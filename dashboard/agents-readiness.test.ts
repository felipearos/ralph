// @vitest-environment node
/**
 * A new agent's readiness checklist, over a fake executor.
 *
 * Here rather than in `agents-http.test.ts` because what has to be pinned is
 * how each item reads for an answer the real commands cannot be made to give
 * on demand: a worktree exactly one commit behind, a `models.json` that falls
 * back to a project block, a Jav config with `default` and nothing else, a
 * role that can only be read off an open roster PR's branch. The HTTP test
 * covers the routes against the real `preflight.ts` and `project-config.ts`.
 *
 * The fake answers by argv, so a test says what a command returned and not how
 * the adapter spelled it.
 */
import { describe, expect, it } from "vitest";

import { agentGuide, agentPreflight, listPendingAgents, locatePendingAgent, MERGED_FETCH_EVERY_MS, type AgentsDeps } from "./agents";
import {
  parseAgentConfig,
  parseJavRoutes,
  parseLabelDetails,
  parseLineupSource,
  parsePreflightJson,
  parseWorktreeList,
} from "./agents-adapter";
import type { ExecResult } from "./control-adapter";
import type { PendingAgentView, ReadinessItem, ReadinessItemKey, WorktreeSetupRecord, WorktreeSetupStepState } from "./contracts";

const ROOT = "/root";
const WORKTREE = "/ws/proj/nova-loop";
/** The agent the preflight route hands `agentPreflight`, already located. */
const READY = { name: "nova", worktree: WORKTREE, status: "ready" as const };

interface Answers {
  /** The main checkout's config, and the roster at each ref that can be read. */
  config: Record<string, unknown>;
  /** The refs a `git fetch` moves: read in place of `config`'s once one has run. */
  fetched?: Record<string, unknown>;
  /** What GitHub says of the roster PR; open when absent. */
  prState?: "open" | "merged" | "closed";
  /** `git fetch` fails. */
  fetchFails?: boolean;
  /** `git rev-parse <rev>` in the agent's worktree. */
  revs?: Record<string, string>;
  /** A worktree whose every `git rev-parse` fails, so one agent's read can break alone. */
  blindWorktree?: string;
  labels?: string[] | { fail: string };
  /** `preflight.ts --labels`'s answer for the loop's role. */
  needs?: string[] | { fail: string };
  lineup?: unknown | { fail: string };
  jav?: unknown | { fail: string };
  nodeModules?: boolean;
  /** The worktree's recorded setup run (`readWorktreeSetup`); none when absent. */
  setup?: WorktreeSetupRecord;
  /** A second agent on the page, so a shared read can be counted across two. */
  second?: boolean;
  preflight?: unknown;
  guide?: string | null;
}

const ok = (stdout: string): ExecResult => ({ status: 0, stdout, stderr: "" });
const bad = (stderr: string): ExecResult => ({ status: 1, stdout: "", stderr });
const failed = (value: unknown): value is { fail: string } =>
  typeof value === "object" && value !== null && "fail" in value;

/**
 * Just enough adapter to reach every item: each invocation carries the
 * question as its first argv word, and the fake answers that word.
 */
