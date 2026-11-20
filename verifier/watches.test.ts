// @vitest-environment node
/**
 * The verifier's watch store (felipearos/ralph#563): check-ins are timed from
 * the deploy, a PR is watched once, and a store that cannot be read is
 * refused rather than overwritten with an empty one.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { scratchDir } from "../test-scratch";
import {
  CHECK_IN_LEASE_SECONDS,
  checkInKey,
  checkInSchedule,
  dueCheckIns,
  emptyStore,
  markReported,
  moreCheckInsAfter,
  openWatches,
  readStore,
  recordDecision,
  recordedAcceptance,
  recordEvidence,
  rootOf,
  takeCheckInLease,
  withStore,
  type CheckInDecision,
  type CheckInEvidence,
  type Holder,
  type Lease,
  type WatchCandidate,
  type WatchStore,
} from "./watches";

const candidate = (pr: number): WatchCandidate => ({
  pr,
  ticket: 184,
  ticketRef: "#184",
  mergeCommit: "abc123",
  mergedAt: "2026-10-29T10:00:00.000Z",
  deployId: `dpl_${pr}`,
  deployedAt: "2026-10-29T10:05:00.000Z",
  deployUrl: "app-xyz.vercel.app",
  mode: "observe",
});

const NOW = new Date("2026-10-29T10:06:00.000Z");

describe("checkInSchedule", () => {
  it("dues each check-in at the deploy time plus its offset", () => {
    expect(checkInSchedule("2026-10-29T10:05:00.000Z", [1, 6, 24])).toEqual([
      { offsetHours: 1, dueAt: "2026-10-29T11:05:00.000Z", result: null },
      { offsetHours: 6, dueAt: "2026-10-29T16:05:00.000Z", result: null },
      { offsetHours: 24, dueAt: "2026-10-30T10:05:00.000Z", result: null },
    ]);
  });
});

describe("openWatches", () => {
  it("opens a first watch at round 1 with an empty lineage", () => {
    const store = emptyStore();
    const added = openWatches(store, [candidate(7)], [1], NOW);
    expect(added).toHaveLength(1);
    expect(store.watches["7"]).toMatchObject({ pr: 7, round: 1, lineage: [], verdict: null, openedAt: NOW.toISOString() });
  });

  it("opens with no root and nothing reported, and keeps a fix ticket's root", () => {
    const store = emptyStore();
    openWatches(store, [candidate(7), { ...candidate(8), ticket: 190, root: 184, round: 2, lineage: [184] }], [1], NOW);
    expect(store.watches["7"]).toMatchObject({ root: null, reported: {} });
    expect(rootOf(store.watches["7"]!)).toBe(184);
    expect(store.watches["8"]).toMatchObject({ root: 184, round: 2, lineage: [184], reported: {} });
    expect(rootOf(store.watches["8"]!)).toBe(184);
  });

  it("re-opening the same PR is a no-op", () => {
    const store = emptyStore();
    openWatches(store, [candidate(7)], [1], NOW);
    const before = structuredClone(store);
    const added = openWatches(store, [candidate(7), candidate(7)], [1, 6], new Date("2026-10-29T12:00:00.000Z"));
    expect(added).toEqual([]);
    expect(store).toEqual(before);
  });
});

describe("the store file", () => {
  it("round-trips through withStore and readStore", async () => {
    const path = join(scratchDir("ralph-verifier-watches-"), "ralph", "verifier-watches.json");
    expect(readStore(path)).toEqual(emptyStore());
    const added = await withStore(path, (store) => openWatches(store, [candidate(7)], [1, 6, 24], NOW));
    expect(added).toHaveLength(1);
    expect(readStore(path).watches["7"]).toEqual(added[0]);
  });

  it("refuses to overwrite an unreadable file, and reports it as empty", async () => {
    const path = join(scratchDir("ralph-verifier-watches-"), "verifier-watches.json");
    for (const content of ["{not json", JSON.stringify({ version: 99, watches: { "7": {} } })]) {
      writeFileSync(path, content);
      expect(readStore(path)).toEqual(emptyStore());
      await expect(withStore(path, (store) => openWatches(store, [candidate(8)], [1], NOW))).rejects.toThrow(/unreadable/);
      expect(readFileSync(path, "utf8")).toBe(content);
    }
  });

  it("lands two concurrent writes, one after the other under the lock", async () => {
    const path = join(scratchDir("ralph-verifier-watches-"), "verifier-watches.json");
    await Promise.all([
      withStore(path, (store) => openWatches(store, [candidate(1)], [1], NOW)),
      withStore(path, (store) => openWatches(store, [candidate(2)], [1], NOW)),
    ]);
    expect(Object.keys(readStore(path).watches).sort()).toEqual(["1", "2"]);
  });
});

describe("an old store", () => {
  it("loads with no leases key and keeps its watches", async () => {
    const path = join(scratchDir("ralph-verifier-watches-"), "verifier-watches.json");
    const store = emptyStore();
    openWatches(store, [candidate(7)], [1], NOW);
    writeFileSync(path, JSON.stringify({ version: 1, watches: store.watches }));
    expect(readStore(path)).toEqual({ version: 1, watches: store.watches, leases: {} });
    await withStore(path, (s) => openWatches(s, [candidate(8)], [1], NOW));
    const written = JSON.parse(readFileSync(path, "utf8")) as WatchStore;
    expect(Object.keys(written.watches).sort()).toEqual(["7", "8"]);
    expect(written.leases).toEqual({});
  });

  it("reads a watch written before root and reported as its own root with nothing reported", async () => {
    const path = join(scratchDir("ralph-verifier-watches-"), "verifier-watches.json");
    const store = emptyStore();
    openWatches(store, [candidate(7)], [1], NOW);
    const { root: _root, reported: _reported, ...legacy } = store.watches["7"]!;
    writeFileSync(path, JSON.stringify({ version: 1, watches: { "7": legacy }, leases: {} }));
    expect(readStore(path).watches["7"]).toEqual(store.watches["7"]);
    await withStore(path, (s) => { markReported(s, 7, { alerted: true }); });
    expect((JSON.parse(readFileSync(path, "utf8")) as WatchStore).watches["7"]).toMatchObject({ root: null, reported: { alerted: true } });
  });
});

const evidence = (pr: number): CheckInEvidence => ({
  gatheredAt: "2026-10-29T11:06:00.000Z",
  health: { reachable: true, issues: [] },
  traffic: { reachable: true, hits: 12 },
  pr: { number: pr, files: ["app/page.tsx"], routes: ["/"] },
  otherPrs: [],
});

const decision = (verdict: CheckInDecision["verdict"], over: Partial<CheckInDecision> = {}): CheckInDecision => ({
  decidedAt: "2026-10-29T11:10:00.000Z",
  verdict,
  reason: `it is ${verdict}`,
  act: true,
  priority: "normal",
  ...over,
});

const at = (iso: string): Date => new Date(iso);

/** PR 7 deployed 10:05 with check-ins at +1h (11:05) and +6h (16:05). */
function watched(...prs: number[]): WatchStore {
  const store = emptyStore();
  openWatches(store, prs.map(candidate), [1, 6], NOW);
  return store;
}

