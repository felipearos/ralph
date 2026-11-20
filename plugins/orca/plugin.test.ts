// @vitest-environment node
/**
 * The Orca plugin as the loop reaches it: through the plugin host, never
 * directly. Each case drives the host's CLI — what `ralph.sh` and the stage
 * scripts call — against a fake `orca` that records every invocation, so the
 * assertions are about what actually reaches Orca, and about what never does
 * when the plugin is off.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { writeProjectConfig } from "../../dashboard/fixtures";

import { BINDING_VERBS } from "./binding";
import { ALLOWED_VERBS } from "./lifecycle";
import { CONTROL_VERBS } from "./mailbox";
import { invokeOrca } from "./cli";
import { subprocessSuite } from "../../test-timeouts";

subprocessSuite("runs the Orca plugin through bash and bun");

const REPO_ROOT = join(__dirname, "..", "..");
const BUN = process.env.RALPH_TEST_BUN ?? ((): string => {
  try {
    return execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
  } catch {
    return process.execPath;
  }
})();

const scratch: string[] = [];
afterAll(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `ralph-orca-plugin-${label}-`));
  scratch.push(root);
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  writeProjectConfig(root);
  mkdirSync(join(root, "gitcommon"), { recursive: true });
  const bin = join(root, "bin");
  mkdirSync(bin);
  const callLog = join(root, "orca.calls");
  const orca = join(bin, "orca");
  writeFileSync(
    orca,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(callLog)}`,
      'case "$1 $2" in',
      "  \"orchestration run-current\") printf '{\"ok\":true,\"result\":{}}\\n' ;;",
      "  *) printf '{\"ok\":true,\"result\":{\"run\":{\"id\":\"run_fake\"},\"task\":{\"id\":\"task_fake\"},\"dispatch\":{\"id\":\"ctx_fake\"},\"messages\":[],\"gates\":[]}}\\n' ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(orca, 0o755);
  const git = join(bin, "git");
  writeFileSync(
    git,
    [
      "#!/bin/sh",
      `if [ "$2" = "--path-format=absolute" ]; then printf '%s\\n' ${JSON.stringify(join(root, "gitcommon"))}; exit 0; fi`,
      "if [ \"$1\" = \"symbolic-ref\" ]; then printf '%s\\n' \"ralph/703\"; exit 0; fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(git, 0o755);
  const inherited = { ...process.env };
  delete inherited.RALPH_PLUGINS;
  const env: Record<string, string | undefined> = {
    ...inherited,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    RALPH_STATE_ROOT: root,
    RALPH_ORCA_CLI: orca,
    RALPH_LOOP_NAME: "ralph",
    RALPH_RUN_ID: "ralph-run-1",
    RALPH_SUPERVISOR_PID: String(process.pid),
    ORCA_TERMINAL_HANDLE: "term_loop",
    RALPH_CLAIM_LEASE_PATH: join(root, "gitcommon", "ralph-claim-leases.json"),
  };
  return {
    root,
    calls: (): string[] =>
      existsSync(callLog) ? readFileSync(callLog, "utf8").split("\n").filter((line) => line !== "") : [],
    run: (script: string, args: string[], over: Record<string, string> = {}) =>
      spawnSync(BUN, [join(REPO_ROOT, script), ...args], {
        encoding: "utf8",
        cwd: root,
        env: { ...env, ...over },
        timeout: 60_000,
      }),
    health: () => {
      const path = join(root, ".ralph", "logs", "plugins.json");
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    },
  };
}

describe("with the plugin off, which is the default", () => {
  it("makes no Orca subprocess for an event, a pulse, an alert or a poll", () => {
    const f = fixture("off");
    expect(f.run("plugins.ts", ["event", "--event", "supervisor-start", "--stage", "starting"]).status).toBe(0);
    expect(f.run("plugins.ts", ["pulse"]).status).toBe(0);
    expect(f.run("push-notification.ts", ["record", "--event", "no-sigil", "--iteration", "1"]).status).toBe(0);
    expect(f.run("controls.ts", ["poll", "--supervised"]).status).toBe(0);
    expect(f.calls()).toEqual([]);
    expect(f.health()).toBeNull();
  });

  it("says in the loop's record that an alert reached no plugin", () => {
    const f = fixture("off-notify");
    f.run("push-notification.ts", ["record", "--event", "no-sigil", "--iteration", "1"]);
    const record = JSON.parse(readFileSync(join(f.root, ".ralph", "logs", "push-notifications.json"), "utf8"));
    const [occurrence] = Object.values(record.occurrences) as Record<string, unknown>[];
    expect(occurrence).toMatchObject({ kind: "no-sigil", plugins: [], unoffered: "no notify plugin is enabled" });
  });
});

describe("with the plugin on", () => {
  const on = { RALPH_PLUGINS: "orca" };

  it("mirrors a recorded event onto the board, as a Run with a status", () => {
    const f = fixture("event");
    expect(f.run("plugins.ts", ["event", "--event", "supervisor-start", "--stage", "starting"], on).status).toBe(0);
    const calls = f.calls().join("\n");
    expect(calls).toContain("orchestration run-create");
    expect(calls).toContain("orchestration send --run run_fake --type status");
    expect(f.health().plugins.orca.degraded).toBeNull();
    expect(JSON.parse(readFileSync(join(f.root, ".ralph", "logs", "orca-lifecycle.json"), "utf8"))).toMatchObject({
      ralphRun: "ralph-run-1",
      orcaRun: "run_fake",
    });
  });

  it("sends a heartbeat on a pulse once an attempt is dispatched", () => {
    const f = fixture("pulse");
    const lease = {
      version: 1,
      leases: {
        "703": {
          issue: 703,
          run: "ralph-run-1",
          loop: "ralph",
          owner: "ralph@test",
          pid: 1,
          host: "test",
          worktree: f.root,
          branch: "ralph/703",
          claimedAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      },
    };
    writeFileSync(join(f.root, "gitcommon", "ralph-claim-leases.json"), JSON.stringify(lease));
    f.run("plugins.ts", ["event", "--event", "supervisor-start"], on);
    f.run("plugins.ts", ["event", "--event", "iteration-start", "--stage", "iteration", "--iteration", "1"], {
      ...on,
      RALPH_SESSION_ID: "s1",
    });
    expect(f.calls().join("\n")).toContain("orchestration dispatch --run run_fake --task task_fake");
    const before = f.calls().length;
    f.run("plugins.ts", ["pulse"], on);
    const beat = f.calls().slice(before).join("\n");
    expect(beat).toContain("--type heartbeat");
    expect(beat).toContain('"dispatchId":"ctx_fake"');
  });

  it("sends an alert to the Run through notify, and records that it did", () => {
    const f = fixture("notify");
    f.run("plugins.ts", ["event", "--event", "supervisor-start"], on);
    const before = f.calls().length;
    f.run("push-notification.ts", ["record", "--event", "no-sigil", "--iteration", "1", "--why", "no sigil"], on);
    const sent = f.calls().slice(before).join("\n");
    expect(sent).toContain("orchestration send --run run_fake --type no-sigil");
    expect(sent).toContain("--priority high");
    const record = JSON.parse(readFileSync(join(f.root, ".ralph", "logs", "push-notifications.json"), "utf8"));
    expect(Object.values(record.occurrences)).toContainEqual(
      expect.objectContaining({ kind: "no-sigil", plugins: ["orca"], unoffered: null }),
    );
  });

  it("records Orca being away as the plugin's health, and leaves the loop's exit alone", () => {
    const f = fixture("away");
    const ran = f.run("plugins.ts", ["event", "--event", "supervisor-start"], {
      ...on,
      RALPH_ORCA_CLI: join(f.root, "no-such-orca"),
    });
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe("");
    expect(f.health().plugins.orca.degraded).toMatchObject({ hook: "on-event" });
    expect(f.health().plugins.orca.degraded.why).toContain("no Orca CLI");
  });

  it("shows its own panel lines under the host's", () => {
    const f = fixture("status");
    f.run("plugins.ts", ["event", "--event", "supervisor-start"], on);
    const shown = f.run("plugins.ts", ["status", "--line"], on).stdout.split("\n");
    expect(shown[0]).toBe("Plugins: orca ok");
    expect(shown[1]).toMatch(/^ {2}Orca lifecycle: run run_fake/);
    expect(shown[2]).toMatch(/^ {2}Orca controls: listening/);
  });
});

describe("what the plugin may ask of Orca", () => {
  it("never places a process: every roster refuses worker-start, dispatch --inject and terminal send", () => {
    for (const [who, roster] of [
      ["lifecycle", ALLOWED_VERBS],
      ["mailbox", CONTROL_VERBS],
      ["binding", BINDING_VERBS],
    ] as const) {
      for (const verb of roster) expect(verb, who).not.toMatch(/worker-start|terminal send/);
      expect(() => invokeOrca("orchestration worker-start", [], roster, who)).toThrow(/may not run/);
      expect(() => invokeOrca("terminal send", [], roster, who)).toThrow(/may not run/);
      expect(() => invokeOrca(roster[0], ["--inject"], roster, who)).toThrow(/may not pass/);
    }
  });
});
