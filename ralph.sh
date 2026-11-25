#!/usr/bin/env bash
# AFK Ralph: run up to N fresh-context iterations over a project's backlog.
# Usage: (from inside a project worktree) ~/ralph/ralph.sh [max_iterations]   (default 15)
#
# The harness is this checkout (RALPH_HOME); the project is the git toplevel of
# the launch directory (RALPH_PROJECT), configured by its committed
# `.ralph/config.json` — see project-config.ts.
#
# Before every iteration the supervisor asks the frontier, read-only, whether
# an iteration would have anything to do — and never spawns into an empty
# answer. Set RALPH_WAIT_FOR_WORK=<seconds> to make that ask a blocking wait
# rather than a stop. See "Asking the frontier first" below.
set -uo pipefail
RALPH_HOME="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd -P)"
# shellcheck source=project.sh
. "${RALPH_HOME}/project.sh"

MAX="${1:-15}"
mkdir -p .ralph/logs

# Structured iteration events are the largest artifact Ralph writes: a long
# turn includes thinking and every tool result. Keep two weeks by default —
# enough for overnight diagnosis without letting unattended runs fill disk.
# The human log, final channel and failure ledger stay until an operator
# removes them; only reconstructable event streams are expired automatically.
RALPH_EVENT_RETENTION_DAYS="${RALPH_EVENT_RETENTION_DAYS:-14}"
case "$RALPH_EVENT_RETENTION_DAYS" in
  ''|*[!0-9]*)
    echo "ralph.sh: RALPH_EVENT_RETENTION_DAYS must be a non-negative whole number; got '${RALPH_EVENT_RETENTION_DAYS}'." >&2
    exit 1
    ;;
esac
find .ralph/logs -maxdepth 1 -type f -name 'iter-*.events.jsonl' \
  -mtime "+${RALPH_EVENT_RETENTION_DAYS}" -delete 2>/dev/null || true

# --- Loop identity ----------------------------------------------------------
# Four supervisors run this script against one tracker, and everything they
# leave behind has to say which one did it: the claim label on the issue, the
# branch prefix, the provenance line on the PR, the run id in the usage ledger.
# `ralph` conventionally runs from the main checkout; `rafa`, `remo` and `rulo` each
# run from a worktree of their own.
#
# Resolved from `.ralph/loop-name` rather than from an exported variable the
# operator has to remember, because the identity belongs to the WORKTREE — the
# file is untracked, so each checkout carries its own and a loop restarted by
# hand cannot silently come back as the other one. The environment still wins
# when it is set, which is what the tests drive and what a one-off run uses.
#
# An unknown name is refused rather than passed through: the claim fence is
# the project's roster (`loops` in `.ralph/config.json`), so a loop calling
# itself something else would write a claim no other loop reads. The check
# waits for the project config below; until then the name is only read.
LOOP_NAME_FILE=".ralph/loop-name"
# A file that EXISTS but yields no name is refused rather than defaulted past.
# The default is not neutral — it is the roster's first loop, the one that owns
# the tracker's original labels — so a rafa worktree whose `.loop-name` turned
# unreadable (a bad mode, a directory, an empty write) would come back claiming
# `ralph-wip`, which is the single-label collision this file exists to prevent.
# Failing at startup costs one message; defaulting costs a claim nobody can
# attribute.
if [ -z "${RALPH_LOOP_NAME:-}" ] && [ -e "$LOOP_NAME_FILE" ]; then
  if ! RALPH_LOOP_NAME="$(tr -d '[:space:]' < "$LOOP_NAME_FILE" 2>/dev/null)"; then
    echo "ralph.sh: ${PWD}/${LOOP_NAME_FILE} exists but could not be read." >&2
    echo "       Fix or remove it — starting anyway would claim as the roster's first loop." >&2
    exit 1
  fi
  if [ -z "$RALPH_LOOP_NAME" ]; then
    echo "ralph.sh: ${PWD}/${LOOP_NAME_FILE} is empty." >&2
    echo "       Write one of the project's loops (\`loops\` in .ralph/config.json) into it, or remove it." >&2
    exit 1
  fi
fi
# Capitalised for the console only. Every machine-readable use — labels,
# branches, the run id — takes the lowercase name. Provisional until the
# roster below settles an unset name.
loop_display() { printf '%s' "${1:0:1}" | tr '[:lower:]' '[:upper:]'; printf '%s' "${1:1}"; }
LOOP_DISPLAY="$(loop_display "${RALPH_LOOP_NAME:-ralph}")"

# --- Asking the frontier first ----------------------------------------------
# Every iteration is preceded by the same read-only question: would an
# iteration have anything to do? The asker is the gate this loop's ROLE declares
# (`INTAKE_GATE` below — `ralph/frontier-gate.ts` for a coder), and
# the answer decides between spending a fresh-context turn and not — because
# an iteration launched into an empty frontier burns dollars to be told
# ALL_BLOCKED, which is an answer a handful of `gh` calls already know.
#
# By default the ask happens once, before each spawn, and "nothing to do"
# stops the supervisor with the gate's reason in the log. That is the same
# terminal state ALL_BLOCKED used to reach, minus the turn spent discovering
# it.
#
# Set RALPH_WAIT_FOR_WORK=<seconds> to upgrade the ask into a blocking gate:
# the supervisor waits, polling on that interval, until the answer changes to
# work. That matters most for a SECOND loop: the frontier prints at most one
# ticket per spec tree, so while another loop holds the only unblocked tree
# this loop's frontier is legitimately empty — and without waiting it would
# stop instantly, every restart, until the backlog widened.
#
# The gate is also why ALL_BLOCKED and COMPLETE stop being terminal here: a
# loop that is meant to be started once and left running has to treat "nothing
# right now" as a wait. It never becomes a hot spin, because an iteration that
# comes back blocked sleeps one interval before the gate is asked again — the
# gate and the iteration read the same GitHub state, so a disagreement between
# them is a race, and racing back into it immediately is how you burn the
# iteration cap on turns that cannot do anything.
#
# A role that holds at the gate (RALPH_ROLE_GATE_HOLDS, #771) goes further: the
# blocked iteration writes the verdict it refuted to the record in
# `gate-verdict-store.ts`, and the gate holds on that unchanged verdict rather
# than waking the loop for it again. Past RALPH_GATE_HOLD_BUDGET_HOURS (default
# 48) of the same verdict the gate hands back once, the operator is notified
# once, and the loop keeps holding while it reads as blocked.
RALPH_WAIT_FOR_WORK="${RALPH_WAIT_FOR_WORK:-}"
if [ -n "$RALPH_WAIT_FOR_WORK" ]; then
  case "$RALPH_WAIT_FOR_WORK" in
    ''|*[!0-9]*|0)
      echo "${LOOP_DISPLAY}: RALPH_WAIT_FOR_WORK must be a whole number of seconds; got '${RALPH_WAIT_FOR_WORK}'." >&2
      exit 1
      ;;
  esac
fi
# Validated here rather than left to the gate: a budget the gate cannot read
# would only surface as a gate failure hours into an unattended night.
if [ -n "${RALPH_GATE_HOLD_BUDGET_HOURS:-}" ]; then
  if ! [[ "$RALPH_GATE_HOLD_BUDGET_HOURS" =~ ^[1-9][0-9]*$ ]]; then
    echo "${LOOP_DISPLAY}: RALPH_GATE_HOLD_BUDGET_HOURS must be a positive whole number of hours; got '${RALPH_GATE_HOLD_BUDGET_HOURS}'." >&2
    exit 1
  fi
  export RALPH_GATE_HOLD_BUDGET_HOURS
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "${LOOP_DISPLAY}: bun is not on PATH, so neither the project config nor the model lineup can be read." >&2
  exit 1
fi

# --- Project configuration --------------------------------------------------
# Everything project-specific — the repository, the base branch, which secrets
# manager injects the environment and which of its secrets are withheld, the
# files that would shadow it, the environment check, the gates — comes from the
# project's committed `.ralph/config.json`, validated strictly by
# `project-config.ts`. Refused rather than defaulted: a harness that guessed a
# project's secret scope or withhold list would be guessing at a fence.
if ! RALPH_PROJECT_EXPORTS="$(bun "${RALPH_HOME}/project-config.ts" --export)"; then
  echo "${LOOP_DISPLAY}: refusing to start without a valid ${RALPH_PROJECT}/.ralph/config.json." >&2
  exit 1
fi
eval "$RALPH_PROJECT_EXPORTS"
# The roster is the project's, so the name is checked here, against it.
export RALPH_LOOP_NAME="${RALPH_LOOP_NAME:-${RALPH_PROJECT_LOOPS%% *}}"
case " ${RALPH_PROJECT_LOOPS} " in
  *" ${RALPH_LOOP_NAME} "*) ;;
  *)
    echo "ralph.sh: RALPH_LOOP_NAME must be one of this project's loops (${RALPH_PROJECT_LOOPS// /, }); got '${RALPH_LOOP_NAME}'." >&2
    echo "       It is read from ${PWD}/${LOOP_NAME_FILE} unless the environment sets it." >&2
    echo "       Adding a loop? Add it to \`loops\` in ${RALPH_PROJECT}/.ralph/config.json." >&2
    exit 1
    ;;
esac
# The loop's role (`roles.ts`): a plain roster name is a coder, and an entry
# `{ "name", "role" }` names another. Always the roster's, never the caller's
# environment: a role decides what the loop may do. RALPH_PROJECT_LOOPS stays
# names only, whatever their roles, so its readers need not know about roles.
RALPH_LOOP_ROLE="$(bun "${RALPH_HOME}/project-config.ts" --role-of "$RALPH_LOOP_NAME")" || {
  echo "${LOOP_DISPLAY}: refusing to start: could not read ${RALPH_LOOP_NAME}'s role from ${RALPH_PROJECT}/.ralph/config.json." >&2
  exit 1
}
export RALPH_LOOP_ROLE
# And the intake gate that role declares, in place of `frontier-gate.ts`. A
# doctor's gate asks Buildkite rather than the backlog, so what counts as "there
# is work" is the role's to answer; the CONTRACT does not vary, which is why
# everything below reads any of them the same way — exit 0 with a
# `work available — ` line, block or wait otherwise, honour the control inbox.
# Read from the descriptor rather than built here, so `roles.ts` stays the one
# place a role says what differs.
INTAKE_GATE="$(bun "${RALPH_HOME}/project-config.ts" --intake-gate-of "$RALPH_LOOP_NAME")" || {
  echo "${LOOP_DISPLAY}: refusing to start: could not read ${RALPH_LOOP_NAME}'s intake gate from ${RALPH_PROJECT}/.ralph/config.json." >&2
  exit 1
}
# Not checked for existence here: a gate that is missing from a stale worktree
# already stops the loop where it is invoked below, with the log line that says
# so. Nothing checks it EARLIER yet — `preflight.ts`'s `HARNESS_FILES` knows only
# the coder's gate — so a role whose gate has not shipped starts and then dies on
# its first poll. That check belongs in the role preflight (#158); until it
# lands, `ci-doctor/gate.ts` is a descriptor value with no file behind it (#156).
#
# And the rest of what the role changes about this script — which sigils its
# sessions may end with, whether it has phases, the environment it is given,
# the worktree it must leave behind, whether it takes part in the host lease.
# `role-behaviour.ts` renders the descriptor as `export` lines; everything
# below reads RALPH_ROLE_* rather than asking what role this is, so a role
# added to `roles.ts` needs no edit here.
if ! RALPH_ROLE_EXPORTS="$(bun "${RALPH_HOME}/role-behaviour.ts" --export "$RALPH_LOOP_ROLE")"; then
  echo "${LOOP_DISPLAY}: refusing to start: could not read the ${RALPH_LOOP_ROLE} role's behaviour from ${RALPH_HOME}/role-behaviour.ts." >&2
  exit 1
fi
eval "$RALPH_ROLE_EXPORTS"
LOOP_DISPLAY="$(loop_display "$RALPH_LOOP_NAME")"
RALPH_BASE_REF="origin/${RALPH_BASE_BRANCH}"
# Plugins: the project's `plugins` list, unless this run says otherwise with
# `RALPH_PLUGINS` (empty for none). Resolved once and exported, so every child
# — the control poll, the stage scripts' notifications — agrees on it for the
# whole run. Off by default: the loop needs no plugin to run, be controlled,
# or report its state. See `plugins.ts`.
export RALPH_PLUGINS="${RALPH_PLUGINS-${RALPH_PROJECT_PLUGINS:-}}"

# --- Harness freshness ------------------------------------------------------
# The harness is a shared checkout that updates only when somebody pulls it.
# Unlike the project worktree below, a stale harness is WARNED about rather
# than refused: every loop on the machine runs this one checkout, and refusing
# here would stop all of them over a pull nobody has made yet.
if git -C "$RALPH_HOME" rev-parse --git-dir >/dev/null 2>&1; then
  GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND='ssh -oBatchMode=yes' \
    timeout "${RALPH_FETCH_TIMEOUT:-30}" git -C "$RALPH_HOME" fetch --quiet origin main 2>/dev/null || true
  RALPH_HOME_HEAD="$(git -C "$RALPH_HOME" rev-parse HEAD 2>/dev/null || true)"
  RALPH_HOME_BASE="$(git -C "$RALPH_HOME" rev-parse origin/main 2>/dev/null || true)"
  if [ -n "$RALPH_HOME_HEAD" ] && [ -n "$RALPH_HOME_BASE" ] && [ "$RALPH_HOME_HEAD" != "$RALPH_HOME_BASE" ] &&
     git -C "$RALPH_HOME" merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
    echo "${LOOP_DISPLAY}: warning: the harness at ${RALPH_HOME} is behind its origin/main." >&2
    echo "       Update when no loop is mid-iteration: git -C ${RALPH_HOME} pull --ff-only" >&2
  fi
fi

# --- Worktree freshness -----------------------------------------------------
# A loop's worktree does not update itself, and a stale one does not fail as
# staleness: the second loop's worktree once sat three commits behind with no
# `ralph/frontier-gate.ts` in it at all, so RALPH_WAIT_FOR_WORK died on a
# missing file. Checked before the environment work below, because an old
# checkout also breaks THAT in confusing ways — a `.env.test` without the key
# this script greps for reads as a broken repo rather than an old one.
#
# Only a clean checkout that is STRICTLY BEHIND and has no surviving claim is
# moved — HEAD is an ancestor of the base branch and differs from it, so a
# fast-forward is available and no work would be lost. A worktree carrying its
# own commits, uncommitted changes, or this loop's unfinished claim is
# mid-ticket: a killed iteration leaves exactly that, and `prompt.md` §1
# shepherds it on the next run. Those two start anyway and leave HEAD alone.
#
# In that one lossless case the supervisor fast-forwards rather than refusing,
# because refusing there stops the loop over a condition its own next step
# resolves: `prompt.md` §1 runs `git switch --detach "origin/$RALPH_BASE_BRANCH"`
# before asking the frontier, having established the same three facts. The
# refusal cost a stopped loop a restart that exited instantly — rafa, 2026-09-15,
# five hours dead and then three commits behind loggd's main the moment an
# operator pressed start.
#
# It is still not licence to update somebody's checkout. The move is confined
# to the state the guard already proved is a fast-forward, it is announced with
# both shas so the log says HEAD moved and to where, and a fast-forward that
# does not take is refused exactly as before — an unexpected checkout is the
# one thing worse than an old one.
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  # Best effort, and bounded. A fetch that cannot reach the network leaves
  # origin/main at whatever it already knew, so the comparison below is against
  # a stale ref and can only be too permissive — warn, never refuse, because a
  # blip must not stop a loop that is otherwise fine.
  #
  # The bound is the point: unauthenticated HTTPS makes git PROMPT, and a
  # supervisor started with `nohup … &` would sit on that prompt forever,
  # looking like a hang rather than a failure. Both prompts are disabled and
  # the whole thing is capped, so "best effort" cannot become "blocked".
  # RALPH_FETCH_TIMEOUT exists so a test can prove the cap without waiting
  # out a realistic one.
  if ! GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND='ssh -oBatchMode=yes' \
       timeout "${RALPH_FETCH_TIMEOUT:-30}" git fetch --quiet origin 2>/dev/null; then
    echo "${LOOP_DISPLAY}: could not fetch origin; freshness is being judged against a stale ref." >&2
  fi
  RALPH_HEAD="$(git rev-parse HEAD 2>/dev/null || true)"
  RALPH_BASE="$(git rev-parse "$RALPH_BASE_REF" 2>/dev/null || true)"
  if [ -n "$RALPH_HEAD" ] && [ -n "$RALPH_BASE" ] && [ "$RALPH_HEAD" != "$RALPH_BASE" ] &&
     git merge-base --is-ancestor HEAD "$RALPH_BASE_REF" 2>/dev/null; then
    RALPH_DIRTY="$(git status --porcelain 2>/dev/null || true)"
    # The dashboard's Resume work, after a Stop now: the operator asked for
    # the interrupted work to be picked up where it lies, so HEAD stays put
    # whatever the label or the checkout says. §0 and §1 inspect it.
    if [ "${RALPH_RESUME_WORK:-0}" = "1" ]; then
      echo "${LOOP_DISPLAY}: this worktree is behind ${RALPH_BASE_REF}, but an operator is resuming the work left in it." >&2
      echo "       Starting on the existing checkout at ${RALPH_HEAD}; HEAD is not moved." >&2
    elif [ -n "$RALPH_DIRTY" ]; then
      echo "${LOOP_DISPLAY}: this worktree is behind ${RALPH_BASE_REF}, but it has uncommitted work to recover." >&2
      echo "       Starting one iteration on the existing checkout; §0 must inspect it before moving HEAD." >&2
    else
      # Through the project's tracker (#334): GitHub issues, Linear or Jira.
      RALPH_OWN_CLAIMS="$(
        timeout "${RALPH_RECOVERY_PROBE_TIMEOUT:-15}" \
          bun "${RALPH_HOME}/tracker.ts" claimed 2>/dev/null | head -n 1 || true
      )"
      if [ -n "$RALPH_OWN_CLAIMS" ]; then
        echo "${LOOP_DISPLAY}: this worktree is behind ${RALPH_BASE_REF}, but this loop has an unfinished claim to recover." >&2
        echo "       Starting one iteration on the existing checkout; §1 must recover the claim before the frontier." >&2
      elif git checkout --detach "$RALPH_BASE_REF" --quiet 2>/dev/null; then
        echo "${LOOP_DISPLAY}: this worktree was behind ${RALPH_BASE_REF}; fast-forwarded it." >&2
        echo "       was:     ${RALPH_HEAD}" >&2
        echo "       now:     ${RALPH_BASE}" >&2
      else
        # Detaching a clean ancestor is as safe as git gets, so a failure here
        # is not staleness — it is a worktree that does not do what it says.
        # Printing the remedy and stopping is right for that one.
        echo "${LOOP_DISPLAY}: this worktree is behind ${RALPH_BASE_REF} and could not be fast-forwarded." >&2
        echo "       at:      ${RALPH_HEAD}" >&2
        echo "       main:    ${RALPH_BASE}" >&2
        echo "       Update:  git checkout --detach ${RALPH_BASE_REF}" >&2
        echo "       (that moves the checkout; commit or stash uncommitted work first," >&2
        echo "        and on a ${RALPH_LOOP_NAME}/<n> branch rebase it instead of detaching.)" >&2
        exit 1
      fi
    fi
  fi
fi

# --- Model lineup -----------------------------------------------------------
# Which model runs which stage is one file — `ralph/models.json` — resolved by
# `ralph/models.ts`, and this is the only place the supervisor asks. The five
# stages used to name their models in four different places, prose included;
# now the flag below, the executor in `delegate.sh`, and the subagent models
# rendered into the prompt all read the same answer.
#
# Resolved BEFORE the run id and the log exist, because a lineup that cannot be
# resolved is not a run: refusing here costs one message, while starting would
# spend a fresh-context turn on whatever model happened to be the account
# default. Structural problems are the resolver's to refuse. Usage accounting
# accepts every resolved model id.
#
# `eval` of generated shell, deliberately: the values have to reach three
# consumers with different syntaxes (a CLI flag here, `{env:…}` inside
# opencode's config, `{{…}}` inside the prompt), and one exported set is the
# only form all three read. The resolver single-quotes what it emits, and
# nothing but this script's own output is ever eval'd.
# Warnings are captured rather than left on stderr: an unpriced model would
# otherwise land in the nohup stdout and never reach the supervisor log, which
# is the file `status.sh` and a human read. Held until `say` exists, a few
# lines below, because that needs the run id.
# Under `.ralph/logs/` rather than `mktemp`: that directory already exists, is
# already gitignored, and is where this run's other artefacts go — so a
# supervisor killed before the trap fires leaves its scrap among the logs
# instead of in /tmp, and there is no mktemp exit status to have to check.
RALPH_MODEL_WARNINGS_FILE=".ralph/logs/.model-warnings-$$"
trap 'rm -f "$RALPH_MODEL_WARNINGS_FILE"' EXIT
# Agents whose `models.json` block says `"updates": { "policy": "auto" }` move
# to the latest Claude model of their family here, BEFORE the lineup below is
# resolved, so this start already runs on it (#851). Best effort: an update
# that cannot be read or written is one line in the log and the loop starts on
# the lineup as configured — never a refusal, and never a wait. Bounded by
# `timeout` because it reads the Claude Code binary, and a start must not hang
# on a disk. Its lines are held until the export below has written the
# warnings file, which that redirect truncates.
RALPH_MODEL_UPDATES=""
if ! RALPH_MODEL_UPDATES="$(timeout 60 bun "${RALPH_HOME}/model-updates.ts" --apply-auto --project "$RALPH_PROJECT_ID" 2>&1)"; then
  RALPH_MODEL_UPDATES="auto model updates were skipped this start: $(printf '%s\n' "$RALPH_MODEL_UPDATES" | head -n 1)"
fi
# `--role` because a role declares WHICH stages it runs (`roles.ts` `stages`), and
# the exports are that set: a triager gets three stage variables, not five with
# two models nothing will ever invoke. The role also picks the project's `@<role>`
# block, so a second loop of a role needs no `models.json` edit.
if ! RALPH_MODEL_EXPORTS="$(bun "${RALPH_HOME}/models.ts" --export --role "$RALPH_LOOP_ROLE" 2>"$RALPH_MODEL_WARNINGS_FILE")"; then
  cat "$RALPH_MODEL_WARNINGS_FILE" >&2
  echo "${LOOP_DISPLAY}: refusing to start without a model lineup." >&2
  exit 1
fi
[ -n "$RALPH_MODEL_UPDATES" ] && printf '%s\n' "$RALPH_MODEL_UPDATES" >> "$RALPH_MODEL_WARNINGS_FILE"

# The prompt names the models its subagents must use, so it is rendered rather
# than `cat`. Prose was the old mechanism and it could not be enforced: an
# iteration that ignored "use sonnet for mapping" left no trace.
#
# Rendered by the resolver, not by a `sed` here: a model id substituted into
# `s|…|…|` makes `|`, `&` and `\` sed syntax rather than text, and a sed that
# aborts inside `$( )` under `set -uo pipefail` yields an EMPTY prompt that any
# placeholder check then passes. An unrendered placeholder is refused there.
#
# WHICH template is the role's to declare (`roles.ts` `prompt`), so the role is
# all this passes: a coder gets `prompt.md`, a triager `prompts/triager.md`. The
# same flag holds the project fragment's splice to that role's sections, so one
# `.ralph/prompt.md` can carry every role's guidance without a coder's render
# tripping over a triager's.
if ! RALPH_PROMPT="$(bun "${RALPH_HOME}/models.ts" --render-prompt --role "$RALPH_LOOP_ROLE")"; then
  echo "${LOOP_DISPLAY}: could not render the ${RALPH_LOOP_ROLE} prompt under ${RALPH_HOME} (see above)." >&2
  exit 1
fi
if [ -z "$RALPH_PROMPT" ]; then
  echo "${LOOP_DISPLAY}: the rendered prompt is empty; refusing to spend an iteration on it." >&2
  exit 1
fi

# The clerk's second session kind (felipearos/ralph#499): an iteration the gate
# hands a filed ticket to, which reads the application code behind it and
# writes one comment. Rendered here, beside the role's own prompt and for the
# same reasons, but FAIL SOFT where that one refuses: the code-context step is
# an addition to report intake, and a template that cannot be rendered must not
# keep the clerk from filing reports all night. Without it a code-context case
# runs as an ordinary clerk iteration (which finds no batch and ends blocked),
# and the warning below reaches the supervisor log through the same file the
# lineup's warnings do, because `say` does not exist yet.
RALPH_CODE_CONTEXT_TEMPLATE="prompts/clerk-code-context.md"
RALPH_CODE_CONTEXT_PROMPT=""
if [ "$RALPH_LOOP_ROLE" = clerk ]; then
  # Stderr apart from the prompt, so a warning the renderer prints on success
  # never ends up in front of the model; its first line is the reason on failure.
  code_context_render_err=".ralph/logs/.code-context-render-$$"
  if ! RALPH_CODE_CONTEXT_PROMPT="$(bun "${RALPH_HOME}/models.ts" --render-prompt "${RALPH_HOME}/${RALPH_CODE_CONTEXT_TEMPLATE}" --role clerk 2>"$code_context_render_err")" \
     || [ -z "$RALPH_CODE_CONTEXT_PROMPT" ]; then
    printf '%s\n' "code context is off for this run: ${RALPH_CODE_CONTEXT_TEMPLATE} could not be rendered ($(head -n 1 "$code_context_render_err" 2>/dev/null || true)); a code-context case runs with the clerk prompt and model instead." \
      >> "$RALPH_MODEL_WARNINGS_FILE"
    RALPH_CODE_CONTEXT_PROMPT=""
  fi
  rm -f "$code_context_render_err"
fi

# Rendered BEFORE the exports are eval'd, so both resolutions read the same
# environment. After the eval this script's own exports ARE the environment,
# and the operator's `RALPH_MODEL_ORCHESTRATOR_EFFORT=` — the way a model that
# takes no effort is reached — would no longer be visible to the second pass:
# the prompt would name an effort the CLI was never handed.
eval "$RALPH_MODEL_EXPORTS"

# Every stage, present and non-empty. The resolver emits all of them or fails,
# so this catches the ways an `eval` can half-succeed instead — output
# truncated, a stage renamed on one side of the seam only — rather than letting
# `set -u` report it as an unbound variable from somewhere further down. The
# roster is generated by the resolver too, so there is no second copy of the
# stage list living in this script.
for stage_var in ${RALPH_MODEL_STAGE_VARS:?the resolver emitted no stage roster} \
                 ${RALPH_RUNNER_STAGE_VARS:?the resolver emitted no runner roster}; do
  if [ -z "${!stage_var:-}" ]; then
    echo "${LOOP_DISPLAY}: the resolved lineup has no ${stage_var}." >&2
    echo "       Check: bun ${RALPH_HOME}/models.ts --list --role ${RALPH_LOOP_ROLE}" >&2
    exit 1
  fi
done

# `claude --effort` is the session's. The Claude read-only stages carry their
# own model and effort in the named-agent definitions the resolver built, and
# a definition's effort wins over the session's. On every turn, a resumed one
# included, so the prompt never names an agent the session does not have.
RALPH_CLAUDE_MODEL_ARGS=(--model "$RALPH_MODEL_ORCHESTRATOR")
if [ -n "${RALPH_MODEL_ORCHESTRATOR_EFFORT:-}" ]; then
  RALPH_CLAUDE_MODEL_ARGS+=(--effort "$RALPH_MODEL_ORCHESTRATOR_EFFORT")
fi
if [ -n "${RALPH_CLAUDE_AGENTS:-}" ]; then
  RALPH_CLAUDE_MODEL_ARGS+=(--agents "$RALPH_CLAUDE_AGENTS")
