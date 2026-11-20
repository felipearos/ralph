// @vitest-environment node
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { subprocessSuite } from "../test-timeouts";
import {
  appendEvent,
  clerkMetricsPath,
  isoWeek,
  localDay,
  outcomeOf,
  participation,
  precision,
  readEvents,
  reportsByMode,
  summarise,
  type MetricsEvent,
  type Outcome,
  type Override,
} from "./metrics";

subprocessSuite("git rev-parse in a scratch repo for the ledger path");

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (label: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `ralph-clerk-metrics-${label}-`)));
  scratch.push(dir);
  return dir;
};

const base = { v: 1 as const, at: "2026-10-20T15:00:00.000Z", mode: "live" as const };
const reported = (report: string, reporter = "U1", reportedAt = "2026-10-20T15:00:00.000Z", reporterName?: string): MetricsEvent => ({
  ...base,
  kind: "reported",
  report,
  reporter,
  channel: "C1",
  reportedAt,
  ...(reporterName !== undefined ? { reporterName } : {}),
});
const classified = (report: string, app = "backoffice"): MetricsEvent => ({
  ...base,
  kind: "classified",
  report,
  key: `OAI-${report}`,
  verdict: "file",
  type: "Bug",
  app,
  priority: "High",
  difficulty: "medium",
  storyPoints: 3,
});
const confirmed = (report: string, overrides: Override[] = [], latencyMs = 60_000): MetricsEvent => ({
  ...base,
  kind: "confirmed",
  report,
  key: `OAI-${report}`,
  by: { accountId: "acc-1", displayName: "Rafa" },
  latencyMs,
  overrides,
});
const closed = (report: string, resolution: string | null, status = "Done"): MetricsEvent => ({
  ...base,
  kind: "closed",
  report,
  key: `OAI-${report}`,
  resolution,
  status,
});
const rejected = (report: string): MetricsEvent => ({ ...base, kind: "rejected", report });
const ignored = (report: string): MetricsEvent => ({ ...base, kind: "ignored", report, reason: "chatter" });
const duplicate = (report: string): MetricsEvent => ({ ...base, kind: "duplicate", report, of: "OAI-1" });
const moved = (report: string): MetricsEvent => ({ ...base, kind: "moved", report, oaKey: "OA-9" });

describe("outcomeOf", () => {
  const cases: [string, MetricsEvent[], Outcome][] = [
    ["confirmed then closed Done", [reported("r"), confirmed("r"), closed("r", "Done")], "valuable"],
    ["confirmed, moved, then closed Fixed", [reported("r"), confirmed("r"), moved("r"), closed("r", "Fixed")], "valuable"],
    ["confirmed then closed as Won't Do", [reported("r"), confirmed("r"), closed("r", "Won't Do")], "noise"],
    ["confirmed then closed as cannot reproduce, any case", [confirmed("r"), closed("r", "cannot reproduce")], "noise"],
    ["confirmed then closed Descartado", [confirmed("r"), closed("r", "Descartado")], "noise"],
    ["confirmed and still open", [reported("r"), classified("r"), confirmed("r")], "pending"],
    ["confirmed and moved, not closed", [confirmed("r"), moved("r")], "pending"],
    ["closed Done without a confirmation", [reported("r"), closed("r", "Done")], "pending"],
    ["closed Won't Fix without a confirmation", [reported("r"), closed("r", "Won't Fix")], "noise"],
    ["ignored", [reported("r"), ignored("r")], "noise"],
    // Already reported: counted apart, neither noise nor new work.
    ["duplicate", [reported("r"), duplicate("r")], "duplicate"],
    ["rejected at confirmation", [reported("r"), classified("r"), rejected("r")], "noise"],
    ["ignored, re-opened, confirmed and done", [ignored("r"), confirmed("r"), closed("r", "Done")], "valuable"],
    ["only reported", [reported("r")], "pending"],
    ["only classified", [reported("r"), classified("r")], "pending"],
    ["confirmed then closed with no resolution", [confirmed("r"), closed("r", null)], "valuable"],
  ];
  it.each(cases)("%s", (_name, events, outcome) => {
    expect(outcomeOf(events)).toBe(outcome);
  });

  it("takes a configured won't-do set", () => {
    const events = [confirmed("r"), closed("r", "Obsolete")];
    expect(outcomeOf(events)).toBe("valuable");
    expect(outcomeOf(events, ["Obsolete"])).toBe("noise");
  });
});

