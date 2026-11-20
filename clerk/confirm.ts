/**
 * The confirmation sweep on the clerk's Jira intake board (felipearos/ralph#443,
 * #449).
 *
 * The clerk files every report into "Por confirmar". A person reviews it,
 * edits whatever the clerk got wrong, and moves it to "Confirmado" — or to
 * "Descartado". On every poll the gate runs this sweep, which acts on what that
 * person decided, and records it in the metrics ledger:
 *
 * - **to-agent** — confirmed with `para-agente`: `ready-for-agent` is added on
 *   the board, the frontier's `READY_LABEL`, and the backoffice coder loops
 *   take it from there. This replaces the `agent-proposed` approval for this
 *   pipeline.
 * - **to-person** — confirmed with `para-persona`, or with neither label: the
 *   ticket moves to the person board (OA) through `triage/handoff.ts`
 *   `moveToJira`, and the intake ticket is closed as "Movido".
 * - **rejected** — "Descartado": nothing is written; the ledger counts it as
 *   noise.
 *
 * Every field the person changed against what the clerk set (the store's
 * determination snapshot, #447) is an override, kept whole in the `confirmed`
 * event with both values: the ledger is the corpus the classifier is tuned
 * against later.
 *
 * Nothing here may stop or hang the gate. A Jira failure is a note and a retry
 * on the next poll; a status name the board does not have is a search that
 * finds nothing or a note; a denial is returned for the gate to treat as it
 * treats every other. Idempotent across restarts: the labels fence a live
 * ticket, the store's `confirmed` record keeps each event from being written
 * twice, and the move itself is `moveToJira`'s idempotent one.
 *
 * Shadow holds a read-only view of Jira (`readOnly`): no write method is
 * reachable from it. What live would do is recorded in the store's shadow
 * record and the poll's notes, and the ledger events are marked shadow.
 *
 * Quiet (felipearos/ralph#443) writes the intake board as live does. Either
 * may hold the move to the team's board (`clerk.holdOaMove`, on by default in
 * quiet): a ticket confirmed for a person stays in the confirmed status,
 * labelled `para-mover-a-oa` (`HOLD_LABEL`), and its `moved` event is marked
 * held, with a never-real `HELD-…` key.
 */
import type { AppLabels } from "../triage/intake";
import { clerkAppLabels, clerkJira, type ClerkMode, type ClerkRules, type ClerkStatus, type TriageJira } from "../project-config";
import type { Denial } from "./gate";
import { DIFFICULTY_LABEL_PREFIX, HOLD_LABEL, INTAKE_LABEL, MOVED_LABEL, POSSIBLE_DUPLICATE_LABEL, heldMovedKey } from "./apply";
import { JiraError, jqlString, type JiraClient, type JiraIssue, type JiraStatusChange } from "./jira";
import type { MetricsEvent, Override } from "./metrics";
import { assigneeOfLabels, clip, SUMMARY_MAX, TYPES, type App, type IssueType } from "./plan";
import { withClerkStore, type ClerkStore, type ConfirmedRecord, type Determination } from "./store";
import { READY_FOR_AGENT_LABEL } from "../triage/intake";
import { moveToJira, strippedDescription, type HandoffFields } from "../triage/handoff";

/** The most confirmed or rejected tickets one poll acts on, oldest first: the rest wait for the next poll. */
export const CONFIRM_PER_POLL = 10;

/**
 * How many tickets the sweep's search reads, most recently updated first.
 * Rejected tickets carry no label to fence them out of the search, so a
 * board's old rejections fall out of this window as newer tickets move,
 * rather than crowding the poll's cap for ever.
 */
export const CONFIRM_READ = 100;

/** How far back the search looks: a ticket nobody has touched in this long was decided long ago. */
export const CONFIRM_WINDOW_DAYS = 90;

/** How long the store remembers a ticket it recorded: past the search's window, so nothing is recorded twice. */
export const CONFIRMED_KEEP_DAYS = 2 * CONFIRM_WINDOW_DAYS;

export type ConfirmOutcome = ConfirmedRecord["outcome"];

export interface Decided {
  outcome: ConfirmOutcome;
  /** Every field the person changed; null when there is no snapshot to compare against (filed by hand, or pruned). */
  overrides: Override[] | null;
}

