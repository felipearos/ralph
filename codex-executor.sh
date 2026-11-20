#!/usr/bin/env bash
# Codex executor: writable source, read-only Git/loop metadata, isolated home,
# no inherited MCP/config, no application credentials or shell network access.
set -euo pipefail

# Usage:
#   codex-executor.sh <model> <stage-codex-home> [session] [effort]
#   codex-executor.sh --probe-tools
#
# `--probe-tools` starts nothing but a shell in the same runtime mounts and
# PATH the executor gets, and checks that every tool the host has resolves and
# runs there (see `probe_tools`). `ralph/preflight.ts` runs it at startup.

# The executor's PATH. Only /usr is mounted from the host, so every runtime
# installed elsewhere (bun under ~/.bun, a Node outside the distribution) has
# to be placed in /ralph-runtimes to be found.
EXECUTOR_PATH=/ralph-runtimes:/usr/local/bin:/usr/bin

# The filesystem the executor sandbox and the probe share.
SANDBOX_BASE=(
  --ro-bind /usr /usr
  --symlink usr/bin /bin
  --symlink usr/lib /lib
  --symlink usr/lib64 /lib64
  --ro-bind /etc /etc
  # Codex resolves /proc/self/exe while loading config. Mount procfs inside
  # the private PID namespace so it sees only this stage's processes.
  --proc /proc
  --dev /dev
  --tmpfs /tmp
  --setenv PATH "$EXECUTOR_PATH"
)

# Expose runtimes installed outside /usr without exposing their home
# directories, and the shims beside them that briefs name directly.
#
# `bunx` is not a second binary: bun installs it as a symlink to itself and
# picks its mode from the name it was started as. Binding only `bun` left the
# executor without it, and on 2026-09-23 four of five overnight runs typed the
# `bunx jest …` their brief prescribed, got exit 127, and spent steps finding
# out that `bun x` worked. A relative symlink keeps both the name and the binary.
#
# npm and npx are scripts inside the npm package. Under /usr they are already
# visible; anywhere else (nvm, a tarball, a CI tool cache) the package is
# bound whole so the CLI can load the rest of itself.
RUNTIME_ARGS=()
runtime_args() {
  local runtime runtime_path runtime_real npm_root="" tool tool_path tool_real
  for runtime in bun node; do
    runtime_path="$(command -v "$runtime" || true)"
    if [ -n "$runtime_path" ]; then
      runtime_real="$(readlink -f "$runtime_path")"
      RUNTIME_ARGS+=(--ro-bind "$runtime_real" "/ralph-runtimes/$runtime")
      [ "$runtime" != bun ] || RUNTIME_ARGS+=(--symlink bun /ralph-runtimes/bunx)
    fi
  done
  for tool in npm npx; do
    tool_path="$(command -v "$tool" || true)"
    [ -n "$tool_path" ] || continue
    tool_real="$(readlink -f "$tool_path")"
    case "$tool_real" in
      /usr/*) ;;
      */node_modules/npm/bin/*)
        if [ -z "$npm_root" ]; then
          npm_root="${tool_real%/bin/*}"
          RUNTIME_ARGS+=(--ro-bind "$npm_root" /ralph-runtimes/lib/npm)
        fi
        RUNTIME_ARGS+=(--symlink "lib/npm/bin/${tool_real##*/}" "/ralph-runtimes/$tool")
        ;;
    esac
  done
}

# Every runtime or shim the host has must resolve and run inside. Prints one
# `ok|missing|broken <tool> …` line per tool and exits 1 on any that did not.
probe_tools() {
  local expected=() tool
  if command -v bun >/dev/null 2>&1; then expected+=(bun bunx); fi
  for tool in node npm npx; do
    if command -v "$tool" >/dev/null 2>&1; then expected+=("$tool"); fi
  done
  runtime_args
  # shellcheck disable=SC2016 # expanded by the sandboxed shell
  exec bwrap --die-with-parent --unshare-user --unshare-pid "${SANDBOX_BASE[@]}" \
    --setenv HOME /tmp "${RUNTIME_ARGS[@]}" \
    /bin/bash -c '
      status=0
      for tool in "$@"; do
        if ! path="$(command -v "$tool")"; then
          echo "missing $tool: not on the executor PATH ($PATH)"; status=1
        elif ! "$tool" --version >/dev/null 2>&1; then
          echo "broken $tool: $path --version failed"; status=1
        else
          echo "ok $tool $path"
        fi
      done
      exit "$status"' probe-tools "${expected[@]}"
}

if [ "${1:-}" = --probe-tools ]; then
  probe_tools
fi

