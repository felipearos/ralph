/**
 * The intake snapshot: every ticket the clerk filed, old and current, as one
 * JSON file beside its store (felipearos/ralph#459).
 *
 * The Slack canvas holds at most `rowCap` rows a section, because Slack
 * refuses a canvas table of more than 300 cells. The team still needs to see
 * the whole backlog and the old tickets, so on every canvas rebuild the gate
 * writes the tickets it read here too. The local dashboard serves the file
 * (`clerk-intake.ts --json`), and the remote bridge pushes it to the hosted
 * store from there, as it pushes every other snapshot.
 *
 * Live, a rebuild reads only the open tickets and the ones closed this week,
 * so the file keeps what earlier rebuilds saw: a ticket that falls out of the
 * read stays, with the state it was last seen in. Shadow is the store's own
 * shadow record, whole, and is never merged: those tickets do not exist, and
 * once the clerk goes live they must not linger beside real ones.
 *
 * The file is an observation for people to read, never an input to the gate.
 * So a write that fails is a note on the poll, never a throw, and nothing
 * here waits on anything: one read and one atomic rename of a local file.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { AGENT_LABEL, HOLD_LABEL, PERSON_LABEL, isPlaceholderKey, reportPermalinkOf as permalinkOf, type ShadowRecord } from "./apply";
import { appOf as appOfLabels, shadowRows, type CanvasRow, type IntakeRow } from "./canvas";
import type { AppLabels } from "../triage/intake";
import type { JiraIssue } from "./jira";
import { PULL_STATES, pullsNaming, type PullRef, type PullState } from "./pulls";

export const INTAKE_SNAPSHOT_VERSION = 1 as const;

/** Where a ticket stands for the page's tabs: Backlog is `abierto`, Historial the other two. */
export const INTAKE_STAGES = ["abierto", "cerrado", "movido"] as const;
export type IntakeStage = (typeof INTAKE_STAGES)[number];

/** Who does the work, as the team reads it. */
export const INTAKE_ASSIGNEES = ["agente", "persona"] as const;
export type IntakeAssignee = (typeof INTAKE_ASSIGNEES)[number];

/** One intake ticket, as the page shows it. Every field the ticket does not say is null. */
export interface IntakeTicket {
  key: string;
  /** The ticket's page; in shadow, the report's Slack permalink. */
  url: string;
  summary: string;
  /** `Backoffice`, `pwa`, both joined by a comma, or null when no app label says. */
  app: string | null;
  type: string | null;
  priority: string | null;
  difficulty: string | null;
  storyPoints: number | null;
  assignee: IntakeAssignee | null;
  /** The tracker's own status name (`Por confirmar`, `In Progress`, …). */
  status: string;
  stage: IntakeStage;
  /** The reporter's name as the ticket records it. */
  reporter: string | null;
  /** When it was reported (ISO). */
  created: string | null;
  closedAt: string | null;
  /** The person board's key a moved ticket went to, and its page. */
  movedTo: string | null;
  movedToUrl: string | null;
  /** How many reports it stands for: the first, plus each duplicate folded into it. */
  reports: number;
  /** Whether the channel's canvas shows it right now: the page's Recientes tab. */
  onCanvas: boolean;
  /**
   * Every stage the report went through, oldest first: the Slack message, the
   * intake ticket, the team ticket it moved to, and the PRs that name either
   * (the page's Seguimiento column). Empty in a file an older rebuild wrote.
   */
  trail: IntakeStep[];
}

/** A PR's state, as the team reads it. */
export const INTAKE_PR_STATES = PULL_STATES;
export type IntakePrState = PullState;

/** One stage of a ticket's trail. `at` is when it got there (ISO), null when nothing says. */
export type IntakeStep =
  /** The report: its Slack message, null when the ticket does not name it. */
  | { kind: "slack"; url: string | null; at: string | null; reporter: string | null }
  /** The intake board's ticket (OAI-n); in shadow a would-be one, with no page. */
  | { kind: "intake"; key: string; url: string | null; status: string; at: string | null }
  /**
   * The team board's ticket (OA-n) it moved to. `held` is a move a person
   * confirmed that the clerk holds back (`clerk.holdOaMove`): no ticket yet.
   * The key is null when the move names none; the status when it was not read.
   */
  | { kind: "team"; key: string | null; url: string | null; status: string | null; held: boolean; at: string | null }
  | { kind: "pr"; repo: string; number: number; url: string; state: IntakePrState; at: string | null };

