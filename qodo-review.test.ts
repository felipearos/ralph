import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import {
  countsOf,
  exitOf,
  fallbackSeen,
  findingsOf,
  finishedReviewOf,
  judge,
  parseArgs,
  parseComments,
  parseHead,
  reviewedCommits,
  run,
  seenStore,
  RETRIGGER,
  type HeadSeen,
  type IssueComment,
  type Io,
  type PrState,
} from "./qodo-review";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const BOT = "qodo-code-review[bot]";
const SELF = "acme-bot";
const marker = (sha: string) => `<!-- https://github.com/example-org/acme/commit/${sha} -->`;

// The shapes Qodo posted on this repository's PRs, trimmed to what is read.
// The category icons are escapes: the source files of this repo carry no emoji.
const BUG = "\u{1F41E}";
const clean = (sha: string) =>
  `<h3>Code Review by Qodo</h3>\n<code>${BUG} Bugs (0)</code>  <code>\u{1F4D8} Rule violations (0)</code>  <code>\u{1F4CE} Requirement gaps (0)</code>\n` +
  `<h3>Great, no issues found!</h3>\n${marker(sha)}`;
const finding = (n: number, title: string, type = `${BUG} Bug`, id = `f${n}`) =>
  `<details>\n<summary>  ${n}.  ${title} <code>${type}</code></summary>\n\n<br/>\n\n> <details>\n><summary>Description</summary>\n>text\n></details>\n\n` +
  `[Dismiss ↗](https://app.qodo.ai/findings/${id}?action=dismiss&origin=git) | [View ↗](https://app.qodo.ai/findings/${id})\n\n</details>\n`;
const withFindings = (sha: string) =>
  `<h3>Code Review by Qodo</h3>\n\n<br/>\n\n<img src="https://img.shields.io/badge/High-634FD1?style=flat-square" height="20px" alt="Action required">\n\n` +
  finding(1, "Delayed pushes fail the review gate") +
  `\n<details><summary><ins><strong>View medium (2)</strong></ins></summary><br/>\n<img src="https://img.shields.io/badge/Medium-634FD1?style=flat-square" alt="Remediation recommended">\n` +
  finding(2, "Busy pull requests lose their review") +
  finding(3, "<s>Already handled</s> ✓ Resolved", "\u{1F4D8} Rule violation") +
  `</details>\n<details><summary>View low (1)</summary>\n<img src="https://img.shields.io/badge/Low-634FD1?style=flat-square" alt="Advisory">\n` +
  finding(4, "A naming nit", "\u{1F4CE} Requirement gap") +
  `</details>\n${marker(sha)}`;
const failed =
  "<h3>Code Review by Qodo</h3>\n<h3>Sorry, something went wrong</h3>\nWe weren't able to complete the code review on our side. " +
  "Please try again manually by commenting <code>/agentic_review</code> on this PR.";
// The describe comment carries the commit too; it is not a review.
const prSummary = `<h3>PR Summary by Qodo</h3>\nCheck the name list\n<sub>Assessed commit</sub>\n${marker(HEAD)}`;

const at = (minute: number) => new Date(Date.UTC(2026, 10, 21, 12, minute)).toISOString();
const comment = (author: string, body: string, minute = 1): IssueComment => ({
  author,
  body,
  createdAt: at(minute),
  url: `https://github.com/example-org/acme/pull/7#issuecomment-${minute}`,
});
const state = (comments: IssueComment[]): PrState => ({ head: HEAD, headAt: at(0), comments });
const seenAt = (minute: number, askedAt?: string): HeadSeen => ({ firstSeen: at(minute), ...(askedAt ? { askedAt } : {}) });
const minute = (m: number) => new Date(at(m));

