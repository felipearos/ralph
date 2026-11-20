// @vitest-environment node
/**
 * Lifecycle dispatch — `start` and `restart-to-apply` — driven through a
 * recording executor.
 *
 * The real control and lifecycle adapters build every invocation, so the argv
 * asserted is the one the GUI would run; the fake executor only decides what
 * each subprocess answers. That is what lets the restart ordering be asserted
 * exactly: which record read showed a confirmed stop, which liveness read
 * showed the supervisor gone, and that `start.sh` ran only after both.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { Liveness } from "./contracts";
import {
  createRalphControlAdapter,
  type ControlAdapter,
  type ExecResult,
  type Invocation,
} from "./control-adapter";
import { createRalphLifecycleAdapter, parseLoopState, parseSupervisor } from "./lifecycle-adapter";
import { restartToApply, resumeWork, start, type LifecycleDeps } from "./lifecycle";
import { createRecordingExecutor } from "./recording-executor";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Kind = "start" | "liveness" | "record" | "send" | "git" | "other";

/** The pseudo-command a delivery into the loop's inbox is logged as. */
const INBOX = "<inbox>";

/**
 * The control adapter, with each inbox delivery logged as a `send` call beside
 * the subprocesses — so ordering assertions see the command where it happened.
 * The payload is the file that actually landed, read back.
 */
const recordingDelivery = (
  adapter: ControlAdapter,
  root: string,
  log: (invocation: Invocation, delivered: { accepted: boolean; why: string }) => void,
): ControlAdapter => ({
  ...adapter,
  deliver: (input) => {
    const delivered = adapter.deliver(input);
    const file = join(root, ".ralph", "control", "inbox", `${input.key}.json`);
    const control: unknown = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    log({ command: INBOX, args: ["--payload", JSON.stringify({ control })], cwd: root, env: {} }, delivered);
    return delivered;
  },
});

const kindOf = (invocation: Invocation): Kind => {
  if (invocation.command.endsWith("start.sh")) return "start";
  if (invocation.args.some((arg) => arg.endsWith("loop-state.ts"))) return "liveness";
  if (invocation.args.some((arg) => arg.endsWith("controls.ts"))) return "record";
  if (invocation.command === INBOX) return "send";
  if (invocation.command === "git") return "git";
  return "other";
};

interface Script {
  /** The supervisor's liveness, asked afresh on every read. */
  liveness: () => Liveness;
  /** The control record `controls status --json` prints, or null. */
  record: () => unknown | null;
  startResult: ExecResult;
  gitStatus: string;
  /** What `git log … --not --remotes` prints, or null for a git that fails. */
  unpushed: string | null;
}

interface Harness {
  root: string;
  calls: { kind: Kind; invocation: Invocation; answer: ExecResult }[];
  script: Script;
  deps: LifecycleDeps;
  /** How many control messages were sent so far. */
  sent: () => number;
  leasePath: string;
}

