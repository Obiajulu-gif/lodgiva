#!/usr/bin/env bash
# Serve EVERY site on the bench, resolved by Host header, instead of pinning
# one site with --site. This is what makes one bench behave like a SaaS: each
# hotel gets its own site, its own database and its own login, and the
# request's Host decides which one answers.
#
# Leaving out `--site` is not enough on its own. With `default_site` set in
# sites/common_site_config.json, bench fills the site in anyway - see
# bench_helper.py, `elif default_site := frappe.get_conf().default_site` - and
# the server binds to that one site for its whole life. Host is then never
# consulted, so every hotel's address quietly serves the default site's data.
# Nothing reports it: Desk, the API and the login page all answer normally,
# just as the wrong site. Hence the check below.
#
# A request that names no site now gets a 404 instead of a default. That is
# the trade, and it is the right way round for a SaaS.
#
# Copied into the WSL bench by scripts/lodgiva-up.sh.
set -euo pipefail

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:$PATH"
export PATH="$(echo "$PATH" | tr ':' '\n' | grep -v '^/mnt/c' | paste -sd:)"

cd "$HOME/kamra-bench"

if python3 -c 'import json,sys; sys.exit(0 if json.load(open("sites/common_site_config.json")).get("default_site") else 1)'; then
  echo "refusing to start: default_site is set in sites/common_site_config.json." >&2
  echo "It pins this server to that one site, and Host routing stops working" >&2
  echo "without any error - every hotel's address serves the default site." >&2
  echo "Remove the key from that file, then start again." >&2
  exit 1
fi

for conf in config/redis_cache.conf config/redis_queue.conf; do
  redis-server "$conf" --daemonize yes 2>/dev/null || true
done

if ! ss -ltn | grep -q ':9001 '; then
  nohup node apps/frappe/socketio.js > "$HOME/kamra-socketio.log" 2>&1 &
fi

exec bench serve --port 8002
