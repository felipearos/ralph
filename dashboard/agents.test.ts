// @vitest-environment node
/**
 * The two refusals `createCheckout` makes over a roster it cannot trust, and
 * where the `worktreeSetup` steps (#694) sit in Create checkout, Add agent and
 * Rerun setup.
 *
 * They are here rather than in `agents-http.test.ts` because neither is
 * reachable through the real `project-config.ts`: it validates roles against
 * `roles.ts` before printing, so a config it accepts is one `narrowRoster`
 * accepts too. What they guard is drift BETWEEN those two lists — a role added
 * to `roles.ts` and not to `contracts.ts` — which only a fake config read can
 * stage. Pinning them matters because "refuse rather than default" is the
 * whole of the change: the alternative was a silent `coder`, whose labels
 * `preflight` would then deny the start over.
 */
import { describe, expect, it } from "vitest";

import { addAgent, createCheckout, deleteAgent, gatedStart, rerunWorktreeSetup, type AgentsDeps } from "./agents";
import { parseAgentConfig, parseWorktreeList, type Step } from "./agents-adapter";
import type { WorktreeSetupRecord, WorktreeSetupStepConfig, WorktreeSetupStepState, WorktreeSetupStepView } from "./contracts";
import type { ExecResult } from "./control-adapter";
import type { LifecycleDeps } from "./lifecycle";

const CONFIG = { repo: "o/r", baseBranch: "main", loops: ["solo"] };

/**
 * Just enough adapter to reach the roster check: the config read answers
 * `config`, the worktree list is empty, and every invocation is recorded so a
 * test can assert nothing was created.
 */
