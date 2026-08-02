#!/usr/bin/env node
/**
 * Demo / training property.
 *
 * Usage: node packages/database/src/seed-demo.js [--reset]
 *
 * Creates a SECOND tenant, deliberately separate from the Grand Palm seed the
 * test suites depend on, so a trainee clicking "cancel everything" cannot
 * break anyone's test run — and so cross-tenant isolation is exercised by the
 * mere existence of two tenants with similar-looking data.
 *
 * The data is chosen to make training realistic rather than tidy. A dataset
 * where every folio balances and every room is clean teaches nobody what to do
 * on a real Tuesday, so this one ships with:
 *   - an in-house guest with an unpaid balance
 *   - a departure still in house, past their checkout time
 *   - a dirty room blocking an arrival
 *   - a maintenance ticket on an out-of-order room
 *   - a cash variance awaiting approval
 *   - a POS void waiting on a supervisor
 *
 * Every one of those is a scenario in docs/uat-script.md.
 */
const { PrismaClient } = require("@prisma/client");
const argon2 = require("argon2");

const prisma = new PrismaClient();

const TENANT_SLUG = "harmattan-demo";
const PROPERTY_CODE = "HRM-ABJ";
const PASSWORD = "TrainMe123!";

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function wipeExisting() {
  const tenant = await prisma.tenant.findUnique({ where: { slug: TENANT_SLUG } });
  if (!tenant) return;
  // Ordered by dependency. The demo tenant is disposable by design; the live
  // seed is never touched.
  const t = { where: { tenantId: tenant.id } };
  await prisma.folioEntry.deleteMany(t);
  await prisma.posOrderLine.deleteMany(t);
  await prisma.posOrder.deleteMany(t);
  await prisma.approvalRequest.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.cashMovement.deleteMany(t);
  await prisma.cashierShift.deleteMany(t);
  await prisma.menuItem.deleteMany(t);
  await prisma.outlet.deleteMany(t);
  await prisma.maintenanceTicket.deleteMany(t);
  await prisma.housekeepingTask.deleteMany(t);
  await prisma.roomNightAllocation.deleteMany(t);
  await prisma.hold.deleteMany(t);
  await prisma.folio.deleteMany(t);
  await prisma.reservationRoom.deleteMany(t);
  await prisma.reservation.deleteMany(t);
  await prisma.guest.deleteMany(t);
  await prisma.dailyRate.deleteMany(t);
  await prisma.rateRestriction.deleteMany(t);
  await prisma.ratePlan.deleteMany(t);
  await prisma.room.deleteMany(t);
  await prisma.roomType.deleteMany(t);
  await prisma.taxRule.deleteMany(t);
  await prisma.auditEvent.deleteMany(t);
  await prisma.membershipProperty.deleteMany({});
  await prisma.membership.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.property.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.tenant.delete({ where: { id: tenant.id } });
}

