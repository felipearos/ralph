/**
 * The clerk's daily KPI report (felipearos/ralph#453, spec #443): what the
 * intake channel sent, what the team confirmed, what was signal and what was
 * noise, what got delivered, and who in the channel has gone quiet — built
 * from the metrics ledger (`clerk/metrics.ts`) and DMed by the clerk's bot.
 *
 * **Who gets it.** A draft (`kpiReport.mode: "draft"`, the default) goes to
 * `clerk.operator` alone, so nobody on the team reads a number the operator
 * has not checked. `send` reaches `recipients` — but only while the clerk is
 * live: in shadow the report is a draft whatever the switch says, because
 * shadow promises the team sees nothing of the clerk. `channels` are posted
 * in exactly when `recipients` are DMed, never with a draft.
 *
 * **When.** Once per local day, at the first gate poll on or after
 * `kpiReport.time` in `kpiReport.timezone` (Monday to Friday with
 * `weekdays`). The day, the rendered text and who it reached are recorded in a
 * small state file beside the ledger, so a restart re-sends nothing that went
 * out, a missed 09:00 sends late rather than never, and a retry sends the very
 * text the first attempt rendered.
 *
 * **Failure.** Everything here is an observation the clerk can do without. A
 * Slack read that fails is a line in the report saying the data was not
 * available; a send that fails is a note in the supervisor log and a retry at
 * the next poll, and so is a channel post the bot is not a member for. Nothing throws out of `sendDueReport`, and a refused scope
 * never stops the loop the way a refusal of the clerk's own calls does.
 *
 * The text is Spanish, short, and carries no emoji, as everything the bot writes.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import type { ClerkMode, KpiReportRules } from "../project-config";
import {
  DEFAULT_WONT_DO,
  TEXT_OVERRIDE_FIELDS,
  outcomeOf,
  readEvents,
  type ChangeCount,
  type ClassifiedEvent,
  type ConfirmedEvent,
  type MetricsEvent,
  type ReportedEvent,
} from "./metrics";
import { SlackError, type SlackClient } from "./slack";

/* --------------------------------------------------------------------------
 * Calendar: local days in the report's time zone.
 * ----------------------------------------------------------------------- */

export interface LocalNow {
  /** YYYY-MM-DD. */
  day: string;
  /** 1 Monday … 7 Sunday. */
  weekday: number;
  /** Minutes since local midnight. */
  minutes: number;
}

const WEEKDAYS: Readonly<Record<string, number>> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function localNow(ms: number, timeZone: string): LocalNow {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAYS[parts.weekday ?? ""] ?? 1,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** YYYY-MM-DD in `timeZone`, or null for a timestamp that does not parse. */
export function dayIn(iso: string, timeZone: string): string | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? localNow(ms, timeZone).day : null;
}

/** A calendar day `delta` days from `day`. */
export function addDays(day: string, delta: number): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + delta)).toISOString().slice(0, 10);
}

const weekdayOf = (day: string): number => new Date(`${day}T12:00:00Z`).getUTCDay() || 7;

const minutesOf = (time: string): number => {
  const [hours = "0", minutes = "0"] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
};

const isSendDay = (weekday: number, rules: Pick<KpiReportRules, "weekdays">): boolean => !rules.weekdays || weekday <= 5;

/**
 * The local day a report is due for at `ms`, or null when none is: before
 * `time`, or on a weekend with `weekdays`. Whether it was already sent is the
 * state's business, not this one's.
 */
export function dueDay(ms: number, rules: Pick<KpiReportRules, "time" | "timezone" | "weekdays">): string | null {
  const now = localNow(ms, rules.timezone);
  if (!isSendDay(now.weekday, rules)) return null;
  return now.minutes >= minutesOf(rules.time) ? now.day : null;
}

/**
 * The days a report for `day` covers: from the previous send day through
 * yesterday. A Tuesday report covers Monday; with `weekdays`, a Monday report
 * covers Friday to Sunday, so Friday's reports are never in nobody's report.
 */
export function reportWindow(day: string, rules: Pick<KpiReportRules, "weekdays">): { from: string; to: string } {
  let from = addDays(day, -1);
  while (!isSendDay(weekdayOf(from), rules)) from = addDays(from, -1);
  return { from, to: addDays(day, -1) };
}

