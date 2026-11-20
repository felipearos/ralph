// @vitest-environment node
/**
 * `clerk-intake.ts`, the intake page's read (felipearos/ralph#459), run as the
 * dashboard runs it: `RALPH_PROJECT` naming a scratch intake project, never
 * this checkout's `.ralph/`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { EXIT } from "./clerk-intake";
import { intakeSnapshotPath, recordIntakeSnapshot } from "./clerk/intake-snapshot";
import { appendEvent, clerkMetricsPath } from "./clerk/metrics";
import { clerkStorePath } from "./clerk/store";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("bun clerk-intake.ts");

const SCRIPT = join(import.meta.dirname, "clerk-intake.ts");
const BUN = execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
const FIXTURE = join(import.meta.dirname, "fixtures", "clerk", ".ralph", "config.json");

const scratch: string[] = [];
afterAll(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A scratch intake project: its own git repo with the clerk fixture's config, whose roster's clerk is `clara`. */
function project(withConfig = true): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "ralph-clerk-intake-cli-")));
  scratch.push(repo);
  execFileSync("git", ["init", "-q", repo]);
  if (withConfig) {
    mkdirSync(join(repo, ".ralph"));
    copyFileSync(FIXTURE, join(repo, ".ralph", "config.json"));
  }
  return repo;
}

function run(root: string, args: string[]): { status: number | null; json: Record<string, unknown> | null; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env, RALPH_PROJECT: root };
  delete env.RALPH_LOOP_NAME;
  const out = spawnSync(BUN, [SCRIPT, ...args], { cwd: import.meta.dirname, env, encoding: "utf8" });
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(out.stdout) as Record<string, unknown>;
  } catch {}
  return { status: out.status, json, stderr: out.stderr };
}

describe("clerk-intake.ts --json", () => {
  it("says the clerk has not published yet, then prints the snapshot the gate wrote", () => {
    const root = project();
    const before = run(root, ["--json"]);
    expect(before.status).toBe(EXIT.ok);
    expect(before.json).toMatchObject({ v: 1, available: false, loop: "clara" });
    expect(String(before.json!.reason)).toMatch(/todavía no ha publicado/);

    const note = recordIntakeSnapshot(intakeSnapshotPath(clerkStorePath("clara", root)), { title: "", links: [],
      source: "shadow",
      mode: "shadow",
      canvasRowCap: 32,
      nowMs: Date.parse("2026-10-22T12:00:00.000Z"),
      tickets: [],
    });
    expect(note).toBeNull();
    expect(run(root, ["--json"]).json).toEqual({
      v: 1,
      available: true,
      loop: "clara",
      reason: null,
      generatedAt: "2026-10-22T12:00:00.000Z",
      source: "shadow",
      mode: "shadow",
      canvasRowCap: 32,
      title: "",
      links: [],
      tickets: [],
    });
  });

  it("is an unavailable view, exit 0, for a project with no readable config", () => {
    const out = run(project(false), ["--json"]);
    expect(out.status).toBe(EXIT.ok);
    expect(out.json).toMatchObject({ available: false, loop: null });
  });

  it("refuses to run without --json, and an unknown argument", () => {
    expect(run(project(), []).status).toBe(EXIT.usage);
    expect(run(project(), ["--json", "--nope"]).status).toBe(EXIT.usage);
  });
});

describe("clerk-intake.ts --metrics --json", () => {
  it("prints the clerk-metrics rows by reporter, app and week, and participation", () => {
    const root = project();
    const path = clerkMetricsPath("clara", root);
    const base = { v: 1 as const, at: "2026-10-21T12:00:00.000Z", mode: "shadow" as const };
    appendEvent(path, { ...base, kind: "reported", report: "1.1", reporter: "U1", reporterName: "Ana", channel: "C1", reportedAt: "2026-10-20T15:00:00.000Z" });
    appendEvent(path, { ...base, kind: "classified", report: "1.1", verdict: "issue", app: "Backoffice" });
    const out = run(root, ["--metrics", "--json"]);
    expect(out.status).toBe(EXIT.ok);
    expect(out.json).toMatchObject({ v: 1, available: true, loop: "clara", skippedLines: 0 });
    expect(out.json!.byReporter).toEqual([expect.objectContaining({ key: "U1", label: "Ana", reports: 1, pending: 1 })]);
    expect(out.json!.byApp).toEqual([expect.objectContaining({ key: "Backoffice", reports: 1 })]);
    expect(out.json!.byWeek).toEqual([expect.objectContaining({ key: "2026-W43" })]);
    expect(out.json!.participation).toEqual([expect.objectContaining({ key: "U1", reports: 1 })]);
  });
});
