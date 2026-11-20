import { describe, expect, it } from "vitest";

import { openThreads, parseArgs, parsePage, priorityOf, render, titleOf, type ReviewThread } from "./review-threads";

const CODEX = "chatgpt-codex-connector";
const SELF = "felipearosr";

const body = (priority: string, title: string): string =>
  `**<sub><sub>![${priority} Badge](https://img.shields.io/badge/${priority}-orange)</sub></sub>  ${title}**\n\nWhy it matters.\n\nUseful? React with 👍 / 👎.`;

const thread = (over: Partial<ReviewThread> & { latestAuthor?: string | null; firstAuthor?: string | null } = {}): ReviewThread => {
  const { latestAuthor, firstAuthor, ...rest } = over;
  const first = { author: firstAuthor === undefined ? CODEX : firstAuthor, body: body("P1", "Keep the gate"), url: "https://x/1", databaseId: 11 };
  return {
    isResolved: false,
    isOutdated: false,
    path: "src/a.ts",
    line: 7,
    comments: 1,
    first,
    latest: { ...first, author: latestAuthor === undefined ? first.author : latestAuthor },
    ...rest,
  };
};

describe("openThreads", () => {
  it("lists a reviewer's finding nobody has answered", () => {
    expect(openThreads([thread()], SELF)).toEqual([
      { id: 11, priority: "P1", title: "Keep the gate", path: "src/a.ts", line: 7, outdated: false, reviewer: CODEX, url: "https://x/1" },
    ]);
  });

  it("drops a resolved thread, and one the loop has replied to last", () => {
    expect(openThreads([thread({ isResolved: true })], SELF)).toEqual([]);
    expect(openThreads([thread({ comments: 2, latestAuthor: SELF })], SELF)).toEqual([]);
  });

  it("reopens a thread when the reviewer speaks again after the reply", () => {
    expect(openThreads([thread({ comments: 3, latestAuthor: CODEX })], SELF)).toHaveLength(1);
  });

  it("keeps the operator's own note open until somebody replies to it", () => {
    // The loops post as the operator's account, so authorship alone cannot
    // tell the operator's note from the loop's reply.
    expect(openThreads([thread({ firstAuthor: SELF })], SELF)).toHaveLength(1);
    expect(openThreads([thread({ firstAuthor: SELF, comments: 2 })], SELF)).toEqual([]);
  });

  it("still counts an outdated thread, and says so", () => {
    expect(openThreads([thread({ isOutdated: true })], SELF)[0]!.outdated).toBe(true);
  });
});

describe("the finding's headline", () => {
  it("reads Codex's badge and bold title", () => {
    expect(priorityOf(body("P2", "x"))).toBe("P2");
    expect(titleOf(body("P2", "Include every rendered dependency in the ETag"))).toBe(
      "Include every rendered dependency in the ETag",
    );
  });

  it("reads the Claude review's badge, whose alt text arrives empty", () => {
    // Verbatim from example-org/acme-backoffice#178, 2026-10-28.
    const claude = "![](https://img.shields.io/badge/P2-orange?style=flat)\n**Los loops no esperan a este revisor**\n\nDetalle.";
    expect(priorityOf(claude)).toBe("P2");
    expect(titleOf(claude)).toBe("Los loops no esperan a este revisor");
    // A shields badge that is not a priority is not one.
    expect(priorityOf("![](https://img.shields.io/badge/build-passing-green)")).toBeNull();
  });

  it("falls back to the first line for a reviewer without a badge", () => {
    expect(priorityOf("nit: rename this")).toBeNull();
    expect(titleOf("\nnit: rename this\nmore")).toBe("nit: rename this");
  });
});

describe("parsePage", () => {
  const page = (nodes: unknown[], next: string | null = null) =>
    JSON.stringify({
      data: {
        viewer: { login: SELF },
        repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } } },
      },
    });
  const c = (login: string, id: number) => ({ author: { login }, body: body("P3", "t"), url: `u${id}`, databaseId: id });

  it("narrows a thread to its first and latest comment, and carries the cursor", () => {
    const read = parsePage(
      page(
        [
          {
            isResolved: false,
            isOutdated: true,
            path: "p.ts",
            line: null,
            originalLine: 4,
            comments: { totalCount: 2, nodes: [c(CODEX, 1)] },
            last: { nodes: [c(SELF, 2)] },
          },
        ],
        "abc",
      ),
    );
    expect(read.viewer).toBe(SELF);
    expect(read.next).toBe("abc");
    expect(read.threads[0]).toMatchObject({ line: 4, comments: 2, first: { author: CODEX }, latest: { author: SELF } });
  });

  it("refuses an answer with no threads in it rather than reading it as none", () => {
    expect(() => parsePage(JSON.stringify({ data: { viewer: { login: SELF }, repository: { pullRequest: null } } }))).toThrow(
      /reviewThreads/,
    );
  });
});

describe("the command", () => {
  it("parses a PR and its options, and refuses anything else", () => {
    expect(parseArgs(["12", "--repo", "o/n", "--json"])).toEqual({ pr: 12, repo: "o/n", json: true });
    expect(parseArgs([])).toMatch(/usage/);
    expect(parseArgs(["12", "--repo", "bad"])).toMatch(/owner\/name/);
  });

  it("prints a reply command for each open thread", () => {
    const out = render(9, "o/n", openThreads([thread()], SELF));
    expect(out).toContain("PR #9: 1 open review thread");
    expect(out).toContain("gh api repos/o/n/pulls/9/comments/11/replies -F body=@<file>");
    expect(render(9, "o/n", [])).toBe("PR #9: no open review threads");
  });
});
