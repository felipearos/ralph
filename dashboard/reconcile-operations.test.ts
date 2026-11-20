// @vitest-environment node
/**
 * The reconcile adapter's operations, given an executor that fails, and the
 * commands each one runs.
 *
 * The adapter owns its executor and wraps it in `guarded`, so the reconciler
 * and the migration watchdog ask for an answer and carry no try/catch of their
 * own. That only holds if every operation RESOLVES to its failure answer when
 * the executor throws: both run on a timer with nobody watching, and a
 * rejection would end the pass for every other loop and project.
 *
 * Nothing is spawned: the executor is a fake.
 */
import { describe, expect, it } from "vitest";

import type { ExecResult, Executor } from "./control-adapter";
import { createReconcileAdapter, RECONCILE_SURFACE, type PushInput, type ReconcileAdapter } from "./reconcile";
import { createRecordingExecutor } from "./recording-executor";

const adapterOver = (exec: Executor): ReconcileAdapter =>
  createReconcileAdapter({ cliDir: "/h", bunPath: "bun", env: {}, exec });

/** An executor that rejects, the way a spawn error surfaces from an async executor. */
const rejecting = (): Executor => createRecordingExecutor({ fallback: { throw: new Error("boom") } }).exec;

/** An executor that throws before it ever returns a promise. */
const throwingSync: Executor = () => {
  throw new Error("sync boom");
};

const answer = (status: number, stdout: string, stderr = ""): ExecResult => ({ status, stdout, stderr });

const input: PushInput = {
  kind: "loop-retried",
  occurrence: "loop-retried:ralph-run-dead",
  subject: "s",
  body: "b",
  priority: "normal",
  worktree: "/w/loop",
  loop: "ralph",
  run: "ralph-run-dead",
};

describe.each([
  { name: "rejects", exec: rejecting(), message: "boom" },
  { name: "throws synchronously", exec: throwingSync, message: "sync boom" },
])("an executor that $name", ({ exec, message }) => {
  it("ends a push as not recorded, with the error as why", async () => {
    await expect(adapterOver(exec).push(input)).resolves.toEqual({ ok: false, why: message });
  });

  it("answers the migration list with a problem", async () => {
    await expect(adapterOver(exec).listMigrations("/w/loop")).resolves.toEqual({ problem: message });
  });

  it("answers the apply time with a problem", async () => {
    await expect(adapterOver(exec).appliedAt("/w/loop", 7)).resolves.toEqual({ problem: message });
  });
});

describe("the commands each operation runs", () => {
  it("push runs push-notification.ts in the worktree, attributed to the dead run", async () => {
    const recorder = createRecordingExecutor({ fallback: answer(0, "") });
    await expect(adapterOver(recorder.exec).push(input)).resolves.toEqual({ ok: true });
    expect(recorder.calls).toHaveLength(1);
    const { invocation } = recorder.calls[0]!;
    expect(invocation.command).toBe("bun");
    expect(invocation.args).toEqual([
      "/h/push-notification.ts",
      "push",
      "--kind",
      "loop-retried",
      "--occurrence",
      input.occurrence,
      "--subject",
      "s",
      "--body",
      "b",
      "--priority",
      "normal",
    ]);
    expect(invocation.cwd).toBe("/w/loop");
    expect(invocation.env).toMatchObject({
      [RECONCILE_SURFACE.push.env.root]: "/w/loop",
      [RECONCILE_SURFACE.push.env.loop]: "ralph",
      [RECONCILE_SURFACE.push.env.run]: "ralph-run-dead",
    });
  });

  it("push answers a failed write with its trimmed stderr", async () => {
    const recorder = createRecordingExecutor({ fallback: answer(1, "", "  disk full\n") });
    await expect(adapterOver(recorder.exec).push(input)).resolves.toEqual({ ok: false, why: "disk full" });
  });

  it("push answers a silent failure with its status", async () => {
    const recorder = createRecordingExecutor({ fallback: answer(2, "") });
    await expect(adapterOver(recorder.exec).push(input)).resolves.toEqual({ ok: false, why: "2" });
  });

  it("listMigrations runs gh pr list in the worktree and parses the PRs", async () => {
    const recorder = createRecordingExecutor({
      fallback: answer(0, JSON.stringify([{ number: 12, title: "t", url: "https://x/12" }])),
    });
    await expect(adapterOver(recorder.exec).listMigrations("/w/loop")).resolves.toEqual({
      prs: [{ number: 12, title: "t", url: "https://x/12" }],
    });
    const { invocation } = recorder.calls[0]!;
    expect([invocation.command, ...invocation.args]).toEqual(["gh", ...RECONCILE_SURFACE.gh.list]);
    expect(invocation.cwd).toBe("/w/loop");
  });

  it("listMigrations answers unparseable output with a problem", async () => {
    const recorder = createRecordingExecutor({ fallback: answer(0, "not json") });
    await expect(adapterOver(recorder.exec).listMigrations("/w/loop")).resolves.toEqual({ problem: "0" });
  });

  it("appliedAt reads the PR's events and answers the newest apply", async () => {
    const recorder = createRecordingExecutor({
      fallback: answer(0, "2026-10-01T00:00:00Z\n2026-10-02T00:00:00Z\n"),
    });
    await expect(adapterOver(recorder.exec).appliedAt("/w/loop", 7)).resolves.toEqual({ at: "2026-10-02T00:00:00Z" });
    const { invocation } = recorder.calls[0]!;
    expect(invocation.command).toBe("gh");
    expect(invocation.args).toContain("repos/{owner}/{repo}/issues/7/events");
    expect(invocation.cwd).toBe("/w/loop");
  });

  it("appliedAt answers an unparseable date with a problem", async () => {
    const recorder = createRecordingExecutor({ fallback: answer(0, "yesterday\n", "warn") });
    await expect(adapterOver(recorder.exec).appliedAt("/w/loop", 7)).resolves.toEqual({ problem: "warn" });
  });
});
