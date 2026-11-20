import { describe, expect, it } from "vitest";

import { NOW, hoursAgo, reporterContract, seedIssue, seedOf } from "./contract";
import { sentryEmulator } from "./sentry-emulator";
import { createSentryReporter, type SentryReporterOptions } from "./sentry";
import type { Fetch } from "./types";

const TOKEN = "tok-secret";

const options = (fetcher: Fetch, overrides: Partial<SentryReporterOptions> = {}): SentryReporterOptions => ({
  org: "acme",
  project: "web",
  environment: "production",
  token: TOKEN,
  pageSize: 5,
  pageCap: 3,
  fetcher,
  ...overrides,
});

reporterContract("sentry", {
  kind: "sentry",
  pageSize: 5,
  pageCap: 3,
  make: (seed) => createSentryReporter(options(sentryEmulator(seed))),
});

const QUERY = { since: hoursAgo(6), lookbackHours: 24, now: NOW };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetcher that answers each path from a table, anything else 404. */
const routes =
  (table: Record<string, () => Response | Promise<Response>>, seen: string[] = []): Fetch =>
  async (raw) => {
    seen.push(raw);
    const answer = table[new URL(raw).pathname];
    return answer === undefined ? json({ detail: "not found" }, 404) : answer();
  };

const PROJECT = "/api/0/projects/acme/web/";
const ROOT = "/api/0/";
const ISSUES = "/api/0/organizations/acme/issues/";
const LATEST = "/api/0/organizations/acme/issues/5871234567/events/latest/";

// Recorded shapes: one org issue list row and one latest event as Sentry sends
// them, extra fields included, so the mapping is tested on the real wire format.
const RECORDED_ROW = {
  id: "5871234567",
  shareId: null,
  shortId: "WEB-3F2",
  title: "TypeError: Cannot read properties of undefined (reading 'total')",
  culprit: "app/checkout/page.tsx in CheckoutSummary",
  permalink: "https://acme.sentry.io/issues/5871234567/",
  logger: null,
  level: "error",
  status: "unresolved",
  statusDetails: {},
  substatus: "regressed",
  isPublic: false,
  platform: "javascript",
  project: { id: "4242", name: "web", slug: "web", platform: "javascript-nextjs" },
  type: "error",
  metadata: { type: "TypeError", value: "Cannot read properties of undefined (reading 'total')", filename: "app/checkout/page.tsx" },
  numComments: 2,
  assignedTo: null,
  isBookmarked: false,
  isSubscribed: true,
  subscriptionDetails: { reason: "unknown" },
  hasSeen: true,
  annotations: [],
  issueType: "error",
  issueCategory: "error",
  priority: "high",
  isUnhandled: true,
  count: "37",
  userCount: 11,
  firstSeen: "2026-10-30T08:14:02.123000Z",
  lastSeen: "2026-11-04T11:41:55.910000Z",
  stats: { "24h": [[1793750400, 3], [1793754000, 0]] },
};

const RECORDED_EVENT = {
  id: "c3f0a5b1e2d94f6b8a7c6d5e4f3a2b1c",
  groupID: "5871234567",
  eventID: "c3f0a5b1e2d94f6b8a7c6d5e4f3a2b1c",
  projectID: "4242",
  size: 18234,
  title: "TypeError: Cannot read properties of undefined (reading 'total')",
  message: "",
  platform: "javascript",
  type: "error",
  dateCreated: "2026-11-04T11:41:55.910000Z",
  dateReceived: "2026-11-04T11:41:56.402000Z",
  user: { id: "u-91", email: null, ip_address: "203.0.113.4" },
  sdk: { name: "sentry.javascript.nextjs", version: "8.38.0" },
  contexts: { browser: { name: "Chrome", version: "130.0.0" } },
  entries: [
    {
      type: "breadcrumbs",
      data: {
        values: [
          {
            type: "navigation",
            timestamp: "2026-11-04T11:41:50.001000Z",
            category: "navigation",
            level: "info",
            message: null,
            data: { from: "/cart", to: "/checkout" },
            event_id: null,
          },
          {
            type: "default",
            timestamp: "2026-11-04T11:41:55.800000Z",
            category: "ui.click",
            level: null,
            message: "button#pay",
            data: null,
            event_id: null,
          },
        ],
      },
    },
    {
      type: "exception",
      data: {
        values: [
          {
            type: "TypeError",
            value: "Cannot read properties of undefined (reading 'total')",
            mechanism: { type: "onerror", handled: false },
            stacktrace: {
              frames: [
                {
                  filename: "node_modules/react-dom/cjs/react-dom.production.min.js",
                  absPath: "app:///_next/static/chunks/framework.js",
                  function: "renderWithHooks",
                  module: "react-dom",
                  lineNo: 1201,
                  colNo: 22,
                  inApp: false,
                  context: [],
                  vars: null,
                },
                {
                  filename: null,
                  absPath: "app:///_next/static/chunks/app/checkout/page.js",
                  function: null,
                  lineNo: null,
                  colNo: null,
                  inApp: true,
                },
                {
                  filename: "app/checkout/page.tsx",
                  absPath: "app:///_next/static/chunks/app/checkout/page.js",
                  function: "CheckoutSummary",
                  module: null,
                  lineNo: 48,
                  colNo: 31,
                  inApp: true,
                  context: [[48, "  const total = cart.summary.total;"]],
                },
              ],
              framesOmitted: null,
              registers: null,
            },
            rawStacktrace: null,
          },
        ],
        hasSystemFrames: true,
        excOmitted: null,
      },
    },
    { type: "request", data: { url: "https://app.acme.example/checkout", method: "GET" } },
  ],
  tags: [
    { key: "browser", value: "Chrome 130.0.0" },
    { key: "browser.name", value: "Chrome" },
    { key: "environment", value: "production" },
    { key: "handled", value: "no" },
    { key: "level", value: "error" },
    { key: "os", value: "Windows 11" },
    { key: "transaction", value: "/checkout" },
    { key: "url", value: "https://app.acme.example/checkout" },
  ],
  release: { version: "web@2026.11.04-1", shortVersion: "web@2026.11.04-1", dateCreated: "2026-11-04T09:00:00Z" },
};