describe("summarise", () => {
  const ledger: MetricsEvent[] = [
    reported("a", "U1", "2026-10-20T15:00:00.000Z", "Ana"),
    classified("a", "backoffice"),
    confirmed("a", [{ field: "priority", agent: "High", human: "Low" }, { field: "storyPoints", agent: 3, human: 5 }], 60_000),
    closed("a", "Done"),
    reported("b", "U1", "2026-10-21T15:00:00.000Z"),
    classified("b", "pwa"),
    confirmed("b", [{ field: "storyPoints", agent: 2, human: 1 }], 180_000),
    closed("b", "Won't Do"),
    reported("c", "U1", "2026-10-22T15:00:00.000Z"),
    classified("c", "backoffice"),
    confirmed("c", [], 120_000),
    reported("d", "U2", "2026-10-22T16:00:00.000Z"),
    ignored("d"),
  ];

  it("groups by reporter with outcome counts and rates", () => {
    const rows = summarise(ledger, { by: "reporter" });
    expect(rows).toEqual([
      {
        key: "U1",
        label: "Ana",
        reports: 3,
        valuable: 1,
        noise: 1,
        pending: 1,
        duplicates: 0,
        noiseRate: 1 / 3,
        confirmed: 3,
        overrideRate: 2 / 3,
        overridesByField: { priority: 1, storyPoints: 2 },
        overrideRateByField: { priority: 1 / 3, storyPoints: 2 / 3 },
        topChanges: [
          { field: "priority", agent: "High", human: "Low", count: 1 },
          { field: "storyPoints", agent: 2, human: 1, count: 1 },
          { field: "storyPoints", agent: 3, human: 5, count: 1 },
        ],
        medianConfirmLatencyMs: 120_000,
      },
      {
        key: "U2",
        reports: 1,
        valuable: 0,
        noise: 1,
        pending: 0,
        duplicates: 0,
        noiseRate: 1,
        confirmed: 0,
        overrideRate: null,
        overridesByField: {},
        overrideRateByField: {},
        topChanges: [],
        medianConfirmLatencyMs: null,
      },
    ]);
  });

  it("counts story points like any other overridden field, once per ticket", () => {
    const rows = summarise(
      [
        reported("x"),
        confirmed("x", [
          { field: "storyPoints", agent: 1, human: 2 },
          { field: "storyPoints", agent: 2, human: 3 },
          { field: "assignee", agent: "a", human: "b" },
        ]),
      ],
      { by: "reporter" },
    );
    expect(rows[0]!.overridesByField).toEqual({ storyPoints: 1, assignee: 1 });
    expect(rows[0]!.overrideRate).toBe(1);
  });

  it("ranks the most common clerk→person changes, leaving free text out", () => {
    const events: MetricsEvent[] = [];
    const confirmations: [string, Override[]][] = [
      ["p", [{ field: "priority", agent: "High", human: "Low" }, { field: "summary", agent: "Bug", human: "Login fails" }]],
      ["q", [{ field: "priority", agent: "High", human: "Low" }, { field: "assigneeKind", agent: "backend", human: "frontend" }]],
      ["r", [{ field: "priority", agent: "Low", human: "High" }, { field: "difficulty", agent: "easy", human: null }]],
    ];
    for (const [report, overrides] of confirmations) events.push(reported(report), confirmed(report, overrides));
    const [row] = summarise(events, { by: "reporter" });
    expect(row!.topChanges).toEqual([
      { field: "priority", agent: "High", human: "Low", count: 2 },
      { field: "assigneeKind", agent: "backend", human: "frontend", count: 1 },
      { field: "difficulty", agent: "easy", human: null, count: 1 },
      { field: "priority", agent: "Low", human: "High", count: 1 },
    ]);
    expect(row!.overridesByField).toEqual({ priority: 3, summary: 1, assigneeKind: 1, difficulty: 1 });
    expect(row!.overrideRateByField).toEqual({ priority: 1, summary: 1 / 3, assigneeKind: 1 / 3, difficulty: 1 / 3 });
  });

  it("uses a report's latest confirmation only", () => {
    const rows = summarise(
      [reported("x"), confirmed("x", [{ field: "priority", agent: "a", human: "b" }], 10), confirmed("x", [], 30)],
      { by: "reporter" },
    );
    expect(rows[0]).toMatchObject({ confirmed: 1, overrideRate: 0, overridesByField: {}, medianConfirmLatencyMs: 30 });
  });

  it("groups by the latest classified app, unknown without one", () => {
    const rows = summarise(ledger, { by: "app" });
    expect(rows.map((row) => [row.key, row.reports])).toEqual([
      ["backoffice", 2],
      ["(unknown)", 1],
      ["pwa", 1],
    ]);
  });

  it("groups by ISO week in Santiago, in time order", () => {
    const rows = summarise(
      [
        // Monday 2026-10-26 02:30 UTC is still Sunday the 25th in Santiago: week 43.
        reported("late", "U1", "2026-10-26T02:30:00.000Z"),
        reported("next", "U1", "2026-10-26T15:00:00.000Z"),
        reported("early", "U1", "2026-10-20T15:00:00.000Z"),
      ],
      { by: "week" },
    );
    expect(rows.map((row) => [row.key, row.reports])).toEqual([
      ["2026-W43", 2],
      ["2026-W44", 1],
    ]);
  });

  it("drops reports posted before --since, by the Santiago day", () => {
    const rows = summarise(ledger, { by: "reporter", since: "2026-10-22" });
    expect(rows.map((row) => [row.key, row.reports])).toEqual([
      ["U1", 1],
      ["U2", 1],
    ]);
  });

  it("is empty for an empty ledger", () => {
    expect(summarise([], { by: "week" })).toEqual([]);
  });
});