describe("dueCheckIns", () => {
  it("lists nothing before the first check-in is due", () => {
    expect(dueCheckIns(watched(7), at("2026-10-29T11:04:59.000Z"))).toEqual([]);
  });

  it("lists a due check-in", () => {
    const due = dueCheckIns(watched(7), at("2026-10-29T11:05:00.000Z"));
    expect(due.map((d) => [d.watch.pr, d.checkIn.offsetHours])).toEqual([[7, 1]]);
  });

  it("lists only the earliest undecided check-in of each watch, by due time then PR", () => {
    const store = watched(9, 7);
    store.watches["9"]!.checkIns[0]!.dueAt = "2026-10-29T09:00:00.000Z";
    const due = dueCheckIns(store, at("2026-10-29T20:00:00.000Z"));
    expect(due.map((d) => [d.watch.pr, d.checkIn.offsetHours])).toEqual([[9, 1], [7, 1]]);
    store.watches["9"]!.checkIns[0]!.dueAt = store.watches["7"]!.checkIns[0]!.dueAt;
    expect(dueCheckIns(store, at("2026-10-29T20:00:00.000Z")).map((d) => d.watch.pr)).toEqual([7, 9]);
  });

  it("moves on to the next check-in once one is decided, and skips a watch with a verdict", () => {
    const store = watched(7, 8);
    recordEvidence(store, 7, 1, evidence(7), at("2026-10-29T11:06:00.000Z"));
    recordDecision(store, 7, 1, decision("pending"));
    recordEvidence(store, 8, 1, evidence(8), at("2026-10-29T11:06:00.000Z"));
    recordDecision(store, 8, 1, decision("verified"));
    expect(dueCheckIns(store, at("2026-10-29T12:00:00.000Z"))).toEqual([]);
    const due = dueCheckIns(store, at("2026-10-29T17:00:00.000Z"));
    expect(due.map((d) => [d.watch.pr, d.checkIn.offsetHours])).toEqual([[7, 6]]);
  });

  it("still lists a check-in with evidence but no decision — its session may have died", () => {
    const store = watched(7);
    recordEvidence(store, 7, 1, evidence(7), at("2026-10-29T11:06:00.000Z"));
    expect(dueCheckIns(store, at("2026-10-29T12:00:00.000Z"))).toHaveLength(1);
  });
});

