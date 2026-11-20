/**
 * The improver CLI (#873): `propose` runs the improver on a finished eval
 * run, stores its proposal beside the run, and queues the run that would try
 * it in the recommended-runs inbox. The dashboard shells out to it and never
 * imports it.
 *
 * Nothing here starts an eval run: the operator starts the inbox entry, so a
 * proposal costs one model session and never a batch of trials on its own.
 * That is why this module imports neither `startRun` nor `experiments.ts`.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { configArms, DEFAULT_JUDGE_MODEL, type ArmConfig, type BacktestConfig } from "./backtest";
import { claudeJudge, JUDGE_TIMEOUT_MS, type JudgeCall } from "./backtest-judge";
import type { BacktestReport } from "./backtest-report";
import { segment } from "./backtest-run";
import { lineupPath } from "./backtest-trial";
import type { Analysis } from "./eval-analyst";
import { isPromptKind, isTestSetKind, testSetRefusal, type CaseContent, type CheckContent, type PromptContent, type PromptKind, type RetireContent } from "./eval-evaluation-proposals";
import { gradeRun } from "./eval-grade";
import { addEntry, type InboxEntry } from "./eval-inbox";
import { proposedLineup } from "./eval-lineup";
import { promptHash, readSaturated } from "./eval-proposals";
import {
  failedCases, GOALS, improverInput, improverPrompt, improverSettings, liveLineup, parseProposal, subsetCases,
  type Goal, type ImproverRun, type LineupContent, type OverlayContent,
} from "./eval-improver";
import { EVAL_INSTRUCTION_FILES, readEvalInstructions } from "./eval-instructions";
import { checkStart, experimentsRoot, launch, readPatch, runSummary, type Launcher, type SetReader } from "./eval-runs";
import { readSet as readEvalSet, type EvalCase } from "./evals-set";
import { loadConfig, validateConfig } from "./models";
import { projectRoot } from "./paths";
import { loadProjectConfig } from "./project-config";
import { projectIdFor } from "./project-id";
import { isPromptFile, readOverlay } from "./prompt-overlay";
import { buildRedactor } from "./runner-failure";
import { summarizeReview } from "./trial-review";
import { REVIEW_ROUND_CAP } from "./trial-sandbox";

export interface EvalsImproveDeps {
  now: () => string;
  out: (line: string) => void;
  err: (line: string) => void;
  /** The project's test set: the cases the improver may read, and the recommended run picks from. */
  readSet: SetReader;
  /** The improver's model session for one model, logging to `logPath`. */
  judge: (options: { model: string; logPath: string }) => JudgeCall;
  /** Throws, in the plan parser's words, on a plan that would not run. */
  check: (project: string, plan: Record<string, unknown>) => void;
  /** Starts `propose` in the background for `--detach`; never an eval run. */
  launcher: Launcher;
  /** The bun binary the detached `propose` runs under. */
  bun: string;
  /** Where lineup files live (`<home>/.ralph/lineups`): injected so a test never writes the operator's. */
  home: string;
  /** The live models.json, the base a lineup proposal overrides. */
  loadConfig: () => Record<string, unknown>;
  /** The project's `.ralph/config.json`, for the improver's subset settings. */
  projectConfig: (project: string) => { evalsImprover?: { size?: number; failed?: boolean } };
  /** A fresh proposal id. */
  proposalId: () => string;
  /** A fresh per-propose nonce: names the scope unit and the logs, so two proposes on one run never share them. */
  nonce: () => string;
  /** A harness prompt file's current text by its harness-relative path; null when it cannot be read. */
  readPrompt: (path: string) => string | null;
  /** Queues the recommended run in the inbox (`eval-inbox.ts`). */
  addEntry: typeof addEntry;
  /** The judge panel's or the analyst's current opening instructions (#878): injected so a test never reads the harness's files. */
  readInstructions: (kind: PromptKind) => string;
  /** The set's saturated cases as its runs say (`readSaturated`, #878); undefined when unreadable, then only a stored status counts. */
  saturated: (project: string, cases: readonly EvalCase[]) => ReadonlySet<string> | undefined;
}

const USAGE = "usage: evals-improve.ts propose --run <id> --goal quality|cost [--project <path>] [--model <id>] [--detach]";

class UsageError extends Error {}