/* --------------------------------------------------------------------------
 * The numbers, from the ledger.
 * ----------------------------------------------------------------------- */

/** What the channel's members came to, or why they could not be read. */
export type Members =
  | {
      ok: true;
      /** The channel's members now, bots excluded. */
      current: string[];
      /** The members at the last report; null when there was none to compare with. */
      previous: string[] | null;
    }
  | { ok: false; why: string };

export interface KpiInput {
  /** The local day the report is for (it covers `window`). */
  day: string;
  window: { from: string; to: string };
  timezone: string;
  quietDays: number;
  members: Members;
  wontDo?: readonly string[];
  /** `clerk.kpiReport.exclude`: named in no per-person line, still counted in the totals. */
  exclude?: readonly string[];
}

export type IntakeStatus = "filed" | "ignored" | "duplicate" | "unclassified";

export interface KpiData {
  day: string;
  window: { from: string; to: string };
  intake: {
    reports: number;
    byApp: Record<string, number>;
    byReporter: Record<string, number>;
    status: Record<IntakeStatus, number>;
  };
  confirmation: {
    confirmed: number;
    rejected: number;
    medianConfirmLatencyMs: number | null;
    /** As `clerk-metrics.ts --json` names it: confirmations with the field overridden / confirmations. */
    overrideRateByField: Record<string, number>;
    topChanges: ChangeCount[];
  };
  /**
   * Per reporter, over the last `SIGNAL_DAYS` days: what their reports came to.
   * `storyPoints` sums only valuable reports (closed as work done), at their
   * final value: points on a pending, rejected or won't-do ticket are work
   * that never happened, so they would credit a reporter for noise.
   */
  signal: { reporter: string; reports: number; valuable: number; noise: number; pending: number; duplicate: number; storyPoints: number }[];
  delivery: {
    /** Of the reports filed in the window: who does the work. */
    assignee: Record<string, number>;
    /** Tickets closed in the window with a resolution that kept the work. */
    done: number;
    storyPointsClosed: number;
    /** Every filed ticket still open, by difficulty. */
    backlogByDifficulty: Record<string, number>;
  };
  participation:
    | { ok: true; quietDays: number; quiet: string[]; joined: string[]; left: string[]; compared: boolean }
    | { ok: false; why: string };
}

/** How far back signal versus noise looks: a day's reports are mostly still pending, a month's are not. */
export const SIGNAL_DAYS = 30;

const NOT_RECORDED = "sin dato";

const bump = (record: Record<string, number>, key: string, by = 1): void => {
  record[key] = (record[key] ?? 0) + by;
};

/** A report's field as it stands: the confirmer's value when they overrode it, else the clerk's. */
function finalField(events: readonly MetricsEvent[], field: "app" | "difficulty" | "storyPoints" | "assigneeKind"): string | number | null {
  const classified = events.filter((event): event is ClassifiedEvent => event.kind === "classified").at(-1);
  const confirmed = events.filter((event): event is ConfirmedEvent => event.kind === "confirmed").at(-1);
  // `assignee` carries the kind (agent | person) in the plan's vocabulary; `assigneeKind` is the ledger's own name for it.
  const names = field === "assigneeKind" ? ["assigneeKind", "assignee"] : [field];
  const override = (Array.isArray(confirmed?.overrides) ? confirmed.overrides : []).find((entry) => names.includes(entry.field));
  if (override !== undefined) return override.human;
  if (classified === undefined) return null;
  if (field === "assigneeKind") return classified.assigneeKind ?? classified.assignee ?? null;
  return classified[field] ?? null;
}

function statusOf(events: readonly MetricsEvent[]): IntakeStatus {
  if (events.some((event) => event.kind === "duplicate")) return "duplicate";
  const classified = events.filter((event): event is ClassifiedEvent => event.kind === "classified").at(-1);
  if (events.some((event) => event.kind === "ignored") || classified?.verdict === "ignore") return "ignored";
  return classified === undefined ? "unclassified" : "filed";
}

