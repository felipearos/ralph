// @vitest-environment node
/**
 * The loop reconciler: what it restarts, what it leaves alone, and the bound.
 *
 * Every read and every write here goes through the modules that own them — the
 * real lifecycle adapter builds the `loop-state` and `start.sh` invocations,
 * the real `agents.ts` gate decides whether a start may happen, and the real
 * records adapter reads the feed the bound is counted from. Only the processes
 * are faked, by an injected executor that answers each invocation and, for a
 * push, APPENDS the feed line the real `push-notification.ts` would, so a
 * later pass counts attempts out of a file rather than out of this suite's
 * memory.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createAgentsAdapter } from "./agents-adapter";
import type { AgentsDeps } from "./agents";
import type { Liveness, StopKind } from "./contracts";
import { createRalphControlAdapter, type ExecResult, type Executor, type Invocation } from "./control-adapter";
import { createRalphLifecycleAdapter } from "./lifecycle-adapter";
import { classifyLoop } from "../loop-state";
import type { LifecycleDeps } from "./lifecycle";
import { createRecordsAdapter } from "./records-adapter";
import { notificationFeed, type RawFile } from "./records";
import { createRecordingExecutor } from "./recording-executor";
import {
  createReconcileAdapter,
  decide,
  DEFAULT_ATTEMPTS,
  DEFAULT_MIGRATION_ALERT_SECONDS,
  DEFAULT_RECONCILE_MS,
  DEFAULT_RETRY_SCHEDULE_MINUTES,
  readBootTimeMs,
  reconcile,
  reconcileConfigFromEnv,
  RESTART_OUTCOMES,
  retryView,
  targetsFrom,
  RECONCILE_ENV,
  RECONCILE_SURFACE,
  schedule,
  watchMigrations,
  watchProjectsFrom,
  watchRoot,
  WINDOW_MS,
  type MigrationWatchDeps,
  type PushInput,
  type ReconcileDeps,
  type ReconcileTarget,
  type RetrySeen,
  type Said,
  type Seen,
} from "./reconcile";

const HARNESS = "/harness";
const scratchRoots: string[] = [];
afterAll(() => scratchRoots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** What the fake `loop-state status --json` says about one worktree. */
interface Script {
  liveness: Liveness;
  /** Null: mid-iteration. Undefined: no durable record at all. */
  stop?: { kind: StopKind; why: string; signal?: string; self?: boolean } | null;
  heartbeat?: string;
  recorded?: boolean;
  /** The start gate's answer: `false` makes `project-config` omit the loop from `loops`. */
  rostered?: boolean;
  /** `start.sh`'s answer. */
  start?: ExecResult;
  /** A stop on the control record, as `controls status --json` holds it. */
  stop_record?: { kind: StopKind; confirmation: "confirmed" | "pending" | "unreachable" } | null;
  /** Make `push-notification.ts` fail, so no attempt record is written. */
  pushFails?: boolean;
  /** The event that wrote the stop, which `decide()` reads a retry off. */
  lastEvent?: { name: string; detail?: string };
  lastIterationEndAt?: string;
  /** The stop's `at`; defaults to 2026-10-20T11:00:00.000Z. */
  stopAt?: string;
}

interface Harness {
  deps: ReconcileDeps;
  target: ReconcileTarget;
  worktree: string;
  script: Script;
  calls: Invocation[];
  feed: () => ReturnType<typeof notificationFeed>["notifications"];
  /** Append a `loop-restarted` record as a past attempt, as the real push would. */
  pastAttempt: (at: string, kind?: string) => void;
  nowMs: () => number;
  advance: (ms: number) => void;
}

const STARTED = (pid: number): ExecResult => ({
  status: 0,
  stdout: `Started Ralph supervisor (pid ${String(pid)}); waits 300s, runs up to 50 iterations.\n`,
  stderr: "",
});

const FEED = ".ralph/logs/notifications.jsonl";

/** The host's boot time every harness reports: after the default stop at 11:00. */
const BOOT_MS = Date.parse("2026-10-20T11:30:00.000Z");

function harness(label: string, over: Script = { liveness: "dead", stop: null }): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `ralph-reconcile-${label}-`)));
  scratchRoots.push(root);
  const worktree = join(root, "loop");
  mkdirSync(join(worktree, ".ralph", "logs"), { recursive: true });
  const script: Script = { recorded: true, rostered: true, start: STARTED(5151), ...over };
  let clock = Date.parse("2026-10-20T12:00:00.000Z");
  const startScript = join(HARNESS, "start.sh");

  const stateJson = (): string =>
    JSON.stringify({
      self: worktree,
      loops: [
        {
          worktree,
          worktreeStatus: "live",
          loopStatus: script.liveness === "alive" ? "running" : "stale",
          branch: "ralph/346-reconcile",
          state:
            script.recorded === false
              ? null
              : {
                  version: 1,
                  run: "ralph-run-dead",
                  owner: { loop: "ralph", pid: 4242, host: "test" },
                  worktree,
                  branch: "ralph/346-reconcile",
                  stage: "iteration",
                  iteration: { index: 3, max: 50 },
                  heartbeat: script.heartbeat ?? new Date(clock).toISOString(),
                  lastEvent: script.lastEvent === undefined ? null : { ...script.lastEvent, at: "2026-10-20T11:00:00.000Z" },
                  stopReason:
                    script.stop === null || script.stop === undefined
                      ? null
                      : { ...script.stop, at: script.stopAt ?? "2026-10-20T11:00:00.000Z" },
                  ...(script.lastIterationEndAt === undefined ? {} : { lastIterationEndAt: script.lastIterationEndAt }),
                },
          stateProblem: script.recorded === false ? "missing" : null,
          supervisor: script.liveness,
        },
      ],
      reconciliation: { orphaned: [], prunable: [] },
    });

  const projectConfig = (): ExecResult => ({
    status: 0,
    stdout: JSON.stringify({
      repo: "felipearos/ralph",
      baseBranch: "main",
      loops: script.rostered === false ? ["rafa"] : ["ralph"],
    }),
    stderr: "",
  });

  // One answer for every invocation, through the shared recorder so the
  // suite inspects its calls the way the others do.
  const answer = (invocation: Invocation): ExecResult => {
    const script0 = invocation.args[0] ?? "";
    if (invocation.command === startScript) return script.start!;
    if (script0.endsWith("loop-state.ts")) return { status: 0, stdout: stateJson(), stderr: "" };
    if (script0.endsWith("project-config.ts")) return projectConfig();
    if (script0.endsWith("controls.ts")) {
      const stopped = script.stop_record ?? null;
      return {
        status: 0,
        stdout: JSON.stringify({
          version: 1,
          ralphRun: "ralph-run-dead",
          loop: "ralph",
          hold: null,
          gates: [],
          stop:
            stopped === null
              ? null
              : {
                  key: "k",
                  kind: stopped.kind,
                  run: "ralph-run-dead",
                  why: "stop now",
                  at: "2026-10-20T11:00:00.000Z",
                  confirmation: stopped.confirmation,
                  issue: null,
                },
          applied: [],
          deferrals: [],
        }),
        stderr: "",
      };
    }
    if (script0.endsWith("push-notification.ts")) {
      if (script.pushFails === true) return { status: 1, stdout: "", stderr: "no room on device\n" };
      // Exactly what `push()` appends: the `raised` line of the feed, under
      // the `<run>:<occurrence>` id it dedupes on.
      const flag = (name: string): string => invocation.args[invocation.args.indexOf(`--${name}`) + 1] ?? "";
      const run = invocation.env[RECONCILE_SURFACE.push.env.run] ?? "adhoc";
      // `--retry-*` put `retry` on the raised line, as `push()` writes it.
      const retry = invocation.args.includes("--retry-attempt")
        ? { retry: { attempt: Number(flag("retry-attempt")), of: Number(flag("retry-of")), cause: flag("retry-cause") } }
        : {};
      appendFileSync(
        join(invocation.cwd ?? worktree, FEED),
        `${JSON.stringify({
          version: 1,
          event: "raised",
          id: `${run}:${flag("occurrence")}`,
          at: new Date(clock).toISOString(),
          run,
          loop: invocation.env[RECONCILE_SURFACE.push.env.loop] ?? null,
          kind: flag("kind"),
          subject: flag("subject"),
          body: flag("body"),
          priority: flag("priority"),
          ticket: null,
          iteration: null,
          plugins: [],
          github: "absent",
          ...retry,
        })}\n`,
      );
      return { status: 0, stdout: "", stderr: "" };
    }
    if (invocation.command === "git") return { status: 0, stdout: "", stderr: "" };
    return { status: 127, stdout: "", stderr: `unexpected invocation: ${invocation.command}` };
  };
  const recorder = createRecordingExecutor({ fallback: answer });
  const exec = recorder.exec;

  const lifecycle: LifecycleDeps = {
    control: createRalphControlAdapter({ cliDir: HARNESS, root: worktree, bunPath: "bun", env: {}, exec }),
    lifecycle: createRalphLifecycleAdapter({ cliDir: HARNESS, root: worktree, bunPath: "bun", env: {}, startScript, exec }),
    loop: "ralph",
  };
  const agents: AgentsDeps = {
    agents: createAgentsAdapter({ cliDir: HARNESS, root, project: "software-factory", bunPath: "bun", exec }),
  };
  const target: ReconcileTarget = { project: "software-factory", loop: "ralph", worktree, lifecycle, agents };

  return {
    worktree,
    script,
    get calls() {
      return recorder.calls.map((call) => call.invocation);
    },
    target,
    nowMs: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    feed: () => notificationFeed("ralph", createRecordsAdapter({ root: worktree }).readFeed()).notifications,
    pastAttempt: (at, kind = RECONCILE_SURFACE.push.kinds.restarted) =>
      appendFileSync(
        join(worktree, FEED),
        `${JSON.stringify({
          version: 1,
          event: "raised",
          id: `ralph-run-dead:${kind}:software-factory:ralph:${at}`,
          at,
          run: "ralph-run-dead",
          loop: "ralph",
          kind,
          subject: "an earlier attempt",
          body: "",
          priority: "normal",
          plugins: [],
          github: "absent",
        })}\n`,
      ),
    deps: {
      targets: () => [target],
      records: (path) => createRecordsAdapter({ root: path }),
      adapter: createReconcileAdapter({ cliDir: HARNESS, bunPath: "bun", env: {}, exec }),
      now: () => new Date(clock),
      // Fixed, after the default stop at 11:00, so no test reads the real
      // host's `/proc/stat` and a legacy stop reads as one after the boot.
      bootTime: () => BOOT_MS,
    },
  };
}

/** The restart attempts recorded in the loop's own feed, oldest first. */
const restarts = (h: Harness): { at: string; body: string; subject: string }[] =>
  h
    .feed()
    .filter((entry) => entry.kind === RECONCILE_SURFACE.push.kinds.restarted)
    .map((entry) => ({ at: entry.at, body: entry.body, subject: entry.subject }))
    .reverse();

const startCalls = (h: Harness): Invocation[] => h.calls.filter((call) => call.command.endsWith("start.sh"));

/** How far a pass is from the one before it in these cases: one interval. */
const GAP_MS = 60_000;

