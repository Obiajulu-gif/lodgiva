# Lodgiva issue register

States: **Confirmed** (reproduced in code or at runtime) · **Fixed** (with the
check that proves it) · **Reproduced** (observed, not yet fixed) ·
**Hypothesis** (from the prior audit, not yet re-verified).

Every finding below was re-checked against the working tree at
`1587c53` + uncommitted work on 2026-09-09. Findings the prior audit listed
that are **already fixed** are marked as such rather than recreated.

---

## Fixed this cycle

### L-01 · Any authenticated user could move money — **Fixed**

**Severity:** critical. **User impact:** a housekeeper's account could post
charges, capture payments, reverse ledger entries and split folios.

`PermissionsGuard` allows any route with no declared permission
(`if (!required) return true`), and `FoliosController` and `PaymentsController`
declared none — verified by `grep -c "RequirePermission"` returning `0` on both.
The guard's behaviour is a deliberate design ("permissions gate actions"), so
the defect is the missing metadata, not the guard.

**Fix:** decorated every mutating route on both controllers, plus night audit,
cashiering, housekeeping, maintenance and invoices — 20 routes total.

| Route | Permission |
| --- | --- |
| `GET /folios/:id`, `GET /folios/by-reservation/:id`, `POST /folios/split` | `folio.read` |
| `POST /folios/:id/charges`, `POST /folios/:id/transfer` | `folio.post_charge` |
| `POST /folios/:id/entries/:entryId/reverse` | `folio.reverse_entry` |
| `POST /payments` | `payment.capture` |
| `GET /payments` | `folio.read` |
| `POST /night-audit/run` | `night_audit.run` |
| `POST /cashiering/shifts`, `.../movements` | `cashier.open_shift` |
| `POST /cashiering/shifts/:id/close` | `cashier.close_shift` |
| `POST /cashiering/shifts/:id/approve` | `cashier.approve_variance` |
| `POST /housekeeping/tasks`, `.../assign`, `.../advance` | `housekeeping.update` |
| `POST /maintenance`, `.../status` | `maintenance.manage` |
| `POST /invoices` | `folio.post_charge` |
| `POST /invoices/:id/void` | `folio.reverse_entry` |

**Regression coverage:** blocked — needs the integration harness (L-09).
Static verification only so far.

### L-02 · A typed word could settle a card payment — **Fixed**

**Severity:** critical. **User impact:** anyone able to record a payment could
mark a folio paid without money moving.

`SandboxGatewayProvider.verifyTransaction()` returned `{ verified: true }` for
any non-empty string, and `CARD` / `PAYMENT_LINK` were wired to it in
`PaymentsService.providers` **and** offered in the dashboard folio form.

**Fix:** the provider class is deleted. Manual recording now accepts only
`CASH`, `BANK_TRANSFER`, `POS_TERMINAL` — tenders a person can witness. Card
and payment-link collection has to go through `POST /payments/intents` and is
credited by a signed webhook or server-side verify. The dashboard no longer
offers the two options.

Also corrected: the form asked for a reference **only** on card payments — the
one case where the gateway supplies it — and not on transfers or terminal
payments, which are the ones with outside evidence to reconcile against. Both
the Zod schema and the form now require a narration/slip number for every
non-cash manual payment.

### L-03 · Inclusive tax overcharged every guest — **Fixed**

**Severity:** critical (money). **User impact:** a room quoted at ₦107,500
inclusive of 7.5% VAT was billed ₦115,000.

`TaxService.compute()` extracted the tax correctly for an `INCLUSIVE` rule
(`taxable × rate ÷ (10000 + rate)`), then added it to the untouched inclusive
base: `total = baseMinor + Σ lines`.

**Fix:** inclusive tax accumulates into `includedTaxMinor`; the charge line
becomes `base − includedTax`, so `base + Σ components == total` exactly, and
the quoted price is what gets billed.

**Regression coverage:** `apps/api/test/unit/tax.test.mjs` — 7 tests including
the brief's exact fixture (`10750000` → base `10000000`, tax `750000`, total
`10750000`), compounding, version selection, zero-rate and rounding
boundaries. **Passing.**

### L-04 · Folios were scoped by tenant only — **Fixed**

**Severity:** high. **User impact:** staff limited to property A could read and
charge property B's folios; every downstream check trusted this function.

`FoliosService.getFolioOrThrow()` filtered on `tenantId` alone.

**Fix:** the same rule `PropertiesService.assertProperty` applies —
`propertyId ∈ auth.propertyIds` unless `allProperties`. Enforced inline to
avoid a module cycle. Returns 404 rather than 403: telling an unauthorised
caller that a folio exists elsewhere is itself a disclosure.

**Regression coverage:** blocked on L-09.

### L-05 · A refused checkout rolled back the nights it had just posted — **Fixed**

