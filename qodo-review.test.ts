import { describe, expect, it } from "vitest";

import {
  countsOf,
  judge,
  parseArgs,
  parseState,
  reviewedCommits,
  run,
  RETRIGGER,
  type IssueComment,
  type Io,
  type PrState,
} from "./qodo-review";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const BOT = "qodo-code-review[bot]";
const SELF = "acme-bot";

// The shapes Qodo posted on this repository's PRs, trimmed to what is read.
// The category icons are escapes: the source files of this repo carry no emoji.
const BUG = "\u{1F41E}";
const RULE = "\u{1F4D8}";
const GAP = "\u{1F4CE}";
const reviewed = (sha: string, bugs = 0) =>
  `<h3>Code Review by Qodo</h3>\n<code>${BUG} Bugs (${bugs})</code>  <code>${RULE} Rule violations (1)</code>  <code>${GAP} Requirement gaps (2)</code>\n` +
  `<!-- https://github.com/example-org/acme/commit/${sha} -->`;
const failed =
  "<h3>Code Review by Qodo</h3>\n<h3>Sorry, something went wrong</h3>\nWe weren't able to complete the code review on our side. " +
  "Please try again manually by commenting <code>/agentic_review</code> on this PR.";
const summaryOnly = "<h3>PR Summary by Qodo</h3>\nCheck the name list before installing the pre-push hook";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 21, 12, minute)).toISOString();
const comment = (author: string, body: string, minute = 1): IssueComment => ({
  author,
  body,
  createdAt: at(minute),
  url: `https://github.com/example-org/acme/pull/7#issuecomment-${minute}`,
});
const state = (comments: IssueComment[]): PrState => ({ head: HEAD, headAt: at(0), self: SELF, comments });
const minute = (m: number) => new Date(at(m));

describe("countsOf / reviewedCommits", () => {
  it("reads the three counts and every reviewed commit", () => {
    expect(countsOf(reviewed(HEAD, 3))).toEqual({ bugs: 3, rules: 1, requirements: 2 });
    expect(reviewedCommits(`${reviewed(OLD)}\n${reviewed(HEAD)}`)).toEqual([OLD, HEAD]);
  });

  it("has no counts on a failed run", () => {
    expect(countsOf(failed)).toBeNull();
    expect(reviewedCommits(failed)).toEqual([]);
  });
});

describe("judge", () => {
  it("passes a finished review of the head, with its counts", () => {
    const verdict = judge(state([comment(BOT, summaryOnly), comment(BOT, reviewed(HEAD, 1))]), minute(3));
    expect(verdict).toMatchObject({ kind: "reviewed", counts: { bugs: 1, rules: 1, requirements: 2 } });
  });

  it("waits, without asking, when Qodo has not commented yet", () => {
    expect(judge(state([]), minute(2))).toMatchObject({ kind: "pending", retrigger: false });
  });

  it("waits while only the PR summary is there (the review is still running)", () => {
    expect(judge(state([comment(BOT, summaryOnly)]), minute(2))).toMatchObject({ kind: "pending", retrigger: false });
  });

  it("asks again once when Qodo's run failed", () => {
    expect(judge(state([comment(BOT, failed)]), minute(2))).toMatchObject({ kind: "pending", retrigger: true });
  });

  it("does not ask twice for the same head", () => {
    const asked = [comment(BOT, failed), comment(SELF, RETRIGGER, 2)];
    expect(judge(state(asked), minute(4))).toMatchObject({ kind: "pending", retrigger: false });
  });

  it("asks again for a new head, even if it asked for an older one", () => {
    // This ask predates the head's commit, so it was for an earlier head.
    const earlier = { ...comment(SELF, RETRIGGER), createdAt: new Date(Date.parse(at(0)) - 60_000).toISOString() };
    expect(judge(state([comment(BOT, failed), earlier]), minute(2))).toMatchObject({ retrigger: true });
  });

  it("leaves a stale review to Qodo's own push review for a grace period, then asks", () => {
    const stale = [comment(BOT, reviewed(OLD))];
    expect(judge(state(stale), minute(2))).toMatchObject({ kind: "pending", retrigger: false });
    expect(judge(state(stale), minute(6))).toMatchObject({ kind: "pending", retrigger: true });
  });

  it("ignores a look-alike comment from someone who is not Qodo", () => {
    expect(judge(state([comment("mallory", reviewed(HEAD))]), minute(2)).kind).toBe("pending");
  });

  it("reads only the newest summary when Qodo posted more than one", () => {
    const comments = [comment(BOT, reviewed(HEAD), 1), comment(BOT, failed, 2)];
    expect(judge(state(comments), minute(3)).kind).toBe("pending");
  });

  it("gives up past the budget instead of waiting forever", () => {
    expect(judge(state([comment(BOT, failed)]), minute(31))).toMatchObject({ kind: "gave-up" });
    expect(judge(state([]), minute(11), 10)).toMatchObject({ kind: "gave-up" });
  });

  it("a review of the head still passes after the budget", () => {
    expect(judge(state([comment(BOT, reviewed(HEAD))]), minute(59)).kind).toBe("reviewed");
  });
});

