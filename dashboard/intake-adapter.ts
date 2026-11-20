/**
 * The intake page's runtime adapter (felipearos/ralph#459): runs
 * `clerk-intake.ts` for one project through the CLI read (`cli-read.ts`) over
 * an injected `Executor`, and narrows what it prints, never importing the
 * clerk — the same process boundary `jav-adapter.ts` keeps with `jav.ts`. The
 * project travels as `RALPH_PROJECT`, its checkout.
 *
 * Two read-only argv shapes and nothing else. Each read is kept for
 * `INTAKE_CACHE_MS`: the bridge asks for both on its own cadence for every
 * project, and the files behind them change once a canvas rebuild at most.
 * A CLI that fails, times out or prints the wrong shape is an unavailable
 * view with the reason, never a throw into the route.
 */
import { createCliReader, type CliRead, type CliSurface } from "./cli-read";
import {
  INTAKE_ASSIGNEES,
  INTAKE_PR_STATES,
  INTAKE_STAGES,
  type IntakeLinkView,
  type IntakeMetricsRow,
  type IntakeMetricsView,
  type IntakeOverrideValue,
  type IntakeParticipationRow,
  type IntakePrecisionView,
  type IntakeStepView,
  type IntakeTicketView,
  type IntakeView,
} from "./contracts";
import { createProcessExecutor, type Executor } from "./executor";

export const INTAKE_SURFACE = {
  tickets: { script: "clerk-intake.ts", args: ["--json"] },
  metrics: { script: "clerk-intake.ts", args: ["--metrics", "--json"] },
} as const;

export const INTAKE_CACHE_MS = 30_000;

export interface IntakeAdapter {
  tickets(): Promise<IntakeView>;
  metrics(): Promise<IntakeMetricsView>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | null => (list.includes(value as T) ? (value as T) : null);

export const emptyIntake = (reason: string): IntakeView => ({
  v: 1,
  available: false,
  reason,
  loop: null,
  generatedAt: null,
  source: null,
  mode: null,
  canvasRowCap: null,
  title: null,
  links: [],
  tickets: [],
});

/** A shortcut the page can open: an https URL, so a snapshot cannot make the sidebar run script. */
function narrowLink(value: unknown): IntakeLinkView | null {
  if (!isRecord(value)) return null;
  const group = oneOf(["GitHub", "Jira"] as const, value.group);
  const label = str(value.label);
  const url = str(value.url);
  if (group === null || label === null || url === null || !url.startsWith("https://")) return null;
  return { group, label, url };
}

const EMPTY_PRECISION: IntakePrecisionView = { confirmed: 0, exact: 0, precision: null, byField: [], byWeek: [], corrections: [] };

export const emptyMetrics = (reason: string, nowMs = Date.now()): IntakeMetricsView => ({
  v: 1,
  available: false,
  reason,
  loop: null,
  generatedAt: new Date(nowMs).toISOString(),
  skippedLines: 0,
  modes: { shadow: 0, quiet: 0, live: 0 },
  byReporter: [],
  byApp: [],
  byWeek: [],
  participation: [],
  precision: EMPTY_PRECISION,
});

const https = (value: unknown): string | null => {
  const text = str(value);
  return text !== null && text.startsWith("https://") ? text : null;
};

/** One ticket, or null when it lacks what a row needs: a key, a link and a summary. */
function narrowTicket(value: unknown): IntakeTicketView | null {
  if (!isRecord(value)) return null;
  const key = str(value.key);
  const url = str(value.url);
  const summary = str(value.summary);
  const stage = oneOf(INTAKE_STAGES, value.stage);
  if (key === null || url === null || summary === null || stage === null) return null;
  return {
    key,
    url,
    summary,
    app: str(value.app),
    type: str(value.type),
    priority: str(value.priority),
    difficulty: str(value.difficulty),
    storyPoints: num(value.storyPoints),
    assignee: oneOf(INTAKE_ASSIGNEES, value.assignee),
    status: str(value.status) ?? "-",
    stage,
    reporter: str(value.reporter),
    created: str(value.created),
    closedAt: str(value.closedAt),
    movedTo: str(value.movedTo),
    movedToUrl: str(value.movedToUrl),
    reports: num(value.reports) ?? 1,
    onCanvas: value.onCanvas === true,
    // A snapshot written before the trail has none: an empty column, not a dropped ticket.
    trail: (Array.isArray(value.trail) ? value.trail : []).flatMap((entry) => narrowStep(entry) ?? []),
  };
}

/**
 * One stage, or null when it is not one. Every link becomes an href on the
 * page, so only an https one is kept; a stage whose link is required and
 * not https is dropped.
 */
function narrowStep(value: unknown): IntakeStepView | null {
  if (!isRecord(value)) return null;
  const at = str(value.at);
  switch (value.kind) {
    case "slack":
      return { kind: "slack", url: https(value.url), at, reporter: str(value.reporter) };
    case "intake": {
      const key = str(value.key);
      return key === null ? null : { kind: "intake", key, url: https(value.url), status: str(value.status) ?? "-", at };
    }
    case "team":
      return { kind: "team", key: str(value.key), url: https(value.url), status: str(value.status), held: value.held === true, at };
    case "pr": {
      const url = https(value.url);
      const number = num(value.number);
      const state = oneOf(INTAKE_PR_STATES, value.state);
      const repo = str(value.repo);
      return url === null || number === null || state === null || repo === null ? null : { kind: "pr", repo, number, url, state, at };
    }
    default:
      return null;
  }
}

/** Unknown fields are dropped; a bad `v` is an unavailable view, not a guess. */
export function narrowIntake(value: unknown): IntakeView {
  if (!isRecord(value) || value.v !== 1) return emptyIntake("clerk-intake.ts imprimió una forma inesperada.");
  if (value.available !== true) return { ...emptyIntake(str(value.reason) ?? "Sin datos."), loop: str(value.loop) };
  const source = value.source === "shadow" || value.source === "jira" ? value.source : null;
  const mode = value.mode === "shadow" || value.mode === "quiet" || value.mode === "live" ? value.mode : null;
  return {
    v: 1,
    available: true,
    reason: null,
    loop: str(value.loop),
    generatedAt: str(value.generatedAt),
    source,
    mode,
    canvasRowCap: num(value.canvasRowCap),
    title: str(value.title) || null,
    links: (Array.isArray(value.links) ? value.links : []).flatMap((entry) => narrowLink(entry) ?? []),
    tickets: (Array.isArray(value.tickets) ? value.tickets : []).flatMap((entry) => narrowTicket(entry) ?? []),
  };
}

const counts = (value: unknown): Record<string, number> =>
  isRecord(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => num(entry[1]) !== null)) : {};

