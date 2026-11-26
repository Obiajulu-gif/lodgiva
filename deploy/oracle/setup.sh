#!/usr/bin/env bash
# Lodgiva on any Ubuntu 22.04/24.04 server - one command, on a fresh VM.
# Needs 2 GB RAM and about 25 GB of disk for a test install (lite mode, chosen
# automatically under 6 GB of RAM); 4 GB or more for real hotels. Works on
# Oracle Cloud, DigitalOcean, Hetzner, Contabo, AWS, Google Cloud and Azure.
#
#   curl -fsSL https://raw.githubusercontent.com/Obiajulu-gif/lodgiva/main/deploy/oracle/setup.sh -o setup.sh
#   sudo bash setup.sh                                  # free https://<ip>.sslip.io
#   sudo LODGIVA_DOMAIN=demo.lodgiva.com bash setup.sh  # your own domain
#   sudo DEMO_HOTEL=1 bash setup.sh                     # also create a sample Lagos hotel
#   sudo LITE=0 bash setup.sh                           # full services even on a small VM
#   sudo BUILD_LOCALLY=1 bash setup.sh                  # build the image here (needs 4 GB)
#
# The server image is built by GitHub ("Server image" workflow) and pulled
# from ghcr.io, so a small VM never has to build it.
#
# What you get: the Lodgiva landing page at /, the PMS at /lodgiva, the
# guest booking page at /book, HTTPS, and Frappe's scheduler running (it
# posts room charges every night - without it the PMS silently stops).
#
# Re-running is safe: finished steps are skipped.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }

SITE="lodgiva.local"          # internal Frappe site name; the public host is separate
WORK="/opt/lodgiva"
SECRETS="$WORK/secrets.env"   # generated once, 0600, never printed
# Which branch of Obiajulu-gif/lodgiva to take the router config from.
LODGIVA_REF="${LODGIVA_REF:-main}"
REPO_RAW="https://raw.githubusercontent.com/Obiajulu-gif/lodgiva/${LODGIVA_REF}/deploy/oracle"

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
mkdir -p "$WORK"; cd "$WORK"

# ── Release: pinned app revisions and the image they make (release.sh) ────
# release.sh is shared with the "Server image" workflow, so the image this
# script asks for is named exactly as the one GitHub built.
for f in release.lock release.sh control.Containerfile compose.lite.yaml; do
  curl -fsSL "$REPO_RAW/$f" -o "$f"
done
# shellcheck disable=SC1091
. ./release.sh

# ── Size: lite mode for small VMs ─────────────────────────────────────────
MEM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
LITE="${LITE:-auto}"
if [ "$LITE" = auto ]; then
  if [ "$MEM_MB" -lt 6000 ]; then LITE=1; else LITE=0; fi
fi
DISK_FREE_GB="$(df -BG --output=avail / | tail -1 | tr -dc '0-9')"
if [ "${DISK_FREE_GB:-0}" -lt 15 ]; then
  echo "Only ${DISK_FREE_GB} GB free on /. Lodgiva needs about 15 GB for the image, data and swap." >&2
  exit 1
fi

# ── 0. Address ────────────────────────────────────────────────────────────
PUBLIC_IP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me)"
LODGIVA_DOMAIN="${LODGIVA_DOMAIN:-${PUBLIC_IP//./-}.sslip.io}"
# Optional: Let's Encrypt uses it only for expiry warnings. None is invented -
# a made-up address can get the certificate request refused.
ACME_EMAIL="${ACME_EMAIL:-}"
# Customer environments are created as <customer>.$LODGIVA_APEX. Defaults to the
# public domain, so hotels live under the same name as the landing page. Set
# after LODGIVA_DOMAIN above, which it falls back to.
LODGIVA_APEX="${LODGIVA_APEX:-$LODGIVA_DOMAIN}"
log "Public address: https://${LODGIVA_DOMAIN}"
log "Customer environments: https://<customer>.${LODGIVA_APEX}"
log "Release $RELEASE on ${MEM_MB} MB RAM ($([ "$LITE" = 1 ] && echo lite || echo full) mode)"

