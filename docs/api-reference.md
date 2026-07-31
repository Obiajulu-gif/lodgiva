# Lodgiva API reference — identity, tenancy and property configuration

Machine-readable spec: [`docs/openapi.json`](openapi.json) (OpenAPI 3.0.0,
83 paths / 104 operations). Interactive docs are served at
`http://localhost:4000/api/v1/docs` when the API is running. The typed client
generated from it lives in [`packages/api-client`](../packages/api-client).

Regenerate both after changing routes:

```bash
pnpm --filter @lodgiva/api build && pnpm openapi && pnpm generate:client
```

> **Known limitation.** Request bodies are validated with Zod at runtime, not
> with class-validator DTOs, so `@nestjs/swagger` cannot introspect them. The
> generated document is accurate for paths, methods, query/path parameters and
> security, and the generated client types bodies as `unknown`. The body
> contracts are therefore documented below by hand. Migrating the DTOs to
> `nestjs-zod` would close this gap and is the recommended next step.

---

## Authentication (§6.3)

All protected routes take `Authorization: Bearer <accessToken>`. **The tenant
is always derived from the token and never read from the request body**; any
route body containing `tenantId` is rejected outright (schemas are `.strict()`).

| Route | Body | Notes |
|---|---|---|
| `POST /auth/login` | `{ email, password }` | Argon2id verification. Returns `{ accessToken, refreshToken, claims }`. Access token lives 15 minutes. |
| `POST /auth/refresh` | `{ refreshToken }` | **Rotating**: the presented token is revoked and a new pair issued. Replaying a consumed token returns `401 SESSION_INVALID`. |
| `POST /auth/logout` | `{ refreshToken }` | Revokes the session. |
| `GET /auth/me` | — | User, tenant, role, resolved `permissions[]`, and the properties in scope. |
| `GET /auth/sessions` | — | Active/expired sessions with user agent and last activity. Token hashes are never returned. |
| `DELETE /auth/sessions/:id` | — | Revoke one session. |
| `DELETE /auth/sessions` | — | Revoke all sessions for the current user. |

**Account lockout.** Consecutive failures apply a *progressive* delay
(5s → 10s → 20s …, capped at 5 minutes) rather than a permanent lock, so a
front desk is never locked out mid-rush. A locked response is
`401 ACCOUNT_TEMPORARILY_LOCKED` with `details.retryAfterSeconds` and
`retryable: true`. Failures reset to zero on a successful login.

**User enumeration.** A wrong password and an unknown email return an
identical code and message, and the unknown-email path still performs a hash
so the two take comparable time.

---

## Onboarding and user administration

| Route | Permission | Body |
|---|---|---|
| `POST /onboarding/tenants` | public | `{ tenantName, legalName?, ownerEmail, ownerFullName, password, propertyName, propertyCode, timezone?, businessDate }` |
| `POST /onboarding/invitations/accept` | public | `{ token, password }` |
| `POST /properties` | `settings.property.manage` | `{ name, code, timezone?, businessDate, checkinTime?, checkoutTime? }` |
| `GET /memberships` | `user.manage` | — |
| `PATCH /memberships/:id` | `user.manage` | `{ role?, status?, allProperties?, propertyIds? }` |
| `POST /invitations` | `user.manage` | `{ email, fullName, role, allProperties?, propertyIds? }` |
| `GET /invitations` | `user.manage` | `?status=PENDING\|ALL` |
| `POST /invitations/:id/revoke` | `user.manage` | — |

Onboarding creates tenant + owner user + owner membership + first property in
a single transaction. Invitations return a **one-time token** in the response;
it is stored only as a SHA-256 hash and cannot be retrieved again. Accepting is
single-use and expires after 7 days.

Changing a membership's role, status or property scope **revokes that user's
sessions** (`revokedReason: ACCESS_CHANGED`) so an old access token cannot
outlive its privileges. The last active `TENANT_OWNER` cannot be demoted or
suspended (`409 LAST_OWNER`).

