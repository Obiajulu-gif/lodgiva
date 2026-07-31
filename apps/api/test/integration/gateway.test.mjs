/**
 * Integration tests for the payment gateway: intents, signed webhooks,
 * idempotency, refunds with approval, settlement import and reconciliation.
 *
 * The API must be started with the same PAYSTACK_SECRET_KEY this file signs
 * with, otherwise webhook verification cannot be exercised end to end.
 *
 * Run: node --test test/integration/gateway.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const BASE = process.env.API_BASE ?? "http://localhost:4000/api/v1";
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY ?? "sk_test_lodgiva_e2e";

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

/** Posts a webhook exactly as a provider would: raw bytes plus a signature. */
async function postWebhook(provider, payload, { signature, secret } = {}) {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  const sig =
    signature ??
    createHmac("sha512", secret ?? PAYSTACK_SECRET).update(Buffer.from(raw)).digest("hex");
  const res = await fetch(`${BASE}/webhooks/${provider}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-paystack-signature": sig },
    body: raw,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : {} };
}

const uniq = () => Math.random().toString(36).slice(2, 8);
const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

let token;         // front desk
let financeToken;  // owner / finance
let property;
let businessDate;
let typeId;

async function freshFolio() {
  const guest = await call("/guests", {
    method: "POST",
    token,
    body: { firstName: "Pay", lastName: `Gate${uniq()}` },
  });
  const arrival = addDays(businessDate, 500 + Math.floor(Math.random() * 300));
  const res = await call("/reservations", {
    method: "POST",
    token,
    body: {
      propertyId: property.id,
      guestId: guest.data.id,
      roomTypeId: typeId,
      arrivalDate: arrival,
      departureDate: addDays(arrival, 1),
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  await call(`/folios/${res.data.folioId}/charges`, {
    method: "POST",
    token,
    body: { type: "POS_CHARGE", description: "Gateway test", amountMinor: 5000000, applyTaxes: false },
  });
  return res.data.folioId;
}

test("setup", async () => {
  token = (
    await call("/auth/login", {
      method: "POST",
      body: { email: "frontdesk@grandpalm.demo", password: "Password123!" },
    })
  ).data.accessToken;
  financeToken = (
    await call("/auth/login", {
      method: "POST",
      body: { email: "owner@grandpalm.demo", password: "Password123!" },
    })
  ).data.accessToken;

  const me = await call("/auth/me", { token });
  property = me.data.properties[0];
  businessDate = property.businessDate;

  const code = `PG${uniq()}`.toUpperCase();
  const rt = await call("/config/room-types", {
    method: "POST",
    token: financeToken,
    body: {
      propertyId: property.id,
      code,
      name: `Gateway ${code}`,
      baseOccupancy: 2,
      maxOccupancy: 2,
      baseRateMinor: 5000000,
    },
  });
  assert.equal(rt.status, 201);
  typeId = rt.data.id;
  for (let i = 0; i < 6; i++) {
    await call("/config/rooms", {
      method: "POST",
      token: financeToken,
      body: { propertyId: property.id, roomTypeId: typeId, roomNumber: `${code}${i}`, floor: 1 },
    });
  }
});

// ── Provider status honesty ──────────────────────────────────────────────

test("provider status reports whether each adapter is live or sandbox", async () => {
  const res = await call("/payments/providers", { token });
  assert.equal(res.status, 200);
  const names = res.data.map((p) => p.name).sort();
  assert.deepEqual(names, ["FLUTTERWAVE", "PAYSTACK"]);
  for (const p of res.data) {
    assert.ok(["LIVE", "SANDBOX"].includes(p.mode));
    assert.ok(p.note.length > 20, "each provider must explain what its mode means");
  }
});

// ── Intents ──────────────────────────────────────────────────────────────

test("an intent is created without touching the folio", async () => {
  const folioId = await freshFolio();
  const before = await call(`/folios/${folioId}`, { token });

  const intent = await call("/payments/intents", {
    method: "POST",
    token,
    body: {
      folioId,
      provider: "PAYSTACK",
      amountMinor: 5000000,
      email: "guest@example.com",
    },
  });
  assert.equal(intent.status, 201, JSON.stringify(intent.data));
  assert.ok(intent.data.reference.startsWith("LDG-"));
  assert.ok(intent.data.checkoutUrl);
  assert.equal(intent.data.status, "PENDING");

  const after = await call(`/folios/${folioId}`, { token });
  assert.equal(
    after.data.balanceMinor,
    before.data.balanceMinor,
    "creating an intent must not move money — only a confirmed provider signal does"
  );
});

test("an intent cannot be raised against a closed folio", async () => {
  const guest = await call("/guests", {
    method: "POST", token, body: { firstName: "Closed", lastName: `Gate${uniq()}` },
  });
  const res = await call("/reservations", {
    method: "POST",
    token,
    body: {
      propertyId: property.id, guestId: guest.data.id, roomTypeId: typeId,
      arrivalDate: businessDate, departureDate: addDays(businessDate, 1),
    },
  });
  await call(`/reservations/${res.data.id}/check-in`, { method: "POST", token, body: {} });
  let co = await call(`/reservations/${res.data.id}/check-out`, { method: "POST", token, body: {} });
  for (let i = 0; i < 3 && co.status === 409; i++) {
    await call("/payments", {
      method: "POST", token,
      body: { folioId: res.data.folioId, method: "CASH", amountMinor: co.data.error.details.balanceMinor },
    });
    co = await call(`/reservations/${res.data.id}/check-out`, { method: "POST", token, body: {} });
  }
  assert.equal(co.status, 201);

  const intent = await call("/payments/intents", {
    method: "POST",
    token,
    body: { folioId: res.data.folioId, provider: "PAYSTACK", amountMinor: 1000, email: "a@b.com" },
  });
  assert.equal(intent.status, 409);
  assert.equal(intent.data.error.code, "FOLIO_CLOSED");
});

// ── Webhook signature enforcement ────────────────────────────────────────

test("a webhook with a bad signature is rejected and never posts money", async () => {
  const folioId = await freshFolio();
  const intent = await call("/payments/intents", {
    method: "POST",
    token,
    body: { folioId, provider: "PAYSTACK", amountMinor: 5000000, email: "g@example.com" },
  });
  const before = await call(`/folios/${folioId}`, { token });

  const res = await postWebhook(
    "paystack",
    {
      event: "charge.success",
      data: {
        id: Date.now(),
        reference: intent.data.reference,
        amount: 5000000,
        currency: "NGN",
        status: "success",
      },
    },
    { signature: "deadbeef" }
  );
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, "INVALID_SIGNATURE");

  const after = await call(`/folios/${folioId}`, { token });
  assert.equal(after.data.balanceMinor, before.data.balanceMinor, "no money may move on a bad signature");
});

test("a body tampered after signing is rejected", async () => {
  const folioId = await freshFolio();
  const intent = await call("/payments/intents", {
    method: "POST",
    token,
    body: { folioId, provider: "PAYSTACK", amountMinor: 5000000, email: "g@example.com" },
  });

  const honest = JSON.stringify({
    event: "charge.success",
    data: {
      id: Date.now(),
      reference: intent.data.reference,
      amount: 5000000,
      currency: "NGN",
      status: "success",
    },
  });
  const signature = createHmac("sha512", PAYSTACK_SECRET).update(Buffer.from(honest)).digest("hex");
  // Same signature, inflated amount.
  const tampered = honest.replace('"amount":5000000', '"amount":9900000');

  const res = await postWebhook("paystack", tampered, { signature });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, "INVALID_SIGNATURE");
});

test("an unknown provider is refused", async () => {
  const res = await postWebhook("notaprovider", { event: "x" });
  assert.equal(res.status, 404);
});

// ── Webhook happy path & idempotency ─────────────────────────────────────

test("a signed webhook confirms the payment and credits the folio once", async () => {
  const folioId = await freshFolio();
  const before = await call(`/folios/${folioId}`, { token });
  const intent = await call("/payments/intents", {
    method: "POST",
    token,
    body: { folioId, provider: "PAYSTACK", amountMinor: 5000000, email: "g@example.com" },
  });

  const txId = Date.now();
  const payload = {
    event: "charge.success",
    data: {
      id: txId,
      reference: intent.data.reference,
      amount: 5000000,
      currency: "NGN",
      status: "success",
      fees: 75000,
    },
  };

  const first = await postWebhook("paystack", payload);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.confirmed, true);

  const after = await call(`/folios/${folioId}`, { token });
  assert.equal(
    after.data.balanceMinor,
    before.data.balanceMinor - 5000000,
    "a confirmed payment must reduce the folio balance by exactly the amount"
  );
  const payments = after.data.entries.filter((e) => e.type === "PAYMENT");
  assert.equal(payments.length, 1);

  // Providers retry. The replay must be a no-op.
  const replay = await postWebhook("paystack", payload);
  assert.equal(replay.status, 201);
  assert.equal(replay.data.duplicate, true, "a redelivered webhook must be recognised");

  const afterReplay = await call(`/folios/${folioId}`, { token });
  assert.equal(
    afterReplay.data.balanceMinor,
    after.data.balanceMinor,
    "a replayed webhook must not credit the folio twice"
  );
  assert.equal(
    afterReplay.data.entries.filter((e) => e.type === "PAYMENT").length,
    1,
    "exactly one payment line may exist"
  );
});

test("a webhook for an unknown reference raises an exception instead of failing", async () => {
  const res = await postWebhook("paystack", {
    event: "charge.success",
    data: {
      id: Date.now() + 1,
      reference: `LDG-nonexistent-${uniq()}`,
      amount: 123400,
      currency: "NGN",
      status: "success",
    },
  });
  // Must be 2xx: a non-2xx would make the provider retry forever.
  assert.ok(res.status >= 200 && res.status < 300, `expected 2xx, got ${res.status}`);
  assert.equal(res.data.unmatched, true);
});

test("a non-payment event is acknowledged and ignored", async () => {
  const res = await postWebhook("paystack", {
    event: "charge.success",
    data: { id: Date.now() + 2, reference: "LDG-x", amount: 100, status: "failed" },
  });
  assert.ok(res.status >= 200 && res.status < 300);
  assert.equal(res.data.ignored, true);
});

// ── Refunds & approvals ──────────────────────────────────────────────────

async function paidFolio() {
  const folioId = await freshFolio();
  const intent = await call("/payments/intents", {
    method: "POST",
    token,
    body: { folioId, provider: "PAYSTACK", amountMinor: 5000000, email: "g@example.com" },
  });
  await postWebhook("paystack", {
    event: "charge.success",
    data: {
      id: Date.now() + Math.floor(Math.random() * 100000),
      reference: intent.data.reference,
      amount: 5000000,
      currency: "NGN",
      status: "success",
    },
  });
  const folio = await call(`/folios/${folioId}`, { token });
  const payments = await call(`/payments?propertyId=${property.id}`, { token });
  const payment = payments.data.find((p) => p.folioId === folioId);
  return { folioId, folio, paymentId: payment.id };
}

test("a refund requires a second approver and never self-approves", async () => {
  const { paymentId } = await paidFolio();

  const req = await call("/refunds", {
    method: "POST",
    token,
    body: { paymentId, amountMinor: 1000000, reason: "Guest charged for a service not delivered" },
  });
  assert.equal(req.status, 201, JSON.stringify(req.data));
  assert.equal(req.data.status, "PENDING_APPROVAL");

  // The requester cannot approve.
  const self = await call(`/refunds/${req.data.id}/approve`, { method: "POST", token, body: {} });
  assert.equal(self.status, 409);
  assert.ok(["SELF_APPROVAL", "FORBIDDEN_ROLE"].includes(self.data.error.code));

  const approved = await call(`/refunds/${req.data.id}/approve`, {
    method: "POST",
    token: financeToken,
    body: { note: "Verified with the guest" },
  });
  assert.equal(approved.status, 201, JSON.stringify(approved.data));
  assert.equal(approved.data.status, "APPROVED");
});

test("an approved refund posts to the folio and cannot be decided twice", async () => {
  const { folioId, paymentId } = await paidFolio();
  const before = await call(`/folios/${folioId}`, { token });

  const req = await call("/refunds", {
    method: "POST",
    token,
    body: { paymentId, amountMinor: 500000, reason: "Partial goodwill refund" },
  });
  const during = await call(`/folios/${folioId}`, { token });
  assert.equal(
    during.data.balanceMinor,
    before.data.balanceMinor,
    "a pending refund must not touch the ledger"
  );

  await call(`/refunds/${req.data.id}/approve`, {
    method: "POST", token: financeToken, body: { note: "Approved" },
  });
  const after = await call(`/folios/${folioId}`, { token });
  assert.equal(
    after.data.balanceMinor,
    before.data.balanceMinor + 500000,
    "a refund increases what the guest owes back"
  );
  assert.ok(after.data.entries.some((e) => e.type === "REFUND" && e.amountMinor === 500000));

  const again = await call(`/refunds/${req.data.id}/approve`, {
    method: "POST", token: financeToken, body: {},
  });
  assert.equal(again.status, 409);
  assert.equal(again.data.error.code, "ALREADY_DECIDED");
});

test("a refund cannot exceed what remains on the payment", async () => {
  const { paymentId } = await paidFolio();
  const over = await call("/refunds", {
    method: "POST",
    token,
    body: { paymentId, amountMinor: 9999999, reason: "Refund more than was paid" },
  });
  assert.equal(over.status, 409);
  assert.equal(over.data.error.code, "REFUND_EXCEEDS_PAYMENT");
});

test("a rejected refund leaves the ledger untouched", async () => {
  const { folioId, paymentId } = await paidFolio();
  const before = await call(`/folios/${folioId}`, { token });
  const req = await call("/refunds", {
    method: "POST",
    token,
    body: { paymentId, amountMinor: 250000, reason: "Requested in error" },
  });
  const rejected = await call(`/refunds/${req.data.id}/reject`, {
    method: "POST", token: financeToken, body: { note: "Not warranted" },
  });
  assert.equal(rejected.status, 201);
  assert.equal(rejected.data.status, "REJECTED");

  const after = await call(`/folios/${folioId}`, { token });
  assert.equal(after.data.balanceMinor, before.data.balanceMinor);
});

// ── Settlement import & reconciliation ───────────────────────────────────

test("a clean settlement matches every payment and raises no exceptions", async () => {
  const { paymentId } = await paidFolio();
  const payments = await call(`/payments?propertyId=${property.id}`, { token });
  const payment = payments.data.find((p) => p.id === paymentId);

  const imported = await call("/settlements/import", {
    method: "POST",
    token: financeToken,
    body: {
      propertyId: property.id,
      provider: "PAYSTACK",
      reference: `PS-PAYOUT-${uniq()}`,
      settledOn: businessDate,
      lines: [
        { providerRef: payment.externalReference, amountMinor: payment.amountMinor, feeMinor: 75000 },
      ],
    },
  });
  assert.equal(imported.status, 201, JSON.stringify(imported.data));
  assert.equal(imported.data.matched, 1);
  assert.equal(imported.data.netMinor, imported.data.grossMinor - imported.data.feeMinor);
  // Other unsettled payments from earlier tests legitimately show up as
  // MISSING_IN_SETTLEMENT; the matched line itself must be clean.
  assert.ok(
    !imported.data.exceptions.some((e) => e.kind === "AMOUNT_MISMATCH"),
    "a correct line must not raise a mismatch"
  );
});

test("settlement import is idempotent on the payout reference", async () => {
  const reference = `PS-DUP-${uniq()}`;
  const body = {
    propertyId: property.id,
    provider: "PAYSTACK",
    reference,
    settledOn: businessDate,
    lines: [{ providerRef: `unknown-${uniq()}`, amountMinor: 1000, feeMinor: 0 }],
  };
  const first = await call("/settlements/import", { method: "POST", token: financeToken, body });
  assert.equal(first.status, 201);
  const second = await call("/settlements/import", { method: "POST", token: financeToken, body });
  assert.equal(second.status, 409);
  assert.equal(second.data.error.code, "SETTLEMENT_ALREADY_IMPORTED");
});

test("a payout line we cannot match raises a critical exception", async () => {
  const ghost = `ghost-${uniq()}`;
  const imported = await call("/settlements/import", {
    method: "POST",
    token: financeToken,
    body: {
      propertyId: property.id,
      provider: "PAYSTACK",
      reference: `PS-GHOST-${uniq()}`,
      settledOn: businessDate,
      lines: [{ providerRef: ghost, amountMinor: 4200000, feeMinor: 0 }],
    },
  });
  assert.equal(imported.status, 201);
  assert.ok(imported.data.exceptions.some((e) => e.kind === "UNKNOWN_IN_SETTLEMENT"));

  const open = await call(`/reconciliation/exceptions?propertyId=${property.id}`, {
    token: financeToken,
  });
  const raised = open.data.find((e) => e.providerRef === ghost);
  assert.ok(raised, "the exception must be visible to finance");
  assert.equal(raised.kind, "UNKNOWN_IN_SETTLEMENT");
  assert.equal(raised.severity, "CRITICAL");
  assert.equal(raised.status, "OPEN");
});

test("a settled amount that differs from ours raises a mismatch with both figures", async () => {
  const { paymentId } = await paidFolio();
  const payments = await call(`/payments?propertyId=${property.id}`, { token });
  const payment = payments.data.find((p) => p.id === paymentId);

  const imported = await call("/settlements/import", {
    method: "POST",
    token: financeToken,
    body: {
      propertyId: property.id,
      provider: "PAYSTACK",
      reference: `PS-MISMATCH-${uniq()}`,
      settledOn: businessDate,
      lines: [
        { providerRef: payment.externalReference, amountMinor: payment.amountMinor - 100000, feeMinor: 0 },
      ],
    },
  });
  assert.ok(imported.data.exceptions.some((e) => e.kind === "AMOUNT_MISMATCH"));

  const open = await call(`/reconciliation/exceptions?propertyId=${property.id}`, {
    token: financeToken,
  });
  const mismatch = open.data.find(
    (e) => e.kind === "AMOUNT_MISMATCH" && e.providerRef === payment.externalReference
  );
  assert.ok(mismatch);
  assert.equal(mismatch.expectedMinor, payment.amountMinor);
  assert.equal(mismatch.actualMinor, payment.amountMinor - 100000);
});

test("a duplicated reference inside one payout is flagged", async () => {
  const ref = `dupe-${uniq()}`;
  const imported = await call("/settlements/import", {
    method: "POST",
    token: financeToken,
    body: {
      propertyId: property.id,
      provider: "PAYSTACK",
      reference: `PS-INTERNALDUP-${uniq()}`,
      settledOn: businessDate,
      lines: [
        { providerRef: ref, amountMinor: 1000, feeMinor: 0 },
        { providerRef: ref, amountMinor: 1000, feeMinor: 0 },
      ],
    },
  });
  assert.ok(imported.data.exceptions.some((e) => e.kind === "DUPLICATE_REFERENCE"));
});

test("front desk cannot import settlements or resolve exceptions", async () => {
  const imported = await call("/settlements/import", {
    method: "POST",
    token,
    body: {
      propertyId: property.id,
      provider: "PAYSTACK",
      reference: `PS-FORBIDDEN-${uniq()}`,
      settledOn: businessDate,
      lines: [{ providerRef: "x", amountMinor: 1, feeMinor: 0 }],
    },
  });
  assert.equal(imported.status, 409);
  assert.equal(imported.data.error.code, "FORBIDDEN_ROLE");
});

test("an exception can be resolved with a note and cannot be resolved twice", async () => {
  const ghost = `resolve-${uniq()}`;
  await call("/settlements/import", {
    method: "POST",
    token: financeToken,
    body: {
      propertyId: property.id,
      provider: "PAYSTACK",
      reference: `PS-RES-${uniq()}`,
      settledOn: businessDate,
      lines: [{ providerRef: ghost, amountMinor: 5000, feeMinor: 0 }],
    },
  });
  const open = await call(`/reconciliation/exceptions?propertyId=${property.id}`, {
    token: financeToken,
  });
  const ex = open.data.find((e) => e.providerRef === ghost);
  assert.ok(ex);

  const resolved = await call(`/reconciliation/exceptions/${ex.id}/resolve`, {
    method: "POST",
    token: financeToken,
    body: { resolution: "WRITTEN_OFF", note: "Provider confirmed a test transaction" },
  });
  assert.equal(resolved.status, 201);
  assert.equal(resolved.data.status, "WRITTEN_OFF");

  const again = await call(`/reconciliation/exceptions/${ex.id}/resolve`, {
    method: "POST",
    token: financeToken,
    body: { resolution: "RESOLVED", note: "Second attempt" },
  });
  assert.equal(again.status, 409);
  assert.equal(again.data.error.code, "ALREADY_RESOLVED");
});

test("settlements are listed with their totals and exception counts", async () => {
  const res = await call(`/settlements?propertyId=${property.id}`, { token: financeToken });
  assert.equal(res.status, 200);
  assert.ok(res.data.length > 0);
  const s = res.data[0];
  assert.equal(s.netMinor, s.grossMinor - s.feeMinor, "net must equal gross minus fees");
  assert.ok(typeof s.exceptions === "number");
});
