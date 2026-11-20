// @vitest-environment node
/**
 * The lifecycle routes — start, restart-to-apply and the checkout report —
 * driven in-process through the real handler.
 *
 * The runtime read is a fixed snapshot and the executor is a scripted façade
 * behind the real control and lifecycle adapters, so every assertion is on what
 * crosses the process boundary: whether `start.sh` ran, from which checkout,
 * whether a stop was sent, and that no git call repaired anything. Restart's
 * ordering is not re-tested here; `lifecycle.test.ts` owns it. These tests pin
 * the HTTP contract: validation, the server-enforced restart confirmation, loop
 * resolution, and that each result is lifecycle dispatch's, serialized.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { coderRoster } from "./contracts";
import type { Liveness, RuntimeSnapshot } from "./contracts";
import {
  createRalphControlAdapter,
  type ControlAdapter,
  type ExecResult,
  type Invocation,
} from "./control-adapter";
import { createRalphLifecycleAdapter } from "./lifecycle-adapter";
import { createRecordingExecutor } from "./recording-executor";
import { createHandler } from "./server";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Kind = "start" | "liveness" | "record" | "send" | "git" | "other";

/** The pseudo-command a delivery into the loop's inbox is logged as. */
const INBOX = "<inbox>";

/**
 * The control adapter, with each inbox delivery logged as a `send` call beside
 * the subprocesses — so ordering assertions see the command where it happened.
 * The payload is the file that actually landed, read back.
 */
const recordingDelivery = (
  adapter: ControlAdapter,
  root: string,
  log: (invocation: Invocation, delivered: { accepted: boolean; why: string }) => void,
): ControlAdapter => ({
  ...adapter,
  deliver: (input) => {
    const delivered = adapter.deliver(input);
    const file = join(root, ".ralph", "control", "inbox", `${input.key}.json`);
    const control: unknown = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    log({ command: INBOX, args: ["--payload", JSON.stringify({ control })], cwd: root, env: {} }, delivered);
    return delivered;
  },
});

const kindOf = (invocation: Invocation): Kind => {
  if (invocation.command.endsWith("start.sh")) return "start";
  if (invocation.args.some((arg) => arg.endsWith("loop-state.ts"))) return "liveness";
  if (invocation.args.some((arg) => arg.endsWith("controls.ts"))) return "record";
  if (invocation.command === INBOX) return "send";
  if (invocation.command === "git") return "git";
  return "other";
};

interface Harness {
  handler: (request: Request) => Promise<Response>;
  root: string;
  read: ReturnType<typeof vi.fn>;
  readonly calls: readonly { kind: Kind; invocation: Invocation }[];
  kinds: () => Kind[];
  sent: () => number;
  leasePath: string;
  script: {
    liveness: () => Liveness;
    record: () => unknown | null;
    startResult: ExecResult;
    gitStatus: string;
  };
}

