/**
 * The local Bun HTTP server: a thin adapter over the pure aggregation.
 *
 * Handlers parse a request, call `adapter.read()` and `aggregateDashboard`, and
 * serialize. They contain no projection logic and invoke no runtime command —
 * that is the adapter's job, behind the process boundary. The server binds
 * loopback only. The observation routes are `GET`; the write surfaces are
 * mounted handlers, each reached only when its factory is supplied:
 *
 *   - `POST /api/control` in `control-routes.ts`, a thin adapter over dispatch;
 *   - `POST /api/start`, `POST /api/restart`, `POST /api/resume-work` and
 *     `POST /api/stop-now` in `lifecycle-routes.ts`, a thin adapter over
 *     lifecycle dispatch and Stop now (`interrupt.ts`);
 *   - `POST /api/doctor` in `doctor-routes.ts`, which runs the harness's plugin
 *     doctor for a loop's checkout;
 *   - the lineup editor under `/api/lineup*`, which writes only the project's
 *     keys in `models.json`;
 *   - the notification feed and audit history in `records-routes.ts`, which
 *     read a loop's records and write only the feed's read mark;
 *   - Jav under `/api/jav*`, which writes only the project's block in the
 *     harness's `jav.json`;
 *   - the project's sleep at `/api/sleep` in `project-sleep-routes.ts`, which
 *     sets or clears its one marker through the harness's `project-sleep.ts`;
 *   - filing one learning as a ticket at `/api/learnings/file` in
 *     `learnings-file-routes.ts`, through the harness's `findings.ts file`;
 *   - adding a project (`POST /api/projects`, `GET /api/github/repos`) and
 *     setting one up (`/api/p/:project/setup*`) in `onboarding-routes.ts`,
 *     which also refuses Start, Restart and Resume work on a project that is
 *     not ready, and answers a failed read on one with `ProjectNotReady`;
 *   - agents under `/api/agents*` in `agents-routes.ts`: Add agent (a
 *     worktree and a roster PR), Delete agent worktree, and a new agent's
 *     Start, which also gates `POST /api/start`; `GET /api/labels`, the
 *     labels the roster needs (read-only); and `POST
 *     /api/projects/remove`, which writes only the project registry.
 *
 * `GET /api/loops/:name/output` is the one held-open response: the loop's
 * iteration log, redacted, as server-sent events (`iteration-output.ts`).
 *
 * Every page and API route is scoped to a project: `/p/:project/…` and
 * `/api/p/:project/…`, each project served by its own adapter. An unknown
 * project is a 404. Unscoped legacy URLs keep working: a page redirects into
 * the first registered project, and an API path is answered as that
 * project's. `GET /api/projects` lists the registered projects.
 *
 * Only the project the page shows gets the full snapshot, and only when the
 * page asks for it. Every other project is read through `GET
 * /api/projects/health`: local loop state and control records, no `gh`, at
 * most every 30s (`health.ts`). The usage route pairs the project's own spend
 * with the account's plan, read across every project's logs.
 *
 * Two refusals precede every route in that list: a request whose `Host` the
 * server does not answer to is 403 `UnknownHost`, and a write the browser
 * itself reports as cross-site is 403 `CrossOrigin` (`hostAllowed`,
 * `sameSiteWrite` in `routes.ts`). The page has no login — the machine's user
 * is the operator — so request authenticity is the one check it can make.
 *
 * `Bun.serve` is declared locally rather than pulled in as a dependency type:
 * the tool is run by Bun and never compiled into the Next.js app, so it must
 * not drag the app's type graph in either.
 */
import { createRalphAdapter, RalphContractError, type RalphAdapter } from "./adapter";
import { gatedStart, type AgentsDeps, type ProjectRegistryWrite } from "./agents";
import { handleAgentRoute, handleProjectRemoval, START_AGENT_PATH, type AgentsFactory } from "./agents-routes";
import { aggregateDashboard } from "./aggregate";
import { buildShell, type Asset } from "./build";
import { configFromEnv, DashboardConfigError } from "./config";
import type {
  AccountUsageView,
  Clock,
  ControlsView,
  Dashboard,
  LoopRetryView,
  PlanUsageView,
  ProjectHealthView,
  ProjectsHealthView,
  ProjectUsageReport,
  DailySpendView,
  MachineSpendView,
  RuntimeLoop,
  SpendWindows,
  UsageBarView,
  UsageReport,
} from "./contracts";
import { createProcessExecutor, type ControlStatusRead } from "./control-adapter";
import type { ChatSessions } from "./chat";
import { composeServer, processFactories } from "./compose";
import { HANDBACK_PATH, handleChatRoute, type HandbackFactory } from "./chat-routes";
import { handleControlRoute, type ControlsFactory } from "./control-routes";
import { composeControlView, composeControlViews } from "./control-view";
import { handleDoctorRoute, type DoctorFactory } from "./doctor-routes";
import { createGateRunner, type GateRunner } from "./gate-run";
import { unknownHealth } from "./health";
import { outputResponse, type Emit, type Follower } from "./iteration-output";
import { JavError, type JavAdapter } from "./jav-adapter";
import { handleJavRoute } from "./jav-routes";
import type { ProjectSleepAdapter } from "./project-sleep-adapter";
import type { ClaudeAccountsAdapter } from "./claude-accounts-adapter";
import { handleClaudeAccountsRoute } from "./claude-accounts-routes";
import { handleProjectSleepRoute } from "./project-sleep-routes";
import type { LearningsFileAdapter } from "./learnings-file-adapter";
import { handleLearningsFileRoute } from "./learnings-file-routes";
import type { EvalsAdapter } from "./evals-adapter";
import { handleEvalsRoute } from "./evals-routes";
import type { IntakeAdapter } from "./intake-adapter";
import { handleIntakeRoute } from "./intake-routes";
import {
  handleLifecycleRoute,
  RESTART_PATH,
  RESUME_WORK_PATH,
  START_PATH,
  type InterruptFactory,
  type LifecycleFactory,
} from "./lifecycle-routes";
import type { Onboarding } from "./onboarding";
import { explainUnlessReady, handleProjectsRoute, handleSetupRoute, refuseUnlessReady } from "./onboarding-routes";
import { handleRecordsRoute, type RecordsFactory } from "./records-routes";
import {
  DEFAULT_RETRY_SCHEDULE_MINUTES,
  reconcileConfigFromEnv,
  RECONCILE_ENV,
  retryView,
  schedule,
} from "./reconcile";
import { createProjectRegistry, ProjectRegistryError, projectsFile, type RegisteredProject } from "./projects";
import { loopOf, matchRoute, PROJECTIONS } from "./route-table";
import {
  createSnapshotHub,
  snapshotWatchDirs,
  streamResponse,
  type SnapshotHub,
  type SnapshotHubOptions,
  type SnapshotProducer,
  type StreamForward,
} from "./snapshot-stream";
import { hostAllowed, isShellPath, isTopLevelPage, PROJECTS_HEALTH_PATH, sameSiteWrite, SCOPED_API_PATH, SCOPED_PAGE_PATH } from "./routes";
import { accountPlan, mergeDaily, sumSpend } from "./usage";
import { createLineupAdapter } from "../lineup/adapter";
import { configFromEnv as lineupConfigFromEnv } from "../lineup/config";
import { RALPH_HOME, projectRoot } from "../paths";

