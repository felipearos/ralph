/**
 * The issue tracker, as the harness uses it (felipearos/ralph#330).
 *
 * Every read and write the loops make against issues is one of these
 * operations, named in tracker terms rather than as `gh` argv, so a project
 * can keep its tickets in GitHub issues, Linear or Jira and the frontier,
 * the supervisor and the prompts ask the same questions of each.
 *
 * Ticket numbers stay integers. A Linear project is pinned to one team and a
 * Jira project to one project key, so `AND-184` is ticket 184 and `OA-410`
 * is ticket 410; branch names, leases, spec files and controls keep the shape
 * they have on GitHub. `ref` renders the number the way the tracker spells it.
 *
 * What is NOT here: pull requests, checks and the base branch. Those stay on
 * GitHub whatever the tracker, and are read with `gh` as before.
 */
import type { IssueComment } from "../block-reason";
import type { RateLimitSignal } from "../frontier/github-rate-limit";

/** `local` keeps its tickets in one JSON file on the host (`tracker/local.ts`), for a project with no tracker of its own. */
export type TrackerKind = "github" | "linear" | "jira" | "local";

/** A blocker edge, with the blocker's state: a closed blocker is the trace of a finished slice. */
export interface TrackerBlocker {
  number: number;
  state: "open" | "closed";
}

/** An open issue as the census reads it. */
export interface TrackerIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
  /** Who opened it; null when the tracker did not say. */
  author: string | null;
  /** The tracker's own parent link (Linear sub-issue, Jira parent); null on GitHub, where `## Parent` prose carries it. */
  parent: number | null;
  /**
   * Native blockers, closed ones included. Null when the tracker could not
   * give the whole list in the census, so a caller never mistakes a
   * truncated list for "no blockers".
   */
  blockers: TrackerBlocker[] | null;
  /** The tail of the thread, oldest first. */
  comments: IssueComment[];
}

/** A closed issue, carried far enough to appear as a done leaf. */
export interface TrackerClosedIssue {
  number: number;
  title: string;
  body: string;
}

/** One issue read in full, open or closed: what the spec fetch and `tracker.ts view` show. */
export interface TrackerIssueDetail {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  /** The tracker's workflow state name (`In Progress`); on GitHub, `OPEN` or `CLOSED`. */
  status: string;
  labels: string[];
  assignees: string[];
  author: string | null;
  url: string;
  /** When the issue was closed (ISO 8601), whatever closed it; null while it is open or when the tracker cannot say. */
  closedAt: string | null;
  /**
   * How a closed issue was closed: finished, or dropped (cancelled, won't do,
   * a duplicate). Null while it is open. A tracker with no notion of a
   * cancelled close reports every closed issue as completed.
   */
  closedAs: "completed" | "canceled" | null;
  /**
   * URLs of the pull requests the tracker links to the issue, oldest first,
   * each once. A tracker that cannot list them reports none.
   */
  pullRequests: string[];
  /** Every comment, oldest first. */
  comments: IssueComment[];
}

/**
 * The fields a claim decision re-reads immediately before writing. Kept
 * small on purpose: two copies of "which fields does a claim need" is two
 * places for the decision to start reading a field the other does not.
 */
export interface TrackerLiveIssue {
  assignees: string[];
  labels: string[];
  /**
   * PRs the tracker links to this issue, of ANY state, so each must be
   * checked open before it refuses a claim. GitHub links them itself; a
   * tracker that cannot see GitHub reports none, and the caller reads the
   * PR census instead.
   */
  linkedPullRequests: number[];
  /**
   * Whether the issue is closed, read from the same single-issue read as the
   * claim fields: a tracker's search index can lag a status move, so this is
   * the authoritative answer a claim checks.
   */
  state: "open" | "closed";
  /** The workflow status name, or "" when the tracker has none (GitHub). */
  status: string;
}

/** An issue in a by-label listing. */
export interface TrackerIssueSummary {
  number: number;
  title: string;
}

