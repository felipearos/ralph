/**
 * Applying a validated plan: every Slack and Jira write the clerk makes, made
 * here and only here, through one write port (felipearos/ralph#315). A new
 * report is filed as a ticket on the Jira intake board labelled with its
 * app's repo (felipearos/ralph#447), and its duplicate candidates are intake
 * tickets too.
 *
 * What each decision becomes is a pure function (`outcomeOf`), so the rules —
 * a sure duplicate of an open ticket is a comment, a duplicate of one closed
 * within the regression window is a new `Error` "posible regresión", an unsure
 * one is a new ticket "posible duplicado", every new ticket gets the first
 * reply in its report's thread — are read and tested apart from the I/O that
 * carries them out.
 *
 * The port is the shadow fence. In `shadow` mode the port records each
 * intended write and makes none: there is no code path from a shadow apply to
 * Slack or Jira, whatever the plan says, because the shadow port holds no
 * client at all. In `live` mode (felipearos/ralph#320) the same calls reach
 * Jira and Slack. In `quiet` mode the port reaches Jira as live does and holds
 * no Slack client, so no thread reply can be posted (`quietPort`, `live.ts`).
 *
 * Idempotent per report. A report's progress is saved after each step it
 * completes, a report is marked processed only once every step is done, and
 * before creating a ticket the port is asked whether one already carries the
 * report's permalink. A run stopped halfway and run again therefore redoes
 * only what it had not finished, and files nothing twice.
 */
import { clerkAppLabels, type ClerkMode, type ClerkRules } from "../project-config";
import type { AppLabels } from "../triage/intake";
import { attachedBlock, maxBytesOf, type AttachableFile } from "./files";
import {
  AGENT_LABEL,
  clip,
  PERSON_LABEL,
  SUMMARY_MAX,
  type App,
  type Assignee,
  type BatchReport,
  type Candidate,
  type Decision,
  type Difficulty,
  type IssueType,
  type Priority,
  type StoryPoints,
} from "./plan";

/** The label every ticket the clerk files carries, so the team can query, review or bulk-close them. */
export const INTAKE_LABEL = "slack-intake";
/**
 * The label the confirmation sweep puts on an intake ticket it moved to the
 * team's board: closed on the intake board, still live there. Here rather
 * than in `candidates.ts`, which imports this module.
 */
export const MOVED_LABEL = "moved-to-jira";
/** The label a decision carries: the team decides on it in grooming. */
export const DECISION_LABEL = "por-decidir";
/** The label of a report filed after the session failed to classify it twice. */
export const UNCLASSIFIED_LABEL = "intake-sin-clasificar";

/**
 * What a confirmer filters the board by to check a likely duplicate or a
 * likely regression: the link and the note say which ticket, the label says
 * there is one to check.
 */
export const POSSIBLE_DUPLICATE_LABEL = "posible-duplicado";
export const POSSIBLE_REGRESSION_LABEL = "posible-regresion";
/**
 * How a difficulty label starts: `difficulty:easy`, the form Jav routes on
 * (felipearos/ralph#444), so intake work is routed like any other ticket.
 */
export const DIFFICULTY_LABEL_PREFIX = "difficulty:";
// Defined beside `Assignee` in `plan.ts`, which matches a duplicate's to its original's by them.
export { AGENT_LABEL, PERSON_LABEL } from "./plan";
/**
 * The label the sweep puts on a ticket confirmed for a person and held on the
 * intake board rather than created on OA (`clerk.holdOaMove`,
 * felipearos/ralph#443): the confirmer sees on the board that it would have
 * moved.
 */
export const HOLD_LABEL = "para-mover-a-oa";
/** The first reply in a new report's thread: the reporter learns at once it was received. */
export const RECEIVED_REPLY = "Recibido, en revisión.";

/**
 * Slack cannot move a message into a thread, so a report joined from several
 * top-level messages (`clerk/reports.ts`) shows its grouping with replies
 * instead, in live mode only: the first message's reply lists the others,
 * and each of the others is pointed back at the first.
 */
export const GROUPED_PREFIX = "Este reporte incluye también: ";
export const FOLLOW_UP_PREFIX = "Agregado al reporte de arriba: ";

// The reporters' wall clock: the channel is in Chile, whatever the host's zone.
const CHILE_TIME = new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** A Slack ts as HH:MM in Chile time. */
export function chileTime(ts: string): string {
  const parts = CHILE_TIME.formatToParts(new Date(Math.round(Number(ts) * 1000)));
  const part = (type: string): string => parts.find((one) => one.type === type)?.value ?? "00";
  return `${part("hour")}:${part("minute")}`;
}

/** The top-level messages a report was joined from after its first, with their links: what the grouping replies name. */
export function followUpsOf(report: Pick<BatchReport, "roots" | "messages">): { ts: string; permalink: string }[] {
  return report.roots.slice(1).flatMap((root) => {
    const message = report.messages.find((one) => one.ts === root && !one.reply);
    return message === undefined ? [] : [{ ts: root, permalink: message.permalink }];
  });
}

/** `reply` with the report's other messages listed after it, as Slack mrkdwn links; `reply` alone for a one-message report. */
export function groupedReply(reply: string, report: Pick<BatchReport, "roots" | "messages">): string {
  const others = followUpsOf(report);
  if (others.length === 0) return reply;
  return `${reply} ${GROUPED_PREFIX}${others.map((other) => `<${other.permalink}|mensaje de ${chileTime(other.ts)}>`).join(", ")}`;
}

