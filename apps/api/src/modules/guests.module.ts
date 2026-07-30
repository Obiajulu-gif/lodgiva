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
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { RequirePermission } from "../common/permissions.guard";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { AuthContext, CurrentAuth } from "../common/auth";
import { AuditService } from "../common/audit.service";

const createGuestSchema = z
  .object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    nationality: z.string().optional(),
    notes: z.string().optional(),
    vip: z.boolean().optional(),
    idDocumentType: z.enum(["PASSPORT", "NIN", "DRIVERS_LICENCE", "VOTERS_CARD"]).optional(),
    // Only the last four are accepted — the full number is never stored
    // (§12.2 data minimisation).
    idDocumentLast4: z.string().regex(/^\d{4}$/).optional(),
    idDocumentExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    marketingConsent: z.boolean().optional(),
  })
  .strict(); // §9.1: reject unknown fields on write DTOs

const updateGuestSchema = createGuestSchema.partial().strict();

const mergeSchema = z
  .object({
    survivingGuestId: z.string().min(1),
    mergedGuestId: z.string().min(1),
    reason: z.string().min(3),
  })
  .strict();

const blacklistSchema = z
  .object({ blacklisted: z.boolean(), reason: z.string().min(3).optional() })
  .strict();

/** Normalises a phone number to digits so +234803… and 0803… compare equal. */
function phoneKey(phone?: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return null;
  // Compare on the national significant number: the last 10 digits covers
  // both +234 803 … and 0803 … forms used interchangeably in Nigeria.
  return digits.slice(-10);
}

@Injectable()
export class GuestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  search(auth: AuthContext, q?: string) {
    return this.prisma.guest.findMany({
      where: {
        tenantId: auth.tenantId,
        // Merged profiles are tombstones: kept for history, hidden from search.
        mergedIntoId: null,
        ...(q
          ? {
              OR: [
                { firstName: { contains: q } },
                { lastName: { contains: q } },
                { phone: { contains: q } },
                { email: { contains: q } },
              ],
            }
          : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
  }

  async get(auth: AuthContext, id: string) {
    const guest = await this.prisma.guest.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: {
        reservations: {
          orderBy: { arrivalDate: "desc" },
          take: 10,
          select: {
            id: true, confirmationCode: true, status: true,
            arrivalDate: true, departureDate: true,
          },
        },
      },
    });
    if (!guest) {
      throw new NotFoundException({
        error: { code: "GUEST_NOT_FOUND", message: "Guest not found." },
      });
    }
    return guest;
  }

  async create(auth: AuthContext, dto: z.infer<typeof createGuestSchema>) {
    return this.prisma.transactionWithRetry(async (tx) => {
      const guest = await tx.guest.create({
        data: {
          tenantId: auth.tenantId,
          ...dto,
          consentUpdatedAt: dto.marketingConsent !== undefined ? new Date() : null,
        },
      });
      await this.audit.log(tx, auth, {
        action: "guest.created",
        entityType: "guest",
        entityId: guest.id,
        summary: { name: `${guest.firstName} ${guest.lastName}` },
      });
      return guest;
    });
  }

  async update(auth: AuthContext, id: string, body: unknown) {
    const dto = updateGuestSchema.parse(body);
    const guest = await this.prisma.guest.findFirst({
      where: { id, tenantId: auth.tenantId },
    });
    if (!guest) {
      throw new NotFoundException({
        error: { code: "GUEST_NOT_FOUND", message: "Guest not found." },
      });
    }
    if (guest.mergedIntoId) {
      throw new ConflictException({
        error: {
          code: "GUEST_MERGED",
          message: "This profile has been merged into another and is read-only.",
          details: { survivingGuestId: guest.mergedIntoId },
        },
      });
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.guest.update({
        where: { id: guest.id },
        data: {
          ...dto,
          ...(dto.marketingConsent !== undefined ? { consentUpdatedAt: new Date() } : {}),
        },
      });
      await this.audit.log(tx, auth, {
        action: "guest.updated",
        entityType: "guest",
        entityId: guest.id,
        summary: { changed: Object.keys(dto) },
      });
      return updated;
    });
  }

