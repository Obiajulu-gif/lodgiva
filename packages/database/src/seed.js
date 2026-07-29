/* Seed: demo tenant "Grand Palm Hotels" with one Lagos property, rooms,
 * staff users, guests and a few reservations so the dashboard has data.
 * Idempotent: safe to re-run (upserts by natural keys). */
const { PrismaClient } = require("@prisma/client");
const argon2 = require("argon2");

const prisma = new PrismaClient();
const today = new Date().toISOString().slice(0, 10);

function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: "grand-palm" },
    update: {},
    create: {
      legalName: "Grand Palm Hospitality Ltd",
      displayName: "Grand Palm Hotels",
      slug: "grand-palm",
    },
  });

  const property = await prisma.property.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "GPH-LAG" } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: "Grand Palm Hotel Lagos",
      code: "GPH-LAG",
      slug: "grand-palm-lagos",
      businessDate: today,
    },
  });

  const roomTypeDefs = [
    { code: "STD", name: "Standard", baseRateMinor: 3500000n, baseOccupancy: 2, maxOccupancy: 2 },
    { code: "DLX", name: "Deluxe", baseRateMinor: 4650000n, baseOccupancy: 2, maxOccupancy: 3 },
    { code: "EXE", name: "Executive", baseRateMinor: 6200000n, baseOccupancy: 2, maxOccupancy: 3 },
    { code: "SUT", name: "Suite", baseRateMinor: 9500000n, baseOccupancy: 2, maxOccupancy: 4 },
  ];
  const roomTypes = {};
  for (const rt of roomTypeDefs) {
    roomTypes[rt.code] = await prisma.roomType.upsert({
      where: {
        tenantId_propertyId_code: {
          tenantId: tenant.id,
          propertyId: property.id,
          code: rt.code,
        },
      },
      update: {},
      create: { tenantId: tenant.id, propertyId: property.id, ...rt },
    });
  }

  // 20 rooms across 4 floors: floor 1 STD, 2-3 DLX, 4 EXE/SUT
  const rooms = [];
  for (let floor = 1; floor <= 4; floor++) {
    for (let n = 1; n <= 5; n++) {
      const roomNumber = `${floor}0${n}`;
      const code =
        floor === 1 ? "STD" : floor === 4 ? (n <= 3 ? "EXE" : "SUT") : "DLX";
      rooms.push(
        await prisma.room.upsert({
          where: {
            tenantId_propertyId_roomNumber: {
              tenantId: tenant.id,
              propertyId: property.id,
              roomNumber,
            },
          },
          update: {},
          create: {
            tenantId: tenant.id,
            propertyId: property.id,
            roomTypeId: roomTypes[code].id,
            roomNumber,
            floor,
            operationalStatus: n === 5 && floor === 2 ? "VACANT_DIRTY" : "VACANT_CLEAN",
          },
        })
      );
    }
  }

  const password = await argon2.hash("Password123!", { type: argon2.argon2id });
  const userDefs = [
    { email: "owner@grandpalm.demo", fullName: "Adanna Okeke", role: "TENANT_OWNER" },
    { email: "manager@grandpalm.demo", fullName: "Bola Adesina", role: "GENERAL_MANAGER" },
    { email: "frontdesk@grandpalm.demo", fullName: "Chidi Nwachukwu", role: "FRONT_DESK" },
    { email: "housekeeping@grandpalm.demo", fullName: "Mary Johnson", role: "HOUSEKEEPING" },
  ];
  for (const u of userDefs) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: { email: u.email, fullName: u.fullName, passwordHash: password },
    });
    await prisma.membership.upsert({
      where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
      update: { role: u.role },
      create: { tenantId: tenant.id, userId: user.id, role: u.role },
    });
  }

  const guestDefs = [
    { firstName: "Adaeze", lastName: "Okonkwo", phone: "+2348034567890", email: "adaeze.o@example.com", vip: true },
    { firstName: "Tunde", lastName: "Bakare", phone: "+2348051234567", email: "tunde.b@example.com" },
    { firstName: "Chiamaka", lastName: "Eze", phone: "+2348129876543", email: "chiamaka.e@example.com", vip: true },
    { firstName: "Ibrahim", lastName: "Musa", phone: "+2348062345678", email: "ibrahim.m@example.com" },
    { firstName: "Funke", lastName: "Adeyemi", phone: "+2348093456789", email: "funke.a@example.com" },
  ];
  const guests = [];
  for (const g of guestDefs) {
    const existing = await prisma.guest.findFirst({
      where: { tenantId: tenant.id, phone: g.phone },
    });
    guests.push(
      existing ??
        (await prisma.guest.create({ data: { tenantId: tenant.id, nationality: "Nigerian", ...g } }))
    );
  }

  // A few reservations if none exist yet
  const count = await prisma.reservation.count({ where: { tenantId: tenant.id } });
  if (count === 0) {
    const mk = async (i, guest, rtCode, startOffset, nights, status) => {
      const arrival = addDays(today, startOffset);
      const departure = addDays(arrival, nights);
      const rt = roomTypes[rtCode];
      const res = await prisma.reservation.create({
        data: {
          tenantId: tenant.id,
          propertyId: property.id,
          confirmationCode: `LDG-${5000 + i}`,
          primaryGuestId: guest.id,
          status,
          arrivalDate: arrival,
          departureDate: departure,
          rooms: {
            create: {
              tenantId: tenant.id,
              roomTypeId: rt.id,
              arrivalDate: arrival,
              departureDate: departure,
              nightlyRateMinor: rt.baseRateMinor,
            },
          },
        },
      });
      await prisma.folio.create({
        data: {
          tenantId: tenant.id,
          propertyId: property.id,
          reservationId: res.id,
          guestId: guest.id,
        },
      });
      return res;
    };
    await mk(1, guests[0], "DLX", 0, 3, "CONFIRMED");
    await mk(2, guests[1], "EXE", 0, 2, "CONFIRMED");
    await mk(3, guests[2], "SUT", 1, 4, "CONFIRMED");
    await mk(4, guests[3], "STD", 2, 1, "CONFIRMED");
    await mk(5, guests[4], "DLX", 3, 2, "CONFIRMED");
  }

  // Outlets + menus for the POS module
  const outletDefs = [
    {
      code: "REST", name: "Palm Restaurant", type: "RESTAURANT",
      items: [
        { code: "JOLLOF", name: "Jollof Rice & Chicken", category: "MAINS", priceMinor: 850000n },
        { code: "EGUSI", name: "Egusi Soup & Pounded Yam", category: "MAINS", priceMinor: 980000n },
        { code: "CROAKER", name: "Grilled Croaker Fish", category: "MAINS", priceMinor: 1450000n },
        { code: "PEPPER", name: "Pepper Soup (Goat)", category: "STARTERS", priceMinor: 720000n },
        { code: "SUYA", name: "Suya Platter", category: "STARTERS", priceMinor: 1100000n },
        { code: "PUFF", name: "Puff Puff & Ice Cream", category: "DESSERTS", priceMinor: 480000n },
      ],
    },
    {
      code: "BAR", name: "Pool Bar", type: "BAR",
      items: [
        { code: "CHAPMAN", name: "Chapman", category: "DRINKS", priceMinor: 350000n },
        { code: "OJ", name: "Fresh Orange Juice", category: "DRINKS", priceMinor: 300000n },
        { code: "STAR", name: "Star Lager", category: "DRINKS", priceMinor: 250000n },
        { code: "WINE", name: "Red Wine (Glass)", category: "DRINKS", priceMinor: 650000n },
      ],
    },
  ];
  for (const o of outletDefs) {
    const outlet = await prisma.outlet.upsert({
      where: {
        tenantId_propertyId_code: {
          tenantId: tenant.id, propertyId: property.id, code: o.code,
        },
      },
      update: {},
      create: {
        tenantId: tenant.id, propertyId: property.id,
        code: o.code, name: o.name, type: o.type,
      },
    });
    for (const item of o.items) {
      await prisma.menuItem.upsert({
        where: {
          tenantId_outletId_code: {
            tenantId: tenant.id, outletId: outlet.id, code: item.code,
          },
        },
        update: {},
        create: { tenantId: tenant.id, outletId: outlet.id, ...item },
      });
    }
  }

  console.log("Seed complete:", {
    tenant: tenant.slug,
    property: property.code,
    rooms: rooms.length,
    logins: userDefs.map((u) => u.email),
    password: "Password123!",
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
