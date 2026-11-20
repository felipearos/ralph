import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readLeaseStore, writeLeaseStore, type ClaimLease } from "../claim-lease";
import {
  adoptComment,
  adoptIdentityFrom,
  adoptionMarker,
  handbackComment,
  parseUnattended,
  pickOrphan,
  readUnattended,
  releaseAdoptedLease,
  said,
  takeAdoptedLease,
  ticketOf,
} from "./adoption";

const NOW = Date.parse("2026-10-22T12:00:00.000Z");
const MEDIC = { run: "run-medic", loop: "medi", pid: 4242 };

describe("parseUnattended", () => {
  it("keys the loops by name", () => {
    const parsed = parseUnattended(JSON.stringify([
      { loop: "rafa", stopKind: "failed", downSince: "2026-10-22T10:00:00.000Z" },
      { loop: "remo", stopKind: null, downSince: "2026-10-22T11:00:00.000Z" },
    ]));
    expect(parsed?.get("rafa")?.stopKind).toBe("failed");
    expect(parsed?.get("remo")?.stopKind).toBeNull();
    expect(parsed?.size).toBe(2);
  });

  it("reads an empty array as nobody unattended", () => {
    expect(parseUnattended("[]")?.size).toBe(0);
  });

  it("is null on garbage or the wrong shape", () => {
    expect(parseUnattended("not json")).toBeNull();
    expect(parseUnattended("{}")).toBeNull();
    expect(parseUnattended("[null]")).toBeNull();
    expect(parseUnattended(JSON.stringify([{ stopKind: null, downSince: "x" }]))).toBeNull();
    expect(parseUnattended(JSON.stringify([{ loop: "rafa", stopKind: null }]))).toBeNull();
    expect(parseUnattended(JSON.stringify([{ loop: "rafa", stopKind: 3, downSince: "x" }]))).toBeNull();
    expect(parseUnattended(JSON.stringify([{ loop: "rafa", downSince: "x" }]))).toBeNull();
  });
});

describe("readUnattended", () => {
  const ok = JSON.stringify([{ loop: "rafa", stopKind: "failed", downSince: "2026-10-22T10:00:00.000Z" }]);

  it("asks loop-state.ts unattended --json through bun", () => {
    const calls: [string, string[]][] = [];
    const parsed = readUnattended((command, args) => {
      calls.push([command, args]);
      return { status: 0, stdout: ok, stderr: "" };
    });
    expect(parsed?.has("rafa")).toBe(true);
    const [command, args] = calls[0] ?? ["", []];
    expect(command).toBe("bun");
    expect(args[0]).toMatch(/loop-state\.ts$/);
    expect(args.slice(1)).toEqual(["unattended", "--json"]);
  });

  it("is null on a non-zero exit, a throw or garbage", () => {
    expect(readUnattended(() => ({ status: 1, stdout: ok, stderr: "boom" }))).toBeNull();
    expect(readUnattended(() => { throw new Error("spawn failed"); })).toBeNull();
    expect(readUnattended(() => ({ status: 0, stdout: "garbage", stderr: "" }))).toBeNull();
  });
});

describe("ticketOf", () => {
  it("reads the issue of the owner's agent branch", () => {
    expect(ticketOf("rafa/123-fix-the-thing", "rafa")).toBe(123);
    expect(ticketOf("rafa/7", "rafa")).toBe(7);
  });

  it("is null for any other branch", () => {
    expect(ticketOf("rafa/fix-x", "rafa")).toBeNull();
    expect(ticketOf("rafa/0-x", "rafa")).toBeNull();
    expect(ticketOf("rafa/012-x", "rafa")).toBeNull();
    expect(ticketOf("other/12-x", "rafa")).toBeNull();
    expect(ticketOf("xrafa/12-x", "rafa")).toBeNull();
    expect(ticketOf("rafa/12x", "rafa")).toBeNull();
    expect(ticketOf("rafa/12-", "rafa")).toBeNull();
  });
});

