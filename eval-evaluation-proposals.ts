/**
 * Proposals that change the evaluation itself (#878): a new judge or analyst
 * prompt, a new test-set case, an operator check for a case, or a suggestion
 * to retire a saturated case.
 *
 * Pure on purpose: it parses a proposal's content strictly, guards a test-set
 * proposal against the current set, and reaches the verdict on a prompt
 * proposal from evidence the caller already read. It reads no disk and spawns
 * nothing, so the improver, the proposals CLI and the PR path share one rule.
 *
 * A prompt proposal passes only on judge accuracy against the operators'
 * calibration verdicts: a prompt that merely raises scores would let the
 * evaluation grade itself kinder, so scores are reported and never a pass.
 */
import type { CheckOutcome, HeldOut, TicketScore } from "./backtest-score";
import { judgeAccuracy, type AccuracyTally, type CalibratedCase } from "./eval-judge-accuracy";
import type { GuardrailCondition } from "./eval-guardrails";
import type { Axis } from "./eval-panel";
import type { EvalCase } from "./evals-set";

export const EVALUATION_KINDS = ["judge-prompt", "analyst-prompt", "case", "check", "retire-suggestion"] as const;
export type EvaluationKind = (typeof EVALUATION_KINDS)[number];

export const PROMPT_KINDS = ["judge-prompt", "analyst-prompt"] as const;
export type PromptKind = (typeof PROMPT_KINDS)[number];

export const TEST_SET_KINDS = ["case", "check", "retire-suggestion"] as const;
export type TestSetKind = (typeof TEST_SET_KINDS)[number];

export const isPromptKind = (kind: unknown): kind is PromptKind => (PROMPT_KINDS as readonly unknown[]).includes(kind);
export const isTestSetKind = (kind: unknown): kind is TestSetKind => (TEST_SET_KINDS as readonly unknown[]).includes(kind);

/** The replacement instructions of the judge panel's or the analyst's prompt: the opening paragraph(s), not the whole prompt. */
export interface PromptContent { instructions: string }
export interface CaseContent { repo: string; prs: number[]; reason: string; tags?: string[]; ticket?: string }
/**
 * A test file only: a command check would be a model-written shell command
 * that runs on the host after one Confirm click, possibly relayed from the
 * remote page. A command check is an operator's, through `evals-set.ts check`.
 */
export interface CheckContent { case: string; test: string }
export interface RetireContent { case: string; reason: string }

export type EvaluationContent = PromptContent | CaseContent | CheckContent | RetireContent;
export type ContentOf<K extends EvaluationKind> =
  K extends PromptKind ? PromptContent : K extends "case" ? CaseContent : K extends "check" ? CheckContent : RetireContent;

type Parsed<T> = { ok: true; content: T } | { ok: false; reason: string };

/**
 * Fields a case holds that only an operator sets: the graded-only ones would
 * let a proposal write its own answer key, and `status`/`id` would edit or
 * retire a case by the back door. Named apart from an unknown key so the
 * refusal says why.
 */
const OPERATOR_ONLY = ["heldOut", "notes", "check", "calibration", "status", "id"] as const;

const ALLOWED: Record<EvaluationKind, readonly string[]> = {
  "judge-prompt": ["instructions"],
  "analyst-prompt": ["instructions"],
  case: ["repo", "prs", "reason", "tags", "ticket"],
  check: ["case", "test"],
  "retire-suggestion": ["case", "reason"],
};

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** The first key outside the kind's allowed set, worded for the refusal; null when every key is allowed. */
function strayKey(kind: EvaluationKind, content: Record<string, unknown>): string | null {
  for (const key of Object.keys(content)) {
    if (ALLOWED[kind].includes(key)) continue;
    if ((OPERATOR_ONLY as readonly string[]).includes(key)) {
      return isTestSetKind(kind)
        ? `a test-set proposal may only add; it may not set ${key}`
        : `a ${kind} proposal may not set ${key}`;
    }
    return `a ${kind} proposal has an unknown key ${key}`;
  }
  return null;
}