const inWindow = (day: string | null, window: { from: string; to: string }): boolean => day !== null && day >= window.from && day <= window.to;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function buildKpi(events: readonly MetricsEvent[], input: KpiInput): KpiData {
  const { window, timezone } = input;
  const wontDo = input.wontDo ?? DEFAULT_WONT_DO;
  const wont = new Set(wontDo.map((resolution) => resolution.trim().toLowerCase()));
  const byReport = new Map<string, MetricsEvent[]>();
  for (const event of events) {
    const list = byReport.get(event.report);
    if (list) list.push(event);
    else byReport.set(event.report, [event]);
  }

  const intake: KpiData["intake"] = { reports: 0, byApp: {}, byReporter: {}, status: { filed: 0, ignored: 0, duplicate: 0, unclassified: 0 } };
  const delivery: KpiData["delivery"] = { assignee: {}, done: 0, storyPointsClosed: 0, backlogByDifficulty: {} };
  let confirmedCount = 0;
  let rejected = 0;
  const latencies: number[] = [];
  const overriddenByField: Record<string, number> = {};
  const changes = new Map<string, ChangeCount>();
  const signal = new Map<string, { reports: number; valuable: number; noise: number; pending: number; duplicate: number; storyPoints: number }>();
  const lastReportBy = new Map<string, string>();
  const signalFrom = addDays(input.day, -SIGNAL_DAYS);
  const excluded = new Set(input.exclude ?? []);

  for (const reportEvents of byReport.values()) {
    const reported = reportEvents.find((event): event is ReportedEvent => event.kind === "reported");
    const postedDay = dayIn(reported?.reportedAt ?? reportEvents[0]!.at, timezone);
    const reporter = reported?.reporter || NOT_RECORDED;
    const status = statusOf(reportEvents);
    const outcome = outcomeOf(reportEvents, wontDo);

    if (reported !== undefined && postedDay !== null && postedDay < input.day) {
      const last = lastReportBy.get(reporter);
      if (last === undefined || postedDay > last) lastReportBy.set(reporter, postedDay);
    }

    if (inWindow(postedDay, window)) {
      intake.reports += 1;
      intake.status[status] += 1;
      if (!excluded.has(reporter)) bump(intake.byReporter, reporter);
      bump(intake.byApp, String(finalField(reportEvents, "app") ?? NOT_RECORDED));
      if (status === "filed") bump(delivery.assignee, String(finalField(reportEvents, "assigneeKind") ?? NOT_RECORDED));
    }

    if (postedDay !== null && postedDay >= signalFrom && postedDay < input.day && !excluded.has(reporter)) {
      const row = signal.get(reporter) ?? { reports: 0, valuable: 0, noise: 0, pending: 0, duplicate: 0, storyPoints: 0 };
      row.reports += 1;
      row[outcome] += 1;
      if (outcome === "valuable") {
        const points = finalField(reportEvents, "storyPoints");
        if (typeof points === "number" && Number.isFinite(points)) row.storyPoints += points;
      }
      signal.set(reporter, row);
    }

    for (const event of reportEvents) {
      const eventDay = dayIn(event.at, timezone);
      if (!inWindow(eventDay, window)) continue;
      if (event.kind === "rejected") rejected += 1;
      if (event.kind === "confirmed") {
        confirmedCount += 1;
        if (Number.isFinite(event.latencyMs)) latencies.push(event.latencyMs);
        const overrides = (Array.isArray(event.overrides) ? event.overrides : []).filter(
          (override) => typeof override === "object" && override !== null && typeof override.field === "string",
        );
        for (const field of new Set(overrides.map((override) => override.field))) bump(overriddenByField, field);
        for (const override of overrides) {
          if (TEXT_OVERRIDE_FIELDS.has(override.field)) continue;
          const key = JSON.stringify([override.field, override.agent ?? null, override.human ?? null]);
          const change = changes.get(key);
          if (change) change.count += 1;
          else changes.set(key, { field: override.field, agent: override.agent ?? null, human: override.human ?? null, count: 1 });
        }
      }
      if (event.kind === "closed" && !(event.resolution !== null && wont.has(event.resolution.trim().toLowerCase()))) {
        delivery.done += 1;
        const points = finalField(reportEvents, "storyPoints");
        if (typeof points === "number" && Number.isFinite(points)) delivery.storyPointsClosed += points;
      }
    }

    // Open: filed, and nothing since has closed, rejected or marked it noise.
    const finished = reportEvents.some((event) => event.kind === "closed" || event.kind === "rejected");
    if (status === "filed" && !finished) bump(delivery.backlogByDifficulty, String(finalField(reportEvents, "difficulty") ?? NOT_RECORDED));
  }

  let participation: KpiData["participation"];
  if (input.members.ok) {
    const current = input.members.current.filter((member) => !excluded.has(member));
    const previous = input.members.previous?.filter((member) => !excluded.has(member)) ?? null;
    const quietFrom = addDays(input.day, -input.quietDays);
    const quiet = current.filter((member) => {
      const last = lastReportBy.get(member);
      return last === undefined || last < quietFrom;
    });
    participation = {
      ok: true,
      quietDays: input.quietDays,
      quiet,
      joined: previous === null ? [] : current.filter((member) => !previous.includes(member)),
      left: previous === null ? [] : previous.filter((member) => !current.includes(member)),
      compared: previous !== null,
    };
  } else participation = { ok: false, why: input.members.why };

  return {
    day: input.day,
    window,
    intake,
    confirmation: {
      confirmed: confirmedCount,
      rejected,
      medianConfirmLatencyMs: median(latencies),
      overrideRateByField: Object.fromEntries(Object.entries(overriddenByField).map(([field, count]) => [field, count / confirmedCount])),
      topChanges: [...changes.values()].sort((a, b) => b.count - a.count || a.field.localeCompare(b.field)).slice(0, 5),
    },
    signal: [...signal.entries()]
      .map(([reporter, row]) => ({ reporter, ...row }))
      .sort((a, b) => b.reports - a.reports || a.reporter.localeCompare(b.reporter)),
    delivery,
    participation,
  };
}

