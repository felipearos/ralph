/**
 * The clerk's canvas: what the channel reported and where each report stands,
 * rendered as one markdown document that replaces the canvas whole on every
 * rebuild (felipearos/ralph#315).
 *
 * Pure: rows in, markdown out, no clock and no I/O of its own, so the rules —
 * which section a ticket lands in, in what order, how many rows a table may
 * hold — are read and tested apart from the Slack call that carries them.
 *
 * Live rows come from the Jira intake board (`intakeRows`, rendered by
 * `renderIntakeCanvas`, felipearos/ralph#448). In shadow, rows
 * come from the would-be tickets the shadow apply recorded (`shadowRows`),
 * rendered by `renderCanvas`, which have no Jira page: their link is the
 * report's Slack permalink, and the "y N más" line has no search to point at.
 *
 * Slack refuses a canvas table of more than 300 cells. The widest tables here
 * have nine columns (the shadow canvas's open sections since
 * felipearos/ralph#444, and every intake section), so `rowCap` (at most
 * `CLERK_ROW_CAP_CEILING`, 32, checked by the config validator) plus the
 * header row always fits.
 */
import type { ClerkStatus } from "../project-config";
import { READY_FOR_AGENT_LABEL, type AppLabels } from "../triage/intake";
import { DECISION_LABEL, DIFFICULTY_LABEL_PREFIX, DUPLICATE_COMMENT, MOVED_LABEL, plain, type ShadowRecord } from "./apply";
import type { JiraIssue } from "./jira";
import { tsMs } from "./slack";

/** One ticket as the canvas shows it: a Jira issue, or in shadow a would-be one. */
export interface CanvasRow {
  key: string;
  /** Where the ticket column links: the Jira issue, or in shadow the report's permalink. */
  url: string;
  summary: string;
  type: string;
  priority: string | null;
  /** `easy`, `medium` or `hard`, or null when the ticket carries none (a record stored before felipearos/ralph#444). */
  difficulty: string | null;
  /** The suggested story points, or null when nobody sized it. */
  storyPoints: number | null;
  status: string;
  /** `new`, `indeterminate` or `done`: Jira's own grouping of a workflow's statuses. */
  statusCategory: string;
  labels: string[];
  /** How many reports it stands for: the first, plus each duplicate folded into it. */
  reports: number;
  /** When it was reported (ISO). */
  created: string;
  /** When it was closed (ISO), or null while it is open. */
  resolved: string | null;
}

export interface CanvasInput {
  rows: readonly CanvasRow[];
  nowMs: number;
  rowCap: number;
  /** Where the rows came from: `shadow` says the tickets do not exist, and links nothing. */
  source: { kind: "shadow" };
  /** `clerk.dashboardUrl`: the page with every ticket, linked from the top line. */
  dashboardUrl?: string | null;
  /** The project's `appLabels`, which the App column reads. */
  apps: AppLabels;
}

/**
 * The canvas's top line when `clerk.dashboardUrl` is set (felipearos/ralph#459):
 * the canvas holds at most `rowCap` rows a section, the page holds them all.
 * Empty when it is not, so the header reads exactly as before.
 */
export function backlogLines(url: string | null | undefined): string[] {
  return url === null || url === undefined || url === "" ? [] : [`Ver todo el backlog: ${url}`];
}

/** The team is in Chile; a date a day off from the one they lived is a wrong date. */
export const CANVAS_TIME_ZONE = "America/Santiago";

/** How far back the closed section looks. */
export const CLOSED_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * Most urgent first. `Lowest` is not one the clerk files but may be set by
 * hand in Jira, so it has a place; an unknown or missing priority goes last.
 */
const PRIORITY_ORDER = ["Highest", "High", "Medium", "Low", "Lowest", "Sin Prioridad"];

const rank = (priority: string | null): number => {
  const at = priority === null ? -1 : PRIORITY_ORDER.indexOf(priority);
  return at === -1 ? PRIORITY_ORDER.length : at;
};

const time = (iso: string | null): number => {
  const ms = iso === null ? NaN : Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
};

/** Priority, then oldest first, then key: the same rows always render the same. */
const byUrgency = (a: CanvasRow, b: CanvasRow): number =>
  rank(a.priority) - rank(b.priority) || time(a.created) - time(b.created) || a.key.localeCompare(b.key);

/** Most recently closed first: the closed section is what changed this week. */
const byClosed = (a: CanvasRow, b: CanvasRow): number => time(b.resolved) - time(a.resolved) || a.key.localeCompare(b.key);