function caseRef(content: Record<string, unknown>, kind: TestSetKind): Parsed<string> {
  if (!nonEmpty(content.case)) return { ok: false, reason: `the ${kind} proposal names no case` };
  if (!ID.test(content.case)) return { ok: false, reason: `case ${content.case} is not a case id` };
  return { ok: true, content: content.case };
}

/** A proposal's content, checked strictly: one that breaks a rule is refused with why, never repaired. */
export function evaluationContent<K extends EvaluationKind>(kind: K, content: unknown): Parsed<ContentOf<K>>;
export function evaluationContent(kind: EvaluationKind, content: unknown): Parsed<EvaluationContent> {
  if (!isRecord(content)) return { ok: false, reason: `the ${kind} proposal's content is not an object` };
  if (kind === "check" && content.command !== undefined) return { ok: false, reason: "an improver's check may only name a test file; a command check is an operator's" };
  const stray = strayKey(kind, content);
  if (stray !== null) return { ok: false, reason: stray };

  if (isPromptKind(kind)) {
    if (!nonEmpty(content.instructions)) return { ok: false, reason: `the ${kind} proposal has no instructions` };
    return { ok: true, content: { instructions: content.instructions } };
  }

  if (kind === "case") {
    if (typeof content.repo !== "string" || !REPO.test(content.repo)) return { ok: false, reason: `repo ${String(content.repo)} is not owner/name` };
    if (!Array.isArray(content.prs) || content.prs.length === 0) return { ok: false, reason: "the case proposal names no PR" };
    const prs: number[] = [];
    for (const pr of content.prs) {
      if (typeof pr !== "number" || !Number.isSafeInteger(pr) || pr <= 0) return { ok: false, reason: `PR ${String(pr)} is not a positive PR number` };
      if (!prs.includes(pr)) prs.push(pr);
    }
    if (!nonEmpty(content.reason)) return { ok: false, reason: "the case proposal gives no reason" };
    let tags: string[] | undefined;
    if (content.tags !== undefined) {
      if (!Array.isArray(content.tags) || !content.tags.every(nonEmpty)) return { ok: false, reason: "the case proposal's tags are not non-empty strings" };
      tags = [...(content.tags as string[])];
    }
    if (content.ticket !== undefined && !nonEmpty(content.ticket)) return { ok: false, reason: "the case proposal's ticket is not a non-empty string" };
    return {
      ok: true,
      content: {
        repo: content.repo, prs, reason: content.reason,
        ...(tags !== undefined ? { tags } : {}), ...(content.ticket !== undefined ? { ticket: content.ticket as string } : {}),
      },
    };
  }

  const ref = caseRef(content, kind);
  if (!ref.ok) return ref;

  if (kind === "check") {
    if (!nonEmpty(content.test)) return { ok: false, reason: "the check proposal names no test file" };
    // The stored check's own rule (parseOperatorCheck): a test outside the case's repo would run something the case never held.
    if (content.test.startsWith("/") || content.test.split(/[\\/]/).includes("..")) return { ok: false, reason: `test ${content.test} is not a relative path with no .. segment` };
    return { ok: true, content: { case: ref.content, test: content.test } };
  }

  if (!nonEmpty(content.reason)) return { ok: false, reason: "the retire suggestion gives no reason" };
  return { ok: true, content: { case: ref.content, reason: content.reason } };
}

/**
 * The "only add or suggest retiring" guard against the current set: null when
 * the proposal is acceptable as a suggestion. A check's fail-on-base and
 * pass-on-reference proof is not here; it runs when the operator confirms,
 * through `evals-set.ts check` (see checkAcceptance).
 */
