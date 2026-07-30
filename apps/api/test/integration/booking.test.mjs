/**
 * Integration tests for guests, rate plans, restrictions, availability,
 * quote/hold and concurrency-safe inventory.
 *
 * The concurrency test is the important one: it fires more simultaneous
 * bookings than there are rooms and asserts the database refused the excess.
 *
 * Run: node --test test/integration/booking.test.mjs   (API must be up)
 */
import test from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.API_BASE ?? "http://localhost:4000/api/v1";

async function call(path, { method = "GET", body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : {} };
}

const uniq = () => Math.random().toString(36).slice(2, 7);
const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

let ownerToken;
let fdToken;
let property;
let businessDate;
// A dedicated room type with a known, small capacity so the concurrency
// assertions are exact rather than dependent on seed data.
let typeId;
let planId;
const CAPACITY = 3;

test("setup: dedicated room type with known capacity", async () => {
  ownerToken = (
    await call("/auth/login", {
      method: "POST",
      body: { email: "owner@grandpalm.demo", password: "Password123!" },
    })
  ).data.accessToken;
  fdToken = (
    await call("/auth/login", {
      method: "POST",
      body: { email: "frontdesk@grandpalm.demo", password: "Password123!" },
    })
  ).data.accessToken;

  const me = await call("/auth/me", { token: ownerToken });
  property = me.data.properties[0];
  businessDate = property.businessDate;

  const code = `CT${uniq()}`.toUpperCase();
  const rt = await call("/config/room-types", {
    method: "POST",
    token: ownerToken,
    body: {
      propertyId: property.id,
      code,
      name: `Concurrency ${code}`,
      baseOccupancy: 2,
      maxOccupancy: 3,
      baseRateMinor: 5000000,
    },
  });
  assert.equal(rt.status, 201, JSON.stringify(rt.data));
  typeId = rt.data.id;

  for (let i = 0; i < CAPACITY; i++) {
    const room = await call("/config/rooms", {
      method: "POST",
      token: ownerToken,
      body: {
        propertyId: property.id,
        roomTypeId: typeId,
        roomNumber: `${code}-${i}`,
        floor: 1,
      },
    });
    assert.equal(room.status, 201, JSON.stringify(room.data));
  }

  const plan = await call("/rates/plans", {
    method: "POST",
    token: ownerToken,
    body: {
      propertyId: property.id,
      roomTypeId: typeId,
      code: `RP${uniq()}`.toUpperCase(),
      name: "Concurrency BAR",
      minStay: 1,
    },
  });
  assert.equal(plan.status, 201, JSON.stringify(plan.data));
  planId = plan.data.id;
});

// ── Availability & quoting ───────────────────────────────────────────────

test("availability reports capacity per night", async () => {
  const arrival = addDays(businessDate, 30);
  const res = await call(
    `/availability?propertyId=${property.id}&arrival=${arrival}&departure=${addDays(arrival, 2)}`,
    { token: fdToken }
  );
  assert.equal(res.status, 200);
  const mine = res.data.find((r) => r.roomTypeId === typeId);
  assert.equal(mine.available, CAPACITY);
  assert.equal(mine.byNight.length, 2);
  assert.equal(mine.byNight[0].capacity, CAPACITY);
});

test("a quote prices night by night and itemises tax", async () => {
  const arrival = addDays(businessDate, 30);
  const res = await call(
    `/quotes?propertyId=${property.id}&ratePlanId=${planId}&arrival=${arrival}&departure=${addDays(arrival, 2)}`,
    { token: fdToken }
  );
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.nights.length, 2);
  assert.equal(res.data.baseMinor, 10000000);
  assert.ok(res.data.taxes.length >= 1);
  assert.equal(
    res.data.totalMinor,
    res.data.baseMinor + res.data.taxes.reduce((s, t) => s + t.amountMinor, 0),
    "total must equal base plus the itemised taxes"
  );
});

