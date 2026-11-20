/**
 * The backtest scoring engine (felipearos/ralph#534): every arm of every
 * backtest ticket scored the same way, from what the run left in `runDir`.
 *
 * It never runs or reruns a trial. Per ticket it clones the source into a
 * throwaway dir, fetches each agent arm's bundle into it, and reads the human
 * PRs' commits from the same clone, so the human arm and the agent arms are
 * held to one set of held-out tests, gates and reviews. Every step degrades to
 * a note: one ticket's broken tree or missing sha never costs the next ticket.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { armList, codexJudgeModel, judgeSpecs, type BacktestConfig, type BacktestPr, type BacktestTicket, type CheckSpec } from "./backtest";
import { judgeGate, recordBase, runGates, type BaseRed, type GateCheck } from "./base-red";
import { JUDGE_TIMEOUT_MS, type ArmId, type JudgeCall, type JudgeResult } from "./backtest-judge";
import { productionJudge, type JudgeFactory } from "./eval-judges";
import { readEvalInstructions } from "./eval-instructions";
import { judgePanel, type Candidate, type PanelResult } from "./eval-panel";
import { PASSING, type ArmName, type TrialRow } from "./backtest-report";
import { segment, writeAtomic, type BacktestState } from "./backtest-run";
import type { GhRunner } from "./clerk/pulls";
import { matchesGlob } from "./executor-guard/diff-guard";
import { runCommand } from "./experiments";
import { WORKFLOW_PATH, type Finding, type LocalReviewOptions, type LocalReviewResult } from "./local-review";
import { scrubbed, shQuote } from "./trial-sandbox";

export type ReviewScore =
  | { status: "ok"; head: string; counts: { P1: number; P2: number; P3: number }; findings: Finding[]; dir: string; screenshots: string[] }
  | { status: "unavailable"; head: string | null; reason: string };

export type HeldOut =
  | { status: "ok"; files: { path: string; baseline: "pass" | "fail"; result: "pass" | "fail" }[] }
  /** The human's tests did not apply on this arm's tree. */
  | { status: "not-applicable"; reason: string }
  /** The human PRs changed no test file, or there is nothing to run them on. */
  | { status: "none"; reason: string };

export interface ArmScore {
  arm: "a" | ArmName;
  heads: { first: string | null; final: string | null };
  /** Null for the human arm: its tests are the held-out set. */
  heldOut: HeldOut | null;
  /** The human arm's are run here; an agent arm's are its trial's, a failing gate the merge base also fails re-judged (#579). */
  gates: { name: string; conclusion: string; baseRed?: string[] }[] | null;
  /** Null when `scoring.review` is off. */
  review: { first: ReviewScore; final: ReviewScore } | null;
  /** The human arm only. */
  human: { openToMergeSeconds: number | null; rounds: number | null } | null;
  /** Why each degraded step degraded. */
  notes: string[];
  /** The case's operator check on the arm's final tree (#857); absent when the case has none. */
  check?: CheckOutcome;
}

/** An operator check's verdict on one tree (#857): a check that could not run is an error, never a fail. */
export type CheckOutcome = { result: "pass" | "fail" } | { result: "error"; why: string };

export interface TicketScore {
  ticket: string;
  scoredAt: string;
  baseline: { path: string; result: "pass" | "fail" }[];
  arms: ArmScore[];
  /** The panel's ranking, the single judge's shape; null when `scoring.judge` is off. Absent in a scores.json written before #535. */
  judge?: JudgeResult | null;
  /** Every judge's verdict, the axes and the contested ones (#801). Absent in a scores.json written before it. */
  panel?: PanelResult | null;
  /** The tests the ticket's merge base already fails, per gate (#579). Absent in a scores.json written before #579. */
  baseRed?: BaseRed | null;
  /** The repeat these arms' trials were, 1 to k (#821); absent on the case's first trials. */
  repeat?: number;
}

export interface ScoreDeps {
  /** Production: `runLocalReview`. */
  review: (opts: LocalReviewOptions) => Promise<LocalReviewResult>;
  gh: GhRunner;
  /** Bring PR `pr`'s commits into `clone`; the default fetches `refs/pull/<pr>/head` from the source's origin. */
  fetchHumanPr?: (clone: string, repo: string, pr: number) => void;
  env?: NodeJS.ProcessEnv;
  log: (line: string) => void;
  scratchParent?: string;
  /** Ctrl-C: the command in flight is killed and no further ticket is scored. */
  signal?: AbortSignal;
  /** Each panel judge's call (#801). Production: `productionJudge`, by the judge's family. */
  panelJudge?: JudgeFactory;
  /** The analyst's call after the panel (#801). Production: `claudeJudge`, a no-tool call. */
  analyst?: (opts: { model: string; cwd: string; logPath: string; timeoutMs: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal }) => JudgeCall;
  /** The default panel's Codex judge model (#817), resolved once per scoring pass; absent: the one models.json names. */
  codexModel?: string | null;
  /** The Claude-only judge call of #535, used for every judge when `panelJudge` is not given. */
  judge?: (opts: { model: string; cwd: string; logPath: string; timeoutMs: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal }) => JudgeCall;
  /** The judges' and the analyst's opening instructions (#878); each absent one is read from its harness file. */
  instructions?: { judge?: string; analyst?: string };
}


const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
/** Every git call's bound: a stalled fetch of a human PR must fail the step, not hang the scoring overnight. */
export const GIT_TIMEOUT_MS = 10 * 60_000;

type Git = { status: number | null; stdout: string; stderr: string };

/** git in the scoring clone. The scrubbed env keeps a hook's GIT_DIR from pointing it at the harness checkout. */
function git(cwd: string, args: string[], input?: string): Git {
  const result = spawnSync("git", args, { cwd, env: scrubbed(), encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024, timeout: GIT_TIMEOUT_MS });
  // A timed-out call has a null status (and an ETIMEDOUT error), so it reads as failed.
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "", stderr: (result.stderr || result.error?.message || "").trim() };
}

function hasCommit(clone: string, sha: string): boolean {
  return git(clone, ["cat-file", "-e", `${sha}^{commit}`]).status === 0;
}

