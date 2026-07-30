import {
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import * as argon2 from "argon2";
import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { AuthContext, CurrentAuth, Public } from "../common/auth";
import { AuditService } from "../common/audit.service";
import { RequirePermission } from "../common/permissions.guard";
import { ROLES } from "../common/permissions";
import { PropertiesModule, PropertiesService } from "./properties.module";

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const onboardSchema = z
  .object({
    tenantName: z.string().min(2),
    legalName: z.string().min(2).optional(),
    ownerEmail: z.string().email(),
    ownerFullName: z.string().min(2),
    password: z.string().min(10, "Use at least 10 characters."),
    propertyName: z.string().min(2),
    propertyCode: z.string().min(2).max(12),
    timezone: z.string().default("Africa/Lagos"),
    businessDate: isoDate,
  })
  .strict();

const createPropertySchema = z
  .object({
    name: z.string().min(2),
    code: z.string().min(2).max(12),
    timezone: z.string().default("Africa/Lagos"),
    businessDate: isoDate,
    checkinTime: timeOfDay.default("14:00"),
    checkoutTime: timeOfDay.default("12:00"),
  })
  .strict();

const inviteSchema = z
  .object({
    email: z.string().email(),
    fullName: z.string().min(2),
    role: z.enum(ROLES),
    allProperties: z.boolean().default(true),
    propertyIds: z.array(z.string()).default([]),
  })
  .strict();

const acceptSchema = z
  .object({ token: z.string().min(20), password: z.string().min(10) })
  .strict();

const updateMembershipSchema = z
  .object({
    role: z.enum(ROLES).optional(),
    status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
    allProperties: z.boolean().optional(),
    propertyIds: z.array(z.string()).optional(),
  })
  .strict();

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly properties: PropertiesService
  ) {}

  /**
   * Self-serve onboarding: creates tenant, owner user, owner membership and
   * the first property in one transaction. Public because there is no session
   * yet — protected by the global rate limit.
   */
  async onboard(body: unknown) {
    const dto = onboardSchema.parse(body);

    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.ownerEmail },
    });
    if (existingUser) {
      throw new ConflictException({
        error: {
          code: "EMAIL_IN_USE",
          message: "An account already exists for that email. Sign in instead.",
        },
      });
    }

    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });
    let slug = slugify(dto.tenantName);
    if (await this.prisma.tenant.findUnique({ where: { slug } })) {
      slug = `${slug}-${randomBytes(3).toString("hex")}`;
    }

    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          legalName: dto.legalName ?? dto.tenantName,
          displayName: dto.tenantName,
          slug,
          status: "TRIAL",
        },
      });
      const user = await tx.user.create({
        data: { email: dto.ownerEmail, fullName: dto.ownerFullName, passwordHash },
      });
      await tx.membership.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          role: "TENANT_OWNER",
          allProperties: true,
        },
      });
      const property = await tx.property.create({
        data: {
          tenantId: tenant.id,
          name: dto.propertyName,
          code: dto.propertyCode.toUpperCase(),
          slug: slugify(dto.propertyName),
          timezone: dto.timezone,
          businessDate: dto.businessDate,
        },
      });
      // Audit the creation against the new owner as actor.
      await tx.auditEvent.create({
        data: {
          tenantId: tenant.id,
          propertyId: property.id,
          actorType: "USER",
          actorId: user.id,
          action: "tenant.onboarded",
          entityType: "tenant",
          entityId: tenant.id,
          summary: JSON.stringify({ tenant: tenant.slug, property: property.code }),
        },
      });
      return {
        tenant: { id: tenant.id, slug: tenant.slug, displayName: tenant.displayName },
        property: { id: property.id, code: property.code, name: property.name },
        owner: { id: user.id, email: user.email },
      };
    });
  }

  async createProperty(auth: AuthContext, body: unknown) {
    const dto = createPropertySchema.parse(body);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const property = await tx.property.create({
          data: {
            tenantId: auth.tenantId,
            name: dto.name,
            code: dto.code.toUpperCase(),
            slug: slugify(dto.name),
            timezone: dto.timezone,
            businessDate: dto.businessDate,
            checkinTime: dto.checkinTime,
            checkoutTime: dto.checkoutTime,
          },
        });
        await this.audit.log(tx, auth, {
          action: "property.created",
          entityType: "property",
          entityId: property.id,
          propertyId: property.id,
          summary: { code: property.code, name: property.name },
        });
        return property;
      });
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "P2002") {
        throw new ConflictException({
          error: { code: "PROPERTY_CODE_IN_USE", message: `Property code ${dto.code} already exists.` },
        });
      }
      throw e;
    }
  }

  async listMemberships(auth: AuthContext) {
    const rows = await this.prisma.membership.findMany({
      where: { tenantId: auth.tenantId },
      include: {
        user: { select: { id: true, email: true, fullName: true, lastLoginAt: true, mfaEnabled: true } },
        properties: { select: { propertyId: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((m) => ({
      id: m.id,
      role: m.role,
      status: m.status,
      allProperties: m.allProperties,
      propertyIds: m.properties.map((p) => p.propertyId),
      user: m.user,
    }));
  }

  async invite(auth: AuthContext, body: unknown) {
    const dto = inviteSchema.parse(body);

    // A scoped invitation must name properties the inviter can actually reach.
    if (!dto.allProperties) {
      if (dto.propertyIds.length === 0) {
        throw new ConflictException({
          error: {
            code: "SCOPE_REQUIRED",
            message: "A property-scoped invitation must list at least one property.",
          },
        });
      }
      for (const id of dto.propertyIds) await this.properties.assertProperty(auth, id);
    }

    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      const member = await this.prisma.membership.findFirst({
        where: { tenantId: auth.tenantId, userId: existing.id },
      });
      if (member) {
        throw new ConflictException({
          error: { code: "ALREADY_MEMBER", message: "That person is already a member of this tenant." },
        });
      }
    }

    const token = randomBytes(32).toString("base64url");
    const invitation = await this.prisma.$transaction(async (tx) => {
      const inv = await tx.invitation.create({
        data: {
          tenantId: auth.tenantId,
          email: dto.email,
          fullName: dto.fullName,
          role: dto.role,
          tokenHash: sha256(token),
          allProperties: dto.allProperties,
          propertyIds: JSON.stringify(dto.propertyIds),
          expiresAt: new Date(Date.now() + 7 * 86400_000),
          invitedById: auth.userId,
        },
      });
      await this.audit.log(tx, auth, {
        action: "user.invited",
        entityType: "invitation",
        entityId: inv.id,
        summary: { email: dto.email, role: dto.role, allProperties: dto.allProperties },
      });
      await this.audit.emit(tx, auth.tenantId, {
        aggregateType: "invitation",
        aggregateId: inv.id,
        eventType: "user.invited",
        payload: { email: dto.email, role: dto.role },
      });
      return inv;
    });

    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      // The raw token is returned once. In production the notification worker
      // emails the accept link; there is no way to retrieve it afterwards.
      token,
    };
  }

  async listInvitations(auth: AuthContext, status = "PENDING") {
    return this.prisma.invitation.findMany({
      where: { tenantId: auth.tenantId, ...(status === "ALL" ? {} : { status }) },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, email: true, fullName: true, role: true, status: true,
        allProperties: true, expiresAt: true, createdAt: true, acceptedAt: true,
      },
    });
  }

  async revokeInvitation(auth: AuthContext, id: string) {
    const result = await this.prisma.invitation.updateMany({
      where: { id, tenantId: auth.tenantId, status: "PENDING" },
      data: { status: "REVOKED" },
    });
    if (result.count === 0) {
      throw new NotFoundException({
        error: { code: "INVITATION_NOT_FOUND", message: "No pending invitation with that id." },
      });
    }
    return { revoked: true };
  }

  /** Public: the invitee sets their own password; the token is single-use. */
  async acceptInvitation(body: unknown) {
    const dto = acceptSchema.parse(body);
    const invitation = await this.prisma.invitation.findFirst({
      where: { tokenHash: sha256(dto.token) },
    });
    const invalid = new NotFoundException({
      error: { code: "INVITATION_INVALID", message: "This invitation is invalid or has already been used." },
    });
    if (!invitation || invitation.status !== "PENDING") throw invalid;
    if (invitation.expiresAt < new Date()) {
      await this.prisma.invitation.update({
        where: { id: invitation.id },
        data: { status: "EXPIRED" },
      });
      throw new ConflictException({
        error: { code: "INVITATION_EXPIRED", message: "This invitation has expired. Ask for a new one." },
      });
    }

    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });
    return this.prisma.$transaction(async (tx) => {
      let user = await tx.user.findUnique({ where: { email: invitation.email } });
      if (!user) {
        user = await tx.user.create({
          data: { email: invitation.email, fullName: invitation.fullName, passwordHash },
        });
      }
      const membership = await tx.membership.create({
        data: {
          tenantId: invitation.tenantId,
          userId: user.id,
          role: invitation.role,
          allProperties: invitation.allProperties,
        },
      });
      const propertyIds: string[] = JSON.parse(invitation.propertyIds);
      for (const propertyId of propertyIds) {
        await tx.membershipProperty.create({
          data: { tenantId: invitation.tenantId, membershipId: membership.id, propertyId },
        });
      }
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: "ACCEPTED", acceptedAt: new Date() },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: invitation.tenantId,
          actorType: "USER",
          actorId: user.id,
          action: "user.invitation_accepted",
          entityType: "membership",
          entityId: membership.id,
          summary: JSON.stringify({ email: invitation.email, role: invitation.role }),
        },
      });
      return { userId: user.id, role: membership.role, tenantId: membership.tenantId };
    });
  }

  async updateMembership(auth: AuthContext, id: string, body: unknown) {
    const dto = updateMembershipSchema.parse(body);
    const membership = await this.prisma.membership.findFirst({
      where: { id, tenantId: auth.tenantId },
    });
    if (!membership) {
      throw new NotFoundException({
        error: { code: "MEMBERSHIP_NOT_FOUND", message: "Membership not found." },
      });
    }
    // Guard against a tenant locking itself out of administration.
    if (membership.role === "TENANT_OWNER" && (dto.role || dto.status === "SUSPENDED")) {
      const owners = await this.prisma.membership.count({
        where: { tenantId: auth.tenantId, role: "TENANT_OWNER", status: "ACTIVE" },
      });
      if (owners <= 1) {
        throw new ConflictException({
          error: {
            code: "LAST_OWNER",
            message: "This is the only active tenant owner; promote another owner first.",
          },
        });
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.membership.update({
        where: { id: membership.id },
        data: {
          role: dto.role ?? membership.role,
          status: dto.status ?? membership.status,
          allProperties: dto.allProperties ?? membership.allProperties,
        },
      });
      if (dto.propertyIds) {
        await tx.membershipProperty.deleteMany({ where: { membershipId: membership.id } });
        for (const propertyId of dto.propertyIds) {
          await tx.membershipProperty.create({
            data: { tenantId: auth.tenantId, membershipId: membership.id, propertyId },
          });
        }
      }
      // Changing access must not leave old tokens usable for the old scope.
      if (dto.role || dto.status || dto.allProperties !== undefined || dto.propertyIds) {
        await tx.session.updateMany({
          where: { userId: membership.userId, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: "ACCESS_CHANGED" },
        });
      }
      await this.audit.log(tx, auth, {
        action: "user.membership_updated",
        entityType: "membership",
        entityId: membership.id,
        summary: {
          from: { role: membership.role, status: membership.status },
          to: { role: updated.role, status: updated.status },
          scopeChanged: !!dto.propertyIds || dto.allProperties !== undefined,
        },
      });
      return updated;
    });
  }
}

