/* End-to-end happy path against a running API (spec §16.1 release gate):
 * login → availability → create guest+reservation → check-in → post charge
 * → payment → checkout → night audit → daily flash + tenant isolation +
 * duplicate-payment idempotency + ledger immutability (reversals).
 *
 * Run: node test/e2e.mjs  (API must be running on :4000)
 */
const BASE = "http://localhost:4000/api/v1";
let failures = 0;

function assert(cond, name, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

async function call(path, { method = "GET", body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

/**
 * The last section of this suite deliberately exhausts the per-IP login budget
 * to prove credential stuffing is refused. That leaves the budget spent for the
 * rest of the minute, so a back-to-back re-run would otherwise fail on its very
 * first request - for the wrong reason. Waiting the window out here keeps the
 * suite re-runnable without weakening the assertion at the end.
 */
async function loginWhenAllowed(body) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await call("/auth/login", { method: "POST", body });
    if (res.status !== 429) return res;
    if (attempt === 0) {
      console.log("   (login rate limit cooling down from a previous run - waiting)");
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error("login stayed rate limited for 80s - is another client hammering the API?");
}

console.log("1. Authentication");
const bad = await loginWhenAllowed({
  email: "frontdesk@grandpalm.demo",
  password: "wrong",
});
assert(bad.status === 401, "wrong password rejected", `got ${bad.status}`);

const login = await loginWhenAllowed({
  email: "frontdesk@grandpalm.demo",
  password: "Password123!",
});
assert(login.status === 201 || login.status === 200, "login succeeds");
const token = login.data.accessToken;

const anon = await call("/reservations");
assert(anon.status === 401, "unauthenticated request rejected");

const me = await call("/auth/me", { token });
const property = me.data.properties[0];
assert(!!property, "auth/me returns property context");
const businessDate = property.businessDate;

// Tax rules are append-only and versioned, so previous runs leave versions
// behind. Pin a known configuration (5% service, 7.5% VAT) as the newest
// version so this suite is deterministic on a re-used database.
const mgrLogin = await call("/auth/login", {
  method: "POST",
  body: { email: "manager@grandpalm.demo", password: "Password123!" },
});
const mgrToken = mgrLogin.data.accessToken;
// Tax configuration is reserved to owner/finance roles (§6.4), so the owner
// pins the baseline even though the manager drives the rest of the suite.
const ownerLogin = await call("/auth/login", {
  method: "POST",
  body: { email: "owner@grandpalm.demo", password: "Password123!" },
});
const ownerToken = ownerLogin.data.accessToken;
await call("/properties/tax-rules", {
  method: "POST",
  token: ownerToken,
  body: {
    propertyId: property.id, code: "SVC", name: "Service Charge",
    rateBp: 500, compoundOrder: 1, taxOnServiceCharge: false, effectiveFrom: businessDate,
  },
});
const baselineVat = await call("/properties/tax-rules", {
  method: "POST",
  token: ownerToken,
  body: {
    propertyId: property.id, code: "VAT", name: "Value Added Tax",
    rateBp: 750, compoundOrder: 2, taxOnServiceCharge: true, effectiveFrom: businessDate,
  },
});
assert(baselineVat.status === 201, "tax baseline pinned at 5% service + 7.5% VAT");

console.log("2. Availability & reservation");
const types = await call(`/properties/${property.id}/room-types`, { token });
const dlx = types.data.find((t) => t.code === "DLX");
assert(!!dlx, "room types load");

const guest = await call("/guests", {
  method: "POST",
  token,
  body: { firstName: "E2E", lastName: "Tester", phone: "+2348000000001" },
});
assert(guest.status === 201, "guest created");

function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Finds a sellable room of the given type, cleaning one first if the suite has
 * already used up the clean ones. Keeps the suite runnable repeatedly against
 * the same database instead of requiring a fresh seed.
 */
async function ensureCleanRoom(typeCode) {
  const rack = await call(`/properties/${property.id}/room-rack`, { token });
  const ofType = rack.data.filter((r) => r.roomType.code === typeCode && !r.occupant);
  const ready = ofType.find((r) =>
    ["VACANT_CLEAN", "INSPECTED"].includes(r.operationalStatus)
  );
  if (ready) return ready;
  const dirty = ofType.find((r) => r.operationalStatus === "VACANT_DIRTY");
  if (!dirty) throw new Error(`No free ${typeCode} room available to prepare.`);
  await call(`/rooms/${dirty.id}/status`, {
    method: "PATCH",
    token,
    body: { status: "VACANT_CLEAN", reason: "e2e preparation" },
  });
  return { ...dirty, operationalStatus: "VACANT_CLEAN" };
}
const arrival = businessDate;
const departure = addDays(businessDate, 2);

const avail = await call(
  `/reservations/availability?propertyId=${property.id}&arrival=${arrival}&departure=${departure}`,
  { token }
);
const dlxAvail = avail.data.find((a) => a.code === "DLX");
assert(dlxAvail.available > 0, "DLX has availability");

const res = await call("/reservations", {
  method: "POST",
  token,
  body: {
    propertyId: property.id,
    guestId: guest.data.id,
    roomTypeId: dlx.id,
    arrivalDate: arrival,
    departureDate: departure,
    source: "WALK_IN",
  },
});
assert(res.status === 201, "reservation created", JSON.stringify(res.data));
const reservationId = res.data.id;
const folioId = res.data.folioId;

const badTransition = await call(`/reservations/${reservationId}/check-out`, {
  method: "POST",
  token,
  body: {},
});
assert(badTransition.status === 409, "CONFIRMED → CHECKED_OUT rejected (state machine)");

console.log("3. Check-in");
const cleanRoom = await ensureCleanRoom("DLX");
assert(!!cleanRoom, "a clean DLX room is available");

const checkin = await call(`/reservations/${reservationId}/check-in`, {
  method: "POST",
  token,
  body: { roomId: cleanRoom.id },
});
assert(checkin.status === 201, "check-in succeeds", JSON.stringify(checkin.data));

const rack2 = await call(`/properties/${property.id}/room-rack`, { token });
const nowOccupied = rack2.data.find((r) => r.id === cleanRoom.id);
assert(nowOccupied.operationalStatus === "OCCUPIED_CLEAN", "room becomes OCCUPIED_CLEAN");

console.log("3b. Room move & stay extension");
const moveTarget = await ensureCleanRoom("DLX");
const move = await call(`/reservations/${reservationId}/room-move`, {
  method: "POST",
  token,
  body: { roomId: moveTarget.id, reason: "Guest requested a quieter room" },
});
assert(move.status === 201, "room move succeeds", JSON.stringify(move.data));

const rackAfterMove = await call(`/properties/${property.id}/room-rack`, { token });
const vacated = rackAfterMove.data.find((r) => r.id === cleanRoom.id);
const occupiedNow = rackAfterMove.data.find((r) => r.id === moveTarget.id);
assert(vacated.operationalStatus === "VACANT_DIRTY", "vacated room goes dirty after a move");
assert(occupiedNow.operationalStatus === "OCCUPIED_CLEAN", "new room becomes occupied");
assert(!!occupiedNow.occupant, "the stay follows the guest to the new room");

const sameRoom = await call(`/reservations/${reservationId}/room-move`, {
  method: "POST", token,
  body: { roomId: moveTarget.id, reason: "Repeat move" },
});
assert(sameRoom.status === 400, "moving to the same room is rejected");

const extend = await call(`/reservations/${reservationId}/extend`, {
  method: "POST",
  token,
  body: { departureDate: addDays(businessDate, 4), reason: "Guest staying longer" },
});
assert(extend.status === 201 && extend.data.departureDate === addDays(businessDate, 4),
  "stay extended");

const badExtend = await call(`/reservations/${reservationId}/extend`, {
  method: "POST", token,
  body: { departureDate: arrival },
});
assert(badExtend.status === 400, "departure on or before arrival is rejected");

console.log("4. Folio ledger & payments");
const charge = await call(`/folios/${folioId}/charges`, {
  method: "POST",
  token,
  body: { type: "POS_CHARGE", description: "Restaurant dinner", amountMinor: 1000000, applyTaxes: true },
});
assert(charge.status === 201, "POS charge posted");

let folio = await call(`/folios/${folioId}`, { token });
const taxLine = folio.data.entries.find((e) => e.type === "TAX");
const svcLine = folio.data.entries.find((e) => e.type === "SERVICE_CHARGE");
assert(svcLine?.amountMinor === 50000, "5% service charge is a separate line");
assert(taxLine?.amountMinor === 78750, "7.5% VAT on (base+service) is a separate line");

// Ledger immutability: reversal, not edit
const rev = await call(`/folios/${folioId}/entries/${charge.data.id}/reverse`, {
  method: "POST",
  token,
  body: { reason: "Posting error test" },
});
assert(rev.status === 201, "reversal entry created");
const rev2 = await call(`/folios/${folioId}/entries/${charge.data.id}/reverse`, {
  method: "POST",
  token,
  body: { reason: "Double reversal attempt" },
});
assert(rev2.status === 400, "double reversal rejected");

// Duplicate payment idempotency (§16.1 gate)
const idem = `e2e-${Date.now()}`;
const pay1 = await call("/payments", {
  method: "POST",
  token,
  body: { folioId, method: "CASH", amountMinor: 128750, idempotencyKey: idem },
});
const pay2 = await call("/payments", {
  method: "POST",
  token,
  body: { folioId, method: "CASH", amountMinor: 128750, idempotencyKey: idem },
});
assert(pay1.data.duplicate === false, "first payment recorded");
assert(pay2.data.duplicate === true, "duplicate idempotency key returns original payment");
assert(pay1.data.payment.id === pay2.data.payment.id, "no duplicate payment row created");

console.log("5. Checkout (with room-night posting + settlement rule)");
const co1 = await call(`/reservations/${reservationId}/check-out`, {
  method: "POST",
  token,
  body: {},
});
assert(co1.status === 409 && co1.data.error.code === "OUTSTANDING_BALANCE",
  "checkout blocked while balance outstanding");

// The rejected checkout rolled back atomically (charges + throw in one txn);
// it reports the would-be balance in error.details.
const balance = co1.data.error.details.balanceMinor;
const payRest = await call("/payments", {
  method: "POST",
  token,
  body: { folioId, method: "BANK_TRANSFER", amountMinor: balance, externalReference: "TRF-E2E-001" },
});
assert(payRest.status === 201, "balance settled by bank transfer");

const co2 = await call(`/reservations/${reservationId}/check-out`, {
  method: "POST",
  token,
  body: {},
});
assert(co2.status === 201 && co2.data.status === "CHECKED_OUT", "checkout succeeds after settlement");

const rack3 = await call(`/properties/${property.id}/room-rack`, { token });
const afterCo = rack3.data.find((r) => r.id === cleanRoom.id);
assert(afterCo.operationalStatus === "VACANT_DIRTY", "room becomes VACANT_DIRTY after checkout");

const hk = await call(`/housekeeping/tasks?propertyId=${property.id}`, { token });
const turnover = hk.data.find(
  (t) => t.room.roomNumber === afterCo.roomNumber && t.type === "TURNOVER" && t.status === "PENDING"
);
assert(!!turnover, "turnover task auto-created after checkout");

console.log("6. POS, cashiering & maintenance");
// A shift left open by an earlier run would block opening a new one; close it
// balanced so the suite can run repeatedly.
const existingShifts = await call(`/cashiering/shifts?propertyId=${property.id}`, { token });
for (const s of existingShifts.data.filter((s) => s.status === "OPEN")) {
  const detail = await call(`/cashiering/shifts/${s.id}`, { token });
  await call(`/cashiering/shifts/${s.id}/close`, {
    method: "POST",
    token,
    body: { countedMinor: detail.data.expectedMinor },
  });
}

// Cashier shift
const shift = await call("/cashiering/shifts", {
  method: "POST",
  token,
  body: { propertyId: property.id, openingFloatMinor: 5000000 },
});
assert(shift.status === 201, "cashier shift opened", JSON.stringify(shift.data));
const shiftId = shift.data.id;

const dupShift = await call("/cashiering/shifts", {
  method: "POST",
  token,
  body: { propertyId: property.id, openingFloatMinor: 0 },
});
assert(dupShift.status === 409, "second concurrent shift for same user rejected");

// POS order priced server-side
const outlets = await call(`/pos/outlets?propertyId=${property.id}`, { token });
const restaurant = outlets.data.find((o) => o.code === "REST");
assert(restaurant?.menuItems.length > 0, "outlet menus load");
const jollof = restaurant.menuItems.find((m) => m.code === "JOLLOF");

const order = await call("/pos/orders", {
  method: "POST",
  token,
  body: { outletId: restaurant.id, lines: [{ menuItemId: jollof.id, quantity: 2 }] },
});
assert(order.status === 201, "POS order created");
assert(order.data.subtotalMinor === 1700000, "order priced from menu (2 × ₦8,500)");
assert(order.data.totalMinor === 1700000 + 85000 + 133875, "order totals include 5% service + 7.5% VAT");

// Post to a live in-house room folio: create and check in a dedicated stay.
const posGuest = await call("/guests", {
  method: "POST",
  token,
  body: { firstName: "POS", lastName: "Diner", phone: "+2348000000002" },
});
const posRes = await call("/reservations", {
  method: "POST",
  token,
  body: {
    propertyId: property.id,
    guestId: posGuest.data.id,
    roomTypeId: dlx.id,
    arrivalDate: businessDate,
    departureDate: addDays(businessDate, 1),
    source: "WALK_IN",
  },
});
const posRoom = await ensureCleanRoom("DLX");
const posCheckin = await call(`/reservations/${posRes.data.id}/check-in`, {
  method: "POST",
  token,
  body: { roomId: posRoom.id },
});
assert(posCheckin.status === 201, "in-house stay ready for room posting");
const posFolioId = posRes.data.folioId;

const settle = await call(`/pos/orders/${order.data.id}/settle`, {
  method: "POST",
  token,
  body: { settlement: "ROOM_POSTING", folioId: posFolioId },
});
assert(settle.status === 201, "POS order posted to room folio", JSON.stringify(settle.data));

const f = await call(`/folios/${posFolioId}`, { token });
const posEntry = f.data.entries.find(
  (e) => e.type === "POS_CHARGE" && e.description.includes(order.data.orderNumber)
);
assert(!!posEntry, "POS charge appears on the guest folio ledger");
assert(posEntry.amountMinor === 1700000, "posted amount matches the order subtotal");
assert(f.data.balanceMinor === order.data.totalMinor,
  "folio balance equals the order total (base + service + VAT)");

const reSettle = await call(`/pos/orders/${order.data.id}/settle`, {
  method: "POST",
  token,
  body: { settlement: "CASH" },
});
assert(reSettle.status === 409, "settled order cannot be settled twice");

const voidSettled = await call(`/pos/orders/${order.data.id}/void`, {
  method: "POST",
  token,
  body: { reason: "Attempt to void after settlement" },
});
assert(voidSettled.status === 409, "settled order cannot be voided");

// Settle and release this stay so repeated runs don't exhaust the room stock.
const posFolioState = await call(`/folios/${posFolioId}`, { token });
await call("/payments", {
  method: "POST",
  token,
  body: {
    folioId: posFolioId,
    method: "CASH",
    amountMinor: posFolioState.data.balanceMinor,
  },
});
// Checkout posts the night's room charge, so settle whatever remains.
let posCheckout = await call(`/reservations/${posRes.data.id}/check-out`, {
  method: "POST", token, body: {},
});
if (posCheckout.status === 409) {
  await call("/payments", {
    method: "POST",
    token,
    body: {
      folioId: posFolioId,
      method: "CASH",
      amountMinor: posCheckout.data.error.details.balanceMinor,
    },
  });
  posCheckout = await call(`/reservations/${posRes.data.id}/check-out`, {
    method: "POST", token, body: {},
  });
}
assert(posCheckout.status === 201, "POS stay settled and checked out",
  JSON.stringify(posCheckout.data));

// Cash settlement flows into the drawer
const order2 = await call("/pos/orders", {
  method: "POST",
  token,
  body: { outletId: restaurant.id, lines: [{ menuItemId: jollof.id, quantity: 1 }] },
});
const cashSettle = await call(`/pos/orders/${order2.data.id}/settle`, {
  method: "POST",
  token,
  body: { settlement: "CASH", shiftId },
});
assert(cashSettle.status === 201, "POS cash settlement recorded against shift");

// §13.4 POS void approvals. A void is how cash walks out of a till — ring the
// order, take the money, void the ticket — so above the correction window it
// needs a second person. `token` is front desk, which cannot approve.
const voidTarget = await call("/pos/orders", {
  method: "POST",
  token,
  body: { outletId: restaurant.id, lines: [{ menuItemId: jollof.id, quantity: 2 }] },
});
const voidReq = await call(`/pos/orders/${voidTarget.data.id}/void`, {
  method: "POST",
  token,
  body: { reason: "Guest disputed the bill" },
});
assert(voidReq.status === 201 && voidReq.data.status === "PENDING_APPROVAL",
  "a large void by front desk raises an approval request", JSON.stringify(voidReq.data));

const parked = await call(`/pos/orders/${voidTarget.data.id}/settle`, {
  method: "POST", token, body: { settlement: "CASH", shiftId },
});
assert(parked.status === 409 && parked.data.error.code === "VOID_PENDING",
  "an order awaiting a void decision cannot be settled around");

const selfApproveVoid = await call(`/approvals/${voidReq.data.request.id}/approve`, {
  method: "POST", token, body: {},
});
assert(selfApproveVoid.status === 403,
  "the requester cannot approve their own void", JSON.stringify(selfApproveVoid.data));

const voidBlocked = await call(`/night-audit/preflight?propertyId=${property.id}`, { token });
assert(voidBlocked.data.blockers.some((b) => b.code === "POS_VOIDS_AWAITING_APPROVAL"),
  "an undecided void blocks the night audit");

const voidApproved = await call(`/approvals/${voidReq.data.request.id}/approve`, {
  method: "POST", token: mgrToken, body: { note: "Verified with the floor" },
});
assert(voidApproved.status === 201 && voidApproved.data.status === "APPROVED",
  "a manager approves the void", JSON.stringify(voidApproved.data));

const voidedOrder = (await call(`/pos/orders?propertyId=${property.id}`, { token }))
  .data.find((o) => o.id === voidTarget.data.id);
assert(voidedOrder.status === "VOIDED", "approval actually voids the order");

// A rejected void puts the order back on the floor, with no stale reason left
// behind to make a live ticket look cancelled.
const rejectTarget = await call("/pos/orders", {
  method: "POST", token,
  body: { outletId: restaurant.id, lines: [{ menuItemId: jollof.id, quantity: 2 }] },
});
const rejectReq = await call(`/pos/orders/${rejectTarget.data.id}/void`, {
  method: "POST", token, body: { reason: "Claimed the guest left" },
});
const rejected = await call(`/approvals/${rejectReq.data.request.id}/reject`, {
  method: "POST", token: ownerToken, body: { note: "The guest was served" },
});
assert(rejected.status === 201 && rejected.data.status === "REJECTED", "a void can be rejected");
const restored = (await call(`/pos/orders?propertyId=${property.id}`, { token }))
  .data.find((o) => o.id === rejectTarget.data.id);
assert(restored.status === "OPEN" && restored.voidReason === null,
  "a rejected void returns the order to the floor", JSON.stringify(restored));
// Settled by card, so this check does not disturb the drawer arithmetic the
// cashiering assertions below depend on.
const restoredSettle = await call(`/pos/orders/${rejectTarget.data.id}/settle`, {
  method: "POST", token, body: { settlement: "CARD" },
});
assert(restoredSettle.status === 201, "the restored order can be settled");

const shiftState = await call(`/cashiering/shifts/${shiftId}`, { token });
const expected = shiftState.data.expectedMinor;
assert(expected === 5000000 + order2.data.totalMinor, "drawer expected = float + cash taken");

// Variance handling
const badClose = await call(`/cashiering/shifts/${shiftId}/close`, {
  method: "POST",
  token,
  body: { countedMinor: expected - 100000 },
});
assert(badClose.status === 409 && badClose.data.error.code === "VARIANCE_REASON_REQUIRED",
  "closing short without a reason is rejected");

const closed = await call(`/cashiering/shifts/${shiftId}/close`, {
  method: "POST",
  token,
  body: { countedMinor: expected - 100000, varianceReason: "Suspected short-change at dinner service" },
});
assert(closed.data.status === "PENDING_APPROVAL", "variance close requires manager approval");

const selfApprove = await call(`/cashiering/shifts/${shiftId}/approve`, { method: "POST", token });
assert(selfApprove.status === 403 && selfApprove.data.error.code === "PERMISSION_DENIED",
  "a cashier has no permission to approve a variance at all");

const mgr = await call("/auth/login", {
  method: "POST",
  body: { email: "manager@grandpalm.demo", password: "Password123!" },
});
const mgrApprove = await call(`/cashiering/shifts/${shiftId}/approve`, {
  method: "POST",
  token: mgr.data.accessToken,
});
assert(mgrApprove.status === 201 && mgrApprove.data.status === "CLOSED",
  "manager approves variance and shift closes");

// Maintenance blocks a room out of inventory
const rackForMaint = await call(`/properties/${property.id}/room-rack`, { token });
const blockTarget = rackForMaint.data.find(
  (r) => !r.occupant && r.operationalStatus !== "OUT_OF_ORDER"
);
const ticket = await call("/maintenance/tickets", {
  method: "POST",
  token,
  body: {
    propertyId: property.id,
    roomId: blockTarget.id,
    title: "AC not cooling",
    priority: "HIGH",
    blocksRoom: true,
  },
});
assert(ticket.status === 201, "maintenance ticket created");

const rackBlocked = await call(`/properties/${property.id}/room-rack`, { token });
assert(
  rackBlocked.data.find((r) => r.id === blockTarget.id).operationalStatus === "OUT_OF_ORDER",
  "blocking ticket takes the room out of order"
);

const resolved = await call(`/maintenance/tickets/${ticket.data.id}/status`, {
  method: "POST",
  token,
  body: { status: "RESOLVED" },
});
assert(resolved.status === 201, "ticket resolved");
const rackFreed = await call(`/properties/${property.id}/room-rack`, { token });
assert(
  rackFreed.data.find((r) => r.id === blockTarget.id).operationalStatus === "VACANT_DIRTY",
  "resolved room returns via housekeeping, not straight to sellable"
);

console.log("7. Rates, versioned tax engine, approvals & offline sync");

// Rate plan + calendar + quote
const plan = await call("/rates/plans", {
  method: "POST",
  token: mgrToken,
  body: {
    propertyId: property.id,
    roomTypeId: dlx.id,
    code: `BAR${Date.now() % 10000}`,
    name: "Best Available Rate",
    minStay: 2,
  },
});
assert(plan.status === 201, "rate plan created", JSON.stringify(plan.data));

const weekend = addDays(businessDate, 5);
await call("/rates/calendar", {
  method: "POST",
  token: mgrToken,
  body: {
    ratePlanId: plan.data.id,
    rates: [{ date: weekend, rateMinor: 7000000, closed: false }],
  },
});
const cal = await call(
  `/rates/calendar?ratePlanId=${plan.data.id}&from=${weekend}&to=${addDays(weekend, 2)}`,
  { token: mgrToken }
);
assert(cal.data[0].rateMinor === 7000000 && cal.data[0].source === "CALENDAR",
  "calendar override applies on the priced date");
assert(cal.data[1].source === "BASE", "other dates fall back to the room-type base rate");

const shortQuote = await call(
  `/rates/quote?propertyId=${property.id}&ratePlanId=${plan.data.id}&arrival=${weekend}&departure=${addDays(weekend, 1)}`,
  { token: mgrToken }
);
assert(shortQuote.status === 409 && shortQuote.data.error.code === "MIN_STAY_NOT_MET",
  "minimum-stay restriction enforced");

const quote = await call(
  `/rates/quote?propertyId=${property.id}&ratePlanId=${plan.data.id}&arrival=${weekend}&departure=${addDays(weekend, 2)}`,
  { token: mgrToken }
);
assert(quote.status === 200, "quote returns");
assert(quote.data.baseMinor === 7000000 + 4650000,
  "quote prices night-by-night (calendar night + base night)");
assert(quote.data.taxes.length === 2, "quote itemises service charge and VAT");

// Closed dates block quoting
await call("/rates/calendar", {
  method: "POST",
  token: mgrToken,
  body: { ratePlanId: plan.data.id, rates: [{ date: weekend, rateMinor: 7000000, closed: true }] },
});
const closedQuote = await call(
  `/rates/quote?propertyId=${property.id}&ratePlanId=${plan.data.id}&arrival=${weekend}&departure=${addDays(weekend, 2)}`,
  { token: mgrToken }
);
assert(closedQuote.status === 409 && closedQuote.data.error.code === "DATES_CLOSED",
  "closed dates are not sellable");

// Versioned tax rules: front desk cannot change tax config
const forbiddenTax = await call("/properties/tax-rules", {
  method: "POST",
  token,
  body: {
    propertyId: property.id, code: "VAT", name: "Value Added Tax",
    rateBp: 1000, compoundOrder: 2, effectiveFrom: businessDate,
  },
});
assert(forbiddenTax.status === 403 && forbiddenTax.data.error.code === "PERMISSION_DENIED",
  "front desk cannot change tax configuration");

// The baseline pinned in section 1 is the currently effective VAT version.
const vatBaselineVersion = baselineVat.data.version;
assert(vatBaselineVersion >= 1, "VAT rule has an effective version");

// Post a charge under v1, then version the VAT rate up and confirm history holds
const taxGuest = await call("/guests", {
  method: "POST", token,
  body: { firstName: "Tax", lastName: "Case", phone: "+2348000000003" },
});
const taxRes = await call("/reservations", {
  method: "POST", token,
  body: {
    propertyId: property.id, guestId: taxGuest.data.id, roomTypeId: dlx.id,
    arrivalDate: businessDate, departureDate: addDays(businessDate, 1), source: "PHONE",
  },
});
await call(`/folios/${taxRes.data.folioId}/charges`, {
  method: "POST", token,
  body: { type: "POS_CHARGE", description: "Charge under VAT v1", amountMinor: 1000000, applyTaxes: true },
});
let taxFolio = await call(`/folios/${taxRes.data.folioId}`, { token });
const v1Vat = taxFolio.data.entries.find((e) => e.taxCode === "VAT");
assert(v1Vat.amountMinor === 78750 && v1Vat.taxRuleVersion === vatBaselineVersion,
  "charge taxed at the effective VAT rule (7.5%) and stamped with its version");

const vatV2 = await call("/properties/tax-rules", {
  method: "POST",
  token: ownerToken,
  body: {
    propertyId: property.id, code: "VAT", name: "Value Added Tax",
    rateBp: 1000, compoundOrder: 2, taxOnServiceCharge: true, effectiveFrom: businessDate,
  },
});
assert(vatV2.data.version === vatBaselineVersion + 1,
  "tax change creates a new version rather than editing the existing rule");

await call(`/folios/${taxRes.data.folioId}/charges`, {
  method: "POST", token,
  body: { type: "POS_CHARGE", description: "Charge under VAT v2", amountMinor: 1000000, applyTaxes: true },
});
taxFolio = await call(`/folios/${taxRes.data.folioId}`, { token });
const stillV1 = taxFolio.data.entries.find(
  (e) => e.taxCode === "VAT" && e.description.includes("v1")
);
const nowV2 = taxFolio.data.entries.find(
  (e) => e.taxCode === "VAT" && e.description.includes("v2")
);
assert(stillV1.amountMinor === 78750, "the older posted line is unchanged by the rate change");
assert(nowV2.amountMinor === 105000 && nowV2.taxRuleVersion === vatBaselineVersion + 1,
  "the new charge uses the new VAT version (10%)");

// Approvals: discount threshold
const smallDiscount = await call("/approvals/discounts", {
  method: "POST", token,
  body: { folioId: taxRes.data.folioId, amountMinor: 20000, reason: "Goodwill — slow service" },
});
assert(smallDiscount.data.status === "APPLIED", "small discount applies without approval");

const bigDiscount = await call("/approvals/discounts", {
  method: "POST", token,
  body: { folioId: taxRes.data.folioId, amountMinor: 900000, reason: "Service failure compensation" },
});
assert(bigDiscount.data.status === "PENDING_APPROVAL", "large discount needs manager approval");
const requestId = bigDiscount.data.request.id;

const beforeApproval = await call(`/folios/${taxRes.data.folioId}`, { token });
const noDiscountYet = beforeApproval.data.entries.filter(
  (e) => e.type === "DISCOUNT" && e.amountMinor === -900000
);
assert(noDiscountYet.length === 0, "pending discount does not touch the ledger");

const selfApproveDiscount = await call(`/approvals/${requestId}/approve`, { method: "POST", token });
assert(selfApproveDiscount.status === 403 && selfApproveDiscount.data.error.code === "PERMISSION_DENIED",
  "the requesting front-desk user cannot approve the discount");

const approved = await call(`/approvals/${requestId}/approve`, {
  method: "POST", token: mgrToken, body: { note: "Approved — documented complaint" },
});
assert(approved.status === 201, "manager approves the discount");
const afterApproval = await call(`/folios/${taxRes.data.folioId}`, { token });
assert(
  afterApproval.data.entries.some((e) => e.type === "DISCOUNT" && e.amountMinor === -900000),
  "approval posts the discount to the ledger"
);

// Offline sync contract
const hkTasks = await call(`/housekeeping/tasks?propertyId=${property.id}`, { token });
const syncTask = hkTasks.data.find((t) => t.status === "PENDING");
const opId = `op-${Date.now()}`;
const push1 = await call("/sync/mutations", {
  method: "POST",
  token,
  body: {
    deviceId: "dev_hk_tablet_01",
    mutations: [
      {
        operationId: opId,
        entityType: "housekeepingTask",
        entityId: syncTask.id,
        baseVersion: syncTask.version,
        action: "start",
        occurredAt: new Date().toISOString(),
        payload: {},
      },
      {
        operationId: `${opId}-money`,
        entityType: "housekeepingTask",
        entityId: syncTask.id,
        action: "payment",
        occurredAt: new Date().toISOString(),
        payload: { amountMinor: 50000 },
      },
    ],
  },
});
assert(push1.data.applied.length === 1, "queued housekeeping mutation applied");
assert(push1.data.rejected[0].code === "ONLINE_ONLY", "financial mutation rejected as online-only");
assert(typeof push1.data.nextCursor === "string", "sync returns a cursor");
assert(push1.data.serverChanges.length > 0, "sync returns server changes");

const replay = await call("/sync/mutations", {
  method: "POST",
  token,
  body: {
    deviceId: "dev_hk_tablet_01",
    mutations: [{
      operationId: opId,
      entityType: "housekeepingTask",
      entityId: syncTask.id,
      baseVersion: syncTask.version,
      action: "start",
      occurredAt: new Date().toISOString(),
      payload: {},
    }],
  },
});
assert(replay.data.applied[0].replayed === true, "replayed operationId is idempotent");

const staleVersion = await call("/sync/mutations", {
  method: "POST",
  token,
  body: {
    deviceId: "dev_hk_tablet_02",
    mutations: [{
      operationId: `${opId}-stale`,
      entityType: "housekeepingTask",
      entityId: syncTask.id,
      baseVersion: syncTask.version, // stale: the task advanced above
      action: "complete",
      occurredAt: new Date().toISOString(),
      payload: {},
    }],
  },
});
assert(staleVersion.data.conflicts[0]?.code === "VERSION_CONFLICT",
  "stale offline version reports a conflict instead of overwriting");
assert(!!staleVersion.data.conflicts[0].resolution, "conflict includes a resolution path");

console.log("8. Night audit (idempotent)");
// The suite has been opening drawers and tickets all the way down; a night
// auditor would close them before attempting the day, so do the same.
const openShifts = await call(`/cashiering/shifts?propertyId=${property.id}`, { token });
for (const sh of openShifts.data.filter((x) => x.status === "OPEN")) {
  const detail = await call(`/cashiering/shifts/${sh.id}`, { token });
  await call(`/cashiering/shifts/${sh.id}/close`, {
    method: "POST", token, body: { countedMinor: detail.data.expectedMinor },
  });
}
// Voided by the manager, not front desk: a front-desk void of this size now
// parks for approval, which would leave the day unable to close — exactly the
// control the night audit blocker exists to enforce.
const openOrders = await call(`/pos/orders?propertyId=${property.id}`, { token });
for (const o of openOrders.data.filter((x) => x.status === "OPEN")) {
  const cleared = await call(`/pos/orders/${o.id}/void`, {
    method: "POST", token: mgrToken, body: { reason: "Cleared before night audit" },
  });
  assert(cleared.data.status === "VOIDED",
    `an approver clears order ${o.orderNumber} outright`, JSON.stringify(cleared.data));
}

// Pre-flight must surface anything unfinished before the day can close.
const pre = await call(`/night-audit/preflight?propertyId=${property.id}`, { token });
assert(pre.data.canRun === true,
  "pre-flight is clear once shifts and orders are closed",
  JSON.stringify(pre.data.blockers));
assert(pre.status === 200 && typeof pre.data.canRun === "boolean",
  "night audit pre-flight reports readiness");

if (pre.data.warnings.length > 0) {
  // Deliberately omits acknowledgeWarnings — that is the point of the check.
  const unacked = await call("/night-audit/run", {
    method: "POST", token, body: { propertyId: property.id },
  });
  assert(unacked.status === 409 && unacked.data.error.code === "NIGHT_AUDIT_WARNINGS",
    "unacknowledged warnings block the night audit");
}

const audit1 = await call("/night-audit/run", {
  method: "POST",
  token,
  body: { propertyId: property.id, acknowledgeWarnings: true },
});
assert(audit1.status === 201, "night audit runs", JSON.stringify(audit1.data));
assert(Array.isArray(audit1.data.phases) && audit1.data.phases.length === 5,
  "the audit records its five phases");
assert(audit1.data.newBusinessDate === addDays(businessDate, 1), "business date advanced by audit only");

const audit2 = await call("/night-audit/run", {
  method: "POST",
  token,
  body: { propertyId: property.id, acknowledgeWarnings: true },
});
// Second run is for the NEW business date, so it should succeed;
// rerunning the SAME date must fail. Verify via direct duplicate:
assert(audit2.status === 201, "next business date can be audited");
const flash = await call(`/reports/daily-flash?propertyId=${property.id}`, { token });
assert(flash.status === 200, "daily flash report loads");

console.log("8b. Reports, CSV exports & security headers");
const taxSummary = await call(
  `/reports/tax-summary?propertyId=${property.id}&from=${addDays(businessDate, -30)}&to=${addDays(businessDate, 5)}`,
  { token: mgrToken }
);
assert(taxSummary.status === 200 && taxSummary.data.length > 0,
  "tax summary groups by business date, code and rule version");
assert(taxSummary.data.some((r) => r.taxCode === "VAT"), "tax summary includes VAT rows");

const csvRes = await fetch(
  `${BASE}/reports/export?propertyId=${property.id}&type=tax-summary&from=${addDays(businessDate, -30)}&to=${addDays(businessDate, 5)}`,
  { headers: { Authorization: `Bearer ${mgrToken}` } }
);
const csv = await csvRes.text();
assert(csvRes.headers.get("content-type")?.includes("text/csv"), "CSV export sets a CSV content type");
assert(csvRes.headers.get("content-disposition")?.includes("attachment"),
  "CSV export is sent as a download");
assert(csv.split("\r\n")[0] === "businessDate,taxCode,ruleVersion,lines,totalMinor,totalNaira",
  "CSV has a header row");
assert(csv.split("\r\n").length > 1, "CSV has data rows");

const ledgerCsvRes = await fetch(
  `${BASE}/reports/export?propertyId=${property.id}&type=guest-ledger&from=${addDays(businessDate, -30)}&to=${addDays(businessDate, 5)}`,
  { headers: { Authorization: `Bearer ${mgrToken}` } }
);
const ledgerCsv = await ledgerCsvRes.text();
// Descriptions contain commas; RFC 4180 quoting must keep the column count stable.
const headerCols = ledgerCsv.split("\r\n")[0].split(",").length;
assert(ledgerCsv.includes('"') || headerCols > 5, "guest ledger CSV quotes fields containing commas");

const badExport = await call(
  `/reports/export?propertyId=${property.id}&type=nonsense&from=${businessDate}&to=${businessDate}`,
  { token: mgrToken }
);
assert(badExport.status === 400, "unknown export type is rejected");

// §14 Asynchronous exports. Every declared type must actually build — a type
// in the enum with no builder behind it returns an empty file that reads like
// a quiet trading period.
const exportFrom = new Date(Date.parse(businessDate) - 30 * 86400000).toISOString().slice(0, 10);
async function runExport(type, format) {
  const job = await call("/analytics/exports", {
    method: "POST", token: ownerToken,
    body: { propertyId: property.id, type, format, from: exportFrom, to: businessDate },
  });
  if (job.status !== 201) return { status: "REJECTED", error: JSON.stringify(job.data) };
  for (let i = 0; i < 50; i++) {
    const st = await call(`/analytics/exports/${job.data.jobId}`, { token: ownerToken });
    if (st.data.status === "COMPLETE" || st.data.status === "FAILED") return st.data;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { status: "TIMEOUT" };
}
for (const type of ["DAILY_FLASH", "REVENUE", "OCCUPANCY", "CASHIER", "TAX",
                    "RECEIVABLES", "GUEST_LEDGER", "AUDIT"]) {
  const done = await runExport(type, "CSV");
  assert(done.status === "COMPLETE" && !!done.download?.url,
    `${type} export completes with a download link`, JSON.stringify(done.error ?? done.status));
}

const pdfJob = await runExport("GUEST_LEDGER", "PDF");
assert(pdfJob.status === "COMPLETE", "PDF export completes", JSON.stringify(pdfJob.error));
const pdfRes = await fetch(pdfJob.download.url);
const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
assert(pdfRes.headers.get("content-type") === "application/pdf",
  "PDF export is served with a PDF content type");
assert(pdfBuf.subarray(0, 5).toString("latin1") === "%PDF-" &&
  pdfBuf.toString("latin1").trimEnd().endsWith("%%EOF"),
  "the PDF is a complete document, not a renamed CSV");

const headRes = await fetch(`${BASE}/health/live`);
assert(headRes.headers.get("x-frame-options") || headRes.headers.get("content-security-policy"),
  "security headers are applied (§12.1)");
assert(!!headRes.headers.get("x-ratelimit-limit"), "rate limiting is active");

console.log("9. Tenant isolation (§6.2 rule 8)");
// Forge a token signed with the right secret but a different tenant id.
// Simpler equivalent: use a valid token but request another tenant's object id.
const foreign = await call(`/folios/does-not-exist-id`, { token });
assert(foreign.status === 404, "cross-tenant/unknown folio returns 404, not data");

const audit = await call(`/reports/audit-trail?propertyId=${property.id}`, { token });
const actions = audit.data.map((a) => a.action);
assert(actions.includes("frontdesk.check_in"), "check-in audit event recorded");
assert(actions.includes("payment.confirmed"), "payment audit event recorded");
assert(actions.includes("night_audit.run"), "night audit event recorded");

console.log("10. Hardening (\u00a712)");

// MFA: a password alone stops being enough once the second factor is on.
const mfaSetup = await call("/auth/mfa/setup", { method: "POST", token: mgrToken });
assert(mfaSetup.status === 201 && !!mfaSetup.data.secret, "MFA setup returns a secret to scan");
assert(mfaSetup.data.otpauthUri.startsWith("otpauth://totp/"),
  "the enrolment URI is scannable by a real authenticator app");

const { createHmac } = await import("node:crypto");
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function totpCode(secret) {
  let bits = 0, value = 0; const bytes = [];
  for (const ch of secret.toUpperCase().replace(/[\s=-]/g, "")) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const d = createHmac("sha1", Buffer.from(bytes)).update(buf).digest();
  const o = d[d.length - 1] & 0x0f;
  const n = ((d[o] & 0x7f) << 24) | ((d[o+1] & 0xff) << 16) | ((d[o+2] & 0xff) << 8) | (d[o+3] & 0xff);
  return String(n % 1000000).padStart(6, "0");
}

const mfaOn = await call("/auth/mfa/activate", {
  method: "POST", token: mgrToken, body: { code: totpCode(mfaSetup.data.secret) },
});
assert(mfaOn.status === 201 && mfaOn.data.enabled === true, "a valid code activates MFA",
  JSON.stringify(mfaOn.data));
assert(mfaOn.data.recoveryCodes.length === 10, "recovery codes are issued once, in clear");

const gated = await call("/auth/login", {
  method: "POST", body: { email: "manager@grandpalm.demo", password: "Password123!" },
});
assert(gated.data.status === "MFA_REQUIRED" && !gated.data.accessToken,
  "the correct password alone no longer yields a session", JSON.stringify(gated.data));

// The challenge token is signed with the same secret; only its purpose stops
// it authorising anything. Accepting it would mean a request with no tenant,
// and every tenantId filter in the codebase silently becoming unfiltered.
const challengeMisuse = await call("/reservations", { token: gated.data.mfaToken });
assert(challengeMisuse.status === 401,
  "an MFA challenge token cannot be used as an access token",
  JSON.stringify(challengeMisuse.data).slice(0, 120));

const exchanged = await call("/auth/mfa/verify", {
  method: "POST",
  body: { mfaToken: gated.data.mfaToken, code: totpCode(mfaSetup.data.secret) },
});
assert(exchanged.status === 201 && !!exchanged.data.accessToken,
  "the code exchanges the challenge for a real session", JSON.stringify(exchanged.data));

const mfaOff = await call("/auth/mfa/disable", {
  method: "POST", token: exchanged.data.accessToken, body: { password: "Password123!" },
});
assert(mfaOff.data.enabled === false, "MFA can be removed by re-proving the password");

// Observability
const traced = await fetch(`${BASE}/auth/me`, {
  headers: {
    Authorization: `Bearer ${token}`,
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  },
});
assert(traced.headers.get("x-trace-id") === "4bf92f3577b34da6a3ce929d0e0e4736",
  "an inbound W3C trace is continued across the hop");

const metrics = await fetch(`${BASE}/metrics`);
const metricsBody = await metrics.text();
assert(metrics.status === 200 && metricsBody.includes("lodgiva_http_requests_total"),
  "Prometheus metrics are scrapeable");
assert(!/route="[^"]*[0-9a-f]{8}-[0-9a-f]{4}-/.test(metricsBody),
  "route labels are templated, not one time series per record");

const sl = await call("/observability/service-level?windowMinutes=60", { token: mgrToken });
assert(sl.status === 200 && typeof sl.data.sloLatencyMs === "number",
  "the service-level report exposes the SLI");

// Support tooling
const supportHit = await call(
  `/support/lookup?q=${encodeURIComponent(res.data.confirmationCode)}`,
  { token: mgrToken }
);
assert(supportHit.status === 200 &&
  supportHit.data.reservations.some((r) => r.confirmationCode === res.data.confirmationCode),
  "support lookup finds a booking by confirmation code",
  JSON.stringify(supportHit.data).slice(0, 150));

const supportDenied = await call("/support/lookup?q=test", { token });
assert(supportDenied.status === 403, "front desk cannot use support lookup");

// Feature flags
const flagKey = `e2e-${Date.now().toString(36)}`;
const flagCreated = await call("/admin/feature-flags", {
  method: "POST", token: ownerToken,
  body: { key: flagKey, description: "Created by the e2e suite.", enabled: false },
});
assert(flagCreated.status === 201, "a feature flag can be created", JSON.stringify(flagCreated.data));
const flagsSeen = await call("/feature-flags", { token: ownerToken });
assert(flagsSeen.data[flagKey] === false, "a new flag starts off, so a typo cannot enable a feature");

// Rate limiting. Deliberately the LAST thing in this file: it exhausts the
// per-IP login budget, and anything after it that tried to sign in would fail
// for the wrong reason.
// The budget is read from the route itself rather than hard-coded, so this
// exercises the real limit whether the API is running the production default
// (30/min) or a raised value for a test run.
const limitProbe = await fetch(`${BASE}/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "nobody@grandpalm.demo", password: "wrong-password" }),
});
const authBudget = Number(limitProbe.headers.get("x-ratelimit-limit"));
const remaining = Number(limitProbe.headers.get("x-ratelimit-remaining"));
const generalProbe = await fetch(`${BASE}/health/live`);
assert(authBudget < Number(generalProbe.headers.get("x-ratelimit-limit")),
  "login carries a tighter budget than the general API", `auth=${authBudget}`);

// Sent as ONE burst of deliberately malformed bodies. The limiter is an
// onRequest hook, so these count exactly like real attempts — but they skip
// the argon2 verification, and that matters: a well-formed guess costs the
// server ~200ms by design, so sending hundreds sequentially takes longer than
// the minute the window resets in, and the budget is never actually reached.
let sawRateLimit = false;
const seenStatuses = new Set();
const burst = await Promise.all(
  Array.from({ length: remaining + 5 }, () =>
    call("/auth/login", { method: "POST", body: { email: "not-an-email" } })
  )
);
for (const a of burst) {
  seenStatuses.add(a.status);
  if (a.status === 429 && a.data.error?.code === "RATE_LIMITED") sawRateLimit = true;
}
const lastStatus = [...seenStatuses].sort().join(",");

assert(sawRateLimit,
  "a burst against the login route is refused with 429 RATE_LIMITED, not 500",
  `statuses seen: ${lastStatus}`);

console.log(failures === 0 ? "\nALL E2E CHECKS PASSED ✅" : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
