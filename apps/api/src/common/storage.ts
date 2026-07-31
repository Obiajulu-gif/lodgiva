import { createHash, createHmac, randomBytes } from "crypto";
import { promises as fs } from "fs";
import { dirname, join, resolve, sep } from "path";

/**
 * §11 object storage abstraction.
 *
 * Two buckets with genuinely different policies:
 *
 *  - PUBLIC  — room photographs and similar. Readable by URL without a
 *              signature, because they are marketing assets.
 *  - PRIVATE — guest identity documents, invoices, exports. Never publicly
 *              readable; every read is a short-lived signed URL.
 *
 * The interface is S3-shaped so the R2/MinIO adapter is a drop-in. The local
 * adapter exists because no object store is reachable in this environment; it
 * implements the same signing and expiry semantics against the filesystem so
 * the surrounding logic is genuinely exercised rather than stubbed.
 */

export type BucketName = "PUBLIC" | "PRIVATE";

export interface PresignedUpload {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface StorageAdapter {
  readonly name: string;
  /** True when backed by a real object store rather than local disk. */
  readonly remote: boolean;
  presignPut(input: {
    bucket: BucketName;
    objectKey: string;
    contentType: string;
    maxBytes: number;
    expiresInSeconds: number;
  }): Promise<PresignedUpload>;
  presignGet(input: {
    bucket: BucketName;
    objectKey: string;
    expiresInSeconds: number;
  }): Promise<{ url: string; expiresAt: Date }>;
  /** Size and checksum as actually stored, or null when absent. */
  stat(bucket: BucketName, objectKey: string): Promise<{ size: number; sha256: string } | null>;
  delete(bucket: BucketName, objectKey: string): Promise<void>;
  put(bucket: BucketName, objectKey: string, body: Buffer): Promise<void>;
  get(bucket: BucketName, objectKey: string): Promise<Buffer | null>;
}

/** Deterministic, collision-resistant, and never derived from user input. */
export function buildObjectKey(input: {
  tenantId: string;
  purpose: string;
  originalName: string;
}): string {
  const ext = input.originalName.includes(".")
    ? input.originalName.slice(input.originalName.lastIndexOf(".")).toLowerCase().slice(0, 12)
    : "";
  // The original name is never used as a path component: it is attacker
  // controlled and would otherwise allow traversal or key collisions.
  const safeExt = /^\.[a-z0-9]+$/.test(ext) ? ext : "";
  const now = new Date();
  const datePath = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return `${input.tenantId}/${input.purpose.toLowerCase()}/${datePath}/${randomBytes(16).toString("hex")}${safeExt}`;
}

/**
 * Rejects keys that could escape their prefix. Belt and braces alongside
 * buildObjectKey, because keys also arrive from the database.
 */
export function assertSafeKey(objectKey: string): void {
  if (
    !objectKey ||
    objectKey.includes("..") ||
    objectKey.startsWith("/") ||
    objectKey.includes("\\") ||
    objectKey.includes("\0")
  ) {
    throw new Error(`Unsafe object key: ${JSON.stringify(objectKey)}`);
  }
}

/**
 * Local filesystem adapter used when no object store is configured.
 *
 * Presigned URLs are real: they carry an expiry and an HMAC over
 * bucket + key + expiry, verified by the API before it serves or accepts
 * bytes. Nothing is trusted just because it knows the path.
 */
export class LocalStorageAdapter implements StorageAdapter {
  readonly name = "LOCAL";
  readonly remote = false;

  constructor(
    private readonly root = process.env.STORAGE_LOCAL_ROOT ??
      join(process.cwd(), ".storage"),
    private readonly signingKey = process.env.STORAGE_SIGNING_KEY ??
      "lodgiva-dev-storage-signing-key",
    private readonly baseUrl = process.env.STORAGE_BASE_URL ??
      "http://localhost:4000/api/v1/files"
  ) {}

  private pathFor(bucket: BucketName, objectKey: string): string {
    assertSafeKey(objectKey);
    const full = resolve(join(this.root, bucket.toLowerCase(), objectKey));
    const base = resolve(join(this.root, bucket.toLowerCase()));
    // Final guard: the resolved path must remain inside its bucket.
    if (full !== base && !full.startsWith(base + sep)) {
      throw new Error("Resolved object path escaped its bucket.");
    }
    return full;
  }

  sign(bucket: string, objectKey: string, expiresAtMs: number, op: string): string {
    return createHmac("sha256", this.signingKey)
      .update(`${op}:${bucket}:${objectKey}:${expiresAtMs}`)
      .digest("hex");
  }