export interface DecideRules {
  statuses: Record<ClerkStatus, string>;
  /** The project's `appLabels`, which say a ticket's app. */
  appLabels: AppLabels;
  /** Null when no points field is configured: the points are unknown, so never an override. */
  storyPointsField: string | null;
}

/** The app a ticket's repo labels say, by the project's `appLabels`; null when it carries neither. */
export function appOfLabels(labels: readonly string[], apps: AppLabels): App | null {
  const backoffice = labels.includes(apps.backoffice);
  const pwa = labels.includes(apps.pwa);
  if (backoffice && pwa) return "both";
  if (backoffice) return "Backoffice";
  return pwa ? "pwa" : null;
}

/**
 * Who does it, by the `para-*` labels the confirmer left. Both labels is a
 * person: a ticket a person is meant to look at is never handed to an agent on
 * a tie. Neither is null, which routes like a person too. The plan matches a
 * duplicate's assignee to its original's by the same reading.
 */
export { assigneeOfLabels };

/** The `difficulty:*` label's level, or null without one. */
export function difficultyOfLabels(labels: readonly string[]): string | null {
  const label = labels.find((one) => one.startsWith(DIFFICULTY_LABEL_PREFIX));
  return label === undefined ? null : label.slice(DIFFICULTY_LABEL_PREFIX.length);
}

/** Text compared the way Jira hands it back: runs of whitespace are one space. */
const normalised = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * What a person decided for `ticket`, and what they changed, or null for a
 * ticket in neither the confirmed nor the rejected status. Pure.
 */
export function decide(ticket: JiraIssue, snapshot: Determination | null, rules: DecideRules): Decided | null {
  let outcome: ConfirmOutcome;
  if (ticket.status === rules.statuses.rejected) outcome = "rejected";
  else if (ticket.status === rules.statuses.confirmed) outcome = assigneeOfLabels(ticket.labels) === "agent" ? "to-agent" : "to-person";
  else return null;
  return { outcome, overrides: snapshot === null ? null : overridesOf(ticket, snapshot, rules) };
}

/** Each field the ticket now holds that differs from what the clerk set, with both values. */
export function overridesOf(ticket: JiraIssue, snapshot: Determination, rules: Pick<DecideRules, "storyPointsField" | "appLabels">): Override[] {
  const overrides: Override[] = [];
  const differs = (field: Override["field"], agent: string | number | null, human: string | number | null): void => {
    if (agent !== human) overrides.push({ field, agent, human });
  };
  differs("type", snapshot.type, ticket.type || null);
  differs("priority", snapshot.priority, ticket.priority);
  // By label set, not by name: the clerk files `none` with the backoffice
  // label, so a ticket still carrying exactly that label was not changed.
  const app = appOfLabels(ticket.labels, rules.appLabels);
  const byApp = clerkAppLabels(rules.appLabels);
  const filedLabels = [...byApp[snapshot.app]].sort().join(",");
  const nowLabels = app === null ? "" : [...byApp[app]].sort().join(",");
  if (filedLabels !== nowLabels) overrides.push({ field: "app", agent: snapshot.app, human: app });
  differs("difficulty", snapshot.difficulty, difficultyOfLabels(ticket.labels));
  if (rules.storyPointsField !== null) differs("storyPoints", snapshot.storyPoints, ticket.storyPoints);
  differs("assigneeKind", snapshot.assignee, assigneeOfLabels(ticket.labels));
  if (snapshot.summary !== undefined && normalised(snapshot.summary) !== normalised(ticket.summary)) {
    overrides.push({ field: "summary", agent: snapshot.summary, human: ticket.summary });
  }
  if (snapshot.description !== undefined && normalised(snapshot.description) !== normalised(ticket.description)) {
    overrides.push({ field: "description", agent: snapshot.description, human: ticket.description });
  }
  return overrides;
}

/** The open intake tickets a person has confirmed or rejected and the sweep has not finished, most recently updated first. */
export const sweepJql = (project: string, statuses: Record<ClerkStatus, string>): string =>
  [
    `project = ${jqlString(project)}`,
    `labels = ${jqlString(INTAKE_LABEL)}`,
    `status in (${jqlString(statuses.confirmed)}, ${jqlString(statuses.rejected)})`,
    `labels not in (${jqlString(READY_FOR_AGENT_LABEL)}, ${jqlString(MOVED_LABEL)})`,
    `updated >= -${CONFIRM_WINDOW_DAYS}d`,
  ].join(" AND ") + " ORDER BY updated DESC";

