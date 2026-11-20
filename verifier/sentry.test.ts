// @vitest-environment node
/**
 * The verifier's Sentry reader (felipearos/ralph#565): issues since the deploy
 * with their before/after rates, frames and routes, and traffic on the changed
 * routes. Any failed call makes the whole read unreachable, never a throw and
 * never partial evidence.
 */
import { describe, expect, it } from "vitest";

import type { Fetch } from "./credentials";
import { nextPageUrl, readHealth, readTraffic, routesFromFiles, type HealthQuery } from "./sentry";

const DEPLOYED_AT = "2026-10-29T10:00:00.000Z";
const NOW = new Date("2026-10-29T12:00:00.000Z");
const PRE_START = "2026-10-29T08:00:00.000Z";

type Route = (url: URL) => Response | Promise<Response>;

const json = (body: unknown, status = 200): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

/** A fake Sentry that routes on the URL path and records every URL and auth header. */
function sentry(routes: Record<string, Route>): { fetcher: Fetch; urls: URL[]; auth: (string | null)[] } {
  const urls: URL[] = [];
  const auth: (string | null)[] = [];
  const fetcher: Fetch = async (raw, init) => {
    const url = new URL(raw);
    urls.push(url);
    auth.push(new Headers(init.headers).get("Authorization"));
    const route = routes[url.pathname];
    if (route === undefined) return json({ detail: "not found" }, 404);
    return route(url);
  };
  return { fetcher, urls, auth };
}

const ISSUE_LIST = "/api/0/projects/acme/web/issues/";
const EVENTS = "/api/0/organizations/acme/events/";
const LATEST = "/api/0/issues/42/events/latest/";

const latestEvent = {
  transaction: "/top-level-ignored-when-tag-exists",
  tags: [
    { key: "browser", value: "Chrome" },
    { key: "transaction", value: "/checkout/[id]" },
  ],
  entries: [
    { type: "breadcrumbs", data: { values: [] } },
    {
      type: "exception",
      data: {
        values: [
          {
            stacktrace: {
              frames: [
                { filename: "app/checkout/[id]/page.tsx", absPath: "/srv/app/checkout/[id]/page.tsx" },
                { absPath: "/srv/lib/pay.ts" },
                { filename: "app/checkout/[id]/page.tsx" },
              ],
            },
          },
        ],
      },
    },
  ],
};

/** Discover counts: 4 events before the deploy, 10 after (from 3 users). */
const discoverRoute: Route = (url) =>
  url.searchParams.get("start") === DEPLOYED_AT
    ? json({ data: [{ "count()": 10, "count_unique(user)": 3 }] })
    : json({ data: [{ "count()": 4, "count_unique(user)": 2 }] });

/** One page of the issue list, with Sentry's cursor `Link` header. */
const pageOf = (body: unknown, link: string): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { link } });

const healthy = (): Record<string, Route> => ({
  [ISSUE_LIST]: () =>
    json([{ id: "42", title: "TypeError: x is undefined", permalink: "https://acme.sentry.io/issues/42/", firstSeen: "2026-10-29T10:05:00Z" }]),
  [EVENTS]: discoverRoute,
  [LATEST]: () => json(latestEvent),
});

const query = (fetcher: Fetch, over: Partial<HealthQuery> = {}): HealthQuery => ({
  org: "acme",
  project: "web",
  token: "sntrys_secret",
  deployedAt: DEPLOYED_AT,
  now: NOW,
  excludeEmail: "verifier@acme.test",
  fetcher,
  ...over,
});

describe("routesFromFiles", () => {
  it("maps app-router pages and route handlers, dropping route groups", () => {
    expect(
      routesFromFiles([
        "app/page.tsx",
        "app/(marketing)/about/page.tsx",
        "src/app/checkout/[id]/page.jsx",
        "app/api/orders/route.ts",
        "app/checkout/[id]/layout.tsx",
        "app/components/Button.tsx",
      ]),
    ).toEqual(["/", "/about", "/api/orders", "/checkout/[id]"]);
  });

  it("maps pages-router files, skipping _app, _document and other underscored files", () => {
    expect(
      routesFromFiles([
        "pages/index.tsx",
        "pages/blog/[slug].tsx",
        "src/pages/settings/index.js",
        "pages/api/health.ts",
        "pages/_app.tsx",
        "pages/_document.tsx",
        "pages/_error.tsx",
        "pages/styles.css",
      ]),
    ).toEqual(["/", "/api/health", "/blog/[slug]", "/settings"]);
  });

  it("dedupes, sorts, and maps unrelated files to nothing", () => {
    expect(routesFromFiles(["app/page.tsx", "pages/index.tsx", "app/page.tsx"])).toEqual(["/"]);
    expect(routesFromFiles(["lib/db.ts", "README.md", "components/app/page.tsx"])).toEqual([]);
    expect(routesFromFiles([])).toEqual([]);
  });
});

