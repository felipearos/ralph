// @vitest-environment node
/**
 * The per-loop control view: what the control record and the durable loop
 * state already know, selected for one panel.
 *
 * Every control record here goes through the adapter's own narrowing
 * (`parseControlStatus`) rather than being handed to the projection as a typed
 * literal, so the cases exercise the `controls status --json` shape the
 * CLI actually prints. The properties are about honesty: a hold is shown with
 * its why and gate, a recorded outcome keeps its timestamp, a deferral keeps
 * its attempts and a given-up command its remedy — and a degraded or
 * unreachable channel is shown as degraded, never as a hold or a stop.
 */
import { describe, expect, it } from "vitest";

import { coderRoster } from "./contracts";
import type { Clock, LoopStateView, RuntimeLoop, RuntimeSnapshot } from "./contracts";
import {
  createRalphControlAdapter,
  parseControlStatus,
  type ControlStatusRead,
  type Executor,
} from "./control-adapter";
import {
  composeControlView,
  composeControlViews,
  projectControlView,
  readControlStatus,
  RECENT_COMMAND_LIMIT,
} from "./control-view";
import { createRecordingExecutor } from "./recording-executor";

const clock: Clock = { nowMs: Date.parse("2026-09-15T12:00:00.000Z") };

const state = (over: Partial<LoopStateView> = {}): LoopStateView => ({
  version: 1,
  run: "run-1",
  owner: { loop: "ralph", pid: 4242, host: "desktop" },
  worktree: "/checkout/ralph",
  branch: "ralph/15",
  stage: "iteration",
  iteration: { index: 2, max: 50 },
  heartbeat: "2026-09-15T11:59:00.000Z",
  lastEvent: { name: "iteration-start", at: "2026-09-15T11:59:00.000Z" },
  stopReason: null,
  ...over,
});

const loop = (over: Partial<RuntimeLoop> = {}): RuntimeLoop => ({
  worktree: "/checkout/ralph",
  identity: "ralph",
  loopStatus: "running",
  worktreeStatus: "live",
  branch: "ralph/15",
  state: state(),
  stateProblem: null,
  supervisor: "alive",
  presence: null,
  ...over,
});

/** A record in the shape `controls.ts status --json` prints. */
const record = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  ralphRun: "run-1",
  loop: "ralph",
  ownerChangedAt: null,
  applied: [],
  hold: null,
  stop: null,
  retries: [],
  abandoned: [],
  released: [],
  deferrals: [],
  degraded: null,
  lastPolledAt: "2026-09-15T11:59:30.000Z",
  ...over,
});

const read = (raw: unknown): ControlStatusRead =>
  parseControlStatus({ status: 0, stdout: JSON.stringify(raw), stderr: "" });

const GIVEN_UP_WHY =
  "abandon was waiting from 2026-09-15T09:00:00.000Z and has been given up after 5 attempts — the lease store is locked. The lease store's lock may have been left behind by a process that died: check next-tasks-claim.lock in the Git common directory, then issue the command again.";

describe("narrowing `controls status --json`", () => {
  it("reads `null` as a loop with no record yet, not as a failure", () => {
    expect(parseControlStatus({ status: 0, stdout: "null\n", stderr: "" })).toEqual({ kind: "none" });
  });

  it("reads a failed or malformed status as unreadable, with the reason", () => {
    expect(parseControlStatus({ status: 1, stdout: "", stderr: "controls: boom\n" })).toEqual({
      kind: "unreadable",
      why: "controls: boom",
    });
    expect(parseControlStatus({ status: 0, stdout: "{not json", stderr: "" })).toMatchObject({
      kind: "unreadable",
    });
    expect(parseControlStatus({ status: 0, stdout: '{"version":2}', stderr: "" })).toMatchObject({
      kind: "unreadable",
    });
  });

  it("carries the degraded window, the gate question and the given-up commands", () => {
    const parsed = read(
      record({
        hold: { kind: "approval", why: "decision gate g1: ship it?", since: "T1", key: null, gate: "g1" },
        applied: [{ key: "ab-1", command: "abandon", at: "T2", outcome: "refused", why: GIVEN_UP_WHY }],
        degraded: { why: "orca unreachable", at: "T3", retryAt: "T4" },
      }),
    );
    expect(parsed.kind).toBe("record");
    if (parsed.kind !== "record") return;
    expect(parsed.record.degraded).toEqual({ why: "orca unreachable", at: "T3", retryAt: "T4" });
    expect(parsed.record.gateQuestion).toBe("ship it?");
    expect(parsed.record.givenUp).toEqual([
      { key: "ab-1", command: "abandon", at: "T2", attempts: 5, remedy: GIVEN_UP_WHY },
    ]);
  });
});