interface BunServer {
  hostname: string;
  port: number;
  stop(closeActiveConnections?: boolean): void;
}

declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    idleTimeout?: number;
    fetch: (request: Request) => Response | Promise<Response>;
  }): BunServer;
};

/** One registered project and the runtime reads scoped to it. */
export interface ProjectScope {
  project: RegisteredProject;
  adapter: RalphAdapter;
  /** The project's usage and cost; unmounted, its `/usage` API is 404. */
  usage?: () => Promise<UsageReport>;
  /**
   * The lineup editor pinned to this project's keys in `models.json`. Absent,
   * the shared `lineup` handler serves the project.
   */
  lineup?: (request: Request) => Promise<Response>;
  /** Jav pinned to this project's block in `jav.json`. Absent, the shared `jav` does. */
  jav?: JavAdapter;
  /** The clerk's intake page, under `/api/intake*` (felipearos/ralph#459). Absent, those paths are 404. */
  intake?: IntakeAdapter;
  /**
   * The project's sleep at `/api/sleep`: one marker every loop of the project
   * reads at its iteration boundary. Absent, the path is 404.
   */
  sleep?: ProjectSleepAdapter;
  /**
   * The host's Claude accounts and which one each loop of the project runs
   * on, at `/api/claude-accounts`. Absent, the path is 404.
   */
  claudeAccounts?: ClaudeAccountsAdapter;
  /** Filing one learning as a ticket at `/api/learnings/file`. Absent, the path is 404. */
  learningsFile?: LearningsFileAdapter;
  /** The Evals tab's runs at `/api/evals*` (#801). Absent, those paths are 404. */
  evals?: EvalsAdapter;
  /**
   * The project's health for the switcher while another project is shown:
   * local reads only, cached. Absent, the project is left out of `GET
   * /api/projects/health`.
   */
  health?: () => Promise<ProjectHealthView>;
  /**
   * The same health, uncached, as the project's snapshot hub's `_/health`
   * producer (#729): another project's stream forwards its key when it moves.
   * Without `targets`, its value's `loops[].worktree` are watched as the
   * dashboard's are. Absent, the project's health is not forwarded.
   */
  healthProducer?: SnapshotProducer;
  /**
   * The newest plan reading in the project's logs, cached, for the account's
   * plan on another project's usage page. Absent, it is not asked.
   */
  plan?: () => Promise<PlanUsageView | null>;
  /**
   * The project's reported spend, cached like `plan`, for the all-projects
   * spend on another project's usage page. Absent, the project adds nothing.
   */
  spend?: () => Promise<{ spend: SpendWindows; daily: DailySpendView[] }>;
}

/** The stream key another project's health moves under (#729). */
const HEALTH_KEY = "_/health";

/**
 * How long a project's last runtime read answers the next request instead of
 * a new `loop-state status` run. The page asks `/api/loops` and then
 * `/api/controls` back to back, and each read runs every loop's status. It
 * must stay below the page's poll interval (`POLL_MS` in `ui/reads.ts`), so a
 * reused snapshot is never older than the freshness the page already promises.
 * Counted from when the read started, and a read takes 1.7–2.5 s on a busy
 * host, so a window near that length would close before the next request.
 */
export const RUNTIME_REUSE_MS = 4_000;

/** The project the `adapter` shorthand stands for when no registry is given. */
export const IMPLICIT_PROJECT: RegisteredProject = {
  id: "default",
  path: "/",
  addedAt: "1970-01-01T00:00:00.000Z",
  source: "local",
};

