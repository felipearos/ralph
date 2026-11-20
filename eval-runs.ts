/**
 * Eval runs as the dashboard sees them (#801): the project's runs listed as a
 * summary view, a run started from a plan the page built, and a run stopped.
 * `experiments.ts runs|start|stop|patch` print these; the dashboard shells
 * out to them and never imports this module.
 *
 * The view is a SUMMARY: scores, verdicts, the analyst's notes and run
 * metrics, never a diff, a patch or a test body. It is what the bridge may
 * push to the hosted store for any project, client code included; the
 * patches stay on the host behind `patch`, which the page reads locally.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { armList, codexJudgeModel, configArms, DEFAULT_JUDGE_MODEL, judgeSpecs, parseBacktest, repeatCount, type ArmConfig, type BacktestConfig, type BacktestSample } from "./backtest";
import { repeatSummaries, type ArmResolution, type BacktestReport, type RepeatSummary, type ResolvedStage, type TrialRow } from "./backtest-report";
import { backtestRunDir, lineupPath } from "./backtest-trial";
import { segment } from "./backtest-run";
import { gradeRun, round2, type RunGrades } from "./eval-grade";
import type { GuardrailVerdict } from "./eval-guardrails";
import { reportJudgeAccuracy, type CalibratedCase, type JudgeAccuracy } from "./eval-judge-accuracy";
import { NOISE_FLOOR_FILE, noiseFloorSettings, readFloorFile, type NoiseReport, type NoiseSpread } from "./eval-noise-floor";
import { AXES, contestedRuleLabel, type Axis } from "./eval-panel";
import { JIRA_TOKEN_ENV, parseJiraToken } from "./clerk/jira";
import { selectCases } from "./eval-set-source";
import { readSet as readEvalSet, type EvalCase } from "./evals-set";
import { clerkRules, loadProjectConfig } from "./project-config";
import { projectIdFor } from "./project-id";
import { loopsWithRole, roleOf } from "./roster";
import { keyedProjectTracker } from "./tracker/project";

const HERE = resolve(import.meta.dirname);

/**
 * Judge reasons and analyst notes may quote code: kept to prose and a bounded
 * length, so client code stays on the host. Every fenced block and every
 * inline code span goes, however short; a span that only names a file path or
 * a line is evidence, not code, so it stays readable without its backticks.
 */
const TEXT_CHARS = 600;
/**
 * A path whose last segment names a file (`src/app.ts`, `./x/y.md`), with an
 * optional `:42`, `:42:7` or `:10-20`; a bare file name only with a line
 * (`app.ts:42`, so `obj.method` stays code); or a short line number (`42`,
 * `L10-L20`). A slash alone is not enough: `total/count` and `api/v1/users`
 * are code or routes, not evidence.
 */
const EVIDENCE_SPAN = /^(?:(?:[\w.@-]*\/)+[\w@-][\w.@-]*\.[A-Za-z]\w*(?::\d+(?:[:-]\d+)?)?|[\w@-][\w.@-]*\.[A-Za-z]\w*:\d+(?:[:-]\d+)?|L?\d{1,6}(?:-L?\d{1,6})?)$/;
export function prose(text: string): string {
  const flat = text
    .replace(/```[\s\S]*?(?:```|$)/g, " [code] ")
    // Collapsed before the span pass, so a span hard-wrapped across lines is still one span.
    .replace(/\s+/g, " ");
  const inline = flat.replace(/(`+)(.+?)\1(?!`)/g, (_span, _ticks, content: string) => {
    const kept = content.trim();
    return EVIDENCE_SPAN.test(kept) ? kept : " [code] ";
  });
  // A backtick left over means one was unpaired, and the pairing may have
  // shifted onto prose and let code through anywhere after the first tick:
  // dropping the rest from there is safer than relaying it.
  const unpaired = inline.includes("`");
  const stripped = (unpaired ? `${flat.slice(0, flat.indexOf("`"))} [code]` : inline).replace(/\s+/g, " ").trim();
  return stripped.length > TEXT_CHARS ? `${stripped.slice(0, TEXT_CHARS).trimEnd()}…` : stripped;
}

export interface EvalCaseArmView {
  arm: string;
  /** Null for the reference: it is what merged. */
  outcome: string | null;
  gates: string | null;
  /** `passed/evidence` over held-out tests that failed on the base; null when none apply. */
  heldOut: string | null;
  findings: { P1: number; P2: number; P3: number } | null;
  rounds: number | null;
  wallSeconds: number | null;
  tokens: number | null;
  costUsd: number | null;
  /** Each judge's scores for this arm. */
  axes: { judge: string; scores: Record<Axis, number | null>; better: string }[];
  /**
   * A test-set run's objective result for this arm (#855); null for the
   * reference, off a set run, or where the case has no objective grader.
   * Never combined with `judge`.
   */
  objective: "pass" | "fail" | "pending" | null;
  /** The mean of the arm's axis scores over the answering judges, to 2 decimals (#855); null where unscored or off a set run. */
  judge: number | null;
}