  verify(
    bucket: string,
    objectKey: string,
    expiresAtMs: number,
    op: string,
    signature: string
  ): { ok: boolean; reason?: string } {
    if (!Number.isFinite(expiresAtMs)) return { ok: false, reason: "Malformed expiry." };
    if (Date.now() > expiresAtMs) return { ok: false, reason: "This link has expired." };
    const expected = this.sign(bucket, objectKey, expiresAtMs, op);
    const a = Buffer.from(expected);
    const b = Buffer.from(signature ?? "");
    if (a.length !== b.length) return { ok: false, reason: "Invalid signature." };
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0 ? { ok: true } : { ok: false, reason: "Invalid signature." };
  }

  async presignPut(input: {
    bucket: BucketName;
    objectKey: string;
    contentType: string;
    maxBytes: number;
    expiresInSeconds: number;
  }): Promise<PresignedUpload> {
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
    const sig = this.sign(input.bucket, input.objectKey, expiresAt.getTime(), "put");
    const url =
      `${this.baseUrl}/upload?bucket=${input.bucket}` +
      `&key=${encodeURIComponent(input.objectKey)}` +
      `&expires=${expiresAt.getTime()}&signature=${sig}`;
    return {
      url,
      method: "PUT",
      headers: {
        "Content-Type": input.contentType,
        "x-lodgiva-max-bytes": String(input.maxBytes),
      },
      expiresAt,
    };
  }

  async presignGet(input: {
    bucket: BucketName;
    objectKey: string;
    expiresInSeconds: number;
  }): Promise<{ url: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
    // Public objects need no signature; signing them would only create links
    // that mysteriously stop working on a marketing page.
    if (input.bucket === "PUBLIC") {
      return {
        url: `${this.baseUrl}/public/${input.objectKey}`,
        expiresAt,
      };
    }
    const sig = this.sign(input.bucket, input.objectKey, expiresAt.getTime(), "get");
    return {
      url:
        `${this.baseUrl}/download?bucket=${input.bucket}` +
        `&key=${encodeURIComponent(input.objectKey)}` +
        `&expires=${expiresAt.getTime()}&signature=${sig}`,
      expiresAt,
    };
  }

  async put(bucket: BucketName, objectKey: string, body: Buffer): Promise<void> {
    const path = this.pathFor(bucket, objectKey);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, body);
  }

  async get(bucket: BucketName, objectKey: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.pathFor(bucket, objectKey));
    } catch {
      return null;
    }
  }

  async stat(bucket: BucketName, objectKey: string) {
    const body = await this.get(bucket, objectKey);
    if (!body) return null;
    return {
      size: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
    };
  }

  async delete(bucket: BucketName, objectKey: string): Promise<void> {
    try {
      await fs.unlink(this.pathFor(bucket, objectKey));
    } catch {
      // Already gone is the desired end state.
    }
  }
}

let adapter: StorageAdapter | null = null;

/**
 * S3/R2/MinIO would be selected here when STORAGE_ENDPOINT and credentials are
 * present. None are configured in this environment, so the local adapter is
 * used and says so through `remote: false`.
 */
export function getStorage(): StorageAdapter {
  if (!adapter) adapter = new LocalStorageAdapter();
  return adapter;
}

/** Only these types are accepted; everything else is refused at intent time. */
export const ALLOWED_CONTENT_TYPES: Record<string, string[]> = {
  GUEST_ID: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
  ROOM_IMAGE: ["image/jpeg", "image/png", "image/webp"],
  INVOICE: ["application/pdf"],
  EXPORT: ["text/csv", "application/pdf", "application/json"],
  GENERAL: ["image/jpeg", "image/png", "image/webp", "application/pdf", "text/csv"],
};

export const MAX_BYTES: Record<string, number> = {
  GUEST_ID: 8 * 1024 * 1024,
  ROOM_IMAGE: 12 * 1024 * 1024,
  INVOICE: 8 * 1024 * 1024,
  EXPORT: 64 * 1024 * 1024,
  GENERAL: 12 * 1024 * 1024,
};

/** Identity documents are private by definition; room photos are not. */
export function bucketFor(purpose: string): BucketName {
  return purpose === "ROOM_IMAGE" ? "PUBLIC" : "PRIVATE";
}

/**
 * Magic-byte sniffing.
 *
 * A client-declared Content-Type is a hint, not evidence: renaming
 * payload.html to photo.jpg costs nothing. Comparing the declared type
 * against the actual leading bytes is what stops a stored file being served
 * back as something executable.
 */
export function sniffContentType(body: Buffer): string | null {
  if (body.length < 4) return null;
  const hex = body.subarray(0, 12).toString("hex").toLowerCase();
  if (hex.startsWith("ffd8ff")) return "image/jpeg";
  if (hex.startsWith("89504e470d0a1a0a")) return "image/png";
  if (hex.startsWith("25504446")) return "application/pdf";
  if (hex.startsWith("52494646") && body.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (hex.startsWith("3c3f786d6c") || hex.startsWith("3c68746d6c") || hex.startsWith("3c21")) {
    // XML/HTML — dangerous if served from a bucket, never an accepted type.
    return "text/html";
  }
  return null;
}