fi
# The orchestrator's rails. Every claude orchestrator carries
# `claude-orchestrator-settings.json`: the session reads untrusted ticket
# text, and the project's secrets CLI is still authenticated on this host, so
# the withheld names (`secrets.withhold`) are denied to it the way the
# executor's rails already deny them. A role may name its OWN file in
# `roles.ts` (`orchestratorSettings`: the pr-medic, denied a raw `git push`
# so `pr-medic/push.ts` is its one route to the operator's branch); that file
# replaces the harness one, so it repeats every rule of it
# (`claude-executor-rails.test.ts` checks). One `--settings` per session,
# every turn, a resumed one included.
RALPH_ORCHESTRATOR_RAILS="${RALPH_ROLE_ORCHESTRATOR_SETTINGS:-claude-orchestrator-settings.json}"
if [ "$RALPH_RUNNER_ORCHESTRATOR" != claude ]; then
  # The codex orchestrator runs with approvals and sandbox bypassed and reads
  # its rules from the operator's own CODEX_HOME, so there is no rail this
  # script could hand one session. A role that REQUIRES one is refused — it
  # would otherwise run without it and nothing would say so. The harness-wide
  # rail is a tripwire the prompt's own rule backs, so its absence under codex
  # is said once here rather than refused.
  if [ -n "${RALPH_ROLE_ORCHESTRATOR_SETTINGS:-}" ]; then
    echo "${LOOP_DISPLAY}: refusing to start: the ${RALPH_LOOP_ROLE} role's orchestrator must run under rails (${RALPH_ROLE_ORCHESTRATOR_SETTINGS}), which only the claude runner can carry; its lineup names ${RALPH_RUNNER_ORCHESTRATOR}." >&2
    echo "       Give the role a claude orchestrator: bun ${RALPH_HOME}/models.ts --list --role ${RALPH_LOOP_ROLE}" >&2
    exit 1
  fi
  echo "${LOOP_DISPLAY}: the ${RALPH_RUNNER_ORCHESTRATOR} orchestrator carries no settings rails; its role prompt's rule on the secrets CLI is its only fence." >&2
else
  if [ ! -r "${RALPH_HOME}/${RALPH_ORCHESTRATOR_RAILS}" ]; then
    echo "${LOOP_DISPLAY}: refusing to start: the orchestrator rails ${RALPH_HOME}/${RALPH_ORCHESTRATOR_RAILS} cannot be read." >&2
    exit 1
  fi
  RALPH_CLAUDE_MODEL_ARGS+=(--settings "${RALPH_HOME}/${RALPH_ORCHESTRATOR_RAILS}")
fi
# `merge: "human"` (`project-config.ts`): a person merges every PR, so the
# orchestrator is denied `gh pr merge` on top of its prompt's rule. Like the
# rails above it is a tripwire (`gh api` could still merge); the boundary is a
# branch rule requiring a review the loop's own account cannot give.
if [ "${RALPH_MERGE:-loop}" = human ]; then
  if [ "$RALPH_RUNNER_ORCHESTRATOR" = claude ]; then
    RALPH_CLAUDE_MODEL_ARGS+=(--disallowedTools "Bash(gh pr merge:*)" "Bash(gh pr merge *)")
  else
    echo "${LOOP_DISPLAY}: merge is human, but the ${RALPH_RUNNER_ORCHESTRATOR} orchestrator cannot be denied gh pr merge; its prompt's rule is its only fence." >&2
  fi
fi

# The role's own session arguments, kept: an iteration of another kind swaps
# `RALPH_CLAUDE_MODEL_ARGS` for its own and the next iteration starts from these.
RALPH_CLAUDE_ROLE_ARGS=("${RALPH_CLAUDE_MODEL_ARGS[@]}")
# The clerk's code-context session (felipearos/ralph#499): its own model and
# effort (`code-context` in the lineup), and the SAME rails as the clerk's
# orchestrator — it reads a checkout of the application code instead of a
# batch of messages, and needs the network and the credential stores no more
# than the classifier does. No `--agents`: it delegates nothing. Every turn of
# such an iteration — the sigil recovery included — runs with these, so a
# resumed session never changes model halfway through.
#
# Fail soft, like the render above: a lineup that cannot give it a claude model
# turns code context off for the run rather than refusing to start the clerk.
RALPH_CLAUDE_CODE_CONTEXT_ARGS=()
if [ -n "$RALPH_CODE_CONTEXT_PROMPT" ]; then
  if [ "$RALPH_RUNNER_ORCHESTRATOR" != claude ] || [ "${RALPH_RUNNER_CODE_CONTEXT:-}" != claude ] \
     || [ -z "${RALPH_MODEL_CODE_CONTEXT:-}" ]; then
    printf '%s\n' "code context is off for this run: the lineup gives it no claude model (${RALPH_MODEL_CODE_CONTEXT:-none} on ${RALPH_RUNNER_CODE_CONTEXT:-no runner}); a code-context case runs with the clerk prompt and model instead." \
      >> "$RALPH_MODEL_WARNINGS_FILE"
    RALPH_CODE_CONTEXT_PROMPT=""
  else
    RALPH_CLAUDE_CODE_CONTEXT_ARGS=(--model "$RALPH_MODEL_CODE_CONTEXT")
    if [ -n "${RALPH_MODEL_CODE_CONTEXT_EFFORT:-}" ]; then
      RALPH_CLAUDE_CODE_CONTEXT_ARGS+=(--effort "$RALPH_MODEL_CODE_CONTEXT_EFFORT")
    fi
    RALPH_CLAUDE_CODE_CONTEXT_ARGS+=(--settings "${RALPH_HOME}/${RALPH_ORCHESTRATOR_RAILS}")
  fi
fi
# The gate's code-context verdict, as `clerk/gate.ts` prints it after
# `work available — `: `code context OAI-62 (pwa)`. A report batch's line never
# starts this way, so matching the case text is all the switch needs.
RALPH_CODE_CONTEXT_CASE='^code context ([A-Z][A-Z0-9]*-[0-9]+) \('
# What the current iteration runs as. Set again at the top of every iteration;
# defaulted here so the helpers that read them never meet an unset name.
ITERATION_KIND=""
ITERATION_MODEL="$RALPH_MODEL_ORCHESTRATOR"
ITERATION_ROLE_PROMPT="$RALPH_PROMPT"
ITERATION_RECOVERY_PROMPT=""

# --- Environment for the iteration ------------------------------------------
# The iteration runs under the project's secrets manager (`secrets.runner` in
# `.ralph/config.json`) so its local gates validate against the configuration
# the project is really deployed with, rather than invented values in a
# throwaway env file. A gate that passes on made-up config proves nothing.
#
# A secrets manager carries more than app config, so the config names
# credentials to withhold (`secrets.withhold`). They are stripped from the child
# environment after injection, which is why this is a deny list rather than an
# allowlist: a secret added to the manager later reaches the loop unless the
# project names it. For Loggd that is PRODUCTION_MIGRATIONS_DATABASE_URL,
# SUPABASE_SERVICE_ROLE_KEY, SELF_HOSTED_RUNNER_GH_PAT, BUILDKITE_AGENT_TOKEN,
# BUILDKITE_API_TOKEN, BUILDKITE_OPERATOR_TOKEN and RENOVATE_TOKEN.
#
# The deny is on the *environment*, not on the manager itself: its CLI is still
# authed on this host. A claude orchestrator is denied the CLI and its store by
# `claude-orchestrator-settings.json` (a tripwire, like the executor's rails);
# every role's prompt states the rule, and it is the only fence a codex
# orchestrator has.
read -r -a RALPH_WITHHELD_SECRET_NAMES <<< "${RALPH_WITHHELD_SECRETS}"

# A leftover local env file (`refuseFiles`, e.g. `.env.local`) would shadow
# everything the manager injects, quietly replacing the environment the build
# is meant to validate. Refuse rather than delete: it is not the loop's file to
# throw away.
read -r -a RALPH_REFUSE_FILE_LIST <<< "${RALPH_REFUSE_FILES}"
for refused in "${RALPH_REFUSE_FILE_LIST[@]}"; do
  if [ -e "$refused" ]; then
    echo "${LOOP_DISPLAY}: ${refused} exists and would override the injected environment." >&2
    echo "       Move it aside before running the loop." >&2
    exit 1
  fi
done

# The command every child runs under: the secrets manager scoped explicitly to
# the configured project/config (never a per-directory setup), or nothing.
# A role may be given no application environment at all (`roles.ts`): a
# triager reads and labels issues, runs no gate, and touches no application
# code, so there is nothing for the project's configuration to validate. Its
# children run unwrapped, and the project's own env check is skipped with the
# injection — with nothing injected it has nothing to verify, and it would
# refuse every triager start over a `DATABASE_URL` no triager uses.
#
# The configured runner is kept apart for the role's NAMED secrets (below): a
# manager-less role still reads those by name from the project's scope. The
# clerk wraps nothing in Doppler, yet its two tokens live there (#358).
RALPH_NAMED_SECRETS_RUNNER="$RALPH_SECRETS_RUNNER"
if [ "$RALPH_ROLE_SECRETS_MANAGER" != 1 ]; then
  # `say` is not defined yet and SUPERVISOR_LOG is not set, so this goes
  # straight to stderr like the other startup refusals above.
  #
  # The preflight agrees with this line: it reads the ROLE, so a manager-less
  # role is asked neither for the secrets CLI on PATH nor for the scope behind
  # it (`preflight.ts`'s `requiredTools` and its `doppler-scope` gate). A host
  # with no manager auth at all therefore starts such a role.
  echo "${LOOP_DISPLAY}: the ${RALPH_LOOP_ROLE} role is given no application environment; the project's secrets manager is not run for it." >&2
  RALPH_SECRETS_RUNNER=none
fi
case "$RALPH_SECRETS_RUNNER" in
  doppler)
    if ! command -v doppler >/dev/null 2>&1; then
      echo "${LOOP_DISPLAY}: doppler is not on PATH, so an iteration would have no environment." >&2
      echo "       Install the Doppler CLI and re-run." >&2
      exit 1
    fi
    RALPH_SECRETS_CMD=(doppler run -p "$RALPH_SECRETS_PROJECT" -c "$RALPH_SECRETS_CONFIG" --)
    ;;
  dotenv)
    # No manager to ask: the project names a dotenv file on the host (#49).
    # `dotenv-run.sh` exports it with the shell builtin and execs the command,
    # so its values override the inherited environment as `doppler run`'s do
    # and never sit in a process's argv. The withhold filter below runs after
    # it, exactly as after `doppler run`. The preflight's `secrets-file` check
    # has already refused a missing, unreadable, malformed or tracked file.
    RALPH_SECRETS_CMD=(bash "${RALPH_HOME}/secrets/dotenv-run.sh" "$RALPH_SECRETS_FILE" --)
    ;;
  none) RALPH_SECRETS_CMD=() ;;
  *)
    echo "${LOOP_DISPLAY}: unsupported secrets runner '${RALPH_SECRETS_RUNNER}'." >&2
    exit 1
    ;;
esac
# Preflight probes access to the configured scope. Unavailable access waits;
# denied access stops before any child receives secrets.

# `env -u NAME …` applied to the injected environment for every child, then the
# project's own environment check (`envCheck`), run by development-env.sh.
RALPH_ENV_FILTER=(env)
# The dotenv file's path is the supervisor's, not the children's: it holds the
# withheld names too, so a session handed the path could read them back (#49).
# Unset for every role, not only when the runner reads `dotenv` here: a
# manager-less role (triager, clerk) has its runner set to `none` above while
# the path is still exported, and unsetting an unset name is harmless.
RALPH_ENV_FILTER+=(-u RALPH_SECRETS_FILE)
for secret in "${RALPH_WITHHELD_SECRET_NAMES[@]}"; do
  RALPH_ENV_FILTER+=(-u "$secret")
done
[ "$RALPH_ROLE_SECRETS_MANAGER" = 1 ] && RALPH_ENV_FILTER+=(bash "${RALPH_HOME}/development-env.sh")

# One run id for this whole invocation, so usage.py can total across the
# iterations below; one fixed session id per iteration, so usage.py knows which
# transcript is the current one instead of guessing by mtime.
#
# The pid is part of the id because the timestamp alone is not unique: two
# supervisors started inside the same second, which is exactly what starting a
# second loop looks like, would share a run id and `usage.py` would silently
# report one run whose tokens are the sum of two.
export RALPH_RUN_ID="${RALPH_RUN_ID:-${RALPH_LOOP_NAME}-run-$(date +%Y%m%dT%H%M%S)-$$}"
export RALPH_SUPERVISOR_PID="$$"

# The orchestrator waits on `delegate.sh` through its Bash tool, whose ceiling
# is 600s unless this raises it — shorter than an executor's budget, so rafa
# #1107's orchestrator wrapped the call in `timeout 590` and walked away from a
# run that was nearly done. Raise the ceiling to cover the largest budget a
# brief can declare (ralph/executor-budget.ts), never lower one already set.
if delegate_wait_ms="$(bun "${RALPH_HOME}/executor-budget.ts" orchestrator-wait-ms 2>/dev/null)" \
   && [[ "$delegate_wait_ms" =~ ^[0-9]+$ ]]; then
  if ! [[ "${BASH_MAX_TIMEOUT_MS:-}" =~ ^[0-9]+$ ]] || [ "$BASH_MAX_TIMEOUT_MS" -lt "$delegate_wait_ms" ]; then
    export BASH_MAX_TIMEOUT_MS="$delegate_wait_ms"
  fi
fi

# One file per run, so a second loop's supervisor chatter never interleaves
# with this one's, and `status.sh` can tell an idle supervisor from a dead one
# by reading the last line rather than by looking at the process table alone.
SUPERVISOR_LOG=".ralph/logs/supervisor-${RALPH_RUN_ID}.log"
say() { printf '%s\n' "$*" | tee -a "$SUPERVISOR_LOG"; }

# The durable record of what this loop is doing, written beside the logs and
# read back by `status.sh` — see `ralph/loop-state.ts` for the shape and for
# what each status means. The supervisor log is prose an operator greps; this
# is the same run in a form a panel can classify, and it is the ONLY thing that
# still answers "what happened here?" once the process is gone.
#
# Never fatal, and never noisy. A supervisor that died because its bookkeeping
# could not be written would be strictly worse than a missing panel, and a
# `record` failure printed into the supervisor log would bury the loop's own
# output under it. The panel degrades to process inspection on its own when
# there is no record, which is exactly the state a failed call leaves.
# A claim's lease is independent of the loop-state snapshot: it is the fence
# that lets a replacement recover a dead owner. The lease tool only renews
# claims belonging to this run, so a restarted loop cannot accidentally extend
# somebody else's work. Supervisor records pulse the active lease at every
# state boundary; a separate heartbeat invocation can be scheduled for long
# iterations.
renew_leases() { bun "${RALPH_HOME}/claim-lease.ts" heartbeat >/dev/null 2>&1 || true; }
LEASE_HEARTBEAT_PID=""
stop_lease_heartbeat() {
  if [ -n "$LEASE_HEARTBEAT_PID" ]; then
    kill "$LEASE_HEARTBEAT_PID" 2>/dev/null || true
    wait "$LEASE_HEARTBEAT_PID" 2>/dev/null || true
  fi
}
# The plugins' pulse, for the same reason and on the same pattern. `record`
# only fires at the boundaries AROUND `claude -p`, and that turn holds for tens
# of minutes — so without this a plugin hears nothing while an iteration is
# working, and a healthy long iteration looks exactly like a supervisor that
# died right after its first event. Started only when a plugin is enabled.
PLUGIN_PULSE_PID=""
stop_plugin_pulse() {
  if [ -n "$PLUGIN_PULSE_PID" ]; then
    kill "$PLUGIN_PULSE_PID" 2>/dev/null || true
    wait "$PLUGIN_PULSE_PID" 2>/dev/null || true
  fi
}
BUDGET_GUARD_PID=""
stop_budget_guard() {
  if [ -n "$BUDGET_GUARD_PID" ]; then
    kill "$BUDGET_GUARD_PID" 2>/dev/null || true
    wait "$BUDGET_GUARD_PID" 2>/dev/null || true
    BUDGET_GUARD_PID=""
  fi
}
trap 'stop_lease_heartbeat; stop_plugin_pulse; stop_budget_guard; rm -f "$RALPH_MODEL_WARNINGS_FILE"' EXIT

# --- Ending on a signal --------------------------------------------------------
# SIGTERM, SIGINT and SIGHUP end the run as `interrupted`, the way Stop now
# does, so a shutdown or a `kill` stays stopped instead of reading to the
# dashboard's reconciler as a crash to restart. See signal-stop.sh.
. "${RALPH_HOME}/signal-stop.sh"
# One event, and everyone who reads it. `loop-state.ts` is the record an
# operator already in this worktree reads; the lease is the fence that lets a
# replacement recover a dead owner; `push-notification.ts` decides whether it
# is worth an alert; and `plugins.ts` hands the same event to every enabled
# plugin's `on-event` hook — after the durable record has it, so a plugin never
# hears about an event the loop's own record does not have. One call site, so
# none of them can drift into describing a different run; each takes these
# flags unchanged.
#
# Plugins are held to the same contract as the rest: bounded, never fatal, and
# their output discarded — the host records a plugin's failure against the
# plugin, never against the loop. With no plugin enabled, no subprocess is made
# for them at all.
record() {
  bun "${RALPH_HOME}/loop-state.ts" record "$@" >/dev/null 2>&1 || true
  [ -n "$RALPH_PLUGINS" ] && { bun "${RALPH_HOME}/plugins.ts" event "$@" >/dev/null 2>&1 || true; }
  bun "${RALPH_HOME}/push-notification.ts" record "$@" >/dev/null 2>&1 || true
  renew_leases
}

# One event in the speed ledger (`speed.ts`, #578): how long a ticket takes
# from its first claim to the PR being ready for a person, and how much of
# that an iteration was actually running. Only for a coder: that clock is a
# coder measure, and a triager's claim is routing, not a ticket being built.
# A write that fails is one line in the supervisor log and nothing more — the
# iteration it describes must finish regardless.
speed_record() {
  [ "$RALPH_LOOP_ROLE" = coder ] || return 0
  bun "${RALPH_HOME}/speed.ts" record "$@" >/dev/null 2>> "$SUPERVISOR_LOG" || true
}
# The name of the last sigil in <file>, or `no-sigil`: the outcome an
# iteration-end carries into the speed ledger. Any spelling counts here, the
# role's set included or not — this describes how the iteration ended, it
# decides nothing.
last_sigil_name() { # <file>
  local name
  name="$(grep -Eo '<ralph>(DONE|RETRY_LATER|AWAIT_PR|PHASE|NEEDS_TRIAGE|ALL_BLOCKED|COMPLETE|AWAIT_HOST)[ <]' "$1" 2>/dev/null |
    tail -n 1 | sed -E 's/^<ralph>//; s/[ <]$//')"
  printf '%s' "${name:-no-sigil}"
}