function deps(answers: Answers, clock: { at: number } = { at: 0 }): { deps: AgentsDeps; ran: () => string[][] } {
  const ran: string[][] = [];
  let fetched = false;
  const answer = (args: string[]): ExecResult => {
    const [what, first] = args;
    switch (what) {
      case "fetch":
        if (answers.fetchFails === true) return bad("fatal: unable to access the remote");
        fetched = true;
        return ok("");
      case "config": {
        const at = first!;
        const value = (fetched ? answers.fetched?.[at] : undefined) ?? answers.config[at];
        return value === undefined ? bad(`fatal: ambiguous argument '${at}'`) : ok(JSON.stringify(value));
      }
      case "worktree-list":
        return ok(
          [`worktree ${ROOT}`, "", `worktree ${WORKTREE}`, ...(answers.second === true ? ["", "worktree /ws/proj/mira-loop"] : []), ""].join("\n"),
        );
      case "rev-parse": {
        if (args[2] === answers.blindWorktree) return bad("fatal: not a git repository");
        const sha = (answers.revs ?? { HEAD: "a".repeat(40), "origin/main": "a".repeat(40) })[first!];
        return sha === undefined ? bad(`fatal: ambiguous argument '${first}'`) : ok(sha);
      }
      case "needs": {
        const needs = answers.needs ?? [`${args[1]}-wip`, `${args[1]}-blocked`, `${args[1]}-done`];
        return failed(needs) ? bad(needs.fail) : ok(needs.join("\n"));
      }
      case "label-list": {
        const labels = answers.labels ?? ["nova-wip", "nova-blocked", "nova-done", "mira-wip", "mira-blocked", "mira-done"];
        return failed(labels) ? bad(labels.fail) : ok(JSON.stringify(labels.map((name) => ({ name }))));
      }
      case "models": {
        const lineup = answers.lineup ?? { stages: { orchestrator: { model: "m", runner: "claude", source: "loop" } } };
        return failed(lineup) ? bad(lineup.fail) : ok(JSON.stringify(lineup));
      }
      case "jav": {
        const jav = answers.jav ?? { config: { enabled: false, routes: {} } };
        return failed(jav) ? bad(jav.fail) : ok(JSON.stringify(jav));
      }
      case "preflight":
        // Preflight exits non-zero for `denied` and `unavailable` by design.
        return { status: 1, stdout: JSON.stringify(answers.preflight ?? { verdict: "ready", checks: [] }), stderr: "" };
      default:
        return ok("");
    }
  };

  // Every operation runs one fake argv: recorded, answered by `answer`, and
  // parsed as the adapter's own parser would.
  const ask = async <T>(args: string[], parse: (result: ExecResult) => T): Promise<T> => {
    ran.push(args);
    return parse(answer(args));
  };
  const agents = {
    root: ROOT,
    project: "proj",
    worktreeFor: (name: string) => `/ws/proj/${name}-loop`,
    worktreesDir: () => "/ws/proj",
    readConfig: ({ ref } = {} as { ref?: string }) => ask(["config", ref ?? "@work"], parseAgentConfig),
    fetch: () => ask(["fetch"], (result) => (result.status === 0 ? { ok: true as const } : { ok: false as const, why: result.stderr })),
    listWorktrees: () => ask(["worktree-list"], parseWorktreeList),
    // The main checkout is no agent; each worktree is named after its loop.
    readLoopName: (path: string) => /^\/ws\/proj\/([a-z]+)-loop$/.exec(path)?.[1] ?? null,
    branchFor: (edit: string, name: string) => `ralph-roster/${edit}-${name}`,
    findPr: () =>
      ask(["pr-list"], () => ({
        ok: true,
        value: { url: "https://github.com/o/r/pull/7", branch: "ralph-roster/add-nova", state: answers.prState ?? "open" },
      })),
    supervisors: () => ask(["supervisors"], () => ({ ok: true, value: [] })),
    checkouts: () => ask(["checkouts"], () => ({ ok: true, value: { loops: [], orphaned: [], prunable: [] } })),
    revParse: (worktree: string, rev: string) =>
      ask(["rev-parse", rev, worktree], (result) =>
        result.status === 0 && result.stdout.trim() !== ""
          ? { ok: true as const, value: result.stdout.trim() }
          : { ok: false as const, why: result.stderr.trim() },
      ),
    labels: (name: string, role: string) =>
      ask(["needs", name, role], (result) =>
        result.status === 0
          ? { ok: true as const, value: result.stdout.split("\n").filter((line) => line !== "") }
          : { ok: false as const, why: result.stderr },
      ),
    listLabels: () => ask(["label-list"], parseLabelDetails),
    models: (name: string, role: string) => ask(["models", name, role], parseLineupSource),
    jav: () => ask(["jav"], parseJavRoutes),
    preflight: () => ask(["preflight"], parsePreflightJson),
    hasNodeModules: () => answers.nodeModules ?? true,
    readWorktreeSetup: () => answers.setup ?? null,
    readGuide: () =>
      answers.guide === null ? { ok: false, why: "/cli/adding-an-agent.md could not be read: ENOENT" } : { ok: true, value: answers.guide ?? "# Adding a new agent (loop)\n" },
    readProjectFile: () => ({ ok: false, missing: true, why: "not read in these tests" }),
    renderPrompt: async () => ({ ok: false, why: "not rendered in these tests" }),
  } as unknown as AgentsDeps["agents"];
  // A fresh throttle per fake, on a clock the test moves by hand.
  return { deps: { agents, mergedFetches: { now: () => clock.at, last: new Map() } }, ran: () => ran };
}

