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
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { AuthContext, CurrentAuth } from "../common/auth";
import { AuditService } from "../common/audit.service";
import { RequirePermission } from "../common/permissions.guard";
import { PropertiesModule, PropertiesService } from "./properties.module";

/**
 * §7 Inventory and Procurement.
 *
 * Quantities are integers in THOUSANDTHS, for the same reason money is in
 * minor units: 0.1kg + 0.2kg must equal 0.3kg exactly. A float ledger drifts,
 * and a stock ledger that drifts cannot distinguish rounding from theft —
 * which is the entire point of keeping one.
 */
const QTY_SCALE = 1000;

/** Movements that remove stock, stored negative so the ledger simply sums. */
const OUTFLOWS = ["ISSUE", "CONSUMPTION", "TRANSFER_OUT", "WASTAGE"];

const itemSchema = z
  .object({
    propertyId: z.string().min(1),
    sku: z.string().min(1).max(40),
    name: z.string().min(1).max(120),
    category: z.enum(["HOUSEKEEPING", "FB", "MAINTENANCE", "GENERAL"]).default("GENERAL"),
    unit: z.enum(["EACH", "KG", "LITRE", "PACK", "BOTTLE"]).default("EACH"),
    reorderLevel: z.number().min(0).max(1_000_000).default(0),
    unitCostMinor: z.number().int().min(0).default(0),
  })
  .strict();

const locationSchema = z
  .object({
    propertyId: z.string().min(1),
    code: z.string().min(1).max(20),
    name: z.string().min(1).max(80),
  })
  .strict();

