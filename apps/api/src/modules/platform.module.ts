import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { AuthContext, CurrentAuth, Public } from "../common/auth";
import { AuditService } from "../common/audit.service";
import { ROLES, roleHasPermission } from "../common/permissions";

const securityPolicySchema = z
  .object({
    mfaRequiredRoles: z.array(z.enum(ROLES as unknown as [string, ...string[]])),
  })
  .strict();

const flagSchema = z
  .object({
    key: z
      .string()
      .min(3)
      .max(60)
      // Kebab-case only, so a flag cannot be created twice under two spellings
      // and then read as two different flags.
      .regex(/^[a-z][a-z0-9-]*$/, "Use lower-case kebab-case, e.g. pos-void-approvals."),
    description: z.string().min(5),
    enabled: z.boolean().default(false),
  })
  .strict();

const flagUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    description: z.string().min(5).optional(),
    /** tenantId -> boolean. Explicit null removes the override. */
    overrides: z.record(z.string(), z.boolean().nullable()).optional(),
  })
  .strict();

/**
 * §12.3 Feature flags.
 *
 * Rollout state lives in the database, not in environment variables, because
 * the mitigation for "the new thing is breaking checkout" has to be faster
 * than a redeploy. Reads are cached for a few seconds: a flag check sits on
 * hot paths, and a database round trip per request would make the safety
 * mechanism the bottleneck.
 */
@Injectable()
export class FeatureFlagService {
  private cache = new Map<string, { enabled: boolean; overrides: Record<string, boolean> }>();
  private cachedAt = 0;
  private static readonly TTL_MS = 5_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  private async load() {
    if (Date.now() - this.cachedAt < FeatureFlagService.TTL_MS && this.cache.size) return;
    const flags = await this.prisma.featureFlag.findMany();
    this.cache = new Map(
      flags.map((f) => [
        f.key,
        { enabled: f.enabled, overrides: JSON.parse(f.overrides) as Record<string, boolean> },
      ])
    );
    this.cachedAt = Date.now();
  }

  /** Forces the next read to hit the database — used after a write. */
  invalidate() {
    this.cachedAt = 0;
  }

  /**
   * An unknown flag is OFF. A typo in a flag name must not switch a feature on
   * for everyone; failing closed makes the mistake visible instead.
   */
  async isEnabled(key: string, tenantId?: string): Promise<boolean> {
    await this.load();
    const flag = this.cache.get(key);
    if (!flag) return false;
    if (tenantId && tenantId in flag.overrides) return flag.overrides[tenantId];
    return flag.enabled;
  }

  /** Every flag as this tenant sees it, for the client to branch on. */
  async evaluateAll(tenantId: string) {
    await this.load();
    const out: Record<string, boolean> = {};
    for (const [key, flag] of this.cache) {
      out[key] = tenantId in flag.overrides ? flag.overrides[tenantId] : flag.enabled;
    }
    return out;
  }

  async list() {
    const flags = await this.prisma.featureFlag.findMany({ orderBy: { key: "asc" } });
    return flags.map((f) => ({
      key: f.key,
      description: f.description,
      enabled: f.enabled,
      overrides: JSON.parse(f.overrides) as Record<string, boolean>,
      updatedAt: f.updatedAt,
    }));
  }

  async create(auth: AuthContext, body: unknown) {
    const dto = flagSchema.parse(body);
    const existing = await this.prisma.featureFlag.findUnique({ where: { key: dto.key } });
    if (existing) {
      throw new BadRequestException({
        error: { code: "FLAG_EXISTS", message: `Flag ${dto.key} already exists.` },
      });
    }
    const flag = await this.prisma.featureFlag.create({
      data: {
        key: dto.key,
        description: dto.description,
        enabled: dto.enabled,
        updatedById: auth.userId,
      },
    });
    this.invalidate();
    await this.audit.log(this.prisma, auth, {
      action: "flag.created",
      entityType: "feature_flag",
      entityId: flag.key,
      summary: { enabled: dto.enabled },
    });
    return flag;
  }

  async update(auth: AuthContext, key: string, body: unknown) {
    const dto = flagUpdateSchema.parse(body);
    const flag = await this.prisma.featureFlag.findUnique({ where: { key } });
    if (!flag) {
      throw new NotFoundException({
        error: { code: "FLAG_NOT_FOUND", message: `No flag named ${key}.` },
      });
    }

    const overrides = JSON.parse(flag.overrides) as Record<string, boolean>;
    for (const [tenantId, value] of Object.entries(dto.overrides ?? {})) {
      if (value === null) delete overrides[tenantId];
      else overrides[tenantId] = value;
    }

    const updated = await this.prisma.featureFlag.update({
      where: { key },
      data: {
        ...(dto.enabled === undefined ? {} : { enabled: dto.enabled }),
        ...(dto.description ? { description: dto.description } : {}),
        overrides: JSON.stringify(overrides),
        updatedById: auth.userId,
      },
    });
    this.invalidate();
    // Flag changes are audited like configuration, because "what changed just
    // before it broke" is the first question of every incident.
    await this.audit.log(this.prisma, auth, {
      action: "flag.updated",
      entityType: "feature_flag",
      entityId: key,
      summary: { enabled: updated.enabled, overrides: Object.keys(overrides).length },
    });
    return updated;
  }
}

