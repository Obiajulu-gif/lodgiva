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
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { AuthContext, CurrentAuth } from "../common/auth";
import { AuditService } from "../common/audit.service";
import { TaxService } from "../common/tax.service";

type Tx = Prisma.TransactionClient;

const postChargeSchema = z
  .object({
    type: z.enum(["POS_CHARGE", "ROOM_CHARGE", "LAUNDRY", "MINIBAR", "OTHER"]),
    description: z.string().min(1),
    amountMinor: z.number().int().positive(),
    applyTaxes: z.boolean().default(true),
  })
  .strict();

const reverseSchema = z.object({ reason: z.string().min(3) }).strict();

const splitSchema = z
  .object({
    reservationId: z.string().min(1),
    label: z.string().min(1).max(40),
  })
  .strict();

const transferSchema = z
  .object({
    targetFolioId: z.string().min(1),
    entryIds: z.array(z.string().min(1)).min(1).max(100),
    reason: z.string().min(3),
  })
  .strict();

@Injectable()
export class FoliosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tax: TaxService
  ) {}

  async getFolioOrThrow(auth: AuthContext, folioId: string, tx?: Tx) {
    const db = tx ?? this.prisma;
    const folio = await db.folio.findFirst({
      where: { id: folioId, tenantId: auth.tenantId },
    });
    if (!folio) {
      throw new NotFoundException({
        error: { code: "FOLIO_NOT_FOUND", message: "Folio not found." },
      });
    }
    return folio;
  }

  async balanceMinor(folioId: string, tx?: Tx): Promise<bigint> {
    const db = tx ?? this.prisma;
    const agg = await db.folioEntry.aggregate({
      where: { folioId },
      _sum: { amountMinor: true },
    });
    return agg._sum.amountMinor ?? 0n;
  }

  async get(auth: AuthContext, folioId: string) {
    const folio = await this.prisma.folio.findFirst({
      where: { id: folioId, tenantId: auth.tenantId },
      include: {
        guest: { select: { firstName: true, lastName: true } },
        reservation: { select: { confirmationCode: true, status: true } },
        entries: { orderBy: { postedAt: "asc" } },
        payments: true,
      },
    });
    if (!folio) {
      throw new NotFoundException({
        error: { code: "FOLIO_NOT_FOUND", message: "Folio not found." },
      });
    }
    const balanceMinor = await this.balanceMinor(folioId);
    return { ...folio, balanceMinor };
  }

  /**
   * Post a charge with tax + service charge as separate immutable lines.
   * Used by POS, checkout and night audit. Runs inside the given transaction.
   */
  async postChargeTx(
    tx: Tx,
    auth: AuthContext,
    folio: { id: string; tenantId: string; propertyId: string; status: string },
    input: {
      type: string;
      description: string;
      amountMinor: bigint;
      applyTaxes: boolean;
      businessDate: string;
    }
  ) {
    if (folio.status !== "OPEN") {
      throw new BadRequestException({
        error: { code: "FOLIO_CLOSED", message: "Cannot post to a closed folio; request a reopen approval." },
      });
    }
    const base = {
      tenantId: folio.tenantId,
      folioId: folio.id,
      businessDate: input.businessDate,
      postedById: auth.userId,
    };
    const entry = await tx.folioEntry.create({
      data: { ...base, type: input.type, description: input.description, amountMinor: input.amountMinor },
    });
    if (input.applyTaxes) {
      // Resolve versioned tax rules (§13.3) and post each as its own line,
      // recording the rule version that produced it.
      const computed = await this.tax.compute(tx, {
        tenantId: folio.tenantId,
        propertyId: folio.propertyId,
        baseMinor: input.amountMinor,
        chargeKind: input.type === "ROOM_CHARGE" ? "ROOM" : "FB",
        businessDate: input.businessDate,
      });
      for (const line of computed.lines) {
        await tx.folioEntry.create({
          data: {
            ...base,
            type: line.isServiceCharge ? "SERVICE_CHARGE" : "TAX",
            taxCode: line.code,
            taxRuleId: line.taxRuleId,
            taxRuleVersion: line.taxRuleVersion,
            description: `${line.name} — ${input.description}`,
            amountMinor: line.amountMinor,
          },
        });
      }
    }
    await this.audit.log(tx, auth, {
      action: "folio.entry_posted",
      entityType: "folio_entry",
      entityId: entry.id,
      propertyId: folio.propertyId,
      summary: { folioId: folio.id, type: input.type, amountMinor: Number(input.amountMinor) },
    });
    await this.audit.emit(tx, folio.tenantId, {
      aggregateType: "folio",
      aggregateId: folio.id,
      eventType: "folio.entry_posted",
      payload: { entryId: entry.id, type: input.type, amountMinor: Number(input.amountMinor) },
    });
    return entry;
  }

  async postCharge(auth: AuthContext, folioId: string, body: unknown) {
    const dto = postChargeSchema.parse(body);
    return this.prisma.$transaction(async (tx) => {
      const folio = await this.getFolioOrThrow(auth, folioId, tx);
      const property = await tx.property.findUniqueOrThrow({
        where: { id: folio.propertyId },
      });
      return this.postChargeTx(tx, auth, folio, {
        type: dto.type,
        description: dto.description,
        amountMinor: BigInt(dto.amountMinor),
        applyTaxes: dto.applyTaxes,
        businessDate: property.businessDate,
      });
    });
  }

  /** §7.3 — corrections are reversals; posted entries are never edited. */
  async reverse(auth: AuthContext, folioId: string, entryId: string, body: unknown) {
    const dto = reverseSchema.parse(body);
    return this.prisma.$transaction(async (tx) => {
      const folio = await this.getFolioOrThrow(auth, folioId, tx);
      const original = await tx.folioEntry.findFirst({
        where: { id: entryId, folioId: folio.id, tenantId: auth.tenantId },
      });
      if (!original) {
        throw new NotFoundException({
          error: { code: "ENTRY_NOT_FOUND", message: "Folio entry not found." },
        });
      }
      if (original.type === "REVERSAL") {
        throw new BadRequestException({
          error: { code: "CANNOT_REVERSE_REVERSAL", message: "A reversal entry cannot be reversed." },
        });
      }
      const property = await tx.property.findUniqueOrThrow({
        where: { id: folio.propertyId },
      });
      try {
        const reversal = await tx.folioEntry.create({
          data: {
            tenantId: auth.tenantId,
            folioId: folio.id,
            type: "REVERSAL",
            description: `Reversal of "${original.description}" — ${dto.reason}`,
            amountMinor: -original.amountMinor,
            reversalOfId: original.id,
            businessDate: property.businessDate,
            postedById: auth.userId,
          },
        });
        await this.audit.log(tx, auth, {
          action: "folio.entry_reversed",
          entityType: "folio_entry",
          entityId: reversal.id,
          propertyId: folio.propertyId,
          summary: { originalEntryId: original.id, reason: dto.reason },
        });
        return reversal;
      } catch (e: unknown) {
        if ((e as { code?: string }).code === "P2002") {
          throw new BadRequestException({
            error: { code: "ALREADY_REVERSED", message: "This entry has already been reversed." },
          });
        }
        throw e;
      }
    });
  }

  /**
   * Opens an additional folio on a stay — the classic case being room and tax
   * to a company account, extras to the guest.
   */
  async split(auth: AuthContext, body: unknown) {
    const dto = splitSchema.parse(body);
    return this.prisma.transactionWithRetry(async (tx) => {
      const reservation = await tx.reservation.findFirst({
        where: { id: dto.reservationId, tenantId: auth.tenantId },
        include: { folios: true },
      });
      if (!reservation) {
        throw new NotFoundException({
          error: { code: "RESERVATION_NOT_FOUND", message: "Reservation not found." },
        });
      }
      if (["CHECKED_OUT", "CANCELLED", "NO_SHOW"].includes(reservation.status)) {
        throw new ConflictException({
          error: { code: "STAY_CLOSED", message: "A closed stay cannot take another folio." },
        });
      }
      if (reservation.folios.length >= 6) {
        throw new ConflictException({
          error: { code: "TOO_MANY_FOLIOS", message: "A stay may carry at most six folios." },
        });
      }

      const folio = await tx.folio.create({
        data: {
          tenantId: auth.tenantId,
          propertyId: reservation.propertyId,
          reservationId: reservation.id,
          guestId: reservation.primaryGuestId,
          label: dto.label,
          isPrimary: false,
        },
      });
      await this.audit.log(tx, auth, {
        action: "folio.split",
        entityType: "folio",
        entityId: folio.id,
        propertyId: reservation.propertyId,
        summary: { reservationId: reservation.id, label: dto.label },
      });
      return folio;
    });
  }

  /**
   * Moves postings between folios of the same stay.
   *
   * The ledger is append-only, so nothing is re-parented. Each entry is
   * reversed on the source and re-posted on the target, both halves sharing a
   * transferGroupId. The pair is exactly zero-sum, so the combined balance of
   * the two folios is unchanged and the move can be reconstructed later.
   */
  async transfer(auth: AuthContext, sourceFolioId: string, body: unknown) {
    const dto = transferSchema.parse(body);
    if (sourceFolioId === dto.targetFolioId) {
      throw new BadRequestException({
        error: { code: "SAME_FOLIO", message: "Source and target folio are the same." },
      });
    }

    return this.prisma.transactionWithRetry(async (tx) => {
      const source = await this.getFolioOrThrow(auth, sourceFolioId, tx);
      const target = await this.getFolioOrThrow(auth, dto.targetFolioId, tx);

      if (source.status !== "OPEN") {
        throw new ConflictException({
          error: { code: "FOLIO_CLOSED", message: "Source folio is closed." },
        });
      }
      if (target.status !== "OPEN") {
        throw new ConflictException({
          error: { code: "FOLIO_CLOSED", message: "Target folio is closed." },
        });
      }
      // Transferring between unrelated stays would silently move a debt onto
      // another guest, so both folios must belong to the same reservation.
      if (!source.reservationId || source.reservationId !== target.reservationId) {
        throw new ConflictException({
          error: {
            code: "DIFFERENT_STAY",
            message: "Charges can only be transferred between folios of the same stay.",
          },
        });
      }

      const entries = await tx.folioEntry.findMany({
        where: { id: { in: dto.entryIds }, folioId: source.id, tenantId: auth.tenantId },
      });
      if (entries.length !== dto.entryIds.length) {
        throw new NotFoundException({
          error: {
            code: "ENTRY_NOT_FOUND",
            message: "One or more entries were not found on the source folio.",
          },
        });
      }
      for (const e of entries) {
        if (e.type === "REVERSAL" || e.transferGroupId) {
          throw new ConflictException({
            error: {
              code: "ENTRY_NOT_TRANSFERABLE",
              message: `"${e.description}" is a reversal or has already been transferred.`,
            },
          });
        }
      }

      const property = await tx.property.findUniqueOrThrow({
        where: { id: source.propertyId },
      });
      const transferGroupId = randomUUID();
      let movedMinor = 0n;

      for (const e of entries) {
        await tx.folioEntry.create({
          data: {
            tenantId: auth.tenantId,
            folioId: source.id,
            type: "REVERSAL",
            description: `Transferred out: ${e.description}`,
            amountMinor: -e.amountMinor,
            taxCode: e.taxCode,
            taxRuleId: e.taxRuleId,
            taxRuleVersion: e.taxRuleVersion,
            businessDate: property.businessDate,
            postedById: auth.userId,
            transferGroupId,
          },
        });
        await tx.folioEntry.create({
          data: {
            tenantId: auth.tenantId,
            folioId: target.id,
            type: e.type,
            description: `Transferred in: ${e.description}`,
            amountMinor: e.amountMinor,
            taxCode: e.taxCode,
            taxRuleId: e.taxRuleId,
            taxRuleVersion: e.taxRuleVersion,
            businessDate: property.businessDate,
            postedById: auth.userId,
            transferGroupId,
          },
        });
        // Mark the original so it cannot be transferred twice.
        await tx.folioEntry.update({
          where: { id: e.id },
          data: { transferGroupId },
        });
        movedMinor += e.amountMinor;
      }

      await this.audit.log(tx, auth, {
        action: "folio.charges_transferred",
        entityType: "folio",
        entityId: source.id,
        propertyId: source.propertyId,
        summary: {
          targetFolioId: target.id,
          entries: entries.length,
          movedMinor: Number(movedMinor),
          transferGroupId,
          reason: dto.reason,
        },
      });

      return {
        transferGroupId,
        movedEntries: entries.length,
        movedMinor: Number(movedMinor),
        sourceBalanceMinor: Number(await this.balanceMinor(source.id, tx)),
        targetBalanceMinor: Number(await this.balanceMinor(target.id, tx)),
      };
    });
  }

  /** Every folio on a stay, with balances — the checkout screen's data. */
  async listForReservation(auth: AuthContext, reservationId: string) {
    const folios = await this.prisma.folio.findMany({
      where: { tenantId: auth.tenantId, reservationId },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    });
    return Promise.all(
      folios.map(async (f) => ({
        id: f.id,
        label: f.label,
        isPrimary: f.isPrimary,
        status: f.status,
        balanceMinor: Number(await this.balanceMinor(f.id)),
      }))
    );
  }
}

@Controller("folios")
export class FoliosController {
  constructor(private readonly service: FoliosService) {}

  @Get(":id")
  get(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.get(auth, id);
  }

  @Post(":id/charges")
  postCharge(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown
  ) {
    return this.service.postCharge(auth, id, body);
  }

  @Post("split")
  split(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.split(auth, body);
  }

  @Get("by-reservation/:reservationId")
  listForReservation(
    @CurrentAuth() auth: AuthContext,
    @Param("reservationId") reservationId: string
  ) {
    return this.service.listForReservation(auth, reservationId);
  }

  @Post(":id/transfer")
  transfer(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown
  ) {
    return this.service.transfer(auth, id, body);
  }

  @Post(":id/entries/:entryId/reverse")
  reverse(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Param("entryId") entryId: string,
    @Body() body: unknown
  ) {
    return this.service.reverse(auth, id, entryId, body);
  }
}

@Module({
  controllers: [FoliosController],
  providers: [FoliosService, TaxService],
  exports: [FoliosService, TaxService],
})
export class FoliosModule {}
