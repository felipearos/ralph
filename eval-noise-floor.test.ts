import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MAX_ARMS } from "./backtest";
import { gradeRun } from "./eval-grade";
import {
  armGaps,
  floorStatus,
  latestFloor,
  measureFloor,
  noiseFloorArms,
  noiseFloorSettings,
  noiseReport,
  NOISE_FLOOR_FILE,
  readNoiseFloors,
  stampNoise,
  type NoiseFloor,
  type NoiseReads,
  type NoiseStatus,
} from "./eval-noise-floor";
import { MIXED_SET_CASES, mixedSetReport } from "./fixtures/evals/mixed-set";
import { NOISE_FLOOR_CASES, noiseFloorReport } from "./fixtures/evals/noise-floor";

const MEASURED = "2026-11-19T04:00:00Z";

function floorOf(cases: string[], measuredAt = MEASURED): NoiseFloor {
  return { v: 1, version: "v", measuredAt, runId: `run-${measuredAt}`, arms: ["live-1", "live-2"], cases, spread: { objective: 0.5, judge: 0.66 }, perCase: [] };
}

const TEN = Array.from({ length: 10 }, (_, i) => `case-${i}`);
const active = (id: string) => ({ id, status: "active" as const });

describe("noiseFloorArms", () => {
  test("names N identical live arms", () => {
    expect(noiseFloorArms(3)).toEqual([
      { name: "live-1", lineup: "live", overlay: null },
      { name: "live-2", lineup: "live", overlay: null },
      { name: "live-3", lineup: "live", overlay: null },
    ]);
    expect(noiseFloorArms(MAX_ARMS)).toHaveLength(MAX_ARMS);
  });

  test("refuses fewer than two, more than MAX_ARMS, or a fraction", () => {
    for (const n of [0, 1, MAX_ARMS + 1, 2.5, Number.NaN]) expect(() => noiseFloorArms(n)).toThrow();
  });
});

describe("measureFloor", () => {
  test("reads the set and per-case spreads of the fixture by hand", () => {
    const floor = measureFloor(noiseFloorReport(), MEASURED);
    expect(floor).toEqual({
      v: 1,
      version: "floor-v1",
      measuredAt: MEASURED,
      runId: "noise-floor-run",
      arms: ["live-1", "live-2", "live-3"],
      cases: [...NOISE_FLOOR_CASES],
      spread: { objective: 0.5, judge: 0.66 },
      perCase: [
        { case: "noise-flaky", objective: 1, judge: 1 },
        { case: "noise-steady", objective: 0, judge: 1 },
        { case: "noise-judged", objective: null, judge: 0 },
      ],
    });
  });

  test("keeps the objective and judge spreads apart", () => {
    const floor = measureFloor(noiseFloorReport(), MEASURED)!;
    expect(Object.keys(floor.spread).sort()).toEqual(["judge", "objective"]);
  });

  test("is null on a report that is not a set run, or of an uncommitted set", () => {
    const { set: _set, ...notSet } = noiseFloorReport();
    expect(measureFloor(notSet, MEASURED)).toBeNull();
    const uncommitted = noiseFloorReport();
    uncommitted.set = { ...uncommitted.set!, version: null };
    expect(measureFloor(uncommitted, MEASURED)).toBeNull();
    expect(measureFloor({ ...noiseFloorReport(), scores: [] }, MEASURED)).toBeNull();
  });
});

describe("measureFloor on cases not every arm ran", () => {
  test("compares the arms on the cases all of them graded, never rates over different cases", () => {
    const report = noiseFloorReport();
    // live-3 has no result on noise-flaky (its trial did not run): only noise-steady is common, where all three pass.
    report.scores = report.scores!.map((score) => score.ticket !== "noise-flaky" ? score : { ...score, arms: score.arms.filter((arm) => arm.arm !== "live-3") });
    expect(measureFloor(report, MEASURED)?.spread.objective).toBe(0);
  });
});

