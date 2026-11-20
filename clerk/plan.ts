/**
 * The clerk's plan: what the session writes, and the validator that decides
 * whether code will act on it (felipearos/ralph#315).
 *
 * The session only classifies. It reads a batch of reports with their dedupe
 * candidates (`clerk/batch.ts`) and writes one JSON file; it has no Slack or
 * Jira write path. This module is the boundary between that file and every
 * write: Slack text is untrusted, a model can be talked into anything, and the
 * one thing a message cannot do is get a plan past these rules.
 *
 *   {
 *     "batch": "<the batch id>",
 *     "entries": [
 *       { "report": "<report id>", "verdict": "issue" | "decision" | "ignore",
 *         "type": "Error" | "Tarea", "app": "Backoffice" | "pwa" | "both" | "none",
 *         "priority": "Highest" | "High" | "Medium" | "Low" | "Sin Prioridad",
 *         "assignee": "agent" | "person", "difficulty": "easy" | "medium" | "hard",
 *         "story_points": 1 | 2 | 3 | 5 | 8,
 *         "duplicate_of": "<a key from the candidates>" | "<an earlier report's id>" | null,
 *         "duplicate_confidence": "sure" | "unsure",
 *         "summary_es": "…", "description_es": "…", "ignore_reason": "…" }
 *     ]
 *   }
 *
 * Which fields an entry needs depends on its verdict: an `issue` needs all of
 * type, app, priority, assignee, difficulty, story points, summary and
 * description; a `decision` needs app, difficulty, story points, summary and
 * description, and is always a `Tarea` at `Sin Prioridad` for a `person`; an
 * `ignore` needs only its reason (felipearos/ralph#444).
 *
 * Some reports go to a person whatever the session says: Highest priority,
 * both apps, or an app no agent project works (`triage/intake.ts`
 * `forcedToPerson`). Such an entry's `agent` becomes `person` with a note
 * rather than a refusal, because the rest of its classification is still good
 * and a refusal would cost the whole batch a turn.
 *
 * A plan is valid or it is not: an unknown enum value, a missing field, a
 * report the batch does not hold or one it holds left out, and the whole plan
 * is refused. The gate hands the batch over once more with the problems, and a
 * second refusal files every report unclassified. The one exception is a
 * `duplicate_of` the session was not offered — a key it invented, or another
 * report's candidate — which downgrades THAT entry to a new ticket marked
 * "posible duplicado" rather than failing the plan: a report is never merged
 * into a ticket nobody has shown to exist, and never lost because of it.
 *
 * A report may also duplicate an EARLIER report of its own batch: the board
 * candidates are read once, before any of the batch is filed, so without this
 * two reports of one problem in one batch were filed twice. `duplicate_of`
 * then names that report's id, and the apply resolves it to the ticket the
 * earlier report was filed as or folded into — which exists by then, because
 * reports are applied in batch order. A chain (C → B → A) resolves here to
 * its root, sure only if every link was sure. Naming the report itself, a
 * later one, or one the plan ignores is downgraded like an unoffered key.
 *
 * A duplicate goes to whoever the ticket it duplicates goes to, so one
 * problem is never an agent's on one ticket and a person's on another: its
 * assignee is the original's `para-agente` / `para-persona`, whatever the
 * session said. Only a rule above outranks that — a decision, or an entry
 * `forcedToPerson`, is a person's — and then the original follows it
 * instead: the decision names the original for the apply to relabel
 * `para-persona` (`relabel`), and every report of the batch that duplicates
 * the same one goes to a person too.
 */
import { forcedToPerson, POR_DECIDIR_LABEL, type AppLabels } from "../triage/intake";
import type { Report } from "./reports";

export const VERDICTS = ["issue", "decision", "ignore"] as const;
export const TYPES = ["Error", "Tarea"] as const;
export const APPS = ["Backoffice", "pwa", "both", "none"] as const;
/** `Lowest` exists in the project and is deliberately not offered: the rubric does not use it. */
export const PRIORITIES = ["Highest", "High", "Medium", "Low", "Sin Prioridad"] as const;
export const CONFIDENCES = ["sure", "unsure"] as const;
/** How hard the work is, as Jav routes it: written as a `difficulty:<level>` label. */
export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
/** Story points, Fibonacci up to 8: anything bigger is a report to split, not to size. */
export const STORY_POINTS = [1, 2, 3, 5, 8] as const;
/** Who does the work: an agent loop, or a person on the team. */
export const ASSIGNEES = ["agent", "person"] as const;

