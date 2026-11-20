#!/usr/bin/env bash
# Start this worktree's loop as a detached, frontier-gated supervisor.
set -euo pipefail
RALPH_HOME="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd -P)"
# shellcheck source=project.sh
. "${RALPH_HOME}/project.sh"

# The poll interval, from the loop's ROLE when the operator names none. A
# triager's gate answers "what has nobody looked at", which cannot change as
# fast as a coder's frontier, so polling both at 300s spends GitHub reads on an
# answer that has not moved (`roles.ts`'s `pollSeconds`).
#
# Asked here rather than in `ralph.sh` because an empty RALPH_WAIT_FOR_WORK
# there means UNGATED — a default applied inside it would silently turn a
# one-shot run into a waiting one.
#
# Best-effort, and 300 stays the fallback: the name is resolved as `ralph.sh`
# resolves it — the environment, then `.ralph/loop-name`, then the roster's
# first loop, which `--poll-seconds-of` applies when given no name. A roster
# that does not carry the name, or a harness too old to answer, leaves the
# number this script has always used. Starting a supervisor must not depend on
# a nicety.
#
# The name is resolved whatever the interval, because it also names the
# supervisor's systemd unit below.
START_LOOP_NAME="${RALPH_LOOP_NAME:-}"
if [ -z "$START_LOOP_NAME" ] && [ -r .ralph/loop-name ]; then
  START_LOOP_NAME="$(tr -d '[:space:]' < .ralph/loop-name || true)"
fi
WAIT_SECONDS="${RALPH_WAIT_FOR_WORK:-}"
if [ -z "$WAIT_SECONDS" ]; then
  WAIT_SECONDS="$(bun "${RALPH_HOME}/project-config.ts" --poll-seconds-of ${START_LOOP_NAME:+"$START_LOOP_NAME"} 2>/dev/null || true)"
  [[ "$WAIT_SECONDS" =~ ^[1-9][0-9]*$ ]] || WAIT_SECONDS=300
fi
MAX_ITERATIONS="${RALPH_MAX_ITERATIONS:-50}"
LOG=".ralph/logs/loop.stdout"
LOCK=".ralph/logs/supervisor.lock"
PID_FILE=".ralph/logs/supervisor.pid"

