import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { AuthContext, CurrentAuth } from "../common/auth";
import { AuditService } from "../common/audit.service";
import { TaxService } from "../common/tax.service";
import { nightsBetween } from "../common/money";
import { PropertiesModule, PropertiesService } from "./properties.module";
import { FoliosModule } from "./folios.module";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const ratePlanSchema = z
  .object({
    propertyId: z.string().min(1),
    roomTypeId: z.string().min(1),
    code: z.string().min(2),
    name: z.string().min(2),
    refundable: z.boolean().default(true),
    minStay: z.number().int().min(1).default(1),
    includesBreakfast: z.boolean().default(false),
  })
  .strict();

const dailyRateSchema = z
  .object({
    ratePlanId: z.string().min(1),
    rates: z
      .array(
        z.object({
          date: isoDate,
          rateMinor: z.number().int().positive(),
          closed: z.boolean().default(false),
        })
      )
      .min(1),
  })
  .strict();

const taxRuleSchema = z
  .object({
    propertyId: z.string().min(1),
    code: z.string().min(2),
    name: z.string().min(2),
    rateBp: z.number().int().min(0).max(10000),
    appliesTo: z.enum(["ALL", "ROOM", "FB"]).default("ALL"),
    basis: z.enum(["EXCLUSIVE", "INCLUSIVE"]).default("EXCLUSIVE"),
    compoundOrder: z.number().int().min(1).default(1),
    taxOnServiceCharge: z.boolean().default(true),
    effectiveFrom: isoDate,
  })
  .strict();

/** Rate plans, the rate calendar, quotes, and versioned tax configuration. */
@Injectable()
export class RatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly properties: PropertiesService,
    private readonly tax: TaxService
  ) {}

  async listPlans(auth: AuthContext, propertyId: string) {
    await this.properties.assertProperty(auth, propertyId);
    return this.prisma.ratePlan.findMany({
      where: { tenantId: auth.tenantId, propertyId, status: "ACTIVE" },
      include: { roomType: { select: { code: true, name: true, baseRateMinor: true } } },
    });
  }

  async createPlan(auth: AuthContext, body: unknown) {
    const dto = ratePlanSchema.parse(body);
    await this.properties.assertProperty(auth, dto.propertyId);
    try {
      return await this.prisma.ratePlan.create({
        data: { tenantId: auth.tenantId, ...dto },
      });
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "P2002") {
        throw new ConflictException({
          error: { code: "RATE_PLAN_EXISTS", message: `Rate plan ${dto.code} already exists for this property.` },
        });
      }
      throw e;
    }
  }

  async setDailyRates(auth: AuthContext, body: unknown) {
    const dto = dailyRateSchema.parse(body);
    const plan = await this.prisma.ratePlan.findFirst({
      where: { id: dto.ratePlanId, tenantId: auth.tenantId },
    });
    if (!plan) {
      throw new NotFoundException({
        error: { code: "RATE_PLAN_NOT_FOUND", message: "Rate plan not found." },
      });
    }
    return this.prisma.$transaction(async (tx) => {
      for (const r of dto.rates) {
        await tx.dailyRate.upsert({
          where: { ratePlanId_date: { ratePlanId: plan.id, date: r.date } },
          update: { rateMinor: BigInt(r.rateMinor), closed: r.closed },
          create: {
            tenantId: auth.tenantId,
            ratePlanId: plan.id,
            date: r.date,
            rateMinor: BigInt(r.rateMinor),
            closed: r.closed,
          },
        });
      }
      await this.audit.log(tx, auth, {
        action: "rates.calendar_updated",
        entityType: "rate_plan",
        entityId: plan.id,
        propertyId: plan.propertyId,
        summary: { dates: dto.rates.length },
      });
      return { updated: dto.rates.length };
    });
  }

  async calendar(auth: AuthContext, ratePlanId: string, from: string, to: string) {
    const plan = await this.prisma.ratePlan.findFirst({
      where: { id: ratePlanId, tenantId: auth.tenantId },
      include: { roomType: true },
    });
    if (!plan) {
      throw new NotFoundException({
        error: { code: "RATE_PLAN_NOT_FOUND", message: "Rate plan not found." },
      });
    }
    const overrides = await this.prisma.dailyRate.findMany({
      where: { ratePlanId: plan.id, date: { gte: from, lte: to } },
    });
    const byDate = new Map(overrides.map((o) => [o.date, o]));
    return nightsBetween(from, to).map((date) => {
      const o = byDate.get(date);
      return {
        date,
        rateMinor: o ? o.rateMinor : plan.roomType.baseRateMinor,
        closed: o?.closed ?? false,
        source: o ? "CALENDAR" : "BASE",
      };
    });
  }

  /**
   * §7 quote: prices a stay night by night from the rate calendar, applies
   * restrictions, then adds taxes through the versioned engine.
   */
  async quote(
    auth: AuthContext,
    propertyId: string,
    ratePlanId: string,
    arrival: string,
    departure: string
  ) {
    const property = await this.properties.assertProperty(auth, propertyId);
    if (!arrival || !departure || arrival >= departure) {
      throw new BadRequestException({
        error: { code: "INVALID_DATE_RANGE", message: "Departure must be after arrival." },
      });
    }
    const plan = await this.prisma.ratePlan.findFirst({
      where: { id: ratePlanId, tenantId: auth.tenantId, propertyId },
      include: { roomType: true },
    });
    if (!plan) {
      throw new NotFoundException({
        error: { code: "RATE_PLAN_NOT_FOUND", message: "Rate plan not found." },
      });
    }
    const nights = nightsBetween(arrival, departure);
    if (nights.length < plan.minStay) {
      throw new ConflictException({
        error: {
          code: "MIN_STAY_NOT_MET",
          message: `${plan.name} requires a minimum stay of ${plan.minStay} night(s).`,
        },
      });
    }
    const overrides = await this.prisma.dailyRate.findMany({
      where: { ratePlanId: plan.id, date: { in: nights } },
    });
    const byDate = new Map(overrides.map((o) => [o.date, o]));

    const closed = nights.filter((n) => byDate.get(n)?.closed);
    if (closed.length) {
      throw new ConflictException({
        error: {
          code: "DATES_CLOSED",
          message: `${plan.name} is closed for ${closed.join(", ")}.`,
        },
      });
    }

    const breakdown = nights.map((date) => ({
      date,
      rateMinor: byDate.get(date)?.rateMinor ?? plan.roomType.baseRateMinor,
    }));
    const base = breakdown.reduce((s, n) => s + n.rateMinor, 0n);
    const computed = await this.tax.compute(this.prisma, {
      tenantId: auth.tenantId,
      propertyId,
      baseMinor: base,
      chargeKind: "ROOM",
      businessDate: property.businessDate,
    });

    return {
      ratePlan: { id: plan.id, code: plan.code, name: plan.name, refundable: plan.refundable },
      roomType: { id: plan.roomTypeId, name: plan.roomType.name },
      nights: breakdown,
      baseMinor: base,
      taxes: computed.lines.map((l) => ({
        code: l.code,
        name: l.name,
        amountMinor: l.amountMinor,
        ruleVersion: l.taxRuleVersion,
      })),
      totalMinor: computed.total,
    };
  }

  async listTaxRules(auth: AuthContext, propertyId: string) {
    await this.properties.assertProperty(auth, propertyId);
    return this.prisma.taxRule.findMany({
      where: { tenantId: auth.tenantId, propertyId },
      orderBy: [{ code: "asc" }, { version: "desc" }],
    });
  }

  /**
   * §13.4 — changing a tax rate never mutates the existing rule. It closes
   * the current version at the new effective date and creates version + 1,
   * so posted lines keep the rule they were billed under.
   */
  async upsertTaxRule(auth: AuthContext, body: unknown) {
    const dto = taxRuleSchema.parse(body);
    await this.properties.assertProperty(auth, dto.propertyId);
    if (!["TENANT_OWNER", "GENERAL_MANAGER", "FINANCE"].includes(auth.role)) {
      throw new ConflictException({
        error: {
          code: "FORBIDDEN_ROLE",
          message: "Only an owner, general manager or finance user can change tax configuration.",
        },
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const current = await tx.taxRule.findFirst({
        where: { tenantId: auth.tenantId, propertyId: dto.propertyId, code: dto.code },
        orderBy: { version: "desc" },
      });
      if (current) {
        await tx.taxRule.update({
          where: { id: current.id },
          data: { effectiveTo: dto.effectiveFrom },
        });
      }
      const created = await tx.taxRule.create({
        data: {
          tenantId: auth.tenantId,
          ...dto,
          version: (current?.version ?? 0) + 1,
          createdById: auth.userId,
        },
      });
      await this.audit.log(tx, auth, {
        action: "tax.rule_versioned",
        entityType: "tax_rule",
        entityId: created.id,
        propertyId: dto.propertyId,
        summary: {
          code: dto.code,
          rateBp: dto.rateBp,
          version: created.version,
          effectiveFrom: dto.effectiveFrom,
          supersedes: current?.version,
        },
      });
      return created;
    });
  }
}

