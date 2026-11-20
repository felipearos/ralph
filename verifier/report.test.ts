import { describe, expect, it } from "vitest";

import type { PushInput } from "../push-notification";
import { createFakeTracker, type FakeTracker } from "../tracker/fake";
import { READY_LABEL as FRONTIER_READY_LABEL, URGENT_LABEL as FRONTIER_URGENT_LABEL } from "../frontier/next-tasks";
import { chainFromBody, chainFromRevertComment, fixMarker, READY_LABEL, reportWatch, revertedLine, URGENT_LABEL, type ReportDeps } from "./report";
import type { AcceptanceResult } from "./verdict";
import { emptyStore, type Watch, type WatchReported, type WatchStore, type WatchVerdict } from "./watches";

const NOW = new Date("2026-10-29T12:00:00.000Z");

function makeWatch(overrides: Partial<Watch> = {}): Watch {
  return {
    pr: 501,
    ticket: 10,
    root: null,
    ticketRef: "#10",
    mergeCommit: "abc123",
    mergedAt: "2026-10-29T09:00:00.000Z",
    deployId: "dpl_1",
    deployedAt: "2026-10-29T10:00:00.000Z",
    deployUrl: "https://deploy.example/dpl_1",
    checkIns: [
      { offsetHours: 1, dueAt: "2026-10-29T11:00:00.000Z", result: null },
      { offsetHours: 24, dueAt: "2026-10-30T10:00:00.000Z", result: null },
    ],
    round: 1,
    lineage: [],
    mode: "report",
    openedAt: "2026-10-29T10:05:00.000Z",
    verdict: null,
    reported: {},
    ...overrides,
  };
}

const verdictOf = (verdict: WatchVerdict["verdict"], reason: string, extra: Partial<WatchVerdict> = {}): WatchVerdict => ({
  verdict,
  reason,
  act: true,
  offsetHours: 24,
  decidedAt: "2026-10-30T10:01:00.000Z",
  ...extra,
});

/** A watch whose first check-in recorded `acceptance` and saw one Sentry issue. */
function withAcceptance(watch: Watch, acceptance: AcceptanceResult[]): Watch {
  watch.checkIns[0]!.result = {
    handedOverAt: "2026-10-29T11:00:00.000Z",
    evidence: {
      gatheredAt: "2026-10-29T11:00:00.000Z",
      health: {
        reachable: true,
        issues: [
          {
            id: "S1",
            title: "TypeError in checkout",
            link: "https://sentry.example/issues/S1",
            firstSeen: "2026-10-29T10:30:00.000Z",
            preDeployRate: 0,
            postDeployRate: 3,
            frameFiles: [],
            routes: [],
            events: 3,
            distinctUsers: 1,
          },
        ],
      },
      traffic: { reachable: true, hits: 4 },
      pr: { number: watch.pr, files: [], routes: [] },
      otherPrs: [],
    },
    decision: { decidedAt: "2026-10-29T11:01:00.000Z", verdict: "ticket", reason: "x", act: true, priority: "normal" },
    acceptance,
  };
  return watch;
}

function harness(language: "en" | "es" = "en", tracker: FakeTracker = createFakeTracker({ issues: [{ number: 10 }] })) {
  const pushes: PushInput[] = [];
  const records: Partial<WatchReported>[] = [];
  const deps: ReportDeps = { tracker, push: (input) => void pushes.push(input), language, now: () => NOW, repo: "felipearos/loggd" };
  const record = (patch: Partial<WatchReported>): void => void records.push(patch);
  const merged = (): WatchReported => Object.assign({}, ...records);
  return { tracker, pushes, records, deps, record, merged };
}

const storeOf = (...watches: Watch[]): WatchStore => {
  const store = emptyStore();
  for (const watch of watches) store.watches[String(watch.pr)] = watch;
  return store;
};

const ANNOUNCED: WatchReported = { announcedAt: "2026-10-29T10:06:00.000Z" };

