/**
 * The noise floor of a test set (#859): how far N identical live-setup arms
 * drift apart on the same cases. A later set run's gap between two arms means
 * something only when it is wider than that floor.
 *
 * The objective score and the judge score each get their own floor, gap and
 * verdict, never a blended one (see eval-grade.ts): a judge-only improvement
 * must not borrow the objective floor, nor the other way round.
 *
 * Pure except readNoiseFloors and readFloorFile, which read the floors a
 * project stored, and stampNoise, which reads through the NoiseReads it is given.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { armList, MAX_ARMS, type ArmConfig, type BacktestConfig } from "./backtest";
import type { BacktestReport } from "./backtest-report";
import { gradeRun, round2, type ArmGrades, type RunGrades } from "./eval-grade";
import type { EvalCase } from "./evals-set";

/** The file a floor run stores beside its report. */
export const NOISE_FLOOR_FILE = "noise-floor.json";
export const DEFAULT_NOISE_FLOOR_ARMS = 3;
/** The share of the floor's cases that may come and go before it no longer describes the set. */
export const DEFAULT_STALE_SHARE = 0.2;

/** The project's `evalsNoiseFloor` with the defaults filled: how many identical arms a floor runs, and when it goes stale. */
export function noiseFloorSettings(config: { evalsNoiseFloor?: { arms?: number; staleShare?: number } }): { arms: number; staleShare: number } {
  return {
    arms: config.evalsNoiseFloor?.arms ?? DEFAULT_NOISE_FLOOR_ARMS,
    staleShare: config.evalsNoiseFloor?.staleShare ?? DEFAULT_STALE_SHARE,
  };
}

// round2 leaves float noise (0.66 vs 0.6600000000000001); it must not flip a boundary.
export const EPSILON = 1e-9;

/** N identical live arms live-1..live-N. Throws for N not an integer in 2..MAX_ARMS (a spread needs two arms). */
export function noiseFloorArms(n: number): ArmConfig[] {
  if (!Number.isInteger(n) || n < 2 || n > MAX_ARMS) throw new Error(`a noise floor needs 2 to ${MAX_ARMS} identical arms, got ${n}`);
  return Array.from({ length: n }, (_, i) => ({ name: `live-${i + 1}`, lineup: "live", overlay: null }));
}

export interface NoiseSpread { objective: number | null; judge: number | null }
export interface NoiseFloor {
  v: 1;
  /** report.set.version: the set version measured. */
  version: string;
  measuredAt: string;
  /** The report id of the floor run. */
  runId: string;
  /** The agent arm names (never the reference arm `a`). */
  arms: string[];
  /** report.set.selected: the cases the floor was measured on. */
  cases: string[];
  spread: NoiseSpread;
  perCase: { case: string; objective: number | null; judge: number | null }[];
}

/** max − min, or null below two values: one arm has nothing to differ from. */
function spreadOf(values: readonly number[]): number | null {
  return values.length < 2 ? null : round2(Math.max(...values) - Math.min(...values));
}

/** Pass rate over the tests-graded cases; null when the arm has none, so it takes no part. */
function passRate(arm: ArmGrades): number | null {
  return arm.objective.graded === 0 ? null : arm.objective.passed / arm.objective.graded;
}

/** The floor of a finished set run on identical arms; null when it is not a graded set run of a committed set. */
export function measureFloor(report: BacktestReport, measuredAt: string): NoiseFloor | null {
  const version = report.set?.version;
  if (version === null || version === undefined) return null;
  const arms = armList(report.arms).map((arm) => arm.name).filter((name) => name !== "a");
  const grades = gradeRun(report, arms);
  if (grades === null) return null;
  // Arms are compared on the same cases only: an arm whose trial did not run
  // a case would otherwise get a pass rate over fewer cases, and two rates
  // over different cases can agree by accident, storing a floor of 0.
  const full = (graded: RunGrades["cases"][number]) => graded.arms.length === grades.arms.length;
  const objectiveCases = grades.cases.filter((graded) => full(graded) && graded.arms.every((arm) => arm.objective === "pass" || arm.objective === "fail"));
  const judgedCases = grades.cases.filter((graded) => full(graded) && graded.arms.every((arm) => arm.judge !== null));
  const rates = objectiveCases.length === 0 ? [] : grades.arms.map((arm) =>
    objectiveCases.filter((graded) => graded.arms.find((entry) => entry.arm === arm.arm)?.objective === "pass").length / objectiveCases.length);
  const means = judgedCases.length === 0 ? [] : grades.arms.map((arm) =>
    round2(judgedCases.reduce((sum, graded) => sum + (graded.arms.find((entry) => entry.arm === arm.arm)?.judge ?? 0), 0) / judgedCases.length));
  return {
    v: 1,
    version,
    measuredAt,
    runId: report.id,
    arms,
    cases: [...report.set!.selected],
    spread: { objective: spreadOf(rates), judge: spreadOf(means) },
    perCase: grades.cases.map((graded) => {
      // A pending check or a missing result is no evidence of disagreement.
      const results = graded.arms.map((arm) => arm.objective).filter((result) => result === "pass" || result === "fail");
      const judged = graded.arms.map((arm) => arm.judge).filter((judge): judge is number => judge !== null);
      return {
        case: graded.case,
        objective: results.length < 2 ? null : new Set(results).size > 1 ? 1 : 0,
        judge: spreadOf(judged),
      };
    }),
  };
}

