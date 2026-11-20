// @vitest-environment node
/**
 * The first turn's evidence seed (#253), pinned two ways.
 *
 * As text: `buildSeed` over a fixture block record, stop reason, journal and
 * log tail is compared whole, so a change to what the agent is told shows up
 * as a diff here rather than as a vaguer answer in a chat.
 *
 * As a pipeline: a real `ChatSessions` with the harness's own redactor and a
 * `claude` that records its stdin, over fixtures that carry a secret in every
 * one of the four sources. Nothing the seed quotes may reach `claude`, the
 * browser or the transcript unredacted, and a redactor that cannot vouch for
 * the seed must stop the turn before `claude` is started at all.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ChatSessions, type ChatEvent, type ChatLoop } from "./chat";
import { buildSeed, journalEntryFor, SEED_LINE_CHARS, type ChatEvidence, type SeedInput } from "./chat-seed";
import type { JournalEntryView } from "./contracts";
import { bunPath } from "./fixtures";
import { createRedactor } from "./iteration-output";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("redacts the evidence seed through real child processes");

const REPO_ROOT = join(__dirname, "..");
const scratch: string[] = [];
const sessions: ChatSessions[] = [];

afterEach(() => {
  sessions.splice(0).forEach((chats) => chats.stopAll());
  scratch.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ralph-chat-seed-"));
  scratch.push(dir);
  return dir;
}

const entry = (name: string, fields: Partial<JournalEntryView> = {}): JournalEntryView => ({
  name,
  at: null,
  issue: null,
  loop: "rafa",
  title: null,
  outcome: null,
  ...fields,
});

const JOURNAL: JournalEntryView[] = [
  entry("20261007T144157Z-245-72084253-ab7.md", { issue: 245, title: "#245 pr-medic", outcome: "merged" }),
  entry("20261007T132808Z-2013-5e6fce5f-e1c.md", {
    issue: 2013,
    at: "2026-10-07T13:28:08.000Z",
    title: "2026-10-07 — #2013 visual baseline",
    outcome: "blocked (needs build 3191's PNG)",
  }),
  entry("20261006T101010Z-2013-0aaaaaaa-111.md", { issue: 2013, title: "an older #2013 iteration", outcome: "pr" }),
];

const EVIDENCE: ChatEvidence = {
  ticket: 2013,
  block: {
    kind: "other",
    reason: "blocked: needs build 3191's actual PNG as the new baseline — loop token cannot read artifacts",
    pr: 2020,
    migration: null,
    at: "2026-10-07T13:27:00Z",
  },
  journal: JOURNAL,
};

const input = (overrides: Partial<SeedInput> = {}): SeedInput => ({
  loop: "rafa",
  worktree: "/work/rafa",
  harness: "/opt/ralph",
  stopReason: { kind: "blocked", why: "iteration 7 blocked #2013; see .ralph/logs/iter-20261007T132001.log", at: "2026-10-07T13:30:00Z" },
  session: "5e6fce5f-e1c4-4b7e-9d1a-000000000000",
  source: "iter-20261007T132001.log → supervisor-run.log",
  why: null,
  log: "iter-20261007T132001.log",
  tail: ["● Bash(bun bk-log.ts 3191)", "  ⎿  403: artifact not readable", "blocked: #2013 needs the PNG"],
  evidence: EVIDENCE,
  ...overrides,
});

describe("the seed, as text", () => {
  it("is pinned against a block comment, a stop reason, a journal and a log", () => {
    expect(buildSeed(input())).toBe(
      [
        "~~~~ operator-chat",
        "You are being addressed by the OPERATOR, a person, from the Ralph dashboard's unblocker chat — not by the loop's supervisor and not by a ticket.",
        "",
        "This is a FORK of the session that hit the block (5e6fce5f-e1c4-4b7e-9d1a-000000000000, traced through iter-20261007T132001.log → supervisor-run.log). The loop's own session is untouched, and nothing said here reaches the loop unless the operator hands it back.",
        "",
        "Mode: Ask, read-only. Allowed: Read, Grep and Glob inside this worktree and /opt/ralph (secrets such as `.env` are denied), `gh issue view`, `gh pr view`, `gh pr checks`, `git log`, `git diff`, `git show`, `bun /opt/ralph/bk-log.ts`, `bun /opt/ralph/tracker.ts view <n>` (the ticket on a Linear or Jira project). Everything else is refused, every edit included: do not try to change the worktree, push, or comment. Shell readers (`cat`, `grep`, `sed` and the like) are refused too; read files with Read and search them with Grep.",
        "",
        "Loop: rafa · worktree: /work/rafa · ticket: #2013",
        "",
        "## Block comment on #2013",
        "kind: other · posted 2026-10-07T13:27:00Z · PR #2020",
        "> blocked: needs build 3191's actual PNG as the new baseline — loop token cannot read artifacts",
        "",
        "## Stop reason (state.json)",
        "blocked at 2026-10-07T13:30:00Z: iteration 7 blocked #2013; see .ralph/logs/iter-20261007T132001.log",
        "",
        "## Journal entry",
        "20261007T132808Z-2013-5e6fce5f-e1c.md — 2026-10-07 — #2013 visual baseline",
        "Outcome: blocked (needs build 3191's PNG)",
        "",
        "## Iteration log (iter-20261007T132001.log, last 3 lines)",
        "● Bash(bun bk-log.ts 3191)",
        "  ⎿  403: artifact not readable",
        "blocked: #2013 needs the PNG",
        "~~~~",
        "",
      ].join("\n"),
    );
  });

  it("says so when there is no session to resume, and why", () => {
    const seed = buildSeed(
      input({ session: null, source: null, why: "iteration 20261007T132001 was orchestrated by codex, and only a claude session can be resumed" }),
    );
    expect(seed).toContain(
      "There is NO resumable session for this block: iteration 20261007T132001 was orchestrated by codex, and only a claude session can be resumed. This is a FRESH claude session",
    );
    expect(seed).not.toContain("This is a FORK");
    // With no session to match, the journal falls back to the ticket's newest.
    expect(seed).toContain("20261007T132808Z-2013-5e6fce5f-e1c.md");
  });

  it("says what it could not find rather than leaving a section out", () => {
    const seed = buildSeed(input({ stopReason: null, log: null, tail: null, evidence: { ticket: 2013, block: null, journal: null } }));
    expect(seed).toContain("No block record was found on #2013 (no `rafa-blocked` comment, or the backlog could not be read).");
    expect(seed).toContain("## Stop reason (state.json)\nNone recorded");
    expect(seed).toContain("## Journal entry\nNone found");
    expect(seed).toContain("## Iteration log\nNo iteration log was traced");
    expect(buildSeed(input({ tail: null }))).toContain("## Iteration log (iter-20261007T132001.log)\nThe log could not be read.");
    expect(buildSeed(input({ evidence: { ticket: null, block: null, journal: null } }))).toContain("No ticket is attached to this halt");
  });

  it("keeps one fence whatever the log quotes, and clips a runaway line", () => {
    const seed = buildSeed(input({ tail: ["~~~~~~ a fence of its own", "x".repeat(SEED_LINE_CHARS * 3)] }));
    expect(seed.startsWith("~~~~~~~ operator-chat\n")).toBe(true);
    expect(seed.endsWith("\n~~~~~~~\n")).toBe(true);
    expect(seed).toContain(`${"x".repeat(SEED_LINE_CHARS - 1)}…`);
    expect(seed).not.toContain("x".repeat(SEED_LINE_CHARS));
  });
});

describe("the iteration's journal entry", () => {
  it("is the one the session wrote, by the fragment in its name", () => {
    expect(journalEntryFor(JOURNAL, "0aaaaaaa-1112-0000-0000-000000000000", 2013)?.name).toBe("20261006T101010Z-2013-0aaaaaaa-111.md");
  });

  it("falls back to the ticket's newest entry, and never to another ticket's", () => {
    expect(journalEntryFor(JOURNAL, "ffffffff-ffff-0000-0000-000000000000", 2013)?.name).toBe("20261007T132808Z-2013-5e6fce5f-e1c.md");
    expect(journalEntryFor(JOURNAL, null, 999)).toBeNull();
    expect(journalEntryFor(JOURNAL, null, null)).toBeNull();
    expect(journalEntryFor(null, "5e6fce5f-e1c4-4b7e-9d1a-000000000000", 2013)).toBeNull();
  });
});

/* --------------------------------------------------- through the redactor */