const movementSchema = z
  .object({
    propertyId: z.string().min(1),
    itemId: z.string().min(1),
    locationId: z.string().min(1),
    type: z.enum([
      "RECEIPT",
      "ISSUE",
      "CONSUMPTION",
      "ADJUSTMENT",
      "TRANSFER_IN",
      "TRANSFER_OUT",
      "WASTAGE",
    ]),
    /** Always positive; the type decides the sign. ADJUSTMENT may be negative. */
    quantity: z.number(),
    unitCostMinor: z.number().int().min(0).optional(),
    reference: z.string().max(80).optional(),
    note: z.string().max(300).optional(),
  })
  .strict();

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly properties: PropertiesService
  ) {}

  async createItem(auth: AuthContext, body: unknown) {
    const dto = itemSchema.parse(body);
    await this.properties.assertProperty(auth, dto.propertyId);
    try {
      const item = await this.prisma.inventoryItem.create({
        data: {
          tenantId: auth.tenantId,
          ...dto,
          sku: dto.sku.toUpperCase(),
          reorderLevel: Math.round(dto.reorderLevel * QTY_SCALE),
          unitCostMinor: BigInt(dto.unitCostMinor),
        },
      });
      return this.presentItem(item);
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "P2002") {
        throw new ConflictException({
          error: { code: "SKU_EXISTS", message: `SKU ${dto.sku} already exists at this property.` },
        });
      }
      throw e;
    }
  }

  async createLocation(auth: AuthContext, body: unknown) {
    const dto = locationSchema.parse(body);
    await this.properties.assertProperty(auth, dto.propertyId);
    try {
      return await this.prisma.stockLocation.create({
        data: { tenantId: auth.tenantId, ...dto, code: dto.code.toUpperCase() },
      });
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "P2002") {
        throw new ConflictException({
          error: { code: "LOCATION_EXISTS", message: `Location ${dto.code} already exists.` },
        });
      }
      throw e;
    }
  }

  private presentItem(item: {
    id: string;
    sku: string;
    name: string;
    category: string;
    unit: string;
    reorderLevel: number;
    unitCostMinor: bigint;
    active: boolean;
  }) {
    return {
      id: item.id,
      sku: item.sku,
      name: item.name,
      category: item.category,
      unit: item.unit,
      reorderLevel: item.reorderLevel / QTY_SCALE,
      unitCostMinor: Number(item.unitCostMinor),
      active: item.active,
    };
  }

  async listItems(auth: AuthContext, propertyId: string, category?: string) {
    await this.properties.assertProperty(auth, propertyId);
    const items = await this.prisma.inventoryItem.findMany({
      where: {
        tenantId: auth.tenantId,
        propertyId,
        active: true,
        ...(category ? { category } : {}),
      },
      orderBy: [{ category: "asc" }, { name: "asc" }],
    });
    return items.map((i) => this.presentItem(i));
  }

  async listLocations(auth: AuthContext, propertyId: string) {
    await this.properties.assertProperty(auth, propertyId);
    return this.prisma.stockLocation.findMany({
      where: { tenantId: auth.tenantId, propertyId, active: true },
      orderBy: { code: "asc" },
    });
  }

  /**
   * Records a movement. The ledger is append-only: a mistake is corrected with
   * an opposing ADJUSTMENT, never by editing history.
   */
  async recordMovement(auth: AuthContext, body: unknown) {
    const dto = movementSchema.parse(body);
    const property = await this.properties.assertProperty(auth, dto.propertyId);

    if (dto.quantity === 0) {
      throw new BadRequestException({
        error: { code: "ZERO_QUANTITY", message: "A movement must change the stock level." },
      });
    }
    if (dto.type !== "ADJUSTMENT" && dto.quantity < 0) {
      throw new BadRequestException({
        error: {
          code: "NEGATIVE_QUANTITY",
          message: `Enter a positive quantity — "${dto.type}" already determines the direction.`,
        },
      });
    }

    const [item, location] = await Promise.all([
      this.prisma.inventoryItem.findFirst({
        where: { id: dto.itemId, tenantId: auth.tenantId, propertyId: dto.propertyId },
      }),
      this.prisma.stockLocation.findFirst({
        where: { id: dto.locationId, tenantId: auth.tenantId, propertyId: dto.propertyId },
      }),
    ]);
    if (!item || !location) {
      throw new NotFoundException({
        error: { code: "ITEM_OR_LOCATION_NOT_FOUND", message: "Item or location not found." },
      });
    }

    const magnitude = Math.round(Math.abs(dto.quantity) * QTY_SCALE);
    const signed =
      dto.type === "ADJUSTMENT"
        ? Math.round(dto.quantity * QTY_SCALE)
        : OUTFLOWS.includes(dto.type)
          ? -magnitude
          : magnitude;

    // Stock cannot go negative: a location holding -3 bottles is a data error
    // that hides either an unrecorded delivery or a theft.
    if (signed < 0) {
      const onHand = await this.onHand(auth.tenantId, dto.itemId, dto.locationId);
      if (onHand + signed < 0) {
        throw new ConflictException({
          error: {
            code: "INSUFFICIENT_STOCK",
            message: `Only ${onHand / QTY_SCALE} ${item.unit.toLowerCase()} of ${item.name} on hand at ${location.code}.`,
            details: { onHand: onHand / QTY_SCALE, requested: Math.abs(signed) / QTY_SCALE },
          },
        });
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const movement = await tx.stockMovement.create({
        data: {
          tenantId: auth.tenantId,
          propertyId: dto.propertyId,
          itemId: dto.itemId,
          locationId: dto.locationId,
          type: dto.type,
          quantity: signed,
          unitCostMinor: BigInt(dto.unitCostMinor ?? Number(item.unitCostMinor)),
          reference: dto.reference,
          note: dto.note,
          businessDate: property.businessDate,
          performedById: auth.userId,
        },
      });
      await this.audit.log(tx, auth, {
        action: "inventory.movement_recorded",
        entityType: "stock_movement",
        entityId: movement.id,
        propertyId: dto.propertyId,
        summary: {
          sku: item.sku,
          type: dto.type,
          quantity: signed / QTY_SCALE,
          location: location.code,
        },
      });
      return {
        id: movement.id,
        type: movement.type,
        quantity: signed / QTY_SCALE,
        businessDate: movement.businessDate,
      };
    });
  }

  /** Current level for an item at a location, in thousandths. */
  private async onHand(tenantId: string, itemId: string, locationId: string): Promise<number> {
    const agg = await this.prisma.stockMovement.aggregate({
      where: { tenantId, itemId, locationId },
      _sum: { quantity: true },
    });
    return agg._sum.quantity ?? 0;
  }

  /** §14 stock on hand, with reorder flags — the report a storekeeper acts on. */
  async stockOnHand(auth: AuthContext, propertyId: string, lowOnly = false) {
    await this.properties.assertProperty(auth, propertyId);
    const items = await this.prisma.inventoryItem.findMany({
      where: { tenantId: auth.tenantId, propertyId, active: true },
      orderBy: [{ category: "asc" }, { name: "asc" }],
    });
    const grouped = await this.prisma.stockMovement.groupBy({
      by: ["itemId"],
      where: { tenantId: auth.tenantId, propertyId },
      _sum: { quantity: true },
    });
    const byItem = new Map(grouped.map((g) => [g.itemId, g._sum.quantity ?? 0]));

    const rows = items.map((i) => {
      const qty = byItem.get(i.id) ?? 0;
      return {
        itemId: i.id,
        sku: i.sku,
        name: i.name,
        category: i.category,
        unit: i.unit,
        onHand: qty / QTY_SCALE,
        reorderLevel: i.reorderLevel / QTY_SCALE,
        belowReorder: qty <= i.reorderLevel && i.reorderLevel > 0,
        valuationMinor: Math.round((qty / QTY_SCALE) * Number(i.unitCostMinor)),
      };
    });
    const filtered = lowOnly ? rows.filter((r) => r.belowReorder) : rows;
    return {
      rows: filtered,
      totalValuationMinor: rows.reduce((s, r) => s + r.valuationMinor, 0),
      belowReorderCount: rows.filter((r) => r.belowReorder).length,
    };
  }

  /** Consumption and wastage over a period — where stock actually goes. */
  async movementSummary(
    auth: AuthContext,
    propertyId: string,
    from: string,
    to: string
  ) {
    await this.properties.assertProperty(auth, propertyId);
    const movements = await this.prisma.stockMovement.findMany({
      where: {
        tenantId: auth.tenantId,
        propertyId,
        businessDate: { gte: from, lte: to },
      },
      include: { item: { select: { sku: true, name: true, unit: true } } },
    });

    const byType = new Map<string, number>();
    const byItem = new Map<string, { sku: string; name: string; unit: string; net: number; wastage: number }>();
    for (const m of movements) {
      byType.set(m.type, (byType.get(m.type) ?? 0) + m.quantity);
      const row =
        byItem.get(m.itemId) ??
        { sku: m.item.sku, name: m.item.name, unit: m.item.unit, net: 0, wastage: 0 };
      row.net += m.quantity;
      if (m.type === "WASTAGE") row.wastage += Math.abs(m.quantity);
      byItem.set(m.itemId, row);
    }

    return {
      from,
      to,
      movementCount: movements.length,
      byType: [...byType.entries()].map(([type, qty]) => ({
        type,
        quantity: qty / QTY_SCALE,
      })),
      byItem: [...byItem.values()]
        .map((r) => ({ ...r, net: r.net / QTY_SCALE, wastage: r.wastage / QTY_SCALE }))
        .sort((a, b) => b.wastage - a.wastage),
    };
  }

  async ledger(auth: AuthContext, propertyId: string, itemId: string) {
    await this.properties.assertProperty(auth, propertyId);
    const movements = await this.prisma.stockMovement.findMany({
      where: { tenantId: auth.tenantId, propertyId, itemId },
      orderBy: { createdAt: "asc" },
      include: { location: { select: { code: true } } },
      take: 500,
    });
    let running = 0;
    return movements.map((m) => {
      running += m.quantity;
      return {
        id: m.id,
        businessDate: m.businessDate,
        type: m.type,
        quantity: m.quantity / QTY_SCALE,
        balance: running / QTY_SCALE,
        location: m.location.code,
        reference: m.reference,
        note: m.note,
      };
    });
  }
}

