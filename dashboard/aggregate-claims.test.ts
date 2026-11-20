// @vitest-environment node
/**
 * Claim attribution and the machine-wide ownership map, through the pure
 * aggregation. The honesty rule is the one the rest of the dashboard follows:
 * a claim is `active` only on the evidence of an unexpired lease for that
 * loop. A label with no lease, an unreadable source or a lapsed lease never
 * renders as active, and a lapsed claim never makes a loop the owner.
 */
import { describe, expect, it } from "vitest";

import { aggregateDashboard } from "./aggregate";
import type {
  Clock,
  GithubClaimView,
  LeaseView,
  RuntimeClaims,
  RuntimeLoop,
  RuntimeSnapshot,
} from "./contracts";
import { coderRoster } from "./contracts";

const NOW = "2026-09-13T12:00:00.000Z";
const clock: Clock = { nowMs: Date.parse(NOW) };
const LATER = "2026-09-13T12:02:00.000Z";
const EARLIER = "2026-09-13T11:58:00.000Z";

const lease = (over: Partial<LeaseView> = {}): LeaseView => ({
  issue: 919,
  run: "run-ralph",
  loop: "ralph",
  owner: "ralph@desk",
  host: "desk",
  worktree: "/checkout/ralph",
  branch: "ralph/919-scaffold",
  claimedAt: "2026-09-13T11:00:00.000Z",
  heartbeatAt: "2026-09-13T11:59:00.000Z",
  expiresAt: LATER,
  ...over,
});

const label = (over: Partial<GithubClaimView> = {}): GithubClaimView => ({
  issue: 919,
  title: "Scaffold the thing",
  loop: "ralph",
  ...over,
});

const worktree = (loop: string, over: Partial<RuntimeLoop> = {}): RuntimeLoop => ({
  worktree: `/checkout/${loop}`,
  identity: loop,
  loopStatus: "idle",
  worktreeStatus: "live",
  branch: null,
  state: null,
  stateProblem: "missing",
  supervisor: "alive",
  presence: null,
  ...over,
});

const runtime = (claims: RuntimeClaims | undefined, loops: RuntimeLoop[] = []): RuntimeSnapshot => ({
  roster: coderRoster("ralph", "rafa", "remo", "rulo"),
  loops,
  reconciliation: { orphaned: [], prunable: [] },
  ...(claims === undefined ? {} : { claims }),
});

const panel = (snapshot: RuntimeSnapshot, loop: string) =>
  aggregateDashboard(snapshot, clock).loops.find((entry) => entry.loop === loop)!;