export function testSetRefusal(kind: TestSetKind, content: CaseContent | CheckContent | RetireContent, cases: readonly EvalCase[], saturated: ReadonlySet<string>): string | null {
  if (kind === "case") {
    const proposed = content as CaseContent;
    // GitHub repo names are case-insensitive, so `Org/Repo` and `org/repo` hold the same PR.
    const repo = proposed.repo.toLowerCase();
    for (const existing of cases) {
      if (existing.repo.toLowerCase() !== repo) continue;
      const held = proposed.prs.find((pr) => existing.prs.some((p) => p.number === pr));
      if (held !== undefined) return `would edit case ${existing.id}, which already holds ${existing.repo}#${held}`;
    }
    return null;
  }
  const id = (content as CheckContent | RetireContent).case;
  const found = cases.find((c) => c.id === id);
  if (found === undefined) return `no case ${id} in the set`;
  if (found.status === "retired") return `case ${id} is already retired`;
  if (kind === "check") {
    if (found.check !== undefined) return `would replace case ${id}'s check; a proposal may only add`;
    return null;
  }
  if (!saturated.has(id)) return `case ${id} is not saturated`;
  return null;
}

/**
 * Whether a verified check may be stored, the one rule `evals-set.ts check`
 * applies to every check, an operator's or an improver's suggested one: base
 * first (a check that cannot run on the base says nothing about the reference
 * either). `at` carries the shas the refusal names, shortened.
 */
export function checkAcceptance(verified: { base: CheckOutcome; reference: CheckOutcome }, at?: { base: string; reference: string }): string | null {
  const { base, reference } = verified;
  const short = (sha: string): string => sha.slice(0, 7);
  if (base.result === "error") return `the check cannot run on the base: ${base.why}`;
  if (reference.result === "error") return `the check cannot run on the reference: ${reference.why}`;
  if (base.result === "pass") return `the check passes on the base${at ? ` (${short(at.base)})` : ""}; it must fail there`;
  if (reference.result === "fail") return `the check fails on the reference${at ? ` (${short(at.reference)})` : ""}; it must pass there`;
  return null;
}

export interface PromptEvidence {
  accuracy: AccuracyTally;
  axes: Record<Axis, AccuracyTally>;
  /** `<ticket>/<arm>` → the arm's objective outcome: held-out tests and operator check. */
  objectives: Record<string, string>;
  /** Mean of every ok judge's axis scores; reported only, never a pass condition. */
  meanScore: number | null;
  cases: number;
  /**
   * The calibration verdicts the accuracy counted (`case/axis/arm|arm`, sorted):
   * a prompt that contests or abstains on the verdicts it would get wrong drops
   * them from the denominator, so accuracy compares only on the same ones.
   */
  checked: string[];
}

/** A stable string of a held-out outcome: the file results sorted, so the same outcome always reads the same. */
function heldOutLabel(heldOut: HeldOut | null): string {
  if (heldOut === null) return "held-out none";
  if (heldOut.status !== "ok") return `held-out ${heldOut.status}`;
  const files = heldOut.files.map((file) => `${file.path}=${file.result}`).sort();
  return `held-out ok ${files.join(",")}`;
}

// The error's why is left out: a rerun's wording may differ while the outcome does not.
const checkLabel = (check: CheckOutcome | undefined): string => (check === undefined ? "" : `; check ${check.result}`);

