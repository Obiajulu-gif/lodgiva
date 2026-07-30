import {
  BadRequestException,
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
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { AuthContext, CurrentAuth } from "../common/auth";
import { AuditService } from "../common/audit.service";
import { nightsBetween } from "../common/money";
import { InventoryService } from "../common/inventory.service";
import { inventoryMutex } from "../common/mutex";
import { BookingModule, BookingService } from "./booking.module";
import { PropertiesModule, PropertiesService } from "./properties.module";
import { FoliosModule, FoliosService } from "./folios.module";

type Tx = Prisma.TransactionClient;

// §7.1 reservation state machine — legal transitions only.
const TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["HOLD", "CONFIRMED", "CANCELLED"],
  HOLD: ["PENDING_PAYMENT", "CONFIRMED", "CANCELLED"],
  PENDING_PAYMENT: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["CHECKED_IN", "CANCELLED", "NO_SHOW"],
  CHECKED_IN: ["CHECKED_OUT"],
  CHECKED_OUT: [],
  CANCELLED: [],
  NO_SHOW: [],
};

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const createSchema = z
  .object({
    propertyId: z.string().min(1),
    guestId: z.string().min(1),
    roomTypeId: z.string().min(1),
    roomId: z.string().optional(),
    arrivalDate: isoDate,
    departureDate: isoDate,
    adults: z.number().int().min(1).default(1),
    children: z.number().int().min(0).default(0),
    source: z.enum(["DIRECT", "WALK_IN", "PHONE", "BOOKING_ENGINE", "CORPORATE"]).default("WALK_IN"),
    notes: z.string().optional(),
    /** When present, converts an existing hold instead of competing for inventory. */
    holdToken: z.string().optional(),
  })
  .strict();

const checkInSchema = z
  .object({ roomId: z.string().optional(), overrideDirtyRoom: z.boolean().default(false) })
  .strict();

const checkOutSchema = z
  .object({ allowOutstandingBalance: z.boolean().default(false) })
  .strict();

const cancelSchema = z.object({ reason: z.string().min(3) }).strict();

const roomMoveSchema = z
  .object({
    roomId: z.string().min(1),
    reason: z.string().min(3),
    overrideDirtyRoom: z.boolean().default(false),
  })
  .strict();