@Controller()
export class AdminController {
  constructor(private readonly service: AdminService) {}

  @Public()
  @Post("onboarding/tenants")
  onboard(@Body() body: unknown) {
    return this.service.onboard(body);
  }

  @Public()
  @Post("onboarding/invitations/accept")
  accept(@Body() body: unknown) {
    return this.service.acceptInvitation(body);
  }

  @RequirePermission("settings.property.manage")
  @Post("properties")
  createProperty(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.createProperty(auth, body);
  }

  @RequirePermission("user.manage")
  @Get("memberships")
  memberships(@CurrentAuth() auth: AuthContext) {
    return this.service.listMemberships(auth);
  }

  @RequirePermission("user.manage")
  @Patch("memberships/:id")
  updateMembership(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown
  ) {
    return this.service.updateMembership(auth, id, body);
  }

  @RequirePermission("user.manage")
  @Post("invitations")
  invite(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.invite(auth, body);
  }

  @RequirePermission("user.manage")
  @Get("invitations")
  listInvitations(@CurrentAuth() auth: AuthContext, @Query("status") status?: string) {
    return this.service.listInvitations(auth, status);
  }

  @RequirePermission("user.manage")
  @Post("invitations/:id/revoke")
  revokeInvitation(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.revokeInvitation(auth, id);
  }
}

@Module({
  imports: [PropertiesModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
