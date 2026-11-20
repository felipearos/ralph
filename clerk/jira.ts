#!/usr/bin/env bun
/**
 * The clerk's Jira client: the REST calls the clerk makes against Jira Cloud,
 * through an injected `fetch`, so every test runs against a fake and never the
 * network (felipearos/ralph#315).
 *
 * Failures are classified the way `clerk/slack.ts` classifies Slack's, and for
 * the same reason — none of them may hang or halt a loop left running
 * overnight:
 *
 * - `transient` — a 5xx, a timeout, the network: wait and retry;
 * - `rate-limited` — HTTP 429, for what `Retry-After` says;
 * - `denied` — 401, 403, a project that is not there, or a request Jira
 *   refuses as malformed (a priority or issue type the project does not have):
 *   waiting fixes none of them, so the loop stops with the remedy.
 *
 * The credential is `RALPH_CLERK_JIRA_TOKEN`, written `<email>:<api token>` —
 * the pair Jira Cloud's basic auth takes, in one secret so the supervisor can
 * prove and hand over one value. The site and the project come from the
 * project's `clerk` block. It is a `gate` secret: no model session holds it.
 *
 * Usage:
 *   bun clerk/jira.ts --check-token   can the token read the configured project?
 *
 * Exit codes for `--check-token`: 0 usable · 1 refused · 2 Jira could not be
 * reached · 64 usage.
 */
import { openAsBlob } from "node:fs";

import { clerkRules, loadProjectConfig, triageRules } from "../project-config";
import { projectRoot } from "../paths";
import { retryAfterSeconds, type Fetch } from "./slack";

export const JIRA_TOKEN_ENV = "RALPH_CLERK_JIRA_TOKEN";

export const CALL_TIMEOUT_MS = 20_000;

/** How long one attachment upload may take: a 100 MB file on a slow link, and no longer. */
export const UPLOAD_TIMEOUT_MS = 10 * 60_000;

/** One file on a ticket, as the clerk reads it to tell whether it is already there. */
export interface JiraAttachment {
  id: string;
  filename: string;
  size: number;
}

/** A file on disk to attach, under the name the ticket shows. */
export interface JiraUpload {
  path: string;
  name: string;
  /** Its media type, so Jira previews an image or a video; Jira guesses from the name without one. */
  type?: string;
}

export type JiraFailure =
  | { kind: "transient"; why: string }
  | { kind: "rate-limited"; why: string; retryAfterSeconds: number }
  /** `fields`: the fields a 400 named as the ones it refused, so a caller can drop an optional one and retry. */
  | { kind: "denied"; code: string; why: string; remedy: string; fields?: string[] };

export class JiraError extends Error {
  constructor(readonly failure: JiraFailure) {
    super(failure.why);
    this.name = "JiraError";
  }
}

/** One issue as the clerk reads it. */
export interface JiraIssue {
  key: string;
  summary: string;
  type: string;
  status: string;
  /** `new`, `indeterminate` or `done`: Jira's own grouping of a workflow's statuses. */
  statusCategory: string;
  priority: string | null;
  labels: string[];
  created: string;
  /** When it was resolved, or null while it is open. */
  resolved: string | null;
  /** The description as plain text, flattened from Atlassian Document Format. */
  description: string;
  /** How many comments it has. */
  comments: number;
  /**
   * When it moved to Jira's "done" category, or null. A workflow can close a
   * ticket without setting a resolution, and such a ticket is still closed.
   */
  doneAt: string | null;
  /** The comments the search returned, as plain text. */
  commentTexts: string[];
  /** The story points, when the search asked for their field and the ticket has a number in it. */
  storyPoints: number | null;
  assignee: JiraUser | null;
  reporter: JiraUser | null;
  /** The resolution's name ("Listo", "No se hará", ...), or null while it has none. */
  resolution: string | null;
}

/** A Jira account, as an issue or a changelog names it. */
export interface JiraUser {
  accountId: string;
  displayName: string;
}

/** One status change off a ticket's changelog. */
export interface JiraStatusChange {
  from: string;
  to: string;
  /** When, as Jira wrote it. */
  at: string;
  /** Who; null for a change no account made (an import, some automation). */
  by: JiraUser | null;
}

/** One comment, as a code-context case reads it. */
export interface JiraComment {
  author: string;
  created: string;
  text: string;
}

