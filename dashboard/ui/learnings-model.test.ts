// @vitest-environment node
/**
 * The learnings panel's decisions (#201). `.tsx` has no tests, so what the
 * panel will show is pinned here: when it renders nothing at all, what it says
 * instead of a bare zero, where each entry's fix stands, and the order the
 * list reads in.
 */
import { describe, expect, it } from "vitest";

import type { Dashboard, LearningEntryView, LearningsRead, LearningsSourceView } from "../contracts";
import {
  ageLabel,
  filingOutcome,
  fixLabel,
  fixStatus,
  inlinePieces,
  learningsCount,
  learningsPanel,
  learningsSummary,
  listedFixed,
  listedItems,
  nothingLearned,
} from "./learnings-model";

const dashboard = (learnings: LearningsRead | null): Dashboard => ({
  generatedAt: "2026-10-06T01:00:00.000Z",
  loops: [],
  reconciliation: { orphaned: [], prunable: [] },
  unattributed: [],
  ownership: { issues: [], contested: [], sources: { leases: "ok", github: "ok" } },
  frontier: null,
  ciHealth: null,
  following: null,
  learnings,
});

const BASE = "https://github.com/felipearos/ralph/blob/main";

const read = (sources: LearningsRead["sources"], base: string | null = BASE): LearningsRead => ({ base, sources });

const entry = (title: string, extra: Partial<LearningEntryView> = {}): LearningEntryView => ({
  slug: title.toLowerCase().replace(/\W+/g, "-"),
  title,
  date: null,
  anchor: title.toLowerCase().replace(/\s/g, "-"),
  seen: null,
  workaround: null,
  fix: null,
  change: null,
  verify: null,
  seenAgain: [],
  fixPending: false,
  ...extra,
});

const project: LearningsSourceView = {
  scope: "project",
  file: "learnings/loggd.md",
  entries: [
    entry("A missing TMDB fixture parks PRs", { date: "2026-09-30", fix: "#1890.", seenAgain: ["2026-10-01", "2026-10-02", "2026-10-03"] }),
    entry("CI is sensitive to host load"),
  ],
  fixed: [
    { problem: "Older", fixedBy: "#1" },
    { problem: "Newer", fixedBy: "#2" },
  ],
  present: true,
};
const harness: LearningsSourceView = {
  scope: "harness",
  file: "learnings/harness.md",
  entries: [entry("Parked PRs starve the loops", { date: "2026-10-04", fix: "no issue yet.", fixPending: true, seenAgain: ["2026-10-05"] })],
  fixed: [],
  present: true,
};
const absent = (source: LearningsSourceView): LearningsSourceView => ({ ...source, entries: [], fixed: [], present: false });
const empty = (source: LearningsSourceView): LearningsSourceView => ({ ...source, entries: [], fixed: [], present: true });

describe("learningsPanel", () => {
  it("counts both files, keeps their order, and links each entry to its heading on GitHub", () => {
    const panel = learningsPanel(dashboard(read([project, harness])));
    expect(panel?.total).toBe(3);
    expect(panel?.rows.map((row) => [row.scope, row.count])).toEqual([
      ["project", 2],
      ["harness", 1],
    ]);
    expect(panel?.rows[0]?.href).toBe(`${BASE}/learnings/loggd.md`);
    expect(panel?.rows[0]?.items[1]?.href).toBe(`${BASE}/learnings/loggd.md#ci-is-sensitive-to-host-load`);
  });

  it("reads sightings, age and readiness off each entry", () => {
    const [tmdb, ci] = learningsPanel(dashboard(read([project])))?.rows[0]?.items ?? [];
    expect(tmdb).toMatchObject({ seenCount: 4, lastSeen: "2026-10-03", hot: true, ageDays: 6, readyForCoder: false, fileable: false });
    expect(ci).toMatchObject({ seenCount: 1, lastSeen: null, hot: false, ageDays: null });
    const ready = learningsPanel(dashboard(read([{ ...harness, entries: [entry("x", { change: "c", verify: "v" })] }])));
    expect(ready?.rows[0]?.items[0]?.readyForCoder).toBe(true);
  });

  it("is null when no adapter supplied the learnings, so a failed read never reads as a clear list", () => {
    expect(learningsPanel(dashboard(null))).toBeNull();
    expect(learningsPanel(dashboard(read([])))).toBeNull();
  });

  it("shows the harness file alone for a project that opted out", () => {
    expect(learningsPanel(dashboard(read([harness])))?.rows.map((row) => row.scope)).toEqual(["harness"]);
  });

  it("leaves the entries unlinked rather than dead when the remote is not readable", () => {
    const panel = learningsPanel(dashboard(read([project, harness], null)));
    expect(panel?.rows.map((row) => row.href)).toEqual([null, null]);
    expect(panel?.rows[0]?.items.map((one) => one.href)).toEqual([null, null]);
  });
});

