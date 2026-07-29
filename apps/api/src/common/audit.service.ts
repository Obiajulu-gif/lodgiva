import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma.service";
import { AuthContext } from "./auth";

type Tx = Prisma.TransactionClient;

/**
 * Append-only audit events (§12.3) and transactional outbox writes (§9.3).
 * Both are written inside the caller's transaction so a state change, its
 * audit record and its domain event commit or roll back together.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(
    tx: Tx,
    auth: AuthContext,
    input: {
      action: string;
      entityType: string;
      entityId: string;
      propertyId?: string;
      summary?: Record<string, unknown>;
    }
  ) {
    await tx.auditEvent.create({
      data: {
        tenantId: auth.tenantId,
        propertyId: input.propertyId,
        actorType: "USER",
        actorId: auth.userId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        summary: JSON.stringify(input.summary ?? {}),
      },
    });
  }

  async emit(
    tx: Tx,
    tenantId: string,
    input: {
      aggregateType: string;
      aggregateId: string;
      eventType: string;
      payload: Record<string, unknown>;
    }
  ) {
    await tx.outboxEvent.create({
      data: {
        tenantId,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        eventType: input.eventType,
        payload: JSON.stringify(input.payload),
      },
    });
  }
}