@Controller("inventory")
export class InventoryController {
  constructor(private readonly service: InventoryService) {}

  @Get("items")
  listItems(
    @CurrentAuth() auth: AuthContext,
    @Query("propertyId") propertyId: string,
    @Query("category") category?: string
  ) {
    return this.service.listItems(auth, propertyId, category);
  }

  @RequirePermission("inventory.manage")
  @Post("items")
  createItem(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.createItem(auth, body);
  }

  @Get("locations")
  listLocations(@CurrentAuth() auth: AuthContext, @Query("propertyId") propertyId: string) {
    return this.service.listLocations(auth, propertyId);
  }

  @RequirePermission("inventory.manage")
  @Post("locations")
  createLocation(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.createLocation(auth, body);
  }

  @RequirePermission("inventory.manage")
  @Post("movements")
  recordMovement(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.recordMovement(auth, body);
  }

  @Get("stock-on-hand")
  stockOnHand(
    @CurrentAuth() auth: AuthContext,
    @Query("propertyId") propertyId: string,
    @Query("lowOnly") lowOnly?: string
  ) {
    return this.service.stockOnHand(auth, propertyId, lowOnly === "true");
  }

  @Get("movement-summary")
  movementSummary(
    @CurrentAuth() auth: AuthContext,
    @Query("propertyId") propertyId: string,
    @Query("from") from: string,
    @Query("to") to: string
  ) {
    return this.service.movementSummary(auth, propertyId, from, to);
  }

  @Get("ledger")
  ledger(
    @CurrentAuth() auth: AuthContext,
    @Query("propertyId") propertyId: string,
    @Query("itemId") itemId: string
  ) {
    return this.service.ledger(auth, propertyId, itemId);
  }
}

@Module({
  imports: [PropertiesModule],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