describe("selecting the hold", () => {
  it("shows an operator pause with its why", () => {
    const view = projectControlView(
      "ralph",
      loop({ loopStatus: "blocked", state: state({ stage: "paused" }) }),
      read(record({ hold: { kind: "pause", why: "triage", since: "2026-09-15T11:00:00.000Z", key: "p-1", gate: null } })),
      clock,
    );
    expect(view.status).toBe("held");
    expect(view.hold).toEqual({ kind: "pause", why: "triage", since: "2026-09-15T11:00:00.000Z", gate: null });
    expect(view.pendingApprovals).toEqual([]);
    expect(view.channel.state).toBe("ok");
  });

  it("shows an approval hold with its gate, and lists it as a pending approval with its question", () => {
    const view = projectControlView(
      "ralph",
      loop(),
      read(
        record({
          hold: { kind: "approval", why: "decision gate g1: ship it?", since: "2026-09-15T11:30:00.000Z", key: null, gate: "g1" },
        }),
      ),
      clock,
    );
    expect(view.status).toBe("held");
    expect(view.hold).toMatchObject({ kind: "approval", gate: "g1", why: "decision gate g1: ship it?" });
    expect(view.pendingApprovals).toEqual([
      { gate: "g1", question: "ship it?", since: "2026-09-15T11:30:00.000Z" },
    ]);
  });

  it("ranks a recorded stop above a hold", () => {
    const view = projectControlView(
      "ralph",
      loop(),
      read(
        record({
          hold: { kind: "pause", why: "triage", since: "T1", key: "p-1", gate: null },
          stop: { kind: "blocked", why: "operator", at: "T2", key: "s-1", confirmation: "confirmed" },
        }),
      ),
      clock,
    );
    expect(view.status).toBe("stopped");
    expect(view.stop).toEqual({
      kind: "blocked",
      why: "operator",
      at: "T2",
      confirmation: "confirmed",
      iteration: null,
      issue: null,
    });
  });

  it("says which phase a hold at a phase boundary is held before, and a phase stop stopped before", () => {
    const held = projectControlView(
      "ralph",
      loop({ loopStatus: "blocked", state: state({ stage: "paused", phase: "finish" }) }),
      read(
        record({
          hold: { kind: "pause", why: "pause after review", since: "T1", key: "p-1", gate: null, phase: "finish", after: "review" },
        }),
      ),
      clock,
    );
    expect(held.status).toBe("held");
    // The phase just finished too, which is what the page offers to retry.
    expect(held.hold).toEqual({ kind: "pause", why: "pause after review", since: "T1", gate: null, phase: "finish", after: "review" });

    const stopped = projectControlView(
      "ralph",
      loop(),
      read(record({ stop: { kind: "blocked", why: "no PR", at: "T2", key: "s-1", confirmation: "confirmed", phase: "finish" } })),
      clock,
    );
    expect(stopped.stop).toMatchObject({ kind: "blocked", confirmation: "confirmed", phase: "finish" });

    // A phase the dashboard does not know is left off rather than shown.
    const odd = projectControlView(
      "ralph",
      loop(),
      read(record({ hold: { kind: "pause", why: "x", since: "T1", key: "p", gate: null, phase: "daydream" } })),
      clock,
    );
    expect(odd.hold).not.toHaveProperty("phase");
  });

  it("lists the armed gates in the record's order, and drops one naming no known phase", () => {
    const view = projectControlView(
      "ralph",
      loop(),
      read(
        record({
          gates: [
            { phase: "review", why: null, since: "T1", key: "a-1", asked: null },
            { phase: "lunch", why: null, since: "T1", key: "a-2", asked: null },
            { phase: "finish", why: "a person opens the PRs", since: "T2", key: "a-3", asked: "run#2" },
          ],
        }),
      ),
      clock,
    );
    expect(view.gates).toEqual([
      { phase: "review", since: "T1", why: null },
      { phase: "finish", since: "T2", why: "a person opens the PRs" },
    ]);
    expect(view.status).toBe("clear");
    expect(projectControlView("ralph", loop(), read(record({})), clock).gates).toEqual([]);
  });

  it("shows the approval an armed gate is waiting on, with the phase it is held before", () => {
    const view = projectControlView(
      "ralph",
      loop({ loopStatus: "blocked", state: state({ stage: "paused", phase: "finish" }) }),
      read(
        record({
          hold: {
            kind: "approval",
            why: "decision gate before-finish: continue into finish?",
            since: "T1",
            key: "a-1",
            gate: "before-finish",
            phase: "finish",
            after: "review",
          },
          gates: [{ phase: "finish", why: null, since: "T0", key: "a-1", asked: "run#2" }],
        }),
      ),
      clock,
    );
    expect(view.status).toBe("held");
    expect(view.hold).toMatchObject({ kind: "approval", gate: "before-finish", phase: "finish" });
    expect(view.pendingApprovals).toEqual([{ gate: "before-finish", question: "continue into finish?", since: "T1" }]);
    expect(view.gates.map((gate) => gate.phase)).toEqual(["finish"]);
  });

  it("carries what an interrupted stop cut short: the iteration, and the ticket still claimed", () => {
    const view = projectControlView(
      "ralph",
      loop(),
      read(
        record({
          stop: { kind: "interrupted", why: "stopped now", at: "T2", key: "now-1", confirmation: "confirmed", iteration: 7, issue: 49 },
        }),
      ),
      clock,
    );
    expect(view.status).toBe("stopped");
    expect(view.stop).toMatchObject({ kind: "interrupted", confirmation: "confirmed", iteration: 7, issue: 49 });
  });
});

