# Deploying the Lodgiva PMS (Kamra fork) — demo and production

Written 2026-09-21, after the vertical slice in `LODGIVA_GAP_MATRIX.md` §8.
Two routes: **demo it today** on the machine where it already runs, and
**put it on a domain** so other people can use it.

The one rule that shapes everything: **Frappe cannot run on Vercel.** It needs
long-lived processes — web, websocket, scheduler, workers — plus MariaDB and
Redis. The marketing site stays on Vercel; the PMS gets its own host.

---

## Part 1 — Demo it today (already installed)

Everything below is already built on this machine, in WSL distro
`Ubuntu-24.04`, bench `~/kamra-bench`, site `kamra.localhost`.

### Start it

Two processes, each in **its own PowerShell window**, left open while you
demo. WSL shuts its VM down when nothing is holding it, so these windows are
the thing keeping it alive.

Window 1 — the database:

```powershell
wsl -d Ubuntu-24.04 -u frappe -- bash /home/frappe/kamra-mariadb.sh --foreground
```

Window 2 — the site:

```powershell
wsl -d Ubuntu-24.04 -u frappe -- bash /home/frappe/kamra-serve.sh
```

Then open **http://localhost:8001/kamra**.

### Log in

**The username is `Administrator`, not your email address.** A fresh Frappe
site has exactly one account and it is not tied to your GitHub or Google
identity; signing in with a personal email returns "Wrong email, username, or
password" because no such user exists yet. Add real staff accounts afterwards
from `/app/user`.

The admin password was generated during install and never printed. Read it
yourself:

```powershell
wsl -d Ubuntu-24.04 -u frappe -- cat /home/frappe/.kamra-slice-credentials
```

User `Administrator`, password `SITE_ADMIN_PASSWORD` from that file. Treat
that file as a secret; it is fine for a local demo and must not travel to a
real deployment.

### What to show, in this order

| # | URL | What it proves |
| --- | --- | --- |
| 1 | `/book` | **No login needed.** The public booking engine for "Lodgiva Demo Hotel, Ikeja" priced in naira — ₦96,750 for two nights, taxes in. The best opener: it looks like a product, instantly |
| 2 | `/kamra` | Front desk: today board, arrivals, departures, the tape chart |
| 3 | `/kamra/setup` | Hotel onboarding — property, room types, rooms, rates |
| 4 | `/hk` | Housekeeping, on a phone-shaped screen |
| 5 | `/app` | Frappe Desk — the admin escape hatch. Useful for showing the audit trail |

### The money story — the part worth rehearsing

This is what separates the demo from a screenshot tour. Take a booking,
check in, run the night audit, then **try to check the guest out without
taking payment**. Lodgiva refuses:

> Ngozi Eze still owes 91375.0 on this stay. Take payment, move the balance to
> a company or city-ledger folio, or post an allowance with a reason before
> checking out.

Stock Kamra allows that departure — verified on 2026-09-21, gap matrix §8.
Then take the payment as a **bank transfer** with the sender's narration as the
reference, and try to post the same reference twice. Refused as a duplicate.
Then check out: it goes through, and the folio closes with invoice
`INV-LDH-26-#####` in naira, VAT shown as VAT and the TIN labelled TIN.

That sequence — refuse, settle, depart, invoice — is the demo. It shows the
product and the controls in ninety seconds.

### Stop it

Close both windows, or:

```powershell
wsl -d Ubuntu-24.04 --shutdown
```

---

## Part 2 — Put it on a domain

Target from the milestone plan: marketing stays at `lodgiva.com` on Vercel,
PMS at `app.lodgiva.com`. Kamra's own quickstart is the Docker route; these
are the same steps with Lodgiva's app added.

### Step 0 — the repositories (done)

Two public repositories, as the milestone plan's branch strategy describes:

