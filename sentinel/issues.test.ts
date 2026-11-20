// @vitest-environment node
/**
 * The sentinel issue store as the dashboard's JSON view (felipearos/ralph#685):
 * every state, the draft title without its body, today's ledger, a malformed
 * record skipped rather than fatal, and the CLI over a scratch git repo.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { scratchDir } from "../test-scratch";
import { subprocessSuite } from "../test-timeouts";
import { SENTINEL_ISSUES_VIEW_VERSION, sentinelIssuesView } from "./issues";
import { emptyStore, type IssueRecord, type IssueState, type SentinelStore, STORE_RELATIVE_PATH } from "./store";

subprocessSuite("bun and git");

const HOME = join(__dirname, "..");
const CLI = join(HOME, "sentinel", "issues.ts");
const BUN = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim() || process.execPath;

const NOW = new Date("2026-11-04T12:00:00.000Z");

const record = (id: string, state: IssueState, overrides: Partial<IssueRecord> = {}): IssueRecord => ({
  reporter: "sentry",
  id,
  state,
  candidate: {
    id,
    title: `TypeError in ${id}`,
    culprit: "app/page.tsx",
    level: "error",
    status: "unresolved",
    regressed: false,
    firstSeen: "2026-11-01T00:00:00.000Z",
    lastSeen: "2026-11-04T00:00:00.000Z",
    events: 12,
    users: 3,
    permalink: `https://sentry.example/issues/${id}/`,
  },
  evidence: null,
  attempts: 0,
  ticket: null,
  draft: null,
  mode: "observe",
  observedAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  ...overrides,
});

const storeOf = (...records: IssueRecord[]): SentinelStore => {
  const store = emptyStore();
  for (const r of records) store.issues[`${r.reporter}:${r.id}`] = r;
  return store;
};

describe("sentinelIssuesView", () => {
  it("is an empty list with today's empty ledger over an empty store", () => {
    expect(sentinelIssuesView(emptyStore(), NOW)).toEqual({
      version: SENTINEL_ISSUES_VIEW_VERSION,
      issues: [],
      today: { day: "2026-11-04", filed: 0, alerted: false },
    });
  });

  it("prints a row per state with the documented fields", () => {
    const view = sentinelIssuesView(
      storeOf(
        record("1", "observed", { updatedAt: "2026-11-04T01:00:00.000Z" }),
        record("2", "drafted", { updatedAt: "2026-11-04T02:00:00.000Z", attempts: 1 }),
        record("3", "filed", {
          updatedAt: "2026-11-04T03:00:00.000Z",
          mode: "file",
          ticket: "#42",
          ticketNumber: 42,
          cycle: 1,
          regressedAfter: "#7",
        }),
        record("4", "failed", { updatedAt: "2026-11-04T04:00:00.000Z", attempts: 3 }),
      ),
      NOW,
    );
    expect(view.issues.map((row) => row.state)).toEqual(["failed", "filed", "drafted", "observed"]);
    expect(view.issues.find((row) => row.id === "3")).toEqual({
      key: "sentry:3",
      reporter: "sentry",
      id: "3",
      title: "TypeError in 3",
      permalink: "https://sentry.example/issues/3/",
      state: "filed",
      events: 12,
      users: 3,
      attempts: 0,
      ticket: "#42",
      ticketNumber: 42,
      mode: "file",
      draftTitle: null,
      observedAt: "2026-11-02T00:00:00.000Z",
      updatedAt: "2026-11-04T03:00:00.000Z",
      cycle: 1,
      regressedAfter: "#7",
    });
    // A record from before recurrences (#683): cycle 0, no regression, the number read off the ref.
    const old = sentinelIssuesView(storeOf(record("5", "filed", { ticket: "AND-12" })), NOW).issues[0];
    expect(old).toMatchObject({ cycle: 0, regressedAfter: null, ticketNumber: 12, ticket: "AND-12" });
  });

  it("carries an observe-mode draft's title but never its body or the evidence", () => {
    const view = sentinelIssuesView(
      storeOf(
        record("1", "drafted", {
          draft: { title: "Fix the TypeError", body: "SECRET BODY with a stack", at: "2026-11-04T00:00:00.000Z" },
          evidence: { secret: "SECRET EVIDENCE" } as unknown as IssueRecord["evidence"],
        }),
      ),
      NOW,
    );
    expect(view.issues[0]).toMatchObject({ draftTitle: "Fix the TypeError", mode: "observe" });
    const json = JSON.stringify(view);
    expect(json).not.toContain("SECRET");
    expect(Object.keys(view.issues[0] ?? {})).not.toContain("draft");
    expect(Object.keys(view.issues[0] ?? {})).not.toContain("evidence");
  });

  it("reads today's filed count and alert from the day ledger, ignoring other days", () => {
    const store = emptyStore();
    store.days["2026-11-03"] = { filed: 5, alerted: true };
    store.days["2026-11-04"] = { filed: 2, alerted: true };
    expect(sentinelIssuesView(store, NOW).today).toEqual({ day: "2026-11-04", filed: 2, alerted: true });
    store.days["2026-11-04"] = { filed: 1, alerted: false };
    expect(sentinelIssuesView(store, NOW).today).toEqual({ day: "2026-11-04", filed: 1, alerted: false });
    // A malformed ledger entry reads as nothing filed, no alert.
    (store.days as Record<string, unknown>)["2026-11-04"] = "broken";
    expect(sentinelIssuesView(store, NOW).today).toEqual({ day: "2026-11-04", filed: 0, alerted: false });
  });

  it("skips a malformed record instead of throwing", () => {
    const store = storeOf(record("1", "observed"));
    const issues = store.issues as Record<string, unknown>;
    issues["junk:a"] = "not a record";
    issues["junk:b"] = null;
    issues["junk:c"] = { ...record("c", "observed"), state: "exploded" };
    issues["junk:d"] = { ...record("d", "observed"), candidate: null };
    issues["junk:e"] = { ...record("e", "observed"), id: 5 };
    issues["junk:f"] = { ...record("f", "observed"), mode: "loud" };
    const view = sentinelIssuesView(store, NOW);
    expect(view.issues.map((row) => row.key)).toEqual(["sentry:1"]);
  });

  it("sorts by updatedAt descending, then by key", () => {
    const view = sentinelIssuesView(
      storeOf(
        record("b", "observed", { updatedAt: "2026-11-03T00:00:00.000Z" }),
        record("a", "observed", { updatedAt: "2026-11-03T00:00:00.000Z" }),
        record("c", "observed", { updatedAt: "2026-11-04T00:00:00.000Z" }),
        record("d", "observed", { updatedAt: "2026-11-01T00:00:00.000Z" }),
      ),
      NOW,
    );
    expect(view.issues.map((row) => row.key)).toEqual(["sentry:c", "sentry:a", "sentry:b", "sentry:d"]);
  });

  it("reads a missing permalink as null", () => {
    const r = record("1", "observed");
    r.candidate.permalink = "";
    expect(sentinelIssuesView(storeOf(r), NOW).issues[0]?.permalink).toBeNull();
  });
});

describe("bun sentinel/issues.ts --json", () => {
  const project = (): string => {
    const root = scratchDir("ralph-sentinel-issues-");
    spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
    return root;
  };
  const storeFile = (root: string): string => {
    const path = join(root, ".git", STORE_RELATIVE_PATH);
    mkdirSync(dirname(path), { recursive: true });
    return path;
  };
  const run = (root: string, args = ["--json"]) =>
    spawnSync(BUN, [CLI, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, RALPH_PROJECT: root } });

  it("prints an empty list and exits 0 when there is no store", () => {
    const result = run(project());
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const view = JSON.parse(result.stdout);
    expect(view).toMatchObject({ version: 1, issues: [], today: { filed: 0, alerted: false } });
    expect(view.today.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("prints the store's rows", () => {
    const root = project();
    const store = storeOf(
      record("1", "drafted", { draft: { title: "Would file", body: "SECRET", at: "2026-11-04T00:00:00.000Z" } }),
    );
    writeFileSync(storeFile(root), JSON.stringify(store));
    const result = run(root);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("SECRET");
    const view = JSON.parse(result.stdout);
    expect(view.version).toBe(1);
    expect(view.issues).toHaveLength(1);
    expect(view.issues[0]).toMatchObject({ key: "sentry:1", state: "drafted", draftTitle: "Would file" });
  });

  it("exits 1 with the reason on stderr and nothing on stdout for an unreadable store", () => {
    const root = project();
    const path = storeFile(root);
    writeFileSync(path, "{ not json");
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(path);
    expect(result.stderr).toContain("not JSON");
  });

  it("exits 64 with a usage line on a bad argv", () => {
    for (const args of [[], ["--json", "extra"], ["--yaml"]]) {
      const result = run(project(), args);
      expect(result.status).toBe(64);
      expect(result.stderr).toContain("usage:");
    }
  });
});
