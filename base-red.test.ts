import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { failingTests, judgeGate, runGates, type BaseRed } from "./base-red";
import { scratchDir } from "./test-scratch";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs gates under sh and the base-red CLI under bun");

const VITEST_TEST = `src/lib/input-guard.test.ts > campos sin límite (OA-479) > nadie usa <input> nativo salvo type="file"`;
const VITEST_TAIL = [
  "\x1b[31m⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯\x1b[39m",
  "",
  `\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m ${VITEST_TEST}`,
  "AssertionError: expected [ Array(1) ] to deeply equal []",
  "",
  " Test Files  1 failed | 242 passed (243)",
].join("\n");

/** A FAIL line as vitest draws it with colour on, the project tag a ` unit ` badge. */
const colouredFail = (rest: string) => `\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m \x1b[30m\x1b[42m unit \x1b[49m\x1b[39m ${rest}`;
const colouredLoad = (file: string) => colouredFail(`${file}\x1b[2m [ ${file} ]\x1b[22m`);
const plainLoad = (file: string) => ` FAIL  |unit| ${file} [ ${file} ]`;
const LOAD_SUMMARY = " Test Files  1 failed (1)\n      Tests  no tests";

describe("failingTests", () => {
  it.each([
    ["the real vitest tail, with colour codes", VITEST_TAIL, [VITEST_TEST]],
    ["a vitest file that failed to load", " FAIL  src/x.test.ts [ src/x.test.ts ]\n", ["src/x.test.ts"]],
    ["a parenthesised duration", " FAIL  src/x.test.ts > a > b (12 ms)\n", ["src/x.test.ts > a > b"]],
    ["a name ending in a duration keeps it", " FAIL  src/x.test.ts > waits 5s\n FAIL  src/x.test.ts > waits 10s\n", ["src/x.test.ts > waits 10s", "src/x.test.ts > waits 5s"]],
    ["a jest failure header", "  ● login › rejects a bad password\n\n    expect(received)", ["login > rejects a bad password"]],
    ["jest console output is not a failure", "  ● Console\n\n    console.log hi", []],
    ["tsc without --pretty", "src/a.ts(10,5): error TS2322: Type 'x' is not assignable to type 'y'.", ["src/a.ts: TS2322: Type 'x' is not assignable to type 'y'."]],
    ["tsc with --pretty", "\x1b[96msrc/a.ts\x1b[0m:\x1b[93m10\x1b[0m:\x1b[93m5\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m TS2322: \x1b[0mType 'x' is not assignable.", ["src/a.ts: TS2322: Type 'x' is not assignable."]],
    ["duplicates and order", " FAIL  b.test.ts > t\n FAIL  a.test.ts > t\n FAIL  b.test.ts > t\n", ["a.test.ts > t", "b.test.ts > t", "b.test.ts > t"]],
    ["anything else", "Error: something broke\n  at foo (bar.ts:1:2)\nnpm ERR! code 1", []],
    ["a coloured load failure under a project badge", colouredLoad("src/lib/backoffice-access.test.ts"), ["src/lib/backoffice-access.test.ts"]],
    ["a coloured test failure under a project badge", colouredFail("src/x.test.ts > suite > name"), ["src/x.test.ts > suite > name"]],
    ["a coloured badge whose project name has a space", "\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m \x1b[30m\x1b[43m unit tests \x1b[49m\x1b[39m src/a.test.ts > t", ["src/a.test.ts > t"]],
    ["a coloured FAIL line with no project badge", "\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m src/x.test.ts > a", ["src/x.test.ts > a"]],
  ])("%s", (_name, output, expected) => {
    expect(failingTests(output)).toEqual(expected);
  });

  it("gives the same ids for a vitest tail with and without colour", () => {
    const coloured = [colouredLoad("src/a.test.ts"), colouredLoad("src/b.test.ts"), colouredFail("src/c.test.ts > suite > name"), "AssertionError: nope"].join("\n");
    const plain = [plainLoad("src/a.test.ts"), plainLoad("src/b.test.ts"), " FAIL  |unit| src/c.test.ts > suite > name", "AssertionError: nope"].join("\n");
    expect(failingTests(coloured)).toEqual(["src/a.test.ts", "src/b.test.ts", "src/c.test.ts > suite > name"]);
    expect(failingTests(plain)).toEqual(failingTests(coloured));
  });

  it("drops line and column so a shifted tsc error still matches", () => {
    expect(failingTests("src/a.ts(10,5): error TS2322: T")).toEqual(failingTests("src/a.ts(42,1): error TS2322: T"));
  });
});

