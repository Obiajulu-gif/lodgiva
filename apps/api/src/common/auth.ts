import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Reflector } from "@nestjs/core";
import { PrismaService } from "../prisma.service";

/** Claims carried by the 15-minute access token (§6.3). */
export interface AuthContext {
  userId: string;
  email: string;
  tenantId: string;
  role: string;
  allProperties: boolean;
  /** Property ids this membership may touch when allProperties is false. */
  propertyIds: string[];
  /** Server-side session bound to this access token. */
  sessionId: string;
}

export const IS_PUBLIC = "isPublic";
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const CurrentAuth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext => {
    return ctx.switchToHttp().getRequest().auth;
  }
);

/**
 * Global guard: every route requires a valid access token unless @Public().
 * The tenant identifier is ALWAYS taken from the verified token, never from
 * the request body (§6.2 rule 2).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers?.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException({
        error: { code: "UNAUTHENTICATED", message: "Missing access token." },
      });
    }
    let claims: Partial<AuthContext> & { purpose?: string };
    try {
      claims = await this.jwt.verifyAsync(header.slice(7), {
        secret: process.env.JWT_SECRET,
      });
    } catch {
      throw new UnauthorizedException({
        error: { code: "TOKEN_INVALID", message: "Access token expired or invalid." },
      });
    }

    /**
     * A valid signature is not the same as a valid access token.
     *
     * The MFA challenge and enrolment tokens are signed with this same secret,
     * and they deliberately carry no tenant or role. Accepting one here would
     * set `auth.tenantId` to undefined — and every `where: { tenantId }` in the
     * codebase then silently becomes an unfiltered query across every tenant.
     * So the claim set is checked, not just the signature, and any token
     * carrying a `purpose` is refused outright: those exist to be exchanged at
     * one specific endpoint, never to authorise a request.
     */
    if (claims.purpose) {
      throw new UnauthorizedException({
        error: {
          code: "TOKEN_NOT_AN_ACCESS_TOKEN",
          message: `This is a ${claims.purpose} token. Exchange it for a session first.`,
        },
      });
    }
    if (!claims.userId || !claims.tenantId || !claims.role || !claims.sessionId) {
      throw new UnauthorizedException({
        error: {
          code: "TOKEN_INCOMPLETE",
          message: "Access token is missing required claims.",
        },
      });
    }

    // A signature proves who issued the token, not that the account is still
    // allowed to act. Re-check mutable security state on every request so a
    // logout, suspension, role change, or membership revocation takes effect
    // immediately rather than waiting for the 15-minute JWT to expire.
    const session = await this.prisma.session.findFirst({
      where: {
        id: claims.sessionId,
        userId: claims.userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        user: { status: "ACTIVE" },
      },
    });
    const membership = await this.prisma.membership.findFirst({
      where: {
        userId: claims.userId,
        tenantId: claims.tenantId,
        status: "ACTIVE",
        tenant: { status: { in: ["ACTIVE", "TRIAL"] } },
      },
      include: { properties: { select: { propertyId: true } } },
    });
    if (!session || !membership || membership.role !== claims.role) {
      throw new UnauthorizedException({
        error: { code: "SESSION_REVOKED", message: "This session is no longer active." },
      });
    }
    claims.allProperties = membership.allProperties;
    claims.propertyIds = membership.properties.map((property) => property.propertyId);

    req.auth = claims as AuthContext;
    return true;
  }
}
