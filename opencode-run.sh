#!/usr/bin/env bash
# One opencode invocation, with a leash on the part of it that never reports.
#
# Both harness call sites — `ralph/delegate.sh` for the executor and
# `ralph/inspect.sh` for the read-only stages — run opencode inside a pipeline
# under `timeout`, and that ceiling is the only thing that has ever ended a run
# that stopped making progress. It is a poor instrument for one specific
# failure, observed on 2026-08-27 across three of roughly ten invocations:
#
#   opencode bootstraps, loads its config, logs `init` — and then does nothing
#   at all. No session, no snapshot, no `message=stream`, no request. It never
#   reaches the model.
#
# The cost of that shape is what makes it worth a file. The stage is billed
# nothing (there are no tokens — `DELEGATE_INPUT=0` is literally true), so it
# looks free, and it is not: it burns the FULL ceiling, 900s, twice in one
# iteration, and then the orchestrator does the delegated work itself on Opus.
# The iteration that motivated this spent $11.66 on a turn that was supposed to
# cost cents, and lost half an hour of wall clock waiting for two processes
# that had already decided to do nothing.
#
# A shorter ceiling cannot fix it: a healthy read-only stage legitimately runs
# for minutes (470s and 23 steps, measured), so any timeout tight enough to
# catch the hang quickly would kill the work this loop exists to do. The two
# are only separable by what the run has DONE, not by how long it has taken —
# so that is what this watches.
#
# Two independent measures, because they fail differently:
#
#   1. The init work that can hang is turned off. `OPENCODE_DISABLE_MODELS_FETCH`
#      stops the boot-time refresh of the models.dev catalogue — a network call
#      on the way to the first request, in a stage whose environment is cleared
#      precisely so it does not depend on the network for anything but the
#      model. `OPENCODE_DISABLE_PRUNE` stops the
#      boot-time prune of a store that is 805MB on this machine. Neither is a
#      proven cause — the hang leaves no diagnostic — but both are unbounded
#      work between `init` and the first request, which is exactly the window
#      that hangs, and neither is work a stage needs.
#
#   2. If it hangs anyway, it is killed on evidence and retried once. The
#      evidence is opencode's own log: a healthy run writes `message=stream`
#      within seconds of `init` and hundreds of lines thereafter; a hung one
#      wrote twelve lines and stopped. The durable provider log remains the
#      signal because rendered output alone cannot prove the request started.
#
#   3. And when the log says nothing at all, the run's own write count does.
#      Measure 2 shipped, and then failed in production on 2026-08-27, on the
#      stage it was written for. Its stand-down fired instead:
#
#        opencode-run: cannot attribute a log line to this run; watchdog stood down.
#
#      The run had opened the log and the 777MB database and blocked holding
#      both, having written not one line — not even the `creating instance`
#      that measures 1 and 2 identify a run by. Two seconds of CPU in fourteen
#      minutes. So there was no candidate, no attribution, and "no evidence" is
#      the stand-down condition: the leash was built to let go on precisely the
#      failure it exists for. `/proc/<pid>/io` fixes that at the root, because
#      the pids in this invocation's process group are OURS by construction and
#      there is nothing to attribute. See `bytes_written`.
#
# The retry is safe for the same reason the kill is: a run with no `stream`
# line has not contacted the model, so it has written no code, made no edit and
# spent nothing. Re-running it repeats nothing. That is why this refuses to
# kill on any weaker evidence, and why there is exactly one retry rather than a
# loop — two hangs in a row is a broken harness, and the caller's own degrade
# path (exit 2 in `inspect.sh`) is a better answer than a third attempt.
#
# THE WATCHDOG NEVER FAILS A RUN THAT IS STILL WORKING. That is the rule, and
# measure 3 is what changed to keep it true: it used to be "never fails a run
# it cannot SEE", which sounds like the same caution and is not. Unreadable
# evidence was treated as proof of health, so the quieter the failure the safer
# it was from the guard. Now an unattributable run is judged on whether it is
# still writing — ambiguity about WHICH run is ours still stands the watchdog
# down, because killing the wrong one is the harm that reasoning protects
# against, and a run that is writing is spared whatever the log says.
#
# Usage:
#   ralph/opencode-run.sh <root> <opencode-args...>
#
# `<root>` is the worktree opencode is run against — the same path the callers
# pass as `--dir`. It is how a log line is attributed to THIS invocation rather
# than to a stage running concurrently in another worktree, which is a thing
# two loops on one machine do routinely.
#
# Exits with opencode's own status, so the pipeline's `PIPESTATUS[0]` keeps
# meaning what it meant before this file existed.
#
#   RALPH_OPENCODE_WATCHDOG=0            no watchdog; bare passthrough.
#   RALPH_OPENCODE_FIRST_STREAM_SECONDS  how long a run may take to reach the
#                                        model before it is treated as hung
#                                        (default 90; measured healthy runs
#                                        stream within ~10s of `init`).
#   RALPH_OPENCODE_STALL_SECONDS         how long a run may write NOTHING AT
#                                        ALL before it is treated as hung
#                                        (default 120). This is the signal
#                                        that needs no log; see below.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

