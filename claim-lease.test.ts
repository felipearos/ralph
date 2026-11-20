// @vitest-environment node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEASE_SECONDS,
  heartbeatLogger,
  claimLease,
  currentLeaseOf,
  leaseStatus,
  reclaimVerdict,
  reconnectLease,
  releaseLease,
  renewLease,
  CLAIM_REFUSED_EXIT,
  type ClaimLease,
  type LeaseStore,
} from "./claim-lease";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("races real bun processes over one lease store");

const input = (nowMs = 1_000) => ({
  issue: 701, run: "ralph-run-1", loop: "ralph", pid: 42, host: "desk",
  worktree: "/tmp/loggd", branch: "ralph/701-leases", nowMs, leaseMs: 1_000,
});

describe("releaseLease", () => {
  it("drops the holder's own lease so the next claimant need not wait out the TTL", () => {
    const store: LeaseStore = { version: 1, leases: {} };
    claimLease(store, input());
    const result = releaseLease(store, 701, { run: "ralph-run-1", loop: "ralph" });
    expect(result.released).toBe(true);
    expect(result.store.leases["701"]).toBeUndefined();
    // Pure: the input store is untouched, so a caller that fails to write it
    // has not already dropped the claim in memory.
    expect(store.leases["701"]).toBeDefined();
  });

  it("refuses to release another run's or another loop's lease", () => {
    const store: LeaseStore = { version: 1, leases: {} };
    claimLease(store, input());
    expect(releaseLease(store, 701, { run: "other-run", loop: "ralph" }).released).toBe(false);
    expect(releaseLease(store, 701, { run: "ralph-run-1", loop: "rafa" }).released).toBe(false);
    expect(store.leases["701"]).toBeDefined();
  });

  it("treats a lease that is not there as nothing to do", () => {
    const result = releaseLease({ version: 1, leases: {} }, 701, { run: "r", loop: "ralph" });
    expect(result.released).toBe(false);
  });
});