**Severity:** high (money, dead end). **User impact:** the front desk was told
"outstanding balance ₦52,486.87" for a charge that was not on the folio they
could see, which showed ₦0.00. Settling the visible balance changed nothing;
checkout refused again, permanently.

Root cause is architectural: `TenantContextInterceptor` wraps the **whole
request** in one transaction, so `checkOut()` posting room charges and then
throwing `OUTSTANDING_BALANCE` discarded the charges with the exception. A
second `$transaction` call does not help — the proxy in `PrismaService` routes
nested calls straight back into the request's own transaction.

**Fix:** `PrismaService.runInNewTenantTransaction()` exits the
`AsyncLocalStorage` so the work genuinely commits on its own connection.
`postStayedNights()` uses it, and is idempotent per night.

**Verified at runtime** (local API against Neon, before the isolated-harness
rule took effect):

```
before:  balance 0
refusal: 409 demanding 5248687
after:   balance 5248687, 3 entries   ← now matches what is demanded
retry:   no double charge
paid →   checkout 201
```

### L-06 · A solo owner could not run their hotel — **Fixed**

**Severity:** high (product-blocking). **User impact:** a self-serve owner is
the only user in a new tenant. They could create a booking and then do nothing
with it — no check-in, charge, payment or check-out — until they invited a
colleague.

`TENANT_OWNER` held `reservation.create` but not `frontdesk.check_in`,
`folio.post_charge`, `payment.capture`, `frontdesk.check_out`,
`housekeeping.update` or `maintenance.manage`.

**Fix:** granted that operational set. Withholding it protected nothing — the
same role already holds `payment.refund`, `folio.apply_discount` and
`night_audit.run`. Cash handling (`pos.operate`, `cashier.open_shift`,
`cashier.close_shift`) is still withheld, because the shift is the
reconciliation unit and one person who opens, takes and closes their own
drawer has removed the only check on it.

**Regression coverage:** `test/unit/permissions.test.mjs` — "a role that can
take a booking can carry it through the whole stay" and "the owner still
cannot open, take and close their own cash drawer". **Passing.**

**Verified in the browser** on the deployed app: Check in → room 201 assigned
→ folio charge with correct compound tax (₦5,000 + ₦250 service + ₦393.75 VAT)
→ payment → balance ₦0.00.

---

## Fixed 2026-09-18, and what closing them exposed

These were listed as open on 2026-09-09. Each entry records what the fix
was and, where a fix uncovered something further, the new finding beside it
rather than filed away separately.

### L-07 · Undecorated mutating routes — **Fixed 2026-09-18**

`test/unit/route-permissions.test.mjs` now scans every controller and fails
when a mutating route neither declares a permission nor appears in an explicit
list with a reason. Missing metadata can no longer quietly mean "open".

Four assertions, the first of which matters most: the scanner must actually
find routes and detect existing decorators, or every other check passes
vacuously. A fourth forbids any route in `folios`, `payments`, `invoices`,
`cashiering` or `night-audit` from being excepted at all — those must be
declared outright.

**A note on the tool, because it nearly caused harm.** The first version only
looked for decorators *above* the route decorator, and this codebase writes
`@Post()` then `@RequirePermission(...)`. It reported 27 correctly-guarded
routes as wide open. Checking `reservations.module.ts` by hand before changing
anything is the only reason the real list below is six rather than
thirty-three. A scanner is a claim, not evidence, until its false-positive
rate is known.

### L-24 · Six routes had no authorisation check at all — **Fixed 2026-09-18**

Found by L-07's test, not by reading. All six were callable by any
authenticated account, a housekeeper included.

| Route | Now requires |
| --- | --- |
| `POST /payments/intents` | `payment.capture` |
| `POST /payments/intents/:id/verify` | `payment.capture` |
| `POST /refunds` | `payment.capture` |
| `POST /files/intents` | `file.manage` |
| `POST /files/:id/complete` | `file.manage` |
| `POST /analytics/exports` | `report.financial.read` |

Requesting a refund is not refunding — approval still gates the money leaving
— but it should not have been open to every account either. POS
order/settle/void and booking holds are now declared too; they had been
relying on nothing.

Refund approval, settlement import and exception resolution turned out to be
genuinely guarded, by an `APPROVER_ROLES` allow-list (owner / GM / finance)
inside the service. They are on the exception list with the reason recorded
rather than decorated — these are the routes that move money **out**, so the
argument for excepting them belongs on the record where a reviewer will see it.

### L-07b · Route classification still incomplete — **Open**

20 routes are now decorated, but a route-by-route audit is incomplete. Modules
with mutating routes and no `@RequirePermission`, needing individual
classification (some enforce in-service, which is valid but undeclared):

