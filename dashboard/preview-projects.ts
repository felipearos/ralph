/**
 * The design preview's other projects: five scenarios beside the original
 * "preview" gallery, so the project rail and the CI health page can be
 * clicked through over many shapes rather than one.
 *
 * - `atlas`: a healthy, quiet project — main green, nothing open, a calm trend.
 * - `harbor`: a project whose roster has no ci-doctor at all.
 * - `kiln`: a project whose CI health store could not be read.
 * - `foundry`: a bad day — main red for hours, incidents, a wall of flakes.
 * - `meadow`: a project just set up — main never measured, no trend recorded.
 *
 * Each world is built from the preview's own builders (`PreviewKit`), handed
 * in by `preview.ts` rather than imported from it: this module is imported BY
 * that one, and a run-time import back would read its builders before they
 * are defined. Only types cross the other way. Every store below is the raw
 * shape `ci-doctor/scan.ts` writes and is folded with the real `foldCiHealth`,
 * for the same reason the gallery's is: a fold bug must show up here too.
 */
import { foldCiHealth } from "./ci-health";
import type {
  CiWaitsView,
  ControlView,
  FrontierRead,
  FrontierView,
  JournalEntryView,
  LearningsRead,
  LoopRole,
  PresenceView,
  ProjectView,
} from "./contracts";
import { previewLearning, type CannedLoop, type FakeLoop, type FeedRow, type PreviewWorld } from "./preview";

/** The preview's builders, as `preview.ts` hands them over. */
export interface PreviewKit {
  ago: (seconds: number) => string;
  feed: (loop: string, rows: FeedRow[]) => PresenceView["recent"];
  controlView: (loop: string, over?: Partial<ControlView>) => ControlView;
  presence: (loop: string, overrides: Partial<PresenceView> & Pick<PresenceView, "status" | "supervisor">) => PresenceView;
  cannedLoop: (over: Partial<CannedLoop> & Pick<CannedLoop, "presence">) => CannedLoop;
  feeds: { running: FeedRow[]; gate: FeedRow[]; blocked: FeedRow[] };
}

/** The retry allowance every store below is folded against: `ciDoctor.retry.perDay`'s default. */
const RETRY_CAP = 6;

type PresenceIssue = PresenceView["issues"][number];

/** The phase a role without phases is drawn in: observe still reports one. */
const IMPLEMENT: PresenceView["phase"] = { index: 2, total: 5, label: "Implement" };

/** A project registered from this machine, its folder named after its id. */
const projectAt = (id: string, addedAt: string): ProjectView => ({ id, path: `/home/dev/${id}`, addedAt, source: "local" });

/** A frontier with nothing in it but what is passed in. */
function frontier(now: string, over: Partial<FrontierView> = {}): FrontierRead {
  return {
    readAt: now,
    view: {
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
      human: [],
      ...over,
    },
    problem: null,
  };
}

/** A ready ticket as one root of its own group, for the tree. */
const looseReady = (number: number, title: string): FrontierView["tree"][number] => ({
  spec: null,
  under: null,
  subSpecs: [],
  total: 1,
  complete: false,
  specStillOpen: false,
  roots: [{ number, title, state: "ready", stuck: null, detail: null, otherBlockers: [], heldBy: null, frees: 0, human: null, children: [] }],
});

/** No learnings filed yet: the panel's empty state. */
const noLearnings = (): LearningsRead => ({ base: "https://github.com/felipearos/ralph/blob/main", sources: [] });

/** The wait medians, as `readCiWaits` would fold a project's logs. */
const waits = (day: CiWaitsView["day"], week: CiWaitsView["week"]): CiWaitsView => ({ day, week, unreadable: [] });

/** A journal, one row per entry: [loop, secondsAgo, issue, title, outcome]. */
function journalOf(kit: PreviewKit, rows: [loop: string, secondsAgo: number, issue: number, title: string, outcome: string][]): () => JournalEntryView[] {
  return () =>
    rows.map(([loop, seconds, issue, title, outcome]) => ({
      name: `${kit.ago(seconds).slice(0, 10)}-${issue}.md`,
      at: kit.ago(seconds),
      issue,
      loop,
      title,
      outcome,
    }));
}

/**
 * A loop of one project: its checkout under the project's worktrees folder,
 * and the control view pointed at it, so a command and the panel agree on
 * where the loop lives.
 */
function loopIn(
  kit: PreviewKit,
  root: string,
  name: string,
  role: LoopRole,
  canned: () => CannedLoop,
  { control = {}, claims = [] }: { control?: Partial<ControlView>; claims?: number[] } = {},
): [string, FakeLoop] {
  const worktree = `${root}/${name}`;
  return [name, { name, role, worktree, control: kit.controlView(name, { worktree, ...control }), canned, facts: {}, claims }];
}