export interface EvalCaseView {
  key: string;
  title: string;
  repo: string;
  prs: number[];
  reference: "person" | "loop" | "mixed" | null;
  arms: EvalCaseArmView[];
  /** The panel's ranking, best first; null when not judged. */
  ranking: string[][] | null;
  judges: { name: string; runner: string; status: "ok" | "unavailable"; reason: string }[];
  /** Two arms under inversion, one under spread. */
  contested: { axis: Axis; arms: string[] }[];
  /** The rule that decided `contested`, in words; null when the case has no panel. */
  contestedRule: string | null;
  /** What decides the case objectively on a test-set run (#855); null off a set run or when unscored. */
  grade: { grader: "tests" | "check" | "judge-only"; noEvidence: boolean } | null;
}

export interface EvalArmTotal {
  arm: string;
  ran: number;
  green: number;
  judged: number;
  wins: number;
  costUsd: number | null;
  /** True when some trial's cost is unknown, so `costUsd` is a lower bound. */
  costPartial: boolean;
  tokens: number | null;
  medianWallSeconds: number | null;
  heldOut: string | null;
  /** A test-set run's objective tally (#855): tests cases passed of graded, check cases pending; null off a set run. */
  objective: { passed: number; graded: number; pending: number } | null;
  /** A test-set run's mean judge score over the cases judged (#855), kept apart from `objective`; null off a set run. */
  judge: { mean: number | null; cases: number } | null;
}

/** The tally only: the view is relayed to the remote store, so the per-verdict list stays on the host. */
export type EvalJudgeAccuracy = Omit<JudgeAccuracy, "checks">;

export interface EvalRunSummary {
  id: string;
  dir: string;
  kind: "eval" | "backtest" | "nightly";
  startedAt: string;
  finishedAt: string | null;
  running: boolean;
  stoppedBy: string | null;
  source:
    | { kind: "pr"; repo: string; prs: number[]; ticket: string | null }
    | { kind: "clerk"; clerk: string }
    /** The test set (#854): the commit the run read, its filter, and the selected cases it could not run. */
    | { kind: "set"; version: string | null; tags: string[]; cases: string[]; unrunnable: { id: string; reason: string }[] };
  arms: ArmConfig[];
  /** The panel the run recorded it used (#816), else the one its config names. */
  panel: { name: string; runner: string; model: string }[];
  /** What each arm resolved to and the panel's seed (#816); null when the report is missing or predates it. */
  resolved: { arms: Record<string, ArmResolution>; seed: string | null } | null;
  repeats: number;
  cases: EvalCaseView[];
  totals: EvalArmTotal[];
  /** Each repeated case's arms over all their trials: green runs, mean axis scores and spread, the first trial's verdict (#821). */
  repeated: RepeatSummary[];
  analysis: { status: "ok"; summary: string; improvements: { knob: string; target: string; change: string; arm: string; evidence: string[] }[] }
    | { status: "unavailable"; reason: string } | null;
  /** A later set run's gaps against the noise floor (#859), as the report recorded them; null before it or off a set run. */
  noise: NoiseReport | null;
  /** On a run that measures the noise floor (#859): when, and whether its floor was stored (a stopped run stores none). */
  noiseFloor: { measuredAt: string; stored: boolean; spread: NoiseSpread | null } | null;
  /** A set run's guardrail verdict (#871): whether its proposal arm earns a PR, per goal; null when the report has none. */
  guardrails: GuardrailVerdict | null;
  /**
   * A set run's agreement with the operator's calibration verdicts (#877),
   * computed fresh from the set so a verdict recorded after the run counts;
   * null off a set run, on a run with no scores yet, or when the set cannot be read.
   */
  judgeAccuracy: EvalJudgeAccuracy | null;
  /** Why the run directory could not be read whole. */
  problem: string | null;
}

export interface EvalRunsView {
  version: 1;
  runs: EvalRunSummary[];
  /** The lineup files an arm can name, besides `live`. */
  lineups: string[];
  /** What the Run screen starts from. */
  /** `noiseFloorArms`: the project's identical arms per noise-floor run (#859), so the screen shows the trial count before a measurement. */
  defaults: { panel: { name: string; runner: "claude" | "codex"; model: string }[]; trialMinutes: number; repeats: number; noiseFloorArms: number };
  /** Past trials of this project, for the Run screen's estimate; null with none. */
  history: { trialSeconds: number | null; trialTokens: number | null; trials: number };
  /** The project's `relayEvalPatches`: whether its trials' patches may leave the host (#825). */
  relayPatches: boolean;
  /** The project's clerks in roster order, which the Run card offers a clerk backtest's source from. */
  clerks: string[];
  /** The repos besides the project's own that a clerk's sample draws from: each needs a checkout the page names. */
  clerkRepos: string[];
}

const readJson = <T>(path: string): T | null => {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
};
const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const tokensOf = (row: TrialRow): number | null => (row.tokens ? row.tokens.input + row.tokens.cacheRead + row.tokens.cacheWrite + row.tokens.output : null);
const PASSING = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const gateLine = (gates: { conclusion: string }[] | null | undefined): string | null =>
  gates ? `${gates.filter((gate) => PASSING.has(gate.conclusion)).length}/${gates.length}` : null;

export const experimentsRoot = (project: string): string => join(project, ".ralph", "logs", "experiments");
const PID_FILE = "eval.pid";
const LOG_FILE = "eval.log";
const PLAN_FILE = "plan.json";

