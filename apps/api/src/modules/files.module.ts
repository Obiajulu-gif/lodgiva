import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { createHash } from "crypto";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { AuthContext, CurrentAuth, Public } from "../common/auth";
import { AuditService } from "../common/audit.service";
import {
  ALLOWED_CONTENT_TYPES,
  bucketFor,
  buildObjectKey,
  getStorage,
  LocalStorageAdapter,
  MAX_BYTES,
  sniffContentType,
  type BucketName,
} from "../common/storage";
import { RequirePermission } from "../common/permissions.guard";

const INTENT_TTL_SECONDS = Number(process.env.UPLOAD_INTENT_TTL ?? 900);
const DOWNLOAD_TTL_SECONDS = Number(process.env.DOWNLOAD_URL_TTL ?? 300);

const intentSchema = z
  .object({
    purpose: z.enum(["GUEST_ID", "ROOM_IMAGE", "INVOICE", "EXPORT", "GENERAL"]),
    originalName: z.string().min(1).max(255),
    contentType: z.string().min(3).max(120),
    sizeBytes: z.number().int().positive(),
    propertyId: z.string().optional(),
    entityType: z.string().max(40).optional(),
    entityId: z.string().max(64).optional(),
  })
  .strict();

const completeSchema = z
  .object({ checksumSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() })
  .strict();

const quarantineSchema = z.object({ reason: z.string().min(3) }).strict();

@Injectable()
export class FilesService {
  private readonly storage = getStorage();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  /**
   * Step 1: reserve a row and hand back a presigned PUT.
   *
   * The metadata row is created BEFORE any bytes exist, so an upload that is
   * started and abandoned is visible and sweepable rather than an orphan.
   */
  async createIntent(auth: AuthContext, body: unknown) {
    const dto = intentSchema.parse(body);
    const allowed = ALLOWED_CONTENT_TYPES[dto.purpose];
    if (!allowed.includes(dto.contentType)) {
      throw new BadRequestException({
        error: {
          code: "CONTENT_TYPE_NOT_ALLOWED",
          message: `${dto.contentType} is not accepted for ${dto.purpose}. Allowed: ${allowed.join(", ")}.`,
          details: { allowed },
        },
      });
    }
    const maxBytes = MAX_BYTES[dto.purpose];
    if (dto.sizeBytes > maxBytes) {
      throw new BadRequestException({
        error: {
          code: "FILE_TOO_LARGE",
          message: `${dto.purpose} uploads are limited to ${Math.floor(maxBytes / 1024 / 1024)}MB.`,
          details: { maxBytes },
        },
      });
    }

    const bucket = bucketFor(dto.purpose);
    const objectKey = buildObjectKey({
      tenantId: auth.tenantId,
      purpose: dto.purpose,
      originalName: dto.originalName,
    });

    const file = await this.prisma.$transaction(async (tx) => {
      const created = await tx.fileObject.create({
        data: {
          tenantId: auth.tenantId,
          propertyId: dto.propertyId,
          bucket,
          objectKey,
          originalName: dto.originalName.slice(0, 255),
          contentType: dto.contentType,
          declaredSize: dto.sizeBytes,
          purpose: dto.purpose,
          entityType: dto.entityType,
          entityId: dto.entityId,
          uploadedById: auth.userId,
          expiresAt: new Date(Date.now() + INTENT_TTL_SECONDS * 1000),
        },
      });
      await this.audit.log(tx, auth, {
        action: "file.intent_created",
        entityType: "file",
        entityId: created.id,
        propertyId: dto.propertyId,
        summary: { purpose: dto.purpose, bucket, contentType: dto.contentType },
      });
      return created;
    });

    const presigned = await this.storage.presignPut({
      bucket,
      objectKey,
      contentType: dto.contentType,
      maxBytes,
      expiresInSeconds: INTENT_TTL_SECONDS,
    });

    return {
      fileId: file.id,
      bucket,
      upload: presigned,
      maxBytes,
      expiresAt: file.expiresAt,
      storage: { adapter: this.storage.name, remote: this.storage.remote },
    };
  }

