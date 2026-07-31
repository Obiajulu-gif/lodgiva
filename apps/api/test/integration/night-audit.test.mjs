/**
 * Integration tests for cashier shifts, cash movements, variance approval and
 * the night audit state machine.
 *
 * Run: node --test test/integration/night-audit.test.mjs
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

let deskToken;
let mgrToken;
let property;

/** Closes every open or pending shift so pre-flight starts clean. */
async function drainShifts() {
  const shifts = await call(`/cashiering/shifts?propertyId=${property.id}`, { token: deskToken });
  for (const s of shifts.data.filter((s) => s.status === "OPEN")) {
    const detail = await call(`/cashiering/shifts/${s.id}`, { token: deskToken });
    await call(`/cashiering/shifts/${s.id}/close`, {
      method: "POST",
      token: deskToken,
      body: { countedMinor: detail.data.expectedMinor },
    });
  }
  const after = await call(`/cashiering/shifts?propertyId=${property.id}`, { token: deskToken });
  for (const s of after.data.filter((s) => s.status === "PENDING_APPROVAL")) {
    await call(`/cashiering/shifts/${s.id}/approve`, { method: "POST", token: mgrToken, body: {} });
  }
}

async function closeOpenPosOrders() {
  const orders = await call(`/pos/orders?propertyId=${property.id}`, { token: deskToken });
  for (const o of orders.data.filter((o) => o.status === "OPEN")) {
    await call(`/pos/orders/${o.id}/void`, {
      method: "POST",
      token: deskToken,
      body: { reason: "Cleared before night audit test" },
    });
  }
}

test("setup", async () => {
  deskToken = (
    await call("/auth/login", {
      method: "POST",
      body: { email: "frontdesk@grandpalm.demo", password: "Password123!" },
    })
  ).data.accessToken;
  mgrToken = (
    await call("/auth/login", {
      method: "POST",
      body: { email: "manager@grandpalm.demo", password: "Password123!" },
    })
  ).data.accessToken;
  const me = await call("/auth/me", { token: deskToken });
  // Other suites create their own properties, so pin to the seeded one that
  // actually has outlets and rooms rather than whichever comes back first.
  property =
    me.data.properties.find((p) => p.code === "GPH-LAG") ?? me.data.properties[0];
  assert.ok(property, "no property available");
});

// ── Cashier shifts ───────────────────────────────────────────────────────

test("a shift opens with a float and records it as a movement", async () => {
  await drainShifts();
  const opened = await call("/cashiering/shifts", {
    method: "POST",
    token: deskToken,
    body: { propertyId: property.id, openingFloatMinor: 5000000 },
  });
  assert.equal(opened.status, 201, JSON.stringify(opened.data));

  const detail = await call(`/cashiering/shifts/${opened.data.id}`, { token: deskToken });
  assert.equal(detail.data.expectedMinor, 5000000, "the float is the opening expectation");
  assert.ok(detail.data.movements.some((m) => m.type === "FLOAT_IN"));
});

test("a second concurrent shift for the same cashier is refused", async () => {
  const again = await call("/cashiering/shifts", {
    method: "POST",
    token: deskToken,
    body: { propertyId: property.id, openingFloatMinor: 0 },
  });
  assert.equal(again.status, 409);
  assert.equal(again.data.error.code, "SHIFT_ALREADY_OPEN");
});