/** `ralph` observed at run-1 with a checkout; `rafa` and `remo` have none. */
function harness(label: string): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `ralph-lifecycle-routes-${label}-`)));
  roots.push(root);
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  const common = join(root, "gitcommon");
  mkdirSync(common);
  const state = {
    version: 1 as const,
    run: "run-1",
    owner: { loop: "ralph", pid: null, host: "test" },
    worktree: root,
    branch: "ralph/16",
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
        branch: "ralph/16",
        state,
        stateProblem: null,
        supervisor: "alive",
        presence: null,
      },
    ],
    reconciliation: { orphaned: [], prunable: [] },
  };
  const read = vi.fn(async () => runtime);

  const script: Harness["script"] = {
    liveness: () => "alive",
    record: () => null,
    startResult: { status: 0, stdout: "Started Ralph supervisor (pid 5151); waits 300s.\n", stderr: "" },
    gitStatus: "",
  };
  // Each kind's answer is a function, read at call time, so a test re-scripts by
  // mutating `script`; anything unmatched gets the recorder's `unexpected`.
  const isKind = (kind: Kind) => (invocation: Invocation) => kindOf(invocation) === kind;
  const recorder = createRecordingExecutor()
    .on(isKind("start"), () => script.startResult)
    .on(isKind("liveness"), () => ({
      status: 0,
      stdout: JSON.stringify({
        self: root,
        loops: [
          {
            worktree: root,
            worktreeStatus: "live",
            loopStatus: "running",
            branch: "ralph/16",
            state: null,
            stateProblem: null,
            supervisor: script.liveness(),
          },
        ],
        reconciliation: { orphaned: [], prunable: [] },
      }),
      stderr: "",
    }))
    .on(isKind("record"), () => {
      const record = script.record();
      return { status: 0, stdout: record === null ? "null" : JSON.stringify(record), stderr: "" };
    })
    .on(isKind("git"), (invocation) => {
      if (invocation.args[0] === "status") return { status: 0, stdout: script.gitStatus, stderr: "" };
      if (invocation.args[0] === "rev-parse") return { status: 0, stdout: `${common}\n`, stderr: "" };
      if (invocation.args[0] === "symbolic-ref") return { status: 0, stdout: "ralph/16\n", stderr: "" };
      return { status: 1, stdout: "", stderr: "unexpected git" };
    });
  const exec = recorder.exec;
  // The kind is derived on read, so the inbox deliveries `record`ed beside the
  // executor classify the same way as the subprocesses, in one sequence.
  const calls = (): Harness["calls"] =>
    recorder.calls.map((call) => ({ kind: kindOf(call.invocation), invocation: call.invocation }));

  let clock = Date.parse("2026-09-15T12:00:00.000Z");
  const env = {};
  const handler = createHandler({
    adapter: { read },
    shell: "<html></html>",
    clock: () => ({ nowMs: clock }),
    lifecycle: ({ worktree }) => ({
      control: recordingDelivery(
        createRalphControlAdapter({ cliDir: "/harness", root: worktree, bunPath: "bun", env, exec }),
        worktree,
        (invocation, delivered) =>
          recorder.record(invocation, { status: delivered.accepted ? 0 : 1, stdout: "", stderr: delivered.why }),
      ),
      lifecycle: createRalphLifecycleAdapter({ cliDir: "/harness", root: worktree, bunPath: "bun", env, exec }),
      sleep: async (ms) => {
        clock += ms;
      },
      waitTimeoutMs: 10_000,
      pollIntervalMs: 1_000,
    }),
  });

  return {
    handler,
    root,
    read,
    get calls() {
      return calls();
    },
    script,
    leasePath: join(common, "ralph-claim-leases.json"),
    kinds: () => calls().map((call) => call.kind),
    sent: () => calls().filter((call) => call.kind === "send").length,
  };
}