describe("what is restarted, and what is left alone", () => {
  it("restarts a dead supervisor whose loop chose no ending", async () => {
    const h = harness("dead");
    const pass = await reconcile(h.deps);
    expect(pass.attempts).toHaveLength(1);
    expect(pass.attempts[0]).toMatchObject({ outcome: "restarted", pid: 5151, run: "ralph-run-dead", loop: "ralph" });
    expect(pass.skipped).toEqual([]);
    expect(startCalls(h)).toHaveLength(1);
  });

  it("leaves every ending the loop chose stopped", async () => {
    // These four are decisions, not deaths. A reconciler that restarted them
    // would undo a loop that halted for a human, over and over. With no
    // `lastEvent` none of them is a transient fault either, so none is retried.
    for (const kind of ["completed", "blocked", "failed", "interrupted"] as StopKind[]) {
      const h = harness(`ending-${kind}`, { liveness: "dead", stop: { kind, why: "its own ending" } });
      const pass = await reconcile(h.deps);
      expect(pass.attempts, kind).toEqual([]);
      expect(pass.skipped[0]?.why, kind).toContain(kind);
      expect(startCalls(h), kind).toEqual([]);
      const report = {
        liveness: "dead" as const,
        stopReason: { kind, why: "its own ending", at: "2026-10-20T11:00:00.000Z" },
        run: "r",
        loop: "ralph",
        pid: 77,
        recorded: true,
        why: "supervisor dead",
      };
      expect(decide(report), kind).not.toHaveProperty("retry");
    }
  });

  it("never restarts over a live supervisor, nor over one it could not see", async () => {
    const alive = harness("alive", { liveness: "alive", stop: null });
    expect((await reconcile(alive.deps)).attempts).toEqual([]);
    expect(startCalls(alive)).toEqual([]);

    // `unknown` is "could not tell", whatever the heartbeat says: the read
    // failed, so the process table said nothing about this supervisor at all.
    // The case below ties the same fixture to the real `classifyLoop`.
    const stale = harness("stale", {
      liveness: "unknown",
      stop: null,
      heartbeat: new Date(Date.parse("2026-10-20T12:00:00.000Z") - 6 * 3_600_000).toISOString(),
    });
    const pass = await reconcile(stale.deps);
    expect(pass.attempts).toEqual([]);
    expect(pass.skipped[0]?.why).toContain("unknown");
    expect(startCalls(stale)).toEqual([]);
  });

  it("leaves the stale a real classifyLoop would report, because it reads liveness and not the word", async () => {
    // The fixture's own heartbeat and the real classifier, so "stale is not a
    // death" is asserted against `loop-state.ts` rather than against a status
    // word this suite hand-wrote.
    const heartbeat = Date.parse("2026-10-20T12:00:00.000Z") - 6 * 3_600_000;
    expect(
      classifyLoop({
        state: {
          version: 1,
          run: "ralph-run-dead",
          owner: { loop: "ralph", pid: 4242, host: "test" },
          worktree: "/w/loop",
          branch: null,
          stage: "iteration",
          iteration: null,
          heartbeat: new Date(heartbeat).toISOString(),
          lastEvent: null,
          stopReason: null,
        },
        worktreeExists: true,
        supervisor: "unknown",
        // `loop-state.ts` keeps its own defaults private; the hour is the one
        // this case is about, and six hours is past it either way.
      }, { nowMs: Date.parse("2026-10-20T12:00:00.000Z"), loopStaleAfterMs: 3_600_000, worktreeStaleAfterMs: 7 * 24 * 3_600_000 }),
    ).toBe("stale");
    // And the reconciler declines it, on the liveness alone.
    const h = harness("stale-classifier", {
      liveness: "unknown",
      stop: null,
      heartbeat: new Date(heartbeat).toISOString(),
    });
    expect((await reconcile(h.deps)).attempts).toEqual([]);
  });

  it("reports start.sh's own worktree lock as an attempt that started nothing", async () => {
    // Two dashboards, or a Start pressed in the same second: `start.sh` is
    // idempotent and says so, and that is an attempt like any other.
    const h = harness("already-running", {
      liveness: "dead",
      stop: null,
      start: { status: 0, stdout: "Ralph supervisor already running (pid 7272).\n", stderr: "" },
    });
    const pass = await reconcile(h.deps);
    expect(pass.attempts[0]).toMatchObject({ outcome: "already-running", pid: 7272 });
    expect(restarts(h)[0]?.body).toContain("outcome: already-running");
  });

  it("writes one of the four declared outcomes and nothing else", () => {
    expect(RESTART_OUTCOMES).toEqual(["restarted", "already-running", "refused", "failed"]);
  });

  it("does not start a worktree that has no durable record at all", async () => {
    // `stopReason: null` and "no record" read the same off the state alone.
    // Only the first was ever started here; starting the second would launch
    // a loop nothing has run.
    const h = harness("no-record", { liveness: "dead", recorded: false });
    expect((await reconcile(h.deps)).attempts).toEqual([]);
    expect(startCalls(h)).toEqual([]);
  });

  it("decides off the reading alone, with no process at all", () => {
    const report = { liveness: "dead" as Liveness, stopReason: null, run: "r", loop: "ralph", pid: 77, recorded: true, why: "supervisor dead" };
    expect(decide(report)).toEqual({ restart: true, reason: "supervisor 77 gone, no stopReason" });
    expect(decide({ ...report, pid: null }).restart).toBe(true);
    expect(decide({ ...report, liveness: "alive" })).toEqual({ restart: false, why: "supervisor alive" });
  });
});

describe("which stops the loop chose are retried", () => {
  // Read off `lastEvent.name`, never off the stop kind alone: only a `failed`
  // stop on a transient fault is retried, and a missing signal never is.
  const stopped = (kind: StopKind, lastEvent?: { name: string; detail?: string }): Parameters<typeof decide>[0] => ({
    liveness: "dead" as Liveness,
    stopReason: { kind, why: "its own ending", at: "2026-10-20T11:00:00.000Z" },
    run: "r",
    loop: "ralph",
    pid: 77,
    recorded: true,
    why: "supervisor dead",
    ...(lastEvent === undefined ? {} : { lastEvent: { at: "2026-10-20T11:00:00.000Z", ...lastEvent } }),
  });
  const why = "the loop ended: failed — its own ending";

  it("retries secrets-env, no-sigil, preflight-broken and a preflight-denied on doppler-scope alone", () => {
    const cases: [{ name: string; detail?: string }, string][] = [
      [{ name: "secrets-env" }, "secrets-env"],
      // An older harness stopped on a preflight that could not run (#767).
      [{ name: "preflight-broken" }, "preflight-broken"],
      [{ name: "no-sigil" }, "no-sigil"],
      [{ name: "preflight-denied", detail: "doppler-scope" }, "preflight-denied"],
      [{ name: "preflight-denied", detail: "doppler-scope, doppler-scope" }, "preflight-denied"],
    ];
    for (const [event, cause] of cases) {
      expect(decide(stopped("failed", event)), JSON.stringify(event)).toEqual({ restart: false, why, retry: { cause } });
    }
  });

  it("leaves every other failed stop for a human, with today's answer", () => {
    const events: ({ name: string; detail?: string } | undefined)[] = [
      { name: "usage-limit-stop" },
      // A local-config check beside the Doppler one is a stop for a human.
      { name: "preflight-denied", detail: "doppler-scope,config" },
      // No recorded checks is a missing signal, never a retry.
      { name: "preflight-denied" },
      { name: "preflight-denied", detail: "" },
      { name: "preflight-denied", detail: "doppler-scope," },
      undefined,
      // A genuine denial on a local check stays stopped (#767).
      { name: "preflight-denied", detail: "buildkite-logs" },
      { name: "needs-triage" },
      { name: "gate-broken" },
      { name: "something-new" },
    ];
    for (const event of events) {
      const verdict = decide(stopped("failed", event));
      expect(verdict, JSON.stringify(event)).toEqual({ restart: false, why });
      expect(verdict, JSON.stringify(event)).not.toHaveProperty("retry");
    }
  });

  it("never retries a control-stop, of any kind", () => {
    for (const kind of ["completed", "blocked", "failed"] as StopKind[]) {
      expect(decide(stopped(kind, { name: "control-stop" })), kind).not.toHaveProperty("retry");
    }
  });

  it("retries only a failed stop, even when the event names a transient fault", () => {
    for (const kind of ["completed", "blocked"] as StopKind[]) {
      const verdict = decide(stopped(kind, { name: "no-sigil" }));
      expect(verdict, kind).toEqual({ restart: false, why: `the loop ended: ${kind} — its own ending` });
    }
    // A legacy `interrupted` (no `self`/`signal`) says it cannot tell (#6).
    expect(decide(stopped("interrupted", { name: "no-sigil" }))).toEqual({
      restart: false,
      why: "the loop ended: interrupted — its own ending; its record does not say which signal stopped it or who recorded it, so it stays stopped as before",
    });
    expect(decide(stopped("failed", { name: "no-sigil" }))).toHaveProperty("retry", { cause: "no-sigil" });
  });
});

describe("the restart is the Start button's own path", () => {
  it("runs the very invocation POST /api/p/<project>/start runs", async () => {
    const h = harness("same-invocation");
    await reconcile(h.deps);
    // Not "an equivalent command": the invocation the start route would build
    // for this loop, argv, cwd and per-run environment included.
    const [call] = startCalls(h);
    // Written out, not rebuilt by the adapter: the server's environment, less
    // the per-run and resume variables a fresh start must not inherit, with
    // the loop's worktree named as its project.
    const env: Record<string, string | undefined> = { ...process.env, RALPH_PROJECT: h.worktree };
    for (const name of ["RALPH_RUN_ID", "RALPH_SUPERVISOR_PID", "RALPH_STATE_ROOT", "RALPH_RESUME_WORK", "RALPH_RESUME_ISSUE"]) {
      delete env[name];
    }
    expect(call).toEqual({ command: join(HARNESS, "start.sh"), args: [], cwd: h.worktree, env });
    // And the gate ran before it: `prepareStart` reads the roster first. Both
    // indices are asserted present, or a missing gate read would be -1 and
    // "less than" would pass vacuously.
    const gateAt = h.calls.findIndex((c) => (c.args[0] ?? "").endsWith("project-config.ts"));
    const startAt = h.calls.findIndex((c) => c.command.endsWith("start.sh"));
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(startAt).toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeLessThan(startAt);
  });

  it("starts nothing on the next pass once the supervisor is alive again", async () => {
    const h = harness("second-pass");
    await reconcile(h.deps);
    h.script.liveness = "alive";
    h.advance(60_000);
    const second = await reconcile(h.deps);
    expect(second.attempts).toEqual([]);
    expect(startCalls(h)).toHaveLength(1);
  });

  it("records a refused start with its reason, so the bound counts it", async () => {
    // A new agent whose roster PR has not merged: `prepareStart` refuses, and
    // nothing is started. The attempt is still an attempt.
    const h = harness("refused", { liveness: "dead", stop: null, rostered: false });
    const pass = await reconcile(h.deps);
    expect(pass.attempts[0]?.outcome).toBe("refused");
    expect(pass.attempts[0]?.why).toContain("pending merge");
    expect(startCalls(h)).toEqual([]);
    const [record] = restarts(h);
    expect(record?.subject).toContain("restart refused");
    expect(record?.body).toContain("pending merge");
  });

  it("reports a start.sh failure as the attempt's outcome rather than throwing", async () => {
    const h = harness("start-failed", { liveness: "dead", stop: null, start: { status: 1, stdout: "", stderr: "no bun\n" } });
    const pass = await reconcile(h.deps);
    expect(pass.attempts[0]).toMatchObject({ outcome: "failed", why: "no bun" });
  });
});

