# Test and quality audit

Audit environment: Windows PowerShell, Node 24.12.0, pnpm 10.28.2, local SQLite. External provider/deployment tests were not available.

## Command results

| Command/check | Result | Evidence / interpretation |
|---|---|---|
| pnpm install --frozen-lockfile | PASS | Lockfile was current. pnpm warned that native build scripts for Prisma engines, argon2, esbuild, and sharp were ignored; policy should be reviewed. |
| pnpm build | PASS on clean retry | Database generate, API tsc, dashboard tsc/Vite/PWA, and Next production build passed; 4 build tasks in about 5m39s. Worker and api-client have no build task. First attempt failed with Windows EPERM because an audit API process held Prisma's DLL; after stopping only that process, retry passed. |
| pnpm lint | FAIL | Turbo reaches only marketing; next lint prompts interactively for configuration. API, dashboard, worker, database, and client have no lint scripts. Not CI-reproducible. |
| pnpm test:unit | PASS | After the safe fix: 131 tests, 131 passed, 0 failed/skipped/todo. Covers permissions, CSV, restrictions, reservation states, confirmation codes, gateway signatures, settlements, PDFs, POS voids, TOTP/recovery codes, and fail-closed production configuration. |
| pnpm --filter @lodgiva/dashboard-web test | PASS | 5/5 cache-policy tests; operational allowlist and money denylist assertions pass. |
| pnpm test:integration without a running API | FAIL/TIMEOUT | Script is a client suite only; it does not start/reset/seed the API and timed out after about 244 seconds. This is a test harness defect, not a demonstrated product failure. |
| Integration suites against an audit-controlled fresh local API | PARTIAL | Files 24/24, gateway 22/22, night audit 15/15 passed. Inventory/analytics passed 23/25 in isolation; two housekeeping notification assertions depend on a task created by another suite. A combined earlier run had 209/230 due mainly to missing harness storage/base/secret configuration, corrected in focused reruns. |
| Fresh-database end-to-end workflow against configured local API | PASS | Terminal reported ALL E2E CHECKS PASSED. Covered booking/stay, folios/payments, cashiering/POS, maintenance, rates/tax, approvals, safe offline sync, night audit, reports/PDF/exports, security headers/rate limiting, tenant isolation, MFA, observability, support, and flags. |
| Prisma schema validate | PASS | prisma/schema.prisma is valid for the configured SQLite provider. This does not validate PostgreSQL compatibility. |
| pnpm check:migrations | FAIL | Strict gate reported 10 disk migrations, 0 applied in the selected DB, all pending, and destructive SQLite rebuild DROP/RENAME blockers. No production PostgreSQL chain was available. |
| pnpm openapi; pnpm generate:client; client typecheck | PASS with drift | Regeneration produced 155 paths/184 operations; OpenAPI and client differed from HEAD and were retained as deterministic generated fixes. Client tsc passes. Request bodies remain unknown. |
| pnpm audit --prod | FAIL | 7 advisories: 6 high, 1 moderate. See F-011. |

## Safe fix verification

apps/api/src/common/runtime-config.ts and runtime-config.test.mjs were added after the initial reports. pnpm --filter @lodgiva/api build and pnpm test:unit pass. This closes F-003's unsafe-startup behavior; it deliberately leaves the missing PostgreSQL/R2 architecture visible as F-001/F-007.

## Test-value assessment

The API tests are generally substantive. They assert response bodies, invariants, authorization, idempotency, signatures, side effects, duplicate behavior, and database state rather than only HTTP 200. No skipped/only/todo tests or broad TypeScript suppression pattern was found. The full e2e script demonstrates a coherent hotel day on one process/SQLite.

The central limitation is representativeness: there is no PostgreSQL/RLS test lane, multi-instance worker/API lane, connected provider sandbox lane, real browser/PWA lane, or production smoke lane. Passing local tests therefore supports **internal demo**, not **production safe**.

## Coverage gaps by risk

- P1: PostgreSQL concurrency, RLS direct-access isolation, access-token revocation/state change, TOTP ciphertext, high-value money serialization, worker crash/concurrency/idempotency, complete night-audit blockers, real R2, provider sandbox, deployment rollback, and dependency security.
- P2: multi-tab/offline quota/upgrade, account recovery, notification receipts, cross-instance SSE/rate limits, platform suspension/entitlements, complete business domains, and telemetry receipt.
- P3: accessibility, responsive layouts, installability, performance budgets, visual regression, documentation contract tests, and ADR enforcement.

## Quality-system findings

Requirement: noninteractive lint/typecheck/format/build/test/security/migration/generated-artifact gates in CI.  
Status/severity: **PARTIAL/FAIL — P2 F-023/F-024/F-025; P3 F-032/F-033**.  
Evidence: no .github workflows; root scripts lack format/typecheck; lint prompts; worker has no tests; integration needs a separately managed API; inventory fixture coupling; generated artifacts had drift.  
Business impact: regressions and insecure dependencies can merge without a reliable gate, and new contributors cannot reproduce one canonical command.  
Remediation: add one hermetic CI entrypoint that provisions PostgreSQL/Redis/object-store fixtures, starts API/worker, resets per suite, then runs format-check, lint, typecheck, unit, integration, browser/e2e, OpenAPI no-diff, migrations, audit, and build.

## Minimum CI lanes before production

1. Static: frozen install, format check, ESLint, aggregate TypeScript, forbidden raw Prisma/tenant query rule, generated-artifact no-diff.
2. Unit: pure business/security/serialization tests with deterministic clocks.
3. PostgreSQL integration: migrations, RLS, per-suite fixtures, transaction/concurrency tests, API and worker.
4. Browser/PWA: Chromium plus one mobile profile for login, offline cache/queue, service-worker upgrade, accessibility, and core front-desk flow.
5. Provider contracts: recorded and live sandbox tests for payments, R2, notifications, and observability.
6. Release: production dependency audit/SBOM, migration safety, preview smoke, canary smoke, rollback/forward-fix drill.