describe("reading a summary", () => {
  it("reads a clean review's counts and every reviewed commit", () => {
    expect(countsOf(clean(HEAD))).toEqual({ bugs: 0, rules: 0, requirements: 0 });
    expect(reviewedCommits(`${clean(OLD)}\n${clean(HEAD)}`)).toEqual([OLD, HEAD]);
  });

  it("reads each finding under the severity badge before it", () => {
    expect(findingsOf(withFindings(HEAD))).toEqual([
      { number: 1, title: "Delayed pushes fail the review gate", type: "Bug", severity: "High", resolved: false, view: "https://app.qodo.ai/findings/f1" },
      { number: 2, title: "Busy pull requests lose their review", type: "Bug", severity: "Medium", resolved: false, view: "https://app.qodo.ai/findings/f2" },
      { number: 3, title: "Already handled ✓ Resolved", type: "Rule violation", severity: "Medium", resolved: true, view: "https://app.qodo.ai/findings/f3" },
      { number: 4, title: "A naming nit", type: "Requirement gap", severity: "Low", resolved: false, view: "https://app.qodo.ai/findings/f4" },
    ]);
  });

  it("reads Qodo's resolution marks, not the words, as resolved", () => {
    const body = `<img src="https://img.shields.io/badge/Medium-1?x" alt="Remediation recommended">\n` + finding(1, "Outdated cache entries are served");
    expect(findingsOf(body)[0]).toMatchObject({ title: "Outdated cache entries are served", resolved: false });
  });

  it("calls a review finished only with the head, a finished body, and no failure", () => {
    expect(finishedReviewOf(clean(HEAD), HEAD)).toBe(true);
    expect(finishedReviewOf(withFindings(HEAD), HEAD)).toBe(true);
    expect(finishedReviewOf(clean(OLD), HEAD)).toBe(false);
    // The head's URL alone is not a finished review (PR #26 review, finding 2).
    expect(finishedReviewOf(`<h3>Code Review by Qodo</h3>\nReviewing…\n${marker(HEAD)}`, HEAD)).toBe(false);
    expect(finishedReviewOf(`${failed}\n${marker(HEAD)}`, HEAD)).toBe(false);
  });
});

describe("judge", () => {
  it("passes a finished clean review of the head", () => {
    const verdict = judge(state([comment(BOT, prSummary), comment(BOT, clean(HEAD))]), seenAt(1), minute(3));
    expect(verdict).toMatchObject({ kind: "reviewed", counts: { bugs: 0, rules: 0, requirements: 0 }, findings: [] });
    expect(exitOf(verdict)).toBe(0);
  });

  it("lists a review's open findings as exit 1, and a resolved-only review as 0", () => {
    const verdict = judge(state([comment(BOT, withFindings(HEAD))]), seenAt(1), minute(3));
    expect(verdict.kind).toBe("reviewed");
    expect(exitOf(verdict)).toBe(1);
    expect(exitOf({ kind: "reviewed", counts: null, findings: [{ ...findingsOf(withFindings(HEAD))[2]! }], url: "" })).toBe(0);
  });

  it("never takes the PR summary (describe) comment for a review", () => {
    expect(judge(state([comment(BOT, prSummary)]), seenAt(1), minute(2))).toMatchObject({ kind: "pending", retrigger: false });
  });

  it("waits, without asking, when Qodo has not commented yet", () => {
    expect(judge(state([]), seenAt(1), minute(2))).toMatchObject({ kind: "pending", retrigger: false });
  });

  it("asks again once when Qodo's run failed, and not twice for the same head", () => {
    expect(judge(state([comment(BOT, failed)]), seenAt(1), minute(2))).toMatchObject({ kind: "pending", retrigger: true });
    expect(judge(state([comment(BOT, failed)]), seenAt(1, at(2)), minute(4))).toMatchObject({ kind: "pending", retrigger: false });
  });

  it("leaves a stale review to Qodo's own push review for a grace period, then asks", () => {
    const stale = state([comment(BOT, clean(OLD))]);
    expect(judge(stale, seenAt(1), minute(3))).toMatchObject({ kind: "pending", retrigger: false });
    expect(judge(stale, seenAt(1), minute(7))).toMatchObject({ kind: "pending", retrigger: true });
  });

  it("ignores a look-alike comment from someone who is not Qodo", () => {
    expect(judge(state([comment("mallory", clean(HEAD))]), seenAt(1), minute(2)).kind).toBe("pending");
  });

  it("reads only the newest review when Qodo posted more than one", () => {
    expect(judge(state([comment(BOT, clean(HEAD), 1), comment(BOT, failed, 2)]), seenAt(1), minute(3)).kind).toBe("pending");
  });

  it("counts the budget from when the head was first seen, not from its commit date", () => {
    // Committed at minute 0, pushed and first seen at minute 50 (PR #26 review, finding 1).
    expect(judge(state([]), seenAt(50), minute(52)).kind).toBe("pending");
    expect(judge(state([]), seenAt(50), minute(81))).toMatchObject({ kind: "gave-up" });
    // Without a record the commit date is the fallback.
    expect(judge(state([]), null, minute(31))).toMatchObject({ kind: "gave-up" });
  });

  it("a review of the head still passes after the budget", () => {
    expect(judge(state([comment(BOT, clean(HEAD))]), seenAt(1), minute(59)).kind).toBe("reviewed");
  });
});