describe("every attempt reaches the loop's own feed", () => {
  it("pushes through the pinned invocation, naming the project, loop, dead run, reason and outcome", async () => {
    const h = harness("push");
    await reconcile(h.deps);
    const push = h.calls.find((call) => (call.args[0] ?? "").endsWith(RECONCILE_SURFACE.push.script))!;
    expect(push.args.slice(0, 2)).toEqual([`${HARNESS}/${RECONCILE_SURFACE.push.script}`, "push"]);
    expect(push.args).toContain(RECONCILE_SURFACE.push.kinds.restarted);
    // Unset, `push()` would record `run: "adhoc"` and `loop: null`, and the
    // record would name nothing an operator could act on.
    expect(push.env[RECONCILE_SURFACE.push.env.root]).toBe(h.worktree);
    expect(push.env[RECONCILE_SURFACE.push.env.loop]).toBe("ralph");
    expect(push.env[RECONCILE_SURFACE.push.env.run]).toBe("ralph-run-dead");
    const occurrence = push.args[push.args.indexOf("--occurrence") + 1]!;
    expect(occurrence).toBe(`${RECONCILE_SURFACE.push.kinds.restarted}:software-factory:ralph:${new Date(h.nowMs()).toISOString()}`);

    const [record] = restarts(h);
    for (const line of ["project: software-factory", "loop: ralph", "dead run: ralph-run-dead", "reason: supervisor 4242 gone, no stopReason", "outcome: restarted (pid 5151)"]) {
      expect(record?.body).toContain(line);
    }
  });

  it("writes two records for two attempts under one dead run id", async () => {
    // The loop dies before it writes a new `state.json`, so both attempts see
    // the same run. Without the attempt's timestamp in the occurrence key the
    // second push would be dropped as a duplicate, and the bound below —
    // which counts these records — would never trip.
    const h = harness("two-attempts");
    await reconcile(h.deps);
    h.advance(GAP_MS);
    await reconcile(h.deps);
    const ids = h.feed().map((entry) => entry.id);
    expect(new Set(ids).size).toBe(2);
    expect(restarts(h)).toHaveLength(2);
  });
});

describe("a stop nobody confirmed stops the restart", () => {
  it("leaves the loop alone while a pending stop is on the record", async () => {
    // A Stop now that signalled the process group and never got its
    // confirming write — the gap an oomd kill lands in — leaves
    // `stopReason: null` with a pending stop. A new supervisor ADOPTS it and
    // exits, so the restart would record a start that immediately ended.
    for (const confirmation of ["pending", "unreachable"] as const) {
      const h = harness(`stop-${confirmation}`, {
        liveness: "dead",
        stop: null,
        stop_record: { kind: "interrupted", confirmation },
      });
      const pass = await reconcile(h.deps);
      expect(pass.attempts, confirmation).toEqual([]);
      expect(pass.skipped[0]?.why, confirmation).toContain(confirmation);
      expect(startCalls(h), confirmation).toEqual([]);
    }
  });

  it("restarts over a confirmed stop whose record carries no ending", async () => {
    // Confirmed is the supervisor saying it read the stop and is exiting; the
    // record's own `stopReason` is what says the loop chose an ending, and
    // this one has none.
    const h = harness("stop-confirmed", {
      liveness: "dead",
      stop: null,
      stop_record: { kind: "blocked", confirmation: "confirmed" },
    });
    expect((await reconcile(h.deps)).attempts).toHaveLength(1);
  });
});

describe("the bound", () => {
  it("counts the records in the loop's own feed, not anything it remembers", async () => {
    // The feed is written by this test, before the reconciler has ever run:
    // after a `Restart=always` cycle that is exactly the state the process
    // wakes up in, and an in-memory counter would read zero.
    const h = harness("counts-file");
    const base = Date.parse("2026-10-20T12:00:00.000Z");
    for (const minutes of [50, 40, 30]) h.pastAttempt(new Date(base - minutes * 60_000).toISOString());
    const pass = await reconcile(h.deps);
    expect(pass.attempts).toEqual([]);
    expect(pass.capped[0]).toMatchObject({ loop: "ralph", attempts: DEFAULT_ATTEMPTS, alerted: true });
    expect(startCalls(h)).toEqual([]);
    const capped = h.feed().filter((entry) => entry.kind === RECONCILE_SURFACE.push.kinds.capped);
    expect(capped).toHaveLength(1);
    expect(capped[0]?.body).toContain("reached the bound of 3");
  });

  it("raises one alert per capped stretch, not one per pass", async () => {
    const h = harness("one-alert");
    const base = Date.parse("2026-10-20T12:00:00.000Z");
    for (const minutes of [50, 40, 30]) h.pastAttempt(new Date(base - minutes * 60_000).toISOString());
    await reconcile(h.deps);
    h.advance(60_000);
    const second = await reconcile(h.deps);
    expect(second.capped[0]?.alerted).toBe(false);
    expect(h.feed().filter((entry) => entry.kind === RECONCILE_SURFACE.push.kinds.capped)).toHaveLength(1);
  });

  it("trips on three restarts that all carry the same run id", async () => {
    const h = harness("same-run");
    for (let round = 0; round < 3; round += 1) {
      const pass = await reconcile(h.deps);
      expect(pass.attempts, `round ${String(round)}`).toHaveLength(1);
      h.advance(GAP_MS);
    }
    const fourth = await reconcile(h.deps);
    expect(fourth.attempts).toEqual([]);
    expect(fourth.capped).toHaveLength(1);
    expect(startCalls(h)).toHaveLength(3);
  });

  it("trips on three refusals in a row, so a gate that keeps saying no is bounded", async () => {
    const h = harness("three-refusals", { liveness: "dead", stop: null, rostered: false });
    for (let round = 0; round < 3; round += 1) {
      expect((await reconcile(h.deps)).attempts, `round ${String(round)}`).toHaveLength(1);
      h.advance(GAP_MS);
    }
    const fourth = await reconcile(h.deps);
    expect(fourth.attempts).toEqual([]);
    expect(fourth.capped[0]?.attempts).toBe(3);
    // Nothing was ever started, and the capped pass re-read no roster at all:
    // a gate that keeps refusing stops costing git reads every interval.
    expect(startCalls(h)).toEqual([]);
    const reads = (): number => h.calls.filter((call) => (call.args[0] ?? "").endsWith("project-config.ts")).length;
    const before = reads();
    h.advance(GAP_MS);
    await reconcile(h.deps);
    expect(reads()).toBe(before);
  });

  it("leaves the loop alone when the feed it counts from cannot be read", async () => {
    // Unreadable is not "no attempts yet": read as zero, nothing would bound
    // the restarts at all, which is the runaway the bound exists to stop.
    const h = harness("feed-unreadable");
    const pass = await reconcile({
      ...h.deps,
      records: () => ({ readFeed: () => ({ feed: { state: "unreadable", why: "EACCES" }, readMark: { state: "missing" } }) }),
    });
    expect(pass.attempts).toEqual([]);
    expect(pass.skipped[0]?.why).toContain("bound cannot be counted");
    expect(startCalls(h)).toEqual([]);
  });

  it("bounds a loop whose attempt records cannot be written, from this process's own count", async () => {
    // The records are the bound, and a push that fails writes none of them —
    // so a loop that dies on every start would get a fresh `start.sh` every
    // interval for ever. The process's count is the second ceiling for
    // exactly that; it is never the only one, because `Restart=always` resets
    // it on the cycle the bound exists for.
    const h = harness("push-fails", { liveness: "dead", stop: null, pushFails: true });
    const seen: Seen = new Map();
    for (let round = 0; round < DEFAULT_ATTEMPTS; round += 1) {
      const pass = await reconcile({ ...h.deps, seen });
      expect(pass.attempts, `round ${String(round)}`).toHaveLength(1);
      h.advance(GAP_MS);
    }
    expect(h.feed()).toEqual([]);
    const capped = await reconcile({ ...h.deps, seen });
    expect(capped.attempts).toEqual([]);
    expect(capped.capped[0]).toMatchObject({ loop: "ralph", attempts: DEFAULT_ATTEMPTS });
    expect(startCalls(h)).toHaveLength(DEFAULT_ATTEMPTS);
  });

  it("counts the same attempt once when both the records and this process saw it", async () => {
    // The two sources are a MAXIMUM, not a sum: each attempt is in the feed
    // and in memory, so adding them would cap every loop after two real
    // attempts instead of three — a bound the operator never asked for and
    // could not explain.
    const h = harness("both-sources");
    const seen: Seen = new Map();
    for (let round = 0; round < DEFAULT_ATTEMPTS; round += 1) {
      expect((await reconcile({ ...h.deps, seen })).attempts, `round ${String(round)}`).toHaveLength(1);
      h.advance(GAP_MS);
    }
    // Both sources now hold all three, and the records were really written.
    expect(restarts(h)).toHaveLength(DEFAULT_ATTEMPTS);
    expect(seen.get(h.worktree)?.attempts).toHaveLength(DEFAULT_ATTEMPTS);
    expect(startCalls(h)).toHaveLength(DEFAULT_ATTEMPTS);
    const capped = await reconcile({ ...h.deps, seen });
    expect(capped.attempts).toEqual([]);
    expect(capped.capped[0]).toMatchObject({ attempts: DEFAULT_ATTEMPTS });
  });

  it("attempts again once the window has slid past what THIS PROCESS remembers", async () => {
    // The second ceiling is times, not a count, for exactly this: a count
    // would never age out, so three attempts would cap the loop for as long
    // as the dashboard ran and the hourly bound would quietly become a
    // permanent one — with the capped alert re-raised on every pass.
    const h = harness("seen-window", { liveness: "dead", stop: null, pushFails: true });
    const seen: Seen = new Map();
    for (let round = 0; round < DEFAULT_ATTEMPTS; round += 1) {
      expect((await reconcile({ ...h.deps, seen })).attempts, `round ${String(round)}`).toHaveLength(1);
      h.advance(GAP_MS);
    }
    expect((await reconcile({ ...h.deps, seen })).capped).toHaveLength(1);
    h.advance(WINDOW_MS);
    const later = await reconcile({ ...h.deps, seen });
    expect(later.capped).toEqual([]);
    expect(later.attempts).toHaveLength(1);
  });

  it("raises the capped alert once per stretch even with nothing written to count", async () => {
    // With pushes failing there is no record to key the stretch to, so the
    // process remembers that it has said so; otherwise this is one
    // high-priority alert attempt per pass, for ever.
    const h = harness("seen-alert-once", { liveness: "dead", stop: null, pushFails: true });
    const seen: Seen = new Map();
    for (let round = 0; round < DEFAULT_ATTEMPTS; round += 1) {
      await reconcile({ ...h.deps, seen });
      h.advance(GAP_MS);
    }
    const alerted: boolean[] = [];
    for (let round = 0; round < 4; round += 1) {
      alerted.push((await reconcile({ ...h.deps, seen })).capped[0]?.alerted === true);
      h.advance(60_000);
    }
    expect(alerted).toEqual([true, false, false, false]);
  });

  it("attempts again once the window has slid past the oldest attempt", async () => {
    const h = harness("window-slides");
    const base = Date.parse("2026-10-20T12:00:00.000Z");
    for (const minutes of [50, 40, 30]) h.pastAttempt(new Date(base - minutes * 60_000).toISOString());
    expect((await reconcile(h.deps)).capped).toHaveLength(1);
    // Past the hour from the oldest of the three — and past the spacing from
    // the newest, which was 30 minutes ago.
    h.advance(WINDOW_MS - 49 * 60_000);
    const later = await reconcile(h.deps);
    expect(later.capped).toEqual([]);
    expect(later.attempts).toHaveLength(1);
  });
});