/** A loop mid-iteration on `issue`, its presence listing `issues`. */
function working(
  kit: PreviewKit,
  name: string,
  issue: number | null,
  issues: PresenceIssue[],
  action: string,
  phase: PresenceView["phase"],
  over: Partial<CannedLoop> = {},
): () => CannedLoop {
  return () =>
    kit.cannedLoop({
      ...over,
      presence: kit.presence(name, {
        status: "running",
        supervisor: "alive",
        issue,
        issues,
        warning: null,
        step: { stage: "orchestrator", action },
        phase,
      }),
    });
}

/**
 * Alive between iterations with nothing to take: the supervisor is up, the
 * stage is a gate, and `classifyLoop` calls that `idle`.
 */
function idle(kit: PreviewKit, name: string, why: string, issues: PresenceIssue[] = []): () => CannedLoop {
  return () =>
    kit.cannedLoop({
      loopStatus: "idle",
      stage: "gate",
      phase: null,
      iteration: { index: 12, max: 50 },
      lastEvent: { name: "frontier.empty", at: kit.ago(640) },
      presence: kit.presence(name, {
        status: "idle",
        supervisor: "alive",
        issue: null,
        issues,
        actors: [],
        recent: [],
        warning: null,
        step: { stage: "orchestrator", action: why },
        phase: { index: 1, total: 5, label: "Select + map" },
        iteration: { index: 12, max: 50 },
      }),
    });
}

/** A loop that stopped on its own: completed, blocked or failed, the supervisor gone. */
function stopped(
  kit: PreviewKit,
  name: string,
  kind: "completed" | "blocked" | "failed",
  why: string,
  issue: number | null,
  issues: PresenceIssue[],
  over: Partial<CannedLoop> = {},
): () => CannedLoop {
  return () =>
    kit.cannedLoop({
      loopStatus: kind,
      supervisor: "dead",
      stage: "stopped",
      stopReason: { kind, why, at: kit.ago(2700) },
      phase: null,
      iteration: { index: 9, max: 50 },
      lastEvent: { name: `iteration.${kind}`, at: kit.ago(2700) },
      ...over,
      presence: kit.presence(name, {
        status: kind,
        supervisor: "dead",
        issue,
        issues,
        warning: null,
        step: null,
        phase: { index: 2, total: 5, label: "Implement" },
        failureReason: kind === "completed" ? null : why,
        recent: kind === "completed" ? [] : kit.feed(name, kit.feeds.blocked),
      }),
    });
}

/** One of the presence's ticket rows. */
const row = (
  kit: PreviewKit,
  issue: number,
  state: PresenceIssue["state"],
  title: string,
  secondsAgo: number,
  extra: Partial<PresenceIssue> = {},
): PresenceIssue => ({ issue, state, pr: null, draft: false, title, detail: null, block: null, at: kit.ago(secondsAgo), ...extra });

/* ---------------------------------------------------------- atlas: healthy */

/**
 * Main green for two days, every build of the last day passed, nothing open,
 * no flakes, nothing parked, no retries spent and a near-flat trend: the
 * picture the CI page draws on a good week, which is most of them.
 */
function atlasStore(now: string): unknown {
  const nowMs = Date.parse(now);
  const before = (seconds: number) => new Date(nowMs - seconds * 1000).toISOString();
  const greens = [1800, 9000, 21_000, 38_000, 61_000, 79_000];
  return {
    version: 1,
    cursor: now,
    jobsSeen: {},
    failures: [],
    builds: greens.map((seconds, index) => ({
      number: 5_240 - index * 3,
      branch: "main",
      commit: `4be1c0${index}a9f3d2e7`,
      state: "passed",
      startedAt: before(seconds),
      finishedAt: before(seconds - 420),
      createdAt: before(seconds),
    })),
    cases: {
      // Closed weeks ago: the scan keeps it, and the panel must not head it "open".
      "infra:apt mirror timeout": {
        kind: "infra",
        state: "fixed",
        evidence: [{ build: 5_011, branch: "main", commit: "e0e0e0e", kind: "bootstrap", line: "Temporary failure resolving 'deb.debian.org'" }],
        cost72h: { redBuilds: 0, mainReds: 0, dequeues: 0 },
        issue: null,
        pr: null,
        fixAttempts: 1,
        unparks: {},
      },
    },
    main: { state: "green", since: before(172_800), build: 5_240 },
    leases: {},
    retries: { day: new Date(nowMs).toISOString().slice(0, 10), count: 0, byCase: {} },
    reverts: {},
    metrics: Object.fromEntries(
      [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0].map((reds, back) => [
        new Date(nowMs - back * 86_400_000).toISOString().slice(0, 10),
        { knownFlakeReds: reds, parkedOnFlake: 0 },
      ]),
    ),
    backfill: null,
  };
}

