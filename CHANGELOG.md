# Changelog

All notable changes to Lodgiva are recorded here, newest first.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Lodgiva doesn't publish version numbers yet, so each release is identified by
the **date it reached `main`**. Changes waiting to merge sit under
**Unreleased**.

Change types: **Added** new features · **Changed** existing behaviour ·
**Fixed** bugs · **Security** vulnerabilities and hardening · **Removed**
features taken out · **Deprecated** features on their way out.

Entries marked **(PMS)** landed in
[`lodgiva-pms`](https://github.com/Obiajulu-gif/lodgiva-pms) or
[`lodgiva-nigeria`](https://github.com/Obiajulu-gif/lodgiva-nigeria) rather
than this repository. They're recorded here so the product has one history.

> **Keeping this current:** every pull request that changes behaviour adds a
> line under **Unreleased**, in the same PR. When it merges, the lines move
> under that day's date. See [docs/README.md](docs/README.md#keeping-these-documents-true).

---

## [Unreleased]

### Added
- A documentation home organised by task ([docs/README.md](docs/README.md)),
  an end-to-end architecture reference ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)),
  a reference for every environment variable
  ([docs/CONFIGURATION.md](docs/CONFIGURATION.md)), this changelog, and a
  pull-request checklist that keeps them up to date.
- [deploy/README.md](deploy/README.md): hosting options compared for
  sign-ups from Nigeria, including which providers take PayPal.

### Security
- Row-level security stays strict for anonymous routes. Three narrow
  `SECURITY DEFINER` resolvers, callable only by the app role, answer
  "which tenant owns this?" and nothing else, and only when the answer is
  unambiguous. All real work then runs under that tenant's RLS. Migration
  `20260922000000_public_entry_point_resolvers`, additive only.
- Verified that the API needs **no owner database credentials** at runtime:
  the full suite passes with `DIRECT_URL` set to the restricted role. (L-25)

### Changed
- The README now describes the product as it is: three repositories that
  deploy as one.
- [docs/deploy-vercel.md](docs/deploy-vercel.md) is now a complete from-zero
  guide: database roles, every variable, bootstrap, verification, custom
  domains, shipping changes, what doesn't run on Vercel, costs and
  troubleshooting.
- The server installer (`deploy/oracle/setup.sh`) now works on any Ubuntu
  host, not only Oracle.

### Fixed
- **Payment webhooks failed with a 500** when the API ran as its restricted
  database role, as production should. Every Paystack and Flutterwave
  confirmation was refused by row-level security. Money that no hotel can be
  matched to is now recorded for finance review instead of being written under
  a made-up tenant id. (L-31)
- **The public booking engine couldn't find any hotel** under the restricted
  role, and when it could, it might have picked the wrong one: two companies
  may use the same property slug. Quotes now resolve a hotel only when the slug
  is unambiguous. (L-31)
- **New staff couldn't accept their invitations**: acceptance rolled back with
  a database error. (L-32)
- **Live updates never reached any screen.** The poller now reads each
  connected hotel's events in that hotel's own context. (L-33)
- **Exports never finished, on every deployment**, and request metrics were
  never saved. Background work was reusing a request's closed database
  transaction. (L-34)
- A quarantined upload (HTML disguised as an image) left **no audit trail**:
  the quarantine was rolled back by its own error response. Nothing was ever
  served. (L-35)
- `db:reset` failed to parse and couldn't run at all. It's now covered by a
  test. (L-29)
- The test database script granted rights in an order PostgreSQL 16 ignores,
  so every query was refused. (L-30)
- The integration and end-to-end suites had drifted from the API and **had
  never run against PostgreSQL row-level security**. They now pass in full,
  under the production login rate limit, as the restricted role only:
  242/242 integration, 144/144 end-to-end, 156/156 unit. (L-36)
- The installer aborted on providers whose firewall starts empty (Hetzner,
  DigitalOcean): it inserted a rule at a fixed position. It now inserts at the
  top, and opens `ufw` if that's active.
- The installer's HTTPS setup failed to load with no email given, and invented
  an address Let's Encrypt can refuse. The email is now optional.
- The installer ran no `apt-get update` before installing, which fails on a
  fresh image.
- The README said payments used "sandbox adapters"; that adapter was removed on
  2026-09-09. It also carried stale test counts; the unit suite is 150 tests.

---

## 2026-09-21

### Added
- **"See it in action"** on the landing page: six real screens from the
  Lodgiva PMS running a Lagos hotel, each opening full size.
- **One address for everything:** a Caddy router puts the landing page at `/`
  and the PMS behind it (`/lodgiva`, `/book`, `/app`). It's used by the laptop
  demo and by servers.
- A one-command server installer (`deploy/oracle/setup.sh`): Docker, the
  Frappe stack, HTTPS through a free `sslip.io` hostname, the scheduler, and a
  nightly backup. Optionally, a demo hotel.
