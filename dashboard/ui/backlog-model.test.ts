import { describe, expect, it } from "vitest";

import type { ClaimView, FrontierRead, FrontierView, ParkReason, StuckReason } from "../contracts";
import {
  type BacklogLoop,
  duration,
  forPerson,
  forYouRows,
  inFlightTip,
  needsHuman,
  runningTickets,
  since,
  staleNote,
  stuckTip,
} from "./backlog-model";

const NOW = Date.parse("2026-10-13T14:00:00Z");
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const stuck = (number: number, reason: string | null, at: string | null = null): StuckReason => ({
  number,
  title: `#${number}`,
  kind: "other",
  reason,
  pr: null,
  migration: null,
  at,
  park: null,
});

const park = (over: Partial<ParkReason> = {}): ParkReason => ({
  loop: "rita",
  label: "rita-blocked",
  pr: null,
  summary: "check test green on the PR",
  condition: { kind: "check", name: "test", on: "pr" },
  since: minutesAgo(30),
  budgetUntil: new Date(NOW + 45 * 60_000).toISOString(),
  remainingSeconds: 45 * 60,
  expired: false,
  escalatedAt: null,
  ...over,
});

const parked = (base: StuckReason, over: Partial<ParkReason> = {}): StuckReason => ({ ...base, park: park(over) });

const view = (patch: Partial<FrontierView>): FrontierView => ({
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
  ...patch,
});

const claim = (issue: number, loop: string, claimedAt: string | null): ClaimView => ({
  issue,
  title: null,
  loop,
  status: "active",
  claimedAt,
  expiresAt: null,
  run: null,
  labeled: true,
  leased: claimedAt !== null,
});

const loop = (patch: Partial<BacklogLoop> & { loop: string }): BacklogLoop => ({
  supervisor: "alive",
  claims: [],
  issue: null,
  phase: null,
  lastEvent: null,
  ...patch,
});

const inFlight = (number: number, owner: string | null, claimText = `${owner}-wip`) => ({
  number,
  title: `#${number}`,
  loop: owner,
  claim: claimText,
  queued: true,
});

describe("duration", () => {
  it("reads as the two largest units", () => {
    expect(duration(30_000)).toBe("under a minute");
    expect(duration(42 * 60_000)).toBe("42m");
    expect(duration(3 * 3_600_000)).toBe("3h");
    expect(duration(3 * 3_600_000 + 12 * 60_000)).toBe("3h 12m");
    expect(duration(50 * 3_600_000)).toBe("2d 2h");
  });

  it("is null for a missing or unreadable time, never a made-up zero", () => {
    expect(since(null, NOW)).toBeNull();
    expect(since("not a date", NOW)).toBeNull();
    expect(since(minutesAgo(5), NOW)).toBe("5m");
  });
});

describe("running tickets", () => {
  it("spins only for a claim whose loop's supervisor is alive", () => {
    const frontier = view({ inFlight: [inFlight(1, "ralph"), inFlight(2, "rafa"), inFlight(3, null, "PR #9")] });
    const loops = [loop({ loop: "ralph" }), loop({ loop: "rafa", supervisor: "dead" })];
    expect([...runningTickets(frontier, loops)]).toEqual([1]);
  });
});

describe("in-flight hover text", () => {
  it("says who works it, for how long, and what the loop is doing on it", () => {
    const loops = [
      loop({
        loop: "ralph",
        issue: 2370,
        phase: "finish",
        claims: [claim(2370, "ralph", minutesAgo(192))],
        lastEvent: { name: "pr-wait", at: minutesAgo(4), detail: "PR #2378 ci, round 2" },
      }),
    ];
    expect(inFlightTip(inFlight(2370, "ralph"), loops, NOW)).toBe(
      "ralph is working it\nclaimed 3h 12m ago\nphase: finish\nlast: PR #2378 ci, round 2 (4m ago)",
    );
  });

  it("leaves out the phase when the loop is on another of its claims", () => {
    const loops = [loop({ loop: "ralph", issue: 7, phase: "verify", claims: [claim(8, "ralph", minutesAgo(10))] })];
    expect(inFlightTip(inFlight(8, "ralph"), loops, NOW)).toBe("ralph is working it\nclaimed 10m ago");
  });

  it("says a claim is held by a loop that is down, and an undated claim as unknown", () => {
    const loops = [loop({ loop: "rafa", supervisor: "dead", claims: [claim(5, "rafa", null)] })];
    expect(inFlightTip(inFlight(5, "rafa"), loops, NOW)).toBe(
      "claimed by rafa, whose loop is not running\nclaimed at an unknown time",
    );
  });

  it("names the claim itself when no loop holds it", () => {
    expect(inFlightTip(inFlight(2280, null, "PR #2348"), [], NOW)).toBe("claimed by PR #2348");
  });
});

