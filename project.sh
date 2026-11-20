# Sourced — never executed — by every harness entry script, right after it
# has resolved RALPH_HOME from its own location.
#
# The harness lives in one shared checkout (RALPH_HOME, e.g. ~/ralph) and
# works on whichever project worktree it was launched from (RALPH_PROJECT).
# The project is the git toplevel of the launch directory, so a script run from
# `src/` or `mobile/` of a worktree lands on the same root as one run from the
# root itself. The environment may name it instead, which is how a child of the
# supervisor (delegate.sh, inspect.sh) keeps working on the supervisor's
# project whatever directory the iteration happens to be standing in.
#
# Both are resolved physically (`pwd -P`), because the process-table matcher
# compares against `/proc/<pid>/cwd`, which is always fully resolved.
if [ -z "${RALPH_PROJECT:-}" ]; then
  RALPH_PROJECT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$RALPH_PROJECT" ] && [ -d "$RALPH_PROJECT" ] || RALPH_PROJECT="$(pwd -P)"
fi
if ! RALPH_PROJECT="$(cd "$RALPH_PROJECT" 2>/dev/null && pwd -P)"; then
  echo "ralph: RALPH_PROJECT does not name a directory." >&2
  exit 3
fi
export RALPH_HOME RALPH_PROJECT
cd "$RALPH_PROJECT" || exit 3
