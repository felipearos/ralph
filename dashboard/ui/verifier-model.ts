/**
 * The verifier settings form's state and rules, kept apart from the React so
 * they can be tested without a DOM.
 *
 * `formProblems` is a hand-kept copy of the rule part of `project-config.ts`'s
 * `verifierProblems`, message for message: the page may not import the
 * harness, and a form that accepts what the proposal route then refuses (or
 * says it differently) is two rules. `verifier-form-parity.test.ts` runs both
 * over the same cases.
 */
import {
  VERIFIER_MODES,
  VERIFIER_RULE_DEFAULTS,
  type ProposeVerifierResult,
  type VerifierRules,
  type VerifierRulesView,
} from "../contracts";
import { rulesSaveNotice, type SaveNotice } from "./rules-save-model";

export type { SaveNotice } from "./rules-save-model";

/**
 * What the inputs show. Numbers are held as the typed text so a half-typed
 * value ("1.", "") is representable; the check-ins are one comma-separated
 * string.
 */
export interface VerifierForm {
  /** The On/Off switch (#789): saved on its own, at once, never by the rules' Save. */
  enabled: boolean;
  windowHours: string;
  checkIns: string;
  trafficFloor: boolean;
  revert: { rateFactor: string; minEvents: string; minUsers: string };
  follow: { loopPrs: boolean; humanPrs: boolean };
  mode: string;
}

/** The form from the base branch's rules, every key it leaves out filled with its default. */
export function formFromView(rules: VerifierRulesView | null): VerifierForm {
  const block = rules ?? {};
  const revert = { ...VERIFIER_RULE_DEFAULTS.revert, ...block.revert };
  const follow = { ...VERIFIER_RULE_DEFAULTS.follow, ...block.follow };
  return {
    enabled: block.enabled ?? VERIFIER_RULE_DEFAULTS.enabled,
    windowHours: String(block.windowHours ?? VERIFIER_RULE_DEFAULTS.windowHours),
    checkIns: (block.checkIns ?? VERIFIER_RULE_DEFAULTS.checkIns).join(", "),
    trafficFloor: block.trafficFloor ?? VERIFIER_RULE_DEFAULTS.trafficFloor,
    revert: { rateFactor: String(revert.rateFactor), minEvents: String(revert.minEvents), minUsers: String(revert.minUsers) },
    follow: { loopPrs: follow.loopPrs, humanPrs: follow.humanPrs },
    mode: block.mode ?? VERIFIER_RULE_DEFAULTS.mode,
  };
}

/**
 * One input's value as the harness would receive it: a finite number, or the
 * typed text, trimmed, when it does not read as one. The text, not NaN: JSON has no
 * NaN, and the harness would be judging a string.
 */
function parsed(text: string): number | string {
  const trimmed = text.trim();
  if (trimmed === "") return trimmed;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : trimmed;
}

/** The rule object the form stands for, with any input that is not a number left as its text. */
export function formValues(form: VerifierForm): {
  enabled: boolean;
  windowHours: number | string;
  checkIns: (number | string)[];
  trafficFloor: boolean;
  revert: { rateFactor: number | string; minEvents: number | string; minUsers: number | string };
  follow: { loopPrs: boolean; humanPrs: boolean };
  mode: string;
} {
  return {
    enabled: form.enabled,
    windowHours: parsed(form.windowHours),
    checkIns: form.checkIns.trim() === "" ? [] : form.checkIns.split(",").map(parsed),
    trafficFloor: form.trafficFloor,
    revert: { rateFactor: parsed(form.revert.rateFactor), minEvents: parsed(form.revert.minEvents), minUsers: parsed(form.revert.minUsers) },
    follow: { ...form.follow },
    mode: form.mode,
  };
}

const isPositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** Every reason the harness would refuse these rules, in its words and its order. */
export function formProblems(form: VerifierForm): string[] {
  const problems: string[] = [];
  const values = formValues(form);

  const windowOk = isPositive(values.windowHours);
  if (!windowOk) problems.push(`'verifier.windowHours' must be a positive number; got ${JSON.stringify(values.windowHours)}`);
  // The harness's "checkIns must be set under 24 hours" rule is not copied:
  // the form always sends its check-ins, so it cannot fire from here.
  const checkIns = values.checkIns;
  if (checkIns.length === 0) {
    problems.push(`'verifier.checkIns' must be a non-empty list of hours after the deploy; got ${JSON.stringify(checkIns)}`);
  } else {
    const window = windowOk ? (values.windowHours as number) : null;
    for (const [index, hours] of checkIns.entries()) {
      if (!isPositive(hours)) {
        problems.push(`'verifier.checkIns[${index}]' must be a positive number; got ${JSON.stringify(hours)}`);
        continue;
      }
      const previous = checkIns[index - 1];
      if (index > 0 && isPositive(previous) && hours <= previous) {
        problems.push(`'verifier.checkIns[${index}]' must come after ${previous}: check-ins are strictly ascending; got ${hours}`);
      }
      if (window !== null && hours > window) {
        problems.push(`'verifier.checkIns[${index}]' must be within the ${window}-hour window; got ${hours}`);
      }
    }
  }

  const { rateFactor } = values.revert;
  if (!(isPositive(rateFactor) && rateFactor > 1)) {
    problems.push(`'verifier.revert.rateFactor' must be a number greater than 1; got ${JSON.stringify(rateFactor)}`);
  }
  for (const key of ["minEvents", "minUsers"] as const) {
    const value = values.revert[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      problems.push(`'verifier.revert.${key}' must be a whole number of at least 1; got ${JSON.stringify(value)}`);
    }
  }

  if (!values.follow.loopPrs && !values.follow.humanPrs) problems.push("'verifier.follow' must follow loop PRs, human PRs or both");

  if (!(VERIFIER_MODES as readonly string[]).includes(values.mode)) {
    problems.push(`'verifier.mode' must be 'observe', 'report' or 'act'; got ${JSON.stringify(values.mode)}`);
  }
  return problems;
}

/** The whole rule object to propose, or null while the form has a problem. */
export function rulesFromForm(form: VerifierForm): VerifierRules | null {
  if (formProblems(form).length > 0) return null;
  return formValues(form) as VerifierRules;
}

/** What the sheet says after a save: `rules-save-model.ts`'s words, naming the verifier. */
export function saveNotice(result: ProposeVerifierResult): SaveNotice {
  return rulesSaveNotice(result, "verifier");
}

/**
 * What the On/Off switch saves (#789): the base branch's rules as they stand
 * with only `enabled` changed, so a switch never carries a half-edited form
 * along. Null when those rules would be refused, which a rules save fixes first.
 */
export function switchRules(rules: VerifierRulesView | null, enabled: boolean): VerifierRules | null {
  return rulesFromForm({ ...formFromView(rules), enabled });
}