/** Flags that take no value. */
const SWITCHES = new Set(["detach"]);
/** `--session` is not in USAGE: only `--detach` passes it, so the child logs where its launcher named. */
const FLAGS: Record<string, readonly string[]> = {
  propose: ["project", "run", "goal", "model", "detach", "session"],
};

/** `--flag value` pairs and positionals; an unknown flag or a missing value is a usage error, not a guess. */
function parseArgs(command: string, rest: string[]): { positional: string[]; flags: Map<string, string> } {
  const allowed = FLAGS[command] ?? [];
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const name = arg.slice(2);
    if (!allowed.includes(name)) throw new UsageError(`unknown flag ${arg} for ${command}`);
    if (flags.has(name)) throw new UsageError(`${arg} given twice`);
    if (SWITCHES.has(name)) { flags.set(name, ""); continue; }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value`);
    flags.set(name, value);
    index += 1;
  }
  return { positional, flags };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

/** The run's analysis: its own file, else the copy the report carries. */
function runAnalysis(runDir: string, report: BacktestReport): Analysis | null {
  return readJson<Analysis>(join(runDir, "analysis.json")) ?? report.analysis ?? null;
}

/** A NUL byte marks a binary file: the improver reads text, never a bundle. */
const isText = (buffer: Buffer): boolean => !buffer.includes(0);

/**
 * The trial's own logs (`<trial>/logs/*`, as backtest-run writes them). Only
 * the trial's directory is read: the source PR and the case's graded fields
 * live elsewhere and stay out.
 */
function trialLogs(trialDir: string): string[] {
  const dir = join(trialDir, "logs");
  let names: string[];
  try { names = readdirSync(dir).sort(); } catch { return []; }
  const texts: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      const buffer = readFileSync(path);
      if (isText(buffer)) texts.push(`# ${name}\n${buffer.toString("utf8")}`);
    } catch { /* an unreadable log costs that log, not the proposal */ }
  }
  return texts;
}

/** Write then rename, so a kill mid-write leaves no half of a proposal. */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

/** A prompt's `{{…}}` placeholders: an overlay that drops one renders a prompt with a hole in it. */
const placeholders = (text: string): Set<string> => new Set(text.match(/\{\{[^{}]+\}\}/g) ?? []);

const firstLine = (text: string): string => {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
};

