// @vitest-environment node
/**
 * Add agent's steps over the real `createAgentsAdapter`, on a scripted
 * executor: at each step pinned here, an executor that THROWS reads exactly
 * as one that never exited.
 *
 * The adapter wraps its `exec` in `guarded`, which turns a rejection into a
 * null status, and the null-status why text lives in the adapter now that
 * `agents.ts` no longer sees an `ExecResult`. Pinning both paths to one answer
 * is what keeps a spawn that fails to start (a throw) from reading differently
 * to the operator than one the timeout killed (a null status). Nothing spawns:
 * every invocation is answered by the recording executor.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { addAgent } from "./agents";
import { createAgentsAdapter, narrowSentinelRules } from "./agents-adapter";
import { SENTINEL_RULE_DEFAULTS, type SentinelIssueRow } from "./contracts";
import type { ExecResult, Invocation } from "./control-adapter";
import { createRecordingExecutor, type Answer } from "./recording-executor";

const ROOT = "/nonexistent/proj";
const CONFIG = { repo: "o/r", baseBranch: "main", loops: ["solo"] };
const ok = (stdout: string): ExecResult => ({ status: 0, stdout, stderr: "" });
type AddAgentResult = Awaited<ReturnType<typeof addAgent>>;
const NEVER_EXITED: ExecResult = { status: null, stdout: "", stderr: "" };

/** Which of Add agent's steps the script breaks, and how the answer names it. */
const STEPS: { step: string; at: (invocation: Invocation) => boolean; why: string }[] = [
  {
    step: "git fetch",
    at: ({ command, args }) => command === "git" && args[0] === "fetch",
    why: "could not fetch origin/main: git fetch did not exit (killed, timed out or never started)",
  },
  {
    // The roster edit itself: a throw carries the executor's error as stderr,
    // which must not stand in for `project-config`'s own refusal.
    step: "the roster edit",
    at: ({ args }) => args.includes("--add-loop"),
    why: "project-config did not exit (killed, timed out or never started)",
  },
  {
    step: "git worktree add",
    at: ({ command, args }) => command === "git" && args[0] === "worktree" && args[1] === "add",
    why: "git worktree add failed: git worktree add did not exit (killed, timed out or never started)",
  },
];

/** Add agent for `nova`, with every step answering as it would on a healthy host but `broken`. */
const addWith = async (broken: (invocation: Invocation) => boolean, answer: Answer): Promise<{ result: AddAgentResult; ran: Invocation[] }> => {
  const recorder = createRecordingExecutor()
    .on(broken, answer)
    .on((invocation) => invocation.args.includes("--json") && invocation.args.some((arg) => arg.endsWith("project-config.ts")), ok(JSON.stringify(CONFIG)))
    .on((invocation) => invocation.args.includes("--add-loop"), ok(JSON.stringify({ ...CONFIG, loops: ["solo", "nova"] })))
    .on({ command: "git", args: ["worktree", "list"] }, ok(`worktree ${ROOT}\n`))
    .on({ command: "git", args: ["fetch"] }, ok(""))
    // Exit 2: origin has no such branch yet.
    .on({ command: "git", args: ["ls-remote"] }, { status: 2, stdout: "", stderr: "" });
  const agents = createAgentsAdapter({
    cliDir: "/nonexistent/cli",
    root: ROOT,
    project: "proj",
    workspaces: "/nonexistent/ws",
    bunPath: "bun",
    env: {},
    exec: recorder.exec,
  });
  const result = await addAgent({ agents }, { name: "nova" });
  return { result, ran: recorder.calls.map((call) => call.invocation) };
};

describe("an Add agent step whose executor throws", () => {
  for (const { step, at, why } of STEPS) {
    it(`refuses at ${step} exactly as when that step never exited`, async () => {
      const thrown = await addWith(at, { throw: new Error("spawn bun ENOENT") });
      const killed = await addWith(at, NEVER_EXITED);

      expect(thrown.result).toMatchObject({ name: "nova", outcome: "refused", status: null, pr: null, labels: null });
      expect(thrown.result.why).toBe(why);
      expect(thrown.result.why).toContain("did not exit (killed, timed out or never started)");
      // Not "spawn bun ENOENT": the why is the step's, whatever the executor said.
      expect(killed.result).toEqual(thrown.result);
      // The script reached the broken step and stopped there, both times.
      expect(thrown.ran.filter(at)).toHaveLength(1);
      expect(thrown.ran.at(-1)).toSatisfy(at);
      expect(killed.ran.map((call) => call.args)).toEqual(thrown.ran.map((call) => call.args));
    });
  }
});

