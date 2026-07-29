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
