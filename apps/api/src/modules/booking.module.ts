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
import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { AuthContext, CurrentAuth, Public } from "../common/auth";
import { AuditService } from "../common/audit.service";
import { TaxService } from "../common/tax.service";
import { InventoryService } from "../common/inventory.service";
import { inventoryMutex } from "../common/mutex";
import { evaluateRestrictions, RestrictionRow } from "../common/restrictions";
import { nightsBetween } from "../common/money";
import { PropertiesModule, PropertiesService } from "./properties.module";
import { FoliosModule } from "./folios.module";

type Tx = Prisma.TransactionClient;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/** Holds live long enough to pay, short enough not to strangle inventory. */
const HOLD_MINUTES = Number(process.env.HOLD_MINUTES ?? 15);

const holdSchema = z
  .object({
    propertyId: z.string().min(1),
    ratePlanId: z.string().min(1),
    arrivalDate: isoDate,
    departureDate: isoDate,
    adults: z.number().int().min(1).max(10).default(1),
    children: z.number().int().min(0).max(10).default(0),
  })
  .strict();

const publicQuoteSchema = z
  .object({
    propertySlug: z.string().min(1),
    ratePlanCode: z.string().min(1).optional(),
    arrivalDate: isoDate,
    departureDate: isoDate,
    adults: z.number().int().min(1).max(10).default(1),
    children: z.number().int().min(0).max(10).default(0),
  })
  .strict();

export interface QuoteResult {
  ratePlan: { id: string; code: string; name: string; refundable: boolean };
  roomType: { id: string; code: string; name: string; maxOccupancy: number };
  nights: { date: string; rateMinor: number; source: string }[];
  baseMinor: number;
  taxes: { code: string; name: string; amountMinor: number; ruleVersion: number }[];
  totalMinor: number;
  currency: string;
  availableRooms: number;
}

