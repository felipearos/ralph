/**
 * The Jira Cloud adapter (felipearos/ralph#337): the `Tracker` interface over
 * REST v3, pinned to one site and one project, so issue `n` is `<KEY>-n`.
 *
 * Plain `fetch` with basic auth (account email and API token), never `acli`,
 * for the reason the Linear adapter gives: an injected fetch is what lets the
 * contract suite drive it, and a loop's tracker must not depend on a CLI's
 * login state overnight.
 *
 * Shapes worth knowing, read off the live site with `acli` (2026-10-20):
 *   - Descriptions and comments are ADF (`adf.ts` renders them as markdown).
 *   - Closed is `status.statusCategory.key === "done"`, whatever the status
 *     is called.
 *   - A "Blocks" link on issue X with an `inwardIssue` Y reads "X is blocked
 *     by Y", so X's blockers are its inward "Blocks" links.
 *   - The search endpoint is `POST /rest/api/3/search/jql`, paged by
 *     `nextPageToken` (the offset-paged `/search` is retired).
 *   - A throttle is HTTP 429 with `Retry-After` in seconds.
 *
 * A state move is a transition: Jira moves an issue only along its workflow,
 * so the adapter takes the transition whose target status has the configured
 * name, and reports a warning when the issue's current status offers none.
 */
import type { IssueComment } from "../block-reason";
import { retryPolicy, withRateLimitRetry, type RateLimitSignal, type RetryBudget } from "../frontier/github-rate-limit";
import type { TrackerStates } from "../project-config";
import { adfToMarkdown, markdownToAdf } from "./adf";
import {
  TrackerUnavailableError,
  wipLabelsOn,
  type Tracker,
  type TrackerBlocker,
  type TrackerClosedIssue,
  type TrackerCreatedIssue,
  type TrackerIssue,
  type TrackerIssueDetail,
  type TrackerIssueSummary,
  type TrackerLiveIssue,
  type TrackerTransition,
} from "./types";

const OPEN_CENSUS_LIMIT = 500;
const CLOSED_CENSUS_LIMIT = 1000;
const PAGE = 100;
const COMMENT_TAIL = 20;
const CENSUS_FIELDS = ["summary", "description", "labels", "assignee", "reporter", "parent", "issuelinks", "status", "comment"];

export interface JiraTrackerOptions {
  /** `example.atlassian.net`. */
  site: string;
  /** `OA`. */
  project: string;
  scopeLabel: string | null;
  states: TrackerStates;
  email: string;
  apiToken: string;
  fetch?: typeof fetch;
}

/** A Jira answer that was an error, with what Jira said. */
export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "JiraError";
  }
}

export function classifyJiraFailure(error: unknown): RateLimitSignal | null {
  if (!(error instanceof JiraError) || error.status !== 429) return null;
  return { kind: "quota", retryAfterSeconds: error.retryAfterSeconds };
}

interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
}

interface JiraComment {
  body: unknown;
  created: string;
  author?: { displayName: string } | null;
}

interface JiraFields {
  summary: string;
  description?: unknown;
  labels?: string[];
  assignee?: JiraUser | null;
  reporter?: JiraUser | null;
  parent?: { key: string } | null;
  status?: { name: string; statusCategory: { key: string } };
  /**
   * Set when an issue gets a resolution, which a workflow's done transitions
   * usually give; one that closes without a resolution leaves it null.
   */
  resolutiondate?: string | null;
  issuelinks?: {
    type: { name: string };
    inwardIssue?: { key: string; fields?: { status?: { statusCategory: { key: string } } } };
    outwardIssue?: { key: string };
  }[];
  comment?: { comments: JiraComment[]; total: number };
}

interface JiraIssue {
  key: string;
  fields: JiraFields;
}

