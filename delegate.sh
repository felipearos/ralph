#!/usr/bin/env bash
# Hand one fully-specified implementation task to the cheap code model.
#
# The Ralph iteration stays the orchestrator — whichever model `models.json`
# gives that stage: it picks the ticket,
# writes the brief, reviews the diff, runs the gates, and owns git/gh. This
# script is the only place the executor model is invoked, so the rails live
# in runner-specific files: ralph/opencode-executor.jsonc (permissions, opencode runner),
# ralph/claude-executor-settings.json (permissions, claude runner) and
# ralph/codex-executor.sh (filesystem and network confinement), plus
# ralph/coder.md (behaviour). The lineup selects `executor.runner`.
#
# Usage:
#   ralph/delegate.sh <brief-file>              # fresh executor session
#   ralph/delegate.sh --continue <brief-file>   # follow-up round, same session
#
# Exit codes:
#   0  executor finished (this says NOTHING about the diff being correct —
#      the orchestrator must still read it)
#   2  executor unavailable (not installed / not authed) — caller should fall
#      back to implementing directly rather than failing the iteration
#   3  bad usage
#   4  executor errored or hit the timeout
set -uo pipefail
RALPH_HOME="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd -P)"
# shellcheck source=project.sh
. "${RALPH_HOME}/project.sh"
ROOT="$PWD"

# The executor's model comes from the lineup in `ralph/models.json` like every
# other stage, and it is ASKED FOR rather than read out of the environment even
# though `ralph.sh` has usually exported it already. Reading `$RALPH_MODEL_EXECUTOR`
# here with a `${RALPH_CODER_MODEL:-…}` fallback was a second copy of the
# resolver's precedence rules, and it had already drifted: `${VAR:-}` accepts a
# whitespace-only value the resolver deliberately ignores, and would hand that
# to `opencode -m`. One bun start per delegation is the price of one rule.
#
# `RALPH_CODER_MODEL` still works — the resolver honours it as the name this
# knob had before the lineup existed.
# `--role`, so a role with no executor stage (`roles.ts`) is refused by the
# resolver instead of being handed the coder's executor: a triager that reached
# this script would otherwise delegate code it may not write.
#
# Only when the supervisor exported one: an explicit `coder` here would beat the
# resolver's roster lookup and turn that refusal back into a model id.
STAGE_ROLE_ARGS=()
[ -n "${RALPH_LOOP_ROLE:-}" ] && STAGE_ROLE_ARGS=(--role "$RALPH_LOOP_ROLE")
if ! MODEL="$(bun "${RALPH_HOME}/models.ts" executor "${STAGE_ROLE_ARGS[@]}")"; then
  echo "delegate: could not resolve the executor model (see above)." >&2
  exit 3
fi
if ! RUNNER="$(bun "${RALPH_HOME}/models.ts" executor --runner "${STAGE_ROLE_ARGS[@]}")"; then
  echo "delegate: could not resolve the executor runner (see above)." >&2
  exit 3
fi
EFFORT=""
if [ "$RUNNER" = codex ]; then
  EFFORT="$(bun "${RALPH_HOME}/models.ts" executor --effort "${STAGE_ROLE_ARGS[@]}")" || exit 3
fi
case "$RUNNER" in
  opencode|claude|codex) ;;
  *)
    echo "delegate: the executor runner is '${RUNNER}', which this script does not start." >&2
    exit 3 ;;
esac

# One database for this executor for the life of one Ralph run. Follow-up
# rounds use `--continue`, so they must see the same session store; mapper and
# review stages get their own short-lived stores in inspect.sh. Keeping the
# executor here, under this worktree's ignored logs, prevents two loops from
# contending on OpenCode's global database and keeps a single store from
# accumulating every loop's event history forever.
RALPH_LOG_DIR="${RALPH_LOG_DIR:-.ralph/logs}"
[ "$RUNNER" = opencode ] && mkdir -p "${RALPH_LOG_DIR}/opencode-db"
safe_run_id="$(printf '%s' "${RALPH_RUN_ID:-adhoc}" | tr -c '[:alnum:]_.-' '_')"
if [ "$RUNNER" = opencode ]; then
  if [ "${RALPH_LOG_DIR#/}" != "${RALPH_LOG_DIR}" ]; then
    default_executor_db="${RALPH_LOG_DIR}/opencode-db/${safe_run_id}-executor.db"
  else
    default_executor_db="${ROOT}/${RALPH_LOG_DIR}/opencode-db/${safe_run_id}-executor.db"
  fi
  OPENCODE_EXECUTOR_DB="${RALPH_OPENCODE_DB:-${default_executor_db}}"