describe("reportedChecks", () => {
  const SHAS = ["aaa111", "bbb222"];
  const isApi = (path: string) => (invocation: Invocation) => invocation.command === "gh" && invocation.args[0] === "api" && invocation.args[1] === path;
  const reporter = (broken?: (invocation: Invocation) => boolean) => {
    const recorder = createRecordingExecutor();
    if (broken !== undefined) recorder.on(broken, { status: 1, stdout: "", stderr: "HTTP 404: Not Found" });
    recorder
      .on(({ command, args }) => command === "gh" && args[0] === "pr" && args[1] === "list", ok(JSON.stringify(SHAS.map((headRefOid) => ({ headRefOid })))))
      .on(isApi("repos/o/r/commits/main/check-runs?per_page=100"), ok(JSON.stringify({ check_runs: [{ name: "test" }, { name: "lint" }] })))
      .on(isApi("repos/o/r/commits/main/status?per_page=100"), ok(JSON.stringify({ statuses: [{ context: "buildkite/r" }] })))
      .on(isApi("repos/o/r/commits/aaa111/check-runs?per_page=100"), ok(JSON.stringify({ check_runs: [{ name: "test" }, { name: "e2e" }] })))
      .on(isApi("repos/o/r/commits/aaa111/status?per_page=100"), ok(JSON.stringify({ statuses: [] })))
      .on(isApi("repos/o/r/commits/bbb222/check-runs?per_page=100"), ok(JSON.stringify({ check_runs: [] })))
      .on(isApi("repos/o/r/commits/bbb222/status?per_page=100"), ok(JSON.stringify({ statuses: [{ context: "buildkite/r" }, { context: "Vercel" }] })));
    const agents = createAgentsAdapter({
      cliDir: "/nonexistent/cli",
      root: ROOT,
      project: "proj",
      workspaces: "/nonexistent/ws",
      bunPath: "bun",
      env: {},
      exec: recorder.exec,
    });
    return { agents, recorder };
  };

  it("merges check-run names and status contexts across the base and the recent PR heads, sorted and de-duplicated", async () => {
    const { agents, recorder } = reporter();
    expect(await agents.reportedChecks("o/r", "main")).toEqual({ ok: true, value: ["Vercel", "buildkite/r", "e2e", "lint", "test"] });
    const list = recorder.calls.map((call) => call.invocation.args).find((args) => args[0] === "pr");
    expect(list).toEqual(["pr", "list", "--state", "all", "--limit", "5", "--json", "headRefOid", "--repo", "o/r"]);
  });

  it("fails the whole read when the PR list fails", async () => {
    const { agents } = reporter(({ args }) => args[0] === "pr");
    const read = await agents.reportedChecks("o/r", "main");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.why).toContain("gh pr list");
  });

  it("fails the whole read, naming the commit, when one commit's read fails", async () => {
    const { agents } = reporter(isApi("repos/o/r/commits/bbb222/status?per_page=100"));
    const read = await agents.reportedChecks("o/r", "main");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.why).toContain("bbb222");
  });
});

