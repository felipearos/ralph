// @vitest-environment node
/**
 * The guard from #271: no test source creates a temp directory it never
 * removes. The first test is the guard itself running over this checkout; the
 * rest cover the rule, since a guard whose own logic is untested is a guard
 * that silently stops guarding.
 */
import { describe, expect, it } from "vitest";

import { codeOnly, describeOffences, isTestSource, mkdtempOffences, testSources } from "./test-mkdtemp";

/** Just the paths, for the cases that are about which files are named. */
const paths = (sources: Parameters<typeof mkdtempOffences>[0]) => mkdtempOffences(sources).map((o) => o.path);

describe("every test source in this checkout", () => {
  it("removes the temp directories it creates", () => {
    const offences = mkdtempOffences(testSources(import.meta.dirname));
    expect(offences.map((offence) => offence.path), offences.length ? describeOffences(offences) : "").toEqual([]);
  });

  it("is found by the walk — the guard is watching a real file set", () => {
    const paths = testSources(import.meta.dirname).map((source) => source.path);
    expect(paths).toContain("test-mkdtemp.test.ts");
    expect(paths).toContain("test-config-home.setup.ts");
    expect(paths).toContain("test-tmp.global.ts");
    expect(paths).toContain("dashboard/fixtures.ts");
    expect(paths).toContain("lineup/fixtures.ts");
    expect(paths.some((path) => path.startsWith("ci-doctor/"))).toBe(true);
    expect(paths.every((path) => !path.includes("node_modules"))).toBe(true);
  });
});

describe("isTestSource", () => {
  it("takes suites, setup files, globalSetup modules and test helpers", () => {
    expect(isTestSource("models.test.ts")).toBe(true);
    expect(isTestSource("test-config-home.setup.ts")).toBe(true);
    expect(isTestSource("test-tmp.global.ts")).toBe(true);
    expect(isTestSource("dashboard/fixtures.ts")).toBe(true);
    expect(isTestSource("test-workers.ts")).toBe(true);
  });

  it("leaves production sources alone", () => {
    expect(isTestSource("frontier/next.ts")).toBe(false);
    expect(isTestSource("dashboard/server.ts")).toBe(false);
  });

  it("exempts the guard's own machinery, which it cannot judge by text", () => {
    expect(isTestSource("test-tmp.ts")).toBe(false);
    expect(isTestSource("test-scratch.ts")).toBe(false);
    expect(isTestSource("test-mkdtemp.ts")).toBe(false);
  });
});

describe("codeOnly", () => {
  it("blanks a fixture suite written as a string, so it is judged on its own code", () => {
    const text = ['const body = `', "  const dir = mkdtempSync(tmpdir());", "`;", 'const note = "mkdtempSync(x)";'].join(
      "\n",
    );
    expect(codeOnly(text)).not.toContain("mkdtempSync(");
  });

  it("blanks comments, including one that names the call", () => {
    expect(codeOnly("// mkdtempSync(join(tmpdir(), 'x'))\nconst a = 1;")).not.toContain("mkdtempSync");
    expect(codeOnly("/** mkdtempSync(x) */\nconst a = 1;")).not.toContain("mkdtempSync");
  });

  it("keeps code on the lines after prose with an apostrophe in it", () => {
    // A literal that could span newlines is what blanked whole files in the
    // first cut of this: one apostrophe, and everything to the next one went.
    const text = ["const note = 'it does not';", "// the suite's own fixture", "const dir = mkdtempSync(here);"].join(
      "\n",
    );
    expect(codeOnly(text)).toContain("mkdtempSync(here)");
  });
});