/* --------------------------------------------------------------------------
 * The text.
 * ----------------------------------------------------------------------- */

/** How the report is framed: a draft says so, and says who it would have gone to. */
export interface Framing {
  draft: boolean;
  /** Why it is a draft, when it is one. */
  draftWhy?: string;
  recipients: readonly string[];
  /** The channels a sent report would also be posted in. */
  channels?: readonly string[];
}

const FIELD_NAMES: Readonly<Record<string, string>> = {
  type: "tipo",
  app: "app",
  priority: "prioridad",
  difficulty: "dificultad",
  storyPoints: "puntos",
  assigneeKind: "responsable",
  assignee: "responsable",
  summary: "resumen",
  description: "descripción",
};

const STATUS_NAMES: Readonly<Record<IntakeStatus, string>> = {
  filed: "registrados",
  ignored: "ignorados",
  duplicate: "duplicados",
  unclassified: "sin clasificar",
};

const ASSIGNEE_NAMES: Readonly<Record<string, string>> = { agent: "agente", person: "persona" };

/** A Slack user id as a mention, which the DM shows as the person's name; anything else as it is. */
const who = (id: string): string => (/^[UW][A-Z0-9]+$/.test(id) ? `<@${id}>` : id);

const percent = (rate: number): string => `${Math.round(rate * 100)}%`;

function duration(ms: number | null): string {
  if (ms === null) return "sin datos";
  const minutes = ms / 60_000;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  return hours < 48 ? `${hours.toFixed(1)} h` : `${(hours / 24).toFixed(1)} días`;
}

const counts = (record: Record<string, number>, name: (key: string) => string = (key) => key): string => {
  const entries = Object.entries(record).filter(([, count]) => count > 0);
  if (entries.length === 0) return "ninguno";
  return entries
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([key, count]) => `${name(key)} ${count}`)
    .join(", ");
};

const shown = (value: string | number | null): string => (value === null ? "vacío" : String(value));

const list = (ids: readonly string[]): string => (ids.length === 0 ? "nadie" : ids.map(who).join(", "));