/** Where a write puts the story points: the custom field's id, or nowhere. */
export interface JiraPointsOptions {
  storyPointsField?: string | null;
}

/** What a transition did: the status it reached, or why it did not. */
export interface JiraTransition {
  movedTo: string | null;
  warning: string | null;
}

export interface JiraTransitionOptions {
  /**
   * With no way to `statusName`, take any transition into Jira's "done"
   * category instead (felipearos/ralph#449): a board whose workflow has no
   * "Movido" still gets its moved ticket closed. A ticket already done is
   * left where it is.
   */
  orDone?: boolean;
}

/** A ticket as the clerk files it. There is no assignee field: the clerk never assigns. */
export interface JiraNewIssue {
  project: string;
  type: string;
  summary: string;
  /** Plain text; turned into Atlassian Document Format on the way out (`toAdf`). */
  description: string;
  labels: string[];
  priority: string;
  /** Suggested story points; written only when a `storyPointsField` is given too. */
  storyPoints?: number | null;
  /**
   * File it with nobody assigned, explicitly: a project whose default
   * assignee is its lead otherwise hands every ticket to the lead. A project
   * that refuses an unassigned ticket gets its default instead.
   */
  unassigned?: boolean;
  /**
   * The key of the ticket it is filed under, such as the epic that collects
   * the team's intake work. A parent Jira refuses (closed, deleted, a type
   * that cannot hold this one) is dropped and the ticket filed without it.
   */
  parent?: string | null;
}

export interface JiraClient {
  /** Issues matching `jql`, at most `max`; with a `storyPointsField`, each one's points read from it. */
  search(jql: string, max: number, fields?: readonly string[], options?: JiraPointsOptions): Promise<JiraIssue[]>;
  /** The project, to prove the token can read it. */
  project(key: string): Promise<{ key: string; name: string }>;
  /** Every workflow status name the project's issue types use, each once (felipearos/ralph#447). */
  projectStatuses(key: string): Promise<string[]>;
  /** Every field the site has, custom ones included, as the field list names them. */
  fields(): Promise<{ id: string; name: string }[]>;
  /**
   * File a ticket: its key, and whether the story points landed in their
   * field. A field Jira refuses (not on the create screen, wrong type) costs
   * the points, never the ticket: it is filed again without them. A failure to
   * file at all still throws.
   */
  /** `parentWritten` only when a `parent` was asked for: false when Jira refused it. */
  createIssue(issue: JiraNewIssue, options?: JiraPointsOptions): Promise<{ key: string; pointsWritten: boolean; parentWritten?: boolean }>;
  /**
   * Add and remove labels and set the story points (null clears them), in one
   * edit. A refused points field is dropped and the labels sent alone, as
   * `createIssue` does. Nothing to change sends nothing.
   */
  updateFields(
    key: string,
    changes: { labels?: { add?: readonly string[]; remove?: readonly string[] }; storyPoints?: number | null },
    options?: JiraPointsOptions,
  ): Promise<{ pointsWritten: boolean }>;
  /**
   * Move a ticket to the status named `statusName` along its workflow, the
   * rule `tracker/jira.ts` `move` follows: a ticket already there is left, and
   * a workflow that offers no way there is a warning naming what it offers.
   * Never throws: a status move is never a reason to stop a poll.
   */
  transition(key: string, statusName: string, options?: JiraTransitionOptions): Promise<JiraTransition>;
  /** A ticket's status changes, oldest first, off its changelog; every other change is left out. */
  statusHistory(key: string): Promise<JiraStatusChange[]>;
  /** A ticket's comments, as plain text, oldest first. */
  comments(key: string): Promise<string[]>;
  addComment(key: string, body: string): Promise<void>;
  /**
   * A ticket's comments with who wrote each and when, oldest first: what a
   * code-context case shows its session (felipearos/ralph#499).
   */
  commentEntries(key: string): Promise<JiraComment[]>;
  /** Post a comment already in Atlassian Document Format: one whose marks (`code`, bold) plain text cannot carry. */
  addDocComment(key: string, doc: AdfNode): Promise<void>;
  /** Link `from` to `to`: "relates to", or "duplicates" for a likely duplicate. */
  link(from: string, to: string, kind?: LinkKind): Promise<void>;
  /** The files already on a ticket. */
  attachments(key: string): Promise<JiraAttachment[]>;
  /** Attach one file to a ticket, streamed from disk (`POST …/attachments`, multipart field `file`). */
  attach(key: string, file: JiraUpload): Promise<void>;
}

