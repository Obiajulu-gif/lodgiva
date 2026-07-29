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

const FLOW = ["PENDING", "IN_PROGRESS", "COMPLETED", "INSPECTED"] as const;

const createTaskSchema = z
  .object({
    propertyId: z.string().min(1),
    roomId: z.string().min(1),
    type: z.enum(["FULL_CLEAN", "TURNOVER", "INSPECTION", "DEEP_CLEAN", "MAINTENANCE"]),
    priority: z.enum(["HIGH", "NORMAL", "LOW"]).default("NORMAL"),
    assignedTo: z.string().optional(),
    notes: z.string().optional(),
  })
  .strict();

@Injectable()
export class HousekeepingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
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
    return this.prisma.housekeepingTask.create({
      data: {
        tenantId: auth.tenantId,
        businessDate: property.businessDate,
        ...dto,
      },
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
      if (next === "COMPLETED") {
        await this.audit.emit(tx, auth.tenantId, {
          aggregateType: "housekeeping_task",
          aggregateId: task.id,
          eventType: "housekeeping.task_completed",
          payload: { room: task.room.roomNumber, type: task.type },
        });
      }
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

  @Post(":id/advance")
  advance(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.advance(auth, id);
  }
}

@Module({
  controllers: [HousekeepingController],
  providers: [HousekeepingService],
})
export class HousekeepingModule {}
