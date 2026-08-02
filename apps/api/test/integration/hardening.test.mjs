/**
 * Integration tests for MFA enforcement, feature flags, service-level metrics
 * and per-route rate limiting.
 *
 * The TOTP algorithm itself is verified against the RFC vectors in
 * test/unit/totp.test.mjs; what is asserted here is the flow around it — that
 * a password alone stops being enough, that the challenge is single-purpose,
 * and that a recovery code cannot be used twice.
 *
 * Run: node --test test/integration/hardening.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const BASE = process.env.API_BASE ?? "http://localhost:4000/api/v1";

async function call(path, { method = "GET", body, token, raw = false } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    data: raw ? text : text ? JSON.parse(text) : {},
  };
}

/**
 * Sign-in is rate limited per IP, and every suite in this repository shares
 * one. A 429 here means the control is working, not that the test failed, so
 * it is waited out rather than disabled - a suite that had to turn off a
 * production control to pass would be testing a system nobody ships.
 */
async function login(email, password = "Password123!") {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await call("/auth/login", { method: "POST", body: { email, password } });
    if (res.status !== 429) return res;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error("login stayed rate limited for 80 seconds");
}

// ── A local TOTP, so the test proves the server's implementation rather than
// borrowing it. If both sides shared a bug this would pass while no real
// authenticator app worked.
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32decode(s) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of s.toUpperCase().replace(/[\s=-]/g, "")) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
function code(secret, atMs = Date.now()) {
  const counter = Math.floor(atMs / 30_000);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const d = createHmac("sha1", b32decode(secret)).update(buf).digest();
  const o = d[d.length - 1] & 0x0f;
  const n =
    ((d[o] & 0x7f) << 24) | ((d[o + 1] & 0xff) << 16) | ((d[o + 2] & 0xff) << 8) | (d[o + 3] & 0xff);
  return String(n % 1_000_000).padStart(6, "0");
}

let ownerToken;
let deskToken;

test("setup", async () => {
  ownerToken = (await login("owner@grandpalm.demo")).data.accessToken;
  deskToken = (await login("frontdesk@grandpalm.demo")).data.accessToken;
  assert.ok(ownerToken && deskToken);
});

// ── MFA enrolment and challenge ──────────────────────────────────────────

