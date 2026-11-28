// @vitest-environment node
/**
 * What the durable record is allowed to claim, and what it must never claim.
 *
 * The status panel exists to be read when something has gone wrong, which is
 * exactly when its inputs are least trustworthy: a record half-written by a
 * killed supervisor, a `.ralph/logs/` an operator deleted, a worktree removed
 * from disk while Git still lists it, a pid the kernel has since handed to
 * something else. Every case below is one of those, and the property under
 * test is always the same shape — *the panel degrades, and it never reports a
 * dead or absent loop as working*.
 *
 * The end-to-end cases drive the REAL `ralph/loop-state.ts` as a subprocess
 * against scratch worktrees and a fake `git` on PATH. The registry is a
 * subprocess seam, so a fake binary tests the seam where a mock would test the
 * mock; nothing here touches this repository's own git metadata.
 */
import { execFileSync, spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { writeProjectConfig } from "./dashboard/fixtures";

import {
  applyRecord,
  classifyLoop,
  classifyWorktree,
  DEFAULT_UNATTENDED_AFTER_MS,
  findSupervisor,
  lazyScan,
  lastLedgerStep,
  LEDGER_RELATIVE_PATH,
  parseLoopState,
  parseWorktreeRegistry,
  scanSupervisors,
  snapshot,
  STATE_RELATIVE_PATH,
  supervisorPidMatches,
  type Clock,
  type LoopReport,
  type LoopState,
  type RegistryEntry,
  type Snapshot,
  type SupervisorScan,
  type UnattendedLoop,
  unattendedLoops,
} from "./loop-state";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs the loop-state CLI through bash and bun");

/** `JSON.parse` is `any`; the CLI's `--json` shape is not. */
function parseSnapshot(stdout: string): Snapshot {
  const parsed: unknown = JSON.parse(stdout);
  return parsed as Snapshot;
}

const REPO_ROOT = __dirname;

const scratchRoots: string[] = [];
afterAll(() => scratchRoots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const scratch = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `loggd-loop-state-${label}-`));
  scratchRoots.push(dir);
  return dir;
};

/** The bun that is running this suite, by absolute path — PATH is replaced. */
const BUN = ((): string => {
  try {
    return execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
  } catch {
    return process.execPath;
  }
})();

const NOW = Date.parse("2026-08-26T12:00:00.000Z");
const clock: Clock = {
  nowMs: NOW,
  // Two windows, because they time unrelated things: an iteration's heartbeat,
  // and an operator's use of a checkout.
  loopStaleAfterMs: 60 * 60 * 1000,
  worktreeStaleAfterMs: 7 * 24 * 60 * 60 * 1000,
};
const minutesAgo = (n: number): string => new Date(NOW - n * 60_000).toISOString();

const entry = (over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  path: "/home/faros/loggd",
  head: "abc1234",
  branch: "main",
  detached: false,
  bare: false,
  lockedReason: null,
  prunableReason: null,
  ...over,
});

const state = (over: Partial<LoopState> = {}): LoopState => ({
  version: 1,
  run: "ralph-run-20260826T110000-4242",
  owner: { loop: "ralph", pid: 4242, host: "desktop" },
  worktree: "/home/faros/loggd",
  branch: "ralph/700-durable-loop-status",
  stage: "iteration",
  iteration: { index: 3, max: 50 },
  heartbeat: minutesAgo(2),
  lastEvent: { name: "iteration-start", at: minutesAgo(2) },
  stopReason: null,
  ...over,
});

describe("the worktree registry", () => {
  it("parses attributes Git emits with no value", () => {
    // `prunable`, `locked` and `detached` are routinely bare, and they are the
    // three that decide whether an entry is reported as a working loop. A
    // reader that only understood `key value` would miss all of them.
    const parsed = parseWorktreeRegistry(
      [
        "worktree /home/faros/loggd",
        "HEAD abc1234",
        "branch refs/heads/main",
        "",
        "worktree /home/faros/loggd-rafa",
        "HEAD def5678",
        "detached",
        "locked",
        "prunable gitdir file points to non-existent location",
        "",
      ].join("\n"),
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ path: "/home/faros/loggd", branch: "main", bare: false });
    expect(parsed[1]).toMatchObject({
      path: "/home/faros/loggd-rafa",
      detached: true,
      lockedReason: "",
      prunableReason: "gitdir file points to non-existent location",
    });
  });

  it("closes the final record without a trailing blank line", () => {
    const parsed = parseWorktreeRegistry("worktree /home/faros/loggd\nHEAD abc1234");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.head).toBe("abc1234");
  });

  it("prefers Git's own prunable verdict to a missing directory", () => {
    // Both are true of the same entry. Calling it `orphaned` would send an
    // operator investigating something `git worktree prune` has already
    // offered to clean up.
    expect(
      classifyWorktree(
        entry({ prunableReason: "gitdir file points to non-existent location" }),
        { directoryExists: false, lastActivityMs: NOW, supervisor: "dead" },
        clock,
      ),
    ).toBe("prunable");
  });

  it("calls a registered path that is gone from disk orphaned", () => {
    expect(
      classifyWorktree(
        entry({ lockedReason: "in use on the other machine" }),
        { directoryExists: false, lastActivityMs: NOW, supervisor: "unknown" },
        clock,
      ),
    ).toBe("orphaned");
  });

  it("keeps a worktree live while a supervisor is in it, however old its timestamps", () => {
    // An iteration writes nothing for tens of minutes at a stretch. A timer
    // that outranked the process table would report a paying loop as stale.
    expect(
      classifyWorktree(
        entry(),
        { directoryExists: true, lastActivityMs: NOW - 5 * 60 * 60 * 1000, supervisor: "alive" },
        clock,
      ),
    ).toBe("live");
  });

  it("calls an untouched checkout with nobody in it stale", () => {
    // On the WORKTREE window, which is a week rather than the hour a loop's
    // heartbeat is judged against: the two time unrelated things, and sharing
    // one made every checkout nobody had run a git command in since lunch read
    // as abandoned.
    const week = 7 * 24 * 60 * 60 * 1000;
    expect(
      classifyWorktree(
        entry(),
        { directoryExists: true, lastActivityMs: NOW - week - 60_000, supervisor: "dead" },
        clock,
      ),
    ).toBe("stale");
    expect(
      classifyWorktree(
        entry(),
        { directoryExists: true, lastActivityMs: NOW - 2 * 60 * 60 * 1000, supervisor: "dead" },
        clock,
      ),
    ).toBe("live");
  });
});

