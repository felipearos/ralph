// @vitest-environment node
/**
 * The case lease, pinned — including the two-doctor race the acceptance
 * criterion names.
 *
 * The race is expressed the way `claim-race.test.ts` expresses it: not with
 * two processes, but by running two takes against ONE real store file through
 * the real lock, and asserting exactly one of them comes away with the case.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { free, heldElsewhere, supervisorPid, takeCaseLease, type Holder } from "./case-lease";
import { CASE_LEASE_SECONDS, readStore, withStore, type Lease } from "./store";

const T0 = Date.parse("2026-09-30T10:00:00.000Z");
const RALPH: Holder = { run: "run-a", loop: "ralph", pid: 4242, host: "fedora" };
const RAFA: Holder = { run: "run-b", loop: "rafa", pid: 4343, host: "fedora" };
const KEY = "flake:src/a.test.ts > flaps";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function storeFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "case-lease-"));
  dirs.push(dir);
  return join(dir, "ralph", "ci-health.json");
}

const leaseFor = (holder: Holder, expiresAtMs: number): Lease => ({
  run: holder.run,
  loop: holder.loop,
  pid: holder.pid ?? 1,
  host: holder.host ?? "fedora",
  expiresAt: new Date(expiresAtMs).toISOString(),
});

const dead = () => false;
const living = () => true;

describe("free", () => {
  it("is true for a case nobody holds", () => {
    expect(free({}, KEY, RALPH, T0, living)).toBe(true);
  });

  it("is true for this holder's own live lease — a doctor resumes its own case", () => {
    const leases = { [KEY]: leaseFor(RALPH, T0 + 60_000) };
    expect(free(leases, KEY, RALPH, T0, living)).toBe(true);
  });

  it("is false for another doctor's live lease", () => {
    const leases = { [KEY]: leaseFor(RAFA, T0 + 60_000) };
    expect(free(leases, KEY, RALPH, T0, living)).toBe(false);
  });

  it("is true once another doctor's lease has expired, however alive it looks", () => {
    const leases = { [KEY]: leaseFor(RAFA, T0 - 1) };
    expect(free(leases, KEY, RALPH, T0, living)).toBe(true);
  });

  it("is true when the holder is gone, without waiting out the expiry", () => {
    const leases = { [KEY]: leaseFor(RAFA, T0 + 60_000) };
    expect(free(leases, KEY, RALPH, T0, dead)).toBe(true);
  });

  it("falls back to the holder's liveness when the expiry cannot be read", () => {
    const leases = { [KEY]: { ...leaseFor(RAFA, T0), expiresAt: "whenever" } };
    expect(free(leases, KEY, RALPH, T0, living)).toBe(false);
    expect(free(leases, KEY, RALPH, T0, dead)).toBe(true);
  });
});

describe("heldElsewhere", () => {
  it("names every case this doctor must skip, and no others", () => {
    const leases = {
      "flake:a": leaseFor(RAFA, T0 + 60_000),
      "flake:b": leaseFor(RALPH, T0 + 60_000),
      "flake:c": leaseFor(RAFA, T0 - 1),
    };
    expect(heldElsewhere(leases, RALPH, T0, living)).toEqual(["flake:a"]);
  });
});

describe("supervisorPid", () => {
  it("is the supervisor's, not this process's — the gate exits before the case is worked", () => {
    // Recorded as `process.pid`, the lease named a process that was already
    // gone by the time the iteration started, and a second doctor took the
    // case out from under it.
    expect(supervisorPid({ RALPH_SUPERVISOR_PID: "4242" })).toBe(4242);
    expect(supervisorPid({})).toBe(process.ppid || process.pid);
    expect(supervisorPid({ RALPH_SUPERVISOR_PID: "not a pid" })).toBe(process.ppid || process.pid);
  });

  it("is what a lease taken with no explicit holder records", async () => {
    const path = storeFile();
    process.env.RALPH_SUPERVISOR_PID = "4242";
    try {
      await takeCaseLease(path, KEY, { run: "run-a", loop: "ralph" }, { nowMs: T0, alive: living });
    } finally {
      delete process.env.RALPH_SUPERVISOR_PID;
    }
    expect(readStore(path).leases[KEY]?.pid).toBe(4242);
  });
});

describe("takeCaseLease", () => {
  it("records the holder and the expiry", async () => {
    const path = storeFile();
    const result = await takeCaseLease(path, KEY, RALPH, { nowMs: T0, alive: living });
    expect(result.taken).toBe(true);
    expect(readStore(path).leases[KEY]).toEqual({
      run: "run-a",
      loop: "ralph",
      pid: 4242,
      host: "fedora",
      expiresAt: new Date(T0 + CASE_LEASE_SECONDS * 1000).toISOString(),
    });
  });

  it("hands a case to exactly one of two doctors racing for it", async () => {
    const path = storeFile();
    const [first, second] = await Promise.all([
      takeCaseLease(path, KEY, RALPH, { nowMs: T0, alive: living }),
      takeCaseLease(path, KEY, RAFA, { nowMs: T0, alive: living }),
    ]);
    expect([first.taken, second.taken].filter(Boolean)).toHaveLength(1);

    const winner = first.taken ? RALPH : RAFA;
    const loser = first.taken ? second : first;
    expect(readStore(path).leases[KEY]?.loop).toBe(winner.loop);
    // The loser learns who has it, so its gate can say so rather than wait blind.
    expect(loser.holder?.loop).toBe(winner.loop);
  });

  it("lets two doctors hold two different cases at once", async () => {
    const path = storeFile();
    const [a, b] = await Promise.all([
      takeCaseLease(path, "flake:a", RALPH, { nowMs: T0, alive: living }),
      takeCaseLease(path, "flake:b", RAFA, { nowMs: T0, alive: living }),
    ]);
    expect([a.taken, b.taken]).toEqual([true, true]);
    expect(Object.keys(readStore(path).leases).sort()).toEqual(["flake:a", "flake:b"]);
  });

  it("takes over an expired lease, and leaves every other lease where it is", async () => {
    const path = storeFile();
    await withStore(path, (store) => {
      store.leases = { [KEY]: leaseFor(RAFA, T0 - 1), "flake:other": leaseFor(RAFA, T0 + 60_000) };
    });
    const result = await takeCaseLease(path, KEY, RALPH, { nowMs: T0, alive: living });
    expect(result.taken).toBe(true);
    expect(readStore(path).leases[KEY]?.loop).toBe("ralph");
    // Pruning is `role-leases.ts`'s on the heartbeat; the gate touches one key.
    expect(readStore(path).leases["flake:other"]).toEqual(leaseFor(RAFA, T0 + 60_000));
  });

  it("renews rather than duplicates when the same doctor takes it again", async () => {
    const path = storeFile();
    await takeCaseLease(path, KEY, RALPH, { nowMs: T0, alive: living });
    const again = await takeCaseLease(path, KEY, RALPH, { nowMs: T0 + 30_000, alive: living });
    expect(again.taken).toBe(true);
    expect(readStore(path).leases[KEY]?.expiresAt).toBe(
      new Date(T0 + 30_000 + CASE_LEASE_SECONDS * 1000).toISOString(),
    );
  });
});