if [[ ! "$WAIT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "RALPH_WAIT_FOR_WORK must be a positive integer; got '${WAIT_SECONDS}'." >&2
  exit 1
fi
if [[ ! "$MAX_ITERATIONS" =~ ^[1-9][0-9]*$ ]]; then
  echo "RALPH_MAX_ITERATIONS must be a positive integer; got '${MAX_ITERATIONS}'." >&2
  exit 1
fi

mkdir -p .ralph/logs
exec 9>"$LOCK"
# A short wait, not none: the dashboard's recovery poll holds this lock for
# the second it applies retry, abandon or release, so that no supervisor can
# start under it — and a Start pressed in that second should start, not
# report a supervisor that is not there.
if ! flock -w 2 9; then
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  echo "Ralph supervisor already running${pid:+ (pid ${pid})}."
  exit 0
fi

# A free lock does not prove no supervisor lives: a wrapper killed on its own
# (the lock is the wrapper's) leaves its supervisor running, on either launch
# path. Starting a second one beside it would run two loops on one worktree,
# and on the systemd path the stale-unit stop below would kill the live one.
# Modelled on `supervisorPidMatches` in `loop-state.ts`, with one difference:
# where that answers `unknown` for an unreadable /proc, this has to decide, and
# it refuses the start when the pid still answers kill -0 (only our own
# processes do), since a second supervisor is worse than a start not taken.
supervisor_alive() {
  local pid="$1" args="" arg cwd="" named=""
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  # Unreadable /proc cannot tell; a pid that answers kill -0 may then be the
  # live supervisor, and refusing a start is the safe side of that doubt.
  # The braces silence the redirection's own failure, which `2>/dev/null` on
  # the command does not: bash would print it, and the dashboard reads a
  # failed start's first stderr line as its reason.
  if ! args="$({ tr '\0' '\n' < "/proc/${pid}/cmdline"; } 2>/dev/null)"; then
    kill -0 "$pid" 2>/dev/null && return 0
    return 1
  fi
  while IFS= read -r arg; do
    # A shell running `-c` whose command merely mentions ralph.sh is not one.
    [ "$arg" = "-c" ] && return 1
    if [ "$arg" = "ralph.sh" ] || [[ "$arg" == */ralph.sh ]]; then named=1; fi
  done <<< "$args"
  [ -n "$named" ] || return 1
  if ! cwd="$(realpath "/proc/${pid}/cwd" 2>/dev/null)"; then
    kill -0 "$pid" 2>/dev/null && return 0
    return 1
  fi
  [ "$cwd" = "$(pwd -P)" ]
}
recorded_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
recorded_pid="${recorded_pid//[[:space:]]/}"
if supervisor_alive "$recorded_pid"; then
  echo "Ralph supervisor already running (pid ${recorded_pid})."
  exit 0
fi
: > "$PID_FILE"

log_line() {
  printf 'start.sh: %s\n' "$*" >> "$LOG" 2>/dev/null || true
}

# The supervisor gets a transient systemd user scope of its own where a user
# manager answers. Launched from the dashboard it would otherwise sit in the
# dashboard unit's cgroup, so memory pressure there (oomd) or a stop of the
# dashboard would take every loop down with it. The name is the project and
# the loop, so a second start finds the first one's unit.
UNIT_PROJECT="${RALPH_PROJECT_ID:-}"
[ -n "$UNIT_PROJECT" ] || UNIT_PROJECT="${PWD##*/}"
UNIT_LOOP="${START_LOOP_NAME:-ralph}"
UNIT="ralph-loop-${UNIT_PROJECT//[^A-Za-z0-9_.-]/-}-${UNIT_LOOP//[^A-Za-z0-9_.-]/-}"
SCOPE="${UNIT}.scope"

# RALPH_LOOP_SCOPE=off is how the test suite keeps the real start.sh from
# creating, or stopping, ralph-loop-* units on the host of the live loops.
scope_unavailable=""
if [ "${RALPH_LOOP_SCOPE:-}" = "off" ]; then
  scope_unavailable="RALPH_LOOP_SCOPE=off"
elif ! command -v systemd-run >/dev/null 2>&1; then
  scope_unavailable="systemd-run not on PATH"
elif ! systemctl --user show-environment >/dev/null 2>&1; then
  scope_unavailable="no systemd user manager answers"
fi

# One launch of the wrapper, with "$@" (systemd-run and its options, or
# nothing) between setsid and bash. nohup, setsid and systemd-run --scope all
# exec, so $wrapper is the wrapper bash itself and stays its group's leader:
# the group kill below and Stop now reach the supervisor through it.
launch() {
  nohup setsid "$@" bash -c '
    pid_file="$1"
    shift
    "$@" 9>&- &
    supervisor=$!
    printf "%s\n" "$supervisor" > "$pid_file"
    wait "$supervisor"
  ' bash "$PID_FILE" env RALPH_WAIT_FOR_WORK="$WAIT_SECONDS" \
    "${RALPH_HOME}/ralph.sh" "$MAX_ITERATIONS" >> "$LOG" 2>&1 < /dev/null &
  wrapper=$!
}

# Polls for the published pid, up to $1 tries 0.05 s apart (40, 2 s, by
# default), and stops early once the wrapper is gone.
await_pid() {
  local tries="${1:-40}" try
  pid=""
  for ((try = 0; try < tries; try++)); do
    IFS= read -r pid < "$PID_FILE" || pid=""
    [ -n "$pid" ] && break
    if ! kill -0 "$wrapper" 2>/dev/null; then
      break
    fi
    sleep 0.05
  done
  # The wrapper may publish and exit between the read and the kill -0 above.
  if [ -z "$pid" ]; then
    IFS= read -r pid < "$PID_FILE" || pid=""
  fi
}

# Does the scope hold a live supervisor? The guard above has ruled out this
# worktree's recorded one, but a unit name is not proof of ownership: a second
# worktree of one project with no loop name of its own also defaults to
# `ralph`, and `-` joins parts that may contain `-`. A supervisor in the scope
# is then ANOTHER loop's (or one this worktree's pid file lost), and stopping
# the scope would kill it. Orphans of a dead supervisor (claude, vitest, a
# build) are not supervisors, so they do not hold the name. A cgroup that
# cannot be read counts as held: not stopping is the safe side.
scope_holds_supervisor() {
  local cgroup procs proc args arg named
  held_pid=""
  cgroup="$(systemctl --user show -p ControlGroup --value "$SCOPE" 2>/dev/null || true)"
  # A loaded unit with no cgroup has nothing running in it.
  [ -n "$cgroup" ] || return 1
  # RALPH_CGROUP_ROOT exists for start.test.ts, which cannot fake /sys/fs/cgroup.
  procs="${RALPH_CGROUP_ROOT:-/sys/fs/cgroup}${cgroup}/cgroup.procs"
  [ -r "$procs" ] || return 0
  while IFS= read -r proc; do
    [[ "$proc" =~ ^[1-9][0-9]*$ ]] || continue
    args="$({ tr '\0' '\n' < "/proc/${proc}/cmdline"; } 2>/dev/null)" || continue
    named=""
    while IFS= read -r arg; do
      [ "$arg" = "-c" ] && { named=""; break; }
      if [ "$arg" = "ralph.sh" ] || [[ "$arg" == */ralph.sh ]]; then named=1; fi
    done <<< "$args"
    if [ -n "$named" ]; then
      held_pid="$proc"
      return 0
    fi
  done < "$procs"
  return 1
}

if [ -z "$scope_unavailable" ]; then
  # The supervisor is gone (the guard above), yet its unit can be held: a
  # kill -9 on it leaves its children (claude, vitest) alive in the scope,
  # and systemd-run would refuse the name. Never fatal — the fallback launch
  # below catches a name still held.
  load_state="$(systemctl --user show -p LoadState --value "$SCOPE" 2>/dev/null || true)"
  if [ "$load_state" = "loaded" ] \
    || systemctl --user is-active --quiet "$SCOPE" 2>/dev/null \
    || systemctl --user is-failed --quiet "$SCOPE" 2>/dev/null; then
    if scope_holds_supervisor; then
      # This worktree's own supervisor, which its pid file lost: it runs.
      if [ -n "$held_pid" ] \
        && [ "$({ realpath "/proc/${held_pid}/cwd"; } 2>/dev/null || true)" = "$(pwd -P)" ]; then
        printf '%s\n' "$held_pid" > "$PID_FILE"
        echo "Ralph supervisor already running (pid ${held_pid})."
        exit 0
      fi
      scope_unavailable="unit ${SCOPE} holds a live supervisor this worktree does not own"
    # Bounded: a scope stop waits out its children's SIGTERM (90 s by
    # default), longer than the dashboard waits for this script. A stop cut
    # short goes on in the manager, and a name still held falls back below.
    elif timeout 10 systemctl --user stop "$SCOPE" >> "$LOG" 2>&1; then
      log_line "stopped stale unit ${SCOPE} left by a dead supervisor"
    else
      log_line "could not stop stale unit ${SCOPE}; launching anyway"
    fi
    systemctl --user reset-failed "$SCOPE" >/dev/null 2>&1 || true
  fi
fi

unit_note=""
if [ -z "$scope_unavailable" ]; then
  log_line "launching in transient unit ${SCOPE}"
  launch systemd-run --user --scope --quiet --collect --unit "$UNIT"
  # Longer than the plain launch: systemd-run registers the scope over D-Bus
  # first, which on a loaded host can take more than the default 2 s. A
  # refusal still ends the wait at once, as the wrapper exits. 5 s, so the
  # bounded stale stop, this wait and a fallback stay inside the dashboard's
  # 30 s start timeout.
  await_pid 100
  if [ -z "$pid" ]; then
    # systemd-run refused (name still held, access denied) and ran nothing,
    # or is still waiting on a stalled user manager's job queue: the old
    # launch still works, and a loop that starts beats a clean cgroup. A
    # systemd-run still waiting is killed with its group first, so it cannot
    # exec a second supervisor later.
    status=0
    if kill -0 "$wrapper" 2>/dev/null; then
      kill -TERM -- "-$wrapper" 2>/dev/null || true
      kill "$wrapper" 2>/dev/null || true
    fi
    wait "$wrapper" || status=$?
    log_line "systemd-run refused or stalled on unit ${SCOPE} (status ${status}); falling back to nohup setsid"
    : > "$PID_FILE"
    launch
    await_pid
  else
    unit_note=" in unit ${SCOPE}"
  fi
else
  log_line "launching with nohup setsid (systemd-run --user unavailable: ${scope_unavailable})"
  launch
  await_pid
fi
# Held until here, not just past the launch, so the lock stays taken across a
# refused systemd launch and its fallback.
exec 9>&-

if [ -z "$pid" ]; then
  status=0
  kill -TERM -- "-$wrapper" 2>/dev/null || true
  kill "$wrapper" 2>/dev/null || true
  wait "$wrapper" || status=$?
  echo "Ralph supervisor wrapper did not publish a PID (status ${status}); see ${LOG}." >&2
  exit 1
fi
if ! kill -0 "$pid" 2>/dev/null; then
  status=0
  wait "$wrapper" || status=$?
  echo "Ralph supervisor exited during startup (status ${status}); see ${LOG}." >&2
  exit 1
fi

echo "Started Ralph supervisor (pid ${pid})${unit_note}; waits ${WAIT_SECONDS}s, runs up to ${MAX_ITERATIONS} iterations."
echo "Log: ${LOG}"
