// @vitest-environment node
/**
 * The adapter's fan-out and snapshot sharing, over a scripted runtime: which
 * reads overlap, how many are made, and that a failed shared snapshot is not
 * kept. Proved on the recorded invocations rather than on wall-clock time, so
 * a loaded host cannot make it pass or fail.
 */
import { afterAll, expect, it } from "vitest";
import { ADAPTER_ENV, RalphContractError } from "./adapter";
import { adapterWorld, drained, loopReport, loopStateAnswer, ok } from "./adapter-script";
import { cleanupFixtures } from "./fixtures";

afterAll(cleanupFixtures);

/** Two loops, `ralph` and `rafa`, each in its own worktree. */
function twoLoops(label: string) {
  const world = adapterWorld(label);
  const worktrees = [world.worktree("wt-ralph"), world.worktree("wt-rafa")];
  const reports = worktrees.map((worktree, i) => loopReport(worktree, { loop: i === 0 ? "ralph" : "rafa" }));
  world.answer("loopState", loopStateAnswer(reports));
  return { world, worktrees, reports };
}

it("overlaps independent loop reads instead of adding their latency", async () => {
  const { world, worktrees } = twoLoops("parallel-reads");
  const observe = world.gate("observe");
  const read = world.adapter().read();
  let snapshot;
  try {
    // A serial fan-out would hold the first observe and never ask for the
    // second, so wait for the queued work to drain rather than for an arrival
    // that may never come: both must be held by then.
    // Raced against the read itself, so a snapshot that fails before any
    // observe runs surfaces its own error at once instead of a gate timeout.
    await Promise.race([observe.until(1), read]);
    await drained();
    expect(observe.arrived.map((invocation) => invocation.env[ADAPTER_ENV.observerRoot])).toEqual(worktrees);
    // Each loop's timeline is asked beside its observer, not after it: both
    // were answered while every observe was still held.
    expect(world.callsTo("timeline").map((invocation) => invocation.env[ADAPTER_ENV.timelineRoot])).toEqual(worktrees);
    expect(world.callsTo("observe")).toEqual([]);
  } finally {
    observe.release();
    snapshot = await read;
  }
  expect(snapshot.loops.map((loop) => loop.worktree)).toEqual(worktrees);
  expect(world.callsTo("observe")).toHaveLength(2);
});

it("shares simultaneous page reads but refreshes the next snapshot", async () => {
  const { world } = twoLoops("shared-reads");
  const adapter = world.adapter();
  const [panel, controls, usage] = await Promise.all([adapter.read(), adapter.read(), adapter.read()]);
  expect(world.callsTo("github")).toHaveLength(1);
  expect(panel).toEqual(controls);
  expect(panel).toEqual(usage);
  // The claim read has no TTL (only the frontier and Following do), so the
  // next snapshot asks again without the clock moving.
  await adapter.read();
  expect(world.callsTo("github")).toHaveLength(2);
});

it("retries after a shared snapshot fails instead of retaining its rejection", async () => {
  const { world, reports } = twoLoops("retry-reads");
  const valid = loopStateAnswer(reports);
  let drifted = true;
  // Read at call time, so the same script answers drift first and a valid list after.
  world.answer("loopState", (i) => (drifted ? ok({}) : valid(i)));
  const adapter = world.adapter();
  const reads = await Promise.allSettled([adapter.read(), adapter.read()]);
  for (const read of reads) {
    expect(read.status).toBe("rejected");
    if (read.status === "rejected") expect(read.reason).toBeInstanceOf(RalphContractError);
  }
  drifted = false;
  const snapshot = await adapter.read();
  expect(snapshot.loops).toHaveLength(2);
});
