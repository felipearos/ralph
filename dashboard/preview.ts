/**
 * A design preview of the dashboard: the real React shell over fake loops.
 *
 * `bun run dashboard:preview` serves the UI on its own port (8792 by default)
 * next to a running dashboard, never touching a loop. It rebuilds the shell
 * whenever a file under `ui/` changes and the open page reloads itself, so a
 * layout change shows up in the browser without restarting anything.
 * `RALPH_PREVIEW_WATCH=0` skips that rebuild: `dashboard:dev` sets it on the
 * preview it starts, where Vite's hot module replacement does the job.
 *
 * The loops are a canned runtime snapshot, rebuilt on every request so its
 * timestamps stay relative to it and the page always looks live. The loop
 * reads (`/api/loops`, a loop's panel, ownership, frontier) are answered by
 * the real server, composed over that snapshot with no process behind it, so
 * every panel is what `aggregateDashboard` derives. The control buttons act
 * on an in-memory copy of the snapshot's facts. The lineup editor reads the
 * harness's real `models.json`, but a save only validates: it never writes.
 *
 * It serves several canned projects, so the project rail and the CI health
 * page can be clicked through over different shapes: "preview", the gallery
 * of every panel state and the default, and the scenarios in
 * `preview-projects.ts`. Each project's routes answer its own snapshot and
 * its commands act on its own loops.
 *
 * `createPreviewRouter` is the request handler on its own, so a test can call
 * it in-process; building, watching and serving happen only when this file
 * is run, never when it is imported.
 */
import { noIssueYet } from "../learnings";
import { githubAnchor } from "./learnings";
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildShell, type Shell } from "./build";
import { foldCiHealth } from "./ci-health";
import type {
  CheckoutReport,
  CiHealthRead,
  LearningEntryView,
  LearningsRead,
  ControlCommand,
  ControlResult,
  ControlsView,
  ControlView,
  Dashboard,
  DoctorCheckView,
  DoctorHistoryEntry,
  DoctorStepView,
  DoctorView,
  FrontierRead,
  Iteration,
  JournalEntryView,
  Liveness,
  LocalSnapshot,
  LoopEvent,
  LoopRole,
  LoopStatus,
  PresenceView,
  ProjectSetupView,
  ProjectSleepView,
  ProjectHealthView,
  ProjectsHealthView,
  ProjectsView,
  ProjectView,
  RestartResult,
  ResumeWorkResult,
  RunnerFailureView,
  RuntimeLoop,
  RuntimeSnapshot,
  Stage,
  StopReason,
  StartResult,
  StopNowResult,
  ProjectUsageReport,
  DailySpendView,
  MachineSpendView,
  TaskCostView,
  UsageBarView,
  UsageReport,
} from "./contracts";
import { PHASES, type Phase } from "./contracts";
import { composeServer, type ServerDeps } from "./compose";
import { ONBOARDING_SURFACE } from "./onboarding-adapter";
import type { ProjectEntry } from "./projects";
import { createLineupAdapter } from "../lineup/adapter";
import { createHandler as createLineupHandler } from "../lineup/server";
import { outputResponse, type Emit, type Follower } from "./iteration-output";
import { createPreviewChat } from "./preview-chat";
import { previewProjects, type PreviewKit } from "./preview-projects";
import { projectHealth, type HealthLoop } from "./health";
import { isShellPath, OUTPUT_PATH, SCOPED_API_PATH, SCOPED_PAGE_PATH } from "./routes";
import { isLineupPath } from "./server";
import type { RecordsAdapter } from "./records-adapter";
import { handleRecordsRoute, isRecordsPath } from "./records-routes";
import type { ProjectSleepAdapter } from "./project-sleep-adapter";
import { handleProjectSleepRoute } from "./project-sleep-routes";
import { handleLearningsFileRoute } from "./learnings-file-routes";
import { RALPH_HOME } from "../paths";
import { ControlRouteError, readBody, type DispatchRequest } from "./command-requests";
import { matchRoute, type RouteRow } from "./route-table";
import { createSnapshotHub, streamResponse, type SnapshotHub } from "./snapshot-stream";

const PORT = Number(process.env.RALPH_PREVIEW_PORT ?? 8792);
/**
 * `RALPH_PREVIEW_SETUP=1` shows the project as not set up yet, so the setup
 * form and its Tracker connector (#338) can be looked at. The connector's
 * test answers as a Linear workspace would; nothing is saved or opened.
 */
const SETUP_PREVIEW = process.env.RALPH_PREVIEW_SETUP === "1";

function previewSetup(project: string, pathname: string, method: string): Response | null {
  if (pathname === "/api/setup" && method === "GET") {
    return json({ project, status: "needs-setup", baseBranch: "main", pr: null } satisfies ProjectSetupView);
  }
  if (pathname === "/api/setup/defaults") {
    return json({
      config: {
        repo: "acme/backoffice",
        owner: "acme-bot",
        baseBranch: "main",
        displayName: "Backoffice",
        secrets: { runner: "none", withhold: [] },
        refuseFiles: [],
        envCheck: [],
        requiredChecks: ["test"],
        gates: { test: "npm test" },
        promptFragment: ".ralph/prompt.md",
        coderFragment: ".ralph/coder.md",
        plan: ".ralph/plan.md",
        journal: { dir: "journal/backoffice" },
        loops: ["ralph"],
      },
    });
  }
  if (pathname === "/api/setup/validate") return json({ valid: true, problems: [] });
  if (pathname === "/api/setup/tracker/test") {
    return json({
      ok: true,
      kind: "linear",
      user: "preview",
      workspace: "acme",
      options: [
        { key: "AND", name: "Example" },
        { key: "OPS", name: "Operations" },
      ],
      states: ["Backlog", "Todo", "In Progress", "For Review", "Done", "Canceled"],
      labels: ["ready-for-agent", "spec", "acme-backoffice", "acme-pwa"],
    });
  }
  if (pathname === "/api/setup/tracker/save") return json({ saved: true });
  return null;
}
// Localhost by default; set it to e.g. the Tailscale IP to open the preview from another machine.
const HOST = process.env.RALPH_PREVIEW_HOST ?? "127.0.0.1";
const UI_DIR = fileURLToPath(new URL("./ui/", import.meta.url));

/* ---------------------------------------------------------------- fake data */

const ago = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString();

export type FeedRow = [secondsAgo: number, stage: string, label: string, iteration?: number];

/**
 * A timeline feed, oldest first as `observe` returns it. Labels follow the
 * shapes `activitiesFor` in timeline.ts produces for each runner's events.
 */
function feed(loop: string, rows: FeedRow[]): PresenceView["recent"] {
  return rows
    .map(([seconds, stage, label, iteration = 4]) => ({ stage, label, at: ago(seconds), iteration, run: `run-${loop}-01` }))
    .sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0));
}

const LONG_TEXT =
  "The spec asks for start, pause, resume, stop, approve and deny on the loop page. All six are wired and each one reports the recorded outcome rather than assuming the command landed; the one gap is that a stop issued while the supervisor is between polls shows as pending until the next heartbeat, which matches…";

/** Running, mid-review: more than 20 rows so the page's cap shows, rate limits, a failed and a degraded stage. */
const RUNNING_FEED: FeedRow[] = [
  [1500, "orchestrator", "stage completed · claude", 3],
  [1260, "orchestrator", "system — init"],
  [1250, "orchestrator", "stage started · claude"],
  [1240, "orchestrator", "rate limit allowed"],
  [1230, "orchestrator", "thinking — Issue #975 wants loop controls on the dashboard; the executor already landed them, so this pass is verify and fix."],
  [560, "orchestrator", "tool result ok — Implementation done. 4 files changed, 212 insertions(+), 31 deletions(-)"],
  [520, "orchestrator", "tool Agent — Review against the repo's coding standards"],
  [500, "review.standards", "stage started · opencode"],
  [490, "review.standards", "tool read — /home/dev/worktrees/rafa/CLAUDE.md"],
  [470, "review.standards", "tool bash error — pnpm: command not found"],
  [460, "review.standards", "text — Switching to bun for the lint run."],
  [330, "review.standards", "rate limit rejected"],
  [320, "review.standards", "rate limit rejected"],
  [310, "review.standards", "rate limit rejected"],
  [300, "review.standards", "stage failed · opencode"],
  [290, "orchestrator", "tool result error — review.standards failed: provider returned 429 after 3 retries"],
  [280, "orchestrator", "rate limit allowed_warning"],
  [270, "orchestrator", "system — compact_boundary"],
  [250, "orchestrator", "text — The standards review hit a rate limit; retrying it after the spec review."],
  [240, "orchestrator", "tool Agent — Review against the issue's requirements"],
  [235, "review.spec", "stage started · claude"],
  [220, "review.spec", "rate limit overage"],
  [200, "review.spec", "tool Read — dashboard/ui/app.tsx"],
  [180, "review.spec", "stage degraded · claude"],
  [170, "review.spec", `text — ${LONG_TEXT}`],
  [120, "review.spec", "stage completed · claude"],
  [90, "orchestrator", 'tool TodoWrite — [{"content":"Re-run review.standards","status":"in_progress"}]'],
  [60, "orchestrator", "rate limit unknown"],
  [20, "orchestrator", "tool ExitPlanMode"],
  [12, "orchestrator", "tool Bash — bun test"],
  [8, "orchestrator", "tool result ok — 118 pass, 0 fail"],
];

/** Held on a gate: a claude mapper, a codex executor, both reviews passing, then the PR. */
const GATE_FEED: FeedRow[] = [
  [3000, "orchestrator", "system — init"],
  [2990, "orchestrator", "stage started · claude"],
  [2980, "orchestrator", "tool Agent — Map the relevant code for issue #961"],
  [2970, "mapper", "stage started · claude"],
  [2960, "mapper", "tool Grep — catalog"],
  [2950, "mapper", "tool Read — lineup/adapter.ts"],
  [2940, "mapper", "tool Read — lineup/adapter.ts"],
  [2900, "mapper", "text — The catalogue is read in lineup/adapter.ts and cached per runner."],
  [2890, "mapper", "stage completed · claude"],
  [2800, "executor", "stage started · codex"],
  [2790, "executor", "tool reasoning"],
  [2780, "executor", 'tool bash — rg -n "catalog" lineup dashboard'],
  [2600, "executor", "tool file_change"],
  [2590, "executor", "tool file_change"],
  [2580, "executor", "tool file_change"],
  [2400, "executor", "text — Added the harness catalogue with a per-runner cache and tests; 96 pass."],
  [2390, "executor", "stage completed · codex"],
  [1800, "review.standards", "stage completed · claude"],
  [1500, "review.spec", "stage completed · claude"],
  [900, "orchestrator", "tool Bash — gh pr create --fill"],
  [880, "orchestrator", "tool result ok — https://github.com/felipearos/ralph/pull/26"],
  [430, "orchestrator", "text — PR #26 is green; waiting for approval to merge it into main."],
];

/** Blocked: an opencode executor that errors out and a gate that fails. */
const BLOCKED_FEED: FeedRow[] = [
  [5400, "executor", "stage started · opencode", 7],
  [5350, "executor", "tool edit — dashboard/server.ts", 7],
  [5300, "executor", "tool bash — bun test dashboard/server.test.ts", 7],
  [5200, "executor", "tool bash error — Exit code 1: 1 fail, 41 pass", 7],
  [5100, "executor", "text — The failing case expects a 409 when a second stop arrives; fixing the handler.", 7],
  [4800, "executor", "stage degraded · opencode", 7],
  [4700, "executor", "stage failed · opencode", 7],
  [4600, "orchestrator", "rate limit rejected", 7],
  [4500, "orchestrator", "tool Bash — bunx vitest run dashboard/server.test.ts", 7],
  [
    4400,
    "orchestrator",
    "tool result error — FAIL dashboard/server.test.ts > control > refuses a second stop: expected 409, received 200 at Object.<anonymous> (dashboard/server.test.ts:212:31)",
    7,
  ],
  [4000, "orchestrator", "invalid event", 7],
  [3900, "orchestrator", "system — ", 7],
  [3650, "orchestrator", "stage failed · claude", 7],
];