export interface HandlerOptions {
  /**
   * The registered projects, in registration order; the first is where legacy
   * unscoped URLs land. Asked on every request, so a project added by another
   * dashboard process is served without a restart.
   */
  projects?: () => readonly ProjectScope[] | Promise<readonly ProjectScope[]>;
  /** Shorthand for a single project observed by this adapter (and `usage`). */
  adapter?: RalphAdapter;
  /** The HTML document served at `/`. */
  shell: string;
  /** The shell's bundled script and stylesheet, keyed by request path. */
  assets?: ReadonlyMap<string, Asset>;
  /** Extra `Host` names answered beside loopback and the tailnet (`RALPH_DASHBOARD_HOSTS`). */
  hosts?: ReadonlySet<string>;
  /** Defaults to the wall clock; injected as a factory so tests can freeze it. */
  clock?: () => Clock;
  /**
   * Read one worktree's control record (`controls status --json`). Read
   * only; when absent, every control view reports an unreachable channel.
   */
  controlStatus?: (worktree: string) => Promise<ControlStatusRead>;
  /**
   * The control adapter and executor dispatch sends through for a loop's
   * checkout. Absent, `POST /api/control` is not served.
   */
  controls?: ControlsFactory;
  /**
   * What lifecycle dispatch runs against for a loop's checkout. Absent,
   * `POST /api/start`, `POST /api/restart` and the checkout report are not
   * served.
   */
  lifecycle?: LifecycleFactory;
  /**
   * The plugin doctor for a loop's checkout. Absent, `POST /api/doctor` is not
   * served.
   */
  doctor?: DoctorFactory;
  /**
   * What Stop now runs against for a loop's checkout — the one factory that
   * can signal a process (`interrupt-adapter.ts`). Absent, `POST
   * /api/stop-now` is not served.
   */
  interrupt?: InterruptFactory;
  /**
   * The lineup editor's handler, mounted under `/api/lineup*` and `/api/roots`.
   *
   * It writes only `models.json` through the editor's validate-then-atomic-write
   * path, and never reaches the loop runtime.
   */
  lineup?: (request: Request) => Promise<Response>;
  /**
   * Jav, difficulty routing, under `/api/jav*`. It writes only the harness's
   * `jav.json`, through `jav.ts --save`'s validate-then-write.
   */
  jav?: JavAdapter;
  /**
   * The `adapter` shorthand's usage and reported cost, served at
   * `/api/usage`. Read-only: it tails the loops' own logs. Unmounted, the path
   * is 404.
   */
  usage?: () => Promise<UsageReport>;
  /**
   * The machine's UsageBar reading, carried on every project's usage route:
   * the providers' own limit windows, which no loop's logs hold for Codex.
   * Absent, the usage route carries none.
   */
  usagebar?: { usage(): Promise<UsageBarView>; cost(): Promise<MachineSpendView> };
  /**
   * Follow one worktree's iteration log, served at `/api/loops/:name/output`.
   * Read-only: it tails a log through the harness's redactor. Unmounted, the
   * path is 404.
   */
  output?: (worktree: string, emit: Emit) => Follower;
  /**
   * A loop checkout's notification feed and audit history, served at
   * `/api/notifications`, `/api/loops/:name/notifications` and
   * `/api/loops/:name/history`, with the read mark at `POST
   * /api/notifications/read`. Unmounted, the paths are 404.
   */
  records?: RecordsFactory;
  /**
   * The reconciler's effective retry schedule in minutes
   * (`RALPH_DASHBOARD_RETRY_SCHEDULE`, else the default), which each loop's
   * next retry on the page is computed from, so the page uses the gaps the
   * reconciler waits. Absent, `DEFAULT_RETRY_SCHEDULE_MINUTES`.
   */
  retrySchedule?: readonly number[];
  /**
   * The unblocker chat's live sessions (`chat.ts`), served at `/api/chat*`.
   * One registry for the whole server, because a chat id is only meaningful
   * to the process that minted it. Unmounted, the paths are 404.
   */
  chats?: ChatSessions;
  /**
   * What the chat's Unblock & resume writes through for a loop's checkout:
   * the ticket's `gh` calls and the journal publisher. Absent, a handback is
   * refused.
   */
  handback?: HandbackFactory;
  /**
   * Adding and setting up projects. Absent, `POST /api/projects`, `GET
   * /api/github/repos` and `/api/p/:project/setup*` are not served, and a
   * start is not gated on the project being ready.
   */
  onboarding?: Onboarding;
  /**
   * What agent dispatch runs against for a project. Absent, `/api/agents*` is
   * not served and a start is not gated.
   */
  agents?: (project: RegisteredProject) => AgentsDeps;
  /**
   * The registry `POST /api/projects/remove` unregisters from, and
   * `POST /api/settings/worktrees` writes a project's folder to. Served only
   * when `agents` is too: removal first reads the project's supervisors.
   */
  registry?: ProjectRegistryWrite;
  /**
   * The change stream's timings, file watch and log (#724). Tests shorten
   * the timings and fake the watch; the composition routes the log to the
   * server's stderr. Absent, the hub's own defaults and the 20 s heartbeat.
   */
  snapshotStream?: SnapshotStreamOptions;
  /**
   * How long, from when it started, a project's last successful runtime read
   * answers later requests in place of a new one. Absent,
   * `RUNTIME_REUSE_MS`; `0` reads afresh on every request.
   */
  runtimeReuseMs?: number;
}

/** Each project's snapshot hub and its responses: timings, the file watch and the log. */
export type SnapshotStreamOptions = Pick<SnapshotHubOptions, "debounceMs" | "minIntervalMs" | "fallbackMs" | "watch" | "log"> & {
  heartbeatMs?: number;
};

/** The paths the lineup editor owns; everything else is the observer's. */
export const isLineupPath = (pathname: string): boolean =>
  pathname === "/api/roots" || pathname === "/api/lineup" || pathname.startsWith("/api/lineup/");

const getOnly = (): Response => new Response("method not allowed", { status: 405, headers: { allow: "GET" } });

/**
 * The host the request was built with, for a `Request` that carries no `Host`
 * header: every in-process caller — today, only the tests, since the bridge
 * reaches the running server over HTTP like any other client — is one of
 * those, and the URL is the only name it has. A real socket with no `Host` is
 * not: Bun hands over a relative url, which cannot be parsed, and a request
 * that cannot name a host at all is refused rather than crashing the
 * dispatcher on it.
 */
const hostFromUrl = (url: string): string | null => (URL.canParse(url) ? new URL(url).host : null);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** A project's own spend, as its usage report carries it; a partial reader may lack either. */
type OwnSpend = { spend?: SpendWindows; daily?: DailySpendView[] };

