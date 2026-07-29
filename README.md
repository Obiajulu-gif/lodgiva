# Lodgiva 🏨

**Modern hotel management software built for Nigerian hotels, serviced apartments and hotel groups.**

Lodgiva covers reservations, front desk, folios, payments & reconciliation,
housekeeping, maintenance, restaurant POS, cashiering and night audit —
designed around the realities of Nigerian hospitality: bank-transfer payments,
POS terminals, unreliable connectivity, configurable VAT/consumption tax, and
fraud-proof append-only financial ledgers.

Built to [`docs/technical-specification.md`](docs/technical-specification.md).
See **[docs/implementation-status.md](docs/implementation-status.md)** for
exactly what is implemented, what is partial, and what is not built yet.

## Layout

```
apps/
  api             NestJS 11 + Fastify — the modular monolith (all business rules)
  worker          Transactional-outbox poller (notifications, side-effects)
  dashboard-web   Vite + React staff dashboard (PWA), talks to the API
  marketing-web   Next.js public site + booking engine
packages/
  database        Prisma schema and seed
```

## Running it

```bash
pnpm install
```

Set up the database (SQLite locally — see ADR-LOCAL-001 in the status doc):

```bash
pnpm --filter @lodgiva/database exec prisma db push && pnpm db:seed
```

Then start the pieces you need, each in its own terminal:

```bash
pnpm api
```

```bash
pnpm dashboard
```

```bash
pnpm worker
```

- API: <http://localhost:4000/api/v1> (health at `/health/live`, `/health/ready`)
- Dashboard: <http://localhost:5173> (proxies `/api` to the API)
- Marketing site: `pnpm marketing` → <http://localhost:3000>

### Seeded logins

Password for all: `Password123!`

| Email | Role |
|---|---|
| `owner@grandpalm.demo` | Tenant owner |
| `manager@grandpalm.demo` | General manager (can approve cash variances) |
| `frontdesk@grandpalm.demo` | Front desk |
| `housekeeping@grandpalm.demo` | Housekeeping |

The seed creates one tenant (Grand Palm Hotels), one property with 20 rooms
across four room types, two POS outlets with menus, guests and reservations.

## Tests

With the API running:

```bash
pnpm --filter @lodgiva/api test
```

85 assertions covering the full stay lifecycle — reserve, check in, post POS
charges, take payment, check out, run night audit — plus the financial
invariants (append-only ledger, reversals, payment idempotency, cash variance
approval) and tenant isolation.

## Tech stack

- **API** — NestJS 11 + Fastify, Prisma, Zod, Argon2id + JWT
- **Dashboard** — Vite 6, React 19, TanStack Query, React Router, vite-plugin-pwa
- **Marketing** — Next.js 15 (App Router), Tailwind CSS v4, lucide-react
- **Monorepo** — pnpm workspaces + Turborepo

## Configuration

`apps/api/.env` holds `DATABASE_URL`, `JWT_SECRET` and `API_PORT`. Production
keys for Paystack, Flutterwave, Termii, Resend and Cloudflare R2 are documented
in `.env.example`; none are needed to run locally — payment providers use
manual and sandbox adapters.
