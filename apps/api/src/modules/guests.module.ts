import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { AuthContext, CurrentAuth } from "../common/auth";
import { AuditService } from "../common/audit.service";

const createGuestSchema = z
  .object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    nationality: z.string().optional(),
    notes: z.string().optional(),
    vip: z.boolean().optional(),
  })
  .strict(); // §9.1: reject unknown fields on write DTOs

@Injectable()
export class GuestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  search(auth: AuthContext, q?: string) {
    return this.prisma.guest.findMany({
      where: {
        tenantId: auth.tenantId,
        ...(q
          ? {
              OR: [
                { firstName: { contains: q } },
                { lastName: { contains: q } },
                { phone: { contains: q } },
                { email: { contains: q } },
              ],
            }
          : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
  }

  async get(auth: AuthContext, id: string) {
    const guest = await this.prisma.guest.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: {
        reservations: {
          orderBy: { arrivalDate: "desc" },
          take: 10,
          select: {
            id: true, confirmationCode: true, status: true,
            arrivalDate: true, departureDate: true,
          },
        },
      },
    });
    if (!guest) {
      throw new NotFoundException({
        error: { code: "GUEST_NOT_FOUND", message: "Guest not found." },
      });
    }
    return guest;
  }

  async create(auth: AuthContext, dto: z.infer<typeof createGuestSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const guest = await tx.guest.create({
        data: { tenantId: auth.tenantId, ...dto },
      });
      await this.audit.log(tx, auth, {
        action: "guest.created",
        entityType: "guest",
        entityId: guest.id,
        summary: { name: `${guest.firstName} ${guest.lastName}` },
      });
      return guest;
    });
  }
}

@Controller("guests")
export class GuestsController {
  constructor(private readonly service: GuestsService) {}

  @Get()
  search(@CurrentAuth() auth: AuthContext, @Query("q") q?: string) {
    return this.service.search(auth, q);
  }

  @Get(":id")
  get(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.service.get(auth, id);
  }

  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.create(auth, createGuestSchema.parse(body));
  }
}

@Module({
  controllers: [GuestsController],
  providers: [GuestsService],
  exports: [GuestsService],
})
export class GuestsModule {}
