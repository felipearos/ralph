/**
 * The GitHub issues adapter: today's `gh` calls behind the `Tracker`
 * interface (felipearos/ralph#330).
 *
 * It must behave exactly as the direct calls it replaces, because every
 * existing project runs on it. The census is the one paginated GraphQL read
 * the frontier already made (`readOpenIssuesWithBlockers`, moved here from
 * `frontier/next-tasks.ts`, which re-exports it); the rest are the `gh issue`
 * commands the supervisor, the prompts and the controls run today, pinned to
 * the project's repo with `--repo` so the adapter answers the same from any
 * directory.
 */
import type { IssueComment } from "../block-reason";
import {
  classifyRateLimit,
  parseIncluded,
  retryPolicy,
  withRateLimitRetry,
  type RateLimitSignal,
  type RetryBudget,
} from "../frontier/github-rate-limit";
import { CommandError, run } from "./command";
import {
  TrackerIssueNotFoundError,
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

/** An open issue as the census query returns it, in the shape `frontier/next-tasks.ts` calls `RawIssue`. */
export interface GithubRawIssue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
  assignees?: { login: string }[];
  author?: { login: string } | null;
  comments?: IssueComment[];
}

export type GithubBlocker = TrackerBlocker;

/** Whether a failed `gh` read was GitHub throttling — see `github-rate-limit.ts`. */
export function classifyGhFailure(
  error: unknown,
  nowSeconds: number = Date.now() / 1000,
): RateLimitSignal | null {
  const message = error instanceof Error ? error.message : String(error);
  const stdout = error instanceof CommandError ? error.stdout : "";
  return classifyRateLimit(message, stdout === "" ? null : parseIncluded(stdout), nowSeconds);
}

/**
 * Native dependencies, INCLUDING closed ones — a closed blocker is what proves
 * a tree is already in progress, so filtering to open at the API would blind
 * the ordering rule.
 *
 * A 404/410 means this repo carries no dependency data, which is a legitimate
 * degradation to prose-only edges. Every other failure is re-thrown: silently
 * returning "no blockers" would promote a blocked ticket into READY NOW, and a
 * tool whose whole value is truthful readiness must not fail in that direction.
 */
export function classifyDependencyFailure(
  message: string,
): "no-dependency-data" | "fatal" {
  return message.includes("HTTP 404") || message.includes("HTTP 410")
    ? "no-dependency-data"
    : "fatal";
}

/** The open-issue census bound; also `gh issue list --limit` before it went to GraphQL. */
const OPEN_ISSUE_CENSUS_LIMIT = 500;
const GRAPHQL_PAGE = 100;
/**
 * How much of each thread the census carries. The triager reads comments for
 * two things — its own marker, and whether anyone answered it since — and both
 * are at the END of the thread. It costs nothing extra in requests: it rides
 * the census query that was already being made, which is what keeps a triager's
 * poll as cheap as a coder's.
 *
 * A marker older than this tail reads as absent, and the issue comes back to
 * the intake bucket. That is the safe direction — re-triaging an issue costs a
 * marker, where missing one costs a ticket nobody ever looks at — but it does
 * mean an issue with twenty comments since its triage will be offered again.
 */
const COMMENT_TAIL = 20;

/**
 * The open issues and their native blockers in one paginated GraphQL read.
 *
 * It used to be `gh issue list` plus one REST `dependencies/blocked_by` call
 * per open issue: ~120 requests per frontier read against Loggd's backlog,
 * made by four loops and their gates every few minutes on one account. That
 * fan-out is what GitHub throttled on 2026-09-28. This is one request per 100
 * issues, and the blockers come from the same snapshot as the issues.
 *
 * Ordered newest first, like `gh issue list`. A ticket with more blockers than
 * one page carries is left out of `natives`, and `readFrontierInputs` reads it
 * the old way rather than trusting a truncated list.
 */
