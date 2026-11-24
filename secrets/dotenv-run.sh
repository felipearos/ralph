#!/usr/bin/env bash
# bash secrets/dotenv-run.sh <file> -- <cmd> [args…]
#
# Runs <cmd> with the variables of the dotenv file <file> exported — the
# dotenv runner's `doppler run` (felipearos/software-factory#49). As with
# `doppler run`, a variable from the file overrides one already set.
#
# The parse is `bun secrets/dotenv.ts export`, so bash and the SecretSource
# read the file the same way. When it fails (missing 3, unreadable 4,
# malformed 5) this exits with its status, its one stderr line already out,
# and runs nothing: a command started without its secrets fails later and
# less legibly.
#
# A value never reaches the argv of any process (no `env KEY=value`), is never
# echoed, and is never traced.
set +x
set -uo pipefail

usage() {
  echo "usage: bash secrets/dotenv-run.sh <file> -- <cmd> [args...]" >&2
  exit 2
}

[[ $# -ge 3 && -n "$1" && "$2" == "--" ]] || usage
file=$1
shift 2

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# A process substitution's exit status is otherwise lost, so the exporter's
# own status rides in as two trailing records: an empty one, then the number.
# The empty one keeps a record the exporter left unterminated from merging
# into the status.
records=()
mapfile -d '' records < <(
  bun --no-env-file "$here/dotenv.ts" export "$file"
  printf '\0%d\0' "$?"
)
count=${#records[@]}
if ((count < 2)) || [[ -n "${records[count - 2]}" || ! "${records[count - 1]}" =~ ^[0-9]+$ ]]; then
  echo "dotenv-run: could not read the exporter's output for $file" >&2
  exit 1
fi
status=${records[count - 1]}
if ((status != 0)); then
  exit "$status"
fi

for ((i = 0; i < count - 2; i++)); do
  record=${records[i]}
  key=${record%%=*}
  if [[ "$record" != *=* || ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "dotenv-run: record $((i + 1)) from $file is not KEY=value" >&2
    exit 1
  fi
  # `export` is a builtin: the value goes into this shell's environment
  # without passing through any process's argv.
  export "$key=${record#*=}"
done

exec "$@"
