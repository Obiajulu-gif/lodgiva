# Configuration reference

| | |
|---|---|
| **Status** | Living document. **Any pull request that reads a new environment variable must add it here** |
| **Source of truth** | The code. This list was built by searching `process.env.*` across `apps/`, `packages/` and `scripts/` on 2026-09-21 |

Every environment variable Lodgiva reads, with its default, whether production
requires it, and where it's read. **Prod** means enforced at startup by
`apps/api/src/common/runtime-config.ts`: the API refuses to boot with
`NODE_ENV=production` if the value is missing or unsafe.

Legend: **Prod** required and validated in production · **Yes** required
always · **—** optional

---

## Database

| Variable | Required | Default | Read in | Notes |
|---|---|---|---|---|
| `DATABASE_URL` | **Yes** | — | `app-factory.ts`, Prisma | The runtime connection. In production, the **`lodgiva_app`** role on the pooled host, so row-level security applies. Must start `postgres://` or `postgresql://` |
| `DIRECT_URL` | **Yes** | — | `app-factory.ts`, `schema.prisma` | Used by Prisma Migrate. The API refuses to start without it, but never queries through it. **At runtime, set it to the unpooled `lodgiva_app` URL**, verified 2026-09-22 with the full suite. Use the owner URL only when migrating (L-25) |
| `DB_TX_TIMEOUT_MS` | — | `20000` | `prisma.service.ts` | Longest a request's transaction may run |
| `DB_TX_MAX_WAIT_MS` | — | `15000` | `prisma.service.ts` | Longest to wait for a pooled connection |
| `DB_TX_RETRIES` | — | `5` | `prisma.service.ts` | Retries on serialisation conflicts |

## Security

| Variable | Required | Default | Read in | Notes |
|---|---|---|---|---|
| `NODE_ENV` | — | set by the host | several | `production` switches on the startup safety checks and `Secure` cookies. Vercel sets it |
| `JWT_SECRET` | **Prod** | a dev value | `app-factory.ts`, `auth` | 32+ characters, not the dev default. Signs 15-minute access tokens |
| `MFA_ENCRYPTION_KEY` | **Prod** | — | `secret-encryption.ts` | Exactly **32 bytes, base64**. Encrypts TOTP secrets at rest. **Changing it breaks every enrolled MFA** |
| `CORS_ORIGINS` | **Prod** | allow any (development only) | `app-factory.ts` | Comma-separated **exact HTTPS origins**, e.g. `https://lodgiva.vercel.app,https://lodgiva.com`. `*` is rejected |
| `RATE_LIMIT_MAX` | — | `600` | `app-factory.ts` | Requests per minute per token (or per IP when anonymous) |
| `RATE_LIMIT_AUTH_MAX` | — | `30` | `app-factory.ts` | Requests per minute on authentication routes |

Generate secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## File storage

