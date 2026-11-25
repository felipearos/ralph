/**
 * The triage panel's derivations (#147).
 *
 * The properties are about not overstating: a project with no triager has no
 * panel, an unreadable frontier is an unknown intake rather than an empty one,
 * and only the bucket the intake would actually hand over is marked as the one
 * being worked.
 */
import { describe, expect, it } from "vitest";

import { bucketTone, triagePanel, triageWaiting } from "./triage-model";
import type { Dashboard, DashboardLoop, FrontierView, LoopRole, TriageActivityView } from "../contracts";

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
  dropped: [],
  ...over,
});

const activity = (over: Partial<TriageActivityView> = {}): TriageActivityView => ({
  writesLastHour: 4,
  maxWrites: 30,
  units: [],
  ...over,
});

/**
 * A whole `DashboardLoop`, not a cast over three fields: this file is the only
 * model test that would otherwise cast a contract type, and a cast is exactly
 * what stops a field added to `DashboardLoop` later from reaching `triagePanel`
 * as `undefined` with this suite still green.
 */
const loop = (name: string, role: LoopRole, triage: TriageActivityView | null = null): DashboardLoop => ({
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
  repoUrl: null,
  presence: null,
  issueTitle: null,
  actors: [],
  presenceProblem: null,
  claims: [],
  usage: null,
  journal: null,
  timeline: null,
  runnerFailure: { state: "none", reason: null, current: false },
  triage,
});

const dashboard = (loops: DashboardLoop[], view: FrontierView | null = frontier()): Dashboard => ({
  generatedAt: "2026-09-30T12:00:00.000Z",
  loops,
  reconciliation: { orphaned: [], prunable: [] },
  unattributed: [],
  ownership: { issues: [], contested: [], sources: { leases: "ok", github: "ok" } },
  frontier: {
    readAt: "2026-09-30T12:00:00.000Z",
    view,
    problem: view === null ? "gh failed" : null,
  },
  ciHealth: null,
  following: null,
  learnings: null,
});

describe("the triage panel", () => {
  it("is absent for a project that staffs no triager", () => {
    // Not an empty panel: four zeroes would read as a cleared backlog rather
    // than as a question nobody on this project is asking.
    expect(triagePanel(dashboard([loop("ralph", "coder"), loop("rafa", "coder")]))).toBeNull();
  });

  it("lists every bucket, and marks only the one the intake hands over next", () => {
    const panel = triagePanel(
      dashboard([loop("tria", "triager", activity())], frontier({ triage: { staffing: 0, routing: 3, intake: 7, oversize: 1, rescue: 2 } })),
    );
    expect(panel?.buckets).toEqual([
      { bucket: "staffing", count: 0, next: false },
      { bucket: "routing", count: 3, next: true },
      { bucket: "intake", count: 7, next: false },
      { bucket: "oversize", count: 1, next: false },
      { bucket: "rescue", count: 2, next: false },
    ]);
    // The bigger bucket behind the leading one is backlog, not what is next.
    expect(triageWaiting(panel!)).toBe(13);
  });

  it("marks nothing as leading when the whole intake is clear", () => {
    const panel = triagePanel(dashboard([loop("tria", "triager", activity())]));
    expect(panel?.buckets?.every((row) => !row.next)).toBe(true);
    expect(triageWaiting(panel!)).toBe(0);
  });

  it("keeps an unreadable frontier unknown rather than clear", () => {
    const panel = triagePanel(dashboard([loop("tria", "triager", activity())], null));
    expect(panel?.buckets).toBeNull();
    expect(panel?.untriaged).toBeNull();
    expect(triageWaiting(panel!)).toBeNull();
    // The triager's own row still shows: its writes do not come from the frontier.
    expect(panel?.triagers).toEqual([{ loop: "tria", writesLastHour: 4, maxWrites: 30, units: [] }]);
  });

  it("carries the untriaged count the routing bucket is drawn from", () => {
    const panel = triagePanel(
      dashboard(
        [loop("tria", "triager", activity())],
        frontier({
          untriaged: [
            { number: 1131, title: "a" },
            { number: 1132, title: "b" },
          ],
          triage: { staffing: 0, routing: 1, intake: 0, oversize: 0, rescue: 0 },
        }),
      ),
    );
    // Routing is UNTRIAGED after the triager's eligibility fence, so a smaller
    // routing count beside a larger UNTRIAGED is correct, not a bug.
    expect(panel?.untriaged).toBe(2);
    expect(panel?.buckets?.find((row) => row.bucket === "routing")?.count).toBe(1);
  });

  it("gives one row per triager, with its units and unknown writes kept unknown", () => {
    const panel = triagePanel(
      dashboard([
        loop("ralph", "coder"),
        loop("tria", "triager", activity({ units: [{ issue: 1131, at: null, outcome: "routed (7 tickets)", title: "t" }] })),
        loop("trib", "triager", activity({ writesLastHour: null, maxWrites: 12 })),
      ]),
    );
    expect(panel?.triagers).toEqual([
      { loop: "tria", writesLastHour: 4, maxWrites: 30, units: [{ issue: 1131, at: null, outcome: "routed (7 tickets)", title: "t" }] },
      { loop: "trib", writesLastHour: null, maxWrites: 12, units: [] },
    ]);
  });
});

describe("how a bucket's count reads", () => {
  it("calls out only the bucket being worked", () => {
    expect(bucketTone({ bucket: "routing", count: 3, next: true })).toBe("info");
    expect(bucketTone({ bucket: "intake", count: 7, next: false })).toBe("neutral");
  });

  it("leaves a cleared intake entirely neutral", () => {
    // The panel-level fact, not a second copy of the line above: with nothing
    // waiting, no bucket is `next`, so none is tinted — colouring a cleared
    // intake would make the good case look like an alert.
    const panel = triagePanel(dashboard([loop("tria", "triager", activity())]));
    expect(panel?.buckets?.map(bucketTone)).toEqual(["neutral", "neutral", "neutral", "neutral", "neutral"]);
  });
});