describe("recordEvidence", () => {
  it("overwrites an undecided result", () => {
    const store = watched(7);
    recordEvidence(store, 7, 1, evidence(7), at("2026-10-29T11:06:00.000Z"));
    const again = { ...evidence(7), gatheredAt: "2026-10-29T11:30:00.000Z" };
    recordEvidence(store, 7, 1, again, at("2026-10-29T11:30:00.000Z"));
    expect(store.watches["7"]!.checkIns[0]!.result).toEqual({
      handedOverAt: "2026-10-29T11:30:00.000Z",
      evidence: again,
      decision: null,
    });
  });

  it("refuses a decided check-in, and an unknown PR or offset", () => {
    const store = watched(7);
    recordEvidence(store, 7, 1, evidence(7), at("2026-10-29T11:06:00.000Z"));
    recordDecision(store, 7, 1, decision("pending"));
    expect(() => recordEvidence(store, 7, 1, evidence(7), at("2026-10-29T11:30:00.000Z"))).toThrow(/already decided/);
    expect(() => recordEvidence(store, 99, 1, evidence(99), NOW)).toThrow(/no verifier watch/);
    expect(() => recordEvidence(store, 7, 3, evidence(7), NOW)).toThrow(/no \+3h check-in/);
  });
});

describe("recordDecision", () => {
  const decide = (offsetHours: number, d: CheckInDecision) => {
    const store = watched(7);
    for (const checkIn of store.watches["7"]!.checkIns) {
      if (checkIn.offsetHours > offsetHours) break;
      recordEvidence(store, 7, checkIn.offsetHours, evidence(7), NOW);
      recordDecision(store, 7, checkIn.offsetHours, checkIn.offsetHours === offsetHours ? d : decision("pending"));
    }
    return store.watches["7"]!;
  };

  it("keeps the watch open on pending at +1h", () => {
    expect(decide(1, decision("pending")).verdict).toBeNull();
  });

  it("keeps the watch open on inconclusive while a check-in remains", () => {
    const watch = decide(1, decision("inconclusive"));
    expect(watch.verdict).toBeNull();
    expect(watch.checkIns[0]!.result!.decision!.verdict).toBe("inconclusive");
  });

  it("ends the watch on inconclusive at the last check-in", () => {
    expect(decide(6, decision("inconclusive")).verdict).toMatchObject({ verdict: "inconclusive", offsetHours: 6 });
  });

  it("ends the watch on verified at the last check-in", () => {
    expect(decide(6, decision("verified")).verdict).toEqual({
      verdict: "verified",
      reason: "it is verified",
      act: true,
      offsetHours: 6,
      decidedAt: "2026-10-29T11:10:00.000Z",
    });
  });

  it("ends the watch as revert at +1h when the mode held the revert back", () => {
    const watch = decide(1, decision("revert", { act: false, wouldHaveBeen: "revert" }));
    expect(watch.verdict).toMatchObject({ verdict: "revert", act: false, wouldHaveBeen: "revert", offsetHours: 1 });
  });

  it("refuses pending at the last check-in, a check-in with no evidence, and a second decision", () => {
    const store = watched(7);
    expect(() => recordDecision(store, 7, 1, decision("pending"))).toThrow(/no evidence/);
    recordEvidence(store, 7, 1, evidence(7), NOW);
    recordDecision(store, 7, 1, decision("pending"));
    expect(() => recordDecision(store, 7, 1, decision("verified"))).toThrow(/already decided/);
    recordEvidence(store, 7, 6, evidence(7), NOW);
    expect(() => recordDecision(store, 7, 6, decision("pending"))).toThrow(/last one/);
    expect(store.watches["7"]!.checkIns[1]!.result!.decision).toBeNull();
  });

  it("knows whether more check-ins follow", () => {
    const watch = watched(7).watches["7"]!;
    expect(moreCheckInsAfter(watch, 1)).toBe(true);
    expect(moreCheckInsAfter(watch, 6)).toBe(false);
  });
});