function harness(label: string, over: { run?: string } = {}): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `ralph-lifecycle-${label}-`)));
  roots.push(root);
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  const common = join(root, "gitcommon");
  mkdirSync(common);
  const run = over.run ?? "run-1";
  writeFileSync(
    join(root, ".ralph", "logs", "state.json"),
    JSON.stringify({
      version: 1,
      run,
      owner: { loop: "ralph", pid: 4242, host: "test" },
      worktree: root,
      branch: "ralph/13-lifecycle",
      stage: "iteration",
      iteration: { index: 2, max: 50 },
      heartbeat: "2026-09-15T00:00:00.000Z",
      lastEvent: null,
      stopReason: null,
    }),
  );

  const script: Script = {
    liveness: () => "alive",
    record: () => null,
    startResult: {
      status: 0,
      stdout: "Started Ralph supervisor (pid 5151); waits 300s, runs up to 50 iterations.\nLog: .ralph/logs/loop.stdout\n",
      stderr: "",
    },
    gitStatus: "",
    unpushed: "",
  };

  const is = (kind: Kind) => (invocation: Invocation) => kindOf(invocation) === kind;
  const ok = (stdout: string): ExecResult => ({ status: 0, stdout, stderr: "" });
  // Every answer is a function so it reads `script` at call time: tests
  // re-script between steps by mutating it.
  const recorder = createRecordingExecutor()
    .on(is("start"), () => script.startResult)
    .on(is("liveness"), () =>
      ok(
        JSON.stringify({
          self: root,
          loops: [
            {
              worktree: root,
              worktreeStatus: "live",
              loopStatus: "running",
              branch: "ralph/13-lifecycle",
              state: null,
              stateProblem: null,
              supervisor: script.liveness(),
            },
          ],
          reconciliation: { orphaned: [], prunable: [] },
        }),
      ),
    )
    .on(is("record"), () => {
      const record = script.record();
      return ok(record === null ? "null" : JSON.stringify(record));
    })
    .on({ command: "git", args: ["status"] }, () => ok(script.gitStatus))
    .on({ command: "git", args: ["rev-parse"] }, ok(`${common}\n`))
    .on({ command: "git", args: ["symbolic-ref"] }, ok("ralph/13-lifecycle\n"))
    .on({ command: "git", args: ["log"] }, () =>
      script.unpushed === null ? { status: 128, stdout: "", stderr: "fatal: bad revision" } : ok(script.unpushed),
    )
    .on({ command: "git" }, { status: 1, stdout: "", stderr: "unexpected git" });

  // The recorder holds the one ordered sequence (exec calls and inbox sends
  // alike); the harness only tags each entry with its kind. Nothing here
  // scripts a throw, so every recorded answer is present.
  const calls = (): Harness["calls"] =>
    recorder.calls.map((call) => ({ kind: kindOf(call.invocation), invocation: call.invocation, answer: call.answer! }));

  let clock = Date.parse("2026-09-15T12:00:00.000Z");
  const env = {};
  return {
    root,
    get calls() {
      return calls();
    },
    script,
    leasePath: join(common, "ralph-claim-leases.json"),
    sent: () => calls().filter((call) => call.kind === "send").length,
    deps: {
      control: recordingDelivery(
        createRalphControlAdapter({ cliDir: root, root, bunPath: "bun", env, exec: recorder.exec }),
        root,
        (invocation, delivered) =>
          recorder.record(invocation, { status: delivered.accepted ? 0 : 1, stdout: "", stderr: delivered.why }),
      ),
      lifecycle: createRalphLifecycleAdapter({ cliDir: root, root, bunPath: "bun", env, exec: recorder.exec }),
      loop: "ralph",
      now: () => new Date(clock),
      sleep: async (ms) => {
        clock += ms;
      },
      waitTimeoutMs: 10_000,
      pollIntervalMs: 1_000,
    },
  };
}

const stopRecord = (key: string, confirmation: "confirmed" | "unreachable" | "pending", run = "run-1") => ({
  version: 1,
  ralphRun: run,
  loop: "ralph",
  applied: [{ key, command: "stop", outcome: "applied", at: "T", why: "stopping" }],
  deferrals: [],
  hold: null,
  stop: { kind: "blocked", confirmation, why: "apply lineup", at: "T", key },
});

const controlOf = (invocation: Invocation): Record<string, unknown> => {
  const raw = invocation.args[invocation.args.indexOf("--payload") + 1] ?? "{}";
  return (JSON.parse(raw) as { control: Record<string, unknown> }).control;
};

const kinds = (h: Harness): Kind[] => h.calls.map((call) => call.kind);

