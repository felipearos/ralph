/**
 * Carrying out a triager's `to-person` outcome on a keyed tracker
 * (felipearos/ralph#397).
 *
 * On a Linear project the triager model only decides: for a report a person
 * must take, `triage-apply.ts` posts one comment with the reason and the
 * triage marker, and nothing else. The move to the team's Jira project needs
 * the Jira token, which must never reach a model session, so it happens here,
 * outside the session, from the triager's intake gate on every poll.
 *
 * `shadow` posts on the Linear issue what it WOULD file and labels the report
 * `moved-to-jira`; it holds no Jira writer and makes no Jira call. `live` files
 * the Jira ticket, says so on the Linear issue, labels it and cancels it.
 *
 * Every step is safe to re-run after a crash at any point, because each one
 * reads before it writes and skips what is already there:
 *   - the Jira ticket: a Linear comment naming its key is the first record of
 *     it; failing that, a search for the one-word marker its description
 *     carries finds a ticket filed by a run that died before that comment.
 *     Only when both miss is one created, so a crash after the create never
 *     files a second ticket;
 *   - the Linear comment carries `opMarker("jira-moved")` (or
 *     `opMarker("jira-shadow")`), looked up before posting;
 *   - `moved-to-jira` is added only when absent;
 *   - the cancel is skipped once the issue is no longer open.
 */
import { createHash } from "node:crypto";

import type { IssueComment } from "../block-reason";
import { JiraError, jqlString, type JiraClient, type JiraNewIssue } from "../clerk/jira";
import { PRIORITIES, SUMMARY_MAX, TYPES, clip, type IssueType } from "../clerk/plan";
import type { TriageJira } from "../project-config";
import { TrackerUnavailableError, type Tracker, type TrackerIssueDetail } from "../tracker/types";
import { firstLine, hasCurrentTriage, triageMarkerOf } from "../triage-marker";
import { carriesOpMarker, opMarker, withOpMarker } from "./body";
import {
  AGENT_PROPOSED_LABEL,
  MOVED_TO_JIRA_LABEL,
  READY_FOR_AGENT_LABEL,
  SLACK_INTAKE_LABEL,
  TO_PERSON_LEAD,
  reportPriority,
} from "./intake";

/** How the live move's Linear comment opens; the Jira key follows it. */
export const MOVED_LEAD = "Pasa al equipo: ";

/** The op id of the live move's Linear comment. */
export const MOVED_OP = "jira-moved";

/** The op id of the shadow move's Linear comment. */
export const SHADOW_OP = "jira-shadow";

/** How many search hits are enough: more than one is already a duplicate. */
const SEARCH_LIMIT = 5;

/** How many issues one label read returns; Linear pages at 250. */
const LABEL_LIMIT = 250;

/**
 * The marker a Jira ticket carries for the Linear issue it came from. One word
 * of lowercase letters and digits, like the clerk's `filedMarker`, because
 * Jira's `text ~` tokenises: `AND-184` would be split at the hyphen and match
 * every ticket that mentions 184. The closing `fin` keeps `AND-18`'s marker
 * from matching inside `AND-184`'s.
 */
export const linearMarker = (ref: string): string => `linearissue${ref.replace(/[^A-Za-z0-9]/g, "").toLowerCase()}fin`;

/**
 * The same marker for a ticket that came from the clerk's Jira intake board
 * (felipearos/ralph#449). Its own prefix, so an intake key and a Linear ref
 * that spell the same letters can never find each other's OA ticket, and
 * `linearMarker` keeps finding the OA tickets filed before the board.
 */
export const intakeMarker = (ref: string): string => `intaketicket${ref.replace(/[^A-Za-z0-9]/g, "").toLowerCase()}fin`;

export interface PendingHandoffOptions {
  scopeLabel: string | null;
  mode: TriageJira["mode"];
}