  /**
   * Step 2: the client PUTs to the presigned URL. Served here because the
   * local adapter has no separate object-store endpoint; the signature and
   * expiry are still enforced exactly as a real store would.
   */
  async receiveUpload(
    query: { bucket?: string; key?: string; expires?: string; signature?: string },
    body: Buffer | undefined,
    contentType: string | undefined
  ) {
    const local = this.storage as LocalStorageAdapter;
    if (typeof local.verify !== "function") {
      throw new BadRequestException({
        error: { code: "DIRECT_UPLOAD_UNSUPPORTED", message: "Upload directly to the object store." },
      });
    }
    const { bucket, key, expires, signature } = query;
    if (!bucket || !key || !expires || !signature) {
      throw new BadRequestException({
        error: { code: "MALFORMED_UPLOAD_URL", message: "Upload URL is missing parameters." },
      });
    }
    const check = local.verify(bucket, key, Number(expires), "put", signature);
    if (!check.ok) {
      throw new BadRequestException({
        error: { code: "INVALID_UPLOAD_URL", message: check.reason ?? "Rejected." },
      });
    }
    if (!body || body.length === 0) {
      throw new BadRequestException({
        error: { code: "EMPTY_UPLOAD", message: "No bytes were received." },
      });
    }

    const file = await this.prisma.fileObject.findFirst({
      where: { bucket, objectKey: key },
    });
    if (!file) {
      throw new NotFoundException({
        error: { code: "FILE_NOT_FOUND", message: "No upload intent matches this key." },
      });
    }
    if (file.status !== "PENDING") {
      throw new ConflictException({
        error: {
          code: "ALREADY_UPLOADED",
          message: `This upload is already ${file.status}.`,
        },
      });
    }
    if (body.length > MAX_BYTES[file.purpose]) {
      throw new BadRequestException({
        error: { code: "FILE_TOO_LARGE", message: "Upload exceeds the permitted size." },
      });
    }

    await this.storage.put(bucket as BucketName, key, body);
    await this.prisma.fileObject.update({
      where: { id: file.id },
      data: {
        status: "UPLOADED",
        actualSize: body.length,
        checksumSha256: createHash("sha256").update(body).digest("hex"),
      },
    });
    return { received: true, bytes: body.length, contentType: contentType ?? file.contentType };
  }

  /**
   * Step 3: completion validation and scanning.
   *
   * The declared content type is only a hint, so the stored bytes are sniffed
   * and a mismatch quarantines the file rather than accepting it. This is the
   * step that stops an HTML payload being stored as a JPEG and later served
   * back from the public bucket.
   */
  async complete(auth: AuthContext, fileId: string, body: unknown) {
    const dto = completeSchema.parse(body ?? {});
    const file = await this.prisma.fileObject.findFirst({
      where: { id: fileId, tenantId: auth.tenantId },
    });
    if (!file) {
      throw new NotFoundException({
        error: { code: "FILE_NOT_FOUND", message: "File not found." },
      });
    }
    if (file.status === "CLEAN") return this.present(file);
    if (file.status === "QUARANTINED") {
      throw new ConflictException({
        error: {
          code: "FILE_QUARANTINED",
          message: file.quarantineReason ?? "This file was quarantined.",
        },
      });
    }
    if (file.status !== "UPLOADED") {
      throw new ConflictException({
        error: {
          code: "NOT_UPLOADED",
          message: "No bytes have been received for this upload yet.",
        },
      });
    }

    const stat = await this.storage.stat(file.bucket as BucketName, file.objectKey);
    if (!stat) {
      throw new ConflictException({
        error: { code: "OBJECT_MISSING", message: "The uploaded object could not be found." },
      });
    }
    if (dto.checksumSha256 && dto.checksumSha256 !== stat.sha256) {
      return this.quarantineInternal(
        auth,
        file.id,
        "Checksum from the client does not match the stored bytes."
      );
    }

    const bytes = await this.storage.get(file.bucket as BucketName, file.objectKey);
    const sniffed = bytes ? sniffContentType(bytes) : null;
    if (sniffed && sniffed !== file.contentType) {
      return this.quarantineInternal(
        auth,
        file.id,
        `Declared ${file.contentType} but the bytes are ${sniffed}.`
      );
    }
    if (!sniffed && file.contentType.startsWith("image/")) {
      return this.quarantineInternal(
        auth,
        file.id,
        `Declared ${file.contentType} but the bytes are not a recognised image.`
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const clean = await tx.fileObject.update({
        where: { id: file.id },
        data: {
          status: "CLEAN",
          actualSize: stat.size,
          checksumSha256: stat.sha256,
          completedAt: new Date(),
          // Retention: identity documents are kept far more briefly than a
          // room photograph, because they are the most sensitive thing here.
          expiresAt:
            file.purpose === "GUEST_ID"
              ? new Date(Date.now() + 365 * 24 * 3600 * 1000)
              : null,
        },
      });
      await this.audit.log(tx, auth, {
        action: "file.completed",
        entityType: "file",
        entityId: file.id,
        propertyId: file.propertyId ?? undefined,
        summary: { purpose: file.purpose, size: stat.size, checksum: stat.sha256.slice(0, 16) },
      });
      return clean;
    });
    return this.present(updated);
  }