const healthy = (overrides: Record<string, () => Response | Promise<Response>> = {}) => ({
  [PROJECT]: () => json({ id: "4242", slug: "web", name: "web" }),
  [ROOT]: () => json({ version: "0", auth: { scopes: ["project:read", "event:read", "org:read"] }, user: null }),
  [ISSUES]: () => json([RECORDED_ROW]),
  [LATEST]: () => json(RECORDED_EVENT),
  ...overrides,
});

describe("sentry reporter", () => {
  it("maps a recorded issue list row to a candidate", async () => {
    const list = await createSentryReporter(options(routes(healthy()))).listCandidates(QUERY);
    expect(list).toEqual({
      reachable: true,
      truncated: false,
      issues: [
        {
          id: "5871234567",
          title: "TypeError: Cannot read properties of undefined (reading 'total')",
          culprit: "app/checkout/page.tsx in CheckoutSummary",
          level: "error",
          status: "unresolved",
          regressed: true,
          firstSeen: "2026-10-30T08:14:02.123000Z",
          lastSeen: "2026-11-04T11:41:55.910000Z",
          events: 37,
          users: 11,
          permalink: "https://acme.sentry.io/issues/5871234567/",
        },
      ],
    });
  });

  it("maps a recorded latest event to evidence", async () => {
    const read = await createSentryReporter(options(routes(healthy()))).readEvidence("5871234567");
    expect(read).toEqual({
      reachable: true,
      evidence: {
        issueId: "5871234567",
        release: "web@2026.11.04-1",
        environment: "production",
        frames: [
          { file: "app/checkout/page.tsx", function: "CheckoutSummary", line: 48, inApp: true },
          { file: "app:///_next/static/chunks/app/checkout/page.js", function: "?", line: null, inApp: true },
          {
            file: "node_modules/react-dom/cjs/react-dom.production.min.js",
            function: "renderWithHooks",
            line: 1201,
            inApp: false,
          },
        ],
        framesOmitted: 0,
        tags: {
          browser: "Chrome 130.0.0",
          os: "Windows 11",
          url: "https://app.acme.example/checkout",
          transaction: "/checkout",
        },
        breadcrumbs: [
          {
            at: "2026-11-04T11:41:50.001000Z",
            category: "navigation",
            level: "info",
            message: '{"from":"/cart","to":"/checkout"}',
          },
          { at: "2026-11-04T11:41:55.800000Z", category: "ui.click", level: "info", message: "button#pay" },
        ],
        breadcrumbsOmitted: 0,
      },
    });
  });

  it("reads a release sent as a plain string", async () => {
    const fetcher = routes(healthy({ [LATEST]: () => json({ ...RECORDED_EVENT, release: "web@1.0.0" }) }));
    const read = await createSentryReporter(options(fetcher)).readEvidence("5871234567");
    expect(read).toMatchObject({ reachable: true, evidence: { release: "web@1.0.0" } });
  });

  it("asks for the project's issues in the environment and the lookback, paging by cursor", async () => {
    const seen: string[] = [];
    const issues = Array.from({ length: 7 }, (_, index) => seedIssue(`p${index}`, index / 60));
    const list = await createSentryReporter(options(sentryEmulator(seedOf(issues), seen))).listCandidates(QUERY);
    expect(list).toMatchObject({ reachable: true, truncated: false });

    const pages = seen.map((raw) => new URL(raw)).filter((url) => url.pathname === ISSUES);
    expect(pages).toHaveLength(2);
    const first = pages[0]!.searchParams;
    expect(first.get("project")).toBe("4242");
    expect(first.get("environment")).toBe("production");
    expect(first.get("start")).toBe(hoursAgo(24));
    expect(first.get("end")).toBe(NOW.toISOString());
    expect(first.get("query")).toBe(`lastSeen:>=${QUERY.since}`);
    expect(first.get("sort")).toBe("date");
    expect(first.get("limit")).toBe("5");
    expect(first.get("cursor")).toBeNull();
    expect(pages[1]!.searchParams.get("cursor")).toBe("0:5:0");
    expect(pages[1]!.searchParams.get("query")).toBe(`lastSeen:>=${QUERY.since}`);
  });

  it("sends no environment when built without one", async () => {
    const seen: string[] = [];
    const reporter = createSentryReporter(
      options(sentryEmulator(seedOf([seedIssue("a", 1)]), seen), { environment: null }),
    );
    expect(await reporter.listCandidates(QUERY)).toMatchObject({ reachable: true });
    const page = seen.map((raw) => new URL(raw)).find((url) => url.pathname === ISSUES)!;
    expect(page.searchParams.has("environment")).toBe(false);
  });

  it("reads first and last seen from the issue's lifetime, not the windowed row", async () => {
    const windowed = { ...RECORDED_ROW, firstSeen: "2026-11-04T10:00:00Z", lastSeen: "2026-11-04T11:00:00Z" };
    const lifetime = { count: "900", userCount: 80, firstSeen: "2026-09-01T00:00:00Z", lastSeen: "2026-11-04T11:41:55Z" };
    const fetcher = routes(healthy({ [ISSUES]: () => json([{ ...windowed, lifetime }]) }));
    const list = await createSentryReporter(options(fetcher)).listCandidates(QUERY);
    expect(list).toMatchObject({
      reachable: true,
      issues: [{ firstSeen: "2026-09-01T00:00:00Z", lastSeen: "2026-11-04T11:41:55Z", events: 37, users: 11 }],
    });
  });

  it("reads the latest event in the configured environment, and none without one", async () => {
    for (const environment of ["production", null]) {
      const seen: string[] = [];
      const reporter = createSentryReporter(options(routes(healthy(), seen), { environment }));
      expect(await reporter.readEvidence("5871234567")).toMatchObject({ reachable: true });
      const latest = seen.map((raw) => new URL(raw)).find((url) => url.pathname === LATEST)!;
      expect(latest.searchParams.get("environment")).toBe(environment);
    }
  });

  it("refuses evidence for an issue of another project", async () => {
    const fetcher = routes(healthy({ [LATEST]: () => json({ ...RECORDED_EVENT, projectID: "9999" }) }));
    const read = await createSentryReporter(options(fetcher)).readEvidence("5871234567");
    expect(read).toEqual({ reachable: false, why: expect.stringContaining("acme/web") });
  });

  it("makes the whole list unreachable on an unknown status, naming it", async () => {
    const fetcher = routes(healthy({ [ISSUES]: () => json([RECORDED_ROW, { ...RECORDED_ROW, id: "2", status: "reprocessing" }]) }));
    const list = await createSentryReporter(options(fetcher)).listCandidates(QUERY);
    expect(list).toEqual({ reachable: false, why: expect.stringContaining("reprocessing") });
  });

  it("names the entry and field of a malformed row", async () => {
    const fetcher = routes(healthy({ [ISSUES]: () => json([RECORDED_ROW, { ...RECORDED_ROW, count: "many" }]) }));
    const list = await createSentryReporter(options(fetcher)).listCandidates(QUERY);
    expect(list).toEqual({ reachable: false, why: expect.stringMatching(/entry 1.*count/) });
  });

  for (const status of [500, 429]) {
    describe(`a ${status}`, () => {
      const failing = () => json({ detail: "busy" }, status);

      it("on the project call makes checkAccess unreachable", async () => {
        const check = await createSentryReporter(options(routes(healthy({ [PROJECT]: failing })))).checkAccess();
        expect(check).toEqual({ reachable: false, why: expect.stringContaining(String(status)) });
      });

      it("on the API root makes checkAccess unreachable", async () => {
        const check = await createSentryReporter(options(routes(healthy({ [ROOT]: failing })))).checkAccess();
        expect(check).toEqual({ reachable: false, why: expect.stringContaining(String(status)) });
      });

      it("on the issue list makes listCandidates unreachable", async () => {
        const list = await createSentryReporter(options(routes(healthy({ [ISSUES]: failing })))).listCandidates(QUERY);
        expect(list).toEqual({ reachable: false, why: expect.stringContaining(String(status)) });
      });

      it("on the project lookup makes listCandidates unreachable", async () => {
        const list = await createSentryReporter(options(routes(healthy({ [PROJECT]: failing })))).listCandidates(QUERY);
        expect(list).toEqual({ reachable: false, why: expect.stringContaining(String(status)) });
      });

      it("on the latest event makes readEvidence unreachable", async () => {
        const read = await createSentryReporter(options(routes(healthy({ [LATEST]: failing })))).readEvidence(
          "5871234567",
        );
        expect(read).toEqual({ reachable: false, why: expect.stringContaining(String(status)) });
      });
    });
  }

  it("refuses on a 401 from the project call", async () => {
    const fetcher = routes(healthy({ [PROJECT]: () => json({ detail: "Invalid token" }, 401) }));
    const check = await createSentryReporter(options(fetcher)).checkAccess();
    expect(check).toEqual({ reachable: true, access: "refused", why: expect.stringContaining("invalid") });
  });

  it("refuses on a 403 from the project call, naming the project", async () => {
    const fetcher = routes(healthy({ [PROJECT]: () => json({ detail: "forbidden" }, 403) }));
    const check = await createSentryReporter(options(fetcher)).checkAccess();
    expect(check).toEqual({ reachable: true, access: "refused", why: expect.stringContaining("acme/web") });
  });

  it("refuses when the API root reports no auth", async () => {
    const fetcher = routes(healthy({ [ROOT]: () => json({ version: "0", auth: null, user: null }) }));
    const check = await createSentryReporter(options(fetcher)).checkAccess();
    expect(check).toEqual({ reachable: true, access: "refused", why: "Sentry did not report the token's scopes" });
  });

  it("names every write scope and asks for a read-only token", async () => {
    const fetcher = routes(
      healthy({ [ROOT]: () => json({ auth: { scopes: ["project:read", "project:write", "org:ci"] }, user: null }) }),
    );
    const check = await createSentryReporter(options(fetcher)).checkAccess();
    if (!check.reachable || check.access !== "refused") throw new Error(`not refused: ${JSON.stringify(check)}`);
    expect(check.why).toContain("project:write");
    expect(check.why).toContain("org:ci");
    expect(check.why).toContain("project:read, event:read, org:read");
  });

  it("scrubs a token echoed back in an error", async () => {
    const fetcher: Fetch = async (_url, init) => {
      throw new Error(`bad header ${new Headers(init.headers).get("authorization")}\nmore`);
    };
    const reporter = createSentryReporter(options(fetcher));
    for (const result of [await reporter.checkAccess(), await reporter.listCandidates(QUERY), await reporter.readEvidence("1")]) {
      expect(result.reachable).toBe(false);
      if (result.reachable) continue;
      expect(result.why).toContain("<redacted>");
      expect(result.why).not.toContain(TOKEN);
      expect(result.why).not.toMatch(/\n/);
    }
  });

  it("sends a padded token trimmed and scrubs the trimmed form too", async () => {
    const fetcher: Fetch = async (_url, init) => {
      throw new Error(`bad header ${new Headers(init.headers).get("authorization")}`);
    };
    const read = await createSentryReporter(options(fetcher, { token: `${TOKEN}\n` })).checkAccess();
    expect(read.reachable).toBe(false);
    if (read.reachable) return;
    expect(read.why).toContain("Bearer <redacted>");
    expect(read.why).not.toContain(TOKEN);
  });

  it("is unreachable with an empty token, without a call", async () => {
    const seen: string[] = [];
    const reporter = createSentryReporter(options(routes(healthy(), seen), { token: "" }));
    const results = [await reporter.checkAccess(), await reporter.listCandidates(QUERY), await reporter.readEvidence("1")];
    for (const result of results) {
      expect(result).toEqual({ reachable: false, why: "no Sentry token to read with" });
    }
    expect(seen).toEqual([]);
  });

  it("sends the token as a Bearer header and asks for JSON", async () => {
    const headers: Headers[] = [];
    const fetcher: Fetch = async (raw, init) => {
      headers.push(new Headers(init.headers));
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return routes(healthy())(raw, init);
    };
    await createSentryReporter(options(fetcher)).checkAccess();
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) {
      expect(header.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(header.get("accept")).toBe("application/json");
    }
  });
});
