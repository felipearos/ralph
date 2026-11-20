// @vitest-environment node
/**
 * Stop now's sequence, over a scripted target.
 *
 * The adapter is a fake that answers the checks and the process table as a
 * script says and records every signal and audit entry, in order, beside the
 * subprocesses the real control adapter builds. That is what lets the order
 * be asserted exactly: nothing is signalled after a failed check, each signal
 * is recorded before it is sent, SIGKILL only follows a SIGTERM that did not
 * end the group, and the loop's record is written only once the supervisor is
 * gone. The real processes are `interrupt-adapter.test.ts` and
 * `interrupt-channel.test.ts`.
 */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { InterruptCheck } from "./contracts";
import { createRalphControlAdapter, type ExecResult, type Invocation } from "./control-adapter";
import type { InspectedTarget, InterruptAdapter, SignalAuditEntry } from "./interrupt-adapter";
import { stopNow, type InterruptDeps } from "./interrupt";

const roots: string[] = [];
afterAll(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const PASSED: InterruptCheck[] = [
  { check: "pid-file", ok: true, detail: "names pid 4242" },
  { check: "alive", ok: true, detail: "running" },
  { check: "ralph.sh", ok: true, detail: "bash ralph.sh 50" },
  { check: "cwd", ok: true, detail: "this checkout" },
  { check: "group", ok: true, detail: "led by its start.sh wrapper" },
];

type Step = { kind: "audit"; entry: SignalAuditEntry } | { kind: "signal"; signal: string; group: number } | { kind: "exec"; invocation: Invocation };

interface Harness {
  deps: InterruptDeps;
  steps: Step[];
  /** The target the checks report. */
  target: InspectedTarget;
  /** What is left after the signals sent so far. */
  left: (sent: string[]) => { supervisor: boolean; group: boolean; ours: boolean };
  record: ExecResult;
  auditFails: boolean;
  inspected: () => number;
}

function harness(label: string): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `ralph-stop-now-${label}-`)));
  roots.push(root);
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  writeFileSync(
    join(root, ".ralph", "logs", "state.json"),
    JSON.stringify({ version: 1, run: "run-1", owner: { loop: "ralph", pid: 4242, host: "t" }, worktree: root }),
  );
  let inspections = 0;
  const h: Harness = {
    steps: [],
    target: { pidFile: ".ralph/logs/supervisor.pid", pid: 4242, group: 4241, checks: PASSED, ok: true },
    left: (sent) =>
      sent.length === 0 ? { supervisor: true, group: true, ours: true } : { supervisor: false, group: false, ours: true },
    record: {
      status: 0,
      stdout: JSON.stringify({
        stop: { kind: "interrupted", confirmation: "confirmed", why: "w", at: "T", key: "now-1", iteration: 7, issue: 49 },
      }),
      stderr: "",
    },
    auditFails: false,
    inspected: () => inspections,
    deps: undefined as unknown as InterruptDeps,
  };
  const sent = (): string[] => h.steps.flatMap((step) => (step.kind === "signal" ? [step.signal] : []));
  const interrupt: InterruptAdapter = {
    worktree: root,
    inspect: () => {
      inspections += 1;
      return h.target;
    },
    signal: (group, signal) => {
      h.steps.push({ kind: "signal", signal, group });
      return null;
    },
    remaining: () => h.left(sent()),
    audit: (entry) => {
      if (h.auditFails) return "could not append: EROFS";
      h.steps.push({ kind: "audit", entry });
      return null;
    },
  };
  let clock = Date.parse("2026-09-22T12:00:00.000Z");
  h.deps = {
    interrupt,
    control: createRalphControlAdapter({
      cliDir: "/harness",
      root,
      bunPath: "bun",
      env: {},
      exec: async (invocation) => {
        h.steps.push({ kind: "exec", invocation });
        return h.record;
      },
    }),
    loop: "ralph",
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
    termGraceMs: 10_000,
    killGraceMs: 5_000,
    pollIntervalMs: 1_000,
  };
  return h;
}

const shape = (h: Harness): string[] =>
  h.steps.map((step) =>
    step.kind === "audit"
      ? `audit:${step.entry.event}${step.entry.signal ? `:${step.entry.signal}` : ""}`
      : step.kind === "signal"
        ? `signal:${step.signal}:${step.group}`
        : "exec",
  );

