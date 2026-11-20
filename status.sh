#!/usr/bin/env bash
# What is Ralph doing right now?
#
# The iteration log is written by `claude -p --output-format text`, which
# buffers the whole turn and flushes at the end — so a 0-byte log means
# "working", not "stuck", and tailing it tells you nothing until it finishes.
# Everything below is state that DOES move while an iteration runs: the
# process table, the claim labels on GitHub, the PR's checks, and the journal.
#
# Usage: ralph/status.sh [-w]    (-w redraws every 30s)
set -uo pipefail
RALPH_HOME="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd -P)"
# shellcheck source=project.sh
. "${RALPH_HOME}/project.sh"

# The repository comes from the project's committed `.ralph/config.json`; a
# panel for a project with no valid config still shows its local state.
if PROJECT_EXPORTS="$(bun "${RALPH_HOME}/project-config.ts" --export 2>/dev/null)"; then
  eval "$PROJECT_EXPORTS"
fi
REPO="${RALPH_PROJECT_REPO:-}"

# The roster is the project's: `loops` in its `.ralph/config.json`, exported
# above as RALPH_PROJECT_LOOPS by the same `project-config.ts` the claim fence
# reads it through. A second copy in this script is how the Claimed panel comes
# to omit a loop: the panel whose entire job is "who has what" is the worst
# place for a roster that silently runs one name short. The fallback keeps a
# panel for a project with no valid config reporting the harness's fallback
# roster rather than an empty panel.
LOOPS="${RALPH_PROJECT_LOOPS:-}"
LOOPS="${LOOPS:-ralph rafa remo rulo}"

# Which loop this worktree is, resolved as `ralph.sh` resolves it — the
# environment first, then `.ralph/loop-name` — so the panel labels the
# supervisor the same way its own logs do. The loops share one tracker: this
# name decides what "mine" means below, and the Claimed panel still shows every
# loop so a glance answers "who has what" rather than only "what do I have".
#
# An unrecognised name is reported as unrecognised rather than printed as
# fact. This is a read-only panel, so unlike `ralph.sh` it does not exit — but
# a worktree whose identity is broken must not be shown a confident name it
# would then trust.
LOOP="${RALPH_LOOP_NAME:-}"
if [ -z "$LOOP" ] && [ -r .ralph/loop-name ]; then
  LOOP="$(tr -d '[:space:]' < .ralph/loop-name 2>/dev/null || true)"
fi
LOOP="${LOOP:-ralph}"
case " $LOOPS " in
  *" $LOOP "*) ;;
  *) LOOP="${LOOP} (UNRECOGNISED — ralph.sh would refuse to start)" ;;
esac

