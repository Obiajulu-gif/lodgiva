import test from "node:test";
import assert from "node:assert/strict";
import { minorBigInt, naira } from "../src/money.ts";

test("formats PostgreSQL BigInt strings as exact naira values", () => {
  assert.equal(naira("3500000"), "₦35,000.00");
  assert.equal(naira("-125050"), "-₦1,250.50");
});

test("does not lose precision above Number.MAX_SAFE_INTEGER", () => {
  assert.equal(naira("900719925474099300"), "₦9,007,199,254,740,993.00");
  assert.equal(minorBigInt("900719925474099300"), 900719925474099300n);
});

test("rejects unsafe numbers and displays malformed API values safely", () => {
  assert.throws(() => minorBigInt(Number.MAX_SAFE_INTEGER + 1), /safe integer/);
  assert.equal(naira("not-money"), "—");
});