const GITHUB_TOKEN = `ghp_${"a".repeat(36)}`;
const ANTHROPIC_KEY = `sk-ant-${"b".repeat(24)}`;
const BUILDKITE_TOKEN = `bkua_${"c".repeat(30)}`;
const CONNECTION = "postgres://loop:hunter2hunter2@db.internal:5432/loggd";
/** A value that is only a secret because of the NAME it is exported under. */
const ENV_SECRET = "plain-looking-value-31337";

/** A halted worktree whose log carries a secret in its tail. */
function haltedWorktree(dir: string): string {
  const worktree = join(dir, "worktree");
  const logs = join(worktree, ".ralph", "logs");
  mkdirSync(logs, { recursive: true });
  const lines = Array.from({ length: 100 }, (_, n) => `log line ${n}`);
  lines[97] = `● Bash(psql ${CONNECTION})`;
  lines[98] = `  ⎿  using ${ENV_SECRET} from the environment`;
  lines[5] = "too early to be in the tail";
  writeFileSync(join(logs, "iter-20261007T132001.log"), `${lines.join("\n")}\n`);
  writeFileSync(
    join(logs, "supervisor-run.log"),
    [
      "Rafa: models — orchestrator claude-opus-5 on claude",
      "=== Rafa iteration 7/50 (20261007T132001) session 5e6fce5f-e1c4-4b7e-9d1a-000000000000 ===",
      "",
    ].join("\n"),
  );
  return worktree;
}