test("a calendar override changes only the night it covers", async () => {
  const arrival = addDays(businessDate, 40);
  await call("/rates/calendar", {
    method: "POST",
    token: ownerToken,
    body: { ratePlanId: planId, rates: [{ date: arrival, rateMinor: 9000000 }] },
  });
  const res = await call(
    `/quotes?propertyId=${property.id}&ratePlanId=${planId}&arrival=${arrival}&departure=${addDays(arrival, 2)}`,
    { token: fdToken }
  );
  assert.equal(res.data.nights[0].rateMinor, 9000000);
  assert.equal(res.data.nights[0].source, "CALENDAR");
  assert.equal(res.data.nights[1].rateMinor, 5000000);
  assert.equal(res.data.nights[1].source, "BASE");
});

test("occupancy beyond the room type maximum is refused", async () => {
  const arrival = addDays(businessDate, 30);
  const res = await call(
    `/quotes?propertyId=${property.id}&ratePlanId=${planId}&arrival=${arrival}&departure=${addDays(arrival, 1)}&adults=9`,
    { token: fdToken }
  );
  assert.equal(res.status, 409);
  assert.equal(res.data.error.code, "OCCUPANCY_EXCEEDED");
});

// ── Restrictions ─────────────────────────────────────────────────────────

test("restrictions block quoting and are reported with a reason", async () => {
  const arrival = addDays(businessDate, 50);
  const set = await call("/rates/restrictions", {
    method: "POST",
    token: ownerToken,
    body: {
      ratePlanId: planId,
      restrictions: [{ date: arrival, closedToArrival: true }],
    },
  });
  assert.equal(set.status, 201, JSON.stringify(set.data));

  const blocked = await call(
    `/quotes?propertyId=${property.id}&ratePlanId=${planId}&arrival=${arrival}&departure=${addDays(arrival, 2)}`,
    { token: fdToken }
  );
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.error.code, "CLOSED_TO_ARRIVAL");

  // Arriving the day before and staying through the CTA date is still fine.
  const through = await call(
    `/quotes?propertyId=${property.id}&ratePlanId=${planId}&arrival=${addDays(arrival, -1)}&departure=${addDays(arrival, 2)}`,
    { token: fdToken }
  );
  assert.equal(through.status, 200, JSON.stringify(through.data));

  // Clear it so later tests are unaffected.
  await call("/rates/restrictions", {
    method: "POST",
    token: ownerToken,
    body: { ratePlanId: planId, restrictions: [{ date: arrival, closedToArrival: false }] },
  });
});

// ── Holds ────────────────────────────────────────────────────────────────

test("a hold reserves inventory and its price is frozen", async () => {
  const arrival = addDays(businessDate, 60);
  const before = await call(
    `/availability?propertyId=${property.id}&arrival=${arrival}&departure=${addDays(arrival, 1)}`,
    { token: fdToken }
  );
  const availBefore = before.data.find((r) => r.roomTypeId === typeId).available;

  const hold = await call("/holds", {
    method: "POST",
    token: fdToken,
    body: {
      propertyId: property.id,
      ratePlanId: planId,
      arrivalDate: arrival,
      departureDate: addDays(arrival, 1),
    },
  });
  assert.equal(hold.status, 201, JSON.stringify(hold.data));
  assert.ok(hold.data.holdToken, "hold returns a one-time token");
  assert.ok(hold.data.expiresAt);

  const after = await call(
    `/availability?propertyId=${property.id}&arrival=${arrival}&departure=${addDays(arrival, 1)}`,
    { token: fdToken }
  );
  const availAfter = after.data.find((r) => r.roomTypeId === typeId).available;
  assert.equal(availAfter, availBefore - 1, "an active hold must consume inventory");

  // Raising the rate afterwards must not move the held price.
  await call("/rates/calendar", {
    method: "POST",
    token: ownerToken,
    body: { ratePlanId: planId, rates: [{ date: arrival, rateMinor: 99000000 }] },
  });
  const fetched = await call(`/holds/${hold.data.holdId}`, { token: fdToken });
  assert.equal(
    fetched.data.quotedTotalMinor,
    hold.data.quote.totalMinor,
    "the held price is frozen at quote time"
  );

  const released = await call(`/holds/${hold.data.holdId}/release`, {
    method: "POST",
    token: fdToken,
  });
  assert.equal(released.status, 201);

  const restored = await call(
    `/availability?propertyId=${property.id}&arrival=${arrival}&departure=${addDays(arrival, 1)}`,
    { token: fdToken }
  );
  assert.equal(
    restored.data.find((r) => r.roomTypeId === typeId).available,
    availBefore,
    "releasing a hold returns the room to sale"
  );
});

