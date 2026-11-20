// @vitest-environment node
/**
 * The design preview's loop reads, through the real server's composition.
 *
 * The preview answers `/api/loops` and a loop's panel by composing the server
 * over a canned runtime snapshot, so the page shows what `aggregateDashboard`
 * derives rather than a hand-written `Dashboard`. These tests pin that: the
 * composed read is a well-formed `Dashboard` holding every canned loop and
 * every derived state the preview exists to draw, the control buttons still
 * act on the in-memory loops that read sees, and the reads never call the
 * composition's executor. Nothing here spawns or listens.
 */
import { describe, expect, it } from "vitest";
import type { Shell } from "./build";
import { composeServer } from "./compose";
import type { Dashboard, DashboardLoop } from "./contracts";
import { createPreviewRouter, previewServerDeps } from "./preview";

const SHELL: Shell = { html: "<html><body>shell</body></html>", assets: new Map() };
const router = createPreviewRouter({
  shell: () => ({ shell: SHELL, version: 1 }),
  lineup: () => Response.json({ fake: "lineup" }),
  setupPreview: false,
});

const BASE = "http://preview.test";

/** The composed server on its own, asked as the preview forwards: the project's scoped path on loopback. */
const composed = composeServer(previewServerDeps());
const composedGet = (path: string): Promise<Response> =>
  composed.fetch(new Request(`http://127.0.0.1/api/p/preview${path.slice("/api".length)}`));

const routerGet = (path: string): Promise<Response> => router(new Request(`${BASE}/api/p/preview${path.slice("/api".length)}`));
const post = (path: string, body: unknown): Promise<Response> =>
  router(new Request(`${BASE}/api/p/preview${path.slice("/api".length)}`, { method: "POST", body: JSON.stringify(body) }));

/** The canned roster, in its order, with the role each loop has. */
const ROSTER = [
  ["rafa", "coder"],
  ["ralph", "coder"],
  ["remo", "coder"],
  ["doc", "ci-doctor"],
  ["tria", "triager"],
  ["rio", "coder"],
] as const;

/**
 * Every key a `DashboardLoop` carries. `retry` is optional and left out. A
 * `Record` over the interface's keys, so a key added to the contract and not
 * here fails the typecheck rather than passing the shape check unnoticed.
 */
const LOOP_KEYS: Record<Exclude<keyof DashboardLoop, "retry">, true> = {
  loop: true,
  role: true,
  present: true,
  worktree: true,
  loopStatus: true,
  worktreeStatus: true,
  branch: true,
  supervisor: true,
  run: true,
  issue: true,
  iteration: true,
  stage: true,
  phase: true,
  resumedAt: true,
  stopReason: true,
  stateProblem: true,
  presence: true,
  heartbeat: true,
  lastEvent: true,
  repoUrl: true,
  claims: true,
  issueTitle: true,
  actors: true,
  presenceProblem: true,
  usage: true,
  journal: true,
  timeline: true,
  runnerFailure: true,
  triage: true,
  case: true,
};

/** There is no runtime validator for `Dashboard`; this checks its shape key by key. */
function expectDashboard(value: unknown): asserts value is Dashboard {
  expect(value).toBeTypeOf("object");
  const dashboard = value as Record<string, unknown>;
  expect(typeof dashboard.generatedAt).toBe("string");
  expect(Number.isNaN(Date.parse(dashboard.generatedAt as string))).toBe(false);
  expect(Array.isArray(dashboard.loops)).toBe(true);
  expect(Array.isArray(dashboard.unattributed)).toBe(true);
  const reconciliation = dashboard.reconciliation as Record<string, unknown>;
  expect(Array.isArray(reconciliation.orphaned)).toBe(true);
  expect(Array.isArray(reconciliation.prunable)).toBe(true);
  const ownership = dashboard.ownership as Record<string, unknown>;
  expect(Array.isArray(ownership.issues)).toBe(true);
  expect(Array.isArray(ownership.contested)).toBe(true);
  expect(ownership.sources).toBeTypeOf("object");
  for (const key of ["frontier", "ciHealth", "learnings", "following", "tracker"]) {
    expect(dashboard, `Dashboard.${key} is missing`).toHaveProperty(key);
    expect(dashboard[key] === null || typeof dashboard[key] === "object", `Dashboard.${key} is neither null nor an object`).toBe(true);
  }
  for (const panel of dashboard.loops as Record<string, unknown>[]) {
    for (const key of Object.keys(LOOP_KEYS)) {
      expect(panel, `${String(panel.loop)}'s panel has no ${key}`).toHaveProperty(key);
    }
  }
}

async function readDashboard(get: (path: string) => Promise<Response>): Promise<Dashboard> {
  const response = await get("/api/loops");
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expectDashboard(body);
  return body;
}

const panelOf = (dashboard: Dashboard, loop: string): DashboardLoop => {
  const panel = dashboard.loops.find((entry) => entry.loop === loop);
  expect(panel, `no panel for ${loop}`).toBeDefined();
  return panel!;
};