function atlas(kit: PreviewKit): PreviewWorld {
  const root = "/home/dev/atlas/worktrees";
  const shipped = [row(kit, 412, "merged", "Pagination on the invoices list", 5400, { pr: 418 })];
  return {
    project: projectAt("atlas", "2026-08-12T09:30:00.000Z"),
    root,
    repoUrl: "https://github.com/acme/atlas",
    loops: new Map([
      loopIn(
        kit,
        root,
        "ada",
        "coder",
        working(kit, "ada", 431, [row(kit, 431, "active", "CSV export for the ledger", 1100), ...shipped], "running the test gate", {
          index: 3,
          total: 5,
          label: "Verify and fix",
        }),
        { claims: [431] },
      ),
      loopIn(kit, root, "ike", "coder", idle(kit, "ike", "frontier empty, next look in 10 min", shipped)),
      loopIn(kit, root, "dot", "ci-doctor", idle(kit, "dot", "main green, no case to work")),
    ]),
    ciHealth: (now) => ({
      readAt: now,
      view: foldCiHealth(atlasStore(now), RETRY_CAP, Date.parse(now), waits(
        { ciIterations: 4, ciMinutes: 6.5, queueIterations: 2, queueMinutes: 3.1 },
        { ciIterations: 27, ciMinutes: 6.9, queueIterations: 15, queueMinutes: 3.8 },
      )),
      problem: null,
    }),
    frontier: (now) =>
      frontier(now, {
        ready: [{ spec: null, staffingGroup: null, waiting: 0, tickets: [{ number: 433, title: "Dark mode for the settings pages", frees: 0, stuck: null }] }],
        inFlight: [{ number: 431, title: "CSV export for the ledger", loop: "ada", claim: "ada-wip", queued: true }],
        tree: [looseReady(433, "Dark mode for the settings pages")],
      }),
    learnings: noLearnings,
    strays: () => [],
    reconciliation: { orphaned: [], prunable: [] },
    claimTitles: { 431: "CSV export for the ledger" },
    journal: journalOf(kit, [
      ["ada", 5400, 412, "Pagination on the invoices list", "merged"],
      ["ike", 31_000, 409, "Retry webhook deliveries", "merged"],
      ["dot", 86_000, 405, "Flaky date picker test", "merged"],
    ]),
  };
}

/* ---------------------------------------------------- harbor: no ci-doctor */

/**
 * A roster with every role but a ci-doctor: the CI page says so rather than
 * drawing a doctor-less panel, and the Agents page shows the other roles —
 * a triager, a pr-medic, a verifier that finished its pass, a coder held
 * on an approval.
 */
function harbor(kit: PreviewKit): PreviewWorld {
  const root = "/home/dev/harbor/worktrees";
  return {
    project: projectAt("harbor", "2026-09-03T14:00:00.000Z"),
    root,
    repoUrl: "https://github.com/acme/harbor",
    loops: new Map([
      loopIn(
        kit,
        root,
        "hal",
        "coder",
        () =>
          kit.cannedLoop({
            stage: "gate",
            presence: kit.presence("hal", {
              status: "running",
              supervisor: "alive",
              issue: 88,
              issues: [row(kit, 88, "pr", "Booking confirmation emails", 2400, { pr: 91 })],
              warning: null,
              step: { stage: "orchestrator", action: "waiting for approval" },
              recent: kit.feed("hal", kit.feeds.gate),
              phase: { index: 5, total: 5, label: "Finish" },
            }),
          }),
        {
          claims: [88],
          control: {
            status: "held",
            hold: { kind: "approval", why: "Merge PR #91 into main?", since: kit.ago(1260), gate: "merge" },
            pendingApprovals: [{ gate: "merge", question: "Merge PR #91 into main?", since: kit.ago(1260) }],
          },
        },
      ),
      loopIn(
        kit,
        root,
        "tide",
        "triager",
        working(kit, "tide", 97, [], "splitting an oversize ticket", IMPLEMENT, { phase: null }),
      ),
      loopIn(
        kit,
        root,
        "medi",
        "pr-medic",
        working(kit, "medi", 84, [row(kit, 84, "pr", "Harbor map clustering", 3000, { pr: 86 })], "rebasing PR #86 onto main", IMPLEMENT, { phase: null }),
      ),
      loopIn(kit, root, "vera", "verifier", stopped(kit, "vera", "completed", "verified 6 merged tickets, nothing to reopen", null, [])),
    ]),
    // No doctor writes a store here, so the read is the empty picture — the
    // page never reaches it: no ci-doctor in the roster is what it reports.
    ciHealth: (now) => ({ readAt: now, view: foldCiHealth(undefined, RETRY_CAP, Date.parse(now)), problem: null }),
    frontier: (now) =>
      frontier(now, {
        inFlight: [{ number: 88, title: "Booking confirmation emails", loop: "hal", claim: "hal-wip", queued: false }],
        untriaged: [{ number: 97, title: "Everything about berths, v2" }],
        triage: { staffing: 0, routing: 1, intake: 2, oversize: 1, rescue: 0 },
      }),
    learnings: noLearnings,
    strays: () => [],
    reconciliation: { orphaned: [], prunable: ["/home/dev/harbor/worktrees/old-hal"] },
    claimTitles: { 88: "Booking confirmation emails" },
    journal: journalOf(kit, [
      ["tide", 1800, 95, "Berth pricing rules", "split into #98, #99"],
      ["tide", 7400, 93, "App crashes sometimes", "triaged (needs-info)"],
      ["vera", 2700, 80, "Tide table widget", "verified"],
      ["hal", 26_000, 82, "Harbor master contact card", "merged"],
    ]),
  };
}

