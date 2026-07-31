import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { AuthContext, CurrentAuth, Public } from "../common/auth";
import { AuditService } from "../common/audit.service";
import { getProvider, PROVIDERS } from "../common/payment-providers";
import { parseSettlementCsv } from "../common/settlement-csv";
import { FoliosModule, FoliosService } from "./folios.module";
import { PropertiesModule, PropertiesService } from "./properties.module";

type Tx = Prisma.TransactionClient;

const intentSchema = z
  .object({
    folioId: z.string().min(1),
    provider: z.enum(["PAYSTACK", "FLUTTERWAVE"]),
    amountMinor: z.number().int().positive(),
    email: z.string().email(),
    callbackUrl: z.string().url().optional(),
  })
  .strict();

const refundSchema = z
  .object({
    paymentId: z.string().min(1),
    amountMinor: z.number().int().positive(),
    reason: z.string().min(5),
  })
  .strict();

const decisionSchema = z.object({ note: z.string().optional() }).strict();

const settlementSchema = z
  .object({
    propertyId: z.string().min(1),
    provider: z.enum(["PAYSTACK", "FLUTTERWAVE"]),
    reference: z.string().min(1),
    settledOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** One row per provider transaction in the payout. */
    lines: z
      .array(
        z.object({
          providerRef: z.string().min(1),
          amountMinor: z.number().int(),
          feeMinor: z.number().int().min(0).default(0),
          paidOn: z.string().optional(),
        })
      )
      .min(1)
      .max(5000),
  })
  .strict();

const settlementCsvSchema = z
  .object({
    propertyId: z.string().min(1),
    provider: z.enum(["PAYSTACK", "FLUTTERWAVE"]),
    reference: z.string().min(1),
    settledOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    csv: z.string().min(10).max(5_000_000),
    /** Set false only when an export is already in minor units. */
    amountsAreMajor: z.boolean().default(true),
    /** Refuse the import if any row failed to parse. */
    strict: z.boolean().default(false),
  })
  .strict();

const APPROVER_ROLES = ["TENANT_OWNER", "GENERAL_MANAGER", "FINANCE"];

