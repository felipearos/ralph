// @vitest-environment node
/**
 * The turns, driven against real child processes.
 *
 * `claude` is a shell script on disk that records its argv and prints a
 * stream-json transcript, and it writes a session file for whatever id it was
 * told to be — so "the loop's own session file is never written" is checked by
 * looking at the file, not by reading the argv and believing it. The redactor
 * is a real filter too: `cat` for one that passes text through, and scripts
 * that drop a line, add one, or complain on stderr.
 */
import { spawn } from "node:child_process";
import * as nodeFs from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { askSettings, chatTmpDir, ChatSessions, modeArgs, sandboxEnv, type ChatEvent, type ChatLoop, type SandboxRoots } from "./chat";
import { bunPath } from "./fixtures";
import { createRedactor } from "./iteration-output";
import { subprocessSuite } from "../test-timeouts";

const REPO_ROOT = join(__dirname, "..");

subprocessSuite("runs chat turns through real child processes");

const scratch: string[] = [];
const sessions: ChatSessions[] = [];

afterEach(() => {
  sessions.splice(0).forEach((chats) => chats.stopAll());
  scratch.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ralph-chat-turn-"));
  scratch.push(dir);
  return dir;
}

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * A `claude` that records its argv, prints an init event under the id it was
 * given (minting a fork id when told to fork), and writes that id's session
 * file — the same thing the real one does, and the only part that matters here.
 */
function turnFile(argvDir: string, turn: number): string {
  const names = readdirSync(argvDir)
    .filter((name) => !name.endsWith(".stdin"))
    .sort();
  const name = names[turn];
  if (name === undefined) throw new Error(`no turn ${turn} of ${names.length}`);
  return name;
}

function fakeClaude(dir: string): {
  bin: string;
  argvOf: (turn: number) => string[];
  stdinOf: (turn: number) => string;
  sessionFiles: () => string[];
} {
  const sessionDir = join(dir, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const bin = script(
    dir,
    "claude",
    [
      // Numbered, not `mktemp`: the turns must be readable back in order.
      `args_file="$(printf '%s/argv-%03d' "$ARGV_DIR" "$(ls "$ARGV_DIR" | wc -l)")"`,
      'printf "%s\\n" "$@" > "$args_file"',
      'resume=""; fork=0; prev=""',
      'for a in "$@"; do',
      '  [ "$prev" = --resume ] && resume="$a"',
      '  [ "$a" = --fork-session ] && fork=1',
      '  prev="$a"',
      'done',
      'id="$resume"',
      '[ "$fork" = 1 ] && id="forked-$resume"',
      '[ -n "$id" ] || id="fresh-session"',
      // The prompt arrives on stdin, not in the argv: recorded so the test can
      // read back exactly what the operator typed.
      'cat > "${args_file}.stdin"',
      'printf \'{"type":"system","subtype":"init","session_id":"%s"}\\n\' "$id"',
      'printf \'{"type":"assistant","text":"answered"}\\n\'',
      'printf \'done\\n\' >> "${SESSION_DIR}/${id}.jsonl"',
    ].join("\n"),
  );
  const argvDir = join(dir, "argv");
  mkdirSync(argvDir, { recursive: true });
  return {
    bin,
    argvOf: (turn) => {
      const name = turnFile(argvDir, turn);
      return readFileSync(join(argvDir, name), "utf8").trimEnd().split("\n");
    },
    stdinOf: (turn) => readFileSync(join(argvDir, `${turnFile(argvDir, turn)}.stdin`), "utf8"),
    sessionFiles: () => readdirSync(sessionDir).sort(),
  };
}

const loopOf = (worktree: string): ChatLoop => ({
  name: "ralph",
  worktree,
  stopReason: { kind: "failed", why: "see .ralph/logs/iter-20261007T105001.log" },
});

/** A worktree whose logs resolve to `the-session`. */
function halted(dir: string): string {
  const worktree = join(dir, "worktree");
  mkdirSync(join(worktree, ".ralph", "logs"), { recursive: true });
  writeFileSync(join(worktree, ".ralph", "logs", "iter-20261007T105001.log"), "rendered\n");
  writeFileSync(
    join(worktree, ".ralph", "logs", "supervisor-run.log"),
    [
      "Ralph: models — orchestrator claude-opus-5 on claude",
      "=== Ralph iteration 7/50 (20261007T105001) session the-session ===",
      "",
    ].join("\n"),
  );
  return worktree;
}

function chatsWith(
  dir: string,
  claudeBin: string,
  redactBody: string,
  extra: { turnTimeoutMs?: number; idleMs?: number; now?: () => Date; harness?: string; seedTimeoutMs?: number } = {},
): ChatSessions {
  const argvDir = join(dir, "argv");
  const sessionDir = join(dir, "sessions");
  const redact = script(dir, "redact.sh", redactBody);
  const chats = new ChatSessions({
    claude: (args, cwd) =>
      spawn(claudeBin, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ARGV_DIR: argvDir, SESSION_DIR: sessionDir },
      }),
    redactor: () => spawn(redact, { stdio: ["pipe", "pipe", "pipe"] }),
    ...extra,
  });
  sessions.push(chats);
  return chats;
}

