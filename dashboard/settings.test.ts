// @vitest-environment node
/**
 * The Settings overview (#689), over a fake agents adapter that answers each
 * read through the adapter's own parsers, so a test says what a command
 * printed and not how the adapter spelled it.
 */
import { describe, expect, it } from "vitest";

import type { AgentsDeps } from "./agents";
import { parseAgentConfig, parseCheckouts, parseWorktreeList, type CheckoutsSnapshot } from "./agents-adapter";
import type { ExecResult } from "./control-adapter";
import { classifyWorktree, projectSettings } from "./settings";

const ROOT = "/root";
const PROJECT = { id: "proj", path: ROOT, addedAt: "2026-11-01T00:00:00.000Z" };

const ok = (stdout: string): ExecResult => ({ status: 0, stdout, stderr: "" });
const bad = (stderr: string): ExecResult => ({ status: 1, stdout: "", stderr });

/** One porcelain block per worktree, the main checkout first. */
const porcelain = (worktrees: { path: string; branch?: string }[]): string =>
  worktrees
    .map(({ path, branch }) => [`worktree ${path}`, `HEAD ${"a".repeat(40)}`, branch === undefined ? "detached" : `branch refs/heads/${branch}`, ""].join("\n"))
    .join("\n");

/** A `loop-state status --json` snapshot as `narrowSnapshot` reads it. */
const snapshot = (loops: { worktree: string; supervisor: string }[], prunable: string[] = [], orphaned: string[] = []): string =>
  JSON.stringify({
    self: ROOT,
    loops: loops.map(({ worktree, supervisor }) => ({ worktree, worktreeStatus: "live", loopStatus: "running", branch: null, state: null, stateProblem: null, supervisor })),
    reconciliation: { orphaned, prunable },
  });

interface Answers {
  config: ExecResult;
  worktrees: ExecResult;
  checkouts: ExecResult;
  names: Record<string, string>;
  /** The project's own worktrees folder, when its registry entry names one. */
  worktreesDir?: string;
}

function deps(answers: Answers): AgentsDeps {
  const agents = {
    root: ROOT,
    project: "proj",
    worktreesDir: () => answers.worktreesDir ?? "/ws/proj",
    defaultWorktreesDir: () => "/ws/proj",
    worktreesDirSet: () => answers.worktreesDir !== undefined,
    readConfig: async () => parseAgentConfig(answers.config),
    listWorktrees: async () => parseWorktreeList(answers.worktrees),
    checkouts: async () => parseCheckouts(answers.checkouts),
    readLoopName: (path: string) => answers.names[path] ?? null,
  } as unknown as AgentsDeps["agents"];
  return { agents };
}

const CONFIG = ok(
  JSON.stringify({
    repo: "o/r",
    owner: "o",
    baseBranch: "main",
    displayName: "Proj",
    loops: ["nova", "mira", "kai"],
    gates: { typecheck: "bun run typecheck", test: "bun run test", lint: "bun run lint" },
    requiredChecks: ["ci / test", "ci / lint"],
    refuseFiles: ["vitest.config.ts", ".github/workflows/ci.yml"],
    worktreeSetup: [{ name: "install", command: "bun install", installsDependencies: true }, { name: "env", command: "cp .env.example .env", timeoutSeconds: 10 }],
  }),
);
const WORKTREES = ok(
  porcelain([
    { path: ROOT, branch: "main" },
    { path: "/ws/proj/nova-loop", branch: "ralph/1-a" },
    { path: "/ws/proj/mira-loop" },
    { path: "/ws/proj/scratch", branch: "scratch" },
    { path: "/ws/proj/old-loop", branch: "old" },
    { path: "/ws/proj/kai-loop", branch: "kai" },
  ]),
);
const NAMES = { "/ws/proj/nova-loop": "nova", "/ws/proj/mira-loop": "mira", "/ws/proj/old-loop": "old", "/ws/proj/kai-loop": "kai" };
const CHECKOUTS = ok(
  snapshot(
    [
      { worktree: "/ws/proj/nova-loop", supervisor: "alive" },
      { worktree: "/ws/proj/mira-loop", supervisor: "dead" },
      { worktree: "/ws/proj/kai-loop", supervisor: "alive" },
    ],
    ["/ws/proj/kai-loop"],
  ),
);