ROOT="$PWD"
RALPH_HOME="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd -P)"
MODEL="$1"
STAGE_CODEX_HOME="$2"
SESSION="${3:-}"
EFFORT="${4:-}"
CODEX_BIN_REAL="$(readlink -f "$(command -v codex)")"
HOST_CODEX_HOME="$(readlink -f "${CODEX_HOME:-${HOME}/.codex}")"
GIT_DIR="$(git rev-parse --absolute-git-dir)"
GIT_COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir)"
mkdir -p "$STAGE_CODEX_HOME/rules"
# Direct command denials supplement the filesystem and network boundaries.
cat > "$STAGE_CODEX_HOME/rules/executor.rules" <<'RULES'
prefix_rule(pattern = ["gh"], decision = "forbidden")
prefix_rule(pattern = ["doppler"], decision = "forbidden")
prefix_rule(pattern = ["psql"], decision = "forbidden")
prefix_rule(pattern = ["supabase"], decision = "forbidden")
prefix_rule(pattern = ["git", ["commit", "push", "checkout", "switch", "reset", "clean", "merge", "rebase", "stash", "worktree"]], decision = "forbidden")
RULES
# The rules above cannot tell `bun run test` from `bun run test src/a.test.ts`:
# a prefix rule forbids both or neither. Repo-wide verification is refused by
# the guard instead — shims for every package runner, mounted at /ralph-guard
# and first on PATH, which judge what a command would run before running it
# (ralph/executor-guard/guard.ts).
# npm installs Codex as a JavaScript launcher beside its platform package.
# Mount the containing node_modules directory in that case so Node's normal
# package lookup can find both packages. Native or test
# launchers only need their own directory.
case "$CODEX_BIN_REAL" in
  */node_modules/@openai/codex/bin/codex.js)
    CODEX_LAUNCHER_ROOT="${CODEX_BIN_REAL%/@openai/codex/bin/codex.js}"
    CODEX_LAUNCHER_MOUNT="/ralph-codex/node_modules"
    CODEX_SANDBOX_BIN="${CODEX_LAUNCHER_MOUNT}/@openai/codex/bin/codex.js"
    ;;
  *)
    CODEX_LAUNCHER_ROOT="$(dirname "$CODEX_BIN_REAL")"
    CODEX_LAUNCHER_MOUNT="/ralph-codex/bin"
    CODEX_SANDBOX_BIN="${CODEX_LAUNCHER_MOUNT}/$(basename "$CODEX_BIN_REAL")"
    ;;
esac

BWRAP_ARGS=(
  --die-with-parent
  --new-session
  # The Buildkite agent itself is a container without CAP_SYS_ADMIN. Enter
  # a user namespace first so bubblewrap gains mount capabilities only
  # inside its own namespace, never in the agent or on the host.
  # Keep the caller's uid: Codex starts its own bubblewrap sandbox for every
  # shell and patch call, and a nested sandbox cannot write its uid map from
  # inside a namespace mapped to uid 0 ("setting up uid map: Operation not
  # permitted"), which left the executor unable to read or edit anything.
  --unshare-user
  --unshare-pid
  "${SANDBOX_BASE[@]}"
  --dir /tmp/ralph-home
  --bind "$ROOT" "$ROOT"
  --ro-bind "$GIT_COMMON_DIR" "$GIT_COMMON_DIR"
  --ro-bind "$GIT_DIR" "$GIT_DIR"
  --bind "$STAGE_CODEX_HOME" /codex-home
  --ro-bind "${HOST_CODEX_HOME}/auth.json" /codex-home/auth.json
  --ro-bind "$STAGE_CODEX_HOME/rules" /codex-home/rules
  --ro-bind "$CODEX_LAUNCHER_ROOT" "$CODEX_LAUNCHER_MOUNT"
  --ro-bind "${RALPH_HOME}/executor-guard" /ralph-guard
  --chdir "$ROOT"
  --setenv HOME /tmp/ralph-home
  --setenv CODEX_HOME /codex-home
  --setenv TMPDIR /tmp
  --setenv XDG_DATA_HOME /tmp/ralph-home/.local/share
  --setenv XDG_CONFIG_HOME /tmp/ralph-home/.config
  --setenv XDG_CACHE_HOME /tmp/ralph-home/.cache
  --setenv XDG_STATE_HOME /tmp/ralph-home/.local/state
  # The guard shims go first so repo-wide verification is refused before it runs.
  --setenv PATH "/ralph-guard/bin:$EXECUTOR_PATH"
)
# Fedora's /etc/resolv.conf points here. Mount the one file rather than
# /run, which can contain user-session sockets and credentials.
if [ -e /run/systemd/resolve/stub-resolv.conf ]; then
  BWRAP_ARGS+=(--ro-bind /run/systemd/resolve/stub-resolv.conf /run/systemd/resolve/stub-resolv.conf)
