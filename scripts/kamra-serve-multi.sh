#!/usr/bin/env bash
# Serve EVERY site on the bench, resolved by Host header, instead of pinning
# one site with --site. This is what makes one bench behave like a SaaS: each
# hotel gets its own site, its own database and its own login, and the
# request's Host decides which one answers.
#
# Requests that do not name a site (health checks, the certificate gate) fall
# back to the bench's default_site.
#
# Copied into the WSL bench by scripts/lodgiva-up.sh.
set -euo pipefail

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:$PATH"
export PATH="$(echo "$PATH" | tr ':' '\n' | grep -v '^/mnt/c' | paste -sd:)"

cd "$HOME/kamra-bench"

for conf in config/redis_cache.conf config/redis_queue.conf; do
  redis-server "$conf" --daemonize yes 2>/dev/null || true
done

if ! ss -ltn | grep -q ':9001 '; then
  nohup node apps/frappe/socketio.js > "$HOME/kamra-socketio.log" 2>&1 &
fi

exec bench serve --port 8002