/**
 * The clerk's link types, by Jira Cloud's stock ids. Named, they break on a
 * site that renamed them (the client's are "Relacion" and "Duplicado"), and Jira
 * answers a 404 the clerk reads as the target gone: every link was dropped
 * without a word. A site renames a stock type; it never re-ids one.
 */
export const LINK_TYPES = { relates: "10003", duplicate: "10002" } as const;
export type LinkKind = keyof typeof LINK_TYPES;

/** The credential, split. Null when it is not `<email>:<token>`. */
export function parseJiraToken(raw: string | undefined): { email: string; token: string } | null {
  const value = raw?.trim() ?? "";
  const at = value.indexOf(":");
  if (at <= 0 || at === value.length - 1) return null;
  const email = value.slice(0, at);
  return email.includes("@") ? { email, token: value.slice(at + 1) } : null;
}

const FIELDS = [
  "summary",
  "issuetype",
  "status",
  "priority",
  "labels",
  "created",
  "resolutiondate",
  "statuscategorychangedate",
  "description",
  "comment",
  "assignee",
  "reporter",
  "resolution",
];

/** The most changelog pages `statusHistory` reads: a ticket with more history than this is not an intake ticket. */
const CHANGELOG_PAGES = 10;

/** Atlassian Document Format, flattened to its text: blocks on their own lines, inline nodes run together. */
export function adfText(node: unknown): string {
  if (node === null || typeof node !== "object") return typeof node === "string" ? node : "";
  const value = node as { type?: string; text?: string; content?: unknown[] };
  if (typeof value.text === "string") return value.text;
  const children = (value.content ?? []).map(adfText);
  return INLINE_PARENTS.has(value.type ?? "") ? children.join("") : children.join("\n");
}

/** The nodes whose children are inline text: everything else holds blocks. */
const INLINE_PARENTS = new Set(["paragraph", "heading", "listItem", "tableCell", "tableHeader"]);