/** §6.3 tenant-wide security policy. */
@Injectable()
export class SecurityPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  private assertOwner(auth: AuthContext) {
    if (!roleHasPermission(auth.role, "user.manage")) {
      throw new ForbiddenException({
        error: {
          code: "PERMISSION_DENIED",
          message: `Your role (${auth.role}) cannot change the security policy.`,
          details: { requiredPermission: "user.manage" },
        },
      });
    }
  }

  async get(auth: AuthContext) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: auth.tenantId } });
    const roles = JSON.parse(tenant.mfaRequiredRoles) as string[];
    const enrolled = await this.prisma.user.count({
      where: { mfaEnabled: true, memberships: { some: { tenantId: auth.tenantId, status: "ACTIVE" } } },
    });
    const total = await this.prisma.membership.count({
      where: { tenantId: auth.tenantId, status: "ACTIVE" },
    });
    return { mfaRequiredRoles: roles, enrolledUsers: enrolled, activeUsers: total };
  }

  async set(auth: AuthContext, body: unknown) {
    this.assertOwner(auth);
    const dto = securityPolicySchema.parse(body);

    // Requiring MFA of a role nobody in the tenant can currently satisfy is
    // allowed — they are prompted to enrol at next sign-in, not locked out —
    // but the caller is told how many people it will interrupt, because that
    // is the difference between a policy change and an outage.
    const affected = await this.prisma.membership.count({
      where: {
        tenantId: auth.tenantId,
        status: "ACTIVE",
        role: { in: dto.mfaRequiredRoles },
        user: { mfaEnabled: false },
      },
    });

    const tenant = await this.prisma.tenant.update({
      where: { id: auth.tenantId },
      data: { mfaRequiredRoles: JSON.stringify(dto.mfaRequiredRoles) },
    });
    await this.audit.log(this.prisma, auth, {
      action: "security.policy_updated",
      entityType: "tenant",
      entityId: tenant.id,
      summary: { mfaRequiredRoles: dto.mfaRequiredRoles, usersPromptedAtNextLogin: affected },
    });
    return {
      mfaRequiredRoles: dto.mfaRequiredRoles,
      usersPromptedAtNextLogin: affected,
      message: affected
        ? `${affected} user(s) will be asked to set up two-factor authentication at their next sign-in.`
        : "Everyone in the affected roles is already enrolled.",
    };
  }
}

@Controller()
export class PlatformController {
  constructor(
    private readonly flags: FeatureFlagService,
    private readonly policy: SecurityPolicyService
  ) {}

  @Get("security-policy")
  getPolicy(@CurrentAuth() auth: AuthContext) {
    return this.policy.get(auth);
  }

  @Put("security-policy")
  setPolicy(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.policy.set(auth, body);
  }

  /** What this tenant's clients should branch on. */
  @Get("feature-flags")
  myFlags(@CurrentAuth() auth: AuthContext) {
    return this.flags.evaluateAll(auth.tenantId);
  }

  @Get("admin/feature-flags")
  list(@CurrentAuth() auth: AuthContext) {
    this.assertPlatformAdmin(auth);
    return this.flags.list();
  }

  @Post("admin/feature-flags")
  create(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    this.assertPlatformAdmin(auth);
    return this.flags.create(auth, body);
  }

  @Put("admin/feature-flags/:key")
  update(@CurrentAuth() auth: AuthContext, @Param("key") key: string, @Body() body: unknown) {
    this.assertPlatformAdmin(auth);
    return this.flags.update(auth, key, body);
  }

  private assertPlatformAdmin(auth: AuthContext) {
    // Flags are cross-tenant, so they sit behind the highest role rather than
    // any per-property permission.
    if (auth.role !== "TENANT_OWNER") {
      throw new ForbiddenException({
        error: {
          code: "PERMISSION_DENIED",
          message: "Feature flags are managed by the account owner.",
        },
      });
    }
  }
}

@Module({
  controllers: [PlatformController],
  providers: [FeatureFlagService, SecurityPolicyService],
  exports: [FeatureFlagService],
})
export class PlatformModule {}