describe("a pass that cannot read one loop still recovers the others", () => {
  it("skips the unreadable loop and reports why", async () => {
    const h = harness("one-bad");
    const broken: ReconcileTarget = {
      ...h.target,
      loop: "rafa",
      lifecycle: {
        ...h.target.lifecycle,
        lifecycle: createRalphLifecycleAdapter({
          cliDir: HARNESS,
          root: h.worktree,
          bunPath: "bun",
          env: {},
          startScript: join(HARNESS, "start.sh"),
          exec: async () => {
            throw new Error("worktree is gone");
          },
        }),
      },
    };
    const deps: ReconcileDeps = { ...h.deps, targets: () => [broken, h.target] };
    const pass = await reconcile(deps);
    // The broken one's read degrades to `unknown`, which is never a restart.
    expect(pass.skipped.map((entry) => entry.loop)).toContain("rafa");
    expect(pass.attempts.map((entry) => entry.loop)).toEqual(["ralph"]);
  });

  it("answers an empty pass when the loops cannot be listed", async () => {
    const h = harness("no-targets");
    const lines: string[] = [];
    const pass = await reconcile({
      ...h.deps,
      targets: () => {
        throw new Error("registry unreadable");
      },
      log: (line) => lines.push(line),
    });
    expect(pass.considered).toBe(0);
    expect(lines.join("\n")).toContain("registry unreadable");
  });
});

describe("a loop left down is said once (#765)", () => {
  const passes = async (h: Harness, n: number): Promise<{ lines: string[]; said: Said }> => {
    const lines: string[] = [];
    const said: Said = new Map();
    for (let pass = 0; pass < n; pass += 1) {
      await reconcile({ ...h.deps, said, log: (line) => lines.push(line) });
      h.advance(GAP_MS);
    }
    return { lines, said };
  };

  it("says a dead supervisor with an interrupted ending once across passes, and does not restart it", async () => {
    const h = harness("said-interrupted", { liveness: "dead", stop: { kind: "interrupted", why: "SIGTERM at shutdown" } });
    const { lines } = await passes(h, 2);
    expect(startCalls(h)).toEqual([]);
    expect(lines).toEqual([
      "reconcile: software-factory/ralph is down and stays stopped: the loop ended: interrupted — SIGTERM at shutdown; its record does not say which signal stopped it or who recorded it, so it stays stopped as before",
    ]);
  });

  it("says a loop whose liveness could not be read once", async () => {
    const h = harness("said-unknown", { liveness: "unknown", stop: null });
    const { lines } = await passes(h, 2);
    expect(startCalls(h)).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("reconcile: software-factory/ralph could not be seen, so it is left alone: supervisor unknown");
  });

  it("says nothing about a live supervisor, and a loop that came back up is said again when it goes down", async () => {
    const alive = harness("said-alive", { liveness: "alive", stop: null });
    expect((await passes(alive, 2)).lines).toEqual([]);

    const h = harness("said-again", { liveness: "dead", stop: { kind: "interrupted", why: "SIGTERM" } });
    const lines: string[] = [];
    const said: Said = new Map();
    const pass = () => reconcile({ ...h.deps, said, log: (line) => lines.push(line) });
    await pass();
    h.script.liveness = "alive";
    await pass();
    h.script.liveness = "dead";
    await pass();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(lines[1]);
  });

  it("stays silent without the memory, as before", async () => {
    const h = harness("said-none", { liveness: "dead", stop: { kind: "interrupted", why: "SIGTERM" } });
    const lines: string[] = [];
    await reconcile({ ...h.deps, log: (line) => lines.push(line) });
    expect(lines).toEqual([]);
  });
});

describe("a loop the host shutdown stopped before this boot (#6)", () => {
  const BEFORE = "2026-10-20T11:00:00.000Z";
  const AFTER = "2026-10-20T11:45:00.000Z";
  const passes = async (h: Harness, n: number, over: Partial<ReconcileDeps> = {}) => {
    const lines: string[] = [];
    const said: Said = new Map();
    let last: Awaited<ReturnType<typeof reconcile>> | null = null;
    for (let pass = 0; pass < n; pass += 1) {
      last = await reconcile({ ...h.deps, said, log: (line) => lines.push(line), ...over });
      h.advance(GAP_MS);
    }
    return { lines, last: last! };
  };
  const stop = (signal: string | undefined, self: boolean | undefined) => ({
    kind: "interrupted" as StopKind,
    why: "signal received",
    ...(signal === undefined ? {} : { signal }),
    ...(self === undefined ? {} : { self }),
  });
  const plain = "the loop ended: interrupted — signal received";

  it("restarts a self-recorded SIGTERM stop from before the boot, and says why", async () => {
    const h = harness("shutdown-restart", { liveness: "dead", stop: stop("SIGTERM", true), stopAt: BEFORE });
    const { lines, last } = await passes(h, 1);
    expect(startCalls(h)).toHaveLength(1);
    expect(last.attempts).toHaveLength(1);
    expect(last.attempts[0]).toMatchObject({ outcome: "restarted", loop: "ralph" });
    expect(lines).toContain("reconcile: software-factory/ralph was stopped by the host shutdown before this boot — restarting");
    expect(restarts(h)[0]?.body).toContain("reason: stopped by the host shutdown before this boot");
  });

  it("leaves a self-recorded SIGTERM after the boot stopped: a manual kill", async () => {
    const h = harness("shutdown-after", { liveness: "dead", stop: stop("SIGTERM", true), stopAt: AFTER });
    const { lines, last } = await passes(h, 1);
    expect(startCalls(h)).toEqual([]);
    expect(last.skipped[0]?.why).toBe(plain);
    expect(lines).toEqual([`reconcile: software-factory/ralph is down and stays stopped: ${plain}`]);
  });

  it("leaves SIGINT and SIGHUP from before the boot stopped", async () => {
    for (const signal of ["SIGINT", "SIGHUP"]) {
      const h = harness(`shutdown-${signal}`, { liveness: "dead", stop: stop(signal, true), stopAt: BEFORE });
      const { last } = await passes(h, 1);
      expect(startCalls(h), signal).toEqual([]);
      expect(last.skipped[0]?.why, signal).toBe(plain);
    }
  });

  it("leaves an operator's Stop stopped", async () => {
    const h = harness("shutdown-operator", { liveness: "dead", stop: stop(undefined, false), stopAt: BEFORE });
    const { last } = await passes(h, 1);
    expect(startCalls(h)).toEqual([]);
    expect(last.skipped[0]?.why).toBe(plain);
  });

  it("leaves a legacy record stopped, and says so once across two passes", async () => {
    const legacy = `${plain}; its record does not say which signal stopped it or who recorded it, so it stays stopped as before`;
    for (const [label, script] of [
      ["legacy", stop(undefined, undefined)],
      ["legacy-self", stop(undefined, true)],
    ] as const) {
      const h = harness(`shutdown-${label}`, { liveness: "dead", stop: script, stopAt: BEFORE });
      const { lines } = await passes(h, 2);
      expect(startCalls(h), label).toEqual([]);
      expect(lines, label).toEqual([`reconcile: software-factory/ralph is down and stays stopped: ${legacy}`]);
    }
  });

  it("leaves it stopped when the boot time cannot be read, and says so once", async () => {
    const why = `${plain}; the host's boot time could not be read, so it stays stopped`;
    for (const [label, bootTime] of [
      ["null", () => null],
      [
        "throws",
        () => {
          throw new Error("no /proc");
        },
      ],
    ] as const) {
      const h = harness(`shutdown-boot-${label}`, { liveness: "dead", stop: stop("SIGTERM", true), stopAt: BEFORE });
      const { lines } = await passes(h, 2, { bootTime });
      expect(startCalls(h), label).toEqual([]);
      expect(lines, label).toEqual([`reconcile: software-factory/ralph is down and stays stopped: ${why}`]);
    }
  });

  it("leaves it stopped when the stop time cannot be read", async () => {
    const h = harness("shutdown-bad-at", { liveness: "dead", stop: stop("SIGTERM", true), stopAt: "not a time" });
    const { last } = await passes(h, 1);
    expect(startCalls(h)).toEqual([]);
    expect(last.skipped[0]?.why).toBe(`${plain}; its stop time could not be read, so it stays stopped`);
  });

  it("keeps today's answers for a supervisor alive or unseen", () => {
    const report = {
      liveness: "alive" as Liveness,
      stopReason: { kind: "interrupted" as StopKind, why: "signal received", at: BEFORE, signal: "SIGTERM", self: true },
      run: "r",
      loop: "ralph",
      pid: 77,
      recorded: true,
      why: "could not read the process table",
    };
    expect(decide(report, BOOT_MS)).toEqual({ restart: false, why: "supervisor alive" });
    expect(decide({ ...report, liveness: "unknown" }, BOOT_MS)).toEqual({
      restart: false,
      why: "supervisor unknown: could not read the process table",
    });
    expect(decide({ ...report, liveness: "dead" }, BOOT_MS)).toEqual({
      restart: true,
      reason: "stopped by the host shutdown before this boot",
      shutdown: true,
    });
  });

  it("is still blocked by a pending stop on the control record", async () => {
    const h = harness("shutdown-pending", {
      liveness: "dead",
      stop: stop("SIGTERM", true),
      stopAt: BEFORE,
      stop_record: { kind: "interrupted", confirmation: "pending" },
    });
    const { last } = await passes(h, 1);
    expect(startCalls(h)).toEqual([]);
    expect(last.attempts).toEqual([]);
    expect(last.skipped[0]?.why).toContain("pending");
  });

  it("reads the boot time off /proc/stat's btime line, and null otherwise", () => {
    expect(readBootTimeMs(() => "cpu  1 2 3\nbtime 1795500000\nprocesses 9\n")).toBe(1_795_500_000_000);
    expect(readBootTimeMs(() => "cpu  1 2 3\nprocesses 9\n")).toBeNull();
    expect(
      readBootTimeMs(() => {
        throw new Error("EACCES");
      }),
    ).toBeNull();
  });
});

