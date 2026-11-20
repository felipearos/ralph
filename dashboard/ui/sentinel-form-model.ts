/**
 * The sentinel rules form's state and rules, kept apart from the React so
 * they can be tested without a DOM.
 *
 * `formProblems` is a hand-kept copy of the rule part of `project-config.ts`'s
 * `sentinelProblems`, message for message: the page may not import the
 * harness, and a form that accepts what the proposal route then refuses (or
 * says it differently) is two rules. `sentinel-form-parity.test.ts` runs both
 * over the same cases.
 */
import { SENTINEL_MODES, SENTINEL_RULE_DEFAULTS, type ProposeSentinelResult, type SentinelRules, type SentinelRulesView } from "../contracts";
import { rulesSaveNotice, type SaveNotice } from "./rules-save-model";

export type { SaveNotice } from "./rules-save-model";

/** What the inputs show. Numbers are held as the typed text so a half-typed value ("1.", "") is representable. */
export interface SentinelForm {
  /** The On/Off switch (#789): saved on its own, at once, never by the rules' Save. */
  enabled: boolean;
  lookbackHours: string;
  minEvents: string;
  minUsers: string;
  maxPerDay: string;
  mode: string;
}

/** The form from the base branch's rules, every key it leaves out filled with its default. */
export function formFromView(rules: SentinelRulesView | null): SentinelForm {
  const block = { ...SENTINEL_RULE_DEFAULTS, ...rules };
  return {
    enabled: block.enabled,
    lookbackHours: String(block.lookbackHours),
    minEvents: String(block.minEvents),
    minUsers: String(block.minUsers),
    maxPerDay: String(block.maxPerDay),
    mode: block.mode,
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
export function formValues(form: SentinelForm): {
  enabled: boolean;
  lookbackHours: number | string;
  minEvents: number | string;
  minUsers: number | string;
  maxPerDay: number | string;
  mode: string;
} {
  return {
    enabled: form.enabled,
    lookbackHours: parsed(form.lookbackHours),
    minEvents: parsed(form.minEvents),
    minUsers: parsed(form.minUsers),
    maxPerDay: parsed(form.maxPerDay),
    mode: form.mode,
  };
}

const isPositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** Every reason the harness would refuse these rules, in its words and its order. */
export function formProblems(form: SentinelForm): string[] {
  const problems: string[] = [];
  const values = formValues(form);
  if (!isPositive(values.lookbackHours)) {
    problems.push(`'sentinel.lookbackHours' must be a positive number; got ${JSON.stringify(values.lookbackHours)}`);
  }
  for (const key of ["minEvents", "minUsers", "maxPerDay"] as const) {
    const value = values[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      problems.push(`'sentinel.${key}' must be a whole number of at least 1; got ${JSON.stringify(value)}`);
    }
  }
  if (!(SENTINEL_MODES as readonly string[]).includes(values.mode)) {
    problems.push(`'sentinel.mode' must be 'observe' or 'file'; got ${JSON.stringify(values.mode)}`);
  }
  return problems;
}

/** The whole rule object to propose, or null while the form has a problem. */
export function rulesFromForm(form: SentinelForm): SentinelRules | null {
  if (formProblems(form).length > 0) return null;
  return formValues(form) as SentinelRules;
}

/** What the sheet says after a save: `rules-save-model.ts`'s words, naming the sentinel. */
export function saveNotice(result: ProposeSentinelResult): SaveNotice {
  return rulesSaveNotice(result, "sentinel");
}

/**
 * What the On/Off switch saves (#789): the base branch's rules as they stand
 * with only `enabled` changed, so a switch never carries a half-edited form
 * along. Null when those rules would be refused, which a rules save fixes first.
 */
export function switchRules(rules: SentinelRulesView | null, enabled: boolean): SentinelRules | null {
  return rulesFromForm({ ...formFromView(rules), enabled });
}
