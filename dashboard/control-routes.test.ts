// @vitest-environment node
/**
 * The control routes, driven in-process through the real handler.
 *
 * The runtime read is a fixed snapshot and the executor is a recording façade
 * over the real control adapter, so every assertion is on what crosses the
 * process boundary: which command file lands in which checkout's inbox, for
 * which action — or that nothing was written at all. Control semantics are not
 * re-tested here; `dispatch.test.ts` and `dispatch-channel.test.ts` own them.
 * These tests pin the HTTP contract: validation, the server-enforced stop
 * confirmation, loop resolution, and that the handler delegates to dispatch.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { coderRoster } from "./contracts";
import type { RuntimeSnapshot } from "./contracts";
import {
  createRalphControlAdapter,
  type Invocation,
} from "./control-adapter";
import { createRecordingExecutor } from "./recording-executor";
import { createHandler } from "./server";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Harness {
  handler: (request: Request) => Promise<Response>;
  readonly calls: readonly Invocation[];
  read: ReturnType<typeof vi.fn>;
  root: string;
}

/** `ralph` observed at run-1 with a checkout; `rafa` and `remo` have none. */
function harness(label: string, over: { supervisor?: "alive" | "dead" | "unknown" } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), `ralph-control-routes-${label}-`));
  roots.push(root);
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  const state = {
    version: 1 as const,
    run: "run-1",
    owner: { loop: "ralph", pid: null, host: "test" },
    worktree: root,
    branch: "ralph/14",
    stage: "iteration" as const,
    iteration: { index: 1, max: 10 },
    heartbeat: "2026-09-15T00:00:00.000Z",
    lastEvent: null,
    stopReason: null,
  };
  writeFileSync(join(root, ".ralph", "logs", "state.json"), JSON.stringify(state));

  const runtime: RuntimeSnapshot = {
    roster: coderRoster("ralph", "rafa", "remo", "rulo"),
    loops: [
      {
        worktree: root,
        identity: "ralph",
        loopStatus: "running",
        worktreeStatus: "live",
        branch: "ralph/14",
        state,
        stateProblem: null,
        supervisor: over.supervisor ?? "alive",
        presence: null,
      },
    ],
    reconciliation: { orphaned: [], prunable: [] },
  };
  const read = vi.fn(async () => runtime);

  const recorder = createRecordingExecutor({
    // A loop never commanded before: the control record reads back as null.
    rules: [
      {
        match: (invocation) => invocation.args.some((arg) => arg.endsWith("controls.ts")),
        answer: { status: 0, stdout: "null", stderr: "" },
      },
    ],
    fallback: (invocation) => ({ status: 1, stdout: "", stderr: `unexpected: ${invocation.command}` }),
  });
  const exec = recorder.exec;

  const handler = createHandler({
    adapter: { read },
    shell: "<html></html>",
    clock: () => ({ nowMs: 0 }),
    controls: ({ worktree }) => ({
      adapter: createRalphControlAdapter({
        cliDir: "/harness",
        root: worktree,
        bunPath: "bun",
        exec,
      }),
    }),
  });

  return {
    handler,
    get calls() {
      return recorder.calls.map((call) => call.invocation);
    },
    read,
    root,
  };
}