describe("judgeGate", () => {
  const base: BaseRed = { version: 1, base: "abc", gates: { "trial/test": { conclusion: "FAILURE", failures: [VITEST_TEST] }, "trial/lint": { conclusion: "SUCCESS", failures: [] } } };

  it("passes a gate that exits 0", () => {
    expect(judgeGate("trial/test", { ok: true, output: "" }, base)).toEqual({ name: "trial/test", conclusion: "SUCCESS" });
  });

  it("passes a gate that fails only on the base's tests, naming them", () => {
    expect(judgeGate("trial/test", { ok: false, output: VITEST_TAIL }, base)).toEqual({
      name: "trial/test",
      conclusion: "SUCCESS",
      summary: `passes apart from 1 test already failing on the trial base: ${VITEST_TEST}`,
      baseRed: [VITEST_TEST],
    });
  });

  it("keeps a gate red when the head adds a failure, naming the new one", () => {
    const check = judgeGate("trial/test", { ok: false, output: `${VITEST_TAIL}\n FAIL  src/new.test.ts > breaks\n` }, base);
    expect(check).toEqual({ name: "trial/test", conclusion: "FAILURE", summary: "new failures not on the base: src/new.test.ts > breaks" });
  });

  it("keeps a failed gate with unparseable output red", () => {
    expect(judgeGate("trial/test", { ok: false, output: "Segmentation fault" }, base)).toEqual({ name: "trial/test", conclusion: "FAILURE" });
  });

  it("keeps a gate red that was green on the base", () => {
    expect(judgeGate("trial/lint", { ok: false, output: " FAIL  x.test.ts > t\n" }, base).conclusion).toBe("FAILURE");
  });

  it("judges by exit code with no base record", () => {
    expect(judgeGate("trial/test", { ok: false, output: VITEST_TAIL }, null)).toEqual({ name: "trial/test", conclusion: "FAILURE" });
  });

  it.each([
    ["vitest unhandled errors", "⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯"],
    ["vitest unhandled rejection", "⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯"],
    ["vitest's caught count", "Vitest caught 2 unhandled errors during the test run."],
    ["a crashed worker", "Error: Worker exited unexpectedly"],
    ["a vitest coverage threshold", "ERROR: Coverage for lines (50%) does not meet global threshold (80%)"],
    ["a jest coverage threshold", "Jest: \"global\" coverage threshold for lines (80%) not met: 50%"],
  ])("keeps a gate red whose output reports %s, base-red names and all", (_name, marker) => {
    const check = judgeGate("trial/test", { ok: false, output: `${VITEST_TAIL}\n${marker}\n` }, base);
    expect(check.conclusion).toBe("FAILURE");
    expect(check.summary).toMatch(/^not judged against the base: the runner reports a failure that is not a test/);
  });

  it.each([
    ["timed out", { timedOut: true }, /timed out/],
    ["was stopped", { aborted: true }, /stopped/],
    ["outgrew the output cap", { truncated: true }, /cap/],
  ])("keeps a gate red whose run %s", (_name, flags, why) => {
    const check = judgeGate("trial/test", { ok: false, output: VITEST_TAIL, ...flags }, base);
    expect(check.conclusion).toBe("FAILURE");
    expect(check.summary).toMatch(why);
  });

  it("keeps a gate red when the summary counts more failed tests than the output names", () => {
    expect(judgeGate("trial/test", { ok: false, output: `${VITEST_TAIL}\n      Tests  2 failed | 240 passed (242)\n` }, base).conclusion).toBe("FAILURE");
    expect(judgeGate("trial/test", { ok: false, output: `${VITEST_TAIL}\nTests:       2 failed, 240 passed, 242 total\n` }, base).conclusion).toBe("FAILURE");
    // A count that matches the named tests is no obstacle.
    expect(judgeGate("trial/test", { ok: false, output: `${VITEST_TAIL}\n      Tests  1 failed | 241 passed (242)\n` }, base).conclusion).toBe("SUCCESS");
  });

  it("keeps a gate red when the head fails a known error more often than the base", () => {
    const error = "src/a.ts(1,1): error TS2322: T";
    const tsc: BaseRed = { version: 1, base: null, gates: { "trial/typecheck": { conclusion: "FAILURE", failures: failingTests(error) } } };
    expect(judgeGate("trial/typecheck", { ok: false, output: error }, tsc).conclusion).toBe("SUCCESS");
    expect(judgeGate("trial/typecheck", { ok: false, output: `${error}\nsrc/a.ts(9,1): error TS2322: T` }, tsc)).toEqual({
      name: "trial/typecheck", conclusion: "FAILURE", summary: "new failures not on the base: src/a.ts: TS2322: T",
    });
  });

  describe("a file that fails to load (#593)", () => {
    const X = "src/lib/backoffice-access.test.ts";
    const Y = "src/lib/other.test.ts";
    // Recorded as recordBase does, from the base's coloured output.
    const loadBase: BaseRed = { version: 1, base: "abc", gates: { "trial/test": { conclusion: "FAILURE", failures: failingTests(`${colouredLoad(X)}\n${LOAD_SUMMARY}\n`) } } };

    it("passes a plain head that fails to load only the file a coloured base could not load", () => {
      const check = judgeGate("trial/test", { ok: false, output: `${plainLoad(X)}\n${LOAD_SUMMARY}\n` }, loadBase);
      expect(check.conclusion).toBe("SUCCESS");
      expect(check.baseRed).toEqual([X]);
      expect(check.summary).toContain(X);
    });

    it("keeps a head red that also fails to load a file the base loaded", () => {
      const output = `${plainLoad(X)}\n${plainLoad(Y)}\n Test Files  2 failed (2)\n      Tests  no tests\n`;
      expect(judgeGate("trial/test", { ok: false, output }, loadBase)).toEqual({ name: "trial/test", conclusion: "FAILURE", summary: `new failures not on the base: ${Y}` });
    });

    it("judges jest's `Test suite failed to run` by the suite's file", () => {
      const jest = (file: string) => `FAIL ${file}\n  ● Test suite failed to run\n\n    Cannot find module 'x'\n`;
      const jestBase: BaseRed = { version: 1, base: "abc", gates: { "trial/test": { conclusion: "FAILURE", failures: failingTests(jest("src/a.test.js")) } } };
      expect(judgeGate("trial/test", { ok: false, output: jest("src/a.test.js") }, jestBase).conclusion).toBe("SUCCESS");
      expect(judgeGate("trial/test", { ok: false, output: jest("src/b.test.js") }, jestBase).conclusion).toBe("FAILURE");
    });
  });

  it("caps the list of tests in the summary", () => {
    const tests = Array.from({ length: 7 }, (_, i) => `t${i}.test.ts > t`);
    const wide: BaseRed = { version: 1, base: null, gates: { "trial/test": { conclusion: "FAILURE", failures: tests } } };
    const check = judgeGate("trial/test", { ok: false, output: tests.map((t) => ` FAIL  ${t}`).join("\n") }, wide);
    expect(check.conclusion).toBe("SUCCESS");
    expect(check.summary).toBe(`passes apart from 7 tests already failing on the trial base: ${tests.slice(0, 5).join("; ")}; … and 2 more`);
  });
});

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" };

