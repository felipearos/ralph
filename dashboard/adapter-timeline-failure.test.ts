// @vitest-environment node
/**
 * Timeline activity and runner failures, read through the adapter.
 *
 * Both reads run over a scripted runtime: the world answers `timeline.ts
 * --json` and `runner-failure.ts status --json` per run, so the suite tests
 * what the adapter asks and what it does with the answer. The properties:
 * the adapter scopes each read to the loop's recorded run, a loop with no run
 * (or a non-loop checkout) gets no read at all, a CLI that cannot run
 * degrades that one field to unknown, and a drifted shape throws. That each
 * CLI filters by run is pinned against the real CLIs in
 * `adapter-runtime-reads.test.ts`.
 */
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  ADAPTER_ENV,
  COMMAND_SURFACE,
  RalphContractError,
  narrowRunnerFailures,
  narrowTimeline,
} from "./adapter";
import { CLI_DIR, adapterWorld, argAfter, fail, loopReport, loopStateAnswer, ok, okText, type AdapterWorld } from "./adapter-script";
import { cleanupFixtures } from "./fixtures";

afterAll(cleanupFixtures);

/** A world with one `ralph` loop on run `run-ralph`; returns the world and its worktree. */
const oneLoop = (label: string): { world: AdapterWorld; ralph: string } => {
  const world = adapterWorld(label);
  const ralph = world.worktree("wt-ralph");
  world.answer("loopState", loopStateAnswer([loopReport(ralph, { loop: "ralph", run: "run-ralph" })]));
  return { world, ralph };
};

describe("timeline activity through the adapter", () => {
  it("reads timeline --json for the loop's own worktree and run", async () => {
    const { world, ralph } = oneLoop("timeline");
    const timeline = {
      version: 1,
      exists: true,
      path: join(ralph, ".ralph", "logs", "iter-run-ralph-3.events.jsonl"),
      activities: [
        { stage: "mapper", label: "stage started · claude", at: "2026-09-13T11:00:00.000Z", iteration: 3, run: "run-ralph" },
        { stage: "mapper", label: "stage completed · claude", at: "2026-09-13T11:05:00.000Z", iteration: 3, run: "run-ralph" },
      ],
    };
    // Another run's answer is a newer iteration: only the run scope picks ours.
    const other = { ...timeline, activities: [{ ...timeline.activities[0]!, run: "run-before", iteration: 9 }] };
    world.answer("timeline", (i) => ok(argAfter(i, "--run") === "run-ralph" ? timeline : other));

    const read = (await world.adapter().read()).loops[0]?.timeline;
    const [call, ...more] = world.callsTo("timeline");
    expect(more).toEqual([]);
    expect(argAfter(call!, "--run")).toBe("run-ralph");
    expect(call!.cwd).toBe(CLI_DIR);
    expect(call!.env[ADAPTER_ENV.timelineRoot]).toBe(ralph);
    const { version: _version, ...narrowed } = timeline;
    expect(read).toEqual(narrowed);
  });

  it("carries an absent timeline as not existing, not as an empty success", async () => {
    // The world's default timeline answer is the CLI's "no file for this run".
    const { world } = oneLoop("timeline-absent");
    expect((await world.adapter().read()).loops[0]?.timeline).toEqual({ exists: false, path: null, activities: [] });
  });

  it("reads nothing for a loop with no recorded run or a checkout that is not a loop", async () => {
    const world = adapterWorld("timeline-no-run");
    // A loop by its `.ralph/loop-name` but with no record, so no run; and a
    // checkout no roster loop owns.
    const remo = world.worktree("wt-remo", "remo");
    const buildkite = world.worktree("wt-buildkite");
    world.answer("loopState", loopStateAnswer([loopReport(remo, { state: null }), loopReport(buildkite, { state: null })]));

    const snapshot = await world.adapter().read();
    expect(snapshot.loops.map((loop) => loop.identity)).toEqual(["remo", null]);
    for (const loop of snapshot.loops) {
      expect(loop.timeline).toBeNull();
      expect(loop.runnerFailures).toBeNull();
    }
    expect(world.callsTo("timeline")).toEqual([]);
    expect(world.callsTo("runnerFailure")).toEqual([]);
  });

  it("degrades a timeline CLI that cannot run to unknown without failing the snapshot", async () => {
    const { world } = oneLoop("timeline-unavailable");
    world.answer("timeline", fail(3, "broken"));

    const loop = (await world.adapter().read()).loops[0];
    expect(loop?.identity).toBe("ralph");
    expect(loop?.timeline).toBeNull();
    expect(loop?.presence?.loop).toBe("ralph");
  });

  it("fails loudly when timeline --json drifts", async () => {
    const { world } = oneLoop("timeline-drift");
    world.answer("timeline", ok({ version: 2 }));
    await expect(world.adapter().read()).rejects.toBeInstanceOf(RalphContractError);
  });
});