describe("precision", () => {
  const confirmedAt = (report: string, key: string, at: string, overrides: Override[]): MetricsEvent => ({
    v: 1,
    at,
    kind: "confirmed",
    report,
    key,
    mode: "quiet",
    by: { accountId: "557058:ana", displayName: "Ana" },
    latencyMs: 1,
    overrides,
  });

  it("rates each field by how often a confirmer left it as proposed, and lists every correction newest first", () => {
    const events = [
      confirmedAt("r1", "OAI-1", "2026-10-20T15:00:00.000Z", [{ field: "priority", agent: "High", human: "Medium" }]),
      confirmedAt("r2", "OAI-2", "2026-10-21T15:00:00.000Z", [
        { field: "priority", agent: "High", human: "Medium" },
        { field: "summary", agent: "Uno", human: "Dos" },
      ]),
      confirmedAt("r3", "OAI-3", "2026-10-22T15:00:00.000Z", []),
      // Filed by hand: no proposal to compare, so it is left out.
      confirmedAt("OAI-4", "OAI-4", "2026-10-22T15:00:00.000Z", []),
    ];
    const view = precision(events);
    expect(view).toMatchObject({ confirmed: 3, exact: 1 });
    expect(view.precision).toBeCloseTo(1 / 3);
    const priority = view.byField.find((row) => row.field === "priority")!;
    expect(priority).toMatchObject({ confirmed: 3, corrected: 2, topChanges: [{ agent: "High", human: "Medium", count: 2 }] });
    // Free text is rated, never ranked as a common change.
    expect(view.byField.find((row) => row.field === "summary")).toMatchObject({ corrected: 1, topChanges: [] });
    expect(view.byWeek).toEqual([{ week: "2026-W43", confirmed: 3, exact: 1, precision: 1 / 3, correctedByField: { priority: 2, summary: 1 } }]);
    expect(view.corrections.map((one) => `${one.key} ${one.field}`)).toEqual(["OAI-2 priority", "OAI-2 summary", "OAI-1 priority"]);
    expect(view.corrections[0]).toMatchObject({ by: "Ana", agent: "High", human: "Medium" });
  });

  it("counts a ticket confirmed twice by its latest confirmation", () => {
    const view = precision([
      confirmedAt("r1", "OAI-1", "2026-10-20T15:00:00.000Z", [{ field: "type", agent: "Error", human: "Tarea" }]),
      confirmedAt("r1", "OAI-1", "2026-10-21T15:00:00.000Z", []),
    ]);
    expect(view).toMatchObject({ confirmed: 1, exact: 1, precision: 1, corrections: [] });
    expect(precision([])).toMatchObject({ confirmed: 0, precision: null });
  });
});