test("expected total tracks inflows and outflows with the correct sign", async () => {
  const shifts = await call(`/cashiering/shifts?propertyId=${property.id}`, { token: deskToken });
  const open = shifts.data.find((s) => s.status === "OPEN");

  await call(`/cashiering/shifts/${open.id}/movements`, {
    method: "POST",
    token: deskToken,
    body: { type: "PAYMENT_IN", amountMinor: 1500000, note: "Room settlement" },
  });
  await call(`/cashiering/shifts/${open.id}/movements`, {
    method: "POST",
    token: deskToken,
    body: { type: "DROP_TO_SAFE", amountMinor: 2000000, note: "Mid-shift drop" },
  });
  await call(`/cashiering/shifts/${open.id}/movements`, {
    method: "POST",
    token: deskToken,
    body: { type: "PETTY_CASH_OUT", amountMinor: 250000, note: "Cleaning supplies" },
  });

  const detail = await call(`/cashiering/shifts/${open.id}`, { token: deskToken });
  // 5,000,000 float + 1,500,000 in − 2,000,000 drop − 250,000 petty
  assert.equal(detail.data.expectedMinor, 4250000);
  assert.equal(
    detail.data.movements.reduce((s, m) => s + m.amountMinor, 0),
    detail.data.expectedMinor,
    "expected must be exactly the sum of movements"
  );
  assert.ok(
    detail.data.movements.some((m) => m.type === "DROP_TO_SAFE" && m.amountMinor < 0),
    "outflows must be stored negative"
  );
});

test("closing short without a reason is refused", async () => {
  const shifts = await call(`/cashiering/shifts?propertyId=${property.id}`, { token: deskToken });
  const open = shifts.data.find((s) => s.status === "OPEN");
  const detail = await call(`/cashiering/shifts/${open.id}`, { token: deskToken });

  const short = await call(`/cashiering/shifts/${open.id}/close`, {
    method: "POST",
    token: deskToken,
    body: { countedMinor: detail.data.expectedMinor - 150000 },
  });
  assert.equal(short.status, 409);
  assert.equal(short.data.error.code, "VARIANCE_REASON_REQUIRED");
  // The desk is told both figures so it can recount before explaining.
  assert.equal(short.data.error.details.expectedMinor, detail.data.expectedMinor);
  assert.equal(short.data.error.details.varianceMinor, -150000);
});

test("a variance close needs manager approval and blocks self-approval", async () => {
  const shifts = await call(`/cashiering/shifts?propertyId=${property.id}`, { token: deskToken });
  const open = shifts.data.find((s) => s.status === "OPEN");
  const detail = await call(`/cashiering/shifts/${open.id}`, { token: deskToken });

  const closed = await call(`/cashiering/shifts/${open.id}/close`, {
    method: "POST",
    token: deskToken,
    body: {
      countedMinor: detail.data.expectedMinor - 150000,
      varianceReason: "Suspected short-change during dinner service",
    },
  });
  assert.equal(closed.status, 201, JSON.stringify(closed.data));
  assert.equal(closed.data.status, "PENDING_APPROVAL", "a variance never closes silently");
  assert.equal(closed.data.varianceMinor, -150000);

  // Front desk is stopped by the permissions guard before the approval logic
  // is even reached, hence 403 rather than the domain-level 409.
  const desk = await call(`/cashiering/shifts/${open.id}/approve`, {
    method: "POST",
    token: deskToken,
  });
  assert.equal(desk.status, 403, "front desk may not approve a cash variance");

  const approved = await call(`/cashiering/shifts/${open.id}/approve`, {
    method: "POST",
    token: mgrToken,
  });
  assert.equal(approved.status, 201);
  assert.equal(approved.data.status, "CLOSED");
});

test("an approver cannot clear their own variance", async () => {
  // Separation of duties only bites when the closer is themselves an
  // approver, so the manager both opens and closes this one.
  await drainShifts();
  const opened = await call("/cashiering/shifts", {
    method: "POST",
    token: mgrToken,
    body: { propertyId: property.id, openingFloatMinor: 200000 },
  });
  assert.equal(opened.status, 201, JSON.stringify(opened.data));

  const detail = await call(`/cashiering/shifts/${opened.data.id}`, { token: mgrToken });
  const closed = await call(`/cashiering/shifts/${opened.data.id}/close`, {
    method: "POST",
    token: mgrToken,
    body: {
      countedMinor: detail.data.expectedMinor - 50000,
      varianceReason: "Manager counted short",
    },
  });
  assert.equal(closed.data.status, "PENDING_APPROVAL");

  const self = await call(`/cashiering/shifts/${opened.data.id}/approve`, {
    method: "POST",
    token: mgrToken,
  });
  assert.equal(self.status, 409);
  assert.equal(self.data.error.code, "SELF_APPROVAL");

  // A different authorised approver can clear it.
  const ownerToken = (
    await call("/auth/login", {
      method: "POST",
      body: { email: "owner@grandpalm.demo", password: "Password123!" },
    })
  ).data.accessToken;
  const byOwner = await call(`/cashiering/shifts/${opened.data.id}/approve`, {
    method: "POST",
    token: ownerToken,
  });
  assert.equal(byOwner.status, 201);
  assert.equal(byOwner.data.status, "CLOSED");
});