/** The default `fetchHumanPr`: GitHub keeps a merged PR's head under `refs/pull/<n>/head` even after its branch is gone. */
function fetchPullFrom(source: string): (clone: string, repo: string, pr: number) => void {
  return (clone, _repo, pr) => {
    const url = git(source, ["config", "--get", "remote.origin.url"]).stdout.trim();
    if (url === "") throw new Error(`${source} has no remote.origin.url`);
    const fetched = git(clone, ["fetch", "--quiet", url, `refs/pull/${pr}/head:refs/human/${pr}`]);
    if (fetched.status !== 0) throw new Error(`git fetch refs/pull/${pr}/head: ${fetched.stderr}`);
  };
}

/** A held-out test file and the human head it is read from: the last PR whose own commits touched it. */
type HeldOutFile = { path: string; source: string };

/**
 * The test files the human PRs' own commits changed. First-parent, no merges:
 * a PR branch that merged main in carries other people's tests, which are not
 * this ticket's evidence; and each PR is read on its own, so an earlier PR's
 * tests are kept even when a later PR does not descend from it.
 */
function heldOutFiles(s: Scoring, ticket: BacktestTicket, notes: string[]): HeldOutFile[] {
  const sources = new Map<string, string>();
  for (const pr of ticket.humanPrs) {
    const first = pr.firstCommit || null;
    const head = pr.headRefOid || null;
    if (first === null || head === null) { notes.push(`held-out: #${pr.number} has no first commit or head in the sample`); continue; }
    if (!hasCommit(s.clone, first) || !hasCommit(s.clone, head)) { notes.push(`held-out: #${pr.number}'s commits are not in the scoring clone`); continue; }
    // A root first commit has no parent to exclude: the whole first-parent line up to the head is the PR's.
    const range = hasCommit(s.clone, `${first}^`) ? [`${first}^..${head}`] : [head];
    // No renames: a renamed test reads as delete + add, and the add is the file to run.
    const log = git(s.clone, ["-c", "core.quotePath=false", "log", "--first-parent", "--no-merges", "--no-renames", "--name-status", "--format=", ...range]);
    if (log.status !== 0) { notes.push(`held-out: git log for #${pr.number}: ${log.stderr}`); continue; }
    for (const line of log.stdout.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const path = line.slice(tab + 1);
      // The guard's glob dialect rather than Bun.Glob: the suite runs under node, where Bun is undefined.
      if (s.config.scoring.testGlobs.some((glob) => matchesGlob(glob, path))) sources.set(path, head);
    }
  }
  // A test the last PR to touch it deleted is nothing to run.
  return [...sources].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .filter(([path, source]) => git(s.clone, ["cat-file", "-e", `${source}:${path}`]).status === 0)
    .map(([path, source]) => ({ path, source }));
}

/** One ticket's scoring context: the clone, the bound every command gets, and where its logs go. */
interface Scoring {
  clone: string;
  scratch: string;
  logs: string;
  config: BacktestConfig;
  deps: ScoreDeps;
  timeoutMs: number;
  /** Names this ticket's worktrees and gate outputs apart. */
  worktrees: number;
  /** The judge's shuffle seed: `scoring.judge.seed`, else the run's id, so a rescore shows the judge the same order. */
  seed: string;
  /**
   * The source checkout's Revisión Claude workflow, when it has one: every arm
   * is reviewed by today's review, as the trials were, and a merge base older
   * than the workflow has none of its own.
   */
  workflowFile?: string;
}

/** A detached worktree at `sha`, removed with the clone. */
function worktree(s: Scoring, sha: string): string {
  const dir = join(s.scratch, `wt-${++s.worktrees}`);
  const added = git(s.clone, ["worktree", "add", "--quiet", "--detach", dir, sha]);
  if (added.status !== 0) throw new Error(`git worktree add ${sha}: ${added.stderr}`);
  return dir;
}

/** One shell command in its own process group, killed at the trial cap; null when stopped before it was spawned. */
async function shResult(s: Scoring, command: string, cwd: string, label: string): Promise<{ exit: number | null; timedOut: boolean } | null> {
  // Stopped: nothing new is spawned, and the ticket's score is thrown away anyway.
  if (s.deps.signal?.aborted) return null;
  const log = join(s.logs, `${segment(label)}.log`);
  return runCommand(["sh", "-c", command], cwd, scrubbed(), s.timeoutMs, log, s.deps.signal);
}

/** `shResult` as a pass: a timeout is a failure with a note. */
async function sh(s: Scoring, command: string, cwd: string, label: string, notes: string[]): Promise<boolean> {
  const result = await shResult(s, command, cwd, label);
  if (result === null) return false;
  if (result.timedOut) notes.push(`${label}: timed out after ${s.config.caps.trialMinutes} min`);
  return !result.timedOut && result.exit === 0;
}

/** `scoring.setup`, when set; a failed setup is noted and the tests still run, to fail on their own terms. */
async function setup(s: Scoring, cwd: string, label: string, notes: string[]): Promise<boolean> {
  if (s.config.scoring.setup === null) return true;
  if (await sh(s, s.config.scoring.setup, cwd, `${label}-setup`, notes)) return true;
  notes.push(`${label}: setup failed`);
  return false;
}

/** `scoring.testCommand` for one test file. */
const testCommandFor = (s: Scoring, file: string): string => s.config.scoring.testCommand.split("{file}").join(shQuote(file));

async function runTests(s: Scoring, cwd: string, files: string[], label: string, notes: string[]): Promise<Map<string, "pass" | "fail">> {
  const results = new Map<string, "pass" | "fail">();
  for (const file of files) {
    const command = testCommandFor(s, file);
    results.set(file, (await sh(s, command, cwd, `${label}-test-${file.replace(/[\\/]+/g, "__")}`, notes)) ? "pass" : "fail");
  }
  return results;
}