  private async quarantineInternal(auth: AuthContext, fileId: string, reason: string) {
    const file = await this.prisma.$transaction(async (tx) => {
      const q = await tx.fileObject.update({
        where: { id: fileId },
        data: { status: "QUARANTINED", quarantineReason: reason },
      });
      await this.audit.log(tx, auth, {
        action: "file.quarantined",
        entityType: "file",
        entityId: fileId,
        propertyId: q.propertyId ?? undefined,
        summary: { reason },
      });
      return q;
    });
    throw new ConflictException({
      error: {
        code: "FILE_QUARANTINED",
        message: reason,
        details: { fileId: file.id },
      },
    });
  }

  /** Manual quarantine, for a file a human has judged unacceptable. */
  async quarantine(auth: AuthContext, fileId: string, body: unknown) {
    const dto = quarantineSchema.parse(body);
    const file = await this.prisma.fileObject.findFirst({
      where: { id: fileId, tenantId: auth.tenantId },
    });
    if (!file) {
      throw new NotFoundException({
        error: { code: "FILE_NOT_FOUND", message: "File not found." },
      });
    }
    return this.prisma.$transaction(async (tx) => {
      const q = await tx.fileObject.update({
        where: { id: file.id },
        data: { status: "QUARANTINED", quarantineReason: dto.reason },
      });
      await this.audit.log(tx, auth, {
        action: "file.quarantined",
        entityType: "file",
        entityId: file.id,
        propertyId: file.propertyId ?? undefined,
        summary: { reason: dto.reason, manual: true },
      });
      return { id: q.id, status: q.status, quarantineReason: q.quarantineReason };
    });
  }

  private present(file: {
    id: string;
    bucket: string;
    objectKey: string;
    originalName: string;
    contentType: string;
    actualSize: number | null;
    checksumSha256: string | null;
    status: string;
    purpose: string;
    createdAt: Date;
  }) {
    return {
      id: file.id,
      bucket: file.bucket,
      originalName: file.originalName,
      contentType: file.contentType,
      sizeBytes: file.actualSize,
      checksumSha256: file.checksumSha256,
      status: file.status,
      purpose: file.purpose,
      createdAt: file.createdAt,
    };
  }

