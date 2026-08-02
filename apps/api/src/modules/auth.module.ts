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
import {
  generateRecoveryCodes,
  generateSecret,
  normaliseRecoveryCode,
  otpauthUri,
  verifyTotp,
} from "../common/totp";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({ refreshToken: z.string().min(20) });

const mfaVerifySchema = z
  .object({
    mfaToken: z.string().min(20),
    // Either a 6-digit authenticator code or a recovery code.
    code: z.string().min(6).max(20),
  })
  .strict();

const mfaActivateSchema = z.object({ code: z.string().min(6).max(10) }).strict();
const mfaDisableSchema = z.object({ password: z.string().min(1) }).strict();

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

    // 6.3 second factor. The password is correct at this point, so the
    // response says what is missing rather than pretending the credentials
    // were wrong - an honest challenge is not a leak, because whoever is
    // holding this password already has it.
    const gate = await this.mfaGate(user.id);
    if (gate) return gate;

    return this.issueTokens(user.id);
  }

  /**
   * Decides whether a user who has proved their password may hold a session.
   *
   * Two distinct outcomes, because they need two different things from the
   * person in front of the screen: an enrolled user must produce a code; a
   * user whose role now requires MFA but has never enrolled must set it up
   * first. Collapsing them into one error leaves the second group stuck with
   * no stated way forward.
   */
  private async mfaGate(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { memberships: { where: { status: "ACTIVE" }, include: { tenant: true } } },
    });
    const membership = user.memberships[0];

    if (user.mfaEnabled && user.mfaSecret) {
      // Short-lived and single-purpose: this token can do nothing except be
      // exchanged for a session alongside a valid code.
      const mfaToken = await this.jwt.signAsync(
        { sub: user.id, purpose: "mfa" },
        { secret: process.env.JWT_SECRET, expiresIn: "5m" }
      );
      return {
        status: "MFA_REQUIRED" as const,
        mfaToken,
        message: "Enter the 6-digit code from your authenticator app.",
      };
    }

    if (membership) {
      const required = this.requiredRoles(membership.tenant.mfaRequiredRoles);
      if (required.includes(membership.role)) {
        const setupToken = await this.jwt.signAsync(
          { sub: user.id, purpose: "mfa_enrol" },
          { secret: process.env.JWT_SECRET, expiresIn: "15m" }
        );
        return {
          status: "MFA_ENROLMENT_REQUIRED" as const,
          setupToken,
          role: membership.role,
          message: `Your role (${membership.role}) requires two-factor authentication. Set it up to continue.`,
        };
      }
    }
    return null;
  }

  private requiredRoles(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((r) => typeof r === "string") : [];
    } catch {
      // A malformed policy must not silently read as "MFA off", but it also
      // must not lock every owner out of their own hotel. Empty is the
      // recoverable failure; the config endpoint validates on write so this
      // path means someone edited the database by hand.
      return [];
    }
  }

  /** Exchanges the challenge token plus a code for a real session. */
  async mfaVerify(body: unknown) {
    const dto = mfaVerifySchema.parse(body);
    const invalid = new UnauthorizedException({
      error: {
        code: "INVALID_MFA_CODE",
        message: "That code is not valid. Check the clock on your phone and try again.",
      },
    });

    let payload: { sub: string; purpose: string };
    try {
      payload = await this.jwt.verifyAsync(dto.mfaToken, { secret: process.env.JWT_SECRET });
    } catch {
      throw new UnauthorizedException({
        error: {
          code: "MFA_CHALLENGE_EXPIRED",
          message: "This sign-in attempt expired. Start again.",
        },
      });
    }
    if (payload.purpose !== "mfa") throw invalid;

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.mfaSecret || user.status !== "ACTIVE") throw invalid;

    if (verifyTotp(user.mfaSecret, dto.code)) {
      return this.issueTokens(user.id);
    }

    // Recovery codes are single use: an unconsumed one is a permanent
    // password that bypasses the second factor entirely.
    const stored: string[] = JSON.parse(user.mfaRecoveryCodes);
    const submitted = normaliseRecoveryCode(dto.code);
    for (const hash of stored) {
      if (await argon2.verify(hash, submitted).catch(() => false)) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { mfaRecoveryCodes: JSON.stringify(stored.filter((h) => h !== hash)) },
        });
        const tokens = await this.issueTokens(user.id);
        return {
          ...tokens,
          usedRecoveryCode: true,
          recoveryCodesRemaining: stored.length - 1,
          message:
            "Signed in with a recovery code. That code is now used up - generate new ones if you are running low.",
        };
      }
    }
    throw invalid;
  }

  /**
   * Step one of enrolment: hand back a secret and the URI to scan. Nothing is
   * enabled yet, so an abandoned setup cannot lock anyone out.
   */
  async mfaSetup(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.mfaEnabled) {
      throw new UnauthorizedException({
        error: {
          code: "MFA_ALREADY_ENABLED",
          message: "Two-factor authentication is already on for this account.",
        },
      });
    }
    const secret = generateSecret();
    await this.prisma.user.update({ where: { id: userId }, data: { mfaSecret: secret } });
    return {
      secret,
      otpauthUri: otpauthUri({ secret, accountName: user.email }),
      message: "Scan this in your authenticator app, then confirm with the code it shows.",
    };
  }

  /**
   * Step two: the user proves they can read a code from the secret before it
   * becomes required. Recovery codes are returned once, in clear, and kept
   * only as hashes - a database dump must not be a set of working keys.
   */
  async mfaActivate(userId: string, body: unknown) {
    const dto = mfaActivateSchema.parse(body);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.mfaSecret) {
      throw new UnauthorizedException({
        error: { code: "MFA_NOT_STARTED", message: "Start setup before confirming a code." },
      });
    }
    if (!verifyTotp(user.mfaSecret, dto.code)) {
      throw new UnauthorizedException({
        error: {
          code: "INVALID_MFA_CODE",
          message:
            "That code is not valid. If your phone clock is more than a minute out, fix it and try again.",
        },
      });
    }
    const codes = generateRecoveryCodes();
    const hashes = await Promise.all(
      codes.map((c) => argon2.hash(normaliseRecoveryCode(c), { type: argon2.argon2id }))
    );
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        mfaEnabled: true,
        mfaActivatedAt: new Date(),
        mfaRecoveryCodes: JSON.stringify(hashes),
      },
    });
    return {
      enabled: true,
      recoveryCodes: codes,
      message:
        "Two-factor authentication is on. Store these recovery codes somewhere safe - they are shown once.",
    };
  }

  /** Turning MFA off re-proves the password: a hijacked session must not. */
  async mfaDisable(auth: AuthContext, body: unknown) {
    const dto = mfaDisableSchema.parse(body);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!(await argon2.verify(user.passwordHash, dto.password).catch(() => false))) {
      throw new UnauthorizedException({
        error: { code: "INVALID_CREDENTIALS", message: "Password is incorrect." },
      });
    }
    const membership = await this.prisma.membership.findFirst({
      where: { userId: auth.userId, status: "ACTIVE" },
      include: { tenant: true },
    });
    if (
      membership &&
      this.requiredRoles(membership.tenant.mfaRequiredRoles).includes(membership.role)
    ) {
      throw new UnauthorizedException({
        error: {
          code: "MFA_REQUIRED_BY_POLICY",
          message: `Two-factor authentication is mandatory for ${membership.role}. Ask an owner to change the policy first.`,
        },
      });
    }
    await this.prisma.user.update({
      where: { id: auth.userId },
      data: { mfaEnabled: false, mfaSecret: null, mfaActivatedAt: null, mfaRecoveryCodes: "[]" },
    });
    return { enabled: false };
  }

  async mfaStatus(auth: AuthContext) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    const membership = await this.prisma.membership.findFirst({
      where: { userId: auth.userId, status: "ACTIVE" },
      include: { tenant: true },
    });
    const required = membership
      ? this.requiredRoles(membership.tenant.mfaRequiredRoles).includes(membership.role)
      : false;
    return {
      enabled: user.mfaEnabled,
      activatedAt: user.mfaActivatedAt,
      requiredByPolicy: required,
      recoveryCodesRemaining: (JSON.parse(user.mfaRecoveryCodes) as string[]).length,
    };
  }

  private async subjectFromEnrolToken(setupToken: string): Promise<string> {
    const payload = await this.jwt
      .verifyAsync(setupToken, { secret: process.env.JWT_SECRET })
      .catch(() => null);
    if (!payload || payload.purpose !== "mfa_enrol") {
      throw new UnauthorizedException({
        error: {
          code: "MFA_CHALLENGE_EXPIRED",
          message: "This enrolment attempt expired. Sign in again.",
        },
      });
    }
    return payload.sub as string;
  }

  /** Enrolment driven from a setup token, for a user gated at login. */
  async mfaSetupWithToken(setupToken: string) {
    return this.mfaSetup(await this.subjectFromEnrolToken(setupToken));
  }

  async mfaActivateWithToken(setupToken: string, body: unknown) {
    const userId = await this.subjectFromEnrolToken(setupToken);
    const result = await this.mfaActivate(userId, body);
    // Enrolment completes the sign-in it interrupted, so nobody is asked for a
    // code seconds after proving they can produce one.
    const tokens = await this.issueTokens(userId);
    return { ...result, ...tokens };
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

  // ── §6.3 Multi-factor authentication ───────────────────────────────────
  // The verify and enrol routes are public because the caller has not got a
  // session yet — that is the entire point of the challenge. Each one carries
  // its own single-purpose, short-lived token instead.

  @Public()
  @Post("mfa/verify")
  mfaVerify(@Body() body: unknown) {
    return this.service.mfaVerify(body);
  }

  @Public()
  @Post("mfa/enrol/setup")
  mfaEnrolSetup(@Body() body: { setupToken?: string }) {
    return this.service.mfaSetupWithToken(String(body?.setupToken ?? ""));
  }

  @Public()
  @Post("mfa/enrol/activate")
  mfaEnrolActivate(@Body() body: { setupToken?: string; code?: string }) {
    return this.service.mfaActivateWithToken(String(body?.setupToken ?? ""), {
      code: String(body?.code ?? ""),
    });
  }

  @Get("mfa")
  mfaStatus(@CurrentAuth() auth: AuthContext) {
    return this.service.mfaStatus(auth);
  }

  @Post("mfa/setup")
  mfaSetup(@CurrentAuth() auth: AuthContext) {
    return this.service.mfaSetup(auth.userId);
  }

  @Post("mfa/activate")
  mfaActivate(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.mfaActivate(auth.userId, body);
  }

  @Post("mfa/disable")
  mfaDisable(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.mfaDisable(auth, body);
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