const CONFIG = { repo: "o/r", baseBranch: "main", loops: [] as string[] };
const onBase = { ...CONFIG, loops: ["nova"], roster: [{ name: "nova", role: "coder" }] };
const prBranch = { ...CONFIG, loops: ["nova"], roster: [{ name: "nova", role: "triager" }] };

/** The one agent `listPendingAgents` finds, for the answers given. */
const only = async (answers: Answers): Promise<PendingAgentView> => {
  const view = await listPendingAgents(deps(answers).deps);
  expect(view.pending).toHaveLength(1);
  return view.pending[0]!;
};

const itemOf = (agent: PendingAgentView, key: ReadinessItemKey): ReadinessItem | undefined =>
  agent.readiness.find((entry) => entry.key === key);

describe("the items of a pending agent's readiness", () => {
  it("passes the roster-PR item only once the base branch lists it, and keeps the items in order", async () => {
    const ready = await only({ config: { "@work": CONFIG, "origin/main": onBase } });
    expect(ready.status).toBe("ready");
    expect(itemOf(ready, "roster-pr")).toMatchObject({ state: "pass", label: "roster PR merged" });
    // `preflight` is never one of them: this route is polled every 5 s.
    expect(ready.readiness.map((entry) => entry.key)).toEqual(["roster-pr", "worktree", "labels", "lineup", "node-modules"]);

    const pending = await only({ config: { "@work": CONFIG, "origin/main": CONFIG, "origin/ralph-roster/add-nova": prBranch } });
    expect(pending.status).toBe("pending-merge");
    const item = itemOf(pending, "roster-pr")!;
    expect(item.state).toBe("fail");
    expect(item.reason).toContain("its roster PR is open");
  });

  it("fails the worktree item for a worktree merely BEHIND the base, not only a diverged one", async () => {
    // The whole point of comparing exactly: `merge-base --is-ancestor` exits 0
    // for "behind or equal", so this agent would have read as ready.
    const behind = await only({
      config: { "@work": CONFIG, "origin/main": onBase },
      revs: { HEAD: "b".repeat(40), "origin/main": "c".repeat(40) },
    });
    const item = itemOf(behind, "worktree")!;
    expect(item.state).toBe("fail");
    expect(item.reason).toContain("bbbbbbb");
    expect(item.reason).toContain("ccccccc");
    // The reason says what it compared against, and that Start moves a ready
    // agent up anyway, so the fail is not read as a blocker.
    expect(item.reason).toContain("as last fetched");
    expect(item.reason).toContain("runs no git fetch");
    expect(item.reason).toContain("warning, not a blocker");
  });

  it("reads the worktree item as unknown when git could not answer, and still answers every other item", async () => {
    const agent = await only({ config: { "@work": CONFIG, "origin/main": onBase }, revs: {} });
    expect(itemOf(agent, "worktree")).toMatchObject({ state: "unknown" });
    expect(itemOf(agent, "labels")).toMatchObject({ state: "pass" });
    expect(itemOf(agent, "node-modules")).toMatchObject({ state: "pass" });
  });

  it("names every label the role needs that the project has not got", async () => {
    const agent = await only({
      config: { "@work": CONFIG, "origin/main": onBase },
      needs: ["nova-wip", "nova-blocked", "nova-done"],
      labels: ["nova-wip"],
    });
    const item = itemOf(agent, "labels")!;
    expect(item.state).toBe("fail");
    expect(item.reason).toContain("nova-blocked, nova-done");
    expect(item.reason).toContain("loop-labels");
  });

  it("matches labels case-insensitively, as GitHub does", async () => {
    const agent = await only({
      config: { "@work": CONFIG, "origin/main": onBase },
      needs: ["nova-wip"],
      labels: ["Nova-WIP"],
    });
    expect(itemOf(agent, "labels")).toMatchObject({ state: "pass" });
  });

  it("names the block a loop without its own lineup falls back to", async () => {
    const agent = await only({
      config: { "@work": CONFIG, "origin/main": onBase },
      lineup: { stages: { orchestrator: { model: "m", runner: "claude", source: "project" } } },
    });
    const item = itemOf(agent, "lineup")!;
    expect(item.state).toBe("fail");
    expect(item.reason).toContain("'project' block");
  });

  it("shows the Jav item only where Jav is on and the role takes frontier work", async () => {
    const off = await only({ config: { "@work": CONFIG, "origin/main": onBase } });
    expect(itemOf(off, "jav")).toBeUndefined();

    const routed = await only({
      config: { "@work": CONFIG, "origin/main": onBase },
      jav: { config: { enabled: true, routes: { nova: ["difficulty:easy"] } } },
    });
    expect(itemOf(routed, "jav")).toMatchObject({ state: "pass" });

    // `routes.default` is a route: a coder without one of its own falls back.
    const fallback = await only({
      config: { "@work": CONFIG, "origin/main": onBase },
      jav: { config: { enabled: true, routes: { default: ["difficulty:easy"] } } },
    });
    expect(itemOf(fallback, "jav")!.reason).toContain("falls back to 'default' (difficulty:easy)");

    const unrouted = await only({
      config: { "@work": CONFIG, "origin/main": onBase },
      jav: { config: { enabled: true, routes: {} } },
    });
    expect(itemOf(unrouted, "jav")).toMatchObject({ state: "fail" });

    // A route declared with no labels in it is no route: Jav's gate would hand
    // the loop nothing, which is exactly what this item is about.
    const empty = await only({
      config: { "@work": CONFIG, "origin/main": onBase },
      jav: { config: { enabled: true, routes: { nova: [], default: [] } } },
    });
    expect(itemOf(empty, "jav")).toMatchObject({ state: "fail" });

    // A triager takes no frontier work, so the item is absent even with Jav on.
    const triager = await only({
      config: { "@work": CONFIG, "origin/main": { ...onBase, roster: [{ name: "nova", role: "triager" }] } },
      jav: { config: { enabled: true, routes: {} } },
    });
    expect(itemOf(triager, "jav")).toBeUndefined();
  });

  it("fails node_modules when the worktree has none", async () => {
    const agent = await only({ config: { "@work": CONFIG, "origin/main": onBase }, nodeModules: false });
    expect(itemOf(agent, "node-modules")).toMatchObject({ state: "fail" });
    expect(itemOf(agent, "node-modules")!.reason).toContain("bun install");
  });
});

