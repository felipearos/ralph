// @vitest-environment node
/**
 * The session's sentinel issue CLI (felipearos/ralph#681): what `show` prints
 * of the evidence the gate stored, and what `draft` records — the draft on the
 * record, the lease dropped, nothing written to any tracker — against a real
 * temp issue store. That nothing reaches a tracker is pinned on the source: the
 * CLI takes no tracker, so a fake one could never see a write.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { SentinelMode, SentinelRules } from "../project-config";
import type { Candidate, Evidence } from "../reporter/types";
import { scratchDir } from "../test-scratch";
import { caseText } from "./gate";
import { DRAFT_EXIT, NOTHING_EXIT, run, USAGE_EXIT, type IssueDeps } from "./issue";
import { issueKey, readStore, recordCandidate, recordHandover, withStore, type IssueRecord } from "./store";

const NOW = new Date("2026-11-04T10:00:00.000Z");
const LATER = new Date("2026-11-04T11:00:00.000Z");

const rules = (overrides: Partial<SentinelRules> = {}): SentinelRules => ({
  reporter: { kind: "sentry", org: "loggd", project: "web", environment: null },
  enabled: true,
  lookbackHours: 24,
  minEvents: 5,
  minUsers: 2,
  maxPerDay: 3,
  mode: "observe",
  language: "es",
  ...overrides,
});

const candidate = (id: string): Candidate => ({
  id,
  title: "TypeError: x is undefined",
  culprit: "app/page.tsx",
  level: "error",
  status: "unresolved",
  regressed: true,
  firstSeen: "2026-11-03T10:00:00.000Z",
  lastSeen: "2026-11-04T09:00:00.000Z",
  events: 12,
  users: 4,
  permalink: `https://sentry.example/issues/${id}`,
});

const evidence = (id: string): Evidence => ({
  issueId: id,
  release: "abc123",
  environment: "production",
  frames: [
    { file: "src/crash.ts", function: "crash", line: 30, inApp: true },
    { file: "node_modules/lib.js", function: "call", line: null, inApp: false },
  ],
  framesOmitted: 7,
  tags: { browser: "Chrome 130", url: "https://loggd.app/page" },
  breadcrumbs: [
    { at: "2026-11-04T08:59:00.000Z", category: "ui.click", level: "info", message: "clicked save" },
    { at: "2026-11-04T08:59:30.000Z", category: "fetch", level: "error", message: "POST /api 500" },
  ],
  breadcrumbsOmitted: 3,
});

interface Seeded {
  deps: IssueDeps;
  dir: string;
  record: IssueRecord;
  key: string;
}

/** A store with one issue, handed over with evidence unless `handed` is false, and leased to a run. */
async function seed(options: { handed?: boolean; mode?: SentinelMode; env?: NodeJS.ProcessEnv } = {}): Promise<Seeded> {
  const dir = scratchDir("sentinel-issue-");
  const storePath = join(dir, "sentinel-issues.json");
  const key = issueKey("sentry", "123");
  const record = await withStore(storePath, (store) => {
    const seeded = recordCandidate(store, "sentry", candidate("123"), "observe", NOW);
    if (options.handed !== false) recordHandover(store, key, evidence("123"), "observe", NOW);
    store.leases[key] = { run: "run-1", loop: "senti", pid: 111, host: "box", expiresAt: LATER.toISOString() };
    return structuredClone(seeded);
  });
  return {
    deps: { storePath, rules: rules({ mode: options.mode ?? "observe" }), env: options.env ?? {}, now: () => LATER },
    dir,
    record,
    key,
  };
}

const bodyFile = (dir: string, text: string): string => {
  const path = join(dir, "body.md");
  writeFileSync(path, text);
  return path;
};

