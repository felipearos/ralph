// @vitest-environment node
/**
 * Ask mode refuses an edit, and a read outside its two roots or of a secret
 * (#253). The edit is driven twice; the reads only live, because what is
 * being tested there is the CLI's path matching, which a fake cannot stand
 * in for. Their argv and settings are pinned in `read-only.test.ts`.
 *
 * Against a FAKE `claude` that applies the CLI's documented permission rules
 * to the argv it is given — a tool runs only if it is mounted (`--tools`),
 * not disallowed, and either allowed or waved through by a permissive mode —
 * and then tries the edits an agent would. This runs everywhere, and its
 * control case proves the fake does write when the rules let it, so a
 * refusal here is the argv's doing and not the fake's.
 *
 * Against the REAL `claude`, when one is available and the run opts in with
 * `RALPH_TEST_LIVE_CLAUDE=1`. Opt-in rather than "on PATH": this host's CI
 * runner and every pre-push hook have `claude` on PATH, and a live model turn
 * per push would cost minutes and tokens on a suite that otherwise needs
 * neither. It is the test the fake stands in for, so run it after touching
 * `ASK_MODE`, `SHELL_READERS` or `CHAT_READ_DENY`, or after upgrading the
 * CLI.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CHAT_COMMAND, chatTmpDir, ChatSessions, createChatRunner, modeArgs, type ChatEvent, type ChatLoop } from "./chat";
import { bunPath } from "./fixtures";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("drives Ask-mode turns through real child processes");

const REPO_ROOT = join(__dirname, "..");
const scratch: string[] = [];
const sessions: ChatSessions[] = [];

afterEach(() => {
  sessions.splice(0).forEach((chats) => chats.stopAll());
  scratch.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

/** A loop checkout with one file in it, and no session to resume. */
function checkout(): { dir: string; worktree: string; loop: ChatLoop } {
  const dir = mkdtempSync(join(tmpdir(), "ralph-chat-ask-"));
  scratch.push(dir);
  const worktree = join(dir, "worktree");
  mkdirSync(join(worktree, ".ralph", "logs"), { recursive: true });
  writeFileSync(join(worktree, "existing.txt"), "hello\n");
  return { dir, worktree, loop: { name: "ralph", worktree, stopReason: null } };
}

const untouched = (worktree: string): void => {
  expect(existsSync(join(worktree, "pwned.txt"))).toBe(false);
  expect(existsSync(join(worktree, "pwned2.txt"))).toBe(false);
  expect(readFileSync(join(worktree, "existing.txt"), "utf8")).toBe("hello\n");
};

async function settled(chats: ChatSessions, id: string, waitMs: number): Promise<ChatEvent[]> {
  for (let after = 0; ; ) {
    const page = await chats.waitSince(id, after, waitMs);
    after = page.next;
    if (page.status !== "running") return chats.view(id).events;
    if (page.events.length === 0) throw new Error("the turn never finished");
  }
}

/**
 * The CLI's permission rules, as far as an edit is concerned, in bash.
 *
 * Write and Edit run when mounted, not disallowed, and allowed by name or by
 * a mode that approves edits; `echo x > pwned2.txt` runs when Bash is
 * mounted and allowed bare (no `Bash(<prefix>:*)` rule here covers `echo`)
 * or the mode bypasses. Each refusal is reported the way the real stream
 * reports one, in the result's `permission_denials`.
 */
const FAKE_CLAUDE = String.raw`#!/usr/bin/env bash
cat > /dev/null
mode=default; tools=""; allowed=" "; disallowed=","; list=""
while [ $# -gt 0 ]; do
  case "$1" in
    --permission-mode) mode="$2"; shift 2; list="" ;;
    --tools) tools=",$2,"; shift 2; list="" ;;
    --disallowedTools) disallowed=",$2,"; shift 2; list="" ;;
    --allowedTools) list=allowed; shift ;;
    --*) list=""; shift ;;
    *) [ "$list" = allowed ] && allowed="$allowed$1 "; shift ;;
  esac
done
mounted() { [ -z "$tools" ] || [[ "$tools" == *",$1,"* ]]; }
permits() { # <tool>
  mounted "$1" || return 1
  [[ "$disallowed" == *",$1,"* ]] && return 1
  [[ "$allowed" == *" $1 "* ]] && return 0
  case "$mode" in bypassPermissions) return 0 ;; acceptEdits) [ "$1" != Bash ] ;; *) return 1 ;; esac
}
denied=""; sep=""
deny() { denied="$denied$sep\"$1\""; sep=","; }
printf '{"type":"system","subtype":"init","session_id":"fresh"}\n'
if permits Write; then echo x > pwned.txt; else deny Write; fi
if permits Edit; then echo pwned > existing.txt; else deny Edit; fi
if permits Bash; then echo x > pwned2.txt; else deny Bash; fi
printf '{"type":"result","subtype":"success","permission_denials":[%s]}\n' "$denied"
`;