/** A JQL string literal. */
const quote = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const asComments = (comments: JiraComment[]): IssueComment[] =>
  comments
    .map((comment) => ({ body: adfToMarkdown(comment.body), createdAt: comment.created, author: comment.author?.displayName ?? null }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

export function createJiraTracker(options: JiraTrackerOptions): Tracker {
  const { project, states } = options;
  const doFetch = options.fetch ?? fetch;
  const base = `https://${options.site}`;
  const auth = `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString("base64")}`;
  const ref = (number: number): string => `${project}-${number}`;
  /** The number of a key in this project, or null for any other project's. */
  const numberOf = (key: string): number | null => {
    const match = /^([A-Z][A-Z0-9_]*)-([1-9][0-9]*)$/.exec(key);
    return match !== null && match[1] === project ? Number(match[2]) : null;
  };

  const send = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await doFetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: auth,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (response.status === 401) {
      throw new TrackerUnavailableError(`Jira refused the credential for ${options.site} (HTTP 401); reconnect the tracker from the dashboard`, "not-connected");
    }
    if (response.status === 429) {
      const retry = Number(response.headers.get("retry-after"));
      throw new JiraError(`Jira rate limit (HTTP 429) on ${method} ${path}`, 429, Number.isFinite(retry) && retry > 0 ? retry : null);
    }
    if (!response.ok) {
      let detail = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> };
        detail = [...(parsed.errorMessages ?? []), ...Object.entries(parsed.errors ?? {}).map(([field, message]) => `${field}: ${message}`)].join("; ") || detail;
      } catch {
        // Not JSON: the raw text, truncated, is the detail.
      }
      throw new JiraError(`Jira ${method} ${path} failed (HTTP ${response.status}): ${detail}`, response.status);
    }
    return (text === "" ? undefined : JSON.parse(text)) as T;
  };

  const budget: RetryBudget = { waitedSeconds: 0 };
  const retryDeps = {
    sleep: (seconds: number): Promise<void> => new Promise((done) => setTimeout(done, seconds * 1000)),
    random: Math.random,
  };
  const read = <T>(method: string, path: string, body?: unknown): Promise<T> =>
    withRateLimitRetry(() => send<T>(method, path, body), classifyJiraFailure, retryDeps, retryPolicy(), budget);
  const write = async (method: string, path: string, body?: unknown): Promise<void> => {
    await send(method, path, body);
  };

  const jql = (closed: boolean | null, label?: string, bodyContains?: string, updatedSince?: string): string => {
    const clauses = [`project = ${quote(project)}`];
    if (closed !== null) clauses.push(closed ? "statusCategory = Done" : "statusCategory != Done");
    if (options.scopeLabel !== null) clauses.push(`labels = ${quote(options.scopeLabel)}`);
    if (label !== undefined) clauses.push(`labels = ${quote(label)}`);
    // `~` is Jira's word-based text match, so it is a prefilter and no more.
    if (bodyContains !== undefined) clauses.push(`description ~ ${quote(bodyContains)}`);
    // JQL reads a date in the account's time zone, which the adapter does not
    // know: a day before the UTC date is a superset in any zone, never a subset.
    if (updatedSince !== undefined) clauses.push(`updated >= "${new Date(Date.parse(updatedSince) - 86_400_000).toISOString().slice(0, 10)}"`);
    return `${clauses.join(" AND ")} ORDER BY created DESC`;
  };

  /** Every issue a JQL query matches, up to `limit`, newest first. */
  const search = async (query: string, fields: string[], limit: number): Promise<JiraIssue[]> => {
    const found: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    while (found.length < limit) {
      const page = await read<{ issues: JiraIssue[]; nextPageToken?: string; isLast?: boolean }>("POST", "/rest/api/3/search/jql", {
        jql: query,
        fields,
        maxResults: Math.min(PAGE, limit - found.length),
        ...(nextPageToken === undefined ? {} : { nextPageToken }),
      });
      found.push(...page.issues);
      if (page.isLast !== false || page.nextPageToken === undefined) break;
      nextPageToken = page.nextPageToken;
    }
    return found.slice(0, limit);
  };

  const issuePath = (number: number): string => `/rest/api/3/issue/${encodeURIComponent(ref(number))}`;
  const fieldsOf = async (number: number, fields: string[]): Promise<JiraFields> =>
    (await read<JiraIssue>("GET", `${issuePath(number)}?fields=${fields.join(",")}`)).fields;

  const allComments = async (number: number): Promise<IssueComment[]> => {
    const found: JiraComment[] = [];
    for (;;) {
      const page = await read<{ comments: JiraComment[]; total: number }>(
        "GET",
        `${issuePath(number)}/comment?orderBy=created&startAt=${found.length}&maxResults=100`,
      );
      found.push(...page.comments);
      if (page.comments.length === 0 || found.length >= page.total) break;
    }
    return asComments(found);
  };

  const blockersOf = (links: JiraFields["issuelinks"] = []): TrackerBlocker[] =>
    links.flatMap((link) => {
      if (link.type.name !== "Blocks" || link.inwardIssue === undefined) return [];
      const number = numberOf(link.inwardIssue.key);
      if (number === null) return [];
      return [{ number, state: link.inwardIssue.fields?.status?.statusCategory.key === "done" ? "closed" : "open" } as TrackerBlocker];
    });

  const editLabels = async (number: number, ops: { add: string }[] | { remove: string }[]): Promise<void> => {
    if (ops.length === 0) return;
    await write("PUT", issuePath(number), { update: { labels: ops } });
  };

  const removeLabels = async (number: number, labels: readonly string[], carried?: readonly string[]): Promise<void> => {
    const present = carried ?? (await fieldsOf(number, ["labels"])).labels ?? [];
    await editLabels(number, labels.filter((label) => present.includes(label)).map((label) => ({ remove: label })));
  };

  const addLabels = async (number: number, labels: readonly string[], carried?: readonly string[]): Promise<void> => {
    if (labels.length === 0) return;
    const present = carried ?? (await fieldsOf(number, ["labels"])).labels ?? [];
    await editLabels(number, labels.filter((label) => !present.includes(label)).map((label) => ({ add: label })));
  };

  /** The transition to the status named `to`; a missing one is a warning, since the labels are the fence. */
  const move = async (number: number, to: string): Promise<TrackerTransition> => {
    try {
      const status = (await fieldsOf(number, ["status"])).status;
      if (status?.name === to) return { movedTo: to, warning: null };
      const { transitions } = await read<{ transitions: { id: string; name: string; to: { name: string } }[] }>(
        "GET",
        `${issuePath(number)}/transitions`,
      );
      const transition = transitions.find((candidate) => candidate.to.name === to) ?? transitions.find((candidate) => candidate.name === to);
      if (transition === undefined) {
        return {
          movedTo: null,
          warning: `${ref(number)} has no transition to '${to}' from '${status?.name ?? "its status"}'${transitions.length === 0 ? "" : ` (offers: ${transitions.map((candidate) => candidate.to.name).join(", ")})`}`,
        };
      }
      await write("POST", `${issuePath(number)}/transitions`, { transition: { id: transition.id } });
      return { movedTo: to, warning: null };
    } catch (error) {
      return { movedTo: null, warning: `moving ${ref(number)} to '${to}' failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  };

  const swapWip = async (number: number, label: string): Promise<void> => {
    const carried = (await fieldsOf(number, ["labels"])).labels ?? [];
    const wip = wipLabelsOn(carried);
    await removeLabels(number, wip, carried);
    await addLabels(number, [label], carried.filter((name) => !wip.includes(name)));
  };

  const display = (user: JiraUser | null | undefined): string[] => (user ? [user.displayName] : []);

  const isDone = (fields: JiraFields): boolean => fields.status?.statusCategory.key === "done";

  /**
   * Drops a done-category issue from a search for OPEN issues. Jira's JQL
   * search runs on an index that can lag a status move, so a ticket moved to
   * a done-category status like "Mergeado" came back as open and was claimed
   * (OAI-140, 2026-11-03); the per-issue GET is authoritative, but an open
   * search whose response carries the status need not wait for it. An issue
   * without a status in the response is kept, as before.
   */
  const stillOpen = (issues: JiraIssue[]): JiraIssue[] => issues.filter((issue) => !isDone(issue.fields));

  return {
    kind: "jira",
    ref,
    url: (number) => `${base}/browse/${ref(number)}`,

    async openIssues(): Promise<TrackerIssue[]> {
      const issues = stillOpen(await search(jql(false), CENSUS_FIELDS, OPEN_CENSUS_LIMIT));
      return issues.flatMap((issue) => {
        const number = numberOf(issue.key);
        if (number === null) return [];
        const { fields } = issue;
        return [
          {
            number,
            title: fields.summary,
            body: adfToMarkdown(fields.description),
            labels: fields.labels ?? [],
            assignees: display(fields.assignee),
            author: fields.reporter?.displayName ?? null,
            parent: fields.parent ? numberOf(fields.parent.key) : null,
            blockers: blockersOf(fields.issuelinks),
            comments: asComments(fields.comment?.comments ?? []).slice(-COMMENT_TAIL),
          },
        ];
      });
    },

    async closedIssues(): Promise<TrackerClosedIssue[]> {
      return (await search(jql(true), ["summary", "description"], CLOSED_CENSUS_LIMIT)).flatMap((issue) => {
        const number = numberOf(issue.key);
        return number === null ? [] : [{ number, title: issue.fields.summary, body: adfToMarkdown(issue.fields.description) }];
      });
    },

    async issue(number): Promise<TrackerIssueDetail> {
      const [fields, comments] = await Promise.all([
        fieldsOf(number, ["summary", "description", "status", "labels", "assignee", "reporter", "resolutiondate"]),
        allComments(number),
      ]);
      return {
        number,
        title: fields.summary,
        body: adfToMarkdown(fields.description),
        state: isDone(fields) ? "closed" : "open",
        status: fields.status?.name ?? "",
        labels: fields.labels ?? [],
        assignees: display(fields.assignee),
        author: fields.reporter?.displayName ?? null,
        url: `${base}/browse/${ref(number)}`,
        closedAt: fields.resolutiondate ?? null,
        // Jira has no cancelled status category, and cancel() here moves to a
        // done-category state, so every closed issue reads as completed.
        closedAs: isDone(fields) ? "completed" : null,
        // Jira's development panel is not on the REST API this adapter reads: none listed.
        pullRequests: [],
        comments,
      };
    },

    async live(number): Promise<TrackerLiveIssue> {
      const fields = await fieldsOf(number, ["labels", "assignee", "status"]);
      return {
        assignees: display(fields.assignee),
        labels: fields.labels ?? [],
        linkedPullRequests: [],
        state: isDone(fields) ? "closed" : "open",
        status: fields.status?.name ?? "",
      };
    },

    comments: allComments,

    async withLabel(label, { state = "open", limit = 100, updatedSince } = {}): Promise<TrackerIssueSummary[]> {
      const found = await search(jql(state === "all" ? null : state === "closed", label, undefined, updatedSince), state === "open" ? ["summary", "status"] : ["summary"], limit);
      return (state === "open" ? stillOpen(found) : found).flatMap((issue) => {
        const number = numberOf(issue.key);
        return number === null ? [] : [{ number, title: issue.fields.summary }];
      });
    },

    addLabels: (number, labels) => addLabels(number, labels),
    removeLabels: (number, labels) => removeLabels(number, labels),

    async assign(number, login) {
      let accountId: string;
      if (login === undefined) {
        accountId = (await read<JiraUser>("GET", "/rest/api/3/myself")).accountId;
      } else {
        const users = (await read<JiraUser[]>("GET", `/rest/api/3/user/search?query=${encodeURIComponent(login)}`)).filter(
          (user) => user.displayName === login || user.emailAddress === login,
        );
        if (users.length !== 1) throw new JiraError(`Jira has ${users.length === 0 ? "no" : "more than one"} user named '${login}'`, 404);
        accountId = users[0]!.accountId;
      }
      await write("PUT", `${issuePath(number)}/assignee`, { accountId });
    },

    async comment(number, body) {
      await write("POST", `${issuePath(number)}/comment`, { body: markdownToAdf(body) });
    },

    async create(issue): Promise<TrackerCreatedIssue> {
      const created = await send<{ key: string }>("POST", "/rest/api/3/issue", {
        fields: {
          project: { key: project },
          // Jira requires a type and every project has "Task". The pipeline's
          // own type and priority (#391) arrive with #397, which is also when
          // there is a caller to configure them.
          issuetype: { name: "Task" },
          summary: issue.title,
          description: markdownToAdf(issue.body),
          ...(issue.labels === undefined || issue.labels.length === 0 ? {} : { labels: [...issue.labels] }),
        },
      });
      const number = numberOf(created.key);
      if (number === null) throw new JiraError(`Jira created ${created.key}, which is not in project ${project}`, 200);
      // Jira opens an issue in its workflow's first status, so a named state is
      // a transition afterwards: a warning if the workflow does not offer it,
      // never a throw, since the issue exists and its number must come back.
      const transition = issue.state === undefined ? { movedTo: null, warning: null } : await move(number, issue.state);
      return { number, url: `${base}/browse/${ref(number)}`, ...transition };
    },

    async editBody(number, body) {
      await write("PUT", issuePath(number), { fields: { description: markdownToAdf(body) } });
    },

    /**
     * Jira has no cancelled status TYPE — everything finished is the `done`
     * category — so the status is the configured one, falling back to the
     * project's done state rather than leaving a routed issue open.
     */
    cancel: (number) => move(number, states.canceled ?? states.done),

    /**
     * Back through the transition into the To Do category, whatever the
     * workflow calls its status: the category is the one name every Jira
     * workflow shares. A missing transition is a warning, as `move`'s is.
     */
    async reopen(number) {
      const status = (await fieldsOf(number, ["status"])).status;
      if (status?.statusCategory.key !== "done") return { movedTo: null, warning: null };
      const { transitions } = await read<{ transitions: { id: string; name: string; to: { name: string; statusCategory?: { key: string } } }[] }>(
        "GET",
        `${issuePath(number)}/transitions`,
      );
      const transition = transitions.find((candidate) => candidate.to.statusCategory?.key === "new");
      if (transition === undefined) {
        return { movedTo: null, warning: `${ref(number)} has no transition into a To Do status from '${status.name}' to reopen it` };
      }
      await write("POST", `${issuePath(number)}/transitions`, { transition: { id: transition.id } });
      return { movedTo: transition.to.name, warning: null };
    },

    async findByBodyMarker(marker, { state = "all", limit = 25 } = {}): Promise<TrackerIssueSummary[]> {
      const fields = state === "open" ? ["summary", "description", "status"] : ["summary", "description"];
      const found = await search(jql(state === "all" ? null : state === "closed", undefined, marker), fields, limit);
      return (state === "open" ? stillOpen(found) : found).flatMap((issue) => {
        const number = numberOf(issue.key);
        // The exact substring, read back out of the ADF: `~` matches words, so
        // a near miss would otherwise read as "already created".
        if (number === null || !adfToMarkdown(issue.fields.description).includes(marker)) return [];
        return [{ number, title: issue.fields.summary }];
      });
    },

    async claim(number, claimLabel) {
      await addLabels(number, [claimLabel]);
      return move(number, states.claimed);
    },

    async done(number, doneLabel) {
      await swapWip(number, doneLabel);
      return move(number, states.done);
    },

    async handoff(number, doneLabel) {
      await swapWip(number, doneLabel);
      return states.review === undefined ? { movedTo: null, warning: null } : move(number, states.review);
    },

    async blocked(number, stuckLabel) {
      await swapWip(number, stuckLabel);
      return { movedTo: null, warning: null };
    },

    // Jira labels are free-form: adding one creates it.
    ensureLabels: async () => ({ created: [], missing: [] }),

    // Every status any of the project's issue types can be in.
    async workflowStates() {
      const types = await read<{ statuses: { name: string }[] }[]>("GET", `/rest/api/3/project/${encodeURIComponent(project)}/statuses`);
      return [...new Set(types.flatMap((type) => type.statuses.map((status) => status.name)))];
    },

    classifyFailure: (error) => classifyJiraFailure(error),
  };
}
