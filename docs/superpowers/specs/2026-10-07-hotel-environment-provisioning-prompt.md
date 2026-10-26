# Master prompt — Lodgiva hotel environment provisioning

Paste everything below the line into a fresh session. Replace `<apex>` with the
real apex domain first; the prompt tells the agent to stop if it is still a
placeholder.

---

Build `lodgiva_control`, a Frappe app that provisions a new Lodgiva PMS
environment (one Frappe site) per hotel customer.

## Context you need before writing code

Lodgiva is a hotel management SaaS for Nigerian hotels. Two separate products
share the name; **this task targets the Frappe one, not the Next.js one**:

- `Obiajulu-gif/lodgiva` — landing page, docs, and the server deploy kit. Read
  `deploy/oracle/setup.sh`, `deploy/oracle/Caddyfile` and
  `deploy/oracle/Caddyfile.routes` before anything else. They describe the
  production server exactly.
- `Obiajulu-gif/lodgiva-pms` — the PMS itself, a fork of Kamra, installed as the
  `kamra` app. Plus `lodgiva-nigeria` (the `lodgiva_nigeria` app).

Production today: one VPS, one Docker Compose stack (project `lodgiva`, built
from `frappe_docker` with the mariadb, redis and noproxy overrides), serving a
**single** Frappe site `lodgiva.local`. Stock `caddy:2` runs on the host network
in front of it. A nightly cron backs up that one site.

The single site is pinned by `FRAPPE_SITE_NAME_HEADER=lodgiva.local` in
`frappe.env`, which makes every request serve that site whatever Host arrived.
Multi-site requires removing it. See the migration section — it is a breaking
change and must land before any customer exists.

`kamra.api.setup_property` already seeds a hotel from a JSON payload. The exact
call, with a working payload, is in `deploy/oracle/setup.sh` around line 148.
Reuse it; do not write a second seeding path.

## Decisions already made — do not revisit

- **Site per customer.** An "environment" is a real Frappe site with its own
  database, not a row in a shared table.
- **Control plane is a Frappe app in the existing bench.** A new app
  `lodgiva_control`, installed only on a `control.<apex>` site in the same
  stack. A background job shells out to `bench`. No new container, no SSH key,
  no Docker socket, no host agent. Frappe Desk supplies the list views, forms,
  permissions, job queue and audit trail — do not build a custom frontend.
- **Subdomain per customer**, `<subdomain>.<apex>`. In Frappe the site name *is*
  the hostname, so the site directory must be named exactly that.
- **On-demand TLS**, stock Caddy binary, HTTP-01. No wildcard certificate, no
  DNS-01, no `xcaddy` build, no DNS provider token.
- **Scale target is under 10 customer sites on one small VPS.** Single host. No
  placement logic, no host registry, no capacity scheduler.
- **v1 scope is create + list only.**

## Scope

In scope: create an environment, list environments, show status and the
generated admin password.

Out of scope — do not build, do not scaffold for: suspend/resume, backup or
restore UI, delete/archive, plans, billing, usage metering, custom domains,
multi-host placement, self-serve customer signup. Each is a later field or
button and none of them change this design.

## Design

### DocType `Hotel Environment`

| Field | Type | Notes |
|---|---|---|
| `customer_name` | Data, reqd | |
| `subdomain` | Data, reqd, unique | `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`; reject reserved: `www api admin control app assets files` |
| `site_name` | Data, read-only | `{subdomain}.<apex>`, computed in `validate` |
| `owner_email` | Data, reqd | |
| `property_name`, `city`, `state`, `country`, `currency` | Data | default Nigeria / NGN |
| `room_types` | Table | child: `code`, `name`, `base_price`, `adults` |
| `room_blocks` | Table | child: `room_type_code`, `numbers` |
| `status` | Select | `Draft`, `Provisioning`, `Active`, `Failed` |
| `admin_password` | Password | generated at provision |
| `provision_log` | Code, read-only | stdout/stderr appended per step |

Two child DocTypes for the tables. Field names map 1:1 onto the
`kamra.api.setup_property` payload so no translation layer is needed.

New role `Lodgiva Operator` holds all permissions. No guest access.

### Provisioning job

Enqueued on submit, `queue="long"`, runs in the worker container with cwd set to
the bench directory. Set `status = Provisioning` at step 1 so in-flight work is
visible in the list view.

