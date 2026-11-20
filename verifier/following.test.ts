// @vitest-environment node
/**
 * The "Following" view of the verifier watch store (felipearos/ralph#569):
 * what is in progress, what finished, what observe mode held back, and that a
 * malformed record or result is skipped rather than fatal.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { scratchDir } from "../test-scratch";
import { subprocessSuite } from "../test-timeouts";
import { followingView } from "./following";
import {
  type CheckInDecision,
  type CheckInResult,
  checkInSchedule,
  emptyStore,
  STORE_RELATIVE_PATH,
  type Watch,
  type WatchStore,
  type WatchVerdict,
} from "./watches";

subprocessSuite("runs verifier/following.ts through bun in a scratch git repo");

const HOME = join(__dirname, "..");
const CLI = join(HOME, "verifier", "following.ts");
const BUN = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim() || process.execPath;

const watch = (pr: number, overrides: Partial<Watch> = {}): Watch => ({
  pr,
  ticket: 184,
  ticketRef: "#184",
  mergeCommit: "abc123",
  mergedAt: "2026-10-29T10:00:00.000Z",
  deployId: `dpl_${pr}`,
  deployedAt: "2026-10-29T10:05:00.000Z",
  deployUrl: "app-xyz.vercel.app",
  checkIns: checkInSchedule("2026-10-29T10:05:00.000Z", [1, 6, 24]),
  round: 1,
  lineage: [],
  root: null,
  mode: "observe",
  openedAt: "2026-10-29T10:06:00.000Z",
  verdict: null,
  reported: {},
  ...overrides,
});

const storeOf = (...watches: unknown[]): WatchStore => ({
  version: 1,
  leases: {},
  watches: Object.fromEntries(watches.map((w, i) => [String((w as { pr?: unknown })?.pr ?? `x${i}`), w])) as WatchStore["watches"],
});

const observeRevert = { verdict: "revert", reason: "checkout 500s", priority: "high", act: false, wouldHaveBeen: "revert" } as const;

const evidence: CheckInResult["evidence"] = {
  gatheredAt: "2026-10-29T11:05:00.000Z",
  health: { reachable: true, issues: [] },
  traffic: { reachable: true, hits: 3 },
  pr: { number: 41, files: [], routes: [] },
  otherPrs: [],
};

/** A check-in the gate handed over and the session decided. */
const decided = (decision: Omit<CheckInDecision, "decidedAt">): CheckInResult => ({
  handedOverAt: "2026-10-29T11:05:00.000Z",
  evidence,
  decision: { decidedAt: "2026-10-29T11:10:00.000Z", ...decision },
});

/** A terminal verdict as the store records it. */
const final = (verdict: Omit<WatchVerdict, "offsetHours" | "decidedAt">): WatchVerdict => ({
  offsetHours: 24,
  decidedAt: "2026-10-30T10:10:00.000Z",
  ...verdict,
});

/** A shape the store's types would refuse: the view must survive it anyway. */
const raw = <T>(value: unknown): T => value as T;

