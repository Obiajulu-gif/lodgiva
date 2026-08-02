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
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { AuthContext, CurrentAuth } from "../common/auth";
import { AuditService } from "../common/audit.service";
import { nightsBetween } from "../common/money";
import { toCsv, ReportsModule, ReportsService } from "./reports.module";
import { renderTablePdf } from "../common/pdf";
import { PropertiesModule, PropertiesService } from "./properties.module";
import { FilesModule, FilesService } from "./files.module";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const EXPORT_TITLES: Record<string, string> = {
  DAILY_FLASH: "Daily flash",
  REVENUE: "Revenue by category",
  OCCUPANCY: "Occupancy, ADR and RevPAR",
  CASHIER: "Cashier report",
  TAX: "Tax summary",
  RECEIVABLES: "Aged receivables",
  GUEST_LEDGER: "Guest ledger",
  AUDIT: "Audit trail",
};

// Printed on the PDF so a figure cannot be read out of context once the file
// has left the building.
const EXPORT_NOTES: Record<string, string> = {
  REVENUE: "Excludes payments and refunds: those settle revenue, they are not revenue.",
  OCCUPANCY: "ADR is per room sold; RevPAR is per room available. Blocked rooms reduce availability.",
  CASHIER: "Shortages and overages are listed separately; netting them hides two different problems.",
  RECEIVABLES: "Ageing runs from the departure date, against the current business date.",
  TAX: "Rule version records which rate was in force when each line was posted.",
};

const exportSchema = z
  .object({
    propertyId: z.string().min(1),
    type: z.enum([
      "DAILY_FLASH",
      "REVENUE",
      "OCCUPANCY",
      "CASHIER",
      "TAX",
      "RECEIVABLES",
      "GUEST_LEDGER",
      "AUDIT",
    ]),
    format: z.enum(["CSV", "PDF"]).default("CSV"),
    from: isoDate,
    to: isoDate,
  })
  .strict();