if [ "$#" -lt 2 ]; then
  echo "opencode-run: usage: opencode-run.sh <root> <opencode-args...>" >&2
  exit 3
fi
ROOT="$1"
shift

# Turned off unless it is a positive integer. A malformed value must not be
# read as zero — that would make every run instantly "hung".
FIRST_STREAM="${RALPH_OPENCODE_FIRST_STREAM_SECONDS:-90}"
if [[ ! "$FIRST_STREAM" =~ ^[1-9][0-9]*$ ]]; then
  FIRST_STREAM=90
fi

STALL="${RALPH_OPENCODE_STALL_SECONDS:-120}"
if [[ ! "$STALL" =~ ^[1-9][0-9]*$ ]]; then
  STALL=120
fi

# Measure 1, applied whatever the watchdog does. Set rather than exported over
# the caller: an operator who has deliberately set either of these — to debug
# the catalogue, say — keeps their value.
export OPENCODE_DISABLE_MODELS_FETCH="${OPENCODE_DISABLE_MODELS_FETCH:-1}"
export OPENCODE_DISABLE_PRUNE="${OPENCODE_DISABLE_PRUNE:-1}"
# OpenCode 1.18.23 can block before its first log line in @parcel/watcher's
# native `Backend::getShared` subscription startup. Ralph does not consume
# filesystem watcher events: snapshots and tools inspect the worktree on
# demand, so keep that unnecessary native service out of every stage.
export OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER="${OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER:-1}"

# Where opencode writes the log this watches. The stage's environment is
# cleared but passes XDG_DATA_HOME through, so this resolves the same way
# opencode resolves it.
LOG_FILE="${XDG_DATA_HOME:-${HOME}/.local/share}/opencode/log/opencode.log"

# `stat` is the only reading this does of anything but the log, and a missing
# `stat` must degrade rather than throw.
log_size() {
  [ -r "$LOG_FILE" ] || { printf '0'; return; }
  stat -c%s "$LOG_FILE" 2>/dev/null || printf '0'
}

# Everything the log gained since this invocation started. Byte offsets rather
# than a set of run ids known beforehand: it is the same attribution with less
# state, and a rotated log (new size below the mark) simply reads as "all of
# it", which is over-inclusive in the safe direction — more candidates means
# ambiguity means the watchdog stands down.
since_mark() {
  local mark="$1" size
  size="$(log_size)"
  [ "$size" -le "$mark" ] && return 0
  tail -c "+$((mark + 1))" "$LOG_FILE" 2>/dev/null || true
}

# The run id opencode gave THIS invocation, or empty when that cannot be said
# with certainty. Certainty is one candidate: a second concurrent run in the
# same worktree makes both lines equally plausible, and a watchdog that guessed
# would eventually kill the wrong one.
our_run_id() {
  local mark="$1" ids
  ids="$(since_mark "$mark" \
    | grep -aF "message=\"creating instance\" directory=${ROOT}" \
    | sed -nE 's/.* run=([a-f0-9]+) .*/\1/p' \
    | sort -u)"
  [ "$(printf '%s\n' "$ids" | grep -c .)" -eq 1 ] || return 0
  printf '%s' "$ids"
}

