/**
 * A scripted world for the adapter suites: a recording executor that answers
 * every read `createRalphAdapter(...).read()` issues, and a scratch root on
 * disk for the few things the adapter reads directly.
 *
 * Test infrastructure, not shipped code, but kept out of `*.test.ts` (like
 * `fixtures.ts` and `recording-executor.ts`) so the adapter suites script the
 * runtime the same way instead of each spawning the real CLIs against a fake
 * `gh` and `git`. Nothing here spawns a process: the scratch root is made with
 * `mkdtempSync`, and every invocation is answered by a rule.
 *
 * The script is two layers on one recorder. The defaults — one rule per
 * `COMMAND_SURFACE` entry, each a neutral, contract-valid answer (no loops, no
 * leases, no issues, an empty frontier) — are appended; overrides are
 * PREPENDED, so the recorder's first-match-wins makes the newest override beat
 * older ones and every default, without a test restating the other surfaces.
 * An invocation neither layer matches still reaches `unexpected` (status 127),
 * so a read a test did not plan for shows up as a failed read in `calls`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

import { COMMAND_SURFACE, createRalphAdapter, type RalphAdapterConfig } from "./adapter";
import type { ExecResult, Invocation } from "./control-adapter";
import { scratchRoot, type RosterFixture } from "./fixtures";
import { createRecordingExecutor, matches, type Answer, type Matcher, type RecordingExecutor } from "./recording-executor";

/** The harness checkout: the real one, so the scripted argv names real scripts. Nothing under it runs. */
export const CLI_DIR = join(__dirname, "..");
/** The bun the world's adapter is told to use. A fixed fake string: nothing resolves or runs it. */
export const BUN = "bun";
/** The python the world's adapter runs `usage.py` under; as fake as {@link BUN}. */
export const PYTHON = "python3";
/** Where the journal and learnings git reads point (`-C <home>`); never a real repository. */
export const JOURNAL_HOME = "/journal-home";
/** The clock's start; any fixed instant would do, this one is the one the suites already use. */
export const EPOCH = 1_700_000_000_000;

export type SurfaceName = keyof typeof COMMAND_SURFACE;

/** A CLI that printed `value` as JSON and exited 0. */
export const ok = (value: unknown): ExecResult => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
/** A CLI that printed `stdout` verbatim (the `parse: "text"` surfaces: git, runner-failure). */
export const okText = (stdout: string): ExecResult => ({ status: 0, stdout, stderr: "" });
/** A CLI that exited `status` with `stderr`, printing nothing. */
export const fail = (status: number, stderr = ""): ExecResult => ({ status, stdout: "", stderr });

/** `bun <cliDir>/<script> …` (or `python3 …` for usage): the command, then the script's own path. */
const scriptMatcher = (command: string, script: string, args: readonly string[]) => (i: Invocation): boolean =>
  i.command === command &&
  (i.args[0] ?? "").endsWith(`${sep}${script}`) &&
  args.every((arg, index) => i.args[index + 1] === arg);

/** `<command> <argv prefix>`, after the `-C <home>` git reads carry before the subcommand. */
const commandMatcher = (command: string, args: readonly string[]) => (i: Invocation): boolean => {
  if (i.command !== command) return false;
  const offset = command === "git" && i.args[0] === "-C" ? 2 : 0;
  return args.every((arg, index) => i.args[index + offset] === arg);
};

/**
 * Whether an invocation is the read of one `COMMAND_SURFACE` entry, as the
 * world's adapter issues it (bun is {@link BUN}, python {@link PYTHON}). Built
 * from the declared argv, so a surface that changes its flags moves here too.
 */
export function isSurface(name: SurfaceName): (invocation: Invocation) => boolean {
  const surface = COMMAND_SURFACE[name];
  if ("script" in surface) return scriptMatcher(name === "usage" ? PYTHON : BUN, surface.script, surface.args);
  return commandMatcher(surface.command, surface.args);
}

/** The value of `flag` in an invocation's argv (e.g. `--run`), for per-run answers. */
export const argAfter = (invocation: Invocation, flag: string): string | undefined => {
  const index = invocation.args.indexOf(flag);
  return index === -1 ? undefined : invocation.args[index + 1];
};