/* ------------------------------------------------ kiln: store unreadable */

/**
 * The doctor runs, but the store cannot be read: `readCiHealth`'s one
 * `view: null` answer, a checkout whose git directory it cannot find. The
 * page has nothing to fold and must say why rather than draw zeros.
 */
function kiln(kit: PreviewKit): PreviewWorld {
  const root = "/home/dev/kiln/worktrees";
  return {
    project: projectAt("kiln", "2026-10-20T08:15:00.000Z"),
    root,
    repoUrl: "https://github.com/acme/kiln",
    loops: new Map([
      loopIn(
        kit,
        root,
        "kit",
        "ci-doctor",
        stopped(kit, "kit", "failed", "ci-doctor scan exited 1: the checkout's .git is gone", null, [], {
          runnerFailures: [],
        }),
      ),
      loopIn(
        kit,
        root,
        "kip",
        "coder",
        stopped(kit, "kip", "blocked", "needs-migration: apply drizzle/0031_glaze_batches.sql before merging", 214, [
          row(kit, 214, "blocked", "Glaze batch tracking", 2900, { pr: 219, draft: true, detail: "needs-migration", block: "migration" }),
        ]),
      ),
      loopIn(
        kit,
        root,
        "sen",
        "sentinel",
        working(kit, "sen", null, [], "reading new Sentry issues since 06:00", IMPLEMENT, { phase: null }),
      ),
    ]),
    ciHealth: (now) => ({ readAt: now, view: null, problem: "could not read /home/dev/kiln/worktrees/kit/.git" }),
    frontier: (now) =>
      frontier(now, {
        stuck: [{ number: 214, title: "Glaze batch tracking", label: "kip-blocked" }],
        stuckReasons: [
          {
            number: 214,
            title: "Glaze batch tracking",
            kind: "migration",
            reason: "needs-migration: draft PR #219 ready; apply drizzle/0031_glaze_batches.sql (new table) before merging",
            pr: 219,
            migration: "drizzle/0031_glaze_batches.sql",
            at: kit.ago(2900),
            park: null,
          },
        ],
      }),
    learnings: noLearnings,
    strays: () => [],
    reconciliation: { orphaned: ["/home/dev/kiln/worktrees/kit"], prunable: [] },
    claimTitles: { 214: "Glaze batch tracking" },
  };
}

/* ------------------------------------------------------ foundry: bad day */

/** The flaky cases of the bad day, more than the table's limit so it shows "+N more". */
const FOUNDRY_FLAKES: [subject: string, state: string, redBuilds: number, issue: number | null, pr: number | null][] = [
  ["apps/web/src/checkout/cart.test.ts > applies the coupon once", "fixing", 11, 2214, 2220],
  ["apps/web/src/checkout/address.test.ts > validates postcodes", "confirmed", 9, 2215, null],
  ["packages/ui/src/date-picker.test.tsx > opens on focus", "filed", 8, 2209, null],
  ["apps/api/src/orders/refund.test.ts > refunds partially", "confirmed", 7, null, null],
  ["apps/web/e2e/login.spec.ts > remembers the device", "fixing", 7, 2198, 2203],
  ["packages/search/src/rank.test.ts > ties break by recency", "candidate", 6, null, null],
  ["apps/api/src/webhooks/stripe.test.ts > retries on 502", "filed", 5, 2187, null],
  ["apps/web/src/catalog/filters.test.ts > keeps the sort", "candidate", 4, null, null],
  ["apps/worker/src/mailer.test.ts > batches digests", "confirmed", 4, 2216, null],
  ["packages/ui/src/toast.test.tsx > stacks three", "candidate", 3, null, null],
  ["apps/web/e2e/search.spec.ts > shows suggestions", "candidate", 3, null, null],
  ["apps/api/src/inventory/reserve.test.ts > releases on timeout", "filed", 2, 2190, null],
  ["apps/worker/src/thumbnails.test.ts > resizes webp", "candidate", 2, null, null],
  ["packages/i18n/src/plural.test.ts > handles Polish", "fixed", 1, 2150, 2158],
  ["apps/web/src/account/avatar.test.ts > crops square", "retired", 1, 2121, null],
];

