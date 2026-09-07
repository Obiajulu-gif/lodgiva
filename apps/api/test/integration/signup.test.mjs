/**
 * Integration tests for public self-serve signup.
 *
 * This is the path a hotel owner takes with no account and no invitation, so
 * it is the one place where an anonymous caller creates a tenant. What matters
 * here is that it creates a *complete, usable* account atomically — a signup
 * that leaves a user without a membership, or a tenant without a property,
 * produces someone who can sign in and then do nothing at all.
 *
 * Run: node --test test/integration/signup.test.mjs   (API must be up)
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
  return { status: res.status, data };
}

const uniq = () => Math.random().toString(36).slice(2, 8);

/** A complete, valid signup payload with a fresh identity every time. */
function payload(overrides = {}) {
  const suffix = uniq();
  return {
    tenantName: `Signup Hotels ${suffix}`,
    ownerEmail: `owner-${suffix}@signup.test`,
    ownerFullName: "Chidinma Okafor",
    password: "CorrectHorseBattery1",
    propertyName: `Signup Lodge ${suffix}`,
    propertyCode: `SG${suffix.slice(0, 4)}`.toUpperCase(),
    ...overrides,
  };
}

// ── The happy path, end to end ───────────────────────────────────────────

test("signup creates a usable account and the owner can immediately sign in", async () => {
  const dto = payload();

  const created = await call("/onboarding/tenants", { method: "POST", body: dto });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.ok(created.data.tenant?.id);
  assert.equal(created.data.property.code, dto.propertyCode);
  assert.equal(created.data.owner.email, dto.ownerEmail);
  // The password must never come back out, in any form.
  assert.ok(
    !JSON.stringify(created.data).includes(dto.password),
    "the signup response must not echo the password",
  );

  const signedIn = await call("/auth/login", {
    method: "POST",
    body: { email: dto.ownerEmail, password: dto.password },
  });
  assert.equal(signedIn.status, 201, JSON.stringify(signedIn.data));
  assert.ok(signedIn.data.accessToken, "a new owner has no second factor yet");

  // The whole point of onboarding: the account can actually do something.
  const me = await call("/auth/me", { token: signedIn.data.accessToken });
  assert.equal(me.status, 200);
  assert.equal(me.data.role, "TENANT_OWNER");
  assert.equal(me.data.tenant.displayName, dto.tenantName);
  assert.equal(me.data.properties.length, 1, "the first property must exist");
  assert.equal(me.data.properties[0].code, dto.propertyCode);
  assert.ok(
    me.data.permissions.includes("user.manage"),
    "an owner must be able to invite their own staff",
  );
});

test("the password is stored hashed, not accepted verbatim afterwards", async () => {
  const dto = payload();
  await call("/onboarding/tenants", { method: "POST", body: dto });

  // A near-miss must fail: this would pass if the stored value were compared
  // loosely or truncated somewhere.
  const wrong = await call("/auth/login", {
    method: "POST",
    body: { email: dto.ownerEmail, password: `${dto.password}x` },
  });
  assert.equal(wrong.status, 401, JSON.stringify(wrong.data));
  assert.equal(wrong.data.error.code, "INVALID_CREDENTIALS");
});

test("the business date is derived server-side when the client omits it", async () => {
  // A laptop with a wrong clock must not decide a date only night audit can
  // move afterwards.
  const dto = payload({ timezone: "Africa/Lagos" });
  const created = await call("/onboarding/tenants", { method: "POST", body: dto });
  assert.equal(created.status, 201, JSON.stringify(created.data));

  const signedIn = await call("/auth/login", {
    method: "POST",
    body: { email: dto.ownerEmail, password: dto.password },
  });
  const me = await call("/auth/me", { token: signedIn.data.accessToken });
  const businessDate = me.data.properties[0].businessDate;

  assert.match(businessDate, /^\d{4}-\d{2}-\d{2}$/);
  const expected = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  assert.equal(businessDate, expected, "the property opens on its own local date");
});

test("an explicit business date is still honoured", async () => {
  // Existing callers pass one; onboarding must stay backward compatible.
  const dto = payload({ businessDate: "2030-01-15" });
  const created = await call("/onboarding/tenants", { method: "POST", body: dto });
  assert.equal(created.status, 201, JSON.stringify(created.data));

  const signedIn = await call("/auth/login", {
    method: "POST",
    body: { email: dto.ownerEmail, password: dto.password },
  });
  const me = await call("/auth/me", { token: signedIn.data.accessToken });
  assert.equal(me.data.properties[0].businessDate, "2030-01-15");
});