describe("floorStatus", () => {
  test("nothing in play is stale even at a share of 1", () => {
    expect(floorStatus(floorOf(TEN), [], 1).state).toBe("stale");
  });

  test("is missing without a floor", () => {
    expect(floorStatus(null, TEN.map(active), 0.2)).toEqual({ state: "missing", floor: null, drift: null, staleShare: 0.2 });
  });

  test("two changes of ten at a 0.2 share are still fresh; three are stale", () => {
    const floor = floorOf(TEN);
    // case-0 retired, case-new added: 2 / 10 = 0.2, not over the share.
    const two = [{ id: "case-0", status: "retired" as const }, ...TEN.slice(1).map(active), active("case-new")];
    expect(floorStatus(floor, two, 0.2)).toMatchObject({ state: "fresh", drift: { added: 1, retired: 1, share: 0.2 } });
    // case-1 gone from the set too: 3 / 10.
    const three = two.filter((c) => c.id !== "case-1");
    expect(floorStatus(floor, three, 0.2)).toMatchObject({ state: "stale", drift: { added: 1, retired: 2, share: 0.3 } });
  });

  test("a saturated case is still in play", () => {
    const current = TEN.map((id) => ({ id, status: id === "case-3" ? "saturated" as const : "active" as const }));
    expect(floorStatus(floorOf(TEN), current, 0.2)).toMatchObject({ state: "fresh", drift: { added: 0, retired: 0, share: 0 } });
  });

  test("edits that keep ids and statuses count for nothing", () => {
    const status = floorStatus({ ...floorOf(TEN), version: "old-commit" }, TEN.map(active), 0.2);
    expect(status).toMatchObject({ state: "fresh", drift: { added: 0, retired: 0, share: 0 } });
    expect(status.floor).toEqual({ version: "old-commit", measuredAt: MEASURED, runId: `run-${MEASURED}`, spread: { objective: 0.5, judge: 0.66 } });
  });

  test("a floor of no cases is stale", () => {
    expect(floorStatus(floorOf([]), TEN.map(active), 0.2).state).toBe("stale");
  });
});

describe("armGaps", () => {
  // mixed-set: b passes case-tests, c fails it (rates 1 and 0); judge means b 4.11, c 2.
  const grades = gradeRun(mixedSetReport(), ["a", "b", "c"])!;
  const status = (state: NoiseStatus["state"], objective: number | null, judge: number | null): NoiseStatus => ({
    state,
    floor: state === "missing" ? null : { version: "v", measuredAt: MEASURED, runId: "r", spread: { objective, judge } },
    drift: state === "missing" ? null : { added: 0, retired: 0, share: 0 },
    staleShare: 0.2,
  });

  test("objective within while judge beyond", () => {
    expect(armGaps(grades, status("fresh", 1, 0.5))).toEqual([{
      arm: "c", vs: "b",
      objective: { gap: -1, verdict: "within" },
      judge: { gap: -2.11, verdict: "beyond" },
    }]);
  });

  test("judge within while objective beyond", () => {
    expect(armGaps(grades, status("fresh", 0.5, 3))).toEqual([{
      arm: "c", vs: "b",
      objective: { gap: -1, verdict: "beyond" },
      judge: { gap: -2.11, verdict: "within" },
    }]);
  });

  test("a gap exactly at the floor is within", () => {
    const [gap] = armGaps(grades, status("fresh", 1, 2.11));
    expect(gap!.objective.verdict).toBe("within");
    expect(gap!.judge.verdict).toBe("within");
  });

  test("an axis without a floor spread is no-floor, the other still judged", () => {
    const [gap] = armGaps(grades, status("fresh", null, 0.5));
    expect(gap!.objective.verdict).toBe("no-floor");
    expect(gap!.judge.verdict).toBe("beyond");
  });

  test("a stale or missing floor is never beyond", () => {
    const [stale] = armGaps(grades, status("stale", 0, 0));
    expect(stale!.objective).toEqual({ gap: -1, verdict: "stale" });
    expect(stale!.judge).toEqual({ gap: -2.11, verdict: "stale" });
    const [missing] = armGaps(grades, status("missing", null, null));
    expect(missing!.objective).toEqual({ gap: -1, verdict: "no-floor" });
    expect(missing!.judge).toEqual({ gap: -2.11, verdict: "no-floor" });
  });

  test("no gap where an arm has no objective grade or judge mean", () => {
    const ungraded = {
      cases: [],
      arms: [
        { arm: "b", objective: { passed: 0, graded: 0, pending: 1 }, judge: { mean: null, cases: 0 } },
        { arm: "c", objective: { passed: 1, graded: 1, pending: 0 }, judge: { mean: 3, cases: 1 } },
      ],
    };
    expect(armGaps(ungraded, status("fresh", 1, 1))).toEqual([{
      arm: "c", vs: "b", objective: { gap: null, verdict: null }, judge: { gap: null, verdict: null },
    }]);
  });

  test("noiseReport carries the status and the gaps; null off a set run", () => {
    const fresh = status("fresh", 1, 0.5);
    expect(noiseReport(mixedSetReport(), fresh)).toEqual({ ...fresh, gaps: armGaps(grades, fresh) });
    const { set: _set, ...notSet } = mixedSetReport();
    expect(noiseReport(notSet, fresh)).toBeNull();
  });
});