export function renderKpi(data: KpiData, framing: Framing): string {
  const period = data.window.from === data.window.to ? data.window.from : `${data.window.from} a ${data.window.to}`;
  const lines: string[] = [];
  if (framing.draft) {
    const to = framing.recipients.length === 0 ? "sin destinatarios configurados" : `destinatarios configurados: ${list(framing.recipients)}`;
    const channels = framing.channels ?? [];
    const into = channels.length === 0 ? "" : `; canales configurados: ${channels.map((id) => `<#${id}>`).join(", ")}`;
    lines.push(`_Borrador, solo para el operador${framing.draftWhy ? ` (${framing.draftWhy})` : ""}; ${to}${into}._`, "");
  }
  lines.push(`*Reporte diario de intake, ${data.day}* (periodo: ${period})`, "");

  const { intake } = data;
  lines.push("*Volumen*");
  lines.push(`- Reportes recibidos: ${intake.reports}`);
  lines.push(`- Por app: ${counts(intake.byApp)}`);
  lines.push(`- Por persona: ${counts(intake.byReporter, who)}`);
  lines.push(`- Resultado: ${(Object.keys(STATUS_NAMES) as IntakeStatus[]).filter((status) => status !== "unclassified" || intake.status[status] > 0).map((status) => `${intake.status[status]} ${STATUS_NAMES[status]}`).join(", ")}`);
  lines.push("");

  const { confirmation } = data;
  lines.push("*Confirmación*");
  lines.push(`- Confirmados: ${confirmation.confirmed}; descartados: ${confirmation.rejected}`);
  lines.push(`- Tiempo mediano hasta confirmar: ${duration(confirmation.medianConfirmLatencyMs)}`);
  const rates = Object.entries(confirmation.overrideRateByField).sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  lines.push(`- Correcciones por campo: ${rates.length === 0 ? "ninguna" : rates.map(([field, rate]) => `${FIELD_NAMES[field] ?? field} ${percent(rate)}`).join(", ")}`);
  lines.push(
    `- Cambios más comunes: ${
      confirmation.topChanges.length === 0
        ? "ninguno"
        : confirmation.topChanges.map((change) => `${FIELD_NAMES[change.field] ?? change.field} ${shown(change.agent)} a ${shown(change.human)} (${change.count})`).join("; ")
    }`,
  );
  lines.push("");

  lines.push(`*Señal y ruido* (últimos ${SIGNAL_DAYS} días)`);
  if (data.signal.length === 0) lines.push("- Sin reportes en el periodo");
  for (const row of data.signal) {
    const decided = row.valuable + row.noise;
    const share = decided === 0 ? "sin resultados aún" : `${percent(row.valuable / decided)} valiosos`;
    const duplicates = row.duplicate === 0 ? "" : `, ${row.duplicate} ya reportados`;
    lines.push(`- ${who(row.reporter)}: ${row.reports} reportes, ${row.valuable} valiosos, ${row.noise} ruido, ${row.pending} pendientes, ${row.storyPoints} puntos${duplicates} (${share})`);
  }
  lines.push("");

  const { delivery } = data;
  lines.push("*Entrega*");
  lines.push(`- Responsable de lo registrado: ${counts(delivery.assignee, (key) => ASSIGNEE_NAMES[key] ?? key)}`);
  lines.push(`- Tickets terminados: ${delivery.done}; puntos de historia cerrados: ${delivery.storyPointsClosed}`);
  lines.push(`- Pendientes por dificultad: ${counts(delivery.backlogByDifficulty)}`);
  lines.push("");

  lines.push("*Participación*");
  const { participation } = data;
  if (!participation.ok) {
    lines.push(`- Datos de miembros del canal no disponibles (${participation.why})`);
  } else {
    lines.push(`- Sin reportes en los últimos ${participation.quietDays} días: ${list(participation.quiet)}`);
    if (participation.compared) {
      lines.push(`- Se unieron al canal desde el último reporte: ${list(participation.joined)}`);
      lines.push(`- Salieron del canal desde el último reporte: ${list(participation.left)}`);
    } else lines.push("- Altas y bajas del canal: sin reporte anterior con que comparar");
  }
  return lines.join("\n");
}

/** `buildKpi` and `renderKpi` in one, for a caller with nothing to add between them. */
export const kpiText = (events: readonly MetricsEvent[], input: KpiInput, framing: Framing): string => renderKpi(buildKpi(events, input), framing);

/* --------------------------------------------------------------------------
 * Who it goes to.
 * ----------------------------------------------------------------------- */

export interface Targets {
  /** The Slack user ids the report is DMed to today. */
  to: string[];
  /** The channels it is posted in today: none for a draft. */
  channels: string[];
  draft: boolean;
  draftWhy?: string;
}

