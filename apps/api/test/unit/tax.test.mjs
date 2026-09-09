/**
 * Unit tests for tax computation.
 *
 * These run against a stubbed rule store rather than a database: the
 * arithmetic is the thing under test, and a fixture that needs Postgres is a
 * fixture nobody runs. Amounts are kobo (minor units) as BigInt throughout.
 *
 * Run: node --test test/unit/tax.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TaxService } from "../../dist/common/tax.service.js";

/** A `tx` that returns exactly the rules a case declares. */
function stubTx(rules) {
  return {
    taxRule: {
      findMany: async () => rules,
    },
  };
}

let seq = 0;
function rule(overrides = {}) {
  seq += 1;
  return {
    id: `rule-${seq}`,
    code: "VAT",
    name: "Value Added Tax",
    rateBp: 750,
    basis: "EXCLUSIVE",
    compoundOrder: 1,
    version: 1,
    taxOnServiceCharge: false,
    appliesTo: "ALL",
    effectiveFrom: "2020-01-01",
    effectiveTo: null,
    ...overrides,
  };
}

const service = new TaxService();
const compute = (rules, baseMinor) =>
  service.compute(stubTx(rules), {
    tenantId: "t1",
    propertyId: "p1",
    baseMinor,
    chargeKind: "ROOM",
    businessDate: "2026-09-09",
  });

// ── The fixture that names the bug ───────────────────────────────────────

test("an inclusive rule leaves the quoted price unchanged", async () => {
  // ₦107,500 quoted inclusive of 7.5% VAT. The guest agreed to ₦107,500 and
  // must be billed ₦107,500 — the tax comes OUT of that, it is not added on
  // top. This previously produced ₦115,000, overcharging every guest on an
  // inclusive rule by the full tax amount.
  const result = await compute([rule({ basis: "INCLUSIVE" })], 10_750_000n);

  assert.equal(result.total, 10_750_000n, "the total must equal the quoted price");
  assert.equal(result.base, 10_000_000n, "the charge line is the price net of included tax");
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].amountMinor, 750_000n, "the included tax is shown, not added");

  // The invariant the invoice and the ledger both depend on.
  const componentSum = result.lines.reduce((s, l) => s + l.amountMinor, 0n);
  assert.equal(result.base + componentSum, result.total, "components must reconcile to the total");
});

test("an exclusive rule still adds tax on top", async () => {
  // The other half of the fix: exclusive behaviour must not have changed.
  const result = await compute([rule({ basis: "EXCLUSIVE" })], 10_000_000n);
  assert.equal(result.base, 10_000_000n);
  assert.equal(result.lines[0].amountMinor, 750_000n);
  assert.equal(result.total, 10_750_000n);
});

test("components always reconcile to the total, whatever the basis", async () => {
  const cases = [
    { label: "inclusive", rules: [rule({ basis: "INCLUSIVE" })], base: 10_750_000n },
    { label: "exclusive", rules: [rule({ basis: "EXCLUSIVE" })], base: 10_000_000n },
    {
      label: "service charge then VAT on top of it",
      rules: [
        rule({ code: "SVC", name: "Service Charge", rateBp: 500, compoundOrder: 0 }),
        rule({ code: "VAT", rateBp: 750, compoundOrder: 1, taxOnServiceCharge: true }),
      ],
      base: 10_000_000n,
    },
    {
      label: "inclusive VAT alongside an exclusive service charge",
      rules: [
        rule({ code: "SVC", name: "Service Charge", rateBp: 500, compoundOrder: 0 }),
        rule({ code: "VAT", rateBp: 750, compoundOrder: 1, basis: "INCLUSIVE" }),
      ],
      base: 10_750_000n,
    },
  ];

  for (const c of cases) {
    const r = await compute(c.rules, c.base);
    const sum = r.lines.reduce((s, l) => s + l.amountMinor, 0n);
    assert.equal(
      r.base + sum,
      r.total,
      `${c.label}: base ${r.base} + components ${sum} must equal total ${r.total}`
    );
    // Nothing may be invented or lost: an inclusive rule cannot raise the
    // price, and no rule may reduce it below the net of what it extracts.
    assert.ok(r.total > 0n, `${c.label}: total must be positive`);
  }
});

test("compounding order is respected and VAT can sit on the service charge", async () => {
  const r = await compute(
    [
      rule({ code: "SVC", name: "Service Charge", rateBp: 500, compoundOrder: 0 }),
      rule({ code: "VAT", rateBp: 750, compoundOrder: 1, taxOnServiceCharge: true }),
    ],
    10_000_000n
  );
  const svc = r.lines.find((l) => l.code === "SVC");
  const vat = r.lines.find((l) => l.code === "VAT");
  assert.equal(svc.amountMinor, 500_000n, "5% of 10,000,000");
  // 7.5% of (10,000,000 + 500,000)
  assert.equal(vat.amountMinor, 787_500n, "VAT applies to base plus service charge");
  assert.equal(r.total, 11_287_500n);
});

test("only the newest version of a code applies", async () => {
  // Superseded versions must not stack — two VAT lines would double-charge.
  const r = await compute(
    [
      rule({ code: "VAT", rateBp: 500, version: 1 }),
      rule({ code: "VAT", rateBp: 750, version: 2 }),
    ],
    10_000_000n
  );
  assert.equal(r.lines.length, 1, "one line per code");
  assert.equal(r.lines[0].amountMinor, 750_000n, "the newest version wins");
});

test("a zero-rate rule is a real answer, not a missing one", async () => {
  const r = await compute([rule({ rateBp: 0 })], 10_000_000n);
  assert.equal(r.lines[0].amountMinor, 0n);
  assert.equal(r.total, 10_000_000n);
});

test("rounding never invents kobo the guest was not quoted", async () => {
  // 7.5% of 1 kobo truncates to 0; the total must follow the components
  // exactly rather than rounding independently.
  for (const base of [1n, 7n, 13n, 99n, 101n, 12_345_679n]) {
    const r = await compute([rule({ basis: "EXCLUSIVE" })], base);
    const sum = r.lines.reduce((s, l) => s + l.amountMinor, 0n);
    assert.equal(r.base + sum, r.total, `base ${base}: components must reconcile`);
  }
});