const isOpen = (row: CanvasRow): boolean => row.statusCategory !== "done";
const isDecision = (row: CanvasRow): boolean => row.labels.includes(DECISION_LABEL);

/**
 * The app column, from the labels: the repo labels the clerk files intake
 * tickets with (the project's `appLabels`), or the older labels a ticket filed
 * by hand may still carry (the app's own name).
 */
export function appOf(labels: readonly string[], apps: AppLabels): string {
  const named = [
    ["Backoffice", apps.backoffice],
    ["pwa", apps.pwa],
  ].filter((names) => names.some((label) => labels.includes(label)));
  return named.length === 0 ? "-" : named.map(([app]) => app).join(", ");
}

/**
 * One table cell. A `|` would end the cell and a newline the row, and a
 * reporter's text may hold either; emoji are dropped as everywhere the clerk
 * writes.
 */
export function cell(value: string): string {
  // The backslash first, or `a\|b` would come out as an escaped backslash
  // followed by a bare pipe, which ends the cell. Brackets and `!` too: a
  // summary must not become a link or a mention on the canvas.
  const text = plain(value.replace(/\r?\n|\r/g, " "))
    .replace(/\\/g, "\\\\")
    .replace(/([|[\]!])/g, "\\$1");
  return text === "" ? "-" : text;
}

/**
 * A URL as a markdown link target: a parenthesis or a space would end it
 * early, and `encodeURIComponent` leaves parentheses as they are.
 */
const target = (url: string): string => url.replace(/[()\s]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);

/** A link's text is a cell too, without the brackets that would end it. */
const link = (text: string, url: string): string => `[${cell(text).replace(/[[\]]/g, "")}](${target(url)})`;

const dateIn = (iso: string | null, timeZone: string): string => {
  const ms = time(iso);
  if (ms === 0) return "-";
  // en-CA writes ISO dates (YYYY-MM-DD), which read the same in any language.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
};

const stampIn = (ms: number, timeZone: string): string => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};

interface Section {
  title: string;
  empty: string;
  rows: CanvasRow[];
  columns: string[];
  cells: (row: CanvasRow) => string[];
}

/** Nine columns: the widest table, which `CLERK_ROW_CAP_CEILING` is derived from. */
export const OPEN_COLUMNS = ["Ticket", "Resumen", "App", "Prioridad", "Dificultad", "Puntos", "Estado", "Reportes", "Reportado"];

/**
 * The canvas, whole. Sections in the spec's order: open errors, open requests,
 * por decidir, closed in the last seven days. A decision is only ever in "Por
 * decidir", whatever its type, so no ticket appears twice.
 */
export function renderCanvas(input: CanvasInput): string {
  const timeZone = CANVAS_TIME_ZONE;
  const open = input.rows.filter(isOpen);
  const openCells = (row: CanvasRow): string[] => [
    link(row.key, row.url),
    cell(row.summary),
    appOf(row.labels, input.apps),
    cell(row.priority ?? "-"),
    cell(row.difficulty ?? "-"),
    row.storyPoints === null ? "-" : String(row.storyPoints),
    cell(row.status),
    String(row.reports),
    dateIn(row.created, timeZone),
  ];
  const sections: Section[] = [
    {
      title: "Errores abiertos",
      empty: "Sin errores abiertos.",
      rows: open.filter((row) => !isDecision(row) && row.type === "Error").sort(byUrgency),
      columns: OPEN_COLUMNS,
      cells: openCells,
    },
    {
      // Every open non-Error that is not a decision: the clerk files only
      // `Tarea`, but a ticket retyped by hand in Jira must still show somewhere.
      title: "Pedidos abiertos",
      empty: "Sin pedidos abiertos.",
      rows: open.filter((row) => !isDecision(row) && row.type !== "Error").sort(byUrgency),
      columns: OPEN_COLUMNS,
      cells: openCells,
    },
    {
      title: "Por decidir",
      empty: "Nada por decidir.",
      rows: open.filter(isDecision).sort(byUrgency),
      columns: OPEN_COLUMNS,
      cells: openCells,
    },
    {
      title: `Cerrados en los últimos ${CLOSED_DAYS} días`,
      empty: `Sin tickets cerrados en los últimos ${CLOSED_DAYS} días.`,
      rows: input.rows
        .filter((row) => !isOpen(row) && row.resolved !== null && input.nowMs - time(row.resolved) <= CLOSED_DAYS * DAY_MS)
        .sort(byClosed),
      columns: ["Ticket", "Resumen", "Estado", "Cerrado"],
      cells: (row) => [link(row.key, row.url), cell(row.summary), cell(row.status), dateIn(row.resolved, timeZone)],
    },
  ];

  const header = [
    "# Reportes del canal (prueba, modo shadow)",
    "",
    ...backlogLines(input.dashboardUrl).flatMap((line) => [line, ""]),
    "Generado automáticamente desde las decisiones del clerk en modo shadow: estos tickets no existen en Jira y el enlace de cada uno lleva al reporte en Slack. No lo edites: los cambios manuales se sobrescriben en la próxima actualización.",
  ];
  const out = [...header, "", `Actualizado: ${stampIn(input.nowMs, timeZone)} (hora de Chile).`];

  for (const section of sections) {
    out.push("", `## ${section.title}`, "");
    if (section.rows.length === 0) {
      out.push(section.empty);
      continue;
    }
    const shown = section.rows.slice(0, input.rowCap);
    out.push(`| ${section.columns.join(" | ")} |`, `| ${section.columns.map(() => "---").join(" | ")} |`);
    for (const row of shown) out.push(`| ${section.cells(row).join(" | ")} |`);
    const more = section.rows.length - shown.length;
    if (more > 0) out.push("", `y ${more} más`);
  }
  return `${out.join("\n")}\n`;
}

