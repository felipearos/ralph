// @vitest-environment node
/**
 * The dashboard's HTTP surface, driven in-process (#624): each case builds the
 * server `main()` would build — the same environment record parsed by the same
 * config functions, `composeServer` over the real adapter factories — and
 * hands a `Request` straight to its `fetch`, with no `Bun.serve`, no port and
 * no child `bun` to boot per case.
 *
 * In-process because what these cases pin is the routes and the adapters
 * behind them, not the Bun entrypoint: that has its own few cases in
 * `server.test.ts`. The adapters are the real ones, but every command they
 * run goes through the composition's one executor factory (#626), and here
 * that factory hands back a recording executor answering from the scripted
 * world in `adapter-script.ts`. So a fixture describes runtime STATE — the
 * loop-state report, each worktree's presence, its control record, its
 * timeline — and the recorder answers each CLI with it: no harness CLI runs,
 * and no fake `git`, `gh`, runner or Orca sits on any PATH. What each CLI
 * prints for a given disk is that CLI's own suite's. A scratch root on disk
 * still holds what the server reads and writes directly: iteration logs,
 * loop-name files, each worktree's records feed, the loop record a control
 * write is fenced by, and the control inbox it writes to.
 *
 * Two things still spawn, neither of them a fake on PATH: the pane's redactor
 * (`redact.ts` under the absolute bun running this suite, an exec-free
 * factory whose streams an `Executor` cannot carry) and the lineup editor's
 * `models.ts` reads, behind the `lineup` dep rather than the executor.
 *
 * Several projects are a registry file under the scratch config home, each
 * project a directory under the root, and an answer keyed by the root or
 * checkout an invocation names reads that project's state alone. A case about
 * which CLI ran where asserts on `rec.calls`. The Usage route is not here: its
 * source's worker only loads under Bun (see `server.test.ts`).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { JsonObject } from "../lineup/contracts";
import { createLineupAdapter } from "../lineup/adapter";
import { configFromEnv as lineupConfigFromEnv } from "../lineup/config";
import { block, cleanupFixtures as cleanupLineupFixtures, rootWith } from "../lineup/fixtures";
import { RALPH_HOME, projectRoot } from "../paths";
import { createRalphAdapter } from "./adapter";
import {
  BUN,
  CLI_DIR,
  JOURNAL_HOME,
  PYTHON,
  fail,
  loopReport,
  observeIn,
  ok,
  okText,
  presence,
  isSurface,
  scriptedExecutor,
  type SurfaceName,
  type WorldScript,
} from "./adapter-script";
import { composeServer, processFactories, type ServerDeps } from "./compose";
import { configFromEnv } from "./config";
import { CONTROL_SURFACE, type Invocation } from "./control-adapter";
import { bunPath, cleanupFixtures, scratchRoot, writeLoopState, leaseRecord } from "./fixtures";
import { createProjectRegistry, projectsFile } from "./projects";
import { reconcileConfigFromEnv } from "./reconcile";
import type { Answer, Matcher, RecordingExecutor } from "./recording-executor";
import { subprocessSuite } from "../test-timeouts";
import { RUNTIME_REUSE_MS } from "./server";
import { POLL_MS } from "./ui/reads";

subprocessSuite("runs the pane's redactor and the lineup's models.ts behind an in-process handler");

afterAll(() => {
  cleanupFixtures();
});

/** Any loopback origin: nothing listens on it, it only makes the URLs absolute. */
const BASE = "http://127.0.0.1:8791";

interface InProcessServer {
  base: string;
  /** A path or an absolute URL, answered by the composed handler. */
  fetch: (pathOrUrl: string, init?: RequestInit) => Promise<Response>;
  /** Ends what the case started: its chats and its usage workers. */
  stop: () => void;
}

/** `controls.ts status --json` as the control adapter runs it, for one worktree. */
const controlStatusIn = (worktree: string) => (i: Invocation): boolean =>
  i.command === BUN &&
  i.args[0] === join(CLI_DIR, CONTROL_SURFACE.controlStatus.script) &&
  CONTROL_SURFACE.controlStatus.args.every((arg, index) => i.args[index + 1] === arg) &&
  i.env.RALPH_STATE_ROOT === worktree;

/** Any `controls.ts status --json`, whichever worktree it is asked about. */
const isControlStatus = (i: Invocation): boolean =>
  i.command === BUN &&
  i.args[0] === join(CLI_DIR, CONTROL_SURFACE.controlStatus.script) &&
  CONTROL_SURFACE.controlStatus.args.every((arg, index) => i.args[index + 1] === arg);

const toMatcher = (surface: SurfaceName | Matcher): Matcher =>
  typeof surface === "string" ? isSurface(surface) : surface;

/** `loop-state status --json` listing `reports`, with what its reconciliation names. */
const loopStateWith = (reports: readonly unknown[], orphaned: readonly string[] = []) => (i: Invocation) =>
  ok({ self: i.env.RALPH_STATE_ROOT ?? "", loops: reports, reconciliation: { orphaned, prunable: [] } });

interface ScriptedServer extends InProcessServer {
  /** The scratch root the server is configured with: worktrees live under it. */
  root: string;
  /** The recorder: `calls` is every command the server ran, `rules` the live script. */
  rec: RecordingExecutor;
  /** Answers one surface (or any narrower matcher) ahead of everything scripted so far. */
  answer: (surface: SurfaceName | Matcher, answer: Answer) => ScriptedServer;
  /** A worktree directory under the root, with `.ralph/logs`; `loopName` writes its `.ralph/loop-name`. */
  worktree: (name: string, loopName?: string) => string;
  /** A registered project's checkout, `<root>/<id>` (only with `projects`). */
  project: (id: string) => string;
  /** Rewrites the registry file to name exactly `ids`, as an operator removing a project would. */
  register: (ids: readonly string[]) => void;
}

interface ScriptedOptions {
  /** The world's defaults and per-surface overrides, as `adapter-script.ts` takes them. */
  script?: WorldScript;
  /** Extra environment for the parsed config (`RALPH_LINEUP_ROOTS`, say); never a PATH. */
  env?: Record<string, string | undefined>;
  /**
   * Registered projects, by id: each gets a checkout at `<root>/<id>` and an
   * entry in the scratch registry file, and the roots variable is emptied so
   * the registry, not the variable, names them. Each project's reads are its
   * own only where a case keys an answer by root (`RALPH_STATE_ROOT`, the
   * invocation's `cwd`); unkeyed, every project gets the same answer.
   */
  projects?: readonly string[];
  /** How long a project's runtime read is reused; absent, the handler's default. */
  runtimeReuseMs?: number;
  /** The change stream's timings, passed through to `composeServer`. */
  snapshotStream?: ServerDeps["snapshotStream"];
  /** Called on every full adapter read, before it runs. */
  onAdapterRead?: () => void;
}

/**
 * The server `main()` builds over a scripted runtime: the config parsed from
 * the environment `main()` would get, with its roots at a fresh scratch root
 * and its bun at the world's {@link BUN}, and the composition's executor
 * factory returning one recorder for every timeout surface — the timeout is
 * the process executor's concern, and nothing here is a process. The
 * recorder answers every `COMMAND_SURFACE` read neutrally until a case says
 * otherwise, and a loop with no control record (`null`) for every control
 * read; anything else falls to `unexpected` (127), visible in `rec.calls`.
 */
