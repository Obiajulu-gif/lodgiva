# Lodgiva implementation plan

Goal: a dependable first-hotel workflow — create a workspace, configure rooms
and rates, give staff correct access, take reservations, confirm real
payments, check in, handle changes, check out, prepare rooms, close the day.

Ordering follows dependency, not visibility: access control first, then money
correctness, then the journeys that sit on top. Each phase names its
acceptance criteria and the evidence class that can prove it
(see `LODGIVA_VERIFICATION.md`).

---

## Phase 0 — Baseline · **done**

Established the working tree, re-checked the prior audit's findings against
current code, and recorded which were already fixed. Four of the audit's
critical claims reproduced exactly; several inventory claims remain
un-reproduced and are carried in the register rather than assumed.

---

## Phase 1 — Access, tenancy and money truth · **partly done**

| Item | State | Files |
| --- | --- | --- |
| Permissions on folio/payment routes | Done | `folios.module.ts`, `payments.module.ts` |
| Permissions on night audit, cashiering, housekeeping, maintenance, invoices | Done | those modules |
| Property scope on every folio access | Done | `folios.module.ts` |
| Remove the fake card verifier | Done | `payments.module.ts`, `reservation-workflows.tsx` |
| Evidence required for non-cash manual payments | Done | as above |
| Inclusive tax must not inflate the quoted price | Done | `tax.service.ts` + `test/unit/tax.test.mjs` |
| Owner can complete a stay | Done | `permissions.ts` + unit test |
| Refused checkout keeps its charges | Done | `prisma.service.ts`, `reservations.module.ts` |
| **Endpoint→permission matrix test** | **Next** | new `test/unit/route-permissions.test.mjs` |
| **Runtime proof of the above** | **Blocked** | needs B-01 |

**Acceptance:** a housekeeper cannot post, reverse, pay, refund or close the
day; property-limited staff cannot reach another property's finance; an
undecorated mutating route fails the build rather than opening quietly.
*The first two are implemented but unproven until the harness exists.*

---

## Phase 2 — Test harness · **next, and it gates everything after it**

Nothing below Phase 2 can be honestly claimed without it.

1. Isolated PostgreSQL (Docker), disposable, with an application role that is
   not owner/superuser/`BYPASSRLS` — asserted by the suite itself.
2. Repair `reset.js` to accept an explicitly named disposable PostgreSQL
   target and refuse everything else. Keep the guard; correct its condition.
3. Re-point `test:integration` and `test:e2e`; confirm the suites pass against
   the restricted role, including absent/incorrect/correct tenant context and
   pooled-connection reuse.
4. Add RLS policies per table rather than relying on the migration's
   discovery loop, which will not cover future tables.

**Acceptance:** `pnpm test:e2e` runs green against a disposable database, and
`pnpm test:integration` passes as the restricted role.

---

## Phase 3 — Inventory and stay invariants

Reproduce each carried claim (L-11 … L-14, L-17) before changing anything, and
write the failing test first — several are subtle enough that a fix without a
reproduction is a guess.

Order: strict date validation (cheapest, and it guards everything else) →
`allocateStay` transaction handling → `extendStay` allocation movement →
`roomMove` locking → hold consumption races.

Before any allocation-structure change: a read-only reconciliation of active
stays, hold allocations and room assignments, with an additive migration and
collision report. Paid stays are never silently rewritten.

**Acceptance:** two API instances race for the last room-night and exactly one
wins; extension allocates added nights; shortening releases only genuinely
free future nights; `2026-02-30` is rejected at the API boundary.

---

## Phase 4 — Ledger, documents and payment confirmation

- Replace description-based room-charge dedup with a stable business key
  (reservation-room + service date + component). L-15 is a live double-charge
  risk the moment a guest changes room.
- Explicit primary/routing rules for multi-folio reservations; checkout must
  account for every folio (L-16).
- One money representation across DTOs, client, exports and PDFs (L-22).
- Property billing policy must be an explicit choice; stop applying a silent
  5% service charge to a property that has configured nothing (L-23).
- Durable webhook statuses; a duplicate insert is not proof of processing
  (L-18).
- Receipt and invoice download from the reservation, authorised, private.

**Acceptance:** night audit → room move → checkout posts each night once; a
duplicate webhook and a verify/webhook race produce one financial effect.

---

## Phase 5 — Identity, sessions and shared devices

Invitation delivery with recoverable link material, password reset, refresh
that does not treat a 503 as a bad password, logout that works without an
access token, and query caches scoped so a shared reception PC never shows the
previous user's data (L-19).

---

## Phase 6 — Journeys and jobs

Finish the dashboard states (loading, forbidden, empty, conflict, retry),
move export execution onto the existing worker's leasing/retry machinery
(L-20), and make the product usable on a low-cost Android handset.

---

## Out of scope this cycle

Restaurant POS, payroll, procurement, loyalty, AI pricing, channel manager.
NRS e-invoicing stays behind an adapter boundary; nothing is labelled
compliant without a verified submission.

---

## Standing constraints

- Production Neon is not a test database. It has already been seeded once
  (L-10) — that needs a cleanup decision, not repetition.
- No deployment as part of verification without explicit authorisation.
- No live-money transactions, no messages to real guests.
- Never substitute a success response for an unverified one.
