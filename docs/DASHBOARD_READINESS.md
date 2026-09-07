# Dashboard readiness check — 7 September 2026

This is a verification record, not a production-readiness certification.

## Changes in this pass

- Property changes remount the dashboard page so unsaved forms and POS carts do not carry identifiers into another hotel.
- Room and room-block configuration mutations invalidate the room rack and related configuration/housekeeping caches.
- Missing reconciliation values display a dash, not a misleading zero.
- POS cash settlement requires an open shift belonging to the order's property. Room posting rejects a folio from another property.
- Added three no-write regression tests for rejected POS settlements to the unit suite.

## Verification

- API TypeScript build and dashboard TypeScript check passed.
- Dashboard ESLint passed.
- API unit suite: 136 passed, zero failed.
- All 13 dashboard data endpoint checks passed against the restricted Neon application role.
- Live persistence checks passed for room creation, property isolation, guest edits, reservation creation, and check-in.
- Live workflow checks also passed for unpaid-checkout rejection, payment idempotency, zero-balance checkout, housekeeping advancement, and cashier shift opening/closing.
- Browser checks covered owner and manager login, role-dependent navigation, property switching with an unsaved settings edit, guest list, guest profile detail, and saving a profile edit.

The owner role intentionally cannot edit guests or operate POS; use a suitably scoped operational role rather than removing the authorization checks.

## Repeat the disposable smoke test

Use an isolated local API on port 4012 connected to the intended test database. From `apps/api`:

```powershell
node --env-file=../../packages/database/.env test/dashboard-fixture.mjs
node test/dashboard-workflows.mjs
node --env-file=../../packages/database/.env test/dashboard-fixture.mjs --cleanup
```

The fixture uses a clearly named temporary tenant and account, never a production seed reset. Cleanup is required even after a failed test. The fixture's credentials are test-only and must not become company credentials. `DIRECT_URL` is only used by fixture administration; the API runs with its restricted application role.

## Remaining launch gates

- Move report export execution out of fire-and-forget API calls into a durable, retryable worker. The current implementation can lose execution on restart and inherits request transaction context.
- Verify invitation acceptance and actual invitation delivery; queued status alone does not prove an email was sent.
- Finish browser coverage for every action and error state, including mobile/keyboard use and role/property restrictions.
- Run restart/recovery, concurrent booking/payment, file-storage, backup/restore, and production deployment checks with real configuration.
- Investigate the transient transaction error observed during the first live run; later endpoint passes do not establish reliability under sustained load.

Do not advertise the entire dashboard as production-ready until these gates are closed.
