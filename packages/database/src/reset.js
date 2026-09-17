/* Clears every row so the seed can recreate a known state.
 *
 * WHAT THIS GUARD IS FOR
 *
 * This script deletes all data. Pointed at the wrong database it destroys a
 * hotel's bookings and ledger. The previous guard only accepted `file:` URLs,
 * which was safe but had stopped matching reality -- PostgreSQL is now the
 * only provider the schema supports, so `pnpm test:e2e` could not run at all.
 *
 * The condition is widened, not loosened. A disposable PostgreSQL target must
 * satisfy BOTH of these, and a production URL cannot satisfy either:
 *
 *   1. The host is loopback. A database reachable over a network is never a
 *      safe reset target from a test script, however it is named.
 *   2. The database name ends with `_test`. Naming is the second, independent
 *      signal, so one mistyped host cannot be enough on its own.
 *
 * Managed hosts are refused by name as well, because "localhost" can be made
 * to point anywhere and a tunnel to Neon should still fail closed.
 *
 * The rejected URL is never printed -- it carries credentials. Only the parts
 * needed to explain the refusal are shown.
 */
const { PrismaClient } = require("@prisma/client");

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const MANAGED_HOST_MARKERS = [
  "neon.tech",
  "supabase.",
  "rds.amazonaws.com",
  "azure.com",
  "render.com",
  "railway.app",
  "-pooler",
];

function assertDisposable(rawUrl) {
  // Legacy SQLite development databases stay allowed: a local file is
  // self-evidently disposable.
  if (rawUrl.startsWith("file:")) return { kind: "sqlite", label: "local file" };

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("DATABASE_URL is not a URL this script can check. Refusing to reset.");
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new Error(`Refusing to reset a ${parsed.protocol.replace(":", "")} database.`);
  }

  const host = parsed.hostname.toLowerCase();
  const database = parsed.pathname.replace(/^\//, "");
  const problems = [];

  if (!LOOPBACK.has(host)) {
    problems.push(`host "${host}" is not loopback (expected localhost)`);
  }
  const managed = MANAGED_HOST_MARKERS.find((m) => rawUrl.toLowerCase().includes(m));
  if (managed) {
    problems.push(`the URL names a managed host ("${managed}")`);
  }
  if (!/_test$/.test(database)) {
    problems.push(`database "${database}" does not end with _test`);
  }

  if (problems.length > 0) {
    throw new Error(
      [
        "Refusing to reset this database. It does not look disposable:",
        ...problems.map((p) => `  - ${p}`),
        "",
        "This script deletes every row. A disposable target must be on",
        "localhost AND named *_test. Create one rather than relaxing this:",
        "",
        "  createdb lodgiva_test",
        "  DATABASE_URL=postgresql://USER@localhost:5432/lodgiva_test pnpm db:migrate",
      ].join("
")
    );
  }
  return { kind: "postgres", label: `${host}/${database}` };
}

const url = process.env.DATABASE_URL ?? "file:./dev.db";
let target;
try {
  target = assertDisposable(url);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const prisma = new PrismaClient();

// Child tables first so foreign keys stay satisfied.
const ORDER = [
  "syncOperation",
  "approvalRequest",
  "cashMovement",
  "posOrderLine",
  "posOrder",
  "cashierShift",
  "menuItem",
  "outlet",
  "maintenanceTicket",
  "housekeepingTask",
  "payment",
  "folioEntry",
  "folio",
  "reservationRoom",
  "reservation",
  "guest",
  "dailyRate",
  "ratePlan",
  "taxRule",
  "nightAuditRun",
  "auditEvent",
  "outboxEvent",
  "roomBlock",
  "roomTypeAmenity",
  "roomAmenity",
  "amenity",
  "room",
  "roomType",
  "session",
  "invitation",
  "membershipProperty",
  "membership",
  "user",
  "property",
  "tenant",
];

async function main() {
  // Reversal entries reference other folio entries, so clear the link first.
  await prisma.folioEntry.updateMany({ data: { reversalOfId: null } });

  // Every model Prisma knows about, so a newly added table cannot be silently
  // skipped and leave the "clean" database holding rows.
  const allModels = Object.keys(prisma).filter(
    (k) => !k.startsWith("$") && !k.startsWith("_") && typeof prisma[k]?.deleteMany === "function"
  );
  const unknown = allModels.filter((m) => !ORDER.includes(m));
  const plan = [...ORDER.filter((m) => allModels.includes(m)), ...unknown];

  // Retry across passes: ordering handles the common case, and any model left
  // blocked by a foreign key is cleared once its children are gone.
  let remaining = plan;
  for (let pass = 0; pass < 5 && remaining.length; pass++) {
    const blocked = [];
    for (const model of remaining) {
      try {
        await prisma[model].deleteMany({});
      } catch (err) {
        if (err?.code === "P2003") blocked.push(model);
        else throw err;
      }
    }
    remaining = blocked;
  }
  if (remaining.length) {
    throw new Error(`Could not clear: ${remaining.join(", ")} (foreign keys still held).`);
  }
  console.log(`Cleared ${plan.length} tables in ${target.label} (${target.kind}).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
