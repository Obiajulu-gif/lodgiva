# Lodgiva production-readiness audit

Audit date: 2 August 2026  
Repository: C:/Users/googl/Desktop/lodgiva  
Recommendation: **INTERNAL DEMO ONLY**

## Scope and authority

The requested file Nigerian_Hotel_Management_System_Technical_Specification.md is not present. The closest and most complete authority is docs/technical-specification.md, version 1.0 dated 28 July 2026. This audit uses that document and records the filename mismatch rather than claiming compliance with an unseen document. README.md, docs/implementation-status.md, docs/operations.md, docs/uat-script.md, docs/api-reference.md, source, schema, migrations, generated API artifacts, and executable checks were corroborating evidence.

## Decision

The repository is a strong local prototype: the monorepo builds, 131 API unit tests and 5 dashboard cache-policy tests pass, and the fresh-database end-to-end hotel workflow passes. Core reservations, front desk, folios, cashiering, POS, night audit, reports, MFA, files, offline-safe mutations, tenant-negative tests, and payment webhook invariants are implemented rather than empty route shells.

It is not a safe production release. Persistence is SQLite with SQLite rebuild migrations and no PostgreSQL RLS; session revocation, membership changes, and tenant suspension do not invalidate access tokens immediately; browser tokens and MFA seeds are exposed more than the specification permits; storage is local disk; the worker is not concurrency-safe; production gateways have not been certified; the deployment topology is neither configured nor evidenced; and the production dependency audit reports six high vulnerabilities. These are release blockers, not polish items. The audit did close the narrower unsafe-startup finding by adding tested production checks for database URL, JWT/storage secrets, CORS origins, and storage base URL.

## Finding totals

| Severity | Count | Meaning |
|---|---:|---|
| P0 | 0 | No reproducible cross-tenant disclosure, payment duplication, or irreversible corruption was demonstrated. |
| P1 | 12 open; 1 fixed | Blocks a production launch or can materially compromise authentication, isolation, money, or availability. F-003 was fixed during the audit. |
| P2 | 18 | Material completeness, operability, maintainability, or assurance gap. |
| P3 | 6 | Documentation, consistency, or lower-risk engineering debt. |

## P1 release blockers

