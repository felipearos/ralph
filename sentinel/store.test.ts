// @vitest-environment node
/**
 * The sentinel's issue store (felipearos/ralph#681): an issue seen again keeps
 * its progress, one issue is leased to one session, a drafted one is never
 * leased again, and a store that cannot be read is refused rather than
 * overwritten with an empty one.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Candidate, Evidence } from "../reporter/types";
import { scratchDir } from "../test-scratch";
import {
  confirmComment,
  doubled,
  emptyStore,
  ensureBaseline,
  filedOn,
  handled,
  issueKey,
  loadStore,
  markCapAlerted,
  markChecked,
  readStore,
  recordCandidate,
  recordDraft,
  recordFiled,
  recordHandover,
  RECURRENCE_COMMENTS_KEPT,
  releaseComment,
  reopenRecord,
  reserveComment,
  takeIssueLease,
  ticketNumberOf,
  utcDay,
  withStore,
  type Holder,
  type IssueRecord,
  type Lease,
  type RecurrenceComment,
} from "./store";

const NOW = new Date("2026-11-04T10:00:00.000Z");
const LATER = new Date("2026-11-04T11:00:00.000Z");
const T0 = NOW.getTime();

const candidate = (id: string, events = 5): Candidate => ({
  id,
  title: "TypeError: x is undefined",
  culprit: "app/page.tsx",
  level: "error",
  status: "unresolved",
  regressed: false,
  firstSeen: "2026-11-03T10:00:00.000Z",
  lastSeen: "2026-11-04T09:00:00.000Z",
  events,
  users: 2,
  permalink: `https://sentry.example/issues/${id}`,
});

const evidence = (id: string): Evidence => ({
  issueId: id,
  release: "abc123",
  environment: "production",
  frames: [],
  framesOmitted: 0,
  tags: {},
  breadcrumbs: [],
  breadcrumbsOmitted: 0,
});

const draft = { title: "Fix TypeError on page", body: "…", at: LATER.toISOString() };

const RALPH: Holder = { run: "run-1", loop: "ralph", pid: 111, host: "box" };
const RAFA: Holder = { run: "run-2", loop: "rafa", pid: 222, host: "box" };
const living = () => true;
const dead = () => false;

const storeIn = (): string => join(scratchDir("sentinel-store-"), "ralph", "sentinel-issues.json");

describe("issueKey", () => {
  it("joins the reporter and its issue id", () => {
    expect(issueKey("sentry", "123")).toBe("sentry:123");
  });
});

describe("recordCandidate", () => {
  it("records a new issue as observed with no attempts", () => {
    const store = emptyStore();
    const record = recordCandidate(store, "sentry", candidate("1"), "observe", NOW);
    expect(record).toMatchObject({ reporter: "sentry", id: "1", state: "observed", attempts: 0, evidence: null, ticket: null, draft: null, mode: "observe" });
    expect(record.observedAt).toBe(NOW.toISOString());
    expect(store.issues["sentry:1"]).toBe(record);
  });

  it("refreshes only the candidate and updatedAt on a second sighting", () => {
    const store = emptyStore();
    recordCandidate(store, "sentry", candidate("1"), "observe", NOW);
    recordHandover(store, "sentry:1", evidence("1"), "observe", NOW);
    recordDraft(store, "sentry:1", draft, "observe", NOW);
    const again = recordCandidate(store, "sentry", candidate("1", 40), "file", LATER);
    expect(again).toMatchObject({ state: "drafted", attempts: 1, mode: "observe", observedAt: NOW.toISOString(), updatedAt: LATER.toISOString() });
    expect(again.candidate.events).toBe(40);
  });
});

describe("recordHandover and recordDraft", () => {
  it("stores the evidence and counts each handover", () => {
    const store = emptyStore();
    recordCandidate(store, "sentry", candidate("1"), "observe", NOW);
    recordHandover(store, "sentry:1", evidence("1"), "observe", NOW);
    const record = recordHandover(store, "sentry:1", evidence("1"), "observe", LATER);
    expect(record.attempts).toBe(2);
    expect(record.evidence?.issueId).toBe("1");
  });

  it("records the mode the attempt was made in", () => {
    const store = emptyStore();
    recordCandidate(store, "sentry", candidate("1"), "observe", NOW);
    expect(recordHandover(store, "sentry:1", evidence("1"), "file", LATER).mode).toBe("file");
  });

  it("refuses an unknown key", () => {
    expect(() => recordHandover(emptyStore(), "sentry:9", evidence("9"), "observe", NOW)).toThrow(/no sentinel issue record/);
    expect(() => recordDraft(emptyStore(), "sentry:9", draft, "observe", NOW)).toThrow(/no sentinel issue record/);
  });

  it("stores the draft, marks it drafted and frees the lease", async () => {
    const path = storeIn();
    await withStore(path, (store) => { recordCandidate(store, "sentry", candidate("1"), "observe", NOW); });
    expect((await takeIssueLease(path, "sentry:1", RALPH, { nowMs: T0, alive: living })).taken).toBe(true);
    await withStore(path, (store) => { recordDraft(store, "sentry:1", draft, "file", LATER); });
    const store = readStore(path);
    expect(store.issues["sentry:1"]).toMatchObject({ state: "drafted", draft, mode: "file", updatedAt: LATER.toISOString() });
    expect(handled(store.issues["sentry:1"]!)).toBe(true);
    expect(store.leases["sentry:1"]).toBeUndefined();
  });

  it("refuses to redraft a filed issue", () => {
    const store = emptyStore();
    recordCandidate(store, "sentry", candidate("1"), "file", NOW).state = "filed";
    expect(() => recordDraft(store, "sentry:1", draft, "file", NOW)).toThrow(/already filed/);
  });
});

describe("recordFiled and the day ledger", () => {
  const DAY = utcDay(LATER);

  it("marks the issue filed, frees its lease and counts the day", async () => {
    const path = storeIn();
    await withStore(path, (store) => {
      recordCandidate(store, "sentry", candidate("1"), "file", NOW);
      recordDraft(store, "sentry:1", draft, "file", NOW);
    });
    expect((await takeIssueLease(path, "sentry:1", RALPH, { nowMs: T0, alive: living, allowDrafted: true })).taken).toBe(true);
    await withStore(path, (store) => { recordFiled(store, "sentry:1", { ticket: "#42", number: 42, draft: null, adopted: false }, "file", LATER); });
    const store = readStore(path);
    expect(store.issues["sentry:1"]).toMatchObject({ state: "filed", ticket: "#42", draft, mode: "file", updatedAt: LATER.toISOString() });
    expect(store.leases["sentry:1"]).toBeUndefined();
    expect(DAY).toBe("2026-11-04");
    expect(filedOn(store, DAY)).toBe(1);
  });

  it("replaces the draft only when given one", () => {
    const store = emptyStore();
    recordCandidate(store, "sentry", candidate("1"), "file", NOW);
    const templated = { title: "Templated", body: "…", at: LATER.toISOString() };
    expect(recordFiled(store, "sentry:1", { ticket: "#7", number: 7, draft: templated, adopted: false }, "file", LATER).draft).toEqual(templated);
  });

  it("does not count an adopted ticket against the day", () => {
    const store = emptyStore();
    recordCandidate(store, "sentry", candidate("1"), "file", NOW);
    recordFiled(store, "sentry:1", { ticket: "#42", number: 42, draft: draft, adopted: true }, "file", LATER);
    expect(store.issues["sentry:1"]!.state).toBe("filed");
    expect(filedOn(store, DAY)).toBe(0);
  });

  it("refuses to file an issue twice, and an unknown one", () => {
    const store = emptyStore();
    recordCandidate(store, "sentry", candidate("1"), "file", NOW);
    recordFiled(store, "sentry:1", { ticket: "#42", number: 42, draft: null, adopted: false }, "file", LATER);
    expect(() => recordFiled(store, "sentry:1", { ticket: "#43", number: 43, draft: null, adopted: false }, "file", LATER)).toThrow(/already filed/);
    expect(store.issues["sentry:1"]!.ticket).toBe("#42");
    expect(filedOn(store, DAY)).toBe(1);
    expect(() => recordFiled(store, "sentry:9", { ticket: "#1", number: 1, draft: null, adopted: false }, "file", LATER)).toThrow(/no sentinel issue record/);
  });

  it("alerts about the cap once a day", () => {
    const store = emptyStore();
    expect(markCapAlerted(store, DAY)).toBe(true);
    expect(markCapAlerted(store, DAY)).toBe(false);
    expect(markCapAlerted(store, "2026-11-05")).toBe(true);
  });

  it("reads a malformed day entry as an empty day and replaces it on write, never a throw", () => {
    const store = emptyStore();
    (store.days as Record<string, unknown>)[DAY] = { filed: "3", alerted: "yes" };
    (store.days as Record<string, unknown>)["2026-11-05"] = null;
    expect(filedOn(store, DAY)).toBe(0);
    expect(filedOn(store, "2026-11-05")).toBe(0);
    recordCandidate(store, "sentry", candidate("1"), "file", NOW);
    recordFiled(store, "sentry:1", { ticket: "#42", number: 42, draft: null, adopted: false }, "file", LATER);
    expect(store.days[DAY]).toEqual({ filed: 1, alerted: false });
    expect(markCapAlerted(store, "2026-11-05")).toBe(true);
    expect(store.days["2026-11-05"]).toEqual({ filed: 0, alerted: true });
  });

  it("drops days older than 14 days whenever it writes one", () => {
    const store = emptyStore();
    store.days["2026-10-20"] = { filed: 3, alerted: true };
    store.days["2026-10-21"] = { filed: 2, alerted: false };
    store.days["2026-11-03"] = { filed: 1, alerted: false };
    recordCandidate(store, "sentry", candidate("1"), "file", NOW);
    recordFiled(store, "sentry:1", { ticket: "#42", number: 42, draft: null, adopted: false }, "file", NOW);
    expect(Object.keys(store.days).sort()).toEqual(["2026-10-21", "2026-11-03", "2026-11-04"]);
    markCapAlerted(store, "2026-11-05");
    expect(Object.keys(store.days).sort()).toEqual(["2026-11-03", "2026-11-04", "2026-11-05"]);
  });
});

describe("takeIssueLease", () => {
  const KEY = "sentry:1";
  const leaseFor = (holder: Holder, expiresAtMs: number): Lease => ({
    run: holder.run,
    loop: holder.loop,
    pid: holder.pid!,
    host: holder.host!,
    expiresAt: new Date(expiresAtMs).toISOString(),
  });
  const seed = (path: string, lease: Lease) => withStore(path, (store) => { store.leases[KEY] = lease; });

  it("gives one issue to exactly one of two racing holders", async () => {
    const path = storeIn();
    const results = await Promise.all([
      takeIssueLease(path, KEY, RALPH, { nowMs: T0, alive: living }),
      takeIssueLease(path, KEY, RAFA, { nowMs: T0, alive: living }),
    ]);
    expect(results.filter((result) => result.taken)).toHaveLength(1);
    const loser = results.find((result) => !result.taken)!;
    const winner = results.find((result) => result.taken)!;
    expect(loser.holder).toEqual(winner.holder);
  });

  it("re-takes an expired lease", async () => {
    const path = storeIn();
    await seed(path, leaseFor(RAFA, T0 - 1));
    expect((await takeIssueLease(path, KEY, RALPH, { nowMs: T0, alive: living })).taken).toBe(true);
  });

  it("re-takes a live lease only once its holder is dead", async () => {
    const path = storeIn();
    await seed(path, leaseFor(RAFA, T0 + 60_000));
    expect((await takeIssueLease(path, KEY, RALPH, { nowMs: T0, alive: living })).taken).toBe(false);
    expect((await takeIssueLease(path, KEY, RALPH, { nowMs: T0, alive: dead })).taken).toBe(true);
  });

  it("lets the same run and loop re-take its own lease", async () => {
    const path = storeIn();
    await seed(path, leaseFor(RALPH, T0 + 60_000));
    expect((await takeIssueLease(path, KEY, { ...RALPH, pid: 999 }, { nowMs: T0, alive: living })).taken).toBe(true);
  });

  it("refuses a drafted issue even with no lease on it", async () => {
    const path = storeIn();
    await withStore(path, (store) => {
      recordCandidate(store, "sentry", candidate("1"), "observe", NOW);
      recordDraft(store, KEY, draft, "observe", NOW);
    });
    expect(await takeIssueLease(path, KEY, RALPH, { nowMs: T0, alive: living })).toEqual({ taken: false, holder: null });
    expect(readStore(path).leases[KEY]).toBeUndefined();
  });

  it("leases a drafted issue with allowDrafted, but never a filed one", async () => {
    const path = storeIn();
    await withStore(path, (store) => {
      recordCandidate(store, "sentry", candidate("1"), "file", NOW);
      recordDraft(store, KEY, draft, "file", NOW);
      recordCandidate(store, "sentry", candidate("2"), "file", NOW);
      recordFiled(store, "sentry:2", { ticket: "#42", number: 42, draft: null, adopted: false }, "file", NOW);
    });
    expect((await takeIssueLease(path, KEY, RALPH, { nowMs: T0, alive: living, allowDrafted: true })).taken).toBe(true);
    expect(readStore(path).leases[KEY]?.run).toBe(RALPH.run);
    expect(await takeIssueLease(path, "sentry:2", RALPH, { nowMs: T0, alive: living, allowDrafted: true })).toEqual({ taken: false, holder: null });
    expect(readStore(path).leases["sentry:2"]).toBeUndefined();
  });
});

describe("the file", () => {
  it("reads a missing or empty file as an empty store", () => {
    const path = storeIn();
    expect(readStore(path)).toEqual(emptyStore());
    const empty = join(scratchDir("sentinel-store-"), "empty.json");
    writeFileSync(empty, "");
    expect(readStore(empty)).toEqual(emptyStore());
  });

  it("reads a store written before the day ledger as one with no days", () => {
    const path = join(scratchDir("sentinel-store-"), "sentinel-issues.json");
    writeFileSync(path, JSON.stringify({ version: 1, issues: {}, leases: {} }));
    const loaded = loadStore(path);
    expect(loaded.kind).toBe("ok");
    expect(loaded.kind === "ok" ? loaded.store.days : null).toEqual({});
  });

  it("refuses a day ledger that is not an object", () => {
    const path = join(scratchDir("sentinel-store-"), "sentinel-issues.json");
    writeFileSync(path, JSON.stringify({ version: 1, issues: {}, leases: {}, days: [] }));
    expect(loadStore(path)).toEqual({ kind: "unreadable", why: "'days' is not an object" });
  });

  it("refuses to overwrite an unreadable store and leaves it as it was", async () => {
    const path = join(scratchDir("sentinel-store-"), "sentinel-issues.json");
    writeFileSync(path, "{ not json");
    await expect(withStore(path, (store) => { recordCandidate(store, "sentry", candidate("1"), "observe", NOW); }))
      .rejects.toThrow(/sentinel issue store .* is unreadable/);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });
});

describe("recurrences", () => {
  const filedRecord = (store = emptyStore(), events = 12): IssueRecord => {
    recordCandidate(store, "sentry", candidate("1", events), "file", NOW);
    return recordFiled(store, "sentry:1", { ticket: "#42", number: 42, draft: null, adopted: false }, "file", NOW);
  };
  const comment = (events: number, at = LATER.toISOString()): RecurrenceComment => ({
    at, events, users: 3, lastSeen: at, release: null, body: `seen ${events}`, posted: true,
  });

  it("reads a record written before recurrences: number from the ref, baseline set on first check", () => {
    const store = emptyStore();
    const old = recordCandidate(store, "sentry", candidate("1", 9), "file", NOW);
    Object.assign(old, { state: "filed", ticket: "AND-12" });
    expect(old.recurrence).toBeUndefined();
    expect(ticketNumberOf(old)).toBe(12);
    expect(ticketNumberOf({ ...old, ticket: "#7" })).toBe(7);
    expect(ticketNumberOf({ ...old, ticket: "none" })).toBeNull();
    expect(ticketNumberOf({ ...old, ticket: null })).toBeNull();
    expect(ticketNumberOf({ ...old, ticket: "#7", ticketNumber: 70 })).toBe(70);
    expect(ensureBaseline(store, "sentry:1", 30)).toEqual({ baseline: 30, commentedOn: null, checkedAt: null, comments: [] });
    // Already there: the baseline is not moved by a later count.
    expect(ensureBaseline(store, "sentry:1", 99).baseline).toBe(30);
    expect(() => ensureBaseline(store, "sentry:9", 1)).toThrow(/no sentinel issue record/);
  });

  it("recordFiled stores the number and the filing count as the baseline", () => {
    const record = filedRecord();
    expect(record.ticketNumber).toBe(42);
    expect(ticketNumberOf(record)).toBe(42);
    expect(record.recurrence).toEqual({ baseline: 12, commentedOn: null, checkedAt: null, comments: [] });
  });

  it("reserves one comment a day, rolls back only its own day, and keeps the last ten", () => {
    const store = emptyStore();
    filedRecord(store);
    expect(reserveComment(store, "sentry:1", "2026-11-04")).toBeNull();
    expect(reserveComment(store, "sentry:1", "2026-11-04")).toBe(false);
    releaseComment(store, "sentry:1", "2026-11-03", "2026-11-01");
    expect(store.issues["sentry:1"]!.recurrence!.commentedOn).toBe("2026-11-04");
    releaseComment(store, "sentry:1", "2026-11-04", null);
    expect(store.issues["sentry:1"]!.recurrence!.commentedOn).toBeNull();

    expect(reserveComment(store, "sentry:1", "2026-11-04")).toBeNull();
    expect(confirmComment(store, "sentry:1", comment(25)).baseline).toBe(25);
    expect(reserveComment(store, "sentry:1", "2026-11-05")).toBe("2026-11-04");
    for (let n = 0; n < 12; n++) confirmComment(store, "sentry:1", comment(100 + n));
    const kept = store.issues["sentry:1"]!.recurrence!.comments;
    expect(kept).toHaveLength(RECURRENCE_COMMENTS_KEPT);
    expect(kept[0]!.events).toBe(102);
    expect(kept.at(-1)!.events).toBe(111);
    expect(() => reserveComment(store, "sentry:9", "2026-11-04")).toThrow(/no sentinel issue record/);
  });

  it("marks when the ticket was last checked", () => {
    const store = emptyStore();
    recordCandidate(store, "sentry", candidate("1", 4), "file", NOW);
    expect(markChecked(store, "sentry:1", LATER)).toEqual({ baseline: 4, commentedOn: null, checkedAt: LATER.toISOString(), comments: [] });
  });

  it("reopens a filed record as a new cycle and drops its lease", async () => {
    const path = storeIn();
    await withStore(path, (store) => { filedRecord(store); });
    await withStore(path, (store) => {
      // A lease left on the key, as a gate filing it would hold one.
      store.leases["sentry:1"] = { ...RALPH, pid: 1, host: "h", expiresAt: LATER.toISOString() };
      confirmComment(store, "sentry:1", comment(30));
      reopenRecord(store, "sentry:1", LATER, 30);
    });
    const store = readStore(path);
    expect(store.issues["sentry:1"]).toMatchObject({
      state: "observed",
      attempts: 0,
      evidence: null,
      draft: null,
      ticket: null,
      ticketNumber: null,
      cycle: 1,
      regressedAfter: "#42",
      previousTickets: ["#42"],
      updatedAt: LATER.toISOString(),
    });
    expect(store.issues["sentry:1"]!.recurrence!.comments).toHaveLength(1);
    expect(store.leases["sentry:1"]).toBeUndefined();

    await withStore(path, (s) => {
      recordFiled(s, "sentry:1", { ticket: "#50", number: 50, draft: null, adopted: false }, "file", LATER);
      reopenRecord(s, "sentry:1", LATER, 30);
    });
    expect(readStore(path).issues["sentry:1"]).toMatchObject({ cycle: 2, regressedAfter: "#50", previousTickets: ["#42", "#50"] });
  });

  it("refuses to reopen a record that is not filed", () => {
    const store = emptyStore();
    recordCandidate(store, "sentry", candidate("1"), "file", NOW);
    expect(() => reopenRecord(store, "sentry:1", LATER, 30)).toThrow(/not filed/);
    expect(() => reopenRecord(store, "sentry:9", LATER, 30)).toThrow(/no sentinel issue record/);
  });

  it("counts a doubling from the baseline, and a baseline of 0 as 1", () => {
    const at = (baseline: number) => ({ baseline, commentedOn: null, checkedAt: null, comments: [] });
    expect(doubled(at(12), 24)).toBe(true);
    expect(doubled(at(12), 23)).toBe(false);
    expect(doubled(at(0), 1)).toBe(false);
    expect(doubled(at(0), 2)).toBe(true);
  });
});
