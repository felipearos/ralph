// @vitest-environment node
/**
 * The blocker store (#429, for #416): the shared record of which loops wait on
 * which external blocker, so one escalation can speak for all of them.
 *
 * Every test writes into its own temp directory or fixture checkout, never
 * into this repository's git dir or `.ralph/`.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { subprocessSuite } from "./test-timeouts";

import {
  blockerStorePath,
  emptyStore,
  join,
  leave,
  listStore,
  main,
  markCleared,
  markExhausted,
  markNotified,
  prune,
  readStore,
  type Store,
  withStore,
} from "./blocker-store";

subprocessSuite("git for the fixture checkout, and bun for concurrent CLI joins");

const SCRIPT = fileURLToPath(new URL("./blocker-store.ts", import.meta.url));
const roots: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(joinPath(tmpdir(), "blocker-store-"));
  roots.push(dir);
  return dir;
};
const storeFile = (): string => joinPath(tempDir(), "ralph-blockers.json");
const readFile = (path: string): Store => JSON.parse(readFileSync(path, "utf8")) as Store;

afterAll(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { vi.restoreAllMocks(); });

const T0 = "2026-10-22T10:00:00.000Z";
const T1 = "2026-10-22T10:05:00.000Z";
const T2 = "2026-10-22T10:10:00.000Z";
const here = { pid: process.pid, host: process.env.HOSTNAME ?? hostname() };
const allAlive = (): boolean => true;

/** A pid that certainly belonged to a process on this host and is now gone. */
function deadPid(): number {
  const child = spawnSync("true");
  if (!child.pid) throw new Error("could not spawn a short-lived process");
  return child.pid;
}

