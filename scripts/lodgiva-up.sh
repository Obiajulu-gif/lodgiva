#!/usr/bin/env bash
#
# Start the whole Lodgiva demo stack from Git Bash on Windows.
#
#   bash scripts/lodgiva-up.sh              # start everything, print the link
#   bash scripts/lodgiva-up.sh --no-tunnel  # local only, no public link
#
# Leave this window open. Everything runs as a child of this script, and the
# WSL VM shuts down when nothing holds it open - closing the terminal stops
# the stack.
#
# Ctrl-C stops all of it cleanly.
#
# What it starts, in order:
#   MariaDB      127.0.0.1:3307   the eval bench's own database
#   Frappe       0.0.0.0:8002     ALL sites, resolved by Host header
#   worker                        runs provisioning jobs (new hotel sites)
#   socketio     9001             live updates between staff screens
#   Caddy        8001             landing page + PMS + /admin on one address
#   cloudflared                   public https link
set -uo pipefail

DISTRO="Ubuntu-24.04"
WSL_USER="frappe"
BENCH="/home/frappe/kamra-bench"
TUNNEL=1
[ "${1:-}" = "--no-tunnel" ] && TUNNEL=0

# MSYS_NO_PATHCONV stops Git Bash rewriting /home/... into a Windows path.
wsl_run() { MSYS_NO_PATHCONV=1 wsl -d "$DISTRO" -u "$WSL_USER" -- bash -c "$1"; }

PIDS=()
cleanup() {
  echo ""
  echo "stopping..."
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null; done
  wait 2>/dev/null
  echo "stopped. (the WSL VM shuts down on its own once nothing holds it)"
}
trap cleanup EXIT INT TERM

# Wait until a port is listening inside WSL, or give up.
wait_for_port() {
  local port="$1" label="$2" tries="${3:-60}" i=0
  while [ "$i" -lt "$tries" ]; do
    if wsl_run "ss -lnt | grep -q ':$port '" 2>/dev/null; then
      echo "  ok   $label (:$port)"
      return 0
    fi
    sleep 3
    i=$((i + 1))
  done
  echo "  FAIL $label did not come up on :$port"
  return 1
}

echo "Lodgiva stack"
echo "============="

# A cold WSL start needs free memory; this is the failure everybody hits.
AVAIL=$(wsl_run "free -m | awk '/^Mem:/ {print \$7}'" 2>/dev/null | tr -d '\r')
echo "WSL memory available: ${AVAIL:-unknown} MB"
echo ""

echo "1/5 MariaDB"
MSYS_NO_PATHCONV=1 wsl -d "$DISTRO" -u "$WSL_USER" -- bash /home/frappe/kamra-mariadb.sh --foreground &
PIDS+=($!)
wait_for_port 3307 "MariaDB" 60 || exit 1

# The multi-site serve script is versioned here, not in the bench, so a fresh
# machine does not silently fall back to single-site serving.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WIN_SRC="$(cd "$HERE" && pwd -W 2>/dev/null || pwd)"
WSL_DIR="/mnt/$(echo "$WIN_SRC" | sed 's|^\([A-Za-z]\):|\L\1|; s|\\|/|g')"
for helper in kamra-serve-multi.sh lodgiva-worker.sh; do
  [ -f "$HERE/$helper" ] || continue
  wsl_run "tr -d '\r' < '$WSL_DIR/$helper' > /home/frappe/$helper 2>/dev/null && chmod +x /home/frappe/$helper" || true
done

echo "2/5 Frappe (all sites, by Host header)"
MSYS_NO_PATHCONV=1 wsl -d "$DISTRO" -u "$WSL_USER" -- bash /home/frappe/kamra-serve-multi.sh &
PIDS+=($!)
wait_for_port 8002 "Frappe" 60 || exit 1

echo "3/5 background worker (needed to provision new hotels)"
# Supervised: RQ quits cleanly after an idle stretch on this bench, which
# silently stops provisioning while everything else keeps looking fine.
MSYS_NO_PATHCONV=1 wsl -d "$DISTRO" -u "$WSL_USER" -- bash /home/frappe/lodgiva-worker.sh &
PIDS+=($!)
sleep 8
if wsl_run "ps -eo args | grep -q '[f]rappe worker'"; then
  echo "  ok   worker"
else
  echo "  WARN worker not detected - provisioning a new hotel will sit queued"
fi

echo "4/5 Caddy router"
MSYS_NO_PATHCONV=1 wsl -d "$DISTRO" -u "$WSL_USER" -- bash -c \
  "cd /home/frappe/lodgiva-router && FRAPPE_UPSTREAM=127.0.0.1:8002 exec ./caddy run --config Caddyfile.local --adapter caddyfile" &
PIDS+=($!)
wait_for_port 8001 "Caddy" 40 || exit 1

echo ""
echo "local:  http://localhost:8001"
for path in / /lodgiva /book /admin; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 -L "http://localhost:8001$path")
  printf "  %-10s %s\n" "$path" "$code"
done

if [ "$TUNNEL" = "1" ]; then
  echo ""
  echo "5/5 public link"
  LOG="$(mktemp -t lodgiva-tunnel-XXXXXX.log)"
  MSYS_NO_PATHCONV=1 wsl -d "$DISTRO" -u "$WSL_USER" -- \
    /home/frappe/cloudflared tunnel --no-autoupdate --url http://localhost:8001 >"$LOG" 2>&1 &
  PIDS+=($!)

  URL=""
  for _ in $(seq 1 30); do
    URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1)
    [ -n "$URL" ] && break
    sleep 2
  done

  if [ -n "$URL" ]; then
    echo ""
    echo "  PUBLIC: $URL"
    echo "          $URL/lodgiva   staff PMS"
    echo "          $URL/book      guest booking"
    echo "          $URL/admin     hotel onboarding console"
  else
    echo "  FAIL no tunnel URL; see $LOG"
  fi
fi

echo ""
echo "running. Ctrl-C to stop."
wait
