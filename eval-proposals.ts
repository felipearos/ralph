/**
 * The improver's proposals (#873) and where each one stands (#874). A
 * proposal's status is never stored: it is derived from the eval runs that
 * carry it, so a run started, stopped or dismissed by hand is read as it is.
 *
 * A proposal first runs on a subset of the test set. A subset run that is
 * promising (every guardrail condition passes but the noise-floor ones, which
 * only the full set can measure) earns one full-set run, recommended into the
 * inbox by `advanceProposals`; the full run's guardrail verdict is the
 * proposal's verdict.
 *
 * The one thing stored is that the full run was recommended (`full` on the
 * proposal file), so the advance happens once even if the operator dismisses
 * the recommendation: a dismissed run is the operator's decision, never
 * re-asked.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { BacktestReport } from "./backtest-report";
import { writeAtomic } from "./backtest-run";
import { NOISE_FLOOR_CONDITIONS, guardrailSettings, reportGuardrails, type GuardrailCondition, type GuardrailGoal, type GuardrailThresholds } from "./eval-guardrails";
import { addEntry, readInbox, withLock, type InboxEntry } from "./eval-inbox";
import type { NoiseStatus } from "./eval-noise-floor";
import { checkStart, experimentsRoot, runsNewestFirst, type EvalRunSummary } from "./eval-runs";
import { loadProjectConfig } from "./project-config";

export type ProposalStatus = "proposed" | "subset-run" | "full-run" | "passed" | "failed";

export interface ProposalAnswer { knob: string; target: string; change: string; arm?: string; evidence?: string[] }

export interface StoredProposal {
  v: 1;
  id: string;
  /** The run the improver read. */
  run: string;
  goal: GuardrailGoal;
  kind: "prompt-overlay" | "lineup";
  content: unknown;
  rationale: string;
  answers: ProposalAnswer[];
  model: string;
  createdAt: string;
  subset: string[];
  /** The inbox entry of the subset run. */
  entry: string | null;
  /** The full-set run, once recommended; absent on older files. */
  full: { entry: string; at: string; subsetRun: string } | null;
  /**
   * An overlay's base (#875): each file's `promptHash` as the trial's baseline
   * read it, null for a file it could not read; absent on a lineup and on
   * files written before #875.
   */
  bases?: Record<string, string | null>;
  /** The file it was read from. */
  path: string;
}

/** A prompt file's text as a stable hash: what an overlay's base is recorded and compared as (#875). */
export const promptHash = (text: string): string => createHash("sha256").update(text).digest("hex");

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isDir = (path: string): boolean => { try { return statSync(path).isDirectory(); } catch { return false; } };
const list = (dir: string): string[] => { try { return readdirSync(dir).sort(); } catch { return []; } };

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}


/** One proposal file; a reason string when it is not one. */
export function parseProposal(value: unknown, path: string): StoredProposal | string {
  if (!isObject(value)) return `${path}: not a proposal object`;
  if (value.v !== 1) return `${path}: v must be 1`;
  for (const key of ["id", "run", "model", "createdAt"] as const) {
    if (!isString(value[key]) || value[key] === "") return `${path}: ${key} must be a non-empty string`;
  }
  if (value.goal !== "quality" && value.goal !== "cost") return `${path}: goal must be "quality" or "cost"`;
  if (value.kind !== "prompt-overlay" && value.kind !== "lineup") return `${path}: kind must be "prompt-overlay" or "lineup"`;
  if (!isString(value.rationale)) return `${path}: rationale must be a string`;
  if (!Array.isArray(value.answers) || !value.answers.every((answer) => isObject(answer) && isString(answer.knob) && isString(answer.target) && isString(answer.change))) {
    return `${path}: answers must be a list of improvements`;
  }
  if (!Array.isArray(value.subset) || !value.subset.every(isString)) return `${path}: subset must be a list of case ids`;
  if (value.entry !== null && !isString(value.entry)) return `${path}: entry must be a string or null`;
  let full: StoredProposal["full"] = null;
  if (value.full !== undefined && value.full !== null) {
    const given = value.full;
    if (!isObject(given) || !isString(given.entry) || !isString(given.at) || !isString(given.subsetRun)) return `${path}: full must be null or { entry, at, subsetRun }`;
    full = { entry: given.entry, at: given.at, subsetRun: given.subsetRun };
  }
  let bases: Record<string, string | null> | undefined;
  if (value.bases !== undefined) {
    if (!isObject(value.bases) || !Object.values(value.bases).every((hash) => hash === null || isString(hash))) return `${path}: bases must map files to a hash or null`;
    bases = value.bases as Record<string, string | null>;
  }
  return {
    v: 1, id: value.id as string, run: value.run as string, goal: value.goal, kind: value.kind, content: value.content,
    rationale: value.rationale, answers: value.answers as ProposalAnswer[], model: value.model as string, createdAt: value.createdAt as string,
    subset: value.subset as string[], entry: (value.entry as string | null | undefined) ?? null, full, path,
    ...(bases === undefined ? {} : { bases }),
  };
}