describe("followingView", () => {
  it("is empty for an empty store", () => {
    expect(followingView(emptyStore())).toEqual({ version: 1, watches: [] });
  });

  it("shows an in-progress watch with its next check-in", () => {
    const w = watch(41);
    w.checkIns[0]!.result = decided({ verdict: "pending", reason: "too early", priority: "normal", act: false });
    // Handed over, not yet decided: still the next check-in, not a done one.
    w.checkIns[1]!.result = { handedOverAt: "2026-10-29T16:05:00.000Z", evidence, decision: null };
    const [view] = followingView(storeOf(w)).watches;
    expect(view).toEqual({
      pr: 41,
      ticket: 184,
      ticketRef: "#184",
      mode: "observe",
      round: 1,
      mergedAt: "2026-10-29T10:00:00.000Z",
      deployedAt: "2026-10-29T10:05:00.000Z",
      deployUrl: "app-xyz.vercel.app",
      openedAt: "2026-10-29T10:06:00.000Z",
      state: "in-progress",
      nextCheckIn: { offsetHours: 6, dueAt: "2026-10-29T16:05:00.000Z" },
      checkInsDone: 1,
      checkInsTotal: 3,
      verdict: null,
      wouldBe: [],
      notVerifiableLive: [],
    });
  });

  it("finishes a watch with a verified verdict", () => {
    const w = watch(42, { mode: "act", verdict: final({ verdict: "verified", reason: "all green", act: true }) });
    w.checkIns.forEach((c) => (c.result = decided({ verdict: "verified", reason: "all green", priority: "normal", act: true })));
    const [view] = followingView(storeOf(w)).watches;
    expect(view!.state).toBe("finished");
    expect(view!.nextCheckIn).toBeNull();
    expect(view!.checkInsDone).toBe(3);
    expect(view!.verdict).toEqual({ verdict: "verified", reason: "all green", act: true, wouldHaveBeen: null });
    expect(view!.wouldBe).toEqual([]);
  });

  it("lists observe-mode would-be actions at a check-in and the terminal one, once per reason", () => {
    const { priority: _, ...observeRevertFinal } = observeRevert;
    const w = watch(43, { verdict: final({ ...observeRevertFinal, reason: "still 500s" }) });
    w.checkIns[0]!.result = decided(observeRevert);
    w.checkIns[1]!.result = decided(observeRevert);
    w.checkIns[2]!.result = decided({ ...observeRevert, reason: "still 500s" });
    const [view] = followingView(storeOf(w)).watches;
    expect(view!.state).toBe("finished");
    expect(view!.wouldBe).toEqual([
      { verdict: "revert", reason: "checkout 500s", at: 1 },
      { verdict: "revert", reason: "still 500s", at: 24 },
    ]);
  });

  it("lists a terminal-only would-be with a null offset", () => {
    const w = watch(44, { verdict: final({ verdict: "ticket", reason: "slow", act: false, wouldHaveBeen: "ticket" }) });
    expect(followingView(storeOf(w)).watches[0]!.wouldBe).toEqual([{ verdict: "ticket", reason: "slow", at: null }]);
  });

  it("does not list a report-mode verdict that acted as a would-be", () => {
    const reported = {
      verdict: "ticket",
      reason: "checkout 500s (report mode: filed as a ticket instead of a revert)",
      act: true,
      wouldHaveBeen: "revert",
    } as const;
    const w = watch(45, { mode: "report", verdict: final(reported) });
    w.checkIns[0]!.result = decided({ ...reported, priority: "high" });
    const [view] = followingView(storeOf(w)).watches;
    expect(view!.wouldBe).toEqual([]);
    expect(view!.verdict).toEqual({ verdict: "ticket", reason: reported.reason, act: true, wouldHaveBeen: "revert" });
  });

  it("collects not-verifiable criteria across check-ins, deduplicated", () => {
    const w = watch(46);
    const pending = decided({ verdict: "pending", reason: "nothing wrong yet", priority: "normal", act: false });
    w.checkIns[0]!.result = raw({
      ...pending,
      acceptance: [
        { criterion: "emails arrive", result: "not-verifiable", detail: "no inbox access" },
        { criterion: "page loads", result: "passed" },
      ],
    });
    w.checkIns[1]!.result = raw({
      ...pending,
      acceptance: [
        { criterion: "emails arrive", result: "not-verifiable", detail: "still no inbox" },
        { criterion: "export works", result: "not-verifiable" },
      ],
    });
    expect(followingView(storeOf(w)).watches[0]!.notVerifiableLive).toEqual([
      { criterion: "emails arrive", detail: "no inbox access" },
      { criterion: "export works", detail: null },
    ]);
  });

  it("ignores a malformed verdict, result and record", () => {
    const w = watch(47, { verdict: raw({ verdict: 7, reason: "?" }) });
    w.checkIns[0]!.result = raw("garbage");
    w.checkIns[1]!.result = raw({ handedOverAt: "x", decision: { verdict: ["nope"] }, acceptance: "nope" });
    const view = followingView(storeOf(w, "not a watch", { pr: "48" }, null));
    expect(view.watches).toHaveLength(1);
    expect(view.watches[0]).toMatchObject({
      pr: 47,
      state: "in-progress",
      verdict: null,
      checkInsDone: 2,
      nextCheckIn: { offsetHours: 24, dueAt: "2026-10-30T10:05:00.000Z" },
      wouldBe: [],
      notVerifiableLive: [],
    });
  });

  it("sorts in-progress by next check-in, then finished newest first", () => {
    const done = (pr: number, openedAt: string): Watch =>
      watch(pr, { openedAt, verdict: final({ verdict: "verified", reason: "ok", act: true }) });
    const later = watch(1, { checkIns: checkInSchedule("2026-10-29T12:00:00.000Z", [1]) });
    const sooner = watch(2, { checkIns: checkInSchedule("2026-10-29T09:00:00.000Z", [1]) });
    const view = followingView(storeOf(done(3, "2026-10-27T00:00:00.000Z"), later, done(4, "2026-10-28T00:00:00.000Z"), sooner));
    expect(view.watches.map((w) => w.pr)).toEqual([2, 1, 4, 3]);
  });
});

describe("bun verifier/following.ts --json", () => {
  const project = (): string => {
    const root = scratchDir("ralph-verifier-following-");
    spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
    return root;
  };
  const run = (root: string, args = ["--json"]) =>
    spawnSync(BUN, [CLI, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, RALPH_PROJECT: root } });

  it("prints an empty view and exits 0 when there is no store", () => {
    const result = run(project());
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ version: 1, watches: [] });
  });

  it("exits 1 with the reason on stderr and nothing on stdout for an unreadable store", () => {
    const root = project();
    const store = join(root, ".git", STORE_RELATIVE_PATH);
    mkdirSync(dirname(store), { recursive: true });
    writeFileSync(store, "{ not json");
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(store);
    expect(result.stderr).toContain("not JSON");
  });

  it("exits 64 with a usage line without --json", () => {
    const result = run(project(), []);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("usage:");
  });
});
