# Implementation status vs the technical specification

This tracks what is **actually built and verified** against
`docs/technical-specification.md`. Verified means covered by
`apps/api/test/e2e.mjs` (47 assertions, run against a live API) and/or
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
| Properties & Configuration | **Working** | Profile, timezone, business date, room rack. Taxes are fixed at VAT 7.5% + service 5% in `common/money.ts` — not yet a versioned per-property tax table (§13.3). |
| Rooms & Inventory | **Working** | Room types, rooms, all six operational states, guarded transitions. |
| Guests & CRM | **Working (core)** | Search, create, stay history. No merge, consent, or ID-document metadata. |
| Reservations | **Working** | Availability, create with double-booking prevention, cancel, no-show, full §7.1 state machine. Rate plans/restrictions not built — nightly rate comes from the room type. |
| Front Office | **Working (core)** | Check-in with dirty-room rule + audited override, checkout with room-night posting and settlement gate. No room move or stay extension yet. |
| Folios & Billing | **Working** | Append-only ledger, tax/service as separate lines, reversal-only corrections, balance, close. No split folios or PDF invoices. |
| Payments | **Working** | `PaymentProvider` interface with manual (cash/transfer/POS) and sandbox gateway adapters; idempotency keys; ledger effect. Real Paystack/Flutterwave webhooks not wired. |
| Cashiering & Night Audit | **Working** | Shift open/movements/close, expected-vs-counted variance requiring a reason, `PENDING_APPROVAL` + manager approval with self-approval blocked. Idempotent night audit that posts room charges, snapshots KPIs and advances the business date. |
| Housekeeping | **Working** | Task board, four-stage flow, room condition follows task completion, auto turnover task on checkout. |
| Maintenance | **Working** | Tickets with priorities; blocking ticket takes a room out of order; resolution routes back through housekeeping. |
| POS & Outlets | **Working** | Outlets, menus, server-side pricing, post-to-room-folio, cash settlement into the drawer, void rules. No modifiers or outlet shift reports. |
| Reporting | **Working (core)** | Daily flash (occupancy, revenue, movements, outstanding, payments by method) and audit trail. No CSV/PDF exports or scheduled reports. |
| Audit & Approvals | **Working (audit)** | Append-only audit events on every state change. Approvals exist for cash variance only — no general threshold policy engine. |
| Notifications | **Stub** | Outbox worker logs the notification it would send. No Termii/Resend adapters. |
| Platform & Subscriptions | **Not built** | No plan entitlements, usage limits or tenant suspension. |
| Rates & Availability | **Partial** | Availability search works; rate plans, restrictions, promotions and quote/hold tokens are not built. |
| Inventory & Procurement | **Not built** | |
| Accounting & Compliance | **Not built** | No journal export or e-invoice adapter. |
| Files / R2 (§11) | **Not built** | No upload intents or object storage. |
| Integrations | **Not built** | |

Also not built: MFA (§6.3), WebSockets (§9.5), the offline mutation/sync
contract (§10.3–10.4 — the dashboard is a PWA shell but does not queue
mutations offline), and rate limiting.

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

Run it with the API up:

```bash
node apps/api/test/e2e.mjs
```
