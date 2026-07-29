import {
  BadRequestException,
  Controller,
  Get,
  Injectable,
  Module,
  Query,
  Res,
} from "@nestjs/common";
import { PrismaService } from "../prisma.service";
import { AuthContext, CurrentAuth } from "../common/auth";
import { PropertiesModule, PropertiesService } from "./properties.module";

/** §14.1 — daily flash report + audit trail reads. */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly properties: PropertiesService
  ) {}

  async dailyFlash(auth: AuthContext, propertyId: string) {
    const property = await this.properties.assertProperty(auth, propertyId);
    const businessDate = property.businessDate;

    const totalRooms = await this.prisma.room.count({
      where: { tenantId: auth.tenantId, propertyId },
    });
    const inHouse = await this.prisma.reservationRoom.count({
      where: {
        tenantId: auth.tenantId,
        status: "IN_HOUSE",
        reservation: { propertyId, status: "CHECKED_IN" },
      },
    });
    const arrivals = await this.prisma.reservation.count({
      where: { tenantId: auth.tenantId, propertyId, arrivalDate: businessDate, status: "CONFIRMED" },
    });
    const departures = await this.prisma.reservation.count({
      where: { tenantId: auth.tenantId, propertyId, departureDate: businessDate, status: "CHECKED_IN" },
    });
    const revenue = await this.prisma.folioEntry.aggregate({
      where: {
        tenantId: auth.tenantId,
        businessDate,
        amountMinor: { gt: 0 },
        folio: { propertyId },
      },
      _sum: { amountMinor: true },
    });
    const paymentsByMethod = await this.prisma.payment.groupBy({
      by: ["method"],
      where: { tenantId: auth.tenantId, propertyId, status: "CONFIRMED" },
      _sum: { amountMinor: true },
      _count: true,
    });
    // Outstanding = sum of balances on open folios.
    const openFolios = await this.prisma.folio.findMany({
      where: { tenantId: auth.tenantId, propertyId, status: "OPEN" },
      select: { id: true },
    });
    let outstandingMinor = 0n;
    for (const f of openFolios) {
      const agg = await this.prisma.folioEntry.aggregate({
        where: { folioId: f.id },
        _sum: { amountMinor: true },
      });
      const bal = agg._sum.amountMinor ?? 0n;
      if (bal > 0n) outstandingMinor += bal;
    }

    return {
      businessDate,
      totalRooms,
      occupied: inHouse,
      occupancyPct: totalRooms ? Math.round((inHouse / totalRooms) * 100) : 0,
      arrivalsToday: arrivals,
      departuresToday: departures,
      revenueTodayMinor: Number(revenue._sum.amountMinor ?? 0n),
      outstandingMinor: Number(outstandingMinor),
      paymentsByMethod: paymentsByMethod.map((p) => ({
        method: p.method,
        count: p._count,
        totalMinor: Number(p._sum.amountMinor ?? 0n),
      })),
    };
  }

  auditTrail(auth: AuthContext, propertyId?: string) {
    return this.prisma.auditEvent.findMany({
      where: { tenantId: auth.tenantId, ...(propertyId ? { propertyId } : {}) },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  /** §13.3 — tax summary by business date and tax code. */
  async taxSummary(auth: AuthContext, propertyId: string, from: string, to: string) {
    await this.properties.assertProperty(auth, propertyId);
    const entries = await this.prisma.folioEntry.findMany({
      where: {
        tenantId: auth.tenantId,
        folio: { propertyId },
        businessDate: { gte: from, lte: to },
        type: { in: ["TAX", "SERVICE_CHARGE"] },
      },
      select: {
        businessDate: true,
        taxCode: true,
        taxRuleVersion: true,
        amountMinor: true,
      },
    });
    const grouped = new Map<string, { businessDate: string; taxCode: string; ruleVersion: number | null; totalMinor: bigint; lines: number }>();
    for (const e of entries) {
      const key = `${e.businessDate}|${e.taxCode}|${e.taxRuleVersion}`;
      const row = grouped.get(key) ?? {
        businessDate: e.businessDate,
        taxCode: e.taxCode ?? "—",
        ruleVersion: e.taxRuleVersion,
        totalMinor: 0n,
        lines: 0,
      };
      row.totalMinor += e.amountMinor;
      row.lines += 1;
      grouped.set(key, row);
    }
    return [...grouped.values()].sort(
      (a, b) => a.businessDate.localeCompare(b.businessDate) || a.taxCode.localeCompare(b.taxCode)
    );
  }

  /** Guest ledger: every posted line for a date range, for finance export. */
  async guestLedger(auth: AuthContext, propertyId: string, from: string, to: string) {
    await this.properties.assertProperty(auth, propertyId);
    const entries = await this.prisma.folioEntry.findMany({
      where: {
        tenantId: auth.tenantId,
        folio: { propertyId },
        businessDate: { gte: from, lte: to },
      },
      orderBy: { postedAt: "asc" },
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
    return entries.map((e) => ({
      businessDate: e.businessDate,
      postedAt: e.postedAt.toISOString(),
      confirmationCode: e.folio.reservation?.confirmationCode ?? "",
      guest: `${e.folio.guest.firstName} ${e.folio.guest.lastName}`,
      folioId: e.folio.id,
      type: e.type,
      description: e.description,
      taxCode: e.taxCode ?? "",
      taxRuleVersion: e.taxRuleVersion ?? "",
      amountMinor: Number(e.amountMinor),
      amountNaira: (Number(e.amountMinor) / 100).toFixed(2),
    }));
  }
}

/** RFC 4180 quoting so descriptions containing commas or quotes stay intact. */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(",")),
  ].join("\r\n");
}

@Controller("reports")
export class ReportsController {
  constructor(private readonly service: ReportsService) {}

  @Get("daily-flash")
  dailyFlash(@CurrentAuth() auth: AuthContext, @Query("propertyId") propertyId: string) {
    return this.service.dailyFlash(auth, propertyId);
  }

  @Get("audit-trail")
  auditTrail(@CurrentAuth() auth: AuthContext, @Query("propertyId") propertyId?: string) {
    return this.service.auditTrail(auth, propertyId);
  }

  @Get("tax-summary")
  taxSummary(
    @CurrentAuth() auth: AuthContext,
    @Query("propertyId") propertyId: string,
    @Query("from") from: string,
    @Query("to") to: string
  ) {
    return this.service.taxSummary(auth, propertyId, from, to);
  }

  @Get("guest-ledger")
  guestLedger(
    @CurrentAuth() auth: AuthContext,
    @Query("propertyId") propertyId: string,
    @Query("from") from: string,
    @Query("to") to: string
  ) {
    return this.service.guestLedger(auth, propertyId, from, to);
  }

  /** §14.1 CSV exports. Streams directly rather than staging a file. */
  @Get("export")
  async exportCsv(
    @CurrentAuth() auth: AuthContext,
    @Query("propertyId") propertyId: string,
    @Query("type") type: string,
    @Query("from") from: string,
    @Query("to") to: string,
    @Res() reply: { header: (k: string, v: string) => void; send: (b: string) => void }
  ) {
    const rows =
      type === "tax-summary"
        ? (await this.service.taxSummary(auth, propertyId, from, to)).map((r) => ({
            businessDate: r.businessDate,
            taxCode: r.taxCode,
            ruleVersion: r.ruleVersion ?? "",
            lines: r.lines,
            totalMinor: Number(r.totalMinor),
            totalNaira: (Number(r.totalMinor) / 100).toFixed(2),
          }))
        : type === "guest-ledger"
          ? await this.service.guestLedger(auth, propertyId, from, to)
          : null;

    if (!rows) {
      throw new BadRequestException({
        error: {
          code: "UNKNOWN_EXPORT",
          message: 'Unknown export type. Use "tax-summary" or "guest-ledger".',
        },
      });
    }
    const filename = `lodgiva-${type}-${from}_to_${to}.csv`;
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);
    reply.send(toCsv(rows as unknown as Record<string, unknown>[]));
  }
}

@Module({
  imports: [PropertiesModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
