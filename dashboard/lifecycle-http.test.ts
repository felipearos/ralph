// @vitest-environment node
/**
 * Start and restart-to-apply over HTTP, against the actual Bun server on an
 * ephemeral loopback port.
 *
 * Nothing between `fetch` and the process table is faked except the ends: the
 * server runs the real lifecycle and control adapters, a copy of the real
 * `start.sh` and `project.sh` (named through `RALPH_DASHBOARD_START`), the
 * real `controls.ts` and the real `loop-state.ts`. As in
 * `lifecycle-channel.test.ts`, `nohup` and `ralph.sh` are fakes — the fake
 * supervisor runs the real `controls.ts poll --supervised` between
 * "iterations" and exits on a stop it reads from its inbox. So the endpoint's
 * answers are asserted against what really happened in the worktree.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { bunPath, cleanupFixtures, createFixture, realGitPath, writeLoopState } from "./fixtures";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("starts the dashboard and loops as bun processes");

const REPO_ROOT = join(__dirname, "..");
const SERVER = join(REPO_ROOT, "dashboard", "server.ts");
const BUN = bunPath();

const children: ChildProcess[] = [];
const eventLogs: string[] = [];
afterAll(() => {
  children.forEach((child) => child.kill("SIGKILL"));
  // Test cleanup only: the fake supervisors are this suite's own children.
  for (const log of eventLogs) {
    if (!existsSync(log)) continue;
    for (const line of readFileSync(log, "utf8").split("\n")) {
      const pid = Number(/^start run-(\d+)/.exec(line)?.[1]);
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
    }
  }
  cleanupFixtures();
});

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function startServer(env: Record<string, string | undefined>): Promise<{ base: string; stop: () => void }> {
  return new Promise((resolve, reject) => {
    const child = spawn(BUN, [SERVER], {
      cwd: REPO_ROOT,
      // The loop reconciler is off for this suite's servers: its startup pass
      // would read the fixture worktrees as dead loops and start them.
      env: { ...process.env, RALPH_DASHBOARD_RECONCILE_MS: "0", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server did not start within 20s:\n${output}`));
    }, 20_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /listening on (http:\/\/\S+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve({ base: match[1]!, stop: () => child.kill("SIGKILL") });
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}:\n${output}`));
    });
  });
}

const script = (path: string, lines: string[]): void => {
  writeFileSync(path, [...lines, ""].join("\n"));
  chmodSync(path, 0o755);
};

/**
 * One loop checkout, a scratch harness holding the starter and fake supervisor,
 * and a server over them.
 *
 * `lingerSeconds` keeps the first supervisor alive that long after it confirms
 * a stop, so restart's wait outlasts Bun's default 10s idle timeout.
 */
