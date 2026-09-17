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