/** Wait for the chat to settle, or for it to be withheld. */
async function settled(chats: ChatSessions, id: string): Promise<ChatEvent[]> {
  for (let after = 0; ; ) {
    const page = await chats.waitSince(id, after, 5_000);
    after = page.next;
    if (page.status !== "running") return chats.view(id).events;
    if (page.events.length === 0) throw new Error("the turn never finished");
  }
}

describe("a chat forks the loop's session and then resumes the fork", () => {
  it("forks once, resumes after, and never writes the loop's own session file", async () => {
    const dir = scratchDir();
    const claude = fakeClaude(dir);
    const worktree = halted(dir);
    // The loop's own session file, as it stood before the chat.
    writeFileSync(join(dir, "sessions", "the-session.jsonl"), "the loop's own history\n");

    const chats = chatsWith(dir, claude.bin, 'exec cat');
    const started = chats.start(loopOf(worktree), { kind: "halt" });
    expect(started.session).toBe("the-session");

    chats.send(started.id, "why are you blocked?");
    await settled(chats, started.id);
    chats.send(started.id, "and what would unblock it?");
    await settled(chats, started.id);

    const first = claude.argvOf(0);
    expect(first).toContain("--fork-session");
    expect(first.slice(first.indexOf("--resume"), first.indexOf("--resume") + 2)).toEqual(["--resume", "the-session"]);
    const second = claude.argvOf(1);
    expect(second).not.toContain("--fork-session");
    expect(second.slice(second.indexOf("--resume"), second.indexOf("--resume") + 2)).toEqual([
      "--resume",
      "forked-the-session",
    ]);

    // The promise spec #251 makes: the loop's history is exactly what the loop wrote.
    expect(readFileSync(join(dir, "sessions", "the-session.jsonl"), "utf8")).toBe("the loop's own history\n");
    expect(claude.sessionFiles()).toEqual(["forked-the-session.jsonl", "the-session.jsonl"]);
  });

  it("runs an Ask turn with exactly #253's allowlist, and asks nobody to approve anything", async () => {
    const dir = scratchDir();
    const claude = fakeClaude(dir);
    // A harness whose executor rails deny two paths: the Ask turn's settings
    // must carry exactly those, read from the file at run time.
    const harness = join(dir, "harness");
    mkdirSync(harness);
    writeFileSync(
      join(harness, "claude-executor-settings.json"),
      JSON.stringify({ permissions: { deny: ["Bash(gh *)", "Read(~/.ssh/**)", "Read(//etc/**)"] } }),
    );
    const chats = chatsWith(dir, claude.bin, "exec cat", { harness });
    const worktree = halted(dir);
    const started = chats.start(loopOf(worktree), { kind: "halt" });
    expect(chats.view(started.id).mode).toBe("ask");
    // The fixture worktree has no `.git`, so the sandbox opens no git dir.
    const roots: SandboxRoots = { worktree, harness, gitDirs: { own: null, common: null }, tmp: chatTmpDir(started.id), tools: [] };
    chats.send(started.id, "hello");
    await settled(chats, started.id);
    chats.send(started.id, "and then?");
    await settled(chats, started.id);

    // The whole argv, as the fake recorded it: one element per line, so the
    // empty `--setting-sources` value is the empty line it should be.
    const ask = [
      "--tools",
      "Read,Grep,Glob,Bash",
      "--add-dir",
      harness,
      "--allowedTools",
      "Bash(gh issue view:*)",
      "Bash(gh pr view:*)",
      "Bash(gh pr checks:*)",
      "Bash(git log:*)",
      "Bash(git diff:*)",
      "Bash(git show:*)",
      `Bash(bun ${harness}/bk-log.ts:*)`,
      `Bash(bun ${harness}/tracker.ts view:*)`,
      "--disallowedTools",
      "Edit,Write,NotebookEdit",
      "--settings",
      askSettings(["Read(~/.ssh/**)", "Read(//etc/**)"], roots),
    ];
    // The executor's Bash rules are NOT carried over: its `Bash(gh *)` would
    // refuse the very `gh issue view` Ask mode allows.
    const settings = JSON.parse(ask.at(-1)!) as { permissions: { deny: string[] } };
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Read(~/.ssh/**)", "Read(//etc/**)", "Read(**/.env*)", "Bash(grep *)"]));
    expect(settings.permissions.deny).not.toContain("Bash(gh *)");
    const pinned = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--strict-mcp-config",
      "--setting-sources",
      "",
    ];
    expect(modeArgs("ask", harness, ["Read(~/.ssh/**)", "Read(//etc/**)"], roots)).toEqual(ask);
    // And the sandbox rides in those settings, fail-closed.
    const sandbox = (JSON.parse(ask.at(-1)!) as { sandbox: { enabled: boolean; failIfUnavailable: boolean; filesystem: { denyWrite: string[] } } }).sandbox;
    expect([sandbox.enabled, sandbox.failIfUnavailable]).toEqual([true, true]);
    expect(sandbox.filesystem.denyWrite).toEqual([harness, join(worktree, ".git")]);
    expect(claude.argvOf(0)).toEqual([...pinned, ...ask, "--resume", "the-session", "--fork-session"]);
    // Every turn is an Ask turn, not only the first.
    expect(claude.argvOf(1)).toEqual([...pinned, ...ask, "--resume", "forked-the-session"]);
  });

  it("hands every turn's claude the sandbox's shell and the chat's own temp dir", async () => {
    const dir = scratchDir();
    const claude = fakeClaude(dir);
    const envs: Record<string, string>[] = [];
    const chats = new ChatSessions({
      claude: (args, cwd, _mode, env) => {
        envs.push(env);
        return spawn(claude.bin, args, {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, ...env, ARGV_DIR: join(dir, "argv"), SESSION_DIR: join(dir, "sessions") },
        });
      },
      redactor: () => spawn("cat", [], { stdio: ["pipe", "pipe", "pipe"] }),
    });
    sessions.push(chats);
    const worktree = halted(dir);
    const started = chats.start(loopOf(worktree), { kind: "halt" });
    chats.send(started.id, "hello");
    await settled(chats, started.id);
    expect(envs).toEqual([
      sandboxEnv({ worktree, harness: "", gitDirs: { own: null, common: null }, tmp: chatTmpDir(started.id), tools: [] }),
    ]);
    expect(envs[0]).toMatchObject({ CLAUDE_CODE_SHELL: "/bin/bash", CLAUDE_CODE_TMPDIR: `/tmp/ralph-chat-${started.id}` });
  });

  it("withholds the chat, rather than run unsandboxed, when the CLI says its sandbox is unavailable", async () => {
    const dir = scratchDir();
    // What the CLI does under `failIfUnavailable` with socat missing: one line
    // on stderr and exit 1, before any turn has run.
    const bin = script(
      dir,
      "claude",
      [
        "cat > /dev/null",
        'echo "Error: sandbox required but unavailable: sandbox is enabled but dependencies are missing: socat not installed" >&2',
        'echo "  sandbox.failIfUnavailable is set, refusing to start without a working sandbox." >&2',
        "exit 1",
      ].join("\n"),
    );
    const chats = chatsWith(dir, bin, "exec cat");
    const started = chats.start(loopOf(halted(dir)), { kind: "halt" });
    chats.send(started.id, "hello");
    const events = await settled(chats, started.id);

    expect(chats.view(started.id).status).toBe("withheld");
    expect(events.at(-1)).toMatchObject({ kind: "withheld", text: expect.stringContaining("OS sandbox is unavailable") });
    // Nothing of the turn is passed off as an answer, and no later turn runs.
    expect(events.some((event) => event.kind === "turn-end")).toBe(false);
    expect(() => chats.send(started.id, "again")).toThrow(/withheld/);
  });

  it("runs no turn when the executor's read denies cannot be loaded", async () => {
    const dir = scratchDir();
    const claude = fakeClaude(dir);
    // A harness with no `claude-executor-settings.json`: an Ask turn without
    // the executor's denies would read `~/.ssh`, so it is not run at all.
    const chats = chatsWith(dir, claude.bin, "exec cat", { harness: join(dir, "no-harness") });
    const started = chats.start(loopOf(halted(dir)), { kind: "halt" });
    chats.send(started.id, "hello");
    const events = await settled(chats, started.id);

    expect(chats.view(started.id).status).toBe("withheld");
    expect(events.at(-1)?.text).toContain("Ask mode's read denies could not be loaded");
    expect(readdirSync(join(dir, "argv"))).toEqual([]);
  });

  it("starts a fresh session when none could be resolved", async () => {
    const dir = scratchDir();
    const claude = fakeClaude(dir);
    const worktree = join(dir, "bare");
    mkdirSync(join(worktree, ".ralph", "logs"), { recursive: true });

    const chats = chatsWith(dir, claude.bin, "exec cat");
    const started = chats.start({ name: "ralph", worktree, stopReason: null }, { kind: "halt" });
    expect(started.session).toBeNull();
    expect(started.why).toContain("no stop reason");

    chats.send(started.id, "hello");
    await settled(chats, started.id);
    expect(claude.argvOf(0)).not.toContain("--resume");
  });
});