const LOOP = (worktree: string): ChatLoop => ({
  name: "rafa",
  worktree,
  stopReason: { kind: "blocked", why: `auth failed with ${ANTHROPIC_KEY}; see .ralph/logs/iter-20261007T132001.log` },
});

const SECRET_EVIDENCE: ChatEvidence = {
  ticket: 2013,
  block: { ...EVIDENCE.block!, reason: `blocked: the artifact API refused ${GITHUB_TOKEN}` },
  journal: [entry("20261007T132808Z-2013-5e6fce5f-e1c.md", { issue: 2013, title: "#2013", outcome: `blocked (${BUILDKITE_TOKEN} expired)` })],
};

/** A `claude` that records its argv and stdin, one file per turn, and answers. */
function recordingClaude(dir: string): { bin: string; turns: () => string[]; stdinOf: (turn: number) => string } {
  const record = join(dir, "turns");
  mkdirSync(record, { recursive: true });
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      `n="$(ls "${record}" | wc -l)"`,
      `cat > "${record}/turn-$n.stdin"`,
      `printf '{"type":"system","subtype":"init","session_id":"forked"}\\n'`,
      `printf '{"type":"assistant","text":"the PNG"}\\n'`,
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    turns: () => readdirSync(record).sort(),
    stdinOf: (turn) => readFileSync(join(record, `turn-${turn}.stdin`), "utf8"),
  };
}

function chatsWith(claude: string, redactor: () => ReturnType<typeof spawn>, extra: { seedTimeoutMs?: number } = {}): ChatSessions {
  const chats = new ChatSessions({
    claude: (args, cwd) => spawn(claude, args, { cwd, stdio: ["pipe", "pipe", "pipe"] }),
    redactor,
    harness: REPO_ROOT,
    ...extra,
  });
  sessions.push(chats);
  return chats;
}

async function settled(chats: ChatSessions, id: string): Promise<ChatEvent[]> {
  for (let after = 0; ; ) {
    const page = await chats.waitSince(id, after, 10_000);
    after = page.next;
    if (page.status !== "running") return chats.view(id).events;
    if (page.events.length === 0) throw new Error("the turn never finished");
  }
}

const shellFilter = (dir: string, body: string): (() => ReturnType<typeof spawn>) => {
  const path = join(dir, "redact.sh");
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return () => spawn(path, { stdio: ["pipe", "pipe", "pipe"] });
};

