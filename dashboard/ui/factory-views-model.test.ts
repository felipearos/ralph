import { describe, expect, it } from "vitest";

import type {
  Dashboard,
  DashboardLoop,
  FrontierTreeNode,
  FrontierView,
  LoopRole,
  ParkReason,
  PullStatusView,
  StuckReason,
} from "../contracts";
import {
  agentLine,
  attention,
  pipeline,
  projectSummaries,
  remember,
  sampleOf,
  ticketAsks,
  type Sample,
  tracks,
} from "./factory-views-model";

const NOW = Date.parse("2026-10-13T14:00:00Z");

/** Every field spelled out, so a field added to `DashboardLoop` fails to compile here rather than reach a view undefined. */
const loop = (name: string, role: LoopRole, over: Partial<DashboardLoop> = {}): DashboardLoop => ({
  loop: name,
  role,
  case: null,
  present: true,
  worktree: `/checkout/${name}`,
  loopStatus: "running",
  worktreeStatus: "live",
  branch: null,
  supervisor: "alive",
  run: null,
  issue: null,
  iteration: null,
  stage: null,
  phase: null,
  resumedAt: null,
  stopReason: null,
  stateProblem: null,
  heartbeat: null,
  lastEvent: null,
  repoUrl: "https://github.com/o/r",
  presence: null,
  issueTitle: null,
  actors: [],
  presenceProblem: null,
  claims: [],
  usage: null,
  journal: null,
  timeline: null,
  runnerFailure: { state: "none", reason: null, current: false },
  triage: null,
  ...over,
});

const idle = { loopStatus: "idle", lastEvent: { name: "frontier-wait", at: "2026-10-13T13:59:00Z" } } as const;
const dead = { supervisor: "dead", loopStatus: "interrupted", stage: "stopped" } as const;

const node = (number: number, state: FrontierTreeNode["state"], over: Partial<FrontierTreeNode> = {}): FrontierTreeNode => ({
  number,
  title: `ticket ${number}`,
  state,
  stuck: null,
  detail: null,
  otherBlockers: [],
  heldBy: null,
  frees: 0,
  human: null,
  children: [],
  ...over,
});

const frontier = (over: Partial<FrontierView> = {}): FrontierView => ({
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
});

const dashboard = (loops: DashboardLoop[], view: FrontierView = frontier(), prs: PullStatusView[] = []): Dashboard => ({
  generatedAt: "2026-10-13T14:00:00.000Z",
  loops,
  reconciliation: { orphaned: [], prunable: [] },
  unattributed: [],
  ownership: { issues: [], contested: [], sources: { leases: "ok", github: "ok" } },
  frontier: { readAt: "2026-10-13T14:00:00.000Z", view, problem: null, prs },
  ciHealth: null,
  following: null,
  learnings: null,
});

const roots = (...nodes: FrontierTreeNode[]): FrontierView["tree"] => [
  { spec: null, under: null, subSpecs: [], total: nodes.length, complete: false, specStillOpen: false, roots: nodes },
];

const inFlight = (number: number, owner: string | null) => ({
  number,
  title: `ticket ${number}`,
  loop: owner,
  claim: owner === null ? "PR #9" : `${owner}-wip`,
  queued: true,
});

describe("an agent's line", () => {
  it("writes out what a busy agent is on and drops a quiet agent's stale ticket", () => {
    expect(agentLine("loggd", loop("ralph", "coder", { issue: 7, issueTitle: "fix it", phase: "review" }), NOW)).toMatchObject({
      state: "working",
      issue: 7,
      title: "fix it",
      issueUrl: "https://github.com/o/r/issues/7",
      doing: "review",
    });
    expect(
      agentLine("loggd", loop("rulo", "coder", { issue: 8, lastEvent: { name: "pr-wait", at: "2026-10-13T13:50:00Z" } }), NOW),
    ).toMatchObject({ state: "waiting", issue: 8, doing: "PR wait" });
    expect(agentLine("loggd", loop("remo", "coder", { ...idle, issue: 9 }), NOW)).toMatchObject({
      state: "idle",
      issue: null,
      doing: "nothing to take",
    });
    expect(agentLine("loggd", loop("rita", "coder", dead), NOW)).toMatchObject({ state: "down", doing: "not running" });
  });
});

