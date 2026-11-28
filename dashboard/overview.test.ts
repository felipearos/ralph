import { describe, expect, it } from "vitest";
import {
  OVERVIEW_RECENT_ROWS,
  type ActivityView,
  type CiHealthRead,
  type Dashboard,
  type DashboardLoop,
  type FrontierRead,
  type FrontierTreeGroup,
  type FrontierView,
  type LearningsRead,
  type PresenceView,
  type PullStatusView,
} from "./contracts";
import { overviewOf } from "./overview";

const AT = "2026-11-28T10:00:00.000Z";

const activity = (index: number): ActivityView => ({
  stage: "coder",
  label: `step ${index}: ran the targeted tests for acme-widgets, read the gate's verdict and wrote the journal entry`,
  at: new Date(Date.parse(AT) + index * 1000).toISOString(),
  iteration: 1 + Math.floor(index / 20),
  run: "run-1",
});

const presence = (loop: string, rows: number): PresenceView => ({
  loop,
  run: "run-1",
  status: "running",
  supervisor: "alive",
  issue: 12,
  branch: `${loop}/12-acme-widgets`,
  iteration: null,
  observedAt: AT,
  issues: [],
  actors: [],
  recent: Array.from({ length: rows }, (_, index) => activity(index)),
  failureReason: null,
  step: null,
  phase: { index: 1, total: 5, label: "implement" },
  warning: null,
});

// The panel's other fields do not concern the projection, which copies them as they are.
const loopOf = (loop: string, rows: number | null): DashboardLoop =>
  ({ loop, role: "coder", present: true, presence: rows === null ? null : presence(loop, rows) }) as DashboardLoop;

const ticket = (number: number) => ({ number, title: `Widget ${number}: make the acme-widgets export survive a slow tracker` });

const treeOf = (nodes: number): FrontierTreeGroup[] =>
  Array.from({ length: Math.ceil(nodes / 10) }, (_, group) => ({
    spec: { number: 1000 + group, title: `Spec ${group}: the acme-widgets reporting pipeline`, state: null, detail: null, stuck: null, blockers: [] },
    under: null,
    subSpecs: [],
    total: 10,
    complete: false,
    children: Array.from({ length: 10 }, (_, index) => ({
      ...ticket(group * 10 + index),
      state: "ready",
      stuck: null,
      detail: null,
      otherBlockers: [],
      heldBy: null,
      frees: 0,
      human: null,
    })),
  })) as unknown as FrontierTreeGroup[];

const viewOf = (nodes: number): FrontierView => ({
  ready: [{ spec: ticket(1), staffingGroup: null, waiting: 0, tickets: [{ ...ticket(2), frees: 1, stuck: null }] }],
  occupied: [{ ...ticket(3), heldBy: 2 }],
  specs: [{ ...ticket(1), children: 4 }],
  inFlight: [{ ...ticket(4), loop: "ralph", claim: "ralph-wip", queued: false }],
  blocked: [{ ...ticket(5), blockers: [4], stuck: null }],
  gates: [ticket(4)],
  stuck: [{ ...ticket(6), label: "ralph-blocked" }],
  tree: treeOf(nodes),
  stuckReasons: [],
  untriaged: [ticket(7)],
  triage: { routing: 1 } as FrontierView["triage"],
  human: [],
  dropped: [],
});

const prsOf = (count: number): PullStatusView[] =>
  Array.from({ length: count }, (_, index) => ({ issue: index, pr: 2000 + index, state: "merged", draft: false, mergedAt: AT }));

const frontierOf = (nodes: number, prs: number): FrontierRead => ({
  readAt: AT,
  view: viewOf(nodes),
  problem: null,
  failedAt: null,
  prs: prsOf(prs),
});

// Opaque bulk: the projection drops both whole, so only their weight matters here.
const learningsOf = (bytes: number): LearningsRead =>
  ({ base: null, sources: [{ text: "Learned: read the acme-widgets gate log first. ".repeat(bytes / 48) }] }) as unknown as LearningsRead;