/** Whether the run's process is alive: its pid file names a live `experiments.ts` process. */
export function runAlive(dir: string): boolean {
  const pid = Number(readFileSync(join(dir, PID_FILE), "utf8").trim() || "0");
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); } catch { return false; }
  // A recycled pid is some other process: only one running this CLI is the run.
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("experiments.ts"); } catch { return true; }
}

const alive = (dir: string): boolean => { try { return runAlive(dir); } catch { return false; } };

/**
 * The run's grades (#855), or null off a test-set run. report.json is read
 * over a process boundary: a report too malformed to grade costs the page
 * the grades, never the run.
 */
function runGrades(report: BacktestReport, arms: readonly string[]): RunGrades | null {
  try { return gradeRun(report, arms); } catch { return null; }
}

function caseView(report: BacktestReport, sample: BacktestSample | null, key: string, grades: RunGrades | null): EvalCaseView {
  const ticket = sample?.tickets.find((entry) => entry.oaKey === key);
  const score = report.scores?.find((entry) => entry.ticket === key);
  const verdicts = score?.panel?.verdicts ?? [];
  const graded = grades?.cases.find((entry) => entry.case === key);
  const firsts = report.rows.filter((row) => row.ticket === key && row.repeat === undefined);
  const armNames = ["a", ...firsts.map((row) => row.arm)];
  const arms: EvalCaseArmView[] = armNames.flatMap((arm): EvalCaseArmView[] => {
    const row = firsts.find((entry) => entry.arm === arm);
    const scored = score?.arms.find((entry) => entry.arm === arm);
    if (arm === "a" && scored === undefined) return [];
    const held = scored?.heldOut;
    const evidence = held?.status === "ok" ? held.files.filter((file) => file.baseline === "fail") : null;
    const final = scored?.review?.final;
    const armGrade = graded?.arms.find((entry) => entry.arm === arm);
    return [{
      arm,
      outcome: arm === "a" ? null : row?.outcome ?? null,
      gates: gateLine(scored?.gates ?? row?.gates),
      heldOut: evidence === null ? null : `${evidence.filter((file) => file.result === "pass").length}/${evidence.length}`,
      findings: final?.status === "ok" ? final.counts : null,
      rounds: arm === "a" ? scored?.human?.rounds ?? null : row?.reviewRounds ?? null,
      wallSeconds: arm === "a" ? scored?.human?.openToMergeSeconds ?? null : row?.wallSeconds ?? null,
      tokens: row ? tokensOf(row) : null,
      costUsd: row?.cost.usd ?? null,
      axes: verdicts.flatMap((verdict) => {
        if (verdict.status !== "ok" || verdict.arms[arm] === undefined) return [];
        const given = verdict.arms[arm]!;
        const scores = Object.fromEntries(AXES.map((axis) => [axis, given.axes[axis].score])) as Record<Axis, number | null>;
        return [{ judge: verdict.judge.name, scores, better: prose(given.better) }];
      }),
      objective: armGrade?.objective ?? null,
      judge: typeof armGrade?.judge === "number" ? round2(armGrade.judge) : null,
    }];
  });
  const judge = score?.judge;
  return {
    key,
    title: ticket?.frozen.title ?? key,
    repo: ticket?.repo ?? "",
    prs: ticket?.humanPrs.map((pr) => pr.number) ?? [],
    reference: ticket?.reference ?? (ticket ? "person" : null),
    arms,
    ranking: judge?.status === "ok" ? judge.ranking : null,
    judges: verdicts.map((verdict) => ({
      name: verdict.judge.name, runner: verdict.judge.runner, status: verdict.status, reason: prose(verdict.reason),
    })),
    contested: (score?.panel?.contested ?? []).map((entry) => ({ axis: entry.axis, arms: entry.arms })),
    // A panel written before #818 carries no rule; inversion was the only one then.
    contestedRule: score?.panel ? contestedRuleLabel(score.panel.rule ?? { kind: "inversion" }) : null,
    grade: graded === undefined ? null : { grader: graded.grader, noEvidence: graded.noEvidence },
  };
}

