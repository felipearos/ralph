import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { COMMAND_PARSERS } from "./command-requests";
import {
  RELAYED_COMMAND_KINDS,
  type Dashboard,
  type EvalPatchesView,
  type NotificationsView,
  type ProjectsHealthView,
} from "./contracts";
import {
  frontierOf,
  healthWithout,
  LOCAL_ONLY_ROUTES,
  loopFeedOf,
  loopPanelOf,
  matchRoute,
  ownershipOf,
  PROJECTIONS,
  RELAY_ROUTES,
  ROUTE_TABLE,
  routeFlags,
  SNAPSHOT_ROUTES,
  snapshotKeyOf,
  type RouteRow,
} from "./route-table";
import { PROJECTS_HEALTH_PATH } from "./routes";

/**
 * Every route `remote/handler.ts` declared in `COMMAND_ROUTES`, `intakeRoute`,
 * `projectRoute` and `globalRoute` before the table existed: this list is what
 * pins "no behaviour change" when the handler reads the table instead.
 */
const EXPECTED: [string, string, string, string][] = [
  // [method, path, scope, what]
  ["GET", "/api/intake", "project", "snapshot intake"],
  ["GET", "/api/intake/metrics", "project", "remote-only intake-metrics"],
  ["GET", "/api/intake/session", "project", "remote-only intake-session"],
  ["POST", "/api/intake/login", "project", "remote-only intake-login"],
  ["POST", "/api/intake/logout", "project", "remote-only intake-logout"],
  ["POST", "/api/control", "project", "command control"],
  ["POST", "/api/start", "project", "command start"],
  ["POST", "/api/restart", "project", "command restart"],
  ["POST", "/api/stop-now", "project", "command stop-now"],
  ["POST", "/api/resume-work", "project", "command resume-work"],
  ["POST", "/api/agents/start", "project", "command agent-start"],
  ["POST", "/api/notifications/read", "project", "command mark-read"],
  ["POST", "/api/evals/start", "project", "command eval-start"],
  ["POST", "/api/evals/stop", "project", "command eval-stop"],
  ["POST", "/api/evals/set/add", "project", "command eval-set-add"],
  ["POST", "/api/evals/set/edit", "project", "command eval-set-edit"],
  ["POST", "/api/evals/set/retire", "project", "command eval-set-retire"],
  ["POST", "/api/evals/set/check", "project", "command eval-set-check"],
  ["POST", "/api/evals/set/keep", "project", "command eval-set-keep"],
  ["POST", "/api/evals/inbox/add", "project", "command eval-inbox-add"],
  ["POST", "/api/evals/inbox/start", "project", "command eval-inbox-start"],
  ["POST", "/api/evals/inbox/dismiss", "project", "command eval-inbox-dismiss"],
  ["POST", "/api/evals/improve/propose", "project", "command eval-improve-propose"],
  ["POST", "/api/evals/set/calibrate", "project", "command eval-set-calibrate"],
  ["POST", "/api/evals/proposals/open-pr", "project", "command eval-proposal-open-pr"],
  ["GET", "/api/loops", "project", "snapshot dashboard"],
  ["GET", "/api/ownership", "project", "derived dashboard ownership"],
  ["GET", "/api/frontier", "project", "derived dashboard frontier"],
  ["GET", "/api/notifications", "project", "snapshot notifications"],
  ["GET", "/api/usage", "project", "snapshot usage"],
  ["GET", "/api/controls", "project", "snapshot controls"],
  ["GET", "/api/setup", "project", "snapshot setup"],
  ["POST", "/api/setup", "project", "local-only POST /api/setup"],
  ["GET", "/api/agents", "project", "snapshot agents"],
  ["POST", "/api/agents", "project", "local-only POST /api/agents"],
  ["GET", "/api/lineup", "loop", "snapshot lineup/<loop>"],
  ["GET", "/api/roots", "project", "snapshot roots"],
  ["GET", "/api/jav", "project", "snapshot jav"],
  ["GET", "/api/settings", "project", "snapshot settings"],
  ["GET", "/api/settings/prompts", "project", "snapshot prompts"],
  ["GET", "/api/sentinel", "project", "snapshot sentinel"],
  ["GET", "/api/evals", "project", "snapshot evals"],
  ["GET", "/api/evals/patches", "project", "snapshot evals-patches"],
  ["GET", "/api/evals/set", "project", "snapshot evals-set"],
  ["GET", "/api/evals/suggestions", "project", "snapshot evals-suggestions"],
  ["GET", "/api/evals/inbox", "project", "snapshot evals-inbox"],
  ["GET", "/api/evals/proposals", "project", "snapshot evals-proposals"],
  ["GET", "/api/bridge", "project", "remote-only bridge"],
  ["GET", "/api/versions", "project", "remote-only versions"],
  ["GET", "/api/setup/defaults", "project", "local-only GET /api/setup/defaults"],
  ["GET", "/api/lineup/catalog", "project", "local-only GET /api/lineup/catalog"],
  ["GET", "/api/evals/set/case", "project", "local-only GET /api/evals/set/case"],
  ["GET", "/api/lineup/updates", "project", "local-only GET /api/lineup/updates"],
  ["GET", "/api/agents/guide", "project", "local-only GET /api/agents/guide"],
  ["GET", "/api/agents/preflight", "project", "local-only GET /api/agents/preflight"],
  ["GET", "/api/agents/verifier", "project", "local-only GET /api/agents/verifier"],
  ["POST", "/api/agents/verifier", "project", "local-only POST /api/agents/verifier"],
  ["GET", "/api/agents/sentinel", "project", "local-only GET /api/agents/sentinel"],
  ["POST", "/api/agents/sentinel", "project", "local-only POST /api/agents/sentinel"],
  ["POST", "/api/settings/project", "project", "local-only POST /api/settings/project"],
  ["GET", "/api/settings/gates/run", "project", "local-only GET /api/settings/gates/run"],
  ["POST", "/api/settings/gates/run", "project", "local-only POST /api/settings/gates/run"],
  ["POST", "/api/settings/worktrees", "project", "local-only POST /api/settings/worktrees"],
  ["POST", "/api/settings/worktrees/cleanup", "project", "local-only POST /api/settings/worktrees/cleanup"],
  ["POST", "/api/setup/validate", "project", "local-only POST /api/setup/validate"],
  ["POST", "/api/setup/tracker/test", "project", "local-only POST /api/setup/tracker/test"],
  ["POST", "/api/setup/tracker/save", "project", "local-only POST /api/setup/tracker/save"],
  ["POST", "/api/agents/delete", "project", "local-only POST /api/agents/delete"],
  ["POST", "/api/agents/checkout", "project", "local-only POST /api/agents/checkout"],
  ["POST", "/api/agents/setup", "project", "local-only POST /api/agents/setup"],
  ["POST", "/api/doctor", "project", "local-only POST /api/doctor"],
  ["POST", "/api/lineup/preview", "project", "local-only POST /api/lineup/preview"],
  ["POST", "/api/lineup/edit", "project", "local-only POST /api/lineup/edit"],
  ["POST", "/api/lineup/save", "project", "local-only POST /api/lineup/save"],
  ["POST", "/api/lineup/updates/answer", "project", "local-only POST /api/lineup/updates/answer"],
  ["POST", "/api/jav/save", "project", "local-only POST /api/jav/save"],
  ["GET", "/api/sleep", "project", "local-only GET /api/sleep"],
  ["POST", "/api/sleep", "project", "local-only POST /api/sleep"],
  ["POST", "/api/learnings/file", "project", "local-only POST /api/learnings/file"],
  ["GET", "/api/evals/patch", "project", "derived evals-patches eval-patch"],
  ["GET", "/api/labels", "project", "local-only GET /api/labels"],
  ["POST", "/api/chat", "project", "local-only POST /api/chat"],
  ["GET", "/api/chat/<id>", "project", "local-only GET /api/chat/<id>"],
  ["DELETE", "/api/chat/<id>", "project", "local-only DELETE /api/chat/<id>"],
  ["POST", "/api/chat/<id>/turn", "project", "local-only POST /api/chat/<id>/turn"],
  ["GET", "/api/chat/<id>/events", "project", "local-only GET /api/chat/<id>/events"],
  ["POST", "/api/chat/<id>/mode", "project", "local-only POST /api/chat/<id>/mode"],
  ["POST", "/api/chat/<id>/stop-and-fix", "project", "local-only POST /api/chat/<id>/stop-and-fix"],
  ["POST", "/api/chat/<id>/handback", "project", "local-only POST /api/chat/<id>/handback"],
  ["GET", "/api/commands/<id>", "project", "remote-only command-view"],
  ["GET", "/api/loops/<loop>", "loop", "derived dashboard loop-panel"],
  ["GET", "/api/loops/<loop>/control", "loop", "snapshot control/<loop>"],
  ["GET", "/api/loops/<loop>/checkout", "loop", "snapshot checkout/<loop>"],
  ["GET", "/api/loops/<loop>/history", "loop", "snapshot history/<loop>"],
  ["GET", "/api/loops/<loop>/notifications", "loop", "derived notifications loop-feed"],
  ["GET", "/api/loops/<loop>/output", "loop", "output"],
  ["GET", "/api/stream", "project", "stream"],
  ["GET", "/api/projects", "global", "snapshot _/projects"],
  ["POST", "/api/projects", "global", "local-only POST /api/projects"],
  ["GET", "/api/projects/health", "global", "derived _/health health-without-selected"],
  ["POST", "/api/projects/remove", "global", "local-only POST /api/projects/remove"],
  ["POST", "/api/projects/pick-folder", "global", "local-only POST /api/projects/pick-folder"],
  ["GET", "/api/github/repos", "global", "local-only GET /api/github/repos"],
];