const ciHealthOf = (bytes: number): CiHealthRead =>
  ({ readAt: AT, problem: null, view: { notes: "acme-widgets main went red on the build step. ".repeat(bytes / 46) } }) as unknown as CiHealthRead;

const dashboardOf = (loops: DashboardLoop[], frontier: FrontierRead | null, over: Partial<Dashboard> = {}): Dashboard =>
  ({
    generatedAt: AT,
    loops,
    reconciliation: { orphaned: [], prunable: [] },
    unattributed: [],
    ownership: { claims: [] },
    frontier,
    ciHealth: ciHealthOf(1000),
    learnings: learningsOf(1000),
    following: null,
    tracker: null,
    ...over,
  }) as unknown as Dashboard;

describe("overviewOf", () => {
  it("keeps each loop's newest recent rows, in order, and says how many there were", () => {
    const full = dashboardOf([loopOf("ralph", 200), loopOf("rafa", 3), loopOf("remo", null)], null);
    const [ralph, rafa, remo] = overviewOf(full).loops;
    expect(ralph!.presence!.recent).toEqual(full.loops[0]!.presence!.recent.slice(200 - OVERVIEW_RECENT_ROWS));
    expect(ralph!.presence!.recent.map((row) => row.label)).toEqual(
      Array.from({ length: OVERVIEW_RECENT_ROWS }, (_, index) => activity(200 - OVERVIEW_RECENT_ROWS + index).label),
    );
    expect(ralph!.presence!.recentTotal).toBe(200);
    expect(rafa!.presence!.recent).toEqual(full.loops[1]!.presence!.recent);
    expect(rafa!.presence!.recentTotal).toBe(3);
    expect(remo!.presence).toBeNull();
    // The rest of a panel is carried as it is.
    expect(ralph!.presence!.branch).toBe("ralph/12-acme-widgets");
    expect(ralph!.role).toBe("coder");
  });

  it("drops the tree, the PR states, the learnings and the CI health, at runtime", () => {
    const full = dashboardOf([loopOf("ralph", 10)], frontierOf(20, 5));
    const overview = overviewOf(full);
    expect("learnings" in overview).toBe(false);
    expect("ciHealth" in overview).toBe(false);
    expect("prs" in overview.frontier!).toBe(false);
    expect("tree" in overview.frontier!.view!).toBe(false);
    const { tree: _tree, ...buckets } = full.frontier!.view!;
    expect(overview.frontier!.view).toEqual(buckets);
    expect(overview.frontier!.readAt).toBe(AT);
    expect(overview.frontier!.problem).toBeNull();
    expect(overview.frontier!.failedAt).toBeNull();
    expect(overview.ownership).toEqual(full.ownership);
    expect(overview.generatedAt).toBe(AT);
    expect(overview.following).toBeNull();
  });

  it("keeps a missing frontier, or a frontier with no view, null", () => {
    expect(overviewOf(dashboardOf([], null)).frontier).toBeNull();
    const unread: FrontierRead = { readAt: AT, view: null, problem: "the tracker timed out", prs: null };
    const overview = overviewOf(dashboardOf([], unread));
    expect(overview.frontier).toEqual({ readAt: AT, view: null, problem: "the tracker timed out" });
  });

  it("never changes the dashboard it is handed", () => {
    const full = dashboardOf([loopOf("ralph", 200), loopOf("rafa", null)], frontierOf(30, 10));
    const before = structuredClone(full);
    overviewOf(full);
    expect(full).toEqual(before);
  });

  it("answers a busy project in well under the full body's weight", () => {
    const loops = ["ralph", "rafa", "remo", "rulo", "rio", "rosa", "rita", "raul", "rene"].map((name) => loopOf(name, 200));
    const full = dashboardOf(loops, frontierOf(850, 300), { learnings: learningsOf(44_000), ciHealth: ciHealthOf(20_000) });
    // The fixture must stay as busy as the project #67 measured, or the cap proves nothing.
    expect(JSON.stringify(full).length).toBeGreaterThanOrEqual(600_000);
    expect(JSON.stringify(overviewOf(full)).length).toBeLessThan(150_000);
  });
});