describe("claim leases", () => {
  it("records ownership, timestamps, and provenance on the first claim", () => {
    const store: LeaseStore = { version: 1, leases: {} };
    const result = claimLease(store, input());
    expect(result.outcome).toBe("claimed");
    expect(result.lease).toMatchObject({
      issue: 701, run: "ralph-run-1", owner: "ralph@desk", loop: "ralph",
      worktree: "/tmp/loggd", branch: "ralph/701-leases", attempt: 1,
      claimedAt: "1970-01-01T00:00:01.000Z", heartbeatAt: "1970-01-01T00:00:01.000Z",
      expiresAt: "1970-01-01T00:00:02.000Z", history: [],
    });
  });

  it("keeps a live or dead-but-unexpired owner held", () => {
    const store: LeaseStore = { version: 1, leases: {} };
    const first = claimLease(store, { ...input(), leaseMs: 10_000 }).lease;
    expect(leaseStatus(first, { nowMs: 1_500, pidAlive: () => true })).toBe("active");
    expect(leaseStatus(first, { nowMs: 1_100, reconnectGraceMs: 90, pidAlive: () => true })).toBe("slow");
    expect(leaseStatus(first, { nowMs: 1_500, pidAlive: () => false })).toBe("reconnecting");
    expect(leaseStatus(first, { nowMs: 2_001, reconnectGraceMs: 90, pidAlive: () => false })).toBe("dead");
    expect(claimLease(store, { ...input(1_500), run: "rafa-run-2", loop: "rafa" }).outcome).toBe("held");
    expect(leaseStatus(first, { nowMs: 11_001, pidAlive: () => false })).toBe("expired");
  });

  it("renews only the owning run and tracks replacement attempts", () => {
    const store: LeaseStore = { version: 1, leases: {} };
    const first = claimLease(store, input()).lease;
    expect(renewLease(store, 701, { run: "other", loop: "ralph" }, 1_500)).toBeNull();
    expect(renewLease(store, 701, { run: first.run, loop: first.loop }, 1_500, {
      worktree: "/tmp/new-worktree", branch: "ralph/701-retry",
    })).toMatchObject({ heartbeatAt: "1970-01-01T00:00:01.500Z", expiresAt: "1970-01-01T00:00:02.500Z" });
    const replaced = claimLease(store, { ...input(3_001), run: "rafa-run-2", loop: "rafa" });
    expect(replaced.outcome).toBe("replaced");
    expect(replaced.lease.attempt).toBe(2);
    expect(replaced.lease.history).toHaveLength(1);
    expect(replaced.lease.history[0]).toMatchObject({ run: "ralph-run-1", branch: "ralph/701-retry" });
  });

  it("keeps repeated renewals at the configured lease duration", () => {
    const store: LeaseStore = { version: 1, leases: {} };
    const first = claimLease(store, input()).lease;
    renewLease(store, 701, { run: first.run, loop: first.loop }, 1_500);
    expect(renewLease(store, 701, { run: first.run, loop: first.loop }, 2_000)?.expiresAt)
      .toBe("1970-01-01T00:00:03.000Z");
  });

  it("lets a restarted owner reconnect in the same worktree without replacing the attempt", () => {
    const store: LeaseStore = { version: 1, leases: {} };
    const first = claimLease(store, { ...input(), leaseMs: 10_000 }).lease;
    const reconnected = reconnectLease(store, 701, {
      run: "ralph-run-2", loop: "ralph", pid: 43, host: "desk",
      worktree: "/tmp/loggd", branch: null,
    }, 1_500, { pidAlive: () => false });
    expect(reconnected).toMatchObject({ run: "ralph-run-2", pid: 43, attempt: 1, history: [] });
    expect(reconnected?.reconnects).toMatchObject([{ run: "ralph-run-1", branch: "ralph/701-leases" }]);
    expect(reconnected?.branch).toBe("ralph/701-leases");
    expect(reconnected?.claimedAt).toBe(first.claimedAt);
  });

  it("reconnects a lapsed lease only for Resume work, in the same loop and worktree", () => {
    // Stop now keeps the claim, and its lease lapses while the operator looks
    // at what the killed iteration left. Resuming over that work must pick the
    // claim back up; an ordinary restart past the expiry must not.
    const identity = { run: "ralph-run-2", loop: "ralph", pid: 43, host: "desk", worktree: "/tmp/loggd", branch: null };
    const lapsed = (): LeaseStore => {
      const store: LeaseStore = { version: 1, leases: {} };
      claimLease(store, { ...input(), leaseMs: 1_000 });
      return store;
    };
    expect(reconnectLease(lapsed(), 701, identity, 60_000, { pidAlive: () => false })).toBeNull();
    expect(reconnectLease(lapsed(), 701, identity, 60_000, { pidAlive: () => false, resume: true }))
      .toMatchObject({ run: "ralph-run-2", pid: 43, attempt: 1 });
    // Never another loop's, nor one claimed from another worktree.
    // (The heartbeat passes `resume` only for the interrupted ticket; every
    // other lapsed lease in the store is reconnected as an ordinary restart would.)
    expect(reconnectLease(lapsed(), 701, { ...identity, loop: "rafa" }, 60_000, { resume: true })).toBeNull();
    expect(reconnectLease(lapsed(), 701, { ...identity, worktree: "/tmp/other" }, 60_000, { resume: true })).toBeNull();
  });
});

/** One lease, held by another run, expiring two minutes after it was claimed. */
const lease = (over: Partial<ClaimLease> = {}): ClaimLease => ({
  version: 1,
  issue: 703,
  run: "ralph-run-0",
  owner: "ralph@fedora",
  loop: "ralph",
  pid: 1,
  host: "fedora",
  worktree: "/tmp/wt",
  branch: "ralph/703",
  claim: "ralph-wip",
  logs: ".ralph/logs",
  usageLedger: ".ralph/logs/usage-ledger.tsv",
  claimedAt: "2026-08-27T00:00:00.000Z",
  heartbeatAt: "2026-08-27T00:00:00.000Z",
  expiresAt: "2026-08-27T00:02:00.000Z",
  leaseMs: DEFAULT_LEASE_SECONDS * 1000,
  attempt: 1,
  history: [],
  ...over,
});

