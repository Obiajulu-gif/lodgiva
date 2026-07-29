/* Clears all rows from the local development database so the seed can
 * recreate a known state. Truncating rather than deleting the file means it
 * works while the API is running (which holds the SQLite file open).
 *
 * Guarded to file: databases — never point this at a shared or production
 * database. */
const { PrismaClient } = require("@prisma/client");

const url = process.env.DATABASE_URL ?? "file:./dev.db";
if (!url.startsWith("file:")) {
  console.error(`Refusing to reset a non-file database (${url}).`);
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
  "room",
  "roomType",
  "session",
  "membership",
  "user",
  "property",
  "tenant",
];

async function main() {
  // Reversal entries reference other folio entries, so clear the link first.
  await prisma.folioEntry.updateMany({ data: { reversalOfId: null } });
  for (const model of ORDER) {
    await prisma[model].deleteMany({});
  }
  console.log("Development database cleared.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