describe("show", () => {
  it("prints the candidate, the frames, the breadcrumbs and the language", async () => {
    const { deps, record } = await seed();
    const ran = await run(["show", caseText(record)], deps);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain("sentry:123: TypeError: x is undefined");
    expect(ran.stdout).toContain("12 events, 4 users");
    expect(ran.stdout).toContain("regressed");
    expect(ran.stdout).toContain("https://sentry.example/issues/123");
    expect(ran.stdout).toContain("release: abc123");
    expect(ran.stdout).toContain("browser=Chrome 130");
    expect(ran.stdout).toContain("  src/crash.ts:30 crash [in-app]\n");
    expect(ran.stdout).toContain("  node_modules/lib.js call\n");
    expect(ran.stdout).toContain("7 more frames omitted");
    expect(ran.stdout).toContain("  2026-11-04T08:59:30.000Z fetch error POST /api 500\n");
    expect(ran.stdout).toContain("3 more breadcrumbs omitted");
    expect(ran.stdout).toContain("state observed, attempts 1, mode observe");
    expect(ran.stdout).toContain("language: es");
  });

  it("prints the record and the language as JSON", async () => {
    const { deps, record } = await seed();
    const ran = await run(["show", caseText(record), "--json"], deps);
    expect(ran.code).toBe(0);
    const shown = JSON.parse(ran.stdout) as { record: IssueRecord; language: string };
    expect(shown.language).toBe("es");
    expect(shown.record.evidence?.frames).toHaveLength(2);
  });

  it("has nothing to show for an issue the gate never handed over", async () => {
    const { deps, record } = await seed({ handed: false });
    const ran = await run(["show", caseText(record)], deps);
    expect(ran.code).toBe(NOTHING_EXIT);
    expect(ran.stderr).toContain("nothing to show");
  });

  it("reads the case from RALPH_INTAKE_CASE", async () => {
    const { deps, record } = await seed();
    const ran = await run(["show"], { ...deps, env: { RALPH_INTAKE_CASE: caseText(record) } });
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain("sentry:123");
  });

  it("refuses a case that is not a sentinel's", async () => {
    const { deps } = await seed();
    const ran = await run(["show"], { ...deps, env: { RALPH_INTAKE_CASE: "verifier check-in +6h of PR #12 (#34), deploy d1" } });
    expect(ran.code).toBe(USAGE_EXIT);
    expect(ran.stderr).toContain("not a sentinel case");
  });

  it("refuses to run without sentinel rules", async () => {
    const { deps, record } = await seed();
    const ran = await run(["show", caseText(record)], { ...deps, rules: null });
    expect(ran.code).toBe(USAGE_EXIT);
  });
});

