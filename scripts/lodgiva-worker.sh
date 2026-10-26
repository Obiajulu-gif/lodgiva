#!/usr/bin/env bash
# Keep a Frappe background worker alive.
#
# On this bench RQ exits *cleanly* after an idle stretch:
#
#   Worker ...: Redis connection timeout, quitting...
#
# Exit code 0, no error, nothing in the UI. The stack looks healthy and stays
# healthy - except that provisioning a new hotel now sits in the queue forever,
# because nothing is left to run the job. Restarting it is the whole fix.
#
# Runs inside WSL. Copied in by scripts/lodgiva-up.sh.
set -u

export PATH="$HOME/.local/bin:$PATH"
cd "$HOME/kamra-bench"

while true; do
  bench worker --queue long,default,short
  code=$?
  echo "[worker-supervisor] exited with $code; restarting in 3s" >&2
  sleep 3
done