export function jiraClient(site: string, credential: { email: string; token: string }, fetcher: Fetch = fetch): JiraClient {
  const base = `https://${site}`;
  const auth = `Basic ${Buffer.from(`${credential.email}:${credential.token}`).toString("base64")}`;

  const call = async (method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<unknown> => {
    let response: Response;
    // A multipart upload is sent as the form it is, with the header Jira
    // demands of one (its XSRF check), and the content type left to fetch,
    // which writes the boundary.
    const form = body instanceof FormData;
    try {
      response = await fetcher(`${base}${path}`, {
        method,
        headers: {
          authorization: auth,
          accept: "application/json",
          ...(body === undefined || form ? {} : { "content-type": "application/json" }),
          ...(form ? { "x-atlassian-token": "no-check" } : {}),
        },
        ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }),
        signal: AbortSignal.timeout(form ? UPLOAD_TIMEOUT_MS : CALL_TIMEOUT_MS),
      });
    } catch (error) {
      throw new JiraError({ kind: "transient", why: `Jira ${method} ${path} could not be reached: ${(error as Error).message}` });
    }
    if (response.status === 429) {
      const wait = retryAfterSeconds(response.headers.get("retry-after"));
      throw new JiraError({ kind: "rate-limited", why: `Jira is rate limiting the clerk for ${wait}s`, retryAfterSeconds: wait });
    }
    if (response.status >= 500 || response.status === 408) {
      throw new JiraError({ kind: "transient", why: `Jira ${method} ${path} answered HTTP ${response.status}` });
    }
    const text = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new JiraError({
        kind: "denied",
        code: "jira_unauthorized",
        why: `Jira refused the clerk's credential (HTTP 401)`,
        remedy: `store '<email>:<API token>' of a Jira account that can browse the project as ${JIRA_TOKEN_ENV}, and restart`,
      });
    }
    if (response.status === 403) {
      throw new JiraError({
        kind: "denied",
        code: "jira_forbidden",
        why: `Jira forbade ${method} ${path} (HTTP 403)`,
        remedy: `give the Jira account behind ${JIRA_TOKEN_ENV} permission to browse, create and comment in the project, and restart`,
      });
    }
    if (response.status === 404 || response.status === 400) {
      const fields = refusedFields(text);
      throw new JiraError({
        kind: "denied",
        code: response.status === 404 ? "jira_not_found" : "jira_bad_request",
        why: `Jira refused ${method} ${path} (HTTP ${response.status}): ${jiraMessage(text)}`,
        remedy: "check 'clerk.jira' in .ralph/config.json against the Jira project — its key, issue types, priorities and labels — and restart",
        ...(fields.length === 0 ? {} : { fields }),
      });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new JiraError({ kind: "transient", why: `Jira ${method} ${path} answered HTTP ${response.status}` });
    }
    if (text === "") return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new JiraError({ kind: "transient", why: `Jira ${method} ${path} answered a body that is not JSON` });
    }
  };

  /** Whether `error` is Jira's 400 naming `field` as one it refused. */
  const refused = (error: unknown, field: string): boolean => {
    const failure = error instanceof JiraError ? error.failure : null;
    return failure?.kind === "denied" && failure.code === "jira_bad_request" && (failure.fields ?? []).includes(field);
  };

  /**
   * `send` with the points field, and again without it when Jira's 400 names
   * that field: the points are a suggestion, and a board whose screen lacks
   * the field must still get its ticket.
   */
  const withPoints = async <T>(field: string | null, send: (includePoints: boolean) => Promise<T>): Promise<{ value: T; pointsWritten: boolean }> => {
    if (field === null) return { value: await send(false), pointsWritten: false };
    try {
      return { value: await send(true), pointsWritten: true };
    } catch (error) {
      if (!refused(error, field)) throw error;
      return { value: await send(false), pointsWritten: false };
    }
  };

  return {
    async search(jql, max, fields = FIELDS, options = {}) {
      const points = options.storyPointsField ?? null;
      const asked = points === null || fields.includes(points) ? fields : [...fields, points];
      // Paged by `nextPageToken`, as the search/jql endpoint pages: a canvas
      // that says "y N más" has to have counted every row, not the first 100.
      // Bounded by pages as well as rows, and an empty page or a token that
      // repeats ends it: a loop that runs all night must not spin on a server
      // that keeps saying "more" and sends nothing.
      const out: JiraIssue[] = [];
      let next: string | undefined;
      for (let page = 0; page <= Math.ceil(max / 100); page++) {
        const body = (await call("POST", "/rest/api/3/search/jql", {
          jql,
          fields: asked,
          maxResults: Math.max(1, Math.min(100, max - out.length)),
          ...(next === undefined ? {} : { nextPageToken: next }),
        })) as { issues?: { key: string; fields: Record<string, unknown> }[]; nextPageToken?: string; isLast?: boolean } | null;
        const issues = (body?.issues ?? []).map((raw) => issueOf(raw, points));
        out.push(...issues);
        const token = body?.isLast === false && typeof body.nextPageToken === "string" ? body.nextPageToken : undefined;
        if (token === undefined || token === next || issues.length === 0 || out.length >= max) break;
        next = token;
      }
      return out;
    },
    async project(key) {
      const body = (await call("GET", `/rest/api/3/project/${encodeURIComponent(key)}`)) as { key?: string; name?: string } | null;
      return { key: body?.key ?? key, name: body?.name ?? key };
    },
    async projectStatuses(key) {
      // One list per issue type, the same status often in several: the board
      // is checked against their union, because a ticket of any type may be
      // the one a status is asked of.
      const body = (await call("GET", `/rest/api/3/project/${encodeURIComponent(key)}/statuses`)) as { statuses?: { name?: unknown }[] }[] | null;
      const names = (Array.isArray(body) ? body : []).flatMap((type) => (type.statuses ?? []).map((status) => status.name));
      return [...new Set(names.filter((name): name is string => typeof name === "string"))];
    },
    async fields() {
      const body = (await call("GET", "/rest/api/3/field")) as { id?: unknown; name?: unknown }[] | null;
      return (Array.isArray(body) ? body : [])
        .filter((field): field is { id: string; name?: unknown } => typeof field.id === "string")
        .map((field) => ({ id: field.id, name: typeof field.name === "string" ? field.name : field.id }));
    },
    async createIssue(issue, options = {}) {
      const points = typeof issue.storyPoints === "number" ? (options.storyPointsField ?? null) : null;
      const fields = {
        project: { key: issue.project },
        issuetype: { name: issue.type },
        summary: issue.summary,
        description: toAdf(issue.description),
        labels: issue.labels,
        priority: { name: issue.priority },
        ...(issue.unassigned === true ? { assignee: null } : {}),
        ...(typeof issue.parent === "string" ? { parent: { key: issue.parent } } : {}),
      };
      let parentWritten = "parent" in fields;
      // Each optional field Jira's 400 names is dropped and the rest sent
      // again: a ticket filed without its assignee or parent beats none.
      const create = async (sent: Record<string, unknown>): Promise<{ key?: string } | null> => {
        try {
          return (await call("POST", "/rest/api/3/issue", { fields: sent })) as { key?: string } | null;
        } catch (error) {
          const field = ["assignee", "parent"].find((name) => name in sent && refused(error, name));
          if (field === undefined) throw error;
          if (field === "parent") parentWritten = false;
          const { [field]: _dropped, ...rest } = sent;
          return create(rest);
        }
      };
      const { value: body, pointsWritten } = await withPoints(points, (includePoints) =>
        create(includePoints && points !== null ? { ...fields, [points]: issue.storyPoints } : fields),
      );
      if (typeof body?.key !== "string") throw new JiraError({ kind: "transient", why: "Jira created an issue but did not say its key" });
      return { key: body.key, pointsWritten, ...("parent" in fields ? { parentWritten } : {}) };
    },
    async updateFields(key, changes, options = {}) {
      const labels = [...(changes.labels?.add ?? []).map((label) => ({ add: label })), ...(changes.labels?.remove ?? []).map((label) => ({ remove: label }))];
      const points = changes.storyPoints !== undefined ? (options.storyPointsField ?? null) : null;
      if (labels.length === 0 && points === null) return { pointsWritten: false };
      const path = `/rest/api/3/issue/${encodeURIComponent(key)}`;
      const { pointsWritten } = await withPoints(points, async (includePoints) => {
        if (!includePoints && labels.length === 0) return;
        await call("PUT", path, {
          ...(labels.length === 0 ? {} : { update: { labels } }),
          ...(includePoints && points !== null ? { fields: { [points]: changes.storyPoints } } : {}),
        });
      });
      return { pointsWritten };
    },
    async transition(key, statusName, options = {}) {
      const path = `/rest/api/3/issue/${encodeURIComponent(key)}`;
      try {
        const current = (await call("GET", `${path}?fields=status`)) as { fields?: { status?: { name?: string; statusCategory?: { key?: string } } } } | null;
        const status = current?.fields?.status?.name;
        if (status === statusName) return { movedTo: statusName, warning: null };
        const orDone = options.orDone === true;
        if (orDone && status !== undefined && current?.fields?.status?.statusCategory?.key === "done") return { movedTo: status, warning: null };
        const body = (await call("GET", `${path}/transitions`)) as {
          transitions?: { id: string; name: string; to?: { name?: string; statusCategory?: { key?: string } } }[];
        } | null;
        const transitions = body?.transitions ?? [];
        const named = transitions.find((candidate) => candidate.to?.name === statusName) ?? transitions.find((candidate) => candidate.name === statusName);
        const done = named === undefined && orDone ? transitions.find((candidate) => candidate.to?.statusCategory?.key === "done") : undefined;
        if (done !== undefined) {
          await call("POST", `${path}/transitions`, { transition: { id: done.id } });
          return { movedTo: done.to?.name ?? done.name, warning: null };
        }
        const chosen = named;
        if (chosen === undefined) {
          const offers = transitions.map((candidate) => candidate.to?.name ?? candidate.name);
          return {
            movedTo: null,
            warning: `${key} has no transition to '${statusName}' from '${status ?? "its status"}'${offers.length === 0 ? " (offers none)" : ` (offers: ${offers.join(", ")})`}`,
          };
        }
        await call("POST", `${path}/transitions`, { transition: { id: chosen.id } });
        return { movedTo: statusName, warning: null };
      } catch (error) {
        return { movedTo: null, warning: `moving ${key} to '${statusName}' failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
    async statusHistory(key) {
      // `expand=changelog` carries the whole changelog of a short-lived ticket,
      // newest first (read off example.atlassian.net, 2026-10-22). One whose
      // changelog is longer than the page is read again, whole, from the
      // changelog endpoint, which pages oldest first: mixing the two orders
      // would skip or repeat histories. Bounded, so a server that keeps saying
      // "more" cannot keep a poll here.
      const path = `/rest/api/3/issue/${encodeURIComponent(key)}`;
      const body = (await call("GET", `${path}?fields=status&expand=changelog`)) as { changelog?: JiraChangelogPage } | null;
      const first = body?.changelog?.histories ?? [];
      if ((body?.changelog?.total ?? first.length) <= first.length) return statusChanges(first);
      const histories: JiraHistory[] = [];
      for (let page = 0; page < CHANGELOG_PAGES; page++) {
        const more = (await call("GET", `${path}/changelog?startAt=${histories.length}&maxResults=100`)) as { values?: JiraHistory[]; isLast?: boolean } | null;
        const values = more?.values ?? [];
        histories.push(...values);
        if (values.length === 0 || more?.isLast !== false) break;
      }
      return statusChanges(histories);
    },
    async comments(key) {
      const body = (await call("GET", `/rest/api/3/issue/${encodeURIComponent(key)}/comment?maxResults=100&orderBy=-created`)) as { comments?: { body?: unknown }[] } | null;
      return (body?.comments ?? []).map((comment) => adfText(comment.body).trim());
    },
    async addComment(key, text) {
      await call("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: toAdf(text) });
    },
    async commentEntries(key) {
      const body = (await call("GET", `/rest/api/3/issue/${encodeURIComponent(key)}/comment?maxResults=100&orderBy=created`)) as {
        comments?: { body?: unknown; author?: { displayName?: unknown }; created?: unknown }[];
      } | null;
      return (body?.comments ?? []).map((comment) => ({
        author: typeof comment.author?.displayName === "string" ? comment.author.displayName : "",
        created: typeof comment.created === "string" ? comment.created : "",
        text: adfText(comment.body).trim(),
      }));
    },
    async addDocComment(key, doc) {
      await call("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: doc });
    },
    async link(from, to, kind = "relates") {
      // Jira gives the outward verb to the issue posted as `inwardIssue`, so
      // this reads "`from` duplicates `to`" (checked on the client's site: OAI-17
      // then shows "duplicado OAI-16").
      await call("POST", "/rest/api/3/issueLink", { type: { id: LINK_TYPES[kind] }, inwardIssue: { key: from }, outwardIssue: { key: to } });
    },
    async attachments(key) {
      const body = (await call("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?fields=attachment`)) as {
        fields?: { attachment?: { id?: unknown; filename?: unknown; size?: unknown }[] };
      } | null;
      return (body?.fields?.attachment ?? [])
        .filter((one) => typeof one.filename === "string")
        .map((one) => ({ id: String(one.id ?? ""), filename: one.filename as string, size: typeof one.size === "number" ? one.size : -1 }));
    },
    async attach(key, file) {
      // A file-backed blob: the upload reads the file as it sends it, so a
      // large video is never held in memory whole.
      const form = new FormData();
      form.append("file", await openAsBlob(file.path, file.type === undefined ? {} : { type: file.type }), file.name);
      await call("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/attachments`, form);
    },
  };
}

