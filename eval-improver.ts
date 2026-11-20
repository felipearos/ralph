/**
 * The improver (#873): one model session, started on a finished eval run,
 * that reads what the run showed and proposes one change — a prompt overlay
 * or a lineup — for the operator to try in a new run.
 *
 * This module is its library: what it may read, what it is asked, how its
 * answer is checked, and which cases the recommended run takes. It reads no
 * file and starts nothing; the CLI on top does both.
 *
 * The overfitting guard lives in `improverInput`. A proposal tuned on the
 * held-out tests, an operator's check or notes, or the reference diff would
 * be fitted to the grading rather than to the tickets, and the next run's
 * pass rate would prove nothing. So the input is an explicit projection,
 * field by field: a field added to a case or a row later stays out until
 * someone adds it here on purpose.
 */
import { basename } from "node:path";

import type { ArmConfig } from "./backtest";
import type { TrialOutcome, TrialRow } from "./backtest-report";
import type { Analysis, Improvement } from "./eval-analyst";
import type { RunGrades } from "./eval-grade";
import { withoutGraded, type EvalCase } from "./evals-set";
import { RUNNERS, STAGES, type Runner, type Stage } from "./models";
import { isPromptFile } from "./prompt-overlay";
import type { TrialReview } from "./trial-review";

export type Goal = "quality" | "cost";
export const GOALS: readonly Goal[] = ["quality", "cost"];

/** What the caller has already read off disk for one finished run. Report scores are not here: they carry held-out results. */
export interface ImproverRun {
  id: string;
  analysis: Analysis;
  arms: ArmConfig[];
  rows: TrialRow[];
  patches: { ticket: string; arm: string; diff: string }[];
  logs: { ticket: string; arm: string; text: string }[];
  /** First-repeat review summaries, as `summarizeReview` reads them off `<trial>/result.json`. */
  reviews?: { ticket: string; arm: string; review: TrialReview }[];
  /** The current text of the harness prompt files the analyst's prompt improvements target, by harness path. */
  prompts?: Record<string, string>;
}

/** One stage of the live lineup, as the improver is shown it. */
export interface LineupStage { runner: string; model: string; effort?: string }

export interface ImproverInput {
  run: string;
  improvements: Improvement[];
  arms: { name: string; lineup: string; overlay: string | null }[];
  trials: {
    ticket: string; arm: string; outcome: TrialOutcome; gates: { name: string; conclusion: string }[] | null;
    reviewRounds: number | null; reviewThreads: number | null;
  }[];
  patches: { ticket: string; arm: string; diff: string }[];
  logs: { ticket: string; arm: string; text: string }[];
  /** Review threads of first trials: what the reviewer raised and how the iteration answered, never where. */
  threads: { ticket: string; arm: string; threads: { title: string; priority: string | null; answer: string }[] }[];
  /** What the total cap dropped, so the improver knows the run showed more than it read. */
  omitted: { patches: number; logs: number; threads: number };
  cases: { id: string; tags: string[]; ticket: { ref: string; title: string; body: string } }[];
  /** The live `default` lineup, dotted stage names flattened: what a lineup proposal changes. */
  lineup: Record<string, LineupStage>;
  /** Whole current prompt files an overlay may replace; never cut, since an overlay is written back whole. */
  prompts: Record<string, string>;
}

/** Past this a patch or log is cut: the improver needs what went wrong, not a whole session twice. */
export const INPUT_TEXT_CAP = 20_000;
/** Past this, across all patches, logs and threads, the rest is dropped: a large run must not overflow the session. */
export const INPUT_TOTAL_CAP = 300_000;
const TRUNCATED = "\n… (truncated)";
const TRUNCATED_HEAD = "(truncated) …\n";

/** A patch keeps its head: the files it starts with say what it touched. */
const head = (text: string): string => (text.length > INPUT_TEXT_CAP ? `${text.slice(0, INPUT_TEXT_CAP)}${TRUNCATED}` : text);
/** A log keeps its tail: a session that went wrong shows it at the end. */
const tail = (text: string): string => (text.length > INPUT_TEXT_CAP ? `${TRUNCATED_HEAD}${text.slice(-INPUT_TEXT_CAP)}` : text);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The live lineup the improver may change: the top-level `default` block of
 * models.json, a nested review group flattened to `review.<axis>`. Anything
 * that is not a stage with a runner and a model is left out.
 */
export function liveLineup(config: Record<string, unknown>): Record<string, LineupStage> {
  const base = isRecord(config.default) ? config.default : {};
  const out: Record<string, LineupStage> = {};
  const add = (name: string, value: unknown): void => {
    if (!isRecord(value) || typeof value.runner !== "string" || typeof value.model !== "string") return;
    out[name] = typeof value.effort === "string" ? { runner: value.runner, model: value.model, effort: value.effort } : { runner: value.runner, model: value.model };
  };
  for (const [name, value] of Object.entries(base)) {
    if (name.startsWith("$") || !isRecord(value)) continue;
    if (typeof value.model === "string") add(name, value);
    else for (const [leaf, stage] of Object.entries(value)) add(`${name}.${leaf}`, stage);
  }
  return out;
}

