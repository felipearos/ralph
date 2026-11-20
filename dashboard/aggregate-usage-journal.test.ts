// @vitest-environment node
/**
 * Token usage and journal entries in the pure projection.
 *
 * Attribution: a panel shows usage only when the runtime read it for that
 * loop's own worktree and run — usage recorded under another run is somebody
 * else's consumption, not this loop's. Selection: a panel shows only the
 * entries its loop signed, newest first and capped. Absent data stays `null`
 * in both, so the page can say unknown instead of zero or "nothing happened".
 */
import { describe, expect, it } from "vitest";

import { JOURNAL_LIMIT, aggregateDashboard } from "./aggregate";
import type {
  Clock,
  JournalEntryView,
  LoopStateView,
  RuntimeLoop,
  RuntimeSnapshot,
  TokenUsage,
  UsageView,
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
  lastEvent: null,
  stopReason: null,
  ...over,
});

const tokens = (total: number): TokenUsage => ({
  input: total,
  output: total / 10,
  cache5m: 0,
  cache1h: 0,
  cacheRead: 0,
  inputTotal: total,
});

const usage = (over: Partial<UsageView> = {}): UsageView => ({
  session: "sess-1",
  runId: "ralph-run-1",
  iteration: {
    turns: 3,
    elapsedSeconds: 60,
    usage: tokens(100),
    models: [{ model: "claude-opus-5", usage: tokens(100) }],
  },
  run: { steps: 4, usage: tokens(400) },
  context: { model: "claude-opus-5", tokens: 1000, window: 1_000_000, percent: 0.1 },
  ...over,
});

const entry = (stamp: string, loop: string | null): JournalEntryView => ({
  name: `20260913T${stamp}Z-100-abcdefabcdef.md`,
  at: `2026-09-13T${stamp.slice(0, 2)}:${stamp.slice(2, 4)}:${stamp.slice(4, 6)}.000Z`,
  issue: 100,
  loop,
  title: `entry ${stamp}`,
  outcome: "merged",
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
  presence: null,
  ...over,
});

const runtime = (loops: RuntimeLoop[]): RuntimeSnapshot => ({
  roster: coderRoster("ralph", "rafa", "remo", "rulo"),
  loops,
  reconciliation: { orphaned: [], prunable: [] },
});

const panel = (snapshot: RuntimeSnapshot, name: string) =>
  aggregateDashboard(snapshot, clock).loops.find((item) => item.loop === name);

describe("attributing token usage", () => {
  it("carries the usage the runtime read for the loop's own run", () => {
    expect(panel(runtime([loop({ usage: usage() })]), "ralph")?.usage).toEqual(usage());
  });

  it("does not attribute usage recorded under another run", () => {
    const stale = usage({ runId: "ralph-run-0" });
    expect(panel(runtime([loop({ usage: stale })]), "ralph")?.usage).toBeNull();
  });

  it("does not attribute usage when the loop's run is unknown", () => {
    const snapshot = runtime([loop({ state: null, usage: usage() })]);
    expect(panel(snapshot, "ralph")?.usage).toBeNull();
  });

  it("keeps a missing run ledger unknown rather than zero", () => {
    expect(panel(runtime([loop({ usage: usage({ run: null }) })]), "ralph")?.usage?.run).toBeNull();
  });

  it("renders missing usage as unknown, including for a loop with no worktree", () => {
    const snapshot = runtime([loop()]);
    expect(panel(snapshot, "ralph")?.usage).toBeNull();
    expect(panel(snapshot, "rafa")).toMatchObject({ present: false, usage: null, journal: null });
  });

  it("never puts a non-loop worktree's usage on a panel", () => {
    const snapshot = runtime([
      loop({ worktree: "/checkout/buildkite", identity: null, usage: usage() }),
    ]);
    expect(aggregateDashboard(snapshot, clock).loops.every((item) => item.usage === null)).toBe(true);
  });

  it("uses the record-bearing worktree's usage when two claim one loop", () => {
    const snapshot = runtime([
      loop({ worktree: "/checkout/copy", state: null, usage: null }),
      loop({ worktree: "/checkout/real", usage: usage() }),
    ]);
    expect(panel(snapshot, "ralph")?.usage?.session).toBe("sess-1");
  });
});

