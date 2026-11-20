// @vitest-environment node
/**
 * The run's single temp root (#271): the helpers behind `test-tmp.global.ts`,
 * including the fence that keeps its one `rmSync` off anything but a run root.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

import { fileScratchDir } from "./test-scratch";
import {
  RUN_ROOT_PREFIX,
  createRunRoot,
  leakReport,
  leftovers,
  reapStaleRoots,
  realTmpRoot,
  removeRunRoot,
  runRootName,
  runStamp,
} from "./test-tmp";

const scratch = fileScratchDir("ralph-test-tmp-");

describe("realTmpRoot", () => {
  it("reads TMPDIR when it is set", () => {
    expect(realTmpRoot({ TMPDIR: "/var/tmp" })).toBe("/var/tmp");
  });

  it("falls back to /tmp when TMPDIR is unset, empty or blank", () => {
    expect(realTmpRoot({})).toBe("/tmp");
    expect(realTmpRoot({ TMPDIR: "" })).toBe("/tmp");
    expect(realTmpRoot({ TMPDIR: "   " })).toBe("/tmp");
  });

  it("drops trailing slashes, so dirname() comparisons in teardown hold", () => {
    expect(realTmpRoot({ TMPDIR: "/var/tmp/" })).toBe("/var/tmp");
    expect(realTmpRoot({ TMPDIR: "/var/tmp///" })).toBe("/var/tmp");
  });

  it("keeps the root directory itself, however many slashes it is written with", () => {
    // `"//"` used to trim to "", and `createRunRoot("")` then built the run root
    // in the process's cwd — this checkout — where `removeRunRoot` refuses to
    // remove it and the run goes red with the directory still there.
    expect(realTmpRoot({ TMPDIR: "/" })).toBe("/");
    expect(realTmpRoot({ TMPDIR: "//" })).toBe("/");
    expect(realTmpRoot({ TMPDIR: "///" })).toBe("/");
  });
});

describe("runStamp and runRootName", () => {
  it("stamps to the second, in UTC, with no punctuation a path would mind", () => {
    expect(runStamp(new Date("2026-10-07T18:32:15.123Z"))).toBe("20261007T183215");
  });

  it("carries the prefix the fence requires, the stamp and the pid", () => {
    expect(runRootName(runStamp(new Date("2026-10-07T18:32:15.123Z")), 4242)).toBe(
      `${RUN_ROOT_PREFIX}20261007T183215-4242`,
    );
  });
});

describe("the redirect this run is itself under", () => {
  // The mechanism every doc comment in #271 rests on, asserted rather than
  // argued: `globalSetup` set `TMPDIR`, and these run in a worker vitest forked
  // afterwards.
  it("put this worker's os.tmpdir() inside the run root", () => {
    expect(basename(tmpdir()).startsWith(RUN_ROOT_PREFIX)).toBe(true);
  });

  it("reaches a child process, which is where the harness scripts live", () => {
    const child = spawnSync("bash", ["-c", 'd="$(mktemp -d)"; printf %s "$d"; rmdir "$d"'], { encoding: "utf8" });
    expect(child.status).toBe(0);
    expect(child.stdout).toContain(tmpdir());
  });
});

describe("leftovers", () => {
  it("lists the root's direct children, which is what the census judges", () => {
    const root = createRunRoot(scratch, runRootName("census", 9));
    expect(leftovers(root)).toEqual([]);
    mkdirSync(join(root, "one", "nested"), { recursive: true });
    mkdirSync(join(root, "two"));
    expect(leftovers(root).sort()).toEqual(["one", "two"]);
  });

  it("is empty for a root that is not there, rather than throwing in teardown", () => {
    expect(leftovers(join(scratch, "never-made"))).toEqual([]);
  });
});

describe("leakReport", () => {
  it("passes a run that cleaned up to the cap", () => {
    expect(leakReport(["a-1", "b-2"], 2)).toBeNull();
    expect(leakReport([], 0)).toBeNull();
  });

  it("names the commonest prefixes, not just the count, so the suite is findable", () => {
    const names = [
      ...Array.from({ length: 9 }, (_, index) => `ralph-triage-apply-project-${index}`),
      ...Array.from({ length: 3 }, (_, index) => `inspect-brief-${index}`),
    ];
    const report = leakReport(names, 5);
    expect(report).toContain("12 entries");
    expect(report).toContain("cap 5");
    expect(report).toContain("ralph-triage-apply-project-*");
    expect(report).toContain("inspect-brief-*");
    expect(report).toContain("scratchDir");
  });

  it("copes with a name that has no prefix at all", () => {
    expect(leakReport(["lonely"], 0)).toContain("lonely");
  });
});

describe("reapStaleRoots", () => {
  it("removes a run root an abandoned run left, and keeps a live one", () => {
    const stale = createRunRoot(scratch, runRootName("stale", 1));
    const fresh = createRunRoot(scratch, runRootName("fresh", 2));
    const other = createRunRoot(scratch, "someone-elses-dir");
    const now = Date.now();
    utimesSync(stale, new Date(now - 3 * 60 * 60 * 1000), new Date(now - 3 * 60 * 60 * 1000));
    utimesSync(other, new Date(now - 3 * 60 * 60 * 1000), new Date(now - 3 * 60 * 60 * 1000));

    expect(reapStaleRoots(scratch, now, 2 * 60 * 60 * 1000)).toEqual([stale]);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    // Old, but not a run root: the fence, not the age, is what protects it.
    expect(existsSync(other)).toBe(true);
  });

  it("reports nothing for a temp root that does not exist", () => {
    expect(reapStaleRoots(join(scratch, "absent"), Date.now(), 1)).toEqual([]);
  });
});

describe("createRunRoot", () => {
  it("creates the root and any missing parent", () => {
    const parent = join(scratch, "missing", "parent");
    const root = createRunRoot(parent, runRootName("stamp", 1));
    expect(existsSync(root)).toBe(true);
    expect(basename(root).startsWith(RUN_ROOT_PREFIX)).toBe(true);
  });
});

describe("removeRunRoot", () => {
  it("removes the tree it is given, contents and all", () => {
    const root = createRunRoot(scratch, runRootName("remove", 2));
    mkdirSync(join(root, "nested", "deeper"), { recursive: true });
    writeFileSync(join(root, "nested", "deeper", "file.txt"), "x");
    removeRunRoot(root, scratch);
    expect(existsSync(root)).toBe(false);
  });

  it("is a no-op rather than an error when the root is already gone", () => {
    const root = join(scratch, runRootName("absent", 3));
    expect(() => removeRunRoot(root, scratch)).not.toThrow();
  });

  it("refuses a path that is not a direct child of the real temp root", () => {
    const nested = createRunRoot(join(scratch, "deeper"), runRootName("nested", 4));
    expect(() => removeRunRoot(nested, scratch)).toThrow(/not a direct child/);
    expect(existsSync(nested)).toBe(true);
  });

  it("refuses the real temp root itself", () => {
    expect(() => removeRunRoot(scratch, scratch)).toThrow();
    expect(existsSync(scratch)).toBe(true);
  });

  it("refuses a sibling whose name lacks the run-root prefix", () => {
    const sibling = createRunRoot(scratch, "someone-elses-dir");
    expect(() => removeRunRoot(sibling, scratch)).toThrow(/does not start with/);
    expect(existsSync(sibling)).toBe(true);
  });
});
