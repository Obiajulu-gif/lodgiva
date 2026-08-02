import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Query,
} from "@nestjs/common";
import { PrismaService } from "../prisma.service";
import { AuthContext, CurrentAuth } from "../common/auth";
import { AuditService } from "../common/audit.service";
import { roleHasPermission } from "../common/permissions";

/**
 * §15 Support tooling.
 *
 * A support call starts with whatever the caller can remember: a confirmation
 * code, the phone number they booked with, half an email address, an invoice
 * number off a receipt. One search covers all of them, because asking "which
 * kind of reference is that?" is asking the caller to do the system's job.
 *
 * Two rules shape everything here:
 *  - It is READ ONLY. Nothing in this module changes state. Support that can
 *    quietly alter a folio is an audit problem wearing a helpful face.
 *  - Results are redacted by default. Enough to confirm you have the right
 *    person, never enough to become a source of personal data in its own
 *    right, and every lookup is written to the audit trail.
 */
@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  private assertAllowed(auth: AuthContext) {
    if (!roleHasPermission(auth.role, "support.lookup")) {
      throw new ForbiddenException({
        error: {
          code: "PERMISSION_DENIED",
          message: `Your role (${auth.role}) cannot use support lookup.`,
          details: { requiredPermission: "support.lookup" },
        },
      });
    }
  }

  /** Keeps the last two characters so a caller can confirm, no more. */
  private maskEmail(email?: string | null) {
    if (!email) return null;
    const [user, domain] = email.split("@");
    if (!domain) return "***";
    const head = user.slice(0, 2);
    return `${head}${"*".repeat(Math.max(1, user.length - 2))}@${domain}`;
  }

  private maskPhone(phone?: string | null) {
    if (!phone) return null;
    return `${"*".repeat(Math.max(0, phone.length - 4))}${phone.slice(-4)}`;
  }

  async lookup(auth: AuthContext, q: string, propertyId?: string) {
    this.assertAllowed(auth);
    const query = (q ?? "").trim();
    if (query.length < 3) {
      throw new BadRequestException({
        error: {
          code: "QUERY_TOO_SHORT",
          message: "Enter at least 3 characters — a shorter search would return most of the database.",
        },
      });
    }

    const scope = { tenantId: auth.tenantId, ...(propertyId ? { propertyId } : {}) };
    const like = query.toLowerCase();

    const [reservations, guests, invoices] = await Promise.all([
      this.prisma.reservation.findMany({
        where: {
          ...scope,
          OR: [
            { confirmationCode: { contains: query } },
            { guest: { email: { contains: like } } },
            { guest: { phone: { contains: query } } },
            { guest: { lastName: { contains: like } } },
          ],
        },
        include: {
          guest: { select: { firstName: true, lastName: true, email: true, phone: true } },
          rooms: { select: { status: true, room: { select: { roomNumber: true } } } },
        },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      this.prisma.guest.findMany({
        where: {
          tenantId: auth.tenantId,
          // A merged guest is a tombstone; surfacing it sends support to a
          // record that no longer receives charges.
          mergedIntoId: null,
          OR: [
            { email: { contains: like } },
            { phone: { contains: query } },
            { lastName: { contains: like } },
          ],
        },
        take: 20,
        orderBy: { updatedAt: "desc" },
      }),
      this.prisma.invoice.findMany({
        where: { ...scope, invoiceNumber: { contains: query } },
        take: 10,
        orderBy: { issuedAt: "desc" },
      }),
    ]);

    // Every lookup is recorded. A support tool that reaches guest data without
    // leaving a trace is the tool an insider uses.
    await this.audit.log(this.prisma, auth, {
      action: "support.lookup",
      entityType: "support",
      entityId: "search",
      propertyId,
      summary: {
        // The query itself is kept: knowing WHAT was searched for is the point
        // of the record. It is staff-entered, not scraped from a guest.
        query,
        results: reservations.length + guests.length + invoices.length,
      },
    });

    return {
      query,
      reservations: reservations.map((r) => ({
        id: r.id,
        confirmationCode: r.confirmationCode,
        status: r.status,
        arrivalDate: r.arrivalDate,
        departureDate: r.departureDate,
        guest: `${r.guest.firstName} ${r.guest.lastName}`,
        email: this.maskEmail(r.guest.email),
        phone: this.maskPhone(r.guest.phone),
        rooms: r.rooms.map((x) => x.room?.roomNumber ?? "unassigned"),
      })),
      guests: guests.map((g) => ({
        id: g.id,
        name: `${g.firstName} ${g.lastName}`,
        email: this.maskEmail(g.email),
        phone: this.maskPhone(g.phone),
        vip: g.vip,
      })),
      invoices: invoices.map((i) => ({
        id: i.id,
        number: i.invoiceNumber,
        status: i.status,
        totalMinor: Number(i.totalMinor),
        issuedAt: i.issuedAt,
      })),
    };
  }

  /**
   * Everything about one reservation, in the order a support call needs it:
   * what was booked, what it cost, what has been paid, and what has happened
   * to it. Assembled server-side so support is not clicking through five
   * screens while a guest waits.
   */
  async reservationTimeline(auth: AuthContext, id: string) {
    this.assertAllowed(auth);
    const reservation = await this.prisma.reservation.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: {
        guest: true,
        rooms: { include: { room: true } },
        folios: { include: { entries: { orderBy: { postedAt: "asc" } } } },
      },
    });
    if (!reservation) {
      throw new NotFoundException({
        error: { code: "RESERVATION_NOT_FOUND", message: "No reservation with that id." },
      });
    }

    const events = await this.prisma.auditEvent.findMany({
      where: {
        tenantId: auth.tenantId,
        OR: [
          { entityId: id },
          { entityId: { in: reservation.folios.map((f) => f.id) } },
          { entityId: { in: reservation.rooms.map((r) => r.id) } },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: 200,
    });

    const balanceMinor = reservation.folios.reduce(
      (sum, f) => sum + f.entries.reduce((s, e) => s + Number(e.amountMinor), 0),
      0
    );

    await this.audit.log(this.prisma, auth, {
      action: "support.timeline_viewed",
      entityType: "reservation",
      entityId: id,
      propertyId: reservation.propertyId,
      summary: { confirmationCode: reservation.confirmationCode },
    });

    return {
      reservation: {
        id: reservation.id,
        confirmationCode: reservation.confirmationCode,
        status: reservation.status,
        arrivalDate: reservation.arrivalDate,
        departureDate: reservation.departureDate,
        source: reservation.source,
        guest: `${reservation.guest.firstName} ${reservation.guest.lastName}`,
        email: this.maskEmail(reservation.guest.email),
        phone: this.maskPhone(reservation.guest.phone),
      },
      rooms: reservation.rooms.map((r) => ({
        roomTypeId: r.roomTypeId,
        room: r.room?.roomNumber ?? null,
        status: r.status,
        nightlyRateMinor: Number(r.nightlyRateMinor),
      })),
      folios: reservation.folios.map((f) => ({
        id: f.id,
        label: f.label,
        status: f.status,
        balanceMinor: f.entries.reduce((s, e) => s + Number(e.amountMinor), 0),
        entries: f.entries.map((e) => ({
          postedAt: e.postedAt,
          businessDate: e.businessDate,
          type: e.type,
          description: e.description,
          amountMinor: Number(e.amountMinor),
          // A reversal is not a deleted line; showing the link is what lets
          // support explain a charge the guest says was removed.
          reversalOfId: e.reversalOfId,
        })),
      })),
      balanceMinor,
      timeline: events.map((e) => ({
        at: e.createdAt,
        action: e.action,
        actorType: e.actorType,
        actorId: e.actorId,
        summary: e.summary,
      })),
    };
  }

  /** What an engineer asks for first: is this tenant's data self-consistent. */
  async diagnostics(auth: AuthContext, propertyId: string) {
    this.assertAllowed(auth);

    const [orphanEntries, negativeStock, pendingVoids, staleHolds, openShifts, failedExports] =
      await Promise.all([
        // A charge dated after the property's own business date means either a
        // clock problem or a night audit that ran twice - both make a folio
        // total impossible to explain to a guest.
        this.prisma.property
          .findFirst({ where: { id: propertyId, tenantId: auth.tenantId } })
          .then((prop) =>
            prop
              ? this.prisma.folioEntry.count({
                  where: {
                    tenantId: auth.tenantId,
                    folio: { propertyId },
                    businessDate: { gt: prop.businessDate },
                  },
                })
              : 0
          ),
        this.prisma.stockMovement.count({
          where: { tenantId: auth.tenantId, propertyId, quantity: { lt: 0 }, type: "RECEIPT" },
        }),
        this.prisma.posOrder.count({
          where: { tenantId: auth.tenantId, propertyId, status: "VOID_PENDING" },
        }),
        this.prisma.hold.count({
          where: { tenantId: auth.tenantId, propertyId, status: "ACTIVE", expiresAt: { lt: new Date() } },
        }),
        this.prisma.cashierShift.count({
          where: { tenantId: auth.tenantId, propertyId, status: "OPEN" },
        }),
        this.prisma.exportJob.count({
          where: { tenantId: auth.tenantId, propertyId, status: "FAILED" },
        }),
      ]);

    const findings = [];
    if (orphanEntries > 0)
      findings.push({ code: "FUTURE_DATED_CHARGES", count: orphanEntries, severity: "CRITICAL" });
    if (negativeStock > 0)
      findings.push({ code: "NEGATIVE_RECEIPTS", count: negativeStock, severity: "WARNING" });
    if (pendingVoids > 0)
      findings.push({ code: "POS_VOIDS_AWAITING_APPROVAL", count: pendingVoids, severity: "WARNING" });
    if (staleHolds > 0)
      findings.push({ code: "EXPIRED_HOLDS_NOT_RECLAIMED", count: staleHolds, severity: "INFO" });
    if (failedExports > 0)
      findings.push({ code: "FAILED_EXPORTS", count: failedExports, severity: "INFO" });

    return {
      propertyId,
      checkedAt: new Date().toISOString(),
      openCashierShifts: openShifts,
      findings,
      // An empty findings list is a result, not an absence of one.
      healthy: findings.every((f) => f.severity === "INFO"),
    };
  }
}

@Controller("support")
export class SupportController {
  constructor(private readonly service: SupportService) {}

  @Get("lookup")
  lookup(
    @CurrentAuth() auth: AuthContext,
    @Query("q") q: string,
    @Query("propertyId") propertyId?: string
  ) {
    return this.service.lookup(auth, q, propertyId);
  }

  @Get("reservations/:id")
  timeline(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.reservationTimeline(auth, id);
  }

  @Get("diagnostics")
  diagnostics(@CurrentAuth() auth: AuthContext, @Query("propertyId") propertyId: string) {
    return this.service.diagnostics(auth, propertyId);
  }
}

@Module({
  controllers: [SupportController],
  providers: [SupportService],
})
export class SupportModule {}