export const OPEN_ISSUES_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: ${GRAPHQL_PAGE}, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title body
        author { login }
        labels(first: 100) { nodes { name } }
        assignees(first: 100) { nodes { login } }
        comments(last: ${COMMENT_TAIL}) { nodes { body createdAt } }
        blockedBy(first: 100) { totalCount nodes { number state } }
      }
    }
  }
}`;

interface GraphQlIssue {
  number: number;
  title: string;
  body: string;
  author: { login: string } | null;
  labels: { nodes: { name: string }[] };
  assignees: { nodes: { login: string }[] };
  /** Optional because a census read from a stub or an older schema may omit it. */
  comments?: { nodes: { body: string; createdAt: string }[] };
  blockedBy: { totalCount: number; nodes: { number: number; state: string }[] };
}

export async function readOpenIssuesWithBlockers(
  io: { gh(args: string[]): Promise<string> },
  repo?: string,
): Promise<{ raw: GithubRawIssue[]; natives: Map<number, GithubBlocker[]> }> {
  const raw: GithubRawIssue[] = [];
  const natives = new Map<number, GithubBlocker[]>();
  // Without a repo, gh fills the placeholders from the checkout it runs in.
  const [owner, name] = repo === undefined ? ["{owner}", "{repo}"] : repo.split("/");
  let after: string | null = null;
  while (raw.length < OPEN_ISSUE_CENSUS_LIMIT) {
    const args = ["api", "graphql", "--include", "-F", `owner=${owner}`, "-F", `name=${name}`];
    // One line: argv loggers (and people reading `ps`) see one call, not twelve.
    args.push("-f", `query=${OPEN_ISSUES_QUERY.replace(/\s+/g, " ")}`);
    if (after !== null) args.push("-f", `after=${after}`);
    const page = JSON.parse(parseIncluded(await io.gh(args)).body) as {
      data?: {
        repository?: {
          issues?: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GraphQlIssue[] };
        };
      };
    };
    const issues = page.data?.repository?.issues;
    if (issues === undefined) throw new Error("the open-issue census returned no issues connection");
    for (const node of issues.nodes) {
      if (raw.length >= OPEN_ISSUE_CENSUS_LIMIT) break;
      raw.push({
        number: node.number,
        title: node.title,
        body: node.body,
        labels: node.labels.nodes,
        assignees: node.assignees.nodes,
        author: node.author,
        comments: node.comments?.nodes ?? [],
      });
      if (node.blockedBy.nodes.length >= node.blockedBy.totalCount) {
        natives.set(
          node.number,
          node.blockedBy.nodes.map((b) => ({
            number: b.number,
            state: b.state.toLowerCase() === "closed" ? "closed" : "open",
          })),
        );
      }
    }
    if (!issues.pageInfo.hasNextPage || issues.pageInfo.endCursor === null) break;
    after = issues.pageInfo.endCursor;
  }
  return { raw, natives };
}

/** The closed-issue census bound: past it the oldest children fall out, and the frontier reports that. */
export const CLOSED_ISSUE_CENSUS_LIMIT = 1000;

export interface GithubTrackerOptions {
  /** `owner/name`. */
  repo: string;
  /** The login `assign` uses when none is named: `gh` cannot resolve `@me` for assignment. */
  owner: string;
  /**
   * Whether every command names the repo with `--repo` (the default). The
   * frontier runs unpinned, from inside the project's checkout, so its argv
   * stays exactly what it was before the seam and gh resolves the repo from
   * the remote the way it always has.
   */
  pinned?: boolean;
  /** Writes. Never retried behind the caller's back. */
  gh?: (args: string[]) => Promise<string>;
  /** Reads. Defaults to `gh` with the frontier's rate-limit retry and budget. */
  read?: (args: string[]) => Promise<string>;
}

/** `gh` with the rate-limit retry every frontier read gets, sharing one budget per adapter. */
function retryingRead(gh: (args: string[]) => Promise<string>): (args: string[]) => Promise<string> {
  const budget: RetryBudget = { waitedSeconds: 0 };
  const deps = {
    sleep: (seconds: number): Promise<void> => new Promise((done) => setTimeout(done, seconds * 1000)),
    random: Math.random,
  };
  return (args) => withRateLimitRetry(() => gh(args), classifyGhFailure, deps, retryPolicy(), budget);
}

/**
 * The issue number in gh's "that issue does not exist" failure, or null for
 * any other failure. GitHub words it "issue" or "issue or pull request"
 * depending on the command.
 */
export function missingIssueNumber(message: string): number | null {
  const found = /Could not resolve to an issue(?: or pull request)? with the number of ([0-9]+)/.exec(message);
  return found === null ? null : Number(found[1]);
}

/**
 * `call` with gh's missing-issue failure raised as `TrackerIssueNotFoundError`.
 * It wraps the call from outside, after any rate-limit retry, so a throttle
 * still surfaces as itself; every other failure is rethrown unchanged.
 *
 * Only a call aimed at one issue (`issue <verb> <n>`) is translated, and only
 * when gh's own text names that same number: `run` puts the whole argv in the
 * message, so a comment or title quoting the phrase must not turn an
 * unrelated failure (a 502, a throttle on a write) into "no issue".
 */
function namingMissingIssues(
  call: (args: string[]) => Promise<string>,
  repo: string,
): (args: string[]) => Promise<string> {
  return async (args) => {
    try {
      return await call(args);
    } catch (error) {
      const target = args[0] === "issue" && /^[1-9][0-9]*$/.test(args[2] ?? "") ? Number(args[2]) : null;
      if (target === null) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const command = `gh ${args.join(" ")} failed: `;
      const said = message.startsWith(command) ? message.slice(command.length) : message;
      if (missingIssueNumber(said) !== target) throw error;
      throw new TrackerIssueNotFoundError(`#${target}`, repo, { cause: error });
    }
  };
}