describe("the walk over the registry's projects", () => {
  const build = () => ({ lifecycle: {} as never, agents: {} as never });

  it("carries each project's id and drops a worktree the roster names no loop for", async () => {
    const targets = await targetsFrom(
      [
        {
          project: "software-factory",
          read: async () => ({
            loops: [
              { identity: "ralph", worktree: "/w/ralph" },
              // A worktree no loop is attributed to cannot be started by name.
              { identity: null, worktree: "/w/orphan" },
              { identity: "rafa", worktree: "/w/rafa" },
            ],
          }),
        },
        { project: "loggd", read: async () => ({ loops: [{ identity: "remo", worktree: "/w/remo" }] }) },
      ],
      build,
    );
    expect(targets.map((target) => [target.project, target.loop, target.worktree])).toEqual([
      ["software-factory", "ralph", "/w/ralph"],
      ["software-factory", "rafa", "/w/rafa"],
      ["loggd", "remo", "/w/remo"],
    ]);
  });

  it("skips a project whose read fails and still walks the others", async () => {
    const lines: string[] = [];
    const targets = await targetsFrom(
      [
        {
          project: "broken",
          read: () => {
            throw new Error("loop-state did not run");
          },
        },
        { project: "loggd", read: async () => ({ loops: [{ identity: "remo", worktree: "/w/remo" }] }) },
      ],
      build,
      (line) => lines.push(line),
    );
    expect(targets.map((target) => target.loop)).toEqual(["remo"]);
    expect(lines[0]).toContain("broken");
    expect(lines[0]).toContain("loop-state did not run");
  });

  it("says a project that stays unreadable once, re-reads it every pass, and says when it is back", async () => {
    const lines: string[] = [];
    const said: Said = new Map();
    let failure: string | null = "no .ralph/config.json";
    const projects = [
      {
        project: "broken",
        read: async () => {
          if (failure !== null) throw new Error(failure);
          return { loops: [{ identity: "remo", worktree: "/w/remo" }] };
        },
      },
    ];
    const walk = () => targetsFrom(projects, build, (line) => lines.push(line), said);
    for (let pass = 0; pass < 3; pass += 1) expect(await walk()).toEqual([]);
    expect(lines).toEqual(["reconcile: could not read broken: no .ralph/config.json"]);

    // The retry is the next pass's read: its targets come back, said once.
    failure = null;
    expect((await walk()).map((target) => target.loop)).toEqual(["remo"]);
    expect((await walk()).map((target) => target.loop)).toEqual(["remo"]);
    expect(lines.slice(1)).toEqual(["reconcile: broken is readable again"]);

    failure = "loop-state did not run";
    await walk();
    await walk();
    expect(lines.slice(2)).toEqual(["reconcile: could not read broken: loop-state did not run"]);
  });

  it("logs every failed read when it is given no memory", async () => {
    const lines: string[] = [];
    const projects = [{ project: "broken", read: () => Promise.reject(new Error("gone")) }];
    await targetsFrom(projects, build, (line) => lines.push(line));
    await targetsFrom(projects, build, (line) => lines.push(line));
    expect(lines).toHaveLength(2);
  });

  it("is what the server walks with, rather than a second walk in its composition", () => {
    // The wiring `main()` serves lives in `composeServer` since #624.
    const compose = readFileSync(join(__dirname, "compose.ts"), "utf8");
    const body = compose.slice(compose.indexOf("export function composeServer("));
    expect(body).toMatch(/targetsFrom\(/);
    // One reading of the registry per pass, so the walk and the deps a target
    // is built with cannot disagree about which projects there are. Asserted
    // as the map itself: `registry.list()` appears in the composition for the request
    // scopes too, so counting calls would pass with this property reverted.
    expect(body).toMatch(/const registered = new Map\(/);
    expect(body).toMatch(/registered\.get\(project\)/);
  });
});

describe("the migration watchdog's walk over the registry's projects", () => {
  it("gives each project one root, the roster's first loop, and skips a project whose read fails", async () => {
    const lines: string[] = [];
    const projects = await watchProjectsFrom(
      [
        {
          project: "software-factory",
          read: async () => ({
            roster: [
              { name: "rafa", role: "coder" },
              { name: "ralph", role: "coder" },
            ],
            loops: [
              { identity: "ralph", worktree: "/w/a-ralph" },
              { identity: "rafa", worktree: "/w/z-rafa" },
            ],
          }),
        },
        {
          project: "broken",
          read: () => {
            throw new Error("loop-state did not run");
          },
        },
        { project: "empty", read: async () => ({ roster: [], loops: [{ identity: null, worktree: "/w/orphan" }] }) },
      ],
      (line) => lines.push(line),
    );
    expect(projects).toEqual([
      { project: "software-factory", root: { loop: "rafa", worktree: "/w/z-rafa" } },
      // Kept, with no root: `watchMigrations` reports it as skipped.
      { project: "empty", root: null },
    ]);
    expect(lines.join("\n")).toContain("broken");
    expect(lines.join("\n")).toContain("loop-state did not run");
  });

  it("says a project that stays unreadable once, and again only once it read and broke again (#765)", async () => {
    const lines: string[] = [];
    const said: Said = new Map();
    let broken = true;
    const projects = [
      {
        project: "usagebar",
        read: async () => {
          if (broken) throw new Error("no .ralph/config.json");
          return { roster: [], loops: [] };
        },
      },
    ];
    const walk = () => watchProjectsFrom(projects, (line) => lines.push(line), said);
    await walk();
    await walk();
    await walk();
    expect(lines).toEqual(["migration-watchdog: could not read usagebar: no .ralph/config.json"]);
    broken = false;
    await walk();
    broken = true;
    await walk();
    expect(lines).toHaveLength(2);
  });

  it("is what the server walks with, on the reconciler's timer and off switch", () => {
    const compose = readFileSync(join(__dirname, "compose.ts"), "utf8");
    const body = compose.slice(compose.indexOf("export function composeServer("));
    expect(body).toMatch(/watchProjectsFrom\(/);
    expect(body).toMatch(/alertSeconds: reconciling\.migrationAlertSeconds/);
    // The composition only offers the pass; `main()` alone schedules it.
    expect(body).not.toMatch(/schedule\(/);
    const server = readFileSync(join(__dirname, "server.ts"), "utf8");
    const main = server.slice(server.indexOf("async function main("));
    expect(main.match(/schedule\(/g)).toHaveLength(1);
    expect(main).toMatch(/await composed\.watchMigrations\(\)/);
  });
});

describe("the schedule", () => {
  it("runs the startup pass at once, then one pass per interval, on an injected clock", async () => {
    // No real interval is waited on: the clock and the wait are both the
    // test's, so this suite cannot be slow and cannot flake on a loaded host.
    let clock = 0;
    const waits: number[] = [];
    let passes = 0;
    const handle = schedule(
      async () => {
        passes += 1;
        clock += 250;
      },
      {
        intervalMs: 60_000,
        now: () => clock,
        wait: async (ms) => {
          waits.push(ms);
          clock += ms;
          if (waits.length >= 3) handle.stop();
        },
      },
    );
    await handle.done;
    expect(passes).toBe(3);
    // The remainder of the interval, so a slow pass does not push the next out.
    expect(waits).toEqual([59_750, 59_750, 59_750]);
  });

  it("settles when the pass itself stops it, without waiting out an interval", async () => {
    // `main()` drops the handle and only the process stops that schedule, but
    // a stop issued from inside a pass must not leave `done` pending for a
    // whole interval — which is what the post-pass check is for.
    let clock = 0;
    const waits: number[] = [];
    let passes = 0;
    // The first pass runs inside `schedule(...)`, before `handle` exists, so
    // the stop is issued after a microtask — which is also how a real pass
    // would reach it.
    let handle!: { stop: () => void; done: Promise<void> };
    handle = schedule(
      async () => {
        passes += 1;
        await Promise.resolve();
        handle.stop();
      },
      { intervalMs: 60_000, now: () => clock, wait: async (ms) => { waits.push(ms); clock += ms; } },
    );
    await handle.done;
    expect(passes).toBe(1);
    expect(waits).toEqual([]);
  });

  it("logs a wait that rejects rather than leaving an unhandled rejection", async () => {
    // The server drops the handle deliberately, so nothing is attached to
    // `done` there: a rejected wait must not escape the loop.
    let clock = 0;
    let passes = 0;
    const lines: string[] = [];
    const handle = schedule(
      async () => {
        passes += 1;
      },
      {
        intervalMs: 1_000,
        now: () => clock,
        wait: async () => {
          if (passes >= 2) handle.stop();
          throw new Error("the timer is gone");
        },
        log: (line) => lines.push(line),
      },
    );
    await expect(handle.done).resolves.toBeUndefined();
    expect(passes).toBe(2);
    expect(lines[0]).toContain("the timer is gone");
  });

  it("keeps going when a pass throws", async () => {
    let clock = 0;
    let passes = 0;
    const lines: string[] = [];
    const handle = schedule(
      async () => {
        passes += 1;
        throw new Error(`pass ${String(passes)} broke`);
      },
      {
        intervalMs: 1_000,
        now: () => clock,
        wait: async (ms) => {
          clock += ms;
          if (passes >= 2) handle.stop();
        },
        log: (line) => lines.push(line),
      },
    );
    await handle.done;
    expect(passes).toBe(2);
    expect(lines[0]).toContain("pass 1 broke");
  });

  it("defaults to a minute", () => {
    expect(DEFAULT_RECONCILE_MS).toBe(60_000);
  });
});

describe("a loop that stopped itself on a transient fault is retried", () => {
  const kinds = RECONCILE_SURFACE.push.kinds;
  const RETRYING: Script = { liveness: "dead", stop: { kind: "failed", why: "no sigil" }, lastEvent: { name: "no-sigil" } };
  const MINUTE = 60_000;
  /** The raw `raised` lines of one kind, oldest first, with whatever `push` put on them. */
  const raised = (h: Harness, kind: string): Record<string, unknown>[] => {
    const path = join(h.worktree, FEED);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => row.kind === kind);
  };
  /** A past `loop-retried` (or `loop-retry-capped`) record, as the real push would have left it. */
  const pastRetry = (h: Harness, at: string, kind: string = kinds.retried): void => h.pastAttempt(at, kind);
  const iso = (ms: number): string => new Date(ms).toISOString();

  it("waits out the first gap from the stop, then starts with attempt 1 of 7 on the raised line", async () => {
    const h = harness("retry-first", { ...RETRYING, stopAt: "2026-10-20T11:58:00.000Z" });
    const early = await reconcile(h.deps);
    expect(early.attempts).toEqual([]);
    expect(early.skipped[0]?.why).toBe("retry 1 of 7 for no-sigil is due at 2026-10-20T12:03:00.000Z");
    h.advance(3 * MINUTE - 1_000);
    expect((await reconcile(h.deps)).attempts).toEqual([]);
    expect(startCalls(h)).toEqual([]);
    h.advance(1_000);
    const pass = await reconcile(h.deps);
    expect(pass.attempts).toHaveLength(1);
    expect(pass.attempts[0]).toMatchObject({ outcome: "restarted", pid: 5151, retry: { attempt: 1, of: 7, cause: "no-sigil" } });
    expect(startCalls(h)).toHaveLength(1);
    const lines = raised(h, kinds.retried);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ priority: "normal", subject: "ralph (software-factory): retry 1 of 7 restarted" });
    expect(lines[0]?.retry).toEqual({ attempt: 1, of: 7, cause: "no-sigil" });
    expect(lines[0]?.body).toContain("attempt: 1 of 7");
    expect(lines[0]?.body).toContain("cause: no-sigil");
  });

  it("waits each gap of the schedule from the newest attempt, not from the stop", async () => {
    for (const [k, minutes] of [[0, 5], [1, 15], [2, 45], [3, 60]] as const) {
      // With past attempts the stop is a day old, so a gap anchored on it
      // would be long elapsed: only the newest record can hold the start.
      const h = harness(`retry-gap-${String(k)}`, { ...RETRYING, stopAt: k === 0 ? "2026-10-20T12:00:00.000Z" : "2026-10-19T00:00:00.000Z" });
      for (let i = 0; i < k; i += 1) pastRetry(h, iso(h.nowMs() - (k - i - 1) * 2 * MINUTE));
      expect((await reconcile(h.deps)).attempts, String(k)).toEqual([]);
      h.advance(minutes * MINUTE - 1_000);
      expect((await reconcile(h.deps)).attempts, String(k)).toEqual([]);
      h.advance(1_000);
      const pass = await reconcile(h.deps);
      expect(pass.attempts[0]?.retry, String(k)).toEqual({ attempt: k + 1, of: 7, cause: "no-sigil" });
      expect(startCalls(h), String(k)).toHaveLength(1);
    }
  });

  it("caps after seven attempts that each stop again, with one high alert and nothing started after", async () => {
    const h = harness("retry-cap", RETRYING);
    for (const [i, minutes] of DEFAULT_RETRY_SCHEDULE_MINUTES.entries()) {
      if (i > 0) h.advance(minutes * MINUTE);
      const pass = await reconcile(h.deps);
      expect(pass.attempts[0]?.retry, String(i)).toEqual({ attempt: i + 1, of: 7, cause: "no-sigil" });
    }
    expect(startCalls(h)).toHaveLength(7);
    h.advance(60 * MINUTE);
    const capped = await reconcile(h.deps);
    expect(capped.attempts).toEqual([]);
    expect(capped.capped).toEqual([{ loop: "ralph", project: "software-factory", attempts: 7, alerted: true, retry: true }]);
    const alerts = raised(h, kinds.retryCapped);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ priority: "high", subject: "ralph (software-factory): retries capped" });
    expect(alerts[0]?.body).toContain("7 retry attempts since the loop was first recorded spent the schedule of 7");
    expect(alerts[0]?.body).toContain("press Start once the cause is fixed");
    for (const _ of [1, 2]) {
      h.advance(60 * MINUTE);
      const later = await reconcile(h.deps);
      expect(later.capped[0]?.alerted).toBe(false);
      expect(later.attempts).toEqual([]);
    }
    expect(raised(h, kinds.retryCapped)).toHaveLength(1);
    expect(startCalls(h)).toHaveLength(7);
  });

  it("records a refused start as an attempt, and counts it", async () => {
    const h = harness("retry-refused", { ...RETRYING, rostered: false });
    const pass = await reconcile(h.deps);
    expect(pass.attempts[0]).toMatchObject({ outcome: "refused", retry: { attempt: 1, of: 7, cause: "no-sigil" } });
    expect(startCalls(h)).toEqual([]);
    expect(raised(h, kinds.retried)).toHaveLength(1);
    expect(raised(h, kinds.retried)[0]?.priority).toBe("high");
    h.advance(15 * MINUTE);
    expect((await reconcile(h.deps)).attempts[0]?.retry?.attempt).toBe(2);
  });

  it("counts an attempt whose supervisor exited before writing a record: the count is the records, not the runs", async () => {
    // Every past attempt is under the same run id — no new supervisor ever
    // wrote a record — and each still spends one.
    const h = harness("retry-no-run", RETRYING);
    for (const minutes of [300, 200, 100]) pastRetry(h, iso(h.nowMs() - minutes * MINUTE));
    const pass = await reconcile(h.deps);
    expect(pass.attempts[0]?.retry).toEqual({ attempt: 4, of: 7, cause: "no-sigil" });
    expect(new Set(raised(h, kinds.retried).map((row) => row.run))).toEqual(new Set(["ralph-run-dead"]));
    h.advance(60 * MINUTE);
    expect((await reconcile(h.deps)).attempts[0]?.retry?.attempt).toBe(5);
  });

  it("ignores a record time and a stop time that will not parse, rather than failing", async () => {
    const h = harness("retry-unparseable", { ...RETRYING, stopAt: "not a time" });
    pastRetry(h, "not a time either");
    const pass = await reconcile(h.deps);
    expect(pass.attempts[0]?.retry).toEqual({ attempt: 1, of: 7, cause: "no-sigil" });
    expect(startCalls(h)).toHaveLength(1);
  });

  it("starts a fresh schedule once an iteration finished after the old retries and their cap", async () => {
    const h = harness("retry-fresh", { ...RETRYING, lastIterationEndAt: "2026-10-20T10:00:00.000Z" });
    for (let i = 0; i < 7; i += 1) pastRetry(h, iso(Date.parse("2026-10-19T00:00:00.000Z") + i * 60 * MINUTE));
    pastRetry(h, "2026-10-19T08:00:00.000Z", kinds.retryCapped);
    const deps: ReconcileDeps = { ...h.deps, retrySchedule: [1] };
    const pass = await reconcile(deps);
    expect(pass.attempts[0]?.retry).toEqual({ attempt: 1, of: 1, cause: "no-sigil" });
    h.advance(MINUTE);
    const capped = await reconcile(deps);
    expect(capped.capped[0]).toMatchObject({ attempts: 1, alerted: true, retry: true });
    expect(raised(h, kinds.retryCapped)).toHaveLength(2);
    expect(raised(h, kinds.retryCapped)[1]?.body).toContain("since 2026-10-20T10:00:00.000Z");
  });

  it("still caps when no push is written: the process's own memory spends the schedule", async () => {
    // Every push fails, so no `loop-retried` record exists to count from.
    // Without the second ceiling each pass would start it again, forever.
    const h = harness("retry-push-fails", { ...RETRYING, pushFails: true });
    const retrySeen: RetrySeen = new Map();
    const seen: Seen = new Map();
    const deps: ReconcileDeps = { ...h.deps, retrySeen, seen };
    for (const [i, minutes] of DEFAULT_RETRY_SCHEDULE_MINUTES.entries()) {
      if (i > 0) {
        h.advance(minutes * MINUTE - 1_000);
        expect((await reconcile(deps)).attempts, String(i)).toEqual([]);
        h.advance(1_000);
      }
      const pass = await reconcile(deps);
      expect(pass.attempts[0]?.retry, String(i)).toEqual({ attempt: i + 1, of: 7, cause: "no-sigil" });
    }
    expect(startCalls(h)).toHaveLength(7);
    expect(raised(h, kinds.retried)).toEqual([]);
    h.advance(60 * MINUTE);
    const capped = await reconcile(deps);
    expect(capped.attempts).toEqual([]);
    expect(capped.capped).toEqual([{ loop: "ralph", project: "software-factory", attempts: 7, alerted: true, retry: true }]);
    // The cap is remembered too, so its failed push is not tried on every pass.
    h.advance(60 * MINUTE);
    const later = await reconcile(deps);
    expect(later.attempts).toEqual([]);
    expect(later.capped[0]?.alerted).toBe(false);
    expect(startCalls(h)).toHaveLength(7);
    expect(seen.size).toBe(0);
  });

  it("waits while the supervisor is alive or cannot be seen, past the gap", async () => {
    for (const liveness of ["alive", "unknown"] as const) {
      const h = harness(`retry-${liveness}`, { ...RETRYING, liveness });
      h.advance(60 * MINUTE);
      const pass = await reconcile(h.deps);
      expect(pass.attempts, liveness).toEqual([]);
      expect(pass.skipped[0]?.why, liveness).toContain(`supervisor ${liveness}, so the retry waits`);
      expect(startCalls(h), liveness).toEqual([]);
      expect(h.calls.filter((call) => (call.args[0] ?? "").endsWith("push-notification.ts")), liveness).toEqual([]);
    }
  });

  it("starts a fresh schedule from the stop once an iteration finished after the old retries", async () => {
    const h = harness("retry-fresh-uncapped", {
      ...RETRYING,
      stopAt: "2026-10-20T11:58:00.000Z",
      lastIterationEndAt: "2026-10-20T11:00:00.000Z",
    });
    pastRetry(h, "2026-10-20T10:00:00.000Z");
    pastRetry(h, "2026-10-20T10:30:00.000Z");
    const early = await reconcile(h.deps);
    expect(early.attempts).toEqual([]);
    expect(early.skipped[0]?.why).toBe("retry 1 of 7 for no-sigil is due at 2026-10-20T12:03:00.000Z");
    h.advance(3 * MINUTE);
    expect((await reconcile(h.deps)).attempts[0]?.retry).toEqual({ attempt: 1, of: 7, cause: "no-sigil" });
  });

  it("leaves the loop alone when the feed it counts from cannot be read", async () => {
    const h = harness("retry-unreadable", RETRYING);
    const pass = await reconcile({
      ...h.deps,
      records: () => ({ readFeed: () => ({ feed: { state: "unreadable", why: "EACCES" }, readMark: { state: "missing" } }) }),
    });
    expect(pass.attempts).toEqual([]);
    expect(pass.skipped[0]?.why).toContain("retry schedule cannot be counted");
    expect(startCalls(h)).toEqual([]);
  });

  it("honours a shorter schedule: two attempts, then the cap", async () => {
    const h = harness("retry-override", RETRYING);
    const deps: ReconcileDeps = { ...h.deps, retrySchedule: [1, 2] };
    expect((await reconcile(deps)).attempts[0]?.retry).toEqual({ attempt: 1, of: 2, cause: "no-sigil" });
    h.advance(2 * MINUTE - 1_000);
    expect((await reconcile(deps)).attempts).toEqual([]);
    h.advance(1_000);
    expect((await reconcile(deps)).attempts[0]?.retry).toEqual({ attempt: 2, of: 2, cause: "no-sigil" });
    h.advance(60 * MINUTE);
    const capped = await reconcile(deps);
    expect(capped.capped[0]).toMatchObject({ attempts: 2, alerted: true, retry: true });
    expect(raised(h, kinds.retryCapped)[0]?.body).toContain("spent the schedule of 2");
    expect(startCalls(h)).toHaveLength(2);
  });

  it("never spends the dead-supervisor path's attempts, nor lets it spend this path's", async () => {
    // A retry cap in the feed does not hold the restart path's own alert.
    const dead = harness("retry-vs-restart");
    for (const minutes of [50, 40, 30]) dead.pastAttempt(iso(dead.nowMs() - minutes * MINUTE));
    pastRetry(dead, iso(dead.nowMs() - 10 * MINUTE), kinds.retryCapped);
    const restartCapped = await reconcile(dead.deps);
    expect(restartCapped.capped).toEqual([{ loop: "ralph", project: "software-factory", attempts: 3, alerted: true }]);
    expect(raised(dead, kinds.capped)).toHaveLength(1);

    // Restart records and a restart cap neither count toward nor suppress a
    // retry, and the retry path leaves the process's restart memory alone.
    const h = harness("restart-vs-retry", RETRYING);
    for (let i = 0; i < 7; i += 1) h.pastAttempt(iso(h.nowMs() - (i + 1) * MINUTE));
    h.pastAttempt(iso(h.nowMs() - MINUTE / 2), kinds.capped);
    const seen: Seen = new Map();
    const pass = await reconcile({ ...h.deps, seen });
    expect(pass.capped).toEqual([]);
    expect(pass.attempts[0]?.retry).toEqual({ attempt: 1, of: 7, cause: "no-sigil" });
    expect(seen.size).toBe(0);
  });
});

