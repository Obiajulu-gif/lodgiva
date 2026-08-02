# Implementation status vs the technical specification

This tracks what is **actually built and verified** against
`docs/technical-specification.md`. Verified means covered by
`apps/api/test/e2e.mjs` (85 assertions, run against a live API) and/or
exercised through the dashboard UI.

## Local deviations from the spec

Two spec choices could not be honoured on this machine (no Docker, no Redis).
Both are isolated behind interfaces so production can switch without touching
callers.

| ADR | Spec says | Built as | Why / migration path |
|---|---|---|---|
| ADR-LOCAL-001 | PostgreSQL 18 (ADR-001) | SQLite via Prisma | Docker is unavailable locally. The schema avoids SQLite-only features; switching is a `provider` + `DATABASE_URL` change. Enums are modelled as validated strings (SQLite has no enum type) and enforced in the service layer, which is where the state machines live anyway. |
| ADR-LOCAL-002 | Redis + BullMQ (ADR-004) | `apps/worker` polls the outbox table | Redis is unavailable locally. The outbox contract is unchanged — events are written in the same transaction as the state change and consumers are idempotent — so swapping the poller for a BullMQ publisher needs no schema or API change. |

Money is `BigInt` minor units (kobo) everywhere, per §7.3. No floats touch money.

## Modules

| Spec module (§7) | Status | Notes |
|---|---|---|
| Properties & Configuration | **Working** | Profile, timezone, business date, room rack, and versioned per-property tax rules (§13.3). |
| Rooms & Inventory | **Working** | Room types, rooms, all six operational states, guarded transitions. |
| Guests & CRM | **Working (core)** | Search, create, stay history. No merge, consent, or ID-document metadata. |
| Reservations | **Working** | Availability, create with double-booking prevention, cancel, no-show, full §7.1 state machine. |
| Rates & Availability | **Working (core)** | Rate plans, per-date rate calendar with closed-date restrictions, minimum stay, and night-by-night quotes with itemised tax. No promotions, packages or hold tokens. |
| Front Office | **Working (core)** | Check-in with dirty-room rule + audited override, checkout with room-night posting and settlement gate. No room move or stay extension yet. |
| Folios & Billing | **Working** | Append-only ledger, tax/service as separate lines, reversal-only corrections, balance, close. No split folios or PDF invoices. |
| Payments | **Working** | `PaymentProvider` interface with manual (cash/transfer/POS) and sandbox gateway adapters; idempotency keys; ledger effect. Real Paystack/Flutterwave webhooks not wired. |
| Cashiering & Night Audit | **Working** | Shift open/movements/close, expected-vs-counted variance requiring a reason, `PENDING_APPROVAL` + manager approval with self-approval blocked. Idempotent night audit that posts room charges, snapshots KPIs and advances the business date. |
| Housekeeping | **Working** | Task board, four-stage flow, room condition follows task completion, auto turnover task on checkout. |
| Maintenance | **Working** | Tickets with priorities; blocking ticket takes a room out of order; resolution routes back through housekeeping. |
| POS & Outlets | **Working** | Outlets, menus, server-side pricing, post-to-room-folio, cash settlement into the drawer. Voids above ₦5,000 or older than 15 minutes route through the approval engine: the order parks in `VOID_PENDING` where it can be neither settled nor voided again, night audit blocks on undecided voids, and rejection returns the order to `OPEN` with the reason cleared. No modifiers or outlet shift reports. |
| Reporting | **Working** | Daily flash, occupancy/ADR/RevPAR (both denominators returned), revenue by category (payments excluded — they settle revenue), cashier (shortages and overages totalled separately), tax by rule version, aged receivables, audit trail and owner dashboard. All eight async export types build, in CSV and in PDF via a dependency-free writer. Exports run in-process rather than on a queue, and land in the local storage adapter rather than an object store. No scheduled reports. |
| Audit & Approvals | **Working** | Append-only audit events on every state change, plus threshold-driven approvals (§13.4): discounts over 5% of charges raise an approval request that never touches the ledger until a different, authorised user approves. Cash variances follow the same rule. |
| Offline sync (§10.3–10.4) | **Working** | `POST /sync/mutations` applies queued mutations idempotently by `operationId`, reports version conflicts with a resolution path instead of auto-merging, rejects financial actions as online-only, and returns a change feed with a cursor. The dashboard queues housekeeping changes when the API is unreachable and flushes on reconnect, showing offline state, unsynced count and last sync time. |
| Notifications | **Stub** | Outbox worker logs the notification it would send. No Termii/Resend adapters. |
| Platform & Subscriptions | **Not built** | No plan entitlements, usage limits or tenant suspension. |
| Inventory & Procurement | **Not built** | |
| Accounting & Compliance | **Not built** | No journal export or e-invoice adapter. |
| Files / R2 (§11) | **Not built** | No upload intents or object storage. |
| Integrations | **Not built** | |

Also not built: MFA (§6.3), WebSockets (§9.5), and rate limiting. The offline
support covers **writes** (queue + sync); it does not yet cache **reads**, so
a cold page load with no connectivity shows an empty board (§10.2).

## Verified invariants

The e2e suite asserts the release-gate behaviours from §16.1:

- Reservation state machine rejects illegal transitions (`CONFIRMED → CHECKED_OUT`).
- No double booking: capacity is checked inside the creating transaction.
- Tax and service charge post as **separate immutable ledger lines**.
- Posted entries are never edited — corrections are reversals, and an entry
  cannot be reversed twice.
- Duplicate payment with the same idempotency key returns the original payment
  and creates no second row.
- Checkout is blocked while a folio balance is outstanding.
- Night audit is idempotent per (property, business date) and is the only
  writer of the business date.
- Cash variance cannot close silently, and a cashier cannot approve their own.
- A blocking maintenance ticket removes a room from sellable inventory.
- Unauthenticated and unknown/cross-tenant reads return 401/404, never data.
- Changing a tax rate creates a new rule version; already-posted lines keep the
  amount and rule version they were billed under.
- A discount above the threshold does not reach the ledger until approved, and
  the requester cannot approve it.
- A rate plan's minimum stay and closed dates block quoting.
- A replayed offline `operationId` is not applied twice, and a stale
  `baseVersion` returns a conflict rather than overwriting newer server state.

Run it against a freshly seeded database (recommended):

```bash
pnpm --filter @lodgiva/api test
```

Or against the current database, with the API up:

```bash
node apps/api/test/e2e.mjs
```