const describeRow = (row: RouteRow): string => {
  switch (row.kind) {
    case "snapshot":
      return `snapshot ${row.key}`;
    case "derived":
      return `derived ${row.source} ${row.projection}`;
    case "command":
      return `command ${row.command}`;
    case "local-only":
      return `local-only ${row.label}`;
    case "output":
      return "output";
    case "stream":
      return "stream";
    case "remote-only":
      return `remote-only ${row.serves}`;
  }
};

describe("ROUTE_TABLE", () => {
  it("has exactly the routes the remote handler declared, one row per (method, path)", () => {
    const actual = ROUTE_TABLE.map((row) => [row.method, row.path, row.scope, describeRow(row)]);
    expect([...actual].sort()).toEqual([...EXPECTED].sort());
    const keys = ROUTE_TABLE.map((row) => `${row.method} ${row.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps GET before POST or DELETE on a path that has both", () => {
    // The order of a 405's `allow`: the local chat answers `GET, DELETE`.
    const rank = { GET: 0, POST: 1, DELETE: 2 } as const;
    for (const path of new Set(ROUTE_TABLE.map((row) => row.path))) {
      const methods = ROUTE_TABLE.filter((row) => row.path === path).map((row) => row.method);
      expect(methods, path).toEqual([...methods].sort((a, b) => rank[a] - rank[b]));
    }
    expect(matchRoute("/api/chat/c1", "project")?.rows.map((row) => row.method)).toEqual(["GET", "DELETE"]);
  });

  it("marks the five intake routes and nothing else", () => {
    expect(ROUTE_TABLE.filter((row) => row.intake).map((row) => row.path)).toEqual([
      "/api/intake",
      "/api/intake/metrics",
      "/api/intake/session",
      "/api/intake/login",
      "/api/intake/logout",
    ]);
  });

  it("relays exactly the command rows and keeps exactly the local-only rows local", () => {
    for (const row of ROUTE_TABLE) {
      expect(row.relays, `${row.method} ${row.path}`).toBe(row.kind === "command");
      expect(row.localOnly, `${row.method} ${row.path}`).toBe(row.kind === "local-only");
    }
  });

  it("relays exactly the contracts' command kinds, each through its own parser", () => {
    const commands = ROUTE_TABLE.flatMap((row) => (row.kind === "command" ? [row] : []));
    expect(commands.map((row) => row.command).sort()).toEqual([...RELAYED_COMMAND_KINDS].sort());
    for (const row of commands) expect(row.parse).toBe(COMMAND_PARSERS[row.command]);
  });

  it("spells the health path as routes.ts does", () => {
    expect(ROUTE_TABLE.some((row) => row.path === PROJECTS_HEALTH_PATH)).toBe(true);
  });

  it("reads every loop from its path segment except the lineup's query", () => {
    for (const row of ROUTE_TABLE) {
      const expected = row.scope !== "loop" ? null : row.path === "/api/lineup" ? "query" : "path";
      expect(row.loopFrom, row.path).toBe(expected);
    }
  });
});

describe("the bridge lists", () => {
  it("collects exactly the snapshots the bridge stores", () => {
    const expected = [
      { scope: "global", key: "_/projects", path: "/api/projects" },
      { scope: "global", key: "_/health", path: "/api/projects/health" },
      { scope: "project", key: "dashboard", path: "/api/loops" },
      { scope: "project", key: "controls", path: "/api/controls" },
      { scope: "loop", key: "control/<loop>", path: "/api/loops/<loop>/control" },
      { scope: "loop", key: "checkout/<loop>", path: "/api/loops/<loop>/checkout" },
      { scope: "loop", key: "history/<loop>", path: "/api/loops/<loop>/history" },
      { scope: "project", key: "notifications", path: "/api/notifications" },
      { scope: "project", key: "usage", path: "/api/usage" },
      { scope: "project", key: "setup", path: "/api/setup" },
      { scope: "project", key: "agents", path: "/api/agents" },
      { scope: "loop", key: "lineup/<loop>", path: "/api/lineup?loop=<loop>" },
      { scope: "project", key: "roots", path: "/api/roots" },
      { scope: "project", key: "jav", path: "/api/jav" },
      { scope: "project", key: "settings", path: "/api/settings" },
      { scope: "project", key: "prompts", path: "/api/settings/prompts" },
      { scope: "project", key: "sentinel", path: "/api/sentinel" },
      { scope: "project", key: "evals", path: "/api/evals" },
      { scope: "project", key: "evals-patches", path: "/api/evals/patches" },
      { scope: "project", key: "evals-set", path: "/api/evals/set" },
      { scope: "project", key: "evals-suggestions", path: "/api/evals/suggestions" },
      { scope: "project", key: "evals-inbox", path: "/api/evals/inbox" },
      { scope: "project", key: "evals-proposals", path: "/api/evals/proposals" },
      { scope: "project", key: "intake", path: "/api/intake" },
      { scope: "project", key: "intake-metrics", path: "/api/intake/metrics" },
    ];
    const order = (entry: { key: string }): string => entry.key;
    expect([...SNAPSHOT_ROUTES].sort((a, b) => order(a).localeCompare(order(b)))).toEqual(
      [...expected].sort((a, b) => order(a).localeCompare(order(b))),
    );
  });

  it("probes the project list first, with every global read before the rest", () => {
    expect(SNAPSHOT_ROUTES[0]?.key).toBe("_/projects");
    const firstOther = SNAPSHOT_ROUTES.findIndex((entry) => entry.scope !== "global");
    expect(SNAPSHOT_ROUTES.slice(firstOther).some((entry) => entry.scope === "global")).toBe(false);
  });

  it("collects on a non-snapshot row only where the row says so", () => {
    const explicit = ROUTE_TABLE.filter((row) => row.kind !== "snapshot" && row.collects !== null);
    expect(explicit.map((row) => `${row.method} ${row.path} ${row.collects}`)).toEqual([
      "GET /api/intake/metrics intake-metrics",
      "GET /api/projects/health _/health",
    ]);
    for (const row of ROUTE_TABLE) if (row.kind === "snapshot") expect(row.collects).toBe(row.key);
  });

  it("relays each command kind to one path", () => {
    expect(RELAY_ROUTES).toEqual({
      control: "/api/control",
      start: "/api/start",
      restart: "/api/restart",
      "stop-now": "/api/stop-now",
      "resume-work": "/api/resume-work",
      "agent-start": "/api/agents/start",
      "mark-read": "/api/notifications/read",
      "eval-start": "/api/evals/start",
      "eval-stop": "/api/evals/stop",
      "eval-set-add": "/api/evals/set/add",
      "eval-set-edit": "/api/evals/set/edit",
      "eval-set-retire": "/api/evals/set/retire",
      "eval-set-check": "/api/evals/set/check",
      "eval-set-keep": "/api/evals/set/keep",
      "eval-inbox-add": "/api/evals/inbox/add",
      "eval-inbox-start": "/api/evals/inbox/start",
      "eval-inbox-dismiss": "/api/evals/inbox/dismiss",
      "eval-improve-propose": "/api/evals/improve/propose",
      "eval-set-calibrate": "/api/evals/set/calibrate",
      "eval-proposal-open-pr": "/api/evals/proposals/open-pr",
    });
    expect(Object.keys(RELAY_ROUTES).sort()).toEqual([...RELAYED_COMMAND_KINDS].sort());
    expect(Object.keys(RELAY_ROUTES).sort()).toEqual(Object.keys(COMMAND_PARSERS).sort());
  });

  it("lists the local-only rows, none of which the bridge reads or relays to", () => {
    expect(LOCAL_ONLY_ROUTES).toEqual(
      ROUTE_TABLE.filter((row) => row.kind === "local-only").map((row) => ({ method: row.method, path: row.path })),
    );
    for (const entry of LOCAL_ONLY_ROUTES) expect(Object.keys(entry).sort()).toEqual(["method", "path"]);
    const local = new Set(LOCAL_ONLY_ROUTES.map((entry) => `${entry.method} ${entry.path}`));
    for (const entry of SNAPSHOT_ROUTES) expect(local.has(`GET ${entry.path.split("?")[0]}`), entry.path).toBe(false);
    for (const path of Object.values(RELAY_ROUTES)) expect(local.has(`POST ${path}`), path).toBe(false);
  });
});

describe("matchRoute", () => {
  it("matches a project path to every method on it", () => {
    const match = matchRoute("/api/setup", "project");
    expect(match?.rows.map((row) => row.method)).toEqual(["GET", "POST"]);
    expect(match?.params).toEqual({});
  });

  it("matches a global path only at the top level", () => {
    expect(matchRoute("/api/projects", "global")?.rows.map((row) => row.method)).toEqual(["GET", "POST"]);
    expect(matchRoute("/api/projects", "project")).toBeNull();
    expect(matchRoute("/api/loops", "global")).toBeNull();
    expect(matchRoute("/api/loops/ralph", "global")).toBeNull();
  });

  it("decodes a loop or command id segment", () => {
    const loop = matchRoute("/api/loops/a%20b/control", "project");
    expect(loop?.rows[0]?.path).toBe("/api/loops/<loop>/control");
    expect(loop?.params).toEqual({ loop: "a b" });
    const panel = matchRoute("/api/loops/ralph", "project");
    expect(panel?.rows[0]?.path).toBe("/api/loops/<loop>");
    expect(panel?.params).toEqual({ loop: "ralph" });
    const view = matchRoute("/api/commands/abc%2Fdef", "project");
    expect(view?.rows[0]?.kind).toBe("remote-only");
    expect(view?.params).toEqual({ id: "abc/def" });
    // The chat's id is a project-scope placeholder too, on each of its tails.
    const turn = matchRoute("/api/chat/c%201/turn", "project");
    expect(turn?.rows.map(describeRow)).toEqual(["local-only POST /api/chat/<id>/turn"]);
    expect(turn?.params).toEqual({ id: "c 1" });
    expect(matchRoute("/api/chat/c1", "global")).toBeNull();
    expect(matchRoute("/api/chat/c1/nope", "project")).toBeNull();
  });

  it("serves /api/loops as the dashboard snapshot, not a loop row", () => {
    const rows = matchRoute("/api/loops", "project")?.rows;
    expect(rows?.map(describeRow)).toEqual(["snapshot dashboard"]);
    expect(rows?.[0]?.scope).toBe("project");
  });

  it("narrows to the rows kept before it decodes a segment", () => {
    expect(() => matchRoute("/api/loops/%E0", "project")).toThrow(URIError);
    expect(matchRoute("/api/loops/%E0", "project", (row) => row.intake)).toBeNull();
    expect(matchRoute("/api/intake", "project", (row) => row.intake)?.rows.map((row) => row.method)).toEqual(["GET"]);
  });

  it("matches nothing for an unknown path, an extra segment or an empty segment", () => {
    expect(matchRoute("/api/loops/a/b", "project")).toBeNull();
    expect(matchRoute("/api/nope", "project")).toBeNull();
    expect(matchRoute("/api/nope", "global")).toBeNull();
    expect(matchRoute("/api/loops//control", "project")).toBeNull();
    expect(matchRoute("/api/commands/", "project")).toBeNull();
  });
});

describe("routeFlags", () => {
  it("answers the flags of one method on one path", () => {
    expect(routeFlags("POST", "/api/control")).toEqual({ relays: true, localOnly: false });
    expect(routeFlags("POST", "/api/setup")).toEqual({ relays: false, localOnly: true });
    expect(routeFlags("GET", "/api/setup")).toEqual({ relays: false, localOnly: false });
    expect(routeFlags("POST", "/api/projects/remove")).toEqual({ relays: false, localOnly: true });
    expect(routeFlags("GET", "/api/loops/ralph/history")).toEqual({ relays: false, localOnly: false });
  });

  it("answers null where nothing serves the method or the path", () => {
    expect(routeFlags("GET", "/api/control")).toBeNull();
    expect(routeFlags("POST", "/api/nope")).toBeNull();
  });
});

describe("snapshotKeyOf", () => {
  const snapshotRow = (path: string, scope: "global" | "project", search = new URLSearchParams()): string => {
    const match = matchRoute(path, scope)!;
    const row = match.rows.find((entry) => entry.method === "GET")!;
    if (row.kind !== "snapshot") throw new Error(`${path} is not a snapshot`);
    return snapshotKeyOf(row, match.params, search);
  };

  it("resolves the loop from the path", () => {
    expect(snapshotRow("/api/loops/ralph/control", "project")).toBe("control/ralph");
    expect(snapshotRow("/api/loops/ralph/checkout", "project")).toBe("checkout/ralph");
    expect(snapshotRow("/api/loops/ralph/history", "project")).toBe("history/ralph");
  });

  it("resolves the lineup's loop from the query, defaulting to empty", () => {
    expect(snapshotRow("/api/lineup", "project", new URLSearchParams("loop=rafa"))).toBe("lineup/rafa");
    expect(snapshotRow("/api/lineup", "project")).toBe("lineup/");
  });

  it("puts a loop name with `$` patterns into the key as it is", () => {
    expect(snapshotRow("/api/loops/%24%26/control", "project")).toBe("control/$&");
    expect(snapshotRow("/api/lineup", "project", new URLSearchParams("loop=$$"))).toBe("lineup/$$");
  });

  it("leaves a fixed key as it is", () => {
    expect(snapshotRow("/api/loops", "project")).toBe("dashboard");
    expect(snapshotRow("/api/projects", "global")).toBe("_/projects");
  });
});

describe("the projections", () => {
  const dashboard = {
    loops: [{ loop: "ralph" }, { loop: "rafa" }],
    ownership: { claims: [] },
    frontier: { buckets: [] },
  } as unknown as Dashboard;
  const notifications = {
    loops: [{ loop: "ralph", unread: 1 }],
    recent: [],
    unread: 1,
  } as unknown as NotificationsView;
  const health = {
    selected: null,
    projects: [{ project: "a" }, { project: "b" }],
  } as unknown as ProjectsHealthView;
  const input = (loop: string, query = ""): { loop: string; search: URLSearchParams } => ({
    loop,
    search: new URLSearchParams(query),
  });

  it("projects the dashboard's ownership and frontier", () => {
    expect(ownershipOf(dashboard)).toBe(dashboard.ownership);
    expect(frontierOf(dashboard)).toBe(dashboard.frontier);
    expect(PROJECTIONS.ownership(dashboard, input(""))).toEqual({ found: true, body: dashboard.ownership });
    expect(PROJECTIONS.frontier(dashboard, input(""))).toEqual({ found: true, body: dashboard.frontier });
  });

  it("finds a loop's panel, or says it found none", () => {
    expect(loopPanelOf(dashboard, "rafa")).toBe(dashboard.loops[1]);
    expect(loopPanelOf(dashboard, "nope")).toBeUndefined();
    expect(PROJECTIONS["loop-panel"](dashboard, input("ralph"))).toEqual({ found: true, body: dashboard.loops[0] });
    expect(PROJECTIONS["loop-panel"](dashboard, input("nope"))).toEqual({ found: false });
  });

  it("finds a loop's feed, or says it found none", () => {
    expect(loopFeedOf(notifications, "ralph")).toBe(notifications.loops[0]);
    expect(loopFeedOf(notifications, "rafa")).toBeUndefined();
    expect(PROJECTIONS["loop-feed"](notifications, input("ralph"))).toEqual({ found: true, body: notifications.loops[0] });
    expect(PROJECTIONS["loop-feed"](notifications, input("rafa"))).toEqual({ found: false });
  });

  it("leaves the selected project out of the health view", () => {
    expect(healthWithout(health, "a")).toEqual({ selected: "a", projects: [{ project: "b" }] });
    expect(healthWithout(health, null)).toEqual({ selected: null, projects: health.projects });
    expect(PROJECTIONS["health-without-selected"](health, input("", "selected=b"))).toEqual({
      found: true,
      body: { selected: "b", projects: [{ project: "a" }] },
    });
  });

  describe("eval-patch", () => {
    const patches: EvalPatchesView = {
      enabled: true,
      patches: [
        { run: "r1", case: "c1", arm: "a", text: "diff --git a/x b/x\n+one\n", truncated: false },
        { run: "r1", case: "c1", arm: "b", text: "diff --git a/y b/y\n+two", truncated: true },
      ],
      omitted: 1,
      problem: null,
    };
    const trial = (run: string, kase: string, arm: string): string =>
      new URLSearchParams({ run, case: kase, arm }).toString();

    it("answers a relayed trial's patch as a diff", () => {
      expect(PROJECTIONS["eval-patch"](patches, input("", trial("r1", "c1", "a")))).toEqual({
        found: true,
        body: "diff --git a/x b/x\n+one\n",
        contentType: "text/x-diff; charset=utf-8",
      });
    });

    it("ends a cut patch with a comment line that says so", () => {
      const result = PROJECTIONS["eval-patch"](patches, input("", trial("r1", "c1", "b")));
      expect(result.found).toBe(true);
      const body = result.found ? String(result.body) : "";
      expect(body.startsWith("diff --git a/y b/y\n+two\n# ")).toBe(true);
      expect(body).toMatch(/# patch cut at the relay budget.*\n$/);
    });

    it("says the project does not relay patches when it did not opt in", () => {
      const disabled: EvalPatchesView = { enabled: false, patches: [], omitted: 0, problem: null };
      expect(PROJECTIONS["eval-patch"](disabled, input("", trial("r1", "c1", "a")))).toEqual({
        found: false,
        why: "this project does not relay eval patches; open the patch on the local dashboard",
      });
    });

    it("says the machine's read failed rather than calling it an opt-out", () => {
      const failed: EvalPatchesView = { enabled: false, patches: [], omitted: 0, problem: "experiments.ts patches exited 1" };
      const result = PROJECTIONS["eval-patch"](failed, input("", trial("r1", "c1", "a")));
      expect(result.found).toBe(false);
      expect(result.found ? "" : result.why).toContain("could not read the relayed eval patches (experiments.ts patches exited 1)");
    });

    it("names a trial the snapshot left out, and points at the local dashboard", () => {
      const result = PROJECTIONS["eval-patch"](patches, input("", trial("r1", "c2", "a")));
      expect(result.found).toBe(false);
      const why = result.found ? "" : (result.why ?? "");
      expect(why).toContain("r1/c2/a");
      expect(why).toContain("size budget");
      expect(why).toContain("local dashboard");
    });

    it("finds nothing when the query names no trial", () => {
      const result = PROJECTIONS["eval-patch"](patches, input(""));
      expect(result.found).toBe(false);
      expect(result.found ? "" : result.why).toContain("//");
    });
  });
});

describe("the browser-safe import graph", () => {
  it("reaches only the contracts and the parser leaf, and no package", () => {
    const repo = resolve(import.meta.dirname, "..");
    const seen = new Set<string>();
    const packages = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const [, specifier] of readFileSync(file, "utf8").matchAll(/(?:from\s+|import\()\s*["']([^"']+)["']/g)) {
        if (specifier!.startsWith(".")) walk(resolve(dirname(file), `${specifier}.ts`));
        else packages.add(specifier!);
      }
    };
    walk(join(repo, "dashboard", "route-table.ts"));
    const files = [...seen].map((file) => file.slice(repo.length + 1)).sort();
    expect(files).toEqual(["dashboard/command-requests.ts", "dashboard/contracts.ts", "dashboard/route-table.ts"]);
    expect([...packages]).toEqual([]);
  });
});
