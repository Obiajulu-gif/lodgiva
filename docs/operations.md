# Lodgiva operations

Runbooks, edge configuration, service levels and the production checklist.

Everything here has been run against the local stack unless a line says
otherwise. Where something is **untested in this environment**, it says so in
those words — an ops document that quietly mixes verified steps with plausible
ones is worse than no document, because it is trusted at 3am.

---

## 1. Service levels

| Indicator | Objective | How it is measured |
| --- | --- | --- |
| Availability | 99.5% of requests non-5xx, monthly | `lodgiva_slo_availability_ratio`, from `RequestMetric` |
| Latency | 99% of requests inside `SLO_LATENCY_MS` (default 500ms) | `lodgiva_slo_latency_ratio` |
| Night audit | Completes before 06:00 local, every property, every day | `NightAuditRun.completedAt` |
| Booking write | Availability search + hold under 2s at p95 | `scripts/load-test.mjs --scenario search` |
| Backup | A restore drill passes weekly | `scripts/restore.mjs --drill` exit code |

**A 5xx counts as a latency breach regardless of how fast it was.** A fast
failure is still a failure, and an availability SLI that ignores it reports a
healthy service while nothing works.

**An empty window reports `null`, not 100%.** No traffic is not the same as no
failures. A dashboard that shows green for a dead service is worse than one
that shows nothing.

`GET /observability/service-level?windowMinutes=60` returns both SLIs plus the
ten slowest routes. `GET /metrics` is the Prometheus scrape.

### Alert thresholds

| Alert | Condition | Why this number |
| --- | --- | --- |
| `LodgivaAvailabilityBurn` | availability ratio < 0.99 for 10 min | Burns a 99.5% monthly budget in about two days if sustained |
| `LodgivaLatencyBurn` | latency ratio < 0.95 for 15 min | Front desk feels this before a guest does |
| `LodgivaNightAuditLate` | no `COMPLETED` run by 06:00 | The day cannot close; rates and reports go stale |
| `LodgivaPendingVoids` | POS voids pending > 2h | Revenue in limbo, and the night audit will block |
| `LodgivaBackupStale` | no successful backup in 26h | Daily job has silently stopped |
| `LodgivaWebhookFailures` | reconciliation exceptions rising | Payments confirmed by the provider are not landing |

---

## 2. Web application firewall

Lodgiva does not ship a WAF. It expects one in front (Cloudflare, AWS WAF, or
nginx + ModSecurity). The application-level controls below already exist; the
edge rules are what stop what an application cannot see.

### Rules that must exist

| Rule | Why the app cannot do this itself |
| --- | --- |
| **Block `/api/v1/metrics` from the internet.** Allow only the scraper's source range. | The endpoint is public by design — a Prometheus scraper has no session. Route names and traffic volumes are reconnaissance. |
| **Rate limit `POST /api/v1/auth/*` per IP *and* per ASN.** | The in-process limiter is per instance and per IP. Credential stuffing arrives from thousands of addresses; only the edge sees the aggregate. |
| **Challenge (not block) requests with no `User-Agent` on `/api/v1/auth/login`.** | Legitimate clients always send one; blocking outright breaks the odd corporate proxy. |
| **Block request bodies over 1 MB except on `/files/*`.** | Uploads are presigned and go to the object store; nothing else needs a large body. |
| **Geo-restrict `/api/v1/admin/*` and `/api/v1/security-policy` to the operator's countries.** | Tenant-wide destructive configuration. Convenience is not worth the blast radius. |
| **Strip `X-Forwarded-For` from client input, then set it.** | Otherwise a caller forges their own IP and defeats every per-IP limit including the login one. |
| **Do not "protect" `/api/v1/gateway/webhooks/*` with a JS challenge.** | Providers are not browsers. Verify with the HMAC signature the app already checks; a challenge here silently breaks payment confirmation. |

Managed rule sets: enable the SQL-injection and XSS groups, but **run them in
count mode for a week first**. Guest names and folio notes contain apostrophes
and free text that generic rules flag, and a false positive here rejects a
legitimate check-in.

