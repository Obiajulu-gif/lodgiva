#!/usr/bin/env node
/**
 * Load test against a running API.
 *
 * Usage:
 *   node scripts/load-test.mjs [--duration 20] [--concurrency 20] [--scenario mixed]
 *
 * Scenarios model what a property actually does, not what is easy to measure:
 *   read      — the room rack and arrivals list, polled by every open screen
 *   search    — availability search, the most expensive read path
 *   mixed     — reads plus a booking write, in the ratio a front desk produces
 *   contention— many clients booking the SAME night, to exercise the unique
 *               index that allocation depends on
 *
 * Percentiles are computed from every sample, not a running estimate, because
 * the whole point is the tail: a p99 built from an approximation hides exactly
 * the requests a guest complains about.
 *
 * Reports non-2xx separately from timing. A load test that counts errors as
 * fast responses reports its best numbers when the service is broken.
 */
const BASE = process.env.API_BASE ?? "http://localhost:4000/api/v1";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};

const durationSec = Number(flag("duration", 15));
const concurrency = Number(flag("concurrency", 20));
const scenario = flag("scenario", "mixed");
const email = flag("email", "frontdesk@grandpalm.demo");
const password = flag("password", "Password123!");

const samples = [];
const statuses = new Map();
let errors = 0;

async function call(path, { method = "GET", body, token } = {}) {
  const started = performance.now();
  let status = 0;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    status = res.status;
    await res.text(); // drain, or the timing excludes the body
  } catch {
    errors += 1;
    status = 0;
  }
  const ms = performance.now() - started;
  samples.push({ ms, status, path: path.split("?")[0] });
  statuses.set(status, (statuses.get(status) ?? 0) + 1);
  return status;
}

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function setup() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const login = await res.json();
  if (!login.accessToken) {
    throw new Error(
      `login returned ${login.status ?? "no token"} - if MFA is enforced for this user, pass --email for one that is not.`
    );
  }
  const me = await (await fetch(`${BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${login.accessToken}` },
  })).json();
  const property = me.properties.find((p) => p.code === "GPH-LAG") ?? me.properties[0];
  const auth = { Authorization: `Bearer ${login.accessToken}`, "Content-Type": "application/json" };

  // Rate configuration is a manager permission, and rightly so. Traffic is
  // still generated as the front-desk user - the point is to measure the
  // role that actually sits at the desk all day.
  const admin = await (await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: flag("adminEmail", "manager@grandpalm.demo"), password }),
  })).json();
  const adminAuth = {
    Authorization: `Bearer ${admin.accessToken}`,
    "Content-Type": "application/json",
  };

  // A hold is placed against a rate plan, not a room type: the plan carries
  // the price the hold is quoting. The base seed ships no plans, so the
  // harness creates one and prices it - a write scenario that 400s on every
  // request measures nothing but the validation layer.
  let plans = await (await fetch(`${BASE}/rates/plans?propertyId=${property.id}`, {
    headers: auth,
  })).json();

  if (!Array.isArray(plans) || plans.length === 0) {
    const types = await (await fetch(`${BASE}/config/room-types?propertyId=${property.id}`, {
      headers: auth,
    })).json();
    if (!types.length) throw new Error("no room types - seed the database first");

    const created = await (await fetch(`${BASE}/rates/plans`, {
      method: "POST",
      headers: adminAuth,
      body: JSON.stringify({
        propertyId: property.id,
        roomTypeId: types[0].id,
        code: `LOAD${Date.now().toString().slice(-5)}`,
        name: "Load test rate",
      }),
    })).json();
    if (!created?.id) throw new Error(`could not create a rate plan: ${JSON.stringify(created)}`);

    // Price a wide window so every worker's dates are quotable. An unpriced
    // night is a legitimate 409 the test would otherwise report as a failure.
    const rates = [];
    for (let d = 0; d < 130; d++) {
      rates.push({ date: addDays(property.businessDate, d), rateMinor: 4500000 });
    }
    await fetch(`${BASE}/rates/calendar`, {
      method: "POST",
      headers: adminAuth,
      body: JSON.stringify({ ratePlanId: created.id, rates }),
    });
    plans = [created];
  }

  return { token: login.accessToken, property, ratePlanId: plans[0].id };
}

