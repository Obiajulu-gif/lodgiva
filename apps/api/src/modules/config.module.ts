import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { AuthContext, CurrentAuth } from "../common/auth";
import { AuditService } from "../common/audit.service";
import { RequirePermission } from "../common/permissions.guard";
import { CsvError, parseCsv, requireColumns } from "../common/csv";
import { PropertiesModule, PropertiesService } from "./properties.module";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const updatePropertySchema = z
  .object({
    name: z.string().min(2).optional(),
    timezone: z.string().optional(),
    checkinTime: timeOfDay.optional(),
    checkoutTime: timeOfDay.optional(),
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  })
  .strict();

const roomTypeSchema = z
  .object({
    propertyId: z.string().min(1),
    code: z.string().min(2).max(10),
    name: z.string().min(2),
    description: z.string().optional(),
    baseOccupancy: z.number().int().min(1).max(10).default(2),
    maxOccupancy: z.number().int().min(1).max(12).default(2),
    baseRateMinor: z.number().int().positive(),
    amenityIds: z.array(z.string()).default([]),
  })
  .strict();

const updateRoomTypeSchema = roomTypeSchema.partial().omit({ propertyId: true }).strict();

const roomSchema = z
  .object({
    propertyId: z.string().min(1),
    roomTypeId: z.string().min(1),
    roomNumber: z.string().min(1).max(10),
    floor: z.number().int().min(0).max(60).default(1),
    amenityIds: z.array(z.string()).default([]),
  })
  .strict();

const amenitySchema = z
  .object({
    propertyId: z.string().min(1),
    code: z.string().min(2).max(24),
    name: z.string().min(2),
    category: z.enum(["ROOM", "BATHROOM", "TECH", "ACCESSIBILITY", "PROPERTY"]).default("ROOM"),
    icon: z.string().optional(),
  })
  .strict();

const blockSchema = z
  .object({
    propertyId: z.string().min(1),
    roomId: z.string().min(1),
    type: z.enum(["OUT_OF_ORDER", "OUT_OF_SERVICE", "HOUSE_USE"]).default("OUT_OF_ORDER"),
    reason: z.string().min(3),
    startDate: isoDate,
    endDate: isoDate,
  })
  .strict();

const importSchema = z
  .object({ propertyId: z.string().min(1), csv: z.string().min(1), dryRun: z.boolean().default(false) })
  .strict();

