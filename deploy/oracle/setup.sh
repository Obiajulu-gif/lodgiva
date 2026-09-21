#!/usr/bin/env bash
# Lodgiva on any Ubuntu 22.04/24.04 server - one command, on a fresh VM.
# Needs 4 GB RAM or more. Works on Oracle Cloud, DigitalOcean, Hetzner,
# Contabo, AWS, Google Cloud and Azure alike (see deploy/README.md).
#
#   curl -fsSL https://raw.githubusercontent.com/Obiajulu-gif/lodgiva/main/deploy/oracle/setup.sh -o setup.sh
#   sudo bash setup.sh                                  # free https://<ip>.sslip.io
#   sudo LODGIVA_DOMAIN=demo.lodgiva.com bash setup.sh  # your own domain
#   sudo DEMO_HOTEL=1 bash setup.sh                     # also create a sample Lagos hotel
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
FRAPPE_BRANCH="v16.25.0"
# Which branch of Obiajulu-gif/lodgiva to take the router config from.
LODGIVA_REF="${LODGIVA_REF:-main}"
REPO_RAW="https://raw.githubusercontent.com/Obiajulu-gif/lodgiva/${LODGIVA_REF}/deploy/oracle"

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
mkdir -p "$WORK"; cd "$WORK"

# ── 0. Address ────────────────────────────────────────────────────────────
PUBLIC_IP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me)"
LODGIVA_DOMAIN="${LODGIVA_DOMAIN:-${PUBLIC_IP//./-}.sslip.io}"
# Optional: Let's Encrypt uses it only for expiry warnings. None is invented -
# a made-up address can get the certificate request refused.
ACME_EMAIL="${ACME_EMAIL:-}"
log "Public address: https://${LODGIVA_DOMAIN}"

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
# shellcheck disable=SC1090
. "$SECRETS"

# ── 5. Build the image: Frappe + payments + Lodgiva PMS + Nigeria pack ───
if [ ! -d frappe_docker ]; then
  git clone --depth 1 https://github.com/frappe/frappe_docker
fi
cat > apps.json <<'EOF'
[
  { "url": "https://github.com/frappe/payments", "branch": "develop" },
  { "url": "https://github.com/Obiajulu-gif/lodgiva-pms", "branch": "main" },
  { "url": "https://github.com/Obiajulu-gif/lodgiva-nigeria", "branch": "main" }
]
EOF
if ! docker image inspect lodgiva-pms:latest >/dev/null 2>&1 || [ "${REBUILD:-0}" = 1 ]; then
  log "Building the Lodgiva image (20-40 minutes on the first run)"
  docker build \
    --build-arg=FRAPPE_PATH=https://github.com/frappe/frappe \
    --build-arg=FRAPPE_BRANCH="$FRAPPE_BRANCH" \
    --build-arg=APPS_JSON_BASE64="$(base64 -w 0 apps.json)" \
    --tag=lodgiva-pms:latest \
    --file=frappe_docker/images/layered/Containerfile frappe_docker
fi

# ── 6. The Frappe stack ───────────────────────────────────────────────────
log "Starting the Frappe stack"
cat > frappe.env <<EOF
CUSTOM_IMAGE=lodgiva-pms
CUSTOM_TAG=latest
PULL_POLICY=never
DB_PASSWORD=${DB_PASSWORD}
# Every request is for this one site, whatever Host the browser sent.
FRAPPE_SITE_NAME_HEADER=${SITE}
HTTP_PUBLISH_PORT=8080
EOF
chmod 600 frappe.env
( cd frappe_docker && docker compose --env-file ../frappe.env \
    -f compose.yaml \
    -f overrides/compose.mariadb.yaml \
    -f overrides/compose.redis.yaml \
    -f overrides/compose.noproxy.yaml \
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
if [ -n "$ACME_EMAIL" ]; then
  # Caddy's global block must come first in the file.
  printf '{\n\temail %s\n}\n\n' "$ACME_EMAIL" | cat - caddy/Caddyfile > caddy/Caddyfile.tmp
  mv caddy/Caddyfile.tmp caddy/Caddyfile
fi
docker rm -f lodgiva-caddy >/dev/null 2>&1 || true
docker run -d --name lodgiva-caddy --restart unless-stopped --network host \
  -e LODGIVA_DOMAIN="$LODGIVA_DOMAIN" \
  -e FRAPPE_UPSTREAM=127.0.0.1:8080 \
  -v "$WORK/caddy:/etc/caddy" -v lodgiva_caddy_data:/data \
  caddy:2 caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

# ── 9. Nightly backup (inside the stack's volume - copy it off the server) ─
cat > /etc/cron.d/lodgiva-backup <<EOF
30 2 * * * root docker compose -p lodgiva -f $WORK/lodgiva-stack.yaml exec -T backend bench --site $SITE backup --with-files >/dev/null 2>&1
EOF

cat <<EOF

  Lodgiva is up.

    Landing page   https://${LODGIVA_DOMAIN}/
    Staff PMS      https://${LODGIVA_DOMAIN}/lodgiva
    Booking page   https://${LODGIVA_DOMAIN}/book

    Username       Administrator
    Password       sudo grep ADMIN_PASSWORD $SECRETS

  The first HTTPS request can take ~30s while the certificate is issued.
  If the site doesn't load, re-check the VCN ingress rules for 80/443.
EOF
