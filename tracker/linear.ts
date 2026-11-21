/**
 * The Linear adapter (felipearos/ralph#336): the `Tracker` interface over
 * Linear's GraphQL API, pinned to one team, so issue `n` is `<TEAM>-n`.
 *
 * Plain `fetch`, never the `linear` CLI: the CLI keeps its key in a desktop
 * keyring that is not reliably unlocked for a loop running overnight, and an
 * injected `fetch` is what lets the contract suite drive this adapter
 * against an emulated Linear.
 *
 * Shapes worth knowing, read off the live API (2026-10-20):
 *   - An issue is closed when its state's TYPE is `completed`, `canceled` or
 *     `duplicate` (a team may name a completed state "For Review").
 *   - "X blocks Y" is a relation on X; Y sees it in `inverseRelations` with
 *     type `blocks`, so Y's blockers are its inverse `blocks` relations.
 *   - A personal API key goes in `Authorization` bare, without `Bearer`.
 *   - A bad key is HTTP 401 `AUTHENTICATION_ERROR`; a throttled one carries
 *     `RATELIMITED`, and `x-ratelimit-requests-reset` is an epoch in ms.
 *   - `orderBy: createdAt` lists newest first.
 *
 * A team often holds several repositories' tickets, so `scopeLabel`, when set,
 * narrows every listing to the issues carrying it.
 *
 * Only the team's own issues are numbers here. A parent or blocker in another
 * team has a number that would collide with this team's, so it is left out
 * rather than mis-resolved.
 */
import type { IssueComment } from "../block-reason";
import { retryPolicy, withRateLimitRetry, type RateLimitSignal, type RetryBudget } from "../frontier/github-rate-limit";
import type { TrackerStates } from "../project-config";
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

export const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const CLOSED_TYPES = ["completed", "canceled", "duplicate"];
const OPEN_CENSUS_LIMIT = 500;
const CLOSED_CENSUS_LIMIT = 1000;
const PAGE = 100;
const COMMENT_TAIL = 20;

export interface LinearTrackerOptions {
  /** The team key, `AND`. */
  team: string;
  /** The workspace URL key, `exampleorg`. */
  workspace: string;
  scopeLabel: string | null;
  states: TrackerStates;
  apiKey: string;
  fetch?: typeof fetch;
  endpoint?: string;
}

/** A Linear answer that was an error, with what Linear said. */
export class LinearError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "LinearError";
  }
}

/** Whether a failed Linear call was throttling. */
export function classifyLinearFailure(error: unknown): RateLimitSignal | null {
  if (!(error instanceof LinearError)) return null;
  if (error.code === "RATELIMITED" || error.status === 429) {
    return { kind: "quota", retryAfterSeconds: error.retryAfterSeconds };
  }
  return null;
}

interface GraphQlAnswer<T> {
  data?: T | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}

interface LinearNode {
  id: string;
  number: number;
  title: string;
  description: string | null;
  state: { name: string; type: string };
  labels: { nodes: { id: string; name: string }[] };
  assignee: { displayName: string } | null;
  creator: { displayName: string } | null;
  parent: { number: number; team: { key: string } } | null;
  /** Linear stamps one or the other as an issue enters a completed- or canceled-type state, and clears it on the way out. */
  completedAt: string | null;
  canceledAt: string | null;
}

/** What `issue()` reads: the census never asks for attachments, so only the one-issue read carries them. */
interface DetailNode extends LinearNode {
  /** Links attached to the issue, a GitHub integration's pull requests among them. */
  attachments: { nodes: { url: string; createdAt: string }[] };
}

interface CensusNode extends LinearNode {
  inverseRelations: {
    pageInfo: { hasNextPage: boolean };
    nodes: { type: string; issue: { number: number; team: { key: string }; state: { type: string } } }[];
  };
  comments: { nodes: { body: string; createdAt: string }[] };
}

const NODE_FIELDS = `id number title description state { name type } labels { nodes { id name } }
  assignee { displayName } creator { displayName } parent { number team { key } } completedAt canceledAt`;

