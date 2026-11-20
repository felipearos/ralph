/**
 * The verifier's Sentry reader (felipearos/ralph#565, spec #560): the
 * production health and traffic evidence one check-in hands to `verdict.ts`.
 *
 * Nothing here throws, and nothing here returns half an answer: any call that
 * fails makes the whole read `reachable: false` with a one-line `why`. The
 * verdict never tickets or reverts on an unreachable source, so an outage
 * costs a quiet check-in; partial evidence read as complete could revert a
 * good deploy on an issue whose pre-deploy rate simply was not fetched.
 */
import { CALL_TIMEOUT_MS, type Fetch } from "./credentials";
import type { HealthEvidence, SentryIssue, TrafficEvidence } from "./verdict";

export type GatheredHealth = HealthEvidence & { why?: string };
export type GatheredTraffic = TrafficEvidence & { why?: string };

export interface HealthQuery {
  org: string;
  project: string;
  token: string;
  /** ISO time of the production deploy. */
  deployedAt: string;
  now: Date;
  /** The verifier's test account, so its own probes never count as impact or traffic. */
  excludeEmail: string | null;
  fetcher: Fetch;
  apiBase?: string;
}

export interface TrafficQuery extends HealthQuery {
  routes: string[];
}

const DEFAULT_API_BASE = "https://sentry.io";
const HOUR_MS = 3_600_000;

const PAGE_EXTENSIONS = /\.(tsx|ts|jsx|js)$/;

/**
 * The app routes a set of changed files serves, for Next.js-style layouts.
 * Anything it does not recognise maps to nothing: an empty list is a valid
 * answer, and the traffic read then reports "unknown", not "unused".
 */
export function routesFromFiles(files: string[]): string[] {
  const routes = new Set<string>();
  for (const raw of files) {
    const file = raw.replace(/^\.?\//, "");
    const route = appRoute(file) ?? pagesRoute(file);
    if (route !== null) routes.add(route);
  }
  return [...routes].sort();
}

function appRoute(file: string): string | null {
  const match = /^(?:src\/)?app\/(.*)$/.exec(file);
  if (match === null) return null;
  const segments = match[1]!.split("/");
  const leaf = segments.pop()!;
  if (!/^page\.(tsx|ts|jsx|js)$/.test(leaf) && !/^route\.(ts|js)$/.test(leaf)) return null;
  // A route group `(marketing)` organises files without appearing in the URL.
  const kept = segments.filter((s) => !(s.startsWith("(") && s.endsWith(")")));
  return `/${kept.join("/")}`;
}

function pagesRoute(file: string): string | null {
  const match = /^(?:src\/)?pages\/(.*)$/.exec(file);
  if (match === null || !PAGE_EXTENSIONS.test(match[1]!)) return null;
  const segments = match[1]!.replace(PAGE_EXTENSIONS, "").split("/");
  // `_app`, `_document` and the like wrap every page; they serve no route of their own.
  if (segments[segments.length - 1]!.startsWith("_")) return null;
  if (segments[segments.length - 1] === "index") segments.pop();
  return `/${segments.join("/")}`;
}

/** A failed call, carrying the one-line `why` the read reports. */
class Unreachable extends Error {}

function sentryUrl(apiBase: string, path: string, params: Record<string, string | string[]> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : [value]) search.append(key, v);
  }
  const query = search.toString();
  return `${apiBase.replace(/\/+$/, "")}${path}${query === "" ? "" : `?${query}`}`;
}

async function getJson(url: string, token: string, fetcher: Fetch, what: string): Promise<unknown> {
  return (await getPage(url, token, fetcher, what)).body;
}

/** One call's JSON body with its `Link` header, which carries Sentry's cursor to the next page. */
async function getPage(url: string, token: string, fetcher: Fetch, what: string): Promise<{ body: unknown; link: string | null }> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Unreachable(`Sentry could not be reached for ${what}: ${firstLine((error as Error)?.message ?? String(error))}`);
  }
  if (!response.ok) throw new Unreachable(`Sentry answered ${response.status} for ${what}`);
  try {
    return { body: await response.json(), link: response.headers?.get("link") ?? null };
  } catch (error) {
    throw new Unreachable(`Sentry's ${what} was not JSON: ${firstLine((error as Error)?.message ?? String(error))}`);
  }
}

interface Window {
  start: string;
  end: string;
  hours: number;
}