/** The reply on each follow-up message, pointing at the report's first. */
export const followUpReply = (reportPermalink: string): string => `${FOLLOW_UP_PREFIX}<${reportPermalink}|ver reporte>`;

/** A new ticket, as code files it. */
export interface NewIssue {
  type: IssueType;
  summary: string;
  description: string;
  labels: string[];
  /** The decision's app, which the live port writes into the issue's body. */
  app: App;
  priority: Priority;
  /** Who does it; also a `para-*` label. */
  assignee: Assignee;
  /** How hard it is; also a `difficulty:*` label. */
  difficulty: Difficulty;
  /** The suggested story points, or null when nobody sized it (an unclassified report). */
  storyPoints: StoryPoints | null;
  /** The report's permalink, which the description carries and the idempotency check looks for. */
  permalink: string;
  /**
   * Which of a split report's tickets this is, from 2: the report's own is
   * the first and carries no number. With the permalink, what the
   * idempotency check looks for (`filedIdentity`).
   */
  part?: number;
}

/**
 * What a filed ticket is found by again: its report's permalink, and for a
 * split report's other tickets the part's number too, so each problem of the
 * report is filed once and none is taken for the report's own ticket.
 */
export const filedIdentity = (issue: Pick<NewIssue, "permalink" | "part">): string =>
  issue.part === undefined ? issue.permalink : `${issue.permalink}#parte-${issue.part}`;

/** One more ticket of a split report, and what it may already be. */
export interface PartTicket {
  issue: NewIssue;
  link: DuplicateLink | null;
}

type DuplicateLink = { key: string; why: "posible regresión" | "posible duplicado" };

/** What a split report's tickets are linked to each other as. */
export const SAME_REPORT = "mismo reporte";

/**
 * The field block a filed ticket's body carries after its description: what
 * the tracker has no slot for, one `Name: value` line each. `triage/handoff.ts`
 * strips exactly these lines (`FIELD_LINE`) when it moves a report on, so a
 * line added here is a name added there.
 */
export function fieldLines(issue: NewIssue): string[] {
  return [
    `Tipo: ${issue.type}`,
    `Prioridad: ${issue.priority}`,
    `App: ${issue.app}`,
    `Dificultad: ${issue.difficulty}`,
    ...(issue.storyPoints === null ? [] : [`Puntos de historia sugeridos: ${issue.storyPoints}`]),
    `Asignado a: ${issue.assignee === "agent" ? "agente" : "persona"}`,
  ];
}

/** What code does with one report. */
export type Outcome =
  | { kind: "ignore"; reason: string }
  | {
      kind: "comment";
      key: string;
      comment: string;
      reply: string;
      /** The ticket it becomes instead, should the one it duplicates be gone by the time it is applied. */
      instead: NewIssue;
      /** The report's other problems, filed as their own tickets and linked to the one it duplicates. */
      parts: PartTicket[];
      /** Tickets it duplicates to move from `para-agente` to `para-persona` (`Decision.relabel`). */
      relabel: string[];
    }
  | { kind: "create"; issue: NewIssue; link: DuplicateLink | null; reply: string | null; parts: PartTicket[]; relabel: string[] };

/** One write the port makes, or in shadow would have made. */
export type Write =
  | { kind: "create"; issue: NewIssue }
  | { kind: "comment"; key: string; body: string }
  | { kind: "link"; from: string; to: string; why: string }
  | { kind: "reply"; thread: string; text: string }
  /** A reply posted in a filed report's thread, copied to its ticket (felipearos/ralph#321). */
  | { kind: "thread-comment"; key: string; body: string; reply: string }
  /** What the confirmation sweep would do to a confirmed intake ticket (felipearos/ralph#449), in words. */
  | { kind: "confirm"; key: string; text: string }
  /** A ticket a duplicate of which must go to a person, moved from `para-agente` to `para-persona`. */
  | { kind: "relabel"; key: string; add: string; remove: string };

/** Replies in any top-level message's thread, not only a report's first. */
export interface ThreadReplies {
  /** Whether the clerk already posted exactly this reply in `thread`. */
  hasReply(thread: string, text: string): Promise<boolean>;
  reply(thread: string, text: string): Promise<void>;
}

export interface WritePort {
  readonly mode: ClerkMode;
  /**
   * The grouping replies' way into Slack. Only the live port has it: shadow
   * and quiet are handed no Slack writer, so a grouped report posts nothing
   * there, and its first reply stays the plain one.
   */
  readonly threads?: ThreadReplies;
  /** The key of a ticket already filed as `identity` (`filedIdentity`: a report's permalink, or one part of a split report), or null. */
  findFiled(identity: string): Promise<string | null>;
  /** Whether `key` already carries a comment quoting this permalink. */
  hasComment(key: string, permalink: string): Promise<boolean>;
  /** Create a ticket and return its key. */
  create(issue: NewIssue, report: BatchReport): Promise<string>;
  comment(key: string, body: string, report: BatchReport): Promise<void>;
  link(from: string, to: string, why: string, report: BatchReport): Promise<void>;
  /** Move `key` from `para-agente` to `para-persona`: a duplicate of it must go to a person. Throws `TargetGone` for a ticket that no longer exists. */
  relabel(key: string, report: BatchReport): Promise<void>;
  /** Reply in the report's thread. */
  reply(report: BatchReport, text: string): Promise<void>;
  /** Whether the clerk already posted exactly this reply in the report's thread. */
  hasReply(report: BatchReport, text: string): Promise<boolean>;
  /** Copy one thread reply (`reply`, its ts) on report `report` to ticket `key` as a comment. */
  copyReply(key: string, body: string, report: string, reply: string): Promise<void>;
}

