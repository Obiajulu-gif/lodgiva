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

/** Claims carried by the 15-minute access token (§6.3). */
export interface AuthContext {
  userId: string;
  email: string;
  tenantId: string;
  role: string;
  allProperties: boolean;
  /** Property ids this membership may touch when allProperties is false. */
  propertyIds: string[];
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
    private readonly reflector: Reflector
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
    if (!claims.userId || !claims.tenantId || !claims.role) {
      throw new UnauthorizedException({
        error: {
          code: "TOKEN_INCOMPLETE",
          message: "Access token is missing required claims.",
        },
      });
    }

    req.auth = claims as AuthContext;
    return true;
  }
}
