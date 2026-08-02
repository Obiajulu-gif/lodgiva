import {
  Body,
  ConflictException,
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
import { AuditService } from "../common/audit.service";
import { addDaysIso } from "../common/money";
import { PropertiesModule, PropertiesService } from "./properties.module";
import { FoliosModule, FoliosService } from "./folios.module";

const runSchema = z
  .object({
    propertyId: z.string().min(1),
    /** Warnings must be seen and accepted; blockers can never be waived. */
    acknowledgeWarnings: z.boolean().default(false),
  })
  .strict();

/**
 * §7.4 — night audit: validates the day, posts room charges for every
 * in-house night, snapshots KPIs, closes the business date and advances it.
 * Idempotent per (property, businessDate) via a unique constraint.
 */
@Injectable()
export class NightAuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly properties: PropertiesService,
    private readonly folios: FoliosService
  ) {}

  /**
   * §7.4 pre-flight.
   *
   * The day cannot be closed while the property is still mid-transaction.
   * Each blocker names the thing to fix, because a night auditor at 2am needs
   * to act on this list, not interpret it.
   *
   * Blockers stop the run; warnings are recorded and allowed through.
   */
  async preflight(auth: AuthContext, propertyId: string) {
    const property = await this.properties.assertProperty(auth, propertyId);
    const businessDate = property.businessDate;

    const openShifts = await this.prisma.cashierShift.findMany({
      where: { tenantId: auth.tenantId, propertyId, status: "OPEN" },
      select: { id: true, shiftNumber: true, userId: true },
    });
    const pendingShifts = await this.prisma.cashierShift.count({
      where: { tenantId: auth.tenantId, propertyId, status: "PENDING_APPROVAL" },
    });
    const openPosOrders = await this.prisma.posOrder.count({
      where: { tenantId: auth.tenantId, propertyId, status: "OPEN" },
    });
    const pendingVoids = await this.prisma.posOrder.count({
      where: { tenantId: auth.tenantId, propertyId, status: "VOID_PENDING" },
    });
    const dueOut = await this.prisma.reservation.count({
      where: {
        tenantId: auth.tenantId,
        propertyId,
        status: "CHECKED_IN",
        departureDate: { lte: businessDate },
      },
    });
    const unarrived = await this.prisma.reservation.count({
      where: {
        tenantId: auth.tenantId,
        propertyId,
        status: "CONFIRMED",
        arrivalDate: { lte: businessDate },
      },
    });
    const alreadyRun = await this.prisma.nightAuditRun.findFirst({
      where: { propertyId, businessDate },
      select: { id: true, status: true },
    });

    const blockers: { code: string; message: string; count?: number }[] = [];
    const warnings: { code: string; message: string; count?: number }[] = [];

    if (alreadyRun && alreadyRun.status === "COMPLETED") {
      blockers.push({
        code: "ALREADY_RUN",
        message: `Night audit for ${businessDate} has already completed.`,
      });
    }
    // An open drawer means cash is unaccounted for: closing the day over it
    // would bake an unbalanced float into the day's numbers.
    if (openShifts.length > 0) {
      blockers.push({
        code: "OPEN_CASHIER_SHIFTS",
        message: `Close ${openShifts.length} open cashier shift(s) first: ${openShifts
          .map((s) => s.shiftNumber)
          .join(", ")}.`,
        count: openShifts.length,
      });
    }
    if (openPosOrders > 0) {
      blockers.push({
        code: "OPEN_POS_ORDERS",
        message: `${openPosOrders} POS order(s) are still open and would not be billed tonight.`,
        count: openPosOrders,
      });
    }
    // A void nobody decided on is revenue in limbo: the order is neither
    // billed nor written off, and rolling the date makes it yesterday's
    // problem, which is how it stops being anyone's problem.
    if (pendingVoids > 0) {
      blockers.push({
        code: "POS_VOIDS_AWAITING_APPROVAL",
        message: `${pendingVoids} POS void(s) await supervisor approval. Decide them before closing the day.`,
        count: pendingVoids,
      });
    }
    if (pendingShifts > 0) {
      warnings.push({
        code: "SHIFTS_AWAITING_APPROVAL",
        message: `${pendingShifts} cash variance(s) still await manager approval.`,
        count: pendingShifts,
      });
    }
    if (dueOut > 0) {
      warnings.push({
        code: "DUE_OUT_STILL_IN_HOUSE",
        message: `${dueOut} guest(s) were due to depart but are still checked in.`,
        count: dueOut,
      });
    }
    if (unarrived > 0) {
      warnings.push({
        code: "UNARRIVED_BOOKINGS",
        message: `${unarrived} confirmed booking(s) did not arrive and may need marking as no-show.`,
        count: unarrived,
      });
    }

    return {
      businessDate,
      canRun: blockers.length === 0,
      blockers,
      warnings,
    };
  }

  async run(auth: AuthContext, body: unknown) {
    const dto = runSchema.parse(body);
    const property = await this.properties.assertProperty(auth, dto.propertyId);
    const businessDate = property.businessDate;

    // PHASE 1 — PREFLIGHT. Refuse rather than close a day that is not
    // actually finished. `force` skips warnings, never blockers.
    const checks = await this.preflight(auth, dto.propertyId);
    const steps: { phase: string; ok: boolean; detail?: string; at: string }[] = [];
    const mark = (phase: string, detail?: string) =>
      steps.push({ phase, ok: true, detail, at: new Date().toISOString() });

    if (!checks.canRun) {
      throw new ConflictException({
        error: {
          code: "NIGHT_AUDIT_BLOCKED",
          message: checks.blockers[0].message,
          retryable: false,
          details: { blockers: checks.blockers, warnings: checks.warnings },
        },
      });
    }
    if (checks.warnings.length > 0 && !dto.acknowledgeWarnings) {
      throw new ConflictException({
        error: {
          code: "NIGHT_AUDIT_WARNINGS",
          message: `${checks.warnings.length} item(s) need acknowledging before the day can close.`,
          retryable: false,
          details: { warnings: checks.warnings },
        },
      });
    }
    mark("PREFLIGHT", `${checks.warnings.length} warning(s) acknowledged`);

    return this.prisma.$transaction(async (tx) => {
      // Idempotency gate first (§7.4): a rerun for the same date must fail
      // cleanly and change nothing.
      try {
        await tx.nightAuditRun.create({
          data: {
            tenantId: auth.tenantId,
            propertyId: property.id,
            businessDate,
            summary: "{}",
          },
        });
      } catch (e: unknown) {
        if ((e as { code?: string }).code === "P2002") {
          throw new ConflictException({
            error: {
              code: "NIGHT_AUDIT_ALREADY_RUN",
              message: `Night audit for ${businessDate} has already completed.`,
            },
          });
        }
        throw e;
      }

      // 1. Post tonight's room charge for every in-house reservation room.
      const inHouse = await tx.reservationRoom.findMany({
        where: {
          tenantId: auth.tenantId,
          status: "IN_HOUSE",
          arrivalDate: { lte: businessDate },
          departureDate: { gt: businessDate },
          reservation: { propertyId: property.id, status: "CHECKED_IN" },
        },
        include: {
          room: { select: { roomNumber: true } },
          reservation: { include: { folios: { where: { status: "OPEN" } } } },
        },
      });
      let postedCount = 0;
      let roomRevenueMinor = 0n;
      for (const rr of inHouse) {
        const folioRow = rr.reservation.folios[0];
        if (!folioRow) continue;
        const description = `Room ${rr.room?.roomNumber ?? ""} night ${businessDate}`.trim();
        const already = await tx.folioEntry.findFirst({
          where: { folioId: folioRow.id, type: "ROOM_CHARGE", description },
        });
        if (already) continue;
        await this.folios.postChargeTx(tx, auth, folioRow, {
          type: "ROOM_CHARGE",
          description,
          amountMinor: rr.nightlyRateMinor,
          applyTaxes: true,
          businessDate,
        });
        postedCount++;
        roomRevenueMinor += rr.nightlyRateMinor;
      }

      mark("POSTING", `${postedCount} room charge(s) posted`);

      // PHASE 3 — SNAPSHOT.
      const totalRooms = await tx.room.count({
        where: { tenantId: auth.tenantId, propertyId: property.id },
      });
      const occupied = inHouse.length;
      const occupancyPct = totalRooms ? Math.round((occupied / totalRooms) * 100) : 0;
      const adrMinor = occupied ? Number(roomRevenueMinor) / occupied : 0;
      const revparMinor = totalRooms ? Number(roomRevenueMinor) / totalRooms : 0;
      const paymentsToday = await tx.payment.aggregate({
        where: {
          tenantId: auth.tenantId,
          propertyId: property.id,
          status: "CONFIRMED",
        },
        _sum: { amountMinor: true },
      });
      const summary = {
        businessDate,
        totalRooms,
        occupied,
        occupancyPct,
        roomChargesPosted: postedCount,
        roomRevenueMinor: Number(roomRevenueMinor),
        adrMinor: Math.round(adrMinor),
        revparMinor: Math.round(revparMinor),
        confirmedPaymentsToDateMinor: Number(paymentsToday._sum.amountMinor ?? 0n),
      };

      mark("SNAPSHOT");

      // PHASE 4 — ADVANCING. The only place the business date moves (ADR-009).
      const nextDate = addDaysIso(businessDate, 1);
      await tx.property.update({
        where: { id: property.id },
        data: { businessDate: nextDate },
      });
      mark("ADVANCING", `business date -> ${nextDate}`);
      mark("COMPLETED");
      await tx.nightAuditRun.updateMany({
        where: { propertyId: property.id, businessDate },
        data: {
          summary: JSON.stringify(summary),
          phase: "COMPLETED",
          status: "COMPLETED",
          steps: JSON.stringify(steps),
          blockers: JSON.stringify(checks.warnings),
          runById: auth.userId,
        },
      });
      await this.audit.log(tx, auth, {
        action: "night_audit.run",
        entityType: "property",
        entityId: property.id,
        propertyId: property.id,
        summary,
      });
      await this.audit.emit(tx, auth.tenantId, {
        aggregateType: "property",
        aggregateId: property.id,
        eventType: "night_audit.completed",
        payload: summary,
      });
      return { ...summary, newBusinessDate: nextDate, phases: steps, acknowledgedWarnings: checks.warnings };
    });
  }

  async history(auth: AuthContext, propertyId: string) {
    await this.properties.assertProperty(auth, propertyId);
    const runs = await this.prisma.nightAuditRun.findMany({
      where: { tenantId: auth.tenantId, propertyId },
      orderBy: { businessDate: "desc" },
      take: 30,
    });
    return runs.map((r) => ({
      ...r,
      summary: JSON.parse(r.summary),
      steps: JSON.parse(r.steps ?? "[]"),
      blockers: JSON.parse(r.blockers ?? "[]"),
    }));
  }
}

@Controller("night-audit")
export class NightAuditController {
  constructor(private readonly service: NightAuditService) {}

  @Post("run")
  run(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.run(auth, body);
  }

  @Get("preflight")
  preflight(@CurrentAuth() auth: AuthContext, @Query("propertyId") propertyId: string) {
    return this.service.preflight(auth, propertyId);
  }

  @Get("history")
  history(@CurrentAuth() auth: AuthContext, @Query("propertyId") propertyId: string) {
    return this.service.history(auth, propertyId);
  }
}

@Module({
  imports: [PropertiesModule, FoliosModule],
  controllers: [NightAuditController],
  providers: [NightAuditService],
})
export class NightAuditModule {}
