// @vitest-environment node
/**
 * The design preview's router, driven in-process against the route table.
 *
 * The preview is the shell over canned loops, and it drifts from production
 * the moment a route is added to one and not the other. These tests pin it to
 * `ROUTE_TABLE`: every GET row is either answered by the preview or listed as
 * deliberately left out, and the command routes judge malformed bodies with
 * the same parsers production uses. Nothing here spawns or listens.
 */
import { describe, expect, it } from "vitest";
import type { Shell } from "./build";
import { COMMAND_PARSERS, ControlRouteError, parseJsonBody } from "./command-requests";
import type { ControlsView, Dashboard, ProjectsHealthView, ProjectsView } from "./contracts";
import { createPreviewRouter } from "./preview";
import { ROUTE_TABLE, type RouteRow } from "./route-table";

const SHELL: Shell = {
  html: "<html><body>shell</body></html>",
  assets: new Map([["/assets/app.js", { body: new TextEncoder().encode("x") as Uint8Array<ArrayBuffer>, type: "text/javascript" }]]),
};

const lineupPaths: string[] = [];
const lineup = (request: Request): Response => {
  lineupPaths.push(new URL(request.url).pathname);
  return Response.json({ fake: "lineup" });
};

// A getter over a mutable binding, as the live rebuild swaps the build under the router.
let current: { shell: Shell; version: number } = { shell: SHELL, version: 42 };
const router = createPreviewRouter({ shell: () => current, lineup, setupPreview: false });

/** A loop the preview's canned roster has. */
const LOOP = "rafa";
const BASE = "http://preview.test";

const GET_ROWS: RouteRow[] = ROUTE_TABLE.filter((row) => row.method === "GET");

/** The URL the shell would use: project rows under `/api/p/preview`, global rows at the top. */
function urlFor(path: string, scope: RouteRow["scope"]): string {
  const concrete = path.replace("<loop>", LOOP);
  return scope === "global" ? `${BASE}${concrete}` : `${BASE}/api/p/preview${concrete.slice("/api".length)}`;
}

const scopeOf = (path: string): RouteRow["scope"] => GET_ROWS.find((row) => row.path === path)!.scope;

const get = (path: string, init?: RequestInit): Promise<Response> => router(new Request(urlFor(path, scopeOf(path)), init));

/** Paths the router hands to the lineup editor (`isLineupPath` in server.ts). */
const LINEUP_ROWS = new Set(["/api/lineup", "/api/lineup/catalog", "/api/lineup/updates", "/api/roots"]);

/** Every GET row the preview answers. */
const PREVIEWED = [
  "/api/loops",
  "/api/ownership",
  "/api/frontier",
  "/api/controls",
  "/api/loops/<loop>",
  "/api/loops/<loop>/control",
  "/api/loops/<loop>/checkout",
  "/api/loops/<loop>/history",
  "/api/loops/<loop>/notifications",
  "/api/loops/<loop>/output",
  // The change stream, over the same composed snapshot; the canned commands nudge it.
  "/api/stream",
  "/api/notifications",
  "/api/usage",
  "/api/setup",
  "/api/lineup",
  "/api/roots",
  "/api/lineup/catalog",
  // Read for real off the harness's models.json; its answer writes nothing in the preview.
  "/api/lineup/updates",
  // The chat module owns both; a real chat is created for the first, and the
  // second is reached with an unknown id because a live chat's events long-poll.
  "/api/chat/<id>",
  "/api/chat/<id>/events",
  "/api/projects",
  "/api/projects/health",
  // Held in memory, so the Sleep project toggle can be tried without a CLI.
  "/api/sleep",
];

