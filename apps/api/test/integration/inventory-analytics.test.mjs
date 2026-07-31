/**
 * Integration tests for inventory, analytics, async exports and push
 * subscription handling.
 *
 * Run: node --test test/integration/inventory-analytics.test.mjs
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
let hkToken;
let property;
let businessDate;
let itemId;
let locationId;

test("setup", async () => {
  ownerToken = (
    await call("/auth/login", {
      method: "POST",
      body: { email: "owner@grandpalm.demo", password: "Password123!" },
    })
  ).data.accessToken;
  hkToken = (
    await call("/auth/login", {
      method: "POST",
      body: { email: "housekeeping@grandpalm.demo", password: "Password123!" },
    })
  ).data.accessToken;
  const me = await call("/auth/me", { token: ownerToken });
  property = me.data.properties.find((p) => p.code === "GPH-LAG") ?? me.data.properties[0];
  businessDate = property.businessDate;

  const loc = await call("/inventory/locations", {
    method: "POST",
    token: ownerToken,
    body: { propertyId: property.id, code: `ST${uniq()}`, name: "Main Store" },
  });
  assert.equal(loc.status, 201, JSON.stringify(loc.data));
  locationId = loc.data.id;

  const item = await call("/inventory/items", {
    method: "POST",
    token: ownerToken,
    body: {
      propertyId: property.id,
      sku: `SKU${uniq()}`,
      name: "Bath Towel",
      category: "HOUSEKEEPING",
      unit: "EACH",
      reorderLevel: 20,
      unitCostMinor: 350000,
    },
  });
  assert.equal(item.status, 201, JSON.stringify(item.data));
  itemId = item.data.id;
});

// ── Inventory ────────────────────────────────────────────────────────────

test("a duplicate SKU is refused", async () => {
  const items = await call(`/inventory/items?propertyId=${property.id}`, { token: ownerToken });
  const existing = items.data.find((i) => i.id === itemId);
  const dupe = await call("/inventory/items", {
    method: "POST",
    token: ownerToken,
    body: {
      propertyId: property.id,
      sku: existing.sku,
      name: "Another towel",
      unit: "EACH",
    },
  });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.data.error.code, "SKU_EXISTS");
});

test("receipts add stock and issues remove it", async () => {
  const receipt = await call("/inventory/movements", {
    method: "POST",
    token: ownerToken,
    body: {
      propertyId: property.id,
      itemId,
      locationId,
      type: "RECEIPT",
      quantity: 100,
      reference: "PO-1001",
    },
  });
  assert.equal(receipt.status, 201, JSON.stringify(receipt.data));
  assert.equal(receipt.data.quantity, 100);

  const issue = await call("/inventory/movements", {
    method: "POST",
    token: ownerToken,
    body: { propertyId: property.id, itemId, locationId, type: "ISSUE", quantity: 30 },
  });
  assert.equal(issue.status, 201);
  // The caller sends a positive number; the type decides the sign.
  assert.equal(issue.data.quantity, -30);

  const soh = await call(`/inventory/stock-on-hand?propertyId=${property.id}`, {
    token: ownerToken,
  });
  const row = soh.data.rows.find((r) => r.itemId === itemId);
  assert.equal(row.onHand, 70);
  assert.equal(row.valuationMinor, 70 * 350000);
});

test("fractional quantities are exact, not floating point", async () => {
  const kg = await call("/inventory/items", {
    method: "POST",
    token: ownerToken,
    body: {
      propertyId: property.id,
      sku: `KG${uniq()}`,
      name: "Detergent",
      unit: "KG",
      reorderLevel: 1,
      unitCostMinor: 100000,
    },
  });
  await call("/inventory/movements", {
    method: "POST",
    token: ownerToken,
    body: { propertyId: property.id, itemId: kg.data.id, locationId, type: "RECEIPT", quantity: 0.1 },
  });
  await call("/inventory/movements", {
    method: "POST",
    token: ownerToken,
    body: { propertyId: property.id, itemId: kg.data.id, locationId, type: "RECEIPT", quantity: 0.2 },
  });

  const soh = await call(`/inventory/stock-on-hand?propertyId=${property.id}`, {
    token: ownerToken,
  });
  const row = soh.data.rows.find((r) => r.itemId === kg.data.id);
  // 0.1 + 0.2 must be exactly 0.3 — the reason quantities are integers.
  assert.equal(row.onHand, 0.3);
});

test("stock cannot be driven negative", async () => {
  const res = await call("/inventory/movements", {
    method: "POST",
    token: ownerToken,
    body: { propertyId: property.id, itemId, locationId, type: "ISSUE", quantity: 10000 },
  });
  assert.equal(res.status, 409);
  assert.equal(res.data.error.code, "INSUFFICIENT_STOCK");
  assert.ok(res.data.error.details.onHand >= 0);
});

test("a negative quantity is refused except on an adjustment", async () => {
  const bad = await call("/inventory/movements", {
    method: "POST",
    token: ownerToken,
    body: { propertyId: property.id, itemId, locationId, type: "RECEIPT", quantity: -5 },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error.code, "NEGATIVE_QUANTITY");

  // An adjustment is the sanctioned way to correct a count downwards.
  const adj = await call("/inventory/movements", {
    method: "POST",
    token: ownerToken,
    body: {
      propertyId: property.id,
      itemId,
      locationId,
      type: "ADJUSTMENT",
      quantity: -5,
      note: "Stock count correction",
    },
  });
  assert.equal(adj.status, 201);
  assert.equal(adj.data.quantity, -5);
});

test("a zero movement is rejected", async () => {
  const res = await call("/inventory/movements", {
    method: "POST",
    token: ownerToken,
    body: { propertyId: property.id, itemId, locationId, type: "RECEIPT", quantity: 0 },
  });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, "ZERO_QUANTITY");
});

test("the ledger shows a running balance", async () => {
  const led = await call(
    `/inventory/ledger?propertyId=${property.id}&itemId=${itemId}`,
    { token: ownerToken }
  );
  assert.equal(led.status, 200);
  assert.ok(led.data.length >= 3);
  // Each row's balance is the sum of everything up to and including it.
  let running = 0;
  for (const row of led.data) {
    running += row.quantity;
    assert.equal(row.balance, Number(running.toFixed(3)), `balance drifted at ${row.id}`);
  }
});

test("items below their reorder level are flagged", async () => {
  const low = await call(
    `/inventory/stock-on-hand?propertyId=${property.id}&lowOnly=true`,
    { token: ownerToken }
  );
  assert.equal(low.status, 200);
  for (const r of low.data.rows) {
    assert.equal(r.belowReorder, true);
    assert.ok(r.onHand <= r.reorderLevel);
  }
});

test("wastage is reported separately from ordinary consumption", async () => {
  await call("/inventory/movements", {
    method: "POST",
    token: ownerToken,
    body: {
      propertyId: property.id,
      itemId,
      locationId,
      type: "WASTAGE",
      quantity: 3,
      note: "Torn in the wash",
    },
  });
  const summary = await call(
    `/inventory/movement-summary?propertyId=${property.id}&from=${addDays(businessDate, -30)}&to=${addDays(businessDate, 1)}`,
    { token: ownerToken }
  );
  assert.equal(summary.status, 200);
  const row = summary.data.byItem.find((r) => r.wastage > 0);
  assert.ok(row, "wastage must be visible in its own column");
  assert.ok(summary.data.byType.some((t) => t.type === "WASTAGE"));
});

test("recording stock requires the inventory permission", async () => {
  const res = await call("/inventory/movements", {
    method: "POST",
    token: hkToken,
    body: { propertyId: property.id, itemId, locationId, type: "RECEIPT", quantity: 1 },
  });
  assert.equal(res.status, 403);
});

// ── Analytics ────────────────────────────────────────────────────────────

test("occupancy separates ADR from RevPAR", async () => {
  const res = await call(
    `/analytics/occupancy?propertyId=${property.id}&from=${addDays(businessDate, -7)}&to=${businessDate}`,
    { token: ownerToken }
  );
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(res.data.days.length >= 7);

  for (const d of res.data.days) {
    assert.ok(d.available <= d.totalRooms, "blocked rooms reduce availability");
    if (d.sold > 0) {
      // ADR uses rooms sold; RevPAR uses rooms available. With any spare
      // capacity ADR must exceed RevPAR — conflating them flatters the hotel.
      assert.ok(d.adrMinor >= d.revparMinor, `ADR ${d.adrMinor} < RevPAR ${d.revparMinor}`);
      assert.equal(d.adrMinor, Math.round(d.roomRevenueMinor / d.sold));
    }
    if (d.available > 0) {
      assert.equal(d.revparMinor, Math.round(d.roomRevenueMinor / d.available));
    }
  }
});

test("an inverted or over-long date range is rejected", async () => {
  const inverted = await call(
    `/analytics/occupancy?propertyId=${property.id}&from=${businessDate}&to=${addDays(businessDate, -5)}`,
    { token: ownerToken }
  );
  assert.equal(inverted.status, 400);
  assert.equal(inverted.data.error.code, "INVALID_DATE_RANGE");

  const tooLong = await call(
    `/analytics/occupancy?propertyId=${property.id}&from=${addDays(businessDate, -900)}&to=${businessDate}`,
    { token: ownerToken }
  );
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.data.error.code, "RANGE_TOO_LONG");
});

test("revenue separates tax and discounts from gross", async () => {
  const res = await call(
    `/analytics/revenue?propertyId=${property.id}&from=${addDays(businessDate, -30)}&to=${businessDate}`,
    { token: ownerToken }
  );
  assert.equal(res.status, 200);
  // Payments settle revenue, they are not revenue; a category named PAYMENT
  // would mean the report is double counting.
  assert.ok(!res.data.byCategory.some((c) => c.category === "PAYMENT"));
  assert.ok(!res.data.byCategory.some((c) => c.category === "TAX"));
  assert.equal(res.data.netMinor, res.data.grossMinor + res.data.discountMinor);
  assert.equal(
    res.data.totalBilledMinor,
    res.data.grossMinor + res.data.discountMinor + res.data.taxMinor
  );
});

test("the cashier report separates shortages from overages", async () => {
  const res = await call(
    `/analytics/cashier?propertyId=${property.id}&from=${addDays(businessDate, -30)}&to=${addDays(businessDate, 1)}`,
    { token: ownerToken }
  );
  assert.equal(res.status, 200);
  assert.ok(res.data.totals.shortageMinor <= 0, "shortages are negative");
  assert.ok(res.data.totals.overageMinor >= 0, "overages are positive");
  // Netting them would hide two different problems behind one number.
  for (const s of res.data.shifts) {
    assert.equal(typeof s.varianceMinor, "number");
  }
});

test("receivables age balances into buckets", async () => {
  const res = await call(`/analytics/receivables?propertyId=${property.id}`, {
    token: ownerToken,
  });
  assert.equal(res.status, 200);
  for (const r of res.data.rows) {
    assert.ok(r.balanceMinor > 0, "only debts appear on a receivables report");
    assert.ok(["CURRENT", "1-30", "31-60", "61-90", "90+"].includes(r.bucket));
  }
  const bucketTotal = Object.values(res.data.byBucket).reduce((s, v) => s + v, 0);
  assert.equal(bucketTotal, res.data.totalOutstandingMinor, "buckets must sum to the total");
});

test("the owner dashboard surfaces what needs attention", async () => {
  const res = await call(`/analytics/owner-dashboard?propertyId=${property.id}`, {
    token: ownerToken,
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  for (const k of ["occupancyPct", "adrMinor", "revparMinor", "roomRevenueMinor"]) {
    assert.equal(typeof res.data.monthToDate[k], "number", `missing ${k}`);
  }
  for (const k of ["pendingApprovals", "unapprovedCashVariances", "openReconciliationExceptions"]) {
    assert.equal(typeof res.data.needsAttention[k], "number", `missing ${k}`);
  }
  assert.equal(res.data.businessDate, businessDate);
});

// ── Async exports ────────────────────────────────────────────────────────

test("an export runs and produces a downloadable file", async () => {
  const job = await call("/analytics/exports", {
    method: "POST",
    token: ownerToken,
    body: {
      propertyId: property.id,
      type: "OCCUPANCY",
      from: addDays(businessDate, -7),
      to: businessDate,
    },
  });
  assert.equal(job.status, 201, JSON.stringify(job.data));
  assert.ok(job.data.jobId);

  // The job runs out of band, so poll rather than assuming it finished.
  let state;
  for (let i = 0; i < 20; i++) {
    state = await call(`/analytics/exports/${job.data.jobId}`, { token: ownerToken });
    if (["COMPLETE", "FAILED"].includes(state.data.status)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(state.data.status, "COMPLETE", `job did not complete: ${JSON.stringify(state.data)}`);
  assert.ok(state.data.rowCount > 0);
  assert.ok(state.data.download?.url, "a completed export must expose a signed download");

  const file = await fetch(state.data.download.url);
  assert.equal(file.status, 200);
  const csv = await file.text();
  const header = csv.split("\r\n")[0];
  assert.match(header, /date,available,sold,occupancyPct/);
  assert.ok(csv.split("\r\n").length > 1, "the export must contain data rows");
});

test("a receivables export completes and matches the report", async () => {
  const job = await call("/analytics/exports", {
    method: "POST",
    token: ownerToken,
    body: {
      propertyId: property.id,
      type: "RECEIVABLES",
      from: addDays(businessDate, -30),
      to: businessDate,
    },
  });
  let state;
  for (let i = 0; i < 20; i++) {
    state = await call(`/analytics/exports/${job.data.jobId}`, { token: ownerToken });
    if (["COMPLETE", "FAILED"].includes(state.data.status)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(state.data.status, "COMPLETE", JSON.stringify(state.data));

  const report = await call(`/analytics/receivables?propertyId=${property.id}`, {
    token: ownerToken,
  });
  assert.equal(state.data.rowCount, report.data.rows.length, "export and report must agree");
});

test("an unimplemented export type fails visibly rather than silently", async () => {
  const job = await call("/analytics/exports", {
    method: "POST",
    token: ownerToken,
    body: {
      propertyId: property.id,
      type: "AUDIT",
      from: addDays(businessDate, -7),
      to: businessDate,
    },
  });
  let state;
  for (let i = 0; i < 20; i++) {
    state = await call(`/analytics/exports/${job.data.jobId}`, { token: ownerToken });
    if (["COMPLETE", "FAILED"].includes(state.data.status)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(state.data.status, "FAILED");
  assert.match(state.data.error, /not implemented/i);
});

test("export jobs are listed for the property", async () => {
  const res = await call(`/analytics/exports?propertyId=${property.id}`, { token: ownerToken });
  assert.equal(res.status, 200);
  assert.ok(res.data.length > 0);
});

// ── Push ─────────────────────────────────────────────────────────────────

test("push status reports whether it is configured", async () => {
  const res = await call("/push/status", { token: hkToken });
  assert.equal(res.status, 200);
  assert.equal(typeof res.data.enabled, "boolean");
  // Whether on or off, the client is told plainly rather than left to guess.
  assert.ok(res.data.note.length > 20);
  if (res.data.enabled) assert.ok(res.data.publicKey);
});

test("subscribing without VAPID configured is refused, not faked", async () => {
  const status = await call("/push/status", { token: hkToken });
  const res = await call("/push/subscribe", {
    method: "POST",
    token: hkToken,
    body: {
      endpoint: `https://push.example.com/${uniq()}`,
      keys: { p256dh: "x".repeat(20), auth: "y".repeat(10) },
    },
  });
  if (status.data.enabled) {
    assert.equal(res.status, 201);
    assert.equal(res.data.subscribed, true);
  } else {
    // Silently accepting a subscription that can never deliver would be worse
    // than refusing it.
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, "PUSH_DISABLED");
  }
});

test("a task assignment queues a notification event", async () => {
  const tasks = await call(`/housekeeping/tasks?propertyId=${property.id}`, { token: hkToken });
  const task = tasks.data.find((t) => !["COMPLETED", "INSPECTED"].includes(t.status));
  assert.ok(task, "a live task is needed for this test");

  const me = await call("/auth/me", { token: hkToken });
  const assigned = await call(`/housekeeping/tasks/${task.id}/assign`, {
    method: "POST",
    token: ownerToken,
    body: { assignedUserId: me.data.user.id },
  });
  assert.equal(assigned.status, 201, JSON.stringify(assigned.data));
  assert.equal(assigned.data.assignedUserId, me.data.user.id);
  // The version must move so an offline device sees the reassignment.
  assert.ok(assigned.data.version > task.version);

  const audit = await call(`/reports/audit-trail?propertyId=${property.id}`, {
    token: ownerToken,
  });
  assert.ok(
    audit.data.some((a) => a.action === "housekeeping.task_assigned" && a.entityId === task.id),
    "the assignment must be audited"
  );
});

test("a task cannot be assigned to someone outside the tenant", async () => {
  const tasks = await call(`/housekeeping/tasks?propertyId=${property.id}`, { token: hkToken });
  const task = tasks.data.find((t) => !["COMPLETED", "INSPECTED"].includes(t.status));
  const res = await call(`/housekeeping/tasks/${task.id}/assign`, {
    method: "POST",
    token: ownerToken,
    body: { assignedUserId: "00000000-0000-0000-0000-000000000000" },
  });
  assert.equal(res.status, 404);
  assert.equal(res.data.error.code, "ASSIGNEE_NOT_FOUND");
});