| ID | Finding | Evidence and impact | Required remediation |
|---|---|---|---|
| F-001 | Production database contract is absent | packages/database/prisma/schema.prisma uses provider sqlite; all 10 migrations are SQLite SQL. The strict migration check fails with every migration pending and rebuild DROP/RENAME operations. PostgreSQL 18, timestamptz, deploy migrations, and production rollback evidence do not exist. | Create and rehearse a PostgreSQL baseline and forward-only migration chain on production-shaped data. |
| F-002 | Tenant isolation is application-convention only | Services inject PrismaService directly; no repository/UoW tenant enforcement and no RLS policies exist. Negative HTTP tests pass, but one omitted where clause can expose another tenant. | Add PostgreSQL RLS plus transaction-scoped tenant/property context and repository enforcement; test both HTTP and direct DB bypass attempts. |
| F-003 | **FIXED DURING AUDIT:** unsafe production defaults could start | apps/api/src/common/runtime-config.ts now rejects non-PostgreSQL URLs, missing/default JWT and storage signing secrets, missing/wildcard/non-HTTPS exact CORS origins, and non-HTTPS storage base URLs before development defaults are assigned. Five focused tests pass. This guard does not implement PostgreSQL or R2; those remain F-001/F-007. | Keep the validator in CI/startup and extend it when Redis/R2/provider adapters become required. Rotate any value that was previously exposed. |
| F-004 | Revocation and account state lag access-token expiry | AuthGuard verifies signed claims only. It does not check Session, User, Membership, Tenant.status, or current property scope. Revocation/admin changes therefore leave a token usable for up to 15 minutes. | Put a session/version identifier in access tokens and validate a cached server-side security version and active tenant/membership on every request. |
| F-005 | Refresh and access tokens live in localStorage | apps/dashboard-web/src/api.ts stores the complete session under lodgiva.session. Any successful XSS can steal long-lived refresh authority. | Move refresh tokens to Secure HttpOnly SameSite cookies, keep access tokens in memory, rotate and reuse-detect refresh families, then add CSRF controls where cookies authorize writes. |
| F-006 | MFA seeds are plaintext at rest | User.mfaSecret is a String and AuthService writes/reads the raw TOTP seed. Recovery codes are hashed, but the factor seed is not envelope-encrypted. | Encrypt TOTP seeds with a managed KMS key, version ciphertexts, restrict decryption to auth, and rotate existing seeds. |
| F-007 | Production object storage is not implemented | getStorage always returns LocalStorageAdapter; no S3/R2 SDK or remote adapter is present. Ephemeral/serverless disk cannot safely retain guest IDs, invoices, or exports. | Implement and test private/public R2 adapters, signed uploads/downloads, retention, malware scanning, deletion, and backup policy. |
| F-008 | Worker delivery is unsafe to scale | apps/worker/src/main.js polls unclaimed outbox rows, performs side effects, then sets publishedAt. Parallel/crashed workers can duplicate delivery; there is no lease, BullMQ/Redis, exponential backoff, dead-letter queue, or consumer idempotency table. | Deploy a dedicated worker with atomic claiming or BullMQ, idempotency keys, retry policy, DLQ, metrics, and crash/concurrency tests. |
| F-009 | Night audit can close over specified anomalies | NightAuditService.preflight blocks shifts/POS but only warns on overdue departures/unarrived bookings and does not check negative folios, occupied-without-stay, pending room moves, unposted charges, or payment/reconciliation exceptions. | Implement the full blocker/warning policy, evidence every query, and add close-over-anomaly integration tests. |
| F-010 | Money can lose integer precision at the API/report boundary | apps/api/src/main.ts globally converts BigInt to Number; NightAuditService also converts aggregates to Number. Values beyond Number.MAX_SAFE_INTEGER are silently rounded. | Serialize minor units as decimal strings or bounded integers with explicit validation; update the OpenAPI/client contract and add maximum-value tests. |
| F-011 | Production dependencies contain known high vulnerabilities | pnpm audit --prod reports 6 high and 1 moderate advisories, including find-my-way, js-yaml, sharp/libvips, PostCSS, and React Router. | Upgrade through patched framework/package versions, regression-test, and enforce a production audit gate in CI. |
| F-012 | No evidenced production deployment topology | No vercel.json, linked project metadata, CI workflow, or API/worker runtime manifest exists. docs/operations.md says only the marketing site is deployed. SSE and a perpetual worker are unsuitable for Vercel Functions. | Deploy marketing/dashboard on separate Vercel projects with rewrites and CSP; deploy API and worker on a dedicated long-running runtime; attach managed PostgreSQL, Redis, and R2; run smoke/rollback drills. |
| F-013 | Live payment readiness is unverified | Paystack and Flutterwave adapters contain real HTTP/signature code, but all executed tests were local/synthetic. No live-like sandbox certification, credential inventory, webhook URL evidence, settlement drill, or provider-version acceptance exists. | Complete provider sandbox certification for initialize/verify/webhook/refund/reconciliation, pin accepted API versions, and obtain finance sign-off before PAYMENTS_MODE=live. |

## P2 findings

F-014 platform subscription/trial/suspension/entitlement lifecycle is absent; F-015 rate limits and login failure counters are in-process and not multi-instance; F-016 password reset/account recovery and hardened cookie sessions are absent; F-017 email/SMS/WhatsApp deliveries are log messages except optional Web Push; F-018 SSE uses a query-string token and process-local delivery with no cross-instance bus; F-019 outbox envelopes omit required property/correlation/actor metadata and DLQ state; F-020 offline writes use localStorage without multi-tab coordination, quota handling, or queue schema migration; F-021 the generated client has unknown bodies and the dashboard uses a separate hand-written client; F-022 required shared packages and architectural boundaries are missing; F-023 lint is interactive and covers only marketing; F-024 integration commands assume a running API and one suite depends on another suite's fixture; F-025 no CI workflow or real-browser automation exists; F-026 authoritative/status/operations/API documentation conflicts with source and the requested spec filename is missing; F-027 readiness checks only the DB and telemetry delivery is not proven; F-028 several business domains are foundations only, including procurement/accounting/e-invoicing/revenue/group sales/preventive maintenance/advanced housekeeping; F-029 marketing also ships a demo dashboard/login surface that can be confused with the real PWA; F-030 String states/business dates and selected indirect property ownership are not database constrained; F-031 ledger/audit immutability is convention-based rather than database-enforced.

## P3 findings

F-032 root quality scripts omit format and aggregate typecheck and the worker has no build/test; F-033 checked-in OpenAPI/client artifacts were stale before this audit; F-034 documented test and route counts are stale; F-035 the marketing app is not configured for the specified static export even though current routes prerender; F-036 .env.example duplicates keys, names a non-consumed Paystack webhook secret, and claims an R2 adapter that does not exist; F-037 ADR identifiers appear in comments/documents but there is no committed ADR set.

## Evidence confidence and limitation

Local evidence is high-confidence. No production credentials, linked Vercel project, PostgreSQL database, Redis, R2 account, provider sandbox account, email/SMS account, or observability backend was available, so external integrations and deployed state are **UNVERIFIED**, never inferred as passing. The exact requested specification was absent.