/**
 * The ticket a write was aimed at no longer exists — deleted or moved between
 * the session's read and the apply. That is one report's problem, not the
 * loop's: a comment becomes a new ticket and a link is dropped, rather than a
 * denial that stops the clerk overnight.
 */
export class TargetGone extends Error {
  constructor(readonly key: string) {
    super(`${key} no longer exists`);
    this.name = "TargetGone";
  }
}

/** Text the clerk writes is plain: no emoji, whatever the model or the reporter put in. */
export const plain = (value: string): string =>
  value
    // An alternation rather than one class: the joiner and the selectors are
    // not characters a class may mix with the emoji they combine with.
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u{FE0F}|\u{200D}|\u{20E3}/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .trim();

const DAY_MS = 86_400_000;

/**
 * Whether a candidate counts as open: it has no close time. A batch stored
 * before felipearos/ralph#394 holds Jira-shaped candidates with no `closed`
 * field at all, so for one of those Jira's own `done` category decides, as it
 * did when the batch was handed over.
 */
export const isOpen = (candidate: Candidate): boolean => {
  if (candidate.closed !== undefined) return candidate.closed === null;
  return (candidate as { statusCategory?: string }).statusCategory !== "done";
};

/** Whether a candidate was moved to the team's board: closed on the intake board, live there, so treated as open. */
export const isMoved = (candidate: Candidate): boolean => candidate.labels.includes(MOVED_LABEL);

/** Whether a closed candidate, not one moved to Jira, was closed within the regression window. */
export const closedWithin = (candidate: Candidate, nowMs: number, days: number): boolean => {
  if (isOpen(candidate) || isMoved(candidate)) return false;
  // A pre-#394 Jira candidate carries its close time as `resolved`.
  const closed = candidate.closed ?? (candidate as { resolved?: string | null }).resolved ?? null;
  return closed !== null && nowMs - Date.parse(closed) <= days * DAY_MS;
};

const nameOf = (report: BatchReport, user: string): string => report.names[user] ?? user;

/** The report quoted whole: who wrote what, the thread's replies included. */
/**
 * Slack's message markup as the text a person reads: `<url|label>` as the
 * label and the URL, `<url>` as the URL, `<@U…>` as the name, and the three
 * entities Slack escapes. Quoted raw, a link's `|label>` would ride into the
 * ticket as part of its URL.
 */