describe("the adopted lease", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "adoption-lease-"));
    path = join(dir, "ralph-claim-leases.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const ownerLease = (issue: number, expiresAt: string): ClaimLease => ({
    version: 1, issue, run: "run-owner", owner: "rafa@host", loop: "rafa", pid: 999, host: "host",
    worktree: "/w/rafa", branch: `rafa/${issue}-x`, claim: "rafa-wip", logs: ".ralph/logs",
    usageLedger: ".ralph/logs/usage-ledger.tsv", claimedAt: new Date(NOW - 600_000).toISOString(),
    heartbeatAt: new Date(NOW - 600_000).toISOString(), expiresAt, attempt: 1, history: [],
  });
  const take = (issue: number, pidAlive?: (pid: number) => boolean) =>
    takeAdoptedLease(path, { issue, identity: MEDIC, worktree: dir, branch: `rafa/${issue}-x`, nowMs: NOW, pidAlive });

  it("takes an absent lease under the supervisor's pid", () => {
    expect(take(12)).toEqual({ ok: true });
    const lease = readLeaseStore(path).leases["12"]!;
    expect(lease.loop).toBe("medi");
    expect(lease.run).toBe("run-medic");
    expect(lease.pid).toBe(4242);
  });

  it("takes over an expired owner lease", () => {
    writeLeaseStore(path, { version: 1, leases: { "12": ownerLease(12, new Date(NOW - 60_000).toISOString()) } });
    expect(take(12, () => false)).toEqual({ ok: true });
    const lease = readLeaseStore(path).leases["12"]!;
    expect(lease.loop).toBe("medi");
    expect(lease.history.map((attempt) => attempt.loop)).toEqual(["rafa"]);
  });

  it("refuses a live owner lease, naming its loop and status", () => {
    writeLeaseStore(path, { version: 1, leases: { "12": ownerLease(12, new Date(NOW - 60_000).toISOString()) } });
    const result = take(12, () => true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.why).toMatch(/rafa.*slow/);
    expect(readLeaseStore(path).leases["12"]?.loop).toBe("rafa");
  });

  it("refuses a second adoption while one is held, and retakes the same issue", () => {
    expect(take(12)).toEqual({ ok: true });
    const second = take(13);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.why).toContain("#12");
    expect(readLeaseStore(path).leases["13"]).toBeUndefined();
    expect(take(12)).toEqual({ ok: true });
  });

  it("refuses rather than throws on a lock that is busy or a store that is unreadable", () => {
    writeFileSync(join(dir, "next-tasks-claim.lock"), "");
    expect(take(12)).toEqual({ ok: false, why: "the lease store is locked" });
    rmSync(join(dir, "next-tasks-claim.lock"));
    writeFileSync(path, "{ not json");
    expect(take(12).ok).toBe(false);
  });

  it("releases only this run and loop's lease", () => {
    writeLeaseStore(path, { version: 1, leases: { "13": ownerLease(13, new Date(NOW + 60_000).toISOString()) } });
    expect(take(12)).toEqual({ ok: true });
    expect(releaseAdoptedLease(path, 13, MEDIC)).toBe("none");
    expect(releaseAdoptedLease(path, 12, { run: "other-run", loop: "medi" })).toBe("none");
    expect(releaseAdoptedLease(path, 12, MEDIC)).toBe("released");
    const leases = readLeaseStore(path).leases;
    expect(leases["12"]).toBeUndefined();
    expect(leases["13"]?.loop).toBe("rafa");
    expect(releaseAdoptedLease(path, 12, MEDIC)).toBe("none");
  });

  it("reports a release the busy lock refused as failed, and keeps the lease", () => {
    expect(take(12)).toEqual({ ok: true });
    writeFileSync(join(dir, "next-tasks-claim.lock"), "");
    expect(releaseAdoptedLease(path, 12, MEDIC)).toBe("failed");
    rmSync(join(dir, "next-tasks-claim.lock"));
    expect(readLeaseStore(path).leases["12"]?.loop).toBe("medi");
  });
});