/** A settled failure as `runner-failure.ts status --json` prints one. */
const failureRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  at: "2026-09-13T11:30:00.000Z",
  host: "test",
  loop: "ralph",
  run: "run-ralph",
  attempt: { iteration: 3, session: null },
  stage: "executor",
  runner: "claude",
  model: "opus",
  owner: null,
  issue: 919,
  exitCode: 1,
  kind: "api-error",
  summary: "the provider answered with an error",
  visibility: "post-hoc",
  signals: [{ kind: "api-error", evidence: "overloaded_error: try again later", visibility: "post-hoc" }],
  log: null,
  signalsFile: null,
  note: null,
  ...over,
});

/** The CLI prints JSON as text: the surface parses it itself, to tell a blank stdout from drift. */
const failures = (settled: unknown[]) => okText(`${JSON.stringify({ inFlight: [], settled })}\n`);

describe("runner failures through the adapter", () => {
  it("reads runner-failure status --json scoped to the loop's run", async () => {
    const { world, ralph } = oneLoop("failures");
    world.answer("runnerFailure", (i) =>
      argAfter(i, "--run") === "run-ralph"
        ? failures([failureRow()])
        : failures([failureRow({ run: "run-before", kind: "timeout", at: "2026-09-13T10:00:00.000Z" })]),
    );

    const read = (await world.adapter().read()).loops[0]?.runnerFailures;
    const [call, ...more] = world.callsTo("runnerFailure");
    expect(more).toEqual([]);
    expect(argAfter(call!, "--run")).toBe("run-ralph");
    expect(call!.cwd).toBe(CLI_DIR);
    expect(call!.env[ADAPTER_ENV.project]).toBe(ralph);
    expect(read).toEqual({
      settled: [
        {
          at: "2026-09-13T11:30:00.000Z",
          loop: "ralph",
          run: "run-ralph",
          iteration: 3,
          stage: "executor",
          runner: "claude",
          model: "opus",
          issue: 919,
          exitCode: 1,
          kind: "api-error",
          summary: "the provider answered with an error",
          visibility: "post-hoc",
          evidence: ["overloaded_error: try again later"],
          note: null,
        },
      ],
    });
  });

  it("reports a worktree with no failure ledger as having no settled failures", async () => {
    // The world's default is the CLI's answer for a missing ledger.
    const { world } = oneLoop("failures-none");
    expect((await world.adapter().read()).loops[0]?.runnerFailures).toEqual({ settled: [] });
  });

  it("degrades a runner-failure CLI that cannot run to unknown", async () => {
    const { world } = oneLoop("failures-unavailable");
    world.answer("runnerFailure", fail(3, "broken"));
    expect((await world.adapter().read()).loops[0]?.runnerFailures).toBeNull();
  });

  it("treats a runner-failure CLI that exits 0 having printed nothing as unavailable, not drift", async () => {
    // runner-failure.ts never exits non-zero: a crash is stderr and exit 0.
    const { world } = oneLoop("failures-silent");
    world.answer("runnerFailure", { status: 0, stdout: "", stderr: "runner-failure: boom\n" });
    expect((await world.adapter().read()).loops[0]?.runnerFailures).toBeNull();
  });

  it("reads its own worktree's ledger even when the environment redirects the failure log", async () => {
    const { world, ralph } = oneLoop("failures-redirect");
    world.answer("runnerFailure", failures([failureRow({ kind: "timeout" })]));
    const adapter = world.adapter({ env: { [ADAPTER_ENV.failureLog]: join(world.root, "elsewhere.jsonl") } });

    expect((await adapter.read()).loops[0]?.runnerFailures?.settled.map((row) => row.kind)).toEqual(["timeout"]);
    // The caller's redirect is dropped, so the CLI would fall back to the
    // worktree's own ledger under RALPH_PROJECT (the real-CLI case is in
    // adapter-runtime-reads.test.ts).
    const [call] = world.callsTo("runnerFailure");
    expect(call!.env).not.toHaveProperty(ADAPTER_ENV.failureLog);
    expect(call!.env[ADAPTER_ENV.project]).toBe(ralph);
  });

  it("fails loudly when runner-failure status --json drifts", async () => {
    const { world } = oneLoop("failures-drift");
    world.answer("runnerFailure", okText('{"settled": {}}\n'));
    await expect(world.adapter().read()).rejects.toBeInstanceOf(RalphContractError);
  });

  it("reads failures and the timeline without writing: status and --json only", () => {
    expect(COMMAND_SURFACE.timeline).toEqual({ contract: "timeline", script: "timeline.ts", args: ["--json"] });
    expect(COMMAND_SURFACE.runnerFailure).toEqual({
      contract: "runner-failure",
      script: "runner-failure.ts",
      args: ["status", "--json"],
    });
  });
});