@Controller()
export class RatesController {
  constructor(private readonly service: RatesService) {}

  @Get("rates/plans")
  listPlans(@CurrentAuth() auth: AuthContext, @Query("propertyId") propertyId: string) {
    return this.service.listPlans(auth, propertyId);
  }

  @Post("rates/plans")
  createPlan(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.createPlan(auth, body);
  }

  @Post("rates/calendar")
  setDailyRates(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.setDailyRates(auth, body);
  }

  @Get("rates/calendar")
  calendar(
    @CurrentAuth() auth: AuthContext,
    @Query("ratePlanId") ratePlanId: string,
    @Query("from") from: string,
    @Query("to") to: string
  ) {
    return this.service.calendar(auth, ratePlanId, from, to);
  }

  @Get("rates/quote")
  quote(
    @CurrentAuth() auth: AuthContext,
    @Query("propertyId") propertyId: string,
    @Query("ratePlanId") ratePlanId: string,
    @Query("arrival") arrival: string,
    @Query("departure") departure: string
  ) {
    return this.service.quote(auth, propertyId, ratePlanId, arrival, departure);
  }

  @Get("properties/tax-rules")
  listTaxRules(@CurrentAuth() auth: AuthContext, @Query("propertyId") propertyId: string) {
    return this.service.listTaxRules(auth, propertyId);
  }

  @Post("properties/tax-rules")
  upsertTaxRule(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.upsertTaxRule(auth, body);
  }
}

@Module({
  imports: [PropertiesModule, FoliosModule],
  controllers: [RatesController],
  providers: [RatesService],
})
export class RatesModule {}