/**
 * The open reports whose CURRENT triage decision is `to-person` and whose
 * move is not finished, lowest number first. A decision made on a body that
 * has since been edited, or followed by a person's comment, is stale: the
 * frontier offers that report for triage again, and moving it on the old
 * decision would file the team a ticket the triager has not seen.
 *
 * Labels are read first, one call per label, so issues are read only for the
 * candidates that pass them.
 */
export async function pendingHandoffs(tracker: Tracker, options: PendingHandoffOptions): Promise<number[]> {
  const numbers = async (label: string): Promise<Set<number>> =>
    new Set((await tracker.withLabel(label, { state: "open", limit: LABEL_LIMIT })).map((issue) => issue.number));
  const intake = await numbers(SLACK_INTAKE_LABEL);
  const scoped = options.scopeLabel === null ? null : await numbers(options.scopeLabel);
  const proposed = await numbers(AGENT_PROPOSED_LABEL);
  const ready = await numbers(READY_FOR_AGENT_LABEL);
  const moved = await numbers(MOVED_TO_JIRA_LABEL);

  const pending: number[] = [];
  for (const number of [...intake].sort((a, b) => a - b)) {
    if (scoped !== null && !scoped.has(number)) continue;
    if (proposed.has(number) || ready.has(number)) continue;
    // In shadow the label is the whole record: once carried, nothing is left.
    if (options.mode === "shadow" && moved.has(number)) continue;
    const { body, comments } = await tracker.issue(number);
    if (latestToPerson(comments) === null) continue;
    // The gate's own comments come after the marker by design; they are not
    // news the triager has to see, so they do not make the decision stale.
    // The gate never edits the body, so its writes leave the hash matching.
    const own = (comment: IssueComment): boolean => carriesOpMarker(comment.body, MOVED_OP) || carriesOpMarker(comment.body, SHADOW_OP);
    if (!hasCurrentTriage(body, comments.filter((comment) => !own(comment)))) continue;
    // In live, a report carrying the label is pending only when it also
    // carries the live move's comment: a crash between the label and the
    // cancel. A label with no such comment came from SHADOW, and that report
    // was already routed by the test channel; switching shadow to live must
    // not re-send every one of them to the team's Jira.
    if (moved.has(number) && !comments.some((comment) => carriesOpMarker(comment.body, MOVED_OP))) continue;
    pending.push(number);
  }
  return pending;
}

/** The comment carrying the latest triage marker when that marker says `to-person`, else null. */
export function latestToPerson(comments: readonly IssueComment[]): IssueComment | null {
  for (let at = comments.length - 1; at >= 0; at--) {
    const marker = triageMarkerOf(comments[at]!);
    if (marker !== null) return marker.outcome === "to-person" ? comments[at]! : null;
  }
  return null;
}

/** What a report hands to Jira, read off its Linear issue. */
export interface HandoffFields {
  type: IssueType;
  priority: string;
  summary: string;
  /** The report's description, without the clerk's field block and filed marker. */
  description: string;
  reason: string;
  /** The Slack thread, or null when the description names none. */
  permalink: string | null;
  url: string;
  ref: string;
  /**
   * Where the report comes from: a Linear issue (the triager's path, and the
   * default) or a ticket on the clerk's Jira intake board (felipearos/ralph#449).
   * It picks the marker and how the description names the way back.
   */
  origin?: "linear" | "intake";
}

/** The marker of the OA ticket a report moves to, by where it comes from. */
export const handoffMarker = (fields: Pick<HandoffFields, "ref" | "origin">): string =>
  fields.origin === "intake" ? intakeMarker(fields.ref) : linearMarker(fields.ref);

const TYPE_LINE = /^\s*Tipo:\s*(.*?)\s*$/m;
const PERMALINK_LINE = /^Reportado por .* en Slack: (\S+)\s*$/m;
const FIELD_LINE = /^\s*(?:Tipo|Prioridad|App|Dificultad|Puntos de historia sugeridos|Asignado a):/;
const FILED_MARKER = /^slackintake[A-Za-z0-9]+fin$/;

