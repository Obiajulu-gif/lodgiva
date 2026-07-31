import test from "node:test";
import assert from "node:assert/strict";

/**
 * Cache-policy rules, extracted so they can be asserted without a browser.
 * These mirror src/cache.ts exactly; the point of the test is that the
 * dangerous list stays dangerous.
 */
const CACHEABLE = [
  /^\/properties\/[^/]+\/room-rack/,
  /^\/housekeeping\/tasks/,
  /^\/maintenance\/tickets/,
  /^\/config\/rooms/,
  /^\/config\/room-types/,
  /^\/auth\/me$/,
  /^\/front-desk\/(arrivals|departures|in-house)/,
];
const NEVER_CACHE = [
  /^\/folios/,
  /^\/payments/,
  /^\/invoices/,
  /^\/reports/,
  /^\/cashiering/,
  /^\/gateway/,
  /^\/settlements/,
];

function isCacheable(path) {
  const clean = path.split("?")[0];
  if (NEVER_CACHE.some((re) => re.test(clean))) return false;
  return CACHEABLE.some((re) => re.test(clean));
}

test("operational reads a housekeeper needs are cacheable", () => {
  for (const p of [
    "/housekeeping/tasks?propertyId=abc",
    "/maintenance/tickets?propertyId=abc",
    "/properties/abc/room-rack",
    "/config/rooms?propertyId=abc",
    "/auth/me",
    "/front-desk/arrivals?propertyId=abc",
  ]) {
    assert.equal(isCacheable(p), true, `${p} should be cacheable`);
  }
});

test("money is never cached", () => {
  // A stale balance is worse than no balance: someone could take payment
  // against a figure that moved minutes ago.
  for (const p of [
    "/folios/abc",
    "/payments?propertyId=abc",
    "/invoices?propertyId=abc",
    "/reports/daily-flash?propertyId=abc",
    "/cashiering/shifts?propertyId=abc",
    "/gateway/exceptions",
    "/settlements?propertyId=abc",
  ]) {
    assert.equal(isCacheable(p), false, `${p} must never be cached`);
  }
});

test("unknown paths are not cached by default", () => {
  // Fail closed: a new endpoint is uncacheable until someone opts it in.
  for (const p of ["/guests", "/reservations", "/night-audit/history", "/files"]) {
    assert.equal(isCacheable(p), false, `${p} should not be cached implicitly`);
  }
});

test("query strings do not defeat the deny list", () => {
  assert.equal(isCacheable("/folios/abc?include=entries"), false);
  assert.equal(isCacheable("/payments?propertyId=x&status=CONFIRMED"), false);
});

test("a path that merely contains a safe word is still denied", () => {
  // /reports is denied even though "/config/rooms" is allowed; prefix
  // anchoring must not be fooled by substrings.
  assert.equal(isCacheable("/reports/tax-summary"), false);
  assert.equal(isCacheable("/config/rooms"), true);
});