export type AdfNode = Record<string, unknown>;

/** A line's text, with every http(s) URL in it a link. */
function inline(line: string): AdfNode[] {
  const nodes: AdfNode[] = [];
  let at = 0;
  // A URL ends at whitespace, at Slack's `|` and `>`, and before trailing
  // punctuation a sentence put after it.
  for (const match of line.matchAll(/https?:\/\/[^\s|<>]*[^\s|<>.,;:!?)\]"']/g)) {
    if (match.index! > at) nodes.push({ type: "text", text: line.slice(at, match.index) });
    nodes.push({ type: "text", text: match[0], marks: [{ type: "link", attrs: { href: match[0] } }] });
    at = match.index! + match[0].length;
  }
  if (at < line.length) nodes.push({ type: "text", text: line.slice(at) });
  return nodes;
}

const paragraph = (lines: readonly string[]): AdfNode => ({
  type: "paragraph",
  content: lines.flatMap((line, index) => [...(index === 0 ? [] : [{ type: "hardBreak" }]), ...inline(line)]),
});

/**
 * Plain text as Atlassian Document Format, which is all Jira Cloud's v3 API
 * accepts for a description or a comment. Blocks are split on blank lines; a
 * block whose lines all start with `> ` is a quote, one whose lines all start
 * with `- ` a list, a lone `---` a divider, anything else a paragraph whose
 * lines are kept. URLs become links, so the Slack permalink and the
 * screenshots are one click away.
 */
