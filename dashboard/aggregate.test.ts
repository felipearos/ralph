// @vitest-environment node
/**
 * The projection is pure: typed runtime view models in, one dashboard out.
 *
 * These cases are about *selection and honesty* rather than rendering. The
 * runtime reports every registered worktree — buildkite runners, temporary
 * checkouts, a loop in a worktree nobody expected — and the dashboard must
 * present exactly the roster, attribute each loop's own signals, and say
 * `unknown` rather than invent a healthy loop from absent data.
 */
import { describe, expect, it } from "vitest";

import { aggregateDashboard } from "./aggregate";
import type {
  ActorView,
  CiCaseView,
  CiHealthRead,
  Clock,
  LoopStateView,
  PresenceView,
  RuntimeLoop,
  RuntimeSnapshot,
} from "./contracts";
import { coderRoster } from "./contracts";

const clock: Clock = { nowMs: Date.parse("2026-09-13T12:00:00.000Z") };

const state = (over: Partial<LoopStateView> = {}): LoopStateView => ({
  version: 1,
  run: "ralph-run-1",
  owner: { loop: "ralph", pid: 4242, host: "desktop" },
  worktree: "/checkout/ralph",
  branch: "ralph/919-scaffold",
  stage: "iteration",
  iteration: { index: 2, max: 50 },
  heartbeat: "2026-09-13T11:59:00.000Z",
  lastEvent: { name: "iteration-start", at: "2026-09-13T11:59:00.000Z" },
  stopReason: null,
  ...over,
});

const presence = (over: Partial<PresenceView> = {}): PresenceView => ({
  loop: "ralph",
  run: "ralph-run-1",
  status: "running",
  supervisor: "alive",
  issue: 919,
  branch: "ralph/919-scaffold",
  iteration: { index: 2, max: 50 },
  observedAt: "2026-09-13T11:59:30.000Z",
  issues: [],
  actors: [],
  recent: [],
  failureReason: null,
  step: null,
  phase: { index: 1, total: 5, label: "select and map" },
  warning: null,
  ...over,
});

const actor = (over: Partial<ActorView> = {}): ActorView => ({
  stage: "executor",
  state: "running",
  invocation: "inv-1",
  runner: "claude",
  model: "opus",
  startedAt: "2026-09-13T11:58:00.000Z",
  endedAt: null,
  lastAction: "tool Bash — bun run test",
  activityAt: "2026-09-13T11:59:10.000Z",
  ...over,
});

const loop = (over: Partial<RuntimeLoop> = {}): RuntimeLoop => ({
  worktree: "/checkout/ralph",
  identity: "ralph",
  loopStatus: "running",
  worktreeStatus: "live",
  branch: "ralph/919-scaffold",
  state: state(),
  stateProblem: null,
  supervisor: "alive",
  presence: presence(),
  repoUrl: "https://github.com/felipearos/loggd",
  ...over,
});

