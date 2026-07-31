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
import { PushModule, PushService } from "./push.module";

const FLOW = ["PENDING", "IN_PROGRESS", "COMPLETED", "INSPECTED"] as const;

const createTaskSchema = z
  .object({
    propertyId: z.string().min(1),
    roomId: z.string().min(1),
    type: z.enum(["FULL_CLEAN", "TURNOVER", "INSPECTION", "DEEP_CLEAN", "MAINTENANCE"]),
    priority: z.enum(["HIGH", "NORMAL", "LOW"]).default("NORMAL"),
    assignedTo: z.string().optional(),
    assignedUserId: z.string().optional(),
    notes: z.string().optional(),
  })
  .strict();

const assignSchema = z
  .object({
    assignedUserId: z.string().min(1),
    assignedTo: z.string().max(80).optional(),
  })
  .strict();

@Injectable()
export class HousekeepingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly push: PushService
  ) {}

  list(auth: AuthContext, propertyId?: string) {
    return this.prisma.housekeepingTask.findMany({
      where: { tenantId: auth.tenantId, ...(propertyId ? { propertyId } : {}) },
      orderBy: [{ status: "asc" }, { priority: "asc" }, { createdAt: "desc" }],
      take: 100,
      include: { room: { select: { roomNumber: true, operationalStatus: true } } },
    });
  }

  async create(auth: AuthContext, body: unknown) {
    const dto = createTaskSchema.parse(body);
    const property = await this.prisma.property.findFirst({
      where: { id: dto.propertyId, tenantId: auth.tenantId },
    });
    if (!property) {
      throw new NotFoundException({
        error: { code: "PROPERTY_NOT_FOUND", message: "Property not found." },
      });
    }
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.housekeepingTask.create({
        data: {
          tenantId: auth.tenantId,
          businessDate: property.businessDate,
          ...dto,
        },
        include: { room: { select: { roomNumber: true } } },
      });
      if (dto.assignedUserId) {
        await this.push.queueAssignment(tx, auth.tenantId, {
          userId: dto.assignedUserId,
          taskId: task.id,
          roomNumber: task.room.roomNumber,
          taskType: task.type,
          priority: task.priority,
        });
      }
      return task;
    });
  }

  /**
   * Assigns a task to a member of staff and notifies them.
   *
   * The notification is queued in the same transaction as the assignment, so
   * nobody is ever told to clean a room for an assignment that rolled back.
   */
  async assign(auth: AuthContext, id: string, body: unknown) {
    const dto = assignSchema.parse(body);
    const task = await this.prisma.housekeepingTask.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { room: { select: { roomNumber: true } } },
    });
    if (!task) {
      throw new NotFoundException({
        error: { code: "TASK_NOT_FOUND", message: "Task not found." },
      });
    }
    if (["COMPLETED", "INSPECTED"].includes(task.status)) {
      throw new BadRequestException({
        error: {
          code: "TASK_FINISHED",
          message: "A finished task cannot be reassigned.",
        },
      });
    }
    // Assigning outside the tenant would leak a room number to a stranger.
    const member = await this.prisma.membership.findFirst({
      where: { tenantId: auth.tenantId, userId: dto.assignedUserId, status: "ACTIVE" },
      include: { user: { select: { fullName: true } } },
    });
    if (!member) {
      throw new NotFoundException({
        error: {
          code: "ASSIGNEE_NOT_FOUND",
          message: "That user is not an active member of this tenant.",
        },
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.housekeepingTask.update({
        where: { id: task.id },
        data: {
          assignedUserId: dto.assignedUserId,
          assignedTo: dto.assignedTo ?? member.user.fullName,
          version: { increment: 1 },
        },
      });
      await this.push.queueAssignment(tx, auth.tenantId, {
        userId: dto.assignedUserId,
        taskId: task.id,
        roomNumber: task.room.roomNumber,
        taskType: task.type,
        priority: task.priority,
      });
      await this.audit.log(tx, auth, {
        action: "housekeeping.task_assigned",
        entityType: "housekeeping_task",
        entityId: task.id,
        propertyId: task.propertyId,
        summary: { room: task.room.roomNumber, assignedTo: member.user.fullName },
      });
      return updated;
    });
  }

  /** Advance PENDING → IN_PROGRESS → COMPLETED → INSPECTED. */
  async advance(auth: AuthContext, id: string) {
    const task = await this.prisma.housekeepingTask.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { room: true },
    });
    if (!task) {
      throw new NotFoundException({
        error: { code: "TASK_NOT_FOUND", message: "Task not found." },
      });
    }
    const idx = FLOW.indexOf(task.status as (typeof FLOW)[number]);
    if (idx < 0 || idx >= FLOW.length - 1) {
      throw new BadRequestException({
        error: { code: "TASK_FINAL", message: "Task is already inspected." },
      });
    }
    const next = FLOW[idx + 1];
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.housekeepingTask.update({
        where: { id: task.id },
        data: {
          status: next,
          startedAt: next === "IN_PROGRESS" ? new Date() : task.startedAt,
          completedAt: next === "COMPLETED" ? new Date() : task.completedAt,
          // The version must move on EVERY write, not only on writes that
          // arrive through /sync/mutations. Without this an offline device's
          // baseVersion still looks current after someone advanced the task
          // here, and its queued change would overwrite their work instead of
          // being reported as a conflict.
          version: { increment: 1 },
        },
      });
      // Room condition follows the cleaning flow when the room is vacant.
      if (!task.room.operationalStatus.startsWith("OCCUPIED")) {
        if (next === "COMPLETED") {
          await tx.room.update({
            where: { id: task.roomId },
            data: { operationalStatus: "VACANT_CLEAN" },
          });
        } else if (next === "INSPECTED") {
          await tx.room.update({
            where: { id: task.roomId },
            data: { operationalStatus: "INSPECTED" },
          });
        }
      }
      await this.audit.log(tx, auth, {
        action: "housekeeping.task_advanced",
        entityType: "housekeeping_task",
        entityId: task.id,
        propertyId: task.propertyId,
        summary: { room: task.room.roomNumber, from: task.status, to: next },
      });
      // Emit on EVERY transition, not just completion: a supervisor watching
      // the board should see a room start being cleaned, not only finish.
      await this.audit.emit(tx, auth.tenantId, {
        aggregateType: "housekeeping_task",
        aggregateId: task.id,
        eventType:
          next === "COMPLETED"
            ? "housekeeping.task_completed"
            : "housekeeping.task_advanced",
        payload: { room: task.room.roomNumber, type: task.type, status: next },
      });
      return updated;
    });
  }
}

@Controller("housekeeping/tasks")
export class HousekeepingController {
  constructor(private readonly service: HousekeepingService) {}

  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query("propertyId") propertyId?: string) {
    return this.service.list(auth, propertyId);
  }

  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.create(auth, body);
  }

  @Post(":id/assign")
  assign(@CurrentAuth() auth: AuthContext, @Param("id") id: string, @Body() body: unknown) {
    return this.service.assign(auth, id, body);
  }

  @Post(":id/advance")
  advance(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.advance(auth, id);
  }
}

@Module({
  imports: [PushModule],
  controllers: [HousekeepingController],
  providers: [HousekeepingService],
})
export class HousekeepingModule {}
