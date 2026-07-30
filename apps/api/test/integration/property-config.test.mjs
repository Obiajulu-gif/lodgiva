/**
 * Integration tests for property configuration: settings, business date,
 * room types, rooms, amenities, taxes, service charges, blocks and imports.
 *
 * Run: node --test test/integration/property-config.test.mjs  (API must be up)
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
let frontDeskToken;
let property;
let businessDate;

test("setup", async () => {
  const owner = await call("/auth/login", {
    method: "POST",
    body: { email: "owner@grandpalm.demo", password: "Password123!" },
  });
  ownerToken = owner.data.accessToken;
  const fd = await call("/auth/login", {
    method: "POST",
    body: { email: "frontdesk@grandpalm.demo", password: "Password123!" },
  });
  frontDeskToken = fd.data.accessToken;

  const me = await call("/auth/me", { token: ownerToken });
  property = me.data.properties[0];
  businessDate = property.businessDate;
  assert.ok(property?.id);
});

// ── Settings & business date ─────────────────────────────────────────────

test("settings expose counts and the effective tax rules", async () => {
  const res = await call(`/properties/${property.id}/settings`, { token: ownerToken });
  assert.equal(res.status, 200);
  assert.equal(res.data.property.id, property.id);
  assert.ok(typeof res.data.counts.rooms === "number");
  assert.ok(Array.isArray(res.data.effectiveTaxRules));
  // Only one effective version per code should be returned.
  const codes = res.data.effectiveTaxRules.map((r) => r.code);
  assert.equal(new Set(codes).size, codes.length, "one effective version per tax code");
});

test("settings can be updated and check-in times are validated", async () => {
  const ok = await call(`/properties/${property.id}/settings`, {
    method: "PATCH",
    token: ownerToken,
    body: { checkinTime: "15:00", checkoutTime: "11:00" },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.checkinTime, "15:00");

  const bad = await call(`/properties/${property.id}/settings`, {
    method: "PATCH",
    token: ownerToken,
    body: { checkinTime: "25:00" },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error.code, "VALIDATION_ERROR");

  // restore
  await call(`/properties/${property.id}/settings`, {
    method: "PATCH",
    token: ownerToken,
    body: { checkinTime: "14:00", checkoutTime: "12:00" },
  });
});

test("front desk cannot change property settings", async () => {
  const res = await call(`/properties/${property.id}/settings`, {
    method: "PATCH",
    token: frontDeskToken,
    body: { checkinTime: "16:00" },
  });
  assert.equal(res.status, 403);
  assert.equal(res.data.error.details.requiredPermission, "settings.property.manage");
});

test("business date is readable and documented as night-audit-only", async () => {
  const res = await call(`/properties/${property.id}/business-date`, { token: ownerToken });
  assert.equal(res.status, 200);
  assert.match(res.data.businessDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(res.data.advancedBy, "night_audit_only");

  // There is deliberately no setter: the business date must not be writable.
  const attempt = await call(`/properties/${property.id}/settings`, {
    method: "PATCH",
    token: ownerToken,
    body: { businessDate: "2099-01-01" },
  });
  assert.equal(attempt.status, 400, "businessDate must not be an accepted settings field");
});

// ── Amenities ────────────────────────────────────────────────────────────

let amenityId;

test("amenities can be created and listed", async () => {
  const code = `WIFI${uniq()}`.toUpperCase();
  const created = await call("/config/amenities", {
    method: "POST",
    token: ownerToken,
    body: { propertyId: property.id, code, name: "Fast Wi-Fi", category: "TECH" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  amenityId = created.data.id;

  const list = await call(`/config/amenities?propertyId=${property.id}`, { token: ownerToken });
  assert.ok(list.data.some((a) => a.id === amenityId));

  const dup = await call("/config/amenities", {
    method: "POST",
    token: ownerToken,
    body: { propertyId: property.id, code, name: "Duplicate" },
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error.code, "AMENITY_EXISTS");
});

// ── Room types ───────────────────────────────────────────────────────────

let roomTypeId;
const roomTypeCode = `RT${uniq()}`.toUpperCase();

test("room types validate occupancy and attach amenities", async () => {
  const invalid = await call("/config/room-types", {
    method: "POST",
    token: ownerToken,
    body: {
      propertyId: property.id,
      code: `BAD${uniq()}`.toUpperCase(),
      name: "Impossible",
      baseOccupancy: 4,
      maxOccupancy: 2,
      baseRateMinor: 100000,
    },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.error.code, "INVALID_OCCUPANCY");

  const created = await call("/config/room-types", {
    method: "POST",
    token: ownerToken,
    body: {
      propertyId: property.id,
      code: roomTypeCode,
      name: "Garden Suite",
      baseOccupancy: 2,
      maxOccupancy: 4,
      baseRateMinor: 7500000,
      amenityIds: [amenityId],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  roomTypeId = created.data.id;

  const list = await call(`/config/room-types?propertyId=${property.id}`, { token: ownerToken });
  const found = list.data.find((t) => t.id === roomTypeId);
  assert.equal(found.amenities.length, 1);
  assert.equal(found.amenities[0].amenity.id, amenityId);
});

test("room type rates are stored as integer minor units", async () => {
  const updated = await call(`/config/room-types/${roomTypeId}`, {
    method: "PATCH",
    token: ownerToken,
    body: { baseRateMinor: 8000000 },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.baseRateMinor, 8000000);
  assert.ok(Number.isInteger(updated.data.baseRateMinor), "money must never be fractional");
});

// ── Rooms & imports ──────────────────────────────────────────────────────

let roomId;

test("rooms can be created and duplicates are rejected", async () => {
  const roomNumber = `9${uniq().slice(0, 2)}`;
  const created = await call("/config/rooms", {
    method: "POST",
    token: ownerToken,
    body: { propertyId: property.id, roomTypeId, roomNumber, floor: 9 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  roomId = created.data.id;

  const dup = await call("/config/rooms", {
    method: "POST",
    token: ownerToken,
    body: { propertyId: property.id, roomTypeId, roomNumber, floor: 9 },
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error.code, "ROOM_EXISTS");
});

test("room import validates the whole file before writing anything", async () => {
  const good = `R${uniq().slice(0, 3)}`;
  const csv = [
    "room_number,room_type_code,floor",
    `${good}1,${roomTypeCode},7`,
    `${good}2,NOSUCHTYPE,7`, // invalid row
  ].join("\n");

  const failed = await call("/config/imports/rooms", {
    method: "POST",
    token: ownerToken,
    body: { propertyId: property.id, csv },
  });
  assert.equal(failed.status, 400);
  assert.equal(failed.data.error.code, "IMPORT_VALIDATION_FAILED");
  assert.equal(failed.data.error.details.errors[0].line, 3, "reports the offending line number");

  // Nothing was written — the valid row on line 2 must not exist.
  const rooms = await call(`/config/rooms?propertyId=${property.id}`, { token: ownerToken });
  assert.ok(
    !rooms.data.some((r) => r.roomNumber === `${good}1`),
    "a partially valid import must write nothing"
  );
});

test("room import dry run reports without writing, then commits", async () => {
  const p = `D${uniq().slice(0, 3)}`;
  const csv = [
    "room_number,room_type_code,floor",
    `${p}1,${roomTypeCode},8`,
    `${p}2,${roomTypeCode},8`,
  ].join("\n");

  const dry = await call("/config/imports/rooms", {
    method: "POST",
    token: ownerToken,
    body: { propertyId: property.id, csv, dryRun: true },
  });
  assert.equal(dry.status, 201);
  assert.equal(dry.data.dryRun, true);
  assert.equal(dry.data.wouldCreate, 2);

  const beforeCommit = await call(`/config/rooms?propertyId=${property.id}`, { token: ownerToken });
  assert.ok(!beforeCommit.data.some((r) => r.roomNumber === `${p}1`), "dry run must not write");

  const commit = await call("/config/imports/rooms", {
    method: "POST",
    token: ownerToken,
    body: { propertyId: property.id, csv },
  });
  assert.equal(commit.status, 201);
  assert.equal(commit.data.created, 2);

  const after = await call(`/config/rooms?propertyId=${property.id}`, { token: ownerToken });
  assert.ok(after.data.some((r) => r.roomNumber === `${p}1`));
});

test("import rejects a file with duplicate room numbers inside it", async () => {
  const p = `Z${uniq().slice(0, 3)}`;
  const csv = [
    "room_number,room_type_code,floor",
    `${p}1,${roomTypeCode},5`,
    `${p}1,${roomTypeCode},5`,
  ].join("\n");
  const res = await call("/config/imports/rooms", {
    method: "POST",
    token: ownerToken,
    body: { propertyId: property.id, csv },
  });
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(res.data.error.details.errors), /duplicated/);
});

test("import rejects a file missing required columns", async () => {
  const res = await call("/config/imports/rooms", {
    method: "POST",
    token: ownerToken,
    body: { propertyId: property.id, csv: "room_number\n101\n" },
  });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, "CSV_INVALID");
  assert.match(res.data.error.message, /room_type_code/);
});

// ── Room blocks ──────────────────────────────────────────────────────────

test("a room block removes the room from sale and can be released", async () => {
  const block = await call("/config/room-blocks", {
    method: "POST",
    token: ownerToken,
    body: {
      propertyId: property.id,
      roomId,
      type: "OUT_OF_ORDER",
      reason: "Bathroom refit",
      startDate: businessDate,
      endDate: addDays(businessDate, 3),
    },
  });
  assert.equal(block.status, 201, JSON.stringify(block.data));

  const rack = await call(`/properties/${property.id}/room-rack`, { token: ownerToken });
  const blocked = rack.data.find((r) => r.id === roomId);
  assert.equal(blocked.operationalStatus, "OUT_OF_ORDER");

  const release = await call(`/config/room-blocks/${block.data.id}/release`, {
    method: "POST",
    token: ownerToken,
  });
  assert.equal(release.status, 201);

  const rack2 = await call(`/properties/${property.id}/room-rack`, { token: ownerToken });
  const released = rack2.data.find((r) => r.id === roomId);
  assert.equal(
    released.operationalStatus,
    "VACANT_DIRTY",
    "a released room returns through housekeeping, not straight to sellable"
  );
});

test("a block cannot be placed over an existing booking", async () => {
  // Find an in-house room from the seeded data.
  const rack = await call(`/properties/${property.id}/room-rack`, { token: ownerToken });
  const occupied = rack.data.find((r) => r.occupant);
  if (!occupied) return; // nothing in house right now

  const res = await call("/config/room-blocks", {
    method: "POST",
    token: ownerToken,
    body: {
      propertyId: property.id,
      roomId: occupied.id,
      reason: "Attempt to block an occupied room",
      startDate: businessDate,
      endDate: addDays(businessDate, 2),
    },
  });
  assert.equal(res.status, 409);
  assert.equal(res.data.error.code, "ROOM_HAS_BOOKINGS");
});

test("block dates are validated", async () => {
  const res = await call("/config/room-blocks", {
    method: "POST",
    token: ownerToken,
    body: {
      propertyId: property.id,
      roomId,
      reason: "Backwards range",
      startDate: addDays(businessDate, 3),
      endDate: businessDate,
    },
  });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, "INVALID_DATE_RANGE");
});

// ── Referential safety ───────────────────────────────────────────────────

test("a room type in use cannot be deleted", async () => {
  const res = await call(`/config/room-types/${roomTypeId}`, {
    method: "DELETE",
    token: ownerToken,
  });
  assert.equal(res.status, 409);
  assert.equal(res.data.error.code, "ROOM_TYPE_IN_USE");
});

test("a room with reservation history cannot be deleted", async () => {
  const rack = await call(`/properties/${property.id}/room-rack`, { token: ownerToken });
  const withHistory = rack.data.find((r) => r.occupant);
  if (!withHistory) return;
  const res = await call(`/config/rooms/${withHistory.id}`, {
    method: "DELETE",
    token: ownerToken,
  });
  assert.equal(res.status, 409);
  assert.equal(res.data.error.code, "ROOM_HAS_HISTORY");
});

test("a room that has been blocked keeps its history and refuses hard delete", async () => {
  // roomId was blocked and released earlier, so it now has history.
  const res = await call(`/config/rooms/${roomId}`, { method: "DELETE", token: ownerToken });
  assert.equal(res.status, 409);
  assert.equal(res.data.error.code, "ROOM_HAS_HISTORY");
  assert.equal(res.data.error.details.blocks, 1, "the released block still counts as history");
});

test("cleanup: freshly imported rooms and the test room type are removed", async () => {
  const rooms = await call(`/config/rooms?propertyId=${property.id}`, { token: ownerToken });
  const mine = rooms.data.filter((r) => r.roomType.id === roomTypeId && r.id !== roomId);
  for (const r of mine) {
    const del = await call(`/config/rooms/${r.id}`, { method: "DELETE", token: ownerToken });
    assert.equal(del.status, 200, `failed to delete room ${r.roomNumber}`);
  }

  // The blocked room still uses the type, so the type cannot go yet — that is
  // the referential rule working, not a cleanup failure.
  const stillInUse = await call(`/config/room-types/${roomTypeId}`, {
    method: "DELETE",
    token: ownerToken,
  });
  assert.equal(stillInUse.status, 409);
  assert.equal(stillInUse.data.error.code, "ROOM_TYPE_IN_USE");

  const delAmenity = await call(`/config/amenities/${amenityId}`, {
    method: "DELETE",
    token: ownerToken,
  });
  assert.equal(delAmenity.status, 200);
});