/** The four loggd runs, as `writeProjectConfig` defaults them. */
export const DEFAULT_LOOPS: RosterFixture = ["ralph", "rafa", "remo", "rulo"];

/**
 * `project-config --json` for a roster, in the resolved shape the CLI prints:
 * the roster with a role on every entry, the journal dir, and the learnings
 * file `parseProjectConfig` derives from it. `extra` merges over the top
 * level, for a `tracker` or `verifier` block.
 */
export function projectConfigAnswer(loops: RosterFixture = DEFAULT_LOOPS, extra: Record<string, unknown> = {}): unknown {
  return {
    repo: "your-org/your-repo",
    owner: "your-github-login",
    baseBranch: "main",
    displayName: "Fixture",
    journal: { dir: "journal/fixture" },
    learnings: { file: "learnings/fixture.md" },
    roster: loops.map((loop) =>
      typeof loop === "string" ? { name: loop, role: "coder" } : { name: loop.name, role: loop.role ?? "coder" },
    ),
    ...extra,
  };
}

const ZERO_TOKENS = { input: 0, output: 0, cache_5m: 0, cache_1h: 0, cache_read: 0, input_total: 0 };

/** An empty frontier: the shape `narrowFrontier` accepts as no backlog at all. */
export const EMPTY_FRONTIER = {
  ready: [],
  occupied: [],
  specs: [],
  inFlight: [],
  blocked: [],
  gates: [],
  stuck: [],
  tree: [],
  stuckReasons: [],
  untriaged: [],
  triage: { staffing: 0, routing: 0, intake: 0, oversize: 0, rescue: 0 },
};

/**
 * One worktree's `observe.ts --json`: an idle loop with nothing in flight,
 * `over` merged on top (a loop name, a branch, its actors).
 */
export function presence(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    loop: "ralph",
    run: null,
    status: "idle",
    supervisor: "unknown",
    issue: null,
    branch: null,
    iteration: null,
    observedAt: new Date(EPOCH).toISOString(),
    issues: [],
    actors: [],
    recent: [],
    failureReason: null,
    step: null,
    phase: { index: 0, total: 0, label: "" },
    warning: null,
    ...over,
  };
}

/** The observe read of one worktree: the adapter names it by `RALPH_OBSERVER_ROOT`. */
export const observeIn = (worktree: string) => (i: Invocation): boolean =>
  isSurface("observe")(i) && i.env.RALPH_OBSERVER_ROOT === worktree;

/** The project-config read for one project: the adapter names it by `RALPH_PROJECT`. */
export const projectConfigIn = (root: string) => (i: Invocation): boolean =>
  isSurface("projectConfig")(i) && i.env.RALPH_PROJECT === root;

/**
 * The neutral answer for each surface. Computed ones read the invocation so
 * the answer names the root or worktree it was asked about, as the CLI would.
 * The per-loop reads (observe, usage, timeline, runner-failure, journal) only
 * run for a worktree loop-state lists, and the default `loopState` answer lists
 * none; they still get valid answers so a test that adds a loop scripts only
 * what it asserts.
 */
export function neutralAnswers(loops: RosterFixture = DEFAULT_LOOPS, config: Record<string, unknown> = {}): Record<SurfaceName, Answer> {
  return {
    loopState: (i) => ok({ self: i.env.RALPH_STATE_ROOT ?? "", loops: [], reconciliation: { orphaned: [], prunable: [] } }),
    observe: ok(presence()),
    claims: (i) => ok({ version: 1, path: join(i.env.RALPH_STATE_ROOT ?? "", "claim-leases.json"), leases: [] }),
    github: ok([]),
    trackerIssues: ok([]),
    pullsOpen: ok([]),
    pullsMerged: ok([]),
    projectConfig: ok(projectConfigAnswer(loops, config)),
    usage: (i) =>
      ok({
        session: i.env.RALPH_SESSION_ID ?? "",
        run_id: i.env.RALPH_RUN_ID ?? "",
        iteration: { turns: 0, elapsed_seconds: null, usage: ZERO_TOKENS, models: {} },
        run: { steps: 0, usage: ZERO_TOKENS },
        context: { model: null, tokens: 0, window: null, percent: 0 },
      }),
    // An empty listing is a journal with no entries: the batch read never runs.
    journalList: okText(""),
    journalRead: okText(""),
    // A file missing from the ref is git's non-zero `show`: no learning written yet.
    learningsShow: fail(128, "fatal: path does not exist in 'origin/main'"),
    learningsRemote: okText("https://github.com/your-org/your-repo.git\n"),
    timeline: ok({ version: 1, exists: false, path: null, activities: [] }),
    runnerFailure: okText(JSON.stringify({ inFlight: [], settled: [] })),
    frontier: ok(EMPTY_FRONTIER),
    following: ok({ version: 1, watches: [] }),
  };
}

