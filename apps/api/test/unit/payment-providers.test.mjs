import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  FlutterwaveProvider,
  PaystackProvider,
  safeEqual,
} from "../../dist/common/payment-providers.js";

const PAYSTACK_SECRET = "sk_test_unit_secret_key";
const FLW_HASH = "flw-webhook-shared-secret";

const paystack = new PaystackProvider(PAYSTACK_SECRET);
const flutterwave = new FlutterwaveProvider("FLWSECK_TEST-unit", FLW_HASH);

const sign = (body) =>
  createHmac("sha512", PAYSTACK_SECRET).update(body).digest("hex");

const paystackBody = (over = {}) =>
  Buffer.from(
    JSON.stringify({
      event: "charge.success",
      data: {
        id: 302961,
        reference: "LDG-abc123",
        amount: 4650000,
        currency: "NGN",
        status: "success",
        fees: 69750,
        ...over,
      },
    })
  );

// ── safeEqual ────────────────────────────────────────────────────────────

test("safeEqual matches identical strings and rejects everything else", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  // Different lengths must not throw — timingSafeEqual does if lengths differ.
  assert.equal(safeEqual("abc", "abcdef"), false);
  assert.equal(safeEqual("", ""), true);
  assert.equal(safeEqual(undefined, "abc"), false);
  assert.equal(safeEqual("abc", undefined), false);
});

// ── Paystack signatures ──────────────────────────────────────────────────

test("Paystack accepts a correct HMAC-SHA512 over the raw body", () => {
  const body = paystackBody();
  assert.equal(
    paystack.verifySignature(body, { "x-paystack-signature": sign(body) }),
    true
  );
});

test("Paystack rejects a tampered body even by one byte", () => {
  const body = paystackBody();
  const signature = sign(body);
  // Attacker inflates the amount but reuses the original signature.
  const tampered = Buffer.from(
    body.toString("utf8").replace('"amount":4650000', '"amount":1')
  );
  assert.equal(
    paystack.verifySignature(tampered, { "x-paystack-signature": signature }),
    false
  );
});

test("Paystack rejects a signature made with a different secret", () => {
  const body = paystackBody();
  const wrong = createHmac("sha512", "sk_test_someone_elses_key")
    .update(body)
    .digest("hex");
  assert.equal(paystack.verifySignature(body, { "x-paystack-signature": wrong }), false);
});

test("Paystack rejects missing, empty and malformed signature headers", () => {
  const body = paystackBody();
  assert.equal(paystack.verifySignature(body, {}), false);
  assert.equal(paystack.verifySignature(body, { "x-paystack-signature": "" }), false);
  assert.equal(paystack.verifySignature(body, { "x-paystack-signature": "not-hex" }), false);
});

test("verification depends on exact bytes, not on parsed equivalence", () => {
  // Same JSON value, different serialisation. A handler that re-stringified
  // the parsed body would wrongly accept this against the original signature.
  const original = paystackBody();
  const signature = sign(original);
  const reserialised = Buffer.from(
    JSON.stringify(JSON.parse(original.toString("utf8")), null, 2)
  );
  assert.notEqual(original.toString(), reserialised.toString());
  assert.equal(
    paystack.verifySignature(reserialised, { "x-paystack-signature": signature }),
    false,
    "re-serialised body must not validate against the original signature"
  );
});

test("a provider with no secret configured never validates a signature", () => {
  const unconfigured = new PaystackProvider("");
  const body = paystackBody();
  assert.equal(
    unconfigured.verifySignature(body, { "x-paystack-signature": sign(body) }),
    false
  );
});

// ── Paystack parsing ─────────────────────────────────────────────────────

test("Paystack parses a successful charge in kobo without conversion", () => {
  const parsed = paystack.parseWebhook(paystackBody());
  assert.equal(parsed.eventType, "charge.success");
  assert.equal(parsed.reference, "LDG-abc123");
  assert.equal(parsed.providerRef, "302961");
  assert.equal(parsed.amountMinor, 4650000n, "Paystack kobo maps 1:1 to minor units");
  assert.equal(parsed.feeMinor, 69750n);
  assert.equal(parsed.isSuccessfulPayment, true);
  assert.equal(parsed.externalId, "charge.success:302961");
});

test("Paystack does not treat a failed charge as a payment", () => {
  const parsed = paystack.parseWebhook(paystackBody({ status: "failed" }));
  assert.equal(parsed.isSuccessfulPayment, false);
});

test("Paystack does not treat a non-charge event as a payment", () => {
  const body = Buffer.from(
    JSON.stringify({ event: "transfer.success", data: { id: 5, status: "success" } })
  );
  assert.equal(paystack.parseWebhook(body).isSuccessfulPayment, false);
});