/** The reads the sweep makes. Shadow is handed only these. */
export type BoardReader = Pick<JiraClient, "search" | "statusHistory" | "comments">;

/**
 * A view of `jira` with its reads alone: shadow's sweep is built on this, so
 * no write call is reachable from it whatever the sweep's code does.
 */
export const readOnly = (jira: JiraClient): BoardReader => ({
  search: (jql, max, fields, options) => jira.search(jql, max, fields, options),
  statusHistory: (key) => jira.statusHistory(key),
  comments: (key) => jira.comments(key),
});

/**
 * What the sweep may write, by mode. `holdOaMove` is `clerk.holdOaMove`
 * resolved (`holdsOaMove`): true holds a to-person move on the intake board.
 */
export type SweepBoard = { mode: "shadow"; jira: BoardReader } | { mode: "quiet" | "live"; jira: JiraClient; holdOaMove: boolean };

export interface SweepDeps {
  rules: ClerkRules;
  board: SweepBoard;
  storePath: string;
  now: () => number;
  /** Append one ledger event; false when it was lost. Absent, nothing is recorded. */
  ledger?: (event: MetricsEvent) => boolean;
}

export interface SweepResult {
  /** What the supervisor log should keep: each ticket acted on, each failure. */
  notes: string[];
  /** Jira refused the credential: for the gate to treat as every other denial. */
  denial: Denial | null;
}

/** The never-real OA key a shadow move is recorded under, as `shadowKey` names a would-be intake ticket. */
export const shadowMovedKey = (key: string): string => `SHADOW-${key.replace(/[^A-Za-z0-9]/g, "")}`;

/** The reason the OA ticket gives for a person taking it. */
export const confirmedReason = (displayName: string): string => `Confirmado para una persona por ${displayName}.`;

const PERMALINK = /en Slack: (https?:\/\/\S+)/;

/** The note `outcomeOf` in `clerk/apply.ts` writes on a likely duplicate, naming the original. */
const DUPLICATE_NOTE = /Posible duplicado de ([A-Z][A-Z0-9]*-\d+)/;