const extendSchema = z
  .object({ departureDate: isoDate, reason: z.string().optional() })
  .strict();

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly properties: PropertiesService,
    private readonly folios: FoliosService,
    private readonly inventory: InventoryService,
    private readonly booking: BookingService
  ) {}

  private assertTransition(from: string, to: string) {
    if (!TRANSITIONS[from]?.includes(to)) {
      throw new ConflictException({
        error: {
          code: "INVALID_STATE_TRANSITION",
          message: `Cannot move a reservation from ${from} to ${to}.`,
        },
      });
    }
  }

  private async getOrThrow(auth: AuthContext, id: string, tx?: Tx) {
    const db = tx ?? this.prisma;
    const res = await db.reservation.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { rooms: true, folios: true, guest: true },
    });
    if (!res) {
      throw new NotFoundException({
        error: { code: "RESERVATION_NOT_FOUND", message: "Reservation not found." },
      });
    }
    return res;
  }

  /** Overlap rule for date ranges: [arrival, departure) — §8.3. */
  private overlapWhere(arrival: string, departure: string) {
    return { arrivalDate: { lt: departure }, departureDate: { gt: arrival } };
  }

  async availability(
    auth: AuthContext,
    propertyId: string,
    arrival: string,
    departure: string
  ) {
    await this.properties.assertProperty(auth, propertyId);
    if (arrival >= departure) {
      throw new BadRequestException({
        error: { code: "INVALID_DATE_RANGE", message: "Departure must be after arrival." },
      });
    }
    const roomTypes = await this.prisma.roomType.findMany({
      where: { tenantId: auth.tenantId, propertyId },
      include: { _count: { select: { rooms: true } } },
    });
    const result = [];
    for (const rt of roomTypes) {
      const sold = await this.prisma.reservationRoom.count({
        where: {
          tenantId: auth.tenantId,
          roomTypeId: rt.id,
          status: { in: ["RESERVED", "IN_HOUSE"] },
          ...this.overlapWhere(arrival, departure),
          reservation: { status: { in: ["CONFIRMED", "CHECKED_IN", "PENDING_PAYMENT", "HOLD"] } },
        },
      });
      result.push({
        roomTypeId: rt.id,
        code: rt.code,
        name: rt.name,
        baseRateMinor: rt.baseRateMinor,
        totalRooms: rt._count.rooms,
        available: rt._count.rooms - sold,
      });
    }
    return result;
  }

  list(auth: AuthContext, propertyId?: string, status?: string) {
    return this.prisma.reservation.findMany({
      where: {
        tenantId: auth.tenantId,
        ...(propertyId ? { propertyId } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: [{ arrivalDate: "desc" }],
      take: 100,
      include: {
        guest: { select: { id: true, firstName: true, lastName: true, vip: true } },
        rooms: {
          include: {
            room: { select: { roomNumber: true } },
          },
        },
        folios: { select: { id: true, status: true } },
      },
    });
  }

  async get(auth: AuthContext, id: string) {
    const res = await this.getOrThrow(auth, id);
    const folio = res.folios[0];
    const balanceMinor = folio ? await this.folios.balanceMinor(folio.id) : 0n;
    return { ...res, balanceMinor };
  }

  async create(auth: AuthContext, body: unknown) {
    const dto = createSchema.parse(body);
    if (dto.arrivalDate >= dto.departureDate) {
      throw new BadRequestException({
        error: { code: "INVALID_DATE_RANGE", message: "Departure must be after arrival." },
      });
    }
    await this.properties.assertProperty(auth, dto.propertyId);

    // Serialise claims against the same room type in this process so writers
    // queue instead of colliding; the unique index remains the guarantee.
    return inventoryMutex.runExclusive(`rt:${dto.roomTypeId}`, () =>
      this.prisma.transactionWithRetry(async (tx) => {
      const roomType = await tx.roomType.findFirst({
        where: { id: dto.roomTypeId, tenantId: auth.tenantId, propertyId: dto.propertyId },
        include: { _count: { select: { rooms: true } } },
      });
      if (!roomType) {
        throw new NotFoundException({
          error: { code: "ROOM_TYPE_NOT_FOUND", message: "Room type not found." },
        });
      }
      // Inventory is claimed below via RoomNightAllocation, whose unique
      // (roomTypeId, date, slotIndex) constraint is what actually prevents
      // overbooking. A count-based check here would be a check-then-act race.
      let hold = null;
      if (dto.holdToken) {
        hold = await this.booking.consumeHoldTx(tx, auth.tenantId, dto.holdToken);
        if (
          hold.roomTypeId !== roomType.id ||
          hold.arrivalDate !== dto.arrivalDate ||
          hold.departureDate !== dto.departureDate
        ) {
          throw new ConflictException({
            error: {
              code: "HOLD_MISMATCH",
              message: "This hold was issued for different dates or a different room type.",
              details: {
                held: {
                  roomTypeId: hold.roomTypeId,
                  arrivalDate: hold.arrivalDate,
                  departureDate: hold.departureDate,
                },
              },
            },
          });
        }
      }

      if (dto.roomId) {
        const clash = await tx.reservationRoom.count({
          where: {
            tenantId: auth.tenantId,
            roomId: dto.roomId,
            status: { in: ["RESERVED", "IN_HOUSE"] },
            ...this.overlapWhere(dto.arrivalDate, dto.departureDate),
          },
        });
        if (clash > 0) {
          throw new ConflictException({
            error: { code: "ROOM_NOT_AVAILABLE", message: "That physical room is already booked for these dates." },
          });
        }
      }

      const guest = await tx.guest.findFirst({
        where: { id: dto.guestId, tenantId: auth.tenantId },
      });
      if (!guest) {
        throw new NotFoundException({
          error: { code: "GUEST_NOT_FOUND", message: "Guest not found." },
        });
      }

      const count = await tx.reservation.count({ where: { tenantId: auth.tenantId } });
      const confirmationCode = `LDG-${5000 + count + 1}`;

      const reservation = await tx.reservation.create({
        data: {
          tenantId: auth.tenantId,
          propertyId: dto.propertyId,
          confirmationCode,
          primaryGuestId: guest.id,
          source: dto.source,
          status: "CONFIRMED",
          arrivalDate: dto.arrivalDate,
          departureDate: dto.departureDate,
          adults: dto.adults,
          children: dto.children,
          notes: dto.notes,
          rooms: {
            create: {
              tenantId: auth.tenantId,
              roomTypeId: roomType.id,
              roomId: dto.roomId,
              arrivalDate: dto.arrivalDate,
              departureDate: dto.departureDate,
              adults: dto.adults,
              children: dto.children,
              nightlyRateMinor: roomType.baseRateMinor,
            },
          },
        },
        include: { rooms: true },
      });
      // Claim inventory for every night. Throws 409 SOLD_OUT if any night is
      // full — including when a concurrent request won the last slot.
      await this.inventory.allocateStay(tx, {
        tenantId: auth.tenantId,
        propertyId: dto.propertyId,
        roomTypeId: roomType.id,
        arrival: dto.arrivalDate,
        departure: dto.departureDate,
        reservationRoomId: reservation.rooms[0].id,
        consumingHoldId: hold?.id,
      });
      if (hold) {
        await tx.hold.update({
          where: { id: hold.id },
          data: { status: "CONSUMED", consumedAt: new Date() },
        });
      }

      const folio = await tx.folio.create({
        data: {
          tenantId: auth.tenantId,
          propertyId: dto.propertyId,
          reservationId: reservation.id,
          guestId: guest.id,
        },
      });
      await this.audit.log(tx, auth, {
        action: "reservation.created",
        entityType: "reservation",
        entityId: reservation.id,
        propertyId: dto.propertyId,
        summary: { confirmationCode, guest: `${guest.firstName} ${guest.lastName}` },
      });
      await this.audit.emit(tx, auth.tenantId, {
        aggregateType: "reservation",
        aggregateId: reservation.id,
        eventType: "reservation.confirmed",
        payload: { confirmationCode, arrivalDate: dto.arrivalDate },
      });
      return { ...reservation, folioId: folio.id };
      })
    );
  }

  async checkIn(auth: AuthContext, id: string, body: unknown) {
    const dto = checkInSchema.parse(body);
    return this.prisma.$transaction(async (tx) => {
      const res = await this.getOrThrow(auth, id, tx);
      this.assertTransition(res.status, "CHECKED_IN");
      const resRoom = res.rooms[0];
      const roomId = dto.roomId ?? resRoom.roomId;
      if (!roomId) {
        throw new BadRequestException({
          error: { code: "NO_ROOM_ASSIGNED", message: "Assign a room before check-in." },
        });
      }
      const room = await tx.room.findFirst({
        where: { id: roomId, tenantId: auth.tenantId, propertyId: res.propertyId },
      });
      if (!room) {
        throw new NotFoundException({
          error: { code: "ROOM_NOT_FOUND", message: "Room not found." },
        });
      }
      // §7.2: only inspected/clean rooms may be assigned unless an authorised
      // override is recorded (the override itself becomes an audit event).
      const assignable = ["VACANT_CLEAN", "INSPECTED"].includes(room.operationalStatus);
      if (!assignable && !dto.overrideDirtyRoom) {
        throw new ConflictException({
          error: {
            code: "ROOM_NOT_READY",
            message: `Room ${room.roomNumber} is ${room.operationalStatus}; choose another room or record an override.`,
          },
        });
      }
      const clash = await tx.reservationRoom.count({
        where: {
          tenantId: auth.tenantId,
          roomId: room.id,
          status: "IN_HOUSE",
        },
      });
      if (clash > 0) {
        throw new ConflictException({
          error: { code: "ROOM_OCCUPIED", message: `Room ${room.roomNumber} already has an in-house guest.` },
        });
      }

      await tx.reservationRoom.update({
        where: { id: resRoom.id },
        data: { roomId: room.id, status: "IN_HOUSE" },
      });
      await tx.room.update({
        where: { id: room.id },
        data: { operationalStatus: "OCCUPIED_CLEAN" },
      });
      const updated = await tx.reservation.update({
        where: { id: res.id },
        data: { status: "CHECKED_IN", version: { increment: 1 } },
      });
      await this.audit.log(tx, auth, {
        action: "frontdesk.check_in",
        entityType: "reservation",
        entityId: res.id,
        propertyId: res.propertyId,
        summary: {
          room: room.roomNumber,
          override: dto.overrideDirtyRoom && !assignable ? "dirty-room-override" : undefined,
        },
      });
      await this.audit.emit(tx, auth.tenantId, {
        aggregateType: "reservation",
        aggregateId: res.id,
        eventType: "guest.checked_in",
        payload: { confirmationCode: res.confirmationCode, room: room.roomNumber },
      });
      return updated;
    });
  }

  /** Posts any unposted room nights up to today, then requires settlement. */
  async checkOut(auth: AuthContext, id: string, body: unknown) {
    const dto = checkOutSchema.parse(body);
    return this.prisma.$transaction(async (tx) => {
      const res = await this.getOrThrow(auth, id, tx);
      this.assertTransition(res.status, "CHECKED_OUT");
      const property = await tx.property.findUniqueOrThrow({
        where: { id: res.propertyId },
      });
      const folioRow = res.folios[0];
      const folio = await this.folios.getFolioOrThrow(auth, folioRow.id, tx);
      const resRoom = res.rooms[0];
      const room = resRoom.roomId
        ? await tx.room.findUnique({ where: { id: resRoom.roomId } })
        : null;

      // Post room charges for every stayed night not yet posted.
      const stayedUntil =
        property.businessDate < res.departureDate ? property.businessDate : res.departureDate;
      const nights = nightsBetween(res.arrivalDate, stayedUntil);
      const lastNight = nights.length ? nights : nightsBetween(res.arrivalDate, res.departureDate).slice(0, 1);
      for (const night of lastNight) {
        const description = `Room ${room?.roomNumber ?? ""} night ${night}`.trim();
        const already = await tx.folioEntry.findFirst({
          where: { folioId: folio.id, type: "ROOM_CHARGE", description },
        });
        if (!already) {
          await this.folios.postChargeTx(tx, auth, folio, {
            type: "ROOM_CHARGE",
            description,
            amountMinor: resRoom.nightlyRateMinor,
            applyTaxes: true,
            businessDate: property.businessDate,
          });
        }
      }

      const balance = await this.folios.balanceMinor(folio.id, tx);
      if (balance > 0n && !dto.allowOutstandingBalance) {
        throw new ConflictException({
          error: {
            code: "OUTSTANDING_BALANCE",
            message: `Folio has an outstanding balance of ₦${(Number(balance) / 100).toLocaleString()}. Take payment or record an approved receivable.`,
            details: { balanceMinor: Number(balance) },
          },
        });
      }

      await tx.folio.update({
        where: { id: folio.id },
        data: { status: "CLOSED", closedAt: new Date() },
      });
      await tx.reservationRoom.update({
        where: { id: resRoom.id },
        data: { status: "DEPARTED" },
      });
      if (room) {
        await tx.room.update({
          where: { id: room.id },
          data: { operationalStatus: "VACANT_DIRTY" },
        });
        await tx.housekeepingTask.create({
          data: {
            tenantId: auth.tenantId,
            propertyId: res.propertyId,
            roomId: room.id,
            businessDate: property.businessDate,
            type: "TURNOVER",
            priority: "HIGH",
            notes: `Post-checkout turnover (${res.confirmationCode})`,
          },
        });
      }
      const updated = await tx.reservation.update({
        where: { id: res.id },
        data: { status: "CHECKED_OUT", version: { increment: 1 } },
      });
      await this.audit.log(tx, auth, {
        action: "frontdesk.check_out",
        entityType: "reservation",
        entityId: res.id,
        propertyId: res.propertyId,
        summary: {
          balanceMinor: Number(balance),
          receivable: balance > 0n ? true : undefined,
        },
      });
      await this.audit.emit(tx, auth.tenantId, {
        aggregateType: "reservation",
        aggregateId: res.id,
        eventType: "guest.checked_out",
        payload: { confirmationCode: res.confirmationCode },
      });
      return updated;
    });
  }

  /**
   * §7 Front Office room move. The stay keeps its folio and confirmation
   * code; the vacated room goes dirty and gets a turnover task, exactly as it
   * would after a checkout.
   */
  async roomMove(auth: AuthContext, id: string, body: unknown) {
    const dto = roomMoveSchema.parse(body);
    return this.prisma.$transaction(async (tx) => {
      const res = await this.getOrThrow(auth, id, tx);
      if (res.status !== "CHECKED_IN") {
        throw new ConflictException({
          error: {
            code: "NOT_IN_HOUSE",
            message: "Only an in-house reservation can be moved to another room.",
          },
        });
      }
      const resRoom = res.rooms[0];
      const target = await tx.room.findFirst({
        where: { id: dto.roomId, tenantId: auth.tenantId, propertyId: res.propertyId },
      });
      if (!target) {
        throw new NotFoundException({
          error: { code: "ROOM_NOT_FOUND", message: "Target room not found." },
        });
      }
      if (target.id === resRoom.roomId) {
        throw new BadRequestException({
          error: { code: "SAME_ROOM", message: "The guest is already in that room." },
        });
      }
      const occupied = await tx.reservationRoom.count({
        where: { tenantId: auth.tenantId, roomId: target.id, status: "IN_HOUSE" },
      });
      if (occupied > 0) {
        throw new ConflictException({
          error: { code: "ROOM_OCCUPIED", message: `Room ${target.roomNumber} already has an in-house guest.` },
        });
      }
      const ready = ["VACANT_CLEAN", "INSPECTED"].includes(target.operationalStatus);
      if (!ready && !dto.overrideDirtyRoom) {
        throw new ConflictException({
          error: {
            code: "ROOM_NOT_READY",
            message: `Room ${target.roomNumber} is ${target.operationalStatus}; choose another room or record an override.`,
          },
        });
      }

      const previous = resRoom.roomId
        ? await tx.room.findUnique({ where: { id: resRoom.roomId } })
        : null;
      const property = await tx.property.findUniqueOrThrow({ where: { id: res.propertyId } });

      await tx.reservationRoom.update({
        where: { id: resRoom.id },
        data: { roomId: target.id },
      });
      await tx.room.update({
        where: { id: target.id },
        data: { operationalStatus: "OCCUPIED_CLEAN" },
      });
      if (previous) {
        await tx.room.update({
          where: { id: previous.id },
          data: { operationalStatus: "VACANT_DIRTY" },
        });
        await tx.housekeepingTask.create({
          data: {
            tenantId: auth.tenantId,
            propertyId: res.propertyId,
            roomId: previous.id,
            businessDate: property.businessDate,
            type: "TURNOVER",
            priority: "HIGH",
            notes: `Room move ${previous.roomNumber} → ${target.roomNumber} (${res.confirmationCode})`,
          },
        });
      }
      const updated = await tx.reservation.update({
        where: { id: res.id },
        data: { version: { increment: 1 } },
      });
      await this.audit.log(tx, auth, {
        action: "frontdesk.room_move",
        entityType: "reservation",
        entityId: res.id,
        propertyId: res.propertyId,
        summary: {
          from: previous?.roomNumber,
          to: target.roomNumber,
          reason: dto.reason,
          override: !ready ? "dirty-room-override" : undefined,
        },
      });
      await this.audit.emit(tx, auth.tenantId, {
        aggregateType: "reservation",
        aggregateId: res.id,
        eventType: "reservation.room_moved",
        payload: { confirmationCode: res.confirmationCode, to: target.roomNumber },
      });
      return { ...updated, roomNumber: target.roomNumber };
    });
  }

  /**
   * Extend or shorten a stay. Extending re-checks capacity for the added
   * nights so an extension can never create a double booking.
   */
  async extendStay(auth: AuthContext, id: string, body: unknown) {
    const dto = extendSchema.parse(body);
    return this.prisma.$transaction(async (tx) => {
      const res = await this.getOrThrow(auth, id, tx);
      if (!["CHECKED_IN", "CONFIRMED"].includes(res.status)) {
        throw new ConflictException({
          error: {
            code: "NOT_EXTENDABLE",
            message: `A ${res.status} reservation cannot change its departure date.`,
          },
        });
      }
      if (dto.departureDate <= res.arrivalDate) {
        throw new BadRequestException({
          error: { code: "INVALID_DATE_RANGE", message: "Departure must be after arrival." },
        });
      }
      const resRoom = res.rooms[0];
      const extending = dto.departureDate > res.departureDate;

      if (extending) {
        // Capacity for the added nights only: [old departure, new departure).
        const sold = await tx.reservationRoom.count({
          where: {
            tenantId: auth.tenantId,
            roomTypeId: resRoom.roomTypeId,
            status: { in: ["RESERVED", "IN_HOUSE"] },
            id: { not: resRoom.id },
            ...this.overlapWhere(res.departureDate, dto.departureDate),
            reservation: { status: { in: ["CONFIRMED", "CHECKED_IN", "PENDING_PAYMENT", "HOLD"] } },
          },
        });
        const roomType = await tx.roomType.findUniqueOrThrow({
          where: { id: resRoom.roomTypeId },
          include: { _count: { select: { rooms: true } } },
        });
        if (sold >= roomType._count.rooms) {
          throw new ConflictException({
            error: {
              code: "ROOM_NOT_AVAILABLE",
              message: `No ${roomType.name} availability for the extended nights.`,
            },
          });
        }
        // The specific physical room must also be free for the added nights.
        if (resRoom.roomId) {
          const clash = await tx.reservationRoom.count({
            where: {
              tenantId: auth.tenantId,
              roomId: resRoom.roomId,
              id: { not: resRoom.id },
              status: { in: ["RESERVED", "IN_HOUSE"] },
              ...this.overlapWhere(res.departureDate, dto.departureDate),
            },
          });
          if (clash > 0) {
            throw new ConflictException({
              error: {
                code: "ROOM_NOT_AVAILABLE",
                message: "This room is booked by another guest for the extended nights.",
              },
            });
          }
        }
      }

      const nights = nightsBetween(res.arrivalDate, dto.departureDate).length;
      await tx.reservationRoom.update({
        where: { id: resRoom.id },
        data: { departureDate: dto.departureDate },
      });
      const updated = await tx.reservation.update({
        where: { id: res.id },
        data: { departureDate: dto.departureDate, version: { increment: 1 } },
      });
      await this.audit.log(tx, auth, {
        action: extending ? "frontdesk.stay_extended" : "frontdesk.early_departure",
        entityType: "reservation",
        entityId: res.id,
        propertyId: res.propertyId,
        summary: {
          from: res.departureDate,
          to: dto.departureDate,
          nights,
          reason: dto.reason,
        },
      });
      return updated;
    });
  }

  async cancel(auth: AuthContext, id: string, body: unknown) {
    const dto = cancelSchema.parse(body);
    return this.prisma.$transaction(async (tx) => {
      const res = await this.getOrThrow(auth, id, tx);
      this.assertTransition(res.status, "CANCELLED");
      await tx.reservationRoom.updateMany({
        where: { reservationId: res.id },
        data: { status: "RELEASED" },
      });
      // Cancelled nights go back on sale immediately.
      for (const rr of res.rooms) {
        await this.inventory.releaseReservationRoom(tx, rr.id);
      }
      const updated = await tx.reservation.update({
        where: { id: res.id },
        data: { status: "CANCELLED", version: { increment: 1 } },
      });
      await this.audit.log(tx, auth, {
        action: "reservation.cancelled",
        entityType: "reservation",
        entityId: res.id,
        propertyId: res.propertyId,
        summary: { reason: dto.reason },
      });
      await this.audit.emit(tx, auth.tenantId, {
        aggregateType: "reservation",
        aggregateId: res.id,
        eventType: "reservation.cancelled",
        payload: { confirmationCode: res.confirmationCode, reason: dto.reason },
      });
      return updated;
    });
  }

  async noShow(auth: AuthContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const res = await this.getOrThrow(auth, id, tx);
      this.assertTransition(res.status, "NO_SHOW");
      await tx.reservationRoom.updateMany({
        where: { reservationId: res.id },
        data: { status: "RELEASED" },
      });
      for (const rr of res.rooms) {
        await this.inventory.releaseReservationRoom(tx, rr.id);
      }
      const updated = await tx.reservation.update({
        where: { id: res.id },
        data: { status: "NO_SHOW", version: { increment: 1 } },
      });
      await this.audit.log(tx, auth, {
        action: "reservation.no_show",
        entityType: "reservation",
        entityId: res.id,
        propertyId: res.propertyId,
      });
      return updated;
    });
  }
}

