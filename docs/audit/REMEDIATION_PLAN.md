# Prioritized remediation plan

## Release rule

Keep PAYMENTS_MODE=sandbox and deployment limited to isolated internal demos until every P1 has an owner, acceptance evidence, and sign-off. Production readiness means all P1 findings closed, no unaccepted high production advisories, and all gates below green on production-shaped infrastructure.

## Phase 0 — preserve evidence and prevent accidental launch (now)

1. Label all public demo routes and environments **non-production / no real guest or card data**.
2. Review and commit the audit documents, regenerated OpenAPI/client, and environment template independently of feature work.
3. Add a release checklist that blocks live provider mode and customer onboarding.
4. Rotate any value that ever matched the documented development JWT/storage defaults in a reachable environment.

Exit: stakeholders acknowledge **INTERNAL DEMO ONLY** and no production traffic/real PII/money enters the system.

## Phase 1 — security and data foundation (P1)

### 1A. PostgreSQL and tenant isolation

- Create a new PostgreSQL schema/baseline; do not try to run SQLite rebuild migrations in production.
- Add explicit tenant/property ownership, legal-state/date/amount constraints, indexes, timestamptz timestamps, and forward-only migrations.
- Add restricted app/migration roles and RLS policies driven by transaction-local tenant/property context.
- Put Prisma behind scoped repositories/UoW; prohibit unscoped client use.
- Port the full suite and add concurrent overbooking, folio, POS, night-audit, and direct-RLS bypass tests.

Acceptance: migration deploy/rollback rehearsal passes on production-shaped data; cross-tenant reads/writes fail at DB level; load and lock tests meet agreed SLOs. Closes F-001/F-002/F-030.

### 1B. Authentication, configuration, and exact money

- Keep the audit-added production startup validator green and extend it to reject local storage once the remote adapter selector exists.
- Use HttpOnly Secure SameSite refresh cookies with families/reuse detection; keep access tokens in memory.
- Bind access tokens to a server-validated session/security version and active User/Membership/Tenant/property scope.
- KMS-encrypt MFA seeds and add password-reset/account-recovery flows.
- Replace BigInt-to-Number JSON with decimal-string minor units and update all contracts/clients.

Acceptance: revocation/demotion/suspension takes effect immediately; XSS cannot read refresh tokens; DB snapshots do not expose MFA seeds; maximum-value money round-trips exactly; production config-negative tests pass. F-003 is already closed; this closes F-004/F-005/F-006/F-010/F-016.

### 1C. Dependency remediation

- Upgrade Next/Fastify/Nest Swagger/React Router/PostCSS/Sharp paths to patched versions using release notes and compatibility tests.
- Review pnpm's allowed-build-scripts policy for native dependencies and generate an SBOM.

Acceptance: pnpm audit --prod has no unaccepted high/critical findings and all static/unit/integration/browser/build gates pass. Closes F-011.

## Phase 2 — durable production integrations (P1/P2)

### 2A. Storage and worker

- Implement R2 public/private adapters, signed transfer, malware quarantine/scanning, retention/deletion, access audit, and recovery.
- Introduce Redis/BullMQ or atomic PostgreSQL leases; add idempotent consumers, retry/backoff/DLQ, poison-event controls, and worker metrics.
- Enrich outbox events with tenant/property, actor, correlation/causation, schema version, and stable idempotency key.

Acceptance: upload/download/delete/retention and restore canaries pass; two workers plus forced crash do not duplicate side effects; DLQ/replay is audited. Closes F-007/F-008/F-019.

### 2B. Payments and communications

- Certify Paystack and Flutterwave sandbox initialize/verify/webhook/refund/reconciliation, including duplicate/reordered/delayed events and ambiguous timeouts.
- Add email/SMS/WhatsApp adapters with consent, versioned templates, idempotency, receipts, retry/DLQ and suppression.

Acceptance: signed provider test evidence and finance approval; guest/staff delivery receipts observable; no browser redirect is trusted as payment truth. Closes F-013/F-017.

### 2C. Night audit and platform control

- Add complete non-waivable anomaly blockers and exact-value snapshots.
- Implement plan/trial/subscription/entitlement and hard suspension across API, jobs, streams and files.

Acceptance: every specified anomaly prevents close; business date never advances on failure; suspension immediately denies all surfaces. Closes F-009/F-014.

## Phase 3 — deployment and operations (P1/P2)

- Create separate Vercel marketing and dashboard projects; isolate/remove public demo dashboard routes.
- Deploy API and worker to dedicated long-running services with managed PostgreSQL, Redis and R2.
- Implement exact CORS/CSP/rewrites/cache policies, deeper readiness, shared rate limiting, Redis realtime fanout, and managed secrets.
- Prove OTLP/Sentry/log receipt, dashboards, SLO alerts, backup/PITR and restore drills.
- Add canary smoke and application rollback/forward-schema-fix runbooks.

Acceptance: production-like staging passes 24-hour soak, synthetic booking/payment/file/job checks, alert receipt, restore drill, and rollback drill. Closes F-012/F-015/F-018/F-027/F-029.

## Phase 4 — quality and feature completeness (P2/P3)

- Make lint noninteractive and universal; add root format/typecheck; build/test the worker/client; hermetic per-suite fixtures.
- Add PostgreSQL, real-browser/PWA, accessibility, visual, multi-tab, quota, performance, and provider contract CI lanes.
- Generate complete request/response OpenAPI schemas and use one generated client.
- Reconcile docs/spec/route/test counts and commit ADRs for approved deviations.
- Prioritize group sales, procurement, accounting/e-invoice, advanced housekeeping, preventive maintenance, and revenue management against signed launch scope.

Acceptance: one documented CI command passes from a clean clone; no generated drift; UAT and operational runbooks match the deployed product. Closes F-020 through F-037.

## Production-ready definition of done

- P0=0 and P1=0; remaining P2/P3 explicitly accepted by accountable owners with dates.
- PostgreSQL migrations/RLS, load, backup/restore, and rollback evidence attached to the release.
- Session/MFA/config/money and tenant-isolation security tests pass.
- R2, queue/worker, both payment providers, notifications, and telemetry are connected and certified.
- Dependency audit/SBOM reviewed; CI is green and reproducible.
- Vercel frontends plus dedicated API/worker smoke-tested under production domains.
- Finance, hotel operations, security, privacy, and engineering sign off on the exact feature claims.
