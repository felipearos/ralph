#!/usr/bin/env bash
set -euo pipefail

# Validate the exact environment received by this child, including recovery and
# redactors, with the PROJECT's own check (`envCheck` in .ralph/config.json),
# run inside the project. The harness does not know what a safe target looks
# like for a given project; the project does, and commits the check. The check
# must not load local dotenv files while deciding which target is safe (Loggd's
# runs under `bun --no-env-file`).
#
# RALPH_ENV_CHECK is exported by ralph.sh from the config as quoted shell
# words. Unset is refused rather than skipped: a child that lost the variable
# on the way here must not run unchecked. Set-but-empty is the config saying
# "no check".
if [ -z "${RALPH_ENV_CHECK+set}" ]; then
  echo "development-env: RALPH_ENV_CHECK is not set; refusing to run a child unchecked." >&2
  exit 1
fi
eval "check=(${RALPH_ENV_CHECK})"
if [ "${#check[@]}" -gt 0 ]; then
  (cd "${RALPH_PROJECT:-.}" && "${check[@]}")
fi
exec "$@"
