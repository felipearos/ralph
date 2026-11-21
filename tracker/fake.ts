/**
 * An in-memory tracker for tests (felipearos/ralph#330).
 *
 * It has two shapes. A GitHub-shaped fake numbers issues `#n`, has no workflow
 * states, and links PRs to issues itself. A keyed fake (Linear- or Jira-shaped)
 * numbers them `<KEY>-n`, moves a claimed issue to its claimed state and a
 * finished one to its done state, and links no PRs, the way a tracker that
 * cannot see GitHub behaves. Loop code tested against both shapes is tested
 * against the semantics every adapter must give it; `contract.ts` holds the
 * same fake to the same suite as the real adapters.
 */
import type { IssueComment } from "../block-reason";
import type { RateLimitSignal } from "../frontier/github-rate-limit";
import {
  TrackerIssueNotFoundError,
  wipLabelsOn,
  type Tracker,
  type TrackerIssueDetail,
  type TrackerIssueSummary,
  type TrackerKind,
  type TrackerTransition,
} from "./types";

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  /** Workflow state on a keyed fake; `OPEN`/`CLOSED` on a GitHub-shaped one. */
  status: string;
  /** When it was closed (ISO 8601); absent or null while open, and on a closed issue seeded without one. */
  closedAt?: string | null;
  /** When it was last updated (ISO 8601); absent reads as `closedAt`, and an issue with neither is kept by any `updatedSince`. */
  updatedAt?: string | null;
  /** How it was closed; absent on a closed issue reads as completed, and `cancel()` sets canceled. */
  closedAs?: "completed" | "canceled" | null;
  labels: string[];
  assignees: string[];
  author: string | null;
  parent: number | null;
  blockers: number[];
  comments: IssueComment[];
  linkedPullRequests: number[];
  /** PR URLs the tracker links to the issue, as `issue()` lists them; on every shape, since Linear lists them too. */
  pullRequests: string[];
}

export interface FakeTrackerOptions {
  kind?: TrackerKind;
  /** The team or project key of a keyed fake. Required unless `kind` is `github`. */
  key?: string;
  /** The states a keyed fake moves claimed, finished and cancelled issues to. */
  states?: { claimed: string; done: string; canceled?: string; review?: string };
  /** The workflow states the tracker has; a move to any other one fails with a warning. */
  workflow?: string[];
  /** Labels that already exist. A Jira-shaped fake treats labels as free-form and ignores this. */
  labels?: string[];
  /**
   * Labels `ensureLabels` cannot create (GitHub without the permission, a
   * Linear team that refuses it): reported in `missing` and never added, so a
   * test can drive a caller's refusal path. A label that already exists is
   * not affected.
   */
  uncreatableLabels?: string[];
  /** Who `assign()` with no login assigns. */
  self?: string;
  issues?: (Partial<FakeIssue> & { number: number })[];
}

/** The fake plus what a test needs to arrange and inspect it. */
export interface FakeTracker extends Tracker {
  readonly issues: Map<number, FakeIssue>;
  readonly existingLabels: Set<string>;
  /** Every write, in order, as `<op> <number> <detail>`. */
  readonly writes: string[];
  /** The next call to `op` throws `error`. */
  failNext(op: keyof Tracker, error: Error): void;
  /** Add or replace an issue. */
  put(issue: Partial<FakeIssue> & { number: number }): FakeIssue;
}

/** The throttle signal a fake raises: an error carrying it. */
export class FakeThrottle extends Error {
  constructor(readonly signal: RateLimitSignal) {
    super(`fake tracker throttled (${signal.kind})`);
  }
}