describe("parsing gh", () => {
  it("reads the flags and caps --wait under the Bash ceiling", () => {
    expect(parseArgs(["12", "--repo", "example-org/acme", "--wait", "900", "--json"])).toEqual({
      pr: 12,
      repo: "example-org/acme",
      json: true,
      waitSeconds: 480,
    });
    expect(typeof parseArgs([])).toBe("string");
    expect(typeof parseArgs(["12", "--wait", "soon"])).toBe("string");
    expect(typeof parseArgs(["12", "--repo", "acme"])).toBe("string");
  });

  it("reads every page of comments, one per line", () => {
    const lines = Array.from({ length: 150 }, (_, i) => JSON.stringify({ author: i === 0 ? BOT : SELF, body: `c${i}`, createdAt: at(1), url: "u" }));
    const comments = parseComments(`${lines.join("\n")}\n`);
    expect(comments).toHaveLength(150);
    expect(comments[0]).toEqual({ author: BOT, body: "c0", createdAt: at(1), url: "u" });
  });

  it("reads the head, and throws on an answer without one", () => {
    expect(parseHead(JSON.stringify({ headRefOid: HEAD, commits: [{ committedDate: at(0) }, { committedDate: at(3) }] }))).toEqual({ head: HEAD, headAt: at(3) });
    expect(() => parseHead("{}")).toThrow();
  });
});

describe("the seen store", () => {
  it("round-trips, and reads a missing or malformed file as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "qodo-review-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "ralph", "qodo-review.json");
    const store = seenStore(path);
    expect(store.get("k")).toBeNull();
    store.set("k", seenAt(1));
    expect(store.get("k")).toEqual(seenAt(1));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ k: seenAt(1) });
    writeFileSync(path, "not json");
    expect(store.get("k")).toBeNull();
    expect(seenStore(null).get("k")).toBeNull();
  });
});