export function toAdf(text: string): AdfNode {
  const content: AdfNode[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    if (lines.length === 0) continue;
    if (lines.length === 1 && lines[0]!.trim() === "---") {
      // A divider: it sets the clerk's internal marker apart from the report.
      content.push({ type: "rule" });
    } else if (lines.every((line) => line.startsWith(">"))) {
      content.push({ type: "blockquote", content: [paragraph(lines.map((line) => line.replace(/^>\s?/, "")))] });
    } else if (lines.every((line) => line.startsWith("- "))) {
      content.push({ type: "bulletList", content: lines.map((line) => ({ type: "listItem", content: [paragraph([line.slice(2)])] })) });
    } else if (lines.length > 1 && lines.slice(1).every((line) => line.startsWith("- "))) {
      // A heading line followed by a list: "Capturas:" and its links.
      content.push(paragraph([lines[0]!]));
      content.push({ type: "bulletList", content: lines.slice(1).map((line) => ({ type: "listItem", content: [paragraph([line.slice(2)])] })) });
    } else if (lines.length > 1 && lines.slice(1).every((line) => line.startsWith(">"))) {
      content.push(paragraph([lines[0]!]));
      content.push({ type: "blockquote", content: [paragraph(lines.slice(1).map((line) => line.replace(/^>\s?/, "")))] });
    } else {
      content.push(paragraph(lines));
    }
  }
  return { type: "doc", version: 1, content };
}