describe("the timeline contract guard", () => {
  const activity = { stage: "executor", label: "tool Bash — bun run test", at: "T", iteration: 3, run: "r" };
  const valid = { version: 1, exists: true, path: "/w/.ralph/logs/iter-r-3.events.jsonl", activities: [activity] };

  it("accepts the shape timeline.ts emits", () => {
    const { version: _version, ...narrowed } = valid;
    expect(narrowTimeline(valid)).toEqual(narrowed);
    expect(narrowTimeline({ version: 1, exists: false, path: null, activities: [] })).toEqual({
      exists: false,
      path: null,
      activities: [],
    });
  });

  it("rejects a version, stage or field it was not written against", () => {
    expect(() => narrowTimeline({ ...valid, version: 2 })).toThrow(/\$\.version/);
    expect(() => narrowTimeline({ ...valid, exists: "yes" })).toThrow(/\$\.exists/);
    expect(() => narrowTimeline({ ...valid, activities: [{ ...activity, stage: "reviewer" }] })).toThrow(
      /\$\.activities\[0\]\.stage/,
    );
    expect(() => narrowTimeline({ ...valid, activities: [{ ...activity, label: 7 }] })).toThrow(
      /\$\.activities\[0\]\.label/,
    );
    expect(() => narrowTimeline({ ...valid, activities: undefined })).toThrow(RalphContractError);
  });
});

describe("the runner-failure contract guard", () => {
  const row = {
    version: 1,
    at: "T",
    host: "h",
    loop: "ralph",
    run: "r",
    attempt: { iteration: null, session: null },
    stage: "review.spec",
    runner: null,
    model: null,
    owner: null,
    issue: null,
    exitCode: 124,
    kind: "timeout",
    summary: "timed out",
    visibility: "live",
    signals: [],
    log: null,
    signalsFile: null,
    note: "killed by timeout",
  };
  const valid = { inFlight: [{ file: "/w/.ralph/logs/signals-x.jsonl", signals: [{ kind: "permission-denied", evidence: "denied" }] }], settled: [row] };

  it("accepts the shape runner-failure.ts emits", () => {
    expect(narrowRunnerFailures(valid)).toEqual({
      settled: [
        {
          at: "T",
          loop: "ralph",
          run: "r",
          iteration: null,
          stage: "review.spec",
          runner: null,
          model: null,
          issue: null,
          exitCode: 124,
          kind: "timeout",
          summary: "timed out",
          visibility: "live",
          evidence: [],
          note: "killed by timeout",
        },
      ],
    });
  });

  it("rejects a drifted shape rather than coercing it", () => {
    expect(() => narrowRunnerFailures({})).toThrow(RalphContractError);
    expect(() => narrowRunnerFailures({ ...valid, inFlight: [{ file: 1, signals: [] }] })).toThrow(/\$\.inFlight\[0\]\.file/);
    expect(() => narrowRunnerFailures({ ...valid, settled: [{ ...row, version: 2 }] })).toThrow(/\$\.settled\[0\]\.version/);
    expect(() => narrowRunnerFailures({ ...valid, settled: [{ ...row, exitCode: "1" }] })).toThrow(/\$\.settled\[0\]\.exitCode/);
    expect(() => narrowRunnerFailures({ ...valid, settled: [{ ...row, visibility: "sometimes" }] })).toThrow(
      /\$\.settled\[0\]\.visibility/,
    );
    expect(() => narrowRunnerFailures({ ...valid, settled: [{ ...row, signals: [{ kind: "x" }] }] })).toThrow(
      /\$\.settled\[0\]\.signals\[0\]\.evidence/,
    );
  });
});
