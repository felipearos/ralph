/**
 * The clerk's intake metrics ledger (felipearos/ralph#443, #446).
 *
 * Every step a Slack report takes — reported, classified, confirmed or
 * rejected on the intake board, moved to OA, closed, marked a duplicate,
 * ignored — is one line here, so an operator can ask which reporters and apps
 * produce work the team keeps and which produce noise, and how often the
 * team overrides the clerk's classification.
 *
 * It lives beside the clerk store, in Git's common directory
 * (`<git-common-dir>/ralph/clerk/<loop>.metrics.jsonl`), so it survives the
 * loop's worktree being recreated. Append-only JSONL, as `triage/ledger.ts`:
 * a kill mid-write truncates one line, and a truncated line costs the reader
 * one event rather than the whole ledger.
 *
 * The ledger is an observation, never an input to a decision. So a write that
 * fails returns false and the poll carries on: losing one metrics line is
 * cheaper than a clerk that stops filing reports because a disk is full.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The canvas's time zone (`clerk/canvas.ts`): a week here is the week the team sees. */
export const METRICS_TIME_ZONE = "America/Santiago";

/** Resolutions that close a ticket without the work being worth having. Matched case-insensitively. */
export const DEFAULT_WONT_DO: readonly string[] = ["Won't Do", "Won't Fix", "Duplicate", "Cannot Reproduce", "Descartado"];

/**
 * The clerk mode an event was recorded in. `quiet` (felipearos/ralph#443) is
 * real tickets on the intake board that nobody in Slack was told about: test
 * data, kept apart from live by `SummaryOptions.modes`.
 */
export const METRICS_MODES = ["shadow", "quiet", "live"] as const;
export type MetricsMode = (typeof METRICS_MODES)[number];

interface EventBase {
  v: 1;
  /** ISO 8601, when the clerk observed it. */
  at: string;
  /** The report's Slack ts id: every event of one report shares it. */
  report: string;
  /** The intake ticket's Jira key, once there is one. */
  key?: string;
  mode: MetricsMode;
}

export interface ReportedEvent extends EventBase {
  kind: "reported";
  /** Slack user id. */
  reporter: string;
  /** The reporter's display name, when the gate had it; the CLI never asks Slack. */
  reporterName?: string;
  channel: string;
  /** ISO 8601, when the report was posted. */
  reportedAt: string;
}

export interface ClassifiedEvent extends EventBase {
  kind: "classified";
  verdict: string;
  type?: string;
  app?: string;
  priority?: string;
  assignee?: string;
  assigneeKind?: string;
  difficulty?: string;
  storyPoints?: number;
  summary?: string;
  description?: string;
}

/**
 * The fields a person can override at confirmation. `assigneeKind` is who the
 * work goes to by role (the clerk proposes a kind before a person); free text
 * (`summary`, `description`) is a field like any other.
 */
export type OverrideField =
  | "type"
  | "app"
  | "priority"
  | "difficulty"
  | "storyPoints"
  | "assigneeKind"
  | "assignee"
  | "summary"
  | "description";

/** Free-text fields: every edit is unique, so they are rated but never ranked as a common change. */
export const TEXT_OVERRIDE_FIELDS: ReadonlySet<string> = new Set<OverrideField>(["summary", "description"]);

/**
 * One field a person changed at confirmation, kept in full: what the clerk
 * proposed and what the person left. Both values, not just the field name,
 * because the ledger is the corpus the classifier is tuned against later — a
 * count of "priority was changed" says the clerk is wrong, the pairs say how.
 * Summary and description carry both whole texts.
 */
export interface Override {
  field: OverrideField | (string & {});
  /** The clerk's value; null when it proposed none. */
  agent: string | number | null;
  /** The person's final value; null when they cleared it. */
  human: string | number | null;
}

export interface ConfirmedEvent extends EventBase {
  kind: "confirmed";
  by: { accountId: string; displayName?: string };
  /** From the ticket's creation to its confirmation. */
  latencyMs: number;
  overrides: Override[];
}

export interface RejectedEvent extends EventBase {
  kind: "rejected";
}

