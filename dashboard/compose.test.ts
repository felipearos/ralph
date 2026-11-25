// @vitest-environment node
/**
 * `composeServer`, assembled in-process from fakes (#624).
 *
 * The adapters are the real ones over recording executors, and the project
 * read and the exec-free factories are recording fakes, so nothing here spawns
 * a process, reads a real CLI or touches the network: what is pinned is the
 * wiring `main()` used to hold inline — which project keeps which scope, which
 * surface's commands run on which executor, and that the scheduled passes read
 * the registry once and the loops only locally.
 */
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { composeServer, type ServerDeps } from "./compose";
import { coderRoster, type RuntimeSnapshot } from "./contracts";
import type { Invocation } from "./control-adapter";
import type { ProjectEntry, ProjectRegistry, RegisteredProject } from "./projects";
import { createRecordingExecutor, type RecordingExecutor } from "./recording-executor";
import { scratchDir } from "../test-scratch";

type Exec = ReturnType<ServerDeps["executor"]>;
type Factories = ServerDeps["factories"];

/** A scratch directory in the OS temp dir, never this checkout, removed after the case. */
const tempDir = (label: string): string => scratchDir(`ralph-compose-${label}-`);

/** The registry as an in-memory list the test edits between requests; `lists` counts reads. */
function fakeRegistry(initial: ProjectEntry[]): ProjectRegistry & { entries: ProjectEntry[]; lists: number } {
  const registry = {
    file: "/nonexistent/projects.json",
    readOnly: false,
    entries: initial,
    lists: 0,
    list(): ProjectEntry[] {
      registry.lists += 1;
      return registry.entries.map((entry) => ({ ...entry, roots: [...entry.roots] }));
    },
    add(): RegisteredProject {
      throw new Error("the compose suite adds no project");
    },
    remove(): boolean {
      return false;
    },
    setWorktrees(): ProjectEntry {
      throw new Error("the compose suite sets no worktrees folder");
    },
  };
  return registry;
}

const entry = (id: string, path: string, roots: string[] = [path]): ProjectEntry => ({
  id,
  path,
  addedAt: "2026-11-01T00:00:00.000Z",
  source: "local",
  roots,
});

/** One `ralph` loop with a checkout at `worktree`, its supervisor dead. */
const snapshotAt = (worktree: string): RuntimeSnapshot => ({
  roster: coderRoster("ralph"),
  loops: [
    {
      worktree,
      identity: "ralph",
      loopStatus: "failed",
      worktreeStatus: "live",
      branch: null,
      state: null,
      stateProblem: null,
      supervisor: "dead",
      presence: null,
    },
  ],
  reconciliation: { orphaned: [], prunable: [] },
});

/** The harness script an invocation runs (`bun <cliDir>/<script> …`), or its command. */
const scriptOf = (invocation: Invocation): string => {
  const first = invocation.args[0] ?? "";
  return first.endsWith(".ts") || first.endsWith(".sh") ? basename(first) : invocation.command;
};

/** A project config every surface that reads one accepts. */
const PROJECT_CONFIG = JSON.stringify({ repo: "example/a", baseBranch: "main", loops: ["ralph"] });