@Controller("reservations")
export class ReservationsController {
  constructor(private readonly service: ReservationsService) {}

  @Get("availability")
  availability(
    @CurrentAuth() auth: AuthContext,
    @Query("propertyId") propertyId: string,
    @Query("arrival") arrival: string,
    @Query("departure") departure: string
  ) {
    return this.service.availability(auth, propertyId, arrival, departure);
  }

  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query("propertyId") propertyId?: string,
    @Query("status") status?: string
  ) {
    return this.service.list(auth, propertyId, status);
  }

  @Get(":id")
  get(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.get(auth, id);
  }

  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.create(auth, body);
  }

  @Post(":id/check-in")
  checkIn(@CurrentAuth() auth: AuthContext, @Param("id") id: string, @Body() body: unknown) {
    return this.service.checkIn(auth, id, body ?? {});
  }

  @Post(":id/check-out")
  checkOut(@CurrentAuth() auth: AuthContext, @Param("id") id: string, @Body() body: unknown) {
    return this.service.checkOut(auth, id, body ?? {});
  }

  @Post(":id/room-move")
  roomMove(@CurrentAuth() auth: AuthContext, @Param("id") id: string, @Body() body: unknown) {
    return this.service.roomMove(auth, id, body);
  }

  @Post(":id/extend")
  extend(@CurrentAuth() auth: AuthContext, @Param("id") id: string, @Body() body: unknown) {
    return this.service.extendStay(auth, id, body);
  }

  @Post(":id/cancel")
  cancel(@CurrentAuth() auth: AuthContext, @Param("id") id: string, @Body() body: unknown) {
    return this.service.cancel(auth, id, body);
  }

  @Post(":id/no-show")
  noShow(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.noShow(auth, id);
  }
}

@Module({
  imports: [PropertiesModule, FoliosModule, BookingModule],
  controllers: [ReservationsController],
  providers: [ReservationsService],
})
export class ReservationsModule {}