function lifecycleFixture(label: string, { lingerSeconds = 0 }: { lingerSeconds?: number } = {}) {
  const f = createFixture(label);
  const ralph = f.worktree("wt-ralph");
  // A record from an earlier run attributes the checkout to `ralph`; no
  // supervisor is running for it yet.
  writeLoopState(ralph, { loop: "ralph", run: "run-old" });
  f.registry([ralph]);
  const home = join(f.root, "harness");
  mkdirSync(home);
  for (const file of ["start.sh", "project.sh"]) cpSync(join(REPO_ROOT, file), join(home, file));
  chmodSync(join(home, "start.sh"), 0o755);

  const events = join(f.root, "events.log");
  writeFileSync(events, "");
  eventLogs.push(events);
  const gitLog = join(f.root, "git.calls");
  const lingered = join(f.root, "lingered");

  script(join(f.bin, "nohup"), ["#!/usr/bin/env bash", 'exec "$@"']);

  // The fixture's registry-and-journal git, plus what a checkout report reads:
  // recovery work in `status`, and no common dir, so the lease store is the
  // worktree-local fallback. Every call is logged to prove none repaired.
  script(join(f.bin, "git"), [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${JSON.stringify(gitLog)}`,
    `if [ "$1" = "-C" ]; then case "$3" in ls-tree|cat-file) exec ${JSON.stringify(realGitPath())} "$@";; esac; fi`,
    'if [ "$1 $2" = "worktree list" ]; then',
    `  while IFS= read -r line; do printf '%s\\n' "$line"; done < ${JSON.stringify(join(f.root, "registry.txt"))}`,
    "  exit 0",
    "fi",
    'if [ "$1" = "symbolic-ref" ]; then printf \'%s\\n\' "ralph/16-restart"; exit 0; fi',
    'if [ "$1" = "status" ]; then printf \'%s\\n\' "?? recovery-notes.md"; exit 0; fi',
    "exit 0",
  ]);


  script(join(home, "ralph.sh"), [
    "#!/usr/bin/env bash",
    'run="run-$$"',
    'now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"',
    `printf '{"version":1,"run":"%s","owner":{"loop":"ralph","pid":%s,"host":"test"},"worktree":"%s","branch":"ralph/16-restart","stage":"iteration","iteration":{"index":1,"max":50},"heartbeat":"%s","lastEvent":null,"stopReason":null}' "$run" "$$" "$PWD" "$now" > .ralph/logs/state.json`,
    `printf 'start %s\\n' "$run" >> ${JSON.stringify(events)}`,
    "for _ in $(seq 1 600); do",
    `  RALPH_RUN_ID="$run" RALPH_LOOP_NAME=ralph ${JSON.stringify(BUN)} ${JSON.stringify(join(REPO_ROOT, "controls.ts"))} poll --supervised >/dev/null 2>&1`,
    '  if [ "$?" -eq 20 ]; then',
    `    if [ ${lingerSeconds} -gt 0 ] && [ ! -e ${JSON.stringify(lingered)} ]; then : > ${JSON.stringify(lingered)}; sleep ${lingerSeconds}; fi`,
    `    printf 'exit %s\\n' "$run" >> ${JSON.stringify(events)}`,
    "    exit 0",
    "  fi",
    "  sleep 0.1",
    "done",
  ]);

  const serve = () =>
    startServer({
      RALPH_DASHBOARD_PORT: "0",
      RALPH_DASHBOARD_ROOTS: f.root,
      RALPH_DASHBOARD_START: join(home, "start.sh"),
      PATH: `${f.bin}:${process.env.PATH ?? ""}`,
    });

  const readEvents = (): string[] => readFileSync(events, "utf8").split("\n").filter((line) => line !== "");
  const waitForStarts = async (count: number): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (readEvents().filter((line) => line.startsWith("start ")).length >= count) return;
      await sleep(50);
    }
    throw new Error(`expected ${count} supervisor start(s); saw ${readEvents().join(", ")}`);
  };
  const gitCalls = (): string[] =>
    existsSync(gitLog) ? readFileSync(gitLog, "utf8").split("\n").filter(Boolean) : [];

  return { f, ralph, serve, readEvents, waitForStarts, gitCalls };
}

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("start and restart-to-apply over HTTP", () => {
  it("starts once, answers a second start as already running, and restarts only after a confirmed stop", async () => {
    const loop = lifecycleFixture("http-lifecycle", { lingerSeconds: 12 });
    const recovery = join(loop.ralph, "recovery-notes.md");
    writeFileSync(recovery, "half-finished ticket\n");
    writeFileSync(
      join(loop.ralph, ".ralph-claim-leases.json"),
      JSON.stringify({
        version: 1,
        leases: { "16": { issue: 16, run: "run-old", loop: "ralph", worktree: loop.ralph, branch: "ralph/16-restart" } },
      }),
    );
    const leases = readFileSync(join(loop.ralph, ".ralph-claim-leases.json"), "utf8");
    const server = await loop.serve();
    try {
      expect(new URL(server.base).hostname).toBe("127.0.0.1");

      // The panel's warning: what a restart would leave in place.
      const checkout = await fetch(`${server.base}/api/loops/ralph/checkout`);
      expect(checkout.status).toBe(200);
      expect(await checkout.json()).toMatchObject({
        loop: "ralph",
        checkout: { dirty: true, changes: ["?? recovery-notes.md"], midTicket: true, claims: [{ issue: 16 }] },
      });

      const first = await post(server.base, "/api/start", { loop: "ralph" });
      expect(first.status).toBe(200);
      const started = (await first.json()) as { outcome: string; pid: number; why: string };
      expect(started.outcome, started.why).toBe("started");
      expect(started.pid).toBeGreaterThan(0);
      await loop.waitForStarts(1);

      const second = (await (await post(server.base, "/api/start", { loop: "ralph" })).json()) as {
        outcome: string;
        why: string;
      };
      expect(second.outcome, second.why).toBe("already-running");
      expect(second.why).toContain("already running");
      expect(loop.readEvents()).toHaveLength(1);

      // Restart without the confirmation field is refused before anything runs.
      const unconfirmed = await post(server.base, "/api/restart", { loop: "ralph" });
      expect(unconfirmed.status).toBe(400);
      expect(await unconfirmed.json()).toMatchObject({ error: "ConfirmationRequired" });
      expect(loop.readEvents()).toHaveLength(1);

      // The old supervisor confirms, then lingers past Bun's default idle
      // timeout before exiting; the request must survive that wait.
      const restart = await post(server.base, "/api/restart", { loop: "ralph", confirm: true, id: "restart-1" });
      expect(restart.status).toBe(200);
      const result = (await restart.json()) as {
        outcome: string;
        halt: string | null;
        why: string;
        confirmation: string;
        start: { outcome: string; pid: number };
        stop: { outcome: string; stop: { kind: string } };
        checkout: { dirty: boolean; midTicket: boolean };
      };
      expect(result.outcome, `${result.halt ?? ""} ${result.why}`).toBe("started");
      expect(result.confirmation).toBe("confirmed");
      expect(result.start).toMatchObject({ outcome: "started" });
      expect(result.stop).toMatchObject({ outcome: "applied", stop: { kind: "blocked" } });
      expect(result.checkout).toMatchObject({ dirty: true, midTicket: true });

      await loop.waitForStarts(2);
      const [firstStart, firstExit, secondStart] = loop.readEvents();
      expect(firstExit).toBe(firstStart!.replace("start", "exit"));
      expect(secondStart).toMatch(/^start run-\d+$/);
      expect(secondStart).not.toBe(firstStart);

      // Commits, claims and uncommitted recovery work stay where they were.
      expect(readFileSync(recovery, "utf8")).toBe("half-finished ticket\n");
      expect(readFileSync(join(loop.ralph, ".ralph-claim-leases.json"), "utf8")).toBe(leases);
      for (const call of loop.gitCalls()) {
        expect(call).not.toMatch(/^(reset|checkout|clean|stash|restore|switch|commit|worktree remove|worktree prune)\b/);
      }
    } finally {
      server.stop();
    }
  }, 90_000);

  it("refuses to start while an old stop is unconfirmed and no supervisor is running", async () => {
    const loop = lifecycleFixture("http-lifecycle-unconfirmed");
    writeFileSync(
      join(loop.ralph, ".ralph", "logs", "controls.json"),
      JSON.stringify({
        version: 1,
        ralphRun: "run-gone",
        loop: "ralph",
        ownerChangedAt: null,
        applied: [{ key: "old", command: "stop", at: "T", outcome: "applied", why: "stopping" }],
        hold: null,
        stop: { kind: "blocked", why: "nobody home", at: "T", key: "old", confirmation: "unreachable" },
        retries: [],
        abandoned: [],
        released: [],
        deferrals: [],
        degraded: null,
        lastPolledAt: null,
      }),
    );
    const server = await loop.serve();
    try {
      const response = await post(server.base, "/api/restart", { loop: "ralph", confirm: true });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        outcome: "halted",
        halt: "stop-unreachable",
        confirmation: "unreachable",
        start: null,
      });
      expect(loop.readEvents()).toHaveLength(0);
    } finally {
      server.stop();
    }
  }, 60_000);
});