describe("the transcript", () => {
  it("records the operator's message and every redacted event", async () => {
    const dir = scratchDir();
    const claude = fakeClaude(dir);
    const worktree = halted(dir);
    const chats = chatsWith(dir, claude.bin, "exec cat");
    const started = chats.start(loopOf(worktree), { kind: "halt" });

    chats.send(started.id, "why are you blocked?");
    await settled(chats, started.id);

    const lines = readFileSync(join(worktree, ".ralph", "logs", `chat-${started.id}.jsonl`), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as ChatEvent);
    expect(lines[0]).toMatchObject({ seq: 1, kind: "operator", text: "why are you blocked?" });
    // The seed the agent was sent is in the transcript too, redacted.
    expect(lines.map((event) => event.kind)).toEqual(["operator", "seed", "agent", "agent", "turn-end"]);
    expect(lines[1]!.text).toContain("operator-chat");
    expect(lines[3]!.text).toContain("answered");
  });
});

describe("the redactor fails closed", () => {
  it("withholds the chat when the filter complains on stderr", async () => {
    const dir = scratchDir();
    const claude = fakeClaude(dir);
    const chats = chatsWith(dir, claude.bin, 'echo "no patterns to redact with" >&2; exit 3');
    const started = chats.start(loopOf(halted(dir)), { kind: "halt" });

    chats.send(started.id, "hello");
    const events = await settled(chats, started.id);

    expect(chats.view(started.id).status).toBe("withheld");
    const withheld = events.filter((event) => event.kind === "withheld");
    expect(withheld).toHaveLength(1);
    expect(withheld[0]!.text).toContain("no patterns");
    expect(events.some((event) => event.kind === "agent")).toBe(false);
  });

  it("withholds the chat when the filter returns fewer lines than it was given", async () => {
    const dir = scratchDir();
    const claude = fakeClaude(dir);
    // Drops the init event: every later line would then be attributed to the
    // wrong place, and one of them is the one we would read the fork id from.
    const chats = chatsWith(dir, claude.bin, 'grep --line-buffered -v \'"init"\' || true');
    const started = chats.start(loopOf(halted(dir)), { kind: "halt" });

    chats.send(started.id, "hello");
    const events = await settled(chats, started.id);

    expect(chats.view(started.id).status).toBe("withheld");
    expect(events.at(-1)).toMatchObject({ kind: "withheld", text: expect.stringContaining("of 2 lines") });
  });

  it("withholds the chat when the filter invents a line", async () => {
    const dir = scratchDir();
    const claude = fakeClaude(dir);
    const chats = chatsWith(dir, claude.bin, "awk '{ print; print \"and one more\"; fflush() }'");
    const started = chats.start(loopOf(halted(dir)), { kind: "halt" });

    chats.send(started.id, "hello");
    const events = await settled(chats, started.id);

    expect(chats.view(started.id).status).toBe("withheld");
    expect(events.at(-1)).toMatchObject({ kind: "withheld", text: expect.stringContaining("more lines") });
  });

  it("refuses a turn on a withheld chat rather than starting another", async () => {
    const dir = scratchDir();
    const claude = fakeClaude(dir);
    const chats = chatsWith(dir, claude.bin, 'echo broken >&2; exit 1');
    const started = chats.start(loopOf(halted(dir)), { kind: "halt" });
    chats.send(started.id, "hello");
    await settled(chats, started.id);

    expect(() => chats.send(started.id, "again")).toThrow(/withheld/);
  });
});