/** The body without the clerk's field block (`clerk/apply.ts` `fieldLines`) and its filed marker. */
export function strippedDescription(body: string): string {
  return body
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .filter((block) => {
      const lines = block.split("\n").filter((line) => line.trim() !== "");
      if (lines.length === 0) return false;
      if (lines.length === 1 && FILED_MARKER.test(lines[0]!.trim())) return false;
      return !lines.every((line) => FIELD_LINE.test(line));
    })
    .join("\n\n")
    .trim();
}

/**
 * The fields to hand over, or a problem naming why this report cannot be.
 *
 * The clerk writes a `Tipo:` and a `Prioridad:` line on every report it files,
 * even an unclassified one (`clerk/plan.ts` `unclassified`), so it has no
 * default for a missing line: a body without one was edited by hand, and a
 * guessed type or priority would file the team a ticket nobody chose.
 */
export function handoffFields(issue: TrackerIssueDetail, ref: string): HandoffFields | { problem: string } {
  const comment = latestToPerson(issue.comments);
  if (comment === null) return { problem: `${ref}'s latest triage decision is not to-person` };
  const lead = firstLine(comment.body);
  if (!lead.startsWith(TO_PERSON_LEAD.trim())) return { problem: `${ref}'s to-person comment does not open with '${TO_PERSON_LEAD.trim()}'` };
  const reason = lead.slice(TO_PERSON_LEAD.trim().length).trim();
  if (reason === "") return { problem: `${ref}'s to-person comment gives no reason` };

  const type = TYPE_LINE.exec(issue.body)?.[1] ?? null;
  if (type === null || !(TYPES as readonly string[]).includes(type)) {
    return { problem: `${ref}'s body names no report type (Tipo: ${TYPES.join(" or ")}); got ${JSON.stringify(type)}` };
  }
  const priority = reportPriority(issue.body);
  if (priority === null || !(PRIORITIES as readonly string[]).includes(priority)) {
    return { problem: `${ref}'s body names no priority (Prioridad: ${PRIORITIES.join(", ")}); got ${JSON.stringify(priority)}` };
  }
  return {
    type: type as IssueType,
    priority,
    // Clara's limit: a hand-edited Linear title can exceed what Jira takes.
    summary: clip(issue.title, SUMMARY_MAX),
    description: strippedDescription(issue.body),
    reason,
    permalink: PERMALINK_LINE.exec(issue.body)?.[1] ?? null,
    url: issue.url,
    ref,
  };
}

/**
 * The Jira description, in Spanish: the report, why a person takes it, the
 * links back, then the marker. Each in its own block, so the marker stays one
 * word on its own line however the description is rendered.
 */
export function jiraDescription(fields: HandoffFields): string {
  return [
    fields.description,
    `Por qué requiere una persona: ${fields.reason}`,
    ...(fields.permalink === null ? [] : [`Hilo de Slack: ${fields.permalink}`]),
    fields.origin === "intake" ? `Ticket en el tablero de ingreso: ${fields.url}` : `Issue en Linear: ${fields.url}`,
    handoffMarker(fields),
  ]
    .filter((block) => block !== "")
    .join("\n\n");
}

/**
 * The ticket as it is (or would be) filed. Explicitly unassigned: the team
 * assigns, and OA's default assignee (its lead) took every moved ticket.
 */
export function jiraIssue(fields: HandoffFields, rules: TriageJira): JiraNewIssue {
  return {
    project: rules.project,
    type: rules.issueTypes[fields.type],
    summary: fields.summary,
    description: jiraDescription(fields),
    labels: [SLACK_INTAKE_LABEL],
    priority: fields.priority,
    unassigned: true,
    ...(typeof rules.parent === "string" ? { parent: rules.parent } : {}),
  };
}

