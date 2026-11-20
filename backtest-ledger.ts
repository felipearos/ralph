#!/usr/bin/env bun
/**
 * The permanent record of the human-ticket backtests, and the nightly run that
 * feeds it (#525).
 *
 * A run's report lives in the clerk checkout's `.ralph/logs`, which is neither
 * kept nor comparable across runs. So each finished ticket becomes one line of
 * `backtests/<project>/ledger.jsonl` on this repository's `main`, with
 * `RESULTS.md` rendered beside it. Both go through the journal's lock and
 * worktree, so they cannot collide with a loop's publish.
 *
 * The ledger is also what makes a nightly run affordable: a recorded ticket,
 * and any other ticket naming a recorded PR, is never sampled again. A ticket
 * whose trial did not run is left out, so the next run retries it. An unreadable
 * ledger stops the run rather than reading as empty, which would pay for every
 * ticket again.
 *
 *   bun backtest-ledger.ts nightly <config.json>
 *   bun backtest-ledger.ts record <run-dir> --project-id <id>
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { armList, backtestDeps, buildBacktestSample, parseBacktest, type BacktestConfig, type BacktestSample, type BacktestTicket } from "./backtest";
import { GRADES_INTRO, graderLabel, judgeAccuracyLines, objectiveCell, PASSING, type BacktestReport, type TrialRow } from "./backtest-report";
import type { ArmScore, ReviewScore } from "./backtest-score";
import { runBacktestCommand } from "./backtest-trial";
import { gradeRun, round2, type CaseArmGrade, type GraderType } from "./eval-grade";
import { tallyChecks, type CalibrationCheck, type CalibrationOutcome } from "./eval-judge-accuracy";
import { AXES, contestedRuleLabel, type Axis, type ContestedRule, type PanelResult } from "./eval-panel";
import { RALPH_HOME } from "./paths";
import { projectIdFor } from "./project-id";
import { defaultGit, DEFAULT_MAX_ATTEMPTS, ensureWorktree, LOCK_TIMEOUT_STATUS, type GitRunner } from "./publish-journal";
import { buildRedactor } from "./runner-failure";

export const RESULTS_DIR = "backtests";
/** Where a nightly run keeps its artifacts, per day, so a restart the same day resumes it. */
const NIGHTLY_PREFIX = "nightly-";

type Counts = { P1: number; P2: number; P3: number } | null;

export interface LedgerAgent {
  arm: string;
  lineup: string;
  outcome: string;
  /** The trial's claim to its hand-off: the clock the live loops' speed ledger keeps. */
  handoffSeconds: number | null;
  wallSeconds: number;
  costUsd: number | null;
  reviewRounds: number | null;
  gates: string;
  review: Counts;
  heldOut: string;
  /** The arm's objective result on a test-set case (#855); null where no objective grader decides it. Absent before #855 and off a set run. */
  objective?: "pass" | "fail" | "pending" | null;
  /** The panel's mean 1–5 for the arm on this case, to 2 decimals; never combined with `objective`. Absent before #855 and off a set run. */
  judge?: number | null;
}

export interface LedgerEntry {
  v: 1;
  run: string;
  recordedAt: string;
  ticket: string;
  intakeKey: string | null;
  repo: string;
  title: string;
  prs: { number: number; url: string }[];
  human: { openToMergeSeconds: number | null; rounds: number | null; gates: string; review: Counts };
  agents: LedgerAgent[];
  judge: { winners: string[]; tie: boolean; reason: string } | null;
  /** The judge panel's verdicts (#801), scores only. Absent on a line written before #824. */
  panel?: LedgerPanel | null;
  /** How a test-set case is graded (#855). Absent on a line written before #855 and off a set run. */
  grade?: { grader: GraderType; noEvidence: boolean };
  /**
   * The operator's calibration verdicts on this case as the run checked them
   * (#877): the ledger is write-once, so this is the snapshot it was recorded
   * against. Absent on a line written before #877 and off a set run.
   */
  calibration?: LedgerCalibration[];
}

export type LedgerCalibration = { axis: Axis; arms: [string, string]; preferred: string; panel: string; outcome: CalibrationOutcome };

