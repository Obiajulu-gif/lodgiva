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
- **Self-serve signup on the control site.** `/signup` (Frappe page
  `lodgiva_control/www/signup`) saves a Draft Hotel Environment, emails a
  confirmation link, and only then submits it to the normal provisioning
  queue. Rate-limited to 5 per IP per hour. Caddy now sends `/signup` there
  instead of to `/login`.
- **Named owner accounts.** Provisioning creates the owner's own user on the
  new site (Hotel Admin, Front Desk, Housekeeping, Finance, Revenue Manager)
  and emails a one-time, two-day activation link. The link is never written
  to the provisioning log. Operators can **Resend activation** from the
  Hotels Console.
- **Group Dashboard (PMS `/group`).** (PMS) All Properties (occupancy, room
  revenue, ADR, RevPAR, arrivals, departures, out-of-service rooms for a date
  range), Daily Close (business date, close status, open cashiers, blockers
  with a link to the screen that clears each one) and Finance (cash, bank
  transfer, POS terminal, Paystack, refunds, outstanding folios, unmatched
  payments, cashier variances). Numbers come from the same queries as the
  property reports. Anything not yet through night audit is marked
  provisional. Clicking a hotel switches to it.
- **Reconciliation queue (PMS `/reconciliation`).** (PMS) A new `Payment
  Match` doctype in lodgiva-nigeria. Load bank statement, POS batch or
  Paystack lines (CSV); each line is matched to a folio, suggested, or left
  unmatched. Finance resolves with Post / Match / Ignore and a required
  note, and who did it is recorded. Includes a daily accounting CSV export.
- **Platform exceptions queue (Hotels Console).** Failed or stuck
  provisioning, scheduler not running, missed night audits, missing or
  stale off-server backups, overdue subscriptions, and a subscription access
  mode the site is not actually applying. Each entry shows the site, what
  happened, when, and the next action. Each site also shows its deployed
  version, health-check time, last local backup, last off-server copy, last
  verified restore and grace end.
- **Scoped support access.** `Support Access Grant`: one site, a reason, at
  most 24 hours. Granting creates a dedicated support user on that site only
  and shows the password once. An hourly job (or Revoke) disables it.
- **Off-server backups and restore rehearsal.**
  `lodgiva_control.backups.offsite(site, target)` backs up with files,
  checksums the copy (rclone remote or another disk), and records counts at
  backup time. `backups.rehearse(site, dir, "rehearsal-<x>")` restores into
  a disposable site, verifies reservations, folios, payments and
  attachments, and records how long it took and how recent the data is.
- **WhatsApp delivery status and pre-arrival reminders.** (PMS) Meta
  delivery receipts (sent / delivered / read / failed) update each message,
  and a late receipt can't move a status backwards. A daily reminder goes
  to tomorrow's arrivals (template `tpl_prearrival`), once per stay. Setting
  `lodgiva_whatsapp_test_recipients` in site config limits every send to
  those numbers, for staging.
- **Release pins.** `deploy/oracle/release.lock` records the exact Frappe,
  frappe_docker, payments, PMS and Nigeria revisions. `setup.sh` refuses to
  build if a ref has moved since, and labels the image with the release.
- **CI.** (PMS) Integrity checks run under real concurrency
  (`kamra/scripts/integrity_checks.py`, 8 checks). A new `upgrade` job
  installs the previous release with data, migrates to the PR, and re-runs
  the checks.

### Fixed (enterprise foundation)
- **Every customer hostname reached the same hotel.** `setup.sh` forced
  `FRAPPE_SITE_NAME_HEADER` to the landing site. It now passes Caddy's
  header through, and Frappe otherwise routes by Host.
- **Staff could reach other properties through the API.** (PMS) Most Kamra
  methods read with `get_all` or SQL, which ignore User Permissions. A new
  auth hook (`kamra/property_guard.py`) refuses any call whose `property`,
  reservation, folio, order, room or similar argument belongs to a property
  outside the user's permissions.
- **Two unassigned bookings could take the last room.** (PMS) The room-type
  capacity count was a plain read. It is now a locking read.
- **Concurrent gateway retries could credit a folio twice, and link
  payments skipped the ledger.** (PMS) `post_link_payment` now locks the
  folio, checks the reference with a locking read, and writes the ledger
  row that a desk payment writes. Paystack retries that lose the lock are
  retried and answer 200.