type ProjectHandlerOptions = Omit<HandlerOptions, "projects" | "adapter" | "usage" | "shell" | "assets" | "agents" | "registry" | "hosts"> & {
  adapter: RalphAdapter;
  /** The project, whose registry id is stamped on every lifecycle target. */
  project?: RegisteredProject;
  agents?: AgentsFactory;
  /** The registry the project's worktrees folder is written to. */
  registry?: ProjectRegistryWrite;
  usage?: () => Promise<UsageReport>;
  /** The unblocker chat's live sessions, shared across this project's requests. */
  chats?: ChatSessions;
  /** The account's plan and spend across every project, given this project's own reading. */
  account?: (own: PlanUsageView | null, ownSpend: OwnSpend | undefined) => Promise<AccountUsageView>;
  /** The clerk's intake page, read-only. */
  intake?: IntakeAdapter;
  /** The project's sleep, read and set through the harness's CLI. */
  sleep?: ProjectSleepAdapter;
  /** The host's Claude accounts, read and set through the harness's CLI. */
  claudeAccounts?: ClaudeAccountsAdapter;
  /** Filing one learning as a ticket through the harness's CLI. */
  learningsFile?: LearningsFileAdapter;
  /** The project's eval runs, through the harness's `experiments.ts`. */
  evals?: EvalsAdapter;
  /** The Settings page's gate runs, one runner for every project of the server. */
  gates?: GateRunner;
  /**
   * Handed this handler's fresh snapshot read when the handler is built, so
   * the outer handler's hub for the project can recompute it even when the
   * hub is made for another project's stream (#729).
   */
  snapshotSource?: (compute: () => Promise<Dashboard>) => void;
  /**
   * The project's change stream, over the one hub per project the outer
   * handler keeps and closes when the project is removed. Absent,
   * `/api/stream` is the generic 404.
   */
  stream?: (signal: AbortSignal) => Response;
};

/**
 * Serve one project's API, at unscoped `/api/…` paths: the outer handler
 * strips the `/api/p/:project` prefix before it gets here.
 */