export interface MovedEvent extends EventBase {
  kind: "moved";
  /** The OA key the intake ticket moved to; a never-real `HELD-…` one for a held move. */
  oaKey: string;
  /** The move was held (`clerk.holdOaMove`): nothing was created on OA (felipearos/ralph#443). */
  held?: boolean;
}

export interface ClosedEvent extends EventBase {
  kind: "closed";
  resolution: string | null;
  status: string;
  /** The OA ticket that closed, when it was the moved one and not the intake ticket (`key`) itself. */
  oaKey?: string;
}

export interface DuplicateEvent extends EventBase {
  kind: "duplicate";
  of: string;
}

export interface IgnoredEvent extends EventBase {
  kind: "ignored";
  reason: string;
}

/**
 * A shadow redo (`clerk/cursor.ts --since … --redo`) dropped this report from
 * the store so it is classified again. Its earlier shadow events describe a
 * classification that no longer stands; `readEvents` drops them, so the
 * redone report counts once, as its new classification.
 */
export interface SupersededEvent extends EventBase {
  kind: "superseded";
}

export type MetricsEvent =
  | ReportedEvent
  | ClassifiedEvent
  | ConfirmedEvent
  | RejectedEvent
  | MovedEvent
  | ClosedEvent
  | DuplicateEvent
  | IgnoredEvent
  | SupersededEvent;

export type MetricsKind = MetricsEvent["kind"];

const KINDS: ReadonlySet<string> = new Set<MetricsKind>([
  "reported",
  "classified",
  "confirmed",
  "rejected",
  "moved",
  "closed",
  "duplicate",
  "ignored",
  "superseded",
]);

/** Under the common dir, beside the clerk store (`clerk/store.ts`). */
export const clerkMetricsRelativePath = (loop: string): string => `ralph/clerk/${loop}.metrics.jsonl`;

/** The `clerkStorePath` rule, with the same fallback outside git. */
export function clerkMetricsPath(loop: string, cwd = process.cwd()): string {
  const out = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  });
  const common = out.status === 0 ? out.stdout.trim() : "";
  return common ? join(common, clerkMetricsRelativePath(loop)) : join(resolve(cwd), ".ralph-clerk", `${loop}.metrics.jsonl`);
}

/** Append one event. Never throws: false means the line was lost, and the caller carries on. */
export function appendEvent(path: string, event: MetricsEvent): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

export interface LedgerRead {
  events: MetricsEvent[];
  /** Lines that were not an event: a half-written last line, or garbage. */
  skippedLines: number;
}

/** A missing ledger is a clerk that has recorded nothing yet, which is not an error. */
export function readEvents(path: string): LedgerRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { events: [], skippedLines: 0 };
  }
  const events: MetricsEvent[] = [];
  let skippedLines = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      // A kill mid-append leaves exactly this; counted so the summary says so.
      skippedLines += 1;
      continue;
    }
    if (isEvent(parsed)) events.push(parsed);
    else skippedLines += 1;
  }
  return { events: withoutSuperseded(events), skippedLines };
}

/**
 * The events that still stand: a report's shadow events before its latest
 * `superseded` marker are dropped, and so are the markers. Done here, where
 * every reader (summary, KPI report, participation) reads the ledger, rather
 * than in each, so none of them can count a redone report twice. Live events
 * are never dropped: a redo runs only in shadow, and what was filed for real
 * stays filed.
 */
export function withoutSuperseded(events: readonly MetricsEvent[]): MetricsEvent[] {
  const lastMarker = new Map<string, number>();
  events.forEach((event, index) => {
    if (event.kind === "superseded") lastMarker.set(event.report, index);
  });
  return events.filter((event, index) => {
    if (event.kind === "superseded") return false;
    const marker = lastMarker.get(event.report);
    return marker === undefined || index > marker || event.mode !== "shadow";
  });
}

function isEvent(value: unknown): value is MetricsEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    event.v === 1 &&
    typeof event.kind === "string" &&
    KINDS.has(event.kind) &&
    typeof event.at === "string" &&
    typeof event.report === "string" &&
    event.report !== "" &&
    (METRICS_MODES as readonly unknown[]).includes(event.mode)
  );
}

