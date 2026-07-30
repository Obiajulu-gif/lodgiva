import {
  Body,
  Controller,
  Delete,
  Get,
  Module,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { AuthContext, CurrentAuth, Public } from "../common/auth";
import { permissionsForRole } from "../common/permissions";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({ refreshToken: z.string().min(20) });

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService
  ) {}

  private async issueTokens(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        memberships: {
          where: { status: "ACTIVE" },
          include: { properties: { select: { propertyId: true } } },
        },
      },
    });
    const membership = user.memberships[0];
    if (!membership) {
      throw new UnauthorizedException({
        error: { code: "NO_MEMBERSHIP", message: "User has no active tenant membership." },
      });
    }
    const claims: AuthContext = {
      userId: user.id,
      email: user.email,
      tenantId: membership.tenantId,
      role: membership.role,
      allProperties: membership.allProperties,
      propertyIds: membership.properties.map((p) => p.propertyId),
    };
    const accessToken = await this.jwt.signAsync(claims, {
      secret: process.env.JWT_SECRET,
      expiresIn: "15m",
    });
    // Opaque rotating refresh token stored as a hash (§6.3).
    const refreshToken = randomBytes(48).toString("base64url");
    await this.prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + 30 * 86400_000),
      },
    });
    return { accessToken, refreshToken, claims };
  }

  /**
   * §6.3 — progressive delay rather than permanent lock: a front desk locked
   * out during check-in rush is worse than a slow attacker. Delay grows with
   * consecutive failures and resets on success.
   */
  private lockoutSeconds(failures: number): number {
    if (failures < 3) return 0;
    return Math.min(2 ** (failures - 2) * 5, 300); // 5s, 10s, 20s … capped at 5m
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    const invalid = new UnauthorizedException({
      error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect." },
    });
    // Always verify against a hash so a missing account and a wrong password
    // take comparable time (no user enumeration by timing).
    if (!user || user.status !== "ACTIVE") {
      await argon2.hash(password, { type: argon2.argon2id }).catch(() => undefined);
      throw invalid;
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const retryAfter = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      throw new UnauthorizedException({
        error: {
          code: "ACCOUNT_TEMPORARILY_LOCKED",
          message: `Too many failed attempts. Try again in ${retryAfter}s.`,
          retryable: true,
          details: { retryAfterSeconds: retryAfter },
        },
      });
    }

    const ok = await argon2.verify(user.passwordHash, password);
    if (!ok) {
      const failures = user.failedLoginCount + 1;
      const delay = this.lockoutSeconds(failures);
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: failures,
          lockedUntil: delay > 0 ? new Date(Date.now() + delay * 1000) : null,
        },
      });
      throw invalid;
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
    });
    return this.issueTokens(user.id);
  }

  /** §6.3 device/session management. */
  async sessions(auth: AuthContext) {
    const rows = await this.prisma.session.findMany({
      where: { userId: auth.userId },
      orderBy: { lastActivityAt: "desc" },
      take: 50,
      select: {
        id: true, createdAt: true, lastActivityAt: true, expiresAt: true,
        revokedAt: true, revokedReason: true, userAgent: true,
      },
    });
    return rows.map((s) => ({ ...s, active: !s.revokedAt && s.expiresAt > new Date() }));
  }

  async revokeSession(auth: AuthContext, sessionId: string) {
    const result = await this.prisma.session.updateMany({
      where: { id: sessionId, userId: auth.userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: "USER_REVOKED" },
    });
    if (result.count === 0) {
      throw new NotFoundException({
        error: { code: "SESSION_NOT_FOUND", message: "No active session with that id." },
      });
    }
    return { revoked: result.count };
  }

  async revokeAllSessions(auth: AuthContext) {
    const result = await this.prisma.session.updateMany({
      where: { userId: auth.userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: "USER_REVOKED_ALL" },
    });
    return { revoked: result.count };
  }

  async refresh(refreshToken: string) {
    const session = await this.prisma.session.findFirst({
      where: {
        refreshTokenHash: sha256(refreshToken),
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!session) {
      throw new UnauthorizedException({
        error: { code: "SESSION_INVALID", message: "Refresh token is invalid or revoked." },
      });
    }
    // Rotation: revoke the used session and issue a fresh pair.
    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
    return this.issueTokens(session.userId);
  }

  async logout(refreshToken: string) {
    await this.prisma.session.updateMany({
      where: { refreshTokenHash: sha256(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }

  async me(auth: AuthContext) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { id: true, email: true, fullName: true, lastLoginAt: true },
    });
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: auth.tenantId },
      select: { id: true, displayName: true, slug: true, defaultCurrency: true },
    });
    // Scoped memberships only see the properties they are assigned to.
    const properties = await this.prisma.property.findMany({
      where: {
        tenantId: auth.tenantId,
        status: "ACTIVE",
        ...(auth.allProperties ? {} : { id: { in: auth.propertyIds } }),
      },
      select: { id: true, name: true, code: true, businessDate: true, timezone: true },
    });
    return {
      user,
      tenant,
      role: auth.role,
      permissions: permissionsForRole(auth.role),
      allProperties: auth.allProperties,
      properties,
    };
  }
}

@Controller("auth")
export class AuthController {
  constructor(private readonly service: AuthService) {}

  @Public()
  @Post("login")
  login(@Body() body: unknown) {
    const dto = loginSchema.parse(body);
    return this.service.login(dto.email, dto.password);
  }

  @Public()
  @Post("refresh")
  refresh(@Body() body: unknown) {
    const dto = refreshSchema.parse(body);
    return this.service.refresh(dto.refreshToken);
  }

  @Post("logout")
  logout(@Body() body: unknown) {
    const dto = refreshSchema.parse(body);
    return this.service.logout(dto.refreshToken);
  }

  @Get("me")
  me(@CurrentAuth() auth: AuthContext) {
    return this.service.me(auth);
  }

  @Get("sessions")
  sessions(@CurrentAuth() auth: AuthContext) {
    return this.service.sessions(auth);
  }

  @Delete("sessions/:id")
  revokeSession(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.revokeSession(auth, id);
  }

  @Delete("sessions")
  revokeAll(@CurrentAuth() auth: AuthContext) {
    return this.service.revokeAllSessions(auth);
  }
}

@Module({
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