describe("reading a record", () => {
  it("treats every unusable file as no record at all", () => {
    // Truncated mid-write, a bare array, a future version, a heartbeat that is
    // not a date, a missing owner. An operator does not care which; a reader
    // that threw on any of them would take the panel down for a file whose
    // whole purpose is to make the panel better.
    expect(parseLoopState('{"version": 1, "run": "r", "owner": {"loop": "ral')).toBeNull();
    expect(parseLoopState("[]")).toBeNull();
    expect(parseLoopState(JSON.stringify({ ...state(), version: 2 }))).toBeNull();
    expect(parseLoopState(JSON.stringify({ ...state(), heartbeat: "soon" }))).toBeNull();
    expect(parseLoopState(JSON.stringify({ ...state(), owner: null }))).toBeNull();
    expect(parseLoopState(JSON.stringify({ ...state(), stage: "thinking" }))).toBeNull();
  });

  it("drops fields it cannot use rather than the whole record", () => {
    // A hand-edited or partially-written record still answers the question the
    // panel is actually asking. Only the fields that decide liveness are
    // load-bearing enough to reject a file over.
    const parsed = parseLoopState(
      JSON.stringify({ ...state(), iteration: { index: "3" }, owner: { loop: "ralph", pid: "x" } }),
    );
    expect(parsed?.iteration).toBeNull();
    expect(parsed?.owner.pid).toBeNull();
    expect(parsed?.run).toBe("ralph-run-20260826T110000-4242");
  });

  it("keeps a stop's signal and self only when well-formed, and reads an old record without them", () => {
    const stop = (extra: Record<string, unknown>) =>
      parseLoopState(
        JSON.stringify({ ...state(), stopReason: { kind: "interrupted", why: "w", at: minutesAgo(1), ...extra } }),
      )?.stopReason;
    const old = stop({});
    expect(old).not.toHaveProperty("signal");
    expect(old).not.toHaveProperty("self");
    expect(stop({ signal: "SIGTERM", self: true })).toMatchObject({ signal: "SIGTERM", self: true });
    const malformed = stop({ signal: 7, self: "yes" });
    expect(malformed?.kind).toBe("interrupted");
    expect(malformed).not.toHaveProperty("signal");
    expect(malformed).not.toHaveProperty("self");
    expect(stop({ signal: "" })).not.toHaveProperty("signal");
  });

  it("drops a stop's signal and self when its own stop time is missing (#6)", () => {
    // The heartbeat stands in for a missing time, and the reconciler would read
    // it as when the shutdown stopped the loop.
    const parsed = parseLoopState(
      JSON.stringify({ ...state(), stopReason: { kind: "interrupted", why: "w", signal: "SIGTERM", self: true } }),
    )?.stopReason;
    expect(parsed?.kind).toBe("interrupted");
    expect(parsed).not.toHaveProperty("signal");
    expect(parsed).not.toHaveProperty("self");
  });

  it("keeps a known phase and drops one it does not know", () => {
    expect(parseLoopState(JSON.stringify({ ...state(), phase: "verify" }))?.phase).toBe("verify");
    const unknown = parseLoopState(JSON.stringify({ ...state(), phase: "daydream" }));
    expect(unknown).not.toBeNull();
    expect(unknown?.phase).toBeUndefined();
  });

  it("keeps when the loop last finished an iteration, and drops one that is not a date", () => {
    const at = minutesAgo(30);
    expect(parseLoopState(JSON.stringify({ ...state(), lastIterationEndAt: at }))?.lastIterationEndAt).toBe(at);
    const malformed = parseLoopState(JSON.stringify({ ...state(), lastIterationEndAt: "yesterday-ish" }));
    expect(malformed).not.toBeNull();
    expect(malformed).not.toHaveProperty("lastIterationEndAt");
  });
});

describe("classifying a loop", () => {
  it("falls back to the process table when there is no record", () => {
    // This is the behaviour the panel had before records existed, and it is
    // what makes a deleted `.ralph/logs/` a non-event rather than an outage.
    const missing = { state: null, worktreeExists: true } as const;
    expect(classifyLoop({ ...missing, supervisor: "alive" }, clock)).toBe("running");
    expect(classifyLoop({ ...missing, supervisor: "dead" }, clock)).toBe("unknown");
    expect(classifyLoop({ ...missing, supervisor: "unknown" }, clock)).toBe("unknown");
  });

  it("never reports a loop whose worktree is gone as running", () => {
    // The record is entirely plausible — iteration 3 of 50, heartbeat two
    // minutes old — and the directory it names no longer exists. This is the
    // case the whole reconciliation is for.
    expect(
      classifyLoop({ state: state(), worktreeExists: false, supervisor: "alive" }, clock),
    ).toBe("orphaned");
  });

  it("reads the ending the loop wrote for itself", () => {
    const stopped = (kind: "completed" | "blocked" | "failed" | "interrupted"): LoopState =>
      state({ stage: "stopped", stopReason: { kind, why: "…", at: minutesAgo(1) } });
    for (const [kind, expected] of [
      ["completed", "completed"],
      ["blocked", "blocked"],
      ["failed", "failed"],
      // An operator's Stop now: neither finished nor broken, and never `stale`.
      ["interrupted", "interrupted"],
    ] as const) {
      expect(
        classifyLoop({ state: stopped(kind), worktreeExists: true, supervisor: "dead" }, clock),
      ).toBe(expected);
    }
  });

  it("separates an iteration from a wait, and a wait from a blocked park", () => {
    const alive = { worktreeExists: true, supervisor: "alive" } as const;
    expect(classifyLoop({ ...alive, state: state() }, clock)).toBe("running");
    expect(classifyLoop({ ...alive, state: state({ stage: "gate" }) }, clock)).toBe("idle");
    expect(classifyLoop({ ...alive, state: state({ stage: "preflight" }) }, clock)).toBe("idle");
    expect(
      classifyLoop(
        {
          ...alive,
          state: state({
            stage: "gate",
            lastEvent: { name: "blocked-wait", at: minutesAgo(1) },
          }),
        },
        clock,
      ),
    ).toBe("blocked");
  });

  it("reads a loop backing off an external blocker as blocked, not as idle", () => {
    // Alive and deliberately doing nothing until a provider outage clears —
    // the thing that would unstick it sooner is a person, as with a park.
    const alive = { worktreeExists: true, supervisor: "alive" } as const;
    expect(
      classifyLoop(
        { ...alive, state: state({ stage: "gate", lastEvent: { name: "backoff-wait", at: minutesAgo(1) } }) },
        clock,
      ),
    ).toBe("blocked");
  });

  it("reads a gate hold past its budget as blocked, and one inside it as idle", () => {
    // Past the budget only a person changes the verdict (#771); inside it the
    // gate is doing its job, and the loop is between iterations.
    const alive = { worktreeExists: true, supervisor: "alive" } as const;
    expect(
      classifyLoop(
        { ...alive, state: state({ stage: "gate", lastEvent: { name: "gate-hold-exhausted", at: minutesAgo(1) } }) },
        clock,
      ),
    ).toBe("blocked");
    expect(
      classifyLoop(
        { ...alive, state: state({ stage: "gate", lastEvent: { name: "gate-hold", at: minutesAgo(1) } }) },
        clock,
      ),
    ).toBe("idle");
  });

  it("reads a loop waiting out a usage limit as blocked, not as failed or idle", () => {
    // Alive and holding its claim until the account's limit resets — nothing
    // is broken, and nothing but the clock (or a person) moves it sooner.
    const alive = { worktreeExists: true, supervisor: "alive" } as const;
    expect(
      classifyLoop(
        { ...alive, state: state({ stage: "gate", lastEvent: { name: "usage-wait", at: minutesAgo(1) } }) },
        clock,
      ),
    ).toBe("blocked");
  });

  it("reads a loop held by an operator as blocked, not as idle", () => {
    // `paused` is a live supervisor doing nothing on purpose — an Orca pause,
    // or a decision gate nobody has resolved. `idle` would read as "between
    // iterations, carry on", and the thing that unsticks it is a person.
    const alive = { worktreeExists: true, supervisor: "alive" } as const;
    expect(classifyLoop({ ...alive, state: state({ stage: "paused" }) }, clock)).toBe("blocked");
  });

  it("calls a record whose supervisor died without an ending stale", () => {
    // A closed terminal, a reboot, a `kill -9`. The record still says
    // "iteration 3", and believing it is how a dead loop is reported as
    // working — so the process table outranks the record here.
    expect(classifyLoop({ state: state(), worktreeExists: true, supervisor: "dead" }, clock)).toBe(
      "stale",
    );
  });

  it("falls back to the heartbeat only when liveness cannot be observed", () => {
    const unknown = { worktreeExists: true, supervisor: "unknown" } as const;
    expect(classifyLoop({ ...unknown, state: state() }, clock)).toBe("running");
    expect(
      classifyLoop({ ...unknown, state: state({ heartbeat: minutesAgo(180) }) }, clock),
    ).toBe("stale");
  });
});