async function main() {
  if (process.argv.includes("--reset")) await wipeExisting();

  const existing = await prisma.tenant.findUnique({ where: { slug: TENANT_SLUG } });
  if (existing) {
    console.log(
      JSON.stringify(
        { ok: true, created: false, message: "Demo tenant already present. Re-run with --reset to rebuild it." },
        null,
        2
      )
    );
    return;
  }

  const businessDate = today();
  const tenant = await prisma.tenant.create({
    data: {
      slug: TENANT_SLUG,
      legalName: "Harmattan Hospitality Ltd (Training)",
      displayName: "Harmattan Suites — Training",
      status: "TRIAL",
    },
  });

  const property = await prisma.property.create({
    data: {
      tenantId: tenant.id,
      code: PROPERTY_CODE,
      slug: "harmattan-suites-abuja",
      name: "Harmattan Suites Abuja",
      timezone: "Africa/Lagos",
      businessDate,
      checkinTime: "14:00",
      checkoutTime: "12:00",
    },
  });

  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const staff = [
    { email: "trainer@harmattan.demo", fullName: "Ngozi Umeh", role: "TENANT_OWNER" },
    { email: "trainee.gm@harmattan.demo", fullName: "Sadiq Bello", role: "GENERAL_MANAGER" },
    { email: "trainee.desk@harmattan.demo", fullName: "Kemi Alabi", role: "FRONT_DESK" },
    { email: "trainee.hk@harmattan.demo", fullName: "Grace Peter", role: "HOUSEKEEPING" },
  ];
  for (const s of staff) {
    const user = await prisma.user.upsert({
      where: { email: s.email },
      update: {},
      create: { email: s.email, fullName: s.fullName, passwordHash },
    });
    await prisma.membership.create({
      data: { tenantId: tenant.id, userId: user.id, role: s.role, allProperties: true },
    });
  }

  // ── Rooms ──────────────────────────────────────────────────────────────
  const types = [];
  for (const t of [
    { code: "STD", name: "Standard", maxOccupancy: 2, baseRateMinor: 3800000 },
    { code: "EXE", name: "Executive", maxOccupancy: 2, baseRateMinor: 5500000 },
    { code: "STE", name: "Suite", maxOccupancy: 4, baseRateMinor: 9800000 },
  ]) {
    types.push(
      await prisma.roomType.create({
        data: { tenantId: tenant.id, propertyId: property.id, ...t },
      })
    );
  }

  const rooms = [];
  let n = 100;
  for (const type of types) {
    for (let i = 0; i < 6; i++) {
      n += 1;
      rooms.push(
        await prisma.room.create({
          data: {
            tenantId: tenant.id,
            propertyId: property.id,
            roomTypeId: type.id,
            roomNumber: String(n),
            floor: Math.floor(n / 100),
            // A property where every room is spotless teaches nobody how to
            // handle the morning after a full house.
            operationalStatus:
              i === 0 ? "VACANT_DIRTY" : i === 5 ? "OUT_OF_ORDER" : "VACANT_CLEAN",
          },
        })
      );
    }
    n = Math.ceil((n + 1) / 100) * 100;
  }

  // ── Rates ──────────────────────────────────────────────────────────────
  for (const type of types) {
    const plan = await prisma.ratePlan.create({
      data: {
        tenantId: tenant.id,
        propertyId: property.id,
        roomTypeId: type.id,
        code: `BAR-${type.code}`,
        name: `Best available — ${type.name}`,
        refundable: true,
      },
    });
    const rates = [];
    for (let d = -3; d < 90; d++) {
      const date = addDays(businessDate, d);
      const weekend = [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
      rates.push({
        tenantId: tenant.id,
        ratePlanId: plan.id,
        date,
        // Weekend uplift, so revenue reports show a shape rather than a line.
        // baseRateMinor is a BigInt; the uplift is applied in Number space
        // and converted back, because BigInt will not multiply by 1.25.
        rateMinor: BigInt(Math.round(Number(type.baseRateMinor) * (weekend ? 1.25 : 1))),
      });
    }
    await prisma.dailyRate.createMany({ data: rates });
  }

  // ── Guests and stays ───────────────────────────────────────────────────
  const guestData = [
    ["Amaka", "Nwosu", "amaka.nwosu@example.ng", "+2348030000001", true],
    ["Yusuf", "Danladi", "yusuf.danladi@example.ng", "+2348030000002", false],
    ["Blessing", "Etim", "blessing.etim@example.ng", "+2348030000003", false],
    ["Oluwaseun", "Ade", "seun.ade@example.ng", "+2348030000004", false],
    ["Hauwa", "Sani", "hauwa.sani@example.ng", "+2348030000005", true],
  ];
  const guests = [];
  for (const [firstName, lastName, email, phone, vip] of guestData) {
    guests.push(
      await prisma.guest.create({
        data: { tenantId: tenant.id, firstName, lastName, email, phone, vip },
      })
    );
  }

  const scenarios = [
    // in house, owing money — the most common real support call
    { guest: 0, arrival: -2, departure: 2, status: "CHECKED_IN", roomIndex: 1, charges: true, paid: false },
    // due out today, still in house — blocks tonight's arrival
    { guest: 1, arrival: -3, departure: 0, status: "CHECKED_IN", roomIndex: 2, charges: true, paid: true },
    // arriving today
    { guest: 2, arrival: 0, departure: 3, status: "CONFIRMED", roomIndex: null, charges: false, paid: false },
    // future booking
    { guest: 3, arrival: 5, departure: 8, status: "CONFIRMED", roomIndex: null, charges: false, paid: false },
    // yesterday's no-show, left unresolved on purpose
    { guest: 4, arrival: -1, departure: 1, status: "NO_SHOW", roomIndex: null, charges: false, paid: false },
  ];

  let created = 0;
  for (const s of scenarios) {
    const type = types[created % types.length];
    const reservation = await prisma.reservation.create({
      data: {
        tenantId: tenant.id,
        propertyId: property.id,
        confirmationCode: `LDG-DEMO-${String(1000 + created)}`,
        primaryGuestId: guests[s.guest].id,
        source: "DIRECT",
        status: s.status,
        arrivalDate: addDays(businessDate, s.arrival),
        departureDate: addDays(businessDate, s.departure),
        adults: 2,
      },
    });
    await prisma.reservationRoom.create({
      data: {
        tenantId: tenant.id,
        reservationId: reservation.id,
        roomTypeId: type.id,
        roomId: s.roomIndex === null ? null : rooms[s.roomIndex].id,
        arrivalDate: addDays(businessDate, s.arrival),
        departureDate: addDays(businessDate, s.departure),
        adults: 2,
        nightlyRateMinor: BigInt(type.baseRateMinor),
        status: s.status === "CHECKED_IN" ? "IN_HOUSE" : "RESERVED",
      },
    });
    if (s.roomIndex !== null) {
      await prisma.room.update({
        where: { id: rooms[s.roomIndex].id },
        data: { operationalStatus: "OCCUPIED" },
      });
    }

    const folio = await prisma.folio.create({
      data: {
        tenantId: tenant.id,
        propertyId: property.id,
        reservationId: reservation.id,
        guestId: guests[s.guest].id,
        label: "Room folio",
        status: "OPEN",
      },
    });
    if (s.charges) {
      const nights = Math.abs(s.departure - s.arrival);
      for (let i = 0; i < nights; i++) {
        await prisma.folioEntry.create({
          data: {
            tenantId: tenant.id,
            folioId: folio.id,
            type: "ROOM_CHARGE",
            description: `Room ${type.name}`,
            amountMinor: BigInt(type.baseRateMinor),
            businessDate: addDays(businessDate, s.arrival + i),
          },
        });
      }
      if (s.paid) {
        await prisma.folioEntry.create({
          data: {
            tenantId: tenant.id,
            folioId: folio.id,
            type: "PAYMENT",
            description: "Payment — card",
            amountMinor: -BigInt(type.baseRateMinor) * BigInt(nights),
            businessDate,
          },
        });
      }
    }
    created += 1;
  }

  // ── Housekeeping and maintenance ───────────────────────────────────────
  await prisma.housekeepingTask.create({
    data: {
      tenantId: tenant.id,
      propertyId: property.id,
      roomId: rooms[0].id,
      businessDate,
      type: "FULL_CLEAN",
      priority: "HIGH",
      status: "PENDING",
      notes: "Arrival waiting on this room.",
    },
  });
  await prisma.maintenanceTicket.create({
    data: {
      tenantId: tenant.id,
      propertyId: property.id,
      roomId: rooms[5].id,
      title: "Air conditioner not cooling",
      description: "Reported by housekeeping. Room is out of order until fixed.",
      priority: "HIGH",
      status: "OPEN",
      blocksRoom: true,
    },
  });

  // ── F&B ────────────────────────────────────────────────────────────────
  const outlet = await prisma.outlet.create({
    data: {
      tenantId: tenant.id,
      propertyId: property.id,
      code: "REST",
      name: "Harmattan Grill",
      type: "RESTAURANT",
    },
  });
  const menu = [
    ["JOLLOF", "Jollof rice & chicken", "MAIN", 750000],
    ["SUYA", "Beef suya platter", "STARTER", 550000],
    ["CHAPMAN", "Chapman", "DRINKS", 300000],
    ["WATER", "Bottled water", "DRINKS", 100000],
  ];
  for (const [code, name, category, priceMinor] of menu) {
    await prisma.menuItem.create({
      data: { tenantId: tenant.id, outletId: outlet.id, code, name, category, priceMinor },
    });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        created: true,
        tenant: tenant.displayName,
        propertyCode: PROPERTY_CODE,
        businessDate,
        rooms: rooms.length,
        reservations: created,
        logins: staff.map((s) => `${s.email} (${s.role})`),
        password: PASSWORD,
        deliberateProblems: [
          "One in-house guest owes a balance",
          "One departure is past checkout and still in house",
          "One room is VACANT_DIRTY with an arrival waiting",
          "One room is OUT_OF_ORDER with an open maintenance ticket",
          "One reservation is an unresolved NO_SHOW",
        ],
      },
      null,
      2
    )
  );
}

main()
  .catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
