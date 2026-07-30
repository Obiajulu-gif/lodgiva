import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRestrictions } from "../../dist/common/restrictions.js";

const nights = (from, count) => {
  const out = [];
  const d = new Date(from + "T00:00:00Z");
  for (let i = 0; i < count; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
};

const base = (overrides = {}) => ({
  nights: nights("2026-08-10", 2),
  departureDate: "2026-08-12",
  restrictions: new Map(),
  planMinStay: 1,
  businessDate: "2026-08-01",
  ...overrides,
});

test("an unrestricted stay produces no violations", () => {
  assert.deepEqual(evaluateRestrictions(base()), []);
});

test("a closed night blocks the stay and names the date", () => {
  const r = new Map([["2026-08-11", { date: "2026-08-11", closed: true }]]);
  const v = evaluateRestrictions(base({ restrictions: r }));
  assert.equal(v.length, 1);
  assert.equal(v[0].code, "DATES_CLOSED");
  assert.deepEqual(v[0].details.dates, ["2026-08-11"]);
});

test("closed-to-arrival applies only to the arrival night", () => {
  const cta = new Map([["2026-08-10", { date: "2026-08-10", closedToArrival: true }]]);
  assert.equal(evaluateRestrictions(base({ restrictions: cta }))[0].code, "CLOSED_TO_ARRIVAL");

  // The same flag on a later night must not block the stay.
  const later = new Map([["2026-08-11", { date: "2026-08-11", closedToArrival: true }]]);
  assert.deepEqual(evaluateRestrictions(base({ restrictions: later })), []);
});

test("closed-to-departure applies to the departure date, not the last night", () => {
  const ctd = new Map([["2026-08-12", { date: "2026-08-12", closedToDeparture: true }]]);
  assert.equal(evaluateRestrictions(base({ restrictions: ctd }))[0].code, "CLOSED_TO_DEPARTURE");

  // The last *night* is the 11th; CTD there is irrelevant.
  const lastNight = new Map([["2026-08-11", { date: "2026-08-11", closedToDeparture: true }]]);
  assert.deepEqual(evaluateRestrictions(base({ restrictions: lastNight })), []);
});

test("plan-level minimum stay is enforced", () => {
  const v = evaluateRestrictions(base({ planMinStay: 3 }));
  assert.equal(v[0].code, "MIN_STAY_NOT_MET");
  assert.equal(v[0].details.minStay, 3);
  assert.equal(v[0].details.requested, 2);
});

test("a date-level minimum stay overrides the plan default", () => {
  const r = new Map([["2026-08-10", { date: "2026-08-10", minStay: 1 }]]);
  assert.deepEqual(evaluateRestrictions(base({ planMinStay: 5, restrictions: r })), []);
});

test("maximum stay is enforced from the arrival date", () => {
  const r = new Map([["2026-08-10", { date: "2026-08-10", maxStay: 1 }]]);
  const v = evaluateRestrictions(base({ restrictions: r }));
  assert.equal(v[0].code, "MAX_STAY_EXCEEDED");
  assert.equal(v[0].details.maxStay, 1);
});

test("advance-purchase rules compare against the business date", () => {
  // 9 days of lead time; the rule demands 14.
  const r = new Map([["2026-08-10", { date: "2026-08-10", minAdvanceDays: 14 }]]);
  const v = evaluateRestrictions(base({ restrictions: r }));
  assert.equal(v[0].code, "MIN_ADVANCE_NOT_MET");
  assert.equal(v[0].details.leadDays, 9);

  // Same rule, booked far enough ahead.
  assert.deepEqual(
    evaluateRestrictions(base({ restrictions: r, businessDate: "2026-07-01" })),
    []
  );
});

test("minAdvanceDays of 0 permits same-day booking", () => {
  const r = new Map([["2026-08-10", { date: "2026-08-10", minAdvanceDays: 0 }]]);
  assert.deepEqual(
    evaluateRestrictions(base({ restrictions: r, businessDate: "2026-08-10" })),
    []
  );
});

test("all violations are reported together, not just the first", () => {
  const r = new Map([
    ["2026-08-10", { date: "2026-08-10", closedToArrival: true, maxStay: 1 }],
    ["2026-08-11", { date: "2026-08-11", closed: true }],
  ]);
  const codes = evaluateRestrictions(base({ restrictions: r })).map((v) => v.code).sort();
  assert.deepEqual(codes, ["CLOSED_TO_ARRIVAL", "DATES_CLOSED", "MAX_STAY_EXCEEDED"]);
});

test("an empty stay yields no violations rather than throwing", () => {
  assert.deepEqual(evaluateRestrictions(base({ nights: [] })), []);
});
