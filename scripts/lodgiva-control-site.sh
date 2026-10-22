#!/usr/bin/env bash
#
# Put the control console on its own site.
#
#   bash scripts/lodgiva-control-site.sh [apex]
#
# The control plane must not be subject to the billing state it enforces.
# While lodgiva_control rides on a hotel site, that hotel going unpaid takes
# the console that manages billing read-only with it - and the person trying
# to fix the billing problem is locked out by the billing problem.
#
# Idempotent: creates the site if absent, installs the app if missing, and
# removes the app from any hotel site still carrying it.
#
# Runs inside WSL. Called by scripts/lodgiva-up.sh.
set -uo pipefail

APEX="${1:-localhost}"
SITE="control.${APEX}"
BENCH=/home/frappe/.local/bin/bench
BENCH_DIR=/home/frappe/kamra-bench

cd "$BENCH_DIR"

. /home/frappe/.kamra-slice-credentials 2>/dev/null || true

if [ ! -d "sites/$SITE" ]; then
  echo "creating $SITE"
  "$BENCH" new-site "$SITE" \
    --db-host 127.0.0.1 \
    --db-port 3307 \
    --db-root-username "${DB_ADMIN_USER:-root}" \
    --db-root-password "${DB_ADMIN_PASSWORD:-}" \
    --mariadb-user-host-login-scope=% \
    --no-mariadb-socket \
    --admin-password "${CONTROL_ADMIN_PASSWORD:-lodgivacontrol}" \
    --install-app lodgiva_control || exit 1
else
  echo "$SITE already exists"
  if ! "$BENCH" --site "$SITE" list-apps 2>/dev/null | grep -q lodgiva_control; then
    "$BENCH" --site "$SITE" install-app lodgiva_control || exit 1
  fi
fi

# Everything the provisioner and the sweep need to reach the database, the
# bench and the tunnel binary. Carried on the control site because that is
# where those jobs now run.
"$BENCH" --site "$SITE" set-config lodgiva_apex "$APEX" >/dev/null
"$BENCH" --site "$SITE" set-config lodgiva_db_host 127.0.0.1 >/dev/null
"$BENCH" --site "$SITE" set-config lodgiva_db_port 3307 >/dev/null
"$BENCH" --site "$SITE" set-config lodgiva_bench_bin "$BENCH" >/dev/null
"$BENCH" --site "$SITE" set-config lodgiva_cloudflared_bin /home/frappe/cloudflared >/dev/null
"$BENCH" --site "$SITE" set-config allow_tests true >/dev/null
if [ -n "${DB_ADMIN_USER:-}" ]; then
  "$BENCH" --site "$SITE" set-config lodgiva_db_root_user "$DB_ADMIN_USER" >/dev/null
  "$BENCH" --site "$SITE" set-config lodgiva_db_root_password "$DB_ADMIN_PASSWORD" >/dev/null
fi

# Take the app off any hotel site still carrying it. This is the demo
# shortcut being undone: /admin used to be served from the PMS site so one
# tunnel could reach both.
for hotel in $(ls sites | grep -vE '^(assets|apps\.txt|common_site_config\.json|currentsite\.txt)$'); do
  [ -d "sites/$hotel" ] || continue
  [ "$hotel" = "$SITE" ] && continue
  if "$BENCH" --site "$hotel" list-apps 2>/dev/null | grep -q lodgiva_control; then
    echo "removing lodgiva_control from $hotel"
    "$BENCH" --site "$hotel" uninstall-app lodgiva_control --yes --no-backup 2>&1 | tail -2
  fi
done

echo "CONTROL SITE READY: $SITE"
