# Lodgiva on Oracle Cloud Always Free

> **Oracle won't accept your sign-up?** That's common, especially with
> Nigerian cards. The same installer runs unchanged on Hetzner,
> DigitalOcean, Contabo and others, several of which take PayPal. See
> **[../README.md](../README.md)**.

The result: one HTTPS address. It serves your landing page at `/`, the
staff PMS at `/lodgiva` and the guest booking page at `/book`. It stays up
without your laptop, and it costs nothing.

Oracle's Always Free tier is the only free option with enough RAM for Frappe.
Its Arm allowance is **4 CPUs and 24 GB of memory** — more than the PMS needs.

---

## 1. Create the account (15 min, done once)

1. Sign up at **cloud.oracle.com/free**. A card is required to verify
   identity; the Always Free resources are never charged.
2. **Pick your home region carefully — it can't be changed later.** Arm
   capacity is scarce in popular regions. Choose a less busy one, such as
   Johannesburg, Marseille or Stockholm, over London, Frankfurt or Ashburn,
   unless you already know one works.

## 2. Create the VM (10 min)

**Compute → Instances → Create instance**

| Setting | Value |
|---|---|
| Image | **Canonical Ubuntu 24.04** |
| Shape | **Ampere → VM.Standard.A1.Flex**, **4 OCPU, 24 GB** |
| Networking | Create a new VCN with a **public subnet**, and **assign a public IPv4 address** |
| SSH keys | "Generate a key pair" and **download the private key** — you can't get it again |
| Boot volume | 100 GB (Always Free allows up to 200 GB total) |

"Out of host capacity" means that region has no Arm capacity at the
moment. Try another availability domain, or retry later; it clears up
often. Oracle doesn't queue the request for you.

## 3. Open ports 80 and 443 in Oracle's network (5 min)

**Networking → Virtual cloud networks → your VCN → Security Lists → Default
Security List → Add Ingress Rules**

| Source CIDR | Protocol | Destination port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

The VM has its own firewall as well, and it blocks these ports too. The
setup script opens that one. Both have to be open, and missing either one
gives the same symptom: the site just times out.

## 4. Run the setup (30–50 min, mostly the first image build)

From your PC, open PowerShell in the folder holding the key you downloaded:

```powershell
ssh -i .\ssh-key-*.key ubuntu@<your-public-ip>
```

Then on the VM:

```bash
curl -fsSL https://raw.githubusercontent.com/Obiajulu-gif/lodgiva/main/deploy/oracle/setup.sh -o setup.sh
sudo DEMO_HOTEL=1 bash setup.sh
```

`DEMO_HOTEL=1` creates a sample hotel, Lodgiva Demo Hotel in Ikeja, with
six rooms priced in naira, so there's something to show straight away.
Leave it off if you want to start empty with the setup wizard.

> Until PR #1 is merged into `main`, the files only exist on the PR branch.
> Add `LODGIVA_REF=docs/kamra-source-audit` before `bash`, and use that
> branch name in the `curl` URL in place of `main`.

When it finishes, it prints your address:

```
Landing page   https://141-147-12-34.sslip.io/
Staff PMS      https://141-147-12-34.sslip.io/lodgiva
Booking page   https://141-147-12-34.sslip.io/book
```

That `sslip.io` address is a free hostname that points at your IP, and it
gets a real HTTPS certificate — no domain purchase needed.

**Log in** as `Administrator`. The password was generated during setup and
isn't printed. To read it:

```bash
sudo grep ADMIN_PASSWORD /opt/lodgiva/secrets.env
```

## 5. Use your own domain instead (optional)

Point two DNS **A records** at the VM's IP, for example:

| Name | Points at | Why |
|---|---|---|
| `demo.lodgiva.com` | VM IP | the landing page, PMS and booking page |
| `*.demo.lodgiva.com` | VM IP | the control site (`control.demo.lodgiva.com`) and every customer hotel (`<hotel>.demo.lodgiva.com`) |

Wait a few minutes, then run:

