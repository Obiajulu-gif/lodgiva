import {
  Body,
  Controller,
  Get,
  Module,
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
      include: { memberships: { where: { status: "ACTIVE" } } },
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

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    const invalid = new UnauthorizedException({
      error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect." },
    });
    if (!user || user.status !== "ACTIVE") throw invalid;
    const ok = await argon2.verify(user.passwordHash, password);
    if (!ok) throw invalid;
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    return this.issueTokens(user.id);
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
    const properties = await this.prisma.property.findMany({
      where: { tenantId: auth.tenantId, status: "ACTIVE" },
      select: { id: true, name: true, code: true, businessDate: true, timezone: true },
    });
    return { user, tenant, role: auth.role, properties };
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
}

@Module({
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
