// @vitest-environment node
/**
 * Fix mode and Stop & fix (#254), two ways.
 *
 * `fixGate` and `stopForFix` against the REAL control and lifecycle adapters
 * with a scripted executor, as `lifecycle.test.ts` drives restart: the fake
 * decides only what `loop-state` says about the supervisor and what the
 * control record holds, so the stop that lands is the real command file in
 * the real inbox, counted on disk.
 *
 * Then the routes, through the real handler over a real `ChatSessions`, whose
 * `claude` is a script recording its argv — so "a Fix turn runs with the
 * executor's rails" is read off what the process was started with, and
 * "every Fix turn is marked" off the transcript file in the worktree.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CHAT_COMMAND,
  chatTmpDir,
  ChatSessions,
  createChatRunner,
  EXECUTOR_SETTINGS,
  executorDenies,
  executorEnv,
  fixSettings,
  modeArgs,
  type ChatEvent,
  type ChatView,
  type SandboxRoots,
} from "./chat";
import { fixGate, stopForFix, type FixFactory } from "./chat-fix";
import { modeNotice } from "./chat-seed";
import { coderRoster, type Liveness, type RuntimeSnapshot } from "./contracts";
import { createRalphControlAdapter, type ExecResult, type Executor } from "./control-adapter";
import { bunPath } from "./fixtures";
import { createRalphLifecycleAdapter } from "./lifecycle-adapter";
import type { LifecycleDeps } from "./lifecycle";
import { createHandler } from "./server";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("drives Fix mode and Stop & fix over real child processes");

const REPO_ROOT = join(__dirname, "..");
const scratch: string[] = [];
const sessions: ChatSessions[] = [];

afterEach(() => {
  sessions.splice(0).forEach((chats) => chats.stopAll());
  scratch.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

/** A loop checkout whose logs resolve a halt to `the-session`. */
function worktree(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ralph-chat-fix-")));
  scratch.push(root);
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  writeFileSync(join(root, ".ralph", "logs", "iter-20261007T105001.log"), "rendered\n");
  writeFileSync(
    join(root, ".ralph", "logs", "supervisor-run.log"),
    "Ralph: models — orchestrator claude-opus-5 on claude\n=== Ralph iteration 7/50 (20261007T105001) session the-session ===\n",
  );
  return root;
}

interface Supervisor {
  /** Asked afresh on every liveness read. */
  liveness: () => Liveness;
  /** The control record `controls status --json` prints, or null. */
  record: () => unknown;
  /** Liveness reads so far. */
  reads: number;
  /** Called on every wait between polls, after the clock has moved. */
  onSleep: () => Promise<void>;
  /** Command files that landed in the inbox, parsed. */
  sent: () => Record<string, unknown>[];
  deps: LifecycleDeps;
}

/** The real adapters over `root`, with a scripted executor and a clock of its own. */
function supervisor(root: string, liveness: Liveness = "alive"): Supervisor {
  const state: Supervisor = {
    liveness: () => liveness,
    record: () => null,
    reads: 0,
    onSleep: async () => undefined,
    sent: () => {
      const inbox = join(root, ".ralph", "control", "inbox");
      if (!existsSync(inbox)) return [];
      return readdirSync(inbox)
        .filter((name) => name.endsWith(".json") && !name.startsWith("."))
        .map((name) => JSON.parse(readFileSync(join(inbox, name), "utf8")) as Record<string, unknown>);
    },
    deps: undefined as unknown as LifecycleDeps,
  };
  const exec: Executor = async (invocation): Promise<ExecResult> => {
    if (invocation.args.some((arg) => arg.endsWith("loop-state.ts"))) {
      state.reads += 1;
      const supervisor = state.liveness();
      return {
        status: 0,
        stdout: JSON.stringify({
          self: root,
          loops: [
            {
              worktree: root,
              worktreeStatus: "live",
              loopStatus: supervisor === "alive" ? "running" : "failed",
              branch: "ralph/254",
              state: null,
              stateProblem: null,
              supervisor,
            },
          ],
          reconciliation: { orphaned: [], prunable: [] },
        }),
        stderr: "",
      };
    }
    if (invocation.args.some((arg) => arg.endsWith("controls.ts"))) {
      const record = state.record();
      return { status: 0, stdout: record === null ? "null" : JSON.stringify(record), stderr: "" };
    }
    return { status: 127, stdout: "", stderr: `unexpected invocation: ${invocation.command}` };
  };
  let clock = Date.parse("2026-10-07T13:00:00.000Z");
  state.deps = {
    control: createRalphControlAdapter({ cliDir: root, root, bunPath: "bun", env: {}, exec }),
    lifecycle: createRalphLifecycleAdapter({ cliDir: root, root, bunPath: "bun", env: {}, exec }),
    loop: "ralph",
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
      await state.onSleep();
    },
    waitTimeoutMs: 10_000,
    pollIntervalMs: 1_000,
  };
  return state;
}