describe("the node_modules item over worktreeSetup steps (#694)", () => {
  const install = { name: "install", command: "bun install", timeoutSeconds: 600, installsDependencies: true };
  const withSetup = (steps: unknown[]) => ({ ...CONFIG, worktreeSetup: steps });
  const record = (state: WorktreeSetupStepState, name = "install"): WorktreeSetupRecord => ({
    ranAt: "2026-11-04T00:00:00.000Z",
    steps: [
      {
        name,
        command: "bun install",
        state,
        durationMs: 10,
        exitCode: state === "failed" ? 1 : state === "passed" ? 0 : null,
        output: "",
        truncated: false,
        limitMs: 600_000,
        error: null,
      },
    ],
  });

  it("passes on the install step's recorded pass, whatever node_modules holds", async () => {
    const agent = await only({ config: { "@work": withSetup([install]), "origin/main": onBase }, nodeModules: false, setup: record("passed") });
    expect(itemOf(agent, "node-modules")).toMatchObject({ state: "pass" });
    expect(itemOf(agent, "node-modules")!.reason).toContain("setup step 'install' installed its dependencies");
  });

  it("fails on a recorded failure or timeout, naming the step and its state, and points at Rerun setup", async () => {
    const failed = await only({ config: { "@work": withSetup([install]), "origin/main": onBase }, setup: record("failed") });
    const item = itemOf(failed, "node-modules")!;
    expect(item.state).toBe("fail");
    expect(item.reason).toContain("setup step 'install' failed with exit code 1");
    expect(item.reason).toContain("Rerun setup");
    expect(item.reason).not.toContain("bun install there");

    const timedOut = await only({ config: { "@work": withSetup([install]), "origin/main": onBase }, setup: record("timeout") });
    expect(itemOf(timedOut, "node-modules")!.reason).toContain("timed out after 600s");
  });

  it("fails when the step has not run here: no record, or a record without it", async () => {
    // node_modules being there proves nothing about an install that never ran.
    const none = await only({ config: { "@work": withSetup([install]), "origin/main": onBase }, nodeModules: true });
    expect(itemOf(none, "node-modules")).toMatchObject({ state: "fail" });
    expect(itemOf(none, "node-modules")!.reason).toContain("setup step 'install' has not run in this worktree");

    const other = await only({ config: { "@work": withSetup([install]), "origin/main": onBase }, setup: record("passed", "codegen") });
    expect(itemOf(other, "node-modules")!.reason).toContain("has not run in this worktree");
  });

  it("reads node_modules as before when no step installs dependencies", async () => {
    const steps = [{ ...install, name: "codegen", installsDependencies: false }];
    const agent = await only({ config: { "@work": withSetup(steps), "origin/main": onBase }, nodeModules: false, setup: record("failed", "codegen") });
    expect(itemOf(agent, "node-modules")).toMatchObject({ state: "fail" });
    expect(itemOf(agent, "node-modules")!.reason).toContain("run bun install there");
  });
});