test("Paystack falls back to a body hash when no transaction id is present", () => {
  const body = Buffer.from(JSON.stringify({ event: "charge.success", data: {} }));
  const parsed = paystack.parseWebhook(body);
  assert.match(parsed.externalId, /^[a-f0-9]{64}$/, "should be a sha256 hex digest");
});

// ── Flutterwave ──────────────────────────────────────────────────────────

const flwBody = (over = {}) =>
  Buffer.from(
    JSON.stringify({
      event: "charge.completed",
      data: {
        id: 4567,
        tx_ref: "LDG-xyz789",
        amount: 46500.5,
        currency: "NGN",
        status: "successful",
        app_fee: 651.01,
        ...over,
      },
    })
  );

test("Flutterwave accepts the shared secret echoed in verif-hash", () => {
  assert.equal(flutterwave.verifySignature(flwBody(), { "verif-hash": FLW_HASH }), true);
});

test("Flutterwave rejects a wrong or missing verif-hash", () => {
  assert.equal(flutterwave.verifySignature(flwBody(), { "verif-hash": "wrong" }), false);
  assert.equal(flutterwave.verifySignature(flwBody(), {}), false);
  assert.equal(
    new FlutterwaveProvider("FLWSECK_TEST-x", "").verifySignature(flwBody(), {
      "verif-hash": "anything",
    }),
    false,
    "unconfigured hash must never validate"
  );
});

test("Flutterwave converts major units to minor without losing a kobo", () => {
  const parsed = flutterwave.parseWebhook(flwBody());
  // 46500.50 naira → 4650050 kobo; naive truncation would lose 50 kobo.
  assert.equal(parsed.amountMinor, 4650050n);
  assert.equal(parsed.feeMinor, 65101n);
  assert.equal(parsed.isSuccessfulPayment, true);
  assert.equal(parsed.reference, "LDG-xyz789");
});

test("Flutterwave handles the dotted event.type variant", () => {
  const body = Buffer.from(
    JSON.stringify({
      "event.type": "CHARGE_COMPLETED",
      data: { id: 1, tx_ref: "LDG-1", amount: 100, status: "successful" },
    })
  );
  const parsed = flutterwave.parseWebhook(body);
  assert.equal(parsed.eventType, "CHARGE_COMPLETED");
  assert.equal(parsed.isSuccessfulPayment, true);
});

test("Flutterwave does not treat a pending charge as a payment", () => {
  assert.equal(flutterwave.parseWebhook(flwBody({ status: "pending" })).isSuccessfulPayment, false);
});

// ── Sandbox honesty ──────────────────────────────────────────────────────

test("unconfigured adapters report sandbox mode and refuse to confirm money", async () => {
  const sandboxPaystack = new PaystackProvider("");
  assert.equal(sandboxPaystack.live, false);

  const verified = await sandboxPaystack.verify("LDG-anything");
  assert.equal(verified.verified, false, "sandbox must never report a payment as verified");
  assert.match(verified.note, /sandbox/i);

  const refund = await sandboxPaystack.refund({
    providerRef: "1",
    amountMinor: 100n,
    reason: "test",
  });
  assert.equal(refund.accepted, false, "sandbox must never claim a refund was executed");
  assert.match(refund.note, /sandbox/i);
});

test("live mode must be opted into explicitly, never inferred from the key", () => {
  // A plausible-looking test key must NOT put the adapter into live mode:
  // a misconfigured environment would otherwise make real calls to a gateway.
  assert.equal(new PaystackProvider("sk_test_abc").live, false);
  assert.equal(new FlutterwaveProvider("FLWSECK_TEST-abc", "h").live, false);
  // Explicit opt-in is honoured.
  assert.equal(new PaystackProvider("sk_test_abc", true).live, true);
  assert.equal(new FlutterwaveProvider("FLWSECK_TEST-abc", "h", true).live, true);
});

test("signature verification works in sandbox mode too", () => {
  // Forged webhooks must be rejected even where no live credentials exist.
  const sandbox = new PaystackProvider(PAYSTACK_SECRET);
  assert.equal(sandbox.live, false);
  const body = paystackBody();
  assert.equal(sandbox.verifySignature(body, { "x-paystack-signature": sign(body) }), true);
  assert.equal(sandbox.verifySignature(body, { "x-paystack-signature": "bad" }), false);
});

test("sandbox initialise returns the same shape as live, marked as placeholder", async () => {
  const init = await new PaystackProvider("").initialize({
    reference: "LDG-ref",
    amountMinor: 1000n,
    currency: "NGN",
    email: "guest@example.com",
  });
  assert.equal(init.reference, "LDG-ref");
  assert.match(init.checkoutUrl, /sandbox\.local/);
});