describe("the blocked reason", () => {
  it("names what a loop parked on the frontier is waiting for", () => {
    const view = projectControlView(
      "ralph",
      loop({
        loopStatus: "blocked",
        state: state({
          stage: "gate",
          lastEvent: { name: "blocked-wait", at: "2026-09-15T11:50:00.000Z", detail: "every open ticket is blocked" },
        }),
      }),
      read(record()),
      clock,
    );
    expect(view.status).toBe("blocked");
    expect(view.blocked).toEqual({
      source: "frontier",
      reason: "every open ticket is blocked",
      since: "2026-09-15T11:50:00.000Z",
    });
  });

  it("names a loop that stopped on a blocked ending", () => {
    const view = projectControlView(
      "ralph",
      loop({
        loopStatus: "blocked",
        supervisor: "dead",
        state: state({ stage: "stopped", stopReason: { kind: "blocked", why: "needs human triage", at: "T9" } }),
      }),
      read({ ...record(), applied: [] }),
      clock,
    );
    expect(view.blocked).toEqual({ source: "stop", reason: "needs human triage", since: "T9" });
  });

  it("has no blocked reason for a running loop", () => {
    expect(projectControlView("ralph", loop(), read(record()), clock).blocked).toBeNull();
  });
});

describe("recorded outcomes", () => {
  it("lists recent commands newest first, each with its outcome and timestamp", () => {
    const view = projectControlView(
      "ralph",
      loop(),
      read(
        record({
          applied: [
            { key: "p-1", command: "pause", at: "2026-09-15T10:00:00.000Z", outcome: "applied", why: "paused — triage" },
            { key: "r-1", command: "resume", at: "2026-09-15T10:05:00.000Z", outcome: "applied", why: "resumed" },
            { key: "s-0", command: "stop", at: "2026-09-15T10:06:00.000Z", outcome: "needs-reconfirmation", why: "old run" },
          ],
        }),
      ),
      clock,
    );
    expect(view.commands).toEqual([
      { key: "s-0", command: "stop", outcome: "needs-reconfirmation", at: "2026-09-15T10:06:00.000Z", why: "old run" },
      { key: "r-1", command: "resume", outcome: "applied", at: "2026-09-15T10:05:00.000Z", why: "resumed" },
      { key: "p-1", command: "pause", outcome: "applied", at: "2026-09-15T10:00:00.000Z", why: "paused — triage" },
    ]);
    expect(view.status).toBe("clear");
  });

  it("keeps only the most recent commands", () => {
    const applied = Array.from({ length: RECENT_COMMAND_LIMIT + 5 }, (_, index) => ({
      key: `k-${index}`,
      command: "pause",
      at: `2026-09-15T10:${String(index).padStart(2, "0")}:00.000Z`,
      outcome: "applied",
      why: "paused",
    }));
    const view = projectControlView("ralph", loop(), read(record({ applied })), clock);
    expect(view.commands).toHaveLength(RECENT_COMMAND_LIMIT);
    expect(view.commands[0]?.key).toBe(`k-${RECENT_COMMAND_LIMIT + 4}`);
  });
});

