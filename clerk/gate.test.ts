// @vitest-environment node
/**
 * The clerk's gate contract (felipearos/ralph#316, #317): the lines `ralph.sh`
 * reads, the `--once` verdict, and the blocking wait that honours the control
 * inbox and a supervisor that is gone, run as the supervisor runs it against
 * the clerk fixture project. What a poll decides from Slack is
 * `clerk/gate-poll.test.ts`'s, against a fake Slack in-process: no process
 * here ever reaches Slack.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { hasPendingCommand, readInbox, writeInboxCommand } from "../control-inbox";
import { commandFromInbox } from "../controls";
import { subprocessSuite } from "../test-timeouts";
import { CONTROL_PENDING_LINE, verdictLine, waitingLine } from "./gate";

subprocessSuite("runs clerk/gate.ts through bun");

const HOME = join(__dirname, "..");
const GATE = join(HOME, "clerk", "gate.ts");
const BUN = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim() || process.execPath;
const FIXTURE = join(HOME, "fixtures", "clerk", ".ralph");

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

/** A worktree carrying the clerk fixture's `.ralph/`. */
function intakeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "ralph-clerk-gate-"));
  roots.push(root);
  cpSync(FIXTURE, join(root, ".ralph"), { recursive: true });
  return root;
}

const gateEnv = (project: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  RALPH_PROJECT: project,
  RALPH_LOOP_NAME: "clara",
  // Not a real token. Every process here stops before its first Slack call:
  // a fresh store's first poll only starts the clock.
  RALPH_CLERK_SLACK_TOKEN: "xoxb-test-not-a-real-token",
  RALPH_CLERK_JIRA_TOKEN: "clerk@example.com:not-a-real-token",
  ...extra,
});

describe("the lines the supervisor reads", () => {
  // `ralph.sh`'s two patterns, verbatim.
  const CASE_LINE = /^[A-Za-z0-9_.-]+: work available — (.*)$/;
  const CONTROL_LINE = /^[A-Za-z0-9_.-]+: control command waiting/;

  it("never read as a case when there is none", () => {
    const line = verdictLine({ work: false, why: "the channel is quiet" });
    expect(line).toBe("clerk-gate: nothing to do — the channel is quiet");
    expect(CASE_LINE.test(line)).toBe(false);
  });

  it("carry a case the supervisor can read off them", () => {
    expect(CASE_LINE.exec(verdictLine({ work: true, why: "2 settled reports" }))?.[1]).toBe("2 settled reports");
  });

  it("hand back to the control checkpoint in the shape ralph.sh matches", () => {
    expect(CONTROL_LINE.test(CONTROL_PENDING_LINE)).toBe(true);
    expect(CASE_LINE.test(CONTROL_PENDING_LINE)).toBe(false);
  });

  it("prove an idle clerk is alive rather than dead", () => {
    const now = Date.parse("2026-10-20T10:00:00Z");
    const line = waitingLine(
      { work: false, why: "the channel is quiet" },
      { poll: 3, waitingSince: new Date(now - 900_000), now: new Date(now), waitSeconds: 300 },
    );
    expect(line).toBe("clerk-gate: the channel is quiet at 2026-10-20T10:00:00Z — waiting 300s (poll 3, idle 15m)");
    expect(CASE_LINE.test(line)).toBe(false);
  });
});

describe("the gate as a process", () => {
  it("starts the clock on a fresh store without asking Slack anything, and exits 1", () => {
    // The token is not a real one, and nothing may reach Slack with it: the
    // first poll of a store only records where the clerk starts.
    const project = intakeProject();
    const run = spawnSync(BUN, [GATE, "--once"], { cwd: project, encoding: "utf8", env: gateEnv(project) });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(1);
    expect(run.stdout.trim()).toMatch(/^clerk-gate: nothing to do — starting at \d+\.\d{6}: nothing posted before it is filed$/);
  });

  it("stops the loop when it was handed no token: the remedy, a stop in its own inbox, and exit 2", () => {
    const project = intakeProject();
    const run = spawnSync(BUN, [GATE, "--once"], {
      cwd: project,
      encoding: "utf8",
      env: gateEnv(project, { RALPH_CLERK_SLACK_TOKEN: "", RALPH_RUN_ID: "clara-run-1" }),
    });
    expect(run.status).toBe(2);
    const lines = run.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/^clerk-gate: stopping the loop — the gate was handed no RALPH_CLERK_SLACK_TOKEN; store the clerk's Slack bot token/);
    const inbox = readInbox(project);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.kind === "command" && inbox[0]!.value).toMatchObject({ command: "stop", loop: "clara", run: "clara-run-1", stop: "blocked", via: "clerk-gate" });
    expect(hasPendingCommand(project)).toBe(true);
    // And it is a command the supervisor's checkpoint applies: a `stop` of
    // kind `blocked`, addressed to this loop and this run.
    const command = inbox[0]!.kind === "command" ? commandFromInbox({ stem: inbox[0]!.stem, value: inbox[0]!.value }) : null;
    expect(command).toMatchObject({ command: "stop", stopKind: "blocked", loop: "clara", run: "clara-run-1", via: "clerk-gate" });
    expect(command?.why).toContain("RALPH_CLERK_SLACK_TOKEN");
  });

  it("refuses to guess a channel for a project with no clerk block, as a non-verdict exit", () => {
    const project = intakeProject();
    const config = JSON.parse(readFileSync(join(project, ".ralph", "config.json"), "utf8"));
    delete config.clerk;
    config.loops = ["ralph"];
    writeFileSync(join(project, ".ralph", "config.json"), JSON.stringify(config));
    const run = spawnSync(BUN, [GATE, "--once"], { cwd: project, encoding: "utf8", env: gateEnv(project) });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("no 'clerk' block");
  });

  it("stops when its supervisor is gone, rather than polling for nobody", () => {
    const dead = spawnSync("true");
    const project = intakeProject();
    const run = spawnSync(BUN, [GATE, "3600"], {
      cwd: project,
      encoding: "utf8",
      env: gateEnv(project, { RALPH_SUPERVISOR_PID: String(dead.pid), RALPH_CONTROL_POLL_SECONDS: "1" }),
      timeout: 20_000,
    });
    expect(run.status).toBe(0);
    const lines = run.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/^clerk-gate: .* — waiting 3600s \(poll 1, idle 0s\)$/);
    expect(lines.at(-1)).toBe(`clerk-gate: supervisor ${dead.pid} is gone — stopping.`);
  });

  it("hands back to the supervisor when an operator command is waiting", async () => {
    const project = intakeProject();
    const child = spawn(BUN, [GATE, "3600"], {
      cwd: project,
      env: gateEnv(project, { RALPH_SUPERVISOR_PID: String(process.pid), RALPH_CONTROL_POLL_SECONDS: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    const waiting = new Promise<void>((resolve) => {
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
        if (out.includes("waiting 3600s")) resolve();
      });
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    try {
      // Raced against the exit, so a gate that dies before it waits fails here
      // rather than at the suite's timeout.
      await Promise.race([
        waiting,
        exited.then((code) => {
          throw new Error(`the gate exited ${code} before it waited: ${out}`);
        }),
      ]);
      writeInboxCommand(project, {
        version: 1,
        id: "stop-clara-1",
        command: "stop",
        loop: "clara",
        why: "operator",
        stop: "blocked",
        issuedAt: new Date().toISOString(),
      });
      expect(await exited).toBe(0);
    } finally {
      child.kill("SIGKILL");
    }
    expect(out.trim().split("\n").at(-1)).toBe(CONTROL_PENDING_LINE);
  });
});
