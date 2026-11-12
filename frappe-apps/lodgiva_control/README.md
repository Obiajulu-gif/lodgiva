# Lodgiva Control

Creates one Frappe site per hotel customer. An operator fills a form in Frappe
Desk, a background job runs `bench new-site` and seeds the hotel, and the
customer signs in at `https://<subdomain>.<apex>`.

v1 does create and list. Suspend, backup/restore, delete, plans and custom
domains are deliberately absent — each is a later field or button on the same
DocType.

## Install

The app lives in the `lodgiva` repo rather than its own, so install it from a
path:

```bash
bench get-app ./frappe-apps/lodgiva_control
bench new-site control.<apex> --install-app lodgiva_control
bench --site control.<apex> set-config lodgiva_apex <apex>
```

Give the operator the **Lodgiva Operator** role. Nothing in this app is
available to Guest except the certificate gate below.

## Migration to multi-site

The server today serves a single site pinned by `FRAPPE_SITE_NAME_HEADER`, so
every request reaches `lodgiva.local` whatever Host arrived. Customer sites
cannot exist until that is gone. Steps 3 and 4 are an outage.

1. DNS: point `<apex>` and `*.<apex>` at the server.
2. `bench --site lodgiva.local backup --with-files`, and copy the archive off
   the server before touching anything else.
3. Stop the stack and `mv sites/lodgiva.local sites/demo.<apex>`. Renaming the
   directory is enough: the database name and credentials live inside
   `sites/<site>/site_config.json`, so nothing else moves.
4. Remove `FRAPPE_SITE_NAME_HEADER` from `frappe.env`, regenerate
   `lodgiva-stack.yaml`, and start the stack. Frappe now resolves by Host.
5. `bench --site demo.<apex> set-config host_name https://demo.<apex>`
6. `bench set-config -g default_site control.<apex>`

   Required, and easy to miss. Caddy's certificate gate is called over
   `127.0.0.1:8080`, so the Host it sends is an address, not a site name. With
   no default site Frappe cannot resolve that request at all and answers an
   error, which Caddy reads as "refuse" — and then no customer site can ever
   obtain a certificate.

   This is safe **here** because the stack serves through gunicorn, which
   loads `frappe.app:application` directly and resolves every request's site
   from `X-Frappe-Site-Name` or `Host`. It is not safe under the development
   server: `bench serve` with no `--site` substitutes `default_site`
   (`bench_helper.py`, `get_sites`), binds to that one site for its whole life
   and stops reading `Host` — so every hotel's address serves the default
   site's data, with nothing in any log to say so. See
   [scripts/kamra-serve-multi.sh](../../scripts/kamra-serve-multi.sh), which
   refuses to start while the key is set.
7. Re-run `setup.sh`, or apply its Caddy changes by hand, so the global block
   carries `on_demand_tls` and the `*.<apex>` site block exists.
8. Confirm the backup cron in `/etc/cron.d/lodgiva-backup` says `--site all`.
   Pinned to one site, every customer created afterwards goes unbacked.

## The certificate gate

Customer certificates are issued on first request. That keeps the stack on the
stock `caddy:2` image, because a wildcard certificate would need a DNS-01
challenge, a Caddy built with a DNS provider module, and an API token for the
zone.

The cost is that any hostname resolving to this server would otherwise trigger
an issuance. `lodgiva_control.api.allow_host` is what stops that: Caddy asks it
before issuing, and it answers 200 only for hostnames that exist as site
directories on disk. Deliberately a filesystem check rather than a database
query, so certificates keep working while the control site is down.

Without it, a stranger can exhaust the Let's Encrypt limit of 50 certificates
per registered domain per week and take live customers offline.

## Hotels Console

`/app/hotels-console` (and `/admin` on the public origin) is the operator's
home: every Hotel Environment, plus any site directory on disk that has no
record, each with its subscription state and a health read taken on the
hotel's own site. `lodgiva_control.console.overview` builds it;
`issues_for` turns each row into actions, worst first, and is covered by
`tests/test_console.py`.

- Health is read with a short python run per site, the same way
  `scheduler.usage_for` reads usage, and cached for 5 minutes. "Re-check all
  sites" bypasses the cache. Past a few dozen hotels, have the daily sweep
  store health in a table and read that instead.
- "Open hotel site" uses `public_url` when it is live, otherwise the
  `lodgiva_hotel_url` template from the control site's config (default
  `https://{site}`; locally `http://{site}:8002`). A quick-tunnel URL is
  ignored once its cloudflared process is gone.
- A trial that ended but is still `trialing`, or a hotel whose business date
  is behind, means scheduled jobs are not running — the stack needs
  `bench schedule` as well as `bench worker`.

## Failure

A failed provision leaves `status = Failed`, the error in `provision_log`, and
the half-created site on disk. There is no automatic rollback — dropping
databases unattended is not worth automating for a case this rare. Inspect it,
remove it by hand, then resubmit; the job refuses to touch a site directory that
already exists, so a live customer can never be half-overwritten.

## Tests

```bash
bench --site control.<apex> run-tests --app lodgiva_control
```

Covers subdomain validation, every reserved name, and the certificate gate's
refusals (unknown host, traversal, absolute path, null byte).