### Already handled in the application

- Security headers (CSP `default-src 'none'`, HSTS 1 year with subdomains,
  `X-Frame-Options`, `X-Content-Type-Options`) — asserted by
  `test/integration/hardening.test.mjs`.
- Per-account progressive lockout on failed logins.
- Per-route rate limit of 30/min on auth routes vs 600/min globally.
- Tenant scoping on every query, and a guard that rejects tokens missing the
  claims that scoping depends on.

---

## 3. Runbooks

### 3.1 API is down

1. `curl -sS $BASE/health/live` — process up? `curl -sS $BASE/health/ready` —
   database reachable?
2. If `ready` fails and `live` passes, it is the database. Go to 3.2.
3. Check the error rate: `GET /observability/service-level?windowMinutes=15`.
4. Look for a recent change: `GET /reports/audit-trail` and the flag audit
   entries (`flag.updated`). **Check flags before you check code** — a flag
   flip is the fastest thing to have changed and the fastest to undo.
5. Roll back the flag: `PUT /admin/feature-flags/{key}` with
   `{"enabled": false}`. Takes effect within 5 seconds; no redeploy.
6. If it is not a flag, roll back the deployment. Then read logs.

### 3.2 Database unreachable or slow

1. `node scripts/check-migrations.mjs` — a half-applied migration is a common
   cause after a deploy. `blocking` will name it.
2. If `FAILED_MIGRATIONS` is listed: **do not deploy on top of it.** Resolve
   with `prisma migrate resolve` and re-run the check.
3. If the database is up but slow, look for lock contention. On SQLite this is
   the single-writer lock (see §5); on PostgreSQL, `pg_stat_activity` for long
   transactions.
4. The API returns `503 RESOURCE_BUSY` with `retryable: true` for transient
   contention (`P2024`, `P2034`, `SQLITE_BUSY`). Clients back off on that; a
   flood of it means genuine contention, not a client bug.

### 3.3 Restore from backup

**Measured locally: a full restore of the development database took 916ms for
56 tables / 249 rows.** That number is meaningless at production scale — re-run
the drill against a production-sized copy before publishing an RTO.

```bash
node scripts/restore.mjs --drill
```

The drill backs up, restores to a scratch file, compares row counts table by
table, and exits non-zero on any mismatch. It prints both sides, so a silent
partial restore cannot pass as success.

To restore for real:

```bash
node scripts/restore.mjs --file backups/lodgiva-<stamp>.db --to ./restored.db
```

Restoring **over** the live database is refused unless `--force` is passed. The
most expensive way to lose a night's bookings is a restore typed into the wrong
terminal.

### 3.4 A guest says they were charged twice

1. `GET /support/lookup?q=<confirmation code | phone | surname>`
2. `GET /support/reservations/{id}` — the folio entries carry `reversalOfId`.
   A charge with a matching reversal was undone; the ledger is append-only, so
   both lines remain and that is correct, not a duplicate.
3. If there are genuinely two charges with no reversal, post a reversal — never
   edit or delete the entry.
4. If the second charge came from the payment gateway, check
   `GET /payments/reconciliation` for an exception on that reference.

### 3.5 Night audit will not run

`GET /night-audit/preflight?propertyId=…` lists blockers, each with the reason:

- `OPEN_CASHIER_SHIFTS` — close them; an open drawer means cash is unaccounted for.
- `OPEN_POS_ORDERS` — settle or void them; they would not be billed tonight.
- `POS_VOIDS_AWAITING_APPROVAL` — decide them. A void nobody decided is revenue
  in limbo, and rolling the date makes it yesterday's problem.
- `ALREADY_RUN` — the date is closed. Do not force it.

Warnings (due-outs still in house, unapproved variances) do not block, but the
run must acknowledge them explicitly.

### 3.6 Someone has lost their second factor

1. Have them use a recovery code at the MFA prompt. Each works once.
2. If they have none left, an account owner disables MFA for that user — this
   requires the **owner's** password, and is audited.