/** What the control buttons change about a loop's record; the rest of it is canned. */
export interface LoopFacts {
  loopStatus: LoopStatus;
  supervisor: Liveness;
  stage: Stage;
  stopReason: StopReason | null;
}

/** One loop as its record, observe and its ledgers would report it, stamped for one read. */
export interface CannedLoop extends LoopFacts {
  iteration: Iteration;
  phase: Phase | null;
  heartbeat: string;
  lastEvent: LoopEvent;
  presence: PresenceView;
  runnerFailures: RunnerFailureView[];
}

/**
 * A preview loop: runtime facts, never a drawn panel. Every read turns these
 * into a `RuntimeLoop` and the real `aggregateDashboard` draws the panel, so
 * the preview cannot show a state the aggregate would not derive.
 */
export interface FakeLoop {
  name: string;
  role: LoopRole;
  /** Its checkout, under the project's worktrees folder. */
  worktree: string;
  control: ControlView;
  /** Rebuilt on every read, so the timestamps stay relative to the request. */
  canned: () => CannedLoop;
  /** What a command has changed since the preview started, laid over `canned`. */
  facts: Partial<LoopFacts>;
  /** The issues this loop holds a lease and a claim label on; abandon and release drop one. */
  claims: number[];
}

/** A control view with nothing recorded but what is passed in. */
function controlView(loop: string, over: Partial<ControlView> = {}): ControlView {
  return {
    loop,
    generatedAt: new Date().toISOString(),
    present: true,
    worktree: `/home/dev/worktrees/${loop}`,
    run: `run-${loop}-01`,
    loopStatus: "running",
    status: "clear",
    channel: { state: "ok", why: null, since: null, retryAt: null },
    hold: null,
    blocked: null,
    stop: null,
    commands: [],
    pendingApprovals: [],
    gates: [],
    deferrals: [],
    givenUp: [],
    ...over,
  };
}

function presence(
  loop: string,
  overrides: Partial<PresenceView> & Pick<PresenceView, "status" | "supervisor">,
): PresenceView {
  return {
    loop,
    run: `run-${loop}-01`,
    issue: 975,
    branch: "detached 468f4603",
    iteration: { index: 4, max: 50 },
    observedAt: ago(2),
    issues: [
      { issue: 975, state: "active", pr: null, draft: false, title: "Dashboard loop controls", detail: null, block: null, at: ago(900) },
      { issue: 961, state: "merged", pr: 24, draft: false, title: "Lineup catalog", detail: null, block: null, at: ago(7200) },
      { issue: 958, state: "handoff", pr: null, draft: false, title: "Flaky gate on CI", detail: "needs a human", block: null, at: ago(14400) },
      { issue: 955, state: "pr", pr: 23, draft: false, title: "Observer stage labels", detail: null, block: null, at: ago(18000) },
      { issue: 950, state: "blocked", pr: null, draft: false, title: "Migrate state records", detail: "waiting on #948", block: "other", at: ago(21600) },
      { issue: 947, state: "blocked", pr: 22, draft: true, title: "Streaming region", detail: "needs-migration", block: "migration", at: ago(25200) },
      { issue: 944, state: "failed", pr: 21, draft: true, title: "Parallel executors", detail: "gate failed 3 times", block: null, at: ago(28800) },
    ],
    actors: [
      {
        stage: "orchestrator",
        state: "running",
        invocation: "inv-1",
        runner: "claude",
        model: "claude-opus-5",
        startedAt: ago(1200),
        endedAt: null,
        lastAction: "running tests",
        activityAt: ago(8),
      },
      {
        stage: "executor",
        state: "completed",
        invocation: "inv-2",
        runner: "codex",
        model: "gpt-5-codex",
        startedAt: ago(1100),
        endedAt: ago(600),
        lastAction: "wrote dashboard/ui/app.tsx",
        activityAt: ago(600),
      },
      {
        stage: "review.standards",
        state: "failed",
        invocation: "inv-3",
        runner: "claude",
        model: "claude-sonnet-5",
        startedAt: ago(500),
        endedAt: ago(300),
        lastAction: "rate limited",
        activityAt: ago(300),
      },
    ],
    recent: feed(loop, RUNNING_FEED),
    failureReason: null,
    step: { stage: "orchestrator", action: "running tests" },
    phase: { index: 4, total: 5, label: "Verify and fix" },
    warning: "rate limited, retrying",
    ...overrides,
  };
}

const BRANCH = "detached 468f4603";
const worktreeOf = (loop: string): string => `/home/dev/worktrees/${loop}`;
const runOf = (loop: string): string => `run-${loop}-01`;

/** A running coder mid-iteration, with whatever the loop's own entry overrides. */
function cannedLoop(over: Partial<CannedLoop> & Pick<CannedLoop, "presence">): CannedLoop {
  return {
    loopStatus: "running",
    supervisor: "alive",
    stage: "iteration",
    stopReason: null,
    iteration: { index: 4, max: 50 },
    phase: "implement",
    heartbeat: ago(5),
    lastEvent: { name: "iteration.started", at: ago(1200) },
    runnerFailures: [],
    ...over,
  };
}

/** The canned loop with the commands applied: what a read reports now. */
const current = (entry: FakeLoop): CannedLoop => ({ ...entry.canned(), ...entry.facts });

/** The worktree as the adapter would report it, from the loop's facts. */
function runtimeLoop(entry: FakeLoop, journal: JournalEntryView[], repoUrl: string): RuntimeLoop {
  const loop = entry.name;
  const now = current(entry);
  const run = runOf(loop);
  const worktree = entry.worktree;
  return {
    worktree,
    identity: loop,
    loopStatus: now.loopStatus,
    worktreeStatus: "live",
    branch: BRANCH,
    state: {
      version: 1,
      run,
      owner: { loop, pid: 1732290, host: "desktop" },
      worktree,
      branch: BRANCH,
      stage: now.stage,
      iteration: now.iteration,
      heartbeat: now.heartbeat,
      lastEvent: now.lastEvent,
      stopReason: now.stopReason,
      ...(now.phase === null ? {} : { phase: now.phase }),
    },
    stateProblem: null,
    supervisor: now.supervisor,
    presence: now.presence,
    repoUrl,
    usage: {
      session: `session-${loop}`,
      runId: run,
      iteration: {
        turns: 42,
        elapsedSeconds: 1180,
        usage: { input: 2_100, output: 38_000, cache5m: 90_000, cache1h: 0, cacheRead: 2_400_000, inputTotal: 2_492_100 },
        models: [],
      },
      run: {
        steps: 9,
        usage: { input: 9_800, output: 210_000, cache5m: 400_000, cache1h: 0, cacheRead: 11_000_000, inputTotal: 11_409_800 },
      },
      context: { model: "claude-opus-5", tokens: 118_000, window: 200_000, percent: 59 },
    },
    // The project's whole journal, as the adapter hands it to every worktree;
    // the aggregate keeps the entries each loop signs.
    journal,
    // The adapter reads apply ledgers only for a triager. Its units are not
    // here: the aggregate takes them from the journal entries the triager signs.
    triage: entry.role === "triager" ? { writesLastHour: 14, maxWrites: 30, units: [] } : null,
    runnerFailures: { settled: now.runnerFailures },
  };
}

/**
 * The triager's journal: one unit of every outcome that APPLIED something —
 * `gave up` included, because giving up leaves a marker comment. `all
 * blocked` and `retry later` are not units and never reach the panel.
 */
const TRIAGE_ENTRIES: [name: string, secondsAgo: number, issue: number, outcome: string, title: string][] = [
  ["2026-11-03-1131.md", 600, 1131, "routed (7 tickets)", "Routing batch"],
  ["2026-11-02-1120.md", 4200, 1120, "split into #1133, #1134", "Diary filters"],
  ["2026-11-01-1118.md", 9000, 1118, "triaged (needs-info)", "Crash on cold start"],
  ["2026-10-31-1104.md", 26000, 1104, "closed (duplicate of #1066)", "Media detail parity"],
  ["2026-10-30-1098.md", 51000, 1098, "gave up", "Unreadable bug report"],
];

/** The project's journal, every loop's entries signed by the loop that wrote them. */
function projectJournal(world: PreviewWorld): JournalEntryView[] {
  if (world.journal !== undefined) return world.journal();
  return [...world.loops.values()].flatMap(({ name: loop, role }): JournalEntryView[] =>
    role === "triager"
      ? TRIAGE_ENTRIES.map(([name, seconds, issue, outcome, title]) => ({ name, at: ago(seconds), issue, loop, title, outcome }))
      : [
          { name: "2026-09-15-961.md", at: ago(7200), issue: 961, loop, title: "Lineup catalog", outcome: "merged" },
          { name: "2026-09-14-958.md", at: ago(90_000), issue: 958, loop, title: "Flaky gate on CI", outcome: "handoff" },
        ],
  );
}

/**
 * A checkout holding a record another loop's name wrote — copied from a
 * machine where `rex` runs. Not in the roster, so the aggregate reports it
 * under unattributed rather than drawing a panel for it.
 */
function copiedRecord(): RuntimeLoop {
  const worktree = "/home/dev/worktrees/copied-record";
  return {
    worktree,
    identity: "rex",
    loopStatus: "unknown",
    worktreeStatus: "live",
    branch: null,
    state: {
      version: 1,
      run: "run-rex-01",
      owner: { loop: "rex", pid: null, host: "laptop" },
      worktree,
      branch: null,
      stage: "stopped",
      iteration: null,
      heartbeat: ago(86_400),
      lastEvent: null,
      stopReason: null,
    },
    stateProblem: "foreign",
    supervisor: "unknown",
    presence: null,
  };
}

/** The titles the claim labels' issues carry on GitHub. */
const CLAIM_TITLES: Record<number, string> = { 975: "Dashboard loop controls" };

/** The case key the gallery's ci-doctor holds a lease on. */
const HELD_KEY = "flake:src/media/detail.test.ts > renders providers";

/**
 * The gallery's ci-health STORE — the shape `ci-doctor/scan.ts` writes, not
 * the shape the panel reads.
 *
 * It is deliberately the raw store and not a folded `CiHealthView`: handing
 * the preview a pre-folded view would leave `foldCiHealth` — the reader every
 * live project goes through — joined to nothing, since no test compiles a
 * `.tsx`. `ciHealth()` below folds this with the real function, so a fold bug
 * that produced a correct-shaped but wrong view shows up in the served
 * snapshot.
 *
 * The folded view goes into the snapshot the composed server aggregates, so
 * the doctor's card takes its case off `held` exactly as a live project's does.
 *
 * It covers every section at once: a confirmed flake with a fix PR in hand and
 * a doctor's lease on it, a candidate nobody has confirmed, a main regression
 * that has cost main three reds, one open infra incident and one already
 * fixed (which must NOT appear under "open"), two tickets parked on a flake
 * (one unparked twice), the day's retry allowance spent, and a merged revert
 * with its forward fix.
 */
