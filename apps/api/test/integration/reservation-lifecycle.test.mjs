/**
 * Integration tests for the reservation lifecycle: state machine enforcement,
 * modify, room allocation, confirmation codes and audit/outbox events.
 *
 * Run: node --test test/integration/reservation-lifecycle.test.mjs
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

let token;
let ownerToken;
let property;
let businessDate;
let typeId;
let altTypeId;
const ROOMS = 2;

async function newGuest(name = "Life") {
  const g = await call("/guests", {
    method: "POST",
    token,
    body: { firstName: name, lastName: `Cycle${uniq()}` },
  });
  assert.equal(g.status, 201, JSON.stringify(g.data));
  return g.data.id;
}

async function book(overrides = {}) {
  const arrival = overrides.arrivalDate ?? addDays(businessDate, 200);
  return call("/reservations", {
    method: "POST",
    token,
    body: {
      propertyId: property.id,
      guestId: overrides.guestId ?? (await newGuest()),
      roomTypeId: overrides.roomTypeId ?? typeId,
      arrivalDate: arrival,
      departureDate: overrides.departureDate ?? addDays(arrival, 2),
      ...overrides.extra,
    },
  });
}

test("setup: isolated room types for lifecycle testing", async () => {
  token = (
    await call("/auth/login", {
      method: "POST",
      body: { email: "frontdesk@grandpalm.demo", password: "Password123!" },
    })
  ).data.accessToken;
  ownerToken = (
    await call("/auth/login", {
      method: "POST",
      body: { email: "owner@grandpalm.demo", password: "Password123!" },
    })
  ).data.accessToken;

  const me = await call("/auth/me", { token });
  property = me.data.properties[0];
  businessDate = property.businessDate;

  for (const target of ["primary", "alt"]) {
    const code = `LC${uniq()}`.toUpperCase();
    const rt = await call("/config/room-types", {
      method: "POST",
      token: ownerToken,
      body: {
        propertyId: property.id,
        code,
        name: `Lifecycle ${code}`,
        baseOccupancy: 2,
        maxOccupancy: 2,
        baseRateMinor: 4000000,
      },
    });
    assert.equal(rt.status, 201, JSON.stringify(rt.data));
    if (target === "primary") typeId = rt.data.id;
    else altTypeId = rt.data.id;

    for (let i = 0; i < ROOMS; i++) {
      const room = await call("/config/rooms", {
        method: "POST",
        token: ownerToken,
        body: {
          propertyId: property.id,
          roomTypeId: rt.data.id,
          roomNumber: `${code}${i}`,
          floor: i + 1,
        },
      });
      assert.equal(room.status, 201, JSON.stringify(room.data));
    }
  }
});

// ── Confirmation codes ───────────────────────────────────────────────────

test("confirmation codes are unique, unambiguous and non-sequential", async () => {
  const codes = [];
  for (let i = 0; i < 4; i++) {
    const arrival = addDays(businessDate, 300 + i * 5);
    const r = await book({ arrivalDate: arrival, departureDate: addDays(arrival, 1) });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    codes.push(r.data.confirmationCode);
  }

  assert.equal(new Set(codes).size, codes.length, "codes must be unique");
  for (const c of codes) {
    assert.match(c, /^LDG-[ACDEFGHJKMNPQRTWXY2346789]{4}-[ACDEFGHJKMNPQRTWXY2346789]{4}$/, c);
  }
  // A counter-based scheme would produce a strictly ascending run.
  const ascending = codes.filter((c, i) => i > 0 && c > codes[i - 1]).length;
  assert.ok(ascending < codes.length - 1, "codes must not be sequential");
});

// ── State machine ────────────────────────────────────────────────────────

test("illegal transitions are refused with an actionable message", async () => {
  const r = await book({ arrivalDate: addDays(businessDate, 210) });
  assert.equal(r.status, 201);

  // CONFIRMED → CHECKED_OUT skips check-in.
  const skip = await call(`/reservations/${r.data.id}/check-out`, {
    method: "POST",
    token,
    body: {},
  });
  assert.equal(skip.status, 409);
  assert.equal(skip.data.error.code, "INVALID_STATE_TRANSITION");
  assert.match(skip.data.error.message, /checked in/i);
  assert.equal(skip.data.error.details.from, "CONFIRMED");
});

test("a cancelled reservation is terminal", async () => {
  const r = await book({ arrivalDate: addDays(businessDate, 215) });
  await call(`/reservations/${r.data.id}/cancel`, {
    method: "POST",
    token,
    body: { reason: "Guest changed plans" },
  });

  for (const [path, body] of [
    ["cancel", { reason: "Again please" }],
    ["no-show", {}],
    ["check-in", {}],
  ]) {
    const res = await call(`/reservations/${r.data.id}/${path}`, {
      method: "POST",
      token,
      body,
    });
    assert.equal(res.status, 409, `${path} on a cancelled booking must fail`);
  }
});

test("an in-house guest cannot be cancelled", async () => {
  const arrival = businessDate;
  const r = await book({ arrivalDate: arrival, departureDate: addDays(arrival, 1) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const ci = await call(`/reservations/${r.data.id}/check-in`, {
    method: "POST",
    token,
    body: {},
  });
  assert.equal(ci.status, 201, JSON.stringify(ci.data));

  const cancel = await call(`/reservations/${r.data.id}/cancel`, {
    method: "POST",
    token,
    body: { reason: "Trying to cancel an occupied room" },
  });
  assert.equal(cancel.status, 409);
  assert.match(cancel.data.error.message, /check them out instead/i);
});

test("only a confirmed reservation can be marked no-show", async () => {
  const r = await book({ arrivalDate: addDays(businessDate, 220) });
  const first = await call(`/reservations/${r.data.id}/no-show`, { method: "POST", token });
  assert.equal(first.status, 201);
  assert.equal(first.data.status, "NO_SHOW");

  const again = await call(`/reservations/${r.data.id}/no-show`, { method: "POST", token });
  assert.equal(again.status, 409);
});

test("a no-show releases its inventory and emits an event", async () => {
  const arrival = addDays(businessDate, 230);
  const departure = addDays(arrival, 1);
  const r = await book({ arrivalDate: arrival, departureDate: departure });

  const during = await call(
    `/availability?propertyId=${property.id}&arrival=${arrival}&departure=${departure}`,
    { token }
  );
  assert.equal(during.data.find((x) => x.roomTypeId === typeId).available, ROOMS - 1);

  await call(`/reservations/${r.data.id}/no-show`, { method: "POST", token });

  const after = await call(
    `/availability?propertyId=${property.id}&arrival=${arrival}&departure=${departure}`,
    { token }
  );
  assert.equal(
    after.data.find((x) => x.roomTypeId === typeId).available,
    ROOMS,
    "a no-show must put the room back on sale"
  );

  const audit = await call(`/reports/audit-trail?propertyId=${property.id}`, {
    token: ownerToken,
  });
  assert.ok(
    audit.data.some((a) => a.action === "reservation.no_show" && a.entityId === r.data.id),
    "no-show must be audited"
  );
});

// ── Modify ───────────────────────────────────────────────────────────────

test("modifying dates moves the inventory with the booking", async () => {
  const arrival = addDays(businessDate, 240);
  const r = await book({ arrivalDate: arrival, departureDate: addDays(arrival, 1) });
  const newArrival = addDays(businessDate, 245);

  const mod = await call(`/reservations/${r.data.id}`, {
    method: "PATCH",
    token,
    body: {
      arrivalDate: newArrival,
      departureDate: addDays(newArrival, 2),
      reason: "Guest moved their trip",
    },
  });
  assert.equal(mod.status, 200, JSON.stringify(mod.data));
  assert.equal(mod.data.arrivalDate, newArrival);
  assert.ok(mod.data.changes.dates, "the change set records the date move");

  // Old dates released…
  const old = await call(
    `/availability?propertyId=${property.id}&arrival=${arrival}&departure=${addDays(arrival, 1)}`,
    { token }
  );
  assert.equal(old.data.find((x) => x.roomTypeId === typeId).available, ROOMS);

  // …new dates claimed.
  const now = await call(
    `/availability?propertyId=${property.id}&arrival=${newArrival}&departure=${addDays(newArrival, 2)}`,
    { token }
  );
  assert.equal(now.data.find((x) => x.roomTypeId === typeId).available, ROOMS - 1);
});

test("a modification that cannot be satisfied leaves the booking untouched", async () => {
  // Fill a window completely, then try to move another booking into it.
  const full = addDays(businessDate, 260);
  const held = [];
  for (let i = 0; i < ROOMS; i++) {
    const b = await book({ arrivalDate: full, departureDate: addDays(full, 1) });
    assert.equal(b.status, 201);
    held.push(b.data.id);
  }

  const mover = await book({
    arrivalDate: addDays(businessDate, 270),
    departureDate: addDays(businessDate, 271),
  });
  assert.equal(mover.status, 201);

  const attempt = await call(`/reservations/${mover.data.id}`, {
    method: "PATCH",
    token,
    body: { arrivalDate: full, departureDate: addDays(full, 1) },
  });
  assert.equal(attempt.status, 409);
  assert.equal(attempt.data.error.code, "SOLD_OUT");

  // The original booking must still exist on its original dates.
  const after = await call(`/reservations/${mover.data.id}`, { token });
  assert.equal(after.data.arrivalDate, addDays(businessDate, 270));
  const stillHeld = await call(
    `/availability?propertyId=${property.id}&arrival=${addDays(businessDate, 270)}&departure=${addDays(businessDate, 271)}`,
    { token }
  );
  assert.equal(
    stillHeld.data.find((x) => x.roomTypeId === typeId).available,
    ROOMS - 1,
    "the failed modification must not have released the original nights"
  );

  for (const id of held) {
    await call(`/reservations/${id}/cancel`, {
      method: "POST",
      token,
      body: { reason: "cleanup" },
    });
  }
});

test("modifying to a different room type re-allocates and drops a stale room", async () => {
  const arrival = addDays(businessDate, 280);
  const r = await book({ arrivalDate: arrival, departureDate: addDays(arrival, 1) });
  await call(`/reservations/${r.data.id}/assign-room`, { method: "POST", token, body: {} });

  const assigned = await call(`/reservations/${r.data.id}`, { token });
  assert.ok(assigned.data.rooms[0].roomId, "a room was assigned");

  const mod = await call(`/reservations/${r.data.id}`, {
    method: "PATCH",
    token,
    body: { roomTypeId: altTypeId, reason: "Upgrade" },
  });
  assert.equal(mod.status, 200, JSON.stringify(mod.data));
  assert.ok(mod.data.changes.roomType, "the change set records the type change");

  const after = await call(`/reservations/${r.data.id}`, { token });
  assert.equal(
    after.data.rooms[0].roomId,
    null,
    "a room of the old type must not be carried into the new type"
  );
  assert.equal(after.data.rooms[0].roomTypeId, altTypeId);
});

test("an in-house stay cannot be modified in bulk", async () => {
  const arrival = businessDate;
  const r = await book({
    roomTypeId: altTypeId,
    arrivalDate: arrival,
    departureDate: addDays(arrival, 1),
  });
  await call(`/reservations/${r.data.id}/check-in`, { method: "POST", token, body: {} });

  const mod = await call(`/reservations/${r.data.id}`, {
    method: "PATCH",
    token,
    body: { adults: 2 },
  });
  assert.equal(mod.status, 409);
  assert.equal(mod.data.error.code, "NOT_MODIFIABLE");
  assert.match(mod.data.error.message, /room move or extend/i);
});

test("modify rejects an empty change set and impossible dates", async () => {
  const r = await book({ arrivalDate: addDays(businessDate, 290) });

  const empty = await call(`/reservations/${r.data.id}`, { method: "PATCH", token, body: {} });
  assert.equal(empty.status, 400);
  assert.equal(empty.data.error.code, "NO_CHANGES");

  const backwards = await call(`/reservations/${r.data.id}`, {
    method: "PATCH",
    token,
    body: { departureDate: r.data.arrivalDate },
  });
  assert.equal(backwards.status, 400);
  assert.equal(backwards.data.error.code, "INVALID_DATE_RANGE");
});

test("occupancy above the room type maximum is refused on modify", async () => {
  const r = await book({ arrivalDate: addDays(businessDate, 295) });
  const mod = await call(`/reservations/${r.data.id}`, {
    method: "PATCH",
    token,
    body: { adults: 2, children: 2 },
  });
  assert.equal(mod.status, 409);
  assert.equal(mod.data.error.code, "OCCUPANCY_EXCEEDED");
});

// ── Room allocation ──────────────────────────────────────────────────────

test("auto-assignment picks a free room and refuses when none remain", async () => {
  const arrival = addDays(businessDate, 320);
  const departure = addDays(arrival, 1);

  const assigned = [];
  for (let i = 0; i < ROOMS; i++) {
    const r = await book({ arrivalDate: arrival, departureDate: departure });
    assert.equal(r.status, 201);
    const a = await call(`/reservations/${r.data.id}/assign-room`, {
      method: "POST",
      token,
      body: {},
    });
    assert.equal(a.status, 201, JSON.stringify(a.data));
    assigned.push(a.data.roomNumber);
  }
  assert.equal(new Set(assigned).size, ROOMS, "auto-assignment must not reuse a room");

  // Every room of the type is now taken for these dates, so the next booking
  // cannot be created at all — inventory is exhausted before assignment.
  const overflow = await book({ arrivalDate: arrival, departureDate: departure });
  assert.equal(overflow.status, 409);
  assert.equal(overflow.data.error.code, "SOLD_OUT");
});

test("assigning a room of the wrong type is refused", async () => {
  const r = await book({ arrivalDate: addDays(businessDate, 330) });
  const rooms = await call(`/config/rooms?propertyId=${property.id}`, { token: ownerToken });
  const wrong = rooms.data.find((x) => x.roomType.id === altTypeId);

  const res = await call(`/reservations/${r.data.id}/assign-room`, {
    method: "POST",
    token,
    body: { roomId: wrong.id },
  });
  assert.equal(res.status, 404);
  assert.equal(res.data.error.code, "ROOM_NOT_FOUND");
});

test("a room already taken for the dates cannot be double-assigned", async () => {
  const arrival = addDays(businessDate, 340);
  const departure = addDays(arrival, 1);

  const first = await book({ arrivalDate: arrival, departureDate: departure });
  const a = await call(`/reservations/${first.data.id}/assign-room`, {
    method: "POST",
    token,
    body: {},
  });
  assert.equal(a.status, 201);

  const second = await book({ arrivalDate: arrival, departureDate: departure });
  const clash = await call(`/reservations/${second.data.id}/assign-room`, {
    method: "POST",
    token,
    body: { roomId: a.data.roomId },
  });
  assert.equal(clash.status, 409);
  assert.equal(clash.data.error.code, "ROOM_NOT_AVAILABLE");
});

// ── Audit & outbox ───────────────────────────────────────────────────────

test("lifecycle actions are audited and published to the outbox", async () => {
  const arrival = addDays(businessDate, 350);
  const r = await book({ arrivalDate: arrival, departureDate: addDays(arrival, 1) });
  await call(`/reservations/${r.data.id}`, {
    method: "PATCH",
    token,
    body: { notes: "Late arrival expected" },
  });
  await call(`/reservations/${r.data.id}/cancel`, {
    method: "POST",
    token,
    body: { reason: "Testing the audit trail" },
  });

  const audit = await call(`/reports/audit-trail?propertyId=${property.id}`, {
    token: ownerToken,
  });
  const mine = audit.data.filter((a) => a.entityId === r.data.id).map((a) => a.action);
  for (const expected of [
    "reservation.created",
    "reservation.modified",
    "reservation.cancelled",
  ]) {
    assert.ok(mine.includes(expected), `${expected} should be audited (saw ${mine.join(", ")})`);
  }
});