3. If tenant policy requires MFA for that role, the policy must be relaxed
   first (`PUT /security-policy`); the API refuses to leave a covered role
   without a factor.
4. Re-enrol immediately afterwards.

**There is no support-side bypass, deliberately.** A bypass is the attack.

### 3.7 Suspected credential compromise

1. `GET /auth/sessions` for the user, then `DELETE /auth/sessions` to revoke
   all refresh tokens. Access tokens expire within 15 minutes.
2. Force a password change.
3. `PUT /security-policy` adding their role to `mfaRequiredRoles`. The response
   states how many users will be prompted at next sign-in.
4. `GET /reports/audit-trail` filtered to their user id — every state change is
   there, including `support.lookup` if they used support tooling.

---

## 4. Production checklist

### Before the first deploy

- [ ] `DATABASE_URL` points at managed PostgreSQL with automated backups **and**
      point-in-time recovery. Change `provider` in `schema.prisma` to
      `postgresql`. No SQLite-only feature is used (ADR-LOCAL-001).
- [ ] `JWT_SECRET` is a 32+ byte random value, not the development default.
      The API falls back to a known string if unset — that fallback is for
      local work only.
- [ ] `CORS_ORIGINS` lists the real dashboard origins. Unset means allow-all.
- [ ] `RATE_LIMIT_MAX` and `RATE_LIMIT_AUTH_MAX` reviewed against expected
      staff count. The 30/min auth default assumes a property behind one NAT
      can put a shift through the login screen at 07:00.
- [ ] TLS terminated at the edge; HSTS is already sent by the app.
- [ ] WAF rules from §2 applied, managed rule sets in **count mode** first.
- [ ] `/api/v1/metrics` blocked from the internet.
- [ ] Storage: real S3-compatible credentials. The local filesystem adapter is
      development only.
- [ ] `PAYSTACK_SECRET_KEY` / provider credentials set; webhook URL registered.
- [ ] VAPID keys generated (`npx web-push generate-vapid-keys`) or push stays
      disabled — it reports `PUSH_DISABLED` rather than silently accepting.
- [ ] `SENTRY_DSN` and `OTEL_EXPORTER_OTLP_ENDPOINT` set. Confirm with
      `GET /observability/status`, which states which exporters are live.
- [ ] Backup job scheduled (`scripts/backup.mjs --verify`) and alerting on
      non-zero exit.
- [ ] Restore drill run against a production-sized copy; record the real RTO.

### Every deploy

- [ ] `node scripts/check-migrations.mjs --strict` exits 0.
- [ ] `pnpm --filter @lodgiva/api run test:unit` and `test:integration` pass.
- [ ] Backup taken immediately before migrating.
- [ ] Deploy the code that stops using a column **before** the migration that
      drops it. The check flags this as `DROP_COLUMN` under `--strict`.
- [ ] After deploy: `GET /observability/service-level?windowMinutes=15` — error
      rate at baseline.
- [ ] New behaviour behind a flag, default off, enabled for one tenant first.

---

## 5. Known limits of this environment

Stated plainly so nobody reads a local number as a production one.

- **The database here is SQLite.** Its single-writer lock dominates every
  concurrent measurement: in the mixed load test, `POST /holds` reached a p95
  of 9.5s at 20 concurrent clients while the same `/reports/daily-flash` route
  served a p50 of **20.5ms** when measured without concurrent writes. Those
  numbers describe SQLite, not the application. Re-measure on PostgreSQL.
- **No OTLP collector and no Sentry project exist here.** Spans are recorded
  and sampled in-process; nothing has been transmitted to a real backend. The
  payload builders are unit-testable and the wire formats are implemented, but
  **no span has ever been delivered to a collector from this environment**, and
  no event to Sentry.
- **No push notification has been delivered** — no VAPID keys.
- **No real payment gateway transaction has executed.** Webhook HMAC
  verification is genuine; outbound provider calls are stubbed.
- **Object storage is the local filesystem.** Exports and uploads are real
  files behind real signed URLs, but not in S3 or R2.
- **Only the marketing site is deployed.** The API and dashboard need a managed
  PostgreSQL connection string.