/** What a run under one prompt shows: its judge accuracy, its arms' objective outcomes and, for the report, its mean score. */
export function promptEvidence(scores: readonly TicketScore[], cases: readonly CalibratedCase[]): PromptEvidence {
  const accuracy = judgeAccuracy(scores, cases);
  const objectives: Record<string, string> = {};
  const tickets = new Set<string>();
  let sum = 0;
  let count = 0;
  for (const score of scores) {
    // First trials only, as judgeAccuracy reads them: repeats are a run's own evidence.
    if (!isRecord(score) || score.repeat !== undefined || typeof score.ticket !== "string") continue;
    if (tickets.has(score.ticket)) continue;
    tickets.add(score.ticket);
    for (const arm of Array.isArray(score.arms) ? score.arms : []) {
      if (!isRecord(arm) || typeof arm.arm !== "string") continue;
      objectives[`${score.ticket}/${arm.arm}`] = `${heldOutLabel(arm.heldOut ?? null)}${checkLabel(arm.check)}`;
    }
    const verdicts = isRecord(score.panel) && Array.isArray(score.panel.verdicts) ? score.panel.verdicts : [];
    for (const verdict of verdicts) {
      if (!isRecord(verdict) || verdict.status !== "ok" || !isRecord(verdict.arms)) continue;
      for (const entry of Object.values(verdict.arms)) {
        if (!isRecord(entry) || !isRecord(entry.axes)) continue;
        for (const axis of Object.values(entry.axes)) {
          if (isRecord(axis) && typeof axis.score === "number" && Number.isFinite(axis.score)) {
            sum += axis.score;
            count += 1;
          }
        }
      }
    }
  }
  // judgeAccuracy's tally counts exactly the non-contested checks; unjudged verdicts are never checks.
  const checked = accuracy.checks.filter((check) => check.outcome !== "contested")
    .map((check) => `${check.case}/${check.axis}/${check.arms.join("|")}`).sort();
  return {
    accuracy: accuracy.overall, axes: accuracy.axes, objectives,
    meanScore: count === 0 ? null : Math.round((sum / count) * 100) / 100,
    cases: tickets.size,
    checked,
  };
}

export interface PromptProposalVerdict { pass: boolean; conditions: GuardrailCondition[]; current: PromptEvidence; proposed: PromptEvidence }

const accuracyText = (value: number | null): string => (value === null ? "none" : String(value));

/** A prompt proposal passes only when it agrees with the operators more often and changes no arm's objective outcome. */
export function promptProposalVerdict(current: PromptEvidence, proposed: PromptEvidence): PromptProposalVerdict {
  const conditions: GuardrailCondition[] = [];

  conditions.push(current.accuracy.total > 0
    ? { id: "calibrated", pass: true, reason: `${current.accuracy.total} calibration verdict(s) to measure against` }
    : { id: "calibrated", pass: false, reason: "no calibration verdict to measure judge accuracy against" });

  const same = current.accuracy.total === proposed.accuracy.total
    && current.checked.length === proposed.checked.length && current.checked.every((key, index) => proposed.checked[index] === key);
  conditions.push({
    id: "same-verdicts", pass: same,
    reason: same
      ? `both prompts judged the same ${current.accuracy.total} verdict(s)`
      : `the current prompt judged ${current.accuracy.total} verdict(s), the proposed ${proposed.accuracy.total}${current.accuracy.total === proposed.accuracy.total ? " (different ones)" : ""}; accuracy compares only on the same verdicts`,
  });

  const before = current.accuracy.accuracy;
  const after = proposed.accuracy.accuracy;
  const up = before !== null && after !== null && after > before;
  conditions.push({ id: "accuracy-up", pass: up, reason: `judge accuracy ${accuracyText(before)} → ${accuracyText(after)}${up ? "" : "; it must rise"}` });

  const keys = new Set([...Object.keys(current.objectives), ...Object.keys(proposed.objectives)]);
  const changed = [...keys].sort().filter((key) => current.objectives[key] !== proposed.objectives[key]);
  conditions.push(changed.length === 0
    ? { id: "objective-unchanged", pass: true, reason: "every arm's objective outcome is unchanged" }
    : {
      id: "objective-unchanged", pass: false,
      reason: `${changed.length} arm(s) changed objective outcome: ${changed.slice(0, 3).join(", ")}${changed.length > 3 ? ", …" : ""}`,
    });

  const delta = current.meanScore === null || proposed.meanScore === null ? null : Math.round((proposed.meanScore - current.meanScore) * 100) / 100;
  conditions.push({
    id: "scores-alone", pass: true,
    reason: `mean score ${accuracyText(current.meanScore)} → ${accuracyText(proposed.meanScore)}${delta === null ? "" : ` (${delta >= 0 ? "+" : ""}${delta})`}; raising scores alone never passes`,
  });

  return { pass: conditions.every((condition) => condition.pass), conditions, current, proposed };
}