describe("folding an event into the record", () => {
  const base = {
    run: "ralph-run-1",
    loop: "ralph",
    pid: 99,
    host: "desktop",
    worktree: "/home/faros/loggd",
  };

  it("keeps what an event did not mention", () => {
    // The iteration counter is only known at iteration boundaries; a
    // heartbeat written between them must not blank it.
    // Same run as `base`: merging is what one supervisor's own events do to
    // its own record, and a record from a different run is not merged with at
    // all (below).
    const previous = state({ run: base.run });
    const next = applyRecord(previous, { event: "gate-wait", stage: "gate" }, base, minutesAgo(0));
    expect(next.iteration).toEqual({ index: 3, max: 50 });
    expect(next.stage).toBe("gate");
    expect(next.heartbeat).toBe(minutesAgo(0));
  });

  it("does not let a later event un-stop a stopped loop", () => {
    // The record's job after a loop ends is to explain the ending. A stray
    // heartbeat writing `stopReason: null` back over it turns `failed` into
    // `stale`, which is the difference between "repair this" and "restart it".
    const stopped = applyRecord(
      state(),
      { event: "halt", stop: { kind: "failed", why: "iteration 3 ended without a sigil" } },
      base,
      minutesAgo(5),
    );
    const later = applyRecord(stopped, { event: "heartbeat" }, base, minutesAgo(0));
    expect(later.stopReason).toEqual(stopped.stopReason);
    expect(later.stage).toBe("stopped");
  });

  it("does not inherit the previous run's ending, or its counters", () => {
    // The record lives at a fixed path in the worktree, so the NEXT supervisor
    // started there reads the last one's ending as its own `previous`. Merging
    // across that boundary reported a live loop as `completed`, because
    // `classifyLoop` consults `stopReason` before liveness.
    const ended = applyRecord(
      state(),
      { event: "cap-reached", stop: { kind: "completed", why: "iteration cap (1) reached" } },
      base,
      minutesAgo(120),
    );
    const restarted = applyRecord(
      ended,
      { event: "supervisor-start", stage: "starting" },
      { ...base, run: "ralph-run-2", pid: 5150 },
      minutesAgo(0),
    );
    expect(restarted.stopReason).toBeNull();
    expect(restarted.stage).toBe("starting");
    // The counters are the previous run's too, and an inherited `iteration
    // 1/1` on a run that has not started one is the same class of lie.
    expect(restarted.iteration).toBeNull();
    expect(
      classifyLoop({ state: restarted, worktreeExists: true, supervisor: "alive" }, clock),
    ).not.toBe("completed");
  });

  it("carries the phase through an iteration and drops it once the iteration is over", () => {
    // Each boundary names the phase it moves into; every other event of the
    // iteration keeps it. The gate after the iteration is not in any phase,
    // and a stale one there would tell the panel work is still under way.
    const previous = state({ run: base.run, stage: "iteration" });
    const started = applyRecord(previous, { event: "iteration-start", stage: "iteration", phase: "select" }, base, minutesAgo(9));
    const boundary = applyRecord(started, { event: "phase", stage: "iteration", phase: "implement" }, base, minutesAgo(5));
    const recovery = applyRecord(boundary, { event: "sigil-recovery", stage: "iteration" }, base, minutesAgo(4));
    const ended = applyRecord(recovery, { event: "iteration-end", stage: "iteration" }, base, minutesAgo(3));
    const gate = applyRecord(ended, { event: "gate-wait", stage: "gate" }, base, minutesAgo(2));
    const stopped = applyRecord(boundary, { event: "halt", stop: { kind: "failed", why: "x" } }, base, minutesAgo(1));

    expect(started.phase).toBe("select");
    expect(boundary.phase).toBe("implement");
    expect(recovery.phase).toBe("implement");
    expect(ended.phase).toBe("implement");
    expect(gate.phase).toBeUndefined();
    expect(stopped.phase).toBeUndefined();
    // A record that names a phase keeps it whatever its stage: a hold at a
    // boundary has to be able to say which boundary.
    expect(applyRecord(boundary, { event: "control-hold", stage: "paused", phase: "review" }, base, minutesAgo(0)).phase).toBe("review");
  });

  it("says an iteration is resuming only while it is still in the phase it resumed at", () => {
    const previous = state({ run: base.run, stage: "gate" });
    const started = applyRecord(previous, { event: "iteration-start", stage: "iteration", phase: "verify", resumedAt: "verify" }, base, minutesAgo(9));
    const recovery = applyRecord(started, { event: "sigil-recovery", stage: "iteration" }, base, minutesAgo(8));
    const boundary = applyRecord(recovery, { event: "phase", stage: "iteration", phase: "review" }, base, minutesAgo(7));
    const gate = applyRecord(recovery, { event: "gate-wait", stage: "gate" }, base, minutesAgo(6));
    const fresh = applyRecord(recovery, { event: "iteration-start", stage: "iteration", phase: "select" }, base, minutesAgo(5));

    expect(started.resumedAt).toBe("verify");
    expect(recovery.resumedAt).toBe("verify");
    expect(boundary.resumedAt).toBeUndefined();
    expect(gate.resumedAt).toBeUndefined();
    expect(fresh.resumedAt).toBeUndefined();
    expect(parseLoopState(JSON.stringify(started))?.resumedAt).toBe("verify");
    expect(parseLoopState(JSON.stringify({ ...started, resumedAt: "daydream" }))?.resumedAt).toBeUndefined();
  });

  it("records when the loop last finished an iteration, at that write's time", () => {
    const previous = state({ run: base.run, stage: "iteration" });
    const first = applyRecord(previous, { event: "iteration-end", stage: "iteration" }, base, minutesAgo(9));
    const between = applyRecord(first, { event: "gate-wait", stage: "gate" }, base, minutesAgo(8));
    const second = applyRecord(between, { event: "iteration-end", stage: "iteration" }, base, minutesAgo(3));
    const stopped = applyRecord(second, { event: "halt", stop: { kind: "failed", why: "x" } }, base, minutesAgo(1));

    expect(first.lastIterationEndAt).toBe(minutesAgo(9));
    expect(between.lastIterationEndAt).toBe(minutesAgo(9));
    expect(second.lastIterationEndAt).toBe(minutesAgo(3));
    expect(stopped.lastIterationEndAt).toBe(minutesAgo(3));
  });

  it("carries when the loop last finished an iteration into a new run, and nothing else", () => {
    // Asked about the loop, not a run: every retry the dashboard's reconcile
    // makes starts a new run, so a per-run value would be unset when it is read.
    const ended = applyRecord(
      state({ run: base.run }),
      { event: "iteration-end", stage: "iteration" },
      base,
      minutesAgo(120),
    );
    const stopped = applyRecord(ended, { event: "halt", stop: { kind: "failed", why: "x" } }, base, minutesAgo(119));
    const restarted = applyRecord(
      stopped,
      { event: "supervisor-start", stage: "starting" },
      { ...base, run: "ralph-run-2", pid: 5150 },
      minutesAgo(0),
    );
    expect(restarted.lastIterationEndAt).toBe(minutesAgo(120));
    expect(restarted.stopReason).toBeNull();
    expect(restarted.iteration).toBeNull();
    // The retry the reconcile cares about stops again at once: its own stop
    // must not move or clear the time the loop last did any work.
    const diedAgain = applyRecord(
      restarted,
      { event: "halt", stop: { kind: "failed", why: "y" } },
      { ...base, run: "ralph-run-2", pid: 5150 },
      minutesAgo(0),
    );
    expect(diedAgain.lastIterationEndAt).toBe(minutesAgo(120));
  });

  it("leaves it unset for a loop with no record, which has never finished one", () => {
    const fresh = applyRecord(null, { event: "supervisor-start", stage: "starting" }, base, minutesAgo(0));
    expect(fresh).not.toHaveProperty("lastIterationEndAt");
  });
});

