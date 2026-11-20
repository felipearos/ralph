/**
 * The CI health panel's decisions (felipearos/ralph#160).
 *
 * `Dashboard` and `DashboardLoop` are built as full literals rather than cast,
 * for the reason `triage-model.test.ts` gives: a cast is exactly what would
 * stop a field added to a contract later from reaching this panel as
 * `undefined` with the suite still green.
 */
import { describe, expect, it } from "vitest";

import type {
  CiCaseView,
  CiHealthRead,
  CiHealthView,
  CiMetricsView,
  Dashboard,
  DashboardLoop,
  LoopRole,
} from "../contracts";
import {
  anyWaits,
  attentionSummary,
  CASE_ROW_LIMIT,
  cardLead,
  caseLine,
  caseTone,
  caseWord,
  ciHealthPanel,
  ciStrip,
  ciTrend,
  costParts,
  incidentTone,
  mainTone,
  mainWord,
  retryTone,
  spanSince,
  stateWord,
  subjectOf,
  testName,
  trendDetail,
  trendState,
  trendTicks,
  waitTone,
  waitCell,
} from "./ci-health-model";

const kase = (over: Partial<CiCaseView> = {}): CiCaseView => ({
  key: "flake:a.test.ts > one",
  subject: "a.test.ts > one",
  kind: "flake",
  state: "confirmed",
  redBuilds: 3,
  mainReds: 0,
  dequeues: 0,
  issue: null,
  pr: null,
  rule: null,
  heldBy: null,
  notified: false,
  ...over,
});

const view = (over: Partial<CiHealthView> = {}): CiHealthView => ({
  main: { state: "green", since: "2026-10-05T09:00:00.000Z", build: 412 },
  cases: [],
  incidents: [],
  parked: [],
  retries: { day: "2026-10-05", count: 1, cap: 6, today: true },
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
});

