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

### Demo from a laptop, free

The PMS also runs in WSL on Windows and can be shared through a free
Cloudflare Tunnel. See
[`docs/LODGIVA_PMS_DEPLOYMENT.md`](docs/LODGIVA_PMS_DEPLOYMENT.md).

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
pnpm test:unit      # 150 tests, no database needed
```

These cover permissions (including a scan that fails the build if any route
is missing its permission check), tax maths (inclusive and exclusive VAT),
the reservation state machine, POS settlement, payment providers, TOTP and
secret encryption.

The end-to-end suite (`pnpm --filter @lodgiva/api test`) runs the full stay
lifecycle against a disposable PostgreSQL database; see
[`docs/LOCAL_DATABASE_SETUP.md`](docs/LOCAL_DATABASE_SETUP.md).

The PMS side has its own tests in `lodgiva-nigeria`: unit tests for the
country pack, plus a live-site test that replays the four money defects and
checks they're refused.

---

## Documentation

| Document | What it answers |
|---|---|
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