describe("run", () => {
  function fakeIo(states: PrState[], startMinute = 1) {
    let clock = Date.parse(at(startMinute));
    const log: string[] = [];
    const asked: number[] = [];
    const seen = new Map<string, HeadSeen>();
    let reads = 0;
    const io: Io = {
      repo: async () => "example-org/acme",
      read: async () => states[Math.min(reads++, states.length - 1)]!,
      retrigger: async (pr) => {
        asked.push(pr);
      },
      seen: { get: (key) => seen.get(key) ?? null, set: (key, value) => void seen.set(key, value) },
      sleep: async (seconds) => {
        clock += seconds * 1000;
      },
      now: () => new Date(clock),
      log: (line) => log.push(line),
    };
    return { io, log, asked, seen, reads: () => reads };
  }

  it("polls until the review lands, then exits 0", async () => {
    const fake = fakeIo([state([]), state([comment(BOT, prSummary)]), state([comment(BOT, clean(HEAD))])]);
    expect(await run({ pr: 7, repo: null, json: false, waitSeconds: 240 }, fake.io, {})).toBe(0);
    expect(fake.reads()).toBe(3);
    expect(fake.log.at(-1)).toContain("no open findings");
  });

  it("lists open findings and exits 1", async () => {
    const fake = fakeIo([state([comment(BOT, withFindings(HEAD))])]);
    expect(await run({ pr: 7, repo: null, json: false, waitSeconds: 0 }, fake.io, {})).toBe(1);
    expect(fake.log.at(-1)).toContain("1. [High] Bug — Delayed pushes fail the review gate");
    expect(fake.log.at(-1)).not.toContain("Already handled");
  });

  it("answers pending (3) once its own wait is spent", async () => {
    const fake = fakeIo([state([])]);
    expect(await run({ pr: 7, repo: null, json: false, waitSeconds: 60 }, fake.io, {})).toBe(3);
    expect(fake.reads()).toBe(3);
  });

  it("asks Qodo again once on a failed run, across calls, and exits 4 past the budget", async () => {
    const fake = fakeIo([state([comment(BOT, failed)])], 1);
    expect(await run({ pr: 7, repo: null, json: false, waitSeconds: 60 }, fake.io, {})).toBe(3);
    expect(await run({ pr: 7, repo: null, json: false, waitSeconds: 60 }, fake.io, {})).toBe(3);
    expect(fake.asked).toEqual([7]);
    expect(await run({ pr: 7, repo: null, json: true, waitSeconds: 0 }, fake.io, { RALPH_QODO_REVIEW_MINUTES: "1" })).toBe(4);
    expect(JSON.parse(fake.log.at(-1)!)).toMatchObject({ pr: 7, kind: "gave-up" });
  });

  it("a malformed budget knob falls back to the default, never to no wait", async () => {
    const fake = fakeIo([state([])], 20);
    expect(await run({ pr: 7, repo: null, json: false, waitSeconds: 0 }, fake.io, { RALPH_QODO_REVIEW_MINUTES: "soon" })).toBe(3);
  });

  it(`records ${RETRIGGER} only once posted, so a failed post is asked again`, async () => {
    const fake = fakeIo([state([comment(BOT, failed)])]);
    const post = fake.io.retrigger;
    fake.io.retrigger = async () => {
      throw new Error("gh pr failed");
    };
    await expect(run({ pr: 7, repo: null, json: false, waitSeconds: 0 }, fake.io, {})).rejects.toThrow();
    expect([...fake.seen.values()][0]?.askedAt).toBeUndefined();
    fake.io.retrigger = post;
    expect(await run({ pr: 7, repo: null, json: false, waitSeconds: 0 }, fake.io, {})).toBe(3);
    expect(fake.asked).toEqual([7]);
  });

  it("prints the finding counts in text mode", async () => {
    const fake = fakeIo([state([comment(BOT, clean(HEAD))])]);
    await run({ pr: 7, repo: null, json: false, waitSeconds: 0 }, fake.io, {});
    expect(fake.log.at(-1)).toContain("counts: 0 bugs, 0 rule violations, 0 requirement gaps");
    const withF = fakeIo([state([comment(BOT, withFindings(HEAD))])]);
    await run({ pr: 7, repo: null, json: false, waitSeconds: 0 }, withF.io, {});
    expect(withF.log.at(-1)).toContain("counts: 2 bugs, 1 rule violations, 1 requirement gaps (from the findings)");
  });

  it("with a store that keeps nothing, neither re-asks every poll nor restarts the budget", async () => {
    let posted: IssueComment[] = [];
    const fake = fakeIo([state([comment(BOT, failed)])], 5);
    fake.io.seen = { get: () => null, set: () => {} };
    fake.io.read = async () => state([comment(BOT, failed), ...posted]);
    fake.io.retrigger = async (pr) => {
      fake.asked.push(pr);
      posted = [{ ...comment(SELF, RETRIGGER), createdAt: fake.io.now().toISOString() }];
    };
    expect(await run({ pr: 7, repo: null, json: false, waitSeconds: 120 }, fake.io, {})).toBe(3);
    expect(fake.asked).toEqual([7]);
    // The budget falls back to the commit date (minute 0), so it still ends.
    expect(fallbackSeen(state([]))).toEqual({ firstSeen: at(0) });
    expect(await run({ pr: 7, repo: null, json: false, waitSeconds: 0 }, fake.io, { RALPH_QODO_REVIEW_MINUTES: "3" })).toBe(4);
  });
});
