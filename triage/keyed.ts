/**
 * The triager's validate and apply on a keyed tracker (felipearos/ralph#396).
 *
 * On a Linear or Jira project the triager has one job, the Slack intake: a
 * report the clerk filed is either an agent brief (`propose`) or a person's
 * (`to-person`). The model decides which, and this module acts — through the
 * `Tracker` seam, never `gh` — so the GitHub path's census, simulation and
 * frontier check do not apply: a keyed plan is one op on one issue, and its
 * writes cannot leave a backlog the frontier fails to read.
 *
 * A refused plan writes NOTHING. Everything is read and checked first.
 *
 * Every step is safe to re-run after a crash at any point, because each one
 * reads the tracker before it writes and skips what is already there:
 *   - the body edit compares the issue's body with the brief first, so a
 *     re-run after it landed makes no second edit;
 *   - the label is added only when absent, and the validator lets an issue
 *     that already carries the brief AND the label through, so a crash after
 *     the label (which makes the report look triaged) still reaches release;
 *   - the `-wip` label is removed only when carried;
 *   - the marker comment carries `opMarker("release-<attempt>")`, looked up
 *     before posting, so a re-run never posts a second one. For `to-person`,
 *     which writes no label, that comment IS the record.
 */
import type { IssueComment } from "../block-reason";
import { TrackerUnavailableError, type Tracker, type TrackerIssueDetail, type TrackerKind } from "../tracker/types";
import { formatTriageMarker, hasCurrentTriage, triageBodyHash } from "../triage-marker";
import { carriesOpMarker, opMarker } from "./body";
import { sectionIfPresent, sectionRange } from "../sections";
import {
  AGENT_PROPOSED_LABEL,
  KEYED_INTAKE_OUTCOMES,
  READY_FOR_AGENT_LABEL,
  TO_PERSON_LEAD,
  forcedToPerson,
  isUntriagedReport,
  type AppLabels,
} from "./intake";
import type { SectionHeading, TriageOp, TriagePlan } from "./plan";

export interface KeyedValidationRules {
  scopeLabel: string | null;
  /** The project's `appLabels`; null sends every propose to a person (`forcedToPerson`). */
  apps: AppLabels | null;
  loop: string | null;
  kind: TrackerKind;
  /** How the tracker spells a ticket (`AND-184`), so a refusal names it the way the operator sees it. */
  ref: (number: number) => string;
  /** Which label a propose lands with; only the idempotency check reads it. Defaults to false. */
  autoReady?: boolean;
}

export interface KeyedApplyDeps {
  tracker: Tracker;
  rules: { scopeLabel: string | null; apps: AppLabels | null; loop: string | null; autoReady: boolean };
  dryRun: boolean;
  /** The claim lease's release. Best effort: the lease has a TTL. */
  releaseLease: (unit: number) => void;
  sleep: (ms: number) => Promise<void>;
  spacingMs: number;
}

export interface KeyedApplyResult {
  outcome: "applied" | "dry-run" | "refused" | "rate-limited" | "failed";
  writes: number;
  skipped: number;
  refusals: string[];
  problem: string | null;
}

const KEYED_OUTCOMES = new Set<string>(KEYED_INTAKE_OUTCOMES);

/**
 * The sections the coder prompt and frontier read as a brief. Typed as
 * `SectionHeading`, so a heading renamed in `plan.ts` is a type error here.
 */
const BRIEF_SECTIONS: readonly SectionHeading[] = ["What to build", "Acceptance criteria", "Blocked by"];

/** An unchecked criterion, the line the coder ticks off and the frontier counts. */
const OPEN_CRITERION = /^\s*- \[ \]/m;

/** Bodies compared the way an editor round-trip leaves them. */
const normalised = (body: string): string => body.replace(/\r\n/g, "\n").trim();

/** The label a propose lands with. */
export const proposeLabel = (autoReady: boolean): string => (autoReady ? READY_FOR_AGENT_LABEL : AGENT_PROPOSED_LABEL);

const releaseOpId = (plan: TriagePlan): string => `release-${plan.attempt}`;

const carriesRelease = (comments: readonly IssueComment[], plan: TriagePlan): boolean =>
  comments.some((comment) => carriesOpMarker(comment.body, releaseOpId(plan)));