/** What a claim, done or blocked write did beyond the labels. */
export interface TrackerTransition {
  /** The workflow state the issue moved to, or null when the tracker has none (GitHub) or nothing moved. */
  movedTo: string | null;
  /**
   * Why the state move did not happen, when it was attempted and failed.
   * The labels are the fence, so a failed move is reported, never thrown.
   */
  warning: string | null;
}

/**
 * What `create` is asked to open.
 *
 * Call `ensureLabels` first: a label the tracker does not have is refused by
 * GitHub and by Linear, and quietly invented by Jira, so `create` is not the
 * place to discover a typo'd one.
 */
export interface TrackerNewIssue {
  title: string;
  body: string;
  labels?: readonly string[];
  /** The workflow state to open it in; the tracker's own default when omitted, and ignored on a tracker without states. */
  state?: string;
}

/**
 * A created issue. It carries a `TrackerTransition` because the state move is
 * reported the same way a claim's is: the issue exists either way, and losing
 * its number over a misnamed state would be far worse than a warning.
 */
export interface TrackerCreatedIssue extends TrackerTransition {
  number: number;
  url: string;
}

export interface Tracker {
  readonly kind: TrackerKind;
  /** `#184`, `AND-184`, `OA-410`. */
  ref(number: number): string;
  url(number: number): string;

  /** Open issues, newest first, bounded by the adapter's census limit. */
  openIssues(): Promise<TrackerIssue[]>;
  /** Closed issues, bounded; past the bound the oldest fall out. */
  closedIssues(): Promise<TrackerClosedIssue[]>;
  /** One issue in full. Throws when it does not exist. */
  issue(number: number): Promise<TrackerIssueDetail>;
  live(number: number): Promise<TrackerLiveIssue>;
  /** Every comment on one issue, oldest first. */
  comments(number: number): Promise<IssueComment[]>;
  /**
   * Issues carrying `label`, newest first. With `updatedSince` (ISO 8601),
   * only issues updated at or after it, and — where the tracker can order by
   * it — the most recently updated first: an old issue closed this week must
   * not fall behind the limit just because newer ones were created after it.
   * A tracker may answer a superset (a coarser date); never a subset.
   */
  withLabel(label: string, options?: { state?: "open" | "closed" | "all"; limit?: number; updatedSince?: string }): Promise<TrackerIssueSummary[]>;

  /** Adding a label already present, or removing one that is absent, is a no-op, never an error. */
  addLabels(number: number, labels: readonly string[]): Promise<void>;
  removeLabels(number: number, labels: readonly string[]): Promise<void>;
  /** Assign to `login`, or to the credential's own user when omitted. */
  assign(number: number, login?: string): Promise<void>;
  comment(number: number, body: string): Promise<void>;

  /** The claim label, then (where the tracker has states) the claimed state. */
  claim(number: number, claimLabel: string): Promise<TrackerTransition>;
  /**
   * Finished: closed (on GitHub, only if the merge did not already close it),
   * every `*-wip` label it carries removed, and `doneLabel` added.
   */
  done(number: number, doneLabel: string): Promise<TrackerTransition>;
  /**
   * Handed to a person (`merge: "human"`): the PR is open and green and a
   * person merges it. Every `*-wip` label removed and `doneLabel` added, the
   * issue left OPEN — the merge closes it on GitHub, a person elsewhere — and,
   * where the project names a `review` state, moved to it.
   */
  handoff(number: number, doneLabel: string): Promise<TrackerTransition>;
  /** Stuck: every `*-wip` label it carries removed and `stuckLabel` added. The state is left for a human. */
  blocked(number: number, stuckLabel: string): Promise<TrackerTransition>;

