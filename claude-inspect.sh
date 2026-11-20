#!/usr/bin/env bash
# A Claude inspection hosted by a Codex orchestrator. Only file-reading tools;
# a read-only filesystem view excludes the user's other credential stores.
set -euo pipefail
# usage: claude-inspect.sh <model> [effort] — the stage's lineup, as a
# Claude-hosted run puts it in the named agent's definition.
ROOT="$PWD"
MODEL="$1"
EFFORT="${2:-}"
EFFORT_ARGS=()
[ -z "$EFFORT" ] || EFFORT_ARGS=(--effort "$EFFORT")
CLAUDE_BIN="$(readlink -f "$(command -v claude)")"
CLAUDE_HOME="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"
[ -f "$CLAUDE_HOME/.credentials.json" ] || { echo 'inspect: Claude requires a file credential for isolated inspection' >&2; exit 2; }
ARGS=(--die-with-parent --new-session --unshare-user --uid 0 --gid 0 --unshare-pid
  --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64
  --ro-bind /etc /etc --proc /proc --dev /dev --tmpfs /tmp
  --dir /tmp/ralph-home --tmpfs /claude-home
  --ro-bind "$CLAUDE_HOME/.credentials.json" /claude-home/.credentials.json
  --ro-bind "$ROOT" "$ROOT"
  --ro-bind "$(dirname "$CLAUDE_BIN")" /ralph-claude
  --chdir "$ROOT" --setenv HOME /tmp/ralph-home --setenv CLAUDE_CONFIG_DIR /claude-home
  --setenv PATH /usr/local/bin:/usr/bin --setenv TMPDIR /tmp)
# Keep project env files out of the file-reading tools as well.
while IFS= read -r -d '' env_file; do
  ARGS+=(--ro-bind /dev/null "$env_file")
done < <(find "$ROOT" -name node_modules -prune -o -name .git -prune -o -type f -name '.env*' -print0)
if [ -e /run/systemd/resolve/stub-resolv.conf ]; then
  ARGS+=(--ro-bind /run/systemd/resolve/stub-resolv.conf /run/systemd/resolve/stub-resolv.conf)
fi
# File reads cannot invoke repo hooks, shell commands, MCP or write tools.
bwrap "${ARGS[@]}" "/ralph-claude/$(basename "$CLAUDE_BIN")" -p \
  --model "$MODEL" ${EFFORT_ARGS[@]+"${EFFORT_ARGS[@]}"} --tools Read,Glob,Grep --allowedTools Read Glob Grep \
  --permission-mode dontAsk --strict-mcp-config --setting-sources '' \
  --output-format stream-json --verbose