# --- What an operator is allowed to tell this loop ---------------------------
# `ralph/controls.ts` reads the loop's local inbox (`.ralph/control/inbox/`,
# which the dashboard writes, and which an enabled plugin may write through its
# `inbox` hook) for operator commands — pause, resume, stop, approve, deny,
# retry, abandon, release — and answers with one of three verdicts, which it
# prints on its first line and repeats as an exit status:
#
#   0  continue   nothing is holding this loop.
#   10 hold       an operator paused it, or a decision gate has not been
#                 resolved. The supervisor PARKS here — it does not exit —
#                 because a hold is temporary by definition and a loop that
#                 exited on one would need a human to start it again, which is
#                 the opposite of what "pause" means.
#   20 stop       end the run, with the stop kind on the second field.
#
# ANY other status is continue. A plugin that is down, a `bun` that is missing,
# a bug in the poller — none of them may hold or stop a loop that is otherwise
# fine.
#
# The checkpoint sits between iterations, and at each phase boundary inside
# one, which are the only honest places for it: `claude -p` holds one turn for
# tens of minutes and this supervisor neither reads nor interrupts it. A stop
# issued mid-turn therefore takes effect at the boundary its scope names — the
# next iteration by default, the next boundary of either kind for a command
# sent with `"scope": "phase"` — and until it does the record says so,
# `pending` rather than `confirmed`. See `ralph/controls.ts`.
CONTROL_POLL_SECONDS="${RALPH_CONTROL_POLL_SECONDS:-15}"
if [[ ! "$CONTROL_POLL_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "${LOOP_DISPLAY}: RALPH_CONTROL_POLL_SECONDS must be a positive integer; got '${CONTROL_POLL_SECONDS}'." >&2
  exit 1
fi
CONTROL_STOP_KIND=""
CONTROL_STOP_WHY=""
# Set when the stop was carried out at a phase boundary: the phase it stopped
# before. The iteration ends there, and the run ends once it has.
CONTROL_STOP_PHASE=""
# Set when an operator's `retry-phase` released a hold at a phase boundary: the
# phase just finished, to run again in a fresh session.
CONTROL_RETRY_PHASE=""

# The checkpoint is the only place a command is applied, but it is not the only
# place this supervisor waits: the frontier gate, a backoff and a blocked wait
# can each hold it for hours. They used to sleep straight through the inbox,
# so a stop sent to an idle loop sat unread until work turned up. Each of them
# now looks between slices and, when a command is waiting, hands back to the
# checkpoint. Kept in step with `hasPendingCommand` in `ralph/control-inbox.ts`
# (the TypeScript waits ask that): a file an earlier poll already answered —
# its outcome written, only the move left — is not waiting.
#
# A project put to sleep (`ralph/project-sleep.ts`) is waiting too, as it is
# for `hasPendingControl`: every caller of this is a wait between iterations,
# and a loop that slept through its project falling asleep would wake to new
# work and claim it. The marker is in git's common directory, shared by every
# worktree of the project; the cheap existence test runs every slice, and
# `project-sleep.ts` only once one is there, so a marker it cannot read
# reads as awake here exactly as it does at the checkpoint.
RALPH_SLEEP_MARKER="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
RALPH_SLEEP_MARKER="${RALPH_SLEEP_MARKER:+${RALPH_SLEEP_MARKER}/ralph-sleep.json}"
RALPH_SLEEP_MARKER="${RALPH_SLEEP_MARKER:-${PWD}/.ralph-sleep.json}"
control_pending() {
  local file stem
  for file in .ralph/control/inbox/*.json; do
    [ -f "$file" ] || continue
    stem="$(basename "$file" .json)"
    [ -f ".ralph/control/processed/${stem}.outcome.json" ] || return 0
  done
  if [ -f "$RALPH_SLEEP_MARKER" ] &&
    bun "${RALPH_HOME}/project-sleep.ts" status --json 2>/dev/null | grep -q '"asleep":true'; then
    return 0
  fi
  return 1
}
# Sleep $1 seconds in control-poll slices. 0 when the whole wait elapsed, 1 when
# a command cut it short.
control_sleep() {
  local left="$1" step
  while [ "$left" -gt 0 ]; do
    step=$(( left < CONTROL_POLL_SECONDS ? left : CONTROL_POLL_SECONDS ))
    sleep "$step"
    left=$((left - step))
    control_pending && return 1
  done
  return 0
}
# Hold at a boundary until a resolving command arrives.
#   control_checkpoint                      between iterations
#   control_checkpoint <finished> <next>    at the phase boundary before <next>
# With CONTROL_IN_ITERATION set (the host-lease wait between two turns), the
# poll says so, and a sleeping project does not hold it: the sleep lets an
# iteration that has started finish, and holds it at the next one.
# 0 keep going, 1 the caller must stop and read CONTROL_STOP_*, 2 (at a phase
# boundary only) run the phase just finished again, CONTROL_RETRY_PHASE. A hold
# does not return: it parks here, polling, until a command releases it (resume,
# approve, retry-phase) or turns it into a stop (stop, deny). Parked time runs
# no model, so it spends no tokens and nothing the iteration's cap counts; the
# lease is renewed on every poll, and the background heartbeat keeps running.
control_checkpoint() {
  local held=0 held_as="" finished="${1:-}" next="${2:-}"
  local -a where=()
  [ -n "$next" ] && where=(--phase "$next" ${finished:+--after "$finished"})
  [ -z "$next" ] && [ -n "${CONTROL_IN_ITERATION:-}" ] && where=(--in-iteration)
  while :; do
    local out status verdict detail why
    # `--supervised` says who is asking, and it has to be said rather than
    # inferred: this supervisor is about to ACT on the answer, which is what
    # lets a stop it reads be recorded as confirmed rather than as a note left
    # for a process nobody can find. `--phase` says the boundary is inside an
    # iteration, so a command meant for the next one waits for it.
    out="$(bun "${RALPH_HOME}/controls.ts" poll --supervised "${where[@]}" 2>/dev/null)"
    status=$?
    IFS=$'\t' read -r verdict detail why <<< "$(printf '%s\n' "$out" | head -n 1)"
    # Everything after the machine line is for a human reading the pane.
    printf '%s\n' "$out" | tail -n +2 | while IFS= read -r notice; do
      [ -n "$notice" ] && say "${LOOP_DISPLAY}: control — ${notice}"
    done
    case "$status" in
      20)
        CONTROL_STOP_KIND="${detail:-blocked}"
        CONTROL_STOP_WHY="${why:-stopped by an operator}"
        CONTROL_STOP_PHASE="$next"
        return 1
        ;;
      30)
        # Only a phase boundary has a phase to run again; `controls.ts` refuses
        # the command anywhere else, and a detail that is not a phase is read as
        # the phase just finished.
        if [ -n "$next" ]; then
          CONTROL_RETRY_PHASE="$detail"
          [[ "$CONTROL_RETRY_PHASE" =~ ^(select|implement|verify|review|finish)$ ]] || CONTROL_RETRY_PHASE="$finished"
          if [ -n "$CONTROL_RETRY_PHASE" ]; then
            say "${LOOP_DISPLAY}: released to retry ${CONTROL_RETRY_PHASE} — ${why:-retried by an operator}"
            return 2
          fi
        fi
        return 0
        ;;
      10)
        # Recorded once per hold rather than once per poll: a loop parked for an
        # hour would otherwise write four events a minute, and the record's job
        # here is to say WHAT is holding it, which does not change while it is.
        # Recorded again when what holds it changes: a loop resumed while its
        # project sleeps goes straight from the operator's pause to the sleep.
        if [ "$held" -eq 0 ] || [ "$held_as" != "${detail:-hold}" ]; then
          held_as="${detail:-hold}"
          if [ "$held_as" = sleep ]; then
            say "${LOOP_DISPLAY}: asleep with its project${next:+ before ${next}} — ${why:-the project is asleep}"
            say "       Polling every ${CONTROL_POLL_SECONDS}s; wake the project from the dashboard (or bun ${RALPH_HOME}/project-sleep.ts wake), or Ctrl-C to stop."
          else
            say "${LOOP_DISPLAY}: held by an operator (${detail:-hold})${next:+ before ${next}} — ${why:-no reason given}"
            say "       Polling every ${CONTROL_POLL_SECONDS}s; resume it from the dashboard, or Ctrl-C to stop."
          fi
          # At a phase boundary the record names the phase it is held before,
          # which is what the dashboard reads as "held before <phase>".
          record --event control-hold --stage paused ${next:+--phase "$next"} \
            --detail "${detail:-hold}${next:+ before ${next}}: ${why:-held by an operator}"
          held=1
        else
          # The lease still has to be renewed while parked, or a hold long
          # enough to matter would hand this loop's ticket to another one.
          renew_leases
        fi
        sleep "$CONTROL_POLL_SECONDS"
        ;;
      *)
        if [ "$held" -eq 1 ]; then
          say "${LOOP_DISPLAY}: released — ${why:-resumed}"
          # Released inside an iteration goes back to it, in the phase it was
          # held before; between iterations it goes on to the gate.
          if [ -n "$next" ]; then
            record --event control-resume --stage iteration --phase "$next" --detail "${why:-resumed by an operator}"
          else
            record --event control-resume --stage gate --detail "${why:-resumed by an operator}"
          fi
        fi
        return 0
        ;;
    esac
  done
}

# What the orchestrator's own turn did, in the same durable, attributed and
# redacted form `delegate.sh` and `inspect.sh` write for the stages below it.
#
# `record` above says WHERE the loop got to; this says WHY a turn ended badly.
# Those were the same answer for as long as the only orchestrator failure the
# supervisor could name was "no sigil", which is not a reason — it is the
# absence of one. A turn that died on an expired credential, a rate limit, or
# permissions it did not have produced exactly that, and the repair was a
# thousand lines away in the iteration log.
#
# Called on the CLEAN path too, for the reason the two stage scripts give: a
# `claude -p` turn that hit a rate limit, waited, and finished is worth a line,
# and `observe` writes nothing when there is nothing to say.
#
# Never fatal, like everything else in this block.
observe_orchestrator() {
  bun "${RALPH_HOME}/runner-failure.ts" observe --stage orchestrator --runner "$RALPH_RUNNER_ORCHESTRATOR" \
    --model "${ITERATION_MODEL:-$RALPH_MODEL_ORCHESTRATOR}" "$@" >/dev/null 2>&1 || true
  bun "${RALPH_HOME}/push-notification.ts" observation --stage orchestrator >/dev/null 2>&1 || true
}

# --- Waiting on a PR without a model, and the token cap ---------------------
# An iteration's cost is turns × context, and two habits multiplied both: a
# session that blocked on CI and the merge queue polled from inside itself —
# 571 `sleep N; check` turns on 2026-09-18/19, at ~480K tokens of context
# each — and it did so carrying everything the implementation had read. Half
# of that week's cache reads came after the PR was already open.
#
# So a session that has pushed and needs CI or the queue to settle ends with
# `<ralph>AWAIT_PR <pr> ci|merge</ralph>`. The supervisor waits (`pr-wait.ts`,
# no model involved) and then starts a FRESH session on the same iteration,
# whose prompt (`ship-prompt.ts`) is the shipping half of `prompt.md` under a
# preamble carrying the outcome. RALPH_PR_WAIT_ROUNDS bounds how many waits one
# iteration gets; past it the fresh session is told to hand off instead.
#
# Before waiting, `await-pr-check.ts` judges the number (#807: testo ended with
# `AWAIT_PR 2694` — the issue, read off its branch `testo/2694-...` — and the
# supervisor waited on a number that was no PR while its PR was #2768). A
# number gh says is no PR resumes the SAME session with the branch's open PR
# to name instead, at most RALPH_AWAIT_PR_REFUSALS times an iteration; past
# that, or when the check cannot judge, the wait starts as it always did.
#
# RALPH_ITERATION_TOKEN_CAP is the backstop the prompt cannot be: tokens
# processed by every session of the iteration, counted from its events file by
# `iteration-budget.ts`, which stops the session past the cap. The default sits
# well above every normal iteration (p95 63M that week) and well below the one
# that was not (549M). A stopped iteration gets a short handoff session with a
# cap of its own, RALPH_HANDOFF_TOKEN_CAP; the RALPH_BUDGET_STRIKES-th stop on
# the same ticket makes that handoff the blocked exit rather than a retry. 0
# switches the cap off.
RALPH_PR_WAIT_ROUNDS="${RALPH_PR_WAIT_ROUNDS:-6}"
# A wait that ends in `timeout` learned only that nothing has failed yet: CI is
# queued or running behind other builds on the shared host. Resuming a model
# for that is pure cost: 356 of 553 PR sessions in Oct 2026 did nothing but
# ask to wait again, at ~59k fresh cache tokens each. So the supervisor waits
# again by itself, up to RALPH_PR_WAIT_EXTENSIONS times per round, and only an
# outcome someone can act on (or the last timeout) starts a session.
RALPH_PR_WAIT_EXTENSIONS="${RALPH_PR_WAIT_EXTENSIONS:-2}"
RALPH_ITERATION_TOKEN_CAP="${RALPH_ITERATION_TOKEN_CAP:-120000000}"
RALPH_HANDOFF_TOKEN_CAP="${RALPH_HANDOFF_TOKEN_CAP:-8000000}"
RALPH_BUDGET_STRIKES="${RALPH_BUDGET_STRIKES:-2}"
RALPH_AWAIT_PR_REFUSALS="${RALPH_AWAIT_PR_REFUSALS:-2}"
for knob in RALPH_PR_WAIT_ROUNDS RALPH_PR_WAIT_EXTENSIONS RALPH_ITERATION_TOKEN_CAP RALPH_HANDOFF_TOKEN_CAP RALPH_BUDGET_STRIKES RALPH_AWAIT_PR_REFUSALS; do
  if [[ ! "${!knob}" =~ ^[0-9]+$ ]]; then
    echo "${LOOP_DISPLAY}: ${knob} must be a non-negative whole number; got '${!knob}'." >&2
    exit 1
  fi
done
# Extra `pr-wait.ts` flags, for a test that cannot wait out a real interval.
read -r -a RALPH_PR_WAIT_FLAGS <<< "${RALPH_PR_WAIT_ARGS:-}"
AWAIT_SIGIL='<ralph>AWAIT_PR [0-9]+( (ci|merge))?</ralph>'
STOP_SIGILS='<ralph>(NEEDS_TRIAGE|COMPLETE|ALL_BLOCKED|DONE|RETRY_LATER)</ralph>'
# `<ralph>AWAIT_HOST <n></ralph>`: the session needs a heavy local command the
# project's host fence refuses while CI is busy, for an acceptance criterion CI
# does not produce. `host-lease.ts` owns the policy; `await_host` below runs it.
HOST_SIGIL='<ralph>AWAIT_HOST #?[0-9]+</ralph>'

# --- Phase boundaries ---------------------------------------------------------
# An iteration yields at each boundary between its five phases (select,
# implement, verify, review, finish — `ralph/phase.ts` owns the roster) with
# `<ralph>PHASE <next> <n></ralph>`. The supervisor records the phase, appends
# the finished one to the ticket's ledger, passes `phase_checkpoint`, and
# RESUMES THE SAME SESSION: unlike AWAIT_PR's fresh session, the context carries
# over, so a boundary costs one short turn. A terminal sigil or AWAIT_PR in the
# same message wins over it; a malformed one is no sigil at all, and goes to the
# missing-sigil recovery like any other. `phase.test.ts` pins this pattern to
# the roster. RALPH_PHASE_YIELDS bounds the boundaries one iteration may take,
# so a session that yields in a circle hands off rather than spinning.
PHASE_SIGIL='<ralph>PHASE (select|implement|verify|review|finish)( #?[0-9]+)?</ralph>'

# Those four are the WHOLE vocabulary — every ending the supervisor knows how
# to read, and the text `phase.test.ts` pins against `ralph/phase.ts`. What a
# given role may actually end with is a subset of it (`roles.ts`), so each is
# narrowed here, once, before anything reads them.
#
# A sigil outside the role's set is not matched at all: an empty pattern, which
# `has_sigil` treats as "never", so the session falls to the missing-sigil
# recovery and a second such ending stops the supervisor exactly as a no-sigil
# death does. Refused rather than reinterpreted — a triager's `AWAIT_PR` names
# a pull request it never opened, and reading it as DONE would report work that
# did not happen.
sigil_allowed() { # <SIGIL>
  # A word comparison rather than a `case " $list " in *" $1 "*)` glob: the
  # pattern side of `case` would read a `*` or `?` in the argument as a pattern.
  local candidate
  for candidate in $RALPH_ROLE_SIGILS; do
    [ "$candidate" = "$1" ] && return 0
  done
  return 1
}
# `grep -E ''` matches every line, so a disallowed sigil's empty pattern must
# never reach grep. Every read of these patterns goes through here.
has_sigil() { # <pattern> <file>
  [ -n "$1" ] || return 1
  grep -Eq "$1" "$2"
}
# One named sigil, honouring the role's set. The settle below reads each stop
# sigil by its literal text rather than through STOP_SIGILS, and those reads
# need the same fence: a ci-doctor's COMPLETE must not be settled as "backlog
# drained" merely because the narrowed STOP_SIGILS missed it first.
stop_sigil_seen() { # <SIGIL> <file>
  sigil_allowed "$1" || return 1
  grep -q "<ralph>$1</ralph>" "$2"
}
# Why a sigil-less turn died, when the answer is the subscription's usage
# limit. On 2026-10-21 thirteen loops stopped within minutes as "ended without
# a sigil" and the dashboard called it a provider api-error; the reset time
# the operator needed was only in the iteration log. Only the LAST rate-limit
# line counts: a rejection the turn waited out and then worked past is not why
# it ended. Prints nothing, and fails, for any other death.
usage_limit_reason() { # <iteration log>
  [ -f "$1" ] || return 1
  local window resets label
  window="$(grep -oE 'rate limit: [a-z_]+ — [a-z_]+' "$1" 2>/dev/null | tail -n 1)"
  case "$window" in
    "rate limit: rejected — "*) window="${window##* }" ;;
    *) return 1 ;;
  esac
  case "$window" in
    five_hour) label="5-hour session" ;;
    seven_day) label="weekly" ;;
    seven_day_*) label="weekly ${window#seven_day_}" ;;
    *) label="$window" ;;
  esac
  # Claude's own sentence carries the reset in the operator's timezone, e.g.
  # "You've hit your session limit · resets 10:30pm (America/Santiago)".
  resets="$(grep -E '\] text: .*hit your .*limit' "$1" 2>/dev/null | tail -n 1 | grep -oE 'resets .*$' || true)"
  printf 'hit the Claude %s usage limit%s' "$label" "${resets:+, which ${resets}}"
}
if [ -z "$RALPH_ROLE_STOP_SIGILS" ]; then
  echo "${LOOP_DISPLAY}: the ${RALPH_LOOP_ROLE} role declares no terminal sigil, so no iteration of it could ever end." >&2
  exit 1
fi
sigil_allowed AWAIT_PR || AWAIT_SIGIL=""
sigil_allowed AWAIT_HOST || HOST_SIGIL=""
sigil_allowed PHASE || PHASE_SIGIL=""
STOP_SIGILS="<ralph>($(printf '%s' "$RALPH_ROLE_STOP_SIGILS" | tr ' ' '|'))</ralph>"

RALPH_PHASE_YIELDS="${RALPH_PHASE_YIELDS:-12}"
if [[ ! "$RALPH_PHASE_YIELDS" =~ ^[0-9]+$ ]]; then
  echo "${LOOP_DISPLAY}: RALPH_PHASE_YIELDS must be a non-negative whole number; got '${RALPH_PHASE_YIELDS}'." >&2
  exit 1
fi

# --- Backing off a target that is not moving ---------------------------------
# The gate says "work" for as long as this loop's PR is open, and on 2026-09-23
# rafa took it at its word seven times in six minutes: seven Opus sessions,
# each re-discovering that Vercel was blocking every deploy, each ending DONE
# on a PR that never changed. The ninth ended NEEDS_TRIAGE to stop the spin,
# and the loop was dead for the night over an outage it could have waited out.
#
# `backoff.ts` separates the two things DONE was carrying. An iteration that
# found the work blocked on something external ends `<ralph>RETRY_LATER</ralph>`;
# an iteration that left its shepherd PR exactly as it found it is treated the
# same way whatever it ended with. Either one starts a wait with no model in
# it — doubling from RALPH_BACKOFF_BASE_SECONDS up to RALPH_BACKOFF_MAX_SECONDS,
# polling the PR every RALPH_BACKOFF_POLL_SECONDS so a push or a merge wakes it
# — and then one iteration re-checks. Past RALPH_BACKOFF_BUDGET_SECONDS of
# waiting in one streak, the supervisor stops for a human instead: an outage
# that outlasts the budget is triage after all.
export RALPH_BACKOFF_BASE_SECONDS="${RALPH_BACKOFF_BASE_SECONDS:-300}"
export RALPH_BACKOFF_MAX_SECONDS="${RALPH_BACKOFF_MAX_SECONDS:-3600}"
export RALPH_BACKOFF_BUDGET_SECONDS="${RALPH_BACKOFF_BUDGET_SECONDS:-21600}"
export RALPH_BACKOFF_POLL_SECONDS="${RALPH_BACKOFF_POLL_SECONDS:-60}"
for knob in RALPH_BACKOFF_BASE_SECONDS RALPH_BACKOFF_MAX_SECONDS RALPH_BACKOFF_BUDGET_SECONDS RALPH_BACKOFF_POLL_SECONDS; do
  if [[ ! "${!knob}" =~ ^[1-9][0-9]*$ ]]; then
    echo "${LOOP_DISPLAY}: ${knob} must be a positive whole number of seconds; got '${!knob}'." >&2
    exit 1
  fi
done

# A turn the account's usage limit rejected ends at once with no sigil, which
# used to stop the loop as failed (2026-10-21: thirteen loops, each needing a
# restart after the reset). The limit names its own reset, so the supervisor
# waits it out instead: `usage-limit.ts detect` writes this file when the
# iteration's last rate_limit_event is a rejection, and the top of the main
# loop sleeps until the time it holds. Kept across iterations, not cleared at
# startup like the backoff: a restart before the reset would only hit the same
# wall.
USAGE_WAIT_STATE=".ralph/logs/usage-wait.json"
# The line `detect` printed: "waiting for usage reset until HH:MM (...)".
USAGE_WAIT_SAID=""

# 0 when this iteration's events end on a usage-limit rejection, with the state
# armed and USAGE_WAIT_SAID set. Never fatal: a reader that cannot run is "not
# limited", which is how every no-sigil ending was read before.
usage_limited() {
  USAGE_WAIT_SAID="$(bun "${RALPH_HOME}/usage-limit.ts" detect --events "$events" \
    --state "$USAGE_WAIT_STATE" 2>> "$SUPERVISOR_LOG")" || { USAGE_WAIT_SAID=""; return 1; }
  # Both detect's own line and the state it arms: anything else on stdout is
  # not a limit, and a limit with no state would skip the wait and spin
  # through uncounted iterations.
  if [[ "$USAGE_WAIT_SAID" == "waiting for usage reset"* ]] && [ -f "$USAGE_WAIT_STATE" ]; then
    return 0
  fi
  USAGE_WAIT_SAID=""
  return 1
}

# --- The plan usage stop (usage-stop.ts) -------------------------------------
# A share of the account's plan, chosen per project or per loop, past which a
# loop stops spending it: at `percent` it drains — no new ticket, the one it
# holds goes on to its hand-off — and at `hardPercent` (or once nothing is
# held) it parks until the window it watches resets. The account's own limit
# (#407, above) only rejects at 100%, after every loop has spent the week the
# operator meant to keep. Asked fresh at every pass of the main loop, so an
# override the dashboard writes, a waiver or a window that reset all apply at
# the next checkpoint, and no state file can outlive the reset it was about.
# A check that cannot run is "run": a stop that fails open is today's loop.
# How long a park sleeps between checks, RALPH_USAGE_STOP_RECHECK_SECONDS, is
# set before the startup preflight.
USAGE_STOP_VERDICT=run
USAGE_STOP_SECONDS=0
USAGE_STOP_KEY=""
USAGE_STOP_DETAIL=""
# What the last pass said, so a park that lasts days logs and records once per
# change rather than once per recheck.
USAGE_STOP_SAID=""
USAGE_DRAINING=0

usage_stop_check() {
  local out
  out="$(bun "${RALPH_HOME}/usage-stop.ts" check --loop "$RALPH_LOOP_NAME" 2>> "$SUPERVISOR_LOG" | head -n 1)" || out=""
  IFS=$'\t' read -r USAGE_STOP_VERDICT USAGE_STOP_SECONDS USAGE_STOP_KEY USAGE_STOP_DETAIL <<< "$out"
  case "$USAGE_STOP_VERDICT" in
    run|drain|park) ;;
    *) USAGE_STOP_VERDICT=run ;;
  esac
  [[ "$USAGE_STOP_SECONDS" =~ ^[0-9]+$ ]] || USAGE_STOP_SECONDS=0
  [ "$USAGE_STOP_KEY" = - ] && USAGE_STOP_KEY=""
  # A drain or park with no time left would spin; the next check reads the
  # window as reset and runs.
  if [ "$USAGE_STOP_VERDICT" != run ] && [ "$USAGE_STOP_SECONDS" -eq 0 ]; then
    USAGE_STOP_VERDICT=run
  fi
  return 0
}

# Park for one recheck interval (or what is left of the window, if less), with
# no model and the claim kept. <why> says what parked it: the hard threshold,
# or a drain with nothing left to finish. Returns when the sleep ends or an
# operator command arrives; the caller goes back to the control checkpoint.
usage_stop_park() { # <why>
  local why="$1" step
  if [ "$USAGE_STOP_SAID" != "park:${USAGE_STOP_KEY}:${why}" ]; then
    USAGE_STOP_SAID="park:${USAGE_STOP_KEY}:${why}"
    say "${LOOP_DISPLAY}: plan usage stop — ${USAGE_STOP_DETAIL}; ${why}. Parked, claim kept (waive: bun ${RALPH_HOME}/usage-stop.ts waive --loop ${RALPH_LOOP_NAME})."
    record --event usage-stop --stage gate --detail "${USAGE_STOP_DETAIL}; ${why}"
    bun "${RALPH_HOME}/push-notification.ts" push --kind usage-stop \
      --occurrence "usage-stop:${RALPH_LOOP_NAME}:${USAGE_STOP_KEY}" \
      --subject "${RALPH_LOOP_NAME} parked at its plan usage stop" \
      --body "${USAGE_STOP_DETAIL}; ${why}. It resumes on its own when the window resets; to run it sooner: bun ${RALPH_HOME}/usage-stop.ts waive --loop ${RALPH_LOOP_NAME} (in $(pwd))." \
      --priority normal >/dev/null 2>> "$SUPERVISOR_LOG" || true
  fi
  renew_leases
  step=$(( USAGE_STOP_SECONDS < RALPH_USAGE_STOP_RECHECK_SECONDS ? USAGE_STOP_SECONDS : RALPH_USAGE_STOP_RECHECK_SECONDS ))
  control_sleep "$step" || true
}

# Why a finished drain parks; also how a recheck tells it has nothing new to say.
USAGE_DRAIN_DONE="nothing held is left to finish"

usage_drain_announce() {
  USAGE_STOP_SAID="drain:${USAGE_STOP_KEY}"
  say "${LOOP_DISPLAY}: plan usage stop — ${USAGE_STOP_DETAIL}; draining: only work this loop already holds."
  record --event usage-drain --stage gate --detail "$USAGE_STOP_DETAIL"
}

# 0 when the gate's verdict line is work this loop already holds: a pull
# request of its own to shepherd, its own unfinished claim, or local recovery
# work. A frontier ticket or a spec to close is new work, which a drain does
# not take. Matched on the verdict's own phrasing (`frontier-gate.ts`),
# anchored like the gate lines below so a ticket title cannot pass for one.
usage_drain_held() { # <gate line>
  local case_text
  case_text="$(printf '%s\n' "$1" | sed -nE 's/^[A-Za-z0-9_.-]+: work available — (.*)$/\1/p')"
  case "$case_text" in
    "frontier ticket #"*|"spec #"*) return 1 ;;
  esac
  printf '%s\n' "$case_text" | grep -qE '^[A-Za-z0-9]+ PR #[0-9]+ to shepherd|^issue #[0-9]+ carries this loop.s unfinished claim|^local recovery work on '
}

# 0 when <file> carries any sigil this role may use. Each pattern separately,
# because a disallowed sigil's is empty and an empty alternation branch would
# match everything — which would read every ending, valid or not, as "a sigil
# was there".
any_sigil() { # <file>
  local pattern
  for pattern in "$STOP_SIGILS" "$AWAIT_SIGIL" "$HOST_SIGIL" "$PHASE_SIGIL"; do
    has_sigil "$pattern" "$1" && return 0
  done
  return 1
}

# Watches this iteration's events for the cap. Never fatal: a guard that cannot
# start leaves the iteration uncapped, which is how every iteration ran before.
start_budget_guard() { # <session> <cap> [--only-session]
  BUDGET_GUARD_PID=""
  [ "$2" -gt 0 ] || return 0
  bun "${RALPH_HOME}/iteration-budget.ts" watch --events "$events" --limit "$2" \
    --session "$1" --marker "$budget_marker" --supervisor "$$" ${3:-} >/dev/null 2>&1 &
  BUDGET_GUARD_PID=$!
}

# Holds a turn while the project's secrets scope cannot be read (#759). The
# startup probe only covers the first turn: a login keyring that locks again,
# or a Doppler outage, would otherwise make every later turn's `doppler run`
# wrapper fail, and the turn would be read as a failed or crashed iteration
# for a fault no model can fix. So the same probe is asked before each turn,
# and a failing one waits — no turn spent, no failure recorded — on the
# preflight wait's interval, alert and operator-stop handling.
# Only the SCOPE is probed, not the env filter: the filter runs the project's
# envCheck, and a refusal there is no secrets outage — it would be logged as
# one and waited on forever. A failure is classified as the startup preflight
# classifies it (`preflight.ts --doppler-failure`): auth or setup the operator
# must fix stops the loop as the startup check does, with the remedy; anything
# else, or a classifier that could not answer, is a wait.
# Never fatal otherwise, and a project with no secrets manager is never asked.
#
# A dotenv file (#49) has no classifier: the wrapper's own exit says what is
# wrong (3 missing, 4 unreadable, 5 malformed). Such a refusal is waited on —
# an operator saving the file, or a mount coming up late, clears by a later
# probe — and stops the loop only when refusals in a row span at least one
# retry interval (`RALPH_PREFLIGHT_RETRY_SECONDS`) of real time: two probes at
# the least, and never two seconds apart because `control_sleep` returned
# early. Any other failure (a timeout on a loaded host, bun killed) is an
# ordinary wait, and like a success it starts the count again.
await_secrets_scope() {
  [ "${#RALPH_SECRETS_CMD[@]}" -gt 0 ] || return 0
  local probe_err="${SUPERVISOR_LOG%/*}/secrets-scope-${RALPH_RUN_ID}.err"
  local waited=0 started="" alerted="" why failure probe_status dotenv_refused_at=""
  while true; do
    probe_status=0
    timeout 45 "${RALPH_SECRETS_CMD[@]}" true >/dev/null 2> "$probe_err" || probe_status=$?
    [ "$probe_status" = 0 ] && break
    if [ "$RALPH_SECRETS_RUNNER" = "dotenv" ]; then
      case "$probe_status" in
        3 | 4 | 5)
          # The wrapper's one stderr line names the file and which of the
          # three; it never holds a value.
          if [ -n "$dotenv_refused_at" ] && [ $(($(date +%s) - dotenv_refused_at)) -ge "$PREFLIGHT_RETRY" ]; then
            why="$(head -n 1 "$probe_err" 2>/dev/null | cut -c 1-200)"
            rm -f "$probe_err"
            say "${LOOP_DISPLAY}: the secrets file ${RALPH_SECRETS_FILE} cannot be read (${why:-no error output}); stopping before the turn."
            record --event secrets-env --stop failed \
              --why "the secrets file ${RALPH_SECRETS_FILE} cannot be read (${why:-no error output}); no turn was spent"
            exit 1
          fi
          [ -n "$dotenv_refused_at" ] || dotenv_refused_at="$(date +%s)"
          ;;
        *) dotenv_refused_at="" ;;
      esac
      failure="unavailable"
    else
      failure="$(bun "${RALPH_HOME}/preflight.ts" --doppler-failure < "$probe_err" 2>/dev/null || true)"
    fi
    if [ "$failure" = "denied" ]; then
      why="$(head -n 1 "$probe_err" 2>/dev/null | cut -c 1-200)"
      rm -f "$probe_err"
      say "${LOOP_DISPLAY}: Doppler ${RALPH_SECRETS_PROJECT}/${RALPH_SECRETS_CONFIG} secrets cannot be read — missing access or expired auth (${why:-no error output}); stopping before the turn."
      say "${LOOP_DISPLAY}: to fix: doppler setup -p ${RALPH_SECRETS_PROJECT} -c ${RALPH_SECRETS_CONFIG}   (then: doppler login)"
      record --event secrets-env --stop failed \
        --why "Doppler ${RALPH_SECRETS_PROJECT}/${RALPH_SECRETS_CONFIG} secrets cannot be read — missing access or expired auth; no turn was spent"
      exit 1
    fi
    if [ -z "$started" ]; then
      started="$(date +%s)"
      # The first line only, cut: Doppler's errors can run to a page, and the
      # line is a reason, not a log.
      why="$(head -n 1 "$probe_err" 2>/dev/null | cut -c 1-200)"
      say "${LOOP_DISPLAY}: the secrets scope could not be read (${why:-no error output}); the turn waits and tries again every ${PREFLIGHT_RETRY}s."
      record --event secrets-scope-wait --stage iteration \
        --detail "the secrets scope could not be read: ${why:-no error output}"
    fi
    # Once per wait, like the preflight's: a scope that never reads again is
    # the shape a revoked token takes, and nobody is watching overnight. The
    # kind is the preflight's because push-notification.ts takes a fixed list
    # and this is the same stall one step later; the occurrence has its own
    # prefix so it never collapses into the preflight's own alert.
    if [ -z "$alerted" ] && [ "$waited" -ge "$PREFLIGHT_ALERT" ]; then
      alerted=1
      bun "${RALPH_HOME}/push-notification.ts" push --kind preflight-stalled \
        --occurrence "secrets-scope-stalled:${RALPH_RUN_ID}:${started}" \
        --subject "${RALPH_LOOP_NAME} waiting on its secrets scope" \
        --body "the ${RALPH_LOOP_NAME} loop has waited ${waited}s before a turn because its secrets scope cannot be read; it keeps waiting. See ${SUPERVISOR_LOG}." \
        --priority high >/dev/null 2>> "$SUPERVISOR_LOG" || true
    fi
    if ! control_sleep "$PREFLIGHT_RETRY" && ! CONTROL_IN_ITERATION=1 control_checkpoint; then
      rm -f "$probe_err"
      say "${LOOP_DISPLAY}: stopped by an operator while waiting on the secrets scope — ${CONTROL_STOP_WHY}"
      record --event control-stop --stop "$CONTROL_STOP_KIND" --why "$CONTROL_STOP_WHY"
      [ "$CONTROL_STOP_KIND" = "failed" ] && exit 1
      exit 0
    fi
    # Real time, not intervals asked for: a sleeping project cuts control_sleep
    # short, and counting the full interval would fire the alert early.
    waited=$(( $(date +%s) - started ))
  done
  rm -f "$probe_err"
  [ -z "$started" ] || say "${LOOP_DISPLAY}: the secrets scope reads again after ${waited}s — running the turn."
  return 0
}

# One `claude -p` turn, appended to this iteration's log and events. Every
# session of an iteration goes through here — the first, a sigil recovery, one
# resumed after a PR wait, a budget handoff — so the shape the long comment in
# the loop below explains exists exactly once.
#   orchestrator_turn <prompt> <final> <signals> <errlog> <cap> <cap-scope> --session-id|--resume <session>
# Sets ITER_STATUS to the selected runner's exit status.
orchestrator_turn() {
  local turn_prompt="$1" turn_final="$2" turn_signals="$3" turn_errlog="$4" turn_cap="$5" turn_scope="$6"
  shift 6
  local turn_errdone="${turn_errlog}.done"
  local errwait=0 status
  # Before the host lease, so a loop waiting on its own secrets never holds
  # the host from another loop.
  await_secrets_scope
  # Held here while another loop has the host (`host-lease.ts`), and counted
  # as inside a turn from here to the end, so a draining holder can see it.
  # Never fatal: a store that cannot be read lets the turn through.
  #
  # A role that runs no local gates takes no part in the lease (`roles.ts`):
  # it never holds the host and is never held waiting for it, because holding
  # a triager behind a busy host pays an iteration's latency for a fence its
  # work cannot trip. `AWAIT_HOST` is not among its sigils either, so it
  # cannot ask for what it does not wait on.
  #
  # Exit 3 is "held, and an operator command is waiting": apply it at the
  # checkpoint — a stop ends the run here exactly as it does at the iteration
  # checkpoint, with the claim kept for the next run — and ask again. Any
  # other status lets the turn through: never fatal.
  if [ "$RALPH_ROLE_HOST_LEASE" = 1 ]; then
    local turn_hold
    while :; do
      bun "${RALPH_HOME}/host-lease.ts" turn-begin 2>> "$SUPERVISOR_LOG" | tee -a "$SUPERVISOR_LOG"
      turn_hold="${PIPESTATUS[0]}"
      [ "$turn_hold" -eq 3 ] || break
      # No boundary argument: a held turn is not a phase boundary, and the
      # hold IS the loop's idle moment, so a command of either scope is
      # answered here rather than deferred to a boundary the loop may not
      # reach for hours. The cost is that an operator who pauses "at the next
      # phase" and then retries that phase has the pause consumed here, and
      # the retry refused for want of a boundary.
      #
      # A stop exits without closing the iteration, the way the iteration
      # checkpoint does, so a hold on a SECOND or later turn ends a run whose
      # `iteration-start` has no `iteration-end` and whose usage step is left
      # open. Deliberate and scoped out of #303: handing the stop back out of
      # this function instead would touch all seven call sites. The durable
      # state a later run resumes from — the claim, the branch, the handoff
      # note, the phase ledger — is written before the turn and is unaffected.
      if ! CONTROL_IN_ITERATION=1 control_checkpoint; then
        say "${LOOP_DISPLAY}: stopped by an operator while held for the host — ${CONTROL_STOP_WHY}"
        record --event control-stop --stop "$CONTROL_STOP_KIND" --why "$CONTROL_STOP_WHY"
        [ "$CONTROL_STOP_KIND" = "failed" ] && exit 1
        exit 0
      fi
    done
  fi
  rm -f "$turn_errdone"
  : > "$turn_errlog"
  start_budget_guard "$2" "$turn_cap" "$turn_scope"
  local -a turn_command
  local turn_input
  if [ "$RALPH_RUNNER_ORCHESTRATOR" = codex ]; then
    exec {turn_input}<<< "$turn_prompt"
    turn_command=(python3 "${RALPH_HOME}/codex-orchestrator.py" --session-id "$2" --model "$RALPH_MODEL_ORCHESTRATOR")
    [ "$1" != --resume ] || turn_command+=(--resume)
    [ -z "${RALPH_MODEL_ORCHESTRATOR_EFFORT:-}" ] || turn_command+=(--effort "$RALPH_MODEL_ORCHESTRATOR_EFFORT")
  else
    exec {turn_input}</dev/null
    turn_command=(claude -p "$turn_prompt" "${RALPH_CLAUDE_MODEL_ARGS[@]}" "$@"
      --dangerously-skip-permissions --output-format stream-json --verbose)
  fi
  # In the background and waited on, so a signal's trap runs mid-turn
  # (signal-stop.sh); the pipeline's statuses come back through a file.
  local turn_pipestatus="${turn_errlog}.pipestatus"
  rm -f "$turn_pipestatus"
  {
    "${RALPH_SECRETS_CMD[@]}" "${RALPH_ENV_FILTER[@]}" \
      nice -n 5 "${turn_command[@]}" <&"$turn_input" \
      2> >("${RALPH_SECRETS_CMD[@]}" "${RALPH_ENV_FILTER[@]}" \
             bun "${RALPH_HOME}/runner-failure.ts" redact --done "$turn_errdone" > "$turn_errlog") \
      | "${RALPH_SECRETS_CMD[@]}" "${RALPH_ENV_FILTER[@]}" \
          python3 "${RALPH_HOME}/stream-render.py" \
            --events "$events" --final "$turn_final" --signals "$turn_signals" \
      | tee -a "$log"
    printf '%s\n' "${PIPESTATUS[*]}" > "$turn_pipestatus"
  } &
  wait "$!"
  # See (2) in the loop's comment: `claude`'s status is PIPESTATUS[0], and the
  # stderr filter is waited on for at most ten seconds, never with `wait`. A
  # file that never got written is a turn that did not finish: a failure.
  local -a turn_pipe=(1)
  [ -s "$turn_pipestatus" ] && read -r -a turn_pipe < "$turn_pipestatus"
  rm -f "$turn_pipestatus"
  ITER_STATUS="${turn_pipe[0]}"
  # An incomplete renderer/tee stream cannot authorize a supervisor transition.
  if [ "$ITER_STATUS" -eq 0 ]; then
    for status in "${turn_pipe[@]:1}"; do
      [ "$status" -eq 0 ] || ITER_STATUS=1
    done
  fi
  exec {turn_input}<&-
  [ "$RALPH_ROLE_HOST_LEASE" = 1 ] &&
    bun "${RALPH_HOME}/host-lease.ts" turn-end >/dev/null 2>> "$SUPERVISOR_LOG" || true
  stop_budget_guard
  while [ ! -f "$turn_errdone" ] && [ "$errwait" -lt 100 ]; do
    sleep 0.1
    errwait=$((errwait + 1))
  done
  rm -f "$turn_errdone"
}

# A clean Claude exit with no control sigil is usually a model handoff bug,
# not proof that the work itself failed. Give that exact case one small,
# resumed turn whose only job is to settle the iteration. This is bounded:
# runner failures never retry here, a turn the token cap stopped is not
# "clean", and a second missing sigil still stops the supervisor. We do not
# infer DONE from prose because that would turn an unknown ending into fake
# progress.
recover_missing_sigil() {
  [ "$ITER_STATUS" -eq 0 ] || return 0
  [ -f "$budget_marker" ] && return 0
  any_sigil "$final" && return 0
  # A turn the usage limit rejected is not a handoff bug: a resumed turn would
  # hit the same wall. The state `detect` armed is what the iteration's end
  # reads to wait instead of stopping.
  if usage_limited; then
    say "${LOOP_DISPLAY}: iteration ${i} was rejected by the usage limit — not spending the sigil recovery."
    return 0
  fi
  say "${LOOP_DISPLAY}: iteration ${i} ended cleanly without a sigil — recovering the missing sigil once."
  record --event sigil-recovery --stage iteration --iteration "$i" --max "$MAX" \
    --detail "$log"

  local recovery_ts recovery_final recovery_signals recovery_errlog recovery_prompt
  recovery_ts="$(date +%Y%m%dT%H%M%S)"
  recovery_final=".ralph/logs/iter-${recovery_ts}-$$-recovery.final.txt"
  recovery_signals=".ralph/logs/signals-orchestrator-${recovery_ts}-$$-recovery.jsonl"
  recovery_errlog=".ralph/logs/iter-${recovery_ts}-$$-recovery.err"
  # The role's own text (`roles.ts`): the recovery turn is a menu of endings,
  # and offering one this role may not use invites the ending that got the
  # session here. A code-context iteration has its own (set where it starts):
  # the role's speaks of a plan that session never had to write.
  recovery_prompt="${ITERATION_RECOVERY_PROMPT:-$RALPH_ROLE_RECOVERY_PROMPT}"

  orchestrator_turn "$recovery_prompt" "$recovery_final" "$recovery_signals" "$recovery_errlog" \
    "$RALPH_ITERATION_TOKEN_CAP" "" --resume "$RALPH_SESSION_ID"
  [ -s "$recovery_errlog" ] && say "${LOOP_DISPLAY}: sigil recovery stderr: ${recovery_errlog}"
  observe_orchestrator --exit "$ITER_STATUS" --log "$log" \
    --errors "$recovery_errlog" --signals "$recovery_signals"
  final="$recovery_final"
}

# Closes the usage step of a session that is about to be replaced, so its tail
# lands in the ledger under its own session id before the next one starts.
close_session_usage() {
  "${RALPH_HOME}/usage.py" --step "$1" 2>&1 | tee -a "$log" | sed 's/^/usage: /'
}

# Starts the next session of this iteration under a fresh id.
next_session() {
  RALPH_SESSION_ID="$(uuidgen)"
  RALPH_ITERATION_SESSIONS="${RALPH_ITERATION_SESSIONS} ${RALPH_SESSION_ID}"
  export RALPH_SESSION_ID RALPH_ITERATION_SESSIONS
}

# The open issue this loop claims, or nothing. Bounded, and never fatal: the
# callers use it for bookkeeping, and a tracker that cannot answer must not
# stop the iteration it is describing.
claimed_issue() {
  timeout "${RALPH_RECOVERY_PROBE_TIMEOUT:-15}" \
    bun "${RALPH_HOME}/tracker.ts" claimed 2>/dev/null | head -n 1 || true
}

# --- Resuming an interrupted ticket from its ledger ----------------------------
# An iteration cut off between phases — a phase stop, a Stop now, a crash, a
# restart, a hold or the yield bound — leaves the claim, the branch, the notes
# and the ticket's ledger. The next iteration that resumes the claim used to
# start it from the top, select and map included; now it starts a FRESH session
# at the phase after the last one that finished, from that phase's handoff
# note, once `phase-prompt.ts resume` has checked the ledger against the
# worktree: the same branch, the recorded head in its history, the note on
# disk. A missing, stale or contradicted ledger — or a builder that cannot run
# — falls back to today's path, the whole prompt and §1's claim recovery, and
# the supervisor log and the iteration's record say why.
#
# Which ticket: the one a Stop now interrupted, on the first iteration of the
# run the dashboard's Resume work started (RALPH_RESUME_ISSUE). Otherwise this
# loop's one unfinished claim, asked of the tracker only when some ledger is on
# disk — a loop with none has nothing to resume, and pays no `gh` call for it.
# Two claims are §1's NEEDS_TRIAGE to make, never a guess here.
#
# Sets RESUME_PHASE, RESUME_AFTER (the phase that finished) and RESUME_PROMPT
# when resuming, RESUME_WHY either way (the reason when not), and
# ITERATION_TICKET to the ticket it looked at.
#
# The resumed session enters its phase across that phase's boundary, so the
# caller passes `phase_checkpoint` first: a phase-scoped pause or stop, an
# armed gate or a retry-phase acts there as it would have in the interrupted
# iteration. A gate denied before `finish` is asked again, never walked past.
ledger_on_disk() {
  local file
  for file in .ralph/logs/phases/*.jsonl; do
    [ -f "$file" ] && return 0
  done
  return 1
}
phase_resume() {
  local ticket="" out verdict phase after why
  RESUME_PHASE=""
  RESUME_AFTER=""
  RESUME_PROMPT=""
  RESUME_WHY=""
  if [ "$i" -eq 1 ] && [ "${RALPH_RESUME_WORK:-0}" = "1" ] && [[ "${RALPH_RESUME_ISSUE:-}" =~ ^[1-9][0-9]*$ ]]; then
    ticket="$RALPH_RESUME_ISSUE"
  elif ledger_on_disk; then
    ticket="$(timeout "${RALPH_RECOVERY_PROBE_TIMEOUT:-15}" \
      bun "${RALPH_HOME}/tracker.ts" claimed 2>/dev/null | head -n 2 || true)"
  fi
  # None, several, or an answer that is not one ticket: nothing to resume.
  [[ "$ticket" =~ ^[1-9][0-9]*$ ]] || return 0
  ITERATION_TICKET="$ticket"
  out="$(printf '%s' "$RALPH_PROMPT" | bun "${RALPH_HOME}/phase-prompt.ts" resume \
    --ticket "$ticket" --iteration "$i" 2>> "$SUPERVISOR_LOG")" || out=""
  IFS=$'\t' read -r verdict phase after why <<< "$(printf '%s\n' "$out" | head -n 1)"
  if [ "$verdict" = resume ] && [[ "$phase" =~ ^(select|implement|verify|review|finish)$ ]] &&
     [[ "$after" =~ ^(select|implement|verify|review|finish)$ ]]; then
    RESUME_PROMPT="$(printf '%s\n' "$out" | tail -n +2)"
    if [ -n "$RESUME_PROMPT" ]; then
      RESUME_PHASE="$phase"
      RESUME_AFTER="$after"
      RESUME_WHY="${why:-the ledger agrees with the worktree}"
      return 0
    fi
  fi
  if [ "$verdict" = fallback ]; then
    RESUME_WHY="${why:-the ledger could not be used}"
  else
    RESUME_WHY="the resume check could not run"
  fi
  say "${LOOP_DISPLAY}: #${ticket} is not resumed from its phase ledger — ${RESUME_WHY}; iteration ${i} starts from the top."
}

# Where a control acts on a phase boundary. Called with the phase just
# finished, the phase about to start, and the ticket (possibly empty), after
# the boundary is recorded and before the session resumes.
#
# A pause, stop or approval request sent with `"scope": "phase"` is applied
# here; one of the default scope waits in the inbox for the iteration
# boundary. A hold parks in `control_checkpoint` with the session intact, and
# 0 — its release — resumes the same session into <next>. A stop returns 1,
# which ends the iteration at this boundary as a handoff, with the claim, the
# branch, the note and the ledger left in place, and the run ends once the
# iteration has closed (CONTROL_STOP_PHASE). A control channel that cannot
# run answers continue, so the session resumes as it did before any of this.
phase_checkpoint() { # <finished> <next> [ticket]
  local held_from=$SECONDS status=0
  control_checkpoint "$1" "$2" || status=$?
  # An operator's hold inside the iteration runs no model: the speed ledger
  # counts it as waiting, like a PR wait, not as active time. An unheld
  # checkpoint is one poll, which rounds to nothing.
  ITERATION_WAITED=$((ITERATION_WAITED + SECONDS - held_from))
  return "$status"
}

# An operator held the loop after <phase> and asked for it to run again. Start
# a FRESH session on it — its prompt is the handoff note of the phase before it
# plus <phase>'s sections of `prompt.md` (`ralph/phase-prompt.ts`) — under the
# iteration's own token cap, so a retry spends from the same budget as every
# other session of the iteration. Sets `final`. 1 when the prompt cannot be
# built: the caller then resumes the old session into <next>, as a release
# would have, rather than halting.
phase_retry() { # <phase> <next> [ticket]
  local phase="$1" next="$2" ticket="${3:-}" retry_prompt phase_ts phase_final phase_signals phase_errlog
  if ! retry_prompt="$(printf '%s' "$RALPH_PROMPT" | bun "${RALPH_HOME}/phase-prompt.ts" retry \
         --phase "$phase" --next "$next" ${ticket:+--ticket "$ticket"} --iteration "$i" 2>> "$SUPERVISOR_LOG")" ||
     [ -z "$retry_prompt" ]; then
    say "${LOOP_DISPLAY}: could not build the prompt to retry ${phase}; resuming session ${RALPH_SESSION_ID} into ${next} instead."
    return 1
  fi
  close_session_usage "iteration ${i} retrying ${phase}"
  next_session
  ITERATION_PHASE="$phase"
  # The next boundary's ledger line is this attempt, marked as a retry.
  PHASE_RETRY="$phase"
  say "=== ${LOOP_DISPLAY} iteration ${i}: fresh session ${RALPH_SESSION_ID} retrying ${phase}${ticket:+ on #${ticket}} ==="
  record --event phase-retry --stage iteration --iteration "$i" --max "$MAX" --phase "$phase" \
    --detail "retrying ${phase}${ticket:+ on #${ticket}} before ${next}; session ${RALPH_SESSION_ID}"
  phase_ts="$(date +%Y%m%dT%H%M%S)"
  phase_final=".ralph/logs/iter-${phase_ts}-$$-retry${PHASE_YIELDS}.final.txt"
  phase_signals=".ralph/logs/signals-orchestrator-${phase_ts}-$$-retry${PHASE_YIELDS}.jsonl"
  phase_errlog=".ralph/logs/iter-${phase_ts}-$$-retry${PHASE_YIELDS}.err"
  orchestrator_turn "$retry_prompt" "$phase_final" "$phase_signals" "$phase_errlog" \
    "$RALPH_ITERATION_TOKEN_CAP" "" --session-id "$RALPH_SESSION_ID"
  [ -s "$phase_errlog" ] && say "${LOOP_DISPLAY}: iteration ${i} ${phase} retry stderr: ${phase_errlog}"
  observe_orchestrator --exit "$ITER_STATUS" --log "$log" --errors "$phase_errlog" --signals "$phase_signals"
  final="$phase_final"
  recover_missing_sigil
  return 0
}

# Whether <ticket> reads `closed` in the tracker — merged from outside the
# loops while this iteration worked on it (#809). Bounded like
# `claimed_issue()`, and parsed without jq: a timeout, a failed read, an empty
# or non-JSON answer, or any state but `closed` is "not closed", so an
# unreadable tracker never ends an iteration.
ticket_closed() { # <ticket>
  local state
  state="$(timeout "${RALPH_RECOVERY_PROBE_TIMEOUT:-15}" bun "${RALPH_HOME}/tracker.ts" view "$1" --json 2>/dev/null |
    bun -e 'try { const s = JSON.parse(await Bun.stdin.text()).state; if (typeof s === "string") console.log(s); } catch {}' 2>/dev/null || true)"
  [ "$state" = closed ]
}

# A ticket closed outside the loop (#809) holds no claim worth keeping,
# whatever its wrap-up ended on: release its lease so no loop waits it out.
# Bounded and never fatal, like every supervisor read.
release_closed_ticket() {
  [ -n "$PHASE_CLOSED_TICKET" ] || return 0
  timeout "${RALPH_RECOVERY_PROBE_TIMEOUT:-15}" bun "${RALPH_HOME}/claim-lease.ts" release "$PHASE_CLOSED_TICKET" \
    >/dev/null 2>> "$SUPERVISOR_LOG" || true
}

# The session ended at a phase boundary. Record it, pass the checkpoint, and
# resume the same session with a short prompt — or, when an operator asked for
# the finished phase again, run it in a fresh session (`phase_retry`). Sets
# `final`. Returns 1 when the iteration should settle on what it has instead —
# out of yields, or held at the checkpoint.
phase_boundary() {
  local sigil next ticket resume_prompt wrapup_prompt phase_ts phase_final phase_signals phase_errlog from checkpoint retried head branch
  sigil="$(grep -Eo "$PHASE_SIGIL" "$final" | tail -n 1)"
  next="$(printf '%s' "$sigil" | sed -E 's/<ralph>PHASE ([a-z]+).*/\1/')"
  ticket="$(printf '%s' "$sigil" | sed -nE 's/.* #?([0-9]+)<\/ralph>$/\1/p')"
  [ -n "$ticket" ] || ticket="$(claimed_issue)"
  [[ "$ticket" =~ ^[1-9][0-9]*$ ]] || ticket=""
  from="$ITERATION_PHASE"
  # The wrap-up turn for a closed ticket answered with another boundary: it
  # gets no second turn. Checked before the yield bound so the line said is
  # this one, never "the next iteration resumes it" — nothing resumes a
  # closed ticket.
  if [ -n "$PHASE_CLOSED_WRAPUP" ]; then
    # The closed ticket's ledger, whatever the new sigil names: a wrap-up that
    # strays to another number must not leave #<closed>'s ledger behind.
    bun "${RALPH_HOME}/phase.ts" clear --ticket "$PHASE_CLOSED_TICKET" >/dev/null 2>> "$SUPERVISOR_LOG" || true
    say "${LOOP_DISPLAY}: iteration ${i} wrap-up for closed #${PHASE_CLOSED_TICKET} ended at another phase boundary (${from} → ${next}) — ending the iteration; the closed ticket is not resumed."
    return 1
  fi
  # After the guard above: a stray number in a wrap-up's sigil must not
  # credit the iteration's bookkeeping to another ticket.
  [ -n "$ticket" ] && ITERATION_TICKET="$ticket"
  PHASE_YIELDS=$((PHASE_YIELDS + 1))
  if [ "$PHASE_YIELDS" -gt "$RALPH_PHASE_YIELDS" ]; then
    say "${LOOP_DISPLAY}: iteration ${i} reached phase boundary ${PHASE_YIELDS} (${from} → ${next}), past its ${RALPH_PHASE_YIELDS} — the next iteration resumes it."
    return 1
  fi

  # Closed from outside the loops mid-iteration (#809): every remaining phase
  # would spend tokens on a ticket already done. Resume ONCE with a wrap-up
  # that tidies the branch and ends DONE, rather than returning bare and
  # leaving a branch with no claim behind it, which the next session reads as
  # unexplained and sends to NEEDS_TRIAGE. Before the ledger line, so a dropped
  # ticket records no phase it never entered. `select → finish` is the
  # shepherd and post-merge cleanup path, which legitimately runs on a closed
  # ticket, so it is never probed. Nor is a role whose phase number is not a
  # tracker ticket (the pr-medic's is a pull request's): reading it as one
  # would wrap up live work over an unrelated ticket's state.
  if [ "${RALPH_ROLE_PHASE_TICKET_PROBE:-0}" = 1 ] && [ -n "$ticket" ] &&
     ! { [ "$from" = select ] && [ "$next" = finish ]; } && ticket_closed "$ticket"; then
    PHASE_CLOSED_WRAPUP=1
    PHASE_CLOSED_TICKET="$ticket"
    say "${LOOP_DISPLAY}: iteration ${i} phase ${from} → ${next} on #${ticket} — #${ticket} was closed outside the loop; resuming session ${RALPH_SESSION_ID} once to wrap up."
    record --event ticket-closed --stage iteration --iteration "$i" --max "$MAX" --phase "$from" \
      --detail "#${ticket} closed outside the loop at ${from} → ${next}; wrapping up session ${RALPH_SESSION_ID}"
    # Literal `$RALPH_HOME`, `$RALPH_LOOP_NAME` and `$RALPH_BASE_BRANCH`: the
    # session's shell has them, and the prompt reads the same in every loop.
    wrapup_prompt="#${ticket} was closed outside this loop while you worked on it. Do not open or push a PR. Commit any uncommitted work on your branch without pushing it. In its own step, write a comment to a file under \`.ralph/logs/\`; the comment names your unpushed branch and says briefly how it compares with whatever closed the ticket. Then post it with \`bun \"\$RALPH_HOME/tracker.ts\" comment ${ticket} --body-file <file>\`. Remove your claim with \`bun \"\$RALPH_HOME/tracker.ts\" label remove ${ticket} \$RALPH_LOOP_NAME-wip\`. Run \`git switch --detach \"origin/\$RALPH_BASE_BRANCH\"\`. Write your journal entry. End with <ralph>DONE</ralph>."
    phase_ts="$(date +%Y%m%dT%H%M%S)"
    phase_final=".ralph/logs/iter-${phase_ts}-$$-closed${PHASE_YIELDS}.final.txt"
    phase_signals=".ralph/logs/signals-orchestrator-${phase_ts}-$$-closed${PHASE_YIELDS}.jsonl"
    phase_errlog=".ralph/logs/iter-${phase_ts}-$$-closed${PHASE_YIELDS}.err"
    orchestrator_turn "$wrapup_prompt" "$phase_final" "$phase_signals" "$phase_errlog" \
      "$RALPH_ITERATION_TOKEN_CAP" "" --resume "$RALPH_SESSION_ID"
    [ -s "$phase_errlog" ] && say "${LOOP_DISPLAY}: iteration ${i} closed-ticket wrap-up stderr: ${phase_errlog}"
    observe_orchestrator --exit "$ITER_STATUS" --log "$log" --errors "$phase_errlog" --signals "$phase_signals"
    final="$phase_final"
    recover_missing_sigil
    return 0
  fi

  # The ledger and the resume prompt come from `phase.ts`; if it cannot run,
  # the session still resumes on the plain prompt below, and only the ledger
  # line is lost. The line carries the branch and head the phase finished on,
  # which is what a later iteration checks before resuming from it.
  retried=""
  [ -n "$PHASE_RETRY" ] && [ "$PHASE_RETRY" = "$from" ] && retried=1
  PHASE_RETRY=""
  head="$(git rev-parse HEAD 2>/dev/null || true)"
  branch="$(git branch --show-current 2>/dev/null || true)"
  resume_prompt="$(bun "${RALPH_HOME}/phase.ts" boundary --from "$from" --next "$next" \
    ${ticket:+--ticket "$ticket"} --iteration "$i" ${retried:+--retry} \
    ${branch:+--branch "$branch"} ${head:+--head "$head"} 2>> "$SUPERVISOR_LOG")" || resume_prompt=""
  [ -n "$resume_prompt" ] ||
    resume_prompt="Phase boundary recorded: ${from} → ${next}. The supervisor resumed this same session. Continue with the ${next} phase, and at its end write its handoff note and end with the next <ralph>PHASE <next> <n></ralph>, or with one of the endings in §6 per the HARD RAIL."
  ITERATION_PHASE="$next"
  say "${LOOP_DISPLAY}: iteration ${i} phase ${from} → ${next}${ticket:+ on #${ticket}} — resuming session ${RALPH_SESSION_ID}."
  record --event phase --stage iteration --iteration "$i" --max "$MAX" --phase "$next" \
    --detail "${from} → ${next}${ticket:+ on #${ticket}}; session ${RALPH_SESSION_ID}"

  checkpoint=0
  CONTROL_RETRY_PHASE=""
  phase_checkpoint "$from" "$next" "$ticket" || checkpoint=$?
  # A retry that cannot start resumes the old session into <next>, as a
  # release would have.
  if [ "$checkpoint" -eq 2 ]; then
    phase_retry "$CONTROL_RETRY_PHASE" "$next" "$ticket" && return 0
    checkpoint=0
  fi
  if [ "$checkpoint" -ne 0 ]; then
    if [ -n "$CONTROL_STOP_PHASE" ]; then
      say "${LOOP_DISPLAY}: iteration ${i} stopped before ${next}${ticket:+ on #${ticket}} — the claim is kept for the next run."
    else
      say "${LOOP_DISPLAY}: iteration ${i} held at the ${next} boundary — the next iteration resumes it."
    fi
    return 1
  fi

  phase_ts="$(date +%Y%m%dT%H%M%S)"
  phase_final=".ralph/logs/iter-${phase_ts}-$$-phase${PHASE_YIELDS}.final.txt"
  phase_signals=".ralph/logs/signals-orchestrator-${phase_ts}-$$-phase${PHASE_YIELDS}.jsonl"
  phase_errlog=".ralph/logs/iter-${phase_ts}-$$-phase${PHASE_YIELDS}.err"
  orchestrator_turn "$resume_prompt" "$phase_final" "$phase_signals" "$phase_errlog" \
    "$RALPH_ITERATION_TOKEN_CAP" "" --resume "$RALPH_SESSION_ID"
  [ -s "$phase_errlog" ] && say "${LOOP_DISPLAY}: iteration ${i} ${next} phase stderr: ${phase_errlog}"
  observe_orchestrator --exit "$ITER_STATUS" --log "$log" --errors "$phase_errlog" --signals "$phase_signals"
  final="$phase_final"
  recover_missing_sigil
  return 0
}

# The token cap stopped this iteration: a short session with its own cap
# leaves the ticket where the next attempt can pick it up. Sets `final`.
#
# Its prompt (`ship-prompt.ts budget`) is the coder's for every role but the
# pr-medic, whose branch is the operator's: `--role` gives it a handoff that
# pushes nothing and drafts nothing. For a triager the coder's text still talks
# about pushing commits and drafting a PR, which it can neither do nor be
# allowed to. Harmless — it ends DONE, the one sigil every role has.
budget_handoff() {
  local used limit issue strike strikes_file handoff_prompt phase_ts
  used="$(grep -o '"used":[0-9]*' "$budget_marker" | head -n 1 | cut -d: -f2)"
  limit="$(grep -o '"limit":[0-9]*' "$budget_marker" | head -n 1 | cut -d: -f2)"
  say "${LOOP_DISPLAY}: iteration ${i} passed its token cap (${used:-?} of ${limit:-?} tokens) and was stopped."
  record --event budget-stop --stage iteration --iteration "$i" --max "$MAX" \
    --detail "${used:-?} tokens of ${limit:-?}; see ${log}"
  close_session_usage "iteration ${i} stopped at the token cap"

  # Strikes are counted per ticket, here rather than by the model, so the
  # second stop on the same ticket is the blocked exit whatever the handoff
  # session makes of its comments.
  issue="$(claimed_issue)"
  strike=1
  strikes_file=".ralph/logs/budget-strikes.tsv"
  if [[ "$issue" =~ ^[0-9]+$ ]]; then
    strike=$(( $(awk -F '\t' -v n="$issue" '$1 == n' "$strikes_file" 2>/dev/null | wc -l) + 1 ))
    printf '%s\t%s\t%s\n' "$issue" "$RALPH_RUN_ID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$strikes_file"
  else
    issue=""
  fi
  if ! handoff_prompt="$(printf '%s' "$ITERATION_ROLE_PROMPT" | bun "${RALPH_HOME}/ship-prompt.ts" budget \
         --used "${used:-0}" --limit "${limit:-0}" --strike "$strike" --strikes "$RALPH_BUDGET_STRIKES" \
         ${issue:+--issue "$issue"} --handoff ".ralph/logs/handoff-pr-*.md or .ralph/logs/phase-*.md (the newest, if any)" \
         --iteration "$i" --role "$RALPH_LOOP_ROLE")"; then
    say "${LOOP_DISPLAY}: could not build the handoff prompt; the claim stays for the next iteration."
    return 0
  fi

  next_session
  phase_ts="$(date +%Y%m%dT%H%M%S)"
  final=".ralph/logs/iter-${phase_ts}-$$-handoff.final.txt"
  say "=== ${LOOP_DISPLAY} iteration ${i}: handoff session ${RALPH_SESSION_ID} (strike ${strike} of ${RALPH_BUDGET_STRIKES}${issue:+ on #${issue}}) ==="
  orchestrator_turn "$handoff_prompt" "$final" ".ralph/logs/signals-orchestrator-${phase_ts}-$$-handoff.jsonl" \
    ".ralph/logs/iter-${phase_ts}-$$-handoff.err" "$RALPH_HANDOFF_TOKEN_CAP" --only-session \
    --session-id "$RALPH_SESSION_ID"
  observe_orchestrator --exit "$ITER_STATUS" --log "$log" \
    --errors ".ralph/logs/iter-${phase_ts}-$$-handoff.err" \
    --signals ".ralph/logs/signals-orchestrator-${phase_ts}-$$-handoff.jsonl"
}

# The session ended `<ralph>AWAIT_HOST <n></ralph>`: wait, with no model, for
# `host-lease.ts` to grant or refuse a quiet host, then resume THIS session with
# the answer, and release the lease when that turn ends — whatever it ended with.
# Once per iteration: a second request is refused without asking the store.
# Returns 1 only when it could not resume the session at all.
await_host() {
  local sigil ticket claimed result outcome host_prompt host_ts host_final host_signals host_errlog waited_from
  sigil="$(grep -Eo "$HOST_SIGIL" "$final" | tail -n 1)"
  ticket="$(printf '%s' "$sigil" | sed -E 's/.*AWAIT_HOST #?([0-9]+).*/\1/')"
  HOST_REQUESTS=$((HOST_REQUESTS + 1))
  # A session that keeps asking after its refusal is not resumed a third time.
  if [ "$HOST_REQUESTS" -gt 2 ]; then
    say "${LOOP_DISPLAY}: iteration ${i} asked for the host again after its refusal — the next iteration resumes it."
    return 1
  fi
  claimed="${ITERATION_TICKET:-$(claimed_issue)}"
  result=".ralph/logs/host-lease-${ts}-$$-${i}-${HOST_REQUESTS}.json"
  if [ "$HOST_REQUESTS" -gt 1 ]; then
    printf '{"outcome":"refused","ticket":%s,"command":null,"expiresAt":null,"detail":"this iteration already asked for the host once"}\n' "$ticket" > "$result"
  else
    say "${LOOP_DISPLAY}: iteration ${i} asks for a quiet host for #${ticket} — no model turn while it waits."
    record --event host-lease-wait --stage iteration --iteration "$i" --max "$MAX" ${ITERATION_PHASE:+--phase "$ITERATION_PHASE"} \
      --detail "#${ticket}: waiting for a quiet host"
    waited_from=$SECONDS
    bun "${RALPH_HOME}/host-lease.ts" acquire --ticket "$ticket" ${claimed:+--claimed "$claimed"} \
      --request .ralph/logs/host-lease-request.json > "$result" 2>> "$SUPERVISOR_LOG"
    ITERATION_WAITED=$((ITERATION_WAITED + SECONDS - waited_from))
    grep -q '"outcome"' "$result" 2>/dev/null ||
      printf '{"outcome":"unreadable","ticket":%s,"command":null,"expiresAt":null,"detail":"the wait produced no result"}\n' "$ticket" > "$result"
  fi
  outcome="$(grep -o '"outcome":"[a-z-]*"' "$result" | head -n 1 | cut -d'"' -f4)"
  say "${LOOP_DISPLAY}: host lease for #${ticket}: ${outcome}."
  record --event host-lease --stage iteration --iteration "$i" --max "$MAX" ${ITERATION_PHASE:+--phase "$ITERATION_PHASE"} \
    --detail "#${ticket}: ${outcome}"
  host_prompt="$(bun "${RALPH_HOME}/host-lease.ts" prompt --result "$result" 2>> "$SUPERVISOR_LOG")" ||
    host_prompt="Host lease for #${ticket}: ${outcome}. Do not run the fenced command unless it was granted; do not end with AWAIT_HOST again this iteration. End with one of the endings in §6, per the HARD RAIL."

  host_ts="$(date +%Y%m%dT%H%M%S)"
  host_final=".ralph/logs/iter-${host_ts}-$$-host${HOST_REQUESTS}.final.txt"
  host_signals=".ralph/logs/signals-orchestrator-${host_ts}-$$-host${HOST_REQUESTS}.jsonl"
  host_errlog=".ralph/logs/iter-${host_ts}-$$-host${HOST_REQUESTS}.err"
  orchestrator_turn "$host_prompt" "$host_final" "$host_signals" "$host_errlog" \
    "$RALPH_ITERATION_TOKEN_CAP" "" --resume "$RALPH_SESSION_ID"
  bun "${RALPH_HOME}/host-lease.ts" release 2>> "$SUPERVISOR_LOG" || true
  [ -s "$host_errlog" ] && say "${LOOP_DISPLAY}: iteration ${i} host-lease session stderr: ${host_errlog}"
  observe_orchestrator --exit "$ITER_STATUS" --log "$log" --errors "$host_errlog" --signals "$host_signals"
  final="$host_final"
  recover_missing_sigil
  return 0
}

# The session asked the supervisor to wait on its PR. Wait, then start the
# fresh session that picks the outcome up. Sets `final`. Returns 1 when there
# is nothing more to run and the iteration should settle on what it has.
await_pr() {
  local sigil pr mode result outcome head_sha extensions ship_prompt phase_ts phase_final phase_signals phase_errlog handoff waited_from
  local refusal refusal_rc
  sigil="$(grep -Eo "$AWAIT_SIGIL" "$final" | tail -n 1)"
  pr="$(printf '%s' "$sigil" | sed -E 's/.*AWAIT_PR ([0-9]+).*/\1/')"
  mode="$(printf '%s' "$sigil" | sed -nE 's/.*AWAIT_PR [0-9]+ (ci|merge).*/\1/p')"
  mode="${mode:-ci}"

  # #807: a number that is no PR at all (the issue number, typically) would
  # be waited on for nothing. Exit 3 is the only refusal; every other exit, a
  # timeout included, is a check that could not judge and leaves the wait as
  # it was. Once the refusals are spent the check is not asked at all: its
  # answer could change nothing.
  refusal_rc=0
  refusal=""
  if [ "$AWAIT_PR_REFUSED" -lt "$RALPH_AWAIT_PR_REFUSALS" ]; then
    refusal="$(timeout 60 bun "${RALPH_HOME}/await-pr-check.ts" "$pr" --mode "$mode" 2>> "$SUPERVISOR_LOG")" || refusal_rc=$?
  fi
  if [ "$refusal_rc" -eq 3 ] && [ -n "$refusal" ]; then
    AWAIT_PR_REFUSED=$((AWAIT_PR_REFUSED + 1))
    say "${LOOP_DISPLAY}: iteration ${i} asked to wait on PR #${pr}, which is no pull request — refused (${AWAIT_PR_REFUSED}/${RALPH_AWAIT_PR_REFUSALS}); resuming session ${RALPH_SESSION_ID}: ${refusal}"
    record --event pr-sigil-refused --stage iteration --iteration "$i" --max "$MAX" ${ITERATION_PHASE:+--phase "$ITERATION_PHASE"} \
      --detail "PR #${pr} ${mode}, refusal ${AWAIT_PR_REFUSED}; session ${RALPH_SESSION_ID}"
    phase_ts="$(date +%Y%m%dT%H%M%S)"
    phase_final=".ralph/logs/iter-${phase_ts}-$$-prsigil${AWAIT_PR_REFUSED}.final.txt"
    phase_signals=".ralph/logs/signals-orchestrator-${phase_ts}-$$-prsigil${AWAIT_PR_REFUSED}.jsonl"
    phase_errlog=".ralph/logs/iter-${phase_ts}-$$-prsigil${AWAIT_PR_REFUSED}.err"
    orchestrator_turn "$refusal" "$phase_final" "$phase_signals" "$phase_errlog" \
      "$RALPH_ITERATION_TOKEN_CAP" "" --resume "$RALPH_SESSION_ID"
    [ -s "$phase_errlog" ] && say "${LOOP_DISPLAY}: iteration ${i} refused-sigil session stderr: ${phase_errlog}"
    observe_orchestrator --exit "$ITER_STATUS" --log "$log" --errors "$phase_errlog" --signals "$phase_signals"
    final="$phase_final"
    recover_missing_sigil
    return 0
  fi

  PR_WAIT_ROUND=$((PR_WAIT_ROUND + 1))
  if [ "$PR_WAIT_ROUND" -gt $((RALPH_PR_WAIT_ROUNDS + 1)) ]; then
    say "${LOOP_DISPLAY}: iteration ${i} asked to wait on PR #${pr} again after its last round — the next iteration resumes it."
    return 1
  fi
  close_session_usage "iteration ${i} awaiting PR #${pr}"

  result=".ralph/logs/pr-wait-${ts}-$$-${i}-${PR_WAIT_ROUND}.json"
  if [ "$PR_WAIT_ROUND" -gt "$RALPH_PR_WAIT_ROUNDS" ]; then
    printf '{"outcome":"rounds-exhausted","mode":"%s","pr":"%s","detail":"%s waits this iteration"}\n' \
      "$mode" "$pr" "$RALPH_PR_WAIT_ROUNDS" > "$result"
  else
    say "${LOOP_DISPLAY}: iteration ${i} waits on PR #${pr} (${mode}, round ${PR_WAIT_ROUND}/${RALPH_PR_WAIT_ROUNDS}) — no model turn while it does."
    # Only a pushed PR is waited on, and pushing it is the finish phase — so
    # the record says so even when the session skipped the boundary sigil.
    ITERATION_PHASE=finish
    record --event pr-wait --stage iteration --iteration "$i" --max "$MAX" --phase finish \
      --detail "PR #${pr} ${mode}, round ${PR_WAIT_ROUND}"
    head_sha=""
    [ "$mode" = "ci" ] && head_sha="$(git rev-parse HEAD 2>/dev/null || true)"
    extensions=0
    while :; do
      waited_from=$SECONDS
      bun "${RALPH_HOME}/pr-wait.ts" "$pr" --mode "$mode" ${head_sha:+--head "$head_sha"} \
        "${RALPH_PR_WAIT_FLAGS[@]}" > "$result" 2>> "$SUPERVISOR_LOG"
      ITERATION_WAITED=$((ITERATION_WAITED + SECONDS - waited_from))
      grep -q '"outcome"' "$result" 2>/dev/null ||
        printf '{"outcome":"unreadable","mode":"%s","pr":"%s","detail":"the wait produced no result"}\n' "$mode" "$pr" > "$result"
      outcome="$(grep -o '"outcome":"[a-z-]*"' "$result" | head -n 1 | cut -d'"' -f4)"
      # CI only: a queue timeout (3600 s) extended twice would leave a stuck
      # queue, a stale `-conflict` say, unattended for three hours.
      [ "$outcome" = "timeout" ] && ! grep -q '"mode":"merge"' "$result" &&
        [ "$extensions" -lt "$RALPH_PR_WAIT_EXTENSIONS" ] || break
      extensions=$((extensions + 1))
      # Kept in the history, so the session that does start sees how long it
      # has been; and kept as a result file of its own (same iteration, a
      # distinct round suffix) because the dashboard's CI-wait medians sum
      # those files per iteration and would otherwise see only the last wait.
      cat "$result" >> "$wait_history"
      cp "$result" "${result%.json}0${extensions}.json"
      say "${LOOP_DISPLAY}: PR #${pr} still has nothing failed or settled; waiting again (${extensions}/${RALPH_PR_WAIT_EXTENSIONS}) — no session for that."
      record --event pr-wait --stage iteration --iteration "$i" --max "$MAX" --phase finish \
        --detail "PR #${pr} ${mode}, round ${PR_WAIT_ROUND}, extension ${extensions}"
    done
  fi
  outcome="$(grep -o '"outcome":"[a-z-]*"' "$result" | head -n 1 | cut -d'"' -f4)"
  say "${LOOP_DISPLAY}: PR #${pr} wait ended: ${outcome}."

  handoff=".ralph/logs/handoff-pr-${pr}.md"
  if ! ship_prompt="$(printf '%s' "$RALPH_PROMPT" | bun "${RALPH_HOME}/ship-prompt.ts" ship \
         --wait "$result" --history "$wait_history" --round "$PR_WAIT_ROUND" \
         --max-rounds "$RALPH_PR_WAIT_ROUNDS" --handoff "$handoff" --iteration "$i" \
         --role "$RALPH_LOOP_ROLE")"; then
    say "${LOOP_DISPLAY}: could not build the prompt to continue PR #${pr}; the next iteration resumes it."
    return 1
  fi
  cat "$result" >> "$wait_history"

  next_session
  phase_ts="$(date +%Y%m%dT%H%M%S)"
  phase_final=".ralph/logs/iter-${phase_ts}-$$-pr${PR_WAIT_ROUND}.final.txt"
  phase_signals=".ralph/logs/signals-orchestrator-${phase_ts}-$$-pr${PR_WAIT_ROUND}.jsonl"
  phase_errlog=".ralph/logs/iter-${phase_ts}-$$-pr${PR_WAIT_ROUND}.err"
  say "=== ${LOOP_DISPLAY} iteration ${i}: fresh session ${RALPH_SESSION_ID} for PR #${pr} (${outcome}) ==="
  record --event pr-session --stage iteration --iteration "$i" --max "$MAX" \
    --detail "PR #${pr} ${outcome}; session ${RALPH_SESSION_ID}"
  orchestrator_turn "$ship_prompt" "$phase_final" "$phase_signals" "$phase_errlog" \
    "$RALPH_ITERATION_TOKEN_CAP" "" --session-id "$RALPH_SESSION_ID"
  [ -s "$phase_errlog" ] && say "${LOOP_DISPLAY}: iteration ${i} PR session stderr: ${phase_errlog}"
  observe_orchestrator --exit "$ITER_STATUS" --log "$log" --errors "$phase_errlog" --signals "$phase_signals"
  final="$phase_final"
  recover_missing_sigil
  return 0
}

# How many iterations in a row have come back with nothing to do. Reset by any
# iteration that works, so it counts a STREAK rather than a total.
#
# It exists because the gate and the iteration can disagree stably, not just
# race. A frontier ticket is self-limiting — the gate sees it, the iteration
# claims it, and the answer changes. A closable spec is not: if the iteration
# declines to close it, nothing changes, and a gated supervisor would re-ask,
# get the same answer, and spend one Opus turn per interval forever. Two rounds
# of that is enough to know it is not a race.
#
# A role that holds at the gate (RALPH_ROLE_GATE_HOLDS, #771) does not count
# its first refusal: it writes the refuted verdict to the record in
# `gate-verdict-store.ts`, and its gate holds on that unchanged verdict —
# escalating once past RALPH_GATE_HOLD_BUDGET_HOURS (default 48) — instead of
# spawning on it again. The streak and its halt remain for every role that
# does not hold, and as the fallback when the record cannot be written or the
# hold did not take (the gate offered the held verdict anyway).
BLOCKED_STREAK=0
BLOCKED_STREAK_LIMIT=2

# The frontier ticket the gate named for this iteration, or empty when it
# spawned for anything else (a PR to shepherd, a claim to resume, a spec to
# close). Set after every gate answer.
GATE_TICKET=""
# Whether the gate already claimed GATE_TICKET for this loop (`--claim`, #5):
# its work line then ends `claim held by this loop`. Set after every gate answer.
GATE_CLAIMED=""

# The one disagreement that IS a race: the gate names ticket T from a dry run,
# another loop claims T before this iteration's real take-one, and the
# iteration comes back empty. That says nothing about the gate being wrong, and
# counting it halted remo, rulo and rafa on 2026-09-26/27 (#1397, #1407).
# Since #5 the coder's gate claims T itself when it reports it, so a session
# that started holding its ticket cannot have lost it: its empty iteration is a
# genuine disagreement and counts, without asking. The check now covers only
# the one path that can still lose a race — the gate's unreadable-probe
# fallback, where it probed read-only and the session claims — and any role
# whose gate does not claim.
# `claim-race.ts` asks whether T is now held by another loop, using the
# frontier's own claim fence, and the answer is logged either way. Succeeds
# when it was a lost race — and when GitHub could not be read, because a
# disagreement that cannot be verified must not count towards a halt either.
# Fails when nothing explains the empty iteration, or when there is no ticket
# to ask about. Leaves what to say in RACE_LINE.
lost_claim_race() {
  RACE_LINE=""
  [ -n "$GATE_TICKET" ] || return 1
  [ -z "$GATE_CLAIMED" ] || return 1
  local line status
  line="$(bun "${RALPH_HOME}/claim-race.ts" "$GATE_TICKET" 2>> "$SUPERVISOR_LOG")"
  status=$?
  case "$status" in
    0) RACE_LINE="${line} — back to the gate; not counted as a disagreement"; return 0 ;;
    3) RACE_LINE="${line} — not counted as a disagreement"; return 0 ;;
    1) say "${LOOP_DISPLAY}: ${line}." ;;
    # A check that could not run at all is a harness fault, not a GitHub read:
    # count it, as the supervisor did before the check existed.
    *) say "${LOOP_DISPLAY}: the claim-race check for #${GATE_TICKET} failed (exit ${status}); counting the disagreement." ;;
  esac
  return 1
}