describe("the projects", () => {
  it("puts the busiest live project first and folds the ones with nothing running", () => {
    const { live, dormant } = projectSummaries(
      [
        { id: "quiet", dashboard: dashboard([loop("ralph", "coder", idle)]) },
        { id: "busy", dashboard: dashboard([loop("ralph", "coder", { issue: 1 }), loop("rita", "coder", dead)], frontier({ inFlight: [inFlight(1, "ralph")], tree: roots(node(1, "in-flight"), node(2, "ready")) })) },
        { id: "gone", dashboard: dashboard([loop("ralph", "coder", dead)]) },
        { id: "slow", dashboard: null },
      ],
      NOW,
    );
    expect(live.map((project) => project.id)).toEqual(["busy", "quiet", "slow"]);
    expect(dormant.map((project) => project.id)).toEqual(["gone"]);
    expect(live[0]).toMatchObject({ busy: 1, states: { working: 1, down: 1 }, tickets: { working: 1, queued: 1 } });
    expect(live[0]!.agents.map((agent) => agent.loop)).toEqual(["ralph", "rita"]);
  });
});

describe("the attention inbox", () => {
  it("asks for the operator on a blocked agent, and counts the tickets that wait on a person by project and reason", () => {
    const reads = [
        {
          id: "loggd",
          dashboard: dashboard(
            [
              loop("ralph", "coder", { issue: 1, lastEvent: { name: "phase", at: "2026-10-13T13:58:00Z" } }),
              loop("rafa", "coder", { issue: 2, lastEvent: { name: "phase", at: "2026-10-13T13:59:00Z" } }),
              loop("rulo", "coder", { loopStatus: "blocked", stopReason: { kind: "blocked", why: "tests red", at: "2026-10-13T13:00:00Z" } }),
              loop("tria", "triager", idle),
              loop("rita", "coder", dead),
            ],
            frontier({
              human: [
                { number: 5, title: "ticket 5", reason: "needs-info" },
                { number: 6, title: "ticket 6", reason: "held" },
              ],
              tree: roots(
                node(7, "blocked", { stuck: "ralph-blocked" }),
                node(8, "done", { stuck: "ralph-blocked" }),
                node(4, "open", { stuck: "rafa-blocked" }),
              ),
            }),
          ),
        },
    ];
    const groups = attention(reads, NOW);
    expect(groups["needs-you"].map((item) => [item.loop, item.why])).toEqual([["rulo", "tests red"]]);
    // A held ticket asks nothing; a closed one is not stuck any more.
    expect(ticketAsks(reads, NOW).map((ask) => [ask.why, ask.tickets.map((ticket) => [ticket.number, ticket.detail]), ask.href])).toEqual([
      ["waits on its reporter", [[5, null]], "/p/loggd/backlog"],
      ["stuck on a blocked label", [[4, "rafa-blocked"], [7, "ralph-blocked"]], "/p/loggd/backlog"],
    ]);
    // The freshest moving agent first.
    expect(groups.moving.map((item) => item.loop)).toEqual(["rafa", "ralph"]);
    expect(groups.idle.map((item) => item.loop)).toEqual(["tria"]);
    expect(groups.down.map((item) => item.loop)).toEqual(["rita"]);
  });
});

describe("ticket asks on a parked ticket", () => {
  const park = (over: Partial<ParkReason> = {}): ParkReason => ({
    loop: "ralph",
    label: "ralph-blocked",
    pr: null,
    summary: "#700 to land",
    condition: { kind: "reference", ref: "#700" },
    since: "2026-10-13T13:00:00Z",
    budgetUntil: "2026-10-13T16:00:00Z",
    remainingSeconds: 7200,
    expired: false,
    escalatedAt: null,
    ...over,
  });
  const reason = (number: number, parked: ParkReason | null): StuckReason => ({
    number,
    title: `ticket ${number}`,
    kind: "migration",
    reason: null,
    pr: null,
    migration: null,
    at: null,
    park: parked,
  });

  it("asks nothing for a live park, and asks under its own reason for a spent one", () => {
    const reads = [
      {
        id: "loggd",
        dashboard: dashboard(
          [loop("ralph", "coder", idle)],
          frontier({
            tree: roots(
              node(1, "blocked", { stuck: "ralph-blocked" }),
              node(2, "blocked", { stuck: "ralph-blocked" }),
              node(3, "blocked", { stuck: "ralph-blocked" }),
              node(4, "blocked", { stuck: "ralph-blocked" }),
              node(5, "blocked", { stuck: "ralph-blocked" }),
            ),
            stuckReasons: [
              reason(1, park()),
              reason(2, park({ expired: true, budgetUntil: "2026-10-13T13:30:00Z", remainingSeconds: 0 })),
              reason(3, park({ expired: true, escalatedAt: "2026-10-13T13:40:00Z", budgetUntil: "2026-10-13T13:30:00Z" })),
              // The view still says live, but the page's clock is past its budget.
              reason(4, park({ budgetUntil: "2026-10-13T13:59:00Z", condition: { kind: "label-removed", label: "needs-design" } })),
              reason(5, null),
            ],
          }),
        ),
      },
    ];
    expect(ticketAsks(reads, NOW).map((ask) => [ask.why, ask.tickets.map((ticket) => [ticket.number, ticket.detail])])).toEqual([
      ["stuck on a blocked label", [[5, "ralph-blocked"]]],
      [
        "park ran out",
        [
          [2, "park ran out: #700 to land never held"],
          [3, "park ran out: #700 to land never held · escalated"],
          [4, "park ran out: label needs-design removed never held"],
        ],
      ],
    ]);
  });
});