export interface IntakeSnapshot {
  v: typeof INTAKE_SNAPSHOT_VERSION;
  generatedAt: string;
  /** Where the tickets were read: the shadow record, or the Jira intake board. */
  source: "shadow" | "jira";
  mode: "shadow" | "quiet" | "live";
  /** `clerk.rowCap`: how many rows a canvas section holds. */
  canvasRowCap: number;
  /** The project's `displayName`, the page's title. Absent in a snapshot written before it. */
  title?: string;
  /** The page's shortcuts, from the clerk's config (`intakeLinks`). Absent in a snapshot written before them. */
  links?: IntakeLink[];
  tickets: IntakeTicket[];
}

/** One sidebar shortcut on the intake page. */
export interface IntakeLink {
  group: "GitHub" | "Jira";
  label: string;
  url: string;
}

/**
 * The page's shortcuts, from config rather than spelled in the page: the app
 * repos the clerk reads PRs from and the two Jira boards it files on. A page
 * that named one team's repos would show them to every other project's.
 */
export function intakeLinks(rules: { prRepos?: string[] | null; jira: { site: string; project: string; intakeProject?: string | null } }): IntakeLink[] {
  const links: IntakeLink[] = (rules.prRepos ?? []).map((repo) => ({ group: "GitHub", label: repo.split("/")[1] ?? repo, url: `https://github.com/${repo}` }));
  if (rules.jira.site === "") return links;
  const board = (label: string, key: string): IntakeLink => ({ group: "Jira", label: `${label} · ${key}`, url: `https://${rules.jira.site}/jira/software/projects/${key}` });
  if (rules.jira.intakeProject) links.push(board("Intake", rules.jira.intakeProject));
  if (rules.jira.project !== "") links.push(board("Equipo", rules.jira.project));
  return links;
}

/**
 * The most tickets the file keeps. Far past any real channel's history, and
 * well under the store's 1 MB a key after gzip; past it the oldest closed
 * tickets go first, and an open one only once no closed one is left.
 */
export const INTAKE_SNAPSHOT_MAX = 3000;

/** Beside the clerk store: `<loop>.json` becomes `<loop>.intake.json`. */
export const intakeSnapshotPath = (storePath: string): string => storePath.replace(/(\.json)?$/, ".intake.json");

/**
 * The ticket keys a rendered canvas shows. Every table row the clerk renders
 * starts with the ticket's link (`| [KEY](url) |`), whichever canvas it is, so
 * reading them back off the markdown is exact and needs no second copy of each
 * canvas's section rules.
 */
export function shownKeys(markdown: string): Set<string> {
  const keys = new Set<string>();
  for (const line of markdown.split("\n")) {
    const match = /^\| \[([^\]]+)\]\(/.exec(line);
    if (match) keys.add(match[1]!.replace(/\\(.)/g, "$1"));
  }
  return keys;
}

/** A `Name: value` line of the field block a filed ticket's body carries (`apply.ts` `fieldLines`). */
function fieldOf(body: string, name: string): string | null {
  const match = new RegExp(`^${name}:\\s*(.+?)\\s*$`, "m").exec(body);
  return match === null ? null : match[1]!;
}

const reporterOf = (body: string): string | null => /^Reportado por (.+?) en Slack:/m.exec(body)?.[1]?.trim() || null;

/** The PR stages of a ticket: each PR that names its intake key or its team key. */
const prSteps = (pulls: readonly PullRef[], keys: readonly (string | null)[]): IntakeStep[] =>
  pullsNaming(
    pulls,
    keys.filter((key): key is string => key !== null),
  ).map((pull) => ({ kind: "pr", repo: pull.repo, number: pull.number, url: pull.url, state: pull.state, at: pull.at }));

const appOrNull = (app: string): string | null => (app === "-" || app === "" ? null : app);

function assigneeOf(labels: readonly string[], body: string): IntakeAssignee | null {
  if (labels.includes(AGENT_LABEL)) return "agente";
  if (labels.includes(PERSON_LABEL)) return "persona";
  const line = fieldOf(body, "Asignado a");
  return line === "agente" || line === "persona" ? line : null;
}

/**
 * The shadow record's would-be tickets. The canvas rows carry most of it; the
 * reporter is read off the description the shadow apply would have filed.
 */