function scriptedServer(
  label: string,
  { script = {}, env = {}, projects, snapshotStream, onAdapterRead, runtimeReuseMs }: ScriptedOptions = {},
): ScriptedServer {
  const root = scratchRoot(label);
  const configHome = join(root, "config");
  const registryFile = join(configHome, "ralph", "projects.json");
  const register = (ids: readonly string[]): void => {
    mkdirSync(join(configHome, "ralph"), { recursive: true });
    writeFileSync(
      registryFile,
      JSON.stringify(ids.map((id) => ({ id, path: join(root, id), addedAt: "2026-09-23T00:00:00.000Z", source: "local" }))),
    );
  };
  if (projects !== undefined) {
    // A `.git` directory, as a clone leaves one: the checkout the registry names.
    for (const id of projects) mkdirSync(join(root, id, ".git"), { recursive: true });
    register(projects);
  }
  const rec = scriptedExecutor(script);
  rec.on(isControlStatus, okText("null\n"));
  // The project is set up: its config is on the base branch. A failed read
  // asks onboarding whether the project is ready before it answers, and a
  // project that is not would turn every read failure into a 409.
  rec.on({ command: "git", args: ["cat-file", "-e"] }, okText(""));
  // The registry file under the scratch root, never this host's: the roots
  // override it anyway, but a registry that writes must not write the operator's.
  const caseEnv: Record<string, string | undefined> = {
    RALPH_DASHBOARD_RECONCILE_MS: "0",
    RALPH_DASHBOARD_PORT: "0",
    // With projects, unset: the registry, not the variable, names them.
    RALPH_DASHBOARD_ROOTS: projects === undefined ? root : "",
    RALPH_DASHBOARD_BUN: BUN,
    XDG_CONFIG_HOME: configHome,
    ...env,
  };
  const merged: Record<string, string | undefined> = { ...process.env, ...caseEnv };
  const config = configFromEnv(merged, { cliDir: CLI_DIR, root: projectRoot() });
  const registry = createProjectRegistry({
    file: projectsFile(merged),
    seed: config.roots,
    override: config.rootsOverride ? config.roots : null,
  });
  const lineupConfig = lineupConfigFromEnv(merged, { cliDir: RALPH_HOME, root: RALPH_HOME });
  // `main()` also warms the lineup catalog at boot; no case reads the
  // catalog, so no case pays for the harness probes it runs. Its env is the
  // case's alone: the editor reads resolved config, which needs no runner.
  const lineup = createLineupAdapter({
    cliDir: lineupConfig.cliDir,
    roots: lineupConfig.roots,
    env: caseEnv,
    ...(lineupConfig.bunPath === undefined ? {} : { bunPath: lineupConfig.bunPath }),
  });
  const usageSources: { close(): void }[] = [];
  const composed = composeServer({
    ...(snapshotStream === undefined ? {} : { snapshotStream }),
    ...(runtimeReuseMs === undefined ? {} : { runtimeReuseMs }),
    config,
    registry,
    shell: { html: "<!doctype html><title>Ralph dashboard</title>", assets: new Map() },
    harness: CLI_DIR,
    reconciling: reconcileConfigFromEnv(merged),
    lineup,
    executor: () => rec.exec,
    // The world's python and journal home, which `isSurface` matches on. The
    // adapter merges its env over `process.env`, and the test host runs live
    // loops, so the variables it reads from there are pinned to neutral.
    ralphAdapter: (adapterConfig) => {
      const adapter = createRalphAdapter({
        ...adapterConfig,
        pythonPath: PYTHON,
        journalHome: JOURNAL_HOME,
        env: { HOME: join(root, "home"), RALPH_JOURNAL_DIR: "", RALPH_TRIAGE_MAX_WRITES: "", ...adapterConfig.env },
      });
      if (onAdapterRead === undefined) return adapter;
      // Counted per call, not per CLI run: the adapter shares one run between overlapping callers.
      return {
        ...adapter,
        read: () => {
          onAdapterRead();
          return adapter.read();
        },
      };
    },
    factories: {
      ...processFactories,
      // The pane's redactor and a chat's runner own a child whose streams an
      // `Executor` cannot carry: they run under the bun running this suite,
      // not the world's fake {@link BUN}.
      redactor: (redactorConfig) => processFactories.redactor({ ...redactorConfig, bunPath: bunPath(), env: merged }),
      chatRunner: (runnerConfig) => processFactories.chatRunner({ ...runnerConfig, bunPath: bunPath(), env: merged }),
      usage: (options) => {
        const source = processFactories.usage(options);
        usageSources.push(source);
        return source;
      },
      // Never the operator's own cache file.
      usagebarMemory: () => ({ load: () => null, save: () => {} }),
    },
  });
  const server: ScriptedServer = {
    base: BASE,
    root,
    rec,
    fetch: (pathOrUrl, init) => composed.fetch(new Request(new URL(pathOrUrl, BASE), init)),
    stop: () => {
      composed.chats.stopAll();
      for (const source of usageSources.splice(0)) source.close();
    },
    answer: (surface, answer) => {
      rec.rules.unshift({ match: toMatcher(surface), answer });
      return server;
    },
    worktree: (name, loopName) => {
      const path = join(root, name);
      mkdirSync(join(path, ".ralph", "logs"), { recursive: true });
      if (loopName !== undefined) writeFileSync(join(path, ".ralph", "loop-name"), `${loopName}\n`);
      return path;
    },
    project: (id) => join(root, id),
    register,
  };
  return server;
}

