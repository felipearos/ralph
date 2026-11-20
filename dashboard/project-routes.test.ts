// @vitest-environment node
/**
 * Project scoping, driven in-process through the real handler with two
 * registered projects that both have a `ralph`.
 *
 * Every assertion is on what crosses the handler's surface: which project's
 * runtime answered, which checkout a write route was handed, the redirect a
 * legacy URL gets, and the 404 an unknown project gets.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { coderRoster } from "./contracts";
import type { RuntimeSnapshot } from "./contracts";
import { createRalphControlAdapter, type Executor } from "./control-adapter";
import type { JavAdapter } from "./jav-adapter";
import { createRecordsAdapter } from "./records-adapter";
import { createHandler, type HandlerOptions, type ProjectScope } from "./server";

const scratch: string[] = [];
afterAll(() => scratch.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A checkout where `ralph` is running run-`id`. */
function checkout(id: string): string {
  const root = mkdtempSync(join(tmpdir(), `ralph-project-routes-${id}-`));
  scratch.push(root);
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  return root;
}

function runtimeAt(worktree: string, run: string): RuntimeSnapshot {
  const state = {
    version: 1 as const,
    run,
    owner: { loop: "ralph", pid: null, host: "test" },
    worktree,
    branch: "ralph/14",
    stage: "iteration" as const,
    iteration: { index: 1, max: 10 },
    heartbeat: "2026-09-15T00:00:00.000Z",
    lastEvent: null,
    stopReason: null,
  };
  writeFileSync(join(worktree, ".ralph", "logs", "state.json"), JSON.stringify(state));
  return {
    roster: coderRoster("ralph", "rafa"),
    loops: [
      {
        worktree,
        identity: "ralph",
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
}

const project = (id: string, path: string) => ({ id, path, addedAt: "2026-09-23T00:00:00.000Z", source: "local" as const });

function twoProjects(over: Partial<HandlerOptions> = {}) {
  const alpha = checkout("alpha");
  const beta = checkout("beta");
  const scopes: ProjectScope[] = [
    {
      project: project("alpha", alpha),
      adapter: { read: vi.fn(async () => runtimeAt(alpha, "run-alpha")) },
      usage: vi.fn(async () => ({ project: "alpha" }) as never),
    },
    {
      project: project("beta", beta),
      adapter: { read: vi.fn(async () => runtimeAt(beta, "run-beta")) },
      usage: vi.fn(async () => ({ project: "beta" }) as never),
    },
  ];
  const exec: Executor = async (invocation) =>
    invocation.args.some((arg) => arg.endsWith("controls.ts"))
      ? { status: 0, stdout: "null", stderr: "" }
      : { status: 1, stdout: "", stderr: "unexpected" };
  const handler = createHandler({
    projects: () => scopes,
    shell: "<html>shell</html>",
    clock: () => ({ nowMs: Date.parse("2026-09-15T00:00:05.000Z") }),
    controls: ({ worktree }) => ({
      adapter: createRalphControlAdapter({ cliDir: "/harness", root: worktree, bunPath: "bun", exec }),
    }),
    records: (worktree) => createRecordsAdapter({ root: worktree }),
    ...over,
  });
  const get = (path: string) => handler(new Request(`http://127.0.0.1${path}`));
  const post = (path: string, body: unknown) =>
    handler(new Request(`http://127.0.0.1${path}`, { method: "POST", body: JSON.stringify(body) }));
  return { alpha, beta, scopes, handler, get, post };
}

const inbox = (root: string): string[] => {
  const dir = join(root, ".ralph", "control", "inbox");
  return existsSync(dir) ? readdirSync(dir).filter((name) => !name.startsWith(".")) : [];
};

describe("the project list", () => {
  it("lists every registered project in order", async () => {
    const { get, alpha, beta } = twoProjects();
    const response = await get("/api/projects");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projects: [project("alpha", alpha), project("beta", beta)] });
  });
});

describe("API routes under /api/p/:project", () => {
  it("answer from the named project's runtime", async () => {
    const { get, scopes } = twoProjects();
    const beta = (await (await get("/api/p/beta/loops/ralph")).json()) as { run: string | null };
    expect(beta).toMatchObject({ loop: "ralph" });
    expect(JSON.stringify(beta)).toContain("run-beta");
    expect(scopes[0]!.adapter.read).not.toHaveBeenCalled();
    // Each project's usage is its own; the account's plan rides beside it.
    expect(await (await get("/api/p/alpha/usage")).json()).toMatchObject({
      project: "alpha",
      account: { scope: "all-projects", projects: ["alpha"] },
    });
    expect(await (await get("/api/p/beta/usage")).json()).toMatchObject({ project: "beta" });
  });

  it("are a 404 for an unknown project, without reading any runtime", async () => {
    const { get, post, scopes } = twoProjects();
    const response = await get("/api/p/nope/loops");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "UnknownProject" });
    expect((await post("/api/p/nope/control", { loop: "ralph", action: "pause" })).status).toBe(404);
    for (const scope of scopes) expect(scope.adapter.read).not.toHaveBeenCalled();
  });

  it("resolve legacy unscoped paths to the first project", async () => {
    const { get } = twoProjects();
    const legacy = await (await get("/api/loops/ralph")).text();
    expect(legacy).toContain("run-alpha");
    expect(await (await get("/api/usage")).json()).toMatchObject({ project: "alpha" });
  });
});