describe("fixStatus", () => {
  it("links a ticket URL and keeps a bare #n unlinked", () => {
    expect(fixStatus({ fix: "https://github.com/felipearos/loggd/issues/2818 — needs a check", fixPending: false })).toEqual({
      kind: "ticket",
      label: "#2818",
      href: "https://github.com/felipearos/loggd/issues/2818",
    });
    expect(fixStatus({ fix: "#168 includes an opt-in live test.", fixPending: false })).toEqual({ kind: "ticket", label: "#168", href: null });
  });

  it("says queued for the placeholder the filer will turn into a ticket, whatever follows it", () => {
    expect(fixStatus({ fix: "no issue yet — an operator must restore access.", fixPending: true })).toEqual({ kind: "queued" });
  });

  it("tells a duplicate and an operator's job apart from an unfiled fix", () => {
    expect(fixStatus({ fix: "duplicate; close together with `prod-ledger`.", fixPending: false })).toEqual({ kind: "duplicate" });
    expect(fixStatus({ fix: "operator side, no issue yet. Apply it by hand.", fixPending: false })).toEqual({ kind: "operator" });
    expect(fixStatus({ fix: "strip ANSI in `parseConfigProblems`", fixPending: false })).toEqual({ kind: "none" });
    expect(fixStatus({ fix: null, fixPending: false })).toEqual({ kind: "none" });
  });
});

describe("listedItems", () => {
  const panel = learningsPanel(dashboard(read([project, harness])))!;

  it("puts the most-seen first, then newest, undated last", () => {
    expect(listedItems(panel, "all").map((one) => [one.title, one.seenCount])).toEqual([
      ["A missing TMDB fixture parks PRs", 4],
      ["Parked PRs starve the loops", 2],
      ["CI is sensitive to host load", 1],
    ]);
  });

  it("keeps one file when filtered", () => {
    expect(listedItems(panel, "harness").map((one) => one.scope)).toEqual(["harness"]);
  });
});

describe("learningsSummary and listedFixed", () => {
  const panel = learningsPanel(dashboard(read([project, harness])))!;

  it("counts open and fixed for the filter", () => {
    expect(learningsSummary(panel, "all")).toEqual({ open: 3, fixed: 2 });
    expect(learningsSummary(panel, "harness")).toEqual({ open: 1, fixed: 0 });
  });

  it("lists the Fixed rows newest first", () => {
    expect(listedFixed(panel, "all").map((one) => one.problem)).toEqual(["Newer", "Older"]);
  });
});

describe("filing a ticket", () => {
  const withEvidence = (fix: string | null, fixPending = false) =>
    learningsPanel(dashboard(read([{ ...harness, entries: [entry("x", { seen: "s", workaround: "w", fix, fixPending })] }])))!.rows[0]!.items[0]!;

  it("offers File ticket on an entry with its evidence and no ticket, queued or not", () => {
    expect(withEvidence(null).fileable).toBe(true);
    expect(withEvidence("operator side. By hand.").fileable).toBe(true);
    expect(withEvidence("no issue yet.", true).fileable).toBe(true);
  });

  it("never offers it where a ticket or a duplicate already stands, or the evidence is missing", () => {
    expect(withEvidence("https://github.com/o/r/issues/9").fileable).toBe(false);
    expect(withEvidence("duplicate; see `y`.").fileable).toBe(false);
    const thin = learningsPanel(dashboard(read([{ ...harness, entries: [entry("x", { seen: "s" })] }])))!.rows[0]!.items[0]!;
    expect(thin.fileable).toBe(false);
  });

  it("reads the harness's answer as filed, queued or refused", () => {
    expect(filingOutcome({ slug: "x", url: "https://github.com/o/r/issues/2901", problem: null })).toEqual({
      kind: "filed",
      label: "#2901",
      href: "https://github.com/o/r/issues/2901",
    });
    expect(filingOutcome({ slug: "x", url: null, problem: null })).toEqual({ kind: "queued" });
    expect(filingOutcome({ slug: "x", url: null, problem: "already reads #9" })).toEqual({ kind: "problem", text: "already reads #9" });
  });

  it("says nothing in the ticket column for an entry with no ticket", () => {
    expect([fixLabel({ kind: "ticket", label: "#9", href: null }), fixLabel({ kind: "queued" }), fixLabel({ kind: "operator" }), fixLabel({ kind: "none" })]).toEqual([
      "#9",
      "queued",
      "operator",
      null,
    ]);
  });
});

describe("nothingLearned", () => {
  it("is true only when neither file is on the ref", () => {
    const panel = learningsPanel(dashboard(read([absent(project), absent(harness)])));
    expect(panel !== null && nothingLearned(panel)).toBe(true);
  });

  it("is false for files that exist and are empty: a clear list is an achievement", () => {
    const panel = learningsPanel(dashboard(read([empty(project), empty(harness)])));
    expect(panel !== null && nothingLearned(panel)).toBe(false);
  });
});

describe("learningsCount", () => {
  it("says an absent file in words, not as a zero", () => {
    const panel = learningsPanel(dashboard(read([absent(project), empty(harness), project])))!;
    expect(panel.rows.map(learningsCount)).toEqual(["nothing learned yet", "no open entries", "2 open"]);
  });
});

describe("ageLabel and inlinePieces", () => {
  it("reads an age short", () => {
    expect([ageLabel(null), ageLabel(0), ageLabel(25)]).toEqual([null, "today", "25d"]);
  });

  it("splits code and bold, leaving stars inside code and unclosed marks alone", () => {
    expect(inlinePieces("run `a **b**` then **stop** `x")).toEqual([
      { kind: "text", text: "run " },
      { kind: "code", text: "a **b**" },
      { kind: "text", text: " then " },
      { kind: "bold", text: "stop" },
      { kind: "text", text: " `x" },
    ]);
  });
});