describe("the dashboard over HTTP", () => {
  it("serves the roster, a single loop, and refuses the rest", async () => {
    const server = scriptedServer("http");
    const ralph = server.worktree("wt-ralph");
    const rafa = server.worktree("wt-rafa");
    // The registry names a worktree whose directory is gone: loop-state
    // reports it orphaned and names it in its reconciliation.
    const gone = join(server.root, "wt-remo");
    server.answer(
      "loopState",
      loopStateWith(
        [
          loopReport(ralph, { loop: "ralph" }),
          loopReport(rafa, { loop: "rafa" }),
          { ...loopReport(gone, { state: null }), worktreeStatus: "orphaned", loopStatus: "orphaned", supervisor: "unknown" },
        ],
        [gone],
      ),
    );
    try {
      const response = await server.fetch(`/api/loops`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        generatedAt: string;
        loops: { loop: string; role: string; present: boolean; loopStatus: string; worktreeStatus: string }[];
        reconciliation: { orphaned: string[]; prunable: string[] };
      };
      expect(body.loops.map((loop) => loop.loop)).toEqual(["ralph", "rafa", "remo", "rulo"]);
      expect(body.loops.find((loop) => loop.loop === "ralph")).toMatchObject({
        present: true,
        worktreeStatus: "live",
      });
      // Every loop reports a role, and this project's config spells them all
      // as bare names, so every one of them is a coder.
      expect(body.loops.map((loop) => loop.role)).toEqual(["coder", "coder", "coder", "coder"]);
      // The roster loop with no checkout is unknown, not a healthy loop.
      expect(body.loops.find((loop) => loop.loop === "remo")).toMatchObject({
        present: false,
        loopStatus: "unknown",
        worktreeStatus: "unknown",
      });
      // The gone worktree is reconciliation, never a loop panel.
      expect(body.reconciliation.orphaned).toEqual([gone]);
      expect(body.loops.some((loop) => loop.present && loop.worktreeStatus === "orphaned")).toBe(false);

      const single = await server.fetch(`/api/loops/ralph`);
      expect(single.status).toBe(200);
      expect((await single.json()) as { loop: string }).toMatchObject({ loop: "ralph" });

      expect((await server.fetch(`/api/loops/nope`)).status).toBe(404);
      expect((await server.fetch(`/api/nope`)).status).toBe(404);
      expect((await server.fetch(`/api/loops`, { method: "POST" })).status).toBe(405);
    } finally {
      server.stop();
    }
  });

  it("streams a loop's iteration log, redacted, and refuses writes to it", async () => {
    const server = scriptedServer("http-output");
    const ralph = server.worktree("wt-ralph");
    server.answer("loopState", loopStateWith([loopReport(ralph, { loop: "ralph" })]));
    const token = "ghp_" + "Z9y8X7w6V5u4T3s2R1q0P9o8";
    writeFileSync(join(ralph, ".ralph", "logs", "iter-20260902T100000.log"), `[t] text: hello ${token}\n`);

    try {
      const controller = new AbortController();
      const response = await server.fetch(`/api/loops/ralph/output`, { signal: controller.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let received = "";
      const deadline = Date.now() + 20_000;
      while (!received.includes("hello") && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value);
      }
      controller.abort();
      // No socket closes in-process: cancelling the body is what ends the follow.
      await reader.cancel();
      expect(received).toContain('"kind":"reset","log":"iter-20260902T100000.log"');
      expect(received).toContain("hello [redacted:github-token]");
      expect(received).not.toContain(token);

      // A loop with no checkout is an empty pane with a reason, not an error.
      const absent = await server.fetch(`/api/loops/remo/output`);
      expect(absent.status).toBe(200);
      const absentReader = absent.body!.getReader();
      let absentText = "";
      while (!absentText.includes("reset")) absentText += decoder.decode((await absentReader.read()).value);
      await absentReader.cancel();
      expect(absentText).toContain('"log":null');

      expect((await server.fetch(`/api/loops/nope/output`)).status).toBe(404);
      expect((await server.fetch(`/api/loops/ralph/output`, { method: "POST", body: "ls\n" })).status).toBe(405);
    } finally {
      server.stop();
    }
  }, 40_000);

  it("mounts the lineup editor against the configured lineup root", async () => {
    const lineupRoot = rootWith();
    const server = scriptedServer("http-lineup", { env: { RALPH_LINEUP_ROOTS: lineupRoot } });
    const ralph = server.worktree("wt-ralph");
    server.answer("loopState", loopStateWith([loopReport(ralph, { loop: "ralph" })]));
    try {
      const read = await server.fetch(`/api/lineup?loop=rafa`);
      expect(read.status).toBe(200);
      const body = (await read.json()) as { root: string; loop: string; config: JsonObject; resolved: { stages: Record<string, { source: string }> } };
      expect(body.root).toBe(lineupRoot);
      expect(body.resolved.stages.executor).toMatchObject({ source: "default" });

      // A save goes through the editor's validated path and lands in the file.
      const candidate = { ...body.config, rafa: { ...block(), executor: { runner: "claude", model: "claude-opus-5" } } };
      const saved = await server.fetch(`/api/lineup/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loop: "rafa", config: candidate }),
      });
      expect(saved.status).toBe(200);
      const written = JSON.parse(readFileSync(join(lineupRoot, "models.json"), "utf8")) as JsonObject;
      // Under this project's key: the page edits its own project's lineup only.
      const { projects } = (await (await server.fetch(`/api/projects`)).json()) as { projects: { id: string }[] };
      const id = projects[0]!.id;
      expect(written).not.toHaveProperty("rafa");
      expect(written[id]).toMatchObject({ rafa: { executor: { model: "claude-opus-5" } } });

      // An invalid candidate is refused with the resolver's problems and the file is untouched.
      const bad = { ...candidate, rafa: { ...block(), executor: { runner: "codex", model: "provider/invalid" } } };
      const refused = await server.fetch(`/api/lineup/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loop: "rafa", config: bad }),
      });
      expect(refused.status).toBe(400);
      expect(JSON.parse(readFileSync(join(lineupRoot, "models.json"), "utf8"))).toEqual(written);
    } finally {
      server.stop();
      cleanupLineupFixtures();
    }
  });

  it("keeps answering when a loop's record is unreadable", async () => {
    const server = scriptedServer("http-degrade");
    const ralph = server.worktree("wt-ralph");
    // A truncated record is the shape a killed supervisor leaves behind:
    // loop-state reports it unreadable, and the checkout is named by its
    // loop-name file alone. It must degrade that one loop, not blank the response.
    const broken = server.worktree("wt-rafa", "rafa");
    server.answer(
      "loopState",
      loopStateWith([
        loopReport(ralph, { loop: "ralph" }),
        { ...loopReport(broken, { state: null }), stateProblem: "unreadable", loopStatus: "unknown", supervisor: "unknown" },
      ]),
    );
    try {
      const response = await server.fetch(`/api/loops`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        loops: { loop: string; loopStatus: string; stateProblem: string | null }[];
      };
      expect(body.loops).toHaveLength(4);
      expect(body.loops.find((loop) => loop.loop === "rafa")).toMatchObject({
        loopStatus: "unknown",
      });
    } finally {
      server.stop();
    }
  });

  it("serves each loop's actors, issue, branch and iteration, and survives a broken observe", async () => {
    const server = scriptedServer("http-detail");
    const ralph = server.worktree("wt-ralph");
    const rafa = server.worktree("wt-rafa");
    server.answer("loopState", loopStateWith([loopReport(ralph, { loop: "ralph" }), loopReport(rafa, { loop: "rafa" })]));
    // ralph's presence carries the executor its timeline started; observe is
    // broken for rafa's worktree only.
    server.answer(
      observeIn(ralph),
      ok(
        presence({
          loop: "ralph",
          status: "running",
          branch: "ralph/919-scaffold",
          actors: [
            {
              stage: "executor",
              state: "running",
              invocation: "e1",
              runner: "claude",
              model: "opus",
              startedAt: "2026-09-13T11:06:00.000Z",
              endedAt: null,
              lastAction: null,
              activityAt: "2026-09-13T11:06:00.000Z",
            },
          ],
        }),
      ),
    );
    server.answer(observeIn(rafa), fail(7, "unreadable"));
    try {
      const response = await server.fetch(`/api/loops`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        loops: {
          loop: string;
          issue: number | null;
          issueTitle: string | null;
          branch: string | null;
          iteration: { index: number; max: number | null } | null;
          actors: { stage: string; state: string; runner: string | null; model: string | null }[];
          presenceProblem: string | null;
        }[];
      };
      expect(body.loops.find((loop) => loop.loop === "ralph")).toMatchObject({
        issue: 919,
        issueTitle: "scaffold",
        branch: "ralph/919-scaffold",
        iteration: { index: 3, max: 50 },
        presenceProblem: null,
        actors: [expect.objectContaining({ stage: "executor", runner: "claude", model: "opus" })],
      });
      expect(body.loops.find((loop) => loop.loop === "rafa")).toMatchObject({
        presenceProblem: "unavailable",
        actors: [],
        branch: "ralph/919-scaffold",
        iteration: { index: 3, max: 50 },
      });
    } finally {
      server.stop();
    }
  });

  it("serves a loop's control view, and degrades an unreadable control record", async () => {
    const server = scriptedServer("http-control");
    const ralph = server.worktree("wt-ralph");
    const rafa = server.worktree("wt-rafa");
    server.answer("loopState", loopStateWith([loopReport(ralph, { loop: "ralph" }), loopReport(rafa, { loop: "rafa" })]));
    const givenUp =
      "abandon was waiting from 2026-09-15T09:00:00.000Z and has been given up after 5 attempts — locked. The lease store's lock may have been left behind by a process that died: check next-tasks-claim.lock in the Git common directory, then issue the command again.";
    // ralph's control record, as `controls status --json` prints it.
    server.answer(
      controlStatusIn(ralph),
      ok({
        version: 1,
        ralphRun: "run-ralph",
        loop: "ralph",
        ownerChangedAt: null,
        applied: [
          { key: "p-1", command: "pause", at: "2026-09-15T10:00:00.000Z", outcome: "applied", why: "paused — triage" },
          { key: "ab-1", command: "abandon", at: "2026-09-15T10:05:00.000Z", outcome: "refused", why: givenUp },
        ],
        hold: { kind: "approval", why: "decision gate g1: ship it?", since: "2026-09-15T10:10:00.000Z", key: null, gate: "g1" },
        stop: null,
        retries: [],
        abandoned: [],
        released: [],
        deferrals: [{ key: "rt-1", command: "retry", since: "2026-09-15T10:20:00.000Z", attempts: 2 }],
        lastPolledAt: null,
      }),
    );
    // The control CLI fails for rafa's checkout only, as an unreachable channel would.
    server.answer(controlStatusIn(rafa), fail(1, "controls: boom"));
    try {
      const response = await server.fetch(`/api/loops/ralph/control`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(
        [
          "blocked",
          "channel",
          "commands",
          "deferrals",
          "gates",
          "generatedAt",
          "givenUp",
          "hold",
          "loop",
          "loopStatus",
          "pendingApprovals",
          "present",
          "run",
          "status",
          "stop",
          "worktree",
        ].sort(),
      );
      expect(body).toMatchObject({
        loop: "ralph",
        present: true,
        run: "run-ralph",
        status: "held",
        hold: { kind: "approval", gate: "g1", why: "decision gate g1: ship it?" },
        pendingApprovals: [{ gate: "g1", question: "ship it?", since: "2026-09-15T10:10:00.000Z" }],
        stop: null,
        blocked: null,
        channel: { state: "ok", why: null, retryAt: null },
        deferrals: [{ key: "rt-1", command: "retry", attempts: 2 }],
        givenUp: [{ key: "ab-1", command: "abandon", attempts: 5, remedy: givenUp }],
        commands: [
          { key: "ab-1", outcome: "refused", at: "2026-09-15T10:05:00.000Z" },
          { key: "p-1", outcome: "applied", at: "2026-09-15T10:00:00.000Z" },
        ],
      });

      // An unreadable control record degrades that loop; it does not fail.
      const degraded = await server.fetch(`/api/loops/rafa/control`);
      expect(degraded.status).toBe(200);
      expect((await degraded.json()) as Record<string, unknown>).toMatchObject({
        loop: "rafa",
        status: "degraded",
        channel: { state: "unreachable" },
        hold: null,
        stop: null,
      });

      // A roster loop with no checkout is unknown; a name off the roster is 404.
      const remo = await server.fetch(`/api/loops/remo/control`);
      expect(remo.status).toBe(200);
      expect((await remo.json()) as Record<string, unknown>).toMatchObject({ present: false, status: "unknown" });
      expect((await server.fetch(`/api/loops/nope/control`)).status).toBe(404);
      expect((await server.fetch(`/api/loops/ralph/control`, { method: "POST" })).status).toBe(405);

      // The batched read gives every roster loop the view the per-loop route
      // gives it; only the read time may differ between the two requests.
      const all = await server.fetch(`/api/controls`);
      expect(all.status).toBe(200);
      const { loops } = (await all.json()) as { loops: Record<string, Record<string, unknown>> };
      expect(Object.keys(loops)).toEqual(expect.arrayContaining(["ralph", "rafa", "remo"]));
      const one = (await (await server.fetch(`/api/loops/ralph/control`)).json()) as Record<string, unknown>;
      expect({ ...loops.ralph, generatedAt: null }).toEqual({ ...one, generatedAt: null });
    } finally {
      server.stop();
    }
  });

  it("carries token usage and journal fields in the JSON API, unknown when absent", async () => {
    const server = scriptedServer("http-usage");
    const ralph = server.worktree("wt-ralph");
    const rafa = server.worktree("wt-rafa");
    // ralph's record names its session; rafa's names none.
    server.answer(
      "loopState",
      loopStateWith([loopReport(ralph, { loop: "ralph", run: "run-ralph", session: "sess-1" }), loopReport(rafa, { loop: "rafa" })]),
    );
    // `usage.py` for ralph's session: one assistant turn of 100 in, 50 out.
    const tokens = { input: 100, output: 50, cache_5m: 0, cache_1h: 0, cache_read: 0, input_total: 100 };
    server.answer("usage", (i) =>
      ok({
        session: i.env.RALPH_SESSION_ID ?? "",
        run_id: i.env.RALPH_RUN_ID ?? "",
        iteration: { turns: 1, elapsed_seconds: null, usage: tokens, models: { "claude-opus-5": tokens } },
        run: { steps: 1, usage: tokens },
        context: { model: "claude-opus-5", tokens: 100, window: null, percent: 0 },
      }),
    );
    try {
      const response = await server.fetch(`/api/loops`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        loops: Record<string, unknown>[];
      };
      for (const loop of body.loops) {
        expect(loop).toHaveProperty("usage");
        expect(loop).toHaveProperty("journal");
      }
      const byName = Object.fromEntries(body.loops.map((loop) => [loop.loop as string, loop]));
      expect(byName.ralph?.usage).toMatchObject({
        runId: "run-ralph",
        iteration: { usage: { output: 50 } },
        // No ledger in this worktree: the run total is unknown, not zero.
        run: null,
      });
      // No recorded session, and no worktree at all: unknown, never zero.
      expect(byName.rafa?.usage).toBeNull();
      expect(byName.remo?.usage).toBeNull();
      // Only ralph's session was asked about.
      expect(server.rec.calls.filter((call) => isSurface("usage")(call.invocation)).map((call) => call.invocation.cwd)).toEqual([ralph]);
      // The project's journal dir has no entries on the harness's origin/main:
      // empty, never invented entries.
      expect(byName.ralph?.journal).toEqual([]);

      const single = (await (await server.fetch(`/api/loops/ralph`)).json()) as Record<string, unknown>;
      expect(single).toHaveProperty("usage");
      expect(single).toHaveProperty("journal");
    } finally {
      server.stop();
    }
  });

  it("carries timeline and runner-failure fields in the JSON API, and a missing timeline does not fail it", async () => {
    const server = scriptedServer("http-timeline");
    const ralph = server.worktree("wt-ralph");
    // rafa has a record but no timeline and no failure ledger at all: the
    // world's defaults are those CLIs' answers for that.
    const rafa = server.worktree("wt-rafa");
    server.answer(
      "loopState",
      loopStateWith([loopReport(ralph, { loop: "ralph", run: "run-ralph" }), loopReport(rafa, { loop: "rafa" })]),
    );
    const at = (minute: string) => `2026-09-13T11:${minute}:00.000Z`;
    server.answer("timeline", (i) =>
      ok(
        i.env.RALPH_TIMELINE_ROOT === ralph
          ? {
              version: 1,
              exists: true,
              path: join(ralph, ".ralph", "logs", "iter-run-ralph-3.events.jsonl"),
              activities: [
                { stage: "executor", label: "stage failed · claude", at: at("09"), iteration: 3, run: "run-ralph" },
                { stage: "executor", label: "stage started · claude", at: at("06"), iteration: 3, run: "run-ralph" },
              ],
            }
          : { version: 1, exists: false, path: null, activities: [] },
      ),
    );
    const failure = {
      version: 1,
      at: at("09"),
      host: "test",
      loop: "ralph",
      run: "run-ralph",
      attempt: { iteration: 3, session: null },
      stage: "executor",
      runner: "claude",
      model: "opus",
      owner: null,
      issue: 919,
      exitCode: 1,
      kind: "api-error",
      summary: "the provider answered with an error",
      visibility: "post-hoc",
      signals: [{ kind: "api-error", evidence: "overloaded_error: try again later", visibility: "post-hoc" }],
      log: null,
      signalsFile: null,
      note: null,
    };
    server.answer("runnerFailure", (i) =>
      okText(`${JSON.stringify({ inFlight: [], settled: i.env.RALPH_PROJECT === ralph ? [failure] : [] })}\n`),
    );
    try {
      const response = await server.fetch(`/api/loops`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { loops: Record<string, unknown>[] };
      for (const loop of body.loops) {
        expect(loop).toHaveProperty("timeline");
        expect(loop).toHaveProperty("runnerFailure");
      }
      const byName = Object.fromEntries(body.loops.map((loop) => [loop.loop as string, loop]));
      expect(byName.ralph?.timeline).toEqual([
        { stage: "executor", label: "stage failed · claude", at: at("09"), iteration: 3, run: "run-ralph" },
        { stage: "executor", label: "stage started · claude", at: at("06"), iteration: 3, run: "run-ralph" },
      ]);
      expect(byName.ralph?.runnerFailure).toMatchObject({
        state: "failed",
        reason: { kind: "api-error", stage: "executor", run: "run-ralph", evidence: ["overloaded_error: try again later"] },
      });
      // No timeline is unknown, not an empty success; no failure ledger is none.
      expect(byName.rafa?.timeline).toBeNull();
      expect(byName.rafa?.runnerFailure).toEqual({ state: "none", reason: null, current: false });
      expect(byName.remo).toMatchObject({ timeline: null, runnerFailure: { state: "unknown", reason: null } });

      const single = (await (await server.fetch(`/api/loops/ralph`)).json()) as Record<string, unknown>;
      expect(single).toHaveProperty("timeline");
      expect(single).toHaveProperty("runnerFailure");
    } finally {
      server.stop();
    }
  });

  it("fails loudly with 500 when the runtime emits a drifted shape", async () => {
    // Drift is a bug in the pairing, not a broken checkout: it must surface,
    // unlike the unreadable-record case above, which degrades to 200.
    const server = scriptedServer("http-drift");
    const ralph = server.worktree("wt-ralph");
    server.answer("loopState", loopStateWith([loopReport(ralph, { loop: "ralph" })]));
    server.answer("observe", ok({ loop: 5 }));
    try {
      const response = await server.fetch(`/api/loops`);
      expect(response.status).toBe(500);
      expect((await response.json()) as { error: string }).toMatchObject({
        error: "RalphContractError",
      });
    } finally {
      server.stop();
    }
  });
});

