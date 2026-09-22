# Hosting Lodgiva's PostgreSQL database on Neon

Lodgiva uses two database identities and two connection modes:

- `DIRECT_URL`: the Neon owner role over the non-pooled endpoint, used only by Prisma Migrate and administration.
- `DATABASE_URL`: the restricted `lodgiva_app` role over Neon's pooled endpoint, used by the API and worker.

Never expose either value to the browser applications.

## 1. Create Neon

Either create a Neon database from the Vercel Marketplace (`vercel integration add neon`) after linking the API project, or create a project directly in the Neon console. Choose a region near the API host, create a production branch, and keep the default owner credentials in the deployment secret store.

From Neon's **Connect** dialog copy both connection strings:

```env
# Hostname contains -pooler; initially use the owner while migrating.
DATABASE_URL="postgresql://neondb_owner:OWNER_PASSWORD@ep-example-pooler.region.aws.neon.tech/lodgiva?sslmode=require&connect_timeout=15"

# Hostname does not contain -pooler.
DIRECT_URL="postgresql://neondb_owner:OWNER_PASSWORD@ep-example.region.aws.neon.tech/lodgiva?sslmode=require&connect_timeout=15"
```

Use URL encoding for special characters in passwords. Do not commit `.env`.

## 2. Deploy the PostgreSQL baseline

The database must be empty. From the repository root:

```bash
pnpm install
pnpm --filter @lodgiva/database build
pnpm db:migrate
```

The migrations create the schema, the restricted `lodgiva_app` role, and row-level security policies. Migration must use the owner/direct connection.

## 3. Give the runtime role its own secret

Generate a long random password, open Neon's SQL Editor as the owner, and run:

```sql
ALTER ROLE lodgiva_app WITH LOGIN PASSWORD 'REPLACE_WITH_A_RANDOM_PASSWORD';
```

Now change only the runtime URL to the pooled hostname and restricted role:

```env
DATABASE_URL="postgresql://lodgiva_app:APP_PASSWORD@ep-example-pooler.region.aws.neon.tech/lodgiva?sslmode=require&connect_timeout=15&connection_limit=10&pool_timeout=20"
DIRECT_URL="postgresql://neondb_owner:OWNER_PASSWORD@ep-example.region.aws.neon.tech/lodgiva?sslmode=require&connect_timeout=15"
```

The API wraps authenticated requests in a transaction and sets `app.tenant_id`. PostgreSQL RLS then rejects rows belonging to any other tenant. Do not run the API as `neondb_owner`, because table owners bypass ordinary RLS policies.

## 4. Seed only if this is a demo environment

The seed is administrative and must use the owner connection. In PowerShell:

```powershell
$env:DATABASE_URL = $env:DIRECT_URL
pnpm db:seed
```

Do not seed production with the demo hotel or documented demo passwords.

## 5. Configure deployment

Set `DATABASE_URL` (the `lodgiva_app` pooled URL) wherever the API or worker runs.

**`DIRECT_URL` must also be set on the API's runtime:** it refuses to start
without it, because the Prisma schema declares `directUrl`. The runtime never
queries through it, only Prisma Migrate does. So prefer the **unpooled
`lodgiva_app`** URL there, and keep the **owner** URL for migration jobs only
(issue L-25; verify with the smoke test before relying on it).

Current topology (see [deploy-vercel.md](deploy-vercel.md)):

- **Vercel:** `apps/marketing-web`, which also runs the whole API in-process
  at `/api/v1`. One project.
- **Neon:** PostgreSQL.
- **Cloudflare R2:** uploaded files and generated exports, once enabled.
- **Not on Vercel:** `apps/worker` needs any always-on host. Alternatively,
  run the API standalone ([deploy-render.md](deploy-render.md)) and set
  `LODGIVA_API_ORIGIN`.

Before releasing, run:

```bash
pnpm db:migrate
pnpm build
pnpm test:unit
pnpm audit --prod
```

Use a separate Neon branch/database for staging. Test migrations there before applying them to production, and enable Neon point-in-time restore/backups appropriate to the plan.