function compose(entries: ProjectEntry[], worktree = tempDir("wt")) {
  const registry = fakeRegistry(entries);
  // One distinct recording executor per call, keyed back to the timeout it was
  // asked for. Every surface's real adapter runs its commands on one of these,
  // so which surface got which executor is read off who received its commands.
  // Nothing answered here starts a loop: `loop-state` and `controls` fall to
  // the default 127, so a loop reads as never recorded and the pass skips it.
  const recorders: RecordingExecutor[] = [];
  const timeoutOf = new Map<Exec, number | undefined>();
  const executor = vi.fn((timeoutMs?: number): Exec => {
    const recorder = createRecordingExecutor()
      .on((invocation) => scriptOf(invocation) === "project-config.ts", { status: 0, stdout: PROJECT_CONFIG, stderr: "" })
      .on({ command: "git" }, { status: 0, stdout: "", stderr: "" });
    recorders.push(recorder);
    timeoutOf.set(recorder.exec, timeoutMs);
    return recorder.exec;
  });
  /** The timeouts of the executors that ran `script`, one per call. */
  const ranOn = (script: string, where: (invocation: Invocation) => boolean = () => true): (number | undefined)[] =>
    recorders.flatMap((recorder) =>
      recorder.calls
        .filter(({ invocation }) => scriptOf(invocation) === script && where(invocation))
        .map(() => timeoutOf.get(recorder.exec)),
    );
  /** Every invocation of `script`, on whichever executor. */
  const callsOf = (script: string): Invocation[] =>
    recorders.flatMap((recorder) => recorder.calls.map(({ invocation }) => invocation).filter((invocation) => scriptOf(invocation) === script));
  const local = { roster: coderRoster("ralph"), loops: [{ identity: "ralph", worktree }] };
  const ralphAdapters: { config: Parameters<ServerDeps["ralphAdapter"]>[0]; read: ReturnType<typeof vi.fn>; readLocal: ReturnType<typeof vi.fn> }[] = [];
  const usages: { close: ReturnType<typeof vi.fn> }[] = [];
  const lineupHandlers: Parameters<Factories["lineupHandler"]>[0][] = [];
  const ralphAdapter: ServerDeps["ralphAdapter"] = (config) => {
    const read = vi.fn(async () => snapshotAt(worktree));
    const readLocal = vi.fn(async () => local);
    ralphAdapters.push({ config, read, readLocal });
    return { read, readLocal } as unknown as ReturnType<ServerDeps["ralphAdapter"]>;
  };
  const factories: Factories = {
    interrupt: () => ({}) as unknown as ReturnType<Factories["interrupt"]>,
    usagebarMemory: () => ({ load: () => null, save: () => {} }),
    records: () => ({ readFeed: () => ({ feed: [] }) }) as unknown as ReturnType<Factories["records"]>,
    lineupHandler: (config) => {
      lineupHandlers.push(config);
      return async () => new Response("lineup");
    },
    usage: () => {
      const close = vi.fn();
      usages.push({ close });
      return Object.assign(async () => ({}), { close }) as unknown as ReturnType<Factories["usage"]>;
    },
    chatRunner: () => ({
      claude: () => {
        throw new Error("the compose suite runs no claude");
      },
      redactor: () => {
        throw new Error("the compose suite runs no redactor");
      },
    }),
    redactor: () => () => {
      throw new Error("the compose suite runs no redactor");
    },
    follower: () => ({}) as unknown as ReturnType<Factories["follower"]>,
  };
  const lineup = {} as unknown as ServerDeps["lineup"];
  const log = { out: vi.fn(), err: vi.fn() };
  const composed = composeServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      roots: [],
      rootsOverride: false,
      cliDir: "/nonexistent/cli",
      bunPath: "/nonexistent/bun",
      hosts: [],
    },
    registry,
    shell: { html: "<html></html>", assets: new Map() },
    harness: "/nonexistent/harness",
    reconciling: { intervalMs: 0, attempts: 3, retryScheduleMinutes: [1], migrationAlertSeconds: 3600 },
    lineup,
    executor,
    ralphAdapter,
    factories,
    log,
  });
  return { composed, registry, executor, recorders, timeoutOf, ranOn, callsOf, ralphAdapters, usages, lineupHandlers, lineup, log, worktree };
}

const get = (path: string): Request => new Request(`http://127.0.0.1${path}`);
const post = (path: string, body: unknown): Request =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** The request scopes' adapters: the reconcile passes build theirs without a project id. */
const scoped = (adapters: ReturnType<typeof compose>["ralphAdapters"]) => adapters.filter((a) => a.config.projectId !== undefined);

