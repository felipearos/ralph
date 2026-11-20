import { describe, expect, it } from "vitest";

import { gatherSignals, rankSuggestions, reviewsByOthers, type MergedPr, type Suggestion, type SuggestionInput } from "./evals-suggest";
import type { SpeedEvent } from "./speed";
import { createFakeTracker } from "./tracker/fake";
import type { Tracker } from "./tracker/types";

const REPO = "felipearos/loggd";

const pr = (number: number, extra: Partial<MergedPr> = {}): MergedPr => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/${REPO}/pull/${number}`,
  mergedAt: `2026-11-${String(10 + (number % 9)).padStart(2, "0")}T12:00:00Z`,
  body: "🤖 rafa loop — run abc",
  headRefName: `rafa/${number}-thing`,
  reviews: 1,
  closes: [],
  ...extra,
});

const ev = (kind: SpeedEvent["kind"], at: string, ticket: string, extra: Partial<SpeedEvent> = {}): SpeedEvent => ({
  v: 1, at, kind, loop: "rafa", project: "loggd", ticket, session: null, run: "r1", iteration: null, ...extra,
});

const input = (pulls: MergedPr[], extra: Partial<SuggestionInput> = {}): SuggestionInput => ({
  repo: REPO,
  pulls: { ok: true, value: pulls },
  held: [],
  loops: ["rafa", "ralph"],
  doctors: ["medi"],
  blocked: { ok: true, value: [] },
  parked: { ok: true, value: [] },
  journal: { ok: true, value: [] },
  speed: { ok: true, value: [] },
  projectId: null,
  ...extra,
});

const reasonsOf = (s: Suggestion | undefined): string[] => (s?.reasons ?? []).map((r) => `${r.signal}: ${r.text}`);
const find = (list: Suggestion[], n: number): Suggestion | undefined => list.find((s) => s.pr === n);

describe("rankSuggestions", () => {
  it("states every signal with its reason", () => {
    const pulls = [
      pr(1, { closes: [601] }),
      pr(2, { closes: [602] }),
      pr(3, { title: "Add a thing" }),
      pr(4, { title: 'Revert "Add a thing"' }),
      pr(5, { reviews: 5 }),
      pr(6),
      pr(7, { closes: [607] }),
      pr(8, { closes: [608], body: "by hand", headRefName: "felipe/fix" }),
      pr(9, { closes: [609] }),
    ];
    const speed = [
      ev("claimed", "2026-11-01T00:00:00Z", "#607"),
      ev("handed-off", "2026-11-03T00:00:00Z", "#607", { pr: `https://github.com/${REPO}/pull/7` }),
      ev("claimed", "2026-11-01T00:00:00Z", "608"),
      ev("claimed", "2026-11-01T00:00:00Z", "609"),
      ev("blocked", "2026-11-01T01:00:00Z", "609"),
    ];
    const { suggestions, missing } = rankSuggestions(
      input(pulls, {
        blocked: { ok: true, value: [{ ticket: 601, loop: "rafa" }] },
        parked: { ok: true, value: [602] },
        journal: { ok: true, value: [{ name: "a.md", body: "Loop: **Medi**. Fixed CI on PR #6." }] },
        speed: { ok: true, value: speed },
      }),
    );
    expect(missing).toEqual([]);
    expect(reasonsOf(find(suggestions, 1))).toContainEqual("blocked: blocked by rafa on #601");
    expect(reasonsOf(find(suggestions, 2))).toContainEqual("parked: #602 parked now");
    expect(reasonsOf(find(suggestions, 3))).toContainEqual("reverted: reverted by #4");
    expect(reasonsOf(find(suggestions, 5))).toContainEqual("reviewRounds: 5 review rounds");
    expect(reasonsOf(find(suggestions, 6))).toContainEqual("doctor: a doctor worked on it by Medi");
    expect(reasonsOf(find(suggestions, 7))).toContainEqual("slow: 48h from claim to hand-off");
    expect(reasonsOf(find(suggestions, 8)).join("\n")).toContain("finishedByPerson: finished by a person after rafa claimed it");
    expect(reasonsOf(find(suggestions, 9)).join("\n")).toContain("the speed ledger records #609 blocked");
    expect(find(suggestions, 4)).toBeUndefined();
  });

  it("ranks a struggled PR above a calm one and drops a PR with no signal", () => {
    const pulls = [pr(10, { reviews: 3 }), pr(11, { closes: [611], reviews: 4 }), pr(12)];
    const { suggestions } = rankSuggestions(
      input(pulls, { blocked: { ok: true, value: [{ ticket: 611, loop: "ralph" }] }, parked: { ok: true, value: [611] } }),
    );
    expect(suggestions.map((s) => s.pr)).toEqual([11, 10]);
  });

  it("breaks ties by merge time, then PR number, and honours the limit", () => {
    const pulls = [
      pr(20, { reviews: 3, mergedAt: "2026-11-01T00:00:00Z" }),
      pr(21, { reviews: 3, mergedAt: "2026-11-02T00:00:00Z" }),
      pr(22, { reviews: 3, mergedAt: "2026-11-02T00:00:00Z" }),
    ];
    expect(rankSuggestions(input(pulls)).suggestions.map((s) => s.pr)).toEqual([22, 21, 20]);
    expect(rankSuggestions(input(pulls, { limit: 2 })).suggestions.map((s) => s.pr)).toEqual([22, 21]);
  });

  it("never suggests a PR a case holds, active or retired, whatever the repo's case", () => {
    const pulls = [pr(30, { reviews: 5 }), pr(31, { reviews: 5 }), pr(32, { reviews: 5 })];
    const { suggestions } = rankSuggestions(
      input(pulls, { held: [{ repo: "FelipeAros/Loggd", prs: [30] }, { repo: REPO, prs: [31] }, { repo: "other/repo", prs: [32] }] }),
    );
    expect(suggestions.map((s) => s.pr)).toEqual([32]);
  });

  it("matches a journal mention of #12 but not #123", () => {
    const pulls = [pr(12), pr(123)];
    const { suggestions } = rankSuggestions(
      input(pulls, { journal: { ok: true, value: [{ name: "b.md", body: "**Case:** ci-red\nLooked at #123." }] } }),
    );
    expect(suggestions.map((s) => s.pr)).toEqual([123]);
    expect(reasonsOf(suggestions[0])).toContainEqual("doctor: a doctor worked on it");
  });

  it("reads a doctor's entry signed the way the doctors sign theirs", () => {
    for (const body of ["# CI red\n- **Loop:** medi\nRe-ran PR #41.", "# CI red\n- Loop: medi\nRe-ran PR #41."]) {
      const { suggestions } = rankSuggestions(input([pr(41)], { journal: { ok: true, value: [{ name: "d.md", body }] } }));
      expect(reasonsOf(suggestions[0])).toContainEqual("doctor: a doctor worked on it by medi");
    }
  });

  it("ignores a journal mention by a loop that is not a doctor", () => {
    const { suggestions } = rankSuggestions(input([pr(40)], { journal: { ok: true, value: [{ name: "c.md", body: "Loop: **rafa**. PR #40." }] } }));
    expect(suggestions).toEqual([]);
  });

  it("detects a revert by its body line, with and without the repo", () => {
    const pulls = [pr(50), pr(51), pr(52, { body: `Reverts ${REPO}#50` }), pr(53, { body: "Undo.\nReverts #51" }), pr(54), pr(55, { body: "Reverts other/repo#54" })];
    const { suggestions } = rankSuggestions(input(pulls));
    expect(reasonsOf(find(suggestions, 50))).toContainEqual("reverted: reverted by #52");
    expect(reasonsOf(find(suggestions, 51))).toContainEqual("reverted: reverted by #53");
    expect(find(suggestions, 54)).toBeUndefined();
  });

  it("prefers the Reverts body line, and by title marks only PRs merged before the revert", () => {
    const pulls = [
      pr(80, { title: "Add a thing", mergedAt: "2026-11-01T00:00:00Z" }),
      pr(81, { title: 'Revert "Add a thing"', mergedAt: "2026-11-02T00:00:00Z" }),
      pr(82, { title: "Add a thing", mergedAt: "2026-11-03T00:00:00Z" }),
      pr(83, { title: "Other", mergedAt: "2026-11-01T00:00:00Z" }),
      pr(84, { title: 'Revert "Other"', body: "Reverts #80", mergedAt: "2026-11-04T00:00:00Z" }),
    ];
    const { suggestions } = rankSuggestions(input(pulls));
    expect(reasonsOf(find(suggestions, 80))).toEqual(["reverted: reverted by #81, #84"]);
    expect(find(suggestions, 82)).toBeUndefined();
    expect(find(suggestions, 83)).toBeUndefined();
  });

  it("rounds each score to one decimal", () => {
    const speed = [ev("claimed", "2026-11-01T00:00:00Z", "#690"), ev("handed-off", "2026-11-02T01:07:00Z", "#690")];
    const { suggestions } = rankSuggestions(input([pr(90, { closes: [690] })], { speed: { ok: true, value: speed } }));
    expect(suggestions.map((s) => s.reasons.map((r) => r.signal))).toEqual([["slow"]]);
    const score = suggestions[0]!.score;
    expect(Math.round(score * 10) / 10).toBe(score);
  });

  it("skips finished-by-a-person without a roster", () => {
    const pulls = [pr(91, { closes: [691], body: "by hand", headRefName: "felipe/fix" })];
    const speed = [ev("claimed", "2026-11-01T00:00:00Z", "691")];
    expect(rankSuggestions(input(pulls, { speed: { ok: true, value: speed } })).suggestions.map((s) => s.pr)).toEqual([91]);
    expect(rankSuggestions(input(pulls, { loops: [], speed: { ok: true, value: speed } })).suggestions).toEqual([]);
  });

  it("only uses speed events of the named project", () => {
    const speed = [
      ev("claimed", "2026-11-01T00:00:00Z", "#692", { project: "other" }),
      ev("handed-off", "2026-11-05T00:00:00Z", "#692", { project: "other", pr: `https://github.com/${REPO}/pull/92` }),
    ];
    const pulls = [pr(92)];
    expect(rankSuggestions(input(pulls, { speed: { ok: true, value: speed } })).suggestions.map((s) => s.pr)).toEqual([92]);
    expect(rankSuggestions(input(pulls, { projectId: "loggd", speed: { ok: true, value: speed } })).suggestions).toEqual([]);
    expect(rankSuggestions(input(pulls, { projectId: "other", speed: { ok: true, value: speed } })).suggestions.map((s) => s.pr)).toEqual([92]);
  });

  it("ignores closing references when they are not this tracker's tickets", () => {
    const pulls = [pr(93, { closes: [693] })];
    const blocked = { ok: true as const, value: [{ ticket: 693, loop: "rafa" }] };
    expect(reasonsOf(find(rankSuggestions(input(pulls, { blocked })).suggestions, 93))).toEqual(["blocked: blocked by rafa on #693"]);
    const off = rankSuggestions(input(pulls, { blocked, closesAreTickets: false }));
    expect(off.suggestions).toEqual([]);
  });

  it("degrades an unreadable source: the ranking returns and missing names it", () => {
    const pulls = [pr(60, { reviews: 4, closes: [660] })];
    const { suggestions, missing } = rankSuggestions(input(pulls, { blocked: { ok: false, why: "tracker down" } }));
    expect(suggestions.map((s) => s.pr)).toEqual([60]);
    expect(missing).toEqual([{ source: "tracker", why: "tracker down" }]);
  });

  it("returns nothing when the merged PRs cannot be read", () => {
    const { suggestions, missing } = rankSuggestions(input([], { pulls: { ok: false, why: "gh failed" } }));
    expect(suggestions).toEqual([]);
    expect(missing).toContainEqual({ source: "pulls", why: "gh failed" });
  });
});

