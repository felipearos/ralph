import { describe, expect, it } from "vitest";

import { trackerContract, type Seed } from "./contract";
import { createFakeTracker, FakeThrottle, type FakeTrackerOptions } from "./fake";

const fromSeed = (seed: Seed, options: FakeTrackerOptions) =>
  createFakeTracker({
    ...options,
    self: seed.self,
    labels: seed.labels,
    issues: seed.issues.map((issue) => ({
      ...issue,
      title: issue.title ?? `Issue ${issue.number}`,
    })),
  });

trackerContract("fake, GitHub-shaped", {
  kind: "github",
  ref: (number) => `#${number}`,
  movesStates: false,
  openState: null,
  createsLabels: true,
  cancelsAs: "canceled",
  listsPullRequests: true,
  raisesNotFound: true,
  make: (seed) => fromSeed(seed, { kind: "github" }),
});

trackerContract("fake, Linear-shaped", {
  kind: "linear",
  ref: (number) => `AND-${number}`,
  movesStates: true,
  openState: "Todo",
  createsLabels: true,
  cancelsAs: "canceled",
  listsPullRequests: true,
  raisesNotFound: true,
  make: (seed) => fromSeed(seed, { kind: "linear", key: "AND" }),
});

trackerContract("fake, Jira-shaped", {
  kind: "jira",
  ref: (number) => `OA-${number}`,
  movesStates: true,
  openState: "Todo",
  createsLabels: false,
  cancelsAs: "canceled",
  listsPullRequests: true,
  raisesNotFound: true,
  make: (seed) => fromSeed(seed, { kind: "jira", key: "OA" }),
});

describe("fake tracker", () => {
  it("moves a keyed issue to the configured states", async () => {
    const tracker = createFakeTracker({
      kind: "linear",
      key: "AND",
      states: { claimed: "Doing", done: "Shipped" },
      workflow: ["Backlog", "Doing", "Shipped"],
      issues: [{ number: 184 }],
    });
    expect(tracker.issues.get(184)!.status).toBe("Backlog");
    expect(await tracker.claim(184, "ralph-wip")).toEqual({ movedTo: "Doing", warning: null });
    expect(await tracker.done(184, "ralph-done")).toEqual({ movedTo: "Shipped", warning: null });
  });

  it("reports a missing workflow state as a warning and keeps the claim label", async () => {
    const tracker = createFakeTracker({
      kind: "jira",
      key: "OA",
      states: { claimed: "In Progress", done: "Done" },
      workflow: ["To Do", "Done"],
      issues: [{ number: 410 }],
    });
    const transition = await tracker.claim(410, "ralph-wip");
    expect(transition).toEqual({ movedTo: null, warning: "no workflow state named 'In Progress'" });
    expect(tracker.issues.get(410)!.labels).toEqual(["ralph-wip"]);
  });

  it("leaves an issue open when a keyed cancel has no state to move it into", async () => {
    const tracker = createFakeTracker({
      kind: "linear",
      key: "AND",
      states: { claimed: "In Progress", done: "Done" },
      workflow: ["Todo", "In Progress", "Done"],
      issues: [{ number: 184, body: "report" }],
    });
    // The move IS the close on a keyed tracker, so a warning means nothing
    // closed — the same way the Linear adapter leaves it.
    expect(await tracker.cancel(184)).toEqual({ movedTo: null, warning: "no workflow state named 'Canceled'" });
    expect(tracker.issues.get(184)!.state).toBe("open");
    expect(await tracker.findByBodyMarker("report")).toEqual([{ number: 184, title: "Issue 184" }]);
  });

  it("links PRs only when GitHub-shaped", async () => {
    const issues = [{ number: 1, linkedPullRequests: [42] }];
    expect((await createFakeTracker({ issues }).live(1)).linkedPullRequests).toEqual([42]);
    expect((await createFakeTracker({ kind: "linear", key: "AND", issues }).live(1)).linkedPullRequests).toEqual([]);
  });

  it("fails the next call to an operation once, and classifies its throttle", async () => {
    const tracker = createFakeTracker({ issues: [{ number: 1 }] });
    const throttle = new FakeThrottle({ kind: "quota", retryAfterSeconds: 30 });
    tracker.failNext("openIssues", throttle);
    await expect(tracker.openIssues()).rejects.toBe(throttle);
    expect(tracker.classifyFailure(throttle)).toEqual({ kind: "quota", retryAfterSeconds: 30 });
    expect(await tracker.openIssues()).toHaveLength(1);
  });

  it("needs a key when keyed", () => {
    expect(() => createFakeTracker({ kind: "linear" })).toThrow(/needs a key/);
  });
});