/** The reference arm: the change that actually merged. Its diff is the answer, never an input. */
const REFERENCE_ARM = "a";

/**
 * Everything the improver may see of a run, and nothing else. Throws on a run
 * without an analysis: the proposal must answer an analyst improvement, and
 * the caller refuses before it spends a model call.
 */
export function improverInput(run: ImproverRun, cases: EvalCase[], lineup: Record<string, LineupStage>): ImproverInput {
  if (run.analysis.status !== "ok") throw new Error(`improver: run ${run.id} has no analysis (${run.analysis.reason})`);
  const arms = run.arms.filter((arm) => arm.name !== REFERENCE_ARM);
  const armNames = new Set(arms.map((arm) => arm.name));
  const firsts = run.rows.filter((row) => row.repeat === undefined);
  const tickets = new Set(run.rows.map((row) => row.ticket));
  const own = (entry: { ticket: string; arm: string }): boolean => armNames.has(entry.arm) && tickets.has(entry.ticket);
  // One budget across patches, then logs, then threads, in row order: once spent, the rest is counted, not sent.
  let budget = INPUT_TOTAL_CAP;
  const omitted = { patches: 0, logs: 0, threads: 0 };
  const fits = (size: number, kind: keyof typeof omitted): boolean => {
    if (size > budget) { omitted[kind] += 1; budget = 0; return false; }
    budget -= size;
    return true;
  };
  const patches: ImproverInput["patches"] = [];
  for (const patch of run.patches.filter(own)) {
    const diff = head(patch.diff);
    if (fits(diff.length, "patches")) patches.push({ ticket: patch.ticket, arm: patch.arm, diff });
  }
  const logs: ImproverInput["logs"] = [];
  for (const log of run.logs.filter(own)) {
    const text = tail(log.text);
    if (fits(text.length, "logs")) logs.push({ ticket: log.ticket, arm: log.arm, text });
  }
  const threads: ImproverInput["threads"] = [];
  for (const entry of (run.reviews ?? []).filter(own)) {
    // Title, priority and answer only: a thread's path, line, head and reply body stay out.
    const list = entry.review.threads.map((thread) => ({ title: thread.title, priority: thread.priority, answer: thread.answer }));
    if (list.length === 0) continue;
    const size = list.reduce((sum, thread) => sum + thread.title.length + 32, 0);
    if (fits(size, "threads")) threads.push({ ticket: entry.ticket, arm: entry.arm, threads: list });
  }
  // The files an analyst prompt improvement targets, whole: an overlay replaces a file, so it must start from all of it.
  const targets = new Set(run.analysis.improvements.filter((entry) => entry.knob === "prompt" && isPromptFile(entry.target)).map((entry) => entry.target));
  const prompts: Record<string, string> = {};
  for (const [path, text] of Object.entries(run.prompts ?? {})) if (targets.has(path)) prompts[path] = text;
  return {
    run: run.id,
    improvements: run.analysis.improvements.map((entry) => ({
      knob: entry.knob, target: entry.target, change: entry.change, arm: entry.arm, evidence: [...entry.evidence],
    })),
    // The overlay's directory is a host path; its name is all the improver needs to tell arms apart.
    arms: arms.map((arm) => ({ name: arm.name, lineup: arm.lineup, overlay: arm.overlay === null ? null : basename(arm.overlay) })),
    // The reference arm's trial is the merged change: its outcome is the answer key, so it stays out here too.
    trials: firsts.filter((row) => row.arm !== REFERENCE_ARM).map((row) => ({
      ticket: row.ticket, arm: row.arm, outcome: row.outcome,
      gates: row.gates === null ? null : row.gates.map((gate) => ({ name: gate.name, conclusion: gate.conclusion })),
      reviewRounds: row.reviewRounds, reviewThreads: row.reviewThreads,
    })),
    patches,
    logs,
    threads,
    omitted,
    cases: cases.filter((c) => tickets.has(c.id)).map((c) => {
      // withoutGraded drops heldOut, notes and check; reason, prs, comments and the rest are dropped by naming only these.
      const open = withoutGraded(c);
      return { id: open.id, tags: [...open.tags], ticket: { ref: open.ticket.ref, title: open.ticket.title, body: open.ticket.body } };
    }),
    lineup: { ...lineup },
    prompts,
  };
}

const GOAL_TEXT: Record<Goal, string> = {
  quality: "Raise quality: more cases end in a green PR, with fewer review rounds and fewer review findings.",
  cost: "Lower cost at the same quality: spend less usage for the same results, for example by moving a lineup stage to a cheaper model where the run shows it held up.",
};