describe("the pipeline", () => {
  it("stages each ticket and puts its agent on it, with the rest on the bench", () => {
    const prs: PullStatusView[] = [
      { issue: 2, pr: 20, state: "testing", draft: false, mergedAt: null },
      { issue: 9, pr: 90, state: "merged", draft: false, mergedAt: "2026-10-13T10:00:00Z" },
      { issue: 8, pr: 80, state: "merged", draft: false, mergedAt: "2026-10-10T10:00:00Z" },
    ];
    const [row] = pipeline(
      [
        {
          id: "loggd",
          dashboard: dashboard(
            [
              loop("ralph", "coder", { issue: 1 }),
              loop("rulo", "coder", { issue: 2, lastEvent: { name: "pr-wait", at: "2026-10-13T13:50:00Z" } }),
              loop("medi", "pr-medic", { issue: 30, issueTitle: "tend PR" }),
              loop("tria", "triager", idle),
            ],
            frontier({
              inFlight: [inFlight(1, "ralph"), inFlight(2, "rulo")],
              tree: roots(node(1, "in-flight"), node(2, "in-flight"), node(3, "blocked"), node(4, "ready"), node(9, "done")),
            }),
            prs,
          ),
        },
        { id: "empty", dashboard: dashboard([loop("ralph", "coder", dead)]) },
      ],
      NOW,
    );
    expect(row!.columns.queued.map((chip) => [chip.number, chip.held])).toEqual([
      [4, null],
      [3, "blocked behind another ticket"],
    ]);
    expect(row!.columns.coding.map((chip) => [chip.number, chip.agent?.loop])).toEqual([
      [1, "ralph"],
      [30, "medi"],
    ]);
    expect(row!.columns.review).toMatchObject([{ number: 2, agent: { loop: "rulo", state: "waiting" }, pr: { number: 20, state: "testing" } }]);
    expect(row!.columns.shipped).toMatchObject([{ number: 9, title: "ticket 9", pr: { number: 90, url: "https://github.com/o/r/pull/90" } }]);
    expect(row!.bench.map((agent) => agent.loop)).toEqual(["tria"]);
  });

  it("leaves out a project with no tickets and nothing running", () => {
    expect(pipeline([{ id: "gone", dashboard: dashboard([loop("ralph", "coder", dead)]) }], NOW)).toEqual([]);
  });
});

describe("the timeline", () => {
  const read = (over: Partial<DashboardLoop>) => [{ id: "loggd", dashboard: dashboard([loop("ralph", "coder", over)]) }];

  it("keeps only the busy agents in a sample, and only the window's samples", () => {
    expect(sampleOf(read(idle), NOW).agents).toEqual({});
    expect(sampleOf(read({ issue: 1, phase: "implement" }), NOW).agents).toEqual({
      "loggd:ralph": { state: "working", phase: "implement", issue: 1 },
    });
    const old: Sample = { at: NOW - 3 * 3_600_000, agents: {} };
    const recent: Sample = { at: NOW - 60_000, agents: {} };
    expect(remember([old, recent], { at: NOW, agents: {} }, 2 * 3_600_000).map((sample) => sample.at)).toEqual([NOW - 60_000, NOW]);
  });

  it("draws a bar per stretch of one phase, and ends one at a gap rather than bridging it", () => {
    const at = (minutes: number) => NOW - minutes * 60_000;
    const working = (phase: "implement" | "review") => ({ "loggd:ralph": { state: "working" as const, phase, issue: 1 } });
    const history: Sample[] = [
      { at: at(30), agents: working("implement") },
      { at: at(29), agents: working("implement") },
      { at: at(28), agents: working("review") },
      // The page was closed for twenty minutes.
      { at: at(8), agents: working("review") },
      { at: at(7), agents: {} },
      { at: at(1), agents: working("review") },
    ];
    const [track] = tracks(history, NOW, 2 * 60_000);
    expect(track).toMatchObject({ project: "loggd", loop: "ralph", href: "/p/loggd/loops/ralph" });
    expect(track!.segments.map((segment) => [segment.phase, (NOW - segment.from) / 60_000, (NOW - segment.to) / 60_000])).toEqual([
      ["implement", 30, 28],
      ["review", 28, 26],
      ["review", 8, 7],
      ["review", 1, 0],
    ]);
  });
});