export function shadowTickets(record: ShadowRecord, shown: ReadonlySet<string>, apps: AppLabels): IntakeTicket[] {
  const descriptions = new Map<string, string>();
  for (const entry of record.writes) {
    if (entry.write.kind === "create") descriptions.set(entry.report, entry.write.issue.description);
  }
  return shadowRows(record).map((row: CanvasRow) => {
    const ticket = record.tickets[row.key];
    const description = ticket === undefined ? "" : (descriptions.get(ticket.report) ?? "");
    const assignee = ticket?.assignee;
    return {
      key: row.key,
      url: row.url,
      summary: row.summary,
      app: appOrNull(appOfLabels(row.labels, apps)),
      type: row.type,
      priority: row.priority,
      difficulty: row.difficulty,
      storyPoints: row.storyPoints,
      assignee: assignee === "agent" ? "agente" : assignee === "person" ? "persona" : assigneeOf(row.labels, ""),
      status: row.status,
      stage: "abierto",
      reporter: reporterOf(description),
      created: row.created,
      closedAt: null,
      movedTo: null,
      movedToUrl: null,
      reports: row.reports,
      onCanvas: shown.has(row.key),
      // A would-be ticket has no board page, no team ticket and no PR: only the report is real.
      trail: [
        { kind: "slack", url: ticket?.permalink ?? permalinkOf(description), at: row.created, reporter: reporterOf(description) },
        { kind: "intake", key: row.key, url: null, status: row.status, at: row.created },
      ],
    };
  });
}

/**
 * The intake board's tickets, as the live canvas rebuild read them
 * (`clerk/canvas.ts` `intakeRows`). The rows carry the board's own reading;
 * the reporter and the assignee kind are read off each ticket's description
 * and labels, which the clerk wrote when it filed it.
 */
export interface BoardTrail {
  /** The OA key the sweep recorded for each intake ticket it moved (`store.confirmed`): a `HELD-…` one is a held move. */
  movedKeys?: ReadonlyMap<string, string>;
  /** The team tickets' statuses, as this rebuild read them; a key missing here shows no status. */
  teamStatuses?: ReadonlyMap<string, string>;
  /** The app repos' PRs (`clerk/pulls.ts`). */
  pulls?: readonly PullRef[];
}

/** A ticket's team stage, or null when it neither moved nor waits on a held move. */
function teamStep(row: IntakeRow, teamKey: string | null, held: boolean, site: string, statuses: ReadonlyMap<string, string>): IntakeStep | null {
  if (held && teamKey === null) return { kind: "team", key: null, url: null, status: null, held: true, at: null };
  if (teamKey === null && row.group !== "team") return null;
  return {
    kind: "team",
    key: teamKey,
    url: teamKey === null || site === "" ? null : `https://${site}/browse/${teamKey}`,
    status: teamKey === null ? null : (statuses.get(teamKey) ?? null),
    held: false,
    at: row.closedAt,
  };
}

export function boardTickets(
  issues: readonly JiraIssue[],
  rows: readonly IntakeRow[],
  site: string,
  shown: ReadonlySet<string>,
  apps: AppLabels,
  trail: BoardTrail = {},
): IntakeTicket[] {
  const byKey = new Map(issues.map((issue) => [issue.key, issue]));
  return rows.map((row) => {
    const description = byKey.get(row.key)?.description ?? "";
    // The comment the move left names the team key; the sweep's own record is
    // the fallback, and a placeholder there is a move held back, never a key.
    const recorded = trail.movedKeys?.get(row.key) ?? null;
    const teamKey = row.teamKey ?? (recorded === null || isPlaceholderKey(recorded) ? null : recorded);
    const held = teamKey === null && (row.labels.includes(HOLD_LABEL) || (recorded?.startsWith("HELD-") ?? false));
    const created = row.created === "" ? null : row.created;
    const team = teamStep(row, teamKey, held, site, trail.teamStatuses ?? new Map());
    return {
      key: row.key,
      url: row.url,
      summary: row.summary,
      app: appOrNull(appOfLabels(row.labels, apps)),
      type: row.type === "" ? null : row.type,
      priority: row.priority,
      difficulty: row.difficulty,
      storyPoints: row.storyPoints,
      assignee: assigneeOf(row.labels, description),
      status: row.status,
      stage: row.group === "team" ? "movido" : row.group === "closed" || row.group === "rejected" ? "cerrado" : "abierto",
      reporter: reporterOf(description),
      created,
      closedAt: row.closedAt,
      movedTo: teamKey,
      movedToUrl: teamKey === null || site === "" ? null : `https://${site}/browse/${teamKey}`,
      reports: row.reports,
      onCanvas: shown.has(row.key),
      trail: [
        { kind: "slack", url: permalinkOf(description), at: created, reporter: reporterOf(description) },
        { kind: "intake", key: row.key, url: row.url, status: row.status, at: created },
        ...(team === null ? [] : [team]),
        ...prSteps(trail.pulls ?? [], [row.key, teamKey]),
      ],
    };
  });
}