/** The post-deploy window and the equal-length one ending at the deploy. */
function windows(deployedAt: string, now: Date): { pre: Window; post: Window } {
  const deployed = Date.parse(deployedAt);
  const end = now.getTime();
  if (!Number.isFinite(deployed)) throw new Unreachable(`the deploy time ${JSON.stringify(deployedAt)} is not a date`);
  // An empty window would divide by zero, and "no time since the deploy" is no evidence.
  if (!(end > deployed)) throw new Unreachable(`no time has passed since the deploy at ${deployedAt}`);
  const length = end - deployed;
  const iso = (ms: number): string => new Date(ms).toISOString();
  return {
    pre: { start: iso(deployed - length), end: iso(deployed), hours: length / HOUR_MS },
    post: { start: iso(deployed), end: iso(end), hours: length / HOUR_MS },
  };
}

/**
 * The next page's URL from Sentry's `Link` header, or null when there is none:
 * Sentry always sends a `rel="next"` link and says whether it holds anything
 * with `results="true"`.
 */
export function nextPageUrl(link: string | null): string | null {
  if (link === null) return null;
  for (const part of link.split(",")) {
    const url = /<([^>]+)>/.exec(part)?.[1];
    if (url !== undefined && /rel="next"/.test(part) && /results="true"/.test(part)) return url;
  }
  return null;
}

/** How many 100-issue pages the issue list follows before it gives up. */
const MAX_ISSUE_PAGES = 5;

/**
 * A Sentry search value in double quotes: unquoted, a `]` in a dynamic
 * segment like `/users/[id]` ends a list early in Sentry's search grammar.
 */
const quoted = (value: string): string => `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

const exclusion = (email: string | null): string => (email === null || email === "" ? "" : ` !user.email:${email}`);

interface ListedIssue {
  id: string;
  title: string;
  permalink?: string;
  firstSeen: string;
}

function parseIssues(body: unknown): ListedIssue[] {
  if (!Array.isArray(body)) throw new Unreachable("Sentry's issue list was not an array");
  return body.map((item, index) => {
    const i = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    for (const field of ["id", "title", "firstSeen"]) {
      if (typeof i[field] !== "string") throw new Unreachable(`Sentry's issue list entry ${index} had no '${field}'`);
    }
    return {
      id: i.id as string,
      title: i.title as string,
      firstSeen: i.firstSeen as string,
      ...(typeof i.permalink === "string" ? { permalink: i.permalink } : {}),
    };
  });
}

interface Counts {
  count: number;
  users: number;
}

function parseCounts(body: unknown, what: string, wantUsers: boolean): Counts {
  const row = (body as { data?: unknown } | null)?.data;
  const first = Array.isArray(row) ? (row[0] as Record<string, unknown> | undefined) : undefined;
  const count = first?.["count()"];
  const users = first?.["count_unique(user)"];
  if (typeof count !== "number" || (wantUsers && typeof users !== "number")) {
    throw new Unreachable(`Sentry's ${what} had no counts`);
  }
  return { count, users: typeof users === "number" ? users : 0 };
}

async function discover(
  q: HealthQuery,
  apiBase: string,
  query: string,
  window: Window,
  fields: string[],
  what: string,
): Promise<Counts> {
  const url = sentryUrl(apiBase, `/api/0/organizations/${encodeURIComponent(q.org)}/events/`, {
    field: fields,
    query,
    start: window.start,
    end: window.end,
  });
  return parseCounts(await getJson(url, q.token, q.fetcher, what), what, fields.includes("count_unique(user)"));
}

/** Frame files and the transaction route from an issue's latest event. */
function parseLatest(body: unknown): { frameFiles: string[]; routes: string[] } {
  const event = (typeof body === "object" && body !== null ? body : {}) as {
    entries?: unknown;
    tags?: unknown;
    transaction?: unknown;
  };
  const files = new Set<string>();
  for (const entry of Array.isArray(event.entries) ? event.entries : []) {
    if (entry?.type !== "exception") continue;
    for (const value of Array.isArray(entry.data?.values) ? entry.data.values : []) {
      for (const frame of Array.isArray(value?.stacktrace?.frames) ? value.stacktrace.frames : []) {
        const file = typeof frame?.filename === "string" && frame.filename !== "" ? frame.filename : frame?.absPath;
        if (typeof file === "string" && file !== "") files.add(file);
      }
    }
  }
  const tag = Array.isArray(event.tags)
    ? (event.tags as { key?: unknown; value?: unknown }[]).find((t) => t?.key === "transaction")?.value
    : undefined;
  const transaction = typeof tag === "string" && tag !== "" ? tag : event.transaction;
  return { frameFiles: [...files], routes: typeof transaction === "string" && transaction !== "" ? [transaction] : [] };
}