  /** A signed, short-lived URL. Quarantined files are never served. */
  async downloadUrl(auth: AuthContext, fileId: string) {
    const file = await this.prisma.fileObject.findFirst({
      where: { id: fileId, tenantId: auth.tenantId },
    });
    if (!file) {
      throw new NotFoundException({
        error: { code: "FILE_NOT_FOUND", message: "File not found." },
      });
    }
    if (file.status === "QUARANTINED") {
      throw new ConflictException({
        error: {
          code: "FILE_QUARANTINED",
          message: "This file was quarantined and cannot be downloaded.",
        },
      });
    }
    if (file.status !== "CLEAN") {
      throw new ConflictException({
        error: { code: "FILE_NOT_READY", message: `File is ${file.status}.` },
      });
    }
    if (file.deletedAt) {
      throw new NotFoundException({
        error: { code: "FILE_DELETED", message: "This file has been deleted." },
      });
    }
    const signed = await this.storage.presignGet({
      bucket: file.bucket as BucketName,
      objectKey: file.objectKey,
      expiresInSeconds: DOWNLOAD_TTL_SECONDS,
    });
    return { ...signed, bucket: file.bucket, contentType: file.contentType };
  }

  /** Serves bytes for the local adapter, enforcing the signature. */
  async serve(query: {
    bucket?: string;
    key?: string;
    expires?: string;
    signature?: string;
  }) {
    const local = this.storage as LocalStorageAdapter;
    const { bucket, key, expires, signature } = query;
    if (!bucket || !key || !expires || !signature) {
      throw new BadRequestException({
        error: { code: "MALFORMED_URL", message: "Download URL is missing parameters." },
      });
    }
    const check = local.verify(bucket, key, Number(expires), "get", signature);
    if (!check.ok) {
      throw new BadRequestException({
        error: { code: "INVALID_DOWNLOAD_URL", message: check.reason ?? "Rejected." },
      });
    }
    const file = await this.prisma.fileObject.findFirst({
      where: { bucket, objectKey: key },
    });
    // A signature alone is not enough: the row is still the authority on
    // whether these bytes may be served.
    if (!file || file.status !== "CLEAN" || file.deletedAt) {
      throw new NotFoundException({
        error: { code: "FILE_NOT_AVAILABLE", message: "File is not available." },
      });
    }
    const bytes = await this.storage.get(bucket as BucketName, key);
    if (!bytes) {
      throw new NotFoundException({
        error: { code: "OBJECT_MISSING", message: "Object not found in storage." },
      });
    }
    return { bytes, contentType: file.contentType, originalName: file.originalName };
  }