@Injectable()
export class BookingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly properties: PropertiesService,
    private readonly tax: TaxService,
    private readonly inventory: InventoryService
  ) {}

  private assertRange(arrival: string, departure: string) {
    if (arrival >= departure) {
      throw new BadRequestException({
        error: { code: "INVALID_DATE_RANGE", message: "Departure must be after arrival." },
      });
    }
    if (nightsBetween(arrival, departure).length > 60) {
      throw new BadRequestException({
        error: { code: "STAY_TOO_LONG", message: "Stays longer than 60 nights must be booked as a group block." },
      });
    }
  }

  /**
   * Prices a stay night by night and checks restrictions and live inventory.
   * Shared by the authenticated and public quote paths so a guest and an
   * agent can never be shown different numbers for the same stay.
   */
  private async priceStay(
    tx: Tx | PrismaService,
    input: {
      tenantId: string;
      propertyId: string;
      businessDate: string;
      ratePlanId: string;
      arrivalDate: string;
      departureDate: string;
      adults: number;
      children: number;
    }
  ): Promise<QuoteResult> {
    const plan = await tx.ratePlan.findFirst({
      where: {
        id: input.ratePlanId,
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        status: "ACTIVE",
      },
      include: { roomType: true },
    });
    if (!plan) {
      throw new NotFoundException({
        error: { code: "RATE_PLAN_NOT_FOUND", message: "Rate plan not found." },
      });
    }

    const occupancy = input.adults + input.children;
    if (occupancy > plan.roomType.maxOccupancy) {
      throw new ConflictException({
        error: {
          code: "OCCUPANCY_EXCEEDED",
          message: `${plan.roomType.name} sleeps a maximum of ${plan.roomType.maxOccupancy}.`,
          details: { maxOccupancy: plan.roomType.maxOccupancy, requested: occupancy },
        },
      });
    }

    const nights = nightsBetween(input.arrivalDate, input.departureDate);

    // Restrictions are evaluated against the arrival date and every night.
    const restrictionRows = await tx.rateRestriction.findMany({
      where: {
        ratePlanId: plan.id,
        date: { in: [...nights, input.departureDate] },
      },
    });
    const restrictions = new Map<string, RestrictionRow>(
      restrictionRows.map((r) => [r.date, r])
    );
    const violations = evaluateRestrictions({
      nights,
      departureDate: input.departureDate,
      restrictions,
      planMinStay: plan.minStay,
      businessDate: input.businessDate,
    });
    if (violations.length) {
      throw new ConflictException({
        error: {
          code: violations[0].code,
          message: violations[0].message,
          retryable: false,
          details: { violations },
        },
      });
    }

    // Night-by-night pricing from the calendar, falling back to the base rate.
    const overrides = await tx.dailyRate.findMany({
      where: { ratePlanId: plan.id, date: { in: nights } },
    });
    const byDate = new Map(overrides.map((o) => [o.date, o]));
    const breakdown = nights.map((date) => {
      const o = byDate.get(date);
      return {
        date,
        rateMinor: Number(o?.rateMinor ?? plan.roomType.baseRateMinor),
        source: o ? "CALENDAR" : "BASE",
      };
    });
    const baseMinor = breakdown.reduce((s, n) => s + BigInt(n.rateMinor), 0n);

    const computed = await this.tax.compute(tx, {
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      baseMinor,
      chargeKind: "ROOM",
      businessDate: input.businessDate,
    });

    const perNight = await this.inventory.availabilityByNight(
      {
        tenantId: input.tenantId,
        roomTypeId: plan.roomTypeId,
        arrival: input.arrivalDate,
        departure: input.departureDate,
      },
      tx
    );
    const availableRooms = Math.min(...perNight.map((n) => n.available));

    return {
      ratePlan: { id: plan.id, code: plan.code, name: plan.name, refundable: plan.refundable },
      roomType: {
        id: plan.roomType.id,
        code: plan.roomType.code,
        name: plan.roomType.name,
        maxOccupancy: plan.roomType.maxOccupancy,
      },
      nights: breakdown,
      baseMinor: Number(baseMinor),
      taxes: computed.lines.map((l) => ({
        code: l.code,
        name: l.name,
        amountMinor: Number(l.amountMinor),
        ruleVersion: l.taxRuleVersion,
      })),
      totalMinor: Number(computed.total),
      currency: "NGN",
      availableRooms,
    };
  }

  /** Authenticated availability across every rate plan for a property. */
  async availability(
    auth: AuthContext,
    propertyId: string,
    arrival: string,
    departure: string
  ) {
    const property = await this.properties.assertProperty(auth, propertyId);
    this.assertRange(arrival, departure);
    await this.inventory.expireStaleHolds(auth.tenantId);

    const roomTypes = await this.prisma.roomType.findMany({
      where: { tenantId: auth.tenantId, propertyId, status: "ACTIVE" },
      include: { ratePlans: { where: { status: "ACTIVE" } } },
    });

    const results = [];
    for (const rt of roomTypes) {
      const byNight = await this.inventory.availabilityByNight({
        tenantId: auth.tenantId,
        roomTypeId: rt.id,
        arrival,
        departure,
      });
      const available = byNight.length ? Math.min(...byNight.map((n) => n.available)) : 0;
      const plans = [];
      for (const plan of rt.ratePlans) {
        try {
          const quote = await this.priceStay(this.prisma, {
            tenantId: auth.tenantId,
            propertyId,
            businessDate: property.businessDate,
            ratePlanId: plan.id,
            arrivalDate: arrival,
            departureDate: departure,
            adults: 1,
            children: 0,
          });
          plans.push({
            id: plan.id,
            code: plan.code,
            name: plan.name,
            sellable: true,
            totalMinor: quote.totalMinor,
          });
        } catch (e: unknown) {
          // A restricted plan is reported as unsellable with the reason
          // rather than omitted, so staff can see why it cannot be sold.
          const err = (e as { response?: { error?: { code: string; message: string } } }).response
            ?.error;
          plans.push({
            id: plan.id,
            code: plan.code,
            name: plan.name,
            sellable: false,
            reason: err?.code ?? "UNAVAILABLE",
            message: err?.message,
          });
        }
      }
      results.push({
        roomTypeId: rt.id,
        code: rt.code,
        name: rt.name,
        baseRateMinor: Number(rt.baseRateMinor),
        maxOccupancy: rt.maxOccupancy,
        available,
        byNight,
        ratePlans: plans,
      });
    }
    return results;
  }

  async quote(
    auth: AuthContext,
    propertyId: string,
    ratePlanId: string,
    arrival: string,
    departure: string,
    adults = 1,
    children = 0
  ) {
    const property = await this.properties.assertProperty(auth, propertyId);
    this.assertRange(arrival, departure);
    await this.inventory.expireStaleHolds(auth.tenantId);
    return this.priceStay(this.prisma, {
      tenantId: auth.tenantId,
      propertyId,
      businessDate: property.businessDate,
      ratePlanId,
      arrivalDate: arrival,
      departureDate: departure,
      adults,
      children,
    });
  }

  /**
   * §6.3 public booking: anonymous quote by property slug. No tenant context
   * exists yet, so the slug resolves it. Rate-limited globally; returns only
   * what a prospective guest needs.
   */
  async publicQuote(body: unknown) {
    const dto = publicQuoteSchema.parse(body);
    this.assertRange(dto.arrivalDate, dto.departureDate);

    const property = await this.prisma.property.findFirst({
      where: { slug: dto.propertySlug, status: "ACTIVE" },
    });
    if (!property) {
      throw new NotFoundException({
        error: { code: "PROPERTY_NOT_FOUND", message: "No such property." },
      });
    }
    await this.inventory.expireStaleHolds(property.tenantId);

    const plans = await this.prisma.ratePlan.findMany({
      where: {
        tenantId: property.tenantId,
        propertyId: property.id,
        status: "ACTIVE",
        ...(dto.ratePlanCode ? { code: dto.ratePlanCode.toUpperCase() } : {}),
      },
    });

    const offers = [];
    for (const plan of plans) {
      try {
        const quote = await this.priceStay(this.prisma, {
          tenantId: property.tenantId,
          propertyId: property.id,
          businessDate: property.businessDate,
          ratePlanId: plan.id,
          arrivalDate: dto.arrivalDate,
          departureDate: dto.departureDate,
          adults: dto.adults,
          children: dto.children,
        });
        // Only offer what can actually be sold right now.
        if (quote.availableRooms > 0) offers.push(quote);
      } catch {
        // Restricted or sold out: silently omitted from a public response —
        // a prospective guest gets alternatives, not internal rule codes.
      }
    }

    return {
      property: { name: property.name, slug: property.slug, timezone: property.timezone },
      arrivalDate: dto.arrivalDate,
      departureDate: dto.departureDate,
      nights: nightsBetween(dto.arrivalDate, dto.departureDate).length,
      offers,
    };
  }

  /**
   * Creates a hold: prices the stay, then claims real inventory for it. The
   * returned token is the only way to consume the hold and is stored hashed.
   */
  async createHold(auth: AuthContext | null, body: unknown, tenantOverride?: string) {
    const dto = holdSchema.parse(body);
    this.assertRange(dto.arrivalDate, dto.departureDate);

    const tenantId = auth?.tenantId ?? tenantOverride;
    if (!tenantId) {
      throw new BadRequestException({
        error: { code: "TENANT_REQUIRED", message: "Could not resolve a tenant for this hold." },
      });
    }
    const property = auth
      ? await this.properties.assertProperty(auth, dto.propertyId)
      : await this.prisma.property.findFirstOrThrow({ where: { id: dto.propertyId, tenantId } });

    await this.inventory.expireStaleHolds(tenantId);

    const token = randomBytes(24).toString("base64url");

    const hold = await inventoryMutex.runExclusive(`rt-hold:${dto.ratePlanId}`, () =>
      this.prisma.transactionWithRetry(async (tx) => {
      const quote = await this.priceStay(tx, {
        tenantId,
        propertyId: property.id,
        businessDate: property.businessDate,
        ratePlanId: dto.ratePlanId,
        arrivalDate: dto.arrivalDate,
        departureDate: dto.departureDate,
        adults: dto.adults,
        children: dto.children,
      });

      const created = await tx.hold.create({
        data: {
          tenantId,
          propertyId: property.id,
          roomTypeId: quote.roomType.id,
          ratePlanId: quote.ratePlan.id,
          tokenHash: sha256(token),
          arrivalDate: dto.arrivalDate,
          departureDate: dto.departureDate,
          adults: dto.adults,
          children: dto.children,
          // The price is frozen here: a rate change mid-payment must not move
          // the number the guest agreed to.
          quotedTotalMinor: BigInt(quote.totalMinor),
          quotedBreakdown: JSON.stringify({ nights: quote.nights, taxes: quote.taxes }),
          expiresAt: new Date(Date.now() + HOLD_MINUTES * 60_000),
        },
      });

      await this.inventory.allocateStay(tx, {
        tenantId,
        propertyId: property.id,
        roomTypeId: quote.roomType.id,
        arrival: dto.arrivalDate,
        departure: dto.departureDate,
        holdId: created.id,
      });

      if (auth) {
        await this.audit.log(tx, auth, {
          action: "reservation.hold_created",
          entityType: "hold",
          entityId: created.id,
          propertyId: property.id,
          summary: {
            arrival: dto.arrivalDate,
            departure: dto.departureDate,
            totalMinor: quote.totalMinor,
          },
        });
      }
      return { created, quote };
      })
    );

    return {
      holdId: hold.created.id,
      holdToken: token,
      expiresAt: hold.created.expiresAt,
      expiresInSeconds: HOLD_MINUTES * 60,
      quote: hold.quote,
    };
  }

  async getHold(tokenOrId: string) {
    await this.inventory.expireStaleHolds();
    const hold = await this.prisma.hold.findFirst({
      where: { OR: [{ id: tokenOrId }, { tokenHash: sha256(tokenOrId) }] },
      include: { roomType: { select: { code: true, name: true } } },
    });
    if (!hold) {
      throw new NotFoundException({
        error: { code: "HOLD_NOT_FOUND", message: "Hold not found." },
      });
    }
    return {
      id: hold.id,
      status: hold.status,
      arrivalDate: hold.arrivalDate,
      departureDate: hold.departureDate,
      roomType: hold.roomType,
      quotedTotalMinor: Number(hold.quotedTotalMinor),
      breakdown: JSON.parse(hold.quotedBreakdown),
      expiresAt: hold.expiresAt,
      expired: hold.status === "ACTIVE" && hold.expiresAt <= new Date(),
    };
  }

  async releaseHold(auth: AuthContext, holdIdOrToken: string) {
    const hold = await this.prisma.hold.findFirst({
      where: {
        tenantId: auth.tenantId,
        OR: [{ id: holdIdOrToken }, { tokenHash: sha256(holdIdOrToken) }],
      },
    });
    if (!hold) {
      throw new NotFoundException({
        error: { code: "HOLD_NOT_FOUND", message: "Hold not found." },
      });
    }
    if (hold.status !== "ACTIVE") {
      throw new ConflictException({
        error: { code: "HOLD_NOT_ACTIVE", message: `Hold is already ${hold.status}.` },
      });
    }
    return this.prisma.$transaction(async (tx) => {
      await this.inventory.releaseHold(tx, hold.id);
      const released = await tx.hold.update({
        where: { id: hold.id },
        data: { status: "RELEASED", releasedAt: new Date() },
      });
      await this.audit.log(tx, auth, {
        action: "reservation.hold_released",
        entityType: "hold",
        entityId: hold.id,
        propertyId: hold.propertyId,
      });
      return released;
    });
  }

  /**
   * Validates a hold token for conversion into a reservation. Returns the hold
   * row inside the caller's transaction so the check and the consume are
   * atomic.
   */
  async consumeHoldTx(tx: Tx, tenantId: string, token: string) {
    const hold = await tx.hold.findFirst({
      where: { tenantId, tokenHash: sha256(token) },
    });
    if (!hold) {
      throw new NotFoundException({
        error: { code: "HOLD_NOT_FOUND", message: "Hold token is not valid." },
      });
    }
    if (hold.status !== "ACTIVE") {
      throw new ConflictException({
        error: {
          code: "HOLD_NOT_ACTIVE",
          message: `This hold has already been ${hold.status.toLowerCase()}.`,
        },
      });
    }
    if (hold.expiresAt <= new Date()) {
      throw new ConflictException({
        error: {
          code: "HOLD_EXPIRED",
          message: "This hold has expired and its rooms were released. Please re-quote.",
          retryable: true,
        },
      });
    }
    return hold;
  }
}

