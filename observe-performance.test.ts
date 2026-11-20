// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeProjectConfig } from "./dashboard/fixtures";
import { snapshot, worktreeReport, type Clock } from "./loop-state";
import { harnessJournalReader, observeRun } from "./observe";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("builds fixture git repos and observes real runs");

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), readdirSync: vi.fn(actual.readdirSync) };
});
const roots: string[] = [];
afterEach(() => { vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const scratch = () => { const root = mkdtempSync(join(tmpdir(), "observe-performance-")); roots.push(root); return root; };
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
const repo = () => { const root = scratch(); git(root, "init", "-q"); git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial", "--allow-empty"); return root; };
const clock: Clock = { nowMs: Date.now(), loopStaleAfterMs: 3600000, worktreeStaleAfterMs: 604800000 };
const state = (root: string) => ({ version: 1, run: "run", owner: { loop: "ralph", pid: 99999999, host: "test" }, worktree: root, branch: "ralph/123-test", stage: "iteration", iteration: { index: 1, max: 5 }, heartbeat: new Date(clock.nowMs).toISOString(), lastEvent: null, stopReason: null });
const writeState = (root: string, value: unknown = state(root)) => { mkdirSync(join(root, ".ralph/logs"), { recursive: true }); writeFileSync(join(root, ".ralph/logs/state.json"), JSON.stringify(value)); };

describe("bounded observer reads", () => {
  it("reads the newest 200 published entries in order with two Git processes, preserving UTF-8 bodies", () => {
    const root = repo(); mkdirSync(join(root, "journal"));
    const entries = Array.from({ length: 205 }, (_, index) => ({ name: `20260920T120000Z-${String(index).padStart(3, "0")}-entry.md`, body: `# café 日本語 ${index}\n\nbody\n` }));
    for (const entry of entries) writeFileSync(join(root, "journal", entry.name), entry.body);
    writeFileSync(join(root, "journal", "README.md"), "ignore");
    git(root, "add", "."); git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "journal"); git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    vi.mocked(execFileSync).mockClear();
    expect(harnessJournalReader(root, root, { RALPH_JOURNAL_DIR: "journal/" })()).toEqual(entries.slice(-200));
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(vi.mocked(execFileSync).mock.calls[1]?.[1]).toEqual(["-C", root, "cat-file", "--batch"]);
  });

  it("skips the batch for an empty journal and tolerates Git failure", () => {
    const root = scratch();
    vi.mocked(execFileSync).mockReturnValueOnce("journal/README.md\n");
    expect(harnessJournalReader(root, root, { RALPH_JOURNAL_DIR: "journal" })()).toEqual([]);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error("unavailable"); });
    expect(harnessJournalReader(root, root, { RALPH_JOURNAL_DIR: "journal" })()).toEqual([]);
  });

  it("keeps the readable prefix when a batch object is missing or truncated", () => {
    const root = scratch(); const names = ["journal/20260920T120000Z-1-a.md", "journal/20260920T120000Z-2-b.md"];
    for (const tail of ["origin/main:missing missing\n", "abc blob 10\nshort"]) {
      vi.mocked(execFileSync).mockReturnValueOnce(names.join("\n")).mockReturnValueOnce(`abc blob 3\none\n${tail}`);
      expect(harnessJournalReader(root, root, { RALPH_JOURNAL_DIR: "journal" })()).toEqual([{ name: names[0]!.split("/").at(-1), body: "one" }]);
    }
  });

  it("retains complete entries when the batch reaches its output cap", () => {
    const root = scratch();
    const names = ["journal/20260920T120000Z-1-a.md", "journal/20260920T120000Z-2-b.md"];
    const stdout = "abc blob 5\ncafé\ndef blob 10\npartial";
    vi.mocked(execFileSync).mockReturnValueOnce(names.join("\n")).mockImplementationOnce(() => {
      throw Object.assign(new Error("spawnSync git ENOBUFS"), { code: "ENOBUFS", stdout });
    });
    expect(harnessJournalReader(root, root, { RALPH_JOURNAL_DIR: "journal" })()).toEqual([
      { name: "20260920T120000Z-1-a.md", body: "café" },
    ]);
    expect(execFileSync).toHaveBeenCalledTimes(2);
    // Captured output on a different failure must not become journal evidence.
    vi.mocked(execFileSync).mockReturnValueOnce(names.join("\n")).mockImplementationOnce(() => {
      throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT", stdout });
    });
    expect(harnessJournalReader(root, root, { RALPH_JOURNAL_DIR: "journal" })()).toEqual([]);
  });

  it("observes only its registered worktree and reads its timeline once", () => {
    const root = repo(); const peer = join(scratch(), "peer"); git(root, "worktree", "add", "-qb", "peer", peer);
    // The observer reads the branch against the project's roster.
    writeProjectConfig(root);
    for (const path of [root, peer]) {
      writeState(path);
      writeFileSync(join(path, ".ralph/logs/iter-1.events.jsonl"), JSON.stringify({ type: "text", part: { text: "hello" }, ralph_run: "run", ralph_iteration: 1, ralph_stage: "executor", ralph_received_at: new Date(clock.nowMs).toISOString() }) + "\n");
    }
    vi.mocked(readFileSync).mockClear(); vi.mocked(readdirSync).mockClear();
    expect(observeRun(root, clock)).toMatchObject({ loop: "ralph", run: "run", recent: [expect.objectContaining({ label: "text — hello" })] });
    const reads = vi.mocked(readFileSync).mock.calls.map(([path]) => String(path));
    expect(reads.filter((path) => path.endsWith("iter-1.events.jsonl"))).toEqual([join(root, ".ralph/logs/iter-1.events.jsonl")]);
    expect(reads.some((path) => path.startsWith(peer))).toBe(false);
    expect(vi.mocked(readdirSync).mock.calls.some(([path]) => String(path).startsWith(peer))).toBe(false);
    expect(worktreeReport(root, clock)?.report).toEqual(snapshot(root, clock).loops.find((report) => report.worktree === root));
    const alias = join(scratch(), "alias"); symlinkSync(root, alias);
    expect(worktreeReport(alias, clock)?.report.worktree).toBe(root);
  });

  it.each(["missing", "foreign", "unreadable"])("preserves %s state and liveness reconciliation", (problem) => {
    const root = repo();
    if (problem === "foreign") writeState(root, state("/different/worktree"));
    if (problem === "unreadable") { writeState(root); writeFileSync(join(root, ".ralph/logs/state.json"), "{"); }
    expect(worktreeReport(root, clock)?.report).toEqual(snapshot(root, clock).loops[0]);
    expect(worktreeReport(root, clock)?.report).toMatchObject({ stateProblem: problem, state: null, supervisor: "dead" });
  });

  it("does not invent a self report when Git lists only another worktree", () => {
    const root = scratch();
    vi.mocked(execFileSync).mockReturnValueOnce(`worktree ${join(root, "peer")}\nHEAD abc\nbranch refs/heads/main\n\n`);
    expect(worktreeReport(root, clock)).toBeNull();
  });

  it("preserves a missing registered worktree as an orphan", () => {
    const root = join(scratch(), "gone");
    vi.mocked(execFileSync).mockReturnValueOnce(`worktree ${root}\nHEAD abc\nbranch refs/heads/main\n\n`);
    expect(worktreeReport(root, clock)?.report).toMatchObject({ worktreeStatus: "orphaned", stateProblem: null, state: null, supervisor: "dead" });
  });

  it("falls back to self when Git has no registry", () => {
    const root = scratch();
    expect(worktreeReport(root, clock)?.report).toMatchObject({ worktree: root, stateProblem: "missing", supervisor: "dead" });
  });
});