describe("the preview's composed loop read", () => {
  it("is a well-formed Dashboard with every canned loop, in roster order, with its role", async () => {
    const dashboard = await readDashboard(composedGet);
    expect(dashboard.loops.map((panel) => [panel.loop, panel.role])).toEqual(ROSTER.map(([loop, role]) => [loop, role]));
  });

  it("answers the same through the preview's router", async () => {
    const dashboard = await readDashboard(routerGet);
    expect(dashboard.loops.map((panel) => panel.loop)).toEqual(ROSTER.map(([loop]) => loop));
  });

  it("derives the states the preview exists to show", async () => {
    const dashboard = await readDashboard(composedGet);
    expect(dashboard.ownership.contested).toContain(975);
    expect(dashboard.ownership.sources).toEqual({ leases: "ok", github: "ok" });
    expect(dashboard.reconciliation.orphaned).toContain("/home/dev/worktrees/old-spike");
    expect(dashboard.unattributed).toContainEqual(expect.objectContaining({ owner: "rex", stateProblem: "foreign" }));

    const view = dashboard.frontier?.view;
    expect(view).toBeTruthy();
    expect(view!.ready.length).toBeGreaterThan(0);
    expect(view!.untriaged.length).toBeGreaterThan(0);
    expect(view!.human.length).toBeGreaterThan(0);
    expect(dashboard.ciHealth).not.toBeNull();
    expect(dashboard.learnings).not.toBeNull();

    expect(panelOf(dashboard, "doc").case).not.toBeNull();
    expect(panelOf(dashboard, "tria").triage?.units).toHaveLength(5);
    const remo = panelOf(dashboard, "remo");
    expect(remo.runnerFailure).toMatchObject({ state: "failed" });
    expect(remo.supervisor).toBe("dead");

    for (const panel of dashboard.loops) {
      expect(panel.presence, `${panel.loop} has no presence`).not.toBeNull();
      expect(panel.presenceProblem, `${panel.loop} has a presence problem`).toBeNull();
    }
  });
});

// Loop state is the preview module's, shared by every case here: each case
// that acts on a loop acts on its own, so no case reads another's mutation.
describe("the preview's controls through the composed read", () => {
  it("shows a stopped loop on the next read of its panel", async () => {
    const before = (await (await routerGet("/api/loops/rafa")).json()) as DashboardLoop;
    expect(before.supervisor).toBe("alive");

    const stopped = await post("/api/stop-now", { loop: "rafa", confirm: true });
    expect(stopped.status).toBe(200);

    const response = await routerGet("/api/loops/rafa");
    expect(response.status).toBe(200);
    const after = (await response.json()) as DashboardLoop;
    expect(after.supervisor).toBe("dead");
    expect(after.loopStatus).toBe("interrupted");
  });

  it("drops a released claim from the loop's next read", async () => {
    const claimed = (issues: DashboardLoop["claims"]): number[] => issues.map((claim) => claim.issue);
    const before = (await (await routerGet("/api/loops/rio")).json()) as DashboardLoop;
    expect(claimed(before.claims)).toContain(975);

    const released = await post("/api/control", { loop: "rio", action: "release", issue: 975, confirm: true });
    expect(released.status).toBe(200);

    const after = (await (await routerGet("/api/loops/rio")).json()) as DashboardLoop;
    expect(claimed(after.claims)).not.toContain(975);
  });
});

describe("the preview's composition", () => {
  it("runs no process: its executor refuses every call but onboarding's set-up probes", async () => {
    // Onboarding is the real adapter over this executor, so the probes that
    // make a project read as set up answer; anything else, a loop read
    // included, refuses rather than spawning.
    const run = previewServerDeps().executor();
    await expect(run({ command: "/nonexistent/bun", args: ["/nonexistent/cli/loop-state.ts", "status", "--json"], cwd: "/", env: {} })).rejects.toThrow(
      "the preview runs no process",
    );
    await expect(run({ command: "git", args: ["status"], cwd: "/", env: {} })).resolves.toMatchObject({ status: 0 });
  });

  it("never calls its executor to answer the loop reads", async () => {
    // Refusing is the fallback; the reads must not even ask.
    const deps = previewServerDeps();
    const calls: unknown[][] = [];
    const executor: typeof deps.executor = (timeoutMs) => {
      const run = deps.executor(timeoutMs);
      return ((...args: unknown[]) => {
        calls.push(args);
        return (run as unknown as (...rest: unknown[]) => unknown)(...args);
      }) as unknown as typeof run;
    };
    const spied = composeServer({ ...deps, executor });
    for (const path of ["/loops", "/loops/rafa", "/ownership", "/frontier"]) {
      const response = await spied.fetch(new Request(`http://127.0.0.1/api/p/preview${path}`));
      expect(response.status, path).toBe(200);
    }
    expect(calls).toEqual([]);
  });

  it("lets a failed read stand as the server's error, not as a project needing setup", async () => {
    // A malformed loop name throws inside the handler; the server then asks
    // onboarding to explain it, and a preview that read as not set up would
    // answer 409 and hide the real error.
    const response = await composedGet("/api/loops/%E0");
    expect(response.status).toBe(500);
  });
});
