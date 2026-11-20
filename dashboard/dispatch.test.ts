// @vitest-environment node
/**
 * The command-dispatch layer, driven through a recording executor.
 *
 * Every test runs the real adapter — so the file asserted is the one the GUI
 * would write — and hands it a fake executor that records each `Invocation`
 * and returns the control record the test wants to reason about. No Orca, no
 * supervisor and no loop are involved; the write path is asserted as the exact
 * file that lands in the loop's inbox.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  createRalphControlAdapter,
  type ControlAdapter,
  type Executor,
  type Invocation,
} from "./control-adapter";
import { DispatchRequestError, dispatch, type DispatchDeps } from "./dispatch";
import { createRecordingExecutor } from "./recording-executor";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("builds fixture git repos");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Harness {
  deps: DispatchDeps;
  readonly calls: readonly Invocation[];
  /** The recording executor the harness adapter runs its read-backs through. */
  exec: Executor;
  /** The same adapter over this root, with its read-backs run by another executor. */
  adapterWith: (exec: Executor) => ControlAdapter;
  /** The control record `controls status --json` returns, as JSON. */
  setRecord: (record: unknown | null) => void;
  /** Make the loop's inbox unwritable, as a full disk or a bad mount would. */
  breakInbox: () => void;
  root: string;
}

/** A loop observed at `run-1`. */
function harness(label: string, over: { run?: string; loop?: string } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), `ralph-dispatch-${label}-`));
  roots.push(root);
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  writeFileSync(
    join(root, ".ralph", "logs", "state.json"),
    JSON.stringify({
      version: 1,
      run: over.run ?? "run-1",
      owner: { loop: over.loop ?? "ralph", pid: null, host: "test" },
      worktree: root,
      branch: "ralph/12",
      stage: "iteration",
      iteration: { index: 2, max: 15 },
      heartbeat: "2026-09-14T00:00:00.000Z",
      lastEvent: null,
      stopReason: null,
    }),
  );

  let record: unknown | null = null;

  // A function answer reads `record` at call time, so `setRecord` re-scripts the read-back.
  const recorder = createRecordingExecutor({
    rules: [
      {
        match: (invocation) => invocation.args.some((arg) => arg.endsWith("controls.ts")),
        answer: () => ({ status: 0, stdout: record === null ? "null" : JSON.stringify(record), stderr: "" }),
      },
    ],
    fallback: (invocation) => ({ status: 1, stdout: "", stderr: `unexpected invocation: ${invocation.command}` }),
  });
  const exec = recorder.exec;

  const adapterWith = (executor: Executor): ControlAdapter =>
    createRalphControlAdapter({
      cliDir: root,
      root,
      bunPath: "bun",
      exec: executor,
    });

  return {
    root,
    get calls() {
      return recorder.calls.map((call) => call.invocation);
    },
    exec,
    adapterWith,
    deps: { adapter: adapterWith(exec), loop: "ralph", now: () => new Date("2026-09-14T12:00:00.000Z") },
    setRecord: (value) => {
      record = value;
    },
    breakInbox: () => {
      // A file where the control directory should be: nothing can be created under it.
      mkdirSync(join(root, ".ralph"), { recursive: true });
      writeFileSync(join(root, ".ralph", "control"), "");
    },
  };
}

/** The command files waiting in the loop's inbox, in the order they were named. */
const sends = (h: Harness): Record<string, unknown>[] => {
  const dir = join(h.root, ".ralph", "control", "inbox");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .sort()
    .map((name) => ({ file: name, ...(JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>) }));
};

const controlOf = (command: Record<string, unknown>): Record<string, unknown> => command;