/**
 * `duplicate`: the report named work someone had already reported. It is no
 * new work, and no noise either — a second person hitting the same problem is
 * evidence that it is real — so it is counted apart.
 */
export type Outcome = "valuable" | "noise" | "pending" | "duplicate";

/**
 * What one report came to, from its events in ledger order.
 *
 * The latest decisive event wins, because a report can change its mind: an
 * ignored report a person asks to have filed is confirmed later, and a
 * confirmed ticket can still be closed as Won't Do. Valuable needs both a
 * confirmation and a close that kept the work; a close without a confirmation
 * (a ticket someone finished straight off the intake board) stays pending
 * rather than crediting the clerk with a ticket nobody checked.
 */
export function outcomeOf(events: readonly MetricsEvent[], wontDo: readonly string[] = DEFAULT_WONT_DO): Outcome {
  const wont = new Set(wontDo.map(normalise));
  let confirmed = false;
  let outcome: Outcome = "pending";
  for (const event of events) {
    switch (event.kind) {
      case "duplicate":
        confirmed = false;
        outcome = "duplicate";
        break;
      case "ignored":
      case "rejected":
        confirmed = false;
        outcome = "noise";
        break;
      case "confirmed":
        confirmed = true;
        outcome = "pending";
        break;
      case "closed":
        if (event.resolution !== null && wont.has(normalise(event.resolution))) outcome = "noise";
        else outcome = confirmed ? "valuable" : "pending";
        break;
      default:
        break;
    }
  }
  return outcome;
}

const normalise = (resolution: string): string => resolution.trim().toLowerCase();

export type SummaryBy = "reporter" | "app" | "week";

export interface SummaryOptions {
  by: SummaryBy;
  /** YYYY-MM-DD: only reports posted on or after this day in Santiago. */
  since?: string;
  wontDo?: readonly string[];
  /** Only reports whose events were recorded in one of these modes; absent, every mode. */
  modes?: readonly MetricsMode[];
}

export interface SummaryRow {
  /** The reporter's Slack id, the app, or an ISO week such as `2026-W43`. */
  key: string;
  /** The reporter's recorded name, when the `reported` event had one. */
  label?: string;
  reports: number;
  valuable: number;
  noise: number;
  pending: number;
  /** Reports of work already reported: neither valuable nor noise (`Outcome`). */
  duplicates: number;
  /** noise / reports; null with no reports. */
  noiseRate: number | null;
  confirmed: number;
  /** Confirmed tickets with at least one override / confirmed; null with none confirmed. */
  overrideRate: number | null;
  /** How many confirmed tickets had each field overridden. */
  overridesByField: Record<string, number>;
  /** overridesByField / confirmed, per field. */
  overrideRateByField: Record<string, number>;
  /** The most common clerk→person changes of a non-text field, most frequent first. */
  topChanges: ChangeCount[];
  medianConfirmLatencyMs: number | null;
}

export interface ChangeCount {
  field: string;
  agent: string | number | null;
  human: string | number | null;
  count: number;
}

/** How many of the most common changes a row lists. */
export const TOP_CHANGES = 5;

/** The group a report lands in when the field it is grouped by was never recorded. */
export const UNKNOWN_GROUP = "(unknown)";