describe("projectSettings", () => {
  it("says the project's own worktrees folder is no default, even when it equals the default", async () => {
    for (const folder of ["/srv/agents/proj", "/ws/proj"]) {
      const view = await projectSettings(
        deps({ config: CONFIG, worktrees: WORKTREES, checkouts: CHECKOUTS, names: NAMES, worktreesDir: folder }),
        PROJECT,
      );
      expect(view).toMatchObject({ worktreesDir: folder, worktreesDefault: false, defaultWorktreesDir: "/ws/proj" });
    }
  });

  it("lists the config and classifies every worktree", async () => {
    const view = await projectSettings(deps({ config: CONFIG, worktrees: WORKTREES, checkouts: CHECKOUTS, names: NAMES }), PROJECT);
    expect(view).toMatchObject({
      project: "proj",
      checkout: { path: ROOT, addedAt: PROJECT.addedAt },
      worktreesDir: "/ws/proj",
      worktreesDefault: true,
      defaultWorktreesDir: "/ws/proj",
      config: { repo: "o/r", owner: "o", baseBranch: "main", displayName: "Proj" },
      problems: [],
      worktreesProblem: null,
    });
    expect(view.worktrees).toEqual([
      { path: ROOT, branch: "main", main: true, loop: null, use: "unowned", reconciliation: null },
      { path: "/ws/proj/nova-loop", branch: "ralph/1-a", main: false, loop: "nova", use: "in-use", reconciliation: null },
      { path: "/ws/proj/mira-loop", branch: null, main: false, loop: "mira", use: "idle", reconciliation: null },
      { path: "/ws/proj/scratch", branch: "scratch", main: false, loop: null, use: "unowned", reconciliation: null },
      // Named, but not on the roster: no loop of this project owns it.
      { path: "/ws/proj/old-loop", branch: "old", main: false, loop: "old", use: "unowned", reconciliation: null },
      // Alive and on the roster, yet listed prunable: the Reconciliation page
      // offers to remove it, so it is never in use here.
      { path: "/ws/proj/kai-loop", branch: "kai", main: false, loop: "kai", use: "unowned", reconciliation: "prunable" },
    ]);
  });

  it("lists every gate, by name and command in config order, and every required check", async () => {
    const view = await projectSettings(deps({ config: CONFIG, worktrees: WORKTREES, checkouts: CHECKOUTS, names: NAMES }), PROJECT);
    expect(view.config?.gates).toEqual([
      { name: "typecheck", command: "bun run typecheck" },
      { name: "test", command: "bun run test" },
      { name: "lint", command: "bun run lint" },
    ]);
    expect(view.config?.requiredChecks).toEqual(["ci / test", "ci / lint"]);
    // In the config's order: the Settings editor shows them as spelled.
    expect(view.config?.refuseFiles).toEqual(["vitest.config.ts", ".github/workflows/ci.yml"]);
  });

  it("lists every worktree setup step in config order, with its defaults filled", async () => {
    const view = await projectSettings(deps({ config: CONFIG, worktrees: WORKTREES, checkouts: CHECKOUTS, names: NAMES }), PROJECT);
    expect(view.config?.worktreeSetup).toEqual([
      { name: "install", command: "bun install", timeoutSeconds: 120, installsDependencies: true },
      { name: "env", command: "cp .env.example .env", timeoutSeconds: 10, installsDependencies: false },
    ]);
  });

  it("lists no gates or required checks for a config that spells neither", async () => {
    const config = ok(JSON.stringify({ repo: "o/r", baseBranch: "main", loops: ["nova"] }));
    const view = await projectSettings(deps({ config, worktrees: WORKTREES, checkouts: CHECKOUTS, names: NAMES }), PROJECT);
    expect(view.config).toMatchObject({ gates: [], requiredChecks: [], refuseFiles: [], worktreeSetup: [] });
    expect(view.problems).toEqual([]);
  });

  it("lists every problem of an invalid config and still lists the worktrees", async () => {
    const config = bad("project-config: .ralph/config.json is invalid:\n  - repo must be a string\n  - loops must be a list\n");
    const view = await projectSettings(deps({ config, worktrees: WORKTREES, checkouts: CHECKOUTS, names: NAMES }), PROJECT);
    expect(view.config).toBeNull();
    expect(view.problems).toEqual(["repo must be a string", "loops must be a list"]);
    expect(view.worktrees).not.toBeNull();
    // No roster to check against: a named worktree is judged by liveness, an
    // unnamed one is still unowned.
    const use = Object.fromEntries(view.worktrees!.map((entry) => [entry.path, entry.use]));
    // old-loop is not in loop-state's report, so it cannot be seen: in use.
    expect(use).toMatchObject({ "/ws/proj/nova-loop": "in-use", "/ws/proj/old-loop": "in-use", "/ws/proj/scratch": "unowned" });
  });

  it("quotes the one reason a config that lists no problems could not be read", async () => {
    const view = await projectSettings(deps({ config: bad("project-config: ENOENT"), worktrees: WORKTREES, checkouts: CHECKOUTS, names: NAMES }), PROJECT);
    expect(view.problems).toEqual(["project-config: ENOENT"]);
  });

  it("shows the config when the worktrees cannot be listed", async () => {
    const view = await projectSettings(
      deps({ config: CONFIG, worktrees: bad("fatal: not a git repository"), checkouts: CHECKOUTS, names: NAMES }),
      PROJECT,
    );
    expect(view.worktrees).toBeNull();
    expect(view.worktreesProblem).toContain("fatal: not a git repository");
    expect(view.config).toMatchObject({ repo: "o/r" });
    expect(view.problems).toEqual([]);
  });

  it("drops the worktrees with the reason when loop-state cannot be read", async () => {
    const view = await projectSettings(deps({ config: CONFIG, worktrees: WORKTREES, checkouts: bad("boom"), names: NAMES }), PROJECT);
    expect(view.worktrees).toBeNull();
    expect(view.worktreesProblem).toContain("boom");
  });
});