# The record of the verdict a holding role's gate holds on (#771). Its stderr
# goes to the supervisor log; callers decide what its stdout and exit mean.
gate_verdict() {
  bun "${RALPH_HOME}/gate-verdict-store.ts" "$@" 2>> "$SUPERVISOR_LOG"
}

# Both stop sigils face the same fork, so the mode switch lives here once
# rather than beside each of them. Two whole messages rather than a stem and a
# suffix: the ungated wording is the wording this script has always printed,
# and reassembling it from parts is how that drifts. Exit status is the
# caller's instruction — 0 keep looping, 1 stop.
# $3 is how the record should read this stop — `completed` for a drained
# backlog, `blocked` for work that exists and cannot be taken. The distinction
# is the operator's next action, so it cannot be derived from the message.
wait_or_stop() {
  if [ -z "$RALPH_WAIT_FOR_WORK" ]; then
    say "${LOOP_DISPLAY}: $1"
    record --event stop --stop "$3" --why "$1"
    return 1
  fi
  # Checked before the streak moves: a lost race leaves it where it was, so
  # neither halts the loop nor excuses the disagreement before it.
  if lost_claim_race; then
    say "${LOOP_DISPLAY}: ${RACE_LINE}."
    record --event blocked-wait --stage gate --detail "$RACE_LINE"
    control_sleep "$RALPH_WAIT_FOR_WORK" || true
    return 0
  fi
  # A holding role records the verdict it just refuted, and its gate holds on
  # it rather than spawning on it again (#771). Only a fresh hold, or the first
  # re-hold of a verdict that came back after a release (on its original
  # clock), skips the streak: every other outcome is today's disagreement,
  # counted — so a ticket that flaps in and out of the frontier costs a
  # bounded number of sessions and then stops for a human.
  if [ "${RALPH_ROLE_GATE_HOLDS:-0}" = 1 ] && [ -n "$INTAKE_CASE" ]; then
    local hold_status
    gate_verdict write --case "$INTAKE_CASE" >/dev/null
    hold_status=$?
    case "$hold_status" in
      0)
        say "${LOOP_DISPLAY}: $2 — holding at the gate until its verdict changes (${INTAKE_CASE})."
        # `gate-hold`, not `blocked-wait`: a hold inside its budget is a
        # normal wait, and the panel reads it as `idle`.
        record --event gate-hold --stage gate --detail "holding on: ${INTAKE_CASE}"
        control_sleep "$RALPH_WAIT_FOR_WORK" || true
        return 0
        ;;
      3)
        say "${LOOP_DISPLAY}: the gate offered the verdict it was holding on again (${INTAKE_CASE}); the disagreement counts."
        ;;
      # No holdable subject (a PR to shepherd, an own claim, a recovery): the
      # disagreement is today's, silently.
      2) ;;
      *)
        say "${LOOP_DISPLAY}: the gate verdict record could not be written (exit ${hold_status}); the disagreement counts."
        ;;
    esac
  fi
  BLOCKED_STREAK=$((BLOCKED_STREAK + 1))
  if [ "$BLOCKED_STREAK" -ge "$BLOCKED_STREAK_LIMIT" ]; then
    say "${LOOP_DISPLAY}: $BLOCKED_STREAK iterations in a row found nothing while the gate said there was work."
    say "       The gate and the iteration disagree persistently; needs human triage."
    record --event gate-disagreement --stop blocked \
      --why "the gate and the iteration disagreed ${BLOCKED_STREAK} times running; needs human triage"
    return 1
  fi
  say "${LOOP_DISPLAY}: $2"
  # `blocked-wait` rather than a plain heartbeat: a supervisor parked here is
  # alive and has nothing to do, which the panel reports as `blocked` — the
  # frontier needs a human, the loop does not.
  record --event blocked-wait --stage gate --detail "$2"
  # Cut short by a command, the caller's next step is the checkpoint anyway.
  control_sleep "$RALPH_WAIT_FOR_WORK" || true
  return 0
}