/** The Slack channel a filed ticket's report was posted in, off its permalink; null for a ticket filed by hand. */
export function channelOf(ticket: Pick<JiraIssue, "description">): string | null {
  const link = PERMALINK.exec(ticket.description)?.[1];
  return link === undefined ? null : (/\/archives\/([A-Z0-9]+)\//.exec(link)?.[1] ?? null);
}

/**
 * Whether this loop owns `ticket`. Loops watching different channels share
 * one intake board, and the one that sweeps a ticket first is the one that
 * records it: a loop without the ticket's determination records a
 * confirmation with no overrides, and the loop that has it never records
 * one (OAI-22). So a ticket from another channel is left alone; one this loop
 * filed, or one filed by hand, is its.
 */
export function ownsTicket(ticket: Pick<JiraIssue, "key" | "description">, channel: string, known: Record<string, unknown>): boolean {
  if (Object.hasOwn(known, ticket.key)) return true;
  const from = channelOf(ticket);
  return from === null || from === channel;
}

/**
 * One sweep. Never throws: every failure is a note, and the ticket it
 * stopped on is tried again on the next poll.
 */
export async function sweep(deps: SweepDeps): Promise<SweepResult> {
  const notes: string[] = [];
  const intake = clerkJira(deps.rules.jira);
  const project = intake.intakeProject;
  if (project === null) return { notes, denial: null };
  const { statuses, storyPointsField } = intake;
  const reader = deps.board.jira;

  let found: JiraIssue[];
  try {
    found = await reader.search(sweepJql(project, statuses), CONFIRM_READ, undefined, { storyPointsField });
  } catch (error) {
    // A 400 here is most often a status name the board does not have, which
    // JQL refuses outright: the operator's to fix in 'clerk.jira.statuses',
    // and never a reason to stop the clerk filing.
    return failure(error, `the intake board ${project} could not be searched for confirmed tickets`, notes);
  }

  const { determinations, confirmed, reports } = await withClerkStore(deps.storePath, deps.rules.channel, (store) => ({
    determinations: structuredClone(store.determinations ?? {}),
    confirmed: structuredClone(store.confirmed ?? {}),
    reports: reportsByKey(store),
  }));
  const rules: DecideRules = { statuses, storyPointsField, appLabels: deps.rules.appLabels };
  const due = found
    .filter((ticket) => ownsTicket(ticket, deps.rules.channel, determinations))
    .map((ticket) => ({ ticket, decided: decide(ticket, determinations[ticket.key] ?? null, rules) }))
    .filter((entry): entry is { ticket: JiraIssue; decided: Decided } => {
      if (entry.decided === null) return false;
      const prior = confirmed[entry.ticket.key];
      return prior === undefined || prior.outcome !== entry.decided.outcome || !prior.done;
    })
    // Oldest first: the ticket that has waited longest is acted on first.
    .sort((a, b) => Date.parse(a.ticket.created) - Date.parse(b.ticket.created) || a.ticket.key.localeCompare(b.ticket.key))
    .slice(0, CONFIRM_PER_POLL);

  let lost = 0;
  const record = (event: MetricsEvent): void => {
    if (deps.ledger === undefined) return;
    let written = false;
    try {
      written = deps.ledger(event);
    } catch {}
    if (!written) lost += 1;
  };

  for (const { ticket, decided } of due) {
    try {
      const done = await actOn(deps, { ticket, decided, prior: confirmed[ticket.key], snapshot: determinations[ticket.key] ?? null, report: reports[ticket.key] ?? ticket.key }, notes, record);
      if (!done) continue;
    } catch (error) {
      const result = failure(error, `${ticket.key} (${decided.outcome}) was not finished`, notes);
      // Out of the loop on anything but one ticket's own refusal: a 5xx or a
      // 429 is the next ticket's too, and a denial is the whole sweep's.
      if (result.denial !== null || !isTicketProblem(error)) {
        if (lost > 0) notes.push(lostNote(lost));
        return result;
      }
    }
  }
  if (lost > 0) notes.push(lostNote(lost));
  return { notes, denial: null };
}

const lostNote = (lost: number): string => `the intake metrics ledger could not be written: ${lost} event${lost === 1 ? "" : "s"} lost`;

/** A failure only this ticket has: Jira refused or could not find something about it. */
const isTicketProblem = (error: unknown): boolean =>
  error instanceof JiraError && error.failure.kind === "denied" && (error.failure.code === "jira_bad_request" || error.failure.code === "jira_not_found");

/** A failure as the sweep's answer: a denial for a refused credential, a note for everything else. */
function failure(error: unknown, what: string, notes: string[]): SweepResult {
  if (error instanceof JiraError) {
    const { failure } = error;
    if (failure.kind === "denied" && (failure.code === "jira_unauthorized" || failure.code === "jira_forbidden")) {
      notes.push(`${what}: ${failure.why}`);
      return { notes, denial: { code: failure.code, why: failure.why, remedy: failure.remedy } };
    }
    notes.push(`${what}: ${failure.why}; tried again at the next poll`);
    return { notes, denial: null };
  }
  notes.push(`${what}: ${error instanceof Error ? error.message : String(error)}; tried again at the next poll`);
  return { notes, denial: null };
}

/** The Slack report each filed ticket came from, by its key, off the processed reports. */
export function reportsByKey(store: ClerkStore): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [report, processed] of Object.entries(store.processed)) {
    if (processed.state === "filed" && processed.key !== null) out[processed.key] = report;
  }
  return out;
}

interface Due {
  ticket: JiraIssue;
  decided: Decided;
  prior: ConfirmedRecord | undefined;
  snapshot: Determination | null;
  /** The Slack report id the ledger files its events under; the key itself for a ticket filed by hand. */
  report: string;
}

/**
 * Record and carry out one ticket's outcome. True once it is finished; a
 * write that fails throws, and the record says how far it got.
 */