function createProjectHandler({
  adapter,
  project,
  clock,
  controlStatus,
  controls,
  lifecycle,
  doctor,
  interrupt,
  lineup,
  jav,
  intake,
  sleep,
  claudeAccounts,
  learningsFile,
  evals,
  usage,
  output,
  records,
  retrySchedule = DEFAULT_RETRY_SCHEDULE_MINUTES,
  chats,
  handback,
  onboarding,
  agents,
  registry,
  account,
  usagebar,
  gates,
  snapshotSource,
  stream,
  runtimeReuseMs = RUNTIME_REUSE_MS,
}: ProjectHandlerOptions): (request: Request) => Promise<Response> {
  const projectId = project?.id;
  const now = clock ?? (() => ({ nowMs: Date.now() }));
  const readStatus =
    controlStatus ?? (async (): Promise<ControlStatusRead> => ({ kind: "unreadable", why: "no control reader is configured" }));
  // This handler's adapter read on the wire, if any. The adapter shares one
  // read between overlapping callers, so the change stream's recompute must
  // not join one that began before the file event it answers: it would hash
  // the old state and miss the change.
  let reading: Promise<unknown> | null = null;
  type Runtime = Awaited<ReturnType<RalphAdapter["read"]>>;
  // The last successful read and when it started, on a wall clock of its own:
  // tests freeze the injected `clock`, which would never close the window. A
  // failed read is never kept. `generation` moves on every write, so a read
  // that began before one cannot be kept after it.
  let kept: { runtime: Runtime; startedMs: number } | null = null;
  let generation = 0;
  const forget = (): void => {
    kept = null;
    generation += 1;
  };
  // Where and when each adapter read began. The adapter hands an overlapping
  // caller the read already on the wire, so a caller's own start says nothing:
  // a read that began before a write, joined after it, must still carry the
  // write's old generation and its real start, or it would be kept as fresh.
  const origins = new WeakMap<Promise<Runtime>, { startedMs: number; generation: number }>();
  const readFresh = (): Promise<Runtime> => {
    const pending = adapter.read();
    let origin = origins.get(pending);
    if (origin === undefined) {
      origin = { startedMs: performance.now(), generation };
      origins.set(pending, origin);
    }
    const { startedMs, generation: startedIn } = origin;
    reading = pending;
    void pending.then(
      (runtime) => {
        if (reading === pending) reading = null;
        // An older read settling late must not replace a newer kept one.
        if (runtimeReuseMs > 0 && startedIn === generation && (kept === null || kept.startedMs <= startedMs)) {
          kept = { runtime, startedMs };
        }
      },
      () => {
        if (reading === pending) reading = null;
      },
    );
    return pending;
  };
  const read = (): Promise<Runtime> => {
    if (kept !== null && performance.now() - kept.startedMs < runtimeReuseMs) return Promise.resolve(kept.runtime);
    return readFresh();
  };
  // The kept snapshot is shared across requests: never write into it.
  const compose = (runtime: Runtime): Dashboard => {
    if (records === undefined) return aggregateDashboard(runtime, now());
    // New loop objects rather than writes into the read: the adapter may hand
    // the same snapshot to the next request.
    const loops = runtime.loops.map((loop): RuntimeLoop => {
      let retry: LoopRetryView | null;
      try {
        retry = retryView(records(loop.worktree).readFeed().feed, loop.state?.lastIterationEndAt, retrySchedule);
      } catch {
        // `readFeed` reports I/O as `unreadable` and `retryView` is pure; this
        // is the last line, so a surprise costs the loop its retry line, not
        // the page.
        retry = null;
      }
      return retry === null ? loop : { ...loop, retry };
    });
    return aggregateDashboard({ ...runtime, loops }, now());
  };
  const dashboard = async (): Promise<Dashboard> => compose(await read());

  // The stream's recompute: it waits out any read already on the wire (its
  // failure is that caller's), so its own starts after the change it answers.
  const freshDashboard = async (): Promise<Dashboard> => {
    while (reading !== null) {
      try {
        await reading;
      } catch {
        // The earlier caller reports its own failure.
      }
    }
    // Past the reuse window: it answers a file event, so it reads afresh,
    // and its result is what the next request reuses.
    return compose(await readFresh());
  };
  snapshotSource?.(freshDashboard);

  const handle = async (request: Request): Promise<Response> => {
    const { pathname, searchParams: search } = new URL(request.url);
    if (lineup !== undefined && isLineupPath(pathname)) return lineup(request);
    try {
      if (jav !== undefined) {
        const routed = await handleJavRoute(request, pathname, jav);
        if (routed !== null) return routed;
      }
      if (intake !== undefined) {
        const routed = await handleIntakeRoute(request, pathname, intake);
        if (routed !== null) return routed;
      }
      if (sleep !== undefined) {
        const routed = await handleProjectSleepRoute(request, pathname, sleep);
        if (routed !== null) return routed;
      }
      if (claudeAccounts !== undefined) {
        const routed = await handleClaudeAccountsRoute(request, pathname, claudeAccounts);
        if (routed !== null) return routed;
      }
      if (learningsFile !== undefined) {
        const routed = await handleLearningsFileRoute(request, pathname, learningsFile);
        if (routed !== null) return routed;
      }
      if (evals !== undefined) {
        const routed = await handleEvalsRoute(request, pathname, evals);
        if (routed !== null) return routed;
      }
      if (controls !== undefined) {
        const routed = await handleControlRoute(request, pathname, {
          controls,
          dashboard,
          now: () => new Date(now().nowMs),
        });
        if (routed !== null) return routed;
      }
      if (onboarding !== undefined && project !== undefined) {
        const routed = await handleSetupRoute(request, pathname, project, onboarding);
        if (routed !== null) return routed;
        // Unblock & resume ends in a start, so it is gated as one.
        const starts = [START_PATH, RESTART_PATH, RESUME_WORK_PATH, START_AGENT_PATH].includes(pathname) || HANDBACK_PATH.test(pathname);
        if (request.method === "POST" && starts) {
          const refused = await refuseUnlessReady(project, onboarding);
          if (refused !== null) return refused;
        }
      }
      if (agents !== undefined) {
        const routed = await handleAgentRoute(request, pathname, {
          agents,
          ...(lifecycle === undefined ? {} : { lifecycle }),
          ...(projectId === undefined ? {} : { project: projectId }),
          ...(project === undefined ? {} : { registered: { id: project.id, path: project.path, addedAt: project.addedAt } }),
          ...(gates === undefined ? {} : { gates }),
          ...(registry === undefined ? {} : { registry }),
          now: () => new Date(now().nowMs),
        });
        if (routed !== null) return routed;
      }
      if (lifecycle !== undefined) {
        const routed = await handleLifecycleRoute(request, pathname, {
          // A new agent may not start until the base branch's roster names it.
          ...(agents === undefined
            ? {}
            : { gatedStart: (target, deps) => gatedStart(agents(), deps, { name: target.loop, worktree: target.worktree }) }),
          // A start runs under this project's id, whatever the checkout's
          // directory is called, so the loop reads the keys its pages edit.
          lifecycle: projectId === undefined ? lifecycle : (target) => lifecycle({ ...target, project: projectId }),
          ...(interrupt === undefined ? {} : { interrupt }),
          dashboard,
          now: () => new Date(now().nowMs),
        });
        if (routed !== null) return routed;
      }
      if (doctor !== undefined) {
        const routed = await handleDoctorRoute(request, pathname, { doctor, dashboard });
        if (routed !== null) return routed;
      }
      if (chats !== undefined) {
        const routed = await handleChatRoute(request, pathname, {
          chats,
          dashboard,
          ...(projectId === undefined ? {} : { project: projectId }),
          // Fix's supervisor check and Stop & fix's stop run against the same
          // adapters the lifecycle routes do; without them Fix stays locked.
          ...(lifecycle === undefined
            ? {}
            : { fix: projectId === undefined ? lifecycle : (target) => lifecycle({ ...target, project: projectId }) }),
          ...(handback === undefined ? {} : { handback }),
          now: () => new Date(now().nowMs),
        });
        if (routed !== null) return routed;
      }
      if (records !== undefined) {
        const routed = await handleRecordsRoute(request, pathname, {
          records,
          dashboard,
          now: () => new Date(now().nowMs),
        });
        if (routed !== null) return routed;
      }
      if (request.method !== "GET") {
        return getOnly();
      }
      // The paths come from the route table (#630): the GET row on the path,
      // dispatched on what it does. A row the chain above should have answered
      // (its module unconfigured here) falls through to the generic 404. Only
      // the GET rows this block serves are matched, so a malformed escape on a
      // path it does not serve (`/api/commands/%E0`) is that 404, not the
      // decoder's 500.
      const match = matchRoute(
        pathname,
        "project",
        (entry) =>
          entry.method === "GET" &&
          (entry.kind === "snapshot" || entry.kind === "derived" || entry.kind === "output" || entry.kind === "stream"),
      );
      const row = match?.rows.find((entry) => entry.method === "GET");
      if (match !== null && row !== undefined) {
        const { params } = match;
        if (row.kind === "snapshot" && row.key === "usage") {
          if (usage === undefined) return json({ error: "not found" }, 404);
          const report = await usage();
          // The account and UsageBar reads degrade on their own: none throws,
          // and neither UsageBar read waits on a slow CLI, so the project's
          // spend is never held back by another project or by UsageBar.
          const [accountView, usagebarView, machineView] = await Promise.all([
            account === undefined ? undefined : account(report.plan ?? null, report),
            usagebar?.usage(),
            usagebar?.cost(),
          ]);
          return json({
            ...report,
            ...(accountView === undefined ? {} : { account: accountView }),
            ...(usagebarView === undefined ? {} : { usagebar: usagebarView }),
            ...(machineView === undefined ? {} : { machineSpend: machineView }),
          } satisfies ProjectUsageReport);
        }
        if (row.kind === "snapshot" && row.key === "dashboard") {
          return json(await dashboard());
        }
        if (row.kind === "snapshot" && row.key === "controls") {
          // Every loop's control view from one runtime read, not one per loop.
          const loops = await composeControlViews(await read(), readStatus, now());
          return json({ loops } satisfies ControlsView);
        }
        if (row.kind === "snapshot" && row.key === "control/<loop>") {
          const name = loopOf(row, params, search);
          const view = await composeControlView(await read(), name, readStatus, now());
          return view === null ? json({ error: `no loop '${name}'` }, 404) : json(view);
        }
        if (row.kind === "derived" && row.source === "dashboard") {
          const loop = loopOf(row, params, search);
          const projected = PROJECTIONS[row.projection](await dashboard(), { loop, search });
          return projected.found ? json(projected.body) : json({ error: `no loop '${loop}'` }, 404);
        }
        if (row.kind === "stream" && stream !== undefined) {
          try {
            return stream(request.signal);
          } catch (error) {
            // The page treats any non-stream answer as "poll instead": a hub
            // that cannot be made costs live updates, never the request.
            return json({ error: "StreamUnavailable", message: error instanceof Error ? error.message : String(error) }, 503);
          }
        }
        if (row.kind === "output" && output !== undefined) {
          const name = loopOf(row, params, search);
          const panel = (await dashboard()).loops.find((entry) => entry.loop === name);
          if (panel === undefined) return json({ error: `no loop '${name}'` }, 404);
          const worktree = panel.worktree;
          return outputResponse((emit) => {
            if (worktree !== null) return output(worktree, emit);
            emit({ kind: "reset", log: null, reason: "No checkout is attributed to this loop, so it has no log." });
            return { stop: () => undefined };
          }, request.signal);
        }
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      // A project that is not set up has no config to read: its reads say
      // `ProjectNotReady`, as a start does, rather than failing.
      if (onboarding !== undefined && project !== undefined && request.method === "GET") {
        const explained = await explainUnlessReady(project, onboarding);
        if (explained !== null) return explained;
      }
      return failure(error);
    }
  };
  // A write may change what the runtime reports, so the next read after it is
  // fresh: the kept snapshot is dropped before the write, and again after it,
  // since the write's own route may read (and keep) the state before it acts.
  return async (request: Request): Promise<Response> => {
    if (request.method === "GET") return handle(request);
    forget();
    try {
      return await handle(request);
    } finally {
      forget();
    }
  };
}

/** Contract drift is an explicit error, not a wrong panel: the operator sees it. */
function failure(error: unknown): Response {
  const kind =
    error instanceof RalphContractError ||
    error instanceof DashboardConfigError ||
    error instanceof JavError ||
    error instanceof ProjectRegistryError
      ? error.name
      : "error";
  const message = error instanceof Error ? error.message : String(error);
  return json({ error: kind, message }, 500);
}

/**
 * The same request at another path. A body is buffered rather than passed as
 * a stream: every write route takes a small JSON body, and a stream body would
 * need `duplex` on some runtimes.
 */
async function rewritten(request: Request, pathname: string): Promise<Request> {
  const url = new URL(request.url);
  url.pathname = pathname;
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
    ...(hasBody ? { body: await request.arrayBuffer() } : {}),
  });
}