fi

# Protect orchestration state and hide project Codex configuration.
[ ! -e "$ROOT/.git" ] || BWRAP_ARGS+=(--ro-bind "$ROOT/.git" "$ROOT/.git")
[ ! -e "$ROOT/.ralph" ] || BWRAP_ARGS+=(--ro-bind "$ROOT/.ralph" "$ROOT/.ralph")
MASKED=()
if [ -e "$ROOT/.codex" ]; then
  BWRAP_ARGS+=(--tmpfs "$ROOT/.codex")
  MASKED+=("$ROOT/.codex")
fi
while IFS= read -r -d '' env_file; do
  BWRAP_ARGS+=(--ro-bind /dev/null "$env_file")
  MASKED+=("$env_file")
done < <(find "$ROOT" -name node_modules -prune -o -name .git -prune -o -type f -name '.env*' -print0)

# Git inside the sandbox reads the masks as edits: a tracked `.env.example`
# under /dev/null is a character device git refuses to hash ("unsupported file
# type", exit 128 from `git status`, `git diff` and `git diff --check`), and a
# tracked `.codex/` under tmpfs reads as every file deleted. The executor audits
# its own work with exactly those commands. So it gets a private copy of the
# index with skip-worktree set on the tracked masked paths, which tells git
# not to look at them in the working tree. The project's own index is never
# written: the copy is rebuilt from it every round (the orchestrator may have
# committed since) and lives beside this stage's Codex home. Masking the file
# instead with an empty regular file would only trade the crash for a false
# `M` on every masked path.
PRIVATE_GIT="${STAGE_CODEX_HOME}/git"
rm -rf "$PRIVATE_GIT"
mkdir -p "$PRIVATE_GIT"
REAL_INDEX="$(git rev-parse --path-format=absolute --git-path index)"
if [ -f "$REAL_INDEX" ]; then
  # Preserving the index's mtime is the whole point here, and that mtime is
  # load-bearing. (`--preserve=timestamps` rather than `-p`: only the timestamp
  # matters, and `-p` would also try mode and ownership, which under
  # `set -e` turns a mount that refuses them into a dead executor.) Git (built
  # without USE_NSEC) compares mtimes at one-second granularity, so a file
  # edited in the same second its stat was cached still looks unchanged; git
  # catches such a "racily clean" entry only because the entry's mtime is not
  # older than the INDEX FILE's own mtime, and then re-reads the content. A
  # plain `cp` stamps the copy with the time of the copy, which is later, so git
  # trusts the stale stat data instead: `git status --short` inside the sandbox
  # reports a clean tree over a real edit, and the executor audits its own work
  # against a lie (two red CI runs on main, 2026-10-20, #353).
  cp --preserve=timestamps "$REAL_INDEX" "$PRIVATE_GIT/index"
  if [ "${#MASKED[@]}" -gt 0 ]; then
    GIT_INDEX_FILE="$PRIVATE_GIT/index" git --literal-pathspecs ls-files -z -- "${MASKED[@]}" \
      | GIT_INDEX_FILE="$PRIVATE_GIT/index" git update-index -z --skip-worktree --stdin
  fi
  # Under /tmp, which Codex's own shell sandbox leaves writable, so git can
  # still refresh its stat cache there.
  BWRAP_ARGS+=(--bind "$PRIVATE_GIT" /tmp/ralph-git --setenv GIT_INDEX_FILE /tmp/ralph-git/index)
fi
runtime_args
BWRAP_ARGS+=("${RUNTIME_ARGS[@]}")
ARGS=(-c 'approval_policy="never"' -c 'sandbox_mode="workspace-write"'
  -c 'sandbox_workspace_write.network_access=false' -c 'web_search="disabled"'
  -c 'features.multi_agent=false' -c 'features.apps=false'
  --ignore-user-config --model "$MODEL" --json --skip-git-repo-check)
# Set on Codex's shell tool directly as well, so the private index reaches
# every command whatever Codex's environment-inheritance default becomes.
if [ -f "$PRIVATE_GIT/index" ]; then
  ARGS+=(-c 'shell_environment_policy.set.GIT_INDEX_FILE="/tmp/ralph-git/index"')
fi
if [ -n "$EFFORT" ]; then
  ARGS+=(-c "model_reasoning_effort=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$EFFORT")")
fi
if [ -n "$SESSION" ]; then
  EXEC=(exec resume "${ARGS[@]}" "$SESSION" -)
else
  EXEC=(exec "${ARGS[@]}" --cd "$ROOT" -)
fi
bwrap "${BWRAP_ARGS[@]}" "$CODEX_SANDBOX_BIN" "${EXEC[@]}"