export function createFakeTracker(options: FakeTrackerOptions = {}): FakeTracker {
  const kind = options.kind ?? "github";
  const keyed = kind !== "github";
  if (keyed && !options.key) throw new Error(`a ${kind}-shaped fake tracker needs a key`);
  const states = options.states ?? { claimed: "In Progress", done: "Done" };
  const canceled = states.canceled ?? "Canceled";
  const workflow = options.workflow ?? ["Todo", states.claimed, ...(states.review === undefined ? [] : [states.review]), states.done, canceled];
  const freeFormLabels = kind === "jira";
  const issues = new Map<number, FakeIssue>();
  const existingLabels = new Set(options.labels ?? []);
  const uncreatable = new Set(options.uncreatableLabels ?? []);
  const writes: string[] = [];
  const failures = new Map<string, Error>();

  const put = (issue: Partial<FakeIssue> & { number: number }): FakeIssue => {
    const state = issue.state ?? "open";
    const full: FakeIssue = {
      title: `Issue ${issue.number}`,
      body: "",
      status: keyed ? (state === "closed" ? states.done : workflow[0]!) : state.toUpperCase(),
      labels: [],
      assignees: [],
      author: null,
      parent: null,
      blockers: [],
      comments: [],
      linkedPullRequests: [],
      pullRequests: [],
      ...issue,
      state,
    };
    issues.set(full.number, full);
    return full;
  };
  for (const issue of options.issues ?? []) put(issue);

  const trip = (op: string): void => {
    const error = failures.get(op);
    if (error !== undefined) {
      failures.delete(op);
      throw error;
    }
  };
  const get = (number: number): FakeIssue => {
    const issue = issues.get(number);
    if (issue === undefined) throw new TrackerIssueNotFoundError(ref(number), where);
    return issue;
  };
  // Where a missing issue was looked for: the repo its GitHub-shaped url()
  // names, or a keyed fake's team or project key.
  const where = kind === "github" ? "fake/repo" : (options.key ?? kind);
  const ref = (number: number): string => (keyed ? `${options.key}-${number}` : `#${number}`);
  const url = (number: number): string =>
    kind === "github"
      ? `https://github.com/fake/repo/issues/${number}`
      : kind === "linear"
        ? `https://linear.app/fake/issue/${ref(number)}`
        : kind === "local"
          ? // `.invalid` never resolves (RFC 6761): a local ticket has no page, but callers expect an https link.
            `https://local.invalid/${options.key}/${ref(number)}`
          : `https://fake.atlassian.net/browse/${ref(number)}`;

  const addLabels = (issue: FakeIssue, labels: readonly string[]): void => {
    for (const label of labels) {
      if (!issue.labels.includes(label)) issue.labels.push(label);
      if (freeFormLabels) existingLabels.add(label);
    }
  };
  const removeLabels = (issue: FakeIssue, labels: readonly string[]): void => {
    issue.labels = issue.labels.filter((label) => !labels.includes(label));
  };
  /** A keyed fake's state move; a move to a state the workflow lacks is a warning, not a throw. */
  const move = (issue: FakeIssue, to: string): TrackerTransition => {
    if (!keyed) return { movedTo: null, warning: null };
    if (!workflow.includes(to)) return { movedTo: null, warning: `no workflow state named '${to}'` };
    issue.status = to;
    writes.push(`move ${issue.number} ${to}`);
    return { movedTo: to, warning: null };
  };

  /** Every write that closes an issue goes through here, so its close time is stamped once, when it closed. */
  const close = (issue: FakeIssue, as: "completed" | "canceled"): void => {
    if (issue.state === "closed") return;
    issue.state = "closed";
    issue.closedAt = new Date().toISOString();
    issue.updatedAt = issue.closedAt;
    issue.closedAs = as;
  };

  const fake: FakeTracker = {
    kind,
    issues,
    existingLabels,
    writes,
    put,
    failNext: (op, error) => void failures.set(op, error),
    ref,
    url,

    async openIssues() {
      trip("openIssues");
      return [...issues.values()]
        .filter((issue) => issue.state === "open")
        .sort((a, b) => b.number - a.number)
        .map((issue) => ({
          number: issue.number,
          title: issue.title,
          body: issue.body,
          labels: [...issue.labels],
          assignees: [...issue.assignees],
          author: issue.author,
          parent: issue.parent,
          blockers: issue.blockers.map((number) => ({ number, state: issues.get(number)?.state ?? "open" })),
          comments: issue.comments.slice(-20),
        }));
    },

    async closedIssues() {
      trip("closedIssues");
      return [...issues.values()]
        .filter((issue) => issue.state === "closed")
        .sort((a, b) => b.number - a.number)
        .map(({ number, title, body }) => ({ number, title, body }));
    },

    async issue(number): Promise<TrackerIssueDetail> {
      trip("issue");
      const issue = get(number);
      return {
        number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        status: issue.status,
        labels: [...issue.labels],
        assignees: [...issue.assignees],
        author: issue.author,
        url: url(number),
        closedAt: issue.state === "closed" ? (issue.closedAt ?? null) : null,
        closedAs: issue.state === "closed" ? (issue.closedAs ?? "completed") : null,
        pullRequests: [...new Set(issue.pullRequests)],
        comments: [...issue.comments],
      };
    },

    async live(number) {
      trip("live");
      const issue = get(number);
      return {
        assignees: [...issue.assignees],
        labels: [...issue.labels],
        linkedPullRequests: keyed ? [] : [...issue.linkedPullRequests],
        state: issue.state,
        // A GitHub-shaped fake has no workflow status, as GitHub has none.
        status: keyed ? issue.status : "",
      };
    },

    async comments(number) {
      trip("comments");
      return [...get(number).comments];
    },

    async withLabel(label, { state = "open", limit = 100, updatedSince } = {}) {
      trip("withLabel");
      // An issue with no known update time is kept: a superset, never a subset.
      const recent = (issue: FakeIssue): boolean => {
        const at = issue.updatedAt ?? issue.closedAt ?? null;
        return updatedSince === undefined || at === null || Date.parse(at) >= Date.parse(updatedSince);
      };
      return [...issues.values()]
        .filter((issue) => issue.labels.includes(label) && (state === "all" || issue.state === state) && recent(issue))
        .sort((a, b) => b.number - a.number)
        .slice(0, limit)
        .map(({ number, title }) => ({ number, title }));
    },

    async addLabels(number, labels) {
      trip("addLabels");
      addLabels(get(number), labels);
      writes.push(`label+ ${number} ${labels.join(",")}`);
    },

    async removeLabels(number, labels) {
      trip("removeLabels");
      removeLabels(get(number), labels);
      writes.push(`label- ${number} ${labels.join(",")}`);
    },

    async assign(number, login) {
      trip("assign");
      const who = login ?? options.self ?? "fake-self";
      const issue = get(number);
      if (!issue.assignees.includes(who)) issue.assignees.push(who);
      writes.push(`assign ${number} ${who}`);
    },

    async comment(number, body) {
      trip("comment");
      get(number).comments.push({ body, createdAt: new Date().toISOString() });
      writes.push(`comment ${number}`);
    },

    async create(issue) {
      trip("create");
      // Deterministic, so a test can name the number it is about to get.
      const number = Math.max(0, ...issues.keys()) + 1;
      const created = put({ number, title: issue.title, body: issue.body });
      addLabels(created, issue.labels ?? []);
      writes.push(`create ${number}`);
      const transition = issue.state === undefined ? { movedTo: null, warning: null } : move(created, issue.state);
      return { number, url: url(number), ...transition };
    },

    async editBody(number, body) {
      trip("editBody");
      get(number).body = body;
      writes.push(`editBody ${number}`);
    },

    async cancel(number) {
      trip("cancel");
      const issue = get(number);
      if (!keyed) {
        close(issue, "canceled");
        issue.status = "CLOSED";
        writes.push(`cancel ${number}`);
        return { movedTo: null, warning: null };
      }
      const transition = move(issue, canceled);
      // On a keyed tracker the state move IS the close, so a move that failed
      // leaves the issue open — as Linear and Jira leave it — and `writes` is
      // what happened, not what was asked for.
      if (transition.movedTo !== null) {
        close(issue, "canceled");
        writes.push(`cancel ${number}`);
      }
      return transition;
    },

    async reopen(number) {
      trip("reopen");
      const issue = get(number);
      if (issue.state === "open") return { movedTo: null, warning: null };
      issue.state = "open";
      issue.closedAt = null;
      issue.closedAs = null;
      issue.updatedAt = new Date().toISOString();
      // A keyed tracker reopens by moving back to the start of its workflow.
      issue.status = keyed ? workflow[0]! : "OPEN";
      writes.push(`reopen ${number}`);
      return { movedTo: keyed ? issue.status : null, warning: null };
    },

    async findByBodyMarker(marker, { state = "all", limit = 25 } = {}): Promise<TrackerIssueSummary[]> {
      trip("findByBodyMarker");
      return [...issues.values()]
        .filter((issue) => issue.body.includes(marker) && (state === "all" || issue.state === state))
        .sort((a, b) => b.number - a.number)
        .slice(0, limit)
        .map(({ number, title }) => ({ number, title }));
    },

    async claim(number, claimLabel) {
      trip("claim");
      const issue = get(number);
      addLabels(issue, [claimLabel]);
      writes.push(`label+ ${number} ${claimLabel}`);
      return move(issue, states.claimed);
    },

    async done(number, doneLabel) {
      trip("done");
      const issue = get(number);
      removeLabels(issue, wipLabelsOn(issue.labels));
      addLabels(issue, [doneLabel]);
      close(issue, "completed");
      writes.push(`done ${number} ${doneLabel}`);
      if (!keyed) {
        issue.status = "CLOSED";
        return { movedTo: null, warning: null };
      }
      return move(issue, states.done);
    },

    async handoff(number, doneLabel) {
      trip("handoff");
      const issue = get(number);
      removeLabels(issue, wipLabelsOn(issue.labels));
      addLabels(issue, [doneLabel]);
      writes.push(`handoff ${number} ${doneLabel}`);
      return keyed && states.review !== undefined ? move(issue, states.review) : { movedTo: null, warning: null };
    },

    async blocked(number, stuckLabel) {
      trip("blocked");
      const issue = get(number);
      removeLabels(issue, wipLabelsOn(issue.labels));
      addLabels(issue, [stuckLabel]);
      writes.push(`blocked ${number} ${stuckLabel}`);
      return { movedTo: null, warning: null };
    },

    async ensureLabels(labels) {
      trip("ensureLabels");
      if (freeFormLabels) return { created: [], missing: [] };
      const absent = labels.filter((label) => !existingLabels.has(label));
      const missing = absent.filter((label) => uncreatable.has(label));
      const created = absent.filter((label) => !uncreatable.has(label));
      for (const label of created) existingLabels.add(label);
      return { created, missing };
    },

    ...(keyed ? { workflowStates: async () => [...workflow] } : {}),

    classifyFailure: (error) => (error instanceof FakeThrottle ? error.signal : null),
  };
  return fake;
}
