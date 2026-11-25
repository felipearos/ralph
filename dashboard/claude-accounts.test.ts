// @vitest-environment node
/**
 * The host's Claude accounts, from the page's side: the adapter against a
 * recording executor (what crosses the process boundary, and how the CLI's
 * view is narrowed), then the route through the real handler. Nothing here
 * spawns: `claude-account.ts` is the harness's, faked by the executor.
 */
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { coderRoster, type ClaudeAccountsRequest, type RuntimeSnapshot } from "./contracts";
import { claudeAccountsArgs, createClaudeAccountsAdapter, parseClaudeAccountsView } from "./claude-accounts-adapter";
import { parseClaudeAccountsRequest } from "./claude-accounts-routes";
import { createRecordingExecutor } from "./recording-executor";
import { createHandler, type ProjectScope } from "./server";

const HARNESS = "/opt/ralph";
const ROOT = "/home/dev/acme";
const SCRIPT = join(HARNESS, "claude-account.ts");

const VIEW = {
  version: 1,
  registry: "/home/dev/.config/ralph/claude-accounts.json",
  registryProblem: null,
  overrideFile: "/home/dev/acme/.git/ralph-claude-accounts.json",
  overrideProblem: null,
  configProblem: null,
  accounts: [
    {
      name: "acme-work",
      configDir: "/home/dev/.claude-work",
      loggedIn: true,
      email: "dev@example.org",
      organization: "Acme",
      limitedUntil: "2026-11-25T15:00:00.000Z",
      limitSource: "ralph",
    },
    { name: "acme-home", configDir: "/home/dev/.claude", loggedIn: false, email: null, organization: null, limitedUntil: null, limitSource: null },
  ],
  detected: [{ configDir: "/home/dev/.claude-new", suggestedName: "new", loggedIn: true, email: null, organization: null, registeredAs: null }],
  project: {
    rule: { use: ["acme-work", "acme-home"], onLimit: "next" },
    source: "override-project",
    choice: { verdict: "run", account: { name: "acme-home", configDir: "/home/dev/.claude" }, onLimit: "next", detail: "running on Claude account acme-home" },
  },
  loops: [
    {
      loop: "ralph",
      rule: null,
      source: "override",
      own: true,
      choice: { verdict: "default", onLimit: "wait", detail: "no claudeAccounts rule: the environment's account" },
    },
  ],
};

const ok = (body: unknown) => ({ status: 0, stdout: typeof body === "string" ? body : JSON.stringify(body), stderr: "" });

describe("the accounts adapter", () => {
  it("reads the view in the project's checkout and narrows it", async () => {
    const recorder = createRecordingExecutor({ fallback: ok(VIEW) });
    const adapter = createClaudeAccountsAdapter({ cliDir: HARNESS, root: ROOT, bunPath: "/bin/bun", exec: recorder.exec });
    const view = await adapter.view();
    expect(recorder.calls[0]!.invocation).toMatchObject({ command: "/bin/bun", args: [SCRIPT, "view", "--json"], cwd: ROOT });
    expect(recorder.calls[0]!.invocation.env.RALPH_STATE_ROOT).toBe(ROOT);
    expect(view.problem).toBeNull();
    expect(view.accounts.map((account) => [account.name, account.loggedIn, account.limitedUntil])).toEqual([
      ["acme-work", true, "2026-11-25T15:00:00.000Z"],
      ["acme-home", false, null],
    ]);
    expect(view.project).toEqual({
      rule: { use: ["acme-work", "acme-home"], onLimit: "next" },
      source: "override-project",
      choice: { verdict: "run", account: "acme-home", detail: "running on Claude account acme-home" },
    });
    expect(view.loops).toEqual([
      { loop: "ralph", own: true, rule: null, source: "override", choice: { verdict: "default", account: null, detail: expect.any(String) } },
    ]);
    expect(view.detected[0]).toMatchObject({ configDir: "/home/dev/.claude-new", registeredAs: null });
  });

  it("reads a failed or off-shape CLI as a view with a problem", () => {
    expect(parseClaudeAccountsView({ status: 1, stdout: "", stderr: "boom" }).problem).toBe("boom");
    expect(parseClaudeAccountsView(ok("nope")).problem).toContain("did not print JSON");
    expect(parseClaudeAccountsView(ok({ version: 2 })).problem).toContain("unexpected shape");
    expect(parseClaudeAccountsView(ok({ ...VIEW, configProblem: "cannot read config" })).problems).toEqual(["the project's config: cannot read config"]);
  });

  it.each<[ClaudeAccountsRequest, string[]]>([
    [{ action: "add", name: "acme-work", dir: "~/.claude-work" }, ["add", "--name", "acme-work", "--dir", "~/.claude-work"]],
    [{ action: "remove", name: "acme-work" }, ["remove", "--name", "acme-work"]],
    [{ action: "clear-limit", name: "acme-work" }, ["clear", "--account", "acme-work"]],
    [
      { action: "assign", target: "*", use: ["acme-work", "acme-home"], onLimit: "next" },
      ["assign", "--target", "*", "--use", "acme-work,acme-home", "--on-limit", "next"],
    ],
    [{ action: "assign-env", target: "ralph" }, ["assign", "--target", "ralph", "--env"]],
    [{ action: "unassign", target: "ralph" }, ["unassign", "--target", "ralph"]],
  ])("runs %j as the CLI's verbs", (request, args) => {
    expect(claudeAccountsArgs(request)).toEqual(args);
  });

  it("answers a refusal with the CLI's reason and the view read again", async () => {
    const recorder = createRecordingExecutor({ fallback: ok(VIEW) }).on(
      { args: [SCRIPT, "assign"] },
      { status: 1, stdout: "", stderr: "not registered on this host: acme-x" },
    );
    const adapter = createClaudeAccountsAdapter({ cliDir: HARNESS, root: ROOT, bunPath: "/bin/bun", exec: recorder.exec });
    const answer = await adapter.act({ action: "assign", target: "*", use: ["acme-x"], onLimit: "wait" });
    expect(answer).toMatchObject({ ok: false, message: "not registered on this host: acme-x" });
    expect(answer.view.accounts).toHaveLength(2);
    expect(recorder.calls.map((call) => call.invocation.args[1])).toEqual(["assign", "view"]);
  });
});