/** The status a ticket shows once it left the open read without reaching the closed one. */
export const CLOSED_UNSEEN_STATUS = "Cerrado";

/**
 * This rebuild's tickets over what the file already held. A ticket read now
 * replaces its old entry; one not read keeps its old entry, off the canvas.
 * An old open ticket that is in neither read, when the open read was whole
 * (`openComplete`: fewer than its cap came back), was closed longer ago than
 * the closed read looks back, so it moves to Historial.
 */
export function mergeTickets(
  previous: readonly IntakeTicket[],
  current: readonly IntakeTicket[],
  options: { openComplete: boolean },
): IntakeTicket[] {
  const byKey = new Map<string, IntakeTicket>();
  for (const ticket of previous) {
    // A file written before the trail was recorded has none: empty, not undefined.
    const stale: IntakeTicket = { ...ticket, trail: Array.isArray(ticket.trail) ? ticket.trail : [], onCanvas: false };
    if (stale.stage === "abierto" && options.openComplete) {
      stale.stage = "cerrado";
      stale.status = CLOSED_UNSEEN_STATUS;
    }
    byKey.set(ticket.key, stale);
  }
  for (const ticket of current) byKey.set(ticket.key, ticket);
  return capped([...byKey.values()]);
}

const time = (iso: string | null): number => {
  const ms = iso === null ? NaN : Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
};

/** At most `INTAKE_SNAPSHOT_MAX`, newest first: the oldest closed go before any open one. */
function capped(tickets: IntakeTicket[]): IntakeTicket[] {
  const newest = (a: IntakeTicket, b: IntakeTicket): number => time(b.created) - time(a.created) || b.key.localeCompare(a.key);
  const sorted = [...tickets].sort(newest);
  if (sorted.length <= INTAKE_SNAPSHOT_MAX) return sorted;
  const open = sorted.filter((ticket) => ticket.stage === "abierto");
  const rest = sorted.filter((ticket) => ticket.stage !== "abierto");
  return [...open, ...rest].slice(0, INTAKE_SNAPSHOT_MAX).sort(newest);
}

/** The file as last written, or null when there is none or it cannot be read: a fresh start, never an error. */
export function readIntakeSnapshot(path: string): IntakeSnapshot | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<IntakeSnapshot>;
    if (value?.v !== INTAKE_SNAPSHOT_VERSION || !Array.isArray(value.tickets)) return null;
    return value as IntakeSnapshot;
  } catch {
    return null;
  }
}

export interface IntakeBuild {
  source: IntakeSnapshot["source"];
  mode: IntakeSnapshot["mode"];
  canvasRowCap: number;
  title: string;
  links: IntakeLink[];
  nowMs: number;
  tickets: IntakeTicket[];
  /** Live only: whether the open read came back whole, for `mergeTickets`. */
  openComplete?: boolean;
}

/**
 * Write this rebuild's snapshot. Returns the note for the poll's log when it
 * could not be written, else null; it never throws, because a page nobody may
 * be reading is no reason for a poll to fail.
 */
export function recordIntakeSnapshot(path: string, build: IntakeBuild): string | null {
  try {
    const previous = readIntakeSnapshot(path);
    const tickets =
      build.source === "jira" && previous?.source === "jira"
        ? mergeTickets(previous.tickets, build.tickets, { openComplete: build.openComplete ?? false })
        : capped(build.tickets);
    const snapshot: IntakeSnapshot = {
      v: INTAKE_SNAPSHOT_VERSION,
      generatedAt: new Date(build.nowMs).toISOString(),
      source: build.source,
      mode: build.mode,
      canvasRowCap: build.canvasRowCap,
      title: build.title,
      links: build.links,
      tickets,
    };
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(snapshot)}\n`);
    renameSync(temp, path);
    return null;
  } catch (error) {
    return `intake snapshot not written to ${path} — ${(error as Error).message}; the page keeps the previous one`;
  }
}
