/**
 * A Sentry API emulator over a `ReporterSeed` (felipearos/ralph#680), so the
 * Sentry reporter runs the shared contract with no network. It answers the
 * four endpoints the adapter reads in Sentry's own shapes — `count` as a
 * string, raw statuses like "muted", a `Link` header with both a previous and
 * a next part — so the adapter's parsing is what gets tested, not a
 * convenience format. Any other URL is a 404, as Sentry answers one.
 */
import type { ReporterSeed, SeedIssue } from "./fake";
import type { Fetch } from "./types";

export const EMULATOR_PROJECT_ID = "4242";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const notFound = (): Response => json({ detail: "The requested resource does not exist" }, 404);

const cursorAt = (offset: number): string => `0:${offset}:0`;

function issueList(seed: ReporterSeed, url: URL): Response {
  const params = url.searchParams;
  const start = Date.parse(params.get("start") ?? "");
  const end = Date.parse(params.get("end") ?? "");
  const sinceMatch = /lastSeen:>=(\S+)/.exec(params.get("query") ?? "");
  const since = sinceMatch === null ? -Infinity : Date.parse(sinceMatch[1]!);
  const limit = Number(params.get("limit") ?? "100");
  const offset = Number((params.get("cursor") ?? cursorAt(0)).split(":")[1] ?? "0");

  const rows = seed.issues
    .filter((issue) => Date.parse(issue.lastSeen) >= since)
    .map((issue) => {
      const inside = issue.events.filter((event) => {
        const at = Date.parse(event.at);
        return at >= start && at <= end;
      });
      return { issue, inside };
    })
    .filter(({ inside }) => inside.length > 0)
    .sort((a, b) => Date.parse(b.issue.lastSeen) - Date.parse(a.issue.lastSeen))
    .map(({ issue, inside }) =>
      issueRow(
        issue,
        inside.length,
        new Set(inside.flatMap((e) => (e.user === null ? [] : [e.user]))).size,
        windowSeen(inside),
      ),
    );

  const page = rows.slice(offset, offset + limit);
  const link = (cursorOffset: number, rel: string, results: boolean): string => {
    const target = new URL(url.toString());
    target.searchParams.set("cursor", cursorAt(cursorOffset));
    return `<${target.toString()}>; rel="${rel}"; results="${results}"; cursor="${cursorAt(cursorOffset)}"`;
  };
  const header = [
    link(Math.max(0, offset - limit), "previous", offset > 0),
    link(offset + limit, "next", offset + limit < rows.length),
  ].join(", ");
  return json(page, 200, { link: header });
}

/** One row as Sentry's org issue list sends it, extra fields and all. */
/** The first and last event inside the window: what Sentry puts at the row's top level once start/end are set. */
function windowSeen(inside: { at: string }[]): { firstSeen: string; lastSeen: string } {
  const times = inside.map((event) => Date.parse(event.at)).sort((a, b) => a - b);
  return { firstSeen: new Date(times[0]!).toISOString(), lastSeen: new Date(times.at(-1)!).toISOString() };
}

function issueRow(
  issue: SeedIssue,
  count: number,
  users: number,
  window: { firstSeen: string; lastSeen: string },
): Record<string, unknown> {
  return {
    id: issue.id,
    shareId: null,
    shortId: `WEB-${issue.id.toUpperCase()}`,
    title: issue.title,
    culprit: issue.culprit,
    permalink: issue.permalink,
    logger: null,
    level: issue.level,
    status: issue.status,
    statusDetails: {},
    substatus: issue.regressed === true ? "regressed" : issue.status === "unresolved" ? "ongoing" : null,
    isPublic: false,
    platform: "javascript",
    project: { id: EMULATOR_PROJECT_ID, name: "web", slug: "web", platform: "javascript" },
    type: "error",
    metadata: { value: issue.title },
    numComments: 0,
    assignedTo: null,
    isBookmarked: false,
    isSubscribed: false,
    hasSeen: false,
    annotations: [],
    isUnhandled: true,
    count: String(count),
    userCount: users,
    // Windowed at the top level, the issue's own under `lifetime`, as Sentry
    // sends them, so an adapter reading the wrong one fails the contract.
    firstSeen: window.firstSeen,
    lastSeen: window.lastSeen,
    lifetime: { count: String(issue.events.length), userCount: users, firstSeen: issue.firstSeen, lastSeen: issue.lastSeen },
    stats: { "24h": [] },
  };
}

/** The latest event of one issue, in the shape of Sentry's event endpoint. */
function latestEvent(issue: SeedIssue): Record<string, unknown> {
  const tags = Object.entries(issue.tags ?? {}).map(([key, value]) => ({ key, value }));
  if (issue.environment !== undefined && issue.environment !== null) {
    tags.push({ key: "environment", value: issue.environment });
  }
  return {
    id: `ev-${issue.id}`,
    groupID: issue.id,
    eventID: `ev-${issue.id}`,
    projectID: EMULATOR_PROJECT_ID,
    title: issue.title,
    platform: "javascript",
    dateCreated: issue.lastSeen,
    entries: [
      {
        type: "exception",
        data: {
          values: [
            {
              type: "Error",
              value: issue.title,
              mechanism: { type: "onerror", handled: false },
              stacktrace: {
                frames: (issue.frames ?? []).map((frame) => ({
                  filename: frame.file,
                  absPath: `https://app.example/${frame.file}`,
                  function: frame.function,
                  module: null,
                  lineNo: frame.line,
                  colNo: frame.line === null ? null : 7,
                  inApp: frame.inApp,
                  context: [],
                  vars: null,
                })),
                framesOmitted: null,
              },
            },
          ],
          hasSystemFrames: true,
        },
      },
      {
        type: "breadcrumbs",
        data: {
          values: (issue.breadcrumbs ?? []).map((crumb) => ({
            type: "default",
            timestamp: crumb.at,
            category: crumb.category,
            level: crumb.level,
            message: crumb.message,
            data: null,
            event_id: null,
          })),
        },
      },
    ],
    tags,
    release: issue.release === undefined || issue.release === null ? null : { version: issue.release, dateCreated: issue.firstSeen },
    user: null,
    contexts: {},
  };
}

/** A `Fetch` that answers like Sentry for `acme/web`, from the seed. `seen` collects every URL requested. */
export function sentryEmulator(seed: ReporterSeed, seen: string[] = []): Fetch {
  return async (raw, init) => {
    seen.push(raw);
    if (seed.outage !== undefined) throw new TypeError(seed.outage);
    const auth = new Headers(init.headers).get("authorization") ?? "";
    if (!/^Bearer \S+$/.test(auth) || !seed.access.tokenValid) {
      return json({ detail: "Invalid token" }, 401);
    }
    const url = new URL(raw);
    const path = url.pathname;
    if (path === "/api/0/projects/acme/web/") {
      if (!seed.access.projectVisible) return notFound();
      return json({ id: EMULATOR_PROJECT_ID, slug: "web", name: "web", platform: "javascript", isMember: true });
    }
    if (path === "/api/0/") {
      return json({
        version: "0",
        auth: { scopes: seed.access.scopes },
        user: { id: "1", name: "loop", email: "loop@example.com" },
      });
    }
    if (path === "/api/0/organizations/acme/issues/") return issueList(seed, url);
    const latest = /^\/api\/0\/organizations\/acme\/issues\/([^/]+)\/events\/latest\/$/.exec(path);
    if (latest !== null) {
      const id = decodeURIComponent(latest[1]!);
      const issue = seed.issues.find((candidate) => candidate.id === id);
      return issue === undefined ? notFound() : json(latestEvent(issue));
    }
    return notFound();
  };
}
