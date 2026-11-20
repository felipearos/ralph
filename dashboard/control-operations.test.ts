// @vitest-environment node
/**
 * The control adapter's operations, given an executor that fails.
 *
 * The adapter owns its executor and wraps it in `guarded`, so the layers above
 * it (dispatch, the control view, Stop now) ask for an answer and carry no
 * try/catch of their own. That only holds if every operation RESOLVES to its
 * failure answer when the executor throws — a rejection here would surface as
 * a failed HTTP response, or an unhandled one, on the operator's page.
 *
 * Nothing is spawned and nothing touches the disk: the executor is a fake.
 */
import { describe, expect, it } from "vitest";

import { createRalphControlAdapter, type ControlAdapter, type Executor } from "./control-adapter";
import { createRecordingExecutor } from "./recording-executor";

const adapterOver = (exec: Executor): ControlAdapter =>
  createRalphControlAdapter({ cliDir: "/harness", root: "/checkout/ralph", bunPath: "bun", exec });

/** An executor that rejects, the way a spawn error surfaces from an async executor. */
const rejecting = (): Executor => createRecordingExecutor({ fallback: { throw: new Error("boom") } }).exec;

/** An executor that throws before it ever returns a promise. */
const throwingSync: Executor = () => {
  throw new Error("sync boom");
};

describe.each([
  { name: "rejects", exec: rejecting(), message: "boom" },
  { name: "throws synchronously", exec: throwingSync, message: "sync boom" },
])("an executor that $name", ({ exec, message }) => {
  it("reads as no control record", async () => {
    await expect(adapterOver(exec).readControlRecord()).resolves.toBeNull();
  });

  it("reads the control status as unreadable, naming the error", async () => {
    const read = await adapterOver(exec).readControlStatus();
    expect(read.kind).toBe("unreadable");
    if (read.kind !== "unreadable") throw new Error("unreachable");
    expect(read.why).toContain(message);
  });

  it("ends a recovery poll as failed, naming the error", async () => {
    const ending = await adapterOver(exec).recoveryPoll("run-1", "ralph");
    expect(ending.kind).toBe("failed");
    if (ending.kind !== "failed") throw new Error("unreachable");
    expect(ending.why).toContain(message);
  });

  it("ends the record of a Stop now as failed, naming the error", async () => {
    const ending = await adapterOver(exec).recordInterrupt("run-1", "ralph", "stop-1", "operator");
    expect(ending.kind).toBe("failed");
    if (ending.kind !== "failed") throw new Error("unreachable");
    expect(ending.why).toContain(message);
  });
});