---

## Authorisation (§6.4)

RBAC plus resource scope. The full matrix is in
[`apps/api/src/common/permissions.ts`](../apps/api/src/common/permissions.ts)
and is unit-tested. Routes declare `@RequirePermission(...)`; a denial returns
`403 PERMISSION_DENIED` with `details.requiredPermission`.

| Role | Notable grants | Deliberately withheld |
|---|---|---|
| `TENANT_OWNER` | config, tax, users, approvals, reports | day-to-day check-in/POS |
| `GENERAL_MANAGER` | operations, approvals, config, users | tax configuration |
| `FRONT_DESK` | reservations, check-in/out, room move, folio posting, payment capture | tax and role configuration |
| `CASHIER` | POS, payment capture, shift open/close | `payment.refund` (needs approval) |
| `HOUSEKEEPING` | room status, tasks, inspections | all folio/payment access |
| `MAINTENANCE` | tickets, room blocks | financial access |
| `FINANCE` | reconciliation, refunds, tax settings, exports | check-in/POS |
| `AUDITOR` | read-only everything | every write |

**Resource scope.** A membership is either tenant-wide (`allProperties: true`)
or limited to listed properties. `assertProperty` is the single chokepoint:
out-of-tenant *and* out-of-scope both return `404 PROPERTY_NOT_FOUND` — never
`403` — so a response cannot confirm that an id exists.

---

## Property configuration

| Route | Permission | Notes |
|---|---|---|
| `GET /properties/:id/settings` | authenticated + scope | Property, counts, effective tax rules |
| `PATCH /properties/:id/settings` | `settings.property.manage` | `{ name?, timezone?, checkinTime?, checkoutTime?, status? }` |
| `GET /properties/:id/business-date` | authenticated + scope | Read-only; see below |
| `GET/POST /config/room-types`, `PATCH/DELETE /config/room-types/:id` | `settings.room.manage` | |
| `GET/POST /config/rooms`, `DELETE /config/rooms/:id` | `settings.room.manage` | |
| `GET/POST /config/amenities`, `DELETE /config/amenities/:id` | `settings.room.manage` | |
| `GET/POST /config/room-blocks`, `POST /config/room-blocks/:id/release` | `room.block` | |
| `POST /config/imports/rooms` | `settings.room.manage` | `{ propertyId, csv, dryRun? }` |
| `GET/POST /properties/tax-rules` | `settings.tax.manage` | Versioned; see §13.3 |

**Business date is read-only by design.** It advances only through night audit
(ADR-009). `businessDate` is not an accepted settings field — sending it
returns `400 VALIDATION_ERROR`. Exposing a setter would let a property skip a
day's posting and silently break revenue continuity.

**Taxes and service charges** are versioned rules, not columns. Changing a rate
creates version *n+1* and closes version *n* at the new effective date; posted
folio lines keep `taxRuleId`/`taxRuleVersion`, so historical invoices never
change. Service charge is modelled as the `SVC` rule with
`taxOnServiceCharge: false` and a lower `compoundOrder` so VAT computes on
base + service.

**Room blocks** are dated removals from sellable inventory, distinct from the
momentary `operationalStatus`. Creating a block that covers today also flips
the room's status; releasing it returns the room to `VACANT_DIRTY` — back
through housekeeping, never straight to sellable. A block cannot be placed over
an existing booking (`409 ROOM_HAS_BOOKINGS`).

**Referential safety.** A room type with rooms cannot be deleted
(`409 ROOM_TYPE_IN_USE`). A room with any operational history — reservations,
housekeeping tasks, maintenance tickets or blocks — cannot be hard-deleted
(`409 ROOM_HAS_HISTORY`, with per-category counts); take it out of service
instead. Hard delete exists only to correct a mistake made moments ago.

### Room import CSV

Required columns: `room_number`, `room_type_code`, `floor`.

```csv
room_number,room_type_code,floor
101,STD,1
102,DLX,1
```