describe("stuck hover text", () => {
  it("adds how long the block has stood to the reason", () => {
    expect(stuckTip(stuck(1, "blocked: red twice", minutesAgo(90)), NOW)).toBe("blocked: red twice\n\nstuck for 1h 30m");
    expect(stuckTip(stuck(1, "blocked: red twice"), NOW)).toBe("blocked: red twice");
    expect(stuckTip(undefined, NOW)).toBeUndefined();
  });

  it("leads with the park, then the reason, then the age", () => {
    expect(stuckTip(parked(stuck(1, "blocked: red twice", minutesAgo(90))), NOW)).toBe(
      "parked: waiting for check test green on the PR · 45m left\n\nblocked: red twice\n\nstuck for 1h 30m",
    );
    expect(stuckTip(parked(stuck(1, null), { expired: true, budgetUntil: minutesAgo(1) }), NOW)).toBe(
      "park ran out: check test green on the PR never held",
    );
  });
});

describe("for you", () => {
  it("reads a block reason that hands the rest to a person", () => {
    expect(needsHuman(stuck(2280, "blocked: PR #2348 green; AC3 on-device Android emulator pass needs a human"))).toBe(true);
    expect(needsHuman(stuck(1, "blocked: needs a manual emulator pass"))).toBe(true);
    expect(needsHuman(stuck(1, "blocked: PR #1276 red twice"))).toBe(false);
    expect(needsHuman(stuck(1, null))).toBe(false);
  });

  it("lists labelled tickets first, then stuck ones a person must clear, each once", () => {
    const rows = forYouRows(
      view({
        human: [{ number: 2317, title: "Sign in with Apple", reason: "ready-for-human" }],
        stuckReasons: [
          stuck(2280, "AC3 needs a human"),
          stuck(2317, "needs a human too"),
          stuck(1109, "PR #1276 red twice"),
        ],
      }),
      NOW,
    );
    expect(rows.map((row) => [row.number, row.kind])).toEqual([
      [2317, "human"],
      [2280, "stuck"],
    ]);
  });
});

describe("for you, with parks", () => {
  it("leaves a live park off even when its reason needs a human, and lists a spent one", () => {
    const rows = forYouRows(
      view({
        stuckReasons: [
          parked(stuck(1, "AC3 needs a human")),
          parked(stuck(2, "PR red twice"), { expired: true, budgetUntil: minutesAgo(5) }),
          parked(stuck(3, "PR red twice"), { budgetUntil: minutesAgo(1) }),
          parked(stuck(4, null), { expired: true, escalatedAt: minutesAgo(1), budgetUntil: minutesAgo(5) }),
        ],
      }),
      NOW,
    );
    expect(rows.map((row) => [row.number, row.kind])).toEqual([
      [2, "stuck"],
      [3, "stuck"],
      [4, "stuck"],
    ]);
  });

  it("decides the Stuck panel's chip by the same rule, so the chip and the list agree", () => {
    expect(forPerson(parked(stuck(1, "AC3 needs a human")), NOW)).toBe(false);
    expect(forPerson(parked(stuck(2, "PR red twice"), { expired: true, budgetUntil: minutesAgo(5) }), NOW)).toBe(true);
    expect(forPerson(stuck(3, "AC3 needs a human"), NOW)).toBe(true);
    expect(forPerson(stuck(4, "PR red twice"), NOW)).toBe(false);
  });
});

describe("staleNote", () => {
  const view = { ready: [] } as unknown as FrontierView;
  const read = (over: Partial<FrontierRead>): FrontierRead => ({
    readAt: "2026-10-13T13:58:00Z",
    view,
    problem: null,
    ...over,
  });
  const time = (iso: string): string => iso.slice(11, 16);

  it("says nothing for a fresh backlog, or for none at all", () => {
    expect(staleNote(read({}), time)).toBeNull();
    expect(staleNote(read({ failedAt: null }), time)).toBeNull();
    expect(staleNote(read({ view: null, problem: "boom", failedAt: minutesAgo(1) }), time)).toBeNull();
  });

  it("names a GitHub throttle, with the kept read's time", () => {
    const problem = "GitHub rate limit (unspecified) — retry later (in ~60s): gh issue list failed";
    expect(staleNote(read({ problem, failedAt: minutesAgo(1) }), time)).toBe(
      "Stale since 13:58: GitHub is rate-limiting the read, retrying every minute.",
    );
  });

  it("finds the throttle after the warnings the census printed first", () => {
    const problem = "warning: branch claims unread\nGitHub rate limit (secondary) — retry later: gh failed";
    expect(staleNote(read({ problem, failedAt: minutesAgo(1) }), time)).toMatch(/GitHub is rate-limiting/);
  });

  it("falls back to a plain failure for any other reason", () => {
    expect(staleNote(read({ problem: "gh: not logged in", failedAt: minutesAgo(1) }), time)).toBe(
      "Stale since 13:58: the latest read failed, retrying every minute.",
    );
  });
});
