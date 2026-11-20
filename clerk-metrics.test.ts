// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { EXIT, formatTable, loopName, parseFlags } from "./clerk-metrics";
import { appendEvent, clerkMetricsPath, type MetricsEvent } from "./clerk/metrics";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("bun clerk-metrics.ts");

const SCRIPT = join(import.meta.dirname, "clerk-metrics.ts");
const BUN = execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A scratch intake project: its own git repo, never this checkout's `.ralph/`. */
function scratchRepo(loop?: string): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "ralph-clerk-metrics-cli-")));
  scratch.push(repo);
  execFileSync("git", ["init", "-q", repo]);
  if (loop !== undefined) {
    mkdirSync(join(repo, ".ralph"));
    writeFileSync(join(repo, ".ralph", "loop-name"), `${loop}\n`);
  }
  return repo;
}

function run(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env };
  // The suite may itself run under a loop; the CLI must read the scratch repo's identity.
  delete env.RALPH_PROJECT;
  delete env.RALPH_LOOP_NAME;
  const out = spawnSync(BUN, [SCRIPT, ...args], { cwd, env, encoding: "utf8" });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

const base = { v: 1 as const, at: "2026-10-21T12:00:00.000Z", mode: "shadow" as const };
const ledger: MetricsEvent[] = [
  { ...base, kind: "reported", report: "1.1", reporter: "U1", reporterName: "Ana", channel: "C1", reportedAt: "2026-10-20T15:00:00.000Z" },
  { ...base, kind: "classified", report: "1.1", key: "OAI-1", verdict: "file", app: "backoffice", storyPoints: 3 },
  {
    ...base,
    kind: "confirmed",
    report: "1.1",
    key: "OAI-1",
    by: { accountId: "acc", displayName: "Rafa" },
    latencyMs: 90_000,
    overrides: [{ field: "storyPoints", agent: 3, human: 5 }],
  },
  { ...base, kind: "closed", report: "1.1", key: "OAI-1", resolution: "Done", status: "Done" },
  { ...base, kind: "reported", report: "2.2", reporter: "U2", channel: "C1", reportedAt: "2026-10-21T15:00:00.000Z" },
  { ...base, kind: "ignored", report: "2.2", reason: "chatter" },
];