describe("a roster PR merged since the base branch was last fetched", () => {
  it("fetches the base branch once and reads the agent as ready, so the card flips with no loop running", async () => {
    const { deps: fake, ran } = deps({
      config: { "@work": CONFIG, "origin/main": CONFIG, "origin/ralph-roster/add-nova": prBranch },
      fetched: { "origin/main": onBase },
      prState: "merged",
    });
    const view = await listPendingAgents(fake);
    expect(view.pending[0]!.status).toBe("ready");
    expect(ran().filter((args) => args[0] === "fetch")).toHaveLength(1);
  });

  it("fetches nothing while the PR is open, and stays pending when the fetch fails", async () => {
    const open = deps({ config: { "@work": CONFIG, "origin/main": CONFIG, "origin/ralph-roster/add-nova": prBranch } });
    expect((await listPendingAgents(open.deps)).pending[0]!.status).toBe("pending-merge");
    expect(open.ran().some((args) => args[0] === "fetch")).toBe(false);

    const offline = deps({
      config: { "@work": CONFIG, "origin/main": CONFIG, "origin/ralph-roster/add-nova": prBranch },
      prState: "merged",
      fetchFails: true,
    });
    const view = await listPendingAgents(offline.deps);
    expect(view.pending[0]!.status).toBe("pending-merge");
    expect(view.problem).toBeNull();
  });

  it("does not fetch on every poll while the merged PR still leaves the agent off the base", async () => {
    // Merged into another branch: a fetch succeeds and main still does not list it.
    const clock = { at: 0 };
    const { deps: fake, ran } = deps(
      { config: { "@work": CONFIG, "origin/main": CONFIG, "origin/ralph-roster/add-nova": prBranch }, prState: "merged" },
      clock,
    );
    const fetches = () => ran().filter((args) => args[0] === "fetch").length;
    await listPendingAgents(fake);
    expect(fetches()).toBe(1);
    clock.at += 5_000;
    await listPendingAgents(fake);
    clock.at += MERGED_FETCH_EVERY_MS - 10_000;
    await listPendingAgents(fake);
    expect(fetches()).toBe(1);
    clock.at += 5_000;
    expect((await listPendingAgents(fake)).pending[0]!.status).toBe("pending-merge");
    expect(fetches()).toBe(2);
  });
});