@Controller()
export class BookingController {
  constructor(private readonly service: BookingService) {}

  @Get("availability")
  availability(
    @CurrentAuth() auth: AuthContext,
    @Query("propertyId") propertyId: string,
    @Query("arrival") arrival: string,
    @Query("departure") departure: string
  ) {
    return this.service.availability(auth, propertyId, arrival, departure);
  }

  @Get("quotes")
  quote(
    @CurrentAuth() auth: AuthContext,
    @Query("propertyId") propertyId: string,
    @Query("ratePlanId") ratePlanId: string,
    @Query("arrival") arrival: string,
    @Query("departure") departure: string,
    @Query("adults") adults?: string,
    @Query("children") children?: string
  ) {
    return this.service.quote(
      auth,
      propertyId,
      ratePlanId,
      arrival,
      departure,
      adults ? Number(adults) : 1,
      children ? Number(children) : 0
    );
  }

  @Post("holds")
  createHold(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.createHold(auth, body);
  }

  @Get("holds/:id")
  getHold(@Param("id") id: string) {
    return this.service.getHold(id);
  }

  @Post("holds/:id/release")
  releaseHold(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.releaseHold(auth, id);
  }

  /** Anonymous booking-engine quote (§6.3). */
  @Public()
  @Post("public/quotes")
  publicQuote(@Body() body: unknown) {
    return this.service.publicQuote(body);
  }
}

@Module({
  imports: [PropertiesModule, FoliosModule],
  controllers: [BookingController],
  providers: [BookingService, InventoryService],
  exports: [BookingService, InventoryService],
})
export class BookingModule {}
