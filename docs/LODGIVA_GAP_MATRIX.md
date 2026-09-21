# Lodgiva ↔ Kamra feature and gap matrix

Prepared 2026-09-17 for ADR-001.

**Read the confidence column before using this.** Lodgiva's side is verified —
it is in this repository and much of it was tested in the last two weeks.
Kamra's side is taken from its public description and the revamp plan; **no
Kamra instance has been run**, because WSL2 will not start on this machine.
Every "claimed" row is a question to answer during the §8 vertical slice, not
a finding.

Legend — **V** verified in this repo · **C** claimed by Kamra/plan, unverified ·
**?** unknown · **✗** absent

---

## 1. Operations

| Capability | Lodgiva | Kamra | Notes for the slice |
| --- | --- | --- | --- |
| Reservations, amendments, cancel, no-show | V | C | Compare the state machine, not the screen |
| Room rack / tape chart | V | C | Kamra's is the reason for this proposal |
| Check-in / check-out | V | C | Does Kamra refuse checkout on an unsettled folio? |
| Room move | V (locking gaps open — L-12) | C | Does a move re-charge a posted night? Lodgiva's L-15 does |
| Housekeeping board | V | C | Task lifecycle and who may advance it |
| Maintenance tickets | V | C | Does a ticket block a room from being sold? |
| Night audit / business-day close | V (blockers + warnings) | C | Does the date advance exactly once? |
| Booking engine (public) | Partial | C | Lodgiva has quotes/holds; Kamra claims a full engine |
| POS / KDS | V (backend; dashboard removed by request) | C | Explicitly out of scope this cycle |
| Channel manager | ✗ | C (seams) | Neither has a working integration |

## 2. Money

This is the section that decides the migration. Everything here must be proven
against a running Kamra before any financial data moves.

| Capability | Lodgiva | Kamra | Notes for the slice |
| --- | --- | --- | --- |
| Append-only ledger; corrections as reversals | V | ? | If Kamra edits entries in place, that is a hard stop |
| Minor-unit (kobo) integer arithmetic | V | ? | Check for float money anywhere in the chain |
| Versioned tax rules with effective dates | V | ? | Do historical invoices recompute from current settings? |
| Inclusive **and** exclusive tax | V (fixed 2026-09-09; fixture pinned) | ? | Kamra is GST-shaped; inclusive VAT is the Nigerian case |
| Service charge distinct from tax | V | ? | Must not be collapsed into one "tax" |
| Gapless invoice numbering | V | ? | Legal requirement, not a nicety |
| Idempotent payment capture | V | ? | Duplicate webhook must post once |
| Refunds as an authorised state machine | Partial | ? | Cumulative cap, audit trail |
| Cashier shift + variance approval | V | C | Lodgiva withholds self-approval by design |
| Multi-folio routing | Partial (L-16 open) | ? | Checkout must see every folio |

## 3. Tenancy, access and audit

| Capability | Lodgiva | Kamra | Notes for the slice |
| --- | --- | --- | --- |
| Multi-tenant isolation | V (PostgreSQL RLS + restricted role) | ? | Frappe permissions are not RLS; compare honestly |
| Property scoping within a tenant | V (fixed 2026-09-09) | C (multi-property) | Can property-A staff reach property-B finance? |
| Role → permission matrix | V (38 permissions, 8 roles) | C | Map Kamra roles onto Lodgiva's |
| MFA | V (TOTP, RFC vectors) | ? | Frappe has 2FA; confirm it is enforceable per role |
| Audit trail of every state change | V | ? | Frappe versioning may cover this |
| Owner-operator mode | V (fixed 2026-09-08) | ? | A one-person hotel must be able to work |

## 4. Nigeria

The plan's core justification for `lodgiva_nigeria`. Lodgiva is already
Nigeria-shaped; Kamra is India-shaped by its own description.

| Item | Lodgiva | Kamra | Work implied |
| --- | --- | --- | --- |
| Currency NGN / ₦ | V | ✗ (INR) | Country-pack abstraction |
| Locale en-NG, Africa/Lagos | V | ✗ | " |
| VAT + TIN | V | ✗ (GST/GSTIN) | Replace, do not relabel |
| Phone +234 normalisation | V | ✗ (Indian parsing) | Keep international numbers working |
| Bank transfer / POS terminal tenders | V | ? | The dominant Nigerian tenders |
| Paystack | V (intents + webhooks) | ✗ (Razorpay-shaped) | Port to `lodgiva_nigeria` |
| States / LGAs | Partial | ✗ | Data only |
| NDPC-shaped privacy controls | Partial | ? | Guest ID retention and access |

## 5. Platform

