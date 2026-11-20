/**
 * What the Sentinel and Verifier sheets say about a rules save (#787), kept
 * apart from the React so it can be tested without a DOM, and shared so the
 * two sheets cannot drift: a save either lands on the base branch at once
 * (`configChanges: "commit"`, the default) or opens a config PR (`"pr"`, or
 * when the direct push was refused).
 */
import type { ConfigChanges, RulesSaveResult } from "../contracts";
import type { Tone } from "./agents-model";

export interface SaveNotice {
  tone: Tone;
  text: string;
  /** The PR to open, when the save opened one. */
  url?: string;
}

/** Whose rules: the sentence names the loop that reads them. */
export type RulesOwner = "sentinel" | "verifier";

export function rulesSaveNotice(result: RulesSaveResult, owner: RulesOwner): SaveNotice {
  switch (result.outcome) {
    case "committed":
      return {
        tone: "good",
        text: `Saved to ${result.commit.branch} (${result.commit.sha.slice(0, 7)}). The ${owner} picks it up on its next poll.`,
      };
    case "proposed":
      return result.notCommitted === undefined
        ? { tone: "good", text: "Proposed the new rules. They apply once the PR is merged.", url: result.pr.url }
        : {
            tone: "warn",
            text: `Couldn't commit directly (${result.notCommitted}), opened a PR instead. The new rules apply once it is merged.`,
            url: result.pr.url,
          };
    case "refused":
      return { tone: "bad", text: `Not saved: ${result.why}` };
    case "pr-failed":
      return { tone: "warn", text: `The rules branch may be pushed, but the PR was not opened: ${result.why}` };
  }
}

/** The sheet's words for its save, which depend on where the save lands. */
export interface RulesSaveCopy {
  button: string;
  busy: string;
  /** The note above the button. */
  hint: string;
}

export function rulesSaveCopy(configChanges: ConfigChanges, baseBranch: string, owner: RulesOwner): RulesSaveCopy {
  return configChanges === "pr"
    ? {
        button: "Propose rules",
        busy: "Proposing…",
        hint: `Save opens a PR against ${baseBranch}. The ${owner} reads the new rules once it is merged.`,
      }
    : {
        button: "Save rules",
        busy: "Saving…",
        hint:
          `Save commits the rules to ${baseBranch}, and the ${owner} picks them up on its next poll. ` +
          "If the push is refused (a protected branch, or the branch moved), it opens a PR instead.",
      };
}

/**
 * The On/Off switch on the Sentinel and Verifier sheets, and the line their
 * cards show while off (#789). The state is the base branch's `enabled`,
 * which the gate re-reads every poll; absent means on, as the harness reads it.
 */
export interface AgentSwitch {
  on: boolean;
  /** The note beside the switch: what the state means, and where a switch lands. */
  hint: string;
  /** What a card says while it is off, or null while on: a card speaks up only for the unusual state. */
  card: string | null;
}

/** The words a card shows for an agent its config switched off. */
export const OFF_CARD = "Off: disabled in config";

export function agentSwitch(rules: { enabled?: boolean } | null, owner: RulesOwner, configChanges: ConfigChanges, baseBranch: string): AgentSwitch {
  const on = rules?.enabled !== false;
  const state = on
    ? `The ${owner} is on.`
    : `The ${owner} is off: its gate keeps polling, and reads, writes and hands over nothing until it is switched on.`;
  const lands =
    configChanges === "pr"
      ? `Switching opens a PR against ${baseBranch}; it applies once merged.`
      : `Switching saves to ${baseBranch} at once, and the ${owner} follows on its next poll.`;
  return { on, hint: `${state} ${lands}`, card: on ? null : OFF_CARD };
}

/** What the sheet says after a switch: a commit names the new state; the rest are a rules save's words. */
export function switchNotice(result: RulesSaveResult, owner: RulesOwner, enabled: boolean): SaveNotice {
  if (result.outcome !== "committed") return rulesSaveNotice(result, owner);
  return {
    tone: "good",
    text: `Switched ${enabled ? "on" : "off"} on ${result.commit.branch} (${result.commit.sha.slice(0, 7)}). The ${owner} ${enabled ? "starts" : "stops"} on its next poll.`,
  };
}