- **Paystack credited any signed charge to the folio named in its
  metadata.** (PMS) A charge is now posted only if the reference was issued
  for that folio and the currency matches. Anything else is parked as
  Unmatched in the reconciliation queue.
- **Overlapping night audits could post a night twice, and a failed
  property's half-posted audit was committed by the next property.** (PMS)
  The audit now takes a property lock, re-checks with a locking read, and
  rolls back a failed property before moving on.
- **WhatsApp webhooks were unsigned.** (PMS) When a connection has its Meta
  app secret, `X-Hub-Signature-256` is now verified.
- **Customer environment provisioning.** A new Frappe app,
  [frappe-apps/lodgiva_control](frappe-apps/lodgiva_control), creates one
  Lodgiva site per hotel customer. An operator fills a form in Frappe Desk
  (customer, subdomain, owner, hotel, room types and rooms) and a background
  job runs `bench new-site` and seeds the property through
  `kamra.api.setup_property`. v1 does create and list only; suspend, backup,
  restore and delete stay manual `bench` commands on purpose. Design and
  rationale in the app's
  [README](frappe-apps/lodgiva_control/README.md).
- **Customer subdomains on the server.** `deploy/oracle/Caddyfile` gains a
  `*.$LODGIVA_APEX` block, and `setup.sh` exports `LODGIVA_APEX` (defaulting to
  the public domain) so hotels live under the same name as the landing page.
- **A `/admin` route** to the provisioning console, in
  [deploy/oracle/Caddyfile.routes](deploy/oracle/Caddyfile.routes). A redirect
  rather than a path prefix: Frappe Desk owns `/app`, `/api` and `/assets` at
  the root, so a second Frappe surface cannot be mounted beneath `/admin`
  without those calls reaching the wrong site.
- **A PMS demo walkthrough**
  ([docs/LODGIVA_PMS_WALKTHROUGH.md](docs/LODGIVA_PMS_WALKTHROUGH.md)) — what to
  say for each of the ten `/lodgiva` sections, drawn from the app's own launcher
  definitions.