- The PMS deployment guide
  ([docs/LODGIVA_PMS_DEPLOYMENT.md](docs/LODGIVA_PMS_DEPLOYMENT.md)).
- **(PMS)** Lodgiva branding throughout: name, logo, favicon, login and desk.
  The app moved from `/kamra` to `/lodgiva`, and old links redirect.
- **(PMS)** A Nigeria country pack: ₦ NGN, VAT 7.5% on one line, TIN, naira
  and kobo in words.
- **(PMS)** Nigerian defaults: Africa/Lagos, POS Terminal as a tender,
  Nigerian nationality, NIN as an ID type.
- **(PMS)** Real photos, room descriptions and a Lagos cover image for the
  demo hotel's booking page (Unsplash License, credited).

### Fixed
- **(PMS)** A guest could check out while still owing money. Now refused.
- **(PMS)** A bill that still owed money could be closed and given an invoice
  number. Now refused.
- **(PMS)** The same bank-transfer reference could be recorded twice. Now
  refused as a duplicate.
- **(PMS)** Naira payments were stored as INR. They're now stored as NGN.
- **(PMS)** On a first login or a new browser, every screen asked for Kamra's
  own demo hotel. The tape chart and settings crashed. Screens now wait until
  the real hotel is known.
- **(PMS)** India-only assumptions: "GST Act" on invoices, rupee icons,
  "Folio ₹" in guest history, and Indian nationality and Aadhaar defaults.
- **(PMS)** Desk actions in guest history were credited to "None".
- **(PMS)** The public booking page and the housekeeping phone app called a
  staff-only endpoint.
- **(PMS)** Live updates between staff screens didn't work on the laptop demo.

### Security
- **(PMS)** Before the demo went public: developer mode switched off, and
  confirmed that none of Kamra's published demo logins exist on the site.

---

## 2026-09-17 – 2026-09-19

### Added
- [ADR-001](docs/adr/ADR-001-kamra-fork-evaluation.md): an evaluation of
  building the PMS on Kamra, and a verified source audit
  ([gap matrix §7](docs/LODGIVA_GAP_MATRIX.md)).
- A route-permission test that **fails the build** when a route lacks a
  permission check or a documented reason to be open.

### Fixed
- Six routes had no permission check (L-05, L-06, L-24).

### Security
- `db:reset` now refuses any database that isn't local and named `*_test`,
  and never prints the connection string.

---

## 2026-09-09

### Fixed
- **Any signed-in user could move money** (L-01): folios, payments, night
  audit, cashiering and invoices had no permission checks.
- Staff could read other properties' folios within the same tenant.
- **VAT-inclusive prices** added the tax on top instead of extracting it.
- A refused checkout lost the nights it had just posted. They now survive the
  refusal.
- A hotel owner couldn't run a stay end to end. The owner role gained desk
  permissions but still can't approve their own cash drawer.

### Removed
- **The sandbox payment adapter**, which reported payments as successful
  without moving money. Non-cash tenders now require a reference.

---

## 2026-09-03 – 2026-09-08

### Added
- **The whole API runs inside Next.js**, so one Vercel project serves the
  product ([deploy-vercel.md](docs/deploy-vercel.md)).
- A Render blueprint for running the API as a standalone server.
- Self-serve sign-up.
- A production bootstrap that creates exactly one real tenant, property and
  owner.
- Startup safety checks that refuse unsafe production configuration.

### Changed
- The Next.js dashboard was connected to real authentication and APIs:
  reservations, folios, guests, reports, settings and team.
- POS, cashiering and payments were removed from the Next.js dashboard. The
  API keeps them.
- Reservation filtering moved to the server.

### Security
- Hardened authentication and production infrastructure. The worker's queries
  are now scoped by tenant.

---

## 2026-07-29 – 2026-08-02

### Added
- The platform: a pnpm/Turborepo monorepo, the NestJS API, the Prisma schema
  with PostgreSQL row-level security, the outbox worker, and the Vite
  dashboard PWA.
- Identity, tenancy, roles and permissions; property configuration; MFA
  (TOTP).
- Reservations: quotes, holds, concurrency-safe inventory, modifications,
  room moves, stay extensions and confirmation codes.
- Front desk worklists, split folios, invoicing, and a calendar with drag and
  drop.
- A versioned tax engine, rate plans, restrictions and an approvals engine.
- A payment gateway with signed webhooks, refunds, settlements and
  reconciliation, plus settlement CSV import.
- POS with void approvals, cashiering, maintenance, and a night-audit state
  machine.
- File storage, PDF output, CSV and report exports.
- A mobile room board, offline reads (IndexedDB), live updates and push
  notifications.
- An inventory ledger, reporting analytics, feature flags, observability and
  operations scripts.
- The landing page.