describe("reviewsByOthers", () => {
  it("does not count the author's own reviews, whatever the case, and counts one with no author", () => {
    const reviews = [{ author: { login: "Rafa-Bot" } }, { author: { login: "codex" } }, { author: null }, {}];
    expect(reviewsByOthers({ author: { login: "rafa-bot" }, reviews })).toBe(3);
    expect(reviewsByOthers({ author: null, reviews })).toBe(4);
    expect(reviewsByOthers({ author: { login: "x" }, reviews: null })).toBe(0);
  });
});

describe("gatherSignals", () => {
  it("reads blocked tickets per loop, open and closed", async () => {
    const tracker = createFakeTracker({
      issues: [
        { number: 612, labels: ["rafa-blocked"], state: "closed" },
        { number: 613, labels: ["ralph-blocked"] },
        { number: 614, labels: ["rafa-wip"] },
      ],
    });
    const got = await gatherSignals({ tracker, loops: ["rafa", "ralph"], parked: () => [612], journal: () => [], speed: () => [] });
    expect(got.blocked).toEqual({ ok: true, value: [{ ticket: 612, loop: "rafa" }, { ticket: 613, loop: "ralph" }] });
    expect(got.parked).toEqual({ ok: true, value: [612] });
  });

  it("wraps each source on its own, and a throwing tracker still lets the ranking return", async () => {
    const tracker = createFakeTracker({ issues: [{ number: 670, labels: ["rafa-blocked"] }] });
    tracker.failNext("withLabel", new Error("rate limited"));
    const got = await gatherSignals({
      tracker,
      loops: ["rafa"],
      parked: () => [670],
      journal: () => {
        throw new Error("no journal");
      },
      speed: () => [],
    });
    expect(got.blocked).toEqual({ ok: false, why: "rate limited" });
    expect(got.journal).toEqual({ ok: false, why: "no journal" });
    expect(got.parked).toEqual({ ok: true, value: [670] });
    const { suggestions, missing } = rankSuggestions({ ...input([pr(70, { closes: [670] })]), ...got });
    expect(suggestions.map((s) => s.pr)).toEqual([70]);
    expect(reasonsOf(suggestions[0])).toContainEqual("parked: #670 parked now");
    expect(missing.map((m) => m.source)).toEqual(["tracker", "journal"]);
  });

  it("names a tracker that does not answer by the deadline and still reads the rest", async () => {
    const stalled = { withLabel: () => new Promise(() => undefined) } as unknown as Tracker;
    const got = await gatherSignals({ tracker: stalled, loops: ["rafa"], parked: () => [1], journal: () => [], speed: () => [], trackerDeadlineMs: 20 });
    expect(got.blocked).toEqual({ ok: false, why: "the tracker did not answer within 20 ms" });
    expect(got.parked).toEqual({ ok: true, value: [1] });
  });

  it("reads blocked as failed with the given why when there is no tracker", async () => {
    const got = await gatherSignals({ tracker: null, trackerWhy: "no config", loops: ["rafa"], parked: () => [], journal: () => [], speed: () => [] });
    expect(got.blocked).toEqual({ ok: false, why: "no config" });
  });
});