- **Hotels Console** (`/app/hotels-console` on the control site; `/admin` now
  lands there). One page listing every hotel on the platform: provisioning
  status, plan and subscription state, and a live health read of each hotel's
  own site (staff accounts, last sign-in, rooms, bookings in 30 days, business
  date, overdue departures, server errors, scheduler). Each hotel carries a list
  of issues worded as the action to take, worst first, plus buttons to open the
  site, open the record and log, retry a failed provision, mark a subscription
  paid or email the owner. Sites on disk with no record are listed too, since
  nothing else bills or sweeps them. Details in the app's
  [README](frappe-apps/lodgiva_control/README.md#hotels-console).
- **(PMS) Paystack payment links in naira.** Payment links now use the
  property's currency from the localisation pack instead of a hard-coded INR,
  and `lodgiva_nigeria` registers a Paystack gateway (signed `charge.success`
  webhook at `/api/method/lodgiva_nigeria.paystack.webhook`). With test mode on,
  a link opens a built-in test checkout that posts the payment to the folio,
  idempotent on the reference.
- **(PMS) Payment link straight after booking.** The booking dialog's
  confirmation offers "Get payment link" for the stay total, and the folio's
  Payment link button now shows the link, amount, Copy and Open instead of
  silently writing to the clipboard. "copy check-in link" on Today confirms the
  copy.
- **(PMS) Night-audit catch-up and overdue departures.** A stalled business date
  is rolled forward one audited day at a time (capped at 370), and Today shows
  guests still checked in past their departure date.

### Changed
- The nightly backup cron in `setup.sh` now runs `bench --site all backup`
  instead of naming one site, so customers created later are included. Pinned to
  a single site, every new environment would have gone unbacked.
- **The local stack now runs the Frappe scheduler** alongside the worker
  ([scripts/lodgiva-worker.sh](scripts/lodgiva-worker.sh)). Without it no
  scheduled job was ever enqueued: the PMS night audit never ran (the demo's
  business date was found 13 days behind) and the daily subscription sweep never
  ended a trial.
- **(PMS)** The app switcher in the PMS top bar is a labelled, bordered "Apps"
  button with a chevron instead of a bare grid icon nobody read as clickable.

### Fixed
- **Every hotel's address served the same site.** `bench serve` was started
  without `--site`, which looks like multi-site serving but is not: bench
  substitutes `default_site` from `sites/common_site_config.json`, the server
  binds to that one site, and the `Host` header is never read again. Nothing
  reported it — Desk, the API and the login page all answered normally, as the
  wrong site — so it surfaced only as a login being refused against another
  site's user list. Removing `default_site` restores per-`Host` resolution, and
  [scripts/kamra-serve-multi.sh](scripts/kamra-serve-multi.sh) now refuses to
  start while the key is set. A request naming no site gets a 404 instead of a
  default, which is the right way round for a SaaS.
- **`/admin` reached a site without the console installed**, answering "Page
  hotel-environment not found". The console lives on its own site; the console
  origin (`:8011` locally) now names that site with `X-Frappe-Site-Name` rather
  than by rewriting `Host`, which the realtime server rejects.
- **Live updates never connected on either origin** ("Invalid origin"). The
  realtime server refuses a connection whose `Host` and `Origin` hostnames
  disagree. A stock bench reaches it cross-origin on its own port, so browsers
  always send `Origin`; proxying `/socket.io` onto the same origin makes the
  handshake same-origin, and browsers omit `Origin` there. Both headers are now
  set in the proxy, with the port kept — dropping it aims the server's
  session callback at port 80.
- **Every Vercel build of `main` failed since 2026-09-22** with
  `@prisma/client has no exported member 'PrismaClient'`. `packages/database`
  declared no TypeScript, so pnpm paired its Prisma client with the TypeScript 7
  the docs app pulls in; `prisma generate` filled that copy while `apps/api`
  imported the TypeScript 5 copy, which stayed empty. Builds only passed from
  cache. `packages/database` now pins `typescript ^5.8.3`.
- **(PMS) Guests could check out owing their room.** The settlement control ran
  in `before_save`, but checkout posts the nights the night audit has not
  reached (`post_remaining_nights`) afterwards, in `on_update`. A stay passed
  the check at a zero balance and left owing; eleven demo stays did. The control
  now runs again after posting, and refusing there rolls the checkout back.
- **(PMS) Payment links pointed at a dead tunnel.** A stale `host_name` in the
  demo site's config made every generated link use an old trycloudflare
  address; links now use the address the desk is on.
- **(PMS) Cancelling a booking left an empty open bill** when a prepayment link
  had opened its folio. An untouched folio is now closed (without an invoice
  number) on cancel.
- **(PMS) Long emails overflowed the registration card** (GRC); values now wrap
  inside their column.
- **(PMS) Nigerian phone numbers saved as +91.** The phone field defaulted to
  India's dial code. Five demo guests were corrected to +234, each with a
  comment on the record.

### Security
- The control site's setup script no longer falls back to a fixed
  Administrator password; it generates one and prints it once.
- Provisioning stores each hotel's generated admin password encrypted instead
  of in plain text on the Hotel Environment record.
- **(PMS)** The test checkout records a payment only on a POST from its Pay
  button. As a GET, a link preview in WhatsApp or mail could have marked a stay
  paid.
- Customer certificates are issued on demand and gated by
  `lodgiva_control.api.allow_host`, which answers only for hostnames that exist
  as site directories. Without the gate, anyone pointing a DNS record at the
  server could force certificate issuance and exhaust the Let's Encrypt limit of
  50 per registered domain per week, taking live customers offline.

- **The documentation site.** Sixty-six pages covering the PMS as it actually
  works — getting started, rooms and rates, front desk, guests, billing,
  housekeeping, administration, installation, a hand-written API reference and
  resources — at [apps/docs](apps/docs), live at
  <https://lodgiva-docs.vercel.app>. Every claim was checked against the
  running product, and anything not built carries a status label rather than
  being described as available. Deployment steps in
  [docs/deploy-docs.md](docs/deploy-docs.md).
- A documentation home organised by task ([docs/README.md](docs/README.md)),
  an end-to-end architecture reference ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)),
  a reference for every environment variable
  ([docs/CONFIGURATION.md](docs/CONFIGURATION.md)), this changelog, and a
  pull-request checklist that keeps them up to date.
- [deploy/README.md](deploy/README.md): hosting options compared for
  sign-ups from Nigeria, including which providers take PayPal.
- The README now shows how to start every local server: the PMS demo
  (database, PMS, router, optional public tunnel) and the landing page, with
  sign-in and troubleshooting steps.

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
  2026-09-09. It also carried stale test counts; the unit suite is 156 tests.

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
