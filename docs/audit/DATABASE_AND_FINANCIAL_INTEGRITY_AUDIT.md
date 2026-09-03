# Database and financial-integrity audit

## Production database

Requirement: §3/§6 PostgreSQL 18, Prisma migrations, tenant/property RLS, timestamptz timestamps, integer minor money, and production-safe deploy migrations.  
Status/severity: **FAIL — P1 F-001/F-002; P2 F-030**.  
Evidence: packages/database/prisma/schema.prisma declares provider sqlite; business dates/statuses are unconstrained String values; migrations are SQLite table rebuilds. Prisma validate passes. scripts/check-migrations.mjs --strict fails: 10 migrations on disk, 0 applied in the selected database, all pending, with DROP_TABLE/RENAME blockers. No PostgreSQL SQL, policies, roles, or RLS tests exist.  
Business impact: the production database required by the specification cannot be deployed or defended; SQLite locking/typing behavior is not evidence for hotel concurrency.  
Technical impact: schema and migration SQL must be regenerated/reviewed; date/time, constraints, indexes, and concurrency can behave differently.  
Remediation: design a PostgreSQL baseline rather than editing SQLite migrations in place; add CHECK/enum constraints, timestamptz fields, RLS, transaction-scoped tenant context, concurrent indexes, migrate-deploy/rollback drills, and production-shaped load.

## Ownership and constraints

Requirement: every tenant row carries tenantId, property-specific rows propertyId, ownership-compatible uniqueness/indexes, and restricted cascades.  
Status/severity: **PARTIAL — P2 F-030**.  
Evidence: schema.prisma has explicit tenant/property keys on most aggregates and generally avoids cascades on financial roots. Some children/events use indirect property ownership, and many state/date invariants are comments/String fields rather than database CHECKs. Webhook/provider and business-date uniqueness should be re-evaluated under explicit tenant/property ownership.  
Impact: invalid states and policy/index blind spots can enter through bugs, migrations, scripts, or privileged access.  
Remediation: publish an ownership table for every model, add explicit keys where policies/partitioning need them, and enforce legal states/date relationships/positive amounts in PostgreSQL.

## Money representation and ledgers

Requirement: integer minor units end to end; no floating-point money; append-only charges/payments/refunds/cash/audit.  
Status/severity: **PARTIAL — P1 F-010; P2 F-031**.  
Evidence: Prisma monetary fields use BigInt and services generally perform BigInt arithmetic. main.ts installs BigInt.toJSON returning Number; NightAuditService converts revenue/payment sums to Number. FolioEntry and AuditEvent are ordinary mutable tables; at least transfer metadata is updated on an existing folio entry.  
Impact: very large aggregates can silently round and a compromised/buggy writer can rewrite financial history.  
Remediation: use decimal-string minor units in JSON/OpenAPI, enforce safe bounds if numeric clients are unavoidable, append adjustment entries instead of mutating value records, and deny UPDATE/DELETE through DB roles/triggers.

## Folios, payments, cashiering, and POS

Requirement: balanced folios, split/transfer/reversal, idempotent payments/refunds, controlled cashier/void variance.  
Status/severity: **PASS locally, UNVERIFIED on production database/providers**.  
Evidence: financial-invariants.test.mjs, gateway.test.mjs, pos-approvals.test.mjs, and the fresh e2e suite pass. Transactional services and approval flows are substantive.  
Impact: local correctness is valuable but does not prove PostgreSQL lock ordering, provider races, or multi-instance behavior.  
Remediation: repeat the same invariants under PostgreSQL with concurrent requests, webhook/verify races, provider timeouts, duplicate deliveries, and reconciliation imports.

## Night audit

Requirement: one atomic run per property/business date; comprehensive blockers; idempotent posting; snapshots; advance only after success.  
Status/severity: **PARTIAL — P1 F-009/F-010**.  
Evidence: NightAuditRun unique propertyId/businessDate, transaction-wrapped charge posting and date advance, and night-audit tests pass. Preflight covers completed run, open shifts, open/void-pending POS, and warnings for due-out/unarrived. It omits specified negative-folio, occupancy/stay, room-move, unposted-charge, and payment/reconciliation exceptions. Snapshots use Number conversions.  
Impact: a day can be closed with unresolved operational/financial anomalies and oversized totals can round.  
Remediation: implement complete blocker queries, distinguish non-waivable finance blockers, preserve exact minor units, snapshot opening/closing evidence, and test rollback after every phase failure.

## Backup, restore, and migration operations

Requirement: encrypted automated PostgreSQL and object-storage recovery with measured RPO/RTO and restore drills.  
Status/severity: **UNVERIFIED — P1 F-001/F-007/F-012**.  
Evidence: backup/restore scripts and operations documentation exist, but no production-shaped PostgreSQL/R2 target, artifact, schedule, checksum record, or successful drill evidence was available.  
Impact: recoverability cannot be claimed.  
Remediation: configure managed PITR, encrypted logical backups, R2 version/retention strategy, quarterly isolated restore drills, and signed evidence with RPO/RTO results.

