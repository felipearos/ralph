import { describe, expect, it } from "vitest";

import { summarizeReview } from "./trial-review";

const REVIEWER = "revision-claude";
const finding = (priority: "P1" | "P2" | "P3", title: string) => ({ path: "src/a.ts", line: 3, priority, title, body: "why" });
const comment = (author: string, body: string) => ({ databaseId: 1, author, body, url: "", createdAt: "" });
const thread = (id: number, headSha: string, priority: string, title: string, replies: [string, string][] = []) => ({
  id,
  headSha,
  path: "src/a.ts",
  line: 3,
  isResolved: false,
  comments: [
    comment(REVIEWER, `![](https://img.shields.io/badge/${priority}-orange?style=flat) **${title}**\n\nbecause`),
    ...replies.map(([author, body]) => comment(author, body)),
  ],
});
const state = (heads: unknown[], reviewThreads: unknown[] = []) => ({
  version: 1,
  prs: [
    { number: 1, heads: [], reviewThreads: [] },
    { number: 2, heads, reviewThreads },
  ],
});

describe("summarizeReview", () => {
  it("counts a round per reviewed head and reads a fix reply (AC1)", () => {
    const review = summarizeReview(state(
      [
        { sha: "h1", seenAt: "", findingsCmd: "x", findings: [finding("P2", "Null deref")] },
        { sha: "h2", seenAt: "", findingsCmd: "x", findings: [] },
      ],
      [thread(5, "h1", "P2", "Null deref", [["ralph-trial", "Fixed in abc1234."]])],
    ), 5);
    expect(review.pr).toBe(2);
    expect(review.roundCount).toBe(2);
    expect(review.rounds).toEqual([
      { round: 1, head: "h1", findings: 1, priorities: { P1: 0, P2: 1, P3: 0, none: 0 } },
      { round: 2, head: "h2", findings: 0, priorities: { P1: 0, P2: 0, P3: 0, none: 0 } },
    ]);
    expect(review.heads.map((h) => h.status)).toEqual(["findings", "clean"]);
    expect(review.threads).toEqual([{
      id: 5, round: 1, head: "h1", priority: "P2", path: "src/a.ts", line: 3, title: "Null deref", answer: "fix", reply: "Fixed in abc1234.",
    }]);
    expect(review.answered).toEqual({ fix: 1, rebuttal: 0, unanswered: 0 });
    expect(review.capReached).toBe(false);
    expect(review.note).toBe("2 rounds; last head clean");
  });

  it("reports the cap and the head pushed after it (AC2)", () => {
    const review = summarizeReview(state([
      { sha: "h1", seenAt: "", findingsCmd: "x", findings: [finding("P1", "a")] },
      { sha: "h2", seenAt: "", findingsCmd: "x", findings: [finding("P3", "b")] },
      { sha: "h3", seenAt: "", findingsCmd: "x", findings: null, reviewSkipped: "round cap 2 reached" },
    ]), 2);
    expect(review.roundCount).toBe(2);
    expect(review.capReached).toBe(true);
    expect(review.cap).toBe(2);
    expect(review.cappedHeads).toEqual(["h3"]);
    expect(review.heads[2]).toEqual({ sha: "h3", status: "capped", reason: "round cap 2 reached" });
    expect(review.note).toBe("stopped at the round cap (2 rounds); 1 head pushed after it was not reviewed");
  });

  it("does not read the cap as reached when the last allowed round was clean", () => {
    const review = summarizeReview(state([
      { sha: "h1", seenAt: "", findingsCmd: "x", findings: [finding("P2", "a")] },
      { sha: "h2", seenAt: "", findingsCmd: "x", findings: [] },
    ]), 2);
    expect(review.roundCount).toBe(2);
    expect(review.capReached).toBe(false);
    expect(review.note).toBe("2 rounds; last head clean");
  });

  it("reads the cap as reached when the last allowed round still had findings, with no head pushed after it", () => {
    const review = summarizeReview(state([
      { sha: "h1", seenAt: "", findingsCmd: "x", findings: [finding("P2", "a")] },
      { sha: "h2", seenAt: "", findingsCmd: "x", findings: [finding("P3", "b")] },
    ]), 2);
    expect(review.capReached).toBe(true);
    expect(review.cappedHeads).toEqual([]);
    expect(review.note).toBe("stopped at the round cap (2 rounds)");
  });

  it("keeps an unavailable head out of the rounds, and never clean (AC3)", () => {
    const review = summarizeReview(state([
      { sha: "h1", seenAt: "", findingsCmd: "x", findings: null, reviewUnavailable: "local review unavailable: no workflow" },
    ]), 5);
    expect(review.heads).toEqual([{ sha: "h1", status: "unavailable", reason: "local review unavailable: no workflow" }]);
    expect(review.unreviewedHeads).toEqual(["h1"]);
    expect(review.roundCount).toBe(0);
    expect(review.threads).toEqual([]);
    expect(review.note).toBe("0 rounds; last head unavailable; 1 head unreviewed (review unavailable)");
  });

  it("reads any other reply as a rebuttal, the last reply winning, and the reviewer's own follow-up as none", () => {
    const review = summarizeReview(state(
      [{ sha: "h1", seenAt: "", findingsCmd: "x", findings: [finding("P2", "a"), finding("P3", "b"), finding("P1", "c")] }],
      [
        thread(1, "h1", "P2", "a", [["ralph-trial", "Fixed in abc1234"], ["ralph-trial", "No: the caller checks it first."]]),
        thread(2, "h1", "P3", "b", [[REVIEWER, "Still open."]]),
        thread(3, "h1", "P1", "c", [["ralph-trial", "Corregido en `DEADBEEF12`."]]),
      ],
    ), 5);
    expect(review.threads.map((t) => [t.answer, t.reply])).toEqual([
      ["rebuttal", "No: the caller checks it first."],
      ["unanswered", null],
      ["fix", "Corregido en `DEADBEEF12`."],
    ]);
    expect(review.answered).toEqual({ fix: 1, rebuttal: 1, unanswered: 1 });
  });

  it.each([
    ["null", null],
    ["a string", "nope"],
    ["no prs", {}],
    ["prs not an array", { prs: 3 }],
    ["junk prs", { prs: [null, 4, { number: 1, heads: "x", reviewThreads: [null, { comments: 5 }] }] }],
  ])("returns an empty summary for %s, without throwing", (_name, github) => {
    const review = summarizeReview(github, 5);
    expect(review.rounds).toEqual([]);
    expect(review.roundCount).toBe(0);
    expect(review.heads).toEqual([]);
    expect(review.capReached).toBe(false);
    expect(review.answered.fix + review.answered.rebuttal).toBe(0);
  });
});