const loop = (name: string, role: LoopRole, holding: CiCaseView | null = null): DashboardLoop => ({
  loop: name,
  role,
  case: holding,
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

const dashboard = (loops: DashboardLoop[], ciHealth: CiHealthRead | null = null): Dashboard => ({
  generatedAt: "2026-10-05T12:00:00.000Z",
  loops,
  reconciliation: { orphaned: [], prunable: [] },
  unattributed: [],
  ownership: { issues: [], contested: [], sources: { leases: "ok", github: "ok" } },
  frontier: null,
  ciHealth,
  following: null,
  learnings: null,
});

const read = (over: Partial<CiHealthRead> = {}): CiHealthRead => ({
  readAt: "2026-10-05T11:59:00.000Z",
  view: view(),
  problem: null,
  ...over,
});

describe("the CI health panel", () => {
  it("is absent for a project that staffs no ci-doctor", () => {
    // Not an empty panel: a green main and a row of zeroes with nobody
    // measuring would read as healthy CI rather than as a question nobody on
    // this project is asking.
    expect(ciHealthPanel(dashboard([loop("ralph", "coder"), loop("tria", "triager")], read()))).toBeNull();
  });

  it("renders an EMPTY panel for a doctor whose store is missing, not an error", () => {
    // #160's fourth acceptance criterion. `dashboard/ci-health.ts` folds a
    // missing store to an empty view; the panel's job is not to second-guess it.
    const panel = ciHealthPanel(dashboard([loop("doc", "ci-doctor")], read({ view: view({ main: { state: "unknown", since: null, build: null } }) })));
    expect(panel?.problem).toBeNull();
    expect(panel?.health).toMatchObject({ main: { state: "unknown", since: null, build: null }, cases: [] });
  });

  it("reports an unreadable store as unknown, carrying the reason", () => {
    const panel = ciHealthPanel(dashboard([loop("doc", "ci-doctor")], read({ view: null, problem: "could not read /w/doc/.git" })));
    expect(panel?.health).toBeNull();
    expect(panel?.problem).toBe("could not read /w/doc/.git");
    expect(panel?.readAt).toBe("2026-10-05T11:59:00.000Z");
  });

  it("says so when the adapter supplied no read at all", () => {
    const panel = ciHealthPanel(dashboard([loop("doc", "ci-doctor")], null));
    expect(panel?.health).toBeNull();
    expect(panel?.problem).toBe("the adapter supplied no CI health read");
    expect(panel?.readAt).toBeNull();
  });

  it("lists every roster doctor in roster order, with the case each holds", () => {
    const held = kase({ key: "flake:held", subject: "held", heldBy: "doc2" });
    const panel = ciHealthPanel(
      dashboard([loop("doc1", "ci-doctor"), loop("ralph", "coder"), loop("doc2", "ci-doctor", held)], read()),
    );
    expect(panel?.doctors).toEqual([
      { loop: "doc1", case: null },
      { loop: "doc2", case: held },
    ]);
  });

  describe("the case table's length", () => {
    const many = (count: number): CiCaseView[] =>
      Array.from({ length: count }, (_, index) => kase({ key: `flake:${index}`, subject: String(index) }));

    it("draws every case when there are few enough", () => {
      const panel = ciHealthPanel(dashboard([loop("doc", "ci-doctor")], read({ view: view({ cases: many(3) }) })));
      expect(panel?.health?.cases).toHaveLength(3);
      expect(panel?.moreCases).toBe(0);
    });

    it("truncates at the row limit and counts the rest, so the table says it was cut", () => {
      const panel = ciHealthPanel(
        dashboard([loop("doc", "ci-doctor")], read({ view: view({ cases: many(CASE_ROW_LIMIT + 5) }) })),
      );
      expect(panel?.health?.cases).toHaveLength(CASE_ROW_LIMIT);
      expect(panel?.moreCases).toBe(5);
    });

    it("never truncates the incidents, the parked tickets or the reverts", () => {
      const incidents = Array.from({ length: CASE_ROW_LIMIT + 2 }, (_, index) =>
        kase({ key: `infra:${index}`, subject: String(index), kind: "infra" }),
      );
      const panel = ciHealthPanel(dashboard([loop("doc", "ci-doctor")], read({ view: view({ incidents }) })));
      expect(panel?.health?.incidents).toHaveLength(CASE_ROW_LIMIT + 2);
      expect(panel?.moreCases).toBe(0);
    });
  });
});

describe("a case in one line", () => {
  it("says the state and the kind as prose, then what it is about", () => {
    expect(caseLine(kase())).toBe("confirmed flake · a.test.ts > one");
    expect(caseLine(kase({ kind: "regression", state: "filed", subject: "b.test.ts > two" }))).toBe(
      "filed regression · b.test.ts > two",
    );
    expect(caseLine(kase({ kind: "infra", subject: "agent lost" }))).toBe("confirmed infra · agent lost");
  });

  it("spells handed-off as a phrase, and leaves pr-specific the doctor's own word", () => {
    expect(stateWord("handed-off")).toBe("handed off");
    expect(caseLine(kase({ kind: "pr-specific", state: "handed-off", subject: "ralph/160:a.test.ts > one" }))).toBe(
      "handed off pr-specific · ralph/160:a.test.ts > one",
    );
  });
});

describe("a case key read past its kind", () => {
  it("strips the prefix, so a rule and an unpark spell a test the same way the table does", () => {
    expect(subjectOf("flake:src/a.test.ts > flaps")).toBe("src/a.test.ts > flaps");
    expect(subjectOf("pr-specific:ralph/160:src/a.test.ts > flaps")).toBe("ralph/160:src/a.test.ts > flaps");
    expect(subjectOf("parked:1109")).toBe("1109");
  });

  it("leaves a key with no prefix alone rather than eating its first character", () => {
    expect(subjectOf("bare")).toBe("bare");
  });
});

describe("what a loop card leads with", () => {
  it("shows a doctor its case rather than a ticket", () => {
    expect(cardLead({ case: kase(), issue: 7, issueTitle: "something else" })).toBe("confirmed flake · a.test.ts > one");
  });

  it("falls through to the ticket exactly as the card built it before", () => {
    expect(cardLead({ case: null, issue: 160, issueTitle: "CI doctor: dashboard CI health panel" })).toBe(
      "#160 CI doctor: dashboard CI health panel",
    );
    expect(cardLead({ case: null, issue: 160, issueTitle: null })).toBe("#160");
  });

  it("leads with nothing when there is neither a case nor a ticket", () => {
    expect(cardLead({ case: null, issue: null, issueTitle: null })).toBeNull();
  });
});

describe("what a doctor's row says about its case", () => {
  it("says what it holds", () => {
    expect(caseWord(kase(), true)).toBe("confirmed flake · a.test.ts > one");
  });

  it("tells a doctor holding nothing from a store nobody read", () => {
    // `contracts.ts`: "A card that said 'no case' on the strength of a read
    // that did not happen would be the one wrong answer." The row cannot
    // honour that without being told which null it has.
    expect(caseWord(null, true)).toBe("holding no case");
    expect(caseWord(null, false)).toBe("case unknown — the store was not read");
  });
});

describe("the tones", () => {
  it("says an unmeasured main in words, not as a third colour", () => {
    expect(mainWord("green")).toBe("green");
    expect(mainWord("red")).toBe("red");
    expect(mainWord("unknown")).toBe("not measured yet");
  });

  it("marks a case that has taken main down, whatever else it has cost", () => {
    expect(caseTone(kase({ mainReds: 0, redBuilds: 40, dequeues: 9 }))).toBe("neutral");
    expect(caseTone(kase({ mainReds: 1, redBuilds: 0, dequeues: 0 }))).toBe("bad");
  });

  it("reads an infra incident as a warning, unless it has taken main down", () => {
    // There is nothing in the diff to fix, and the doctor's whole response is
    // a notification — so `warn`, not `bad`.
    expect(incidentTone(kase({ kind: "infra", mainReds: 0 }))).toBe("warn");
    expect(incidentTone(kase({ kind: "infra", mainReds: 2 }))).toBe("bad");
  });

  it("reads an unmeasured main as neutral, not as bad news", () => {
    expect(mainTone("green")).toBe("good");
    expect(mainTone("red")).toBe("bad");
    expect(mainTone("unknown")).toBe("neutral");
  });

  it("warns only once the retries are actually spent", () => {
    expect(retryTone({ day: "2026-10-05", count: 0, cap: 6, today: true })).toBe("neutral");
    expect(retryTone({ day: "2026-10-05", count: 5, cap: 6, today: true })).toBe("neutral");
    expect(retryTone({ day: "2026-10-05", count: 6, cap: 6, today: true })).toBe("warn");
    expect(retryTone({ day: "2026-10-05", count: 7, cap: 6, today: true })).toBe("warn");
  });

  it("does not warn over a count that is not today's", () => {
    // The panel says "not today's count" beside this number. An amber figure
    // there would have the colour contradicting the sentence.
    expect(retryTone({ day: "2026-10-04", count: 6, cap: 6, today: false })).toBe("neutral");
    expect(retryTone({ day: null, count: 0, cap: 6, today: false })).toBe("neutral");
  });

  it("does not warn on a project that has turned retries off", () => {
    // Zero of zero spent is not pressure; it is a project that configured the
    // doctor to retry nothing.
    expect(retryTone({ day: "2026-10-05", count: 0, cap: 0, today: true })).toBe("neutral");
  });
});

describe("the 14-day trend (#163)", () => {
  const metrics = (days: [number, number][]): CiMetricsView => ({
    days: days.map(([knownFlakeReds, parkedOnFlake], index) => ({
      day: `2026-10-${String(index + 1).padStart(2, "0")}`,
      knownFlakeReds,
      parkedOnFlake,
    })),
    reds: days.reduce((sum, [reds]) => sum + reds, 0),
    parkedPeak: days.reduce((most, [, parked]) => Math.max(most, parked), 0),
    recorded: true,
  });

  it("scales both series against ONE peak, so one parked ticket cannot look like ten reds", () => {
    const trend = ciTrend(metrics([[10, 1], [0, 0]]));
    expect(trend.peak).toBe(10);
    expect(trend.bars[0]!.redHeight).toBe(100);
    expect(trend.bars[0]!.parkedHeight).toBe(10);
  });

  it("gives a non-zero count a visible floor, and the tested height IS the drawn one", () => {
    // One red against a peak of 100 rounds to 1% and then to nothing a reader
    // can see; "one red" must not draw the same as "none". The floor is here
    // rather than in the panel so this assertion is about what renders.
    const trend = ciTrend(metrics([[100, 0], [1, 0]]));
    expect(trend.bars[1]!.redHeight).toBe(2);
    expect(trend.bars[1]!.parkedHeight).toBe(0);
  });

  it("tells a fortnight nobody measured from a fortnight with nothing in it", () => {
    expect(trendState(ciTrend({ ...metrics([[0, 0]]), recorded: false }))).toBe("unrecorded");
    expect(trendState(ciTrend(metrics([[0, 0]])))).toBe("quiet");
    expect(trendState(ciTrend(metrics([[1, 0]])))).toBe("drawn");
  });

  it("marks the last day as today, since the series ends on the day of the read", () => {
    const trend = ciTrend(metrics([[1, 0], [2, 0], [3, 0]]));
    expect(trend.bars.map((bar) => bar.today)).toEqual([false, false, true]);
  });

  it("labels a day from its own UTC numbers, so a reader west of Greenwich is not a day out", () => {
    expect(ciTrend(metrics([[0, 0]])).bars[0]!.label).toBe("Thu 1 Oct");
  });

  it("gives a quiet fortnight a peak of zero rather than dividing by it", () => {
    const trend = ciTrend(metrics([[0, 0], [0, 0]]));
    expect(trend.peak).toBe(0);
    expect(trend.bars.map((bar) => bar.redHeight)).toEqual([0, 0]);
  });

  it("ticks the y-axis at the peak, its half and zero, never twice at one height", () => {
    expect(trendTicks(11)).toEqual([11, 6, 0]);
    expect(trendTicks(10)).toEqual([10, 5, 0]);
    expect(trendTicks(2)).toEqual([2, 1, 0]);
    // 1 halves (and rounds) back to 1: one label, not two stacked.
    expect(trendTicks(1)).toEqual([1, 0]);
    expect(trendTicks(0)).toEqual([0]);
    expect(ciTrend(metrics([[4, 7]])).ticks).toEqual([7, 4, 0]);
  });

  it("labels every third day counted back from today, and today as Today", () => {
    const days: [number, number][] = Array.from({ length: 14 }, () => [1, 0]);
    const labels = ciTrend(metrics(days)).bars.map((bar) => bar.axisLabel);
    expect(labels).toEqual(["", "Fri 2", "", "", "Mon 5", "", "", "Thu 8", "", "", "Sun 11", "", "", "Today"]);
  });

  it("words a day's popover with singulars agreeing", () => {
    expect(trendDetail("Thu 1 Oct", 1, 1)).toEqual({
      label: "Thu 1 Oct",
      reds: "1 known-flake red",
      parked: "1 parked",
      aria: "Thu 1 Oct: 1 known-flake red, 1 parked",
    });
    expect(trendDetail("Thu 1 Oct", 0, 3).reds).toBe("0 known-flake reds");
    expect(ciTrend(metrics([[2, 0]])).bars[0]!.detail.aria).toBe("Thu 1 Oct: 2 known-flake reds, 0 parked");
  });

  it("opens the popover leftwards for the right half, so it never leaves the card", () => {
    const trend = ciTrend(metrics([[1, 0], [1, 0], [1, 0], [1, 0]]));
    expect(trend.bars.map((bar) => bar.flip)).toEqual([false, false, true, true]);
  });

  it("reports today's reds from the last day", () => {
    expect(ciTrend(metrics([[5, 0], [3, 1]])).todayReds).toBe(3);
    expect(ciTrend(metrics([])).todayReds).toBe(0);
  });

  it("carries through whether anything was recorded, which a flat series cannot say", () => {
    expect(ciTrend({ ...metrics([[0, 0]]), recorded: false }).recorded).toBe(false);
  });
});

describe("the wait medians (#163)", () => {
  it("says no iteration waited rather than nought minutes", () => {
    // A median of nothing is not zero, and zero would claim the loops never
    // wait on CI — the opposite of what the figure exists to measure.
    expect(waitCell({ minutes: null, iterations: 0 }, { minutes: null, iterations: 0 })).toEqual({
      figure: null,
      unit: "no iteration waited in 24 h",
      week: "no iteration waited over 7 d",
      title: "median over 24 h: no iteration waited",
    });
  });

  it("leads with the day's median and puts the week's under it", () => {
    expect(waitCell({ minutes: 7.4, iterations: 9 }, { minutes: 6, iterations: 41 })).toEqual({
      figure: "7.4",
      unit: "min · 24h",
      week: "6 min over 7 d · 41 iterations",
      title: "median of 9 iterations over 24 h",
    });
  });

  it("counts one iteration in the singular", () => {
    const cell = waitCell({ minutes: 3, iterations: 1 }, { minutes: 3, iterations: 1 });
    expect(cell.week).toBe("3 min over 7 d · 1 iteration");
    expect(cell.title).toBe("median of 1 iteration over 24 h");
  });

  it("keeps the week line when the day has no median", () => {
    // A quiet day inside a busy week is the common case overnight.
    const cell = waitCell({ minutes: null, iterations: 0 }, { minutes: 12, iterations: 4 });
    expect(cell.figure).toBeNull();
    expect(cell.week).toBe("12 min over 7 d · 4 iterations");
  });

  it("warns once a typical iteration waits as long as the supervisor's cap", () => {
    expect(waitTone(24.9)).toBe("neutral");
    expect(waitTone(25)).toBe("warn");
    expect(waitTone(null)).toBe("neutral");
  });

  it("draws nothing at all for a project whose loops have opened no PR in a week", () => {
    const quiet = { ciIterations: 0, ciMinutes: null, queueIterations: 0, queueMinutes: null };
    expect(anyWaits({ day: quiet, week: quiet, unreadable: [] })).toBe(false);
    expect(anyWaits({ day: quiet, week: { ...quiet, queueIterations: 1, queueMinutes: 4 }, unreadable: [] })).toBe(true);
  });
});

describe("the status strip", () => {
  // Two hours twenty after `view()`'s main went green.
  const now = Date.parse("2026-10-05T11:20:00.000Z");
  const tile = (health: CiHealthView, key: string) => {
    const found = ciStrip(health, now).find((entry) => entry.key === key);
    if (found === undefined) throw new Error(`no ${key} tile`);
    return found;
  };

  it("is always the same four tiles in the same order", () => {
    expect(ciStrip(view(), now).map((entry) => entry.key)).toEqual(["main", "incidents", "lost", "retries"]);
    expect(ciStrip(view(), now).map((entry) => entry.label)).toEqual([
      "Main",
      "Infra incidents",
      "CI time lost · 24h",
      "Retries today",
    ]);
  });

  describe("how long ago", () => {
    const at = "2026-10-05T00:00:00.000Z";
    const after = (minutes: number) => spanSince(at, Date.parse(at) + minutes * 60_000);

    it("says minutes, hours and days in at most two units", () => {
      expect(after(0)).toBe("0m");
      expect(after(45)).toBe("45m");
      expect(after(80)).toBe("1h 20m");
      expect(after(120)).toBe("2h");
      expect(after(3 * 1440 + 4 * 60 + 59)).toBe("3d 4h");
      expect(after(2 * 1440)).toBe("2d");
    });

    it("clamps a future instant to now and refuses one that does not parse", () => {
      expect(after(-30)).toBe("0m");
      expect(spanSince("not a date", Date.parse(at))).toBeNull();
    });
  });

  describe("main", () => {
    it("says the colour, how long it has held, and the build", () => {
      expect(tile(view(), "main")).toEqual({
        key: "main",
        label: "Main",
        value: "green",
        unit: "2h 20m",
        detail: "build #412",
        tone: "good",
        title: "2026-10-05T09:00:00.000Z",
      });
    });

    it("drops the span and the hover when there is no since, and says when there is no build", () => {
      const main = tile(view({ main: { state: "unknown", since: null, build: null } }), "main");
      expect(main).toMatchObject({ value: "not measured yet", unit: null, detail: "no build recorded", tone: "neutral", title: null });
    });

    it("keeps the build when only since is missing", () => {
      expect(tile(view({ main: { state: "red", since: null, build: 9 } }), "main")).toMatchObject({
        value: "red",
        unit: null,
        detail: "build #9",
        tone: "bad",
      });
    });
  });

  describe("infra incidents", () => {
    const incident = (subject: string, mainReds = 0) => kase({ key: `infra:${subject}`, subject, kind: "infra", mainReds });

    it("reads none as neutral", () => {
      expect(tile(view(), "incidents")).toMatchObject({ value: "0", unit: "open", detail: "none open", tone: "neutral" });
    });

    it("names a single incident and warns", () => {
      expect(tile(view({ incidents: [incident("agent lost")] }), "incidents")).toMatchObject({
        value: "1",
        detail: "agent lost",
        tone: "warn",
      });
    });

    it("names the first and counts the rest, bad when any has taken main down", () => {
      const health = view({ incidents: [incident("agent lost"), incident("registry down", 1), incident("dns")] });
      expect(tile(health, "incidents")).toMatchObject({ value: "3", detail: "agent lost +2 more", tone: "bad" });
    });
  });

  describe("CI time lost", () => {
    it("says zero plainly when nothing flaked", () => {
      expect(tile(view(), "lost")).toMatchObject({ value: "0", unit: "min", detail: "no known-flake reds", tone: "neutral" });
    });

    it("prints no figure when reds could not be timed", () => {
      const health = view({ lostTime: { reds: 3, medianBuildMinutes: null, minutes: null } });
      expect(tile(health, "lost")).toMatchObject({
        value: "—",
        unit: null,
        detail: "3 known-flake reds · no build could be timed",
        tone: "neutral",
      });
    });

    it("calls the figure an estimate and never tints it", () => {
      const health = view({ lostTime: { reds: 1, medianBuildMinutes: 400, minutes: 400 } });
      expect(tile(health, "lost")).toMatchObject({
        value: "400",
        unit: "min",
        detail: "1 known-flake red · estimate",
        tone: "neutral",
      });
    });
  });

  describe("retries", () => {
    it("says none has been recorded on a store that names no day", () => {
      expect(tile(view({ retries: { day: null, count: 0, cap: 6, today: false } }), "retries")).toMatchObject({
        value: "0",
        unit: "/ 6",
        detail: "none recorded yet",
        tone: "neutral",
      });
    });

    it("counts what is left today", () => {
      expect(tile(view(), "retries")).toMatchObject({ value: "1", unit: "/ 6", detail: "5 left today", tone: "neutral" });
    });

    it("warns once today's allowance is spent", () => {
      expect(tile(view({ retries: { day: "2026-10-05", count: 6, cap: 6, today: true } }), "retries")).toMatchObject({
        value: "6",
        detail: "allowance spent",
        tone: "warn",
      });
    });

    it("says a count from another day is not today's, without the warning colour", () => {
      expect(tile(view({ retries: { day: "2026-10-04", count: 6, cap: 6, today: false } }), "retries")).toMatchObject({
        value: "6",
        detail: "on 2026-10-04, not today's count",
        tone: "neutral",
      });
    });
  });
});

describe("what needs attention", () => {
  it("counts each list, in the singular where it is one", () => {
    expect(attentionSummary({ incidents: 1, cases: 3, parked: 2 })).toBe("1 incident · 3 tests · 2 parked");
    expect(attentionSummary({ incidents: 2, cases: 1, parked: 1 })).toBe("2 incidents · 1 test · 1 parked");
  });

  it("drops a zero part rather than printing it", () => {
    expect(attentionSummary({ incidents: 0, cases: 4, parked: 0 })).toBe("4 tests");
    expect(attentionSummary({ incidents: 1, cases: 0, parked: 3 })).toBe("1 incident · 3 parked");
  });

  it("is null when there is nothing to attend to, so no card is drawn", () => {
    expect(attentionSummary({ incidents: 0, cases: 0, parked: 0 })).toBeNull();
  });
});

describe("a test's name and its file", () => {
  it("splits on the last separator, so nested describes stay with the path", () => {
    expect(testName("src/a.test.ts > suite > flaps")).toEqual({ name: "flaps", path: "src/a.test.ts > suite" });
    expect(testName("a.test.ts > one")).toEqual({ name: "one", path: "a.test.ts" });
  });

  it("is all name when there is no separator", () => {
    expect(testName("runner-disk-full")).toEqual({ name: "runner-disk-full", path: null });
  });
});

describe("a case's cost", () => {
  it("names the three costs, tinting main's when there is any", () => {
    expect(costParts(kase({ redBuilds: 3, mainReds: 1, dequeues: 2 }))).toEqual({
      reds: "3",
      redsWords: "reds/72h",
      main: "1 on main",
      mainTone: "bad",
      dequeues: "2 dequeues",
    });
  });

  it("says one dequeue in the singular, and a clean main in the neutral tone", () => {
    const parts = costParts(kase({ mainReds: 0, dequeues: 1 }));
    expect(parts.dequeues).toBe("1 dequeue");
    expect(parts.main).toBe("0 on main");
    expect(parts.mainTone).toBe("neutral");
  });
});