describe("claims on a loop panel", () => {
  it("lists a leased, labeled ticket as active with its issue number and expiry", () => {
    const claims = panel(runtime({ leases: [lease()], github: [label()] }), "ralph").claims;
    expect(claims).toEqual([
      {
        issue: 919,
        title: "Scaffold the thing",
        loop: "ralph",
        status: "active",
        claimedAt: "2026-09-13T11:00:00.000Z",
        expiresAt: LATER,
        run: "run-ralph",
        labeled: true,
        leased: true,
      },
    ]);
  });

  it("attributes each claim to its own loop and to no other", () => {
    const snapshot = runtime({
      leases: [lease(), lease({ issue: 12, loop: "rafa", run: "run-rafa" })],
      github: [label(), label({ issue: 12, loop: "rafa", title: "Other" })],
    });
    expect(panel(snapshot, "ralph").claims.map((claim) => claim.issue)).toEqual([919]);
    expect(panel(snapshot, "rafa").claims.map((claim) => claim.issue)).toEqual([12]);
    expect(panel(snapshot, "remo").claims).toEqual([]);
  });

  it("keeps a lease active after the label is cleared for the PR", () => {
    const [claim] = panel(runtime({ leases: [lease()], github: [] }), "ralph").claims;
    expect(claim).toMatchObject({ status: "active", labeled: false, leased: true, title: null });
  });

  it("renders a lapsed lease as expired, never active", () => {
    const [claim] = panel(runtime({ leases: [lease({ expiresAt: EARLIER })], github: [label()] }), "ralph").claims;
    expect(claim).toMatchObject({ status: "expired", expiresAt: EARLIER });
  });

  it("treats an expiry exactly at now as expired", () => {
    const [claim] = panel(runtime({ leases: [lease({ expiresAt: NOW })], github: [label()] }), "ralph").claims;
    expect(claim?.status).toBe("expired");
  });

  it("renders a label with no lease as unknown with no expiry", () => {
    const [claim] = panel(runtime({ leases: [], github: [label()] }), "ralph").claims;
    expect(claim).toMatchObject({ status: "unknown", expiresAt: null, leased: false, labeled: true });
  });

  it("renders a label as unknown when the lease store could not be read", () => {
    const [claim] = panel(runtime({ leases: null, github: [label()] }), "ralph").claims;
    expect(claim).toMatchObject({ status: "unknown", expiresAt: null });
  });

  it("renders an unparseable expiry as unknown", () => {
    const [claim] = panel(runtime({ leases: [lease({ expiresAt: "soon" })], github: [label()] }), "ralph").claims;
    expect(claim?.status).toBe("unknown");
  });

  it("keeps an unexpired lease active when GitHub could not be read, with labeled unknown", () => {
    const [claim] = panel(runtime({ leases: [lease()], github: null }), "ralph").claims;
    expect(claim).toMatchObject({ status: "active", labeled: null });
  });

  it("does not list an old expired lease that nothing else still points at", () => {
    // Leases are never deleted; a lapsed one with no label and no current run
    // is history, not a claim.
    expect(panel(runtime({ leases: [lease({ expiresAt: EARLIER })], github: [] }), "ralph").claims).toEqual([]);
  });

  it("lists the current run's lapsed lease as expired", () => {
    const loops = [
      worktree("ralph", {
        state: {
          version: 1,
          run: "run-ralph",
          owner: { loop: "ralph", pid: 1, host: "desk" },
          worktree: "/checkout/ralph",
          branch: null,
          stage: "iteration",
          iteration: null,
          heartbeat: NOW,
          lastEvent: null,
          stopReason: null,
        },
        stateProblem: null,
      }),
    ];
    const [claim] = panel(runtime({ leases: [lease({ expiresAt: EARLIER })], github: [] }, loops), "ralph").claims;
    expect(claim).toMatchObject({ status: "expired", issue: 919 });
  });

  it("gives a label for one loop and a lease for another two separate claims", () => {
    const snapshot = runtime({ leases: [lease({ loop: "rafa", run: "run-rafa" })], github: [label()] });
    expect(panel(snapshot, "ralph").claims).toEqual([
      expect.objectContaining({ issue: 919, status: "unknown", leased: false, labeled: true }),
    ]);
    expect(panel(snapshot, "rafa").claims).toEqual([
      expect.objectContaining({ issue: 919, status: "active", leased: true, labeled: false, title: "Scaffold the thing" }),
    ]);
  });

  it("lists claims on a roster loop that has no worktree", () => {
    const snapshot = runtime({ leases: [lease({ loop: "remo", run: "run-remo" })], github: [] });
    const remo = panel(snapshot, "remo");
    expect(remo.present).toBe(false);
    expect(remo.claims.map((claim) => claim.status)).toEqual(["active"]);
  });

  it("ignores claims by a loop outside the roster", () => {
    const dashboard = aggregateDashboard(
      runtime({ leases: [lease({ loop: "nova" })], github: [label({ loop: "nova" })] }),
      clock,
    );
    expect(dashboard.loops.flatMap((entry) => entry.claims)).toEqual([]);
    expect(dashboard.ownership.issues).toEqual([]);
  });

  it("orders a loop's claims by issue number", () => {
    const snapshot = runtime({ leases: [lease({ issue: 30 }), lease({ issue: 4 })], github: [label({ issue: 17 })] });
    expect(panel(snapshot, "ralph").claims.map((claim) => claim.issue)).toEqual([4, 17, 30]);
  });

  it("dedupes a lease two roots both reported", () => {
    const snapshot = runtime({ leases: [lease(), lease()], github: [label(), label()] });
    expect(panel(snapshot, "ralph").claims).toHaveLength(1);
  });
});

