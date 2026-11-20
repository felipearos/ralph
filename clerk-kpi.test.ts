// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { EXIT, parseFlags } from "./clerk-kpi";
import { appendEvent, clerkMetricsPath, type MetricsEvent } from "./clerk/metrics";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("bun clerk-kpi.ts");

const SCRIPT = join(import.meta.dirname, "clerk-kpi.ts");
const BUN = execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A scratch intake project with the clerk fixture's config: its own git repo, never this checkout's `.ralph/`. */
function scratchRepo(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "ralph-clerk-kpi-cli-")));
  scratch.push(repo);
  execFileSync("git", ["init", "-q", repo]);
  mkdirSync(join(repo, ".ralph"));
  writeFileSync(join(repo, ".ralph", "loop-name"), "clara\n");
  execFileSync("cp", [join(import.meta.dirname, "fixtures", "clerk", ".ralph", "config.json"), join(repo, ".ralph", "config.json")]);
  return repo;
}

function run(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.RALPH_PROJECT;
  delete env.RALPH_LOOP_NAME;
  // A Slack token in the environment must not matter: --print never calls Slack.
  env.RALPH_CLERK_SLACK_TOKEN = "xoxb-would-fail";
  const out = spawnSync(BUN, [SCRIPT, ...args], { cwd, env, encoding: "utf8" });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

const base = { v: 1 as const, mode: "shadow" as const };
const LEDGER: MetricsEvent[] = [
  { ...base, at: "2026-10-21T13:00:00Z", kind: "reported", report: "1", reporter: "U0ANA00001", channel: "C0TESTCHAN1", reportedAt: "2026-10-21T13:00:00Z" },
  { ...base, at: "2026-10-21T13:10:00Z", kind: "classified", report: "1", key: "OAI-1", verdict: "issue", app: "Backoffice", assignee: "agent", difficulty: "easy", storyPoints: 2 },
];

describe("clerk-kpi CLI", () => {
  it("prints the report from the ledger with the fixture's draft framing, and calls no Slack", () => {
    const repo = scratchRepo();
    const path = clerkMetricsPath("clara", repo);
    for (const event of LEDGER) expect(appendEvent(path, event)).toBe(true);

    const out = run(repo, ["--print", "--date", "2026-10-22", "--members", "U0ANA00001,U0BETO0001"]);
    expect(out.stderr).toBe("");
    expect(out.status).toBe(EXIT.ok);
    expect(out.stdout).toContain("_Borrador, solo para el operador; destinatarios configurados: <@U0RECIPNT1>, <@U0RECIPNT2>._");
    expect(out.stdout).toContain("*Reporte diario de intake, 2026-10-22* (periodo: 2026-10-21)");
    expect(out.stdout).toContain("- Por app: Backoffice 1");
    expect(out.stdout).toContain("- Sin reportes en los últimos 7 días: <@U0BETO0001>");
  });

  it("says the members were not available without --members", () => {
    const out = run(scratchRepo(), ["--print", "--date", "2026-10-22"]);
    expect(out.status).toBe(EXIT.ok);
    expect(out.stdout).toContain("- Datos de miembros del canal no disponibles (--print no consulta Slack; pase --members)");
    expect(out.stdout).toContain("- Reportes recibidos: 0");
  });

  it("refuses to run without --print", () => {
    const out = run(scratchRepo(), []);
    expect(out.status).toBe(EXIT.usage);
    expect(out.stderr).toContain("--print is required");
  });
});

describe("flags", () => {
  it("parses and refuses", () => {
    expect(parseFlags(["--print", "--members", "U1, U2,", "--loop", "clara"])).toEqual({ flags: { print: true, members: ["U1", "U2"], loop: "clara" } });
    expect(parseFlags(["--print", "--date", "22-10-2026"])).toEqual({ problem: "--date takes a date as YYYY-MM-DD" });
    expect(parseFlags(["--print", "--send"])).toEqual({ problem: "unknown argument: --send" });
  });
});
