# Local database startup

Use Node.js 24 and run commands from the repository root:

```sh
pnpm api
pnpm marketing
pnpm worker
```

The API and worker scripts load their package `.env` before importing application
code. Variables supplied by the host take precedence. A root `.env` can supply
missing values. Local secret files are ignored by Git.

- `apps/api/.env`: pooled Neon `DATABASE_URL` using `lodgiva_app`, plus API secrets.
- `apps/worker/.env`: pooled Neon `DATABASE_URL` using `lodgiva_app`.
- `packages/database/.env`: administrative `DATABASE_URL` and direct `DIRECT_URL`
  for migrations and bootstrap.

Use `connect_timeout=60` and `pool_timeout=60` on local connections when Neon
cold starts or the network is slow. Never copy owner credentials into frontend
environment variables.

Run `pnpm db:migrate` for pending migrations. The PostgreSQL baseline and tenant
RLS migrations were already applied when the connection was verified.

The database currently has no permanent hotel or user records. Configure the
`BOOTSTRAP_*` values described in `.env.production.example` with the real hotel
and owner information before running `pnpm db:bootstrap`. Demo seeding is not
required for login or normal operation.