describe("the chat registry", () => {
  it("does not know an id it never issued", () => {
    const dir = scratchDir();
    const chats = chatsWith(dir, fakeClaude(dir).bin, "exec cat");
    expect(() => chats.view("nope")).toThrow(/no chat 'nope'/);
    expect(() => chats.send("nope", "hi")).toThrow(/no chat 'nope'/);
  });

  it("refuses a second turn while one is in flight", () => {
    const dir = scratchDir();
    const chats = chatsWith(dir, fakeClaude(dir).bin, "exec cat");
    const started = chats.start(loopOf(halted(dir)), { kind: "halt" });
    chats.send(started.id, "one");
    expect(() => chats.send(started.id, "two")).toThrow(/still answering/);
  });

  it("holds a long poll open until there is something to say", async () => {
    const dir = scratchDir();
    const chats = chatsWith(dir, fakeClaude(dir).bin, "exec cat");
    const started = chats.start(loopOf(halted(dir)), { kind: "halt" });
    const page = chats.waitSince(started.id, 0, 5_000);
    chats.send(started.id, "hello");
    expect((await page).events[0]).toMatchObject({ seq: 1, kind: "operator" });
  });

  it("gives up a long poll on its own, with nothing to report", async () => {
    const dir = scratchDir();
    const chats = chatsWith(dir, fakeClaude(dir).bin, "exec cat");
    const started = chats.start(loopOf(halted(dir)), { kind: "halt" });
    const page = await chats.waitSince(started.id, 0, 50);
    expect(page.events).toEqual([]);
    expect(page.status).toBe("idle");
  });
});

