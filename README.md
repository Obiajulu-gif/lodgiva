# Lodgiva 🏨

**Hotel management software built for Nigerian hotels, serviced apartments and hotel groups.**

Reservations, front desk, a tape chart, folios and VAT invoices in naira,
cashiering, night audit, housekeeping, a restaurant POS and a commission-free
booking page. It's designed around how Nigerian hotels actually run: bank
transfers and POS terminals as first-class payments, 7.5% VAT on its own line,
TIN on the invoice, and a ledger that nobody can quietly edit.

**Landing page:** [lodgiva.vercel.app](https://lodgiva.vercel.app)

---

## How Lodgiva is put together

Lodgiva is three repositories that deploy as one product.

| Repository | What it is | Where it runs |
|---|---|---|
| **[lodgiva](https://github.com/Obiajulu-gif/lodgiva)** (this one) | The landing page, the docs, the deploy kit, and the original NestJS stack | Landing page on **Vercel** |
| **[lodgiva-pms](https://github.com/Obiajulu-gif/lodgiva-pms)** | The hotel system staff use every day: a Lodgiva-branded fork of [Kamra PMS](https://github.com/Kamra-PMS/kamra-pms) on Frappe v16 | Your **server** |
| **[lodgiva-nigeria](https://github.com/Obiajulu-gif/lodgiva-nigeria)** | Naira, VAT and TIN, Nigerian defaults, the money controls, and Lodgiva branding | Installed into the PMS |

```
                           ┌─ /lodgiva   staff PMS            ┐
                           ├─ /book      guest booking page   │ Frappe + lodgiva-pms
browser → one address ─────┤  /app, /login, /api/method …     ┘ + lodgiva-nigeria
                           │
                           └─ /          landing page  → lodgiva.vercel.app (this repo)
```

**Why this shape.** Kamra already covers the breadth a hotel needs: tape
chart, booking engine, POS, banquets and housekeeping. Rebuilding all of
that would take years. Lodgiva adds the part Kamra didn't have: Nigeria.
Everything Nigerian lives in `lodgiva-nigeria` and plugs into Kamra through
its country-pack hook, so pulling an upstream Kamra update stays a merge, not
a rewrite. The reasoning and the evidence are in
[`docs/adr/ADR-001-kamra-fork-evaluation.md`](docs/adr/ADR-001-kamra-fork-evaluation.md)
and [`docs/LODGIVA_GAP_MATRIX.md`](docs/LODGIVA_GAP_MATRIX.md).

### What `lodgiva-nigeria` adds on top of Kamra

- **Naira and VAT, not rupees and GST.** Invoices show ₦, 7.5% VAT on a
  single line, TIN, and amounts in words ("Naira … and … Kobo Only").
- **Money controls Kamra was missing.** A live test run found that Kamra let a
  guest check out while still owing money, invoiced unpaid bills, accepted
  the same bank reference twice, and stored naira payments as INR. All four
  are now refused and tested
  ([gap matrix §8](docs/LODGIVA_GAP_MATRIX.md)).
- **Nigerian tenders and defaults.** Bank transfer and POS terminal with a
  reference, Africa/Lagos time, Nigerian nationality, and NIN as an ID type.
- **Lodgiva branding**, while keeping Kamra's AGPL credit and the source link
  the licence requires.

---

## Try it

### See the landing page locally

```bash
pnpm install
pnpm marketing          # http://localhost:3000
```

### Run the PMS on a server (about 40 minutes)

On any fresh **Ubuntu 22.04/24.04 server with 4 GB RAM or more**:

```bash
curl -fsSL https://raw.githubusercontent.com/Obiajulu-gif/lodgiva/main/deploy/oracle/setup.sh -o setup.sh
sudo DEMO_HOTEL=1 bash setup.sh
```

This gives you HTTPS, the landing page at `/`, the PMS at `/lodgiva`, and a
sample Lagos hotel with rooms, rates and photos. Sign in as `Administrator`;
the script tells you where the generated password is.

**Which provider?** Hetzner, DigitalOcean, Contabo, Oracle, AWS and others
all work. There's a comparison, including which ones take PayPal when a
Nigerian card is declined, in **[`deploy/README.md`](deploy/README.md)**.

### Start the local servers (Windows + WSL)

The PMS demo runs in WSL on Windows: distro `Ubuntu-24.04`, user `frappe`,
already installed on the development machine. It's four processes, each in
its **own Windows PowerShell window**, started in this order. Leave the
windows open; closing one stops that part.

> Use **Windows PowerShell** (Start menu → *PowerShell*), not a Linux
> terminal. The `wsl` command only works from Windows.

**1. Database** (MariaDB, port 3307)

```powershell
wsl -d Ubuntu-24.04 -u frappe -- bash /home/frappe/kamra-mariadb.sh --foreground
```

**2. The PMS** (Frappe on port 8002, plus live updates on 9001). Wait for
`Running on …:8002`.

```powershell
wsl -d Ubuntu-24.04 -u frappe -- bash /home/frappe/kamra-serve.sh
```

**3. The router** (port 8001). It puts the landing page at `/` and the PMS
behind it.

```powershell
wsl -d Ubuntu-24.04 -u frappe -- bash -c "cd ~/lodgiva-router && FRAPPE_UPSTREAM=127.0.0.1:8002 ./caddy run --config Caddyfile.local --adapter caddyfile"
```

Then open:

| Page | Address |
|---|---|
| Landing page | http://localhost:8001/ |
| Staff PMS | http://localhost:8001/lodgiva |
| Guest booking page | http://localhost:8001/book |

**4. Optional: a public link** to share with others, through a free
Cloudflare Tunnel.

```powershell
wsl -d Ubuntu-24.04 -u frappe -- /home/frappe/cloudflared tunnel --no-autoupdate --url http://localhost:8001
```

It prints a new `https://….trycloudflare.com` address **each time it
starts**. Tell the PMS its new address, replacing the example URL:

```powershell
wsl -d Ubuntu-24.04 -u frappe -- bash -lc "cd ~/kamra-bench && bench --site kamra.localhost set-config host_name https://YOUR-NEW-URL.trycloudflare.com"
```

**Sign in** as `Administrator`, not an email address. The password was
generated at install and never printed; read it with:

```powershell
wsl -d Ubuntu-24.04 -u frappe -- cat /home/frappe/.kamra-slice-credentials
```

**Stop everything** by closing the windows, or run:

```powershell
wsl -d Ubuntu-24.04 --shutdown
```

| If you see | It means | Do this |
|---|---|---|
| `address already in use` | That part is still running from before | `wsl -d Ubuntu-24.04 --shutdown`, then start again from step 1 |
| `wsl: command not found` or `Unknown command: -d` | You're in a Linux terminal | Use Windows PowerShell |
| `Wrong email, username, or password` | You signed in with an email | Use `Administrator` |
| The tunnel link won't load at first | Its DNS takes a few seconds | Wait 15–30 seconds and reload |

More detail, and a demo script to rehearse, are in
[`docs/LODGIVA_PMS_DEPLOYMENT.md`](docs/LODGIVA_PMS_DEPLOYMENT.md).

### Start the landing page and original API

From PowerShell in the project folder:

```powershell
cd C:\Users\googl\Desktop\lodgiva
pnpm install
pnpm marketing        # landing page → http://localhost:3000
```

`pnpm api` starts the original API on http://localhost:4000/api/v1. It needs
`DATABASE_URL` and `DIRECT_URL` first; see [The original stack](#the-original-stack)
and [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

---

## This repository

```
apps/
  marketing-web   Next.js 15 landing page — deployed on Vercel
  api             NestJS 11 + Fastify API (original stack)
  worker          Transactional-outbox poller (original stack)
  dashboard-web   Vite + React staff dashboard (original stack)
packages/
  database        Prisma schema, migrations and a guarded reset
deploy/
  README.md       Where to host, and the one-command install
  oracle/         setup.sh (any Ubuntu server), the Caddy router, Oracle notes
docs/             Decisions, the gap matrix, operations and verification
```

### The original stack

`api`, `worker` and `dashboard-web` are Lodgiva's first implementation:
PostgreSQL with row-level security, kobo-integer money and an append-only
ledger. Following the
[migration plan](docs/LODGIVA_IMPLEMENTATION_PLAN.md), it is **frozen, not
deleted**. It stays the reference for the controls the PMS must match, and a
fallback until the PMS passes parity sign-off.

```bash
pnpm db:migrate     # needs DATABASE_URL (see docs/NEON_DEPLOYMENT.md)
pnpm api            # http://localhost:4000/api/v1
pnpm dashboard      # http://localhost:5173
pnpm worker
```

Payments here are **manual only**: cash, bank transfer and POS terminal,
each non-cash tender with a reference. The sandbox adapter that reported
payments as successful without moving money has been removed. For a new
production database, set the `BOOTSTRAP_*` variables and run
`pnpm db:bootstrap`. `pnpm db:seed` loads test fixtures and **must never
point at production**. `packages/database` refuses to reset anything that
isn't a local database whose name ends in `_test`.

### Tests

```bash
pnpm test:unit      # 156 tests, no database needed
```

These cover permissions (including a scan that fails the build if any route
is missing its permission check), tax maths (inclusive and exclusive VAT),
the reservation state machine, POS settlement, payment providers, TOTP and
secret encryption.

Two more suites run against a **disposable** PostgreSQL database named
`*_test`, with the API connected as the restricted role so row-level
security is really exercised (see
[`docs/LOCAL_DATABASE_SETUP.md`](docs/LOCAL_DATABASE_SETUP.md) and
`scripts/test-db-up.sh`):

- `pnpm test:integration`: **242 tests** covering booking, the stay
  lifecycle, money invariants, gateway webhooks, night audit, files, POS and
  hardening.
- `node test/e2e.mjs`: **144 checks** walking one stay from login to night
  audit.

All three suites passed in full on 2026-09-22, under the production login
rate limit.

The PMS side has its own tests in `lodgiva-nigeria`: unit tests for the
country pack, plus a live-site test that replays the four money defects and
checks they're refused.

---

## Documentation

**Start at [docs/README.md](docs/README.md)**, the documentation home,
organised by what you're trying to do. The most-used documents:

| Document | What it answers |
|---|---|
| [**How Lodgiva works**](docs/ARCHITECTURE.md) | The whole system end to end: request path, tenancy, money, auth, data model, limits |
| [**Deploying to Vercel**](docs/deploy-vercel.md) | From zero to a live landing page, dashboard and API |
| [**Configuration**](docs/CONFIGURATION.md) | Every environment variable: default, required or not, where it's read |
| [**Changelog**](CHANGELOG.md) | What changed, and when |
| [ADR-001](docs/adr/ADR-001-kamra-fork-evaluation.md) | Why build on Kamra, and on what conditions |
| [Gap matrix](docs/LODGIVA_GAP_MATRIX.md) | What Kamra does and doesn't do, verified on a live site |
| [Deploying the PMS](docs/LODGIVA_PMS_DEPLOYMENT.md) | The laptop demo, the demo script, and production notes |
| [Where to host](deploy/README.md) | Providers, costs, payment methods, the one-command install |
| [Implementation plan](docs/LODGIVA_IMPLEMENTATION_PLAN.md) | Milestones and what's left |
| [Issue register](docs/LODGIVA_ISSUE_REGISTER.md) | Known defects and their status |
| [Operations](docs/LODGIVA_OPERATIONS.md) | Running it day to day |
| [Verification](docs/LODGIVA_VERIFICATION.md) | How each claim was checked |

## Licences

The PMS repositories are **AGPL-3.0**, inherited from Kamra PMS. Anyone who
uses Lodgiva over a network must be offered the corresponding source; the
booking page's "source" link does that, and it's why those two repositories
are public. Take legal advice before settling a commercial licensing
position.

Built on [Kamra PMS](https://github.com/Kamra-PMS/kamra-pms) and
[Frappe](https://frappe.io).
