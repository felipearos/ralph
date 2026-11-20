/**
 * The triage PLAN: what a triager intends to do, as data.
 *
 * The triager model never runs `gh issue edit` itself. It writes one of these
 * to `.ralph/logs/triage-plan-<unit>.json` and hands it to `triage-apply.ts`,
 * which is the single place triage writes are made and checked. That split is
 * the whole safety story: a plan is inspectable, refusable and replayable,
 * where a sequence of `gh` calls a model improvises is none of the three.
 *
 * This module owns the plan's SHAPE and nothing else. Whether a label exists,
 * whether the loop may touch it, whether the resulting frontier still parses —
 * those need a read of GitHub and the census, and `triage/validate.ts` and
 * `triage/simulate.ts` own them. Keeping the structural parse separate means a
 * malformed plan is refused before a single API call is spent on it.
 */
import { TRIAGE_OUTCOMES, type TriageOutcome } from "../triage-marker";

/**
 * The only headings a triager may rewrite. A plan cannot touch prose outside
 * them: the sections here are the ones the frontier and the coder prompt read
 * as structure, and everything else on an issue is the author's own words.
 */
export const SECTION_HEADINGS = [
  "Parent",
  "Blocked by",
  "Staffing group",
  "Acceptance criteria",
  "What to build",
] as const;
export type SectionHeading = (typeof SECTION_HEADINGS)[number];

/**
 * Why an issue may be closed. Both kinds carry the evidence in the data rather
 * than in prose, so the refusal for closing without it is mechanical: a
 * `done-in` names the merged PR and cites a file or test per acceptance
 * criterion, a `duplicate-of` names the issue that already covers it.
 */
export type CloseEvidence =
  | { kind: "done-in"; pr: number; criteria: { criterion: string; cite: string }[] }
  | { kind: "duplicate-of"; issue: number };

/**
 * A product decision the plan makes, and the rule it is made under.
 *
 * `rule` is a repo-relative path with an optional `#heading` fragment, e.g.
 * `CONTEXT.md#Retention`. `validate.ts` resolves it at `origin/<baseBranch>`
 * and checks `quote` appears there verbatim; a triager that cannot cite a rule
 * is deciding the product, which is not its job.
 */
export interface Decision {
  question: string;
  rule: string;
  quote: string;
}

export type TriageOp =
  | { op: "add-label"; opId: string; issue: number; label: string }
  | { op: "remove-label"; opId: string; issue: number; label: string }
  | {
      op: "set-section";
      opId: string;
      issue: number;
      heading: SectionHeading;
      mode: "replace" | "append";
      body: string;
    }
  | { op: "comment"; opId: string; issue: number; body: string; amends?: boolean }
  | { op: "create-issue"; opId: string; ref: string; title: string; body: string; labels?: string[] }
  | { op: "add-blocker"; opId: string; issue: number; blockedBy: number | string }
  | { op: "close"; opId: string; issue: number; evidence: CloseEvidence; comment?: string }
  | { op: "unblock"; opId: string; issue: number; label: string }
  /**
   * The report is agent-ready: `body` replaces the issue's body with an agent
   * brief (what to build, acceptance criteria, Blocked by), and the issue gets
   * `agent-proposed`, or `ready-for-agent` under `triage.autoReady`. A Linear
   * or Jira project's Slack intake only; the GitHub triager is refused it.
   */
  | { op: "propose"; opId: string; issue: number; body: string }
  /**
   * The report needs a person: `reason` names the agent-ready rule it failed,
   * in one Spanish line. A Linear or Jira project's Slack intake only; the
   * GitHub triager is refused it.
   */
  | { op: "to-person"; opId: string; issue: number; reason: string };

/**
 * An `add-label` whose target is an issue this plan CREATES, named by its ref.
 *
 * Not something a plan may contain: `triage/order.ts` produces it when it defers
 * a child's `ready-for-agent` past the child's creation, and `triage/apply.ts`
 * resolves the ref once the create has a number. Kept in this module so the one
 * place that defines what an op is defines this too.
 */
export interface RefLabelOp {
  op: "add-label";
  opId: string;
  ref: string;
  label: string;
}

/** What an apply executes: the plan's own ops plus the ones ordering derives. */
export type ApplyOp = TriageOp | RefLabelOp;