fi

# The executor runs with a CLEARED environment plus this allowlist, and gets no
# secret at all. The orchestrator's own environment is real (ralph.sh runs the
# iteration under Doppler), and inheriting it here would not defeat the
# permission rails in ralph/opencode-executor.jsonc — it would make them beside the
# point, which is worse. `doppler`, `gh`, `psql` and `supabase` are denied to
# the executor precisely so a cheap model cannot reach credentials; a denied
# command it never needed to run is no protection if the credentials are
# already sitting in its environment.
#
# Nothing in the allowlist is a secret:
#   PATH, HOME  find the binary and its own credential store
#               (~/.local/share/opencode/auth.json) — the executor's auth is
#               the one thing it must keep, and it is not this app's
#   TERM, LANG  keep the renderer and text handling sane under `env -i`
#   XDG_*       only when already set: they relocate that credential store and
#               the caches, so dropping them turns a working install into a
#               mysteriously unauthenticated one
#   OPENCODE_CONFIG  the rails themselves
#
# Every command the executor is allowed to run — read, edit, typecheck, unit
# tests — needs no application environment. Every command that would need one
# is already denied to it.
#   RALPH_MODEL_EXECUTOR  the model, read back by `{env:…}` in opencode-executor.jsonc
#               so the rails file and this script cannot name different models
#
# The claude runner gets the same clearing and the same allowlist minus the
# opencode variables, plus CLAUDE_CONFIG_DIR when set — it relocates ~/.claude,
# the credential store and the session store, the way XDG_* does for opencode.
# Its rails travel as a flag (`--settings`) rather than a variable, and its
# model as `--model`, so nothing harness-specific is in its environment at all.
#
# PATH leads with ralph/executor-guard/bin for the runners that start on the
# host: shims for every package runner that refuse repo-wide verification (the
# full test suite, a whole-repo lint, builds, e2e) before it starts — see
# ralph/executor-guard/guard.ts. The Codex runner builds its own PATH inside
# Bubblewrap and mounts the guard there itself, and must not find the shims
# here when it looks up the real `bun` and `node` to mount.
EXECUTOR_PATH="$PATH"
[ "$RUNNER" = codex ] || EXECUTOR_PATH="${RALPH_HOME}/executor-guard/bin:${PATH}"
EXECUTOR_ENV=(
  env -i
  "PATH=${EXECUTOR_PATH}"
  "HOME=${HOME}"
  "TERM=${TERM:-dumb}"
  "LANG=${LANG:-C.UTF-8}"
)
if [ "$RUNNER" = opencode ]; then
  EXECUTOR_ENV+=(
    "OPENCODE_CONFIG=${RALPH_HOME}/opencode-executor.jsonc"
    "OPENCODE_DB=${OPENCODE_EXECUTOR_DB}"
    "RALPH_MODEL_EXECUTOR=${MODEL}"
  )
fi
for passthrough in XDG_DATA_HOME XDG_CONFIG_HOME XDG_CACHE_HOME XDG_STATE_HOME TMPDIR CLAUDE_CONFIG_DIR CODEX_HOME; do
  if [ -n "${!passthrough:-}" ]; then
    EXECUTOR_ENV+=("${passthrough}=${!passthrough}")
  fi
done

# Every way this script can end badly, written down where it happened.
#
# The exit code alone has never been enough: `2` is "opencode is not there" and
# "opencode is there and has no credential", which are different repairs, and
# `4` covers a timeout, a refused tool and a broken renderer alike. All of that
# used to go to stderr in the middle of an iteration log and nowhere else, so a
# loop that spent a night failing every delegation looked exactly like a loop
# that was working. `ralph/runner-failure.ts` turns each one into a durable,
# attributed, redacted line — and it is called on the SUCCESS path too, because
# an executor whose every tool call was denied still exits 0.
#
# Never fatal and never noisy, the rule the rest of the loop's bookkeeping
# follows: an observation that could not be written must not cost a delegation.
observe() {
  bun "${RALPH_HOME}/runner-failure.ts" observe --stage executor --runner "$RUNNER" \
    --model "${MODEL:-unknown}" "$@" 2>&1 | sed 's/^/delegate: /' >&2 || true
  bun "${RALPH_HOME}/push-notification.ts" observation --stage executor >/dev/null 2>&1 || true
}