describe("composeServer", () => {
  it("is imported and called under the Node environment and serves the registry's projects", async () => {
    const a = tempDir("a");
    const b = tempDir("b");
    const { composed } = compose([entry("a", a), entry("b", b)]);
    const response = await composed.fetch(get("/api/projects"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { projects: { id: string; path: string }[] };
    expect(body.projects.map((project) => [project.id, project.path])).toEqual([
      ["a", a],
      ["b", b],
    ]);
  });

  it("reuses a project's scope across requests at the same roots", async () => {
    const a = tempDir("a");
    const b = tempDir("b");
    const { composed, ralphAdapters, usages } = compose([entry("a", a), entry("b", b)]);
    await composed.fetch(get("/api/projects"));
    await composed.fetch(get("/api/projects"));
    expect(scoped(ralphAdapters).map((adapter) => adapter.config.projectId)).toEqual(["a", "b"]);
    expect(usages).toHaveLength(2);
  });

  it("drops a removed or re-rooted project's scope and closes its usage source", async () => {
    const a = tempDir("a");
    const b = tempDir("b");
    const { composed, registry, ralphAdapters, usages } = compose([entry("a", a), entry("b", b)]);
    await composed.fetch(get("/api/projects"));
    const [usageA, usageB] = usages;
    // `a` is removed; `b` is now observed at another root.
    const moved = tempDir("b-moved");
    registry.entries = [entry("b", b, [moved])];
    await composed.fetch(get("/api/projects"));
    expect(usageA!.close).toHaveBeenCalledTimes(1);
    expect(usageB!.close).toHaveBeenCalledTimes(1);
    const adapters = scoped(ralphAdapters);
    expect(adapters).toHaveLength(3);
    expect(adapters[2]!.config).toMatchObject({ projectId: "b", roots: [moved] });
    expect(usages).toHaveLength(3);
    expect(usages[2]!.close).not.toHaveBeenCalled();
  });

  it("pins lineup, Jav, intake and the sleep to each project, once per project", async () => {
    const a = tempDir("a");
    const b = tempDir("b");
    const { composed, lineupHandlers, lineup, callsOf } = compose([entry("a", a), entry("b", b)]);
    await composed.fetch(get("/api/projects"));
    await composed.fetch(get("/api/projects"));
    expect(lineupHandlers).toHaveLength(2);
    expect(lineupHandlers[0]!.adapter).toBe(lineup);
    expect(lineupHandlers[1]!.adapter).toBe(lineup);
    expect(lineupHandlers.map((config) => config.project)).toEqual(["a", "b"]);
    for (const id of ["a", "b"]) {
      await composed.fetch(get(`/api/p/${id}/jav`));
      await composed.fetch(get(`/api/p/${id}/intake`));
      await composed.fetch(get(`/api/p/${id}/sleep`));
    }
    // Jav reads its project's block by id and its roster by root.
    expect(callsOf("jav.ts").map(({ env }) => [env?.RALPH_PROJECT_ID, env?.RALPH_PROJECT])).toEqual([
      ["a", a],
      ["b", b],
    ]);
    expect(callsOf("clerk-intake.ts").map(({ env }) => env?.RALPH_PROJECT)).toEqual([a, b]);
    // The sleep runs the harness's CLI in each project's own checkout.
    const sleeps = callsOf("project-sleep.ts");
    expect(sleeps.map(({ cwd }) => cwd)).toEqual([a, b]);
    expect(new Set(sleeps.map(({ args }) => args[0])).size).toBe(1);
  });

  it("hands the agents adapter a project's own worktrees folder, and none to a project without one", async () => {
    const a = tempDir("a");
    const b = tempDir("b");
    const folder = join(tempDir("agents"), "a");
    const { composed } = compose([{ ...entry("a", a), worktrees: folder }, entry("b", b)]);
    // The folder is never on a command line; the guide is where the adapter says it.
    const worktreesOf = async (id: string): Promise<string | undefined> => {
      const response = await composed.fetch(get(`/api/p/${id}/agents/guide`));
      expect(response.status).toBe(200);
      return ((await response.json()) as { values: { worktrees: string } | null }).values?.worktrees;
    };
    expect(await worktreesOf("a")).toBe(folder);
    // Without one, the adapter's own default under the workspaces home.
    const fallback = await worktreesOf("b");
    expect(fallback).toBeDefined();
    expect(fallback).not.toBe(folder);
    expect(basename(fallback!)).toBe("b");
  });

  it("hands every surface the executor made for its own timeout", async () => {
    const a = tempDir("a");
    const worktree = tempDir("wt");
    mkdirSync(join(worktree, ".ralph", "logs"), { recursive: true });
    const { composed, ranOn, recorders, timeoutOf, ralphAdapters } = compose([entry("a", a)], worktree);

    // Onboarding, built with the server, on the 240s executor: a setup read
    // probes the checkout with `git`, and nothing else has run a command yet.
    const setup = await composed.fetch(get("/api/p/a/setup"));
    expect(setup.status).toBe(200);
    expect(ranOn("git").length).toBeGreaterThan(0);
    for (const timeout of ranOn("git")) expect(timeout).toBe(240_000);

    // Control, lifecycle and the reconciler on the default executor: the pass
    // reads each loop's state through lifecycle, and the watchdog lists the
    // project's PRs through the reconciler.
    await composed.reconcile();
    await composed.watchMigrations();
    expect(ranOn("loop-state.ts").length).toBeGreaterThan(0);
    for (const timeout of ranOn("loop-state.ts")) expect(timeout).toBeUndefined();
    const listed = ranOn("gh", (invocation) => invocation.args.includes("migration-applied"));
    expect(listed).toEqual([undefined]);
    await composed.fetch(get("/api/p/a/controls"));
    expect(ranOn("controls.ts").length).toBeGreaterThan(0);
    for (const timeout of ranOn("controls.ts")) expect(timeout).toBeUndefined();
    // The project read, in the passes and the request scopes alike, gets the default one too.
    expect(ralphAdapters.length).toBeGreaterThan(0);
    for (const adapter of ralphAdapters) {
      expect(timeoutOf.has(adapter.config.exec!)).toBe(true);
      expect(timeoutOf.get(adapter.config.exec!)).toBeUndefined();
    }
    // One default executor shared by control, lifecycle and the reconciler.
    const holding = (script: string) => recorders.filter((recorder) => recorder.calls.some(({ invocation }) => scriptOf(invocation) === script));
    expect(holding("loop-state.ts")).toEqual(holding("controls.ts"));
    // The reconciler's migration list, not onboarding's own `gh` probes.
    const reconciler = recorders.filter((recorder) =>
      recorder.calls.some(({ invocation }) => invocation.command === "gh" && invocation.args.includes("migration-applied")),
    );
    expect(reconciler).toEqual(holding("loop-state.ts"));
    expect(holding("loop-state.ts")).toHaveLength(1);

    // Agents: the guide reads the project config over the network-bound executor.
    await composed.fetch(get("/api/p/a/agents/guide"));
    expect(ranOn("project-config.ts", (invocation) => invocation.cwd !== undefined && invocation.cwd.startsWith(a))).toEqual([120_000]);

    // The doctor runs when its route resolves a loop.
    await composed.fetch(post("/api/p/a/doctor", { loop: "ralph" }));
    expect(ranOn("plugin-doctor.ts").length).toBeGreaterThan(0);
    for (const timeout of ranOn("plugin-doctor.ts")) expect(timeout).toBe(240_000);

    // The sleep reads on its own short executor; Jav and intake on theirs.
    await composed.fetch(get("/api/p/a/sleep"));
    await composed.fetch(get("/api/p/a/jav"));
    await composed.fetch(get("/api/p/a/intake"));
    expect(ranOn("project-sleep.ts")).toEqual([20_000]);
    expect(ranOn("jav.ts")).toEqual([20_000]);
    expect(ranOn("clerk-intake.ts")).toEqual([20_000]);

    // Filing a learning publishes and opens an issue, so it waits as long as a handback.
    await composed.fetch(post("/api/p/a/learnings/file", { slug: "a-learning", scope: "harness" }));
    expect(ranOn("findings.ts")).toEqual([240_000]);

    // The handback runs when a chat's Unblock & resume is confirmed. What the
    // adapters then answer is not this test's subject; whose executor is.
    const started = await composed.fetch(post("/api/p/a/chat", { loop: "ralph" }));
    expect(started.status).toBe(201);
    const { id } = (await started.json()) as { id: string };
    await composed.fetch(post(`/api/p/a/chat/${id}/handback`, { summary: "go on", confirm: true }));
    expect(ranOn("publish-journal.ts")).toEqual([240_000]);

    // composeServer asks for the 240s executor once per surface; this fake
    // answers each ask with a new one (`main()` shares one, which is fine:
    // an executor holds no state).
    expect(recorders.filter((recorder) => timeoutOf.get(recorder.exec) === 240_000)).toHaveLength(4);
    composed.chats.stopAll();
  });

  it("runs one reconcile and one watchdog pass on demand, each on one registry read and the local read only", async () => {
    const a = tempDir("a");
    const b = tempDir("b");
    const { composed, registry, ralphAdapters, log, ranOn } = compose([entry("a", a), entry("b", b)]);

    const before = registry.lists;
    await composed.reconcile();
    expect(registry.lists).toBe(before + 1);

    await composed.watchMigrations();
    expect(registry.lists).toBe(before + 2);
    // The watchdog lists each project's migration PRs once.
    expect(ranOn("gh", (invocation) => invocation.args.includes("migration-applied"))).toHaveLength(2);

    // Two passes over two projects, each with its own adapter, and no request scope built.
    expect(ralphAdapters).toHaveLength(4);
    expect(scoped(ralphAdapters)).toHaveLength(0);
    for (const adapter of ralphAdapters) {
      expect(adapter.readLocal).toHaveBeenCalledTimes(1);
      expect(adapter.read).not.toHaveBeenCalled();
    }
    const errors = log.err.mock.calls.map(([line]) => String(line));
    expect(errors.filter((line) => line.includes("pass failed"))).toEqual([]);
  });
});