/**
 * The `unblock` this plan makes for `issue`, or null.
 *
 * Shared, because two modules must agree about WHICH op they are looking at:
 * `triage/validate.ts` decides whether the unblock is earned, and
 * `triage/apply.ts` stamps the rescue marker off the same op. Two lookups could
 * find two different ops in a plan that named more than one.
 */
export const unblockFor = (
  plan: TriagePlan,
  issue: number,
): Extract<TriageOp, { op: "unblock" }> | null =>
  plan.ops.find((op): op is Extract<TriageOp, { op: "unblock" }> => op.op === "unblock" && op.issue === issue) ??
  null;

/** Whether an op still names its target by a plan-local ref rather than a number. */
export const isRefLabelOp = (op: ApplyOp): op is RefLabelOp =>
  op.op === "add-label" && "ref" in op;

/**
 * Every op name, in the order the union declares them.
 *
 * `unblock` is the one op that may remove a label belonging to ANOTHER loop —
 * a coder's `<loop>-blocked`, after the triager has re-specified or re-routed
 * the ticket. It is a separate op rather than an exemption inside
 * `remove-label` precisely so that `remove-label` of a `*-blocked` stays
 * refused outright: the five preconditions in `validate.ts` are the whole
 * safety of the thing, and an exemption on the general op would be one
 * mis-written plan away from bypassing them.
 */
export const PLAN_OPS = [
  "add-label",
  "remove-label",
  "set-section",
  "comment",
  "create-issue",
  "add-blocker",
  "close",
  "unblock",
  "propose",
  "to-person",
] as const satisfies readonly TriageOp["op"][];

export interface TriagePlan {
  /** The issue the unit is named by; the plan's log and marker key off it. */
  unit: number;
  loop: string;
  /** The triage attempt this plan closes; 1 for the first. */
  attempt: number;
  outcome: TriageOutcome;
  ops: TriageOp[];
  decisions?: Decision[];
}

/**
 * Closing a duplicate carries this label. The TOOL applies it, not the plan —
 * it lives here rather than in the write engine so the rules can check it like
 * any other label without the pure side importing the IO side.
 */
export const DUPLICATE_LABEL = "duplicate";

export type ParsedPlan = { plan: TriagePlan } | { problems: string[] };

/** Ids and plan-local refs share a charset: both end up in an HTML marker. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LOOP_NAME = /^[a-z][a-z0-9]*$/;

const OUTCOMES = new Set<string>(TRIAGE_OUTCOMES);
const OP_NAMES = new Set<string>(PLAN_OPS);
const HEADINGS = new Set<string>(SECTION_HEADINGS);

const PLAN_KEYS = new Set(["unit", "loop", "attempt", "outcome", "ops", "decisions"]);

/** The keys each op may carry, so a typo'd field is a refusal and not a silent drop. */
const OP_KEYS: Record<string, readonly string[]> = {
  "add-label": ["op", "opId", "issue", "label"],
  "remove-label": ["op", "opId", "issue", "label"],
  "set-section": ["op", "opId", "issue", "heading", "mode", "body"],
  comment: ["op", "opId", "issue", "body", "amends"],
  "create-issue": ["op", "opId", "ref", "title", "body", "labels"],
  "add-blocker": ["op", "opId", "issue", "blockedBy"],
  close: ["op", "opId", "issue", "evidence", "comment"],
  unblock: ["op", "opId", "issue", "label"],
  propose: ["op", "opId", "issue", "body"],
  "to-person": ["op", "opId", "issue", "reason"],
};

/** A `to-person` reason is one line a person reads in the tracker, not an essay. */
const MAX_REASON_LENGTH = 300;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPositiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

/**
 * Structural validation of a plan's text.
 *
 * Collects EVERY problem rather than stopping at the first. A triager reading
 * one refusal at a time would spend an attempt per typo, and its attempts are
 * budgeted (`triageGaveUp` gives it two).
 */
