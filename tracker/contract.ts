/**
 * The behaviour every `Tracker` adapter owes the loops (felipearos/ralph#330),
 * as one suite each adapter's test file runs against its own setup: the
 * in-memory fake in both shapes, GitHub over an emulated `gh`, and Linear and
 * Jira over recorded HTTP. A new tracker is done when it passes this.
 *
 * Only outcomes are asserted (what the issue looks like after a write, what a
 * read returns), never which calls an adapter made to get there.
 */
import { describe, expect, it } from "vitest";

import type { IssueComment } from "../block-reason";
import { TrackerIssueNotFoundError, type Tracker, type TrackerKind } from "./types";

/** One issue as a test arranges it. Numbers are what the tracker numbers them, whatever its key. */
export interface SeedIssue {
  number: number;
  title?: string;
  body?: string;
  state?: "open" | "closed";
  /** When a closed issue was closed (ISO 8601). */
  closedAt?: string;
  /** When it was last updated (ISO 8601); absent reads as `closedAt`. */
  updatedAt?: string;
  /** URLs of pull requests the tracker links to the issue, oldest first. */
  pullRequests?: string[];
  labels?: string[];
  assignees?: string[];
  author?: string | null;
  blockers?: number[];
  comments?: IssueComment[];
}

export interface Seed {
  issues: SeedIssue[];
  /** Labels that exist before the test runs. */
  labels: string[];
  /** Who an `assign()` with no login assigns. */
  self: string;
}

export interface ContractSetup {
  kind: TrackerKind;
  /** `#7` on GitHub, `AND-7` on Linear: what `ref(7)` must print. */
  ref: (number: number) => string;
  /** Whether a claim and a finished ticket move workflow states. */
  movesStates: boolean;
  /**
   * A state a new issue may be opened in, or null where the tracker has none:
   * Linear's team calls it "Todo" and Jira's workflow "To Do", and a contract
   * that named one of them would be testing the tracker's vocabulary.
   */
  openState: string | null;
  /** Whether a missing label is created by `ensureLabels` (false: labels are free-form and need none). */
  createsLabels: boolean;
  /**
   * How an issue closed by `cancel()` reads back: "completed" where the
   * tracker has no cancelled close (Jira's cancel moves to a done-category state).
   */
  cancelsAs: "completed" | "canceled";
  /** Whether `issue()` lists the PRs linked to it (false: it reports none). */
  listsPullRequests: boolean;
  /**
   * Whether an unknown number raises `TrackerIssueNotFoundError` (false: it
   * only throws). The Linear and Jira adapters adopt it later.
   */
  raisesNotFound: boolean;
  make(seed: Seed): Tracker | Promise<Tracker>;
}

const SEED: Seed = {
  self: "felipe",
  labels: ["ready-for-agent", "spec", "ralph-wip", "ralph-blocked", "ralph-done", "rafa-wip"],
  issues: [
    { number: 1, title: "Spec: the thing", body: "spec body", labels: ["spec"], author: "felipe" },
    {
      number: 2,
      title: "First slice",
      body: "## Parent\n\n#1\n",
      labels: ["ready-for-agent"],
      author: "felipe",
      comments: [
        { body: "first", createdAt: "2026-10-01T00:00:00Z" },
        { body: "second", createdAt: "2026-10-02T00:00:00Z" },
      ],
    },
    { number: 3, title: "Second slice", labels: ["ready-for-agent"], blockers: [2, 4], author: "felipe" },
    {
      number: 4,
      title: "Done slice",
      state: "closed",
      closedAt: "2026-10-03T12:00:00Z",
      pullRequests: ["https://github.com/felipearos/ralph/pull/12", "https://github.com/felipearos/ralph/pull/15"],
      author: "felipe",
    },
    { number: 5, title: "Someone else's", labels: ["ready-for-agent", "rafa-wip"], assignees: ["mateo"], author: "mateo" },
  ],
};

