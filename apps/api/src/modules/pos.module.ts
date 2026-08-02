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
import { TaxService } from "../common/tax.service";
import { roleHasPermission } from "../common/permissions";
import { decideVoid } from "../common/pos-void";
import { PropertiesModule, PropertiesService } from "./properties.module";
import { FoliosModule, FoliosService } from "./folios.module";

const createOrderSchema = z
  .object({
    outletId: z.string().min(1),
    tableRef: z.string().optional(),
    lines: z
      .array(
        z.object({
          menuItemId: z.string().min(1),
          quantity: z.number().int().min(1).max(99),
        })
      )
      .min(1),
  })
  .strict();

const settleSchema = z
  .object({
    settlement: z.enum(["ROOM_POSTING", "CASH", "CARD", "POS_TERMINAL", "TRANSFER"]),
    // Required for ROOM_POSTING: the in-house folio to charge.
    folioId: z.string().optional(),
    shiftId: z.string().optional(),
  })
  .strict();

const voidSchema = z.object({ reason: z.string().min(3) }).strict();

/**
 * §7 POS and Outlets — orders are priced from the menu server-side (never
 * from client-supplied amounts), and settle either to a guest room folio
 * (creating real ledger entries) or to a cashier tender.
 */
@Injectable()
export class PosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly properties: PropertiesService,
    private readonly folios: FoliosService,
    private readonly tax: TaxService
  ) {}

  async outlets(auth: AuthContext, propertyId: string) {
    await this.properties.assertProperty(auth, propertyId);
    return this.prisma.outlet.findMany({
      where: { tenantId: auth.tenantId, propertyId, status: "ACTIVE" },
      include: {
        menuItems: {
          where: { active: true },
          orderBy: [{ category: "asc" }, { name: "asc" }],
        },
      },
    });
  }

  async orders(auth: AuthContext, propertyId: string) {
    await this.properties.assertProperty(auth, propertyId);
    return this.prisma.posOrder.findMany({
      where: { tenantId: auth.tenantId, propertyId },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { outlet: { select: { name: true } }, lines: true },
    });
  }

  async createOrder(auth: AuthContext, body: unknown) {
    const dto = createOrderSchema.parse(body);
    return this.prisma.$transaction(async (tx) => {
      const outlet = await tx.outlet.findFirst({
        where: { id: dto.outletId, tenantId: auth.tenantId },
      });
      if (!outlet) {
        throw new NotFoundException({
          error: { code: "OUTLET_NOT_FOUND", message: "Outlet not found." },
        });
      }
      const property = await tx.property.findUniqueOrThrow({
        where: { id: outlet.propertyId },
      });

      // Server-side pricing from the menu (§9.1 — never trust client amounts).
      let subtotal = 0n;
      const lineData: {
        tenantId: string;
        menuItemId: string;
        description: string;
        quantity: number;
        unitMinor: bigint;
        lineMinor: bigint;
      }[] = [];
      for (const l of dto.lines) {
        const item = await tx.menuItem.findFirst({
          where: { id: l.menuItemId, tenantId: auth.tenantId, outletId: outlet.id, active: true },
        });
        if (!item) {
          throw new NotFoundException({
            error: { code: "MENU_ITEM_NOT_FOUND", message: `Menu item ${l.menuItemId} not available in this outlet.` },
          });
        }
        const lineMinor = item.priceMinor * BigInt(l.quantity);
        subtotal += lineMinor;
        lineData.push({
          tenantId: auth.tenantId,
          menuItemId: item.id,
          description: item.name,
          quantity: l.quantity,
          unitMinor: item.priceMinor,
          lineMinor,
        });
      }
      // Same versioned tax engine the folio uses, so an order posted to a
      // room can never total differently from its ledger lines.
      const computed = await this.tax.compute(tx, {
        tenantId: auth.tenantId,
        propertyId: outlet.propertyId,
        baseMinor: subtotal,
        chargeKind: "FB",
        businessDate: property.businessDate,
      });
      const serviceMinor = computed.lines
        .filter((l) => l.isServiceCharge)
        .reduce((s, l) => s + l.amountMinor, 0n);
      const taxMinor = computed.lines
        .filter((l) => !l.isServiceCharge)
        .reduce((s, l) => s + l.amountMinor, 0n);
      const count = await tx.posOrder.count({
        where: { tenantId: auth.tenantId, propertyId: outlet.propertyId },
      });
      const order = await tx.posOrder.create({
        data: {
          tenantId: auth.tenantId,
          propertyId: outlet.propertyId,
          outletId: outlet.id,
          orderNumber: `${outlet.code}-${1000 + count + 1}`,
          tableRef: dto.tableRef,
          subtotalMinor: computed.base,
          serviceMinor,
          taxMinor,
          totalMinor: computed.total,
          businessDate: property.businessDate,
          openedById: auth.userId,
          lines: { create: lineData },
        },
        include: { lines: true },
      });
      await this.audit.log(tx, auth, {
        action: "pos.order_created",
        entityType: "pos_order",
        entityId: order.id,
        propertyId: outlet.propertyId,
        summary: { orderNumber: order.orderNumber, totalMinor: Number(computed.total) },
      });
      return order;
    });
  }

  async settle(auth: AuthContext, orderId: string, body: unknown) {
    const dto = settleSchema.parse(body);
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.posOrder.findFirst({
        where: { id: orderId, tenantId: auth.tenantId },
        include: { lines: true, outlet: true },
      });
      if (!order) {
        throw new NotFoundException({
          error: { code: "ORDER_NOT_FOUND", message: "Order not found." },
        });
      }
      if (order.status === "VOID_PENDING") {
        // Settling underneath a pending void would let a waiter collect on an
        // order they have already asked to make disappear.
        throw new ConflictException({
          error: {
            code: "VOID_PENDING",
            message:
              "This order has a void awaiting approval. It must be approved or rejected before it can be settled.",
            details: { approvalRequestId: order.voidRequestId },
          },
        });
      }
      if (order.status !== "OPEN") {
        throw new ConflictException({
          error: { code: "ORDER_NOT_OPEN", message: `Order is already ${order.status}.` },
        });
      }

      if (dto.settlement === "ROOM_POSTING") {
        if (!dto.folioId) {
          throw new BadRequestException({
            error: { code: "FOLIO_REQUIRED", message: "Room posting requires a folio id." },
          });
        }
        const folio = await this.folios.getFolioOrThrow(auth, dto.folioId, tx);
        if (folio.status !== "OPEN") {
          throw new ConflictException({
            error: { code: "FOLIO_CLOSED", message: "Cannot post to a closed folio." },
          });
        }
        // Post the pre-tax subtotal; postChargeTx re-derives service + VAT as
        // their own immutable ledger lines, matching the order totals.
        await this.folios.postChargeTx(tx, auth, folio, {
          type: "POS_CHARGE",
          description: `${order.outlet.name} order ${order.orderNumber}`,
          amountMinor: order.subtotalMinor,
          applyTaxes: true,
          businessDate: order.businessDate,
        });
      } else if (dto.settlement === "CASH" && dto.shiftId) {
        // Cash tendered at an outlet lands in the cashier drawer.
        const shift = await tx.cashierShift.findFirst({
          where: { id: dto.shiftId, tenantId: auth.tenantId, status: "OPEN" },
        });
        if (!shift) {
          throw new NotFoundException({
            error: { code: "SHIFT_NOT_OPEN", message: "No open cashier shift with that id." },
          });
        }
        await tx.cashMovement.create({
          data: {
            tenantId: auth.tenantId,
            shiftId: shift.id,
            type: "PAYMENT_IN",
            amountMinor: order.totalMinor,
            reference: order.orderNumber,
            note: `POS cash settlement — ${order.outlet.name}`,
            recordedById: auth.userId,
          },
        });
      }

      const settled = await tx.posOrder.update({
        where: { id: order.id },
        data: {
          status: "SETTLED",
          settlement: dto.settlement,
          folioId: dto.settlement === "ROOM_POSTING" ? dto.folioId : null,
          shiftId: dto.shiftId,
          settledAt: new Date(),
        },
      });
      await this.audit.log(tx, auth, {
        action: "pos.order_settled",
        entityType: "pos_order",
        entityId: order.id,
        propertyId: order.propertyId,
        summary: { orderNumber: order.orderNumber, settlement: dto.settlement, totalMinor: Number(order.totalMinor) },
      });
      await this.audit.emit(tx, auth.tenantId, {
        aggregateType: "pos_order",
        aggregateId: order.id,
        eventType: "pos.order_settled",
        payload: { orderNumber: order.orderNumber, settlement: dto.settlement, totalMinor: Number(order.totalMinor) },
      });
      return settled;
    });
  }

  /**
   * §13.4 Voiding an order.
   *
   * A void is the one POS action that makes revenue disappear, which makes it
   * the obvious way to take cash from a till: ring the order, collect the
   * money, void the ticket, pocket the difference. So voids are only free for
   * genuine keying mistakes — small, and caught within a few minutes of the
   * order being opened. Everything else goes to a supervisor, and the order
   * sits in VOID_PENDING where it can be neither settled nor voided again.
   *
   * A settled order is never voidable at all: the money has already reached a
   * folio or a drawer, and the honest correction there is a reversal or refund
   * that leaves both sides of the story on the ledger.
   */
  async void(auth: AuthContext, orderId: string, body: unknown) {
    const dto = voidSchema.parse(body);
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.posOrder.findFirst({
        where: { id: orderId, tenantId: auth.tenantId },
      });
      if (!order) {
        throw new NotFoundException({
          error: { code: "ORDER_NOT_FOUND", message: "Order not found." },
        });
      }
      if (order.status === "SETTLED") {
        throw new ConflictException({
          error: {
            code: "ORDER_SETTLED",
            message: "A settled order cannot be voided; reverse the folio entry or refund instead.",
          },
        });
      }
      if (order.status === "VOIDED") {
        throw new ConflictException({
          error: { code: "ALREADY_VOIDED", message: "This order is already voided." },
        });
      }
      if (order.status === "VOID_PENDING") {
        throw new ConflictException({
          error: {
            code: "VOID_PENDING",
            message: "A void is already awaiting supervisor approval for this order.",
            details: { approvalRequestId: order.voidRequestId },
          },
        });
      }

      const ageMinutes = (Date.now() - order.createdAt.getTime()) / 60_000;
      const total = Number(order.totalMinor);
      const canApprove = roleHasPermission(auth.role, "approval.decide");
      const decision = decideVoid({ totalMinor: total, ageMinutes, canApprove });

      if (decision.requiresApproval) {
        const request = await tx.approvalRequest.create({
          data: {
            tenantId: auth.tenantId,
            propertyId: order.propertyId,
            type: "POS_VOID",
            entityType: "pos_order",
            entityId: order.id,
            amountMinor: order.totalMinor,
            reason: dto.reason,
            payload: JSON.stringify({ orderId: order.id, orderNumber: order.orderNumber }),
            requestedById: auth.userId,
          },
        });
        await tx.posOrder.update({
          where: { id: order.id },
          data: { status: "VOID_PENDING", voidRequestId: request.id, voidReason: dto.reason },
        });
        await this.audit.log(tx, auth, {
          action: "approval.requested",
          entityType: "approval_request",
          entityId: request.id,
          propertyId: order.propertyId,
          summary: {
            type: "POS_VOID",
            orderNumber: order.orderNumber,
            amountMinor: total,
            ageMinutes: Math.round(ageMinutes),
            reason: dto.reason,
          },
        });
        return {
          status: "PENDING_APPROVAL",
          request,
          order: { id: order.id, orderNumber: order.orderNumber, status: "VOID_PENDING" },
          message: decision.message,
        };
      }

      const voided = await tx.posOrder.update({
        where: { id: order.id },
        data: { status: "VOIDED", voidReason: dto.reason },
      });
      await this.audit.log(tx, auth, {
        action: "pos.order_voided",
        entityType: "pos_order",
        entityId: order.id,
        propertyId: order.propertyId,
        summary: {
          orderNumber: order.orderNumber,
          reason: dto.reason,
          amountMinor: total,
          approval: canApprove ? "self (approver)" : "not required (within correction window)",
        },
      });
      return { status: "VOIDED", order: voided };
    });
  }
}

@Controller("pos")
export class PosController {
  constructor(private readonly service: PosService) {}

  @Get("outlets")
  outlets(@CurrentAuth() auth: AuthContext, @Query("propertyId") propertyId: string) {
    return this.service.outlets(auth, propertyId);
  }

  @Get("orders")
  orders(@CurrentAuth() auth: AuthContext, @Query("propertyId") propertyId: string) {
    return this.service.orders(auth, propertyId);
  }

  @Post("orders")
  create(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.createOrder(auth, body);
  }

  @Post("orders/:id/settle")
  settle(@CurrentAuth() auth: AuthContext, @Param("id") id: string, @Body() body: unknown) {
    return this.service.settle(auth, id, body);
  }

  @Post("orders/:id/void")
  voidOrder(@CurrentAuth() auth: AuthContext, @Param("id") id: string, @Body() body: unknown) {
    return this.service.void(auth, id, body);
  }
}

@Module({
  imports: [PropertiesModule, FoliosModule],
  controllers: [PosController],
  providers: [PosService],
})
export class PosModule {}