const checkError = (why: string): CheckOutcome => ({ result: "error", why });
/** A bound as a person reads it: whole minutes as minutes, anything shorter in seconds. */
const bound = (ms: number): string => (ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms / 1000} s`);

/**
 * A case's operator check (#857) on the tree at `dir`. A test spec's file is
 * overlaid from `reference`, as the held-out baseline overlays the human's
 * tests, so the base and every arm run the reference's copy. Anything that
 * keeps the check from giving a verdict (a missing file, a missing command, a
 * timeout, Ctrl-C) is an error, never a fail: it says nothing about the tree.
 */
async function runCheck(s: Scoring, dir: string, spec: CheckSpec, reference: string, label: string, notes: string[]): Promise<CheckOutcome> {
  let command: string;
  if ("test" in spec) {
    const short = reference.slice(0, 7);
    // A blob, not merely a path: a directory would overlay the reference's code as well as its tests.
    const type = git(s.clone, ["cat-file", "-t", `${reference}:${spec.test}`]);
    if (type.status !== 0) return checkError(`the test file ${spec.test} is not in the reference ${short}`);
    if (type.stdout.trim() !== "blob") return checkError(`${spec.test} is not a file in the reference ${short}`);
    const checkedOut = git(dir, ["checkout", reference, "--", spec.test]);
    if (checkedOut.status !== 0) return checkError(`git checkout ${short} -- ${spec.test}: ${checkedOut.stderr}`);
    command = testCommandFor(s, spec.test);
  } else command = spec.command;
  // Unlike the held-out tests, a failed setup is an error: a base that fails
  // only because it could not install would accept a check that tests nothing.
  if (!(await setup(s, dir, label, notes))) {
    return checkError(s.deps.signal?.aborted ? "stopped before the check finished" : "the setup failed, so the check says nothing about the tree");
  }
  const result = await shResult(s, command, dir, label);
  // runCommand reports a kill on abort as a timeout: Ctrl-C is checked first.
  if (result === null || s.deps.signal?.aborted) return checkError("stopped before the check finished");
  if (result.timedOut) return checkError(`timed out after ${bound(s.timeoutMs)}`);
  if (result.exit === 127) return checkError("command not found (exit 127)");
  if (result.exit === 126) return checkError("not executable (exit 126)");
  return { result: result.exit === 0 ? "pass" : "fail" };
}

/** `.ralph/config.json`'s gates at `sha`, or null with a note saying why. */
function gatesAt(s: Scoring, sha: string, notes: string[]): Record<string, string> | null {
  const shown = git(s.clone, ["show", `${sha}:.ralph/config.json`]);
  if (shown.status !== 0) { notes.push(`gates: no .ralph/config.json at ${sha}: ${shown.stderr}`); return null; }
  let raw: { gates?: unknown };
  try {
    raw = JSON.parse(shown.stdout) as { gates?: unknown };
  } catch (error) {
    notes.push(`gates: .ralph/config.json at ${sha} is not JSON: ${message(error)}`);
    return null;
  }
  const gates: Record<string, string> = {};
  if (raw.gates && typeof raw.gates === "object" && !Array.isArray(raw.gates)) {
    for (const [name, command] of Object.entries(raw.gates)) if (typeof command === "string") gates[name] = command;
  }
  if (Object.keys(gates).length === 0) { notes.push(`gates: the project config at ${sha} names none`); return null; }
  return gates;
}

/**
 * The gates every arm is judged by: the first agent arm's sandbox base's, else
 * the merge base's. Since #583 a trial takes its gates from the live checkout,
 * which the sandbox's config commit carries, so the merge base's (or none, for
 * a project whose config lives on another branch) may not be what the trials ran.
 */
function ticketGates(s: Scoring, base: string | null, rows: TrialRow[], notes: string[]): Record<string, string> | null {
  const sandbox = rows.map((row) => row.heads?.base ?? null).find((sha): sha is string => sha !== null && hasCommit(s.clone, sha));
  if (sandbox !== undefined) {
    const gates = gatesAt(s, sandbox, notes);
    if (gates !== null) {
      notes.push(`gates: taken from the sandbox base ${sandbox}, the config the trials ran with`);
      return gates;
    }
  }
  if (base === null) return null;
  const gates = gatesAt(s, base, notes);
  // With agent arms, the merge base's gates are a stand-in for the ones their trials ran.
  if (gates !== null && rows.length > 0) notes.push(`gates: taken from the merge base ${base}, no arm's sandbox base has a project config`);
  return gates;
}

/** Whether the arm's trial judged its checks against a base record itself (#579): its gates are already final. */
function trialHadBaseRecord(resultPath: string): boolean {
  try {
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as { baseRed?: unknown };
    return typeof result?.baseRed === "object" && result.baseRed !== null;
  } catch {
    return false;
  }
}

/** Gate output appended to `<label>.log`; a log that cannot be written costs the log, never the score. */
function gateLog(s: Scoring, label: string): (chunk: string) => void {
  const path = join(s.logs, `${segment(label)}.log`);
  return (chunk) => {
    try {
      mkdirSync(s.logs, { recursive: true });
      appendFileSync(path, chunk);
    } catch { /* the log is a convenience */ }
  };
}

/** A judged check as a score keeps it: the summary is for the trial's fake gh, not the scorecard. */
const stored = (check: GateCheck): { name: string; conclusion: string; baseRed?: string[] } =>
  check.baseRed ? { name: check.name, conclusion: check.conclusion, baseRed: check.baseRed } : { name: check.name, conclusion: check.conclusion };

/** The tests the merge base already fails per gate: what every arm's gate failures are judged against. */
async function baseRecord(s: Scoring, gates: Record<string, string> | null, base: string | null, notes: string[]): Promise<BaseRed | null> {
  if (gates === null || base === null) { notes.push("base-red: no gates or merge base to record; gates are judged by exit code"); return null; }
  if (s.deps.signal?.aborted) return null;
  try {
    const dir = worktree(s, base);
    await setup(s, dir, "base-gates", notes);
    if (s.deps.signal?.aborted) return null;
    return await recordBase(gates, dir, { env: scrubbed(), timeoutMs: s.timeoutMs, stderr: gateLog(s, "base-gates"), signal: s.deps.signal, base });
  } catch (error) {
    notes.push(`base-red: ${message(error)}; gates are judged by exit code`);
    return null;
  }
}

/** The ticket's gates run on the human's final head, judged against the merge base's red tests. */
async function humanGates(s: Scoring, gates: Record<string, string>, head: string, base: BaseRed | null, notes: string[]): Promise<ArmScore["gates"]> {
  const dir = worktree(s, head);
  await setup(s, dir, "a-gates", notes);
  if (s.deps.signal?.aborted) return null;
  const runs = await runGates(gates, dir, { env: scrubbed(), timeoutMs: s.timeoutMs, stderr: gateLog(s, "a-gates"), signal: s.deps.signal });
  return runs.map((run) => stored(judgeGate(run.name, run, base)));
}

