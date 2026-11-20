// @vitest-environment node
/**
 * The raised budget for subprocess suites must not hide a real hang (#187).
 *
 * The proof runs Vitest itself, as a child, on a throwaway suite that declares
 * itself a subprocess suite and then waits on a child process that never
 * exits. The run must fail that test with Vitest's own timeout, well before the
 * child would have finished, and still pass the suite's healthy test.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { SUBPROCESS_TEST_TIMEOUT_MS, subprocessSuite } from "./test-timeouts";

subprocessSuite("runs Vitest itself on a deliberately hanging suite");

const ROOT = import.meta.dirname;
const BUN = execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a subprocess suite's budget", () => {
  it("is finite, above Vitest's 5 s default, and short enough that a hang fails within a minute", () => {
    expect(Number.isFinite(SUBPROCESS_TEST_TIMEOUT_MS)).toBe(true);
    expect(SUBPROCESS_TEST_TIMEOUT_MS).toBeGreaterThan(5_000);
    expect(SUBPROCESS_TEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it("cannot be declared without a reason, or as no timeout at all", () => {
    expect(() => subprocessSuite("")).toThrow(/name what the suite spawns/);
    expect(() => subprocessSuite("   ")).toThrow(/name what the suite spawns/);
    // Vitest reads 0 as "no timeout"; Infinity and NaN are no better.
    for (const bad of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => subprocessSuite("spawns bash", bad)).toThrow(/finite positive/);
    }
  });

  it("still fails a test that hangs on a child process that never exits", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-hang-proof-"));
    scratch.push(dir);
    // The fixture resolves `vitest` through this link to the same real module
    // the helper imports, so `subprocessSuite` configures the run under test.
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
    const pidFile = join(dir, "child.pid");
    writeFileSync(
      join(dir, "hang.test.ts"),
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'import { it } from "vitest";',
        `import { subprocessSuite } from ${JSON.stringify(join(ROOT, "test-timeouts.ts"))};`,
        "",
        'subprocessSuite("waits on a child that never exits, on purpose", 1_000);',
        "",
        'it("finishes when its child does", async () => {',
        '  await new Promise((resolve) => spawn("true").on("close", resolve));',
        "});",
        "",
        'it("hangs on a child that never exits", async () => {',
        '  const child = spawn("sleep", ["120"], { stdio: "ignore" });',
        `  writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        '  await new Promise((resolve) => child.on("close", resolve));',
        "});",
        "",
      ].join("\n"),
    );

    const started = Date.now();
    const run = spawnSync(BUN, ["x", "vitest", "run", "--root", dir, "--maxWorkers=1"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      timeout: 25_000,
    });
    const elapsed = Date.now() - started;
    try {
      process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
    } catch {
      // Already gone, or never started; either way nothing is left running.
    }
    // CI runners force colour whatever FORCE_COLOR says, so match on plain text.
    // eslint-disable-next-line no-control-regex
    const output = (run.stdout + run.stderr).replace(/\u001b\[[0-9;]*m/g, "");

    expect(run.error, output).toBeUndefined();
    expect(run.status, output).toBe(1);
    expect(output).toMatch(/FAIL .*hang\.test\.ts > hangs on a child that never exits/);
    expect(output).toMatch(/Test timed out in 1000ms/);
    expect(output).toMatch(/Tests +1 failed \| 1 passed \(2\)/);
    // Failed by the timeout, not by the child finishing 120 s later.
    expect(elapsed).toBeLessThan(25_000);
  });
});