The **entire file is validated before anything is written** — a bad row on
line 40 cannot leave 39 rooms half-created. Errors are returned as
`400 IMPORT_VALIDATION_FAILED` with `details.errors[] = { line, message }`
(line numbers are 1-based including the header). `dryRun: true` returns the
same report without writing. The parser handles quoted fields, embedded
commas and newlines, escaped quotes, CRLF and a UTF-8 BOM, caps input at 5000
rows, and builds rows with a null prototype so `__proto__` in a header cannot
pollute anything.

---

## Error contract

```json
{
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "Your role (FRONT_DESK) does not have permission to settings.tax.manage.",
    "retryable": false,
    "details": { "requiredPermission": "settings.tax.manage", "role": "FRONT_DESK" }
  }
}
```

| Status | Used for |
|---|---|
| 400 | `VALIDATION_ERROR` (Zod, with field paths), `CSV_INVALID`, `IMPORT_VALIDATION_FAILED`, `INVALID_DATE_RANGE` |
| 401 | `UNAUTHENTICATED`, `TOKEN_INVALID`, `INVALID_CREDENTIALS`, `SESSION_INVALID`, `ACCOUNT_TEMPORARILY_LOCKED` |
| 403 | `PERMISSION_DENIED` |
| 404 | `*_NOT_FOUND` — including out-of-scope resources |
| 409 | State conflicts: `LAST_OWNER`, `ROOM_TYPE_IN_USE`, `ROOM_HAS_HISTORY`, `ROOM_HAS_BOOKINGS`, `AMENITY_EXISTS`, `INVALID_STATE_TRANSITION` |
| 429 | `RATE_LIMITED` (`retryable: true`) |

---

## Guests and CRM

| Route | Permission | Notes |
|---|---|---|
| `GET /guests?q=` | authenticated | Merged tombstones are excluded from search |
| `GET /guests/:id` | authenticated | Profile with recent stays |
| `POST /guests` | `guest.manage` | |
| `PATCH /guests/:id` | `guest.manage` | `409 GUEST_MERGED` if the profile is a tombstone |
| `GET /guests/:id/duplicates` | authenticated | Ranked candidates |
| `POST /guests/merge` | `guest.manage` | `{ survivingGuestId, mergedGuestId, reason }` |
| `POST /guests/:id/blacklist` | `guest.manage` | `{ blacklisted, reason? }` — a reason is required to set |

**Identity documents are minimised (§12.2).** Only `idDocumentType`, the
**last four digits** and an expiry are accepted; the full document number is
never transmitted or stored.

**Duplicate detection** ranks by confidence: normalised phone (HIGH), email
(HIGH), then exact first+last name (LOW). Phone numbers are compared on the
last 10 digits, so `+234 803 …` and `0803 …` — used interchangeably in
Nigeria — match.

**Merging** re-points reservations and folios at the survivor, fills only the
survivor's *blank* fields from the merged record, and keeps the merged row as
a read-only tombstone so history is never orphaned. Every merge writes a
`GuestMergeLog` row and an audit event.

---

## Rates, restrictions, availability and booking

| Route | Permission | Notes |
|---|---|---|
| `GET /availability` | authenticated | `?propertyId&arrival&departure` — per-night capacity and per-plan sellability |
| `GET /quotes` | authenticated | `?propertyId&ratePlanId&arrival&departure&adults&children` |
| `POST /public/quotes` | **public** | `{ propertySlug, arrivalDate, departureDate, adults?, children?, ratePlanCode? }` |
| `POST /holds` | authenticated | `{ propertyId, ratePlanId, arrivalDate, departureDate, adults?, children? }` |
| `GET /holds/:id` | authenticated | Accepts a hold id **or** a hold token |
| `POST /holds/:id/release` | authenticated | Returns the rooms to sale |
| `GET/POST /rates/plans`, `/rates/calendar` | `settings.rate.manage` to write | |
| `GET/POST /rates/restrictions` | `settings.rate.manage` to write | |

