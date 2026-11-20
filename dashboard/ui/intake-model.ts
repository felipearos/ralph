/**
 * The intake page's rules (felipearos/ralph#459), apart from React: which
 * tickets each tab holds, what the filters offer and keep, and how numbers
 * read. Spanish throughout: the page is the team's, as the canvas is.
 */
import { workflowState } from "./intake-signal-model";
import type { IntakeAssignee, IntakeMetricsRow, IntakeMetricsView, IntakeTicketView, IntakeView } from "../contracts";

export type IntakeTab = "recientes" | "backlog" | "por-decidir" | "no-se-hace" | "historial" | "todos";

export const TICKET_TABS: readonly { id: IntakeTab; title: string; empty: string }[] = [
  { id: "recientes", title: "Recientes", empty: "El canvas no muestra tickets ahora." },
  { id: "backlog", title: "Backlog", empty: "No hay tickets abiertos." },
  { id: "por-decidir", title: "Por decidir", empty: "No hay tickets por decidir." },
  { id: "no-se-hace", title: "No se hace", empty: "No hay tickets marcados como que no se hacen." },
  { id: "historial", title: "Historial", empty: "Todavía no hay tickets cerrados ni movidos." },
  { id: "todos", title: "Todos", empty: "No hay tickets." },
];

/**
 * Recientes is what the canvas shows; Backlog every open ticket; Por decidir
 * and No se hace the OAI columns of those names, read off the intake ticket's
 * own status (a later PR or team step does not move it out); Historial the
 * closed and the moved; Todos every one.
 */
export function ticketsOf(tab: IntakeTab, tickets: readonly IntakeTicketView[]): IntakeTicketView[] {
  if (tab === "recientes") return tickets.filter((ticket) => ticket.onCanvas);
  if (tab === "backlog") return tickets.filter((ticket) => ticket.stage === "abierto");
  if (tab === "por-decidir") return tickets.filter((ticket) => workflowState(ticket.status) === "deciding");
  if (tab === "no-se-hace") return tickets.filter((ticket) => workflowState(ticket.status) === "wont-do");
  if (tab === "todos") return [...tickets];
  return tickets.filter((ticket) => ticket.stage !== "abierto");
}

/** One number a ticket goes by: its intake key, the team key it moved to, or a PR that names either. */
export interface TicketNumber {
  label: string;
  href: string | null;
}

const repoName = (repo: string): string => repo.split("/").pop() ?? repo;

/**
 * Every number a ticket goes by, intake key first. A team names the OA key or
 * the PR, never the OAI one, so the page lists them all and the search finds
 * a ticket by any of them.
 */
export function ticketNumbers(ticket: IntakeTicketView): TicketNumber[] {
  const numbers: TicketNumber[] = [{ label: ticket.key, href: ticket.url }];
  const team = ticket.trail.find((step) => step.kind === "team" && step.key !== null);
  const teamKey = ticket.movedTo ?? (team?.kind === "team" ? team.key : null);
  if (teamKey !== null) numbers.push({ label: teamKey, href: ticket.movedToUrl ?? (team?.kind === "team" ? team.url : null) });
  for (const step of ticket.trail) {
    if (step.kind !== "pr") continue;
    const label = `PR #${step.number} (${repoName(step.repo)})`;
    if (!numbers.some((number) => number.label === label)) numbers.push({ label, href: step.url });
  }
  return numbers;
}

/** "Todos" in every filter: no value of the field is excluded. */
export const ALL = "__all__";
/** The value a filter offers for a ticket that does not say. */
export const NONE = "__none__";

export interface IntakeFilters {
  text: string;
  status: string;
  app: string;
  difficulty: string;
  assignee: string;
}

export const NO_FILTERS: IntakeFilters = { text: "", status: ALL, app: ALL, difficulty: ALL, assignee: ALL };

type Field = "status" | "app" | "difficulty" | "assignee";

const valueOf = (ticket: IntakeTicketView, field: Field): string => ticket[field] ?? NONE;

const DIFFICULTY_ORDER = ["easy", "medium", "hard"];

/** The values each filter offers: those the tickets carry, in a stable order, "sin dato" last. */
export function filterOptions(tickets: readonly IntakeTicketView[]): Record<Field, string[]> {
  const options = (field: Field): string[] => {
    const values = [...new Set(tickets.map((ticket) => valueOf(ticket, field)))];
    const rank = (value: string): number => (value === NONE ? 1 : 0);
    return values.sort((a, b) => {
      if (field === "difficulty") {
        const at = (value: string) => (DIFFICULTY_ORDER.includes(value) ? DIFFICULTY_ORDER.indexOf(value) : DIFFICULTY_ORDER.length);
        return rank(a) - rank(b) || at(a) - at(b) || a.localeCompare(b);
      }
      return rank(a) - rank(b) || a.localeCompare(b, "es");
    });
  };
  return { status: options("status"), app: options("app"), difficulty: options("difficulty"), assignee: options("assignee") };
}

