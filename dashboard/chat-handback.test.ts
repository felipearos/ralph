// @vitest-environment node
/**
 * Unblock & resume (#255), end to end over HTTP.
 *
 * The real handler over a real `ChatSessions`, whose `claude` is a script; the
 * real lifecycle, control and handback adapters, whose every invocation goes
 * to one scripted executor that plays `git`, `loop-state`, `controls`,
 * `start.sh`, `gh` and `publish-journal.ts`. The fake `gh` keeps the ticket's
 * comments and labels as state, so "does not double-post" is read off the
 * ticket rather than off a call count alone; the fake publisher reads the
 * draft the adapter wrote, as the real one does, and deletes it.
 *
 * Then the other half of the decision: that what lands on the ticket is what
 * the coder's next iteration is told to read.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { renderSpec } from "../issue-spec";
import { CHAT_COMMAND, CHAT_DRAFT, ChatSessions, draftFrom, type ChatEvent, type ChatView } from "./chat";
import {
  DECISION_HEADING,
  decisionComment,
  decisionMarker,
  handBack,
  journalDraftName,
  worktreeVerdict,
  type HandbackResult,
} from "./chat-handback";
import { createHandbackAdapter, HANDBACK_SURFACE, PUBLISH_ENV } from "./chat-handback-adapter";
import type { HandbackFactory } from "./chat-routes";
import { HANDBACK_DRAFT_PROMPT } from "./chat-seed";
import { LOOP_ROLES, type Liveness, type LoopRole, type RuntimeSnapshot } from "./contracts";
import { createRalphControlAdapter, type ExecResult, type Executor, type Invocation } from "./control-adapter";
import { createRalphLifecycleAdapter, type CheckoutReport } from "./lifecycle-adapter";
import { createRecordingExecutor, type RecordingExecutor } from "./recording-executor";
import { createHandler } from "./server";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("drives Unblock & resume over real child processes");

const REPO_ROOT = join(__dirname, "..");
const HARNESS = "/opt/harness";
const scratch: string[] = [];
const sessions: ChatSessions[] = [];

afterEach(() => {
  sessions.splice(0).forEach((chats) => chats.stopAll());
  scratch.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

/** A loop checkout whose logs resolve both a halt and a block of #255 to `the-session`. */
function worktree(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ralph-chat-handback-")));
  scratch.push(root);
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  writeFileSync(join(root, ".ralph", "logs", "iter-20261007T105001.log"), "blocked: #255 needs the operator's call\n");
  writeFileSync(
    join(root, ".ralph", "logs", "supervisor-run.log"),
    "Ralph: models — orchestrator claude-opus-5 on claude\n=== Ralph iteration 7/50 (20261007T105001) session the-session ===\n",
  );
  return root;
}

interface Ticket {
  labels: string[];
  comments: string[];
}

interface World {
  root: string;
  liveness: Liveness;
  /** The control record `controls status --json` prints, or null. */
  record: unknown;
  gitStatus: string;
  branch: string | null;
  ticket: Ticket;
  /** Fail the next N publishes. */
  failPublish: number;
  /** Fail the next N comments. */
  failComment: number;
  published: { name: string; content: string; env: Invocation["env"]; args: string[] }[];
  readonly calls: readonly Invocation[];
  kinds: () => string[];
}

const kindOf = (invocation: Invocation): string => {
  if (invocation.command.endsWith("start.sh")) return invocation.env.RALPH_RESUME_WORK === "1" ? "resume" : "start";
  if (invocation.args.some((arg) => arg.endsWith("loop-state.ts"))) return "liveness";
  if (invocation.args.some((arg) => arg.endsWith("controls.ts"))) return "record";
  if (invocation.args.some((arg) => arg.endsWith(HANDBACK_SURFACE.publish.script))) return "publish";
  if (invocation.command === "git") return "git";
  if (invocation.command === "gh") return `gh-${invocation.args[1]}`;
  return "other";
};