type LedgerJudge = { name: string; runner: string; model: string };
export interface LedgerPanel {
  verdicts: (
    | { judge: LedgerJudge; status: "ok"; arms: Record<string, Record<Axis, number | null>> }
    | { judge: LedgerJudge; status: "unavailable"; reason: string }
  )[];
  /** One arm under the spread rule, two under inversion (#818). */
  contested: { axis: Axis; arms: string[]; judges: string[] }[];
  /** The rule `contested` was found by; absent in lines written before #818, which read as inversion. */
  rule?: ContestedRule;
}

/** The panel without its evidence: the ledger is one line per ticket, the run dir keeps the prose. */
function ledgerPanel(panel: PanelResult | null | undefined): LedgerPanel | null {
  if (!panel || panel.verdicts.length === 0) return null;
  return {
    verdicts: panel.verdicts.map((verdict) => {
      const judge = { name: verdict.judge.name, runner: verdict.judge.runner, model: verdict.judge.model };
      if (verdict.status !== "ok") return { judge, status: "unavailable" as const, reason: verdict.reason };
      const arms = Object.fromEntries(Object.entries(verdict.arms).map(([id, scored]) =>
        [id, Object.fromEntries(AXES.map((axis) => [axis, scored.axes[axis]?.score ?? null])) as Record<Axis, number | null>]));
      return { judge, status: "ok" as const, arms };
    }),
    contested: panel.contested.map((entry) => ({ axis: entry.axis, arms: [...entry.arms], judges: [...entry.judges] })),
    ...(panel.rule ? { rule: panel.rule } : {}),
  };
}

const gateLine = (gates: { conclusion: string }[] | null | undefined): string =>
  gates ? `${gates.filter((gate) => PASSING.has(gate.conclusion)).length}/${gates.length}` : "—";
const finalReview = (arm: ArmScore | undefined): Counts => {
  const review: ReviewScore | undefined = arm?.review?.final;
  return review?.status === "ok" ? review.counts : null;
};
function heldOutLine(arm: ArmScore | undefined): string {
  const held = arm?.heldOut;
  if (!held) return "—";
  if (held.status !== "ok") return "n/a";
  return `${held.files.filter((file) => file.result === "pass").length}/${held.files.length}`;
}

/** An arm's two grades on a case, kept as two fields: the ledger never stores a number made of both. */
function agentGrade(grade: CaseArmGrade | undefined): Pick<LedgerAgent, "objective" | "judge"> {
  return { objective: grade?.objective ?? null, judge: grade?.judge == null ? null : round2(grade.judge) };
}

/** One entry per scored ticket with at least one trial that ran. */
export function ledgerEntries(report: BacktestReport, tickets: readonly BacktestTicket[]): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  const grades = gradeRun(report, armList(report.arms).map((arm) => arm.name));
  const accuracy = report.judgeAccuracy;
  for (const score of report.scores ?? []) {
    const ticket = tickets.find((candidate) => candidate.oaKey === score.ticket);
    // A case's first trials: repeats (#801) are a run's own evidence, not its verdict.
    const rows = report.rows.filter((row: TrialRow) => row.ticket === score.ticket && row.outcome !== "not-run" && row.repeat === undefined);
    if (ticket === undefined || rows.length === 0) continue;
    const arm = (name: string) => score.arms.find((candidate) => candidate.arm === name);
    const human = arm("a");
    const graded = grades?.cases.find((entry) => entry.case === score.ticket);
    entries.push({
      v: 1, run: report.id, recordedAt: report.finishedAt ?? score.scoredAt,
      ticket: score.ticket, intakeKey: ticket.intakeKey, repo: ticket.repo, title: ticket.frozen.title,
      prs: ticket.humanPrs.map((pr) => ({ number: pr.number, url: pr.url })),
      human: {
        openToMergeSeconds: human?.human?.openToMergeSeconds ?? null, rounds: human?.human?.rounds ?? null,
        gates: gateLine(human?.gates), review: finalReview(human),
      },
      agents: rows.map((row) => ({
        arm: row.arm, lineup: row.lineup, outcome: row.outcome, handoffSeconds: row.handoffSeconds ?? null, wallSeconds: row.wallSeconds,
        costUsd: row.cost.usd, reviewRounds: row.reviewRounds, gates: gateLine(arm(row.arm)?.gates ?? row.gates),
        review: finalReview(arm(row.arm)), heldOut: heldOutLine(arm(row.arm)),
        ...(graded === undefined ? {} : agentGrade(graded.arms.find((entry) => entry.arm === row.arm))),
      })),
      judge: score.judge?.status === "ok" ? { winners: score.judge.winners, tie: score.judge.tie, reason: score.judge.reason } : null,
      panel: ledgerPanel(score.panel),
      ...(graded === undefined ? {} : { grade: { grader: graded.grader, noEvidence: graded.noEvidence } }),
      ...(accuracy === undefined ? {} : {
        calibration: accuracy.checks.filter((check) => check.case === score.ticket)
          .map((check) => ({ axis: check.axis, arms: [check.arms[0], check.arms[1]] as [string, string], preferred: check.preferred, panel: check.panel, outcome: check.outcome })),
      }),
    });
  }
  return entries;
}