function totals(report: BacktestReport, arms: readonly string[], grades: RunGrades | null): EvalArmTotal[] {
  return arms.map((arm) => {
    const ran = report.rows.filter((row) => row.arm === arm && row.repeat === undefined && row.outcome !== "not-run");
    let judged = 0;
    let wins = 0;
    for (const score of report.scores ?? []) {
      if (score.judge?.status !== "ok" || !score.judge.order.includes(arm)) continue;
      judged++;
      if (score.judge.winners.includes(arm)) wins++;
    }
    const costs = ran.map((row) => row.cost.usd);
    const known = costs.filter((cost): cost is number => cost !== null);
    const tokens = ran.map(tokensOf).filter((value): value is number => value !== null);
    const graded = grades?.arms.find((entry) => entry.arm === arm);
    const evidence = (report.scores ?? []).flatMap((score) => score.arms.filter((entry) => entry.arm === arm))
      .flatMap((entry) => (entry.heldOut?.status === "ok" ? entry.heldOut.files : [])).filter((file) => file.baseline === "fail");
    return {
      arm, ran: ran.length, green: ran.filter((row) => row.outcome === "green-pr").length, judged, wins,
      costUsd: known.length === 0 ? null : known.reduce((a, b) => a + b, 0), costPartial: known.length < costs.length,
      tokens: tokens.length === 0 ? null : tokens.reduce((a, b) => a + b, 0),
      medianWallSeconds: median(ran.map((row) => row.wallSeconds)),
      heldOut: evidence.length === 0 ? null : `${evidence.filter((file) => file.result === "pass").length}/${evidence.length}`,
      objective: graded?.objective ?? null,
      judge: graded?.judge ?? null,
    };
  });
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === "string";

/**
 * A report's recorded resolution (#816), read defensively: report.json is
 * read over a process boundary, and a malformed field must cost the page
 * that field, never the run. An arm or stage that does not parse is dropped.
 */
function readResolution(value: unknown): { arms: Record<string, ArmResolution>; seed: string | null; panel: { name: string; runner: string; model: string }[] | null } | null {
  if (!isObject(value) || !isObject(value.arms)) return null;
  const arms: Record<string, ArmResolution> = {};
  for (const [name, arm] of Object.entries(value.arms)) {
    if (!isObject(arm) || !Array.isArray(arm.stages) || !isNullableString(arm.overlayHash)) continue;
    const stages: ResolvedStage[] = arm.stages.filter((stage): stage is ResolvedStage =>
      isObject(stage) && isString(stage.stage) && isString(stage.runner) && isString(stage.model) && isNullableString(stage.effort))
      .map((stage) => ({ stage: stage.stage, runner: stage.runner, model: stage.model, effort: stage.effort }));
    arms[name] = { stages, overlayHash: arm.overlayHash };
  }
  const panel = Array.isArray(value.panel) && value.panel.every((judge) => isObject(judge) && isString(judge.name) && isString(judge.runner) && isString(judge.model))
    ? (value.panel as { name: string; runner: string; model: string }[]).map((judge) => ({ name: judge.name, runner: judge.runner, model: judge.model }))
    : null;
  return { arms, seed: isString(value.seed) ? value.seed : null, panel };
}

/** One run directory as the page shows it. Never throws: what cannot be read is the summary's `problem`. */
export function runSummary(dir: string): EvalRunSummary | null {
  const state = readJson<{ id: string; startedAt: string; config: BacktestConfig; sample: BacktestSample }>(join(dir, "state.json"));
  const plan = state === null ? readJson<unknown>(join(dir, PLAN_FILE)) : null;
  // A run started from the page writes its plan before its first state: show it as starting.
  let config: BacktestConfig | null = state?.config ?? null;
  if (config === null && plan !== null) { try { config = parseBacktest(plan); } catch { config = null; } }
  if (config === null) return null;
  const name = basename(dir);
  const report = readJson<BacktestReport>(join(dir, "report.json"));
  const arms = state ? armList(state.sample.arms) : configArms(config);
  const keys = [...new Set((report?.rows ?? []).map((row) => row.ticket))];
  const analysis = report?.analysis;
  const resolved = readResolution(report?.resolved);
  const grades = report === null ? null : runGrades(report, arms.map((arm) => arm.name));
  // The report's stamp is what the run did; the config's is what it set out to do, all a starting run has.
  const floorRun = report?.noiseFloor ?? config.noiseFloor;
  const floor = floorRun === undefined ? null : readFloorFile(join(dir, NOISE_FLOOR_FILE));
  return {
    id: state?.id ?? name,
    dir: name,
    kind: config.source !== undefined ? "eval" : name.startsWith("nightly-") ? "nightly" : "backtest",
    startedAt: state?.startedAt ?? (() => { try { return statSync(join(dir, PLAN_FILE)).mtime.toISOString(); } catch { return ""; } })(),
    finishedAt: report?.finishedAt ?? null,
    running: alive(dir),
    stoppedBy: report?.stoppedBy ?? null,
    source: config.source === undefined
      ? { kind: "clerk", clerk: config.clerk }
      : config.source.kind === "set"
        ? {
          kind: "set", version: (report?.set ?? state?.sample.set)?.version ?? null, tags: config.source.tags, cases: config.source.cases,
          unrunnable: (report?.skipped ?? state?.sample.skipped ?? []).map((skip) => ({ id: skip.oaKey, reason: skip.reason })),
        }
        : { kind: "pr", repo: config.source.repo, prs: config.source.prs, ticket: config.source.ticket },
    arms,
    // What the run actually used beats what its config names now.
    panel: resolved?.panel ?? (config.scoring.judge === null ? [] : judgeSpecs(config.scoring.judge)),
    resolved: resolved === null ? null : { arms: resolved.arms, seed: resolved.seed },
    repeats: repeatCount(config),
    cases: report === null ? [] : keys.map((key) => caseView(report, state?.sample ?? null, key, grades)),
    totals: report === null ? [] : totals(report, arms.map((arm) => arm.name), grades),
    repeated: report === null ? [] : repeatSummaries({ ...report, arms: state?.sample.arms ?? report.arms }),
    analysis: !analysis ? null : analysis.status === "ok"
      ? { status: "ok", summary: prose(analysis.summary), improvements: analysis.improvements.map((entry) => ({ ...entry, change: prose(entry.change), target: prose(entry.target) })) }
      : { status: "unavailable", reason: prose(analysis.reason) },
    noise: report?.noise ?? null,
    guardrails: report?.guardrails ?? null,
    // Needs the project's set, which a lone run directory cannot name: listRuns fills it.
    judgeAccuracy: null,
    noiseFloor: floorRun === undefined ? null : { measuredAt: floorRun.measuredAt, stored: floor !== null, spread: floor?.spread ?? null },
    problem: state !== null && report === null && !alive(dir) ? "the run has no report: it stopped before its first trial finished, or is starting" : null,
  };
}

const isDir = (path: string): boolean => { try { return statSync(path).isDirectory(); } catch { return false; } };
const subdirs = (dir: string): string[] => { try { return readdirSync(dir).filter((name) => isDir(join(dir, name))).sort(); } catch { return []; } };

/** The run directories under the project, and the runs among them, newest first. */
export function runsNewestFirst(project: string): { dirs: string[]; runs: EvalRunSummary[] } {
  const root = experimentsRoot(project);
  const dirs = existsSync(root) ? readdirSync(root).map((name) => join(root, name)).filter(isDir) : [];
  const runs = dirs.map(runSummary).filter((run): run is EvalRunSummary => run !== null)
    .sort((a, b) => (b.startedAt < a.startedAt ? -1 : b.startedAt > a.startedAt ? 1 : 0));
  return { dirs, runs };
}

/**
 * The project's opt-in to relaying its trials' patches. A config that cannot
 * be loaded reads as off: the patch is the project's code, so doubt keeps it
 * on this host, and the page must still list runs.
 */
export function relaysPatches(project: string): boolean {
  try { return loadProjectConfig(project).relayEvalPatches === true; } catch { return false; }
}

/** The project's test set with its calibration verdicts, or null when it cannot be read. */
export type CalibrationReader = (project: string) => CalibratedCase[] | null;

/**
 * No fetch: the dashboard polls the run list, and a fetch per poll costs too
 * much; the local origin/main already holds what this host's set writes pushed.
 */
const defaultReadCalibration: CalibrationReader = (project) => readEvalSet(projectIdFor(project).id, undefined, undefined, { fetch: false }).cases;

/**
 * Each set run's judge accuracy against the set read once. Never throws: a set
 * that cannot be read, or a report that cannot be tallied, is no accuracy.
 */
function withJudgeAccuracy(project: string, dirs: string[], runs: EvalRunSummary[], read: CalibrationReader): EvalRunSummary[] {
  if (!runs.some((run) => run.source.kind === "set")) return runs;
  let cases: CalibratedCase[] | null;
  try { cases = read(project); } catch { cases = null; }
  if (cases === null) return runs;
  const set = cases;
  return runs.map((run) => {
    // A floor run's arms are identical by design, and its report carries no accuracy either (#877).
    if (run.source.kind !== "set" || run.noiseFloor !== null) return run;
    const dir = dirs.find((path) => basename(path) === run.dir);
    const report = dir === undefined ? null : readJson<BacktestReport>(join(dir, "report.json"));
    if (report === null) return run;
    try {
      const accuracy = reportJudgeAccuracy(report, set);
      if (accuracy === null) return run;
      const { checks: _onHost, ...tally } = accuracy;
      return { ...run, judgeAccuracy: tally };
    } catch {
      return run;
    }
  });
}

/** Every run of the project, newest first, with what the Run screen needs. */
export function listRuns(project: string, home = homedir(), options: { readCalibration?: CalibrationReader } = {}): EvalRunsView {
  const newest = runsNewestFirst(project);
  const dirs = newest.dirs;
  const runs = withJudgeAccuracy(project, dirs, newest.runs, options.readCalibration ?? defaultReadCalibration);
  const lineupDir = join(home, ".ralph", "lineups");
  const lineups = existsSync(lineupDir) ? readdirSync(lineupDir).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).sort() : [];
  // Past trials: each run's first trials that ran, for a per-trial estimate.
  const trials = dirs.flatMap((dir) => readJson<BacktestReport>(join(dir, "report.json"))?.rows ?? []).filter((row) => row.outcome !== "not-run");
  const codex = codexJudgeModel();
  // A missing or broken config costs the page its clerk source, never the run list.
  let clerks: string[] = [];
  let clerkRepos: string[] = [];
  let noiseFloorArms = noiseFloorSettings({}).arms;
  try {
    const config = loadProjectConfig(project);
    noiseFloorArms = noiseFloorSettings(config).arms;
    clerks = loopsWithRole("clerk", config.roster);
    const rules = clerkRules(config);
    // The page names a checkout for each; the project's own is mapped already.
    clerkRepos = rules === null ? [] : clerkSampleRepos(rules).filter((repo) => repo !== config.repo);
  } catch { clerks = []; clerkRepos = []; }
  return {
    version: 1,
    runs,
    lineups,
    defaults: {
      // The engine's own default, so the screen shows the panel that would judge.
      panel: judgeSpecs({ model: DEFAULT_JUDGE_MODEL, defaultPanel: true }, codex),
      trialMinutes: 90,
      repeats: 2,
      noiseFloorArms,
    },
    history: {
      trialSeconds: median(trials.map((row) => row.wallSeconds)),
      trialTokens: median(trials.map(tokensOf).filter((value): value is number => value !== null)),
      trials: trials.length,
    },
    relayPatches: relaysPatches(project),
    clerks,
    clerkRepos,
  };
}

