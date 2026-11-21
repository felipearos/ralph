/**
 * The frontier over a tracker that is not GitHub (felipearos/ralph#333).
 *
 * The same backlog, written once as GitHub issues (`#n`) and once as Linear
 * tickets (`AND-n`, native parents and blockers), must produce the same
 * frontier and the same pick, and the claim fence must hold the same way: the
 * live re-read, other loops' labels, and an open PR, which a tracker that
 * cannot see GitHub ties to its ticket by branch or body.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakeTracker, type FakeIssue, type FakeTrackerOptions } from "../tracker/fake";
import {
  buildTickets,
  claimByNumber,
  classify,
  linkKeyedPullRequests,
  parseParent,
  parseProseBlockers,
  readKeyedFrontierInputs,
  readLiveIssue,
  readStuckReasons,
  takeOneCandidates,
  useFrontierTracker,
  useReferenceKey,
  type OpenPullRequestHead,
} from "./next-tasks";

// The claim labels come from the project's roster: loggd's ralph, rafa, remo, rulo, testo.
process.env.RALPH_PROJECT = join(__dirname, "..", "fixtures", "loggd");

afterEach(() => useFrontierTracker(null));

type Seeded = Partial<FakeIssue> & { number: number };

/** One backlog, spelt for GitHub or for a keyed tracker. */
function backlog(ref: (n: number) => string, native: boolean): Seeded[] {
  return [
    { number: 1, title: "Spec: the thing", labels: ["spec"] },
    { number: 2, title: "First slice", labels: ["ready-for-agent"], body: native ? "" : `## Parent\n\n${ref(1)}\n`, parent: native ? 1 : null },
    {
      number: 3,
      title: "Second slice",
      labels: ["ready-for-agent"],
      body: native ? "" : `## Parent\n\n${ref(1)}\n\n## Blocked by\n\n- ${ref(2)}\n`,
      parent: native ? 1 : null,
      blockers: native ? [2] : [],
    },
    { number: 4, title: "Unrelated", labels: ["ready-for-agent"] },
    { number: 5, title: "Someone has it", labels: ["ready-for-agent", "rafa-wip"] },
    { number: 6, title: "Done long ago", state: "closed" },
  ];
}

async function frontierOf(options: FakeTrackerOptions, key: string | null, heads: OpenPullRequestHead[] = []) {
  const tracker = createFakeTracker(options);
  useReferenceKey(key);
  const inputs = await readKeyedFrontierInputs(tracker, { gh: async () => JSON.stringify(heads) });
  const tickets = buildTickets(inputs.raw, inputs.natives, new Set(inputs.closed.map((issue) => issue.number)), inputs.openPrs);
  const frontier = classify(tickets, inputs.closed.map((issue) => parseParent(issue.body)).filter((n): n is number => n !== null));
  return { tracker, tickets, frontier };
}

describe("the frontier over a keyed tracker", () => {
  it("offers the same tickets from a Linear backlog as from the same GitHub backlog", async () => {
    const github = await frontierOf({ issues: backlog((n) => `#${n}`, false) }, null);
    const linear = await frontierOf({ kind: "linear", key: "AND", issues: backlog((n) => `AND-${n}`, true) }, "AND");
    const shape = (f: Awaited<ReturnType<typeof frontierOf>>) => ({
      ready: f.frontier.readyTasks.map((t) => t.number),
      blocked: f.frontier.blocked.map((t) => t.number),
      pick: takeOneCandidates(f.frontier).map((t) => t.number),
      parents: [...f.tickets.values()].map((t) => [t.number, t.parent]),
    });
    expect(shape(linear)).toEqual(shape(github));
    // The spec is a container, #3 waits on #2, #5 is another loop's.
    expect(shape(linear).ready).not.toContain(1);
    expect(shape(linear).blocked).toContain(3);
    expect(shape(linear).ready).not.toContain(5);
  });

  it("reads AND-n references and never a #n, which in a Linear body is a pull request", () => {
    useReferenceKey("AND");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const body = "## Parent\n\nAND-171, the spec (see PR #73).\n\n## Blocked by\n\n* AND-180\n* OA-12\n* PR #73\n";
    expect(parseParent(body)).toBe(171);
    expect(parseProseBlockers(body)).toEqual([180]);
    expect(error.mock.calls.map((call) => call[0])).toEqual([
      "next-tasks: ignoring OA-12: it is not a AND ticket, so this project cannot read it",
    ]);
    error.mockRestore();
    useReferenceKey(null);
    expect(parseProseBlockers(body)).toEqual([73]);
  });

  it("fences a ticket whose open PR is on a loop's branch for it", async () => {
    const heads = [{ number: 900, headRefName: "rafa/4-unrelated", body: "" }];
    const { frontier } = await frontierOf({ kind: "linear", key: "AND", issues: backlog((n) => `AND-${n}`, true) }, "AND", heads);
    expect(frontier.readyTasks.map((t) => t.number)).not.toContain(4);
    expect(frontier.inFlight.map((t) => t.number)).toContain(4);
  });
});