/**
 * Draft goes to the operator only. `send` reaches the recipients, and the
 * channels, only while the clerk is live: in shadow or quiet it is a draft to
 * the operator, whatever the switch says — the one rule here that no config
 * can turn off.
 */
export function targetsFor(rules: KpiReportRules, clerkMode: ClerkMode, operator: string | null): Targets {
  if (rules.mode === "send" && clerkMode === "live") return { to: [...new Set(rules.recipients)], channels: [...new Set(rules.channels)], draft: false };
  const draftWhy = rules.mode === "send" ? `clerk en modo ${clerkMode}: no se envía a los destinatarios` : undefined;
  return { to: operator === null ? [] : [operator], channels: [], draft: true, ...(draftWhy === undefined ? {} : { draftWhy }) };
}

/** What Slack answers a post in a channel the bot was never invited to: public, and private (which it cannot even see). */
const NOT_A_MEMBER: ReadonlySet<string> = new Set(["not_in_channel", "channel_not_found"]);

/* --------------------------------------------------------------------------
 * State: which day was sent, to whom, with what text.
 * ----------------------------------------------------------------------- */

export interface KpiState {
  v: 1;
  /** The local day the stored report is for; null before the first. */
  day: string | null;
  /** That day's text, rendered once, so a retry sends exactly what the first attempt did. */
  text: string | null;
  /** Who that day's report reached: user ids, and the ids of the channels it was posted in. */
  sentTo: string[];
  /** The channel's members at the last report that could read them, for who joined and who left. */
  members: string[] | null;
}

export const emptyKpiState = (): KpiState => ({ v: 1, day: null, text: null, sentTo: [], members: null });

/** Beside the clerk's store and ledger, in Git's common dir, so a recreated worktree does not send twice. */
export const clerkKpiRelativePath = (loop: string): string => `ralph/clerk/${loop}.kpi.json`;

export function clerkKpiStatePath(loop: string, cwd = process.cwd()): string {
  const out = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  });
  const common = out.status === 0 ? out.stdout.trim() : "";
  return common ? join(common, clerkKpiRelativePath(loop)) : join(resolve(cwd), ".ralph-clerk", `${loop}.kpi.json`);
}

/** An unreadable state is an empty one: at worst one report goes out again, which beats none going out ever. */
export function readKpiState(path: string): KpiState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<KpiState>;
    if (parsed.v !== 1) return emptyKpiState();
    return {
      v: 1,
      day: typeof parsed.day === "string" ? parsed.day : null,
      text: typeof parsed.text === "string" ? parsed.text : null,
      sentTo: Array.isArray(parsed.sentTo) ? parsed.sentTo.filter((id): id is string => typeof id === "string") : [],
      members: Array.isArray(parsed.members) ? parsed.members.filter((id): id is string => typeof id === "string") : null,
    };
  } catch {
    return emptyKpiState();
  }
}

/** Written whole through a rename, so a kill mid-write leaves the last state, not half of one. False when it could not be. */
export function writeKpiState(path: string, state: KpiState): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(temp, path);
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------------------
 * The send, from the gate's poll.
 * ----------------------------------------------------------------------- */

export interface KpiDeps {
  rules: KpiReportRules;
  clerkMode: ClerkMode;
  operator: string | null;
  channel: string;
  /**
   * `clerk.ignoreUsers`: the team members who work the tickets. They are not
   * reporters, so they are left out of the members the report counts — never
   * listed as quiet, joined or left.
   */
  ignoreUsers?: readonly string[];
  metricsPath: string;
  statePath: string;
  /**
   * What this process already finished, kept here as well as in the state:
   * a state file that cannot be written must not turn every poll into
   * another DM.
   */
  memo: { doneDay: string | null };
}

/** The most members whose bot flag is looked up: one `users.info` each, and a poll must not spend minutes on a summary. */
export const MEMBER_LOOKUP_CAP = 200;

async function readMembers(slack: SlackClient, channel: string, previous: string[] | null, ignore: readonly string[] = []): Promise<Members> {
  try {
    const all = (await slack.channelMembers(channel)).filter((member) => !ignore.includes(member));
    const humans: string[] = [];
    for (const member of all.slice(0, MEMBER_LOOKUP_CAP)) {
      let bot = false;
      try {
        bot = await slack.isBot(member);
      } catch {
        // One profile that cannot be read is a person counted, not a report lost.
      }
      if (!bot) humans.push(member);
    }
    return { ok: true, current: humans, previous };
  } catch (error) {
    return { ok: false, why: (error as Error).message };
  }
}

