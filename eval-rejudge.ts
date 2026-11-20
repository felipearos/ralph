/**
 * A prompt proposal's re-judge (#878): the run the improver read, scored
 * again on its calibrated cases under the current and the proposed judge or
 * analyst instructions, each in a scratch copy of the run directory so the
 * source run is never touched.
 *
 * The copy hard-links only the arms' `*.bundle` files: scoring reads them with
 * `git fetch` and never writes them. Every other file is copied, because a
 * rescore writes some in place rather than through `writeAtomic`'s rename
 * (`analyst.log` and the judges' logs are truncated and appended), and a write
 * through a hard link would reach the source run.
 */
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BacktestConfig, BacktestSample } from "./backtest";
import type { BacktestReport } from "./backtest-report";
import type { ScoreDeps, TicketScore } from "./backtest-score";
import { rescoreBacktest } from "./backtest-trial";
import { spawnGh } from "./clerk/pulls";
import type { PromptKind } from "./eval-evaluation-proposals";
import type { StoredProposal } from "./eval-proposals";
import { experimentsRoot } from "./eval-runs";
import { runLocalReview } from "./local-review";

export interface RejudgeInput {
  project: string;
  proposal: StoredProposal;
  /** The run the proposal was read from: the one re-judged. */
  runId: string;
  /** The calibrated case ids: the only cases scored. */
  cases: string[];
  instructions: { current: string; proposed: string };
  kind: PromptKind;
}

export interface RejudgeResult { current: TicketScore[]; proposed: TicketScore[] }

export type Rescore = (config: BacktestConfig, options: {
  runDir: string;
  signal: AbortSignal;
  log: (line: string) => void;
  scoreDeps?: Omit<ScoreDeps, "log">;
}) => Promise<{ report: BacktestReport; runDir: string }>;

export interface RejudgeDeps {
  rescore: Rescore;
  signal: AbortSignal;
  log: (line: string) => void;
  /** The scoring's own dependencies; the instructions are set per side. */
  scoreDeps: Omit<ScoreDeps, "log" | "instructions">;
  /** Where the scratch copies go; tmpdir when absent. */
  scratchParent?: string;
}

// A live run's process files and the run's own proposals: nothing a rescore reads.
const SKIPPED_AT_TOP = new Set(["eval.pid", "eval.log", "proposals"]);

/** Copies `from` into `to`, hard-linking the read-only bundles (a copy when the link fails, e.g. across filesystems). */
function scratchCopy(from: string, to: string, top = true): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (top && SKIPPED_AT_TOP.has(entry.name)) continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) scratchCopy(source, target, false);
    else if (!entry.isFile()) continue;
    else if (entry.name.endsWith(".bundle")) {
      try { linkSync(source, target); } catch { copyFileSync(source, target); }
    } else copyFileSync(source, target);
  }
}

/**
 * The copy's sample and report cut down to the calibrated cases, so the
 * rescore judges only those. Written plainly: the copy is ours alone.
 */
function restrict(runDir: string, cases: ReadonlySet<string>): BacktestConfig {
  const statePath = join(runDir, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { config: BacktestConfig; sample: BacktestSample } & Record<string, unknown>;
  state.sample = { ...state.sample, tickets: state.sample.tickets.filter((ticket) => cases.has(ticket.oaKey)) };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const reportPath = join(runDir, "report.json");
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as BacktestReport;
  const kept: BacktestReport = {
    ...report,
    rows: report.rows.filter((row) => cases.has(row.ticket)),
    ...(report.scores === undefined ? {} : { scores: report.scores.filter((score) => cases.has(score.ticket)) }),
    ...(report.repeatScores === undefined ? {} : { repeatScores: report.repeatScores.filter((score) => cases.has(score.ticket)) }),
  };
  writeFileSync(reportPath, `${JSON.stringify(kept, null, 2)}\n`);
  return state.config;
}

/** Re-judges the proposal's run under both instructions; the scratch copies are removed whatever happens. */
export async function rejudgeProposal(input: RejudgeInput, deps: RejudgeDeps): Promise<RejudgeResult> {
  const source = join(experimentsRoot(input.project), input.runId);
  const cases = new Set(input.cases);
  const scratch = mkdtempSync(join(deps.scratchParent ?? tmpdir(), `eval-rejudge-${input.proposal.id}-`));
  try {
    const side = async (name: "current" | "proposed"): Promise<TicketScore[]> => {
      const runDir = join(scratch, name);
      scratchCopy(source, runDir);
      const config = restrict(runDir, cases);
      const text = input.instructions[name];
      const instructions = input.kind === "judge-prompt" ? { judge: text } : { analyst: text };
      deps.log(`rejudge ${input.proposal.id}: ${name} instructions on ${cases.size} calibrated case(s)`);
      const { report } = await deps.rescore(config, { runDir, signal: deps.signal, log: deps.log, scoreDeps: { ...deps.scoreDeps, instructions } });
      // Filtered again: a report the rescore kept as it was (stopped) still holds only these, but nothing else may count.
      return (report.scores ?? []).filter((score) => cases.has(score.ticket));
    };
    // One after the other: each side is a full judge panel per case, and the host is shared with the loops.
    const current = await side("current");
    if (deps.signal.aborted) throw new Error("the re-judge was stopped");
    const proposed = await side("proposed");
    if (deps.signal.aborted) throw new Error("the re-judge was stopped");
    return { current, proposed };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The real re-judge: rescoreBacktest, stopped by Ctrl-C or SIGTERM. */
export async function realRejudge(input: RejudgeInput): Promise<RejudgeResult> {
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    return await rejudgeProposal(input, { rescore: rescoreBacktest, scoreDeps: { review: runLocalReview, gh: spawnGh }, signal: controller.signal, log: (line) => console.error(`evals-proposals: ${line}`) });
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
