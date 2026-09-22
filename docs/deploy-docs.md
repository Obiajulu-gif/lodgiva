# Deploying the documentation site

The documentation at [`apps/docs`](../apps/docs) is a Next.js app and deploys
to Vercel as **its own project**, separate from the marketing site. Both live
in this monorepo; Vercel builds each from its own root directory.

## Create the project

1. In Vercel, **Add New → Project**, and import `Obiajulu-gif/lodgiva`.
2. Name it `lodgiva-docs`.
3. Set **Root Directory** to `apps/docs`.
4. Leave the framework as **Next.js**. The build and install commands come
   from [`apps/docs/vercel.json`](../apps/docs/vercel.json); there is nothing
   to type.
5. Deploy.

The first build takes a few minutes. It compiles every MDX page, so a broken
page fails the build instead of reaching the site.

## Environment variables

| Variable | Value | Why |
| --- | --- | --- |
| `NEXT_PUBLIC_DOCS_URL` | `https://docs.lodgiva.com` | Absolute URLs in the sitemap, `robots.txt` and the social preview tags |

Set it for **Production** once the domain is attached. Without it the site
still builds and falls back to the Vercel address; the only cost is that
shared links preview against the wrong origin.

## The domain

Point `docs.lodgiva.com` at the project:

1. In the Vercel project, **Settings → Domains → Add**, enter
   `docs.lodgiva.com`.
2. At your DNS provider, add the record Vercel shows — usually:

   ```text
   Type   CNAME
   Name   docs
   Value  cname.vercel-dns.com
   ```

3. Wait for it to verify. The certificate is issued automatically.
4. Set `NEXT_PUBLIC_DOCS_URL` to `https://docs.lodgiva.com` and redeploy, so
   the sitemap and OG tags use the real address.

## Builds that should not run

A monorepo pushes changes that have nothing to do with the documentation. In
**Settings → Git → Ignored Build Step**, use:

```bash
npx turbo-ignore @lodgiva/docs
```

It skips the build when neither `apps/docs` nor anything it depends on
changed, working the dependency graph out from `turbo.json`.

Do not reach for a hand-written `git diff HEAD^ HEAD` here. Vercel clones
shallowly, so `HEAD^` is often missing; git then exits 128, and Vercel cancels
the deployment on any exit code other than 0 or 1. The symptom is a push that
silently never deploys.

## Checking a deployment

- Open `/` and a deep page such as `/docs/billing/night-audit`.
- Press **Ctrl/Cmd + K** and search for something; the index is built at build
  time, so an empty search means the content did not compile.
- Open `/sitemap.xml` and confirm the URLs use the right origin.
- Open `/robots.txt`.

## Rolling back

Vercel keeps every deployment. **Deployments → … → Promote to Production** on
the last good one. The documentation carries no database and no state, so a
rollback is immediate and complete.