| Capability | Lodgiva | Kamra | Notes |
| --- | --- | --- | --- |
| Offline / weak connectivity | ✗ in Next dashboard (old Vite PWA only) | ? | Nigerian connectivity makes this real |
| Durable background jobs | Partial (worker exists; exports still in-request) | C (Frappe scheduler) | Frappe's scheduler is a genuine advantage |
| Object storage | V (R2 adapter; no credentials) | C (Frappe files) | |
| Realtime updates | V (SSE — incompatible with serverless) | C (Frappe socketio) | Frappe's needs a long-lived process |
| Deployment | Vercel (one project, serverless) | VPS + Docker | **Different hosting model and cost** |

---

## 6. What this matrix cannot tell you yet

Every `?` above is unanswered because no Kamra instance has been run. The
honest summary is:

- Kamra's **operational breadth** looks wider (tape chart, booking engine, KDS,
  laundry, channel seams).
- Lodgiva's **financial and tenancy guarantees** are verified and recent, and
  several were subtly wrong until this month — which is the reason to check
  Kamra's equivalents rather than assume a more feature-complete product got
  them right.
- The **Nigeria work is real either way**. Kamra is India-shaped by its own
  description, so the country pack is not a thin veneer.

The §8 vertical slice — Nigeria setup → room/rate → booking → check-in →
bank-transfer payment → checkout → NGN receipt — answers most of the `?` rows
in one pass. That is the cheapest way to turn this matrix into evidence.

---

## 7. Kamra source audit — verified 2026-09-19

Against a real install, not the plan's description: separate bench
`~/kamra-bench` in WSL, **Frappe v16.25.0**, **Kamra v2.6.2** (`1533503`),
payments `86fefa9`. The existing ERPNext bench was not touched.

### The finding that shapes the whole plan

Kamra already has a **country-pack seam**. `kamra/localization/` ships packs
for India, Indonesia, Malaysia, Thailand and UAE plus a `generic` fallback,
and `pack_for()` resolves them through `frappe.get_hooks("kamra_localization")`
— which Frappe merges across every installed app. So a separate app can claim
a country without editing Kamra.

**Demonstrated:** `lodgiva_nigeria` now registers
`{"Nigeria": "lodgiva_nigeria.localization.nigeria"}` and implements the pack
contract (VAT/TIN labels, ₦, `en-NG`, 7.5% configurable default VAT, naira-and-
kobo amounts in words). **18 unit tests pass**, including one asserting no
Indian marker (₹, INR, GST, SAC, lakh…) reaches Nigerian output. Committed
locally in the app repo (`e923b16`). **Not yet run against a live site.**

The pack contract returns *one* tax rate per line. That fits Nigeria because
Kamra's own UAE pack sets the precedent: VAT is one line, and service charge
and municipal levies are **separate folio charges, not tax**. Nigeria's service
charge and state consumption levies follow the same pattern.

### India assumptions outside the pack

Counts are production code only — tests, demo scripts, translations and the
country packs themselves excluded.

| Where | Defect | Severity | Fix path |
| --- | --- | --- | --- |
| `frontend/src/lib/phone.ts` | `dialForCountry()` has no Nigeria entry and **falls back to `"91"`**, so `0803 123 4567` becomes an Indian number | **High** — every guest record | Fork edit: add `nigeria`/`ng` → `234`, length 10. Small; good upstream contribution |
| `kamra/api.py` and others | `₹` hard-coded in 39 user-facing strings (rate guardrails, action logs) | Medium | Fork edit: use the pack's `currency_symbol` |
| `PublicBooking.tsx` | `priceCurrency: "INR"` in the booking engine's structured data | Medium | Fork edit |
| `payments.py` | Razorpay-only; payment link currency hard-coded `"INR"` | Medium | Paystack belongs in `lodgiva_nigeria`; override the endpoint via hooks — **unverified** |
| `Property` doctype | Defaults: country India, `Asia/Kolkata`, INR, `en-IN`; GST slab fields (5%/18%, ₹7,500 threshold) | Medium | Property Setter fixtures in `lodgiva_nigeria`, no fork edit — **needs a site to verify** |
| `pack_for()` | Blank country is treated as India | Low | Covered once the Property default is Nigeria |
| `money.ts` | India defaults until the pack resolves (first-load flash only; cached thereafter) | Low | Fork edit, optional |
| Billing, TapeChart, CalendarView | Dates formatted with hard-coded `en-IN` | Low | `en-IN` and `en-NG` render day-month alike; cosmetic |
| `words.py` | No NGN entry — would print "NGN Twelve Only", dropping kobo | — | **Fixed** by the pack's own `amount_in_words` |

