# Architecture audit

## Conclusion

The implementation is a modular NestJS monolith with meaningful modules, not a set of controller stubs. It is nevertheless a local-first prototype architecture. The specified production data, tenancy, asynchronous work, and deployment boundaries are not present.

## Runtime and workspace

Requirement: §3 Node 24, pnpm/Turbo, Next 16 marketing, Vite 8 PWA, Nest 11 Fastify API, dedicated worker, and shared packages.  
Status/severity: **PARTIAL — P2 F-022; P3 F-032/F-035**.  
Evidence: root package.json and turbo.json; apps/marketing-web/package.json (Next 15), apps/dashboard-web/package.json (Vite 6), apps/api/package.json (Nest 11/Fastify), apps/worker/package.json (start only). The production build reports four build tasks; worker and api-client have no build task.  
Impact: application compilation is credible, but architectural contracts and worker release safety can drift outside CI. Marketing currently prerenders all routes, yet no explicit static-export contract exists.  
Remediation: add build/test/lint/typecheck for every deployable, shared contract/config/auth/observability packages, and either upgrade versions or record approved deviations.

## Module boundaries and persistence

Requirement: §4 modules must preserve controller/application/domain/infrastructure boundaries; Prisma must sit behind repositories/UoW that force tenant scope.  
Status/severity: **PARTIAL — P1 F-002; P2 F-022**.  
Evidence: controllers generally delegate to services in apps/api/src/modules, but services directly inject PrismaService and construct where clauses. AuditService can participate in a caller transaction, which is good; there is no central scoped repository or transaction tenant context.  
Business impact: a future ordinary query omission can become a data breach despite existing negative endpoint tests.  
Technical impact: domain logic, authorization, and persistence are coupled; a PostgreSQL/RLS migration will be more expensive.  
Remediation: establish request/transaction tenant context, scoped repositories, UoW boundaries for money/inventory/night audit, and forbid raw unscoped clients outside infrastructure code.

## Eventing and worker

Requirement: §9.3 transactional outbox, durable Redis/BullMQ work, idempotent consumers, retries/dead-letter, observable delivery.  
Status/severity: **FAIL — P1 F-008; P2 F-019**.  
Evidence: AuditService.emit writes OutboxEvent in caller transactions. apps/worker/src/main.js reads publishedAt:null rows and sends before updating the row. It has no claim token, lock, next-attempt time, max attempts, DLQ, correlation ID, property ID, actor envelope, or consumer receipt.  
Impact: two workers or a crash after a provider call can duplicate delivery; poison events poll forever; incidents cannot be correlated reliably.  
Remediation: use BullMQ or an atomic PostgreSQL SKIP LOCKED lease, persist consumer idempotency receipts, exponential backoff/DLQ, enriched event envelopes, and concurrency/crash tests.

## Realtime architecture

Requirement: scalable authenticated operational change hints without treating realtime as authoritative state.  
Status/severity: **PARTIAL — P2 F-018**.  
Evidence: EventsController.stream uses EventSource with token query parameter and process-local polling/fanout; dashboard App.tsx opens /events/stream?token=.  
Impact: tokens can enter logs/history, and clients on different instances do not share a reliable event bus. Long-lived SSE is a poor fit for serverless functions.  
Remediation: use a secure same-origin session/token exchange, Redis pub/sub or durable broker, reconnect cursors, and deploy it on a long-running API runtime.

## API contracts

Requirement: §9.1 one generated, typed API contract consumed by clients.  
Status/severity: **PARTIAL — P2 F-021; P3 F-033**.  
Evidence: OpenAPI regeneration produces 155 paths/184 operations; the checked-in artifacts changed and the generated client typechecks. Zod request DTOs are absent from the OpenAPI document, so bodies are unknown. dashboard-web/src/api.ts is independent.  
Impact: frontend and backend can disagree at compile time, and stale generated files can mislead integrators.  
Remediation: generate OpenAPI schemas from shared contracts, enforce no-diff generation in CI, and use the package client in both web apps.

## Architectural deviations that require explicit ADRs

- SQLite instead of PostgreSQL/RLS is not a production-equivalent substitute.
- Direct outbox polling instead of Redis/BullMQ is acceptable only for a single-process local demo.
- SSE may be acceptable in place of WebSockets if its authentication, fanout, and runtime are productionized.
- Next/Vite version deviations may be acceptable after compatibility and security review.
- Local signed storage is useful test infrastructure, not an R2 implementation.

References such as ADR-LOCAL-001, ADR-LOCAL-002, and ADR-009 occur in source, but no authoritative ADR directory exists (P3 F-037).

