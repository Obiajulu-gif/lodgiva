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

Set up a PostgreSQL database (Neon instructions are in
[`docs/NEON_DEPLOYMENT.md`](docs/NEON_DEPLOYMENT.md)):

```bash
pnpm db:migrate
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

For a new production database, configure the required `BOOTSTRAP_*` variables
and run `pnpm db:bootstrap`. This creates only the real tenant, property and
owner supplied through the environment. Test fixtures remain available through
`pnpm db:seed`, but must never be run against production.

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

`apps/api/.env` holds `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET` and `API_PORT`. Production
keys for Paystack, Flutterwave, Termii, Resend and Cloudflare R2 are documented
in `.env.example`; none are needed to run locally — payment providers use
manual and sandbox adapters.