describe("start", () => {
  it("runs start.sh at the configured root in the loop's worktree", async () => {
    const h = harness("start");
    const result = await start(h.deps, { loop: "ralph" });

    const invocations = h.calls.filter((call) => call.kind === "start");
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.invocation.command).toBe(join(h.root, "start.sh"));
    expect(invocations[0]!.invocation.args).toEqual([]);
    expect(invocations[0]!.invocation.cwd).toBe(h.root);
    expect(result).toMatchObject({ loop: "ralph", worktree: h.root, outcome: "started", pid: 5151 });
  });

  it("surfaces the worktree lock's answer as an idempotent already-running no-op", async () => {
    const h = harness("already");
    h.script.startResult = { status: 0, stdout: "Ralph supervisor already running (pid 4242).\n", stderr: "" };
    const result = await start(h.deps, { loop: "ralph" });
    expect(result).toMatchObject({ outcome: "already-running", pid: 4242 });
    expect(result.why).toContain("already running");
  });

  it("reports a start.sh that refused, with its reason", async () => {
    const h = harness("start-fails");
    h.script.startResult = {
      status: 1,
      stdout: "",
      stderr: "Ralph supervisor exited during startup (status 3); see .ralph/logs/loop.stdout.\n",
    };
    const result = await start(h.deps, { loop: "ralph" });
    expect(result.outcome).toBe("failed");
    expect(result.why).toContain("exited during startup");
  });

  it("does not start a loop it does not serve", async () => {
    const h = harness("start-other");
    const result = await start(h.deps, { loop: "rafa" });
    expect(result.outcome).toBe("not-for-this-loop");
    expect(h.calls).toHaveLength(0);
  });
});