describe("the interval and the bound come from one environment variable each", () => {
  it("has no off switch on the bound: 0 attempts would be the interval's job", () => {
    const lines: string[] = [];
    expect(reconcileConfigFromEnv({ [RECONCILE_ENV.attempts]: "0" }, (line) => lines.push(line)).attempts).toBe(
      DEFAULT_ATTEMPTS,
    );
    expect(lines[0]).not.toContain("switch the reconciler off");
  });

  it("defaults to a minute and three attempts, and reads both when they are set", () => {
    expect(reconcileConfigFromEnv({})).toEqual({
      intervalMs: DEFAULT_RECONCILE_MS,
      attempts: DEFAULT_ATTEMPTS,
      retryScheduleMinutes: [...DEFAULT_RETRY_SCHEDULE_MINUTES],
      migrationAlertSeconds: DEFAULT_MIGRATION_ALERT_SECONDS,
    });
    expect(
      reconcileConfigFromEnv({
        [RECONCILE_ENV.interval]: " 15000 ",
        [RECONCILE_ENV.attempts]: "1",
      }),
    ).toEqual({
      intervalMs: 15_000,
      attempts: 1,
      retryScheduleMinutes: [...DEFAULT_RETRY_SCHEDULE_MINUTES],
      migrationAlertSeconds: DEFAULT_MIGRATION_ALERT_SECONDS,
    });
  });

  it("takes 0 as the off switch, which the server honours by scheduling nothing", () => {
    // A reconciler left on starts loops, so anything that boots a dashboard it
    // does not want supervising — this suite's own HTTP tests among them — has
    // to be able to say no without stopping the service.
    expect(reconcileConfigFromEnv({ [RECONCILE_ENV.interval]: "0" }).intervalMs).toBe(0);
    const main = readFileSync(join(__dirname, "server.ts"), "utf8");
    expect(main).toContain("if (reconciling.intervalMs === 0) {");
    expect(main.slice(main.indexOf("if (reconciling.intervalMs === 0) {"))).toMatch(/reconciler is off/);
    // And the suite's own server boots with it off, or its startup pass would
    // run the real `start.sh` over the fixtures.
    for (const file of ["server.test.ts", "lifecycle-http.test.ts"]) {
      expect(readFileSync(join(__dirname, file), "utf8"), file).toContain(`${RECONCILE_ENV.interval}: "0"`);
    }
  });

  it("falls back loudly rather than letting a typo become a pass per turn", () => {
    // Refusing to start would take the page and every route down with it, so
    // a bad value is a logged fallback, not an exception.
    const lines: string[] = [];
    for (const bad of ["-5", "soon", "1.5", "60s"]) {
      expect(reconcileConfigFromEnv({ [RECONCILE_ENV.interval]: bad }, (line) => lines.push(line)).intervalMs).toBe(
        DEFAULT_RECONCILE_MS,
      );
    }
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("or 0 to switch the reconciler off");
    expect(lines[0]).toContain(RECONCILE_ENV.interval);
  });
});

