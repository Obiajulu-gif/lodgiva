import {
  ArgumentsHost,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  Global,
  Module,
} from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { JwtModule } from "@nestjs/jwt";
import { ZodError } from "zod";
import { PrismaService } from "./prisma.service";
import { AuthGuard, Public } from "./common/auth";
import { PermissionsGuard } from "./common/permissions.guard";
import { AuditService } from "./common/audit.service";
import { AdminModule } from "./modules/admin.module";
import { ConfigModule } from "./modules/config.module";
import { BookingModule } from "./modules/booking.module";
import { FrontDeskModule } from "./modules/front-desk.module";
import { InvoicesModule } from "./modules/invoices.module";
import { GatewayModule } from "./modules/gateway.module";
import { AuthModule } from "./modules/auth.module";
import { PropertiesModule } from "./modules/properties.module";
import { GuestsModule } from "./modules/guests.module";
import { ReservationsModule } from "./modules/reservations.module";
import { FoliosModule } from "./modules/folios.module";
import { PaymentsModule } from "./modules/payments.module";
import { HousekeepingModule } from "./modules/housekeeping.module";
import { NightAuditModule } from "./modules/night-audit.module";
import { ReportsModule } from "./modules/reports.module";
import { PosModule } from "./modules/pos.module";
import { CashieringModule } from "./modules/cashiering.module";
import { MaintenanceModule } from "./modules/maintenance.module";
import { RatesModule } from "./modules/rates.module";
import { SyncModule } from "./modules/sync.module";
import { ApprovalsModule } from "./modules/approvals.module";

/** §9.1 — stable error contract with field-level validation errors. */
/**
 * Database contention that survived retries is a temporary condition, not a
 * bug in the caller's request. Returning a typed 503 lets a client back off
 * instead of showing "internal server error" to a front desk.
 */
// Scoped to Prisma errors only. A catch-all filter would also intercept the
// structured HttpExceptions the services raise and flatten their bodies.
@Catch(
  Prisma.PrismaClientKnownRequestError,
  Prisma.PrismaClientUnknownRequestError,
  Prisma.PrismaClientInitializationError
)
class TransientDbExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("Database");

  catch(exception: Error & { code?: string }, host: ArgumentsHost) {
    const message = exception.message ?? "";
    const transient =
      ["P2024", "P2034", "P1008", "P1017"].includes(exception.code ?? "") ||
      /socket timeout|database is locked|SQLITE_BUSY/i.test(message);

    const reply = host.switchToHttp().getResponse();
    if (transient) {
      this.logger.warn(`Transient database contention: ${exception.code ?? "timeout"}`);
      reply.status(503).send({
        error: {
          code: "RESOURCE_BUSY",
          message: "The system is busy processing other bookings. Please retry.",
          retryable: true,
        },
      });
      return;
    }

    // Anything else is a genuine fault: log it server-side, return a stable
    // shape, and never leak query text or column names to the client.
    this.logger.error(`Unhandled database error ${exception.code ?? ""}: ${message}`);
    reply.status(500).send({
      error: {
        code: "DATABASE_ERROR",
        message: "The request could not be completed.",
        retryable: false,
      },
    });
  }
}

@Catch(ZodError)
class ZodExceptionFilter implements ExceptionFilter {
  catch(exception: ZodError, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse();
    reply.status(400).send({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed.",
        retryable: false,
        details: exception.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
    });
  }
}

@Controller("health")
class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Public()
  @Get("ready")
  async ready() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: "ready" };
  }
}

@Global()
@Module({
  providers: [PrismaService, AuditService],
  exports: [PrismaService, AuditService],
})
class CoreModule {}

@Module({
  imports: [
    CoreModule,
    JwtModule.register({ global: true }),
    AuthModule,
    AdminModule,
    ConfigModule,
    BookingModule,
    FrontDeskModule,
    InvoicesModule,
    GatewayModule,
    PropertiesModule,
    GuestsModule,
    ReservationsModule,
    FoliosModule,
    PaymentsModule,
    HousekeepingModule,
    PosModule,
    CashieringModule,
    MaintenanceModule,
    RatesModule,
    SyncModule,
    ApprovalsModule,
    NightAuditModule,
    ReportsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: authenticate, then authorise.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // Registered first so it is the outermost filter; Zod stays more specific.
    { provide: APP_FILTER, useClass: TransientDbExceptionFilter },
    { provide: APP_FILTER, useClass: ZodExceptionFilter },
  ],
})
export class AppModule {}