/**
 * §14 Reporting.
 *
 * Every figure here is derived from the ledger and the allocation table — the
 * same rows the night audit and the invoices read. Nothing is kept in a
 * denormalised counter that could drift away from the money it claims to
 * describe.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly properties: PropertiesService,
    private readonly files: FilesService,
    private readonly reports: ReportsService
  ) {}

  private assertRange(from: string, to: string) {
    if (!from || !to || from > to) {
      throw new BadRequestException({
        error: { code: "INVALID_DATE_RANGE", message: "`to` must be on or after `from`." },
      });
    }
    if (nightsBetween(from, to).length > 400) {
      throw new BadRequestException({
        error: { code: "RANGE_TOO_LONG", message: "Report ranges are limited to 400 days." },
      });
    }
  }

  /**
   * §14.1 occupancy, ADR and RevPAR.
   *
   * ADR divides room revenue by rooms SOLD; RevPAR divides the same revenue by
   * rooms AVAILABLE. Confusing the two flatters a half-empty hotel, so both
   * denominators are computed explicitly and returned alongside the rates.
   */
  async occupancy(auth: AuthContext, propertyId: string, from: string, to: string) {
    await this.properties.assertProperty(auth, propertyId);
    this.assertRange(from, to);

    const totalRooms = await this.prisma.room.count({
      where: { tenantId: auth.tenantId, propertyId },
    });
    const dates = nightsBetween(from, to).concat(to);

    const days = [];
    for (const date of dates) {
      const sold = await this.prisma.roomNightAllocation.count({
        where: {
          tenantId: auth.tenantId,
          propertyId,
          date,
          reservationRoomId: { not: null },
        },
      });
      const blocked = await this.prisma.roomBlock.count({
        where: {
          tenantId: auth.tenantId,
          propertyId,
          status: "ACTIVE",
          startDate: { lte: date },
          endDate: { gt: date },
        },
      });
      const roomRevenue = await this.prisma.folioEntry.aggregate({
        where: {
          tenantId: auth.tenantId,
          businessDate: date,
          type: "ROOM_CHARGE",
          folio: { propertyId },
        },
        _sum: { amountMinor: true },
      });

      const available = Math.max(0, totalRooms - blocked);
      const revenueMinor = Number(roomRevenue._sum.amountMinor ?? 0n);
      days.push({
        date,
        totalRooms,
        blocked,
        available,
        sold,
        occupancyPct: available ? Math.round((sold / available) * 100) : 0,
        roomRevenueMinor: revenueMinor,
        // ADR is per room SOLD; RevPAR is per room AVAILABLE.
        adrMinor: sold ? Math.round(revenueMinor / sold) : 0,
        revparMinor: available ? Math.round(revenueMinor / available) : 0,
      });
    }

    const totalSold = days.reduce((s, d) => s + d.sold, 0);
    const totalAvailable = days.reduce((s, d) => s + d.available, 0);
    const totalRevenue = days.reduce((s, d) => s + d.roomRevenueMinor, 0);
    return {
      from,
      to,
      days,
      totals: {
        roomNightsSold: totalSold,
        roomNightsAvailable: totalAvailable,
        occupancyPct: totalAvailable ? Math.round((totalSold / totalAvailable) * 100) : 0,
        roomRevenueMinor: totalRevenue,
        adrMinor: totalSold ? Math.round(totalRevenue / totalSold) : 0,
        revparMinor: totalAvailable ? Math.round(totalRevenue / totalAvailable) : 0,
      },
    };
  }

  /** Revenue split by what produced it, net of discounts and reversals. */
  async revenue(auth: AuthContext, propertyId: string, from: string, to: string) {
    await this.properties.assertProperty(auth, propertyId);
    this.assertRange(from, to);

    const entries = await this.prisma.folioEntry.findMany({
      where: {
        tenantId: auth.tenantId,
        businessDate: { gte: from, lte: to },
        folio: { propertyId },
      },
      select: { type: true, amountMinor: true, businessDate: true, taxCode: true },
    });

    const buckets = new Map<string, number>();
    let grossMinor = 0;
    let taxMinor = 0;
    let discountMinor = 0;
    for (const e of entries) {
      const amount = Number(e.amountMinor);
      if (e.type === "PAYMENT" || e.type === "REFUND") continue; // settlement, not revenue
      if (e.type === "TAX" || e.type === "SERVICE_CHARGE") {
        taxMinor += amount;
        continue;
      }
      if (e.type === "DISCOUNT") {
        discountMinor += amount;
        continue;
      }
      // REVERSAL carries the sign of what it undoes, so it nets correctly.
      buckets.set(e.type, (buckets.get(e.type) ?? 0) + amount);
      grossMinor += amount;
    }

    return {
      from,
      to,
      byCategory: [...buckets.entries()]
        .map(([category, amountMinor]) => ({ category, amountMinor }))
        .sort((a, b) => b.amountMinor - a.amountMinor),
      grossMinor,
      discountMinor,
      taxMinor,
      netMinor: grossMinor + discountMinor,
      totalBilledMinor: grossMinor + discountMinor + taxMinor,
    };
  }

  /** §14.1 cashier report — who took what, and did their drawer balance. */
  async cashier(auth: AuthContext, propertyId: string, from: string, to: string) {
    await this.properties.assertProperty(auth, propertyId);
    this.assertRange(from, to);

    const shifts = await this.prisma.cashierShift.findMany({
      where: {
        tenantId: auth.tenantId,
        propertyId,
        openedAt: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T23:59:59Z`) },
      },
      include: { movements: true, _count: { select: { posOrders: true } } },
      orderBy: { openedAt: "asc" },
    });

    const rows = shifts.map((s) => ({
      shiftNumber: s.shiftNumber,
      userId: s.userId,
      status: s.status,
      openedAt: s.openedAt,
      closedAt: s.closedAt,
      openingFloatMinor: Number(s.openingFloatMinor),
      expectedMinor: Number(s.expectedMinor ?? 0n),
      countedMinor: Number(s.countedMinor ?? 0n),
      varianceMinor: Number(s.varianceMinor ?? 0n),
      varianceReason: s.varianceReason,
      approved: !!s.approvedById,
      movements: s.movements.length,
      posOrders: s._count.posOrders,
    }));

    return {
      from,
      to,
      shifts: rows,
      totals: {
        shifts: rows.length,
        // Shortages and overages are reported separately: they net to nothing
        // in aggregate while hiding two different problems.
        shortageMinor: rows.filter((r) => r.varianceMinor < 0).reduce((s, r) => s + r.varianceMinor, 0),
        overageMinor: rows.filter((r) => r.varianceMinor > 0).reduce((s, r) => s + r.varianceMinor, 0),
        unapprovedVariances: rows.filter((r) => r.varianceMinor !== 0 && !r.approved).length,
      },
    };
  }

  /** Who owes money, and how long it has been owed. */
  async receivables(auth: AuthContext, propertyId: string) {
    const property = await this.properties.assertProperty(auth, propertyId);
    const folios = await this.prisma.folio.findMany({
      where: { tenantId: auth.tenantId, propertyId },
      include: {
        guest: { select: { firstName: true, lastName: true, phone: true } },
        reservation: { select: { confirmationCode: true, departureDate: true, status: true } },
      },
    });

    const rows = [];
    for (const f of folios) {
      const agg = await this.prisma.folioEntry.aggregate({
        where: { folioId: f.id },
        _sum: { amountMinor: true },
      });
      const balance = Number(agg._sum.amountMinor ?? 0n);
      if (balance <= 0) continue;

      const since = f.reservation?.departureDate ?? property.businessDate;
      const ageDays = Math.max(
        0,
        Math.round((Date.parse(property.businessDate) - Date.parse(since)) / 86_400_000)
      );
      rows.push({
        folioId: f.id,
        label: f.label,
        status: f.status,
        guest: `${f.guest.firstName} ${f.guest.lastName}`,
        phone: f.guest.phone,
        confirmationCode: f.reservation?.confirmationCode ?? null,
        departureDate: f.reservation?.departureDate ?? null,
        balanceMinor: balance,
        ageDays,
        // Standard ageing buckets; anything past 90 days is usually written off.
        bucket: ageDays <= 0 ? "CURRENT" : ageDays <= 30 ? "1-30" : ageDays <= 60 ? "31-60" : ageDays <= 90 ? "61-90" : "90+",
      });
    }
    rows.sort((a, b) => b.ageDays - a.ageDays);

    const buckets: Record<string, number> = {};
    for (const r of rows) buckets[r.bucket] = (buckets[r.bucket] ?? 0) + r.balanceMinor;

    return {
      businessDate: property.businessDate,
      rows,
      totalOutstandingMinor: rows.reduce((s, r) => s + r.balanceMinor, 0),
      byBucket: buckets,
      // An open folio is a guest still in house; a closed one owing money is a
      // debt that walked out of the building.
      closedButOwingCount: rows.filter((r) => r.status === "CLOSED").length,
    };
  }

  /** Owner dashboard: the numbers an absentee owner checks each morning. */
  async ownerDashboard(auth: AuthContext, propertyId: string) {
    const property = await this.properties.assertProperty(auth, propertyId);
    const today = property.businessDate;
    const monthStart = `${today.slice(0, 7)}-01`;

    const [mtd, receivables] = await Promise.all([
      this.occupancy(auth, propertyId, monthStart, today),
      this.receivables(auth, propertyId),
    ]);
    const rev = await this.revenue(auth, propertyId, monthStart, today);

    const pendingApprovals = await this.prisma.approvalRequest.count({
      where: { tenantId: auth.tenantId, propertyId, status: "PENDING" },
    });
    const unapprovedVariance = await this.prisma.cashierShift.count({
      where: { tenantId: auth.tenantId, propertyId, status: "PENDING_APPROVAL" },
    });
    const openExceptions = await this.prisma.reconciliationException.count({
      where: { tenantId: auth.tenantId, propertyId, status: "OPEN" },
    });

    return {
      businessDate: today,
      monthToDate: {
        occupancyPct: mtd.totals.occupancyPct,
        adrMinor: mtd.totals.adrMinor,
        revparMinor: mtd.totals.revparMinor,
        roomRevenueMinor: mtd.totals.roomRevenueMinor,
        totalBilledMinor: rev.totalBilledMinor,
        discountMinor: rev.discountMinor,
      },
      receivables: {
        totalOutstandingMinor: receivables.totalOutstandingMinor,
        over60Minor: (receivables.byBucket["61-90"] ?? 0) + (receivables.byBucket["90+"] ?? 0),
        closedButOwingCount: receivables.closedButOwingCount,
      },
      // Surfaced together because these are the things that quietly cost money
      // when nobody is watching.
      needsAttention: {
        pendingApprovals,
        unapprovedCashVariances: unapprovedVariance,
        openReconciliationExceptions: openExceptions,
      },
    };
  }

  // ── Asynchronous exports ────────────────────────────────────────────────

  /**
   * Queues an export. A year of guest ledger will not return inside an HTTP
   * request, so the job is recorded, run out of band, and the result stored as
   * a file the requester downloads through a signed URL.
   */
  async requestExport(auth: AuthContext, body: unknown) {
    const dto = exportSchema.parse(body);
    await this.properties.assertProperty(auth, dto.propertyId);
    this.assertRange(dto.from, dto.to);

    const job = await this.prisma.exportJob.create({
      data: {
        tenantId: auth.tenantId,
        propertyId: dto.propertyId,
        type: dto.type,
        format: dto.format,
        params: JSON.stringify({ from: dto.from, to: dto.to }),
        requestedById: auth.userId,
      },
    });
    // Run immediately in-process. The job row is what makes this replaceable
    // by a queue worker without changing the client contract.
    void this.runExport(auth, job.id).catch(() => undefined);
    return { jobId: job.id, status: job.status, type: job.type };
  }

  async runExport(auth: AuthContext, jobId: string) {
    const job = await this.prisma.exportJob.findFirst({
      where: { id: jobId, tenantId: auth.tenantId },
    });
    if (!job) return;
    if (job.status !== "QUEUED") return;

    await this.prisma.exportJob.update({
      where: { id: job.id },
      data: { status: "RUNNING", startedAt: new Date() },
    });

    try {
      const { from, to } = JSON.parse(job.params) as { from: string; to: string };
      const rows = await this.rowsFor(auth, job.type, job.propertyId, from, to);
      const isPdf = job.format === "PDF";

      let bytes: Buffer;
      if (isPdf) {
        const property = await this.prisma.property.findUniqueOrThrow({
          where: { id: job.propertyId },
          select: { name: true, code: true },
        });
        // Columns come from the first row, so a CSV and a PDF of the same
        // report always carry the same fields — one file cannot quietly hold
        // less than the other.
        const columns = rows.length ? Object.keys(rows[0]) : ["result"];
        bytes = renderTablePdf({
          title: `${EXPORT_TITLES[job.type] ?? job.type} — ${property.name}`,
          meta: [
            `Property: ${property.code}`,
            `Range: ${from} to ${to}`,
            `Generated: ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`,
            `Rows: ${rows.length}`,
          ],
          columns,
          rows: rows.map((r) => columns.map((c) => r[c] as string)),
          notes: EXPORT_NOTES[job.type] ? [EXPORT_NOTES[job.type]] : undefined,
        });
      } else {
        bytes = Buffer.from(toCsv(rows as unknown as Record<string, unknown>[]), "utf8");
      }

      const file = await this.files.storeGenerated(auth, {
        propertyId: job.propertyId,
        purpose: "EXPORT",
        contentType: isPdf ? "application/pdf" : "text/csv",
        originalName: `${job.type.toLowerCase()}-${from}_to_${to}.${isPdf ? "pdf" : "csv"}`,
        bytes,
        entityType: "export_job",
        entityId: job.id,
      });

      await this.prisma.exportJob.update({
        where: { id: job.id },
        data: {
          status: "COMPLETE",
          fileId: file.id,
          rowCount: rows.length,
          completedAt: new Date(),
        },
      });
    } catch (err) {
      await this.prisma.exportJob.update({
        where: { id: job.id },
        data: {
          status: "FAILED",
          error: err instanceof Error ? err.message : "Export failed.",
          completedAt: new Date(),
        },
      });
    }
  }

  private async rowsFor(
    auth: AuthContext,
    type: string,
    propertyId: string,
    from: string,
    to: string
  ): Promise<Record<string, unknown>[]> {
    switch (type) {
      case "OCCUPANCY": {
        const r = await this.occupancy(auth, propertyId, from, to);
        return r.days.map((d) => ({
          date: d.date,
          available: d.available,
          sold: d.sold,
          occupancyPct: d.occupancyPct,
          roomRevenueNaira: (d.roomRevenueMinor / 100).toFixed(2),
          adrNaira: (d.adrMinor / 100).toFixed(2),
          revparNaira: (d.revparMinor / 100).toFixed(2),
        }));
      }
      case "REVENUE": {
        const r = await this.revenue(auth, propertyId, from, to);
        return r.byCategory.map((c) => ({
          category: c.category,
          amountNaira: (c.amountMinor / 100).toFixed(2),
        }));
      }
      case "CASHIER": {
        const r = await this.cashier(auth, propertyId, from, to);
        return r.shifts.map((s) => ({
          shiftNumber: s.shiftNumber,
          status: s.status,
          openedAt: s.openedAt.toISOString(),
          expectedNaira: (s.expectedMinor / 100).toFixed(2),
          countedNaira: (s.countedMinor / 100).toFixed(2),
          varianceNaira: (s.varianceMinor / 100).toFixed(2),
          varianceReason: s.varianceReason ?? "",
          approved: s.approved,
        }));
      }
      case "RECEIVABLES": {
        const r = await this.receivables(auth, propertyId);
        return r.rows.map((row) => ({
          guest: row.guest,
          confirmationCode: row.confirmationCode ?? "",
          departureDate: row.departureDate ?? "",
          balanceNaira: (row.balanceMinor / 100).toFixed(2),
          ageDays: row.ageDays,
          bucket: row.bucket,
          folioStatus: row.status,
        }));
      }
      case "DAILY_FLASH": {
        // The flash is a snapshot of the current business date rather than a
        // range, so it is emitted as label/value pairs — pretending it spans
        // the requested range would put a date on it that it does not have.
        const r = await this.reports.dailyFlash(auth, propertyId);
        const rows: Record<string, unknown>[] = [
          { metric: "Business date", value: r.businessDate },
          { metric: "Rooms", value: r.totalRooms },
          { metric: "Occupied", value: r.occupied },
          { metric: "Occupancy %", value: r.occupancyPct },
          { metric: "Arrivals today", value: r.arrivalsToday },
          { metric: "Departures today", value: r.departuresToday },
          { metric: "Revenue today (NGN)", value: (r.revenueTodayMinor / 100).toFixed(2) },
          { metric: "Outstanding (NGN)", value: (r.outstandingMinor / 100).toFixed(2) },
        ];
        for (const p of r.paymentsByMethod) {
          rows.push({
            metric: `Payments — ${p.method} (${p.count})`,
            value: (p.totalMinor / 100).toFixed(2),
          });
        }
        return rows;
      }
      case "TAX": {
        const r = await this.reports.taxSummary(auth, propertyId, from, to);
        return r.map((t) => ({
          businessDate: t.businessDate,
          taxCode: t.taxCode,
          // The rule version is what makes a filing defensible months later:
          // it says which rate was in force when the line was posted.
          ruleVersion: t.ruleVersion ?? "",
          lines: t.lines,
          totalNaira: (Number(t.totalMinor) / 100).toFixed(2),
        }));
      }
      case "GUEST_LEDGER": {
        const r = await this.reports.guestLedger(auth, propertyId, from, to);
        return r.map((e) => ({
          businessDate: e.businessDate,
          confirmationCode: e.confirmationCode,
          guest: e.guest,
          type: e.type,
          description: e.description,
          taxCode: e.taxCode,
          amountNaira: e.amountNaira,
        }));
      }
      case "AUDIT": {
        const events = await this.prisma.auditEvent.findMany({
          where: {
            tenantId: auth.tenantId,
            propertyId,
            createdAt: {
              gte: new Date(`${from}T00:00:00.000Z`),
              lte: new Date(`${to}T23:59:59.999Z`),
            },
          },
          orderBy: { createdAt: "asc" },
          take: 20000,
        });
        return events.map((e) => ({
          at: e.createdAt.toISOString(),
          actorType: e.actorType,
          actorId: e.actorId ?? "",
          action: e.action,
          entityType: e.entityType,
          entityId: e.entityId,
          requestId: e.requestId ?? "",
          summary: e.summary ?? "",
        }));
      }
      default:
        // Reached only if a type is added to the schema enum without a builder.
        // Failing loudly beats delivering an empty CSV that reads like a quiet
        // trading period.
        throw new Error(`Export type ${type} is not implemented.`);
    }
  }

  async getJob(auth: AuthContext, jobId: string) {
    const job = await this.prisma.exportJob.findFirst({
      where: { id: jobId, tenantId: auth.tenantId },
    });
    if (!job) {
      throw new NotFoundException({
        error: { code: "JOB_NOT_FOUND", message: "Export job not found." },
      });
    }
    let download: { url: string; expiresAt: Date } | null = null;
    if (job.status === "COMPLETE" && job.fileId) {
      const link = await this.files.downloadUrl(auth, job.fileId);
      download = { url: link.url, expiresAt: link.expiresAt };
    }
    return {
      id: job.id,
      type: job.type,
      format: job.format,
      status: job.status,
      rowCount: job.rowCount,
      error: job.error,
      fileId: job.fileId,
      download,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    };
  }

  listJobs(auth: AuthContext, propertyId: string) {
    return this.prisma.exportJob.findMany({
      where: { tenantId: auth.tenantId, propertyId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        type: true,
        format: true,
        status: true,
        rowCount: true,
        createdAt: true,
        completedAt: true,
      },
    });
  }
}

@Controller("analytics")
export class AnalyticsController {
  constructor(private readonly service: AnalyticsService) {}

  @Get("occupancy")
  occupancy(
    @CurrentAuth() auth: AuthContext,
    @Query("propertyId") propertyId: string,
    @Query("from") from: string,
    @Query("to") to: string
  ) {
    return this.service.occupancy(auth, propertyId, from, to);
  }

  @Get("revenue")
  revenue(
    @CurrentAuth() auth: AuthContext,
    @Query("propertyId") propertyId: string,
    @Query("from") from: string,
    @Query("to") to: string
  ) {
    return this.service.revenue(auth, propertyId, from, to);
  }

  @Get("cashier")
  cashier(
    @CurrentAuth() auth: AuthContext,
    @Query("propertyId") propertyId: string,
    @Query("from") from: string,
    @Query("to") to: string
  ) {
    return this.service.cashier(auth, propertyId, from, to);
  }

  @Get("receivables")
  receivables(@CurrentAuth() auth: AuthContext, @Query("propertyId") propertyId: string) {
    return this.service.receivables(auth, propertyId);
  }

  @Get("owner-dashboard")
  ownerDashboard(@CurrentAuth() auth: AuthContext, @Query("propertyId") propertyId: string) {
    return this.service.ownerDashboard(auth, propertyId);
  }

  @Post("exports")
  requestExport(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.requestExport(auth, body);
  }

  @Get("exports")
  listJobs(@CurrentAuth() auth: AuthContext, @Query("propertyId") propertyId: string) {
    return this.service.listJobs(auth, propertyId);
  }

  @Get("exports/:id")
  getJob(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.getJob(auth, id);
  }
}

@Module({
  imports: [PropertiesModule, FilesModule, ReportsModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