/** Exit status: 0 done, 1 refused or failed, 64 bad usage. */
export async function runEvalsImprove(argv: string[], deps: EvalsImproveDeps): Promise<number> {
  const [command, ...rest] = argv;
  const refuse = (why: string): number => { deps.err(`evals-improve: ${buildRedactor()(why)}`); return 1; };
  try {
    if (command === undefined || !(command in FLAGS)) throw new UsageError(command === undefined ? "no command" : `unknown command ${command}`);
    const { positional, flags } = parseArgs(command, rest);
    if (positional.length > 0) throw new UsageError("propose takes no arguments");
    const project = resolve(flags.get("project") ?? projectRoot());
    const id = flags.get("run");
    if (id === undefined || segment(id) !== id) throw new UsageError(id === undefined ? "propose needs --run <id>" : `${id} is not a run id`);
    const goalFlag = flags.get("goal");
    if (goalFlag === undefined || !(GOALS as readonly string[]).includes(goalFlag)) throw new UsageError(`propose needs --goal ${GOALS.join("|")}`);
    const goal = goalFlag as Goal;
    const modelFlag = flags.get("model");
    if (modelFlag !== undefined && modelFlag.trim() === "") throw new UsageError("--model needs a model id");
    const sessionFlag = flags.get("session");
    if (sessionFlag !== undefined && segment(sessionFlag) !== sessionFlag) throw new UsageError(`${sessionFlag} is not a session id`);

    // Checked before any model call, and before a detached start, so the caller gets the reason at once.
    const runDir = join(experimentsRoot(project), id);
    const report = readJson<BacktestReport>(join(runDir, "report.json"));
    if (report === null) return refuse(`run ${id} has no report`);
    // A run off a ticket list has tickets that are not case ids: its subset would be empty, and an empty subset runs the whole set.
    if (report.set === undefined) return refuse(`run ${id} is not a test-set run: the improver needs a test-set run, whose tickets are case ids`);
    const analysis = runAnalysis(runDir, report);
    if (analysis === null) return refuse(`run ${id} has no analysis`);
    if (analysis.status !== "ok") return refuse(`run ${id} has no analysis (${analysis.reason})`);

    if (flags.has("detach")) {
      // A model session takes minutes; the dashboard's exec waits 30 s. The same command runs inline in the background.
      // Per propose, not per run: a second propose on the same run gets its own unit and log.
      const nonce = deps.nonce();
      const unit = `ralph-improver-${createHash("sha256").update(`${runDir}\0${goal}\0${nonce}`).digest("hex").slice(0, 10)}`;
      const log = `improver-${nonce}.log`;
      deps.launcher({
        command: deps.bun,
        argv: [
          join(resolve(import.meta.dirname), "evals-improve.ts"), "propose", "--run", id, "--goal", goal, "--project", project,
          "--session", nonce, ...(modelFlag === undefined ? [] : ["--model", modelFlag]),
        ],
        cwd: project, log: join(runDir, log), unit,
      });
      deps.out(JSON.stringify({ ok: true, started: true, run: id, goal, log }));
      return 0;
    }

    const state = readJson<{ config?: BacktestConfig }>(join(runDir, "state.json"));
    const arms: ArmConfig[] = state?.config ? configArms(state.config) : (runSummary(runDir)?.arms ?? []);
    const armNames = arms.map((arm) => arm.name);
    const rows = report.rows ?? [];
    const patches: ImproverRun["patches"] = [];
    const logs: ImproverRun["logs"] = [];
    const reviews: NonNullable<ImproverRun["reviews"]> = [];
    for (const row of rows.filter((entry) => entry.repeat === undefined)) {
      let diff: string | null = null;
      try { diff = readPatch(project, id, row.ticket, row.arm); } catch { diff = null; }
      if (diff !== null) patches.push({ ticket: row.ticket, arm: row.arm, diff });
      if (segment(row.arm) !== row.arm) continue;
      const trialDir = join(runDir, segment(row.ticket), row.arm);
      for (const text of trialLogs(trialDir)) logs.push({ ticket: row.ticket, arm: row.arm, text });
      // The reference arm is filtered again in improverInput; reading it here costs nothing it could leak.
      const result = readJson<{ github?: unknown }>(join(trialDir, "result.json"));
      if (result !== null && result.github !== undefined) reviews.push({ ticket: row.ticket, arm: row.arm, review: summarizeReview(result.github, REVIEW_ROUND_CAP) });
    }
    // The files an overlay could replace, whole, so the improver edits the real text rather than recalling it.
    const prompts: Record<string, string> = {};
    for (const entry of analysis.improvements) {
      if (entry.knob !== "prompt" || !isPromptFile(entry.target) || entry.target in prompts) continue;
      const text = deps.readPrompt(entry.target);
      if (text !== null) prompts[entry.target] = text;
    }
    const run: ImproverRun = { id, analysis, arms, rows, patches, logs, reviews, prompts };
    const cases = deps.readSet(project).cases;
    const config = deps.loadConfig();
    const instructions = { judge: deps.readInstructions("judge-prompt"), analyst: deps.readInstructions("analyst-prompt") };
    const saturated = deps.saturated(project, cases) ?? new Set(cases.filter((c) => c.status === "saturated").map((c) => c.id));
    const input = improverInput(run, cases, liveLineup(config), instructions, saturated);

    const session = sessionFlag ?? deps.nonce();
    const model = modelFlag ?? state?.config?.scoring?.analyst?.model ?? DEFAULT_JUDGE_MODEL;
    // Its own file: the judge truncates its log, and the launcher's log is the detached child's stdout.
    const answer = await deps.judge({ model, logPath: join(runDir, `improver-${session}.model.log`) })(improverPrompt(input, goal));
    if (!answer.ok) return refuse(`the improver failed: ${answer.reason}`);
    const parsed = parseProposal(answer.text, goal, input.improvements);
    if (!parsed.ok) return refuse(`the improver's proposal was refused: ${parsed.reason}`);
    const proposal = parsed.proposal;
    if (proposal.kind === "prompt-overlay") {
      for (const [path, text] of Object.entries((proposal.content as OverlayContent).files)) {
        const current = input.prompts[path];
        if (current === undefined) continue;
        const kept = placeholders(text);
        const missing = [...placeholders(current)].filter((token) => !kept.has(token));
        if (missing.length > 0) return refuse(`the improver's proposal was refused: overlay file ${path} drops ${missing.join(", ")}`);
      }
    }

    // An evaluation proposal (#878) queues no run: a test-set one waits on the operator, a prompt one on its re-judge.
    if (isTestSetKind(proposal.kind) || isPromptKind(proposal.kind)) {
      let subset: string[] = [];
      let bases: Record<string, string> | undefined;
      if (isTestSetKind(proposal.kind)) {
        const why = testSetRefusal(proposal.kind, proposal.content as CaseContent | CheckContent | RetireContent, cases, saturated);
        if (why !== null) return refuse(`the improver's proposal was refused: ${why}`);
      } else {
        // The CLI reads the calibration verdicts to name the cases; the improver never saw them.
        const kind = proposal.kind;
        const current = kind === "judge-prompt" ? instructions.judge : instructions.analyst;
        // A no-op would re-judge twice under one prompt and measure only the judges' noise.
        if ((proposal.content as PromptContent).instructions.trimEnd() === current.trimEnd()) {
          return refuse("the improver's proposal was refused: the proposed instructions are the current ones");
        }
        subset = cases.filter((c) => (c.calibration ?? []).length > 0).map((c) => c.id);
        if (subset.length === 0) return refuse("the improver's proposal was refused: no calibrated case to measure judge accuracy on");
        // The re-judge rescores this run: a calibrated case it never ran has no panel to measure.
        const ran = new Set(rows.map((row) => row.ticket));
        subset = subset.filter((caseId) => ran.has(caseId));
        if (subset.length === 0) return refuse(`the improver's proposal was refused: none of the calibrated cases ran in run ${id}`);
        // The instructions it replaces, as read now: the PR path refuses when main's copy has moved since, as overlays do.
        bases = { [EVAL_INSTRUCTION_FILES[kind]]: promptHash(current) };
      }
      const pid = deps.proposalId();
      const proposalsDir = join(runDir, "proposals");
      const proposalFile = join(proposalsDir, `${pid}.json`);
      try {
        writeAtomic(proposalFile, `${JSON.stringify({
          v: 1, id: pid, run: id, goal, kind: proposal.kind, content: proposal.content, rationale: proposal.rationale,
          answers: proposal.answers, model, createdAt: deps.now(), subset, entry: null, ...(bases === undefined ? {} : { bases }),
        }, null, 2)}\n`);
      } catch (error) {
        rmSync(proposalFile, { force: true });
        try { rmdirSync(proposalsDir); } catch { /* other proposals are there, or it never was */ }
        return refuse(message(error));
      }
      deps.out(JSON.stringify({ ok: true, proposal: pid, kind: proposal.kind, goal, entry: null, cases: subset.length }));
      return 0;
    }

    const pid = deps.proposalId();
    const proposalsDir = join(runDir, "proposals");
    const pidDir = join(proposalsDir, pid);
    const lineupName = `improver-${pid}`;
    const lineupFile = lineupPath(lineupName, deps.home);
    // Undo what was written for a proposal that will not be stored: a half proposal is noise in the run dir.
    const proposalFile = join(proposalsDir, `${pid}.json`);
    const undo = (): void => {
      rmSync(pidDir, { recursive: true, force: true });
      rmSync(proposalFile, { force: true });
      try { rmdirSync(proposalsDir); } catch { /* other proposals are there, or it never was */ }
      rmSync(lineupFile, { force: true });
    };

    let overlay: string | null = null;
    let lineup = "live";
    try {
      if (proposal.kind === "prompt-overlay") {
        overlay = join(pidDir, "overlay");
        for (const [path, text] of Object.entries((proposal.content as OverlayContent).files)) {
          const target = join(overlay, path);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, text);
        }
        // Belt and braces: the overlay rule enforced on the disk the run will read.
        readOverlay(overlay);
      } else {
        const proposed = proposedLineup(config, (proposal.content as LineupContent).stages);
        const { problems } = validateConfig(proposed);
        if (problems.length > 0) throw new Error(`the proposed lineup is not a valid models.json: ${problems.join("; ")}`);
        lineup = lineupName;
        mkdirSync(dirname(lineupFile), { recursive: true });
        writeFileSync(lineupFile, `${JSON.stringify(proposed, null, 2)}\n`);
      }
    } catch (error) {
      undo();
      return refuse(message(error));
    }

    const cited = [...new Set(proposal.answers.flatMap((entry) => entry.evidence))];
    const failed = failedCases(rows, gradeRun(report, armNames));
    const subset = subsetCases(cases, cited, failed, improverSettings(deps.projectConfig(project)));
    // An empty case list reads as "every active case" to the plan: refused, never a whole-set run.
    if (subset.length === 0) { undo(); return refuse(`no related case is active in the test set: the proposal for run ${id} has no case to try`); }
    const sourcePlan = readJson<Record<string, unknown>>(join(runDir, "plan.json"));
    const plan: Record<string, unknown> = {
      source: { kind: "set", tags: [], cases: subset },
      arms: [{ name: "current", lineup: "live", overlay: null }, { name: "proposal", lineup, overlay }],
      ...(sourcePlan?.scoring !== undefined ? { scoring: sourcePlan.scoring } : {}),
      ...(sourcePlan?.repeats !== undefined ? { repeats: sourcePlan.repeats } : {}),
    };
    // A recommendation the operator could not start is noise: refused, and what was written for it removed.
    try { deps.check(project, plan); } catch (error) { undo(); return refuse(message(error)); }

    // What each overlay file replaced, as the trial's baseline read it (#875): the PR that
    // ships the overlay refuses when main's copy has moved since, rather than reverting it.
    const bases: Record<string, string | null> | undefined = proposal.kind === "prompt-overlay"
      ? Object.fromEntries(Object.keys((proposal.content as OverlayContent).files).map((path) => {
        const text = deps.readPrompt(path);
        return [path, text === null ? null : promptHash(text)];
      }))
      : undefined;
    const stored = (entryId: string | null): string => `${JSON.stringify({
      v: 1, id: pid, run: id, goal, kind: proposal.kind, content: proposal.content, rationale: proposal.rationale,
      answers: proposal.answers, model, createdAt: deps.now(), subset, entry: entryId, ...(bases === undefined ? {} : { bases }),
    }, null, 2)}\n`;
    // The proposal is on disk before the inbox names it, and removed whole if the inbox write fails: never half of one.
    let entry: InboxEntry;
    try {
      writeAtomic(proposalFile, stored(null));
      entry = await deps.addEntry(project, {
        plan,
        recommendedBy: { kind: "agent", name: "improver" },
        reason: `${goal} proposal ${pid} (${proposal.kind}) on run ${id}: ${firstLine(proposal.rationale)}`,
      }, deps.now());
    } catch (error) {
      undo();
      return refuse(`the recommended run could not be queued: ${message(error)}`);
    }
    writeAtomic(proposalFile, stored(entry.id));
    deps.out(JSON.stringify({ ok: true, proposal: pid, kind: proposal.kind, goal, entry: entry.id, cases: subset.length }));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      deps.err(`evals-improve: ${error.message}`);
      deps.err(USAGE);
      return 64;
    }
    return refuse(message(error));
  }
}

