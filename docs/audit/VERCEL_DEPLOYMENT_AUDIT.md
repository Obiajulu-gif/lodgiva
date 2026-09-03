# Vercel and runtime deployment audit

## Verified state

No linked Vercel project metadata, vercel.json, project IDs, deployment API access, production environment inventory, or live URL evidence was available in the repository/session. docs/operations.md states that only the marketing site has been deployed. Therefore current deployed state for the dashboard, API, worker, database, storage, Redis, webhooks, and observability is **UNVERIFIED**. This report does not infer a pass from build success.

## Marketing web

Requirement: independent public marketing deployment, static where possible, no authenticated hotel data.  
Status/severity: **PARTIAL — P2 F-029; P3 F-035**.  
Evidence: Next production build passes and all 16 current routes are statically prerendered. next.config.ts does not set output: export. The same app publishes /dashboard/* and /login demo surfaces, including a reservations page that states changes are session-only.  
Impact: marketing is deployable, but demo dashboard routes can confuse customers/security reviews and broaden the public surface.  
Remediation: remove or clearly isolate demo operations under a labeled sandbox host, configure the intended static contract, set CSP/security headers, and verify no backend secrets are exposed.

## Operations dashboard

Requirement: separate Vercel project for the Vite PWA, SPA fallback, same-origin API route, security headers, cache rules, and environment separation.  
Status/severity: **UNVERIFIED — P1 F-012**.  
Evidence: Vite production build passes and emits the PWA; no Vercel configuration or linked project exists. The client hardcodes /api/v1 and depends on a platform rewrite/proxy not present in production config.  
Impact: direct route refreshes, API calls, service-worker scope, and CSP/CORS may fail or point at the wrong environment.  
Remediation: create a dedicated Vercel project rooted at apps/dashboard-web; add SPA rewrite excluding assets/api, same-origin /api proxy to the dedicated API, immutable asset caching, no-store HTML/service worker, CSP/connect-src, and preview/prod variable separation.

## API

Requirement: Nest/Fastify on a dedicated long-running runtime with health/readiness, connection pooling, migrations, exact CORS and observable rollback.  
Status/severity: **FAIL/UNVERIFIED — P1 F-001/F-012; F-003 FIXED**.  
Evidence: API TypeScript build passes. The audit-added validator now refuses unsafe production database/secret/CORS/storage URL values. No container/process/service manifest exists; storage remains local disk and readiness checks only SELECT 1. EventSource connections and in-memory controls need stable instances.  
Impact: deploying the API as a Vercel Function would conflict with local filesystem persistence, long-lived SSE, process-local state, and the perpetual worker model.  
Remediation: package a container for a dedicated runtime (for example a managed container/PaaS), attach pooled PostgreSQL/Redis/R2, run deploy migrations as a gated release job, and expose deeper readiness. Do not place the current API on Vercel Functions.

## Worker

Requirement: separately deployed, continuously running, horizontally safe worker with durable queue and no public ingress.  
Status/severity: **FAIL — P1 F-008/F-012**.  
Evidence: worker is an infinite Node loop with no build/test, service manifest, health endpoint, queue lease, or DLQ. Vercel cannot host this as a perpetual process.  
Impact: notifications/reports/outbox events are not reliably delivered and scaling can duplicate them.  
Remediation: dedicated private worker service using BullMQ/Redis or safe PostgreSQL leasing, process health/metrics, autoscaling bounds, and deployment smoke tests.

## Required topology

1. Vercel project A: apps/marketing-web only.
2. Vercel project B: apps/dashboard-web static PWA, same-origin rewrite to API.
3. Dedicated runtime: apps/api long-running service with pooled PostgreSQL connections and Redis.
4. Dedicated runtime: apps/worker private long-running service.
5. Managed PostgreSQL with RLS/PITR; Redis for queues/rate limits/pub-sub; R2 public/private buckets.
6. Provider webhooks terminate at the dedicated API with stable HTTPS URLs.
7. OTLP/Sentry/log destinations and alerts tested before traffic.

## Deployment gates and rollback

Requirement: reproducible CI, expand/contract migrations, smoke tests, and rollback compatible with DB changes.  
Status/severity: **FAIL — P1 F-012; P2 F-023/F-025**.  
Evidence: no CI workflows; lint is interactive; strict migration check fails on current local chain; no production smoke/rollback evidence.  
Remediation: gate frozen install, lint, typecheck, unit/integration/e2e, OpenAPI no-diff, production audit, PostgreSQL migration safety, build, preview smoke, then production canary. Roll back application only when schema remains backward-compatible; otherwise use a tested forward fix.