### Restrictions

Per-date, per-rate-plan: `closed`, `closedToArrival` (CTA),
`closedToDeparture` (CTD), `minStay`, `maxStay`, `minAdvanceDays`. Sending a
field as `null` clears it.

Anchoring matters and is unit-tested: **CTA applies to the arrival night only**
and **CTD to the departure date itself** — a stay may pass *through* a CTA date.
Length-of-stay and advance-purchase rules are read from the **arrival date's**
row, with the plan default used when no override exists. A rejected quote
returns the first violation as `error.code` and **all** violations in
`error.details.violations`, so a guest adjusting dates is not sent round the
loop repeatedly.

### Quote → hold → reservation

1. `POST /holds` prices the stay and **claims real inventory**.
2. The response carries a one-time `holdToken` (stored only as a SHA-256 hash)
   and an `expiresAt` (`HOLD_MINUTES`, default 15).
3. `POST /reservations` with `holdToken` converts the hold, **transferring**
   the already-held slots rather than claiming new ones.

The quoted total is **frozen on the hold**: a rate change while the guest is
paying cannot move the number they agreed to. A token is single-use
(`409 HOLD_NOT_ACTIVE`), expires (`409 HOLD_EXPIRED`, retryable), and is
checked against the dates and room type it was issued for
(`409 HOLD_MISMATCH`).

Expired holds are swept on read as well as by the worker, so inventory
recovers even if the sweeper is not running.

### Concurrency-safe inventory

Availability is **not** "capacity minus a count" — that is a check-then-act
race. Every sold room-night takes an explicit slot in `[0, capacity)` in
`RoomNightAllocation`, with a unique constraint on
`(roomTypeId, date, slotIndex)`.

Two concurrent bookings for the last room contend on the same unique index and
**exactly one wins**. The guarantee is a database invariant, so it does not
depend on isolation level and behaves identically on SQLite and PostgreSQL.
Blocked rooms reduce capacity for the dates they cover, so a block can never be
sold over. Cancellation and no-show release the slots immediately.

This is covered by an integration test that fires `capacity + 4` simultaneous
bookings and asserts exactly `capacity` succeed and the rest return
`409 SOLD_OUT`.

---

## Provider and sandbox limitations

These are real constraints of the current environment, stated rather than
worked around:

1. **SQLite serialises writers (ADR-LOCAL-001).** Concurrent inventory
   transactions contend; under load SQLite reports a busy/timeout condition.
   Three mitigations are in place: `PrismaService.transactionWithRetry`
   (jittered backoff on transient codes `P2024`/`P2034`/`P1008` and
   busy/timeout messages), a process-local `KeyedMutex` that serialises claims
   per room type, and a filter that maps exhausted contention to
   `503 RESOURCE_BUSY` with `retryable: true` instead of a bare 500.
   **The mutex is a throughput optimisation, not the correctness boundary** —
   it is process-local and does nothing across instances; the unique index is
   what prevents overbooking. On PostgreSQL the retry path also covers
   serialization failures.
2. **OpenAPI body schemas are absent** — bodies are validated with Zod, which
   `@nestjs/swagger` cannot introspect. Paths, methods, parameters and security
   are accurate; the generated client types bodies as `unknown`. Body contracts
   are documented above by hand. `nestjs-zod` would close this gap.
3. **Payment providers remain sandboxed.** `SandboxGatewayProvider` stands in
   for Paystack/Flutterwave; no live keys are configured and no real webhook
   signature verification runs. Holds therefore expire on time rather than on a
   real payment callback.
4. **No PostgreSQL RLS** (§6.2 rules 6–7). Tenant isolation is enforced in the
   application layer and tested against a second real tenant, but the
   defence-in-depth database layer is unavailable on SQLite.

## Reservations

### Modify a reservation

`PATCH /reservations/{id}` — change dates, room type, occupancy or notes on a
stay that has not yet arrived.

