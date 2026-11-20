// @vitest-environment node
/**
 * The migration watchdog (#434) against the REAL `push-notification.ts`: the
 * two acceptance criteria `reconcile.test.ts` cannot prove with a faked push.
 *
 * Only `gh` is answered with canned stdout — no network, and no `--ticket` is
 * passed, so GitHub is never commented on. The push runs under `bun` in a
 * scratch root with its own HOME, plugins directory and project config.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { Executor } from "./control-adapter";
import { createReconcileAdapter, RECONCILE_SURFACE, watchMigrations } from "./reconcile";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("bun push-notification.ts");

const HARNESS = join(import.meta.dirname, "..");
const KIND = RECONCILE_SURFACE.push.kinds.migrationStalled;
const APPLIED_AT = "2026-10-22T06:00:00Z";
/** Three hours after the apply: well past the one-hour threshold. */
const NOW = Date.parse("2026-10-22T09:00:00Z");

const scratch: string[] = [];
afterAll(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A root worktree whose project enables the `board` plugin, installed beside it. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ralph-migration-watchdog-"));
  scratch.push(dir);
  const root = join(dir, "root");
  const plugins = join(dir, "plugins");
  const home = join(dir, "home");
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  mkdirSync(join(plugins, "board"), { recursive: true });
  mkdirSync(home);
  writeFileSync(
    join(root, ".ralph", "config.json"),
    JSON.stringify({
      repo: "o/r",
      owner: "o",
      baseBranch: "main",
      displayName: "P",
      secrets: { runner: "none", withhold: [] },
      refuseFiles: [],
      envCheck: [],
      requiredChecks: [],
      gates: {},
      promptFragment: ".ralph/prompt.md",
      coderFragment: ".ralph/coder.md",
      plan: ".ralph/plan.md",
      journal: { dir: "journal" },
      loops: ["ralph"],
      plugins: ["board"],
    }),
  );
  // Records each notify it is offered, so the test sees how many pages left.
  writeFileSync(
    join(plugins, "board", "plugin.ts"),
    [
      'import { appendFileSync, readFileSync } from "node:fs";',
      'const input = readFileSync(0, "utf8");',
      'appendFileSync(process.env.RALPH_STATE_ROOT + "/board.seen", process.argv[2] + " " + input.replace(/\\n/g, " ") + "\\n");',
      'console.log(\'{"ok":true}\');',
    ].join("\n"),
  );

  const ghCalls: string[][] = [];
  // `gh` answered from canned stdout; the push really runs. `RALPH_PLUGINS`
  // is dropped so the project's own config decides, as on the live host.
  const exec: Executor = async (invocation) => {
    if (invocation.command === RECONCILE_SURFACE.gh.command) {
      ghCalls.push(invocation.args);
      const stdout =
        invocation.args[0] === "pr"
          ? JSON.stringify([{ number: 2760, title: "fix: carry the hand-applied migration", url: "https://example.test/pr/2760" }])
          : `${APPLIED_AT}\n`;
      return { status: 0, stdout, stderr: "" };
    }
    const env = { ...invocation.env };
    delete env.RALPH_PLUGINS;
    // A loop's own environment may switch pushes off or name another project;
    // neither may decide what this test sees.
    env.RALPH_PUSH_NOTIFICATIONS = "1";
    delete env.RALPH_PROJECT;
    const ran = spawnSync(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env,
      encoding: "utf8",
      timeout: 20_000,
    });
    return { status: ran.status, stdout: ran.stdout ?? "", stderr: ran.stderr ?? (ran.error?.message ?? "") };
  };
  const adapter = createReconcileAdapter({
    cliDir: HARNESS,
    bunPath: "bun",
    env: { HOME: home, RALPH_PLUGINS_DIR: plugins },
    exec,
  });

  const pass = () =>
    watchMigrations({
      projects: [{ project: "loggd", root: { loop: "ralph", worktree: root } }],
      adapter,
      alertSeconds: 3600,
      now: () => NOW,
      // A fresh set per pass: what a restarted dashboard starts with.
      pushed: new Set<string>(),
    });
  const feed = (): Record<string, unknown>[] => {
    const path = join(root, ".ralph", "logs", "notifications.jsonl");
    return existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
  };
  const seen = (): string[] => {
    const path = join(root, "board.seen");
    return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
  };
  return { pass, feed, seen, ghCalls };
}

describe("the migration watchdog over the real push-notification", () => {
  const h = fixture();
  let raised: Record<string, unknown>[] = [];

  it("is not repeated after a restart: two passes, two fresh processes' state, one raised line", async () => {
    const first = await h.pass();
    expect(first.alerted).toEqual([{ project: "loggd", pr: 2760 }]);
    const second = await h.pass();
    expect(second.alerted).toEqual([{ project: "loggd", pr: 2760 }]);
    // Both passes really read gh and really ran the push: the dedupe that
    // held is push-notification's own record at the root, not this process.
    expect(h.ghCalls.filter((args) => args[0] === "pr")).toHaveLength(2);
    raised = h.feed().filter((line) => line.event === "raised" && line.kind === KIND);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ run: RECONCILE_SURFACE.watchdog.run, loop: "ralph", priority: "high" });
    expect(String(raised[0]!.subject)).toContain("PR #2760");
  });

  it("goes out through the project's enabled plugins", () => {
    expect(raised[0]!.plugins).toEqual(["board"]);
    const notifies = h.seen().filter((line) => line.startsWith("notify "));
    expect(notifies).toHaveLength(1);
    expect(notifies[0]).toContain(KIND);
  });
});
