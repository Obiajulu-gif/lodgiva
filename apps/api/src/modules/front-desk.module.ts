import {
  Controller,
  Get,
  Injectable,
  Module,
  Query,
} from "@nestjs/common";
import { PrismaService } from "../prisma.service";
import { AuthContext, CurrentAuth } from "../common/auth";
import { FoliosModule, FoliosService } from "./folios.module";
import { PropertiesModule, PropertiesService } from "./properties.module";

/**
 * §7 Front Office worklists.
 *
 * These are the three questions a front desk asks all day — who is coming,
 * who is leaving, who is here — answered against the property's business
 * date rather than the wall clock, so a shift working past midnight still
 * sees today's list.
 */
@Injectable()
export class FrontDeskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly properties: PropertiesService,
    private readonly folios: FoliosService
  ) {}

  private guestName(g: { firstName: string; lastName: string }) {
    return `${g.firstName} ${g.lastName}`;
  }

  async arrivals(auth: AuthContext, propertyId: string, date?: string) {
    const property = await this.properties.assertProperty(auth, propertyId);
    const on = date ?? property.businessDate;

    const rows = await this.prisma.reservation.findMany({
      where: {
        tenantId: auth.tenantId,
        propertyId,
        arrivalDate: on,
        status: { in: ["CONFIRMED", "PENDING_PAYMENT"] },
      },
      orderBy: { confirmationCode: "asc" },
      include: {
        guest: true,
        rooms: { include: { room: true } },
        folios: { where: { status: "OPEN" } },
      },
    });

    // ReservationRoom stores roomTypeId without a relation, so names are
    // resolved in one lookup rather than a query per row.
    const typeNames = new Map(
      (
        await this.prisma.roomType.findMany({
          where: { tenantId: auth.tenantId, propertyId },
          select: { id: true, name: true },
        })
      ).map((t) => [t.id, t.name])
    );

    return Promise.all(
      rows.map(async (r) => {
        const folio = r.folios[0];
        const balanceMinor = folio ? Number(await this.folios.balanceMinor(folio.id)) : 0;
        const room = r.rooms[0];
        const assigned = room?.room ?? null;
        // A room that is not yet clean is the single most common reason an
        // arrival stalls, so it is surfaced before the guest reaches the desk.
        const roomReady =
          assigned !== null &&
          ["VACANT_CLEAN", "INSPECTED"].includes(assigned.operationalStatus);
        return {
          reservationId: r.id,
          confirmationCode: r.confirmationCode,
          guest: this.guestName(r.guest),
          vip: r.guest.vip,
          blacklisted: r.guest.blacklisted,
          nights: r.rooms[0]
            ? Math.round(
                (Date.parse(r.departureDate) - Date.parse(r.arrivalDate)) / 86_400_000
              )
            : 0,
          departureDate: r.departureDate,
          roomType: room ? (typeNames.get(room.roomTypeId) ?? null) : null,
          roomNumber: assigned?.roomNumber ?? null,
          roomStatus: assigned?.operationalStatus ?? null,
          roomReady,
          adults: r.adults,
          children: r.children,
          balanceMinor,
          folioId: folio?.id ?? null,
          status: r.status,
          readyToCheckIn: roomReady && r.status === "CONFIRMED",
          blockers: [
            !assigned ? "No room assigned" : null,
            assigned && !roomReady ? `Room ${assigned.roomNumber} is ${assigned.operationalStatus.replace(/_/g, " ").toLowerCase()}` : null,
            r.status === "PENDING_PAYMENT" ? "Payment outstanding" : null,
            r.guest.blacklisted ? "Guest is flagged" : null,
          ].filter(Boolean),
        };
      })
    );
  }

  async departures(auth: AuthContext, propertyId: string, date?: string) {
    const property = await this.properties.assertProperty(auth, propertyId);
    const on = date ?? property.businessDate;

    const rows = await this.prisma.reservation.findMany({
      where: {
        tenantId: auth.tenantId,
        propertyId,
        departureDate: on,
        status: "CHECKED_IN",
      },
      include: {
        guest: true,
        rooms: { include: { room: true } },
        folios: { where: { status: "OPEN" } },
      },
    });

    return Promise.all(
      rows.map(async (r) => {
        let outstandingMinor = 0;
        const folioSummaries = [];
        for (const f of r.folios) {
          const bal = Number(await this.folios.balanceMinor(f.id));
          outstandingMinor += bal;
          folioSummaries.push({ folioId: f.id, label: f.label, balanceMinor: bal });
        }
        return {
          reservationId: r.id,
          confirmationCode: r.confirmationCode,
          guest: this.guestName(r.guest),
          vip: r.guest.vip,
          roomNumber: r.rooms[0]?.room?.roomNumber ?? null,
          folios: folioSummaries,
          outstandingMinor,
          // Checkout is blocked while money is owed, so the list says so up
          // front rather than failing at the counter.
          readyToCheckOut: outstandingMinor <= 0,
        };
      })
    );
  }

  async inHouse(auth: AuthContext, propertyId: string) {
    await this.properties.assertProperty(auth, propertyId);
    const rows = await this.prisma.reservation.findMany({
      where: { tenantId: auth.tenantId, propertyId, status: "CHECKED_IN" },
      include: {
        guest: true,
        rooms: { include: { room: true } },
        folios: { where: { status: "OPEN" } },
      },
    });
    return Promise.all(
      rows.map(async (r) => {
        let balanceMinor = 0;
        for (const f of r.folios) balanceMinor += Number(await this.folios.balanceMinor(f.id));
        return {
          reservationId: r.id,
          confirmationCode: r.confirmationCode,
          guest: this.guestName(r.guest),
          vip: r.guest.vip,
          roomNumber: r.rooms[0]?.room?.roomNumber ?? null,
          arrivalDate: r.arrivalDate,
          departureDate: r.departureDate,
          balanceMinor,
          folioCount: r.folios.length,
        };
      })
    );
  }

  /** Everything the desk needs in one call, for the arrivals screen header. */
  async summary(auth: AuthContext, propertyId: string) {
    const property = await this.properties.assertProperty(auth, propertyId);
    const [arrivals, departures, inHouse] = await Promise.all([
      this.arrivals(auth, propertyId),
      this.departures(auth, propertyId),
      this.inHouse(auth, propertyId),
    ]);
    return {
      businessDate: property.businessDate,
      arrivals: {
        total: arrivals.length,
        ready: arrivals.filter((a) => a.readyToCheckIn).length,
        blocked: arrivals.filter((a) => !a.readyToCheckIn).length,
      },
      departures: {
        total: departures.length,
        ready: departures.filter((d) => d.readyToCheckOut).length,
        owing: departures.filter((d) => !d.readyToCheckOut).length,
        outstandingMinor: departures.reduce((s, d) => s + Math.max(0, d.outstandingMinor), 0),
      },
      inHouse: { total: inHouse.length },
    };
  }
}

@Controller("front-desk")
export class FrontDeskController {
  constructor(private readonly service: FrontDeskService) {}

  @Get("summary")
  summary(@CurrentAuth() auth: AuthContext, @Query("propertyId") propertyId: string) {
    return this.service.summary(auth, propertyId);
  }

  @Get("arrivals")
  arrivals(
    @CurrentAuth() auth: AuthContext,
    @Query("propertyId") propertyId: string,
    @Query("date") date?: string
  ) {
    return this.service.arrivals(auth, propertyId, date);
  }

  @Get("departures")
  departures(
    @CurrentAuth() auth: AuthContext,
    @Query("propertyId") propertyId: string,
    @Query("date") date?: string
  ) {
    return this.service.departures(auth, propertyId, date);
  }

  @Get("in-house")
  inHouse(@CurrentAuth() auth: AuthContext, @Query("propertyId") propertyId: string) {
    return this.service.inHouse(auth, propertyId);
  }
}

@Module({
  imports: [PropertiesModule, FoliosModule],
  controllers: [FrontDeskController],
  providers: [FrontDeskService],
})
export class FrontDeskModule {}