describe("the role behind the role-dependent items", () => {
  it("takes a pending agent's role from its roster PR's branch, so its labels are checked while the PR is open", async () => {
    const { deps: fake, ran } = deps({
      config: { "@work": CONFIG, "origin/main": CONFIG, "origin/ralph-roster/add-nova": prBranch },
      needs: ["nova-wip", "ci-health"],
      labels: ["nova-wip"],
    });
    const view = await listPendingAgents(fake);
    const agent = view.pending[0]!;
    expect(agent.role).toBe("triager");
    // The roster was read at the PR's head ref, with no fetch anywhere.
    expect(ran()).toContainEqual(["config", "origin/ralph-roster/add-nova"]);
    expect(ran().some((args) => args[0] === "fetch")).toBe(false);
    // And the labels checked are the TRIAGER's, which is the point.
    expect(ran()).toContainEqual(["needs", "nova", "triager"]);
    expect(itemOf(agent, "labels")!.reason).toContain("ci-health");
  });

  it("reads the role-dependent items as unknown, never as a coder's, when no roster answers", async () => {
    // Neither ref has an entry for it: the label triple a coder would need is
    // not what a triager needs, and a wrong pass is a start preflight denies
    // with nothing saying why.
    const agent = await only({ config: { "@work": CONFIG, "origin/main": CONFIG, "origin/ralph-roster/add-nova": CONFIG } });
    expect(agent.role).toBeNull();
    for (const key of ["labels", "lineup"] as const) {
      expect(itemOf(agent, key)).toMatchObject({ state: "unknown" });
      expect(itemOf(agent, key)!.reason).toContain("this check is the role's");
    }
    // The Jav item is ABSENT rather than unknown: whether it applies at all is
    // the role's answer, and a "Jav route — unknown" line on a project with
    // Jav off describes a step that does not exist. The two unknowns above
    // already say the role could not be read.
    expect(itemOf(agent, "jav")).toBeUndefined();
    // The items that do not need a role still answer.
    expect(itemOf(agent, "worktree")).toMatchObject({ state: "pass" });
  });

  it("quotes what narrowing said about a roster it could not read", async () => {
    const agent = await only({
      config: { "@work": CONFIG, "origin/main": { ...onBase, roster: [{ name: "nova", role: "sleuth" }] } },
    });
    expect(agent.role).toBeNull();
    expect(itemOf(agent, "labels")!.reason).toContain("sleuth");
  });
});

describe("the project's labels and Jav's config are read once per request", () => {
  it("shares both across every agent on the page", async () => {
    const { deps: fake, ran } = deps({
      config: {
        "@work": CONFIG,
        "origin/main": { ...CONFIG, loops: ["nova", "mira"], roster: [{ name: "nova", role: "coder" }, { name: "mira", role: "coder" }] },
      },
      jav: { config: { enabled: true, routes: { default: ["difficulty:easy"] } } },
      second: true,
    });
    // Two agents on the page: each needs the project's labels and Jav's
    // config, and both reads are made once for the request.
    const view = await listPendingAgents(fake);
    expect(view.pending).toHaveLength(2);
    expect(ran().filter((args) => args[0] === "label-list")).toHaveLength(1);
    expect(ran().filter((args) => args[0] === "jav")).toHaveLength(1);
  });

  it("asks for neither when no agent's role could be read", async () => {
    const { deps: fake, ran } = deps({ config: { "@work": CONFIG, "origin/main": CONFIG, "origin/ralph-roster/add-nova": CONFIG } });
    await listPendingAgents(fake);
    expect(ran().some((args) => args[0] === "label-list")).toBe(false);
    expect(ran().some((args) => args[0] === "jav")).toBe(false);
  });
});

describe("one agent's failures stay its own", () => {
  it("reads the broken agent's item as unknown and leaves the other card complete", async () => {
    const { deps: fake } = deps({
      config: {
        "@work": CONFIG,
        "origin/main": { ...CONFIG, loops: ["nova", "mira"], roster: [{ name: "nova", role: "coder" }, { name: "mira", role: "coder" }] },
      },
      second: true,
      blindWorktree: "/ws/proj/mira-loop",
    });
    const view = await listPendingAgents(fake);
    expect(view.pending).toHaveLength(2);
    const nova = view.pending.find((agent) => agent.name === "nova")!;
    const mira = view.pending.find((agent) => agent.name === "mira")!;
    expect(itemOf(mira, "worktree")).toMatchObject({ state: "unknown" });
    // The other agent's worktree item is unaffected, and mira's own other
    // items still answer: a failed read is one item of one card.
    expect(itemOf(nova, "worktree")).toMatchObject({ state: "pass" });
    expect(itemOf(mira, "labels")).toMatchObject({ state: "pass" });
    expect(view.problem).toBeNull();
  });
});