/**
 * A marker a caller would really use, shaped so no tracker's full-text index
 * splits it into words that match something else: Jira's `~` is word-based and
 * GitHub's `in:body` search is fuzzy, so one run of letters and digits is what
 * makes the lookup's own substring check meaningful.
 */
const MARKER = "ralphintake7f3a9b2c";

/**
 * Asserts a close time was stamped by a write made after `since`. The slack
 * is for adapters over recorded HTTP, whose clock is the emulator's, not ours.
 */
const expectClosedSince = (closedAt: string | null, since: number): void => {
  expect(closedAt).not.toBeNull();
  const at = Date.parse(closedAt!);
  expect(Number.isNaN(at)).toBe(false);
  expect(at).toBeGreaterThanOrEqual(since - 60_000);
};

export function trackerContract(name: string, setup: ContractSetup): void {
  const fresh = async (): Promise<Tracker> => setup.make(structuredClone(SEED));

  describe(`Tracker contract: ${name}`, () => {
    it("names its kind and renders references and links", async () => {
      const tracker = await fresh();
      expect(tracker.kind).toBe(setup.kind);
      expect(tracker.ref(7)).toBe(setup.ref(7));
      expect(tracker.url(7)).toMatch(/^https:\/\//);
    });

    it("lists the open issues, newest first, with labels, assignees, author, blockers and the comment tail", async () => {
      const open = await (await fresh()).openIssues();
      expect(open.map((issue) => issue.number)).toEqual([5, 3, 2, 1]);
      const second = open.find((issue) => issue.number === 2)!;
      expect(second.title).toBe("First slice");
      expect(second.body).toContain("## Parent");
      expect(second.labels).toEqual(["ready-for-agent"]);
      expect(second.author).toBe("felipe");
      expect(second.comments.map((comment) => comment.body)).toEqual(["first", "second"]);
      const blocked = open.find((issue) => issue.number === 3)!;
      expect([...(blocked.blockers ?? [])].sort((a, b) => a.number - b.number)).toEqual([
        { number: 2, state: "open" },
        { number: 4, state: "closed" },
      ]);
      expect(open.find((issue) => issue.number === 5)!.assignees).toEqual(["mateo"]);
    });

    it("lists the closed issues", async () => {
      const closed = await (await fresh()).closedIssues();
      expect(closed.map((issue) => issue.number)).toEqual([4]);
      expect(closed[0]!.title).toBe("Done slice");
    });

    it("reads one issue in full, comments oldest first", async () => {
      const tracker = await fresh();
      const issue = await tracker.issue(2);
      expect(issue).toMatchObject({ number: 2, title: "First slice", state: "open", labels: ["ready-for-agent"], author: "felipe" });
      expect(issue.comments.map((comment) => comment.body)).toEqual(["first", "second"]);
      expect(issue.url).toBe(tracker.url(2));
      expect(issue.closedAt).toBeNull();
      expect(issue.closedAs).toBeNull();
      expect(issue.pullRequests).toEqual([]);
      const closed = await tracker.issue(4);
      expect(closed.state).toBe("closed");
      expect(Date.parse(closed.closedAt!)).toBe(Date.parse("2026-10-03T12:00:00Z"));
      expect(closed.closedAs).toBe("completed");
      expect(closed.pullRequests).toEqual(
        setup.listsPullRequests ? ["https://github.com/felipearos/ralph/pull/12", "https://github.com/felipearos/ralph/pull/15"] : [],
      );
      expect((await tracker.comments(2)).map((comment) => comment.body)).toEqual(["first", "second"]);
    });

    it("re-reads the claim fields live", async () => {
      const live = await (await fresh()).live(5);
      expect(live.assignees).toEqual(["mateo"]);
      expect(live.labels.sort()).toEqual(["rafa-wip", "ready-for-agent"]);
      expect(live.linkedPullRequests).toEqual([]);
      expect(live.state).toBe("open");
      expect((await (await fresh()).live(4)).state).toBe("closed");
    });

    it("lists issues by label and state", async () => {
      const tracker = await fresh();
      expect((await tracker.withLabel("ready-for-agent")).map((issue) => issue.number)).toEqual([5, 3, 2]);
      expect(await tracker.withLabel("ralph-wip")).toEqual([]);
    });

    it("lists by label only the issues updated since a time, when asked", async () => {
      const seed = structuredClone(SEED);
      seed.issues.find((issue) => issue.number === 4)!.labels = ["ralph-done"];
      seed.issues.push({ number: 6, title: "Done long ago", state: "closed", closedAt: "2026-09-10T12:00:00Z", updatedAt: "2026-09-10T12:00:00Z", labels: ["ralph-done"] });
      const tracker = await setup.make(seed);
      expect((await tracker.withLabel("ralph-done", { state: "closed" })).map((issue) => issue.number).sort()).toEqual([4, 6]);
      // Between the two: 4 was updated (closed) on 10-03, 6 on 09-10.
      expect((await tracker.withLabel("ralph-done", { state: "closed", updatedSince: "2026-09-25T00:00:00Z" })).map((issue) => issue.number)).toEqual([4]);
    });

    it("adds and removes labels idempotently", async () => {
      const tracker = await fresh();
      await tracker.addLabels(2, ["spec"]);
      await tracker.addLabels(2, ["spec"]);
      expect((await tracker.live(2)).labels.sort()).toEqual(["ready-for-agent", "spec"]);
      await tracker.removeLabels(2, ["spec", "ralph-wip"]);
      expect((await tracker.live(2)).labels).toEqual(["ready-for-agent"]);
    });

    it("assigns to the credential's user by default, or to a named login", async () => {
      const tracker = await fresh();
      await tracker.assign(2);
      expect((await tracker.live(2)).assignees).toEqual(["felipe"]);
      await tracker.assign(3, "mateo");
      expect((await tracker.live(3)).assignees).toEqual(["mateo"]);
    });

    it("posts a comment at the end of the thread", async () => {
      const tracker = await fresh();
      await tracker.comment(2, "Starting #2 on ralph/2-first-slice");
      const bodies = (await tracker.comments(2)).map((comment) => comment.body);
      expect(bodies.at(-1)).toBe("Starting #2 on ralph/2-first-slice");
      expect(bodies).toHaveLength(3);
    });

    it("claims with the label, moving the state where the tracker has states", async () => {
      const tracker = await fresh();
      const transition = await tracker.claim(2, "ralph-wip");
      expect((await tracker.live(2)).labels.sort()).toEqual(["ralph-wip", "ready-for-agent"]);
      expect(transition.warning).toBeNull();
      if (setup.movesStates) {
        expect(transition.movedTo).not.toBeNull();
        expect((await tracker.issue(2)).status).toBe(transition.movedTo);
      } else {
        expect(transition.movedTo).toBeNull();
      }
    });

    it("finishes a ticket: closed, every wip label gone, the done label on", async () => {
      const tracker = await fresh();
      const since = Date.now();
      await tracker.addLabels(2, ["ralph-wip", "rafa-wip"]);
      await tracker.done(2, "ralph-done");
      const issue = await tracker.issue(2);
      expect(issue.state).toBe("closed");
      expectClosedSince(issue.closedAt, since);
      expect(issue.closedAs).toBe("completed");
      expect(issue.labels.sort()).toEqual(["ralph-done", "ready-for-agent"]);
      expect((await tracker.closedIssues()).map((closed) => closed.number)).toContain(2);
    });

    it("finishing an already-closed ticket still swaps its labels", async () => {
      const tracker = await fresh();
      await tracker.addLabels(4, ["ralph-wip"]);
      await tracker.done(4, "ralph-done");
      const issue = await tracker.issue(4);
      expect(issue.state).toBe("closed");
      expect(issue.labels).toEqual(["ralph-done"]);
    });

    it("hands a ticket to a person: wip gone, done on, still open", async () => {
      const tracker = await fresh();
      await tracker.claim(2, "ralph-wip");
      await tracker.handoff(2, "ralph-done");
      const issue = await tracker.issue(2);
      expect(issue.state).toBe("open");
      expect(issue.labels.sort()).toEqual(["ralph-done", "ready-for-agent"]);
    });

    it("parks a stuck ticket: wip gone, blocked on, still open", async () => {
      const tracker = await fresh();
      await tracker.claim(2, "ralph-wip");
      const transition = await tracker.blocked(2, "ralph-blocked");
      const issue = await tracker.issue(2);
      expect(issue.state).toBe("open");
      expect(issue.labels.sort()).toEqual(["ralph-blocked", "ready-for-agent"]);
      expect(transition.movedTo).toBeNull();
    });

    it("creates an issue with its labels and, where the tracker has states, its state", async () => {
      const tracker = await fresh();
      const created = await tracker.create({
        title: "A new report",
        // No trailing newline: Jira's native body is ADF, and a round trip
        // through it drops one, so demanding it would fence Jira out of the
        // contract over a difference no caller can see.
        body: "Reported in Slack.",
        labels: ["ready-for-agent"],
        ...(setup.openState === null ? {} : { state: setup.openState }),
      });
      expect([1, 2, 3, 4, 5]).not.toContain(created.number);
      expect(created.url).toBe(tracker.url(created.number));
      expect(created.warning).toBeNull();
      const issue = await tracker.issue(created.number);
      expect(issue).toMatchObject({ title: "A new report", body: "Reported in Slack.", state: "open", labels: ["ready-for-agent"] });
      expect((await tracker.openIssues()).map((open) => open.number)).toContain(created.number);
      if (setup.movesStates) {
        expect(created.movedTo).toBe(setup.openState);
        expect(issue.status).toBe(setup.openState);
      } else {
        expect(created.movedTo).toBeNull();
      }
    });

    it("creates an issue with no state named and no labels", async () => {
      const tracker = await fresh();
      const created = await tracker.create({ title: "Bare", body: "" });
      expect(created.warning).toBeNull();
      const issue = await tracker.issue(created.number);
      expect(issue.title).toBe("Bare");
      expect(issue.labels).toEqual([]);
      expect(issue.state).toBe("open");
    });

    it("edits a body, leaving the title and the labels alone", async () => {
      const tracker = await fresh();
      await tracker.editBody(2, "## What to build\n\nThe brief a triager wrote.");
      const issue = await tracker.issue(2);
      expect(issue.body).toBe("## What to build\n\nThe brief a triager wrote.");
      expect(issue.title).toBe("First slice");
      expect(issue.labels).toEqual(["ready-for-agent"]);
    });

    it("cancels an issue: closed, no longer open, labels untouched", async () => {
      const tracker = await fresh();
      const since = Date.now();
      const transition = await tracker.cancel(2);
      expect(transition.warning).toBeNull();
      const issue = await tracker.issue(2);
      expect(issue.state).toBe("closed");
      expectClosedSince(issue.closedAt, since);
      expect(issue.closedAs).toBe(setup.cancelsAs);
      expect(issue.labels).toEqual(["ready-for-agent"]);
      expect((await tracker.openIssues()).map((open) => open.number)).not.toContain(2);
      expect((await tracker.closedIssues()).map((closed) => closed.number)).toContain(2);
      if (setup.movesStates) {
        expect(transition.movedTo).not.toBeNull();
        expect(issue.status).toBe(transition.movedTo);
      } else {
        expect(transition.movedTo).toBeNull();
      }
    });

    it("reopens a closed ticket: open again, labels untouched; reopening an open one changes nothing", async () => {
      const tracker = await fresh();
      await tracker.addLabels(4, ["ralph-done"]);
      const transition = await tracker.reopen(4);
      expect(transition.warning).toBeNull();
      const issue = await tracker.issue(4);
      expect(issue.state).toBe("open");
      expect(issue.closedAt).toBeNull();
      expect(issue.closedAs).toBeNull();
      expect(issue.labels).toEqual(["ralph-done"]);
      expect((await tracker.openIssues()).map((open) => open.number)).toContain(4);
      expect((await tracker.closedIssues()).map((closed) => closed.number)).not.toContain(4);
      if (setup.movesStates) {
        expect(transition.movedTo).not.toBeNull();
        expect(issue.status).toBe(transition.movedTo);
      } else {
        expect(transition.movedTo).toBeNull();
      }
      const before = await tracker.issue(2);
      expect(await tracker.reopen(2)).toEqual({ movedTo: null, warning: null });
      const after = await tracker.issue(2);
      expect(after.state).toBe("open");
      expect(after.status).toBe(before.status);
      expect(after.labels).toEqual(before.labels);
    });

    it("finds an issue it may already have created by a marker in the body, cancelled or not", async () => {
      const tracker = await fresh();
      const created = await tracker.create({ title: "Repeated report", body: `Reported in Slack.\n\n<!-- ${MARKER} -->` });
      expect(await tracker.findByBodyMarker(MARKER)).toEqual([{ number: created.number, title: "Repeated report" }]);
      expect(await tracker.findByBodyMarker("ralphintake0000dead")).toEqual([]);
      // The whole point: a retry after a create that was never recorded must
      // find the issue whatever became of it, or it opens a second one.
      await tracker.cancel(created.number);
      expect(await tracker.findByBodyMarker(MARKER)).toEqual([{ number: created.number, title: "Repeated report" }]);
      expect(await tracker.findByBodyMarker(MARKER, { state: "open" })).toEqual([]);
    });

    it("answers the marker lookup newest first, and respects its limit", async () => {
      const tracker = await fresh();
      const first = await tracker.create({ title: "First report", body: `<!-- ${MARKER} -->` });
      const second = await tracker.create({ title: "Second report", body: `<!-- ${MARKER} -->` });
      // Newest first is what a caller reads the first row of, so the order is
      // part of the contract and not left to each tracker's search ranking.
      expect(await tracker.findByBodyMarker(MARKER)).toEqual([
        { number: second.number, title: "Second report" },
        { number: first.number, title: "First report" },
      ]);
      expect(await tracker.findByBodyMarker(MARKER, { limit: 1 })).toEqual([{ number: second.number, title: "Second report" }]);
    });

    it("creates the labels that are missing, where labels need creating", async () => {
      const tracker = await fresh();
      const result = await tracker.ensureLabels(["ralph-wip", "tria-wip"]);
      expect(result.missing).toEqual([]);
      expect(result.created).toEqual(setup.createsLabels ? ["tria-wip"] : []);
      await tracker.addLabels(2, ["tria-wip"]);
      expect((await tracker.live(2)).labels).toContain("tria-wip");
    });

    it("names an issue that does not exist, on reads and writes", async () => {
      const tracker = await fresh();
      if (!setup.raisesNotFound) {
        await expect(tracker.issue(999)).rejects.toThrow();
        return;
      }
      // Reads and writes alike name the missing issue, so the CLI can say so.
      const missing = { name: "TrackerIssueNotFoundError", ref: setup.ref(999) };
      for (const call of [
        () => tracker.issue(999),
        () => tracker.live(999),
        () => tracker.comment(999, "hello"),
        () => tracker.addLabels(999, ["ralph-wip"]),
      ]) {
        const error = await call().then(
          () => null,
          (thrown: unknown) => thrown,
        );
        expect(error).toBeInstanceOf(TrackerIssueNotFoundError);
        expect(error).toMatchObject(missing);
      }
    });
  });
}
