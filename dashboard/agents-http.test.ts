// @vitest-environment node
/**
 * Add agent, Delete agent worktree, a new agent's Start and Remove project,
 * driven through the real handler against a scratch machine.
 *
 * The ends are the only fakes. `git` is a wrapper on PATH that records each
 * argv (and where it ran) and then runs the real git, against a real bare
 * `origin` and a real clone of it: so a test asserts both the argv of `git
 * worktree add`/`remove` and what they did — the worktree on disk, the roster
 * branch's commit on `origin`. `gh` is fake outright: it records its argv,
 * prints a PR URL for `gh pr create`, and answers `gh pr list` from a file.
 * `project-config.ts` and `loop-state.ts` are the harness's own, and a live
 * supervisor is a real `bash …/ralph.sh` process working in the worktree.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAgentsAdapter } from "./agents-adapter";
import type {
  AddAgentResult,
  AgentPreflightView,
  AgentsView,
  CleanUpWorktreesResult,
  GuideView,
  CreateCheckoutResult,
  DeleteAgentResult,
  LabelsView,
  ProjectPromptsView,
  ProjectSettingsView,
  ProposeProjectResult,
  RemoveProjectResult,
  ProposeSentinelResult,
  ProposeVerifierResult,
  RuntimeSnapshot,
  SentinelPanelView,
  SentinelView,
  SetWorktreesResult,
  VerifierView,
  StartResult,
} from "./contracts";
import { coderRoster, type LoopRole } from "./contracts";
import { addNotice } from "./ui/agents-model";
import { createProcessExecutor, createRalphControlAdapter } from "./control-adapter";
import { createRalphLifecycleAdapter } from "./lifecycle-adapter";
import { createProjectRegistry, type ProjectRegistry } from "./projects";
import { createHandler, type ProjectScope } from "./server";
import { bunPath, realGitPath } from "./fixtures";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("serves the dashboard over fixture git repos and a bash supervisor");

const CLI_DIR = join(__dirname, "..");
const BUN = bunPath();
const GIT = realGitPath();
const SEP = "\x1f";
const END = "\x1e";

const scratch: string[] = [];
const children: ChildProcess[] = [];
afterAll(() => scratch.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
afterEach(() => children.splice(0).forEach((child) => child.kill("SIGKILL")));

const CONFIG = {
  repo: "your-org/proj",
  owner: "your-github-login",
  baseBranch: "main",
  displayName: "Proj",
  secrets: { runner: "none", withhold: [] },
  refuseFiles: [],
  envCheck: [],
  requiredChecks: [],
  gates: {},
  promptFragment: ".ralph/prompt.md",
  coderFragment: ".ralph/coder.md",
  plan: ".ralph/plan.md",
  journal: { dir: "journal/proj" },
  loops: ["ralph", "rafa"],
};

interface Machine {
  dir: string;
  root: string;
  origin: string;
  workspaces: string;
  env: Record<string, string>;
  /** Run the real git as the operator would, unrecorded. */
  git: (cwd: string, ...args: string[]) => string;
  gitCalls: () => { cwd: string; args: string[] }[];
  ghCalls: () => string[][];
  /** What the fake `gh pr list` prints. */
  prs: (list: unknown[]) => void;
  /** The labels the fake `gh label list` reports the project already has. */
  labels: (names: string[]) => void;
  /** Labels the fake `gh label create` refuses to create. */
  refuseLabels: (names: string[]) => void;
  /** The check names the fake `gh api` reports on every commit, as check runs. */
  checks: (names: string[]) => void;
  /** Make the fake `gh pr create` fail, as a repo with no push rights would. */
  failPrCreate: () => void;
  /** Kill every `git push` by signal, as the executor's timeout would. */
  killPush: () => void;
  /** Merge a pushed roster branch into `origin/main`, as GitHub's merge button would. */
  merge: (branch: string) => void;
  registry: ProjectRegistry;
  handler: (request: Request) => Promise<Response>;
  /** The runtime the project's observation reads answer with. */
  runtime: { snapshot: RuntimeSnapshot };
  /** A live supervisor working in `worktree`: a real `bash …/ralph.sh`. */
  supervise: (worktree: string) => Promise<ChildProcess>;
}

const script = (path: string, lines: string[]): void => {
  writeFileSync(path, [...lines, ""].join("\n"));
  chmodSync(path, 0o755);
};

const readRecords = (path: string): string[][] => {
  try {
    return readFileSync(path, "utf8")
      .split(END)
      .filter((record) => record !== "")
      .map((record) => record.split(SEP).slice(0, -1));
  } catch {
    return [];
  }
};

/**
 * A scratch machine whose project commits `CONFIG`, or `CONFIG` with `loops`
 * — which may spell roles (`{ name, role }`), as a project's roster can — and
 * any `extra` top-level blocks, such as a `verifier`.
 */
function machine(loops: (string | { name: string; role: string })[] = CONFIG.loops, extra: Record<string, unknown> = {}): Machine {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ralph-agents-http-")));
  scratch.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const gitLog = join(dir, "git-calls");
  const ghLog = join(dir, "gh-calls");
  const prList = join(dir, "gh-pr-list.json");
  const labelList = join(dir, "gh-label-list.json");
  const labelFails = join(dir, "gh-label-fails.txt");
  const prFails = join(dir, "gh-pr-create-fails");
  const pushDies = join(dir, "git-push-dies");
  const checkList = join(dir, "gh-api-checks.json");
  writeFileSync(prList, "[]");
  writeFileSync(checkList, JSON.stringify({ check_runs: [], statuses: [] }));
  writeFileSync(labelList, "[]");
  writeFileSync(labelFails, "");
  script(join(bin, "git"), [
    "#!/usr/bin/env bash",
    `{ printf '%s${SEP}' "$PWD" "$@"; printf '${END}'; } >> ${JSON.stringify(gitLog)}`,
    `if [ "$1" = push ] && [ -f ${JSON.stringify(pushDies)} ]; then echo "pre-push: bun run typecheck" >&2; kill -TERM $$; fi`,
    `exec ${JSON.stringify(GIT)} "$@"`,
  ]);
  script(join(bin, "gh"), [
    "#!/usr/bin/env bash",
    `{ printf '%s${SEP}' "$@"; printf '${END}'; } >> ${JSON.stringify(ghLog)}`,
    `if [ "$1 $2" = "pr create" ]; then [ -f ${JSON.stringify(prFails)} ] && exit 1`,
    '  while [ $# -gt 0 ]; do [ "$1" = "--head" ] && head="$2"; shift; done',
    '  echo "https://github.com/your-org/proj/pull/${#head}"',
    "  exit 0",
    "fi",
    `if [ "$1 $2" = "pr list" ]; then cat ${JSON.stringify(prList)}; exit 0; fi`,
    `if [ "$1 $2" = "label list" ]; then cat ${JSON.stringify(labelList)}; exit 0; fi`,
    // One body answers both the check-runs and the status read: each takes only its own list.
    `if [ "$1" = api ]; then cat ${JSON.stringify(checkList)}; exit 0; fi`,
    `if [ "$1 $2" = "label create" ]; then grep -qxF "$3" ${JSON.stringify(labelFails)} && exit 1; exit 0; fi`,
    "exit 1",
  ]);
  const gitConfig = join(dir, "gitconfig");
  writeFileSync(gitConfig, "[user]\n\tname = fixture\n\temail = fixture@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n");
  const env = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: join(dir, "home"),
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync(GIT, args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });

  // `origin`, seeded with the project's config; the project is a clone of it.
  const seed = join(dir, "seed");
  mkdirSync(join(seed, ".ralph"), { recursive: true });
  git(dir, "init", "--quiet", seed);
  writeFileSync(join(seed, ".ralph", "config.json"), `${JSON.stringify({ ...CONFIG, loops, ...extra }, null, 2)}\n`);
  writeFileSync(join(seed, ".gitignore"), ".ralph/logs/\n.ralph/loop-name\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "seed");
  const origin = join(dir, "origin.git");
  git(dir, "clone", "--quiet", "--bare", seed, origin);
  const root = join(dir, "home", "proj");
  mkdirSync(join(dir, "home"), { recursive: true });
  git(dir, "clone", "--quiet", origin, root);
  writeFileSync(join(root, ".ralph", "loop-name"), "ralph\n");
  const workspaces = join(dir, "home", ".local", "share", "ralph", "workspaces");

  const registryFile = join(dir, "config", "ralph", "projects.json");
  const registry = createProjectRegistry({ file: registryFile, seed: [root], override: null });
  const roster = loops.map((entry) =>
    typeof entry === "string" ? { name: entry, role: "coder" as const } : { name: entry.name, role: (entry.role ?? "coder") as LoopRole },
  );
  const runtime = { snapshot: { roster, loops: [], reconciliation: { orphaned: [], prunable: [] } } as RuntimeSnapshot };
  const executor = createProcessExecutor({ timeoutMs: 60_000 });
  const startScript = join(dir, "start.sh");
  script(startScript, ["#!/bin/sh", 'echo "Started Ralph supervisor (pid 4242)"']);
  const scopes = new Map<string, ProjectScope>();
  const handler = createHandler({
    shell: "<!doctype html>",
    // These requests are built at `http://dashboard/…`, which the Host gate
    // would otherwise refuse; the URLs stay as they are.
    hosts: new Set(["dashboard"]),
    projects: () =>
      registry.list().map((entry) => {
        // Keyed by the folder too, as compose.ts is: a folder set over HTTP
        // reaches the next request's agents adapter.
        const key = JSON.stringify([entry.id, entry.worktrees ?? null]);
        let scope = scopes.get(key);
        if (scope === undefined) {
          const { roots: _roots, ...project } = entry;
          scope = { project, adapter: { read: async () => runtime.snapshot } };
          scopes.set(key, scope);
        }
        return scope;
      }),
    lifecycle: ({ worktree, project }) => ({
      control: createRalphControlAdapter({ cliDir: CLI_DIR, root: worktree, bunPath: BUN, env, exec: executor }),
      lifecycle: createRalphLifecycleAdapter({
        cliDir: CLI_DIR,
        root: worktree,
        bunPath: BUN,
        startScript,
        env: { ...env, ...(project === undefined ? {} : { RALPH_PROJECT_ID: project }) },
        exec: executor,
      }),
    }),
    // As compose.ts does: the registry entry's own folder, when it names one.
    agents: (project) => ({
      agents: createAgentsAdapter({
        cliDir: CLI_DIR,
        root: project.path,
        project: project.id,
        workspaces,
        ...(project.worktrees === undefined ? {} : { worktreesDir: project.worktrees }),
        bunPath: BUN,
        env,
        exec: executor,
      }),
    }),
    registry,
  });

  const fakeHarness = join(dir, "harness");
  mkdirSync(fakeHarness);
  script(join(fakeHarness, "ralph.sh"), ["#!/usr/bin/env bash", "sleep 300"]);

  return {
    dir,
    root,
    origin,
    workspaces,
    env,
    git,
    gitCalls: () => readRecords(gitLog).map(([cwd, ...args]) => ({ cwd: cwd!, args })),
    ghCalls: () => readRecords(ghLog),
    labels: (names) => writeFileSync(labelList, JSON.stringify(names.map((name) => ({ name })))),
    refuseLabels: (names) => writeFileSync(labelFails, names.map((name) => `${name}\n`).join("")),
    checks: (names) => writeFileSync(checkList, JSON.stringify({ check_runs: names.map((name) => ({ name })), statuses: [] })),
    failPrCreate: () => writeFileSync(prFails, ""),
    killPush: () => writeFileSync(pushDies, ""),
    prs: (list) => writeFileSync(prList, JSON.stringify(list)),
    merge: (branch) => git(origin, "update-ref", "refs/heads/main", `refs/heads/${branch}`),
    registry,
    handler,
    runtime,
    supervise: async (worktree) => {
      const child = spawn("bash", [join(fakeHarness, "ralph.sh")], { cwd: worktree, stdio: "ignore" });
      children.push(child);
      // Until bash has exec'd the script, /proc shows no `ralph.sh`.
      for (let tries = 0; tries < 100; tries += 1) {
        try {
          if (readFileSync(`/proc/${child.pid}/cmdline`, "utf8").includes("ralph.sh")) return child;
        } catch {}
        await new Promise((done) => setTimeout(done, 20));
      }
      throw new Error("the fake supervisor did not start");
    },
  };
}

