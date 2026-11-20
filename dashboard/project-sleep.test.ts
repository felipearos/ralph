// @vitest-environment node
/**
 * The project's sleep, from the page's side: the adapter against a recording
 * executor (what crosses the process boundary, and how every answer the CLI
 * may give is narrowed), then the route through the real handler. Nothing
 * here spawns: `project-sleep.ts` is the harness's, and is faked by the
 * executor the way every adapter suite fakes its CLI.
 */
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { coderRoster, PROJECT_SLEEP_WHY_MAX, type ProjectSleepView, type RuntimeSnapshot } from "./contracts";
import {
  createProjectSleepAdapter,
  parseProjectSleepOutput,
  PROJECT_SLEEP_SURFACE,
  type ProjectSleepAdapter,
} from "./project-sleep-adapter";
import { parseProjectSleepRequest } from "./project-sleep-routes";
import { createRecordingExecutor } from "./recording-executor";
import { createHandler, type ProjectScope } from "./server";

const HARNESS = "/opt/ralph";
const ROOT = "/home/dev/loggd";
const SINCE = "2026-11-05T03:00:00.000Z";

const AWAKE = { version: 1, asleep: false, since: null, why: null, by: null };
const ASLEEP = { version: 1, asleep: true, since: SINCE, why: "deploy freeze", by: "dashboard" };

const ok = (body: unknown) => ({ status: 0, stdout: JSON.stringify(body), stderr: "" });

function adapterOver(answer: Parameters<typeof createRecordingExecutor>[0]) {
  const recorder = createRecordingExecutor(answer);
  const adapter = createProjectSleepAdapter({ cliDir: HARNESS, root: ROOT, bunPath: "/bin/bun", exec: recorder.exec });
  return { adapter, calls: recorder.calls };
}

describe("the sleep adapter", () => {
  it("reads the status in the project's checkout, with its state root set", async () => {
    const { adapter, calls } = adapterOver({ fallback: ok(AWAKE) });
    expect(await adapter.status()).toEqual({ asleep: false, since: null, why: null, by: null, problem: null });
    expect(calls).toHaveLength(1);
    const { invocation } = calls[0]!;
    expect(invocation.command).toBe("/bin/bun");
    expect(invocation.args).toEqual([join(HARNESS, "project-sleep.ts"), "status", "--json"]);
    expect(invocation.cwd).toBe(ROOT);
    expect(invocation.env.RALPH_STATE_ROOT).toBe(ROOT);
  });

  it("sleeps with the reason and the page as its author", async () => {
    const { adapter, calls } = adapterOver({ fallback: ok(ASLEEP) });
    expect(await adapter.sleep("deploy freeze")).toEqual({
      asleep: true,
      since: SINCE,
      why: "deploy freeze",
      by: "dashboard",
      problem: null,
    });
    expect(calls[0]!.invocation.args).toEqual([
      join(HARNESS, "project-sleep.ts"),
      "sleep",
      "--json",
      "--why",
      "deploy freeze",
      "--by",
      "dashboard",
    ]);
  });

  it("sleeps without a reason by leaving --why out", async () => {
    const { adapter, calls } = adapterOver({ fallback: ok({ ...ASLEEP, why: null }) });
    expect((await adapter.sleep(null)).why).toBeNull();
    expect(calls[0]!.invocation.args.slice(1)).toEqual(["sleep", "--json", "--by", "dashboard"]);
  });

  it("wakes with the one verb", async () => {
    const { adapter, calls } = adapterOver({ fallback: ok(AWAKE) });
    expect((await adapter.wake()).asleep).toBe(false);
    expect(calls[0]!.invocation.args.slice(1)).toEqual(["wake", "--json"]);
  });

  it("reads an executor that rejects as a problem, never a throw", async () => {
    const { adapter } = adapterOver({ fallback: { throw: new Error("spawn /bin/bun ENOENT") } });
    expect(await adapter.status()).toEqual({ asleep: false, since: null, why: null, by: null, problem: "spawn /bin/bun ENOENT" });
  });

  it("declares exactly the three verbs of one script", () => {
    expect(Object.keys(PROJECT_SLEEP_SURFACE).sort()).toEqual(["sleep", "status", "wake"]);
    expect(new Set(Object.values(PROJECT_SLEEP_SURFACE).map((surface) => surface.script))).toEqual(new Set(["project-sleep.ts"]));
  });
});

describe("narrowing the CLI's answer", () => {
  const run = (stdout: string, status: number | null = 0, stderr = "") => parseProjectSleepOutput("status", { status, stdout, stderr });

  it("keeps a well-formed view and drops what it does not know", () => {
    expect(run(JSON.stringify({ ...ASLEEP, extra: 1 }))).toEqual({
      asleep: true,
      since: SINCE,
      why: "deploy freeze",
      by: "dashboard",
      problem: null,
    });
    // An awake view's stray fields are not carried: awake has no since.
    expect(run(JSON.stringify({ ...AWAKE, since: SINCE }))).toMatchObject({ asleep: false, since: null, problem: null });
  });

  it("reads blank reasons and authors as none", () => {
    expect(run(JSON.stringify({ ...ASLEEP, why: "  ", by: "" }))).toMatchObject({ why: null, by: null, problem: null });
  });

  it("names a non-zero exit by its stderr, else by its status", () => {
    expect(run("", 1, "not a git checkout\n").problem).toBe("not a git checkout");
    expect(run("", 2).problem).toBe("project-sleep.ts status exited 2 without saying why");
    expect(run("", null).problem).toBe("project-sleep.ts status did not run without saying why");
  });

  it.each([
    ["garbage", "not json at all"],
    ["an array", "[]"],
    ["another version", JSON.stringify({ ...AWAKE, version: 2 })],
    ["a missing asleep", JSON.stringify({ version: 1 })],
    ["asleep as text", JSON.stringify({ ...AWAKE, asleep: "yes" })],
    ["asleep with no since", JSON.stringify({ ...ASLEEP, since: null })],
    ["asleep with an unreadable since", JSON.stringify({ ...ASLEEP, since: "yesterday-ish" })],
  ])("reads %s as a problem on an awake-shaped view", (_name, stdout) => {
    const view = run(stdout);
    expect(view.problem).toEqual(expect.any(String));
    expect(view).toMatchObject({ asleep: false, since: null, why: null, by: null });
  });
});