```bash
sudo LODGIVA_DOMAIN=demo.lodgiva.com ACME_EMAIL=you@example.com bash setup.sh
```

It reuses everything already built and only changes the address and the
certificate. On the free `<ip>.sslip.io` address no DNS is needed:
sslip.io resolves every subdomain to the IP, so the control site and
customer hotels work there too.

### The control site

`setup.sh` also creates `control.<apex>` with the `lodgiva_control` app:
provisioning, `/signup`, the Hotels Console (`/admin` redirects there) and
billing. Its Administrator password is in `/opt/lodgiva/secrets.env`
(`CONTROL_ADMIN_PASSWORD`). Before the first signup, add an outgoing email
account on it (**Email Account**, default outgoing). Without one, signup
confirmations and owner activation links are not sent.

`lodgiva_control` lives in this repository, not its own, so it is taken from
`LODGIVA_REF` (the same ref this script reads its config from) and added to
the image as a small last layer. A change to it rebuilds only that layer.

---

## Day to day

| Task | Command (on the VM) |
|---|---|
| Is it running? | `sudo docker ps` |
| PMS logs | `sudo docker compose -p lodgiva -f /opt/lodgiva/lodgiva-stack.yaml logs -f backend` |
| Router / HTTPS logs | `sudo docker logs -f lodgiva-caddy` |
| Deploy new code from GitHub | `sudo REBUILD=1 bash setup.sh` |
| Back up now | `sudo docker compose -p lodgiva -f /opt/lodgiva/lodgiva-stack.yaml exec backend bench --site lodgiva.local backup --with-files` |

A backup also runs every night at 02:30 and is kept inside the stack's
volume. **Before real hotel data goes in, copy backups off the VM** to
Oracle Object Storage (also free, up to 20 GB) or anywhere else. A backup
kept on the same disk as the data doesn't survive losing that disk.

## How the address is routed

```
                           ┌─ /lodgiva, /book, /app, /login, /api/method … → Frappe (this VM)
browser → Caddy (HTTPS) ───┤
                           └─ everything else (/, /_next, pricing …)     → lodgiva.vercel.app
```

The landing page is still deployed on Vercel from the `lodgiva` repo. Caddy
fetches it from there, so changes you push to the landing page appear here
without redeploying the VM. The landing page's **Log in** button opens the
PMS login. `/dashboard` goes there too. **Get started** (`/signup`) goes to
the control site's signup page, which provisions a Frappe site for the
hotel once the owner confirms their email. It never goes to the old Next.js
signup, which would create accounts in the production Neon database.

### One site per customer

Each customer is its own Frappe site and database, reached at
`<customer>.<apex>`. The frappe_docker frontend passes Caddy's
`X-Frappe-Site-Name` through (`FRAPPE_SITE_NAME_HEADER='$http_x_frappe_site_name'`).
Caddy sets it only for the landing domain, whose internal site is
`lodgiva.local`. For every other host it is empty, and Frappe routes by
Host. A hostname with no site gets a 404, and Caddy's `ask` gate refuses it
a certificate.

### Pinned releases

`release.lock` holds the exact revision of Frappe, frappe_docker, payments,
the PMS and the Nigeria pack. `setup.sh` checks each ref with
`git ls-remote` and stops if it has moved. Frappe and payments are pinned
to release tags (`v16.25.0`, `v16.0.1`), which do not move. The PMS and
Nigeria pack track `main`, so every merge there needs a deliberate bump here.

To release: update the SHAs, commit, then run `sudo REBUILD=1 bash setup.sh`.
To deploy a specific revision of this repository (config and control app),
run with `LODGIVA_REF=<sha or tag>`. The image is labelled with the full
release, including the control app's SHA (`/opt/lodgiva/release.txt`).
After a release goes live, bump `PREV_RELEASE` in lodgiva-pms's CI
`upgrade` job to the PMS SHA it replaced.

The full route list is in [`Caddyfile.routes`](Caddyfile.routes).
