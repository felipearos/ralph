/**
 * The route table (`route-table.ts`) and the local server held together in
 * both directions (#630): every row the local server should serve is
 * answered by it, and every API path a route module answers has a row. The
 * server is built in-process with every option supplied, so every route
 * module is wired; the fakes cannot act, because the test only asks whether a
 * route is ANSWERED — anything but the generic `{ error: "not found" }` 404 or
 * a 405 — not whether it succeeds.
 */
import { describe, expect, it, vi } from "vitest";

import * as agentsRoutes from "./agents-routes";
import { ChatSessions } from "./chat";
import * as chatRoutes from "./chat-routes";
import { coderRoster, type RuntimeSnapshot } from "./contracts";
import * as controlRoutes from "./control-routes";
import * as doctorRoutes from "./doctor-routes";
import * as intakeRoutes from "./intake-routes";
import * as javRoutes from "./jav-routes";
import * as lifecycleRoutes from "./lifecycle-routes";
import * as onboardingRoutes from "./onboarding-routes";
import * as projectSleepRoutes from "./project-sleep-routes";
import * as recordsRoutes from "./records-routes";
import { matchRoute, ROUTE_TABLE, type RouteMethod, type RouteRow } from "./route-table";
import * as routes from "./routes";
import { createHandler, type ProjectScope } from "./server";
import { createHandler as createLineupHandler, ROUTES as LINEUP_ROUTES } from "../lineup/server";

const PROJECT = "alpha";
const LOOP = "ralph";
const CHAT_ID = "chat-1";
// Never created: the aggregate is pure, and every fake that would touch a
// checkout refuses before it does.
const WORKTREE = "/nonexistent/route-coverage/alpha";

/**
 * An object whose every method throws, except the ones given; never thenable.
 * It throws rather than rejects: an adapter method may be sync, and a promise
 * it never awaits would reject unhandled instead of failing the route.
 */
function stub<T>(known: Record<string, unknown> = {}): T {
  return new Proxy(known, {
    get: (target, key) => {
      if (key in target) return target[key as string];
      // A `then` would make the stub a thenable, and awaiting it would hang.
      if (key === "then") return undefined;
      return () => {
        throw new Error(`${String(key)} is not in this test`);
      };
    },
  }) as T;
}

const refuse = (): never => {
  throw new Error("this fake cannot act");
};

const runtime = (): RuntimeSnapshot => {
  const state = {
    version: 1 as const,
    run: "run-alpha",
    owner: { loop: LOOP, pid: null, host: "test" },
    worktree: WORKTREE,
    branch: "ralph/14",
    stage: "iteration" as const,
    iteration: { index: 1, max: 10 },
    heartbeat: "2026-10-09T00:00:00.000Z",
    lastEvent: null,
    stopReason: null,
  };
  return {
    roster: coderRoster(LOOP, "rafa"),
    loops: [
      {
        worktree: WORKTREE,
        identity: LOOP,
        loopStatus: "running",
        worktreeStatus: "live",
        branch: "ralph/14",
        state,
        stateProblem: null,
        supervisor: "alive",
        presence: null,
      },
    ],
    reconciliation: { orphaned: [], prunable: [] },
  };
};

/** The local dashboard with one project and every route module mounted. */
function machine() {
  const scope: ProjectScope = {
    project: { id: PROJECT, path: WORKTREE, addedAt: "2026-10-01T00:00:00.000Z", source: "local" },
    adapter: { read: async () => runtime() },
    usage: vi.fn(async () => ({}) as never),
    intake: stub(),
    sleep: stub(),
    learningsFile: stub(),
    evals: stub(),
    health: async () => ({}) as never,
    plan: async () => null,
  };
  return createHandler({
    projects: () => [scope],
    shell: "<html>shell</html>",
    clock: () => ({ nowMs: Date.parse("2026-10-09T00:00:05.000Z") }),
    controlStatus: async () => ({ kind: "unreadable", why: "not in this test" }),
    controls: refuse,
    lifecycle: refuse,
    interrupt: refuse,
    doctor: refuse,
    // The real editor over a refusing adapter, so its own 404s and 405s stand.
    lineup: createLineupHandler({ adapter: stub({ roots: [] }) }),
    jav: stub(),
    records: refuse,
    output: vi.fn(() => ({ stop: () => undefined })),
    chats: new ChatSessions({ claude: refuse, redactor: refuse }),
    handback: refuse,
    // Ready, so a start is not refused before its route sees it.
    onboarding: stub({ status: async () => ({ status: "ready" }) }),
    agents: () => stub({ agents: stub(), exec: async () => ({ status: 1, stdout: "", stderr: "not in this test" }) }),
    registry: stub(),
  });
}

const local = machine();

type Verdict = "answered" | "generic 404" | "405";

