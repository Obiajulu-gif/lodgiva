import test from "node:test";
import assert from "node:assert/strict";
import {
  normaliseDate,
  parseMoneyToMinor,
  parseSettlementCsv,
} from "../../dist/common/settlement-csv.js";

// ── Money parsing ────────────────────────────────────────────────────────

test("major-unit amounts convert to minor without losing a kobo", () => {
  assert.equal(parseMoneyToMinor("46500.50"), 4650050);
  assert.equal(parseMoneyToMinor("1"), 100);
  assert.equal(parseMoneyToMinor("0.01"), 1);
  // Truncation would drop the final kobo here; rounding must not.
  assert.equal(parseMoneyToMinor("100.005"), 10001);
});

test("real-world formatting is tolerated", () => {
  assert.equal(parseMoneyToMinor("₦1,234,567.89"), 123456789);
  assert.equal(parseMoneyToMinor("NGN 500.00"), 50000);
  assert.equal(parseMoneyToMinor("  2,000  "), 200000);
});

test("negative and parenthesised amounts are preserved as negatives", () => {
  // Refund/reversal rows appear as negatives in payout exports. Dropping or
  // flipping them would overstate the payout.
  assert.equal(parseMoneyToMinor("-250.00"), -25000);
  assert.equal(parseMoneyToMinor("(1,234.50)"), -123450);
});

test("nonsense amounts are rejected rather than coerced to zero", () => {
  for (const bad of ["", "   ", "abc", "12.34.56", "1,2,3.4.5", "N/A"]) {
    assert.throws(() => parseMoneyToMinor(bad), `should reject "${bad}"`);
  }
});

// ── Date normalisation ───────────────────────────────────────────────────

test("dates normalise from the formats exports actually use", () => {
  assert.equal(normaliseDate("2026-07-31"), "2026-07-31");
  assert.equal(normaliseDate("2026-07-31T09:14:00Z"), "2026-07-31");
  // dd/mm/yyyy is the Nigerian convention — 07/08 must be 7 August, not 8 July.
  assert.equal(normaliseDate("07/08/2026"), "2026-08-07");
  assert.equal(normaliseDate("not a date"), undefined);
});

// ── Paystack export ──────────────────────────────────────────────────────

const paystackCsv = `Transaction Reference,Amount,Fees,Paid At,Customer
PSK-001,"46,500.50",697.51,2026-07-30T10:00:00Z,Adaeze
PSK-002,12000.00,180.00,2026-07-30T11:30:00Z,Tunde
PSK-003,"1,000",15,2026-07-30T12:00:00Z,Chiamaka`;

test("a Paystack export maps to lines in minor units", () => {
  const parsed = parseSettlementCsv("PAYSTACK", paystackCsv);
  assert.equal(parsed.lines.length, 3);
  assert.equal(parsed.skipped.length, 0);

  assert.deepEqual(parsed.lines[0], {
    providerRef: "PSK-001",
    amountMinor: 4650050,
    feeMinor: 69751,
    paidOn: "2026-07-30",
  });
  assert.equal(parsed.lines[1].amountMinor, 1200000);
  assert.equal(parsed.lines[2].amountMinor, 100000);

  assert.equal(parsed.totalMinor, 4650050 + 1200000 + 100000);
  assert.equal(parsed.feeTotalMinor, 69751 + 18000 + 1500);
});

test("CSV amounts are read as naira even though the Paystack API uses kobo", () => {
  // The single most dangerous confusion in this import: reading the CSV as
  // kobo would understate every payout 100-fold.
  const parsed = parseSettlementCsv("PAYSTACK", "Reference,Amount\nPSK-9,500.00");
  assert.equal(parsed.lines[0].amountMinor, 50000, "500 naira is 50,000 kobo");
});

test("an export already in minor units can be imported without conversion", () => {
  const parsed = parseSettlementCsv("PAYSTACK", "Reference,Amount\nPSK-9,50000", {
    amountsAreMajor: false,
  });
  assert.equal(parsed.lines[0].amountMinor, 50000);
});

test("column lookup ignores case, spacing and punctuation", () => {
  const parsed = parseSettlementCsv(
    "PAYSTACK",
    "transaction_reference,AMOUNT ,  Fees\nPSK-7,100.00,1.50"
  );
  assert.equal(parsed.lines[0].providerRef, "PSK-7");
  assert.equal(parsed.lines[0].amountMinor, 10000);
  assert.equal(parsed.lines[0].feeMinor, 150);
});

test("a missing fee column defaults to zero rather than failing", () => {
  const parsed = parseSettlementCsv("PAYSTACK", "Reference,Amount\nPSK-1,100.00");
  assert.equal(parsed.lines[0].feeMinor, 0);
});

// ── Flutterwave export ───────────────────────────────────────────────────

const flwCsv = `tx_ref,Amount,App Fee,Created At
FLW-001,"46,500.50",651.01,07/08/2026
FLW-002,7500,105,07/08/2026`;

test("a Flutterwave export maps using its own column names", () => {
  const parsed = parseSettlementCsv("FLUTTERWAVE", flwCsv);
  assert.equal(parsed.lines.length, 2);
  assert.equal(parsed.lines[0].providerRef, "FLW-001");
  assert.equal(parsed.lines[0].amountMinor, 4650050);
  assert.equal(parsed.lines[0].feeMinor, 65101);
  assert.equal(parsed.lines[0].paidOn, "2026-08-07");
});

// ── Robustness ───────────────────────────────────────────────────────────

test("unreadable rows are reported, not silently dropped", () => {
  const csv = `Reference,Amount,Fees
PSK-1,100.00,1.00
PSK-2,not-a-number,1.00
,500.00,1.00
PSK-4,,1.00
PSK-5,250.00,2.00`;
  const parsed = parseSettlementCsv("PAYSTACK", csv);
  assert.equal(parsed.lines.length, 2, "only the two clean rows import");
  assert.equal(parsed.skipped.length, 3);
  // Row numbers are 1-based including the header, so finance can find them.
  assert.deepEqual(
    parsed.skipped.map((s) => s.row),
    [3, 4, 5]
  );
  assert.match(parsed.skipped[1].reason, /reference/i);
});

test("quoted fields containing commas and newlines survive", () => {
  const csv = 'Reference,Amount,Narration\nPSK-1,"1,500.00","Room 204, late\ncheckout"';
  const parsed = parseSettlementCsv("PAYSTACK", csv);
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].amountMinor, 150000);
});

test("a BOM from an Excel export does not break the first column", () => {
  const parsed = parseSettlementCsv("PAYSTACK", "﻿Reference,Amount\nPSK-1,100.00");
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].providerRef, "PSK-1");
});

test("a file that is not a settlement export is rejected with guidance", () => {
  assert.throws(
    () => parseSettlementCsv("PAYSTACK", "Guest,Room\nAdaeze,204"),
    /does not look like a PAYSTACK settlement export/
  );
});

test("an unmapped provider is rejected", () => {
  assert.throws(
    () => parseSettlementCsv("STRIPE", "Reference,Amount\nX,1"),
    /No CSV mapping/
  );
});

test("negative payout rows import as negatives", () => {
  const parsed = parseSettlementCsv(
    "PAYSTACK",
    "Reference,Amount,Fees\nPSK-R1,(250.00),0"
  );
  assert.equal(parsed.lines[0].amountMinor, -25000);
  assert.equal(parsed.lines[0].feeMinor, 0);
});
