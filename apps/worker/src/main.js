/* Outbox publisher/worker (§9.3).
 *
 * PostgreSQL row locks atomically lease work, so parallel workers cannot
 * deliver the same row concurrently. Failures use exponential backoff and
 * eventually enter a queryable dead-letter queue. */
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Use a PostgreSQL connection string.");
}

const { getPrisma } = require("@lodgiva/database");
const database = getPrisma();
const { AsyncLocalStorage } = require('node:async_hooks');
const tenantTransaction = new AsyncLocalStorage();
const prisma = new Proxy(database, {
  get(target, key) {
    const active = tenantTransaction.getStore() ?? target;
    const value = active[key];
    return typeof value === 'function' ? value.bind(active) : value;
  },
});

// Web Push delivery. Configured only when VAPID keys are present; otherwise
// assignment events are logged and the app still shows them in-band.
let webpush = null;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush = require("web-push");
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:ops@lodgiva.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

/**
 * Pushes to every device the user registered.
 *
 * A subscription the browser has dropped answers 404/410; those are deleted
 * rather than retried forever, which is what keeps a dead phone from
 * consuming a delivery attempt on every future assignment.
 */
async function pushToUser(userId, payload) {
  if (!webpush) return { skipped: "PUSH_DISABLED" };
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  let sent = 0, pruned = 0, failed = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload)
      );
      sent++;
      await prisma.pushSubscription.update({
        where: { id: s.id },
        data: { lastSentAt: new Date(), failureCount: 0 },
      });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await prisma.pushSubscription.delete({ where: { id: s.id } });
        pruned++;
      } else {
        failed++;
        await prisma.pushSubscription.update({
          where: { id: s.id },
          data: { failureCount: { increment: 1 } },
        });
      }
    }
  }
  return { sent, pruned, failed };
}

const POLL_MS = 2000;
const BATCH = 20;
const WORKER_ID = `${process.env.HOSTNAME || "worker"}-${process.pid}`;
const MAX_ATTEMPTS = Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 10);
const LEASE_SECONDS = Number(process.env.OUTBOX_LEASE_SECONDS ?? 60);

async function handle(event) {
  const payload = JSON.parse(event.payload);
  // Notification side-effects. In production these fan out to email/SMS
  // (Termii), webhooks and report jobs; locally we log the delivery.
  switch (event.eventType) {
    case "reservation.confirmed":
      console.log(`[notify] Booking confirmation ${payload.confirmationCode} → guest email/SMS`);
      break;
    case "guest.checked_in":
      console.log(`[notify] Welcome message for ${payload.confirmationCode} (room ${payload.room})`);
      break;
    case "guest.checked_out":
      console.log(`[notify] Thank-you + invoice email for ${payload.confirmationCode}`);
      break;
    case "payment.confirmed":
      console.log(`[notify] Receipt for ₦${(payload.amountMinor / 100).toLocaleString()} (${payload.method})`);
      break;
    case "housekeeping.task_assigned": {
      const result = await pushToUser(payload.userId, {
        title: `Room ${payload.roomNumber} assigned to you`,
        body: `${payload.taskType.replace(/_/g, " ").toLowerCase()}${payload.priority === "HIGH" ? " · priority" : ""}`,
        url: "/board",
        tag: `task-${payload.taskId}`,
      });
      console.log(`[push] task ${payload.taskId} -> user ${payload.userId}`, result);
      break;
    }
    case "night_audit.completed":
      console.log(`[notify] Daily flash report for ${payload.businessDate}: occupancy ${payload.occupancyPct}%`);
      break;
    default:
      console.log(`[event] ${event.eventType}`, payload);
  }
}

async function tickTenant() {
  const events = await prisma.$queryRawUnsafe(`
    WITH candidates AS (
      SELECT id FROM "OutboxEvent"
      WHERE "publishedAt" IS NULL
        AND "deadLetteredAt" IS NULL
        AND "nextAttemptAt" <= now()
        AND ("lockedAt" IS NULL OR "lockedAt" < now() - ($2 * interval '1 second'))
      ORDER BY "occurredAt" ASC
      LIMIT $3
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "OutboxEvent" AS event
    SET "lockedAt" = now(), "lockedBy" = $1
    FROM candidates
    WHERE event.id = candidates.id
    RETURNING event.*
  `, WORKER_ID, LEASE_SECONDS, BATCH);
  for (const event of events) {
    try {
      await handle(event);
      await prisma.outboxEvent.updateMany({
        where: { id: event.id, lockedBy: WORKER_ID },
        data: {
          publishedAt: new Date(), attempts: { increment: 1 },
          lockedAt: null, lockedBy: null, lastError: null,
        },
      });
    } catch (err) {
      console.error(`[outbox] failed ${event.id} (${event.eventType})`, err.message);
      const attempts = event.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      const delaySeconds = Math.min(3600, 2 ** Math.min(attempts, 10) * 5);
      await prisma.outboxEvent.updateMany({
        where: { id: event.id, lockedBy: WORKER_ID },
        data: {
          attempts,
          lockedAt: null,
          lockedBy: null,
          lastError: String(err?.message ?? err).slice(0, 2000),
          nextAttemptAt: new Date(Date.now() + delaySeconds * 1000),
          deadLetteredAt: dead ? new Date() : null,
        },
      });
    }
  }
  return events.length;
}

async function tick() {
  const tenants = await database.tenant.findMany({ select: { id: true } });
  let processed = 0;
  for (const tenant of tenants) {
    processed += await database.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;
      return tenantTransaction.run(tx, tickTenant);
    }, { timeout: 60000 });
  }
  return processed;
}

async function main() {
  console.log("Lodgiva worker: polling outbox every", POLL_MS, "ms");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await tick();
    } catch (err) {
      console.error("[outbox] poll error:", err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main();
