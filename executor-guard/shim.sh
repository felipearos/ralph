#!/usr/bin/env bash
# The executor's package runners, each asked about before it runs.
#
# Every name in `bin/` is a symlink to this file and sits first on the
# executor's PATH, so `bun run test` typed by the executor — directly, through
# `bash -lc`, or from inside a package script — lands here first. The verdict
# is guard.ts's; this file only finds the real binary behind itself, asks, and
# either refuses or `exec`s it with the arguments untouched.
#
# The real binary is whatever PATH names once this directory is taken out of
# it. The PATH handed on is the original one, so a script the real `bun` runs
# is guarded in turn: `bun run test src/a.test.ts` is allowed, and the `bun x
# vitest run src/a.test.ts` it expands to is judged again on the way through.
#
# A guard that cannot give a verdict (no bun, an unreadable package.json) lets
# the command through with a warning rather than taking the executor's whole
# toolchain down with it. Refusing is for commands, not for its own bugs.
set -uo pipefail

name="${0##*/}"
bin_dir="$(cd "$(dirname "$0")" && pwd -P)"
guard="$(dirname "$bin_dir")/guard.ts"

real_path=""
IFS=: read -ra entries <<< "${PATH:-}"
for entry in "${entries[@]}"; do
  [ -n "$entry" ] || continue
  [ "$(cd "$entry" 2>/dev/null && pwd -P)" = "$bin_dir" ] && continue
  real_path="${real_path:+${real_path}:}${entry}"
done

real="$(PATH="$real_path" command -v "$name" 2>/dev/null || true)"
if [ -z "$real" ] && [ "$name" = bunx ]; then
  # `bunx` is `bun x`; a runtime mounted as a single binary has no bunx beside
  # it, and the executor should not lose a spelling the brief may well use.
  real="$(PATH="$real_path" command -v bun 2>/dev/null || true)"
  if [ -n "$real" ]; then
    name=bun
    set -- x "$@"
  fi
fi
if [ -z "$real" ]; then
  echo "${0##*/}: command not found" >&2
  exit 127
fi

guard_bun="$(PATH="$real_path" command -v bun 2>/dev/null || true)"
if [ -n "$guard_bun" ]; then
  # Run from the guard's own directory so the project's bunfig.toml (preloads
  # and all) does not run on every check; the project's cwd travels as a flag.
  cwd="$PWD"
  (cd "$(dirname "$guard")" && PATH="$real_path" "$guard_bun" "$guard" check --cwd "$cwd" "$name" "$@")
  status=$?
  case "$status" in
    0) ;;
    10) exit 126 ;;
    *) echo "ralph executor guard failed (exit ${status}); running \`${name}\` unchecked." >&2 ;;
  esac
else
  echo "ralph executor guard failed (no bun to run it); running \`${name}\` unchecked." >&2
fi

exec "$real" "$@"