describe("the acceptance record (#566)", () => {
  const results = [{ criterion: "logs in", result: "passed" as const, evidence: "shots/login.png" }];

  it("is null until a decided check-in records one", () => {
    const store = watched(7);
    expect(recordedAcceptance(store.watches["7"]!)).toBeNull();
    recordEvidence(store, 7, 1, evidence(7), NOW);
    recordDecision(store, 7, 1, decision("pending"));
    expect(recordedAcceptance(store.watches["7"]!)).toBeNull();
    expect(store.watches["7"]!.checkIns[0]!.result).not.toHaveProperty("acceptance");
  });

  it("stores results with the decision and reports where they were recorded", () => {
    const store = watched(7);
    recordEvidence(store, 7, 1, evidence(7), NOW);
    recordDecision(store, 7, 1, decision("pending"), { results });
    expect(store.watches["7"]!.checkIns[0]!.result!.acceptance).toEqual(results);
    expect(recordedAcceptance(store.watches["7"]!)).toEqual({ results, offsetHours: 1 });
  });

  it("stores an inconclusive reason apart from the results", () => {
    const store = watched(7);
    recordEvidence(store, 7, 1, evidence(7), NOW);
    recordDecision(store, 7, 1, decision("pending"), { inconclusive: "sign-in failed" });
    const result = store.watches["7"]!.checkIns[0]!.result!;
    expect(result.acceptanceInconclusive).toBe("sign-in failed");
    expect(result.acceptance).toBeUndefined();
    expect(recordedAcceptance(store.watches["7"]!)).toEqual({ inconclusive: "sign-in failed", offsetHours: 1 });
  });

  it("refuses a second record on a later check-in, writing no decision", () => {
    const store = watched(7);
    recordEvidence(store, 7, 1, evidence(7), NOW);
    recordDecision(store, 7, 1, decision("pending"), { results });
    recordEvidence(store, 7, 6, evidence(7), NOW);
    expect(() => recordDecision(store, 7, 6, decision("verified"), { results })).toThrow(/already recorded at \+1h/);
    expect(store.watches["7"]!.checkIns[1]!.result!.decision).toBeNull();
    expect(store.watches["7"]!.checkIns[1]!.result!.acceptance).toBeUndefined();
  });
});