describe("what operator recovery may reclaim", () => {
  const now = Date.parse("2026-08-27T00:01:00.000Z");

  it("refuses to abandon an unexpired lease, and says when it expires", () => {
    const verdict = reclaimVerdict(lease(), now, "abandon");
    expect(verdict).toMatchObject({ ok: false, outcome: "held" });
    expect(verdict.ok === false && verdict.why).toContain("2026-08-27T00:02:00.000Z");
  });

  it("refuses a dead owner's unexpired lease too", () => {
    // The pid check runs on THIS machine, and a lease written on another host
    // has a pid that means nothing here. Waiting for expiry is right on both.
    expect(reclaimVerdict(lease({ pid: 2 ** 22 }), now, "abandon")).toMatchObject({
      ok: false,
      outcome: "held",
    });
  });

  it("abandons an expired lease", () => {
    expect(reclaimVerdict(lease(), Date.parse("2026-08-27T00:03:00.000Z"), "abandon").ok).toBe(true);
  });

  it("lets a run release its own claim without waiting for expiry", () => {
    expect(reclaimVerdict(lease({ run: "ralph-run-1" }), now, "release", { run: "ralph-run-1" }).ok).toBe(
      true,
    );
  });

  it("does not let a run release somebody else's live claim", () => {
    expect(reclaimVerdict(lease(), now, "release", { run: "ralph-run-1" })).toMatchObject({
      ok: false,
      outcome: "held",
    });
  });

  it("does not let a run release another run's claim once it has expired either", () => {
    // Taking a lapsed claim that is not yours is recovery: `abandon`.
    const verdict = reclaimVerdict(lease(), Date.parse("2026-08-27T00:03:00.000Z"), "release", { run: "ralph-run-1" });
    expect(verdict).toMatchObject({ ok: false, outcome: "held" });
    expect(verdict.ok === false && verdict.why).toContain("abandon");
  });

  it("reports a claim that was never there as already free", () => {
    expect(reclaimVerdict(undefined, now, "abandon")).toMatchObject({ ok: false, outcome: "already" });
  });
});