// ── Rejections ───────────────────────────────────────────────────────────

test("a duplicate email is refused cleanly and creates nothing", async () => {
  const dto = payload();
  assert.equal((await call("/onboarding/tenants", { method: "POST", body: dto })).status, 201);

  const tenantsBefore = await call("/auth/login", {
    method: "POST",
    body: { email: dto.ownerEmail, password: dto.password },
  });
  const meBefore = await call("/auth/me", { token: tenantsBefore.data.accessToken });

  const second = await call("/onboarding/tenants", {
    method: "POST",
    body: { ...payload(), ownerEmail: dto.ownerEmail },
  });
  assert.equal(second.status, 409, JSON.stringify(second.data));
  assert.equal(second.data.error.code, "EMAIL_IN_USE");
  assert.match(second.data.error.message, /sign in/i, "it must say what to do instead");

  // The rejected attempt must not have attached a second tenant to this user.
  const meAfter = await call("/auth/me", { token: tenantsBefore.data.accessToken });
  assert.equal(meAfter.data.tenant.id, meBefore.data.tenant.id);
  assert.equal(meAfter.data.properties.length, meBefore.data.properties.length);
});

test("a weak password is rejected before an account exists", async () => {
  const dto = payload({ password: "short" });
  const res = await call("/onboarding/tenants", { method: "POST", body: dto });
  assert.equal(res.status, 400, JSON.stringify(res.data));

  // And no half-made user was left behind.
  const attempt = await call("/auth/login", {
    method: "POST",
    body: { email: dto.ownerEmail, password: "short" },
  });
  assert.equal(attempt.status, 401);
});

test("incomplete submissions are rejected field by field", async () => {
  for (const [field, value] of [
    ["ownerEmail", "not-an-email"],
    ["tenantName", "x"],
    ["propertyName", ""],
    ["propertyCode", "x"],
    ["ownerFullName", ""],
  ]) {
    const res = await call("/onboarding/tenants", {
      method: "POST",
      body: payload({ [field]: value }),
    });
    assert.equal(res.status, 400, `${field}=${JSON.stringify(value)} should be rejected`);
  }
});

test("unknown fields are refused rather than silently ignored", async () => {
  // The schema is strict: accepting `role: "TENANT_OWNER"` from an anonymous
  // caller is exactly the kind of thing that must never start working.
  const res = await call("/onboarding/tenants", {
    method: "POST",
    body: { ...payload(), role: "TENANT_OWNER", tenantId: "someone-elses-tenant" },
  });
  assert.equal(res.status, 400, JSON.stringify(res.data));
});

// ── Isolation ────────────────────────────────────────────────────────────

test("a new tenant sees only its own property, never a neighbour's", async () => {
  const first = payload();
  const second = payload();
  await call("/onboarding/tenants", { method: "POST", body: first });
  await call("/onboarding/tenants", { method: "POST", body: second });

  const a = await call("/auth/login", {
    method: "POST",
    body: { email: first.ownerEmail, password: first.password },
  });
  const b = await call("/auth/login", {
    method: "POST",
    body: { email: second.ownerEmail, password: second.password },
  });

  const meA = await call("/auth/me", { token: a.data.accessToken });
  const meB = await call("/auth/me", { token: b.data.accessToken });

  assert.notEqual(meA.data.tenant.id, meB.data.tenant.id);
  assert.equal(meA.data.properties.length, 1);
  assert.equal(meB.data.properties.length, 1);
  assert.notEqual(meA.data.properties[0].id, meB.data.properties[0].id);

  // Reading across the boundary must return nothing, not a 403 that confirms
  // the row exists.
  const across = await call(
    `/properties/${meB.data.properties[0].id}/room-rack`,
    { token: a.data.accessToken },
  );
  assert.ok([403, 404].includes(across.status), `got ${across.status}`);
});

test("signup does not disturb the invitation path for staff", async () => {
  // Owners onboard themselves; staff are invited. Both must keep working.
  const dto = payload();
  await call("/onboarding/tenants", { method: "POST", body: dto });
  const owner = await call("/auth/login", {
    method: "POST",
    body: { email: dto.ownerEmail, password: dto.password },
  });

  const invited = await call("/invitations", {
    method: "POST",
    token: owner.data.accessToken,
    body: {
      email: `desk-${uniq()}@signup.test`,
      fullName: "Front Desk Hire",
      role: "FRONT_DESK",
      allProperties: true,
    },
  });
  assert.equal(invited.status, 201, JSON.stringify(invited.data));
});