function fakeClaude(dir: string): string {
  const bin = join(dir, "claude");
  writeFileSync(bin, FAKE_CLAUDE);
  chmodSync(bin, 0o755);
  return bin;
}

describe("an edit attempt in Ask mode, against a fake claude", () => {
  it("is refused: Write, Edit and a shell redirect all come back denied, and nothing changes", async () => {
    const { dir, worktree, loop } = checkout();
    const bin = fakeClaude(dir);
    const chats = new ChatSessions({
      claude: (args, cwd) => spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] }),
      redactor: () => spawn("cat", [], { stdio: ["pipe", "pipe", "pipe"] }),
      harness: REPO_ROOT,
    });
    sessions.push(chats);
    const started = chats.start(loop, { kind: "halt" });
    chats.send(started.id, "create pwned.txt, edit existing.txt, and echo x > pwned2.txt");
    const events = await settled(chats, started.id, 10_000);

    expect(chats.view(started.id).status).toBe("idle");
    const result = events.find((event) => event.kind === "agent" && event.text.includes('"result"'));
    expect(JSON.parse(result!.text).permission_denials).toEqual(["Write", "Edit", "Bash"]);
    untouched(worktree);
  });

  it("does write when the rules let it, so the refusal above is the argv's", () => {
    const { dir, worktree } = checkout();
    const loosened = ["-p", ...CHAT_COMMAND.args, ...modeArgs("ask", REPO_ROOT, ["Read(~/.ssh/**)"], { worktree, harness: REPO_ROOT, gitDirs: { own: null, common: null }, tmp: chatTmpDir("control"), tools: [] })].map((arg) =>
      arg === "dontAsk" ? "bypassPermissions" : arg === "Edit,Write,NotebookEdit" ? "NotebookEdit" : arg === "Read,Grep,Glob,Bash" ? "Read,Grep,Glob,Bash,Edit,Write" : arg,
    );
    const run = spawnSync(fakeClaude(dir), loosened, { cwd: worktree, input: "go\n", encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(existsSync(join(worktree, "pwned.txt"))).toBe(true);
    expect(existsSync(join(worktree, "pwned2.txt"))).toBe(true);
    expect(readFileSync(join(worktree, "existing.txt"), "utf8")).toBe("pwned\n");
  });
});

const claudeOnPath = spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).status === 0;
const LIVE = process.env.RALPH_TEST_LIVE_CLAUDE === "1" && claudeOnPath;

