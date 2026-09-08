#!/usr/bin/env node
/**
 * End-to-end smoke test for the API served from Next.js route handlers.
 *
 * Usage:
 *   node scripts/smoke-serverless-api.mjs [--base http://localhost:3100]
 *
 * This exercises the parts of the request path that the serverless transport
 * can plausibly break, rather than the business logic (which has its own 368
 * tests against the standalone server):
 *
 *   - native modules load at all (Argon2 hashing, the Prisma engine)
 *   - a real write transaction commits
 *   - Set-Cookie survives the Response conversion, including its attributes
 *   - the refresh cookie round-trips and rotates
 *   - rate limiting is keyed per client, not per instance
 *   - error status codes are preserved, not flattened to 500
 *
 * It creates a real tenant with a unique email each run, so it is safe to run
 * repeatedly, but it does write to whatever database BASE points at. Never aim
 * it at a database with real guests in it.
 */
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const BASE = (flag("base", "http://localhost:3100")).replace(/\/$/, "");
const API = `${BASE}/api/v1`;

let passed = 0;
let failed = 0;

function check(ok, label, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function call(path, { method = "GET", body, token, cookie } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: res.status, data, headers: res.headers, text };
}

const stamp = Date.now().toString(36);
const email = `smoke-${stamp}@lodgiva.test`;
const password = "SmokeTestPassword123!";

console.log(`Smoke testing ${API}\n`);

// ── 1. The process is up and the database is reachable ────────────────────
console.log("1. Health");
const live = await call("/health/live");
check(live.status === 200, "GET /health/live returns 200", `got ${live.status}`);
const ready = await call("/health/ready");
check(
  ready.status === 200,
  "GET /health/ready runs a real query against the database",
  `got ${ready.status}: ${JSON.stringify(ready.data).slice(0, 160)}`,
);
if (ready.status !== 200) {
  console.log("\nDatabase unreachable; the rest of the suite cannot run.");
  process.exit(1);
}

// ── 2. Errors keep their status, rather than collapsing to 500 ────────────
console.log("\n2. Error mapping");
const missing = await call("/definitely-not-a-route");
check(missing.status === 404, "an unknown route is 404, not 500", `got ${missing.status}`);
const unauth = await call("/reservations");
check(unauth.status === 401, "an unauthenticated read is 401", `got ${unauth.status}`);
const badLogin = await call("/auth/login", {
  method: "POST",
  body: { email: "nobody@lodgiva.test", password: "wrong-password-here" },
});
check(
  badLogin.status === 401 && badLogin.data.error?.code === "INVALID_CREDENTIALS",
  "a wrong password is 401 INVALID_CREDENTIALS (Argon2 ran)",
  `got ${badLogin.status} ${JSON.stringify(badLogin.data).slice(0, 120)}`,
);

// ── 3. A real write transaction ───────────────────────────────────────────
console.log("\n3. Signup writes to the database");
const signup = await call("/onboarding/tenants", {
  method: "POST",
  body: {
    tenantName: `Smoke Hotels ${stamp}`,
    ownerEmail: email,
    ownerFullName: "Smoke Tester",
    password,
    propertyName: `Smoke Inn ${stamp}`,
    propertyCode: `SMK${stamp.slice(-4)}`.toUpperCase(),
    timezone: "Africa/Lagos",
  },
});
check(
  signup.status === 201,
  "POST /onboarding/tenants creates tenant + owner + property",
  `got ${signup.status}: ${JSON.stringify(signup.data).slice(0, 200)}`,
);
check(
  !!signup.data.property?.id,
  "the response carries the created property",
);
check(
  typeof signup.data.property?.code === "string",
  "the property code round-tripped",
);

// ── 4. Login, cookies, and the session ────────────────────────────────────
console.log("\n4. Login and cookie handling");
const login = await call("/auth/login", { method: "POST", body: { email, password } });
check(
  login.status === 201 && !!login.data.accessToken,
  "the new owner can sign in",
  `got ${login.status}: ${JSON.stringify(login.data).slice(0, 160)}`,
);

