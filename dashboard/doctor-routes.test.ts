// @vitest-environment node
/**
 * The Fix route, driven in-process through the real handler.
 *
 * First against a recording executor, to pin the HTTP contract and exactly
 * what crosses the process boundary: one harness script, never a plugin's
 * backend. Then against the real `plugin-doctor.ts` and the real plugins, for
 * the two ends an operator sees — no panel with the plugin off, and a plugin
 * that can only be turned off being turned off.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { coderRoster } from "./contracts";
import type { DoctorView, RuntimeSnapshot } from "./contracts";
import { createProcessExecutor } from "./control-adapter";
import { DOCTOR_SURFACE, createDoctorAdapter, parseDoctorOutput } from "./doctor-adapter";
import type { DoctorFactory } from "./doctor-routes";
import { createRecordingExecutor, type RecordedCall } from "./recording-executor";
import { createHandler } from "./server";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("runs the real plugin-doctor.ts and plugins as subprocesses");

const HERE = __dirname;
const HARNESS = join(HERE, "..");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CONFIG = {
  repo: "your-org/your-repo",
  owner: "your-github-login",
  baseBranch: "main",
  displayName: "Your Project",
  secrets: { runner: "none", withhold: [] },
  refuseFiles: [],
  envCheck: [],
  requiredChecks: [],
  gates: {},
  promptFragment: ".ralph/prompt.md",
  coderFragment: ".ralph/coder.md",
  plan: ".ralph/plan.md",
  journal: { dir: "journal/your-project" },
  loops: ["ralph"],
};

function checkout(label: string, plugins: string[]): { root: string; runtime: RuntimeSnapshot } {
  const root = mkdtempSync(join(tmpdir(), `ralph-doctor-routes-${label}-`));
  roots.push(root);
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  writeFileSync(join(root, ".ralph", "config.json"), JSON.stringify({ ...CONFIG, ...(plugins.length > 0 ? { plugins } : {}) }, null, 2));
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
  return {
    root,
    runtime: {
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
          supervisor: "alive",
          presence: null,
        },
      ],
      reconciliation: { orphaned: [], prunable: [] },
    },
  };
}

const post = (handler: (request: Request) => Promise<Response>, body: unknown): Promise<Response> =>
  handler(new Request("http://127.0.0.1/api/doctor", { method: "POST", body: JSON.stringify(body) }));

const ANSWER = {
  version: 1,
  loop: { run: "run-1", loop: "ralph", worktree: "/x" },
  enabled: ["mirror"],
  plugins: [
    {
      plugin: "mirror",
      supported: true,
      why: null,
      report: {
        plugin: "mirror",
        title: "Mirror",
        checks: [
          { id: "reach", label: "Reachable", status: "pass", detail: "yes", repairs: [] },
          { id: "bound", label: "Bound", status: "fail", detail: "no reader", repairs: [{ id: "rebind", label: "Rebind", default: true }] },
        ],
      },
    },
    { plugin: "quiet", supported: false, why: "doctor exited 1", report: null },
  ],
  steps: [],
  stopped: null,
  history: [{ version: 1, at: "2026-09-22T12:00:00.000Z", plugin: "mirror", run: "run-1", kind: "diagnosis", via: "operator", check: null, action: null, result: "failing", why: "Bound: no reader" }],
};

function recorded(label: string): { handler: (request: Request) => Promise<Response>; calls: RecordedCall[]; root: string } {
  const { root, runtime } = checkout(label, ["mirror"]);
  const { exec, calls } = createRecordingExecutor({ fallback: { status: 0, stdout: JSON.stringify(ANSWER), stderr: "" } });
  const doctor: DoctorFactory = ({ worktree }) =>
    createDoctorAdapter({ cliDir: HARNESS, root: worktree, bunPath: "/bin/bun", env: { RALPH_PLUGINS: "mirror" }, exec });
  const handler = createHandler({ adapter: { read: vi.fn(async () => runtime) }, shell: "", clock: () => ({ nowMs: 0 }), doctor });
  return { handler, calls, root };
}

describe("POST /api/doctor", () => {
  it("diagnoses through the harness's doctor script and nothing else", async () => {
    const { handler, calls, root } = recorded("diagnose");
    const response = await post(handler, { loop: "ralph" });
    expect(response.status).toBe(200);
    const view = (await response.json()) as DoctorView;
    // A plugin without a doctor has no panel.
    expect(view.plugins.map((plugin) => plugin.plugin)).toEqual(["mirror"]);
    expect(view.plugins[0]?.checks.find((check) => check.id === "bound")?.repairs).toEqual([
      { id: "rebind", label: "Rebind", default: true },
    ]);
    expect(view.history).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.invocation).toMatchObject({ command: "/bin/bun", args: [join(HARNESS, "plugin-doctor.ts")], cwd: root });
    expect(calls[0]?.invocation.env.RALPH_STATE_ROOT).toBe(root);
    // A page is not a run: the project's config says which plugins are on.
    expect(calls[0]?.invocation.env).not.toHaveProperty("RALPH_PLUGINS");
  });

  it("names the plugin, check and repair it was asked for, and Fix all by its flag", async () => {
    const { handler, calls } = recorded("repair");
    expect((await post(handler, { loop: "ralph", action: "repair", plugin: "mirror", check: "bound", repair: "rebind" })).status).toBe(200);
    expect((await post(handler, { loop: "ralph", action: "fix-all", plugin: "mirror" })).status).toBe(200);
    expect(calls.map((call) => call.invocation.args.slice(1))).toEqual([
      ["--plugin", "mirror", "--repair", "bound:rebind"],
      ["--plugin", "mirror", "--fix-all"],
    ]);
  });

  it("answers a doctor that could not run as a failed view, not a 500", async () => {
    const { runtime } = checkout("throws", ["mirror"]);
    // A spawn that rejects (a timeout, a missing bun) must not take the panel with it.
    const { exec } = createRecordingExecutor({ fallback: { throw: new Error("spawn /bin/bun ENOENT") } });
    const doctor: DoctorFactory = ({ worktree }) => createDoctorAdapter({ cliDir: HARNESS, root: worktree, bunPath: "/bin/bun", exec });
    const handler = createHandler({ adapter: { read: vi.fn(async () => runtime) }, shell: "", clock: () => ({ nowMs: 0 }), doctor });
    const response = await post(handler, { loop: "ralph" });
    expect(response.status).toBe(200);
    const view = (await response.json()) as DoctorView;
    expect(view).toMatchObject({ loop: "ralph", plugins: [], steps: [] });
    expect(view.problem).toContain("spawn /bin/bun ENOENT");
  });

  it("answers a malformed request as a client error, running nothing", async () => {
    const { handler, calls } = recorded("invalid");
    const cases: [unknown, number, string][] = [
      [{}, 400, "ControlRequestError"],
      [{ loop: "ralph", action: "cure" }, 400, "ControlRequestError"],
      [{ loop: "ralph", action: "repair", plugin: "mirror" }, 400, "ControlRequestError"],
      [{ loop: "ralph", action: "fix-all" }, 400, "ControlRequestError"],
      [{ loop: "ralph", check: "bound" }, 400, "ControlRequestError"],
      [{ loop: "ralph", action: "repair", plugin: "mirror", check: "cli", repair: DOCTOR_SURFACE.disableRepair }, 400, "ConfirmationRequired"],
      [{ loop: "nobody" }, 404, "UnknownLoop"],
    ];
    for (const [body, status, error] of cases) {
      const response = await post(handler, body);
      expect(response.status, JSON.stringify(body)).toBe(status);
      expect(((await response.json()) as { error: string }).error).toBe(error);
    }
    expect(calls).toEqual([]);
    const get = await handler(new Request("http://127.0.0.1/api/doctor"));
    expect(get.status).toBe(405);
  });
});

describe("reading the doctor's answer", () => {
  it("turns an unreadable answer into a problem, never an error", () => {
    expect(parseDoctorOutput("ralph", { status: 1, stdout: "", stderr: "boom" }).problem).toBe("boom");
    expect(parseDoctorOutput("ralph", { status: 0, stdout: '{"version":2}', stderr: "" }).problem).toMatch(/not version 1/);
  });

  it("keeps a plugin whose doctor failed to answer, with the reason", () => {
    const view = parseDoctorOutput("ralph", {
      status: 0,
      stdout: JSON.stringify({ ...ANSWER, plugins: [{ plugin: "mirror", supported: true, why: "doctor timed out after 120s", report: null }] }),
      stderr: "",
    });
    expect(view.plugins).toEqual([{ plugin: "mirror", title: "mirror", checks: [], problem: "doctor timed out after 120s" }]);
  });
});

describe("the page's side of the doctor names no plugin backend", () => {
  it("runs one harness script and names no verb of any plugin", () => {
    expect(DOCTOR_SURFACE.script).toBe("plugin-doctor.ts");
    for (const file of ["doctor-adapter.ts", "doctor-routes.ts", "ui/doctor.tsx", "ui/doctor-model.ts"]) {
      const text = readFileSync(join(HERE, file), "utf8");
      expect(text, file).not.toMatch(/\borca\b|orchestration|RALPH_ORCA_|plugins\/[a-z]/i);
      expect(text, file).not.toMatch(/\b(serve|open|status)\s+--json\b/);
    }
  });
});

describe("against the real doctor", () => {
  const real = (label: string, plugins: string[], env: Record<string, string> = {}) => {
    const { root, runtime } = checkout(label, plugins);
    const doctor: DoctorFactory = ({ worktree }) =>
      createDoctorAdapter({ cliDir: HARNESS, root: worktree, env, exec: createProcessExecutor({ timeoutMs: 60_000 }) });
    return { root, handler: createHandler({ adapter: { read: async () => runtime }, shell: "", clock: () => ({ nowMs: 0 }), doctor }) };
  };

  it("has no panel to show when no plugin is enabled", async () => {
    const { handler } = real("off", []);
    const view = (await (await post(handler, { loop: "ralph" })).json()) as DoctorView;
    expect(view).toMatchObject({ plugins: [], steps: [], stopped: null, problem: null });
  });

  it("offers only turning the plugin off when its CLI is missing, and does it once confirmed", async () => {
    const { root, handler } = real("no-cli", ["orca"], { RALPH_ORCA_CLI: "/nonexistent/orca-cli", ORCA_TERMINAL_HANDLE: "" });
    const diagnosed = (await (await post(handler, { loop: "ralph" })).json()) as DoctorView;
    const cli = diagnosed.plugins[0]?.checks[0];
    expect(cli).toMatchObject({ id: "cli", status: "fail" });
    expect(cli?.repairs.map((repair) => repair.id)).toEqual([DOCTOR_SURFACE.disableRepair]);

    const fixAll = (await (await post(handler, { loop: "ralph", action: "fix-all", plugin: "orca" })).json()) as DoctorView;
    expect(fixAll.steps).toEqual([]);
    expect(fixAll.stopped).toMatch(/no repair applies automatically/);

    const disabled = await post(handler, {
      loop: "ralph",
      action: "repair",
      plugin: "orca",
      check: "cli",
      repair: DOCTOR_SURFACE.disableRepair,
      confirm: true,
    });
    expect(((await disabled.json()) as DoctorView).steps[0]?.result).toBe("repaired");
    expect(JSON.parse(readFileSync(join(root, ".ralph", "config.json"), "utf8")).plugins).toBeUndefined();

    const after = (await (await post(handler, { loop: "ralph" })).json()) as DoctorView;
    expect(after.plugins).toEqual([]);
    // Fix all's own diagnosis matched the one before it, so it was not recorded twice.
    expect(after.history.map((entry) => [entry.kind, entry.result])).toEqual([
      ["diagnosis", "failing"],
      ["fix-all", "stopped"],
      ["repair", "repaired"],
      ["diagnosis", "failing"],
    ]);
  });
});