Inventory is re-allocated inside the same transaction. The new dates are
claimed *before* the old ones are released, so a modification that cannot be
satisfied returns `409 SOLD_OUT` and the guest keeps the booking they already
had. A pre-assigned room that no longer matches the new type or dates is
dropped rather than silently carried over; the response `changes` object
records every field that moved.

Once the guest is in house the endpoint returns `409 NOT_MODIFIABLE` — use
`POST /reservations/{id}/room-move` or `/extend` instead, which have their own
housekeeping and folio consequences.

### Assign a room

`POST /reservations/{id}/assign-room` — assign `roomId`, or omit it to
auto-assign. Auto-assignment walks rooms of the reservation's type from the
lowest floor upward, skipping any that are blocked, out of order, or already
held by an overlapping stay. Check-in performs the same allocation when no
room has been assigned, so a booking never blocks arrival for want of a room
number.

### Confirmation codes

Codes are `LDG-XXXX-XXXX`, drawn at random from a 25-character alphabet that
excludes transcription-ambiguous glyphs (no `O/0`, `I/1/L`, `S/5`, `B`, `U/V`,
`Z`). Lookup normalises case, spaces and dashes, and folds excluded glyphs onto
the character they were most likely misread from (`B→8`, `O/0→Q`, `U/V→W`,
`Z→2`). Glyphs with no unambiguous target are rejected rather than guessed, so
a mistyped code never resolves to somebody else's booking.

Codes are random rather than sequential: a counter both races under concurrent
booking and publishes the property's reservation volume to anyone who books
twice.


## Front desk worklists

`GET /front-desk/arrivals`, `/departures`, `/in-house`, `/summary` — resolved
against the property's **business date**, not the wall clock, so a shift
working past midnight still sees today's list.

Arrivals carry a `blockers` array (no room assigned, room not clean, payment
outstanding, guest flagged) and `readyToCheckIn`. Departures carry per-folio
balances and `readyToCheckOut`, because checkout refuses while money is owed
and the desk should know that before the guest reaches the counter.

## Split folios and transfers

`POST /folios/split` opens an extra folio on a stay — room and tax to a
company account, extras to the guest. `POST /folios/{id}/transfer` moves
postings between folios **of the same stay**.

The ledger is append-only, so a transfer never re-parents a row. Each entry is
reversed on the source and re-posted on the target, both halves sharing a
`transferGroupId`, and the original is stamped so it cannot be moved twice.
The pair is exactly zero-sum: the combined balance of the two folios is
unchanged, which is asserted directly in the financial-invariant suite.
Transfers between different stays are refused — that would silently move a
debt onto another guest.

## Invoices and receipts

`POST /invoices` freezes an immutable snapshot of the folio's lines, taxes and
guest details, then assigns the next number in the property's yearly series
(`GPH-LAG/2026/000042`).

Numbering is **gapless**: the counter is a row read and incremented inside the
issuing transaction, not a `COUNT(*)`, which would both race and skip numbers
when a transaction rolls back — and a tax authority reads a gap as a deleted
invoice.

Issued documents never change. Postings made to the folio afterwards do not
appear on an already-issued invoice. Corrections go through
`POST /invoices/{id}/void`, which issues an offsetting credit note and marks
the original VOID while keeping its number. Voiding requires finance, manager
or owner.

`GET /invoices/{id}/render` returns plain text sized for a 46-column thermal
printer.

## Financial invariants

The suite in `test/integration/financial-invariants.test.mjs` asserts these
against real postings rather than against a model:

1. A folio's balance is exactly the sum of its entries.
2. A reversal is the exact negation; the original entry survives unchanged.
3. An entry cannot be reversed twice.
4. Tax and service charge post as separate lines, each stamped with the rule
   version that priced it; VAT compounds onto base + service.
5. A transfer conserves total value across the two folios.
6. The same charge cannot be transferred twice.
7. An issued invoice's snapshot does not move when the folio changes.
8. Invoice numbers are gapless and sequential.
9. A credit note exactly offsets the invoice it cancels.
10. Checkout is blocked while any folio is owing; a settled folio nets to zero.
11. A closed folio accepts no further postings.
12. A repeated payment idempotency key never double-credits.

