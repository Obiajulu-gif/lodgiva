/* Outbox publisher/worker (§9.3).
 *
 * ADR-LOCAL-002: Redis/BullMQ is unavailable on this machine, so the worker
 * polls the transactional outbox directly and processes events in-process.
 * The outbox contract is unchanged: events are written in the same database
 * transaction as the state change, consumers are idempotent (publishedAt
 * gate), and swapping this loop for a BullMQ publisher requires no schema or
 * API change. */
process.env.DATABASE_URL ??= "file:./dev.db";

const { getPrisma } = require("@lodgiva/database");
const prisma = getPrisma();

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

async function tick() {
  const events = await prisma.outboxEvent.findMany({
    where: { publishedAt: null },
    orderBy: { occurredAt: "asc" },
    take: BATCH,
  });
  for (const event of events) {
    try {
      await handle(event);
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { publishedAt: new Date(), attempts: { increment: 1 } },
      });
    } catch (err) {
      console.error(`[outbox] failed ${event.id} (${event.eventType})`, err.message);
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { attempts: { increment: 1 } },
      });
    }
  }
  return events.length;
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