/** Reads a project's test set (#853); injectable so a test needs no evals checkout. */
export type SetReader = (project: string) => { version: string | null; cases: EvalCase[] };

const defaultReadSet: SetReader = (project) => readEvalSet(projectIdFor(project).id);

/**
 * The plan the page sends, completed from the project: its root, its repo
 * and checkout as the source, its worktree setup as the scoring setup, and a
 * batch cap that fits every trial. Throws, in the parser's words, on a plan
 * that would not run. A set plan's cap fits the cases it selects from the
 * project's test set; a set that cannot be read refuses the start.
 */
export function completePlan(project: string, given: unknown, options: { readSet?: SetReader } = {}): { plan: Record<string, unknown>; config: BacktestConfig } {
  if (typeof given !== "object" || given === null || Array.isArray(given)) throw new Error("eval plan: must be an object");
  const plan = { ...(given as Record<string, unknown>) };
  const config = loadProjectConfig(project);
  const source = typeof plan.source === "object" && plan.source !== null ? { ...(plan.source as Record<string, unknown>) } : null;
  // A set source names no repo (its cases carry their own) and its parser refuses unknown keys.
  const set = source?.kind === "set";
  if (source !== null && !set && source.repo === undefined) source.repo = config.repo;
  const repo = typeof source?.repo === "string" ? source.repo : config.repo;
  const arms = Array.isArray(plan.arms) ? plan.arms.length : 1;
  // A clerk plan backtests a sample of cases, not one PR: the cap must fit
  // every case, and the engine's own clerk default is no repeats. A cap that
  // is not a positive integer counts as one; parseBacktest refuses it below.
  const clerk = (plan.source === undefined || plan.source === null) && plan.clerk !== undefined;
  const sampleCap = (plan.sample as { cap?: unknown } | undefined)?.cap;
  // A noise floor describes the whole set: a floor over a slice would be read against runs it never saw.
  const noiseFloor = plan.noiseFloor !== undefined && plan.noiseFloor !== null;
  if (noiseFloor && set && source !== null && [source.tags, source.cases].some((list) => list !== undefined && list !== null && !(Array.isArray(list) && list.length === 0))) {
    throw new Error("eval plan: a noise floor runs the whole test set");
  }
  let selected = 0;
  if (set && source !== null) {
    const read = (options.readSet ?? defaultReadSet)(project);
    selected = selectCases(read.cases, { tags: stringList(source.tags), cases: stringList(source.cases) }).length;
    // Refused here, not in the background run whose log the page cannot show (#827).
    if (selected === 0) throw new Error("eval plan: the test set selects no case for this plan; a retired case never runs");
    // Pinned so the run directory's hash follows the set: a changed set is a new run, not a resume of the old sample.
    if (source.version === undefined) source.version = read.version;
  }
  const cases = set
    ? selected
    : clerk && typeof sampleCap === "number" && Number.isInteger(sampleCap) && sampleCap > 0 ? sampleCap : 1;
  // A noise floor repeats nothing, like the engine's repeatCount: identical arms disagreeing is the measurement.
  const repeats = typeof plan.repeats === "number" ? plan.repeats : clerk || noiseFloor ? 0 : 2;
  const caps = (plan.caps ?? {}) as Record<string, unknown>;
  const trialMinutes = typeof caps.trialMinutes === "number" ? caps.trialMinutes : 90;
  // The project's own setup fits the project's own repo; a clerk's trials
  // clone its app repos, whose setup only a config file can name.
  const setup = clerk ? "" : config.worktreeSetup.map((step) => step.command).join(" && ");
  const scoring = { ...(setup === "" ? {} : { setup }), ...((plan.scoring ?? {}) as Record<string, unknown>) };
  // The plan as written, not the parsed config: `eval` parses it again, and the parsed shape is not a config file.
  const completed: Record<string, unknown> = {
    ...plan,
    project,
    ...(source === null ? {} : { source }),
    ...(noiseFloor && plan.repeats === undefined ? { repeats } : {}),
    caps: { trialMinutes, batchMinutes: typeof caps.batchMinutes === "number" ? caps.batchMinutes : trialMinutes * arms * cases * (1 + repeats) },
    sources: { [repo]: project, ...((plan.sources ?? {}) as Record<string, unknown>) },
    scoring,
  };
  return { plan: completed, config: parseBacktest(completed) };
}