describe("parseArgs", () => {
  it("reads the flags and caps --wait under the Bash ceiling", () => {
    expect(parseArgs(["12", "--repo", "example-org/acme", "--wait", "900", "--json"])).toEqual({
      pr: 12,
      repo: "example-org/acme",
      json: true,
      waitSeconds: 540,
    });
  });

  it("refuses what it cannot read", () => {
    expect(typeof parseArgs([])).toBe("string");
    expect(typeof parseArgs(["12", "--wait", "soon"])).toBe("string");
    expect(typeof parseArgs(["12", "--repo", "acme"])).toBe("string");
  });
});

describe("parseState", () => {
  it("narrows the GraphQL answer", () => {
    const raw = JSON.stringify({
      data: {
        viewer: { login: SELF },
        repository: {
          pullRequest: {
            headRefOid: HEAD,
            commits: { nodes: [{ commit: { committedDate: at(0) } }] },
            comments: { nodes: [{ author: null, body: "hi", createdAt: at(1), url: "u" }] },
          },
        },
      },
    });
    expect(parseState(raw)).toEqual({
      head: HEAD,
      headAt: at(0),
      self: SELF,
      comments: [{ author: null, body: "hi", createdAt: at(1), url: "u" }],
    });
  });

  it("throws on an answer without a pull request", () => {
    expect(() => parseState(JSON.stringify({ data: { viewer: { login: SELF }, repository: { pullRequest: null } } }))).toThrow();
  });
});

describe("run", () => {
  function fakeIo(states: PrState[], startMinute = 1) {
    let clock = Date.parse(at(startMinute));
    const log: string[] = [];
    const asked: number[] = [];
    let reads = 0;
    const io: Io = {
      repo: async () => "example-org/acme",
      read: async () => states[Math.min(reads++, states.length - 1)]!,
      retrigger: async (pr) => {
        asked.push(pr);
        // As on GitHub: the ask is a comment the next read sees.
        for (const s of states) s.comments.push({ ...comment(SELF, RETRIGGER), createdAt: new Date(clock).toISOString() });
      },
      sleep: async (seconds) => {
        clock += seconds * 1000;
      },
      now: () => new Date(clock),
      log: (line) => log.push(line),
    };
    return { io, log, asked, reads: () => reads };
  }

  it("polls until the review lands, then exits 0", async () => {
    const fake = fakeIo([state([]), state([comment(BOT, summaryOnly)]), state([comment(BOT, reviewed(HEAD))])]);
    expect(await run({ pr: 7, repo: null, json: false, waitSeconds: 240 }, fake.io, {})).toBe(0);
    expect(fake.reads()).toBe(3);
    expect(fake.log.at(-1)).toContain("Qodo reviewed the head");
  });

  it("answers pending (3) once its own wait is spent", async () => {
    const fake = fakeIo([state([])]);
    expect(await run({ pr: 7, repo: null, json: false, waitSeconds: 60 }, fake.io, {})).toBe(3);
    expect(fake.reads()).toBe(3);
  });

  it("asks Qodo again on a failed run, and exits 4 past the budget", async () => {
    const fake = fakeIo([state([comment(BOT, failed)])], 29);
    expect(await run({ pr: 7, repo: null, json: true, waitSeconds: 240 }, fake.io, {})).toBe(4);
    expect(fake.asked).toEqual([7]);
    expect(JSON.parse(fake.log.at(-1)!)).toMatchObject({ pr: 7, kind: "gave-up" });
  });

  it("a malformed budget knob falls back to the default, never to no wait", async () => {
    const fake = fakeIo([state([])], 20);
    expect(await run({ pr: 7, repo: null, json: false, waitSeconds: 0 }, fake.io, { RALPH_QODO_REVIEW_MINUTES: "soon" })).toBe(3);
  });
});