/** The issue with its rates, or null when nobody but the test account raised it after the deploy. */
async function readIssue(q: HealthQuery, apiBase: string, issue: ListedIssue, pre: Window, post: Window): Promise<SentryIssue | null> {
  const query = `issue.id:${issue.id} project:${q.project}${exclusion(q.excludeEmail)}`;
  const fields = ["count()", "count_unique(user)"];
  const [before, after, latest] = await Promise.all([
    discover(q, apiBase, query, pre, fields, `issue ${issue.id}'s pre-deploy events`),
    discover(q, apiBase, query, post, fields, `issue ${issue.id}'s post-deploy events`),
    getJson(
      sentryUrl(apiBase, `/api/0/issues/${encodeURIComponent(issue.id)}/events/latest/`),
      q.token,
      q.fetcher,
      `issue ${issue.id}'s latest event`,
    ),
  ]);
  // The list matched on lastSeen, which the verifier's own probes move too:
  // with no post-deploy event left once they are excluded, it is not impact,
  // and kept it would read as an issue new since the deploy.
  if (after.count === 0) return null;
  return {
    id: issue.id,
    title: issue.title,
    ...(issue.permalink !== undefined ? { link: issue.permalink } : {}),
    firstSeen: issue.firstSeen,
    preDeployRate: before.count / pre.hours,
    postDeployRate: after.count / post.hours,
    ...parseLatest(latest),
    events: after.count,
    distinctUsers: after.users,
  };
}

/** Runs a read, turning any failure into its one-line `why` with the token scrubbed. */
async function guarded<T>(token: string, read: () => Promise<T>): Promise<T | { why: string }> {
  if (token.trim() === "") return { why: "no Sentry token to read with" };
  try {
    return await read();
  } catch (error) {
    const message = error instanceof Unreachable ? error.message : `reading Sentry failed: ${firstLine((error as Error)?.message ?? String(error))}`;
    // A vendor error could echo the header back; never let it reach a log.
    return { why: message.split(token).join("<redacted>") };
  }
}

/** The project's issues seen since the deploy, each with its before/after rates and attribution. */
export async function readHealth(q: HealthQuery): Promise<GatheredHealth> {
  const apiBase = q.apiBase ?? DEFAULT_API_BASE;
  const result = await guarded(q.token, async () => {
    const { pre, post } = windows(q.deployedAt, q.now);
    let url: string | null = sentryUrl(apiBase, `/api/0/projects/${encodeURIComponent(q.org)}/${encodeURIComponent(q.project)}/issues/`, {
      query: `lastSeen:>=${q.deployedAt}`,
      limit: "100",
    });
    const listed: ListedIssue[] = [];
    for (let page = 1; url !== null; page++) {
      const read = await getPage(url, q.token, q.fetcher, `the issue list of ${q.org}/${q.project}`);
      listed.push(...parseIssues(read.body));
      url = nextPageUrl(read.link);
      // A truncated list read as complete could miss the very issue the PR caused.
      if (url !== null && page >= MAX_ISSUE_PAGES) {
        throw new Unreachable(`more than ${MAX_ISSUE_PAGES * 100} issues since the deploy; the read is capped`);
      }
    }
    // One issue at a time keeps a noisy deploy from firing hundreds of calls at once.
    const issues: SentryIssue[] = [];
    for (const issue of listed) {
      const read = await readIssue(q, apiBase, issue, pre, post);
      if (read !== null) issues.push(read);
    }
    return issues;
  });
  if ("why" in result) return { reachable: false, issues: [], why: result.why };
  return { reachable: true, issues: result };
}

/** Transactions on the changed routes since the deploy, excluding the test account. */
export async function readTraffic(q: TrafficQuery): Promise<GatheredTraffic> {
  // An unknown is not "nobody used it": with no route to measure, say so.
  if (q.routes.length === 0) return { reachable: false, hits: 0, why: "no changed route to measure traffic on" };
  const apiBase = q.apiBase ?? DEFAULT_API_BASE;
  const result = await guarded(q.token, async () => {
    const { post } = windows(q.deployedAt, q.now);
    const query = `event.type:transaction project:${q.project} transaction:[${q.routes.map(quoted).join(",")}]${exclusion(q.excludeEmail)}`;
    return discover(q, apiBase, query, post, ["count()"], `transactions on ${q.routes.join(", ")}`);
  });
  if ("why" in result) return { reachable: false, hits: 0, why: result.why };
  return { reachable: true, hits: result.count };
}

const firstLine = (text: string): string => text.split("\n")[0] ?? "";