describe("the last step a run reported", () => {
  const row = (over: Partial<Record<"run" | "step" | "ts" | "label", string>> = {}): string =>
    [
      over.run ?? "ralph-run-1",
      "session-a",
      over.step ?? "2",
      over.ts ?? "2026-08-27T19:27:41+00:00",
      over.label ?? "mapper: brief-683-map.md",
      "opencode-go/deepseek-v4-flash",
      "187695",
      "21379",
      "0",
      "0",
      "3755520",
    ].join("\t");

  const HEADER =
    "run_id\tsession\tstep\tts\tlabel\tmodel\tinput\toutput\tcache_5m\tcache_1h\tcache_read";

  it("reads the last row of this run, not of the file", () => {
    // Every run of every loop in a worktree appends to one ledger, so the rows
    // for this run are not necessarily at the end of it.
    const tsv = [
      HEADER,
      row({ run: "ralph-run-0", label: "someone else's step" }),
      row({ step: "1", ts: "2026-08-27T19:23:38+00:00", label: "claim #683" }),
      row({ step: "2", ts: "2026-08-27T20:06:09+00:00", label: "delegated: brief-683-retry.md" }),
      row({ run: "ralph-run-0", ts: "2026-08-27T21:00:00+00:00", label: "later, other run" }),
      "",
    ].join("\n");
    expect(lastLedgerStep(tsv, "ralph-run-1")).toEqual({
      index: 2,
      label: "delegated: brief-683-retry.md",
      at: "2026-08-27T20:06:09+00:00",
    });
  });

  it("survives a row the writer was killed halfway through", () => {
    // The writer appends under a loop that can be killed mid-line, and the
    // reader is a panel. A torn final row costs the step label, not the table.
    const tsv = [HEADER, row({ step: "1", label: "claim #683" }), "ralph-run-1\tsession-a\t2\t2026"].join(
      "\n",
    );
    expect(lastLedgerStep(tsv, "ralph-run-1")).toEqual({
      index: 1,
      label: "claim #683",
      at: "2026-08-27T19:27:41+00:00",
    });
  });

  it("accepts a legacy row with a trailing cost column", () => {
    expect(lastLedgerStep(`${HEADER}\n${row({ label: "legacy step" })}\t0.0817\n`, "ralph-run-1"))
      .toMatchObject({ index: 2, label: "legacy step" });
  });

  it("is null when the run has reported nothing, and when the header is all there is", () => {
    expect(lastLedgerStep([HEADER, row({ run: "ralph-run-9" })].join("\n"), "ralph-run-1")).toBeNull();
    expect(lastLedgerStep(HEADER, "ralph-run-1")).toBeNull();
    expect(lastLedgerStep("", "ralph-run-1")).toBeNull();
  });

  it("ignores a row whose step or timestamp is not one", () => {
    const tsv = [
      HEADER,
      row({ step: "1" }),
      row({ step: "two", label: "unusable" }),
      row({ step: "3", ts: "not-a-date", label: "also unusable" }),
    ].join("\n");
    expect(lastLedgerStep(tsv, "ralph-run-1")?.index).toBe(1);
  });
});

/* ------------------------------------------------------------------------ */

interface Fixture {
  root: string;
  /** A worktree directory inside the fixture, and its state file path. */
  worktree: (name: string) => string;
  /** Point the fake `git worktree list` at these porcelain lines. */
  registry: (lines: string[]) => void;
  run: (args: string[], env?: Record<string, string>) => SpawnSyncReturns<string>;
}

/**
 * A scratch machine: worktree directories, a registry the test writes by hand,
 * and a `git` that reads it. The registry is written separately from the
 * directories on purpose — a registry that always agreed with the disk could
 * not express the desynchronization these tests are about.
 */