export type Verdict = (typeof VERDICTS)[number];
export type IssueType = (typeof TYPES)[number];
export type App = (typeof APPS)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Confidence = (typeof CONFIDENCES)[number];
export type Difficulty = (typeof DIFFICULTIES)[number];
export type StoryPoints = (typeof STORY_POINTS)[number];
export type Assignee = (typeof ASSIGNEES)[number];

/** The label of a ticket the clerk judged an agent's work. */
export const AGENT_LABEL = "para-agente";
/** The label of a ticket the clerk judged a person's work. */
export const PERSON_LABEL = "para-persona";

/** An issue the session was offered as a possible duplicate of a report. */
export interface Candidate {
  /** The intake ticket's key (`OAI-12`): what a comment goes on and what `duplicate_of` names. */
  key: string;
  summary: string;
  /** The ticket's workflow status name, as the intake board reads it. */
  status: string;
  /** When it was closed (ISO 8601), or null while it is open. */
  closed: string | null;
  labels: string[];
  /** The Jira key (`OA-12`) of a `moved-to-jira` issue, read from its comments; null otherwise, or when none names one. */
  jiraKey: string | null;
  /**
   * The Slack permalink of the report the ticket was filed from, read from its
   * description; null when it names none. Optional: a batch saved before it
   * existed still loads, and its duplicates reply with the key alone.
   */
  permalink?: string | null;
}

/** A report as the session is handed it: the report, who wrote it, and what it might duplicate. */
export interface BatchReport extends Report {
  /** The reporter's name as Slack shows it, or their user id when Slack could not say. */
  authorName: string;
  /** Every user in the report, author and repliers, by id. */
  names: Record<string, string>;
  /**
   * Set when the report was ignored and a person then asked, in its thread,
   * for it to be filed (felipearos/ralph#323): their name. The plan may not
   * ignore it again.
   */
  hint?: string;
  candidates: Candidate[];
}

/** What code will do with one report, once the plan has passed. */
export type Decision =
  | { report: string; verdict: "ignore"; reason: string }
  | {
      report: string;
      verdict: "issue" | "decision";
      type: IssueType;
      app: App;
      priority: Priority;
      assignee: Assignee;
      difficulty: Difficulty;
      /** Null only on an unclassified report: nobody sized it. */
      storyPoints: StoryPoints | null;
      summary: string;
      description: string;
      /** An offered candidate it duplicates, and how sure the session was. */
      duplicate: { candidate: Candidate; confidence: Confidence } | null;
      /** A key the session named that it was never offered: filed new, marked "posible duplicado". */
      unverifiedDuplicate: string | null;
      /**
       * An earlier report of the same batch it duplicates, resolved to the
       * root of any chain: the apply turns it into the ticket that report
       * became. Absent on a plan with none, and on a hand-built decision.
       */
      batchDuplicate?: { report: string; confidence: Confidence };
      /** Filed after the session failed twice to classify it: labelled for a person to sort. */
      unclassified?: true;
      /**
       * Board tickets this report, or one of its parts, duplicates that are an
       * agent's while the duplicate must be a person's: the apply moves each
       * from `para-agente` to `para-persona`. Absent when there are none.
       */
      relabel?: string[];
      /**
       * The report's other problems, when it describes several that are not
       * one (a PDF of four bugs): each filed as its own ticket, linked to the
       * report's. Absent on a report with one.
       */
      parts?: Part[];
    };

/** One more problem of a report that describes several: a ticket of its own. */
export interface Part {
  type: IssueType;
  app: App;
  priority: Priority;
  assignee: Assignee;
  difficulty: Difficulty;
  storyPoints: StoryPoints;
  summary: string;
  description: string;
  /**
   * An offered candidate it may already be: linked and marked "posible
   * duplicado", never folded into it as a comment, because the report's
   * other problems are filed whatever this one is.
   */
  duplicate: Candidate | null;
  /** A key it named that it was never offered, as on a report's own entry. */
  unverifiedDuplicate: string | null;
}