/** The GET rows the preview deliberately leaves to the real server or the hosted function. */
const NOT_PREVIEWED: Record<string, string> = {
  "/api/agents": "the agent roster is the real server's; the preview has no Add agent flow",
  "/api/agents/guide": "part of the Add agent flow, local server only",
  "/api/agents/preflight": "part of the Add agent flow, local server only",
  "/api/agents/verifier": "the verifier role's config is read from a real checkout",
  "/api/jav": "the jav editor reads a real project's config",
  "/api/settings": "the Settings overview reads a real checkout's config and worktrees",
  "/api/settings/prompts": "the Prompts section reads a real checkout's fragments and renders its prompts",
  "/api/sentinel": "the Sentinel panel reads a real checkout's config and the sentinel's issue store",
  "/api/evals": "the Evals tab reads a real checkout's experiment logs",
  "/api/evals/patch": "a trial's patch is read off the real host, or from a relayed snapshot on the hosted page",
  "/api/evals/patches": "the relayed trials' patches are a real checkout's, read for the hosted page",
  "/api/evals/set": "the Test set is a real checkout's committed case files",
  "/api/evals/suggestions": "the suggestions are a real checkout's merged PRs, read through gh and the tracker",
  "/api/evals/inbox": "the recommended-runs inbox is a real checkout's experiment logs",
  "/api/evals/proposals": "the improver's proposals are a real checkout's experiment logs",
  "/api/evals/set/case": "a case's notes are graded-only and read off the real host, local server only",
  "/api/agents/sentinel": "the sentinel role's config is read from a real checkout",
  "/api/settings/gates/run": "a gate run executes on the real host, local server only",
  "/api/bridge": "remote-only: the hosted function's bridge status",
  "/api/versions": "remote-only: the hosted function's version-wait for the remote page",
  "/api/intake": "the intake view is the hosted dashboard's",
  "/api/intake/metrics": "remote-only: the hosted intake metrics",
  "/api/intake/session": "remote-only: the hosted intake login session",
  "/api/setup/defaults": "only under RALPH_PREVIEW_SETUP=1, when the project shows as not set up",
  "/api/labels": "reads the tracker's real labels",
  "/api/commands/<id>": "remote-only: a relayed command's status lives on the hosted function",
  "/api/github/repos": "lists real GitHub repositories through gh",
};

