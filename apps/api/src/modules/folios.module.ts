import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
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