/** A line that does not parse is an error: reading it as absent would pay for that ticket again. */
export function parseLedger(text: string): LedgerEntry[] {
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as LedgerEntry);
}

/** The first verdict on a ticket stands: a later run is a different run, not a correction. */
export function mergeLedger(existing: readonly LedgerEntry[], incoming: readonly LedgerEntry[]): LedgerEntry[] {
  const seen = new Set(existing.map((entry) => entry.ticket));
  const merged = [...existing];
  for (const entry of incoming) {
    if (seen.has(entry.ticket)) continue;
    seen.add(entry.ticket);
    merged.push(entry);
  }
  return merged;
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const duration = (seconds: number | null): string => {
  if (seconds === null) return "—";
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};
const counts = (review: Counts): string => (review ? `P1 ${review.P1} · P2 ${review.P2} · P3 ${review.P3}` : "unreviewed");
const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

export function renderResults(project: string, entries: readonly LedgerEntry[]): string {
  const agents = entries.flatMap((entry) => entry.agents);
  const judged = entries.filter((entry) => entry.judge !== null);
  const tied = judged.filter((entry) => entry.judge!.tie).length;
  const human = judged.filter((entry) => !entry.judge!.tie && entry.judge!.winners.includes("a")).length;
  const usd = agents.flatMap((agent) => (agent.costUsd === null ? [] : [agent.costUsd]));
  const lines = [
    `# Backtest results: ${project}`,
    "",
    "Generated by `backtest-ledger.ts` from `ledger.jsonl`; do not edit by hand.",
    "Each row is a person ticket replayed by a sandboxed coder iteration from the human PR's merge base, then scored against the human's merged PR. Nothing in a trial reaches GitHub, Jira or Slack.",
    "",
    "## So far",
    "",
    `- Tickets: ${entries.length}. Judge, blind: agent ${judged.length - human - tied}, human ${human}, tie ${tied}, not judged ${entries.length - judged.length}.`,
    `- Agent reached a green PR: ${agents.filter((agent) => agent.outcome === "green-pr").length}/${agents.length} trials.`,
    `- Median claim to hand-off: ${duration(median(agents.flatMap((agent) => (agent.handoffSeconds === null ? [] : [agent.handoffSeconds]))))}. Median human open to merge: ${duration(median(entries.flatMap((entry) => (entry.human.openToMergeSeconds === null ? [] : [entry.human.openToMergeSeconds]))))}. These are different clocks: a human's PR opens after the work and waits on people.`,
    `- Trial cost: $${usd.reduce((sum, value) => sum + value, 0).toFixed(2)}${usd.length < agents.length ? ` (${agents.length - usd.length} unknown)` : ""}.`,
    "",
    "A small sample shows direction, not significance. A green PR means the checks passed, not that the whole ticket is done: read the judge's reason. Held-out tests are the human's own, so they fail on anything the agent named or scoped differently.",
    "",
    "## Tickets",
    "",
    "| Ticket | Repo | Judge | Agent | Checks | Hand-off | Rounds | Review | Held-out | Cost | Human checks | Human open to merge | Human review |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const entry of [...entries].reverse()) {
    const verdict = entry.judge === null ? "not judged" : entry.judge.tie ? "tie" : entry.judge.winners.includes("a") ? "human" : `agent (${entry.judge.winners.join(", ")})`;
    for (const agent of entry.agents) {
      lines.push(`| ${entry.ticket} | ${entry.repo.split("/").pop()} | ${verdict} | ${agent.arm} (${agent.lineup}): ${agent.outcome} | ${agent.gates} | ${duration(agent.handoffSeconds)} | ${agent.reviewRounds ?? "—"} | ${counts(agent.review)} | ${agent.heldOut} | ${agent.costUsd === null ? "unknown" : `$${agent.costUsd.toFixed(2)}`} | ${entry.human.gates} | ${duration(entry.human.openToMergeSeconds)} | ${counts(entry.human.review)} |`);
    }
  }
  lines.push("", "## Why the judge chose", "");
  for (const entry of [...entries].reverse()) {
    const prs = entry.prs.map((pr) => `[#${pr.number}](${pr.url})`).join(", ");
    lines.push(`- **${entry.ticket}** ${cell(entry.title)} (human: ${prs}; run \`${entry.run}\`): ${entry.judge === null ? "not judged." : cell(entry.judge.reason)}`);
  }
  lines.push(...gradesSection(entries));
  lines.push(...panelSection(entries));
  lines.push(...accuracySection(entries));
  return `${lines.join("\n")}\n`;
}

/**
 * The test-set cases' objective and judge scores (#855), from the ledger's own
 * fields, in separate columns: nothing adds or averages one into the other.
 * Nothing at all when no entry is graded, so an older ledger renders as it did.
 */
function gradesSection(entries: readonly LedgerEntry[]): string[] {
  const graded = entries.filter((entry) => entry.grade !== undefined);
  if (graded.length === 0) return [];
  const totals = new Map<string, { passed: number; graded: number; pending: number; judged: number[] }>();
  for (const entry of graded) {
    for (const agent of entry.agents) {
      // Keyed by arm and lineup: entries come from many runs, and `b` in one is
      // not the same configuration as `b` in another.
      const key = `${agent.arm} (${agent.lineup})`;
      const total = totals.get(key) ?? { passed: 0, graded: 0, pending: 0, judged: [] };
      totals.set(key, total);
      if (agent.objective === "pass" || agent.objective === "fail") total.graded++;
      if (agent.objective === "pass") total.passed++;
      if (agent.objective === "pending") total.pending++;
      if (typeof agent.judge === "number") total.judged.push(agent.judge);
    }
  }
  const lines = [
    "",
    "## Objective and judge scores",
    "",
    GRADES_INTRO,
    "",
    "| Arm | Objective | Judge |",
    "| --- | --- | --- |",
  ];
  for (const [arm, total] of [...totals].sort(([a], [b]) => a.localeCompare(b))) {
    const objective = objectiveCell(total);
    const mean = total.judged.length === 0 ? null : total.judged.reduce((sum, value) => sum + value, 0) / total.judged.length;
    const judge = mean === null ? "—" : `${mean.toFixed(2)} over ${total.judged.length} case${total.judged.length === 1 ? "" : "s"}`;
    lines.push(`| ${cell(arm)} | ${objective} | ${judge} |`);
  }
  lines.push("");
  for (const entry of [...graded].reverse()) lines.push(`- **${cell(entry.ticket)}**: ${graderLabel(entry.grade!)}`);
  return lines;
}

/** The panel's scores per ticket; nothing at all when no entry has an ok verdict, so a pre-panel ledger renders as it always did. */
function panelSection(entries: readonly LedgerEntry[]): string[] {
  const paneled = [...entries].reverse().filter((entry) => entry.panel?.verdicts.some((verdict) => verdict.status === "ok"));
  if (paneled.length === 0) return [];
  const lines = ["", "## Panel", "", "Each judge scores each arm 1–5 per axis; — where the axis does not apply. ⚑ marks an axis the judge families disagree on."];
  for (const entry of paneled) {
    const panel = entry.panel!;
    lines.push("", `### ${cell(entry.ticket)}`, "", `| Arm | Judge | ${AXES.join(" | ")} |`, `| --- | --- | ${AXES.map(() => "---").join(" | ")} |`);
    const ok = panel.verdicts.flatMap((verdict) => (verdict.status === "ok" ? [verdict] : []));
    const arms = [...new Set(ok.flatMap((verdict) => Object.keys(verdict.arms)))].sort();
    for (const arm of arms) {
      for (const verdict of ok) {
        const scores = verdict.arms[arm];
        if (scores === undefined) continue;
        const axes = AXES.map((axis) => {
          const flag = panel.contested.some((contest) => contest.axis === axis && contest.arms.includes(arm)) ? " ⚑" : "";
          return `${scores[axis] ?? "—"}${flag}`;
        });
        lines.push(`| ${armLabel(arm)} | ${cell(`${verdict.judge.name} (${verdict.judge.runner} ${verdict.judge.model})`)} | ${axes.join(" | ")} |`);
      }
    }
    const abstained = panel.verdicts.flatMap((verdict) => (verdict.status === "unavailable" ? [verdict] : []));
    if (abstained.length > 0) lines.push("", ...abstained.map((verdict) => `- ${cell(verdict.judge.name)} abstained: ${cell(verdict.reason)}`));
    if (panel.contested.length > 0) {
      lines.push("", `Contested (⚑) by ${contestedRuleLabel(panel.rule ?? { kind: "inversion" })}, so read the diffs:`, "");
      lines.push(...panel.contested.map((contest) => `- ${contest.axis}: ${contest.arms.map(armLabel).join(" vs ")} (${contest.judges.map(cell).join(", ")})`));
    }
    if (entry.calibration !== undefined && entry.calibration.length > 0) lines.push("", calibrationNote(entry.calibration));
  }
  return lines;
}

/** One case's calibration verdicts, counted by outcome: "Calibration: 2 agree, 1 disagree, 1 contested". */
function calibrationNote(calibration: readonly LedgerCalibration[]): string {
  const outcomes: CalibrationOutcome[] = ["agree", "disagree", "contested"];
  const parts = outcomes.flatMap((outcome) => {
    const count = calibration.filter((check) => check.outcome === outcome).length;
    return count === 0 ? [] : [`${count} ${outcome}`];
  });
  return `Calibration: ${parts.join(", ")}`;
}

/**
 * How often the panel agreed with the operator over every recorded case
 * (#877), re-tallied from each entry's snapshot. Nothing at all when no entry
 * carries one, so a ledger written before #877 renders as it did.
 */
function accuracySection(entries: readonly LedgerEntry[]): string[] {
  const calibrated = entries.filter((entry) => entry.calibration !== undefined);
  if (calibrated.length === 0) return [];
  const checks: CalibrationCheck[] = calibrated.flatMap((entry) => entry.calibration!.map((check) => ({ ...check, case: entry.ticket })));
  return ["", "## Judge accuracy", "", ...judgeAccuracyLines(tallyChecks(checks))];
}

/** Arm `a` is the human's merged PR in every backtest. */
const armLabel = (arm: string): string => (arm === "a" ? "a (human)" : cell(arm));

const ledgerPath = (projectId: string) => `${RESULTS_DIR}/${projectId}/ledger.jsonl`;
const resultsPath = (projectId: string) => `${RESULTS_DIR}/${projectId}/RESULTS.md`;
const why = (result: { stderr: string; stdout: string; status: number }) => (result.stderr || result.stdout).trim() || `exit ${result.status}`;

/** The ledger on `origin/main`, fresh; a failed fetch throws, an absent file is an empty ledger. */
export function readRecorded(projectId: string, home: string = RALPH_HOME, git: GitRunner = defaultGit): LedgerEntry[] {
  const fetched = git(["-C", home, "fetch", "--quiet", "origin", "main"]);
  if (fetched.status !== 0) throw new Error(`cannot read the backtest ledger: git fetch failed: ${why(fetched)}`);
  const path = ledgerPath(projectId);
  if (git(["-C", home, "cat-file", "-e", `origin/main:${path}`]).status !== 0) return [];
  const shown = git(["-C", home, "show", `origin/main:${path}`]);
  if (shown.status !== 0) throw new Error(`cannot read ${path}: ${why(shown)}`);
  return parseLedger(shown.stdout);
}

/** Commit the merged ledger and its results to `origin/main`; a rejected push retries on the fresh tip. */
export function publishResults(options: {
  projectId: string; entries: readonly LedgerEntry[]; home: string; worktree: string; git?: GitRunner; maxAttempts?: number; beforePush?: (attempt: number) => void;
}): { added: number; sha: string | null } {
  const git = options.git ?? defaultGit;
  const wt = resolve(options.worktree);
  const must = (args: string[]): string => {
    const result = git(["-C", wt, ...args]);
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${why(result)}`);
    return result.stdout;
  };
  const ledger = ledgerPath(options.projectId);
  const results = resultsPath(options.projectId);
  ensureWorktree(options.home, wt, git);
  let rejection = "";
  for (let attempt = 1; attempt <= (options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS); attempt += 1) {
    must(["fetch", "--quiet", "origin", "main"]);
    must(["checkout", "--quiet", "--detach", "--force", "origin/main"]);
    git(["-C", wt, "clean", "-fdq", "--", `${RESULTS_DIR}/${options.projectId}`]);
    const existing = existsSync(join(wt, ledger)) ? parseLedger(readFileSync(join(wt, ledger), "utf8")) : [];
    const merged = mergeLedger(existing, options.entries);
    const added = merged.length - existing.length;
    if (added === 0) return { added: 0, sha: null };
    mkdirSync(dirname(join(wt, ledger)), { recursive: true });
    writeFileSync(join(wt, ledger), `${merged.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    writeFileSync(join(wt, results), renderResults(options.projectId, merged));
    must(["add", "--", ledger, results]);
    must(["commit", "--quiet", "-m", `chore(backtest): results ${options.projectId}, ${added} more ticket${added === 1 ? "" : "s"}`, "--", ledger, results]);
    options.beforePush?.(attempt);
    const pushed = git(["-C", wt, "push", "--quiet", "origin", "HEAD:main"]);
    if (pushed.status === 0) return { added, sha: must(["rev-parse", "HEAD"]).trim() };
    rejection = why(pushed);
  }
  throw new Error(`the results push was rejected every attempt; the run dir keeps them. Last: ${rejection}`);
}

/** A finished run's entries, from its report and the sample its state froze. */
export function runEntries(runDir: string): LedgerEntry[] {
  const report = JSON.parse(readFileSync(join(runDir, "report.json"), "utf8")) as BacktestReport;
  const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as { sample: BacktestSample };
  return ledgerEntries(report, state.sample.tickets);
}

/** Whether a run wrote its scored report: the report is first written before scoring, without them. */
function runFinished(runDir: string): boolean {
  try {
    const report = JSON.parse(readFileSync(join(runDir, "report.json"), "utf8")) as Partial<BacktestReport>;
    return typeof report.finishedAt === "string" && report.scores !== undefined;
  } catch {
    return false;
  }
}

/** The config as the run started: a resume refuses any other, and that night's `sample.recorded` is part of it. */
function withRecordedOf(config: BacktestConfig, runDir: string): BacktestConfig {
  const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as { config?: BacktestConfig };
  const recorded = state.config?.sample.recorded;
  return recorded === undefined ? config : { ...config, sample: { ...config.sample, recorded } };
}

export interface NightlyDeps {
  projectId: string;
  readRecorded: () => LedgerEntry[];
  /** Records a finished run on `main`; false when it could not. */
  record: (runDir: string) => boolean;
  sample: (config: BacktestConfig) => Promise<BacktestSample>;
  run: (config: BacktestConfig, runDir: string) => Promise<{ report: BacktestReport }>;
  /** Today, for the run dir's name. */
  day: () => string;
  log: (line: string) => void;
}

export const experimentsDir = (config: BacktestConfig): string => join(config.project, ".ralph", "logs", "experiments");

/** Run the tickets the ledger has not seen. Exit status: 0 done or nothing to do, 1 a stopped run or a failed record. */
export async function runNightly(config: BacktestConfig, deps: NightlyDeps): Promise<number> {
  const dir = experimentsDir(config);
  // An earlier run is on disk and paid for: finish and record it before sampling, or its tickets are sampled and paid for again.
  // A reboot mid-run leaves its trials done and its scoring not; the resume reruns only what is missing, in the same dir.
  let status = 0;
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter((entry) => entry.startsWith(NIGHTLY_PREFIX)).sort()) {
      const runDir = join(dir, name);
      if (!existsSync(join(runDir, "state.json"))) continue;
      if (!runFinished(runDir)) {
        deps.log(`finishing ${name}, which never finished scoring`);
        const { report } = await deps.run(withRecordedOf(config, runDir), runDir);
        // Spending on new tickets can wait until the old ones are in.
        if (report.finishedAt === null || report.scores === undefined) return 1;
      }
      if (!deps.record(runDir)) status = 1;
    }
  }
  const recorded = deps.readRecorded();
  const withRecorded: BacktestConfig = {
    ...config,
    sample: {
      ...config.sample,
      recorded: {
        tickets: recorded.map((entry) => entry.ticket),
        prs: recorded.flatMap((entry) => entry.prs.map((pr) => `${entry.repo}#${pr.number}`)),
      },
    },
  };
  const sample = await deps.sample(withRecorded);
  if (sample.tickets.length === 0) {
    deps.log(`nothing new: ${recorded.length} recorded, ${sample.skipped.length} waiting or skipped`);
    return status;
  }
  deps.log(`${sample.tickets.length} new: ${sample.tickets.map((ticket) => ticket.oaKey).join(", ")}`);
  const runDir = join(dir, `${NIGHTLY_PREFIX}${deps.day()}`);
  const { report } = await deps.run(withRecorded, runDir);
  if (report.finishedAt === null) return 1;
  return deps.record(runDir) ? status : 1;
}