describe("adoptIdentityFrom", () => {
  it("reads the run, loop and supervisor pid", () => {
    expect(adoptIdentityFrom({ RALPH_RUN_ID: "r", RALPH_LOOP_NAME: "medi", RALPH_SUPERVISOR_PID: "77" }))
      .toEqual({ run: "r", loop: "medi", pid: 77 });
  });

  it("is null when any is missing or the pid is not a positive integer", () => {
    expect(adoptIdentityFrom({ RALPH_LOOP_NAME: "medi", RALPH_SUPERVISOR_PID: "77" })).toBeNull();
    expect(adoptIdentityFrom({ RALPH_RUN_ID: "r", RALPH_SUPERVISOR_PID: "77" })).toBeNull();
    expect(adoptIdentityFrom({ RALPH_RUN_ID: "r", RALPH_LOOP_NAME: "medi" })).toBeNull();
    expect(adoptIdentityFrom({ RALPH_RUN_ID: "r", RALPH_LOOP_NAME: "medi", RALPH_SUPERVISOR_PID: "0" })).toBeNull();
    expect(adoptIdentityFrom({ RALPH_RUN_ID: "r", RALPH_LOOP_NAME: "medi", RALPH_SUPERVISOR_PID: "-3" })).toBeNull();
    expect(adoptIdentityFrom({ RALPH_RUN_ID: "r", RALPH_LOOP_NAME: "medi", RALPH_SUPERVISOR_PID: "x" })).toBeNull();
  });
});

describe("pickOrphan", () => {
  it("takes the migration-applied one first", () => {
    const prs = [
      { number: 5 },
      { number: 9, labels: [{ name: "migration-applied" }] },
      { number: 3, labels: [{ name: "other" }] },
    ];
    expect(pickOrphan(prs)?.number).toBe(9);
    expect(prs.map((pr) => pr.number)).toEqual([5, 9, 3]);
  });

  it("then the lowest number", () => {
    expect(pickOrphan([{ number: 8 }, { number: 3 }, { number: 5 }])?.number).toBe(3);
    expect(pickOrphan([
      { number: 8, labels: [{ name: "migration-applied" }] },
      { number: 4, labels: [{ name: "migration-applied" }] },
      { number: 1 },
    ])?.number).toBe(4);
  });

  it("is null with nothing to pick", () => {
    expect(pickOrphan([])).toBeNull();
  });
});

describe("the comments", () => {
  const head = "abc123";

  it("adoptComment names the medic, the owner, why and how long, and ends with the marker", () => {
    const body = adoptComment({
      medic: "medi", owner: "rafa", stopKind: "failed",
      downSince: new Date(NOW - 90 * 60_000).toISOString(), nowMs: NOW, head,
    });
    expect(body).toContain("medi");
    expect(body).toContain("rafa");
    expect(body).toContain("failed");
    expect(body).toContain("1h30m");
    expect(body).toMatch(/never merges/);
    expect(body.endsWith(adoptionMarker("adopt", "medi", head))).toBe(true);
  });

  it("adoptComment says when there is no recorded ending", () => {
    const body = adoptComment({
      medic: "medi", owner: "rafa", stopKind: null,
      downSince: new Date(NOW - 45 * 60_000).toISOString(), nowMs: NOW, head,
    });
    expect(body).toContain("no recorded ending");
    expect(body).toContain("45m");
  });

  it("handbackComment ends with the handback marker", () => {
    const body = handbackComment({ medic: "medi", owner: "rafa", head });
    expect(body).toContain("rafa");
    expect(body.endsWith(adoptionMarker("handback", "medi", head))).toBe(true);
  });

  it("the marker has case.ts's shape, and said finds it", () => {
    const mark = adoptionMarker("adopt", "medi", head);
    expect(mark).toBe("<!-- pr-medic:adopt medi abc123 -->");
    expect(said([{ body: "x" }, { body: `hello\n${mark}` }], mark)).toBe(true);
    expect(said([{ body: "x" }, {}], mark)).toBe(false);
    expect(said(undefined, mark)).toBe(false);
  });
});
