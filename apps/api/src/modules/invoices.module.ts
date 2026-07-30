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
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { AuthContext, CurrentAuth } from "../common/auth";
import { AuditService } from "../common/audit.service";
import { FoliosModule, FoliosService } from "./folios.module";
import { PropertiesModule, PropertiesService } from "./properties.module";

type Tx = Prisma.TransactionClient;

const issueSchema = z
  .object({
    folioId: z.string().min(1),
    type: z.enum(["INVOICE", "RECEIPT"]).default("INVOICE"),
    /** Billing party override, e.g. the company paying a split folio. */
    billTo: z.string().optional(),
  })
  .strict();

const voidSchema = z.object({ reason: z.string().min(3) }).strict();

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly folios: FoliosService,
    private readonly properties: PropertiesService
  ) {}

  /**
   * Gapless sequence per property and year.
   *
   * The counter is a row that is read and written inside the issuing
   * transaction. Deriving the number from COUNT(*) would both race and leave
   * holes when a transaction rolls back — and a tax authority reads a hole as
   * a deleted invoice.
   */
  private async nextInvoiceNumber(
    tx: Tx,
    tenantId: string,
    propertyId: string,
    propertyCode: string,
    businessDate: string
  ): Promise<string> {
    const series = businessDate.slice(0, 4);
    const existing = await tx.invoiceSequence.findFirst({
      where: { propertyId, series },
    });
    const row = existing
      ? await tx.invoiceSequence.update({
          where: { id: existing.id },
          data: { lastNumber: { increment: 1 } },
        })
      : await tx.invoiceSequence.create({
          data: { tenantId, propertyId, series, lastNumber: 1 },
        });
    return `${propertyCode}/${series}/${String(row.lastNumber).padStart(6, "0")}`;
  }

  async issue(auth: AuthContext, body: unknown) {
    const dto = issueSchema.parse(body);

    return this.prisma.transactionWithRetry(async (tx) => {
      const folio = await tx.folio.findFirst({
        where: { id: dto.folioId, tenantId: auth.tenantId },
        include: {
          guest: true,
          reservation: { select: { confirmationCode: true, arrivalDate: true, departureDate: true } },
          entries: { orderBy: { postedAt: "asc" } },
        },
      });
      if (!folio) {
        throw new NotFoundException({
          error: { code: "FOLIO_NOT_FOUND", message: "Folio not found." },
        });
      }
      if (folio.entries.length === 0) {
        throw new BadRequestException({
          error: { code: "NOTHING_TO_INVOICE", message: "This folio has no postings yet." },
        });
      }

      const property = await tx.property.findUniqueOrThrow({
        where: { id: folio.propertyId },
      });

      // Charges and taxes are separated so the document shows a tax breakdown
      // rather than one opaque total.
      let subtotal = 0n;
      let tax = 0n;
      let paid = 0n;
      const lines = [];
      for (const e of folio.entries) {
        if (e.type === "PAYMENT" || e.type === "REFUND") {
          paid += -e.amountMinor;
        } else if (e.type === "TAX" || e.type === "SERVICE_CHARGE") {
          tax += e.amountMinor;
        } else {
          subtotal += e.amountMinor;
        }
        lines.push({
          postedAt: e.postedAt.toISOString(),
          businessDate: e.businessDate,
          type: e.type,
          description: e.description,
          taxCode: e.taxCode,
          taxRuleVersion: e.taxRuleVersion,
          amountMinor: Number(e.amountMinor),
        });
      }
      const total = subtotal + tax;

      const invoiceNumber = await this.nextInvoiceNumber(
        tx,
        auth.tenantId,
        folio.propertyId,
        property.code,
        property.businessDate
      );

      // The snapshot is what makes the document immutable: later postings to
      // the folio cannot retroactively change what was invoiced.
      const snapshot = {
        invoiceNumber,
        issuedAt: new Date().toISOString(),
        property: {
          name: property.name,
          code: property.code,
          timezone: property.timezone,
        },
        billTo:
          dto.billTo ?? `${folio.guest.firstName} ${folio.guest.lastName}`,
        guest: {
          name: `${folio.guest.firstName} ${folio.guest.lastName}`,
          email: folio.guest.email,
          phone: folio.guest.phone,
        },
        reservation: folio.reservation
          ? {
              confirmationCode: folio.reservation.confirmationCode,
              arrivalDate: folio.reservation.arrivalDate,
              departureDate: folio.reservation.departureDate,
            }
          : null,
        folio: { id: folio.id, label: folio.label },
        lines,
        totals: {
          subtotalMinor: Number(subtotal),
          taxMinor: Number(tax),
          totalMinor: Number(total),
          paidMinor: Number(paid),
          balanceMinor: Number(total - paid),
        },
        currency: folio.currency,
      };

      const invoice = await tx.invoice.create({
        data: {
          tenantId: auth.tenantId,
          propertyId: folio.propertyId,
          folioId: folio.id,
          invoiceNumber,
          type: dto.type,
          snapshot: JSON.stringify(snapshot),
          subtotalMinor: subtotal,
          taxMinor: tax,
          totalMinor: total,
          paidMinor: paid,
          currency: folio.currency,
          businessDate: property.businessDate,
          issuedById: auth.userId,
        },
      });

      await this.audit.log(tx, auth, {
        action: "invoice.issued",
        entityType: "invoice",
        entityId: invoice.id,
        propertyId: folio.propertyId,
        summary: { invoiceNumber, totalMinor: Number(total), folioId: folio.id },
      });
      await this.audit.emit(tx, auth.tenantId, {
        aggregateType: "invoice",
        aggregateId: invoice.id,
        eventType: "invoice.issued",
        payload: { invoiceNumber, totalMinor: Number(total) },
      });

      return { ...invoice, snapshot };
    });
  }

  /**
   * Voids an invoice by issuing a credit note that references it. The original
   * keeps its number — a gapless sequence must never lose an entry, so the
   * document is cancelled rather than deleted.
   */
  async void(auth: AuthContext, id: string, body: unknown) {
    const dto = voidSchema.parse(body);
    if (!["TENANT_OWNER", "GENERAL_MANAGER", "FINANCE"].includes(auth.role)) {
      throw new ConflictException({
        error: {
          code: "FORBIDDEN_ROLE",
          message: "Only finance, a manager or the owner can void a tax document.",
        },
      });
    }

    return this.prisma.transactionWithRetry(async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!invoice) {
        throw new NotFoundException({
          error: { code: "INVOICE_NOT_FOUND", message: "Invoice not found." },
        });
      }
      if (invoice.status === "VOID") {
        throw new ConflictException({
          error: { code: "ALREADY_VOID", message: "This invoice is already void." },
        });
      }

      const property = await tx.property.findUniqueOrThrow({
        where: { id: invoice.propertyId },
      });
      const creditNumber = await this.nextInvoiceNumber(
        tx,
        auth.tenantId,
        invoice.propertyId,
        property.code,
        property.businessDate
      );

      const original = JSON.parse(invoice.snapshot);
      const creditNote = await tx.invoice.create({
        data: {
          tenantId: auth.tenantId,
          propertyId: invoice.propertyId,
          folioId: invoice.folioId,
          invoiceNumber: creditNumber,
          type: "CREDIT_NOTE",
          snapshot: JSON.stringify({
            ...original,
            invoiceNumber: creditNumber,
            creditNoteFor: invoice.invoiceNumber,
            reason: dto.reason,
            issuedAt: new Date().toISOString(),
            // Every amount is negated so the pair nets to zero.
            lines: original.lines.map((l: { amountMinor: number }) => ({
              ...l,
              amountMinor: -l.amountMinor,
            })),
            totals: Object.fromEntries(
              Object.entries(original.totals).map(([k, v]) => [k, -(v as number)])
            ),
          }),
          subtotalMinor: -invoice.subtotalMinor,
          taxMinor: -invoice.taxMinor,
          totalMinor: -invoice.totalMinor,
          paidMinor: -invoice.paidMinor,
          currency: invoice.currency,
          businessDate: property.businessDate,
          issuedById: auth.userId,
          reversesId: invoice.id,
        },
      });

      const voided = await tx.invoice.update({
        where: { id: invoice.id },
        data: { status: "VOID", voidedAt: new Date(), voidReason: dto.reason },
      });

      await this.audit.log(tx, auth, {
        action: "invoice.voided",
        entityType: "invoice",
        entityId: invoice.id,
        propertyId: invoice.propertyId,
        summary: {
          invoiceNumber: invoice.invoiceNumber,
          creditNote: creditNumber,
          reason: dto.reason,
        },
      });
      return { voided, creditNote };
    });
  }

  async get(auth: AuthContext, id: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, tenantId: auth.tenantId },
    });
    if (!invoice) {
      throw new NotFoundException({
        error: { code: "INVOICE_NOT_FOUND", message: "Invoice not found." },
      });
    }
    return { ...invoice, snapshot: JSON.parse(invoice.snapshot) };
  }

  async list(auth: AuthContext, propertyId: string, folioId?: string) {
    await this.properties.assertProperty(auth, propertyId);
    const rows = await this.prisma.invoice.findMany({
      where: {
        tenantId: auth.tenantId,
        propertyId,
        ...(folioId ? { folioId } : {}),
      },
      orderBy: { issuedAt: "desc" },
      take: 100,
    });
    return rows.map((r) => ({
      id: r.id,
      invoiceNumber: r.invoiceNumber,
      type: r.type,
      status: r.status,
      totalMinor: Number(r.totalMinor),
      taxMinor: Number(r.taxMinor),
      businessDate: r.businessDate,
      issuedAt: r.issuedAt,
    }));
  }

  /** Plain-text rendering, printable on the thermal printers desks actually own. */
  async render(auth: AuthContext, id: string): Promise<string> {
    const invoice = await this.get(auth, id);
    const s = invoice.snapshot as {
      invoiceNumber: string;
      issuedAt: string;
      property: { name: string };
      billTo: string;
      reservation: { confirmationCode: string; arrivalDate: string; departureDate: string } | null;
      lines: { description: string; amountMinor: number }[];
      totals: Record<string, number>;
      currency: string;
    };
    const money = (m: number) =>
      `${(m / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
    const width = 46;
    const row = (l: string, r: string) =>
      l.slice(0, width - r.length - 1).padEnd(width - r.length) + r;

    const out = [
      s.property.name.toUpperCase().padStart((width + s.property.name.length) / 2),
      "".padEnd(width, "="),
      `${invoice.type.replace("_", " ")}  ${s.invoiceNumber}`,
      `Issued  ${new Date(s.issuedAt).toLocaleString("en-NG")}`,
      `Bill to ${s.billTo}`,
    ];
    if (s.reservation) {
      out.push(`Booking ${s.reservation.confirmationCode}`);
      out.push(`Stay    ${s.reservation.arrivalDate} to ${s.reservation.departureDate}`);
    }
    out.push("".padEnd(width, "-"));
    for (const l of s.lines) out.push(row(l.description, money(l.amountMinor)));
    out.push("".padEnd(width, "-"));
    out.push(row("Subtotal", money(s.totals.subtotalMinor)));
    out.push(row("Tax & service", money(s.totals.taxMinor)));
    out.push(row("TOTAL", money(s.totals.totalMinor)));
    out.push(row("Paid", money(s.totals.paidMinor)));
    out.push(row("Balance due", money(s.totals.balanceMinor)));
    out.push("".padEnd(width, "="));
    if (invoice.status === "VOID") out.push("*** VOID ***");
    out.push(`All amounts in ${s.currency}.`);
    return out.join("\n");
  }
}

@Controller("invoices")
export class InvoicesController {
  constructor(private readonly service: InvoicesService) {}

  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query("propertyId") propertyId: string,
    @Query("folioId") folioId?: string
  ) {
    return this.service.list(auth, propertyId, folioId);
  }

  @Post()
  issue(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.issue(auth, body);
  }

  @Get(":id")
  get(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.get(auth, id);
  }

  @Get(":id/render")
  render(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.render(auth, id).then((text) => ({ text }));
  }

  @Post(":id/void")
  voidInvoice(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown
  ) {
    return this.service.void(auth, id, body);
  }
}

@Module({
  imports: [FoliosModule, PropertiesModule],
  controllers: [InvoicesController],
  providers: [InvoicesService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
