/**
 * The dashboard server's composition: every adapter, factory and scheduled
 * pass `main()` wires, built from injected dependencies so the whole server
 * can be assembled in-process.
 *
 * It reads no environment and names no Bun API: `server.ts`'s `main()` parses
 * the environment, builds the shell and the real dependencies, and serves
 * what this returns. Executors come in through `deps.executor`, one per
 * timeout surface, and are only ever handed to an adapter as its `exec:`.
 * Every adapter that runs a command is built here from its real factory over
 * one of those executors — the project read through `deps.ralphAdapter`, the
 * rest named directly — so a test answers the whole server's commands through
 * that one factory. `deps.factories` holds only what runs no executor.
 */
import { createRalphAdapter, defaultBunPath } from "./adapter";
import type { AgentsDeps } from "./agents";
import { createAgentsAdapter } from "./agents-adapter";
import type { Asset } from "./build";
import { ChatSessions, createChatRunner } from "./chat";
import { createHandbackAdapter } from "./chat-handback-adapter";
import type { HandbackFactory } from "./chat-routes";
import type { DashboardConfig } from "./config";
import { createRalphControlAdapter, type ControlStatusRead } from "./control-adapter";
import type { Executor } from "./executor";
import type { ControlsFactory } from "./control-routes";
import { readControlStatus } from "./control-view";
import { createDoctorAdapter } from "./doctor-adapter";
import type { DoctorFactory } from "./doctor-routes";
import { cachedRead, HEALTH_TTL_MS, liveHealth } from "./health";
import { createIntakeAdapter } from "./intake-adapter";
import { createInterruptAdapter } from "./interrupt-adapter";
import { createRedactor, followIterationOutput, type Emit, type Follower } from "./iteration-output";
import { createJavAdapter } from "./jav-adapter";
import { createRalphLifecycleAdapter, readBootTimeMs } from "./lifecycle-adapter";
import type { InterruptFactory, LifecycleFactory } from "./lifecycle-routes";
import { createOnboarding } from "./onboarding";
import { createOnboardingAdapter } from "./onboarding-adapter";
import { createProjectSleepAdapter } from "./project-sleep-adapter";
import { createClaudeAccountsAdapter } from "./claude-accounts-adapter";
import { createEvalsAdapter } from "./evals-adapter";
import { createLearningsFileAdapter } from "./learnings-file-adapter";
import type { ProjectEntry, ProjectRegistry, RegisteredProject } from "./projects";
import { createRecordsAdapter } from "./records-adapter";
import {
  createReconcileAdapter,
  reconcile,
  targetsFrom,
  watchMigrations,
  watchProjectsFrom,
  type ReconcileConfig,
  type ReconcileTarget,
  type RetrySeen,
  type Said,
  type Seen,
} from "./reconcile";
import { createHandler, type ProjectScope, type SnapshotStreamOptions } from "./server";
import { createUsageSource } from "./usage";
import { createUsageBarAdapter } from "./usagebar-adapter";
import { createHandler as createLineupHandler } from "../lineup/server";


/**
 * The factories that run no executor of their own: in-process reads, signals,
 * a worker thread, a router over the `lineup` dep, or a long-lived child (a
 * chat, the redactor) whose streams an `Executor` cannot carry. Every other adapter is built here from its real
 * factory over `deps.executor`, so a test answers its commands there.
 */
export interface ExecFreeFactories {
  records: typeof createRecordsAdapter;
  chatRunner: typeof createChatRunner;
  redactor: typeof createRedactor;
  follower: typeof followIterationOutput;
  usage: typeof createUsageSource;
  lineupHandler: typeof createLineupHandler;
  interrupt: typeof createInterruptAdapter;
}

/** The real exec-free factories, as `main()` wires them. */
export const processFactories: ExecFreeFactories = {
  records: createRecordsAdapter,
  chatRunner: createChatRunner,
  redactor: createRedactor,
  follower: followIterationOutput,
  usage: createUsageSource,
  lineupHandler: createLineupHandler,
  interrupt: createInterruptAdapter,
};