# How few log lines a run must have written to still count as "did nothing".
#
# The hang wrote twelve — the bootstrap, and then silence. A run that has
# reached the model writes hundreds: permission evaluations, snapshot tracking,
# one `loop` line per step. The floor sits well above the first and far below
# the second.
SILENT_LINES="${RALPH_OPENCODE_SILENT_LINES:-20}"
if [[ ! "$SILENT_LINES" =~ ^[1-9][0-9]*$ ]]; then
  SILENT_LINES=20
fi

# Has this run done anything a retry would have to repeat?
#
# TWO independent signals, and it takes only one to spare the run. The direct
# one is `message=stream`, the line opencode writes when it hands the request
# to the provider. The indirect one is simply how much the run has written at
# all — because the direct signal is an undocumented string in somebody else's
# log, and a release that renames it would otherwise turn this watchdog into a
# machine that kills every healthy stage at 90s. A guard whose failure mode is
# "murders all the work" needs a second opinion.
made_progress() {
  local mark="$1" id="$2" lines
  since_mark "$mark" | grep -aq "run=${id} .*message=stream " && return 0
  lines="$(since_mark "$mark" | grep -ac "run=${id} ")"
  [ "$lines" -gt "$SILENT_LINES" ]
}

CHILD=""
# Whether the child got a process group of its own, which decides whether it is
# killed as a group or as a pid. `setsid` is in util-linux and so is everywhere
# this loop runs, but a missing one must degrade rather than throw.
GROUPED=0
if command -v setsid >/dev/null 2>&1; then
  GROUPED=1
fi

# Everything the harness has written, in bytes, across its process group.
#
# THE SIGNAL THAT NEEDS NO ATTRIBUTION. Both log-derived measures above ask the
# same question first — "which of the runs in this shared log is mine?" — and
# they answer it from a line opencode writes early in its own startup. The hang
# in production never got that far: it opened the log and the database and then
# blocked, holding both, having written not one line. So `our_run_id` found no
# candidate, and "no evidence" is the watchdog's stand-down condition. The
# leash was built to let go on precisely the failure it exists for.
#
# `/proc/<pid>/io`'s `wchar` counts every write a process has issued — its
# event stream on stdout, its log, its database — and these pids are ours by
# construction. There is nothing to attribute and nothing to misattribute, so
# this measure holds in exactly the case the other two go blind.
#
# It is a STALL detector, not a volume one, and that distinction is the whole
# design: the hang did write during startup, so "has it written anything at
# all" would have spared it. What separates it from a healthy run is that its
# byte count then stopped moving and never moved again.
#
# An unreadable `io` — a hardened kernel, a pid that exited between the listing
# and the read — contributes nothing rather than failing the sample, which
# leaves the count flat. That is the safe direction only because a flat count
# alone never kills: it has to stay flat for a whole stall window while the
# other two measures are also finding nothing.
bytes_written() {
  local total=0 pid pids w
  pids="$CHILD"
  if [ "$GROUPED" = "1" ]; then
    # The child leads its own group, so the group IS the harness and whatever
    # it started. Falling back to the child alone keeps a `ps` that answered
    # nothing from reading as "wrote nothing".
    pids="$(ps -eo pid=,pgid= 2>/dev/null | awk -v g="$CHILD" '$2 == g { print $1 }')"
    [ -n "$pids" ] || pids="$CHILD"
  fi
  for pid in $pids; do
    w="$(sed -n 's/^wchar: *//p' "/proc/${pid}/io" 2>/dev/null)"
    [[ "$w" =~ ^[0-9]+$ ]] && total=$((total + w))
  done
  printf '%s' "$total"
}