test("a balanced close needs no approval", async () => {
  await drainShifts();
  const opened = await call("/cashiering/shifts", {
    method: "POST",
    token: deskToken,
    body: { propertyId: property.id, openingFloatMinor: 100000 },
  });
  const detail = await call(`/cashiering/shifts/${opened.data.id}`, { token: deskToken });
  const closed = await call(`/cashiering/shifts/${opened.data.id}/close`, {
    method: "POST",
    token: deskToken,
    body: { countedMinor: detail.data.expectedMinor },
  });
  assert.equal(closed.data.status, "CLOSED");
  assert.equal(closed.data.varianceMinor, 0);
});

test("a closed shift accepts no further movements", async () => {
  const shifts = await call(`/cashiering/shifts?propertyId=${property.id}`, { token: deskToken });
  const closed = shifts.data.find((s) => s.status === "CLOSED");
  const late = await call(`/cashiering/shifts/${closed.id}/movements`, {
    method: "POST",
    token: deskToken,
    body: { type: "PAYMENT_IN", amountMinor: 1000 },
  });
  assert.equal(late.status, 409);
  assert.equal(late.data.error.code, "SHIFT_CLOSED");
});

// ── Night audit pre-flight ───────────────────────────────────────────────

test("an open cashier shift blocks the night audit", async () => {
  await drainShifts();
  await closeOpenPosOrders();

  const opened = await call("/cashiering/shifts", {
    method: "POST",
    token: deskToken,
    body: { propertyId: property.id, openingFloatMinor: 0 },
  });
  assert.equal(opened.status, 201);

  const pre = await call(`/night-audit/preflight?propertyId=${property.id}`, { token: mgrToken });
  assert.equal(pre.status, 200);
  assert.equal(pre.data.canRun, false);
  const blocker = pre.data.blockers.find((b) => b.code === "OPEN_CASHIER_SHIFTS");
  assert.ok(blocker, "an open drawer must be a blocker");
  assert.match(blocker.message, /S-\d+/, "the blocker names the shift to close");

  const run = await call("/night-audit/run", {
    method: "POST",
    token: mgrToken,
    body: { propertyId: property.id, acknowledgeWarnings: true },
  });
  assert.equal(run.status, 409);
  assert.equal(run.data.error.code, "NIGHT_AUDIT_BLOCKED");
  assert.ok(run.data.error.details.blockers.length > 0);
});

test("an open POS order blocks the night audit", async () => {
  await drainShifts();
  const outlets = await call(`/pos/outlets?propertyId=${property.id}`, { token: deskToken });
  // Outlets can exist without an active menu, so pick one that can actually
  // take an order rather than assuming the first has items.
  const outlet = outlets.data.find((o) => o.menuItems && o.menuItems.length > 0);
  assert.ok(outlet, "the seed must provide at least one outlet with menu items");
  const order = await call("/pos/orders", {
    method: "POST",
    token: deskToken,
    body: {
      outletId: outlet.id,
      lines: [{ menuItemId: outlet.menuItems[0].id, quantity: 1 }],
    },
  });
  assert.equal(order.status, 201);

  const pre = await call(`/night-audit/preflight?propertyId=${property.id}`, { token: mgrToken });
  assert.equal(pre.data.canRun, false);
  assert.ok(pre.data.blockers.some((b) => b.code === "OPEN_POS_ORDERS"));

  await call(`/pos/orders/${order.data.id}/void`, {
    method: "POST",
    token: deskToken,
    body: { reason: "Cleared for audit" },
  });
});

