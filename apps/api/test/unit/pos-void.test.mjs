/**
 * Unit tests for the POS void approval rule.
 *
 * Run: node --test test/unit/pos-void.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideVoid,
  POS_VOID_SELF_SERVICE_MINOR,
  POS_VOID_GRACE_MINUTES,
} from "../../dist/common/pos-void.js";

const T = POS_VOID_SELF_SERVICE_MINOR;
const G = POS_VOID_GRACE_MINUTES;

test("a small mistake caught immediately needs nobody", () => {
  const d = decideVoid({ totalMinor: 120_000, ageMinutes: 2, canApprove: false });
  assert.equal(d.requiresApproval, false);
  assert.equal(d.message, null);
});

test("the thresholds are inclusive at the boundary", () => {
  // Exactly at the limit is still a correction; one kobo over is not.
  assert.equal(decideVoid({ totalMinor: T, ageMinutes: G, canApprove: false }).requiresApproval, false);
  assert.equal(decideVoid({ totalMinor: T + 1, ageMinutes: G, canApprove: false }).requiresApproval, true);
  assert.equal(decideVoid({ totalMinor: T, ageMinutes: G + 1, canApprove: false }).requiresApproval, true);
});

test("an aged order needs approval however small it is", () => {
  // This is the theft pattern the rule exists for: a cheap ticket voided at
  // the end of a shift, long after the cash was taken.
  const d = decideVoid({ totalMinor: 50_000, ageMinutes: 240, canApprove: false });
  assert.equal(d.requiresApproval, true);
  assert.match(d.message, /correction window/);
  assert.match(d.message, /240 minutes/);
});

test("a large order needs approval even seconds after it is opened", () => {
  const d = decideVoid({ totalMinor: T * 4, ageMinutes: 0.5, canApprove: false });
  assert.equal(d.requiresApproval, true);
  assert.match(d.message, /above/, "the message must say why");
});

test("when an order is both large and old the amount is the stated reason", () => {
  const d = decideVoid({ totalMinor: T * 10, ageMinutes: 600, canApprove: false });
  assert.equal(d.requiresApproval, true);
  assert.match(d.message, /above/, "the supervisor asks about the amount first");
});

test("an approver does not raise a request against themselves", () => {
  // Their name still lands on the audit entry, which is where the control is.
  for (const [totalMinor, ageMinutes] of [
    [50_000, 1],
    [T * 100, 10_000],
  ]) {
    assert.equal(decideVoid({ totalMinor, ageMinutes, canApprove: true }).requiresApproval, false);
  }
});