const post = (h: Harness, path: string, body: unknown): Promise<Response> =>
  h.handler(
    new Request(`http://127.0.0.1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const stopRecord = (key: string, confirmation: "confirmed" | "unreachable" | "pending") => ({
  version: 1,
  ralphRun: "run-1",
  loop: "ralph",
  applied: [{ key, command: "stop", outcome: "applied", at: "T", why: "stopping" }],
  deferrals: [],
  hold: null,
  stop: { kind: "blocked", confirmation, why: "apply lineup", at: "T", key },
});

const controlOf = (invocation: Invocation): Record<string, unknown> => {
  const raw = invocation.args[invocation.args.indexOf("--payload") + 1] ?? "{}";
  return (JSON.parse(raw) as { control: Record<string, unknown> }).control;
};

describe("POST /api/start delegates to lifecycle dispatch", () => {
  it("runs start.sh at the loop's checkout and serializes the result", async () => {
    const h = harness("start");
    const response = await post(h, "/api/start", { loop: "ralph" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      loop: "ralph",
      action: "start",
      worktree: h.root,
      outcome: "started",
      pid: 5151,
    });
    const starts = h.calls.filter((call) => call.kind === "start");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.invocation.command).toBe("/harness/start.sh");
    expect(starts[0]!.invocation.cwd).toBe(h.root);
    // Start is a start: no stop, no control message.
    expect(h.sent()).toBe(0);
  });

  it("reports an already-running loop as the idempotent no-op start.sh answered", async () => {
    const h = harness("already");
    h.script.startResult = { status: 0, stdout: "Ralph supervisor already running (pid 4242).\n", stderr: "" };
    const body = (await (await post(h, "/api/start", { loop: "ralph" })).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ outcome: "already-running", pid: 4242 });
    expect(body.why).toContain("already running");
  });

  it("needs no confirmation", async () => {
    const h = harness("start-unconfirmed");
    expect((await post(h, "/api/start", { loop: "ralph", confirm: false })).status).toBe(200);
  });
});

describe("POST /api/restart delegates to lifecycle dispatch", () => {
  it("stops the observed run, and starts only once the stop is confirmed and the supervisor gone", async () => {
    const h = harness("restart");
    let confirmed = false;
    h.script.record = () => {
      if (h.sent() === 0) return null;
      confirmed = true;
      return stopRecord("r-1", "confirmed");
    };
    h.script.liveness = () => (confirmed ? "dead" : "alive");

    const response = await post(h, "/api/restart", {
      loop: "ralph",
      confirm: true,
      id: "r-1",
      why: "apply lineup",
      stopKind: "completed",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      loop: "ralph",
      action: "restart-to-apply",
      key: "r-1",
      outcome: "started",
      halt: null,
      confirmation: "confirmed",
      start: { outcome: "started", pid: 5151 },
      stop: { action: "stop", outcome: "applied" },
      checkout: { worktree: h.root, dirty: false, midTicket: false },
    });
    const send = h.calls.find((call) => call.kind === "send")!;
    expect(controlOf(send.invocation)).toMatchObject({
      command: "stop",
      id: "r-1",
      run: "run-1",
      stop: "completed",
      why: "apply lineup",
    });
    expect(h.kinds().indexOf("start")).toBeGreaterThan(h.kinds().indexOf("send"));
  });

  it.each([
    ["pending", "stop-pending"],
    ["unreachable", "stop-unreachable"],
  ] as const)("refuses to start while the stop is %s, and surfaces the confirmation", async (confirmation, halt) => {
    const h = harness(`restart-${confirmation}`);
    h.script.record = () => (h.sent() === 0 ? null : stopRecord("k", confirmation));
    const body = (await (await post(h, "/api/restart", { loop: "ralph", confirm: true, id: "k" })).json()) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ outcome: "halted", halt, confirmation, start: null });
    expect(h.kinds()).not.toContain("start");
  });

  it("carries an optional via onto the stop's command file, and leaves a restart without one unchanged", async () => {
    const h = harness("restart-via");
    h.script.record = () => (h.sent() === 0 ? null : stopRecord(h.sent() === 1 ? "r-via" : "r-local", "pending"));
    await post(h, "/api/restart", { loop: "ralph", confirm: true, id: "r-via", via: "remote" });
    await post(h, "/api/restart", { loop: "ralph", confirm: true, id: "r-local" });
    const [remote, local] = h.calls.filter((call) => call.kind === "send").map((call) => controlOf(call.invocation));
    expect(remote).toMatchObject({ command: "stop", id: "r-via", via: "remote" });
    expect(local).toMatchObject({ command: "stop", id: "r-local" });
    expect(local).not.toHaveProperty("via");
  });

  it("refuses to start over an old unconfirmed stop when no supervisor is running, sending nothing", async () => {
    const h = harness("restart-old-stop");
    h.script.liveness = () => "dead";
    h.script.record = () => stopRecord("old", "pending");
    const body = (await (await post(h, "/api/restart", { loop: "ralph", confirm: true })).json()) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ outcome: "halted", halt: "stop-pending", confirmation: "pending" });
    expect(h.sent()).toBe(0);
    expect(h.kinds()).not.toContain("start");
  });

  it("reports a dirty, mid-ticket checkout and repairs nothing", async () => {
    const h = harness("restart-dirty");
    h.script.liveness = () => "dead";
    h.script.gitStatus = " M app.ts\n?? recovery-notes.md\n";
    const leases = {
      version: 1,
      leases: { "16": { issue: 16, run: "run-1", loop: "ralph", worktree: h.root, branch: "ralph/16" } },
    };
    writeFileSync(h.leasePath, JSON.stringify(leases));

    const body = (await (await post(h, "/api/restart", { loop: "ralph", confirm: true })).json()) as {
      outcome: string;
      why: string;
      checkout: unknown;
    };
    expect(body.outcome).toBe("started");
    expect(body.checkout).toMatchObject({
      dirty: true,
      changes: [" M app.ts", "?? recovery-notes.md"],
      midTicket: true,
      claims: [{ issue: 16 }],
    });
    expect(body.why).toContain("worktree left as it is");
    for (const call of h.calls.filter((entry) => entry.kind === "git")) {
      expect(["status", "rev-parse", "symbolic-ref", "log"]).toContain(call.invocation.args[0]);
    }
    expect(JSON.parse(readFileSync(h.leasePath, "utf8"))).toEqual(leases);
  });
});

describe("the restart confirmation is a property of the API", () => {
  it.each([
    ["absent", {}],
    ["false", { confirm: false }],
    ["a truthy string", { confirm: "yes" }],
  ])("rejects a restart whose confirmation is %s, before reading or running anything", async (label, extra) => {
    const h = harness(`unconfirmed-${label.replace(/\s/g, "-")}`);
    const response = await post(h, "/api/restart", { loop: "ralph", ...extra });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("ConfirmationRequired");
    expect(h.calls).toHaveLength(0);
    expect(h.read).not.toHaveBeenCalled();
  });
});

describe("request validation", () => {
  it.each([
    ["/api/start", "a body that is not JSON", "{nope"],
    ["/api/start", "a request with no loop", {}],
    ["/api/start", "a non-string loop", { loop: 5 }],
    ["/api/restart", "a body that is not an object", "[1]"],
    ["/api/restart", "a request with no loop", { confirm: true }],
    ["/api/restart", "an unknown stop kind", { loop: "ralph", confirm: true, stopKind: "nuked" }],
    ["/api/restart", "a non-boolean reconfirm", { loop: "ralph", confirm: true, reconfirm: "true" }],
  ])("refuses %s: %s as a 400 without running anything", async (path, _label, body) => {
    const h = harness(`invalid-${Math.random().toString(36).slice(2, 8)}`);
    const response = await post(h, path, body);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("ControlRequestError");
    expect(h.calls).toHaveLength(0);
  });

  it.each(["/api/start", "/api/restart"])("answers an unknown loop on %s with a distinct 404", async (path) => {
    const h = harness("unknown");
    const response = await post(h, path, { loop: "nope", confirm: true });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe("UnknownLoop");
    expect(h.calls).toHaveLength(0);
  });

  it.each(["/api/start", "/api/restart"])("refuses a roster loop with no checkout on %s", async (path) => {
    const h = harness("absent");
    const response = await post(h, path, { loop: "rafa", confirm: true });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe("LoopNotAddressable");
    expect(h.calls).toHaveLength(0);
  });

  it("serves the write routes on POST only", async () => {
    const h = harness("methods");
    for (const path of ["/api/start", "/api/restart"]) {
      for (const method of ["GET", "PUT", "DELETE"]) {
        const response = await h.handler(new Request(`http://127.0.0.1${path}`, { method }));
        expect(response.status).toBe(405);
        expect(response.headers.get("allow")).toBe("POST");
      }
    }
    expect(h.calls).toHaveLength(0);
  });
});

