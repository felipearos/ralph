/**
 * The Following panel's decisions (felipearos/ralph#569).
 *
 * `Dashboard` and `DashboardLoop` are full literals rather than casts, as in
 * `ci-health-model.test.ts`: a cast would let a field added to a contract later
 * reach this panel as `undefined` with the suite still green.
 */
import { describe, expect, it } from "vitest";

import type { Dashboard, DashboardLoop, FollowingRead, FollowingWatchView, LoopRole } from "../contracts";
import { followingPanel } from "./following-model";

const NOW = new Date("2026-10-29T12:00:00.000Z");

const loop = (name: string, role: LoopRole): DashboardLoop => ({
  loop: name,
  role,
  case: null,
  present: true,
  worktree: `/w/${name}`,
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
  presence: null,
  heartbeat: null,
  lastEvent: null,
  repoUrl: null,
  claims: [],
  issueTitle: null,
  actors: [],
  presenceProblem: "unavailable",
  usage: null,
  journal: null,
  timeline: null,
  runnerFailure: { state: "unknown", reason: null, current: false },
  triage: null,
});

const dashboard = (loops: DashboardLoop[], following: FollowingRead | null = null): Dashboard => ({
  generatedAt: "2026-10-29T12:00:00.000Z",
  loops,
  reconciliation: { orphaned: [], prunable: [] },
  unattributed: [],
  ownership: { issues: [], contested: [], sources: { leases: "ok", github: "ok" } },
  frontier: null,
  ciHealth: null,
  following,
  learnings: null,
});

const watch = (over: Partial<FollowingWatchView> = {}): FollowingWatchView => ({
  pr: 2801,
  ticket: 2790,
  ticketRef: "#2790",
  mode: "observe",
  round: 1,
  mergedAt: "2026-10-29T08:00:00.000Z",
  deployedAt: "2026-10-29T08:10:00.000Z",
  deployUrl: null,
  openedAt: "2026-10-29T08:11:00.000Z",
  state: "in-progress",
  nextCheckIn: { offsetHours: 6, dueAt: "2026-10-29T15:00:00.000Z" },
  checkInsDone: 1,
  checkInsTotal: 4,
  verdict: null,
  wouldBe: [],
  notVerifiableLive: [],
  ...over,
});

const read = (watches: FollowingWatchView[]): FollowingRead => ({
  readAt: "2026-10-29T11:59:00.000Z",
  view: { version: 1, watches },
  problem: null,
});

const verifier = [loop("ralph", "coder"), loop("senti", "verifier")];