/** A plan's list as given, for the cap only: parseBacktest refuses a malformed one. */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** How a run is launched: `systemd-run --scope` when there is one, so restarting the dashboard does not end it. */
export interface Launcher { (args: { command: string; argv: string[]; cwd: string; log: string; unit: string }): number }

export const launch: Launcher = ({ command, argv, cwd, log, unit }) => {
  const scoped = spawnSync("systemd-run", ["--user", "--version"], { encoding: "utf8", timeout: 10_000 }).status === 0;
  const out = openSync(log, "a");
  try {
    const [bin, args] = scoped
      ? ["systemd-run", ["--user", "--scope", "--quiet", "--collect", "--unit", unit, command, ...argv]]
      : [command, argv];
    const child = spawn(bin, args, { cwd, detached: true, stdio: ["ignore", out, out] });
    child.unref();
    if (child.pid === undefined) throw new Error(`eval: ${bin} did not start`);
    return child.pid;
  } finally {
    closeSync(out);
  }
};

/**
 * Why a clerk plan's run would die before its first state, or null. The
 * background run would refuse these too, but only into its log, which the
 * page cannot show: it would list a reasonless stopped run (#827).
 */
export function clerkStartProblem(project: string, config: BacktestConfig, env: NodeJS.ProcessEnv = process.env): string | null {
  if (config.source !== undefined) return null;
  const projectConfig = loadProjectConfig(project);
  const rules = clerkRules(projectConfig);
  if (rules === null) return `eval plan: the project has no clerk block, so clerk ${config.clerk} has no person tickets to replay`;
  // A relayed plan, or a page loaded before the roster changed, can name any kebab-case loop.
  if (roleOf(config.clerk, projectConfig.roster) !== "clerk") return `eval plan: ${config.clerk} is not a clerk on the project's roster`;
  const prRepos = clerkSampleRepos(rules);
  if (prRepos.length === 0) return "eval plan: the project's clerk.prRepos is empty, so no PR can be read";
  const outside = (config.sample.repos ?? []).filter((repo) => !prRepos.includes(repo));
  if (outside.length > 0) return `eval plan: sample.repos names ${outside.join(", ")}, which is not one of the project's clerk.prRepos (${prRepos.join(", ")})`;
  // Every repo the sample can draw from needs a checkout to clone the trials from.
  const missing = (config.sample.repos ?? prRepos).filter((repo) => config.sources[repo] === undefined);
  if (missing.length > 0) return `eval plan: clerk ${config.clerk}'s tickets land in ${missing.join(", ")}; name a checkout of each on this host`;
  let keyed: boolean;
  try { keyed = keyedProjectTracker(project) !== null; }
  catch (error) { return `eval plan: cannot open the project's tracker: ${error instanceof Error ? error.message : String(error)}`; }
  // With no keyed tracker the sample reads the clerk's Jira, with a credential only this process's environment can carry.
  if (!keyed && parseJiraToken(env[JIRA_TOKEN_ENV]) === null) {
    return `eval plan: clerk ${config.clerk}'s tickets are read from its Jira, and the dashboard has no usable ${JIRA_TOKEN_ENV} ('<email>:<API token>'); start it from a config file where the token is set`;
  }
  return null;
}