describe("GET /api/loops/:name/checkout", () => {
  it("reports what a restart would leave in place, through read-only git calls", async () => {
    const h = harness("checkout");
    h.script.gitStatus = "?? recovery-notes.md\n";
    writeFileSync(
      h.leasePath,
      JSON.stringify({ version: 1, leases: { "16": { issue: 16, run: "run-1", loop: "ralph", worktree: h.root } } }),
    );
    const response = await h.handler(new Request("http://127.0.0.1/api/loops/ralph/checkout"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      loop: "ralph",
      checkout: { worktree: h.root, branch: "ralph/16", dirty: true, changes: ["?? recovery-notes.md"], midTicket: true },
    });
    expect(new Set(h.kinds())).toEqual(new Set(["git"]));
  });

  it("answers an unknown loop with 404, a loop with no checkout with 409, and non-GET with 405", async () => {
    const h = harness("checkout-errors");
    expect((await h.handler(new Request("http://127.0.0.1/api/loops/nope/checkout"))).status).toBe(404);
    expect((await h.handler(new Request("http://127.0.0.1/api/loops/rafa/checkout"))).status).toBe(409);
    const posted = await h.handler(new Request("http://127.0.0.1/api/loops/ralph/checkout", { method: "POST" }));
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET");
    expect(h.calls).toHaveLength(0);
  });
});

describe("without a lifecycle factory", () => {
  it("serves no start or restart", async () => {
    const read = vi.fn();
    const handler = createHandler({ adapter: { read }, shell: "", clock: () => ({ nowMs: 0 }) });
    for (const path of ["/api/start", "/api/restart"]) {
      const response = await handler(new Request(`http://127.0.0.1${path}`, { method: "POST", body: "{}" }));
      expect(response.status).toBe(405);
    }
    expect(read).not.toHaveBeenCalled();
  });
});