export function summarise(events: readonly MetricsEvent[], options: SummaryOptions): SummaryRow[] {
  const byReport = new Map<string, MetricsEvent[]>();
  for (const event of events) {
    const list = byReport.get(event.report);
    if (list) list.push(event);
    else byReport.set(event.report, [event]);
  }

  interface Group {
    label?: string;
    reports: number;
    valuable: number;
    noise: number;
    pending: number;
    duplicate: number;
    confirmed: number;
    overridden: number;
    overridesByField: Record<string, number>;
    changes: Map<string, ChangeCount>;
    latencies: number[];
  }
  const groups = new Map<string, Group>();

  for (const reportEvents of byReport.values()) {
    if (options.modes !== undefined && !options.modes.includes(modeOf(reportEvents))) continue;
    const reported = reportEvents.find((event): event is ReportedEvent => event.kind === "reported");
    const postedAt = reported?.reportedAt ?? reportEvents[0]!.at;
    const postedDay = localDay(postedAt);
    if (options.since !== undefined && (postedDay === null || postedDay < options.since)) continue;

    const { key, label } = groupOf(options.by, reportEvents, reported, postedDay);
    let group = groups.get(key);
    if (!group) {
      group = { reports: 0, valuable: 0, noise: 0, pending: 0, duplicate: 0, confirmed: 0, overridden: 0, overridesByField: {}, changes: new Map(), latencies: [] };
      groups.set(key, group);
    }
    if (label !== undefined) group.label = label;
    group.reports += 1;
    group[outcomeOf(reportEvents, options.wontDo)] += 1;

    // A report confirmed twice (re-opened and re-confirmed) counts once, as
    // its latest confirmation: that is the classification the team kept.
    const confirmation = reportEvents.filter((event): event is ConfirmedEvent => event.kind === "confirmed").at(-1);
    if (confirmation) {
      group.confirmed += 1;
      const overrides = (Array.isArray(confirmation.overrides) ? confirmation.overrides : []).filter(
        (override): override is Override => typeof override === "object" && override !== null && typeof override.field === "string",
      );
      const fields = new Set(overrides.map((override) => override.field));
      if (fields.size > 0) group.overridden += 1;
      for (const field of fields) group.overridesByField[field] = (group.overridesByField[field] ?? 0) + 1;
      for (const override of overrides) {
        if (TEXT_OVERRIDE_FIELDS.has(override.field)) continue;
        const agent = override.agent ?? null;
        const human = override.human ?? null;
        const changeKey = JSON.stringify([override.field, agent, human]);
        const change = group.changes.get(changeKey);
        if (change) change.count += 1;
        else group.changes.set(changeKey, { field: override.field, agent, human, count: 1 });
      }
      if (Number.isFinite(confirmation.latencyMs)) group.latencies.push(confirmation.latencyMs);
    }
  }

  const rows: SummaryRow[] = [...groups.entries()].map(([key, group]) => ({
    key,
    ...(group.label !== undefined ? { label: group.label } : {}),
    reports: group.reports,
    valuable: group.valuable,
    noise: group.noise,
    pending: group.pending,
    duplicates: group.duplicate,
    noiseRate: group.reports === 0 ? null : group.noise / group.reports,
    confirmed: group.confirmed,
    overrideRate: group.confirmed === 0 ? null : group.overridden / group.confirmed,
    overridesByField: group.overridesByField,
    overrideRateByField: Object.fromEntries(
      Object.entries(group.overridesByField).map(([field, count]) => [field, count / group.confirmed]),
    ),
    topChanges: [...group.changes.values()]
      .sort((a, b) => b.count - a.count || a.field.localeCompare(b.field) || String(a.agent).localeCompare(String(b.agent)))
      .slice(0, TOP_CHANGES),
    medianConfirmLatencyMs: median(group.latencies),
  }));
  // Weeks read in time order; reporters and apps by volume, the busiest first.
  if (options.by === "week") rows.sort((a, b) => a.key.localeCompare(b.key));
  else rows.sort((a, b) => b.reports - a.reports || a.key.localeCompare(b.key));
  return rows;
}

/**
 * The mode a report was recorded in: its first event's. A clerk flipped from
 * quiet to live mid-report keeps the report where it started, so a test
 * report is never counted as the team's.
 */
export const modeOf = (events: readonly MetricsEvent[]): MetricsMode => events[0]!.mode;

/** How many reports each mode recorded, every mode named even at zero. */
export function reportsByMode(events: readonly MetricsEvent[]): Record<MetricsMode, number> {
  const first = new Map<string, MetricsMode>();
  for (const event of events) if (!first.has(event.report)) first.set(event.report, event.mode);
  const counts = Object.fromEntries(METRICS_MODES.map((mode) => [mode, 0])) as Record<MetricsMode, number>;
  for (const mode of first.values()) counts[mode] += 1;
  return counts;
}