/** The shadow comment: what live would file, field by field. */
export function shadowComment(issue: JiraNewIssue): string {
  return [
    `Se crearía ${issue.project}-? con:`,
    [`Tipo: ${issue.type}`, `Prioridad: ${issue.priority}`, `Resumen: ${issue.summary}`, `Etiquetas: ${issue.labels.join(", ")}`].join("\n"),
    `Descripción:\n\n${issue.description}`,
    opMarker(SHADOW_OP),
  ].join("\n\n");
}

/**
 * The Jira key a live move's Linear comment names, or null. Only the gate's
 * own comment counts: a person writing "Pasa al equipo: OA-9" by hand must
 * not stand in for a ticket the gate never filed.
 */
export function movedKey(comments: readonly IssueComment[]): string | null {
  for (const comment of comments) {
    if (!carriesOpMarker(comment.body, MOVED_OP)) continue;
    const match = /^Pasa al equipo: ([A-Z][A-Z0-9_]*-\d+)\b/m.exec(comment.body);
    if (match) return match[1]!;
  }
  return null;
}

/** The report being moved, as its own tracker holds it: read once, before any write. */
export interface MoveSource {
  ref: string;
  comments: readonly IssueComment[];
  labels: readonly string[];
  /** Whether it is still open: a closed one is not closed again. */
  open: boolean;
}

/** The writes a move makes, on the OA board and on the report's own tracker. */
export interface MoveDeps {
  jira: JiraClient;
  rules: TriageJira;
  /** Every write goes through this, so the caller spaces and counts them. */
  write: <T>(call: () => Promise<T>) => Promise<T>;
  /** Hears the OA key as soon as it is known, so a later failure still names it. */
  found?: (key: string) => void;
  /**
   * Link the report to its OA ticket, where both live on the same Jira site
   * (the intake board); absent for a Linear report, which Jira cannot link.
   */
  link?: (key: string) => Promise<void>;
  comment: (body: string) => Promise<void>;
  addLabel: (label: string) => Promise<void>;
  close: () => Promise<{ movedTo: string | null; warning: string | null }>;
}

/** The live move's comment on the report: the OA key, its link, and the op marker. */
export const movedComment = (site: string, key: string): string => `${MOVED_LEAD}${key}\n\nhttps://${site}/browse/${key}\n\n${opMarker(MOVED_OP)}`;

/**
 * The idempotent live move, whichever tracker the report lives on: the
 * triager's Linear issue (`handOff`) or a ticket confirmed on the clerk's
 * intake board (`clerk/confirm.ts`, felipearos/ralph#449). Each step reads
 * before it writes, so a rerun after a kill at any point finishes the move
 * without a second OA ticket:
 *   1. the OA ticket: named by the report's move comment, else found by the
 *      marker its description carries, else created;
 *   2. from the intake board, the ticket's comments, copied onto the OA
 *      ticket once each (`copyComments`);
 *   3. from the intake board, a "relates to" link to the OA ticket, made
 *      while the move comment is missing: the comment is its record, and Jira
 *      keeps one link of a type between two tickets however often it is sent;
 *   4. the move comment, `Pasa al equipo: OA-n` with `opMarker("jira-moved")`;
 *   5. `moved-to-jira`, the fence that keeps the report from being moved again;
 *   6. the close.
 * Throws whatever a write throws; the caller classifies it. A close that did
 * not happen is not a throw: it comes back as `closeWarning`, because the
 * label already fences the report and retrying the close in a loop would not.
 * Nor is a link Jira refuses (a link type the site lacks, a permission): it
 * comes back as `linkWarning`, because the comment already names the OA
 * ticket and a refused link would otherwise stop every move on the board.
 * A parent Jira refused at the create comes back as `parentWarning`: the
 * ticket is filed at the top level instead.
 */