describe("readHealth", () => {
  it("reads each issue's rates from both windows, its impact, frames and transaction route", async () => {
    const { fetcher, urls, auth } = sentry(healthy());
    const result = await readHealth(query(fetcher));
    expect(result).toEqual({
      reachable: true,
      issues: [
        {
          id: "42",
          title: "TypeError: x is undefined",
          link: "https://acme.sentry.io/issues/42/",
          firstSeen: "2026-10-29T10:05:00Z",
          preDeployRate: 2,
          postDeployRate: 5,
          frameFiles: ["app/checkout/[id]/page.tsx", "/srv/lib/pay.ts"],
          routes: ["/checkout/[id]"],
          events: 10,
          distinctUsers: 3,
        },
      ],
    });
    expect(urls[0]!.origin).toBe("https://sentry.io");
    expect(urls[0]!.searchParams.get("query")).toBe(`lastSeen:>=${DEPLOYED_AT}`);
    expect(urls[0]!.searchParams.get("limit")).toBe("100");
    expect(auth.every((a) => a === "Bearer sntrys_secret")).toBe(true);
  });

  it("falls back to the top-level transaction when no transaction tag exists", async () => {
    const routes = healthy();
    routes[LATEST] = () => json({ ...latestEvent, tags: [{ key: "browser", value: "Chrome" }], transaction: "/cart" });
    const result = await readHealth(query(sentry(routes).fetcher));
    expect(result.issues[0]!.routes).toEqual(["/cart"]);
  });

  it("excludes the test account in every Discover query, and the pre window ends at the deploy", async () => {
    const { fetcher, urls } = sentry(healthy());
    await readHealth(query(fetcher, { apiBase: "http://127.0.0.1:9" }));
    const discover = urls.filter((u) => u.pathname === EVENTS);
    expect(discover).toHaveLength(2);
    for (const u of discover) {
      expect(u.origin).toBe("http://127.0.0.1:9");
      expect(u.searchParams.get("query")).toBe("issue.id:42 project:web !user.email:verifier@acme.test");
      expect(u.searchParams.getAll("field")).toEqual(["count()", "count_unique(user)"]);
    }
    const windows = discover.map((u) => [u.searchParams.get("start"), u.searchParams.get("end")]);
    expect(windows).toContainEqual([PRE_START, DEPLOYED_AT]);
    expect(windows).toContainEqual([DEPLOYED_AT, NOW.toISOString()]);
  });

  it("sends no exclusion when there is no test account", async () => {
    const { fetcher, urls } = sentry(healthy());
    await readHealth(query(fetcher, { excludeEmail: null }));
    for (const u of urls.filter((u) => u.pathname === EVENTS)) {
      expect(u.searchParams.get("query")).toBe("issue.id:42 project:web");
    }
  });

  it("is reachable with no issues when nothing was seen since the deploy", async () => {
    const { fetcher, urls } = sentry({ [ISSUE_LIST]: () => json([]) });
    expect(await readHealth(query(fetcher))).toEqual({ reachable: true, issues: [] });
    expect(urls).toHaveLength(1);
  });

  it.each([
    ["a 500 on the issue list", () => json({ detail: "boom" }, 500), /500/],
    ["a 401 on the issue list", () => json({ detail: "bad token" }, 401), /401/],
    ["a thrown fetch", () => Promise.reject(new Error("ECONNRESET sntrys_secret")), /could not be reached/],
    ["bad JSON", () => json("<html>"), /not JSON/],
    ["an entry missing its id", () => json([{ title: "t", firstSeen: DEPLOYED_AT }]), /'id'/],
  ] as [string, Route, RegExp][])("is unreachable on %s", async (_name, route, why) => {
    const routes = healthy();
    routes[ISSUE_LIST] = route;
    const result = await readHealth(query(sentry(routes).fetcher));
    expect(result).toMatchObject({ reachable: false, issues: [] });
    expect(result.why).toMatch(why);
    expect(result.why).not.toContain("sntrys_secret");
  });

  it("is unreachable when a per-issue call fails: partial evidence is not evidence", async () => {
    for (const broken of [EVENTS, LATEST]) {
      const routes = healthy();
      routes[broken] = () => json({ detail: "boom" }, 502);
      const result = await readHealth(query(sentry(routes).fetcher));
      expect(result).toMatchObject({ reachable: false, issues: [] });
      expect(result.why).toMatch(/502/);
    }
  });

  it("is unreachable when only one window's Discover call fails", async () => {
    const routes = healthy();
    routes[EVENTS] = (url) => (url.searchParams.get("end") === DEPLOYED_AT ? json({ data: [] }) : discoverRoute(url));
    const result = await readHealth(query(sentry(routes).fetcher));
    expect(result).toMatchObject({ reachable: false, issues: [] });
    expect(result.why).toMatch(/pre-deploy/);
  });

  it("drops an issue only the test account raised after the deploy", async () => {
    const routes = healthy();
    routes[EVENTS] = (url) => (url.searchParams.get("start") === DEPLOYED_AT
      ? json({ data: [{ "count()": 0, "count_unique(user)": 0 }] })
      : discoverRoute(url));
    expect(await readHealth(query(sentry(routes).fetcher))).toEqual({ reachable: true, issues: [] });
  });

  it("follows the issue list's cursor to the next page", async () => {
    const routes = healthy();
    const issue = (id: string) => ({ id, title: `issue ${id}`, firstSeen: "2026-10-29T10:05:00Z" });
    routes[ISSUE_LIST] = (url) => {
      const next = `https://sentry.io${ISSUE_LIST}?cursor=0:100:0`;
      return url.searchParams.get("cursor") === null
        ? pageOf([issue("42")], `<${next}>; rel="next"; results="true"; cursor="0:100:0"`)
        : pageOf([issue("43")], `<${next}x>; rel="next"; results="false"; cursor="0:200:0"`);
    };
    routes["/api/0/issues/43/events/latest/"] = () => json(latestEvent);
    const result = await readHealth(query(sentry(routes).fetcher));
    expect(result.reachable).toBe(true);
    expect(result.issues.map((i) => i.id)).toEqual(["42", "43"]);
  });

  it("is unreachable rather than truncated past five pages of issues", async () => {
    const routes = healthy();
    let page = 0;
    routes[ISSUE_LIST] = () => {
      page += 1;
      return pageOf([], `<https://sentry.io${ISSUE_LIST}?cursor=${page}>; rel="next"; results="true"; cursor="${page}"`);
    };
    const result = await readHealth(query(sentry(routes).fetcher));
    expect(result).toMatchObject({ reachable: false, issues: [], why: "more than 500 issues since the deploy; the read is capped" });
    expect(page).toBe(5);
  });

  it("reads the next page only from a rel=next link that has results", () => {
    expect(nextPageUrl(null)).toBeNull();
    expect(nextPageUrl('<https://s/p?cursor=a>; rel="previous"; results="true"; cursor="a", <https://s/p?cursor=b>; rel="next"; results="false"; cursor="b"')).toBeNull();
    expect(nextPageUrl('<https://s/p?cursor=a>; rel="previous"; results="false"; cursor="a", <https://s/p?cursor=b>; rel="next"; results="true"; cursor="b"')).toBe("https://s/p?cursor=b");
  });

  it("calls nothing with an empty token", async () => {
    const { fetcher, urls } = sentry(healthy());
    const result = await readHealth(query(fetcher, { token: "" }));
    expect(result).toMatchObject({ reachable: false, issues: [] });
    expect(result.why).toBeTruthy();
    expect(urls).toHaveLength(0);
  });
});