describe("the retry schedule comes from one environment variable", () => {
  it("defaults to 5, 15 and 45 minutes and then hourly, seven attempts, without a word", () => {
    const lines: string[] = [];
    expect(DEFAULT_RETRY_SCHEDULE_MINUTES).toEqual([5, 15, 45, 60, 60, 60, 60]);
    expect(reconcileConfigFromEnv({}, (line) => lines.push(line)).retryScheduleMinutes).toEqual([5, 15, 45, 60, 60, 60, 60]);
    expect(lines).toEqual([]);
  });

  it("honours an override, whose length is the attempt count", () => {
    expect(reconcileConfigFromEnv({ [RECONCILE_ENV.retrySchedule]: "1,2,3" }).retryScheduleMinutes).toEqual([1, 2, 3]);
  });

  it("falls back to the default schedule, loudly, rather than to no retry at all", () => {
    // A loop that is down in silence is the stuck loop CLAUDE.md forbids, so a
    // typo still retries on the default gaps.
    const bad = ["", "   ", "soon", "-5", "0", "1.5", "5,,15", "5,", "1e1", "0x5", "5,0,15"];
    const lines: string[] = [];
    for (const value of bad) {
      expect(
        reconcileConfigFromEnv({ [RECONCILE_ENV.retrySchedule]: value }, (line) => lines.push(line)).retryScheduleMinutes,
        JSON.stringify(value),
      ).toEqual([...DEFAULT_RETRY_SCHEDULE_MINUTES]);
    }
    expect(lines).toHaveLength(bad.length);
    expect(lines[0]).toContain(RECONCILE_ENV.retrySchedule);
  });
});

describe("a retry's push carries its attempt, the schedule's length and its cause", () => {
  const input = {
    kind: RECONCILE_SURFACE.push.kinds.retried,
    occurrence: "loop-retried:p:ralph:2026-10-20T12:00:00.000Z",
    subject: "s",
    body: "b",
    priority: "normal" as const,
    worktree: "/w/loop",
    loop: "ralph",
    run: "ralph-run-dead",
  };
  /** The argv the push ran, as a recording executor saw it. */
  const pushArgs = async (pushed: PushInput): Promise<string[]> => {
    const recorder = createRecordingExecutor({ fallback: { status: 0, stdout: "", stderr: "" } });
    await createReconcileAdapter({ cliDir: "/h", bunPath: "bun", env: {}, exec: recorder.exec }).push(pushed);
    expect(recorder.calls).toHaveLength(1);
    return recorder.calls[0]!.invocation.args;
  };

  it("appends the three flags only when a retry is given", async () => {
    const without = await pushArgs(input);
    const withRetry = await pushArgs({ ...input, retry: { attempt: 2, of: 7, cause: "secrets-env" } });
    expect(withRetry).toEqual([...without, "--retry-attempt", "2", "--retry-of", "7", "--retry-cause", "secrets-env"]);
    expect(without).toEqual([
      "/h/push-notification.ts",
      "push",
      "--kind",
      "loop-retried",
      "--occurrence",
      input.occurrence,
      "--subject",
      "s",
      "--body",
      "b",
      "--priority",
      "normal",
    ]);
  });
});