export async function moveToJira(
  source: MoveSource,
  fields: HandoffFields,
  deps: MoveDeps,
): Promise<{ key: string; closeWarning: string | null; linkWarning: string | null; parentWarning: string | null }> {
  const { jira, rules, write } = deps;
  let key = movedKey(source.comments);
  if (key === null) {
    const marker = handoffMarker(fields);
    const jql = `project = ${jqlString(rules.project)} AND labels = ${jqlString(SLACK_INTAKE_LABEL)} AND text ~ ${jqlString(marker)}`;
    // `text ~` matches words loosely; only a description that carries the
    // marker itself is this report's ticket.
    const hits = await jira.search(jql, SEARCH_LIMIT);
    key = hits.find((hit) => hit.description.includes(marker))?.key ?? null;
  }
  const filed = jiraIssue(fields, rules);
  let parentWarning: string | null = null;
  if (key === null) {
    const created = await write(() => jira.createIssue(filed));
    key = created.key;
    if (created.parentWritten === false) parentWarning = `Jira refused ${filed.parent ?? "its parent"} as its parent; filed at the top level`;
  }
  deps.found?.(key);

  const moved = key;
  if (fields.origin === "intake") await copyComments(source, moved, deps);
  let linkWarning: string | null = null;
  if (!source.comments.some((comment) => carriesOpMarker(comment.body, MOVED_OP))) {
    const link = deps.link;
    if (link !== undefined) {
      try {
        await write(() => link(moved));
      } catch (error) {
        // A transient failure is retried with the rest of the move; a refusal would be refused again.
        if (!(error instanceof JiraError) || error.failure.kind !== "denied") throw error;
        linkWarning = error.failure.why;
      }
    }
    await write(() => deps.comment(movedComment(rules.site, moved)));
  }
  if (!source.labels.includes(MOVED_TO_JIRA_LABEL)) await write(() => deps.addLabel(MOVED_TO_JIRA_LABEL));
  if (source.open) {
    const transition = await write(() => deps.close());
    if (transition.movedTo === null && transition.warning !== null) return { key, closeWarning: transition.warning, linkWarning, parentWarning };
  }
  return { key, closeWarning: null, linkWarning, parentWarning };
}

/** How a comment copied from the intake ticket starts on the OA ticket. */
export const COPIED_LEAD = "Copiado de ";

/** The op id a copied comment carries: its source's text, hashed, so a rerun knows it is there. */
export const copiedOp = (body: string): string => `copied-${createHash("sha256").update(body.trim()).digest("hex").slice(0, 12)}`;

/**
 * Copy the intake ticket's comments onto its OA ticket, oldest first: the
 * reporter's thread replies, the code context, whatever the confirmer wrote.
 * The harness's own op comments are left behind. Each copy carries its
 * source's hash, and the OA ticket is read first, so a rerun after a kill
 * copies only what is missing.
 */
async function copyComments(source: MoveSource, key: string, deps: MoveDeps): Promise<void> {
  const own = source.comments.filter((comment) => !comment.body.includes("<!-- ralph:triage-op ") && comment.body.trim() !== "");
  if (own.length === 0) return;
  const there = await deps.jira.comments(key);
  for (const comment of own) {
    const op = copiedOp(comment.body);
    if (there.some((text) => carriesOpMarker(text, op))) continue;
    await deps.write(() => deps.jira.addComment(key, withOpMarker(`${COPIED_LEAD}${source.ref}:\n\n${comment.body.trim()}`, op)));
  }
}

export interface HandoffDeps {
  tracker: Tracker;
  /** Null when the host holds no Jira credential; always ignored in shadow. */
  jira: JiraClient | null;
  rules: TriageJira;
  sleep: (ms: number) => Promise<void>;
  spacingMs: number;
}

export interface HandoffResult {
  outcome: "moved" | "shadowed" | "waiting" | "denied" | "failed";
  /** The Jira key, once known; always null in shadow. */
  key: string | null;
  writes: number;
  problem: string | null;
  retryAfterSeconds?: number;
  denial?: { code: string; why: string; remedy: string };
}

