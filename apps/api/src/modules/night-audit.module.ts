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

const runSchema = z.object({ propertyId: z.string().min(1) }).strict();

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

  async run(auth: AuthContext, body: unknown) {
    const dto = runSchema.parse(body);
    const property = await this.properties.assertProperty(auth, dto.propertyId);
    const businessDate = property.businessDate;

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

      // 2. KPI snapshot.
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

      // 3. Advance the business date — the ONLY place this happens (ADR-009).
      const nextDate = addDaysIso(businessDate, 1);
      await tx.property.update({
        where: { id: property.id },
        data: { businessDate: nextDate },
      });
      await tx.nightAuditRun.updateMany({
        where: { propertyId: property.id, businessDate },
        data: { summary: JSON.stringify(summary) },
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
      return { ...summary, newBusinessDate: nextDate };
    });
  }

  async history(auth: AuthContext, propertyId: string) {
    await this.properties.assertProperty(auth, propertyId);
    const runs = await this.prisma.nightAuditRun.findMany({
      where: { tenantId: auth.tenantId, propertyId },
      orderBy: { businessDate: "desc" },
      take: 30,
    });
    return runs.map((r) => ({ ...r, summary: JSON.parse(r.summary) }));
  }
}

@Controller("night-audit")
export class NightAuditController {
  constructor(private readonly service: NightAuditService) {}

  @Post("run")
  run(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.run(auth, body);
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