describe("stop now", () => {
  it("records, signals the group, waits for it to go, and has the loop record a confirmed interrupted stop", async () => {
    const h = harness("ok");
    const result = await stopNow(h.deps, { loop: "ralph", id: "now-1", why: "held a turn for an hour" });

    expect(shape(h)).toEqual(["audit:signal:SIGTERM", "signal:SIGTERM:4241", "exec", "audit:outcome:SIGTERM"]);
    expect(result).toMatchObject({
      action: "stop-now",
      outcome: "interrupted",
      run: "run-1",
      key: "now-1",
      signals: ["SIGTERM"],
      recorded: true,
      stop: { kind: "interrupted", confirmation: "confirmed", iteration: 7, issue: 49 },
      target: { pid: 4242, group: 4241 },
      audit: ".ralph/control/signals.jsonl",
    });
    expect(result.checks).toEqual(PASSED);
    expect(result.why).toContain("#49 stays claimed");

    // The loop's own record, as the run on record, under the supervisor lock, with no plugin.
    const record = h.steps.find((step) => step.kind === "exec")!;
    if (record.kind !== "exec") throw new Error("unreachable");
    expect(record.invocation.command).toBe("flock");
    expect(record.invocation.args.slice(0, 4)).toEqual(["-n", "-E", "75", join(h.deps.interrupt.worktree, ".ralph/logs/supervisor.lock")]);
    expect(record.invocation.args.slice(5)).toEqual(["/harness/controls.ts", "interrupted", "--key", "now-1", "--why", "held a turn for an hour"]);
    expect(record.invocation.env).toMatchObject({ RALPH_RUN_ID: "run-1", RALPH_LOOP_NAME: "ralph", RALPH_PLUGINS: "" });

    // Every audit line carries the target, the checks and the operator's reason.
    for (const step of h.steps) {
      if (step.kind !== "audit") continue;
      expect(step.entry).toMatchObject({ id: "now-1", loop: "ralph", run: "run-1", reason: "held a turn for an hour", checks: PASSED });
      expect(step.entry.target).toEqual({ pidFile: ".ralph/logs/supervisor.pid", pid: 4242, group: 4241 });
    }
  });

  it("sends SIGKILL only when SIGTERM did not end the group", async () => {
    const h = harness("kill");
    // The supervisor went on SIGTERM; a child in its group ignored it.
    h.left = (sent) =>
      sent.includes("SIGKILL") ? { supervisor: false, group: false, ours: true } : { supervisor: false, group: true, ours: true };
    const result = await stopNow(h.deps, { loop: "ralph", id: "now-1" });
    expect(shape(h)).toEqual([
      "audit:signal:SIGTERM",
      "signal:SIGTERM:4241",
      "audit:signal:SIGKILL",
      "signal:SIGKILL:4241",
      "exec",
      "audit:outcome:SIGKILL",
    ]);
    expect(result).toMatchObject({ outcome: "interrupted", signals: ["SIGTERM", "SIGKILL"] });
  });

  it("never sends SIGKILL to a group it can no longer prove is the loop's", async () => {
    // The group number may have been reused (the pid counter came round), so
    // its remaining members are reported, not killed.
    const h = harness("unproven");
    h.left = (sent) =>
      sent.length === 0 ? { supervisor: true, group: true, ours: true } : { supervisor: false, group: true, ours: false };
    const result = await stopNow(h.deps, { loop: "ralph", id: "now-1" });
    expect(shape(h)).toEqual(["audit:signal:SIGTERM", "signal:SIGTERM:4241", "exec", "audit:outcome:SIGTERM"]);
    expect(result).toMatchObject({ outcome: "interrupted", signals: ["SIGTERM"] });
    expect(result.why).toContain("left running because the group number can no longer be shown");
  });

  it("reports a supervisor that survives SIGKILL, and records no stop for it", async () => {
    const h = harness("survived");
    h.left = () => ({ supervisor: true, group: true, ours: true });
    const result = await stopNow(h.deps, { loop: "ralph", id: "now-1" });
    expect(result).toMatchObject({ outcome: "survived", recorded: false, stop: null, signals: ["SIGTERM", "SIGKILL"] });
    expect(shape(h)).not.toContain("exec");
    expect(shape(h).at(-1)).toBe("audit:outcome:SIGKILL");
  });

  it.each([
    ["alive", "pid 4242 is not running"],
    ["ralph.sh", "pid 4242 is running 'vim notes.md', not ralph.sh"],
    ["cwd", "pid 4242 is working in /home/other, not this checkout"],
  ] as const)("refuses a target whose %s check fails, naming it, and sends nothing", async (check, detail) => {
    const h = harness(`refused-${check}`);
    const at = PASSED.findIndex((row) => row.check === check);
    h.target = { ...h.target, ok: false, checks: [...PASSED.slice(0, at), { check, ok: false, detail }] };
    const result = await stopNow(h.deps, { loop: "ralph", id: "now-1", why: "w" });
    expect(result.outcome).toBe("refused");
    expect(result.why).toContain(detail);
    expect(result.signals).toEqual([]);
    expect(shape(h)).toEqual(["audit:refused"]);
    const [entry] = h.steps;
    expect(entry).toMatchObject({ kind: "audit", entry: { outcome: "refused", checks: h.target.checks } });
  });

  it("sends no signal it could not record first", async () => {
    const h = harness("unaudited");
    h.auditFails = true;
    const result = await stopNow(h.deps, { loop: "ralph", id: "now-1" });
    expect(result.outcome).toBe("refused");
    expect(result.why).toContain("could not be recorded");
    expect(h.steps.filter((step) => step.kind === "signal")).toEqual([]);
  });

  it("refuses a request naming a replaced run without looking at, or signalling, anything", async () => {
    const h = harness("stale-run");
    const result = await stopNow(h.deps, { loop: "ralph", id: "now-1", run: "run-0" });
    expect(result.outcome).toBe("needs-reconfirmation");
    expect(result.why).toContain("run-1");
    expect(h.inspected()).toBe(0);
    expect(shape(h)).toEqual(["audit:refused"]);
    expect(h.steps[0]).toMatchObject({ kind: "audit", entry: { outcome: "needs-reconfirmation", run: "run-0", checks: [] } });
  });

  it("says the loop was interrupted but not recorded when a supervisor holds the lock again", async () => {
    const h = harness("busy");
    h.record = { status: 75, stdout: "", stderr: "" };
    const result = await stopNow(h.deps, { loop: "ralph", id: "now-1" });
    expect(result).toMatchObject({ outcome: "interrupted", recorded: false, stop: null });
    expect(result.why).toContain("not recorded");
  });

  it("does not act for a loop it does not serve", async () => {
    const h = harness("other");
    expect((await stopNow(h.deps, { loop: "rafa" })).outcome).toBe("not-for-this-loop");
    expect(h.inspected()).toBe(0);
  });
});