/** Jira's error body, as one line, for the reason a request was refused. */
function jiraMessage(text: string): string {
  try {
    const body = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> };
    const parts = [...(body.errorMessages ?? []), ...Object.entries(body.errors ?? {}).map(([field, why]) => `${field}: ${why}`)];
    if (parts.length > 0) return parts.join("; ");
  } catch {}
  return text.slice(0, 200) || "no detail";
}

/** One changelog entry, as Jira Cloud's REST v3 writes it. */
export interface JiraHistory {
  id?: string;
  author?: { accountId?: string; displayName?: string };
  created?: string;
  items?: { field?: string; fieldId?: string; fieldtype?: string; fromString?: string | null; toString?: string | null }[];
}

interface JiraChangelogPage {
  startAt?: number;
  maxResults?: number;
  total?: number;
  histories?: JiraHistory[];
}

/**
 * The status changes in a changelog, oldest first. Jira lists histories
 * newest first on some endpoints and oldest first on others, so they are
 * sorted by time rather than trusted in order. Two in the same millisecond
 * (a confirmation and the automation it fires) go by history id, which Jira
 * hands out in order; failing both, a history keeps its place. Items that
 * change any other field are left out.
 */
export function statusChanges(histories: readonly JiraHistory[]): JiraStatusChange[] {
  const changes: { change: JiraStatusChange; at: number; id: number; index: number }[] = [];
  histories.forEach((history, index) => {
    const author = history.author;
    const by = typeof author?.accountId === "string" ? { accountId: author.accountId, displayName: author.displayName ?? author.accountId } : null;
    for (const item of history.items ?? []) {
      if ((item.fieldId ?? item.field) !== "status") continue;
      const at = history.created ?? "";
      changes.push({ change: { from: item.fromString ?? "", to: item.toString ?? "", at, by }, at: Date.parse(at), id: Number(history.id), index });
    }
  });
  return changes
    .sort((a, b) => {
      if (!Number.isNaN(a.at) && !Number.isNaN(b.at) && a.at !== b.at) return a.at - b.at;
      if (Number.isFinite(a.id) && Number.isFinite(b.id) && a.id !== b.id) return a.id - b.id;
      return a.index - b.index;
    })
    .map(({ change }) => change);
}

/** The fields a 400's `errors` names: Jira keys each refusal by the field it refused. */
function refusedFields(text: string): string[] {
  try {
    const body = JSON.parse(text) as { errors?: Record<string, unknown> } | null;
    return Object.keys(body?.errors ?? {});
  } catch {
    return [];
  }
}