/** The improver's whole prompt: its goal, the allowed input as JSON, and the one answer shape it may give. */
export function improverPrompt(input: ImproverInput, goal: Goal): string {
  // Only the stages the live lineup has: a stage it lacks would be a new seat, not a change to one.
  const stages = Object.keys(input.lineup).filter((stage) => (STAGES as readonly string[]).includes(stage));
  return [
    "You are the improver of an evaluation run. Several arms — each a model lineup and, optionally, replacement",
    "prompt files for the coding harness — worked the same cases. An analyst has read the run and listed",
    "improvements. Propose exactly ONE change for the next run to try.",
    "",
    `Goal: ${GOAL_TEXT[goal]}`,
    "",
    "Your change must answer at least one of the analyst's improvements; cite them by their 0-based index in",
    "`improvements`. Prefer one concrete change the evidence supports over a broad rewrite.",
    "",
    "# Run",
    "",
    "```json",
    JSON.stringify(input, null, 2),
    "```",
    "",
    "# Answer",
    "",
    "Answer with exactly one JSON object and no other text:",
    "",
    `{"kind": "prompt-overlay" | "lineup", "content": <see below>, "rationale": "<why this change, citing the improvements>", "answers": [<improvement index>]}`,
    "",
    "- prompt-overlay: `content` is `{\"files\": {\"<path>\": \"<the full new text of the file>\"}}`. Every path is a",
    "  harness prompt file: `prompt.md`, `coder.md`, `inspector.md` or `prompts/<name>.md`. Nothing else may be replaced.",
    "  Each file's text is the FULL new text of that file, which replaces it whole. Start from its current text in",
    "  `prompts` when given, change only what the cited improvement asks, and keep every `{{…}}` placeholder and",
    "  every `<ralph>` sigil exactly as it is.",
    `- lineup: \`content\` is \`{"stages": {"<stage>": {"model": "<model id>", "runner": "<${RUNNERS.join("|")}>"}}}\`; the runner is`,
    "  optional and, when left out, stays the stage's current one in `lineup`. A stage moved to another runner keeps",
    `  only its runner and model. Stages: ${stages.join(", ")}.`,
  ].join("\n");
}

export type ProposalKind = "prompt-overlay" | "lineup";
export interface OverlayContent { files: Record<string, string> }
export interface LineupContent { stages: Partial<Record<Stage, { model: string; runner?: Runner }>> }

export type Proposal = { goal: Goal; kind: ProposalKind; content: OverlayContent | LineupContent; rationale: string; answers: Improvement[] };

/** A model's JSON: a fenced block, an object inside prose, or the whole text — as the analyst and judges read theirs. */
function jsonIn(text: string): unknown {
  const tries: string[] = [];
  const fence = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/.exec(text);
  if (fence) tries.push(fence[1]!);
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open !== -1 && close > open) tries.push(text.slice(open, close + 1));
  tries.push(text);
  for (const attempt of tries) {
    try { return JSON.parse(attempt); } catch { /* the next */ }
  }
  return undefined;
}

function overlayContent(content: unknown): { ok: true; content: OverlayContent } | { ok: false; reason: string } {
  if (!isRecord(content) || !isRecord(content.files)) return { ok: false, reason: "the overlay has no files object" };
  const entries = Object.entries(content.files);
  if (entries.length === 0) return { ok: false, reason: "the overlay replaces no file" };
  const files: Record<string, string> = {};
  for (const [path, text] of entries) {
    // Checked before the prompt-file rule: the pattern alone would let `prompts/..md` through.
    if (path.startsWith("/") || path.startsWith("\\") || path.includes("..")) return { ok: false, reason: `overlay path ${path} leaves the harness` };
    if (!isPromptFile(path)) return { ok: false, reason: `${path} is not a prompt file (prompt.md, coder.md, inspector.md or prompts/*.md)` };
    if (typeof text !== "string") return { ok: false, reason: `overlay file ${path} is not text` };
    files[path] = text;
  }
  return { ok: true, content: { files } };
}

function lineupContent(content: unknown): { ok: true; content: LineupContent } | { ok: false; reason: string } {
  if (!isRecord(content) || !isRecord(content.stages)) return { ok: false, reason: "the lineup has no stages object" };
  const entries = Object.entries(content.stages);
  if (entries.length === 0) return { ok: false, reason: "the lineup changes no stage" };
  const stages: LineupContent["stages"] = {};
  for (const [stage, value] of entries) {
    if (!(STAGES as readonly string[]).includes(stage)) return { ok: false, reason: `stage ${stage} is not one of ${STAGES.join(", ")}` };
    if (!isRecord(value) || typeof value.model !== "string" || value.model.trim() === "") return { ok: false, reason: `stage ${stage} names no model` };
    if (value.runner !== undefined && (typeof value.runner !== "string" || !(RUNNERS as readonly string[]).includes(value.runner))) {
      return { ok: false, reason: `stage ${stage} runner ${String(value.runner)} is not one of ${RUNNERS.join(", ")}` };
    }
    stages[stage as Stage] = value.runner === undefined ? { model: value.model } : { model: value.model, runner: value.runner as Runner };
  }
  return { ok: true, content: { stages } };
}