export type FloorState = "fresh" | "stale" | "missing";
export interface NoiseStatus {
  state: FloorState;
  floor: Pick<NoiseFloor, "version" | "measuredAt" | "runId" | "spread"> | null;
  /** Cases in play now that the floor never ran, and floor cases no longer in play; null when missing. */
  drift: { added: number; retired: number; share: number } | null;
  staleShare: number;
}

/**
 * Whether the floor still describes the set. Only ids and statuses count: a
 * case edited in place is the same case, and the set's commit moves on every
 * edit, so comparing versions would call every floor stale.
 */
export function floorStatus(floor: NoiseFloor | null, current: readonly Pick<EvalCase, "id" | "status">[], staleShare: number): NoiseStatus {
  if (floor === null) return { state: "missing", floor: null, drift: null, staleShare };
  // The same rule as selectCases: a retired case never runs, a saturated one does.
  const inPlay = new Set(current.filter((c) => c.status !== "retired").map((c) => c.id));
  // Nothing in play to compare is no evidence the floor still fits, whatever the share allows (staleShare may be 1).
  const empty = inPlay.size === 0;
  const measured = new Set(floor.cases);
  const added = [...inPlay].filter((id) => !measured.has(id)).length;
  const retired = [...measured].filter((id) => !inPlay.has(id)).length;
  const share = measured.size === 0 ? Number.POSITIVE_INFINITY : (added + retired) / measured.size;
  const { version, measuredAt, runId, spread } = floor;
  return {
    // A floor measured on no cases describes nothing, so it is stale whatever the set holds.
    state: measured.size === 0 || empty || share > staleShare + EPSILON ? "stale" : "fresh",
    floor: { version, measuredAt, runId, spread },
    drift: { added, retired, share: measured.size === 0 ? 1 : round2(share) },
    staleShare,
  };
}

export type GapVerdict = "within" | "beyond" | "stale" | "no-floor";
export interface AxisGap { gap: number | null; verdict: GapVerdict | null }
export interface ArmGap { arm: string; vs: string; objective: AxisGap; judge: AxisGap }

/** A missing or stale floor never calls a gap "beyond": it cannot vouch for one. */
function verdict(gap: number | null, spread: number | null, state: FloorState): GapVerdict | null {
  if (gap === null) return null;
  if (state === "missing") return "no-floor";
  if (state === "stale") return "stale";
  if (spread === null) return "no-floor";
  return Math.abs(gap) <= spread + EPSILON ? "within" : "beyond";
}

/** Each later agent arm against the first, one axis at a time. */
export function armGaps(grades: RunGrades, status: NoiseStatus): ArmGap[] {
  const [vs, ...rest] = grades.arms;
  if (vs === undefined) return [];
  const spread = status.floor?.spread ?? { objective: null, judge: null };
  return rest.map((arm): ArmGap => {
    const rate = passRate(arm);
    const base = passRate(vs);
    const objective = rate === null || base === null ? null : round2(rate - base);
    const judge = arm.judge.mean === null || vs.judge.mean === null ? null : round2(arm.judge.mean - vs.judge.mean);
    return {
      arm: arm.arm,
      vs: vs.arm,
      objective: { gap: objective, verdict: verdict(objective, spread.objective, status.state) },
      judge: { gap: judge, verdict: verdict(judge, spread.judge, status.state) },
    };
  });
}

export interface NoiseReport extends NoiseStatus { gaps: ArmGap[] }

/** Null when the report is not a graded set run. */
export function noiseReport(report: BacktestReport, status: NoiseStatus): NoiseReport | null {
  const grades = gradeRun(report, armList(report.arms).map((arm) => arm.name));
  if (grades === null) return null;
  return { ...status, gaps: armGaps(grades, status) };
}