@Injectable()
export class ConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly properties: PropertiesService
  ) {}

  // ── Property settings ──────────────────────────────────────────────────

  async getSettings(auth: AuthContext, propertyId: string) {
    const property = await this.properties.assertProperty(auth, propertyId);
    const [roomTypes, rooms, amenities, taxRules, activeBlocks] = await Promise.all([
      this.prisma.roomType.count({ where: { tenantId: auth.tenantId, propertyId } }),
      this.prisma.room.count({ where: { tenantId: auth.tenantId, propertyId } }),
      this.prisma.amenity.count({ where: { tenantId: auth.tenantId, propertyId } }),
      this.prisma.taxRule.findMany({
        where: {
          tenantId: auth.tenantId,
          propertyId,
          effectiveFrom: { lte: property.businessDate },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: property.businessDate } }],
        },
        orderBy: [{ code: "asc" }, { version: "desc" }],
      }),
      this.prisma.roomBlock.count({
        where: { tenantId: auth.tenantId, propertyId, status: "ACTIVE" },
      }),
    ]);
    // Newest effective version per code.
    const effective = new Map<string, (typeof taxRules)[number]>();
    for (const r of taxRules) {
      const seen = effective.get(r.code);
      if (!seen || r.version > seen.version) effective.set(r.code, r);
    }
    return {
      property,
      counts: { roomTypes, rooms, amenities, activeBlocks },
      effectiveTaxRules: [...effective.values()],
    };
  }

  async updateSettings(auth: AuthContext, propertyId: string, body: unknown) {
    const dto = updatePropertySchema.parse(body);
    const property = await this.properties.assertProperty(auth, propertyId);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.property.update({ where: { id: property.id }, data: dto });
      await this.audit.log(tx, auth, {
        action: "property.settings_updated",
        entityType: "property",
        entityId: property.id,
        propertyId: property.id,
        summary: { changed: Object.keys(dto) },
      });
      return updated;
    });
  }

  /**
   * The business date is deliberately read-only here. It advances only through
   * night audit (ADR-009); exposing a setter would let a property skip a day's
   * posting and silently break revenue continuity.
   */
  async getBusinessDate(auth: AuthContext, propertyId: string) {
    const property = await this.properties.assertProperty(auth, propertyId);
    const lastAudit = await this.prisma.nightAuditRun.findFirst({
      where: { tenantId: auth.tenantId, propertyId },
      orderBy: { businessDate: "desc" },
      select: { businessDate: true, completedAt: true },
    });
    return {
      businessDate: property.businessDate,
      timezone: property.timezone,
      lastNightAudit: lastAudit,
      advancedBy: "night_audit_only",
    };
  }

  // ── Room types ─────────────────────────────────────────────────────────

  async listRoomTypes(auth: AuthContext, propertyId: string) {
    await this.properties.assertProperty(auth, propertyId);
    return this.prisma.roomType.findMany({
      where: { tenantId: auth.tenantId, propertyId },
      include: {
        amenities: { include: { amenity: { select: { id: true, code: true, name: true } } } },
        _count: { select: { rooms: true } },
      },
      orderBy: { code: "asc" },
    });
  }

  async createRoomType(auth: AuthContext, body: unknown) {
    const dto = roomTypeSchema.parse(body);
    await this.properties.assertProperty(auth, dto.propertyId);
    if (dto.maxOccupancy < dto.baseOccupancy) {
      throw new BadRequestException({
        error: {
          code: "INVALID_OCCUPANCY",
          message: "Maximum occupancy cannot be lower than base occupancy.",
        },
      });
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const rt = await tx.roomType.create({
          data: {
            tenantId: auth.tenantId,
            propertyId: dto.propertyId,
            code: dto.code.toUpperCase(),
            name: dto.name,
            description: dto.description,
            baseOccupancy: dto.baseOccupancy,
            maxOccupancy: dto.maxOccupancy,
            baseRateMinor: BigInt(dto.baseRateMinor),
          },
        });
        for (const amenityId of dto.amenityIds) {
          await tx.roomTypeAmenity.create({
            data: { tenantId: auth.tenantId, roomTypeId: rt.id, amenityId },
          });
        }
        await this.audit.log(tx, auth, {
          action: "settings.room_type_created",
          entityType: "room_type",
          entityId: rt.id,
          propertyId: dto.propertyId,
          summary: { code: rt.code, baseRateMinor: dto.baseRateMinor },
        });
        return rt;
      });
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "P2002") {
        throw new ConflictException({
          error: { code: "ROOM_TYPE_EXISTS", message: `Room type ${dto.code} already exists here.` },
        });
      }
      throw e;
    }
  }

  async updateRoomType(auth: AuthContext, id: string, body: unknown) {
    const dto = updateRoomTypeSchema.parse(body);
    const rt = await this.prisma.roomType.findFirst({
      where: { id, tenantId: auth.tenantId },
    });
    if (!rt) {
      throw new NotFoundException({
        error: { code: "ROOM_TYPE_NOT_FOUND", message: "Room type not found." },
      });
    }
    await this.properties.assertProperty(auth, rt.propertyId);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.roomType.update({
        where: { id: rt.id },
        data: {
          name: dto.name ?? rt.name,
          description: dto.description ?? rt.description,
          baseOccupancy: dto.baseOccupancy ?? rt.baseOccupancy,
          maxOccupancy: dto.maxOccupancy ?? rt.maxOccupancy,
          baseRateMinor:
            dto.baseRateMinor !== undefined ? BigInt(dto.baseRateMinor) : rt.baseRateMinor,
        },
      });
      if (dto.amenityIds) {
        await tx.roomTypeAmenity.deleteMany({ where: { roomTypeId: rt.id } });
        for (const amenityId of dto.amenityIds) {
          await tx.roomTypeAmenity.create({
            data: { tenantId: auth.tenantId, roomTypeId: rt.id, amenityId },
          });
        }
      }
      await this.audit.log(tx, auth, {
        action: "settings.room_type_updated",
        entityType: "room_type",
        entityId: rt.id,
        propertyId: rt.propertyId,
        summary: { changed: Object.keys(dto) },
      });
      return updated;
    });
  }

  async deleteRoomType(auth: AuthContext, id: string) {
    const rt = await this.prisma.roomType.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { _count: { select: { rooms: true } } },
    });
    if (!rt) {
      throw new NotFoundException({
        error: { code: "ROOM_TYPE_NOT_FOUND", message: "Room type not found." },
      });
    }
    // Deleting a type with rooms would orphan inventory and break historic
    // reservations, so it is refused rather than cascaded.
    if (rt._count.rooms > 0) {
      throw new ConflictException({
        error: {
          code: "ROOM_TYPE_IN_USE",
          message: `${rt._count.rooms} room(s) still use this type. Reassign them first.`,
        },
      });
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.roomTypeAmenity.deleteMany({ where: { roomTypeId: rt.id } });
      await tx.roomType.delete({ where: { id: rt.id } });
      await this.audit.log(tx, auth, {
        action: "settings.room_type_deleted",
        entityType: "room_type",
        entityId: rt.id,
        propertyId: rt.propertyId,
        summary: { code: rt.code },
      });
      return { deleted: true };
    });
  }

  // ── Rooms ──────────────────────────────────────────────────────────────

  async listRooms(auth: AuthContext, propertyId: string) {
    await this.properties.assertProperty(auth, propertyId);
    return this.prisma.room.findMany({
      where: { tenantId: auth.tenantId, propertyId },
      include: {
        roomType: { select: { id: true, code: true, name: true } },
        amenities: { include: { amenity: { select: { id: true, code: true, name: true } } } },
        blocks: { where: { status: "ACTIVE" }, select: { id: true, type: true, startDate: true, endDate: true } },
      },
      orderBy: [{ floor: "asc" }, { roomNumber: "asc" }],
    });
  }

  async createRoom(auth: AuthContext, body: unknown) {
    const dto = roomSchema.parse(body);
    await this.properties.assertProperty(auth, dto.propertyId);
    const rt = await this.prisma.roomType.findFirst({
      where: { id: dto.roomTypeId, tenantId: auth.tenantId, propertyId: dto.propertyId },
    });
    if (!rt) {
      throw new BadRequestException({
        error: { code: "ROOM_TYPE_NOT_FOUND", message: "Room type not found in this property." },
      });
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const room = await tx.room.create({
          data: {
            tenantId: auth.tenantId,
            propertyId: dto.propertyId,
            roomTypeId: rt.id,
            roomNumber: dto.roomNumber,
            floor: dto.floor,
          },
        });
        for (const amenityId of dto.amenityIds) {
          await tx.roomAmenity.create({
            data: { tenantId: auth.tenantId, roomId: room.id, amenityId },
          });
        }
        await this.audit.log(tx, auth, {
          action: "settings.room_created",
          entityType: "room",
          entityId: room.id,
          propertyId: dto.propertyId,
          summary: { roomNumber: room.roomNumber, roomType: rt.code },
        });
        return room;
      });
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "P2002") {
        throw new ConflictException({
          error: { code: "ROOM_EXISTS", message: `Room ${dto.roomNumber} already exists here.` },
        });
      }
      throw e;
    }
  }

  async deleteRoom(auth: AuthContext, id: string) {
    const room = await this.prisma.room.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: {
        _count: {
          select: {
            reservationRooms: true,
            housekeepingTasks: true,
            maintenanceTickets: true,
            blocks: true,
          },
        },
      },
    });
    if (!room) {
      throw new NotFoundException({
        error: { code: "ROOM_NOT_FOUND", message: "Room not found." },
      });
    }
    // Hard delete is only for correcting a mistake (a room created moments
    // ago). Once a room has any operational history, audit events reference
    // it and deleting would orphan them — take it out of service instead.
    const history = {
      reservations: room._count.reservationRooms,
      housekeepingTasks: room._count.housekeepingTasks,
      maintenanceTickets: room._count.maintenanceTickets,
      blocks: room._count.blocks,
    };
    const total = Object.values(history).reduce((a, b) => a + b, 0);
    if (total > 0) {
      throw new ConflictException({
        error: {
          code: "ROOM_HAS_HISTORY",
          message:
            "This room has operational history and cannot be deleted. Take it out of service with a room block instead.",
          details: history,
        },
      });
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.roomAmenity.deleteMany({ where: { roomId: room.id } });
      await tx.room.delete({ where: { id: room.id } });
      await this.audit.log(tx, auth, {
        action: "settings.room_deleted",
        entityType: "room",
        entityId: room.id,
        propertyId: room.propertyId,
        summary: { roomNumber: room.roomNumber },
      });
      return { deleted: true };
    });
  }

  // ── Amenities ──────────────────────────────────────────────────────────

  async listAmenities(auth: AuthContext, propertyId: string) {
    await this.properties.assertProperty(auth, propertyId);
    return this.prisma.amenity.findMany({
      where: { tenantId: auth.tenantId, propertyId },
      orderBy: [{ category: "asc" }, { name: "asc" }],
    });
  }

  async createAmenity(auth: AuthContext, body: unknown) {
    const dto = amenitySchema.parse(body);
    await this.properties.assertProperty(auth, dto.propertyId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const amenity = await tx.amenity.create({
          data: {
            tenantId: auth.tenantId,
            propertyId: dto.propertyId,
            code: dto.code.toUpperCase(),
            name: dto.name,
            category: dto.category,
            icon: dto.icon,
          },
        });
        await this.audit.log(tx, auth, {
          action: "settings.amenity_created",
          entityType: "amenity",
          entityId: amenity.id,
          propertyId: dto.propertyId,
          summary: { code: amenity.code },
        });
        return amenity;
      });
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "P2002") {
        throw new ConflictException({
          error: { code: "AMENITY_EXISTS", message: `Amenity ${dto.code} already exists here.` },
        });
      }
      throw e;
    }
  }

  async deleteAmenity(auth: AuthContext, id: string) {
    const amenity = await this.prisma.amenity.findFirst({
      where: { id, tenantId: auth.tenantId },
    });
    if (!amenity) {
      throw new NotFoundException({
        error: { code: "AMENITY_NOT_FOUND", message: "Amenity not found." },
      });
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.roomTypeAmenity.deleteMany({ where: { amenityId: amenity.id } });
      await tx.roomAmenity.deleteMany({ where: { amenityId: amenity.id } });
      await tx.amenity.delete({ where: { id: amenity.id } });
      await this.audit.log(tx, auth, {
        action: "settings.amenity_deleted",
        entityType: "amenity",
        entityId: amenity.id,
        propertyId: amenity.propertyId,
        summary: { code: amenity.code },
      });
      return { deleted: true };
    });
  }

  // ── Room blocks ────────────────────────────────────────────────────────

  async listBlocks(auth: AuthContext, propertyId: string, status = "ACTIVE") {
    await this.properties.assertProperty(auth, propertyId);
    return this.prisma.roomBlock.findMany({
      where: {
        tenantId: auth.tenantId,
        propertyId,
        ...(status === "ALL" ? {} : { status }),
      },
      include: { room: { select: { roomNumber: true } } },
      orderBy: { startDate: "desc" },
    });
  }

  async createBlock(auth: AuthContext, body: unknown) {
    const dto = blockSchema.parse(body);
    await this.properties.assertProperty(auth, dto.propertyId);
    if (dto.endDate <= dto.startDate) {
      throw new BadRequestException({
        error: { code: "INVALID_DATE_RANGE", message: "Block end date must be after the start date." },
      });
    }
    const room = await this.prisma.room.findFirst({
      where: { id: dto.roomId, tenantId: auth.tenantId, propertyId: dto.propertyId },
    });
    if (!room) {
      throw new NotFoundException({
        error: { code: "ROOM_NOT_FOUND", message: "Room not found in this property." },
      });
    }
    // A block cannot be placed over a stay that is already sold.
    const conflicting = await this.prisma.reservationRoom.count({
      where: {
        tenantId: auth.tenantId,
        roomId: room.id,
        status: { in: ["RESERVED", "IN_HOUSE"] },
        arrivalDate: { lt: dto.endDate },
        departureDate: { gt: dto.startDate },
      },
    });
    if (conflicting > 0) {
      throw new ConflictException({
        error: {
          code: "ROOM_HAS_BOOKINGS",
          message: `Room ${room.roomNumber} has ${conflicting} booking(s) in that window. Move them before blocking it.`,
        },
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const block = await tx.roomBlock.create({
        data: {
          tenantId: auth.tenantId,
          propertyId: dto.propertyId,
          roomId: room.id,
          type: dto.type,
          reason: dto.reason,
          startDate: dto.startDate,
          endDate: dto.endDate,
          createdById: auth.userId,
        },
      });
      // Reflect it immediately on the rack when the block covers today.
      const property = await tx.property.findUniqueOrThrow({ where: { id: dto.propertyId } });
      if (dto.startDate <= property.businessDate && dto.endDate > property.businessDate) {
        await tx.room.update({
          where: { id: room.id },
          data: {
            operationalStatus: dto.type === "OUT_OF_SERVICE" ? "OUT_OF_SERVICE" : "OUT_OF_ORDER",
          },
        });
      }
      await this.audit.log(tx, auth, {
        action: "room.blocked",
        entityType: "room_block",
        entityId: block.id,
        propertyId: dto.propertyId,
        summary: { room: room.roomNumber, type: dto.type, from: dto.startDate, to: dto.endDate },
      });
      await this.audit.emit(tx, auth.tenantId, {
        aggregateType: "room_block",
        aggregateId: block.id,
        eventType: "room.blocked",
        payload: { room: room.roomNumber, type: dto.type },
      });
      return block;
    });
  }

  async releaseBlock(auth: AuthContext, id: string) {
    const block = await this.prisma.roomBlock.findFirst({
      where: { id, tenantId: auth.tenantId, status: "ACTIVE" },
      include: { room: true },
    });
    if (!block) {
      throw new NotFoundException({
        error: { code: "BLOCK_NOT_FOUND", message: "No active block with that id." },
      });
    }
    return this.prisma.$transaction(async (tx) => {
      const released = await tx.roomBlock.update({
        where: { id: block.id },
        data: { status: "RELEASED", releasedById: auth.userId, releasedAt: new Date() },
      });
      // Back to housekeeping, not straight to sellable.
      if (block.room.operationalStatus.startsWith("OUT_OF")) {
        await tx.room.update({
          where: { id: block.roomId },
          data: { operationalStatus: "VACANT_DIRTY" },
        });
      }
      await this.audit.log(tx, auth, {
        action: "room.block_released",
        entityType: "room_block",
        entityId: block.id,
        propertyId: block.propertyId,
        summary: { room: block.room.roomNumber },
      });
      return released;
    });
  }

  // ── Imports ────────────────────────────────────────────────────────────

  /**
   * Bulk room import. Validates the whole file before writing anything, so a
   * bad row on line 40 cannot leave 39 rooms half-created. `dryRun` returns
   * the same report without writing.
   */
  async importRooms(auth: AuthContext, body: unknown) {
    const dto = importSchema.parse(body);
    await this.properties.assertProperty(auth, dto.propertyId);

    let parsed;
    try {
      parsed = parseCsv(dto.csv);
      requireColumns(parsed.headers, ["room_number", "room_type_code", "floor"]);
    } catch (e) {
      throw new BadRequestException({
        error: {
          code: "CSV_INVALID",
          message: e instanceof CsvError ? e.message : "Could not read the CSV file.",
        },
      });
    }

    const types = await this.prisma.roomType.findMany({
      where: { tenantId: auth.tenantId, propertyId: dto.propertyId },
      select: { id: true, code: true },
    });
    const byCode = new Map(types.map((t) => [t.code.toUpperCase(), t.id]));
    const existing = await this.prisma.room.findMany({
      where: { tenantId: auth.tenantId, propertyId: dto.propertyId },
      select: { roomNumber: true },
    });
    const taken = new Set(existing.map((r) => r.roomNumber));

    const errors: { line: number; message: string }[] = [];
    const toCreate: { roomNumber: string; roomTypeId: string; floor: number }[] = [];
    const seen = new Set<string>();

    parsed.rows.forEach((row, i) => {
      const line = i + 2; // header is line 1
      const roomNumber = row.room_number;
      const typeCode = (row.room_type_code ?? "").toUpperCase();
      const floorRaw = row.floor;

      if (!roomNumber) return errors.push({ line, message: "room_number is required." });
      if (taken.has(roomNumber)) {
        return errors.push({ line, message: `Room ${roomNumber} already exists.` });
      }
      if (seen.has(roomNumber)) {
        return errors.push({ line, message: `Room ${roomNumber} is duplicated in the file.` });
      }
      const roomTypeId = byCode.get(typeCode);
      if (!roomTypeId) {
        return errors.push({ line, message: `Unknown room_type_code "${row.room_type_code}".` });
      }
      const floor = Number(floorRaw);
      if (!Number.isInteger(floor) || floor < 0 || floor > 60) {
        return errors.push({ line, message: `floor "${floorRaw}" is not a valid floor number.` });
      }
      seen.add(roomNumber);
      toCreate.push({ roomNumber, roomTypeId, floor });
    });

    if (errors.length) {
      throw new BadRequestException({
        error: {
          code: "IMPORT_VALIDATION_FAILED",
          message: `${errors.length} row(s) could not be imported. Nothing was written.`,
          details: { errors: errors.slice(0, 50), totalRows: parsed.rows.length },
        },
      });
    }

    if (dto.dryRun) {
      return { dryRun: true, wouldCreate: toCreate.length, rooms: toCreate.map((r) => r.roomNumber) };
    }

    const created = await this.prisma.$transaction(async (tx) => {
      for (const r of toCreate) {
        await tx.room.create({
          data: {
            tenantId: auth.tenantId,
            propertyId: dto.propertyId,
            roomTypeId: r.roomTypeId,
            roomNumber: r.roomNumber,
            floor: r.floor,
          },
        });
      }
      await this.audit.log(tx, auth, {
        action: "settings.rooms_imported",
        entityType: "property",
        entityId: dto.propertyId,
        propertyId: dto.propertyId,
        summary: { created: toCreate.length },
      });
      return toCreate.length;
    });

    return { dryRun: false, created, rooms: toCreate.map((r) => r.roomNumber) };
  }
}