say "${LOOP_DISPLAY} run ${RALPH_RUN_ID} — usage ledger: .ralph/logs/usage-ledger.tsv"
# First write of the run: it replaces the previous run's record, so a panel
# reading a restarted worktree describes this supervisor rather than the last
# one's ending.
record --event supervisor-start --stage starting
# Promote pending learnings before the intake gate waits on an empty backlog.
# A GitHub outage must not hold startup or prevent the loop taking other work.
if [ -f "${RALPH_HOME}/findings.ts" ]; then
  timeout --kill-after=5s 60s bun "${RALPH_HOME}/findings.ts" reconcile >>"$SUPERVISOR_LOG" 2>&1 \
    || say "${LOOP_DISPLAY}: pending finding promotion deferred; see the supervisor log."
fi
# A restart is an operator saying "try now": whatever the last run was backing
# off from, this one checks it at once rather than inheriting the wait — and
# a blocker a killed iteration left behind is not this run's to report. The
# same goes for a park hand-off (#776) a session wrote and then died before
# `tracker.ts blocked` read it: it must not park the next block of that ticket.
rm -f .ralph/logs/backoff.json .ralph/logs/retry-blocker.json .ralph/logs/backoff-exhausted.json .ralph/logs/block-park.json
LEASE_HEARTBEAT_SECONDS="${RALPH_LEASE_HEARTBEAT_SECONDS:-30}"
if [[ ! "$LEASE_HEARTBEAT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "${LOOP_DISPLAY}: RALPH_LEASE_HEARTBEAT_SECONDS must be a positive integer; got '${LEASE_HEARTBEAT_SECONDS}'." >&2
  exit 1
fi
# The watcher logs what it could not do — a pulse skipped on a busy lock, a
# pulse that threw, why it stopped — to its own bounded file, and anything it
# prints on the way down (a crash) lands there too. It used to write to
# /dev/null, and when it went quiet mid-iteration (#119) nothing said why.
LEASE_HEARTBEAT_LOG=".ralph/logs/heartbeat-${RALPH_RUN_ID}.log"
RALPH_LEASE_HEARTBEAT_SECONDS="$LEASE_HEARTBEAT_SECONDS" RALPH_LEASE_HEARTBEAT_LOG="$LEASE_HEARTBEAT_LOG" \
  bun "${RALPH_HOME}/claim-lease.ts" heartbeat --watch >/dev/null 2>>"$LEASE_HEARTBEAT_LOG" &
LEASE_HEARTBEAT_PID=$!
# Said out loud, once, because a plugin's failure mode is silence: one that was
# not working at startup produces, say, a board with no loop on it, and an
# operator reading that has no way to tell "not shown" from "not running". The
# line names each enabled plugin and whether the startup event reached it.
# Every line prefixed: a plugin's own panel lines follow the health line.
while IFS= read -r plugin_line; do
  [ -n "$plugin_line" ] && say "${LOOP_DISPLAY}: ${plugin_line}"
done <<< "$(bun "${RALPH_HOME}/plugins.ts" status --line 2>/dev/null || echo 'Plugins: unavailable')"
say "${LOOP_DISPLAY}: $(bun "${RALPH_HOME}/controls.ts" status --line 2>/dev/null || echo 'Controls: unavailable')"
# Started after the first record, so a plugin has something to pulse about.
# It ends with the supervisor: the trap kills it, and it checks the
# supervisor's pid on every pulse for the kill that never runs one.
if [ -n "$RALPH_PLUGINS" ]; then
  bun "${RALPH_HOME}/plugins.ts" pulse --watch >/dev/null 2>&1 &
  PLUGIN_PULSE_PID=$!
fi
# The lineup can now differ per loop and per run, so the log has to say which
# one this was: the ledger records models per row, but only a run that already
# happened. This line is what makes a run readable while it is still going.
while IFS= read -r warning; do
  [ -n "$warning" ] && say "${LOOP_DISPLAY}: ${warning}"
done < "$RALPH_MODEL_WARNINGS_FILE"
# Built from the roster for the same reason the check above is: a sixth stage
# must not be able to go unlogged because this line never heard of it. The
# label is the variable name read backwards — RALPH_MODEL_REVIEW_SPEC becomes
# `review.spec` — so the log says what `--list` says.
RALPH_MODEL_SUMMARY=""
for stage_var in $RALPH_MODEL_STAGE_VARS; do
  stage_tail="${stage_var#RALPH_MODEL_}"
  stage_label="$(printf '%s' "$stage_tail" | tr '[:upper:]_' '[:lower:].')"
  # The one stage whose name holds a hyphen rather than a dot.
  [ "$stage_label" = code.context ] && stage_label=code-context
  runner_var="RALPH_RUNNER_${stage_tail}"
  RALPH_MODEL_SUMMARY="${RALPH_MODEL_SUMMARY}${RALPH_MODEL_SUMMARY:+, }${stage_label} ${!stage_var} on ${!runner_var}"
done
say "${LOOP_DISPLAY}: models — ${RALPH_MODEL_SUMMARY}${RALPH_MODEL_ORCHESTRATOR_EFFORT:+ (orchestrator effort ${RALPH_MODEL_ORCHESTRATOR_EFFORT})}"
if [ -n "$RALPH_WAIT_FOR_WORK" ]; then
  say "${LOOP_DISPLAY}: frontier-gated — waits ${RALPH_WAIT_FOR_WORK}s between checks instead of exiting."
fi

# --- The worktree a role must leave behind -----------------------------------
# A role may declare a post-iteration invariant (`roles.ts`). `clean-detached`
# is the read-only role's: nothing uncommitted, and HEAD detached at the base
# branch. A triager reads issues and writes labels; anything it left in the
# worktree is a prompt bug, and the next loop to read this checkout would
# inherit it.
#
# Repaired rather than fatal, and in this order: the diff is saved first, so
# the restore can never be the thing that loses it; then the checkout is put
# back; then a `role-invariant` notification says a role broke its own fence,
# which is worth a human's eye even though the run continues. Stopping instead
# would leave the stray edit exactly where it does the damage.
role_invariant() {
  [ "$RALPH_ROLE_INVARIANT" = "clean-detached" ] || return 0
  local dirty head base attached why patch pushed
  dirty="$(git status --porcelain 2>/dev/null)"
  head="$(git rev-parse HEAD 2>/dev/null || true)"
  base="$(git rev-parse "$RALPH_BASE_REF" 2>/dev/null || true)"
  # `branch --show-current` rather than `symbolic-ref`: it is what every other
  # read of the checkout's branch in this script uses, and it prints nothing
  # when HEAD is detached, which is the state this invariant wants.
  attached="$(git branch --show-current 2>/dev/null || true)"
  why=""
  [ -n "$dirty" ] && why="left the worktree dirty"
  [ -n "$attached" ] && why="${why:+${why}; }left the checkout on ${attached}"
  [ -z "$attached" ] && [ -n "$base" ] && [ "$head" != "$base" ] &&
    why="${why:+${why}; }left HEAD at ${head:0:12} rather than ${RALPH_BASE_REF}"
  [ -n "$why" ] || return 0

  # The pid is in the name because the timestamp is whole seconds: two
  # violations inside one second would otherwise overwrite each other.
  patch=".ralph/logs/${RALPH_LOOP_ROLE}-violation-$(date -u +%Y%m%dT%H%M%SZ)-$$.patch"
  # `--intent-to-add` first, so a file the role CREATED is in the patch too;
  # `git diff` alone would save nothing for the commonest violation of all.
  git add -A --intent-to-add >/dev/null 2>&1 || true
  # Against the BASE REF, not HEAD: a role that wrongly committed has that work
  # in a commit, which a HEAD diff does not show at all — and the reset below
  # would then be the thing that lost it.
  git diff "$RALPH_BASE_REF" > "$patch" 2>/dev/null || true
  # DETACH FIRST. `git reset --hard` while HEAD is still attached moves the
  # BRANCH ref, so a branch the role should never have made is rewritten rather
  # than merely abandoned; detached, the reset moves only HEAD and the branch
  # stays recoverable by name.
  git switch --detach "$RALPH_BASE_REF" >/dev/null 2>&1 || true
  git reset --hard "$RALPH_BASE_REF" >/dev/null 2>&1 || true
  # Only when something was actually uncommitted: on a clean tree left on a
  # branch there is nothing to clean, and `git clean -fd` would delete untracked
  # files an operator put in the worktree. Ignored files are never touched
  # (no `-x`), which is also what keeps `.ralph/logs` — and the patch just
  # written into it — assuming the project ignores that directory.
  [ -n "$dirty" ] && { git clean -fd >/dev/null 2>&1 || true; }
  say "${LOOP_DISPLAY}: the ${RALPH_LOOP_ROLE} ${why} — saved ${patch} and restored the checkout."

  record --event role-invariant --stage iteration --iteration "$i" --max "$MAX" \
    --detail "${RALPH_LOOP_ROLE} ${why}; saved ${patch}"
  pushed="the ${RALPH_LOOP_ROLE} loop ${RALPH_LOOP_NAME} ${why}. The checkout was restored to ${RALPH_BASE_REF}; the diff is ${RALPH_PROJECT}/${patch}."
  bun "${RALPH_HOME}/push-notification.ts" push --kind role-invariant \
    --occurrence "role-invariant:${RALPH_RUN_ID}:${i}" \
    --subject "${RALPH_LOOP_NAME} broke its ${RALPH_ROLE_INVARIANT} invariant" \
    --body "$pushed" --priority high \
    ${ITERATION_TICKET:+--ticket "$ITERATION_TICKET"} >/dev/null 2>> "$SUPERVISOR_LOG" || true
}

# --- The credentials this role is given -------------------------------------
# A red Buildkite check says only "failed"; the reason is in the job log, and
# the log needs an API token. Without one an iteration re-ran its gates
# locally, got green, and parked the ticket "red twice in CI; not reproducible
# locally" — on 2026-09-27 three times, for one known flaky timeout and one
# root-suite failure the session had never run. `bk-log.ts` reads the log.
#
# That token — RALPH_BUILDKITE_READ_TOKEN, a dedicated one with only
# `read_builds` and `read_build_logs` — is the coder's one NAMED secret, and
# the shape below is now the general one: the role (`roles.ts`) declares which
# credentials the supervisor reads by name, what proves each one narrow, and
# which process gets it.
#
# It is NOT the project's BUILDKITE_API_TOKEN, which Loggd withholds from every
# child by name and which is never read here. Each declared secret is read once
# from the same explicit secrets scope and exported only after its check has
# passed — for the read token, that every scope on it is `read_*`. A credential
# that fails its check, or that has no checker yet, is not exported and is
# stripped from the children's environment too, since `doppler run` would
# otherwise inject it straight back. A missing secret or a failed check is a
# one-line warning, never a stop: the loop works without logs, it just explains
# red CI worse. No value is ever echoed; the redactors strike every declared
# name (`runner-signals.json`'s `never.except`, which `observe.test.ts` holds to
# the descriptors) as well as the `bkua_` shape. One gap to know about: a gate's
# own output goes to the supervisor log WITHOUT passing the redactor, so a gate
# must not print what it was given — the same rule every gate already follows
# for the GitHub token it reads.
#
# A `gate` secret goes to the role's intake gate ALONE (`RALPH_GATE_ENV`
# below), and is stripped from the iteration whether its check passed or not.
# That is the fence between reading CI and acting on it: the doctor's gate can
# retry a build, and no model turn — of that role or any other — is handed the
# credential that does it. A coder declares no gate secret at all, so this
# loop's `env -u` list grows for every role but the coder's own.
#
# A secret already set in the environment is taken as given (and still
# checked); `<NAME>_SECRET` renames the entry read from the scope.
RALPH_GATE_ENV=()
# Which declared secrets resolved and passed their check, and which were in the
# scope but withheld, by NAME. The preflight needs both and can read neither
# any other way: a `gate` secret's value is unset below, from this shell too,
# so `buildkite-retry` asking the environment would warn about a token that is
# present and working. Names only — nothing here carries a value, which is why
# it is safe to export into every child.
#
# WITHHELD is a third answer, not a shade of missing, and a check that collapsed
# it into "absent" would print a remedy the operator has already followed: a
# token stored but withheld (its checker has not shipped, or its check failed)
# is not fixed by storing it again.
#
# UNREAD is a fourth: Doppler failed for a reason other than "not found" — on
# 2026-10-29 the boot-time reconciler started clara before the login keyring
# was unlocked, every read failed with "failed to unlock correct collection",
# and the token was reported absent, so the preflight denied a loop whose setup
# was fine and the 09:00 KPI report never went out. An unread secret is a wait:
# the preflight answers unavailable for it, and it is read again before each
# gate poll and each iteration (`reread_role_secrets`, #759).
RALPH_ROLE_SECRETS_AVAILABLE=""
RALPH_ROLE_SECRETS_WITHHELD=""
RALPH_ROLE_SECRETS_UNREAD=""
# Removed after every read rather than by a trap: the EXIT trap is the
# supervisor's (lease heartbeat, plugin pulse), and replacing it here would
# disarm theirs. A kill mid-read leaves it among the logs, like the model
# warnings file.
RALPH_SECRET_READ_ERRORS=".ralph/logs/.secret-read-errors-$$"
resolve_role_secrets() { # <secret names...>
# Which of these are re-reads: only the filter entry a failed read put there
# is taken back out, never a project's own `secrets.withhold` of the name.
secret_rereading="$RALPH_ROLE_SECRETS_UNREAD"
RALPH_ROLE_SECRETS_UNREAD=""
for role_secret in "$@"; do
  eval "secret_source=\"\${${role_secret}_SECRET:-${role_secret}}\""
  eval "secret_value=\"\${${role_secret}:-}\""
  eval "secret_check=\"\${RALPH_ROLE_SECRET_CHECK_${role_secret}:-}\""
  case " ${RALPH_ROLE_SECRETS_GATE} " in *" ${role_secret} "*) secret_gate=1 ;; *) secret_gate=0 ;; esac
  case " ${RALPH_ROLE_SECRETS_ITERATION} " in *" ${role_secret} "*) secret_iteration=1 ;; *) secret_iteration=0 ;; esac
  secret_unread=""
  if [ -z "$secret_value" ]; then
    # Through the one secret-source seam (#759), for every runner: Doppler,
    # or the environment for `none`, so a future manager is one more source
    # there rather than one more branch here. The value comes back on stdout
    # and stays in this variable — never an argument `ps` would show, never a
    # log line. The why goes to a file, not the value: Doppler can print an
    # update notice to stderr even on success.
    secret_status=0
    secret_value="$(RALPH_NAMED_SECRETS_RUNNER="$RALPH_NAMED_SECRETS_RUNNER" \
      timeout 60 bun --no-env-file "${RALPH_HOME}/secrets/read.ts" "$secret_source" 2>"$RALPH_SECRET_READ_ERRORS")" || secret_status=$?
    case "$secret_status" in
      0) ;;
      3) secret_value="" ;;
      4)
        secret_value=""
        secret_unread="$(tr '\n' ' ' < "$RALPH_SECRET_READ_ERRORS" 2>/dev/null | cut -c1-200)"
        [ -n "${secret_unread// /}" ] || secret_unread="the read failed without saying why"
        ;;
      *)
        # The reader itself did not answer — bun could not start, the read
        # timed out, a signal: no evidence the secret is not stored, so it is
        # a wait, never an "absent" that would stop it being read again.
        secret_value=""
        if [ "$secret_status" = 124 ]; then
          secret_unread="the read timed out"
        else
          secret_unread="the reader exited with status ${secret_status}"
        fi
        ;;
    esac
    rm -f "$RALPH_SECRET_READ_ERRORS"
  fi
  secret_ok=0
  if [ -n "$secret_unread" ]; then
    # On every failed read (#759): the re-read is rate-limited to once per
    # poll interval, so this is too, and a read that fails again says so
    # rather than going quiet.
    secret_from=" from the secrets manager"
    [ "$RALPH_NAMED_SECRETS_RUNNER" = "doppler" ] && secret_from=" from Doppler"
    [ "$RALPH_NAMED_SECRETS_RUNNER" = "dotenv" ] && secret_from=" from ${RALPH_SECRETS_FILE}"
    [ "$RALPH_NAMED_SECRETS_RUNNER" = "none" ] && secret_from=""
    say "${LOOP_DISPLAY}: warning — ${role_secret} could not be read${secret_from} (${secret_unread% }); it is read again before the next gate poll or iteration."
    RALPH_ROLE_SECRETS_UNREAD="${RALPH_ROLE_SECRETS_UNREAD:+${RALPH_ROLE_SECRETS_UNREAD} }${role_secret}"
  elif [ -z "$secret_value" ]; then
    say "${LOOP_DISPLAY}: warning — no ${role_secret} (${secret_source} is not in the secrets scope); the ${RALPH_LOOP_ROLE} works without it."
  elif [ -z "$secret_check" ]; then
    # Declared with no checker yet: withheld exactly as a failed check's value
    # is. An unproved credential that can write is the one this matters for.
    say "${LOOP_DISPLAY}: warning — ${role_secret} has no check command yet, so it is withheld."
  else
    # The check command is a path under $RALPH_HOME and its flags; split into
    # an argv rather than interpolated, and the value is exported INSIDE the
    # subshell rather than passed as an `env NAME=value` argument, which `ps`
    # would show to every user on the host.
    read -r -a secret_check_argv <<< "$secret_check"
    secret_check_argv[0]="${RALPH_HOME}/${secret_check_argv[0]}"
    if secret_said="$(export "${role_secret}=${secret_value}"; timeout 60 bun "${secret_check_argv[@]}" 2>&1)"; then
      secret_ok=1
      secret_targets=""
      [ "$secret_iteration" = 1 ] && secret_targets="the iteration"
      [ "$secret_gate" = 1 ] && secret_targets="${secret_targets:+${secret_targets} and }the intake gate"
      say "${LOOP_DISPLAY}: ${secret_said#*: } — ${role_secret} is available to ${secret_targets}."
    else
      say "${LOOP_DISPLAY}: warning — ${role_secret} withheld: ${secret_said#*: }"
    fi
  fi
  # The gate's copy lives here and nowhere else, so nothing but the gate
  # invocation can pass it on.
  [ "$secret_ok" = 1 ] && [ "$secret_gate" = 1 ] && RALPH_GATE_ENV+=("${role_secret}=${secret_value}")
  if [ "$secret_ok" = 1 ]; then
    RALPH_ROLE_SECRETS_AVAILABLE="${RALPH_ROLE_SECRETS_AVAILABLE:+${RALPH_ROLE_SECRETS_AVAILABLE} }${role_secret}"
  elif [ -n "$secret_value" ]; then
    RALPH_ROLE_SECRETS_WITHHELD="${RALPH_ROLE_SECRETS_WITHHELD:+${RALPH_ROLE_SECRETS_WITHHELD} }${role_secret}"
  fi
  if [ "$secret_ok" = 1 ] && [ "$secret_iteration" = 1 ]; then
    eval "export ${role_secret}=\"\$secret_value\""
    # A startup read that failed put `-u NAME` in the filter; a re-read that
    # passes must take it out again, or the export above is stripped from
    # every iteration and the secret reaches nothing (#759). The leading
    # `env` stays first.
    case " ${secret_rereading} " in *" ${role_secret} "*) secret_refilter=1 ;; *) secret_refilter=0 ;; esac
    # Never a project's own `secrets.withhold` of the same name: that `-u` is
    # the project's deny, and a role secret read under the name must not lift it.
    case " ${RALPH_WITHHELD_SECRET_NAMES[*]} " in *" ${role_secret} "*) secret_refilter=0 ;; esac
    secret_filter=(env)
    secret_index=1
    while [ "$secret_index" -lt "${#RALPH_ENV_FILTER[@]}" ]; do
      if [ "$secret_refilter" = 1 ] && [ "${RALPH_ENV_FILTER[$secret_index]}" = "-u" ] \
        && [ "${RALPH_ENV_FILTER[$((secret_index + 1))]:-}" = "$role_secret" ]; then
        secret_index=$((secret_index + 2))
        continue
      fi
      secret_filter+=("${RALPH_ENV_FILTER[$secret_index]}")
      secret_index=$((secret_index + 1))
    done
    RALPH_ENV_FILTER=("${secret_filter[@]}")
    unset secret_filter secret_index secret_refilter
  else
    unset "$role_secret"
    # Once: a re-read of an unread secret passes through here again.
    case " ${RALPH_ENV_FILTER[*]} " in
      *" -u ${role_secret} "*) ;;
      *) RALPH_ENV_FILTER=(env -u "$role_secret" "${RALPH_ENV_FILTER[@]:1}") ;;
    esac
  fi
  unset secret_source secret_value secret_check secret_check_argv secret_said secret_ok secret_gate secret_iteration secret_targets secret_unread secret_status secret_from
