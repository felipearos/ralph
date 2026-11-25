import { describe, expect, it } from "vitest";

import type { FrontierView, ParkCondition, ParkReason, StuckReason } from "../contracts";
import {
  conditionText,
  noStuckGroups,
  parkLive,
  parkText,
  stuckGroups,
  stuckReasonsByNumber,
  stuckWord,
} from "./blocked-model";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

const park = (over: Partial<ParkReason> = {}): ParkReason => ({
  loop: "rita",
  label: "rita-blocked",
  pr: 42,
  summary: "#700 to land",
  condition: { kind: "reference", ref: "#700" },
  since: at(-60),
  budgetUntil: at(90),
  remainingSeconds: 90 * 60,
  expired: false,
  escalatedAt: null,
  ...over,
});

/** The three ways a park is spent: expired, escalated, or past its budget by the page's clock though the view says live. */
const SPENT: [string, ParkReason][] = [
  ["expired", park({ expired: true, budgetUntil: at(-5), remainingSeconds: 0 })],
  ["escalated", park({ expired: true, escalatedAt: at(-1), budgetUntil: at(-5), remainingSeconds: 0 })],
  ["past its budget by the page clock", park({ budgetUntil: at(-1) })],
];

const reason = (number: number, kind: StuckReason["kind"], parked: ParkReason | null = null): StuckReason => ({
  number,
  title: `#${number}`,
  kind,
  reason: null,
  pr: null,
  migration: null,
  at: null,
  park: parked,
});

const view = (stuckReasons: StuckReason[]): FrontierView => ({
  ready: [],
  occupied: [],
  specs: [],
  inFlight: [],
  blocked: [],
  gates: [],
  stuck: [],
  tree: [],
  stuckReasons,
  untriaged: [],
  triage: { staffing: 0, routing: 0, intake: 0, oversize: 0, rescue: 0 },
  human: [],
  dropped: [],
});

describe("stuck groups", () => {
  it("puts migration blocks apart, and unknown reasons with the other reasons", () => {
    const groups = stuckGroups(view([reason(1109, "other"), reason(1219, "migration"), reason(1040, "unknown")]), NOW);
    expect(groups.migration.map((r) => r.number)).toEqual([1219]);
    expect(groups.other.map((r) => r.number)).toEqual([1109, 1040]);
  });

  it("is empty for a backlog with nothing stuck", () => {
    expect(stuckGroups(view([]), NOW)).toEqual(noStuckGroups());
  });

  it("puts a flake block under the ci-doctor rather than under needs-triage", () => {
    // The third acceptance criterion of felipearos/ralph#160: the doctor
    // unparks it unasked, so an operator has nothing to do and the ticket must
    // not be counted among the ones that need a look.
    const groups = stuckGroups(view([reason(1557, "ci-flake"), reason(1109, "other"), reason(1219, "migration")]), NOW);
    expect(groups.doctor.map((r) => r.number)).toEqual([1557]);
    expect(groups.other.map((r) => r.number)).toEqual([1109]);
    expect(groups.migration.map((r) => r.number)).toEqual([1219]);
  });

  it("partitions: every stuck ticket is in exactly one group", () => {
    const reasons = [
      reason(1, "migration"),
      reason(2, "ci-flake"),
      reason(3, "other"),
      reason(4, "unknown"),
      reason(5, "ci-flake"),
    ];
    const groups = stuckGroups(view(reasons), NOW);
    const placed = [...groups.parked, ...groups.migration, ...groups.doctor, ...groups.other].map((r) => r.number);
    expect([...placed].sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(placed).size).toBe(placed.length);
  });

  it("keeps the empty partition's keys the same as a real one, so a reader cannot fall behind", () => {
    expect(Object.keys(noStuckGroups()).sort()).toEqual(
      Object.keys(stuckGroups(view([reason(1, "migration"), reason(2, "ci-flake"), reason(3, "other")]), NOW)).sort(),
    );
  });

  it("names a migration block by what it needs, and any other by its label", () => {
    const byNumber = stuckReasonsByNumber(view([reason(1219, "migration"), reason(1109, "other")]));
    expect(stuckWord("rafa-blocked", byNumber.get(1219), NOW)).toBe("needs migration");
    expect(stuckWord("ralph-blocked", byNumber.get(1109), NOW)).toBe("ralph-blocked");
    expect(stuckWord("remo-blocked", byNumber.get(1), NOW)).toBe("remo-blocked");
  });

  it("says a flake block is a flaky test, so the ci-doctor's intake does not read as human triage", () => {
    const byNumber = stuckReasonsByNumber(view([reason(1557, "ci-flake"), reason(1109, "other")]));
    expect(stuckWord("ralph-blocked", byNumber.get(1557), NOW)).toBe("flaky test");
    expect(stuckWord("ralph-blocked", byNumber.get(1109), NOW)).toBe("ralph-blocked");
  });
});

describe("parks", () => {
  it("puts a live-parked ticket under parked, ahead of its kind, and nowhere else", () => {
    const groups = stuckGroups(view([reason(1, "migration", park()), reason(2, "other", park()), reason(3, "migration")]), NOW);
    expect(groups.parked.map((r) => r.number)).toEqual([1, 2]);
    expect(groups.migration.map((r) => r.number)).toEqual([3]);
    expect(groups.other).toEqual([]);
  });

  it.each(SPENT)("puts a %s park in a group a person acts on, never the doctor's", (_, spent) => {
    const groups = stuckGroups(
      view([reason(1, "migration", spent), reason(2, "ci-flake", spent), reason(3, "other", spent), reason(4, "ci-flake")]),
      NOW,
    );
    expect(groups.parked).toEqual([]);
    expect(groups.migration.map((r) => r.number)).toEqual([1]);
    expect(groups.other.map((r) => r.number)).toEqual([2, 3]);
    expect(groups.doctor.map((r) => r.number)).toEqual([4]);
    expect(parkLive(spent, NOW)).toBe(false);
    // A migration's badge already names the person's next step; any other says the park ran out.
    expect(stuckWord("rita-blocked", reason(1, "migration", spent), NOW)).toBe("needs migration");
    expect(stuckWord("rita-blocked", reason(2, "ci-flake", spent), NOW)).toBe("park ran out");
  });

  it("calls a live park parked, whatever the kind", () => {
    expect(parkLive(park(), NOW)).toBe(true);
    expect(stuckWord("rita-blocked", reason(1, "migration", park()), NOW)).toBe("parked");
  });

  it("says what a live park waits for and how long it has left by the page clock", () => {
    expect(parkText(park(), NOW)).toBe("parked: waiting for #700 to land · 1h 30m left");
  });

  it("names the condition that never held once a park is spent", () => {
    expect(parkText(SPENT[0]![1], NOW)).toBe("park ran out: #700 to land never held");
    expect(parkText(SPENT[1]![1], NOW)).toBe("park ran out: #700 to land never held · escalated");
    expect(parkText(SPENT[2]![1], NOW)).toBe("park ran out: #700 to land never held");
  });

  it("words each condition kind", () => {
    const cases: [ParkCondition, string][] = [
      [{ kind: "reference", ref: "#123" }, "#123 to land"],
      [{ kind: "check", name: "test", on: "pr" }, "check test green on the PR"],
      [{ kind: "check", name: "deploy", on: "main" }, "check deploy green on main"],
      [{ kind: "step", check: "buildkite", step: "e2e" }, "buildkite step e2e green"],
      [{ kind: "label-removed", label: "needs-design" }, "label needs-design removed"],
    ];
    for (const [condition, text] of cases) expect(conditionText(condition)).toBe(text);
  });
});
