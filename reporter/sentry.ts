/**
 * The Sentry `Reporter` (felipearos/ralph#680): the loops' read of one Sentry
 * project's issues and their latest events, held to `contract.ts`.
 *
 * Read-only by construction and by check: every call is a GET, and
 * `checkAccess` refuses a token that carries any write scope. Nothing here
 * throws; any failed call resolves to `Unreachable` with one line that never
 * holds the token. The patterns (Link-header paging, token scrubbing, the
 * call timeout) follow `sentinel/sentry.ts`, copied rather than imported
 * because that directory is being renamed on another branch.
 */
import { boundEvidence, type RawEvidence } from "./evidence";
import {
  writeScopes,
  type AccessCheck,
  type Breadcrumb,
  type Candidate,
  type CandidateList,
  type CandidateQuery,
  type EvidenceRead,
  type Fetch,
  type Frame,
  type IssueStatus,
  type Reporter,
  type Unreachable,
} from "./types";

export interface SentryReporterOptions {
  org: string;
  project: string;
  /** Only this environment's events count; null reads every environment. */
  environment: string | null;
  /** Passed in by the caller, never read from the environment here, so a test can never pick up a real one. */
  token: string;
  fetcher?: Fetch;
  apiBase?: string;
  /** Issues per page; 100 is Sentry's maximum `limit`. */
  pageSize?: number;
  /** Pages read before `listCandidates` stops and reports `truncated`. */
  pageCap?: number;
}

const DEFAULT_API_BASE = "https://sentry.io";
/** One Sentry call's budget: a hung socket must not hang an unattended loop. */
const CALL_TIMEOUT_MS = 20_000;
const HOUR_MS = 3_600_000;
const READ_ONLY_SCOPES = "project:read, event:read, org:read";

/** A failed call, carrying the one-line `why` the read reports. */
class Failure extends Error {}

/** A reachable answer that still says no, carried out of a read the same way. */
class Refusal extends Error {}

interface Answer {
  status: number;
  body: unknown;
  link: string | null;
}

const firstLine = (text: string): string => text.split("\n")[0] ?? "";
const messageOf = (error: unknown): string => firstLine((error as Error)?.message ?? String(error));

/**
 * The next page's URL from Sentry's `Link` header, or null when there is none:
 * Sentry always sends a `rel="next"` link and says whether it holds anything
 * with `results="true"`.
 */
function nextPageUrl(link: string | null): string | null {
  if (link === null) return null;
  for (const part of link.split(",")) {
    const url = /<([^>]+)>/.exec(part)?.[1];
    if (url !== undefined && /rel="next"/.test(part) && /results="true"/.test(part)) return url;
  }
  return null;
}

/**
 * Sentry's statuses onto the interface's three. "muted" and "archived" are
 * what Sentry calls ignored issues in some API versions; anything else is
 * unknown, and guessing it could ticket something the operator ignored.
 */