@Injectable()
export class GatewayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly folios: FoliosService,
    private readonly properties: PropertiesService
  ) {}

  // ── Intents ────────────────────────────────────────────────────────────

  async createIntent(auth: AuthContext, body: unknown) {
    const dto = intentSchema.parse(body);
    const folio = await this.folios.getFolioOrThrow(auth, dto.folioId);
    if (folio.status !== "OPEN") {
      throw new ConflictException({
        error: { code: "FOLIO_CLOSED", message: "Cannot collect against a closed folio." },
      });
    }
    const provider = getProvider(dto.provider);
    const reference = `LDG-${randomBytes(9).toString("base64url")}`;

    const init = await provider.initialize({
      reference,
      amountMinor: BigInt(dto.amountMinor),
      currency: folio.currency,
      email: dto.email,
      callbackUrl: dto.callbackUrl,
    });

    const intent = await this.prisma.$transaction(async (tx) => {
      const created = await tx.paymentIntent.create({
        data: {
          tenantId: auth.tenantId,
          propertyId: folio.propertyId,
          folioId: folio.id,
          provider: dto.provider,
          reference: init.reference,
          providerRef: init.providerRef,
          amountMinor: BigInt(dto.amountMinor),
          currency: folio.currency,
          checkoutUrl: init.checkoutUrl,
          createdById: auth.userId,
        },
      });
      await this.audit.log(tx, auth, {
        action: "payment.intent_created",
        entityType: "payment_intent",
        entityId: created.id,
        propertyId: folio.propertyId,
        summary: { provider: dto.provider, amountMinor: dto.amountMinor, reference: init.reference },
      });
      return created;
    });

    return {
      intentId: intent.id,
      reference: intent.reference,
      checkoutUrl: intent.checkoutUrl,
      status: intent.status,
      // Stated plainly so a caller never mistakes sandbox behaviour for real
      // money movement.
      sandbox: !provider.live,
    };
  }

  /**
   * Confirms an intent from a server-side verify call. Used when a webhook is
   * delayed or lost — the desk can ask "did this actually pay?" without
   * trusting the browser.
   */
  async verifyIntent(auth: AuthContext, intentId: string) {
    const intent = await this.prisma.paymentIntent.findFirst({
      where: { id: intentId, tenantId: auth.tenantId },
    });
    if (!intent) {
      throw new NotFoundException({
        error: { code: "INTENT_NOT_FOUND", message: "Payment intent not found." },
      });
    }
    if (intent.status === "CONFIRMED") {
      return { status: "CONFIRMED", note: "Already confirmed.", alreadyConfirmed: true };
    }
    const provider = getProvider(intent.provider);
    const result = await provider.verify(intent.reference);
    if (!result.verified) {
      return { status: intent.status, verified: false, note: result.note, sandbox: !provider.live };
    }
    const payment = await this.confirmIntent(intent.id, {
      providerRef: result.providerRef,
      amountMinor: result.amountMinor,
      feeMinor: result.feeMinor,
      source: "verify",
      actorId: auth.userId,
    });
    return { status: "CONFIRMED", verified: true, paymentId: payment?.id, note: result.note };
  }

  /**
   * The single place an intent becomes money on a folio.
   *
   * Idempotent on the intent: a webhook and a verify call racing each other
   * produce one payment, because the intent row is flipped inside the same
   * transaction that creates the payment.
   */
  private async confirmIntent(
    intentId: string,
    input: {
      providerRef?: string;
      amountMinor?: bigint;
      feeMinor?: bigint;
      source: string;
      actorId?: string;
    }
  ) {
    return this.prisma.transactionWithRetry(async (tx) => {
      const intent = await tx.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
      if (intent.status === "CONFIRMED") return null;

      // The provider is authoritative on amount. A mismatch is recorded as a
      // reconciliation exception rather than silently accepted or dropped.
      const amount = input.amountMinor ?? intent.amountMinor;
      if (input.amountMinor !== undefined && input.amountMinor !== intent.amountMinor) {
        await tx.reconciliationException.create({
          data: {
            tenantId: intent.tenantId,
            propertyId: intent.propertyId,
            kind: "AMOUNT_MISMATCH",
            severity: "CRITICAL",
            providerRef: input.providerRef,
            expectedMinor: intent.amountMinor,
            actualMinor: input.amountMinor,
            detail: `Provider confirmed ${input.amountMinor} for intent ${intent.reference} but ${intent.amountMinor} was requested.`,
          },
        });
      }

      const folio = await tx.folio.findUniqueOrThrow({ where: { id: intent.folioId } });
      const property = await tx.property.findUniqueOrThrow({ where: { id: intent.propertyId } });

      const payment = await tx.payment.create({
        data: {
          tenantId: intent.tenantId,
          propertyId: intent.propertyId,
          folioId: intent.folioId,
          method: "CARD",
          provider: intent.provider,
          amountMinor: amount,
          status: "CONFIRMED",
          externalReference: input.providerRef ?? intent.reference,
          idempotencyKey: `intent:${intent.id}`,
          intentId: intent.id,
          feeMinor: input.feeMinor ?? 0n,
          recordedById: input.actorId,
        },
      });
      await tx.folioEntry.create({
        data: {
          tenantId: intent.tenantId,
          folioId: folio.id,
          type: "PAYMENT",
          description: `${intent.provider} payment (${input.providerRef ?? intent.reference})`,
          amountMinor: -amount,
          businessDate: property.businessDate,
          postedById: input.actorId,
        },
      });
      await tx.paymentIntent.update({
        where: { id: intent.id },
        data: {
          status: "CONFIRMED",
          confirmedAt: new Date(),
          providerRef: input.providerRef ?? intent.providerRef,
        },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: intent.tenantId,
          propertyId: intent.propertyId,
          actorType: input.actorId ? "USER" : "SYSTEM",
          actorId: input.actorId,
          action: "payment.confirmed",
          entityType: "payment",
          entityId: payment.id,
          summary: JSON.stringify({
            provider: intent.provider,
            amountMinor: Number(amount),
            source: input.source,
          }),
        },
      });
      await tx.outboxEvent.create({
        data: {
          tenantId: intent.tenantId,
          aggregateType: "payment",
          aggregateId: payment.id,
          eventType: "payment.confirmed",
          payload: JSON.stringify({
            folioId: folio.id,
            amountMinor: Number(amount),
            provider: intent.provider,
          }),
        },
      });
      return payment;
    });
  }

  // ── Webhooks ───────────────────────────────────────────────────────────

  /**
   * Handles an inbound provider webhook.
   *
   * Order matters: store the delivery, verify the signature over the raw
   * bytes, dedupe, then act. Storing first means a rejected delivery is still
   * visible — a burst of bad signatures is exactly what an attack looks like.
   *
   * Always returns 200 once the signature is valid. Providers retry on
   * non-2xx, so returning an error for a business-level problem (unknown
   * reference, duplicate) would cause an endless retry storm.
   */
  async handleWebhook(
    providerName: string,
    rawBody: Buffer | undefined,
    headers: Record<string, string | undefined>
  ) {
    const provider = PROVIDERS[providerName.toUpperCase()];
    if (!provider) {
      throw new NotFoundException({
        error: { code: "UNKNOWN_PROVIDER", message: "No such payment provider." },
      });
    }
    if (!rawBody || rawBody.length === 0) {
      throw new BadRequestException({
        error: { code: "EMPTY_BODY", message: "Webhook body was empty." },
      });
    }

    const valid = provider.verifySignature(rawBody, headers);
    const bodyHash = createHash("sha256").update(rawBody).digest("hex");

    let parsed: ReturnType<typeof provider.parseWebhook> | null = null;
    try {
      parsed = provider.parseWebhook(rawBody);
    } catch {
      parsed = null;
    }
    const externalId = parsed?.externalId ?? bodyHash;

    // Record every delivery, valid or not.
    let event;
    try {
      event = await this.prisma.webhookEvent.create({
        data: {
          provider: provider.name,
          externalId,
          eventType: parsed?.eventType,
          rawBody: rawBody.toString("utf8").slice(0, 20000),
          signature:
            headers["x-paystack-signature"] ?? headers["verif-hash"] ?? null,
          signatureValid: valid,
          status: valid ? "RECEIVED" : "REJECTED",
          rejectReason: valid ? null : "Signature verification failed",
        },
      });
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "P2002") {
        // Already delivered. Providers retry aggressively; replaying must not
        // post the money twice.
        return { received: true, duplicate: true, note: "Delivery already processed." };
      }
      throw e;
    }

    if (!valid) {
      // 401 tells a genuine provider its secret is wrong, and tells an
      // attacker nothing they did not already know.
      throw new BadRequestException({
        error: {
          code: "INVALID_SIGNATURE",
          message: "Webhook signature verification failed.",
        },
      });
    }

    if (!parsed || !parsed.isSuccessfulPayment) {
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { status: "IGNORED", processedAt: new Date(), rejectReason: "Not a successful payment event" },
      });
      return { received: true, ignored: true, eventType: parsed?.eventType ?? "unparseable" };
    }

    const intent = parsed.reference
      ? await this.prisma.paymentIntent.findFirst({ where: { reference: parsed.reference } })
      : null;

    if (!intent) {
      // Money arrived that we cannot attribute. That is a finance problem,
      // not a reason to fail the webhook.
      await this.prisma.$transaction(async (tx) => {
        await tx.webhookEvent.update({
          where: { id: event.id },
          data: { status: "PROCESSED", processedAt: new Date() },
        });
        await tx.reconciliationException.create({
          data: {
            tenantId: "unknown",
            propertyId: "unknown",
            kind: "UNKNOWN_IN_SETTLEMENT",
            severity: "CRITICAL",
            providerRef: parsed.providerRef,
            actualMinor: parsed.amountMinor,
            detail: `${provider.name} reported a successful payment for reference "${parsed.reference}" which matches no payment intent.`,
          },
        });
      });
      return { received: true, unmatched: true, note: "No matching intent; exception raised." };
    }

    const payment = await this.confirmIntent(intent.id, {
      providerRef: parsed.providerRef,
      amountMinor: parsed.amountMinor,
      feeMinor: parsed.feeMinor,
      source: "webhook",
    });
    await this.prisma.webhookEvent.update({
      where: { id: event.id },
      data: {
        status: "PROCESSED",
        processedAt: new Date(),
        tenantId: intent.tenantId,
        intentId: intent.id,
      },
    });
    return {
      received: true,
      confirmed: true,
      paymentId: payment?.id ?? null,
      alreadyConfirmed: payment === null,
    };
  }

  // ── Refunds ────────────────────────────────────────────────────────────

  async requestRefund(auth: AuthContext, body: unknown) {
    const dto = refundSchema.parse(body);
    const payment = await this.prisma.payment.findFirst({
      where: { id: dto.paymentId, tenantId: auth.tenantId },
    });
    if (!payment) {
      throw new NotFoundException({
        error: { code: "PAYMENT_NOT_FOUND", message: "Payment not found." },
      });
    }
    if (payment.status !== "CONFIRMED") {
      throw new ConflictException({
        error: { code: "PAYMENT_NOT_REFUNDABLE", message: `A ${payment.status} payment cannot be refunded.` },
      });
    }
    const remaining = payment.amountMinor - payment.refundedMinor;
    if (BigInt(dto.amountMinor) > remaining) {
      throw new ConflictException({
        error: {
          code: "REFUND_EXCEEDS_PAYMENT",
          message: `Only ${Number(remaining) / 100} remains refundable on this payment.`,
          details: { remainingMinor: Number(remaining) },
        },
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const refund = await tx.refund.create({
        data: {
          tenantId: auth.tenantId,
          propertyId: payment.propertyId,
          paymentId: payment.id,
          folioId: payment.folioId,
          amountMinor: BigInt(dto.amountMinor),
          reason: dto.reason,
          method: payment.method,
          requestedById: auth.userId,
        },
      });
      await this.audit.log(tx, auth, {
        action: "refund.requested",
        entityType: "refund",
        entityId: refund.id,
        propertyId: payment.propertyId,
        summary: { paymentId: payment.id, amountMinor: dto.amountMinor, reason: dto.reason },
      });
      return refund;
    });
  }

  /** §13.4 — a refund always needs a second, authorised pair of eyes. */
  async decideRefund(auth: AuthContext, id: string, approve: boolean, body: unknown) {
    const dto = decisionSchema.parse(body ?? {});
    const refund = await this.prisma.refund.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { payment: true },
    });
    if (!refund) {
      throw new NotFoundException({
        error: { code: "REFUND_NOT_FOUND", message: "Refund not found." },
      });
    }
    if (refund.status !== "PENDING_APPROVAL") {
      throw new ConflictException({
        error: { code: "ALREADY_DECIDED", message: `Refund is already ${refund.status}.` },
      });
    }
    if (!APPROVER_ROLES.includes(auth.role)) {
      throw new ConflictException({
        error: { code: "FORBIDDEN_ROLE", message: "Only finance, a manager or the owner can approve a refund." },
      });
    }
    if (refund.requestedById === auth.userId) {
      throw new ConflictException({
        error: { code: "SELF_APPROVAL", message: "You cannot approve your own refund request." },
      });
    }

    if (!approve) {
      return this.prisma.$transaction(async (tx) => {
        const rejected = await tx.refund.update({
          where: { id: refund.id },
          data: { status: "REJECTED", approvedById: auth.userId, decisionNote: dto.note },
        });
        await this.audit.log(tx, auth, {
          action: "refund.rejected",
          entityType: "refund",
          entityId: refund.id,
          propertyId: refund.propertyId,
          summary: { note: dto.note },
        });
        return rejected;
      });
    }

    // Card refunds go back through the gateway; cash and transfer are handed
    // over at the desk and only recorded.
    let providerNote = "Recorded for manual payout.";
    let providerRef: string | undefined;
    if (refund.payment.provider && PROVIDERS[refund.payment.provider]) {
      const provider = PROVIDERS[refund.payment.provider];
      const result = await provider.refund({
        providerRef: refund.payment.externalReference ?? "",
        amountMinor: refund.amountMinor,
        reason: refund.reason,
      });
      providerNote = result.note;
      providerRef = result.providerRef;
      if (!result.accepted && provider.live) {
        return this.prisma.$transaction(async (tx) => {
          const failed = await tx.refund.update({
            where: { id: refund.id },
            data: { status: "FAILED", approvedById: auth.userId, decisionNote: result.note },
          });
          await this.audit.log(tx, auth, {
            action: "refund.failed",
            entityType: "refund",
            entityId: refund.id,
            propertyId: refund.propertyId,
            summary: { note: result.note },
          });
          return failed;
        });
      }
    }

    return this.prisma.transactionWithRetry(async (tx) => {
      const property = await tx.property.findUniqueOrThrow({ where: { id: refund.propertyId } });
      // A refund is a positive folio entry: it removes credit the guest had.
      await tx.folioEntry.create({
        data: {
          tenantId: auth.tenantId,
          folioId: refund.folioId,
          type: "REFUND",
          description: `Refund — ${refund.reason}`,
          amountMinor: refund.amountMinor,
          businessDate: property.businessDate,
          postedById: auth.userId,
        },
      });
      await tx.payment.update({
        where: { id: refund.paymentId },
        data: {
          refundedMinor: { increment: refund.amountMinor },
          status:
            refund.payment.refundedMinor + refund.amountMinor >= refund.payment.amountMinor
              ? "REFUNDED"
              : "CONFIRMED",
        },
      });
      const approved = await tx.refund.update({
        where: { id: refund.id },
        data: {
          status: "APPROVED",
          approvedById: auth.userId,
          decisionNote: dto.note ?? providerNote,
          providerRef,
          settledAt: new Date(),
        },
      });
      await this.audit.log(tx, auth, {
        action: "refund.approved",
        entityType: "refund",
        entityId: refund.id,
        propertyId: refund.propertyId,
        summary: {
          amountMinor: Number(refund.amountMinor),
          requestedBy: refund.requestedById,
          providerNote,
        },
      });
      return { ...approved, providerNote };
    });
  }

  listRefunds(auth: AuthContext, propertyId?: string, status?: string) {
    return this.prisma.refund.findMany({
      where: {
        tenantId: auth.tenantId,
        ...(propertyId ? { propertyId } : {}),
        ...(status && status !== "ALL" ? { status } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  // ── Settlement import & reconciliation ─────────────────────────────────

  /**
   * §13.2 — imports a provider payout and reconciles it against our payments.
   *
   * Three things can go wrong and each becomes an exception rather than a
   * silent adjustment: the provider paid for something we never recorded, we
   * recorded something the provider never paid for, or the amounts differ.
   */
  async importSettlement(auth: AuthContext, body: unknown) {
    const dto = settlementSchema.parse(body);
    await this.properties.assertProperty(auth, dto.propertyId);
    if (!APPROVER_ROLES.includes(auth.role)) {
      throw new ConflictException({
        error: { code: "FORBIDDEN_ROLE", message: "Only finance, a manager or the owner can import settlements." },
      });
    }

    const gross = dto.lines.reduce((s, l) => s + BigInt(l.amountMinor), 0n);
    const fees = dto.lines.reduce((s, l) => s + BigInt(l.feeMinor), 0n);

    return this.prisma.transactionWithRetry(async (tx) => {
      const existing = await tx.settlement.findFirst({
        where: { tenantId: auth.tenantId, provider: dto.provider, reference: dto.reference },
      });
      if (existing) {
        throw new ConflictException({
          error: {
            code: "SETTLEMENT_ALREADY_IMPORTED",
            message: `Settlement ${dto.reference} has already been imported.`,
          },
        });
      }

      const settlement = await tx.settlement.create({
        data: {
          tenantId: auth.tenantId,
          propertyId: dto.propertyId,
          provider: dto.provider,
          reference: dto.reference,
          settledOn: dto.settledOn,
          grossMinor: gross,
          feeMinor: fees,
          netMinor: gross - fees,
          importedById: auth.userId,
        },
      });

      const exceptions: { kind: string; detail: string }[] = [];
      const seenRefs = new Set<string>();
      let matched = 0;

      for (const line of dto.lines) {
        if (seenRefs.has(line.providerRef)) {
          exceptions.push({
            kind: "DUPLICATE_REFERENCE",
            detail: `Reference ${line.providerRef} appears more than once in this settlement.`,
          });
          await tx.reconciliationException.create({
            data: {
              tenantId: auth.tenantId,
              propertyId: dto.propertyId,
              settlementId: settlement.id,
              kind: "DUPLICATE_REFERENCE",
              severity: "CRITICAL",
              providerRef: line.providerRef,
              actualMinor: BigInt(line.amountMinor),
              detail: `Reference ${line.providerRef} appears more than once in settlement ${dto.reference}.`,
            },
          });
          continue;
        }
        seenRefs.add(line.providerRef);

        const created = await tx.settlementLine.create({
          data: {
            tenantId: auth.tenantId,
            settlementId: settlement.id,
            providerRef: line.providerRef,
            amountMinor: BigInt(line.amountMinor),
            feeMinor: BigInt(line.feeMinor),
            netMinor: BigInt(line.amountMinor - line.feeMinor),
            paidOn: line.paidOn,
          },
        });

        const payment = await tx.payment.findFirst({
          where: {
            tenantId: auth.tenantId,
            propertyId: dto.propertyId,
            provider: dto.provider,
            externalReference: line.providerRef,
            status: { in: ["CONFIRMED", "REFUNDED"] },
            settlementLineId: null,
          },
        });

        if (!payment) {
          await tx.settlementLine.update({
            where: { id: created.id },
            data: { status: "EXCEPTION" },
          });
          await tx.reconciliationException.create({
            data: {
              tenantId: auth.tenantId,
              propertyId: dto.propertyId,
              settlementId: settlement.id,
              kind: "UNKNOWN_IN_SETTLEMENT",
              severity: "CRITICAL",
              providerRef: line.providerRef,
              actualMinor: BigInt(line.amountMinor),
              detail: `${dto.provider} paid out ${line.providerRef} but no matching payment exists in Lodgiva.`,
            },
          });
          exceptions.push({
            kind: "UNKNOWN_IN_SETTLEMENT",
            detail: `No payment matches ${line.providerRef}.`,
          });
          continue;
        }

        if (payment.amountMinor !== BigInt(line.amountMinor)) {
          await tx.settlementLine.update({
            where: { id: created.id },
            data: { status: "EXCEPTION" },
          });
          await tx.reconciliationException.create({
            data: {
              tenantId: auth.tenantId,
              propertyId: dto.propertyId,
              settlementId: settlement.id,
              kind: "AMOUNT_MISMATCH",
              severity: "CRITICAL",
              providerRef: line.providerRef,
              paymentId: payment.id,
              expectedMinor: payment.amountMinor,
              actualMinor: BigInt(line.amountMinor),
              detail: `Settlement shows ${line.amountMinor} for ${line.providerRef}; Lodgiva recorded ${payment.amountMinor}.`,
            },
          });
          exceptions.push({
            kind: "AMOUNT_MISMATCH",
            detail: `${line.providerRef}: expected ${payment.amountMinor}, settled ${line.amountMinor}.`,
          });
          continue;
        }

        await tx.settlementLine.update({
          where: { id: created.id },
          data: { status: "MATCHED" },
        });
        await tx.payment.update({
          where: { id: payment.id },
          data: { settlementLineId: created.id, feeMinor: BigInt(line.feeMinor) },
        });
        matched++;
      }

      // Payments we booked on that date which the provider has not paid out.
      const unsettled = await tx.payment.findMany({
        where: {
          tenantId: auth.tenantId,
          propertyId: dto.propertyId,
          provider: dto.provider,
          status: "CONFIRMED",
          settlementLineId: null,
          receivedAt: { lte: new Date(`${dto.settledOn}T23:59:59Z`) },
        },
        take: 500,
      });
      for (const p of unsettled) {
        await tx.reconciliationException.create({
          data: {
            tenantId: auth.tenantId,
            propertyId: dto.propertyId,
            settlementId: settlement.id,
            kind: "MISSING_IN_SETTLEMENT",
            severity: "WARNING",
            providerRef: p.externalReference,
            paymentId: p.id,
            expectedMinor: p.amountMinor,
            detail: `Payment ${p.externalReference ?? p.id} was confirmed but does not appear in settlement ${dto.reference}.`,
          },
        });
        exceptions.push({
          kind: "MISSING_IN_SETTLEMENT",
          detail: `${p.externalReference ?? p.id} not in payout.`,
        });
      }

      await tx.settlement.update({
        where: { id: settlement.id },
        data: { status: exceptions.length === 0 ? "RECONCILED" : "IMPORTED" },
      });
      await this.audit.log(tx, auth, {
        action: "settlement.imported",
        entityType: "settlement",
        entityId: settlement.id,
        propertyId: dto.propertyId,
        summary: {
          reference: dto.reference,
          lines: dto.lines.length,
          matched,
          exceptions: exceptions.length,
          grossMinor: Number(gross),
          netMinor: Number(gross - fees),
        },
      });

      return {
        settlementId: settlement.id,
        reference: dto.reference,
        lines: dto.lines.length,
        matched,
        grossMinor: Number(gross),
        feeMinor: Number(fees),
        netMinor: Number(gross - fees),
        exceptions,
        status: exceptions.length === 0 ? "RECONCILED" : "IMPORTED",
      };
    });
  }

  /**
   * Imports a provider settlement from its CSV export.
   *
   * Parsing is separated from reconciliation: this maps the file onto lines
   * and then hands them to the same importSettlement path, so a CSV and a
   * JSON import cannot diverge in how they reconcile.
   */
  async importSettlementCsv(auth: AuthContext, body: unknown) {
    const dto = settlementCsvSchema.parse(body);
    const parsed = parseSettlementCsv(dto.provider, dto.csv, {
      amountsAreMajor: dto.amountsAreMajor,
    });

    if (parsed.lines.length === 0) {
      throw new BadRequestException({
        error: {
          code: "NO_USABLE_ROWS",
          message: "No rows in this file could be read as settlement lines.",
          details: { skipped: parsed.skipped.slice(0, 20) },
        },
      });
    }
    // Silently importing a file with unreadable rows understates the payout,
    // so strict mode lets finance refuse rather than reconcile against a
    // partial picture.
    if (dto.strict && parsed.skipped.length > 0) {
      throw new BadRequestException({
        error: {
          code: "CSV_HAS_UNREADABLE_ROWS",
          message: `${parsed.skipped.length} row(s) could not be read. Fix the file or import without strict mode.`,
          details: { skipped: parsed.skipped.slice(0, 20) },
        },
      });
    }

    const result = await this.importSettlement(auth, {
      propertyId: dto.propertyId,
      provider: dto.provider,
      reference: dto.reference,
      settledOn: dto.settledOn,
      lines: parsed.lines,
    });
    return {
      ...result,
      parsed: {
        rows: parsed.lines.length,
        skipped: parsed.skipped,
        totalMinor: parsed.totalMinor,
        feeTotalMinor: parsed.feeTotalMinor,
      },
    };
  }

  async listExceptions(auth: AuthContext, propertyId: string, status = "OPEN") {
    await this.properties.assertProperty(auth, propertyId);
    const rows = await this.prisma.reconciliationException.findMany({
      where: {
        tenantId: auth.tenantId,
        propertyId,
        ...(status === "ALL" ? {} : { status }),
      },
      orderBy: [{ severity: "asc" }, { createdAt: "desc" }],
      take: 200,
    });
    return rows.map((r) => ({
      ...r,
      expectedMinor: r.expectedMinor === null ? null : Number(r.expectedMinor),
      actualMinor: r.actualMinor === null ? null : Number(r.actualMinor),
    }));
  }

  async resolveException(auth: AuthContext, id: string, body: unknown) {
    const dto = z
      .object({
        resolution: z.enum(["RESOLVED", "WRITTEN_OFF"]),
        note: z.string().min(3),
      })
      .strict()
      .parse(body);

    if (!APPROVER_ROLES.includes(auth.role)) {
      throw new ConflictException({
        error: { code: "FORBIDDEN_ROLE", message: "Only finance, a manager or the owner can resolve exceptions." },
      });
    }
    const ex = await this.prisma.reconciliationException.findFirst({
      where: { id, tenantId: auth.tenantId },
    });
    if (!ex) {
      throw new NotFoundException({
        error: { code: "EXCEPTION_NOT_FOUND", message: "Exception not found." },
      });
    }
    if (ex.status !== "OPEN") {
      throw new ConflictException({
        error: { code: "ALREADY_RESOLVED", message: `Exception is already ${ex.status}.` },
      });
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.reconciliationException.update({
        where: { id: ex.id },
        data: {
          status: dto.resolution,
          resolvedById: auth.userId,
          resolutionNote: dto.note,
          resolvedAt: new Date(),
        },
      });
      await this.audit.log(tx, auth, {
        action: "reconciliation.exception_resolved",
        entityType: "reconciliation_exception",
        entityId: ex.id,
        propertyId: ex.propertyId,
        summary: { kind: ex.kind, resolution: dto.resolution, note: dto.note },
      });
      return updated;
    });
  }

  async listSettlements(auth: AuthContext, propertyId: string) {
    await this.properties.assertProperty(auth, propertyId);
    const rows = await this.prisma.settlement.findMany({
      where: { tenantId: auth.tenantId, propertyId },
      orderBy: { settledOn: "desc" },
      take: 50,
      include: { _count: { select: { lines: true, exceptions: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      reference: r.reference,
      settledOn: r.settledOn,
      grossMinor: Number(r.grossMinor),
      feeMinor: Number(r.feeMinor),
      netMinor: Number(r.netMinor),
      status: r.status,
      lines: r._count.lines,
      exceptions: r._count.exceptions,
    }));
  }

  /** Which adapters are configured, so the UI never offers a dead option. */
  providerStatus() {
    return Object.values(PROVIDERS).map((p) => ({
      name: p.name,
      live: p.live,
      mode: p.live ? "LIVE" : "SANDBOX",
      note: p.live
        ? "Credentials configured; transactions are verified against the provider."
        : "No credentials configured. Checkout URLs are placeholders, verification and refunds cannot reach the provider, and webhook signatures will not validate without the shared secret.",
    }));
  }
}

@Controller()
export class GatewayController {
  constructor(private readonly service: GatewayService) {}

  @Get("payments/providers")
  providers() {
    return this.service.providerStatus();
  }

  @Post("payments/intents")
  createIntent(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.createIntent(auth, body);
  }

  @Post("payments/intents/:id/verify")
  verifyIntent(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.verifyIntent(auth, id);
  }

  /**
   * Public: providers cannot authenticate. The signature over the raw body is
   * the authentication.
   */
  @Public()
  @Post("webhooks/:provider")
  webhook(
    @Param("provider") provider: string,
    @Req() req: { rawBody?: Buffer },
    @Headers() headers: Record<string, string | undefined>
  ) {
    return this.service.handleWebhook(provider, req.rawBody, headers);
  }

  @Post("refunds")
  requestRefund(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.requestRefund(auth, body);
  }

  @Get("refunds")
  listRefunds(
    @CurrentAuth() auth: AuthContext,
    @Query("propertyId") propertyId?: string,
    @Query("status") status?: string
  ) {
    return this.service.listRefunds(auth, propertyId, status);
  }

  @Post("refunds/:id/approve")
  approveRefund(@CurrentAuth() auth: AuthContext, @Param("id") id: string, @Body() body: unknown) {
    return this.service.decideRefund(auth, id, true, body);
  }

  @Post("refunds/:id/reject")
  rejectRefund(@CurrentAuth() auth: AuthContext, @Param("id") id: string, @Body() body: unknown) {
    return this.service.decideRefund(auth, id, false, body);
  }

  @Post("settlements/import")
  importSettlement(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.importSettlement(auth, body);
  }

  @Post("settlements/import-csv")
  importSettlementCsv(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.importSettlementCsv(auth, body);
  }

  @Get("settlements")
  listSettlements(@CurrentAuth() auth: AuthContext, @Query("propertyId") propertyId: string) {
    return this.service.listSettlements(auth, propertyId);
  }

  @Get("reconciliation/exceptions")
  exceptions(
    @CurrentAuth() auth: AuthContext,
    @Query("propertyId") propertyId: string,
    @Query("status") status?: string
  ) {
    return this.service.listExceptions(auth, propertyId, status);
  }

  @Post("reconciliation/exceptions/:id/resolve")
  resolveException(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown
  ) {
    return this.service.resolveException(auth, id, body);
  }
}

@Module({
  imports: [FoliosModule, PropertiesModule],
  controllers: [GatewayController],
  providers: [GatewayService],
})
export class GatewayModule {}