describe("classifyWorktree", () => {
  const entry = { path: "/ws/proj/nova-loop", branch: "b", main: false };
  const empty: CheckoutsSnapshot = { loops: [], orphaned: [], prunable: [] };

  it("calls a roster worktree whose supervisor cannot be seen in use", () => {
    const view = classifyWorktree(entry, "nova", ["nova"], { ...empty, loops: [{ worktree: entry.path, liveness: "unknown", owner: null, recorded: false }] });
    expect(view.use).toBe("in-use");
  });

  it("calls a roster worktree loop-state never reported in use, as runningIn does", () => {
    expect(classifyWorktree(entry, "nova", ["nova"], empty).use).toBe("in-use");
  });

  it("attributes a worktree by its loop record before its loop-name, as the dashboard does", () => {
    // The main checkout runs ralph with no `.ralph/loop-name`: its record says so.
    const main = { path: "/root", branch: "main", main: true };
    const view = classifyWorktree(main, null, ["ralph"], {
      ...empty,
      loops: [{ worktree: main.path, liveness: "alive", owner: "ralph", recorded: true }],
    });
    expect(view).toMatchObject({ loop: "ralph", use: "in-use", reconciliation: null });
  });

  it("lists a record no roster loop owns as unattributed, as the Reconciliation page does", () => {
    const view = classifyWorktree(entry, "nova", ["nova"], {
      ...empty,
      loops: [{ worktree: entry.path, liveness: "alive", owner: "old", recorded: true }],
    });
    expect(view).toMatchObject({ loop: "old", use: "unowned", reconciliation: "unattributed" });
  });

  it("leaves a checkout with no record and no roster name unowned, untagged", () => {
    const view = classifyWorktree(entry, null, ["nova"], {
      ...empty,
      loops: [{ worktree: entry.path, liveness: "dead", owner: null, recorded: false }],
    });
    expect(view).toMatchObject({ loop: null, use: "unowned", reconciliation: null });
  });

  it("calls an orphaned worktree unowned, matching paths loosely", () => {
    const view = classifyWorktree(entry, "nova", ["nova"], {
      loops: [{ worktree: entry.path, liveness: "alive", owner: null, recorded: false }],
      orphaned: [`${entry.path}/`],
      prunable: [],
    });
    expect(view).toMatchObject({ use: "unowned", reconciliation: "orphaned" });
  });
});