async function actOn(deps: SweepDeps, due: Due, notes: string[], record: (event: MetricsEvent) => void): Promise<boolean> {
  const { ticket, decided, snapshot } = due;
  const mode: ClerkMode = deps.board.mode;
  const key = ticket.key;
  const base = { v: 1 as const, report: due.report, key, mode };
  const save = (change: (records: Record<string, ConfirmedRecord>) => void): Promise<void> =>
    withClerkStore(deps.storePath, deps.rules.channel, (store) => {
      store.confirmed ??= {};
      change(store.confirmed);
      prune(store.confirmed, deps.now());
    });

  let prior = due.prior;
  if (prior === undefined || prior.outcome !== decided.outcome) {
    // Who decided and when, off the changelog: the latest move into the
    // status the ticket is in now.
    const change = latestInto(await deps.board.jira.statusHistory(key), ticket.status);
    const at = new Date(deps.now()).toISOString();
    const decidedAt = change?.at ?? at;
    const by = change?.by ?? null;
    prior = { outcome: decided.outcome, at, done: decided.outcome === "rejected", ...(by === null ? {} : { by: by.displayName }) };
    const fresh = prior;
    // Saved before the event is written, as the apply does: a kill in
    // between costs the line, never a second one.
    await save((records) => {
      records[key] = fresh;
    });
    if (decided.outcome === "rejected") {
      // Discarding a ticket the clerk marked a likely duplicate agrees with it:
      // the work was already reported, which is no noise. A confirmer who
      // thinks otherwise takes the label off first.
      const original = ticket.labels.includes(POSSIBLE_DUPLICATE_LABEL) ? (DUPLICATE_NOTE.exec(ticket.description)?.[1] ?? "") : null;
      if (original !== null) {
        record({ ...base, at, kind: "duplicate", of: original });
        notes.push(`${modeWord(mode)}${key} discarded in '${ticket.status}'${by === null ? "" : ` by ${by.displayName}`} as a duplicate${original === "" ? "" : ` of ${original}`}: recorded as already reported`);
        return true;
      }
      record({ ...base, at, kind: "rejected" });
      notes.push(`${modeWord(mode)}${key} rejected in '${ticket.status}'${by === null ? "" : ` by ${by.displayName}`}: recorded as noise`);
      return true;
    }
    const since = Date.parse(snapshot?.filedAt ?? ticket.created);
    const latency = Date.parse(decidedAt) - since;
    record({
      ...base,
      at,
      kind: "confirmed",
      by: by === null ? { accountId: "unknown" } : { accountId: by.accountId, displayName: by.displayName },
      latencyMs: Number.isFinite(latency) ? Math.max(0, latency) : 0,
      overrides: decided.overrides ?? [],
    });
  }
  if (decided.outcome === "rejected") return true;

  // Spanish for the OA ticket's reason, which the team reads; the log names
  // an unknown confirmer in its own words.
  const confirmer = prior.by ?? "una persona";
  const noted = prior.by ?? "an unknown account";
  const finish = async (oaKey?: string): Promise<void> => {
    await save((records) => {
      records[key] = { ...records[key]!, done: true, ...(oaKey === undefined ? {} : { oaKey }) };
    });
  };

  if (deps.board.mode === "shadow") {
    const text =
      decided.outcome === "to-agent"
        ? `would add '${READY_FOR_AGENT_LABEL}' to ${key}`
        : `would move ${key} to ${deps.rules.jira.project}, link it and comment the OA key on it, label it '${MOVED_LABEL}' and close it as '${clerkJira(deps.rules.jira).statuses.moved}'`;
    await withClerkStore(deps.storePath, deps.rules.channel, (store) => {
      const write = { kind: "confirm" as const, key, text };
      const entry = { report: due.report, at: new Date(deps.now()).toISOString(), write };
      const at = store.shadow.writes.findIndex((one) => one.write.kind === "confirm" && one.write.key === key);
      if (at === -1) store.shadow.writes.push(entry);
      else store.shadow.writes[at] = entry;
    });
    await finish(decided.outcome === "to-person" ? shadowMovedKey(key) : undefined);
    if (decided.outcome === "to-person") record({ ...base, at: new Date(deps.now()).toISOString(), kind: "moved", oaKey: shadowMovedKey(key) });
    notes.push(`shadow: ${key} confirmed ${decided.outcome} by ${noted} — ${text}`);
    return true;
  }

  const jira = deps.board.jira;
  if (decided.outcome === "to-agent") {
    // The `difficulty:*` label stays as the confirmer left it: Jav routes on it.
    await jira.updateFields(key, { labels: { add: [READY_FOR_AGENT_LABEL] } });
    await finish();
    notes.push(`${modeWord(mode)}${key} confirmed for an agent by ${noted}: labelled '${READY_FOR_AGENT_LABEL}'`);
    return true;
  }

  if (deps.board.holdOaMove) {
    // Held: the ticket stays where the confirmer put it, and the label says
    // on the board what live would have done. Labelled before it is recorded
    // done, so a failed write is retried rather than forgotten.
    if (!ticket.labels.includes(HOLD_LABEL)) await jira.updateFields(key, { labels: { add: [HOLD_LABEL] } });
    const held = heldMovedKey(key);
    await finish(held);
    record({ ...base, at: new Date(deps.now()).toISOString(), kind: "moved", oaKey: held, held: true });
    notes.push(`${modeWord(mode)}${key} confirmed for a person by ${noted}: not moved to ${deps.rules.jira.project} (held: 'clerk.holdOaMove'), labelled '${HOLD_LABEL}'`);
    return true;
  }

  const fields = handoffFieldsOf(ticket, snapshot, deps.rules, confirmer);
  if ("problem" in fields) {
    // Not a write that failed: the ticket as confirmed cannot be filed. It is
    // said on every poll until a person fixes the field, which is the point.
    notes.push(`${key} not moved to ${deps.rules.jira.project}: ${fields.problem}`);
    return false;
  }
  const comments = (await jira.comments(key)).map((body) => ({ body }));
  const statuses = clerkJira(deps.rules.jira).statuses;
  const moved = await moveToJira({ ref: key, comments, labels: ticket.labels, open: ticket.statusCategory !== "done" }, fields, {
    jira,
    rules: personBoard(deps.rules),
    write: (call) => call(),
    link: (oa) => jira.link(key, oa),
    comment: (body) => jira.addComment(key, body),
    addLabel: async (label) => {
      await jira.updateFields(key, { labels: { add: [label] } });
    },
    close: () => jira.transition(key, statuses.moved, { orDone: true }),
  });
  await finish(moved.key);
  record({ ...base, at: new Date(deps.now()).toISOString(), kind: "moved", oaKey: moved.key });
  notes.push(
    moved.closeWarning === null
      ? `${modeWord(mode)}${key} confirmed for a person by ${noted}: moved to ${moved.key}`
      : `${modeWord(mode)}${key} confirmed for a person by ${noted}: moved to ${moved.key}, but not closed (${moved.closeWarning}); '${MOVED_LABEL}' keeps it from moving again`,
  );
  if (moved.linkWarning !== null) notes.push(`${key} not linked to ${moved.key}: ${moved.linkWarning}`);
  if (moved.parentWarning !== null) notes.push(`${moved.key} not filed under its parent: ${moved.parentWarning}`);
  return true;
}