# ── 1. Swap: the SPA build is memory-hungry even on 24 GB shapes ─────────
if ! swapon --show | grep -q /swapfile; then
  log "Adding 4 GB swap"
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ── 2. Firewall ──────────────────────────────────────────────────────────
# Oracle's Ubuntu image rejects 80/443 in iptables, and its cloud firewall
# must ALSO allow them (see README). Other providers start with an empty,
# open chain. Inserting at the top works for both - inserting at a fixed
# position fails on an empty chain and would abort the whole install.
log "Opening ports 80 and 443 in the host firewall"
for p in 80 443; do
  iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null \
    || iptables -I INPUT -p tcp -m state --state NEW --dport "$p" -j ACCEPT
done
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
fi
# A fresh VM's package index is empty; without this, installs can fail
# with "Unable to locate package".
apt-get update -q >/dev/null
DEBIAN_FRONTEND=noninteractive apt-get install -y -q iptables-persistent >/dev/null
netfilter-persistent save >/dev/null

# ── 3. Docker ─────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null; then
  log "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null

# ── 4. Secrets, generated once ────────────────────────────────────────────
if [ ! -f "$SECRETS" ]; then
  umask 077
  cat > "$SECRETS" <<EOF
DB_PASSWORD=$(openssl rand -hex 24)
ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)
EOF
fi
# Added later than the two above, so an existing install gets it on re-run.
if ! grep -q '^CONTROL_ADMIN_PASSWORD=' "$SECRETS"; then
  ( umask 077; echo "CONTROL_ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)" >> "$SECRETS" )
fi
# shellcheck disable=SC1090
. "$SECRETS"

# ── 5. The image: pulled from ghcr.io, or built here as a fallback ───────
fetch_frappe_docker   # its compose files run the stack either way
built="$(docker image inspect lodgiva-pms:latest --format '{{ index .Config.Labels "lodgiva.release" }}' 2>/dev/null || true)"
if [ "$built" = "$RELEASE" ] && [ "${REBUILD:-0}" != 1 ]; then
  log "Image $RELEASE already here"
elif [ "${BUILD_LOCALLY:-0}" != 1 ] && docker pull -q "$SERVER_IMAGE:$RELEASE"; then
  log "Pulled the prebuilt image $RELEASE"
  docker tag "$SERVER_IMAGE:$RELEASE" lodgiva-pms:latest
  docker tag "$SERVER_IMAGE:$RELEASE" lodgiva-pms:"$RELEASE"
else
  if [ "$MEM_MB" -lt 3500 ]; then
    cat >&2 <<EOF

No prebuilt image for $RELEASE, and this server has ${MEM_MB} MB of RAM -
building one needs about 4 GB. Either:
  - run the "Server image" workflow on GitHub (Actions tab of
    Obiajulu-gif/lodgiva) and make the ghcr.io/obiajulu-gif/lodgiva-server
    package public, then re-run this script; or
  - use a VM with 4 GB or more.
EOF
    exit 1
  fi
  log "Building the Lodgiva image $RELEASE here (20-40 minutes on the first run)"
  build_server_image
fi
echo "$RELEASE" > "$WORK/release.txt"

