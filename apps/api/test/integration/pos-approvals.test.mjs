/**
 * Integration tests for POS void approvals and the completed export types.
 *
 * The approval rule itself is unit-tested in test/unit/pos-void.test.mjs (the
 * aged-order branch cannot be produced here without waiting fifteen real
 * minutes); what is asserted here is that the state actually moves, that a
 * pending void cannot be settled around, and that the decision is separated
 * from the request.
 *
 * Run: node --test test/integration/pos-approvals.test.mjs
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

const login = async (email) =>
  (
    await call("/auth/login", {
      method: "POST",
      body: { email, password: "Password123!" },
    })
  ).data.accessToken;

const SELF_SERVICE_MINOR = 500_000; // must match common/pos-void.ts

let deskToken; // FRONT_DESK — can operate POS, cannot approve
let mgrToken; // GENERAL_MANAGER — can approve
let ownerToken; // TENANT_OWNER — a second approver
let property;
let outlet;
let cheapItem;

/** Creates an order whose total lands on the requested side of the threshold. */
async function makeOrder({ large }) {
  const unit = Number(cheapItem.priceMinor);
  // Total carries service charge and tax on top of the line, so aim clear of
  // the threshold rather than exactly at it.
  const quantity = large ? Math.ceil((SELF_SERVICE_MINOR * 1.5) / unit) : 1;
  const res = await call("/pos/orders", {
    method: "POST",
    token: deskToken,
    body: { outletId: outlet.id, lines: [{ menuItemId: cheapItem.id, quantity }] },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const total = Number(res.data.totalMinor);
  if (large) assert.ok(total > SELF_SERVICE_MINOR, `expected a large order, got ${total}`);
  else assert.ok(total <= SELF_SERVICE_MINOR, `expected a small order, got ${total}`);
  return res.data;
}

const orderById = async (id, token = deskToken) => {
  const list = await call(`/pos/orders?propertyId=${property.id}`, { token });
  return list.data.find((o) => o.id === id);
};

test("setup", async () => {
  [deskToken, mgrToken, ownerToken] = await Promise.all([
    login("frontdesk@grandpalm.demo"),
    login("manager@grandpalm.demo"),
    login("owner@grandpalm.demo"),
  ]);
  const me = await call("/auth/me", { token: deskToken });
  property = me.data.properties.find((p) => p.code === "GPH-LAG") ?? me.data.properties[0];

  const outlets = await call(`/pos/outlets?propertyId=${property.id}`, { token: deskToken });
  // An outlet with no menu items cannot price an order, so pick one that can.
  outlet = outlets.data.find((o) => o.menuItems.length > 0);
  assert.ok(outlet, "the seed must provide an outlet with menu items");
  cheapItem = [...outlet.menuItems].sort((a, b) => Number(a.priceMinor) - Number(b.priceMinor))[0];
  assert.ok(Number(cheapItem.priceMinor) > 0);
});

// ── The self-service window ──────────────────────────────────────────────

test("a small order voided immediately needs no approval", async () => {
  const order = await makeOrder({ large: false });
  const res = await call(`/pos/orders/${order.id}/void`, {
    method: "POST",
    token: deskToken,
    body: { reason: "Wrong table keyed" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.status, "VOIDED");
  assert.equal((await orderById(order.id)).status, "VOIDED");
});

test("an approver may void a large order directly, on their own name", async () => {
  const order = await makeOrder({ large: true });
  const res = await call(`/pos/orders/${order.id}/void`, {
    method: "POST",
    token: mgrToken,
    body: { reason: "Kitchen could not fulfil" },
  });
  assert.equal(res.data.status, "VOIDED", JSON.stringify(res.data));

  const audit = await call(`/reports/audit-trail?propertyId=${property.id}`, { token: mgrToken });
  const entry = audit.data.find(
    (e) => e.entityId === order.id && e.action === "pos.order_voided"
  );
  assert.ok(entry, "a void must always leave an audit entry naming who did it");
});

// ── Above the threshold ──────────────────────────────────────────────────

test("a large void by front desk parks the order and raises a request", async () => {
  const order = await makeOrder({ large: true });
  const res = await call(`/pos/orders/${order.id}/void`, {
    method: "POST",
    token: deskToken,
    body: { reason: "Guest changed their mind" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.status, "PENDING_APPROVAL");
  assert.equal(res.data.request.type, "POS_VOID");
  assert.equal(Number(res.data.request.amountMinor), Number(order.totalMinor));
  assert.match(res.data.message, /supervisor/i, "the requester must be told why");

  const current = await orderById(order.id);
  assert.equal(current.status, "VOID_PENDING");
  // The order is not voided yet: the money is still owed until someone decides.
  assert.notEqual(current.status, "VOIDED");
});

test("a pending void cannot be settled around", async () => {
  const order = await makeOrder({ large: true });
  await call(`/pos/orders/${order.id}/void`, {
    method: "POST",
    token: deskToken,
    body: { reason: "Duplicate order" },
  });

  const settle = await call(`/pos/orders/${order.id}/settle`, {
    method: "POST",
    token: deskToken,
    body: { settlement: "CASH" },
  });
  assert.equal(settle.status, 409, JSON.stringify(settle.data));
  assert.equal(settle.data.error.code, "VOID_PENDING");

  // Nor can a second request be stacked on it.
  const again = await call(`/pos/orders/${order.id}/void`, {
    method: "POST",
    token: deskToken,
    body: { reason: "Trying again" },
  });
  assert.equal(again.status, 409);
  assert.equal(again.data.error.code, "VOID_PENDING");
});

test("the requester cannot approve their own void", async () => {
  const order = await makeOrder({ large: true });
  const req = await call(`/pos/orders/${order.id}/void`, {
    method: "POST",
    token: deskToken,
    body: { reason: "Self approval attempt" },
  });
  const requestId = req.data.request.id;

  const decide = await call(`/approvals/${requestId}/approve`, {
    method: "POST",
    token: deskToken,
    body: {},
  });
  assert.equal(decide.status, 403, JSON.stringify(decide.data));
  assert.equal(decide.data.error.code, "PERMISSION_DENIED");
  assert.equal((await orderById(order.id)).status, "VOID_PENDING", "the order must not move");

  // Clean up so this order does not block the night-audit assertion below.
  await call(`/approvals/${requestId}/reject`, { method: "POST", token: mgrToken, body: {} });
});

test("approval voids the order and closes the request", async () => {
  const order = await makeOrder({ large: true });
  const req = await call(`/pos/orders/${order.id}/void`, {
    method: "POST",
    token: deskToken,
    body: { reason: "Guest walked out" },
  });
  const requestId = req.data.request.id;

  const decide = await call(`/approvals/${requestId}/approve`, {
    method: "POST",
    token: mgrToken,
    body: { note: "Confirmed with the floor" },
  });
  assert.equal(decide.status, 201, JSON.stringify(decide.data));
  assert.equal(decide.data.status, "APPROVED");

  const current = await orderById(order.id);
  assert.equal(current.status, "VOIDED");
  assert.equal(current.voidReason, "Guest walked out", "the reason must survive the decision");

  const audit = await call(`/reports/audit-trail?propertyId=${property.id}`, { token: mgrToken });
  const entry = audit.data.find(
    (e) => e.entityId === order.id && e.action === "pos.order_voided"
  );
  assert.ok(entry, "the approved void must be recorded against the order, not only the request");
  assert.match(entry.summary, /supervisor/, "the entry must show it went through approval");
});

test("rejection returns the order to the floor with no trace of a void", async () => {
  const order = await makeOrder({ large: true });
  const req = await call(`/pos/orders/${order.id}/void`, {
    method: "POST",
    token: deskToken,
    body: { reason: "Claimed the guest cancelled" },
  });

  const decide = await call(`/approvals/${req.data.request.id}/reject`, {
    method: "POST",
    token: ownerToken,
    body: { note: "The guest was served; collect payment" },
  });
  assert.equal(decide.data.status, "REJECTED", JSON.stringify(decide.data));

  const current = await orderById(order.id);
  assert.equal(current.status, "OPEN", "a rejected void must put the order back");
  assert.equal(
    current.voidReason,
    null,
    "a stale reason would make a live order look like it had been voided"
  );

  // And it can now be settled, which is the whole point of rejecting it.
  const settle = await call(`/pos/orders/${order.id}/settle`, {
    method: "POST",
    token: deskToken,
    body: { settlement: "CASH" },
  });
  assert.equal(settle.status, 201, JSON.stringify(settle.data));
});

test("a settled order is never voidable, approval or not", async () => {
  const order = await makeOrder({ large: false });
  await call(`/pos/orders/${order.id}/settle`, {
    method: "POST",
    token: deskToken,
    body: { settlement: "CASH" },
  });
  const res = await call(`/pos/orders/${order.id}/void`, {
    method: "POST",
    token: mgrToken,
    body: { reason: "Too late" },
  });
  assert.equal(res.status, 409);
  assert.equal(res.data.error.code, "ORDER_SETTLED");
  assert.match(res.data.error.message, /reverse|refund/i, "it must say what to do instead");
});

test("deciding a request twice is refused", async () => {
  const order = await makeOrder({ large: true });
  const req = await call(`/pos/orders/${order.id}/void`, {
    method: "POST",
    token: deskToken,
    body: { reason: "Double decision test" },
  });
  const id = req.data.request.id;
  await call(`/approvals/${id}/approve`, { method: "POST", token: mgrToken, body: {} });
  const second = await call(`/approvals/${id}/reject`, {
    method: "POST",
    token: ownerToken,
    body: {},
  });
  assert.equal(second.status, 409, JSON.stringify(second.data));
  assert.equal(second.data.error.code, "ALREADY_DECIDED");
});

test("night audit refuses to close the day over an undecided void", async () => {
  const order = await makeOrder({ large: true });
  const req = await call(`/pos/orders/${order.id}/void`, {
    method: "POST",
    token: deskToken,
    body: { reason: "Left pending on purpose" },
  });

  const pre = await call(`/night-audit/preflight?propertyId=${property.id}`, { token: mgrToken });
  const blocker = pre.data.blockers.find((b) => b.code === "POS_VOIDS_AWAITING_APPROVAL");
  assert.ok(blocker, `expected a blocker, got ${JSON.stringify(pre.data.blockers)}`);
  assert.ok(blocker.count >= 1);

  // Decide every outstanding void — earlier tests deliberately leave some
  // parked — and the blocker must clear. A blocker that never clears would
  // stop the hotel closing its day forever, which is worse than not having one.
  const pending = await call(`/approvals?propertyId=${property.id}&status=PENDING`, {
    token: mgrToken,
  });
  for (const r of pending.data.filter((x) => x.type === "POS_VOID")) {
    const decided = await call(`/approvals/${r.id}/approve`, {
      method: "POST",
      token: mgrToken,
      body: {},
    });
    assert.equal(decided.status, 201, JSON.stringify(decided.data));
  }
  assert.ok(
    pending.data.some((r) => r.id === req.data.request.id),
    "the request just raised must be in the pending list"
  );
  const after = await call(`/night-audit/preflight?propertyId=${property.id}`, { token: mgrToken });
  assert.ok(
    !after.data.blockers.some((b) => b.code === "POS_VOIDS_AWAITING_APPROVAL"),
    "the blocker must clear once the void is decided"
  );
});

// ── Exports: the types that previously threw ─────────────────────────────

/** Polls a job to completion — exports run out of band. */
async function runExport(type, format, from, to) {
  const job = await call("/analytics/exports", {
    method: "POST",
    token: ownerToken,
    body: { propertyId: property.id, type, format, from, to },
  });
  assert.equal(job.status, 201, JSON.stringify(job.data));
  for (let i = 0; i < 40; i++) {
    const status = await call(`/analytics/exports/${job.data.jobId}`, { token: ownerToken });
    if (status.data.status === "COMPLETE" || status.data.status === "FAILED") return status.data;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`export ${type}/${format} did not finish`);
}

test("every declared export type produces a file", async () => {
  const to = property.businessDate;
  const from = new Date(Date.parse(to) - 30 * 86_400_000).toISOString().slice(0, 10);

  for (const type of [
    "DAILY_FLASH",
    "REVENUE",
    "OCCUPANCY",
    "CASHIER",
    "TAX",
    "RECEIVABLES",
    "GUEST_LEDGER",
    "AUDIT",
  ]) {
    const job = await runExport(type, "CSV", from, to);
    assert.equal(job.status, "COMPLETE", `${type} failed: ${job.error}`);
    assert.ok(job.download?.url, `${type} completed without a download link`);
  }
});

test("a PDF export downloads as a real PDF", async () => {
  const to = property.businessDate;
  const from = new Date(Date.parse(to) - 7 * 86_400_000).toISOString().slice(0, 10);
  const job = await runExport("OCCUPANCY", "PDF", from, to);
  assert.equal(job.status, "COMPLETE", job.error);

  const res = await fetch(job.download.url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.subarray(0, 5).toString("latin1") === "%PDF-", "must be a PDF, not a renamed CSV");
  assert.ok(buf.toString("latin1").trimEnd().endsWith("%%EOF"), "must be complete");
  // The figure the report exists for has to actually be on the page.
  assert.match(buf.toString("latin1"), /revparNaira|occupancyPct/);
});

test("an unknown export type fails loudly instead of returning an empty file", async () => {
  const res = await call("/analytics/exports", {
    method: "POST",
    token: ownerToken,
    body: {
      propertyId: property.id,
      type: "NOT_A_REPORT",
      format: "CSV",
      from: property.businessDate,
      to: property.businessDate,
    },
  });
  assert.equal(res.status, 400, JSON.stringify(res.data));
});
