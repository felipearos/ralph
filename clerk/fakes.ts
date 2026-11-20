/**
 * Fakes for the clerk's tests: a Slack that answers at the HTTP seam, so the
 * real client's parsing, paging and failure classification run against it, and
 * nothing ever reaches the network.
 *
 * Test support only — nothing in the harness imports it.
 */
import { FILES_SCOPE, SLACK_API, compareTs, type Fetch, type SlackFile, type SlackMessage } from "./slack";
import { KPI_SCOPES, REQUIRED_SCOPES } from "./slack";
import type { AppLabels } from "../triage/intake";

export const BOT = { userId: "U0CLERKBOT", botId: "B0CLERKBOT" } as const;
export const WORKSPACE = "https://example.slack.com/";

/** One recorded call: the method and its parameters (a POST's top-level string fields), and a POST's JSON body. */
export interface SlackCall {
  method: string;
  params: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface FakeSlack {
  fetch: Fetch;
  calls: SlackCall[];
  /** Post a top-level message (or a reply, with `thread_ts`) as a user. */
  post(message: SlackMessage): void;
  /** Answer the next call to `method` (or every call, with `always`) with this failure. */
  fail(method: string, failure: FakeFailure, options?: { always?: boolean }): void;
  scopes: string[];
  /** Every canvas the bot can write, by id, with the markdown last written to it ("" until then). */
  canvases: Map<string, string>;
  /** The canvases the bot has created, in order. */
  created: string[];
  /** Make a canvas gone: deleted, or no longer reachable by the bot. Its next edit answers `code`. */
  canvasGone(canvas: string, code?: string): void;
  /** The channel's members, as `conversations.members` answers them; mutable, so a test can have someone join or leave. */
  members: string[];
  /** Every DM the bot posted, by the user its DM is with. */
  dms: { user: string; text: string }[];
  /** Other channels the bot is a member of; mutable, so a test can invite it. Any other channel answers `channel_not_found`. */
  joined: string[];
  /** Every top-level message the bot posted in a `joined` channel. */
  channelPosts: { channel: string; text: string }[];
  /**
   * Host a file, as Slack hosts what a reporter uploads, and return it as a
   * message's `files` entry carries it. The bot downloads it from its
   * `url_private_download`, recorded as a `files.download` call (and failed
   * with `fail("files.download", …)`); without `files:read` in `scopes` the
   * download answers Slack's sign-in page, as Slack does.
   */
  file(id: string, file: { name: string; content: string; mimetype?: string; size?: number }): SlackFile;
}

/** Where the fake Slack serves its hosted files. */
export const SLACK_FILES = "https://files.slack.com/files-pri";

export type FakeFailure =
  | { status: 429; retryAfter?: string }
  | { status: 500 | 502 | 503 }
  | { error: string; needed?: string }
  | { network: string };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * `canvases` are the canvases that exist before the test starts: the bot can
 * edit those and the ones it creates, and nothing else — an edit of any other
 * id answers `canvas_not_found`, so a write to a canvas nobody configured is
 * caught rather than silently accepted.
 */
export function fakeSlack(
  channel: string,
  options: { scopes?: string[]; users?: Record<string, string>; canvases?: string[]; channelCanvas?: string; members?: string[]; bots?: string[]; joined?: string[] } = {},
): FakeSlack {
  const messages: SlackMessage[] = [];
  const calls: SlackCall[] = [];
  const failures: { method: string; failure: FakeFailure; always: boolean }[] = [];
  const canvases = new Map((options.canvases ?? []).map((id) => [id, ""]));
  const gone = new Map<string, string>();
  const created: string[] = [];
  /** The channel's own canvas, once one is created: a channel has at most one. */
  const channelCanvas: string[] = options.channelCanvas === undefined ? [] : [options.channelCanvas];
  /** DM channel id to the user it is with, as `conversations.open` made them. */
  const dmChannels = new Map<string, string>();
  const bots = new Set([BOT.userId, ...(options.bots ?? [])]);
  const hosted = new Map<string, { name: string; content: string; mimetype: string }>();
  const self: FakeSlack = {
    file(id, file) {
      const mimetype = file.mimetype ?? "image/png";
      hosted.set(id, { name: file.name, content: file.content, mimetype });
      return {
        id,
        name: file.name,
        mimetype,
        mode: "hosted",
        size: file.size ?? new TextEncoder().encode(file.content).byteLength,
        url_private_download: `${SLACK_FILES}/T0EXAMPLE-${id}/download/${encodeURIComponent(file.name)}`,
        permalink: `${WORKSPACE}files/U0REPORTER/${id}/${encodeURIComponent(file.name)}`,
      };
    },
    calls,
    canvases,
    created,
    members: [...(options.members ?? [])],
    dms: [],
    joined: [...(options.joined ?? [])],
    channelPosts: [],
    canvasGone(canvas, code = "canvas_not_found") {
      canvases.delete(canvas);
      gone.set(canvas, code);
    },
    scopes: options.scopes ?? [...new Set([...REQUIRED_SCOPES, ...KPI_SCOPES, FILES_SCOPE])],
    post(message) {
      messages.push({ ...message });
      if (message.thread_ts !== undefined && message.thread_ts !== message.ts) {
        const parent = messages.find((candidate) => candidate.ts === message.thread_ts);
        if (parent !== undefined) {
          parent.reply_count = (parent.reply_count ?? 0) + 1;
          parent.thread_ts = parent.ts;
          if (parent.latest_reply === undefined || compareTs(message.ts, parent.latest_reply) > 0) parent.latest_reply = message.ts;
        }
      }
    },
    fail(method, failure, { always = false } = {}) {
      failures.push({ method, failure, always });
    },
    fetch: async (url, init) => {
      const parsed = new URL(url);
      if (url.startsWith(`${SLACK_FILES}/`)) {
        const id = /^\/files-pri\/T0EXAMPLE-([^/]+)\//.exec(parsed.pathname)?.[1] ?? "";
        calls.push({ method: "files.download", params: { file: id } });
        const at = failures.findIndex((entry) => entry.method === "files.download");
        if (at !== -1) {
          const { failure, always } = failures[at]!;
          if (!always) failures.splice(at, 1);
          if ("network" in failure) throw new TypeError(failure.network);
          if ("status" in failure) return new Response("error", { status: failure.status, headers: "retryAfter" in failure && failure.retryAfter !== undefined ? { "retry-after": failure.retryAfter } : {} });
          return new Response("<html>sign in</html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
        }
        const authorized = (new Headers(init.headers).get("authorization") ?? "").startsWith("Bearer xox");
        const file = hosted.get(id);
        // As Slack does: a token without the scope, or none, gets the sign-in page.
        if (!authorized || !self.scopes.includes(FILES_SCOPE) || file === undefined) {
          return new Response("<html>sign in to Slack</html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
        }
        const bytes = new TextEncoder().encode(file.content);
        return new Response(bytes, { status: 200, headers: { "content-type": file.mimetype, "content-length": String(bytes.byteLength) } });
      }
      const method = parsed.pathname.replace(/^\/api\//, "");
      if (!url.startsWith(SLACK_API)) throw new Error(`the fake Slack was asked for ${url}`);
      const post = (init.method ?? "GET").toUpperCase() === "POST";
      const body = post && typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      const params =
        body === undefined
          ? Object.fromEntries(parsed.searchParams.entries())
          : Object.fromEntries(Object.entries(body).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      calls.push({ method, params, ...(body === undefined ? {} : { body }) });
      const at = failures.findIndex((entry) => entry.method === method);
      if (at !== -1) {
        const { failure, always } = failures[at]!;
        if (!always) failures.splice(at, 1);
        if ("network" in failure) throw new TypeError(failure.network);
        if ("status" in failure) {
          return json({ ok: false }, failure.status, "retryAfter" in failure && failure.retryAfter !== undefined ? { "retry-after": failure.retryAfter } : {});
        }
        return json({ ok: false, error: failure.error, ...(failure.needed === undefined ? {} : { needed: failure.needed }) });
      }
      if (method === "auth.test") {
        return json(
          { ok: true, url: WORKSPACE, team: "Example", user: "clerk", team_id: "T0EXAMPLE", user_id: BOT.userId, bot_id: BOT.botId },
          200,
          { "x-oauth-scopes": self.scopes.join(",") },
        );
      }
      if (method === "users.info" && bots.has(params.user ?? "")) {
        return json({ ok: true, user: { id: params.user, name: "bot", is_bot: true, profile: { display_name: "bot" } } });
      }
      if (method === "users.info") {
        const name = options.users?.[params.user ?? ""];
        return name === undefined ? json({ ok: false, error: "user_not_found" }) : json({ ok: true, user: { id: params.user, name: name.toLowerCase(), profile: { display_name: name } } });
      }
      const markdownOf = (value: unknown): string | null => {
        const content = value as { type?: string; markdown?: unknown } | undefined;
        return content?.type === "markdown" && typeof content.markdown === "string" ? content.markdown : null;
      };
      if (method === "canvases.edit") {
        const id = params.canvas_id ?? "";
        const changes = body?.changes as { operation?: string; section_id?: string; document_content?: unknown }[] | undefined;
        const change = changes?.length === 1 ? changes[0] : undefined;
        const markdown = change?.operation === "replace" && change.section_id === undefined ? markdownOf(change.document_content) : null;
        if (markdown === null) return json({ ok: false, error: "invalid_arguments" });
        if (!canvases.has(id)) return json({ ok: false, error: gone.get(id) ?? "canvas_not_found" });
        canvases.set(id, markdown);
        return json({ ok: true });
      }
      if (method === "conversations.info" && self.joined.includes(params.channel ?? "")) {
        return json({ ok: true, channel: { id: params.channel, is_member: true, properties: {} } });
      }
      if (method === "conversations.info") {
        if (params.channel !== channel) return json({ ok: false, error: "channel_not_found" });
        const own = channelCanvas[0];
        return json({ ok: true, channel: { id: channel, properties: own === undefined ? {} : { canvas: { file_id: own } } } });
      }
      if (method === "conversations.canvases.create") {
        // A channel has at most one canvas of its own.
        const markdown = markdownOf(body?.document_content);
        if (markdown === null) return json({ ok: false, error: "invalid_arguments" });
        if (params.channel_id !== channel) return json({ ok: false, error: "channel_not_found" });
        if (channelCanvas.length > 0) return json({ ok: false, error: "channel_canvas_already_exists" });
        const id = `F0CHANNEL${String(channelCanvas.length + 1).padStart(3, "0")}`;
        channelCanvas.push(id);
        canvases.set(id, markdown);
        return json({ ok: true, canvas_id: id });
      }
      if (method === "canvases.create") {
        const markdown = markdownOf(body?.document_content);
        if (markdown === null || typeof params.title !== "string") return json({ ok: false, error: "invalid_arguments" });
        const id = `F0CREATED${String(created.length + 1).padStart(3, "0")}`;
        created.push(id);
        canvases.set(id, markdown);
        return json({ ok: true, canvas_id: id });
      }
      if (method === "canvases.access.set") {
        const id = params.canvas_id ?? "";
        if (!canvases.has(id)) return json({ ok: false, error: "canvas_not_found" });
        return json({ ok: true });
      }
      if (method === "conversations.open") {
        const user = params.users ?? "";
        if (!/^[UW][A-Z0-9]+$/.test(user)) return json({ ok: false, error: "user_not_found" });
        const id = `D0${user.slice(1)}`;
        dmChannels.set(id, user);
        return json({ ok: true, channel: { id } });
      }
      if (method === "chat.postMessage" && dmChannels.has(params.channel ?? "")) {
        self.dms.push({ user: dmChannels.get(params.channel!)!, text: params.text ?? "" });
        return json({ ok: true, channel: params.channel, ts: `${1_800_000_000 + self.dms.length}.000100` });
      }
      if (method === "chat.postMessage" && self.joined.includes(params.channel ?? "") && params.thread_ts === undefined) {
        self.channelPosts.push({ channel: params.channel!, text: params.text ?? "" });
        return json({ ok: true, channel: params.channel, ts: `${1_800_100_000 + self.channelPosts.length}.000100` });
      }
      if (params.channel !== undefined && params.channel !== channel) return json({ ok: false, error: "channel_not_found" });
      if (method === "conversations.members") return json({ ok: true, members: [...self.members], response_metadata: { next_cursor: "" } });
      if (method === "chat.postMessage") {
        // The clerk's own reply, as Slack would then serve it back: a message
        // by the bot, in the thread it was posted to.
        // On the fake's own clock: one second after the newest message, so a
        // test's later posts stay later than the clerk's reply.
        const newest = messages.reduce((latest, message) => (compareTs(message.ts, latest) > 0 ? message.ts : latest), "0.000000");
        const ts = `${Number(newest.split(".")[0]) + 1}.${String(messages.length).padStart(6, "0")}`;
        self.post({ ts, user: BOT.userId, bot_id: BOT.botId, text: params.text ?? "", ...(params.thread_ts === undefined ? {} : { thread_ts: params.thread_ts }) });
        return json({ ok: true, channel, ts });
      }
      if (method === "conversations.history") {
        const oldest = params.oldest ?? "0";
        const top = messages
          .filter((message) => message.thread_ts === undefined || message.thread_ts === message.ts)
          .filter((message) => compareTs(message.ts, oldest) > 0)
          .sort((a, b) => compareTs(b.ts, a.ts));
        // Paged as Slack pages it: newest first, `limit` a page, the next
        // page behind an opaque cursor — so a client that took the pages'
        // order for the channel's would read a backlog out of order.
        const limit = Math.max(1, Number(params.limit ?? "100"));
        const start = params.cursor === undefined ? 0 : Number(params.cursor.replace(/^page:/, ""));
        const page = top.slice(start, start + limit);
        const more = start + limit < top.length;
        return json({ ok: true, messages: page, has_more: more, response_metadata: { next_cursor: more ? `page:${start + limit}` : "" } });
      }
      if (method === "conversations.replies") {
        const thread = messages
          .filter((message) => message.ts === params.ts || message.thread_ts === params.ts)
          .sort((a, b) => compareTs(a.ts, b.ts));
        return json({ ok: true, messages: thread, has_more: false });
      }
      return json({ ok: false, error: "unknown_method" });
    },
  };
  return self;
}

/** A Slack ts `minutes` after `base` (a ts), as the fake clock writes them. */
export const after = (base: string, minutes: number): string => {
  const [seconds = "0"] = base.split(".");
  return `${Number(seconds) + Math.round(minutes * 60)}.000100`;
};

/* --------------------------------------------------------------------------
 * Jira.
 * ----------------------------------------------------------------------- */

export const SITE = "example.atlassian.net";

/** An issue in the fake Jira, in the shape the clerk reads. */
/** How many comments the fake search returns per issue, as the real one caps them. */
export const SEARCH_COMMENTS = 20;

export interface FakeIssue {
  key: string;
  summary: string;
  type?: string;
  status?: string;
  /** `new`, `indeterminate` or `done`. */
  statusCategory?: string;
  priority?: string;
  labels?: string[];
  created?: string;
  resolved?: string | null;
  /** When it moved to the done category; for a workflow that closes without a resolution. */
  doneAt?: string | null;
  description?: string;
  comments?: string[];
  /** Index-aligned `created` times for `comments`; a comment past its end takes the ticket's creation. */
  commentTimes?: string[];
  /** Custom field values by id (`customfield_10016` for the story points), as the create or an edit set them. */
  custom?: Record<string, unknown>;
  assignee?: { accountId: string; displayName: string } | null;
  /** The key it was filed under, as the create set it. */
  parent?: string;
  reporter?: { accountId: string; displayName: string } | null;
  resolution?: string | null;
  /** Its status changes, oldest first: seeded by a test, appended by every transition. */
  history?: FakeStatusChange[];
  /** The files attached to it, with what was uploaded. */
  attachments?: FakeAttachment[];
}

/** One file on a fake issue. */
export interface FakeAttachment {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  content: string;
}

/** One status change the fake's changelog serves, in the clerk's shape; `by` null for a change no account made. */
export interface FakeStatusChange {
  from: string;
  to: string;
  at: string;
  by: { accountId: string; displayName: string } | null;
}

/** A project's workflow: its statuses (the first is where a new ticket starts) and the moves it allows. */
export interface FakeWorkflow {
  statuses: { name: string; category: "new" | "indeterminate" | "done" }[];
  /** From a status, the statuses a transition leads to; a status it leaves out leads to every other. */
  transitions?: Record<string, string[]>;
}

/** What `fakeJira` serves when a test names no workflow: the OA board's, as the clerk's tests have always seen it. */
export const FAKE_WORKFLOW: FakeWorkflow = {
  statuses: [
    { name: "Por hacer", category: "new" },
    { name: "En curso", category: "indeterminate" },
    { name: "Listo", category: "done" },
  ],
};

/** The intake board's workflow (felipearos/ralph#443), under `CLERK_JIRA_DEFAULTS`' status names. */
export const INTAKE_WORKFLOW: FakeWorkflow = {
  statuses: [
    { name: "Por confirmar", category: "new" },
    { name: "Confirmado", category: "indeterminate" },
    { name: "En curso", category: "indeterminate" },
    { name: "Descartado", category: "done" },
    { name: "Movido", category: "done" },
    { name: "Listo", category: "done" },
  ],
  transitions: {
    "Por confirmar": ["Confirmado", "Descartado"],
    Confirmado: ["En curso", "Movido", "Descartado"],
    "En curso": ["Listo"],
  },
};

export interface FakeJiraOptions {
  /** Every project the token can read and file in, besides the first argument. */
  projects?: string[];
  /** A project's workflow; one not named here gets `FAKE_WORKFLOW`. */
  workflows?: Record<string, FakeWorkflow>;
  /** The site's field list; `FAKE_FIELDS` when not named. */
  fields?: { id: string; name: string }[];
}

/** The fields `fakeJira` lists when a test names none: a story points field among the stock ones. */
export const FAKE_FIELDS: { id: string; name: string }[] = [
  { id: "summary", name: "Summary" },
  { id: "labels", name: "Labels" },
  { id: "customfield_10016", name: "Story point estimate" },
];

export interface JiraCall {
  method: string;
  path: string;
  body: unknown;
}

export interface FakeJira {
  fetch: Fetch;
  calls: JiraCall[];
  issues: FakeIssue[];
  add(issue: FakeIssue): void;
  /** Answer the next call whose path starts with `path` (and, when given, whose method is `method`) with this status, or a network error. */
  fail(path: string, failure: { status: number; retryAfter?: string } | { network: string }, options?: { always?: boolean; method?: string }): void;
  /** Every call that would change Jira. */
  writes(): JiraCall[];
  /** Who the next transitions are made by, as the changelog records them; null for no account. */
  actor: { accountId: string; displayName: string } | null;
  /** Refuse `field` on every create and edit from now on, as Jira refuses a field missing from the screen: HTTP 400 naming it. */
  refuseField(field: string): void;
}

const adf = (text: string): unknown => ({ type: "doc", version: 1, content: text.split("\n").map((line) => ({ type: "paragraph", content: line === "" ? [] : [{ type: "text", text: line }] })) });

/**
 * A Jira that understands the handful of JQL clauses the clerk writes —
 * `project =`, `labels =`, `statusCategory != Done`, `description ~`,
 * `text ~` — and
 * nothing else, so a query the clerk did not mean to
 * send matches nothing rather than everything.
 */
export function fakeJira(project = "OA", options: FakeJiraOptions = {}): FakeJira {
  const projects = [project, ...(options.projects ?? [])];
  const workflowOf = (key: string): FakeWorkflow => options.workflows?.[key.replace(/-\d+$/, "")] ?? FAKE_WORKFLOW;
  const refused = new Set<string>();
  const calls: JiraCall[] = [];
  const failures: { path: string; method?: string; failure: { status: number; retryAfter?: string } | { network: string }; always: boolean }[] = [];
  const issues: FakeIssue[] = [];
  let next = 100;
  const matches = (issue: FakeIssue, query: string): boolean => {
    const clauses: ((value: FakeIssue) => boolean)[] = [];
    const quotedIn = (list: string): string[] => [...list.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]!.replace(/\\(.)/g, "$1"));
    // The outcome scan's ready read (`closedKeysJql` with ready statuses): closed, or at one of them.
    const doneOrReady = /\(statusCategory = Done OR status in \(([^)]*)\)\)/.exec(query);
    if (doneOrReady) {
      const ready = quotedIn(doneOrReady[1]!);
      clauses.push((value) => (value.statusCategory ?? "new") === "done" || ready.includes(value.status ?? workflowOf(value.key).statuses[0]!.name));
    }
    const jql = doneOrReady ? query.replace(doneOrReady[0], "") : query;
    const projectMatch = /project = "([^"]+)"/.exec(jql);
    if (projectMatch) clauses.push((value) => value.key.startsWith(`${projectMatch[1]}-`));
    for (const label of jql.matchAll(/labels = "([^"]+)"/g)) clauses.push((value) => (value.labels ?? []).includes(label[1]!));
    // The confirmation sweep's clauses (felipearos/ralph#449): a status among
    // a list, and none of a list of labels.
    const quoted = (list: string): string[] => [...list.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]!.replace(/\\(.)/g, "$1"));
    const statusIn = /status in \(([^)]*)\)/.exec(jql);
    if (statusIn) {
      const wanted = quoted(statusIn[1]!);
      clauses.push((value) => wanted.includes(value.status ?? workflowOf(value.key).statuses[0]!.name));
    }
    const statusNotIn = /status not in \(([^)]*)\)/.exec(jql);
    if (statusNotIn) {
      const unwanted = quoted(statusNotIn[1]!);
      clauses.push((value) => !unwanted.includes(value.status ?? workflowOf(value.key).statuses[0]!.name));
    }
    // The outcome scan's (felipearos/ralph#450): the moved OA tickets by key.
    const keyIn = /key in \(([^)]*)\)/.exec(jql);
    if (keyIn) {
      const wanted = quoted(keyIn[1]!);
      clauses.push((value) => wanted.includes(value.key));
    }
    const labelsNotIn = /labels not in \(([^)]*)\)/.exec(jql);
    if (labelsNotIn) {
      const unwanted = quoted(labelsNotIn[1]!);
      clauses.push((value) => !(value.labels ?? []).some((label) => unwanted.includes(label)));
    }
    if (/statusCategory = Done/.test(jql)) clauses.push((value) => (value.statusCategory ?? "new") === "done");
    const updatedSince = /AND updated >= -(\d+)d/.exec(jql);
    if (updatedSince) {
      // A ticket's last change: its resolution if it has one, else its creation.
      clauses.push((value) => Date.parse(value.resolved ?? value.created ?? "2026-10-01T10:00:00.000-0300") >= Date.now() - Number(updatedSince[1]) * 86_400_000);
    }
    const resolvedSince = /AND resolved >= -(\d+)d/.exec(jql);
    if (resolvedSince) {
      clauses.push((value) => value.resolved !== null && value.resolved !== undefined && Date.parse(value.resolved) >= Date.now() - Number(resolvedSince[1]) * 86_400_000);
    }
    if (/statusCategory != Done ORDER|statusCategory != Done$/.test(jql)) {
      clauses.push((value) => (value.statusCategory ?? "new") !== "done");
    }
    const since = /created >= -(\d+)d/.exec(jql);
    if (since) clauses.push((value) => Date.parse(value.created ?? "2026-10-01T10:00:00.000-0300") >= Date.now() - Number(since[1]) * 86_400_000);
    for (const phrase of jql.matchAll(/description ~ "((?:[^"\\]|\\.)+)"/g)) {
      const wanted = phrase[1]!.replace(/\\(.)/g, "$1").replace(/^"|"$/g, "");
      clauses.push((value) => (value.description ?? "").includes(wanted));
    }
    // Jira's text search, as the clerk uses it: one word, found in the
    // summary, the description or a comment.
    for (const word of jql.matchAll(/text ~ "((?:[^"\\]|\\.)+)"/g)) {
      const wanted = word[1]!.replace(/\\(.)/g, "$1").toLowerCase();
      clauses.push((value) => [value.summary, value.description ?? "", ...(value.comments ?? [])].some((text) => text.toLowerCase().includes(wanted)));
    }
    return clauses.every((clause) => clause(issue));
  };
  const view = (issue: FakeIssue) => ({
    key: issue.key,
    fields: {
      summary: issue.summary,
      issuetype: { name: issue.type ?? "Error" },
      status: { name: issue.status ?? "Por hacer", statusCategory: { key: issue.statusCategory ?? "new" } },
      priority: issue.priority === undefined ? null : { name: issue.priority },
      labels: issue.labels ?? [],
      created: issue.created ?? "2026-10-01T10:00:00.000-0300",
      resolutiondate: issue.resolved ?? null,
      statuscategorychangedate: issue.doneAt ?? null,
      description: adf(issue.description ?? ""),
      // As the real search does: the first comments only, the total in full.
      comment: { total: (issue.comments ?? []).length, comments: (issue.comments ?? []).slice(0, SEARCH_COMMENTS).map((text) => ({ body: adf(text) })) },
      assignee: issue.assignee ?? null,
      reporter: issue.reporter ?? null,
      resolution: issue.resolution === undefined || issue.resolution === null ? null : { name: issue.resolution },
      ...issue.custom,
    },
  });
  /** A status change in the changelog's own shape: one history, one item. */
  const historyOf = (change: FakeStatusChange, index: number) => ({
    id: String(10_000 + index),
    ...(change.by === null ? {} : { author: { accountId: change.by.accountId, displayName: change.by.displayName, active: true } }),
    created: change.at,
    items: [{ field: "status", fieldtype: "jira", fieldId: "status", from: "1", fromString: change.from, to: "2", toString: change.to }],
  });
  const refusal = (fields: Record<string, unknown>): Response | null => {
    const names = Object.keys(fields).filter((field) => refused.has(field));
    if (names.length === 0) return null;
    return json(
      { errorMessages: [], errors: Object.fromEntries(names.map((field) => [field, `Field '${field}' cannot be set. It is not on the appropriate screen, or unknown.`])) },
      400,
    );
  };
  const customOf = (fields: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(fields).filter(([field]) => /^customfield_\d+$/.test(field)));
  const offered = (issue: FakeIssue): FakeWorkflow["statuses"] => {
    const workflow = workflowOf(issue.key);
    const from = issue.status ?? workflow.statuses[0]!.name;
    const targets = workflow.transitions?.[from] ?? workflow.statuses.map((status) => status.name).filter((name) => name !== from);
    return targets.map((name) => workflow.statuses.find((status) => status.name === name) ?? { name, category: "indeterminate" as const });
  };
  const self: FakeJira = {
    calls,
    issues,
    add(issue) {
      issues.push({ comments: [], labels: [], ...issue });
    },
    fail(path, failure, { always = false, method } = {}) {
      failures.push({ path, failure, always, ...(method === undefined ? {} : { method }) });
    },
    writes: () => calls.filter((call) => (call.method === "POST" || call.method === "PUT") && call.path !== "/rest/api/3/search/jql"),
    actor: { accountId: "557058:fake-confirmer", displayName: "Confirmadora de Prueba" },
    refuseField(field) {
      refused.add(field);
    },
    fetch: async (url, init) => {
      const parsed = new URL(url);
      if (parsed.host !== SITE) throw new Error(`the fake Jira was asked for ${url}`);
      const path = parsed.pathname;
      const method = (init.method ?? "GET").toUpperCase();
      const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : null;
      calls.push({ method, path, body });
      const at = failures.findIndex((entry) => path.startsWith(entry.path) && (entry.method === undefined || entry.method === method));
      if (at !== -1) {
        const { failure, always } = failures[at]!;
        if (!always) failures.splice(at, 1);
        if ("network" in failure) throw new TypeError(failure.network);
        return json({ errorMessages: [`fake ${failure.status}`] }, failure.status, failure.retryAfter === undefined ? {} : { "retry-after": failure.retryAfter });
      }
      const known = /^\/rest\/api\/3\/project\/([^/]+)$/.exec(path);
      if (method === "GET" && known && projects.includes(known[1]!)) return json({ key: known[1], name: known[1] === project ? "Acme" : `Acme ${known[1]}` });
      const statuses = /^\/rest\/api\/3\/project\/([^/]+)\/statuses$/.exec(path);
      if (method === "GET" && statuses && projects.includes(statuses[1]!)) {
        const names = workflowOf(`${statuses[1]}-0`).statuses.map((status) => ({ name: status.name, statusCategory: { key: status.category } }));
        return json([{ name: "Error", statuses: names }, { name: "Tarea", statuses: names }]);
      }
      if (method === "GET" && path === "/rest/api/3/field") return json(options.fields ?? FAKE_FIELDS);
      if (method === "GET" && path.startsWith("/rest/api/3/project/")) return json({ errorMessages: ["No project could be found"] }, 404);
      if (method === "POST" && path === "/rest/api/3/search/jql") {
        const { jql, maxResults } = body as { jql: string; maxResults: number };
        // Paged by token, as the search/jql endpoint pages.
        const { nextPageToken } = body as { nextPageToken?: string };
        // As Jira does: a `key in (...)` naming a key it does not have refuses the whole query.
        const keyIn = /key in \(([^)]*)\)/.exec(jql);
        const missing = keyIn ? [...keyIn[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!).find((key) => !issues.some((issue) => issue.key === key)) : undefined;
        if (missing !== undefined) return json({ errorMessages: [`An issue with key '${missing}' does not exist for field 'key'.`], errors: {} }, 400);
        const all = issues.filter((issue) => matches(issue, jql));
        const from = nextPageToken === undefined ? 0 : Number(nextPageToken);
        const page = all.slice(from, from + maxResults);
        const more = from + page.length < all.length;
        return json({ issues: page.map(view), isLast: !more, ...(more ? { nextPageToken: String(from + page.length) } : {}) });
      }
      const comments = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/comment$/.exec(path);
      if (comments) {
        const issue = issues.find((candidate) => candidate.key === comments[1]);
        if (issue === undefined) return json({ errorMessages: ["Issue does not exist"] }, 404);
        if (method === "GET") {
          const startAt = Number(new URL(url).searchParams.get("startAt") ?? 0);
          const max = Number(new URL(url).searchParams.get("maxResults") ?? 100);
          const all = issue.comments ?? [];
          // Who and when as the real endpoint carries them: one author for every comment, its `commentTimes` entry or the ticket's creation for its time.
          const created = issue.created ?? "2026-10-01T10:00:00.000-0300";
          return json({
            comments: all.slice(startAt, startAt + max).map((text, i) => ({ body: adf(text), author: { displayName: "Persona de Prueba" }, created: issue.commentTimes?.[startAt + i] ?? created })),
            total: all.length, startAt,
          });
        }
        issue.comments = [...(issue.comments ?? []), adfFlat((body as { body: unknown }).body)];
        return json({ id: String(next++) }, 201);
      }
      if (method === "POST" && path === "/rest/api/3/issue") {
        const fields = (body as { fields: Record<string, unknown> }).fields;
        const target = (fields.project as { key?: string } | undefined)?.key ?? project;
        if (!projects.includes(target)) return json({ errorMessages: [], errors: { project: "valid project is required" } }, 400);
        const refusedCreate = refusal(fields);
        if (refusedCreate !== null) return refusedCreate;
        const start = workflowOf(`${target}-0`).statuses[0]!;
        const key = `${target}-${next++}`;
        issues.push({
          key,
          summary: String(fields.summary),
          type: (fields.issuetype as { name: string }).name,
          priority: (fields.priority as { name: string } | undefined)?.name,
          labels: fields.labels as string[],
          description: adfFlat(fields.description),
          statusCategory: start.category,
          status: start.name,
          created: new Date().toISOString(),
          comments: [],
          custom: customOf(fields),
          history: [],
          ...(typeof (fields.parent as { key?: unknown } | undefined)?.key === "string" ? { parent: (fields.parent as { key: string }).key } : {}),
        });
        return json({ id: String(next), key }, 201);
      }
      const attaching = /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]*-\d+)\/attachments$/.exec(path);
      if (method === "POST" && attaching) {
        const issue = issues.find((candidate) => candidate.key === attaching[1]);
        if (issue === undefined) return json({ errorMessages: ["Issue does not exist or you do not have permission to see it."] }, 404);
        // As Jira does: a multipart upload without its XSRF header is refused.
        if (new Headers(init.headers).get("x-atlassian-token") !== "no-check") return json({ errorMessages: ["XSRF check failed"] }, 403);
        const form = init.body instanceof FormData ? init.body : null;
        const file = form?.get("file");
        if (file === null || file === undefined || typeof file === "string") return json({ errorMessages: ["no file field"] }, 400);
        const added: FakeAttachment = { id: String(next++), filename: (file as File).name, size: file.size, mimeType: file.type || "application/octet-stream", content: await file.text() };
        issue.attachments = [...(issue.attachments ?? []), added];
        calls[calls.length - 1]!.body = { file: added.filename, size: added.size };
        return json([{ id: added.id, filename: added.filename, size: added.size, mimeType: added.mimeType }]);
      }
      const one = /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]*-\d+)(\/transitions|\/changelog)?$/.exec(path);
      const issue = one ? issues.find((candidate) => candidate.key === one[1]) : undefined;
      if (one && issue === undefined) return json({ errorMessages: ["Issue does not exist or you do not have permission to see it."] }, 404);
      if (one && issue !== undefined) {
        const history = issue.history ?? [];
        if (method === "GET" && one[2] === undefined) {
          const { fields } = view(issue);
          const expand = parsed.searchParams.get("expand") === "changelog";
          // As the live expand does: newest first, a page of at most a
          // hundred, and the total.
          const newest = history.map(historyOf).reverse().slice(0, 100);
          const attachment = parsed.searchParams.get("fields") === "attachment";
          return json({
            key: issue.key,
            fields: attachment
              ? { attachment: (issue.attachments ?? []).map((file) => ({ id: file.id, filename: file.filename, size: file.size, mimeType: file.mimeType })) }
              : { status: fields.status },
            ...(expand ? { changelog: { startAt: 0, maxResults: newest.length, total: history.length, histories: newest } } : {}),
          });
        }
        if (method === "GET" && one[2] === "/changelog") {
          const startAt = Number(parsed.searchParams.get("startAt") ?? 0);
          const max = Number(parsed.searchParams.get("maxResults") ?? 100);
          const values = history.slice(startAt, startAt + max).map((change, index) => historyOf(change, startAt + index));
          return json({ startAt, maxResults: max, total: history.length, isLast: startAt + values.length >= history.length, values });
        }
        if (method === "GET" && one[2] === "/transitions") {
          return json({ transitions: offered(issue).map((status, index) => ({ id: String(11 + index), name: status.name, to: { name: status.name, statusCategory: { key: status.category } } })) });
        }
        if (method === "POST" && one[2] === "/transitions") {
          const wanted = (body as { transition?: { id?: string } } | null)?.transition?.id;
          const status = offered(issue).find((_, index) => String(11 + index) === wanted);
          if (status === undefined) return json({ errorMessages: [`Transition id '${wanted}' is not valid for this issue.`] }, 400);
          const at = new Date().toISOString();
          issue.history = [...history, { from: issue.status ?? workflowOf(issue.key).statuses[0]!.name, to: status.name, at, by: self.actor }];
          issue.status = status.name;
          issue.statusCategory = status.category;
          if (status.category === "done") {
            issue.doneAt = at;
            issue.resolved = at;
          }
          return new Response(null, { status: 204 });
        }
        if (method === "PUT" && one[2] === undefined) {
          const edit = (body ?? {}) as { fields?: Record<string, unknown>; update?: { labels?: ({ add: string } | { remove: string })[] } };
          const refusedEdit = refusal(edit.fields ?? {});
          if (refusedEdit !== null) return refusedEdit;
          let labels = [...(issue.labels ?? [])];
          for (const op of edit.update?.labels ?? []) {
            if ("add" in op && !labels.includes(op.add)) labels.push(op.add);
            if ("remove" in op) labels = labels.filter((label) => label !== op.remove);
          }
          issue.labels = labels;
          issue.custom = { ...issue.custom, ...customOf(edit.fields ?? {}) };
          return new Response(null, { status: 204 });
        }
      }
      if (method === "POST" && path === "/rest/api/3/issueLink") return new Response(null, { status: 201 });
      return json({ errorMessages: [`the fake Jira does not know ${method} ${path}`] }, 404);
    },
  };
  return self;
}

/** ADF back to text, for the fake's own bookkeeping. */
function adfFlat(node: unknown): string {
  if (node === null || typeof node !== "object") return "";
  const value = node as { type?: string; text?: string; content?: unknown[] };
  if (typeof value.text === "string") return value.text;
  const inner = (value.content ?? []).map(adfFlat);
  return value.type === "doc" ? inner.join("\n") : inner.join("");
}

/** The app labels every clerk test's project names (`appLabels`): placeholders, never a real team's. */
export const APP_LABELS: AppLabels = { backoffice: "acme-backoffice", pwa: "acme-pwa" };