/** The most problems one report is split into, its own included: past that it is a list for a person to sort. */
export const MAX_PARTS = 10;

export type Validated = { ok: true; decisions: Decision[]; notes: string[] } | { ok: false; problems: string[] };

/** What a Jira key looks like: `OA-12`. */
const TICKET_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

/** The longest summary Jira accepts. */
export const SUMMARY_MAX = 255;

/** Where the session writes the plan for a batch: the logs dir, which is ignored, so writing it never dirties the checkout. */
export const planPath = (batchId: string): string => `.ralph/logs/clerk-plan-${batchId}.json`;

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

export interface PlanOptions {
  /**
   * Whether an agent project works the pwa repo: the project's
   * `clerk.pwaAgents`, false by default, so a pwa report goes to a person.
   * The gate and `clerk/batch.ts --check` both pass it, so the validator and
   * the prompt (`RALPH_CLERK_AGENT_APPS`) agree on which apps have agents.
   */
  pwaAgents?: boolean;
  /** The project's `appLabels`: the labels the entry would be filed with, which `forcedToPerson` reads. */
  apps: AppLabels;
}

/**
 * The labels `forcedToPerson` reads, as the entry would be filed with them:
 * its app's repo labels (`none` files under backoffice, as
 * `clerkAppLabels` says) and `por-decidir` for a decision.
 */
const forcedLabels = (app: App, verdict: "issue" | "decision", apps: AppLabels): Set<string> => {
  const labels = new Set<string>(app === "pwa" ? [apps.pwa] : app === "both" ? [apps.backoffice, apps.pwa] : [apps.backoffice]);
  if (verdict === "decision") labels.add(POR_DECIDIR_LABEL);
  return labels;
};

/**
 * Validate `raw` (the parsed plan file, or the parse error as a string)
 * against the batch it is for. Never throws.
 */