CONTINUE=""
if [ "${1:-}" = "--continue" ]; then CONTINUE="--continue"; shift; fi

BRIEF="${1:-}"
if [ -z "$BRIEF" ] || [ ! -f "$BRIEF" ]; then
  echo "delegate: usage: ${RALPH_HOME}/delegate.sh [--continue] <brief-file>" >&2
  exit 3
fi

# The budget: the brief's `Budget:` line, else RALPH_DELEGATE_TIMEOUT, else the
# default, held under RALPH_DELEGATE_MAX_TIMEOUT. ralph/executor-budget.ts says
# why a flat 900s was not enough.
if ! budget_vars="$(bun "${RALPH_HOME}/executor-budget.ts" resolve "$BRIEF")"; then
  echo "delegate: could not resolve the executor's time budget (see above)." >&2
  exit 3
fi
eval "$budget_vars"
TIMEOUT="$DELEGATE_BUDGET"

ts="$(date +%Y%m%dT%H%M%S)"
STAGE_INVOCATION="executor-${ts}-$$"
STAGE_ACTIVE=0
stage_event() {
  python3 "${RALPH_HOME}/timeline.py" "$1" \
    --stage executor \
    --invocation "$STAGE_INVOCATION" \
    --runner "$RUNNER" \
    --model "$MODEL" >/dev/null 2>&1 || true
}
degrade() {
  note="$1"
  observe --exit 2 --note "$note"
  stage_event degraded
  exit 2
}

# Preflight. A missing executor must degrade, not kill the loop.
#
# The claude runner's check is `claude auth status --json`, which spends no
# model call and answers `loggedIn` — run under the executor's cleared
# environment for the same reason opencode's is: the allowlist has to be
# enough to authenticate, not only enough to start.
if [ "$RUNNER" = claude ]; then
  if ! command -v claude >/dev/null 2>&1; then
    echo "delegate: claude not on PATH — implement this task yourself." >&2
    degrade "claude not on PATH"
  fi
  if ! auth_status="$("${EXECUTOR_ENV[@]}" claude auth status --json 2>&1)"; then
    echo "delegate: claude could not run under the executor's cleared environment:" >&2
    printf '%s\n' "$auth_status" | tail -3 >&2
    echo "delegate: implement this task yourself." >&2
    degrade "claude could not run under the executor's cleared environment: $(printf '%s' "$auth_status" | tail -1)"
  fi
  if ! printf '%s' "$auth_status" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("loggedIn") is True else 1)' 2>/dev/null; then
    echo "delegate: claude is not logged in (run: claude auth login) — implement this task yourself." >&2
    degrade "claude is not logged in (run: claude auth login)"
  fi
elif [ "$RUNNER" = codex ]; then
  command -v codex >/dev/null 2>&1 || degrade "codex not on PATH"
  command -v bwrap >/dev/null 2>&1 || degrade "bubblewrap not on PATH; cannot confine the Codex executor"
  "${EXECUTOR_ENV[@]}" timeout 30 codex login status >/dev/null 2>&1 || degrade "codex is not logged in (run: codex login)"
  [ -f "${CODEX_HOME:-${HOME}/.codex}/auth.json" ] || degrade "Codex executor requires CODEX_HOME/auth.json"
elif ! command -v opencode >/dev/null 2>&1; then
  echo "delegate: opencode not on PATH — implement this task yourself." >&2
  degrade "opencode not on PATH"
fi
# Run the auth check under the same cleared environment as the executor itself,
# so this preflight proves the allowlist is enough to authenticate and not only
# enough to start. Capture rather than pipe: the two failures are different
# repairs, and `grep -q` exiting early on a pipeline under `pipefail` would
# report the wrong one.
if [ "$RUNNER" = opencode ] && ! auth_list="$("${EXECUTOR_ENV[@]}" opencode auth list 2>&1)"; then
  echo "delegate: opencode could not run under the executor's cleared environment:" >&2
  printf '%s\n' "$auth_list" | tail -3 >&2
  echo "delegate: implement this task yourself." >&2
  degrade "opencode could not run under the executor's cleared environment: $(printf '%s' "$auth_list" | tail -1)"