| Module | Mutating routes | Notes |
| --- | --- | --- |
| `approvals` | 3 | Checks `roleHasPermission` inside the service |
| `platform` | 3 | Asserts owner in the controller |
| `gateway` | 9 | Mostly public webhooks / signature-verified |
| `booking` | 3 | One public |
| `pos` | 3 | Retained backend, dashboard routes removed |
| `push`, `sync`, `auth` | 15 | Largely self-service on the caller's own record |

**Required:** an endpoint→permission matrix test that fails when a mutating,
non-public route neither declares a permission nor appears on a reviewed
allow-list with a stated reason. Missing metadata must not keep meaning "open".

### L-08 · Test harness cannot target PostgreSQL — **Fixed 2026-09-18**

`packages/database/src/reset.js` now accepts a disposable PostgreSQL target:
loopback host **and** a database named `*_test`, with managed hosts refused by
name so a tunnel to Neon still fails closed. The rejected URL is never printed
— it carries credentials.

Checked against five URLs that must never be reset — Neon pooled, Neon direct,
localhost without the suffix, a remote host with it, and a non-PostgreSQL
engine — **all five refused**.

### L-08b · Original finding, for the record — **was Confirmed**

`packages/database/src/reset.js` rejects any `DATABASE_URL` not starting with
`file:` (line 10), while PostgreSQL is now the only schema provider. So
`pnpm test:e2e` cannot run at all. The guard is correct in intent — it exists
to stop a reset against a shared database — but its condition no longer
matches reality.

### L-09 · No isolated test database — **Partly resolved 2026-09-18**

The host was the blocker, and it is now repaired. WSL2 failed for three
stacked reasons: 0.21 GB free disk, 0.1 GB free RAM against a `.wslconfig`
demanding 5.5 GB plus an 8 GB swap file, and a pending reboot. Caches were
cleared (0.21 → 3.5 GB), the config right-sized, and the user restarted —
after which disk reached 21.5 GB and WSL started cleanly (Ubuntu 24.04.4,
Python 3.12.3).

`scripts/test-db-up.sh` provisions `lodgiva_test` with an application role that
is explicitly `NOSUPERUSER NOBYPASSRLS`, and prints those flags so a suite
cannot pass by accidentally running as the owner.

**Still outstanding:** the PostgreSQL install inside WSL was interrupted
mid-`dpkg`, so no cluster exists yet. Until it does, integration and E2E
remain unrun and every access-control fix in this register — L-01, L-04 and
L-24 — stands on code reading and type checking alone.

### L-09b · Original finding, for the record — **was Confirmed**

`psql` is not installed; nothing listens on 5432; Docker CLI 29.6.2 is present
but the daemon did not start within 2 minutes of launching Docker Desktop.

Consequence: **every integration and E2E claim in this cycle is unverified.**
Unit tests, type checks and builds are the only executed evidence. See
`docs/LODGIVA_VERIFICATION.md`.

---

## Open

### L-10 · Production database was seeded — **Confirmed (needs cleanup decision)**

Before this brief was issued, `pnpm db:seed` was run against the production
Neon database in an earlier session, creating the `grand-palm` tenant (20
rooms, 5 guests, 5 reservations, 4 demo logins with a known password), plus
several `Browser Hotels …` tenants from signup probes and one completed
synthetic stay.

The seed is upsert-only and touched no pre-existing tenant, but demo logins
with the password `Password123!` should not remain in a production database.
**Awaiting a decision** on whether to remove them; nothing has been deleted.

---

## Carried forward from the prior audit — not yet re-verified

Listed so they are not lost. Each still needs reproduction before any fix.

| Ref | Area | Claim |
| --- | --- | --- |
| L-11 | Inventory | `extendStay()` changes dates without moving allocation rows |
| L-12 | Inventory | `roomMove()` lacks consistent lock ordering |
| L-13 | Inventory | `allocateStay()` catches `P2002` and keeps querying inside a failed transaction |
| L-14 | Inventory | `transactionWithRetry()` returns directly inside a request transaction, so retries never happen at the right boundary |
| L-15 | Billing | Room-charge dedup keys on a description containing the room number, so a room move can re-charge a posted night |
| L-16 | Billing | Multi-folio reservations use `folios[0]` ordering rather than explicit routing |
| L-17 | Dates | Date helper normalises `2026-02-30` into March instead of rejecting it |
| L-18 | Webhooks | Any duplicate `WebhookEvent` insert is treated as already processed |
| L-19 | Sessions | Token issuance picks the first active membership; multi-membership accounts may switch workspace on refresh |
| L-20 | Jobs | Export execution is fire-and-forget in request code |
| L-21 | Concurrency | `KeyedMutex` cleanup compares a different promise than it stored |
| L-22 | Money | API money representation mixes number and string forms |
| L-23 | Tax | Optional 5% service charge is applied silently when a property has no rules |