describe("clerk-metrics CLI", () => {
  it("pins the --json shape the dashboard reads", () => {
    const repo = scratchRepo("clara");
    const path = clerkMetricsPath("clara", repo);
    for (const event of ledger) expect(appendEvent(path, event)).toBe(true);
    // A kill mid-append: the rest still summarises.
    appendFileSync(path, '{"v":1,"kind":"rep');

    const out = run(repo, ["--json"]);
    expect(out.status).toBe(EXIT.ok);
    expect(JSON.parse(out.stdout)).toEqual({
      v: 1,
      by: "reporter",
      rows: [
        {
          key: "U1",
          label: "Ana",
          reports: 1,
          valuable: 1,
          noise: 0,
          pending: 0,
          duplicates: 0,
          noiseRate: 0,
          confirmed: 1,
          overrideRate: 1,
          overridesByField: { storyPoints: 1 },
          overrideRateByField: { storyPoints: 1 },
          topChanges: [{ field: "storyPoints", agent: 3, human: 5, count: 1 }],
          medianConfirmLatencyMs: 90_000,
        },
        {
          key: "U2",
          reports: 1,
          valuable: 0,
          noise: 1,
          pending: 0,
          duplicates: 0,
          noiseRate: 1,
          confirmed: 0,
          overrideRate: null,
          overridesByField: {},
          overrideRateByField: {},
          topChanges: [],
          medianConfirmLatencyMs: null,
        },
      ],
      skippedLines: 1,
      modes: { shadow: 2, quiet: 0, live: 0 },
    });
  });

  it("keeps quiet and shadow reports apart from live with --mode, and always says what the ledger mixes (#443)", () => {
    const repo = scratchRepo("clara");
    const path = clerkMetricsPath("clara", repo);
    const asMode = (mode: "quiet" | "live", report: string) => ledger.slice(0, 4).map((event) => ({ ...event, mode, report }));
    for (const event of [...asMode("quiet", "3.3"), ...asMode("live", "4.4"), ...ledger.slice(4)]) appendEvent(path, event);

    const all = JSON.parse(run(repo, ["--json"]).stdout) as { rows: { reports: number }[]; modes: Record<string, number> };
    expect(all.modes).toEqual({ shadow: 1, quiet: 1, live: 1 });
    expect(all.rows.reduce((sum, row) => sum + row.reports, 0)).toBe(3);

    const live = JSON.parse(run(repo, ["--json", "--mode", "live"]).stdout) as { rows: { key: string; reports: number; valuable: number }[]; modes: Record<string, number> };
    expect(live.rows).toMatchObject([{ key: "U1", reports: 1, valuable: 1 }]);
    // The counts are the whole ledger's, so a filtered view still says what it left out.
    expect(live.modes).toEqual({ shadow: 1, quiet: 1, live: 1 });

    const tests = JSON.parse(run(repo, ["--json", "--mode", "quiet,shadow"]).stdout) as { rows: { key: string; reports: number }[] };
    expect(tests.rows.map((row) => `${row.key} ${row.reports}`)).toEqual(["U1 1", "U2 1"]);

    expect(run(repo, []).stdout).toContain("ledger reports by mode: shadow 1, quiet 1, live 1 (--mode live for the team's alone)");
    const refused = run(repo, ["--mode", "dry"]);
    expect(refused.status).toBe(EXIT.usage);
    expect(refused.stderr).toContain("--mode takes shadow, quiet or live");
  });

  it("groups by app and week, and filters by --since", () => {
    const repo = scratchRepo("clara");
    const path = clerkMetricsPath("clara", repo);
    for (const event of ledger) appendEvent(path, event);

    const byApp = JSON.parse(run(repo, ["--json", "--by", "app"]).stdout) as { rows: { key: string }[] };
    expect(byApp.rows.map((row) => row.key)).toEqual(["(unknown)", "backoffice"]);

    const byWeek = JSON.parse(run(repo, ["--json", "--by", "week", "--since", "2026-10-21"]).stdout) as {
      by: string;
      rows: { key: string; reports: number }[];
    };
    expect(byWeek.by).toBe("week");
    expect(byWeek.rows).toMatchObject([{ key: "2026-W43", reports: 1 }]);
  });

  it("reads --loop over .ralph/loop-name", () => {
    const repo = scratchRepo("clara");
    appendEvent(clerkMetricsPath("other", repo), ledger[0]!);
    const named = JSON.parse(run(repo, ["--json", "--loop", "other"]).stdout) as { rows: unknown[] };
    expect(named.rows).toHaveLength(1);
    const defaulted = JSON.parse(run(repo, ["--json"]).stdout) as { rows: unknown[] };
    expect(defaulted.rows).toHaveLength(0);
  });

  it("prints the empty summary for a missing ledger and exits 0", () => {
    const repo = scratchRepo();
    const json = run(repo, ["--json"]);
    expect(json.status).toBe(EXIT.ok);
    expect(JSON.parse(json.stdout)).toEqual({ v: 1, by: "reporter", rows: [], skippedLines: 0, modes: { shadow: 0, quiet: 0, live: 0 } });

    const table = run(repo, []);
    expect(table.status).toBe(EXIT.ok);
    expect(table.stdout).toContain("reporter");
    expect(table.stdout).toContain("(no reports)");
  });

  it("prints a plain table", () => {
    const repo = scratchRepo("clara");
    const path = clerkMetricsPath("clara", repo);
    for (const event of ledger) appendEvent(path, event);
    const out = run(repo, []);
    expect(out.status).toBe(EXIT.ok);
    const lines = out.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^reporter\s+reports\s+valuable\s+noise\s+pending\s+duplicates/);
    expect(lines[1]).toMatch(/^Ana \(U1\)\s+1\s+1\s+0\s+0\s+0\s+0%\s+100%\s+storyPoints:1\(100%\)\s+2m\s+storyPoints 3→5 x1$/);
    expect(lines[2]).toMatch(/^U2\s+1\s+0\s+1\s+0\s+0\s+100%\s+-\s+-\s+-\s+-$/);
  });

  it("refuses bad arguments with exit 64", () => {
    const out = run(scratchRepo(), ["--by", "team"]);
    expect(out.status).toBe(EXIT.usage);
    expect(out.stderr).toContain("--by takes reporter, app or week");
  });
});

describe("parseFlags", () => {
  it.each([
    [[], { flags: { json: false, by: "reporter" } }],
    [["--json", "--by", "week", "--since", "2026-10-01", "--loop", "clara"], { flags: { json: true, by: "week", since: "2026-10-01", loop: "clara" } }],
    [["--mode", "quiet,live,quiet"], { flags: { json: false, by: "reporter", modes: ["quiet", "live"] } }],
    [["--mode"], { problem: "--mode takes shadow, quiet or live, or several comma-separated" }],
    [["--since", "yesterday"], { problem: "--since takes a date as YYYY-MM-DD" }],
    [["--since"], { problem: "--since takes a date as YYYY-MM-DD" }],
    [["--loop", "--json"], { problem: "--loop takes a loop name" }],
    [["--nope"], { problem: "unknown argument: --nope" }],
  ])("%j", (argv, expected) => {
    expect(parseFlags(argv)).toEqual(expected);
  });
});

describe("loopName", () => {
  it("prefers RALPH_LOOP_NAME, then .ralph/loop-name, then clerk", () => {
    const repo = scratchRepo("clara");
    expect(loopName(repo, { RALPH_LOOP_NAME: "env" })).toBe("env");
    expect(loopName(repo, {})).toBe("clara");
    expect(loopName(join(repo, "missing"), {})).toBe("clerk");
  });
});

describe("formatTable", () => {
  it("notes skipped lines", () => {
    expect(formatTable({ v: 1, by: "app", rows: [], skippedLines: 2, modes: { shadow: 0, quiet: 0, live: 0 } })).toContain("skipped 2 unreadable ledger line(s)");
  });

  it("says nothing of modes for a ledger that is live alone", () => {
    expect(formatTable({ v: 1, by: "app", rows: [], skippedLines: 0, modes: { shadow: 0, quiet: 0, live: 4 } })).not.toContain("by mode");
  });
});