describe("POST /api/stop-now and POST /api/resume-work", () => {
  /** The same snapshot, with a Stop now whose target refuses and records every call. */
  const withInterrupt = (label: string) => {
    const h = harness(label);
    const inspected: string[] = [];
    const audited: Record<string, unknown>[] = [];
    const exec = async (): Promise<ExecResult> => ({ status: 127, stdout: "", stderr: "no subprocess in this test" });
    const lifecycleOf = ({ worktree }: { worktree: string }) => ({
      control: createRalphControlAdapter({ cliDir: "/harness", root: worktree, bunPath: "bun", env: {}, exec }),
      lifecycle: createRalphLifecycleAdapter({ cliDir: "/harness", root: worktree, bunPath: "bun", env: {}, exec }),
    });
    const handler = createHandler({
      adapter: { read: h.read as () => Promise<RuntimeSnapshot> },
      shell: "",
      lifecycle: lifecycleOf,
      interrupt: (target) => ({
        ...lifecycleOf(target),
        interrupt: {
          worktree: target.worktree,
          inspect: () => {
            inspected.push(target.worktree);
            return {
              pidFile: ".ralph/logs/supervisor.pid",
              pid: 4242,
              group: 4242,
              checks: [{ check: "pid-file", ok: true, detail: "pid 4242" }, { check: "alive", ok: false, detail: "pid 4242 is not running" }],
              ok: false,
            };
          },
          signal: () => {
            throw new Error("a refused target must never be signalled");
          },
          remaining: () => ({ supervisor: false, group: false, ours: false }),
          audit: (entry) => {
            audited.push({ ...entry });
            return null;
          },
        },
      }),
    });
    const send = (path: string, body: unknown) =>
      handler(new Request(`http://127.0.0.1${path}`, { method: "POST", body: JSON.stringify(body) }));
    return { h, send, inspected, audited };
  };

  it("requires the server-enforced confirmation before looking at any process", async () => {
    const { send, inspected } = withInterrupt("stop-now-unconfirmed");
    for (const body of [{ loop: "ralph" }, { loop: "ralph", confirm: "yes" }]) {
      const response = await send("/api/stop-now", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "ConfirmationRequired" });
    }
    expect(inspected).toEqual([]);
  });

  it("answers a refused target with the mismatch named, as a 200 carrying the checks", async () => {
    const { h, send, inspected } = withInterrupt("stop-now-refused");
    const response = await send("/api/stop-now", { loop: "ralph", confirm: true, why: "held a turn open" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ action: "stop-now", outcome: "refused", signals: [], worktree: h.root });
    expect(body.why).toContain("pid 4242 is not running");
    expect(inspected).toEqual([h.root]);
  });

  it("writes an optional via on the audit line, and leaves a Stop now without one unchanged", async () => {
    const { send, audited } = withInterrupt("stop-now-via");
    await send("/api/stop-now", { loop: "ralph", confirm: true, id: "sn-remote", via: "remote" });
    await send("/api/stop-now", { loop: "ralph", confirm: true, id: "sn-local" });
    expect(audited.map((entry) => [entry.id, entry.via])).toEqual([
      ["sn-remote", "remote"],
      ["sn-local", undefined],
    ]);
    expect(audited[1]).not.toHaveProperty("via");
  });

  it("rejects an id that cannot key a record, and a loop off the roster", async () => {
    const { send, inspected } = withInterrupt("stop-now-bad");
    expect((await send("/api/stop-now", { loop: "ralph", confirm: true, id: "../x" })).status).toBe(400);
    expect((await send("/api/stop-now", { loop: "nobody", confirm: true })).status).toBe(404);
    expect(inspected).toEqual([]);
  });

  it("is not served without a Stop now factory", async () => {
    // Unmounted, the path falls through to the server's GET-only answer.
    const h = harness("stop-now-unmounted");
    expect((await post(h, "/api/stop-now", { loop: "ralph", confirm: true })).status).toBe(405);
    expect(h.calls).toEqual([]);
  });

  it("resumes work through lifecycle dispatch, starting in the same checkout with HEAD kept", async () => {
    const h = harness("resume");
    h.script.liveness = () => "dead";
    h.script.record = () => ({
      ...stopRecord("now-1", "confirmed"),
      stop: { kind: "interrupted", confirmation: "confirmed", why: "stopped now", at: "T", key: "now-1", iteration: 2, issue: 16 },
    });
    const response = await post(h, "/api/resume-work", { loop: "ralph" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ action: "resume-work", outcome: "started", worktree: h.root });
    const starts = h.calls.filter((call) => call.kind === "start");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.invocation.env.RALPH_RESUME_WORK).toBe("1");
    expect(h.sent()).toBe(0);
  });
});
