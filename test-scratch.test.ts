// @vitest-environment node
/**
 * The scratch helpers from #271: a directory per test and a directory per file,
 * each removed when its owner is done, and a removal that survives a child
 * still writing into the tree (#187).
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { fileScratchDir, scratchDir } from "./test-scratch";
import { RUN_ROOT_PREFIX, removeScratchDir } from "./test-tmp";

const seen: string[] = [];

// Registered BEFORE the `fileScratchDir` call below, deliberately: vitest runs
// `afterAll` hooks in reverse registration order, so this one runs last — after
// the removal it is checking. (That order is also why
// `test-config-home.setup.ts` is safe: a setup file registers before the test
// file it precedes, so its cleanup runs after the file's own.)
let forTheFile = "";
afterAll(() => {
  expect(existsSync(forTheFile)).toBe(false);
});

/** Made once for the file; proves `fileScratchDir` outlives its first test. */
forTheFile = fileScratchDir("ralph-scratch-file-");

describe("scratchDir", () => {
  it("hands out a directory inside the run's temp root", () => {
    const dir = scratchDir("ralph-scratch-one-");
    seen.push(dir);
    expect(existsSync(dir)).toBe(true);
    expect(basename(dir).startsWith("ralph-scratch-one-")).toBe(true);
    // The run root, so the whole thing goes even if a removal fails.
    expect(dir.split("/").some((part) => part.startsWith(RUN_ROOT_PREFIX))).toBe(true);
  });

  it("removed the directory the previous test was given", () => {
    expect(seen).toHaveLength(1);
    expect(existsSync(seen[0]!)).toBe(false);
  });

  it("gives each caller its own, and removes a tree with contents", () => {
    const first = scratchDir("ralph-scratch-two-");
    const second = scratchDir("ralph-scratch-two-");
    expect(first).not.toBe(second);
    mkdirSync(join(first, "nested"), { recursive: true });
    writeFileSync(join(first, "nested", "file.txt"), "x");
    seen.push(first, second);
  });

  it("removed both of them", () => {
    expect(seen.slice(1).every((dir) => !existsSync(dir))).toBe(true);
  });
});

describe("fileScratchDir", () => {
  it("is still there, test after test, because the file owns it", () => {
    writeFileSync(join(forTheFile, "kept.txt"), "x");
    expect(readdirSync(forTheFile)).toEqual(["kept.txt"]);
  });

  it("really is still there in the next test", () => {
    expect(readdirSync(forTheFile)).toEqual(["kept.txt"]);
  });
});

describe("removeScratchDir", () => {
  it("removes a directory a child is still writing into (#187)", async () => {
    const dir = scratchDir("ralph-scratch-writer-");
    const writer = spawn(
      "bash",
      ["-c", 'for i in $(seq 1 200); do mkdir "$1/d$i" 2>/dev/null && : > "$1/d$i/f" || exit 0; done', "writer", dir],
      { stdio: "ignore" },
    );
    const exited = new Promise((resolve) => writer.on("close", resolve));
    while (readdirSync(dir).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    removeScratchDir(dir);
    await exited;

    expect(existsSync(dir)).toBe(false);
  });

  it("takes its retry budget by name, so .forEach cannot pass the index as it", () => {
    // `.forEach(removeScratchDir)` used to hand `0` as `attempts`, which made
    // the very first ENOTEMPTY fatal instead of retrying thirty times.
    const dirs = [scratchDir("ralph-scratch-each-a-"), scratchDir("ralph-scratch-each-b-")];
    dirs.forEach((dir) => removeScratchDir(dir));
    expect(dirs.every((dir) => !existsSync(dir))).toBe(true);
  });

  it("throws on a failure that is not a lingering child", () => {
    // A read-only parent gives EACCES, which no amount of retrying fixes — so
    // it is raised rather than waited out, and `scratchDir` is what decides to
    // report instead of failing the test.
    const parent = scratchDir("ralph-scratch-locked-");
    const child = join(parent, "inner");
    mkdirSync(child);
    writeFileSync(join(child, "file.txt"), "x");
    chmodSync(child, 0o500);
    try {
      expect(() => removeScratchDir(child)).toThrow();
    } finally {
      chmodSync(child, 0o700);
    }
  });
});
