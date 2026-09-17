# Lodgiva verification record

What was actually executed, in which environment, and what remains unverified.
No secrets, connection strings or tokens appear here.

Cycle date: 2026-09-09. Baseline: `1587c53` plus uncommitted work.

---

## Environment classes

| Class | Meaning | Used for |
| --- | --- | --- |
| **A — pure** | No database. Stubbed inputs. | Unit tests, type checks, builds |
| **B — isolated PostgreSQL** | Disposable database, restricted app role | **Unavailable this cycle — see blocker** |
| **C — production Neon** | The live database | Not used for testing this cycle |
| **D — deployed app** | `lodgiva.vercel.app` | Browser checks recorded below, all from an earlier session |

---

## Executed and passing (class A)

```bash
pnpm --filter @lodgiva/api exec tsc -p tsconfig.json
```
→ exit 0, no diagnostics.

```bash
pnpm --filter @lodgiva/api run test:unit
```
→ `ℹ tests 146  ℹ pass 146  ℹ fail 0`

Includes the two suites added this cycle:

| Suite | Covers |
| --- | --- |
| `test/unit/tax.test.mjs` (7) | The brief's inclusive fixture, compounding, rule versioning, zero rate, rounding boundaries |
| `test/unit/permissions.test.mjs` (updated) | Every role that can book can complete the stay; owner still cannot self-close a cash drawer |

```bash
pnpm --filter lodgiva exec tsc --noEmit -p tsconfig.json
```
→ exit 0.

### The fixture the brief specifies

Input `10750000` kobo, one inclusive 750-basis-point rule:

| Field | Required | Actual |
| --- | --- | --- |
| total | `10750000` | `10750000` ✓ |
| base | `10000000` | `10000000` ✓ |
| included tax | `750000` | `750000` ✓ |

---

## Executed in an earlier session (class C/D) — recorded, not re-run

These predate the isolated-database rule in the current brief and were run
against production Neon and the deployed app. They are evidence that the
behaviour worked at the time; they are **not** a substitute for class B runs.

| Check | Result |
| --- | --- |
| Checkout refusal keeps the stayed night on the folio | before `0` → refusal `409` demanding `5248687` → after `5248687`; retry did not double-charge; after payment checkout returned `201` |
| Owner can complete a stay in the browser | check-in → room 201 → charge ₦5,000 + ₦250 service + ₦393.75 VAT → payment → balance ₦0.00 |
| Guests page | list, search, open profile, edit, save, restore — all persisted |
| Settings page | property profile, 4 room types, 20 rooms, tabs all render |
| Housekeeping board | renders with honest empty states |

---

## Blocked

### B-00 · The host itself is the blocker — diagnosed 2026-09-17

WSL2 and Docker both fail for the same underlying reason, which is why the
isolated database (B-01) and the Frappe bench for the Kamra evaluation are
blocked together.

| Measurement | Value |
| --- | --- |
| C: free space | **0.21 GB** of 476.6 GB (before cleanup) |
| RAM free | **0.1 GB** of 7.7 GB |
| `.wslconfig` asked for | `memory=5632MB`, `swap=8GB` |
| WSL error | `CreateInstance/CreateVm/0x800705b4` (timeout), once `ConfigureNetworking/E_UNEXPECTED` |
| Windows build | 10.0.22000.2538 (Windows 11 21H2) |
| WSL version | 2.7.13.0 |
| Virtualization present | Yes (`HypervisorPresent: True`) |

A VM cannot allocate 5.5 GB of RAM when 0.1 GB is free, nor create an 8 GB
swap file on a disk with 0.21 GB free. Docker Desktop runs on WSL2, so it
failed for the same reason.

**Actions taken:**

- Cleared npm, Yarn and user temp caches; pruned the pnpm store.
  **0.21 GB → 3.51 GB free.** No project files or `node_modules` touched.
- Rewrote `~/.wslconfig` to `memory=3GB`, `processors=2`, `swap=2GB`, with
  `sparseVhd=true`. Original saved as `.wslconfig.backup-20260917`.