const modeWord = (mode: ClerkMode): string => (mode === "live" ? "" : `${mode}: `);

/** The latest status change into `status`, or null when the changelog has none. */
export function latestInto(history: readonly JiraStatusChange[], status: string): JiraStatusChange | null {
  for (let at = history.length - 1; at >= 0; at--) if (history[at]!.to === status) return history[at]!;
  return null;
}

/** The person board as `moveToJira` takes it: the clerk's site and OA project, its type names as filed. */
export const personBoard = (rules: ClerkRules): TriageJira => ({
  mode: "live",
  site: rules.jira.site,
  project: rules.jira.project,
  issueTypes: Object.fromEntries(TYPES.map((type) => [type, type])) as Record<IssueType, string>,
  parent: clerkJira(rules.jira).parent,
});

/**
 * What the OA ticket is filed with, read off the intake ticket as confirmed:
 * the type and priority a person left, not the clerk's. A type the clerk does
 * not file is a problem, never a guess.
 */
export function handoffFieldsOf(ticket: JiraIssue, snapshot: Determination | null, rules: ClerkRules, confirmer: string): HandoffFields | { problem: string } {
  if (!(TYPES as readonly string[]).includes(ticket.type)) {
    return { problem: `its type '${ticket.type}' is not one the clerk files (${TYPES.join(", ")})` };
  }
  if (ticket.priority === null) return { problem: "it has no priority" };
  return {
    type: ticket.type as IssueType,
    priority: ticket.priority,
    summary: clip(ticket.summary, SUMMARY_MAX),
    description: strippedDescription(ticket.description),
    reason: confirmedReason(confirmer),
    permalink: snapshot?.permalink ?? PERMALINK.exec(ticket.description)?.[1] ?? null,
    url: `https://${rules.jira.site}/browse/${ticket.key}`,
    ref: ticket.key,
    origin: "intake",
  };
}

/** Forget what was recorded past the keep window: the search no longer reaches those tickets. */
function prune(records: Record<string, ConfirmedRecord>, nowMs: number): void {
  for (const [key, entry] of Object.entries(records)) {
    if (nowMs - Date.parse(entry.at) > CONFIRMED_KEEP_DAYS * 86_400_000) delete records[key];
  }
}