describe("the sentinel's reads and its rules edit", () => {
  const sentinelAdapter = (answer: Answer) => {
    const recorder = createRecordingExecutor().on(() => true, answer);
    const agents = createAgentsAdapter({
      cliDir: "/nonexistent/cli",
      root: ROOT,
      project: "proj",
      workspaces: "/nonexistent/ws",
      bunPath: "bun",
      env: {},
      exec: recorder.exec,
    });
    return { agents, recorder };
  };
  const ROW: SentinelIssueRow = {
    key: "sentry:42",
    reporter: "sentry",
    id: "42",
    title: "TypeError: x is undefined",
    permalink: "https://sentry.example/issues/42",
    state: "drafted",
    events: 12,
    users: 3,
    attempts: 0,
    ticket: null,
    ticketNumber: null,
    mode: "observe",
    draftTitle: "Fix TypeError in checkout",
    observedAt: "2026-11-04T08:00:00.000Z",
    updatedAt: "2026-11-04T09:00:00.000Z",
    cycle: 1,
    regressedAfter: null,
  };
  const VIEW = { version: 1, issues: [ROW], today: { day: "2026-11-04", filed: 0, alerted: false } };

  it("edits the rules over stdin with --set-sentinel --at ref, printing the file", async () => {
    const { agents, recorder } = sentinelAdapter(ok("{\"edited\":true}\n"));
    expect(await agents.editSentinel(SENTINEL_RULE_DEFAULTS, "origin/main")).toEqual({ ok: true, value: "{\"edited\":true}\n" });
    const [call] = recorder.calls.map((entry) => entry.invocation);
    expect(call?.args).toEqual(["/nonexistent/cli/project-config.ts", "--set-sentinel", "--at", "origin/main"]);
    expect(JSON.parse(call?.input ?? "")).toEqual(SENTINEL_RULE_DEFAULTS);
  });

  it("quotes project-config's refusal of a rules edit", async () => {
    const { agents } = sentinelAdapter({ status: 1, stdout: "", stderr: "project-config: sentinel.minEvents must be a positive integer\n" });
    expect(await agents.editSentinel({ ...SENTINEL_RULE_DEFAULTS, minEvents: 0 }, "origin/main")).toEqual({
      ok: false,
      why: "sentinel.minEvents must be a positive integer",
    });
  });

  it("names a rules branch per proposal and finds the open one by its prefix", async () => {
    const prs = [
      { url: "https://github.com/o/r/pull/1", state: "OPEN", headRefName: "ralph-roster/verifier-rules-1" },
      { url: "https://github.com/o/r/pull/2", state: "OPEN", headRefName: "ralph-roster/sentinel-rules-2" },
    ];
    const { agents, recorder } = sentinelAdapter(ok(JSON.stringify(prs)));
    expect(agents.sentinelBranch("20261104")).toBe("ralph-roster/sentinel-rules-20261104");
    expect(await agents.sentinelPr("o/r")).toEqual({ ok: true, value: { url: "https://github.com/o/r/pull/2", branch: "ralph-roster/sentinel-rules-2", state: "open" } });
    expect(recorder.calls[0]?.invocation.args).toEqual(["pr", "list", "--state", "open", "--limit", "100", "--json", "url,state,headRefName", "--repo", "o/r"]);
  });

  it("reads the issue store with sentinel/issues.ts --json against the config's checkout", async () => {
    const { agents, recorder } = sentinelAdapter(ok(JSON.stringify(VIEW)));
    expect(await agents.sentinelIssues()).toEqual({ ok: true, value: VIEW });
    const [call] = recorder.calls.map((entry) => entry.invocation);
    expect(call).toMatchObject({ command: "bun", args: ["/nonexistent/cli/sentinel/issues.ts", "--json"], cwd: ROOT });
    expect(call?.env.RALPH_PROJECT).toBe(ROOT);
  });

  it("drops a row whose state or mode this dashboard does not know, keeping the rest", async () => {
    const drifted = { ...VIEW, issues: [{ ...ROW, key: "sentry:1", state: "snoozed" }, ROW, { ...ROW, key: "sentry:2", mode: "act" }] };
    const { agents } = sentinelAdapter(ok(JSON.stringify(drifted)));
    expect(await agents.sentinelIssues()).toEqual({ ok: true, value: VIEW });
  });

  it("fails the read on a version or top level it was not written against", async () => {
    for (const printed of [JSON.stringify({ ...VIEW, version: 2 }), JSON.stringify([]), "not json", JSON.stringify({ version: 1, issues: [] })]) {
      const read = await sentinelAdapter(ok(printed)).agents.sentinelIssues();
      expect(read.ok).toBe(false);
    }
    const read = await sentinelAdapter(ok(JSON.stringify({ ...VIEW, version: 2 }))).agents.sentinelIssues();
    if (!read.ok) expect(read.why).toContain("version 2");
  });

  it("carries the CLI's reason when the store is unreadable, and a kill as never exited", async () => {
    const unreadable = sentinelAdapter({ status: 1, stdout: "", stderr: "sentinel-issues: the issue store at /x is unreadable (bad JSON)\n" });
    expect(await unreadable.agents.sentinelIssues()).toEqual({ ok: false, why: "the issue store at /x is unreadable (bad JSON)" });
    expect(await sentinelAdapter(NEVER_EXITED).agents.sentinelIssues()).toEqual({
      ok: false,
      why: "sentinel/issues.ts did not exit (killed, timed out or never started)",
    });
  });
});