function groupOf(
  by: SummaryBy,
  events: readonly MetricsEvent[],
  reported: ReportedEvent | undefined,
  postedDay: string | null,
): { key: string; label?: string } {
  if (by === "reporter") {
    const key = reported?.reporter || UNKNOWN_GROUP;
    return reported?.reporterName ? { key, label: reported.reporterName } : { key };
  }
  if (by === "app") {
    // The latest classification: a re-classified report belongs to its final app.
    const classified = events.filter((event): event is ClassifiedEvent => event.kind === "classified").at(-1);
    return { key: classified?.app || UNKNOWN_GROUP };
  }
  return { key: postedDay === null ? UNKNOWN_GROUP : isoWeek(postedDay) };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: METRICS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** YYYY-MM-DD in Santiago, or null for a timestamp that does not parse. */
export function localDay(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return dayFormat.format(new Date(ms));
}

/** The ISO 8601 week (`2026-W43`) of a YYYY-MM-DD calendar day. */
export function isoWeek(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const utc = new Date(Date.UTC(year, month - 1, date));
  // The ISO week belongs to the year of its Thursday.
  const weekday = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - weekday);
  const weekYear = utc.getUTCFullYear();
  const week = Math.ceil(((utc.getTime() - Date.UTC(weekYear, 0, 1)) / 86_400_000 + 1) / 7);
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}

/** Who reports, and how recently (felipearos/ralph#459): one row per reporter, the most recent first. */
export interface ParticipationRow {
  /** The reporter's Slack id. */
  key: string;
  label?: string;
  reports: number;
  /** Reports posted in the last 7 and 30 days before `nowMs`. */
  last7Days: number;
  last30Days: number;
  /** The newest report's posting time (ISO), or null when none recorded one. */
  lastReportAt: string | null;
  /** How many distinct ISO weeks (Santiago) the reporter posted in. */
  activeWeeks: number;
}

/**
 * Participation from the `reported` events alone: everyone who has reported,
 * with how often and how lately. Who on a team has never reported needs that
 * team's roster, which the ledger does not hold.
 */
export function participation(events: readonly MetricsEvent[], nowMs: number): ParticipationRow[] {
  const seen = new Set<string>();
  const rows = new Map<string, ParticipationRow & { weeks: Set<string>; lastMs: number }>();
  for (const event of events) {
    if (event.kind !== "reported" || seen.has(event.report)) continue;
    seen.add(event.report);
    const key = event.reporter || UNKNOWN_GROUP;
    let row = rows.get(key);
    if (!row) {
      row = { key, reports: 0, last7Days: 0, last30Days: 0, lastReportAt: null, activeWeeks: 0, weeks: new Set(), lastMs: -Infinity };
      rows.set(key, row);
    }
    if (event.reporterName) row.label = event.reporterName;
    row.reports += 1;
    const ms = Date.parse(event.reportedAt || event.at);
    if (!Number.isFinite(ms)) continue;
    const age = nowMs - ms;
    if (age <= 7 * 86_400_000) row.last7Days += 1;
    if (age <= 30 * 86_400_000) row.last30Days += 1;
    if (ms > row.lastMs) {
      row.lastMs = ms;
      row.lastReportAt = new Date(ms).toISOString();
    }
    const day = localDay(new Date(ms).toISOString());
    if (day !== null) row.weeks.add(isoWeek(day));
  }
  return [...rows.values()]
    .map(({ weeks, lastMs: _lastMs, ...row }) => ({ ...row, activeWeeks: weeks.size }))
    .sort((a, b) => (b.lastReportAt ?? "").localeCompare(a.lastReportAt ?? "") || a.key.localeCompare(b.key));
}

/** The fields the clerk proposes and a confirmer may correct, in the order the precision tab lists them. */
export const PRECISION_FIELDS = ["type", "priority", "app", "difficulty", "storyPoints", "assigneeKind", "summary", "description"] as const;

/** How many single corrections the precision view lists, newest first. */
export const PRECISION_CORRECTIONS = 200;

