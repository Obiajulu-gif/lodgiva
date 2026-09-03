# Security and tenancy audit

## Tenant and property isolation

Requirement: §6.2 requires tenantId/propertyId ownership, tenant context from verified identity, scoped repositories, PostgreSQL RLS, and negative isolation tests.  
Status/severity: **PARTIAL — P1 F-002; P2 F-030**.  
Evidence: AuthGuard rejects incomplete/purpose tokens and services normally filter auth.tenantId. identity.test.mjs, hardening.test.mjs, and e2e.mjs exercise cross-tenant/property denials. schema.prisma has tenant keys on most roots. However, there are no RLS migrations/policies or scoped repositories; Prisma is directly available in each service, and selected child/event models depend on relation traversal for property ownership.  
Business impact: tested paths are isolated, but defense in depth is absent and a future missing predicate can expose guest or financial data.  
Remediation: PostgreSQL RLS, SET LOCAL tenant/property context in transactions, restricted DB roles, scoped repositories, static query rules, and direct SQL/RLS bypass tests.

## Authentication and session lifecycle

Requirement: §6.3 requires secure short access tokens, rotating refresh tokens, session/device control, immediate account/suspension enforcement, and safe browser handling.  
Status/severity: **PARTIAL — P1 F-004/F-005; P2 F-016; F-003 FIXED**.  
Evidence: AuthService uses Argon2, 15-minute JWTs, SHA-256 refresh hashes, rotation, session listing/revocation, and login throttling. AuthGuard validates signature and required claims but never checks session, current User/Membership/Tenant status, or security version. The access token has no session identifier. dashboard api.ts stores both tokens in localStorage. Password-reset routes are absent.  
Impact: XSS can exfiltrate refresh authority; revoked/suspended/demoted users retain access until token expiry; account recovery is operationally incomplete.  
Remediation: secure HttpOnly refresh cookie/family with reuse detection, in-memory access tokens, per-request cached session/security-version validation, tenant suspension enforcement, password reset with one-time expiring hashed tokens, and related tests.

## MFA

Requirement: privileged-role MFA with protected secrets and one-time recovery codes.  
Status/severity: **PARTIAL — P1 F-006**.  
Evidence: MFA enrollment/verification/removal and policy enforcement exist; recovery codes are Argon2 hashes and replay tests pass. User.mfaSecret is stored as plaintext and used directly by AuthService.  
Impact: a database disclosure defeats the second factor for enrolled users.  
Remediation: KMS envelope encryption, ciphertext key version, narrow decrypt permission, audit access, and forced re-enrollment/rotation plan.

## Authorization

Requirement: centralized least-privilege RBAC and property scope.  
Status/severity: **PASS for implemented routes**.  
Evidence: common/permissions.ts and PermissionsGuard; controller decorators; identity/property-config/hardening tests. Property services assert allowed property IDs.  
Impact: current local negative tests did not reveal an IDOR/cross-tenant bypass. This is not proof against untested routes or direct DB access.  
Remediation: preserve route inventory tests, require an authorization test for every new operation, review broad grants such as inventory.manage for FRONT_DESK, and add RLS.

## Secrets, configuration, CORS, and headers

Requirement: fail-closed production config, strong secrets, exact origins, security headers, and no secret leakage.  
Status/severity: **PARTIAL — F-003 FIXED for current startup controls; P2 F-015; P3 F-036**.  
Evidence: runtime-config.ts now runs before development defaults and rejects SQLite/non-PostgreSQL URLs, default/short JWT and storage secrets, absent/wildcard/non-exact HTTPS CORS origins, and non-HTTPS storage URLs in production; five tests pass. Helmet/CSP/HSTS and route/global throttles pass e2e checks. .env.example remains duplicated/inaccurate, rate limits remain local, and remote storage is still absent under F-007.  
Impact: the known unsafe configuration now fails before listening. Per-process rate limits still reset and split across instances, and this guard cannot substitute for missing infrastructure.  
Remediation: extend typed startup validation with every new required adapter, use managed secrets/exact allowlists, add shared Redis rate limits/WAF, and rehearse rotation.

## Dependency and supply-chain posture

Requirement: supported patched dependencies and CI security gate.  
Status/severity: **FAIL — P1 F-011**.  
Evidence: pnpm audit --prod on 2 August 2026 reports six high and one moderate advisory: sharp/libvips, PostCSS, find-my-way, js-yaml, and React Router paths. pnpm install also reports ignored native build scripts. No CI workflow or lockfile audit gate exists.  
Impact: denial of service and content/tooling disclosure risks remain in shipped dependency paths.  
Remediation: upgrade to patched versions, verify native artifact provenance/build policy, run regression tests, produce an SBOM, and gate CI on reviewed production advisories.

## Audit trail and data protection

Requirement: immutable actor/property/correlation audit trail, retention/minimization, protected files.  
Status/severity: **PARTIAL — P2 F-031; P1 F-007**.  
Evidence: AuditService writes structured AuditEvent records and guest ID metadata is minimized to type/last4/expiry. Database permissions/triggers do not make audit/folio rows append-only, correlation IDs are incomplete, and private files use local disk.  
Impact: privileged application/database access can alter history; regulated guest documents lack a production retention/storage boundary.  
Remediation: append-only DB role/triggers, integrity verification/export, correlation coverage, R2 private bucket policies, malware scanning, retention/deletion jobs, and access logging.