export function validatePlan(raw: unknown, batchId: string, reports: readonly BatchReport[], options: PlanOptions): Validated {
  if (typeof raw === "string") return { ok: false, problems: [raw] };
  if (!isObject(raw)) return { ok: false, problems: ["the plan must be a JSON object with 'batch' and 'entries'"] };
  const problems: string[] = [];
  if (raw.batch !== batchId) problems.push(`'batch' must be '${batchId}', the batch you were handed; got ${JSON.stringify(raw.batch)}`);
  if (!Array.isArray(raw.entries)) return { ok: false, problems: [...problems, "'entries' must be an array with one entry per report"] };

  const byId = new Map(reports.map((report) => [report.id, report]));
  const order = new Map(reports.map((report, index) => [report.id, index]));
  /** Entries that named an earlier report, resolved once every entry is read. */
  const inBatch: { from: string; to: string; confidence: Confidence }[] = [];
  const seen = new Set<string>();
  const decisions: Decision[] = [];
  const notes: string[] = [];
  raw.entries.forEach((entry, index) => {
    const where = `entries[${index}]`;
    if (!isObject(entry)) {
      problems.push(`${where} must be an object`);
      return;
    }
    const id = text(entry.report);
    const report = id === null ? undefined : byId.get(id);
    if (report === undefined) {
      problems.push(`${where}.report must be the id of a report in this batch; got ${JSON.stringify(entry.report)}`);
      return;
    }
    if (seen.has(report.id)) {
      problems.push(`${where}.report ${report.id} has a second entry`);
      return;
    }
    seen.add(report.id);
    const at = `${where} (report ${report.id})`;
    const verdict = entry.verdict;
    if (!(VERDICTS as readonly unknown[]).includes(verdict)) {
      problems.push(`${at}.verdict must be one of ${VERDICTS.join(", ")}; got ${JSON.stringify(verdict)}`);
      return;
    }
    if (verdict === "ignore" && report.hint !== undefined) {
      problems.push(`${at}.verdict may not be "ignore": ${report.hint} said in its thread that this is a report, so it is an issue or a decision`);
      return;
    }
    if (verdict === "ignore") {
      const reason = oneLine(entry.ignore_reason);
      if (reason === null) problems.push(`${at}.ignore_reason must say in one line why this is not a report`);
      else decisions.push({ report: report.id, verdict, reason });
      return;
    }

    const local: string[] = [];
    const pick = picker(entry, at, local);
    // A decision is a Tarea at Sin Prioridad by definition: the team decides
    // on it in grooming. The session may leave both out, and may not say
    // otherwise — a decision filed as a High Error is the bug the verdict
    // exists to avoid.
    const type = verdict === "decision" ? pick("type", ["Tarea"] as const, "Tarea") : pick("type", TYPES);
    const priority = verdict === "decision" ? pick("priority", ["Sin Prioridad"] as const, "Sin Prioridad") : pick("priority", PRIORITIES);
    const app = pick("app", APPS);
    // A decision is a person's by definition, like its type and priority.
    let assignee = verdict === "decision" ? pick("assignee", ["person"] as const, "person") : pick("assignee", ASSIGNEES);
    const difficulty = pick("difficulty", DIFFICULTIES);
    const { storyPoints, summary, description } = sizedAndWritten(entry, at, local);

    let duplicate: { candidate: Candidate; confidence: Confidence } | null = null;
    let unverifiedDuplicate: string | null = null;
    const named = entry.duplicate_of;
    if (named !== null && named !== undefined) {
      const key = text(named);
      if (key === null) {
        local.push(`${at}.duplicate_of must be a ticket key from this report's candidates, an earlier report's id, or null`);
      } else {
        const candidate = report.candidates.find((offered) => offered.key === key);
        const named = byId.get(key);
        if (candidate === undefined && named !== undefined && order.get(named.id)! < order.get(report.id)!) {
          const confidence = pick("duplicate_confidence", CONFIDENCES);
          if (confidence !== null) inBatch.push({ from: report.id, to: named.id, confidence });
        } else if (candidate === undefined && named !== undefined) {
          // Itself or a later report: the later one is not filed yet when
          // this one is, so there is nothing to merge into. Its link names the
          // other report for whoever confirms the ticket.
          unverifiedDuplicate = named.id === report.id ? null : named.permalink;
          notes.push(
            `report ${report.id}: duplicate_of ${JSON.stringify(key)} is ${named.id === report.id ? "the report itself" : "a later report of the batch"}; filed new${unverifiedDuplicate === null ? "" : ', marked "posible duplicado"'}`,
          );
        } else if (candidate === undefined) {
          // Downgraded rather than refused: see the module comment. Named in
          // the ticket only when it at least looks like a ticket key — the
          // text goes into a description the team reads.
          unverifiedDuplicate = TICKET_KEY.test(key) ? key : null;
          notes.push(`report ${report.id}: duplicate_of ${JSON.stringify(key)} was not among its candidates; filed new${unverifiedDuplicate === null ? "" : ', marked "posible duplicado"'}`);
        } else {
          const confidence = pick("duplicate_confidence", CONFIDENCES);
          if (confidence !== null) duplicate = { candidate, confidence };
        }
      }
    }
    const relabel: string[] = [];
    const parts = partsOf(entry, at, verdict as "issue" | "decision", report, options, local, notes, relabel);
    if (local.length > 0) {
      problems.push(...local);
      return;
    }
    if (assignee === "agent") assignee = assigneeFor(app!, verdict as "issue" | "decision", priority!, options, (forced) => notes.push(`report ${report.id}: assignee "agent" changed to "person": ${forced}`));
    decisions.push({
      report: report.id,
      verdict: verdict as "issue" | "decision",
      type: type!,
      app: app!,
      priority: priority!,
      assignee: assignee!,
      difficulty: difficulty!,
      storyPoints,
      summary: summary!,
      description: description!,
      duplicate,
      unverifiedDuplicate,
      ...(parts.length === 0 ? {} : { parts }),
      ...(relabel.length === 0 ? {} : { relabel }),
    });
  });
  for (const report of reports) {
    if (!seen.has(report.id)) problems.push(`report ${report.id} has no entry; every report in the batch needs one`);
  }
  if (problems.length > 0) return { ok: false, problems };
  // In batch order, whatever order the session wrote them in: the cursor
  // advances report by report, oldest first.
  decisions.sort((a, b) => order.get(a.report)! - order.get(b.report)!);
  resolveInBatch(decisions, inBatch, byId, notes);
  matchDuplicates(decisions, options, notes);
  return { ok: true, decisions, notes };
}