export function unslack(text: string, names: Readonly<Record<string, string>> = {}): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_all, user: string) => `@${names[user] ?? user}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!([a-z]+)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]*)>/g, (_all, url: string, label: string) => (label === url ? url : `${label} (${url})`))
    .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * The most a description may carry: Jira refuses one past 32,767 characters,
 * and a long thread quoted whole can get there. Clipped below it, with room
 * for the lines that come after the quote.
 */
export const DESCRIPTION_MAX = 30_000;

export function quote(report: BatchReport): string {
  return report.messages
    .map((message) => {
      const who = message.user === report.author ? "" : `(${nameOf(report, message.user)}) `;
      const text = unslack(message.text, report.names).trim();
      const body = text === "" ? "(sin texto)" : text;
      return body
        .split("\n")
        .map((line, index) => `> ${index === 0 ? who : ""}${line}`)
        .join("\n");
    })
    .join("\n");
}

/** Every file of a report the clerk copies onto its ticket, oldest message first. */
export const reportAttachments = (report: Pick<BatchReport, "messages">): AttachableFile[] => report.messages.flatMap((message) => message.attachments ?? []);

/**
 * The description of a ticket the clerk files: the session's words, then the
 * evidence. A file the clerk attaches is named, not linked: the ticket holds
 * it, and the report's own permalink still leads to it in Slack. A file it
 * cannot attach is linked, as every file was before.
 */
export function describe(report: BatchReport, body: string, notes: readonly string[], maxBytes = maxBytesOf({})): string {
  const attached = reportAttachments(report);
  const named = new Set(attached.map((file) => file.permalink));
  const files = report.messages.flatMap((message) => message.files).filter((file) => !named.has(file));
  const quoted = quote(report);
  return plain(
    [
      body,
      ...notes,
      `Reportado por ${report.authorName} en Slack: ${report.permalink}`,
      `Mensaje original:\n${quoted.length <= DESCRIPTION_MAX - body.length - 2_000 ? quoted : `${clip(quoted, Math.max(1_000, DESCRIPTION_MAX - body.length - 2_000))}\n> (mensaje recortado; el hilo completo está en Slack)`}`,
      ...(files.length === 0 ? [] : [`Capturas:\n${files.map((file) => `- ${file}`).join("\n")}`]),
      ...attachedBlock(attached, maxBytes),
      "Registrado automáticamente por el clerk desde el canal de reportes.",
    ].join("\n\n"),
  );
}

/**
 * How every duplicate comment starts. The live canvas counts a ticket's
 * reports by it (`clerk/canvas.ts`), so the two must not drift.
 */
export const DUPLICATE_COMMENT = "Nuevo reporte del mismo problema por ";

/**
 * The permalink on the reporter line the clerk writes into every ticket it
 * files (`describe`). Only an https link counts: the dashboard puts it in an
 * href and a Slack reply in a link, and a ticket a person edited may hold
 * anything there.
 */
export const reportPermalinkOf = (body: string): string | null => /^Reportado por .+? en Slack:\s*(https:\/\/\S+)/m.exec(body)?.[1] ?? null;

/**
 * The thread reply to a sure duplicate: the key the work is followed under
 * and, when the ticket names it, a link to the first report of the problem,
 * so the reporter can read what was already said there.
 */
export function duplicateReply(candidate: Pick<Candidate, "key" | "jiraKey" | "permalink">): string {
  const key = candidate.jiraKey ?? candidate.key;
  const original = candidate.permalink ?? null;
  return original === null ? `Ya está reportado: ${key}.` : `Ya está reportado: ${key} (<${original}|reporte original>).`;
}

/** A comment on the ticket a report duplicates: who reported it again, what they wrote, and the files it attaches there. */
export function duplicateComment(report: BatchReport, maxBytes = maxBytesOf({})): string {
  return plain([`${DUPLICATE_COMMENT}${report.authorName} en Slack: ${report.permalink}`, quote(report), ...attachedBlock(reportAttachments(report), maxBytes)].join("\n\n"));
}

/**
 * The ticket a decision files: its labels, its priority and its description.
 * The repo labels (`clerkAppLabels`, from the project's `appLabels`) route it
 * to the loop that works the app's repo.
 */
function newIssue(
  decision: Pick<Extract<Decision, { verdict: "issue" | "decision" }>, "verdict" | "app" | "assignee" | "difficulty" | "summary" | "description" | "priority" | "storyPoints" | "unclassified">,
  report: BatchReport,
  type: IssueType,
  notes: readonly string[],
  maxBytes: number,
  apps: AppLabels,
  part?: number,
): NewIssue {
  const repos = clerkAppLabels(apps)[decision.app];
  // A decision is a person's, whatever a hand-built one says: the validator
  // never lets a plan say otherwise, and the label and the line agree.
  const assignee: Assignee = decision.verdict === "decision" ? "person" : decision.assignee;
  const labels = [
    INTAKE_LABEL,
    ...repos,
    ...(decision.verdict === "decision" ? [DECISION_LABEL] : []),
    `${DIFFICULTY_LABEL_PREFIX}${decision.difficulty}`,
    assignee === "agent" ? AGENT_LABEL : PERSON_LABEL,
  ];
  if (decision.unclassified === true) labels.push(UNCLASSIFIED_LABEL);
  return {
    type,
    summary: clip(plain(decision.summary), SUMMARY_MAX),
    description: describe(report, decision.description, notes, maxBytes),
    labels,
    app: decision.app,
    priority: decision.verdict === "decision" ? "Sin Prioridad" : decision.priority,
    assignee,
    difficulty: decision.difficulty,
    storyPoints: decision.storyPoints,
    permalink: report.permalink,
    ...(part === undefined ? {} : { part }),
  };
}

/** The line a split report's every ticket carries, so whoever confirms one knows the others exist. */
export const partNote = (part: number, of: number): string =>
  `Parte ${part} de ${of} del reporte: cada problema que describe va en su propio ticket, enlazados entre sí.`;

/**
 * What a named candidate makes of a new ticket: a link, the note that says
 * why, and an Error for a regression. Closed recently and back again is a
 * regression; open, or moved to the team's board, a likely duplicate.
 */
function duplicateMark(
  candidate: Candidate | null,
  unverified: string | null,
  type: IssueType,
  verdict: "issue" | "decision",
  rules: ClerkRules,
  nowMs: number,
): { link: DuplicateLink | null; notes: string[]; type: IssueType; label: string | null } {
  const notes: string[] = [];
  let link: DuplicateLink | null = null;
  if (candidate !== null && closedWithin(candidate, nowMs, rules.regressionDays)) {
    // Closed recently and back again: a regression is a defect whatever type
    // the session gave it, and it must not be folded into a closed ticket.
    // A decision stays a Tarea: it questions behaviour on purpose, and
    // the link and the note carry the history.
    if (verdict === "issue") type = "Error";
    link = { key: candidate.key, why: "posible regresión" };
    notes.push(`Posible regresión de ${candidate.key}, cerrado recientemente.`);
  } else if (candidate !== null && (isOpen(candidate) || isMoved(candidate))) {
    link = { key: candidate.key, why: "posible duplicado" };
    notes.push(`Posible duplicado de ${candidate.key}.`);
  }
  if (unverified !== null) notes.push(`Posible duplicado de ${unverified} (no verificado).`);
  const label = link?.why === "posible regresión" ? POSSIBLE_REGRESSION_LABEL : link !== null || unverified !== null ? POSSIBLE_DUPLICATE_LABEL : null;
  return { link, notes, type, label };
}

/** A split report's other tickets, numbered from 2: the report's own ticket is the first. */
function partTickets(decision: Extract<Decision, { verdict: "issue" | "decision" }>, report: BatchReport, rules: ClerkRules, nowMs: number): PartTicket[] {
  const parts = decision.parts ?? [];
  const of = parts.length + 1;
  return parts.map((part, index) => {
    const mark = duplicateMark(part.duplicate, part.unverifiedDuplicate, part.type, "issue", rules, nowMs);
    const issue = newIssue({ ...part, verdict: "issue" }, report, mark.type, [partNote(index + 2, of), ...mark.notes], maxBytesOf(rules), rules.appLabels, index + 2);
    if (mark.label !== null) issue.labels.push(mark.label);
    return { issue, link: mark.link };
  });
}

/**
 * What one decision becomes. Pure: the rules of the spec's "Validate and
 * apply" section, and nothing that touches a service.
 */
export function outcomeOf(decision: Decision, report: BatchReport, rules: ClerkRules, nowMs: number): Outcome {
  if (decision.verdict === "ignore") return { kind: "ignore", reason: plain(decision.reason) };
  const parts = partTickets(decision, report, rules, nowMs);
  const split = parts.length === 0 ? [] : [partNote(1, parts.length + 1)];
  const duplicate = decision.duplicate;
  // A sure duplicate of an open ticket is one more voice on it, not a new
  // ticket: a comment, and a reply telling the reporter it is known. One moved
  // to the team's board is still live there, so the reply names its OA key,
  // where the work is followed; the comment stays on the intake ticket.
  if (duplicate !== null && duplicate.confidence === "sure" && (isOpen(duplicate.candidate) || isMoved(duplicate.candidate))) {
    return {
      kind: "comment",
      key: duplicate.candidate.key,
      comment: duplicateComment(report, maxBytesOf(rules)),
      reply: duplicateReply(duplicate.candidate),
      instead: newIssue(decision, report, decision.type, [...split, `Iba a registrarse como duplicado de ${duplicate.candidate.key}, que ya no existe.`], maxBytesOf(rules), rules.appLabels),
      parts,
      relabel: decision.relabel ?? [],
    };
  }
  const mark = duplicateMark(duplicate?.candidate ?? null, decision.unverifiedDuplicate, decision.type, decision.verdict, rules, nowMs);
  const { link } = mark;
  const issue = newIssue(decision, report, mark.type, [...split, ...mark.notes], maxBytesOf(rules), rules.appLabels);
  if (mark.label !== null) issue.labels.push(mark.label);
  return {
    kind: "create",
    issue,
    link,
    // Every new report hears back at once, whatever its priority: the reply
    // tags nobody and names no key, so it is the same text in shadow and live.
    reply: RECEIVED_REPLY,
    parts,
    relabel: decision.relabel ?? [],
  };
}

/** How far one report has got, saved after each step. */
export interface Progress {
  key?: string;
  linked?: boolean;
  commented?: boolean;
  replied?: boolean;
  /** The follow-up messages whose grouping reply is posted. */
  followUps?: string[];
  /** A split report's other tickets, by part number: filed, then linked. */
  parts?: Record<string, { key: string; linked?: boolean }>;
  /** The tickets it duplicates already relabelled `para-persona`. */
  relabelled?: string[];
}

/** What became of one report, for the store and the journal. */
export interface Applied {
  report: string;
  permalink: string;
  outcome: Outcome["kind"];
  key: string | null;
  writes: Write[];
  line: string;
  /**
   * The ticket a created report was filed as — or found filed as on a rerun —
   * so the gate can keep what the clerk determined and record it in the
   * metrics ledger (felipearos/ralph#447). Absent for a comment or an ignore.
   */
  issue?: NewIssue;
  /** A split report's other tickets, filed or found filed, each with what it was filed as. */
  parts?: { key: string; issue: NewIssue }[];
  /**
   * Follow-up messages whose grouping reply failed: kept in the store and
   * retried on later polls (`postFollowUps`), never a reason to hold the
   * report back.
   */
  pendingFollowUps?: string[];
}

export interface ApplyDeps {
  rules: ClerkRules;
  port: WritePort;
  now: () => number;
  /** Where a report has got to, from the store. */
  progress(report: string): Progress;
  /** Save a step. Persisted before the next write, so a crash redoes at most that step. */
  saveProgress(report: string, progress: Progress): Promise<void>;
  /** Mark the report done: processed, its key remembered, the cursor free to pass it. */
  done(applied: Applied): Promise<void>;
  /**
   * A report a previous run already finished, with the key it was filed as or
   * folded into; undefined for one still to apply. It is skipped, and a later
   * report of the batch that duplicates it still finds its ticket.
   */
  finished?(report: string): { key: string | null } | undefined;
  /** A line for the poll's notes: a grouping reply that failed and will be retried. */
  note?: (line: string) => void;
}

/**
 * The ticket a later report of the batch that duplicates this one goes to:
 * the one it was folded into when it was a comment there, so a moved
 * ticket's OA key still reaches the reply; otherwise the one it was filed as,
 * which is open because it was filed just now.
 */
function batchTarget(decision: Decision, key: string | null, permalink: string | null): Candidate | null {
  if (key === null || decision.verdict === "ignore") return null;
  const duplicate = decision.duplicate;
  // A new ticket never takes the key of the one it names, so the same key
  // means the report was a comment on that candidate.
  if (duplicate !== null && duplicate.candidate.key === key) return duplicate.candidate;
  return { key, summary: decision.summary, status: "", closed: null, labels: [INTAKE_LABEL], jiraKey: null, permalink };
}

/**
 * A decision that names an earlier report of its batch, made into one that
 * names the ticket that report became, so `outcomeOf` applies the same rules
 * as for a board candidate. An earlier report with no ticket (it cannot have
 * one by the validator's rules, but a hand-built plan can) leaves it a new
 * ticket marked "posible duplicado" of that report.
 */
function withBatchTarget(decision: Decision, targets: ReadonlyMap<string, Candidate>, byId: ReadonlyMap<string, BatchReport>): Decision {
  if (decision.verdict === "ignore" || decision.batchDuplicate === undefined) return decision;
  const target = targets.get(decision.batchDuplicate.report);
  if (target === undefined) return { ...decision, unverifiedDuplicate: decision.unverifiedDuplicate ?? byId.get(decision.batchDuplicate.report)?.permalink ?? null };
  return { ...decision, duplicate: { candidate: target, confidence: decision.batchDuplicate.confidence } };
}

/**
 * Apply each decision in order. A write that throws stops the apply there:
 * the reports before it are done, the one it failed on keeps its progress, and
 * the ones after it are untouched. The caller decides whether to retry (a
 * transient failure) or stop the loop (a denial).
 */
export async function applyDecisions(
  decisions: readonly Decision[],
  reports: readonly BatchReport[],
  deps: ApplyDeps,
): Promise<Applied[]> {
  const byId = new Map(reports.map((report) => [report.id, report]));
  const applied: Applied[] = [];
  // What each report of the batch became, in order, for the later reports
  // that duplicate it.
  const targets = new Map<string, Candidate>();
  const remember = (decision: Decision, key: string | null): void => {
    const target = batchTarget(decision, key, byId.get(decision.report)?.permalink ?? null);
    if (target !== null) targets.set(decision.report, target);
  };
  for (const decision of decisions) {
    const report = byId.get(decision.report);
    if (report === undefined) continue;
    const earlier = deps.finished?.(decision.report);
    const resolved = withBatchTarget(decision, targets, byId);
    if (earlier !== undefined) {
      remember(resolved, earlier.key);
      continue;
    }
    const result = await applyOne(outcomeOf(resolved, report, deps.rules, deps.now()), report, deps);
    await deps.done(result);
    applied.push(result);
    remember(resolved, result.key);
  }
  return applied;
}

async function applyOne(outcome: Outcome, report: BatchReport, deps: ApplyDeps): Promise<Applied> {
  const { port } = deps;
  const progress = { ...deps.progress(report.id) };
  const save = async (): Promise<void> => deps.saveProgress(report.id, progress);
  const writes: Write[] = [];
  const shadow = port.mode === "shadow" ? " (shadow: not written)" : port.mode === "quiet" ? " (quiet: nothing posted in Slack)" : "";
  // Live only, and only for a report joined from more than one message: the
  // fences of shadow and quiet are their ports, which carry no `threads`.
  const threads = port.mode === "live" ? port.threads : undefined;
  const others = followUpsOf(report);
  const grouping = threads !== undefined && others.length > 0;
  const grouped = grouping ? `, grouping replies on ${others.length} follow-up message(s)` : "";
  // Each follow-up's reply, once, after the report's own: a failure is a note
  // and a retry on a later poll, never the report's failure.
  const followUps = async (): Promise<string[]> => {
    if (!grouping) return [];
    const posted = new Set(progress.followUps ?? []);
    const pending = others.filter((other) => !posted.has(other.ts)).map((other) => other.ts);
    return postFollowUps(threads!, report.permalink, pending, deps.note ?? (() => {}), async (root, wrote) => {
      progress.followUps = [...(progress.followUps ?? []), root];
      if (wrote) writes.push({ kind: "reply", thread: root, text: followUpReply(report.permalink) });
      await save();
    });
  };

  // A split report's other tickets, each found or filed once and linked to
  // `anchor`, the ticket the report itself became or was folded into. A link
  // to a ticket gone in the meantime is dropped: the descriptions still say
  // the report was split.
  const fileParts = async (parts: readonly PartTicket[], anchor: string): Promise<{ key: string; issue: NewIssue }[]> => {
    const filed: { key: string; issue: NewIssue }[] = [];
    for (const { issue, link } of parts) {
      const part = String(issue.part);
      progress.parts ??= {};
      if (progress.parts[part] === undefined) {
        const existing = await port.findFiled(filedIdentity(issue));
        let key = existing;
        if (key === null) {
          key = await port.create(issue, report);
          writes.push({ kind: "create", issue });
        }
        progress.parts[part] = { key };
        await save();
      }
      const done = progress.parts[part]!;
      if (done.linked !== true) {
        for (const [to, why] of [[anchor, SAME_REPORT], ...(link === null ? [] : [[link.key, link.why]])] as const) {
          try {
            await port.link(done.key, to, why, report);
            writes.push({ kind: "link", from: done.key, to, why });
          } catch (error) {
            if (!(error instanceof TargetGone)) throw error;
          }
        }
        done.linked = true;
        await save();
      }
      filed.push({ key: done.key, issue });
    }
    return filed;
  };
  const partsLine = (filed: readonly { key: string }[]): string => (filed.length === 0 ? "" : `, split: also ${filed.map((one) => one.key).join(", ")}`);

  // The tickets this report duplicates that must go to a person now, as its
  // own ticket does: each relabelled once. One gone in the meantime has no
  // label left to disagree with.
  const relabel = async (keys: readonly string[]): Promise<string> => {
    for (const key of keys) {
      if (progress.relabelled?.includes(key)) continue;
      try {
        await port.relabel(key, report);
        writes.push({ kind: "relabel", key, add: PERSON_LABEL, remove: AGENT_LABEL });
      } catch (error) {
        if (!(error instanceof TargetGone)) throw error;
      }
      progress.relabelled = [...(progress.relabelled ?? []), key];
      await save();
    }
    return keys.length === 0 ? "" : `, ${keys.join(", ")} relabelled '${PERSON_LABEL}'`;
  };

  if (outcome.kind === "ignore") {
    return { report: report.id, permalink: report.permalink, outcome: "ignore", key: null, writes, line: `${report.permalink} — ignored: ${outcome.reason}` };
  }

  if (outcome.kind === "comment") {
    if (progress.commented !== true) {
      try {
        if (!(await port.hasComment(outcome.key, report.permalink))) {
          await port.comment(outcome.key, outcome.comment, report);
          writes.push({ kind: "comment", key: outcome.key, body: outcome.comment });
        }
      } catch (error) {
        // The open ticket it duplicates is gone: it is a new report after all,
        // and gets a new report's reply.
        if (error instanceof TargetGone) return applyOne({ kind: "create", issue: outcome.instead, link: null, reply: RECEIVED_REPLY, parts: outcome.parts, relabel: outcome.relabel }, report, deps);
        throw error;
      }
      progress.commented = true;
      await save();
    }
    const parts = await fileParts(outcome.parts, outcome.key);
    const relabelled = await relabel(outcome.relabel);
    const reply = grouping ? groupedReply(outcome.reply, report) : outcome.reply;
    if (progress.replied !== true) {
      if (!(await port.hasReply(report, reply))) {
        await port.reply(report, reply);
        writes.push({ kind: "reply", thread: report.id, text: reply });
      }
      progress.replied = true;
      await save();
    }
    const pendingFollowUps = await followUps();
    return {
      report: report.id,
      permalink: report.permalink,
      outcome: "comment",
      key: outcome.key,
      writes,
      // The reply, not "open": one moved to OA is closed on the intake board, and the
      // reply is what says where the reporter was pointed.
      line: `${report.permalink} — duplicate of ${outcome.key}: comment and thread reply "${outcome.reply}"${partsLine(parts)}${relabelled}${grouped}${shadow}`,
      ...(parts.length === 0 ? {} : { parts }),
      ...(pendingFollowUps.length === 0 ? {} : { pendingFollowUps }),
    };
  }

  if (progress.key === undefined) {
    const existing = await port.findFiled(report.permalink);
    if (existing !== null) {
      progress.key = existing;
    } else {
      progress.key = await port.create(outcome.issue, report);
      writes.push({ kind: "create", issue: outcome.issue });
    }
    await save();
  }
  const key = progress.key;
  if (outcome.link !== null && progress.linked !== true) {
    try {
      await port.link(key, outcome.link.key, outcome.link.why, report);
      writes.push({ kind: "link", from: key, to: outcome.link.key, why: outcome.link.why });
    } catch (error) {
      // The ticket it would link to is gone; the description still names it.
      if (!(error instanceof TargetGone)) throw error;
    }
    progress.linked = true;
    await save();
  }
  const parts = await fileParts(outcome.parts, key);
  const relabelled = await relabel(outcome.relabel);
  if (outcome.reply !== null && progress.replied !== true) {
    const text = grouping ? groupedReply(outcome.reply, report) : outcome.reply;
    // Asked first, because a post that timed out may still have landed, and
    // a crash between the post and the save leaves no other record of it.
    if (!(await port.hasReply(report, text))) {
      await port.reply(report, text);
      writes.push({ kind: "reply", thread: report.id, text });
    }
    progress.replied = true;
    await save();
  }
  const pendingFollowUps = outcome.reply === null ? [] : await followUps();
  const { issue } = outcome;
  return {
    report: report.id,
    permalink: report.permalink,
    outcome: "create",
    key,
    writes,
    issue,
    line:
      `${report.permalink} — ${key}: ${issue.type} ${issue.priority} [${issue.labels.join(", ")}] "${issue.summary}"` +
      `${outcome.link === null ? "" : `, ${outcome.link.why} of ${outcome.link.key}`}${partsLine(parts)}${relabelled}${outcome.reply === null ? "" : `, thread reply${grouped}`}${shadow}`,
    ...(parts.length === 0 ? {} : { parts }),
    ...(pendingFollowUps.length === 0 ? {} : { pendingFollowUps }),
  };
}

/**
 * Post the grouping reply on each of `roots`, the follow-up messages of the
 * report at `reportPermalink`, asking first whether it is already there: a
 * post that timed out may still have landed. `posted` hears of each one —
 * and whether this call wrote it — before the next is tried, so the store
 * records it at once. Returns the
 * roots whose post failed, each with a note, for the caller to retry.
 */
export async function postFollowUps(
  threads: ThreadReplies,
  reportPermalink: string,
  roots: readonly string[],
  note: (line: string) => void,
  posted: (root: string, wrote: boolean) => Promise<void>,
): Promise<string[]> {
  const text = followUpReply(reportPermalink);
  const failed: string[] = [];
  for (const root of roots) {
    let wrote = false;
    try {
      if (!(await threads.hasReply(root, text))) {
        await threads.reply(root, text);
        wrote = true;
      }
    } catch (error) {
      note(`${reportPermalink}: the grouping reply on follow-up message ${root} failed and is retried on a later poll: ${(error as Error).message}`);
      failed.push(root);
      continue;
    }
    await posted(root, wrote);
  }
  return failed;
}

/** A would-be ticket, as the shadow port records it: enough for the shadow canvas to show it as a row. */
export interface ShadowTicket {
  key: string;
  report: string;
  permalink: string;
  /** Which of a split report's tickets it is, from 2; absent on the report's own. */
  part?: number;
  type: IssueType;
  summary: string;
  labels: string[];
  priority: Priority;
  /**
   * Who, how hard and how big (felipearos/ralph#444). Optional because a
   * record stored before then has none, and the canvas shows "-" for it.
   */
  assignee?: Assignee;
  difficulty?: Difficulty;
  storyPoints?: StoryPoints | null;
  /** The field block the live ticket's body would carry (`fieldLines`). */
  fields?: string[];
  createdAt: string;
  /** Reports folded into it as duplicates, the first included. */
  reports: number;
}

/** Everything a shadow apply recorded. Lives in the clerk's store, so it survives restarts and the canvas reads it. */
export interface ShadowRecord {
  tickets: Record<string, ShadowTicket>;
  /** Intended writes, one record per report and kind, oldest first. */
  writes: { report: string; at: string; write: Write }[];
}

export const emptyShadow = (): ShadowRecord => ({ tickets: {}, writes: [] });

/** The would-be key of a report's ticket in shadow: never a real key, so nobody mistakes it for one. */
export const shadowKey = (report: string): string => `SHADOW-${report.replace(".", "")}`;

/** The OA key a clerk records for a move it held back (`clerk.holdOaMove`, felipearos/ralph#443): never a real key either. */
export const heldMovedKey = (key: string): string => `HELD-${key.replace(/[^A-Za-z0-9]/g, "")}`;

/** Whether `key` is one only a shadow run or a held move ever records, which no board holds. */
export const isPlaceholderKey = (key: string): boolean => key.startsWith("SHADOW-") || key.startsWith("HELD-");

/**
 * The shadow port. It holds no client: a shadow apply cannot reach Slack or
 * Jira because nothing here could. Each intended write is recorded once per
 * report and kind — a rerun replaces, never repeats — and the would-be tickets
 * are kept for the shadow canvas.
 */
export function shadowPort(
  record: ShadowRecord,
  now: () => number,
  /**
   * Called after a copied reply is recorded. The apply saves the record with
   * every step itself; a copy made from the gate's thread watch has no such
   * step, and is saved here instead.
   */
  saved: (record: ShadowRecord) => Promise<void> = async () => {},
): WritePort {
  // One record per report and kind — and per reply for a copied reply, of
  // which one report may have many.
  const same = (entry: ShadowRecord["writes"][number], report: string, write: Write): boolean =>
    entry.report === report &&
    entry.write.kind === write.kind &&
    (write.kind !== "thread-comment" || (entry.write.kind === "thread-comment" && entry.write.reply === write.reply)) &&
    // A split report creates and links several tickets: one record each.
    (write.kind !== "create" || (entry.write.kind === "create" && entry.write.issue.part === write.issue.part)) &&
    (write.kind !== "link" || (entry.write.kind === "link" && entry.write.from === write.from && entry.write.to === write.to)) &&
    (write.kind !== "relabel" || (entry.write.kind === "relabel" && entry.write.key === write.key));
  const keep = (report: string, write: Write): void => {
    const at = record.writes.findIndex((entry) => same(entry, report, write));
    const entry = { report, at: new Date(now()).toISOString(), write };
    if (at === -1) record.writes.push(entry);
    else record.writes[at] = entry;
  };
  return {
    mode: "shadow",
    async findFiled(identity) {
      return Object.values(record.tickets).find((ticket) => filedIdentity(ticket) === identity)?.key ?? null;
    },
    async hasComment() {
      return false;
    },
    async hasReply() {
      return false;
    },
    async copyReply(key, body, report, reply) {
      keep(report, { kind: "thread-comment", key, body, reply });
      await saved(record);
    },
    async create(issue, report) {
      const key = issue.part === undefined ? shadowKey(report.id) : `${shadowKey(report.id)}-${issue.part}`;
      record.tickets[key] = {
        key,
        report: report.id,
        permalink: report.permalink,
        ...(issue.part === undefined ? {} : { part: issue.part }),
        type: issue.type,
        summary: issue.summary,
        labels: issue.labels,
        priority: issue.priority,
        assignee: issue.assignee,
        difficulty: issue.difficulty,
        storyPoints: issue.storyPoints,
        fields: fieldLines(issue),
        createdAt: new Date(now()).toISOString(),
        reports: 1,
      };
      keep(report.id, { kind: "create", issue });
      return key;
    },
    async comment(key, body, report) {
      const ticket = record.tickets[key];
      if (ticket !== undefined) ticket.reports += 1;
      keep(report.id, { kind: "comment", key, body });
    },
    async link(from, to, why, report) {
      keep(report.id, { kind: "link", from, to, why });
    },
    async relabel(key, report) {
      keep(report.id, { kind: "relabel", key, add: PERSON_LABEL, remove: AGENT_LABEL });
    },
    async reply(report, text) {
      keep(report.id, { kind: "reply", thread: report.id, text });
    },
  };
}

/** The journal entry for one applied batch: what was filed, commented, replied and ignored, report by report. */
export function journalEntry(input: {
  batch: string;
  mode: ClerkMode;
  attempt: number;
  fallback: boolean;
  lines: readonly string[];
  notes: readonly string[];
  at: string;
}): string {
  const lines = [
    `# Clerk: ${input.batch} (${input.mode})`,
    "",
    `Applied at ${input.at}, plan attempt ${input.attempt}${input.fallback ? "; no valid plan, so every report was filed unclassified" : ""}.`,
    "",
    ...input.lines.map((line) => `- ${line}`),
    ...(input.notes.length === 0 ? [] : ["", "Notes:", "", ...input.notes.map((note) => `- ${note}`)]),
    "",
  ];
  return lines.join("\n");
}