describe("participation (#459)", () => {
  it("counts each reporter's reports once, how lately and in how many weeks, the most recent first", () => {
    const now = Date.parse("2026-10-22T15:00:00.000Z");
    const events = [
      reported("r1", "U1", "2026-10-21T15:00:00.000Z", "Ana"),
      // The same report recorded twice (a rerun) is one report.
      reported("r1", "U1", "2026-10-21T15:00:00.000Z", "Ana"),
      reported("r2", "U1", "2026-09-01T15:00:00.000Z"),
      reported("r3", "U2", "2026-10-10T15:00:00.000Z"),
      classified("r3"),
    ];
    expect(participation(events, now)).toEqual([
      { key: "U1", label: "Ana", reports: 2, last7Days: 1, last30Days: 1, lastReportAt: "2026-10-21T15:00:00.000Z", activeWeeks: 2 },
      { key: "U2", reports: 1, last7Days: 0, last30Days: 1, lastReportAt: "2026-10-10T15:00:00.000Z", activeWeeks: 1 },
    ]);
    expect(participation([], now)).toEqual([]);
  });
});

describe("isoWeek and localDay", () => {
  it.each([
    ["2026-10-22", "2026-W43"],
    ["2026-01-01", "2026-W01"],
    ["2027-01-01", "2026-W53"],
    ["2024-12-30", "2025-W01"],
  ])("%s is %s", (day, week) => {
    expect(isoWeek(day)).toBe(week);
  });

  it("reads the day in Santiago and refuses garbage", () => {
    expect(localDay("2026-10-19T02:30:00.000Z")).toBe("2026-10-18");
    expect(localDay("not a time")).toBeNull();
  });
});