/** Send one request and say whether a route answered it. */
async function answer(method: RouteMethod, path: string): Promise<{ verdict: Verdict; status: number; text: string }> {
  // The output route holds its response open: abort it once it has answered.
  const abort = new AbortController();
  const response = await local(
    new Request(`http://127.0.0.1${path}`, {
      method,
      signal: abort.signal,
      headers: { "sec-fetch-site": "same-origin", ...(method === "GET" ? {} : { "content-type": "application/json" }) },
      ...(method === "GET" ? {} : { body: "{}" }),
    }),
  );
  let text = "";
  if (response.headers.get("content-type")?.startsWith("text/event-stream")) {
    abort.abort();
    await response.body?.cancel();
  } else {
    text = await response.text();
  }
  let generic = false;
  if (response.status === 404) {
    try {
      generic = JSON.stringify(JSON.parse(text)) === JSON.stringify({ error: "not found" });
    } catch {
      // A non-JSON 404 is some route's own answer, not the generic fallback.
    }
  }
  const verdict: Verdict = generic ? "generic 404" : response.status === 405 ? "405" : "answered";
  return { verdict, status: response.status, text };
}

/** A row's path as a request: placeholders filled, scoped under the project unless global. */
function requestPath(entry: RouteRow): string {
  const unscoped = entry.path.replace("<loop>", LOOP).replace("<id>", CHAT_ID);
  const query = entry.loopFrom === "query" ? `?loop=${LOOP}` : "";
  return entry.scope === "global" ? `${unscoped}${query}` : `/api/p/${PROJECT}${unscoped.slice("/api".length)}${query}`;
}

describe("every table row is answered by the local server", () => {
  // The hosted function alone serves the remote-only rows: none has a local twin.
  const rows = ROUTE_TABLE.filter((entry) => entry.kind !== "remote-only");

  it.each(rows.map((entry) => [`${entry.method} ${entry.path}`, entry] as const))("%s", async (name, entry) => {
    const { verdict, status, text } = await answer(entry.method, requestPath(entry));
    expect({ row: name, verdict }, `row ${name} has no local twin (${status} ${text.slice(0, 200)})`).toEqual({
      row: name,
      verdict: "answered",
    });
  });
});

/**
 * The paths the route modules answer, read off the modules so a new route
 * constant is a new candidate without anyone copying it here.
 */
const MODULES = {
  agentsRoutes,
  chatRoutes,
  controlRoutes,
  doctorRoutes,
  intakeRoutes,
  javRoutes,
  lifecycleRoutes,
  onboardingRoutes,
  projectSleepRoutes,
  recordsRoutes,
  routes,
};

const CANDIDATES: readonly string[] = [
  ...new Set([
    ...Object.values(MODULES).flatMap((module) =>
      Object.values(module).filter((value): value is string => typeof value === "string" && value.startsWith("/api/")),
    ),
    ...Object.keys(LINEUP_ROUTES),
    // Matched by regex in their modules (chat-routes.ts CHAT_ID_PATH,
    // lifecycle-routes.ts CHECKOUT_PATH, records-routes.ts LOOP_RECORD_PATH,
    // server.ts's table-read GETs), so no string constant names them.
    `/api/chat/${CHAT_ID}`,
    `/api/chat/${CHAT_ID}/turn`,
    `/api/chat/${CHAT_ID}/events`,
    `/api/chat/${CHAT_ID}/mode`,
    `/api/chat/${CHAT_ID}/stop-and-fix`,
    `/api/chat/${CHAT_ID}/handback`,
    `/api/loops/${LOOP}/control`,
    `/api/loops/${LOOP}/checkout`,
    `/api/loops/${LOOP}/history`,
    `/api/loops/${LOOP}/notifications`,
    `/api/loops/${LOOP}/output`,
    "/api/stream",
  ]),
];

describe("every path the local server answers has a table row", () => {
  it("reads candidates off the modules", () => {
    // A guard against the namespace read silently finding nothing.
    expect(CANDIDATES).toEqual(expect.arrayContaining(["/api/start", "/api/labels", "/api/jav/save", "/api/doctor", "/api/lineup/save", "/api/setup"]));
  });

  it.each(CANDIDATES.map((path) => [path]))("%s", async (path) => {
    const global = matchRoute(path, "global");
    const match = global ?? matchRoute(path, "project");
    expect(match, `${path} is answered locally but has no row in ROUTE_TABLE`).not.toBeNull();

    // And the candidate is live, so the list cannot rot into dead paths.
    const url = global !== null ? path : `/api/p/${PROJECT}${path.slice("/api".length)}`;
    const answered: RouteMethod[] = [];
    for (const method of ["GET", "POST", "DELETE"] as const) {
      if ((await answer(method, url)).verdict === "answered") answered.push(method);
    }
    expect(answered, `${path} is answered by no method locally`).not.toEqual([]);
    // Per method too: a method answered locally with no row is one the remote
    // function would answer with a 405 instead of relaying or refusing it.
    const rowMethods = match!.rows.map((entry) => entry.method);
    expect(answered.filter((method) => !rowMethods.includes(method)), `${path}: methods answered locally with no row`).toEqual([]);
  });

  it("still answers an unknown path with the generic 404", async () => {
    expect((await answer("GET", `/api/p/${PROJECT}/nope`)).verdict).toBe("generic 404");
    expect((await answer("GET", "/api/nope-at-all")).verdict).toBe("generic 404");
  });

  it("answers a malformed escape on a row the server does not serve with the generic 404", async () => {
    // `/api/commands/<id>` is the hosted function's alone: decoding its id here
    // would turn a stray request into the decoder's 500.
    expect((await answer("GET", `/api/p/${PROJECT}/commands/%E0`)).verdict).toBe("generic 404");
  });
});