describe("runGates", () => {
  it("runs gates in order, captures output and forwards it", async () => {
    const dir = scratchDir("base-red-");
    const chunks: string[] = [];
    const runs = await runGates({ test: "echo out; echo err >&2; exit 1", lint: "pwd" }, dir, { timeoutMs: 20_000, env, stderr: (c) => chunks.push(c) });
    expect(runs.map((r) => [r.name, r.ok])).toEqual([["trial/test", false], ["trial/lint", true]]);
    expect(runs[0]!.output).toContain("out");
    expect(runs[0]!.output).toContain("err");
    expect(runs[1]!.output.trim()).toBe(dir);
    expect(chunks.join("")).toContain("err");
  });

  it("kills a gate that times out and counts it failed", async () => {
    const dir = scratchDir("base-red-");
    const [run] = await runGates({ slow: "sleep 30 & wait" }, dir, { timeoutMs: 200, env });
    expect(run!.ok).toBe(false);
    expect(run!.output).toContain("timed out");
    expect(run!.timedOut).toBe(true);
  });

  it("bounds the whole run with one deadline: a gate started with nothing left has timed out", async () => {
    const dir = scratchDir("base-red-");
    const runs = await runGates({ slow: "sleep 30", next: "echo never" }, dir, { timeoutMs: 300, env });
    expect(runs.map((run) => [run.name, run.ok, run.timedOut])).toEqual([["trial/slow", false, true], ["trial/next", false, true]]);
    expect(runs[1]!.output).not.toContain("never");
  });

  it("marks output past the cap as truncated", async () => {
    const dir = scratchDir("base-red-");
    const [run] = await runGates({ chatty: "head -c 3000000 /dev/zero | tr '\\0' x" }, dir, { timeoutMs: 20_000, env });
    expect(run!.ok).toBe(true);
    expect(run!.truncated).toBe(true);
  });

  it("stops the current gate on abort and starts no other", async () => {
    const dir = scratchDir("base-red-");
    const controller = new AbortController();
    const started = Date.now();
    const pending = runGates({ slow: "echo go; sleep 30", next: "echo never" }, dir, {
      timeoutMs: 60_000, env, signal: controller.signal, stderr: (chunk) => { if (chunk.includes("go")) controller.abort(); },
    });
    const runs = await pending;
    expect(runs.map((run) => [run.name, run.ok, run.aborted])).toEqual([["trial/slow", false, true]]);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  const setsid = spawnSync("sh", ["-c", "command -v setsid"]).status === 0;

  it.skipIf(!setsid)("settles soon after the shell exits though a setsid child holds the pipes (needs setsid)", async () => {
    const dir = scratchDir("base-red-");
    const started = Date.now();
    const [run] = await runGates({ daemon: "setsid sleep 30 & echo hi" }, dir, { timeoutMs: 60_000, env });
    expect(run!.ok).toBe(true);
    expect(run!.output).toContain("hi");
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it.skipIf(!setsid)("settles at its timeout though a setsid child holds the pipes (needs setsid)", async () => {
    const dir = scratchDir("base-red-");
    const started = Date.now();
    const [run] = await runGates({ daemon: "setsid sleep 30 & sleep 30" }, dir, { timeoutMs: 500, env });
    expect(run!.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("CLI", () => {
  const cli = join(import.meta.dirname, "base-red.ts");
  const bun = (args: string[], cwd: string) => spawnSync("bun", [cli, ...args], { cwd, env, encoding: "utf8" });

  function project(lines: string[]): string {
    const dir = scratchDir("base-red-");
    writeFileSync(join(dir, "test.sh"), `${lines.map((l) => `echo ' FAIL  ${l}'`).join("\n")}\nexit 1\n`);
    writeFileSync(join(dir, "gates.json"), JSON.stringify({ test: "sh test.sh", lint: "true" }));
    return dir;
  }

  it("records the base, then passes a head that fails only on the base's tests", () => {
    const dir = project(["src/x.test.ts > old"]);
    const recorded = bun(["record", "--gates", "gates.json", "--out", "base-red.json", "--base", "abc"], dir);
    expect(recorded.status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "base-red.json"), "utf8"))).toEqual({
      version: 1,
      base: "abc",
      gates: { "trial/test": { conclusion: "FAILURE", failures: ["src/x.test.ts > old"] }, "trial/lint": { conclusion: "SUCCESS", failures: [] } },
    });

    const checks = bun(["checks", "--gates", "gates.json", "--base-red", "base-red.json"], dir);
    expect(checks.status).toBe(0);
    expect(checks.stderr).toContain("FAIL  src/x.test.ts > old");
    expect(JSON.parse(checks.stdout)).toEqual([
      { name: "trial/test", conclusion: "SUCCESS", summary: "passes apart from 1 test already failing on the trial base: src/x.test.ts > old", baseRed: ["src/x.test.ts > old"] },
      { name: "trial/lint", conclusion: "SUCCESS" },
    ]);

    writeFileSync(join(dir, "test.sh"), "echo ' FAIL  src/x.test.ts > old'\necho ' FAIL  src/y.test.ts > new'\nexit 1\n");
    const head = bun(["checks", "--gates", "gates.json", "--base-red", "base-red.json"], dir);
    expect(JSON.parse(head.stdout)[0]).toEqual({ name: "trial/test", conclusion: "FAILURE", summary: "new failures not on the base: src/y.test.ts > new" });
  });

  it("judges by exit code when the base record is missing, still printing valid JSON", () => {
    const dir = project(["src/x.test.ts > old"]);
    const checks = bun(["checks", "--gates", "gates.json", "--base-red", "missing.json"], dir);
    expect(checks.status).toBe(0);
    expect(checks.stderr).toContain("no usable base record");
    expect(JSON.parse(checks.stdout)).toEqual([{ name: "trial/test", conclusion: "FAILURE" }, { name: "trial/lint", conclusion: "SUCCESS" }]);
  });

  it("exits 1 on an unreadable gates file", () => {
    const dir = scratchDir("base-red-");
    const result = bun(["record", "--gates", "nope.json", "--out", "out.json"], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot read gates");
  });
});