done
unset role_secret secret_rereading
export RALPH_ROLE_SECRETS_AVAILABLE RALPH_ROLE_SECRETS_WITHHELD RALPH_ROLE_SECRETS_UNREAD
}
resolve_role_secrets $RALPH_ROLE_SECRETS
# Tells the gates this supervisor understands the secret re-read hand-back
# (#759): a gate that sees it comes back here after a poll without an unread
# secret instead of sleeping. An old supervisor still running after a deploy
# does not export it, and its gates keep sleeping as they always did.
export RALPH_SECRET_REREAD=1

# Every UNREAD secret is read again before each gate poll and each iteration,
# for every role and target (#759): a keyring still locked when the reconciler
# started the loop after a reboot otherwise costs the run that secret until a
# restart — a sentinel watching nothing, a coder explaining red CI blind. At
# most once per poll interval (bash's SECONDS), so an outage never becomes a
# busy loop of reads; `force` is for the callers that already waited out an
# interval. Never fatal: a read that fails again leaves the secret unread.
# One refused by its check is WITHHELD and one not found is absent, and
# neither is in UNREAD, so neither is read again.
SECRETS_REREAD_AT=$SECONDS
reread_role_secrets() { # <stage: gate|iteration> [force]
  [ -n "$RALPH_ROLE_SECRETS_UNREAD" ] || return 0
  # The stage the record carries: a re-read just before an iteration's first
  # turn must not flip the dashboard's stage back to "gate" mid-iteration.
  local reread_stage="${1:-gate}"
  if [ "${2:-}" != "force" ] \
    && [ $((SECONDS - SECRETS_REREAD_AT)) -lt "${RALPH_WAIT_FOR_WORK:-${PREFLIGHT_RETRY:-60}}" ]; then
    return 0
  fi
  SECRETS_REREAD_AT=$SECONDS
  reread_was_unread="$RALPH_ROLE_SECRETS_UNREAD"
  resolve_role_secrets $reread_was_unread || true
  for reread_name in $reread_was_unread; do
    case " ${RALPH_ROLE_SECRETS_AVAILABLE} " in
      *" ${reread_name} "*)
        reread_targets=""
        case " ${RALPH_ROLE_SECRETS_ITERATION} " in *" ${reread_name} "*) reread_targets="the iteration" ;; esac
        case " ${RALPH_ROLE_SECRETS_GATE} " in
          *" ${reread_name} "*) reread_targets="${reread_targets:+${reread_targets} and }the intake gate" ;;
        esac
        say "${LOOP_DISPLAY}: ${reread_name} read on retry — available to ${reread_targets}."
        record --event secret-reread --stage "$reread_stage" --detail "${reread_name} read on retry"
        ;;
    esac
  done
  unset reread_was_unread reread_name reread_targets
  return 0
}

# The role's intake gate, and — with the startup preflight, harness code that
# probes what the gate will act on (the clerk's Jira intake board,
# felipearos/ralph#447) — the only place a `gate` secret is exported; never
# to an iteration. The values are exported inside the subshell rather than
# passed as `env NAME=value` arguments, which `ps` would show to every user on
# the host.
export_gate_secrets() {
  for gate_secret in ${RALPH_GATE_ENV[@]+"${RALPH_GATE_ENV[@]}"}; do export "$gate_secret"; done
}
# The coder's gate is asked to claim the ticket it reports (`--claim`, #5), so
# the session it spawns starts already holding it and no other loop can take it
# in between. Only here, the supervisor's call, under the lease this run writes
# with RALPH_RUN_ID/RALPH_SUPERVISOR_PID and heartbeats: a hand-run `--once` is
# an operator's check and must not claim. Every other role's gate gets the argv
# it always got — they do not know the flag. Nor does a usage drain claim: it
# spawns only on work the loop already holds and parks on a new frontier
# ticket, so a claim taken then would sit fenced off from every sibling until
# the window resets.
run_intake_gate() { # <gate args...>
  local claim=()
  if [ "$INTAKE_GATE" = "frontier-gate.ts" ] && [ "${USAGE_DRAINING:-0}" != 1 ]; then
    claim=(--claim)
  fi
  (
    export_gate_secrets
    # The claim's speed event reads the iteration and session from the
    # environment, and these still name the iteration before this one: the
    # claim belongs to the session not yet started, so it carries neither.
    [ -z "${claim[*]+set}" ] || unset RALPH_ITERATION RALPH_SESSION_ID
    exec bun "${RALPH_HOME}/${INTAKE_GATE}" "$@" ${claim[@]+"${claim[@]}"}
  )
}

# The park sweep (#775): every parked ticket whose wake condition now holds is
# woken (or dropped, or escalated once) before the gate is asked, so a ticket
# woken by it is visible to the gate that follows. Read-only towards the loop:
# its status is one log line and nothing else — a missing file, a crash or a
# non-zero exit never halts the loop, re-runs the turn or touches the gate.
park_sweep() {
  (
    export_gate_secrets
    # Bounded like the reconcile above: a read that hangs must not hold the
    # loop away from its gate.
    exec timeout --kill-after=5s 180s bun "${RALPH_HOME}/park-probe.ts" sweep
  ) 2>&1 | tee -a "$SUPERVISOR_LOG"
  local sweep_status="${PIPESTATUS[0]}"
  if [ "$sweep_status" -ne 0 ]; then
    say "${LOOP_DISPLAY}: the park sweep exited ${sweep_status}; going on to the gate."
  fi
  return 0
}

# --- A gate that never reached a verdict ------------------------------------
# The gate's exits are verdicts: 0 is work (or a control command, or an orphaned
# supervisor), 1 is `--once`'s "nothing to do", and anything else means the gate
# itself never got to ask. That used to be fatal on the spot — and a missing
# file or an unrunnable script still ends the loop, just a few tries later —
# but it is also what a transient spawn failure looks like, and those are not a
# reason to sit a loop down. A signal counts as a non-verdict exit too, so
# `pkill -f frontier-gate` on an idle loop now takes the retries before the
# supervisor stops rather than stopping it at once. On
# 2026-10-07 loggd's rafa, idle at the gate on its thirteenth poll, took
# `ETXTBSY: text file is busy, posix_spawn 'bun'` while the self-hosted CI
# runner was writing, and the supervisor stopped — for 25 minutes, until
# somebody noticed, with a frontier that was simply empty.
#
# So a non-verdict exit is retried, with a growing wait, a bounded number of
# times; the stop below is unchanged and happens only once the gate has failed
# that many times in a row.
#
# The delay has `backoff.ts`'s shape — base, doubling per try, held at a
# ceiling — but deliberately not its machinery. That file's state is about an
# ITERATION that did not move its shepherd PR: it keys on a PR fingerprint, and
# `ralph.sh` deletes `.ralph/logs/backoff.json` at startup because a restart
# means "try now". Worse, asking it would mean spawning `bun`, which is the
# failure being retried.
GATE_RETRY_MAX="${RALPH_GATE_RETRY_MAX:-3}"
GATE_RETRY_SECONDS="${RALPH_GATE_RETRY_SECONDS:-15}"
GATE_RETRY_MAX_SECONDS="${RALPH_GATE_RETRY_MAX_SECONDS:-120}"
for gate_knob in "RALPH_GATE_RETRY_MAX=${GATE_RETRY_MAX}" \
  "RALPH_GATE_RETRY_SECONDS=${GATE_RETRY_SECONDS}" \
  "RALPH_GATE_RETRY_MAX_SECONDS=${GATE_RETRY_MAX_SECONDS}"; do
  if [[ ! "${gate_knob#*=}" =~ ^[1-9][0-9]*$ ]]; then
    echo "${LOOP_DISPLAY}: ${gate_knob%%=*} must be a positive integer; got '${gate_knob#*=}'." >&2
    exit 1
  fi
done
unset gate_knob

# Tries spent on the CURRENT ask. Cleared as soon as an ask reaches a verdict,
# rather than counted for the run: two failures, a verdict, then two more is not
# four in a row, and a loop that recovers must not be one try from stopping for
# the rest of the night. It bounds ASKS, not retries — `RALPH_GATE_RETRY_MAX` of
# 3 is two retries — which is what the "try N of M" line says.
GATE_TRIES=0

# One failed ask: record it, and either wait and report "ask again" (0) or
# report that the streak is spent (1). The caller owns the stop, so the message
# an operator has been reading since this script had one gate is still the
# supervisor's own line.
gate_retry() { # <status> <last-line-of-gate-output>
  local status="$1" said="${2:-}" delay step
  GATE_TRIES=$((GATE_TRIES + 1))
  # Never fatal, exactly like `observe_orchestrator`: this also spawns `bun` —
  # so under a SUSTAINED spawn failure this is the first thing that cannot run,
  # and the `say` line below is the only evidence left — and an unrecordable
  # failure must not become an unretried one.
  #
  # The note is classified as error output by `buildObservation`, so the spawn
  # error itself reaches the record's KIND and not just its text: exit 2 alone
  # classifies as `unavailable`, "the harness is not installed", which is the
  # wrong repair entirely. `runner-signals.json`'s `spawn-failure` patterns are
  # what make the difference.
  bun "${RALPH_HOME}/runner-failure.ts" observe --stage gate --exit "$status" \
    --note "the intake gate exited ${status} without a verdict (try ${GATE_TRIES} of ${GATE_RETRY_MAX})${said:+: ${said}}" \
    >/dev/null 2>&1 || true
  if [ "$GATE_TRIES" -ge "$GATE_RETRY_MAX" ]; then
    return 1
  fi
  # Clamped BEFORE the doubling as well as during it: the knobs are validated
  # for shape, not against each other, so a base above the ceiling would
  # otherwise make the FIRST wait — the one try that skips the loop below —
  # longer than the maximum this script declares.
  delay="$GATE_RETRY_SECONDS"
  [ "$delay" -gt "$GATE_RETRY_MAX_SECONDS" ] && delay="$GATE_RETRY_MAX_SECONDS"
  for ((step = 1; step < GATE_TRIES; step++)); do
    delay=$((delay * 2))
    if [ "$delay" -ge "$GATE_RETRY_MAX_SECONDS" ]; then
      delay="$GATE_RETRY_MAX_SECONDS"
      break
    fi
  done
  say "${LOOP_DISPLAY}: the intake gate did not reach a verdict (status ${status}) — retrying in ${delay}s (try ${GATE_TRIES} of ${GATE_RETRY_MAX})."
  record --event gate-retry --stage gate \
    --detail "the intake gate exited ${status} without a verdict; retrying in ${delay}s (try ${GATE_TRIES} of ${GATE_RETRY_MAX})"
  # Through the control inbox, like the preflight wait: a retry that slept
  # through an operator's stop would be a worse fault than the one it is
  # covering.
  if ! control_sleep "$delay" && ! control_checkpoint; then
    say "${LOOP_DISPLAY}: stopped by an operator — ${CONTROL_STOP_WHY}"
    record --event control-stop --stop "$CONTROL_STOP_KIND" --why "$CONTROL_STOP_WHY"
    [ "$CONTROL_STOP_KIND" = "failed" ] && exit 1
    exit 0
  fi
  return 0
}

# A secret of a role this loop does NOT hold is not merely unread: it is
# stripped, because the manager injects the whole scope into every child and
# a coder would otherwise be handed the doctor's retry token by `doppler run`.
for role_secret in $RALPH_ROLE_FOREIGN_SECRETS; do
  RALPH_ENV_FILTER=(env -u "$role_secret" "${RALPH_ENV_FILTER[@]:1}")
done
unset role_secret

# How long a plan usage stop's park sleeps before it asks again: short enough
# that a lowered threshold or a waiver applies within minutes, long enough that
# a park of days is a few hundred cheap checks. Anything but a positive whole
# number is the default, never a refusal.
RALPH_USAGE_STOP_RECHECK_SECONDS="${RALPH_USAGE_STOP_RECHECK_SECONDS:-300}"
[[ "$RALPH_USAGE_STOP_RECHECK_SECONDS" =~ ^[1-9][0-9]*$ ]] || RALPH_USAGE_STOP_RECHECK_SECONDS=300

# --- Startup preflight ------------------------------------------------------
# Everything the ITERATION needs and this script never touches: the CLIs it
# shells out to, the credentials it works through, the repository state it
# reads, and the frontier's own prerequisites. Asked once, read-only, bounded,
# and — the point — before the frontier gate and before the first paid
# orchestrator turn. `ralph/preflight.ts` carries the check list and why each
# one is worth a startup message rather than an iteration.
#
# Its two failure verdicts are not the same answer:
#
#   1 denied      a local requirement no amount of waiting fixes — no
#                 credential, no label, no CLI. Refused, with the remedy the
#                 preflight printed. Nothing has been claimed.
#   2 unavailable an external service the loop cannot reach. The setup is
#                 fine; the loop simply cannot work yet, so this waits and
#                 re-asks — in BOTH modes. Refusing would let a network blip
#                 permanently end a loop meant to be left running.
#
#                 Ungated too, unlike the frontier gate's "nothing to do",
#                 because the two are different answers: an empty frontier is
#                 a real answer an iteration cannot improve on, while an
#                 unreachable GitHub is no answer at all — stopping on it
#                 would report a drained backlog the loop never actually saw.
#                 The interval there is RALPH_PREFLIGHT_RETRY_SECONDS, since
#                 an ungated supervisor has no poll interval of its own.
#                 Ctrl-C, or a kill, is what ends it; every wait says so.
#
# Anything else means the preflight could not run at all — the runtime failed
# to exec (126 for `bun: Text file busy` while bun is replaced, 127), it
# crashed, or a signal ended it — and so does a 1 with no verdict file, a
# preflight.ts bun could not even load. That is no evidence about the loop's
# requirements either way, so it waits too, and refusing on it once left loops
# down for days over a momentary ETXTBSY (#767). Its wait doubles with each
# consecutive could-not-run answer, from the interval below up to ten minutes,
# or the poll interval if longer, so a preflight that stays broken is not
# re-run every interval forever; any other answer resets the doubling. It
# records a wait, not preflight-broken:
# the notifier pages on every preflight-broken record, and a wait that paged
# each interval would teach the operator to ignore it. The once-per-wait alert
# below is what tells them it has gone on too long.
#
# The interval: a gated supervisor re-asks on its own poll interval, so an
# operator who widened or tightened that gets the same cadence here. An ungated
# one has no interval, hence the default — small enough that a passing outage
# costs a minute, large enough that an hour-long one is not a poll flood.
PREFLIGHT_RETRY="${RALPH_WAIT_FOR_WORK:-${RALPH_PREFLIGHT_RETRY_SECONDS:-60}}"
if [[ ! "$PREFLIGHT_RETRY" =~ ^[1-9][0-9]*$ ]]; then
  echo "${LOOP_DISPLAY}: RALPH_PREFLIGHT_RETRY_SECONDS must be a positive integer; got '${PREFLIGHT_RETRY}'." >&2
  exit 1