1. Refuse if `sites/{site_name}` already exists → `Failed`, no side effects.
2. Generate the admin password with `secrets.token_urlsafe`.
3. `bench new-site {site} --mariadb-user-host-login-scope='%' --db-root-password $DB_PASSWORD --admin-password <generated> --install-app payments --install-app kamra --install-app lodgiva_nigeria`
4. `bench --site {site} set-config host_name https://{site}`
5. `bench --site {site} enable-scheduler`
6. `bench --site {site} execute kamra.api.setup_property --kwargs <payload built from the doc>`
7. `status = Active`

Append each step's output to `provision_log`. Steps 1–3 take minutes; nothing in
a request path may wait on them.

### `ask` endpoint — security critical

Caddy config:

```
{
  on_demand_tls {
    ask http://127.0.0.1:8080/api/method/lodgiva_control.api.allow_host
  }
}
*.<apex> {
  encode zstd gzip
  tls { on_demand }
  reverse_proxy 127.0.0.1:8080
}
```

Caddy issues a certificate only when this endpoint returns 2xx for
`?domain=<host>`. Implement it as whitelisted, guest-allowed, and answer 200
only when `sites/<domain>` exists **on disk** — a filesystem check, not a
database query, so it stays correct while the control site is down. Reject path
traversal in `domain`.

This endpoint is not optional. On-demand TLS without it lets anyone force
certificate issuance for arbitrary hostnames and exhaust the Let's Encrypt limit
of 50 certificates per registered domain per week.

### Failure handling

Any step fails → `status = Failed`, error captured in `provision_log`, job
stops. **No automatic rollback.** Leave the half-created site on disk for
inspection; cleanup is a deliberate manual step over SSH. Do not drop databases
from a background job.

Step 1's existence check is what makes retry safe: after manual cleanup the
operator resubmits, and a live customer site can never be half-overwritten.

### Migration — breaking, must land before the first customer

Steps 3–4 are an outage. Do them in this order.

1. DNS: `<apex>` and `*.<apex>` A records to the server IP.
2. `bench --site lodgiva.local backup --with-files`; copy the archive off the
   server before touching anything.
3. Stop the stack. `mv sites/lodgiva.local sites/demo.<apex>`. This works
   because the database name and credentials live in
   `sites/<site>/site_config.json`, so only the directory name changes.
4. Remove `FRAPPE_SITE_NAME_HEADER` from `frappe.env`, regenerate
   `lodgiva-stack.yaml`, start the stack. Frappe now resolves by Host header.
5. `bench --site demo.<apex> set-config host_name https://demo.<apex>`.
6. Add the `*.<apex>` block and the `on_demand_tls` global to the Caddyfile.
7. Create `control.<apex>` and install `lodgiva_control` on it.
8. Change the backup cron in `/etc/cron.d/lodgiva-backup` from `--site $SITE` to
   `--site all`, or every new customer goes unbacked.

### Tests

Keep it to three. No frameworks beyond what Frappe already provides.

- `validate_subdomain()` — table-driven: regex pass/fail, each reserved name,
  collision with an existing site directory.
- `allow_host()` — 200 for a real site directory, non-2xx for an unknown host,
  rejection of `../` traversal. This is the gate protecting certificate
  issuance.
- One end-to-end provision against a scratch bench: assert the site directory
  exists, `bench --site X list-apps` contains `kamra`, and the property row was
  created.

## Verify before you rely on them

Two things were read from `setup.sh` rather than from source, because the WSL
bench was down when this was written. Confirm both before building on them:

1. Whether the **worker** container (not only `backend`) has `DB_PASSWORD` in
   its environment. Step 3 needs it. If it does not, pass it explicitly through
   the compose override rather than hardcoding the password anywhere.
2. The exact signature of `kamra.api.setup_property` in the `lodgiva-pms` repo.

## Definition of done

- An operator logs in to `control.<apex>`, fills one form, submits, and watches
  status reach `Active`.
- The customer reaches `https://<subdomain>.<apex>`, gets a valid certificate on
  first visit, and signs in as Administrator with the generated password.
- Their hotel, room types and rooms already exist.
- The three tests pass.
- `demo.<apex>` still works, and `bench --site all backup` covers every site.

## Working rules

- Stop and ask if `<apex>` is still a placeholder.
- Follow the patterns in the existing apps; do not restructure `setup.sh` beyond
  the migration steps listed.
- Smallest change that works. No abstraction with one implementation, no config
  for a value that never changes.
- Nothing destructive runs unattended.