describe("the seed, through the harness's own redactor", () => {
  it("reaches claude, the browser and the transcript with every secret struck", async () => {
    const dir = scratchDir();
    const claude = recordingClaude(dir);
    const redactor = createRedactor({
      bunPath: bunPath(),
      cliDir: REPO_ROOT,
      env: { PATH: process.env.PATH ?? "", LOOGD_SERVICE_TOKEN: ENV_SECRET },
    });
    const chats = chatsWith(claude.bin, redactor);
    const started = chats.start(LOOP(haltedWorktree(dir)), { kind: "halt" }, null, SECRET_EVIDENCE);
    expect(started.session).toBe("5e6fce5f-e1c4-4b7e-9d1a-000000000000");

    chats.send(started.id, "why are you blocked?");
    const events = await settled(chats, started.id);
    expect(chats.view(started.id).status).toBe("idle");

    const sent = claude.stdinOf(0);
    const shown = events.find((event) => event.kind === "seed")!.text;
    const transcript = readFileSync(chats.view(started.id).transcript, "utf8");
    for (const text of [sent, shown, transcript]) {
      for (const secret of [GITHUB_TOKEN, ANTHROPIC_KEY, BUILDKITE_TOKEN, CONNECTION, "hunter2hunter2", ENV_SECRET]) {
        expect(text).not.toContain(secret);
      }
    }
    // Every source is there, struck where it carried a secret.
    expect(sent).toContain("> blocked: the artifact API refused [redacted:github-token]");
    expect(sent).toContain("blocked: auth failed with [redacted:anthropic-key]");
    expect(sent).toContain("Outcome: blocked ([redacted:buildkite-token] expired)");
    expect(sent).toContain("[redacted:connection-string]");
    expect(sent).toContain("## Iteration log (iter-20261007T132001.log, last 80 lines)\nlog line 20\n");
    expect(sent).not.toContain("too early to be in the tail");
    // The seed, then the operator's own words, as one prompt.
    expect(sent.endsWith("~~~~\n\nwhy are you blocked?\n")).toBe(true);
    expect(`${shown}\n\nwhy are you blocked?\n`).toBe(sent);
  }, 30_000);

  it("is sent once: the second turn carries only the operator's words", async () => {
    const dir = scratchDir();
    const claude = recordingClaude(dir);
    const chats = chatsWith(claude.bin, () => spawn("cat", [], { stdio: ["pipe", "pipe", "pipe"] }));
    const started = chats.start(LOOP(haltedWorktree(dir)), { kind: "halt" }, null, EVIDENCE);
    chats.send(started.id, "why?");
    await settled(chats, started.id);
    chats.send(started.id, "and now?");
    await settled(chats, started.id);

    expect(claude.stdinOf(0)).toContain("operator-chat");
    expect(claude.stdinOf(1)).toBe("and now?\n");
    expect(chats.view(started.id).events.filter((event) => event.kind === "seed")).toHaveLength(1);
  });

  it("starts claude not at all when the redactor drops part of the seed", async () => {
    const dir = scratchDir();
    const claude = recordingClaude(dir);
    const chats = chatsWith(claude.bin, shellFilter(dir, "head -n 3"));
    const started = chats.start(LOOP(haltedWorktree(dir)), { kind: "halt" }, null, SECRET_EVIDENCE);
    chats.send(started.id, "why?");
    const events = await settled(chats, started.id);

    expect(chats.view(started.id).status).toBe("withheld");
    expect(events.at(-1)?.text).toMatch(/returned 3 of \d+ lines of the evidence seed/);
    expect(events.some((event) => event.kind === "seed")).toBe(false);
    expect(claude.turns()).toEqual([]);
  });

  it("starts claude not at all when the redactor never finishes", async () => {
    const dir = scratchDir();
    const claude = recordingClaude(dir);
    const chats = chatsWith(claude.bin, shellFilter(dir, "exec sleep 120"), { seedTimeoutMs: 200 });
    const started = chats.start(LOOP(haltedWorktree(dir)), { kind: "halt" }, null, SECRET_EVIDENCE);
    chats.send(started.id, "why?");
    const events = await settled(chats, started.id);

    expect(chats.view(started.id).status).toBe("withheld");
    expect(events.at(-1)?.text).toContain("did not return the evidence seed in time");
    expect(claude.turns()).toEqual([]);
    expect(existsSync(join(dir, "turns"))).toBe(true);
  });
});
