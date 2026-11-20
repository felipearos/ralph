/**
 * The intake page's Seguimiento column, as data: which stage of a report's
 * trail the cell shows, and what each entry of its menu says. Pure, so the
 * choice and the wording are tested without a browser; `trail-entry.ts`
 * renders an entry, and `intake.tsx` puts them in the shadcn menu.
 */
import type { IntakeStepView } from "../contracts";
import { chileDateTime } from "./chile-time";

/** How far a report got, by stage kind: a PR is further than its team ticket, which is further than the intake one. */
const RANK: Record<IntakeStepView["kind"], number> = { slack: 0, intake: 1, team: 2, pr: 3 };

/** What a held move shows: a person confirmed it for the team, and the clerk has not created the team ticket. */
export const HELD_STATUS = "Pendiente de mover a OA";

/**
 * The furthest stage the report reached: PR, else team ticket, else intake
 * ticket, else the Slack report. Of several PRs, the newest — the trail is
 * oldest first, so the last — except that a PR closed without merge never
 * hides an earlier merged one: the fix already landed, and a later attempt
 * that was abandoned (OAI-72: a teammate's duplicate PR, closed after the
 * loop's had merged) does not undo it. Null for an empty trail.
 */
export function latestStep(trail: readonly IntakeStepView[]): IntakeStepView | null {
  let latest: IntakeStepView | null = null;
  for (const step of trail) {
    if (latest?.kind === "pr" && latest.state === "mergeado" && step.kind === "pr" && step.state === "cerrado") continue;
    if (latest === null || RANK[step.kind] >= RANK[latest.kind]) latest = step;
  }
  return latest;
}

/** The rank of a ticket's furthest stage, for sorting the column; -1 for none. */
export const latestRank = (trail: readonly IntakeStepView[]): number => {
  const step = latestStep(trail);
  return step === null ? -1 : RANK[step.kind];
};

/** The cell's own text: "PR #12 · mergeado", "OA-200 · En curso", "OAI-7 · Por confirmar". */
export function stepLabel(step: IntakeStepView | null): string {
  if (step === null) return "-";
  switch (step.kind) {
    case "slack":
      return "Reporte de Slack";
    case "intake":
      return `${step.key} · ${step.status}`;
    case "team":
      return step.held ? HELD_STATUS : `${step.key ?? "Equipo"} · ${step.status ?? "-"}`;
    case "pr":
      return `PR #${step.number} · ${step.state}`;
  }
}

/** One entry of the menu: what it was, where it stands, when (Chile time), and where it opens. */
export interface TrailEntry {
  id: string;
  title: string;
  /** The stage's status, or the reporter for the Slack report; null when nothing says. */
  status: string | null;
  /** "22-10-2026 16:04", or "-". */
  when: string;
  /** The page it opens in a new tab; null when there is none, and the entry is text. */
  href: string | null;
}

const repoName = (repo: string): string => repo.split("/").pop() ?? repo;

export function trailEntry(step: IntakeStepView, index: number): TrailEntry {
  const when = chileDateTime(step.at);
  switch (step.kind) {
    case "slack":
      return { id: `${index}-slack`, title: "Reporte de Slack", status: step.reporter, when, href: step.url };
    case "intake":
      return { id: `${index}-intake`, title: `Ticket en el tablero de intake (${step.key})`, status: step.status, when, href: step.url };
    case "team":
      if (step.held) return { id: `${index}-team`, title: "Ticket en el tablero del equipo", status: HELD_STATUS, when, href: null };
      return {
        id: `${index}-team`,
        title: step.key === null ? "Ticket en el tablero del equipo" : `Ticket en el tablero del equipo (${step.key})`,
        status: step.status,
        when,
        href: step.url,
      };
    case "pr":
      return { id: `${index}-pr-${step.repo}-${step.number}`, title: `Pull request #${step.number} (${repoName(step.repo)})`, status: step.state, when, href: step.url };
  }
}

/** The menu's entries, oldest first, as the trail holds them. */
export const trailEntries = (trail: readonly IntakeStepView[]): TrailEntry[] => trail.map(trailEntry);