@Controller()
export class ConfigController {
  constructor(private readonly service: ConfigService) {}

  @Get("properties/:id/settings")
  getSettings(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.getSettings(auth, id);
  }

  @RequirePermission("settings.property.manage")
  @Patch("properties/:id/settings")
  updateSettings(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown
  ) {
    return this.service.updateSettings(auth, id, body);
  }

  @Get("properties/:id/business-date")
  businessDate(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.getBusinessDate(auth, id);
  }

  @Get("config/room-types")
  listRoomTypes(@CurrentAuth() auth: AuthContext, @Query("propertyId") propertyId: string) {
    return this.service.listRoomTypes(auth, propertyId);
  }

  @RequirePermission("settings.room.manage")
  @Post("config/room-types")
  createRoomType(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.createRoomType(auth, body);
  }

  @RequirePermission("settings.room.manage")
  @Patch("config/room-types/:id")
  updateRoomType(@CurrentAuth() auth: AuthContext, @Param("id") id: string, @Body() body: unknown) {
    return this.service.updateRoomType(auth, id, body);
  }

  @RequirePermission("settings.room.manage")
  @Delete("config/room-types/:id")
  deleteRoomType(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.deleteRoomType(auth, id);
  }

  @Get("config/rooms")
  listRooms(@CurrentAuth() auth: AuthContext, @Query("propertyId") propertyId: string) {
    return this.service.listRooms(auth, propertyId);
  }