describe("the harness's own redactor", () => {
  it("strikes a secret from a turn, and still lets the turn end", async () => {
    const dir = scratchDir();
    const token = `ghp_${"b".repeat(36)}`;
    const claude = fakeClaude(dir);
    // The same fake, made to print a token: what matters is that the real
    // filter rewrites the line AND that the end marker still comes back
    // through it, which is what proves the line counting is not a race with
    // the filter's own buffering.
    writeFileSync(
      claude.bin,
      `#!/usr/bin/env bash\nprintf '{"type":"system","subtype":"init","session_id":"forked"}\\n'\nprintf 'leaked ${token}\\n'\n`,
    );
    chmodSync(claude.bin, 0o755);

    const chats = new ChatSessions({
      claude: (args, cwd) => spawn(claude.bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] }),
      redactor: createRedactor({ bunPath: bunPath(), cliDir: REPO_ROOT, env: { PATH: process.env.PATH ?? "" } }),
    });
    sessions.push(chats);
    const started = chats.start(loopOf(halted(dir)), { kind: "halt" });
    chats.send(started.id, "hello");
    const events = await settled(chats, started.id);

    const shown = events.map((event) => event.text).join("\n");
    expect(chats.view(started.id).status).toBe("idle");
    expect(shown).not.toContain(token);
    expect(shown).toContain("[redacted:github-token]");
    expect(events.at(-1)?.kind).toBe("turn-end");
  }, 30_000);

  it("strikes a secret the child printed on STDERR, not only on stdout", async () => {
    const dir = scratchDir();
    const token = `ghp_${"c".repeat(36)}`;
    // stderr is where a crash message lands, and the likeliest place for a
    // path or a token. Nothing but this test stops it being emitted straight
    // to the operator and into the durable transcript, unredacted.
    const bin = script(
      dir,
      "claude",
      [
        `printf '{"type":"system","subtype":"init","session_id":"forked"}\\n'`,
        `echo "claude: auth failed for ${token}" >&2`,
      ].join("\n"),
    );
    const chats = new ChatSessions({
      claude: (args, cwd) => spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] }),
      redactor: createRedactor({ bunPath: bunPath(), cliDir: REPO_ROOT, env: { PATH: process.env.PATH ?? "" } }),
    });
    sessions.push(chats);
    const started = chats.start(loopOf(halted(dir)), { kind: "halt" });

    chats.send(started.id, "hello");
    const events = await settled(chats, started.id);

    const shown = events.map((event) => event.text).join("\n");
    expect(shown).toContain("[stderr] claude: auth failed for [redacted:github-token]");
    expect(shown).not.toContain(token);
    // And the transcript, which is the copy that outlives the dashboard.
    expect(readFileSync(chats.view(started.id).transcript, "utf8")).not.toContain(token);
  }, 30_000);
});

