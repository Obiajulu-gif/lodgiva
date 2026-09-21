# Deploying Lodgiva to Vercel

| | |
|---|---|
| **Status** | Living document. Update it with any change to the build, environment or runtime |
| **Last verified against code** | 2026-09-21 |
| **Live** | https://lodgiva.vercel.app |
| **See also** | [ARCHITECTURE.md](ARCHITECTURE.md) · [CONFIGURATION.md](CONFIGURATION.md) · [NEON_DEPLOYMENT.md](NEON_DEPLOYMENT.md) |

This guide takes you from nothing to a working Lodgiva on Vercel: the landing
page, sign-up, the staff dashboard and the full API, all as **one Vercel
project**.

> **What Vercel can't host:** the **Lodgiva PMS** (Frappe/Kamra) needs a
> long-running server, MariaDB and Redis, so it goes on a Linux server instead.
> See [deploy/README.md](../deploy/README.md). This guide covers everything in
> this repository that *does* run on Vercel.

---

## Contents

1. [What gets deployed](#1-what-gets-deployed)
2. [Before you start](#2-before-you-start)
3. [Step 1: Create the database (Neon)](#step-1-create-the-database-neon)
4. [Step 2: Build the schema and lock down the runtime role](#step-2-build-the-schema-and-lock-down-the-runtime-role)
5. [Step 3: Create the Vercel project](#step-3-create-the-vercel-project)
6. [Step 4: Set environment variables](#step-4-set-environment-variables)
7. [Step 5: Deploy](#step-5-deploy)
8. [Step 6: Create the first hotel](#step-6-create-the-first-hotel)
9. [Step 7: Verify](#step-7-verify)
10. [Custom domain](#custom-domain)
11. [Day-to-day: shipping changes](#day-to-day-shipping-changes)
12. [What doesn't work on Vercel](#what-doesnt-work-on-vercel)
13. [Costs and plan limits](#costs-and-plan-limits)
14. [Troubleshooting](#troubleshooting)
15. [How the in-process API works](#how-the-in-process-api-works)

---

## 1. What gets deployed

```
Vercel project (Root Directory: apps/marketing-web)
│
├── /                 landing page
├── /login /signup    authentication
├── /dashboard/*      staff dashboard (guarded by middleware)
└── /api/v1/*         the entire NestJS API, booted inside a Next.js route handler
                      └── Neon PostgreSQL (row-level security)
```

There is **no second service**. `apps/marketing-web/app/api/v1/[...path]/route.ts`
boots the real NestJS application (all 29 modules) and dispatches each request
into it. See [How the in-process API works](#how-the-in-process-api-works).

**Not deployed to Vercel** (and what that means is covered in
[What doesn't work on Vercel](#what-doesnt-work-on-vercel)): the outbox
`worker`, the Vite `dashboard-web` PWA, and the Lodgiva PMS.

---

## 2. Before you start

| You need | Notes |
|---|---|
| The code on GitHub | [Obiajulu-gif/lodgiva](https://github.com/Obiajulu-gif/lodgiva) |
| A **Vercel** account | Free to start. Read [Costs and plan limits](#costs-and-plan-limits): the free Hobby plan is for non-commercial use |
| A **Neon** account | Free tier is enough to start |
| Locally: **Node.js 20+** and **pnpm 10** | Used once, to run migrations. `corepack enable` provides pnpm |
| Optional: **Cloudflare R2** | For uploads, invoice PDFs and exports. Without it these return 503; everything else works |

---

## Step 1: Create the database (Neon)

1. In Neon, create a project in a region close to your Vercel functions.
   Vercel defaults to Washington D.C. (`iad1`), so a US-East Neon region is a
   good match.
2. From **Connect**, copy two connection strings for the **owner** role:
   - **Pooled**: the hostname contains `-pooler`. This becomes `DATABASE_URL`
     after Step 2.
   - **Direct**: no `-pooler`. This is `DIRECT_URL`, used for migrations.

Keep both secret. Never commit them, and never put them in a `NEXT_PUBLIC_*`
variable.

## Step 2: Build the schema and lock down the runtime role

The Vercel build **doesn't run migrations**, so you run them once from your
machine. In a terminal at the repository root, with the owner's **direct**
URL:

```bash
pnpm install
pnpm --filter @lodgiva/database build        # generates the Prisma client
```

PowerShell:

```powershell
$env:DIRECT_URL   = Read-Host "Paste the owner's DIRECT connection string"   # not echoed into history
$env:DATABASE_URL = $env:DIRECT_URL
pnpm db:migrate
```

This creates all 55 tables, the restricted **`lodgiva_app`** role and the
row-level-security policies. Now give `lodgiva_app` a password. In Neon's SQL
Editor, as the owner:

```sql
ALTER ROLE lodgiva_app WITH LOGIN PASSWORD '<paste a long random password here>';
```

Compose the **runtime** URL. Take Neon's **pooled** connection string (the
hostname contains `-pooler`) and change two parts:

| Part | Change it to |
|---|---|
| User | `lodgiva_app` |
| Password | The one you just set |

Keep the host and database name. Add these query parameters if they're
missing: `sslmode=require&connect_timeout=15&connection_limit=10&pool_timeout=20`.
Paste the result straight into Vercel's secret store (Step 4). Never into a
file, a chat or a document.

> **Why two roles.** The owner **bypasses** row-level security. If the app ran
> as the owner, one missing `tenantId` filter would show one hotel another
> hotel's guests. As `lodgiva_app`, the database itself refuses.

## Step 3: Create the Vercel project

1. **Add New → Project**, and import `Obiajulu-gif/lodgiva`.
2. **Root Directory:** `apps/marketing-web`. Leave **"Include files outside
   the root directory in the Build Step"** on. The build needs the whole pnpm
   workspace.
3. **Framework:** Next.js (detected). Don't override the install or build
   commands; they come from `apps/marketing-web/vercel.json`:

   ```json
   {
     "installCommand": "pnpm install --frozen-lockfile",
     "buildCommand": "pnpm --filter @lodgiva/database run build && pnpm --filter @lodgiva/api run build && next build"
   }
   ```

   The build generates the Prisma client, compiles the API, then builds
   Next.js.

4. Don't deploy yet. Set the variables first, or the first deploy fails its
   production safety check.

## Step 4: Set environment variables

**Settings → Environment Variables.** Scope these to **Production**. Give
**Preview** its own values (see the warning after the table).

### Required

| Variable | Value | How to make it |
|---|---|---|
| `DATABASE_URL` | The **`lodgiva_app` pooled** URL from Step 2 | — |
| `DIRECT_URL` | Must be set, or the API refuses to start | See the note below |
| `JWT_SECRET` | 32+ random characters | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `MFA_ENCRYPTION_KEY` | Exactly 32 random bytes, base64 | The same command |
| `CORS_ORIGINS` | `https://lodgiva.vercel.app` (comma-separate more; exact HTTPS origins only, `*` is rejected) | — |
| `STORAGE_ADAPTER` | `disabled` until you have R2, then `r2` | — |

**About `DIRECT_URL`.** The running API never sends a query through it; only
Prisma Migrate does. Prisma Client just needs the variable to exist, because
the schema declares `directUrl`. Putting the **owner** URL here places
credentials that bypass row-level security in your serverless environment. The
least-privilege option is the **unpooled `lodgiva_app`** URL. That's a
recommendation, not yet a tested fact, so run the smoke test in Step 7 after
changing it. Tracked as **L-25** in the
[issue register](LODGIVA_ISSUE_REGISTER.md).

### Only with R2 storage

`STORAGE_ADAPTER=r2`, `STORAGE_BASE_URL`, `STORAGE_SIGNING_KEY` (32+
characters), `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_PUBLIC_BUCKET`, `R2_PRIVATE_BUCKET`, `R2_PUBLIC_BASE_URL`.

### Optional

| Variable | Effect |
|---|---|
| `PAYSTACK_SECRET_KEY`, `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_WEBHOOK_HASH` | Enable gateway payments and webhook verification |
| `PAYMENTS_MODE=live` | Allow **live** gateway calls. Anything else stays sandbox, deliberately |
| `NEXT_PUBLIC_PMS_URL` | Where the landing page's "See it in action" buttons open the PMS, e.g. `https://pms.example.com`. Leave unset when the landing page is served through the Lodgiva router |
| `SENTRY_DSN`, `OTEL_*` | Error and trace reporting |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_AUTH_MAX` | Rate-limit budgets |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web push (needs the worker, which doesn't run on Vercel) |

**Don't set `LODGIVA_API_ORIGIN`.** It switches Next.js to proxying an
external API, and the in-process route stops being used.

Every variable, with its default and where it's read:
[CONFIGURATION.md](CONFIGURATION.md).

> ⚠️ **Preview deployments.** Every pull request gets a Preview deployment.
> If Preview shares Production's `DATABASE_URL`, then **every pull request's
> code runs against your real hotel data**. Give Preview a separate Neon
> **branch**, or leave Preview's database unset so previews fail safely.

## Step 5: Deploy

Click **Deploy** in the dashboard, or from the repository root with the Vercel
CLI:

```bash
vercel --prod
```

The CLI reads `.vercel/project.json`; run `vercel link` once if it's missing.
After this, **every push to `main` deploys Production**, and every pull request
gets a Preview.

## Step 6: Create the first hotel

Choose one:

- **Self-serve.** Open `/signup`. It creates a tenant, a property and you as
  the owner.
- **Bootstrap** (for a real client's first property). Run this from your
  machine against the production database:

  ```powershell
  $env:DATABASE_URL = "<owner direct URL>"
  $env:BOOTSTRAP_TENANT_LEGAL_NAME   = "Grand Palm Hotels Ltd"
  $env:BOOTSTRAP_TENANT_DISPLAY_NAME = "Grand Palm"
  $env:BOOTSTRAP_TENANT_SLUG         = "grand-palm"
  $env:BOOTSTRAP_PROPERTY_NAME       = "Grand Palm Ikeja"
  $env:BOOTSTRAP_PROPERTY_CODE       = "GPI"
  $env:BOOTSTRAP_PROPERTY_SLUG       = "grand-palm-ikeja"
  $env:BOOTSTRAP_OWNER_EMAIL         = "owner@example.com"
  $env:BOOTSTRAP_OWNER_NAME          = "Ada Obi"
  $env:BOOTSTRAP_OWNER_PASSWORD      = "<14+ characters, not a default>"
  pnpm db:bootstrap
  ```

  Bootstrap **refuses** to run if the database already has a tenant, and
  rejects weak or documented passwords. Optional: `BOOTSTRAP_CURRENCY`
  (default NGN) and `BOOTSTRAP_PROPERTY_TIMEZONE` (default Africa/Lagos).

> **Never run `pnpm db:seed` or `pnpm seed:demo` against production.** They
> create demo logins with published passwords.

## Step 7: Verify

```bash
curl https://lodgiva.vercel.app/api/v1/health/live     # {"status":"ok"}
curl https://lodgiva.vercel.app/api/v1/health/ready    # {"status":"ready"}: database reachable
```

Then run the serverless smoke test, 27 checks aimed at what serverless
transport can break: native modules loading, a real write transaction,
`Set-Cookie` attributes surviving, refresh rotation and single use, rate-limit
headers, and error codes not collapsing into 500s.

```bash
node scripts/smoke-serverless-api.mjs --base https://lodgiva.vercel.app
```

> It creates a real tenant with a unique email on each run: safe to repeat,
> but it **writes to whatever database the URL points at**. Point it at a
> staging deployment when you can. Make sure that deployment runs as
> **`lodgiva_app`**: as the owner, row-level security is bypassed and the test
> passes while proving nothing.

---

## Custom domain

1. **Settings → Domains** → add, for example, `lodgiva.com`, and set the DNS
   records Vercel shows.
2. **Add the new origin to `CORS_ORIGINS`**, e.g.
   `https://lodgiva.vercel.app,https://lodgiva.com`, then redeploy.
   Environment changes only apply to new deployments.

## Day-to-day: shipping changes

| Change | What to do |
|---|---|
| Code only | Merge to `main`. Vercel deploys Production automatically |
| **Database schema** | Run `pnpm db:migrate` against Production **before** merging (with `DIRECT_URL`). Keep migrations additive so the running code and the new schema coexist during the rollout |
| An environment variable | Change it in Vercel, then **Redeploy** |
| Roll back | **Deployments** → pick the last good one → **Promote to Production**. This doesn't undo a migration, which is why migrations must be additive |

Before merging, run the checks CI would run:

```bash
pnpm test:unit            # 150 tests
pnpm --filter lodgiva lint
pnpm check:migrations
```

---

## What doesn't work on Vercel

Serverless functions start on demand and stop when idle, and a request can
last at most 60 seconds here. That shapes what works:

| Feature | On Vercel | Why | If you need it |
|---|---|---|---|
| **Live updates (SSE)** | `/events/*` returns `501 SSE_UNAVAILABLE` | `inject()` buffers whole responses; an endless stream would hang until the timeout | The Next dashboard polls instead. For SSE, run the standalone API |
| **Outbox worker** | Not running | Nothing hosts it: no cron, no process | Run `pnpm worker` on any always-on host. Until then events queue up and **no push notifications** are sent |
| **Email / SMS** | Not implemented anywhere | The worker logs these events; no provider is wired up | Planned; tracked as L-26 |
| **Night audit on a schedule** | Manual | No scheduler in this stack | Run it from the dashboard each night; tracked as L-28 |
| **Rate limits** | Per instance, in memory | Each warm function has its own counters | Per-account lockout still protects each account; add a WAF rule for volume ([operations.md](operations.md) §2) |
| **Long exports** | May not finish | Work after the response isn't guaranteed | Use the standalone API |
| **File uploads, PDFs, exports** | `503 STORAGE_NOT_CONFIGURED` while `STORAGE_ADAPTER=disabled` | Deliberate: a serverless disk is wiped on every deploy | Configure R2 (free allowance) |
| **Cold starts** | The first request boots Nest | ~0.6 s warm, several seconds cold | Traffic keeps instances warm |

**Standalone alternative.** Run the API as a normal server (`pnpm api`, or
[deploy-render.md](deploy-render.md)), then set `LODGIVA_API_ORIGIN` on Vercel.
Next.js then proxies `/api/v1/*` to that server. Only one mode is ever active.

---

## Costs and plan limits

- **Vercel Hobby (free)** is for personal, **non-commercial** use under
  Vercel's terms. A hotel paying for Lodgiva is commercial, so move to **Pro**
  before selling. Check Vercel's current pricing and function limits.
- **Neon free tier** has storage and compute caps that suit a pilot. Check
  Neon's current limits, and set up backups or point-in-time restore on a paid
  plan before real data depends on it.
- **Cloudflare R2** has a free storage allowance and no egress fees.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Deploy boots, then every API call is 500 with `Unsafe production configuration` | A required variable is missing or weak | The message lists each problem. Fix the variables, then **Redeploy** |
| `DIRECT_URL is required` | Not set | Set it (Step 4) |
| `DATABASE_URL is required` | Not set for this environment | Check Production vs Preview scope |
| `new row violates row-level security policy` | A write ran without a tenant context, or as the wrong role | Check `DATABASE_URL` uses `lodgiva_app`. Report the endpoint: it's a bug |
| Everything works but tenants can see each other | The API is running as the **owner** | Switch `DATABASE_URL` to `lodgiva_app` **now** |
| `Cannot find module '.prisma/client'` or an `argon2` binary error | Native files weren't traced into the function | Keep `outputFileTracingIncludes` in `next.config.ts`; build from the repo root with the whole workspace |
| Login succeeds, then you're immediately logged out | The refresh cookie was dropped | Must be HTTPS in production; check the cookie isn't blocked. `Set-Cookie` joining bugs are covered by the smoke test |
| Browser console: CORS error | The origin isn't in `CORS_ORIGINS` | Add the exact origin (scheme + host, no trailing slash), then redeploy |
| `503 STORAGE_NOT_CONFIGURED` | `STORAGE_ADAPTER=disabled` | Expected. Configure R2 to enable files |
| `501 SSE_UNAVAILABLE` | SSE on serverless | Expected; see above |
| A Preview URL redirects to a Vercel login | Deployment Protection on previews | Expected for previews; Production is public |
| `/api/v1/auth/refresh` → 401 on the landing page | Visitor not signed in | Expected: the page checks for a session |

---

## How the in-process API works

```
Web Request → route handler → fastify.inject() → the real NestJS app → Response
```

`createApiApp()` (`apps/api/src/app-factory.ts`) builds the app without binding
a port, so the standalone server (`apps/api/src/main.ts`) and this handler
share **one** configuration: the same guards, security headers and rate
limits. Two copies would drift, and the first thing to drift silently would be
something that protects money.

| Detail in the handler | Why |
|---|---|
| Node runtime, never Edge; `maxDuration = 60` | Argon2 and Prisma are native modules |
| The client IP from `x-forwarded-for` becomes `remoteAddress` | Rate limits key on `req.ip`; `inject()` defaults to `127.0.0.1`, which would put every visitor in one bucket |
| The body is forwarded as raw bytes | Payment webhooks verify an HMAC over the exact bytes |
| `Set-Cookie` is appended per value | Joining the values into one string strips the refresh cookie's attributes |
| The boot **promise** is cached; a failed boot isn't | Concurrent cold requests share one boot; a transient failure doesn't poison the instance |
| The server-side packages are **webpack externals** (`next.config.ts`) | The import chain starts outside the app, so `serverExternalPackages` alone wasn't enough; bundling NestJS broke on optional dependencies |