/**
 * Resolve each in-batch reference to the root of its chain, in batch order,
 * so an earlier report is resolved before any report that names it: one hop
 * to the earlier report, and from there to wherever it already resolved.
 */
function resolveInBatch(
  decisions: Decision[],
  inBatch: readonly { from: string; to: string; confidence: Confidence }[],
  byId: ReadonlyMap<string, BatchReport>,
  notes: string[],
): void {
  const decisionOf = new Map(decisions.map((decision) => [decision.report, decision]));
  const refOf = new Map(inBatch.map((ref) => [ref.from, ref]));
  for (const decision of decisions) {
    const ref = refOf.get(decision.report);
    if (ref === undefined || decision.verdict === "ignore") continue;
    const target = decisionOf.get(ref.to)!;
    if (target.verdict === "ignore") {
      // Nothing was filed for it, so nothing to merge into; the link still
      // names it for whoever confirms the ticket.
      decision.unverifiedDuplicate = byId.get(ref.to)!.permalink;
      notes.push(`report ${decision.report}: duplicate_of ${ref.to} is a report this plan ignores; filed new, marked "posible duplicado"`);
      continue;
    }
    const via = target.batchDuplicate;
    decision.batchDuplicate =
      via === undefined
        ? { report: ref.to, confidence: ref.confidence }
        : // A chain is only as sure as its least sure link.
          { report: via.report, confidence: via.confidence === "sure" && ref.confidence === "sure" ? "sure" : "unsure" };
  }
}

/**
 * Who does it, by a ticket's `para-*` labels. Both labels is a person, as the
 * confirmation sweep reads them (`clerk/confirm.ts`); neither is null.
 */
export function assigneeOfLabels(labels: readonly string[]): Assignee | null {
  if (labels.includes(PERSON_LABEL)) return "person";
  return labels.includes(AGENT_LABEL) ? "agent" : null;
}

/** Why an entry must go to a person whoever its original goes to, or null when an agent may take it. */
function personOnly(app: App, verdict: "issue" | "decision", priority: Priority, options: PlanOptions): string | null {
  if (verdict === "decision") return "a decision is a person's";
  return forcedWhy(app, verdict, priority, options);
}

/**
 * One label for every ticket of one problem. A report, the earlier reports
 * of the batch that duplicate it (its chain, resolved to it), and the board
 * ticket it duplicates go to one assignee: a person's when any of them must
 * be (the original is relabelled `para-persona` for it), else the board
 * ticket's, else the report's own.
 */
function matchDuplicates(decisions: Decision[], options: PlanOptions, notes: string[]): void {
  type Filed = Extract<Decision, { verdict: "issue" | "decision" }>;
  const groups = new Map<string, Filed[]>();
  for (const decision of decisions) {
    if (decision.verdict === "ignore") continue;
    const root = decision.batchDuplicate?.report ?? decision.report;
    groups.set(root, [...(groups.get(root) ?? []), decision]);
  }
  for (const [rootId, members] of groups) {
    const root = members.find((member) => member.report === rootId)!;
    const board = root.duplicate?.candidate ?? null;
    const original = board === null ? null : assigneeOfLabels(board.labels);
    if (members.length === 1 && original === null) continue;
    let forced: { report: string; why: string } | null = null;
    for (const member of members) {
      const why = personOnly(member.app, member.verdict, member.priority, options);
      if (why !== null) {
        forced = { report: member.report, why };
        break;
      }
    }
    const target: Assignee = forced !== null ? "person" : (original ?? root.assignee);
    for (const member of members) {
      if (member.assignee === target) continue;
      // A forced member is a person's already, so it is never the one changed.
      const source =
        forced !== null && original !== "person"
          ? `report ${forced.report}, a report of the same problem that goes to a person: ${forced.why}`
          : member === root
            ? `${board!.key}, which it duplicates`
            : `report ${rootId}, which it duplicates`;
      notes.push(`report ${member.report}: assignee "${member.assignee}" changed to "${target}" to match ${source}`);
      member.assignee = target;
    }
    if (target === "person" && original === "agent") {
      root.relabel = [...new Set([...(root.relabel ?? []), board!.key])];
      notes.push(`report ${rootId}: ${board!.key}, which it duplicates, relabelled "${PERSON_LABEL}" to match: ${forced!.report === rootId ? "it" : `report ${forced!.report}`} goes to a person: ${forced!.why}`);
    }
  }
}

