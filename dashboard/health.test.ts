// @vitest-environment node
/**
 * Project health, the pure fold and the read around it, and the cache that
 * keeps another project's reads to one per TTL. The HTTP suite proves the
 * same read over a real two-project scratch machine makes no `gh` call.
 */
import { describe, expect, it, vi } from "vitest";

import { coderRoster } from "./contracts";
import type { LocalSnapshot, LoopStatus } from "./contracts";
import type { ControlStatusRead, ControlStatusView } from "./control-adapter";
import { cachedRead, needsYouFor, problemKindOf, projectHealth, readProjectHealth, type HealthLoop } from "./health";
import { accountPlan } from "./usage";

const AT = "2026-09-23T12:00:00.000Z";

const record = (hold: ControlStatusView["hold"] = null): ControlStatusRead => ({
  kind: "record",
  record: { ralphRun: "run-1", loop: "ralph", hold, gates: [], stop: null, applied: [], deferrals: [], degraded: null, gateQuestion: null, givenUp: [] },
});
const approval = record({ kind: "approval", why: "decision gate g1: ship it?", since: AT, gate: "g1" });
const pause = record({ kind: "pause", why: "paused", since: AT, gate: null });
const loop = (name: string, loopStatus: LoopStatus, control: ControlStatusRead = { kind: "none" }): HealthLoop => ({
  loop: name,
  loopStatus,
  control,
  supervisor: "alive",
  stage: null,
  lastEvent: null,
});

describe("what needs the operator", () => {
  it("is an approval hold, an errored stop, or a block", () => {
    expect(needsYouFor(loop("ralph", "blocked", approval))).toBe("approval");
    expect(needsYouFor(loop("ralph", "failed"))).toBe("errored");
    expect(needsYouFor(loop("ralph", "blocked"))).toBe("blocked");
  });

  it("is not the operator's own pause, nor a loop at work, idle, done or stopped now", () => {
    expect(needsYouFor(loop("ralph", "blocked", pause))).toBeNull();
    for (const status of ["running", "idle", "completed", "interrupted", "stale"] as const) {
      expect(needsYouFor(loop("ralph", status))).toBeNull();
    }
  });
});

describe("a project's health", () => {
  it("needs you when any loop does, counting each loop once", () => {
    const view = projectHealth(
      "widgets",
      [loop("ralph", "blocked", approval), loop("rafa", "failed"), loop("remo", "running"), loop("rulo", "stale")],
      AT,
    );
    expect(view).toEqual({
      project: "widgets",
      readAt: AT,
      health: "needs-you",
      needsYou: 2,
      needs: [
        { loop: "ralph", reason: "approval" },
        { loop: "rafa", reason: "errored" },
      ],
      loops: 4,
      running: 1,
      agents: [
        { loop: "ralph", loopStatus: "blocked", supervisor: "alive", stage: null, lastEvent: null },
        { loop: "rafa", loopStatus: "failed", supervisor: "alive", stage: null, lastEvent: null },
        { loop: "remo", loopStatus: "running", supervisor: "alive", stage: null, lastEvent: null },
        { loop: "rulo", loopStatus: "stale", supervisor: "alive", stage: null, lastEvent: null },
      ],
      problem: null,
    });
  });

  it("is degraded when a loop cannot be vouched for, or its controls cannot be read", () => {
    expect(projectHealth("w", [loop("ralph", "running"), loop("rafa", "stale")], AT).health).toBe("degraded");
    expect(projectHealth("w", [loop("ralph", "unknown")], AT).health).toBe("degraded");
    expect(projectHealth("w", [loop("ralph", "running", { kind: "unreadable", why: "boom" })], AT).health).toBe("degraded");
  });

  it("is running when a loop works, and idle otherwise", () => {
    expect(projectHealth("w", [loop("ralph", "running"), loop("rafa", "idle")], AT)).toMatchObject({ health: "running", running: 1 });
    expect(projectHealth("w", [loop("ralph", "idle"), loop("rafa", "blocked", pause)], AT).health).toBe("idle");
    expect(projectHealth("w", [], AT)).toMatchObject({ health: "idle", loops: 0, needsYou: 0 });
  });
});