  @RequirePermission("settings.room.manage")
  @Post("config/rooms")
  createRoom(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.createRoom(auth, body);
  }

  @RequirePermission("settings.room.manage")
  @Delete("config/rooms/:id")
  deleteRoom(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.deleteRoom(auth, id);
  }

  @Get("config/amenities")
  listAmenities(@CurrentAuth() auth: AuthContext, @Query("propertyId") propertyId: string) {
    return this.service.listAmenities(auth, propertyId);
  }

  @RequirePermission("settings.room.manage")
  @Post("config/amenities")
  createAmenity(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.createAmenity(auth, body);
  }

  @RequirePermission("settings.room.manage")
  @Delete("config/amenities/:id")
  deleteAmenity(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.deleteAmenity(auth, id);
  }

  @Get("config/room-blocks")
  listBlocks(
    @CurrentAuth() auth: AuthContext,
    @Query("propertyId") propertyId: string,
    @Query("status") status?: string
  ) {
    return this.service.listBlocks(auth, propertyId, status);
  }

  @RequirePermission("room.block")
  @Post("config/room-blocks")
  createBlock(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.createBlock(auth, body);
  }

  @RequirePermission("room.block")
  @Post("config/room-blocks/:id/release")
  releaseBlock(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.releaseBlock(auth, id);
  }

  @RequirePermission("settings.room.manage")
  @Post("config/imports/rooms")
  importRooms(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.importRooms(auth, body);
  }
}

@Module({
  imports: [PropertiesModule],
  controllers: [ConfigController],
  providers: [ConfigService],
})
export class ConfigModule {}