const RELATION_FIELDS = `inverseRelations(first: 100) { pageInfo { hasNextPage } nodes { type issue { number team { key } state { type } } } }`;

const CENSUS_QUERY = `query RalphCensus($filter: IssueFilter!, $after: String) {
  issues(filter: $filter, first: ${PAGE}, after: $after, orderBy: createdAt) {
    pageInfo { hasNextPage endCursor }
    nodes { ${NODE_FIELDS} ${RELATION_FIELDS} comments(first: ${COMMENT_TAIL}, orderBy: createdAt) { nodes { body createdAt } } }
  }
}`;

const CLOSED_QUERY = `query RalphClosed($filter: IssueFilter!, $after: String) {
  issues(filter: $filter, first: 250, after: $after, orderBy: createdAt) {
    pageInfo { hasNextPage endCursor }
    nodes { number title description }
  }
}`;

const SUMMARY_QUERY = `query RalphWithLabel($filter: IssueFilter!, $first: Int!) {
  issues(filter: $filter, first: $first, orderBy: createdAt) { nodes { number title } }
}`;

/** `SUMMARY_QUERY` for a window of recent updates: ordered by them, so the limit keeps the newest. */
const UPDATED_SUMMARY_QUERY = `query RalphWithLabelUpdated($filter: IssueFilter!, $first: Int!) {
  issues(filter: $filter, first: $first, orderBy: updatedAt) { nodes { number title } }
}`;

const MARKER_QUERY = `query RalphMarker($filter: IssueFilter!, $first: Int!) {
  issues(filter: $filter, first: $first, orderBy: createdAt) { nodes { number title description } }
}`;

const ISSUE_QUERY = `query RalphIssue($id: String!) { issue(id: $id) { ${NODE_FIELDS} attachments { nodes { url createdAt } } } }`;

/** A GitHub pull request's page, the one attachment kind that is a linked PR. */
const PULL_REQUEST_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;

/** How a closed state type was closed: `duplicate` is dropped work, as `canceled` is. */
const closedAsOf = (type: string): "completed" | "canceled" | null =>
  type === "completed" ? "completed" : type === "canceled" || type === "duplicate" ? "canceled" : null;

/**
 * The linked PRs, oldest first, each once. Sorted here because Linear lists a
 * connection newest first; a PR attached twice (by hand and by the
 * integration) is still one PR.
 */
const pullRequestsOf = (attachments: DetailNode["attachments"]): string[] => [
  ...new Set(
    [...attachments.nodes]
      .filter((attachment) => PULL_REQUEST_URL.test(attachment.url))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((attachment) => attachment.url),
  ),
];

const BLOCKERS_QUERY = `query RalphBlockers($id: String!, $after: String) {
  issue(id: $id) {
    inverseRelations(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { type issue { number team { key } state { type } } }
    }
  }
}`;

const COMMENTS_QUERY = `query RalphComments($id: String!, $after: String) {
  issue(id: $id) {
    comments(first: 250, after: $after, orderBy: createdAt) {
      pageInfo { hasNextPage endCursor }
      nodes { body createdAt user { displayName } }
    }
  }
}`;

const TEAM_QUERY = `query RalphTeam($key: String!, $after: String) {
  viewer { id displayName }
  teams(filter: { key: { eq: $key } }) { nodes { id key states { nodes { id name type } } } }
  issueLabels(first: 250, after: $after, filter: { or: [{ team: { key: { eq: $key } } }, { team: { null: true } }] }) {
    pageInfo { hasNextPage endCursor }
    nodes { id name }
  }
}`;

const USER_QUERY = `query RalphUser($login: String!) {
  users(first: 2, filter: { or: [{ displayName: { eq: $login } }, { email: { eq: $login } }, { name: { eq: $login } }] }) {
    nodes { id displayName }
  }
}`;