fi
# How long one wait may stay silent before an operator is told about it. An
# unrecognised Doppler failure now waits instead of refusing, so a wait that
# never ends is the shape a real misconfiguration can take — and a wait nobody
# hears about is the "waits forever in silence" risk preflight.ts names.
# 0 alerts on the first wait; it does not turn the alert off.
PREFLIGHT_ALERT="${RALPH_PREFLIGHT_ALERT_SECONDS:-1800}"
if [[ ! "$PREFLIGHT_ALERT" =~ ^[0-9]+$ ]]; then
  echo "${LOOP_DISPLAY}: RALPH_PREFLIGHT_ALERT_SECONDS must be a non-negative integer; got '${PREFLIGHT_ALERT}'." >&2
  exit 1
fi
# Per run, beside the supervisor log. Absolute, so the file the preflight
# writes is the one read here whatever directory the preflight runs from.
PREFLIGHT_JSON="${PWD}/${SUPERVISOR_LOG%/*}/preflight-${RALPH_RUN_ID}.json"
# The comma-joined names of the checks whose outcome is <status>, from the
# verdict file the preflight just wrote. A missing or unreadable file prints
# nothing, and every caller falls back to the message it had before the file.
preflight_failed_checks() { # <status>
  bun -e '
    try {
      const { checks } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const names = checks.filter((c) => c?.outcome?.status === process.argv[2]).map((c) => String(c.name));
      process.stdout.write(names.join(","));
    } catch {}
  ' "$PREFLIGHT_JSON" "$1" 2>/dev/null || true
}
PREFLIGHT_WAITED=0
PREFLIGHT_WAIT_STARTED="$(date +%s)"
PREFLIGHT_ALERTED=""
# Which kind of wait this is (unavailable, broken) and how long THIS kind has
# waited. A change of kind is a new wait for the alert: an outage already paged
# for must not swallow the page for a preflight that then stops running, which
# is a different thing for the operator to fix. PREFLIGHT_WAITED stays the
# total idle the lines say.
PREFLIGHT_WAIT_KIND=""
PREFLIGHT_KIND_WAITED=0
# The current could-not-run wait; empty until one is taken, and again after
# any other answer, which restarts the doubling at PREFLIGHT_RETRY.
PREFLIGHT_BROKEN_WAIT=""
PREFLIGHT_BROKEN_CAP=600
# A broken preflight is never asked faster than a working one is polled, so a
# poll interval above ten minutes is the cap.
[ "$PREFLIGHT_RETRY" -gt "$PREFLIGHT_BROKEN_CAP" ] && PREFLIGHT_BROKEN_CAP="$PREFLIGHT_RETRY"
# One startup wait, shared by both waiting answers: the once-per-wait alert,
# the operator-aware sleep, the idle accounting and the secret re-read.
preflight_wait() { # <kind> <seconds> <alert subject> <alert body>
  if [ "$1" != "$PREFLIGHT_WAIT_KIND" ]; then
    PREFLIGHT_WAIT_KIND="$1"
    PREFLIGHT_KIND_WAITED=0
    PREFLIGHT_ALERTED=""
    PREFLIGHT_WAIT_STARTED="$(date +%s)"
  fi
  shift
  # Once per wait: the alert says the wait has gone on long enough to need
  # a human, and repeating it every interval would only teach them to
  # ignore it. The loop keeps waiting — an outage can still lift.
  if [ -z "$PREFLIGHT_ALERTED" ] && [ "$PREFLIGHT_KIND_WAITED" -ge "$PREFLIGHT_ALERT" ]; then
    PREFLIGHT_ALERTED=1
    bun "${RALPH_HOME}/push-notification.ts" push --kind preflight-stalled \
      --occurrence "preflight-stalled:${RALPH_RUN_ID}:${PREFLIGHT_WAIT_STARTED}" \
      --subject "$2" --body "$3" \
      --priority high >/dev/null 2>> "$SUPERVISOR_LOG" || true
  fi
  if ! control_sleep "$1" && ! control_checkpoint; then
    say "${LOOP_DISPLAY}: stopped by an operator — ${CONTROL_STOP_WHY}"
    record --event control-stop --stop "$CONTROL_STOP_KIND" --why "$CONTROL_STOP_WHY"
    [ "$CONTROL_STOP_KIND" = "failed" ] && exit 1
    exit 0
  fi
  PREFLIGHT_WAITED=$((PREFLIGHT_WAITED + $1))
  PREFLIGHT_KIND_WAITED=$((PREFLIGHT_KIND_WAITED + $1))
  # A secret that could not be read is read again before the next ask;
  # without this a keyring that unlocks after boot is never seen.
  reread_role_secrets gate force
}
# The could-not-run wait, doubling from PREFLIGHT_RETRY up to the cap.
preflight_broken_wait() { # <status as said, e.g. "126" or "1, no verdict">
  if [ -z "$PREFLIGHT_BROKEN_WAIT" ]; then
    PREFLIGHT_BROKEN_WAIT="$PREFLIGHT_RETRY"
  else
    PREFLIGHT_BROKEN_WAIT=$((PREFLIGHT_BROKEN_WAIT * 2))
    [ "$PREFLIGHT_BROKEN_WAIT" -gt "$PREFLIGHT_BROKEN_CAP" ] && PREFLIGHT_BROKEN_WAIT="$PREFLIGHT_BROKEN_CAP"
  fi
  say "${LOOP_DISPLAY}: the preflight could not run (status $1) — waiting ${PREFLIGHT_BROKEN_WAIT}s and asking again (idle ${PREFLIGHT_WAITED}s; Ctrl-C to stop)."
  record --event preflight-wait --stage preflight \
    --detail "the preflight could not run (status $1); idle ${PREFLIGHT_WAITED}s"
  preflight_wait broken "$PREFLIGHT_BROKEN_WAIT" \
    "${RALPH_LOOP_NAME} preflight could not run (status $1)" \
    "the ${RALPH_LOOP_NAME} loop has waited ${PREFLIGHT_WAITED}s at startup without claiming work because the preflight could not run (status $1); it keeps waiting. See ${SUPERVISOR_LOG}."
}
while :; do
  # Removed before each ask, so a verdict from an earlier ask is never read as
  # this one's when the preflight fails to write the file.
  rm -f "$PREFLIGHT_JSON"
  PREFLIGHT_OUTPUT="$(export_gate_secrets; RALPH_PREFLIGHT_JSON="$PREFLIGHT_JSON" bun "${RALPH_HOME}/preflight.ts" 2>&1)"
  PREFLIGHT_STATUS=$?
  while IFS= read -r preflight_line; do
    [ -n "$preflight_line" ] && say "$preflight_line"
  done <<EOF
$PREFLIGHT_OUTPUT
EOF
  case "$PREFLIGHT_STATUS" in
    0) rm -f "$PREFLIGHT_JSON"; break ;;
    1)
      # The real preflight writes its verdict file whenever it reaches a
      # verdict, so a 1 with no file is a preflight.ts bun could not load —
      # a module missing between `git pull` and `bun install`, a half-written
      # file — exiting before main() ran. Read as a denial it stopped the loop
      # for good with no detail, and the reconcile never retries a denial; it
      # is no evidence about the requirements, so it waits like any other
      # could-not-run (#767). The cost: a real denial whose verdict file could
      # not be written (an unwritable logs directory) now waits and pages
      # instead of stopping.
      if [ ! -f "$PREFLIGHT_JSON" ]; then
        preflight_broken_wait "1, no verdict"
        continue
      fi
      say "${LOOP_DISPLAY}: preflight refused startup; nothing was claimed."
      preflight_checks="$(preflight_failed_checks denied)"
      if [ -n "$preflight_checks" ]; then
        # --detail is what lands in loop-state's lastEvent.detail, which the
        # dashboard and the notifier read over a process boundary: the bare
        # comma-separated names are what lets them say which check refused.
        record --event preflight-denied --stop failed --detail "$preflight_checks" \
          --why "preflight refused startup on ${preflight_checks}; a local requirement is not met"
      else
        record --event preflight-denied --stop failed \
          --why "preflight refused startup; a local requirement is not met"
      fi
      exit 1
      ;;
    2)
      PREFLIGHT_BROKEN_WAIT=""
      # Idle time BEFORE this wait, counted after it: the one thing this line
      # has to prove is that a supervisor nobody is watching is idle rather
      # than dead, and a line claiming a wait it has not taken yet proves the
      # wrong thing.
      preflight_checks="$(preflight_failed_checks unavailable)"
      say "${LOOP_DISPLAY}: an external dependency is unavailable${preflight_checks:+ (${preflight_checks})} — waiting ${PREFLIGHT_RETRY}s without claiming work (idle ${PREFLIGHT_WAITED}s; Ctrl-C to stop)."
      if [ -n "$preflight_checks" ]; then
        record --event preflight-wait --stage preflight \
          --detail "unavailable: ${preflight_checks}; idle ${PREFLIGHT_WAITED}s"
      else
        record --event preflight-wait --stage preflight \
          --detail "an external dependency is unavailable; idle ${PREFLIGHT_WAITED}s"
      fi
      preflight_wait unavailable "$PREFLIGHT_RETRY" \
        "${RALPH_LOOP_NAME} preflight waiting on ${preflight_checks:-an external dependency}" \
        "the ${RALPH_LOOP_NAME} loop has waited ${PREFLIGHT_WAITED}s at startup on ${preflight_checks:-an unavailable external dependency} without claiming work; it keeps waiting. See ${SUPERVISOR_LOG}."
      ;;
    *)
      preflight_broken_wait "$PREFLIGHT_STATUS"
      ;;
  esac
done

# Fail before creating transcript pipelines; per-child checks below also cover
# secret changes between iterations and recovery turns.
if ! "${RALPH_SECRETS_CMD[@]}" "${RALPH_ENV_FILTER[@]}" true; then
  say "${LOOP_DISPLAY}: development environment verification failed; nothing was claimed."
  record --event secrets-env --stop failed \
    --why "development environment verification failed; nothing was claimed"
  exit 1
fi