dim() { printf '\033[2m%s\033[0m\n' "$1"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

show() {
  head_ "Loop"
  printf 'loop        %s (this worktree)\n' "$LOOP"
  # The durable record first, because it is the only thing here that survives
  # the supervisor: the process table can say `running` or `not running`, and
  # every other answer an operator needs at 2am — finished, died mid-ticket,
  # parked on a blocked frontier, worktree deleted out from under it — is a
  # distinction only a written record makes. `ralph/loop-state.ts` reconciles
  # it against the process table AND against `git worktree list`, and reports
  # every loop on this machine rather than only this worktree's.
  #
  # Its absence is not an error. Without `bun`, or with the record deleted, the
  # panel below is exactly what this script printed before the record existed —
  # so the fallback is the whole rest of this function, unchanged.
  local state_panel
  state_panel="$(bun "${RALPH_HOME}/loop-state.ts" status 2>/dev/null || true)"
  if [ -n "$state_panel" ]; then
    printf '%s\n' "$state_panel"
  else
    dim "no durable state panel (${RALPH_HOME}/loop-state.ts did not run) — process table only"
  fi
  # Which plugins this loop has on, and whether each is well: one health line,
  # then each enabled plugin's own panel lines indented under it. A plugin is a
  # display of, or a second way into, the record above, so when one is down the
  # panel has to say it is the plugin and not the loop.
  local plugin_line
  plugin_line="$(bun "${RALPH_HOME}/plugins.ts" status --line 2>/dev/null || true)"
  [ -n "$plugin_line" ] && printf '%s\n' "$plugin_line"
  # And what an operator has told it. A loop showing as `blocked` in the panel
  # above is either waiting on the frontier or held by an operator, and those
  # need different people: this line is the only place that says which.
  local control_line
  control_line="$(bun "${RALPH_HOME}/controls.ts" status --line 2>/dev/null || true)"
  [ -n "$control_line" ] && printf '%s\n' "$control_line"
  local sup suplog pid argv
  # Two filters, because `pgrep -f` alone is wrong twice over. It is
  # machine-wide, so with two loops running it reports the OTHER worktree's
  # supervisor as this one's — `ralph.sh` cds to its own worktree root, so that
  # root tells them apart, and unlike reading the pid out of the run id this
  # still works when RALPH_RUN_ID was set by hand. And it matches the whole
  # command line, so any shell running a compound command that merely MENTIONS
  # ralph.sh matches — including, routinely, this script's own parent.
  # `$PWD` is the LOGICAL path bash was invoked through, while `/proc/<pid>/cwd`
  # is always fully resolved. Compared unresolved, a worktree reached through a
  # symlink never matches and every supervisor reads as dead.
  local root
  root="$(readlink -f "$PWD")"
  sup=""
  # Every loop runs the same `$RALPH_HOME/ralph.sh`, so the cwd is the only
  # thing that tells this worktree's supervisor from another's.
  for pid in $(pgrep -f 'ralph\.sh' 2>/dev/null); do
    argv="$(tr '\0' '\n' < "/proc/${pid}/cmdline" 2>/dev/null)"
    # A supervisor is `bash …/ralph/ralph.sh N`. A shell running `-c` is not.
    printf '%s\n' "$argv" | grep -qx -- '-c' && continue
    printf '%s\n' "$argv" | grep -q '\(^\|/\)ralph\.sh$' || continue
    [ "$(readlink -f "/proc/${pid}/cwd" 2>/dev/null)" = "$root" ] || continue
    sup="$pid"
    break
  done
  # One supervisor log per run, and `.ralph/logs/` belongs to this worktree, so
  # the newest one is this loop's most recent run — running or not.
  suplog="$(ls -t .ralph/logs/supervisor-*.log 2>/dev/null | head -1)"
  if [ -n "$sup" ]; then
    printf 'supervisor  running (pid %s, up %s)\n' \
      "$sup" "$(ps -o etime= -p "$sup" | tr -d ' ')"
  else
    printf 'supervisor  NOT running\n'
    dim "start:  ${RALPH_HOME}/start.sh"
    dim "custom: RALPH_WAIT_FOR_WORK=60 RALPH_MAX_ITERATIONS=10 ${RALPH_HOME}/start.sh"
  fi
  # The last line is what separates a gated supervisor waiting for work from a
  # dead one: the gate reprints it on every poll, with a clock in it.
  [ -n "$suplog" ] && tail -1 "$suplog" 2>/dev/null | sed 's/^/last line   /'

  head_ "Iteration"
  local log age size
  log="$(ls -t .ralph/logs/iter-*.log 2>/dev/null | head -1)"
  if [ -z "$log" ]; then
    echo "no iteration has run yet"
  else
    age=$(( $(date +%s) - $(stat -c %Y "$log") ))
    size=$(stat -c %s "$log")
    printf 'log         %s\n' "$log"
    # `$sup` from the Loop panel, not another machine-wide pgrep: with two
    # loops running, that would call this worktree's log "working" because the
    # OTHER loop's supervisor is alive.
    if [ -n "$sup" ]; then
      if [ "$size" -eq 0 ]; then
        printf 'state       working — output is buffered until the turn ends\n'
      else
        printf 'state       finished writing %s bytes %ss ago\n' "$size" "$age"
      fi
    else
      printf 'state       idle (last write %ss ago, %s bytes)\n' "$age" "$size"
      dim "$(tail -3 "$log" 2>/dev/null)"
    fi
  fi

  head_ "Runner failures"
  # The panel above says where the loop got to; this says what refused it on
  # the way. Permission denials and expired credentials are the two that stop a
  # loop overnight while every other signal here still reads as healthy — the
  # supervisor is running, the log is growing, and nothing gets merged.
  #
  # Whole-record rather than this run only: an operator reading this at 2am
  # after a restart wants the denial from the run that died, which scoping to
  # `RALPH_RUN_ID` — unset in this shell anyway — would hide.
  local failures
  failures="$(bun "${RALPH_HOME}/runner-failure.ts" status 2>/dev/null || true)"
  if [ -n "$failures" ]; then
    printf '%s\n' "$failures"
  else
    dim "no runner failure record (${RALPH_HOME}/runner-failure.ts did not run)"
  fi

  head_ "Claimed"
  local claimed n branch pr loop
  # One call per loop. `--label a,b` is an AND — it would return nothing — and
  # the search form that ORs cannot say WHICH label matched, which is the
  # attribution these labels exist to carry.
  claimed=""
  if [ -z "$REPO" ]; then
    dim "no repository — ${RALPH_PROJECT}/.ralph/config.json is missing or invalid, so claims cannot be read"
    LOOPS_FOR_CLAIMS=""
  else
    LOOPS_FOR_CLAIMS="$LOOPS"
  fi
  for loop in $LOOPS_FOR_CLAIMS; do
    claimed="${claimed}$(gh issue list --repo "$REPO" --label "${loop}-wip" --state open \
      --limit 20 --json number,title \
      -q ".[] | \"${loop}\t\(.number)\t\(.title)\"" 2>/dev/null)
"
  done
  claimed="$(printf '%s' "$claimed" | grep -v '^$')"
  if [ -z "$REPO" ]; then
    :
  elif [ -z "$claimed" ]; then
    echo "nothing claimed — the next iteration picks fresh work"
  else
    while IFS=$'\t' read -r loop n title; do
      printf '%-6s #%-5s %s\n' "$loop" "$n" "$title"
      # The branch prefix is the claiming loop's, not this worktree's: the
      # panel is reporting on somebody else's ticket half the time.
      branch="$(git for-each-ref --format='%(refname:short)' \
        "refs/heads/${loop}/${n}-*" | head -1)"
      [ -z "$branch" ] && { dim "      no branch yet"; continue; }
      # `.[0] | "\(.number)"` on an empty list prints the string "null null",
      # which reads as a PR named #null; select the object away instead.
      pr="$(gh pr list --repo "$REPO" --state all --limit 5 --head "$branch" \
        --json number,state \
        -q '.[0] | select(. != null) | "\(.number) \(.state)"' 2>/dev/null)"
      if [ -z "$pr" ]; then
        dim "      branch ${branch}, no PR yet"
      else
        dim "      branch ${branch} → PR #${pr}"
        gh pr checks "${pr%% *}" --repo "$REPO" 2>/dev/null |
          awk -F'\t' '{printf "      %-28s %s\n", $1, $2}'
      fi
    done <<<"$claimed"
  fi

  head_ "Token usage"
  if [ -s .ralph/logs/usage-ledger.tsv ]; then
    awk -F'\t' 'NR>1 {
        steps[$1 SUBSEP $2 SUBSEP $3] = 1; last = $1
        tin[$1] += $7 + $9 + $10 + $11; tout[$1] += $8
        read[$1] += $11; write5[$1] += $9; write1h[$1] += $10
      }
      END {
        n = 0; for (k in steps) { split(k, p, SUBSEP); if (p[1] == last) n++ }
        printf "run %-22s %.1fk in / %.1fk out  (%d steps; cache %.1fk read, %.1fk 5m, %.1fk 1h)\n",
          last, tin[last] / 1000, tout[last] / 1000, n,
          read[last] / 1000, write5[last] / 1000, write1h[last] / 1000
      }' .ralph/logs/usage-ledger.tsv
    tail -n +2 .ralph/logs/usage-ledger.tsv | tail -3 |
      awk -F'\t' '{printf "  %-28s %.1fk in / %.1fk out  %s\n", substr($5, 1, 28), ($7 + $9 + $10 + $11) / 1000, $8 / 1000, $6}'
  else
    dim "no usage ledger yet — ${RALPH_HOME}/usage.py writes it once an iteration runs"
  fi

  head_ "Journal"
  # One file per iteration, timestamp-first, so plain filename order is
  # chronological and the last three are the three most recent. Every loop
  # publishes into the HARNESS repository (publish-journal.ts pushes to its
  # main), under the project's `journal.dir` — unless the project names a
  # `journal.branch`, which moves it onto that branch of the project's own
  # repository — so the panel reads whichever origin ref that is.
  local entries body journal_dir journal_repo journal_branch
  journal_dir="${RALPH_JOURNAL_DIR:-}"
  journal_dir="${journal_dir%/}"
  if [ -z "$journal_dir" ]; then
    dim "no journal directory — ${RALPH_PROJECT}/.ralph/config.json is missing or invalid"
    echo
    return
  fi
  journal_branch="${RALPH_JOURNAL_BRANCH:-}"
  journal_repo="$RALPH_HOME"
  if [ -n "$journal_branch" ]; then
    journal_repo="$RALPH_PROJECT"
  else
    journal_branch=main
  fi
  # Bound the fetch: with no network this panel should go stale, not hang the
  # whole redraw. A failed fetch still leaves the previous ref readable.
  GIT_TERMINAL_PROMPT=0 timeout 10 git -C "$journal_repo" fetch --quiet origin \
    "+refs/heads/${journal_branch}:refs/remotes/origin/${journal_branch}" 2>/dev/null
  entries="$(git -C "$journal_repo" ls-tree --name-only "origin/${journal_branch}" "${journal_dir}/" 2>/dev/null |
    grep -E '/20' | sort | tail -3)"
  if [ -z "$entries" ]; then
    dim "no journal entries yet — ${journal_dir}/ on origin/${journal_branch} fills as iterations finish"
  else
    while read -r e; do
      printf '%s\n' "$(basename "$e")"
      # Heading and outcome are separate greps on purpose: one -m1 with an
      # alternation stops at the heading and never prints the outcome.
      body="$(git -C "$journal_repo" show "origin/${journal_branch}:$e" 2>/dev/null)"
      dim "  $(printf '%s' "$body" | grep -m1 '^#' | cut -c1-140)"
      dim "  $(printf '%s' "$body" | grep -m1 '^\*\*Outcome' | cut -c1-140)"
    done <<<"$entries"
  fi
  echo
}

if [ "${1:-}" = "-w" ]; then
  while true; do clear; show; dim "redrawing every 30s — ctrl-c to stop"; sleep 30; done
else
  show
fi