const post = (h: Harness, body: unknown): Promise<Response> =>
  h.handler(
    new Request("http://127.0.0.1/api/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

/** The command files in the addressed checkout's inbox. */
const sends = (h: Harness): Record<string, unknown>[] => {
  const dir = join(h.root, ".ralph", "control", "inbox");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>);
};

const controlOf = (command: Record<string, unknown>): Record<string, unknown> => command;

describe("POST /api/control delegates to dispatch", () => {
  it("sends pause through the adapter at the loop's checkout and serializes the result", async () => {
    const h = harness("pause");
    const response = await post(h, { loop: "ralph", action: "pause", run: "run-1", why: "triage", id: "k-1" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      loop: "ralph",
      action: "pause",
      key: "k-1",
      run: "run-1",
      outcome: "applied",
      recorded: false,
      stop: null,
    });
    expect(typeof body.at).toBe("string");

    // The control status read and the send both run at the loop's checkout.
    const status = h.calls.find((call) => call.args.some((arg) => arg.endsWith("controls.ts")));
    expect(status?.args).toEqual(["/harness/controls.ts", "status", "--json"]);
    expect(status?.cwd).toBe(h.root);
    expect(sends(h)).toHaveLength(1);
    const send = sends(h)[0]!;
    expect(controlOf(send)).toMatchObject({ command: "pause", id: "k-1", loop: "ralph", run: "run-1", why: "triage" });
  });

  it("carries an optional via into the command file, and leaves a command without one unchanged", async () => {
    const h = harness("via");
    expect((await post(h, { loop: "ralph", action: "pause", id: "r-1", via: "remote" })).status).toBe(200);
    expect((await post(h, { loop: "ralph", action: "resume", id: "l-1" })).status).toBe(200);
    const byId = Object.fromEntries(sends(h).map((send) => [send.id, send]));
    expect(byId["r-1"]).toMatchObject({ command: "pause", via: "remote" });
    expect(byId["l-1"]).not.toHaveProperty("via");
    // `via` is text like every other field: anything else is a 400 and nothing is sent.
    const bad = await post(h, { loop: "ralph", action: "pause", id: "x-1", via: 7 });
    expect(bad.status).toBe(400);
    expect(sends(h)).toHaveLength(2);
  });

  it.each(["pause", "resume", "approve", "deny"])("accepts %s without a confirmation", async (action) => {
    const h = harness(`plain-${action}`);
    const response = await post(h, { loop: "ralph", action });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { action: string }).action).toBe(action);
    expect(controlOf(sends(h)[0]!).command).toBe(action);
  });

  it("sends a confirmed stop with its kind, and reports it pending rather than confirmed", async () => {
    const h = harness("stop");
    const response = await post(h, { loop: "ralph", action: "stop", stopKind: "failed", confirm: true, id: "s" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { outcome: string; stop: unknown };
    expect(body.outcome).toBe("applied");
    expect(body.stop).toEqual({ kind: "failed", confirmation: "pending" });
    expect(controlOf(sends(h)[0]!)).toMatchObject({ command: "stop", stop: "failed" });
  });

  it("sends pause and a confirmed stop scoped to the next phase", async () => {
    const h = harness("scoped");
    expect((await post(h, { loop: "ralph", action: "pause", scope: "phase", id: "p" })).status).toBe(200);
    const stopped = await post(h, { loop: "ralph", action: "stop", scope: "phase", confirm: true, id: "s" });
    expect(stopped.status).toBe(200);
    const byId = Object.fromEntries(sends(h).map((send) => [send.id, send]));
    expect(byId.p).toMatchObject({ command: "pause", scope: "phase" });
    expect(byId.s).toMatchObject({ command: "stop", scope: "phase" });
    // Scoped or not, a stop still needs its confirmation.
    expect((await post(h, { loop: "ralph", action: "stop", scope: "phase" })).status).toBe(400);
  });

  it("sends a phase retry, which takes no scope of its own", async () => {
    const h = harness("retry-phase");
    expect((await post(h, { loop: "ralph", action: "retry-phase", why: "new reviewer model", id: "rp" })).status).toBe(200);
    expect(sends(h)[0]).toMatchObject({ command: "retry-phase", why: "new reviewer model" });
    expect(sends(h)[0]).not.toHaveProperty("scope");
    expect((await post(h, { loop: "ralph", action: "retry-phase", scope: "phase" })).status).toBe(400);
  });

  it("arms and disarms a gate before a named phase", async () => {
    const h = harness("gates");
    const armed = await post(h, { loop: "ralph", action: "arm-gate", phase: "finish", id: "a" });
    expect(armed.status).toBe(200);
    expect((await post(h, { loop: "ralph", action: "disarm-gate", phase: "finish", id: "d" })).status).toBe(200);
    const byId = Object.fromEntries(sends(h).map((send) => [send.id, send]));
    expect(byId.a).toMatchObject({ command: "arm-gate", phase: "finish" });
    expect(byId.d).toMatchObject({ command: "disarm-gate", phase: "finish" });
  });

  it("serializes needs-reconfirmation for a replaced run and sends nothing", async () => {
    const h = harness("reconfirm");
    const response = await post(h, { loop: "ralph", action: "pause", run: "run-0" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { outcome: string; why: string };
    expect(body.outcome).toBe("needs-reconfirmation");
    expect(body.why).toContain("run-1");
    expect(sends(h)).toHaveLength(0);
  });
});

describe("the stop confirmation is a property of the API", () => {
  it.each([
    ["absent", {}],
    ["false", { confirm: false }],
    ["a truthy string", { confirm: "yes" }],
  ])("rejects a stop whose confirmation is %s, before reading or sending anything", async (_label, extra) => {
    const h = harness(`unconfirmed-${_label.replace(/\s/g, "-")}`);
    const response = await post(h, { loop: "ralph", action: "stop", ...extra });
    expect(response.status).toBe(400);
    expect(h.calls).toHaveLength(0);
    expect(h.read).not.toHaveBeenCalled();
  });

  it("names the missing confirmation distinctly", async () => {
    const h = harness("unconfirmed-name");
    const body = (await (await post(h, { loop: "ralph", action: "stop" })).json()) as { error: string };
    expect(body.error).toBe("ConfirmationRequired");
  });
});

describe("the recovery commands", () => {
  it("accepts retry without a confirmation", async () => {
    const h = harness("retry");
    const response = await post(h, { loop: "ralph", action: "retry", run: "run-1" });
    expect(response.status).toBe(200);
    expect(controlOf(sends(h)[0]!)).toMatchObject({ command: "retry", run: "run-1" });
  });

  it.each(["abandon", "release"])("rejects %s without its confirmation, before reading or sending anything", async (action) => {
    const h = harness(`unconfirmed-${action}`);
    const response = await post(h, { loop: "ralph", action, issue: 703 });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("ConfirmationRequired");
    expect(h.calls).toHaveLength(0);
    expect(h.read).not.toHaveBeenCalled();
    expect(sends(h)).toHaveLength(0);
  });

  it.each(["abandon", "release"])("sends a confirmed %s with its ticket", async (action) => {
    const h = harness(`confirmed-${action}`);
    const response = await post(h, { loop: "ralph", action, issue: 703, confirm: true });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { issue: number }).issue).toBe(703);
    expect(controlOf(sends(h)[0]!)).toMatchObject({ command: action, issue: 703 });
  });

  it("applies a command at once when the page reads the supervisor as dead, and not otherwise", async () => {
    const dead = harness("dead", { supervisor: "dead" });
    await post(dead, { loop: "ralph", action: "retry" });
    expect(dead.calls.some((call) => call.args.includes("poll"))).toBe(true);

    const alive = harness("alive");
    await post(alive, { loop: "ralph", action: "retry" });
    expect(alive.calls.some((call) => call.args.includes("poll"))).toBe(false);
  });
});

describe("request validation", () => {
  it.each([
    ["a body that is not JSON", "{nope"],
    ["a body that is not an object", "[1]"],
    ["a request with no loop", { action: "pause" }],
    ["a request with no action", { loop: "ralph" }],
    ["an action outside the roster", { loop: "ralph", action: "restart-to-apply" }],
    ["an abandon naming no ticket", { loop: "ralph", action: "abandon", confirm: true }],
    ["a release naming a ticket that is not a number", { loop: "ralph", action: "release", issue: "703", confirm: true }],
    ["a ticket that is not a positive whole number", { loop: "ralph", action: "abandon", issue: 7.5, confirm: true }],
    ["a ticket on a command that takes none", { loop: "ralph", action: "retry", issue: 703 }],
    ["a non-string loop", { loop: 5, action: "pause" }],
    ["an unknown stop kind", { loop: "ralph", action: "stop", stopKind: "nuked", confirm: true }],
    ["a stop kind on a non-stop action", { loop: "ralph", action: "pause", stopKind: "failed" }],
    ["a non-boolean reconfirm", { loop: "ralph", action: "pause", reconfirm: "true" }],
    ["an unknown scope", { loop: "ralph", action: "pause", scope: "whenever" }],
    ["a scope on a command that takes none", { loop: "ralph", action: "resume", scope: "phase" }],
    ["an unknown phase", { loop: "ralph", action: "arm-gate", phase: "lunch" }],
    ["a gate with no phase", { loop: "ralph", action: "arm-gate" }],
    ["a phase on a command that takes none", { loop: "ralph", action: "pause", phase: "finish" }],
  ])("refuses %s as a 400 without sending", async (_label, body) => {
    const h = harness(`invalid-${Math.random().toString(36).slice(2, 8)}`);
    const response = await post(h, body);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("ControlRequestError");
    expect(sends(h)).toHaveLength(0);
  });

  it("answers an unknown loop with a distinct 404", async () => {
    const h = harness("unknown");
    const response = await post(h, { loop: "nope", action: "pause" });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe("UnknownLoop");
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a roster loop with no checkout to address", async () => {
    const h = harness("absent");
    const response = await post(h, { loop: "rafa", action: "pause" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe("LoopNotAddressable");
    expect(h.calls).toHaveLength(0);
  });

  it("serves the write route on POST only", async () => {
    const h = harness("methods");
    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await h.handler(new Request("http://127.0.0.1/api/control", { method }));
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
    expect(h.calls).toHaveLength(0);
  });
});