describe("mkdtempOffences", () => {
  const source = (text: string) => [{ path: "suite.test.ts", text }];

  it("names a suite that creates and never removes", () => {
    expect(paths(source("const d = mkdtempSync(join(tmpdir(), PREFIX));"))).toEqual(["suite.test.ts"]);
    expect(paths(source("await mkdtemp(join(tmpdir(), PREFIX));"))).toEqual(["suite.test.ts"]);
  });

  it("sees a temp directory made with mkdirSync as well as with mkdtemp", () => {
    expect(paths(source("mkdirSync(join(tmpdir(), NAME), { recursive: true });"))).toEqual(["suite.test.ts"]);
    expect(paths(source("mkdirSync(tmpdir() + NAME);"))).toEqual(["suite.test.ts"]);
  });

  it("accepts scratchDir and fileScratchDir, which clean up for the caller", () => {
    expect(paths(source("const d = scratchDir(PREFIX);"))).toEqual([]);
    expect(paths(source("const d = fileScratchDir(PREFIX);"))).toEqual([]);
  });

  it("accepts a file that removes what it made", () => {
    const texts = [
      "const d = mkdtempSync(x);\nafterAll(() => rmSync(d, { recursive: true }));",
      "const d = mkdtempSync(x);\nonTestFinished(() => rmSync(d));",
      "const d = mkdtempSync(x);\nafterEach(() => removeScratchDir(d));",
      "const d = mkdtempSync(x);\nawait rm(d, { recursive: true });",
    ];
    for (const text of texts) expect(paths(source(text))).toEqual([]);
  });

  it("is not satisfied by a hook that cleans up something else", () => {
    // `dashboard/server.test.ts` passed the first cut of this guard on an
    // `afterAll` that kills children, while leaking three
    // `ralph-dashboard-config-*` directories a run.
    const text = "const d = mkdtempSync(x);\nafterAll(() => children.forEach(kill));";
    expect(paths(source(text))).toEqual(["suite.test.ts"]);
  });

  it("ignores a file that makes no temp directory at all", () => {
    expect(paths(source("it(NAME, () => expect(1 + 1).toBe(2));"))).toEqual([]);
  });

  it("reports offenders sorted, so the message is stable", () => {
    const sources = [
      { path: "b.test.ts", text: "mkdtempSync(x)" },
      { path: "a.test.ts", text: "mkdtempSync(x)" },
    ];
    expect(paths(sources)).toEqual(["a.test.ts", "b.test.ts"]);
  });
});

describe("the fixtures rule", () => {
  const source = (text: string) => [{ path: "suite.test.ts", text }];

  it("fails a suite that imports scratchProject and never drains the fixtures", () => {
    const text = 'import { scratchProject } from "./dashboard/fixtures";\nconst p = scratchProject("x");';
    expect(mkdtempOffences(source(text))).toEqual([{ path: "suite.test.ts", reason: "no cleanupFixtures" }]);
  });

  it("accepts one that registers the drain", () => {
    const text = [
      'import { cleanupFixtures, scratchProject } from "./dashboard/fixtures";',
      "afterAll(cleanupFixtures);",
      'const p = scratchProject("x");',
    ].join("\n");
    expect(paths(source(text))).toEqual([]);
  });

  it("leaves a file with a scratchProject of its own alone", () => {
    // `preflight.test.ts` has one, and it cleans up after itself; the rule is
    // keyed on the import rather than on the name for exactly that reason.
    const text = 'function scratchProject() { return mkdtempSync(x); }\nafterAll(() => rmSync(d));';
    expect(paths(source(text))).toEqual([]);
  });

  it("accepts lineup's rootWith with the drain", () => {
    const text = 'import { rootWith } from "./lineup/fixtures";\nconst r = rootWith(x);';
    expect(mkdtempOffences(source(text))[0]?.reason).toBe("no cleanupFixtures");
  });
});

describe("describeOffences", () => {
  it("names the offenders and the fix", () => {
    const message = describeOffences([{ path: "a.test.ts", reason: "no cleanup" }]);
    expect(message).toContain("a.test.ts");
    expect(message).toContain("scratchDir");
    expect(message).toContain("#271");
  });
});