# A futex wait is normal for an idle Bun event loop, so `/proc/.../wchan` alone
# cannot identify the startup hang. Capture native stacks while the process is
# still alive, after the liveness detector has decided it is stalled and before
# TERM changes the evidence. Each debugger is bounded; diagnostics must never
# turn the watchdog into another hang.
DIAGNOSTIC_INDEX=0
capture_diagnostics() {
  [ "${RALPH_OPENCODE_DIAGNOSTICS:-1}" = "0" ] && return 0
  local dir file pid task target eu_stack_status pids candidates command
  dir="${RALPH_OPENCODE_DIAGNOSTICS_DIR:-${ROOT}/.ralph/logs}"
  mkdir -p "$dir" 2>/dev/null || return 0
  DIAGNOSTIC_INDEX=$((DIAGNOSTIC_INDEX + 1))
  file="${dir}/opencode-hang-$(date -u +%Y%m%dT%H%M%SZ)-$$-${DIAGNOSTIC_INDEX}.txt"
  pids="$CHILD"
  if [ "$GROUPED" = "1" ]; then
    pids="$(ps -eo pid=,pgid= 2>/dev/null | awk -v g="$CHILD" '$2 == g { print $1 }')"
    [ -n "$pids" ] || pids="$CHILD"
  fi
  candidates=""
  for pid in $pids; do
    command="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null)"
    case "$command" in
      *pty-run.py*) ;;
      *opencode*) candidates="${candidates} ${pid}" ;;
    esac
  done
  [ -n "$candidates" ] || candidates="$pids"
  {
    echo "reason: ${1}"
    echo "captured: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "root: ${ROOT}"
    for pid in $candidates; do
      eu_stack_status=1
      echo "pid: ${pid}"
      echo "command: $(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null)"
      echo "process"
      ps -L -p "$pid" -o pid=,ppid=,tid=,stat=,etime=,time=,wchan:32=,cmd=
      echo "threads"
      for task in "/proc/${pid}/task/"*; do
        [ -d "$task" ] || continue
        printf '%s wchan=' "${task##*/}"
        cat "${task}/wchan" 2>/dev/null || true
        printf ' syscall='
        cat "${task}/syscall" 2>/dev/null || true
        printf '\n'
      done
      echo "file descriptors"
      for task in "/proc/${pid}/fd/"*; do
        [ -e "$task" ] || continue
        printf '%s -> ' "${task##*/}"
        readlink "$task" 2>/dev/null || true
      done
      echo "event-loop descriptors"
      for task in "/proc/${pid}/fd/"*; do
        [ -e "$task" ] || continue
        target="$(readlink "$task" 2>/dev/null)"
        case "$target" in
          *timerfd*|*eventpoll*|*eventfd*)
            echo "-- fd ${task##*/} -> ${target}"
            cat "/proc/${pid}/fdinfo/${task##*/}" 2>/dev/null || true
            ;;
        esac
      done
      echo "native stacks"
      if command -v eu-stack >/dev/null 2>&1; then
        timeout 10s eu-stack -p "$pid" 2>&1
        eu_stack_status=$?
      fi
      if [ "$eu_stack_status" -ne 0 ] && command -v gdb >/dev/null 2>&1; then
        echo "gdb fallback"
        timeout 15s gdb -q -n -batch -ex 'set pagination off' -ex 'thread apply all bt' -p "$pid" 2>&1 || true
      elif [ "$eu_stack_status" -ne 0 ] && ! command -v eu-stack >/dev/null 2>&1; then
        echo "neither eu-stack nor gdb is installed"
      fi
    done
  } > "$file" 2>&1
  echo "opencode-run: captured hang diagnostics: ${file}" >&2
}

# Signal the harness AND everything it started.
#
# The pid alone is not enough, and the reason is the pipeline: opencode's
# children inherit its stdout, so a descendant that outlives a TERM to its
# parent holds the pipe open and `tee` downstream keeps waiting on it. The
# stage would then hang exactly as it did before this file existed, having been
# "killed". A group kill is what actually ends it.
signal_child() {
  local sig="$1"
  [ -n "$CHILD" ] || return 0
  if [ "$GROUPED" = "1" ]; then
    kill "-${sig}" "-${CHILD}" 2>/dev/null
  fi
  kill "-${sig}" "$CHILD" 2>/dev/null
  return 0
}

# The outer `timeout` signals THIS process, not opencode, and the ceiling has
# to keep working: without this trap a killed wrapper would leave the harness
# it started running loose, which is a worse failure than the one being fixed.
cleanup() {
  [ -n "$CHILD" ] && kill -0 "$CHILD" 2>/dev/null && signal_child TERM
  return 0
}
trap cleanup TERM INT HUP EXIT