/**
 * One worktree's entry in `loop-state status --json`, as the CLI reports a
 * live loop: a version-1 record owned by `loop`, on run `run`. `state: null`
 * is a checkout with no record, identified (or not) by its `.ralph/loop-name`.
 */
export function loopReport(
  worktree: string,
  over: { loop?: string; run?: string; session?: string; state?: null } = {},
): Record<string, unknown> {
  const loop = over.loop ?? "ralph";
  const heartbeat = new Date(EPOCH).toISOString();
  return {
    worktree,
    worktreeStatus: "live",
    loopStatus: over.state === null ? "idle" : "running",
    branch: "ralph/919-scaffold",
    state:
      over.state === null
        ? null
        : {
            version: 1,
            run: over.run ?? `run-${loop}`,
            owner: { loop, pid: null, host: "test" },
            worktree,
            branch: "ralph/919-scaffold",
            stage: "iteration",
            iteration: { index: 3, max: 50 },
            heartbeat,
            lastEvent: { name: "iteration-start", at: heartbeat },
            stopReason: null,
            ...(over.session === undefined ? {} : { session: over.session }),
          },
    stateProblem: over.state === null ? "missing" : null,
    supervisor: "alive",
  };
}

/** `loop-state status --json` listing `reports`, for the root the read was asked about. */
export const loopStateAnswer = (reports: readonly unknown[]) => (i: Invocation): ExecResult =>
  ok({ self: i.env.RALPH_STATE_ROOT ?? "", loops: reports, reconciliation: { orphaned: [], prunable: [] } });

/**
 * Resolves once every microtask queued so far has run. The world answers
 * without I/O, so a fan-out the adapter starts at once has fully arrived by
 * then: a test asserts what is held at that point instead of waiting on an
 * arrival a serial fan-out would never make. A turn of the event loop, not a
 * timed sleep.
 */
export const drained = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * A recording executor answering every surface with {@link neutralAnswers}.
 * Overrides passed here are already prepended, ahead of the defaults.
 */
export function scriptedExecutor(options: WorldScript = {}): RecordingExecutor {
  const defaults = neutralAnswers(options.loops, options.config);
  const rec = createRecordingExecutor();
  for (const name of Object.keys(defaults) as SurfaceName[]) rec.on(isSurface(name), defaults[name]);
  for (const [name, answer] of Object.entries(options.answers ?? {}) as [SurfaceName, Answer][]) {
    rec.rules.unshift({ match: isSurface(name), answer });
  }
  return rec;
}

export interface WorldScript {
  /** The roster `project-config --json` answers with; defaults to {@link DEFAULT_LOOPS}. */
  loops?: RosterFixture;
  /** Extra top-level config fields (a `tracker` or `verifier` block). */
  config?: Record<string, unknown>;
  /** Per-surface overrides, ahead of the defaults. */
  answers?: Partial<Record<SurfaceName, Answer>>;
}

/**
 * Holds every matching invocation until released, for a test that must see
 * reads overlap (a parallel fan-out) before any of them answers.
 */
export interface Gate {
  /** The held invocations, in arrival order. */
  arrived: Invocation[];
  /** Resolves once `count` invocations are held: a predicate wait, never a sleep. */
  until: (count: number) => Promise<void>;
  /** Lets every held and every later invocation through to the script. */
  release: () => void;
}

