import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Post,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import webpush from "web-push";
import { PrismaService } from "../prisma.service";
import { AuthContext, CurrentAuth } from "../common/auth";

type Tx = Prisma.TransactionClient;

const subscribeSchema = z
  .object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string().min(10), auth: z.string().min(5) }),
    deviceLabel: z.string().max(60).optional(),
  })
  .strict();

const unsubscribeSchema = z.object({ endpoint: z.string().url() }).strict();

/**
 * Web Push for task assignments.
 *
 * A housekeeper does not sit watching a dashboard — they are in a corridor
 * with the screen off. A push notification is the only way an assignment
 * reaches them promptly, and it is the one channel that works when the app is
 * closed entirely.
 *
 * VAPID keys identify this server to the push service. They are read from the
 * environment; when absent, push is DISABLED rather than faked, and every
 * response says so, because a notification system that silently does nothing
 * is worse than one that is visibly off.
 */
@Injectable()
export class PushService {
  private readonly publicKey = process.env.VAPID_PUBLIC_KEY ?? "";
  private readonly privateKey = process.env.VAPID_PRIVATE_KEY ?? "";
  private readonly subject = process.env.VAPID_SUBJECT ?? "mailto:ops@lodgiva.com";
  readonly enabled: boolean;

  constructor(private readonly prisma: PrismaService) {
    this.enabled = Boolean(this.publicKey && this.privateKey);
    if (this.enabled) {
      webpush.setVapidDetails(this.subject, this.publicKey, this.privateKey);
    }
  }

  status() {
    return {
      enabled: this.enabled,
      publicKey: this.enabled ? this.publicKey : null,
      note: this.enabled
        ? "Push is configured. Delivery still depends on the browser's push service being reachable."
        : "Push is disabled: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY. Assignments still appear in the app and in the sync feed.",
    };
  }

  async subscribe(auth: AuthContext, body: unknown) {
    const dto = subscribeSchema.parse(body);
    if (!this.enabled) {
      throw new BadRequestException({
        error: {
          code: "PUSH_DISABLED",
          message: "Push is not configured on this server.",
        },
      });
    }
    // The endpoint is unique, so re-subscribing the same browser updates the
    // row rather than accumulating duplicates that would double-notify.
    const sub = await this.prisma.pushSubscription.upsert({
      where: { endpoint: dto.endpoint },
      update: {
        tenantId: auth.tenantId,
        userId: auth.userId,
        p256dh: dto.keys.p256dh,
        auth: dto.keys.auth,
        deviceLabel: dto.deviceLabel,
        failureCount: 0,
      },
      create: {
        tenantId: auth.tenantId,
        userId: auth.userId,
        endpoint: dto.endpoint,
        p256dh: dto.keys.p256dh,
        auth: dto.keys.auth,
        deviceLabel: dto.deviceLabel,
      },
    });
    return { id: sub.id, subscribed: true };
  }

  async unsubscribe(auth: AuthContext, body: unknown) {
    const dto = unsubscribeSchema.parse(body);
    const removed = await this.prisma.pushSubscription.deleteMany({
      where: { endpoint: dto.endpoint, userId: auth.userId },
    });
    return { removed: removed.count };
  }

  async listMine(auth: AuthContext) {
    const rows = await this.prisma.pushSubscription.findMany({
      where: { tenantId: auth.tenantId, userId: auth.userId },
      select: { id: true, deviceLabel: true, createdAt: true, lastSentAt: true },
    });
    return rows;
  }

  /**
   * Sends to every device a user has registered.
   *
   * Returns a per-device outcome rather than a boolean: "notified" is not a
   * yes/no when someone has three devices and one has a stale subscription.
   * 404/410 mean the browser dropped the subscription, so it is deleted
   * instead of retried forever.
   */
  async notifyUser(
    userId: string,
    payload: { title: string; body: string; url?: string; tag?: string }
  ): Promise<{ sent: number; failed: number; pruned: number; skipped?: string }> {
    if (!this.enabled) {
      return { sent: 0, failed: 0, pruned: 0, skipped: "PUSH_DISABLED" };
    }
    const subs = await this.prisma.pushSubscription.findMany({ where: { userId } });
    let sent = 0;
    let failed = 0;
    let pruned = 0;

    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload)
        );
        sent++;
        await this.prisma.pushSubscription.update({
          where: { id: s.id },
          data: { lastSentAt: new Date(), failureCount: 0 },
        });
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await this.prisma.pushSubscription.delete({ where: { id: s.id } });
          pruned++;
        } else {
          failed++;
          await this.prisma.pushSubscription.update({
            where: { id: s.id },
            data: { failureCount: { increment: 1 } },
          });
        }
      }
    }
    return { sent, failed, pruned };
  }

  /**
   * Queues an assignment notification through the outbox.
   *
   * Written in the caller's transaction so a notification is never sent for an
   * assignment that rolled back — the classic failure where somebody is told
   * to clean a room that was never actually assigned to them.
   */
  async queueAssignment(
    tx: Tx,
    tenantId: string,
    input: {
      userId: string;
      taskId: string;
      roomNumber: string;
      taskType: string;
      priority: string;
    }
  ) {
    await tx.outboxEvent.create({
      data: {
        tenantId,
        aggregateType: "housekeeping_task",
        aggregateId: input.taskId,
        eventType: "housekeeping.task_assigned",
        payload: JSON.stringify({
          userId: input.userId,
          taskId: input.taskId,
          roomNumber: input.roomNumber,
          taskType: input.taskType,
          priority: input.priority,
        }),
      },
    });
  }
}

@Controller("push")
export class PushController {
  constructor(private readonly service: PushService) {}

  /** The client needs the public key before it can subscribe. */
  @Get("status")
  status() {
    return this.service.status();
  }

  @Get("subscriptions")
  listMine(@CurrentAuth() auth: AuthContext) {
    return this.service.listMine(auth);
  }

  @Post("subscribe")
  subscribe(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.subscribe(auth, body);
  }

  @Post("unsubscribe")
  unsubscribe(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.service.unsubscribe(auth, body);
  }

  /** Lets a user prove push works on this device before relying on it. */
  @Post("test")
  async test(@CurrentAuth() auth: AuthContext) {
    const result = await this.service.notifyUser(auth.userId, {
      title: "Lodgiva",
      body: "Push notifications are working on this device.",
      url: "/board",
      tag: "push-test",
    });
    return result;
  }
}

@Module({
  controllers: [PushController],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