describe("the operator's text never touches the argv", () => {
  it("arrives on stdin, dash and all", async () => {
    const dir = scratchDir();
    const claude = fakeClaude(dir);
    const chats = chatsWith(dir, claude.bin, "exec cat");
    const started = chats.start(loopOf(halted(dir)), { kind: "halt" });

    // A message beginning with a dash is the case that breaks a positional
    // prompt: `claude -p "-v and why?"` prints the version and exits 0.
    chats.send(started.id, "-v and why did you stop?");
    await settled(chats, started.id);

    // Behind the seed on this first turn, and on its own line.
    expect(claude.stdinOf(0)).toMatch(/~~~~\n\n-v and why did you stop\?\n$/);
    expect(claude.argvOf(0)).not.toContain("-v and why did you stop?");
    expect(claude.argvOf(0).filter((arg) => arg === "-p")).toHaveLength(1);
  });
});

describe("a turn that goes wrong is still reported", () => {
  it("shows the child's stderr, marked, and its exit status", async () => {
    const dir = scratchDir();
    const bin = script(
      dir,
      "claude",
      [
        `printf '{"type":"system","subtype":"init","session_id":"forked"}\\n'`,
        'echo "claude: credit balance too low" >&2',
        "exit 7",
      ].join("\n"),
    );
    const chats = chatsWith(dir, bin, "exec cat");
    const started = chats.start(loopOf(halted(dir)), { kind: "halt" });

    chats.send(started.id, "hello");
    const events = await settled(chats, started.id);

    const shown = events.map((event) => event.text);
    expect(shown).toContain("[stderr] claude: credit balance too low");
    expect(shown).toContain("[exit] the turn ended with status 7");
    // Reported, not withheld: a failed turn is the operator's to read.
    expect(chats.view(started.id).status).toBe("idle");
  });

  it("kills a turn whose child never exits, rather than pinning the chat", async () => {
    const dir = scratchDir();
    // `exec`, so the signal reaches the thing that is actually sleeping: a
    // bash that forked `sleep` dies alone and `sleep` holds the pipe open.
    const bin = script(dir, "claude", 'printf \'{"type":"system","subtype":"init","session_id":"forked"}\\n\'\nexec sleep 120');
    const chats = chatsWith(dir, bin, "exec cat", { turnTimeoutMs: 150 });
    const started = chats.start(loopOf(halted(dir)), { kind: "halt" });

    chats.send(started.id, "hello");
    await settled(chats, started.id);

    // Idle again, so the operator can ask something else; without the deadline
    // this chat would 409 "still answering" for the dashboard's lifetime.
    expect(chats.view(started.id).status).toBe("idle");
    expect(() => chats.send(started.id, "again")).not.toThrow();
  });
});