export interface ServerDeps {
  config: DashboardConfig;
  registry: ProjectRegistry;
  shell: { html: string; assets: ReadonlyMap<string, Asset> };
  /** The harness checkout: Jav's and intake's CLI, onboarding's harness. */
  harness: string;
  reconciling: ReconcileConfig;
  /** The lineup editor's adapter, shared by every project's lineup handler. */
  lineup: Parameters<typeof createLineupHandler>[0]["adapter"];
  /** One executor per timeout surface; `undefined` is the executor's default. */
  executor: (timeoutMs?: number) => Executor;
  /**
   * The project read's factory, a dep of its own because it is the one adapter
   * a caller may still want to wrap (the preview answers it from a canned
   * world). Its exec is always `deps.executor()`'s.
   */
  ralphAdapter: typeof createRalphAdapter;
  factories: ExecFreeFactories;
  log?: { out(line: string): void; err(line: string): void };
  /** The change stream's timings, file watch and log (#724); absent, its defaults, logging to `log.err`. */
  snapshotStream?: SnapshotStreamOptions;
}

export interface ComposedServer {
  fetch: (request: Request) => Promise<Response>;
  /** One guarded reconcile pass. */
  reconcile: () => Promise<void>;
  /** One guarded migration-watchdog pass. */
  watchMigrations: () => Promise<void>;
  chats: ChatSessions;
}

const CONSOLE = { out: (line: string) => console.log(line), err: (line: string) => console.error(line) };

