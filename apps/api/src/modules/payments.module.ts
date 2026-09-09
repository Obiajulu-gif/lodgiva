import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { AuthContext, CurrentAuth } from "../common/auth";
import { RequirePermission } from "../common/permissions.guard";
import { AuditService } from "../common/audit.service";
import { FoliosModule, FoliosService } from "./folios.module";

// §13.1 PaymentProvider abstraction. Real Paystack/Flutterwave adapters plug
// in behind this interface; webhooks — not redirects — confirm payments.
export interface PaymentProvider {
  readonly name: string;
  verifyTransaction(reference: string): Promise<{ verified: boolean; note: string }>;
}

/** Cash and manual bank transfer are verified by staff, not a gateway. */
export class ManualProvider implements PaymentProvider {
  constructor(public readonly name: string) {}
  async verifyTransaction(reference: string) {
    return { verified: true, note: `Manually confirmed by staff (${reference || "no reference"}).` };
  }
}

const recordPaymentSchema = z
  .object({
    folioId: z.string().min(1),
    /**
     * Manual recording covers only tenders a member of staff can witness:
     * cash counted into the drawer, a transfer seen landing in the account,
     * a terminal slip in hand. CARD and PAYMENT_LINK are deliberately absent
     * -- they used to be "verified" by a stand-in that accepted ANY non-empty
     * reference, so typing a word settled a folio as though a card had
     * cleared. Those collect through POST /payments/intents and are credited
     * only by a signed webhook or a server-side verify.
     */
    method: z.enum(["CASH", "BANK_TRANSFER", "POS_TERMINAL"]),
    amountMinor: z.number().int().positive(),
    externalReference: z.string().optional(),
    idempotencyKey: z.string().optional(),
  })
  .strict()
  // Cash is witnessed by the person counting it into the drawer. A transfer
  // or a terminal payment has evidence that exists outside Lodgiva -- the
  // bank narration, the terminal slip -- and recording one without it leaves
  // nothing to reconcile against when the statement arrives.
  .refine(
    (v) => v.method === "CASH" || Boolean(v.externalReference?.trim()),
    {
      path: ["externalReference"],
      message:
        "Record the bank narration or terminal slip number so this payment can be reconciled later.",
    }
  );

@Injectable()
export class PaymentsService {
  private readonly providers: Record<string, PaymentProvider> = {
    CASH: new ManualProvider("FrontDesk"),
    BANK_TRANSFER: new ManualProvider("ManualTransfer"),
    POS_TERMINAL: new ManualProvider("POSTerminal"),
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly folios: FoliosService
  ) {}

  async record(auth: AuthContext, body: unknown) {
    const dto = recordPaymentSchema.parse(body);

    // Idempotency (§9.1): same key returns the original payment, never a duplicate.
    if (dto.idempotencyKey) {
      const existing = await this.prisma.payment.findFirst({
        where: { tenantId: auth.tenantId, idempotencyKey: dto.idempotencyKey },
      });
      if (existing) return { payment: existing, duplicate: true };
    }

    const provider = this.providers[dto.method];
    const verification = await provider.verifyTransaction(dto.externalReference ?? "");
    if (!verification.verified) {
      throw new BadRequestException({
        error: { code: "PAYMENT_NOT_VERIFIED", message: verification.note },
      });
    }

    const payment = await this.prisma.$transaction(async (tx) => {
      const folio = await this.folios.getFolioOrThrow(auth, dto.folioId, tx);
      if (folio.status !== "OPEN") {
        throw new BadRequestException({
          error: { code: "FOLIO_CLOSED", message: "Cannot take payment on a closed folio." },
        });
      }
      const property = await tx.property.findUniqueOrThrow({
        where: { id: folio.propertyId },
      });
      const payment = await tx.payment.create({
        data: {
          tenantId: auth.tenantId,
          propertyId: folio.propertyId,
          folioId: folio.id,
          method: dto.method,
          provider: provider.name,
          amountMinor: BigInt(dto.amountMinor),
          status: "CONFIRMED",
          externalReference: dto.externalReference,
          idempotencyKey: dto.idempotencyKey,
          recordedById: auth.userId,
        },
      });
      // Ledger effect: payments are negative entries on the folio (§7.3).
      await tx.folioEntry.create({
        data: {
          tenantId: auth.tenantId,
          folioId: folio.id,
          type: "PAYMENT",
          description: `${dto.method} payment${dto.externalReference ? ` (${dto.externalReference})` : ""}`,
          amountMinor: -BigInt(dto.amountMinor),
          businessDate: property.businessDate,
          postedById: auth.userId,
        },
      });
      await this.audit.log(tx, auth, {
        action: "payment.confirmed",
        entityType: "payment",
        entityId: payment.id,
        propertyId: folio.propertyId,
        summary: { method: dto.method, amountMinor: dto.amountMinor, note: verification.note },
      });
      await this.audit.emit(tx, auth.tenantId, {
        aggregateType: "payment",
        aggregateId: payment.id,
        eventType: "payment.confirmed",
        payload: { folioId: folio.id, method: dto.method, amountMinor: dto.amountMinor },
      });
      return payment;
    });
    return { payment, duplicate: false, verification: verification.note };
  }

  list(auth: AuthContext, propertyId?: string) {
    return this.prisma.payment.findMany({
      where: { tenantId: auth.tenantId, ...(propertyId ? { propertyId } : {}) },
      orderBy: { receivedAt: "desc" },
      take: 100,
      include: {
        folio: {
          select: {
            id: true,
            guest: { select: { firstName: true, lastName: true } },
            reservation: { select: { confirmationCode: true } },
          },
        },
      },
    });
  }
}

@Controller("payments")
export class PaymentsController {
  constructor(private readonly service: PaymentsService) {}

  @RequirePermission("payment.capture")
  @Post()
  record(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.record(auth, body);
  }

  @RequirePermission("folio.read")
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query("propertyId") propertyId?: string) {
    return this.service.list(auth, propertyId);
  }
}

@Module({
  imports: [FoliosModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