describe("readTraffic", () => {
  it("is unreachable without a fetch when there is no route to measure", async () => {
    const { fetcher, urls } = sentry(healthy());
    expect(await readTraffic({ ...query(fetcher), routes: [] })).toEqual({
      reachable: false,
      hits: 0,
      why: "no changed route to measure traffic on",
    });
    expect(urls).toHaveLength(0);
  });

  it("counts transactions on the changed routes since the deploy, excluding the test account", async () => {
    const { fetcher, urls } = sentry({ [EVENTS]: () => json({ data: [{ "count()": 17 }] }) });
    const result = await readTraffic({ ...query(fetcher), routes: ["/about", "/checkout/[id]"] });
    expect(result).toEqual({ reachable: true, hits: 17 });
    expect(urls).toHaveLength(1);
    expect(urls[0]!.searchParams.getAll("field")).toEqual(["count()"]);
    expect(urls[0]!.searchParams.get("query")).toBe(
      'event.type:transaction project:web transaction:["/about","/checkout/[id]"] !user.email:verifier@acme.test',
    );
  });

  it("escapes quotes and backslashes inside a route", async () => {
    const { fetcher, urls } = sentry({ [EVENTS]: () => json({ data: [{ "count()": 1 }] }) });
    await readTraffic({ ...query(fetcher), excludeEmail: null, routes: ['/a"b', "/c\\d"] });
    expect(urls[0]!.searchParams.get("query")).toBe(
      'event.type:transaction project:web transaction:["/a\\"b","/c\\\\d"]',
    );
    expect(urls[0]!.searchParams.get("start")).toBe(DEPLOYED_AT);
    expect(urls[0]!.searchParams.get("end")).toBe(NOW.toISOString());
  });

  it("is unreachable when the Discover call fails", async () => {
    const { fetcher } = sentry({ [EVENTS]: () => json({ detail: "boom" }, 503) });
    const result = await readTraffic({ ...query(fetcher), routes: ["/about"] });
    expect(result).toMatchObject({ reachable: false, hits: 0 });
    expect(result.why).toMatch(/503/);
  });
});