function issueOf(raw: { key: string; fields: Record<string, unknown> }, storyPointsField: string | null = null): JiraIssue {
  const fields = raw.fields ?? {};
  const named = (value: unknown): string => (value !== null && typeof value === "object" && typeof (value as { name?: unknown }).name === "string" ? (value as { name: string }).name : "");
  const status = fields.status as { name?: string; statusCategory?: { key?: string } } | undefined;
  const comment = fields.comment as { total?: number; comments?: unknown[] } | undefined;
  return {
    key: raw.key,
    summary: typeof fields.summary === "string" ? fields.summary : "",
    type: named(fields.issuetype),
    status: status?.name ?? "",
    statusCategory: status?.statusCategory?.key ?? "",
    priority: named(fields.priority) || null,
    labels: Array.isArray(fields.labels) ? fields.labels.filter((label): label is string => typeof label === "string") : [],
    created: typeof fields.created === "string" ? fields.created : "",
    resolved: typeof fields.resolutiondate === "string" ? fields.resolutiondate : null,
    doneAt: typeof fields.statuscategorychangedate === "string" && status?.statusCategory?.key === "done" ? fields.statuscategorychangedate : null,
    description: adfText(fields.description).trim(),
    comments: typeof comment?.total === "number" ? comment.total : Array.isArray(comment?.comments) ? comment.comments.length : 0,
    commentTexts: Array.isArray(comment?.comments) ? comment.comments.map((one) => adfText((one as { body?: unknown }).body).trim()) : [],
    storyPoints: storyPointsField !== null && typeof fields[storyPointsField] === "number" ? (fields[storyPointsField] as number) : null,
    assignee: userOf(fields.assignee),
    reporter: userOf(fields.reporter),
    resolution: named(fields.resolution) || null,
  };
}

/** An account off an issue field; null for an unassigned ticket or one Jira does not name. */
function userOf(value: unknown): JiraUser | null {
  if (value === null || typeof value !== "object") return null;
  const user = value as { accountId?: unknown; displayName?: unknown };
  if (typeof user.accountId !== "string") return null;
  return { accountId: user.accountId, displayName: typeof user.displayName === "string" ? user.displayName : user.accountId };
}

/** A JQL string literal: quoted, with the characters JQL treats specially escaped. */
export const jqlString = (value: string): string => `"${value.replace(/[\\"]/g, "\\$&")}"`;

/**
 * `--check-token`: the credential reads the configured project. Run by the
 * supervisor before handing it to the gate, from the project's worktree, which
 * is where the site and project key come from.
 */
export async function checkToken(env: NodeJS.ProcessEnv, root: string, fetcher: Fetch = fetch): Promise<{ code: number; message: string }> {
  const credential = parseJiraToken(env.RALPH_CLERK_JIRA_TOKEN);
  if (credential === null) {
    return {
      code: 1,
      message: `clerk-jira: ${env[JIRA_TOKEN_ENV]?.trim() ? `${JIRA_TOKEN_ENV} is not '<email>:<API token>'` : `no ${JIRA_TOKEN_ENV} in the environment`}`,
    };
  }
  let target: { site: string; project: string } | null;
  try {
    // The clerk's block wins: a project running both reads one Jira. A
    // triager-only project (#397) holds the same credential for its person path.
    const config = loadProjectConfig(root);
    target = clerkRules(config)?.jira ?? triageRules(config).jira;
  } catch (error) {
    return { code: 1, message: `clerk-jira: the project's config could not be read: ${(error as Error).message.split("\n")[0]}` };
  }
  if (target === null) return { code: 1, message: "clerk-jira: the project's .ralph/config.json has no 'clerk' block and no 'triage.jira'" };
  try {
    const project = await jiraClient(target.site, credential, fetcher).project(target.project);
    return { code: 0, message: `clerk-jira: Jira credential ok, reads ${project.key} (${project.name}) on ${target.site}` };
  } catch (error) {
    if (error instanceof JiraError) {
      const { failure } = error;
      if (failure.kind === "denied") return { code: 1, message: `clerk-jira: ${failure.why}; ${failure.remedy}` };
      return { code: 2, message: `clerk-jira: ${failure.why}` };
    }
    return { code: 2, message: `clerk-jira: ${(error as Error).message}` };
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.length !== 1 || argv[0] !== "--check-token") {
    console.error("usage: bun clerk/jira.ts --check-token");
    process.exitCode = 64;
  } else {
    const { code, message } = await checkToken(process.env, projectRoot());
    (code === 0 ? console.log : console.error)(message);
    process.exitCode = code;
  }
}
