/**
 * The order the writes go out in, so that no state BETWEEN two of them is one
 * the frontier would act on.
 *
 * The simulation checks the plan's endpoint. This checks the path: a split that
 * created its children `ready-for-agent` before the parent stopped being one
 * would, for the few seconds in between, offer a coder both the parent and a
 * child with no staffing group and no acceptance criteria. The frontier reads
 * GitHub, not the plan, and it does not wait for the apply to finish.
 *
 * The recipe felipearos/ralph#142 spells out, as phases:
 *
 *   create the children without `ready-for-agent`
 *   → give the parent `spec` and take its `ready-for-agent` away
 *   → set staffing groups, parents and difficulty on the children
 *   → make the children `ready-for-agent`
 *   → comment, linking them
 *   → lift a coder's block, if the plan rescues one
 *   → close what the plan closes
 *
 * Ordering is a pure rearrangement plus ONE rewrite: a `ready-for-agent` a
 * `create-issue` asks for is lifted out of the creation and re-issued as a
 * deferred label op, because "create it, then make it ready" is not something
 * a single `gh issue create` can express.
 */
import { READY_LABEL, SPEC_LABEL } from "../frontier/next-tasks";
import type { ApplyOp, TriageOp, TriagePlan } from "./plan";

export const PHASES = [
  "create",
  "demote",
  "structure",
  "label",
  "ready",
  "comment",
  "unblock",
  "close",
] as const;
export type Phase = (typeof PHASES)[number];

export interface Step {
  phase: Phase;
  op: ApplyOp;
}

/**
 * The plan's ops as ordered steps.
 *
 * Stable within a phase: the plan's own order is the author's, and a split that
 * lists its children in a deliberate sequence keeps it. The deferred
 * `ready-for-agent` ops sort last within `ready` by construction, since they
 * are appended as the creations are walked.
 */
export function orderOps(plan: TriagePlan): Step[] {
  const steps: Step[] = [];
  const deferred: Step[] = [];

  for (const op of plan.ops) {
    if (op.op === "create-issue") {
      const labels = op.labels ?? [];
      const held = labels.filter((label) => label === READY_LABEL);
      const kept = labels.filter((label) => label !== READY_LABEL);
      steps.push({
        phase: "create",
        op: kept.length === labels.length ? op : { ...op, labels: kept },
      });
      for (const label of held) {
        // The derived id has to be stable across reruns — it is the replay key
        // for a write like any other — so it is derived from the creation's own.
        deferred.push({ phase: "ready", op: { op: "add-label", opId: `${op.opId}.ready`, ref: op.ref, label } });
      }
      continue;
    }
    steps.push({ phase: phaseOf(op), op });
  }

  steps.push(...deferred);
  return PHASES.flatMap((phase) => steps.filter((step) => step.phase === phase));
}

/**
 * How many GitHub writes the plan really asks for.
 *
 * Not `plan.ops.length`: ordering lifts a child's `ready-for-agent` out of its
 * creation and re-issues it, so a plan of exactly `RALPH_TRIAGE_MAX_WRITES` ops
 * would make one more write than the cap allows. Counted through `orderOps`
 * itself rather than re-derived, so the two cannot drift.
 */
export const plannedWrites = (plan: TriagePlan): number => orderOps(plan).length;

function phaseOf(op: Exclude<TriageOp, { op: "create-issue" }>): Phase {
  switch (op.op) {
    case "add-label":
      if (op.label === SPEC_LABEL) return "demote";
      return op.label === READY_LABEL ? "ready" : "label";
    case "remove-label":
      // Taking `ready-for-agent` away is a DEMOTION, and it has to land before
      // anything the plan promotes: the window this ordering exists to close is
      // the one where a parent and its half-written children are all offerable.
      return op.label === READY_LABEL ? "demote" : "label";
    case "set-section":
    case "add-blocker":
      return "structure";
    case "comment":
      return "comment";
    case "unblock":
      // Its own phase, after `comment`, because felipearos/ralph#150 fixes the
      // order: the re-spec or the re-route lands first (`structure` or
      // `label`), then the comment saying why, and only then the label.
      //
      // The window it closes is the mirror of the split's. The moment the
      // `<loop>-blocked` is gone the ticket is back in the coders' frontier, so
      // a coder may claim it within seconds — and if the comment had not landed
      // yet, it would claim a ticket whose only visible history is the block it
      // was parked on, with no record of what changed. `close` stays last: a
      // plan that both rescues and closes is closing something else.
      return "unblock";
    case "close":
      return "close";
    // A Linear or Jira project's Slack-intake ops. `validate.ts` refuses them
    // on GitHub before a plan is ever ordered, so reaching here is a bug.
    case "propose":
    case "to-person":
      throw new Error(`triage op "${op.op}" is unreachable on GitHub: the validator refuses it`);
  }
}
