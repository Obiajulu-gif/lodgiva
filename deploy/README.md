# Where to host Lodgiva

The PMS runs on **Frappe**, so it needs a real server. That means at least
**4 GB of RAM**, a disk that persists, and processes that never go to sleep:
the night audit posts room charges on a schedule. Serverless and "free web
service" platforms can't run it; the landing page stays on Vercel either way.

The installer, [`oracle/setup.sh`](oracle/setup.sh), works on **any Ubuntu
22.04 or 24.04 server**, whatever the provider. Its folder is named after the
first provider it was written for.

---

## Pick a provider

Ranked for someone setting up from Nigeria. The usual blocker there isn't
price: it's **card verification**. Many Nigerian naira cards are declined
for international cloud billing, so the payment options column matters as
much as the price column.

| Provider | Server to choose | Rough cost | Pays with | Notes |
|---|---|---|---|---|
| **Hetzner Cloud** | CX22 (2 vCPU, 4 GB) or CAX11 Arm (2 vCPU, 4 GB) | ~€4–5 / month | Card **or PayPal** | Best value. New accounts are sometimes asked for ID verification. EU and US regions |
| **DigitalOcean** | Basic Droplet, 2 vCPU / 4 GB | ~$24 / month | Card **or PayPal** | Often gives new accounts free credit. The easiest dashboard for a first server |
| **Contabo** | Cloud VPS 10 (4 vCPU, 8 GB) | ~€5–6 / month | Card **or PayPal** | Most RAM for the money. Slower support; provisioning can take hours |
| **Frappe Cloud** | Private bench (needed for our custom apps) | Check current pricing | Card | Frappe's own hosting. No server admin; backups and updates handled |
| Google Cloud | e2-medium (2 vCPU, 4 GB) | Free trial credit | Card only | Generous trial, but the card check is strict |
| AWS | t3.medium (2 vCPU, 4 GB) | Free-tier credit | Card only | Same card problem |
| Azure | B2s (2 vCPU, 4 GB) | Trial credit | Card only | Same card problem. Students: **Azure for Students** needs no card |
| Oracle Always Free | Ampere A1, 4 OCPU / 24 GB | Free | Card (verification only) | Genuinely free when sign-up works; it often rejects Nigerian cards |

Prices and trial offers change; treat them as a guide and check the provider's
page on the day.

**Recommendation.** Use **Hetzner** if the account is approved: it's the
cheapest reliable option and takes PayPal. Otherwise use **DigitalOcean**,
which also takes PayPal and has the simplest setup. If a card keeps getting
declined, a **USD virtual card** from a Nigerian fintech (the kind issued for
paying foreign subscriptions) is what people most commonly use for these
sign-ups. PayPal avoids the question entirely.

**Students:** the **GitHub Student Developer Pack** includes DigitalOcean and
Azure credit, with no card needed for Azure.

### Free, today, no account at all

The laptop demo plus **Cloudflare Tunnel** works right now and costs nothing
(see [`docs/LODGIVA_PMS_DEPLOYMENT.md`](../docs/LODGIVA_PMS_DEPLOYMENT.md)).
Its limits: the laptop must stay on and online, and the address changes on
every restart. That's fine for a scheduled demo and wrong for a hotel.

---

## Install (any provider, about 40 minutes)

1. **Create the server:** Ubuntu 24.04, at least 2 vCPU / 4 GB RAM, with a
   public IPv4 address. Add your SSH key when the provider offers it.
2. **Open ports 80 and 443** if the provider has a cloud firewall. Hetzner
   and DigitalOcean don't enable one by default; Oracle and AWS do. The
   script opens the server's own firewall itself.
3. **Connect and run** (from PowerShell on Windows):

   ```powershell
   ssh root@<server-ip>
   ```

   ```bash
   curl -fsSL https://raw.githubusercontent.com/Obiajulu-gif/lodgiva/main/deploy/oracle/setup.sh -o setup.sh
   sudo DEMO_HOTEL=1 bash setup.sh
   ```

4. **Open the address it prints**, e.g. `https://159-89-12-34.sslip.io`.
   `sslip.io` is a free hostname that points at your IP and gets a real
   HTTPS certificate, so you don't need to buy a domain for a demo.

| Option | Effect |
|---|---|
| `DEMO_HOTEL=1` | Adds the sample "Lodgiva Demo Hotel", Ikeja: rooms in naira, photos, ready to demo |
| `LODGIVA_DOMAIN=demo.lodgiva.com` | Uses your own domain. Point its DNS **A record** at the server first |
| `ACME_EMAIL=you@example.com` | Let's Encrypt emails you before a certificate would expire |
| `REBUILD=1` | Rebuilds from the latest GitHub code: your deploy command |

Sign in as **`Administrator`**. The password is generated on the server and
never printed:

```bash
sudo grep ADMIN_PASSWORD /opt/lodgiva/secrets.env
```

Day-to-day commands and the full Oracle walkthrough are in
[`oracle/README.md`](oracle/README.md).

## What gets installed

```
                           ┌─ /lodgiva, /book, /app, /login, /api/method … → Frappe (this server)
browser → Caddy (HTTPS) ───┤
                           └─ everything else (/, /_next, pricing …)     → lodgiva.vercel.app
```

- **Frappe v16.25.0** with `payments`, [`lodgiva-pms`](https://github.com/Obiajulu-gif/lodgiva-pms)
  and [`lodgiva-nigeria`](https://github.com/Obiajulu-gif/lodgiva-nigeria), built into one Docker image
- **MariaDB and Redis**, the Frappe **scheduler** and the **realtime** service
- **Caddy**, which gets and renews the HTTPS certificate and routes by path
- A **nightly backup** at 02:30, kept on the server. Copy it somewhere else
  before real hotel data depends on it.
