# Lodgiva deployment environment guide

This guide describes what the current code actually consumes as of 2 August 2026. It does not turn unimplemented R2, Redis, email, SMS, or WhatsApp support into working integrations. See docs/audit/VERCEL_DEPLOYMENT_AUDIT.md before deployment.

## Environment separation

Use distinct development, preview/staging, and production projects, databases, buckets, queues, provider accounts/webhook URLs, VAPID keys, telemetry destinations, and encryption keys. Never copy production secrets into Vercel preview builds or local .env files. Keep server-only values in the runtime's managed secret store. The current clients expose no VITE_ or NEXT_PUBLIC_ configuration; do not add server secrets under either prefix.

## Current deployment blockers

- Prisma is generated for SQLite; a PostgreSQL DATABASE_URL will not make the current schema/migrations production-ready.
- getStorage always chooses local filesystem storage; R2_* variables are not consumed.
- REDIS_URL is not consumed; worker, rate limit, and realtime are process-local.
- RESEND_API_KEY, TERMII_API_KEY, and WhatsApp credentials are not consumed.
- The worker is a perpetual loop and requires a dedicated runtime, not Vercel Functions.
- The audit-added startup validator now rejects known unsafe current-runtime values; extend it as remote adapters become required.

## API and worker variables consumed today

| Variable | Required intent | Secret | Current consumer/notes |
|---|---|---:|---|
| NODE_ENV | production | no | main.ts and runtime behavior. |
| APP_RELEASE | immutable commit/release ID | no | observability release metadata. |
| API_PORT | dedicated runtime listen port | no | main.ts; usually injected by platform. |
| DATABASE_URL | database connection | yes | Prisma/API/worker/scripts. Current schema supports SQLite only; production must wait for PostgreSQL migration. |
| JWT_SECRET | at least 32 random bytes, preferably 64+ | yes | JWT signing/verification. Rotate with planned dual-key/key-ID support; current single key rotation logs users out. |
| CORS_ORIGINS | comma-separated exact HTTPS dashboard origins | no | Fastify CORS. Never omit or use wildcard with credentials. |
| DB_TX_MAX_WAIT_MS | transaction queue wait | no | Prisma transaction helper. Tune from load evidence. |
| DB_TX_TIMEOUT_MS | transaction timeout | no | Prisma transaction helper. |
| DB_TX_RETRIES | bounded transient retries | no | Prisma transaction helper. |
| RATE_LIMIT_MAX | global per-process maximum | no | main.ts. Not sufficient across instances; replace/back with Redis/WAF. |
| RATE_LIMIT_AUTH_MAX | auth per-process maximum | no | main.ts. |
| HOLD_MINUTES | booking hold duration | no | booking module. Change only through an approved operational policy. |
| PAYMENTS_MODE | sandbox until certification; live only with sign-off | no | payment providers. |
| PAYSTACK_SECRET_KEY | provider server key | yes | Paystack initialize/verify/refund and webhook HMAC. Paystack uses this key for webhook HMAC; PAYSTACK_WEBHOOK_SECRET is not consumed. |
| FLUTTERWAVE_SECRET_KEY | provider server key | yes | Flutterwave API calls. |
| FLUTTERWAVE_WEBHOOK_HASH | provider webhook hash | yes | verif-hash comparison. |
| STORAGE_LOCAL_ROOT | local demo file root | sensitive path | LocalStorageAdapter only. Must not be used as production persistence. |
| STORAGE_SIGNING_KEY | 32+ random bytes | yes | Local signed URL HMAC. Does not protect lost ephemeral files. |
| STORAGE_BASE_URL | public API files base URL | no | Must be exact HTTPS API origin and path. |
| UPLOAD_INTENT_TTL | signed upload seconds | no | File service. |
| DOWNLOAD_URL_TTL | private download seconds | no | File service. |
| VAPID_PUBLIC_KEY | Web Push public key | no | API/dashboard subscription response. |
| VAPID_PRIVATE_KEY | Web Push private key | yes | Worker. |
| VAPID_SUBJECT | mailto or HTTPS contact | no | Worker. |
| OTEL_EXPORTER_OTLP_ENDPOINT | verified HTTPS collector | sensitive | telemetry.ts HTTP exporter. |
| OTEL_EXPORTER_OTLP_HEADERS | collector auth headers | yes | Never log. |
| OTEL_SAMPLE_RATE | 0..1 sampling policy | no | telemetry. |
| OTEL_SERVICE_NAME | stable service name | no | telemetry. Use separate api/worker names once worker emits telemetry. |
| SENTRY_DSN | error backend DSN | sensitive | Status reporting; current full Sentry SDK delivery is not proven. |
| SLO_LATENCY_MS | local latency threshold | no | observability. |

