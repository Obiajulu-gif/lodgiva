import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthContext } from "./auth";
import { Permission, roleHasPermission } from "./permissions";

export const REQUIRED_PERMISSION = "requiredPermission";

/** Declare the permission a route requires. Enforced by PermissionsGuard. */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(REQUIRED_PERMISSION, permission);

/**
 * Runs after AuthGuard, so req.auth is populated. Routes without a declared
 * permission are allowed (they are still authenticated) — permissions gate
 * *actions*, while tenant scoping gates *data* and is enforced separately in
 * the services.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission | undefined>(
      REQUIRED_PERMISSION,
      [ctx.getHandler(), ctx.getClass()]
    );
    if (!required) return true;

    const req = ctx.switchToHttp().getRequest();
    const auth: AuthContext | undefined = req.auth;
    if (!auth) return false; // AuthGuard rejects first; defensive only.

    if (!roleHasPermission(auth.role, required)) {
      throw new ForbiddenException({
        error: {
          code: "PERMISSION_DENIED",
          message: `Your role (${auth.role}) does not have permission to ${required}.`,
          retryable: false,
          details: { requiredPermission: required, role: auth.role },
        },
      });
    }
    return true;
  }
}