describe("the heartbeat of a resumed run", () => {
  it("picks back up the interrupted ticket's lapsed lease, and no other lease this worktree ever held", () => {
    // Leases are never deleted, so a loop's worktree accumulates lapsed ones
    // for tickets long merged. Only the ticket Resume work names may revive.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ralph-lease-resume-")));
    try {
      const store: LeaseStore = { version: 1, leases: {} };
      // Two earlier runs: a run's own next claim would end its previous lease.
      for (const [issue, run] of [[650, "ralph-run-0"], [701, "ralph-run-1"]] as const) {
        claimLease(store, { ...input(), issue, run, worktree: root, pid: 2 ** 22, leaseMs: 1_000 });
      }
      const path = join(root, ".ralph-claim-leases.json");
      writeFileSync(path, JSON.stringify(store));
      const beat = spawnSync(process.env.RALPH_TEST_BUN ?? "bun", [join(__dirname, "claim-lease.ts"), "heartbeat"], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CEILING_DIRECTORIES: tmpdir(),
          RALPH_RUN_ID: "ralph-run-2",
          RALPH_LOOP_NAME: "ralph",
          RALPH_SUPERVISOR_PID: String(process.pid),
          RALPH_RESUME_WORK: "1",
          RALPH_RESUME_ISSUE: "701",
        },
      });
      expect(beat.status, beat.stderr).toBe(0);
      const leases = (JSON.parse(readFileSync(path, "utf8")) as LeaseStore).leases;
      expect(leases["701"]).toMatchObject({ run: "ralph-run-2", pid: process.pid });
      expect(Date.parse(leases["701"]!.expiresAt)).toBeGreaterThan(Date.now());
      expect(leases["650"]).toMatchObject({ run: "ralph-run-0", expiresAt: "1970-01-01T00:00:02.000Z" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("one ticket per run", () => {
  it("ends the run's other leases when it claims the next ticket", () => {
    const store: LeaseStore = { version: 1, leases: {} };
    claimLease(store, { ...input(1_000), issue: 700 });
    claimLease(store, { ...input(1_000), issue: 800, run: "rafa-run-1", loop: "rafa" });
    claimLease(store, { ...input(1_500), issue: 701 });
    expect(Object.keys(store.leases).sort()).toEqual(["701", "800"]);
  });

  it("lets a run claim again a ticket it still holds a live lease on", () => {
    // A run merges a partial PR for a ticket that stays open. Its heartbeat
    // keeps that lease alive, so refusing the holder fenced the ticket from
    // everyone until the supervisor stopped.
    const store: LeaseStore = { version: 1, leases: {} };
    const first = claimLease(store, { ...input(1_000), leaseMs: 10_000 }).lease;
    const again = claimLease(store, { ...input(5_000), leaseMs: 10_000, branch: "ralph/701-second-half" });
    expect(again.outcome).toBe("claimed");
    expect(again).not.toHaveProperty("previous");
    expect(again.lease).toMatchObject({
      attempt: first.attempt, history: [], branch: "ralph/701-second-half",
      claimedAt: "1970-01-01T00:00:05.000Z", expiresAt: "1970-01-01T00:00:15.000Z",
    });
    expect(claimLease(store, { ...input(6_000), run: "ralph-run-2" }).outcome).toBe("held");
    expect(claimLease(store, { ...input(6_000), loop: "rafa" }).outcome).toBe("held");
  });

  it("names the most recently claimed lease as the one the run is working on", () => {
    const store: LeaseStore = { version: 1, leases: {} };
    claimLease(store, { ...input(1_000), issue: 700, run: "ralph-run-0" });
    claimLease(store, { ...input(2_000), issue: 701 });
    // A store written before a claim ended siblings can still hold several.
    store.leases["699"] = { ...store.leases["701"]!, issue: 699, claimedAt: new Date(500).toISOString() };
    expect(currentLeaseOf(store, { run: "ralph-run-1", loop: "ralph" })?.issue).toBe(701);
    expect(currentLeaseOf(store, { run: "ralph-run-9", loop: "ralph" })).toBeNull();
  });

  it("heartbeats only the ticket the run is working on", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ralph-lease-current-")));
    try {
      const now = Date.now();
      const store: LeaseStore = { version: 1, leases: {} };
      claimLease(store, { ...input(now), issue: 701, worktree: root, pid: process.pid, leaseMs: 60_000 });
      // A lease the run moved past, left by code that did not end it on claim.
      store.leases["650"] = { ...store.leases["701"]!, issue: 650, claimedAt: new Date(now - 60_000).toISOString() };
      const path = join(root, ".ralph-claim-leases.json");
      writeFileSync(path, JSON.stringify(store));
      const before = store.leases["650"]!.expiresAt;
      const beat = spawnSync(process.env.RALPH_TEST_BUN ?? "bun", [join(__dirname, "claim-lease.ts"), "heartbeat"], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CEILING_DIRECTORIES: tmpdir(),
          RALPH_RUN_ID: "ralph-run-1",
          RALPH_LOOP_NAME: "ralph",
          RALPH_SUPERVISOR_PID: String(process.pid),
          RALPH_RESUME_WORK: "",
        },
      });
      expect(beat.status, beat.stderr).toBe(0);
      const leases = (JSON.parse(readFileSync(path, "utf8")) as LeaseStore).leases;
      expect(Date.parse(leases["701"]!.heartbeatAt)).toBeGreaterThanOrEqual(now);
      expect(leases["650"]!.expiresAt).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the heartbeat watcher's log (#119)", () => {
  it("rotates past its size limit, so it never grows without bound, and redacts every line", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ralph-heartbeat-log-")));
    try {
      const path = join(root, "logs", "heartbeat-run.log");
      const log = heartbeatLogger(path, {
        maxBytes: 200,
        redact: (line) => line.replace(/hunter2/g, "[redacted]"),
        now: () => new Date(0),
      });
      for (let i = 0; i < 10; i++) log(`pulse skipped ${i} token=hunter2\n  second line`);
      const current = readFileSync(path, "utf8");
      const rotated = readFileSync(`${path}.1`, "utf8");
      expect(Buffer.byteLength(current)).toBeLessThanOrEqual(200);
      expect(Buffer.byteLength(rotated)).toBeLessThanOrEqual(200);
      expect(current + rotated).not.toContain("hunter2");
      expect(current).toContain("1970-01-01T00:00:00.000Z pulse skipped 9 token=[redacted] second line\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** Run `heartbeat --watch` under a supervisor that lives ~2s, and return its log. */
  const watchUntilSupervisorExits = async (root: string): Promise<string> => {
    const supervisor = spawn("sleep", ["2"], { stdio: "ignore" });
    await new Promise((resolve) => supervisor.once("spawn", resolve));
    const logPath = join(root, ".ralph", "logs", "heartbeat-rulo-run-1.log");
    const watcher = spawn(process.env.RALPH_TEST_BUN ?? "bun", [join(__dirname, "claim-lease.ts"), "heartbeat", "--watch"], {
      cwd: root,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_CEILING_DIRECTORIES: tmpdir(),
        RALPH_RUN_ID: "rulo-run-1",
        RALPH_LOOP_NAME: "rulo",
        RALPH_SUPERVISOR_PID: String(supervisor.pid),
        RALPH_LEASE_HEARTBEAT_SECONDS: "1",
        RALPH_LEASE_HEARTBEAT_LOG: logPath,
        RALPH_RESUME_WORK: "",
      },
    });
    const code = await new Promise((resolve) => watcher.once("exit", resolve));
    expect(code).toBe(0);
    return readFileSync(logPath, "utf8");
  };

  it("says when a pulse is skipped on a busy lock, and why it stopped", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ralph-heartbeat-busy-")));
    try {
      writeFileSync(join(root, "next-tasks-claim.lock"), "");
      const log = await watchUntilSupervisorExits(root);
      expect(log).toContain("watching for run rulo-run-1");
      expect(log).toContain("pulse skipped: the lease store lock is busy");
      expect(log).toMatch(/stopping: supervisor pid \d+ is not running/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps watching after a pulse throws, and logs the error", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ralph-heartbeat-throws-")));
    try {
      writeFileSync(join(root, ".ralph-claim-leases.json"), "{ not json");
      const log = await watchUntilSupervisorExits(root);
      expect(log.match(/heartbeat pulse failed: (Error: )?invalid lease store/g)?.length).toBeGreaterThan(1);
      expect(log).toMatch(/stopping: supervisor pid \d+ is not running/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a claim whose supervisor is still running (#119)", () => {
  // loggd #1482, 2026-09-27: rulo's take-one claimed the ticket inside an
  // iteration, its heartbeat stopped renewing while the supervisor worked on,
  // and remo's frontier reaped the claim as expired eleven minutes later —
  // then rulo reaped remo's the same way. Expiry alone must not free a claim
  // whose supervisor is alive on this host.
  const takeOneClaim = (pid: number, nowMs: number) => ({
    // What `frontier/next.ts --take-one` records from the agent's shell:
    // the supervisor's pid from RALPH_SUPERVISOR_PID, and this host.
    issue: 1482, run: "rulo-run-1", loop: "rulo", pid, host: hostname(),
    worktree: "/tmp/rulo-loop", branch: null, claim: "rulo-wip", nowMs,
  });
  const other = (nowMs: number) => ({ ...takeOneClaim(0, nowMs), run: "remo-run-1", loop: "remo", claim: "remo-wip" });

  it("survives past DEFAULT_LEASE_SECONDS unrenewed while the supervisor lives, and is released once it dies", async () => {
    const supervisor = spawn("sleep", ["300"], { stdio: "ignore" });
    try {
      await new Promise((resolve) => supervisor.once("spawn", resolve));
      const pid = supervisor.pid!;
      const claimedAt = Date.now() + 1_000;
      const store: LeaseStore = { version: 1, leases: {} };
      expect(claimLease(store, takeOneClaim(pid, claimedAt)).outcome).toBe("claimed");

      // Not one renewal since the claim, and well past its expiry.
      const later = claimedAt + DEFAULT_LEASE_SECONDS * 1000 + 60_000;
      expect(leaseStatus(store.leases["1482"]!, { nowMs: later })).not.toBe("expired");
      expect(claimLease(store, other(later))).toMatchObject({ outcome: "held" });
      expect(reclaimVerdict(store.leases["1482"], later, "abandon")).toMatchObject({ ok: false, outcome: "held" });
      // And the owner's heartbeat picks it back up rather than refusing it.
      expect(renewLease(store, 1482, { run: "rulo-run-1", loop: "rulo", pid }, later)).toMatchObject({
        expiresAt: new Date(later + DEFAULT_LEASE_SECONDS * 1000).toISOString(),
      });

      supervisor.kill("SIGKILL");
      await new Promise((resolve) => supervisor.once("exit", resolve));
      const afterDeath = later + DEFAULT_LEASE_SECONDS * 1000 + 1;
      expect(leaseStatus(store.leases["1482"]!, { nowMs: afterDeath })).toBe("expired");
      expect(claimLease(store, other(afterDeath))).toMatchObject({ outcome: "replaced" });
    } finally {
      supervisor.kill("SIGKILL");
    }
  });

  it("uses the injected liveness when a clock supplies one", () => {
    const store: LeaseStore = { version: 1, leases: {} };
    const held = claimLease(store, { ...takeOneClaim(42, 1_000), leaseMs: 1_000 }).lease;
    expect(leaseStatus(held, { nowMs: 1_000 + DEFAULT_LEASE_SECONDS * 1000, pidAlive: () => true })).toBe("slow");
    expect(leaseStatus(held, { nowMs: 1_000 + DEFAULT_LEASE_SECONDS * 1000, pidAlive: () => false })).toBe("expired");
  });

  it("does not trust a pid from another host, nor a process that started after the last heartbeat", () => {
    const now = Date.now();
    const lapsed = (over: Partial<ClaimLease>): ClaimLease =>
      lease({
        pid: process.pid, host: hostname(), heartbeatAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 1).toISOString(), ...over,
      });
    const past = now + DEFAULT_LEASE_SECONDS * 1000;
    expect(leaseStatus(lapsed({}), { nowMs: past })).toBe("slow");
    expect(leaseStatus(lapsed({ host: `${hostname()}-elsewhere` }), { nowMs: past })).toBe("expired");
    // This process is alive, but it is not the one that heartbeat in 2020:
    // that supervisor died and its pid was handed out again.
    const reused = lapsed({ heartbeatAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-01-01T00:02:00.000Z" });
    if (existsSync(`/proc/${process.pid}/stat`)) expect(leaseStatus(reused, { nowMs: past })).toBe("expired");
  });

  it("lets the heartbeat renew its own claim after the lease lapsed while the supervisor ran", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ralph-lease-lapsed-")));
    try {
      const store: LeaseStore = { version: 1, leases: {} };
      // Claimed a moment ago with a lease already lapsed, as if every pulse
      // since had been lost.
      const claimed = claimLease(store, { ...takeOneClaim(process.pid, Date.now() - 1), worktree: root, leaseMs: 1 });
      const path = join(root, ".ralph-claim-leases.json");
      writeFileSync(path, JSON.stringify(store));
      const beat = spawnSync(process.env.RALPH_TEST_BUN ?? "bun", [join(__dirname, "claim-lease.ts"), "heartbeat"], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CEILING_DIRECTORIES: tmpdir(),
          RALPH_RUN_ID: "rulo-run-1",
          RALPH_LOOP_NAME: "rulo",
          RALPH_SUPERVISOR_PID: String(process.pid),
          RALPH_RESUME_WORK: "",
        },
      });
      expect(beat.status, beat.stderr).toBe(0);
      const renewed = (JSON.parse(readFileSync(path, "utf8")) as LeaseStore).leases["1482"]!;
      expect(renewed).toMatchObject({ run: "rulo-run-1", pid: process.pid });
      expect(Date.parse(renewed.heartbeatAt)).toBeGreaterThan(Date.parse(claimed.lease.heartbeatAt));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("claim by number, under the claim lock", () => {
  /**
   * Two loops of one role, both told by their own scanner to claim the same
   * issue, racing for it as two real processes.
   *
   * This is the case the frontier cannot arbitrate, because neither process
   * asked the frontier: a ci-doctor finds its case in Buildkite. So the lock
   * and the live re-read are the whole fence, and the failure they exist to
   * stop — `gh issue edit --add-label` succeeding for BOTH, because adding a
   * label that is already there succeeds — is what the assertions below pin.
   *
   * The fake `gh` remembers the labels it was told to add and hands them back
   * to the next `issue view`, so the second process reads what the first
   * actually wrote rather than a fixture that cannot change. Its `issue view`
   * also sleeps, so the two processes really are inside the critical section
   * together; without the lock they would both read the issue free.
   */
  it("hands the issue to exactly one of two concurrent claims, and refuses the other", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ralph-claim-number-")));
    const bin = join(root, "bin");
    try {
      // A real repository, so the lock and the lease store share this scratch
      // directory instead of falling back to the machine's temp directory.
      spawnSync("git", ["init", "--quiet"], { cwd: root });
      spawnSync("mkdir", ["-p", bin]);
      const labels = join(root, "labels");
      const argv = join(root, "gh-argv");
      writeFileSync(labels, "");
      writeFileSync(
        join(bin, "gh"),
        [
          "#!/bin/sh",
          `printf '%s\\n' "gh $*" >> ${JSON.stringify(argv)}`,
          "case \"$*\" in",
          "  *'issue view'*)",
          "    sleep 0.4",
          `    names=$(sed 's/.*/{"name":"&"}/' ${JSON.stringify(labels)} | paste -sd, -)`,
          '    printf \'{"assignees":[],"labels":[%s],"closedByPullRequestsReferences":[],"state":"OPEN"}\\n\' "$names"',
          "    ;;",
          "  *'--add-label'*)",
          `    printf '%s\\n' "$(printf '%s\\n' "$*" | sed -E 's/.*--add-label ([^ ]+).*/\\1/')" >> ${JSON.stringify(labels)}`,
          "    ;;",
          "esac",
          "exit 0",
          "",
        ].join("\n"),
      );
      spawnSync("chmod", ["755", join(bin, "gh")]);

      const claim = (loop: string): Promise<{ code: number; stderr: string }> =>
        new Promise((done) => {
          let stderr = "";
          const child = spawn(
            process.env.RALPH_TEST_BUN ?? "bun",
            [join(__dirname, "claim-lease.ts"), "claim", "1397", "--label", `${loop}-wip`],
            {
              cwd: root,
              env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH ?? ""}`,
                RALPH_PROJECT: join(__dirname, "fixtures", "loggd"),
                RALPH_LOOP_NAME: loop,
                RALPH_RUN_ID: `${loop}-run-1`,
                RALPH_SUPERVISOR_PID: String(process.pid),
              },
              stdio: ["ignore", "ignore", "pipe"],
            },
          );
          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          child.on("close", (code) => done({ code: code ?? -1, stderr }));
        });

      const runs = await Promise.all([claim("ralph"), claim("rulo")]);
      expect(runs.map((r) => r.code).sort()).toEqual([0, CLAIM_REFUSED_EXIT]);
      // WHICH fence refused the loser is the point, and it is why this test can
      // fail if the lock goes. The lease store is a second fence over the same
      // race — it is a read-modify-write, so an unserialised loser would usually
      // be refused by `lease held …` instead — and a test that accepted either
      // message would pass on the lease alone and pin nothing about the lock.
      // Serialised, the loser re-reads the issue AFTER the winner's label landed
      // and is refused by the label.
      const loser = runs.find((r) => r.code === 3)!;
      expect(loser.stderr).toMatch(/refused — labeled (ralph|rulo)-wip/);
      expect(loser.stderr).not.toMatch(/lease /);
      // The label was written once, by whichever process won.
      const written = readFileSync(labels, "utf8").trim().split("\n").filter(Boolean);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatch(/^(ralph|rulo)-wip$/);
      expect(readFileSync(argv, "utf8").match(/--add-label/g)).toHaveLength(1);
      // And the store records one holder for the issue, the one that won.
      const leases = (JSON.parse(readFileSync(join(root, ".git", "ralph-claim-leases.json"), "utf8")) as LeaseStore)
        .leases;
      expect(Object.keys(leases)).toEqual(["1397"]);
      expect(leases["1397"]!.claim).toBe(written[0]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the heartbeat renews the leases the loop's role owns (#138)", () => {
  /** A ci-health store in `root`, holding this run's case lease and a dead holder's. */
  const ciHealth = (root: string, expiresAt: string): string => {
    const path = join(root, ".ralph-ci-health.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      cursor: "", jobsSeen: {}, failures: [], builds: [], cases: {},
      main: { state: "unknown", since: "", build: 0 },
      leases: {
        "flake:mine": { run: "ralph-run-1", loop: "ralph", pid: process.pid, host: process.env.HOSTNAME ?? hostname(), expiresAt },
        "flake:gone": { run: "dead-run", loop: "rafa", pid: 999_999, host: process.env.HOSTNAME ?? hostname(), expiresAt },
      },
      retries: { day: "", count: 0, byCase: {} }, reverts: {}, metrics: {}, backfill: null,
    }));
    return path;
  };

  const beat = (root: string, role: string) => spawnSync(process.env.RALPH_TEST_BUN ?? "bun", [join(__dirname, "claim-lease.ts"), "heartbeat"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CEILING_DIRECTORIES: tmpdir(),
      RALPH_RUN_ID: "ralph-run-1",
      RALPH_LOOP_NAME: "ralph",
      RALPH_LOOP_ROLE: role,
      RALPH_SUPERVISOR_PID: String(process.pid),
      RALPH_RESUME_WORK: "",
    },
  });

  it("renews the ci-doctor's case lease and prunes a dead holder's", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ralph-role-lease-beat-")));
    try {
      const stale = new Date(Date.now() - 60_000).toISOString();
      const path = ciHealth(root, stale);

      const run = beat(root, "ci-doctor");

      expect(run.status, run.stderr).toBe(0);
      const leases = (JSON.parse(readFileSync(path, "utf8")) as { leases: Record<string, { expiresAt: string }> }).leases;
      expect(Object.keys(leases)).toEqual(["flake:mine"]);
      expect(Date.parse(leases["flake:mine"]!.expiresAt)).toBeGreaterThan(Date.now());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves the store alone for a role that owns none", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ralph-role-lease-coder-")));
    try {
      const stale = new Date(Date.now() - 60_000).toISOString();
      const path = ciHealth(root, stale);
      const before = readFileSync(path, "utf8");

      const run = beat(root, "coder");

      expect(run.status, run.stderr).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a role nobody declared instead of renewing nothing", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ralph-role-lease-typo-")));
    try {
      ciHealth(root, new Date(Date.now() - 60_000).toISOString());

      const run = beat(root, "ci_doctor");

      // The claim pulse still happened; only the role store could not be read.
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/role lease renewal failed: .*unknown role 'ci_doctor'/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops renewing the role store when the supervisor goes", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ralph-role-lease-watch-")));
    try {
      const path = ciHealth(root, new Date(Date.now() - 60_000).toISOString());
      const supervisor = spawn("sleep", ["3"], { stdio: "ignore" });
      await new Promise((done) => supervisor.once("spawn", done));
      const watcher = spawn(process.env.RALPH_TEST_BUN ?? "bun", [join(__dirname, "claim-lease.ts"), "heartbeat", "--watch"], {
        cwd: root,
        stdio: "ignore",
        env: {
          ...process.env,
          GIT_CEILING_DIRECTORIES: tmpdir(),
          RALPH_RUN_ID: "ralph-run-1",
          RALPH_LOOP_NAME: "ralph",
          RALPH_LOOP_ROLE: "ci-doctor",
          RALPH_SUPERVISOR_PID: String(supervisor.pid),
          RALPH_LEASE_HEARTBEAT_SECONDS: "1",
          RALPH_RESUME_WORK: "",
        },
      });
      // The startup beat only, well before the supervisor goes.
      await new Promise((done) => setTimeout(done, 400));
      const first = (JSON.parse(readFileSync(path, "utf8")) as { leases: Record<string, { expiresAt: string }> }).leases["flake:mine"]!.expiresAt;
      expect(await new Promise((done) => watcher.once("exit", done))).toBe(0);

      const read = (): string => (JSON.parse(readFileSync(path, "utf8")) as { leases: Record<string, { expiresAt: string }> }).leases["flake:mine"]!.expiresAt;
      // It renewed while the supervisor lived — more than once, which is what
      // separates a beat from a single renewal at startup.
      expect(Date.parse(read())).toBeGreaterThan(Date.parse(first));
      // And the renewal that outlived the supervisor is the last one: the beat
      // cannot hold a case open past the run, because the process is gone.
      expect(watcher.killed || watcher.exitCode !== null).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
