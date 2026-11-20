// @vitest-environment node
/**
 * A project's sleep: one marker every worktree of the repository shares, read
 * as awake whenever it cannot be read at all.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { parseSleep, readSleep, sleep, sleepPathFor, sleepReason, viewOf, wake, SLEEP_FILE_NAME } from "./project-sleep";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs git and the project-sleep CLI through bun");

const scratch: string[] = [];
afterAll(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** The bun running this suite, by absolute path, as `controls.test.ts` finds it. */
const BUN = process.env.RALPH_TEST_BUN ?? ((): string => {
  try {
    return execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
  } catch {
    return process.execPath;
  }
})();
const CLI = join(__dirname, "project-sleep.ts");

function scratchDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ralph-sleep-${label}-`));
  scratch.push(dir);
  return dir;
}

/** A repository and one loop worktree of it: two checkouts, one project. */
function project(label: string): { main: string; loop: string } {
  const dir = scratchDir(label);
  const main = join(dir, "main");
  const loop = join(dir, "loop");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
  execFileSync("git", ["init", "-q", "-b", "main", main], { stdio: "ignore" });
  git(main, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root");
  git(main, "worktree", "add", "-q", "-b", "loop", loop);
  return { main, loop };
}

const cli = (cwd: string, ...args: string[]) =>
  spawnSync(BUN, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, RALPH_STATE_ROOT: cwd } });

describe("the marker", () => {
  it("is kept as it was by a second sleep, and gone after a wake that is safe to repeat", () => {
    const path = join(scratchDir("marker"), SLEEP_FILE_NAME);
    const first = sleep(path, { why: "bedtime", by: "dashboard", now: new Date("2026-11-05T23:00:00Z") });
    expect(first).toEqual({ since: "2026-11-05T23:00:00.000Z", why: "bedtime", by: "dashboard" });
    expect(sleep(path, { why: "again", now: new Date("2026-11-06T01:00:00Z") })).toEqual(first);
    expect(readSleep(path)).toEqual(first);
    wake(path);
    expect(readSleep(path)).toBeNull();
    expect(() => wake(path)).not.toThrow();
  });

  it("reads anything it cannot make sense of as awake", () => {
    expect(parseSleep("{ half")).toBeNull();
    expect(parseSleep("[]")).toBeNull();
    expect(parseSleep(JSON.stringify({ version: 2, since: "2026-11-05T23:00:00Z" }))).toBeNull();
    expect(parseSleep(JSON.stringify({ version: 1, since: "yesterday-ish" }))).toBeNull();
    expect(parseSleep(JSON.stringify({ version: 1, since: "2026-11-05T23:00:00Z", why: "  " }))).toEqual({
      since: "2026-11-05T23:00:00Z",
      why: null,
      by: null,
    });
  });

  it("says how to wake it in the reason a loop shows", () => {
    expect(sleepReason({ since: "2026-11-05T23:00:00Z", why: "bedtime", by: "dashboard" })).toBe(
      "the project is asleep since 2026-11-05T23:00:00Z by dashboard — bedtime; wake it to go on",
    );
    expect(viewOf(null)).toEqual({ version: 1, asleep: false, since: null, why: null, by: null });
  });
});

describe("the CLI", () => {
  it("puts every worktree of the project to sleep at once, and wakes them all", () => {
    const { main, loop } = project("shared");
    expect(sleepPathFor(loop)).toBe(sleepPathFor(main));
    expect(JSON.parse(cli(main, "status", "--json").stdout)).toMatchObject({ asleep: false });

    const slept = cli(main, "sleep", "--why", "bedtime", "--by", "dashboard", "--json");
    expect(slept.status).toBe(0);
    expect(JSON.parse(slept.stdout)).toMatchObject({ version: 1, asleep: true, why: "bedtime", by: "dashboard" });
    // The loop's worktree sees the sleep its main checkout took.
    expect(JSON.parse(cli(loop, "status", "--json").stdout)).toMatchObject({ asleep: true, why: "bedtime" });

    expect(JSON.parse(cli(loop, "wake", "--json").stdout)).toMatchObject({ asleep: false });
    expect(JSON.parse(cli(main, "status", "--json").stdout)).toMatchObject({ asleep: false });
  });

  it("says a marker it ignores is there, rather than hiding it", () => {
    const { main } = project("garbled");
    writeFileSync(sleepPathFor(main), "{ half");
    const status = cli(main, "status");
    expect(status.status).toBe(0);
    expect(status.stdout).toContain("unreadable");
  });

  it("refuses a subcommand it does not know", () => {
    const { main } = project("usage");
    expect(cli(main, "snooze").status).toBe(64);
  });
});
