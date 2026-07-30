import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
} from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { AuthContext, CurrentAuth } from "../common/auth";
import { AuditService } from "../common/audit.service";

// §7.2 — occupancy and housekeeping condition are distinct concepts; these are
// the allowed operational states for a physical room.
export const ROOM_STATES = [
  "VACANT_CLEAN",
  "VACANT_DIRTY",
  "OCCUPIED_CLEAN",
  "OCCUPIED_DIRTY",
  "INSPECTED",
  "OUT_OF_ORDER",
  "OUT_OF_SERVICE",
] as const;

const roomStatusSchema = z.object({
  status: z.enum(ROOM_STATES),
  reason: z.string().optional(),
});

@Injectable()
export class PropertiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  /**
   * The single chokepoint for property access (§6.2 rules 2 and 3). The
   * tenant always comes from the verified token, never the request, and a
   * property-scoped membership cannot reach a property outside its scope.
   *
   * Out-of-scope returns 404 rather than 403 so an attacker cannot use the
   * response to confirm that a property id exists.
   */
  async assertProperty(auth: AuthContext, propertyId: string) {
    const property = await this.prisma.property.findFirst({
      where: { id: propertyId, tenantId: auth.tenantId },
    });
    const notFound = new NotFoundException({
      error: { code: "PROPERTY_NOT_FOUND", message: "Property not found in your tenant." },
    });
    if (!property) throw notFound;
    if (!auth.allProperties && !auth.propertyIds.includes(property.id)) throw notFound;
    return property;
  }

  list(auth: AuthContext) {
    return this.prisma.property.findMany({
      where: {
        tenantId: auth.tenantId,
        ...(auth.allProperties ? {} : { id: { in: auth.propertyIds } }),
      },
      select: {
        id: true, name: true, code: true, slug: true, timezone: true,
        businessDate: true, checkinTime: true, checkoutTime: true, status: true,
      },
    });
  }

  async roomRack(auth: AuthContext, propertyId: string) {
    await this.assertProperty(auth, propertyId);
    const rooms = await this.prisma.room.findMany({
      where: { tenantId: auth.tenantId, propertyId },
      include: {
        roomType: { select: { code: true, name: true, baseRateMinor: true } },
        reservationRooms: {
          where: { status: "IN_HOUSE" },
          include: {
            reservation: {
              select: {
                id: true, confirmationCode: true, departureDate: true,
                guest: { select: { firstName: true, lastName: true } },
              },
            },
          },
        },
      },
      orderBy: { roomNumber: "asc" },
    });
    return rooms.map((r) => ({
      id: r.id,
      roomNumber: r.roomNumber,
      floor: r.floor,
      operationalStatus: r.operationalStatus,
      // The id is needed by clients that must match a room against a
      // reservation's room type (e.g. drag-and-drop on the calendar).
      roomTypeId: r.roomTypeId,
      roomType: r.roomType,
      occupant: r.reservationRooms[0]
        ? {
            reservationId: r.reservationRooms[0].reservation.id,
            confirmationCode: r.reservationRooms[0].reservation.confirmationCode,
            guest: `${r.reservationRooms[0].reservation.guest.firstName} ${r.reservationRooms[0].reservation.guest.lastName}`,
            departureDate: r.reservationRooms[0].reservation.departureDate,
          }
        : null,
    }));
  }

  async roomTypes(auth: AuthContext, propertyId: string) {
    await this.assertProperty(auth, propertyId);
    return this.prisma.roomType.findMany({
      where: { tenantId: auth.tenantId, propertyId },
    });
  }

  async setRoomStatus(
    auth: AuthContext,
    roomId: string,
    status: (typeof ROOM_STATES)[number],
    reason?: string
  ) {
    const room = await this.prisma.room.findFirst({
      where: { id: roomId, tenantId: auth.tenantId },
    });
    if (!room) {
      throw new NotFoundException({
        error: { code: "ROOM_NOT_FOUND", message: "Room not found." },
      });
    }
    const occupied = room.operationalStatus.startsWith("OCCUPIED");
    if (occupied && (status === "VACANT_CLEAN" || status === "VACANT_DIRTY")) {
      throw new BadRequestException({
        error: {
          code: "ROOM_OCCUPIED",
          message: "Room has an in-house guest; check the guest out instead of forcing a vacant state.",
        },
      });
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.room.update({
        where: { id: room.id },
        data: { operationalStatus: status },
      });
      await this.audit.log(tx, auth, {
        action: "room.status_changed",
        entityType: "room",
        entityId: room.id,
        propertyId: room.propertyId,
        summary: { from: room.operationalStatus, to: status, reason },
      });
      await this.audit.emit(tx, auth.tenantId, {
        aggregateType: "room",
        aggregateId: room.id,
        eventType: "room.status_changed",
        payload: { roomNumber: room.roomNumber, from: room.operationalStatus, to: status },
      });
      return updated;
    });
  }
}

@Controller()
export class PropertiesController {
  constructor(private readonly service: PropertiesService) {}

  @Get("properties")
  list(@CurrentAuth() auth: AuthContext) {
    return this.service.list(auth);
  }

  @Get("properties/:id/room-rack")
  roomRack(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.roomRack(auth, id);
  }

  @Get("properties/:id/room-types")
  roomTypes(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.roomTypes(auth, id);
  }

  @Patch("rooms/:id/status")
  setRoomStatus(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown
  ) {
    const dto = roomStatusSchema.parse(body);
    return this.service.setRoomStatus(auth, id, dto.status, dto.reason);
  }
}

@Module({
  controllers: [PropertiesController],
  providers: [PropertiesService],
  exports: [PropertiesService],
})
export class PropertiesModule {}