describe("readNoiseFloors", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("reads the good floors, skips malformed and missing ones", () => {
    const project = mkdtempSync(join(tmpdir(), "noise-floor-"));
    dirs.push(project);
    const experiments = join(project, ".ralph", "logs", "experiments");
    const older = floorOf(TEN, "2026-11-18T04:00:00Z");
    const newer = floorOf(TEN, "2026-11-19T04:00:00Z");
    for (const [run, body] of [["run-old", JSON.stringify(older)], ["run-new", JSON.stringify(newer)], ["run-bad", "{not json"], ["run-wrong", JSON.stringify({ v: 2 })]] as const) {
      mkdirSync(join(experiments, run), { recursive: true });
      writeFileSync(join(experiments, run, NOISE_FLOOR_FILE), body);
    }
    mkdirSync(join(experiments, "run-none"), { recursive: true });
    const floors = readNoiseFloors(project);
    expect(floors).toHaveLength(2);
    expect(floors).toEqual(expect.arrayContaining([older, newer]));
    expect(latestFloor(floors)).toEqual(newer);
  });

  test("a project without experiments has no floors", () => {
    const project = mkdtempSync(join(tmpdir(), "noise-floor-"));
    dirs.push(project);
    expect(readNoiseFloors(project)).toEqual([]);
    expect(latestFloor([])).toBeNull();
  });
});

describe("noiseFloorSettings", () => {
  test("fills the defaults the project config leaves out", () => {
    expect(noiseFloorSettings({})).toEqual({ arms: 3, staleShare: 0.2 });
    expect(noiseFloorSettings({ evalsNoiseFloor: { arms: 5 } })).toEqual({ arms: 5, staleShare: 0.2 });
    expect(noiseFloorSettings({ evalsNoiseFloor: { staleShare: 0.5 } })).toEqual({ arms: 3, staleShare: 0.5 });
  });
});