# ── 6. The Frappe stack ───────────────────────────────────────────────────
log "Starting the Frappe stack"
cat > frappe.env <<EOF
CUSTOM_IMAGE=lodgiva-pms
CUSTOM_TAG=latest
PULL_POLICY=never
DB_PASSWORD=${DB_PASSWORD}
# Pass on Caddy's X-Frappe-Site-Name when it sets one (the landing domain,
# whose internal site is $SITE); otherwise empty, and Frappe routes by Host -
# one site per <customer>.<apex>. Forcing \$SITE here sent every customer's
# hostname to the same hotel.
# Single quotes: compose would otherwise expand it as a shell variable.
FRAPPE_SITE_NAME_HEADER='\$http_x_frappe_site_name'
HTTP_PUBLISH_PORT=8080
GUNICORN_WORKERS=$([ "$LITE" = 1 ] && echo 1 || echo 2)
EOF
chmod 600 frappe.env
LITE_OVERRIDE=()
[ "$LITE" = 1 ] && LITE_OVERRIDE=(-f ../compose.lite.yaml)
( cd frappe_docker && docker compose --env-file ../frappe.env \
    -f compose.yaml \
    -f overrides/compose.mariadb.yaml \
    -f overrides/compose.redis.yaml \
    -f overrides/compose.noproxy.yaml \
    "${LITE_OVERRIDE[@]}" \
    config > ../lodgiva-stack.yaml )
docker compose -p lodgiva -f lodgiva-stack.yaml up -d

log "Waiting for the database"
for _ in $(seq 1 60); do
  docker compose -p lodgiva -f lodgiva-stack.yaml exec -T db \
    mysqladmin ping -uroot -p"$DB_PASSWORD" --silent 2>/dev/null && break
  sleep 5
done

# ── 7. The site ───────────────────────────────────────────────────────────
bench() { docker compose -p lodgiva -f lodgiva-stack.yaml exec -T backend bench "$@"; }
if ! docker compose -p lodgiva -f lodgiva-stack.yaml exec -T backend test -d "sites/$SITE"; then
  log "Creating the site (installs Kamra and the Nigeria pack)"
  bench new-site "$SITE" \
    --mariadb-user-host-login-scope='%' \
    --db-root-password "$DB_PASSWORD" \
    --admin-password "$ADMIN_PASSWORD" \
    --install-app payments --install-app kamra --install-app lodgiva_nigeria
fi
bench --site "$SITE" set-config host_name "https://${LODGIVA_DOMAIN}"
bench --site "$SITE" set-config developer_mode 0
bench --site "$SITE" enable-scheduler
bench --site "$SITE" migrate     # applies Lodgiva branding and Nigerian defaults

# ── 7b. The control site: provisioning, signup, Hotels Console, billing ───
# Its own site, so a hotel's billing state can never lock out the console that
# manages billing. Customer sites are created from here as <customer>.<apex>.
CONTROL_SITE="control.${LODGIVA_APEX}"
if ! docker compose -p lodgiva -f lodgiva-stack.yaml exec -T backend test -d "sites/$CONTROL_SITE"; then
  log "Creating the control site $CONTROL_SITE"
  bench new-site "$CONTROL_SITE" \
    --mariadb-user-host-login-scope='%' \
    --db-root-password "$DB_PASSWORD" \
    --admin-password "$CONTROL_ADMIN_PASSWORD" \
    --install-app lodgiva_control
fi
bench --site "$CONTROL_SITE" set-config host_name "https://${CONTROL_SITE}"
bench --site "$CONTROL_SITE" set-config developer_mode 0
# What provisioning needs: the apex new sites hang off, and the database root
# password to create their databases (the host is the stack's db_host).
bench --site "$CONTROL_SITE" set-config lodgiva_apex "$LODGIVA_APEX" >/dev/null
bench --site "$CONTROL_SITE" set-config lodgiva_db_root_password "$DB_PASSWORD" >/dev/null
bench --site "$CONTROL_SITE" enable-scheduler
bench --site "$CONTROL_SITE" migrate

if [ "${DEMO_HOTEL:-0}" = 1 ]; then
  log "Creating the sample hotel 'Lodgiva Demo Hotel', Ikeja"
  bench --site "$SITE" execute kamra.api.setup_property --kwargs '{"payload": {
    "property": {"property_name": "Lodgiva Demo Hotel", "city": "Ikeja", "state": "Lagos",
                 "country": "Nigeria", "currency": "NGN"},
    "room_types": [{"code": "DLX", "name": "Deluxe", "base_price": 85000, "adults": 2},
                   {"code": "STD", "name": "Standard", "base_price": 45000, "adults": 2}],
    "rooms": [{"room_type_code": "DLX", "numbers": ["101", "102", "103"]},
              {"room_type_code": "STD", "numbers": ["201", "202", "203"]}]}}' \
    || echo "  (sample hotel already exists - skipped)"
  # Photos for the booking page (Unsplash License; credits ship with the app).
  bench --site "$SITE" execute lodgiva_nigeria.demo.apply_demo_photos \
    || echo "  (photos not applied - add them in Booking Settings)"