describe("the sleep request", () => {
  it("takes a sleep with or without a reason, and a wake", () => {
    expect(parseProjectSleepRequest({ asleep: true })).toEqual({ asleep: true, why: null });
    expect(parseProjectSleepRequest({ asleep: true, why: "  release day " })).toEqual({ asleep: true, why: "release day" });
    expect(parseProjectSleepRequest({ asleep: true, why: "" })).toEqual({ asleep: true, why: null });
    expect(parseProjectSleepRequest({ asleep: false })).toEqual({ asleep: false });
  });

  it.each([
    ["no object", null],
    ["an array", []],
    ["no asleep", {}],
    ["asleep as text", { asleep: "true" }],
    ["why as a number", { asleep: true, why: 3 }],
    ["why on a wake", { asleep: false, why: "done" }],
    ["two lines of why", { asleep: true, why: "one\ntwo" }],
    ["an overlong why", { asleep: true, why: "x".repeat(PROJECT_SLEEP_WHY_MAX + 1) }],
  ])("refuses %s", (_name, body) => {
    expect(() => parseProjectSleepRequest(body)).toThrow();
  });
});

describe("the sleep route", () => {
  const PROJECT = "loggd";
  const runtime: RuntimeSnapshot = {
    roster: coderRoster("ralph", "rafa"),
    loops: [],
    reconciliation: { orphaned: [], prunable: [] },
  };

  function serve(sleep: ProjectSleepAdapter) {
    const scope: ProjectScope = {
      project: { id: PROJECT, path: ROOT, addedAt: "2026-10-01T00:00:00.000Z", source: "local" },
      adapter: { read: vi.fn(async () => runtime) },
      sleep,
    };
    return createHandler({ projects: () => [scope], shell: "", clock: () => ({ nowMs: 0 }) });
  }

  const request = (method: string, body?: unknown) =>
    new Request(`http://127.0.0.1/api/p/${PROJECT}/sleep`, {
      method,
      headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });

  function fake(): ProjectSleepAdapter & { calls: string[] } {
    const calls: string[] = [];
    let view: ProjectSleepView = { asleep: false, since: null, why: null, by: null, problem: null };
    return {
      calls,
      status: async () => (calls.push("status"), view),
      sleep: async (why) => (calls.push(`sleep ${why}`), (view = { asleep: true, since: SINCE, why, by: "dashboard", problem: null })),
      wake: async () => (calls.push("wake"), (view = { asleep: false, since: null, why: null, by: null, problem: null })),
    };
  }

  it("reads the status on GET", async () => {
    const sleep = fake();
    const response = await serve(sleep)(request("GET"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ asleep: false, since: null, why: null, by: null, problem: null });
    expect(sleep.calls).toEqual(["status"]);
  });

  it("sleeps and wakes on POST, answering the new view", async () => {
    const sleep = fake();
    const handler = serve(sleep);
    const slept = await handler(request("POST", { asleep: true, why: "deploy freeze" }));
    expect(slept.status).toBe(200);
    expect(await slept.json()).toMatchObject({ asleep: true, since: SINCE, why: "deploy freeze", by: "dashboard" });
    const woken = await handler(request("POST", { asleep: false }));
    expect(await woken.json()).toMatchObject({ asleep: false, since: null });
    expect(sleep.calls).toEqual(["sleep deploy freeze", "wake"]);
  });

  it("answers a failed CLI as a 200 view with its problem", async () => {
    const { exec } = createRecordingExecutor({ fallback: { status: 1, stdout: "", stderr: "no git common dir" } });
    const handler = serve(createProjectSleepAdapter({ cliDir: HARNESS, root: ROOT, bunPath: "/bin/bun", exec }));
    const response = await handler(request("POST", { asleep: true }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ asleep: false, problem: "no git common dir" });
  });

  it.each([["not json", "{"], ["no asleep", { why: "x" }], ["why on a wake", { asleep: false, why: "x" }]])(
    "refuses a body with %s as a 400, running nothing",
    async (_name, body) => {
      const sleep = fake();
      const response = await serve(sleep)(request("POST", body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "ControlRequestError", message: expect.any(String) });
      expect(sleep.calls).toEqual([]);
    },
  );

  it("answers any other method 405, running nothing", async () => {
    const sleep = fake();
    const response = await serve(sleep)(request("DELETE"));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST");
    expect(sleep.calls).toEqual([]);
  });

  it("is not served for a project with no sleep adapter", async () => {
    const scope: ProjectScope = {
      project: { id: PROJECT, path: ROOT, addedAt: "2026-10-01T00:00:00.000Z", source: "local" },
      adapter: { read: vi.fn(async () => runtime) },
    };
    const handler = createHandler({ projects: () => [scope], shell: "", clock: () => ({ nowMs: 0 }) });
    expect((await handler(request("GET"))).status).toBe(404);
  });
});
