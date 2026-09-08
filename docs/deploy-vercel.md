# Deploying Lodgiva to Vercel — one project, front end and API

The API runs **inside the Next.js app** on Vercel. There is no second service
and no proxy: `apps/marketing-web/app/api/v1/[...path]/route.ts` boots the real
NestJS application and dispatches each request into it.

Live: https://lodgiva.vercel.app

---

## 1. What this is, and what it is not

It is **not** a rewrite. The backend was not converted endpoint by endpoint into
route handlers — all 17,000 lines of ledger, tenancy, auth and audit logic run
unchanged, and the same 138 unit tests and 10 signup integration tests still
cover them. Rewriting them would have produced a second implementation to keep
in sync, and the first thing to drift silently would have been something that
moves money.

What the route handler does is narrow:

```
Web Request → fastify.inject() → the real Nest app → Response
```

`createApiApp()` in `apps/api/src/app-factory.ts` builds the application
without binding a port, so the standalone server (`apps/api/src/main.ts`) and
the Vercel handler share **one** configuration. Two copies would drift, and the
first thing to drift silently would be a security header or a rate-limit
budget.

### Deliberate details in the handler

| Detail | Why |
| --- | --- |
| The client IP is taken from `x-forwarded-for` and passed as `remoteAddress` | Every rate limit is keyed on `req.ip`, and `inject()` defaults to `127.0.0.1`. Without this, every visitor shares one bucket and thirty bad passwords lock out the world. |
| The body is forwarded as raw bytes | Payment webhooks verify an HMAC over exactly what the provider sent; re-serialising the JSON changes key order and invalidates every signature. |
| `Set-Cookie` is appended per value, never joined | Joining an array into one comma-separated string silently drops the session cookie's attributes. |
| The boot **promise** is cached, not the app | Concurrent first requests then share one boot instead of racing to build 29 modules and open 29 connection pools. A failed boot is not cached, so one transient blip does not poison a warm instance. |

---

## 2. Known limits of running serverless

These are real, and worth knowing before you rely on them.

- **Server-Sent Events do not work.** `inject()` buffers a complete response,
  so a stream that never ends would hold the function open until it times out.
  `/events/*` returns `501 SSE_UNAVAILABLE` rather than hanging. The Next
  dashboard polls (`refetchInterval`) and does not use it; the Vite staff app
  does, and needs the standalone server.
- **Rate-limit counters are per instance.** `@fastify/rate-limit` keeps them in
  memory, so the 30/minute auth budget multiplies by the number of warm
  instances. Per-account progressive lockout still applies and is the real
  defence against guessing one account; put a WAF rule in front for volume (see
  `docs/operations.md` §2).
- **Async exports finish only if the instance stays awake.** The export runner
  continues after the response is sent, which serverless does not guarantee.
- **Cold starts pay for booting Nest.** Warm requests measured ~0.6s against
  the live deployment.

If any of those matter more than single-project simplicity, deploy the
standalone server instead — `docs/deploy-render.md` — and set
`LODGIVA_API_ORIGIN` so the Next app proxies to it. Both paths are supported
and only one is ever active.

---

## 3. Configuration

Project settings: **Root Directory = `apps/marketing-web`**. Deploy from the
repository root so the whole pnpm workspace is uploaded; the build command in
`apps/marketing-web/vercel.json` builds `@lodgiva/database` and `@lodgiva/api`
before `next build`.

Required environment variables (Production):

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Neon pooled string, as the `lodgiva_app` role |
| `DIRECT_URL` | Required. The Prisma schema declares `directUrl`; the API refuses to start without it |
| `JWT_SECRET` | 32+ characters. `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `MFA_ENCRYPTION_KEY` | Exactly 32 bytes, base64 — same command |
| `CORS_ORIGINS` | `https://lodgiva.vercel.app`. `*` is rejected |
| `STORAGE_ADAPTER` | `r2` once you have a bucket; `disabled` until then |

**Do not set `LODGIVA_API_ORIGIN`.** Setting it switches the app back to
proxying an external API and the in-process route stops being used.

### Storage

The current deployment runs `STORAGE_ADAPTER=disabled`. That is an explicit
admission, not a default: file uploads, invoice PDFs and CSV exports return
`503 STORAGE_NOT_CONFIGURED` with a message saying what to configure.
Everything else works.

The alternative was a silent fallback to local disk, which on an ephemeral host
loses every guest ID scan and invoice on each deploy — a worse failure, because
nobody notices it. Set `STORAGE_ADAPTER=r2` with the R2 variables from
`docs/deploy-render.md` §3 to switch it on; R2's storage allowance is free.

---

## 4. Verifying a deploy

```bash
node scripts/smoke-serverless-api.mjs --base https://lodgiva.vercel.app
```

27 checks covering the parts the serverless transport can plausibly break:
native modules loading, a real write transaction, `Set-Cookie` attributes
surviving, refresh rotation and single-use enforcement, rate-limit headers, and
error codes not collapsing into 500.

It creates a real tenant with a unique email each run, so it is safe to repeat
— but it does write to whatever database the base URL points at. Never aim it
at a database with real guests in it.

> A caution learned the hard way: run this against the **`lodgiva_app`** role.
> If `DATABASE_URL` fails to load, Prisma silently falls back to the `.env`
> beside the schema, which is the `neondb_owner` role — and that role bypasses
> row-level security, so the suite passes while telling you nothing about
> production.