fi

# ── 8. Caddy: HTTPS, the landing page at /, the PMS behind it ────────────
log "Starting Caddy for https://${LODGIVA_DOMAIN}"
mkdir -p caddy
curl -fsSL "$REPO_RAW/Caddyfile" -o caddy/Caddyfile
curl -fsSL "$REPO_RAW/Caddyfile.routes" -o caddy/Caddyfile.routes
# Caddy's global block must come first in the file, and there may only be one,
# so the optional email and the on-demand gate are written together.
#
# The gate is not optional. Customer subdomains get their certificates issued on
# first request, and without `ask` any hostname pointed at this server would
# trigger an issuance - enough of them exhausts the Let's Encrypt limit of 50
# certificates per registered domain per week and takes real customers offline.
{
  printf '{\n'
  [ -n "$ACME_EMAIL" ] && printf '\temail %s\n' "$ACME_EMAIL"
  # The gate runs on the control site. Caddy's `ask` cannot set headers, so it
  # goes through a loopback-only Caddy listener (Caddyfile) that names the site.
  printf '\ton_demand_tls {\n\t\task http://127.0.0.1:9111/api/method/lodgiva_control.api.allow_host\n\t}\n'
  printf '}\n\n'
  cat caddy/Caddyfile
} > caddy/Caddyfile.tmp
mv caddy/Caddyfile.tmp caddy/Caddyfile
docker rm -f lodgiva-caddy >/dev/null 2>&1 || true
docker run -d --name lodgiva-caddy --restart unless-stopped --network host \
  -e LODGIVA_DOMAIN="$LODGIVA_DOMAIN" \
  -e LODGIVA_APEX="$LODGIVA_APEX" \
  -e LODGIVA_PMS_SITE="$SITE" \
  -e LODGIVA_CONTROL_SITE="$CONTROL_SITE" \
  -e LODGIVA_CONTROL_URL="https://${CONTROL_SITE}" \
  -e FRAPPE_UPSTREAM=127.0.0.1:8080 \
  -v "$WORK/caddy:/etc/caddy" -v lodgiva_caddy_data:/data \
  caddy:2 caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

# ── 9. Nightly backup (inside the stack's volume - copy it off the server) ─
cat > /etc/cron.d/lodgiva-backup <<EOF
30 2 * * * root docker compose -p lodgiva -f $WORK/lodgiva-stack.yaml exec -T backend bench --site all backup --with-files >/dev/null 2>&1
EOF

cat <<EOF

  Lodgiva is up.

    Landing page   https://${LODGIVA_DOMAIN}/
    Staff PMS      https://${LODGIVA_DOMAIN}/lodgiva
    Booking page   https://${LODGIVA_DOMAIN}/book

    Username       Administrator
    Password       sudo grep '^ADMIN_PASSWORD' $SECRETS

    Control site   https://${CONTROL_SITE}/app/hotels-console  (also /admin)
    Signup         https://${LODGIVA_DOMAIN}/signup
    Username       Administrator
    Password       sudo grep CONTROL_ADMIN_PASSWORD $SECRETS

  Customer hotels are created at https://<customer>.${LODGIVA_APEX}. That
  needs a wildcard DNS record: *.${LODGIVA_APEX} -> this server. Set an
  outgoing email account on the control site before the first signup.

  The first HTTPS request can take ~30s while the certificate is issued.
  If the site doesn't load, re-check the VCN ingress rules for 80/443.
EOF