const STATUSES: Record<string, IssueStatus> = {
  unresolved: "unresolved",
  resolved: "resolved",
  ignored: "ignored",
  muted: "ignored",
  archived: "ignored",
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The issue's lifetime value of a seen field, falling back to the row's own. */
const lifetimeOr = (row: Record<string, unknown>, field: "firstSeen" | "lastSeen"): string => {
  const lifetime = record(row.lifetime)[field];
  return typeof lifetime === "string" && lifetime !== "" ? lifetime : (row[field] as string);
};

function parseCandidates(body: unknown): Candidate[] {
  if (!Array.isArray(body)) throw new Failure("Sentry's issue list was not an array");
  return body.map((item, index) => {
    const row = record(item);
    for (const field of ["id", "title", "firstSeen", "lastSeen", "permalink"]) {
      if (typeof row[field] !== "string") throw new Failure(`Sentry's issue list entry ${index} had no '${field}'`);
    }
    const status = typeof row.status === "string" ? STATUSES[row.status] : undefined;
    if (status === undefined) {
      throw new Failure(`Sentry's issue list entry ${index} had an unknown status ${JSON.stringify(row.status)}`);
    }
    // With start/end on the request, Sentry reports `count` and `userCount`
    // for that window rather than the issue's lifetime, which is what the
    // interface promises. `count` arrives as a string, `userCount` as a number.
    const events = Number(row.count);
    if (row.count === null || row.count === undefined || row.count === "" || !Number.isFinite(events)) {
      throw new Failure(`Sentry's issue list entry ${index} had a 'count' that is not a number`);
    }
    const users = row.userCount;
    if (typeof users !== "number" || !Number.isFinite(users)) {
      throw new Failure(`Sentry's issue list entry ${index} had a 'userCount' that is not a number`);
    }
    return {
      id: row.id as string,
      title: row.title as string,
      culprit: typeof row.culprit === "string" ? row.culprit : "",
      level: typeof row.level === "string" ? row.level : "error",
      status,
      regressed: row.substatus === "regressed",
      // With start/end on the request, the top-level first and last seen are
      // the window's too; `lifetime` carries the issue's own, which is what
      // tells a new issue from an old one firing again.
      firstSeen: lifetimeOr(row, "firstSeen"),
      lastSeen: lifetimeOr(row, "lastSeen"),
      events,
      users,
      permalink: row.permalink as string,
    };
  });
}

/** The `data` of every entry of one type in an event. */
const entriesOf = (event: Record<string, unknown>, type: string): Record<string, unknown>[] =>
  (Array.isArray(event.entries) ? event.entries : [])
    .map(record)
    .filter((entry) => entry.type === type)
    .map((entry) => record(entry.data));

const valuesOf = (data: Record<string, unknown>): Record<string, unknown>[] =>
  (Array.isArray(data.values) ? data.values : []).map(record);

function parseEvidence(issueId: string, body: unknown): RawEvidence {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Failure(`Sentry's latest event of issue ${issueId} was not an object`);
  }
  const event = body as Record<string, unknown>;

  // Chained exceptions come as several values; taken in the order given, each
  // trace outermost first, which is the order `boundEvidence` expects.
  const frames: Frame[] = entriesOf(event, "exception")
    .flatMap(valuesOf)
    .flatMap((value) => {
      const raw = record(value.stacktrace).frames;
      return (Array.isArray(raw) ? raw : []).map(record);
    })
    .map((frame) => ({
      file:
        (typeof frame.filename === "string" && frame.filename) ||
        (typeof frame.absPath === "string" && frame.absPath) ||
        "?",
      function: (typeof frame.function === "string" && frame.function) || "?",
      line: typeof frame.lineNo === "number" ? frame.lineNo : null,
      inApp: frame.inApp === true,
    }));

  const breadcrumbs: Breadcrumb[] = entriesOf(event, "breadcrumbs")
    .flatMap(valuesOf)
    .map((crumb) => ({
      at: typeof crumb.timestamp === "string" ? crumb.timestamp : "",
      category: typeof crumb.category === "string" ? crumb.category : "",
      level: typeof crumb.level === "string" ? crumb.level : "info",
      message:
        (typeof crumb.message === "string" && crumb.message) ||
        (typeof crumb.data === "object" && crumb.data !== null ? JSON.stringify(crumb.data) : "") ||
        "",
    }));

  const tags: Record<string, string> = {};
  for (const tag of (Array.isArray(event.tags) ? event.tags : []).map(record)) {
    if (typeof tag.key === "string" && typeof tag.value === "string") tags[tag.key] = tag.value;
  }

  const release = event.release;
  return {
    issueId,
    release:
      typeof release === "string"
        ? release
        : typeof record(release).version === "string"
          ? (record(release).version as string)
          : null,
    environment: tags.environment ?? null,
    frames,
    tags,
    breadcrumbs,
  };
}