/** The improver's answer, checked strictly: a proposal that breaks a rule is refused with why, never repaired. */
export function parseProposal(text: string, goal: Goal, improvements: Improvement[]): { ok: true; proposal: Proposal } | { ok: false; reason: string } {
  const doc = jsonIn(text);
  if (!isRecord(doc)) return { ok: false, reason: "the improver answered with no JSON object" };
  if (doc.kind !== "prompt-overlay" && doc.kind !== "lineup") return { ok: false, reason: `kind ${String(doc.kind)} is not prompt-overlay or lineup` };
  if (typeof doc.rationale !== "string" || doc.rationale.trim() === "") return { ok: false, reason: "the proposal has no rationale" };
  if (!Array.isArray(doc.answers) || doc.answers.length === 0) return { ok: false, reason: "the proposal answers no analyst improvement" };
  const answers: Improvement[] = [];
  for (const index of doc.answers) {
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= improvements.length) {
      return { ok: false, reason: `answer ${String(index)} is not an analyst improvement (0 to ${improvements.length - 1})` };
    }
    const improvement = improvements[index]!;
    if (!answers.includes(improvement)) answers.push(improvement);
  }
  const content = doc.kind === "prompt-overlay" ? overlayContent(doc.content) : lineupContent(doc.content);
  if (!content.ok) return content;
  return { ok: true, proposal: { goal, kind: doc.kind, content: content.content, rationale: doc.rationale, answers } };
}

export interface SubsetSettings { size: number; failed: boolean }
export const DEFAULT_SUBSET: SubsetSettings = { size: 12, failed: true };

/** The project's `evalsImprover` with the defaults filled: how many cases the recommended run takes, and whether it includes the source run's failures. */
export function improverSettings(config: { evalsImprover?: { size?: number; failed?: boolean } }): SubsetSettings {
  return { size: config.evalsImprover?.size ?? DEFAULT_SUBSET.size, failed: config.evalsImprover?.failed ?? DEFAULT_SUBSET.failed };
}

/**
 * The project's `evalsImprover.autoMerge`, off when absent (#875). Only
 * reported for now: no merge path exists, so a person merges every PR the
 * improver opens until a later ticket wires the switch.
 */
export function improverAutoMerge(config: { evalsImprover?: { autoMerge?: boolean } }): boolean {
  return config.evalsImprover?.autoMerge ?? false;
}

/**
 * The recommended run's cases: the cases the cited improvements rest on
 * first, so the size cap never drops them; then the source run's failures
 * when `settings.failed` includes them; then the active cases that share a
 * tag with a cited one, in id order. A retired case is never chosen.
 */
export function subsetCases(cases: EvalCase[], cited: string[], failed: string[], settings: SubsetSettings): string[] {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const chosen: string[] = [];
  const take = (id: string): void => {
    const c = byId.get(id);
    if (c === undefined || c.status === "retired" || chosen.includes(id)) return;
    chosen.push(id);
  };
  cited.forEach(take);
  if (settings.failed) failed.forEach(take);
  const tags = new Set(cited.flatMap((id) => byId.get(id)?.tags ?? []));
  cases.filter((c) => c.tags.some((tag) => tags.has(tag))).map((c) => c.id).sort().forEach(take);
  return chosen.slice(0, Math.max(0, settings.size));
}

const FAILING: ReadonlySet<TrialOutcome> = new Set(["failed", "timed-out", "refused"]);

/**
 * The cases the run failed: an arm's objective grade said fail, or, on a case
 * no grade decides (none, or still pending), a first trial ended failed,
 * timed out or refused. A trial that never ran is the harness failing, not
 * the arm, so `not-run` never counts.
 */
export function failedCases(rows: TrialRow[], grades: RunGrades | null): string[] {
  const graded = new Map((grades?.cases ?? []).map((entry) => [entry.case, entry.arms]));
  const out: string[] = [];
  for (const ticket of new Set(rows.map((row) => row.ticket))) {
    const arms = graded.get(ticket) ?? [];
    const decided = arms.some((arm) => arm.objective === "pass" || arm.objective === "fail");
    const failed = decided
      ? arms.some((arm) => arm.objective === "fail")
      : rows.some((row) => row.ticket === ticket && row.repeat === undefined && FAILING.has(row.outcome));
    if (failed) out.push(ticket);
  }
  return out;
}