const runtime = (over: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot => ({
  roster: coderRoster("ralph", "rafa", "remo", "rulo"),
  loops: [],
  reconciliation: { orphaned: [], prunable: [] },
  ...over,
});

describe("the role a loop holds", () => {
  it("reports every roster loop's role, present or absent, and a bare name as a coder", () => {
    const snapshot = runtime({
      roster: [
        { name: "ralph", role: "coder" },
        { name: "tria", role: "triager" },
        { name: "doc", role: "ci-doctor" },
      ],
      loops: [loop({ worktree: "/w/ralph", identity: "ralph" })],
    });
    const byLoop = new Map(aggregateDashboard(snapshot, clock).loops.map((entry) => [entry.loop, entry]));
    // The absent loops matter as much as the present one: a panel with no
    // checkout still has to say which role's rules it is read under.
    expect(byLoop.get("ralph")).toMatchObject({ present: true, role: "coder" });
    expect(byLoop.get("tria")).toMatchObject({ present: false, role: "triager" });
    expect(byLoop.get("doc")).toMatchObject({ present: false, role: "ci-doctor" });
    expect(aggregateDashboard(runtime(), clock).loops.map((entry) => entry.role)).toEqual([
      "coder",
      "coder",
      "coder",
      "coder",
    ]);
  });
});

describe("the retry a loop is on", () => {
  it("carries a runtime loop's retry view through, and leaves it absent when there is none", () => {
    const retry = { attempt: 2, of: 3, cause: "no-sigil", nextAt: "2026-09-13T12:20:00.000Z", spent: false };
    const snapshot = runtime({
      loops: [loop({ worktree: "/w/ralph", identity: "ralph", retry }), loop({ worktree: "/w/rafa", identity: "rafa" })],
    });
    const byLoop = new Map(aggregateDashboard(snapshot, clock).loops.map((entry) => [entry.loop, entry]));
    expect(byLoop.get("ralph")?.retry).toEqual(retry);
    // Absent, not an `undefined` key: the page reads a missing line as "not
    // being retried", and the JSON must not differ between the two.
    expect("retry" in byLoop.get("rafa")!).toBe(false);
  });
});

describe("the case a doctor holds", () => {
  const kase = (over: Partial<CiCaseView> = {}): CiCaseView => ({
    key: "flake:a.test.ts > one",
    subject: "a.test.ts > one",
    kind: "flake",
    state: "confirmed",
    redBuilds: 3,
    mainReds: 0,
    dequeues: 0,
    issue: 90,
    pr: null,
    rule: "timeout-only",
    heldBy: "doc",
    notified: false,
    ...over,
  });

  const health = (over: Partial<NonNullable<CiHealthRead["view"]>> = {}): CiHealthRead => ({
    readAt: "2026-09-13T11:59:00.000Z",
    view: {
      main: { state: "green", since: "2026-09-13T09:00:00.000Z", build: 400 },
      cases: [],
      incidents: [],
      parked: [],
      retries: { day: "2026-09-13", count: 0, cap: 6, today: true },
      reverts: [],
      lostTime: { reds: 0, medianBuildMinutes: null, minutes: null },
      metrics: { days: [], reds: 0, parkedPeak: 0, recorded: false },
      waits: {
        day: { ciIterations: 0, ciMinutes: null, queueIterations: 0, queueMinutes: null },
        week: { ciIterations: 0, ciMinutes: null, queueIterations: 0, queueMinutes: null },
        unreadable: [],
      },
      held: [],
      ...over,
    },
    problem: null,
  });

  /** A doctor and a coder in one project, both reported by the runtime. */
  const staffed = (ciHealth: CiHealthRead | undefined): Map<string, { case: CiCaseView | null }> => {
    const snapshot = runtime({
      roster: [{ name: "ralph", role: "coder" }, { name: "doc", role: "ci-doctor" }],
      loops: [
        loop({ worktree: "/w/ralph", identity: "ralph" }),
        loop({ worktree: "/w/doc", identity: "doc", state: state({ owner: { loop: "doc", pid: 7, host: "desktop" } }) }),
      ],
      ...(ciHealth === undefined ? {} : { ciHealth }),
    });
    return new Map(aggregateDashboard(snapshot, clock).loops.map((entry) => [entry.loop, entry]));
  };

  it("shows the doctor the case its own lease holds", () => {
    const byLoop = staffed(health({ cases: [kase()], held: [kase()] }));
    expect(byLoop.get("doc")?.case).toMatchObject({ key: "flake:a.test.ts > one", heldBy: "doc" });
  });

  it("shows a doctor holding nothing an empty case line, not a guess at the worst one", () => {
    // The worst case in the table is NOT the doctor's case: `held` is empty.
    const byLoop = staffed(health({ cases: [kase({ heldBy: null })], held: [] }));
    expect(byLoop.get("doc")?.case).toBeNull();
  });

  it("finds an infra incident the doctor holds too: a lease is a lease", () => {
    const incident = kase({ key: "infra:agent lost", subject: "agent lost", kind: "infra" });
    const byLoop = staffed(health({ incidents: [incident], held: [incident] }));
    expect(byLoop.get("doc")?.case).toMatchObject({ key: "infra:agent lost" });
  });

  it("finds a PARKED ticket the doctor holds, which no drawn list carries", () => {
    // `ci-doctor/gate.ts` returns `parked:<issue>` as a work verdict and the
    // gate leases whatever key it returns, but a parked case is drawn in
    // `parked` and never in `cases`. Searching the drawn lists reported
    // "holding no case" for a doctor that was mid-unpark.
    const held = kase({ key: "parked:1109", subject: "1109", kind: "parked", state: "handed-off" });
    const byLoop = staffed(
      health({ parked: [{ issue: 1109, state: "handed-off", rule: "flake:a", unparks: [], heldBy: "doc" }], held: [held] }),
    );
    expect(byLoop.get("doc")?.case).toMatchObject({ key: "parked:1109" });
  });

  it("takes the first held case in cost order when a leaked lease leaves two", () => {
    const worst = kase({ key: "flake:worst", mainReds: 3 });
    const lesser = kase({ key: "flake:lesser", mainReds: 0 });
    const byLoop = staffed(health({ held: [worst, lesser] }));
    expect(byLoop.get("doc")?.case?.key).toBe("flake:worst");
  });

  it("leaves a coder's case line null even when a lease names it, because the ROLE decides", () => {
    // A coder cannot take a case lease, so a store naming one is drift or a
    // leaked lease — never a reason to show a coder somebody else's panel.
    const byLoop = staffed(health({ held: [kase({ heldBy: "ralph" })] }));
    expect(byLoop.get("ralph")?.case).toBeNull();
  });

  it("reads an unread store as no case rather than as no work", () => {
    // Both are null on the card. The difference is reported by the panel's own
    // `problem`, not by inventing a third state here.
    expect(staffed(undefined).get("doc")?.case).toBeNull();
    expect(staffed({ readAt: "2026-09-13T11:59:00.000Z", view: null, problem: "could not read .git" }).get("doc")?.case)
      .toBeNull();
  });

  it("holds nothing for a roster loop the runtime never reported", () => {
    const snapshot = runtime({
      roster: [{ name: "doc", role: "ci-doctor" }],
      ciHealth: health({ cases: [kase()], held: [kase()] }),
    });
    expect(aggregateDashboard(snapshot, clock).loops[0]).toMatchObject({ present: false, case: null });
  });
});

describe("aggregating CI health", () => {
  it("carries the adapter's read through untouched, and null when there was none", () => {
    const read: CiHealthRead = { readAt: "2026-01-01T00:00:00.000Z", view: null, problem: "could not read .git" };
    expect(aggregateDashboard(runtime({ ciHealth: read }), clock).ciHealth).toEqual(read);
    expect(aggregateDashboard(runtime(), clock).ciHealth).toBeNull();
  });
});

describe("aggregating the frontier", () => {
  it("carries the adapter's backlog read through untouched, and null when there was none", () => {
    const read = { readAt: "2026-01-01T00:00:00.000Z", view: null, problem: "gh: not logged in" };
    expect(aggregateDashboard(runtime({ frontier: read }), clock).frontier).toEqual(read);
    expect(aggregateDashboard(runtime(), clock).frontier).toBeNull();
  });
});

describe("aggregating the following", () => {
  it("carries the adapter's Following read through untouched, and null when there was none", () => {
    const read = { readAt: "2026-01-01T00:00:00.000Z", view: null, problem: "the watch store is unreadable" };
    expect(aggregateDashboard(runtime({ following: read }), clock).following).toEqual(read);
    expect(aggregateDashboard(runtime(), clock).following).toBeNull();
  });
});

describe("aggregating the roster", () => {
  it("presents exactly the roster, in roster order, even when the runtime reports nothing", () => {
    const dashboard = aggregateDashboard(runtime(), clock);
    expect(dashboard.loops.map((entry) => entry.loop)).toEqual(["ralph", "rafa", "remo", "rulo"]);
    expect(dashboard.loops.every((entry) => entry.present === false)).toBe(true);
  });

  it("renders a roster loop with no worktree as unknown, never as a healthy loop", () => {
    const dashboard = aggregateDashboard(
      runtime({ loops: [loop({ identity: "ralph" })] }),
      clock,
    );
    const rafa = dashboard.loops.find((entry) => entry.loop === "rafa");
    expect(rafa?.present).toBe(false);
    expect(rafa?.loopStatus).toBe("unknown");
    expect(rafa?.worktreeStatus).toBe("unknown");
    expect(rafa?.supervisor).toBe("unknown");
    expect(rafa?.run).toBeNull();
    expect(rafa?.branch).toBeNull();
  });

  it("excludes a worktree that is not attributed to a roster loop", () => {
    const dashboard = aggregateDashboard(
      runtime({
        loops: [
          loop({ worktree: "/checkout/ralph", identity: "ralph" }),
          loop({ worktree: "/checkout/buildkite", identity: null }),
          loop({ worktree: "/checkout/tmp", identity: "renovate" }),
        ],
      }),
      clock,
    );
    expect(dashboard.loops.map((entry) => entry.worktree)).toEqual([
      "/checkout/ralph",
      null,
      null,
      null,
    ]);
  });

  it("keeps reconciliation data separate from the loop panels", () => {
    const dashboard = aggregateDashboard(
      runtime({
        loops: [loop({ worktree: "/checkout/old", identity: null, worktreeStatus: "orphaned" })],
        reconciliation: { orphaned: ["/checkout/old"], prunable: ["/checkout/gone"] },
      }),
      clock,
    );
    expect(dashboard.reconciliation).toEqual({
      orphaned: ["/checkout/old"],
      prunable: ["/checkout/gone"],
    });
    expect(dashboard.loops.some((entry) => entry.worktree === "/checkout/old")).toBe(false);
  });
});

describe("attributing a loop's signals", () => {
  it("carries durable status, worktree status, branch and identity from the record", () => {
    const dashboard = aggregateDashboard(runtime({ loops: [loop()] }), clock);
    expect(dashboard.loops[0]).toMatchObject({
      loop: "ralph",
      present: true,
      worktree: "/checkout/ralph",
      loopStatus: "running",
      worktreeStatus: "live",
      branch: "ralph/919-scaffold",
      supervisor: "alive",
      run: "ralph-run-1",
      issue: 919,
      iteration: { index: 2, max: 50 },
      stage: "iteration",
      repoUrl: "https://github.com/felipearos/loggd",
    });
    expect(aggregateDashboard(runtime(), clock).loops[0]?.repoUrl).toBeNull();
  });

  it("prefers a worktree that has a durable record when two claim one loop", () => {
    // A moved or copied checkout can leave two registry entries naming the same
    // loop. The one with the record is the loop; the other is a stale copy.
    const dashboard = aggregateDashboard(
      runtime({
        loops: [
          loop({ worktree: "/checkout/copy", state: null, presence: null, loopStatus: "unknown" }),
          loop({ worktree: "/checkout/real", loopStatus: "idle" }),
        ],
      }),
      clock,
    );
    expect(dashboard.loops[0]).toMatchObject({
      present: true,
      worktree: "/checkout/real",
      loopStatus: "idle",
    });
  });

  it("reports unknown when the record is unreadable rather than blanking the response", () => {
    const dashboard = aggregateDashboard(
      runtime({
        loops: [
          loop({
            loopStatus: "unknown",
            state: null,
            stateProblem: "unreadable",
            presence: null,
          }),
        ],
      }),
      clock,
    );
    expect(dashboard.loops[0]).toMatchObject({
      present: true,
      loopStatus: "unknown",
      stateProblem: "unreadable",
      presence: null,
    });
  });

  it("falls back to the presence run and iteration when the record is absent", () => {
    const dashboard = aggregateDashboard(
      runtime({
        loops: [
          loop({
            state: null,
            loopStatus: "unknown",
            stateProblem: "missing",
            presence: presence({ run: "from-observe", iteration: { index: 9, max: null } }),
          }),
        ],
      }),
      clock,
    );
    expect(dashboard.loops[0]).toMatchObject({
      run: "from-observe",
      iteration: { index: 9, max: null },
      issue: 919,
    });
  });

  it("carries the phase of the iteration in progress, and null when the record names none", () => {
    const phased = aggregateDashboard(runtime({ loops: [loop({ state: state({ phase: "verify" }) })] }), clock);
    expect(phased.loops[0]?.phase).toBe("verify");
    expect(aggregateDashboard(runtime({ loops: [loop()] }), clock).loops[0]?.phase).toBeNull();
    expect(aggregateDashboard(runtime(), clock).loops[0]?.phase).toBeNull();
  });

  it("carries the phase an iteration resumed an interrupted ticket at, and null otherwise", () => {
    const resumed = aggregateDashboard(runtime({ loops: [loop({ state: state({ phase: "verify", resumedAt: "verify" }) })] }), clock);
    expect(resumed.loops[0]).toMatchObject({ phase: "verify", resumedAt: "verify" });
    expect(aggregateDashboard(runtime({ loops: [loop({ state: state({ phase: "verify" }) })] }), clock).loops[0]?.resumedAt).toBeNull();
    expect(aggregateDashboard(runtime(), clock).loops[0]?.resumedAt).toBeNull();
  });

  it("carries the record's heartbeat and last event for the detail view", () => {
    const dashboard = aggregateDashboard(runtime({ loops: [loop()] }), clock);
    expect(dashboard.loops[0]).toMatchObject({
      heartbeat: "2026-09-13T11:59:00.000Z",
      lastEvent: { name: "iteration-start", at: "2026-09-13T11:59:00.000Z" },
    });
    const recordless = aggregateDashboard(runtime({ loops: [loop({ state: null })] }), clock);
    expect(recordless.loops[0]).toMatchObject({ heartbeat: null, lastEvent: null });
  });

  it("stamps the dashboard from the injected clock", () => {
    expect(aggregateDashboard(runtime(), clock).generatedAt).toBe("2026-09-13T12:00:00.000Z");
  });
});

describe("projecting a loop's live actors", () => {
  it("lists every stage actor with its runner, model, state, start/end and last action", () => {
    const dashboard = aggregateDashboard(
      runtime({
        loops: [
          loop({
            presence: presence({
              actors: [
                actor({ stage: "orchestrator", runner: "claude", model: "fable", lastAction: null }),
                actor({
                  stage: "mapper",
                  state: "completed",
                  runner: "opencode",
                  model: "gpt-mini",
                  endedAt: "2026-09-13T11:58:30.000Z",
                }),
                actor(),
              ],
            }),
          }),
        ],
      }),
      clock,
    );
    const ralph = dashboard.loops[0]!;
    expect(ralph.presenceProblem).toBeNull();
    expect(ralph.actors).toEqual([
      actor({ stage: "orchestrator", runner: "claude", model: "fable", lastAction: null }),
      actor({
        stage: "mapper",
        state: "completed",
        runner: "opencode",
        model: "gpt-mini",
        endedAt: "2026-09-13T11:58:30.000Z",
      }),
      actor(),
    ]);
  });

  it("degrades a running actor to unknown when no live supervisor backs it", () => {
    // A timeline with a `started` and no end is what a killed loop leaves
    // behind. Without a live supervisor that is not evidence of running.
    const dashboard = aggregateDashboard(
      runtime({
        loops: [
          loop({
            loopStatus: "stale",
            supervisor: "dead",
            presence: presence({
              status: "stale",
              supervisor: "dead",
              actors: [actor(), actor({ stage: "mapper", state: "completed" })],
            }),
          }),
        ],
      }),
      clock,
    );
    expect(dashboard.loops[0]!.actors.map((entry) => [entry.stage, entry.state])).toEqual([
      ["executor", "unknown"],
      ["mapper", "completed"],
    ]);
  });

  it("reports no actors and an unavailable presence when observe could not be read", () => {
    const dashboard = aggregateDashboard(runtime({ loops: [loop({ presence: null })] }), clock);
    expect(dashboard.loops[0]).toMatchObject({ actors: [], presenceProblem: "unavailable" });
    const absent = dashboard.loops.find((entry) => entry.loop === "rafa");
    expect(absent).toMatchObject({ actors: [], presenceProblem: "unavailable", issueTitle: null });
  });

  it("refuses to adopt presence that observe attributed to another loop", () => {
    // observe names the loop from the record it found for that root; `unknown`
    // (or another loop's name) means its actors are not this loop's.
    const dashboard = aggregateDashboard(
      runtime({
        loops: [
          loop({
            branch: "ralph/77-fix-the-thing",
            presence: presence({ loop: "unknown", issue: 5, actors: [actor()] }),
          }),
        ],
      }),
      clock,
    );
    expect(dashboard.loops[0]).toMatchObject({
      presenceProblem: "unattributed",
      actors: [],
      issue: 77,
      issueTitle: "fix the thing",
    });
  });
});

describe("attributing the current issue and branch", () => {
  it("derives the title from the loop's own issue history when it has one", () => {
    const dashboard = aggregateDashboard(
      runtime({
        loops: [
          loop({
            presence: presence({
              issue: 919,
              issues: [
                { issue: 12, state: "merged", pr: 40, draft: false, title: "Other", detail: null, block: null, at: "T" },
                { issue: 919, state: "handoff", pr: null, draft: false, title: "Dashboard scaffold", detail: null, block: null, at: "T" },
              ],
            }),
          }),
        ],
      }),
      clock,
    );
    expect(dashboard.loops[0]).toMatchObject({
      issue: 919,
      issueTitle: "Dashboard scaffold",
      branch: "ralph/919-scaffold",
      iteration: { index: 2, max: 50 },
    });
  });

  it("falls back to the branch slug for the title when history has none", () => {
    const dashboard = aggregateDashboard(
      runtime({
        loops: [loop({ branch: "ralph/919-loop-detail-panel", presence: presence({ issue: 919 }) })],
      }),
      clock,
    );
    expect(dashboard.loops[0]).toMatchObject({ issue: 919, issueTitle: "loop detail panel" });
  });

  it("leaves the title unknown when the branch belongs to another issue or loop", () => {
    const other = aggregateDashboard(
      runtime({ loops: [loop({ branch: "ralph/12-other", presence: presence({ issue: 919 }) })] }),
      clock,
    );
    expect(other.loops[0]).toMatchObject({ issue: 919, issueTitle: null });
    const foreign = aggregateDashboard(
      runtime({ loops: [loop({ branch: "rafa/919-scaffold", presence: presence({ issue: null }) })] }),
      clock,
    );
    expect(foreign.loops[0]).toMatchObject({ issue: null, issueTitle: null });
  });

  it("reports a worktree with an unresolvable loop record as unattributed, not as a panel", () => {
    const dashboard = aggregateDashboard(
      runtime({
        loops: [
          loop({ worktree: "/checkout/moved", identity: null, state: null, stateProblem: "foreign", loopStatus: "unknown", presence: null }),
          loop({ worktree: "/checkout/renovate", identity: null, state: state({ owner: { loop: "renovate", pid: null, host: "h" } }), presence: null }),
          loop({ worktree: "/checkout/buildkite", identity: null, state: null, stateProblem: "missing", presence: null }),
        ],
      }),
      clock,
    );
    expect(dashboard.loops.every((entry) => !entry.present)).toBe(true);
    expect(dashboard.unattributed).toEqual([
      { worktree: "/checkout/moved", owner: null, loopStatus: "unknown", stateProblem: "foreign" },
      { worktree: "/checkout/renovate", owner: "renovate", loopStatus: "running", stateProblem: null },
    ]);
  });
});