describe("narrowSentinelRules", () => {
  it("copies each rule key only when its JSON type is right, leaving reporter and language behind", () => {
    expect(narrowSentinelRules(undefined)).toBeNull();
    expect(narrowSentinelRules([])).toBeNull();
    expect(
      narrowSentinelRules({
        reporter: { kind: "sentry", org: "o", project: "p" },
        language: "es",
        lookbackHours: 12,
        minEvents: "10",
        minUsers: 3,
        maxPerDay: Number.NaN,
        mode: "file",
      }),
    ).toEqual({ lookbackHours: 12, minUsers: 3, mode: "file" });
    expect(narrowSentinelRules({ mode: "act" })).toEqual({});
  });
});

describe("the Prompts section's reads", () => {
  const promptsAdapter = (answer: Answer, root: string = ROOT) => {
    const recorder = createRecordingExecutor().on(() => true, answer);
    const agents = createAgentsAdapter({
      cliDir: "/nonexistent/cli",
      root,
      project: "proj",
      workspaces: "/nonexistent/ws",
      bunPath: "bun",
      env: { HOME: "/nonexistent/home" },
      exec: recorder.exec,
    });
    return { agents, recorder };
  };

  it("renders a role's prompt in the checkout holding the config, as the loop", async () => {
    const { agents, recorder } = promptsAdapter(ok("# The prompt\n\n"));
    // Verbatim: trailing whitespace is part of what the session receives.
    expect(await agents.renderPrompt("triager", "tria")).toEqual({ ok: true, value: "# The prompt\n\n" });
    const [call] = recorder.calls.map((entry) => entry.invocation);
    expect(call?.command).toBe("bun");
    expect(call?.args).toEqual(["/nonexistent/cli/models.ts", "--render-prompt", "--role", "triager"]);
    // A path that is no git checkout is its own config checkout.
    expect(call?.cwd).toBe(ROOT);
    expect(call?.env).toMatchObject({ HOME: "/nonexistent/home", RALPH_PROJECT: ROOT, RALPH_PROJECT_ID: "proj", RALPH_LOOP_NAME: "tria" });
  });

  it("quotes models.ts's refusal of a render, or names the exit when it says nothing", async () => {
    const refused = promptsAdapter({ status: 1, stdout: "# half a prompt\n", stderr: "models: cannot read the project coder fragment .ralph/coder.md: ENOENT\n" });
    expect(await refused.agents.renderPrompt("coder", "ralph")).toEqual({
      ok: false,
      why: "models: cannot read the project coder fragment .ralph/coder.md: ENOENT",
    });
    const silent = promptsAdapter({ status: 2, stdout: "", stderr: "" });
    expect(await silent.agents.renderPrompt("coder", "ralph")).toEqual({ ok: false, why: "models.ts --render-prompt exited 2" });
  });

  it("reads a project file relative to the checkout, telling missing from refused", () => {
    const root = mkdtempSync(join(tmpdir(), "ralph-project-file-"));
    try {
      mkdirSync(join(root, ".ralph"));
      writeFileSync(join(root, ".ralph", "prompt.md"), "## Project\n");
      const { agents, recorder } = promptsAdapter(ok(""), root);
      expect(agents.readProjectFile(".ralph/prompt.md")).toEqual({ ok: true, value: "## Project\n" });
      expect(agents.readProjectFile(".ralph/coder.md")).toMatchObject({ ok: false, missing: true });
      for (const path of ["../x", ".ralph/../../x", join(root, ".ralph", "prompt.md"), "/etc/passwd"]) {
        expect(agents.readProjectFile(path)).toMatchObject({ ok: false, missing: false });
      }
      // A committed symlink out of the checkout passes the lexical check, so
      // it is refused once resolved; one that stays inside still reads.
      const elsewhere = mkdtempSync(join(tmpdir(), "ralph-project-file-out-"));
      try {
        writeFileSync(join(elsewhere, "secret"), "not the project's\n");
        symlinkSync(join(elsewhere, "secret"), join(root, ".ralph", "plan.md"));
        symlinkSync("prompt.md", join(root, ".ralph", "alias.md"));
        expect(agents.readProjectFile(".ralph/plan.md")).toMatchObject({ ok: false, missing: false });
        expect(agents.readProjectFile(".ralph/alias.md")).toEqual({ ok: true, value: "## Project\n" });
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
      // A file read, never a process.
      expect(recorder.calls).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
