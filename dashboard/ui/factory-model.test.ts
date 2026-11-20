import { describe, expect, it } from "vitest";

import type {
  Dashboard,
  DashboardLoop,
  FrontierTreeNode,
  FrontierView,
  LoopRole,
  PullStatusView,
} from "../contracts";
import { agentState, factoryFloor } from "./factory-model";

const NOW = Date.parse("2026-10-13T14:00:00Z");

/** Every field spelled out, so a field added to `DashboardLoop` fails to compile here rather than reach the floor undefined. */
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

const dashboard = (loops: DashboardLoop[], view: FrontierView, prs: PullStatusView[] = []): Dashboard => ({
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

describe("the factory floor", () => {
  it("lanes a coder's tickets by what is happening to them", () => {
    const floor = factoryFloor(
      [
        {
          id: "loggd",
          dashboard: dashboard(
            [
              loop("ralph", "coder", { issue: 1 }),
              loop("rafa", "coder", { supervisor: "dead" }),
              loop("remo", "coder", { loopStatus: "idle", issue: 9 }),
            ],
            frontier({
              inFlight: [inFlight(1, "ralph"), inFlight(2, "rafa")],
              tree: roots(
                node(1, "in-flight"),
                node(2, "in-flight"),
                node(3, "ready"),
                node(4, "blocked", { stuck: "ralph-blocked" }),
                node(5, "open", { human: "ready-for-human" }),
                node(6, "blocked"),
                node(7, "done"),
              ),
            }),
          ),
        },
      ],
      NOW,
    );
    expect(floor.lanes.map((lane) => lane.role)).toEqual(["coder"]);
    expect(floor.lanes[0]!.cells.map((cell) => [cell.number, cell.state])).toEqual([
      [1, "working"],
      [2, "waiting"],
      [3, "queued"],
      [4, "waiting"],
      [5, "waiting"],
      [6, "queued"],
    ]);
    // remo is live but between tickets: its stale issue number does not make it running.
    expect(floor.lanes[0]).toMatchObject({ agents: 3, running: 1 });
    expect(floor).toMatchObject({ tasks: 6, active: 1, shipped: 0 });
  });

  it("ships a PR merged in the last day and drops an older one", () => {
    const prs: PullStatusView[] = [
      { issue: 7, pr: 70, state: "merged", draft: false, mergedAt: "2026-10-13T09:00:00Z" },
      { issue: 8, pr: 80, state: "merged", draft: false, mergedAt: "2026-10-11T09:00:00Z" },
    ];
    const floor = factoryFloor(
      [{ id: "loggd", dashboard: dashboard([loop("ralph", "coder")], frontier({ tree: roots(node(7, "done")) }), prs) }],
      NOW,
    );
    expect(floor.lanes[0]!.cells).toMatchObject([
      { number: 7, state: "shipped", title: "ticket 7", url: "https://github.com/o/r/pull/70" },
    ]);
    expect(floor.shipped).toBe(1);
  });

  it("gives the other agent types their own lanes, across projects", () => {
    const floor = factoryFloor(
      [
        {
          id: "loggd",
          dashboard: dashboard(
            [loop("tria", "triager", { issue: 40, issueTitle: "triage me" }), loop("doc", "ci-doctor")],
            frontier({ triage: { staffing: 0, routing: 0, intake: 2, oversize: 0, rescue: 0 } }),
          ),
        },
        {
          id: "factory",
          dashboard: dashboard([loop("medic", "pr-medic", { issue: 12 })], frontier()),
        },
        { id: "down", dashboard: null },
      ],
      NOW,
    );
    expect(floor.lanes.map((lane) => [lane.role, lane.cells.map((cell) => `${cell.project}:${cell.state}`)])).toEqual([
      ["triager", ["loggd:working", "loggd:queued", "loggd:queued"]],
      ["pr-medic", ["factory:working"]],
      ["ci-doctor", []],
    ]);
  });

  it("is empty with no agents and no work", () => {
    expect(factoryFloor([{ id: "loggd", dashboard: null }], NOW)).toEqual({
      lanes: [],
      tasks: 0,
      active: 0,
      shipped: 0,
      agents: 0,
    });
  });
});

describe("an agent's state", () => {
  it("reads working, waiting, idle, paused, blocked and down from the loop record", () => {
    expect(agentState(loop("a", "coder"))).toBe("working");
    expect(
      agentState(loop("a", "coder", { lastEvent: { name: "pr-wait", at: "2026-10-13T13:00:00Z", detail: "PR #1 ci" } })),
    ).toBe("waiting");
    expect(agentState(loop("a", "coder", { loopStatus: "idle", issue: 9 }))).toBe("idle");
    expect(agentState(loop("a", "coder", { stage: "paused", loopStatus: "idle" }))).toBe("paused");
    expect(agentState(loop("a", "coder", { loopStatus: "blocked" }))).toBe("blocked");
    expect(agentState(loop("a", "coder", { loopStatus: "failed" }))).toBe("blocked");
    expect(agentState(loop("a", "coder", { supervisor: "dead" }))).toBe("down");
    expect(agentState(loop("a", "coder", { loopStatus: "stale" }))).toBe("down");
  });

  it("puts one square per agent in its lane, across projects, linking to the loop page", () => {
    const floor = factoryFloor(
      [
        { id: "loggd", dashboard: dashboard([loop("ralph", "coder"), loop("doc", "ci-doctor", { loopStatus: "idle" })], frontier()) },
        { id: "factory", dashboard: dashboard([loop("rafa", "coder", { supervisor: "dead" })], frontier()) },
      ],
      NOW,
    );
    expect(floor.agents).toBe(3);
    expect(floor.lanes.map((lane) => [lane.role, lane.agentCells.map((agent) => `${agent.loop}:${agent.state}`)])).toEqual([
      ["coder", ["ralph:working", "rafa:down"]],
      ["ci-doctor", ["doc:idle"]],
    ]);
    expect(floor.lanes[0]!.agentCells[1]!.href).toBe("/p/factory/loops/rafa");
  });
});