describe("the Fix gate", () => {
  it("is shut while the supervisor is alive, and says to use Stop & fix", async () => {
    const gate = await fixGate(supervisor(worktree(), "alive").deps);
    expect(gate).toMatchObject({ open: false, liveness: "alive" });
    expect(gate.why).toContain("supervisor is running");
    expect(gate.why).toContain("Stop & fix");
  });

  it("is shut when liveness cannot be read: cannot tell is not stopped", async () => {
    const h = supervisor(worktree());
    const exec = async () => ({ status: 1, stdout: "", stderr: "loop-state crashed" });
    const root = h.deps.lifecycle.worktree;
    h.deps = { ...h.deps, lifecycle: createRalphLifecycleAdapter({ cliDir: root, root, bunPath: "bun", env: {}, exec }) };
    const gate = await fixGate(h.deps);
    expect(gate).toMatchObject({ open: false, liveness: "unknown" });
    expect(gate.why).toContain("loop-state crashed");
  });

  it("opens once the supervisor is gone", async () => {
    expect(await fixGate(supervisor(worktree(), "dead").deps)).toEqual({ open: true, liveness: "dead", why: "" });
  });
});

describe("stopForFix", () => {
  it("sends one soft stop at iteration scope and answers once the supervisor has exited", async () => {
    const root = worktree();
    const h = supervisor(root);
    h.liveness = () => (h.reads >= 4 ? "dead" : "alive");
    let waiting = 0;
    const result = await stopForFix(h.deps, { key: "chat-stop-1", send: true, onWaiting: () => (waiting += 1) });

    expect(result.outcome).toBe("exited");
    expect(result.sent).toBe(true);
    expect(waiting).toBe(1);
    const sent = h.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: "chat-stop-1", command: "stop", loop: "ralph" });
    // Iteration scope is the default and is written as the ABSENCE of a scope.
    expect(sent[0]).not.toHaveProperty("scope");
  });

  it("waits on a stop already sent without sending another", async () => {
    const h = supervisor(worktree());
    h.liveness = () => (h.reads >= 3 ? "dead" : "alive");
    const result = await stopForFix(h.deps, { key: "chat-stop-1", send: false });
    expect(result).toMatchObject({ outcome: "exited", sent: false, stop: null });
    expect(h.sent()).toHaveLength(0);
  });

  it("reports a stop still pending after the window, and does not claim an exit", async () => {
    const h = supervisor(worktree(), "alive");
    const result = await stopForFix(h.deps, { key: "chat-stop-1", send: true });
    expect(result.outcome).toBe("pending");
    expect(result.why).toContain("still pending after 10s");
    expect(h.sent()).toHaveLength(1);
  });

  it("sends nothing to a supervisor that is already gone, or one it cannot see", async () => {
    const gone = supervisor(worktree(), "dead");
    expect(await stopForFix(gone.deps, { key: "k", send: true })).toMatchObject({ outcome: "exited", sent: false });
    expect(gone.sent()).toHaveLength(0);

    const unseen = supervisor(worktree(), "unknown");
    expect(await stopForFix(unseen.deps, { key: "k", send: true })).toMatchObject({ outcome: "unknown", sent: false });
    expect(unseen.sent()).toHaveLength(0);
  });

  it("stops waiting when the loop records the stop refused", async () => {
    const h = supervisor(worktree(), "alive");
    h.record = () => ({
      version: 1,
      ralphRun: "run-1",
      loop: "ralph",
      applied: [{ key: "chat-stop-1", command: "stop", outcome: "needs-reconfirmation", at: "T", why: "names a replaced run" }],
      deferrals: [],
      hold: null,
      stop: null,
    });
    const result = await stopForFix(h.deps, { key: "chat-stop-1", send: false });
    expect(result.outcome).toBe("refused");
    expect(result.why).toContain("needs-reconfirmation");
  });
});