| Variable | Required | Default | Read in | Notes |
|---|---|---|---|---|
| `STORAGE_ADAPTER` | **Prod** | local (development) | `runtime-config.ts`, `storage.ts` | `r2` or `disabled` in production. `disabled` makes file routes return `503 STORAGE_NOT_CONFIGURED`, so it's an honest off switch, not a silent local disk |
| `STORAGE_BASE_URL` | Prod with R2 | — | `storage.ts` | Public HTTPS base for signed URLs |
| `STORAGE_SIGNING_KEY` | Prod with R2 | a dev value | `storage.ts` | 32+ characters; signs upload and download URLs |
| `STORAGE_LOCAL_ROOT` | — | a local folder | `storage.ts` | Development only |
| `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Prod with R2 | — | `storage.ts` | Cloudflare R2 credentials |
| `R2_PUBLIC_BUCKET`, `R2_PRIVATE_BUCKET`, `R2_PUBLIC_BASE_URL` | Prod with R2 | — | `storage.ts` | Guest ID scans go to the **private** bucket |
| `UPLOAD_INTENT_TTL` | — | `900` (seconds) | `files.module.ts` | How long a signed upload URL lives |
| `DOWNLOAD_URL_TTL` | — | `300` (seconds) | `files.module.ts` | How long a signed download URL lives |

## Payments

| Variable | Required | Default | Read in | Notes |
|---|---|---|---|---|
| `PAYMENTS_MODE` | — | `sandbox` | `payment-providers.ts` | Only the exact value `live` allows real gateway calls. Webhook signatures are verified in every mode |
| `PAYSTACK_SECRET_KEY` | — | — | `payment-providers.ts` | Also the HMAC-SHA512 key for Paystack webhooks |
| `FLUTTERWAVE_SECRET_KEY` | — | — | `payment-providers.ts` | — |
| `FLUTTERWAVE_WEBHOOK_HASH` | — | — | `payment-providers.ts` | Shared hash Flutterwave sends with each webhook |

Manual tenders (cash, bank transfer, POS terminal) need no configuration.

## Bookings

| Variable | Required | Default | Read in | Notes |
|---|---|---|---|---|
| `HOLD_MINUTES` | — | `15` | `booking.module.ts` | How long a public-booking hold keeps a room |

## Push notifications

| Variable | Required | Default | Read in | Notes |
|---|---|---|---|---|
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | — | — | `push.module.ts`, `worker` | Web Push keys. Sending happens in the **worker**, which doesn't run on Vercel |
| `VAPID_SUBJECT` | — | `mailto:ops@…` | `push.module.ts` | Contact address for push services |

## Worker

| Variable | Required | Default | Read in | Notes |
|---|---|---|---|---|
| `OUTBOX_MAX_ATTEMPTS` | — | `10` | `worker/src/main.js` | Tries per event before it's parked |
| `OUTBOX_LEASE_SECONDS` | — | `60` | `worker/src/main.js` | How long a worker holds an event |
| `HOSTNAME` | — | `worker` | `worker/src/main.js` | Identifies the worker in leases |

## Observability

| Variable | Required | Default | Read in | Notes |
|---|---|---|---|---|
| `SENTRY_DSN` | — | — | `telemetry.ts` | Error reporting |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | — | `telemetry.ts` | Trace export target |
| `OTEL_EXPORTER_OTLP_HEADERS` | — | — | `telemetry.ts` | For example, an API key header |
| `OTEL_SERVICE_NAME` | — | `lodgiva-api` | `telemetry.ts` | — |
| `OTEL_SAMPLE_RATE` | — | `0.1` | `telemetry.ts` | Fraction of traces kept |
| `SLO_LATENCY_MS` | — | `500` | `telemetry.ts` | Latency objective used in request metrics |
| `APP_RELEASE` | — | `dev` | `telemetry.ts` | Release tag attached to errors |

## Servers and routing

| Variable | Required | Default | Read in | Notes |
|---|---|---|---|---|
| `PORT` / `API_PORT` | — | `4000` | `api/src/main.ts` | Standalone API only; `PORT` wins (Render injects it) |
| `LODGIVA_API_ORIGIN` | — | unset | `marketing-web/next.config.ts` | **Leave unset on Vercel.** When set, Next.js proxies `/api/v1/*` to this origin instead of running the API in-process |
| `NEXT_PUBLIC_PMS_URL` | — | unset (same origin) | `components/landing/Showcase.tsx` | Where the landing page's "See it in action" buttons open the PMS. **Public:** it's embedded in the browser bundle |

## First-tenant bootstrap (`pnpm db:bootstrap`)

Used once, from a trusted machine, against a production database that has no
tenants yet. It refuses if a tenant already exists.

| Variable | Required | Notes |
|---|---|---|
| `BOOTSTRAP_TENANT_LEGAL_NAME`, `BOOTSTRAP_TENANT_DISPLAY_NAME` | Yes | — |
| `BOOTSTRAP_TENANT_SLUG`, `BOOTSTRAP_PROPERTY_SLUG` | Yes | Lowercase URL slugs |
| `BOOTSTRAP_PROPERTY_NAME`, `BOOTSTRAP_PROPERTY_CODE` | Yes | The code prefixes invoice numbers, e.g. `GPI/2026/000001` |
| `BOOTSTRAP_OWNER_EMAIL`, `BOOTSTRAP_OWNER_NAME` | Yes | — |
| `BOOTSTRAP_OWNER_PASSWORD` | Yes | 14+ characters; documented and default passwords are refused |
| `BOOTSTRAP_CURRENCY` | — | Default `NGN` |
| `BOOTSTRAP_PROPERTY_TIMEZONE` | — | Default `Africa/Lagos` |

## Tooling (scripts only)

| Variable | Default | Used by |
|---|---|---|
| `API_BASE` | `http://localhost:4000…` | `scripts/load-test.mjs` |
| `OPENAPI_OUT`, `OPENAPI_EXIT` | — | `pnpm openapi` (writes `docs/openapi.json`) |
| `MIGRATIONS_DIR` | the Prisma folder | `scripts/check-migrations.mjs` |
| `PG_DUMP_BIN`, `PG_RESTORE_BIN`, `SQLITE_BIN` | `pg_dump`, `pg_restore`, `sqlite3` | `scripts/backup.mjs`, `scripts/restore.mjs` |

---

## Documented but not used

These appear in older notes or `.env.example`, but **no code reads them**.
Setting them does nothing. They're listed so nobody assumes a feature exists:

| Variable | The feature it implies | Status |
|---|---|---|
| `RESEND_API_KEY` | Email (booking confirmations, receipts) | Not implemented; the worker only logs these events (L-26) |
| `TERMII_API_KEY` | SMS | Not implemented (L-26) |

---

## The PMS (Frappe) is configured separately

The Lodgiva PMS doesn't read any of the variables above. Its settings live in
Frappe's `site_config.json` and in the installer's options
(`LODGIVA_DOMAIN`, `DEMO_HOTEL`, `ACME_EMAIL`, `REBUILD`, `LODGIVA_REF`). See
[deploy/README.md](../deploy/README.md).