/**
 * An agent arm's gates: its trial's, with each failing gate the merge base
 * also fails re-run on the arm's final head and re-judged against the base's
 * red tests. A row written before #579 judged by exit code alone; a trial
 * that judged against its own base record is final, a passing gate is never
 * re-run, and anything missing keeps the trial's verdict.
 */
async function armGates(s: Scoring, row: TrialRow, fetched: boolean, resultPath: string, gates: Record<string, string> | null,
  base: BaseRed | null, notes: string[]): Promise<ArmScore["gates"]> {
  if (row.gates === null) return null;
  const failing = row.gates.filter((gate) => !PASSING.has(gate.conclusion));
  if (failing.length === 0) return row.gates;
  if (trialHadBaseRecord(resultPath)) return row.gates;
  if (base === null || gates === null) { notes.push("gates: no base record to re-judge the failing gates against; the trial's are kept"); return row.gates; }
  const commands: Record<string, string> = {};
  for (const gate of failing) {
    if (base.gates[gate.name]?.conclusion !== "FAILURE") continue;
    const name = gate.name.startsWith("trial/") ? gate.name.slice("trial/".length) : gate.name;
    const command = gates[name];
    if (command === undefined) notes.push(`gates: no command for ${gate.name} to re-run; the trial's verdict is kept`);
    else commands[name] = command;
  }
  if (Object.keys(commands).length === 0) return row.gates;
  const final = row.heads?.final ?? null;
  if (!fetched) { notes.push("gates: no bundle to re-run the base-red gates on; the trial's are kept"); return row.gates; }
  if (final === null || !hasCommit(s.clone, final)) { notes.push("gates: no final head to re-run the base-red gates on; the trial's are kept"); return row.gates; }
  if (s.deps.signal?.aborted) return row.gates;
  try {
    const dir = worktree(s, final);
    await setup(s, dir, `${row.arm}-gates`, notes);
    if (s.deps.signal?.aborted) return row.gates;
    const runs = await runGates(commands, dir, { env: scrubbed(), timeoutMs: s.timeoutMs, stderr: gateLog(s, `${row.arm}-gates`), signal: s.deps.signal });
    const judged = new Map(runs.map((run) => [run.name, stored(judgeGate(run.name, run, base))]));
    return row.gates.map((gate) => judged.get(gate.name) ?? gate);
  } catch (error) {
    notes.push(`gates: re-running the base-red gates: ${message(error)}; the trial's are kept`);
    return row.gates;
  }
}

async function reviewOne(s: Scoring, runDir: string, dir: string, which: "first" | "final",
  base: string | null, head: string | null, repo: string): Promise<ReviewScore> {
  if (s.deps.signal?.aborted) return { status: "unavailable", head, reason: "scoring was stopped" };
  if (head === null) return { status: "unavailable", head: null, reason: `no ${which} head` };
  if (base === null) return { status: "unavailable", head, reason: "no base commit to review against" };
  if (!hasCommit(s.clone, head)) return { status: "unavailable", head, reason: `${head} is not in the scoring clone` };
  const out = join(runDir, dir, `review-${which}`);
  // A rescore replaces the review, so no screenshot from the previous one lingers beside it.
  rmSync(out, { recursive: true, force: true });
  try {
    const result = await s.deps.review({
      checkout: s.clone, base, head, repo, out, env: s.deps.env, log: s.deps.log,
      ...(s.workflowFile !== undefined ? { workflowFile: s.workflowFile } : {}),
    });
    if (result.status === "unavailable") return { status: "unavailable", head, reason: result.reason };
    const counts = { P1: 0, P2: 0, P3: 0 };
    for (const finding of result.findings) counts[finding.priority] += 1;
    const rel = (path: string) => relative(runDir, isAbsolute(path) ? path : join(out, path));
    return { status: "ok", head, counts, findings: result.findings, dir: relative(runDir, out), screenshots: result.screenshots.map(rel) };
  } catch (error) {
    return { status: "unavailable", head, reason: message(error) };
  }
}

/** First and final reviewed alike; the same head is reviewed once and the result read for both. */
async function reviews(s: Scoring, runDir: string, dir: string, base: string | null,
  heads: { first: string | null; final: string | null }, repo: string): Promise<ArmScore["review"]> {
  if (!s.config.scoring.review) return null;
  const first = await reviewOne(s, runDir, dir, "first", base, heads.first, repo);
  if (heads.first !== null && heads.first === heads.final) return { first, final: first };
  return { first, final: await reviewOne(s, runDir, dir, "final", base, heads.final, repo) };
}

/** Distinct reviewed heads, less the first, per PR: the human analogue of a trial's `reviewRounds`. */
async function humanRounds(gh: GhRunner, ticket: BacktestTicket, notes: string[]): Promise<number | null> {
  let rounds = 0;
  for (const pr of ticket.humanPrs) {
    try {
      // `--slurp` makes every page one array of arrays, which `.flat()` joins.
      const text = await gh(["api", `repos/${ticket.repo}/pulls/${pr.number}/reviews`, "--paginate", "--slurp"]);
      const pages = JSON.parse(text) as unknown;
      if (!Array.isArray(pages)) throw new Error("not a JSON array");
      const commits = new Set<string>();
      for (const review of pages.flat() as { state?: unknown; commit_id?: unknown }[]) {
        if (review && review.state !== "PENDING" && typeof review.commit_id === "string") commits.add(review.commit_id);
      }
      rounds += Math.max(0, commits.size - 1);
    } catch (error) {
      notes.push(`rounds: gh reviews for #${pr.number}: ${message(error)}`);
      return null;
    }
  }
  return rounds;
}

function openToMerge(ticket: BacktestTicket, notes: string[]): number | null {
  const created = ticket.humanPrs.map((pr) => Date.parse(pr.createdAt)).filter(Number.isFinite);
  const merged = ticket.humanPrs.map((pr) => Date.parse(pr.mergedAt)).filter(Number.isFinite);
  if (created.length === 0 || merged.length === 0) { notes.push("time: no human PR with createdAt and mergedAt"); return null; }
  return Math.round((Math.max(...merged) - Math.min(...created)) / 1000);
}