describe("linkKeyedPullRequests", () => {
  const loops = ["ralph", "rafa"];
  it("ties a PR to the ticket its loop branch or its body names", () => {
    expect(
      linkKeyedPullRequests(
        [
          { number: 10, headRefName: "ralph/184-search-module", body: "" },
          { number: 11, headRefName: "feature/x", body: "Implements AND-185 and AND-186.\n\nPR #73 was the first try." },
          { number: 12, headRefName: "ralph/187", body: "" },
        ],
        "AND",
        loops,
      ),
    ).toEqual([
      { number: 10, closingIssuesReferences: [{ number: 184 }] },
      { number: 11, closingIssuesReferences: [{ number: 185 }, { number: 186 }] },
      { number: 12, closingIssuesReferences: [{ number: 187 }] },
    ]);
  });

  it("ignores a branch of a loop this project does not have, and another key", () => {
    expect(
      linkKeyedPullRequests([{ number: 13, headRefName: "nova/184-x", body: "OA-184" }], "AND", loops),
    ).toEqual([{ number: 13, closingIssuesReferences: [] }]);
  });

  it("does not tie a PR to a key it quotes as code", () => {
    expect(
      linkKeyedPullRequests(
        [{ number: 14, headRefName: "feature/y", body: "Ticket: AND-184 https://x\n\n- [ ] builds on `AND-185`\n\n```\nAND-186\n```" }],
        "AND",
        loops,
      ),
    ).toEqual([{ number: 14, closingIssuesReferences: [{ number: 184 }] }]);
  });

  it("reads a double-backtick span and a fence holding a ```js line as code", () => {
    expect(
      linkKeyedPullRequests(
        [{ number: 15, headRefName: "feature/z", body: "Implements AND-184.\n\nSee ``AND-185`` too.\n\n```\n```js\nAND-186\n```\nAND-187" }],
        "AND",
        loops,
      ),
    ).toEqual([{ number: 15, closingIssuesReferences: [{ number: 184 }, { number: 187 }] }]);
  });
});

describe("claiming on a keyed tracker", () => {
  const io = (tracker: ReturnType<typeof createFakeTracker>) => ({
    readLive: readLiveIssue,
    claim: async (n: number, label: string) => {
      await tracker.claim(n, label);
    },
    isOpenPr: async () => true,
  });

  it("lets exactly one of two loops hold a ticket, and moves it to In Progress", async () => {
    const tracker = createFakeTracker({ kind: "linear", key: "AND", issues: [{ number: 184, labels: ["ready-for-agent"] }] });
    useFrontierTracker(tracker, "AND", async () => []);
    const first = await claimByNumber(184, "ralph-wip", io(tracker));
    const second = await claimByNumber(184, "rafa-wip", io(tracker));
    expect(first.claimed).toBe(true);
    expect(second).toMatchObject({ claimed: false, refusal: "labeled ralph-wip" });
    expect(tracker.issues.get(184)!.labels).toEqual(["ready-for-agent", "ralph-wip"]);
    expect(tracker.issues.get(184)!.status).toBe("In Progress");
  });

  it("refuses a ticket an open PR on a loop branch already carries", async () => {
    const tracker = createFakeTracker({ kind: "linear", key: "AND", issues: [{ number: 184, labels: ["ready-for-agent"] }] });
    useFrontierTracker(tracker, "AND", async () => [{ number: 901, headRefName: "remo/184-search", body: "" }]);
    const outcome = await claimByNumber(184, "ralph-wip", io(tracker));
    expect(outcome).toMatchObject({ claimed: false, refusal: "open PR #901" });
    expect(tracker.writes).toEqual([]);
  });

  it("refuses a ticket the tracker's live read calls closed, though it still wears ready-for-agent", async () => {
    // OAI-140: a Jira ticket already in the done-category "Mergeado" was
    // claimed because the claim's live re-read dropped the state.
    const tracker = createFakeTracker({
      kind: "jira",
      key: "OA",
      issues: [{ number: 140, labels: ["ready-for-agent"], state: "closed", status: "Mergeado" }],
    });
    useFrontierTracker(tracker, "OA", async () => []);
    const outcome = await claimByNumber(140, "ralph-wip", io(tracker));
    expect(outcome.claimed).toBe(false);
    expect(outcome.refusal).toBe("closed (Mergeado)");
    expect(tracker.writes).toEqual([]);
    useReferenceKey("OA");
    const inputs = await readKeyedFrontierInputs(tracker, { gh: async () => "[]" });
    expect(inputs.raw.map((issue) => issue.number)).not.toContain(140);
  });

  it("reads a stuck ticket's reason off the tracker's comments", async () => {
    const tracker = createFakeTracker({
      kind: "jira",
      key: "OA",
      issues: [{ number: 410, comments: [{ body: "blocked: waiting on the migration, PR #12", createdAt: "2026-10-20T00:00:00Z" }] }],
    });
    useFrontierTracker(tracker, "OA");
    const reasons = await readStuckReasons([410]);
    expect(reasons.get(410)).toMatchObject({ kind: "other", pr: 12 });
  });
});