export interface AdapterWorld {
  /** The scratch root the adapter reads `.git`, `.ralph/` and the usage ledger from. */
  root: string;
  /** The recorder; its `calls` are every read, its `rules` the live script. */
  rec: RecordingExecutor;
  /** The adapter's clock: advance `clock.t` to cross a TTL. */
  clock: { t: number };
  /**
   * Replaces one surface's answer (or any matcher's, for a read narrower than
   * a surface, such as one worktree's observe) ahead of everything scripted so far.
   */
  answer: (surface: SurfaceName | Matcher, answer: Answer) => AdapterWorld;
  /** Holds the matching invocations until the returned gate is released. */
  gate: (surface: SurfaceName | Matcher) => Gate;
  /** The recorded invocations of one surface, in order. */
  callsTo: (surface: SurfaceName) => Invocation[];
  /**
   * A worktree directory under the root, for the reads the adapter makes off
   * disk; `loopName` writes its `.ralph/loop-name`. Returns the path.
   */
  worktree: (name: string, loopName?: string) => string;
  /**
   * An adapter over this world; `config` overrides any other field (a second
   * root, a TTL, env). Not the runtime: `isSurface` matches on {@link BUN} and
   * {@link PYTHON} and the world's exec, so another would send every read to 127.
   */
  adapter: (config?: Omit<Partial<RalphAdapterConfig>, "bunPath" | "pythonPath" | "exec">) => ReturnType<typeof createRalphAdapter>;
}

const toMatcher = (surface: SurfaceName | Matcher): Matcher =>
  typeof surface === "string" ? isSurface(surface) : surface;

/** The world for one test: a fresh root, recorder and clock. */
export function adapterWorld(label: string, script: WorldScript = {}): AdapterWorld {
  const root = scratchRoot(label);
  const rec = scriptedExecutor(script);
  const clock = { t: EPOCH };
  const gates: { match: Matcher; gate: Gate; hold: (invocation: Invocation) => Promise<void> | null }[] = [];

  const world: AdapterWorld = {
    root,
    rec,
    clock,
    answer: (surface, answer) => {
      rec.rules.unshift({ match: toMatcher(surface), answer });
      return world;
    },
    gate: (surface) => {
      let open = false;
      let release!: () => void;
      const opened = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiters: { count: number; resolve: () => void }[] = [];
      const gate: Gate = {
        arrived: [],
        until: (count) =>
          gate.arrived.length >= count ? Promise.resolve() : new Promise((resolve) => waiters.push({ count, resolve })),
        release: () => {
          open = true;
          release();
        },
      };
      const hold = (invocation: Invocation): Promise<void> | null => {
        if (open) return null;
        gate.arrived.push(invocation);
        for (const waiter of waiters.splice(0)) {
          if (gate.arrived.length >= waiter.count) waiter.resolve();
          else waiters.push(waiter);
        }
        return opened;
      };
      gates.push({ match: toMatcher(surface), gate, hold });
      return gate;
    },
    callsTo: (surface) => rec.calls.map((call) => call.invocation).filter(isSurface(surface)),
    worktree: (name, loopName) => {
      const path = join(root, name);
      mkdirSync(join(path, ".ralph"), { recursive: true });
      if (loopName !== undefined) writeFileSync(join(path, ".ralph", "loop-name"), `${loopName}\n`);
      return path;
    },
    adapter: (config = {}) =>
      createRalphAdapter({
        cliDir: CLI_DIR,
        roots: [root],
        // Through the world, not `rec.exec` captured once, so a gate added
        // after the adapter was built still holds its reads.
        exec: async (invocation) => {
          for (const entry of gates) {
            if (!matches(entry.match, invocation)) continue;
            const held = entry.hold(invocation);
            if (held !== null) await held;
          }
          return rec.exec(invocation);
        },
        now: () => clock.t,
        bunPath: BUN,
        pythonPath: PYTHON,
        journalHome: JOURNAL_HOME,
        ...config,
        // No PATH of a fake bin: the executor is the whole runtime here. The
        // adapter merges this over `process.env`, and the test host runs live
        // loops, so the variables it reads from there are pinned to neutral.
        env: { HOME: join(root, "home"), RALPH_JOURNAL_DIR: "", RALPH_TRIAGE_MAX_WRITES: "", ...config.env },
      }),
  };
  return world;
}