/* ------------------------------------------------------------------------- *
 * The routes.
 * ------------------------------------------------------------------------- */

function runtimeFor(root: string): RuntimeSnapshot {
  return {
    roster: coderRoster("ralph", "rafa"),
    loops: [
      {
        worktree: root,
        identity: "ralph",
        loopStatus: "failed",
        worktreeStatus: "live",
        branch: "ralph/254",
        state: {
          version: 1,
          run: "ralph-run-1",
          owner: { loop: "ralph", pid: null, host: "test" },
          worktree: root,
          branch: "ralph/254",
          stage: "iteration",
          iteration: { index: 7, max: 50 },
          heartbeat: "2026-10-07T13:00:00.000Z",
          lastEvent: null,
          stopReason: { kind: "failed", why: "see .ralph/logs/iter-20261007T105001.log", at: "2026-10-07T13:00:00.000Z" },
        },
        stateProblem: null,
        supervisor: "dead",
        presence: null,
      },
    ],
    reconciliation: { orphaned: [], prunable: [] },
  };
}

interface Rig {
  root: string;
  sup: Supervisor;
  handler: (request: Request) => Promise<Response>;
  argv: (turn: number) => string[];
  stdinOf: (turn: number) => string;
  turns: () => number;
}

/** The real handler, a real `ChatSessions`, and a `claude` that records its argv. */
function rig(options: { fix?: boolean } = {}): Rig {
  const root = worktree();
  const dir = join(root, "..", `${root.split("/").at(-1)}-bin`);
  mkdirSync(dir);
  scratch.push(dir);
  const argvDir = join(dir, "argv");
  mkdirSync(argvDir);
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      `f="$(printf '%s/argv-%03d' "${argvDir}" "$(ls "${argvDir}" | grep -vc '\\.')")"`,
      'printf "%s\\n" "$@" > "$f"',
      'cat > "$f.stdin"',
      `printf '{"type":"system","subtype":"init","session_id":"forked"}\\n'`,
      `printf '{"type":"assistant","text":"fixed"}\\n'`,
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  const chats = new ChatSessions({
    claude: (args, cwd) => spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] }),
    redactor: () => spawn("cat", [], { stdio: ["pipe", "pipe", "pipe"] }),
    harness: REPO_ROOT,
  });
  sessions.push(chats);
  const sup = supervisor(root);
  const factory: FixFactory = () => {
    const { loop: _loop, ...rest } = sup.deps;
    return rest;
  };
  const handler = createHandler({
    adapter: { read: async () => runtimeFor(root) },
    shell: "<html></html>",
    clock: () => ({ nowMs: Date.parse("2026-10-07T13:00:00.000Z") }),
    chats,
    ...(options.fix === false ? {} : { lifecycle: factory as never }),
  });
  const names = (): string[] => readdirSync(argvDir).filter((name) => !name.includes(".")).sort();
  return {
    root,
    sup,
    handler,
    argv: (turn) => readFileSync(join(argvDir, names()[turn]!), "utf8").replace(/\n$/, "").split("\n"),
    stdinOf: (turn) => readFileSync(join(argvDir, `${names()[turn]!}.stdin`), "utf8"),
    turns: () => names().length,
  };
}