describe("the preflight item, on its own route", () => {
  it("is not run by GET /api/agents", async () => {
    const { deps: fake, ran } = deps({ config: { "@work": CONFIG, "origin/main": onBase } });
    await listPendingAgents(fake);
    expect(ran().some((args) => args[0] === "preflight")).toBe(false);
  });

  it("reads ready as a pass, denied as a fail naming the check, and unavailable as unknown", async () => {
    const { deps: fake } = deps({ config: { "@work": CONFIG, "origin/main": onBase } });
    expect(await agentPreflight(fake, READY)).toMatchObject({
      name: "nova",
      item: { key: "preflight", state: "pass" },
    });

    const { deps: denied } = deps({
      config: { "@work": CONFIG, "origin/main": onBase },
      // `preflight.ts`'s real shape, not a flat one invented here: a fake
      // that disagrees with the CLI is a second copy of its contract.
      preflight: {
        verdict: "denied",
        checks: [
          { name: "loop-labels", outcome: { status: "denied", why: "no nova-wip label", remedy: "gh label create nova-wip" } },
          { name: "logs-writable", outcome: { status: "ok" } },
        ],
      },
    });
    const refusal = await agentPreflight(denied, READY);
    expect(refusal.item.state).toBe("fail");
    // The check that denied it, read out of `checks[].outcome.status`: naming
    // it is the whole difference between this card and the refusal an operator
    // used to meet only at the first start.
    expect(refusal.item.reason).toContain("loop-labels");
    expect(refusal.item.reason).not.toContain("logs-writable");

    const { deps: unavailable } = deps({
      config: { "@work": CONFIG, "origin/main": onBase },
      preflight: { verdict: "unavailable", checks: [] },
    });
    expect((await agentPreflight(unavailable, READY)).item.state).toBe("unknown");
  });

  it("does not run at all for a pending-merge agent, and says why no verdict is available", async () => {
    // Its worktree's config does not list it yet and `resolveLoopName` accepts
    // only a name on that roster, so preflight would deny on identity — which
    // would read as the agent's fault rather than the clock's.
    const { deps: fake, ran } = deps({ config: { "@work": CONFIG, "origin/main": CONFIG } });
    const answer = await agentPreflight(fake, { ...READY, status: "pending-merge" });
    expect(answer.item).toMatchObject({ key: "preflight", state: "unknown" });
    expect(answer.item.reason).toContain("no verdict is available until its roster PR merges");
    expect(ran().some((args) => args[0] === "preflight")).toBe(false);
  });

  it("reports that no verdict is available when preflight printed none", async () => {
    const { deps: fake } = deps({ config: { "@work": CONFIG, "origin/main": onBase }, preflight: { checks: [] } });
    const answer = await agentPreflight(fake, READY);
    expect(answer.item).toMatchObject({ state: "unknown" });
    expect(answer.item.reason).toContain("no verdict is available");
  });
});

describe("locating one pending agent for its preflight", () => {
  it("finds it from the worktree list alone: no gh, no fetch, and not the whole readiness fold", async () => {
    const { deps: fake, ran } = deps({ config: { "@work": CONFIG, "origin/main": onBase } });
    const found = await locatePendingAgent(fake, "nova");
    expect(found).toEqual({ ok: true, value: { name: "nova", worktree: WORKTREE, status: "ready" } });
    // The cheap reads only — the fold's label list, lineup, Jav and the PR
    // lookup are what the route exists to keep off a button press.
    for (const command of ["label-list", "jav", "models", "needs", "pr-list", "fetch"]) {
      expect(ran().some((args) => args[0] === command)).toBe(false);
    }
  });

  it("reads a name the base branch already lists as pending-merge, and an unknown one as absent", async () => {
    const { deps: pending } = deps({ config: { "@work": CONFIG, "origin/main": CONFIG } });
    expect(await locatePendingAgent(pending, "nova")).toMatchObject({ ok: true, value: { status: "pending-merge" } });
    const { deps: fake } = deps({ config: { "@work": CONFIG, "origin/main": onBase } });
    expect(await locatePendingAgent(fake, "mira")).toMatchObject({ ok: false, why: "no new agent 'mira'" });
  });
});

describe("the guide view", () => {
  it("carries the file's bytes and the project's values", async () => {
    const { deps: fake } = deps({ config: { "@work": CONFIG, "origin/main": onBase }, guide: "# Adding a new agent (loop)\n\nstep\n" });
    const view = await agentGuide(fake);
    expect(view.markdown).toContain("# Adding a new agent (loop)");
    expect(view.problem).toBeNull();
    expect(view.values).toEqual({ project: "proj", repo: "o/r", baseBranch: "main", root: ROOT, worktrees: "/ws/proj" });
  });

  it("says why when the guide file could not be read", async () => {
    const { deps: fake } = deps({ config: { "@work": CONFIG, "origin/main": onBase }, guide: null });
    const view = await agentGuide(fake);
    expect(view.markdown).toBe("");
    expect(view.problem).toContain("adding-an-agent.md");
  });
});