export function parsePlan(text: string, source?: string): ParsedPlan {
  const problems: string[] = [];
  const where = (path: string, message: string): void => {
    problems.push(source === undefined ? `${path}: ${message}` : `${source}: ${path}: ${message}`);
  };

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    where("plan", `is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    return { problems };
  }
  if (!isObject(raw)) {
    where("plan", "must be a JSON object");
    return { problems };
  }

  for (const key of Object.keys(raw)) {
    if (!PLAN_KEYS.has(key)) where(key, "is not a plan field");
  }

  if (!isPositiveInt(raw.unit)) where("unit", "must be a positive integer issue number");
  if (!isNonEmptyString(raw.loop) || !LOOP_NAME.test(raw.loop)) {
    where("loop", "must be a loop name matching /^[a-z][a-z0-9]*$/");
  }
  if (!isPositiveInt(raw.attempt)) where("attempt", "must be an integer >= 1");
  if (typeof raw.outcome !== "string" || !OUTCOMES.has(raw.outcome)) {
    where("outcome", `must be one of ${TRIAGE_OUTCOMES.join(", ")}`);
  }

  const ops: TriageOp[] = [];
  const refs = new Set<string>();
  const opIds = new Set<string>();
  const blockerRefs: { path: string; ref: string }[] = [];

  if (!Array.isArray(raw.ops) || raw.ops.length === 0) {
    where("ops", "must be a non-empty array");
  } else {
    raw.ops.forEach((entry, index) => {
      const path = `ops[${index}]`;
      if (!isObject(entry)) {
        where(path, "must be an object");
        return;
      }
      const name = entry.op;
      if (typeof name !== "string" || !OP_NAMES.has(name)) {
        where(`${path}.op`, `must be one of ${PLAN_OPS.join(", ")}`);
        return;
      }
      for (const key of Object.keys(entry)) {
        if (!OP_KEYS[name]!.includes(key)) where(`${path}.${key}`, `is not a field of ${name}`);
      }
      if (!isNonEmptyString(entry.opId) || !NAME.test(entry.opId)) {
        where(`${path}.opId`, "must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/");
      } else if (opIds.has(entry.opId)) {
        where(`${path}.opId`, `repeats ${entry.opId}; op ids are the replay key and must be unique`);
      } else {
        opIds.add(entry.opId);
      }

      if (name !== "create-issue" && !isPositiveInt(entry.issue)) {
        where(`${path}.issue`, "must be a positive integer issue number");
      }

      switch (name) {
        case "add-label":
        case "remove-label":
        // Shape only. That the label is exactly one coder's `<loop>-blocked`,
        // and that the plan earned the right to remove it, is `validate.ts`'s
        // question: the parser has no roster and no ticket to ask.
        case "unblock":
          if (!isNonEmptyString(entry.label)) where(`${path}.label`, "must be a non-empty label name");
          break;
        case "set-section":
          if (typeof entry.heading !== "string" || !HEADINGS.has(entry.heading)) {
            where(`${path}.heading`, `must be one of ${SECTION_HEADINGS.join(", ")}`);
          }
          if (entry.mode !== "replace" && entry.mode !== "append") {
            where(`${path}.mode`, 'must be "replace" or "append"');
          }
          if (typeof entry.body !== "string") {
            where(`${path}.body`, "must be a string");
          } else if (entry.mode === "append" && entry.body.trim() === "") {
            where(`${path}.body`, "must be non-empty to append");
          }
          break;
        case "comment":
          if (!isNonEmptyString(entry.body)) where(`${path}.body`, "must be a non-empty string");
          // `amends` says this comment IS the change to the spec, rather than a
          // note about it. It earns an `unblock` the way a `set-section` does
          // (felipearos/ralph#150), so it is a declaration and not a guess: a
          // triager that clarifies a ticket in prose rather than by rewriting
          // its body has still re-specified it, but only it can say so.
          if (entry.amends !== undefined && typeof entry.amends !== "boolean") {
            where(`${path}.amends`, "must be a boolean when present");
          }
          break;
        case "create-issue": {
          if (!isNonEmptyString(entry.ref) || !NAME.test(entry.ref)) {
            where(`${path}.ref`, "must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/");
          } else if (/^\d+$/.test(entry.ref)) {
            where(`${path}.ref`, "must not look like an issue number");
          } else if (refs.has(entry.ref)) {
            where(`${path}.ref`, `repeats ${entry.ref}`);
          } else {
            refs.add(entry.ref);
          }
          if (!isNonEmptyString(entry.title)) where(`${path}.title`, "must be a non-empty string");
          if (!isNonEmptyString(entry.body)) where(`${path}.body`, "must be a non-empty string");
          if (entry.labels !== undefined) {
            if (!Array.isArray(entry.labels) || !entry.labels.every(isNonEmptyString)) {
              where(`${path}.labels`, "must be an array of label names");
            }
          }
          break;
        }
        case "add-blocker":
          if (typeof entry.blockedBy === "string") {
            blockerRefs.push({ path: `${path}.blockedBy`, ref: entry.blockedBy });
          } else if (!isPositiveInt(entry.blockedBy)) {
            where(`${path}.blockedBy`, "must be an issue number or a create-issue ref in this plan");
          }
          break;
        case "close":
          problems.push(...closeProblems(entry, path, source));
          if (entry.comment !== undefined && !isNonEmptyString(entry.comment)) {
            where(`${path}.comment`, "must be a non-empty string when present");
          }
          break;
        case "propose":
          if (!isNonEmptyString(entry.body)) where(`${path}.body`, "must be a non-empty string");
          break;
        case "to-person":
          if (!isNonEmptyString(entry.reason)) {
            where(`${path}.reason`, "must be a non-empty string");
          } else if (/[\r\n]/.test(entry.reason)) {
            where(`${path}.reason`, "must be one line");
          } else if (entry.reason.length > MAX_REASON_LENGTH) {
            where(`${path}.reason`, `must be at most ${MAX_REASON_LENGTH} characters`);
          }
          break;
      }
      ops.push(entry as unknown as TriageOp);
    });
  }

  // Checked after the fold, because a ref may be created by a LATER op than the
  // one naming it: ordering is `triage/order.ts`'s problem, not the parser's.
  for (const { path, ref } of blockerRefs) {
    if (!refs.has(ref)) where(path, `names no create-issue ref in this plan (${ref})`);
  }

  if (raw.decisions !== undefined) {
    if (!Array.isArray(raw.decisions)) {
      where("decisions", "must be an array");
    } else {
      raw.decisions.forEach((entry, index) => {
        const path = `decisions[${index}]`;
        if (!isObject(entry)) {
          where(path, "must be an object");
          return;
        }
        for (const key of ["question", "rule", "quote"]) {
          if (!isNonEmptyString(entry[key])) where(`${path}.${key}`, "must be a non-empty string");
        }
        if (isNonEmptyString(entry.rule)) {
          const path0 = entry.rule.split("#")[0] ?? "";
          if (path0 === "" || path0.startsWith("/") || path0.split("/").includes("..")) {
            where(`${path}.rule`, "must be a repo-relative path with no .. segment");
          }
        }
      });
    }
  }

  if (problems.length > 0) return { problems };
  return { plan: raw as unknown as TriagePlan };
}

function closeProblems(entry: Record<string, unknown>, path: string, source?: string): string[] {
  const found: string[] = [];
  const say = (at: string, message: string): void => {
    found.push(source === undefined ? `${at}: ${message}` : `${source}: ${at}: ${message}`);
  };
  const evidence = entry.evidence;
  if (!isObject(evidence)) {
    say(`${path}.evidence`, "is required: a close carries done-in or duplicate-of evidence");
    return found;
  }
  if (evidence.kind === "done-in") {
    if (!isPositiveInt(evidence.pr)) say(`${path}.evidence.pr`, "must be the merged PR number");
    const criteria = evidence.criteria;
    if (!Array.isArray(criteria) || criteria.length === 0) {
      say(`${path}.evidence.criteria`, "must cite a file or test per acceptance criterion");
    } else {
      criteria.forEach((cited, at) => {
        if (!isObject(cited) || !isNonEmptyString(cited.criterion) || !isNonEmptyString(cited.cite)) {
          say(`${path}.evidence.criteria[${at}]`, "must be { criterion, cite } with both non-empty");
        }
      });
    }
  } else if (evidence.kind === "duplicate-of") {
    if (!isPositiveInt(evidence.issue)) {
      say(`${path}.evidence.issue`, "must be the issue number this duplicates");
    }
  } else {
    say(`${path}.evidence.kind`, 'must be "done-in" or "duplicate-of"');
  }
  return found;
}