describe("the preview covers the route table", () => {
  it("lists every GET row exactly once, in PREVIEWED or NOT_PREVIEWED", () => {
    const table = new Set(GET_ROWS.map((row) => row.path));
    const listed = [...PREVIEWED, ...Object.keys(NOT_PREVIEWED)];
    for (const path of table) {
      expect(listed, `GET ${path} is in ROUTE_TABLE but in neither list: decide whether the preview serves it`).toContain(path);
    }
    for (const path of listed) {
      expect(table.has(path), `${path} is listed but is not a GET row of ROUTE_TABLE: drop the stale entry`).toBe(true);
    }
    const overlap = PREVIEWED.filter((path) => path in NOT_PREVIEWED);
    expect(overlap, "a row is both previewed and not previewed").toEqual([]);
    expect(new Set(PREVIEWED).size, "PREVIEWED lists a row twice").toBe(PREVIEWED.length);
  });

  const plain = PREVIEWED.filter((path) => !LINEUP_ROWS.has(path) && !path.startsWith("/api/chat/") && !path.endsWith("/output") && path !== "/api/stream");

  it.each(plain)("answers GET %s", async (path) => {
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(await response.json()).not.toEqual({ error: "not found" });
  });

  it.each([...LINEUP_ROWS])("hands GET %s to the lineup editor, unscoped", async (path) => {
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ fake: "lineup" });
    expect(lineupPaths.at(-1)).toBe(path);
  });

  it("streams a loop's output until the client goes away", async () => {
    const abort = new AbortController();
    const response = await get("/api/loops/<loop>/output", { signal: abort.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    // Aborting ends the stream's follower and heartbeat, so no timer outlives the test.
    abort.abort();
    await response.body?.cancel();
  });

  it("streams a snapshot change after a pressed Approve, until the client goes away", async () => {
    const abort = new AbortController();
    // Held for the whole case: a Request's signal only follows the controller
    // while the Request itself is reachable, and the stream ends on that signal.
    const request = new Request(urlFor("/api/stream", "project"), { signal: abort.signal });
    const response = await router(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    /** Reads until `done` holds; true when the stream ended first. */
    const readUntil = async (done: (seen: string) => boolean): Promise<boolean> => {
      const deadline = Date.now() + 10_000;
      while (!done(text)) {
        if (Date.now() > deadline) throw new Error(`timed out; read so far: ${JSON.stringify(text)}`);
        const chunk = await reader.read();
        if (chunk.done) return true;
        text += decoder.decode(chunk.value, { stream: true });
      }
      return false;
    };
    await readUntil((seen) => seen.includes("retry:"));
    // The page's own read overlaps the hub's baseline, so once it is back the
    // baseline holds the approval still pending.
    expect((await get("/api/loops")).status).toBe(200);
    // `ralph` is the canned loop waiting on an approval, and no other case reads it.
    const approved = await router(
      new Request(`${BASE}/api/p/preview/control`, { method: "POST", body: JSON.stringify({ loop: "ralph", action: "approve" }) }),
    );
    expect(approved.status).toBe(200);
    await readUntil((seen) => seen.includes('data: {"key":"dashboard","version":'));
    // Aborting ends the stream and its heartbeat, so no timer outlives the test.
    abort.abort();
    expect(await readUntil(() => false)).toBe(true);
    expect(request.signal.aborted).toBe(true);
  });

  it("streams the widgets project's own change, not the preview project's", async () => {
    const abort = new AbortController();
    // Held for the whole case, as above: the stream ends on this signal.
    const request = new Request(`${BASE}/api/p/widgets/stream`, { signal: abort.signal });
    const response = await router(request);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (done: (seen: string) => boolean): Promise<boolean> => {
      const deadline = Date.now() + 10_000;
      while (!done(text)) {
        if (Date.now() > deadline) throw new Error(`timed out; read so far: ${JSON.stringify(text)}`);
        const chunk = await reader.read();
        if (chunk.done) return true;
        text += decoder.decode(chunk.value, { stream: true });
      }
      return false;
    };
    await readUntil((seen) => seen.includes("retry:"));
    expect((await router(new Request(`${BASE}/api/p/widgets/loops`))).status).toBe(200);
    // `wido` lives only in `widgets`: a stream hashing `preview`'s snapshot
    // would never see this pause.
    const control = (action: string) =>
      router(new Request(`${BASE}/api/p/widgets/control`, { method: "POST", body: JSON.stringify({ loop: "wido", action }) }));
    try {
      expect((await control("pause")).status).toBe(200);
      await readUntil((seen) => seen.includes('data: {"key":"dashboard","version":'));
    } finally {
      // Other cases read `wido` running, so the pause does not outlive this one.
      await control("resume");
      abort.abort();
    }
    expect(await readUntil(() => false)).toBe(true);
  });

  it("serves a chat the preview opened", async () => {
    const opened = await router(
      new Request(`${BASE}/api/p/preview/chat`, { method: "POST", body: JSON.stringify({ loop: LOOP }) }),
    );
    expect(opened.status).toBe(201);
    const { id } = (await opened.json()) as { id: string };
    const response = await router(new Request(`${BASE}/api/p/preview/chat/${id}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id, loop: LOOP });
  });

  it("reaches the chat module for an unknown chat's events, not the fall-through", async () => {
    const response = await router(new Request(`${BASE}/api/p/preview/chat/nope/events?after=0`));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "UnknownChat" });
  });

  it.each(Object.keys(NOT_PREVIEWED))("leaves GET %s to the fall-through 404", async (path) => {
    const response = await router(new Request(urlFor(path.replace("<id>", "nope"), scopeOf(path))));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });

  it.each(["/api/ownership", "/api/frontier"])("answers POST %s with the server's 405", async (path) => {
    const response = await router(new Request(urlFor(path, "project"), { method: "POST", body: "{}" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("answers /api/setup/defaults when the setup preview is on", async () => {
    const setup = createPreviewRouter({ shell: () => current, lineup, setupPreview: true });
    const response = await setup(new Request(urlFor("/api/setup/defaults", "project")));
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("config");
  });
});

describe("the preview's shell", () => {
  it.each(["/p/preview/", "/p/preview/states"])("serves the shell at %s with the reload script", async (path) => {
    const response = await router(new Request(`${BASE}${path}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("/__preview/version");
    expect(html.indexOf("/__preview/version")).toBeLessThan(html.indexOf("</body>"));
    expect(html.startsWith("<html><body>shell")).toBe(true);
  });

  it("answers the build version and the build's assets", async () => {
    expect(await (await router(new Request(`${BASE}/__preview/version`))).text()).toBe("42");
    const asset = await router(new Request(`${BASE}/assets/app.js`));
    expect(asset.headers.get("content-type")).toBe("text/javascript");
    expect(await asset.text()).toBe("x");
  });

  it("picks up a rebuilt shell on the next request", async () => {
    const before = current;
    try {
      current = { shell: { html: "<html><body>rebuilt</body></html>", assets: new Map() }, version: 43 };
      expect(await (await router(new Request(`${BASE}/__preview/version`))).text()).toBe("43");
      expect(await (await router(new Request(`${BASE}/p/preview/`))).text()).toContain("rebuilt");
    } finally {
      current = before;
    }
  });
});

const COMMANDS = [
  ["/api/control", "control"],
  ["/api/start", "start"],
  ["/api/restart", "restart"],
  ["/api/stop-now", "stop-now"],
  ["/api/resume-work", "resume-work"],
] as const;

const post = (path: string, body: string): Promise<Response> =>
  router(new Request(`${BASE}/api/p/preview${path.slice("/api".length)}`, { method: "POST", body }));

/** What production answers `raw` with: the shared parsers' error, computed rather than copied. */
function expected(kind: keyof typeof COMMAND_PARSERS, raw: string): { status: number; error: string; message: string } {
  try {
    COMMAND_PARSERS[kind](parseJsonBody(raw));
  } catch (error) {
    if (error instanceof ControlRouteError) return { status: error.status, error: error.name, message: error.message };
    throw error;
  }
  throw new Error(`${kind} accepted ${raw}; the case expects a malformed body`);
}

describe("the preview's command bodies match production", () => {
  const malformed = COMMANDS.flatMap(([path, kind]) => ["{", "[]", "{}"].map((raw) => [path, kind, raw] as const));

  it.each(malformed)("POST %s (%s) answers %s as the parser does", async (path, kind, raw) => {
    const want = expected(kind, raw);
    const response = await post(path, raw);
    expect(response.status).toBe(want.status);
    expect(await response.json()).toEqual({ error: want.error, message: want.message });
  });

  it.each([
    ["/api/control", { loop: LOOP, action: "stop" }],
    ["/api/restart", { loop: LOOP }],
    ["/api/stop-now", { loop: LOOP }],
  ] as const)("POST %s asks for confirmation", async (path, body) => {
    const response = await post(path, JSON.stringify(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "ConfirmationRequired" });
  });

  const wellFormed: Record<(typeof COMMANDS)[number][0], Record<string, unknown>> = {
    "/api/control": { action: "pause" },
    "/api/start": {},
    "/api/restart": { confirm: true },
    "/api/stop-now": { confirm: true },
    "/api/resume-work": {},
  };

  it.each(COMMANDS)("POST %s names an unknown loop with a 404", async (path) => {
    const response = await post(path, JSON.stringify({ loop: "nobody", ...wellFormed[path] }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "UnknownLoop" });
  });

  // These act on the module's canned loops, so only the status is pinned: the
  // outcome depends on what an earlier case left the loop in.
  it.each(COMMANDS)("POST %s acts on a known loop", async (path) => {
    const response = await post(path, JSON.stringify({ loop: LOOP, ...wellFormed[path] }));
    expect(response.status).toBe(200);
  });

  // The parsed body, not the raw one, reaches the canned action: control names it back.
  it("hands control's parsed action to the canned loop", async () => {
    const response = await post("/api/control", JSON.stringify({ loop: LOOP, action: "pause", issue: null }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ loop: LOOP, action: "pause" });
  });
});

/**
 * The projects beside "preview": the rail lists them all, and each one's
 * scoped routes answer its OWN snapshot — its roster, its CI health — rather
 * than the default project's or a 404.
 */
const PROJECTS = {
  preview: { loops: ["rafa", "ralph", "remo", "doc", "tria", "rio"] },
  widgets: { loops: ["wido"] },
  atlas: { loops: ["ada", "ike", "dot"] },
  foundry: { loops: ["dex", "dara", "fern", "flo", "fox", "max"] },
  harbor: { loops: ["hal", "tide", "medi", "vera"] },
  kiln: { loops: ["kit", "kip", "sen"] },
  meadow: { loops: ["mei", "milo"] },
} as const;
const NEW_PROJECTS = Object.keys(PROJECTS).filter((id) => id !== "preview") as Exclude<keyof typeof PROJECTS, "preview">[];

const scoped = (id: string, path: string, init?: RequestInit): Promise<Response> =>
  router(new Request(`${BASE}/api/p/${id}${path.slice("/api".length)}`, init));

describe("the preview's projects", () => {
  it("lists every project, the default first, each with its own path", async () => {
    const { projects } = (await (await router(new Request(`${BASE}/api/projects`))).json()) as ProjectsView;
    expect(projects.map((project) => project.id)).toEqual(["preview", "widgets", "atlas", "foundry", "harbor", "kiln", "meadow"]);
    expect(new Set(projects.map((project) => project.path)).size).toBe(projects.length);
  });

  it("reports every project's health but the selected one's", async () => {
    const response = await router(new Request(`${BASE}/api/projects/health?selected=atlas`));
    expect(response.status).toBe(200);
    const view = (await response.json()) as ProjectsHealthView;
    expect(view.selected).toBe("atlas");
    const byId = Object.fromEntries(view.projects.map((project) => [project.project, project]));
    expect(Object.keys(byId).sort()).toEqual(["foundry", "harbor", "kiln", "meadow", "preview", "widgets"]);
    // An approval hold puts a project on "needs you", as a live one's does.
    expect(byId.foundry).toMatchObject({ health: "needs-you", loops: 6 });
    expect(byId.harbor!.needs).toContainEqual({ loop: "hal", reason: "approval" });
    expect(byId.meadow).toMatchObject({ health: "running", needsYou: 0, running: 1 });
  });

  it("answers an unknown project with a 404", async () => {
    const response = await scoped("nowhere", "/api/loops");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "UnknownProject" });
  });

  it.each(Object.entries(PROJECTS))("serves %s's own roster", async (id, { loops }) => {
    const response = await scoped(id, "/api/loops");
    expect(response.status).toBe(200);
    const dashboard = (await response.json()) as Dashboard;
    expect(dashboard.loops.map((loop) => loop.loop)).toEqual(expect.arrayContaining([...loops]));
    expect(dashboard.loops.filter((loop) => loop.role !== null).map((loop) => loop.loop)).toEqual([...loops]);
  });

  it.each(NEW_PROJECTS)("serves %s's CI page and its scoped reads", async (id) => {
    for (const path of ["/api/controls", "/api/frontier", "/api/ownership", "/api/usage", "/api/setup", "/api/sleep"]) {
      expect((await scoped(id, path)).status, `${id} ${path}`).toBe(200);
    }
    const page = await router(new Request(`${BASE}/p/${id}/ci`));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const { loops } = (await (await scoped(id, "/api/controls")).json()) as ControlsView;
    expect(Object.keys(loops)).toEqual([...PROJECTS[id].loops]);
  });

  it("draws each CI scenario from the project's own store", async () => {
    const ci = async (id: string) => ((await (await scoped(id, "/api/loops")).json()) as Dashboard).ciHealth;
    const atlas = (await ci("atlas"))!.view!;
    expect(atlas.main.state).toBe("green");
    expect(atlas).toMatchObject({ cases: [], incidents: [], parked: [], reverts: [] });
    expect(atlas.retries).toMatchObject({ count: 0, cap: 6, today: true });

    const foundry = (await ci("foundry"))!.view!;
    expect(foundry.main.state).toBe("red");
    expect(foundry.incidents).toHaveLength(2);
    expect(foundry.incidents.filter((incident) => !incident.notified)).toHaveLength(1);
    expect(foundry.cases.length).toBeGreaterThan(12);
    expect(foundry.parked.filter((parked) => parked.unparks.length > 0).length).toBeGreaterThanOrEqual(2);
    expect(foundry.retries).toMatchObject({ count: 6, cap: 6 });
    expect(foundry.reverts.map((revert) => revert.state).sort()).toEqual(["abandoned", "open"]);

    const harbor = (await (await scoped("harbor", "/api/loops")).json()) as Dashboard;
    expect(harbor.loops.some((loop) => loop.role === "ci-doctor")).toBe(false);

    expect(await ci("kiln")).toMatchObject({ view: null, problem: expect.stringContaining("could not read") });

    const meadow = (await ci("meadow"))!.view!;
    expect(meadow.main).toEqual({ state: "unknown", since: null, build: null });
    expect(meadow.metrics.recorded).toBe(false);
  });

  it("keeps a command on one project's loop off every other project", async () => {
    const response = await scoped("atlas", "/api/control", { method: "POST", body: JSON.stringify({ loop: "rafa", action: "pause" }) });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "UnknownLoop" });
    expect((await scoped("atlas", "/api/control", { method: "POST", body: JSON.stringify({ loop: "ada", action: "pause" }) })).status).toBe(200);
  });
});