const call = async <T,>(rig: Rig, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
  const response = await rig.handler(
    new Request(`http://127.0.0.1${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }),
  );
  const text = await response.text();
  // A 405 answers in plain words, as every other route here does.
  try {
    return { status: response.status, body: (text === "" ? null : JSON.parse(text)) as T };
  } catch {
    return { status: response.status, body: text as T };
  }
};

async function open(r: Rig): Promise<string> {
  const started = await call<{ id: string }>(r, "POST", "/api/chat", { loop: "ralph" });
  expect(started.status).toBe(201);
  return started.body.id;
}

/** Send a turn and wait for it to end. */
async function turn(r: Rig, id: string, text: string): Promise<void> {
  const sent = await call(r, "POST", `/api/chat/${id}/turn`, { text });
  expect(sent.status).toBe(202);
  for (let after = 0; ; ) {
    const page = await call<{ events: ChatEvent[]; next: number; status: string }>(r, "GET", `/api/chat/${id}/events?after=${after}`);
    after = page.body.next;
    if (page.body.status !== "running") {
      expect(page.body.status).toBe("idle");
      return;
    }
  }
}

const view = async (r: Rig, id: string): Promise<ChatView> => (await call<ChatView>(r, "GET", `/api/chat/${id}`)).body;
const transcript = (r: Rig, id: string): ChatEvent[] =>
  readFileSync(join(r.root, ".ralph", "logs", `chat-${id}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ChatEvent);

/** What a chat in this rig is sandboxed around: its worktree, the harness, its own temp dir. */
const rootsOf = (r: Rig, id: string): SandboxRoots => ({
  worktree: r.root,
  harness: REPO_ROOT,
  gitDirs: { own: null, common: null },
  tmp: chatTmpDir(id),
  tools: [],
});

/** The rails a Fix turn must carry: the executor's flags, its whole deny list and the sandbox in the settings. */
const FIX_RAILS = (r: Rig, id: string): string[] => {
  const executor = executorDenies(readFileSync(join(REPO_ROOT, EXECUTOR_SETTINGS), "utf8"));
  return ["-p", ...CHAT_COMMAND.fix, ...modeArgs("fix", REPO_ROOT, executor, rootsOf(r, id))];
};

describe("Fix mode over HTTP", () => {
  it("is refused, with the reason, while the loop's supervisor is alive", async () => {
    const r = rig();
    const id = await open(r);
    const refused = await call<{ error: string; message: string }>(r, "POST", `/api/chat/${id}/mode`, { mode: "fix", confirm: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("SupervisorAlive");
    expect(refused.body.message).toContain("ralph's supervisor is running");
    expect((await view(r, id)).mode).toBe("ask");

    // An Ask turn still runs, under Ask's rails.
    await turn(r, id, "why are you blocked?");
    expect(r.argv(0).slice(0, CHAT_COMMAND.args.length + 1)).toEqual(["-p", ...CHAT_COMMAND.args]);
    expect(r.argv(0)).not.toContain("--dangerously-skip-permissions");
  });

  it("asks for a confirmation, and refuses a mode it does not know", async () => {
    const r = rig();
    r.sup.liveness = () => "dead";
    const id = await open(r);
    const unconfirmed = await call<{ error: string }>(r, "POST", `/api/chat/${id}/mode`, { mode: "fix" });
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.error).toBe("ConfirmationRequired");
    expect((await call(r, "POST", `/api/chat/${id}/mode`, { mode: "yolo", confirm: true })).status).toBe(400);
    expect((await call(r, "GET", `/api/chat/${id}/mode`)).status).toBe(405);
    expect((await view(r, id)).mode).toBe("ask");
  });

  it("is refused when the dashboard cannot read the supervisor at all", async () => {
    const r = rig({ fix: false });
    const id = await open(r);
    const refused = await call<{ error: string }>(r, "POST", `/api/chat/${id}/mode`, { mode: "fix", confirm: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("FixUnavailable");
  });

  it("once the supervisor has exited, runs every Fix turn with the executor's rails, and marks each one", async () => {
    const r = rig();
    const id = await open(r);
    r.sup.liveness = () => "dead";

    const switched = await call<ChatView>(r, "POST", `/api/chat/${id}/mode`, { mode: "fix", confirm: true });
    expect(switched.status).toBe(200);
    expect(switched.body.mode).toBe("fix");

    await turn(r, id, "regenerate the baseline");
    await turn(r, id, "and commit it locally");

    // The executor's flags and its deny list, exactly — no Ask allowlist, no
    // `--tools`, no `--add-dir` — then the session, as any turn carries it.
    expect(r.argv(0)).toEqual([...FIX_RAILS(r, id), "--resume", "the-session", "--fork-session"]);
    expect(r.argv(1)).toEqual([...FIX_RAILS(r, id), "--resume", "forked"]);
    const settings = JSON.parse(r.argv(0)[r.argv(0).indexOf("--settings") + 1]!) as { permissions: { deny: string[] } };
    for (const rule of ["Bash(git push *)", "Bash(gh *)", "Read(~/.ssh/**)", "Read(**/.env*)", "Bash(grep *)", "Agent"]) {
      expect(settings.permissions.deny).toContain(rule);
    }
    expect(r.argv(0).at(CHAT_COMMAND.fix.length + 2)).toBe(fixSettings(executorDenies(readFileSync(join(REPO_ROOT, EXECUTOR_SETTINGS), "utf8")), rootsOf(r, id)));
    // The agent is told: the seed said Ask, so the first Fix turn carries the
    // Fix notice between the seed and the operator's words — and only once.
    const first = r.stdinOf(0);
    expect(first).toContain("Mode: Ask, read-only.");
    expect(first.endsWith(`${modeNotice("fix", REPO_ROOT)}regenerate the baseline\n`)).toBe(true);
    expect(r.stdinOf(1)).toBe("and commit it locally\n");

    // The transcript says under which rails each answer was given: the switch,
    // then a `fix-turn` marker ahead of EVERY Fix turn's operator message.
    const events = transcript(r, id);
    const kinds = events.map((event) => event.kind).filter((kind) => kind !== "agent" && kind !== "seed");
    expect(kinds).toEqual(["mode", "fix-turn", "operator", "turn-end", "fix-turn", "operator", "turn-end"]);
    expect(events.find((event) => event.kind === "mode")).toMatchObject({ mode: "fix" });
    const markers = events.filter((event) => event.kind === "fix-turn");
    expect(markers.map((event) => event.mode)).toEqual(["fix", "fix"]);
    expect(markers[0]!.text).toContain(EXECUTOR_SETTINGS);
    expect(markers[0]!.text).toContain(r.root);
  });

  it("refuses a Fix turn if the loop has been started again since the switch", async () => {
    const r = rig();
    r.sup.liveness = () => "dead";
    const id = await open(r);
    expect((await call(r, "POST", `/api/chat/${id}/mode`, { mode: "fix", confirm: true })).status).toBe(200);
    r.sup.liveness = () => "alive";
    const refused = await call<{ error: string }>(r, "POST", `/api/chat/${id}/turn`, { text: "carry on" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("SupervisorAlive");
    expect(r.turns()).toBe(0);
  });

  it("goes back to Ask at any time, marked, and the next turn runs Ask's rails", async () => {
    const r = rig();
    r.sup.liveness = () => "dead";
    const id = await open(r);
    await call(r, "POST", `/api/chat/${id}/mode`, { mode: "fix", confirm: true });
    await turn(r, id, "fix it");
    // Back to Ask needs no confirmation and no supervisor check.
    r.sup.liveness = () => "alive";
    const back = await call<ChatView>(r, "POST", `/api/chat/${id}/mode`, { mode: "ask" });
    expect(back.status).toBe(200);
    expect(back.body.mode).toBe("ask");
    await turn(r, id, "what did you change?");

    expect(r.argv(0)).toContain("--dangerously-skip-permissions");
    expect(r.argv(1).slice(0, CHAT_COMMAND.args.length + 1)).toEqual(["-p", ...CHAT_COMMAND.args]);
    expect(r.argv(1)).not.toContain("--dangerously-skip-permissions");
    expect(r.stdinOf(1)).toBe(`${modeNotice("ask", REPO_ROOT)}what did you change?\n`);
    const modes = transcript(r, id).filter((event) => event.kind === "mode");
    expect(modes.map((event) => event.mode)).toEqual(["fix", "ask"]);
    expect(transcript(r, id).filter((event) => event.kind === "fix-turn")).toHaveLength(1);
  });
});

describe("Stop & fix over HTTP", () => {
  it("sends exactly one soft stop, keeps Fix locked until the supervisor exits, then switches", async () => {
    const r = rig();
    const id = await open(r);
    r.sup.liveness = () => (r.sup.reads >= 6 ? "dead" : "alive");
    // While the stop is out and the supervisor still running, Fix stays
    // locked, and a second press waits on the same stop rather than sending
    // another. Both are tried from inside the wait itself.
    const during: { mode: number; again: number; stopping: boolean }[] = [];
    r.sup.onSleep = async () => {
      if (during.length > 0) return;
      const mode = await call(r, "POST", `/api/chat/${id}/mode`, { mode: "fix", confirm: true });
      const stopping = (await view(r, id)).stopping;
      during.push({ mode: mode.status, again: 0, stopping });
    };
    const answered = await call<{ outcome: string; mode: string; stopping: boolean }>(r, "POST", `/api/chat/${id}/stop-and-fix`, {
      confirm: true,
    });

    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ outcome: "fix", mode: "fix", stopping: false });
    expect(during).toEqual([{ mode: 409, again: 0, stopping: true }]);
    const sent = r.sup.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ command: "stop", loop: "ralph" });
    expect(sent[0]).not.toHaveProperty("scope");

    // The stream told the operator what was happening, in order.
    const events = transcript(r, id).filter((event) => event.kind === "stop" || event.kind === "mode");
    expect(events.map((event) => [event.kind, event.mode])).toEqual([
      ["stop", "ask"],
      ["stop", "ask"],
      ["mode", "fix"],
    ]);
    expect(events[0]!.text).toBe("stopping — waiting for the iteration boundary");
    expect(events[1]!.text).toContain("exited at the iteration boundary");

    // Fix is unlocked: the next turn runs under the executor's rails.
    await turn(r, id, "now fix it");
    expect(r.argv(0)).toEqual([...FIX_RAILS(r, id), "--resume", "the-session", "--fork-session"]);
  });

  it("reports a stop still pending after the window, does not switch, and never sends a second", async () => {
    const r = rig();
    const id = await open(r);
    const first = await call<{ outcome: string; why: string; mode: string; stopping: boolean }>(r, "POST", `/api/chat/${id}/stop-and-fix`, {
      confirm: true,
    });
    expect(first.body).toMatchObject({ outcome: "pending", mode: "ask", stopping: true });
    expect(first.body.why).toContain("still pending");
    expect((await view(r, id)).mode).toBe("ask");

    // Pressed again: still waiting on the SAME stop.
    const second = await call<{ outcome: string }>(r, "POST", `/api/chat/${id}/stop-and-fix`, { confirm: true });
    expect(second.body.outcome).toBe("pending");
    expect(r.sup.sent()).toHaveLength(1);

    // And when the boundary does come, the third press switches — one stop in all.
    r.sup.liveness = () => "dead";
    const third = await call<{ outcome: string; mode: string }>(r, "POST", `/api/chat/${id}/stop-and-fix`, { confirm: true });
    expect(third.body).toMatchObject({ outcome: "fix", mode: "fix" });
    expect(r.sup.sent()).toHaveLength(1);
    const pending = transcript(r, id).filter((event) => event.kind === "stop" && event.text.includes("still pending"));
    expect(pending).toHaveLength(2);
    for (const event of pending) expect(event.text).toContain("still in Ask");
  });

  it("switches at once, sending nothing, when the loop is already stopped", async () => {
    const r = rig();
    r.sup.liveness = () => "dead";
    const id = await open(r);
    const answered = await call<{ outcome: string; mode: string }>(r, "POST", `/api/chat/${id}/stop-and-fix`, { confirm: true });
    expect(answered.body).toMatchObject({ outcome: "fix", mode: "fix" });
    expect(r.sup.sent()).toHaveLength(0);
    expect(transcript(r, id).some((event) => event.text === "stopping — waiting for the iteration boundary")).toBe(false);
  });

  it("asks for a confirmation before it stops anything", async () => {
    const r = rig();
    const id = await open(r);
    const unconfirmed = await call<{ error: string }>(r, "POST", `/api/chat/${id}/stop-and-fix`, {});
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.error).toBe("ConfirmationRequired");
    expect(r.sup.sent()).toHaveLength(0);
  });
});

describe("a Fix turn's environment", () => {
  it("is the executor's cleared allowlist, led by the executor guard, with nothing else of the dashboard's", () => {
    const env = executorEnv(
      { PATH: "/usr/bin", HOME: "/home/op", TERM: "", GH_TOKEN: "ghp_secret", DOPPLER_TOKEN: "dp.st.x", XDG_CONFIG_HOME: "/x", CLAUDE_CONFIG_DIR: "/c" },
      "/ralph",
    );
    expect(env).toEqual({
      PATH: "/ralph/executor-guard/bin:/usr/bin",
      HOME: "/home/op",
      TERM: "dumb",
      LANG: "C.UTF-8",
      XDG_CONFIG_HOME: "/x",
      CLAUDE_CONFIG_DIR: "/c",
    });
  });

  it("is what the server's runner starts a Fix turn's `claude` with; an Ask turn keeps the dashboard's", async () => {
    // The server's own runner, with a fake `claude` first on its PATH and a
    // canary in its environment that stands for a dashboard secret.
    const r = rig();
    const bin = join(r.root, "..", `${r.root.split("/").at(-1)}-path`);
    mkdirSync(bin);
    scratch.push(bin);
    const dump = join(bin, "env");
    writeFileSync(
      join(bin, "claude"),
      [
        "#!/usr/bin/env bash",
        `env >> "${dump}"`,
        `echo "=== end" >> "${dump}"`,
        "cat > /dev/null",
        `printf '{"type":"system","subtype":"init","session_id":"forked"}\\n'`,
      ].join("\n"),
    );
    chmodSync(join(bin, "claude"), 0o755);
    const chats = new ChatSessions(
      createChatRunner({ bunPath: bunPath(), cliDir: REPO_ROOT, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, CHAT_FIX_CANARY: "canary" } }),
    );
    sessions.push(chats);
    const started = chats.start({ name: "ralph", worktree: r.root, stopReason: null }, { kind: "halt" });
    const settle = async (): Promise<void> => {
      for (let after = 0; ; ) {
        const page = await chats.waitSince(started.id, after, 10_000);
        after = page.next;
        if (page.status !== "running") return;
      }
    };
    chats.send(started.id, "ask first");
    await settle();
    chats.setMode(started.id, "fix", "test");
    chats.send(started.id, "then fix");
    await settle();

    const [ask, fix] = readFileSync(dump, "utf8").split("=== end\n");
    expect(ask).toContain("CHAT_FIX_CANARY=canary");
    expect(fix).not.toContain("CHAT_FIX_CANARY");
    expect(fix).toContain(`PATH=${join(REPO_ROOT, "executor-guard", "bin")}:${bin}:`);
  });
});

const claudeOnPath = spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).status === 0;
const LIVE = process.env.RALPH_TEST_LIVE_CLAUDE === "1" && claudeOnPath;