async function worker(ctx, deadline, index) {
  const { token, property, ratePlanId } = ctx;
  while (performance.now() < deadline) {
    const from = property.businessDate;
    const to = addDays(from, 2);

    if (scenario === "read") {
      await call(`/reservations?propertyId=${property.id}`, { token });
      await call(`/front-desk/arrivals?propertyId=${property.id}`, { token });
    } else if (scenario === "search") {
      await call(
        `/availability?propertyId=${property.id}&arrivalDate=${from}&departureDate=${to}&adults=2`,
        { token }
      );
    } else if (scenario === "contention") {
      // Every worker aims at the same night on purpose: this is the path where
      // the unique index on (roomTypeId, date, slotIndex) is the only thing
      // standing between two clients and the same last room.
      await call("/holds", {
        method: "POST",
        token,
        body: {
          propertyId: property.id,
          ratePlanId,
          arrivalDate: addDays(from, 30),
          departureDate: addDays(from, 31),
          adults: 2,
        },
      });
    } else {
      // mixed: roughly six reads per write, which is what a front desk shift
      // looks like from the server's side.
      await call(`/reservations?propertyId=${property.id}`, { token });
      await call(`/front-desk/arrivals?propertyId=${property.id}`, { token });
      await call(
        `/availability?propertyId=${property.id}&arrivalDate=${from}&departureDate=${to}&adults=2`,
        { token }
      );
      await call(`/housekeeping/tasks?propertyId=${property.id}`, { token });
      await call(`/reports/daily-flash?propertyId=${property.id}`, { token });
      await call(`/pos/orders?propertyId=${property.id}`, { token });
      if (index % 4 === 0) {
        await call("/holds", {
          method: "POST",
          token,
          body: {
            propertyId: property.id,
            ratePlanId,
            arrivalDate: addDays(from, 60 + index),
            departureDate: addDays(from, 61 + index),
            adults: 2,
          },
        });
      }
    }
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return Number(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))].toFixed(1));
}

const ctx = await setup();
const started = performance.now();
const deadline = started + durationSec * 1000;

await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(ctx, deadline, i)));
const elapsedSec = (performance.now() - started) / 1000;

const ok = samples.filter((s) => s.status >= 200 && s.status < 400);
const bad = samples.filter((s) => s.status >= 400 || s.status === 0);
const okMs = ok.map((s) => s.ms).sort((a, b) => a - b);

const byRoute = new Map();
for (const s of samples) {
  const e = byRoute.get(s.path) ?? { count: 0, ms: [], bad: 0 };
  e.count += 1;
  e.ms.push(s.ms);
  if (s.status >= 400 || s.status === 0) e.bad += 1;
  byRoute.set(s.path, e);
}

console.log(
  JSON.stringify(
    {
      scenario,
      concurrency,
      durationSec: Number(elapsedSec.toFixed(1)),
      requests: samples.length,
      requestsPerSecond: Number((samples.length / elapsedSec).toFixed(1)),
      // Latency is reported over successful responses only; a flood of instant
      // 429s would otherwise read as excellent performance.
      latencyMsOk: {
        p50: percentile(okMs, 50),
        p95: percentile(okMs, 95),
        p99: percentile(okMs, 99),
        max: okMs.length ? Number(okMs[okMs.length - 1].toFixed(1)) : null,
      },
      okCount: ok.length,
      nonSuccess: bad.length,
      transportErrors: errors,
      statusBreakdown: Object.fromEntries([...statuses.entries()].sort()),
      routes: [...byRoute.entries()]
        .map(([route, v]) => {
          const sorted = v.ms.sort((a, b) => a - b);
          return {
            route,
            count: v.count,
            p95: percentile(sorted, 95),
            nonSuccess: v.bad,
          };
        })
        .sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0)),
    },
    null,
    2
  )
);