function deps(config: unknown): { deps: AgentsDeps; ran: () => string[][] } {
  const ran: string[][] = [];
  // Every operation runs one fake argv: recorded, answered as the fake exec
  // answered it before the adapter owned its exec, and parsed the same way.
  const answer = (args: string[]): ExecResult => {
    if (args[0] === "config") return { status: 0, stdout: JSON.stringify(config), stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const ask = async <T>(args: string[], parse: (result: ExecResult) => T): Promise<T> => {
    ran.push(args);
    return parse(answer(args));
  };
  const step = (result: ExecResult): Step => (result.status === 0 ? { ok: true } : { ok: false, why: result.stderr.trim() });
  const agents = {
    root: "/root",
    project: "proj",
    worktreeFor: (name: string) => `/ws/proj/${name}-loop`,
    readConfig: () => ask(["config"], parseAgentConfig),
    listWorktrees: () => ask(["worktree", "list"], parseWorktreeList),
    readLoopName: () => null,
    fetch: () => ask(["fetch"], step),
    addWorktree: (path: string, ref: string) => ask(["worktree", "add", path, ref], step),
    provisionWorktree: () => {
      throw new Error("the test's adapter never provisions");
    },
  } as unknown as AgentsDeps["agents"];
  return { deps: { agents }, ran: () => ran };
}

describe("createCheckout over a roster it cannot read", () => {
  it("refuses a roster it could not narrow, quoting what narrowing said", async () => {
    // A role `roles.ts` would accept and `contracts.ts` does not: the drift
    // this guard exists for.
    const { deps: fake, ran } = deps({ ...CONFIG, roster: [{ name: "solo", role: "sleuth" }] });
    const result = await createCheckout(fake, { name: "solo" });
    expect(result).toMatchObject({ name: "solo", outcome: "refused", labels: null });
    // The diagnosis is narrowing's own, with its JSON path and the value —
    // not a sentence this module made up about what was probably wrong.
    expect(result.why).toContain("cannot read the roster on origin/main");
    expect(result.why).toContain("$.roster[0].role");
    expect(result.why).toContain("sleuth");
    expect(ran().some((args) => args[0] === "worktree" && args[1] === "add")).toBe(false);
  });

  it("refuses a listed name its roster has no entry for", async () => {
    // Unreachable through `project-config`, which derives `loops` from the
    // roster. A guard, and it must still not default to a coder.
    const { deps: fake, ran } = deps({ ...CONFIG, roster: [{ name: "other", role: "coder" }] });
    const result = await createCheckout(fake, { name: "solo" });
    expect(result).toMatchObject({ outcome: "refused", labels: null });
    expect(result.why).toContain("but its roster has no entry for it");
    expect(ran().some((args) => args[0] === "worktree" && args[1] === "add")).toBe(false);
  });

  it("gets past both guards when the roster names the loop", async () => {
    // The same fake, with a roster the dashboard understands: it reaches
    // `git worktree add`, which is what proves the refusals above are the
    // roster's doing and not the fake's.
    const { deps: fake, ran } = deps({ ...CONFIG, roster: [{ name: "solo", role: "triager" }] });
    const result = await createCheckout(fake, { name: "solo" });
    expect(ran().some((args) => args[0] === "worktree" && args[1] === "add")).toBe(true);
    expect(result.outcome).toBe("incomplete");
  });
});

/* ------------------------------------------------------- worktree setup (#694) */

const INSTALL = { name: "install", command: "bun install", timeoutSeconds: 600, installsDependencies: true };
const CODEGEN = { name: "codegen", command: "bun run codegen", timeoutSeconds: 60, installsDependencies: false };

const stepView = (step: WorktreeSetupStepConfig, state: WorktreeSetupStepState, output = ""): WorktreeSetupStepView => ({
  name: step.name,
  command: step.command,
  state,
  durationMs: state === "skipped" ? null : 5,
  exitCode: state === "passed" ? 0 : state === "failed" ? 2 : null,
  output,
  truncated: false,
  limitMs: step.timeoutSeconds * 1000,
  error: null,
});

interface SetupFake {
  /** `.ralph/config.json`'s `worktreeSetup`. */
  steps?: unknown[];
  /** The record `runWorktreeSetup` answers, per call; a function sees the steps. */
  run?: (steps: readonly WorktreeSetupStepConfig[]) => Promise<WorktreeSetupRecord>;
  /** Extra worktrees beside the main checkout, with their loop-names. */
  worktrees?: { path: string; name: string }[];
  supervisors?: { ok: true; value: { worktree: string; liveness: string }[] } | { ok: false; why: string };
  /** `gh pr create` fails. */
  prFails?: boolean;
  /** The worktrees with a setup in flight. */
  setupRunning?: string[];
  /** The worktrees whose directory is gone. */
  missing?: string[];
}

/**
 * A whole adapter, answered in place rather than by argv: Add agent and
 * Create checkout each run a dozen operations before and after the setup, and
 * what is pinned here is only where the setup sits among them.
 */
function setupDeps(fake: SetupFake = {}) {
  const calls: string[] = [];
  const setupCalls: { worktree: string; steps: readonly WorktreeSetupStepConfig[] }[] = [];
  const config = {
    ...CONFIG,
    loops: ["solo"],
    roster: [{ name: "solo", role: "coder" }],
    ...(fake.steps === undefined ? {} : { worktreeSetup: fake.steps }),
  };
  const done = <T>(value: T) => Promise.resolve({ ok: true as const, value });
  const extra = fake.worktrees ?? [];
  const porcelain = ["worktree /root", "", ...extra.flatMap(({ path }) => [`worktree ${path}`, ""])].join("\n");
  const agents = {
    root: "/root",
    project: "proj",
    worktreeFor: (name: string) => `/ws/proj/${name}-loop`,
    readConfig: () => Promise.resolve(parseAgentConfig({ status: 0, stdout: JSON.stringify(config), stderr: "" })),
    listWorktrees: () => Promise.resolve(parseWorktreeList({ status: 0, stdout: porcelain, stderr: "" })),
    readLoopName: (path: string) => extra.find((entry) => entry.path === path)?.name ?? null,
    fetch: () => Promise.resolve({ ok: true }),
    editRoster: () => done("{}"),
    branchFor: (edit: string, name: string) => `ralph-roster/${edit}-${name}`,
    remoteBranch: () => done(false),
    addWorktree: (path: string) => {
      calls.push(`add ${path}`);
      return Promise.resolve({ ok: true });
    },
    provisionWorktree: () => calls.push("provision"),
    removeWorktree: (path: string) => {
      calls.push(`remove ${path}`);
      return Promise.resolve({ ok: true });
    },
    labels: (name: string) => done([`${name}-wip`]),
    listLabels: () => done([{ name: "solo-wip", color: null, description: null }]),
    createLabel: () => Promise.resolve({ ok: true }),
    stage: () => ({ index: "/tmp/i", file: "/tmp/f", dispose: () => {} }),
    readTree: () => done(""),
    hashObject: () => done("b"),
    updateIndex: () => done(""),
    writeTree: () => done("t"),
    commitTree: () => done("c"),
    push: () => done(""),
    createPr: () => {
      calls.push("pr");
      return fake.prFails === true ? Promise.resolve({ ok: false, why: "HTTP 502" }) : done("https://github.com/o/r/pull/9\n");
    },
    supervisors: () => Promise.resolve(fake.supervisors ?? { ok: true, value: [] }),
    runWorktreeSetup: (worktree: string, steps: readonly WorktreeSetupStepConfig[]) => {
      setupCalls.push({ worktree, steps });
      calls.push("setup");
      return fake.run === undefined
        ? Promise.resolve({ ranAt: "2026-11-04T00:00:00.000Z", steps: steps.map((step) => stepView(step, "passed")) })
        : fake.run(steps);
    },
    setupRunning: (worktree: string) => (fake.setupRunning ?? []).includes(worktree),
    worktreeExists: (path: string) => !(fake.missing ?? []).includes(path),
  } as unknown as AgentsDeps["agents"];
  return { deps: { agents } as AgentsDeps, calls, setupCalls };
}

const failingInstall = (steps: readonly WorktreeSetupStepConfig[]): Promise<WorktreeSetupRecord> =>
  Promise.resolve({
    ranAt: "2026-11-04T00:00:00.000Z",
    steps: steps.map((step, index) =>
      stepView(step, index === 0 ? "failed" : "skipped", index === 0 ? "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nerror: lockfile had changes\n" : ""),
    ),
  });

describe("Create checkout and Add agent run the worktreeSetup steps", () => {
  it("makes no setup call and reports setup null when no steps are configured", async () => {
    const checkout = setupDeps();
    const created = await createCheckout(checkout.deps, { name: "solo" });
    expect(created).toMatchObject({ outcome: "created", setup: null });
    expect(created.why).toBe("solo is at /ws/proj/solo-loop, detached at origin/main; Start applies to it now");
    expect(checkout.setupCalls).toEqual([]);

    const add = setupDeps();
    const added = await addAgent(add.deps, { name: "nova" });
    expect(added).toMatchObject({ outcome: "added", setup: null });
    expect(added.why).not.toContain("setup");
    expect(add.setupCalls).toEqual([]);
  });

  it("runs the steps after provisioning, in the new worktree, and carries the record", async () => {
    const checkout = setupDeps({ steps: [INSTALL, CODEGEN] });
    const created = await createCheckout(checkout.deps, { name: "solo" });
    expect(created.outcome).toBe("created");
    expect(created.setup?.steps.map((step) => step.state)).toEqual(["passed", "passed"]);
    expect(checkout.calls.slice(0, 3)).toEqual(["add /ws/proj/solo-loop", "provision", "setup"]);
    expect(checkout.setupCalls[0]).toMatchObject({ worktree: "/ws/proj/solo-loop", steps: [INSTALL, CODEGEN] });

    const add = setupDeps({ steps: [INSTALL] });
    const added = await addAgent(add.deps, { name: "nova" });
    expect(added.outcome).toBe("added");
    expect(added.setup?.steps).toHaveLength(1);
    expect(added.why).not.toContain("setup");
  });

  it("reports a failing step as an incomplete checkout, keeps the worktree, and still creates the labels", async () => {
    const checkout = setupDeps({ steps: [INSTALL, CODEGEN], run: failingInstall });
    const created = await createCheckout(checkout.deps, { name: "solo" });
    expect(created.outcome).toBe("incomplete");
    expect(created.setup?.steps.map((step) => step.state)).toEqual(["failed", "skipped"]);
    expect(created.why).toContain("the worktree is at /ws/proj/solo-loop");
    expect(created.why).toContain("setup step 'install' failed with exit code 2");
    // The last five lines, not the whole log.
    expect(created.why).toContain("error: lockfile had changes");
    expect(created.why).not.toContain("line 2");
    expect(created.why).toContain("the worktree is kept, and Rerun setup re-runs the steps");
    expect(created.labels).toBeNull();
    expect(checkout.calls.some((call) => call.startsWith("remove"))).toBe(false);
  });

  it("reports an adapter that rejects as a step that could not start, never throwing", async () => {
    const checkout = setupDeps({ steps: [INSTALL, CODEGEN], run: () => Promise.reject(new Error("spawn EAGAIN")) });
    const created = await createCheckout(checkout.deps, { name: "solo" });
    expect(created.outcome).toBe("incomplete");
    expect(created.why).toContain("setup step 'install' could not start (spawn EAGAIN)");
    expect(created.setup?.steps.map((step) => step.state)).toEqual(["failed", "skipped"]);
  });

  it("still opens Add agent's roster PR over a failed setup, naming the failure in why", async () => {
    const add = setupDeps({ steps: [INSTALL], run: failingInstall });
    const added = await addAgent(add.deps, { name: "nova" });
    expect(added.outcome).toBe("added");
    expect(added.pr?.url).toBe("https://github.com/o/r/pull/9");
    expect(added.why).toContain("Its setup needs a hand: setup step 'install' failed with exit code 2");
    expect(added.setup?.steps[0]?.state).toBe("failed");
    expect(add.calls).toContain("pr");
    expect(add.calls.some((call) => call.startsWith("remove"))).toBe(false);

    const both = setupDeps({ steps: [INSTALL], run: failingInstall, prFails: true });
    const partial = await addAgent(both.deps, { name: "nova" });
    expect(partial.outcome).toBe("pr-failed");
    expect(partial.why).toContain("the roster PR was not opened");
    expect(partial.why).toContain("Its setup also needs a hand: setup step 'install' failed");
  });
});

describe("rerunWorktreeSetup", () => {
  const SOLO = { path: "/ws/proj/solo-loop", name: "solo" };

  it("refuses, running nothing, without a worktree, without steps, or while the loop runs", async () => {
    const none = setupDeps({ steps: [INSTALL] });
    expect(await rerunWorktreeSetup(none.deps, { name: "solo" })).toMatchObject({ outcome: "refused", worktree: null, setup: null });

    const noSteps = setupDeps({ worktrees: [SOLO] });
    const refused = await rerunWorktreeSetup(noSteps.deps, { name: "solo" });
    expect(refused).toMatchObject({ outcome: "refused", worktree: SOLO.path });
    expect(refused.why).toContain("no worktreeSetup steps");

    const running = setupDeps({ steps: [INSTALL], worktrees: [SOLO], supervisors: { ok: true, value: [{ worktree: SOLO.path, liveness: "alive" }] } });
    expect((await rerunWorktreeSetup(running.deps, { name: "solo" })).why).toContain("stop it before re-running its setup");

    // A worktree the supervisor list does not mention cannot be seen, so it is refused too.
    const blind = setupDeps({ steps: [INSTALL], worktrees: [SOLO], supervisors: { ok: false, why: "loop-state crashed" } });
    expect((await rerunWorktreeSetup(blind.deps, { name: "solo" })).why).toContain("loop-state crashed");

    // The main checkout is the operator's own, even when it carries the name.
    const main = setupDeps({ steps: [INSTALL], worktrees: [{ path: "/root", name: "solo" }] });
    const onMain = await rerunWorktreeSetup(main.deps, { name: "solo" });
    expect(onMain).toMatchObject({ outcome: "refused", worktree: "/root" });
    expect(onMain.why).toContain("main checkout");

    for (const fake of [none, noSteps, running, blind, main]) expect(fake.setupCalls).toEqual([]);
  });

  it("refuses, running nothing, while a setup already runs there or when its directory is gone", async () => {
    const busy = setupDeps({ steps: [INSTALL], worktrees: [SOLO], setupRunning: [SOLO.path] });
    const twice = await rerunWorktreeSetup(busy.deps, { name: "solo" });
    expect(twice).toMatchObject({ outcome: "refused", worktree: SOLO.path, setup: null });
    expect(twice.why).toBe(`a worktree setup is already running in ${SOLO.path}; rerun it once that setup has finished`);

    const gone = setupDeps({ steps: [INSTALL], worktrees: [SOLO], missing: [SOLO.path] });
    const missing = await rerunWorktreeSetup(gone.deps, { name: "solo" });
    expect(missing).toMatchObject({ outcome: "refused", worktree: SOLO.path, setup: null });
    expect(missing.why).toContain(`the worktree directory ${SOLO.path} does not exist`);

    for (const fake of [busy, gone]) expect(fake.setupCalls).toEqual([]);
  });

  it("runs the steps in the loop's worktree and reports what they did", async () => {
    const dead = { ok: true as const, value: [{ worktree: SOLO.path, liveness: "dead" }] };
    const passing = setupDeps({ steps: [INSTALL], worktrees: [SOLO], supervisors: dead });
    const passed = await rerunWorktreeSetup(passing.deps, { name: "solo" });
    expect(passed).toMatchObject({ outcome: "passed", worktree: SOLO.path });
    expect(passed.setup?.steps[0]?.state).toBe("passed");
    expect(passing.setupCalls[0]?.worktree).toBe(SOLO.path);

    const failing = setupDeps({ steps: [INSTALL], worktrees: [SOLO], supervisors: dead, run: failingInstall });
    const failed = await rerunWorktreeSetup(failing.deps, { name: "solo" });
    expect(failed.outcome).toBe("failed");
    expect(failed.why).toContain("setup step 'install' failed with exit code 2");
  });
});

describe("a running worktree setup fences Delete and Start", () => {
  const SOLO = { path: "/ws/proj/solo-loop", name: "solo" };

  it("refuses to delete the worktree, removing nothing", async () => {
    const busy = setupDeps({ steps: [INSTALL], worktrees: [SOLO], setupRunning: [SOLO.path] });
    const result = await deleteAgent(busy.deps, { name: "solo" });
    expect(result).toMatchObject({ outcome: "refused", worktree: SOLO.path, pr: null });
    expect(result.why).toBe(`a worktree setup is running in ${SOLO.path}; delete solo once the setup has finished`);
    expect(busy.calls.some((call) => call.startsWith("remove"))).toBe(false);
  });

  it("refuses to start the loop, starting nothing", async () => {
    const busy = setupDeps({ steps: [INSTALL], worktrees: [SOLO], setupRunning: [SOLO.path] });
    // Any lifecycle call would throw: the refusal comes before the gate and start.sh.
    const lifecycle = { now: () => new Date("2026-11-04T00:00:00.000Z") } as unknown as LifecycleDeps;
    const result = await gatedStart(busy.deps, lifecycle, { name: "solo", worktree: SOLO.path });
    expect(result).toMatchObject({ outcome: "refused", loop: "solo", worktree: SOLO.path, pid: null, at: "2026-11-04T00:00:00.000Z" });
    expect(result.why).toBe(`a worktree setup is running in ${SOLO.path}; start it once the setup has finished`);
  });
});
