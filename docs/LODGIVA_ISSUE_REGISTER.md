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

## Fixed 2026-09-22 — the first run against real PostgreSQL RLS

Until 2026-09-22 the integration suite had never run against PostgreSQL row-level
security. It ran against a disposable local `lodgiva_test`, with the API connected
**only** as the restricted role: `DATABASE_URL` and `DIRECT_URL` both set to
`lodgiva_test_app`, the same way production is meant to run. The first result was
11 passes out of 241. Everything below came out of getting that to a full pass.

### L-29 · `db:reset` couldn't run at all — **Fixed**

A `"\n"` in `packages/database/src/reset.js` had been written as a literal line
break on 2026-09-17, so the file failed to parse (`SyntaxError`). The reset, and
the e2e suite that calls it, didn't work for five days, and nothing noticed
because nothing ran it. **Fix:** the escape is restored.
`test/unit/reset-guard.test.mjs` now runs the script against six URLs it must
refuse (Neon, Supabase, a remote `*_test` host, a local database not named
`*_test`, MySQL) and checks that a refused URL's password is never printed. That
test fails on the old file.

### L-31 · Public entry points were broken under row-level security — **Fixed (needs the new migration in production)**

Four routes run with no signed-in user, so no tenant context exists, and RLS
correctly showed them nothing:

| Route | Symptom |
|---|---|
| `POST /gateway/webhooks/:provider` | **500**. The `WebhookEvent` insert was refused, so **no Paystack or Flutterwave payment could be confirmed by webhook** |
| `POST /booking/public/quotes` | **404** for every hotel. The public booking engine couldn't find anything |
| `POST /files/upload`, `GET /files/download` | 404 (local storage adapter only; R2 uploads don't pass through here) |

It was also **ambiguous**: property slugs and payment references are unique per
tenant, not globally, and the old code took whichever row matched first. That
could quote, and book, the wrong hotel.

**Fix:** migration `20260922000000_public_entry_point_resolvers`.
`WebhookEvent`, a platform inbox that no tenant route reads, leaves tenant RLS,
as the auth tables already do. Three narrow `SECURITY DEFINER` resolvers
(`lodgiva_tenant_for_payment_reference`, `lodgiva_active_property_by_slug`,
`lodgiva_tenant_for_file_object`) each answer only "which tenant owns this?",
and **only when the answer is unambiguous**. They're executable by `lodgiva_app`
only, not `PUBLIC`. The API then does all real work inside that tenant under
normal RLS. Unmatched webhook money is now recorded on the inbox as
`UNMATCHED` instead of as a `ReconciliationException` under the made-up tenant
id `"unknown"`, which RLS refused and no hotel could ever have seen.

### L-32 · Staff couldn't accept invitations — **Fixed**

`POST /admin/onboarding/invitations/accept` is anonymous. Its transaction wrote
an `AuditEvent` with no tenant context set, RLS refused it, and the whole
acceptance rolled back with `DATABASE_ERROR`. **Fix:** the transaction runs in
the invitation's own tenant.

### L-33 · Live updates never fired — **Fixed**

The SSE poller read `OutboxEvent` across all tenants in one query with no
tenant context, so RLS returned nothing and no stream ever received an event.
**Fix:** it polls once per tenant with a connected client, inside that tenant's
context, with a per-tenant high-water mark.

### L-34 · Exports never finished; request metrics were never saved — **Fixed**

Both were background work started during a request. AsyncLocalStorage carried
the request's transaction into it, but that transaction closes when the request
commits, so every later query failed. Exports stayed `QUEUED` forever, and the
metrics flush failed silently inside its `catch`. This was independent of RLS:
**broken on every deployment**. **Fix:** exports run each step in its own tenant
transaction, after waiting for the creating request to commit. The metrics flush
runs through the new `PrismaService.detached()`, outside any request.

### L-35 · A quarantined upload wasn't recorded — **Fixed**

`files.complete()` caught HTML disguised as a JPEG, marked the file
`QUARANTINED`, wrote an audit event, then threw a 409. The throw rolled the
request's transaction back, so the file stayed `UPLOADED` and the stored-XSS
attempt **left no audit trace**. Nothing was served, because only `CLEAN` files
download. **Fix:** the quarantine commits in its own transaction before the 409.

### L-36 · The integration suite was stale and had never run against RLS — **Fixed**

Beyond the defects above, the suite itself had drifted from the API:

- **Money** is serialised as strings (BigInt-safe), but tests did arithmetic on
  it, so `+` concatenated. A shared `test/integration/lib/api.mjs` now reads
  `…Minor` fields back as numbers; every fixture is far below 2⁵³.
- **Refresh** tokens moved to an HttpOnly cookie. The test still posted one in
  the body, and now exercises the cookie contract instead.
- **Reversals and voids** need `folio.reverse_entry` (GM or Finance) since L-01.
  Tests reversed as front desk; they now use the seeded manager, and expect
  **403** when front desk tries.
- **Cash settlement** needs a `shiftId`. The POS suite now opens a drawer, and
  closes it balanced at the end so it can't block the night audit.
- **Login rate limit**: about 35 sign-ins shared one 30-per-minute budget, so
  whole files failed with 429. All suites now wait a 429 out, as
  `hardening.test.mjs` already did, rather than raising a production limit.

`scripts/test-db-up.sh` also granted the test role in an order that PostgreSQL
16 doesn't honour (L-30), so every query was `permission denied`. It now
grants `WITH INHERIT TRUE` and explains why.

### L-25 · Owner database credentials live in the serverless runtime — **Verified locally (production change pending)**

**Update 2026-09-22:** the full integration suite passes with `DIRECT_URL` set to
the **restricted** role and no owner credentials anywhere in the API's
environment. That includes signup, the case the `app-factory.ts` comment worried
about. The owner URL is only needed for `prisma migrate`. **Production still
needs the change:** set Vercel's `DIRECT_URL` to the unpooled `lodgiva_app` URL.

**Original entry:**

Found 2026-09-21 while writing [ARCHITECTURE.md](ARCHITECTURE.md).
`app-factory.ts` refuses to start without `DIRECT_URL`, and the deploy guides
set it to the **owner** role, which bypasses row-level security. But nothing in
`apps/api/src` queries through it: the only reference is `directUrl` in
`schema.prisma`, which Prisma Migrate uses and Prisma Client merely requires to
exist. The comment in `app-factory.ts` says signup failed with an RLS
violation when it was unset. That doesn't follow from any query path, so the
real cause of that failure is unknown.

**Proposed:** set the runtime `DIRECT_URL` to the unpooled `lodgiva_app` URL,
keep the owner URL for migrations only, and run
`scripts/smoke-serverless-api.mjs` (it signs up a tenant) against a staging
deployment to prove it. **Not yet done.** [deploy-vercel.md](deploy-vercel.md)
states this as a recommendation, not a fact.

### L-26 · Notifications: no worker on Vercel, no email or SMS anywhere — **Confirmed**

Nothing hosts `apps/worker` on Vercel (no cron, no process), so `OutboxEvent`
rows accumulate and housekeeping push notifications are never sent. Separately,
the worker handles `reservation.confirmed`, `guest.checked_in`,
`guest.checked_out`, `payment.confirmed` and `night_audit.completed` with a
`console.log` only. `RESEND_API_KEY` and `TERMII_API_KEY` are read by no code.
Guests receive no confirmations or receipts from the original stack. (The PMS
has its own WhatsApp and email features.)

### L-27 · Requests routed through the Caddy router may share one rate-limit bucket — **Hypothesis**

When the landing page and its `/api/v1` are reached through the Lodgiva router
(`deploy/oracle/Caddyfile.routes`), Vercel sees the **server's** address, not
the visitor's. If Vercel sets `x-forwarded-for` to its immediate peer, every
visitor coming through one router shares the 30-per-minute authentication
budget. Low impact while the router serves demos; confirm before a hotel
depends on it.

### L-28 · The night audit isn't scheduled on the original stack — **Confirmed**

There's no scheduler: no `@Cron`, and no Vercel Cron in `vercel.json`. The
business date only advances when a person runs the night audit. The PMS runs
its own through Frappe's scheduler, which the installer enables.

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