describe("restart-to-apply", () => {
  it("stops the observed run, waits for a confirmed stop and a gone supervisor, then starts", async () => {
    const h = harness("restart");
    let reads = 0;
    let exited = false;
    h.script.record = () => {
      if (h.sent() === 0) return null;
      reads += 1;
      // Not yet polled, then recorded pending by nobody, then confirmed by the
      // supervisor that is about to exit.
      if (reads === 1) return null;
      if (reads === 2) return stopRecord("r-1", "pending");
      return stopRecord("r-1", "confirmed");
    };
    h.script.liveness = () => {
      if (reads >= 4) exited = true;
      return exited ? "dead" : "alive";
    };

    const result = await restartToApply(h.deps, { loop: "ralph", id: "r-1", why: "apply lineup" });

    expect(result.outcome).toBe("started");
    expect(result.halt).toBeNull();
    expect(result.confirmation).toBe("confirmed");
    expect(result.start).toMatchObject({ outcome: "started", pid: 5151 });

    const send = h.calls.find((call) => call.kind === "send")!;
    expect(controlOf(send.invocation)).toMatchObject({
      command: "stop",
      id: "r-1",
      loop: "ralph",
      run: "run-1",
      stop: "blocked",
      why: "apply lineup",
    });

    // start.sh ran exactly once, after the send, after a record read showing
    // the stop confirmed, and after a liveness read showing the supervisor gone.
    const order = kinds(h);
    const startAt = order.indexOf("start");
    expect(order.filter((kind) => kind === "start")).toHaveLength(1);
    expect(startAt).toBeGreaterThan(order.indexOf("send"));
    const before = h.calls.slice(0, startAt);
    expect(before.some((call) => call.kind === "liveness" && call.answer.stdout.includes('"dead"'))).toBe(true);
    expect(
      before.some((call) => call.kind === "record" && call.answer.stdout.includes('"confirmed"')),
    ).toBe(true);
    expect(h.calls[startAt - 1]!.kind).not.toBe("send");
  });

  it("carries the chosen stop kind", async () => {
    const h = harness("restart-kind");
    let confirmed = false;
    h.script.record = () => {
      if (h.sent() === 0) return null;
      confirmed = true;
      return { ...stopRecord("k", "confirmed"), stop: { ...stopRecord("k", "confirmed").stop, kind: "completed" } };
    };
    h.script.liveness = () => (confirmed ? "dead" : "alive");
    const result = await restartToApply(h.deps, { loop: "ralph", id: "k", stopKind: "completed" });
    expect(result.outcome).toBe("started");
    expect(controlOf(h.calls.find((call) => call.kind === "send")!.invocation)).toMatchObject({
      stop: "completed",
    });
  });

  it("waits for the supervisor to exit after a confirmed stop, and halts if it never does", async () => {
    const h = harness("restart-lingers");
    h.script.record = () => (h.sent() === 0 ? null : stopRecord("k", "confirmed"));
    h.script.liveness = () => "alive";
    const result = await restartToApply(h.deps, { loop: "ralph", id: "k" });
    expect(result).toMatchObject({ outcome: "halted", halt: "supervisor-running", confirmation: "confirmed" });
    expect(kinds(h)).not.toContain("start");
  });

  it("refuses to start while the stop is unreachable", async () => {
    const h = harness("restart-unreachable");
    h.script.record = () => (h.sent() === 0 ? null : stopRecord("k", "unreachable"));
    h.script.liveness = () => "alive";
    const result = await restartToApply(h.deps, { loop: "ralph", id: "k" });
    expect(result).toMatchObject({ outcome: "halted", halt: "stop-unreachable", confirmation: "unreachable" });
    expect(result.why).toContain("unreachable");
    expect(result.start).toBeNull();
    expect(kinds(h)).not.toContain("start");
  });

  it("refuses to start while the stop is still pending at the deadline", async () => {
    const h = harness("restart-pending");
    h.script.record = () => (h.sent() === 0 ? null : stopRecord("k", "pending"));
    h.script.liveness = () => "alive";
    const result = await restartToApply(h.deps, { loop: "ralph", id: "k" });
    expect(result).toMatchObject({ outcome: "halted", halt: "stop-pending", confirmation: "pending" });
    expect(kinds(h)).not.toContain("start");
  });

  it("refuses to start when the supervisor exits without confirming the stop", async () => {
    const h = harness("restart-exit-unconfirmed");
    h.script.record = () => (h.sent() === 0 ? null : stopRecord("k", "pending"));
    let alive = true;
    h.script.liveness = () => {
      const now = alive;
      if (h.sent() > 0) alive = false;
      return now ? "alive" : "dead";
    };
    const result = await restartToApply(h.deps, { loop: "ralph", id: "k" });
    expect(result).toMatchObject({ outcome: "halted", halt: "stop-pending" });
    expect(kinds(h)).not.toContain("start");
  });

  it("halts when the loop records the stop as refused", async () => {
    const h = harness("restart-recorded-refusal");
    h.script.record = () =>
      h.sent() === 0
        ? null
        : {
            version: 1,
            ralphRun: "run-2",
            loop: "ralph",
            applied: [{ key: "k", command: "stop", outcome: "needs-reconfirmation", at: "T", why: "run-2 replaced it" }],
            deferrals: [],
          };
    const result = await restartToApply(h.deps, { loop: "ralph", id: "k" });
    expect(result).toMatchObject({ outcome: "halted", halt: "stop-refused" });
    expect(result.why).toContain("needs-reconfirmation");
    expect(kinds(h)).not.toContain("start");
  });

  it("refuses a restart naming a replaced run without sending or starting anything", async () => {
    const h = harness("restart-stale", { run: "run-2" });
    const result = await restartToApply(h.deps, { loop: "ralph", run: "run-1", id: "k" });
    expect(result).toMatchObject({ outcome: "halted", halt: "stop-refused" });
    expect(result.stop?.outcome).toBe("needs-reconfirmation");
    expect(h.sent()).toBe(0);
    expect(kinds(h)).not.toContain("start");
  });

  it("does not guess when the supervisor's liveness cannot be seen", async () => {
    const h = harness("restart-unknown");
    h.script.liveness = () => "unknown";
    const result = await restartToApply(h.deps, { loop: "ralph", id: "k" });
    expect(result).toMatchObject({ outcome: "halted", halt: "supervisor-unknown" });
    expect(h.sent()).toBe(0);
    expect(kinds(h)).not.toContain("start");
  });

  it("starts a loop whose supervisor is already gone without sending a stop", async () => {
    const h = harness("restart-idle");
    h.script.liveness = () => "dead";
    const result = await restartToApply(h.deps, { loop: "ralph", id: "k" });
    expect(result).toMatchObject({ outcome: "started", halt: null, stop: null });
    expect(result.why).toContain("not running");
    expect(h.sent()).toBe(0);
  });

  it("refuses to start over an old stop that is still unconfirmed, even with no supervisor", async () => {
    // A new supervisor would adopt that stop and exit at its first checkpoint.
    const h = harness("restart-old-stop");
    h.script.liveness = () => "dead";
    h.script.record = () => stopRecord("old", "unreachable");
    const result = await restartToApply(h.deps, { loop: "ralph", id: "k" });
    expect(result).toMatchObject({ outcome: "halted", halt: "stop-unreachable" });
    expect(h.sent()).toBe(0);
    expect(kinds(h)).not.toContain("start");
  });

  it("does not answer a loop it does not serve", async () => {
    const h = harness("restart-other");
    const result = await restartToApply(h.deps, { loop: "remo", id: "k" });
    expect(result.outcome).toBe("not-for-this-loop");
    expect(h.calls).toHaveLength(0);
  });
});