| Repository | Contents |
| --- | --- |
| [`Obiajulu-gif/lodgiva-pms`](https://github.com/Obiajulu-gif/lodgiva-pms) | The branded Kamra fork. `upstream` points at Kamra-PMS/kamra-pms so security fixes can be pulled deliberately |
| [`Obiajulu-gif/lodgiva-nigeria`](https://github.com/Obiajulu-gif/lodgiva-nigeria) | The Nigerian country pack, financial controls and Lodgiva branding |

They are **public on purpose**. Kamra is AGPL-3.0: serving a modified version
over a network obliges Lodgiva to offer the corresponding source to its users,
and the footer's "source" link points at `lodgiva-pms`. Making them private
means finding another lawful way to deliver source to every user — possible,
but decide it deliberately rather than by accident.

### Step 1 — the server

Ubuntu 22.04 or 24.04, **2 vCPU · 4 GB RAM · 40 GB disk** as the floor;
double the RAM if the pilot hotel has real traffic. Docker Engine 24+ with
Compose v2. Point `app.lodgiva.com` at its IP before you start, so
certificate issuance works first time.

### Step 2 — build an image containing all three apps

```bash
git clone https://github.com/frappe/frappe_docker
cd frappe_docker
```

`apps.json` — Kamra pinned to the stable tag, never `develop`:

```json
[
  { "url": "https://github.com/frappe/payments", "branch": "develop" },
  { "url": "https://github.com/Obiajulu-gif/lodgiva-pms", "branch": "main" },
  { "url": "https://github.com/Obiajulu-gif/lodgiva-nigeria", "branch": "main" }
]
```

Note it pulls **`lodgiva-pms`, not upstream Kamra** — that fork carries the
rebrand. The app inside it is still called `kamra`, so `bench install-app
kamra` is correct; only the branding differs.

```bash
export APPS_JSON_BASE64=$(base64 -w 0 apps.json)
docker build \
  --build-arg=FRAPPE_PATH=https://github.com/frappe/frappe \
  --build-arg=FRAPPE_BRANCH=v16.25.0 \
  --build-arg=APPS_JSON_BASE64=$APPS_JSON_BASE64 \
  --tag=lodgiva-pms:2.6.2 \
  --file=images/layered/Containerfile .
```

### Step 3 — bring the stack up

Use `compose.yaml` with the MariaDB, Redis and HTTPS overrides, setting
`SITES=app.lodgiva.com` and your image. Then create the site:

```bash
docker compose exec backend bench new-site app.lodgiva.com \
  --admin-password '<choose-a-strong-one>' \
  --db-root-password '<db-root>' \
  --install-app payments --install-app kamra --install-app lodgiva_nigeria

docker compose exec backend bench --site app.lodgiva.com enable-scheduler
docker compose exec backend bench --site app.lodgiva.com set-config server_script_enabled 1
```

Installing `lodgiva_nigeria` runs its `after_migrate` hook, which applies the
Nigerian defaults — NGN currency, `Africa/Lagos`, TIN labels, POS Terminal as
a tender — and its controls take effect immediately. Confirm with:

```bash
docker compose exec backend bench --site app.lodgiva.com list-apps
```

**The scheduler matters.** Night audit, business-date rollover and no-show
flagging are scheduled jobs. A PMS without a running scheduler quietly stops
posting room charges.

### Step 4 — first-run setup

Open `https://app.lodgiva.com/kamra/setup` and create the property. Set
**country Nigeria** — that one field is what makes every downstream money
decision use the Nigerian pack. Leaving it blank makes Kamra fall back to
India.

### Step 5 — point the landing page at it

Keep `lodgiva.com` on Vercel and send `/dashboard` to the PMS. In
`apps/marketing-web/next.config.ts`:

```ts
async redirects() {
  return [
    { source: "/dashboard", destination: "https://app.lodgiva.com/kamra", permanent: false },
    { source: "/dashboard/:path*", destination: "https://app.lodgiva.com/kamra", permanent: false },
  ];
}
```

**Not applied in this repository yet** — it would take the existing Next.js
dashboard out of service, which is a cutover decision, not a deployment
detail. The milestone plan is explicit that the current stack stays available
as a fallback until parity is signed off.

---

---

## Part 3 — hosting it for free

Frappe needs about **4 GB of RAM, a persistent disk and processes that never
sleep**. That single sentence eliminates most "free tier" hosting, so the
honest shortlist is short. Ranked by what actually works:

### 1. Cloudflare Tunnel — free, live in five minutes, best for a client demo

Publishes the bench already running on this machine at a real HTTPS URL. No
server, no card, no build. The laptop must stay on and connected — which is
fine for a scheduled demo and useless as production.

```bash
# in WSL, with the site already served on 8001
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
chmod +x cloudflared
./cloudflared tunnel --url http://localhost:8001
```

It prints a `https://something.trycloudflare.com` URL. One extra step, or
Frappe will refuse the unfamiliar host:

```bash
bench --site kamra.localhost add-to-hosts        # optional, local convenience
bench --site kamra.localhost set-config host_name https://<that-url>
```

Free, genuinely instant, and the guest-facing `/book` page works over it.

### 2. Oracle Cloud Always Free — free forever, and big enough to mean it

The only free tier that can really run a PMS: **4 Arm CPUs and 24 GB RAM**
across your Always Free allowance, plus 200 GB of block storage. That is more
than the 2 vCPU / 4 GB the Docker route asks for.

- Create an Always Free **Ampere A1** instance, Ubuntu 24.04, 4 OCPU / 24 GB.
- Open ports 80 and 443 in both the VCN security list **and** `iptables` —
  Oracle's Ubuntu images ship with a restrictive firewall, and this is the
  step everyone misses.
- Follow Part 2 unchanged. Build on the instance itself: it is ARM64, so an
  image built on an x86 laptop will not run.

Two honest caveats: Ampere capacity is genuinely scarce in popular regions and
you may hit "out of host capacity" for days — pick a quieter region at sign-up.
And a card is required for identity verification even though the tier is free.

### 3. Frappe Cloud — not free, but the least work

A free trial, then roughly $10–25/month. It handles backups, SSL, updates and
the scheduler. Kamra is on the Frappe Cloud marketplace; a private bench there
can install `lodgiva-pms` and `lodgiva-nigeria` from git. If the pilot hotel is
paying anything at all, this is cheaper than your time.

### What does not work, and why

| Platform | Why not |
| --- | --- |
| **Vercel / Netlify** | Serverless. No long-lived process, no MariaDB, no scheduler. The marketing site belongs here; the PMS cannot |
| **AWS / GCP / Azure free tiers** | 1 GB RAM (`t3.micro`, `e2-micro`, `B1s`). Frappe's build and worker processes thrash and get OOM-killed. Also expires after 12 months |
| **Render / Railway free** | No persistent MariaDB on the free plan, and free web services sleep. A PMS that sleeps stops running the night audit |
| **Heroku** | No free dynos any more |

**Recommendation:** Cloudflare Tunnel for the demo this week, Oracle Always
Free for a pilot that has to stay up, Frappe Cloud the moment real hotel money
depends on it being someone's job to keep it alive.

---

## Before a real hotel uses this

Not blockers for a demo. Blockers for money.

- **AGPL.** Kamra is AGPL-3.0 and Lodgiva serves it over a network, so the
  corresponding source must be offered to users. Keep the licence notices,
  and put a visible Source link in the UI. The booking page currently reads
  "Powered by Kamra"; rebranding it is fine, removing attribution and the
  source offer is not.
- **Payments.** Paystack is not wired up. Today's tenders are cash, bank
  transfer and POS terminal, all captured with a reference. That is genuinely
  enough for a pilot, and it is what most Nigerian hotels actually take.
- **Phone numbers.** Kamra's frontend `dialForCountry()` falls back to `"91"`,
  so a Nigerian mobile can be stored as an Indian number, and nothing
  normalises server-side. Fix in the fork before real guest data lands.
- **Backups.** `bench backup --with-files` on a schedule, off the server.
  Restore-test one before go-live, not after.
- **Never point this at the Neon production database.** Different data model
  entirely; the PMS owns its own MariaDB.

## Known gaps carried forward

Still unverified: whether the invoice series stays gapless under a failed
transaction, and whether Paystack can be substituted for Razorpay from
`lodgiva_nigeria` without forking. Both are recorded in the gap matrix.