function world(root: string): { world: World; exec: Executor; recorder: RecordingExecutor } {
  const w: World = {
    root,
    liveness: "dead",
    record: null,
    gitStatus: "",
    branch: null,
    ticket: { labels: ["ralph-blocked", "ready-for-agent"], comments: ["blocked: needs the operator's call on the baseline"] },
    failPublish: 0,
    failComment: 0,
    published: [],
    get calls() {
      return recorder.calls.map((call) => call.invocation);
    },
    kinds: () => w.calls.map(kindOf),
  };
  const ok = (stdout = ""): ExecResult => ({ status: 0, stdout, stderr: "" });
  // One answer for every invocation, through the shared recorder so the
  // suite inspects its calls the way the others do.
  const answer = (invocation: Invocation): ExecResult => {
    switch (kindOf(invocation)) {
      case "liveness":
        return ok(
          JSON.stringify({
            self: root,
            loops: [{ worktree: root, worktreeStatus: "live", loopStatus: "failed", branch: w.branch, state: null, stateProblem: null, supervisor: w.liveness }],
            reconciliation: { orphaned: [], prunable: [] },
          }),
        );
      case "record":
        return ok(w.record === null ? "null" : JSON.stringify(w.record));
      case "git":
        if (invocation.args[0] === "status") return ok(w.gitStatus);
        if (invocation.args[0] === "symbolic-ref") return w.branch === null ? { status: 1, stdout: "", stderr: "" } : ok(`${w.branch}\n`);
        if (invocation.args[0] === "rev-parse") return ok(`${join(root, "gitcommon")}\n`);
        return ok("");
      case "start":
      case "resume":
        return ok("Started Ralph supervisor (pid 5151); waits 300s, runs up to 50 iterations.\n");
      case "gh-view":
        return ok(JSON.stringify({ labels: w.ticket.labels.map((name) => ({ name })), comments: w.ticket.comments.map((body) => ({ body })) }));
      case "gh-comment": {
        if (w.failComment > 0) {
          w.failComment -= 1;
          return { status: 1, stdout: "", stderr: "HTTP 502: Bad Gateway" };
        }
        const body = invocation.args.find((arg) => arg.startsWith("--body="))!.slice("--body=".length);
        w.ticket.comments.push(body);
        return ok("https://github.com/felipearos/ralph/issues/255#issuecomment-1\n");
      }
      case "gh-edit": {
        const label = invocation.args.find((arg) => arg.startsWith("--remove-label="))!.slice("--remove-label=".length);
        if (!w.ticket.labels.includes(label)) return { status: 1, stdout: "", stderr: `'${label}' not found` };
        w.ticket.labels = w.ticket.labels.filter((name) => name !== label);
        return ok("");
      }
      case "publish": {
        if (w.failPublish > 0) {
          w.failPublish -= 1;
          return { status: 1, stdout: "", stderr: "journal not published: ~/.ralph/journal.lock stayed locked for 120s; the draft is kept" };
        }
        const draft = invocation.args[invocation.args.indexOf("--draft") + 1]!;
        const name = draft.split("/").at(-1)!.slice("journal-draft-".length);
        w.published.push({ name, content: readFileSync(draft, "utf8"), env: invocation.env, args: invocation.args });
        rmSync(draft);
        return ok(`journal published: journal/ralph/${name} at abc123\n`);
      }
      default:
        return { status: 127, stdout: "", stderr: `unexpected invocation: ${invocation.command} ${invocation.args.join(" ")}` };
    }
  };
  const recorder = createRecordingExecutor({ fallback: answer });
  return { world: w, exec: recorder.exec, recorder };
}

function runtimeFor(root: string, role: LoopRole = "coder"): RuntimeSnapshot {
  return {
    roster: [{ name: "ralph", role }],
    loops: [
      {
        worktree: root,
        identity: "ralph",
        loopStatus: "failed",
        worktreeStatus: "live",
        branch: null,
        state: {
          version: 1,
          run: "ralph-run-1",
          owner: { loop: "ralph", pid: null, host: "test" },
          worktree: root,
          branch: null,
          stage: "iteration",
          iteration: { index: 7, max: 50 },
          heartbeat: "2026-10-07T13:00:00.000Z",
          lastEvent: null,
          stopReason: { kind: "blocked", why: "see .ralph/logs/iter-20261007T105001.log", at: "2026-10-07T13:00:00.000Z" },
        },
        stateProblem: null,
        supervisor: "dead",
        presence: null,
      },
    ],
    reconciliation: { orphaned: [], prunable: [] },
  };
}

const SUMMARY = [
  "**What was wrong** — the loop could not read build 3191's artifact to take it as the new baseline.",
  "**What was decided** — the operator committed the PNG to `fixtures/baseline/` in this worktree.",
  "**What the loop should do next** — rebase on main, re-run the visual gate, and ship #255.",
].join("\n");