describe("reading a project's health", () => {
  const local = (loops: LocalSnapshot["loops"]): (() => Promise<LocalSnapshot>) => async () => ({ roster: coderRoster("ralph", "rafa"), loops });
  const entry = (worktree: string, identity: string | null, over: Partial<LocalSnapshot["loops"][number]> = {}) => ({
    worktree,
    identity,
    loopStatus: "running" as LoopStatus,
    worktreeStatus: "live" as const,
    state: null,
    supervisor: "alive" as const,
    ...over,
  });

  it("reads the control record of each roster checkout only", async () => {
    const controlStatus = vi.fn(async (worktree: string) => (worktree === "/w/ralph" ? approval : record()));
    const view = await readProjectHealth({
      project: "widgets",
      local: local([
        entry("/w/main", null),
        entry("/w/ralph", "ralph", { loopStatus: "blocked" }),
        entry("/w/rafa", "rafa"),
        entry("/w/gone", "rafa", { worktreeStatus: "orphaned", loopStatus: "orphaned" }),
      ]),
      controlStatus,
      now: () => Date.parse(AT),
    });
    expect(controlStatus.mock.calls.map(([worktree]) => worktree)).toEqual(["/w/ralph", "/w/rafa"]);
    expect(view).toMatchObject({ health: "needs-you", needsYou: 1, loops: 2, running: 1, readAt: AT });
    // The rail's marks carry each loop's liveness, stage and last event from its record.
    expect(view.agents).toEqual([
      { loop: "ralph", loopStatus: "blocked", supervisor: "alive", stage: null, lastEvent: null },
      { loop: "rafa", loopStatus: "running", supervisor: "alive", stage: null, lastEvent: null },
    ]);
  });

  it("is unknown, with the reason, when the project cannot be read at all", async () => {
    const view = await readProjectHealth({
      project: "widgets",
      local: async () => {
        throw new Error("roster contract drift: no config");
      },
      controlStatus: async () => ({ kind: "none" }),
      now: () => Date.parse(AT),
    });
    expect(view).toEqual({
      project: "widgets",
      readAt: AT,
      health: "unknown",
      needsYou: 0,
      needs: [],
      loops: 0,
      running: 0,
      problem: "roster contract drift: no config",
      problemKind: "unreadable",
    });
  });

  it("says which kind of unreadable a project is, from the reason its read gave", () => {
    expect(
      problemKindOf(
        "roster contract drift: cannot read the project config at /p/usagebar: project-config: cannot read " +
          "/p/usagebar/.ralph/config.json (ENOENT); a project opts in to the harness by committing .ralph/config.json",
      ),
    ).toBe("not-set-up");
    expect(problemKindOf("roster contract drift: the project folder /p/gone does not exist")).toBe("missing");
    expect(problemKindOf("project-config: /p/w/.ralph/config.json is invalid:\n  - loops must be an array")).toBe(
      "invalid-config",
    );
    expect(problemKindOf("project-config: /p/w/.ralph/config.json is not valid JSON: Unexpected token")).toBe(
      "invalid-config",
    );
    expect(problemKindOf("loop-state unavailable: timed out")).toBe("unreadable");
  });

  it("degrades a control read that throws rather than failing the project", async () => {
    const view = await readProjectHealth({
      project: "widgets",
      local: local([entry("/w/ralph", "ralph")]),
      controlStatus: async () => {
        throw new Error("spawn failed");
      },
    });
    expect(view.health).toBe("degraded");
  });
});

describe("a cached read", () => {
  it("serves one read per TTL, shares one in flight, and retries after a failure", async () => {
    let nowMs = 0;
    let calls = 0;
    let fail = false;
    const read = cachedRead(
      async () => {
        calls += 1;
        if (fail) throw new Error("boom");
        return calls;
      },
      30_000,
      () => nowMs,
    );
    expect(await Promise.all([read(), read()])).toEqual([1, 1]);
    nowMs = 29_999;
    expect(await read()).toBe(1);
    nowMs = 30_000;
    fail = true;
    await expect(read()).rejects.toThrow("boom");
    fail = false;
    expect(await read()).toBe(3);
    expect(calls).toBe(3);
  });

  it("serves a primed value for a fresh TTL, over a read already in flight", async () => {
    let nowMs = 0;
    let release = (_value: number): void => undefined;
    const read = cachedRead(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
      30_000,
      () => nowMs,
    );
    const stale = read();
    nowMs = 10_000;
    read.prime(7);
    release(1);
    expect(await stale).toBe(1);
    expect(await read()).toBe(7);
    nowMs = 39_999;
    expect(await read()).toBe(7);
  });
});

describe("the account's plan across projects", () => {
  const plan = (at: string, windowsAt: string | null, utilization: number) => ({
    at,
    loop: "ralph",
    status: "allowed",
    limitingWindow: null,
    usingOverage: false,
    windowsAt,
    fiveHour: windowsAt === null ? null : { utilization, resetsAt: null, lapsed: false },
    sevenDay: null,
  });

  it("is the newest status any project reported, with the newest window figures", () => {
    const account = accountPlan([
      { project: "loggd", plan: plan("2026-09-23T10:00:00.000Z", "2026-09-23T10:00:00.000Z", 0.4) },
      { project: "widgets", plan: { ...plan("2026-09-23T11:00:00.000Z", null, 0), status: "allowed_warning" } },
      { project: "gadgets", plan: null },
    ]);
    expect(account).toMatchObject({
      project: "widgets",
      status: "allowed_warning",
      at: "2026-09-23T11:00:00.000Z",
      windowsAt: "2026-09-23T10:00:00.000Z",
      fiveHour: { utilization: 0.4 },
    });
  });

  it("is none when no project has a reading", () => {
    expect(accountPlan([{ project: "loggd", plan: null }])).toBeNull();
    expect(accountPlan([])).toBeNull();
  });
});