describe("the machine-wide ownership map", () => {
  it("attributes an actively claimed ticket to its one owning loop", () => {
    const { ownership } = aggregateDashboard(runtime({ leases: [lease()], github: [label()] }), clock);
    expect(ownership.issues).toEqual([
      expect.objectContaining({
        issue: 919,
        title: "Scaffold the thing",
        owner: "ralph",
        status: "active",
        loops: ["ralph"],
        working: [],
      }),
    ]);
    expect(ownership.contested).toEqual([]);
    expect(ownership.sources).toEqual({ leases: "ok", github: "ok" });
  });

  it("flags two loops actively claiming one ticket as contested, with no owner", () => {
    const { ownership } = aggregateDashboard(
      runtime({
        leases: [lease(), lease({ loop: "rafa", run: "run-rafa" })],
        github: [],
      }),
      clock,
    );
    expect(ownership.issues[0]).toMatchObject({ issue: 919, owner: null, status: "contested", loops: ["ralph", "rafa"] });
    expect(ownership.contested).toEqual([919]);
  });

  it("counts an unknown claim as a contender, so a stray label is never hidden", () => {
    const { ownership } = aggregateDashboard(
      runtime({ leases: [lease({ loop: "rafa", run: "run-rafa" })], github: [label()] }),
      clock,
    );
    expect(ownership.issues[0]).toMatchObject({ status: "contested", owner: null });
    expect(ownership.contested).toEqual([919]);
  });

  it("does not let an expired claim compete with an active one", () => {
    const { ownership } = aggregateDashboard(
      runtime({
        leases: [lease({ loop: "rafa", run: "run-rafa" })],
        github: [label({ loop: "ralph" })],
      }),
      clock,
    );
    // Sanity: this is the contested shape above; now lapse ralph's side instead.
    expect(ownership.issues[0]?.status).toBe("contested");

    const lapsed = aggregateDashboard(
      runtime({
        leases: [lease({ issue: 5, expiresAt: EARLIER }), lease({ issue: 5, loop: "rafa", run: "run-rafa" })],
        github: [label({ issue: 5, loop: "rafa" })],
      }),
      clock,
    );
    expect(lapsed.ownership.issues).toHaveLength(1);
    expect(lapsed.ownership.issues[0]).toMatchObject({ issue: 5, owner: "rafa", status: "active" });
  });

  it("gives an issue whose claims have all lapsed no owner", () => {
    const { ownership } = aggregateDashboard(
      runtime({ leases: [lease({ expiresAt: EARLIER })], github: [label()] }),
      clock,
    );
    expect(ownership.issues[0]).toMatchObject({ owner: null, status: "expired", loops: ["ralph"] });
  });

  it("owns a label-only claim as unknown, not active", () => {
    const { ownership } = aggregateDashboard(runtime({ leases: [], github: [label()] }), clock);
    expect(ownership.issues[0]).toMatchObject({ owner: "ralph", status: "unknown" });
  });

  it("maps a running loop's active work, and flags a second loop working the same ticket", () => {
    const running = (loop: string, issue: number): RuntimeLoop =>
      worktree(loop, {
        loopStatus: "running",
        presence: {
          loop,
          run: `run-${loop}`,
          status: "running",
          supervisor: "alive",
          issue,
          branch: null,
          iteration: null,
          observedAt: NOW,
          actors: [],
          issues: [],
          recent: [],
          failureReason: null,
          step: null,
          phase: { index: 2, total: 5, label: "implement" },
          warning: null,
        },
      });
    const { ownership } = aggregateDashboard(
      runtime({ leases: [lease()], github: [label()] }, [running("ralph", 919), running("remo", 919), running("rafa", 44)]),
      clock,
    );
    expect(ownership.issues.map((entry) => entry.issue)).toEqual([44, 919]);
    expect(ownership.issues[0]).toMatchObject({ issue: 44, owner: "rafa", status: "unknown", working: ["rafa"], claims: [] });
    expect(ownership.issues[1]).toMatchObject({ issue: 919, owner: null, status: "contested", working: ["ralph", "remo"] });
    expect(ownership.contested).toEqual([919]);
  });

  it("does not count an idle loop's last issue as active work", () => {
    const idle = worktree("ralph", {
      loopStatus: "idle",
      presence: {
        loop: "ralph",
        run: null,
        status: "idle",
        supervisor: "alive",
        issue: 919,
        branch: null,
        iteration: null,
        observedAt: NOW,
        actors: [],
        issues: [],
        recent: [],
        failureReason: null,
        step: null,
        phase: { index: 1, total: 5, label: "select and map" },
        warning: null,
      },
    });
    expect(aggregateDashboard(runtime({ leases: [], github: [] }, [idle]), clock).ownership.issues).toEqual([]);
  });

  it("reports each claim source's health, and an absent claims read as unavailable", () => {
    expect(aggregateDashboard(runtime({ leases: null, github: [] }), clock).ownership.sources).toEqual({
      leases: "unavailable",
      github: "ok",
    });
    const blind = aggregateDashboard(runtime(undefined), clock);
    expect(blind.ownership).toEqual({ issues: [], contested: [], sources: { leases: "unavailable", github: "unavailable" } });
    expect(blind.loops.every((entry) => entry.claims.length === 0)).toBe(true);
  });
});