interface Rig {
  root: string;
  w: World;
  handler: (request: Request) => Promise<Response>;
  argv: (turn: number) => string[];
  stdinOf: (turn: number) => string;
}

/** The real handler; `claude` prints a `result` event carrying `answer`. */
function rig(options: { role?: LoopRole; answer?: string; handback?: boolean } = {}): Rig {
  const root = worktree();
  const dir = join(root, "..", `${root.split("/").at(-1)}-bin`);
  mkdirSync(dir);
  scratch.push(dir);
  const argvDir = join(dir, "argv");
  mkdirSync(argvDir);
  const result =
    options.answer ?? JSON.stringify({ type: "result", subtype: "success", is_error: false, result: SUMMARY });
  writeFileSync(join(dir, "result.json"), `${result}\n`);
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      `f="$(printf '%s/argv-%03d' "${argvDir}" "$(ls "${argvDir}" | grep -vc '\\.')")"`,
      'printf "%s\\n" "$@" > "$f"',
      'cat > "$f.stdin"',
      `printf '{"type":"system","subtype":"init","session_id":"forked"}\\n'`,
      `cat "${join(dir, "result.json")}"`,
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  const chats = new ChatSessions({
    claude: (args, cwd) => spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] }),
    redactor: () => spawn("cat", [], { stdio: ["pipe", "pipe", "pipe"] }),
    harness: REPO_ROOT,
    now: () => new Date("2026-10-07T15:06:00.000Z"),
  });
  sessions.push(chats);
  const { world: w, exec } = world(root);
  const lifecycle = () => ({
    control: createRalphControlAdapter({ cliDir: root, root, bunPath: "bun", env: {}, exec }),
    lifecycle: createRalphLifecycleAdapter({ cliDir: root, root, bunPath: "bun", env: {}, exec }),
  });
  const handback: HandbackFactory = ({ loop, worktree: checkout }) =>
    createHandbackAdapter({ cliDir: HARNESS, root: checkout, loop, bunPath: "bun", env: { RALPH_JOURNAL_LOCKED: "1", RALPH_JOURNAL_DIR: "journal/other" }, exec });
  const handler = createHandler({
    adapter: { read: async () => runtimeFor(root, options.role) },
    shell: "<html></html>",
    clock: () => ({ nowMs: Date.parse("2026-10-07T15:06:00.000Z") }),
    chats,
    lifecycle: lifecycle as never,
    ...(options.handback === false ? {} : { handback }),
  });
  const names = (): string[] => readdirSync(argvDir).filter((name) => !name.includes(".")).sort();
  return {
    root,
    w,
    handler,
    argv: (turn) => readFileSync(join(argvDir, names()[turn]!), "utf8").replace(/\n$/, "").split("\n"),
    stdinOf: (turn) => readFileSync(join(argvDir, `${names()[turn]!}.stdin`), "utf8"),
  };
}

