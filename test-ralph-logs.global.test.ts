// @vitest-environment node
/**
 * The guard has to fail a real run, not just diff two maps, so this drives a
 * child vitest whose `globalSetup` is the guard and whose watched checkout is a
 * scratch tree. The fixture suites below are what a polluting suite looks like.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { scratchDir } from "./test-scratch";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs a child vitest per case to prove the guard fails the run");

const BUN = execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
const ROOT = import.meta.dirname;

/** A scratch checkout with a `.ralph/logs`, plus a suite that writes `body`. */
function fixture(body: string): { dir: string; guarded: string } {
  const dir = scratchDir("ralph-logs-guard-run-");
  const guarded = join(dir, "checkout");
  mkdirSync(join(guarded, ".ralph", "logs"), { recursive: true });
  writeFileSync(join(guarded, ".ralph", "logs", "kept.log"), "already here\n");
  writeFileSync(join(dir, "fixture.test.ts"), body);
  writeFileSync(
    join(dir, "vitest.config.ts"),
    `export default { test: { globalSetup: [${JSON.stringify(join(ROOT, "test-ralph-logs.global.ts"))}] } };\n`,
  );
  return { dir, guarded };
}

/** The child run's status and its combined output. */
function run(dir: string, guarded: string, env: Record<string, string> = {}): { status: number | null; out: string } {
  const child = spawnSync(BUN, ["x", "vitest", "run", "--root", dir], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", RALPH_TEST_LOGS_GUARD_ROOT: guarded, ...env },
    timeout: 60_000,
  });
  return { status: child.status, out: `${child.stdout}${child.stderr}` };
}

/** A suite that writes `name` under the guarded checkout's `.ralph/logs`. */
const writes = (name: string): string =>
  [
    'import { appendFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'import { it, expect } from "vitest";',
    'it("leaks into the checkout", () => {',
    `  appendFileSync(join(process.env.RALPH_TEST_LOGS_GUARD_ROOT!, ".ralph", "logs", ${JSON.stringify(name)}), "x");`,
    "  expect(1).toBe(1);",
    "});",
    "",
  ].join("\n");

/** The id of the command the operator sends in the cases below. */
const OPERATOR_ID = "aa2363c0-0000-4000-8000-000000000000";

/**
 * A suite during which a SECOND process — the dashboard, in life — delivers
 * `command` into the guarded checkout's inbox the way its writer does: the
 * control directory with its `.gitignore`, then a dotted temp renamed into
 * place. With `alsoLeaks`, the suite itself also writes into `.ralph/logs`.
 */
const operatorWrites = (command: Record<string, unknown>, alsoLeaks?: string): string => {
  const id = OPERATOR_ID;
  const writer = [
    'const { mkdirSync, renameSync, writeFileSync } = require("node:fs");',
    'const { join } = require("node:path");',
    'const control = join(process.argv[1], ".ralph", "control");',
    'const inbox = join(control, "inbox");',
    "mkdirSync(inbox, { recursive: true });",
    'writeFileSync(join(control, ".gitignore"), "*\\n");',
    `const temp = join(inbox, ".${id}.json." + process.pid + ".tmp");`,
    `writeFileSync(temp, ${JSON.stringify(JSON.stringify({ version: 1, id, command: "stop", ...command }))});`,
    `renameSync(temp, join(inbox, "${id}.json"));`,
  ].join("\n");
  return [
    'import { spawnSync } from "node:child_process";',
    'import { appendFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'import { it, expect } from "vitest";',
    'it("runs while the operator sends a command", () => {',
    "  const root = process.env.RALPH_TEST_LOGS_GUARD_ROOT!;",
    `  const writer = spawnSync(process.execPath, ["-e", ${JSON.stringify(writer)}, root], { encoding: "utf8" });`,
    "  expect(writer.status, writer.stderr).toBe(0);",
    ...(alsoLeaks === undefined
      ? []
      : [`  appendFileSync(join(root, ".ralph", "logs", ${JSON.stringify(alsoLeaks)}), "x");`]),
    "});",
    "",
  ].join("\n");
};

/** The identity of the live loop the operator addresses, as the harness exports it. */
const LIVE = { RALPH_RUN_ID: "ralph-run-live", RALPH_LOOP_NAME: "rafa" };

const clean = [
  'import { it, expect } from "vitest";',
  'it("touches nothing", () => expect(1).toBe(1));',
  "",
].join("\n");