**Result: WSL still times out.** Resource exhaustion was real and had to be
fixed, but it was not the whole cause.

**Remaining cause — a pending reboot.**
`HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\PendingFileRenameOperations`
is set, and the host has been up 6.2 days. A staged file-rename means an
update is waiting for a restart to complete; given `wsl --update` then hung
with no output for several minutes (the process was stopped), the staged
update is plausibly the WSL platform itself. `LxssManager` was also found
stopped.

**Next step: restart the host.** That is not something to do from a coding
session — it would close the browsers and editor along with any unsaved work,
so it is the user's call. Afterwards:

```bash
wsl --update
wsl -d Ubuntu-24.04 --exec /bin/echo ok
```

If that echoes, both blocked workstreams open up at once: the Kamra vertical
slice (ADR-001 option B) and the isolated PostgreSQL harness (B-01/B-02).

**One caveat for the bench.** Even repaired, this host is tight for Frappe:
7.7 GB RAM with Chrome and the editor already using ~3 GB, and 3.4 GB of disk
free after cleanup. A Frappe bench plus MariaDB, Redis and a Node asset build
wants more than that. Expect to free more space, or run the evaluation bench
on a small cloud VM instead — which is also closer to how it would be
deployed.

### B-01 · No isolated PostgreSQL (blocks all integration and E2E)

**Attempted:**

```bash
docker run -d --name lodgiva-test-pg -e POSTGRES_PASSWORD=… -p 55432:5432 postgres:16-alpine
```
→ `failed to connect to the docker API … dockerDesktopLinuxEngine`

Docker Desktop was launched and polled for 120 s; the daemon never became
ready. `psql` is not on PATH and nothing listens on 5432.

**Consequence — stated plainly:** none of the access-control fixes (L-01,
L-04) have been proven at runtime. They are verified by reading the code and
by type checking only. Specifically **not** demonstrated:

- a housekeeper receiving 403 from `POST /folios/:id/charges`
- property-A staff receiving 404 for a property-B folio
- the restricted application role being non-superuser and non-`BYPASSRLS`
- tenant context behaviour across a pooled connection

**To unblock:** start Docker Desktop, then

```bash
docker run -d --name lodgiva-test-pg -e POSTGRES_PASSWORD=testonly -e POSTGRES_DB=lodgiva_test -p 55432:5432 postgres:16-alpine
```

then point `DATABASE_URL`/`DIRECT_URL` at `localhost:55432`, run
`pnpm --filter @lodgiva/database run migrate`, and fix B-02 before
`pnpm test:e2e` will run at all.

### B-02 · `test:e2e` cannot target PostgreSQL

`packages/database/src/reset.js:10` rejects any URL that does not start with
`file:`, but PostgreSQL is the only provider the schema supports. The guard's
intent is right — it stops a reset against a shared database — but the
condition is stale. It needs to accept an explicitly named disposable
PostgreSQL target and keep refusing anything else. **Not changed this cycle:**
loosening a safety guard without an isolated database to point it at is how a
production reset happens.

### B-03 · No R2 credentials

`assertSafeProductionEnvironment()` requires an R2 bucket pair in production.
No credentials exist locally or on Vercel. Document upload, export download
and receipt storage cannot be verified end to end.

### B-04 · No payment provider sandbox configured

`PAYSTACK_SECRET_KEY` and `PAYSTACK_WEBHOOK_SECRET` are unset. Webhook
signature verification is implemented and unit-testable, but no real provider
event has been exchanged. Removing the fake CARD path (L-02) means card
collection is now **correctly unavailable** rather than fraudulently
available — it is not "working".

---

## Not claimed

- No integration or E2E suite was run this cycle.
- No performance measurement was taken.
- No deployment was made this cycle.
- No provider, delivery or refund was exercised against a real or sandbox
  account.
- The 20 newly decorated routes are not covered by an automated
  authorisation test yet (L-07).
