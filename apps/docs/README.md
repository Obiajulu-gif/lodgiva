# Lodgiva documentation

The documentation site for the Lodgiva PMS, at
[`apps/docs`](.) in the `lodgiva` monorepo. Built with
[Next.js](https://nextjs.org) and [Fumadocs](https://fumadocs.dev); content is
MDX under [`content/docs`](content/docs).

## Run it

From the repository root:

```bash
pnpm install
```

```bash
pnpm docs
```

Then open <http://localhost:3001>.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Development server with hot reload |
| `pnpm build` | Production build, including every static page |
| `pnpm start` | Serve a production build |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `next typegen` then `tsc --noEmit` |

## Where things live

```text
app/
  (home)/page.tsx     the landing page
  docs/[[...slug]]/   every documentation page
  og/                 generated social images
  sitemap.ts          derived from the content tree
components/
  mdx.tsx             which components MDX can use
  status.tsx          <Status type="available | beta | planned | …" />
content/docs/         the documentation itself, in MDX
  meta.json           section order in the sidebar
lib/
  shared.ts           site name, origin, GitHub edit links
  layout.shared.tsx   the navigation bar
public/images/docs/   screenshots
```

## Writing a page

Create an `.mdx` file under `content/docs`, and add its name to the
`meta.json` in the same folder to place it in the sidebar.

```mdx
---
title: "Take a booking"
description: "Turn an enquiry into a confirmed reservation."
---

Body text.
```

**Quote `title` and `description`.** An unquoted YAML value containing `: `
is a parse error, and descriptions naturally contain colons.

### Components available in MDX

`Note`, `Tip`, `Warning`, `Danger`, `Cards`/`Card`, `Steps`/`Step`,
`Tabs`/`Tab`, `Accordions`/`Accordion`, `Files`/`File`/`Folder`, `TypeTable`,
and `Status`.

### The rule about unbuilt features

Never describe something that does not exist as if it works. Label it:

```mdx
Card payments through Paystack <Status type="planned" /> are not built.
```

[Feature status](content/docs/resources/feature-status.mdx) is the index of
what is real, and is updated with the product.

## Checks before opening a pull request

```bash
pnpm lint && pnpm typecheck && pnpm build
```

The build compiles every MDX file, so a broken page fails it rather than
reaching the site.

## Deployment

Deployed to Vercel as its own project with the repository root as the Vercel
root directory and `apps/docs` as the app — see
[`docs/deploy-docs.md`](../../docs/deploy-docs.md).