/** The tickets every filter keeps; the text matches any of its numbers (OAI, OA, PR), the summary or the reporter. */
export function applyFilters(tickets: readonly IntakeTicketView[], filters: IntakeFilters): IntakeTicketView[] {
  const text = filters.text.trim().toLocaleLowerCase("es");
  return tickets.filter((ticket) => {
    for (const field of ["status", "app", "difficulty", "assignee"] as const) {
      if (filters[field] !== ALL && valueOf(ticket, field) !== filters[field]) return false;
    }
    if (text === "") return true;
    return [...ticketNumbers(ticket).map((number) => number.label), ticket.summary, ticket.reporter ?? ""].some((value) => value.toLocaleLowerCase("es").includes(text));
  });
}

const DIFFICULTY_LABELS: Record<string, string> = { easy: "Fácil", medium: "Media", hard: "Difícil" };

/** A filter value as the select shows it. */
export function optionLabel(field: Field, value: string): string {
  if (value === ALL) return "Todos";
  if (value === NONE) return "Sin dato";
  if (field === "difficulty") return DIFFICULTY_LABELS[value] ?? value;
  if (field === "assignee") return assigneeLabel(value as IntakeAssignee);
  return value;
}

export const difficultyLabel = (value: string | null): string => (value === null ? "-" : (DIFFICULTY_LABELS[value] ?? value));

const PRIORITY_LABELS: Record<string, string> = {
  Highest: "Muy alta",
  High: "Alta",
  Medium: "Media",
  Low: "Baja",
  Lowest: "Muy baja",
  "Sin Prioridad": "Sin prioridad",
};

export const priorityLabel = (value: string | null): string => (value === null ? "-" : (PRIORITY_LABELS[value] ?? value));

export const assigneeLabel = (value: IntakeAssignee | null): string => (value === "agente" ? "Agente" : value === "persona" ? "Persona" : "-");

/** A rate as a whole percent; a rate with nothing under it is a dash, never NaN. */
export const percent = (rate: number | null): string => (rate === null || !Number.isFinite(rate) ? "-" : `${Math.round(rate * 100)}%`);

/** A latency as minutes, hours or days. */
export function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "-";
  const minutes = ms / 60_000;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  return hours < 48 ? `${hours.toFixed(1)} h` : `${(hours / 24).toFixed(1)} d`;
}

const FIELD_LABELS: Record<string, string> = {
  type: "Tipo",
  app: "App",
  priority: "Prioridad",
  difficulty: "Dificultad",
  storyPoints: "Puntos",
  assigneeKind: "Asignado a",
  assignee: "Responsable",
  summary: "Resumen",
  description: "Descripción",
};

export const fieldLabel = (field: string): string => FIELD_LABELS[field] ?? field;

/** Each overridden field with its rate, most overridden first. */
export function overridesOf(row: IntakeMetricsRow): { field: string; count: number; rate: string }[] {
  return Object.entries(row.overridesByField)
    .map(([field, count]) => ({ field: fieldLabel(field), count, rate: percent(row.overrideRateByField[field] ?? null) }))
    .sort((a, b) => b.count - a.count || a.field.localeCompare(b.field, "es"));
}

const shown = (value: string | number | null): string => (value === null ? "nada" : String(value));

/** One side of a correction as shown: a priority in Spanish, a long text cut, "nada" for none. */
export const overrideValue = (field: string, value: string | number | null): string => {
  if (field === "priority" && typeof value === "string") return priorityLabel(value);
  const text = shown(value);
  return text.length > 140 ? `${text.slice(0, 140)}...` : text;
};

/** The clerk-to-person changes, as "Prioridad: Media a Alta (3)". */
export const changesOf = (row: IntakeMetricsRow): string[] =>
  row.topChanges.map((change) => `${fieldLabel(change.field)}: ${overrideValue(change.field, change.agent)} a ${overrideValue(change.field, change.human)} (${change.count})`);

/** A reporter as recorded: their name when the ledger had it, with the Slack id beside it. */
export const reporterLabel = (row: { key: string; label?: string }): string => (row.label ? `${row.label} (${row.key})` : row.key);

/** The share of a row's reports that were valuable; a dash with none. */
export const valuableRate = (row: IntakeMetricsRow): string => percent(row.reports === 0 ? null : row.valuable / row.reports);

/**
 * What the header says about the clerk's mode: shadow tickets are not real;
 * quiet ones are on the intake board but nobody in Slack was told
 * (felipearos/ralph#443). Empty for live.
 */
export function modeNotice(mode: IntakeView["mode"]): string {
  if (mode === "shadow") return " · modo shadow: estos tickets no existen todavía";
  if (mode === "quiet") return " · modo quiet: tickets reales en el tablero de intake, sin avisos en Slack";
  return "";
}

/**
 * What part of the numbers is test data (felipearos/ralph#443): a quiet or
 * shadow run records into the same ledger, and the tables count every mode.
 * Null when every report is live.
 */
export function testReports(view: Pick<IntakeMetricsView, "modes">): string | null {
  const { shadow, quiet, live } = view.modes;
  if (shadow + quiet === 0) return null;
  const parts = [...(quiet > 0 ? [`${quiet} en modo quiet`] : []), ...(shadow > 0 ? [`${shadow} en modo shadow`] : [])];
  return `Incluye reportes de prueba: ${parts.join(" y ")}, de ${live + shadow + quiet} en total. Solo los del equipo: bun clerk-metrics.ts --mode live.`;
}