**Reading this honestly:** the tax/label/currency work the plan feared is
mostly absorbed by the existing seam. The fork still needs a handful of small,
upstreamable edits, and one of them (phone numbers) is not cosmetic.

---

## 8. The vertical slice, run against a live site — 2026-09-21

Site `kamra.localhost` on the evaluation bench, all four apps installed
(frappe 16.25.0, payments, kamra 2.6.2, lodgiva_nigeria 0.0.1). Property
**Lodgiva Demo Hotel**, Ikeja, Lagos, country Nigeria, currency NGN, created
through Kamra's own `setup_property` onboarding API — not by hand-inserting
rows. Two room types, four rooms. Every claim below was produced by running
the product, and the scripts are in the session scratchpad.

### The seam holds

`pack_for("Lodgiva Demo Hotel")` returns `lodgiva_nigeria.localization.nigeria`.
Note the signature: it takes a **property name**, not a country string, and
looks up that property's country — an unknown name silently falls back to
India, which is worth knowing before anyone calls it directly.

Through the live seam: `₦`, `en-NG`, `NGN`, labels VAT and TIN, place of
supply Lagos, split `[("vat", 1)]`. A two-night Deluxe stay priced
₦170,000 + ₦12,750 VAT = **₦182,750**; a Standard night posted by the night
audit as ₦45,000 + ₦3,375 = **₦48,375**. 7.5% throughout, via the pack, with
no Kamra source edited. Amount in words: "Naira Forty Eight Thousand Three
Hundred Seventy Five Only".

**Night audit, inventory control and check-in all work.** The audit posted
room charges, advanced the business date and flagged a no-show; booking a
third Deluxe room was refused — "2 of 2 rooms sold and the overbooking
allowance (0.0%) is used up".

### What the slice found — the reason to run it

| # | Finding | Severity | Evidence |
| --- | --- | --- | --- |
| 1 | **Checkout does not refuse an unsettled folio.** A guest owing ₦48,375 was checked out; the balance stayed ₦48,375 | **High** | `check_out()` sets `status = "Checked Out"` and saves — no balance check anywhere in the path |
| 2 | **A folio that still owes money can be closed and issued an invoice**, with no transfer to a receivable or city ledger — the debt simply sits on a closed folio | **High** | `INV-LDH-26-00003` issued on a folio with ₦91,375 outstanding |
| 3 | **A naira payment is stored as INR.** `Folio Payment.currency` is a Data field hard-defaulted to `"INR"`; the country pack cannot reach it | **High** | Live row: `mode: Bank Transfer, amount: 48375.0, currency: 'INR'` on a Nigerian property |
| 4 | **Payments are not idempotent.** The same amount and the same bank reference posted twice, taking the folio to **−₦1,000**; the overpayment was accepted silently with no refund state | **High** | Two identical `Bank Transfer` rows, `payments_total` 49,375 against a 48,375 bill |
| 5 | **Tax columns are named `gst_rate` / `gst_amount`** in the Folio Charge schema, so Nigerian VAT is stored in a column called GST | Medium | Doctype fields; inherited by every report, export and integration |
| 6 | **Payment modes are a fixed Select**: Cash, Card, **UPI**, Bank Transfer, OTA Prepaid, Company Credit, Payment Link. UPI is Indian; there is no POS terminal, Nigeria's second tender | Medium | `folio_payment.json` |
| 7 | **Money is float end to end** (Frappe Currency fields), against Lodgiva's integer kobo | Medium | Every amount above printed as `float` |
| 8 | Nothing normalises a phone number server-side — `"0803 123 4567"` is stored exactly as typed | Low–Medium | Compounds §7's `phone.ts` defect: the frontend would turn it Indian, the backend defends nothing |
| 9 | A zero-total folio consumed an invoice number in the legal series | Low | `INV-LDH-26-00002`, grand total 0 |

On the matrix's "append-only ledger" row: Kamra's intended correction path is
`post_allowance`, a write-off carrying a reason — a real mechanism. I also
changed a posted charge's amount directly and nothing objected, but that was
`frappe.db.set_value`, which bypasses the ORM by design, so it is weak
evidence about the product and is recorded only as "nothing at the storage
layer enforces immutability".

### What this means for the decision

Findings 1–4 are the same class of defect Lodgiva spent this cycle fixing, and
three of them touch money directly. They are not reasons to abandon the fork —
each is a small, targeted change — but they answer the question the matrix was
built to ask: **a more feature-complete product did not get the financial
guarantees right either.** A migration that assumes otherwise would move real
hotel money onto a system that lets guests walk out with an open balance.

Still unverified: whether the invoice series is gapless under a failed
transaction, `Property` doctype defaults via Property Setter fixtures, and
overriding the Razorpay endpoint from `lodgiva_nigeria` for Paystack.