i=0
while [ "$i" -lt "$MAX" ]; do
  # Asked BEFORE the frontier gate, so a paused loop does not poll the tracker
  # and a stopped one never asks a question whose answer it will not use.
  if ! control_checkpoint; then
    say "${LOOP_DISPLAY}: stopped by an operator — ${CONTROL_STOP_WHY}"
    record --event control-stop --stop "$CONTROL_STOP_KIND" --why "$CONTROL_STOP_WHY"
    [ "$CONTROL_STOP_KIND" = "failed" ] && exit 1
    exit 0
  fi
  # The last iteration was rejected by the usage limit: wait, with no model,
  # until the reset its state names. Cut short by an operator command, it goes
  # back to the checkpoint with the state kept, so the wait resumes after a
  # pause. An unreadable state reads as 0 left — never a wait that cannot end.
  if [ -f "$USAGE_WAIT_STATE" ]; then
    usage_left="$(bun "${RALPH_HOME}/usage-limit.ts" remaining --state "$USAGE_WAIT_STATE" 2>> "$SUPERVISOR_LOG" || true)"
    [[ "$usage_left" =~ ^[0-9]+$ ]] || usage_left=0
    if [ "$usage_left" -gt 0 ]; then
      usage_until="$(date -d "+${usage_left} seconds" +%H:%M 2>/dev/null || echo "?")"
      say "${LOOP_DISPLAY}: waiting for the usage limit to reset at ${usage_until} (${usage_left}s left)."
      record --event usage-wait --stage gate --detail "waiting for usage reset until ${usage_until} (${usage_left}s left)"
      renew_leases
      control_sleep "$usage_left" || continue
    fi
    rm -f "$USAGE_WAIT_STATE"
    say "${LOOP_DISPLAY}: usage limit reset — resuming."
    record --event usage-reset --stage gate
  fi
  # The plan usage stop. A park sleeps one recheck and goes back to the
  # checkpoint; a drain lets the gate answer once and only spawns on work the
  # loop holds. Only the frontier gate's verdicts tell held work from new, and
  # the other roles' gates may claim as they answer, so for them a drain is a
  # park: their units of work are short and nothing is left half-built.
  USAGE_DRAINING=0
  usage_stop_check
  case "$USAGE_STOP_VERDICT" in
    park)
      usage_stop_park "at its hard threshold"
      continue
      ;;
    drain)
      if [ "$INTAKE_GATE" != "frontier-gate.ts" ]; then
        usage_stop_park "this role has no held work to drain"
        continue
      fi
      USAGE_DRAINING=1
      # A drain that already finished for this window parks again on every
      # recheck; announcing the drain each time wrote a drain and a park pair
      # every few minutes for a whole night (2026-11-13, loggd). It is said
      # once, and again only if held work turns up (below, after the gate).
      if [ "$USAGE_STOP_SAID" != "drain:${USAGE_STOP_KEY}" ] &&
        [ "$USAGE_STOP_SAID" != "park:${USAGE_STOP_KEY}:${USAGE_DRAIN_DONE}" ]; then
        usage_drain_announce
      fi
      ;;
    *)
      if [ -n "$USAGE_STOP_SAID" ]; then
        USAGE_STOP_SAID=""
        say "${LOOP_DISPLAY}: plan usage stop cleared — ${USAGE_STOP_DETAIL}; resuming."
        record --event usage-stop-cleared --stage gate --detail "$USAGE_STOP_DETAIL"
      fi
      ;;
  esac
  # The previous iteration did not move its target: wait here, with no model,
  # before asking the gate again. With no backoff pending this is skipped. Any
  # status but the spent budget's is "go on" — a backoff that cannot run must
  # never hold or stop a loop.
  # A re-gate after a secret re-read hand-back (#759) is the same gate wait
  # going on, not a new ask after an iteration: waiting the backoff again
  # would add a full backoff to every poll and spend its budget until the
  # loop stopped blocked. The file stays, so the next real ask still waits.
  GATE_SKIP_BACKOFF_NOW="${GATE_SKIP_BACKOFF:-0}"
  GATE_SKIP_BACKOFF=0
  if [ -f .ralph/logs/backoff.json ] && [ "$GATE_SKIP_BACKOFF_NOW" != 1 ]; then
    record --event backoff-wait --stage gate --detail "backing off a target the last iteration did not move"
    bun "${RALPH_HOME}/backoff.ts" wait 2>&1 | tee -a "$SUPERVISOR_LOG"
    BACKOFF_STATUS="${PIPESTATUS[0]}"
    # 4: an operator command is waiting. Back to the checkpoint; the backoff
    # file is still there, so the wait resumes if the command was not a stop.
    [ "$BACKOFF_STATUS" -eq 4 ] && continue
    if [ "$BACKOFF_STATUS" -eq 3 ]; then
      say "${LOOP_DISPLAY}: the backoff budget is spent and the blocker is still there; needs human triage."
      # A spent SHARED episode (#431) leaves its own record: the one loop that
      # claimed the escalation names every waiter, the others record
      # `backoff-exhausted-shared`, which pushes no second ticket-blocked. A
      # file that is missing, unreadable or malformed is today's record.
      EXHAUSTED_EVENT=backoff-exhausted
      EXHAUSTED_WHY="backed off for ${RALPH_BACKOFF_BUDGET_SECONDS}s on a target no iteration could move; needs human triage"
      if [ -f .ralph/logs/backoff-exhausted.json ]; then
        EXHAUSTED_RECORD="$(bun -e '
          try {
            const { event, why } = JSON.parse(require("fs").readFileSync(".ralph/logs/backoff-exhausted.json", "utf8"));
            if ((event === "backoff-exhausted" || event === "backoff-exhausted-shared") &&
                typeof why === "string" && why.trim() !== "" && !/[\r\n\t]/.test(why)) {
              process.stdout.write(`${event}\t${why.trim()}`);
            }
          } catch {}
        ' 2>/dev/null || true)"
        if [ -n "$EXHAUSTED_RECORD" ]; then
          EXHAUSTED_EVENT="${EXHAUSTED_RECORD%%$'\t'*}"
          EXHAUSTED_WHY="${EXHAUSTED_RECORD#*$'\t'}"
        fi
      fi
      record --event "$EXHAUSTED_EVENT" --stop blocked --why "$EXHAUSTED_WHY"
      exit 0
    fi
  fi
  # #775: wake what is due before the gate is asked, so a woken ticket is
  # visible to the gate that follows. Never fatal; see `park_sweep`.
  park_sweep || true
  GATE_SAID=""
  # Set when the gate woke for an operator command rather than for work. The
  # answer to that is to go round the OUTER loop, back to the control
  # checkpoint — which is why it is a flag and not a `continue` inside the
  # retry loop below.
  GATE_REGATE=0
  # One ask per turn of this loop; a turn that does not reach a verdict is a
  # retry (see `gate_retry`), and `GATE_TRIES` is cleared once one arrives.
  while :; do
    # Before every ask, gated or --once (#759): a gate secret read here is
    # handed to this very ask. Rate-limited inside, so a retry streak does not
    # turn into a read per retry.
    reread_role_secrets gate
    # A draining loop asks once rather than blocking: what it may take is
    # already there or it is not, and a blocking wait would wake for new work
    # it would then refuse.
    if [ -n "$RALPH_WAIT_FOR_WORK" ] && [ "$USAGE_DRAINING" != 1 ]; then
      # The gate blocks — possibly for hours — and reports on every poll while it
      # does. Its output goes through the supervisor log for the same reason the
      # rest does: it is the evidence the loop is alive.
      # A hold past its budget, already told to the operator, keeps the loop
      # on the needs-you list: the panel reads only the last event, so the
      # wait re-records the exhausted hold rather than a plain wait (#771).
      if [ "${RALPH_ROLE_GATE_HOLDS:-0}" = 1 ] && gate_verdict notified >/dev/null; then
        record --event gate-hold-exhausted --stage gate --detail "$(gate_verdict describe)"
      else
        record --event frontier-wait --stage gate
      fi
      GATE_STARTED="$(date +%s)"
      # Also kept aside, because the verdict line says WHAT the work is, and a
      # shepherd target is what the backoff below watches.
      GATE_OUT=".ralph/logs/.gate-$$"
      # RALPH_PARK_SWEEP_IN_GATE: the gate runs the park sweep before each of
      # its polls too (#775), so a ticket that wakes during a long wait is seen.
      RALPH_CONTROL_POLL_SECONDS="$CONTROL_POLL_SECONDS" RALPH_PARK_SWEEP_IN_GATE=1 \
        run_intake_gate "$RALPH_WAIT_FOR_WORK" 2>&1 | tee -a "$SUPERVISOR_LOG" "$GATE_OUT"
      # The GATE's status, not the pipeline's. `tee` is how the line reaches the
      # log, and a log that could not be written is not a gate that failed to
      # start — the retry and the stop below both judge the gate itself.
      GATE_STATUS="${PIPESTATUS[0]}"
      GATE_SAID="$(tail -n 1 "$GATE_OUT" 2>/dev/null || true)"
      rm -f "$GATE_OUT"
      if [ "$GATE_STATUS" -ne 0 ]; then
        # A failed gate run ends the wait it was resuming (#759).
        unset RALPH_GATE_WAITING_SINCE RALPH_GATE_POLLS
        if gate_retry "$GATE_STATUS" "$GATE_SAID"; then
          continue
        fi
        say "${LOOP_DISPLAY}: the intake gate failed to start; stopping."
        record --event gate-broken --stop failed --why "the intake gate failed to start"
        exit 1
      fi
      # The gate woke for an operator command rather than for work: apply it at
      # the checkpoint, and wait again if it was not a stop.
      #
      # ANCHORED at the start of the line, and it has to be: the work-available
      # line carries the ticket's raw title, so an unanchored match on this phrase
      # would fire on an issue merely titled after it — and the re-gate sits above
      # the iteration counter, so the supervisor would re-gate forever, spawning
      # nothing, in the overnight mode. Any role's gate is accepted (the name
      # before the colon is the gate's own), which is why this is not just the
      # coder's literal prefix.
      if printf '%s\n' "$GATE_SAID" | grep -qE '^[A-Za-z0-9_.-]+: control command waiting'; then
        GATE_REGATE=1
      fi
      # The gate polled without a secret that could not be read, and came back
      # here instead of sleeping (#759): read it again, sleep what is left of
      # the poll, and ask the gate again. Without this a keyring that unlocks
      # after boot is never seen by a gate the preflight does not wait for.
      # Anchored for the same reason as the control line: a ticket title could
      # carry the phrase. It re-gates above the iteration counter, so this exit
      # 0 never spawns an iteration.
      if printf '%s\n' "$GATE_SAID" | grep -qE '^[A-Za-z0-9_.-]+: secret re-read due'; then
        reread_started=$SECONDS
        reread_role_secrets gate force
        # The rest of the wait the gate would have slept, as it said, so a
        # re-read never shortens a poll. A cut-short sleep needs nothing more:
        # the re-gate goes back to the control checkpoint anyway.
        reread_wait="$(printf '%s\n' "$GATE_SAID" | sed -nE 's/.* poll again in ([0-9]+)s.*/\1/p')"
        [ -n "$reread_wait" ] || reread_wait="$RALPH_WAIT_FOR_WORK"
        reread_left=$(( reread_wait - (SECONDS - reread_started) ))
        [ "$reread_left" -gt 0 ] && { control_sleep "$reread_left" || true; }
        # The read above counts for this whole wait: without this, the
        # rate-limited read before the next ask would find an interval gone
        # and read again, delaying the poll by a second read.
        SECRETS_REREAD_AT=$SECONDS
        # One waiting line across the hand-backs: the next gate run resumes it
        # from when this wait began and the polls it has made, rather than
        # announcing a fresh wait every interval.
        export RALPH_GATE_WAITING_SINCE="${RALPH_GATE_WAITING_SINCE:-$GATE_STARTED}"
        # The gate says which poll it handed back after; a gate run makes
        # several polls between hand-backs once the schedule backs off. An
        # older line without it counts one poll.
        reread_polls="$(printf '%s\n' "$GATE_SAID" | sed -nE 's/.* after poll ([0-9]+).*/\1/p')"
        export RALPH_GATE_POLLS="${reread_polls:-$(( ${RALPH_GATE_POLLS:-0} + 1 ))}"
        unset reread_started reread_wait reread_left reread_polls
        GATE_REGATE=1
        GATE_SKIP_BACKOFF=1
      # The gate has held on one verdict past its budget (#771): tell the
      # operator once, mark the record so the gate does not hand back for it
      # again, and keep waiting without a session. Anchored for the same reason
      # as the lines above.
      elif printf '%s\n' "$GATE_SAID" | grep -qE '^[A-Za-z0-9_.-]+: hold budget spent'; then
        hold_line="$(gate_verdict describe)"
        [ -n "$hold_line" ] || hold_line="${GATE_SAID#*: }"
        read -r hold_kind hold_ticket hold_first _ <<< "$(gate_verdict read)"
        bun "${RALPH_HOME}/push-notification.ts" push --kind gate-hold-exhausted \
          --occurrence "gate-hold-exhausted:${hold_kind}:${hold_ticket}:${hold_first}" \
          --subject "${RALPH_LOOP_NAME} has held on one gate verdict past its budget" \
          --body "${hold_line}; the loop spawns no session on it. Clear with: bun ${RALPH_HOME}/gate-verdict-store.ts clear (in $(pwd))" \
          --priority high >/dev/null 2>> "$SUPERVISOR_LOG" || true
        if gate_verdict notify; then
          say "${LOOP_DISPLAY}: the gate has held past its budget (${hold_line}); the operator is notified, and the loop keeps holding."
        else
          # Unmarked, the gate would hand back again at once: one poll per
          # interval, never a hot loop.
          say "${LOOP_DISPLAY}: the gate has held past its budget (${hold_line}), but the record could not be marked notified; waiting one interval."
          control_sleep "$RALPH_WAIT_FOR_WORK" || true
        fi
        record --event gate-hold-exhausted --stage gate --detail "$hold_line"
        # The wait goes on, as after a secret re-read.
        export RALPH_GATE_WAITING_SINCE="${RALPH_GATE_WAITING_SINCE:-$GATE_STARTED}"
        hold_polls="$(printf '%s\n' "$GATE_SAID" | sed -nE 's/.* after poll ([0-9]+).*/\1/p')"
        export RALPH_GATE_POLLS="${hold_polls:-$(( ${RALPH_GATE_POLLS:-0} + 1 ))}"
        unset hold_line hold_kind hold_ticket hold_first hold_polls
        GATE_REGATE=1
        GATE_SKIP_BACKOFF=1
      # The verdict the gate held on changed (#771): mark the record released
      # and ask again, without a session — the next answer is the new verdict.
      # Released, not deleted: "no work" includes "every candidate is held",
      # which a flaky read also produces, and one such poll must not restart
      # the hold's budget clock or reset the disagreement streak when the same
      # verdict comes back.
      elif printf '%s\n' "$GATE_SAID" | grep -qE '^[A-Za-z0-9_.-]+: hold released'; then
        if gate_verdict release >/dev/null; then
          say "${LOOP_DISPLAY}: the gate's hold is released — ${GATE_SAID#*hold released — }."
        else
          say "${LOOP_DISPLAY}: the gate's hold is released — ${GATE_SAID#*hold released — } — but the record could not be marked released; waiting one interval."
          control_sleep "$RALPH_WAIT_FOR_WORK" || true
        fi
        unset RALPH_GATE_WAITING_SINCE RALPH_GATE_POLLS
        GATE_REGATE=1
        GATE_SKIP_BACKOFF=1
      else
        # Work, a control command: the wait is over, and the next one is new.
        unset RALPH_GATE_WAITING_SINCE RALPH_GATE_POLLS
      fi
    else
      # The ungated ask is the same gate in --once form: one read-only verdict,
      # no polling. Exit 0 spawns; exit 1 is the verdict "nothing to do" — which
      # covers both a definitively empty frontier and probes that could not be
      # read, because an iteration could not have worked around either, and the
      # gate's own line above says which it was. Anything else means the gate
      # itself never asked (a missing file, an unrunnable script, a spawn that
      # failed), the same fault the gated branch retries and then refuses on.
      GATE_ONCE="$(run_intake_gate --once 2>&1)"
      GATE_ONCE_STATUS=$?
      printf '%s\n' "$GATE_ONCE" | tee -a "$SUPERVISOR_LOG"
      GATE_SAID="$(printf '%s\n' "$GATE_ONCE" | tail -n 1)"
      case "$GATE_ONCE_STATUS" in
        0) ;;
        1)
          # Draining, "nothing" means nothing held: park until the reset
          # rather than stop, which an unattended night could not undo.
          if [ "$USAGE_DRAINING" = 1 ]; then
            GATE_TRIES=0
            break
          fi
          say "${LOOP_DISPLAY}: nothing for an iteration to do — stopping without spending one."
          record --event frontier-empty --stop completed \
            --why "nothing for an iteration to do — stopped without spending one"
          exit 0
          ;;
        *)
          if gate_retry "$GATE_ONCE_STATUS" "$GATE_SAID"; then
            continue
          fi
          say "${LOOP_DISPLAY}: the intake gate failed to start; stopping."
          record --event gate-broken --stop failed --why "the intake gate failed to start"
          exit 1
          ;;
      esac
    fi
    # A verdict arrived, so the streak this ask built up is over.
    GATE_TRIES=0
    break
  done
  if [ "$GATE_REGATE" -eq 1 ]; then
    continue
  fi
  # A drain spawns only on held work; anything else (new work, or none) is
  # the drain finished, and the loop parks until the window resets.
  if [ "$USAGE_DRAINING" = 1 ]; then
    if ! usage_drain_held "$GATE_SAID"; then
      usage_stop_park "$USAGE_DRAIN_DONE"
      continue
    fi
    # Held work after a quiet recheck: the drain is working again, so say so.
    [ "$USAGE_STOP_SAID" = "drain:${USAGE_STOP_KEY}" ] || usage_drain_announce
  fi

  # What the gate spawned this iteration for, read off its verdict line. Every
  # role's gate names itself first, so the prefix is matched loosely and the case
  # is the text after `work available — `: a doctor's gate says `ci-doctor-gate:`
  # and a coder's says `frontier-gate:`, and neither the shepherd fingerprint nor
  # the claim-race check cares which asked.
  INTAKE_CASE="$(printf '%s\n' "$GATE_SAID" | sed -nE 's/^[A-Za-z0-9_.-]+: work available — (.*)$/\1/p')"
  # The PR the gate is spawning this iteration to shepherd, and how it stands
  # before the iteration touches it — so the end of the iteration can tell
  # "moved it" from "went round again". Empty for any other kind of work.
  SHEPHERD_PR="$(printf '%s\n' "$INTAKE_CASE" | sed -nE 's/^.*PR #([0-9]+) to shepherd.*/\1/p')"
  # Likewise the frontier ticket, which a lost claim race is checked against.
  # It is the ROLE's pick, because the gate probed the role's bucket: a triager
  # that lost #1400 to the other triager must be checked against #1400, and
  # nothing here has to know which bucket that came from.
  GATE_TICKET="$(printf '%s\n' "$INTAKE_CASE" | sed -nE 's/^frontier ticket #([0-9]+).*/\1/p')"
  # And whether the gate claimed it already (#5), in which case no race can
  # explain an empty iteration. Absent on the gate's unreadable-probe fallback.
  GATE_CLAIMED=""
  case "$INTAKE_CASE" in *" — claim held by this loop") [ -n "$GATE_TICKET" ] && GATE_CLAIMED=1 ;; esac
  # The case itself reaches the session, so a role whose work is not a ticket
  # number — a doctor's red build — has something to start from. A coder's
  # prompt reads the backlog and ignores it.
  export RALPH_INTAKE_CASE="$INTAKE_CASE"
  # The gate reported work, so a hold on any OTHER verdict is over (#771). The
  # same subject keeps its record, released or not: that is the evidence
  # `wait_or_stop` needs to tell a hold that did not take, or a verdict that
  # came back, from a fresh one.
  if [ -n "$RALPH_WAIT_FOR_WORK" ] && [ "${RALPH_ROLE_GATE_HOLDS:-0}" = 1 ]; then
    gate_verdict clear --keep-if-case "$INTAKE_CASE" >/dev/null \
      || say "${LOOP_DISPLAY}: the gate verdict record could not be cleared; see the supervisor log."
  fi
  # A pr-medic's case is an operator's pull request, which its gate has already
  # claimed: `operator PR #<n> on <branch> — <reason>` (`pr-medic/gate.ts`'s
  # `caseText`). The number and the reason (`red: <checks>`, `conflicting`, or
  # both) go to the session as fields of their own, so its prompt reads them
  # rather than parsing prose. Matched on the branch being one word, which git
  # guarantees, so a reason holding anything at all reads back whole. Empty for
  # every other role's case, never stale from an earlier iteration.
  RALPH_INTAKE_PR="$(printf '%s\n' "$INTAKE_CASE" | sed -nE 's/^operator PR #([0-9]+) on [^ ]+ — .*$/\1/p')"
  RALPH_INTAKE_REASON=""
  if [ -n "$RALPH_INTAKE_PR" ]; then
    RALPH_INTAKE_REASON="$(printf '%s\n' "$INTAKE_CASE" | sed -nE 's/^operator PR #[0-9]+ on [^ ]+ — (.*)$/\1/p')"
    # And the backoff watches it as it watches a coder's shepherd PR: a medic
    # iteration that ends leaving the PR exactly as it found it would otherwise
    # be handed the same PR — still red, still carrying its claim — at once,
    # and go round for as long as the night lasts.
    SHEPHERD_PR="${SHEPHERD_PR:-$RALPH_INTAKE_PR}"
  fi
  export RALPH_INTAKE_PR RALPH_INTAKE_REASON
  # Which session this iteration runs (felipearos/ralph#499). Every iteration
  # is the role's own unless a clerk's gate handed it a code-context case: then
  # it runs the code-context prompt on the code-context model, under the same
  # rails. Reset here every time, so one such case never leaks its model into
  # the report batch after it. A case that arrives while code context is off
  # for the run (its prompt or model could not be had at startup) runs as the
  # role's own, and says so.
  ITERATION_KIND=""
  ITERATION_MODEL="$RALPH_MODEL_ORCHESTRATOR"
  ITERATION_ROLE_PROMPT="$RALPH_PROMPT"
  ITERATION_RECOVERY_PROMPT=""
  RALPH_CLAUDE_MODEL_ARGS=("${RALPH_CLAUDE_ROLE_ARGS[@]}")
  if [ "$RALPH_LOOP_ROLE" = clerk ] && [[ "$INTAKE_CASE" =~ $RALPH_CODE_CONTEXT_CASE ]]; then
    if [ -n "$RALPH_CODE_CONTEXT_PROMPT" ]; then
      ITERATION_KIND="code context ${BASH_REMATCH[1]}"
      ITERATION_MODEL="$RALPH_MODEL_CODE_CONTEXT"
      ITERATION_ROLE_PROMPT="$RALPH_CODE_CONTEXT_PROMPT"
      ITERATION_RECOVERY_PROMPT="Your previous Ralph turn ended without a control sigil. This is the only recovery turn. You read the code behind one filed ticket and write one result file; you never write to Jira or Slack, change no code and leave the worktree clean. If the result file is not written yet, write it now from what you have read, saying plainly what you could not verify. End with exactly one valid Ralph sigil on its own final line: <ralph>DONE</ralph> once the result file is written, or <ralph>ALL_BLOCKED</ralph> if no code-context case was waiting."
      RALPH_CLAUDE_MODEL_ARGS=("${RALPH_CLAUDE_CODE_CONTEXT_ARGS[@]}")
    else
      say "${LOOP_DISPLAY}: the gate handed a code-context case (${INTAKE_CASE}), but code context is off for this run; running it as a clerk iteration."
    fi
  fi
  SHEPHERD_BEFORE=""
  if [ -n "$SHEPHERD_PR" ]; then
    SHEPHERD_BEFORE="$(bun "${RALPH_HOME}/backoff.ts" fingerprint "$SHEPHERD_PR" 2>/dev/null || true)"
  fi

  i=$((i + 1))
  ts="$(date +%Y%m%dT%H%M%S)"
  log=".ralph/logs/iter-${ts}.log"
  events=".ralph/logs/iter-${ts}-$$-${i}.events.jsonl"
  final=".ralph/logs/iter-${ts}-$$.final.txt"
  signals=".ralph/logs/signals-orchestrator-${ts}-$$.jsonl"
  export RALPH_SESSION_ID="$(uuidgen)"
  # Every session this iteration runs, for `usage.py`'s iteration scope: a
  # wait on a PR or a budget stop continues the iteration in a new session.
  export RALPH_ITERATION_SESSIONS="$RALPH_SESSION_ID"
  # Exported rather than passed, because the thing that needs it is not this
  # script: `delegate.sh` and `inspect.sh` are started by the ITERATION, and
  # without this an executor failure is attributable to the run but not to the
  # attempt inside it — which is the difference between "this run has been
  # failing" and "this run started failing at iteration 7".
  export RALPH_ITERATION="$i"
  export RALPH_TIMELINE="$events"
  say "=== ${LOOP_DISPLAY} iteration ${i}/${MAX} (${ts}) session ${RALPH_SESSION_ID} ==="
  # The durable boundary heartbeat. Inside the turn, the rendered iteration
  # log and structured events now move with every Claude content block.
  # Every iteration starts in `select`, unless it resumes an interrupted
  # ticket at a later phase (`phase_resume`); each boundary it yields at moves
  # it on. The record says which, and on a fallback why.
  # A role with phases off (`roles.ts`) has no boundaries to yield at, so it
  # never enters `phase_resume`, never writes a ledger, and reports no phase:
  # a triager's iteration is one pass over the tracker, and a ledger recording
  # `select` for it would describe a mechanism that never ran.
  ITERATION_PHASE=""
  ITERATION_TICKET=""
  # Seconds this iteration spent waiting with no model turn (a PR wait, the
  # host lease), which the speed ledger subtracts from its active time.
  ITERATION_WAITED=0
  PHASE_YIELDS=0
  AWAIT_PR_REFUSED=0
  PHASE_RETRY=""
  # The closed-ticket wrap-up (#809): at most one per iteration, and the
  # ticket whose lease is released once the iteration settles.
  PHASE_CLOSED_WRAPUP=""
  PHASE_CLOSED_TICKET=""
  # Cleared here rather than only in `phase_resume`, which a phaseless role
  # never calls: everything below reads them, and `set -u` would stop the run
  # on the first triager iteration.
  RESUME_PHASE=""
  RESUME_AFTER=""
  RESUME_PROMPT=""
  RESUME_WHY=""
  if [ "$RALPH_ROLE_PHASES" = 1 ]; then
    ITERATION_PHASE=select
    phase_resume
  fi
  ITERATION_PROMPT="$ITERATION_ROLE_PROMPT"
  start_detail="session ${RALPH_SESSION_ID}"
  if [ -n "$ITERATION_KIND" ]; then
    say "${LOOP_DISPLAY}: iteration ${i} is ${ITERATION_KIND} — ${RALPH_CODE_CONTEXT_TEMPLATE} on ${ITERATION_MODEL}${RALPH_MODEL_CODE_CONTEXT_EFFORT:+ (effort ${RALPH_MODEL_CODE_CONTEXT_EFFORT})}."
    start_detail="${start_detail}; ${ITERATION_KIND} on ${ITERATION_MODEL}"
  fi
  if [ -n "$RESUME_PHASE" ]; then
    ITERATION_PHASE="$RESUME_PHASE"
    ITERATION_PROMPT="$RESUME_PROMPT"
    say "${LOOP_DISPLAY}: iteration ${i} resumes #${ITERATION_TICKET} at ${RESUME_PHASE} in a fresh session — ${RESUME_WHY}."
    start_detail="${start_detail}; resuming #${ITERATION_TICKET} at ${RESUME_PHASE} — ${RESUME_WHY}"
  elif [ -n "$RESUME_WHY" ]; then
    start_detail="${start_detail}; #${ITERATION_TICKET} not resumed from its ledger — ${RESUME_WHY}"
  fi
  record --event iteration-start --stage iteration --iteration "$i" --max "$MAX" \
    ${ITERATION_PHASE:+--phase "$ITERATION_PHASE"} \
    ${RESUME_PHASE:+--resumed-at "$RESUME_PHASE"} --detail "$start_detail"
  speed_record iteration-start ${ITERATION_TICKET:+--ticket "$ITERATION_TICKET"}

  # STDERR IS CAPTURED SEPARATELY, and that is the whole point of this shape.
  #
  # This used to be `2>&1 | tee "$log"`, which put the runner's diagnostics and
  # the model's own prose into one file — and then handed that file to the
  # classifier. A turn whose output discussed a permission denial was recorded
  # as one. There is no pattern list that can separate the two after the fact,
  # so they are kept apart HERE, where the streams still are: stdout is the
  # structured event stream, stderr is the only free text classified.
  #
  # THREE THINGS ABOUT THE SHAPE, each of them a bug that was here first:
  #
  # 1. Every redactor runs under `"${RALPH_SECRETS_CMD[@]}" "${RALPH_ENV_FILTER[@]}"`,
  #    exactly as the iteration does. `doppler run --` scopes the command it
  #    wraps and NOT its pipeline siblings, so a redactor on the right of the
  #    pipe inherits this supervisor's own environment — which holds none of
  #    the injected secrets. It was therefore striking credential SHAPES and no
  #    values at all: no DATABASE_URL, no SUPABASE_SERVICE_ROLE_KEY, on the
  #    largest file the loop writes. Filtered the same way as the iteration on
  #    purpose, so the redactor knows exactly the values the iteration could
  #    have leaked, and no more.
  #
  # 2. Stderr is redacted ON THE WAY IN rather than written cleartext and
  #    scrubbed afterwards. A turn holds for tens of minutes; an in-place pass
  #    at the end left the one stream chosen for carrying auth failures and API
  #    error bodies sitting unscrubbed on disk for all of it, and permanently
  #    if the supervisor was killed mid-turn.
  #
  #    NOTHING HERE MAY BLOCK. A first attempt used a FIFO and `wait`, and it
  #    could hang the supervisor two ways: `exec 4> fifo` blocks forever if no
  #    reader ever opens it, and — the one that would actually have happened —
  #    an `exec` fd is inherited by `claude` and by everything it spawns, so a
  #    single orphaned grandchild keeps a write end open and the reader never
  #    reaches EOF. `wait` on that never returns, past the last `record`, with
  #    the heartbeats still pulsing a loop that is dead. For a supervisor meant
  #    to be left running overnight that is the worst outcome in this file, and
  #    it is worse than every problem the capture solves.
  #
  #    So: a process substitution, whose fd goes to this one command instead of
  #    into the shell; and a BOUNDED wait on a marker the filter writes as its
  #    last act, instead of `wait`. If the marker never comes, the loop carries
  #    on with however much the filter had written — which is redacted either
  #    way, because it writes nothing it has not scrubbed.
  #
  #    THE SUBSTITUTION MUST STAY ONE COMMAND. Bash waits for a COMPOUND
  #    process substitution when the command it decorates is in a pipeline, so
  #    writing the marker with `; : > "$errdone"` put the unbounded block
  #    straight back — measured at 6s against an orphan holding stderr for 6s,
  #    against 0s for a single command. That is why the marker is `--done`,
  #    written by the filter itself, rather than a second command here.
  #
  # 3. Stderr is NOT appended to "$log". The record points at the error
  #    capture instead, while sigil control reads the final-only channel.
  #
  # Stdout is stream-json. `stream-render.py` is the only process allowed to
  # turn those bytes into files: it redacts each event before persisting it,
  # renders thinking/text/tool activity live to the human log, and writes only
  # `result.result` to "$final". The split is control flow, not presentation:
  # thinking may discuss every sigil literal and must never decide the loop.
  #
  # The pid is in these names for the reason it is in `RALPH_RUN_ID`: `ts` is
  # whole seconds, and two supervisors started in the same second in one
  # worktree — which `ralph.test.ts` drives deliberately — would otherwise
  # share this file and truncate each other's.
  #
  # The pipeline itself is `orchestrator_turn`, above, so every session of the
  # iteration — this one, a sigil recovery, one resumed after a PR wait, a
  # budget handoff — runs through this one shape.
  errlog=".ralph/logs/iter-${ts}-$$.err"
  budget_marker=".ralph/logs/budget-${ts}-$$-${i}.json"
  wait_history=".ralph/logs/pr-wait-${ts}-$$-${i}.jsonl"
  rm -f "$budget_marker"
  PR_WAIT_ROUND=0
  HOST_REQUESTS=0
  budget_handled=""
  : > "$log"
  # A resumed iteration enters its phase across that phase's boundary
  # (`phase_resume`): 0 runs the resumed session, 2 has already run the
  # finished phase again in `phase_retry`, and 1 — a stop, or a gate denied —
  # runs no turn at all, and the iteration ends below with the claim kept.
  resume_entry=0
  if [ -n "$RESUME_PHASE" ]; then
    CONTROL_RETRY_PHASE=""
    phase_checkpoint "$RESUME_AFTER" "$RESUME_PHASE" "$ITERATION_TICKET" || resume_entry=$?
    if [ "$resume_entry" -eq 2 ]; then
      phase_retry "$CONTROL_RETRY_PHASE" "$RESUME_PHASE" "$ITERATION_TICKET" || resume_entry=0
    fi
  fi
  if [ "$resume_entry" -eq 1 ]; then
    : > "$final"
    say "${LOOP_DISPLAY}: iteration ${i} stopped before ${RESUME_PHASE} on #${ITERATION_TICKET} — the claim is kept for the next run."
  elif [ "$resume_entry" -eq 0 ]; then
    # An iteration secret read now reaches this iteration rather than the next
    # one's (#759); rate-limited inside, like the gate's.
    reread_role_secrets iteration
    orchestrator_turn "$ITERATION_PROMPT" "$final" "$signals" "$errlog" \
      "$RALPH_ITERATION_TOKEN_CAP" "" --session-id "$RALPH_SESSION_ID"
    [ -s "$errlog" ] && say "${LOOP_DISPLAY}: iteration ${i} stderr: ${errlog}"
    # The renderer timestamps denials and rate-limit events as they pass, so the
    # existing observation can distinguish a live refusal from a final flush.
    # `--log` remains a pointer; prose in it is never classified.
    observe_orchestrator --exit "$ITER_STATUS" --log "$log" --errors "$errlog" --signals "$signals"
    recover_missing_sigil
  fi

  # What the iteration's sessions asked for next: the cap's handoff first,
  # because a stopped session's sigil is not an answer; then the supervisor's
  # wait on a PR, as often as the sessions ask and the rounds allow; then a
  # phase boundary, which resumes the same session. The order IS the
  # precedence (`sessionSignal` in `ralph/phase.ts` states it once): a stop
  # sigil ends it, AWAIT_PR outranks PHASE, and anything else — a malformed
  # PHASE included — falls to the checks below.
  while :; do
    if [ -f "$budget_marker" ]; then
      [ -n "$budget_handled" ] && break
      budget_handled=1
      budget_handoff
      continue
    fi
    has_sigil "$STOP_SIGILS" "$final" && break
    if has_sigil "$HOST_SIGIL" "$final"; then
      await_host || break
      continue
    fi
    if has_sigil "$AWAIT_SIGIL" "$final"; then
      await_pr || break
      continue
    fi
    has_sigil "$PHASE_SIGIL" "$final" || break
    phase_boundary || break
  done

  # Recovery is part of this iteration, not the event after it. Close usage
  # and the durable (and mirrored) attempt only after its optional resumed turn so the
  # same timeline, token checkpoint, and heartbeat cover the whole attempt.
  # Before the iteration is recorded as ended: the invariant is part of the
  # attempt, and a restore that happened after it would read as the next one's.
  role_invariant
  "${RALPH_HOME}/usage.py" --step "iteration ${i} end" 2>&1 | tee -a "$log" | sed 's/^/usage: /'
  record --event iteration-end --stage iteration --iteration "$i" --max "$MAX" --detail "$log"
  speed_record iteration-end ${ITERATION_TICKET:+--ticket "$ITERATION_TICKET"} \
    --outcome "$(last_sigil_name "$final")" --waited "$ITERATION_WAITED"

  # Stopped at a phase boundary: the iteration is closed, and so is the run.
  # Acted on here rather than at the next checkpoint, so a control channel
  # that cannot answer a second time cannot turn a stop already carried out
  # into another iteration. Nothing is released: the claim, the branch, the
  # handoff note and the ledger are what a later run resumes from.
  if [ -n "$CONTROL_STOP_PHASE" ]; then
    say "${LOOP_DISPLAY}: stopped by an operator before ${CONTROL_STOP_PHASE} — ${CONTROL_STOP_WHY}"
    record --event control-stop --stop "$CONTROL_STOP_KIND" --phase "$CONTROL_STOP_PHASE" \
      --why "stopped before ${CONTROL_STOP_PHASE}: ${CONTROL_STOP_WHY}"
    [ "$CONTROL_STOP_KIND" = "failed" ] && exit 1
    exit 0
  fi

  # Rejected by the account's usage limit — the main turn, its recovery, or
  # whichever session ran last (a PR wait's, a phase resume's, the token cap's
  # handoff), whose events are the last in the file. The cap's marker does not
  # exempt it: a handoff the limit rejected is the same wait. Before the backoff settle, so a
  # limit neither strikes nor resets a backoff, and before anything that could
  # clear the phase ledger: the claim, the branch and the ledger are kept, and
  # the top of the loop waits out the reset. Not counted against the cap:
  # ~15 loops share one limit and hit it nightly, and a night of waits would
  # otherwise retire a loop that never failed.
  if ! any_sigil "$final" && usage_limited; then
    say "${LOOP_DISPLAY}: iteration ${i} hit the account's usage limit — ${USAGE_WAIT_SAID}; the claim is kept."
    record --event usage-wait --stage gate --detail "$USAGE_WAIT_SAID"
    # No settle runs for this iteration, so its blocker goes here: the retry
    # names its own or none. Its park hand-off likewise (#776).
    rm -f .ralph/logs/retry-blocker.json .ralph/logs/block-park.json
    # A closed ticket's wrap-up cut off by the limit is not resumed — `claimed`
    # lists open issues only — so its lease goes now, not with a settle that
    # never runs.
    release_closed_ticket
    i=$((i - 1))
    continue
  fi

  # How this iteration ended, for the backoff: RETRY_LATER, a DONE (a strike
  # only if it left its shepherd PR untouched), or anything else, which resets
  # it. A fault outranks RETRY_LATER here as it does below.
  if stop_sigil_seen NEEDS_TRIAGE "$final"; then settled_as=other
  elif stop_sigil_seen RETRY_LATER "$final"; then settled_as=retry-later
  elif stop_sigil_seen DONE "$final"; then settled_as=done
  else settled_as=other
  fi
  # Only asked when there is something to decide: frontier work with no
  # backoff pending would come back "no backoff" every time.
  if [ "$settled_as" = retry-later ] || [ -n "$SHEPHERD_PR" ] || [ -f .ralph/logs/backoff.json ]; then
    bun "${RALPH_HOME}/backoff.ts" settle --sigil "$settled_as" \
      ${SHEPHERD_PR:+--pr "$SHEPHERD_PR"} ${SHEPHERD_BEFORE:+--before "$SHEPHERD_BEFORE"} \
      --blocker-file .ralph/logs/retry-blocker.json \
      2>/dev/null | tee -a "$SUPERVISOR_LOG"
  fi
  # Whether or not it settled: one iteration's blocker must never be read as
  # the next one's. The usage-limit branch above drops it before its continue.
  # A park hand-off `tracker.ts blocked` never read is dropped the same way.
  rm -f .ralph/logs/retry-blocker.json .ralph/logs/block-park.json
  # DONE finishes the ticket's iteration, so its phases are over: the ledger
  # and the notes go, and a later claim of the same ticket starts from the top.
  if [ "$settled_as" = done ] && [ -n "$ITERATION_TICKET" ] && [ "$RALPH_ROLE_PHASES" = 1 ]; then
    bun "${RALPH_HOME}/phase.ts" clear --ticket "$ITERATION_TICKET" >/dev/null 2>> "$SUPERVISOR_LOG" || true
  fi
  release_closed_ticket

  # Checked FIRST, because these greps are unanchored substring matches and so
  # the order IS the precedence: a log that somehow carries two sigils resolves
  # to whichever is tested earliest. A fault has to win that tie — reading it
  # as COMPLETE would retire a loop that never reached the backlog.
  #
  # An infrastructure fault the iteration could not route around: it never got
  # as far as having work. Terminal in BOTH modes, unlike the stop sigils
  # below. Waiting would re-run the same broken environment on a timer, and
  # DONE would look like progress and spin at full speed until the cap.
  if stop_sigil_seen NEEDS_TRIAGE "$final"; then
    say "${LOOP_DISPLAY}: iteration ${i} could not reach the backlog — halting for repair."
    say "       See ${log} and the journal entry for what failed."
    record --event needs-triage --stop failed --detail "$log" \
      --why "iteration ${i} could not reach the backlog; see ${log}"
    say "       $(bun "${RALPH_HOME}/runner-failure.ts" status --line 2>/dev/null || echo 'runner failures: unavailable')"
    exit 1
  fi

  # Blocked on something external that time will clear: not a fault, and not
  # "nothing to do" either. The settle above armed the backoff, and the top of
  # the loop waits it out before the next gate — in both modes, because the
  # point is a loop that survives an outage unattended.
  if [ "$settled_as" = retry-later ]; then
    BLOCKED_STREAK=0
    continue
  fi

  # Both stop sigils mean "nothing right now", which is terminal for an ungated
  # supervisor and a wait for a gated one. Returns 0 to keep looping.
  if stop_sigil_seen COMPLETE "$final"; then
    wait_or_stop \
      "backlog drained after ${i} iteration(s)." \
      "backlog drained after ${i} iteration(s) — waiting for new work." \
      completed || exit 0
    continue
  fi
  if stop_sigil_seen ALL_BLOCKED "$final"; then
    wait_or_stop \
      "everything remaining is blocked; needs human triage." \
      "everything remaining is blocked — waiting for the frontier to widen." \
      blocked || exit 0
    continue
  fi
  # Past both stop sigils, so this iteration did work: the streak is over.
  # Before the missing-sigil check rather than after, because that check exits
  # and the reset would never run — and a death is not a disagreement.
  BLOCKED_STREAK=0
  # Work flowed, so whatever verdict the gate held on is stale (#771). Not at
  # the retry-later reset above: a usage or rate-limit wait says nothing about
  # the frontier.
  if [ -n "$RALPH_WAIT_FOR_WORK" ] && [ "${RALPH_ROLE_GATE_HOLDS:-0}" = 1 ]; then
    gate_verdict clear >/dev/null \
      || say "${LOOP_DISPLAY}: the gate verdict record could not be cleared; see the supervisor log."
  fi
  # Still waiting on a PR when the iteration ran out of waits (or could not
  # build the next session's prompt) is a handoff, not a death: the claim is in
  # place and the next iteration resumes the PR under §1 priority 1.
  if ! stop_sigil_seen DONE "$final" && has_sigil "$AWAIT_SIGIL" "$final"; then
    say "${LOOP_DISPLAY}: iteration ${i} ended still waiting on a PR — the next iteration resumes it."
    continue
  fi
  # Likewise a session that kept asking for the host after its refusal: the
  # claim is in place, and the next iteration's request meets the same limits.
  if ! stop_sigil_seen DONE "$final" && has_sigil "$HOST_SIGIL" "$final"; then
    say "${LOOP_DISPLAY}: iteration ${i} ended still asking for the host — the next iteration resumes it."
    continue
  fi
  # Likewise a session that ended at a phase boundary nobody resumed — out of
  # yields, held at the checkpoint, or a budget handoff that yielded anyway.
  # The branch, the notes and the ledger are on disk and the claim is in place.
  # Not so for a ticket closed outside the loop (#809): nothing resumes it.
  if ! stop_sigil_seen DONE "$final" && has_sigil "$PHASE_SIGIL" "$final"; then
    if [ -n "$PHASE_CLOSED_TICKET" ]; then
      say "${LOOP_DISPLAY}: iteration ${i} ended at a phase boundary after wrapping up closed #${PHASE_CLOSED_TICKET}."
    else
      say "${LOOP_DISPLAY}: iteration ${i} ended at a phase boundary — the next iteration resumes it."
    fi
    continue
  fi
  if ! stop_sigil_seen DONE "$final"; then
    # Still fatal in either mode. A missing sigil means the iteration died for
    # an unknown reason, and a supervisor that shrugged that off and waited
    # would restart the same failure until it hit the cap.
    # A spent usage limit is its own event, so a reader can tell it from a
    # lost sigil without parsing the sentence: the notifier pushes it as a
    # rate limit, and a restart must not run against a limit that has not
    # lifted (the reconcile retry #414 asks for reads the event name).
    if limit="$(usage_limit_reason "$log")"; then
      say "${LOOP_DISPLAY}: iteration ${i} ${limit} — stopping; restart the loop after the reset."
      record --event usage-limit-stop --stop failed --detail "$log" \
        --why "iteration ${i} ${limit}; restart the loop after the reset. See ${log}"
    else
      say "${LOOP_DISPLAY}: iteration ${i} and its recovery ended without a sigil — stopping for safety."
      record --event no-sigil --stop failed --detail "$log" \
        --why "iteration ${i} and its recovery ended without a sigil; see ${log}"
    fi
    # The one place this is worth saying out loud: a missing sigil is the
    # supervisor admitting it does not know why the turn ended, and the
    # observation above is the only thing in the run that might.
    say "       $(bun "${RALPH_HOME}/runner-failure.ts" status --line 2>/dev/null || echo 'runner failures: unavailable')"
    exit 1
  fi
done

say "${LOOP_DISPLAY}: iteration cap (${MAX}) reached."
record --event cap-reached --stop completed --why "iteration cap (${MAX}) reached"