describe("stampNoise", () => {
  const project = "/no/such/project";
  const setFloor = (spread: NoiseFloor["spread"], cases: string[] = [...MIXED_SET_CASES]): NoiseFloor => ({ ...floorOf(cases), spread });
  const reads = (overrides: Partial<NoiseReads> = {}): NoiseReads => ({
    floors: () => [],
    staleShare: () => 0.2,
    ...overrides,
  });

  test("a finished floor run records itself and yields its floor", () => {
    const { report, floor } = stampNoise(noiseFloorReport(), { project, noiseFloor: { measuredAt: MEASURED } }, reads());
    expect(report.noiseFloor).toEqual({ measuredAt: MEASURED });
    expect(report.noise).toBeUndefined();
    expect(floor).toEqual(measureFloor(noiseFloorReport(), MEASURED));
  });

  test("a stopped or unfinished floor run yields no floor, but still says what it was", () => {
    const config = { project, noiseFloor: { measuredAt: MEASURED } };
    const stopped = stampNoise({ ...noiseFloorReport(), stoppedBy: "batch-cap" }, config, reads());
    expect(stopped.floor).toBeNull();
    expect(stopped.report.noiseFloor).toEqual({ measuredAt: MEASURED });
    expect(stampNoise({ ...noiseFloorReport(), finishedAt: null }, config, reads()).floor).toBeNull();
  });

  test("a later set run is beyond a narrow fresh floor", () => {
    const { report, floor } = stampNoise(mixedSetReport(), { project }, reads({ floors: () => [setFloor({ objective: 0.5, judge: 0.66 })] }));
    expect(floor).toBeNull();
    expect(report.noise?.state).toBe("fresh");
    expect(report.noise?.gaps).toEqual([{ arm: "c", vs: "b", objective: { gap: -1, verdict: "beyond" }, judge: { gap: -2.11, verdict: "beyond" } }]);
  });

  test("a later set run is within a wide fresh floor", () => {
    const { report } = stampNoise(mixedSetReport(), { project }, reads({ floors: () => [setFloor({ objective: 1, judge: 3 })] }));
    expect(report.noise?.gaps.map((gap) => [gap.objective.verdict, gap.judge.verdict])).toEqual([["within", "within"]]);
  });

  test("the latest floor is the one used", () => {
    const old = { ...setFloor({ objective: 0, judge: 0 }), measuredAt: "2026-11-01T00:00:00Z" };
    const { report } = stampNoise(mixedSetReport(), { project }, reads({ floors: () => [setFloor({ objective: 1, judge: 3 }), old] }));
    expect(report.noise?.floor?.measuredAt).toBe(MEASURED);
  });

  test("a stale floor and a missing one are never beyond", () => {
    const stale = stampNoise(mixedSetReport(), { project }, reads({ floors: () => [setFloor({ objective: 0, judge: 0 }, TEN)] })).report.noise!;
    expect(stale.state).toBe("stale");
    expect(stale.gaps[0]).toMatchObject({ objective: { verdict: "stale" }, judge: { verdict: "stale" } });
    const missing = stampNoise(mixedSetReport(), { project }, reads()).report.noise!;
    expect(missing.state).toBe("missing");
    expect(missing.gaps[0]).toMatchObject({ objective: { verdict: "no-floor" }, judge: { verdict: "no-floor" } });
  });

  test("a run over a slice of the set is stale against the whole-set floor, never beyond", () => {
    const slice = { ...mixedSetReport(), set: { ...mixedSetReport().set!, selected: [MIXED_SET_CASES[0]!] } };
    const noise = stampNoise(slice, { project }, reads({ floors: () => [setFloor({ objective: 0, judge: 0 })] })).report.noise!;
    expect(noise.state).toBe("stale");
    expect(noise.drift).toMatchObject({ added: 0, retired: MIXED_SET_CASES.length - 1 });
    expect(noise.gaps.every((gap) => gap.objective.verdict !== "beyond" && gap.judge.verdict !== "beyond")).toBe(true);
  });

  test("a rescore of a floor run under a plain plan stays a floor run, never judged against itself", () => {
    const stamped = { ...noiseFloorReport(), noiseFloor: { measuredAt: MEASURED } };
    const { report, floor } = stampNoise(stamped, { project }, reads({ floors: () => [setFloor({ objective: 0, judge: 0 })] }));
    expect(report.noise).toBeUndefined();
    expect(report.noiseFloor).toEqual({ measuredAt: MEASURED });
    expect(floor).toEqual(measureFloor(stamped, MEASURED));
  });

  test("unreadable config or floors degrade, never throw", () => {
    const boom = (): never => { throw new Error("unreadable"); };
    const { report } = stampNoise(mixedSetReport(), { project }, reads({ floors: () => [setFloor({ objective: 5, judge: 5 })], staleShare: boom }));
    expect(report.noise).toMatchObject({ state: "fresh", staleShare: 0.2 });
    expect(stampNoise(mixedSetReport(), { project }, reads({ floors: boom })).report.noise?.state).toBe("missing");
  });

  test("a run off the test set is left alone and reads nothing", () => {
    const { set: _set, ...notSet } = mixedSetReport();
    const boom = (): never => { throw new Error("read"); };
    expect(stampNoise(notSet, { project }, { floors: boom, staleShare: boom })).toEqual({ report: notSet, floor: null });
  });
});