/** The repos a clerk's sample draws from: the clerk block's `prRepos`, else the default apps. */
function clerkSampleRepos(rules: NonNullable<ReturnType<typeof clerkRules>>): readonly string[] {
  return rules.prRepos ?? [];
}

/**
 * Every refusal a start makes before it launches, without launching: the
 * inbox (#872) stores a plan only when this passes, so it holds no entry its
 * Start would refuse for the plan's own sake.
 */
export function checkStart(project: string, given: unknown, options: { env?: NodeJS.ProcessEnv; readSet?: SetReader } = {}): { plan: Record<string, unknown>; config: BacktestConfig } {
  const completed = completePlan(project, given, { readSet: options.readSet });
  const problem = clerkStartProblem(project, completed.config, options.env);
  if (problem !== null) throw new Error(problem);
  for (const arm of configArms(completed.config)) {
    if (arm.lineup !== "live" && !existsSync(lineupPath(arm.lineup))) throw new Error(`eval plan: arm ${arm.name} names lineup ${arm.lineup}, which ~/.ralph/lineups does not have`);
  }
  return completed;
}

/** Start a run of the plan the page built; the run directory is the plan's own, so the same plan resumes. */
export function startRun(project: string, given: unknown, options: { launcher?: Launcher; bun?: string; env?: NodeJS.ProcessEnv; readSet?: SetReader } = {}): { id: string; dir: string } {
  const { plan, config } = checkStart(project, given, options);
  const dir = backtestRunDir(config);
  if (existsSync(join(dir, PID_FILE)) && alive(dir)) throw new Error(`eval: ${basename(dir)} is already running`);
  mkdirSync(dir, { recursive: true });
  const planPath = join(dir, PLAN_FILE);
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  const unit = `ralph-eval-${createHash("sha256").update(dir).digest("hex").slice(0, 10)}`;
  const pid = (options.launcher ?? launch)({
    command: options.bun ?? process.execPath,
    argv: [join(HERE, "experiments.ts"), "eval", planPath, "--run-dir", dir],
    cwd: project, log: join(dir, LOG_FILE), unit,
  });
  writeFileSync(join(dir, PID_FILE), `${pid}\n`);
  return { id: basename(dir), dir };
}

/** Stop a run as Ctrl-C does: its current trial is killed and the state stays resumable. */
export function stopRun(project: string, id: string): { stopped: boolean; why: string | null } {
  if (segment(id) !== id) throw new Error(`eval: ${id} is not a run`);
  const dir = join(experimentsRoot(project), id);
  if (!existsSync(join(dir, PID_FILE)) || !alive(dir)) return { stopped: false, why: "the run is not running" };
  const pid = Number(readFileSync(join(dir, PID_FILE), "utf8").trim());
  process.kill(pid, "SIGINT");
  return { stopped: true, why: null };
}