/** Every `<run>/proposals/<pid>.json` under the project. Never throws: a file that does not parse is a problem. */
export function readProposals(project: string): { proposals: StoredProposal[]; problems: string[] } {
  const root = experimentsRoot(project);
  const proposals: StoredProposal[] = [];
  const problems: string[] = [];
  for (const run of list(root)) {
    const dir = join(root, run, "proposals");
    if (!isDir(dir)) continue;
    for (const name of list(dir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (error) { problems.push(`${path}: not JSON: ${message(error)}`); continue; }
      const parsed = parseProposal(raw, path);
      if (typeof parsed === "string") problems.push(parsed); else proposals.push(parsed);
    }
  }
  return { proposals, problems };
}

/** The proposal's arm in a run: its own lineup, or its overlay directory. */
function carries(pid: string, run: EvalRunSummary): boolean {
  return (run.arms ?? []).some((arm) => {
    if (arm.lineup === `improver-${pid}`) return true;
    if (!isString(arm.overlay)) return false;
    const tail = arm.overlay.split(/[\\/]+/).filter((part) => part !== "").slice(-3);
    return tail.length === 3 && tail[0] === "proposals" && tail[1] === pid && tail[2] === "overlay";
  });
}

const newest = (runs: EvalRunSummary[]): EvalRunSummary | null =>
  runs.reduce<EvalRunSummary | null>((best, run) => (best === null || run.startedAt > best.startedAt ? run : best), null);

/** The newest subset run (named cases) and the newest full-set run (no case, no tag) carrying the proposal. */
export function proposalRuns(pid: string, runs: readonly EvalRunSummary[]): { subset: EvalRunSummary | null; full: EvalRunSummary | null } {
  const mine = runs.filter((run) => run.source?.kind === "set" && carries(pid, run));
  const set = (run: EvalRunSummary) => run.source as Extract<EvalRunSummary["source"], { kind: "set" }>;
  return {
    subset: newest(mine.filter((run) => (set(run).cases ?? []).length > 0)),
    full: newest(mine.filter((run) => (set(run).cases ?? []).length === 0 && (set(run).tags ?? []).length === 0)),
  };
}

// Any status will do: the conditions that read it are dropped.
const NO_FLOOR: NoiseStatus = { state: "missing", floor: null, drift: null, staleShare: 0 };

/** Whether a subset run is promising: every condition of the goal passes, the noise-floor ones aside. */
export function subsetPromise(report: BacktestReport, goal: GuardrailGoal, thresholds: GuardrailThresholds): { promising: boolean; conditions: GuardrailCondition[]; reason: string | null } {
  let verdict;
  try { verdict = reportGuardrails(report, NO_FLOOR, thresholds); } catch { verdict = null; }
  const mine = verdict?.goals.find((entry) => entry.goal === goal) ?? null;
  if (mine === null) return { promising: false, conditions: [], reason: "the subset run has no graded baseline/proposal pair" };
  const conditions = mine.conditions.filter((condition) => !NOISE_FLOOR_CONDITIONS.has(condition.id));
  const failing = conditions.filter((condition) => !condition.pass).map((condition) => condition.id);
  return failing.length === 0
    ? { promising: true, conditions, reason: null }
    : { promising: false, conditions, reason: `the subset run was not promising: ${failing.join(", ")}` };
}

export interface ProposalStatusDeps {
  readReport: (runDir: string) => BacktestReport | null;
  thresholds: GuardrailThresholds;
  inbox: readonly InboxEntry[];
}

export interface ProposalState {
  status: ProposalStatus;
  verdict: { pass: boolean; conditions: GuardrailCondition[] } | null;
  reason: string | null;
  runs: { subset: string | null; full: string | null };
  promising: boolean | null;
}

/** Where the proposal stands, read off its runs. Never throws. */
export function proposalStatus(proposal: StoredProposal, runs: readonly EvalRunSummary[], deps: ProposalStatusDeps): ProposalState {
  const { subset, full } = proposalRuns(proposal.id, runs);
  const ids = { subset: subset?.id ?? null, full: full?.id ?? null };
  const state = (status: ProposalStatus, rest: Partial<ProposalState> = {}): ProposalState =>
    ({ status, verdict: null, reason: null, runs: ids, promising: null, ...rest });
  const inInbox = (id: string): boolean => deps.inbox.some((entry) => entry.id === id);
  // Recommended and dismissed before it ran: the operator's call, said rather than waited on.
  const fullPending = (rest: Partial<ProposalState>): ProposalState => state("full-run", {
    ...rest,
    reason: full === null && proposal.full !== null && !inInbox(proposal.full.entry)
      ? `its full-set run (inbox entry ${proposal.full.entry}) was dismissed from the inbox`
      : rest.reason ?? null,
  });

  if (full !== null) {
    if (full.running) return fullPending({});
    // Not running and never finished: stopped by hand, killed, or lost to a reboot. Said, not waited on forever.
    if (full.finishedAt === null) return state("failed", { reason: `the full-set run stopped before the end${full.problem === null ? "" : `: ${full.problem}`}` });
    const goal = full.guardrails?.goals.find((entry) => entry.goal === proposal.goal) ?? null;
    if (goal !== null) return state(goal.pass ? "passed" : "failed", { verdict: { pass: goal.pass, conditions: goal.conditions } });
    const why = full.stoppedBy !== null ? `the full-set run stopped (${full.stoppedBy})`
      : full.problem !== null ? `the full-set run: ${full.problem}`
        : "no guardrail verdict: no noise floor or no baseline pair";
    return state("failed", { reason: why });
  }

  if (subset !== null) {
    if (subset.running) return state("subset-run");
    if (subset.finishedAt === null) return state("failed", { reason: `the subset run stopped before the end${subset.problem === null ? "" : `: ${subset.problem}`}` });
    let report: BacktestReport | null;
    try { report = deps.readReport(subset.dir); } catch { report = null; }
    const promise = report === null
      ? { promising: false, conditions: [], reason: "the subset run has no report" }
      : subsetPromise(report, proposal.goal, deps.thresholds);
    const verdict = { pass: promise.promising, conditions: promise.conditions };
    if (!promise.promising) return state("failed", { verdict, reason: promise.reason, promising: false });
    // No verdict yet: a promising subset settles nothing, and a green one beside "Full-set run" would read as passed.
    if (proposal.full !== null) return fullPending({ promising: true, reason: "the subset run was promising" });
    return state("subset-run", { promising: true, reason: "the subset run was promising: a full-set run is to be recommended" });
  }

  if (proposal.entry !== null && !inInbox(proposal.entry)) {
    return state("proposed", { reason: `its subset run (inbox entry ${proposal.entry}) was dismissed from the inbox` });
  }
  return state("proposed");
}

/** The subset run's plan over the whole set: same arms, scoring and repeats, nothing a completed plan added. */
export function fullSetPlan(subsetPlan: Record<string, unknown>): Record<string, unknown> {
  return {
    source: { kind: "set", tags: [], cases: [] },
    arms: subsetPlan.arms,
    ...(subsetPlan.scoring !== undefined ? { scoring: subsetPlan.scoring } : {}),
    ...(subsetPlan.repeats !== undefined ? { repeats: subsetPlan.repeats } : {}),
  };
}

function isFullSetOf(plan: Record<string, unknown>, wanted: Record<string, unknown>): boolean {
  const source = plan.source;
  if (!isObject(source) || source.kind !== "set") return false;
  if (!Array.isArray(source.cases) || source.cases.length !== 0) return false;
  if (source.tags !== undefined && (!Array.isArray(source.tags) || source.tags.length !== 0)) return false;
  return JSON.stringify(plan.arms) === JSON.stringify(wanted.arms);
}

export interface AdvanceDeps {
  runs: () => EvalRunSummary[];
  readReport: (runDir: string) => BacktestReport | null;
  readPlan: (runDir: string) => Record<string, unknown> | null;
  thresholds: GuardrailThresholds;
  addEntry: (project: string, add: { plan: Record<string, unknown>; recommendedBy: InboxEntry["recommendedBy"]; reason: string }, now: string) => Promise<InboxEntry>;
  readInbox: (project: string) => InboxEntry[];
  check: (project: string, plan: Record<string, unknown>) => void;
  now: () => string;
}

/**
 * Recommend one full-set run for each proposal whose subset run finished
 * promising. The slow part (every run read, and the start check, which
 * fetches the test set) runs before the lock: the lock is broken as stale
 * after 10 s, so a section that outlives it would let a second advance in.
 * Under the lock only the proposal file and the inbox are re-read, so two
 * advances never recommend the same run twice; an inbox entry already
 * holding that plan is adopted rather than doubled. One proposal's failure
 * is a problem string and never stops the others.
 */
export async function advanceProposals(project: string, deps: AdvanceDeps): Promise<{ advanced: string[]; problems: string[] }> {
  const advanced: string[] = [];
  const problems: string[] = [];
  const { proposals, problems: unread } = readProposals(project);
  problems.push(...unread);
  let runs: EvalRunSummary[];
  let inbox: InboxEntry[];
  try { runs = deps.runs(); } catch (error) { problems.push(`the runs could not be read: ${message(error)}`); return { advanced, problems }; }
  try { inbox = deps.readInbox(project); } catch (error) { problems.push(`the inbox could not be read: ${message(error)}`); return { advanced, problems }; }

  const due: { proposal: StoredProposal; subsetRun: string; plan: Record<string, unknown> }[] = [];
  for (const proposal of proposals) {
    if (proposal.full !== null) continue;
    const state = proposalStatus(proposal, runs, { readReport: deps.readReport, thresholds: deps.thresholds, inbox });
    if (state.status !== "subset-run" || state.promising !== true) continue;
    const subset = proposalRuns(proposal.id, runs).subset!;
    try {
      const subsetPlan = deps.readPlan(subset.dir);
      if (subsetPlan === null) throw new Error(`the plan of subset run ${subset.id} could not be read`);
      const plan = fullSetPlan(subsetPlan);
      // An adopted entry was checked when it was added; only a new one is checked here.
      if (!inbox.some((candidate) => isFullSetOf(candidate.plan, plan))) deps.check(project, plan);
      due.push({ proposal, subsetRun: subset.id, plan });
    } catch (error) {
      problems.push(`proposal ${proposal.id}: ${message(error)}`);
    }
  }
  if (due.length === 0) return { advanced, problems };

  try {
    await withLock(join(experimentsRoot(project), "proposals"), async () => {
      for (const { proposal, subsetRun, plan } of due) {
        try {
          // Re-read inside the lock: another advance may have recommended it since.
          const raw = JSON.parse(readFileSync(proposal.path, "utf8")) as Record<string, unknown>;
          if (raw.full !== undefined && raw.full !== null) continue;
          let entry = deps.readInbox(project).find((candidate) => isFullSetOf(candidate.plan, plan)) ?? null;
          if (entry === null) {
            entry = await deps.addEntry(project, {
              plan,
              recommendedBy: { kind: "agent", name: "improver" },
              reason: `${proposal.goal} proposal ${proposal.id}: full-set run, the subset run ${subsetRun} was promising`,
            }, deps.now());
          }
          writeAtomic(proposal.path, `${JSON.stringify({ ...raw, full: { entry: entry.id, at: deps.now(), subsetRun } }, null, 2)}\n`);
          advanced.push(proposal.id);
        } catch (error) {
          problems.push(`proposal ${proposal.id}: ${message(error)}`);
        }
      }
    });
  } catch (error) {
    problems.push(message(error));
  }
  return { advanced, problems };
}

export interface ProposalRowView {
  id: string;
  run: string;
  goal: GuardrailGoal;
  kind: StoredProposal["kind"];
  status: ProposalStatus;
  verdict: ProposalState["verdict"];
  reason: string | null;
  createdAt: string;
  runs: { subset: string | null; full: string | null };
  rationale?: string;
  answers?: { knob: string; target: string; change: string }[];
}

/** A proposal as a page shows it: never its content, overlay or lineup, which name host paths and prompt text. */
export function proposalView(stored: StoredProposal, status: ProposalState, details: boolean): ProposalRowView {
  return {
    id: stored.id, run: stored.run, goal: stored.goal, kind: stored.kind,
    status: status.status, verdict: status.verdict, reason: status.reason, createdAt: stored.createdAt, runs: status.runs,
    ...(details ? { rationale: stored.rationale, answers: stored.answers.map((answer) => ({ knob: answer.knob, target: answer.target, change: answer.change })) } : {}),
  };
}

/** Newest first. */
export function proposalViews(rows: ProposalRowView[]): ProposalRowView[] {
  return [...rows].sort((a, b) => (b.createdAt < a.createdAt ? -1 : b.createdAt > a.createdAt ? 1 : 0));
}

/** The real readers and writers. A config that cannot load reads as the default thresholds. */
export function realProposalDeps(project: string): AdvanceDeps {
  const root = experimentsRoot(project);
  let thresholds: GuardrailThresholds;
  try { thresholds = guardrailSettings(loadProjectConfig(project)); } catch { thresholds = guardrailSettings({}); }
  return {
    runs: () => runsNewestFirst(project).runs,
    readReport: (runDir) => readJson<BacktestReport>(join(root, runDir, "report.json")),
    readPlan: (runDir) => {
      const plan = readJson<unknown>(join(root, runDir, "plan.json"));
      return isObject(plan) ? plan : null;
    },
    thresholds,
    addEntry,
    readInbox,
    check: (target, plan) => { checkStart(target, plan); },
    now: () => new Date().toISOString(),
  };
}
