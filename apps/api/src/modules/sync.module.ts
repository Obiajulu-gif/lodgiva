import {
  Body,
  Controller,
  Injectable,
  Module,
  Post,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { AuthContext, CurrentAuth } from "../common/auth";
import { AuditService } from "../common/audit.service";

type Tx = Prisma.TransactionClient;

const mutationSchema = z.object({
  operationId: z.string().min(6),
  entityType: z.enum(["housekeepingTask", "maintenanceTicket", "room"]),
  entityId: z.string().min(1),
  baseVersion: z.number().int().min(0).optional(),
  action: z.string().min(1),
  occurredAt: z.string(),
  payload: z.record(z.unknown()).default({}),
});

const syncSchema = z
  .object({
    deviceId: z.string().min(1),
    lastServerCursor: z.string().optional(),
    mutations: z.array(mutationSchema).max(200).default([]),
  })
  .strict();

type Mutation = z.infer<typeof mutationSchema>;

// §10.3 — operations that must never be applied from a queued offline device.
// Money and the business date are online-only.
const ONLINE_ONLY = new Set([
  "payment",
  "refund",
  "discount",
  "rateOverride",
  "nightAudit",
  "checkIn",
  "checkOut",
]);

const HK_FLOW = ["PENDING", "IN_PROGRESS", "COMPLETED", "INSPECTED"];

/**
 * §10.4 synchronisation contract.
 *
 * Applies queued offline mutations idempotently (operationId is the key),
 * reports conflicts with the current server version instead of auto-merging,
 * and returns the changes the device missed since its cursor.
 */
@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async push(auth: AuthContext, body: unknown) {
    const dto = syncSchema.parse(body);

    const applied: unknown[] = [];
    const conflicts: unknown[] = [];
    const rejected: unknown[] = [];

    for (const m of dto.mutations) {
      // Idempotency: a replayed operationId returns its original outcome.
      const seen = await this.prisma.syncOperation.findFirst({
        where: { tenantId: auth.tenantId, operationId: m.operationId },
      });
      if (seen) {
        const detail = JSON.parse(seen.detail);
        const bucket =
          seen.status === "APPLIED" ? applied : seen.status === "CONFLICT" ? conflicts : rejected;
        bucket.push({ ...detail, operationId: m.operationId, replayed: true });
        continue;
      }

      if (ONLINE_ONLY.has(m.action)) {
        const detail = {
          operationId: m.operationId,
          entityType: m.entityType,
          entityId: m.entityId,
          code: "ONLINE_ONLY",
          message: `"${m.action}" must be performed online and cannot be queued offline.`,
        };
        await this.record(auth, dto.deviceId, m, "REJECTED", detail);
        rejected.push(detail);
        continue;
      }

      try {
        const outcome = await this.prisma.$transaction((tx) => this.apply(tx, auth, m));
        if (outcome.status === "CONFLICT") {
          await this.record(auth, dto.deviceId, m, "CONFLICT", outcome.detail);
          conflicts.push(outcome.detail);
        } else {
          await this.record(auth, dto.deviceId, m, "APPLIED", outcome.detail);
          applied.push(outcome.detail);
        }
      } catch (err) {
        const detail = {
          operationId: m.operationId,
          entityType: m.entityType,
          entityId: m.entityId,
          code: "REJECTED",
          message: err instanceof Error ? err.message : "Could not apply mutation.",
        };
        await this.record(auth, dto.deviceId, m, "REJECTED", detail);
        rejected.push(detail);
      }
    }

    // Server changes the device missed. The cursor is an ISO timestamp.
    const since = dto.lastServerCursor ? new Date(dto.lastServerCursor) : new Date(0);
    const nextCursor = new Date().toISOString();

    const [tasks, rooms] = await Promise.all([
      this.prisma.housekeepingTask.findMany({
        where: { tenantId: auth.tenantId, updatedAt: { gt: since } },
        orderBy: { updatedAt: "asc" },
        take: 200,
        include: { room: { select: { roomNumber: true } } },
      }),
      this.prisma.room.findMany({
        where: { tenantId: auth.tenantId, updatedAt: { gt: since } },
        orderBy: { updatedAt: "asc" },
        take: 200,
        select: { id: true, roomNumber: true, operationalStatus: true, updatedAt: true },
      }),
    ]);

    const serverChanges = [
      ...tasks.map((t) => ({
        entityType: "housekeepingTask",
        entityId: t.id,
        version: t.version,
        updatedAt: t.updatedAt,
        data: {
          room: t.room.roomNumber,
          type: t.type,
          status: t.status,
          priority: t.priority,
          notes: t.notes,
        },
      })),
      ...rooms.map((r) => ({
        entityType: "room",
        entityId: r.id,
        updatedAt: r.updatedAt,
        data: { roomNumber: r.roomNumber, operationalStatus: r.operationalStatus },
      })),
    ];

    return { applied, conflicts, rejected, serverChanges, nextCursor };
  }

  private async record(
    auth: AuthContext,
    deviceId: string,
    m: Mutation,
    status: string,
    detail: unknown
  ) {
    await this.prisma.syncOperation.create({
      data: {
        tenantId: auth.tenantId,
        operationId: m.operationId,
        deviceId,
        userId: auth.userId,
        entityType: m.entityType,
        entityId: m.entityId,
        action: m.action,
        status,
        detail: JSON.stringify(detail),
      },
    });
  }

  private async apply(
    tx: Tx,
    auth: AuthContext,
    m: Mutation
  ): Promise<{ status: "APPLIED" | "CONFLICT"; detail: Record<string, unknown> }> {
    const head = { operationId: m.operationId, entityType: m.entityType, entityId: m.entityId };

    if (m.entityType === "housekeepingTask") {
      const task = await tx.housekeepingTask.findFirst({
        where: { id: m.entityId, tenantId: auth.tenantId },
        include: { room: true },
      });
      if (!task) throw new Error("Housekeeping task no longer exists.");

      // Optimistic concurrency: someone else moved this task while offline.
      if (m.baseVersion !== undefined && m.baseVersion !== task.version) {
        return {
          status: "CONFLICT",
          detail: {
            ...head,
            code: "VERSION_CONFLICT",
            message: `Task was updated on the server (v${task.version}) after this device went offline (v${m.baseVersion}).`,
            serverVersion: task.version,
            serverStatus: task.status,
            resolution: "Review the current status and re-apply if still needed.",
          },
        };
      }

      if (m.action === "note") {
        // Notes append — never last-write-wins (§10.4).
        const note = String(m.payload.notes ?? "").trim();
        const merged = [task.notes, note].filter(Boolean).join("\n");
        const updated = await tx.housekeepingTask.update({
          where: { id: task.id },
          data: { notes: merged, version: { increment: 1 } },
        });
        await this.audit.log(tx, auth, {
          action: "sync.housekeeping_note_appended",
          entityType: "housekeeping_task",
          entityId: task.id,
          propertyId: task.propertyId,
          summary: { offline: true, operationId: m.operationId },
        });
        return { status: "APPLIED", detail: { ...head, version: updated.version, status: updated.status } };
      }

      const target =
        m.action === "start" ? "IN_PROGRESS" :
        m.action === "complete" ? "COMPLETED" :
        m.action === "inspect" ? "INSPECTED" : null;
      if (!target) throw new Error(`Unsupported housekeeping action "${m.action}".`);

      // Only ever move forward through the flow.
      if (HK_FLOW.indexOf(target) <= HK_FLOW.indexOf(task.status)) {
        return {
          status: "CONFLICT",
          detail: {
            ...head,
            code: "ALREADY_ADVANCED",
            message: `Task is already ${task.status} on the server; "${m.action}" would move it backwards.`,
            serverVersion: task.version,
            serverStatus: task.status,
            resolution: "No action needed — the server is ahead of this device.",
          },
        };
      }

      const updated = await tx.housekeepingTask.update({
        where: { id: task.id },
        data: {
          status: target,
          startedAt: target === "IN_PROGRESS" ? new Date(m.occurredAt) : task.startedAt,
          completedAt: target === "COMPLETED" ? new Date(m.occurredAt) : task.completedAt,
          version: { increment: 1 },
        },
      });
      if (!task.room.operationalStatus.startsWith("OCCUPIED")) {
        if (target === "COMPLETED") {
          await tx.room.update({
            where: { id: task.roomId },
            data: { operationalStatus: "VACANT_CLEAN" },
          });
        } else if (target === "INSPECTED") {
          await tx.room.update({
            where: { id: task.roomId },
            data: { operationalStatus: "INSPECTED" },
          });
        }
      }
      await this.audit.log(tx, auth, {
        action: "sync.housekeeping_task_advanced",
        entityType: "housekeeping_task",
        entityId: task.id,
        propertyId: task.propertyId,
        summary: { offline: true, to: target, occurredAt: m.occurredAt, operationId: m.operationId },
      });
      return { status: "APPLIED", detail: { ...head, version: updated.version, status: updated.status } };
    }

    if (m.entityType === "maintenanceTicket" && m.action === "note") {
      const ticket = await tx.maintenanceTicket.findFirst({
        where: { id: m.entityId, tenantId: auth.tenantId },
      });
      if (!ticket) throw new Error("Maintenance ticket no longer exists.");
      const note = String(m.payload.notes ?? "").trim();
      const updated = await tx.maintenanceTicket.update({
        where: { id: ticket.id },
        data: { description: [ticket.description, note].filter(Boolean).join("\n") },
      });
      await this.audit.log(tx, auth, {
        action: "sync.maintenance_note_appended",
        entityType: "maintenance_ticket",
        entityId: ticket.id,
        propertyId: ticket.propertyId,
        summary: { offline: true, operationId: m.operationId },
      });
      return { status: "APPLIED", detail: { ...head, status: updated.status } };
    }

    throw new Error(`Unsupported offline mutation ${m.entityType}.${m.action}.`);
  }
}

@Controller("sync")
export class SyncController {
  constructor(private readonly service: SyncService) {}

  @Post("mutations")
  push(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.push(auth, body);
  }
}

@Module({
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