describe("blockerStorePath", () => {
  it("resolves one file in git's common directory from every worktree of a checkout", () => {
    const root = tempDir();
    const primary = joinPath(root, "main");
    mkdirSync(primary);
    const git = (cwd: string, ...args: string[]): void => {
      execFileSync("git", args, { cwd, stdio: "ignore" });
    };
    git(primary, "init", "-q", "-b", "main");
    writeFileSync(joinPath(primary, "README"), "fixture\n");
    git(primary, "add", "README");
    git(primary, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
    git(primary, "worktree", "add", "-q", joinPath(root, "other"), "-b", "other");

    const fromMain = blockerStorePath(primary);
    const fromOther = blockerStorePath(joinPath(root, "other"));
    expect(fromOther).toBe(fromMain);
    expect(fromMain.endsWith("/ralph-blockers.json")).toBe(true);
    expect(fromMain.startsWith(realpathSync(root))).toBe(true);
  });
});

describe("mutators", () => {
  it("are pure over a Store value, and several run in one critical section with a single write", async () => {
    const plain = emptyStore();
    join(plain, { key: "k", loop: "a", ...here }, T0);
    expect(markNotified(plain, "k", T1)).toBe(true);
    expect(plain.blockers.k?.notified).toBe(T1);

    const path = storeFile();
    await withStore(path, (store) => {
      join(store, { key: "ci:test", loop: "a", ...here, summary: "test fails on main" }, T0);
      markNotified(store, "ci:test", T1);
    });
    const written = readFile(path);
    expect(written.blockers["ci:test"]?.waiters.a?.loop).toBe("a");
    expect(written.blockers["ci:test"]?.notified).toBe(T1);
    expect(written.blockers["ci:test"]?.summary).toBe("test fails on main");
  });

  it("join is idempotent per loop and key: one waiter, only lastSeen moves", () => {
    const store = emptyStore();
    join(store, { key: "k", loop: "a", ...here, pr: 7, baseSha: "abc", baseFailing: true }, T0);
    markNotified(store, "k", T0);
    const before = structuredClone(store.blockers.k);
    join(store, { key: "k", loop: "a", ...here, baseSha: "def", baseFailing: false }, T1);

    const after = store.blockers.k!;
    expect(Object.keys(after.waiters)).toEqual(["a"]);
    expect(after.waiters.a).toEqual({ ...before!.waiters.a, lastSeen: T1 });
    expect(after.first).toBe(T0);
    expect(after.baseSha).toBe("abc");
    expect(after.baseFailing).toBe(true);
    expect(after.notified).toBe(T0);

    join(store, { key: "k", loop: "b", ...here }, T1);
    expect(Object.keys(store.blockers.k!.waiters).sort()).toEqual(["a", "b"]);
  });

  it("a join on a cleared blocker opens a new episode with only the joining loop", () => {
    const store = emptyStore();
    join(store, { key: "k", loop: "a", ...here, baseSha: "abc", baseFailing: true }, T0);
    join(store, { key: "k", loop: "b", ...here }, T0);
    markNotified(store, "k", T0);
    markExhausted(store, "k", T0);
    markCleared(store, "k", T1);

    join(store, { key: "k", loop: "b", ...here, baseSha: "def", baseFailing: false }, T2);
    const blocker = store.blockers.k!;
    expect(blocker.first).toBe(T2);
    expect(blocker.baseSha).toBe("def");
    expect(blocker.baseFailing).toBe(false);
    expect(blocker.notified).toBeNull();
    expect(blocker.exhaustedNotified).toBeNull();
    expect(blocker.clearedAt).toBeNull();
    expect(Object.keys(blocker.waiters)).toEqual(["b"]);
    expect(blocker.waiters.b?.since).toBe(T2);

    // Not given again → not known, rather than carried over from the old episode.
    markCleared(store, "k", T2);
    join(store, { key: "k", loop: "a", ...here }, T2);
    expect(store.blockers.k?.baseSha).toBeNull();
    expect(store.blockers.k?.baseFailing).toBeNull();
  });

  it("markNotified, markExhausted and markCleared set their field once, and a later join keeps them", () => {
    const store = emptyStore();
    expect(markNotified(store, "missing", T0)).toBe(false);
    join(store, { key: "k", loop: "a", ...here }, T0);
    expect(markNotified(store, "k", T0)).toBe(true);
    expect(markNotified(store, "k", T1)).toBe(false);
    expect(markExhausted(store, "k", T0)).toBe(true);
    expect(markExhausted(store, "k", T1)).toBe(false);
    join(store, { key: "k", loop: "b", ...here }, T1);
    expect(store.blockers.k?.notified).toBe(T0);
    expect(store.blockers.k?.exhaustedNotified).toBe(T0);
    expect(markCleared(store, "k", T1)).toBe(true);
    expect(markCleared(store, "k", T2)).toBe(false);
    expect(store.blockers.k?.clearedAt).toBe(T1);
  });

  it("leave drops the waiter, and the blocker with its last one", () => {
    const store = emptyStore();
    join(store, { key: "k", loop: "a", ...here }, T0);
    join(store, { key: "k", loop: "b", ...here }, T0);
    expect(leave(store, "k", "a")).toBe(true);
    expect(Object.keys(store.blockers.k!.waiters)).toEqual(["b"]);
    expect(leave(store, "k", "a")).toBe(false);
    expect(leave(store, "k", "b")).toBe(true);
    expect(store.blockers.k).toBeUndefined();
  });

  it("prune uses the injected liveness and drops emptied blockers", () => {
    const store = emptyStore();
    join(store, { key: "k", loop: "a", pid: 1, host: "h" }, T0);
    join(store, { key: "k", loop: "b", pid: 2, host: "h" }, T0);
    join(store, { key: "j", loop: "c", pid: 3, host: "h" }, T0);
    expect(prune(store, ({ pid }) => pid === 1)).toBe(2);
    expect(Object.keys(store.blockers)).toEqual(["k"]);
    expect(Object.keys(store.blockers.k!.waiters)).toEqual(["a"]);
  });
});

describe("the file", () => {
  it("prunes a dead waiter on this host on the next read, keeps one on another host, and drops an emptied blocker", async () => {
    const path = storeFile();
    const dead = deadPid();
    await withStore(path, (store) => {
      join(store, { key: "shared", loop: "dead", pid: dead, host: here.host }, T0);
      join(store, { key: "shared", loop: "remote", pid: dead, host: "some-other-host.invalid" }, T0);
      join(store, { key: "lonely", loop: "dead", pid: dead, host: here.host }, T0);
    }, allAlive);

    const store = await listStore(path);
    expect(Object.keys(store.blockers)).toEqual(["shared"]);
    expect(Object.keys(store.blockers.shared!.waiters)).toEqual(["remote"]);
    // The pruning is written back, not only returned.
    expect(Object.keys(readFile(path).blockers)).toEqual(["shared"]);
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["malformed", "{not json"],
    ["of another version", JSON.stringify({ version: 2, blockers: {} })],
    ["with a null waiter", JSON.stringify({ version: 1, blockers: { k: { first: T0, waiters: { a: null } } } })],
    ["with a blocker that is not a record", JSON.stringify({ version: 1, blockers: { k: 3 } })],
  ])("a %s file reads as empty, and the next write repairs it", async (_label, content) => {
    const path = storeFile();
    if (content !== null) writeFileSync(path, content);
    await withStore(path, () => {});
    expect(readStore(path)).toEqual(emptyStore());
    await withStore(path, (store) => { join(store, { key: "k", loop: "a", ...here }, T0); });
    const repaired = readFile(path);
    expect(repaired.version).toBe(1);
    expect(Object.keys(repaired.blockers)).toEqual(["k"]);
  });

  it("reads a blocker missing its set-once fields as null, so the episode and its marks still work", async () => {
    const path = storeFile();
    writeFileSync(path, JSON.stringify({ version: 1, blockers: { k: {
      key: "k", first: T0, waiters: { a: { loop: "a", pr: null, ...here, since: T0, lastSeen: T0 } },
    } } }));
    const blocker = await withStore(path, (store) => {
      join(store, { key: "k", loop: "b", ...here }, T1);
      markNotified(store, "k", T1);
      return store.blockers.k!;
    });
    expect(blocker.first).toBe(T0);
    expect(blocker.notified).toBe(T1);
    expect(Object.keys(blocker.waiters).sort()).toEqual(["a", "b"]);
  });
});

describe("CLI", () => {
  const run = (path: string, loop: string): Promise<number | null> =>
    new Promise((done, fail) => {
      const child = spawn("bun", [SCRIPT, "join", "--key", "k", "--loop", loop], {
        env: { ...process.env, RALPH_BLOCKER_STORE: path, RALPH_SUPERVISOR_PID: String(process.pid) },
        stdio: "ignore",
      });
      child.on("error", fail);
      child.on("exit", done);
    });

  it("two bun processes joining one key together both survive", async () => {
    const path = storeFile();
    const codes = await Promise.all([run(path, "a"), run(path, "b")]);
    expect(codes).toEqual([0, 0]);
    expect(Object.keys(readFile(path).blockers.k!.waiters).sort()).toEqual(["a", "b"]);
  });

  it("prints the blocker as JSON and records pid and host from identity()", async () => {
    const path = storeFile();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = { RALPH_BLOCKER_STORE: path, RALPH_SUPERVISOR_PID: String(process.pid) };
    const code = await main([
      "join", "--key", "ci:test", "--loop", "rafa", "--pr", "12", "--summary", "red main",
      "--base-sha", "abc", "--base-failing", "true", "--json",
    ], env);
    expect(code).toBe(0);
    const blocker = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as Store["blockers"][string];
    expect(blocker.key).toBe("ci:test");
    expect(blocker.summary).toBe("red main");
    expect(blocker.baseSha).toBe("abc");
    expect(blocker.baseFailing).toBe(true);
    expect(blocker.waiters.rafa).toMatchObject({ loop: "rafa", pr: 12, pid: process.pid, host: here.host });

    expect(await main(["list", "--json"], env)).toBe(0);
    const listed = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as Store;
    expect(Object.keys(listed.blockers)).toEqual(["ci:test"]);

    expect(await main(["leave", "--key", "ci:test", "--loop", "rafa"], env)).toBe(0);
    expect(readFile(path).blockers).toEqual({});
  });

  it.each([
    [["join", "--loop", "rafa"]],
    [["join", "--key", "k"]],
    [["leave", "--key", "k"]],
    [["join", "--key", "k", "--loop", "rafa", "--pr", "nope"]],
    [["join", "--key", "k", "--loop", "rafa", "--base-failing", "maybe"]],
    [["frobnicate"]],
  ])("exits 64 on a usage error: %j", async (argv) => {
    const path = storeFile();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(argv, { RALPH_BLOCKER_STORE: path, RALPH_SUPERVISOR_PID: String(process.pid) })).toBe(64);
    expect(String(err.mock.calls[0]?.[0])).toContain("usage:");
  });

  it("refuses a join without RALPH_SUPERVISOR_PID rather than record a pid the next read prunes", async () => {
    const path = storeFile();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["join", "--key", "k", "--loop", "rafa"], { RALPH_BLOCKER_STORE: path })).toBe(64);
    expect(err.mock.calls.map(String).join("\n")).toContain("RALPH_SUPERVISOR_PID");
    expect(readStore(path)).toEqual(emptyStore());
  });
});