describe("recovery work in the worktree", () => {
  it("reports a dirty, mid-ticket checkout and repairs nothing", async () => {
    const h = harness("dirty");
    h.script.gitStatus = " M app.ts\n?? recovery-notes.md\n";
    const leases = {
      version: 1,
      leases: {
        "13": { issue: 13, run: "run-1", loop: "ralph", worktree: h.root, branch: "ralph/13-lifecycle" },
        "14": { issue: 14, run: "run-x", loop: "rafa", worktree: "/elsewhere", branch: null },
      },
    };
    writeFileSync(h.leasePath, JSON.stringify(leases));
    let confirmed = false;
    h.script.record = () => {
      if (h.sent() === 0) return null;
      confirmed = true;
      return stopRecord("k", "confirmed");
    };
    h.script.liveness = () => (confirmed ? "dead" : "alive");

    const result = await restartToApply(h.deps, { loop: "ralph", id: "k" });

    expect(result.outcome).toBe("started");
    expect(result.checkout).toMatchObject({
      worktree: h.root,
      branch: "ralph/13-lifecycle",
      dirty: true,
      changes: [" M app.ts", "?? recovery-notes.md"],
      midTicket: true,
      claims: [{ issue: 13, run: "run-1", loop: "ralph", branch: "ralph/13-lifecycle" }],
    });
    // Every git call is a read; nothing resets, checks out, cleans or stashes.
    for (const call of h.calls.filter((entry) => entry.kind === "git")) {
      expect(["status", "rev-parse", "symbolic-ref", "log"]).toContain(call.invocation.args[0]);
    }
    for (const call of h.calls) {
      const argv = [call.invocation.command, ...call.invocation.args].join(" ");
      expect(argv).not.toMatch(/\b(reset|checkout|clean|stash|restore|worktree remove|prune)\b/);
    }
    expect(JSON.parse(readFileSync(h.leasePath, "utf8"))).toEqual(leases);
  });

  it("reports the commits no remote has, and says when git cannot tell", async () => {
    const h = harness("unpushed");
    h.script.liveness = () => "dead";
    h.script.unpushed = "abc1234 feat: half of #13\ndef5678 test: the other half\n";
    const result = await restartToApply(h.deps, { loop: "ralph", id: "k" });
    expect(result.checkout?.unpushed).toEqual(["abc1234 feat: half of #13", "def5678 test: the other half"]);
    const log = h.calls.find((call) => call.kind === "git" && call.invocation.args[0] === "log")!;
    expect(log.invocation.args).toEqual(["log", "--format=%h %s", "--max-count=50", "HEAD", "--not", "--remotes"]);

    const blind = harness("unpushed-unknown");
    blind.script.liveness = () => "dead";
    blind.script.unpushed = null;
    expect((await restartToApply(blind.deps, { loop: "ralph", id: "k" })).checkout?.unpushed).toBeNull();
  });

  it("reports a clean checkout with no claim as not mid-ticket", async () => {
    const h = harness("clean");
    h.script.liveness = () => "dead";
    const result = await restartToApply(h.deps, { loop: "ralph", id: "k" });
    expect(result.checkout).toMatchObject({ dirty: false, changes: [], midTicket: false, claims: [] });
  });
});