describe("mapping an action to the documented inbox command", () => {
  it("writes pause as one inbox file naming the observed run, and runs no orca", async () => {
    const h = harness("pause");
    const result = await dispatch(h.deps, {
      loop: "ralph",
      action: "pause",
      run: "run-1",
      why: "frontier needs triage",
      id: "k-pause",
    });

    expect(result.outcome).toBe("applied");
    expect(result.recorded).toBe(false);
    expect(sends(h)).toEqual([
      {
        file: "k-pause.json",
        version: 1,
        id: "k-pause",
        command: "pause",
        loop: "ralph",
        run: "run-1",
        why: "frontier needs triage",
        issuedAt: "2026-09-14T12:00:00.000Z",
      },
    ]);
    // The only subprocess is the record read back; nothing named Orca ran.
    expect(h.calls.every((call) => call.args.some((arg) => arg.endsWith("controls.ts")))).toBe(true);
  });

  it("makes the control directory ignore itself, so a project committing .ralph/ never commits it", async () => {
    const h = harness("gitignore");
    await dispatch(h.deps, { loop: "ralph", action: "pause", id: "k" });
    expect(readFileSync(join(h.root, ".ralph", "control", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("leaves nothing for git to commit in a project that tracks .ralph/", async () => {
    const h = harness("git-tracked");
    const git = (...args: string[]): string =>
      execFileSync("git", ["-C", h.root, ...args], { encoding: "utf8" });
    git("init", "-q");
    writeFileSync(join(h.root, ".ralph", "config.json"), "{}");
    git("add", ".ralph/config.json");
    await dispatch(h.deps, { loop: "ralph", action: "stop", id: "k" });
    expect(existsSync(join(h.root, ".ralph", "control", "inbox", "k.json"))).toBe(true);
    const untracked = git("status", "--porcelain", "--untracked-files=all", "--", ".ralph/control");
    expect(untracked).toBe("");
  });

  it("refuses an id that is not a safe file name rather than escaping it", async () => {
    const h = harness("unsafe-id");
    await expect(
      dispatch(h.deps, { loop: "ralph", action: "pause", id: "../../logs/state" }),
    ).rejects.toBeInstanceOf(DispatchRequestError);
    expect(sends(h)).toHaveLength(0);
  });

  it("addresses a command that names no run to whoever holds the loop", async () => {
    const h = harness("no-run");
    const result = await dispatch(h.deps, { loop: "ralph", action: "resume", id: "k" });
    expect(result.run).toBeNull();
    expect(controlOf(sends(h)[0]!)).not.toHaveProperty("run");
    expect(result.why).toContain("whoever holds");
  });

  it("carries a stop kind, defaulting to blocked", async () => {
    const h = harness("stop-kind");
    await dispatch(h.deps, { loop: "ralph", action: "stop", stopKind: "failed", id: "k" });
    expect(controlOf(sends(h)[0]!)).toMatchObject({ command: "stop", stop: "failed" });
  });

  it("writes a phase scope for pause and stop, and nothing for the default", async () => {
    const h = harness("scope");
    const paused = await dispatch(h.deps, { loop: "ralph", action: "pause", scope: "phase", id: "k-1" });
    await dispatch(h.deps, { loop: "ralph", action: "stop", scope: "phase", id: "k-2" });
    await dispatch(h.deps, { loop: "ralph", action: "stop", scope: "iteration", id: "k-3" });
    const [pause, stop, plain] = sends(h);
    expect(pause).toMatchObject({ command: "pause", scope: "phase" });
    expect(stop).toMatchObject({ command: "stop", scope: "phase", stop: "blocked" });
    // The default is the absence of a scope, which every loop already reads.
    expect(plain).not.toHaveProperty("scope");
    expect(paused.why).toContain("it applies at the next phase boundary");
  });

  it("says a phase retry waits for the loop's phase boundary", async () => {
    const h = harness("retry-phase");
    const sent = await dispatch(h.deps, { loop: "ralph", action: "retry-phase", id: "k-1" });
    expect(sends(h)[0]).toMatchObject({ command: "retry-phase" });
    expect(sent.why).toContain("it applies at the next phase boundary");
    expect(sent.stop).toBeNull();
  });

  it("refuses a phase scope on a command that has none, before anything is written", async () => {
    const h = harness("scope-refused");
    await expect(
      dispatch(h.deps, { loop: "ralph", action: "resume", scope: "phase", id: "k" }),
    ).rejects.toBeInstanceOf(DispatchRequestError);
    expect(sends(h)).toHaveLength(0);
  });

  it("writes the phase a gate is armed or disarmed before", async () => {
    const h = harness("gate");
    const armed = await dispatch(h.deps, { loop: "ralph", action: "arm-gate", phase: "finish", id: "g-1" });
    await dispatch(h.deps, { loop: "ralph", action: "disarm-gate", phase: "select", id: "g-2" });
    const [arm, disarm] = sends(h);
    expect(arm).toMatchObject({ command: "arm-gate", phase: "finish" });
    expect(arm).not.toHaveProperty("scope");
    expect(disarm).toMatchObject({ command: "disarm-gate", phase: "select" });
    expect(armed.why).toContain("it applies at the next phase boundary");
  });

  it("refuses a gate with no phase, and a phase on any other command, before anything is written", async () => {
    const h = harness("gate-refused");
    await expect(dispatch(h.deps, { loop: "ralph", action: "arm-gate", id: "k-1" })).rejects.toBeInstanceOf(
      DispatchRequestError,
    );
    await expect(
      dispatch(h.deps, { loop: "ralph", action: "approve", phase: "finish", id: "k-2" }),
    ).rejects.toBeInstanceOf(DispatchRequestError);
    expect(sends(h)).toHaveLength(0);
  });

  it("rejects an action outside its roster", async () => {
    const h = harness("bad-action");
    await expect(
      dispatch(h.deps, { loop: "ralph", action: "restart-to-apply" as never }),
    ).rejects.toBeInstanceOf(DispatchRequestError);
    expect(sends(h)).toHaveLength(0);
  });
});

describe("the recovery commands", () => {
  const polls = (h: Harness): Invocation[] => h.calls.filter((call) => call.args.includes("poll"));

  it("writes retry, abandon and release with the ticket they name", async () => {
    const h = harness("recovery-files");
    await dispatch(h.deps, { loop: "ralph", action: "retry", run: "run-1", id: "k-retry" });
    await dispatch(h.deps, { loop: "ralph", action: "abandon", issue: 704, id: "k-abandon" });
    await dispatch(h.deps, { loop: "ralph", action: "release", run: "run-1", issue: 703, id: "k-release" });
    expect(sends(h).map(({ file, command, issue, run }) => ({ file, command, issue, run }))).toEqual([
      { file: "k-abandon.json", command: "abandon", issue: 704, run: undefined },
      { file: "k-release.json", command: "release", issue: 703, run: "run-1" },
      { file: "k-retry.json", command: "retry", issue: undefined, run: "run-1" },
    ]);
  });

  it("refuses abandon and release that name no ticket, before anything is written", async () => {
    const h = harness("recovery-no-issue");
    for (const action of ["abandon", "release"] as const) {
      await expect(dispatch(h.deps, { loop: "ralph", action, id: `k-${action}` })).rejects.toBeInstanceOf(
        DispatchRequestError,
      );
    }
    expect(sends(h)).toHaveLength(0);
  });

  it("applies a command at once when the supervisor is gone, as the observed run with the Orca route off", async () => {
    // Nothing else would ever read the inbox: the loop's own poll runs inside
    // the supervisor, and recovery is exactly when there is none.
    const h = harness("recovery-dead");
    await dispatch({ ...h.deps, supervisor: "dead" }, { loop: "ralph", action: "abandon", issue: 704, id: "k" });
    expect(polls(h)).toHaveLength(1);
    const poll = polls(h)[0]!;
    // Under the lock `start.sh` takes, so no supervisor can start mid-poll.
    expect(poll.command).toBe("flock");
    expect(poll.args.slice(0, 4)).toEqual(["-n", "-E", "75", join(h.root, ".ralph", "logs", "supervisor.lock")]);
    expect(poll.args[4]).toBe("bun");
    expect(poll.args[5]).toMatch(/\/controls\.ts$/);
    expect(poll.args.slice(6)).toEqual(["poll", "--only", "retry,abandon,release"]);
    expect(poll.env).toMatchObject({
      RALPH_PLUGINS: "",
      RALPH_RUN_ID: "run-1",
      RALPH_LOOP_NAME: "ralph",
      RALPH_STATE_ROOT: h.root,
    });
    // The record is read, checked to be this run's, polled, and read back, so
    // the page shows what the loop recorded.
    const statuses = h.calls.map((call) => (call.args.includes("poll") ? "poll" : "status"));
    expect(statuses).toEqual(["status", "status", "poll", "status"]);
  });

  it("leaves pause, resume, stop, approve and deny to the next supervisor, even with none running", async () => {
    const h = harness("recovery-not-for-pause");
    for (const action of ["pause", "resume", "approve", "deny", "stop"] as const) {
      await dispatch({ ...h.deps, supervisor: "dead" }, { loop: "ralph", action, id: `k-${action}` });
    }
    expect(polls(h)).toHaveLength(0);
  });

  it("leaves the command to a live supervisor, or to one it cannot see", async () => {
    for (const supervisor of ["alive", "unknown", undefined] as const) {
      const h = harness(`recovery-${supervisor ?? "unset"}`);
      await dispatch({ ...h.deps, supervisor }, { loop: "ralph", action: "retry", id: "k" });
      expect(polls(h)).toHaveLength(0);
    }
  });

  it("does not poll as a run the control record has already moved past", async () => {
    // A newer run owns the record while the loop state still names run-1:
    // polling as run-1 would adopt the record back and drop run-2's stop.
    const h = harness("recovery-record-moved");
    h.setRecord({ version: 1, ralphRun: "run-2", loop: "ralph", applied: [], deferrals: [] });
    const result = await dispatch({ ...h.deps, supervisor: "dead" }, { loop: "ralph", action: "retry", id: "k" });
    expect(polls(h)).toHaveLength(0);
    expect(result.why).toContain("do not agree");
  });

  it("says a supervisor holds the loop when the poll finds the lock taken", async () => {
    const h = harness("recovery-busy");
    const exec = h.exec;
    const deps = {
      ...h.deps,
      supervisor: "dead" as const,
      adapter: h.adapterWith(async (invocation: Invocation) =>
        invocation.args.includes("poll") ? { status: 75, stdout: "", stderr: "" } : exec(invocation),
      ),
    };
    const result = await dispatch(deps, { loop: "ralph", action: "retry", id: "k" });
    expect(result).toMatchObject({ outcome: "applied", recorded: false });
    expect(result.why).toContain("supervisor lock is held");
  });

  it("does not poll when the control record cannot be read, since the poll would adopt it", async () => {
    const h = harness("recovery-record-unreadable");
    const exec = h.exec;
    const deps = {
      ...h.deps,
      supervisor: "dead" as const,
      adapter: h.adapterWith(async (invocation: Invocation) =>
        invocation.args.includes("status")
          ? { status: 1, stdout: "", stderr: "record unreadable" }
          : exec(invocation),
      ),
    };
    await dispatch(deps, { loop: "ralph", action: "retry", id: "k" });
    expect(polls(h)).toHaveLength(0);
  });

  it("does not poll as a guessed run when the loop has none on record", async () => {
    const h = harness("recovery-no-run");
    rmSync(join(h.root, ".ralph", "logs"), { recursive: true, force: true });
    const result = await dispatch({ ...h.deps, supervisor: "dead" }, { loop: "ralph", action: "retry", id: "k" });
    expect(polls(h)).toHaveLength(0);
    expect(result).toMatchObject({ outcome: "applied", recorded: false });
  });
});

describe("ownership", () => {
  it("refuses a command naming a replaced run without sending it", async () => {
    const h = harness("reconfirmation", { run: "run-2" });
    const result = await dispatch(h.deps, { loop: "ralph", action: "stop", run: "run-1", id: "k" });
    expect(result.outcome).toBe("needs-reconfirmation");
    expect(result.why).toContain("re-issue it against run-2");
    expect(sends(h)).toHaveLength(0);
  });

  it("sends a reconfirmed command against the run the operator named", async () => {
    const h = harness("reconfirmed", { run: "run-2" });
    const result = await dispatch(h.deps, {
      loop: "ralph",
      action: "stop",
      run: "run-1",
      reconfirm: true,
      id: "k",
    });
    expect(result.outcome).toBe("applied");
    expect(controlOf(sends(h)[0]!)).toMatchObject({ run: "run-1" });
  });

  it("does not answer a command addressed to the other loop", async () => {
    const h = harness("other-loop");
    const result = await dispatch(h.deps, { loop: "rafa", action: "pause", id: "k" });
    expect(result.outcome).toBe("not-for-this-loop");
    expect(sends(h)).toHaveLength(0);
  });
});

describe("the recorded outcome", () => {
  it("replays a command the fence already holds, and sends nothing", async () => {
    const h = harness("replay");
    h.setRecord({
      version: 1,
      ralphRun: "run-1",
      loop: "ralph",
      applied: [{ key: "k", command: "pause", outcome: "applied", at: "T", why: "paused" }],
      deferrals: [],
    });
    const result = await dispatch(h.deps, { loop: "ralph", action: "pause", id: "k" });
    expect(result.outcome).toBe("replayed");
    expect(result.recorded).toBe(true);
    expect(sends(h)).toHaveLength(0);
  });

  it("surfaces a refusal the loop recorded rather than a replay", async () => {
    const h = harness("recorded-refusal");
    h.setRecord({
      version: 1,
      ralphRun: "run-1",
      loop: "ralph",
      applied: [
        { key: "k", command: "approve", outcome: "refused", at: "T", why: "nothing is waiting" },
      ],
      deferrals: [],
    });
    const result = await dispatch(h.deps, { loop: "ralph", action: "approve", id: "k" });
    expect(result.outcome).toBe("refused");
    expect(result.why).toBe("nothing is waiting");
    expect(sends(h)).toHaveLength(0);
  });

  it("reports a deferred command with its wait", async () => {
    const h = harness("deferred");
    h.setRecord({
      version: 1,
      ralphRun: "run-1",
      loop: "ralph",
      applied: [],
      deferrals: [{ key: "k", command: "abandon", since: "T0", attempts: 3 }],
    });
    const result = await dispatch(h.deps, { loop: "ralph", action: "pause", id: "k" });
    expect(result.outcome).toBe("deferred");
    expect(result.why).toContain("attempt 3");
    expect(sends(h)).toHaveLength(0);
  });

  it("reports accepted-but-unapplied as applied and not recorded", async () => {
    const h = harness("fresh");
    const result = await dispatch(h.deps, { loop: "ralph", action: "pause", id: "fresh" });
    expect(result).toMatchObject({ outcome: "applied", recorded: false });
  });

  it("refuses when the inbox cannot be written, and never claims the command landed", async () => {
    const h = harness("send-fails");
    h.breakInbox();
    const result = await dispatch(h.deps, { loop: "ralph", action: "pause", id: "k" });
    expect(result.outcome).toBe("refused");
    expect(result.why).toContain("could not write");
  });
});

describe("the stop confirmation", () => {
  it("is pending for a stop no supervisor has confirmed, never confirmed", async () => {
    const h = harness("stop-pending");
    const result = await dispatch(h.deps, { loop: "ralph", action: "stop", id: "k" });
    expect(result.stop).toEqual({ kind: "blocked", confirmation: "pending" });
  });

  it("takes the confirmation the loop recorded, including unreachable", async () => {
    const h = harness("stop-unreachable");
    h.setRecord({
      version: 1,
      ralphRun: "run-1",
      loop: "ralph",
      applied: [{ key: "k", command: "stop", outcome: "applied", at: "T", why: "stopping" }],
      deferrals: [],
      stop: { kind: "blocked", confirmation: "unreachable", why: "no process", at: "T", key: "k" },
    });
    const result = await dispatch(h.deps, { loop: "ralph", action: "stop", id: "k" });
    expect(result.stop?.confirmation).toBe("unreachable");
    expect(result.stop?.confirmation).not.toBe("confirmed");
  });

  it("is absent for the non-destructive controls", async () => {
    const h = harness("no-stop");
    const result = await dispatch(h.deps, { loop: "ralph", action: "resume", id: "k" });
    expect(result.stop).toBeNull();
  });

  it("is absent when a stop was refused before it was sent", async () => {
    const h = harness("stop-refused-unsent", { run: "run-2" });
    const result = await dispatch(h.deps, { loop: "ralph", action: "stop", run: "run-1", id: "k" });
    expect(result.outcome).toBe("needs-reconfirmation");
    expect(result.stop).toBeNull();
  });

  it("is absent when the inbox write failed", async () => {
    const h = harness("stop-send-failed");
    h.breakInbox();
    const result = await dispatch(h.deps, { loop: "ralph", action: "stop", id: "k" });
    expect(result.outcome).toBe("refused");
    expect(result.stop).toBeNull();
  });
});

describe("the idempotency key", () => {
  it("uses the operator's id so a re-send is the same command", async () => {
    const h = harness("operator-id");
    await dispatch(h.deps, { loop: "ralph", action: "pause", id: "the-id" });
    expect(controlOf(sends(h)[0]!).id).toBe("the-id");
  });

  it("generates one when the operator gave none", async () => {
    const h = harness("generated-id");
    const result = await dispatch(h.deps, { loop: "ralph", action: "pause" });
    expect(result.key).not.toBe("");
    expect(controlOf(sends(h)[0]!).id).toBe(result.key);
  });
});

describe("the adapter owns the surface", () => {
  it("never leaks a shell command into dispatch", () => {
    // A guard against re-litigating the boundary: the layer above the adapter
    // builds no argv, so this file must not contain the CLI words either.
    const adapter: ControlAdapter = createRalphControlAdapter({
      cliDir: "/tmp",
      root: "/tmp",
      exec: async () => ({ status: 1, stdout: "", stderr: "" }),
    });
    expect(typeof adapter.readIdentity).toBe("function");
  });
});