describe("selecting journal entries", () => {
  const journal = [
    entry("010000", "ralph"),
    entry("020000", "rafa"),
    entry("030000", "ralph"),
    entry("040000", null),
    entry("050000", "ralph"),
    entry("060000", "ralph"),
    entry("070000", "rafa"),
    entry("080000", "ralph"),
    entry("090000", "ralph"),
    entry("100000", "ralph"),
  ];

  it("shows only the loop's own entries, newest first, capped", () => {
    const snapshot = runtime([
      loop({ journal }),
      loop({ worktree: "/checkout/rafa", identity: "rafa", state: state({ run: "rafa-run" }), journal }),
    ]);
    expect(JOURNAL_LIMIT).toBe(5);
    expect(panel(snapshot, "ralph")?.journal?.map((item) => item.title)).toEqual([
      "entry 100000",
      "entry 090000",
      "entry 080000",
      "entry 060000",
      "entry 050000",
    ]);
    expect(panel(snapshot, "rafa")?.journal?.map((item) => item.title)).toEqual([
      "entry 070000",
      "entry 020000",
    ]);
  });

  it("never attributes an unsigned entry to a loop", () => {
    const snapshot = runtime([loop({ journal: [entry("040000", null)] })]);
    expect(panel(snapshot, "ralph")?.journal).toEqual([]);
  });

  it("keeps an unreadable journal unknown and a loop with no entries empty", () => {
    expect(panel(runtime([loop({ journal: null })]), "ralph")?.journal).toBeNull();
    expect(panel(runtime([loop()]), "ralph")?.journal).toBeNull();
    expect(panel(runtime([loop({ journal: [entry("020000", "rafa")] })]), "ralph")?.journal).toEqual([]);
  });

  it("does not reorder the runtime's journal in place", () => {
    const copy = [...journal];
    aggregateDashboard(runtime([loop({ journal })]), clock);
    expect(journal).toEqual(copy);
  });
});

/**
 * The triage panel's own projection (#147).
 *
 * The buckets and UNTRIAGED come off the frontier; what is left is the
 * triager's own activity, and it is per-role: a coder has no triage panel at
 * all, which is a different thing from a triager with nothing in it.
 */
describe("projecting a triager's activity", () => {
  const roster = [
    { name: "ralph", role: "coder" as const },
    { name: "tria", role: "triager" as const },
  ];
  const withRoster = (loops: RuntimeLoop[]): RuntimeSnapshot => ({
    roster,
    loops,
    reconciliation: { orphaned: [], prunable: [] },
  });
  const unit = (stamp: string, issue: number | null, outcome: string): JournalEntryView => ({
    ...entry(stamp, "tria"),
    issue,
    outcome,
  });
  const triager = (over: Partial<RuntimeLoop> = {}): RuntimeLoop =>
    loop({
      worktree: "/checkout/tria",
      identity: "tria",
      state: state({ run: "tria-run", owner: { loop: "tria", pid: 1, host: "desktop" } }),
      ...over,
    });

  it("gives a coder no triage panel", () => {
    const snapshot = withRoster([loop({ triage: { writesLastHour: 7, maxWrites: 30, units: [] } })]);
    expect(panel(snapshot, "ralph")?.triage).toBeNull();
  });

  it("carries the writes the runtime read, and the cap it read them against", () => {
    const snapshot = withRoster([triager({ triage: { writesLastHour: 14, maxWrites: 12, units: [] } })]);
    expect(panel(snapshot, "tria")?.triage).toEqual({ writesLastHour: 14, maxWrites: 12, units: [] });
  });

  it("keeps unreadable ledgers unknown rather than zero", () => {
    const snapshot = withRoster([triager({ triage: { writesLastHour: null, maxWrites: 30, units: [] } })]);
    expect(panel(snapshot, "tria")?.triage?.writesLastHour).toBeNull();
    // A runtime that reported no triage read at all is unknown throughout —
    // the CAP too. Filling in the validator's default here would have the
    // panel quote a cap nobody configured, beside a null it keeps honestly.
    expect(panel(withRoster([triager()]), "tria")?.triage).toEqual({
      writesLastHour: null,
      maxWrites: null,
      units: [],
    });
  });

  it("lists the units it decided, newest first and capped at ten", () => {
    // Twelve entries of its own, so the cap is the thing under test rather
    // than the window.
    const entries = Array.from({ length: 12 }, (_, n) =>
      unit(`${String(n + 1).padStart(2, "0")}0000`, 1100 + n, `routed (${n} tickets)`),
    );
    const units = panel(withRoster([triager({ journal: entries })]), "tria")?.triage?.units;
    expect(units).toHaveLength(10);
    expect(units?.map((u) => u.issue)).toEqual([1111, 1110, 1109, 1108, 1107, 1106, 1105, 1104, 1103, 1102]);
    expect(units?.[0]).toEqual({
      issue: 1111,
      at: entries[11]!.at,
      outcome: "routed (11 tickets)",
      title: "entry 120000",
    });
  });

  it("takes ten units off the project's window, not off the journal panel's five", () => {
    // The loop's own journal panel is capped at five; the units list must not
    // inherit that cap, or half the panel would be missing.
    const entries = Array.from({ length: 8 }, (_, n) => unit(`${String(n + 1).padStart(2, "0")}0000`, 1200 + n, "routed"));
    const projected = panel(withRoster([triager({ journal: entries })]), "tria");
    expect(projected?.journal).toHaveLength(JOURNAL_LIMIT);
    expect(projected?.triage?.units).toHaveLength(8);
  });

  it("leaves out an iteration that took no unit", () => {
    // `--issue none` is an iteration that decided nothing; listing it as a
    // unit would inflate the only count of what triage has actually done.
    const entries = [unit("010000", 1131, "routed (7 tickets)"), unit("020000", null, "all blocked")];
    expect(panel(withRoster([triager({ journal: entries })]), "tria")?.triage?.units).toEqual([
      { issue: 1131, at: entries[0]!.at, outcome: "routed (7 tickets)", title: "entry 010000" },
    ]);
  });

  it("ignores another loop's entries, as the journal panel does", () => {
    const entries = [unit("010000", 1131, "routed"), { ...entry("020000", "ralph"), issue: 999 }];
    expect(panel(withRoster([triager({ journal: entries })]), "tria")?.triage?.units.map((u) => u.issue)).toEqual([1131]);
  });

  it("gives a triager the runtime never reported an empty, unknown panel", () => {
    // Absent, not fine: nothing is known about its writes, its cap or its units.
    expect(panel(withRoster([]), "tria")?.triage).toEqual({ writesLastHour: null, maxWrites: null, units: [] });
  });
});