describe("resume work", () => {
  const interrupted = (confirmation: "confirmed" | "pending" = "confirmed") => ({
    ...stopRecord("now-1", confirmation),
    stop: { kind: "interrupted", confirmation, why: "stopped now", at: "T", key: "now-1", iteration: 2, issue: 13 },
  });

  it("starts in the same worktree without letting the supervisor move HEAD, and says what it kept", async () => {
    const h = harness("resume");
    h.script.liveness = () => "dead";
    h.script.record = () => interrupted();
    h.script.gitStatus = " M app.ts\n";
    h.script.unpushed = "abc1234 feat: half of #13\n";
    const result = await resumeWork(h.deps, { loop: "ralph" });

    expect(result).toMatchObject({ action: "resume-work", outcome: "started", pid: 5151, worktree: h.root });
    expect(result.checkout).toMatchObject({ branch: "ralph/13-lifecycle", dirty: true, unpushed: ["abc1234 feat: half of #13"] });
    const started = h.calls.filter((call) => call.kind === "start");
    expect(started).toHaveLength(1);
    expect(started[0]!.invocation.cwd).toBe(h.root);
    expect(started[0]!.invocation.env.RALPH_RESUME_WORK).toBe("1");
    // The one ticket whose lapsed claim the resumed run may pick back up.
    expect(started[0]!.invocation.env.RALPH_RESUME_ISSUE).toBe("13");
    expect(started[0]!.invocation.env.RALPH_RUN_ID).toBeUndefined();
    for (const call of h.calls) {
      const argv = [call.invocation.command, ...call.invocation.args].join(" ");
      expect(argv).not.toMatch(/\b(reset|checkout|clean|stash|restore|switch)\b/);
    }
  });

  it("an ordinary start never asks to keep HEAD", async () => {
    const h = harness("start-plain");
    await start(h.deps, { loop: "ralph" });
    expect(h.calls.find((call) => call.kind === "start")!.invocation.env.RALPH_RESUME_WORK).toBeUndefined();
    expect(h.calls.find((call) => call.kind === "start")!.invocation.env.RALPH_RESUME_ISSUE).toBeUndefined();
  });

  it("refuses while a supervisor runs, or while nobody can tell, starting nothing", async () => {
    for (const liveness of ["alive", "unknown"] as const) {
      const h = harness(`resume-${liveness}`);
      h.script.liveness = () => liveness;
      const result = await resumeWork(h.deps, { loop: "ralph" });
      expect(result.outcome).toBe("refused");
      expect(h.calls.filter((call) => call.kind === "start")).toHaveLength(0);
    }
  });

  it("refuses over a stop nobody confirmed, which the new supervisor would adopt and exit on", async () => {
    const h = harness("resume-pending");
    h.script.liveness = () => "dead";
    h.script.record = () => interrupted("pending");
    const result = await resumeWork(h.deps, { loop: "ralph" });
    expect(result.outcome).toBe("refused");
    expect(result.why).toContain("pending");
    expect(h.calls.filter((call) => call.kind === "start")).toHaveLength(0);
  });

  it("resumes only over a Stop now: any other ending is an ordinary start's", async () => {
    for (const record of [null, stopRecord("s-1", "confirmed")]) {
      const h = harness("resume-not-interrupted");
      h.script.liveness = () => "dead";
      h.script.record = () => record;
      const result = await resumeWork(h.deps, { loop: "ralph" });
      expect(result.outcome).toBe("refused");
      expect(result.why).toContain("Start");
      expect(h.calls.filter((call) => call.kind === "start")).toHaveLength(0);
    }
  });

  it("does not resume a loop it does not serve", async () => {
    const h = harness("resume-other");
    expect((await resumeWork(h.deps, { loop: "rafa" })).outcome).toBe("not-for-this-loop");
    expect(h.calls).toHaveLength(0);
  });
});

