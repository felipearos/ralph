// @vitest-environment node
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUsageSource, summarizeUsage } from "./usage";

const workers = vi.hoisted(() => [] as FakeWorker[]);
class FakeWorker extends EventEmitter {
  postMessage = vi.fn();
  terminate = vi.fn(async () => 0);
  ref = vi.fn();
  unref = vi.fn();
  constructor() { super(); workers.push(this); }
}
vi.mock("node:worker_threads", () => ({ Worker: function () { return new FakeWorker(); } }));
const tick = async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); };
const report = summarizeUsage([], 0);
beforeEach(() => { workers.length = 0; });

describe("usage source worker lifecycle", () => {
  it("coalesces callers, reuses the worker, and refreshes time even with cached targets", async () => {
    let now = 0;
    const targets = vi.fn(async () => []);
    const source = createUsageSource({ targets, now: () => now });
    try {
      const first = source();
      expect(source()).toBe(first);
      await tick();
      expect(targets).toHaveBeenCalledTimes(1);
      expect(workers).toHaveLength(1);
      expect(workers[0]!.postMessage).toHaveBeenCalledWith({ targets: [], nowMs: 0 });
      workers[0]!.emit("message", { report });
      expect(await first).toEqual(report);
      now = 10_000;
      const second = source();
      await tick();
      expect(targets).toHaveBeenCalledTimes(1);
      expect(workers).toHaveLength(1);
      expect(workers[0]!.postMessage).toHaveBeenLastCalledWith({ targets: [], nowMs: now });
      workers[0]!.emit("message", { report });
      await second;
      now = 31_000;
      const third = source();
      await tick();
      expect(targets).toHaveBeenCalledTimes(2);
      workers[0]!.emit("message", { report });
      await third;
    } finally { source.close(); }
  });

  it.each(["error", "exit", "message"])("rejects on worker %s and starts a fresh worker on retry", async (event) => {
    const source = createUsageSource({ targets: async () => [] });
    try {
      const first = source();
      const failure = expect(first).rejects.toThrow(/broken|exited/);
      await tick();
      const old = workers[0]!;
      old.emit(event, event === "error" ? new Error("broken") : event === "exit" ? 1 : { error: "broken" });
      await failure;
      expect(old.terminate).toHaveBeenCalledTimes(1);
      const retry = source();
      await tick();
      expect(workers).toHaveLength(2);
      // A stale worker's exit cannot reject the replacement's request.
      old.emit("exit", 1);
      workers[1]!.emit("message", { report });
      expect(await retry).toEqual(report);
    } finally { source.close(); }
  });

  it("closes pending work and refuses future reads", async () => {
    const source = createUsageSource({ targets: async () => [] });
    const request = source();
    const failure = expect(request).rejects.toThrow("closed");
    await tick();
    source.close();
    await failure;
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
    await expect(source()).rejects.toThrow("closed");
  });

  it("allows retry after target discovery fails without starting a worker", async () => {
    const targets = vi.fn().mockRejectedValueOnce(new Error("discovery failed")).mockResolvedValue([]);
    const source = createUsageSource({ targets });
    try {
      await expect(source()).rejects.toThrow("discovery failed");
      expect(workers).toHaveLength(0);
      const retry = source();
      await tick();
      workers[0]!.emit("message", { report });
      await retry;
    } finally { source.close(); }
  });
});
