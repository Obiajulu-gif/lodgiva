import {
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
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { AuthContext, CurrentAuth } from "../common/auth";
import { AuditService } from "../common/audit.service";
import { PropertiesModule, PropertiesService } from "./properties.module";

const openSchema = z
  .object({
    propertyId: z.string().min(1),
    openingFloatMinor: z.number().int().min(0).default(0),
  })
  .strict();

const movementSchema = z
  .object({
    type: z.enum(["PAYMENT_IN", "REFUND_OUT", "DROP_TO_SAFE", "PETTY_CASH_OUT", "FLOAT_IN"]),
    amountMinor: z.number().int().positive(),
    reference: z.string().optional(),
    note: z.string().optional(),
  })
  .strict();

const closeSchema = z
  .object({
    countedMinor: z.number().int().min(0),
    varianceReason: z.string().optional(),
  })
  .strict();

// Movements that reduce the drawer are stored as negative amounts.
const OUTFLOWS = ["REFUND_OUT", "DROP_TO_SAFE", "PETTY_CASH_OUT"];

/**
 * §7 Cashiering — open a shift, record cash movements, close with expected
 * vs counted reconciliation. A non-zero variance forces PENDING_APPROVAL and
 * requires a reason (§13.4 approval policy).
 */
@Injectable()
export class CashieringService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly properties: PropertiesService
  ) {}

  async open(auth: AuthContext, body: unknown) {
    const dto = openSchema.parse(body);
    const property = await this.properties.assertProperty(auth, dto.propertyId);

    const existing = await this.prisma.cashierShift.findFirst({
      where: {
        tenantId: auth.tenantId,
        propertyId: property.id,
        userId: auth.userId,
        status: "OPEN",
      },
    });
    if (existing) {
      throw new ConflictException({
        error: {
          code: "SHIFT_ALREADY_OPEN",
          message: `You already have an open shift (${existing.shiftNumber}). Close it before opening another.`,
        },
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const count = await tx.cashierShift.count({
        where: { tenantId: auth.tenantId, propertyId: property.id },
      });
      const shift = await tx.cashierShift.create({
        data: {
          tenantId: auth.tenantId,
          propertyId: property.id,
          shiftNumber: `S-${400 + count + 1}`,
          userId: auth.userId,
          openingFloatMinor: BigInt(dto.openingFloatMinor),
        },
      });
      if (dto.openingFloatMinor > 0) {
        await tx.cashMovement.create({
          data: {
            tenantId: auth.tenantId,
            shiftId: shift.id,
            type: "FLOAT_IN",
            amountMinor: BigInt(dto.openingFloatMinor),
            note: "Opening float",
            recordedById: auth.userId,
          },
        });
      }
      await this.audit.log(tx, auth, {
        action: "cashiering.shift_opened",
        entityType: "cashier_shift",
        entityId: shift.id,
        propertyId: property.id,
        summary: { shiftNumber: shift.shiftNumber, openingFloatMinor: dto.openingFloatMinor },
      });
      return shift;
    });
  }

  private async getOpenShift(auth: AuthContext, shiftId: string) {
    const shift = await this.prisma.cashierShift.findFirst({
      where: { id: shiftId, tenantId: auth.tenantId },
    });
    if (!shift) {
      throw new NotFoundException({
        error: { code: "SHIFT_NOT_FOUND", message: "Shift not found." },
      });
    }
    return shift;
  }

  async addMovement(auth: AuthContext, shiftId: string, body: unknown) {
    const dto = movementSchema.parse(body);
    const shift = await this.getOpenShift(auth, shiftId);
    if (shift.status !== "OPEN") {
      throw new ConflictException({
        error: { code: "SHIFT_CLOSED", message: "Cannot add movements to a closed shift." },
      });
    }
    const signed = OUTFLOWS.includes(dto.type)
      ? -BigInt(dto.amountMinor)
      : BigInt(dto.amountMinor);

    return this.prisma.$transaction(async (tx) => {
      const movement = await tx.cashMovement.create({
        data: {
          tenantId: auth.tenantId,
          shiftId: shift.id,
          type: dto.type,
          amountMinor: signed,
          reference: dto.reference,
          note: dto.note,
          recordedById: auth.userId,
        },
      });
      await this.audit.log(tx, auth, {
        action: "cashiering.movement_recorded",
        entityType: "cash_movement",
        entityId: movement.id,
        propertyId: shift.propertyId,
        summary: { shiftNumber: shift.shiftNumber, type: dto.type, amountMinor: Number(signed) },
      });
      return movement;
    });
  }

  async get(auth: AuthContext, shiftId: string) {
    const shift = await this.getOpenShift(auth, shiftId);
    const movements = await this.prisma.cashMovement.findMany({
      where: { shiftId: shift.id },
      orderBy: { createdAt: "asc" },
    });
    const expectedMinor = movements.reduce((s, m) => s + m.amountMinor, 0n);
    return { ...shift, movements, expectedMinor };
  }

  async list(auth: AuthContext, propertyId: string) {
    await this.properties.assertProperty(auth, propertyId);
    return this.prisma.cashierShift.findMany({
      where: { tenantId: auth.tenantId, propertyId },
      orderBy: { openedAt: "desc" },
      take: 30,
      include: { _count: { select: { movements: true } } },
    });
  }

  async close(auth: AuthContext, shiftId: string, body: unknown) {
    const dto = closeSchema.parse(body);
    const shift = await this.getOpenShift(auth, shiftId);
    if (shift.status === "CLOSED") {
      throw new ConflictException({
        error: { code: "SHIFT_ALREADY_CLOSED", message: "Shift is already closed." },
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const movements = await tx.cashMovement.findMany({ where: { shiftId: shift.id } });
      const expected = movements.reduce((s, m) => s + m.amountMinor, 0n);
      const counted = BigInt(dto.countedMinor);
      const variance = counted - expected;

      if (variance !== 0n && !dto.varianceReason) {
        throw new ConflictException({
          error: {
            code: "VARIANCE_REASON_REQUIRED",
            message: `Drawer is out by ₦${(Number(variance) / 100).toLocaleString()}. A reason is required to close with a variance.`,
            details: { expectedMinor: Number(expected), countedMinor: dto.countedMinor, varianceMinor: Number(variance) },
          },
        });
      }

      const closed = await tx.cashierShift.update({
        where: { id: shift.id },
        data: {
          // A variance never silently closes — it needs manager approval.
          status: variance === 0n ? "CLOSED" : "PENDING_APPROVAL",
          countedMinor: counted,
          expectedMinor: expected,
          varianceMinor: variance,
          varianceReason: dto.varianceReason,
          closedAt: new Date(),
        },
      });
      await this.audit.log(tx, auth, {
        action: "cashiering.shift_closed",
        entityType: "cashier_shift",
        entityId: shift.id,
        propertyId: shift.propertyId,
        summary: {
          shiftNumber: shift.shiftNumber,
          expectedMinor: Number(expected),
          countedMinor: dto.countedMinor,
          varianceMinor: Number(variance),
          reason: dto.varianceReason,
          status: closed.status,
        },
      });
      await this.audit.emit(tx, auth.tenantId, {
        aggregateType: "cashier_shift",
        aggregateId: shift.id,
        eventType: "cashiering.shift_closed",
        payload: { shiftNumber: shift.shiftNumber, varianceMinor: Number(variance), status: closed.status },
      });
      return { ...closed, expectedMinor: expected, varianceMinor: variance };
    });
  }

  /** Manager approval clears a variance shift to CLOSED (§13.4). */
  async approve(auth: AuthContext, shiftId: string) {
    const shift = await this.getOpenShift(auth, shiftId);
    if (shift.status !== "PENDING_APPROVAL") {
      throw new ConflictException({
        error: { code: "NOT_PENDING", message: "Shift is not awaiting approval." },
      });
    }
    if (!["TENANT_OWNER", "GENERAL_MANAGER", "FINANCE"].includes(auth.role)) {
      throw new ConflictException({
        error: { code: "FORBIDDEN_ROLE", message: "Only a manager, owner or finance user can approve a cash variance." },
      });
    }
    if (shift.userId === auth.userId) {
      throw new ConflictException({
        error: {
          code: "SELF_APPROVAL",
          message: "You cannot approve your own shift variance.",
        },
      });
    }
    return this.prisma.$transaction(async (tx) => {
      const approved = await tx.cashierShift.update({
        where: { id: shift.id },
        data: { status: "CLOSED", approvedById: auth.userId },
      });
      await this.audit.log(tx, auth, {
        action: "cashiering.variance_approved",
        entityType: "cashier_shift",
        entityId: shift.id,
        propertyId: shift.propertyId,
        summary: { shiftNumber: shift.shiftNumber, varianceMinor: Number(shift.varianceMinor ?? 0n) },
      });
      return approved;
    });
  }
}

@Controller("cashiering/shifts")
export class CashieringController {
  constructor(private readonly service: CashieringService) {}

  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query("propertyId") propertyId: string) {
    return this.service.list(auth, propertyId);
  }

  @Post()
  open(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.open(auth, body);
  }

  @Get(":id")
  get(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.get(auth, id);
  }

  @Post(":id/movements")
  movement(@CurrentAuth() auth: AuthContext, @Param("id") id: string, @Body() body: unknown) {
    return this.service.addMovement(auth, id, body);
  }

  @Post(":id/close")
  close(@CurrentAuth() auth: AuthContext, @Param("id") id: string, @Body() body: unknown) {
    return this.service.close(auth, id, body);
  }

  @Post(":id/approve")
  approve(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.approve(auth, id);
  }
}

@Module({
  imports: [PropertiesModule],
  controllers: [CashieringController],
  providers: [CashieringService],
})
export class CashieringModule {}