describe("one reading of loop-state", () => {
  // The restart decision in `reconcile.ts` needs the liveness AND the ending
  // together; what is pinned here is that both come out of the SAME answer and
  // that every way of failing to read it is `unknown`, never `dead`.
  const answer = (root: string, over: Record<string, unknown>): ExecResult => ({
    status: 0,
    stdout: JSON.stringify({
      self: root,
      loops: [
        {
          worktree: root,
          worktreeStatus: "live",
          loopStatus: "running",
          branch: "ralph/13-lifecycle",
          state: null,
          stateProblem: null,
          supervisor: "alive",
          ...over,
        },
      ],
      reconciliation: { orphaned: [], prunable: [] },
    }),
    stderr: "",
  });
  const record = (root: string, over: Record<string, unknown> = {}) => ({
    version: 1,
    run: "ralph-run-7",
    owner: { loop: "ralph", pid: 4242, host: "test" },
    worktree: root,
    branch: "ralph/13-lifecycle",
    stage: "iteration",
    iteration: { index: 2, max: 50 },
    heartbeat: "2026-09-15T00:00:00.000Z",
    lastEvent: null,
    stopReason: null,
    ...over,
  });

  it("carries the record's ending, run and loop beside the liveness", () => {
    const root = "/w/loop";
    const mid = parseLoopState(answer(root, { state: record(root) }), root);
    expect(mid).toEqual({
      liveness: "alive",
      stopReason: null,
      run: "ralph-run-7",
      loop: "ralph",
      pid: 4242,
      recorded: true,
      why: "supervisor alive",
    });
    const stopped = parseLoopState(
      answer(root, {
        supervisor: "dead",
        loopStatus: "blocked",
        state: record(root, { stopReason: { kind: "blocked", why: "needs a human", at: "2026-09-15T01:00:00.000Z" } }),
      }),
      root,
    );
    expect(stopped.liveness).toBe("dead");
    expect(stopped.stopReason).toEqual({ kind: "blocked", why: "needs a human", at: "2026-09-15T01:00:00.000Z" });
    expect(stopped.recorded).toBe(true);
  });

  it("carries the record's last event and last iteration end, for the reconcile to tell an orderly stop from a fault", () => {
    const root = "/w/loop";
    const lastEvent = { name: "stop", at: "2026-09-15T01:00:00.000Z", detail: "operator stop-now" };
    const report = parseLoopState(
      answer(root, {
        supervisor: "dead",
        loopStatus: "failed",
        state: record(root, {
          lastEvent,
          lastIterationEndAt: "2026-09-15T00:30:00.000Z",
          stopReason: { kind: "failed", why: "stopped by operator", at: "2026-09-15T01:00:00.000Z" },
        }),
      }),
      root,
    );
    expect(report.lastEvent).toEqual(lastEvent);
    expect(report.lastIterationEndAt).toBe("2026-09-15T00:30:00.000Z");
  });

  it("leaves both out for a record that has neither, and still reads it", () => {
    const root = "/w/loop";
    const report = parseLoopState(answer(root, { state: record(root) }), root);
    expect(report.recorded).toBe(true);
    expect(report).not.toHaveProperty("lastEvent");
    expect(report).not.toHaveProperty("lastIterationEndAt");
  });

  it("reads each of them without the other", () => {
    const root = "/w/loop";
    const lastEvent = { name: "supervisor-start", at: "2026-09-15T00:00:00.000Z" };
    const eventOnly = parseLoopState(answer(root, { state: record(root, { lastEvent }) }), root);
    expect(eventOnly.lastEvent).toEqual(lastEvent);
    expect(eventOnly).not.toHaveProperty("lastIterationEndAt");
    const endOnly = parseLoopState(
      answer(root, { state: record(root, { lastIterationEndAt: "2026-09-15T00:30:00.000Z" }) }),
      root,
    );
    expect(endOnly.lastIterationEndAt).toBe("2026-09-15T00:30:00.000Z");
    expect(endOnly).not.toHaveProperty("lastEvent");
  });

  it("separates a worktree with no record from one mid-iteration", () => {
    // Both read `stopReason: null`. Only the second may ever be restarted, so
    // the difference has to be a field and not an inference.
    const root = "/w/loop";
    const bare = parseLoopState(answer(root, { state: null, stateProblem: "missing", loopStatus: "idle" }), root);
    expect(bare).toMatchObject({ liveness: "alive", stopReason: null, run: null, loop: null, pid: null, recorded: false });
  });

  it("answers unknown, never dead, for every way the read can fail", () => {
    const root = "/w/loop";
    const failures: [string, ExecResult, string][] = [
      ["a non-zero exit", { status: 1, stdout: "", stderr: "boom\n" }, "loop-state could not run: boom"],
      ["output that is not JSON", { status: 0, stdout: "not json", stderr: "" }, "loop-state did not return JSON"],
      ["a snapshot it cannot narrow", { status: 0, stdout: "{}", stderr: "" }, ""],
      ["a snapshot with no row for this worktree", answer("/w/other", {}), `loop-state reported no worktree at ${root}`],
    ];
    for (const [what, result, why] of failures) {
      const report = parseLoopState(result, root);
      expect(report.liveness, what).toBe("unknown");
      expect(report.recorded, what).toBe(false);
      expect(report.stopReason, what).toBeNull();
      if (why !== "") expect(report.why, what).toContain(why);
    }
  });

  it("gives the liveness-only callers the same reading", () => {
    const root = "/w/loop";
    const result = answer(root, { supervisor: "dead", state: record(root) });
    expect(parseSupervisor(result, root)).toEqual({ liveness: "dead", why: "supervisor dead" });
  });
});