describe("deferrals", () => {
  it("shows a waiting command with its attempts, and a given-up one with its remedy", () => {
    const view = projectControlView(
      "ralph",
      loop(),
      read(
        record({
          deferrals: [{ key: "rt-1", command: "retry", since: "2026-09-15T11:40:00.000Z", attempts: 3 }],
          applied: [{ key: "ab-1", command: "abandon", at: "2026-09-15T11:45:00.000Z", outcome: "refused", why: GIVEN_UP_WHY }],
        }),
      ),
      clock,
    );
    expect(view.deferrals).toEqual([
      { key: "rt-1", command: "retry", since: "2026-09-15T11:40:00.000Z", attempts: 3 },
    ]);
    expect(view.givenUp).toEqual([
      { key: "ab-1", command: "abandon", at: "2026-09-15T11:45:00.000Z", attempts: 5, remedy: GIVEN_UP_WHY },
    ]);
    // A given-up command is still a recorded outcome: refused.
    expect(view.commands[0]).toMatchObject({ key: "ab-1", outcome: "refused" });
    // Waiting is not holding.
    expect(view.hold).toBeNull();
    expect(view.status).toBe("clear");
  });
});

describe("a degraded or unreachable control channel", () => {
  it("shows a degraded window as degraded, never as a hold or a stop", () => {
    const view = projectControlView(
      "ralph",
      loop(),
      read(record({ degraded: { why: "orca unreachable", at: "2026-09-15T11:58:00.000Z", retryAt: "2026-09-15T12:03:00.000Z" } })),
      clock,
    );
    expect(view.status).toBe("degraded");
    expect(view.channel).toEqual({
      state: "degraded",
      why: "orca unreachable",
      since: "2026-09-15T11:58:00.000Z",
      retryAt: "2026-09-15T12:03:00.000Z",
    });
    expect(view.hold).toBeNull();
    expect(view.stop).toBeNull();
  });

  it("keeps a recorded hold through a degraded window, and says the channel is degraded", () => {
    // The record is what the verdict falls back to: an existing hold keeps
    // holding, and the panel says both things rather than choosing one.
    const view = projectControlView(
      "ralph",
      loop(),
      read(
        record({
          hold: { kind: "pause", why: "triage", since: "T1", key: "p-1", gate: null },
          degraded: { why: "orca unreachable", at: "T2", retryAt: "T3" },
        }),
      ),
      clock,
    );
    expect(view.status).toBe("held");
    expect(view.channel.state).toBe("degraded");
  });

  it("shows an unreadable control record as an unreachable channel, inventing no hold or stop", () => {
    const view = projectControlView(
      "ralph",
      loop(),
      { kind: "unreadable", why: "controls: boom" },
      clock,
    );
    expect(view.status).toBe("degraded");
    expect(view.channel).toEqual({ state: "unreachable", why: "controls: boom", since: null, retryAt: null });
    expect(view.hold).toBeNull();
    expect(view.stop).toBeNull();
    expect(view.commands).toEqual([]);
  });

  it("never shows an unreachable stop as confirmed", () => {
    const view = projectControlView(
      "ralph",
      loop({ supervisor: "dead" }),
      read(record({ stop: { kind: "failed", why: "recovering", at: "T1", key: "s-1", confirmation: "unreachable" } })),
      clock,
    );
    expect(view.status).toBe("stop-unreachable");
    expect(view.stop?.confirmation).toBe("unreachable");
  });

  it("shows a pending stop as pending", () => {
    const view = projectControlView(
      "ralph",
      loop(),
      read(record({ stop: { kind: "blocked", why: "operator", at: "T1", key: "s-1", confirmation: "pending" } })),
      clock,
    );
    expect(view.status).toBe("stop-pending");
  });

  it("reports a loop with no record yet as a listening channel with nothing held", () => {
    const view = projectControlView("ralph", loop(), { kind: "none" }, clock);
    expect(view.channel.state).toBe("no-record");
    expect(view.status).toBe("clear");
  });
});