/**
 * Against the REAL `claude`, opt-in as `chat-ask.test.ts`'s live tests are:
 * what is tested is the CLI honouring a settings deny under the bypass, which
 * a fake cannot stand in for. Run it after touching `CHAT_COMMAND.fix`,
 * `fixSettings` or the executor's settings, or after upgrading the CLI.
 */
describe.skipIf(!LIVE)("a Fix turn, against the real claude", () => {
  it(
    "edits the worktree, and is still refused the executor's denies and Ask's secret reads",
    async () => {
      const root = worktree();
      const nonce = Math.random().toString(36).slice(2);
      const mark = `DOTENV-FIXTURE-${nonce}`;
      writeFileSync(join(root, ".env"), `${mark}\n`);
      const chats = new ChatSessions(createChatRunner({ bunPath: bunPath(), cliDir: REPO_ROOT }));
      sessions.push(chats);
      const started = chats.start({ name: "ralph", worktree: root, stopReason: null }, { kind: "halt" });
      chats.setMode(started.id, "fix", "live test");
      chats.send(
        started.id,
        [
          "I am testing this chat's Fix rails and need every attempt made, one tool call each, without working around a refusal:",
          "1. Create the file fixed.txt containing the word fixed.",
          "2. Bash: grep -r FIXTURE .",
          "3. Read the file .env in this directory.",
          "4. Bash: gh auth status",
          "Then say in one line what was refused.",
        ].join("\n"),
      );
      for (let after = 0; ; ) {
        const page = await chats.waitSince(started.id, after, 60_000);
        after = page.next;
        if (page.status !== "running") break;
      }
      const events = chats.view(started.id).events;
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
      expect(init?.permissionMode).toBe("bypassPermissions");
      // The edit the executor could make, made.
      expect(readFileSync(join(root, "fixed.txt"), "utf8")).toContain("fixed");
      // And nothing of the `.env` reached the stream, by any tool.
      expect(events.map((event) => event.text).join("\n")).not.toContain(mark);
      const result = stream.find((event) => event.type === "result") as { permission_denials?: unknown[] } | undefined;
      expect(result?.permission_denials?.length ?? 0).toBeGreaterThan(0);
    },
    240_000,
  );
});
