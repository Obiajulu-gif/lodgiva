import {
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
import { PropertiesModule, PropertiesService } from "./properties.module";

const createSchema = z
  .object({
    propertyId: z.string().min(1),
    roomId: z.string().optional(),
    title: z.string().min(3),
    description: z.string().optional(),
    priority: z.enum(["URGENT", "HIGH", "NORMAL", "LOW"]).default("NORMAL"),
    // Blocking a room takes it out of sellable inventory (§7.2).
    blocksRoom: z.boolean().default(false),
    assignedTo: z.string().optional(),
  })
  .strict();

const statusSchema = z
  .object({ status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]) })
  .strict();

@Injectable()
export class MaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly properties: PropertiesService
  ) {}

  async list(auth: AuthContext, propertyId: string) {
    await this.properties.assertProperty(auth, propertyId);
    return this.prisma.maintenanceTicket.findMany({
      where: { tenantId: auth.tenantId, propertyId },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 100,
      include: { room: { select: { roomNumber: true, operationalStatus: true } } },
    });
  }

  async create(auth: AuthContext, body: unknown) {
    const dto = createSchema.parse(body);
    await this.properties.assertProperty(auth, dto.propertyId);

    return this.prisma.$transaction(async (tx) => {
      const ticket = await tx.maintenanceTicket.create({
        data: { tenantId: auth.tenantId, reportedById: auth.userId, ...dto },
      });
      // An out-of-order room is not sellable; the rack reflects it immediately.
      if (dto.blocksRoom && dto.roomId) {
        const room = await tx.room.findFirst({
          where: { id: dto.roomId, tenantId: auth.tenantId },
        });
        if (!room) {
          throw new NotFoundException({
            error: { code: "ROOM_NOT_FOUND", message: "Room not found." },
          });
        }
        await tx.room.update({
          where: { id: room.id },
          data: { operationalStatus: "OUT_OF_ORDER" },
        });
      }
      await this.audit.log(tx, auth, {
        action: "maintenance.ticket_created",
        entityType: "maintenance_ticket",
        entityId: ticket.id,
        propertyId: dto.propertyId,
        summary: { title: dto.title, priority: dto.priority, blocksRoom: dto.blocksRoom },
      });
      await this.audit.emit(tx, auth.tenantId, {
        aggregateType: "maintenance_ticket",
        aggregateId: ticket.id,
        eventType: "maintenance.ticket_created",
        payload: { title: dto.title, priority: dto.priority },
      });
      return ticket;
    });
  }

  async setStatus(auth: AuthContext, id: string, body: unknown) {
    const dto = statusSchema.parse(body);
    const ticket = await this.prisma.maintenanceTicket.findFirst({
      where: { id, tenantId: auth.tenantId },
    });
    if (!ticket) {
      throw new NotFoundException({
        error: { code: "TICKET_NOT_FOUND", message: "Ticket not found." },
      });
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.maintenanceTicket.update({
        where: { id: ticket.id },
        data: {
          status: dto.status,
          resolvedAt: ["RESOLVED", "CLOSED"].includes(dto.status) ? new Date() : null,
        },
      });
      // Releasing the block returns the room to the cleaning flow, not
      // straight to sellable — it still needs housekeeping.
      if (
        ticket.blocksRoom &&
        ticket.roomId &&
        ["RESOLVED", "CLOSED"].includes(dto.status)
      ) {
        await tx.room.update({
          where: { id: ticket.roomId },
          data: { operationalStatus: "VACANT_DIRTY" },
        });
        const property = await tx.property.findUniqueOrThrow({
          where: { id: ticket.propertyId },
        });
        await tx.housekeepingTask.create({
          data: {
            tenantId: auth.tenantId,
            propertyId: ticket.propertyId,
            roomId: ticket.roomId,
            businessDate: property.businessDate,
            type: "FULL_CLEAN",
            priority: "HIGH",
            notes: `Post-maintenance clean — ${ticket.title}`,
          },
        });
      }
      await this.audit.log(tx, auth, {
        action: "maintenance.ticket_status_changed",
        entityType: "maintenance_ticket",
        entityId: ticket.id,
        propertyId: ticket.propertyId,
        summary: { from: ticket.status, to: dto.status },
      });
      return updated;
    });
  }
}

@Controller("maintenance/tickets")
export class MaintenanceController {
  constructor(private readonly service: MaintenanceService) {}

  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query("propertyId") propertyId: string) {
    return this.service.list(auth, propertyId);
  }

  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.create(auth, body);
  }

  @Post(":id/status")
  setStatus(@CurrentAuth() auth: AuthContext, @Param("id") id: string, @Body() body: unknown) {
    return this.service.setStatus(auth, id, body);
  }
}

@Module({
  imports: [PropertiesModule],
  controllers: [MaintenanceController],
  providers: [MaintenanceService],
})
export class MaintenanceModule {}