describe("takeCheckInLease", () => {
  const T0 = Date.parse("2026-10-29T11:06:00.000Z");
  const RALPH: Holder = { run: "run-a", loop: "ralph", pid: 4242, host: "fedora" };
  const RAFA: Holder = { run: "run-b", loop: "rafa", pid: 4343, host: "fedora" };
  const KEY = checkInKey(7, 1);
  const living = () => true;
  const dead = () => false;
  const storeFile = () => join(scratchDir("ralph-verifier-lease-"), "ralph", "verifier-watches.json");
  const leaseFor = (holder: Holder, expiresAtMs: number): Lease => ({
    run: holder.run,
    loop: holder.loop,
    pid: holder.pid!,
    host: holder.host!,
    expiresAt: new Date(expiresAtMs).toISOString(),
  });
  const seed = (path: string, lease: Lease) => withStore(path, (store) => { store.leases[KEY] = lease; });

  it("keys a check-in by PR and offset", () => {
    expect(KEY).toBe("7@1");
  });

  it("hands one check-in to exactly one of two racing holders", async () => {
    const path = storeFile();
    const results = await Promise.all([
      takeCheckInLease(path, KEY, RALPH, { nowMs: T0, alive: living }),
      takeCheckInLease(path, KEY, RAFA, { nowMs: T0, alive: living }),
    ]);
    expect(results.filter((r) => r.taken)).toHaveLength(1);
    const winner = results.find((r) => r.taken)!.holder!;
    expect(results.find((r) => !r.taken)!.holder).toEqual(winner);
    expect(readStore(path).leases[KEY]).toEqual({ ...winner, expiresAt: new Date(T0 + CHECK_IN_LEASE_SECONDS * 1000).toISOString() });
  });

  it("retakes an expired lease", async () => {
    const path = storeFile();
    await seed(path, leaseFor(RAFA, T0 - 1));
    expect((await takeCheckInLease(path, KEY, RALPH, { nowMs: T0, alive: living })).taken).toBe(true);
    expect(readStore(path).leases[KEY]).toMatchObject({ run: "run-a", loop: "ralph" });
  });

  it("retakes a dead holder's lease before it expires", async () => {
    const path = storeFile();
    await seed(path, leaseFor(RAFA, T0 + 60_000));
    expect((await takeCheckInLease(path, KEY, RALPH, { nowMs: T0, alive: living })).taken).toBe(false);
    expect((await takeCheckInLease(path, KEY, RALPH, { nowMs: T0, alive: dead })).taken).toBe(true);
  });

  it("re-takes the holder's own lease and pushes its expiry out", async () => {
    const path = storeFile();
    await seed(path, leaseFor(RALPH, T0 + 10_000));
    expect((await takeCheckInLease(path, KEY, RALPH, { nowMs: T0, alive: living })).taken).toBe(true);
    expect(readStore(path).leases[KEY]!.expiresAt).toBe(new Date(T0 + CHECK_IN_LEASE_SECONDS * 1000).toISOString());
  });
});

describe("markReported", () => {
  it("merges each write into what was already reported", () => {
    const store = emptyStore();
    openWatches(store, [candidate(7)], [1], NOW);
    markReported(store, 7, { announcedAt: "2026-10-29T10:07:00.000Z" });
    const watch = markReported(store, 7, { fixTicket: 190, alerted: true });
    expect(watch.reported).toEqual({ announcedAt: "2026-10-29T10:07:00.000Z", fixTicket: 190, alerted: true });
    expect(store.watches["7"]!.reported).toEqual(watch.reported);
  });

  it("throws on a PR with no watch", () => {
    expect(() => markReported(emptyStore(), 7, { alerted: true })).toThrow(/no verifier watch for PR #7/);
  });
});