API_BASE is used by test/load tooling rather than production browser code. PG_DUMP_BIN, PG_RESTORE_BIN, SQLITE_BIN, and MIGRATIONS_DIR are operator/script overrides. OPENAPI_OUT and OPENAPI_EXIT are build-generation controls and must not be set on the serving runtime.

## Variables required after remediation but not consumed today

REDIS_URL, R2_ACCOUNT_ID, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PUBLIC_BUCKET, R2_PRIVATE_BUCKET, RESEND_API_KEY, TERMII_API_KEY, and any WhatsApp/provider variables are design placeholders until the corresponding adapters and startup validation land. Setting them today has no production effect and must not be treated as a completed integration.

## Vercel frontends

Marketing: project root apps/marketing-web. No secret environment variables. If static export is selected, configure and test it explicitly. Remove/isolate demo /dashboard and /login routes before a customer-facing launch.

Dashboard: project root apps/dashboard-web. Serve the built dist as an SPA/PWA. Add a production rewrite from /api/* to the dedicated API origin so the browser stays same-origin. Rewrite app routes to /index.html but exclude assets, manifest, icons, sw.js, workbox files, and /api. Cache hashed assets immutably; serve index.html, manifest, and service worker with revalidation/no-store appropriate to safe updates. Set CSP connect-src for the API/stream/push endpoints.

## Dedicated API and worker

Run API and worker as separate services from one immutable release. API receives public HTTPS traffic and provider webhooks; worker has no public ingress. Neither should use Vercel Functions in the current design. After PostgreSQL migration, use a pooled runtime URL for the app and a direct URL only in a migration job if Prisma/tooling requires it. Run migrations once before rolling application instances and only after the migration safety gate passes.

## Secret generation and rotation

Generate random secrets with an approved password/secret manager or platform generator, never hand-written phrases. Give provider/storage/telemetry credentials least privilege and separate them by environment. Record owner, purpose, creation, expiry/rotation date, and emergency revocation procedure. Rotation tests must cover JWT sessions, storage URLs, VAPID subscriptions, gateway webhooks, DB users, Redis, R2, and telemetry tokens.

## Pre-deploy validation

1. Frozen install and universal lint/typecheck/unit/integration/browser/build gates pass.
2. pnpm audit --prod has no unaccepted high/critical advisory.
3. OpenAPI/client regeneration produces no diff.
4. PostgreSQL migration/RLS check passes on a clone and rollback/forward-fix is rehearsed.
5. Readiness proves DB, Redis/queue, object storage, and required provider/config dependencies.
6. Synthetic login/reservation/check-in/folio/payment-sandbox/night-audit/file/job flows pass.
7. Provider webhook signatures, R2 canary, notification receipts, trace/error/log receipt, alerts, backup and restore are proven.
8. CORS, CSP, HTTPS, cookie flags, cache behavior, rate limits, and tenant/property negative tests pass under production domains.

## Rollback and incident rules

Use backward-compatible expand/contract migrations so application rollback remains possible. Never roll back code across a destructive schema change. Stop live gateway changes first during ambiguous payment incidents, preserve webhook bodies/audit records, reconcile provider truth, and resume through an approved runbook. For isolation or secret compromise, suspend ingress, rotate affected credentials, preserve audit evidence, and notify accountable privacy/security owners.
