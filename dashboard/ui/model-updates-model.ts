/**
 * The Agents page's model-update panel, as plain data (#851).
 *
 * `GET /api/lineup/updates` reports every `models.json` block of the project
 * with the stages it runs on an older Claude id. This turns that report into
 * what the panel draws: the blocks to ASK about, each with the answers it
 * offers, and the quiet ones — outdated, but pinned, snoozed, skipped or
 * moving by themselves — with the reason they are not asked.
 */
import type { ModelUpdateAgentView, ModelUpdateAnswer, ModelUpdateResult, ModelUpdatesView } from "../../lineup/contracts";

export interface UpdateCard {
  /** Stable across reads: the block's address. */
  key: string;
  /** What the operator calls it: the loop, the role, or `default`. */
  name: string;
  /** What kind of block it is, so a role default is not mistaken for one loop. */
  kind: string;
  agent: ModelUpdateAgentView;
  /** The distinct ids the block would move to, for the Update button. */
  targets: string[];
  /** Why a quiet block is not asked; null for one that is. */
  quiet: string | null;
}

export interface UpdatePanel {
  asking: UpdateCard[];
  quiet: UpdateCard[];
}

/** A block's address as one key, `*` standing for the file's own `default`. */
export const blockKey = (agent: Pick<ModelUpdateAgentView, "project" | "block">): string =>
  `${agent.project ?? "*"}/${agent.block}`;

export function blockLabel(agent: Pick<ModelUpdateAgentView, "project" | "block">): { name: string; kind: string } {
  if (agent.project === null) return { name: "default", kind: "every project's fallback lineup" };
  if (agent.block === "default") return { name: "default", kind: "this project's fallback lineup" };
  if (agent.block.startsWith("@")) {
    const role = agent.block.slice(1);
    return { name: role, kind: `every ${role} loop without a block of its own` };
  }
  return { name: agent.block, kind: "agent" };
}

const day = (iso: string): string => iso.slice(0, 10);

/** Why an outdated block is not being asked, in the operator's words. */
export function quietReason(agent: ModelUpdateAgentView, nowMs: number): string {
  if (agent.malformed) return "pinned: its updates setting could not be read, so nothing changes";
  if (agent.policy === "pinned") return "pinned: never asked";
  if (agent.policy === "auto") return "updates itself at its next start";
  if (agent.snoozedUntil !== null && Date.parse(agent.snoozedUntil) > nowMs) return `snoozed until ${day(agent.snoozedUntil)}`;
  return `skipped ${[...new Set(agent.outdated.map((stage) => stage.latest))].join(", ")}`;
}

/** The panel for one report: asking blocks first, then the quiet ones; blocks with nothing outdated are left out. */
export function updatePanel(view: ModelUpdatesView, nowMs: number): UpdatePanel {
  const panel: UpdatePanel = { asking: [], quiet: [] };
  for (const agent of view.agents) {
    if (agent.outdated.length === 0) continue;
    const card: UpdateCard = {
      key: blockKey(agent),
      ...blockLabel(agent),
      agent,
      targets: [...new Set(agent.outdated.map((stage) => stage.latest))],
      quiet: agent.ask ? null : quietReason(agent, nowMs),
    };
    (agent.ask ? panel.asking : panel.quiet).push(card);
  }
  return panel;
}

/** The request body `POST /api/lineup/updates/answer` takes for one card. */
export function answerBody(agent: Pick<ModelUpdateAgentView, "project" | "block">, answer: ModelUpdateAnswer): Record<string, unknown> {
  return agent.project === null ? { fileDefault: true, answer } : { block: agent.block, answer };
}

/** What the panel says once an answer landed. */
export function answerMessage(result: ModelUpdateResult): string {
  const { name } = blockLabel(result);
  const moved = result.changes.length;
  const stages = `${moved} stage${moved === 1 ? "" : "s"}`;
  switch (result.answer) {
    case "update":
      return moved === 0 ? `${name}: nothing to move.` : `${name}: moved ${stages}. It runs the new model from its next start.`;
    case "auto":
      return `${name}: moves to the latest model by itself at every start${moved === 0 ? "" : `; moved ${stages} now`}.`;
    case "snooze":
      return `${name}: asked again ${result.agent?.snoozedUntil ? `after ${day(result.agent.snoozedUntil)}` : "in a week"}.`;
    case "skip":
      return `${name}: not asked again until a newer model ships.`;
    case "pin":
      return `${name}: pinned. Never asked again.`;
    case "ask":
      return `${name}: asked again whenever it falls behind.`;
  }
}
