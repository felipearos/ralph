// @vitest-environment node
/**
 * The Settings page's Run routes (#690): `POST /api/settings/gates/run` runs
 * one of the config's gates by name in the project's checkout, answering at
 * once with the run `running`; `GET` on the same path reads it, for polling.
 * Real gate commands over a fake agents adapter, with a short time limit.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { subprocessSuite } from "../test-timeouts";
import type { AgentsDeps } from "./agents";
import { parseAgentConfig } from "./agents-adapter";
import { handleAgentRoute, SETTINGS_GATE_RUN_PATH } from "./agents-routes";
import type { GateRunAnswer, GateRunView } from "./contracts";
import type { ExecResult } from "./control-adapter";
import { createGateRunner, type GateRunner } from "./gate-run";

subprocessSuite("runs gate commands under bash through the Settings routes");

const ROOT = mkdtempSync(path.join(os.tmpdir(), "gate-run-routes-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const CONFIG: ExecResult = {
  status: 0,
  stdout: JSON.stringify({
    repo: "o/r",
    owner: "o",
    baseBranch: "main",
    displayName: "Proj",
    loops: ["nova"],
    gates: { ok: "echo fine", bad: "echo nope >&2; exit 4", slow: "sleep 30" },
    requiredChecks: [],
  }),
  stderr: "",
};

const deps = (config: ExecResult = CONFIG): AgentsDeps =>
  ({
    agents: { root: ROOT, project: "proj", readConfig: async () => parseAgentConfig(config) },
  }) as unknown as AgentsDeps;

const URL_OF = `http://127.0.0.1${SETTINGS_GATE_RUN_PATH}`;

const call = async (gates: GateRunner, init: RequestInit = {}, config?: ExecResult): Promise<Response> => {
  const response = await handleAgentRoute(new Request(URL_OF, init), SETTINGS_GATE_RUN_PATH, { agents: () => deps(config), gates });
  if (response === null) throw new Error("route not served");
  return response;
};

const post = (gates: GateRunner, body: unknown, config?: ExecResult): Promise<Response> =>
  call(gates, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, config);

const read = async (gates: GateRunner): Promise<GateRunView | null> => ((await (await call(gates)).json()) as GateRunAnswer).run;

/** Poll GET until the run has settled, bounded so a stuck run fails the test rather than hanging it. */
const settled = async (gates: GateRunner, withinMs = 10_000): Promise<GateRunView> => {
  const deadline = Date.now() + withinMs;
  for (;;) {
    const run = await read(gates);
    if (run !== null && run.state !== "running") return run;
    if (Date.now() > deadline) throw new Error(`gate run still ${run?.state ?? "absent"} after ${withinMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("the gate run routes", () => {
  it("answers GET with no run before any has started", async () => {
    expect(await read(createGateRunner({ limitMs: 300 }))).toBeNull();
  });

  it("starts a passing gate at once and reports it passed", async () => {
    const gates = createGateRunner({ limitMs: 60_000 });
    const response = await post(gates, { gate: "ok" });
    expect(response.status).toBe(200);
    const { run } = (await response.json()) as GateRunAnswer;
    expect(run).toMatchObject({ gate: "ok", command: "echo fine", state: "running" });
    expect(await settled(gates)).toMatchObject({ state: "passed", exitCode: 0, output: "fine" });
  });

  it("reports a failing gate's exit code and output", async () => {
    const gates = createGateRunner({ limitMs: 60_000 });
    expect((await post(gates, { gate: "bad" })).status).toBe(200);
    expect(await settled(gates)).toMatchObject({ state: "failed", exitCode: 4, output: "nope" });
  });

  it("times a slow gate out, and refuses a second start while it runs", async () => {
    const gates = createGateRunner({ limitMs: 2000, killGraceMs: 200 });
    expect((await post(gates, { gate: "slow" })).status).toBe(200);
    const refused = await post(gates, { gate: "ok" });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: string; message: string };
    expect(body.error).toBe("GateRunInFlight");
    expect(body.message).toContain("'slow'");
    // Not queued: the run on record is still the first.
    expect(await read(gates)).toMatchObject({ gate: "slow", state: "running" });
    const run = await settled(gates);
    expect(run).toMatchObject({ gate: "slow", state: "timeout", exitCode: null });
  });

  it("refuses a gate the config does not have, naming the ones it does", async () => {
    const response = await post(createGateRunner({ limitMs: 300 }), { gate: "deploy" });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("UnknownGate");
    expect(body.message).toContain("'ok', 'bad', 'slow'");
  });

  it("refuses a request that names no gate", async () => {
    const gates = createGateRunner({ limitMs: 300 });
    expect((await post(gates, {})).status).toBe(400);
    expect((await post(gates, { gate: "  " })).status).toBe(400);
    expect(await read(gates)).toBeNull();
  });

  it("answers 502 when the config cannot be read", async () => {
    const response = await post(createGateRunner({ limitMs: 300 }), { gate: "ok" }, { status: 1, stdout: "", stderr: "no config" });
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toBe("ConfigUnreadable");
  });

  it("serves GET and POST only", async () => {
    const response = await call(createGateRunner({ limitMs: 300 }), { method: "DELETE" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST");
  });
});