const call = async <T,>(r: Rig, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
  const response = await r.handler(
    new Request(`http://127.0.0.1${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }),
  );
  const text = await response.text();
  try {
    return { status: response.status, body: (text === "" ? null : JSON.parse(text)) as T };
  } catch {
    return { status: response.status, body: text as T };
  }
};

async function open(r: Rig, ticket: number | null = 255): Promise<string> {
  const started = await call<{ id: string }>(r, "POST", "/api/chat", ticket === null ? { loop: "ralph" } : { loop: "ralph", ticket });
  expect(started.status).toBe(201);
  return started.body.id;
}

const confirm = (r: Rig, id: string, summary = SUMMARY) =>
  call<HandbackResult>(r, "POST", `/api/chat/${id}/handback`, { summary, confirm: true });

const transcript = (r: Rig, id: string): ChatEvent[] =>
  readFileSync(join(r.root, ".ralph", "logs", `chat-${id}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ChatEvent);

const handbackEvents = (r: Rig, id: string): string[] =>
  transcript(r, id)
    .filter((event) => event.kind === "handback")
    .map((event) => `${event.step}:${event.outcome}`);

describe("the draft", () => {
  it("runs one bounded turn on the chat's own session and rails, and returns the summary", async () => {
    const r = rig();
    const id = await open(r);
    const drafted = await call<{ draft: string }>(r, "POST", `/api/chat/${id}/handback`, { draft: true });
    expect(drafted.status).toBe(200);
    expect(drafted.body.draft).toBe(SUMMARY);

    // Ask's rails, the session forked as any first turn forks it, and the
    // draft's bounds after them — never in their place.
    const argv = r.argv(0);
    expect(argv.slice(0, CHAT_COMMAND.args.length + 1)).toEqual(["-p", ...CHAT_COMMAND.args]);
    expect(argv).toContain("--disallowedTools");
    const bounds = argv.indexOf("--max-turns");
    expect(argv.slice(bounds, bounds + CHAT_DRAFT.args.length)).toEqual([...CHAT_DRAFT.args]);
    expect(argv.slice(-3)).toEqual(["--resume", "the-session", "--fork-session"]);
    // The first turn still carries the seed, and the draft prompt behind it.
    expect(r.stdinOf(0)).toContain("Mode: Ask, read-only.");
    expect(r.stdinOf(0).endsWith(`${HANDBACK_DRAFT_PROMPT}\n`)).toBe(true);

    const events = transcript(r, id);
    expect(handbackEvents(r, id)).toEqual(["draft:asked", "draft:done"]);
    expect(events.find((event) => event.kind === "handback" && event.outcome === "done")!.text).toBe(SUMMARY);
    // The chat is idle again: a later turn resumes the fork.
    const view = (await call<ChatView>(r, "GET", `/api/chat/${id}`)).body;
    expect(view).toMatchObject({ status: "idle", fork: "forked", ticket: 255, handingBack: false });
  });

  it("says why when the bounded turn wrote no summary, and the operator writes it instead", async () => {
    const r = rig({ answer: JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }) });
    const id = await open(r);
    const failed = await call<{ error: string; message: string }>(r, "POST", `/api/chat/${id}/handback`, { draft: true });
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe("DraftFailed");
    expect(failed.body.message).toContain("error_max_turns");
    expect(handbackEvents(r, id)).toEqual(["draft:asked", "draft:failed"]);
    // Nothing was written anywhere but the transcript.
    expect(r.w.kinds().filter((kind) => kind.startsWith("gh") || kind === "publish" || kind === "start")).toEqual([]);
  });

  it("falls back to the assistant's text, and cuts a runaway summary", () => {
    const at = "2026-10-07T00:00:00.000Z";
    const agent = (text: string): ChatEvent => ({ seq: 1, at, kind: "agent", text });
    expect(
      draftFrom([agent(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: " decided " }] } }))]),
    ).toBe("decided");
    const long = draftFrom([agent(JSON.stringify({ type: "result", subtype: "success", result: "x".repeat(CHAT_DRAFT.maxChars + 50) }))]);
    expect(typeof long === "string" && long.length).toBe(CHAT_DRAFT.maxChars + 1);
    expect(draftFrom([agent("not json"), { seq: 2, at, kind: "turn-end", text: "" }])).toEqual({ why: "the agent wrote no summary" });
  });
});

