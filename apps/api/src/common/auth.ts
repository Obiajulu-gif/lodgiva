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
    try {
      req.auth = await this.jwt.verifyAsync<AuthContext>(header.slice(7), {
        secret: process.env.JWT_SECRET,
      });
      return true;
    } catch {
      throw new UnauthorizedException({
        error: { code: "TOKEN_INVALID", message: "Access token expired or invalid." },
      });
    }
  }
}
