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

# The scheduler is a separate process from the worker. Without it no
# scheduled job is ever enqueued: the PMS night audit never runs (business
# date stalls, found 13 days behind on 2026-11-12) and the control site's
# daily subscription sweep never ends a trial. Supervised for the same reason
# as the worker below.
(
  while true; do
    bench schedule
    echo "[scheduler-supervisor] exited with $?; restarting in 3s" >&2
    sleep 3
  done
) &

while true; do
  bench worker --queue long,default,short
  code=$?
  echo "[worker-supervisor] exited with $code; restarting in 3s" >&2
  sleep 3
done
