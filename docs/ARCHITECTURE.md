# How Lodgiva works — architecture reference

| | |
|---|---|
| **Status** | Living document. Update it in the same pull request as any change it describes (see [docs/README.md](README.md#keeping-these-documents-true)) |
| **Last verified against code** | 2026-09-21, `main` at `c712f52` + PR #4 |
| **Audience** | Engineers joining the project, operators deploying it, reviewers checking a change |

This document explains what Lodgiva is made of, how a request travels through
it, and why it is built the way it is. Every number in it was counted from the
source on the date above. If you find one that no longer matches, the code is
right and this document is wrong: fix it.

---

## Contents

1. [The system at a glance](#1-the-system-at-a-glance)
2. [Two stacks, and which one is current](#2-two-stacks-and-which-one-is-current)
3. [Deployment view](#3-deployment-view)
4. [The life of a request on Vercel](#4-the-life-of-a-request-on-vercel)
5. [The API](#5-the-api)
6. [Identity and access](#6-identity-and-access)
7. [Multi-tenancy](#7-multi-tenancy)
8. [Money](#8-money)
9. [Reservations and inventory](#9-reservations-and-inventory)
10. [Background work](#10-background-work)
11. [Files, observability and health](#11-files-observability-and-health)
12. [The web front ends](#12-the-web-front-ends)
13. [The Lodgiva PMS (Frappe)](#13-the-lodgiva-pms-frappe)
14. [Data model](#14-data-model)
15. [Security model](#15-security-model)
16. [Known limitations](#16-known-limitations)
17. [Glossary](#17-glossary)

---

## 1. The system at a glance

Lodgiva is hotel management software for Nigerian hotels. Hotel staff use it to
take bookings, check guests in and out, bill them in naira with VAT, take
payment and close the day. Guests use its public pages to book direct.

```
 Guests ──────► landing page + booking page ─┐
                                              ├──► Lodgiva ──► PostgreSQL (Neon)
 Hotel staff ─► staff app (desk, billing…) ──┘        │
                                                      ├──► Cloudflare R2   (files, when enabled)
 Payment providers (Paystack, Flutterwave) ──webhooks─┤
                                                      └──► Web Push        (housekeeping alerts)
```

It lives in three repositories:

| Repository | Contains | Runs on |
|---|---|---|
| [`lodgiva`](https://github.com/Obiajulu-gif/lodgiva) | Landing page, the original TypeScript stack, docs, deploy kit | Vercel (landing + API) |
| [`lodgiva-pms`](https://github.com/Obiajulu-gif/lodgiva-pms) | Lodgiva-branded fork of Kamra PMS (Frappe v16) | A Linux server |
| [`lodgiva-nigeria`](https://github.com/Obiajulu-gif/lodgiva-nigeria) | Nigerian country pack, money controls, branding | Inside the PMS |

---

## 2. Two stacks, and which one is current

Lodgiva currently contains **two implementations** of a hotel system. This is
deliberate and temporary, and understanding it prevents most confusion.

| | The original stack | The Lodgiva PMS |
|---|---|---|
| **What** | NestJS API + Next.js/Vite front ends + PostgreSQL | Frappe v16 + Kamra (forked) + `lodgiva-nigeria` |
| **Code** | This repository (`apps/`, `packages/`) | `lodgiva-pms`, `lodgiva-nigeria` |
| **Strengths** | Multi-tenant row-level security; kobo-integer money; append-only ledger; tested permission matrix | Far broader: tape chart, booking engine, POS/KDS, banquets, laundry, WhatsApp, channel seams |
| **Status** | **Frozen, not deleted** ([migration plan](LODGIVA_IMPLEMENTATION_PLAN.md)). It's the reference the PMS must match, and a fallback | **Direction of travel**, for staff operations |
| **Hosting** | Vercel (serverless) | A Linux server (Frappe can't run serverless) |

Why both: rebuilding Kamra's breadth would take years, but Kamra's financial
guarantees were **weaker** than Lodgiva's. A live test found four ways money
could go missing ([gap matrix §8](LODGIVA_GAP_MATRIX.md)). The plan is to
move staff onto the PMS and port or re-verify each of the original stack's
controls there before it's retired. `lodgiva-nigeria` is where those controls
land.

**The rest of this document describes the original stack in §4–§12, and the
PMS in §13.**

---

## 3. Deployment view

### Production today

```
                     ┌──────────────────── Vercel project "lodgiva" ──────────────────────┐
 browser ──HTTPS────►│  Next.js 15 (apps/marketing-web)                                   │
                     │   ├─ /                 landing page (static + client components)   │
                     │   ├─ /login /signup    auth pages                                  │
                     │   ├─ /dashboard/*      staff dashboard (middleware-guarded)        │
                     │   └─ /api/v1/*  ──►  route handler ──► the whole NestJS API        │
                     │                          (booted in-process, Fastify inject())      │
                     └───────────────────────────────┬────────────────────────────────────┘
                                                     │ Prisma, role lodgiva_app, pooled
                                                     ▼
                                          Neon PostgreSQL (RLS on every tenant table)
```

- **One Vercel project, one deployment.** The API is not a separate service:
  `apps/marketing-web/app/api/v1/[...path]/route.ts` boots the real NestJS app
  and dispatches each request into it (§4).
- **Not running on Vercel:** `apps/worker` (the outbox processor) and
  `apps/dashboard-web` (the offline-capable Vite PWA). See §10 and §16.
- **The PMS** runs on its own server behind a Caddy router, which can also
  serve this landing page at `/` from the same address
  ([deploy/README.md](../deploy/README.md)).

### Alternative: standalone API

Setting `LODGIVA_API_ORIGIN` makes Next.js **proxy** `/api/v1/*` to a
long-running API server (`pnpm api`, or the Render blueprint in
[deploy-render.md](deploy-render.md)) instead of booting it in-process. Only one
mode is ever active. Use it when you need what serverless can't do: SSE,
long exports, or a co-located worker.

---

## 4. The life of a request on Vercel

A staff member clicks **Check in**. Here is everything that happens, in order.

```
Browser
  │  POST /api/v1/front-desk/…    Authorization: Bearer <access token>
  ▼
Vercel edge → Next.js route handler  app/api/v1/[...path]/route.ts   (Node runtime, 60 s max)
  │  1. getApp(): reuse the booted Nest app, or boot it once per warm instance
  │  2. copy method, headers (minus hop-by-hop), raw body bytes
  │  3. remoteAddress := first x-forwarded-for entry
  ▼
Fastify inject() → NestJS pipeline   (built once in apps/api/src/app-factory.ts)
  │  helmet     security headers (CSP none, HSTS)
  │  cors       exact origins from CORS_ORIGINS
  │  rate-limit per bearer token, else per IP (in memory, per instance)
  │  JSON parser keeps the raw bytes for webhook signatures
  ▼
Guards and interceptors
  │  Auth guard         verify JWT (15 min), load user, membership, property scope
  │  PermissionsGuard   route's @RequirePermission vs the role's permission set
  │  TenantContextInterceptor
  │       └─ opens ONE database transaction for the whole request
  │          and runs  SET LOCAL app.tenant_id = '<tenant>'
  ▼
Controller → service → Prisma (inside that transaction)
  │  every query also filters tenantId in code
  ▼
PostgreSQL, connected as lodgiva_app
     RLS policy: "tenantId" = current_setting('app.tenant_id')
     → a row from another tenant is invisible even if the code forgot the filter
  ▲
  └─ commit (or roll back on any error) → JSON response → route handler → browser
```

Three details in the route handler are load-bearing, and each has broken
something before:

| Detail | Why it matters |
|---|---|
| The client IP is forwarded as `remoteAddress` | Rate limits key on `req.ip`; `inject()` defaults to `127.0.0.1`, which would put every visitor in one bucket |
| The body is forwarded as raw bytes | Paystack and Flutterwave sign the exact bytes; re-serialised JSON fails verification |
| `Set-Cookie` values are appended one by one | Joining them into one header silently strips the refresh cookie's attributes |

The boot **promise** is cached (not the resolved app) so concurrent cold
requests share one boot, and a failed boot is not cached so one database blip
doesn't poison a warm instance.

---

## 5. The API

`apps/api`: NestJS 11 on Fastify, Prisma, Zod validation.
**29 modules, 155 paths, 184 operations** (see [openapi.json](openapi.json) and
[api-reference.md](api-reference.md)). All routes live under `/api/v1`.

### Modules by domain

| Domain | Modules |
|---|---|
| Identity & tenancy | `auth`, `admin`, `platform`, `config`, `properties`, `support` |
| Guests & bookings | `guests`, `reservations`, `booking` (public quotes/holds), `rates` |
| Front office | `front-desk`, `housekeeping`, `maintenance`, `night-audit` |
| Money | `folios`, `payments`, `gateway` (Paystack/Flutterwave), `invoices`, `cashiering`, `approvals` |
| Food & beverage | `pos`, `inventory` |
| Reporting | `reports`, `analytics` |
| Platform services | `events` (SSE), `push`, `files`, `sync` (offline replay), `observability` |

### Shared building blocks (`apps/api/src/common`)

| File | Responsibility |
|---|---|
| `auth.ts`, `permissions.ts`, `permissions.guard.ts` | Who you are, what your role may do |
| `tenant-context.interceptor.ts`, `../prisma.service.ts` | Per-request transaction and tenant session variable |
| `money.ts`, `tax.service.ts` | Kobo arithmetic; VAT and levies |
| `reservation-state.ts`, `restrictions.ts`, `inventory.service.ts`, `mutex.ts` | Booking rules and concurrency |
| `payment-providers.ts`, `settlement-csv.ts`, `pos-void.ts` | Payments, settlement import, POS voids |
| `audit.service.ts` | Writes an `AuditEvent` for state changes |
| `storage.ts`, `pdf.ts`, `csv.ts` | Files, invoice PDFs, exports |
| `totp.ts`, `secret-encryption.ts` | MFA and encryption of stored secrets |
| `runtime-config.ts` | Refuses to start production with unsafe settings (§15) |
| `telemetry.ts` | OpenTelemetry and Sentry hooks |

### Conventions

- **Validation:** every body is parsed with a Zod schema; unknown keys are
  rejected (`.strict()`).
- **Errors:** `{ error: { code, message } }` with a stable `code`, such as
  `SESSION_INVALID` or `STORAGE_NOT_CONFIGURED`. A rate-limit hit is a real 429,
  never a 500.
- **Money in JSON:** BigInt values serialise as **decimal strings** so kobo
  can never be lost to floating point.
- **Mutations** carry an `@RequirePermission`. A unit test scans every
  controller and **fails the build** if a route has neither a permission nor a
  documented reason for being open (`test/unit/route-permissions.test.mjs`).

---

## 6. Identity and access

### Sign-in

```
POST /auth/login  {email, password}
  → argon2id verify (a dummy hash runs for unknown emails, so timing reveals nothing)
  → per-account progressive lockout on failures
  → MFA enabled?  → 5-minute mfaToken → POST /auth/mfa/verify {code}  (TOTP, RFC 6238)
  → issue:
       access token  JWT, 15 minutes, returned in the body, kept in memory by the client
       refresh token 48 random bytes, 30 days, HttpOnly + SameSite=Strict cookie
                     "lodgiva_refresh"; only its SHA-256 is stored (Session table)
POST /auth/refresh  → rotates the refresh token (single use) → new access token
```

- The web client holds the access token **in memory only**, never in
  `localStorage`, and refreshes transparently. Concurrent refreshes share one
  in-flight request.
- `apps/marketing-web/middleware.ts` redirects `/dashboard/*` to `/login` when
  the refresh cookie is absent.
- Sessions are listable and revocable; invitations add staff to a tenant.

### Roles and permissions

**8 roles × 38 permissions**, defined in `apps/api/src/common/permissions.ts`:

| Role | In short |
|---|---|
| `TENANT_OWNER` | Runs the business; can carry a stay end to end. Deliberately **cannot** open, operate and close their own cash drawer (segregation of duties) |
| `GENERAL_MANAGER` | Operations and approvals across the property |
| `FRONT_DESK` | Bookings, check-in/out, room moves, posting charges, taking payment |
| `CASHIER` | Shifts, cash movements, payments |
| `HOUSEKEEPING` | Room status and tasks |
| `MAINTENANCE` | Tickets |
| `FINANCE` | Reversals, variance approvals, financial reports |
| `AUDITOR` | Read-only |

A membership can be scoped to **specific properties**. Staff at property A can't
read property B's folios, even inside one tenant.

---

## 7. Multi-tenancy

Many hotel companies (tenants) share one database. Isolation has two layers,
and the second exists because the first depends on people never making a
mistake.

1. **In code:** every query filters by `tenantId` from the authenticated
   context.
2. **In the database:** migration `20260903001000_tenant_rls` enables
   row-level security on every tenant table with the policy
   `"tenantId" = current_setting('app.tenant_id', true)` for the role
   `lodgiva_app`. The API connects **as `lodgiva_app`**, and
   `TenantContextInterceptor` sets `app.tenant_id` inside the request's
   transaction. A forgotten filter returns nothing rather than another
   hotel's guests.

Two identities, two URLs (see [CONFIGURATION.md](CONFIGURATION.md)):

| Variable | Role | Used by |
|---|---|---|
| `DATABASE_URL` | `lodgiva_app`, pooled | The running API and worker. **Subject to RLS** |
| `DIRECT_URL` | Owner, unpooled | Prisma Migrate. **Bypasses RLS**; see L-25 in the [issue register](LODGIVA_ISSUE_REGISTER.md) |

Work that must survive a request's rollback, such as posting stayed nights
before a checkout that may then be refused, uses
`PrismaService.runInNewTenantTransaction`, which opens a separate committed
transaction under the same tenant.

---

## 8. Money

The design goal is **no naira ever appears or disappears without a record**.

| Rule | How it's enforced |
|---|---|
| Money is integer **kobo** (`BigInt` minor units) | `common/money.ts`; JSON serialises as strings |
| The ledger is **append-only** | `FolioEntry` amounts are never updated or deleted; corrections are **reversal** entries. The one `update` in the code only tags a transferred charge so it can't move twice. Enforced in code, not by a database trigger |
| Tax is computed, not typed | `TaxRule` rows are **versioned with effective dates** (`effectiveFrom`/`effectiveTo`), in basis points (750 = 7.5%), `EXCLUSIVE` or `INCLUSIVE`, with a compound order so VAT can apply after service charge. Each entry records the rule **version** it used, so old invoices never recompute |
| Invoice numbers are **gapless** | `InvoiceSequence` increments inside the invoice's own transaction, so a failed invoice rolls its number back. One series per property per year: `CODE/2026/000123` |
| Payments are **idempotent** | A payment carries a reference; gateway webhooks are stored in `WebhookEvent` and processed once |
| Cash must **balance** | A `CashierShift` closes with counted vs expected; a variance needs `cashier.approve_variance`, which the person who ran the drawer doesn't hold |

### Payment methods

- **Manual, live today:** `CASH`, `BANK_TRANSFER`, `POS_TERMINAL`. Non-cash
  tenders **require a reference**: the bank narration or the terminal slip
  number.
- **Gateways:** `PaystackProvider` and `FlutterwaveProvider` create payment
  intents and verify webhooks (Paystack: HMAC-SHA512 of the raw body;
  Flutterwave: shared hash). They make **no live calls** unless
  `PAYMENTS_MODE=live` is set explicitly, but signature checks apply in every
  mode.
- **After payment:** refunds (an authorised state machine), settlement CSV
  import, and reconciliation exceptions for anything that doesn't match.

There is **no sandbox adapter**. The one that reported payments as successful
without moving money was removed ([issue register](LODGIVA_ISSUE_REGISTER.md)).

---

## 9. Reservations and inventory

- **Quote → hold → reservation.** The public booking flow quotes a price and
  places a `Hold` for `HOLD_MINUTES` (default 15) before confirming.
- **Inventory** is tracked per room per night in `RoomNightAllocation`, and
  availability is checked **inside the booking transaction**, so two desks can't
  sell the last room twice.
- **State machine** (`common/reservation-state.ts`): only legal transitions are
  accepted, from confirmed through in-house and checked out, plus cancelled and
  no-show.
- **Confirmation codes** are generated to be unambiguous when read aloud or
  typed.
- **Restrictions** (`RateRestriction`): closed-to-arrival, minimum stay and so on.
- **Checkout** posts any un-posted nights in a separate committed transaction
  (§7), then refuses if the folio still has a balance.
- **Night audit** (`NightAuditRun`): posts room charges, flags no-shows,
  advances the business date **exactly once**, and lists blockers versus
  warnings before running. **It is triggered by a person, not a schedule** (§16).

---

## 10. Background work

### The outbox

Side effects are written as `OutboxEvent` rows **in the same transaction** as
the change that caused them, so an event exists if and only if the change
committed. `apps/worker` leases events (`OUTBOX_LEASE_SECONDS`), processes them
and retries up to `OUTBOX_MAX_ATTEMPTS`.

**What the worker actually does today:**

| Event | Effect |
|---|---|
| `housekeeping.task_assigned` | **Real:** a Web Push notification to the assigned housekeeper |
| `reservation.confirmed`, `guest.checked_in`, `guest.checked_out`, `payment.confirmed`, `night_audit.completed` | **Log line only.** Email and SMS are not implemented; `RESEND_API_KEY` and `TERMII_API_KEY` are not read anywhere in the code |

**The worker isn't deployed on Vercel.** Events accumulate in `OutboxEvent`
until a worker runs (`pnpm worker`, on any long-running host).

### Live updates

`events` streams Server-Sent Events. On Vercel, `inject()` buffers whole
responses, so `/events/*` deliberately returns **`501 SSE_UNAVAILABLE`**
instead of hanging. The Next dashboard polls instead; the Vite PWA needs the
standalone API for live updates.

---

## 11. Files, observability and health

- **Files** (`files` module, `common/storage.ts`): guest ID scans, invoice PDFs
  and exports go to **Cloudflare R2** through short-lived signed upload and
  download URLs. In production storage is either R2 or **explicitly
  `disabled`**. Disabled makes file endpoints return
  `503 STORAGE_NOT_CONFIGURED`, rather than silently writing to a disk that a
  serverless host wipes. The live deployment runs `disabled`.
- **Observability:** OpenTelemetry (`OTEL_*`), optional Sentry (`SENTRY_DSN`),
  and a `RequestMetric` table for latency against `SLO_LATENCY_MS`.
- **Health:** `GET /api/v1/health/live` (the process is up) and
  `GET /api/v1/health/ready` (it can reach the database).

---

## 12. The web front ends

### `apps/marketing-web` (Next.js 15, deployed on Vercel)

| Route | What it is |
|---|---|
| `/` | Landing page: hero, **"See it in action"** screenshots of the PMS, features, pricing, FAQ |
| `/login`, `/signup` | Sign-in and self-serve signup (creates a tenant) |
| `/dashboard`, `/guests`, `/reservations`, `/rooms`, `/housekeeping`, `/reports`, `/settings` | The staff dashboard, all under `/dashboard`. POS, cashiering and payments were **removed** from this dashboard by request (commit `081c79f`); the API still has them |
| `/api/v1/*` | The API (§4) |

Styling: Tailwind CSS v4 with brand tokens in `app/globals.css`
(`--color-brand-*` greens, `--color-gold-*`). The landing sections are in
`components/landing/`.

### `apps/dashboard-web` (Vite + React PWA, not on Vercel)

The original staff app: room rack, calendar, POS, cashiering, night audit,
payments. It caches reads in **IndexedDB** and replays queued writes through
the `sync` module when the connection returns, which matters on Nigerian
networks. It needs the standalone API for live updates and isn't part of the
Vercel project.

---

## 13. The Lodgiva PMS (Frappe)

The staff system the project is moving to. It's a separate deployment and
can't run on Vercel, because Frappe needs long-running web, worker, scheduler
and websocket processes, plus MariaDB and Redis.

```
                           ┌─ /lodgiva   staff app (React SPA)     ┐
                           ├─ /book      guest booking page         │ Frappe v16
browser → Caddy (HTTPS) ───┤  /hk        housekeeping phone app     │  + kamra   (lodgiva-pms)
                           │  /app       Frappe Desk (admin)        │  + lodgiva_nigeria
                           │  /api/method/…                         ┘  + MariaDB, Redis, scheduler
                           └─ everything else → lodgiva.vercel.app  (this landing page)
```

**How Nigeria plugs in without forking Kamra's logic:**

| Seam | What `lodgiva_nigeria` does through it |
|---|---|
| `kamra_localization` hook | Claims **Nigeria**: ₦/NGN, `en-NG`, VAT 7.5% on one line, TIN, "Naira … Kobo Only". Kamra calls `pack_for(property)`, which looks up the property's country; **a blank country falls back to India** |
| `doc_events` on `Reservation` and `Folio` | Refuses a checkout or invoice while money is owed, and refuses a duplicate payment reference. These run at **document level**, so no API route can bypass them |
| Property Setters (`after_migrate`) | Nigerian defaults: NGN, Africa/Lagos, POS Terminal tender, Nigerian nationality, NIN; payment currency NGN instead of INR |
| Hooks + Website Settings | Lodgiva name, logo and favicon; home page `/lodgiva` |

**What the fork itself changes** (kept small so upstream merges stay easy):
the rebrand, the app moved from `/kamra` to `/lodgiva` with redirects, removal
of India-only UI assumptions, and bug fixes found in testing. The Python app is
still named `kamra`, and so are its API paths; those are the contract.

Deployment: [deploy/README.md](../deploy/README.md). Evidence and open
questions: [LODGIVA_GAP_MATRIX.md](LODGIVA_GAP_MATRIX.md).

---

## 14. Data model

**55 Prisma models** (`packages/database/prisma/schema.prisma`), **2
migrations** (PostgreSQL baseline, then RLS). Almost every table carries
`tenantId`.

| Area | Models |
|---|---|
| Tenancy & identity | `Tenant`, `Property`, `User`, `Membership`, `MembershipProperty`, `Invitation`, `Session`, `FeatureFlag` |
| Rooms & rates | `RoomType`, `Room`, `Amenity`, `RoomTypeAmenity`, `RoomAmenity`, `RoomBlock`, `RatePlan`, `DailyRate`, `RateRestriction`, `TaxRule` |
| Guests & stays | `Guest`, `GuestMergeLog`, `Hold`, `Reservation`, `ReservationRoom`, `RoomNightAllocation` |
| Billing | `Folio`, `FolioEntry`, `Invoice`, `InvoiceSequence` |
| Payments | `Payment`, `PaymentIntent`, `WebhookEvent`, `Refund`, `Settlement`, `SettlementLine`, `ReconciliationException` |
| Cash & approvals | `CashierShift`, `CashMovement`, `ApprovalRequest` |
| Operations | `HousekeepingTask`, `MaintenanceTicket`, `NightAuditRun` |
| Food & beverage | `Outlet`, `MenuItem`, `PosOrder`, `PosOrderLine`, `InventoryItem`, `StockLocation`, `StockMovement` |
| Platform | `AuditEvent`, `OutboxEvent`, `SyncOperation`, `FileObject`, `PushSubscription`, `ExportJob`, `RequestMetric` |

Enumerated values are stored as strings with the allowed values documented
inline, such as `appliesTo: ALL | ROOM | FB`.

---

## 15. Security model

| Control | Where |
|---|---|
| Production refuses unsafe configuration: JWT secret ≥ 32 characters and not the dev default; `CORS_ORIGINS` exact HTTPS origins (`*` rejected); a 32-byte `MFA_ENCRYPTION_KEY`; R2 fully configured or storage explicitly `disabled`; `DATABASE_URL` a PostgreSQL URL | `common/runtime-config.ts`, run before anything else boots |
| Passwords hashed with **argon2id**; constant-time path for unknown emails; per-account lockout | `auth` module |
| **TOTP MFA**, with secrets encrypted at rest | `common/totp.ts`, `common/secret-encryption.ts` |
| Refresh token **HttpOnly, SameSite=Strict, rotating, stored hashed** | `auth` module |
| **Deny by default at the database** (RLS) plus tenant filters in code | §7 |
| Every mutating route declares a permission, enforced by a build-failing test | §5 |
| **Security headers**: CSP `default-src 'none'`, HSTS, frame-ancestors none | `app-factory.ts` |
| **Rate limits** per token or IP, with a stricter budget on auth | `app-factory.ts` |
| Webhooks verified against the **raw bytes** | `payment-providers.ts` |
| `db:reset` refuses anything that isn't a local database named `*_test` | `packages/database/src/reset.js` |
| An audit trail of state changes | `AuditEvent` via `audit.service.ts` |

Open security items are tracked in the
[issue register](LODGIVA_ISSUE_REGISTER.md). Notably, **L-10**: the production
database was once seeded with demo logins (`Password123!`) and is awaiting a
cleanup decision.

---

## 16. Known limitations

Stated plainly so no one discovers them in front of a customer.

| Limitation | Consequence | Where it's tracked |
|---|---|---|
| The **worker doesn't run on Vercel** | Outbox events accumulate; no push notifications | L-26 |
| **Email/SMS aren't implemented** | Confirmations, receipts and welcome messages are log lines | L-26 |
| **The night audit isn't scheduled** on the original stack | Someone must run it each night | L-28 |
| **SSE unavailable serverless** | `/events/*` → 501; the dashboard polls | [deploy-vercel.md](deploy-vercel.md) |
| **Rate-limit counters are per instance**, in memory | The auth budget multiplies by warm instances; per-account lockout still holds | deploy-vercel.md |
| **Behind the Caddy router**, API calls reach Vercel from one IP | Requests routed through a PMS server may share one rate-limit bucket | L-27 |
| **File storage is `disabled`** in production | Uploads, PDFs and exports return 503 until R2 is configured | deploy-vercel.md |
| The owner database URL (`DIRECT_URL`) is present in the runtime | Credentials that bypass RLS live in the serverless environment | L-25 |
| The PMS doesn't yet match every original-stack control | See gap matrix §8 and the PMS README | [gap matrix](LODGIVA_GAP_MATRIX.md) |

---

## 17. Glossary

| Term | Meaning |
|---|---|
| **Folio** | A guest's running bill: charges and payments |
| **Folio entry** | One line on a folio; never edited, only reversed |
| **Business date** | The hotel's accounting day. Advanced by the night audit, not the clock |
| **Night audit** | End-of-day close: post room nights, flag no-shows, roll the business date |
| **Tape chart / room rack** | A grid of rooms by nights, showing who is where |
| **Hold** | A short-lived reservation of inventory while a guest completes a booking |
| **Tenant** | A hotel company. It can own several properties |
| **Property** | One hotel |
| **Kobo** | 1/100 of a naira. All money is stored in kobo |
| **RLS** | PostgreSQL row-level security: the database hides other tenants' rows |
| **Outbox** | A table of side effects written with the change that caused them |
| **Country pack** | Kamra's per-country module for currency, tax and labels |
| **Kamra** | The open-source Frappe PMS that Lodgiva PMS is forked from |
| **Frappe** | The Python web framework the PMS runs on |