describe("reading the control record", () => {
  const adapterOver = (exec: Executor) =>
    createRalphControlAdapter({ cliDir: "/cli", root: "/checkout/ralph", bunPath: "bun", exec });

  it("makes only the status read", async () => {
    const recorder = createRecordingExecutor().on(
      { command: "bun", args: ["/cli/controls.ts", "status", "--json"] },
      { status: 0, stdout: JSON.stringify(record()), stderr: "" },
    );
    const result = await readControlStatus(adapterOver(recorder.exec));
    expect(result.kind).toBe("record");
    expect(recorder.calls.map((call) => call.invocation.args.slice(1))).toEqual([["status", "--json"]]);
  });

  it("degrades an executor that throws rather than failing", async () => {
    const recorder = createRecordingExecutor({ fallback: { throw: new Error("spawn bun ENOENT") } });
    expect(await readControlStatus(adapterOver(recorder.exec))).toEqual({
      kind: "unreadable",
      why: "spawn bun ENOENT",
    });
  });
});

describe("composing a loop's control view from the runtime snapshot", () => {
  const runtime = (loops: RuntimeLoop[]): RuntimeSnapshot => ({
    roster: coderRoster("ralph", "rafa", "remo", "rulo"),
    loops,
    reconciliation: { orphaned: [], prunable: [] },
  });

  it("returns null for a name outside the roster", async () => {
    expect(await composeControlView(runtime([]), "nope", async () => ({ kind: "none" }), clock)).toBeNull();
  });

  it("reads the record of the loop's own worktree", async () => {
    const worktrees: string[] = [];
    const view = await composeControlView(
      runtime([
        loop({ worktree: "/checkout/copy", state: null, loopStatus: "unknown" }),
        loop({ worktree: "/checkout/real" }),
      ]),
      "ralph",
      async (worktree) => {
        worktrees.push(worktree);
        return read(record({ hold: { kind: "pause", why: "triage", since: "T1", key: null, gate: null } }));
      },
      clock,
    );
    expect(worktrees).toEqual(["/checkout/real"]);
    expect(view).toMatchObject({ loop: "ralph", present: true, worktree: "/checkout/real", run: "run-1", status: "held" });
    expect(view?.generatedAt).toBe("2026-09-15T12:00:00.000Z");
  });

  it("reports a roster loop with no checkout as unknown without reading anything", async () => {
    let reads = 0;
    const view = await composeControlView(
      runtime([]),
      "remo",
      async () => {
        reads += 1;
        return { kind: "none" };
      },
      clock,
    );
    expect(reads).toBe(0);
    expect(view).toMatchObject({ loop: "remo", present: false, status: "unknown", hold: null, stop: null });
    expect(view?.channel.state).toBe("unreachable");
  });

  it("composes every roster loop's view exactly as the one-loop read does", async () => {
    const snapshot = runtime([
      loop({ worktree: "/checkout/copy", state: null, loopStatus: "unknown" }),
      loop({ worktree: "/checkout/real" }),
      loop({ worktree: "/checkout/rafa", identity: "rafa", branch: "rafa/16" }),
    ]);
    const readStatus = async (worktree: string): Promise<ControlStatusRead> =>
      worktree === "/checkout/real"
        ? read(record({ hold: { kind: "pause", why: "triage", since: "T1", key: null, gate: null } }))
        : { kind: "none" };
    const worktrees: string[] = [];
    const views = await composeControlViews(
      snapshot,
      async (worktree) => {
        worktrees.push(worktree);
        return readStatus(worktree);
      },
      clock,
    );
    expect(Object.keys(views).sort()).toEqual(["rafa", "ralph", "remo", "rulo"]);
    for (const name of ["ralph", "rafa", "remo", "rulo"]) {
      expect(views[name]).toEqual(await composeControlView(snapshot, name, readStatus, clock));
    }
    // The loops with no checkout (remo, rulo) are unreadable and read nothing.
    expect(worktrees.sort()).toEqual(["/checkout/rafa", "/checkout/real"]);
    expect(views.remo).toMatchObject({ present: false, status: "unknown" });
    expect(views.remo?.channel.state).toBe("unreachable");
  });

  it("answers an empty roster with no views", async () => {
    const empty: RuntimeSnapshot = { roster: [], loops: [], reconciliation: { orphaned: [], prunable: [] } };
    expect(await composeControlViews(empty, async () => ({ kind: "none" }), clock)).toEqual({});
  });
});