const ADD_LABEL = `mutation RalphAddLabel($id: String!, $labelId: String!) { issueAddLabel(id: $id, labelId: $labelId) { success } }`;
const REMOVE_LABEL = `mutation RalphRemoveLabel($id: String!, $labelId: String!) { issueRemoveLabel(id: $id, labelId: $labelId) { success } }`;
const UPDATE_ISSUE = `mutation RalphUpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`;
const CREATE_COMMENT = `mutation RalphComment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`;
const CREATE_ISSUE = `mutation RalphCreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { number } } }`;
const CREATE_LABEL = `mutation RalphCreateLabel($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id name } } }`;

const oneLine = (query: string): string => query.replace(/\s+/g, " ").trim();

const oldestFirst = (comments: { body: string; createdAt: string; user?: { displayName: string } | null }[]): IssueComment[] =>
  [...comments]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(({ body, createdAt, user }) => ({ body, createdAt, ...(user === undefined ? {} : { author: user?.displayName ?? null }) }));

interface Team {
  id: string;
  viewer: { id: string; displayName: string };
  states: { id: string; name: string; type: string }[];
  labels: Map<string, string>;
}

export function createLinearTracker(options: LinearTrackerOptions): Tracker {
  const { team: key, states } = options;
  const doFetch = options.fetch ?? fetch;
  const endpoint = options.endpoint ?? LINEAR_ENDPOINT;
  const ref = (number: number): string => `${key}-${number}`;

  const send = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: options.apiKey },
      body: JSON.stringify({ query: oneLine(query), variables }),
    });
    const text = await response.text();
    let answer: GraphQlAnswer<T> = {};
    try {
      answer = JSON.parse(text) as GraphQlAnswer<T>;
    } catch {
      // A non-JSON answer (a proxy's HTML) is reported by status below.
    }
    const code = answer.errors?.[0]?.extensions?.code ?? null;
    if (response.status === 401 || code === "AUTHENTICATION_ERROR") {
      throw new TrackerUnavailableError(`Linear refused the API key (HTTP ${response.status}); reconnect the tracker from the dashboard`, "not-connected");
    }
    if (code === "RATELIMITED" || response.status === 429) {
      const reset = Number(response.headers.get("x-ratelimit-requests-reset"));
      const retryAfterSeconds = Number.isFinite(reset) && reset > 0 ? Math.max(1, Math.ceil((reset - Date.now()) / 1000)) : null;
      throw new LinearError(`Linear rate limit: ${answer.errors?.[0]?.message ?? `HTTP ${response.status}`}`, response.status, "RATELIMITED", retryAfterSeconds);
    }
    if (answer.errors !== undefined && answer.errors.length > 0) {
      throw new LinearError(`Linear: ${answer.errors.map((error) => error.message).join("; ")}`, response.status, code);
    }
    if (!response.ok || answer.data === undefined || answer.data === null) {
      throw new LinearError(`Linear answered HTTP ${response.status} with no data`, response.status, code);
    }
    return answer.data;
  };

  const budget: RetryBudget = { waitedSeconds: 0 };
  const retryDeps = {
    sleep: (seconds: number): Promise<void> => new Promise((done) => setTimeout(done, seconds * 1000)),
    random: Math.random,
  };
  /** Reads retry a throttle within the run's budget; writes never do behind the caller's back. */
  const read = <T>(query: string, variables: Record<string, unknown>): Promise<T> =>
    withRateLimitRetry(() => send<T>(query, variables), classifyLinearFailure, retryDeps, retryPolicy(), budget);
  const write = async (query: string, variables: Record<string, unknown>): Promise<void> => {
    await send(query, variables);
  };

  let team: Promise<Team> | null = null;
  const teamInfo = (): Promise<Team> =>
    (team ??= (async () => {
      const labels = new Map<string, string>();
      let after: string | null = null;
      let found: Omit<Team, "labels"> | null = null;
      do {
        const page: {
          viewer: { id: string; displayName: string };
          teams: { nodes: { id: string; key: string; states: { nodes: Team["states"] } }[] };
          issueLabels: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { id: string; name: string }[] };
        } = await read(TEAM_QUERY, { key, after });
        const node = page.teams.nodes[0];
        if (node === undefined) throw new LinearError(`Linear has no team with key '${key}'`, 200, "NO_TEAM");
        found = { id: node.id, viewer: page.viewer, states: node.states.nodes };
        // A team label shadows a workspace label of the same name, as in Linear's own picker.
        for (const label of page.issueLabels.nodes) if (!labels.has(label.name)) labels.set(label.name, label.id);
        after = page.issueLabels.pageInfo.hasNextPage ? page.issueLabels.pageInfo.endCursor : null;
      } while (after !== null);
      return { ...found!, labels };
    })().catch((error: unknown) => {
      team = null;
      throw error;
    }));

  /** Every listing's filter: this team, optionally this repository's label, a state set, and optionally a body substring. */
  const filter = (closed: boolean | null, extraLabel?: string, bodyContains?: string): Record<string, unknown> => {
    const clauses: Record<string, unknown>[] = [{ team: { key: { eq: key } } }];
    if (closed !== null) clauses.push({ state: { type: closed ? { in: CLOSED_TYPES } : { nin: CLOSED_TYPES } } });
    if (options.scopeLabel !== null) clauses.push({ labels: { name: { eq: options.scopeLabel } } });
    if (extraLabel !== undefined) clauses.push({ labels: { name: { eq: extraLabel } } });
    // Linear's `contains` is a case-sensitive substring, not a tokenised search.
    if (bodyContains !== undefined) clauses.push({ description: { contains: bodyContains } });
    return { and: clauses };
  };

  const node = async (number: number): Promise<DetailNode> => (await read<{ issue: DetailNode }>(ISSUE_QUERY, { id: ref(number) })).issue;

  const blockersOf = (nodes: CensusNode["inverseRelations"]["nodes"]): TrackerBlocker[] =>
    nodes
      .filter((relation) => relation.type === "blocks" && relation.issue.team.key === key)
      .map((relation) => ({
        number: relation.issue.number,
        state: CLOSED_TYPES.includes(relation.issue.state.type) ? "closed" : "open",
      }));

  const allBlockers = async (number: number): Promise<TrackerBlocker[]> => {
    const found: TrackerBlocker[] = [];
    let after: string | null = null;
    do {
      const page: { issue: { inverseRelations: CensusNode["inverseRelations"] & { pageInfo: { endCursor: string | null } } } } =
        await read(BLOCKERS_QUERY, { id: ref(number), after });
      found.push(...blockersOf(page.issue.inverseRelations.nodes));
      after = page.issue.inverseRelations.pageInfo.hasNextPage ? page.issue.inverseRelations.pageInfo.endCursor : null;
    } while (after !== null);
    return found;
  };

  const allComments = async (number: number): Promise<IssueComment[]> => {
    const found: { body: string; createdAt: string; user?: { displayName: string } | null }[] = [];
    let after: string | null = null;
    do {
      const page: {
        issue: {
          comments: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: { body: string; createdAt: string; user?: { displayName: string } | null }[];
          };
        };
      } = await read(COMMENTS_QUERY, { id: ref(number), after });
      found.push(...page.issue.comments.nodes);
      after = page.issue.comments.pageInfo.hasNextPage ? page.issue.comments.pageInfo.endCursor : null;
    } while (after !== null);
    return oldestFirst(found);
  };

  const labelId = async (name: string): Promise<string> => {
    const id = (await teamInfo()).labels.get(name);
    if (id === undefined) throw new LinearError(`Linear team ${key} has no label named '${name}'; preflight creates the loop's labels`, 200, "NO_LABEL");
    return id;
  };

  const ensureLabels = async (labels: readonly string[]): Promise<{ created: string[]; missing: string[] }> => {
    const info = await teamInfo();
    const created: string[] = [];
    const missing: string[] = [];
    for (const label of labels) {
      if (info.labels.has(label)) continue;
      try {
        const answer = await send<{ issueLabelCreate: { issueLabel: { id: string; name: string } } }>(CREATE_LABEL, {
          input: { name: label, teamId: info.id },
        });
        info.labels.set(label, answer.issueLabelCreate.issueLabel.id);
        created.push(label);
      } catch (error) {
        // A throttle or a refused key says nothing about the label: reporting
        // it as missing would turn a retryable failure into a permanent one.
        if (error instanceof TrackerUnavailableError || classifyLinearFailure(error) !== null) throw error;
        missing.push(label);
      }
    }
    if (missing.length === 0) return { created, missing };
    // Another process may have made the label between our read and our create,
    // and Linear refuses a taken name: read the team once more before calling
    // a label missing that now exists.
    team = null;
    const fresh = await teamInfo();
    for (const label of created) if (!fresh.labels.has(label)) fresh.labels.set(label, info.labels.get(label)!);
    return { created, missing: missing.filter((label) => !fresh.labels.has(label)) };
  };

  const addLabels = async (number: number, labels: readonly string[], issue?: LinearNode): Promise<void> => {
    if (labels.length === 0) return;
    const target = issue ?? (await node(number));
    const carried = target.labels.nodes.map((label) => label.name);
    for (const label of labels) {
      if (!carried.includes(label)) await write(ADD_LABEL, { id: target.id, labelId: await labelId(label) });
    }
  };

  const removeLabels = async (number: number, labels: readonly string[]): Promise<void> => {
    const issue = await node(number);
    for (const label of issue.labels.nodes) {
      if (labels.includes(label.name)) await write(REMOVE_LABEL, { id: issue.id, labelId: label.id });
    }
  };

  /** The state move a claim or a finish makes. A failure is a warning: the labels are the fence. */
  const move = async (number: number, to: string): Promise<TrackerTransition> => {
    try {
      const state = (await teamInfo()).states.find((candidate) => candidate.name === to);
      if (state === undefined) return { movedTo: null, warning: `Linear team ${key} has no workflow state named '${to}'` };
      const issue = await node(number);
      if (issue.state.name === to) return { movedTo: to, warning: null };
      await write(UPDATE_ISSUE, { id: issue.id, input: { stateId: state.id } });
      return { movedTo: to, warning: null };
    } catch (error) {
      return { movedTo: null, warning: `moving ${ref(number)} to '${to}' failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  };

  const swapWip = async (number: number, label: string): Promise<void> => {
    const issue = await node(number);
    await removeLabels(number, wipLabelsOn(issue.labels.nodes.map((carried) => carried.name)));
    await addLabels(number, [label], { ...issue, labels: { nodes: issue.labels.nodes.filter((carried) => !carried.name.endsWith("-wip")) } });
  };

  return {
    kind: "linear",
    ref,
    url: (number) => `https://linear.app/${options.workspace}/issue/${ref(number)}`,

    async openIssues(): Promise<TrackerIssue[]> {
      const issues: TrackerIssue[] = [];
      let after: string | null = null;
      while (issues.length < OPEN_CENSUS_LIMIT) {
        const page: { issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: CensusNode[] } } = await read(
          CENSUS_QUERY,
          { filter: filter(false), after },
        );
        for (const issue of page.issues.nodes) {
          if (issues.length >= OPEN_CENSUS_LIMIT) break;
          issues.push({
            number: issue.number,
            title: issue.title,
            body: issue.description ?? "",
            labels: issue.labels.nodes.map((label) => label.name),
            assignees: issue.assignee === null ? [] : [issue.assignee.displayName],
            author: issue.creator?.displayName ?? null,
            parent: issue.parent !== null && issue.parent.team.key === key ? issue.parent.number : null,
            // A blocker list longer than one page is read in full rather than trusted truncated.
            blockers: issue.inverseRelations.pageInfo.hasNextPage ? await allBlockers(issue.number) : blockersOf(issue.inverseRelations.nodes),
            comments: oldestFirst(issue.comments.nodes),
          });
        }
        if (!page.issues.pageInfo.hasNextPage || page.issues.pageInfo.endCursor === null) break;
        after = page.issues.pageInfo.endCursor;
      }
      return issues;
    },

    async closedIssues(): Promise<TrackerClosedIssue[]> {
      const closed: TrackerClosedIssue[] = [];
      let after: string | null = null;
      while (closed.length < CLOSED_CENSUS_LIMIT) {
        const page: {
          issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { number: number; title: string; description: string | null }[] };
        } = await read(CLOSED_QUERY, { filter: filter(true), after });
        for (const issue of page.issues.nodes) closed.push({ number: issue.number, title: issue.title, body: issue.description ?? "" });
        if (!page.issues.pageInfo.hasNextPage || page.issues.pageInfo.endCursor === null) break;
        after = page.issues.pageInfo.endCursor;
      }
      return closed.slice(0, CLOSED_CENSUS_LIMIT);
    },

    async issue(number): Promise<TrackerIssueDetail> {
      const [issue, comments] = await Promise.all([node(number), allComments(number)]);
      return {
        number: issue.number,
        title: issue.title,
        body: issue.description ?? "",
        state: CLOSED_TYPES.includes(issue.state.type) ? "closed" : "open",
        status: issue.state.name,
        labels: issue.labels.nodes.map((label) => label.name),
        assignees: issue.assignee === null ? [] : [issue.assignee.displayName],
        author: issue.creator?.displayName ?? null,
        // The short form, the same link `url()` gives: Linear redirects it to the slugged one.
        url: `https://linear.app/${options.workspace}/issue/${ref(issue.number)}`,
        closedAt: issue.completedAt ?? issue.canceledAt ?? null,
        closedAs: closedAsOf(issue.state.type),
        pullRequests: pullRequestsOf(issue.attachments),
        comments,
      };
    },

    async live(number): Promise<TrackerLiveIssue> {
      const issue = await node(number);
      return {
        assignees: issue.assignee === null ? [] : [issue.assignee.displayName],
        labels: issue.labels.nodes.map((label) => label.name),
        // Linear's GitHub link is optional and not ours to rely on: the caller reads the PR census.
        linkedPullRequests: [],
        state: CLOSED_TYPES.includes(issue.state.type) ? "closed" : "open",
        status: issue.state.name,
      };
    },

    comments: allComments,

    async withLabel(label, { state = "open", limit = 100, updatedSince } = {}): Promise<TrackerIssueSummary[]> {
      const scoped = filter(state === "all" ? null : state === "closed", label) as { and: Record<string, unknown>[] };
      const page = await read<{ issues: { nodes: TrackerIssueSummary[] } }>(
        updatedSince === undefined ? SUMMARY_QUERY : UPDATED_SUMMARY_QUERY,
        {
          filter: updatedSince === undefined ? scoped : { and: [...scoped.and, { updatedAt: { gte: updatedSince } }] },
          first: Math.min(limit, 250),
        },
      );
      return page.issues.nodes.map(({ number, title }) => ({ number, title }));
    },

    addLabels: (number, labels) => addLabels(number, labels),
    removeLabels,

    async assign(number, login) {
      let assigneeId: string;
      if (login === undefined) {
        assigneeId = (await teamInfo()).viewer.id;
      } else {
        const users = (await read<{ users: { nodes: { id: string }[] } }>(USER_QUERY, { login })).users.nodes;
        if (users.length !== 1) throw new LinearError(`Linear has ${users.length === 0 ? "no" : "more than one"} user named '${login}'`, 200, "NO_USER");
        assigneeId = users[0]!.id;
      }
      await write(UPDATE_ISSUE, { id: (await node(number)).id, input: { assigneeId } });
    },

    async comment(number, body) {
      await write(CREATE_COMMENT, { input: { issueId: (await node(number)).id, body } });
    },

    async create(issue): Promise<TrackerCreatedIssue> {
      const info = await teamInfo();
      const wanted = issue.state;
      const state = wanted === undefined ? undefined : info.states.find((candidate) => candidate.name === wanted);
      // The issue is created either way: a state Linear does not have is a
      // warning, never a reason to lose the number of an issue that now exists.
      const warning = wanted !== undefined && state === undefined ? `Linear team ${key} has no workflow state named '${wanted}'` : null;
      // Every listing narrows to the scope label, so an issue opened without it
      // would exist and never be read again: not listed, never offered to a loop.
      // The scope label is the adapter's own, not the caller's: a caller
      // ensures the labels it names, but none of them knows to ensure this
      // one, so a scoped team that has never seen it would refuse every
      // filing. It is ensured here, before anything is opened.
      if (options.scopeLabel !== null && (await ensureLabels([options.scopeLabel])).missing.length > 0) {
        throw new LinearError(`Linear team ${key} cannot create the scope label '${options.scopeLabel}'; nothing was opened`, 200, "NO_LABEL");
      }
      const labels = [...new Set([...(issue.labels ?? []), ...(options.scopeLabel === null ? [] : [options.scopeLabel])])];
      const labelIds: string[] = [];
      for (const label of labels) labelIds.push(await labelId(label));
      const answer = await send<{ issueCreate: { issue: { number: number } } }>(CREATE_ISSUE, {
        input: {
          teamId: info.id,
          title: issue.title,
          description: issue.body,
          ...(labelIds.length === 0 ? {} : { labelIds }),
          ...(state === undefined ? {} : { stateId: state.id }),
        },
      });
      const number = answer.issueCreate.issue.number;
      return { number, url: `https://linear.app/${options.workspace}/issue/${ref(number)}`, movedTo: state?.name ?? null, warning };
    },

    async editBody(number, body) {
      await write(UPDATE_ISSUE, { id: (await node(number)).id, input: { description: body } });
    },

    async cancel(number) {
      let to: string;
      let misconfigured: string | null = null;
      try {
        const info = await teamInfo();
        // The name an operator configured wins; otherwise the team's own
        // `canceled`-TYPE state, whatever it is called ("Cancelled", "Won't do").
        const named = states.canceled === undefined ? undefined : info.states.find((candidate) => candidate.name === states.canceled);
        const state = named ?? info.states.find((candidate) => candidate.type === "canceled");
        if (state === undefined) return { movedTo: null, warning: `Linear team ${key} has no canceled state to close ${ref(number)} into` };
        // A configured name the team does not have is a typo in the project's
        // config, and every other configured state reports one. Cancelling into
        // the type's state anyway beats leaving routed work open, so it is a
        // warning ON a move that happened, not instead of one.
        if (states.canceled !== undefined && named === undefined) {
          misconfigured = `Linear team ${key} has no workflow state named '${states.canceled}'; cancelled into '${state.name}' instead`;
        }
        to = state.name;
      } catch (error) {
        return { movedTo: null, warning: `cancelling ${ref(number)} failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      const moved = await move(number, to);
      return moved.warning === null && misconfigured !== null ? { ...moved, warning: misconfigured } : moved;
    },

    async reopen(number) {
      const info = await teamInfo();
      const issue = await node(number);
      // Only a closed-type state is reopened: an open issue, wherever it sits
      // in the workflow, is already where the loops can see it.
      if (!CLOSED_TYPES.includes(issue.state.type)) return { movedTo: null, warning: null };
      // Back to the team's own "not started" state, whatever it is called;
      // a team without one parks reopened work in its backlog.
      const state = info.states.find((candidate) => candidate.type === "unstarted") ?? info.states.find((candidate) => candidate.type === "backlog");
      if (state === undefined) return { movedTo: null, warning: `${ref(number)} has no unstarted state to reopen into` };
      await write(UPDATE_ISSUE, { id: issue.id, input: { stateId: state.id } });
      return { movedTo: state.name, warning: null };
    },

    async findByBodyMarker(marker, { state = "all", limit = 25 } = {}): Promise<TrackerIssueSummary[]> {
      const page = await read<{ issues: { nodes: { number: number; title: string; description: string | null }[] } }>(MARKER_QUERY, {
        filter: filter(state === "all" ? null : state === "closed", undefined, marker),
        first: Math.min(limit, 250),
      });
      // Re-checked here as every adapter does, so one tracker's looser search
      // can never be the reason a retry decides it already created the issue.
      return page.issues.nodes
        .filter((issue) => (issue.description ?? "").includes(marker))
        .map(({ number, title }) => ({ number, title }));
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

    ensureLabels,

    workflowStates: async () => (await teamInfo()).states.map((state) => state.name),

    classifyFailure: (error) => classifyLinearFailure(error),
  };
}