/** A trial's patch, for the page's local diff view; null when it has none. */
export function readPatch(project: string, id: string, ticket: string, arm: string): string | null {
  for (const part of [id, ticket, arm]) if (segment(part) !== part) throw new Error(`eval: ${part} is not a path segment`);
  const dir = join(experimentsRoot(project), id, segment(ticket), arm);
  for (const name of ["patch.diff", "partial.patch"]) {
    const path = join(dir, name);
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return null;
}

export interface RelayedPatch { run: string; case: string; arm: string; text: string; truncated: boolean }

export interface RelayedPatches {
  version: 1;
  enabled: boolean;
  /**
   * One entry per trial, newest run first, named by the segments `readPatch`
   * takes. A list, not a record keyed `<run>/<case>/<arm>`: the remote
   * scrubber blanks strings under keys that look like credentials, and an
   * arm named e.g. `lean-tokens` would have its patch silently scrubbed.
   */
  patches: RelayedPatch[];
  /** Trials with a patch left out because the total budget was spent. */
  omitted: number;
}

/**
 * Sized so the relayed snapshot stays under the hosted store's 1 MiB gzip
 * key limit. One generated-file patch must not crowd out every other trial,
 * and the total is not sized on how well diffs usually compress: a binary
 * hunk from `git diff --binary` hardly compresses, and JSON escaping grows
 * the text. 768 KiB of near-incompressible text, plus the escaping a typical
 * patch carries, still gzips under 1 MiB; only a patch made mostly of
 * escape-heavy characters (control bytes, quotes, backslashes) could push it
 * past the limit.
 */
export const RELAY_PATCH_BYTES = 256 * 1024;
export const RELAY_TOTAL_BYTES = 768 * 1024;

/**
 * At most `limit` bytes of the file, cut back to its last whole line when it
 * is longer. One descriptor, one read of `limit + 1` bytes: a stat before the
 * read would race a finishing trial's atomic rename of patch.diff, and read
 * the whole new file uncapped.
 */
function readCapped(path: string, limit: number): { text: string; truncated: boolean } {
  const buffer = Buffer.alloc(limit + 1);
  const fd = openSync(path, "r");
  let read = 0;
  try {
    // readSync may return short of what the file holds, so read until full or EOF.
    while (read < buffer.length) {
      const got = readSync(fd, buffer, read, buffer.length - read, read);
      if (got === 0) break;
      read += got;
    }
  } finally { closeSync(fd); }
  if (read <= limit) return { text: buffer.subarray(0, read).toString("utf8"), truncated: false };
  // A cut mid-line would show the page a hunk line that never existed; but a
  // first line longer than the cap would leave nothing, so then cut it hard.
  const lastNewline = buffer.subarray(0, limit).lastIndexOf(0x0a);
  const end = lastNewline === -1 ? limit : lastNewline + 1;
  return { text: buffer.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * Every trial's patch, newest run first, for the bridge to push to the
 * hosted store (#825). Off unless the project set `relayEvalPatches`, and
 * then no patch file is read at all: a trial's patch is the project's code.
 */
export function relayedPatches(project: string, budget: { perPatch?: number; total?: number } = {}): RelayedPatches {
  if (!relaysPatches(project)) return { version: 1, enabled: false, patches: [], omitted: 0 };
  const perPatch = budget.perPatch ?? RELAY_PATCH_BYTES;
  const total = budget.total ?? RELAY_TOTAL_BYTES;
  const root = experimentsRoot(project);
  const patches: RelayedPatch[] = [];
  let spent = 0;
  let omitted = 0;
  for (const run of runsNewestFirst(project).runs) {
    const runDir = join(root, run.dir);
    for (const ticket of subdirs(runDir)) {
      if (segment(ticket) !== ticket) continue;
      const arms = subdirs(join(runDir, ticket));
      for (const arm of arms) {
        if (segment(arm) !== arm) continue;
        // A repeat trial (`<arm>-r<n>`, backtest-run.ts) is never linked by
        // the page, so relaying it would only spend the budget that older
        // runs' first trials could use.
        const repeat = /^(.+)-r\d+$/.exec(arm);
        if (repeat !== null && arms.includes(repeat[1]!)) continue;
        // The same choice readPatch makes: the finished patch, else the partial one.
        const path = ["patch.diff", "partial.patch"].map((name) => join(runDir, ticket, arm, name)).find((candidate) => existsSync(candidate));
        if (path === undefined) continue;
        // Once the budget is spent the rest are only counted, so what is
        // relayed is the newest trials, whole runs before older ones.
        if (omitted > 0) { omitted++; continue; }
        let patch: { text: string; truncated: boolean };
        try { patch = readCapped(path, perPatch); } catch { continue; }
        const bytes = Buffer.byteLength(patch.text, "utf8");
        if (spent + bytes > total) { omitted++; continue; }
        spent += bytes;
        patches.push({ run: run.dir, case: ticket, arm, ...patch });
      }
    }
  }
  return { version: 1, enabled: true, patches, omitted };
}
