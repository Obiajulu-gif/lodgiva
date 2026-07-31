/**
 * Integration tests for the sync contract and live updates.
 *
 * The browser-only parts (IndexedDB cache, service worker) are verified in
 * the browser and recorded in docs/api-reference.md; everything asserted here
 * is the server contract those clients depend on.
 *
 * Run: node --test test/integration/sync-live.test.mjs
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

const uniq = () => Math.random().toString(36).slice(2, 8);

let hkToken;
let mgrToken;
let property;

async function pendingTask() {
  const tasks = await call(`/housekeeping/tasks?propertyId=${property.id}`, { token: hkToken });
  const t = tasks.data.find((x) => x.status === "PENDING");
  if (t) return t;
  // Nothing pending: create one so the suite is not order-dependent.
  const rooms = await call(`/config/rooms?propertyId=${property.id}`, { token: mgrToken });
  const created = await call("/housekeeping/tasks", {
    method: "POST",
    token: mgrToken,
    body: {
      propertyId: property.id,
      roomId: rooms.data[0].id,
      type: "FULL_CLEAN",
      priority: "NORMAL",
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const again = await call(`/housekeeping/tasks?propertyId=${property.id}`, { token: hkToken });
  return again.data.find((x) => x.id === created.data.id);
}

function mutation(task, action, extra = {}) {
  return {
    operationId: `op_${uniq()}_${Date.now()}`,
    entityType: "housekeepingTask",
    entityId: task.id,
    baseVersion: task.version,
    action,
    occurredAt: new Date().toISOString(),
    payload: {},
    ...extra,
  };
}

test("setup", async () => {
  hkToken = (
    await call("/auth/login", {
      method: "POST",
      body: { email: "housekeeping@grandpalm.demo", password: "Password123!" },
    })
  ).data.accessToken;
  mgrToken = (
    await call("/auth/login", {
      method: "POST",
      body: { email: "manager@grandpalm.demo", password: "Password123!" },
    })
  ).data.accessToken;
  const me = await call("/auth/me", { token: hkToken });
  property = me.data.properties.find((p) => p.code === "GPH-LAG") ?? me.data.properties[0];
  assert.ok(property);
});

// ── Sync contract ────────────────────────────────────────────────────────

test("a queued mutation applies and bumps the version", async () => {
  const task = await pendingTask();
  const res = await call("/sync/mutations", {
    method: "POST",
    token: hkToken,
    body: { deviceId: `dev_${uniq()}`, mutations: [mutation(task, "start")] },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.applied.length, 1);
  assert.equal(res.data.applied[0].status, "IN_PROGRESS");
  assert.equal(res.data.applied[0].version, task.version + 1);
  assert.ok(typeof res.data.nextCursor === "string");
});

test("replaying the same operationId does not apply it twice", async () => {
  const task = await pendingTask();
  const m = mutation(task, "start");
  const deviceId = `dev_${uniq()}`;

  const first = await call("/sync/mutations", {
    method: "POST", token: hkToken, body: { deviceId, mutations: [m] },
  });
  assert.equal(first.data.applied[0].replayed, undefined);
  const versionAfterFirst = first.data.applied[0].version;

  // Exactly what a retried flush sends after a half-failed request.
  const replay = await call("/sync/mutations", {
    method: "POST", token: hkToken, body: { deviceId, mutations: [m] },
  });
  assert.equal(replay.data.applied.length, 1);
  assert.equal(replay.data.applied[0].replayed, true, "a replay must be recognised");

  const after = await call(`/housekeeping/tasks?propertyId=${property.id}`, { token: hkToken });
  const current = after.data.find((t) => t.id === task.id);
  assert.equal(
    current.version,
    versionAfterFirst,
    "the version must not move on a replayed operation"
  );
});

test("a stale baseVersion conflicts instead of overwriting", async () => {
  const task = await pendingTask();
  // Someone else advances the task while this device was offline. Asserted,
  // because a silent failure here would make the "stale" version current and
  // the test would pass for the wrong reason.
  const moved = await call(`/housekeeping/tasks/${task.id}/advance`, {
    method: "POST", token: hkToken, body: {},
  });
  assert.equal(moved.status, 201, `advance failed: ${JSON.stringify(moved.data)}`);
  assert.ok(moved.data.version > task.version, "the server version must have moved on");

  const res = await call("/sync/mutations", {
    method: "POST",
    token: hkToken,
    body: { deviceId: `dev_${uniq()}`, mutations: [mutation(task, "complete")] },
  });
  assert.equal(res.data.applied.length, 0);
  assert.equal(res.data.conflicts.length, 1);
  const c = res.data.conflicts[0];
  assert.ok(["VERSION_CONFLICT", "ALREADY_ADVANCED"].includes(c.code), c.code);
  // The device needs both the server truth and what to do about it.
  assert.ok(c.serverVersion >= task.version);
  assert.ok(c.resolution && c.resolution.length > 0, "a conflict must carry a resolution path");
});

test("notes append rather than overwrite", async () => {
  const task = await pendingTask();
  const deviceA = `dev_${uniq()}`;
  const deviceB = `dev_${uniq()}`;

  const a = await call("/sync/mutations", {
    method: "POST",
    token: hkToken,
    body: {
      deviceId: deviceA,
      mutations: [mutation(task, "note", { payload: { notes: "Kettle missing" } })],
    },
  });
  assert.equal(a.data.applied.length, 1);

  const mid = await call(`/housekeeping/tasks?propertyId=${property.id}`, { token: hkToken });
  const t2 = mid.data.find((t) => t.id === task.id);

  const b = await call("/sync/mutations", {
    method: "POST",
    token: hkToken,
    body: {
      deviceId: deviceB,
      mutations: [mutation(t2, "note", { payload: { notes: "Towels restocked" } })],
    },
  });
  assert.equal(b.data.applied.length, 1);

  const final = await call(`/housekeeping/tasks?propertyId=${property.id}`, { token: hkToken });
  const notes = final.data.find((t) => t.id === task.id).notes ?? "";
  assert.ok(notes.includes("Kettle missing"), "the first note must survive");
  assert.ok(notes.includes("Towels restocked"), "the second note must also be present");
});

test("financial actions are rejected as online-only", async () => {
  const task = await pendingTask();
  const res = await call("/sync/mutations", {
    method: "POST",
    token: hkToken,
    body: {
      deviceId: `dev_${uniq()}`,
      mutations: [mutation(task, "payment", { payload: { amountMinor: 50000 } })],
    },
  });
  assert.equal(res.data.rejected.length, 1);
  assert.equal(res.data.rejected[0].code, "ONLINE_ONLY");
  assert.equal(res.data.applied.length, 0);
});

test("the change feed returns what a device missed", async () => {
  const first = await call("/sync/mutations", {
    method: "POST",
    token: hkToken,
    body: { deviceId: `dev_${uniq()}`, mutations: [] },
  });
  const cursor = first.data.nextCursor;
  assert.ok(cursor);

  const task = await pendingTask();
  await call(`/housekeeping/tasks/${task.id}/advance`, {
    method: "POST", token: hkToken, body: {},
  });

  const second = await call("/sync/mutations", {
    method: "POST",
    token: hkToken,
    body: { deviceId: `dev_${uniq()}`, lastServerCursor: cursor, mutations: [] },
  });
  assert.ok(
    second.data.serverChanges.some((c) => c.entityId === task.id),
    "a change made after the cursor must appear in the feed"
  );
});

// ── Live updates ─────────────────────────────────────────────────────────

test("the event stream rejects a missing or invalid token", async () => {
  const res = await fetch(`${BASE}/events/stream?token=not-a-real-token`);
  assert.equal(res.status, 401);
  await res.body?.cancel();
});

test("the event stream opens and announces itself", async () => {
  const controller = new AbortController();
  const res = await fetch(`${BASE}/events/stream?token=${hkToken}`, {
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  // Buffering proxies would defeat the stream entirely.
  assert.equal(res.headers.get("x-accel-buffering"), "no");

  const reader = res.body.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  assert.match(text, /retry: \d+/, "the client is told how long to wait before reconnecting");
  assert.match(text, /event: ready/);

  await reader.cancel();
  controller.abort();
});

test("a change is pushed to a connected stream", async () => {
  const controller = new AbortController();
  const res = await fetch(`${BASE}/events/stream?token=${hkToken}`, {
    signal: controller.signal,
  });
  const reader = res.body.getReader();
  await reader.read(); // consume the ready frame

  const task = await pendingTask();
  await call(`/housekeeping/tasks/${task.id}/advance`, {
    method: "POST", token: hkToken, body: {},
  });

  // The poller ticks every 3s; allow a couple of cycles before giving up.
  const deadline = Date.now() + 12000;
  let sawChange = false;
  while (Date.now() < deadline && !sawChange) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = new TextDecoder().decode(value);
    if (chunk.includes("event: change")) sawChange = true;
  }
  await reader.cancel();
  controller.abort();

  assert.ok(sawChange, "an outbox event must reach a connected stream");
});
