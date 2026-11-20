// @vitest-environment node
/**
 * The lifecycle adapter's operations, given an executor that fails, and the
 * commands each one runs.
 *
 * The adapter owns its executor and wraps it in `guarded`, so the layers above
 * it (restart, Resume work, the Fix gate, the reconciler) ask for an answer
 * and carry no try/catch of their own. That only holds if every operation
 * RESOLVES to its failure answer when the executor throws: a rejection would
 * fail a reconcile pass for every other loop, or the operator's request.
 *
 * Nothing is spawned: the executor is a fake. The checkout report reads a
 * claim-lease file under a root that does not exist, which reads as no claims.
 */
import { describe, expect, it } from "vitest";

import type { ExecResult, Executor } from "./control-adapter";
import { createRalphLifecycleAdapter, LIFECYCLE_SURFACE, type LifecycleAdapter } from "./lifecycle-adapter";
import { createRecordingExecutor } from "./recording-executor";

const ROOT = "/nonexistent-ralph-lifecycle-operations/checkout";

const adapterOver = (exec: Executor): LifecycleAdapter =>
  createRalphLifecycleAdapter({ cliDir: "/harness", root: ROOT, bunPath: "bun", env: {}, exec });

/** An executor that rejects, the way a spawn error surfaces from an async executor. */
const rejecting = (): Executor => createRecordingExecutor({ fallback: { throw: new Error("boom") } }).exec;

/** An executor that throws before it ever returns a promise. */
const throwingSync: Executor = () => {
  throw new Error("sync boom");
};

const ok = (stdout: string): ExecResult => ({ status: 0, stdout, stderr: "" });

describe.each([
  { name: "rejects", exec: rejecting() },
  { name: "throws synchronously", exec: throwingSync },
])("an executor that $name", ({ exec }) => {
  it("ends a start as failed", async () => {
    const report = await adapterOver(exec).start();
    expect(report.outcome).toBe("failed");
    expect(report.pid).toBeNull();
  });

  it("reads the supervisor as unknown, never dead", async () => {
    await expect(adapterOver(exec).supervisor()).resolves.toMatchObject({ liveness: "unknown" });
  });

  it("reads the loop state as unknown and unrecorded", async () => {
    await expect(adapterOver(exec).loopState()).resolves.toMatchObject({
      liveness: "unknown",
      recorded: false,
      stopReason: null,
    });
  });

  it("reads the checkout as unreadable, with nothing said about unpushed work", async () => {
    const report = await adapterOver(exec).checkout();
    expect(report.readable).toBe(false);
    expect(report.unpushed).toBeNull();
    expect(report.worktree).toBe(ROOT);
  });
});

describe("the commands each operation runs", () => {
  it("start runs the starter in the worktree", async () => {
    const recorder = createRecordingExecutor({ fallback: ok("Started Ralph supervisor (pid 42)\n") });
    const report = await adapterOver(recorder.exec).start();
    expect(report).toMatchObject({ outcome: "started", pid: 42 });
    expect(recorder.calls).toHaveLength(1);
    const { invocation } = recorder.calls[0]!;
    expect(invocation.command).toBe("/harness/start.sh");
    expect(invocation.args).toEqual([]);
    expect(invocation.cwd).toBe(ROOT);
    expect(invocation.env.RALPH_PROJECT).toBe(ROOT);
  });

  it("supervisor runs the loop-state read for the worktree", async () => {
    const recorder = createRecordingExecutor({ fallback: ok("{}") });
    await adapterOver(recorder.exec).supervisor();
    expect(recorder.calls).toHaveLength(1);
    const { invocation } = recorder.calls[0]!;
    expect(invocation.command).toBe("bun");
    expect(invocation.args).toEqual([
      `/harness/${LIFECYCLE_SURFACE.supervisor.script}`,
      ...LIFECYCLE_SURFACE.supervisor.args,
    ]);
    expect(invocation.cwd).toBe(ROOT);
  });

  it("checkout runs its four git reads in order, one after another", async () => {
    const recorder = createRecordingExecutor({ fallback: ok("") });
    const report = await adapterOver(recorder.exec).checkout();
    expect(report).toMatchObject({ readable: true, dirty: false, unpushed: [] });
    expect(recorder.calls.map(({ invocation }) => [invocation.command, ...invocation.args])).toEqual([
      ["git", ...LIFECYCLE_SURFACE.checkout.status],
      ["git", ...LIFECYCLE_SURFACE.checkout.branch],
      ["git", ...LIFECYCLE_SURFACE.checkout.commonDir],
      ["git", ...LIFECYCLE_SURFACE.checkout.unpushed],
    ]);
    expect(recorder.calls.every(({ invocation }) => invocation.cwd === ROOT)).toBe(true);
  });
});
