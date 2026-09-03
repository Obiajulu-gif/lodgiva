# Payments and integrations audit

## Provider architecture

Requirement: §8 payment providers behind a common interface; server-to-server initialize/verify/refund; webhook confirmation is authoritative; explicit sandbox/live mode.  
Status/severity: **PARTIAL — P1 F-013**.  
Evidence: common/payment-providers.ts defines PaymentProvider and concrete PaystackProvider/FlutterwaveProvider. PAYMENTS_MODE must explicitly be live. Live branches call Paystack initialize/verify/refund APIs and Flutterwave v3 payment/verify/refund APIs; sandbox branches state that they cannot verify or refund. GatewayService exposes intent/status/webhook/refund/reconciliation workflows.  
Business impact: architecture is credible, but no connected-provider evidence supports real-money claims.  
Technical impact: provider response/version changes, TLS/network failures, authentication scopes, and reconciliation differences were not exercised.  
Remediation: run official provider sandboxes with restricted credentials, record request/response contracts and webhook endpoints, test timeouts/retries, obtain finance sign-off, and keep PAYMENTS_MODE=sandbox until complete.

## Webhook authenticity and idempotency

Requirement: raw-body signature verification before state change, durable deduplication, transaction-safe webhook/verify race handling, and immutable delivery history.  
Status/severity: **PASS locally; external behavior UNVERIFIED**.  
Evidence: main.ts preserves raw JSON; Paystack uses HMAC-SHA512 with x-paystack-signature; Flutterwave compares verif-hash; WebhookEvent has provider/externalId uniqueness and records rejected deliveries; GatewayService handles duplicate create conflicts and payment intent finalization. Payment signature unit tests and gateway integration/e2e replay tests pass.  
Impact: forged/replayed local fixtures are rejected, but actual provider headers/payload evolution is not certified.  
Remediation: capture redacted sandbox fixtures from both providers, test reordered/duplicate/delayed events, version parsers, and alert on invalid-signature spikes.

## Refunds, settlements, and reconciliation

Requirement: controlled refunds, idempotency, settlement import, discrepancy workflow, audit trail, and no browser-trusted success.  
Status/severity: **PARTIAL — P1 F-013/F-008**.  
Evidence: Refund, Settlement, SettlementLine, and ReconciliationException models; refund approval/execution code; settlement CSV parsers/tests; gateway integration and e2e workflows. Live provider execution was not tested and outbox/worker delivery is not durable.  
Business impact: finance controls are visible locally, but actual provider settlement parity and recovery from ambiguous outcomes are unknown.  
Remediation: provider sandbox refund/settlement drills, explicit idempotency keys for outbound calls, ambiguous-result reconciliation runbook, maker-checker roles, and accounting sign-off.

## Notifications

Requirement: durable email/SMS/WhatsApp/push delivery with template/version, consent, retries, receipts, and observability.  
Status/severity: **MOCK_ONLY/PARTIAL — P2 F-017; P1 F-008**.  
Evidence: worker logs reservation/payment/night-audit email/SMS intentions. Only Web Push has a real optional adapter when VAPID keys exist. No Resend/Termii/WhatsApp dependency, provider delivery receipt, template store, consent check, or DLQ is present.  
Business impact: guests and staff will not reliably receive confirmations, invoices, receipts, or operational alerts.  
Remediation: implement provider adapters with consent/channel preference, versioned templates, idempotent delivery, provider receipt webhooks, retry/DLQ, and synthetic monitoring.

## File and observability integrations

Requirement: R2 object storage and verified Sentry/OTLP delivery.  
Status/severity: **MOCK_ONLY/UNVERIFIED — P1 F-007; P2 F-027**.  
Evidence: storage.ts always selects LocalStorageAdapter. telemetry.ts can issue OTLP HTTP requests and documents that no real collector/Sentry delivery is proven; package dependencies do not include a Sentry SDK.  
Impact: protected artifacts are not durable and operators cannot assume traces/errors reach a backend.  
Remediation: implement R2 and selected telemetry provider adapters, then prove them with canary upload/download/delete and trace/error receipt tests.

## Environment correctness

Requirement: exact consumed environment names, secret ownership, rotation, and per-environment webhook/base URLs.  
Status/severity: **PARTIAL — F-003 FIXED; P1 F-013; P3 F-036**.  
Evidence: process.env call-site inventory; .env.example duplicates Paystack/Flutterwave keys, includes PAYSTACK_WEBHOOK_SECRET which code does not read, omits critical controls, and advertises R2 takeover that is not implemented. runtime-config.ts now rejects the previously unsafe production defaults.  
Impact: startup is safer, but operators can still configure unused integration variables and mistakenly assume an adapter exists.  
Remediation: use .env.production.example and docs/DEPLOYMENT_ENVIRONMENT_GUIDE.md as the contract, extend validation as adapters land, and keep provider secrets in managed stores only.
