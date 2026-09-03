# Business workflow audit

This report distinguishes implemented local behavior from production/provider verification. Route existence alone was not counted as completion.

## Reservations and commercial controls

Requirement: §7.1 availability pricing, holds, restrictions, reservations, cancellation/no-show, room allocations, group bookings, packages/promotions, and revenue controls.  
Status/severity: **PASS for core individual reservations; PARTIAL — P2 F-028 for advanced commercial scope**.  
Evidence: BookingService and ReservationsService; RoomNightAllocation/Hold/RateRestriction/RatePlan/DailyRate models; booking.test.mjs, reservation-lifecycle.test.mjs, restrictions unit tests, and e2e workflow. Holds, overlapping inventory, state transitions, cancellations/no-show, extensions, and room moves are exercised. No substantive group-booking, package, promotion, channel-management, forecast, or revenue-optimization aggregate was found.  
Business impact: a property can demo/run basic direct reservations locally, but larger/group/commercial operations require spreadsheets or manual workarounds.  
Remediation: agree launch scope; implement group master/allotment/rooming list, promotion/package rules, channel/rate governance, and acceptance tests before claiming those capabilities.

## Front desk and guest profiles

Requirement: §7.2 arrivals, registration/check-in, room assignment/move, extensions, early/late departure handling, no-show, checkout, guest merge/blacklist/consent/minimized IDs.  
Status/severity: **PASS for core stay flow; PARTIAL for supporting policy detail**.  
Evidence: front-desk.module.ts, guests.module.ts, Guest/GuestMergeLog schema, identity and e2e tests. Guest ID stores type/last four/expiry rather than full identifier; merge and blacklist fields exist. Core check-in/move/extend/checkout/no-show flows pass. Dedicated late-checkout/early-departure charging rules and rich registration-card/consent history are not fully evidenced.  
Impact: core reception flow is usable locally; policy-dependent exceptions may be handled inconsistently.  
Remediation: define property policies as versioned rules, retain consent events rather than a single timestamp, and add exception UAT.

## Folios, invoices, payments, cashiering, and POS

Requirement: §7.3/§7.6 controlled posting, splitting/transfers, reversal rather than deletion, invoice sequence, tender/refund, shift/variance approval, POS-to-room, and void approval.  
Status/severity: **PASS locally; production integrity remains blocked by F-001/F-008/F-010/F-013**.  
Evidence: folios, invoices, payments, gateway, cashiering, POS, approvals modules; financial-invariants, gateway, POS approvals, and full e2e tests. Invoice sequencing and PDF generation, manual payments, POS folio posting, shift close, variance approval, and void approval are exercised.  
Impact: this is the strongest implemented business area, but SQLite/single-worker/synthetic-provider evidence cannot support live-money release.  
Remediation: repeat on PostgreSQL under concurrency, certify provider flows, enforce append-only DB controls, and preserve exact integer serialization.

## Night audit

Requirement: §7.4 complete preflight, room/tax posting, snapshots, reports, idempotency, and atomic business-date advance.  
Status/severity: **PARTIAL — P1 F-009**.  
Evidence: night-audit.module.ts and night-audit integration/e2e tests. Atomic run, duplicate guard, charge posting, snapshot, and date advance are present. Preflight does not implement the complete anomaly list; overdue departures and unarrived bookings are waivable warnings.  
Impact: management may close a business day over unresolved balances or inconsistent occupancy/payment state.  
Remediation: add all required blockers with drill-down links, a supervisor acknowledgement record only for approved warnings, and rollback/failure-injection tests.

## Housekeeping

Requirement: §7.5 room/task board, assignment/status/inspection, discrepancy, minibar/linen, lost-and-found, productivity and push.  
Status/severity: **PARTIAL — P2 F-017/F-028**.  
Evidence: housekeeping.module.ts, HousekeepingTask and assignment push outbox event, dashboard Housekeeping page, e2e tests. Task assignment/status/priority and optional Web Push exist. Lost-and-found, linen/minibar workflows, richer inspections/discrepancies, and productivity depth are not evidenced.  
Impact: basic room turnover works; supporting controls and notifications are incomplete.  
Remediation: deliver the missing aggregates or explicitly remove them from launch claims, then test mobile/offline workflows on real devices.

## Maintenance

Requirement: §7.7 tickets, assets, preventive schedules, parts/cost, downtime and SLA.  
Status/severity: **PARTIAL — P2 F-028**.  
Evidence: maintenance.module.ts, MaintenanceTicket schema, dashboard page, e2e ticket flow. No asset register, preventive schedule/work order, parts usage, or comprehensive downtime/SLA model was found.  
Impact: reactive tickets work, but preventive engineering and asset-cost control do not.  
Remediation: add Asset, MaintenancePlan, WorkOrder, PartUsage, downtime and escalation models/workflows.

## Inventory and procurement

Requirement: §7.8 items, stores, stock movement, counts/variance, suppliers, purchase orders, receipts/returns, recipes/reorder.  
Status/severity: **PARTIAL — P2 F-028**.  
Evidence: inventory.module.ts; InventoryItem, StockLocation, StockMovement; inventory report tests. Items/locations/movements and analytics are substantive. Suppliers, purchase requisitions/orders, goods receipt/return, stock count/approval, recipe depletion, and reorder workflow are absent.  
Impact: inventory can be observed but not controlled through an auditable procurement lifecycle.  
Remediation: implement maker-checker procurement and count/variance flows with append-only movements and PostgreSQL concurrency tests.

## Accounting, reporting, and regulatory scope

Requirement: §7.9 operational/statutory reports, accounting export/integration, Nigerian tax/e-invoicing requirements.  
Status/severity: **PARTIAL — P2 F-028**.  
Evidence: reports/analytics/invoices/tax services, CSV/PDF unit tests, export jobs and e2e report exports. No general ledger/subledger integration, e-invoice authority connector, chart-of-accounts mapping, or certified statutory workflow was found.  
Impact: operational reports are demo-ready, not a complete finance/compliance system.  
Remediation: obtain Nigerian finance/legal acceptance criteria, define source-of-truth boundaries with accounting software, and certify tax/e-invoice exports/integrations.

## Platform lifecycle

Requirement: tenant onboarding, plans/trials, subscriptions, entitlements, suspension/reactivation, feature rollout.  
Status/severity: **PARTIAL/FAIL — P2 F-014**.  
Evidence: AdminService can bootstrap a tenant/property and PlatformModule provides MFA policy and feature flags. Tenant.status exists, but AuthGuard does not enforce it; no subscription, billing, plan, or entitlement aggregate exists.  
Impact: the application cannot safely operate as a multi-tenant SaaS commercial platform.  
Remediation: implement plan/entitlement/billing lifecycle, hard suspension across auth/jobs/files, grace-period policy, reactivation, and audited support tooling.

