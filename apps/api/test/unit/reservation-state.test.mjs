import test from "node:test";
import assert from "node:assert/strict";
import {
  RESERVATION_STATES,
  TRANSITIONS,
  TERMINAL_STATES,
  canTransition,
  explainRejection,
  holdsInventory,
  isModifiable,
  isTerminal,
} from "../../dist/common/reservation-state.js";

test("the happy path walks all the way to checked out", () => {
  const path = ["DRAFT", "CONFIRMED", "CHECKED_IN", "CHECKED_OUT"];
  for (let i = 0; i < path.length - 1; i++) {
    assert.ok(canTransition(path[i], path[i + 1]), `${path[i]} → ${path[i + 1]} should be legal`);
  }
});

test("the booking-engine path walks hold → payment → confirmed", () => {
  assert.ok(canTransition("DRAFT", "HOLD"));
  assert.ok(canTransition("HOLD", "PENDING_PAYMENT"));
  assert.ok(canTransition("PENDING_PAYMENT", "CONFIRMED"));
});

test("terminal states are exactly checked out, cancelled and no-show", () => {
  assert.deepEqual([...TERMINAL_STATES].sort(), ["CANCELLED", "CHECKED_OUT", "NO_SHOW"]);
  for (const s of TERMINAL_STATES) {
    assert.ok(isTerminal(s));
    for (const target of RESERVATION_STATES) {
      assert.equal(canTransition(s, target), false, `${s} must not move to ${target}`);
    }
  }
});

test("a stay cannot skip check-in", () => {
  assert.equal(canTransition("CONFIRMED", "CHECKED_OUT"), false);
  assert.match(explainRejection("CONFIRMED", "CHECKED_OUT"), /must be checked in/i);
});

test("an in-house guest cannot be cancelled or marked no-show", () => {
  assert.equal(canTransition("CHECKED_IN", "CANCELLED"), false);
  assert.equal(canTransition("CHECKED_IN", "NO_SHOW"), false);
  assert.match(explainRejection("CHECKED_IN", "CANCELLED"), /check them out instead/i);
});

test("only a confirmed reservation can become a no-show", () => {
  for (const s of RESERVATION_STATES) {
    assert.equal(
      canTransition(s, "NO_SHOW"),
      s === "CONFIRMED",
      `${s} → NO_SHOW should be ${s === "CONFIRMED"}`
    );
  }
});

test("no state transitions to itself", () => {
  for (const s of RESERVATION_STATES) {
    assert.equal(canTransition(s, s), false, `${s} should not transition to itself`);
  }
});

test("every state is reachable from DRAFT", () => {
  const seen = new Set(["DRAFT"]);
  const queue = ["DRAFT"];
  while (queue.length) {
    for (const next of TRANSITIONS[queue.shift()]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  for (const s of RESERVATION_STATES) {
    assert.ok(seen.has(s), `${s} is unreachable from DRAFT — dead state in the machine`);
  }
});

test("every transition target is itself a known state", () => {
  for (const [from, targets] of Object.entries(TRANSITIONS)) {
    for (const t of targets) {
      assert.ok(RESERVATION_STATES.includes(t), `${from} → ${t} names an unknown state`);
    }
  }
});

test("cancellation is available from every non-terminal state", () => {
  for (const s of RESERVATION_STATES) {
    if (isTerminal(s) || s === "CHECKED_IN") continue;
    assert.ok(canTransition(s, "CANCELLED"), `${s} should be cancellable`);
  }
});

test("inventory-holding states are exactly those that have sold a room", () => {
  assert.equal(holdsInventory("HOLD"), true);
  assert.equal(holdsInventory("PENDING_PAYMENT"), true);
  assert.equal(holdsInventory("CONFIRMED"), true);
  assert.equal(holdsInventory("CHECKED_IN"), true);
  // A draft has not sold anything; terminal states have already released.
  assert.equal(holdsInventory("DRAFT"), false);
  for (const s of TERMINAL_STATES) {
    assert.equal(holdsInventory(s), false, `${s} must not hold inventory`);
  }
});

test("stay details are modifiable only before the guest arrives", () => {
  assert.equal(isModifiable("CONFIRMED"), true);
  assert.equal(isModifiable("HOLD"), true);
  // Once in house, changes go through room move / extend, not a blanket edit.
  assert.equal(isModifiable("CHECKED_IN"), false);
  for (const s of TERMINAL_STATES) {
    assert.equal(isModifiable(s), false);
  }
});

test("rejection messages name the legal alternatives", () => {
  const msg = explainRejection("DRAFT", "CHECKED_OUT");
  assert.match(msg, /Allowed from here/);
  assert.match(msg, /CONFIRMED/);
});

test("rejecting a same-state move says so plainly", () => {
  assert.match(explainRejection("CONFIRMED", "CONFIRMED"), /already confirmed/i);
});