/** The status a would-be ticket shows: it was never filed, so it has no Jira status. */
export const SHADOW_STATUS = "Sin registrar (shadow)";

/**
 * The shadow record's would-be tickets as rows. Every one is open — nothing
 * closes a ticket that was never filed — and dated by its report, which is
 * when the reporter wrote it, not when the shadow apply got to it.
 */
export function shadowRows(record: ShadowRecord): CanvasRow[] {
  return Object.values(record.tickets).map((ticket) => {
    const reported = tsMs(ticket.report);
    return {
      key: ticket.key,
      url: ticket.permalink,
      summary: ticket.summary,
      type: ticket.type,
      priority: ticket.priority,
      // A record stored before felipearos/ralph#444 has neither field; its
      // label, should it carry one, is the next best word.
      difficulty: ticket.difficulty ?? ticket.labels.find((label) => label.startsWith(DIFFICULTY_LABEL_PREFIX))?.slice(DIFFICULTY_LABEL_PREFIX.length) ?? null,
      storyPoints: ticket.storyPoints ?? null,
      status: SHADOW_STATUS,
      statusCategory: "new",
      labels: ticket.labels,
      reports: ticket.reports,
      created: Number.isFinite(reported) && reported > 0 ? new Date(reported).toISOString() : ticket.createdAt,
      resolved: null,
    };
  });
}

/** Which section of the intake canvas a ticket belongs to, before the closed window is applied. */
export type IntakeGroup = "pending" | "agent" | "team" | "closed" | "rejected";

/** One intake-board ticket as the live canvas shows it (felipearos/ralph#448). */
export interface IntakeRow {
  key: string;
  /** The ticket's page on the site. */
  url: string;
  summary: string;
  type: string;
  priority: string | null;
  /** From the `difficulty:*` label; null when the ticket carries none. */
  difficulty: string | null;
  /** The story points field, else the description's suggested-points line; null when neither says. */
  storyPoints: number | null;
  status: string;
  labels: string[];
  /** How many reports it stands for: the first, plus each duplicate folded into it. */
  reports: number;
  created: string;
  /** When it was closed (resolution, else the move to Jira's "done" category), or null while it is open. */
  closedAt: string | null;
  /** The person board's key a moved ticket went to, or null when it did not move or no comment names it. */
  teamKey: string | null;
  group: IntakeGroup;
}

/** What `intakeRows` needs of the clerk's rules: the site for links, the person board, and the board's status names. */
export interface IntakeRules {
  site: string;
  /** The person board (`OA`): the key a moved ticket's comment names. */
  project: string;
  statuses: Record<ClerkStatus, string>;
}

/**
 * The line `fieldLines` in `clerk/apply.ts` writes when the points field is
 * unset or refused. Read back so a ticket sized only there still shows its
 * points; the field is read first, so a confirmer who sets it wins.
 */
const POINTS_LINE = /^Puntos de historia sugeridos: (\d+)\s*$/m;