## Payments: providers, webhooks and reconciliation

### Provider interface

`PaymentProvider` (`src/common/payment-providers.ts`) covers initialise,
verify, `verifySignature`, `parseWebhook` and refund. The folio layer never
learns which gateway took the money.

Two rules are enforced in the interface rather than left to each adapter:

1. **A payment is only confirmed from a server-side signal** — a verified
   webhook or an explicit verify call. A browser redirect to a success URL
   proves nothing; anyone can navigate there.
2. **Signatures are verified over the exact received bytes.** The Fastify JSON
   parser stashes the raw buffer on the request; re-serialising parsed JSON
   changes whitespace and key order and silently breaks verification. There is
   a unit test asserting a re-serialised body fails against its own signature.

**Live mode fails closed.** `live` is not inferred from a key's prefix — a
placeholder like `sk_test_placeholder` looks exactly like a real test key, and
treating it as live means a misconfigured environment starts calling a third
party. The operator must set `PAYMENTS_MODE=live` explicitly. Signature
verification is deliberately *not* gated on this, so a sandbox deployment
still rejects forged webhooks.

### Signature schemes

| Provider | Header | Scheme |
|---|---|---|
| Paystack | `x-paystack-signature` | HMAC-SHA512 of the raw body, keyed by the secret key |
| Flutterwave | `verif-hash` | Shared secret echoed verbatim |

Flutterwave's scheme proves the sender knows the secret but says nothing about
the payload, so amounts from Flutterwave are treated as advisory and a
mismatch against the intent raises a reconciliation exception.

Amounts: Paystack sends **kobo** (1:1 with our minor units). Flutterwave sends
**naira**, converted with rounding — truncation would lose a kobo on values
like ₦46,500.50.

### Webhook handling

Order: store the delivery → verify the signature → deduplicate → act. Storing
first means rejected deliveries stay visible; a burst of bad signatures is
what an attack looks like.

Deduplication is on `(provider, externalId)`. Providers retry aggressively, so
a replay is a no-op — asserted by a test that posts the same payload twice and
checks the folio has exactly one payment line.

Business-level problems return **2xx**: an unknown reference raises a
reconciliation exception rather than failing, because a non-2xx would make the
provider retry forever. Only a bad signature returns 4xx.

### Refunds

`POST /refunds` raises a request; nothing reaches the ledger until
`POST /refunds/{id}/approve` by a *different* user holding finance, manager or
owner. Approval posts a positive `REFUND` folio entry and, for card payments,
calls the provider. A refund can never exceed what remains unrefunded.

### Settlement import and reconciliation

`POST /settlements/import` takes a payout and matches each line to a recorded
payment. Four exception kinds, all worked by finance rather than auto-cleared:

| Kind | Meaning |
|---|---|
| `MISSING_IN_SETTLEMENT` | We confirmed a payment the provider has not paid out |
| `UNKNOWN_IN_SETTLEMENT` | The provider paid out something we never recorded |
| `AMOUNT_MISMATCH` | The settled amount differs from ours; both figures are kept |
| `DUPLICATE_REFERENCE` | The same reference appears twice in one payout |

Import is idempotent on the payout reference.

## Calendar drag-and-drop

Drag a stay **vertically** to change room, **horizontally** to shift its
dates, or diagonally for both. A dashed ghost bar previews the landing dates
during the drag, and rooms that cannot accept the stay are greyed out rather
than rejecting the drop.

The gesture picks the right endpoint by status: an in-house guest routes
through `room-move` (dirty room + housekeeping task), a future booking through
`assign-room`. Date shifts go through `PATCH /reservations/{id}`, which
re-allocates inventory in one transaction — a shift into a full window is
refused and the guest keeps the dates they had. In-house and departed stays
cannot have their arrival moved.