  /**
   * Open a new issue (#392): what the clerk loop does with a Slack report and
   * what a triager does when it routes one to a person's tracker.
   *
   * A state the tracker does not have comes back as `warning`, never thrown,
   * for the reason `TrackerCreatedIssue` gives. A failure to create at all
   * throws, like every other write.
   */
  create(issue: TrackerNewIssue): Promise<TrackerCreatedIssue>;
  /** Replace the body, leaving the title, labels and state alone: a triager rewriting a report into a brief. */
  editBody(number: number, body: string): Promise<void>;
  /**
   * Close as Canceled — the routed-elsewhere ending, as against `done`'s
   * finished one: a `canceled`-type state on Linear, close as not planned on
   * GitHub, the configured transition on Jira.
   *
   * It only closes. The `moved-to-jira` label and the comment naming the key
   * are the caller's own calls, because which label and which words belong to
   * the pipeline, not to the seam.
   */
  cancel(number: number): Promise<TrackerTransition>;
  /**
   * Reopen a closed issue so the loops can pick it up again; an open one is
   * left as it is. Labels untouched: which label marks it for the loops is the
   * caller's call, as with `cancel`.
   */
  reopen(number: number): Promise<TrackerTransition>;
  /**
   * Issues whose BODY contains `marker`, newest first.
   *
   * This is what makes `create` safe to retry: a caller writes a marker of its
   * own into the body (a report's Slack timestamp, say) and asks this before
   * creating, so an iteration that died after the write does not open a second
   * issue. A tracker's full-text search is only a prefilter — it tokenises, and
   * Jira's `~` matches words rather than substrings — so every adapter
   * re-checks the substring itself and never reports a fuzzy match as a hit.
   *
   * Every state by default: an issue created and then cancelled is exactly the
   * one a retry must find.
   *
   * Two limits a caller has to know, because no adapter can hide them:
   *   - **Make the marker one word of letters and digits.** Every miss here
   *     costs a duplicate issue, and search syntax or punctuation is what a
   *     tokenising index mangles.
   *   - **On GitHub the answer can lag the write.** Issue search is eventually
   *     consistent, so a retry seconds after a create may not see it yet;
   *     Linear's is a database predicate and Jira's index is near-real-time.
   */
  findByBodyMarker(marker: string, options?: { state?: "open" | "closed" | "all"; limit?: number }): Promise<TrackerIssueSummary[]>;

  /** Create the labels that are missing where the tracker allows it; report what could not be. */
  ensureLabels(labels: readonly string[]): Promise<{ created: string[]; missing: string[] }>;

  /**
   * The workflow state names a claim and a finish can move to, for preflight
   * to check the configured ones against. Absent on a tracker without states
   * (GitHub) and on one that cannot list them yet.
   */
  workflowStates?(): Promise<string[]>;

  /** Whether a failed call was the tracker throttling, and how long to wait. */
  classifyFailure(error: unknown, nowSeconds?: number): RateLimitSignal | null;
}

/** A tracker that cannot be used yet: no adapter for its kind, or no credential. */
export class TrackerUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: "not-connected" | "no-adapter",
  ) {
    super(message);
    this.name = "TrackerUnavailableError";
  }
}

/**
 * The issue a call named does not exist on the tracker — a typed outcome, so
 * the CLI says "no issue #999 in acme/widgets" instead of the backend's raw
 * error text. The GitHub adapter and the fake raise it today; the Linear and
 * Jira adapters adopt it later (`ContractSetup.raisesNotFound`).
 */
export class TrackerIssueNotFoundError extends Error {
  constructor(
    /** The tracker's spelling of the issue: `#999`, `AND-999`. */
    readonly ref: string,
    /** Where it was looked for: `acme/widgets`, a team or project key. */
    readonly where: string,
    options?: ErrorOptions,
  ) {
    super(`no issue ${ref} in ${where}`, options);
    this.name = "TrackerIssueNotFoundError";
  }
}

/** The `*-wip` labels an issue carries, whichever loop wrote them. */
export const wipLabelsOn = (labels: readonly string[]): string[] => labels.filter((label) => label.endsWith("-wip"));