describe("the .ralph guard, on a real run", () => {
  it("passes a run that leaves the checkout alone", () => {
    const { dir, guarded } = fixture(clean);
    const child = run(dir, guarded);

    expect(child.status, child.out).toBe(0);
  });

  it("fails the run and names the offending path, even though the suite passed", () => {
    const { dir, guarded } = fixture(writes("notifications.jsonl"));
    const child = run(dir, guarded);

    expect(child.status, child.out).not.toBe(0);
    expect(child.out).toContain("logs/notifications.jsonl");
    expect(child.out).toContain("RALPH_PROJECT");
    // The fixture suite itself is green: the guard is what turns the run red.
    expect(child.out).toContain("1 passed");
  });

  it("notices a file it rewrote, not only one it created", () => {
    const { dir, guarded } = fixture(writes("kept.log"));
    const child = run(dir, guarded);

    expect(child.status, child.out).not.toBe(0);
    expect(child.out).toContain("logs/kept.log");
  });

  it("stays quiet about the files the live supervisor writes under its own run id", () => {
    const { dir, guarded } = fixture(writes("supervisor-ralph-run-live.log"));
    const child = run(dir, guarded, { RALPH_RUN_ID: "ralph-run-live" });

    expect(child.status, child.out).toBe(0);
  });

  it("catches a write to the live loop's notification feed, which the dashboard reads", () => {
    // `notifications.jsonl` is the dashboard's Notifications feed and
    // `push-notifications.json` the push state, so a suite writing there raises
    // a false alert about the real loop (#199). Neither is ever excused.
    for (const name of ["notifications.jsonl", "push-notifications.json"]) {
      const { dir, guarded } = fixture(writes(name));
      const child = run(dir, guarded, { RALPH_RUN_ID: "ralph-run-live", RALPH_SESSION_ID: "live-session" });

      expect(child.status, child.out).not.toBe(0);
      expect(child.out).toContain(`logs/${name}`);
    }
  });

  it("catches a supervisor log that is not the live loop's", () => {
    // A supervisor a fixture started writes `supervisor-<its own run>.log`, and
    // that is the 2,488-line incident the guard has to stay able to see. Only
    // the live run id is excused.
    const { dir, guarded } = fixture(writes("supervisor-ralph-run-fixture.log"));
    const child = run(dir, guarded, { RALPH_RUN_ID: "ralph-run-live" });

    expect(child.status, child.out).not.toBe(0);
    expect(child.out).toContain("logs/supervisor-ralph-run-fixture.log");
  });

  it("catches the supervisor's own file names when no loop is live at all", () => {
    // In CI and in a fresh worktree there is no identity to excuse anything,
    // which is where "a full run leaves `.ralph/` unchanged" is judged.
    const { dir, guarded } = fixture(writes("state.json"));
    const child = run(dir, guarded);

    expect(child.status, child.out).not.toBe(0);
    expect(child.out).toContain("logs/state.json");
  });

  it("still catches a leak while a loop is live", () => {
    const { dir, guarded } = fixture(writes("locks/inspect-mapper-abc.lock"));
    mkdirSync(join(guarded, ".ralph", "logs", "locks"), { recursive: true });
    const child = run(dir, guarded, { RALPH_RUN_ID: "ralph-run-live" });

    expect(child.status, child.out).not.toBe(0);
    expect(child.out).toContain("locks/inspect-mapper-abc.lock");
  });

  describe("while the operator sends the live loop a command", () => {
    // PR #401: 5597 tests passed, then the guard failed the gate on a real
    // `stop` the dashboard wrote for that very run (#481).
    const toLive = { loop: "rafa", run: "ralph-run-live" };

    it("passes the run", () => {
      const { dir, guarded } = fixture(operatorWrites(toLive));
      const child = run(dir, guarded, LIVE);

      expect(child.status, child.out).toBe(0);
      // Still there at teardown, so the guard saw it and excused it.
      expect(existsSync(join(guarded, ".ralph", "control", "inbox", `${OPERATOR_ID}.json`))).toBe(true);
    });

    it("still fails a suite that also writes into .ralph/logs", () => {
      const { dir, guarded } = fixture(operatorWrites(toLive, "notifications.jsonl"));
      const child = run(dir, guarded, LIVE);

      expect(child.status, child.out).not.toBe(0);
      expect(child.out).toContain("logs/notifications.jsonl");
      expect(child.out).not.toContain("control/inbox");
    });

    it("fails the run with no loop identity, so CI still catches a leaked command", () => {
      const { dir, guarded } = fixture(operatorWrites(toLive));
      const child = run(dir, guarded, { RALPH_RUN_ID: "", RALPH_SESSION_ID: "", RALPH_LOOP_NAME: "" });

      expect(child.status, child.out).not.toBe(0);
      expect(child.out).toContain("control/inbox");
    });

    it("fails the run on a command that names another run", () => {
      const { dir, guarded } = fixture(operatorWrites({ loop: "rafa", run: "ralph-run-fixture" }));
      const child = run(dir, guarded, LIVE);

      expect(child.status, child.out).not.toBe(0);
      expect(child.out).toContain("control/inbox/aa2363c0-0000-4000-8000-000000000000.json");
    });
  });
});