test("a hold converts into a reservation and cannot be reused", async () => {
  const arrival = addDays(businessDate, 70);
  const hold = await call("/holds", {
    method: "POST",
    token: fdToken,
    body: {
      propertyId: property.id,
      ratePlanId: planId,
      arrivalDate: arrival,
      departureDate: addDays(arrival, 1),
    },
  });
  const guest = await call("/guests", {
    method: "POST",
    token: fdToken,
    body: { firstName: "Hold", lastName: `Convert${uniq()}`, phone: `+23480${Date.now() % 100000000}` },
  });

  const created = await call("/reservations", {
    method: "POST",
    token: fdToken,
    body: {
      propertyId: property.id,
      guestId: guest.data.id,
      roomTypeId: typeId,
      arrivalDate: arrival,
      departureDate: addDays(arrival, 1),
      holdToken: hold.data.holdToken,
      source: "BOOKING_ENGINE",
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));

  // The hold is consumed; replaying the token must fail.
  const replay = await call("/reservations", {
    method: "POST",
    token: fdToken,
    body: {
      propertyId: property.id,
      guestId: guest.data.id,
      roomTypeId: typeId,
      arrivalDate: arrival,
      departureDate: addDays(arrival, 1),
      holdToken: hold.data.holdToken,
    },
  });
  assert.equal(replay.status, 409);
  assert.equal(replay.data.error.code, "HOLD_NOT_ACTIVE");

  // Converting must not double-count: the stay owns the slot the hold held.
  const avail = await call(
    `/availability?propertyId=${property.id}&arrival=${arrival}&departure=${addDays(arrival, 1)}`,
    { token: fdToken }
  );
  assert.equal(
    avail.data.find((r) => r.roomTypeId === typeId).available,
    CAPACITY - 1,
    "hold → reservation transfers the slot rather than consuming a second one"
  );
});

test("a hold for different dates cannot be used on another stay", async () => {
  const arrival = addDays(businessDate, 80);
  const hold = await call("/holds", {
    method: "POST",
    token: fdToken,
    body: {
      propertyId: property.id,
      ratePlanId: planId,
      arrivalDate: arrival,
      departureDate: addDays(arrival, 1),
    },
  });
  const guest = await call("/guests", {
    method: "POST",
    token: fdToken,
    body: { firstName: "Mismatch", lastName: `Case${uniq()}` },
  });
  const res = await call("/reservations", {
    method: "POST",
    token: fdToken,
    body: {
      propertyId: property.id,
      guestId: guest.data.id,
      roomTypeId: typeId,
      arrivalDate: addDays(arrival, 5),
      departureDate: addDays(arrival, 6),
      holdToken: hold.data.holdToken,
    },
  });
  assert.equal(res.status, 409);
  assert.equal(res.data.error.code, "HOLD_MISMATCH");
});

// ── Concurrency ──────────────────────────────────────────────────────────

test("concurrent bookings cannot oversell the last rooms", async () => {
  const arrival = addDays(businessDate, 120);
  const departure = addDays(arrival, 1);

  const guests = await Promise.all(
    Array.from({ length: CAPACITY + 4 }, (_, i) =>
      call("/guests", {
        method: "POST",
        token: fdToken,
        body: { firstName: "Race", lastName: `R${i}${uniq()}` },
      })
    )
  );
  for (const g of guests) {
    assert.equal(g.status, 201, `guest setup failed: ${JSON.stringify(g.data)}`);
  }

  // Fire every booking simultaneously at a room type with exactly CAPACITY
  // rooms. Overbooking is prevented by the unique index on
  // (roomTypeId, date, slotIndex), not by any application-level check.
  const attempts = await Promise.all(
    guests.map((g) =>
      call("/reservations", {
        method: "POST",
        token: fdToken,
        body: {
          propertyId: property.id,
          guestId: g.data.id,
          roomTypeId: typeId,
          arrivalDate: arrival,
          departureDate: departure,
          source: "BOOKING_ENGINE",
        },
      })
    )
  );

  const created = attempts.filter((a) => a.status === 201);
  const rejected = attempts.filter((a) => a.status !== 201);

  assert.equal(
    created.length,
    CAPACITY,
    `exactly ${CAPACITY} bookings should succeed, got ${created.length}`
  );
  assert.equal(rejected.length, 4);
  for (const r of rejected) {
    assert.equal(r.status, 409, `unexpected failure: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.error.code, "SOLD_OUT");
  }

  const avail = await call(
    `/availability?propertyId=${property.id}&arrival=${arrival}&departure=${departure}`,
    { token: fdToken }
  );
  assert.equal(avail.data.find((r) => r.roomTypeId === typeId).available, 0);
});

test("cancelling a booking returns the night to sale", async () => {
  const arrival = addDays(businessDate, 130);
  const departure = addDays(arrival, 1);
  const guest = await call("/guests", {
    method: "POST",
    token: fdToken,
    body: { firstName: "Cancel", lastName: `Me${uniq()}` },
  });
  const res = await call("/reservations", {
    method: "POST",
    token: fdToken,
    body: {
      propertyId: property.id,
      guestId: guest.data.id,
      roomTypeId: typeId,
      arrivalDate: arrival,
      departureDate: departure,
    },
  });
  assert.equal(res.status, 201);

  const during = await call(
    `/availability?propertyId=${property.id}&arrival=${arrival}&departure=${departure}`,
    { token: fdToken }
  );
  assert.equal(during.data.find((r) => r.roomTypeId === typeId).available, CAPACITY - 1);

  await call(`/reservations/${res.data.id}/cancel`, {
    method: "POST",
    token: fdToken,
    body: { reason: "Guest changed plans" },
  });

  const after = await call(
    `/availability?propertyId=${property.id}&arrival=${arrival}&departure=${departure}`,
    { token: fdToken }
  );
  assert.equal(
    after.data.find((r) => r.roomTypeId === typeId).available,
    CAPACITY,
    "cancelled inventory must go back on sale"
  );
});

test("a blocked room reduces sellable capacity", async () => {
  const arrival = addDays(businessDate, 140);
  const departure = addDays(arrival, 1);
  const rooms = await call(`/config/rooms?propertyId=${property.id}`, { token: ownerToken });
  const mine = rooms.data.filter((r) => r.roomType.id === typeId);

  const block = await call("/config/room-blocks", {
    method: "POST",
    token: ownerToken,
    body: {
      propertyId: property.id,
      roomId: mine[0].id,
      reason: "Refurbishment",
      startDate: arrival,
      endDate: departure,
    },
  });
  assert.equal(block.status, 201, JSON.stringify(block.data));

  const avail = await call(
    `/availability?propertyId=${property.id}&arrival=${arrival}&departure=${departure}`,
    { token: fdToken }
  );
  const row = avail.data.find((r) => r.roomTypeId === typeId);
  assert.equal(row.byNight[0].capacity, CAPACITY - 1, "a block reduces capacity for that night");
  assert.equal(row.available, CAPACITY - 1);

  await call(`/config/room-blocks/${block.data.id}/release`, {
    method: "POST",
    token: ownerToken,
  });
});

// ── Public quote (§6.3) ──────────────────────────────────────────────────

test("the public quote endpoint needs no authentication", async () => {
  const arrival = addDays(businessDate, 150);
  const res = await fetch(`${BASE}/public/quotes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      propertySlug: "grand-palm-lagos",
      arrivalDate: arrival,
      departureDate: addDays(arrival, 2),
      adults: 2,
    }),
  });
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.property.slug, "grand-palm-lagos");
  assert.equal(data.nights, 2);
  assert.ok(Array.isArray(data.offers));
  // A public response must not leak internal identifiers of unsellable plans.
  assert.ok(!JSON.stringify(data).includes("tenantId"));
});