describe("write routes act on the project in their URL", () => {
  it("sends a control command to that project's checkout only", async () => {
    const { post, alpha, beta } = twoProjects();
    const response = await post("/api/p/beta/control", { loop: "ralph", action: "pause", run: "run-beta", id: "k-1" });
    expect(response.status).toBe(200);
    expect(inbox(beta)).toHaveLength(1);
    expect(inbox(alpha)).toHaveLength(0);
  });

  it("hands lifecycle, doctor and Stop now the named project's checkout", async () => {
    const seen: string[] = [];
    const projects: (string | undefined)[] = [];
    const record = ({ worktree, project }: { worktree: string; project?: string }) => {
      seen.push(worktree);
      projects.push(project);
      throw new Error("recorded");
    };
    const { post, beta } = twoProjects({ lifecycle: record as never, doctor: record as never, interrupt: record as never });
    await post("/api/p/beta/start", { loop: "ralph" });
    await post("/api/p/beta/doctor", { loop: "ralph", action: "check" });
    await post("/api/p/beta/stop-now", { loop: "ralph", run: "run-beta", confirm: "ralph" });
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([beta]));
    // The start carries the registry id, which keys the loop's lineup and Jav.
    expect(projects[0]).toBe("beta");
  });

  it("marks notifications read in the named project's checkout", async () => {
    const { post, alpha, beta } = twoProjects();
    const response = await post("/api/p/beta/notifications/read", { loop: "ralph", through: "2026-09-15T00:00:00.000Z" });
    expect(response.status).toBe(200);
    expect(readdirSync(join(beta, ".ralph", "control"))).not.toHaveLength(0);
    expect(existsSync(join(alpha, ".ralph", "control"))).toBe(false);
  });

  it("hands lineup and Jav their unscoped paths, and never for an unknown project", async () => {
    const lineup = vi.fn(async (request: Request) => new Response(new URL(request.url).pathname));
    const jav: JavAdapter = {
      read: vi.fn(async () => ({ read: true }) as never),
      save: vi.fn(async (config: unknown) => ({ valid: true, config }) as never),
    };
    const { get, post } = twoProjects({ lineup, jav });
    expect(await (await post("/api/p/beta/lineup/save", { loop: "ralph" })).text()).toBe("/api/lineup/save");
    expect(await (await get("/api/p/beta/lineup?loop=ralph")).text()).toBe("/api/lineup");
    expect(await (await post("/api/p/beta/jav/save", { config: { a: 1 } })).json()).toEqual({ valid: true, config: { a: 1 } });
    expect((await post("/api/p/nope/lineup/save", {})).status).toBe(404);
    expect((await post("/api/p/nope/jav/save", { config: {} })).status).toBe(404);
    expect(lineup).toHaveBeenCalledTimes(2);
    expect(jav.save).toHaveBeenCalledTimes(1);
  });
});

describe("pages under /p/:project", () => {
  it("serve the shell for a known project and 404 for an unknown one", async () => {
    const { get } = twoProjects();
    for (const path of ["/p/beta", "/p/beta/", "/p/beta/loops/ralph", "/p/beta/usage", "/p/alpha/backlog"]) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(await response.text()).toBe("<html>shell</html>");
    }
    expect((await get("/p/nope/")).status).toBe(404);
    expect((await get("/p/nope/loops/ralph")).status).toBe(404);
    expect((await get("/p/beta/no-such-page")).status).toBe(404);
  });

  it("redirect legacy pages into the first project, keeping the query", async () => {
    const { get } = twoProjects();
    for (const [legacy, target] of [
      ["/loops/rafa", "/p/alpha/loops/rafa"],
      ["/usage?range=week", "/p/alpha/usage?range=week"],
      ["/backlog", "/p/alpha/backlog"],
    ] as const) {
      const response = await get(legacy);
      expect(response.status, legacy).toBe(302);
      expect(response.headers.get("location")).toBe(target);
    }
  });

  it("serve the shell at /, which picks the last project used", async () => {
    const { get, scopes } = twoProjects();
    const response = await get("/");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>shell</html>");
    for (const scope of scopes) expect(scope.adapter.read).not.toHaveBeenCalled();
  });
});