export interface PrecisionFieldRow {
  field: string;
  /** Confirmed tickets the clerk proposed this field for. */
  confirmed: number;
  /** How many of them the confirmer changed it on. */
  corrected: number;
  /** Share left as proposed; null with nothing confirmed. */
  precision: number | null;
  /** The commonest agent-to-person changes; empty for free text, where every edit is unique. */
  topChanges: { agent: string | number | null; human: string | number | null; count: number }[];
}

export interface PrecisionWeekRow {
  /** ISO week (Santiago) the ticket was confirmed in. */
  week: string;
  confirmed: number;
  /** Confirmed with no field changed. */
  exact: number;
  precision: number | null;
  /** How many tickets had each field corrected that week. */
  correctedByField: Record<string, number>;
}

export interface PrecisionCorrection {
  key: string;
  report: string;
  at: string;
  by: string | null;
  field: string;
  agent: string | number | null;
  human: string | number | null;
}

export interface PrecisionView {
  /** Confirmed tickets the clerk had a determination for: the ones it can be wrong about. */
  confirmed: number;
  /** Of them, confirmed exactly as proposed. */
  exact: number;
  precision: number | null;
  byField: PrecisionFieldRow[];
  byWeek: PrecisionWeekRow[];
  corrections: PrecisionCorrection[];
}

const share = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

/**
 * How precise the clerk's proposals are, from the `confirmed` events: every
 * correction a confirmer made is a field the clerk got wrong. A ticket filed
 * by hand (its key stands in for the report) had no proposal to compare, so
 * it is left out; a ticket confirmed twice counts once, by its latest
 * confirmation.
 */
export function precision(events: readonly MetricsEvent[]): PrecisionView {
  const latest = new Map<string, ConfirmedEvent & { key: string }>();
  for (const event of events) {
    if (event.kind !== "confirmed" || event.key === undefined || event.report === event.key) continue;
    const prior = latest.get(event.key);
    if (prior === undefined || prior.at <= event.at) latest.set(event.key, { ...event, key: event.key });
  }
  const confirmed = [...latest.values()];
  const byField = PRECISION_FIELDS.map((field): PrecisionFieldRow => {
    const changes = new Map<string, { agent: string | number | null; human: string | number | null; count: number }>();
    let corrected = 0;
    for (const event of confirmed) {
      const override = event.overrides.find((one) => one.field === field);
      if (override === undefined) continue;
      corrected += 1;
      if (TEXT_OVERRIDE_FIELDS.has(field)) continue;
      const id = JSON.stringify([override.agent, override.human]);
      const change = changes.get(id) ?? { agent: override.agent, human: override.human, count: 0 };
      change.count += 1;
      changes.set(id, change);
    }
    return {
      field,
      confirmed: confirmed.length,
      corrected,
      precision: share(confirmed.length - corrected, confirmed.length),
      topChanges: [...changes.values()].sort((a, b) => b.count - a.count).slice(0, 5),
    };
  });
  const weeks = new Map<string, PrecisionWeekRow>();
  for (const event of confirmed) {
    const day = localDay(event.at);
    const week = day === null ? UNKNOWN_GROUP : isoWeek(day);
    const row = weeks.get(week) ?? { week, confirmed: 0, exact: 0, precision: null, correctedByField: {} };
    row.confirmed += 1;
    if (event.overrides.length === 0) row.exact += 1;
    for (const override of event.overrides) row.correctedByField[override.field] = (row.correctedByField[override.field] ?? 0) + 1;
    weeks.set(week, row);
  }
  const exact = confirmed.filter((event) => event.overrides.length === 0).length;
  return {
    confirmed: confirmed.length,
    exact,
    precision: share(exact, confirmed.length),
    byField,
    byWeek: [...weeks.values()].map((row) => ({ ...row, precision: share(row.exact, row.confirmed) })).sort((a, b) => b.week.localeCompare(a.week)),
    corrections: confirmed
      .flatMap((event) =>
        event.overrides.map((override) => ({ key: event.key, report: event.report, at: event.at, by: event.by.displayName ?? null, field: override.field, agent: override.agent, human: override.human })),
      )
      .sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key))
      .slice(0, PRECISION_CORRECTIONS),
  };
}