describe("the ledger file", () => {
  it("round-trips appended events and creates its directory", () => {
    const path = join(tempDir("append"), "deep", "dir", "clerk.metrics.jsonl");
    expect(appendEvent(path, reported("a"))).toBe(true);
    expect(appendEvent(path, ignored("a"))).toBe(true);
    expect(readEvents(path)).toEqual({ events: [reported("a"), ignored("a")], skippedLines: 0 });
  });

  it("keeps every override in full, the clerk's value and the person's, texts included", () => {
    const path = join(tempDir("overrides"), "clerk.metrics.jsonl");
    const overrides: Override[] = [
      { field: "type", agent: "Bug", human: "Story" },
      { field: "app", agent: "pwa", human: "backoffice" },
      { field: "priority", agent: "High", human: "Medium" },
      { field: "difficulty", agent: "easy", human: "hard" },
      { field: "storyPoints", agent: 2, human: 8 },
      { field: "assigneeKind", agent: "backend", human: "design" },
      { field: "summary", agent: "Login broken", human: "SSO login loops on Safari" },
      { field: "description", agent: "User says login is broken.\n\nSteps: unknown", human: "Safari 17, SSO.\n\n1. Open /login\n2. Loops" },
    ];
    expect(appendEvent(path, confirmed("a", overrides))).toBe(true);
    expect(readEvents(path).events).toEqual([confirmed("a", overrides)]);
  });

  it("returns false instead of throwing when the write fails", () => {
    const dir = tempDir("readonly");
    // A file where the directory should be: mkdir -p cannot succeed.
    writeFileSync(join(dir, "blocker"), "");
    expect(appendEvent(join(dir, "blocker", "clerk.metrics.jsonl"), reported("a"))).toBe(false);

    const locked = join(dir, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      // Root ignores the mode bits; the assertion is only that it never throws.
      expect(typeof appendEvent(join(locked, "clerk.metrics.jsonl"), reported("a"))).toBe("boolean");
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it("reads a missing ledger as empty", () => {
    expect(readEvents(join(tempDir("missing"), "nope.jsonl"))).toEqual({ events: [], skippedLines: 0 });
  });

  it("summarises the rest of a ledger whose last line is half-written", () => {
    const path = join(tempDir("truncated"), "clerk.metrics.jsonl");
    appendEvent(path, reported("a"));
    appendEvent(path, confirmed("a"));
    appendEvent(path, closed("a", "Done"));
    appendFileSync(path, JSON.stringify(reported("b")).slice(0, 30));
    const { events, skippedLines } = readEvents(path);
    expect(skippedLines).toBe(1);
    expect(summarise(events, { by: "reporter" })).toMatchObject([{ key: "U1", reports: 1, valuable: 1 }]);
  });

  it("reads quiet events, and keeps a report in the mode it started in when summarising by mode (#443)", () => {
    const path = join(tempDir("quiet"), "clerk.metrics.jsonl");
    const quiet = (event: MetricsEvent): MetricsEvent => ({ ...event, mode: "quiet" });
    // "q" is a quiet test report the clerk was flipped live in the middle of.
    for (const event of [quiet(reported("q", "U9")), quiet(confirmed("q")), closed("q", "Done"), reported("l"), confirmed("l"), closed("l", "Done")]) appendEvent(path, event);
    appendEvent(path, { ...ignored("s"), mode: "shadow" });
    const { events, skippedLines } = readEvents(path);
    expect(skippedLines).toBe(0);
    expect(reportsByMode(events)).toEqual({ shadow: 1, quiet: 1, live: 1 });
    expect(summarise(events, { by: "reporter", modes: ["live"] })).toMatchObject([{ key: "U1", reports: 1, valuable: 1 }]);
    expect(summarise(events, { by: "reporter", modes: ["quiet"] })).toMatchObject([{ key: "U9", reports: 1, valuable: 1 }]);
    expect(summarise(events, { by: "reporter" }).reduce((sum, row) => sum + row.reports, 0)).toBe(3);
  });

  it("drops a redone report's earlier shadow events, so the summary counts it once, as its new classification", () => {
    const path = join(tempDir("superseded"), "clerk.metrics.jsonl");
    const shadow = (event: MetricsEvent): MetricsEvent => ({ ...event, mode: "shadow" });
    const superseded: MetricsEvent = { ...base, mode: "shadow", kind: "superseded", report: "a" };
    // "a" was ignored in shadow, then redone and classified; "b" is untouched;
    // "c" had a live confirmation, which a shadow redo never takes back.
    for (const event of [
      shadow(reported("a")),
      shadow(ignored("a")),
      shadow(reported("b")),
      shadow(ignored("b")),
      reported("c"),
      confirmed("c"),
      { ...superseded, report: "c" },
      superseded,
      shadow(reported("a", "U1", "2026-10-20T15:00:00.000Z", "Ana")),
      shadow(classified("a")),
    ]) appendEvent(path, event);
    const { events } = readEvents(path);
    expect(events).toEqual([
      shadow(reported("b")),
      shadow(ignored("b")),
      reported("c"),
      confirmed("c"),
      shadow(reported("a", "U1", "2026-10-20T15:00:00.000Z", "Ana")),
      shadow(classified("a")),
    ]);
    expect(summarise(events, { by: "reporter" })).toMatchObject([{ key: "U1", label: "Ana", reports: 3, noise: 1, pending: 2, confirmed: 1 }]);
    expect(participation(events, Date.parse("2026-10-21T00:00:00Z"))).toMatchObject([{ key: "U1", reports: 3 }]);
  });

  it("counts lines that parse but are not events", () => {
    const path = join(tempDir("garbled"), "clerk.metrics.jsonl");
    writeFileSync(path, ['{"v":2,"kind":"reported"}', "[]", '{"v":1,"kind":"nope","at":"x","report":"r","mode":"live"}', JSON.stringify(ignored("r")), ""].join("\n"));
    expect(readEvents(path)).toEqual({ events: [ignored("r")], skippedLines: 3 });
  });
});

describe("clerkMetricsPath", () => {
  it("is beside the clerk store, in the git common dir", () => {
    const repo = tempDir("repo");
    execFileSync("git", ["init", "-q", repo]);
    expect(clerkMetricsPath("clara", repo)).toBe(join(repo, ".git", "ralph", "clerk", "clara.metrics.jsonl"));
  });

  it("falls back to the directory when git has no answer", () => {
    // A directory git cannot run in is the deterministic "outside git": a real
    // tmpdir may sit inside some other repository on a developer's machine.
    const dir = join(tempDir("nogit"), "gone");
    expect(clerkMetricsPath("clara", dir)).toBe(join(dir, ".ralph-clerk", "clara.metrics.jsonl"));
  });
});