describe("the fork's id", () => {
  it("is not learnt from an event that merely carries a session_id", async () => {
    const dir = scratchDir();
    // A real stream emits several events before `init`, and some carry an id.
    const bin = script(
      dir,
      "claude",
      [
        `printf '{"type":"system","subtype":"hook_started","session_id":"not-the-fork"}\\n'`,
        `printf '{"type":"system","subtype":"init","session_id":"the-real-fork"}\\n'`,
      ].join("\n"),
    );
    const chats = chatsWith(dir, bin, "exec cat");
    const started = chats.start(loopOf(halted(dir)), { kind: "halt" });

    chats.send(started.id, "hello");
    await settled(chats, started.id);

    expect(chats.view(started.id).fork).toBe("the-real-fork");
  });

  it("withholds the chat when the fork never announces one", async () => {
    const dir = scratchDir();
    const bin = script(dir, "claude", `printf '{"type":"assistant","text":"hi"}\\n'`);
    const chats = chatsWith(dir, bin, "exec cat");
    const started = chats.start(loopOf(halted(dir)), { kind: "halt" });

    chats.send(started.id, "hello");
    const events = await settled(chats, started.id);

    // Carrying on would resume the BASE session and fork it again, stranding
    // this turn in a branch nothing points at.
    expect(chats.view(started.id).status).toBe("withheld");
    expect(events.at(-1)?.text).toContain("never announced its id");
  });

  it("is reported beside the base session, not in place of it", async () => {
    const dir = scratchDir();
    const chats = chatsWith(dir, fakeClaude(dir).bin, "exec cat");
    const started = chats.start(loopOf(halted(dir)), { kind: "halt" });
    chats.send(started.id, "hello");
    await settled(chats, started.id);

    const view = chats.view(started.id);
    expect(view.session).toBe("the-session");
    expect(view.fork).toBe("forked-the-session");
  });
});