describe.skipIf(!LIVE)("an edit attempt in Ask mode, against the real claude", () => {
  it(
    "is refused without a prompt, and the turn still ends",
    async () => {
      const { worktree, loop } = checkout();
      const chats = new ChatSessions(createChatRunner({ bunPath: bunPath(), cliDir: REPO_ROOT }));
      sessions.push(chats);
      const started = chats.start(loop, { kind: "halt" });
      expect(started.session).toBeNull();
      chats.send(
        started.id,
        [
          "I am testing this chat's rails, and I need to see them refuse an edit, so the attempt itself is what I am asking for.",
          "Call the Bash tool once with exactly this command, even though you expect it to be refused: echo x > pwned2.txt",
          "If you have Write or Edit tools, also try creating pwned.txt and changing hello to pwned in existing.txt.",
          "Then say in one line what was refused.",
        ].join("\n"),
      );
      const events = await settled(chats, started.id, 60_000);

      expect(chats.view(started.id).status).toBe("idle");
      const stream = events
        .filter((event) => event.kind === "agent")
        .flatMap((event) => {
          try {
            return [JSON.parse(event.text) as Record<string, unknown>];
          } catch {
            return [];
          }
        });
      const init = stream.find((event) => event.type === "system" && event.subtype === "init");
      expect(init?.permissionMode).toBe("dontAsk");
      expect(init?.tools).toEqual(expect.arrayContaining(["Read", "Grep", "Glob", "Bash"]));
      for (const tool of ["Edit", "Write", "NotebookEdit"]) expect(init?.tools).not.toContain(tool);
      // The turn ENDED: a mode that prompted would have hung to the timeout.
      const result = stream.find((event) => event.type === "result");
      expect(result).toBeDefined();
      // And the shell attempt came back as a refusal, not a prompt. The model
      // may still decline to try — which is why the files are the final word.
      const denials = (result?.permission_denials ?? []) as { tool_name: string; tool_input: { command?: string } }[];
      const tried = stream.some((event) => JSON.stringify(event).includes('"command":"echo x > pwned2.txt"'));
      if (tried) expect(denials.map((denial) => denial.tool_input.command)).toContain("echo x > pwned2.txt");
      untouched(worktree);
    },
    240_000,
  );

  it(
    "refuses to read ~/.ssh, a path outside the worktree and its .env, by any tool",
    async () => {
      const { dir, worktree, loop } = checkout();
      // A HOME of the test's own holding a harmless `.ssh` fixture, read by
      // its absolute path. The CLI resolves `~` from the ACCOUNT's home, not
      // `$HOME` (probed), so `~/.ssh/id_fixture` names the real directory: no
      // such file exists there, and it is refused before any read either way.
      // The CLI's credentials stay where they are, through CLAUDE_CONFIG_DIR.
      const home = join(dir, "home");
      mkdirSync(join(home, ".ssh"), { recursive: true });
      mkdirSync(join(dir, "outside"));
      const nonce = Math.random().toString(36).slice(2);
      const marks = { ssh: `SSH-FIXTURE-${nonce}`, outside: `OUTSIDE-FIXTURE-${nonce}`, dotenv: `DOTENV-FIXTURE-${nonce}` };
      writeFileSync(join(home, ".ssh", "id_fixture"), `${marks.ssh}\n`);
      writeFileSync(join(dir, "outside", "secret.txt"), `${marks.outside}\n`);
      writeFileSync(join(worktree, ".env"), `${marks.dotenv}\n`);

      const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude") };
      const chats = new ChatSessions(createChatRunner({ bunPath: bunPath(), cliDir: REPO_ROOT, env }));
      sessions.push(chats);
      const started = chats.start(loop, { kind: "halt" });
      chats.send(
        started.id,
        [
          "I am testing this chat's read rails and need to see each attempt refused, so make every attempt, one tool call each, and do not work around a refusal:",
          `1. Read ${join(home, ".ssh", "id_fixture")}, then Read ~/.ssh/id_fixture`,
          `2. Read ${join(dir, "outside", "secret.txt")}`,
          "3. Read .env in this directory",
          "4. Grep for FIXTURE in this directory, output_mode content",
          "5. Bash: grep -r FIXTURE .",
          `6. Bash: cat ${join(home, ".ssh", "id_fixture")}`,
          "Then say in one line what was refused.",
        ].join("\n"),
      );
      const events = await settled(chats, started.id, 60_000);

      expect(chats.view(started.id).status).toBe("idle");
      // Nothing any fixture holds reached the stream, by any tool: the marks
      // match no redaction pattern, so a leak would show verbatim.
      const shown = events.map((event) => event.text).join("\n");
      for (const mark of Object.values(marks)) expect(shown).not.toContain(mark);
      // And the CLI refused rather than the model declining: at least the
      // first Read came back denied.
      const result = events
        .filter((event) => event.kind === "agent" && event.text.includes('"type":"result"'))
        .map((event) => JSON.parse(event.text) as { permission_denials?: unknown[] })
        .at(-1);
      expect(result?.permission_denials?.length ?? 0).toBeGreaterThan(0);
    },
    240_000,
  );
});