describe("the server starts it once", () => {
  const server = readFileSync(join(__dirname, "server.ts"), "utf8");

  it("calls the schedule in main(), with the configured interval and bound", () => {
    // `main()` is not exported and is read rather than driven: what it owes
    // the module is one call, which is the startup pass #329 needs.
    const main = server.slice(server.indexOf("async function main("));
    expect(main.match(/schedule\(/g)).toHaveLength(1);
    // The migration watchdog (#434) rides the same callback, after the pass.
    expect(main).toMatch(/schedule\(\s*async \(\) => \{\s*await composed\.reconcile\(\);\s*await composed\.watchMigrations\(\);/);
    expect(main).toContain("intervalMs: reconciling.intervalMs");
    // The pass itself is the composition's (#624): one per process, so the
    // state below lives as long as the server does.
    const compose = readFileSync(join(__dirname, "compose.ts"), "utf8");
    const body = compose.slice(compose.indexOf("export function composeServer("));
    expect(body).toMatch(/guarded\("reconcile", \(\) =>\s*reconcile\(/);
    expect(body).toContain("attempts: reconciling.attempts");
    // The second ceiling is per process and has to outlive a pass to be one.
    // Built once per composition and handed in, or it would bound nothing —
    // the case it exists for is a loop whose attempt records never get
    // written, and the composition is the only place that can own it.
    expect(body).toMatch(/const reconcileSeen: Seen = new Map\(\);[\s\S]*seen: reconcileSeen,/);
    expect(body.indexOf("const reconcileSeen")).toBeLessThan(body.lastIndexOf("return {"));
  });
});

describe("the migration-applied stall watchdog", () => {
  const ROOT = { loop: "ralph", worktree: "/w/ralph" };
  const APPLIED = "2026-10-22T08:00:00Z";
  const NOW = Date.parse(APPLIED) + 2 * 3_600_000 + 5 * 60_000;
  const PR = { number: 77, title: "db: add the ledger index", url: "https://github.com/o/r/pull/77" };

  interface Fake {
    readonly calls: Invocation[];
    exec: Executor;
    /** What the apply-time read answers; replaced between passes. */
    events: ExecResult;
    list: ExecResult;
  }

  function fake(): Fake {
    // Function answers read `f` at call time, so a test re-scripts a read by replacing it.
    const recorder = createRecordingExecutor({ fallback: { status: 0, stdout: "", stderr: "" } })
      .on({ command: "gh", args: ["pr"] }, () => f.list)
      .on({ command: "gh" }, () => f.events);
    const f: Fake = {
      get calls() {
        return recorder.calls.map((call) => call.invocation);
      },
      events: { status: 0, stdout: `2026-10-21T08:00:00Z\n${APPLIED}\n`, stderr: "" },
      list: { status: 0, stdout: JSON.stringify([PR]), stderr: "" },
      exec: recorder.exec,
    };
    return f;
  }

  // The adapter runs `exec` (the fake's, unless a test swaps it), so it is
  // built per call rather than once for the describe.
  const deps = (f: Fake, { exec = f.exec, ...over }: Partial<MigrationWatchDeps> & { exec?: Executor } = {}): MigrationWatchDeps => ({
    projects: [{ project: "loggd", root: ROOT }],
    adapter: createReconcileAdapter({ cliDir: HARNESS, bunPath: "bun", env: {}, exec }),
    alertSeconds: DEFAULT_MIGRATION_ALERT_SECONDS,
    now: () => NOW,
    ...over,
  });
  const pushes = (f: Fake): Invocation[] => f.calls.filter((c) => c.command === "bun");
  const flag = (call: Invocation | undefined, name: string): string | undefined =>
    call === undefined ? undefined : call.args[call.args.indexOf(name) + 1];

  it("pages once, high, under the fixed run at the root, keyed by the newest apply", async () => {
    const f = fake();
    const pass = await watchMigrations(deps(f));
    expect(pass.alerted).toEqual([{ project: "loggd", pr: 77 }]);
    const [call, ...rest] = pushes(f);
    expect(rest).toEqual([]);
    expect(flag(call, "--kind")).toBe("migration-applied-stalled");
    expect(flag(call, "--priority")).toBe("high");
    expect(flag(call, "--occurrence")).toBe(`migration-applied-stalled:77:${APPLIED}`);
    expect(flag(call, "--subject")).toBe("PR #77 has waited 2h 05m since its migration was applied");
    expect(flag(call, "--body")).toContain(PR.title);
    expect(flag(call, "--body")).toContain(PR.url);
    expect(flag(call, "--body")).toContain(APPLIED);
    expect(call?.cwd).toBe(ROOT.worktree);
    expect(call?.env[RECONCILE_SURFACE.push.env.root]).toBe(ROOT.worktree);
    expect(call?.env[RECONCILE_SURFACE.push.env.loop]).toBe("ralph");
    expect(call?.env[RECONCILE_SURFACE.push.env.run]).toBe(RECONCILE_SURFACE.watchdog.run);
    // Both reads ran in the root checkout, with the PR filled into the events path.
    const reads = f.calls.filter((c) => c.command === "gh");
    expect(reads.map((c) => c.cwd)).toEqual([ROOT.worktree, ROOT.worktree]);
    expect(reads[0]?.args).toEqual([...RECONCILE_SURFACE.gh.list]);
    expect(reads[1]?.args).toContain("repos/{owner}/{repo}/issues/77/events");
    expect(reads[1]?.args).not.toContain("--slurp");
  });

  it("lists open PRs only, so a merged or closed one never pages", async () => {
    // The list is the only filter on a PR's state: nothing downstream reads
    // whether a PR merged, so dropping `--state open` would page merged ones.
    const recorder = createRecordingExecutor({ fallback: { status: 0, stdout: "[]", stderr: "" } });
    await createReconcileAdapter({ cliDir: "/h", bunPath: "bun", env: {}, exec: recorder.exec }).listMigrations("/w/ralph");
    expect(recorder.calls).toHaveLength(1);
    const list = recorder.calls[0]!.invocation;
    expect(list.args.join(" ")).toContain("--state open");
    expect(list.args.join(" ")).toContain("--label migration-applied");
  });

  it("stays quiet inside the threshold", async () => {
    const f = fake();
    const pass = await watchMigrations(deps(f, { now: () => Date.parse(APPLIED) + 3_599_000 }));
    expect(pass.alerted).toEqual([]);
    expect(pushes(f)).toEqual([]);
  });

  it("spawns one push across passes in one process, and the same push after a restart", async () => {
    const f = fake();
    const pushed = new Set<string>();
    await watchMigrations(deps(f, { pushed }));
    await watchMigrations(deps(f, { pushed }));
    expect(pushes(f)).toHaveLength(1);
    // A restarted dashboard has a fresh set: it pushes again, but the very same
    // run, root and occurrence, which push-notification's own record dedupes.
    const g = fake();
    await watchMigrations(deps(g, { pushed: new Set() }));
    expect(pushes(g)).toEqual(pushes(f));
  });

  it("does not remember a push that failed, so the next tick tries again", async () => {
    let fail = true;
    const f = fake();
    const inner = f.exec;
    const exec: Executor = (invocation) =>
      invocation.command === "bun" && fail ? Promise.resolve({ status: 1, stdout: "", stderr: "disk full" }) : inner(invocation);
    const pushed = new Set<string>();
    const lines: string[] = [];
    await watchMigrations(deps(f, { exec, pushed, log: (line) => lines.push(line) }));
    expect(pushed.size).toBe(0);
    expect(lines.join("\n")).toContain("was not recorded");
    fail = false;
    await watchMigrations(deps(f, { exec, pushed }));
    expect(pushed.size).toBe(1);
  });

  it("reads once per project, however many loops it has", async () => {
    const f = fake();
    const loops = [
      { identity: "rafa", worktree: "/w/a-rafa" },
      { identity: "ralph", worktree: "/w/ralph" },
      { identity: null, worktree: "/w/0-orphan" },
    ];
    await watchMigrations(deps(f, { projects: [{ project: "loggd", root: watchRoot(loops, ["ralph", "rafa", "tria"]) }] }));
    expect(f.calls.filter((c) => c.command === "gh" && c.args[0] === "pr")).toHaveLength(1);
    expect(pushes(f)).toHaveLength(1);
    expect(pushes(f)[0]?.cwd).toBe("/w/ralph");
  });

  it("roots a project at its roster's first loop, stably", () => {
    const loops = [
      { identity: "tria", worktree: "/w/c" },
      { identity: "stray", worktree: "/w/a" },
      { identity: "rafa", worktree: "/w/b" },
      { identity: null, worktree: "/w/0" },
    ];
    expect(watchRoot(loops, ["rafa", "tria"])).toEqual({ loop: "rafa", worktree: "/w/b" });
    expect(watchRoot([...loops].reverse(), ["rafa", "tria"])).toEqual({ loop: "rafa", worktree: "/w/b" });
    // Unrostered loops come after the rostered ones; no roster falls to the path.
    expect(watchRoot(loops.filter((l) => l.identity !== "rafa" && l.identity !== "tria"), ["rafa"])).toEqual({
      loop: "stray",
      worktree: "/w/a",
    });
    expect(watchRoot(loops, [])).toEqual({ loop: "stray", worktree: "/w/a" });
    expect(watchRoot([{ identity: null, worktree: "/w/0" }], ["rafa"])).toBeNull();
    expect(watchRoot([], [])).toBeNull();
  });

  it("skips a project with no root", async () => {
    const f = fake();
    const pass = await watchMigrations(deps(f, { projects: [{ project: "loggd", root: null }] }));
    expect(f.calls).toEqual([]);
    expect(pass.skipped).toHaveLength(1);
  });

  it("logs an unreadable apply time, pushes nothing, and pages on the next readable tick", async () => {
    for (const events of [
      { status: 1, stdout: "", stderr: "HTTP 502" },
      { status: 0, stdout: "\n", stderr: "" },
      { status: 0, stdout: "not a date\n", stderr: "" },
    ]) {
      const f = fake();
      f.events = events;
      const lines: string[] = [];
      const pass = await watchMigrations(deps(f, { log: (line) => lines.push(line) }));
      expect(pushes(f)).toEqual([]);
      expect(pass.skipped).toEqual([{ project: "loggd", pr: 77, why: "apply time unreadable, retrying next tick" }]);
      expect(lines.join("\n")).toContain("apply time unreadable, retrying next tick");
      f.events = { status: 0, stdout: `${APPLIED}\n`, stderr: "" };
      await watchMigrations(deps(f));
      expect(pushes(f)).toHaveLength(1);
    }
  });

  it("survives a list that fails or does not parse, and still reads the next project", async () => {
    for (const list of [
      { status: 1, stdout: "", stderr: "gh: not logged in" },
      { status: 0, stdout: "<html>", stderr: "" },
    ]) {
      const f = fake();
      let first = true;
      const inner = f.exec;
      const exec: Executor = (invocation) => {
        if (invocation.command === "gh" && invocation.args[0] === "pr" && first) {
          first = false;
          return Promise.resolve(list);
        }
        return inner(invocation);
      };
      const lines: string[] = [];
      const pass = await watchMigrations(
        deps(f, {
          exec,
          projects: [
            { project: "broken", root: { loop: "rita", worktree: "/w/broken" } },
            { project: "loggd", root: ROOT },
          ],
          log: (line) => lines.push(line),
        }),
      );
      expect(pass.skipped[0]).toMatchObject({ project: "broken", pr: null });
      expect(lines[0]).toContain("broken");
      expect(pass.alerted).toEqual([{ project: "loggd", pr: 77 }]);
    }
  });

  it("survives an executor that throws", async () => {
    const pass = await watchMigrations(deps(fake(), { exec: () => Promise.reject(new Error("spawn ENOENT")) }));
    expect(pass.skipped).toHaveLength(1);
  });

  it("defaults to an hour, honours the variable, and falls back loudly on garbage or 0", () => {
    expect(DEFAULT_MIGRATION_ALERT_SECONDS).toBe(3600);
    expect(reconcileConfigFromEnv({ [RECONCILE_ENV.migrationAlert]: "900" }).migrationAlertSeconds).toBe(900);
    const lines: string[] = [];
    for (const bad of ["0", "-1", "soon", "1.5"]) {
      expect(
        reconcileConfigFromEnv({ [RECONCILE_ENV.migrationAlert]: bad }, (line) => lines.push(line)).migrationAlertSeconds,
      ).toBe(DEFAULT_MIGRATION_ALERT_SECONDS);
    }
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain(RECONCILE_ENV.migrationAlert);
    expect(lines[0]).not.toContain("switch the reconciler off");
  });
});

describe("retryView", () => {
  // Pure: the feed, the bound and the schedule are all it reads, so every
  // case is a fixture and none needs a clock.
  const T = "2026-10-20T12:00:00.000Z";
  const at = (minutes: number): string => new Date(Date.parse(T) + minutes * 60_000).toISOString();
  let next = 0;
  const row = (when: string, retry: unknown, kind: string = RECONCILE_SURFACE.push.kinds.retried): Record<string, unknown> => ({
    version: 1,
    event: "raised",
    id: `${kind}:p:ralph:${when}:${String((next += 1))}`,
    at: when,
    loop: "ralph",
    kind,
    retry,
  });
  const feedOf = (...rows: Record<string, unknown>[]): RawFile => ({
    state: "read",
    text: `${rows.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  });
  const retry = (attempt: unknown, of: unknown = 3, cause: unknown = "no-sigil") => ({ attempt, of, cause });

  it("reads a mid-schedule record: its attempt, of and cause, and the next gap from its time", () => {
    const feed = feedOf(row(at(-5), retry(1)), row(T, retry(2)));
    expect(retryView(feed, null, [5, 10, 20])).toEqual({ attempt: 2, of: 3, cause: "no-sigil", nextAt: at(20), spent: false });
  });

  it("takes the gap from the schedule it is passed", () => {
    const feed = feedOf(row(T, retry(2)));
    expect(retryView(feed, null, [1, 2, 45])?.nextAt).toBe(at(45));
  });

  it("is spent with no next time on the schedule's last attempt", () => {
    expect(retryView(feedOf(row(T, retry(3))), null, [5, 10, 20])).toEqual({
      attempt: 3,
      of: 3,
      cause: "no-sigil",
      nextAt: null,
      spent: true,
    });
  });

  it("is spent when the schedule is shorter than the attempt", () => {
    expect(retryView(feedOf(row(T, retry(4, 7))), null, [5, 10])).toMatchObject({ attempt: 4, of: 7, nextAt: null, spent: true });
  });

  it("computes a next time from a longer schedule and still reports the record's of", () => {
    expect(retryView(feedOf(row(T, retry(3, 3))), null, [5, 10, 20, 40])).toEqual({
      attempt: 3,
      of: 3,
      cause: "no-sigil",
      nextAt: at(40),
      spent: false,
    });
  });

  it("takes the attempt from the newest record, not from a count of them", () => {
    const feed = feedOf(row(T, retry(5, 7, "usage-limit")), row(at(-30), retry(1, 7)));
    expect(retryView(feed, null, [5, 10, 20, 40, 60, 90, 120])).toEqual({
      attempt: 5,
      of: 7,
      cause: "usage-limit",
      nextAt: at(90),
      spent: false,
    });
  });

  it("drops every record at or before the last finished iteration", () => {
    const feed = feedOf(row(at(-10), retry(1)), row(T, retry(2)));
    expect(retryView(feed, T, [5, 10, 20])).toBeNull();
    expect(retryView(feed, at(-10), [5, 10, 20])?.attempt).toBe(2);
  });

  it("keeps every record when there is no finished iteration to bound them", () => {
    const feed = feedOf(row(at(-10), retry(1)), row(T, retry(2)));
    expect(retryView(feed, undefined, [5, 10, 20])?.attempt).toBe(2);
    expect(retryView(feed, "not a time", [5, 10, 20])?.attempt).toBe(2);
  });

  it("skips a malformed record, and is null when none is left", () => {
    const malformed = [
      row(at(1), undefined),
      row(at(2), retry(0)),
      row(at(3), retry(1.5)),
      row(at(4), retry(2, 3, 7)),
      row(at(5), retry(2, 3, "")),
      row(at(6), retry(2, 0)),
      row("whenever", retry(2)),
    ];
    expect(retryView(feedOf(row(T, retry(1)), ...malformed), null, [5, 10, 20])).toEqual({
      attempt: 1,
      of: 3,
      cause: "no-sigil",
      nextAt: at(10),
      spent: false,
    });
    expect(retryView(feedOf(...malformed), null, [5, 10, 20])).toBeNull();
  });

  it("is null with no loop-retried record, and for an unreadable feed", () => {
    const other = feedOf(row(T, retry(2), RECONCILE_SURFACE.push.kinds.retryCapped), row(T, retry(2), "loop-restarted"));
    expect(retryView(other, null, [5, 10, 20])).toBeNull();
    expect(retryView({ state: "missing" }, null, [5, 10, 20])).toBeNull();
    expect(retryView({ state: "unreadable", why: "EACCES" }, null, [5, 10, 20])).toBeNull();
  });
});