describe("nothing accumulates unwatched", () => {
  it("stops the turn's redactor once the turn has ended", async () => {
    const dir = scratchDir();
    const claude = fakeClaude(dir);
    const filters: ReturnType<typeof spawn>[] = [];
    const chats = new ChatSessions({
      claude: (args, cwd) =>
        spawn(claude.bin, args, {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, ARGV_DIR: join(dir, "argv"), SESSION_DIR: join(dir, "sessions") },
        }),
      redactor: () => {
        const filter = spawn("cat", [], { stdio: ["pipe", "pipe", "pipe"] });
        filters.push(filter);
        return filter;
      },
    });
    sessions.push(chats);
    const started = chats.start(loopOf(halted(dir)), { kind: "halt" });
    chats.send(started.id, "hello");
    await settled(chats, started.id);
    const afterOne = filters.length;
    chats.send(started.id, "and again");
    await settled(chats, started.id);

    // One redactor per TURN, not per chat — which only a second turn can show
    // — plus the first turn's one-shot filter over its evidence seed.
    expect([afterOne, filters.length]).toEqual([2, 3]);
    // And an idle chat holds none of them.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(filters.map((filter) => filter.exitCode !== null || filter.killed)).toEqual([true, true, true]);
  });

  it("closes a chat and forgets it", () => {
    const dir = scratchDir();
    const chats = chatsWith(dir, fakeClaude(dir).bin, "exec cat");
    const started = chats.start(loopOf(halted(dir)), { kind: "halt" });
    chats.close(started.id);
    expect(() => chats.view(started.id)).toThrow(/no chat/);
  });

  it("does not sweep a chat an operator is still reading", () => {
    const dir = scratchDir();
    let clock = Date.parse("2026-10-07T12:00:00.000Z");
    const chats = chatsWith(dir, fakeClaude(dir).bin, "exec cat", { idleMs: 60_000, now: () => new Date(clock) });
    const reading = chats.start(loopOf(halted(dir)), { kind: "halt" });

    // Reading IS touching: an operator composing a follow-up over an hour,
    // their page polling throughout, must not lose the chat.
    clock += 50_000;
    chats.view(reading.id);
    clock += 50_000;
    chats.start(loopOf(halted(dir)), { kind: "halt" });

    expect(chats.view(reading.id).status).toBe("idle");
  });

  it("sweeps a chat nobody has touched, when the next one starts", async () => {
    const dir = scratchDir();
    let clock = Date.parse("2026-10-07T12:00:00.000Z");
    const chats = chatsWith(dir, fakeClaude(dir).bin, "exec cat", {
      idleMs: 60_000,
      now: () => new Date(clock),
    });
    const stale = chats.start(loopOf(halted(dir)), { kind: "halt" });
    chats.send(stale.id, "hello");
    await settled(chats, stale.id);
    // A poll left open over the chat that is about to be swept: it must be
    // woken, not left to hang for its full timeout and then 404.
    const hanging = chats.waitSince(stale.id, 99, 25_000);
    clock += 120_000;
    const began = Date.now();
    const fresh = chats.start(loopOf(halted(dir)), { kind: "halt" });

    // Woken at once and told the chat is gone — a 404 on the route — rather
    // than left hanging for the full 25 seconds first.
    await expect(hanging).rejects.toThrow(/no chat/);
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(() => chats.view(stale.id)).toThrow(/no chat/);
    expect(chats.view(fresh.id).status).toBe("idle");
  });

  it("does not hold a poll open for a client that has already gone", async () => {
    const dir = scratchDir();
    const chats = chatsWith(dir, fakeClaude(dir).bin, "exec cat");
    const started = chats.start(loopOf(halted(dir)), { kind: "halt" });
    const aborted = AbortSignal.abort();

    // A 25-second timer per disconnected client is what this prevents.
    const began = Date.now();
    await chats.waitSince(started.id, 0, 25_000, aborted);
    expect(Date.now() - began).toBeLessThan(1_000);
  });
});

describe("a chat belongs to the project that started it", () => {
  it("is not readable or resumable under another project", () => {
    const dir = scratchDir();
    const chats = chatsWith(dir, fakeClaude(dir).bin, "exec cat");
    const started = chats.start(loopOf(halted(dir)), { kind: "halt" }, "software-factory");

    expect(chats.view(started.id, "software-factory").loop).toBe("ralph");
    expect(() => chats.view(started.id, "loggd")).toThrow(/no chat/);
    expect(() => chats.send(started.id, "hello", "loggd")).toThrow(/no chat/);
  });
});

describe("the transcript's own failures", () => {
  it("reports an append it could not make, and keeps the chat", async () => {
    const dir = scratchDir();
    const claude = fakeClaude(dir);
    const worktree = halted(dir);
    const chats = new ChatSessions({
      claude: (args, cwd) =>
        spawn(claude.bin, args, {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, ARGV_DIR: join(dir, "argv"), SESSION_DIR: join(dir, "sessions") },
        }),
      redactor: () => spawn("cat", [], { stdio: ["pipe", "pipe", "pipe"] }),
      io: {
        ...nodeFs,
        appendFileSync: () => {
          throw new Error("ENOSPC: no space left on device");
        },
      },
    });
    sessions.push(chats);
    const started = chats.start(loopOf(worktree), { kind: "halt" });

    chats.send(started.id, "why are you blocked?");
    const events = await settled(chats, started.id);

    // The durable half has a gap and the operator is told; the answer already
    // on screen is not thrown away over it.
    const view = chats.view(started.id);
    expect(view.transcriptProblem).toContain("ENOSPC");
    expect(view.status).toBe("idle");
    expect(events.some((event) => event.kind === "agent")).toBe(true);
  });
});
