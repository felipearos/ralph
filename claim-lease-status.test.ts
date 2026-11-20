// @vitest-environment node
/**
 * `claim-lease.ts status --json` is the read-only projection of the lease
 * store that the dashboard adapter consumes. Driven as the real CLI against a
 * real scratch repository, because the store's location comes from git.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { bunPath } from "./dashboard/fixtures";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs the lease-status CLI under bun against fixture git repos");

const CLI = join(__dirname, "claim-lease.ts");
const scratch: string[] = [];
afterAll(() => scratch.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function repo(): { root: string; store: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claim-lease-status-")));
  scratch.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return { root, store: join(root, ".git", "ralph-claim-leases.json") };
}

function status(root: string, args: string[] = ["status", "--json"]) {
  const env: Record<string, string | undefined> = { ...process.env, RALPH_STATE_ROOT: root };
  delete env.RALPH_RUN_ID;
  delete env.RALPH_LOOP_NAME;
  return spawnSync(bunPath(), [CLI, ...args], { cwd: __dirname, env, encoding: "utf8" });
}

const lease = (issue: number, loop: string) => ({
  version: 1, issue, run: `run-${loop}`, owner: `${loop}@desk`, loop, pid: null, host: "desk",
  worktree: `/checkout/${loop}`, branch: null, claim: `${loop}-wip`, logs: ".ralph/logs",
  usageLedger: ".ralph/logs/usage-ledger.tsv", claimedAt: "2026-09-13T11:00:00.000Z",
  heartbeatAt: "2026-09-13T11:59:00.000Z", expiresAt: "2026-09-13T12:01:00.000Z", attempt: 1, history: [],
});

describe("claim-lease status --json", () => {
  it("prints every lease in the git common directory's store, by issue", () => {
    const { root, store } = repo();
    writeFileSync(store, JSON.stringify({ version: 1, leases: { "12": lease(12, "rafa"), "7": lease(7, "ralph") } }));

    const result = status(root);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout) as { version: number; path: string; leases: { issue: number; loop: string }[] };
    expect(body.version).toBe(1);
    expect(body.path).toBe(store);
    expect(body.leases.map((entry) => [entry.issue, entry.loop])).toEqual([[7, "ralph"], [12, "rafa"]]);
  });

  it("needs no run identity and reports an absent store as no leases", () => {
    const { root, store } = repo();
    const result = status(root);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ version: 1, leases: [] });
    expect(existsSync(store)).toBe(false);
  });

  it("refuses an unsupported store rather than printing a guess", () => {
    const { root, store } = repo();
    writeFileSync(store, JSON.stringify({ version: 2, leases: {} }));
    const result = status(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unsupported lease store/);
  });

  it("writes nothing: no lock, no rewrite of the store", () => {
    const { root, store } = repo();
    writeFileSync(store, JSON.stringify({ version: 1, leases: { "7": lease(7, "ralph") } }));
    const before = statSync(store).mtimeMs;
    const entries = readdirSync(join(root, ".git")).sort();
    expect(status(root).status).toBe(0);
    expect(statSync(store).mtimeMs).toBe(before);
    expect(readdirSync(join(root, ".git")).sort()).toEqual(entries);
  });
});