test("MFA is off until a user proves they can read a code from the secret", async () => {
  const before = await call("/auth/mfa", { token: deskToken });
  assert.equal(before.data.enabled, false);

  const setup = await call("/auth/mfa/setup", { method: "POST", token: deskToken });
  assert.equal(setup.status, 201, JSON.stringify(setup.data));
  assert.match(setup.data.otpauthUri, /^otpauth:\/\/totp\//);
  assert.ok(setup.data.secret.length >= 32);

  // An abandoned setup must not lock the account: the secret exists but MFA
  // is still off, and a plain password login still works.
  const midway = await call("/auth/mfa", { token: deskToken });
  assert.equal(midway.data.enabled, false, "a stored secret alone must not enable MFA");
  const stillIn = await login("frontdesk@grandpalm.demo");
  assert.ok(stillIn.data.accessToken, "an incomplete enrolment must not block sign-in");

  const wrong = await call("/auth/mfa/activate", {
    method: "POST",
    token: deskToken,
    body: { code: "000000" },
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.error.code, "INVALID_MFA_CODE");

  const activated = await call("/auth/mfa/activate", {
    method: "POST",
    token: deskToken,
    body: { code: code(setup.data.secret) },
  });
  assert.equal(activated.status, 201, JSON.stringify(activated.data));
  assert.equal(activated.data.enabled, true);
  assert.equal(activated.data.recoveryCodes.length, 10);
  // Shown once, in clear, and never again.
  const status = await call("/auth/mfa", { token: deskToken });
  assert.equal(status.data.recoveryCodesRemaining, 10);
  assert.ok(!JSON.stringify(status.data).includes(activated.data.recoveryCodes[0]));

  // Keep the secret for the tests below.
  test.secret = setup.data.secret;
  test.recovery = activated.data.recoveryCodes;
});

test("a correct password alone no longer yields a session", async () => {
  const res = await login("frontdesk@grandpalm.demo");
  assert.equal(res.data.status, "MFA_REQUIRED", JSON.stringify(res.data));
  assert.ok(res.data.mfaToken, "the challenge must carry a token to exchange");
  assert.equal(res.data.accessToken, undefined, "no access token may be issued yet");
  assert.equal(res.data.refreshToken, undefined);
});

test("the challenge token cannot be used as an access token", async () => {
  const challenge = (await login("frontdesk@grandpalm.demo")).data.mfaToken;
  // It is a signed JWT for the right user; only its purpose stops it working.
  const res = await call("/reservations", { token: challenge });
  assert.equal(res.status, 401, JSON.stringify(res.data));
});

test("a wrong code is refused and the right one completes the sign-in", async () => {
  const challenge = (await login("frontdesk@grandpalm.demo")).data.mfaToken;

  const bad = await call("/auth/mfa/verify", {
    method: "POST",
    body: { mfaToken: challenge, code: "111111" },
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.data.error.code, "INVALID_MFA_CODE");

  const good = await call("/auth/mfa/verify", {
    method: "POST",
    body: { mfaToken: challenge, code: code(test.secret) },
  });
  assert.equal(good.status, 201, JSON.stringify(good.data));
  assert.ok(good.data.accessToken);
  // And the session is a real one.
  const me = await call("/auth/me", { token: good.data.accessToken });
  assert.equal(me.status, 200);
});

test("a code from a stale time step is refused", async () => {
  const challenge = (await login("frontdesk@grandpalm.demo")).data.mfaToken;
  const res = await call("/auth/mfa/verify", {
    method: "POST",
    // Ten minutes ago: far outside the drift window a slow phone justifies.
    body: { mfaToken: challenge, code: code(test.secret, Date.now() - 600_000) },
  });
  assert.equal(res.status, 401, "an old code must not be replayable");
});

test("a recovery code works once and only once", async () => {
  const recovery = test.recovery[0];

  const first = await call("/auth/mfa/verify", {
    method: "POST",
    body: {
      mfaToken: (await login("frontdesk@grandpalm.demo")).data.mfaToken,
      code: recovery,
    },
  });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.usedRecoveryCode, true);
  assert.equal(first.data.recoveryCodesRemaining, 9);

  // An unconsumed recovery code is a permanent password that skips the second
  // factor, which is the whole thing MFA is meant to prevent.
  const replay = await call("/auth/mfa/verify", {
    method: "POST",
    body: {
      mfaToken: (await login("frontdesk@grandpalm.demo")).data.mfaToken,
      code: recovery,
    },
  });
  assert.equal(replay.status, 401, "a spent recovery code must never work again");
});

test("turning MFA off requires the password again", async () => {
  const session = await call("/auth/mfa/verify", {
    method: "POST",
    body: {
      mfaToken: (await login("frontdesk@grandpalm.demo")).data.mfaToken,
      code: code(test.secret),
    },
  });
  const token = session.data.accessToken;

  const noPassword = await call("/auth/mfa/disable", {
    method: "POST",
    token,
    body: { password: "not-the-password" },
  });
  assert.equal(noPassword.status, 401, "a hijacked session must not be able to remove the factor");

  const off = await call("/auth/mfa/disable", {
    method: "POST",
    token,
    body: { password: "Password123!" },
  });
  assert.equal(off.status, 201, JSON.stringify(off.data));
  assert.equal(off.data.enabled, false);

  const plain = await login("frontdesk@grandpalm.demo");
  assert.ok(plain.data.accessToken, "sign-in returns to normal once MFA is removed");
});

// ── Policy enforcement ───────────────────────────────────────────────────

test("a role covered by policy is made to enrol before it can work", async () => {
  const applied = await call("/security-policy", {
    method: "PUT",
    token: ownerToken,
    body: { mfaRequiredRoles: ["FRONT_DESK"] },
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.ok(applied.data.usersPromptedAtNextLogin >= 1, "the owner must be told who this interrupts");

  const gated = await login("frontdesk@grandpalm.demo");
  assert.equal(gated.data.status, "MFA_ENROLMENT_REQUIRED", JSON.stringify(gated.data));
  assert.ok(gated.data.setupToken);
  // Distinct from MFA_REQUIRED on purpose: this user has nothing to type yet,
  // and needs to be sent somewhere, not asked for a code they cannot produce.
  assert.match(gated.data.message, /requires two-factor/i);
  assert.equal(gated.data.accessToken, undefined);

  const setup = await call("/auth/mfa/enrol/setup", {
    method: "POST",
    body: { setupToken: gated.data.setupToken },
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.data));

  const done = await call("/auth/mfa/enrol/activate", {
    method: "POST",
    body: { setupToken: gated.data.setupToken, code: code(setup.data.secret) },
  });
  assert.equal(done.status, 201, JSON.stringify(done.data));
  // Enrolment finishes the interrupted sign-in rather than bouncing the user
  // back to a login screen seconds after they proved themselves.
  assert.ok(done.data.accessToken, "enrolment must complete the sign-in it interrupted");
  test.secret = setup.data.secret;
});

test("policy blocks a covered user from removing their own second factor", async () => {
  const session = await call("/auth/mfa/verify", {
    method: "POST",
    body: {
      mfaToken: (await login("frontdesk@grandpalm.demo")).data.mfaToken,
      code: code(test.secret),
    },
  });
  const res = await call("/auth/mfa/disable", {
    method: "POST",
    token: session.data.accessToken,
    body: { password: "Password123!" },
  });
  assert.equal(res.status, 401);
  assert.equal(res.data.error.code, "MFA_REQUIRED_BY_POLICY");
});

test("only a user manager can change the policy", async () => {
  const session = await call("/auth/mfa/verify", {
    method: "POST",
    body: {
      mfaToken: (await login("frontdesk@grandpalm.demo")).data.mfaToken,
      code: code(test.secret),
    },
  });
  const res = await call("/security-policy", {
    method: "PUT",
    token: session.data.accessToken,
    body: { mfaRequiredRoles: [] },
  });
  assert.equal(res.status, 403, JSON.stringify(res.data));

  // An unknown role must not be silently accepted into the policy.
  const bogus = await call("/security-policy", {
    method: "PUT",
    token: ownerToken,
    body: { mfaRequiredRoles: ["SUPREME_LEADER"] },
  });
  assert.equal(bogus.status, 400);
});

test("teardown: policy off and factor removed", async () => {
  await call("/security-policy", {
    method: "PUT",
    token: ownerToken,
    body: { mfaRequiredRoles: [] },
  });
  const session = await call("/auth/mfa/verify", {
    method: "POST",
    body: {
      mfaToken: (await login("frontdesk@grandpalm.demo")).data.mfaToken,
      code: code(test.secret),
    },
  });
  const off = await call("/auth/mfa/disable", {
    method: "POST",
    token: session.data.accessToken,
    body: { password: "Password123!" },
  });
  assert.equal(off.data.enabled, false);
  // Leaving MFA on would break every other suite that signs in as front desk.
  const plain = await login("frontdesk@grandpalm.demo");
  assert.ok(plain.data.accessToken, "front desk must be able to sign in plainly again");
});

// ── Feature flags ────────────────────────────────────────────────────────

test("an unknown flag reads as off", async () => {
  const flags = await call("/feature-flags", { token: ownerToken });
  assert.equal(flags.status, 200);
  assert.equal(flags.data["definitely-not-a-real-flag"], undefined);
});

test("a flag can be created, toggled and overridden per tenant", async () => {
  const key = `load-test-${Date.now().toString(36)}`;
  const created = await call("/admin/feature-flags", {
    method: "POST",
    token: ownerToken,
    body: { key, description: "Created by the hardening test suite.", enabled: false },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));

  const me = await call("/auth/me", { token: ownerToken });
  const tenantId = me.data.tenantId ?? me.data.claims?.tenantId ?? me.data.memberships?.[0]?.tenantId;

  let flags = await call("/feature-flags", { token: ownerToken });
  assert.equal(flags.data[key], false, "a new flag starts off");

  await call(`/admin/feature-flags/${key}`, {
    method: "PUT",
    token: ownerToken,
    body: { enabled: true },
  });
  // The read cache has a short TTL; poll rather than assume instant coherence.
  for (let i = 0; i < 12; i++) {
    flags = await call("/feature-flags", { token: ownerToken });
    if (flags.data[key] === true) break;
    await new Promise((r) => setTimeout(r, 600));
  }
  assert.equal(flags.data[key], true, "the flag must switch on without a redeploy");

  if (tenantId) {
    // An override wins over the default in both directions — that is what
    // makes it usable for "turn this off for the tenant having a bad day".
    await call(`/admin/feature-flags/${key}`, {
      method: "PUT",
      token: ownerToken,
      body: { overrides: { [tenantId]: false } },
    });
    for (let i = 0; i < 12; i++) {
      flags = await call("/feature-flags", { token: ownerToken });
      if (flags.data[key] === false) break;
      await new Promise((r) => setTimeout(r, 600));
    }
    assert.equal(flags.data[key], false, "a tenant override must beat the global default");
  }
});

test("flag keys are validated, and duplicates refused", async () => {
  const bad = await call("/admin/feature-flags", {
    method: "POST",
    token: ownerToken,
    body: { key: "Not Kebab Case", description: "should be rejected" },
  });
  assert.equal(bad.status, 400, JSON.stringify(bad.data));

  const key = `dup-${Date.now().toString(36)}`;
  const body = { key, description: "first creation wins" };
  assert.equal((await call("/admin/feature-flags", { method: "POST", token: ownerToken, body })).status, 201);
  const second = await call("/admin/feature-flags", { method: "POST", token: ownerToken, body });
  assert.equal(second.status, 400);
  assert.equal(second.data.error.code, "FLAG_EXISTS");
});

test("front desk cannot manage flags", async () => {
  const res = await call("/admin/feature-flags", { token: deskToken });
  assert.equal(res.status, 403, JSON.stringify(res.data));
});

// ── Observability ────────────────────────────────────────────────────────

test("every response carries a trace id a support ticket can quote", async () => {
  const res = await call("/auth/me", { token: ownerToken });
  const traceId = res.headers.get("x-trace-id");
  assert.ok(traceId, "x-trace-id must be present");
  assert.match(traceId, /^[0-9a-f]{32}$/);
});

test("an inbound W3C traceparent is continued rather than replaced", async () => {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const res = await fetch(`${BASE}/auth/me`, {
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      traceparent: `00-${traceId}-00f067aa0ba902b7-01`,
    },
  });
  assert.equal(res.headers.get("x-trace-id"), traceId, "a trace must survive the hop");
});

test("a malformed traceparent starts a fresh trace instead of failing", async () => {
  const res = await fetch(`${BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${ownerToken}`, traceparent: "garbage" },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("x-trace-id"), /^[0-9a-f]{32}$/);
});

test("the observability status says plainly which exporters are live", async () => {
  const res = await call("/observability/status", { token: ownerToken });
  assert.equal(res.status, 200);
  assert.equal(typeof res.data.tracing.configured, "boolean");
  assert.equal(typeof res.data.errorReporting.configured, "boolean");
  // When an exporter is off it must say why, so nobody assumes traces are
  // being collected when nothing is listening.
  if (!res.data.tracing.configured) assert.ok(res.data.tracing.reason);
  if (!res.data.errorReporting.configured) assert.ok(res.data.errorReporting.reason);
});

test("metrics are scrapeable and route ids are templated, not per-record", async () => {
  await call("/auth/me", { token: ownerToken });
  const res = await fetch(`${BASE}/metrics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/plain/);
  const body = await res.text();

  assert.match(body, /# TYPE lodgiva_http_requests_total counter/);
  assert.match(body, /lodgiva_http_requests_total\{route="[^"]+",method="[A-Z]+",status="\dxx"\} \d+/);
  assert.match(body, /lodgiva_slo_latency_ratio/);
  // A uuid in a metric label produces one time series per record and no
  // usable percentile — the classic way to melt a metrics backend.
  assert.ok(
    !/route="[^"]*[0-9a-f]{8}-[0-9a-f]{4}-/.test(body),
    "route labels must be templated, not carry ids"
  );
});

test("the service-level report exposes the SLI, not just raw counts", async () => {
  const res = await call("/observability/service-level?windowMinutes=60", { token: ownerToken });
  assert.equal(res.status, 200);
  assert.equal(typeof res.data.sloLatencyMs, "number");
  assert.ok(res.data.requests >= 1);
  assert.ok(res.data.availabilityPct === null || res.data.availabilityPct <= 100);
  assert.ok(Array.isArray(res.data.slowestRoutes));
});

// ── Rate limiting ────────────────────────────────────────────────────────

test("auth routes carry a much tighter budget than the general API", async () => {
  // Asserted through the advertised limit rather than by exhausting it: this
  // suite shares an IP with every other suite, and burning the login budget
  // here would fail them all. The exhaustion path is exercised at the very end
  // of test/e2e.mjs, where nothing needs to sign in afterwards.
  const general = await fetch(`${BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const generalLimit = Number(general.headers.get("x-ratelimit-limit"));

  const auth = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@grandpalm.demo", password: "Password123!" }),
  });
  const authLimit = Number(auth.headers.get("x-ratelimit-limit"));

  assert.ok(Number.isFinite(generalLimit), "rate limiting must be active at all");
  assert.ok(Number.isFinite(authLimit), "the auth route must advertise its own limit");
  assert.ok(
    authLimit < generalLimit,
    `login budget (${authLimit}) must be tighter than the general one (${generalLimit}) — 600 password guesses a minute is a working attack`
  );
});

test("security headers are present on every response", async () => {
  const res = await fetch(`${BASE}/health/live`);
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(res.headers.get("strict-transport-security") ?? "", /max-age=31536000/);
  assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

// ── Support tooling ──────────────────────────────────────────────────────

test("support lookup finds a booking from a confirmation code", async () => {
  const reservations = await call("/reservations", { token: ownerToken });
  const target = reservations.data[0];
  assert.ok(target, "the seed must contain a reservation");

  const res = await call(`/support/lookup?q=${encodeURIComponent(target.confirmationCode)}`, {
    token: ownerToken,
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const hit = res.data.reservations.find((r) => r.confirmationCode === target.confirmationCode);
  assert.ok(hit, "the code the guest reads out must find the booking");
});

test("support results are redacted, and the raw contact details never appear", async () => {
  const guests = await call("/guests", { token: ownerToken });
  const withEmail = guests.data.find((g) => g.email);
  if (!withEmail) return; // nothing to assert against in this dataset

  const res = await call(`/support/lookup?q=${encodeURIComponent(withEmail.lastName)}`, {
    token: ownerToken,
  });
  assert.equal(res.status, 200);
  const body = JSON.stringify(res.data);
  assert.ok(
    !body.includes(withEmail.email),
    "a support search must not become a source of guest email addresses"
  );
  const hit = res.data.guests.find((g) => g.id === withEmail.id);
  if (hit?.email) {
    assert.match(hit.email, /\*/, "the masked form must still be recognisable to the caller");
    assert.ok(hit.email.includes("@"), "enough must survive for support to confirm the domain");
  }
});

test("a too-short query is refused rather than returning the database", async () => {
  const res = await call("/support/lookup?q=a", { token: ownerToken });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, "QUERY_TOO_SHORT");
});

test("every support lookup lands on the audit trail", async () => {
  const marker = `zzz${Date.now().toString(36)}`;
  await call(`/support/lookup?q=${marker}`, { token: ownerToken });
  const audit = await call("/reports/audit-trail", { token: ownerToken });
  const entry = audit.data.find(
    (e) => e.action === "support.lookup" && String(e.summary).includes(marker)
  );
  // A tool that reaches guest data without leaving a trace is the tool an
  // insider uses.
  assert.ok(entry, "the search must be recorded, including what was searched for");
});

test("housekeeping cannot use support lookup", async () => {
  const hk = (await login("housekeeping@grandpalm.demo")).data.accessToken;
  const res = await call("/support/lookup?q=test", { token: hk });
  assert.equal(res.status, 403, JSON.stringify(res.data));
  assert.equal(res.data.error.details.requiredPermission, "support.lookup");
});

test("the reservation timeline assembles the whole story in one call", async () => {
  const reservations = await call("/reservations", { token: ownerToken });
  const target = reservations.data[0];
  const res = await call(`/support/reservations/${target.id}`, { token: ownerToken });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.reservation.confirmationCode, target.confirmationCode);
  assert.ok(Array.isArray(res.data.folios));
  assert.ok(Array.isArray(res.data.timeline));
  assert.equal(typeof res.data.balanceMinor, "number");
  // Contact details stay masked here too — the timeline is the more tempting
  // place to leak them, because it is the screen support keeps open.
  if (res.data.reservation.email) assert.match(res.data.reservation.email, /\*/);
});

test("diagnostics report findings rather than a bare 'healthy'", async () => {
  const me = await call("/auth/me", { token: ownerToken });
  const property = me.data.properties.find((p) => p.code === "GPH-LAG") ?? me.data.properties[0];
  const res = await call(`/support/diagnostics?propertyId=${property.id}`, { token: ownerToken });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(Array.isArray(res.data.findings));
  assert.equal(typeof res.data.healthy, "boolean");
  for (const f of res.data.findings) {
    assert.ok(f.code && f.severity, "a finding without a severity cannot be triaged");
  }
});

test("support tooling is read only", async () => {
  // There is no write route to call; assert the surface stays that way.
  const res = await call("/support/lookup", { method: "POST", token: ownerToken, body: { q: "x" } });
  assert.ok(res.status === 404 || res.status === 405, `unexpected ${res.status}`);
});