export function createSentryReporter(options: SentryReporterOptions): Reporter {
  const { org, project, environment, token } = options;
  const fetcher: Fetch = options.fetcher ?? ((url, init) => globalThis.fetch(url, init));
  const apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const pageSize = options.pageSize ?? 100;
  const pageCap = options.pageCap ?? 5;
  const projectName = `${org}/${project}`;
  const projectPath = `/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/`;
  let projectId: string | null = null;

  const url = (path: string, params: Record<string, string> = {}): string => {
    const query = new URLSearchParams(params).toString();
    return `${apiBase}${path}${query === "" ? "" : `?${query}`}`;
  };

  /** One GET; the status is the caller's to read, a network or JSON failure is not. */
  const get = async (target: string, what: string): Promise<Answer> => {
    let response: Response;
    try {
      response = await fetcher(target, {
        method: "GET",
        headers: { Authorization: `Bearer ${token.trim()}`, Accept: "application/json" },
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Failure(`Sentry could not be reached for ${what}: ${messageOf(error)}`);
    }
    if (!response.ok) return { status: response.status, body: null, link: null };
    try {
      return { status: response.status, body: await response.json(), link: response.headers?.get("link") ?? null };
    } catch (error) {
      throw new Failure(`Sentry's ${what} was not JSON: ${messageOf(error)}`);
    }
  };

  /** The body of a call that must succeed; any non-2xx is a failed read. */
  const getOk = async (target: string, what: string): Promise<Answer> => {
    const answer = await get(target, what);
    if (answer.status < 200 || answer.status >= 300) throw new Failure(`Sentry answered ${answer.status} for ${what}`);
    return answer;
  };

  /** One line, the token scrubbed out: a vendor error could echo the header back. */
  // An empty token is not scrubbed: splitting on "" would redact between every character.
  // The trimmed form too: fetch strips header whitespace, so that is what a vendor would echo.
  const secrets = [...new Set([token, token.trim()])].filter((secret) => secret !== "");
  const oneLine = (why: string): string =>
    secrets.reduce((text, secret) => text.split(secret).join("<redacted>"), why).replace(/\s+/g, " ").trim() ||
    "Sentry read failed";

  const unreachable = (why: string): Unreachable => ({ reachable: false, why: oneLine(why) });

  /** Runs a read, turning any failure into `Unreachable` and a refusal into its result. */
  async function guarded<T>(read: () => Promise<T>): Promise<T | Unreachable | { refused: string }> {
    if (token.trim() === "") return unreachable("no Sentry token to read with");
    try {
      return await read();
    } catch (error) {
      if (error instanceof Refusal) return { refused: oneLine(error.message) };
      if (error instanceof Failure) return unreachable(error.message);
      return unreachable(`reading Sentry failed: ${messageOf(error)}`);
    }
  }

  const projectDetails = async (): Promise<Answer> => get(url(projectPath), `the project ${projectName}`);

  const refusalFor = (status: number): string | null => {
    if (status === 401) return "Sentry refused the token: it is invalid or revoked";
    if (status === 403) return `the token cannot read the Sentry project ${projectName}`;
    if (status === 404) return `no Sentry project ${projectName} is visible to the token`;
    return null;
  };

  const resolveProjectId = async (): Promise<string> => {
    if (projectId !== null) return projectId;
    const answer = await projectDetails();
    const refused = refusalFor(answer.status);
    if (refused !== null) throw new Failure(refused);
    if (answer.status < 200 || answer.status >= 300) {
      throw new Failure(`Sentry answered ${answer.status} for the project ${projectName}`);
    }
    const id = record(answer.body).id;
    if (typeof id !== "string" || id === "") throw new Failure(`Sentry's project ${projectName} had no 'id'`);
    projectId = id;
    return id;
  };

  return {
    kind: "sentry",

    async checkAccess(): Promise<AccessCheck> {
      const result = await guarded(async (): Promise<AccessCheck> => {
        const details = await projectDetails();
        const refused = refusalFor(details.status);
        if (refused !== null) throw new Refusal(refused);
        if (details.status < 200 || details.status >= 300) {
          throw new Failure(`Sentry answered ${details.status} for the project ${projectName}`);
        }
        const id = record(details.body).id;
        if (typeof id === "string" && id !== "") projectId = id;

        const root = await get(url("/api/0/"), "the API root");
        if (root.status === 401) throw new Refusal("Sentry refused the token: it is invalid or revoked");
        if (root.status < 200 || root.status >= 300) throw new Failure(`Sentry answered ${root.status} for the API root`);
        // Without the scopes there is no proof the token is read-only, so it is refused.
        const scopes = record(record(root.body).auth).scopes;
        if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")) {
          throw new Refusal("Sentry did not report the token's scopes");
        }
        const writes = writeScopes(scopes as string[]);
        if (writes.length > 0) {
          throw new Refusal(
            `the Sentry token can write (${writes.join(", ")}); store a read-only token (${READ_ONLY_SCOPES})`,
          );
        }
        return { reachable: true, access: "ok", scopes: [...(scopes as string[])] };
      });
      if ("refused" in result) return { reachable: true, access: "refused", why: result.refused };
      return result;
    },

    async listCandidates(query: CandidateQuery): Promise<CandidateList> {
      const result = await guarded(async (): Promise<CandidateList> => {
        const id = await resolveProjectId();
        const end = query.now.getTime();
        const params: Record<string, string> = { project: id };
        if (environment !== null) params.environment = environment;
        Object.assign(params, {
          start: new Date(end - query.lookbackHours * HOUR_MS).toISOString(),
          end: new Date(end).toISOString(),
          // No `is:` term, so every status comes back and the caller decides.
          query: `lastSeen:>=${query.since}`,
          // Sentry's "last seen" sort, newest first; kept as returned.
          sort: "date",
          limit: String(pageSize),
        });
        let next: string | null = url(`/api/0/organizations/${encodeURIComponent(org)}/issues/`, params);
        const issues: Candidate[] = [];
        for (let page = 0; page < pageCap && next !== null; page += 1) {
          const answer = await getOk(next, `the issue list of ${projectName}`);
          issues.push(...parseCandidates(answer.body));
          next = nextPageUrl(answer.link);
        }
        return { reachable: true, issues, truncated: next !== null };
      });
      if ("refused" in result) return unreachable(result.refused);
      return result;
    },

    async readEvidence(issueId: string): Promise<EvidenceRead> {
      const result = await guarded(async (): Promise<EvidenceRead> => {
        const what = `the latest event of issue ${issueId}`;
        const id = await resolveProjectId();
        // The same environment the candidates were counted in, so the
        // evidence is not a staging event behind production counts.
        const params: Record<string, string> = environment === null ? {} : { environment };
        const answer = await get(
          url(`/api/0/organizations/${encodeURIComponent(org)}/issues/${encodeURIComponent(issueId)}/events/latest/`, params),
          what,
        );
        if (answer.status === 404) throw new Failure(`Sentry has no issue ${issueId} in ${org}`);
        if (answer.status < 200 || answer.status >= 300) throw new Failure(`Sentry answered ${answer.status} for ${what}`);
        // The endpoint is org-wide: an id from another project is not this reporter's issue.
        const eventProject = record(answer.body).projectID;
        if (eventProject !== undefined && String(eventProject) !== id) {
          throw new Failure(`Sentry issue ${issueId} is not in the project ${projectName}`);
        }
        return { reachable: true, evidence: boundEvidence(parseEvidence(issueId, answer.body)) };
      });
      if ("refused" in result) return unreachable(result.refused);
      return result;
    },
  };
}