describe("the Following panel", () => {
  it("is absent for a project that staffs no verifier", () => {
    expect(followingPanel(dashboard([loop("ralph", "coder")], read([watch()])), NOW)).toBeNull();
  });

  it("says so when the adapter supplied no read at all", () => {
    const panel = followingPanel(dashboard(verifier, null), NOW);
    expect(panel?.problem).toBe("the adapter supplied no Following read");
    expect(panel?.readAt).toBeNull();
    expect(panel?.inProgress).toEqual([]);
  });

  it("carries the CLI's problem when the view could not be read", () => {
    const failed: FollowingRead = { readAt: "2026-10-29T11:59:00.000Z", view: null, problem: "following.ts exited 1" };
    const panel = followingPanel(dashboard(verifier, failed), NOW);
    expect(panel?.problem).toBe("following.ts exited 1");
    expect(panel?.readAt).toBe("2026-10-29T11:59:00.000Z");
    expect(followingPanel(dashboard(verifier, { ...failed, problem: null }), NOW)?.problem).toBe("no reason was reported");
  });

  it("treats an empty store as nothing followed, not as an error", () => {
    const panel = followingPanel(dashboard(verifier, read([])), NOW);
    expect(panel).toMatchObject({ problem: null, empty: "nothing is being followed", readAt: "2026-10-29T11:59:00.000Z" });
    expect(panel?.finished).toEqual([]);
  });

  it("phrases the next check-in relative to now, future and overdue", () => {
    const panel = followingPanel(
      dashboard(
        verifier,
        read([
          watch(),
          watch({ pr: 2802, ticket: 2791, ticketRef: "#2791", round: 2, nextCheckIn: { offsetHours: 1, dueAt: "2026-10-29T11:40:00.000Z" } }),
        ]),
      ),
      NOW,
    );
    expect(panel?.empty).toBeNull();
    expect(panel?.inProgress[0]).toMatchObject({
      ticketRef: "#2790",
      pr: 2801,
      mode: "observe",
      round: 1,
      checkIns: "1/4",
      next: { label: "+6 h", dueAt: "2026-10-29T15:00:00.000Z", relative: "in 3 h", overdue: false },
    });
    expect(panel?.inProgress[1]?.next).toMatchObject({ label: "+1 h", relative: "overdue by 20 min", overdue: true });
  });

  it("says what the watch's mode did to a finished verdict, in that mode's name", () => {
    // The shapes `decideVerdict` returns: report turns a revert into a ticket,
    // observe records the verdict it computed and acts on nothing.
    const panel = followingPanel(
      dashboard(
        verifier,
        read([
          watch({
            mode: "report",
            state: "finished",
            nextCheckIn: null,
            checkInsDone: 4,
            verdict: { verdict: "ticket", reason: "error rate rose 6x", act: true, wouldHaveBeen: "revert" },
          }),
          watch({
            pr: 2802,
            mode: "observe",
            state: "finished",
            nextCheckIn: null,
            verdict: { verdict: "revert", reason: "checkout 500s", act: false, wouldHaveBeen: "revert" },
          }),
          watch({
            pr: 2803,
            mode: "observe",
            state: "finished",
            nextCheckIn: null,
            verdict: { verdict: "verified", reason: "nothing wrong at the last check-in", act: false, wouldHaveBeen: "verified" },
          }),
          watch({
            pr: 2804,
            mode: "act",
            state: "finished",
            nextCheckIn: null,
            verdict: { verdict: "ticket", reason: "acceptance criterion failed", act: true, wouldHaveBeen: null },
          }),
        ]),
      ),
      NOW,
    );
    expect(panel?.inProgress).toEqual([]);
    expect(panel?.finished.map((row) => [row.pr, row.verdict, row.note])).toEqual([
      [2801, "ticket", "report mode: would have been revert"],
      [2802, "revert", "observe mode: held back, nothing was done"],
      [2803, "verified", null],
      [2804, "ticket", null],
    ]);
    expect(panel?.finished[0]?.reason).toBe("error rate rose 6x");
  });

  it("flattens every watch's held-back actions, naming where each came from", () => {
    const panel = followingPanel(
      dashboard(
        verifier,
        read([
          watch({ wouldBe: [{ verdict: "ticket", reason: "slow page", at: 6 }] }),
          watch({ pr: 2802, ticketRef: "#2791", ticket: 2791, wouldBe: [{ verdict: "revert", reason: "500s", at: null }] }),
        ]),
      ),
      NOW,
    );
    expect(panel?.wouldHaveActed).toMatchObject([
      { ticketRef: "#2790", pr: 2801, verdict: "ticket", reason: "slow page", where: "at +6 h check-in" },
      { ticketRef: "#2791", pr: 2802, verdict: "revert", reason: "500s", where: "final verdict" },
    ]);
  });

  it("flattens every watch's criteria that could not be verified live", () => {
    const panel = followingPanel(
      dashboard(
        verifier,
        read([
          watch({ notVerifiableLive: [{ criterion: "admin sees the export", detail: "needs an admin login" }] }),
          watch({ pr: 2802, ticketRef: "#2791", ticket: 2791, notVerifiableLive: [{ criterion: "email sent", detail: null }] }),
        ]),
      ),
      NOW,
    );
    expect(panel?.notVerifiableLive).toMatchObject([
      { ticketRef: "#2790", criterion: "admin sees the export", detail: "needs an admin login" },
      { ticketRef: "#2791", criterion: "email sent", detail: null },
    ]);
  });
});