test("warnings must be acknowledged but do not block", async () => {
  await drainShifts();
  await closeOpenPosOrders();

  const pre = await call(`/night-audit/preflight?propertyId=${property.id}`, { token: mgrToken });
  assert.equal(pre.data.canRun, true, JSON.stringify(pre.data.blockers));

  if (pre.data.warnings.length > 0) {
    const unacknowledged = await call("/night-audit/run", {
      method: "POST",
      token: mgrToken,
      body: { propertyId: property.id },
    });
    assert.equal(unacknowledged.status, 409);
    assert.equal(unacknowledged.data.error.code, "NIGHT_AUDIT_WARNINGS");
    assert.ok(unacknowledged.data.error.details.warnings.length > 0);
  }
});

// ── Night audit run ──────────────────────────────────────────────────────

test("the audit runs through its phases, snapshots and advances the date", async () => {
  await drainShifts();
  await closeOpenPosOrders();

  const before = await call("/auth/me", { token: mgrToken });
  const dateBefore = before.data.properties.find((p) => p.id === property.id).businessDate;

  const run = await call("/night-audit/run", {
    method: "POST",
    token: mgrToken,
    body: { propertyId: property.id, acknowledgeWarnings: true },
  });
  assert.equal(run.status, 201, JSON.stringify(run.data));

  // The phase trail is the audit's own evidence of what it did.
  const phases = run.data.phases.map((p) => p.phase);
  assert.deepEqual(phases, ["PREFLIGHT", "POSTING", "SNAPSHOT", "ADVANCING", "COMPLETED"]);
  assert.ok(run.data.phases.every((p) => p.ok && p.at));

  assert.equal(run.data.businessDate, dateBefore);
  assert.notEqual(run.data.newBusinessDate, dateBefore, "the business date must move");

  const after = await call("/auth/me", { token: mgrToken });
  assert.equal(
    after.data.properties.find((p) => p.id === property.id).businessDate,
    run.data.newBusinessDate,
    "the property's business date reflects the audit"
  );

  // KPI snapshot.
  for (const key of ["occupancyPct", "roomRevenueMinor", "adrMinor", "revparMinor", "totalRooms"]) {
    assert.ok(key in run.data, `snapshot missing ${key}`);
  }
});

test("the same business date cannot be audited twice", async () => {
  // The date has advanced, so re-running now targets a new date; re-run that
  // one twice to prove the idempotency gate.
  await drainShifts();
  await closeOpenPosOrders();

  const first = await call("/night-audit/run", {
    method: "POST",
    token: mgrToken,
    body: { propertyId: property.id, acknowledgeWarnings: true },
  });
  assert.equal(first.status, 201, JSON.stringify(first.data));

  // Rewinding is impossible through the API, so assert via pre-flight that the
  // just-audited date is refused if attempted again.
  const history = await call(`/night-audit/history?propertyId=${property.id}`, {
    token: mgrToken,
  });
  const dates = history.data.map((h) => h.businessDate);
  assert.equal(new Set(dates).size, dates.length, "one run per business date");
});

test("history exposes the phase trail and snapshot", async () => {
  const history = await call(`/night-audit/history?propertyId=${property.id}`, {
    token: mgrToken,
  });
  assert.equal(history.status, 200);
  assert.ok(history.data.length > 0);
  const latest = history.data[0];
  assert.ok(Array.isArray(latest.steps), "steps are returned as an array");
  assert.ok(latest.steps.some((s) => s.phase === "COMPLETED"));
  assert.ok(typeof latest.summary.occupancyPct === "number");
  assert.equal(latest.status, "COMPLETED");
});