/**
 * Which journal entries are "applied units", and what happens when one unit
 * has been attempted twice (#147's review round).
 */
describe("a triager's units: applied, and one per unit", () => {
  const roster = [
    { name: "ralph", role: "coder" as const },
    { name: "tria", role: "triager" as const },
  ];
  const withRoster = (loops: RuntimeLoop[]): RuntimeSnapshot => ({
    roster,
    loops,
    reconciliation: { orphaned: [], prunable: [] },
  });
  const triager = (journal: JournalEntryView[]): RuntimeLoop =>
    loop({
      worktree: "/checkout/tria",
      identity: "tria",
      state: state({ run: "tria-run", owner: { loop: "tria", pid: 1, host: "desktop" } }),
      journal,
    });
  const outcome = (stamp: string, issue: number | null, text: string): JournalEntryView => ({
    ...entry(stamp, "tria"),
    issue,
    outcome: text,
  });
  const unitsOf = (journal: JournalEntryView[]) =>
    panel(withRoster([triager(journal)]), "tria")?.triage?.units ?? [];

  it("leaves out an iteration that applied nothing", () => {
    // `all blocked` took no unit and `retry later` stopped before writing, so
    // neither is a unit the triager applied — listing them would inflate the
    // only count of what triage has actually done.
    expect(
      unitsOf([
        outcome("050000", 1131, "routed (7 tickets)"),
        outcome("040000", 1132, "all blocked"),
        outcome("030000", 1133, "retry later"),
      ]).map((u) => u.issue),
    ).toEqual([1131]);
  });

  it("counts a unit it gave up on", () => {
    // Giving up leaves a marker comment on the issue: that is a write and a
    // decision, so it is an applied unit like any other. The two-attempt fence
    // reads that marker, so a panel hiding it would hide why a ticket is quiet.
    expect(unitsOf([outcome("010000", 1140, "gave up")]).map((u) => u.issue)).toEqual([1140]);
  });

  it("shows one row per unit, newest attempt first, when a unit was retried", () => {
    // A second attempt on a unit is a normal, documented state and publishes
    // its own entry under the same `--issue`. Two rows would duplicate the
    // React key, and would spend two of the ten on one ticket.
    const units = unitsOf([
      outcome("060000", 1131, "routed (7 tickets)"),
      outcome("020000", 1131, "triaged (needs-info)"),
      outcome("010000", 1132, "split into #1133, #1134"),
    ]);
    expect(units.map((u) => [u.issue, u.outcome])).toEqual([
      [1131, "routed (7 tickets)"],
      [1132, "split into #1133, #1134"],
    ]);
  });

  it("still fills ten units when earlier attempts are deduped away", () => {
    // Deduping after a slice of ten would have shown fewer than ten: the cap
    // is on units, not on entries.
    const retried = Array.from({ length: 12 }, (_, n) => outcome(`${String(n + 1).padStart(2, "0")}0000`, 1200 + n, "routed"));
    const repeats = retried.map((e, n) => ({ ...e, name: `${e.name}-retry`, issue: 1200 + n }));
    expect(unitsOf([...retried, ...repeats])).toHaveLength(10);
  });
});