/**
 * Send today's report if it is due and has not reached everyone it is for.
 * Never throws: every outcome is a note for the supervisor log, and an empty
 * list when there was nothing to do.
 */
export async function sendDueReport(deps: KpiDeps, slack: SlackClient, nowMs: number): Promise<string[]> {
  try {
    const targets = targetsFor(deps.rules, deps.clerkMode, deps.operator);
    // Said on every poll, as the config check said at startup: the report is
    // off, and the log is where the operator looks for why it never came.
    if (targets.to.length === 0 && targets.channels.length === 0) return ["kpi report off — 'clerk.operator' is not set, and a draft goes to the operator alone; set it to turn the report on"];
    const day = dueDay(nowMs, deps.rules);
    if (day === null || deps.memo.doneDay === day) return [];
    const stored = readKpiState(deps.statePath);
    let state = stored;
    const notes: string[] = [];
    if (stored.day !== day || stored.text === null) {
      const members = await readMembers(slack, deps.channel, stored.members, deps.ignoreUsers);
      const { events } = readEvents(deps.metricsPath);
      const text = kpiText(
        events,
        { day, window: reportWindow(day, deps.rules), timezone: deps.rules.timezone, quietDays: deps.rules.quietDays, members, exclude: deps.rules.exclude ?? [] },
        {
          draft: targets.draft,
          ...(targets.draftWhy === undefined ? {} : { draftWhy: targets.draftWhy }),
          recipients: deps.rules.recipients,
          channels: deps.rules.channels,
        },
      );
      state = { v: 1, day, text, sentTo: [], members: members.ok ? members.current : stored.members };
      if (!writeKpiState(deps.statePath, state)) notes.push(`kpi report state ${deps.statePath} could not be written; a restart today may send it again`);
    }
    const pending = targets.to.filter((user) => !state.sentTo.includes(user));
    const sent: string[] = [];
    const failed: string[] = [];
    for (const user of pending) {
      try {
        const dm = await slack.openDm(user);
        await slack.postMessage(dm, state.text!);
        state = { ...state, sentTo: [...state.sentTo, user] };
        sent.push(user);
        // After each one, so a send that fails halfway re-sends to nobody it reached.
        writeKpiState(deps.statePath, state);
      } catch (error) {
        failed.push(`${user}: ${(error as Error).message}`);
      }
    }
    // Channel ids and user ids never collide (C/G against U/W), so one
    // `sentTo` keeps both once per day.
    const posted: string[] = [];
    const unposted: string[] = [];
    for (const channel of targets.channels.filter((id) => !state.sentTo.includes(id))) {
      try {
        await slack.postMessage(channel, state.text!);
        state = { ...state, sentTo: [...state.sentTo, channel] };
        posted.push(channel);
        writeKpiState(deps.statePath, state);
      } catch (error) {
        const code = error instanceof SlackError && "code" in error.failure ? error.failure.code : undefined;
        unposted.push(
          code !== undefined && NOT_A_MEMBER.has(code)
            ? `kpi report for ${day} not posted in ${channel}: the bot is not a member (${code}); invite the clerk's bot to ${channel} (/invite in the channel) — retried at the next poll`
            : `kpi report for ${day} not posted in ${channel}: ${(error as Error).message}; check that the clerk's bot is invited to ${channel} — retried at the next poll`,
        );
      }
    }
    const kind = targets.draft ? "draft" : "report";
    if (sent.length > 0) notes.push(`kpi ${kind} for ${day} sent to ${sent.join(", ")}`);
    if (posted.length > 0) notes.push(`kpi report for ${day} posted in ${posted.join(", ")}`);
    if (failed.length > 0) notes.push(`kpi ${kind} for ${day} not sent to ${failed.join("; ")} — retried at the next poll`);
    notes.push(...unposted);
    if (failed.length === 0 && unposted.length === 0) deps.memo.doneDay = day;
    return notes;
  } catch (error) {
    return [`kpi report not sent — ${(error as Error).message}; retried at the next poll`];
  }
}
