import {
  Controller,
  Get,
  Injectable,
  Module,
  Query,
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
}

@Module({
  imports: [PropertiesModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
