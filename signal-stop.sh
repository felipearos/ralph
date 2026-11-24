# shellcheck shell=bash
# Sourced by ralph.sh once its EXIT trap is set: what the supervisor does on
# SIGTERM, SIGINT and SIGHUP.
#
# A shutdown, a reboot, an operator's `kill <pid>` and the dashboard's Stop now
# all reach the supervisor as SIGTERM (Ctrl-C as SIGINT, a closed terminal as
# SIGHUP). Untrapped, it died without an ending, which the dashboard's
# reconciler cannot tell from an oomd kill — so on 2026-10-28 a shutdown came
# back at boot as every loop restarted, the ones meant to be off included.
# Trapped, it ends the way Stop now does: a confirmed `interrupted` stop
# (`controls.ts interrupted --self`), the claim, branch and ledger left for
# Resume work, nothing released. Only a death no trap sees — SIGKILL, an OOM
# kill, a power cut — still reads as a death the reconciler restarts.
#
# Bounded, because systemd waits for it at shutdown and Stop now follows its
# SIGTERM with SIGKILL ten seconds later: the children are told first, the
# record gets RALPH_SIGNAL_RECORD_TIMEOUT seconds, and the EXIT trap does the
# rest. The normal exit path never comes here: EXIT is a separate trap.
#
# Bash runs a trap only once the foreground command has returned, which is why
# `orchestrator_turn` waits on its turn with `wait` rather than in the
# foreground: a `kill <pid>` mid-turn would otherwise sit unanswered until the
# model finished.
#
# Reads RALPH_HOME, RALPH_RUN_ID and, when set, LOOP_DISPLAY and SUPERVISOR_LOG.

# Every process below this one, from one `ps` snapshot. The turn's pipeline
# hangs off a background subshell, `doppler run` forks its command, and the
# heartbeats are children of their own, so the direct children are not enough;
# and the process group is not ours to signal, because a supervisor started by
# hand or by a test shares its caller's.
signal_descendants() {
  local pids
  pids="$(ps -e -o pid=,ppid= 2>/dev/null | awk -v root="$$" '
    { parent[$1] = $2 }
    END {
      found[root] = 1
      do {
        more = 0
        for (p in parent) if (!(p in found) && (parent[p] in found)) { found[p] = 1; more = 1 }
      } while (more)
      for (p in found) if (p != root) print p
    }')"
  # shellcheck disable=SC2086 # one pid per word
  [ -z "$pids" ] || kill -TERM $pids 2>/dev/null
  return 0
}

end_on_signal() { # <name> <number>
  # Once: systemd or Stop now may signal again while this is recording.
  trap '' TERM INT HUP
  signal_descendants
  timeout "${RALPH_SIGNAL_RECORD_TIMEOUT:-5}" bun "${RALPH_HOME}/controls.ts" interrupted --self "$$" \
    --signal "${1}" --key "signal-${RALPH_RUN_ID}" --why "stopped by ${1} (a shutdown, a reboot or a kill)" >/dev/null 2>&1 || true
  # Straight to the file: the terminal a SIGHUP came from is gone.
  printf '%s\n' "${LOOP_DISPLAY:-ralph}: ${1} received — recorded as interrupted; Start or Resume work picks it up." \
    >> "${SUPERVISOR_LOG:-/dev/null}" 2>/dev/null || true
  exit $((128 + $2))
}

trap 'end_on_signal SIGTERM 15' TERM
trap 'end_on_signal SIGINT 2' INT
trap 'end_on_signal SIGHUP 1' HUP
