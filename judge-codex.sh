#!/usr/bin/env bash
# judge-codex.sh <model> <answer-file> — one blind Codex judge call (#801).
#
# The prompt arrives on stdin and the model's last message is written to
# <answer-file>. A judge must not learn which diff is the human's or which
# lineup wrote the others, and Codex cannot be run without a shell: its own
# read-only sandbox blocks writes but not reads. So, as `inspect.sh` does for a
# codex stage, the whole process runs in bubblewrap with an EMPTY working
# directory, an in-memory Codex home holding only auth.json, and the system
# files it needs. The scoring clone, the run directory and the user's HOME are
# not mounted, so no command it runs can read them.
#
# Exit status: 0 with the answer written; 2 when the sandbox cannot be built
# (no codex, no bwrap, no auth); anything else is Codex's own.
set -euo pipefail

MODEL="${1:?usage: judge-codex.sh <model> <answer-file>}"
ANSWER="${2:?usage: judge-codex.sh <model> <answer-file>}"

if ! CODEX_BIN="$(command -v "${RALPH_CODEX_BIN:-codex}")"; then
  echo "judge-codex: codex not on PATH" >&2
  exit 2
fi
if ! command -v bwrap >/dev/null; then
  echo "judge-codex: bubblewrap not on PATH; refusing a judge that could read the scoring clone" >&2
  exit 2
fi
CODEX_BIN_REAL="$(readlink -f "$CODEX_BIN")"
HOST_CODEX_HOME="$(readlink -f "${CODEX_HOME:-${HOME}/.codex}")"
if [ ! -f "${HOST_CODEX_HOME}/auth.json" ]; then
  echo "judge-codex: ${HOST_CODEX_HOME} has no auth.json to mount" >&2
  exit 2
fi

# npm installs Codex as a JavaScript launcher beside its platform package:
# mount node_modules so Node finds both. A native binary needs only its dir.
case "$CODEX_BIN_REAL" in
  */node_modules/@openai/codex/bin/codex.js)
    LAUNCHER_ROOT="${CODEX_BIN_REAL%/@openai/codex/bin/codex.js}"
    LAUNCHER_MOUNT="/ralph-codex/node_modules"
    SANDBOX_BIN="${LAUNCHER_MOUNT}/@openai/codex/bin/codex.js"
    ;;
  *)
    LAUNCHER_ROOT="$(dirname "$CODEX_BIN_REAL")"
    LAUNCHER_MOUNT="/ralph-codex/bin"
    SANDBOX_BIN="${LAUNCHER_MOUNT}/$(basename "$CODEX_BIN_REAL")"
    ;;
esac

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

BWRAP_ARGS=(
  --die-with-parent
  --new-session
  --unshare-user --uid 0 --gid 0
  --unshare-pid
  --ro-bind /usr /usr
  --symlink usr/bin /bin
  --symlink usr/lib /lib
  --symlink usr/lib64 /lib64
  --ro-bind /etc /etc
  --proc /proc
  --dev /dev
  --tmpfs /tmp
  --dir /tmp/ralph-home
  --dir /tmp/judge
  --bind "$OUT" /tmp/out
  --tmpfs /codex-home
  --ro-bind "${HOST_CODEX_HOME}/auth.json" /codex-home/auth.json
  --ro-bind "$LAUNCHER_ROOT" "$LAUNCHER_MOUNT"
  --chdir /tmp/judge
  --setenv HOME /tmp/ralph-home
  --setenv CODEX_HOME /codex-home
  --setenv TMPDIR /tmp
  --setenv PATH /usr/local/bin:/usr/bin
)
# Fedora's /etc/resolv.conf points here; mount the one file, not /run.
if [ -e /run/systemd/resolve/stub-resolv.conf ]; then
  BWRAP_ARGS+=(--ro-bind /run/systemd/resolve/stub-resolv.conf /run/systemd/resolve/stub-resolv.conf)
fi

# `-` reads the prompt from stdin: three large diffs do not fit an argument.
bwrap "${BWRAP_ARGS[@]}" "$SANDBOX_BIN" exec \
  --sandbox read-only \
  --ignore-user-config \
  -c 'approval_policy="never"' -c 'web_search="disabled"' \
  -c 'features.multi_agent=false' -c 'features.apps=false' \
  --model "$MODEL" \
  --cd /tmp/judge \
  --skip-git-repo-check \
  --output-last-message /tmp/out/answer.txt \
  - >&2
cp "$OUT/answer.txt" "$ANSWER"