  /**
   * Duplicate detection. Matches on normalised phone, then email, then an
   * exact name match — in that order of confidence, since a phone number is
   * the strongest identifier a Nigerian front desk reliably captures.
   */
  async duplicates(auth: AuthContext, id: string) {
    const guest = await this.prisma.guest.findFirst({
      where: { id, tenantId: auth.tenantId },
    });
    if (!guest) {
      throw new NotFoundException({
        error: { code: "GUEST_NOT_FOUND", message: "Guest not found." },
      });
    }
    const candidates = await this.prisma.guest.findMany({
      where: {
        tenantId: auth.tenantId,
        id: { not: guest.id },
        mergedIntoId: null,
      },
      take: 500,
    });

    const key = phoneKey(guest.phone);
    const matches = candidates
      .map((c) => {
        if (key && phoneKey(c.phone) === key) {
          return { guest: c, confidence: "HIGH" as const, matchedOn: "phone" };
        }
        if (guest.email && c.email && c.email.toLowerCase() === guest.email.toLowerCase()) {
          return { guest: c, confidence: "HIGH" as const, matchedOn: "email" };
        }
        if (
          c.firstName.toLowerCase() === guest.firstName.toLowerCase() &&
          c.lastName.toLowerCase() === guest.lastName.toLowerCase()
        ) {
          return { guest: c, confidence: "LOW" as const, matchedOn: "name" };
        }
        return null;
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);

    return { guestId: guest.id, candidates: matches };
  }

  /**
   * Merges one profile into another. Reservations and folios are re-pointed
   * at the survivor and the merged row is kept as a tombstone, so history is
   * never orphaned and the merge can be explained afterwards.
   */
  async merge(auth: AuthContext, body: unknown) {
    const dto = mergeSchema.parse(body);
    if (dto.survivingGuestId === dto.mergedGuestId) {
      throw new BadRequestException({
        error: { code: "SAME_GUEST", message: "A guest cannot be merged into itself." },
      });
    }

    const [surviving, merged] = await Promise.all([
      this.prisma.guest.findFirst({
        where: { id: dto.survivingGuestId, tenantId: auth.tenantId },
      }),
      this.prisma.guest.findFirst({
        where: { id: dto.mergedGuestId, tenantId: auth.tenantId },
      }),
    ]);
    if (!surviving || !merged) {
      throw new NotFoundException({
        error: { code: "GUEST_NOT_FOUND", message: "One or both guests were not found." },
      });
    }
    if (merged.mergedIntoId || surviving.mergedIntoId) {
      throw new ConflictException({
        error: {
          code: "ALREADY_MERGED",
          message: "One of these profiles has already been merged.",
        },
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const reservations = await tx.reservation.updateMany({
        where: { tenantId: auth.tenantId, primaryGuestId: merged.id },
        data: { primaryGuestId: surviving.id },
      });
      const folios = await tx.folio.updateMany({
        where: { tenantId: auth.tenantId, guestId: merged.id },
        data: { guestId: surviving.id },
      });

      // Fill blanks on the survivor from the merged record rather than
      // overwriting: the survivor is the record staff chose to keep.
      await tx.guest.update({
        where: { id: surviving.id },
        data: {
          phone: surviving.phone ?? merged.phone,
          email: surviving.email ?? merged.email,
          nationality: surviving.nationality ?? merged.nationality,
          idDocumentType: surviving.idDocumentType ?? merged.idDocumentType,
          idDocumentLast4: surviving.idDocumentLast4 ?? merged.idDocumentLast4,
          notes: [surviving.notes, merged.notes].filter(Boolean).join("\n") || null,
          vip: surviving.vip || merged.vip,
          blacklisted: surviving.blacklisted || merged.blacklisted,
        },
      });

      const tombstone = await tx.guest.update({
        where: { id: merged.id },
        data: { mergedIntoId: surviving.id, mergedAt: new Date() },
      });

      await tx.guestMergeLog.create({
        data: {
          tenantId: auth.tenantId,
          survivingId: surviving.id,
          mergedId: merged.id,
          movedCounts: JSON.stringify({
            reservations: reservations.count,
            folios: folios.count,
          }),
          performedById: auth.userId,
        },
      });
      await this.audit.log(tx, auth, {
        action: "guest.merged",
        entityType: "guest",
        entityId: surviving.id,
        summary: {
          mergedGuestId: merged.id,
          reason: dto.reason,
          movedReservations: reservations.count,
          movedFolios: folios.count,
        },
      });

      return {
        survivingGuestId: surviving.id,
        mergedGuestId: tombstone.id,
        moved: { reservations: reservations.count, folios: folios.count },
      };
    });
  }

  async setBlacklist(auth: AuthContext, id: string, body: unknown) {
    const dto = blacklistSchema.parse(body);
    if (dto.blacklisted && !dto.reason) {
      throw new BadRequestException({
        error: { code: "REASON_REQUIRED", message: "A reason is required to blacklist a guest." },
      });
    }
    const guest = await this.prisma.guest.findFirst({
      where: { id, tenantId: auth.tenantId },
    });
    if (!guest) {
      throw new NotFoundException({
        error: { code: "GUEST_NOT_FOUND", message: "Guest not found." },
      });
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.guest.update({
        where: { id: guest.id },
        data: {
          blacklisted: dto.blacklisted,
          blacklistReason: dto.blacklisted ? dto.reason : null,
        },
      });
      await this.audit.log(tx, auth, {
        action: dto.blacklisted ? "guest.blacklisted" : "guest.blacklist_removed",
        entityType: "guest",
        entityId: guest.id,
        summary: { reason: dto.reason },
      });
      return updated;
    });
  }
}

@Controller("guests")
export class GuestsController {
  constructor(private readonly service: GuestsService) {}

  @Get()
  search(@CurrentAuth() auth: AuthContext, @Query("q") q?: string) {
    return this.service.search(auth, q);
  }

  @Get(":id")
  get(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.get(auth, id);
  }

  @RequirePermission("guest.manage")
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.create(auth, createGuestSchema.parse(body));
  }

  @RequirePermission("guest.manage")
  @Patch(":id")
  update(@CurrentAuth() auth: AuthContext, @Param("id") id: string, @Body() body: unknown) {
    return this.service.update(auth, id, body);
  }

  @Get(":id/duplicates")
  duplicates(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.duplicates(auth, id);
  }

  @RequirePermission("guest.manage")
  @Post("merge")
  merge(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.merge(auth, body);
  }

  @RequirePermission("guest.manage")
  @Post(":id/blacklist")
  blacklist(@CurrentAuth() auth: AuthContext, @Param("id") id: string, @Body() body: unknown) {
    return this.service.setBlacklist(auth, id, body);
  }
}

@Module({
  controllers: [GuestsController],
  providers: [GuestsService],
  exports: [GuestsService],
})
export class GuestsModule {}