describe("Unblock & resume", () => {
  it("leaves the comment, drops the label, writes the journal entry and starts the loop", async () => {
    const r = rig();
    const id = await open(r);
    const answer = await confirm(r, id);

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ outcome: "resumed", step: null, ticket: 255, dirty: [] });
    expect(answer.body.restart).toMatchObject({ action: "start", outcome: "started", pid: 5151 });

    // The comment: the heading, the operator's words, where the transcript is, the marker.
    const transcriptPath = join(r.root, ".ralph", "logs", `chat-${id}.jsonl`);
    expect(r.w.ticket.comments).toHaveLength(2);
    const posted = r.w.ticket.comments[1]!;
    expect(posted).toBe(decisionComment({ chat: id, loop: "ralph", summary: SUMMARY, transcript: transcriptPath }));
    expect(posted.startsWith(`${DECISION_HEADING}\n\n${SUMMARY}\n`)).toBe(true);
    expect(posted).toContain(transcriptPath);
    expect(posted).toContain(decisionMarker(id));
    // The label, and only that one.
    expect(r.w.ticket.labels).toEqual(["ready-for-agent"]);

    // The journal: published once, through the publisher, into the harness
    // named explicitly, as this loop of this checkout.
    expect(r.w.published).toHaveLength(1);
    const entry = r.w.published[0]!;
    expect(entry.name).toBe(journalDraftName({ chat: id, ticket: 255, stamp: "20261007T150600Z" }).slice("journal-draft-".length));
    expect(entry.args).toEqual([join(HARNESS, "publish-journal.ts"), "--draft", join(r.root, ".ralph", "logs", `journal-draft-${entry.name}`), "--issue", "255"]);
    expect(entry.env[PUBLISH_ENV.home]).toBe(HARNESS);
    expect(entry.env[PUBLISH_ENV.project]).toBe(r.root);
    expect(entry.env[PUBLISH_ENV.loop]).toBe("ralph");
    // A loop's leftovers in the dashboard's environment never reach it.
    expect(entry.env.RALPH_JOURNAL_LOCKED).toBeUndefined();
    expect(entry.env.RALPH_JOURNAL_DIR).toBeUndefined();
    expect(entry.content).toContain("# 2026-10-07 — #255: operator decision");
    expect(entry.content).toContain("**Outcome: unblocked by the operator.**");
    expect(entry.content).toContain(SUMMARY);
    expect(entry.content).toContain(transcriptPath);

    // In order, worktree first: nothing external ran before it was read.
    const kinds = r.w.kinds().filter((kind) => kind !== "record" && kind !== "liveness");
    expect(kinds.indexOf("git")).toBeLessThan(kinds.indexOf("gh-view"));
    expect(kinds.filter((kind) => kind !== "git")).toEqual(["gh-view", "gh-comment", "gh-edit", "publish", "start"]);
    // And the transcript says so, step by step.
    expect(handbackEvents(r, id)).toEqual([
      "decision:confirmed",
      "worktree:done",
      "comment:done",
      "label:done",
      "journal:done",
      "restart:done",
    ]);
    expect(transcript(r, id).find((event) => event.step === "decision")!.text).toBe(SUMMARY);
  });

  it("resumes the work a Stop now cut short, rather than starting over", async () => {
    const r = rig();
    r.w.record = {
      version: 1,
      ralphRun: "run-1",
      loop: "ralph",
      applied: [],
      deferrals: [],
      hold: null,
      stop: { kind: "interrupted", confirmation: "confirmed", why: "stopped now", at: "T", key: "now-1", iteration: 7, issue: 255 },
    };
    r.w.branch = "ralph/255-chat-handback";
    const id = await open(r);
    const answer = await confirm(r, id);
    expect(answer.body).toMatchObject({ outcome: "resumed" });
    expect(answer.body.restart).toMatchObject({ action: "resume-work", outcome: "started" });
    expect(r.w.kinds()).toContain("resume");
    expect(r.w.kinds()).not.toContain("start");
  });

  it("on a halt with no ticket, skips the comment and the label, and still journals and starts", async () => {
    const r = rig();
    const id = await open(r, null);
    const answer = await confirm(r, id);
    expect(answer.body).toMatchObject({ outcome: "resumed", ticket: null });
    expect(answer.body.steps.map((step) => `${step.step}:${step.outcome}`)).toEqual([
      "worktree:done",
      "comment:skipped",
      "label:skipped",
      "journal:done",
      "restart:done",
    ]);
    expect(r.w.kinds().filter((kind) => kind.startsWith("gh"))).toEqual([]);
    expect(r.w.published[0]!.args.at(-1)).toBe("none");
    expect(r.w.published[0]!.name).toMatch(/^20261007T150600Z-none-chat-/);
    expect(r.w.kinds()).toContain("start");
  });

  it("refuses a dirty worktree, names the paths, and touches nothing outside it", async () => {
    const r = rig();
    r.w.gitStatus = " M src/app.ts\n?? fixtures/baseline/new.png\n?? .ralph/logs/chat-x.jsonl\nR  old.ts -> src/renamed.ts\n";
    const id = await open(r);
    const answer = await confirm(r, id);

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ outcome: "refused", step: "worktree" });
    // The loop's own state directory is the chat's to write in, so it is not dirt.
    expect(answer.body.dirty).toEqual(["src/app.ts", "fixtures/baseline/new.png", "src/renamed.ts"]);
    expect(answer.body.why).toContain("src/app.ts");
    expect(answer.body.why).toContain("fixtures/baseline/new.png");
    expect(r.w.kinds().filter((kind) => kind.startsWith("gh") || kind === "publish" || kind === "start" || kind === "resume")).toEqual([]);
    expect(r.w.ticket.labels).toContain("ralph-blocked");
    expect(handbackEvents(r, id)).toEqual(["decision:confirmed", "worktree:refused"]);
    // No draft was left behind either.
    expect(readdirSync(join(r.root, ".ralph", "logs")).filter((name) => name.startsWith("journal-draft-"))).toEqual([]);
  });

  it("after a mid-way failure, a retry finishes without posting or publishing twice", async () => {
    const r = rig();
    r.w.failPublish = 1;
    const id = await open(r);

    const first = await confirm(r, id);
    expect(first.body).toMatchObject({ outcome: "failed", step: "journal" });
    expect(first.body.why).toContain("stayed locked");
    expect(r.w.ticket.comments).toHaveLength(2);
    expect(r.w.ticket.labels).not.toContain("ralph-blocked");
    expect(r.w.kinds()).not.toContain("start");
    // The draft the publisher kept is the one the retry rewrites, by name.
    const kept = readdirSync(join(r.root, ".ralph", "logs")).filter((name) => name.startsWith("journal-draft-"));
    expect(kept).toHaveLength(1);

    const second = await confirm(r, id);
    expect(second.body).toMatchObject({ outcome: "resumed" });
    expect(second.body.steps.map((step) => `${step.step}:${step.outcome}`)).toEqual([
      "worktree:done",
      "comment:already",
      "label:already",
      "journal:done",
      "restart:done",
    ]);
    expect(r.w.ticket.comments.filter((body) => body.includes(decisionMarker(id)))).toHaveLength(1);
    expect(r.w.kinds().filter((kind) => kind === "gh-comment")).toHaveLength(1);
    expect(r.w.kinds().filter((kind) => kind === "gh-edit")).toHaveLength(1);
    expect(r.w.published).toHaveLength(1);
    expect(`journal-draft-${r.w.published[0]!.name}`).toBe(kept[0]);

    // And a third press after success changes nothing but the start, which is idempotent.
    const third = await confirm(r, id);
    expect(third.body.steps.map((step) => `${step.step}:${step.outcome}`)).toEqual([
      "worktree:done",
      "comment:already",
      "label:already",
      "journal:already",
      "restart:done",
    ]);
    expect(r.w.published).toHaveLength(1);
    expect(r.w.ticket.comments.filter((body) => body.includes(decisionMarker(id)))).toHaveLength(1);
  });

  it("stops at a failed comment and posts it on the retry", async () => {
    const r = rig();
    r.w.failComment = 1;
    const id = await open(r);
    const first = await confirm(r, id);
    expect(first.body).toMatchObject({ outcome: "failed", step: "comment" });
    expect(first.body.why).toContain("HTTP 502");
    expect(r.w.ticket.labels).toContain("ralph-blocked");
    const second = await confirm(r, id);
    expect(second.body).toMatchObject({ outcome: "resumed" });
    expect(r.w.ticket.comments.filter((body) => body.includes(decisionMarker(id)))).toHaveLength(1);
  });

  it("leaves a running loop's worktree alone, and finds the loop already running", async () => {
    const r = rig();
    r.w.liveness = "alive";
    r.w.gitStatus = " M src/mid-ticket.ts\n";
    const id = await open(r);
    const answer = await confirm(r, id);
    expect(answer.body.steps[0]).toMatchObject({ step: "worktree", outcome: "skipped" });
    expect(answer.body.outcome).toBe("resumed");
    expect(r.w.kinds()).not.toContain("git");
  });

  it("asks for the confirmation and the summary, and refuses a dashboard that cannot write", async () => {
    const r = rig();
    const id = await open(r);
    const unconfirmed = await call<{ error: string }>(r, "POST", `/api/chat/${id}/handback`, { summary: SUMMARY });
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.error).toBe("ConfirmationRequired");
    expect((await call(r, "POST", `/api/chat/${id}/handback`, { confirm: true })).status).toBe(400);
    expect((await call(r, "POST", `/api/chat/${id}/handback`, { summary: "x".repeat(9_000), confirm: true })).status).toBe(400);
    expect((await call(r, "GET", `/api/chat/${id}/handback`)).status).toBe(405);
    expect(r.w.calls).toEqual([]);

    const bare = rig({ handback: false });
    const other = await open(bare);
    const refused = await call<{ error: string }>(bare, "POST", `/api/chat/${other}/handback`, { summary: SUMMARY, confirm: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("HandbackUnavailable");
  });
});