const notFoundPage = (why: string): Response =>
  new Response(`<!doctype html><title>Not found</title><p>${why.replace(/[<&>]/g, "")}</p>`, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });

export function createHandler({
  projects,
  adapter,
  usage,
  shell,
  assets = new Map(),
  hosts = new Set<string>(),
  agents,
  registry,
  ...shared
}: HandlerOptions): (request: Request) => Promise<Response> {
  const scopes =
    projects ??
    (() => {
      if (adapter === undefined) return [];
      return [{ project: IMPLICIT_PROJECT, adapter, ...(usage === undefined ? {} : { usage }) }];
    });
  // The projects as of the latest request, for the account's plan.
  let current: readonly ProjectScope[] = [];
  const accountFor = async (
    self: ProjectScope,
    own: PlanUsageView | null,
    ownSpend: OwnSpend | undefined,
  ): Promise<AccountUsageView> => {
    type Read =
      | { project: string; plan: PlanUsageView | null; spend: SpendWindows | null; daily: DailySpendView[] }
      | { project: string; why: string }
      | null;
    const reads = await Promise.all(
      current.map(async (scope): Promise<Read> => {
        const project = scope.project.id;
        // A report without spend (a partial reader) adds nothing rather than failing the route.
        if (scope === self) return { project, plan: own, spend: ownSpend?.spend ?? null, daily: ownSpend?.daily ?? [] };
        if (scope.plan === undefined && scope.spend === undefined) return null;
        try {
          const [plan, spend] = await Promise.all([scope.plan?.() ?? null, scope.spend?.() ?? null]);
          return { project, plan, spend: spend?.spend ?? null, daily: spend?.daily ?? [] };
        } catch (error) {
          return { project, why: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    const readings = reads.flatMap((read) => (read !== null && "plan" in read ? [read] : []));
    const unread = reads.flatMap((read) => (read !== null && "why" in read ? [read] : []));
    const projectSpend = readings.flatMap(({ project, spend }) => (spend === null ? [] : [{ project, spend }]));
    return {
      scope: "all-projects",
      plan: accountPlan(readings),
      projects: readings.map((read) => read.project),
      unread,
      spend: sumSpend(projectSpend.map((entry) => entry.spend)),
      projectSpend,
      daily: mergeDaily(readings.map((read) => read.daily)),
    };
  };
  // One handler per scope object: its adapter's in-flight read and caches are
  // reused for as long as the registry hands back the same scope.
  const handlers = new WeakMap<ProjectScope, (request: Request) => Promise<Response>>();
  // One gate runner for the whole server, not one per project handler: a
  // handler is rebuilt when the registry hands back a new scope, and a run in
  // flight must still refuse a second start. Keys (each project's checkout)
  // keep the projects apart.
  const gates = createGateRunner();
  // One snapshot hub per project scope, however many pages stream it. Kept
  // here, outside the per-scope handlers, so a request that finds a scope gone
  // from the registry can close its hub and end its streams.
  const hubs = new Map<ProjectScope, SnapshotHub>();
  // Each scope's fresh snapshot read, registered by its handler when built.
  const freshReads = new WeakMap<ProjectScope, () => Promise<Dashboard>>();
  const hubFor = (scope: ProjectScope): SnapshotHub => {
    const existing = hubs.get(scope);
    if (existing !== undefined) return existing;
    const { heartbeatMs: _heartbeat, ...tuning } = shared.snapshotStream ?? {};
    const producer = scope.healthProducer;
    const hub = createSnapshotHub({
      ...tuning,
      // Resolved lazily: a hub made for another project's stream may exist
      // before any request to this project built its handler. The hub runs
      // it only for a full subscriber, i.e. this project's own stream.
      compute: async () => {
        handlerFor(scope);
        const fresh = freshReads.get(scope);
        if (fresh === undefined) throw new Error(`no snapshot read for project '${scope.project.id}'`);
        return fresh();
      },
      ...(producer === undefined
        ? {}
        : { producers: { [HEALTH_KEY]: { ...producer, targets: producer.targets ?? snapshotWatchDirs } } }),
      // The hub's own fallback tick asks too, so a project removed while
      // no request comes in still ends its streams. An unreadable registry
      // is not a removal.
      registered: async () => {
        try {
          return (await scopes()).includes(scope);
        } catch {
          return true;
        }
      },
    });
    hubs.set(scope, hub);
    // Forgotten once closed, so a later stream request makes a fresh one.
    hub.onClose(() => {
      if (hubs.get(scope) === hub) hubs.delete(scope);
    });
    return hub;
  };
  // A project's stream: its own hub in full, and every other registered
  // project's hub for its health alone, so the switcher's health refreshes
  // within a second. Projects registered after the stream opened are not
  // picked up; the page's reconnect does that.
  const streamFor =
    (scope: ProjectScope) =>
    (signal: AbortSignal): Response => {
      const own = hubFor(scope);
      const forwards: StreamForward[] = [];
      for (const other of current) {
        if (other === scope || other.healthProducer === undefined) continue;
        try {
          forwards.push({ hub: hubFor(other), keys: [HEALTH_KEY] });
        } catch {
          // Another project's hub that cannot be made costs its live health only.
        }
      }
      return streamResponse(own, signal, shared.snapshotStream?.heartbeatMs, forwards);
    };
  const handlerFor = (scope: ProjectScope) => {
    let handler = handlers.get(scope);
    if (handler === undefined) {
      handler = createProjectHandler({
        ...shared,
        adapter: scope.adapter,
        project: scope.project,
        gates,
        snapshotSource: (compute) => freshReads.set(scope, compute),
        stream: streamFor(scope),
        ...(scope.usage === undefined ? {} : { usage: scope.usage }),
        ...(scope.lineup === undefined ? {} : { lineup: scope.lineup }),
        ...(scope.jav === undefined ? {} : { jav: scope.jav }),
        ...(scope.intake === undefined ? {} : { intake: scope.intake }),
        ...(scope.sleep === undefined ? {} : { sleep: scope.sleep }),
        ...(scope.claudeAccounts === undefined ? {} : { claudeAccounts: scope.claudeAccounts }),
        ...(scope.learningsFile === undefined ? {} : { learningsFile: scope.learningsFile }),
        ...(scope.evals === undefined ? {} : { evals: scope.evals }),
        ...(agents === undefined ? {} : { agents: () => agents(scope.project) }),
        // The `adapter` shorthand has no registry entry for a folder to be written to.
        ...(registry === undefined || projects === undefined ? {} : { registry }),
        // The `adapter` shorthand observes one project with no registry: its
        // plan is its own, and there is no account to speak for.
        ...(projects === undefined ? {} : { account: (own: PlanUsageView | null, ownSpend: OwnSpend | undefined) => accountFor(scope, own, ownSpend) }),
      });
      handlers.set(scope, handler);
    }
    return handler;
  };
  const serveShell = (): Response =>
    new Response(shell, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });

  return async (request: Request): Promise<Response> => {
    // Request authenticity, before any route: the server has no login by
    // design (the machine's user is the operator), so these two checks are
    // what keeps another site's page — on this machine or any tailnet device —
    // from reading loop state or sending Stop now, a clone, or a setup PR.
    const host = request.headers.get("host") ?? hostFromUrl(request.url);
    if (!hostAllowed(host, hosts)) {
      // The name is the client's, so it is capped before it is printed: an 8K
      // header is not worth a journal line. The cap is the longest legal DNS
      // name, so a name the operator might really paste back is never clipped.
      const named = host === null ? "(no Host header)" : `Host '${host.slice(0, 253)}'`;
      console.error(`ralph-dashboard: refused a request with ${named} — add it to RALPH_DASHBOARD_HOSTS if it is yours`);
      const answer = host === null ? "a request that names no host" : `'${host.slice(0, 253)}'`;
      return json({ error: "UnknownHost", message: `this dashboard does not answer to ${answer}` }, 403);
    }
    if (request.method !== "GET" && request.method !== "HEAD" && !sameSiteWrite(request)) {
      // Named like the refusal above, because the operator debugging their own
      // page needs to see which of the two gates answered. The path only, never
      // the body: a write's body carries the loop's own command payload.
      console.error(`ralph-dashboard: refused a cross-site ${request.method} to ${new URL(request.url).pathname}`);
      return json({ error: "CrossOrigin", message: "a write must come from the dashboard's own page" }, 403);
    }
    const url = new URL(request.url);
    const { pathname } = url;
    let registered: readonly ProjectScope[];
    try {
      registered = await scopes();
    } catch (error) {
      return failure(error);
    }
    current = registered;
    // A removed project's streams end with it.
    for (const [scope, hub] of hubs) if (!registered.includes(scope)) hub.close();
    const find = (id: string) => registered.find((scope) => scope.project.id === id);

    if (agents !== undefined && registry !== undefined) {
      const routed = await handleProjectRemoval(request, pathname, {
        projects: async () => registered.map((scope) => scope.project.id),
        registry,
        agents: (id) => agents(find(id)!.project),
      });
      if (routed !== null) return routed;
    }
    if (shared.onboarding !== undefined) {
      try {
        const routed = await handleProjectsRoute(request, pathname, shared.onboarding);
        if (routed !== null) return routed;
      } catch (error) {
        return failure(error);
      }
    }
    if (pathname === PROJECTS_HEALTH_PATH) {
      if (request.method !== "GET") return getOnly();
      // The selected project is left out: the page already polls its full snapshot.
      const selected = url.searchParams.get("selected");
      const others = registered.filter((scope) => scope.project.id !== selected && scope.health !== undefined);
      const health = await Promise.all(
        others.map((scope) =>
          scope.health!().catch((error: unknown) =>
            unknownHealth(scope.project.id, new Date().toISOString(), error instanceof Error ? error.message : String(error)),
          ),
        ),
      );
      return json({ selected, projects: health } satisfies ProjectsHealthView);
    }
    if (pathname === "/api/projects") {
      if (request.method !== "GET") return getOnly();
      return json({ projects: registered.map((scope) => scope.project) });
    }

    const api = SCOPED_API_PATH.exec(pathname);
    if (api !== null) {
      const id = decodeURIComponent(api[1]!);
      const scope = find(id);
      if (scope === undefined) return json({ error: "UnknownProject", message: `no project '${id}'` }, 404);
      return handlerFor(scope)(await rewritten(request, `/api${api[2] ?? ""}`));
    }
    // An unscoped API path is the first project's, so existing callers keep working.
    if (pathname.startsWith("/api/")) {
      const first = registered[0];
      if (first === undefined) return json({ error: "UnknownProject", message: "no project is registered" }, 404);
      return handlerFor(first)(request);
    }

    if (request.method !== "GET") {
      return getOnly();
    }
    const page = SCOPED_PAGE_PATH.exec(pathname);
    if (page !== null) {
      const id = decodeURIComponent(page[1]!);
      if (find(id) === undefined) return notFoundPage(`No project '${id}' is registered.`);
      return isShellPath(page[2] ?? "/") ? serveShell() : notFoundPage("No such page.");
    }
    // `/` is the shell, which opens the last project used (remembered client-side);
    // the All projects floor is the shell too, belonging to no one project.
    if (isTopLevelPage(pathname)) return serveShell();
    if (isShellPath(pathname)) {
      const first = registered[0];
      if (first === undefined) return serveShell();
      return new Response(null, {
        status: 302,
        headers: { location: `/p/${encodeURIComponent(first.project.id)}${pathname}${url.search}`, "cache-control": "no-store" },
      });
    }
    const asset = assets.get(pathname);
    if (asset !== undefined) {
      // Names are content-hashed by the build, so a served asset never goes stale.
      return new Response(asset.body, {
        status: 200,
        headers: { "content-type": asset.type, "cache-control": "public, max-age=31536000, immutable" },
      });
    }
    return json({ error: "not found" }, 404);
  };
}

async function main(): Promise<void> {
  const config = configFromEnv(process.env, { cliDir: RALPH_HOME, root: projectRoot() });
  const registry = createProjectRegistry({
    file: projectsFile(process.env),
    seed: config.roots,
    override: config.rootsOverride ? config.roots : null,
  });
  // One shared executor per timeout surface, built the first time the
  // composition asks for it. Which surface waits how long is `compose.ts`'s
  // to say; this only builds what it asks for.
  const executors = new Map<number | undefined, ReturnType<typeof createProcessExecutor>>();
  // The lineup editor edits the harness's own `models.json` unless
  // `RALPH_LINEUP_ROOTS` points it at another checkout's.
  const lineupConfig = lineupConfigFromEnv(process.env, { cliDir: RALPH_HOME, root: RALPH_HOME });
  const lineup = createLineupAdapter({
    cliDir: lineupConfig.cliDir,
    roots: lineupConfig.roots,
    ...(lineupConfig.bunPath === undefined ? {} : { bunPath: lineupConfig.bunPath }),
  });
  // Asking the harnesses takes seconds; warm the answer so the first form
  // opens with its pickers filled rather than waiting on it.
  lineup.catalog().catch(() => undefined);
  const shell = await buildShell();
  // Read before the page is served, so the page computes each loop's next
  // retry on the very schedule the reconciler below runs.
  const reconciling = reconcileConfigFromEnv(process.env, (line) => console.error(line));
  const composed = composeServer({
    config,
    registry,
    shell,
    harness: RALPH_HOME,
    reconciling,
    lineup,
    executor: (timeoutMs) => {
      const built = executors.get(timeoutMs) ?? createProcessExecutor(timeoutMs === undefined ? {} : { timeoutMs });
      executors.set(timeoutMs, built);
      return built;
    },
    ralphAdapter: createRalphAdapter,
    factories: processFactories,
  });
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    // A restart answers only once the old supervisor has reached its iteration
    // boundary and exited, which can take minutes. The longest idle timeout
    // Bun allows means that wait is never mistaken for an idle connection.
    idleTimeout: 255,
    fetch: composed.fetch,
  });
  console.log(`ralph-dashboard listening on http://${server.hostname}:${server.port}`);
  // The reconciler and the migration watchdog run once at startup and then on
  // a timer (#329). The handle is deliberately dropped: the schedule ends with
  // the process, and nothing but the process may stop it.
  // The watchdog rides the reconciler's timer, so it follows its off switch:
  // with the interval at 0 neither runs.
  if (reconciling.intervalMs === 0) {
    console.error(
      `ralph-dashboard: ${RECONCILE_ENV.interval}=0 — the loop reconciler is off, and the migration watchdog with it; a loop whose supervisor dies stays down`,
    );
  } else {
    schedule(
      async () => {
        await composed.reconcile();
        await composed.watchMigrations();
      },
      { intervalMs: reconciling.intervalMs, log: (line) => console.error(line) },
    );
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`ralph-dashboard: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