describe("reportWatch", () => {
  it("writes nothing for an observe watch", async () => {
    const h = harness();
    const watch = makeWatch({ mode: "observe", verdict: verdictOf("ticket", "boom") });
    expect(await reportWatch(watch, storeOf(watch), h.record, h.deps)).toEqual({ wrote: [], error: null });
    expect(h.tracker.writes).toEqual([]);
    expect(h.pushes).toEqual([]);
    expect(h.records).toEqual([]);
  });

  it("announces once: following label and one marked comment with the check-in times", async () => {
    const h = harness();
    const watch = makeWatch();
    const result = await reportWatch(watch, storeOf(watch), h.record, h.deps);
    expect(result.error).toBeNull();
    const issue = h.tracker.issues.get(10)!;
    expect(issue.labels).toEqual(["following"]);
    expect(issue.comments).toHaveLength(1);
    expect(issue.comments[0]!.body).toContain("<!-- verifier-watch pr=501 -->");
    expect(issue.comments[0]!.body).toContain("2026-10-29 11:00 UTC (+1h)");
    expect(issue.comments[0]!.body).toContain("2026-10-30 10:00 UTC (+24h)");
    expect(h.merged()).toEqual({ announcedAt: NOW.toISOString() });

    // Again with what the first call recorded: nothing to do.
    const writes = h.tracker.writes.length;
    const again = await reportWatch({ ...watch, reported: h.merged() }, storeOf(watch), h.record, h.deps);
    expect(again).toEqual({ wrote: [], error: null });
    expect(h.tracker.writes).toHaveLength(writes);

    // A gate that died after posting but before recording: the label comes back, the comment does not.
    await reportWatch(watch, storeOf(watch), h.record, h.deps);
    expect(issue.comments).toHaveLength(1);
  });

  it("writes the announce comment in Spanish for language es", async () => {
    const h = harness("es");
    const watch = makeWatch();
    await reportWatch(watch, storeOf(watch), h.record, h.deps);
    const body = h.tracker.issues.get(10)!.comments[0]!.body;
    expect(body).toContain("En seguimiento");
    expect(body).toContain("Revisiones");
    expect(body).toContain("<!-- verifier-watch pr=501 -->");
  });

  it.each(["verified", "unexercised", "inconclusive"] as const)("settles %s with its label and a comment", async (kind) => {
    const h = harness();
    h.tracker.put({ number: 10, labels: ["following"] });
    const watch = makeWatch({ reported: ANNOUNCED, verdict: verdictOf(kind, "the reason given") });
    const result = await reportWatch(watch, storeOf(watch), h.record, h.deps);
    expect(result.error).toBeNull();
    const issue = h.tracker.issues.get(10)!;
    expect(issue.labels).toEqual([kind]);
    expect(issue.comments.at(-1)!.body).toContain("the reason given");
    expect(h.merged().settledAt).toBe(NOW.toISOString());
    expect(h.pushes).toEqual([]);
  });

  it("records no announce whose comment failed", async () => {
    const h = harness();
    const watch = makeWatch();
    h.tracker.failNext("comment", new Error("down"));
    const result = await reportWatch(watch, storeOf(watch), h.record, h.deps);
    expect(result.error).toBe("announce: down");
    expect(h.tracker.issues.get(10)!.labels).toEqual(["following"]);
    expect(h.records).toEqual([]);
  });

  it("skips the announce of a watch decided before it was announced, and settles it", async () => {
    const h = harness();
    const watch = makeWatch({ verdict: verdictOf("verified", "fine") });
    expect((await reportWatch(watch, storeOf(watch), h.record, h.deps)).error).toBeNull();
    const issue = h.tracker.issues.get(10)!;
    expect(issue.labels).toEqual(["verified"]);
    expect(issue.comments).toHaveLength(1);
    expect(h.merged()).toEqual({ settledAt: NOW.toISOString() });
  });

  it("awaits an async record, and stops the watch at a record that throws", async () => {
    const h = harness();
    const watch = makeWatch({ verdict: verdictOf("verified", "fine") });
    const failing = async (): Promise<void> => {
      throw new Error("store locked");
    };
    const result = await reportWatch(watch, storeOf(watch), failing, h.deps);
    expect(result.error).toBe("record: store locked");
    // Settled on the tracker but not recorded: the next run's marker skips the comment.
    expect(h.tracker.issues.get(10)!.labels).toEqual(["verified"]);

    const records: Partial<WatchReported>[] = [];
    const slow = async (patch: Partial<WatchReported>): Promise<void> => {
      await Promise.resolve();
      records.push(patch);
    };
    expect((await reportWatch(watch, storeOf(watch), slow, h.deps)).error).toBeNull();
    expect(Object.assign({}, ...records)).toEqual({ settledAt: NOW.toISOString() });
    expect(h.tracker.issues.get(10)!.comments).toHaveLength(1);
  });

  describe("an acceptance gap", () => {
    const failed: AcceptanceResult[] = [
      { criterion: "The export button downloads a CSV", result: "failed", detail: "404 on /export", evidence: "shot.png" },
      { criterion: "The page loads", result: "passed" },
    ];
    const gap = (): Watch =>
      withAcceptance(makeWatch({ reported: ANNOUNCED, verdict: verdictOf("ticket", 'acceptance criterion failed: "export"') }), failed);

    it("files one ready-for-agent fix ticket naming the root, the round and the criterion", async () => {
      const h = harness();
      h.tracker.put({ number: 10, labels: ["following"] });
      const watch = gap();
      const result = await reportWatch(watch, storeOf(watch), h.record, h.deps);
      expect(result.error).toBeNull();
      const fix = h.tracker.issues.get(11)!;
      expect(fix.labels).toEqual(["ready-for-agent"]);
      expect(fix.body).toContain("Root ticket: #10 (https://github.com/fake/repo/issues/10)");
      expect(fix.body).toContain("failure round 1");
      expect(fix.body).toContain("The export button downloads a CSV");
      expect(fix.body).toContain("404 on /export");
      expect(fix.body).toContain("shot.png");
      expect(fix.body).not.toContain("The page loads");
      expect(fix.body).toContain("TypeError in checkout (https://sentry.example/issues/S1)");
      expect(fix.body).toContain("verifierfixfelipearosloggdpr501end");
      const watched = h.tracker.issues.get(10)!;
      expect(watched.labels).toEqual([]);
      expect(watched.comments.at(-1)!.body).toContain("#11");
      expect(h.merged()).toEqual({ fixTicket: 11, settledAt: NOW.toISOString() });
      expect(h.pushes).toEqual([]);

      const again = await reportWatch({ ...watch, reported: { ...ANNOUNCED, ...h.merged() } }, storeOf(watch), h.record, h.deps);
      expect(again).toEqual({ wrote: [], error: null });
      expect(h.tracker.writes.filter((w) => w.startsWith("create"))).toHaveLength(1);
    });

    it("recovers a fix ticket created before a crash through its marker", async () => {
      const h = harness();
      const watch = gap();
      // The settle comment fails after the create landed.
      h.tracker.failNext("comment", new Error("tracker down"));
      const first = await reportWatch(watch, storeOf(watch), h.record, h.deps);
      expect(first.error).toBe("settle: tracker down");
      expect(h.merged()).toEqual({ fixTicket: 11 });

      // And a run that lost even the fixTicket record finds it again.
      const second = await reportWatch(watch, storeOf(watch), h.record, h.deps);
      expect(second.error).toBeNull();
      expect(h.tracker.writes.filter((w) => w.startsWith("create"))).toHaveLength(1);
      expect(h.merged()).toEqual({ fixTicket: 11, settledAt: NOW.toISOString() });
    });
  });

  it("files a would-be revert as urgent and pushes one alert", async () => {
    const h = harness();
    const watch = makeWatch({
      reported: ANNOUNCED,
      verdict: verdictOf("ticket", "hard break (report mode: filed as a ticket instead of a revert)", { wouldHaveBeen: "revert" }),
    });
    const result = await reportWatch(watch, storeOf(watch), h.record, h.deps);
    expect(result.error).toBeNull();
    const fix = h.tracker.issues.get(11)!;
    expect(fix.labels).toEqual(["ready-for-agent", "priority:urgent"]);
    expect(fix.title).toContain("would have reverted PR #501");
    expect(fix.body).toContain("would have reverted PR #501");
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]).toMatchObject({ kind: "verifier-alert", occurrence: "verifier-alert:501", priority: "high", ticket: 10 });
    expect(h.merged()).toEqual({ fixTicket: 11, alerted: true, settledAt: NOW.toISOString() });

    // A retry with `alerted` recorded never pushes again.
    await reportWatch({ ...watch, reported: { ...ANNOUNCED, fixTicket: 11, alerted: true } }, storeOf(watch), h.record, h.deps);
    expect(h.pushes).toHaveLength(1);
  });

  it("treats a bare revert like a would-be revert", async () => {
    const h = harness();
    const watch = makeWatch({ mode: "act", reported: ANNOUNCED, verdict: verdictOf("revert", "hard break") });
    await reportWatch(watch, storeOf(watch), h.record, h.deps);
    expect(h.tracker.issues.get(11)!.labels).toContain("priority:urgent");
    expect(h.pushes).toHaveLength(1);
  });

  it("returns a push that throws as the alert step's error", async () => {
    const h = harness();
    h.deps.push = () => {
      throw new Error("no feed");
    };
    const watch = makeWatch({ reported: ANNOUNCED, verdict: verdictOf("revert", "hard break") });
    const result = await reportWatch(watch, storeOf(watch), h.record, h.deps);
    expect(result.error).toBe("alert: no feed");
    expect(h.merged()).toEqual({ fixTicket: 11 });
  });

  it("hands a round-cap chain to a person with a summary of every round", async () => {
    const tracker = createFakeTracker({ issues: [{ number: 10 }, { number: 20 }, { number: 30, labels: ["following"] }] });
    const h = harness("en", tracker);
    const round1 = makeWatch({ pr: 501, verdict: verdictOf("ticket", "criterion failed"), reported: { ...ANNOUNCED, fixTicket: 20 } });
    const round2 = makeWatch({
      pr: 502,
      ticket: 20,
      ticketRef: "#20",
      root: 10,
      round: 2,
      lineage: [10],
      verdict: verdictOf("ticket", "still failing"),
      reported: { ...ANNOUNCED, fixTicket: 30 },
    });
    const round3 = makeWatch({
      pr: 503,
      ticket: 30,
      ticketRef: "#30",
      root: 10,
      round: 3,
      lineage: [10, 20],
      verdict: verdictOf("needs-human", "round cap reached at round 3"),
      reported: ANNOUNCED,
    });
    const other = makeWatch({ pr: 600, ticket: 99, ticketRef: "#99" });
    const result = await reportWatch(round3, storeOf(round2, other, round1, round3), h.record, h.deps);
    expect(result.error).toBeNull();
    expect(tracker.issues.get(10)!.labels).toEqual(["needs-human"]);
    expect(tracker.issues.get(30)!.labels).toEqual([]);
    const summary = tracker.issues.get(10)!.comments.at(-1)!.body;
    const lines = summary.split("\n").filter((line) => line.startsWith("- Round"));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("Round 1: #10, PR #501: ticket (criterion failed); fix ticket: #20");
    expect(lines[1]).toContain("Round 2: #20, PR #502: ticket (still failing); fix ticket: #30");
    expect(lines[2]).toContain("Round 3: #30, PR #503: needs-human");
    expect(summary).not.toContain("#99");
    expect(tracker.writes.filter((w) => w.startsWith("create"))).toEqual([]);
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]).toMatchObject({ kind: "verifier-alert", priority: "high", ticket: 10 });
    expect(h.merged()).toEqual({ alerted: true, settledAt: NOW.toISOString() });
  });

  it("stops at the first write that fails and records only what landed", async () => {
    const h = harness();
    const watch = makeWatch({ reported: ANNOUNCED, verdict: verdictOf("ticket", "criterion failed") });
    h.tracker.failNext("comment", new Error("rate limited"));
    const result = await reportWatch(watch, storeOf(watch), h.record, h.deps);
    expect(result.error).toBe("settle: rate limited");
    expect(result.wrote).toEqual(["create #11"]);
    expect(h.merged()).toEqual({ fixTicket: 11 });
    expect(h.tracker.issues.get(10)!.comments).toEqual([]);
  });

  it("files the urgent ticket and pushes for a watch decided before it was announced, whatever its ticket refuses", async () => {
    const h = harness();
    // A ticket already Done that refuses every label edit.
    h.tracker.failNext("addLabels", new Error("issue is closed"));
    h.tracker.failNext("removeLabels", new Error("issue is closed"));
    const watch = makeWatch({ verdict: verdictOf("ticket", "hard break", { wouldHaveBeen: "revert" }) });
    const result = await reportWatch(watch, storeOf(watch), h.record, h.deps);
    expect(result.error).toBe("following: issue is closed");
    expect(h.tracker.issues.get(11)!.labels).toEqual(["ready-for-agent", "priority:urgent"]);
    expect(h.pushes).toHaveLength(1);
    // The skipped announce records nothing; the settle ends the watch's writes.
    expect(h.merged()).toEqual({ fixTicket: 11, alerted: true, settledAt: NOW.toISOString() });
    expect(h.tracker.writes.some((w) => w.startsWith("label+ 10"))).toBe(false);
  });

  it("settles a verified watch even when its following label cannot come off", async () => {
    const h = harness();
    h.tracker.put({ number: 10, labels: ["following"] });
    h.tracker.failNext("removeLabels", new Error("rate limited"));
    const watch = makeWatch({ reported: ANNOUNCED, verdict: verdictOf("verified", "fine") });
    const result = await reportWatch(watch, storeOf(watch), h.record, h.deps);
    expect(result.error).toBe("following: rate limited");
    expect(h.tracker.issues.get(10)!.labels).toEqual(["following", "verified"]);
    expect(h.tracker.issues.get(10)!.comments).toHaveLength(1);
    expect(h.merged()).toEqual({ settledAt: NOW.toISOString() });
  });

  it("fails the step by name when the tracker cannot create a label", async () => {
    const h = harness();
    h.tracker.ensureLabels = async (labels) => ({ created: [], missing: [...labels] });
    const watch = makeWatch({ reported: ANNOUNCED, verdict: verdictOf("ticket", "criterion failed") });
    const result = await reportWatch(watch, storeOf(watch), h.record, h.deps);
    expect(result.error).toBe("fix-ticket: label ready-for-agent missing on the tracker");
    expect(h.tracker.writes.filter((w) => w.startsWith("create"))).toEqual([]);
  });

  describe("the fix-ticket marker", () => {
    it("is one word scoped by repo and closed, so neither a longer PR number nor another repo matches it", () => {
      expect(fixMarker("felipearos/loggd", 120)).toBe("verifierfixfelipearosloggdpr120end");
      expect(fixMarker("felipearos/loggd", 1200)).not.toContain(fixMarker("felipearos/loggd", 120));
      expect(fixMarker("Example/Client-PWA", 5)).toBe("verifierfixexampleclientpwapr5end");
    });

    it("does not reuse PR #1200's fix ticket for PR #120", async () => {
      const h = harness();
      await h.tracker.create({ title: "fix", body: `<!-- verifier-fix ${fixMarker("felipearos/loggd", 1200)} root=10 round=1 lineage=10 -->`, labels: [] });
      const watch = makeWatch({ pr: 120, reported: ANNOUNCED, verdict: verdictOf("ticket", "criterion failed") });
      await reportWatch(watch, storeOf(watch), h.record, h.deps);
      expect(h.merged().fixTicket).toBe(12);
      expect(h.tracker.writes.filter((w) => w.startsWith("create"))).toHaveLength(2);
    });

    it("does not reuse another repo's fix ticket for the same PR number", async () => {
      const h = harness();
      await h.tracker.create({ title: "fix", body: `<!-- verifier-fix ${fixMarker("example/client-pwa", 501)} root=10 round=1 lineage=10 -->`, labels: [] });
      const watch = makeWatch({ reported: ANNOUNCED, verdict: verdictOf("ticket", "criterion failed") });
      await reportWatch(watch, storeOf(watch), h.record, h.deps);
      expect(h.merged().fixTicket).toBe(12);
    });
  });

  it("keeps its filing labels equal to the frontier's", () => {
    expect(READY_LABEL).toBe(FRONTIER_READY_LABEL);
    expect(URGENT_LABEL).toBe(FRONTIER_URGENT_LABEL);
  });
});