describe("an executor that throws", () => {
  /** The world's executor, except that `throws` rejects with "boom" instead of answering. */
  function throwing(throws: string): { w: World; deps: Parameters<typeof handBack>[0] } {
    const root = worktree();
    const { world: w, exec, recorder } = world(root);
    // Ahead of the world's answer, and recorded like any call, as the step that rejected.
    recorder.rules.unshift({ match: (invocation) => kindOf(invocation) === throws, answer: { throw: new Error("boom") } });
    const deps = {
      control: createRalphControlAdapter({ cliDir: root, root, bunPath: "bun", env: {}, exec }),
      lifecycle: createRalphLifecycleAdapter({ cliDir: root, root, bunPath: "bun", env: {}, exec }),
      loop: "ralph",
      handback: createHandbackAdapter({ cliDir: HARNESS, root, loop: "ralph", bunPath: "bun", env: {}, exec }),
    };
    return { w, deps };
  }
  const request = (): Parameters<typeof handBack>[1] => ({
    chat: "c1",
    role: "coder",
    ticket: 255,
    summary: SUMMARY,
    transcript: "/tmp/ralph-chat-c1/transcript.jsonl",
    session: null,
    stamp: "20261007T150600Z",
    done: new Set(),
  });

  it("resolves each operation to its failure answer, never a rejection", async () => {
    const adapter = createHandbackAdapter({
      cliDir: HARNESS,
      root: worktree(),
      loop: "ralph",
      bunPath: "bun",
      env: {},
      exec: async () => {
        throw new Error("boom");
      },
    });
    await expect(adapter.readIssue(255)).resolves.toEqual({ problem: "gh issue view failed: boom" });
    await expect(adapter.comment(255, "body")).resolves.toEqual({ ok: false, why: "commenting on #255 failed: boom" });
    await expect(adapter.unlabel(255, "ralph-blocked")).resolves.toEqual({ ok: false, why: "removing ralph-blocked from #255 failed: boom" });
    await expect(adapter.publish("/w/.ralph/logs/journal-draft-x.md", 255)).resolves.toEqual({
      ok: false,
      why: "publishing the journal entry failed: boom",
    });
  });

  it("stops at the comment when the ticket read throws", async () => {
    const { w, deps } = throwing("gh-view");
    const result = await handBack(deps, request());
    expect(result).toMatchObject({ outcome: "failed", step: "comment", why: "#255 could not be read: gh issue view failed: boom" });
    expect(w.kinds()).not.toContain("gh-comment");
    expect(w.kinds()).not.toContain("start");
  });

  it("stops at the comment when the comment throws, and drops no label and publishes nothing", async () => {
    const { w, deps } = throwing("gh-comment");
    const result = await handBack(deps, request());
    expect(result).toMatchObject({ outcome: "failed", step: "comment", why: "commenting on #255 failed: boom" });
    expect(w.kinds()).not.toContain("gh-edit");
    expect(w.kinds()).not.toContain("publish");
  });

  it("stops at the label when its removal throws", async () => {
    const { w, deps } = throwing("gh-edit");
    const result = await handBack(deps, request());
    expect(result).toMatchObject({ outcome: "failed", step: "label", why: "removing ralph-blocked from #255 failed: boom" });
    expect(w.kinds()).not.toContain("publish");
  });

  it("stops at the journal when the publisher throws", async () => {
    const { w, deps } = throwing("publish");
    const result = await handBack(deps, request());
    expect(result).toMatchObject({ outcome: "failed", step: "journal", why: "publishing the journal entry failed: boom" });
    expect(w.kinds()).not.toContain("start");
  });
});