function narrowRow(value: unknown): IntakeMetricsRow | null {
  if (!isRecord(value) || str(value.key) === null) return null;
  const label = str(value.label);
  return {
    key: value.key as string,
    ...(label === null ? {} : { label }),
    reports: num(value.reports) ?? 0,
    valuable: num(value.valuable) ?? 0,
    noise: num(value.noise) ?? 0,
    pending: num(value.pending) ?? 0,
    duplicates: num(value.duplicates) ?? 0,
    noiseRate: num(value.noiseRate),
    confirmed: num(value.confirmed) ?? 0,
    overrideRate: num(value.overrideRate),
    overridesByField: counts(value.overridesByField),
    overrideRateByField: counts(value.overrideRateByField),
    topChanges: (Array.isArray(value.topChanges) ? value.topChanges : []).flatMap((change) => {
      if (!isRecord(change) || str(change.field) === null) return [];
      const side = (v: unknown): string | number | null => (typeof v === "string" || (typeof v === "number" && Number.isFinite(v)) ? v : null);
      return [{ field: change.field as string, agent: side(change.agent), human: side(change.human), count: num(change.count) ?? 0 }];
    }),
    medianConfirmLatencyMs: num(value.medianConfirmLatencyMs),
  };
}

function narrowParticipation(value: unknown): IntakeParticipationRow | null {
  if (!isRecord(value) || str(value.key) === null) return null;
  const label = str(value.label);
  return {
    key: value.key as string,
    ...(label === null ? {} : { label }),
    reports: num(value.reports) ?? 0,
    last7Days: num(value.last7Days) ?? 0,
    last30Days: num(value.last30Days) ?? 0,
    lastReportAt: str(value.lastReportAt),
    activeWeeks: num(value.activeWeeks) ?? 0,
  };
}

