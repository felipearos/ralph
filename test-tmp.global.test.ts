// @vitest-environment node
/**
 * The run-root guard on a real run (#271): a child vitest, with
 * `test-tmp.global.ts` as its `globalSetup`, proving what the unit tests
 * cannot — that the redirect reaches the child's workers, that the root is
 * gone afterwards, and that a run which leaks past the census cap comes back
 * non-zero even though every test in it passed.
 *
 * That last part is the whole reason this file exists rather than a unit test
 * of `leakReport`: the census reports through `process.exitCode` from a
 * `globalSetup` teardown, the one path vitest swallows, and an assertion about
 * it is only worth anything from outside the process.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

import { RUN_ROOT_PREFIX } from "./test-tmp";
import { scratchDir } from "./test-scratch";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs a child vitest per case to prove the run-root guard fails the run");

const BUN = execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
const ROOT = import.meta.dirname;

/** A scratch root holding a one-file child suite and a config that loads the guard. */
function fixture(body: string): { dir: string; tmp: string } {
  const dir = scratchDir("ralph-run-root-guard-");
  // The child's own TMPDIR, so its run root is somewhere we can look afterwards
  // rather than inside this test's directory.
  const tmp = join(dir, "tmp");
  writeFileSync(join(dir, "fixture.test.ts"), body);
  writeFileSync(
    join(dir, "vitest.config.ts"),
    `export default { test: { globalSetup: [${JSON.stringify(join(ROOT, "test-tmp.global.ts"))}] } };\n`,
  );
  return { dir, tmp };
}

/** The child run's status and its combined output. */
function run(dir: string, tmp: string, env: Record<string, string> = {}): { status: number | null; out: string } {
  const child = spawnSync(BUN, ["x", "vitest", "run", "--root", dir], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", TMPDIR: tmp, ...env },
    timeout: 120_000,
  });
  return { status: child.status, out: `${child.stdout}${child.stderr}` };
}

/** A suite that makes `count` directories under `tmpdir()` and removes none. */
const leaks = (count: number): string =>
  [
    'import { mkdtempSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import { join } from "node:path";',
    'import { it, expect } from "vitest";',
    'it("leaves directories behind", () => {',
    `  for (let i = 0; i < ${count}; i++) mkdtempSync(join(tmpdir(), "leaky-"));`,
    "  expect(1).toBe(1);",
    "});",
    "",
  ].join("\n");

/** A suite that asserts the redirect reached it, and leaves nothing behind. */
const clean = [
  'import { tmpdir } from "node:os";',
  'import { basename } from "node:path";',
  'import { it, expect } from "vitest";',
  'it("runs inside the run root", () => {',
  '  expect(basename(tmpdir()).startsWith("ralph-test-run-")).toBe(true);',
  "});",
  "",
].join("\n");

describe("the run-root guard, on a real run", () => {
  it("redirects the child's workers into a run root and removes it afterwards", () => {
    const { dir, tmp } = fixture(clean);

    const child = run(dir, tmp);

    expect(child.status, child.out).toBe(0);
    expect(readdirSync(tmp).filter((name) => name.startsWith(RUN_ROOT_PREFIX))).toEqual([]);
  });

  it("fails the run when it leaks past the census cap, though every test passed", () => {
    const { dir, tmp } = fixture(leaks(3));

    const child = run(dir, tmp, { RALPH_TEST_TMP_LEAK_CAP: "1" });

    expect(child.out).toContain("1 passed");
    expect(child.status, child.out).toBe(1);
    expect(child.out).toContain("left 3 entries in its temp root (cap 1)");
    // The report names the prefix, so the suite at fault is findable.
    expect(child.out).toContain("leaky-*");
    // Removed even so: the census is a report about a run, not a reason to keep
    // the evidence on the host.
    expect(readdirSync(tmp).filter((name) => name.startsWith(RUN_ROOT_PREFIX))).toEqual([]);
  });

  it("passes the same leak under the standing cap, which is generous", () => {
    const { dir, tmp } = fixture(leaks(3));

    const child = run(dir, tmp);

    expect(child.status, child.out).toBe(0);
  });

  it("reaps a run root an abandoned run left behind", () => {
    const { dir, tmp } = fixture(clean);
    const stale = join(tmp, `${RUN_ROOT_PREFIX}20200101T000000-1`);
    writeFileSync(join(dir, "seed.txt"), "x");
    // Older than the two-hour window, as a run killed overnight would be.
    execFileSync("bash", ["-c", `mkdir -p ${JSON.stringify(stale)} && touch -d '3 hours ago' ${JSON.stringify(stale)}`]);

    const child = run(dir, tmp);

    expect(child.status, child.out).toBe(0);
    expect(existsSync(stale)).toBe(false);
    expect(basename(stale).startsWith(RUN_ROOT_PREFIX)).toBe(true);
  });
});
