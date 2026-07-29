import {
  Body,
  ConflictException,
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
import { FoliosModule, FoliosService } from "./folios.module";

// §13.4 — a discount at or under this share of the folio may be applied
// directly by front desk with a reason; above it needs a manager.
const SELF_SERVICE_DISCOUNT_BP = 500; // 5%
const APPROVER_ROLES = ["TENANT_OWNER", "GENERAL_MANAGER", "FINANCE"];

const discountSchema = z
  .object({
    folioId: z.string().min(1),
    amountMinor: z.number().int().positive(),
    reason: z.string().min(3),
  })
  .strict();

const decisionSchema = z.object({ note: z.string().optional() }).strict();

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly folios: FoliosService
  ) {}

  list(auth: AuthContext, propertyId?: string, status = "PENDING") {
    return this.prisma.approvalRequest.findMany({
      where: {
        tenantId: auth.tenantId,
        ...(propertyId ? { propertyId } : {}),
        ...(status === "ALL" ? {} : { status }),
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  /**
   * Request a discount. Under the threshold it posts immediately; over it,
   * an approval request is raised and nothing touches the ledger until a
   * different, authorised user approves it.
   */
  async requestDiscount(auth: AuthContext, body: unknown) {
    const dto = discountSchema.parse(body);

    return this.prisma.$transaction(async (tx) => {
      const folio = await this.folios.getFolioOrThrow(auth, dto.folioId, tx);
      if (folio.status !== "OPEN") {
        throw new ConflictException({
          error: { code: "FOLIO_CLOSED", message: "Cannot discount a closed folio." },
        });
      }
      const charges = await tx.folioEntry.aggregate({
        where: { folioId: folio.id, amountMinor: { gt: 0 } },
        _sum: { amountMinor: true },
      });
      const chargeTotal = charges._sum.amountMinor ?? 0n;
      if (chargeTotal === 0n) {
        throw new ConflictException({
          error: { code: "NOTHING_TO_DISCOUNT", message: "This folio has no charges to discount." },
        });
      }
      const shareBp = Number((BigInt(dto.amountMinor) * 10000n) / chargeTotal);
      const property = await tx.property.findUniqueOrThrow({ where: { id: folio.propertyId } });

      const withinSelfService =
        shareBp <= SELF_SERVICE_DISCOUNT_BP || APPROVER_ROLES.includes(auth.role);

      if (withinSelfService) {
        const entry = await tx.folioEntry.create({
          data: {
            tenantId: auth.tenantId,
            folioId: folio.id,
            type: "DISCOUNT",
            description: `Discount — ${dto.reason}`,
            amountMinor: -BigInt(dto.amountMinor),
            businessDate: property.businessDate,
            postedById: auth.userId,
          },
        });
        await this.audit.log(tx, auth, {
          action: "folio.discount_applied",
          entityType: "folio_entry",
          entityId: entry.id,
          propertyId: folio.propertyId,
          summary: { amountMinor: dto.amountMinor, shareBp, reason: dto.reason, approval: "not required" },
        });
        return { status: "APPLIED", shareBp, entry };
      }

      const request = await tx.approvalRequest.create({
        data: {
          tenantId: auth.tenantId,
          propertyId: folio.propertyId,
          type: "DISCOUNT",
          entityType: "folio",
          entityId: folio.id,
          amountMinor: BigInt(dto.amountMinor),
          reason: dto.reason,
          payload: JSON.stringify({ folioId: folio.id, amountMinor: dto.amountMinor }),
          requestedById: auth.userId,
        },
      });
      await this.audit.log(tx, auth, {
        action: "approval.requested",
        entityType: "approval_request",
        entityId: request.id,
        propertyId: folio.propertyId,
        summary: { type: "DISCOUNT", amountMinor: dto.amountMinor, shareBp },
      });
      return {
        status: "PENDING_APPROVAL",
        shareBp,
        request,
        message: `Discount is ${(shareBp / 100).toFixed(1)}% of charges, above the ${SELF_SERVICE_DISCOUNT_BP / 100}% self-service limit. A manager must approve it.`,
      };
    });
  }

  async decide(auth: AuthContext, id: string, approve: boolean, body: unknown) {
    const dto = decisionSchema.parse(body ?? {});
    const request = await this.prisma.approvalRequest.findFirst({
      where: { id, tenantId: auth.tenantId },
    });
    if (!request) {
      throw new NotFoundException({
        error: { code: "REQUEST_NOT_FOUND", message: "Approval request not found." },
      });
    }
    if (request.status !== "PENDING") {
      throw new ConflictException({
        error: { code: "ALREADY_DECIDED", message: `Request is already ${request.status}.` },
      });
    }
    if (!APPROVER_ROLES.includes(auth.role)) {
      throw new ConflictException({
        error: { code: "FORBIDDEN_ROLE", message: "Your role cannot approve this request." },
      });
    }
    // Separation of duties: the requester is never the approver.
    if (request.requestedById === auth.userId) {
      throw new ConflictException({
        error: { code: "SELF_APPROVAL", message: "You cannot approve your own request." },
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.approvalRequest.update({
        where: { id: request.id },
        data: {
          status: approve ? "APPROVED" : "REJECTED",
          decidedById: auth.userId,
          decisionNote: dto.note,
          decidedAt: new Date(),
        },
      });

      if (approve && request.type === "DISCOUNT") {
        const payload = JSON.parse(request.payload) as { folioId: string; amountMinor: number };
        const folio = await this.folios.getFolioOrThrow(auth, payload.folioId, tx);
        const property = await tx.property.findUniqueOrThrow({ where: { id: folio.propertyId } });
        await tx.folioEntry.create({
          data: {
            tenantId: auth.tenantId,
            folioId: folio.id,
            type: "DISCOUNT",
            description: `Approved discount — ${request.reason}`,
            amountMinor: -BigInt(payload.amountMinor),
            businessDate: property.businessDate,
            postedById: auth.userId,
          },
        });
      }

      await this.audit.log(tx, auth, {
        action: approve ? "approval.approved" : "approval.rejected",
        entityType: "approval_request",
        entityId: request.id,
        propertyId: request.propertyId,
        summary: {
          type: request.type,
          amountMinor: Number(request.amountMinor ?? 0n),
          requestedBy: request.requestedById,
          note: dto.note,
        },
      });
      return updated;
    });
  }
}

@Controller("approvals")
export class ApprovalsController {
  constructor(private readonly service: ApprovalsService) {}

  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query("propertyId") propertyId?: string,
    @Query("status") status?: string
  ) {
    return this.service.list(auth, propertyId, status);
  }

  @Post("discounts")
  requestDiscount(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.requestDiscount(auth, body);
  }

  @Post(":id/approve")
  approve(@CurrentAuth() auth: AuthContext, @Param("id") id: string, @Body() body: unknown) {
    return this.service.decide(auth, id, true, body);
  }

  @Post(":id/reject")
  reject(@CurrentAuth() auth: AuthContext, @Param("id") id: string, @Body() body: unknown) {
    return this.service.decide(auth, id, false, body);
  }
}

@Module({
  imports: [FoliosModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsService],
})
export class ApprovalsModule {}