const USAGE = "usage: backtest-ledger.ts nightly <config.json> | record <run-dir> --project-id <id>";

function main(argv: string[]): Promise<number> | number {
  const [command, target, flag, value] = argv;
  if (command === "record" && target && flag === "--project-id" && value) return record(target, value);
  if (command === "nightly" && target && argv.length === 2) return nightly(target);
  console.error(USAGE);
  return 64;
}

function record(runDir: string, projectId: string): number {
  // The journal's lock, around a re-exec of this script: the worktree is shared with every publisher on the host.
  if (process.env.RALPH_JOURNAL_LOCKED !== "1") {
    const lock = resolve(process.env.RALPH_JOURNAL_LOCK?.trim() || join(homedir(), ".ralph", "journal.lock"));
    mkdirSync(dirname(lock), { recursive: true });
    const child = spawnSync("flock", ["-w", "300", "-E", String(LOCK_TIMEOUT_STATUS), lock, process.execPath, fileURLToPath(import.meta.url), "record", runDir, "--project-id", projectId], {
      stdio: "inherit", env: { ...process.env, RALPH_JOURNAL_LOCKED: "1" },
    });
    if (child.status !== 0) console.error(`backtest: results not recorded (flock exit ${child.status ?? child.error?.message}); the next nightly run retries`);
    return child.status ?? 1;
  }
  const worktree = process.env.RALPH_JOURNAL_WORKTREE?.trim() || join(homedir(), ".ralph", "journal-wt");
  const result = publishResults({ projectId, entries: runEntries(runDir), home: RALPH_HOME, worktree });
  console.error(`backtest: ${result.added} ticket(s) recorded in ${resultsPath(projectId)}${result.sha ? ` (${result.sha.slice(0, 8)})` : ""}`);
  return 0;
}

async function nightly(file: string): Promise<number> {
  const config = parseBacktest(JSON.parse(readFileSync(file, "utf8")));
  const projectId = projectIdFor(config.project).id;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const log = (line: string) => console.error(`backtest: ${line}`);
  return runNightly(config, {
    projectId, log,
    readRecorded: () => readRecorded(projectId),
    record: (runDir) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), "record", runDir, "--project-id", projectId], { stdio: "inherit" }).status === 0,
    sample: async (withRecorded) => buildBacktestSample(withRecorded, await backtestDeps(withRecorded)),
    run: (withRecorded, runDir) => runBacktestCommand(withRecorded, { runDir, signal: controller.signal, log }),
    day: () => new Date().toISOString().slice(0, 10),
  });
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`backtest: ${buildRedactor()(String(error))}`);
    process.exitCode = 1;
  }
}