describe("no process signal", () => {
  it("never runs a signalling command", async () => {
    const h = harness("signals");
    let confirmed = false;
    h.script.record = () => {
      if (h.sent() === 0) return null;
      confirmed = true;
      return stopRecord("k", "confirmed");
    };
    h.script.liveness = () => (confirmed ? "dead" : "alive");
    await restartToApply(h.deps, { loop: "ralph", id: "k" });
    await start(h.deps, { loop: "ralph" });
    for (const call of h.calls) {
      expect(call.invocation.command).not.toMatch(/(^|\/)(p?kill|killall)$/);
      expect(call.invocation.args.join(" ")).not.toMatch(/worker-stop|SIG[A-Z]+/);
    }
  });

  it("names no signal in the lifecycle sources", () => {
    for (const file of ["lifecycle.ts", "lifecycle-adapter.ts"]) {
      const text = readFileSync(join(__dirname, file), "utf8");
      for (const dangerous of ["process.kill", "SIGTERM", "SIGKILL", "SIGINT", "pkill", "worker-stop"]) {
        expect(text).not.toContain(dangerous);
      }
    }
  });

  it("imports no ralph TypeScript across the boundary", () => {
    const allowed: Record<string, string[]> = {
      "lifecycle-adapter.ts": ["node:fs", "node:path", "./adapter", "./contracts", "./control-adapter"],
      "lifecycle.ts": ["node:crypto", "./command-requests", "./contracts", "./control-adapter", "./dispatch", "./lifecycle-adapter"],
    };
    for (const [file, list] of Object.entries(allowed)) {
      const text = readFileSync(join(__dirname, file), "utf8");
      for (const match of text.matchAll(/from\s+["']([^"']+)["']/g)) {
        expect(list).toContain(match[1]);
      }
    }
  });
});