  async list(auth: AuthContext, entityType?: string, entityId?: string, status?: string) {
    const rows = await this.prisma.fileObject.findMany({
      where: {
        tenantId: auth.tenantId,
        deletedAt: null,
        ...(entityType ? { entityType } : {}),
        ...(entityId ? { entityId } : {}),
        ...(status && status !== "ALL" ? { status } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return rows.map((r) => this.present(r));
  }

  async softDelete(auth: AuthContext, fileId: string) {
    const file = await this.prisma.fileObject.findFirst({
      where: { id: fileId, tenantId: auth.tenantId },
    });
    if (!file) {
      throw new NotFoundException({
        error: { code: "FILE_NOT_FOUND", message: "File not found." },
      });
    }
    return this.prisma.$transaction(async (tx) => {
      const deleted = await tx.fileObject.update({
        where: { id: file.id },
        data: { deletedAt: new Date() },
      });
      await this.audit.log(tx, auth, {
        action: "file.deleted",
        entityType: "file",
        entityId: file.id,
        propertyId: file.propertyId ?? undefined,
        summary: { purpose: file.purpose },
      });
      return { id: deleted.id, deletedAt: deleted.deletedAt };
    });
  }

  /**
   * Lifecycle sweep, run by the worker.
   *
   * Expires abandoned intents, purges the bytes of soft-deleted files, and
   * enforces retention on identity documents. Objects are removed from
   * storage but the metadata row is kept, so a deletion can still be
   * explained during an audit.
   */
  async runLifecycle(): Promise<{
    expiredIntents: number;
    purgedObjects: number;
    retentionExpired: number;
  }> {
    const now = new Date();

    const staleIntents = await this.prisma.fileObject.findMany({
      where: { status: "PENDING", expiresAt: { lte: now } },
      take: 500,
    });
    for (const f of staleIntents) {
      await this.storage.delete(f.bucket as BucketName, f.objectKey);
      await this.prisma.fileObject.update({
        where: { id: f.id },
        data: { status: "EXPIRED" },
      });
    }

    const softDeleted = await this.prisma.fileObject.findMany({
      where: { deletedAt: { not: null }, status: { not: "PURGED" } },
      take: 500,
    });
    for (const f of softDeleted) {
      await this.storage.delete(f.bucket as BucketName, f.objectKey);
      await this.prisma.fileObject.update({
        where: { id: f.id },
        data: { status: "PURGED" },
      });
    }

    const expiredRetention = await this.prisma.fileObject.findMany({
      where: { status: "CLEAN", expiresAt: { lte: now }, deletedAt: null },
      take: 500,
    });
    for (const f of expiredRetention) {
      await this.storage.delete(f.bucket as BucketName, f.objectKey);
      await this.prisma.fileObject.update({
        where: { id: f.id },
        data: { status: "PURGED", deletedAt: now },
      });
    }

    return {
      expiredIntents: staleIntents.length,
      purgedObjects: softDeleted.length,
      retentionExpired: expiredRetention.length,
    };
  }

  storageStatus() {
    return {
      adapter: this.storage.name,
      remote: this.storage.remote,
      buckets: {
        PUBLIC: "Room images. Served without a signature.",
        PRIVATE: "Identity documents, invoices, exports. Signed URLs only.",
      },
      note: this.storage.remote
        ? "Backed by an object store."
        : "No object store configured: bytes are held on local disk. Presigned URLs, expiry and signature checks behave as they would against S3/R2/MinIO.",
      limits: MAX_BYTES,
      allowedTypes: ALLOWED_CONTENT_TYPES,
    };
  }
}

@Controller("files")
export class FilesController {
  constructor(private readonly service: FilesService) {}

  @Get("storage-status")
  status() {
    return this.service.storageStatus();
  }

  @Post("intents")
  createIntent(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.createIntent(auth, body);
  }

  /** Presigned target. Public because the signature is the authorisation. */
  @Public()
  @Post("upload")
  upload(
    @Query() query: Record<string, string>,
    @Req() req: { rawBody?: Buffer; headers: Record<string, string | undefined> }
  ) {
    return this.service.receiveUpload(query, req.rawBody, req.headers["content-type"]);
  }

  @Post(":id/complete")
  complete(@CurrentAuth() auth: AuthContext, @Param("id") id: string, @Body() body: unknown) {
    return this.service.complete(auth, id, body);
  }

  @Get(":id/download-url")
  downloadUrl(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.downloadUrl(auth, id);
  }

  @Public()
  @Get("download")
  async download(
    @Query() query: Record<string, string>,
    @Res() reply: { header: (k: string, v: string) => void; send: (b: Buffer) => void }
  ) {
    const { bytes, contentType, originalName } = await this.service.serve(query);
    reply.header("Content-Type", contentType);
    // Never inline: a stored file rendered in the browser is an XSS vector.
    reply.header("Content-Disposition", `attachment; filename="${originalName.replace(/"/g, "")}"`);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.send(bytes);
  }

  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query("entityType") entityType?: string,
    @Query("entityId") entityId?: string,
    @Query("status") status?: string
  ) {
    return this.service.list(auth, entityType, entityId, status);
  }

  @RequirePermission("file.manage")
  @Post(":id/quarantine")
  quarantine(@CurrentAuth() auth: AuthContext, @Param("id") id: string, @Body() body: unknown) {
    return this.service.quarantine(auth, id, body);
  }

  @RequirePermission("file.manage")
  @Post(":id/delete")
  softDelete(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.softDelete(auth, id);
  }

  @RequirePermission("file.manage")
  @Post("lifecycle/run")
  lifecycle() {
    return this.service.runLifecycle();
  }
}

@Module({
  controllers: [FilesController],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
