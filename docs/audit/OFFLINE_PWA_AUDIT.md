# Offline and PWA audit

## App shell and caching

Requirement: §10.1-10.2 installable PWA, app-shell precache, narrow operational cache, stale labeling, and an absolute prohibition on stale money data.  
Status/severity: **PASS for implemented policy; browser behavior UNVERIFIED — P2 F-025**.  
Evidence: apps/dashboard-web/vite.config.ts configures generateSW, manifest, auto-update, app-shell precache, no runtime API cache, and a push worker import. cache.ts uses IndexedDB and an explicit allowlist; folios/payments/invoices/reports/cashiering/gateway/settlements are denylisted. Dashboard tests pass 5/5. Production build emits sw.js and precaches seven assets. api.ts labels cached data through stalenessFor.  
Business impact: the code avoids the most dangerous offline failure—showing stale balances as current.  
Technical limitation: no Playwright/device evidence proves installation, upgrade, stale UI rendering, eviction behavior, or service-worker recovery.  
Remediation: add real-browser PWA install/update/offline tests and UX review on supported mobile hardware.

## Offline mutation allowlist and server reconciliation

Requirement: §10.3-10.4 only explicitly safe writes may queue; operations need stable IDs, base versions, idempotent replay, conflict/rejection detail, and server change cursors.  
Status/severity: **PARTIAL — P2 F-020**.  
Evidence: offline.ts limits entityType to housekeepingTask, maintenanceTicket, and room; operationId/deviceId/baseVersion/occurredAt are sent to SyncService. sync-live tests and e2e tests exercise apply, duplicate replay, conflict, rejection, and server changes. Financial writes are not queued.  
Business impact: a disconnected housekeeper can perform a narrow safe subset, but client-side loss/race behavior is not production-hardened.  
Technical impact: queue and cursor use localStorage; device IDs use Math.random; a module-local flushing flag does not coordinate tabs; all queued records are cleared after any successful response and depend on server response completeness; quota/write failures and queue schema upgrades are not handled.  
Remediation: move a versioned encrypted/sensitive-minimized queue to IndexedDB, use crypto.randomUUID, acquire a BroadcastChannel/Web Locks lease, remove only explicitly acknowledged operation IDs, handle quota/corruption, and expose per-operation retry/conflict UX.

## Sync and conflict policy

Requirement: conflict handling must be deterministic, visible, and never silently overwrite a newer server record.  
Status/severity: **PARTIAL — P2 F-020**.  
Evidence: baseVersion is optional in the client type and SyncService returns APPLIED/CONFLICT/REJECTED outcomes. Conflicts leave the local queue after acknowledgment and are surfaced through callback/UI state rather than retried blindly.  
Impact: tested conflicts are explicit, but optional versions and limited durable conflict history can make support diagnosis difficult.  
Remediation: require versions for update actions, persist conflict details until user resolution, define field/entity merge policy, and audit accepted conflict decisions.

## Multi-user and realtime interaction

Requirement: reconnect and realtime hints must prompt authoritative refetch without leaking credentials or assuming one server instance.  
Status/severity: **PARTIAL — P2 F-018/F-020**.  
Evidence: dashboard starts periodic/online sync and EventSource change hints. The EventSource access token is in the URL query and server fanout is process-local. No tab leader election exists.  
Impact: multiple tabs can race flushes and create excess streams; URL tokens can appear in infrastructure logs.  
Remediation: tab coordination, same-origin authenticated stream/token exchange, Redis event fanout, reconnect cursor, and integration tests across two instances/tabs.

## Storage budget, privacy, and logout

Requirement: bounded device storage, cache/queue lifecycle on logout/tenant switch, and no protected financial content in caches.  
Status/severity: **PARTIAL — P2 F-020**.  
Evidence: financial paths are denied, but queue/cache entries are not visibly namespaced by tenant/user and api.ts setSession(null) does not itself clear IndexedDB/offline keys. No storage estimate/eviction policy exists.  
Impact: shared devices can retain operational data or queued actions across sessions unless surrounding UI cleanup is perfect.  
Remediation: namespace and encrypt/minimize local data, atomically clear it on logout/tenant change, set TTL/size ceilings, use navigator.storage estimates, and test shared-device handoff.