const post = (m: Machine, path: string, body: unknown): Promise<Response> =>
  m.handler(
    new Request(`http://dashboard${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
const get = (m: Machine, path: string): Promise<Response> => m.handler(new Request(`http://dashboard${path}`));

const configAt = (m: Machine, ref: string): { loops: unknown[] } =>
  JSON.parse(m.git(m.origin, "show", `${ref}:.ralph/config.json`)) as { loops: unknown[] };

/** The writes among the recorded git calls: anything but the reads the pages make. */
const WRITE_VERBS = ["worktree add", "worktree remove", "fetch", "push", "checkout", "hash-object", "commit-tree", "update-index", "read-tree"];
const writes = (calls: { args: string[] }[]): string[] =>
  calls.map((call) => call.args.join(" ")).filter((line) => WRITE_VERBS.some((verb) => line.startsWith(verb)));

/** Whether a worktree is on no branch, as `git worktree add <path> <ref>` leaves it. */
const detached = (m: Machine, worktree: string): boolean => {
  try {
    m.git(worktree, "symbolic-ref", "--quiet", "HEAD");
    return false;
  } catch {
    return true;
  }
};

describe("Add agent", () => {
  let m: Machine;
  beforeEach(() => {
    m = machine();
  });

  it("writes a coder as a bare name and creates its label triple and its role's label", async () => {
    expect((await post(m, "/api/p/proj/agents", { name: "nova" })).status).toBe(200);
    expect(configAt(m, "refs/heads/ralph-roster/add-nova").loops).toEqual(["ralph", "rafa", "nova"]);
    const created = m.ghCalls().filter((call) => call[0] === "label" && call[1] === "create").map((call) => call[2]);
    expect(created).toEqual(["nova-wip", "nova-blocked", "nova-done", "migration-applied"]);
  });

  it("writes a role as an object entry and creates the labels that role declares", async () => {
    const response = await post(m, "/api/p/proj/agents", { name: "tria", role: "triager" });
    expect(response.status).toBe(200);
    expect((await response.json()) as AddAgentResult).toMatchObject({ name: "tria", outcome: "added" });
    // The object form is `project-config`'s, not the dashboard's: the role
    // reaches it as `--role` and it decides the spelling.
    expect(configAt(m, "refs/heads/ralph-roster/add-tria").loops).toEqual([
      "ralph",
      "rafa",
      { name: "tria", role: "triager" },
    ]);
    const created = m.ghCalls().filter((call) => call[0] === "label" && call[1] === "create").map((call) => call[2]);
    expect(created.slice(0, 3)).toEqual(["tria-wip", "tria-blocked", "tria-done"]);
    // The triager's own vocabulary, from its descriptor, beyond the triple.
    expect(created).toEqual(expect.arrayContaining(["needs-triage", "ready-for-agent"]));
  });

  it("creates only the labels the project is missing", async () => {
    m.labels(["nova-wip", "Nova-Done"]);
    expect((await post(m, "/api/p/proj/agents", { name: "nova" })).status).toBe(200);
    // Case-insensitively: GitHub would refuse `nova-done` beside `Nova-Done`.
    const created = m.ghCalls().filter((call) => call[0] === "label" && call[1] === "create").map((call) => call[2]);
    expect(created).toEqual(["nova-blocked", "migration-applied"]);
  });

  it("reports a label it could not create, as a field, without failing the add", async () => {
    m.refuseLabels(["nova-blocked"]);
    const response = await post(m, "/api/p/proj/agents", { name: "nova" });
    expect(response.status).toBe(200);
    const result = (await response.json()) as AddAgentResult;
    // The worktree and the PR are real, so this is not a refusal — but the
    // preflight will deny the start until that label exists, so it cannot be
    // reported as a plain success either.
    expect(result.outcome).toBe("added");
    expect(result.labels).toContain("nova-blocked");
    expect(result.why).toContain("nova-blocked");
    expect(addNotice(result).tone).toBe("warn");
  });

  it("says so when the project's labels cannot be read at all", async () => {
    writeFileSync(join(m.dir, "gh-label-list.json"), "not json");
    const result = (await (await post(m, "/api/p/proj/agents", { name: "nova" })).json()) as AddAgentResult;
    expect(result.outcome).toBe("added");
    expect(result.labels).toMatch(/could not be read/);
    expect(addNotice(result).tone).toBe("warn");
  });

  it("creates the labels even when the roster PR could not be opened", async () => {
    // They are the new loop's own; a PR that failed is no reason to skip them.
    m.failPrCreate();
    const result = (await (await post(m, "/api/p/proj/agents", { name: "nova" })).json()) as AddAgentResult;
    expect(result.outcome).toBe("pr-failed");
    expect(result.labels).toBeNull();
    const created = m.ghCalls().filter((call) => call[0] === "label" && call[1] === "create").map((call) => call[2]);
    expect(created).toEqual(["nova-wip", "nova-blocked", "nova-done", "migration-applied"]);
  });

  it("pushes the roster branch past the project's own pre-push hook", async () => {
    // The hook would gate the main checkout's working tree, not the roster
    // commit, and a full-suite hook outlives the executor's timeout.
    script(join(m.root, ".git", "hooks", "pre-push"), ["#!/bin/sh", "echo 'pre-push: refused' >&2", "exit 1"]);
    const result = (await (await post(m, "/api/p/proj/agents", { name: "nova" })).json()) as AddAgentResult;
    expect(result).toMatchObject({ outcome: "added", status: "pending-merge" });
    expect(configAt(m, "refs/heads/ralph-roster/add-nova").loops).toEqual(["ralph", "rafa", "nova"]);
  });

  it("says a push that was killed did not exit, rather than quoting what it printed first", async () => {
    m.killPush();
    const result = (await (await post(m, "/api/p/proj/agents", { name: "nova" })).json()) as AddAgentResult;
    expect(result.outcome).toBe("pr-failed");
    expect(result.why).toContain("git push did not exit (killed, timed out or never started)");
    expect(result.why).not.toContain("pre-push: bun run typecheck");
  });

  it("refuses a role outside the roster's vocabulary before it reaches project-config", async () => {
    const response = await post(m, "/api/p/proj/agents", { name: "nova", role: "sleuth" });
    expect(response.status).toBe(400);
    expect((await response.json()) as { message: string }).toMatchObject({
      message: expect.stringContaining("'role' must be one of"),
    });
    expect(m.ghCalls()).toEqual([]);
  });

  it("makes the worktree at the Orca path from the base branch, writes loop-name, and opens the roster PR", async () => {
    const base = m.git(m.root, "rev-parse", "origin/main").trim();
    const response = await post(m, "/api/p/proj/agents", { name: "nova" });
    expect(response.status).toBe(200);
    const result = (await response.json()) as AddAgentResult;
    const worktree = join(m.workspaces, "proj", "nova-loop");
    expect(result).toMatchObject({
      name: "nova",
      worktree,
      outcome: "added",
      status: "pending-merge",
      pr: { url: expect.stringMatching(/^https:\/\/github\.com\/your-org\/proj\/pull\//), branch: "ralph-roster/add-nova", state: "open" },
    });

    // The worktree: at the Orca path, on the base branch's commit, named nova.
    expect(m.git(worktree, "rev-parse", "HEAD").trim()).toBe(base);
    expect(detached(m, worktree)).toBe(true);
    expect(readFileSync(join(worktree, ".ralph", "loop-name"), "utf8")).toBe("nova\n");
    // Create checkout is specified as making an identical worktree, so the
    // log directory is pinned on BOTH paths, not only the new one.
    expect(statSync(join(worktree, ".ralph", "logs")).isDirectory()).toBe(true);
    expect(m.git(worktree, "status", "--porcelain")).toBe("");
    const add = m.gitCalls().find((call) => call.args[0] === "worktree" && call.args[1] === "add");
    expect(add).toEqual({ cwd: m.root, args: ["worktree", "add", worktree, "origin/main"] });

    // The roster branch: one commit on the base, adding nova and nothing else.
    expect(configAt(m, "refs/heads/ralph-roster/add-nova")).toEqual({ ...CONFIG, loops: ["ralph", "rafa", "nova"] });
    expect(m.git(m.origin, "rev-parse", "refs/heads/ralph-roster/add-nova^").trim()).toBe(base);
    expect(m.git(m.origin, "diff", "--name-only", "main", "ralph-roster/add-nova").trim()).toBe(".ralph/config.json");
    // Nothing was committed to the base branch, and the project's checkout is untouched.
    expect(m.git(m.origin, "rev-parse", "main").trim()).toBe(base);
    expect(m.git(m.root, "status", "--porcelain")).toBe("");

    const create = m.ghCalls().find((call) => call[0] === "pr" && call[1] === "create")!;
    expect(create.slice(0, 10)).toEqual([
      "pr",
      "create",
      "--repo",
      "your-org/proj",
      "--base",
      "main",
      "--head",
      "ralph-roster/add-nova",
      "--title",
      "Ralph roster: add nova",
    ]);
    expect(create[10]).toBe("--body");
  });

  it("refuses a name the roster rules refuse, and creates nothing", async () => {
    for (const [name, problem] of [
      ["rafa", "repeats 'rafa'"],
      ["executor", "names a stage"],
      ["default", "'default'"],
    ] as const) {
      const result = (await (await post(m, "/api/p/proj/agents", { name })).json()) as AddAgentResult;
      expect(result.outcome).toBe("refused");
      expect(result.why).toContain(problem);
      expect(existsSync(join(m.workspaces, "proj", `${name}-loop`))).toBe(false);
    }
    expect(m.gitCalls().some((call) => call.args[0] === "worktree" && call.args[1] === "add")).toBe(false);
    expect(m.ghCalls()).toEqual([]);
  });

  it("answers a name that is not one word with a 400", async () => {
    for (const name of ["Nova", "../escape", "", 7]) {
      const response = await post(m, "/api/p/proj/agents", { name });
      expect(response.status).toBe(400);
    }
    expect(writes(m.gitCalls())).toEqual([]);
  });

  it("refuses a name another worktree already holds, and a path already taken", async () => {
    const taken = (await (await post(m, "/api/p/proj/agents", { name: "ralph" })).json()) as AddAgentResult;
    expect(taken).toMatchObject({ outcome: "refused", why: expect.stringContaining(`${m.root} is already ralph`) });

    expect((await (await post(m, "/api/p/proj/agents", { name: "nova" })).json()).outcome).toBe("added");
    const again = (await (await post(m, "/api/p/proj/agents", { name: "nova" })).json()) as AddAgentResult;
    expect(again).toMatchObject({ outcome: "refused", why: expect.stringContaining("is already nova") });
  });
});

describe("Add agent on a roster that spells roles", () => {
  const ROLED = ["ralph", { name: "tria", role: "triager" }];

  it("adds a coder beside a role loop, keeping the role loop's entry as the base branch wrote it", async () => {
    const m = machine(ROLED);
    const result = (await (await post(m, "/api/p/proj/agents", { name: "nova" })).json()) as AddAgentResult;
    expect(result).toMatchObject({ name: "nova", outcome: "added", status: "pending-merge" });
    expect(configAt(m, "refs/heads/ralph-roster/add-nova")).toEqual({ ...CONFIG, loops: [...ROLED, "nova"] });
    const view = (await (await get(m, "/api/p/proj/agents")).json()) as AgentsView;
    expect(view.problem).toBeNull();
    expect(view.pending.map((agent) => agent.name)).toEqual(["nova"]);
  });

  it("refuses a name a role loop already holds", async () => {
    const m = machine(ROLED);
    const result = (await (await post(m, "/api/p/proj/agents", { name: "tria" })).json()) as AddAgentResult;
    expect(result.outcome).toBe("refused");
    expect(result.why).toContain("repeats 'tria'");
  });
});

describe("re-adding a name", () => {
  it("refuses before making a worktree when origin still has the old roster branch", async () => {
    const m = machine();
    const first = (await (await post(m, "/api/p/proj/agents", { name: "nova" })).json()) as AddAgentResult;
    expect((await (await post(m, "/api/p/proj/agents/delete", { name: "nova", confirm: true })).json()).outcome).toBe("deleted");
    expect(existsSync(first.worktree)).toBe(false);

    const again = (await (await post(m, "/api/p/proj/agents", { name: "nova" })).json()) as AddAgentResult;
    expect(again).toMatchObject({ outcome: "refused", why: expect.stringContaining("origin already has ralph-roster/add-nova") });
    expect(existsSync(first.worktree)).toBe(false);

    // Once the stale branch is gone, the name can come back.
    m.git(m.origin, "update-ref", "-d", "refs/heads/ralph-roster/add-nova");
    expect((await (await post(m, "/api/p/proj/agents", { name: "nova" })).json()).outcome).toBe("added");
  });
});

describe("a new agent: pending merge, then Start unlocks", () => {
  it("shows pending-merge with its PR and refuses Start until the roster change is on the base branch", async () => {
    const m = machine();
    const added = (await (await post(m, "/api/p/proj/agents", { name: "nova" })).json()) as AddAgentResult;
    const worktree = added.worktree;
    m.prs([{ url: added.pr!.url, state: "OPEN", headRefName: "ralph-roster/add-nova" }]);

    const pending = (await (await get(m, "/api/p/proj/agents")).json()) as AgentsView;
    expect(pending).toEqual({
      project: "proj",
      baseBranch: "main",
      pending: [
        {
          name: "nova",
          worktree,
          status: "pending-merge",
          pr: { url: added.pr!.url, branch: "ralph-roster/add-nova", state: "open" },
          // Its role comes off the roster PR's own branch, so the labels a
          // coder needs are checked while that PR is still open.
          role: "coder",
          readiness: expect.arrayContaining([expect.objectContaining({ key: "roster-pr", state: "fail" })]),
        },
      ],
      problem: null,
    });

    const refused = (await (await post(m, "/api/p/proj/agents/start", { name: "nova" })).json()) as StartResult;
    expect(refused).toMatchObject({ loop: "nova", outcome: "refused", pid: null, why: expect.stringContaining("pending merge") });

    // The PR merges on GitHub. With no loop running nothing else fetches, so
    // the page fetches the base branch once itself, and the card unlocks.
    m.merge("ralph-roster/add-nova");
    m.prs([{ url: added.pr!.url, state: "MERGED", headRefName: "ralph-roster/add-nova" }]);
    const beforeFetch = m.gitCalls().length;
    expect(((await (await get(m, "/api/p/proj/agents")).json()) as AgentsView).pending[0]!.status).toBe("ready");
    // A fetch moves origin/main alone: no checkout, no push, no commit.
    expect(writes(m.gitCalls().slice(beforeFetch))).toEqual([expect.stringMatching(/^fetch .*main$/)]);

    // Start fetches, finds nova on the base branch, moves the clean checkout up to it, and starts.
    const started = (await (await post(m, "/api/p/proj/agents/start", { name: "nova" })).json()) as StartResult;
    expect(started).toMatchObject({ loop: "nova", worktree, outcome: "started", pid: 4242 });
    expect(started.why).toContain("moved its checkout up to origin/main");
    expect(JSON.parse(readFileSync(join(worktree, ".ralph", "config.json"), "utf8")).loops).toEqual(["ralph", "rafa", "nova"]);
    expect(readFileSync(join(worktree, ".ralph", "loop-name"), "utf8")).toBe("nova\n");

    // Still ready afterwards, and with the base listing it no fetch is made again.
    const afterStart = m.gitCalls().length;
    expect(((await (await get(m, "/api/p/proj/agents")).json()) as AgentsView).pending[0]!.status).toBe("ready");
    expect(writes(m.gitCalls().slice(afterStart))).toEqual([]);
  });

  it("drops a merged agent once its supervisor runs, though the main checkout's branch predates its entry", async () => {
    const m = machine();
    const added = (await (await post(m, "/api/p/proj/agents", { name: "nova" })).json()) as AddAgentResult;
    m.merge("ralph-roster/add-nova");
    m.git(m.root, "fetch", "--quiet", "origin", "main");
    // The main checkout stays on its own branch, whose config does not list nova.
    expect(JSON.parse(readFileSync(join(m.root, ".ralph", "config.json"), "utf8")).loops).not.toContain("nova");
    expect(((await (await get(m, "/api/p/proj/agents")).json()) as AgentsView).pending.map((a) => [a.name, a.status])).toEqual([
      ["nova", "ready"],
    ]);

    const supervisor = await m.supervise(added.worktree);
    expect(((await (await get(m, "/api/p/proj/agents")).json()) as AgentsView).pending).toEqual([]);

    // Stopped again, it is back to be started.
    supervisor.kill("SIGKILL");
    await new Promise((done) => supervisor.once("exit", done));
    expect(((await (await get(m, "/api/p/proj/agents")).json()) as AgentsView).pending.map((a) => a.status)).toEqual(["ready"]);
  });

  it("keeps a pending-merge agent listed while its supervisor runs", async () => {
    const m = machine();
    const added = (await (await post(m, "/api/p/proj/agents", { name: "nova" })).json()) as AddAgentResult;
    await m.supervise(added.worktree);
    expect(((await (await get(m, "/api/p/proj/agents")).json()) as AgentsView).pending.map((a) => a.status)).toEqual(["pending-merge"]);
  });

  it("gates POST /api/start too: a roster loop whose checkout predates its entry waits for the base branch", async () => {
    const m = machine();
    const added = (await (await post(m, "/api/p/proj/agents", { name: "nova" })).json()) as AddAgentResult;
    // The project's checkout caught up first, so the roster lists nova; nova's own checkout has not.
    m.runtime.snapshot = {
      roster: coderRoster("ralph", "rafa", "nova"),
      loops: [
        {
          worktree: added.worktree,
          identity: "nova",
          loopStatus: "unknown",
          worktreeStatus: "live",
          branch: null,
          state: null,
          stateProblem: null,
          supervisor: "dead",
          presence: null,
        },
      ],
      reconciliation: { orphaned: [], prunable: [] },
    } as RuntimeSnapshot;

    const refused = (await (await post(m, "/api/p/proj/start", { loop: "nova" })).json()) as StartResult;
    expect(refused).toMatchObject({ outcome: "refused", why: expect.stringContaining("pending merge") });

    m.merge("ralph-roster/add-nova");
    const started = (await (await post(m, "/api/p/proj/start", { loop: "nova" })).json()) as StartResult;
    expect(started).toMatchObject({ outcome: "started", pid: 4242 });
  });

  it("starts a loop whose checkout already lists it without fetching", async () => {
    const m = machine();
    m.runtime.snapshot = {
      roster: coderRoster("ralph", "rafa"),
      loops: [
        {
          worktree: m.root,
          identity: "ralph",
          loopStatus: "unknown",
          worktreeStatus: "live",
          branch: null,
          state: null,
          stateProblem: null,
          supervisor: "dead",
          presence: null,
        },
      ],
      reconciliation: { orphaned: [], prunable: [] },
    } as RuntimeSnapshot;
    const started = (await (await post(m, "/api/p/proj/start", { loop: "ralph" })).json()) as StartResult;
    expect(started).toMatchObject({ outcome: "started", pid: 4242 });
    expect(writes(m.gitCalls())).toEqual([]);
  });
});

describe("Create checkout", () => {
  /** The roster of the scratch project lists rafa; only ralph has a worktree. */
  const CHECKOUT = "/api/p/proj/agents/checkout";

  it("makes the worktree Add agent would have made, and touches no roster", async () => {
    const m = machine();
    const base = m.git(m.root, "rev-parse", "origin/main").trim();
    const response = await post(m, CHECKOUT, { name: "rafa" });
    expect(response.status).toBe(200);
    const worktree = join(m.workspaces, "proj", "rafa-loop");
    expect((await response.json()) as CreateCheckoutResult).toMatchObject({
      name: "rafa",
      worktree,
      outcome: "created",
      labels: null,
    });

    // The same worktree Add agent makes: the Orca path, detached at the base
    // branch, carrying its loop-name and the log directory a start needs.
    expect(m.git(worktree, "rev-parse", "HEAD").trim()).toBe(base);
    expect(detached(m, worktree)).toBe(true);
    expect(readFileSync(join(worktree, ".ralph", "loop-name"), "utf8")).toBe("rafa\n");
    expect(statSync(join(worktree, ".ralph", "logs")).isDirectory()).toBe(true);
    expect(m.git(worktree, "status", "--porcelain")).toBe("");
    const add = m.gitCalls().find((call) => call.args[0] === "worktree" && call.args[1] === "add");
    expect(add).toEqual({ cwd: m.root, args: ["worktree", "add", worktree, "origin/main"] });

    // The name is on the roster already, so nothing is pushed and no PR opened.
    expect(m.ghCalls().some((call) => call[0] === "pr" && call[1] === "create")).toBe(false);
    expect(writes(m.gitCalls()).filter((line) => line.startsWith("push"))).toEqual([]);
    expect(m.git(m.origin, "rev-parse", "main").trim()).toBe(base);
    expect(m.git(m.origin, "for-each-ref", "--format=%(refname)", "refs/heads/ralph-roster")).toBe("");
    expect(m.git(m.root, "status", "--porcelain")).toBe("");
  });

  it("creates the loop's own label triple and its role's label", async () => {
    const m = machine();
    expect(((await (await post(m, CHECKOUT, { name: "rafa" })).json()) as CreateCheckoutResult).outcome).toBe("created");
    const created = m.ghCalls().filter((call) => call[0] === "label" && call[1] === "create").map((call) => call[2]);
    expect(created).toEqual(["rafa-wip", "rafa-blocked", "rafa-done", "migration-applied"]);
  });

  it("creates the labels the roster entry's role declares, not a coder's", async () => {
    const m = machine(["ralph", { name: "tria", role: "triager" }]);
    expect(((await (await post(m, CHECKOUT, { name: "tria" })).json()) as CreateCheckoutResult).outcome).toBe("created");
    const created = m.ghCalls().filter((call) => call[0] === "label" && call[1] === "create").map((call) => call[2]);
    expect(created.slice(0, 3)).toEqual(["tria-wip", "tria-blocked", "tria-done"]);
    expect(created).toEqual(expect.arrayContaining(["needs-triage", "ready-for-agent"]));
  });

  it("reports the labels it could not create, with the checkout still made", async () => {
    const m = machine();
    m.refuseLabels(["rafa-blocked"]);
    const result = (await (await post(m, CHECKOUT, { name: "rafa" })).json()) as CreateCheckoutResult;
    // A missing label is a start `preflight` denies, so it is reported in its
    // own field — but it is no reason to undo a worktree that is there.
    expect(result).toMatchObject({ outcome: "created", labels: expect.stringContaining("rafa-blocked") });
    expect(statSync(join(result.worktree, ".ralph", "logs")).isDirectory()).toBe(true);
  });

  it("refuses a name the base branch's roster does not list, and creates nothing", async () => {
    const m = machine();
    const result = (await (await post(m, CHECKOUT, { name: "nova" })).json()) as CreateCheckoutResult;
    expect(result).toMatchObject({ outcome: "refused", labels: null });
    expect(result.why).toContain("does not list nova");
    // It says where an unlisted name gets its worktree instead.
    expect(result.why).toContain("Add agent");
    expect(existsSync(join(m.workspaces, "proj", "nova-loop"))).toBe(false);
    expect(writes(m.gitCalls()).some((line) => line.startsWith("worktree add"))).toBe(false);
    expect(m.ghCalls()).toEqual([]);
  });

  it("refuses a name that already has a checkout, the main one included", async () => {
    const m = machine();
    const taken = (await (await post(m, CHECKOUT, { name: "ralph" })).json()) as CreateCheckoutResult;
    expect(taken).toMatchObject({ outcome: "refused", why: expect.stringContaining(`${m.root} is already ralph`) });

    expect(((await (await post(m, CHECKOUT, { name: "rafa" })).json()) as CreateCheckoutResult).outcome).toBe("created");
    const again = (await (await post(m, CHECKOUT, { name: "rafa" })).json()) as CreateCheckoutResult;
    expect(again).toMatchObject({ outcome: "refused", why: expect.stringContaining("is already rafa") });
  });

  it("answers a name that is not one word with a 400, before any git write", async () => {
    const m = machine();
    for (const name of ["Rafa", "../escape", "", 7]) {
      expect((await post(m, CHECKOUT, { name })).status).toBe(400);
    }
    expect(writes(m.gitCalls())).toEqual([]);
  });

  it("gives a checkout to the only loop a setup PR left on the roster, and Start then applies", async () => {
    // The onboarding case of felipearos/ralph#189: `loops` came from the setup
    // PR, so its one name has no worktree anywhere and Add agent refuses it.
    const m = machine(["solo"]);
    const refusedAdd = (await (await post(m, "/api/p/proj/agents", { name: "solo" })).json()) as AddAgentResult;
    expect(refusedAdd).toMatchObject({ outcome: "refused", why: expect.stringContaining("repeats 'solo'") });

    const created = (await (await post(m, CHECKOUT, { name: "solo" })).json()) as CreateCheckoutResult;
    expect(created).toMatchObject({ name: "solo", outcome: "created" });
    expect(readFileSync(join(created.worktree, ".ralph", "loop-name"), "utf8")).toBe("solo\n");
    expect(statSync(join(created.worktree, ".ralph", "logs")).isDirectory()).toBe(true);

    // Start works on it straight after: the roster the base branch holds
    // already names solo, so the gate has nothing to wait for.
    m.runtime.snapshot = {
      roster: coderRoster("solo"),
      loops: [
        {
          worktree: created.worktree,
          identity: "solo",
          loopStatus: "unknown",
          worktreeStatus: "live",
          branch: null,
          state: null,
          stateProblem: null,
          supervisor: "dead",
          presence: null,
        },
      ],
      reconciliation: { orphaned: [], prunable: [] },
    } as RuntimeSnapshot;
    const started = (await (await post(m, "/api/p/proj/start", { loop: "solo" })).json()) as StartResult;
    expect(started).toMatchObject({ loop: "solo", worktree: created.worktree, outcome: "started", pid: 4242 });
  });
});

describe("a project with its own worktrees folder", () => {
  /** The scratch project, registered with a folder outside the default workspaces. */
  function ownFolder(): { m: Machine; folder: string } {
    const m = machine();
    const folder = join(m.dir, "agents");
    m.registry.setWorktrees("proj", folder);
    return { m, folder };
  }

  it("makes Add agent's worktree in that folder", async () => {
    const { m, folder } = ownFolder();
    const result = (await (await post(m, "/api/p/proj/agents", { name: "nova" })).json()) as AddAgentResult;
    const worktree = join(folder, "nova-loop");
    expect(result).toMatchObject({ name: "nova", worktree, outcome: "added" });
    expect(readFileSync(join(worktree, ".ralph", "loop-name"), "utf8")).toBe("nova\n");
    const add = m.gitCalls().find((call) => call.args[0] === "worktree" && call.args[1] === "add");
    expect(add).toEqual({ cwd: m.root, args: ["worktree", "add", worktree, "origin/main"] });
    expect(existsSync(join(m.workspaces, "proj", "nova-loop"))).toBe(false);
  });

  it("makes Create checkout's worktree in that folder", async () => {
    const { m, folder } = ownFolder();
    const result = (await (await post(m, "/api/p/proj/agents/checkout", { name: "rafa" })).json()) as CreateCheckoutResult;
    const worktree = join(folder, "rafa-loop");
    expect(result).toMatchObject({ name: "rafa", worktree, outcome: "created" });
    expect(readFileSync(join(worktree, ".ralph", "loop-name"), "utf8")).toBe("rafa\n");
    expect(existsSync(join(m.workspaces, "proj", "rafa-loop"))).toBe(false);
  });

  it("reports the folder in Settings as no default, beside the default it would fall back to", async () => {
    const { m, folder } = ownFolder();
    const view = (await (await get(m, "/api/p/proj/settings")).json()) as ProjectSettingsView;
    expect(view).toMatchObject({ worktreesDir: folder, worktreesDefault: false, defaultWorktreesDir: join(m.workspaces, "proj") });
  });

  it("reports the default folder as the default when the project names none", async () => {
    const m = machine();
    const view = (await (await get(m, "/api/p/proj/settings")).json()) as ProjectSettingsView;
    const fallback = join(m.workspaces, "proj");
    expect(view).toMatchObject({ worktreesDir: fallback, worktreesDefault: true, defaultWorktreesDir: fallback });
  });
});

describe("POST /api/settings/worktrees", () => {
  const PATH = "/api/p/proj/settings/worktrees";

  it("sets the project's folder in the registry, and the next Add agent makes its worktree there", async () => {
    const m = machine();
    const folder = join(m.dir, "agents");
    const response = await post(m, PATH, { folder });
    expect(response.status).toBe(200);
    const fallback = join(m.workspaces, "proj");
    expect((await response.json()) as SetWorktreesResult).toEqual({
      project: "proj",
      worktreesDir: folder,
      worktreesDefault: false,
      defaultWorktreesDir: fallback,
    });
    expect(m.registry.list()[0]?.worktrees).toBe(folder);
    const added = (await (await post(m, "/api/p/proj/agents", { name: "nova" })).json()) as AddAgentResult;
    expect(added).toMatchObject({ name: "nova", worktree: join(folder, "nova-loop"), outcome: "added" });
    expect(existsSync(join(fallback, "nova-loop"))).toBe(false);
  });

  it("clears the folder back to the default with null", async () => {
    const m = machine();
    m.registry.setWorktrees("proj", join(m.dir, "agents"));
    const fallback = join(m.workspaces, "proj");
    const response = await post(m, PATH, { folder: null });
    expect(response.status).toBe(200);
    expect((await response.json()) as SetWorktreesResult).toEqual({
      project: "proj",
      worktreesDir: fallback,
      worktreesDefault: true,
      defaultWorktreesDir: fallback,
    });
    expect(m.registry.list()[0]?.worktrees).toBeUndefined();
    const view = (await (await get(m, "/api/p/proj/settings")).json()) as ProjectSettingsView;
    expect(view).toMatchObject({ worktreesDir: fallback, worktreesDefault: true });
  });

  it("refuses a relative path, naming it, and leaves the registry as it was", async () => {
    const m = machine();
    const before = readFileSync(m.registry.file, "utf8");
    const response = await post(m, PATH, { folder: "agents" });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("WorktreesRefused");
    expect(body.message).toContain("must be an absolute path; got 'agents'");
    expect(readFileSync(m.registry.file, "utf8")).toBe(before);
  });

  it("refuses a folder inside another registered project's checkout, naming that project", async () => {
    const m = machine();
    const other = join(m.dir, "home", "other");
    mkdirSync(other, { recursive: true });
    m.registry.add({ path: other, id: "other" });
    const response = await post(m, PATH, { folder: join(other, "agents") });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.message).toContain("inside project 'other''s checkout");
    expect(m.registry.list().find((entry) => entry.id === "proj")?.worktrees).toBeUndefined();
  });

  it("refuses a body without a string or null 'folder' before the registry sees it", async () => {
    const m = machine();
    for (const body of [{}, { folder: 3 }, { path: "/tmp" }, []]) {
      const response = await post(m, PATH, body);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { message: string }).message).toContain("'folder'");
    }
    expect(m.registry.list()[0]?.worktrees).toBeUndefined();
  });

  it("answers GET with 405", async () => {
    const m = machine();
    const response = await get(m, PATH);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});

describe("POST /api/settings/worktrees/cleanup", () => {
  const PATH = "/api/p/proj/settings/worktrees/cleanup";

  it("needs a confirmation", async () => {
    const m = machine();
    const response = await post(m, PATH, { paths: [join(m.workspaces, "proj", "gone-loop")] });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("ConfirmationRequired");
    expect(body.message).toContain("removes git's registration");
  });

  it("refuses a body without a non-empty list of paths", async () => {
    const m = machine();
    for (const body of [{ confirm: true }, { paths: [], confirm: true }, { paths: [""], confirm: true }, { paths: "/tmp/x", confirm: true }, { paths: [3], confirm: true }]) {
      const response = await post(m, PATH, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(writes(m.gitCalls())).toEqual([]);
  });

  it("removes a confirmed stale registration path by path, never with prune", async () => {
    const m = machine();
    const worktree = join(m.workspaces, "proj", "gone-loop");
    m.git(m.root, "worktree", "add", "--quiet", worktree, "origin/main");
    rmSync(worktree, { recursive: true, force: true });
    const response = await post(m, PATH, { paths: [worktree], confirm: true });
    expect(response.status).toBe(200);
    const result = (await response.json()) as CleanUpWorktreesResult;
    expect(result).toMatchObject({ project: "proj", outcome: "done" });
    expect(result.pruned.map((entry) => entry.path)).toEqual([worktree]);
    expect(m.git(m.root, "worktree", "list", "--porcelain")).not.toContain(worktree);
    expect(m.gitCalls().some((call) => call.args.join(" ").startsWith("worktree prune"))).toBe(false);
  });

  it("answers GET with 405", async () => {
    const m = machine();
    const response = await get(m, PATH);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});

describe("Delete agent worktree", () => {
  /** A rafa worktree, as an operator made one before the dashboard could. */
  function rafa(m: Machine): string {
    const worktree = join(m.workspaces, "proj", "rafa-loop");
    m.git(m.root, "worktree", "add", "--quiet", worktree, "origin/main");
    writeFileSync(join(worktree, ".ralph", "loop-name"), "rafa\n");
    return worktree;
  }

  it("needs a confirmation", async () => {
    const m = machine();
    rafa(m);
    const response = await post(m, "/api/p/proj/agents/delete", { name: "rafa" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("ConfirmationRequired");
  });

  it("is refused while the agent's supervisor runs, and removes nothing", async () => {
    const m = machine();
    const worktree = rafa(m);
    await m.supervise(worktree);
    const result = (await (await post(m, "/api/p/proj/agents/delete", { name: "rafa", confirm: true })).json()) as DeleteAgentResult;
    expect(result).toMatchObject({ outcome: "refused", worktree, pr: null, why: expect.stringContaining("supervisor is running") });
    expect(existsSync(worktree)).toBe(true);
    expect(m.gitCalls().some((call) => call.args[1] === "remove")).toBe(false);
    expect(m.ghCalls()).toEqual([]);
  });

  it("otherwise removes the worktree and opens the PR taking the name out of loops", async () => {
    const m = machine();
    const worktree = rafa(m);
    const base = m.git(m.root, "rev-parse", "origin/main").trim();
    const result = (await (await post(m, "/api/p/proj/agents/delete", { name: "rafa", confirm: true })).json()) as DeleteAgentResult;
    expect(result).toMatchObject({
      name: "rafa",
      worktree,
      outcome: "deleted",
      pr: { branch: "ralph-roster/remove-rafa", state: "open", url: expect.stringContaining("/pull/") },
    });
    expect(existsSync(worktree)).toBe(false);
    expect(m.git(m.root, "worktree", "list", "--porcelain")).not.toContain(worktree);
    const remove = m.gitCalls().find((call) => call.args[0] === "worktree" && call.args[1] === "remove");
    expect(remove).toEqual({ cwd: m.root, args: ["worktree", "remove", worktree] });

    expect(configAt(m, "refs/heads/ralph-roster/remove-rafa").loops).toEqual(["ralph"]);
    expect(m.git(m.origin, "rev-parse", "refs/heads/ralph-roster/remove-rafa^").trim()).toBe(base);
    const create = m.ghCalls().find((call) => call[0] === "pr" && call[1] === "create")!;
    expect(create.slice(0, 10)).toEqual([
      "pr", "create", "--repo", "your-org/proj", "--base", "main", "--head", "ralph-roster/remove-rafa", "--title", "Ralph roster: remove rafa",
    ]);
    // The project's checkout and its own files are untouched.
    expect(existsSync(join(m.root, ".ralph", "config.json"))).toBe(true);
  });

  it("opens no PR for an agent the base branch never listed", async () => {
    const m = machine();
    const added = (await (await post(m, "/api/p/proj/agents", { name: "nova" })).json()) as AddAgentResult;
    m.prs([{ url: added.pr!.url, state: "OPEN", headRefName: "ralph-roster/add-nova" }]);
    const creates = m.ghCalls().filter((call) => call[1] === "create").length;
    const result = (await (await post(m, "/api/p/proj/agents/delete", { name: "nova", confirm: true })).json()) as DeleteAgentResult;
    expect(result).toMatchObject({ outcome: "deleted", pr: null, why: expect.stringContaining(`close ${added.pr!.url}`) });
    expect(existsSync(added.worktree)).toBe(false);
    expect(m.ghCalls().filter((call) => call[1] === "create")).toHaveLength(creates);
  });

  it("never removes the main checkout, and lets git refuse a worktree with changes", async () => {
    const m = machine();
    const main = (await (await post(m, "/api/p/proj/agents/delete", { name: "ralph", confirm: true })).json()) as DeleteAgentResult;
    expect(main).toMatchObject({ outcome: "refused", why: expect.stringContaining("never deletes a clone") });
    expect(existsSync(m.root)).toBe(true);

    const worktree = rafa(m);
    writeFileSync(join(worktree, "work-in-progress.txt"), "keep me\n");
    const dirty = (await (await post(m, "/api/p/proj/agents/delete", { name: "rafa", confirm: true })).json()) as DeleteAgentResult;
    expect(dirty).toMatchObject({ outcome: "refused", why: expect.stringContaining("git worktree remove refused") });
    expect(readFileSync(join(worktree, "work-in-progress.txt"), "utf8")).toBe("keep me\n");
    expect(m.ghCalls().some((call) => call[1] === "create")).toBe(false);
  });
});

describe("Remove project", () => {
  it("is refused while any of its agents runs, and then only edits the registry", async () => {
    const m = machine();
    const worktree = join(m.workspaces, "proj", "rafa-loop");
    m.git(m.root, "worktree", "add", "--quiet", worktree, "origin/main");
    const registryBefore = readFileSync(m.registry.file, "utf8");

    expect((await post(m, "/api/projects/remove", { project: "proj" })).status).toBe(400);
    expect((await post(m, "/api/projects/remove", { project: "nope", confirm: true })).status).toBe(404);

    const supervisor = await m.supervise(worktree);
    const refused = (await (await post(m, "/api/projects/remove", { project: "proj", confirm: true })).json()) as RemoveProjectResult;
    expect(refused).toMatchObject({ project: "proj", outcome: "refused", running: [worktree] });
    expect(readFileSync(m.registry.file, "utf8")).toBe(registryBefore);

    supervisor.kill("SIGKILL");
    await new Promise((done) => supervisor.once("exit", done));
    const before = m.gitCalls().length;
    const removed = (await (await post(m, "/api/projects/remove", { project: "proj", confirm: true })).json()) as RemoveProjectResult;
    expect(removed).toMatchObject({ project: "proj", outcome: "removed", running: [] });
    expect(m.registry.list()).toEqual([]);
    expect((await get(m, "/api/p/proj/agents")).status).toBe(404);

    // Nothing on disk or on the remote was touched.
    expect(existsSync(join(m.root, ".ralph", "config.json"))).toBe(true);
    expect(existsSync(worktree)).toBe(true);
    expect(m.git(m.root, "worktree", "list", "--porcelain")).toContain(worktree);
    expect(writes(m.gitCalls().slice(before))).toEqual([]);
    expect(m.ghCalls()).toEqual([]);
  });
});

describe("Remove project under fixed roots", () => {
  it("is refused when the registry is read-only for the run", async () => {
    const m = machine();
    const readOnly = createProjectRegistry({ file: m.registry.file, seed: [], override: [m.root] });
    const handler = createHandler({
      shell: "",
      hosts: new Set(["dashboard"]),
      projects: () => readOnly.list().map(({ roots: _roots, ...project }) => ({ project, adapter: { read: async () => m.runtime.snapshot } })),
      agents: (project) => ({
        agents: createAgentsAdapter({ cliDir: CLI_DIR, root: project.path, project: project.id, workspaces: m.workspaces, bunPath: BUN, env: m.env, exec: createProcessExecutor() }),
      }),
      registry: readOnly,
    });
    const response = await handler(
      new Request("http://dashboard/api/projects/remove", { method: "POST", body: JSON.stringify({ project: "proj", confirm: true }) }),
    );
    expect(await response.json()).toMatchObject({ outcome: "refused", why: expect.stringContaining("read-only") });
    expect(m.registry.list().map((entry) => entry.id)).toEqual(["proj"]);
  });
});

describe("GET /api/agents is read-only", () => {
  it("lists worktrees and PRs, and fetches, pushes and creates nothing", async () => {
    const m = machine();
    const worktree = join(m.workspaces, "proj", "vera-loop");
    m.git(m.root, "worktree", "add", "--quiet", worktree, "origin/main");
    writeFileSync(join(worktree, ".ralph", "loop-name"), "vera\n");
    const view = (await (await get(m, "/api/p/proj/agents")).json()) as AgentsView;
    expect(view.pending).toMatchObject([{ name: "vera", worktree, status: "pending-merge", pr: null, role: null }]);
    expect(writes(m.gitCalls())).toEqual([]);
    // No roster anywhere names it, so the role-dependent items ask nothing:
    // the project's labels and Jav's config are never read for it.
    expect(m.ghCalls().every((call) => call[0] === "pr" && call[1] === "list")).toBe(true);
    expect(existsSync(join(m.workspaces, "proj"))).toBe(true);
  });

  it("answers the readiness items of a merged agent from the real CLIs, reading the project's labels once", async () => {
    const m = machine();
    const added = (await (await post(m, "/api/p/proj/agents", { name: "nova" })).json()) as AddAgentResult;
    expect(added.outcome).toBe("added");
    m.merge("ralph-roster/add-nova");
    // This route never fetches, so the base ref moves only as a running loop
    // or a Start would: here, as the operator. The worktree itself was made
    // before the merge, so it now sits one commit behind the base — the stale
    // checkout the worktree item exists to catch.
    m.git(m.root, "fetch", "origin");
    m.labels(["nova-wip", "nova-blocked"]);
    m.prs([{ url: "https://github.com/o/r/pull/7", state: "MERGED", headRefName: "ralph-roster/add-nova" }]);

    const before = m.gitCalls().length;
    const beforeGh = m.ghCalls().length;
    const view = (await (await get(m, "/api/p/proj/agents")).json()) as AgentsView;
    const agent = view.pending.find((pending) => pending.name === "nova")!;
    expect(agent.status).toBe("ready");
    expect(agent.role).toBe("coder");
    const state = (key: string): string => agent.readiness.find((entry) => entry.key === key)!.state;
    expect(state("roster-pr")).toBe("pass");
    expect(state("worktree")).toBe("fail");
    // `preflight.ts --labels` named nova-done, which the project has not got.
    expect(state("labels")).toBe("fail");
    expect(agent.readiness.find((entry) => entry.key === "labels")!.reason).toContain("nova-done");
    expect(state("node-modules")).toBe("fail");
    // Read-only throughout, and the project's labels are read once.
    expect(writes(m.gitCalls().slice(before))).toEqual([]);
    const since = m.ghCalls().slice(beforeGh);
    expect(since.filter((call) => call[0] === "label" && call[1] === "list")).toHaveLength(1);
    expect(since.some((call) => call[1] === "create")).toBe(false);
  });
});

describe("GET /api/agents/guide", () => {
  it("serves the guide file's own bytes with the project's values, and refuses a POST", async () => {
    const m = machine();
    const view = (await (await get(m, "/api/p/proj/agents/guide")).json()) as GuideView;
    expect(view.problem).toBeNull();
    // The file itself, not a copy: the expectation is read from it at run time.
    expect(view.markdown).toBe(readFileSync(join(CLI_DIR, "adding-an-agent.md"), "utf8"));
    expect(view.values).toEqual({
      project: "proj",
      repo: CONFIG.repo,
      baseBranch: "main",
      root: m.root,
      worktrees: join(m.workspaces, "proj"),
    });
    const posted = await post(m, "/api/p/proj/agents/guide", {});
    expect(posted.status).toBe(405);
    expect(writes(m.gitCalls())).toEqual([]);
  });
});

describe("GET /api/settings", () => {
  it("serves the overview with the registry's checkout and registration date, and refuses a POST", async () => {
    const m = machine();
    const [entry] = m.registry.list();
    const response = await get(m, "/api/p/proj/settings");
    expect(response.status).toBe(200);
    const view = (await response.json()) as ProjectSettingsView;
    expect(view.project).toBe("proj");
    expect(view.checkout).toEqual({ path: entry!.path, addedAt: entry!.addedAt });
    expect(view.checkout.path).toBe(m.root);
    expect(view.config?.repo).toBe(CONFIG.repo);
    expect(view.problems).toEqual([]);
    const posted = await post(m, "/api/p/proj/settings", {});
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET");
    expect(writes(m.gitCalls())).toEqual([]);
  });
});

describe("GET /api/settings/prompts", () => {
  it("serves the Prompts view with the config's fragments and one render per role, and refuses a POST", async () => {
    const m = machine();
    // The fixture's config names all three fragments and commits none but the prompt.
    writeFileSync(join(m.root, ".ralph", "prompt.md"), "# the project's prompt\n");
    const response = await get(m, "/api/p/proj/settings/prompts");
    expect(response.status).toBe(200);
    const view = (await response.json()) as ProjectPromptsView;
    expect(view.problems).toEqual([]);
    expect(view.fragments).toEqual([
      { kind: "prompt", path: ".ralph/prompt.md", text: "# the project's prompt\n", missing: false, problem: null },
      { kind: "coder", path: ".ralph/coder.md", text: null, missing: true, problem: null },
      { kind: "plan", path: ".ralph/plan.md", text: null, missing: true, problem: null },
    ]);
    // Every fixture loop is a coder, so one render, as the first of them;
    // whether models.ts renders here or refuses, the view carries one or the other.
    expect(view.renders).toHaveLength(1);
    expect(view.renders[0]).toMatchObject({ role: "coder", loop: CONFIG.loops[0] });
    expect((view.renders[0]!.prompt === null) !== (view.renders[0]!.error === null)).toBe(true);
    const posted = await post(m, "/api/p/proj/settings/prompts", {});
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET");
  });
});

describe("GET /api/agents/preflight", () => {
  it("says no verdict is available for a pending-merge agent, without running preflight", async () => {
    const m = machine();
    expect(((await (await post(m, "/api/p/proj/agents", { name: "nova" })).json()) as AddAgentResult).outcome).toBe("added");
    const before = m.gitCalls().length;
    const view = (await (await get(m, "/api/p/proj/agents/preflight?name=nova")).json()) as AgentPreflightView;
    expect(view).toMatchObject({ name: "nova", item: { key: "preflight", state: "unknown" } });
    expect(view.item.reason).toContain("no verdict is available until its roster PR merges");
    expect(writes(m.gitCalls().slice(before))).toEqual([]);
  });

  it("names the check that denied a merged agent, out of the real preflight's own JSON", async () => {
    const m = machine();
    expect(((await (await post(m, "/api/p/proj/agents", { name: "nova" })).json()) as AddAgentResult).outcome).toBe("added");
    m.merge("ralph-roster/add-nova");
    m.git(m.root, "fetch", "origin");
    m.labels([]);
    const view = (await (await get(m, "/api/p/proj/agents/preflight?name=nova")).json()) as AgentPreflightView;
    expect(view.item.state).toBe("fail");
    // The real verdict here, and it is the stale-worktree story the checklist
    // tells: the worktree was made before the roster PR merged, so its own
    // `.ralph/config.json` still does not list nova and `loop-identity` is
    // denied. What matters for this item is that the check is NAMED — read out
    // of `checks[].outcome.status`, which is `preflight.ts`'s own shape, and
    // not a flat `state` the CLI never prints. Which OTHER checks deny is the
    // host's business, not this test's: a CI runner with no `gh` token or a
    // missing tool denies `tools` and `frontier-prerequisites` too, and the
    // reason lists them in the CLI's order, so never pin the whole list.
    expect(view.item.reason).toContain("preflight denies the start:");
    expect(view.item.reason).toContain("loop-identity");
    // Not the empty-handed fallback, which is what a parser reading the wrong
    // shape would always produce.
    expect(view.item.reason).not.toContain("run it in the worktree");
  });

  it("resolves the worktree with the cheap reads only, not the whole readiness fold", async () => {
    const m = machine();
    expect(((await (await post(m, "/api/p/proj/agents", { name: "nova" })).json()) as AddAgentResult).outcome).toBe("added");
    const beforeGh = m.ghCalls().length;
    await get(m, "/api/p/proj/agents/preflight?name=nova");
    // The fold's `gh label list` and `gh pr list` are what this route keeps off
    // a button press; a pending agent's preflight does not run at all, so the
    // only `gh` left would be one of those.
    expect(m.ghCalls().slice(beforeGh)).toEqual([]);
  });

  it("refuses a name that is not a pending agent, and a name of the wrong shape", async () => {
    const m = machine();
    const unknown = await get(m, "/api/p/proj/agents/preflight?name=nova");
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toBe("UnknownAgent");
    const shape = await get(m, "/api/p/proj/agents/preflight?name=Nova");
    expect(shape.status).toBe(400);
    const missing = await get(m, "/api/p/proj/agents/preflight");
    expect(missing.status).toBe(400);
    expect((await post(m, "/api/p/proj/agents/preflight", { name: "nova" })).status).toBe(405);
  });
});

describe("GET /api/labels", () => {
  it("lists each label the roster needs with the loops that need it, then the repository's others", async () => {
    const m = machine(["ralph", { name: "doc", role: "ci-doctor" }]);
    writeFileSync(
      join(m.dir, "gh-label-list.json"),
      JSON.stringify([
        { name: "Ralph-WIP", color: "FBCA04", description: "Claimed by the Ralph loop" },
        { name: "ralph-done", color: "5319E7", description: "" },
        { name: "doc-wip", color: "0E8A16", description: "" },
        { name: "bug", color: "d73a4a", description: "Something isn't working" },
      ]),
    );
    const response = await get(m, "/api/p/proj/labels");
    expect(response.status).toBe(200);
    const view = (await response.json()) as LabelsView;
    expect(view).toMatchObject({ project: "proj", repo: "your-org/proj", problems: [] });
    const byName = Object.fromEntries(view.labels.map((label) => [label.name, label]));
    // The preflight's spelling, matched to the repository's case-insensitively,
    // with the repository's colour and an empty description read as none.
    expect(byName["ralph-wip"]).toEqual({
      name: "ralph-wip",
      usedBy: [{ loop: "ralph", role: "coder" }],
      onRepo: true,
      color: "FBCA04",
      description: "Claimed by the Ralph loop",
    });
    expect(byName["ralph-done"]).toMatchObject({ onRepo: true, description: null });
    expect(byName["ralph-blocked"]).toMatchObject({ onRepo: false, color: null });
    // The doctor's own vocabulary, from its role descriptor.
    expect(byName["ci-health"]).toMatchObject({ usedBy: [{ loop: "doc", role: "ci-doctor" }], onRepo: false });
    expect(byName["bug"]).toMatchObject({ usedBy: [], onRepo: true });
    // A coder's frontier labels, which its preflight does not declare; the
    // doctor needs `priority:urgent` too, and each loop is listed once.
    expect(byName["ready-for-agent"]).toMatchObject({ usedBy: [{ loop: "ralph", role: "coder" }], onRepo: false });
    expect(byName["priority:urgent"]?.usedBy).toEqual([
      { loop: "ralph", role: "coder" },
      { loop: "doc", role: "ci-doctor" },
    ]);
    // Read-only: no label is created, nothing is fetched or pushed.
    expect(m.ghCalls().every((call) => call[0] === "label" && call[1] === "list")).toBe(true);
    expect(writes(m.gitCalls())).toEqual([]);
  });

  it("reads every needed label as unknown, not missing, when the repository's labels cannot be read", async () => {
    const m = machine();
    writeFileSync(join(m.dir, "gh-label-list.json"), "not json");
    const view = (await (await get(m, "/api/p/proj/labels")).json()) as LabelsView;
    expect(view.problems).toEqual([expect.stringContaining("cannot read your-org/proj's labels")]);
    expect(view.labels.map((label) => label.name)).toEqual([
      "ralph-wip",
      "ralph-blocked",
      "ralph-done",
      "migration-applied",
      "ready-for-agent",
      "priority:urgent",
      "rafa-wip",
      "rafa-blocked",
      "rafa-done",
    ]);
    expect(view.labels.every((label) => label.onRepo === null)).toBe(true);
  });

  it("warns when the repository's label list came back full", async () => {
    const m = machine();
    m.labels(Array.from({ length: 200 }, (_, index) => `l${index}`));
    const view = (await (await get(m, "/api/p/proj/labels")).json()) as LabelsView;
    expect(view.problems).toEqual([expect.stringContaining("at least 200 labels")]);
  });

  it("is GET-only", async () => {
    const m = machine();
    expect((await post(m, "/api/p/proj/labels", {})).status).toBe(405);
  });
});

describe("the project settings", () => {
  // Each proposal pushes a branch of its own under this prefix, keyed by the change.
  const PREFIX = "ralph-roster/project-settings-";
  const PATH = "/api/p/proj/settings/project";
  const pushes = (m: Machine): string[] => writes(m.gitCalls()).filter((line) => line.startsWith("push"));
  const prCreates = (m: Machine): string[][] => m.ghCalls().filter((call) => call[0] === "pr" && call[1] === "create");
  /** A `dev` branch on origin, so a base-branch edit has somewhere real to point. */
  const withDev = (m: Machine): void => {
    m.git(m.origin, "update-ref", "refs/heads/dev", "refs/heads/main");
  };

  it("opens one PR whose commit, on main, changes only the display name and base branch", async () => {
    const m = machine();
    withDev(m);
    const response = await post(m, PATH, { displayName: "Proj Two", baseBranch: "dev" });
    expect(response.status).toBe(200);
    const result = (await response.json()) as ProposeProjectResult;
    expect(result).toMatchObject({ outcome: "proposed", pr: { state: "open" } });
    const BRANCH = result.outcome === "proposed" ? result.pr.branch : "";
    expect(BRANCH.startsWith(PREFIX)).toBe(true);

    // One commit, straight on the current base.
    expect(m.git(m.origin, "rev-parse", `refs/heads/${BRANCH}^`).trim()).toBe(m.git(m.origin, "rev-parse", "refs/heads/main").trim());
    expect(m.git(m.origin, "diff", "--name-only", "refs/heads/main", `refs/heads/${BRANCH}`).trim()).toBe(".ralph/config.json");
    const { displayName: _name, baseBranch: _base, ...baseRest } = configAt(m, "refs/heads/main") as unknown as Record<string, unknown>;
    const { displayName, baseBranch, ...branchRest } = configAt(m, `refs/heads/${BRANCH}`) as unknown as Record<string, unknown>;
    expect(branchRest).toEqual(baseRest);
    expect({ displayName, baseBranch }).toEqual({ displayName: "Proj Two", baseBranch: "dev" });

    // Against the base the config lives on today, not the one it names next.
    const created = prCreates(m);
    expect(created).toHaveLength(1);
    expect(created[0]![created[0]!.indexOf("--base") + 1]).toBe("main");
    expect(created[0]![created[0]!.indexOf("--head") + 1]).toBe(BRANCH);
    expect(pushes(m)).toHaveLength(1);

    // `dev` was made from main, so its own config still names main: the body
    // says so, or a loop restarted on dev would read it and move back.
    const body = created[0]![created[0]!.indexOf("--body") + 1]!;
    expect(body).toContain("`dev`'s own `.ralph/config.json` still names `main`");
    expect(body).toContain("check out `dev` in its worktree");
  });

  it("refuses a base branch only a longer ref on origin ends with, pushing nothing", async () => {
    const m = machine();
    // `ls-remote --heads origin dev` would tail-match this one.
    m.git(m.origin, "update-ref", "refs/heads/x/dev", "refs/heads/main");
    const result = (await (await post(m, PATH, { baseBranch: "dev" })).json()) as ProposeProjectResult;
    expect(result).toEqual({ outcome: "refused", why: expect.stringContaining("does not exist on origin") });
    expect(pushes(m)).toEqual([]);
    expect(prCreates(m)).toEqual([]);
  });

  it("refuses a malformed base branch in the config's words before asking origin", async () => {
    const m = machine();
    const result = (await (await post(m, PATH, { baseBranch: "a b" })).json()) as ProposeProjectResult;
    expect(result).toEqual({ outcome: "refused", why: expect.stringContaining("'baseBranch' must be a branch name") });
    expect(m.gitCalls().some((call) => call.args.includes("ls-remote"))).toBe(false);
    expect(pushes(m)).toEqual([]);
    expect(prCreates(m)).toEqual([]);
  });

  it("refuses a base branch with no config of its own, pushing nothing", async () => {
    const m = machine();
    const empty = m.git(m.origin, "hash-object", "-t", "tree", "-w", "/dev/null").trim();
    const bare = m.git(m.origin, "commit-tree", empty, "-m", "no config").trim();
    m.git(m.origin, "update-ref", "refs/heads/bare", bare);
    const result = (await (await post(m, PATH, { baseBranch: "bare" })).json()) as ProposeProjectResult;
    expect(result).toEqual({ outcome: "refused", why: expect.stringContaining("the base branch 'bare' has no readable .ralph/config.json") });
    expect(pushes(m)).toEqual([]);
    expect(prCreates(m)).toEqual([]);
  });

  it("links the open PR again for the same change, pushing nothing", async () => {
    const m = machine();
    const first = (await (await post(m, PATH, { displayName: "Proj Two" })).json()) as ProposeProjectResult;
    expect(first.outcome).toBe("proposed");
    const url = first.outcome === "proposed" ? first.pr.url : "";
    const BRANCH = first.outcome === "proposed" ? first.pr.branch : "";
    m.prs([{ url: "https://github.com/o/r/pull/1", state: "OPEN", headRefName: "ralph-roster/add-nova" }, { url, state: "OPEN", headRefName: BRANCH }]);
    const pushed = pushes(m).length;
    const created = prCreates(m).length;

    const again = (await (await post(m, PATH, { displayName: "Proj Two" })).json()) as ProposeProjectResult;
    expect(again).toMatchObject({ outcome: "reused", pr: { url, branch: BRANCH } });
    expect(pushes(m)).toHaveLength(pushed);
    expect(prCreates(m)).toHaveLength(created);
  });

  it("refuses a base branch origin does not have, pushing nothing", async () => {
    const m = machine();
    const result = (await (await post(m, PATH, { baseBranch: "nowhere" })).json()) as ProposeProjectResult;
    expect(result).toEqual({ outcome: "refused", why: expect.stringContaining("does not exist on origin") });
    expect(pushes(m)).toEqual([]);
    expect(prCreates(m)).toEqual([]);
  });

  it("refuses a Save that changes nothing", async () => {
    const m = machine();
    const result = (await (await post(m, PATH, { displayName: "Proj", baseBranch: "main" })).json()) as ProposeProjectResult;
    expect(result).toEqual({ outcome: "refused", why: expect.stringContaining("nothing to change") });
    expect(pushes(m)).toEqual([]);
    expect(prCreates(m)).toEqual([]);
  });

  it("refuses a display name the config validation refuses, in its own words", async () => {
    const m = machine();
    const result = (await (await post(m, PATH, { displayName: "Proj\nTwo" })).json()) as ProposeProjectResult;
    expect(result).toEqual({ outcome: "refused", why: expect.stringContaining("'displayName' must be a non-empty single-line string") });
    expect(pushes(m)).toEqual([]);
    expect(prCreates(m)).toEqual([]);
  });

  it("opens one PR whose commit changes only the gates, required checks and refused files", async () => {
    const m = machine();
    m.checks(["test"]);
    const response = await post(m, PATH, {
      gates: [
        { name: "typecheck", command: "bun run typecheck" },
        { name: "test", command: "bun run test" },
      ],
      requiredChecks: ["test"],
      refuseFiles: ["secrets.env"],
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as ProposeProjectResult;
    expect(result).toMatchObject({ outcome: "proposed", pr: { state: "open" }, warnings: [] });
    const BRANCH = result.outcome === "proposed" ? result.pr.branch : "";
    expect(BRANCH.startsWith(PREFIX)).toBe(true);

    expect(m.git(m.origin, "rev-parse", `refs/heads/${BRANCH}^`).trim()).toBe(m.git(m.origin, "rev-parse", "refs/heads/main").trim());
    const { gates: _gates, requiredChecks: _checks, refuseFiles: _refuse, ...baseRest } = configAt(m, "refs/heads/main") as unknown as Record<string, unknown>;
    const { gates, requiredChecks, refuseFiles, ...branchRest } = configAt(m, `refs/heads/${BRANCH}`) as unknown as Record<string, unknown>;
    expect(branchRest).toEqual(baseRest);
    expect({ gates, requiredChecks, refuseFiles }).toEqual({
      gates: { typecheck: "bun run typecheck", test: "bun run test" },
      requiredChecks: ["test"],
      refuseFiles: ["secrets.env"],
    });
    // The config keeps the list's order: gates run in it.
    expect(Object.keys(gates as Record<string, string>)).toEqual(["typecheck", "test"]);

    const created = prCreates(m);
    expect(created).toHaveLength(1);
    expect(created[0]![created[0]!.indexOf("--title") + 1]).toBe("Ralph settings: gates, required checks and refused files");
    expect(created[0]![created[0]!.indexOf("--body") + 1]).not.toContain("Warnings");
    expect(pushes(m)).toHaveLength(1);
  });

  it("refuses a duplicate gate name and an invalid refused path together, pushing nothing", async () => {
    const m = machine();
    const result = (await (
      await post(m, PATH, {
        gates: [
          { name: "test", command: "bun run test" },
          { name: "test", command: "bun x vitest" },
        ],
        refuseFiles: ["/etc/passwd"],
      })
    ).json()) as ProposeProjectResult;
    expect(result.outcome).toBe("refused");
    const why = result.outcome === "refused" ? result.why : "";
    expect(why).toContain("gate name 'test' is listed more than once");
    expect(why).toContain("'refuseFiles[0]' must be relative to the project root");
    expect(pushes(m)).toEqual([]);
    expect(prCreates(m)).toEqual([]);
  });

  it("refuses an empty gate name in the same list as the config's own problems", async () => {
    const m = machine();
    const result = (await (await post(m, PATH, { gates: [{ name: " ", command: "true" }] })).json()) as ProposeProjectResult;
    expect(result).toEqual({ outcome: "refused", why: expect.stringContaining("must not be empty") });
    expect(pushes(m)).toEqual([]);
  });

  it("warns, but still proposes, a required check nothing has reported, and not one that has", async () => {
    const m = machine();
    m.checks(["lint"]);
    const result = (await (await post(m, PATH, { requiredChecks: ["lint", "tset"] })).json()) as ProposeProjectResult;
    expect(result).toMatchObject({ outcome: "proposed" });
    const warnings = result.outcome === "proposed" ? result.warnings : [];
    expect(warnings).toEqual([
      "no check named 'tset' has been reported on your-org/proj recently; a required check nothing reports holds every hand-off",
    ]);
    const created = prCreates(m);
    expect(created).toHaveLength(1);
    expect(created[0]![created[0]!.indexOf("--body") + 1]).toContain(`- ${warnings[0]}`);
    // The same Save while that PR is open links it again, with the same warning.
    const url = result.outcome === "proposed" ? result.pr.url : "";
    const BRANCH = result.outcome === "proposed" ? result.pr.branch : "";
    m.prs([{ url, state: "OPEN", headRefName: BRANCH }]);
    const again = (await (await post(m, PATH, { requiredChecks: ["lint", "tset"] })).json()) as ProposeProjectResult;
    expect(again).toMatchObject({ outcome: "reused", warnings });
  });

  it("warns once when the reported checks cannot be read", async () => {
    const m = machine();
    writeFileSync(join(m.dir, "gh-api-checks.json"), "not json");
    const result = (await (await post(m, PATH, { requiredChecks: ["test"] })).json()) as ProposeProjectResult;
    expect(result).toMatchObject({ outcome: "proposed", warnings: [expect.stringContaining("could not check the new required check names")] });
  });

  it("refuses gates, checks and refused files the base already has", async () => {
    const m = machine(CONFIG.loops, { gates: { test: "bun run test" }, requiredChecks: ["test"], refuseFiles: ["a.env"] });
    const result = (await (
      await post(m, PATH, { gates: [{ name: "test", command: "bun run test" }], requiredChecks: ["test"], refuseFiles: ["a.env"] })
    ).json()) as ProposeProjectResult;
    expect(result).toEqual({ outcome: "refused", why: expect.stringContaining("nothing to change") });
    expect(m.ghCalls().some((call) => call[0] === "api")).toBe(false);
    expect(pushes(m)).toEqual([]);
    expect(prCreates(m)).toEqual([]);
  });

  it("opens one PR whose commit writes the worktree setup steps in the config's compact form", async () => {
    const m = machine();
    const response = await post(m, PATH, {
      worktreeSetup: [
        { name: "install", command: "bun install --frozen-lockfile", timeoutSeconds: 120, installsDependencies: true },
        { name: "env", command: "cp .env.example .env.local", timeoutSeconds: 30, installsDependencies: false },
      ],
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as ProposeProjectResult;
    expect(result).toMatchObject({ outcome: "proposed", pr: { state: "open" } });
    const BRANCH = result.outcome === "proposed" ? result.pr.branch : "";

    const { worktreeSetup: _none, ...baseRest } = configAt(m, "refs/heads/main") as unknown as Record<string, unknown>;
    const { worktreeSetup, ...branchRest } = configAt(m, `refs/heads/${BRANCH}`) as unknown as Record<string, unknown>;
    expect(branchRest).toEqual(baseRest);
    // A default is left out, so a hand-written config is not rewritten with them.
    expect(worktreeSetup).toEqual([
      { name: "install", command: "bun install --frozen-lockfile", installsDependencies: true },
      { name: "env", command: "cp .env.example .env.local", timeoutSeconds: 30 },
    ]);
    const created = prCreates(m);
    expect(created).toHaveLength(1);
    expect(created[0]![created[0]!.indexOf("--title") + 1]).toBe("Ralph settings: worktree setup steps");
    expect(pushes(m)).toHaveLength(1);
  });

  it("clears the worktree setup steps with an empty list, and refuses the list the base already has", async () => {
    const steps = [{ name: "install", command: "bun install", timeoutSeconds: 60, installsDependencies: true }];
    const m = machine(CONFIG.loops, { worktreeSetup: [{ name: "install", command: "bun install", timeoutSeconds: 60, installsDependencies: true }] });
    const unchanged = (await (await post(m, PATH, { worktreeSetup: steps })).json()) as ProposeProjectResult;
    expect(unchanged).toEqual({ outcome: "refused", why: expect.stringContaining("nothing to change") });
    expect(pushes(m)).toEqual([]);

    const cleared = (await (await post(m, PATH, { worktreeSetup: [] })).json()) as ProposeProjectResult;
    expect(cleared).toMatchObject({ outcome: "proposed" });
    const BRANCH = cleared.outcome === "proposed" ? cleared.pr.branch : "";
    expect((configAt(m, `refs/heads/${BRANCH}`) as unknown as Record<string, unknown>).worktreeSetup).toEqual([]);
  });

  it("refuses duplicate setup step names and too long a total in project-config's words, pushing nothing", async () => {
    const m = machine();
    const result = (await (
      await post(m, PATH, {
        worktreeSetup: [
          { name: "install", command: "bun install", timeoutSeconds: 100, installsDependencies: true },
          { name: "install", command: "bun run build", timeoutSeconds: 100, installsDependencies: false },
        ],
      })
    ).json()) as ProposeProjectResult;
    expect(result.outcome).toBe("refused");
    const why = result.outcome === "refused" ? result.why : "";
    expect(why).toContain("'worktreeSetup[1].name' 'install' is a duplicate");
    expect(why).toContain("'worktreeSetup' may take at most 150 s in all");
    expect(pushes(m)).toEqual([]);
    expect(prCreates(m)).toEqual([]);
  });

  it("answers a body of the wrong shape with a 400 and a GET with a 405", async () => {
    const m = machine();
    for (const body of [
      {},
      [],
      "Proj",
      { displayName: "Proj Two", repo: "o/r" },
      { displayName: 3 },
      { baseBranch: null },
      { gates: { test: "bun run test" } },
      { gates: [{ name: "test", command: "bun run test", cwd: "." }] },
      { gates: [{ name: "test" }] },
      { requiredChecks: "test" },
      { refuseFiles: [3] },
      { worktreeSetup: { install: "bun install" } },
      { worktreeSetup: [{ name: "install", command: "bun install", timeoutSeconds: 120 }] },
      { worktreeSetup: [{ name: "install", command: "bun install", timeoutSeconds: 120, installsDependencies: false, cwd: "." }] },
      { worktreeSetup: [{ name: "install", command: "bun install", timeoutSeconds: "120", installsDependencies: false }] },
      { worktreeSetup: [{ name: "install", command: "bun install", timeoutSeconds: 120, installsDependencies: "no" }] },
    ]) {
      expect((await post(m, PATH, body)).status).toBe(400);
    }
    expect(writes(m.gitCalls())).toEqual([]);
    expect((await get(m, PATH)).status).toBe(405);
  });
});

describe("the sentinel", () => {
  // Where a sentinel looks is no rule: the form keeps it, and the panel never shows it.
  const REPORTER = { kind: "sentry", org: "your-org", project: "proj" };
  const SENTINEL = { reporter: REPORTER, language: "es", lookbackHours: 48, mode: "file" };
  const PREFIX = "ralph-roster/sentinel-rules-";
  const RULES = { lookbackHours: 12, minEvents: 3, minUsers: 1, maxPerDay: 2, mode: "observe" };
  const sentinelMachine = (extra: Record<string, unknown> = {}): Machine =>
    machine(["ralph", { name: "sent", role: "sentinel" }], { sentinel: SENTINEL, ...extra });
  /** A project that asks for config PRs: the save is exactly what it was before #787. */
  const prMachine = (): Machine => sentinelMachine({ configChanges: "pr" });
  /** The issue store the CLI reads, in the checkout's git common directory. */
  const storeFile = (m: Machine): string => join(m.root, ".git", "ralph", "sentinel-issues.json");
  const corruptStore = (m: Machine): void => {
    mkdirSync(join(m.root, ".git", "ralph"), { recursive: true });
    writeFileSync(storeFile(m), "{ not json");
  };

  it("serves the panel: the checkout's rules with defaults filled in, and its issue store", async () => {
    const m = sentinelMachine();
    const response = await get(m, "/api/p/proj/sentinel");
    expect(response.status).toBe(200);
    const view = (await response.json()) as SentinelPanelView;
    expect(view).toEqual({
      rostered: true,
      rules: { enabled: true, lookbackHours: 48, minEvents: 10, minUsers: 2, maxPerDay: 5, mode: "file" },
      // No store yet is an empty view, not a failure.
      issues: { version: 1, issues: [], today: expect.objectContaining({ filed: 0 }) },
      problem: null,
    });
    // The relayed view carries no reporter: where the sentinel looks stays on the machine.
    expect(JSON.stringify(view)).not.toContain("your-org");
  });

  it("does not read the store of a project with no sentinel", async () => {
    const m = machine();
    // An unreadable store would be a problem, were it read.
    corruptStore(m);
    expect((await (await get(m, "/api/p/proj/sentinel")).json()) as SentinelPanelView).toEqual({
      rostered: false,
      rules: null,
      issues: null,
      problem: null,
    });
  });

  it("says why when the store cannot be read, keeping the rules", async () => {
    const m = sentinelMachine();
    corruptStore(m);
    const response = await get(m, "/api/p/proj/sentinel");
    expect(response.status).toBe(200);
    const view = (await response.json()) as SentinelPanelView;
    expect(view).toMatchObject({ rostered: true, rules: { mode: "file" }, issues: null });
    expect(view.problem).toEqual(expect.any(String));
    expect(view.problem).not.toBe("");
  });

  it("reads the rules the base branch's sentinel block spells, and nothing when there is no block", async () => {
    const m = sentinelMachine();
    const response = await get(m, "/api/p/proj/agents/sentinel");
    expect(response.status).toBe(200);
    expect((await response.json()) as SentinelView).toEqual({
      baseBranch: "main",
      rostered: true,
      configured: true,
      rules: { lookbackHours: 48, mode: "file" },
      pending: null,
      configChanges: "commit",
    });

    const bare = machine();
    expect((await (await get(bare, "/api/p/proj/agents/sentinel")).json()) as SentinelView).toEqual({
      baseBranch: "main",
      rostered: false,
      configured: false,
      rules: null,
      pending: null,
      configChanges: "commit",
    });
  });

  it("commits the rules straight onto the base branch as a fast-forward, changing only the sentinel block's rules (#787)", async () => {
    const m = sentinelMachine();
    const before = m.git(m.origin, "rev-parse", "refs/heads/main").trim();
    const response = await post(m, "/api/p/proj/agents/sentinel", { rules: RULES });
    expect(response.status).toBe(200);
    const result = (await response.json()) as ProposeSentinelResult;
    const subject = "ralph: sentinel rules — lookbackHours, minEvents, minUsers, maxPerDay and mode";
    expect(result).toEqual({ outcome: "committed", commit: { branch: "main", sha: expect.stringMatching(/^[0-9a-f]{40}$/), subject } });
    const sha = result.outcome === "committed" ? result.commit.sha : "";

    // origin's main is the new commit, and its only parent is the main it replaced: a fast-forward.
    expect(m.git(m.origin, "rev-parse", "refs/heads/main").trim()).toBe(sha);
    expect(m.git(m.origin, "rev-parse", `${sha}^@`).trim()).toBe(before);
    expect(m.git(m.origin, "diff", "--name-only", before, sha).trim()).toBe(".ralph/config.json");
    const { sentinel: after, ...rest } = configAt(m, "refs/heads/main") as Record<string, unknown>;
    const { sentinel: _was, ...restBefore } = configAt(m, before) as Record<string, unknown>;
    expect(rest).toEqual(restBefore);
    expect(after).toEqual({ reporter: REPORTER, language: "es", ...RULES });
    expect(m.git(m.origin, "log", "-1", "--format=%B", sha)).toContain("- mode file → observe");
    expect(m.git(m.origin, "log", "-1", "--format=%s", sha).trim()).toBe(subject);

    // No PR, no rules branch, and nothing forced.
    expect(m.ghCalls().filter((call) => call[0] === "pr" && call[1] === "create")).toEqual([]);
    expect(m.git(m.origin, "for-each-ref", "--format=%(refname)", "refs/heads/ralph-roster/").trim()).toBe("");
    const pushes = writes(m.gitCalls()).filter((line) => line.startsWith("push"));
    expect(pushes).toEqual([`push --no-verify origin ${sha}:refs/heads/main`]);

    // The sheet's read shows the committed rules as the base branch's.
    expect((await (await get(m, "/api/p/proj/agents/sentinel")).json()) as SentinelView).toMatchObject({
      rules: { lookbackHours: 12, mode: "observe" },
      pending: null,
    });
  });

  it("names a single change in the commit subject, and refuses a save that changes nothing", async () => {
    const m = sentinelMachine();
    const full = { lookbackHours: 48, minEvents: 10, minUsers: 2, maxPerDay: 5, mode: "observe" };
    const result = (await (await post(m, "/api/p/proj/agents/sentinel", { rules: full })).json()) as ProposeSentinelResult;
    expect(result).toMatchObject({ outcome: "committed", commit: { subject: "ralph: sentinel rules — mode file → observe" } });
    const again = (await (await post(m, "/api/p/proj/agents/sentinel", { rules: full })).json()) as ProposeSentinelResult;
    expect(again).toEqual({ outcome: "refused", why: "nothing to save: these are already the sentinel rules on origin/main" });
  });

  it("switches the sentinel off and back on, each a commit naming only `enabled` (#789)", async () => {
    const m = sentinelMachine();
    // What the sheet's switch sends: the base branch's rules, defaults filled in, only `enabled` changed.
    const base = { enabled: true, lookbackHours: 48, minEvents: 10, minUsers: 2, maxPerDay: 5, mode: "file" };
    const off = (await (await post(m, "/api/p/proj/agents/sentinel", { rules: { ...base, enabled: false } })).json()) as ProposeSentinelResult;
    expect(off).toMatchObject({ outcome: "committed", commit: { branch: "main", subject: "ralph: sentinel rules — enabled true → false" } });
    expect((configAt(m, "refs/heads/main") as Record<string, unknown>).sentinel).toMatchObject({ reporter: REPORTER, language: "es", enabled: false });
    // The sheet and the cards read it back as off.
    expect((await (await get(m, "/api/p/proj/agents/sentinel")).json()) as SentinelView).toMatchObject({ rules: { enabled: false, mode: "file" } });

    const on = (await (await post(m, "/api/p/proj/agents/sentinel", { rules: base })).json()) as ProposeSentinelResult;
    expect(on).toMatchObject({ outcome: "committed", commit: { subject: "ralph: sentinel rules — enabled false → true" } });
    expect((await (await get(m, "/api/p/proj/agents/sentinel")).json()) as SentinelView).toMatchObject({ rules: { enabled: true } });
  });

  it("refuses an `enabled` that is not a boolean, in the config's words", async () => {
    const m = sentinelMachine();
    const result = (await (await post(m, "/api/p/proj/agents/sentinel", { rules: { ...RULES, enabled: "off" } })).json()) as ProposeSentinelResult;
    expect(result).toEqual({ outcome: "refused", why: expect.stringContaining("'sentinel.enabled' must be true or false; got \"off\"") });
    expect(writes(m.gitCalls()).filter((line) => line.startsWith("push"))).toEqual([]);
  });

  it("falls back to a rules PR, saying why, when the base branch refuses the push", async () => {
    const m = sentinelMachine();
    // As a protected branch would: origin declines any update to main.
    script(join(m.origin, "hooks", "pre-receive"), [
      "#!/bin/sh",
      "while read old new ref; do [ \"$ref\" = refs/heads/main ] && { echo 'main is protected' >&2; exit 1; }; done",
      "exit 0",
    ]);
    const before = m.git(m.origin, "rev-parse", "refs/heads/main").trim();
    const result = (await (await post(m, "/api/p/proj/agents/sentinel", { rules: RULES })).json()) as ProposeSentinelResult;
    expect(result).toMatchObject({ outcome: "proposed", notCommitted: "pre-receive hook declined", pr: { state: "open" } });
    const BRANCH = result.outcome === "proposed" ? result.pr.branch : "";
    expect(BRANCH).toMatch(new RegExp(`^${PREFIX}\\d{8}T\\d{9}Z$`));
    expect(m.git(m.origin, "rev-parse", "refs/heads/main").trim()).toBe(before);
    expect((configAt(m, `refs/heads/${BRANCH}`) as Record<string, unknown>).sentinel).toEqual({ reporter: REPORTER, language: "es", ...RULES });
    const created = m.ghCalls().find((call) => call[0] === "pr" && call[1] === "create");
    expect(created).toEqual(expect.arrayContaining(["Ralph sentinel: rules", BRANCH]));
    expect(created?.join(" ")).toContain("could not commit to `main` directly: pre-receive hook declined");
  });

  it("falls back to a PR when origin's main moved after the fetch, and never forces over it", async () => {
    const m = sentinelMachine();
    // Between the save's fetch and its push, someone else lands a commit on main.
    const other = join(m.dir, "other");
    m.git(m.dir, "clone", "--quiet", m.origin, other);
    writeFileSync(join(other, "README.md"), "someone else's commit\n");
    m.git(other, "add", "README.md");
    m.git(other, "commit", "--quiet", "-m", "race");
    // The race is staged by the git wrapper: just before the push to main, the other clone pushes first.
    const wrapper = join(m.dir, "bin", "git");
    const original = readFileSync(wrapper, "utf8").split("\n");
    original.splice(
      2,
      0,
      `case "$*" in *":refs/heads/main"*) ${JSON.stringify(realGitPath())} -C ${JSON.stringify(other)} push --quiet origin HEAD:refs/heads/main ;; esac`,
    );
    writeFileSync(wrapper, original.join("\n"));
    const result = (await (await post(m, "/api/p/proj/agents/sentinel", { rules: RULES })).json()) as ProposeSentinelResult;
    expect(result).toMatchObject({ outcome: "proposed", notCommitted: expect.stringContaining("the branch moved since it was fetched") });
    // The other commit is still main: the save did not overwrite it.
    expect(m.git(m.origin, "log", "-1", "--format=%s", "refs/heads/main").trim()).toBe("race");
  });

  it("with configChanges pr, proposes rules as a PR whose commit changes only the sentinel block's rules", async () => {
    const m = prMachine();
    const response = await post(m, "/api/p/proj/agents/sentinel", { rules: RULES });
    expect(response.status).toBe(200);
    const result = (await response.json()) as ProposeSentinelResult;
    expect(result).toMatchObject({ outcome: "proposed", pr: { state: "open" } });
    const BRANCH = result.outcome === "proposed" ? result.pr.branch : "";
    expect(BRANCH).toMatch(new RegExp(`^${PREFIX}\\d{8}T\\d{9}Z$`));

    expect(m.git(m.origin, "diff", "--name-only", "refs/heads/main", `refs/heads/${BRANCH}`).trim()).toBe(".ralph/config.json");
    const { sentinel: before, ...baseRest } = configAt(m, "refs/heads/main") as Record<string, unknown>;
    const { sentinel: after, ...branchRest } = configAt(m, `refs/heads/${BRANCH}`) as Record<string, unknown>;
    expect(branchRest).toEqual(baseRest);
    expect(before).toEqual(SENTINEL);
    expect(after).toEqual({ reporter: REPORTER, language: "es", ...RULES });

    const created = m.ghCalls().find((call) => call[0] === "pr" && call[1] === "create");
    expect(created).toEqual(expect.arrayContaining(["Ralph sentinel: rules", BRANCH]));
  });

  it("with configChanges pr, refuses a second proposal while the first one's PR is open, naming it", async () => {
    const m = prMachine();
    const first = (await (await post(m, "/api/p/proj/agents/sentinel", { rules: RULES })).json()) as ProposeSentinelResult;
    expect(first.outcome).toBe("proposed");
    const url = first.outcome === "proposed" ? first.pr.url : "";
    const BRANCH = first.outcome === "proposed" ? first.pr.branch : "";
    // A verifier rules PR open beside it is no sentinel rules PR.
    m.prs([{ url: "https://github.com/o/r/pull/1", state: "OPEN", headRefName: "ralph-roster/verifier-rules-x" }, { url, state: "OPEN", headRefName: BRANCH }]);

    expect((await (await get(m, "/api/p/proj/agents/sentinel")).json()) as SentinelView).toMatchObject({
      pending: { url, branch: BRANCH, state: "open" },
    });
    const pushes = writes(m.gitCalls()).filter((line) => line.startsWith("push")).length;
    const again = (await (await post(m, "/api/p/proj/agents/sentinel", { rules: RULES })).json()) as ProposeSentinelResult;
    expect(again).toEqual({ outcome: "refused", why: expect.stringContaining(url) });
    expect(writes(m.gitCalls()).filter((line) => line.startsWith("push")).length).toBe(pushes);
  });

  it("skips the open-PR lookup on ?pending=skip, answering no pending PR", async () => {
    const m = sentinelMachine();
    const url = "https://github.com/o/r/pull/4";
    m.prs([{ url, state: "OPEN", headRefName: `${PREFIX}x` }]);
    const response = await get(m, "/api/p/proj/agents/sentinel?pending=skip");
    expect(response.status).toBe(200);
    expect((await response.json()) as SentinelView).toMatchObject({ rules: { lookbackHours: 48, mode: "file" }, pending: null });
    expect(m.ghCalls().filter((call) => call[0] === "pr" && call[1] === "list")).toEqual([]);
    // Any other value reads it as before.
    expect((await (await get(m, "/api/p/proj/agents/sentinel?pending=read")).json()) as SentinelView).toMatchObject({ pending: { url } });
  });

  it("answers a body without an object of rules with a 400", async () => {
    const m = sentinelMachine();
    for (const body of [{}, { rules: [] }, { rules: "mode=file" }]) {
      expect((await post(m, "/api/p/proj/agents/sentinel", body)).status).toBe(400);
    }
    expect(writes(m.gitCalls())).toEqual([]);
  });

  it("answers the panel GET only", async () => {
    const m = sentinelMachine();
    expect((await post(m, "/api/p/proj/sentinel", {})).status).toBe(405);
  });
});

describe("the verifier rules", () => {
  // What a verifier needs before any rule: where production is, where a deploy
  // is learned of and which Sentry project to read (`verifierProblems`).
  const VERIFIER = {
    productionUrl: "https://proj.example.com",
    deploy: { source: "vercel", project: "proj" },
    sentry: { org: "your-org", project: "proj" },
    windowHours: 36,
    follow: { loopPrs: true },
  };
  // Each proposal pushes a branch of its own under this prefix.
  const PREFIX = "ralph-roster/verifier-rules-";
  const RULES = {
    windowHours: 48,
    checkIns: [1, 12, 48],
    trafficFloor: false,
    revert: { rateFactor: 3, minEvents: 20, minUsers: 4 },
    follow: { loopPrs: true, humanPrs: false },
    mode: "report",
  };
  const verifierMachine = (extra: Record<string, unknown> = {}): Machine =>
    machine(["ralph", { name: "sent", role: "verifier" }], { verifier: VERIFIER, ...extra });

  it("reads the rules the base branch's verifier block spells, and nothing when there is no block", async () => {
    const m = verifierMachine();
    const response = await get(m, "/api/p/proj/agents/verifier");
    expect(response.status).toBe(200);
    expect((await response.json()) as VerifierView).toEqual({
      baseBranch: "main",
      rostered: true,
      configured: true,
      // Only the rule keys, and only those the block spells: production,
      // deploy and Sentry are no rules, and a default is not a choice.
      rules: { windowHours: 36, follow: { loopPrs: true } },
      pending: null,
      configChanges: "commit",
    });

    const bare = machine();
    expect((await (await get(bare, "/api/p/proj/agents/verifier")).json()) as VerifierView).toEqual({
      baseBranch: "main",
      rostered: false,
      configured: false,
      rules: null,
      pending: null,
      configChanges: "commit",
    });
  });

  it("with configChanges pr, proposes rules as a PR whose commit changes only the verifier block's rules", async () => {
    const m = verifierMachine({ configChanges: "pr" });
    const response = await post(m, "/api/p/proj/agents/verifier", { rules: RULES });
    expect(response.status).toBe(200);
    const result = (await response.json()) as ProposeVerifierResult;
    expect(result).toMatchObject({ outcome: "proposed", pr: { state: "open" } });
    const BRANCH = result.outcome === "proposed" ? result.pr.branch : "";
    expect(BRANCH).toMatch(new RegExp(`^${PREFIX}\\d{8}T\\d{9}Z$`));

    expect(m.git(m.origin, "diff", "--name-only", "refs/heads/main", `refs/heads/${BRANCH}`).trim()).toBe(".ralph/config.json");
    const { verifier: before, ...baseRest } = configAt(m, "refs/heads/main") as Record<string, unknown>;
    const { verifier: after, ...branchRest } = configAt(m, `refs/heads/${BRANCH}`) as Record<string, unknown>;
    expect(branchRest).toEqual(baseRest);
    expect(before).toEqual(VERIFIER);
    const { productionUrl, deploy, sentry } = VERIFIER;
    expect(after).toEqual({ productionUrl, deploy, sentry, ...RULES });

    const created = m.ghCalls().find((call) => call[0] === "pr" && call[1] === "create");
    expect(created).toEqual(expect.arrayContaining(["Ralph verifier: rules", BRANCH]));
  });

  it("refuses rules the config validation refuses, in its own words, and pushes nothing", async () => {
    const m = verifierMachine();
    const response = await post(m, "/api/p/proj/agents/verifier", { rules: { ...RULES, follow: { loopPrs: false, humanPrs: false } } });
    expect(response.status).toBe(200);
    expect((await response.json()) as ProposeVerifierResult).toEqual({
      outcome: "refused",
      why: expect.stringContaining("'verifier.follow' must follow loop PRs, human PRs or both"),
    });
    expect(writes(m.gitCalls()).filter((line) => line.startsWith("push"))).toEqual([]);
  });

  it("commits the rules straight onto the base branch, naming each change (#787)", async () => {
    const m = verifierMachine();
    const before = m.git(m.origin, "rev-parse", "refs/heads/main").trim();
    const result = (await (await post(m, "/api/p/proj/agents/verifier", { rules: { ...RULES, mode: "observe" } })).json()) as ProposeVerifierResult;
    expect(result).toMatchObject({ outcome: "committed", commit: { branch: "main" } });
    const sha = result.outcome === "committed" ? result.commit.sha : "";
    expect(m.git(m.origin, "rev-parse", "refs/heads/main").trim()).toBe(sha);
    expect(m.git(m.origin, "rev-parse", `${sha}^@`).trim()).toBe(before);
    const { productionUrl, deploy, sentry } = VERIFIER;
    expect((configAt(m, "refs/heads/main") as Record<string, unknown>).verifier).toEqual({ productionUrl, deploy, sentry, ...RULES, mode: "observe" });
    const body = m.git(m.origin, "log", "-1", "--format=%B", sha);
    expect(body).toContain("- windowHours 36 → 48");
    expect(body).toContain("- checkIns [1, 6, 24] → [1, 12, 48]");
    expect(body).toContain("- follow.humanPrs true → false");
    expect(body).not.toContain("- mode");
    expect(m.ghCalls().filter((call) => call[0] === "pr" && call[1] === "create")).toEqual([]);
  });

  it("switches the verifier off as a commit naming only `enabled` (#789)", async () => {
    const m = verifierMachine();
    const base = {
      enabled: true,
      windowHours: 36,
      checkIns: [1, 6, 24],
      trafficFloor: true,
      revert: { rateFactor: 5, minEvents: 10, minUsers: 2 },
      follow: { loopPrs: true, humanPrs: true },
      mode: "observe",
    };
    const off = (await (await post(m, "/api/p/proj/agents/verifier", { rules: { ...base, enabled: false } })).json()) as ProposeVerifierResult;
    expect(off).toMatchObject({ outcome: "committed", commit: { subject: "ralph: verifier rules — enabled true → false" } });
    expect((configAt(m, "refs/heads/main") as Record<string, unknown>).verifier).toMatchObject({ productionUrl: VERIFIER.productionUrl, enabled: false });
    expect((await (await get(m, "/api/p/proj/agents/verifier")).json()) as VerifierView).toMatchObject({ rules: { enabled: false } });
  });

  it("with configChanges pr, refuses a second proposal while the first one's PR is open, naming it", async () => {
    const m = verifierMachine({ configChanges: "pr" });
    const first = (await (await post(m, "/api/p/proj/agents/verifier", { rules: RULES })).json()) as ProposeVerifierResult;
    expect(first.outcome).toBe("proposed");
    const url = first.outcome === "proposed" ? first.pr.url : "";
    const BRANCH = first.outcome === "proposed" ? first.pr.branch : "";
    // Another PR open beside it is no rules PR.
    m.prs([{ url: "https://github.com/o/r/pull/1", state: "OPEN", headRefName: "ralph-roster/add-nova" }, { url, state: "OPEN", headRefName: BRANCH }]);

    expect((await (await get(m, "/api/p/proj/agents/verifier")).json()) as VerifierView).toMatchObject({
      pending: { url, branch: BRANCH, state: "open" },
    });
    const again = (await (await post(m, "/api/p/proj/agents/verifier", { rules: RULES })).json()) as ProposeVerifierResult;
    expect(again).toEqual({ outcome: "refused", why: expect.stringContaining(url) });

    // Once that PR has merged its head branch may stay on origin; the next
    // proposal pushes a branch of its own instead of being refused for good.
    m.prs([{ url, state: "MERGED", headRefName: BRANCH }]);
    const next = (await (await post(m, "/api/p/proj/agents/verifier", { rules: { ...RULES, mode: "act" } })).json()) as ProposeVerifierResult;
    expect(next).toMatchObject({ outcome: "proposed", pr: { state: "open" } });
    const nextBranch = next.outcome === "proposed" ? next.pr.branch : "";
    expect(nextBranch).not.toBe(BRANCH);
    expect((configAt(m, `refs/heads/${nextBranch}`) as unknown as { verifier: { mode: string } }).verifier.mode).toBe("act");
  });

  it("answers a body without an object of rules with a 400", async () => {
    const m = verifierMachine();
    for (const body of [{}, { rules: [] }, { rules: "mode=act" }]) {
      expect((await post(m, "/api/p/proj/agents/verifier", body)).status).toBe(400);
    }
    expect(writes(m.gitCalls())).toEqual([]);
  });
});
