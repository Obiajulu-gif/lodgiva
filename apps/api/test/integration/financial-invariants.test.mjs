/**
 * Financial invariants (§7.3, §13.3).
 *
 * These are the properties that must hold for the ledger to be trustworthy.
 * Each is asserted against real postings through the API rather than against
 * a model of it, because the invariant is only worth anything if the actual
 * write paths preserve it.
 *
 * Run: node --test test/integration/financial-invariants.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.API_BASE ?? "http://localhost:4000/api/v1";

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

const uniq = () => Math.random().toString(36).slice(2, 7);
const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

let token;
let financeToken;
let property;
let businessDate;
let typeId;

/** Sum of every entry on a folio — the definition of its balance. */
const sumEntries = (entries) => entries.reduce((s, e) => s + e.amountMinor, 0);

async function freshStay(nights = 1, offset = 400) {
  const guest = await call("/guests", {
    method: "POST",
    token,
    body: { firstName: "Fin", lastName: `Inv${uniq()}` },
  });
  const arrival = addDays(businessDate, offset + Math.floor(Math.random() * 200));
  const res = await call("/reservations", {
    method: "POST",
    token,
    body: {
      propertyId: property.id,
      guestId: guest.data.id,
      roomTypeId: typeId,
      arrivalDate: arrival,
      departureDate: addDays(arrival, nights),
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return { reservationId: res.data.id, folioId: res.data.folioId, arrival };
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

  const code = `FI${uniq()}`.toUpperCase();
  const rt = await call("/config/room-types", {
    method: "POST",
    token: financeToken,
    body: {
      propertyId: property.id,
      code,
      name: `Invariant ${code}`,
      baseOccupancy: 2,
      maxOccupancy: 2,
      baseRateMinor: 5000000,
    },
  });
  assert.equal(rt.status, 201);
  typeId = rt.data.id;
  for (let i = 0; i < 8; i++) {
    await call("/config/rooms", {
      method: "POST",
      token: financeToken,
      body: {
        propertyId: property.id,
        roomTypeId: typeId,
        roomNumber: `${code}${i}`,
        floor: 1,
      },
    });
  }
});

// ── Invariant 1: balance is exactly the sum of entries ───────────────────

test("INVARIANT balance always equals the sum of its entries", async () => {
  const { folioId } = await freshStay();
  await call(`/folios/${folioId}/charges`, {
    method: "POST",
    token,
    body: { type: "POS_CHARGE", description: "Dinner", amountMinor: 1234567, applyTaxes: true },
  });
  await call("/payments", {
    method: "POST",
    token,
    body: { folioId, method: "CASH", amountMinor: 500000 },
  });
  await call(`/folios/${folioId}/charges`, {
    method: "POST",
    token,
    body: { type: "MINIBAR", description: "Minibar", amountMinor: 89900, applyTaxes: true },
  });

  const f = await call(`/folios/${folioId}`, { token });
  assert.equal(
    f.data.balanceMinor,
    sumEntries(f.data.entries),
    "reported balance diverged from the ledger"
  );
});

// ── Invariant 2: entries are immutable; corrections are reversals ────────

test("INVARIANT a reversal is the exact negation and the original survives", async () => {
  const { folioId } = await freshStay();
  const charge = await call(`/folios/${folioId}/charges`, {
    method: "POST",
    token,
    body: { type: "POS_CHARGE", description: "Wrong charge", amountMinor: 777700, applyTaxes: false },
  });
  const before = await call(`/folios/${folioId}`, { token });

  const rev = await call(`/folios/${folioId}/entries/${charge.data.id}/reverse`, {
    method: "POST",
    token,
    body: { reason: "Posted to the wrong room" },
  });
  assert.equal(rev.status, 201);
  assert.equal(rev.data.amountMinor, -charge.data.amountMinor, "reversal must negate exactly");

  const after = await call(`/folios/${folioId}`, { token });
  const original = after.data.entries.find((e) => e.id === charge.data.id);
  assert.ok(original, "the original entry must remain visible after reversal");
  assert.equal(original.amountMinor, charge.data.amountMinor, "the original must be unchanged");
  assert.equal(
    after.data.entries.length,
    before.data.entries.length + 1,
    "reversal appends; it never replaces"
  );
  // Net effect of charge + reversal is zero.
  const net = after.data.entries
    .filter((e) => e.id === charge.data.id || e.reversalOfId === charge.data.id)
    .reduce((s, e) => s + e.amountMinor, 0);
  assert.equal(net, 0, "a charge and its reversal must net to zero");
});

test("INVARIANT an entry cannot be reversed twice", async () => {
  const { folioId } = await freshStay();
  const charge = await call(`/folios/${folioId}/charges`, {
    method: "POST",
    token,
    body: { type: "POS_CHARGE", description: "Once only", amountMinor: 100000, applyTaxes: false },
  });
  const first = await call(`/folios/${folioId}/entries/${charge.data.id}/reverse`, {
    method: "POST", token, body: { reason: "First reversal" },
  });
  assert.equal(first.status, 201);
  const second = await call(`/folios/${folioId}/entries/${charge.data.id}/reverse`, {
    method: "POST", token, body: { reason: "Second attempt" },
  });
  assert.equal(second.status, 400);
  assert.equal(second.data.error.code, "ALREADY_REVERSED");
});

// ── Invariant 3: tax is posted as its own line, never folded in ──────────

test("INVARIANT tax and service post as separate lines that reconcile", async () => {
  const { folioId } = await freshStay();
  const base = 1000000;
  await call(`/folios/${folioId}/charges`, {
    method: "POST",
    token,
    body: { type: "POS_CHARGE", description: "Taxable item", amountMinor: base, applyTaxes: true },
  });

  const f = await call(`/folios/${folioId}`, { token });
  const mine = f.data.entries.filter((e) => e.description.includes("Taxable item"));
  const charge = mine.find((e) => e.type === "POS_CHARGE");
  const svc = mine.find((e) => e.type === "SERVICE_CHARGE");
  const vat = mine.find((e) => e.type === "TAX");

  assert.equal(charge.amountMinor, base, "the charge line holds the pre-tax amount only");
  assert.ok(svc && vat, "service charge and tax must each be their own line");

  // Tax rules are versioned, so the expected amounts are derived from whatever
  // version is currently in force rather than hardcoded.
  const rules = await call(`/properties/tax-rules?propertyId=${property.id}`, {
    token: financeToken,
  });
  // Mirrors the engine's selection: in force on the business date, newest
  // version per code wins.
  const active = new Map();
  for (const r of rules.data) {
    if (r.effectiveFrom > businessDate) continue;
    if (r.effectiveTo !== null && r.effectiveTo < businessDate) continue;
    const seen = active.get(r.code);
    if (!seen || r.version > seen.version) active.set(r.code, r);
  }
  // With no rules configured the engine applies its documented Nigerian
  // defaults (5% service, 7.5% VAT) and stamps version 0.
  const svcRule = active.get("SVC") ?? { rateBp: 500, version: 0 };
  const vatRule = active.get("VAT") ?? { rateBp: 750, version: 0 };

  assert.equal(
    svc.amountMinor,
    Math.floor((base * svcRule.rateBp) / 10000),
    `service charge should be ${svcRule.rateBp}bp of base`
  );
  assert.equal(
    vat.amountMinor,
    Math.floor(((base + svc.amountMinor) * vatRule.rateBp) / 10000),
    "VAT must compound onto base + service per the configured order"
  );
  assert.equal(vat.taxRuleVersion, vatRule.version, "the line records the version that priced it");
  // Every tax line records which rule version produced it.
  assert.ok(vat.taxRuleVersion !== null && vat.taxRuleVersion !== undefined);
});

// ── Invariant 4: transfers are zero-sum across folios ────────────────────

test("INVARIANT transferring charges conserves total value across folios", async () => {
  const { reservationId, folioId } = await freshStay();
  await call(`/folios/${folioId}/charges`, {
    method: "POST",
    token,
    body: { type: "POS_CHARGE", description: "Company dinner", amountMinor: 640000, applyTaxes: true },
  });
  await call(`/folios/${folioId}/charges`, {
    method: "POST",
    token,
    body: { type: "MINIBAR", description: "Personal minibar", amountMinor: 150000, applyTaxes: true },
  });

  const split = await call("/folios/split", {
    method: "POST",
    token,
    body: { reservationId, label: "Company account" },
  });
  assert.equal(split.status, 201, JSON.stringify(split.data));

  const before = await call(`/folios/${folioId}`, { token });
  const combinedBefore = before.data.balanceMinor;
  const toMove = before.data.entries.filter((e) => e.description.includes("Company dinner"));
  assert.ok(toMove.length >= 1);

  const moved = await call(`/folios/${folioId}/transfer`, {
    method: "POST",
    token,
    body: {
      targetFolioId: split.data.id,
      entryIds: toMove.map((e) => e.id),
      reason: "Company settles the dinner",
    },
  });
  assert.equal(moved.status, 201, JSON.stringify(moved.data));

  const src = await call(`/folios/${folioId}`, { token });
  const tgt = await call(`/folios/${split.data.id}`, { token });
  assert.equal(
    src.data.balanceMinor + tgt.data.balanceMinor,
    combinedBefore,
    "a transfer must not create or destroy value"
  );
  assert.equal(tgt.data.balanceMinor, toMove.reduce((s, e) => s + e.amountMinor, 0));

  // Both halves are linked, and the source ledger still shows what left.
  const outLeg = src.data.entries.find((e) => e.description.startsWith("Transferred out:"));
  const inLeg = tgt.data.entries.find((e) => e.description.startsWith("Transferred in:"));
  assert.ok(outLeg && inLeg, "both legs of the transfer must be recorded");
  assert.equal(outLeg.amountMinor, -inLeg.amountMinor, "the legs must be exact opposites");
});

test("INVARIANT the same charge cannot be transferred twice", async () => {
  const { reservationId, folioId } = await freshStay();
  const charge = await call(`/folios/${folioId}/charges`, {
    method: "POST",
    token,
    body: { type: "POS_CHARGE", description: "Single move", amountMinor: 200000, applyTaxes: false },
  });
  const a = await call("/folios/split", {
    method: "POST", token, body: { reservationId, label: "A" },
  });
  const b = await call("/folios/split", {
    method: "POST", token, body: { reservationId, label: "B" },
  });

  const first = await call(`/folios/${folioId}/transfer`, {
    method: "POST",
    token,
    body: { targetFolioId: a.data.id, entryIds: [charge.data.id], reason: "First move" },
  });
  assert.equal(first.status, 201);

  const second = await call(`/folios/${folioId}/transfer`, {
    method: "POST",
    token,
    body: { targetFolioId: b.data.id, entryIds: [charge.data.id], reason: "Duplicate move" },
  });
  assert.equal(second.status, 409);
  assert.equal(second.data.error.code, "ENTRY_NOT_TRANSFERABLE");
});

test("charges cannot be transferred between different stays", async () => {
  const one = await freshStay();
  const two = await freshStay();
  const charge = await call(`/folios/${one.folioId}/charges`, {
    method: "POST",
    token,
    body: { type: "POS_CHARGE", description: "Wrong stay", amountMinor: 50000, applyTaxes: false },
  });
  const res = await call(`/folios/${one.folioId}/transfer`, {
    method: "POST",
    token,
    body: { targetFolioId: two.folioId, entryIds: [charge.data.id], reason: "Should fail" },
  });
  assert.equal(res.status, 409);
  assert.equal(res.data.error.code, "DIFFERENT_STAY");
});

// ── Invariant 5: invoices are immutable and gapless ──────────────────────

test("INVARIANT an invoice snapshot does not change when the folio does", async () => {
  const { folioId } = await freshStay();
  await call(`/folios/${folioId}/charges`, {
    method: "POST",
    token,
    body: { type: "POS_CHARGE", description: "Invoiced item", amountMinor: 300000, applyTaxes: true },
  });

  const inv = await call("/invoices", { method: "POST", token, body: { folioId } });
  assert.equal(inv.status, 201, JSON.stringify(inv.data));
  const issuedTotal = inv.data.totalMinor;
  const issuedLines = inv.data.snapshot.lines.length;

  // Post more to the folio afterwards.
  await call(`/folios/${folioId}/charges`, {
    method: "POST",
    token,
    body: { type: "MINIBAR", description: "Added later", amountMinor: 900000, applyTaxes: true },
  });

  const reread = await call(`/invoices/${inv.data.id}`, { token });
  assert.equal(reread.data.totalMinor, issuedTotal, "an issued invoice total must never move");
  assert.equal(reread.data.snapshot.lines.length, issuedLines, "the snapshot must be frozen");
  assert.ok(
    !JSON.stringify(reread.data.snapshot).includes("Added later"),
    "postings made after issue must not appear on the invoice"
  );
});

test("INVARIANT invoice numbers are gapless and sequential per property", async () => {
  const numbers = [];
  for (let i = 0; i < 4; i++) {
    const { folioId } = await freshStay();
    await call(`/folios/${folioId}/charges`, {
      method: "POST",
      token,
      body: { type: "POS_CHARGE", description: `Seq ${i}`, amountMinor: 100000, applyTaxes: false },
    });
    const inv = await call("/invoices", { method: "POST", token, body: { folioId } });
    assert.equal(inv.status, 201, JSON.stringify(inv.data));
    numbers.push(inv.data.invoiceNumber);
  }

  const seq = numbers.map((n) => Number(n.split("/").pop()));
  for (let i = 1; i < seq.length; i++) {
    assert.equal(seq[i], seq[i - 1] + 1, `gap in invoice sequence: ${numbers.join(", ")}`);
  }
  // Format is property/series/number, zero padded.
  assert.match(numbers[0], /^[A-Z0-9-]+\/\d{4}\/\d{6}$/);
});

test("INVARIANT voiding issues a credit note and keeps the original number", async () => {
  const { folioId } = await freshStay();
  await call(`/folios/${folioId}/charges`, {
    method: "POST",
    token,
    body: { type: "POS_CHARGE", description: "To be voided", amountMinor: 250000, applyTaxes: true },
  });
  const inv = await call("/invoices", { method: "POST", token, body: { folioId } });

  // Front desk may not void a tax document.
  const forbidden = await call(`/invoices/${inv.data.id}/void`, {
    method: "POST", token, body: { reason: "Trying without authority" },
  });
  assert.equal(forbidden.status, 409);
  assert.equal(forbidden.data.error.code, "FORBIDDEN_ROLE");

  const voided = await call(`/invoices/${inv.data.id}/void`, {
    method: "POST",
    token: financeToken,
    body: { reason: "Charged to the wrong company" },
  });
  assert.equal(voided.status, 201, JSON.stringify(voided.data));
  assert.equal(voided.data.voided.status, "VOID");
  assert.equal(voided.data.creditNote.type, "CREDIT_NOTE");
  assert.equal(
    voided.data.creditNote.totalMinor,
    -inv.data.totalMinor,
    "a credit note must exactly offset the invoice it cancels"
  );

  // The original document still exists under its original number.
  const original = await call(`/invoices/${inv.data.id}`, { token });
  assert.equal(original.data.invoiceNumber, inv.data.invoiceNumber);
  assert.equal(original.data.totalMinor, inv.data.totalMinor);

  const again = await call(`/invoices/${inv.data.id}/void`, {
    method: "POST", token: financeToken, body: { reason: "Twice" },
  });
  assert.equal(again.status, 409);
  assert.equal(again.data.error.code, "ALREADY_VOID");
});

test("an invoice renders as printable text with a tax breakdown", async () => {
  const { folioId } = await freshStay();
  await call(`/folios/${folioId}/charges`, {
    method: "POST",
    token,
    body: { type: "POS_CHARGE", description: "Printable", amountMinor: 400000, applyTaxes: true },
  });
  const inv = await call("/invoices", { method: "POST", token, body: { folioId } });
  const rendered = await call(`/invoices/${inv.data.id}/render`, { token });
  assert.equal(rendered.status, 200);
  assert.match(rendered.data.text, /TOTAL/);
  assert.match(rendered.data.text, /Tax & service/);
  assert.match(rendered.data.text, /Balance due/);
  assert.ok(rendered.data.text.includes(inv.data.invoiceNumber));
});

test("an empty folio cannot be invoiced", async () => {
  const { folioId } = await freshStay();
  const inv = await call("/invoices", { method: "POST", token, body: { folioId } });
  assert.equal(inv.status, 400);
  assert.equal(inv.data.error.code, "NOTHING_TO_INVOICE");
});

// ── Invariant 6: checkout cannot leave money on the table ────────────────

test("INVARIANT checkout is blocked while any folio is owing", async () => {
  const guest = await call("/guests", {
    method: "POST", token, body: { firstName: "Check", lastName: `Out${uniq()}` },
  });
  const res = await call("/reservations", {
    method: "POST",
    token,
    body: {
      propertyId: property.id,
      guestId: guest.data.id,
      roomTypeId: typeId,
      arrivalDate: businessDate,
      departureDate: addDays(businessDate, 1),
    },
  });
  await call(`/reservations/${res.data.id}/check-in`, { method: "POST", token, body: {} });

  const blocked = await call(`/reservations/${res.data.id}/check-out`, {
    method: "POST", token, body: {},
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.error.code, "OUTSTANDING_BALANCE");

  await call("/payments", {
    method: "POST",
    token,
    body: {
      folioId: res.data.folioId,
      method: "CASH",
      amountMinor: blocked.data.error.details.balanceMinor,
    },
  });
  const ok = await call(`/reservations/${res.data.id}/check-out`, {
    method: "POST", token, body: {},
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));

  // A settled folio nets to zero.
  const folio = await call(`/folios/${res.data.folioId}`, { token });
  assert.equal(folio.data.balanceMinor, 0);
  assert.equal(sumEntries(folio.data.entries), 0);
  assert.equal(folio.data.status, "CLOSED");
});

test("INVARIANT a closed folio accepts no further postings", async () => {
  const guest = await call("/guests", {
    method: "POST", token, body: { firstName: "Closed", lastName: `Folio${uniq()}` },
  });
  const res = await call("/reservations", {
    method: "POST",
    token,
    body: {
      propertyId: property.id,
      guestId: guest.data.id,
      roomTypeId: typeId,
      arrivalDate: businessDate,
      departureDate: addDays(businessDate, 1),
    },
  });
  const ci = await call(`/reservations/${res.data.id}/check-in`, {
    method: "POST", token, body: {},
  });
  assert.equal(ci.status, 201, `check-in failed: ${JSON.stringify(ci.data)}`);

  // Checkout posts the outstanding room nights inside the same transaction it
  // validates in, so a blocked attempt rolls those postings back. Settle and
  // retry until it goes through, then assert it actually did.
  let co = await call(`/reservations/${res.data.id}/check-out`, {
    method: "POST", token, body: {},
  });
  for (let attempt = 0; attempt < 3 && co.status === 409; attempt++) {
    assert.equal(co.data.error.code, "OUTSTANDING_BALANCE", JSON.stringify(co.data));
    await call("/payments", {
      method: "POST",
      token,
      body: {
        folioId: res.data.folioId,
        method: "CASH",
        amountMinor: co.data.error.details.balanceMinor,
      },
    });
    co = await call(`/reservations/${res.data.id}/check-out`, {
      method: "POST", token, body: {},
    });
  }
  assert.equal(co.status, 201, `checkout never completed: ${JSON.stringify(co.data)}`);

  const closed = await call(`/folios/${res.data.folioId}`, { token });
  assert.equal(closed.data.status, "CLOSED", "checkout must close the folio");

  const late = await call(`/folios/${res.data.folioId}/charges`, {
    method: "POST",
    token,
    body: { type: "MINIBAR", description: "Too late", amountMinor: 10000, applyTaxes: false },
  });
  assert.equal(late.status, 400);
  assert.equal(late.data.error.code, "FOLIO_CLOSED");
});

// ── Invariant 7: payments are idempotent ─────────────────────────────────

test("INVARIANT a repeated payment key never double-credits", async () => {
  const { folioId } = await freshStay();
  await call(`/folios/${folioId}/charges`, {
    method: "POST",
    token,
    body: { type: "POS_CHARGE", description: "Idem", amountMinor: 500000, applyTaxes: false },
  });

  const key = `inv-${uniq()}-${Date.now()}`;
  const first = await call("/payments", {
    method: "POST",
    token,
    body: { folioId, method: "CASH", amountMinor: 200000, idempotencyKey: key },
  });
  const replay = await call("/payments", {
    method: "POST",
    token,
    body: { folioId, method: "CASH", amountMinor: 200000, idempotencyKey: key },
  });

  assert.equal(first.data.duplicate, false);
  assert.equal(replay.data.duplicate, true);
  assert.equal(first.data.payment.id, replay.data.payment.id);

  const f = await call(`/folios/${folioId}`, { token });
  const payments = f.data.entries.filter((e) => e.type === "PAYMENT");
  assert.equal(payments.length, 1, "a replayed key must not add a second payment line");
  assert.equal(f.data.balanceMinor, 300000);
});