function fixture(label: string): Fixture {
  const root = scratch(label);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const registryFile = join(root, "registry.txt");
  writeFileSync(registryFile, "");
  writeFileSync(
    join(bin, "git"),
    [
      "#!/bin/sh",
      'if [ "$1 $2" = "worktree list" ]; then',
      `  while IFS= read -r line; do printf '%s\\n' "$line"; done < ${JSON.stringify(registryFile)}`,
      "  exit 0",
      "fi",
      'if [ "$1" = "symbolic-ref" ]; then printf \'%s\\n\' "ralph/700-durable"; exit 0; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "git"), 0o755);

  return {
    root,
    worktree: (name: string): string => {
      const path = join(root, name);
      mkdirSync(join(path, ".ralph", "logs"), { recursive: true });
      writeProjectConfig(path);
      return path;
    },
    registry: (lines: string[]): void => writeFileSync(registryFile, `${lines.join("\n")}\n`),
    run: (args, env = {}): SpawnSyncReturns<string> =>
      spawnSync(BUN, [join(REPO_ROOT, "loop-state.ts"), ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          ...env,
        },
      }),
  };
}

describe("the status CLI", () => {
  it("reports a registered worktree that is gone from disk, and never as a loop at work", () => {
    // Registry desynchronization, in the shape that actually happens: the
    // directory was deleted by hand, Git still lists the entry, and the record
    // left behind inside it is long gone with it. `git worktree list` alone
    // shows an entry indistinguishable from a healthy one.
    const f = fixture("orphan");
    const live = f.worktree("loggd");
    f.registry([
      `worktree ${live}`,
      "HEAD abc1234",
      "branch refs/heads/main",
      "",
      `worktree ${join(f.root, "loggd-rafa")}`,
      "HEAD def5678",
      "branch refs/heads/rafa/661-thing",
      "",
    ]);
    const status = f.run(["status", "--json"]);
    expect(status.status).toBe(0);
    const snap = parseSnapshot(status.stdout);
    const rafa = snap.loops.find((l) => l.worktree.endsWith("loggd-rafa"));
    expect(rafa?.worktreeStatus).toBe("orphaned");
    expect(rafa?.loopStatus).toBe("orphaned");
    expect(snap.reconciliation.orphaned).toEqual([join(f.root, "loggd-rafa")]);

    const text = f.run(["status"]);
    expect(text.stdout).toContain("is registered but missing from disk — not a running loop");
    expect(text.stdout).not.toMatch(/rafa\/661-thing\s+.*running/);
  });

  it("degrades to the process table when the record is corrupt or missing", () => {
    // Two worktrees, neither with a usable record: one whose file was
    // truncated mid-write, one that never had a file at all. Both must still
    // produce a row, and both must say which — an operator debugging a panel
    // needs to know whether the record is broken or simply absent.
    const f = fixture("corrupt");
    const broken = f.worktree("loggd");
    const bare = f.worktree("loggd-rafa");
    writeFileSync(join(broken, STATE_RELATIVE_PATH), '{"version": 1, "run": "ralph-run');
    f.registry([
      `worktree ${broken}`,
      "HEAD abc1234",
      "branch refs/heads/main",
      "",
      `worktree ${bare}`,
      "HEAD def5678",
      "detached",
      "",
    ]);
    const status = f.run(["status", "--json"]);
    expect(status.status).toBe(0);
    const snap = parseSnapshot(status.stdout);
    const rows: Record<string, LoopReport> = Object.fromEntries(
      snap.loops.map((l) => [l.worktree, l]),
    );
    expect(rows[broken]?.stateProblem).toBe("unreadable");
    expect(rows[bare]?.stateProblem).toBe("missing");
    // Nothing is running in either, and no record claims otherwise: the honest
    // answer is that the panel does not know, not that they are working.
    expect(rows[broken]?.loopStatus).toBe("unknown");
    expect(rows[bare]?.loopStatus).toBe("unknown");

    const text = f.run(["status"]);
    expect(text.stdout).toContain("state file unreadable");
    expect(text.stdout).toContain("no durable state");
  });

  it("still reports this worktree when the registry cannot be read at all", () => {
    // A `git` that fails is not evidence that no loops exist. The panel falls
    // back to the one worktree it is standing in rather than printing nothing.
    const f = fixture("no-git");
    f.registry([]);
    const snap = parseSnapshot(f.run(["status", "--json"]).stdout);
    expect(snap.loops).toHaveLength(1);
    expect(snap.loops[0]?.worktree).toBe(snap.self);
  });

  it("records an event, and reads it back as the status of a stopped loop", () => {
    // The round trip: `ralph.sh` writes through `record`, the panel reads
    // through `status`, and the loop's own ending is what the panel reports.
    const f = fixture("round-trip");
    const worktree = f.worktree("loggd");
    f.registry([`worktree ${worktree}`, "HEAD abc1234", "branch refs/heads/main", ""]);

    // `record` writes into the worktree it is RUN from, so the CLI is invoked
    // with the scratch worktree as cwd — which is what `ralph.sh` does.
    const record = spawnSync(
      BUN,
      [
        join(REPO_ROOT, "loop-state.ts"),
        "record",
        "--event",
        "iteration-start",
        "--stage",
        "iteration",
        "--iteration",
        "4",
        "--max",
        "50",
      ],
      {
        cwd: worktree,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(f.root, "bin")}:${process.env.PATH ?? ""}`,
          RALPH_RUN_ID: "ralph-run-test",
          RALPH_LOOP_NAME: "ralph",
          RALPH_STATE_ROOT: worktree,
        },
      },
    );
    expect(record.status).toBe(0);
    const written = parseLoopState(readFileSync(join(worktree, STATE_RELATIVE_PATH), "utf8"));
    expect(written).toMatchObject({
      run: "ralph-run-test",
      owner: { loop: "ralph" },
      stage: "iteration",
      iteration: { index: 4, max: 50 },
      lastEvent: { name: "iteration-start" },
      stopReason: null,
    });
    // The branch comes from git at the moment of writing, not from a flag: the
    // supervisor does not drive the branch changes an iteration makes.
    expect(written?.branch).toBe("ralph/700-durable");

    const stop = spawnSync(
      BUN,
      [
        join(REPO_ROOT, "loop-state.ts"),
        "record",
        "--event",
        "halt",
        "--stop",
        "failed",
        "--why",
        "iteration 4 ended without a sigil",
      ],
      {
        cwd: worktree,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(f.root, "bin")}:${process.env.PATH ?? ""}`,
          RALPH_RUN_ID: "ralph-run-test",
          RALPH_LOOP_NAME: "ralph",
          RALPH_STATE_ROOT: worktree,
        },
      },
    );
    expect(stop.status).toBe(0);

    const snap = parseSnapshot(f.run(["status", "--json"]).stdout);
    const row = snap.loops.find((l) => l.worktree === worktree);
    expect(row?.loopStatus).toBe("failed");
    expect(row?.state?.stopReason?.why).toBe("iteration 4 ended without a sigil");
    expect(f.run(["status"]).stdout).toContain(
      "stopped (failed): iteration 4 ended without a sigil",
    );
  });

  it("refuses a record whose stage it would then have to throw away", () => {
    // A mistyped stage parses as JSON and is rejected on the way back out, so
    // the panel would degrade to "no durable state" with nothing to say why.
    // Refused at the write instead, where the operator is still looking.
    const f = fixture("bad-stage");
    const worktree = f.worktree("loggd");
    const run = f.run(["record", "--event", "x", "--stage", "thinking"], {
      RALPH_STATE_ROOT: worktree,
      RALPH_LOOP_NAME: "ralph",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("--stage must be one of");
  });

  it("records the phase it is given, and refuses one it does not know", () => {
    const f = fixture("phase");
    const worktree = f.worktree("loggd");
    const env = { RALPH_STATE_ROOT: worktree, RALPH_LOOP_NAME: "ralph", RALPH_RUN_ID: "ralph-run-phase" };
    const record = (args: string[]) =>
      spawnSync(BUN, [join(REPO_ROOT, "loop-state.ts"), "record", ...args], {
        cwd: worktree,
        encoding: "utf8",
        env: { ...process.env, PATH: `${join(f.root, "bin")}:${process.env.PATH ?? ""}`, ...env },
      });

    expect(record(["--event", "phase", "--stage", "iteration", "--phase", "review"]).status).toBe(0);
    expect(parseLoopState(readFileSync(join(worktree, STATE_RELATIVE_PATH), "utf8"))?.phase).toBe("review");

    const refused = record(["--event", "phase", "--stage", "iteration", "--phase", "daydream"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("--phase must be one of select, implement, verify, review, finish");

    expect(record(["--event", "iteration-start", "--stage", "iteration", "--phase", "finish", "--resumed-at", "finish"]).status).toBe(0);
    expect(parseLoopState(readFileSync(join(worktree, STATE_RELATIVE_PATH), "utf8"))?.resumedAt).toBe("finish");
    expect(record(["--event", "iteration-start", "--stage", "iteration", "--resumed-at", "later"]).stderr).toContain(
      "--resumed-at must be one of select, implement, verify, review, finish",
    );
  });

  it("shows when the loop last finished an iteration in the status JSON", () => {
    const f = fixture("last-iteration-end");
    const worktree = f.worktree("loggd");
    f.registry([`worktree ${worktree}`, "HEAD abc1234", "branch refs/heads/main", ""]);
    const record = spawnSync(
      BUN,
      [join(REPO_ROOT, "loop-state.ts"), "record", "--event", "iteration-end", "--stage", "iteration"],
      {
        cwd: worktree,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(f.root, "bin")}:${process.env.PATH ?? ""}`,
          RALPH_RUN_ID: "ralph-run-end",
          RALPH_LOOP_NAME: "ralph",
          RALPH_STATE_ROOT: worktree,
        },
      },
    );
    expect(record.status).toBe(0);

    const snap = parseSnapshot(f.run(["status", "--json"]).stdout);
    const row = snap.loops.find((l) => l.worktree === worktree);
    expect(Number.isNaN(Date.parse(row?.state?.lastIterationEndAt ?? ""))).toBe(false);
  });

  it("does not adopt a record another worktree wrote", () => {
    // A copied or `git worktree move`d checkout carries somebody else's
    // `state.json`. Reporting its run, iteration and ending under this path
    // would be a confident wrong answer; no record at all is the honest one.
    const f = fixture("moved");
    const worktree = f.worktree("loggd");
    writeFileSync(
      join(worktree, STATE_RELATIVE_PATH),
      JSON.stringify(state({ worktree: "/home/faros/loggd-rafa", owner: { loop: "rafa", pid: null, host: "desktop" } })),
    );
    f.registry([`worktree ${worktree}`, "HEAD abc1234", "branch refs/heads/main", ""]);

    const snap = parseSnapshot(f.run(["status", "--json"]).stdout);
    const row = snap.loops.find((l) => l.worktree === worktree);
    expect(row?.state).toBeNull();
    expect(row?.loopStatus).toBe("unknown");
    // And it says so as itself. Reported as `unreadable` it would send an
    // operator looking for corruption in a file that parses perfectly.
    expect(row?.stateProblem).toBe("foreign");
    expect(f.run(["status"]).stdout).toContain("belongs to another worktree");
  });

  it("refuses a record it cannot key, rather than writing a nameless one", () => {
    const f = fixture("bad-args");
    const worktree = f.worktree("loggd");
    const missingEvent = f.run(["record"], { RALPH_STATE_ROOT: worktree });
    expect(missingEvent.status).toBe(1);
    expect(missingEvent.stderr).toContain("--event");
    const badStop = f.run(["record", "--event", "x", "--stop", "exploded"], {
      RALPH_STATE_ROOT: worktree,
    });
    expect(badStop.status).toBe(1);
    expect(badStop.stderr).toContain("--stop must be one of");
  });
});

describe("who a record belongs to", () => {
  it("takes the name from the roster, and from this worktree when unset", () => {
    // Resolved through `scripts/next-tasks.ts`, the same resolver `ralph.sh`,
    // the frontier and the preflight use — a fourth copy is how the panel
    // comes to file a run under the other loop's name.
    const f = fixture("owner");
    const worktree = f.worktree("loggd");
    const offRoster = f.run(["record", "--event", "x"], {
      RALPH_STATE_ROOT: worktree,
      RALPH_LOOP_NAME: "ralphie",
    });
    expect(offRoster.status).toBe(1);
    expect(offRoster.stderr).toContain("must be one of");

    // No environment name: the worktree's own `.loop-name` decides, which is
    // what keeps a loop restarted by hand from coming back as the other one.
    mkdirSync(join(worktree, ".ralph"), { recursive: true });
    writeFileSync(join(worktree, ".ralph", "loop-name"), "rafa\n");
    const fromFile = f.run(["record", "--event", "x"], {
      RALPH_STATE_ROOT: worktree,
      RALPH_LOOP_NAME: "",
    });
    expect(fromFile.status).toBe(0);
    const written = parseLoopState(readFileSync(join(worktree, STATE_RELATIVE_PATH), "utf8"));
    expect(written?.owner.loop).toBe("rafa");
  });
});

describe("what a loop is doing between iteration boundaries", () => {
  /**
   * These drive the CLI as a subprocess, so the clock is the REAL one — the
   * fixed `NOW` the in-process cases use would land every timestamp 34 hours
   * in the past. The 20s offset keeps each value in the middle of its rounding
   * bucket, so a slow test cannot tip `70m ago` over to `71m ago`.
   */
  const agoIso = (minutes: number): string =>
    new Date(Date.now() - (minutes * 60_000 - 20_000)).toISOString();

  /** A record whose last event is `minutes` old, written into a worktree. */
  const recordIn = (worktree: string, run: string, minutes: number): void =>
    writeFileSync(
      join(worktree, STATE_RELATIVE_PATH),
      JSON.stringify(
        state({
          run,
          worktree,
          stage: "iteration",
          heartbeat: agoIso(minutes),
          lastEvent: { name: "iteration-start", at: agoIso(minutes) },
        }),
      ),
    );

  const LEDGER_HEADER = [
    "run_id",
    "session",
    "step",
    "ts",
    "label",
    "model",
    "input",
    "output",
    "cache_5m",
    "cache_1h",
    "cache_read",
  ].join("\t");

  const ledgerIn = (worktree: string, rows: string[][]): void =>
    writeFileSync(
      join(worktree, LEDGER_RELATIVE_PATH),
      [LEDGER_HEADER, ...rows.map((r) => r.join("\t")), ""].join("\n"),
    );

  const ledgerRow = (run: string, step: string, minutes: number, label: string): string[] => [
    run,
    "session-a",
    step,
    agoIso(minutes),
    label,
    "claude-opus-5",
    "48",
    "5440",
    "0",
    "73388",
    "1525434",
    "1.6328",
  ];

  const timelineIn = (
    worktree: string,
    run: string,
    minutes: number,
    stage = "executor",
  ): void =>
    writeFileSync(
      join(worktree, ".ralph/logs/iter-test.events.jsonl"),
      `${JSON.stringify({
        type: "tool_use",
        part: {
          callID: "call-1",
          tool: "bash",
          state: { input: { command: "bun run typecheck" } },
        },
        ralph_stage: stage,
        ralph_iteration: 3,
        ralph_run: run,
        ralph_received_at: agoIso(minutes),
      })}\n`,
    );

  it("uses the latest tool event for current activity instead of a billed step", () => {
    const f = fixture("timeline-activity");
    const worktree = f.worktree("loggd");
    f.registry([`worktree ${worktree}`, "HEAD abc1234", "branch refs/heads/main", ""]);
    recordIn(worktree, "ralph-run-live", 70);
    ledgerIn(worktree, [ledgerRow("ralph-run-live", "2", 12, "delegated: old brief")]);
    timelineIn(worktree, "ralph-run-live", 2);

    const text = f.run(["status"]);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain(
      "activity executor: tool bash — bun run typecheck — observed 2m ago; process table decides liveness",
    );
    expect(text.stdout).not.toContain("step 2:");

    const snap = parseSnapshot(f.run(["status", "--json"]).stdout);
    expect(snap.loops.find((loop) => loop.worktree === worktree)?.lastActivity).toMatchObject({
      stage: "executor",
      label: "tool bash — bun run typecheck",
    });
  });

  it("falls back to the billed step when no timeline exists", () => {
    // The whole point: `ralph.sh` records at iteration boundaries only,
    // because between them it is blocked on the orchestrator. An hour of
    // `iteration-start 70m ago` cannot distinguish a working loop from a
    // wedged one, and the ledger is written from inside that hour.
    const f = fixture("in-flight");
    const worktree = f.worktree("loggd");
    f.registry([`worktree ${worktree}`, "HEAD abc1234", "branch refs/heads/main", ""]);
    recordIn(worktree, "ralph-run-live", 70);
    ledgerIn(worktree, [
      ledgerRow("ralph-run-live", "1", 68, "claim #683"),
      ledgerRow("ralph-run-live", "2", 12, "delegated: brief-683-retry.md"),
    ]);

    const text = f.run(["status"]);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("iteration-start 70m ago");
    expect(text.stdout).toContain("step 2: delegated: brief-683-retry.md — reported 12m ago");

    const snap = parseSnapshot(f.run(["status", "--json"]).stdout);
    expect(snap.loops.find((l) => l.worktree === worktree)?.lastStep).toMatchObject({
      index: 2,
      label: "delegated: brief-683-retry.md",
    });
  });

  it("stays quiet when the newest step predates the event", () => {
    // Between iterations the ledger's last row is the PREVIOUS iteration's
    // closing entry. Printed beside a fresh `iteration-start` it would read as
    // progress this iteration has not made.
    const f = fixture("stale-step");
    const worktree = f.worktree("loggd");
    f.registry([`worktree ${worktree}`, "HEAD abc1234", "branch refs/heads/main", ""]);
    recordIn(worktree, "ralph-run-live", 1);
    ledgerIn(worktree, [ledgerRow("ralph-run-live", "5", 40, "iteration 1 end")]);
    expect(f.run(["status"]).stdout).not.toContain("step 5:");
  });

  it("never attributes another run's row in the shared ledger to this one", () => {
    // One ledger holds every run that ever worked in the worktree. Reading the
    // newest row without checking the run id reports a previous supervisor's
    // work as this one's progress — the same class of mistake as inheriting
    // its `stopReason`.
    const f = fixture("other-run");
    const worktree = f.worktree("loggd");
    f.registry([`worktree ${worktree}`, "HEAD abc1234", "branch refs/heads/main", ""]);
    recordIn(worktree, "ralph-run-fresh", 70);
    ledgerIn(worktree, [ledgerRow("ralph-run-other", "3", 2, "someone else's step")]);
    const out = f.run(["status"]);
    expect(out.stdout).not.toContain("someone else's step");
    expect(out.stdout).toContain("iteration-start 70m ago");
  });

  it("degrades to the record alone when the ledger is missing or unreadable", () => {
    // `.ralph/logs/` is a directory an operator may delete at any time, and a
    // panel that fell over on that would be unusable exactly when it is used.
    const f = fixture("no-ledger");
    const worktree = f.worktree("loggd");
    f.registry([`worktree ${worktree}`, "HEAD abc1234", "branch refs/heads/main", ""]);
    recordIn(worktree, "ralph-run-live", 70);
    const missing = f.run(["status"]);
    expect(missing.status).toBe(0);
    expect(missing.stdout).toContain("iteration-start 70m ago");
    expect(missing.stdout).not.toContain("— reported ");

    writeFileSync(join(worktree, LEDGER_RELATIVE_PATH), " not a ledger at all\n");
    const garbage = f.run(["status"]);
    expect(garbage.status).toBe(0);
    expect(garbage.stdout).toContain("iteration-start 70m ago");
    expect(garbage.stdout).not.toContain("— reported ");
  });
});

describe("which loops are unattended", () => {
  const THRESHOLD = 30 * 60 * 1000;
  const loopReport = (over: Partial<LoopReport> = {}): LoopReport => ({
    worktree: "/home/faros/loggd",
    worktreeStatus: "live",
    loopStatus: "failed",
    branch: "ralph/700-durable-loop-status",
    state: state(),
    stateProblem: null,
    lastStep: null,
    lastActivity: null,
    timelineExists: false,
    supervisor: "dead",
    registryEntry: entry(),
    ...over,
  });
  const failedAt = (minutes: number, over: Partial<LoopState> = {}): LoopState =>
    state({
      heartbeat: minutesAgo(minutes),
      lastEvent: { name: "iteration-end", at: minutesAgo(minutes) },
      stopReason: { kind: "failed", why: "no-sigil", at: minutesAgo(minutes) },
      ...over,
    });

  it("names a loop whose failed stop is older than the threshold", () => {
    expect(unattendedLoops([loopReport({ state: failedAt(45) })], clock, THRESHOLD)).toEqual([
      { loop: "ralph", stopKind: "failed", downSince: minutesAgo(45) },
    ]);
  });

  it("leaves a failed stop inside the threshold alone", () => {
    expect(unattendedLoops([loopReport({ state: failedAt(10) })], clock, THRESHOLD)).toEqual([]);
  });

  it("names a dead supervisor with no ending, down since its heartbeat", () => {
    const report = loopReport({
      loopStatus: "stale",
      state: state({ heartbeat: minutesAgo(50), lastEvent: { name: "iteration-start", at: minutesAgo(50) } }),
    });
    expect(unattendedLoops([report], clock, THRESHOLD)).toEqual([
      { loop: "ralph", stopKind: null, downSince: minutesAgo(50) },
    ]);
  });

  it("never names a decided stop, at any age", () => {
    for (const kind of ["completed", "blocked", "interrupted"] as const) {
      const report = loopReport({
        loopStatus: kind,
        state: state({
          heartbeat: minutesAgo(3 * 24 * 60),
          stopReason: { kind, why: kind, at: minutesAgo(3 * 24 * 60) },
        }),
      });
      expect(unattendedLoops([report], clock, THRESHOLD)).toEqual([]);
    }
  });

  it("never names a loop an operator stopped as failed", () => {
    const report = loopReport({
      state: failedAt(120, { lastEvent: { name: "control-stop", at: minutesAgo(120) } }),
    });
    expect(unattendedLoops([report], clock, THRESHOLD)).toEqual([]);
  });

  it("never names a loop whose supervisor is alive", () => {
    const report = loopReport({ supervisor: "alive", state: failedAt(600) });
    expect(unattendedLoops([report], clock, THRESHOLD)).toEqual([]);
  });

  it("never names an ending-less loop on unknown liveness alone", () => {
    for (const loopStatus of ["running", "idle"] as const) {
      const report = loopReport({
        supervisor: "unknown",
        loopStatus,
        state: state({ heartbeat: minutesAgo(45), lastEvent: { name: "iteration-start", at: minutesAgo(45) } }),
      });
      expect(unattendedLoops([report], clock, THRESHOLD)).toEqual([]);
    }
  });

  it("never names a worktree without a record", () => {
    const report = loopReport({ state: null, loopStatus: "orphaned", stateProblem: "missing" });
    expect(unattendedLoops([report], clock, THRESHOLD)).toEqual([]);
  });

  it("names nothing while a live supervisor has no record to name it", () => {
    // A fresh start before its first `record` could be the live owner of the
    // old failed worktree beside it.
    const old = loopReport({ worktree: "/home/faros/loggd-old", state: failedAt(600) });
    const starting = loopReport({
      supervisor: "alive",
      loopStatus: "running",
      state: null,
      stateProblem: "missing",
    });
    expect(unattendedLoops([old, starting], clock, THRESHOLD)).toEqual([]);
  });

  it("defaults the threshold to 30 minutes", () => {
    expect(DEFAULT_UNATTENDED_AFTER_MS).toBe(30 * 60 * 1000);
  });

  it("never names a timestamp it cannot read", () => {
    const report = loopReport({
      state: state({ stopReason: { kind: "failed", why: "x", at: "not-a-date" } }),
    });
    expect(unattendedLoops([report], clock, THRESHOLD)).toEqual([]);
  });

  it("drops a name when any worktree carrying it is attended", () => {
    // An old worktree left behind with a failed stop must not make the live
    // loop of the same name look adoptable.
    const old = loopReport({ worktree: "/home/faros/loggd-old", state: failedAt(600) });
    const live = loopReport({ supervisor: "alive", loopStatus: "running", state: state() });
    expect(unattendedLoops([old, live], clock, THRESHOLD)).toEqual([]);
    expect(unattendedLoops([live, old], clock, THRESHOLD)).toEqual([]);
  });

  it("answers once per name, with the shortest time down", () => {
    const older = loopReport({ worktree: "/home/faros/loggd-old", state: failedAt(600) });
    const newer = loopReport({ state: failedAt(60) });
    const rafa = loopReport({
      worktree: "/home/faros/loggd-rafa",
      state: failedAt(90, { owner: { loop: "rafa", pid: null, host: "desktop" } }),
    });
    expect(unattendedLoops([older, rafa, newer], clock, THRESHOLD)).toEqual([
      { loop: "ralph", stopKind: "failed", downSince: minutesAgo(60) },
      { loop: "rafa", stopKind: "failed", downSince: minutesAgo(90) },
    ]);
  });
});

describe("the unattended CLI", () => {
  const realMinutesAgo = (n: number): string => new Date(Date.now() - n * 60_000).toISOString();
  const failedIn = (worktree: string, loop: string, minutes: number): void =>
    writeFileSync(
      join(worktree, STATE_RELATIVE_PATH),
      JSON.stringify(
        state({
          worktree,
          owner: { loop, pid: null, host: "desktop" },
          heartbeat: realMinutesAgo(minutes),
          lastEvent: { name: "iteration-end", at: realMinutesAgo(minutes) },
          stopReason: { kind: "failed", why: "no-sigil", at: realMinutesAgo(minutes) },
        }),
      ),
    );
  const twoLoops = (label: string): { f: Fixture; down: string } => {
    const f = fixture(label);
    const down = f.worktree("loggd");
    const fresh = f.worktree("loggd-rafa");
    failedIn(down, "ralph", 45);
    failedIn(fresh, "rafa", 5);
    f.registry([
      `worktree ${down}`,
      "HEAD abc1234",
      "branch refs/heads/main",
      "",
      `worktree ${fresh}`,
      "HEAD def5678",
      "branch refs/heads/rafa/661-thing",
      "",
    ]);
    return { f, down };
  };

  it("prints only the loops down past the threshold, keyed loop, stopKind, downSince", () => {
    const { f } = twoLoops("unattended");
    const run = f.run(["unattended", "--json"]);
    expect(run.status).toBe(0);
    const loops = JSON.parse(run.stdout) as UnattendedLoop[];
    expect(loops.map((l) => l.loop)).toEqual(["ralph"]);
    expect(Object.keys(loops[0] ?? {}).sort()).toEqual(["downSince", "loop", "stopKind"]);
    expect(loops[0]?.stopKind).toBe("failed");
  });

  it("honours RALPH_UNATTENDED_AFTER_SECONDS", () => {
    const { f } = twoLoops("unattended-env");
    const wide = JSON.parse(
      f.run(["unattended", "--json"], { RALPH_UNATTENDED_AFTER_SECONDS: String(60 * 60) }).stdout,
    ) as UnattendedLoop[];
    expect(wide).toEqual([]);
    const narrow = JSON.parse(
      f.run(["unattended", "--json"], { RALPH_UNATTENDED_AFTER_SECONDS: "60" }).stdout,
    ) as UnattendedLoop[];
    expect(narrow.map((l) => l.loop).sort()).toEqual(["rafa", "ralph"]);
  });

  it("names unattended in its usage error", () => {
    const f = fixture("unattended-usage");
    const run = f.run(["nonsense"], { RALPH_STATE_ROOT: f.worktree("loggd") });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("'unattended'");
  });
});

describe("supervisorPidMatches against a process that vanishes mid-read", () => {
  // A live loop's `$(…)` subshells carry `ralph.sh` in argv and exit within
  // milliseconds; one that exits between the cmdline read and the cwd read
  // leaves a dangling cwd. That must read as dead, or one subshell anywhere on
  // the host turns every dead loop's panel row into "running" (CI, 11-17).
  const made: string[] = [];
  afterAll(() => made.forEach((root) => rmSync(root, { recursive: true, force: true })));
  const fakeProc = (cwdTarget: string): { proc: string; worktree: string } => {
    const root = mkdtempSync(join(tmpdir(), "ralph-fake-proc-"));
    made.push(root);
    const worktree = join(root, "worktree");
    mkdirSync(worktree);
    mkdirSync(join(root, "proc", "4242"), { recursive: true });
    writeFileSync(join(root, "proc", "4242", "cmdline"), "bash\0/home/x/ralph/ralph.sh\0");
    symlinkSync(cwdTarget === "worktree" ? worktree : join(root, "gone"), join(root, "proc", "4242", "cwd"));
    return { proc: join(root, "proc"), worktree };
  };

  it("reads a cwd that no longer resolves as dead, not unknown", () => {
    const { proc, worktree } = fakeProc("gone");
    expect(supervisorPidMatches(4242, worktree, proc)).toBe("dead");
  });

  it("still reads a matching cwd as alive", () => {
    const { proc, worktree } = fakeProc("worktree");
    expect(supervisorPidMatches(4242, worktree, proc)).toBe("alive");
  });
});

describe("one /proc scan answers every worktree (#64)", () => {
  // The panel used to walk the whole process table once per idle worktree;
  // these pin that one shared scan gives the same verdicts the per-pid check
  // does, and that a snapshot takes it at most once.
  const made: string[] = [];
  afterAll(() => made.forEach((root) => rmSync(root, { recursive: true, force: true })));

  /** A fake `/proc` with worktrees A and B, and the processes named. */
  const fakeHost = (): {
    proc: string;
    a: string;
    b: string;
    addProcess: (pid: number, argv: string[], cwd: string) => void;
  } => {
    const root = mkdtempSync(join(tmpdir(), "ralph-fake-host-"));
    made.push(root);
    const a = join(root, "a");
    const b = join(root, "b");
    mkdirSync(a);
    mkdirSync(b);
    const proc = join(root, "proc");
    mkdirSync(proc);
    const addProcess = (pid: number, argv: string[], cwd: string): void => {
      mkdirSync(join(proc, String(pid)));
      writeFileSync(join(proc, String(pid), "cmdline"), `${argv.join("\0")}\0`);
      symlinkSync(cwd, join(proc, String(pid), "cwd"));
    };
    return { proc, a, b, addProcess };
  };

  const populated = (): ReturnType<typeof fakeHost> => {
    const host = fakeHost();
    host.addProcess(100, ["bash", "/home/x/ralph/ralph.sh", "50"], host.a);
    // Exited between the cmdline and cwd reads: dead, not a supervisor of anything.
    host.addProcess(101, ["bash", "/home/x/ralph/ralph.sh"], join(host.a, "..", "gone"));
    // The status panel's own parent shell mentions ralph.sh but is not one.
    host.addProcess(102, ["bash", "-c", "x=$(/home/x/ralph/ralph.sh status)"], host.b);
    host.addProcess(103, ["vim", "notes.md"], host.b);
    mkdirSync(join(host.proc, "self"));
    return host;
  };

  it("finds the supervisor in A and none in B", () => {
    const host = populated();
    const scan = scanSupervisors(host.proc);
    expect(scan?.sawUnknown).toBe(false);
    expect(findSupervisor(host.a, scan)).toBe("alive");
    expect(findSupervisor(host.b, scan)).toBe("dead");
  });

  it("reads B as unknown when some process could not be judged, while A stays alive", () => {
    const host = populated();
    // A `cmdline` that is a directory fails with EISDIR: unreadable, not gone.
    mkdirSync(join(host.proc, "104", "cmdline"), { recursive: true });
    const scan = scanSupervisors(host.proc);
    expect(scan?.sawUnknown).toBe(true);
    expect(findSupervisor(host.b, scan)).toBe("unknown");
    expect(findSupervisor(host.a, scan)).toBe("alive");
  });

  it("reads an unlistable /proc as unknown", () => {
    const host = fakeHost();
    expect(scanSupervisors(join(host.proc, "missing"))).toBeNull();
    expect(findSupervisor(host.a, null)).toBe("unknown");
  });

  it("agrees with the per-pid check for each single process", () => {
    const cases: Array<(host: ReturnType<typeof fakeHost>) => void> = [
      (host) => host.addProcess(100, ["bash", "/home/x/ralph/ralph.sh"], host.a),
      (host) => host.addProcess(100, ["bash", "/home/x/ralph/ralph.sh"], join(host.a, "..", "gone")),
      (host) => host.addProcess(100, ["bash", "-c", "ralph.sh"], host.a),
      (host) => host.addProcess(100, ["vim"], host.a),
      (host) => mkdirSync(join(host.proc, "100", "cmdline"), { recursive: true }),
    ];
    for (const make of cases) {
      const host = fakeHost();
      make(host);
      const scan = scanSupervisors(host.proc);
      for (const worktree of [host.a, host.b]) {
        expect(findSupervisor(worktree, scan)).toBe(supervisorPidMatches(100, worktree, host.proc));
      }
    }
  });

  it("calls the underlying scan at most once, and not at all if never asked", () => {
    let calls = 0;
    const never = lazyScan(() => {
      calls += 1;
      return null;
    });
    expect(calls).toBe(0);
    expect(typeof never).toBe("function");
    const scan = lazyScan(() => {
      calls += 1;
      return null;
    });
    for (let i = 0; i < 5; i += 1) expect(scan()).toBeNull();
    expect(calls).toBe(1);
  });

  it("takes one scan for a snapshot of several worktrees", () => {
    const root = mkdtempSync(join(tmpdir(), "ralph-scan-once-"));
    made.push(root);
    const main = join(root, "main");
    mkdirSync(main);
    const run = (args: string[], cwd: string): void => {
      execFileSync("git", args, { cwd, stdio: "ignore" });
    };
    run(["init", "-q", "-b", "main"], main);
    run(["-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "--allow-empty", "-m", "init"], main);
    const worktrees = ["w1", "w2", "w3"].map((name) => join(root, name));
    worktrees.forEach((path, i) => run(["worktree", "add", "-q", "-b", `b${i}`, path], main));
    let calls = 0;
    const fixed: SupervisorScan = { cwds: new Set([realpathSync(worktrees[1]!)]), sawUnknown: false };
    const snap = snapshot(main, clock, {
      scan: () => {
        calls += 1;
        return fixed;
      },
    });
    expect(calls).toBe(1);
    const verdict = (path: string): string | undefined =>
      snap.loops.find((l) => realpathSync(l.worktree) === realpathSync(path))?.supervisor;
    expect(snap.loops).toHaveLength(4);
    expect(verdict(main)).toBe("dead");
    expect(verdict(worktrees[0]!)).toBe("dead");
    expect(verdict(worktrees[1]!)).toBe("alive");
    expect(verdict(worktrees[2]!)).toBe("dead");
  });

  it("takes no scan when every worktree's recorded pid is a live supervisor", async () => {
    // The fast path the scan must never cost: a panel whose loops are all
    // running answers from the recorded pids alone.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ralph-scan-none-")));
    made.push(root);
    const main = join(root, "main");
    mkdirSync(main);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: main, stdio: "ignore" });
    // A real `bash …/ralph.sh` with the worktree as cwd, which is what
    // `supervisorPidMatches` reads from `/proc`. It blocks on stdin, so it
    // lives until the test closes the pipe — no sleep to outlast.
    writeFileSync(join(root, "ralph.sh"), "read -r _\n");
    const child = spawn("bash", [join(root, "ralph.sh")], { cwd: main, stdio: ["pipe", "ignore", "ignore"] });
    try {
      const pid = child.pid!;
      const deadline = Date.now() + 20_000;
      while (supervisorPidMatches(pid, main) !== "alive" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(supervisorPidMatches(pid, main)).toBe("alive");
      mkdirSync(join(main, STATE_RELATIVE_PATH, ".."), { recursive: true });
      writeFileSync(
        join(main, STATE_RELATIVE_PATH),
        JSON.stringify(state({ worktree: main, owner: { loop: "ralph", pid, host: "desktop" } })),
      );
      let calls = 0;
      const snap = snapshot(main, clock, {
        scan: () => {
          calls += 1;
          return null;
        },
      });
      expect(snap.loops.map((l) => l.supervisor)).toEqual(["alive"]);
      expect(calls).toBe(0);
    } finally {
      child.stdin!.end();
      child.kill();
    }
  });
});