describe("a loop's retry over HTTP", () => {
  it("shows the retry its feed records on the reconciler's schedule, and none when the feed is unreadable or the record is before the bound", async () => {
    const server = scriptedServer("http-retry", { env: { RALPH_DASHBOARD_RETRY_SCHEDULE: "5,10,20" } });
    const ralph = server.worktree("wt-ralph");
    const rafa = server.worktree("wt-rafa");
    const remo = server.worktree("wt-remo");
    // The retry counts only records raised after the last finished
    // iteration, so the record has to name that bound.
    const bound = (report: Record<string, unknown>, lastIterationEndAt: string): Record<string, unknown> => ({
      ...report,
      state: { ...(report.state as Record<string, unknown>), lastIterationEndAt },
    });
    server.answer(
      "loopState",
      loopStateWith([
        bound(loopReport(ralph, { loop: "ralph" }), "2026-10-22T10:00:00.000Z"),
        loopReport(rafa, { loop: "rafa" }),
        // remo finished an iteration after its only retry: a spent stretch, not a live one.
        bound(loopReport(remo, { loop: "remo" }), "2026-10-22T12:00:00.000Z"),
      ]),
    );
    // The feed is read straight off each worktree's disk, not through the
    // executor, so it stays a file.
    const at = "2026-10-22T11:00:00.000Z";
    const retried = `${JSON.stringify({ event: "raised", id: "retry-2", at, kind: "loop-retried", retry: { attempt: 2, of: 3, cause: "no-sigil" } })}\n`;
    writeFileSync(join(ralph, ".ralph", "logs", "notifications.jsonl"), retried);
    writeFileSync(join(remo, ".ralph", "logs", "notifications.jsonl"), retried);
    // A directory where the feed should be: it opens but cannot be read.
    mkdirSync(join(rafa, ".ralph", "logs", "notifications.jsonl"));
    try {
      const response = await server.fetch(`/api/loops`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { loops: { loop: string; retry?: unknown }[] };
      const byLoop = new Map(body.loops.map((entry) => [entry.loop, entry]));
      expect(byLoop.get("ralph")?.retry).toEqual({
        attempt: 2,
        of: 3,
        cause: "no-sigil",
        nextAt: "2026-10-22T11:20:00.000Z",
        spent: false,
      });
      expect(byLoop.get("rafa")).toBeDefined();
      expect("retry" in byLoop.get("rafa")!).toBe(false);
      expect(byLoop.get("remo")).toBeDefined();
      expect("retry" in byLoop.get("remo")!).toBe(false);
    } finally {
      server.stop();
    }
  });
});

describe("claims and ownership over HTTP", () => {
  it("carries each loop's claims and the ownership map in the JSON API", async () => {
    const server = scriptedServer("http-claims");
    const ralph = server.worktree("wt-ralph");
    // A record with no live supervisor: the claim is the lease's and the
    // label's alone, and no loop is working its branch's issue.
    server.answer(
      "loopState",
      loopStateWith([{ ...loopReport(ralph, { loop: "ralph" }), loopStatus: "stale", supervisor: "dead" }]),
    );
    // Lease status is the dashboard's own call against its clock, so the
    // expiries straddle the real now.
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    const past = new Date(Date.now() - 10 * 60_000).toISOString();
    server.answer("claims", (i) =>
      ok({
        version: 1,
        path: join(i.env.RALPH_STATE_ROOT ?? "", "claim-leases.json"),
        leases: [
          leaseRecord({ issue: 919, loop: "ralph", expiresAt: future }),
          leaseRecord({ issue: 12, loop: "rafa", run: "run-rafa", expiresAt: past }),
        ],
      }),
    );
    server.answer(
      "github",
      ok([
        { number: 919, title: "Scaffold", labels: [{ name: "ralph-wip" }] },
        { number: 12, title: "Lapsed", labels: [{ name: "rafa-wip" }] },
        { number: 50, title: "Unleased", labels: [{ name: "remo-wip" }] },
      ]),
    );
    try {
      const body = (await (await server.fetch(`/api/loops`)).json()) as {
        loops: { loop: string; claims: { issue: number; status: string; expiresAt: string | null }[] }[];
        ownership: {
          issues: { issue: number; owner: string | null; status: string; working: string[] }[];
          contested: number[];
        };
      };
      const claimsOf = (loop: string) => body.loops.find((entry) => entry.loop === loop)?.claims;
      expect(claimsOf("ralph")).toEqual([expect.objectContaining({ issue: 919, status: "active", expiresAt: future })]);
      expect(claimsOf("rafa")).toEqual([expect.objectContaining({ issue: 12, status: "expired", expiresAt: past })]);
      expect(claimsOf("remo")).toEqual([expect.objectContaining({ issue: 50, status: "unknown", expiresAt: null })]);
      expect(body.ownership.issues).toEqual([
        expect.objectContaining({ issue: 12, owner: null, status: "expired" }),
        expect.objectContaining({ issue: 50, owner: "remo", status: "unknown" }),
        expect.objectContaining({ issue: 919, owner: "ralph", status: "active" }),
      ]);
      expect(body.ownership.contested).toEqual([]);
      expect(body.ownership.issues.map((entry) => entry.working)).toEqual([[], [], []]);

      const ownership = await server.fetch(`/api/ownership`);
      expect(ownership.status).toBe(200);
      expect(await ownership.json()).toEqual(body.ownership);
    } finally {
      server.stop();
    }
  });

  it("still answers, with claims unknown, when gh cannot be read", async () => {
    const server = scriptedServer("http-claims-gh-down");
    const ralph = server.worktree("wt-ralph");
    server.answer("loopState", loopStateWith([loopReport(ralph, { loop: "ralph" })]));
    // An unauthenticated gh: non-zero, nothing on stdout.
    server.answer("github", fail(1, "gh: not logged in"));
    try {
      const response = await server.fetch(`/api/loops`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ownership: { sources: { github: string; leases: string } } };
      expect(body.ownership.sources).toEqual({ leases: "ok", github: "unavailable" });
    } finally {
      server.stop();
    }
  });
});

/**
 * The write endpoint, over the real control adapter. A command is delivered
 * as a file in the loop's inbox, written straight to disk, and the identity
 * it is fenced by is the loop's record on disk; the `controls.ts status`
 * read-back is the recorder's. No write reaches for Orca through the
 * executor: the recorder's calls show none. A spawn around the executor is
 * `read-only.test.ts`'s to forbid, statically.
 */
describe("the control endpoint over HTTP", () => {
  const controlFixture = (label: string) => {
    const server = scriptedServer(label);
    const ralph = server.worktree("wt-ralph");
    // The dispatcher reads the run it fences against off the record on disk.
    writeLoopState(ralph, { loop: "ralph", run: "run-1" });
    server.answer("loopState", loopStateWith([loopReport(ralph, { loop: "ralph", run: "run-1" })]));
    /** Every command the server ran that names Orca: none is the property. */
    const orcaCalls = (): Invocation[] =>
      server.rec.calls.map((call) => call.invocation).filter((i) => /(^|\/)orca$/.test(i.command));
    /** The command files the dashboard has written into the loop's inbox. */
    const calls = (): Record<string, unknown>[] => {
      const inbox = join(ralph, ".ralph", "control", "inbox");
      return existsSync(inbox)
        ? readdirSync(inbox)
            .filter((name) => !name.startsWith("."))
            .map((name) => JSON.parse(readFileSync(join(inbox, name), "utf8")) as Record<string, unknown>)
        : [];
    };
    return { server, ralph, calls, orcaCalls };
  };

  const post = (server: InProcessServer, body: unknown) =>
    server.fetch(`/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("validates, delegates each action to dispatch, and serializes its result", async () => {
    const { server, ralph, calls, orcaCalls } = controlFixture("http-control-write");
    try {
      const paused = await post(server, { loop: "ralph", action: "pause", run: "run-1", why: "triage" });
      expect(paused.status).toBe(200);
      expect(await paused.json()).toMatchObject({
        loop: "ralph",
        action: "pause",
        run: "run-1",
        outcome: "applied",
        recorded: false,
      });
      expect(calls()).toHaveLength(1);
      expect(calls()[0]).toMatchObject({ command: "pause", loop: "ralph", run: "run-1", why: "triage" });

      // stop without the confirmation field is a client error and sends nothing.
      const unconfirmed = await post(server, { loop: "ralph", action: "stop" });
      expect(unconfirmed.status).toBe(400);
      expect(await unconfirmed.json()).toMatchObject({ error: "ConfirmationRequired" });
      expect(calls()).toHaveLength(1);

      const stopped = await post(server, { loop: "ralph", action: "stop", stopKind: "completed", confirm: true });
      expect(stopped.status).toBe(200);
      expect(await stopped.json()).toMatchObject({
        action: "stop",
        stop: { kind: "completed", confirmation: "pending" },
      });
      expect(calls()).toHaveLength(2);

      expect((await post(server, { loop: "nope", action: "pause" })).status).toBe(404);
      expect((await post(server, { loop: "ralph", action: "restart-to-apply" })).status).toBe(400);
      expect((await post(server, { action: "pause" })).status).toBe(400);
      expect((await server.fetch(`/api/control`)).status).toBe(405);
      expect(calls()).toHaveLength(2);
      expect(orcaCalls()).toEqual([]);

      // The loop records the command; the control view reads that record
      // back, as `controls status --json` prints it.
      server.answer(
        controlStatusIn(ralph),
        ok({
          version: 1,
          ralphRun: "run-1",
          loop: "ralph",
          ownerChangedAt: null,
          hold: { kind: "pause", why: "triage", since: "2026-09-15T01:00:00.000Z", key: "k" },
          stop: null,
          applied: [{ key: "k", command: "pause", outcome: "applied", at: "2026-09-15T01:00:00.000Z", why: "paused" }],
          deferrals: [],
          retries: [],
          abandoned: [],
          released: [],
          lastPolledAt: null,
        }),
      );
      const view = await server.fetch(`/api/loops/ralph/control`);
      expect(view.status).toBe(200);
      expect(await view.json()).toMatchObject({
        loop: "ralph",
        run: "run-1",
        hold: { kind: "pause" },
        commands: [{ key: "k", outcome: "applied", at: "2026-09-15T01:00:00.000Z" }],
      });

      // A replay of the recorded command is answered from the fence.
      const replay = await post(server, { loop: "ralph", action: "pause", id: "k" });
      expect(await replay.json()).toMatchObject({ outcome: "replayed", recorded: true });
      expect(calls()).toHaveLength(2);
      expect(orcaCalls()).toEqual([]);
    } finally {
      server.stop();
    }
  });
});

describe("projects over HTTP", () => {
  interface LoopsBody {
    loops: { loop: string; present: boolean }[];
  }
  const presentLoops = async (server: InProcessServer, path: string): Promise<string[]> =>
    ((await (await server.fetch(path)).json()) as LoopsBody).loops
      .filter((loop) => loop.present)
      .map((loop) => loop.loop);

  /** `loop-state status --json` asked about one project's root: each project reads its own. */
  const loopStateIn = (root: string) => (i: Invocation): boolean =>
    isSurface("loopState")(i) && i.env.RALPH_STATE_ROOT === root;

  it("scopes every route to the registered project in its URL", async () => {
    const server = scriptedServer("http-projects", { projects: ["alpha", "beta"] });
    const alpha = server.project("alpha");
    const beta = server.project("beta");
    const alphaRalph = server.worktree("alpha/ralph-loop");
    const betaRafa = server.worktree("beta/rafa-loop");
    server.answer(loopStateIn(alpha), loopStateWith([loopReport(alphaRalph, { loop: "ralph" })]));
    server.answer(loopStateIn(beta), loopStateWith([loopReport(betaRafa, { loop: "rafa" })]));
    try {
      expect(await presentLoops(server, "/api/p/alpha/loops")).toEqual(["ralph"]);
      expect(await presentLoops(server, "/api/p/beta/loops")).toEqual(["rafa"]);
      expect((await server.fetch(`/api/p/beta/loops/rafa`)).status).toBe(200);

      // Unscoped API paths answer as the first project; unscoped pages redirect into it.
      expect(await presentLoops(server, "/api/loops")).toEqual(["ralph"]);
      const legacy = await server.fetch(`/loops/rafa`, { redirect: "manual" });
      expect(legacy.status).toBe(302);
      expect(legacy.headers.get("location")).toBe("/p/alpha/loops/rafa");
      const usage = await server.fetch(`/usage`, { redirect: "manual" });
      expect(usage.headers.get("location")).toBe("/p/alpha/usage");
      // The All projects floor belongs to no project: it is the shell where it is.
      const floor = await server.fetch(`/factory`, { redirect: "manual" });
      expect(floor.status).toBe(200);

      // Scoped pages are the shell; an unknown project is a 404 on both surfaces.
      expect((await server.fetch(`/p/beta/loops/rafa`)).status).toBe(200);
      expect((await server.fetch(`/`)).status).toBe(200);
      expect((await server.fetch(`/p/nope/`)).status).toBe(404);
      expect((await server.fetch(`/api/p/nope/loops`)).status).toBe(404);
    } finally {
      server.stop();
    }
  });

  describe("one runtime read per page load (#66)", () => {
    // A window no loaded host can outlast between two in-process requests, so
    // the counts below never depend on how fast the host is; the default's
    // bound is pinned against the page's poll interval instead.
    const WIDE_MS = 600_000;
    const onePage = (label: string, runtimeReuseMs: number) => {
      const server = scriptedServer(label, { projects: ["alpha"], runtimeReuseMs });
      const alpha = server.project("alpha");
      server.answer(loopStateIn(alpha), loopStateWith([loopReport(server.worktree("alpha/ralph-loop"), { loop: "ralph" })]));
      const reads = (): number => server.rec.calls.filter((call) => loopStateIn(alpha)(call.invocation)).length;
      return { server, reads };
    };

    it("answers /controls from the read /loops just made, scoped and unscoped", async () => {
      const { server, reads } = onePage("http-reuse-pair", WIDE_MS);
      try {
        expect((await server.fetch(`/api/p/alpha/loops`)).status).toBe(200);
        expect((await server.fetch(`/api/p/alpha/controls`)).status).toBe(200);
        expect(reads()).toBe(1);
        expect((await server.fetch(`/api/loops`)).status).toBe(200);
        expect((await server.fetch(`/api/controls`)).status).toBe(200);
        expect(reads()).toBe(1);
      } finally {
        server.stop();
      }
    });

    it("shares one read between concurrent requests", async () => {
      const { server, reads } = onePage("http-reuse-concurrent", WIDE_MS);
      try {
        const answers = await Promise.all([server.fetch(`/api/p/alpha/controls`), server.fetch(`/api/p/alpha/controls`)]);
        expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
        expect(reads()).toBe(1);
      } finally {
        server.stop();
      }
    });

    it("reads afresh on every request when reuse is off", async () => {
      const { server, reads } = onePage("http-reuse-off", 0);
      try {
        expect((await server.fetch(`/api/p/alpha/loops`)).status).toBe(200);
        expect((await server.fetch(`/api/p/alpha/controls`)).status).toBe(200);
        expect(reads()).toBe(2);
      } finally {
        server.stop();
      }
    });

    it("reads afresh after a write reaches the project", async () => {
      const { server, reads } = onePage("http-reuse-write", WIDE_MS);
      try {
        expect((await server.fetch(`/api/p/alpha/loops`)).status).toBe(200);
        expect(reads()).toBe(1);
        // Refused for its missing loop, but a POST the project's handler answers.
        const write = await server.fetch(`/api/p/alpha/control`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "pause" }),
        });
        expect(write.status).toBe(400);
        const afterWrite = reads();
        expect((await server.fetch(`/api/p/alpha/controls`)).status).toBe(200);
        expect(reads()).toBe(afterWrite + 1);
      } finally {
        server.stop();
      }
    });

    it("keeps a reused snapshot younger than the page's poll interval", () => {
      expect(RUNTIME_REUSE_MS).toBeGreaterThan(0);
      expect(RUNTIME_REUSE_MS).toBeLessThan(POLL_MS);
    });
  });

  /** A loop as loop-state reports one that stopped on an error. */
  const failedReport = (worktree: string, loop: string): Record<string, unknown> => {
    const report = loopReport(worktree, { loop });
    return {
      ...report,
      loopStatus: "failed",
      supervisor: "dead",
      state: {
        ...(report.state as Record<string, unknown>),
        stage: "stopped",
        stopReason: { kind: "failed", why: "gate failed", at: "2026-09-23T10:00:00.000Z" },
      },
    };
  };

  /**
   * Two registered projects on one scripted machine: alpha, with one ralph
   * checkout whose record has no live supervisor (stale), and beta, whose
   * ralph waits on an approval and whose rafa stopped on an error.
   */
  const twoProjects = (label: string) => {
    const server = scriptedServer(label, { projects: ["alpha", "beta"] });
    const alpha = server.project("alpha");
    const beta = server.project("beta");
    const alphaRalph = server.worktree("alpha/ralph-loop");
    const betaRalph = server.worktree("beta/ralph-loop");
    const betaRafa = server.worktree("beta/rafa-loop");
    server.answer(
      loopStateIn(alpha),
      loopStateWith([{ ...loopReport(alphaRalph, { loop: "ralph" }), loopStatus: "stale", supervisor: "dead" }]),
    );
    server.answer(loopStateIn(beta), loopStateWith([loopReport(betaRalph, { loop: "ralph" }), failedReport(betaRafa, "rafa")]));
    server.answer(
      controlStatusIn(betaRalph),
      ok({
        version: 1,
        ralphRun: "run-ralph",
        loop: "ralph",
        ownerChangedAt: null,
        applied: [],
        hold: { kind: "approval", why: "decision gate g1: ship it?", since: "2026-09-23T10:10:00.000Z", key: null, gate: "g1" },
        stop: null,
        retries: [],
        abandoned: [],
        released: [],
        deferrals: [],
        lastPolledAt: null,
      }),
    );
    /** The recorded invocations of one surface, with the directory each ran in. */
    const callsTo = (surface: SurfaceName) => server.rec.calls.map((call) => call.invocation).filter(isSurface(surface));
    return { server, alpha, beta, callsTo };
  };

  interface HealthBody {
    selected: string | null;
    projects: { project: string; health: string; needsYou: number; needs: unknown[]; readAt: string }[];
  }

  it("reads every other project's health locally, with no gh call, and only the selected project in full", async () => {
    const { server, alpha, beta, callsTo } = twoProjects("http-health");
    try {
      const first = await server.fetch(`/api/projects/health?selected=alpha`);
      expect(first.status).toBe(200);
      const body = (await first.json()) as HealthBody;
      expect(body.selected).toBe("alpha");
      expect(body.projects).toEqual([
        expect.objectContaining({
          project: "beta",
          health: "needs-you",
          needsYou: 2,
          needs: [
            { loop: "ralph", reason: "approval" },
            { loop: "rafa", reason: "errored" },
          ],
          loops: 2,
          problem: null,
        }),
      ]);
      // Within the TTL the same read is served, however often it is asked.
      const again = (await (await server.fetch(`/api/projects/health?selected=alpha`)).json()) as HealthBody;
      expect(again.projects[0]!.readAt).toBe(body.projects[0]!.readAt);
      // Unselected, every project is read. Alpha's ralph left a record but no
      // live supervisor: stale, which is degraded, not something that needs you.
      const all = (await (await server.fetch(`/api/projects/health`)).json()) as HealthBody;
      expect(all.projects.map((project) => [project.project, project.health])).toEqual([
        ["alpha", "degraded"],
        ["beta", "needs-you"],
      ]);
      // Not one of those reads reached GitHub or a tracker: no `gh` of any
      // kind (issues, PR chips, onboarding's), no frontier, no tracker list.
      const remote = (): Invocation[] =>
        server.rec.calls
          .map((call) => call.invocation)
          .filter((i) => i.command === "gh" || isSurface("frontier")(i) || isSurface("trackerIssues")(i));
      expect(remote()).toEqual([]);

      // The selected project's full snapshot runs gh, in its own checkout only.
      expect((await server.fetch(`/api/p/alpha/loops`)).status).toBe(200);
      expect(callsTo("github").length).toBeGreaterThan(0);
      const calls = remote();
      expect(calls.every((call) => call.cwd === alpha)).toBe(true);
      expect(calls.some((call) => call.cwd === beta)).toBe(false);

      expect((await server.fetch(`/api/projects/health`, { method: "POST" })).status).toBe(405);
    } finally {
      server.stop();
    }
  });

  it("keys the frontier cache and gh reads per project", async () => {
    const { server, alpha, beta, callsTo } = twoProjects("http-frontier-keys");
    // The census is the frontier CLI's run in a project's checkout: the gh
    // reads it makes are its own, behind one invocation.
    const censusIn = (dir: string) => callsTo("frontier").filter((call) => call.cwd === dir);
    try {
      expect((await server.fetch(`/api/p/alpha/frontier`)).status).toBe(200);
      const alphaCensus = censusIn(alpha).length;
      expect(alphaCensus).toBeGreaterThan(0);
      expect(censusIn(beta)).toEqual([]);

      // Beta's first read runs its own census; alpha's cached one does not answer for it.
      expect((await server.fetch(`/api/p/beta/frontier`)).status).toBe(200);
      expect(censusIn(beta)).toHaveLength(alphaCensus);

      // Back on alpha, its census is still warm: beta's read did not evict it.
      expect((await server.fetch(`/api/p/alpha/frontier`)).status).toBe(200);
      expect(censusIn(alpha)).toHaveLength(alphaCensus);
      expect(censusIn(beta)).toHaveLength(alphaCensus);
    } finally {
      server.stop();
    }
  });

  it("streams a project's snapshot changes and ends the stream when the project is removed", async () => {
    let reads = 0;
    const server = scriptedServer("http-stream", {
      projects: ["alpha", "beta"],
      // Short timings, and a fallback tick, so a change is seen without
      // waiting on a file watch: the scripted state changes in memory.
      snapshotStream: { debounceMs: 10, minIntervalMs: 50, fallbackMs: 200, heartbeatMs: 50, log: () => undefined },
      onAdapterRead: () => {
        reads += 1;
      },
    });
    const alpha = server.project("alpha");
    const beta = server.project("beta");
    const alphaRalph = server.worktree("alpha/ralph-loop");
    const betaRalph = server.worktree("beta/ralph-loop");
    server.answer(loopStateIn(alpha), loopStateWith([loopReport(alphaRalph, { loop: "ralph" })]));
    server.answer(loopStateIn(beta), loopStateWith([loopReport(betaRalph, { loop: "ralph" })]));
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const decoder = new TextDecoder();
    /** Reads until `done` holds; true when the stream ended first. */
    const readUntil = async (reader: ReadableStreamDefaultReader<Uint8Array>, seen: { text: string }, done: (text: string) => boolean) => {
      const deadline = Date.now() + 20_000;
      while (!done(seen.text)) {
        if (Date.now() > deadline) throw new Error(`timed out; read so far: ${JSON.stringify(seen.text)}`);
        const chunk = await reader.read();
        if (chunk.done) return true;
        seen.text += decoder.decode(chunk.value, { stream: true });
      }
      return false;
    };
    try {
      // Another site's name is refused before the stream is opened.
      const foreign = await server.fetch(`/api/p/beta/stream`, { headers: { host: "evil.example:8791" } });
      expect(foreign.status).toBe(403);
      expect(await foreign.json()).toMatchObject({ error: "UnknownHost" });

      const controller = new AbortController();
      const response = await server.fetch(`/api/p/beta/stream`, { signal: controller.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const reader = response.body!.getReader();
      const seen = { text: "" };
      await readUntil(reader, seen, (text) => text.includes("retry:"));
      expect(seen.text.startsWith("retry: 3000\n\n")).toBe(true);

      // The page's own read overlaps the hub's baseline read, so once it is
      // back the baseline has the state as scripted above.
      expect((await server.fetch(`/api/p/beta/loops`)).status).toBe(200);

      // Nothing changed, so recomputes emit nothing. Two of the hub's reads
      // begun after the page's, the third begun so the second has been hashed
      // (the hub runs one at a time), and a keep-alive after that, so any
      // event they sent is already in what was read.
      const before = reads;
      await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(before + 3), { timeout: 20_000, interval: 20 });
      const quiet = seen.text.length;
      await readUntil(reader, seen, (text) => text.slice(quiet).includes(": keep-alive\n\n"));
      expect(seen.text).not.toContain("data: ");

      // Beta's ralph stops on an error: the next recompute sees it.
      server.answer(loopStateIn(beta), loopStateWith([failedReport(betaRalph, "ralph")]));
      await readUntil(reader, seen, (text) => text.includes("data: "));
      expect(seen.text).toContain('data: {"key":"dashboard","version":1}\n\n');
      expect(seen.text).not.toContain('"version":2');
      await readUntil(reader, seen, (text) => text.includes(": keep-alive\n\n"));

      // Beta leaves the registry: the next request, to any path, ends its stream.
      server.register(["alpha"]);
      expect((await server.fetch(`/api/projects`)).status).toBe(200);
      expect(await readUntil(reader, seen, () => false)).toBe(true);
      controller.abort();
    } finally {
      stderr.mockRestore();
      server.stop();
    }
  });
});

/**
 * The page has no login — the machine's user is the operator — so request
 * authenticity is the one check the server can make. The gate reads the
 * `Host` and `Sec-Fetch-Site`/`Origin` headers off the `Request`, which an
 * in-process `Request` carries as a socket's would; the one thing only a real
 * socket can send, a request with no `Host` at all, is `server.test.ts`'s.
 */
describe("request authenticity", () => {
  it("refuses cross-site writes and unknown Host names, and lets the tailnet and non-browser clients through", async () => {
    const server = scriptedServer("http-authenticity", { env: { RALPH_DASHBOARD_HOSTS: "ralph.home.arpa" } });
    const ralph = server.worktree("wt-ralph");
    server.answer("loopState", loopStateWith([loopReport(ralph, { loop: "ralph" })]));
    // The gate's refusals go to the operator's journal as stderr lines.
    const stderr = vi.spyOn(console, "error");
    const log = (): string => stderr.mock.calls.map((call) => call.join(" ")).join("\n");
    try {
      const control = `${server.base}/api/loops/ralph/control`;
      const body = JSON.stringify({ command: "pause" });
      const headers = { "content-type": "application/json" };
      // A browser on another site, by either signal the browser itself sets.
      expect((await server.fetch(control, { method: "POST", headers: { ...headers, "sec-fetch-site": "cross-site" }, body })).status).toBe(403);
      expect((await server.fetch(control, { method: "POST", headers: { ...headers, origin: "https://evil.example" }, body })).status).toBe(403);
      const refused = await server.fetch(control, { method: "POST", headers: { ...headers, "sec-fetch-site": "cross-site" }, body });
      expect(await refused.json()).toMatchObject({ error: "CrossOrigin" });
      // The page itself, and a non-browser client (the bridge relay, `curl`):
      // whatever this route answers a POST, it is not the gate's 403. This one
      // is GET-only, so a 405 is the proof the request got past the gate and
      // reached the route's own method check — not that the gate is absent.
      expect((await server.fetch(control, { method: "POST", headers: { ...headers, "sec-fetch-site": "same-origin" }, body })).status).toBe(405);
      expect((await server.fetch(control, { method: "POST", headers, body })).status).toBe(405);

      // A route that really does accept a POST is reached too, so the gate
      // cannot be refusing every write. Which refusal `/api/control` answers
      // an empty body with is its own business; that it is not the gate's is
      // the property here.
      const write = await server.fetch(`/api/control`, {
        method: "POST",
        headers: { ...headers, "sec-fetch-site": "same-origin" },
        body: JSON.stringify({}),
      });
      expect(write.status).not.toBe(403);
      expect(await write.json()).not.toMatchObject({ error: "CrossOrigin" });

      // Reads under a rebound name are refused; loopback, the tailnet and the
      // configured name are not.
      const { port } = new URL(server.base);
      const status = async (host: string): Promise<number> =>
        (await server.fetch(`/api/projects`, { headers: { host } })).status;
      expect(await status("evil.example:8791")).toBe(403);
      expect(await status(`127.0.0.1:${port}`)).toBe(200);
      expect(await status("box.tail1234.ts.net")).toBe(200);
      expect(await status("ralph.home.arpa")).toBe(200);
      // The refused name reaches the operator, in exactly one line per refusal
      // (there is no throttling: one request above, one line here), and the
      // line says what to do about it.
      const refusals = log().match(/refused a request with Host 'evil\.example:8791'/g) ?? [];
      expect(refusals).toHaveLength(1);
      expect(log()).toContain("add it to RALPH_DASHBOARD_HOSTS if it is yours");
      expect(log()).toContain("refused a cross-site POST to /api/loops/ralph/control");
    } finally {
      stderr.mockRestore();
      server.stop();
    }
  });
});