export function composeServer(deps: ServerDeps): ComposedServer {
  const { config, registry, harness, reconciling, factories } = deps;
  const log = deps.log ?? CONSOLE;
  const defaultExecutor = deps.executor();
  const controlAdapterFor = (worktree: string) =>
    createRalphControlAdapter({
      cliDir: config.cliDir,
      root: worktree,
      ...(config.bunPath === undefined ? {} : { bunPath: config.bunPath }),
      exec: defaultExecutor,
    });
  const controlStatus = (worktree: string): Promise<ControlStatusRead> =>
    readControlStatus(controlAdapterFor(worktree));
  const controls: ControlsFactory = ({ worktree }) => ({ adapter: controlAdapterFor(worktree) });
  const lifecycle: LifecycleFactory = ({ worktree, project }) => ({
    control: controlAdapterFor(worktree),
    lifecycle: createRalphLifecycleAdapter({
      cliDir: config.cliDir,
      root: worktree,
      ...(project === undefined ? {} : { env: { RALPH_PROJECT_ID: project } }),
      ...(config.bunPath === undefined ? {} : { bunPath: config.bunPath }),
      ...(config.startScript === undefined ? {} : { startScript: config.startScript }),
      exec: defaultExecutor,
    }),
  });
  // A Fix all can wait on a runtime starting and several bounded plugin calls;
  // it stays under `server.ts`'s `idleTimeout`.
  const doctorExecutor = deps.executor(240_000);
  const doctor: DoctorFactory = ({ worktree }) =>
    createDoctorAdapter({
      cliDir: config.cliDir,
      root: worktree,
      ...(config.bunPath === undefined ? {} : { bunPath: config.bunPath }),
      exec: doctorExecutor,
    });
  // Fetches, pushes and `gh pr create` go over the network.
  const agentsExecutor = deps.executor(120_000);
  const agents = (project: RegisteredProject): AgentsDeps => ({
    agents: createAgentsAdapter({
      cliDir: config.cliDir,
      root: project.path,
      project: project.id,
      ...(project.worktrees === undefined ? {} : { worktreesDir: project.worktrees }),
      ...(config.bunPath === undefined ? {} : { bunPath: config.bunPath }),
      exec: agentsExecutor,
    }),
  });
  const interrupt: InterruptFactory = ({ worktree }) => ({
    interrupt: factories.interrupt({ root: worktree }),
    control: controlAdapterFor(worktree),
  });
  // The sleep CLI reads or writes one small file in the git common directory.
  const sleepExecutor = deps.executor(20_000);
  // Filing a learning publishes through the journal lock and opens an issue:
  // it waits on the network like Unblock & resume's writes do.
  const learningsFileExecutor = deps.executor(240_000);
  // Listing reads every run's report; starting validates the plan and launches. Neither waits on a trial.
  const evalsExecutor = deps.executor(60_000);
  // Jav's and intake's CLIs: 20s is the bound each adapter took by default.
  const cliExecutor = deps.executor(20_000);
  // Each project keeps one adapter (its in-flight read and frontier cache)
  // and one usage source for as long as the registry lists it at the same roots
  // and worktrees folder: the scope's entry is what Add agent builds on, so a
  // folder set from Settings must reach the next request, not the next restart.
  const scopes = new Map<string, ProjectScope & { usage: ReturnType<typeof createUsageSource> }>();
  const scopesFor = (entries: readonly ProjectEntry[]): ProjectScope[] => {
    const listed = entries.map((entry) => ({ entry, key: JSON.stringify([entry.id, entry.roots, entry.worktrees ?? null]) }));
    // A project removed, re-rooted or re-foldered since the last request drops its reads.
    for (const [key, scope] of scopes) {
      if (!listed.some((item) => item.key === key)) {
        scope.usage.close();
        scopes.delete(key);
      }
    }
    return listed.map(({ entry, key }) => scopeFor(entry, key));
  };
  const scopeFor = (entry: ProjectEntry, key: string): ProjectScope => {
    const cached = scopes.get(key);
    if (cached !== undefined) return cached;
    const adapter = deps.ralphAdapter({
      cliDir: config.cliDir,
      roots: entry.roots,
      // Keys the project's tracker credential, saved by the connector under this id.
      projectId: entry.id,
      ...(config.bunPath === undefined ? {} : { bunPath: config.bunPath }),
      exec: defaultExecutor,
    });
    // Usage reads each loop's own logs; which worktree is which loop comes from
    // the local read — loop state, never `gh` — refreshed at most every 30s, so
    // another project's page can ask for this one's plan cheaply.
    const usage = factories.usage({
      targets: async () =>
        (await adapter.readLocal()).loops.flatMap((loop) =>
          loop.identity === null ? [] : [{ loop: loop.identity, worktree: loop.worktree }],
        ),
    });
    const { roots: _roots, ...project } = entry;
    // While another project is shown, this one is read locally at most every
    // 30s: its health for the switcher, its plan reading for the account.
    // `healthProducer` is the change stream's cheap read of the same health
    // (#729): another project's page hears it move within a second.
    const { health, producer: healthProducer } = liveHealth({
      project: project.id,
      local: () => adapter.readLocal(),
      controlStatus,
    });
    const summary = cachedRead(async () => {
      const report = await usage();
      return { plan: report.plan, spend: { spend: report.spend, daily: report.daily } };
    }, HEALTH_TTL_MS);
    const plan = async () => (await summary()).plan;
    const spend = async () => (await summary()).spend;
    // Lineup and Jav are harness-wide files keyed by project: each project's
    // pages edit that project's keys and no other's.
    const scope = {
      project,
      adapter,
      usage,
      health,
      healthProducer,
      plan,
      spend,
      lineup: factories.lineupHandler({ adapter: deps.lineup, project: project.id }),
      jav: createJavAdapter({
        cliDir: harness,
        bunPath: config.bunPath ?? defaultBunPath(),
        project: { id: project.id, root: project.path },
        exec: cliExecutor,
      }),
      // A project without a clerk answers "no clerk" from the CLI itself.
      intake: createIntakeAdapter({
        cliDir: harness,
        bunPath: config.bunPath ?? defaultBunPath(),
        project: { root: project.path },
        exec: cliExecutor,
      }),
      // One marker per repo, so the registered checkout speaks for every
      // worktree and loop of the project.
      sleep: createProjectSleepAdapter({
        cliDir: harness,
        root: project.path,
        ...(config.bunPath === undefined ? {} : { bunPath: config.bunPath }),
        exec: sleepExecutor,
      }),
      // The registry is the host's; the registered checkout gives the roster,
      // the committed rule and the git common dir the override lives in.
      claudeAccounts: createClaudeAccountsAdapter({
        cliDir: harness,
        root: project.path,
        ...(config.bunPath === undefined ? {} : { bunPath: config.bunPath }),
        exec: sleepExecutor,
      }),
      // The same harness checkout the snapshot reads the learnings from, so
      // the entry the button names is the one the publisher edits.
      learningsFile: createLearningsFileAdapter({
        cliDir: config.cliDir,
        root: project.path,
        ...(config.bunPath === undefined ? {} : { bunPath: config.bunPath }),
        exec: learningsFileExecutor,
      }),
      // The registered checkout: its experiment logs hold the project's runs.
      evals: createEvalsAdapter({
        cliDir: harness,
        root: project.path,
        // The registry id, as the loops stamp it: the suggestions filter the
        // speed ledger by it and look up a keyed tracker's credential under it.
        env: { RALPH_PROJECT_ID: project.id },
        ...(config.bunPath === undefined ? {} : { bunPath: config.bunPath }),
        exec: evalsExecutor,
      }),
    };
    scopes.set(key, scope);
    return scope;
  };
  // Cloning a repo takes as long as the network does; it stays under
  // `server.ts`'s `idleTimeout`.
  const onboardingExecutor = deps.executor(240_000);
  const onboarding = createOnboarding({
    adapter: createOnboardingAdapter({
      cliDir: config.cliDir,
      harness,
      ...(config.bunPath === undefined ? {} : { bunPath: config.bunPath }),
      exec: onboardingExecutor,
    }),
    registry,
  });
  // One chat registry for the whole server: a chat id is only meaningful to
  // the process that minted it, and each chat is stamped with its project.
  const chats = new ChatSessions(factories.chatRunner({ bunPath: config.bunPath ?? defaultBunPath(), cliDir: config.cliDir }));
  // No shutdown hook, deliberately: `read-only.test.ts` reserves signalling a
  // process to `interrupt.ts`, and a handler here would be the dashboard
  // acquiring that power for bookkeeping. A chat's children are reaped by
  // their pipes instead: they are closed when this process exits, so the
  // redactor's stdin ends and `claude`'s stdout breaks and both finish. The
  // close route calls `ChatSessions.close`; `stopAll` is the tests'.
  // Unblock & resume's writes: `gh` on the ticket and the journal publisher,
  // whose lock wait and pushes take longer than a control read. The journal
  // goes to the harness the dashboard reads it from, named explicitly.
  const handbackExecutor = deps.executor(240_000);
  const handback: HandbackFactory = ({ loop, worktree }) =>
    createHandbackAdapter({
      cliDir: config.cliDir,
      journalHome: config.cliDir,
      root: worktree,
      loop,
      ...(config.bunPath === undefined ? {} : { bunPath: config.bunPath }),
      exec: handbackExecutor,
    });
  // The pane's redactor is the harness's own, run from the harness checkout.
  const redactor = factories.redactor({ bunPath: config.bunPath ?? defaultBunPath(), cliDir: config.cliDir });
  const output = (worktree: string, emit: Emit): Follower =>
    factories.follower({ worktree, redactor, emit });
  const records = (worktree: string) => factories.records({ root: worktree });
  // One UsageBar reader for the whole server: the reading is the machine's,
  // not a project's, and it is cached so every page shares one CLI call.
  const usagebarExecutor = deps.executor(20_000);
  const usagebar = createUsageBarAdapter({ exec: usagebarExecutor, cwd: harness });
  const fetch = createHandler({
    projects: () => scopesFor(registry.list()),
    shell: deps.shell.html,
    assets: deps.shell.assets,
    controlStatus,
    controls,
    lifecycle,
    doctor,
    interrupt,
    output,
    records,
    usagebar,
    retrySchedule: reconciling.retryScheduleMinutes,
    chats,
    handback,
    onboarding,
    agents,
    registry,
    hosts: new Set(config.hosts),
    // A failed watch or snapshot read goes to the server's journal; a test's own log wins.
    snapshotStream: { log: (line: string) => log.err(line), ...deps.snapshotStream },
  });
  // The loops this dashboard shows do not come back by themselves. The
  // service does — `Restart=always` after an oomd kill, `WantedBy` plus
  // linger after a reboot — so a pass here, once at startup and then on a
  // timer, is what restarts a loop whose supervisor died without choosing an
  // ending (#329).
  const reconcileAdapter = createReconcileAdapter({
    cliDir: config.cliDir,
    exec: defaultExecutor,
    ...(config.bunPath === undefined ? {} : { bunPath: config.bunPath }),
  });
  // What this process has already logged about an unreadable project or a
  // loop left down, so a standing state is one journal line, not one a pass
  // (#765). Outlives passes like `reconcileSeen`, and is per process for the
  // same reason: a restarted dashboard says each standing state once again.
  const reconcileSaid: Said = new Map();
  // The local read, not the page's: the roster and each worktree's record from
  // `loop-state status --json` alone, no `gh` and no per-loop reads. Its own
  // adapter per project rather than the request scopes', because the pass runs
  // whether or not anybody has that project open. The walk itself is
  // `targetsFrom`, where it is tested.
  const reconcileTargets = (): Promise<ReconcileTarget[]> => {
    // One reading of the registry per pass, so the walk and the deps a target
    // is built with cannot disagree about which projects there are.
    const registered = new Map(
      registry.list().map((entry) => {
        const { roots, ...project } = entry;
        return [project.id, { project, roots }] as const;
      }),
    );
    return targetsFrom(
      [...registered.values()].map(({ project, roots }) => ({
        project: project.id,
        read: () =>
          deps
            .ralphAdapter({
              cliDir: config.cliDir,
              roots,
              ...(config.bunPath === undefined ? {} : { bunPath: config.bunPath }),
              exec: defaultExecutor,
            })
            .readLocal(),
      })),
      ({ project, loop, worktree }) => ({
        // The factory reads the worktree and the project id; a `ControlTarget`
        // carries the liveness for the ROUTES, which read it from the snapshot
        // they answered the request from. The pass reads liveness itself, per
        // target, which is the read the decision is made on.
        lifecycle: { ...lifecycle({ loop, worktree, supervisor: "unknown", project }), loop },
        agents: agents(registered.get(project)!.project),
      }),
      (line) => log.err(line),
      reconcileSaid,
    );
  };
  // The bound's second ceiling, which has to outlive a pass to be one: the
  // records are the bound, and this is what still bounds a loop whose attempt
  // records cannot be written (`reconcile.ts`'s invariant 3). It is per
  // PROCESS on purpose — `Restart=always` resetting it is why it is never the
  // only ceiling.
  const reconcileSeen: Seen = new Map();
  // The retry path's own, for the same reason: a retry whose push fails
  // leaves no record to count it by.
  const reconcileRetrySeen: RetrySeen = new Map();
  // The migration watchdog's projects (#434): one root per registered project,
  // not per loop, because the `migration-applied` label is the project's. The
  // walk is `watchProjectsFrom`, where it is tested.
  const watchProjects = () =>
    watchProjectsFrom(
      registry.list().map(({ roots, id }) => ({
        project: id,
        read: () =>
          deps
            .ralphAdapter({
              cliDir: config.cliDir,
              roots,
              ...(config.bunPath === undefined ? {} : { bunPath: config.bunPath }),
              exec: defaultExecutor,
            })
            .readLocal(),
      })),
      (line) => log.err(line),
      reconcileSaid,
    );
  // Occurrences this process has already pushed, so a stalled PR does not
  // cost a `bun` push every tick. Outlives passes like `reconcileSeen`; the
  // dedupe that survives a restart is push-notification's own, at the root.
  const migrationsPushed = new Set<string>();
  // Each pass is already non-throwing; these guards are what keep a throw
  // from one anyway from costing the other its tick.
  const guarded = async (what: string, pass: () => Promise<unknown>): Promise<void> => {
    try {
      await pass();
    } catch (error) {
      log.err(`ralph-dashboard: ${what} pass failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return {
    fetch,
    reconcile: () =>
      guarded("reconcile", () =>
        reconcile({
          targets: reconcileTargets,
          records,
          adapter: reconcileAdapter,
          attempts: reconciling.attempts,
          retrySchedule: reconciling.retryScheduleMinutes,
          seen: reconcileSeen,
          retrySeen: reconcileRetrySeen,
          said: reconcileSaid,
          bootTime: readBootTimeMs,
          log: (line) => log.out(line),
        }),
      ),
    watchMigrations: () =>
      guarded("migration-watchdog", async () =>
        watchMigrations({
          projects: await watchProjects(),
          adapter: reconcileAdapter,
          alertSeconds: reconciling.migrationAlertSeconds,
          pushed: migrationsPushed,
          log: (line) => log.out(line),
        }),
      ),
    chats,
  };
}