interface GhIssueView {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: { name: string }[];
  assignees: { login: string }[];
  author: { login: string } | null;
  url: string;
  /** Null, or an empty string on some gh versions, while the issue is open. */
  closedAt?: string | null;
  /** `COMPLETED`, `NOT_PLANNED` or `DUPLICATE` once closed; null or empty while open. */
  stateReason?: string | null;
  comments: (IssueComment & { author?: { login: string } | null })[];
}

export function createGithubTracker(options: GithubTrackerOptions): Tracker {
  const { repo } = options;
  const pinned = options.pinned ?? true;
  const repoFlag = pinned ? ["--repo", repo] : [];
  const apiRepo = pinned ? repo : "{owner}/{repo}";
  const rawGh = options.gh ?? ((args: string[]) => run("gh", args));
  // The retry wraps the raw gh, and the missing-issue translation wraps the
  // retry: classifying after the retry keeps a throttle a throttle.
  const gh = namingMissingIssues(rawGh, repo);
  const read = namingMissingIssues(options.read ?? retryingRead(rawGh), repo);
  const readJson = async <T>(args: string[]): Promise<T> => JSON.parse(await read(args)) as T;
  const onIssue = (verb: string, number: number, ...rest: string[]): string[] => [
    "issue",
    verb,
    String(number),
    ...repoFlag,
    ...rest,
  ];

  const labelsOf = async (number: number): Promise<string[]> =>
    (await readJson<{ labels: { name: string }[] }>(onIssue("view", number, "--json", "labels"))).labels.map(
      (label) => label.name,
    );

  /**
   * The REST read for a ticket whose blockers overflowed the census page. A
   * 404/410 is a repo without dependency data; anything else is re-thrown,
   * because "no blockers" would promote a blocked ticket.
   */
  const restBlockers = async (number: number): Promise<TrackerBlocker[]> => {
    try {
      const body = parseIncluded(
        await read(["api", "--include", `repos/${apiRepo}/issues/${number}/dependencies/blocked_by`, "--jq", "[.[] | {number, state}]"]),
      ).body;
      return (JSON.parse(body || "[]") as { number: number; state: string }[]).map((blocker) => ({
        number: blocker.number,
        state: blocker.state.toLowerCase() === "closed" ? "closed" : "open",
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (classifyDependencyFailure(message) === "no-dependency-data") return [];
      throw error;
    }
  };

  const addLabels = async (number: number, labels: readonly string[]): Promise<void> => {
    if (labels.length === 0) return;
    await gh(onIssue("edit", number, "--add-label", labels.join(",")));
  };
  // `gh` fails removing a label that is not there, so only the present ones go.
  const removeLabels = async (number: number, labels: readonly string[], present?: readonly string[]): Promise<void> => {
    const carried = present ?? (await labelsOf(number));
    const removable = labels.filter((label) => carried.includes(label));
    if (removable.length === 0) return;
    await gh(onIssue("edit", number, "--remove-label", removable.join(",")));
  };
  const none: TrackerTransition = { movedTo: null, warning: null };

  return {
    kind: "github",
    ref: (number) => `#${number}`,
    url: (number) => `https://github.com/${repo}/issues/${number}`,

    async openIssues(): Promise<TrackerIssue[]> {
      const { raw, natives } = await readOpenIssuesWithBlockers({ gh: read }, pinned ? repo : undefined);
      // A ticket with more blockers than one census page carries is read the
      // old way rather than trusted truncated. They are rare, so one at a time.
      for (const issue of raw) {
        if (!natives.has(issue.number)) natives.set(issue.number, await restBlockers(issue.number));
      }
      return raw.map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        labels: issue.labels.map((label) => label.name),
        assignees: (issue.assignees ?? []).map((assignee) => assignee.login),
        author: issue.author?.login ?? null,
        parent: null,
        blockers: natives.get(issue.number)!,
        comments: issue.comments ?? [],
      }));
    },

    closedIssues: () =>
      readJson<TrackerClosedIssue[]>([
        "issue",
        "list",
        ...repoFlag,
        "--state",
        "closed",
        "--limit",
        String(CLOSED_ISSUE_CENSUS_LIMIT),
        "--json",
        "number,title,body",
      ]),

    async issue(number): Promise<TrackerIssueDetail> {
      const view = await readJson<GhIssueView>(
        onIssue("view", number, "--json", "number,title,body,state,labels,assignees,author,url,closedAt,stateReason,comments"),
      );
      return {
        number: view.number,
        title: view.title,
        body: view.body,
        state: view.state.toUpperCase() === "CLOSED" ? "closed" : "open",
        status: view.state.toUpperCase(),
        labels: view.labels.map((label) => label.name),
        assignees: view.assignees.map((assignee) => assignee.login),
        author: view.author?.login ?? null,
        url: view.url,
        closedAt: view.closedAt || null,
        // A closed issue with no reason (closed before GitHub recorded one, or by a merge) was finished.
        closedAs:
          view.state.toUpperCase() !== "CLOSED"
            ? null
            : view.stateReason === "NOT_PLANNED" || view.stateReason === "DUPLICATE"
              ? "canceled"
              : "completed",
        // GitHub links PRs itself, but `live()` reads those; the detail view lists none.
        pullRequests: [],
        comments: view.comments.map((comment) => ({
          body: comment.body,
          createdAt: comment.createdAt,
          author: comment.author?.login ?? null,
        })),
      };
    },

    async live(number): Promise<TrackerLiveIssue> {
      const view = await readJson<{
        assignees: { login: string }[];
        labels: { name: string }[];
        closedByPullRequestsReferences?: { number: number }[];
        state?: string;
      }>(onIssue("view", number, "--json", "assignees,labels,closedByPullRequestsReferences,state"));
      return {
        assignees: view.assignees.map((assignee) => assignee.login),
        labels: view.labels.map((label) => label.name),
        linkedPullRequests: (view.closedByPullRequestsReferences ?? []).map((ref) => ref.number),
        // A view without a state (an older gh, a stub) reads as open: the
        // claim then decides on the fields it always had, never a refusal.
        state: view.state?.toUpperCase() === "CLOSED" ? "closed" : "open",
        // Deliberately "" unlike issue(): GitHub has no workflow status beyond
        // open and closed, and the claim's refusal names only a real status.
        status: "",
      };
    },

    async comments(number) {
      const { comments } = await readJson<{ comments: IssueComment[] }>(onIssue("view", number, "--json", "comments"));
      return comments.map((comment) => ({ body: comment.body, createdAt: comment.createdAt }));
    },

    withLabel: (label, { state = "open", limit = 100, updatedSince } = {}) =>
      readJson<TrackerIssueSummary[]>([
        "issue",
        "list",
        ...repoFlag,
        "--state",
        state,
        "--label",
        label,
        "--limit",
        String(limit),
        // GitHub's search qualifier takes a second-precision UTC time, not milliseconds.
        ...(updatedSince === undefined ? [] : ["--search", `updated:>=${new Date(updatedSince).toISOString().replace(/\.\d{3}Z$/, "Z")}`]),
        "--json",
        "number,title",
      ]),

    addLabels,
    removeLabels: (number, labels) => removeLabels(number, labels),

    async assign(number, login = options.owner) {
      await gh(onIssue("edit", number, "--add-assignee", login));
    },

    async comment(number, body) {
      await gh(onIssue("comment", number, "--body", body));
    },

    async create(issue): Promise<TrackerCreatedIssue> {
      const printed = await gh([
        "issue",
        "create",
        ...repoFlag,
        "--title",
        issue.title,
        "--body",
        issue.body,
        ...(issue.labels === undefined || issue.labels.length === 0 ? [] : ["--label", issue.labels.join(",")]),
      ]);
      // `gh issue create` prints the new issue's URL and nothing else.
      const created = /\/issues\/([0-9]+)\s*$/.exec(printed.trim());
      if (created === null) throw new Error(`gh issue create printed no issue URL: ${printed.trim().slice(0, 200)}`);
      const number = Number(created[1]);
      // `issue.state` is ignored: GitHub issues have no workflow states, which
      // the interface calls out, so it is not a warning either.
      return { number, url: `https://github.com/${repo}/issues/${number}`, ...none };
    },

    async editBody(number, body) {
      await gh(onIssue("edit", number, "--body", body));
    },

    async cancel(number) {
      const { state } = await readJson<{ state: string }>(onIssue("view", number, "--json", "state"));
      // Closing a closed issue fails, exactly as `done` has to allow for.
      if (state.toUpperCase() !== "CLOSED") await gh(onIssue("close", number, "--reason", "not planned"));
      return none;
    },

    async reopen(number) {
      const { state } = await readJson<{ state: string }>(onIssue("view", number, "--json", "state"));
      // Reopening an open issue fails, the mirror of `cancel`'s guard.
      if (state.toUpperCase() === "CLOSED") await gh(onIssue("reopen", number));
      return none;
    },

    async findByBodyMarker(marker, { state = "all", limit = 25 } = {}): Promise<TrackerIssueSummary[]> {
      const found = await readJson<{ number: number; title: string; body: string }[]>([
        "issue",
        "list",
        ...repoFlag,
        "--state",
        state,
        "--search",
        `${marker} in:body`,
        "--limit",
        String(limit),
        "--json",
        "number,title,body",
      ]);
      // GitHub's issue search tokenises and folds case, so it answers with near
      // misses too: the exact substring is checked here, not trusted from the index.
      // Its order is relevance, not recency, so "newest first" is made true here
      // as well — issue numbers rise with creation.
      return found
        .filter((issue) => issue.body.includes(marker))
        .sort((a, b) => b.number - a.number)
        .map(({ number, title }) => ({ number, title }));
    },

    async claim(number, claimLabel) {
      await addLabels(number, [claimLabel]);
      return none;
    },

    async done(number, doneLabel) {
      const view = await readJson<{ state: string; labels: { name: string }[] }>(
        onIssue("view", number, "--json", "state,labels"),
      );
      const labels = view.labels.map((label) => label.name);
      // The merge usually closed it through `Closes #n`; closing again would fail.
      if (view.state.toUpperCase() !== "CLOSED") await gh(onIssue("close", number));
      await removeLabels(number, wipLabelsOn(labels), labels);
      await addLabels(number, [doneLabel]);
      return none;
    },

    async handoff(number, doneLabel) {
      const labels = await labelsOf(number);
      await removeLabels(number, wipLabelsOn(labels), labels);
      await addLabels(number, [doneLabel]);
      return none;
    },

    async blocked(number, stuckLabel) {
      const labels = await labelsOf(number);
      await removeLabels(number, wipLabelsOn(labels), labels);
      await addLabels(number, [stuckLabel]);
      return none;
    },

    async ensureLabels(labels) {
      const existing = new Set(
        (await readJson<{ name: string }[]>(["label", "list", ...repoFlag, "--limit", "1000", "--json", "name"])).map(
          (label) => label.name,
        ),
      );
      const created: string[] = [];
      const missing: string[] = [];
      for (const label of labels) {
        if (existing.has(label)) continue;
        try {
          await gh(["label", "create", label, ...repoFlag]);
          created.push(label);
        } catch {
          missing.push(label);
        }
      }
      return { created, missing };
    },

    classifyFailure: (error, nowSeconds) => classifyGhFailure(error, nowSeconds),
  };
}