export function realEvalsImproveDeps(): EvalsImproveDeps {
  return {
    now: () => new Date().toISOString(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    readSet: (project) => readEvalSet(projectIdFor(project).id),
    judge: ({ model, logPath }) => async (prompt) => {
      // The scratch dir, as the analyst and the judges: no project CLAUDE.md to read.
      const scratch = mkdtempSync(join(tmpdir(), "eval-improver-"));
      try {
        mkdirSync(dirname(logPath), { recursive: true });
        return await claudeJudge({ model, cwd: scratch, logPath, timeoutMs: JUDGE_TIMEOUT_MS })(prompt);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    check: (project, plan) => { checkStart(project, plan); },
    launcher: launch,
    bun: process.execPath,
    home: homedir(),
    // Read only: a migrating load would rewrite the live models.json from an eval command.
    loadConfig: () => loadConfig(undefined, false),
    projectConfig: (project) => loadProjectConfig(project),
    proposalId: () => `prop-${randomBytes(4).toString("hex")}`,
    nonce: () => randomBytes(3).toString("hex"),
    readPrompt: (path) => {
      try { return readFileSync(join(resolve(import.meta.dirname), path), "utf8"); } catch { return null; }
    },
    addEntry,
    readInstructions: (kind) => readEvalInstructions(kind),
    saturated: readSaturated,
  };
}

if (import.meta.main) {
  try {
    process.exitCode = await runEvalsImprove(process.argv.slice(2), realEvalsImproveDeps());
  } catch (error) {
    console.error(`evals-improve: ${buildRedactor()(String(error))}`);
    process.exitCode = 1;
  }
}