/**
 * Everything at once, badly: main red for five and a half hours on a
 * regression, two open infra incidents (the disk one reported, the registry
 * one not yet), fifteen flaky cases, four parked tickets — two unparked
 * before — the day's retries spent, one revert open and one abandoned, and
 * waits long enough to be the day's real cost. The trend climbs to today.
 */
function foundryStore(now: string): unknown {
  const nowMs = Date.parse(now);
  const before = (seconds: number) => new Date(nowMs - seconds * 1000).toISOString();
  const minutesAfter = (at: string, minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();
  const reds = [
    { number: 8_812, startedAt: before(19_800), minutes: 22 },
    { number: 8_815, startedAt: before(16_200), minutes: 19 },
    { number: 8_818, startedAt: before(12_600), minutes: 24 },
    { number: 8_821, startedAt: before(9000), minutes: 17 },
    { number: 8_824, startedAt: before(5400), minutes: 21 },
    { number: 8_826, startedAt: before(2400), minutes: 18 },
    { number: 8_790, startedAt: before(54_000), minutes: 14 },
  ];
  const regression = "regression:apps/api/src/billing/invoice.test.ts > rounds tax per line";
  const cart = `flake:${FOUNDRY_FLAKES[0]![0]}`;
  const login = `flake:${FOUNDRY_FLAKES[4]![0]}`;
  const flakes = Object.fromEntries(
    FOUNDRY_FLAKES.map(([subject, state, redBuilds, issue, pr], index) => [
      `flake:${subject}`,
      {
        kind: "flake",
        state,
        evidence: reds.slice(0, 1 + (index % 3)).map((red) => ({
          build: red.number,
          branch: index % 2 === 0 ? "main" : `fern/${2200 + index}-work`,
          commit: "77ab01c",
          kind: index % 4 === 0 ? "assertion" : "timeout",
          line: index % 4 === 0 ? "expected 2 to be 1" : "Test timed out in 10000ms",
        })),
        cost72h: { redBuilds, mainReds: index < 3 ? 1 : 0, dequeues: index % 3 },
        issue,
        pr,
        fixAttempts: pr === null ? 0 : 1,
        unparks: {},
        ...(state === "candidate" ? {} : { rule: "timeout-only" }),
      },
    ]),
  );
  return {
    version: 1,
    cursor: now,
    jobsSeen: {},
    failures: [],
    builds: reds.map((red) => ({
      number: red.number,
      branch: "main",
      commit: "c41d9e07b2a85f6e3d1c0b9a8f7e6d5c4b3a2910",
      state: "failed",
      startedAt: red.startedAt,
      finishedAt: minutesAfter(red.startedAt, red.minutes),
      createdAt: red.startedAt,
    })),
    cases: {
      ...flakes,
      [regression]: {
        kind: "regression",
        state: "fixing",
        evidence: reds.slice(0, 6).map((red) => ({ build: red.number, branch: "main", commit: "c41d9e0", kind: "assertion", line: "expected 10.07 to be 10.08" })),
        cost72h: { redBuilds: 9, mainReds: 6, dequeues: 4 },
        issue: 2211,
        pr: 2219,
        fixAttempts: 2,
        unparks: {},
        rule: "main-red-since",
      },
      "infra:runner disk full": {
        kind: "infra",
        state: "confirmed",
        evidence: [{ build: 8_818, branch: "main", commit: "c41d9e0", kind: "bootstrap", line: "No space left on device" }],
        cost72h: { redBuilds: 6, mainReds: 2, dequeues: 1 },
        issue: null,
        pr: null,
        fixAttempts: 0,
        unparks: {},
        rule: "infra-signature",
        notified: "ci-incident:disk-full",
      },
      // Open and NOT reported yet: no `notified`, so the panel says so.
      "infra:npm registry 503": {
        kind: "infra",
        state: "candidate",
        evidence: [{ build: 8_826, branch: "main", commit: "c41d9e0", kind: "bootstrap", line: "npm ERR! 503 Service Unavailable - GET https://registry.npmjs.org/esbuild" }],
        cost72h: { redBuilds: 2, mainReds: 1, dequeues: 0 },
        issue: null,
        pr: null,
        fixAttempts: 0,
        unparks: {},
        rule: "infra-signature",
      },
      "parked:2190": {
        kind: "parked",
        state: "confirmed",
        evidence: [],
        cost72h: { redBuilds: 0, mainReds: 0, dequeues: 0 },
        issue: 2190,
        pr: 2195,
        fixAttempts: 0,
        rule: cart,
        unparks: { [cart]: [before(140_000), before(61_000)] },
      },
      "parked:2193": {
        kind: "parked",
        state: "handed-off",
        evidence: [],
        cost72h: { redBuilds: 0, mainReds: 0, dequeues: 0 },
        issue: 2193,
        pr: 2197,
        fixAttempts: 0,
        rule: login,
        unparks: { [login]: [before(200_000), before(90_000), before(7200)], [regression]: [before(3000)] },
      },
      "parked:2201": {
        kind: "parked",
        state: "confirmed",
        evidence: [],
        cost72h: { redBuilds: 0, mainReds: 0, dequeues: 0 },
        issue: 2201,
        pr: null,
        fixAttempts: 0,
        rule: regression,
        unparks: {},
      },
      "parked:2206": {
        kind: "parked",
        state: "candidate",
        evidence: [],
        cost72h: { redBuilds: 0, mainReds: 0, dequeues: 0 },
        issue: 2206,
        pr: 2208,
        fixAttempts: 0,
        rule: cart,
        unparks: {},
      },
    },
    main: { state: "red", since: before(19_800), build: 8_812 },
    leases: {
      [regression]: { run: "run-dex-01", loop: "dex", pid: 40_112, host: "foundry-ci", expiresAt: new Date(nowMs + 120_000).toISOString() },
      [cart]: { run: "run-dara-01", loop: "dara", pid: 40_377, host: "foundry-ci", expiresAt: new Date(nowMs + 45_000).toISOString() },
    },
    retries: { day: new Date(nowMs).toISOString().slice(0, 10), count: RETRY_CAP, byCase: { [cart]: "88a1f0", [login]: "88a20c" } },
    reverts: {
      // The culprit of today's red: its revert is open, the forward fix filed.
      c41d9e07b2a85f6e3d1c0b9a8f7e6d5c4b3a2910: { case: regression, issue: 2211, pr: 2222, forwardIssue: 2223, state: "open" },
      // Given up on: the revert conflicted with a later migration.
      "9b8a7f6e5d4c": { case: login, issue: 2198, pr: 2200, forwardIssue: null, state: "abandoned" },
    },
    metrics: Object.fromEntries(
      [15, 13, 11, 9, 8, 7, 6, 5, 4, 4, 3, 2, 2, 1].map((redCount, back) => [
        new Date(nowMs - back * 86_400_000).toISOString().slice(0, 10),
        { knownFlakeReds: redCount, parkedOnFlake: Math.max(0, 5 - Math.floor(back / 2)) },
      ]),
    ),
    backfill: null,
  };
}

function foundry(kit: PreviewKit): PreviewWorld {
  const root = "/home/dev/foundry/worktrees";
  const parkedRows = [
    row(kit, 2190, "blocked", "Reserve stock at checkout", 61_000, { pr: 2195, detail: "parked on a flake", block: "other" }),
    row(kit, 2193, "handoff", "Remember this device", 7200, { pr: 2197, detail: "unparked 4 times; needs a human" }),
  ];
  return {
    project: projectAt("foundry", "2026-06-30T11:00:00.000Z"),
    root,
    repoUrl: "https://github.com/acme/foundry",
    loops: new Map([
      loopIn(
        kit,
        root,
        "dex",
        "ci-doctor",
        working(kit, "dex", 2211, [row(kit, 2211, "active", "Invoice tax rounding regressed on main", 4800, { pr: 2219 })], "bisecting main: 3 commits left", {
          index: 3,
          total: 5,
          label: "Verify and fix",
        }),
        { claims: [2211] },
      ),
      loopIn(
        kit,
        root,
        "dara",
        "ci-doctor",
        working(kit, "dara", 2214, [row(kit, 2214, "active", "Flaky coupon test in the cart", 2100, { pr: 2220 })], "measuring cart.test.ts, run 4 of 5", {
          index: 3,
          total: 5,
          label: "Verify and fix",
        }),
        { claims: [2214] },
      ),
      loopIn(
        kit,
        root,
        "fern",
        "coder",
        () =>
          kit.cannedLoop({
            stage: "gate",
            presence: kit.presence("fern", {
              status: "running",
              supervisor: "alive",
              issue: 2222,
              issues: [row(kit, 2222, "pr", "Revert c41d9e0: invoice rounding", 900, { pr: 2222 }), ...parkedRows],
              warning: "main is red; merge queue paused",
              step: { stage: "orchestrator", action: "waiting for approval" },
              recent: kit.feed("fern", kit.feeds.gate),
              phase: { index: 5, total: 5, label: "Finish" },
            }),
          }),
        {
          claims: [2222],
          control: {
            status: "held",
            hold: { kind: "approval", why: "Merge the revert PR #2222 while main is red?", since: kit.ago(1500), gate: "merge" },
            pendingApprovals: [{ gate: "merge", question: "Merge the revert PR #2222 while main is red?", since: kit.ago(1500) }],
          },
        },
      ),
      loopIn(
        kit,
        root,
        "flo",
        "coder",
        stopped(kit, "flo", "blocked", "The gate failed three times on the same flaky test.", 2190, parkedRows),
        { control: { loopStatus: "blocked", status: "blocked" } },
      ),
      loopIn(
        kit,
        root,
        "fox",
        "coder",
        stopped(kit, "fox", "failed", "executor exited 137: out of memory during the e2e gate", 2201, [
          row(kit, 2201, "failed", "Bulk order import", 3400, { pr: 2205, draft: true, detail: "gate failed 3 times" }),
        ], {
          runnerFailures: [
            {
              at: kit.ago(2750),
              loop: "fox",
              run: "run-fox-01",
              iteration: 9,
              stage: "executor",
              runner: "codex",
              model: "gpt-5-codex",
              issue: 2201,
              exitCode: 137,
              kind: "crash",
              summary: "killed by the OOM killer during playwright",
              visibility: "live",
              evidence: ["Killed", "exit status 137"],
              note: null,
            },
          ],
        }),
      ),
      loopIn(
        kit,
        root,
        "max",
        "pr-medic",
        working(kit, "max", 2195, [row(kit, 2195, "pr", "Reserve stock at checkout", 61_000, { pr: 2195 })], "re-running CI on PR #2195 (retries spent)", IMPLEMENT, {
          phase: null,
        }),
      ),
    ]),
    ciHealth: (now) => ({
      readAt: now,
      view: foldCiHealth(foundryStore(now), RETRY_CAP, Date.parse(now), waits(
        { ciIterations: 14, ciMinutes: 41.5, queueIterations: 9, queueMinutes: 73.2 },
        { ciIterations: 66, ciMinutes: 24.8, queueIterations: 40, queueMinutes: 38.9 },
      )),
      problem: null,
    }),
    frontier: (now) =>
      frontier(now, {
        inFlight: [
          { number: 2211, title: "Invoice tax rounding regressed on main", loop: "dex", claim: "dex-wip", queued: true },
          { number: 2214, title: "Flaky coupon test in the cart", loop: "dara", claim: "dara-wip", queued: true },
          { number: 2222, title: "Revert c41d9e0: invoice rounding", loop: "fern", claim: "fern-wip", queued: false },
        ],
        stuck: [
          { number: 2190, title: "Reserve stock at checkout", label: "flo-blocked" },
          { number: 2201, title: "Bulk order import", label: "fox-blocked" },
          { number: 2226, title: "Apply coupons to gift cards", label: "flo-blocked" },
        ],
        stuckReasons: [
          { number: 2190, title: "Reserve stock at checkout", kind: "other", reason: "Blocked: parked on the flaky coupon test (#2214).", pr: 2195, migration: null, at: kit.ago(61_000), park: null },
          { number: 2201, title: "Bulk order import", kind: "unknown", reason: null, pr: 2205, migration: null, at: null, park: null },
          // A live park: its budget runs past the preview's clock, so the page
          // shows it in its own muted panel rather than asking anyone to act.
          {
            number: 2226,
            title: "Apply coupons to gift cards",
            kind: "other",
            reason: "Blocked: waiting for the coupon flake fix (#2214) to land.",
            pr: 2228,
            migration: null,
            at: kit.ago(5400),
            park: {
              loop: "flo",
              label: "flo-blocked",
              pr: 2228,
              summary: "the coupon flake fix (#2214) to land",
              condition: { kind: "reference", ref: "#2214" },
              since: kit.ago(5400),
              budgetUntil: new Date(Date.parse(now) + 6 * 3600_000).toISOString(),
              remainingSeconds: 6 * 3600,
              expired: false,
              escalatedAt: null,
            },
          },
        ],
        human: [{ number: 2193, title: "Remember this device", reason: "ready-for-human" }],
      }),
    learnings: () => ({
      base: "https://github.com/felipearos/ralph/blob/main",
      sources: [
        {
          scope: "project",
          file: "learnings/foundry.md",
          entries: [previewLearning({ title: "The e2e gate needs 6 GB on the runner", date: "2026-11-01", fix: "no issue yet." })],
          fixed: [],
          present: true,
        },
      ],
    }),
    strays: () => [],
    reconciliation: { orphaned: [], prunable: [] },
    claimTitles: {
      2211: "Invoice tax rounding regressed on main",
      2214: "Flaky coupon test in the cart",
      2222: "Revert c41d9e0: invoice rounding",
    },
    journal: journalOf(kit, [
      ["dex", 15_000, 2187, "Stripe webhook retry flake", "filed"],
      ["dara", 40_000, 2209, "Date picker focus flake", "filed"],
      ["fern", 52_000, 2180, "Order history filters", "merged"],
      ["flo", 61_000, 2190, "Reserve stock at checkout", "parked"],
      ["fox", 2700, 2201, "Bulk order import", "failed"],
    ]),
  };
}

/* ---------------------------------------------- meadow: never measured */

/**
 * Set up this morning: the doctor's first scan found no main build yet, so
 * main is `unknown` with no since and no build, nothing is recorded for the
 * trend, and no wait has been timed. The page must read as "not yet", never
 * as "all clear".
 */
function meadowStore(now: string): unknown {
  return {
    version: 1,
    cursor: now,
    jobsSeen: {},
    failures: [],
    builds: [],
    cases: {},
    // What the store writes before it has seen main: build 0 beside an empty since.
    main: { state: "unknown", since: "", build: 0 },
    leases: {},
    retries: { day: null, count: 0, byCase: {} },
    reverts: {},
    metrics: {},
    backfill: null,
  };
}

function meadow(kit: PreviewKit): PreviewWorld {
  const root = "/home/dev/meadow/worktrees";
  return {
    project: projectAt("meadow", "2026-11-05T07:40:00.000Z"),
    root,
    repoUrl: "https://github.com/acme/meadow",
    loops: new Map([
      loopIn(
        kit,
        root,
        "mei",
        "ci-doctor",
        () =>
          kit.cannedLoop({
            iteration: { index: 1, max: 50 },
            phase: "select",
            lastEvent: { name: "iteration.started", at: kit.ago(40) },
            presence: kit.presence("mei", {
              status: "running",
              supervisor: "alive",
              issue: null,
              issues: [],
              actors: [],
              recent: [],
              warning: null,
              step: { stage: "orchestrator", action: "first scan: waiting for a main build" },
              phase: { index: 1, total: 5, label: "Select + map" },
              iteration: { index: 1, max: 50 },
            }),
          }),
      ),
      loopIn(kit, root, "milo", "coder", stopped(kit, "milo", "completed", "frontier empty after the first ticket", null, [
        row(kit, 3, "merged", "Project scaffold and README", 2700, { pr: 4 }),
      ])),
    ]),
    ciHealth: (now) => ({
      readAt: now,
      view: foldCiHealth(meadowStore(now), RETRY_CAP, Date.parse(now), waits(
        { ciIterations: 0, ciMinutes: null, queueIterations: 0, queueMinutes: null },
        { ciIterations: 0, ciMinutes: null, queueIterations: 0, queueMinutes: null },
      )),
      problem: null,
    }),
    frontier: (now) => frontier(now),
    learnings: noLearnings,
    strays: () => [],
    reconciliation: { orphaned: [], prunable: [] },
    claimTitles: {},
    journal: journalOf(kit, [["milo", 2700, 3, "Project scaffold and README", "merged"]]),
  };
}

/**
 * A small project with one running coder, a name no other project's loop
 * has: switching to it in a browser shows `wido` and none of `preview`'s,
 * which is how the end-to-end suite tells the two pages apart.
 */
function widgets(kit: PreviewKit): PreviewWorld {
  const root = "/home/dev/widgets-worktrees";
  return {
    project: projectAt("widgets", "2026-10-02T00:00:00.000Z"),
    root,
    repoUrl: "https://github.com/acme/widgets",
    loops: new Map([
      loopIn(kit, root, "wido", "coder", () => kit.cannedLoop({ presence: kit.presence("wido", { status: "running", supervisor: "alive" }) })),
    ]),
    ciHealth: (now) => ({
      readAt: now,
      view: foldCiHealth(meadowStore(now), RETRY_CAP, Date.parse(now), waits(
        { ciIterations: 0, ciMinutes: null, queueIterations: 0, queueMinutes: null },
        { ciIterations: 0, ciMinutes: null, queueIterations: 0, queueMinutes: null },
      )),
      problem: null,
    }),
    frontier: (now) => frontier(now),
    learnings: noLearnings,
    strays: () => [],
    reconciliation: { orphaned: [], prunable: [] },
    claimTitles: {},
    journal: () => [],
  };
}

/** The projects beside "preview", in the order the rail lists them; `widgets` first, as the end-to-end suite expects. */
export function previewProjects(kit: PreviewKit): PreviewWorld[] {
  return [widgets(kit), atlas(kit), foundry(kit), harbor(kit), kiln(kit), meadow(kit)];
}