fi
if [ "$RUNNER" = opencode ] && ! printf '%s' "${auth_list:-}" | grep -qi 'opencode go'; then
  echo "delegate: no OpenCode Go credential (run: opencode auth login) — implement this task yourself." >&2
  degrade "no OpenCode Go credential (run: opencode auth login)"
fi

mkdir -p "${RALPH_LOG_DIR}"
log="${RALPH_LOG_DIR}/delegate-${ts}.log"
usage="${RALPH_LOG_DIR}/delegate-${ts}.usage"
# Written by the renderer as each denial goes past, and read back below. It is
# a separate file from the log because the two answer different questions and
# one of them has to be machine-readable while the run is still going.
#
# The PID is in the name and the log's is not, and the difference is that this
# file is READ BACK. `ts` is whole seconds, so a `--continue` round starting in
# the same second as the round before it would append to the first round's
# signals — and the second delegation would then be recorded as having hit a
# denial that belonged to the first. Two transcripts interleaved is a mess an
# operator can see; a misattributed denial is one they cannot.
signals="${RALPH_LOG_DIR}/signals-executor-${ts}-$$.jsonl"
finish_stage() {
  status=$?
  if [ "$STAGE_ACTIVE" -eq 1 ]; then
    case "$status" in
      0) stage_event completed ;;
      2) stage_event degraded ;;
      *) stage_event failed ;;
    esac
  fi
  # The done-file: an orchestrator whose tool call returned before this run
  # did waits for it rather than guessing, and never kills the run to get on.
  printf '%s\n' "$status" > "${log}.exit" 2>/dev/null || true
}
trap finish_stage EXIT

# Rails first, then the orchestrator's brief. Prepending on every round means
# a --continue follow-up can't drift past the rails as context ages out.
# Rendered rather than `cat`: the generic rails carry `{{PROJECT_CODER_…}}`
# placeholders the project's coder fragment (.ralph/config.json) fills, and a
# render that fails is a bad call — never a brief sent without its rails.
if ! rails="$(bun "${RALPH_HOME}/models.ts" --render-prompt "${RALPH_HOME}/coder.md")"; then
  echo "delegate: could not render the executor rails (${RALPH_HOME}/coder.md; see above)." >&2
  exit 3
fi
budget_note="$(bun "${RALPH_HOME}/executor-budget.ts" note "$TIMEOUT" "$DELEGATE_WRAP_UP" "$(date +%s)")" || budget_note=""
msg="$(printf '%s' "$rails"; printf '\n\n---\n\n%s\n\n# This round\n\n' "$budget_note"; cat "$BRIEF")"

echo "=== delegate → ${MODEL} (${ts}, timeout ${TIMEOUT}s) ==="
echo "brief: ${BRIEF}"
clamp_note=""
[ "$DELEGATE_BUDGET_CLAMPED" = 1 ] && clamp_note=", held to its bounds"
echo "budget: ${TIMEOUT}s (${DELEGATE_BUDGET_SOURCE}${clamp_note}), wrap-up at ${DELEGATE_WRAP_UP}s — wait up to ${DELEGATE_WAIT}s; never wrap this command in its own timeout"
echo "pid: $$"
echo "log: ${log}"
echo "done-file: ${log}.exit"