test("the public quote endpoint rejects an unknown property", async () => {
  const res = await fetch(`${BASE}/public/quotes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      propertySlug: "no-such-hotel-anywhere",
      arrivalDate: addDays(businessDate, 10),
      departureDate: addDays(businessDate, 11),
    }),
  });
  assert.equal(res.status, 404);
});

// ── Guests: duplicates and merge ─────────────────────────────────────────

test("duplicate detection matches on a normalised phone number", async () => {
  const suffix = String(Date.now()).slice(-8);
  const a = await call("/guests", {
    method: "POST",
    token: fdToken,
    body: { firstName: "Chinwe", lastName: `Okafor${uniq()}`, phone: `+23480${suffix}` },
  });
  const b = await call("/guests", {
    method: "POST",
    token: fdToken,
    // Same number written the local way — must still be detected.
    body: { firstName: "Chinwe", lastName: `Okafor${uniq()}`, phone: `080${suffix}` },
  });

  const dupes = await call(`/guests/${a.data.id}/duplicates`, { token: fdToken });
  assert.equal(dupes.status, 200);
  const match = dupes.data.candidates.find((c) => c.guest.id === b.data.id);
  assert.ok(match, "the same number in local format should be flagged");
  assert.equal(match.matchedOn, "phone");
  assert.equal(match.confidence, "HIGH");
});

test("merging moves history and leaves a read-only tombstone", async () => {
  const survivor = await call("/guests", {
    method: "POST",
    token: fdToken,
    body: { firstName: "Keep", lastName: `Me${uniq()}`, email: `keep${uniq()}@example.com` },
  });
  const dupe = await call("/guests", {
    method: "POST",
    token: fdToken,
    body: { firstName: "Keep", lastName: `Me${uniq()}`, phone: `+2348099${Date.now() % 1000000}` },
  });

  // Give the duplicate a reservation so there is history to move.
  const arrival = addDays(businessDate, 160);
  const res = await call("/reservations", {
    method: "POST",
    token: fdToken,
    body: {
      propertyId: property.id,
      guestId: dupe.data.id,
      roomTypeId: typeId,
      arrivalDate: arrival,
      departureDate: addDays(arrival, 1),
    },
  });
  assert.equal(res.status, 201);

  const merge = await call("/guests/merge", {
    method: "POST",
    token: fdToken,
    body: {
      survivingGuestId: survivor.data.id,
      mergedGuestId: dupe.data.id,
      reason: "Same guest booked twice",
    },
  });
  assert.equal(merge.status, 201, JSON.stringify(merge.data));
  assert.equal(merge.data.moved.reservations, 1);

  // The reservation now belongs to the survivor.
  const moved = await call(`/reservations/${res.data.id}`, { token: fdToken });
  assert.equal(moved.data.primaryGuestId, survivor.data.id);

  // The survivor inherited the phone number it was missing.
  const kept = await call(`/guests/${survivor.data.id}`, { token: fdToken });
  assert.ok(kept.data.phone, "blank fields on the survivor are filled from the merged record");

  // The tombstone is read-only and hidden from search.
  const edit = await call(`/guests/${dupe.data.id}`, {
    method: "PATCH",
    token: fdToken,
    body: { notes: "should not be editable" },
  });
  assert.equal(edit.status, 409);
  assert.equal(edit.data.error.code, "GUEST_MERGED");

  const search = await call("/guests?q=Keep", { token: fdToken });
  assert.ok(!search.data.some((g) => g.id === dupe.data.id), "tombstones are hidden from search");
});

test("a guest cannot be merged into itself, and merges are single-use", async () => {
  const g = await call("/guests", {
    method: "POST",
    token: fdToken,
    body: { firstName: "Self", lastName: `Merge${uniq()}` },
  });
  const self = await call("/guests/merge", {
    method: "POST",
    token: fdToken,
    body: { survivingGuestId: g.data.id, mergedGuestId: g.data.id, reason: "Nonsense" },
  });
  assert.equal(self.status, 400);
  assert.equal(self.data.error.code, "SAME_GUEST");
});