const setCookie = login.headers.getSetCookie?.() ?? [];
check(setCookie.length > 0, "a Set-Cookie header survived the Response conversion");
const refreshCookie = setCookie.find((c) => c.startsWith("lodgiva_refresh="));
check(!!refreshCookie, "the refresh cookie is present");
if (refreshCookie) {
  // Attributes are the whole point of the cookie; a naive join would drop them.
  check(/HttpOnly/i.test(refreshCookie), "the refresh cookie kept HttpOnly");
  check(/Path=\//i.test(refreshCookie), "the refresh cookie kept Path");
  check(/SameSite/i.test(refreshCookie), "the refresh cookie kept SameSite");
  check(
    /Secure/i.test(refreshCookie),
    "the refresh cookie is Secure in production mode",
  );
}

const token = login.data.accessToken;

// ── 5. Authenticated reads, tenant-scoped ─────────────────────────────────
console.log("\n5. Authenticated requests");
const me = await call("/auth/me", { token });
check(me.status === 200, "GET /auth/me with a Bearer token", `got ${me.status}`);
check(me.data.user?.email === email, "it returns the account that signed in");
check(
  Array.isArray(me.data.properties) && me.data.properties.length === 1,
  "the new tenant sees exactly its own property",
  `saw ${me.data.properties?.length}`,
);
check(
  me.data.role === "TENANT_OWNER",
  "the signup owner holds TENANT_OWNER",
  `got ${me.data.role}`,
);

const propertyId = me.data.properties?.[0]?.id;
if (propertyId) {
  const rack = await call(`/properties/${propertyId}/room-rack`);
  check(rack.status === 401, "the room rack still requires auth", `got ${rack.status}`);
  const rackAuthed = await call(`/properties/${propertyId}/room-rack`, { token });
  check(
    rackAuthed.status === 200 && Array.isArray(rackAuthed.data),
    "an authenticated room-rack read succeeds (empty for a new property)",
    `got ${rackAuthed.status}`,
  );
  const reservations = await call(`/reservations?propertyId=${propertyId}`, { token });
  check(
    reservations.status === 200,
    "a query-string route works through the catch-all",
    `got ${reservations.status}`,
  );
}

// ── 6. Refresh rotation, driven by the cookie ─────────────────────────────
console.log("\n6. Refresh rotation");
if (refreshCookie) {
  const cookieHeader = refreshCookie.split(";")[0];
  const refreshed = await call("/auth/refresh", { method: "POST", cookie: cookieHeader });
  check(
    refreshed.status === 201 && !!refreshed.data.accessToken,
    "the refresh cookie is accepted and returns a new access token",
    `got ${refreshed.status}: ${JSON.stringify(refreshed.data).slice(0, 160)}`,
  );
  const rotated = refreshed.headers.getSetCookie?.() ?? [];
  check(
    rotated.some((c) => c.startsWith("lodgiva_refresh=")),
    "a rotated refresh cookie comes back",
  );
  // The old token must die with the rotation, or a stolen cookie is valid
  // forever.
  const replay = await call("/auth/refresh", { method: "POST", cookie: cookieHeader });
  check(
    replay.status === 401,
    "replaying the consumed refresh token is refused",
    `got ${replay.status}`,
  );
}

// ── 7. Rate limiting is per client, not per instance ──────────────────────
console.log("\n7. Rate limiting");
const limitProbe = await fetch(`${API}/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "nobody@lodgiva.test", password: "wrong" }),
});
const authLimit = Number(limitProbe.headers.get("x-ratelimit-limit"));
const generalProbe = await fetch(`${API}/health/live`);
const generalLimit = Number(generalProbe.headers.get("x-ratelimit-limit"));
check(
  Number.isFinite(authLimit) && Number.isFinite(generalLimit),
  "rate-limit headers are present (the limiter is active)",
  `auth=${authLimit} general=${generalLimit}`,
);
check(
  authLimit < generalLimit,
  "auth routes carry a tighter budget than the general API",
  `auth=${authLimit} general=${generalLimit}`,
);

console.log(`\n${failed === 0 ? "ALL SMOKE CHECKS PASSED" : `${failed} CHECK(S) FAILED`} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