/**
 * Whether the issue already shows this plan's result, so a re-run after a
 * crash is let through to finish rather than refused as "already triaged".
 */
function carriesResult(plan: TriagePlan, op: TriageOp, issue: TrackerIssueDetail, autoReady: boolean): boolean {
  if (op.op === "propose") {
    return normalised(issue.body) === normalised(op.body) && issue.labels.includes(proposeLabel(autoReady));
  }
  return carriesRelease(issue.comments, plan);
}

/** Every rule a keyed plan breaks against the issue as read. Empty means it may be applied. */
export function validateKeyedPlan(plan: TriagePlan, issue: TrackerIssueDetail, rules: KeyedValidationRules): string[] {
  const problems: string[] = [];
  if (rules.loop !== null && plan.loop !== rules.loop) {
    problems.push(`plan.loop: "${plan.loop}" is not this loop ("${rules.loop}"); a plan writes under its own name`);
  }
  if (!KEYED_OUTCOMES.has(plan.outcome)) {
    problems.push(
      `plan.outcome: "${plan.outcome}" is not a keyed outcome; on a ${rules.kind} tracker the triager's outcomes are propose and to-person (the Slack intake)`,
    );
  }
  if (plan.ops.length !== 1) {
    problems.push(`plan.ops: has ${plan.ops.length} ops; a keyed plan is exactly one op`);
  }
  const op = plan.ops[0];
  if (op === undefined) return problems;
  if (op.op !== plan.outcome) {
    problems.push(`ops[0].op: "${op.op}" must equal plan.outcome ("${plan.outcome}")`);
  }
  if (!("issue" in op) || op.issue !== plan.unit) {
    problems.push(`ops[0].issue: must be the plan's unit ${rules.ref(plan.unit)}`);
  }
  if (op.op !== "propose" && op.op !== "to-person") return problems;

  const labels = new Set(issue.labels);
  if (issue.state !== "open") {
    problems.push(`ops[0]: ${rules.ref(issue.number)} is ${issue.state}; only an open report is triaged`);
  } else if (!isUntriagedReport(labels, rules.scopeLabel) && !carriesResult(plan, op, issue, rules.autoReady ?? false)) {
    problems.push(
      `ops[0]: ${rules.ref(issue.number)} is not an untriaged Slack report (labels: ${issue.labels.length === 0 ? "none" : issue.labels.join(", ")})`,
    );
  }

  if (op.op === "propose") {
    const reason = forcedToPerson({ labels, body: issue.body }, { scopeLabel: rules.scopeLabel, apps: rules.apps });
    if (reason !== null) {
      problems.push(`ops[0]: ${rules.ref(issue.number)} must go to a person: ${reason} Write a to-person plan with that reason.`);
    }
    for (const heading of BRIEF_SECTIONS) {
      if (sectionRange(op.body, heading) === null) problems.push(`ops[0].body: is missing the "## ${heading}" section`);
    }
    // The prompt promises at least one: a brief with no checkable criterion
    // gives the coder nothing to finish against.
    const criteria = sectionIfPresent(op.body, "Acceptance criteria");
    if (criteria !== null && !OPEN_CRITERION.test(criteria)) {
      problems.push('ops[0].body: "## Acceptance criteria" has no "- [ ]" item');
    }
  }
  return problems;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A tracker throw, classified. Not-connected propagates: the caller exits on it, not this module. */
function classifyOrRethrow(
  tracker: Tracker,
  error: unknown,
  counts: { writes: number; skipped: number },
): KeyedApplyResult {
  if (error instanceof TrackerUnavailableError) throw error;
  const limited = tracker.classifyFailure(error) !== null;
  return {
    outcome: limited ? "rate-limited" : "failed",
    writes: counts.writes,
    skipped: counts.skipped,
    refusals: [],
    problem: limited ? `the tracker is rate limited: ${messageOf(error)}` : messageOf(error),
  };
}

/** Validate, then apply a keyed plan's one op and release the claim. */
export async function applyKeyedPlan(plan: TriagePlan, deps: KeyedApplyDeps): Promise<KeyedApplyResult> {
  const { tracker, rules } = deps;
  const counts = { writes: 0, skipped: 0 };

  let issue: TrackerIssueDetail;
  try {
    issue = await tracker.issue(plan.unit);
  } catch (error) {
    return classifyOrRethrow(tracker, error, counts);
  }

  const refusals = validateKeyedPlan(plan, issue, { ...rules, kind: tracker.kind, ref: (number) => tracker.ref(number) });
  if (refusals.length > 0) return { outcome: "refused", writes: 0, skipped: 0, refusals, problem: null };

  // Narrowed by validation: exactly one op, and it is the plan's outcome.
  const op = plan.ops[0] as Extract<TriageOp, { op: "propose" | "to-person" }>;
  const label = proposeLabel(rules.autoReady);
  const wip = `${plan.loop}-wip`;
  const editsBody = op.op === "propose" && normalised(issue.body) !== normalised(op.body);
  const addsLabel = op.op === "propose" && !issue.labels.includes(label);
  const removesWip = issue.labels.includes(wip);
  const postsMarker = !carriesRelease(issue.comments, plan);

  if (deps.dryRun) {
    const writes = [editsBody, addsLabel, removesWip, postsMarker].filter(Boolean).length;
    return { outcome: "dry-run", writes, skipped: 0, refusals: [], problem: null };
  }

  // Spaced like the GitHub path: a burst of writes is what trips a throttle.
  const write = async (call: () => Promise<void>): Promise<void> => {
    if (counts.writes > 0) await deps.sleep(deps.spacingMs);
    await call();
    counts.writes += 1;
  };
  const problems: string[] = [];

  try {
    if (op.op === "propose") {
      if (editsBody) await write(() => tracker.editBody(plan.unit, op.body));
      else counts.skipped += 1;
      if (addsLabel) await write(() => tracker.addLabels(plan.unit, [label]));
      else counts.skipped += 1;
    }

    if (removesWip) {
      try {
        await write(() => tracker.removeLabels(plan.unit, [wip]));
      } catch (error) {
        if (error instanceof TrackerUnavailableError) throw error;
        // Reported rather than swallowed: a `-wip` still on the issue is a claim
        // nobody holds, and the frontier hides the ticket from every loop.
        problems.push(`could not remove ${wip} from ${tracker.ref(plan.unit)}: ${messageOf(error)}`);
      }
    }
    // Best effort, and deliberately not fatal: the lease has a TTL, where an
    // aborted release would leave the marker unwritten.
    try {
      deps.releaseLease(plan.unit);
    } catch {
      // The TTL releases it.
    }

    // The marker hashes the body AS THIS APPLY LEFT IT: hashing the report the
    // triager read would mark a decision current against text that is gone.
    const after = await tracker.issue(plan.unit);
    if (carriesRelease(after.comments, plan)) {
      counts.skipped += 1;
    } else {
      const opId = releaseOpId(plan);
      const marker = formatTriageMarker(
        { attempt: plan.attempt, outcome: plan.outcome, body: triageBodyHash(after.body) },
        { loop: plan.loop, unit: plan.unit, op: opId, labels: after.labels },
      );
      const human =
        op.op === "propose"
          ? `Triage: brief para un agente, etiquetado ${label}.`
          : `${TO_PERSON_LEAD}${op.reason}`;
      await write(() => tracker.comment(plan.unit, `${human}\n\n${marker}\n${opMarker(opId)}`));

      // A to-person report carries no outcome label, so the marker alone keeps
      // it out of the intake. A renderer that strips HTML comments (Linear's
      // markdown can) would offer it again every poll; say so, loudly.
      if (op.op === "to-person") {
        const comments = await tracker.comments(plan.unit);
        if (!hasCurrentTriage(after.body, comments)) {
          problems.push(
            `the tracker did not keep the triage marker on ${tracker.ref(plan.unit)}; the report will be offered for triage again every poll`,
          );
        }
      }
    }
  } catch (error) {
    return classifyOrRethrow(tracker, error, counts);
  }

  return {
    outcome: "applied",
    writes: counts.writes,
    skipped: counts.skipped,
    refusals: [],
    problem: problems.length === 0 ? null : problems.join("; "),
  };
}
