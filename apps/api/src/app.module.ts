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
import { JwtModule } from "@nestjs/jwt";
import { ZodError } from "zod";
import { PrismaService } from "./prisma.service";
import { AuthGuard, Public } from "./common/auth";
import { PermissionsGuard } from "./common/permissions.guard";
import { AuditService } from "./common/audit.service";
import { AdminModule } from "./modules/admin.module";
import { ConfigModule } from "./modules/config.module";
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
    { provide: APP_FILTER, useClass: ZodExceptionFilter },
  ],
})
export class AppModule {}