describe("the worktree's invariant, per role", () => {
  const checkout = (over: Partial<CheckoutReport> = {}): CheckoutReport => ({
    worktree: "/w",
    branch: null,
    readable: true,
    dirty: false,
    changes: [],
    claims: [],
    midTicket: false,
    unpushed: [],
    ...over,
  });

  it("holds a triager to clean and detached", () => {
    expect(worktreeVerdict("triager", "tria", checkout()).ok).toBe(true);
    const attached = worktreeVerdict("triager", "tria", checkout({ branch: "tria/stray" }));
    expect(attached).toMatchObject({ ok: false });
    expect(attached.why).toContain("detached");
  });

  it("holds a coder to its own branch, or none", () => {
    expect(worktreeVerdict("coder", "ralph", checkout({ branch: "ralph/255-handback" })).ok).toBe(true);
    expect(worktreeVerdict("coder", "ralph", checkout()).ok).toBe(true);
    for (const branch of ["main", "rafa/12-other", "ralphie/1-x"]) {
      const verdict = worktreeVerdict("coder", "ralph", checkout({ branch }));
      expect(verdict.ok).toBe(false);
      expect(verdict.why).toContain(branch);
    }
  });

  it("holds every role to nothing uncommitted, and refuses what it cannot read", () => {
    for (const role of LOOP_ROLES) {
      const dirty = worktreeVerdict(role, "x", checkout({ dirty: true, changes: ["MM a.ts"] }));
      expect(dirty).toMatchObject({ ok: false, paths: ["a.ts"] });
    }
    expect(worktreeVerdict("ci-doctor", "doc", checkout({ branch: "doc/fix-flake" })).ok).toBe(true);
    expect(worktreeVerdict("coder", "ralph", checkout({ readable: false }))).toMatchObject({ ok: false });
  });
});