const isSpread = (value: unknown): value is number | null => value === null || typeof value === "number";
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

function parseFloor(value: unknown): NoiseFloor | null {
  if (typeof value !== "object" || value === null) return null;
  const floor = value as Record<string, unknown>;
  if (floor.v !== 1) return null;
  if (typeof floor.version !== "string" || typeof floor.measuredAt !== "string" || typeof floor.runId !== "string") return null;
  if (!isStrings(floor.arms) || !isStrings(floor.cases)) return null;
  const spread = floor.spread as Record<string, unknown> | null;
  if (typeof spread !== "object" || spread === null || !isSpread(spread.objective) || !isSpread(spread.judge)) return null;
  if (!Array.isArray(floor.perCase)) return null;
  const perCaseOk = floor.perCase.every((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return false;
    const c = entry as Record<string, unknown>;
    return typeof c.case === "string" && isSpread(c.objective) && isSpread(c.judge);
  });
  return perCaseOk ? (floor as unknown as NoiseFloor) : null;
}

/** The floor stored at `path`; null when it is absent, unreadable or malformed, never thrown. */
export function readFloorFile(path: string): NoiseFloor | null {
  try {
    return existsSync(path) ? parseFloor(JSON.parse(readFileSync(path, "utf8"))) : null;
  } catch {
    return null;
  }
}

/** Every readable `<project>/.ralph/logs/experiments/*\/noise-floor.json`; unreadable/malformed files are skipped, never thrown. */
export function readNoiseFloors(project: string): NoiseFloor[] {
  const root = join(project, ".ralph", "logs", "experiments");
  let runs: string[];
  try {
    runs = existsSync(root) ? readdirSync(root) : [];
  } catch {
    return [];
  }
  const floors: NoiseFloor[] = [];
  for (const run of runs.sort()) {
    const path = join(root, run, NOISE_FLOOR_FILE);
    try {
      if (!existsSync(path)) continue;
      const floor = parseFloor(JSON.parse(readFileSync(path, "utf8")));
      if (floor !== null) floors.push(floor);
    } catch {
      // One unreadable floor must not hide the others from the operator.
    }
  }
  return floors;
}

/** Newest by measuredAt, or null. */
export function latestFloor(floors: readonly NoiseFloor[]): NoiseFloor | null {
  let latest: NoiseFloor | null = null;
  for (const floor of floors) {
    if (latest === null || Date.parse(floor.measuredAt) > Date.parse(latest.measuredAt)) latest = floor;
  }
  return latest;
}

/** What stampNoise reads beyond the report; injectable so tests pass fixtures instead of touching git. */
export interface NoiseReads {
  floors(project: string): NoiseFloor[];
  staleShare(project: string): number;
}

/**
 * A scored report as it is written, and the floor to store beside it.
 *
 * A floor run records itself as one and, once finished whole, yields its
 * floor: a run the batch cap stopped measured fewer cases than it claims.
 * The report's own stamp wins over the config's, so a rescore of a floor
 * run under another plan stays a floor run, never judged against itself.
 *
 * Any other set run carries its gaps against the latest floor, its drift
 * counted against the cases THIS run ran: a run over a slice of the set is
 * far from the whole-set floor and reads stale, never "beyond" on a handful
 * of cases. On a whole-set run that is exactly the cases added and retired
 * since the floor. Every read degrades: an unreadable config is the default
 * stale share, unreadable floors are no floor. It never throws.
 */
export function stampNoise(report: BacktestReport, config: Pick<BacktestConfig, "project" | "noiseFloor">, reads: NoiseReads): { report: BacktestReport; floor: NoiseFloor | null } {
  const floorRun = report.noiseFloor ?? config.noiseFloor;
  if (floorRun !== undefined) {
    const { measuredAt } = floorRun;
    const { noise: _noise, ...rest } = report;
    const stamped = { ...rest, noiseFloor: { measuredAt } };
    const finished = report.finishedAt !== null && report.stoppedBy === null;
    return { report: stamped, floor: finished ? measureFloor(stamped, measuredAt) : null };
  }
  if (report.set === undefined) return { report, floor: null };
  const ran = report.set.selected.map((id) => ({ id, status: "active" as const }));
  const floors = attempt(() => reads.floors(config.project), []);
  const staleShare = attempt(() => reads.staleShare(config.project), DEFAULT_STALE_SHARE);
  const noise = attempt(() => noiseReport(report, floorStatus(latestFloor(floors), ran, staleShare)), null);
  return { report: noise === null ? report : { ...report, noise }, floor: null };
}

function attempt<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}
