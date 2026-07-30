# Lodgiva API reference — identity, tenancy and property configuration

Machine-readable spec: [`docs/openapi.json`](openapi.json) (OpenAPI 3.0.0,
73 paths / 92 operations). Interactive docs are served at
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
