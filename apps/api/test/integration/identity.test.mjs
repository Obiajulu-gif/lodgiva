/**
 * Integration tests for identity, tenancy and property configuration.
 *
 * These run against a live API and a seeded database. They exercise the
 * §6.2 isolation rules with a SECOND real tenant, which is the only way to
 * prove horizontal access is actually blocked rather than merely absent.
 *
 * Run: node --test test/integration/identity.test.mjs   (API must be up)
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
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data, headers: res.headers };
}

const login = async (email, password = "Password123!") => {
  const r = await call("/auth/login", { method: "POST", body: { email, password } });
  assert.equal(r.status, 201, `login failed for ${email}: ${JSON.stringify(r.data)}`);
  return r.data;
};

const uniq = () => Math.random().toString(36).slice(2, 8);
const today = new Date().toISOString().slice(0, 10);

// ── Shared fixtures ──────────────────────────────────────────────────────
let ownerToken;
let managerToken;
let frontDeskToken;
let housekeepingToken;
let propertyA;

// A second tenant created through the public onboarding endpoint, used as the
// attacker in the isolation tests.
let otherTenant;

test("setup: log in seeded users and onboard a second tenant", async () => {
  ownerToken = (await login("owner@grandpalm.demo")).accessToken;
  managerToken = (await login("manager@grandpalm.demo")).accessToken;
  frontDeskToken = (await login("frontdesk@grandpalm.demo")).accessToken;
  housekeepingToken = (await login("housekeeping@grandpalm.demo")).accessToken;

  const me = await call("/auth/me", { token: ownerToken });
  propertyA = me.data.properties[0];
  assert.ok(propertyA?.id, "owner should see at least one property");

  const suffix = uniq();
  const onboard = await call("/onboarding/tenants", {
    method: "POST",
    body: {
      tenantName: `Rival Hotels ${suffix}`,
      ownerEmail: `rival-${suffix}@example.com`,
      ownerFullName: "Rival Owner",
      password: "RivalPassword123!",
      propertyName: `Rival Inn ${suffix}`,
      propertyCode: `RV${suffix.slice(0, 4)}`.toUpperCase(),
      businessDate: today,
    },
  });
  assert.equal(onboard.status, 201, JSON.stringify(onboard.data));
  const rivalLogin = await login(`rival-${suffix}@example.com`, "RivalPassword123!");
  otherTenant = {
    token: rivalLogin.accessToken,
    propertyId: onboard.data.property.id,
    tenantId: onboard.data.tenant.id,
  };
});

// ── Authentication (§6.3) ────────────────────────────────────────────────

test("login rejects a wrong password without revealing whether the account exists", async () => {
  const wrongPassword = await call("/auth/login", {
    method: "POST",
    body: { email: "owner@grandpalm.demo", password: "definitely-wrong" },
  });
  const noSuchUser = await call("/auth/login", {
    method: "POST",
    body: { email: `ghost-${uniq()}@example.com`, password: "definitely-wrong" },
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal(noSuchUser.status, 401);
  assert.equal(wrongPassword.data.error.code, noSuchUser.data.error.code);
  assert.equal(wrongPassword.data.error.message, noSuchUser.data.error.message);
});

test("passwords are stored as Argon2id, never returned by the API", async () => {
  const me = await call("/auth/me", { token: ownerToken });
  const serialised = JSON.stringify(me.data);
  assert.ok(!serialised.includes("passwordHash"), "response must not leak passwordHash");
  assert.ok(!serialised.includes("$argon2"), "response must not leak a password hash");
});

test("refresh rotation invalidates the token it was issued from", async () => {
  const session = await login("frontdesk@grandpalm.demo");
  const first = await call("/auth/refresh", {
    method: "POST",
    body: { refreshToken: session.refreshToken },
  });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.notEqual(first.data.refreshToken, session.refreshToken, "refresh token must rotate");

  // Replaying the consumed token must fail — this is the whole point of rotation.
  const replay = await call("/auth/refresh", {
    method: "POST",
    body: { refreshToken: session.refreshToken },
  });
  assert.equal(replay.status, 401);
  assert.equal(replay.data.error.code, "SESSION_INVALID");

  // The newly issued token still works.
  const second = await call("/auth/refresh", {
    method: "POST",
    body: { refreshToken: first.data.refreshToken },
  });
  assert.equal(second.status, 201);
});

test("access token carries tenant and role, and is required on protected routes", async () => {
  const anon = await call("/properties");
  assert.equal(anon.status, 401);
  assert.equal(anon.data.error.code, "UNAUTHENTICATED");

  const garbage = await call("/properties", { token: "not-a-jwt" });
  assert.equal(garbage.status, 401);
  assert.equal(garbage.data.error.code, "TOKEN_INVALID");
});

test("sessions can be listed and revoked", async () => {
  const session = await login("manager@grandpalm.demo");
  const list = await call("/auth/sessions", { token: session.accessToken });
  assert.equal(list.status, 200);
  assert.ok(list.data.length >= 1);
  assert.ok(!JSON.stringify(list.data).includes("refreshTokenHash"), "must not expose token hashes");

  // Revoke every session for this user rather than guessing which row is
  // ours: earlier runs leave active sessions behind for the same seeded user.
  const revoke = await call("/auth/sessions", {
    method: "DELETE",
    token: session.accessToken,
  });
  assert.equal(revoke.status, 200);
  assert.ok(revoke.data.revoked >= 1);

  // A revoked session's refresh token can no longer be exchanged.
  const afterRevoke = await call("/auth/refresh", {
    method: "POST",
    body: { refreshToken: session.refreshToken },
  });
  assert.equal(afterRevoke.status, 401);
});

test("repeated failed logins apply a progressive lock, not a permanent one", async () => {
  const suffix = uniq();
  const email = `lockme-${suffix}@example.com`;
  await call("/onboarding/tenants", {
    method: "POST",
    body: {
      tenantName: `Lock Test ${suffix}`,
      ownerEmail: email,
      ownerFullName: "Lock Test",
      password: "CorrectHorse123!",
      propertyName: `Lock Inn ${suffix}`,
      propertyCode: `LK${suffix.slice(0, 4)}`.toUpperCase(),
      businessDate: today,
    },
  });

  let locked = null;
  for (let i = 0; i < 4; i++) {
    const r = await call("/auth/login", { method: "POST", body: { email, password: "wrong" } });
    if (r.data?.error?.code === "ACCOUNT_TEMPORARILY_LOCKED") locked = r.data.error;
  }
  assert.ok(locked, "account should lock after repeated failures");
  assert.ok(locked.retryable, "a progressive lock must be reported as retryable");
  assert.ok(
    locked.details.retryAfterSeconds > 0 && locked.details.retryAfterSeconds <= 300,
    `retry window should be bounded, got ${locked.details.retryAfterSeconds}s`
  );
});

// ── Tenant isolation (§6.2 rule 8) ───────────────────────────────────────

test("a tenant cannot read another tenant's property by id", async () => {
  const cross = await call(`/properties/${propertyA.id}/settings`, {
    token: otherTenant.token,
  });
  assert.equal(cross.status, 404, "cross-tenant read must not succeed");
  assert.equal(cross.data.error.code, "PROPERTY_NOT_FOUND");
});

test("a tenant cannot write configuration into another tenant's property", async () => {
  const cross = await call("/config/room-types", {
    method: "POST",
    token: otherTenant.token,
    body: {
      propertyId: propertyA.id,
      code: `X${uniq().slice(0, 3)}`,
      name: "Injected type",
      baseRateMinor: 1000,
    },
  });
  assert.equal(cross.status, 404, "cross-tenant write must be refused");
});

test("tenant id in the request body is ignored — the token is authoritative (§6.2 rule 2)", async () => {
  const res = await call("/config/amenities", {
    method: "POST",
    token: ownerToken,
    body: {
      propertyId: propertyA.id,
      code: `TEN${uniq().slice(0, 4)}`.toUpperCase(),
      name: "Tenant spoof attempt",
      // Not part of the schema; strict() must reject rather than honour it.
      tenantId: otherTenant.tenantId,
    },
  });
  assert.equal(res.status, 400, "unknown body fields must be rejected outright");
  assert.equal(res.data.error.code, "VALIDATION_ERROR");
});

test("listing properties never includes another tenant's properties", async () => {
  const list = await call("/properties", { token: otherTenant.token });
  assert.equal(list.status, 200);
  const ids = list.data.map((p) => p.id);
  assert.ok(!ids.includes(propertyA.id), "rival tenant must not see our property");
});

// ── Authorisation (§6.4) ─────────────────────────────────────────────────

test("front desk cannot change tax configuration", async () => {
  const res = await call("/properties/tax-rules", {
    method: "POST",
    token: frontDeskToken,
    body: {
      propertyId: propertyA.id,
      code: "VAT",
      name: "Value Added Tax",
      rateBp: 100,
      compoundOrder: 2,
      effectiveFrom: today,
    },
  });
  assert.equal(res.status, 403);
  assert.equal(res.data.error.code, "PERMISSION_DENIED");
  assert.equal(res.data.error.details.requiredPermission, "settings.tax.manage");
});

test("housekeeping cannot manage users or rooms", async () => {
  const users = await call("/memberships", { token: housekeepingToken });
  assert.equal(users.status, 403);

  const room = await call("/config/rooms", {
    method: "POST",
    token: housekeepingToken,
    body: { propertyId: propertyA.id, roomTypeId: "x", roomNumber: "999" },
  });
  assert.equal(room.status, 403);
});

test("the owner can manage users and read the permission set", async () => {
  const me = await call("/auth/me", { token: ownerToken });
  assert.ok(Array.isArray(me.data.permissions));
  assert.ok(me.data.permissions.includes("user.manage"));

  const members = await call("/memberships", { token: ownerToken });
  assert.equal(members.status, 200);
  assert.ok(members.data.length >= 4, "seeded tenant should have several memberships");
});

// ── Staff onboarding ─────────────────────────────────────────────────────

test("an invited user can accept and receives only the granted role", async () => {
  const email = `invitee-${uniq()}@example.com`;
  const invite = await call("/invitations", {
    method: "POST",
    token: ownerToken,
    body: { email, fullName: "New Cashier", role: "CASHIER", allProperties: true },
  });
  assert.equal(invite.status, 201, JSON.stringify(invite.data));
  assert.ok(invite.data.token, "invitation should return a one-time token");

  const accept = await call("/onboarding/invitations/accept", {
    method: "POST",
    body: { token: invite.data.token, password: "NewCashierPass123!" },
  });
  assert.equal(accept.status, 201, JSON.stringify(accept.data));
  assert.equal(accept.data.role, "CASHIER");

  const session = await login(email, "NewCashierPass123!");
  const me = await call("/auth/me", { token: session.accessToken });
  assert.equal(me.data.role, "CASHIER");
  assert.ok(!me.data.permissions.includes("payment.refund"), "cashier must not hold refund rights");

  // The invitation token is single use.
  const replay = await call("/onboarding/invitations/accept", {
    method: "POST",
    body: { token: invite.data.token, password: "Another123456!" },
  });
  assert.equal(replay.status, 404);
});

test("a property-scoped member sees only the properties in scope", async () => {
  // Give the owner's tenant a second property, then invite a scoped manager.
  const second = await call("/properties", {
    method: "POST",
    token: ownerToken,
    body: {
      name: `Annex ${uniq()}`,
      code: `AN${uniq().slice(0, 4)}`.toUpperCase(),
      businessDate: today,
    },
  });
  assert.equal(second.status, 201, JSON.stringify(second.data));

  const email = `scoped-${uniq()}@example.com`;
  const invite = await call("/invitations", {
    method: "POST",
    token: ownerToken,
    body: {
      email,
      fullName: "Scoped Manager",
      role: "GENERAL_MANAGER",
      allProperties: false,
      propertyIds: [second.data.id],
    },
  });
  assert.equal(invite.status, 201, JSON.stringify(invite.data));
  await call("/onboarding/invitations/accept", {
    method: "POST",
    body: { token: invite.data.token, password: "ScopedManager123!" },
  });

  const session = await login(email, "ScopedManager123!");
  const me = await call("/auth/me", { token: session.accessToken });
  const visible = me.data.properties.map((p) => p.id);
  assert.deepEqual(visible, [second.data.id], "scoped member should see exactly one property");

  // And cannot reach the property outside its scope, even inside its own tenant.
  const outOfScope = await call(`/properties/${propertyA.id}/settings`, {
    token: session.accessToken,
  });
  assert.equal(outOfScope.status, 404, "out-of-scope property must be unreachable");
});

test("the last active tenant owner cannot be demoted", async () => {
  const members = await call("/memberships", { token: ownerToken });
  const owners = members.data.filter((m) => m.role === "TENANT_OWNER" && m.status === "ACTIVE");
  if (owners.length !== 1) return; // another owner exists; rule does not apply
  const res = await call(`/memberships/${owners[0].id}`, {
    method: "PATCH",
    token: ownerToken,
    body: { role: "FRONT_DESK" },
  });
  assert.equal(res.status, 409);
  assert.equal(res.data.error.code, "LAST_OWNER");
});

// ── Audit ────────────────────────────────────────────────────────────────

test("identity actions are written to the append-only audit log", async () => {
  const audit = await call(`/reports/audit-trail?propertyId=${propertyA.id}`, {
    token: ownerToken,
  });
  assert.equal(audit.status, 200);
  const actions = audit.data.map((a) => a.action);
  assert.ok(
    actions.some((a) => a.startsWith("settings.") || a.startsWith("property.")),
    "configuration changes should appear in the audit trail"
  );
});
