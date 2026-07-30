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
  console.log(`Development database cleared (${plan.length} tables).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