/** Reads one enumerated field of `entry`, pushing a problem onto `local` when it is not one of `values`. */
const picker =
  (entry: Record<string, unknown>, at: string, local: string[]) =>
  <T extends string>(field: string, values: readonly T[], fallback?: T): T | null => {
    const value = entry[field];
    if ((value === undefined || value === null) && fallback !== undefined) return fallback;
    if ((values as readonly unknown[]).includes(value)) return value as T;
    local.push(`${at}.${field} must be one of ${values.join(", ")}; got ${JSON.stringify(value)}`);
    return null;
  };

/** An entry's story points, summary and description, each pushing its problem onto `local` when it is wrong. */
function sizedAndWritten(entry: Record<string, unknown>, at: string, local: string[]): { storyPoints: StoryPoints | null; summary: string | null; description: string | null } {
  const points = entry.story_points;
  // Numbers only: "3" is refused like 4, so a session that writes strings
  // learns the schema instead of code guessing what it meant.
  const storyPoints = typeof points === "number" && (STORY_POINTS as readonly number[]).includes(points) ? (points as StoryPoints) : null;
  if (storyPoints === null) local.push(`${at}.story_points must be one of ${STORY_POINTS.join(", ")}, as a number; got ${JSON.stringify(points)}`);
  const summary = oneLine(entry.summary_es);
  if (summary === null) local.push(`${at}.summary_es must be a one-line summary in Spanish`);
  else if (summary.length > SUMMARY_MAX) local.push(`${at}.summary_es is ${summary.length} characters; Jira takes at most ${SUMMARY_MAX}`);
  const description = text(entry.description_es);
  if (description === null) local.push(`${at}.description_es must describe the report in Spanish`);
  return { storyPoints, summary, description };
}

/** Why the labels the entry would be filed with send it to a person (`forcedToPerson`), or null. */
const forcedWhy = (app: App, verdict: "issue" | "decision", priority: Priority, options: PlanOptions): string | null =>
  forcedToPerson(
    { labels: forcedLabels(app, verdict, options.apps), body: `Prioridad: ${priority}` },
    { scopeLabel: options.pwaAgents === true ? options.apps.pwa : options.apps.backoffice, apps: options.apps },
  );

/** `agent`, unless the labels the ticket would carry send it to a person (`forcedToPerson`): then `person`, and `forced` hears why. */
function assigneeFor(app: App, verdict: "issue" | "decision", priority: Priority, options: PlanOptions, forced: (why: string) => void): Assignee {
  const why = forcedWhy(app, verdict, priority, options);
  if (why === null) return "agent";
  forced(why);
  return "person";
}

/**
 * An entry's `additional_issues`: the report's other problems, each an issue
 * of its own. Only an `issue` may have them — a decision is one question for
 * the team — and each is checked as an issue entry is, but for its duplicate,
 * which may only be a candidate and is never folded into it.
 */