describe("draft", () => {
  it("records the draft in observe mode and drops the lease", async () => {
    const { deps, dir, record, key } = await seed();
    const ran = await run(["draft", caseText(record), "--title", "  Fix the\n TypeError  on page ", "--body-file", bodyFile(dir, "## What\nIt breaks.\n")], deps);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toBe(`sentinel-issue: drafted ${key} (observe mode: recorded what would have been filed; nothing written to the tracker)\n`);
    const store = readStore(deps.storePath);
    const stored = store.issues[key]!;
    expect(stored.state).toBe("drafted");
    expect(stored.mode).toBe("observe");
    expect(stored.draft).toEqual({ title: "Fix the TypeError on page", body: "## What\nIt breaks.\n", at: LATER.toISOString() });
    expect(store.leases[key]).toBeUndefined();
  });

  it("imports no tracker and no reporter, so no draft can reach either", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "issue.ts"), "utf8");
    const imports = [...source.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    // `../tracker`, `../tracker.ts`, `../tracker/fake`, `../reporter/sentry`, … type-only imports too.
    expect(imports.filter((path) => /^\.\.\/(tracker|reporter)\b/.test(path!))).toEqual([]);
  });

  it("has nothing to draft for a record the gate never handed over, and leaves the store unchanged", async () => {
    const { deps, dir, record } = await seed({ handed: false });
    const body = bodyFile(dir, "body");
    const before = readFileSync(deps.storePath, "utf8");
    const ran = await run(["draft", caseText(record), "--title", "Fix it", "--body-file", body], deps);
    expect(ran.code).toBe(NOTHING_EXIT);
    expect(ran.stderr).toContain("has not handed its evidence over");
    expect(readFileSync(deps.storePath, "utf8")).toBe(before);
  });

  it("records no draft once the sentinel is disabled in config, while `show` still reads (#789)", async () => {
    const { deps, dir, record, key } = await seed({ mode: "file" });
    const off = { ...deps, rules: { ...deps.rules!, enabled: false } };
    const before = readFileSync(deps.storePath, "utf8");
    const ran = await run(["draft", caseText(record), "--title", "Fix it", "--body-file", bodyFile(dir, "body")], off);
    expect(ran.code).toBe(NOTHING_EXIT);
    expect(ran.stderr).toBe(`sentinel-issue: nothing to draft for ${key}: the sentinel is disabled in config ('sentinel.enabled' is false)\n`);
    expect(readFileSync(deps.storePath, "utf8")).toBe(before);
    expect((await run(["show", caseText(record)], off)).code).toBe(0);
  });

  it("leaves an issue another run holds now alone: lease and state unchanged", async () => {
    const { deps, dir, record, key } = await seed({ env: { RALPH_RUN_ID: "run-2", RALPH_LOOP_NAME: "senti" } });
    const body = bodyFile(dir, "body");
    const before = readStore(deps.storePath);
    const ran = await run(["draft", caseText(record), "--title", "Fix it", "--body-file", body], deps);
    expect(ran.code).toBe(NOTHING_EXIT);
    expect(ran.stderr).toContain(`${key} is held by senti (run run-1) now`);
    const after = readStore(deps.storePath);
    expect(after.leases[key]).toEqual(before.leases[key]);
    expect(after.issues[key]!.state).toBe("observed");
    expect(after.issues[key]!.draft).toBeNull();
  });

  it("records the draft when the session is the lease's own run and loop", async () => {
    const { deps, dir, record, key } = await seed({ env: { RALPH_RUN_ID: "run-1", RALPH_LOOP_NAME: "senti" } });
    const ran = await run(["draft", caseText(record), "--title", "Fix it", "--body-file", bodyFile(dir, "body")], deps);
    expect(ran.code, ran.stderr).toBe(0);
    const store = readStore(deps.storePath);
    expect(store.issues[key]!.state).toBe("drafted");
    expect(store.leases[key]).toBeUndefined();
  });

  it("says the gate files it in file mode", async () => {
    const { deps, dir, record, key } = await seed({ mode: "file" });
    const ran = await run(["draft", caseText(record), "--title", "Fix it", "--body-file", bodyFile(dir, "body")], deps);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toBe(`sentinel-issue: drafted ${key} (file mode: recorded; the gate files it on the tracker on its next poll, labelled ready-for-human)\n`);
    expect(readStore(deps.storePath).issues[key]!.mode).toBe("file");
  });

  it("replaces an earlier draft, and prints the record as JSON", async () => {
    const { deps, dir, record, key } = await seed();
    await run(["draft", caseText(record), "--title", "First", "--body-file", bodyFile(dir, "one")], deps);
    const ran = await run(["draft", caseText(record), "--title", "Second", "--body-file", bodyFile(dir, "two"), "--json"], deps);
    expect(ran.code).toBe(0);
    expect((JSON.parse(ran.stdout) as IssueRecord).draft?.title).toBe("Second");
    expect(readStore(deps.storePath).issues[key]!.draft?.body).toBe("two");
  });

  it("refuses a missing or empty body file and leaves the store unchanged", async () => {
    const { deps, dir, record } = await seed();
    const before = readFileSync(deps.storePath, "utf8");
    const missing = await run(["draft", caseText(record), "--title", "Fix it", "--body-file", join(dir, "nope.md")], deps);
    expect(missing.code).toBe(DRAFT_EXIT);
    const empty = await run(["draft", caseText(record), "--title", "Fix it", "--body-file", bodyFile(dir, "  \n\t")], deps);
    expect(empty.code).toBe(DRAFT_EXIT);
    expect(readFileSync(deps.storePath, "utf8")).toBe(before);
  });

  it("refuses an empty or an overlong title", async () => {
    const { deps, dir, record } = await seed();
    const before = readFileSync(deps.storePath, "utf8");
    const body = bodyFile(dir, "body");
    expect((await run(["draft", caseText(record), "--title", " \n ", "--body-file", body], deps)).code).toBe(DRAFT_EXIT);
    expect((await run(["draft", caseText(record), "--title", "x".repeat(201), "--body-file", body], deps)).code).toBe(DRAFT_EXIT);
    expect(readFileSync(deps.storePath, "utf8")).toBe(before);
  });

  it("refuses a record already filed", async () => {
    const { deps, dir, record, key } = await seed();
    await withStore(deps.storePath, (store) => {
      store.issues[key]!.state = "filed";
      store.issues[key]!.ticket = "#900";
    });
    const ran = await run(["draft", caseText(record), "--title", "Fix it", "--body-file", bodyFile(dir, "body")], deps);
    expect(ran.code).toBe(NOTHING_EXIT);
    expect(ran.stderr).toContain("already filed as #900");
    expect(readStore(deps.storePath).issues[key]!.draft).toBeNull();
  });

  it("has nothing to draft for an unknown issue", async () => {
    const { deps, dir } = await seed();
    const ran = await run(["draft", "sentinel issue sentry:999 — Other", "--title", "Fix it", "--body-file", bodyFile(dir, "body")], deps);
    expect(ran.code).toBe(NOTHING_EXIT);
  });

  it("needs a title and a body file", async () => {
    const { deps, record } = await seed();
    expect((await run(["draft", caseText(record), "--title", "Fix it"], deps)).code).toBe(USAGE_EXIT);
  });
});