describe("the accounts request", () => {
  it.each([
    ["no action", {}],
    ["an unknown action", { action: "login" }],
    ["a bad name", { action: "add", name: "Work", dir: "~/.claude-work" }],
    ["a relative dir", { action: "add", name: "work", dir: "claude-work" }],
    ["a two-line dir", { action: "add", name: "work", dir: "/a\n/b" }],
    ["an empty use", { action: "assign", target: "*", use: [], onLimit: "wait" }],
    ["a repeated account", { action: "assign", target: "*", use: ["a", "a"], onLimit: "wait" }],
    ["a bad onLimit", { action: "assign", target: "*", use: ["a"], onLimit: "later" }],
    ["a flag as target", { action: "unassign", target: "--env" }],
    ["env for the project", { action: "assign-env", target: "*" }],
  ])("refuses %s", (_name, body) => {
    expect(() => parseClaudeAccountsRequest(body)).toThrow();
  });

  it("accepts each action", () => {
    expect(parseClaudeAccountsRequest({ action: "add", name: "work", dir: " ~/.claude-work " })).toEqual({ action: "add", name: "work", dir: "~/.claude-work" });
    expect(parseClaudeAccountsRequest({ action: "assign", target: "ralph", use: ["work", "home"], onLimit: "next" })).toEqual({
      action: "assign",
      target: "ralph",
      use: ["work", "home"],
      onLimit: "next",
    });
    expect(parseClaudeAccountsRequest({ action: "unassign", target: "*" })).toEqual({ action: "unassign", target: "*" });
  });
});

describe("the accounts route", () => {
  const PROJECT = "acme";
  const runtime: RuntimeSnapshot = { roster: coderRoster("ralph"), loops: [], reconciliation: { orphaned: [], prunable: [] } };
  const serve = (exec: ReturnType<typeof createRecordingExecutor>["exec"]) => {
    const scope: ProjectScope = {
      project: { id: PROJECT, path: ROOT, addedAt: "2026-10-01T00:00:00.000Z", source: "local" },
      adapter: { read: vi.fn(async () => runtime) },
      claudeAccounts: createClaudeAccountsAdapter({ cliDir: HARNESS, root: ROOT, bunPath: "/bin/bun", exec }),
    };
    return createHandler({ projects: () => [scope], shell: "", clock: () => ({ nowMs: 0 }) });
  };
  const request = (method: string, body?: unknown) =>
    new Request(`http://127.0.0.1/api/p/${PROJECT}/claude-accounts`, {
      method,
      headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("reads on GET and changes one thing on POST", async () => {
    const recorder = createRecordingExecutor({ fallback: ok(VIEW) }).on({ args: [SCRIPT, "unassign"] }, ok("ralph: back to the committed config"));
    const handler = serve(recorder.exec);
    const read = await handler(request("GET"));
    expect(read.status).toBe(200);
    expect(((await read.json()) as { accounts: unknown[] }).accounts).toHaveLength(2);
    const changed = await handler(request("POST", { action: "unassign", target: "ralph" }));
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ ok: true, message: "ralph: back to the committed config" });
  });

  it("refuses a bad body as a 400, running nothing", async () => {
    const recorder = createRecordingExecutor({ fallback: ok(VIEW) });
    const response = await serve(recorder.exec)(request("POST", { action: "add", name: "Bad", dir: "/x" }));
    expect(response.status).toBe(400);
    expect(recorder.calls).toEqual([]);
  });

  it("answers any other method 405", async () => {
    const recorder = createRecordingExecutor({ fallback: ok(VIEW) });
    expect((await serve(recorder.exec)(request("DELETE"))).status).toBe(405);
  });
});