describe("chainFromRevertComment", () => {
  it("reads the next round of the chain an act revert's reopen comment records", () => {
    const first = makeWatch();
    expect(revertedLine(first)).toBe("<!-- verifier-reverted pr=501 root=10 round=1 lineage=10 -->");
    expect(chainFromRevertComment(`Verifier reverted PR #501.\n\n${revertedLine(first)}`)).toEqual({ root: 10, round: 2, lineage: [10] });
    const second = makeWatch({ pr: 502, ticket: 20, ticketRef: "#20", root: 10, round: 2, lineage: [10] });
    expect(chainFromRevertComment(revertedLine(second))).toEqual({ root: 10, round: 3, lineage: [10, 20] });
  });

  it("refuses a comment that is not one, or whose chain does not hold together", () => {
    expect(chainFromRevertComment("Looks good")).toBeNull();
    expect(chainFromRevertComment("<!-- verifier-reverted pr=501 -->")).toBeNull();
    expect(chainFromRevertComment("<!-- verifier-reverted pr=501 root=10 round=0 lineage=10 -->")).toBeNull();
    expect(chainFromRevertComment("<!-- verifier-reverted pr=501 root=10 round=1 lineage=20,10 -->")).toBeNull();
  });
});

describe("chainFromBody", () => {
  it("gives a round-1 watch's fix ticket round 2 and the root as lineage", async () => {
    const h = harness();
    const watch = makeWatch({ reported: ANNOUNCED, verdict: verdictOf("ticket", "gap") });
    await reportWatch(watch, storeOf(watch), h.record, h.deps);
    expect(chainFromBody(h.tracker.issues.get(11)!.body)).toEqual({ root: 10, round: 2, lineage: [10] });
  });

  it("gives a round-2 watch's fix ticket round 3 and the whole lineage", async () => {
    const tracker = createFakeTracker({ issues: [{ number: 10 }, { number: 20 }] });
    const h = harness("en", tracker);
    const watch = makeWatch({
      pr: 502,
      ticket: 20,
      ticketRef: "#20",
      root: 10,
      round: 2,
      lineage: [10],
      reported: ANNOUNCED,
      verdict: verdictOf("ticket", "gap"),
    });
    await reportWatch(watch, storeOf(watch), h.record, h.deps);
    const body = tracker.issues.get(21)!.body;
    expect(body).toContain("failure round 2");
    expect(chainFromBody(body)).toEqual({ root: 10, round: 3, lineage: [10, 20] });
  });

  it("reads the line in a Spanish body too", async () => {
    const h = harness("es");
    const watch = makeWatch({ reported: ANNOUNCED, verdict: verdictOf("ticket", "falla") });
    await reportWatch(watch, storeOf(watch), h.record, h.deps);
    expect(chainFromBody(h.tracker.issues.get(11)!.body)).toEqual({ root: 10, round: 2, lineage: [10] });
  });

  it.each([
    ["no line", "just a ticket"],
    ["a malformed lineage", "<!-- verifier-fix verifierfix5 root=10 round=1 lineage=10,,x -->"],
    ["a missing round", "<!-- verifier-fix verifierfix5 root=10 lineage=10 -->"],
    ["round zero", "<!-- verifier-fix verifierfix5 root=10 round=0 lineage=10 -->"],
    ["a lineage not starting at the root", "<!-- verifier-fix verifierfix5 root=10 round=1 lineage=7 -->"],
  ])("returns null for %s", (_, body) => {
    expect(chainFromBody(body)).toBeNull();
  });
});