# --format json because the pretty renderer discards the per-step token counts.
# delegate-render.py turns the events back into readable text and totals token
# usage in the same pass.
#
# `runner-failure.ts redact` sits between the harness and the RAW log for the
# one reason the rendered log alone is not enough: `tee "${log}.jsonl"` is
# upstream of the renderer, so before this it wrote the harness's untouched
# event stream — tokens, headers, connection strings and all — to a file the
# failure diagnostics then tell an operator to go and read. Redacting only the
# rendered half meant the readable log was clean and the authoritative one was
# not. The filter streams line by line and refuses to pass anything through if
# it has no patterns, so it cannot silently become a no-op.
#
# The claude runner: one `claude -p` under `ralph/claude-executor-settings.json`,
# with the flags that make that file the whole rail —
#   --dangerously-skip-permissions   approve what the settings do not deny (a
#                                    settings deny still bites here; probed by
#                                    ralph/claude-executor-rails-probe.sh)
#   --strict-mcp-config              load NO MCP server: `.mcp.json` and the
#                                    user's global config carry database
#                                    servers with write tools, and the executor
#                                    must not inherit a reach the denylist
#                                    never mentions
#   --setting-sources project        the repo's own settings (its hooks, its
#                                    permission rules) and nothing from the
#                                    user's ~/.claude — whose hooks, plugins
#                                    and default mode would otherwise run
#                                    inside the executor unprobed
#   --output-format stream-json      the per-turn events the renderer reads;
#                                    `--verbose` is what makes -p emit them
# One session per Ralph run, held in a file under the run's logs the way the
# opencode branch holds its database: the first round names it with
# `--session-id`, and `--continue` resumes it with `--resume`, so a follow-up
# sees the same conversation. `< /dev/null` because -p waits on stdin
# otherwise, and there is nothing to say on it.
STAGE_ACTIVE=1
stage_event started
if [ "$RUNNER" = claude ]; then
  session_dir="${RALPH_LOG_DIR}/claude-executor"
  mkdir -p "$session_dir"
  session_file="${session_dir}/${safe_run_id}.session"
  SESSION_ARGS=()
  # A recorded id is trusted only if it is one: a corrupt file would otherwise
  # turn into `--resume ""`, exit 4 on every continuation, and never heal.
  recorded=""
  if [ -s "$session_file" ]; then
    recorded="$(tr -cd 'a-fA-F0-9-' < "$session_file")"
    case "$recorded" in
      ????????-????-????-????-????????????) ;;
      *) echo "delegate: the recorded session id is not a UUID — starting a fresh one." >&2; recorded="" ;;
    esac
  fi
  if [ -n "$CONTINUE" ] && [ -n "$recorded" ]; then
    SESSION_ARGS=(--resume "$recorded")
  else
    if [ -n "$CONTINUE" ]; then
      echo "delegate: no session recorded for this run — starting a fresh one." >&2
    fi
    session_id="$(uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')"
    printf '%s\n' "$session_id" > "$session_file"
    SESSION_ARGS=(--session-id "$session_id")
  fi
  "${EXECUTOR_ENV[@]}" \
    timeout "${TIMEOUT}" nice -n 5 \
    claude -p \
      --model "$MODEL" \
      --settings "${RALPH_HOME}/claude-executor-settings.json" \
      --dangerously-skip-permissions \
      --strict-mcp-config \
      --setting-sources project \
      --output-format stream-json --verbose \
      "${SESSION_ARGS[@]}" \
      "$msg" < /dev/null 2>&1 | bun "${RALPH_HOME}/runner-failure.ts" redact | tee "${log}.jsonl" \
    | RALPH_TIMELINE_STAGE="${RALPH_TIMELINE:+executor}" \
        python3 "${RALPH_HOME}/delegate-render.py" "$usage" "$MODEL" claude "$signals" | tee "$log"