/**
 * Move report `number` to Jira (live) or say what would be moved (shadow).
 * Never throws, except `TrackerUnavailableError`: a tracker that is not
 * connected is the caller's to report, not one report's.
 */
export async function handOff(number: number, deps: HandoffDeps): Promise<HandoffResult> {
  const { tracker, rules } = deps;
  let writes = 0;
  let key: string | null = null;
  // Spaced like `triage/keyed.ts`: a burst of writes is what trips a throttle.
  const write = async <T>(call: () => Promise<T>): Promise<T> => {
    if (writes > 0) await deps.sleep(deps.spacingMs);
    const value = await call();
    writes += 1;
    return value;
  };
  const result = (outcome: HandoffResult["outcome"], problem: string | null = null): HandoffResult => ({ outcome, key, writes, problem });

  // The shadow path holds no Jira writer: whatever the caller passed, it is
  // never touched there. Live without one refuses before any write.
  const jira = rules.mode === "live" ? deps.jira : null;
  if (rules.mode === "live" && jira === null) {
    const why = `no Jira credential to move ${tracker.ref(number)} to ${rules.project}`;
    return {
      ...result("denied", why),
      denial: {
        code: "no_jira_credential",
        why,
        remedy: "put RALPH_CLERK_JIRA_TOKEN ('<email>:<API token>') in Doppler for this project and check the triager's preflight, then restart",
      },
    };
  }

  try {
    const issue = await tracker.issue(number);
    const ref = tracker.ref(number);
    const fields = handoffFields(issue, ref);
    if ("problem" in fields) return result("failed", fields.problem);
    const filed = jiraIssue(fields, rules);
    const carriesLabel = issue.labels.includes(MOVED_TO_JIRA_LABEL);

    if (jira === null) {
      if (!issue.comments.some((comment) => carriesOpMarker(comment.body, SHADOW_OP))) {
        await write(() => tracker.comment(number, shadowComment(filed)));
      }
      if (!carriesLabel) await write(() => tracker.addLabels(number, [MOVED_TO_JIRA_LABEL]));
      return result("shadowed");
    }

    const moved = await moveToJira({ ref, comments: issue.comments, labels: issue.labels, open: issue.state === "open" }, fields, {
      jira,
      rules,
      write,
      found: (found) => {
        key = found;
      },
      comment: (body) => tracker.comment(number, body),
      addLabel: (label) => tracker.addLabels(number, [label]),
      close: () => tracker.cancel(number),
    });
    if (moved.closeWarning !== null) return result("failed", `${ref} moved to ${key} but was not cancelled: ${moved.closeWarning}`);
    return result("moved");
  } catch (error) {
    if (error instanceof TrackerUnavailableError) throw error;
    if (error instanceof JiraError) {
      const failure = error.failure;
      if (failure.kind === "transient") return result("waiting", failure.why);
      if (failure.kind === "rate-limited") return { ...result("waiting", failure.why), retryAfterSeconds: failure.retryAfterSeconds };
      // A 400 is this report's fields — a type, priority or label the project
      // refuses — not the credential: the next report may well file.
      if (failure.code === "jira_bad_request") return result("failed", failure.why);
      // `clerk/jira.ts` words its remedy for the clerk's config block; the
      // triager's site and project come from `triage.jira`.
      const remedy = failure.remedy.replaceAll("'clerk.jira'", "'triage.jira'");
      return { ...result("denied", failure.why), denial: { code: failure.code, why: failure.why, remedy } };
    }
    const signal = tracker.classifyFailure(error);
    const message = error instanceof Error ? error.message : String(error);
    if (signal !== null) {
      return { ...result("waiting", message), ...(signal.retryAfterSeconds === null ? {} : { retryAfterSeconds: signal.retryAfterSeconds }) };
    }
    return result("failed", message);
  }
}