# One attempt. Prints nothing of its own on the happy path — stdout belongs to
# the harness's event stream, and a line of ours in it is a line the renderer
# has to parse around.
#
# Returns opencode's exit status, or 124 when the watchdog killed it, which is
# `timeout`'s own "it ran out of time" code and so needs no new meaning from
# any caller.
attempt() {
  local mark waited id
  mark="$(log_size)"

  # `setsid` so the harness leads its own process group and can be ended as
  # one; see `signal_child`. It stays a direct child either way, so `wait`
  # still reports its status.
  if [ "$GROUPED" = "1" ]; then
    setsid "$@" &
  else
    "$@" &
  fi
  CHILD=$!

  # No watchdog: wait, and let the outer ceiling be the only one. An unreadable
  # log no longer disables it — that used to mean "no signals at all", and the
  # byte counter needs no log to work.
  if [ "${RALPH_OPENCODE_WATCHDOG:-1}" = "0" ]; then
    wait "$CHILD"
    local status=$?
    CHILD=""
    return "$status"
  fi

  waited=0
  id=""
  local io_prev io_now stalled why
  io_prev="$(bytes_written)"
  stalled=0
  why=""
  while :; do
    # The run ending on its own — well or badly — is not this watchdog's
    # business. Checked before the evidence, so a fast run is never killed for
    # having finished before it could be attributed.
    if ! kill -0 "$CHILD" 2>/dev/null; then
      wait "$CHILD"
      local status=$?
      CHILD=""
      return "$status"
    fi
    # Checked at the TOP of every pass, which is what makes the pass where
    # `waited` has just reached the window a look taken after it rather than
    # during it. A watchdog that killed without that look would be killing for
    # lack of looking rather than for lack of progress.
    [ -z "$id" ] && id="$(our_run_id "$mark")"
    if [ -n "$id" ] && made_progress "$mark" "$id"; then
      wait "$CHILD"
      local status=$?
      CHILD=""
      return "$status"
    fi

    io_now="$(bytes_written)"
    if [ "$io_now" != "$io_prev" ]; then
      io_prev="$io_now"
      stalled=0
    else
      stalled=$((stalled + 2))
    fi

    # Attributable, and out of its window to reach the model: the original
    # rule, and still the one that fires first for a run whose log we can read.
    if [ -n "$id" ] && [ "$waited" -ge "$FIRST_STREAM" ]; then
      why="no request reached the model in ${FIRST_STREAM}s (run ${id})"
      break
    fi
    # Not attributable — and it has not written a single byte for a whole
    # stall window. This is the production hang: no log line to attribute, no
    # database write, no event on stdout, holding every file it opened. A run
    # that is merely waiting on a slow provider is still writing, so it resets
    # this counter and is spared.
    if [ "$stalled" -ge "$STALL" ]; then
      why="wrote nothing for ${STALL}s and never reached the model"
      break
    fi
    sleep 2
    waited=$((waited + 2))
  done

  echo "opencode-run: watchdog-killed: ${why}; killing it." >&2
  capture_diagnostics "$why"
  signal_child TERM
  # A harness that ignores TERM must not become a second hang.
  local grace=0
  while [ "$grace" -lt 10 ] && kill -0 "$CHILD" 2>/dev/null; do
    sleep 1
    grace=$((grace + 1))
  done
  signal_child KILL
  wait "$CHILD" 2>/dev/null
  CHILD=""
  return 124
}

attempt python3 "$HERE/pty-run.py" opencode "$@"
status=$?

# One retry, and only for the failure this file is about. Any other exit is the
# harness's own answer and belongs to the caller, which has degrade paths this
# script must not pre-empt.
if [ "$status" -eq 124 ]; then
  echo "opencode-run: retrying once — the killed run reached no model and so did nothing." >&2
  attempt python3 "$HERE/pty-run.py" opencode "$@"
  status=$?
  if [ "$status" -eq 124 ]; then
    echo "opencode-run: it hung twice; leaving the stage to its caller." >&2
  fi
fi

exit "$status"
