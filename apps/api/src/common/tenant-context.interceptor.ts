import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { lastValueFrom, Observable } from "rxjs";
import { AuthContext } from "./auth";
import { PrismaService } from "../prisma.service";

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const auth = context.switchToHttp().getRequest<{ auth?: AuthContext }>().auth;
    if (!auth?.tenantId) return next.handle();
    return new Observable((subscriber) => {
      this.prisma
        .runWithTenant(auth.tenantId, () => lastValueFrom(next.handle()))
        .then((value) => {
          subscriber.next(value);
          subscriber.complete();
        })
        .catch((error) => subscriber.error(error));
    });
  }
}