function ciHealthStore(now: string): unknown {
  const nowMs = Date.parse(now);
  // Relative to the `now` this was CALLED with, not to `Date.now()`: the fold
  // below computes its 24-hour window from the same instant, and two clocks a
  // few hundred milliseconds apart is a window that silently drops its oldest
  // build the day somebody passes a fixed `now`.
  const before = (seconds: number) => new Date(nowMs - seconds * 1000).toISOString();
  const minutesAfter = (at: string, minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();
  // Four red builds inside the 24-hour window, 5 to 11 minutes each, so the
  // median the lost-time estimate uses is a real median of a real sample.
  const reds = [
    { number: 24_117, startedAt: before(4800), minutes: 11 },
    { number: 24_109, startedAt: before(19_000), minutes: 7 },
    { number: 24_101, startedAt: before(42_000), minutes: 8 },
    { number: 24_094, startedAt: before(70_000), minutes: 5 },
  ];
  return {
    version: 1,
    cursor: now,
    jobsSeen: {},
    failures: [],
    builds: [
      ...reds.map((red) => ({
        number: red.number,
        branch: "main",
        commit: "9f2c1ab4e77d05c3b1c0a9e8f6d4b2a1c3e5f709",
        state: "failed",
        startedAt: red.startedAt,
        finishedAt: minutesAfter(red.startedAt, red.minutes),
        createdAt: red.startedAt,
      })),
      // A green build, to prove the median ignores it: a flake costs a re-run,
      // not the run CI would have made anyway.
      { number: 24_120, branch: "main", commit: "aaa", state: "passed", startedAt: before(900), finishedAt: before(780), createdAt: before(900) },
    ],
    cases: {
      [HELD_KEY]: {
        kind: "flake",
        state: "confirmed",
        evidence: reds.map((red) => ({ build: red.number, branch: "main", commit: "9f2c1ab", kind: "timeout", line: "Test timed out in 5000ms" })),
        cost72h: { redBuilds: 9, mainReds: 0, dequeues: 2 },
        issue: 1402,
        pr: 1407,
        fixAttempts: 1,
        unparks: {},
        rule: "timeout-only",
      },
      "regression:src/diary/export.test.ts > column headers": {
        kind: "regression",
        state: "filed",
        evidence: [{ build: 24_117, branch: "main", commit: "9f2c1ab", kind: "assertion", line: "expected 'Watched on' to be 'Date'" }],
        cost72h: { redBuilds: 4, mainReds: 3, dequeues: 1 },
        issue: 1399,
        pr: null,
        fixAttempts: 0,
        unparks: {},
        rule: "main-red-since",
      },
      "flake:src/log/sheet.test.ts > autocompletes tags": {
        kind: "flake",
        state: "candidate",
        evidence: [{ build: 24_109, branch: "rulo/1081-tags", commit: "bbb", kind: "timeout", line: "Test timed out in 5000ms" }],
        cost72h: { redBuilds: 2, mainReds: 0, dequeues: 0 },
        issue: null,
        pr: null,
        fixAttempts: 0,
        unparks: {},
      },
      "infra:agent lost communication": {
        kind: "infra",
        state: "confirmed",
        evidence: [{ build: 24_101, branch: "main", commit: "ccc", kind: "bootstrap", line: "agent lost communication" }],
        cost72h: { redBuilds: 5, mainReds: 1, dequeues: 0 },
        issue: null,
        pr: null,
        fixAttempts: 0,
        unparks: {},
        rule: "infra-signature",
        notified: "ci-incident:agent-lost",
      },
      // Fixed, and so NOT an open incident: the scan keeps a managed case for
      // ever (`ci-doctor/classify.ts:49 MANAGED_STATES`), and the panel must
      // not head it "open".
      "infra:docker pull rate limit": {
        kind: "infra",
        state: "fixed",
        evidence: [{ build: 23_880, branch: "main", commit: "ddd", kind: "bootstrap", line: "toomanyrequests" }],
        cost72h: { redBuilds: 0, mainReds: 0, dequeues: 0 },
        issue: null,
        pr: null,
        fixAttempts: 1,
        unparks: {},
      },
      "parked:1109": {
        kind: "parked",
        state: "handed-off",
        evidence: [],
        cost72h: { redBuilds: 0, mainReds: 0, dequeues: 0 },
        issue: 1109,
        pr: 1276,
        fixAttempts: 0,
        rule: HELD_KEY,
        unparks: { [HELD_KEY]: [before(97_000), before(3600)] },
      },
      "parked:1131": {
        kind: "parked",
        state: "confirmed",
        evidence: [],
        cost72h: { redBuilds: 0, mainReds: 0, dequeues: 0 },
        issue: 1131,
        pr: null,
        fixAttempts: 0,
        rule: "flake:src/log/sheet.test.ts > autocompletes tags",
        unparks: {},
      },
    },
    main: { state: "red", since: before(4800), build: 24_117 },
    leases: {
      [HELD_KEY]: { run: "run-doc-01", loop: "doc", pid: 7721, host: "desktop", expiresAt: new Date(nowMs + 90_000).toISOString() },
    },
    retries: { day: new Date(nowMs).toISOString().slice(0, 10), count: 6, byCase: { [HELD_KEY]: "0192ab" } },
    reverts: {
      "9f2c1ab4e77d05c3b1c0a9e8f6d4b2a1c3e5f709": {
        case: "regression:src/diary/export.test.ts > column headers",
        issue: 1399,
        pr: 1401,
        forwardIssue: 1400,
        state: "merged",
      },
    },
    // A fortnight of the doctor's own success measure, so the gallery shows
    // the trend with a shape rather than a flat line: flake reds falling as
    // cases get filed, and a parked peak in the middle of it.
    metrics: Object.fromEntries(
      [11, 9, 7, 6, 5, 5, 4, 3, 3, 2, 2, 1, 1, 0].map((reds, back) => [
        new Date(nowMs - back * 86_400_000).toISOString().slice(0, 10),
        { knownFlakeReds: reds, parkedOnFlake: back > 3 && back < 9 ? 7 - Math.abs(6 - back) : 0 },
      ]),
    ),
    backfill: null,
  };
}

/**
 * The open learnings, as a project that has been running a while would have
 * them: a couple of its own and a couple of the harness's, with the harness
 * repository's real blob base so the links in the preview go somewhere.
 */
function learnings(): LearningsRead {
  return {
    base: "https://github.com/felipearos/ralph/blob/main",
    sources: [
      {
        scope: "project",
        file: "learnings/loggd.md",
        entries: [
          previewLearning({
            slug: "prod-ledger-ahead-of-main",
            title: "Production migration ledger red on every branch while a migration PR waits to merge",
            date: "2026-10-16",
            seen: "two hand applies to prod, each made before its PR merged, deadlocked the required `production-migrations` job.",
            workaround: "if the only red job is `production-migrations` and your diff leaves `drizzle/` untouched, it is not yours. Do NOT renumber migrations.",
            fix: "operator side, no issue yet. Apply a migration to prod only right before merging its PR.",
            seenAgain: ["2026-10-16", "2026-10-18", "2026-10-20", "2026-10-22"],
          }),
          previewLearning({
            slug: "loggd-backlog-human-gated",
            title: "The loggd backlog is drained to human-gated tickets",
            date: "2026-10-08",
            seen: "`frontier/next.ts --take-one` returned `ticket: null` with no obstructions.",
            workaround: "none for a loop — `ALL_BLOCKED` is the only correct ending.",
            fix: "https://github.com/felipearos/loggd/issues/2818",
            seenAgain: ["2026-10-15"],
          }),
          previewLearning({ slug: null, title: "CI is sensitive to host load", seen: "full suites time out at load of about 40 on 16 cores." }),
        ],
        fixed: [{ problem: "Vercel stopped posting its required status on PRs", fixedBy: "#2854" }],
        present: true,
      },
      {
        scope: "harness",
        file: "learnings/harness.md",
        entries: [
          previewLearning({
            slug: "await-pr-given-issue-number",
            title: "AWAIT_PR handed back the issue number, so the supervisor waited on a PR that does not exist",
            date: "2026-10-22",
            seen: "the session that opened PR #2768 ended with `AWAIT_PR 2694 ci`, the issue number.",
            workaround: "read the PR number back from GitHub rather than from the branch name.",
            fix: "no issue yet. The supervisor should reject an `AWAIT_PR` number that does not resolve to an open PR.",
            change: "resolve the branch's PR number in `ralph.sh` and compare.",
            verify: "an `AWAIT_PR <issue>` is refused with the real PR number.",
          }),
          previewLearning({
            slug: "parent-closure-unfenced",
            title: "Two loops race on the same parent-closure maintenance task",
            date: "2026-10-07",
            seen: "both loops picked #132 and posted near-identical closure summaries eleven seconds apart.",
            workaround: "re-read the issue's state immediately before the write.",
            fix: "#486",
          }),
        ],
        fixed: [
          { problem: "The test gate inherited the loop's `RALPH_*` identity", fixedBy: "#198" },
          { problem: "codex-executor's index-rebuild test fails on a loaded host", fixedBy: "#356" },
        ],
        present: true,
      },
    ],
  };
}

/** One preview entry, the fields it does not name left unwritten. */
export function previewLearning(entry: Partial<LearningEntryView> & { title: string }): LearningEntryView {
  const fix = entry.fix ?? null;
  return {
    slug: null,
    date: null,
    anchor: githubAnchor(`${entry.title}${entry.date ? ` (${entry.date})` : ""}`),
    seen: null,
    workaround: null,
    change: null,
    verify: null,
    seenAgain: [],
    ...entry,
    fix,
    fixPending: fix !== null && noIssueYet(fix) !== null,
  };
}

/** The store above, through the reader every live project goes through. */
function ciHealth(now: string): CiHealthRead {
  return {
    readAt: now,
    view: foldCiHealth(ciHealthStore(now), 6, Date.parse(now), {
      // Hand-written rather than read off a worktree: the gallery has no
      // `.ralph/logs` to read, and `readCiWaits` touches the filesystem.
      day: { ciIterations: 9, ciMinutes: 7.4, queueIterations: 5, queueMinutes: 12.1 },
      week: { ciIterations: 54, ciMinutes: 8.2, queueIterations: 31, queueMinutes: 14.6 },
      unreadable: [],
    }),
    problem: null,
  };
}
/** A preview loop holding the claim every loop starts on: #975, contested by all of them. */
const fakeLoop = (name: string, role: LoopRole, control: ControlView, canned: () => CannedLoop): [string, FakeLoop] => [
  name,
  { name, role, worktree: worktreeOf(name), control, canned, facts: {}, claims: [975] },
];

const loops = new Map<string, FakeLoop>([
  fakeLoop("rafa", "coder", controlView("rafa"), () =>
    cannedLoop({ presence: presence("rafa", { status: "running", supervisor: "alive" }) }),
  ),
  fakeLoop(
    "ralph",
    "coder",
    controlView("ralph", {
      status: "held",
      hold: { kind: "approval", why: "Merge PR #26 into main?", since: ago(420), gate: "merge" },
      pendingApprovals: [{ gate: "merge", question: "Merge PR #26 into main?", since: ago(420) }],
      commands: [{ key: "k-0", command: "pause", outcome: "applied", at: ago(5000), why: "pause applied" }],
    }),
    () =>
      cannedLoop({
        stage: "gate",
        presence: presence("ralph", {
          status: "running",
          supervisor: "alive",
          issue: 961,
          warning: null,
          step: { stage: "orchestrator", action: "waiting for approval" },
          recent: feed("ralph", GATE_FEED),
          phase: { index: 5, total: 5, label: "Finish" },
        }),
      }),
  ),
  fakeLoop(
    "remo",
    "coder",
    controlView("remo", { run: null, loopStatus: "blocked", status: "blocked", channel: { state: "no-record", why: null, since: null, retryAt: null } }),
    () =>
      cannedLoop({
        loopStatus: "blocked",
        supervisor: "dead",
        stage: "stopped",
        stopReason: { kind: "blocked", why: "The gate failed three times on the same test.", at: ago(3600) },
        // The record stopped in the iteration the ledger names, so the
        // aggregate draws that failure as the card's current one.
        iteration: { index: 7, max: 50 },
        runnerFailures: [
          {
            at: ago(3650),
            loop: "remo",
            run: runOf("remo"),
            iteration: 7,
            stage: "executor",
            runner: "opencode",
            model: "opencode-go/glm-5.3",
            issue: 958,
            exitCode: 1,
            kind: "api-error",
            summary: "provider returned 429 after 3 retries",
            visibility: "live",
            evidence: ["error: 429 Too Many Requests", "retry budget exhausted"],
            note: null,
          },
        ],
        presence: presence("remo", {
          status: "blocked",
          supervisor: "dead",
          issue: 958,
          warning: null,
          step: null,
          failureReason: "gate failed: vitest dashboard/server.test.ts",
          phase: { index: 2, total: 5, label: "Implement" },
          recent: feed("remo", BLOCKED_FEED),
        }),
      }),
  ),
  // The only ci-doctor in the gallery: its role badge, and the one thing its
  // card does that no other role's does — leading with the CASE it holds
  // rather than with a ticket (#160's second acceptance criterion). The case
  // is the one `ciHealthStore` leases to `doc`; the aggregate picks it off the
  // folded view's `held`, so the card and the panel's `heldBy` column are the
  // same lease seen twice.
  fakeLoop("doc", "ci-doctor", controlView("doc"), () => {
    const base = presence("doc", {
      status: "running",
      supervisor: "alive",
      issue: 1402,
      warning: null,
      step: { stage: "orchestrator", action: "measuring src/media/detail.test.ts, run 3 of 5" },
    });
    // The card's title comes from the issue observe recorded for the ticket.
    const fixing = { issue: 1402, state: "active", pr: 1407, draft: false, title: "Flaky media detail suite", detail: null, block: null, at: ago(900) } as const;
    return cannedLoop({ presence: { ...base, issues: [fixing, ...base.issues] } });
  }),
  // The only triager in the gallery: the role badge, the coder-only panels it
  // hides, and the triage panel are all verified by eye here (#147). Writes
  // well under the cap, a bucket behind the leading one, and one unit of every
  // outcome the triager's vocabulary has (`TRIAGE_ENTRIES`).
  fakeLoop("tria", "triager", controlView("tria"), () =>
    cannedLoop({
      phase: null,
      presence: presence("tria", {
        status: "running",
        supervisor: "alive",
        issue: 1131,
        warning: null,
        step: { stage: "orchestrator", action: "routing a batch of 7" },
      }),
    }),
  ),
  fakeLoop("rio", "coder", controlView("rio"), () =>
    cannedLoop({
      iteration: { index: 1, max: 50 },
      heartbeat: ago(3),
      lastEvent: { name: "iteration.started", at: ago(4) },
      presence: presence("rio", {
        status: "running",
        supervisor: "alive",
        issue: 980,
        iteration: { index: 1, max: 50 },
        issues: [],
        actors: [],
        recent: [],
        warning: null,
        step: null,
        phase: { index: 1, total: 5, label: "Select + map" },
      }),
    }),
  ),
]);

/**
 * One canned project: its registry entry and everything its snapshot is
 * built from. The loops are its own Map, so a command on one project's loop
 * never shows on another's, and every read is rebuilt from these.
 */
export interface PreviewWorld {
  project: ProjectView;
  /** The folder its worktrees sit in: the registry's root, and how the adapter factory finds the world again. */
  root: string;
  repoUrl: string;
  loops: Map<string, FakeLoop>;
  ciHealth: (now: string) => CiHealthRead;
  frontier: (now: string) => FrontierRead;
  learnings: () => LearningsRead;
  /** Checkouts the roster does not name, which the aggregate reports as unattributed. */
  strays: () => RuntimeLoop[];
  reconciliation: RuntimeSnapshot["reconciliation"];
  /** The titles the claim labels' issues carry on the tracker. */
  claimTitles: Record<number, string>;
  /** The project's journal; absent, every loop signs the default entries for its role. */
  journal?: () => JournalEntryView[];
}

/** The project the preview has always served, and still the default: the existing tests pin it. */
const PREVIEW_PROJECT: ProjectView = { id: "preview", path: "/home/dev/preview", addedAt: "2026-10-01T00:00:00.000Z", source: "local" };

const PREVIEW_WORLD: PreviewWorld = {
  project: PREVIEW_PROJECT,
  root: "/home/dev/worktrees",
  repoUrl: "https://github.com/felipearos/ralph",
  loops,
  ciHealth,
  frontier: frontierRead,
  learnings,
  strays: () => [copiedRecord()],
  reconciliation: { orphaned: ["/home/dev/worktrees/old-spike"], prunable: [] },
  claimTitles: CLAIM_TITLES,
};

/**
 * The builders the other projects are drawn with, handed over rather than
 * imported so `preview-projects.ts` does not import this module back at run
 * time, where a cycle would read these before they are defined.
 */
const KIT: PreviewKit = {
  ago,
  feed,
  controlView,
  presence,
  cannedLoop,
  feeds: { running: RUNNING_FEED, gate: GATE_FEED, blocked: BLOCKED_FEED },
};

/** Every project the preview serves, the original first so it stays the one the shell lands on. */
const WORLDS: readonly PreviewWorld[] = [PREVIEW_WORLD, ...previewProjects(KIT)];

const worldById = (id: string): PreviewWorld | undefined => WORLDS.find((world) => world.project.id === id);

/** A loop by name across every project: the chat module knows names only, and the fixtures keep them unique. */
const loopNamed = (name: string): FakeLoop | undefined =>
  WORLDS.find((world) => world.loops.has(name))?.loops.get(name);

/**
 * The project as the adapter would read it, rebuilt on every call so its
 * timestamps stay relative to the request and the commands' changes show.
 */
function snapshot(world: PreviewWorld): RuntimeSnapshot {
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  const journal = projectJournal(world);
  const entries = [...world.loops.values()];
  return {
    roster: entries.map(({ name, role }) => ({ name, role })),
    loops: [...entries.map((entry) => runtimeLoop(entry, journal, world.repoUrl)), ...world.strays()],
    reconciliation: world.reconciliation,
    // A lease and a label for every claim, so both sources read `ok` and the
    // aggregate finds #975 contested.
    claims: {
      leases: entries.flatMap(({ name, worktree, claims }) =>
        claims.map((issue) => ({
          issue,
          run: runOf(name),
          loop: name,
          owner: `${name}@desktop`,
          host: "desktop",
          worktree,
          branch: BRANCH,
          claimedAt: ago(1500),
          heartbeatAt: ago(5),
          expiresAt: new Date(nowMs + 1_500_000).toISOString(),
        })),
      ),
      github: entries.flatMap(({ name, claims }) =>
        claims.map((issue) => ({ issue, title: world.claimTitles[issue] ?? `Issue #${issue}`, loop: name })),
      ),
    },
    frontier: world.frontier(now),
    ciHealth: world.ciHealth(now),
    learnings: world.learnings(),
  };
}

/** The local half of the snapshot, as `readLocal` answers it. */
function localSnapshot(world: PreviewWorld): LocalSnapshot {
  const { roster, loops: worktrees } = snapshot(world);
  return {
    roster,
    loops: worktrees.map(({ worktree, identity, loopStatus, worktreeStatus, state, supervisor }) => ({
      worktree,
      identity,
      loopStatus,
      worktreeStatus,
      state,
      supervisor,
    })),
  };
}

/** The backlog picture, as `frontier/next-tasks.ts` would report it for the project. */
function frontierRead(now: string): FrontierRead {
  return {
    readAt: now,
    view: {
      ready: [
        {
          spec: { number: 1066, title: "Spec: mobile media detail parity" },
          staffingGroup: null,
          waiting: 7,
          tickets: [{ number: 1087, title: "Friends' activity strip on title, season and episode screens", frees: 0, stuck: null }],
        },
        {
          spec: null,
          staffingGroup: null,
          waiting: 0,
          tickets: [{ number: 1130, title: "Rename the diary export column headers", frees: 2, stuck: null }],
        },
      ],
      occupied: [
        { number: 1088, title: "Where to watch section with providers and attribution", heldBy: 1087 },
        { number: 1089, title: "Inline reviews block with Friends, Popular and Recent", heldBy: 1087 },
      ],
      specs: [{ number: 1066, title: "Spec: mobile media detail parity", children: 8 }],
      inFlight: [
        { number: 975, title: "Dashboard loop controls", loop: "ralph", claim: "ralph-wip", queued: true },
        { number: 1081, title: "Tags in the mobile log sheet with autocomplete", loop: "rulo", claim: "rulo-wip", queued: true },
        { number: 1050, title: "MFA step-up on credential change", loop: null, claim: "PR #1052", queued: false },
      ],
      blocked: [
        { number: 1077, title: "Watched indicators on posters", blockers: [1076], stuck: null },
        { number: 1080, title: "Fade watched titles in browse", blockers: [1073, 1076], stuck: "rafa-blocked" },
      ],
      gates: [{ number: 1073, title: "mobile: browse filter sheet has dead 'Fade watched' toggle" }],
      stuck: [
        { number: 1040, title: "Import CSV from Letterboxd", label: "remo-blocked" },
        { number: 1109, title: "Episode progress sync", label: "ralph-blocked" },
        { number: 1219, title: "Streaming region preference", label: "rafa-blocked" },
      ],
      tree: [
        {
          spec: { number: 1066, title: "Spec: mobile media detail parity", state: null, detail: null, stuck: null, blockers: [] },
          under: null,
          subSpecs: [],
          total: 8,
          complete: false,
          specStillOpen: false,
          roots: [
            { number: 1087, title: "Friends' activity strip on title, season and episode screens", state: "ready", stuck: null, detail: null, otherBlockers: [], heldBy: null, frees: 0, human: null, children: [] },
            { number: 1088, title: "Where to watch section with providers and attribution", state: "occupied", stuck: null, detail: "staffing group held by #1087", otherBlockers: [], heldBy: 1087, frees: 0, human: null, children: [] },
            {
              number: 1076, title: "Viewer media state read and indicators", state: "in-flight", stuck: null, detail: "ralph-wip", otherBlockers: [], heldBy: null, frees: 2, human: null,
              children: [
                { number: 1077, title: "Watched indicators on posters", state: "blocked", stuck: null, detail: null, otherBlockers: [], heldBy: null, frees: 0, human: null, children: [] },
                { number: 1080, title: "Fade watched titles in browse", state: "blocked", stuck: "rafa-blocked", detail: null, otherBlockers: [1073], heldBy: null, frees: 0, human: null, children: [] },
              ],
            },
            { number: 1086, title: "Scope selector visible in edit mode", state: "done", stuck: null, detail: null, otherBlockers: [], heldBy: null, frees: 0, human: null, children: [] },
          ],
        },
        {
          spec: null, under: null, subSpecs: [], total: 1, complete: false, specStillOpen: false,
          roots: [{ number: 1130, title: "Rename the diary export column headers", state: "ready", stuck: null, detail: null, otherBlockers: [], heldBy: null, frees: 2, human: "held", children: [] }],
        },
        {
          spec: null, under: null, subSpecs: [], total: 1, complete: false, specStillOpen: false,
          roots: [{ number: 1140, title: "Backfill diary timestamps in production", state: "open", stuck: null, detail: null, otherBlockers: [], heldBy: null, frees: 0, human: "ready-for-human", children: [] }],
        },
        {
          spec: null, under: null, subSpecs: [], total: 1, complete: false, specStillOpen: false,
          roots: [{ number: 1219, title: "Streaming region preference", state: "open", stuck: "rafa-blocked", detail: null, otherBlockers: [], heldBy: null, frees: 0, human: null, children: [] }],
        },
        {
          spec: null, under: null, subSpecs: [], total: 1, complete: false, specStillOpen: false,
          roots: [{ number: 1109, title: "Episode progress sync", state: "open", stuck: "ralph-blocked", detail: null, otherBlockers: [], heldBy: null, frees: 0, human: null, children: [] }],
        },
        {
          spec: { number: 1030, title: "Spec: onboarding polish", state: null, detail: null, stuck: null, blockers: [] },
          under: null, subSpecs: [], total: 3, complete: true, specStillOpen: true, roots: [],
        },
      ],
      stuckReasons: [
        { number: 1040, title: "Import CSV from Letterboxd", kind: "unknown", reason: null, pr: null, migration: null, at: null, park: null },
        { number: 1080, title: "Fade watched titles in browse", kind: "other", reason: "Blocked: the spec contradicts #1073 on what fading means.", pr: null, migration: null, at: ago(40000), park: null },
        { number: 1109, title: "Episode progress sync", kind: "other", reason: "Blocked: PR #1276 had two red Buildkite runs (#2001 and #2005) that I couldn't reproduce locally.", pr: 1276, migration: null, at: ago(9000), park: null },
        {
          number: 1219,
          title: "Streaming region preference",
          kind: "migration",
          reason: "needs-migration: draft PR #1242 ready; apply drizzle/0062_streaming_region.sql (additive column) before merging",
          pr: 1242,
          migration: "drizzle/0062_streaming_region.sql",
          at: ago(5400),
          park: null,
        },
      ],
      // Two tickets nobody can route, and a bucket behind the leading one:
      // the gallery has to draw the case where staffing leads and routing is
      // sitting there anyway, because that is the panel's whole point.
      untriaged: [
        { number: 1131, title: "Diary heatmap on the profile screen" },
        { number: 1132, title: "Collapse repeat rewatches in the diary" },
      ],
      triage: { staffing: 1, routing: 2, intake: 4, oversize: 1, rescue: 1 },
      // One of each kind a person meets most: a ticket triaged as theirs, and
      // a ready one the plan holds back — the case where the backlog shows
      // work and every loop calls the frontier empty.
      human: [
        { number: 1130, title: "Rename the diary export column headers", reason: "held" },
        { number: 1140, title: "Backfill diary timestamps in production", reason: "ready-for-human" },
      ],
    },
    problem: null,
  };
}

/**
 * Ninety days of daily spend, deterministic so screenshots are stable: a
 * weekday rhythm, a quieter start, and Codex as tokens without a cost.
 */
function previewDaily(scale: number): DailySpendView[] {
  const days: DailySpendView[] = [];
  const pad = (value: number) => String(value).padStart(2, "0");
  for (let back = 89; back >= 0; back -= 1) {
    const date = new Date(Date.now() - back * 86_400_000);
    // Weekends quiet, and a few days with nothing at all.
    if (back % 11 === 7) continue;
    const wave = 0.55 + 0.45 * Math.sin(back / 6) + (date.getDay() % 6 === 0 ? -0.4 : 0.15);
    const ramp = back > 60 ? 0.5 : 1;
    const level = Math.max(0.08, wave * ramp) * scale;
    const tokens = (output: number) => ({ input: Math.round(output / 30), output, cacheRead: output * 140, cacheWrite: output * 3 });
    days.push({
      date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
      models: [
        { model: "claude-opus-5", costUsd: 22 * level, tokens: tokens(Math.round(160_000 * level)) },
        { model: "claude-sonnet-5", costUsd: 6.5 * level, tokens: tokens(Math.round(70_000 * level)) },
        { model: "opencode-go/glm-5.3", costUsd: 0.9 * level, tokens: tokens(Math.round(30_000 * level)) },
        { model: "codex/gpt-5.6-terra", costUsd: null, tokens: tokens(Math.round(52_000 * level)) },
      ],
    });
  }
  return days;
}

/** The machine's spend as `codexbar cost` reads it: more than the loops alone, at list prices. */
function machineSpendReading(): MachineSpendView {
  return { state: "read", readAt: new Date().toISOString(), daily: previewDaily(4.2) };
}

/** The machine's UsageBar reading, as `codexbar usage --format json` would give it. */
function usageBarReading(): UsageBarView {
  const now = Date.now();
  const at = (seconds: number) => new Date(now + seconds * 1000).toISOString();
  return {
    state: "read",
    readAt: new Date(now).toISOString(),
    providers: [
      {
        provider: "claude",
        source: "oauth",
        account: "operator@example.com",
        plan: "max",
        updatedAt: at(-60),
        windows: [
          { label: "Session (5h)", usedPercent: 42, windowMinutes: 300, resetsAt: at(8040), resetDescription: null, pace: "On pace | Expected 40% used | Lasts until reset" },
          { label: "Weekly", usedPercent: 81, windowMinutes: 10_080, resetsAt: at(190_000), resetDescription: null, pace: "Ahead of pace | Expected 62% used | Runs out in 1d 20h" },
          { label: "Sonnet", usedPercent: 12, windowMinutes: 10_080, resetsAt: at(190_000), resetDescription: null, pace: null },
        ],
        error: null,
        stale: false,
      },
      {
        provider: "codex",
        source: "oauth",
        account: "operator@example.com",
        plan: "pro",
        updatedAt: at(-90),
        windows: [
          { label: "Session (5h)", usedPercent: 18, windowMinutes: 300, resetsAt: at(12_000), resetDescription: null, pace: null },
          { label: "Weekly", usedPercent: 58, windowMinutes: 10_080, resetsAt: at(400_000), resetDescription: null, pace: null },
        ],
        error: null,
        stale: false,
      },
      { provider: "gemini", source: "oauth", account: null, plan: null, updatedAt: null, windows: [], error: "Not signed in. Run `gemini` once to log in.", stale: false },
    ],
  };
}

/**
 * A usage report covering every case the page draws: a task still waiting on
 * its cost, unpriced delegate tokens, a zero-cost run, a sub-cent task, one
 * with no issue, and a loop with no spend. `RALPH_PREVIEW_PLAN` picks the plan
 * state: `warning` (default), `ok`, `rejected`, `overage`, `lapsed`, `none`.
 */
function usageReport(): ProjectUsageReport {
  const tokens = (output: number) => ({ input: Math.round(output / 30), output, cacheRead: output * 140, cacheWrite: output * 3 });
  const priced = (model: string, costUsd: number, output: number) => ({ model, costUsd, tokens: tokens(output) });
  const unpriced = (model: string, output: number) => ({ model, costUsd: null, tokens: tokens(output) });
  const task = (
    loop: string,
    issue: number | null,
    hoursAgo: number,
    stages: [string, number][],
    extra: Partial<TaskCostView> = {},
  ): TaskCostView => {
    const costUsd = stages.reduce((sum, [, cost]) => sum + cost, 0);
    return {
      loop,
      issue,
      costUsd,
      runs: stages.length,
      iterations: 1,
      unpricedTokens: 0,
      unreported: false,
      firstAt: ago((hoursAgo + 1.5) * 3600),
      lastAt: ago(hoursAgo * 3600),
      stages: stages.map(([stage, cost]) => ({ stage, costUsd: cost })),
      models: [priced("claude-opus-5", costUsd * 0.8, Math.round(costUsd * 6000)), priced("claude-sonnet-5", costUsd * 0.2, Math.round(costUsd * 2500))],
      ...extra,
    };
  };

  const tasks: TaskCostView[] = [
    task("rafa", 975, 0.02, [["executor", 5.29], ["review.spec", 1.86]], {
      unreported: true,
      iterations: 2,
      unpricedTokens: 1_840_000,
      models: [priced("claude-sonnet-5", 7.15, 72_000), unpriced("opencode-go/glm-5.3", 61_000)],
    }),
    task("ralph", 961, 0.3, [["orchestrator", 14.1], ["executor", 4.62]], { iterations: 3, unpricedTokens: 0 }),
    task("remo", 958, 1.1, [["orchestrator", 31.8], ["executor", 8.9], ["mapper", 1.4]], {
      iterations: 5,
      unpricedTokens: 420_000,
      models: [priced("claude-opus-5", 33.2, 240_000), priced("claude-sonnet-5", 8.9, 88_000), unpriced("codex/gpt-5.6-terra", 14_000)],
    }),
    task("rafa", 955, 26, [["orchestrator", 8.4], ["executor", 1.4]]),
    task("remo", null, 30, [["orchestrator", 0.62]]),
    task("rafa", 950, 52, [["executor", 0.004]]),
    task("ralph", 944, 70, [["orchestrator", 0]]),
  ];

  const now = Date.now();
  const at = (seconds: number) => new Date(now + seconds * 1000).toISOString();
  const mode = process.env.RALPH_PREVIEW_PLAN ?? "warning";
  const plans: Record<string, UsageReport["plan"]> = {
    ok: { at: ago(40), loop: "rafa", status: "allowed", limitingWindow: null, usingOverage: false, windowsAt: ago(40), fiveHour: { utilization: 0.18, resetsAt: at(9000), lapsed: false }, sevenDay: { utilization: 0.34, resetsAt: at(300000), lapsed: false } },
    warning: { at: ago(40), loop: "rafa", status: "allowed_warning", limitingWindow: "seven_day", usingOverage: false, windowsAt: ago(40), fiveHour: { utilization: 0.42, resetsAt: at(8040), lapsed: false }, sevenDay: { utilization: 0.81, resetsAt: at(190000), lapsed: false } },
    rejected: { at: ago(12), loop: "remo", status: "rejected", limitingWindow: "five_hour", usingOverage: false, windowsAt: ago(12), fiveHour: { utilization: 1, resetsAt: at(1500), lapsed: false }, sevenDay: { utilization: 0.93, resetsAt: at(90000), lapsed: false } },
    overage: { at: ago(20), loop: "ralph", status: "rejected", limitingWindow: "five_hour", usingOverage: true, windowsAt: ago(20), fiveHour: { utilization: 1, resetsAt: at(2400), lapsed: false }, sevenDay: { utilization: 0.88, resetsAt: at(120000), lapsed: false } },
    lapsed: { at: ago(30000), loop: "rafa", status: "allowed", limitingWindow: null, usingOverage: false, windowsAt: ago(30000), fiveHour: { utilization: 0.66, resetsAt: ago(12000), lapsed: true }, sevenDay: { utilization: 0.52, resetsAt: at(200000), lapsed: false } },
    none: null,
  };
  const plan = plans[mode] ?? plans.warning!;

  return {
    generatedAt: new Date(now).toISOString(),
    plan,
    // The account's plan, as a second project's loop reported it.
    account: {
      scope: "all-projects",
      plan: plan === null ? null : { ...plan, project: "widgets" },
      projects: ["loggd", "widgets"],
      unread: [],
      spend: { last5h: 19.84, last24h: 91.2, last7d: 340.15, total: 1520.7 },
      projectSpend: [
        { project: "loggd", spend: { last5h: 12.34, last24h: 58.9, last7d: 212.6, total: 948.2 } },
        { project: "widgets", spend: { last5h: 7.5, last24h: 32.3, last7d: 127.55, total: 572.5 } },
      ],
      daily: previewDaily(1.6),
    },
    spend: { last5h: 12.34, last24h: 58.9, last7d: 212.6, total: 948.2 },
    loops: [
      { loop: "rafa", costUsd: 402.5, last7d: 88.1, runs: 96, unpricedTokens: 5_900_000, models: [priced("claude-opus-5", 310.2, 2_100_000), priced("claude-sonnet-5", 92.3, 900_000), unpriced("opencode-go/glm-5.3", 410_000)] },
      { loop: "ralph", costUsd: 311.9, last7d: 61.4, runs: 71, unpricedTokens: 0, models: [priced("claude-fable-5-1", 240.7, 1_600_000), priced("claude-haiku-4-5-20251001", 0.21, 4_000), priced("claude-sonnet-5", 71, 700_000)] },
      { loop: "remo", costUsd: 233.8, last7d: 63.1, runs: 58, unpricedTokens: 2_300_000, models: [priced("claude-opus-5", 233.8, 1_500_000), unpriced("codex/gpt-5.6-terra", 380_000)] },
      { loop: "rio", costUsd: 0, last7d: 0, runs: 0, unpricedTokens: 0, models: [] },
    ],
    tasks,
    models: [
      priced("claude-opus-5", 160.2, 1_100_000),
      priced("claude-sonnet-5", 48.1, 520_000),
      priced("claude-haiku-4-5-20251001", 0.21, 4_000),
      unpriced("opencode-go/glm-5.3", 410_000),
      unpriced("codex/gpt-5.6-terra", 380_000),
    ],
    daily: previewDaily(1),
    sources: { files: 31, results: 214, ledgerRows: 1320 },
    usagebar: usageBarReading(),
    machineSpend: machineSpendReading(),
  };
}

/**
 * Every preview router's change stream over the canned loops (#724), each
 * made on its router's first `/api/stream`. The fake state lives in memory and
 * is shared, so no file watch would see it move: every mutation below nudges
 * every live hub instead.
 */
const previewHubs = new Set<SnapshotHub>();
const nudgeStream = (): void => {
  for (const hub of previewHubs) hub.nudge();
};

const setLive = (loop: FakeLoop, alive: boolean): void => {
  loop.facts = { ...loop.facts, supervisor: alive ? "alive" : "dead", loopStatus: alive ? "running" : "blocked" };
  nudgeStream();
};

/** Apply a control command to the in-memory loop, the way the real loop would. */
function control(loop: FakeLoop, action: ControlCommand, issue: number | null = null, phase: Phase | null = null): ControlResult {
  const status = loop.control;
  switch (action) {
    case "pause":
      status.hold = { kind: "pause", why: "paused from the dashboard", since: new Date().toISOString(), gate: null };
      break;
    case "resume":
    case "approve":
    case "deny":
      status.hold = null;
      status.pendingApprovals = [];
      break;
    case "stop":
      status.hold = null;
      setLive(loop, false);
      break;
    case "arm-gate":
      if (phase !== null && !status.gates.some((gate) => gate.phase === phase)) {
        status.gates = [...status.gates, { phase, since: new Date().toISOString(), why: null }].sort(
          (a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase),
        );
      }
      break;
    case "disarm-gate":
      status.gates = status.gates.filter((gate) => gate.phase !== phase);
      break;
    case "retry":
      loop.facts = { ...loop.facts, stopReason: null };
      break;
    case "abandon":
    case "release":
      // The lease and the label both go, as the real release drops both.
      loop.claims = loop.claims.filter((claimed) => claimed !== issue);
      break;
  }
  const at = new Date().toISOString();
  const key = crypto.randomUUID();
  status.commands = [{ key, command: action, outcome: "applied", at, why: `${action} applied` }, ...status.commands];
  nudgeStream();
  return {
    loop: loop.name,
    action,
    key,
    run: runOf(loop.name),
    issue,
    outcome: "applied",
    recorded: false,
    why: `${action} applied (preview: nothing was sent)`,
    at,
    stop: action === "stop" ? { kind: "blocked", confirmation: "pending" } : null,
  };
}

function start(loop: FakeLoop): StartResult {
  setLive(loop, true);
  return {
    loop: loop.name,
    action: "start",
    worktree: loop.worktree,
    outcome: "started",
    pid: 1732294,
    why: "Started Ralph supervisor (pid 1732294); waits 300s, runs up to 50 iterations.\nLog: .ralph/logs/loop.stdout",
    at: new Date().toISOString(),
  };
}

function checkout(loop: FakeLoop): CheckoutReport {
  return {
    worktree: loop.worktree,
    branch: BRANCH,
    readable: true,
    dirty: true,
    changes: [" M dashboard/ui/app.tsx"],
    claims: loop.claims.map((issue) => ({ issue, run: runOf(loop.name), loop: loop.name, branch: BRANCH })),
    midTicket: loop.claims.length > 0,
    unpushed: ["a1b2c3d feat(dashboard): the half the iteration finished"],
  };
}

/** Stop now, as the real sequence ends when every check passes: the loop interrupted, its claim kept. */
function stopNow(loop: FakeLoop): StopNowResult {
  const at = new Date().toISOString();
  const issue = loop.claims[0] ?? null;
  const iteration = current(loop).iteration.index;
  const why = "stopped now from the dashboard";
  const worktree = loop.worktree;
  loop.facts = {
    ...loop.facts,
    supervisor: "dead",
    loopStatus: "interrupted",
    stage: "stopped",
    stopReason: { kind: "interrupted", why, at },
  };
  loop.control.hold = null;
  loop.control.stop = { kind: "interrupted", why, at, confirmation: "confirmed", iteration, issue };
  nudgeStream();
  const pid = 1732294;
  return {
    loop: loop.name,
    action: "stop-now",
    key: crypto.randomUUID(),
    worktree,
    run: runOf(loop.name),
    outcome: "interrupted",
    why: `${loop.name} was interrupted (preview: nothing was signalled)`,
    at,
    target: { pidFile: ".ralph/logs/supervisor.pid", pid, group: pid - 4 },
    checks: [
      { check: "pid-file", ok: true, detail: `.ralph/logs/supervisor.pid names pid ${pid}` },
      { check: "alive", ok: true, detail: `pid ${pid} is running` },
      { check: "ralph.sh", ok: true, detail: `pid ${pid} is running 'bash ralph.sh 50'` },
      { check: "cwd", ok: true, detail: `pid ${pid} is working in ${worktree}` },
      { check: "group", ok: true, detail: `pid ${pid}'s process group ${pid - 4} is led by its start.sh wrapper` },
    ],
    signals: ["SIGTERM"],
    recorded: true,
    stop: { kind: "interrupted", confirmation: "confirmed", iteration, issue },
    audit: ".ralph/control/signals.jsonl",
  };
}

function resumeWork(loop: FakeLoop): ResumeWorkResult {
  const started = start(loop);
  loop.control.stop = null;
  loop.facts = { ...loop.facts, stopReason: null, loopStatus: "running", stage: "iteration" };
  nudgeStream();
  return { ...started, action: "resume-work", why: `${started.why} (preview: HEAD kept)`, checkout: checkout(loop) };
}

function restart(loop: FakeLoop): RestartResult {
  const stopped = control(loop, "stop");
  const started = start(loop);
  return {
    loop: started.loop,
    action: "restart-to-apply",
    key: stopped.key,
    worktree: started.worktree,
    outcome: "started",
    halt: null,
    why: "stopped at the iteration boundary and started again (preview: nothing was sent)",
    at: started.at,
    stop: stopped,
    confirmation: "confirmed",
    start: { outcome: "started", pid: started.pid, why: started.why },
    checkout: checkout(loop),
  };
}

/* ------------------------------------------------------------ live rebuild */

// The page asks for the build version every second and reloads when it moves.
const RELOAD = `<script>(() => {
  let seen = null;
  setInterval(async () => {
    try {
      const v = await (await fetch("/__preview/version", { cache: "no-store" })).text();
      if (seen !== null && v !== seen) location.reload();
      seen = v;
    } catch {}
  }, 1000);
})();</script>`;

/* ------------------------------------------------------------------ server */

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** A canned live pane: a short tail, then a line every two seconds until the page goes. */
function cannedOutput(emit: Emit): Follower {
  const stamp = () => new Date().toISOString();
  emit({ kind: "reset", log: "iter-20260922T120000.log", reason: null });
  emit({
    kind: "append",
    text: [
      `[${stamp()}] system: init`,
      `[${stamp()}] text: I'll start by orienting on the ticket.`,
      `[${stamp()}] tool: Bash — gh issue view 51 --json title,body`,
      `[${stamp()}] tool result: Bash — ok — token [redacted:github-token]`,
    ].join("\n") + "\n",
  });
  const steps = ["tool: Read — dashboard/server.ts", "thinking: map the route first", "tool: Bash — bun run typecheck", "tool result: Bash — ok"];
  let index = 0;
  const timer = setInterval(() => emit({ kind: "append", text: `[${stamp()}] ${steps[index++ % steps.length]}\n` }), 2000);
  return { stop: () => clearInterval(timer) };
}

/**
 * A canned plugin doctor for the `ralph` loop: one plugin with a consumer that
 * is not bound, which a repair or Fix all mends. Other loops have no plugin
 * enabled, so they show no Fix panel.
 */
const doctorHistory: DoctorHistoryEntry[] = [];
let doctorBroken = true;
function cannedDoctor(loop: string, body: { action?: string; check?: string; repair?: string }): DoctorView {
  if (loop !== "ralph") return { loop, plugins: [], steps: [], stopped: null, history: [], problem: null };
  const at = new Date().toISOString();
  const steps: DoctorStepView[] = [];
  if (doctorBroken && (body.action === "fix-all" || (body.action === "repair" && body.check === "consumer"))) {
    doctorBroken = false;
    steps.push({ check: "consumer", action: body.repair ?? "bind-new", result: "repaired", why: "Opened terminal term_7f3 in this worktree and bound it to Run run_42; it reads the Run's mailbox from now on." });
    doctorHistory.push({ at, plugin: "board", run: "run-1", kind: "repair", via: body.action === "fix-all" ? "fix-all" : "operator", check: "consumer", action: steps[0]!.action, result: "repaired", why: steps[0]!.why });
  }
  const pass = (id: string, label: string, detail: string): DoctorCheckView => ({ id, label, status: "pass", detail, repairs: [] });
  const checks: DoctorCheckView[] = [
    pass("cli", "CLI present", "'board' runs."),
    pass("runtime", "Runtime reachable", "The runtime is ready and reachable."),
    pass("run", "Run registered", "Run run_42 mirrors loop run run-1."),
    doctorBroken
      ? {
          id: "consumer",
          label: "Consumer bound",
          status: "fail",
          detail: "The loop was not started from a board terminal and no terminal is bound to Run run_42, so nothing reads its mailbox and commands sent from the board never reach the loop.",
          repairs: [{ id: "bind-new", label: "Bind a terminal the plugin opens for this loop", default: true }],
        }
      : pass("consumer", "Consumer bound", "Terminal term_7f3 is bound to Run run_42 and reads its mailbox."),
    doctorBroken
      ? { id: "backoff", label: "Back-off window", status: "skipped", detail: "Waiting before trying again — the command route: no safe consumer is available. Not cleared while an earlier check fails.", repairs: [] }
      : pass("backoff", "Back-off window", "Nothing is backing off."),
  ];
  doctorHistory.push({ at, plugin: "board", run: "run-1", kind: "diagnosis", via: "operator", check: null, action: null, result: doctorBroken ? "failing" : "healthy", why: "" });
  return { loop, plugins: [{ plugin: "board", title: "Board", checks, problem: null }], steps, stopped: null, history: [...doctorHistory], problem: null };
}

/**
 * Canned records for the feed and the history, as the harness writes them: the
 * real route reads them through the real projection, so the preview shows what
 * a checkout with these files would.
 */
const readMarks = new Map<string, string>();
const lines = (...rows: unknown[]): string => rows.map((row) => JSON.stringify(row)).join("\n");
const recordsByWorktree = new Map<string, RecordsAdapter>();
/** Built once per loop, so the canned times hold still and a read mark sticks. */
function cannedRecords(worktree: string): RecordsAdapter {
  const cached = recordsByWorktree.get(worktree);
  if (cached !== undefined) return cached;
  const built = buildCannedRecords(worktree);
  recordsByWorktree.set(worktree, built);
  return built;
}
function buildCannedRecords(worktree: string): RecordsAdapter {
  const loop = worktree.split("/").at(-1) ?? "ralph";
  const run = `run-${loop}-01`;
  const raised = (occurrence: string, secondsAgo: number, fields: Record<string, unknown>) => ({
    version: 1, event: "raised", id: `${run}:${occurrence}`, at: ago(secondsAgo), run, loop, priority: "high", ticket: 52, iteration: 4, plugins: [], github: "absent", ...fields,
  });
  const delivery = (occurrence: string, secondsAgo: number, fields: Record<string, unknown>) => ({
    version: 1, event: "delivery", id: `${run}:${occurrence}`, at: ago(secondsAgo), ...fields,
  });
  const feed =
    loop === "remo"
      ? ""
      : lines(
          raised("gate:3", 5400, { kind: "gate-failure", subject: "Loop gate failed at gate-broken", body: "bun run test exited 1 — 2 failing suites", plugins: ["board"], github: "eligible" }),
          delivery("gate:3", 5399, { channel: "plugin", name: "board", ok: true, ran: true, why: null }),
          delivery("gate:3", 5398, { channel: "github", name: "github", ok: true, why: null, outcome: "posted" }),
          raised("rate:4", 900, { kind: "rate-limit", subject: "Executor rate limited", body: "429 from the provider; retrying in 60s with [redacted:env:ANTHROPIC_API_KEY]", plugins: ["board"], github: "unheld" }),
          delivery("rate:4", 899, { channel: "plugin", name: "board", ok: false, ran: true, why: "no board run to send the alert to" }),
          raised("blocked:4", 120, { kind: "ticket-blocked", subject: "Ticket #52 blocked", body: "needs a human: the migration touches production data", plugins: ["board"], github: "eligible" }),
        );
  const history = {
    commands: {
      state: "read" as const,
      files: [
        {
          stem: "pause-1", pending: false, modifiedAt: ago(7000),
          command: { state: "read" as const, text: JSON.stringify({ version: 1, id: "pause-1", command: "pause", loop, run, why: "reviewing the plan", issuedAt: ago(7200) }) },
          outcome: { state: "read" as const, text: JSON.stringify({ key: "pause-1", command: "pause", outcome: "applied", why: "paused — reviewing the plan", at: ago(7100) }) },
        },
        {
          stem: "abandon-1", pending: false, modifiedAt: ago(3000),
          command: { state: "read" as const, text: JSON.stringify({ version: 1, id: "abandon-1", command: "abandon", loop, issue: 48, why: "rafa looks gone", issuedAt: ago(3100) }) },
          outcome: { state: "read" as const, text: JSON.stringify({ key: "abandon-1", command: "abandon", outcome: "refused", why: "#48 is held by run-rafa-01 until 14:20; a claim is reclaimable only once it has expired", at: ago(3050) }) },
        },
        {
          stem: "stop-1", pending: true, modifiedAt: ago(30),
          command: { state: "read" as const, text: JSON.stringify({ version: 1, id: "stop-1", command: "stop", loop, run, stop: "blocked", why: "wait for the migration review", issuedAt: ago(30) }) },
          outcome: { state: "missing" as const },
        },
      ],
    },
    signals: {
      state: "read" as const,
      text: lines({
        id: "now-1", at: ago(2400), event: "refused", loop, run, reason: "turn held for 40 minutes",
        target: { pidFile: ".ralph/logs/supervisor.pid", pid: 4242, group: null },
        checks: [{ check: "pid-file", ok: true, detail: "pid 4242" }, { check: "alive", ok: false, detail: "pid 4242 is not running" }],
        signal: null, outcome: "refused", detail: "nothing was signalled: pid 4242 is not running",
      }),
    },
    repairs: {
      state: "read" as const,
      text: lines({ version: 1, at: ago(1800), plugin: "board", run, kind: "repair", via: "operator", check: "consumer", action: "rebind", result: "repaired", why: "bound terminal term_7f3 to run_42" }),
    },
  };
  return {
    readFeed: () => ({
      feed: feed === "" ? { state: "missing" } : { state: "read", text: feed },
      readMark: readMarks.has(loop) ? { state: "read", text: JSON.stringify({ version: 1, readThrough: readMarks.get(loop) }) } : { state: "missing" },
    }),
    readHistory: () => (loop === "remo" ? { commands: { state: "missing" }, signals: { state: "missing" }, repairs: { state: "missing" } } : history),
    markRead: (through) => {
      readMarks.set(loop, through);
      return { readThrough: through, why: null };
    },
  };
}

/** The unblocker chat over canned answers; Stop & fix and a handback act on the in-memory loops. */
const chat = createPreviewChat({
  find: (name) => {
    const loop = loopNamed(name);
    if (loop === undefined) return null;
    const now = current(loop);
    return {
      worktree: loop.worktree,
      supervisor: now.supervisor,
      halted: now.supervisor !== "alive" && now.stopReason !== null,
      ticket: now.presence.issue,
    };
  },
  stop: (name) => {
    const loop = loopNamed(name);
    if (loop !== undefined) setLive(loop, false);
  },
  start: (name) => {
    const loop = loopNamed(name);
    if (loop !== undefined) start(loop);
  },
});

/** Answers a call the preview must never make: the four reads it forwards reach none of these. */
const unreachable = (what: string) => (): never => {
  throw new Error(`the preview runs no ${what}`);
};

/** An object whose every property is a refusal, for an adapter the composed server builds but the preview never reaches. */
const refusing = <T>(what: string): T =>
  new Proxy(
    {},
    {
      get: (_target, key) => {
        // Not a thenable: an `await` on the object must not look like a call.
        if (key === "then") return undefined;
        throw new Error(`the preview runs no ${what} (asked for ${String(key)})`);
      },
    },
  ) as T;

/** The projects the composed server is registered with, each observed at its own worktrees folder. */
const ENTRIES: ProjectEntry[] = WORLDS.map((world) => ({ ...world.project, roots: [world.root] }));

/**
 * The world an adapter the composed server builds reads. A request's scope
 * names its project; the background passes (never scheduled here) name only
 * the roots, so those are the fallback key.
 */
function worldFor(projectId: string | undefined, roots: readonly string[]): PreviewWorld {
  return (
    (projectId === undefined ? undefined : worldById(projectId)) ??
    WORLDS.find((world) => roots.includes(world.root)) ??
    PREVIEW_WORLD
  );
}

/**
 * The real server's composition over the canned snapshot, with no process
 * behind any of it. The preview forwards only its loop reads here, so the
 * snapshot goes through the same `aggregateDashboard` and projections a live
 * project does; every adapter that would spawn something refuses instead.
 *
 * The factories are written out rather than spread over `processFactories`:
 * one the server came to build that this left real would quietly run a
 * process, where a missing one fails the typecheck.
 */
/** The read-only git subcommands onboarding's set-up probes run; the preview answers no other. */
const GIT_READS = new Set(["rev-parse", "cat-file", "symbolic-ref", "remote", "status"]);

export function previewServerDeps(): ServerDeps {
  return {
    config: {
      host: "127.0.0.1",
      port: 0,
      roots: [],
      rootsOverride: false,
      cliDir: "/nonexistent/cli",
      bunPath: "/nonexistent/bun",
      hosts: [],
    },
    registry: {
      file: "/nonexistent/projects.json",
      readOnly: true,
      list: () => ENTRIES,
      add: unreachable("project registration"),
      remove: () => false,
      setWorktrees: unreachable("worktrees folder write"),
    },
    shell: { html: "", assets: new Map() },
    harness: RALPH_HOME,
    // Never run: the passes that would use these are not scheduled here.
    reconciling: { intervalMs: 0, attempts: 3, retryScheduleMinutes: [1], migrationAlertSeconds: 3600 },
    lineup: refusing<ServerDeps["lineup"]>("lineup adapter"),
    // Asked for at compose time, one per timeout surface. Every adapter built
    // over it but onboarding is never called here: the preview answers those
    // routes itself or never schedules them, so any other call refuses.
    //
    // Onboarding is built at compose time; the preview answers setup and the
    // project list itself. The server asks it only to explain a read that
    // threw, and the project must read as set up then: a "needs-setup" answer
    // would hide the aggregate's real error, which is what the preview exists
    // to show. So every `git` probe succeeds, as on a set-up checkout, the
    // project config reads as valid and the tracker answers, with no process.
    executor: () => async (invocation) => {
      const script = invocation.args[0] ?? "";
      // Only git's reads answer: a write (fetch, switch, worktree, push) from
      // an adapter a future route reaches must refuse, not fake a success.
      if (invocation.command === "git" && GIT_READS.has(invocation.args[0] ?? "")) return { status: 0, stdout: "main\n", stderr: "" };
      if (invocation.command === "gh") return { status: 1, stdout: "", stderr: "the preview runs no gh" };
      if (script.endsWith(`/${ONBOARDING_SURFACE.projectConfig.script}`)) return { status: 0, stdout: "", stderr: "" };
      if (script.endsWith(`/${ONBOARDING_SURFACE.tracker.script}`)) return { status: 0, stdout: "", stderr: "" };
      throw new Error("the preview runs no process");
    },
    ralphAdapter: (config) => {
      const world = worldFor(config.projectId, config.roots);
      return { read: async () => snapshot(world), readLocal: async () => localSnapshot(world) } as unknown as ReturnType<
        ServerDeps["ralphAdapter"]
      >;
    },
    factories: {
      interrupt: unreachable("interrupt"),
      // The server reads each loop's retry line off these, as a live project's.
      records: ({ root }) => cannedRecords(root),
      lineupHandler: () => async () => json({ error: "not found" }, 404),
      usage: () =>
        Object.assign(async () => usageReport(), { close() {} }) as unknown as ReturnType<ServerDeps["factories"]["usage"]>,
      chatRunner: () => ({ claude: unreachable("claude"), redactor: unreachable("redactor") }),
      redactor: () => unreachable("redactor"),
      follower: unreachable("output follower"),
    },
    log: { out: () => undefined, err: (line) => console.error(line) },
  };
}

/** The loop reads the composed server answers — three fixed paths and a loop's panel; nothing else may fall through to it. */
const COMPOSED_READS = new Set(["/api/loops", "/api/ownership", "/api/frontier"]);
const isComposedRead = (pathname: string): boolean =>
  COMPOSED_READS.has(pathname) || /^\/api\/loops\/[^/]+$/.test(pathname);

export interface PreviewRouterDeps {
  /** The current build, read on every request because the live rebuild swaps it. */
  shell: () => { shell: Shell; version: number };
  /** The lineup editor's handler, over the harness's real `models.json`. */
  lineup: (request: Request) => Response | Promise<Response>;
  /** `RALPH_PREVIEW_SETUP=1`: answer the setup routes as a project not set up yet. */
  setupPreview: boolean;
}

/**
 * The project's sleep, held in memory: the toggle can be tried in the preview
 * and nothing is written, and a restart wakes the canned project again.
 */
function cannedSleep(): ProjectSleepAdapter {
  const awake = { asleep: false, since: null, why: null, by: null, problem: null };
  let view: ProjectSleepView = awake;
  return {
    status: async () => view,
    // Idempotent like the CLI: an already-asleep project keeps its first since and why.
    sleep: async (why) => (view = view.asleep ? view : { asleep: true, since: new Date().toISOString(), why, by: "dashboard", problem: null }),
    wake: async () => (view = awake),
  };
}

/**
 * A project's health for the switcher, through the real fold. Each loop's
 * control record is its canned control view's hold, the one part of the
 * record `needsYouFor` reads, so an approval hold puts the project on
 * "needs you" exactly as a live one would.
 */
function worldHealth(world: PreviewWorld): ProjectHealthView {
  const loops = [...world.loops.values()].map((entry): HealthLoop => {
    const now = current(entry);
    const hold = entry.control.hold;
    return {
      loop: entry.name,
      loopStatus: now.loopStatus,
      supervisor: now.supervisor,
      stage: now.stage,
      lastEvent: now.lastEvent.name,
      control: {
        kind: "record",
        record: {
          ralphRun: runOf(entry.name),
          loop: entry.name,
          hold: hold === null ? null : { kind: hold.kind, why: hold.why, since: hold.since, gate: hold.gate },
          gates: [],
          stop: null,
          applied: [],
          deferrals: [],
          degraded: null,
          gateQuestion: hold?.kind === "approval" ? hold.why : null,
          givenUp: [],
        },
      },
    };
  });
  return projectHealth(world.project.id, loops, new Date().toISOString());
}

/** The preview's request handler, with nothing built, watched or served behind it. */
export function createPreviewRouter(deps: PreviewRouterDeps): (request: Request) => Promise<Response> {
  const composed = composeServer(previewServerDeps());
  // One in-memory sleep per project, so putting one to sleep leaves the others awake.
  const sleeps = new Map(WORLDS.map((world) => [world.project.id, cannedSleep()]));
  // Asked as the project's scoped path on loopback: the page may be opened on
  // a Tailscale address the composed server's Host check does not know, and
  // the preview's own front layer has already checked the scope.
  const forward = (world: PreviewWorld, pathname: string, request: Request, search = ""): Promise<Response> =>
    composed.fetch(
      new Request(`http://127.0.0.1/api/p/${encodeURIComponent(world.project.id)}${pathname.slice("/api".length)}${search}`, {
        method: request.method,
      }),
    );
  // A failed composed read is the server's error, not a dashboard: the records
  // routes must report it rather than read `{ error }` as loops.
  const dashboard = async (world: PreviewWorld): Promise<Dashboard> => {
    const response = await forward(world, "/api/loops", new Request("http://127.0.0.1/"));
    if (!response.ok) throw new Error(`the composed /api/loops answered ${response.status}: ${await response.text()}`);
    return (await response.json()) as Dashboard;
  };
  // This router's change streams, one per canned project over that project's
  // composed read; each made on its first `/api/stream` and nudged, with every
  // other router's, by the mutations.
  const hubs = new Map<string, SnapshotHub>();
  return async (request) => {
    const url = new URL(request.url);
    // Several canned projects. The shell lands on `/p/<id>/` and asks for
    // every API path under `/api/p/<id>/`; an unscoped path is the default
    // project's, as it always was.
    if (url.pathname === "/api/projects") return json({ projects: WORLDS.map((world) => world.project) } satisfies ProjectsView);
    if (url.pathname === "/api/projects/health") {
      // As the real server: the selected project is left out, its full snapshot is already polled.
      const selected = url.searchParams.get("selected");
      return json({
        selected,
        projects: WORLDS.filter((world) => world.project.id !== selected).map(worldHealth),
      } satisfies ProjectsHealthView);
    }
    const scopedPage = SCOPED_PAGE_PATH.exec(url.pathname);
    const scopedApi = SCOPED_API_PATH.exec(url.pathname);
    const scope = scopedPage?.[1] ?? scopedApi?.[1] ?? null;
    const world = scope === null ? PREVIEW_WORLD : worldById(decodeURIComponent(scope));
    if (world === undefined) return json({ error: "UnknownProject", message: `no project '${scope}'` }, 404);
    const loops = world.loops;
    const pathname = scopedPage !== null ? (scopedPage[2] ?? "/") : scopedApi !== null ? `/api${scopedApi[2] ?? ""}` : url.pathname;
    if (deps.setupPreview) {
      const setup = previewSetup(world.project.id, pathname, request.method);
      if (setup !== null) return setup;
    }
    if (pathname === "/api/setup") return json({ project: world.project.id, status: "ready", baseBranch: "main", pr: null } satisfies ProjectSetupView);
    // The lineup handler reads its own path off the request, so it is handed the unscoped one.
    if (isLineupPath(pathname)) return deps.lineup(pathname === url.pathname ? request : new Request(new URL(`${pathname}${url.search}`, url), request));
    const { shell, version } = deps.shell();
    if (pathname === "/__preview/version") return new Response(String(version), { headers: { "cache-control": "no-store" } });
    if (pathname === "/states" || isShellPath(pathname)) {
      return new Response(shell.html.replace("</body>", `${RELOAD}</body>`), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    const asset = shell.assets.get(pathname);
    if (asset !== undefined) return new Response(asset.body, { headers: { "content-type": asset.type } });
    // The change stream reads the same composed snapshot the page does, so a
    // pressed Approve reaches the sidebar the way it would on the machine.
    if (pathname === "/api/stream" && request.method === "GET") {
      const project = world.project.id;
      let hub = hubs.get(project);
      if (hub === undefined) {
        const made = createSnapshotHub({ compute: () => dashboard(world), watchTargets: () => [], debounceMs: 50, minIntervalMs: 250 });
        previewHubs.add(made);
        made.onClose(() => {
          previewHubs.delete(made);
          if (hubs.get(project) === made) hubs.delete(project);
        });
        hubs.set(project, made);
        hub = made;
      }
      return streamResponse(hub, request.signal);
    }
    // The loop reads are the real server's, over the canned snapshot.
    if (isComposedRead(pathname)) return forward(world, pathname, request, url.search);
    const slept = await handleProjectSleepRoute(request, pathname, sleeps.get(world.project.id)!);
    if (slept !== null) return slept;
    // File ticket answers a made-up issue after a beat, so its pending state shows; nothing is filed.
    const filed = await handleLearningsFileRoute(request, pathname, {
      file: async (slug) => {
        await new Promise((done) => setTimeout(done, 600));
        return { slug, url: `https://github.com/felipearos/loggd/issues/${3000 + (slug.length % 97)}`, problem: null };
      },
    });
    if (filed !== null) return filed;
    // Every loop's control view at once, as the server's batched route (#615).
    if (pathname === "/api/controls") {
      return json({ loops: Object.fromEntries([...loops].map(([name, loop]) => [name, loop.control])) } satisfies ControlsView);
    }
    if (pathname === "/api/usage") return json(usageReport());
    if (isRecordsPath(pathname)) {
      const routed = await handleRecordsRoute(request, pathname, {
        records: cannedRecords,
        dashboard: () => dashboard(world),
        now: () => new Date(),
      });
      if (routed !== null) return routed;
    }

    // Only the five lifecycle commands are canned here; the table's other command
    // rows (mark-read, agent-start) are the records routes' or not previewed.
    if (request.method === "POST" && ["/api/control", "/api/start", "/api/restart", "/api/stop-now", "/api/resume-work"].includes(pathname)) {
      // The body goes through the parser the route table names for this path,
      // so a malformed request gets production's 400 before any loop lookup.
      const row = matchRoute(pathname, "project")?.rows.find(
        (entry): entry is Extract<RouteRow, { kind: "command" }> => entry.method === "POST" && entry.kind === "command",
      );
      if (row === undefined) return json({ error: "not found" }, 404);
      let body: DispatchRequest;
      try {
        // Every command parser returns at least `loop`; only control's carries the rest.
        body = row.parse(await readBody(request)) as DispatchRequest;
      } catch (error) {
        if (error instanceof ControlRouteError) return json({ error: error.name, message: error.message }, error.status);
        throw error;
      }
      const loop = loops.get(body.loop);
      if (!loop) return json({ error: "UnknownLoop", message: `no loop '${body.loop}' in the roster` }, 404);
      if (pathname === "/api/start") return json(start(loop));
      if (pathname === "/api/restart") return json(restart(loop));
      if (pathname === "/api/stop-now") return json(stopNow(loop));
      if (pathname === "/api/resume-work") return json(resumeWork(loop));
      return json(control(loop, body.action, body.issue ?? null, body.phase ?? null));
    }
    const perLoop = pathname.match(/^\/api\/loops\/([^/]+)\/(control|checkout)$/);
    if (perLoop) {
      const loop = loops.get(decodeURIComponent(perLoop[1]!));
      if (!loop) return json({ error: "not found", message: "no such loop" }, 404);
      return perLoop[2] === "control" ? json(loop.control) : json({ loop: loop.name, checkout: checkout(loop) });
    }
    const chatted = await chat(request, pathname);
    if (chatted !== null) return chatted;
    if (request.method === "POST" && pathname === "/api/doctor") {
      const body = (await request.json()) as { loop: string; action?: string; check?: string; repair?: string };
      return json(cannedDoctor(body.loop, body));
    }
    const output = OUTPUT_PATH.exec(pathname);
    if (output) {
      if (!loops.get(decodeURIComponent(output[1]!))) return json({ error: "not found", message: "no such loop" }, 404);
      return outputResponse(cannedOutput, request.signal);
    }
    return json({ error: "not found" }, 404);
  };
}

// Only a run builds, watches and listens: importing the router from a test must not.
if (import.meta.main) {
  let shell: Shell = await buildShell();
  let version = Date.now();

  let timer: ReturnType<typeof setTimeout> | undefined;
  // Off under `dashboard:dev`: HMR replaces the rebuild there.
  if (process.env.RALPH_PREVIEW_WATCH !== "0") {
    watch(UI_DIR, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const started = Date.now();
        try {
          shell = await buildShell();
          version = Date.now();
          console.log(`rebuilt in ${Date.now() - started}ms`);
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
        }
      }, 100);
    });
  }

  const realLineup = createLineupAdapter({ cliDir: RALPH_HOME, roots: [RALPH_HOME] });
  const lineup = createLineupHandler({
    adapter: {
      roots: realLineup.roots,
      read: (options) => realLineup.read(options),
      preview: (input) => realLineup.preview(input),
      edit: (input) => realLineup.edit(input),
      catalog: (options) => realLineup.catalog(options),
      // A preview never writes models.json: a save only reports the verdict.
      save: async (input) => {
        const { root, project, loop, valid, problems } = await realLineup.preview(input);
        return { root, project, loop, valid, problems };
      },
      updates: (options) => realLineup.updates(options),
      // Nor does an answer: it reports what would move, and the block as it is.
      answerUpdate: async (input) => {
        const report = await realLineup.updates({ root: input.root, project: input.project });
        const project = input.fileDefault === true ? null : report.project;
        const block = input.fileDefault === true ? "default" : (input.block ?? "");
        const agent = report.agents.find((entry) => entry.project === project && entry.block === block) ?? null;
        const moves = input.answer === "update" || input.answer === "auto";
        const changes = moves && agent !== null
          ? agent.outdated.map((stage) => ({ project, block, stage: stage.stage, from: stage.model, to: stage.latest }))
          : [];
        return { root: report.root, project, block, answer: input.answer, changes, agent };
      },
    },
  });
  realLineup.catalog().catch(() => undefined);

  const server = Bun.serve({
    hostname: HOST,
    port: PORT,
    // A chat's events are long-polled for 25 seconds; Bun's default would cut them at 10.
    idleTimeout: 255,
    fetch: createPreviewRouter({ shell: () => ({ shell, version }), lineup, setupPreview: SETUP_PREVIEW }),
  });

  const mode = process.env.RALPH_PREVIEW_WATCH === "0" ? "fake data" : "fake data, rebuilds on ui/ changes";
  console.log(`ralph-dashboard preview on http://${server.hostname}:${server.port} (${mode})`);
}