describe("the decision reaches the next iteration", () => {
  const comment = decisionComment({ chat: "c-1", loop: "ralph", summary: SUMMARY, transcript: "/w/.ralph/logs/chat-c-1.jsonl" });

  it("is in the issue the coder's spec review reads, comment and all", () => {
    // `issue-spec.ts fetch` is how the coder hands the ticket to its spec
    // reviewer: every comment, verbatim. The handback's comment is one.
    const spec = renderSpec(
      {
        number: 255,
        title: "a blocked ticket",
        url: "https://github.com/felipearos/ralph/issues/255",
        state: "OPEN",
        labels: [{ name: "ready-for-agent" }],
        body: "the spec",
        comments: [
          { author: { login: "ralph-bot" }, createdAt: "2026-10-07T10:00:00Z", body: "blocked: needs the operator's call on the baseline" },
          { author: { login: "felipearosr" }, createdAt: "2026-10-07T15:06:00Z", body: comment },
        ],
      },
      "2026-10-07T15:10:00Z",
    );
    expect(spec).toContain(DECISION_HEADING);
    expect(spec).toContain("**What the loop should do next** — rebase on main, re-run the visual gate, and ship #255.");
    expect(spec.indexOf("blocked: needs the operator's call")).toBeLessThan(spec.indexOf(DECISION_HEADING));
  });

  it("is what the rendered coder prompt tells the next iteration to read and follow", () => {
    // The REAL prompt, rendered as `ralph.sh` renders it for a loop, against
    // the Loggd fixture project `prompt-render.test.ts` uses.
    const project = mkdtempSync(join(tmpdir(), "ralph-handback-render-"));
    scratch.push(project);
    const fixture = join(REPO_ROOT, "fixtures", "loggd", ".ralph");
    expect(existsSync(fixture)).toBe(true);
    spawnSync("cp", ["-r", fixture, join(project, ".ralph")]);
    const env: NodeJS.ProcessEnv = { ...process.env, RALPH_PROJECT: project, RALPH_LOOP_NAME: "ralph" };
    for (const name of Object.keys(env)) if (/^RALPH_(MODEL|RUNNER)_/.test(name)) delete env[name];
    const rendered = spawnSync("bun", [join(REPO_ROOT, "models.ts"), "--render-prompt", join(REPO_ROOT, "prompt.md")], {
      cwd: project,
      encoding: "utf8",
      env,
    });
    expect(rendered.status).toBe(0);
    const prompt = rendered.stdout;
    const implement = prompt.slice(prompt.indexOf("## 3. Implement"));
    // Before anything is briefed, the iteration reads the comments, and the
    // handback's heading — the very one the comment carries — is named as
    // the operator's answer that overrides the block.
    expect(implement).toContain('its comments (`bun "$RALPH_HOME/tracker.ts" view <n>`, which prints both)');
    expect(implement).toContain(`\`${DECISION_HEADING}\``);
    expect(implement).toContain("overrides the block");
    expect(comment.startsWith(DECISION_HEADING)).toBe(true);
    // And a claim resumed mid-ticket reads it too.
    const resume = prompt.slice(prompt.indexOf("Resume this loop's unfinished claim"), prompt.indexOf("## 3. Implement"));
    expect(resume).toContain(`\`${DECISION_HEADING}\``);
  });
});