const side = (value: unknown): IntakeOverrideValue => (typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? value : null);

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The precision view, field by field; a ledger written before it narrows to empty. */
function narrowPrecision(value: unknown): IntakePrecisionView {
  if (!isRecord(value)) return EMPTY_PRECISION;
  return {
    confirmed: num(value.confirmed) ?? 0,
    exact: num(value.exact) ?? 0,
    precision: num(value.precision),
    byField: list(value.byField).flatMap((row) =>
      !isRecord(row) || str(row.field) === null
        ? []
        : [
            {
              field: row.field as string,
              confirmed: num(row.confirmed) ?? 0,
              corrected: num(row.corrected) ?? 0,
              precision: num(row.precision),
              topChanges: list(row.topChanges).flatMap((change) => (isRecord(change) ? [{ agent: side(change.agent), human: side(change.human), count: num(change.count) ?? 0 }] : [])),
            },
          ],
    ),
    byWeek: list(value.byWeek).flatMap((row) =>
      !isRecord(row) || str(row.week) === null
        ? []
        : [{ week: row.week as string, confirmed: num(row.confirmed) ?? 0, exact: num(row.exact) ?? 0, precision: num(row.precision), correctedByField: counts(row.correctedByField) }],
    ),
    corrections: list(value.corrections).flatMap((row) =>
      !isRecord(row) || str(row.key) === null || str(row.field) === null
        ? []
        : [{ key: row.key as string, report: str(row.report) ?? (row.key as string), at: str(row.at) ?? "", by: str(row.by), field: row.field as string, agent: side(row.agent), human: side(row.human) }],
    ),
  };
}

export function narrowMetrics(value: unknown): IntakeMetricsView {
  if (!isRecord(value) || value.v !== 1) return emptyMetrics("clerk-intake.ts imprimió una forma inesperada.");
  const rows = (list: unknown) => (Array.isArray(list) ? list : []).flatMap((entry) => narrowRow(entry) ?? []);
  return {
    v: 1,
    available: value.available === true,
    reason: str(value.reason),
    loop: str(value.loop),
    generatedAt: str(value.generatedAt) ?? new Date().toISOString(),
    skippedLines: num(value.skippedLines) ?? 0,
    modes: {
      shadow: isRecord(value.modes) ? (num(value.modes.shadow) ?? 0) : 0,
      quiet: isRecord(value.modes) ? (num(value.modes.quiet) ?? 0) : 0,
      live: isRecord(value.modes) ? (num(value.modes.live) ?? 0) : 0,
    },
    byReporter: rows(value.byReporter),
    byApp: rows(value.byApp),
    byWeek: rows(value.byWeek),
    participation: (Array.isArray(value.participation) ? value.participation : []).flatMap((entry) => narrowParticipation(entry) ?? []),
    precision: narrowPrecision(value.precision),
  };
}

const NOT_JSON = "clerk-intake.ts no imprimió JSON.";

/**
 * Parses stdout itself, so non-JSON is the narrow's own Spanish degraded view
 * rather than reader drift: the only failure left for `degrade: "any"` is a
 * CLI that could not run, and the two never need telling apart by message.
 */
const parsedOr = <T>(narrow: (value: unknown) => T, notJson: () => T) => (value: unknown): T => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    return notJson();
  }
  return narrow(parsed);
};

export function createIntakeAdapter(options: {
  cliDir: string;
  bunPath: string;
  project: { root: string };
  timeoutMs?: number;
  now?: () => number;
  exec?: Executor;
}): IntakeAdapter {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const env = { ...process.env, RALPH_PROJECT: options.project.root };
  const reader = createCliReader({
    exec: options.exec ?? createProcessExecutor({ timeoutMs }),
    now,
    bunPath: options.bunPath,
    cliDir: options.cliDir,
    timeoutMs,
  });

  const ticketsSurface: CliSurface<IntakeView> = {
    ...INTAKE_SURFACE.tickets,
    contract: "clerk-intake.ts --json",
    parse: "text",
    narrow: parsedOr(narrowIntake, () => emptyIntake(NOT_JSON)),
    ttlMs: INTAKE_CACHE_MS,
    degrade: "any",
  };
  const metricsSurface: CliSurface<IntakeMetricsView> = {
    ...INTAKE_SURFACE.metrics,
    contract: "clerk-intake.ts --metrics --json",
    parse: "text",
    narrow: parsedOr(narrowMetrics, () => emptyMetrics(NOT_JSON, now())),
    ttlMs: INTAKE_CACHE_MS,
    degrade: "any",
  };

  // A degraded read is a CLI that could not run: its problem is the reason.
  // That holds only while both narrows stay total (they return an empty view
  // rather than throw); a throwing narrow would degrade here with an English
  // drift message under the Spanish prefix.
  const orUnavailable = <T>(read: CliRead<T>, empty: (reason: string, readAt: string) => T): T =>
    read.view ?? empty(`No se pudo leer el clerk: ${read.problem ?? ""}`, read.readAt);
  const call = { cwd: options.cliDir, env };
  return {
    tickets: async () => orUnavailable(await reader.view(ticketsSurface, call), (reason) => emptyIntake(reason)),
    // Stamped when the failed read ran, so a cached failure keeps its time.
    metrics: async () =>
      orUnavailable(await reader.view(metricsSurface, call), (reason, readAt) => emptyMetrics(reason, Date.parse(readAt))),
  };
}