const pointsOf = (issue: JiraIssue): number | null => {
  if (issue.storyPoints !== null) return issue.storyPoints;
  const line = POINTS_LINE.exec(issue.description)?.[1];
  return line === undefined ? null : Number(line);
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A claim label: whichever loop holds the ticket, it is with the agents. */
const isClaimed = (labels: readonly string[]): boolean => labels.some((label) => label.endsWith("-wip"));

/**
 * The section a ticket belongs to. Discarded wins over everything (a
 * discarded ticket may still carry the labels it was filed with), then moved
 * (an agent label left behind on a ticket that went to the team does not
 * keep it with the agents); an open ticket is with the agents once it is
 * confirmed for them or claimed, and waits for a person otherwise.
 *
 * "Waits for a person" is also where an open ticket in any other status
 * lands — confirmed but not swept yet, or a status set by hand: the Estado
 * column says which, and hiding an open report would be worse than showing
 * it under the nearest heading.
 */
function groupOf(issue: JiraIssue, statuses: IntakeRules["statuses"]): IntakeGroup {
  if (issue.status === statuses.rejected) return "rejected";
  if (issue.labels.includes(MOVED_LABEL) || issue.status === statuses.moved) return "team";
  if (issue.statusCategory === "done") return "closed";
  if (issue.labels.includes(READY_FOR_AGENT_LABEL) || isClaimed(issue.labels)) return "agent";
  return "pending";
}

/**
 * The live canvas's rows, from the intake board's `slack-intake` tickets as
 * the searches read them: status, labels, points and comments as Jira has
 * them now, so a ticket confirmed, claimed or moved shows where it stands on
 * the next rebuild. A key read twice (it closed between the open and the
 * closed read) is kept once, as the later read saw it.
 */
export function intakeRows(issues: readonly JiraIssue[], rules: IntakeRules): IntakeRow[] {
  const teamKey = new RegExp(`\\b${escapeRegExp(rules.project)}-\\d+\\b`);
  const byKey = new Map<string, IntakeRow>();
  for (const issue of issues) {
    const difficulty = issue.labels.find((label) => label.startsWith(DIFFICULTY_LABEL_PREFIX))?.slice(DIFFICULTY_LABEL_PREFIX.length);
    const group = groupOf(issue, rules.statuses);
    byKey.set(issue.key, {
      key: issue.key,
      url: `https://${rules.site}/browse/${issue.key}`,
      summary: issue.summary,
      type: issue.type,
      priority: issue.priority,
      difficulty: difficulty === undefined || difficulty === "" ? null : difficulty,
      storyPoints: pointsOf(issue),
      status: issue.status,
      labels: issue.labels,
      reports: 1 + issue.commentTexts.filter((text) => text.startsWith(DUPLICATE_COMMENT)).length,
      created: issue.created,
      closedAt: issue.statusCategory === "done" ? (issue.resolved ?? issue.doneAt) : null,
      // The newest comment naming a person-board key, should a later comment
      // correct an earlier one.
      teamKey: group === "team" ? ([...issue.commentTexts].reverse().map((text) => teamKey.exec(text)?.[0]).find((key) => key !== undefined) ?? null) : null,
      group,
    });
  }
  return [...byKey.values()];
}

export interface IntakeCanvasInput {
  rows: readonly IntakeRow[];
  nowMs: number;
  rowCap: number;
  /** The intake board's key, named in the header so a reader knows where to look. */
  intakeProject: string;
  /** `example.atlassian.net`, for the person board's key; empty when unknown, and the key shows as plain text. */
  site: string;
  /** `clerk.dashboardUrl`: the page with every ticket, linked from the line under the title (felipearos/ralph#459). */
  dashboardUrl?: string | null;
  /** The project's `appLabels`, which the App column reads. */
  apps: AppLabels;
}

/** The nine columns of every intake section: the widest the row cap allows (9 × 33 = 297 cells). */
export const INTAKE_COLUMNS = ["Ticket", "Resumen", "App", "Tipo", "Prioridad", "Dificultad", "Puntos", "Estado", "Reportes"];

/**
 * The lines above the sections, each its own paragraph. Kept apart from the
 * sections so a line can be added here (a link to the whole backlog, say)
 * without touching them.
 */
export function intakeHeader(input: IntakeCanvasInput): string[] {
  return [
    "# Reportes del canal",
    ...backlogLines(input.dashboardUrl),
    `Generado automáticamente desde el tablero de Jira ${cell(input.intakeProject)} (tickets con la etiqueta slack-intake). No lo edites: los cambios manuales se sobrescriben en la próxima actualización.`,
    `Actualizado: ${stampIn(input.nowMs, CANVAS_TIME_ZONE)} (hora de Chile).`,
  ];
}

/** Newest first, then key: past the row cap, the newest rows are the ones kept. */
const byNewest =
  (at: (row: IntakeRow) => string | null) =>
  (a: IntakeRow, b: IntakeRow): number =>
    time(at(b)) - time(at(a)) || a.key.localeCompare(b.key);

interface IntakeSection {
  title: string;
  empty: string;
  rows: IntakeRow[];
  columns: string[];
  cells: (row: IntakeRow) => string[];
}

/**
 * The live canvas, whole, from the intake board. Sections follow a report's
 * way through the board: waiting for a person to confirm it, confirmed for
 * the agents, moved to the team, closed this week, discarded. Each ticket has
 * exactly one group, so no ticket appears twice, and one closed before the
 * window appears nowhere.
 */
export function renderIntakeCanvas(input: IntakeCanvasInput): string {
  const withinWindow = (row: IntakeRow): boolean => row.closedAt !== null && input.nowMs - time(row.closedAt) <= CLOSED_DAYS * DAY_MS;
  // A ticket Jira gave no closing date still shows: dropping it would hide a
  // report the board holds.
  const current = (row: IntakeRow): boolean => row.closedAt === null || withinWindow(row);
  const of = (group: IntakeGroup): IntakeRow[] => input.rows.filter((row) => row.group === group);
  const cells = (row: IntakeRow, last: string): string[] => [
    link(row.key, row.url),
    cell(row.summary),
    appOf(row.labels, input.apps),
    cell(row.type),
    cell(row.priority ?? "-"),
    cell(row.difficulty ?? "-"),
    row.storyPoints === null ? "-" : String(row.storyPoints),
    last,
    String(row.reports),
  ];
  const withStatus = (row: IntakeRow): string[] => cells(row, cell(row.status));
  const teamCell = (key: string | null): string => (key === null ? "-" : input.site === "" ? cell(key) : link(key, `https://${input.site}/browse/${key}`));
  const sections: IntakeSection[] = [
    {
      title: "Por confirmar",
      empty: "Nada por confirmar.",
      rows: of("pending").sort(byNewest((row) => row.created)),
      columns: INTAKE_COLUMNS,
      cells: withStatus,
    },
    {
      title: "Para agente",
      empty: "Nada para los agentes.",
      rows: of("agent").sort(byNewest((row) => row.created)),
      columns: INTAKE_COLUMNS,
      cells: withStatus,
    },
    {
      // A moved ticket's status is the move itself; the column says where it
      // went instead, which is what a reader of this section asks.
      title: "En el equipo",
      empty: "Nada en el equipo.",
      rows: of("team").filter(current).sort(byNewest((row) => row.created)),
      columns: INTAKE_COLUMNS.map((column) => (column === "Estado" ? "Ticket del equipo" : column)),
      cells: (row) => cells(row, teamCell(row.teamKey)),
    },
    {
      title: `Cerrados en los últimos ${CLOSED_DAYS} días`,
      empty: `Sin tickets cerrados en los últimos ${CLOSED_DAYS} días.`,
      rows: of("closed").filter(withinWindow).sort(byNewest((row) => row.closedAt)),
      columns: INTAKE_COLUMNS,
      cells: withStatus,
    },
    {
      title: "Descartados",
      empty: `Sin tickets descartados en los últimos ${CLOSED_DAYS} días.`,
      rows: of("rejected").filter(current).sort(byNewest((row) => row.closedAt ?? row.created)),
      columns: INTAKE_COLUMNS,
      cells: withStatus,
    },
  ];

  const out = intakeHeader(input).flatMap((line, index) => (index === 0 ? [line] : ["", line]));
  for (const section of sections) {
    out.push("", `## ${section.title}`, "");
    if (section.rows.length === 0) {
      out.push(section.empty);
      continue;
    }
    const shown = section.rows.slice(0, input.rowCap);
    out.push(`| ${section.columns.join(" | ")} |`, `| ${section.columns.map(() => "---").join(" | ")} |`);
    for (const row of shown) out.push(`| ${section.cells(row).join(" | ")} |`);
    const more = section.rows.length - shown.length;
    if (more > 0) out.push("", `y ${more} más`);
  }
  return `${out.join("\n")}\n`;
}