/**
 * A repeat's round (#821): which repeat, and the reference's score from the
 * case's first scoring. The merged PR is the same on every repeat, so its
 * gates, review and rounds are read from there rather than paid for again;
 * its diff is still a candidate, so the panel compares the same field.
 */
type Round = { repeat: number; reference: ArmScore | null };

/** Where an arm's trial kept its files: `<case>/<arm>` for the first trial, `<case>/<arm>-r<n>` for a repeat, as runBacktest names them. */
const armDir = (seg: string, arm: string, round?: Round): string => join(seg, round === undefined ? arm : `${arm}-r${round.repeat}`);

async function scoreTicket(runDir: string, ticket: BacktestTicket, rows: TrialRow[], s: Scoring, round?: Round, check?: CheckSpec): Promise<TicketScore> {
  const seg = segment(ticket.oaKey);
  const { config, deps } = s;
  const fetchHuman = deps.fetchHumanPr ?? fetchPullFrom(config.sources[ticket.repo]!);
  const human: ArmScore = { arm: "a", heads: { first: null, final: null }, heldOut: null, gates: null, review: null, human: null, notes: [] };
  const notes = human.notes;

  // The human shas: an old sample has neither field ("" in a sample written
  // before them), a PR's head may never have been fetched into the source.
  // humanPrs is in merge order, so the first head is the earliest-opened PR's.
  const opened = [...ticket.humanPrs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
  const first = opened?.firstCommit || null;
  const final = ticket.humanPrs.at(-1)?.headRefOid || null;
  if (first === null) notes.push("heads: the sample has no first human commit");
  if (final === null) notes.push("heads: the sample has no final human head");
  // Every PR's own commits are read for the held-out set, so all of them are brought in, not only first and final.
  const wanted = [first, final, ...ticket.humanPrs.flatMap((pr) => [pr.firstCommit || null, pr.headRefOid || null])];
  for (const sha of new Set(wanted.filter((sha): sha is string => sha !== null))) {
    if (hasCommit(s.clone, sha)) continue;
    for (const pr of ticket.humanPrs) {
      if (hasCommit(s.clone, sha)) break;
      try { fetchHuman(s.clone, ticket.repo, pr.number); } catch (error) { notes.push(`heads: fetching #${pr.number}: ${message(error)}`); }
    }
    if (!hasCommit(s.clone, sha)) notes.push(`heads: ${sha} is not in the source nor its PR refs`);
  }
  const present = (sha: string | null) => (sha !== null && hasCommit(s.clone, sha) ? sha : null);
  human.heads = { first: present(first), final: present(final) };
  const base = present(ticket.mergeBase);
  if (base === null) notes.push(`heads: merge base ${ticket.mergeBase} is not in the source`);

  // The arms' bundles first: a merge base with no project config takes its gates from an arm's sandbox base.
  const fetchedArms = new Map<ArmName, { fetched: boolean; notes: string[] }>();
  for (const row of rows) {
    const armNotes: string[] = [];
    if (!row.heads) armNotes.push("heads: the row predates #534 and keeps no heads");
    const bundle = join(runDir, armDir(seg, row.arm, round), "arm.bundle");
    let fetched = false;
    if (!existsSync(bundle)) armNotes.push("bundle: the trial kept no arm.bundle");
    else {
      const result = git(s.clone, ["fetch", "--quiet", bundle, `refs/*:refs/arms/${row.arm}/*`]);
      if (result.status === 0) fetched = true;
      else armNotes.push(`bundle: git fetch: ${result.stderr}`);
    }
    fetchedArms.set(row.arm, { fetched, notes: armNotes });
  }

  // The held-out set and its baseline: the human's tests on the tree the agents started from.
  let files: string[] = [];
  let heldOutReason: string | null = null;
  const baseline = new Map<string, "pass" | "fail">();
  let testPatch = "";
  if (base === null) heldOutReason = "no merge base to run the human's tests on";
  else {
    const listed = heldOutFiles(s, ticket, notes);
    if (listed.length === 0) heldOutReason = "the human PRs' own commits changed no file matching scoring.testGlobs";
    else {
      files = listed.map((file) => file.path);
      try {
        const dir = worktree(s, base);
        for (const { path, source } of listed) {
          const checkedOut = git(dir, ["checkout", source, "--", path]);
          if (checkedOut.status !== 0) throw new Error(`git checkout ${source} -- ${path}: ${checkedOut.stderr}`);
          const diff = git(s.clone, ["diff", "--binary", base, source, "--", path]);
          if (diff.status !== 0) throw new Error(`git diff ${base} ${source} -- ${path}: ${diff.stderr}`);
          testPatch += diff.stdout;
        }
        await setup(s, dir, "baseline", notes);
        for (const [path, result] of await runTests(s, dir, files, "baseline", notes)) baseline.set(path, result);
      } catch (error) {
        heldOutReason = `baseline: ${message(error)}`;
        notes.push(heldOutReason);
      }
    }
  }

  const gates = ticketGates(s, base, rows, notes);
  const baseRed = await baseRecord(s, gates, base, notes);
  if (round !== undefined) {
    // The reference never changes between repeats: its first scoring stands.
    if (round.reference === null) notes.push("reference: the case's first scoring is missing; its gates, review and rounds are left out of this repeat");
    human.gates = round.reference?.gates ?? null;
    human.review = round.reference?.review ?? null;
    human.human = round.reference?.human ?? null;
  } else {
    if (gates !== null && base !== null && human.heads.final !== null) {
      try { human.gates = await humanGates(s, gates, human.heads.final, baseRed, notes); } catch (error) { notes.push(`gates: ${message(error)}`); }
    } else if (gates !== null) notes.push("gates: no merge base or final human head to run them on");
    human.review = await reviews(s, runDir, join(seg, "a"), base, human.heads, ticket.repo);
    human.human = { openToMergeSeconds: openToMerge(ticket, notes), rounds: await humanRounds(deps.gh, ticket, notes) };
  }

  const arms: ArmScore[] = [human];
  // What the judge needs from each agent arm once every arm is scored.
  const agentTrees: { arm: ArmName; fetched: boolean; base: string | null; first: string | null; final: string | null }[] = [];
  for (const row of rows) {
    if (deps.signal?.aborted) break;
    const { fetched, notes: armNotes } = fetchedArms.get(row.arm)!;
    const heads = { first: row.heads?.first ?? null, final: row.heads?.final ?? null };
    agentTrees.push({ arm: row.arm, fetched, base: row.heads?.base ?? null, first: heads.first, final: heads.final });
    let heldOut: HeldOut;
    if (heldOutReason !== null) heldOut = { status: "none", reason: heldOutReason };
    else if (!fetched) heldOut = { status: "none", reason: "no bundle to read the arm's tree from" };
    else if (heads.final === null || !hasCommit(s.clone, heads.final)) heldOut = { status: "none", reason: "the arm has no final head" };
    else {
      try {
        const dir = worktree(s, heads.final);
        const applied = git(dir, ["apply"], testPatch);
        if (applied.status !== 0) heldOut = { status: "not-applicable", reason: applied.stderr };
        else {
          await setup(s, dir, row.arm, armNotes);
          const results = await runTests(s, dir, files, row.arm, armNotes);
          heldOut = { status: "ok", files: files.map((path) => ({ path, baseline: baseline.get(path) ?? "fail", result: results.get(path) ?? "fail" })) };
        }
      } catch (error) {
        heldOut = { status: "none", reason: message(error) };
      }
    }
    // The operator check (#857) grades the arm's final tree against the reference's copy of it.
    let checked: CheckOutcome | undefined;
    if (check !== undefined) {
      if (!fetched) checked = checkError("no bundle to read the arm's tree from");
      else if (heads.final === null || !hasCommit(s.clone, heads.final)) checked = checkError("the arm has no final head");
      else if (human.heads.final === null) checked = checkError("no final human head to read the check from");
      else {
        try { checked = await runCheck(s, worktree(s, heads.final), check, human.heads.final, `${row.arm}-check`, armNotes); } catch (error) { checked = checkError(message(error)); }
      }
    }
    arms.push({
      arm: row.arm,
      heads,
      heldOut,
      gates: await armGates(s, row, fetched, join(runDir, armDir(seg, row.arm, round), "result.json"), gates, baseRed, armNotes),
      // The sandbox base, not the merge base: the sandbox's own config commit is not the agent's work.
      review: await reviews(s, runDir, armDir(seg, row.arm, round), row.heads?.base ?? null, heads, ticket.repo),
      human: null,
      notes: armNotes,
      // No key at all without a check: a case without one scores byte for byte as before #857.
      ...(checked === undefined ? {} : { check: checked }),
    });
  }
  // Each repeat is shuffled by its own seed, so a judge's bias toward a position does not repeat with the trial.
  const seed = round === undefined ? s.seed : `${s.seed}/r${round.repeat}`;
  const panel = await judgeArms(s, seed, ticket, arms, [
    { arm: "a", diff: () => humanDiff(s, ticket, notes), why: "no human PR's own commits to diff" },
    ...agentTrees.map((tree) => ({
      arm: tree.arm,
      first: tree.first,
      base: tree.fetched && tree.base !== null && hasCommit(s.clone, tree.base) ? tree.base : null,
      final: tree.fetched && tree.final !== null && hasCommit(s.clone, tree.final) ? tree.final : null,
      why: tree.fetched ? "no sandbox base or final head in the bundle to diff" : "no bundle to read the arm's diff from",
    })),
  ]);
  return {
    ticket: ticket.oaKey, scoredAt: new Date().toISOString(),
    baseline: files.filter((path) => baseline.has(path)).map((path) => ({ path, result: baseline.get(path)! })),
    arms, judge: panel?.aggregate ?? null, panel, baseRed,
    ...(round === undefined ? {} : { repeat: round.repeat }),
  };
}

/** git's empty tree: what a PR whose first commit is a root commit is diffed from. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * The human arm's work as the judge sees it: each PR's own change, in merge
 * order, read the way heldOutFiles reads its tests. Not merge base to last
 * head: a follow-up PR opened from a later main would carry everyone else's
 * merges in between, and one branched before an earlier PR merged would drop
 * that PR's work. Each PR is diffed from its first commit's parent to its head,
 * limited to the paths its own first-parent, non-merge commits touched, so main
 * merged into the branch stays out. Null when no PR could be read; a PR that
 * cannot be is noted on the human arm. On a path the PR touched, a merge of
 * main that changed the same file still shows in that file's diff.
 */
function humanDiff(s: Scoring, ticket: BacktestTicket, notes: string[]): string | null {
  const parts: string[] = [];
  for (const pr of ticket.humanPrs) {
    const first = pr.firstCommit || null;
    const head = pr.headRefOid || null;
    if (first === null || head === null || !hasCommit(s.clone, first) || !hasCommit(s.clone, head)) {
      notes.push(`judge: #${pr.number}'s commits are not in the scoring clone; its change is left out`);
      continue;
    }
    const parent = hasCommit(s.clone, `${first}^`) ? `${first}^` : EMPTY_TREE;
    const range = parent === EMPTY_TREE ? [head] : [`${first}^..${head}`];
    const log = git(s.clone, ["-c", "core.quotePath=false", "log", "--first-parent", "--no-merges", "--no-renames", "--name-only", "--format=", ...range]);
    if (log.status !== 0) { notes.push(`judge: git log for #${pr.number}: ${log.stderr}`); continue; }
    const paths = [...new Set(log.stdout.split("\n").filter((line) => line !== ""))];
    if (paths.length === 0) continue;
    const diff = git(s.clone, ["diff", "--no-renames", parent, head, "--", ...paths.map((path) => `:(literal)${path}`)]);
    if (diff.status !== 0) { notes.push(`judge: git diff for #${pr.number}: ${diff.stderr}`); continue; }
    parts.push(diff.stdout);
  }
  return parts.length === 0 ? null : parts.join("");
}

/**
 * The judge panel (#801) over each arm's first and final diffs, in arm order
 * (the panel shuffles them). An arm with no final diff is left out, with a
 * note on that arm saying why; a judge that fails abstains, and a panel that
 * throws is `unavailable`, never a lost ticket.
 */
async function judgeArms(s: Scoring, seed: string, ticket: BacktestTicket, arms: ArmScore[],
  trees: ({ arm: ArmId; base: string | null; first: string | null; final: string | null; why: string } | { arm: ArmId; diff: () => string | null; why: string })[]): Promise<PanelResult | null> {
  const judge = s.config.scoring.judge;
  if (judge === null) return null;
  const unavailable = (reason: string): PanelResult => ({ seed, order: [], verdicts: [], contested: [], rule: judge.contested ?? { kind: "inversion" }, aggregate: { status: "unavailable", seed, order: [], reason } });
  if (s.deps.signal?.aborted) return unavailable("scoring was stopped");
  try {
    // The human diff's flags, so no candidate is shaped differently from another.
    const diffOf = (from: string, to: string): string | null => {
      const diff = git(s.clone, ["diff", "--no-renames", from, to]);
      return diff.status === 0 ? diff.stdout : null;
    };
    const candidates: Candidate[] = [];
    for (const tree of trees) {
      const notes = arms.find((arm) => arm.arm === tree.arm)?.notes;
      let final: string;
      let first: string | null = null;
      if ("diff" in tree) {
        // Read only now, past the judge-off check: a scoring with no judge runs no git for it.
        const diff = tree.diff();
        if (diff === null) { notes?.push(`judge: ${tree.why}`); continue; }
        final = diff;
      } else {
        if (tree.base === null || tree.final === null) { notes?.push(`judge: ${tree.why}`); continue; }
        const diff = diffOf(tree.base, tree.final);
        if (diff === null) { notes?.push(`judge: git diff ${tree.base} ${tree.final} failed`); continue; }
        final = diff;
        // The first head shows what the model did alone, before any review round.
        if (tree.first !== null && tree.first !== tree.final && hasCommit(s.clone, tree.first)) first = diffOf(tree.base, tree.first);
      }
      if (final.trim() === "") { notes?.push("judge: the arm's final diff is empty"); continue; }
      candidates.push({ arm: tree.arm, first, final });
    }
    const factory: JudgeFactory = s.deps.panelJudge
      ?? (s.deps.judge ? (spec, opts) => s.deps.judge!({ ...opts, model: spec.model }) : productionJudge);
    // The scratch dir, not a checkout: a judge must read no project CLAUDE.md that could hint at the arms.
    const judges = judgeSpecs(judge, s.deps.codexModel === undefined ? codexJudgeModel() : s.deps.codexModel).map((spec) => ({
      spec,
      call: factory(spec, {
        cwd: s.scratch, logPath: join(s.logs, `judge-${segment(spec.name)}.log`),
        timeoutMs: Math.min(s.timeoutMs, JUDGE_TIMEOUT_MS), env: s.deps.env, signal: s.deps.signal,
      }),
    }));
    return await judgePanel({
      ticket, candidates, seed, judges, contested: judge.contested,
      instructions: s.deps.instructions?.judge ?? readEvalInstructions("judge-prompt"),
    });
  } catch (error) {
    return unavailable(message(error));
  }
}

/** Every arm with only a note: what a ticket scores as when its clone cannot be made. */
function unscored(ticket: BacktestTicket, rows: TrialRow[], config: BacktestConfig, seed: string, why: string, round?: Round): TicketScore {
  const unavailable: ReviewScore = { status: "unavailable", head: null, reason: why };
  const review = config.scoring.review ? { first: unavailable, final: unavailable } : null;
  return {
    ticket: ticket.oaKey,
    scoredAt: new Date().toISOString(),
    baseline: [],
    arms: [
      { arm: "a", heads: { first: null, final: null }, heldOut: null, gates: null, review, human: null, notes: [why] },
      ...rows.map((row): ArmScore => ({
        arm: row.arm, heads: { first: row.heads?.first ?? null, final: row.heads?.final ?? null },
        heldOut: { status: "none", reason: why }, gates: row.gates, review, human: null, notes: [why],
      })),
    ],
    judge: config.scoring.judge === null ? null : { status: "unavailable", seed, order: [], reason: why },
    panel: null,
    ...(round === undefined ? {} : { repeat: round.repeat }),
  };
}

/**
 * One case's trials scored in a throwaway clone of its source, and written to
 * `<case>/scores.json`, or `<case>/scores-r<n>.json` for a repeat. Null when
 * Ctrl-C cut it short: the previous file stays.
 */
async function scoreRound(runDir: string, config: BacktestConfig, deps: ScoreDeps, seed: string,
  ticket: BacktestTicket, rows: TrialRow[], round?: Round, check?: CheckSpec): Promise<TicketScore | null> {
  const seg = segment(ticket.oaKey);
  const scratch = mkdtempSync(join(deps.scratchParent ?? tmpdir(), "backtest-score-"));
  let score: TicketScore;
  const label = round === undefined ? ticket.oaKey : `${ticket.oaKey} r${round.repeat}`;
  try {
    const source = config.sources[ticket.repo];
    if (source === undefined) throw new Error(`no scoring source for ${ticket.repo}`);
    const clone = join(scratch, "clone");
    const cloned = git(scratch, ["clone", "--quiet", "--no-checkout", source, clone]);
    if (cloned.status !== 0) throw new Error(`git clone ${source}: ${cloned.stderr}`);
    // Each round keeps its own logs: a repeat's must not overwrite the first trial's judges'.
    const logs = join(runDir, seg, round === undefined ? "scoring-logs" : `scoring-logs-r${round.repeat}`);
    rmSync(logs, { recursive: true, force: true });
    deps.log(`score ${label}: ${rows.length} agent arm(s)`);
    const workflow = join(source, WORKFLOW_PATH);
    const workflowFile = existsSync(workflow) ? workflow : undefined;
    score = await scoreTicket(runDir, ticket, rows, {
      clone, scratch, logs, config, deps, timeoutMs: config.caps.trialMinutes * 60_000, worktrees: 0, seed,
      ...(workflowFile !== undefined ? { workflowFile } : {}),
    }, round, check);
  } catch (error) {
    deps.log(`score ${label}: ${message(error)}`);
    score = unscored(ticket, rows, config, seed, `scoring: ${message(error)}`, round);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  // A score finished after Ctrl-C was cut short: the previous file stays.
  if (deps.signal?.aborted) return null;
  writeAtomic(join(runDir, seg, round === undefined ? "scores.json" : `scores-r${round.repeat}.json`), json(score));
  return score;
}

/**
 * Score every sample ticket's human arm and finished agent rows, writing
 * `<runDir>/<segment(oaKey)>/scores.json` for each. A rerun on the same run
 * dir recomputes and overwrites the scores: that is the rescore. Only each
 * case's first trials: `scoreRepeats` scores the repeats.
 */
export async function scoreBacktest(runDir: string, config: BacktestConfig, deps: ScoreDeps): Promise<TicketScore[]> {
  const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as BacktestState;
  const seed = config.scoring.judge?.seed ?? state.id;
  const scores: TicketScore[] = [];
  for (const ticket of state.sample.tickets) {
    if (deps.signal?.aborted) break;
    const rows = armList(state.sample.arms).map((arm) => state.rows[`${ticket.oaKey}/${arm.name}`]).filter((row): row is TrialRow => row !== undefined);
    const score = await scoreRound(runDir, config, deps, seed, ticket, rows, undefined, state.sample.set?.checkRuns?.[ticket.oaKey]);
    // No later ticket starts after Ctrl-C.
    if (score === null) break;
    scores.push(score);
  }
  return scores;
}

/**
 * Every repeat that ran (#821), scored and judged as a first trial is: one
 * round per case and repeat, whose arms are the trials of that repeat, with
 * the reference beside them for the panel. `references` are the cases' first
 * scores, whose reference arm each round reuses; `tickets` limits the pass
 * to those cases. Each round is `<case>/scores-r<n>.json`.
 */
export async function scoreRepeats(runDir: string, config: BacktestConfig, deps: ScoreDeps,
  options: { references: readonly TicketScore[]; tickets?: readonly string[] }): Promise<TicketScore[]> {
  const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as BacktestState;
  const seed = config.scoring.judge?.seed ?? state.id;
  const arms = armList(state.sample.arms);
  const scores: TicketScore[] = [];
  for (const ticket of state.sample.tickets) {
    if (deps.signal?.aborted) break;
    if (options.tickets !== undefined && !options.tickets.includes(ticket.oaKey)) continue;
    // The repeats saved for this case: a trial that did not run was never saved, so it is not scored.
    const repeats = new Set<number>();
    for (const [key, row] of Object.entries(state.rows)) {
      if (row.ticket === ticket.oaKey && row.repeat !== undefined && key === `${ticket.oaKey}/${row.arm}/r${row.repeat}`) repeats.add(row.repeat);
    }
    const reference = options.references.find((score) => score.ticket === ticket.oaKey)?.arms.find((arm) => arm.arm === "a") ?? null;
    let stopped = false;
    for (const repeat of [...repeats].sort((a, b) => a - b)) {
      const rows = arms.map((arm) => state.rows[`${ticket.oaKey}/${arm.name}/r${repeat}`]).filter((row): row is TrialRow => row !== undefined);
      const score = await scoreRound(runDir, config, deps, seed, ticket, rows, { repeat, reference }, state.sample.set?.checkRuns?.[ticket.oaKey]);
      if (score === null) { stopped = true; break; }
      scores.push(score);
    }
    if (stopped) break;
  }
  return scores;
}

/**
 * Whether a case's operator check (#857) is a check at all: it must fail on
 * the case's base commit and pass on its reference, the last human PR's head.
 * Run in a throwaway clone of the repo's source, as scoring does. Every way
 * the commits or the source can be missing is an error on both outcomes; it
 * throws only when the scratch directory itself cannot be made.
 */
export async function verifyCheck(config: BacktestConfig,
  input: { repo: string; baseCommit: string; humanPrs: BacktestPr[]; spec: CheckSpec },
  deps: { fetchHumanPr?: ScoreDeps["fetchHumanPr"]; log: (line: string) => void; scratchParent?: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<{ base: CheckOutcome; reference: CheckOutcome; notes: string[] }> {
  const notes: string[] = [];
  const both = (why: string) => ({ base: checkError(why), reference: checkError(why), notes });
  const source = config.sources[input.repo];
  if (source === undefined) return both(`no scoring source for ${input.repo}`);
  const scratch = mkdtempSync(join(deps.scratchParent ?? tmpdir(), "backtest-check-"));
  try {
    const clone = join(scratch, "clone");
    const cloned = git(scratch, ["clone", "--quiet", "--no-checkout", source, clone]);
    if (cloned.status !== 0) return both(`git clone ${source}: ${cloned.stderr}`);
    const reference = input.humanPrs.at(-1)?.headRefOid || null;
    if (reference === null) return both("the case has no reference head");
    const fetchHuman = deps.fetchHumanPr ?? fetchPullFrom(source);
    for (const [what, sha] of [["base commit", input.baseCommit], ["reference", reference]] as const) {
      for (const pr of input.humanPrs) {
        if (sha === "" || hasCommit(clone, sha)) break;
        try { fetchHuman(clone, input.repo, pr.number); } catch (error) { notes.push(`fetching #${pr.number}: ${message(error)}`); }
      }
      if (sha === "" || !hasCommit(clone, sha)) return both(`the ${what} ${sha.slice(0, 7) || "(none)"} is not in the source nor its PR refs`);
    }
    deps.log(`check ${input.repo}: base ${input.baseCommit.slice(0, 7)}, reference ${reference.slice(0, 7)}`);
    const s: Scoring = {
      clone, scratch, logs: join(scratch, "logs"), config,
      // runCheck reads only the signal off the deps: no review, gh or judge is called.
      deps: { log: deps.log, ...(deps.signal !== undefined ? { signal: deps.signal } : {}) } as ScoreDeps,
      timeoutMs: deps.timeoutMs ?? config.caps.trialMinutes * 60_000, worktrees: 0, seed: "check",
    };
    const run = async (sha: string, label: string): Promise<CheckOutcome> => {
      try { return await runCheck(s, worktree(s, sha), input.spec, reference, label, notes); } catch (error) { return checkError(message(error)); }
    };
    const base = await run(input.baseCommit, "base");
    return { base, reference: await run(reference, "reference"), notes };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
