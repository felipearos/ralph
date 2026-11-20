// @vitest-environment node
/**
 * Moving the clerk's cursor to "now" at the flip to live (felipearos/ralph#320,
 * spec user story 45): nothing posted before the move is filed, and a batch
 * handed in shadow is dropped rather than filed for real.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { subprocessSuite } from "../test-timeouts";
import { sinceMs } from "./cursor";
import { msTs } from "./slack";
import { emptyStore } from "./store";

subprocessSuite("runs clerk/cursor.ts through bun");

const HOME = join(__dirname, "..");
const BUN = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim() || process.execPath;

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("the cursor CLI", () => {
  it("prints the cursor, and moves it to now dropping a handed batch", () => {
    const root = mkdtempSync(join(tmpdir(), "ralph-clerk-cursor-"));
    roots.push(root);
    cpSync(join(HOME, "fixtures", "clerk", ".ralph"), join(root, ".ralph"), { recursive: true });
    // Not a git repository, so the store falls back beside the worktree.
    const storePath = join(root, ".ralph-clerk", "clara.json");
    mkdirSync(join(root, ".ralph-clerk"), { recursive: true });
    const store = { ...emptyStore("C0TESTCHAN1"), cursor: "1760961600.000000", batch: { id: "batch-1760961660.000100", handedAt: "x", attempt: 1, reports: [] } };
    writeFileSync(storePath, JSON.stringify(store));
    const env = { ...process.env, RALPH_PROJECT: root, RALPH_LOOP_NAME: "clara" };

    const shown = spawnSync(BUN, [join(HOME, "clerk", "cursor.ts")], { cwd: root, encoding: "utf8", env });
    expect(shown.status).toBe(0);
    expect(shown.stdout).toBe("clerk-cursor: C0TESTCHAN1 (shadow) — cursor 1760961600.000000, batch batch-1760961660.000100\n");

    const before = Date.now() / 1000;
    const moved = spawnSync(BUN, [join(HOME, "clerk", "cursor.ts"), "--now"], { cwd: root, encoding: "utf8", env });
    expect(moved.status).toBe(0);
    expect(moved.stdout).toContain("dropped handed batch batch-1760961660.000100 — nothing posted before it will be filed");
    const after = JSON.parse(readFileSync(storePath, "utf8"));
    expect(Number(after.cursor)).toBeGreaterThanOrEqual(Math.floor(before));
    expect(after.batch).toBeNull();
  });
});

describe("--since", () => {
  const NOW = Date.parse("2026-10-22T15:00:00Z");

  it("reads a date or time with no offset in America/Santiago, across its DST change", () => {
    // Summer time (UTC-3) from September; winter time (UTC-4) before it.
    expect(sinceMs("2026-10-01", NOW)).toEqual({ ms: Date.parse("2026-10-01T03:00:00Z") });
    expect(sinceMs("2026-10-01T09:30", NOW)).toEqual({ ms: Date.parse("2026-10-01T12:30:00Z") });
    expect(sinceMs("2026-10-01 09:30:15", NOW)).toEqual({ ms: Date.parse("2026-10-01T12:30:15Z") });
    expect(sinceMs("2026-07-01", NOW)).toEqual({ ms: Date.parse("2026-07-01T04:00:00Z") });
  });

  it("reads an offset as written", () => {
    expect(sinceMs("2026-10-01T00:00:00Z", NOW)).toEqual({ ms: Date.parse("2026-10-01T00:00:00Z") });
    expect(sinceMs("2026-10-01T09:30:00.250-03:00", NOW)).toEqual({ ms: Date.parse("2026-10-01T12:30:00.250Z") });
    expect(sinceMs("2026-10-01T09:30+02:00", NOW)).toEqual({ ms: Date.parse("2026-10-01T07:30:00Z") });
  });

  it("refuses what is not a date, does not exist, or is still to come", () => {
    for (const text of ["yesterday", "2026-10-1", "01-10-2026", "2026-10-01T9:30", ""]) expect(sinceMs(text, NOW)).toHaveProperty("problem");
    expect(sinceMs("2026-02-30", NOW)).toEqual({ problem: '--since "2026-02-30" is not a date and time that exists' });
    expect(sinceMs("2026-10-01T24:00", NOW)).toHaveProperty("problem");
    expect(sinceMs("2026-10-23", NOW)).toEqual({ problem: '--since "2026-10-23" is still to come; the cursor marks what is done with, and nothing after now is' });
  });

  it("moves the cursor to just before the moment, keeping the processed reports, and starts a moved channel's store over", () => {
    const root = mkdtempSync(join(tmpdir(), "ralph-clerk-cursor-"));
    roots.push(root);
    cpSync(join(HOME, "fixtures", "clerk", ".ralph"), join(root, ".ralph"), { recursive: true });
    const storePath = join(root, ".ralph-clerk", "clara.json");
    mkdirSync(join(root, ".ralph-clerk"), { recursive: true });
    const env = { ...process.env, RALPH_PROJECT: root, RALPH_LOOP_NAME: "clara" };
    const run = (...args: string[]) => spawnSync(BUN, [join(HOME, "clerk", "cursor.ts"), ...args], { cwd: root, encoding: "utf8", env });

    const processed = { "1760961600.000100": { state: "filed", key: "SHADOW-1", at: "x" } };
    writeFileSync(storePath, JSON.stringify({ ...emptyStore("C0TESTCHAN1"), cursor: "1790000000.000000", processed, batch: { id: "batch-1", handedAt: "x", attempt: 1, reports: [] } }));
    const moved = run("--since", "2026-10-01");
    expect(moved.status, moved.stderr).toBe(0);
    const since = Date.parse("2026-10-01T03:00:00Z");
    expect(moved.stdout).toContain(`cursor moved from 1790000000.000000 to ${msTs(since - 1)}; dropped handed batch batch-1`);
    expect(moved.stdout).toContain("the history after it is read from the next poll on, 20 reports a batch");
    expect(JSON.parse(readFileSync(storePath, "utf8"))).toMatchObject({ channel: "C0TESTCHAN1", cursor: msTs(since - 1), batch: null, processed });

    // A store of another channel: none of its reading position is the new one's.
    writeFileSync(storePath, JSON.stringify({ ...emptyStore("C0OLDCHAN01"), cursor: "1700000000.000000", processed }));
    const fresh = run("--since=2026-10-01T09:30-03:00");
    expect(fresh.status, fresh.stderr).toBe(0);
    expect(fresh.stdout).toContain("is for C0OLDCHAN01, not C0TESTCHAN1");
    expect(fresh.stdout).toContain("cursor moved from not started to");
    expect(JSON.parse(readFileSync(storePath, "utf8"))).toMatchObject({ channel: "C0TESTCHAN1", cursor: msTs(Date.parse("2026-10-01T12:30:00Z") - 1), processed: {} });

    for (const args of [["--since"], ["--since", "mañana"], ["--now", "--since", "2026-10-01"], ["--later"], ["--redo"], ["--now", "--redo"], ["--since", "2026-10-01", "--redo", "--redo"]]) {
      expect(run(...args).status, args.join(" ")).toBe(64);
    }
  });
});

describe("--since --redo", () => {
  const project = (mode: "shadow" | "live") => {
    const root = mkdtempSync(join(tmpdir(), "ralph-clerk-redo-"));
    roots.push(root);
    cpSync(join(HOME, "fixtures", "clerk", ".ralph"), join(root, ".ralph"), { recursive: true });
    const configPath = join(root, ".ralph", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.clerk.mode = mode;
    writeFileSync(configPath, JSON.stringify(config));
    mkdirSync(join(root, ".ralph-clerk"), { recursive: true });
    const env = { ...process.env, RALPH_PROJECT: root, RALPH_LOOP_NAME: "clara" };
    return {
      storePath: join(root, ".ralph-clerk", "clara.json"),
      ledgerPath: join(root, ".ralph-clerk", "clara.metrics.jsonl"),
      run: (...args: string[]) => spawnSync(BUN, [join(HOME, "clerk", "cursor.ts"), ...args], { cwd: root, encoding: "utf8", env }),
      dir: join(root, ".ralph-clerk"),
    };
  };
  // 2026-10-01 in Santiago is 03:00Z, 1790823600.
  const BEFORE = "1790800000.000100";
  const AT = "1790823600.000000";
  const AFTER = "1790840000.000200";
  const OTHER = "1790850000.000300";
  const link = (channel: string, ts: string) => `https://team.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
  const ticket = (report: string, channel = "C0TESTCHAN1", reports = 1) => ({
    key: `SHADOW-${report.replace(".", "")}`,
    report,
    permalink: link(channel, report),
    type: "Error",
    summary: "x",
    labels: [],
    priority: "Low",
    createdAt: "x",
    reports,
  });
  const store = () => ({
    ...emptyStore("C0TESTCHAN1"),
    cursor: "1790000000.000000",
    processed: {
      [BEFORE]: { state: "filed", key: ticket(BEFORE).key, at: "x" },
      [AT]: { state: "ignored", key: null, at: "x" },
      [AFTER]: { state: "commented", key: ticket(BEFORE).key, at: "x" },
    },
    shadow: {
      // OTHER is a would-be ticket a store kept from an earlier channel.
      tickets: { [ticket(BEFORE).key]: ticket(BEFORE, "C0TESTCHAN1", 2), [ticket(OTHER).key]: ticket(OTHER, "C0OLDCHAN01") },
      writes: [
        { report: BEFORE, at: "x", write: { kind: "create" } },
        { report: AFTER, at: "x", write: { kind: "comment" } },
      ],
    },
    determinations: { [ticket(BEFORE).key]: { type: "Error" }, [ticket(OTHER).key]: { type: "Error" } },
    batch: { id: "batch-1", handedAt: "x", attempt: 1, reports: [] },
  });

  it("drops the shadow decisions from the moment on, backs the store up, and supersedes their ledger events", () => {
    const { storePath, ledgerPath, run, dir } = project("shadow");
    const original = JSON.stringify(store());
    writeFileSync(storePath, original);
    const event = (report: string, kind: string) => JSON.stringify({ v: 1, at: "2026-10-02T00:00:00.000Z", report, mode: "shadow", kind, reason: "x" });
    writeFileSync(ledgerPath, `${event(BEFORE, "classified")}\n${event(AT, "ignored")}\n${event(AFTER, "duplicate")}\n`);

    const redone = run("--since", "2026-10-01", "--redo");
    expect(redone.status, redone.stderr).toBe(0);
    expect(redone.stdout).toContain("redo in shadow — 2 reports dropped to be classified again; the store before it is");

    const after = JSON.parse(readFileSync(storePath, "utf8"));
    expect(after.cursor).toBe(msTs(Date.parse("2026-10-01T03:00:00Z") - 1));
    expect(after.batch).toBeNull();
    expect(Object.keys(after.processed)).toEqual([BEFORE]);
    // The kept ticket loses the duplicate folded into it; the old channel's is untouched.
    expect(after.shadow.tickets).toEqual({ [ticket(BEFORE).key]: ticket(BEFORE), [ticket(OTHER).key]: ticket(OTHER, "C0OLDCHAN01") });
    expect(after.shadow.writes).toEqual([{ report: BEFORE, at: "x", write: { kind: "create" } }]);
    expect(Object.keys(after.determinations).sort()).toEqual([ticket(BEFORE).key, ticket(OTHER).key].sort());

    const backups = readdirSync(dir).filter((name) => name.startsWith("clara.json.bak-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, backups[0]!), "utf8")).toBe(original);

    const ledger = readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(ledger.slice(3).map((line) => [line.kind, line.report, line.mode])).toEqual([
      ["superseded", AT, "shadow"],
      ["superseded", AFTER, "shadow"],
    ]);
  });

  it("refuses a live clerk, changing nothing", () => {
    const { storePath, run, dir } = project("live");
    const original = JSON.stringify(store());
    writeFileSync(storePath, original);
    const refused = run("--since", "2026-10-01", "--redo");
    expect(refused.status).toBe(64);
    expect(refused.stderr).toContain("--redo refused: clerk.mode is live");
    expect(readFileSync(storePath, "utf8")).toBe(original);
    expect(readdirSync(dir)).toEqual(["clara.json"]);
  });
});