elif [ "$RUNNER" = codex ]; then
  session_dir="${ROOT}/${RALPH_LOG_DIR}/codex-executor"
  [[ "$RALPH_LOG_DIR" != /* ]] || session_dir="${RALPH_LOG_DIR}/codex-executor"
  mkdir -p "$session_dir"
  session_file="${session_dir}/${safe_run_id}.session"
  recorded=""
  if [ -n "$CONTINUE" ] && [ -s "$session_file" ]; then
    recorded="$(cat "$session_file")"
    [[ "$recorded" =~ ^[a-fA-F0-9]{8}-[a-fA-F0-9-]{27}$ ]] || recorded=""
  fi
  "${EXECUTOR_ENV[@]}" timeout "${TIMEOUT}" nice -n 5 \
    bash "${RALPH_HOME}/codex-executor.sh" "$MODEL" "${session_dir}/${safe_run_id}.home" "$recorded" "$EFFORT" \
    <<< "$msg" 2>&1 | bun "${RALPH_HOME}/runner-failure.ts" redact | tee "${log}.jsonl" \
    | RALPH_TIMELINE_STAGE="${RALPH_TIMELINE:+executor}" \
        python3 "${RALPH_HOME}/delegate-render.py" "$usage" "codex/${MODEL}" codex "$signals" | tee "$log"
else
  "${EXECUTOR_ENV[@]}" \
    timeout "${TIMEOUT}" nice -n 5 \
    "${RALPH_HOME}/opencode-run.sh" "$ROOT" run ${CONTINUE} \
      --agent ralph-coder \
      -m "$MODEL" \
      --dir "$ROOT" \
      --auto \
      --format json \
      "$msg" 2>&1 | bun "${RALPH_HOME}/runner-failure.ts" redact | tee "${log}.jsonl" \
    | RALPH_TIMELINE_STAGE="${RALPH_TIMELINE:+executor}" \
        python3 "${RALPH_HOME}/delegate-render.py" "$usage" "$MODEL" opencode "$signals" | tee "$log"
fi

PIPE=("${PIPESTATUS[@]}")
rc="${PIPE[0]}"

# Book token usage against the current Ralph step. A bookkeeping failure must
# never stop an iteration, so every failure here is a warning.
if [ -f "$usage" ]; then
  # shellcheck disable=SC1090
  . "$usage"
  if [ "$RUNNER" = codex ] && [[ "${DELEGATE_SESSION:-}" =~ ^[a-fA-F0-9]{8}-[a-fA-F0-9-]{27}$ ]]; then
    printf '%s\n' "$DELEGATE_SESSION" > "$session_file"
  fi
  if [ "${DELEGATE_STEPS:-0}" -gt 0 ]; then
    "${RALPH_HOME}/usage.py" \
      --record-external "$DELEGATE_MODEL" \
      --input "$DELEGATE_INPUT" \
      --output "$DELEGATE_OUTPUT" \
      --cache-read "$DELEGATE_CACHE_READ" \
      --cache-write "$DELEGATE_CACHE_WRITE" \
      --step "delegated: $(basename "$BRIEF")" \
      || echo "delegate: WARNING could not record tokens in the usage ledger" >&2
  fi
fi

# The blast radius is the useful output, not the model's own summary — it is
# what the orchestrator reviews before anything reaches a commit.
echo
echo "=== delegate result (exit ${rc}) ==="
echo "log: ${log}"
echo
echo "--- git status ---"
git status --short
echo "--- git diff --stat (unstaged + staged vs HEAD) ---"
git --no-pager diff --stat HEAD

if [ "$rc" -eq 124 ]; then
  observe --exit 124 --log "$log" --signals "$signals" \
    --note "the executor was killed at its ${TIMEOUT}s timeout (${DELEGATE_BUDGET_SOURCE} budget); partial events survived but the diff may be incomplete"
  # Keep what the killed run did where a later edit cannot erase it, and say
  # where it stopped, so the orchestrator continues the slice instead of
  # re-deriving it.
  partial="${log}.partial.diff"
  { git --no-pager diff --binary HEAD
    git ls-files --others --exclude-standard | sed 's/^/untracked: /'; } > "$partial" 2>/dev/null || true
  echo "delegate: TIMED OUT after ${TIMEOUT}s — treat the diff as half-finished." >&2
  echo "          Partial events remain in the log and timeline; the working tree is" >&2
  echo "          still the authority for what the interrupted executor changed." >&2
  echo "          partial diff: ${partial}" >&2
  echo "--- last executor activity ---" >&2
  tail -n 15 "$log" >&2 2>/dev/null || true
  echo "delegate: continue this slice (--continue, or a smaller brief with a Budget: line)" >&2
  echo "          rather than rewriting what is already in the working tree." >&2
  exit 4
fi
if [ "$rc" -ne 0 ]; then
  observe --exit "$rc" --log "$log" --signals "$signals"
  exit 4
fi

# The renderer and the `tee`s, which `PIPESTATUS[0]` says nothing about. Found
# by the review of ralph/inspect.sh, which had inherited the same line: an
# executor that succeeded into a broken renderer left an empty log and a zero
# exit, and the orchestrator reads that log to decide whether the diff is worth
# committing.
for i in "${!PIPE[@]}"; do
  [ "$i" -eq 0 ] && continue
  if [ "${PIPE[$i]}" -ne 0 ]; then
    echo "delegate: the executor finished but stage ${i} of the pipeline exited ${PIPE[$i]};" >&2
    echo "          the log is incomplete. Raw events: ${log}.jsonl" >&2
    observe --exit 4 --log "$log" --signals "$signals" \
      --note "the executor finished but stage ${i} of the pipeline exited ${PIPE[$i]}"
    exit 4
  fi
done
# The clean path, and not a formality: an executor that was denied every tool
# it reached for exits 0 with an empty diff, and the denial is the only thing
# that explains it. `observe` writes nothing when there is nothing to say.
observe --exit 0 --log "$log" --signals "$signals"
exit 0