function partsOf(
  entry: Record<string, unknown>,
  at: string,
  verdict: "issue" | "decision",
  report: BatchReport,
  options: PlanOptions,
  local: string[],
  notes: string[],
  relabel: string[],
): Part[] {
  const raw = entry.additional_issues;
  if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) return [];
  if (verdict !== "issue") {
    local.push(`${at}.additional_issues is only for an "issue": a decision is one question for the team`);
    return [];
  }
  if (!Array.isArray(raw)) {
    local.push(`${at}.additional_issues must be an array of issues, one per other problem the report describes`);
    return [];
  }
  if (raw.length > MAX_PARTS - 1) {
    local.push(`${at}.additional_issues has ${raw.length} issues; one report is split into at most ${MAX_PARTS} tickets, its own included`);
    return [];
  }
  const parts: Part[] = [];
  raw.forEach((item, index) => {
    const where = `${at}.additional_issues[${index}]`;
    if (!isObject(item)) {
      local.push(`${where} must be an object`);
      return;
    }
    const mine: string[] = [];
    const pick = picker(item, where, mine);
    const type = pick("type", TYPES);
    const app = pick("app", APPS);
    const priority = pick("priority", PRIORITIES);
    let assignee = pick("assignee", ASSIGNEES);
    const difficulty = pick("difficulty", DIFFICULTIES);
    const { storyPoints, summary, description } = sizedAndWritten(item, where, mine);
    let duplicate: Candidate | null = null;
    let unverifiedDuplicate: string | null = null;
    const named = item.duplicate_of;
    if (named !== null && named !== undefined) {
      const key = text(named);
      duplicate = key === null ? null : (report.candidates.find((offered) => offered.key === key) ?? null);
      if (key === null) mine.push(`${where}.duplicate_of must be a ticket key from this report's candidates, or null`);
      else if (duplicate === null) {
        unverifiedDuplicate = TICKET_KEY.test(key) ? key : null;
        notes.push(`report ${report.id}: additional_issues[${index}].duplicate_of ${JSON.stringify(key)} was not among its candidates; filed new${unverifiedDuplicate === null ? "" : ', marked "posible duplicado"'}`);
      }
    }
    if (mine.length > 0) {
      local.push(...mine);
      return;
    }
    if (assignee === "agent") assignee = assigneeFor(app!, "issue", priority!, options, (forced) => notes.push(`report ${report.id}: additional_issues[${index}] assignee "agent" changed to "person": ${forced}`));
    const original = duplicate === null ? null : assigneeOfLabels(duplicate.labels);
    if (original !== null && original !== assignee) {
      // A part and the board ticket it may be: one label, as for a report's own.
      const forced = forcedWhy(app!, "issue", priority!, options);
      if (original === "agent" && forced !== null) {
        if (!relabel.includes(duplicate!.key)) relabel.push(duplicate!.key);
        notes.push(`report ${report.id}: ${duplicate!.key}, which additional_issues[${index}] duplicates, relabelled "${PERSON_LABEL}" to match: ${forced}`);
      } else {
        notes.push(`report ${report.id}: additional_issues[${index}] assignee "${assignee}" changed to "${original}" to match ${duplicate!.key}, which it duplicates`);
        assignee = original;
      }
    }
    parts.push({
      type: type!,
      app: app!,
      priority: priority!,
      assignee: assignee!,
      difficulty: difficulty!,
      storyPoints: storyPoints!,
      summary: summary!,
      description: description!,
      duplicate,
      unverifiedDuplicate,
    });
  });
  return parts;
}

function oneLine(value: unknown): string | null {
  const line = text(value);
  return line === null || /[\n\r]/.test(line) ? null : line;
}

/**
 * The plan for a batch whose session failed twice: every report filed as a
 * `Tarea` at `Sin Prioridad` for a person, at `medium` difficulty and with no
 * story points, labelled `intake-sin-clasificar` by the apply, so no report is
 * dropped because the model could not classify it.
 */
export function unclassified(reports: readonly BatchReport[]): Decision[] {
  return reports.map((report) => ({
    report: report.id,
    verdict: "issue",
    type: "Tarea",
    app: "none",
    priority: "Sin Prioridad",
    assignee: "person",
    difficulty: "medium",
    storyPoints: null,
    summary: clip(`Reporte sin clasificar de ${report.authorName}: ${firstLine(report)}`, SUMMARY_MAX),
    description: "El clerk no pudo clasificar este reporte. Revisar y clasificar a mano.",
    duplicate: null,
    unverifiedDuplicate: null,
    unclassified: true,
  }));
}

const firstLine = (report: Report): string =>
  (report.messages.find((message) => message.text.trim() !== "")?.text ?? "(sin texto)").split("\n")[0]!.trim();

export const clip = (value: string, max: number): string => (value.length <= max ? value : `${value.slice(0, max - 3).trimEnd()}...`);
