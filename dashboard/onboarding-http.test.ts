// @vitest-environment node
/**
 * Adding a project and setting it up, driven through the real handler.
 *
 * Only `gh` is faked: it logs its argv, lists repos, "clones" from a local
 * bare origin, and remembers the PR it "created". git is the real one, against
 * that bare origin, so the setup branch, the push and a merge are real. Every
 * assertion is on what crosses the surface: HTTP status and JSON, the registry
 * file, the files on the pushed branch, and the argv `gh` received.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { coderRoster } from "./contracts";
import type { RuntimeSnapshot } from "./contracts";
import { RalphContractError } from "./adapter";
import { createProcessExecutor } from "./control-adapter";
import { bunPath, realGitPath } from "./fixtures";
import { createOnboarding } from "./onboarding";
import { createOnboardingAdapter } from "./onboarding-adapter";
import { createProjectRegistry } from "./projects";
import { createHandler, type ProjectScope } from "./server";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("sets projects up through git and the project-config CLI");

const REPO_ROOT = join(__dirname, "..");
const GIT = realGitPath();

const scratch: string[] = [];
afterAll(() => scratch.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const IDENTITY = {
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(GIT, ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...IDENTITY },
    stdio: ["ignore", "pipe", "pipe"],
  });

/**
 * A scratch machine: `$HOME`, a bare origin for `acme/widget` whose `main`
 * has a `package.json` and no Ralph config, and a fake `gh` in `bin`.
 */
function machine(
  label: string,
  {
    identity = true,
    seedFiles = {},
    harness,
    readsNeedConfig = false,
    statusTtlMs = 0,
  }: {
    identity?: boolean;
    seedFiles?: Record<string, string>;
    /** Reads fail as the real adapter's do while the checkout has no `.ralph/config.json`. */
    readsNeedConfig?: boolean;
    /** How long a status read is reused; by default every read derives afresh. */
    statusTtlMs?: number;
    /** Where the harness checkout is on this machine; by default, this repo. */
    harness?: (paths: { root: string; home: string }) => string;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `ralph-onboarding-${label}-`)));
  scratch.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);

  const origin = join(root, "widget.git");
  git(root, "init", "--quiet", "--bare", origin);
  const seed = join(root, "seed");
  git(root, "init", "--quiet", seed);
  writeFileSync(
    join(seed, "package.json"),
    JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit", dev: "vite" } }),
  );
  writeFileSync(join(seed, "bun.lock"), "{}\n");
  for (const [file, text] of Object.entries(seedFiles)) {
    mkdirSync(join(seed, file, ".."), { recursive: true });
    writeFileSync(join(seed, file), text);
  }
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "initial");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "--quiet", "origin", "main");
  git(origin, "symbolic-ref", "HEAD", "refs/heads/main");

  const calls = join(root, "gh-calls.jsonl");
  const prs = join(root, "gh-prs.json");
  const repos = join(root, "gh-repos.json");
  const createFails = join(root, "gh-create-fails");
  // While present: every gh call fails, or only `gh pr list`, as an outage would.
  const ghDown = join(root, "gh-down");
  const prListDown = join(root, "gh-pr-list-down");
  // What main's latest commit reported: a CI job, a bot's run and a skipped
  // job, and one commit status.
  const checkRuns = join(root, "gh-check-runs.json");
  const commitStatus = join(root, "gh-status.json");
  writeFileSync(
    checkRuns,
    JSON.stringify({
      total_count: 3,
      check_runs: [
        { name: "test", conclusion: "success", app: { slug: "github-actions" } },
        { name: "Dependabot", conclusion: "success", app: { slug: "dependabot" } },
        { name: "deploy", conclusion: "skipped", app: { slug: "github-actions" } },
      ],
    }),
  );
  writeFileSync(commitStatus, JSON.stringify({ state: "success", statuses: [{ context: "buildkite/widget", state: "success" }] }));
  writeFileSync(
    repos,
    JSON.stringify([
      { nameWithOwner: "acme/widget", description: "A widget", isPrivate: false },
      { nameWithOwner: "acme/gadget", description: "", isPrivate: true },
    ]),
  );
  // Each call is logged as a JSON argv, so arguments with spaces survive.
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/usr/bin/env bash",
      `${JSON.stringify(bunPath())} -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@" >> ${JSON.stringify(calls)}`,
      `if [ -e ${JSON.stringify(ghDown)} ]; then echo "error connecting to api.github.com" >&2; exit 1; fi`,
      `if [ "$1 $2" = "pr list" ] && [ -e ${JSON.stringify(prListDown)} ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi`,
      'case "$1 $2" in',
      `  "repo list") cat ${JSON.stringify(repos)} ;;`,
      `  "repo clone") if [ "$3" = acme/missing ]; then echo "GraphQL: Could not resolve to a Repository" >&2; exit 1; fi; exec ${JSON.stringify(GIT)} clone --quiet ${JSON.stringify(origin)} "$4" ;;`,
      "  \"repo view\") echo '{\"nameWithOwner\":\"acme/widget\"}' ;;",
      '  "api user") echo octo ;;',
      `  "api repos/acme/widget/commits/main/check-runs?per_page=100") cat ${JSON.stringify(checkRuns)} ;;`,
      `  "api repos/acme/widget/commits/main/status") cat ${JSON.stringify(commitStatus)} ;;`,
      `  "pr list") if [ -e ${JSON.stringify(prs)} ]; then cat ${JSON.stringify(prs)}; else echo '[]'; fi ;;`,
      '  "pr create")',
      `    if [ -e ${JSON.stringify(createFails)} ]; then rm ${JSON.stringify(createFails)}; echo "HTTP 502: Bad Gateway" >&2; exit 1; fi`,
      `    echo '[{"number":7,"url":"https://github.com/acme/widget/pull/7","headRefName":"ralph-setup","baseRefName":"main","state":"OPEN"}]' >${JSON.stringify(prs)}`,
      '    echo "https://github.com/acme/widget/pull/7" ;;',
      '  *) echo "unexpected gh $*" >&2; exit 1 ;;',
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "gh"), 0o755);

  const registry = createProjectRegistry({ file: join(root, "config", "ralph", "projects.json"), seed: [], override: null });
  const onboarding = createOnboarding({
    adapter: createOnboardingAdapter({
      cliDir: REPO_ROOT,
      ...(harness === undefined ? {} : { harness: harness({ root, home }) }),
      home,
      bunPath: bunPath(),
      // Without an identity, and forbidden to guess one, `git commit` fails.
      env: identity
        ? { ...IDENTITY, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` }
        : {
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "user.useConfigOnly",
            GIT_CONFIG_VALUE_0: "true",
            GIT_AUTHOR_NAME: "",
            GIT_AUTHOR_EMAIL: "",
            GIT_COMMITTER_NAME: "",
            GIT_COMMITTER_EMAIL: "",
            EMAIL: "",
            HOME: home,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
          },
      exec: createProcessExecutor(),
    }),
    registry,
    // Every read derives afresh by default, so a transition shows on the next request.
    statusTtlMs,
  });

  const runtime = (worktree: string): RuntimeSnapshot => ({
    roster: coderRoster("ralph"),
    loops: [
      {
        worktree,
        identity: "ralph",
        loopStatus: "idle",
        worktreeStatus: "live",
        branch: "main",
        state: null,
        stateProblem: null,
        supervisor: "dead",
        presence: null,
      },
    ],
    reconciliation: { orphaned: [], prunable: [] },
  });
  const started: string[] = [];
  const read = async (path: string): Promise<RuntimeSnapshot> => {
    if (readsNeedConfig && !existsSync(join(path, ".ralph", "config.json"))) {
      throw new RalphContractError("roster", "cannot read the project config");
    }
    return runtime(path);
  };
  const handler = createHandler({
    projects: (): ProjectScope[] =>
      registry.list().map(({ roots: _roots, ...project }) => ({
        project,
        adapter: { read: () => read(project.path) },
        ...(readsNeedConfig
          ? {
              usage: async (): Promise<never> => {
                await read(project.path);
                throw new Error("usage read reached");
              },
            }
          : {}),
      })),
    shell: "<html>shell</html>",
    onboarding,
    ...(readsNeedConfig
      ? {
          records: () => {
            throw new Error("records reached");
          },
        }
      : {}),
    lifecycle: ({ worktree }) => {
      started.push(worktree);
      throw new Error("start reached lifecycle dispatch");
    },
  });
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await handler(
      new Request(`http://127.0.0.1${path}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const ghCalls = (): string[][] =>
    existsSync(calls)
      ? readFileSync(calls, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[])
      : [];

  /** A local clone of the origin, as the operator would already have one. */
  const localClone = (name: string): string => {
    const path = join(root, name);
    git(root, "clone", "--quiet", origin, path);
    return path;
  };
  /** Merge the setup branch on the origin, and close its PR. */
  const mergeSetup = (): void => {
    git(origin, "update-ref", "refs/heads/main", "refs/heads/ralph-setup");
    writeFileSync(prs, "[]");
  };

  /** Make the next `gh pr create` fail, as a network blip would. */
  const failNextPrCreate = (): void => writeFileSync(createFails, "");

  /** Take every gh call down, or only `gh pr list`, until restored. */
  const ghOutage = (scope: "all" | "pr list" | "none"): void => {
    rmSync(ghDown, { force: true });
    rmSync(prListDown, { force: true });
    if (scope === "all") writeFileSync(ghDown, "");
    if (scope === "pr list") writeFileSync(prListDown, "");
  };

  return { root, home, origin, registry, request, ghCalls, localClone, mergeSetup, started, failNextPrCreate, ghOutage };
}

describe("adding a local project", () => {
  it("registers a git checkout by absolute path, in needs-setup when it has no config on its base", async () => {
    const m = machine("local");
    const path = m.localClone("widget");
    const added = await m.request("POST", "/api/projects", { source: "local", path });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ project: { id: "widget", path, source: "local" }, status: "needs-setup" });
    expect(m.registry.list().map((project) => project.path)).toEqual([path]);
    expect((await m.request("GET", "/api/projects")).body.projects).toMatchObject([{ id: "widget", path }]);
  });

  it("refuses a relative path, a missing directory, a non-git directory and a duplicate, each with the reason", async () => {
    const m = machine("local-refusals");
    const plain = join(m.root, "plain");
    mkdirSync(plain);
    const path = m.localClone("widget");
    await m.request("POST", "/api/projects", { source: "local", path });

    const cases: [unknown, number, string, RegExp][] = [
      [{ source: "local", path: "widget" }, 422, "RelativePath", /must be absolute/],
      [{ source: "local", path: join(m.root, "nope") }, 422, "NoSuchDirectory", /no directory at/],
      [{ source: "local", path: plain }, 422, "NotAGitRepository", /not a git repository/],
      [{ source: "local", path }, 409, "AlreadyRegistered", /already registered/],
      [{ source: "local" }, 400, "InvalidRequest", /'path' is required/],
      [{ source: "ftp", path }, 400, "InvalidRequest", /'source'/],
    ];
    for (const [body, status, error, message] of cases) {
      const answer = await m.request("POST", "/api/projects", body);
      expect(answer.status, JSON.stringify(body)).toBe(status);
      expect(answer.body.error).toBe(error);
      expect(answer.body.message).toMatch(message);
    }
    expect(m.registry.list()).toHaveLength(1);
  });

  it("gives another repo with the same directory name a suffixed id", async () => {
    const m = machine("local-same-name");
    const first = m.localClone("widget");
    mkdirSync(join(m.root, "other"));
    git(join(m.root, "other"), "clone", "--quiet", m.origin, "widget");
    await m.request("POST", "/api/projects", { source: "local", path: first });
    const second = await m.request("POST", "/api/projects", { source: "local", path: join(m.root, "other", "widget") });
    expect(second.status).toBe(201);
    expect(second.body.project).toMatchObject({ id: "widget-2", path: join(m.root, "other", "widget") });
  });

  it("refuses the harness checkout and its worktrees, and accepts another clone of the same repo", async () => {
    const m = machine("local-harness", { harness: ({ root }) => join(root, "harness") });
    const harness = m.localClone("harness");
    const worktree = join(m.root, "harness-wt");
    git(harness, "worktree", "add", "--quiet", "-b", "side", worktree);

    for (const path of [harness, worktree]) {
      const answer = await m.request("POST", "/api/projects", { source: "local", path });
      expect(answer.status, path).toBe(409);
      expect(answer.body.error).toBe("HarnessCheckout");
      expect(answer.body.message).toMatch(/harness checkout .* separate directory/);
    }
    expect(m.registry.list()).toEqual([]);

    const other = m.localClone("ralph");
    const added = await m.request("POST", "/api/projects", { source: "local", path: other });
    expect(added.status).toBe(201);
    expect(added.body.project).toMatchObject({ path: other });
  });

  it("registers a project whose config is already on its base as ready", async () => {
    const m = machine("local-ready");
    const seed = m.localClone("seed-ready");
    mkdirSync(join(seed, ".ralph"));
    writeFileSync(join(seed, ".ralph", "config.json"), "{}\n");
    git(seed, "add", "-A");
    git(seed, "commit", "--quiet", "-m", "config");
    git(seed, "push", "--quiet", "origin", "main");
    const path = m.localClone("widget");
    const added = await m.request("POST", "/api/projects", { source: "local", path });
    expect(added.body).toMatchObject({ status: "ready" });
  });
});

describe("adding a project from GitHub", () => {
  it("lists the operator's repos", async () => {
    const m = machine("github-list");
    const listed = await m.request("GET", "/api/github/repos");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({
      repos: [
        { nameWithOwner: "acme/widget", description: "A widget", isPrivate: false },
        { nameWithOwner: "acme/gadget", description: null, isPrivate: true },
      ],
    });
    expect(m.ghCalls()).toEqual([["repo", "list", "--limit", "200", "--json", "nameWithOwner,description,isPrivate"]]);
  });

  it("clones owner/name into ~/<name> and registers it, then refuses a second clone over it", async () => {
    const m = machine("github-clone");
    const added = await m.request("POST", "/api/projects", { source: "github", repo: "acme/widget" });
    const target = join(m.home, "widget");
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ project: { id: "widget", path: target, source: "github" }, status: "needs-setup" });
    expect(existsSync(join(target, "package.json"))).toBe(true);
    expect(m.ghCalls().filter((call) => call[0] === "repo")).toEqual([["repo", "clone", "acme/widget", target]]);

    // The target exists now: nothing is cloned over it, and the refusal names it.
    m.registry.remove("widget");
    const again = await m.request("POST", "/api/projects", { source: "github", repo: "acme/widget" });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: "CloneTargetExists", path: target });
    expect(m.ghCalls().filter((call) => call[1] === "clone")).toHaveLength(1);

    // …and it can be registered as the local project it already is.
    const local = await m.request("POST", "/api/projects", { source: "local", path: again.body.path });
    expect(local.status).toBe(201);
    expect(local.body).toMatchObject({ project: { path: target, source: "local" } });
  });

  it("never offers the harness as the existing checkout to register", async () => {
    const m = machine("github-harness", { harness: ({ home }) => join(home, "widget") });
    git(m.home, "clone", "--quiet", m.origin, "widget");
    const answer = await m.request("POST", "/api/projects", { source: "github", repo: "acme/widget" });
    expect(answer.status).toBe(409);
    expect(answer.body.error).toBe("HarnessCheckout");
    expect(answer.body.path).toBeUndefined();
    expect(answer.body.message).toContain("as a local checkout");
    expect(m.ghCalls()).toEqual([]);
    expect(m.registry.list()).toEqual([]);
  });

  it("reports a failed clone with gh's reason and registers nothing", async () => {
    const m = machine("github-clone-fails");
    const answer = await m.request("POST", "/api/projects", { source: "github", repo: "acme/missing" });
    expect(answer.status).toBe(502);
    expect(answer.body).toMatchObject({ error: "CloneFailed", message: expect.stringContaining("Could not resolve") });
    expect(m.registry.list()).toEqual([]);
  });

  it("refuses a repo that is not owner/name without calling gh", async () => {
    const m = machine("github-invalid");
    const answer = await m.request("POST", "/api/projects", { source: "github", repo: "widget" });
    expect(answer.status).toBe(422);
    expect(answer.body.error).toBe("InvalidRepo");
    expect(m.ghCalls()).toEqual([]);
  });
});

describe("setting a project up", () => {
  const candidate = (over: Record<string, unknown> = {}) => ({
    repo: "acme/widget",
    owner: "octo",
    baseBranch: "main",
    displayName: "widget",
    secrets: { runner: "none", withhold: [] },
    refuseFiles: [],
    envCheck: [],
    requiredChecks: ["test", "buildkite/widget"],
    gates: { test: "bun run test", typecheck: "bun run typecheck" },
    promptFragment: ".ralph/prompt.md",
    coderFragment: ".ralph/coder.md",
    plan: ".ralph/plan.md",
    journal: { dir: "journal/widget" },
    loops: ["ralph"],
    ...over,
  });

  it("pre-fills the form from git, gh and package.json, with the checks main reported as required", async () => {
    const m = machine("setup-defaults");
    await m.request("POST", "/api/projects", { source: "local", path: m.localClone("widget") });
    const defaults = await m.request("GET", "/api/p/widget/setup/defaults");
    expect(defaults.status).toBe(200);
    expect(defaults.body).toEqual({ project: "widget", config: candidate() });
  });

  it("shows every problem project-config finds, at once", async () => {
    const m = machine("setup-validate");
    await m.request("POST", "/api/projects", { source: "local", path: m.localClone("widget") });
    const valid = await m.request("POST", "/api/p/widget/setup/validate", { config: candidate() });
    expect(valid.body).toEqual({ valid: true, problems: [] });
    const invalid = await m.request("POST", "/api/p/widget/setup/validate", {
      config: candidate({ repo: "widget", loops: [], gates: { Test: "x" } }),
    });
    expect(invalid.body.valid).toBe(false);
    expect(invalid.body.problems).toEqual([
      "'repo' must be 'owner/name'",
      "gate name 'Test' must be lowercase kebab-case",
      "'loops' must name at least one loop",
    ]);
  }, 30_000);

  it("opens a setup PR, goes pending, and turns ready by itself once it merges; start waits for ready", async () => {
    const m = machine("setup-flow");
    const path = m.localClone("widget");
    await m.request("POST", "/api/projects", { source: "local", path });
    expect((await m.request("GET", "/api/p/widget/setup")).body).toEqual({
      project: "widget",
      status: "needs-setup",
      baseBranch: "main",
      pr: null,
    });

    const refused = await m.request("POST", "/api/p/widget/start", { loop: "ralph" });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "ProjectNotReady", status: "needs-setup" });
    expect(m.started).toEqual([]);

    // An invalid config writes nothing and opens nothing.
    const rejected = await m.request("POST", "/api/p/widget/setup", { config: candidate({ owner: "" }) });
    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({ error: "InvalidConfig", problems: ["'owner' must be a GitHub login"] });
    expect(m.ghCalls().some((call) => call[1] === "create")).toBe(false);

    const submitted = await m.request("POST", "/api/p/widget/setup", { config: candidate() });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body).toEqual({
      project: "widget",
      branch: "ralph-setup",
      files: [".ralph/config.json", ".ralph/prompt.md", ".ralph/coder.md", ".ralph/plan.md"],
      pr: { url: "https://github.com/acme/widget/pull/7" },
    });
    const create = m.ghCalls().find((call) => call[0] === "pr" && call[1] === "create")!;
    expect(create.slice(0, 8)).toEqual(["pr", "create", "--base", "main", "--head", "ralph-setup", "--title", "Set up Ralph"]);
    expect(create[8]).toBe("--body");
    expect(create[9]).toContain(".ralph/config.json");

    // The four files are on the pushed setup branch; the checkout is back on main, clean.
    const pushed = git(m.origin, "ls-tree", "-r", "--name-only", "ralph-setup").split("\n");
    expect(pushed).toEqual(expect.arrayContaining([".ralph/config.json", ".ralph/prompt.md", ".ralph/coder.md", ".ralph/plan.md"]));
    expect(JSON.parse(git(m.origin, "show", "ralph-setup:.ralph/config.json"))).toEqual(candidate());
    expect(git(m.origin, "show", "ralph-setup:.ralph/plan.md")).toBe(readFileSync(join(REPO_ROOT, "examples", "plan.md"), "utf8"));
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    expect(git(path, "status", "--porcelain")).toBe("");

    expect((await m.request("GET", "/api/p/widget/setup")).body).toEqual({
      project: "widget",
      status: "setup-pending",
      baseBranch: "main",
      pr: { number: 7, url: "https://github.com/acme/widget/pull/7" },
    });
    const again = await m.request("POST", "/api/p/widget/setup", { config: candidate() });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("NotNeedingSetup");
    expect((await m.request("POST", "/api/p/widget/start", { loop: "ralph" })).body).toMatchObject({
      error: "ProjectNotReady",
      status: "setup-pending",
    });

    // Merged on GitHub: the next read fetches the base and finds the config there.
    m.mergeSetup();
    expect((await m.request("GET", "/api/p/widget/setup")).body).toMatchObject({ status: "ready", pr: null });
    const start = await m.request("POST", "/api/p/widget/start", { loop: "ralph" });
    expect(start.status).toBe(500);
    expect(m.started).toEqual([path]);
  }, 60_000);

  it("turns ready once the setup PR merges into a base that is not origin's HEAD", async () => {
    const m = machine("setup-other-base");
    const path = m.localClone("widget");
    await m.request("POST", "/api/projects", { source: "local", path });
    // The setup PR targeted an integration branch, and merged there; the main
    // checkout is still on main, which has no config.
    const seed = m.localClone("integration-seed");
    git(seed, "switch", "--quiet", "-c", "integracion");
    mkdirSync(join(seed, ".ralph"));
    writeFileSync(join(seed, ".ralph", "config.json"), "{}\n");
    git(seed, "add", "-A");
    git(seed, "commit", "--quiet", "-m", "Set up Ralph");
    git(seed, "push", "--quiet", "origin", "integracion");
    writeFileSync(join(m.root, "gh-prs.json"), JSON.stringify([{ headRefName: "felipearosr/ralph-setup", baseRefName: "integracion", state: "MERGED" }]));
    expect((await m.request("GET", "/api/p/widget/setup")).body).toMatchObject({ status: "ready", baseBranch: "integracion" });
  }, 30_000);

  it("refuses setup while the main checkout has uncommitted changes, touching nothing", async () => {
    const m = machine("setup-dirty");
    const path = m.localClone("widget");
    await m.request("POST", "/api/projects", { source: "local", path });
    writeFileSync(join(path, "notes.md"), "wip\n");
    const answer = await m.request("POST", "/api/p/widget/setup", { config: candidate() });
    expect(answer.status).toBe(409);
    expect(answer.body.error).toBe("CheckoutDirty");
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    expect(git(m.origin, "branch", "--list", "ralph-setup").trim()).toBe("");
  }, 30_000);

  it("refuses an empty requiredChecks until the operator acknowledges merging without CI", async () => {
    const m = machine("setup-no-checks");
    const path = m.localClone("widget");
    await m.request("POST", "/api/projects", { source: "local", path });
    const config = candidate({ requiredChecks: [] });

    const refused = await m.request("POST", "/api/p/widget/setup", { config });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ error: "NoRequiredChecks", message: expect.stringContaining("without waiting for CI") });
    expect(git(m.origin, "branch", "--list", "ralph-setup").trim()).toBe("");
    expect(m.ghCalls().some((call) => call[1] === "create")).toBe(false);

    const acknowledged = await m.request("POST", "/api/p/widget/setup", { config, acknowledgeNoRequiredChecks: true });
    expect(acknowledged.status, JSON.stringify(acknowledged.body)).toBe(200);
    expect(JSON.parse(git(m.origin, "show", "ralph-setup:.ralph/config.json")).requiredChecks).toEqual([]);
  }, 30_000);
});

describe("a setup that cannot go through", () => {
  const config = {
    repo: "acme/widget",
    owner: "octo",
    baseBranch: "main",
    displayName: "widget",
    secrets: { runner: "none", withhold: [] },
    refuseFiles: [],
    envCheck: [],
    requiredChecks: ["test"],
    gates: {},
    promptFragment: ".ralph/prompt.md",
    coderFragment: ".ralph/coder.md",
    plan: ".ralph/plan.md",
    journal: { dir: "journal/widget" },
    loops: ["ralph"],
  };

  it("leaves no written file behind when it fails before its commit", async () => {
    const m = machine("setup-commit-fails", { identity: false });
    const path = m.localClone("widget");
    await m.request("POST", "/api/projects", { source: "local", path });
    const answer = await m.request("POST", "/api/p/widget/setup", { config });
    expect(answer.status).toBe(502);
    expect(answer.body).toMatchObject({ error: "SetupFailed", message: expect.stringContaining("git commit") });
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    expect(git(path, "status", "--porcelain")).toBe("");
    expect(existsSync(join(path, ".ralph"))).toBe(false);
    expect(m.ghCalls().some((call) => call[1] === "create")).toBe(false);
    // The setup branch it made, with no commit of its own, is gone too.
    expect(git(path, "branch", "--list", "ralph-setup").trim()).toBe("");
  }, 30_000);

  it("keeps a local setup branch it did not make", async () => {
    const m = machine("setup-branch-kept", { identity: false });
    const path = m.localClone("widget");
    git(path, "branch", "ralph-setup");
    await m.request("POST", "/api/projects", { source: "local", path });
    const answer = await m.request("POST", "/api/p/widget/setup", { config });
    expect(answer.status).toBe(502);
    expect(git(path, "branch", "--list", "ralph-setup").trim()).toBe("ralph-setup");
  }, 30_000);

  it("shows the end of a refused push's output, and keeps the commit on the local setup branch", async () => {
    const m = machine("setup-push-hook");
    const path = m.localClone("widget");
    const hook = join(path, ".git", "hooks", "pre-push");
    writeFileSync(
      hook,
      [
        "#!/bin/sh",
        "echo 'pre-push: bun run typecheck' >&2",
        'for n in $(seq 1 40); do echo "line $n" >&2; done',
        "echo 'error: suite timed out' >&2",
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(hook, 0o755);
    await m.request("POST", "/api/projects", { source: "local", path });

    const answer = await m.request("POST", "/api/p/widget/setup", { config });
    expect(answer.status).toBe(502);
    expect(answer.body.error).toBe("SetupFailed");
    const message = answer.body.message as string;
    expect(message).toContain("The setup commit is on the local branch ralph-setup");
    expect(message).toContain("line 40\nerror: suite timed out\nerror: failed to push some refs");
    expect(message).not.toContain("line 5\n");
    expect(git(path, "log", "-1", "--format=%s", "ralph-setup").trim()).toBe("Set up Ralph");
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    expect(git(m.origin, "branch", "--list", "ralph-setup").trim()).toBe("");
  }, 30_000);

  it("puts back files the base already had, byte for byte", async () => {
    const m = machine("setup-restores", {
      identity: false,
      seedFiles: { ".ralph/prompt.md": "the project's own prompt\n" },
    });
    const path = m.localClone("widget");
    await m.request("POST", "/api/projects", { source: "local", path });
    const answer = await m.request("POST", "/api/p/widget/setup", { config });
    expect(answer.status).toBe(502);
    expect(readFileSync(join(path, ".ralph", "prompt.md"), "utf8")).toBe("the project's own prompt\n");
    expect(existsSync(join(path, ".ralph", "config.json"))).toBe(false);
    expect(git(path, "status", "--porcelain")).toBe("");
  }, 30_000);

  it("names each setup file the repo's .gitignore would refuse, on Check and on submit, before touching anything", async () => {
    const m = machine("setup-ignored", { seedFiles: { ".gitignore": "node_modules/\n/.ralph/\n" } });
    const path = m.localClone("widget");
    // The operator's own ignored notes, which a refused setup never touches.
    mkdirSync(join(path, ".ralph"));
    writeFileSync(join(path, ".ralph", "plan.md"), "my notes\n");
    await m.request("POST", "/api/projects", { source: "local", path });

    const expected = [".ralph/config.json", ".ralph/prompt.md", ".ralph/coder.md", ".ralph/plan.md"].map(
      (file) => `'${file}' is ignored by .gitignore:2 ('/.ralph/'), so setup could not commit it; un-ignore it on main first`,
    );
    const checked = await m.request("POST", "/api/p/widget/setup/validate", { config });
    expect(checked.body).toEqual({ valid: false, problems: expected });

    const submitted = await m.request("POST", "/api/p/widget/setup", { config });
    expect(submitted.status).toBe(422);
    expect(submitted.body).toMatchObject({ error: "InvalidConfig", problems: expected });
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    expect(git(path, "branch", "--list", "ralph-setup").trim()).toBe("");
    expect(git(m.origin, "branch", "--list", "ralph-setup").trim()).toBe("");
    expect(readFileSync(join(path, ".ralph", "plan.md"), "utf8")).toBe("my notes\n");
    expect(existsSync(join(path, ".ralph", "config.json"))).toBe(false);
  }, 30_000);

  it("resumes an attempt that pushed but could not open its PR", async () => {
    const m = machine("setup-resume");
    const path = m.localClone("widget");
    await m.request("POST", "/api/projects", { source: "local", path });
    m.failNextPrCreate();
    const failed = await m.request("POST", "/api/p/widget/setup", { config });
    expect(failed.status).toBe(502);
    expect(failed.body.message).toContain("gh pr create");
    const pushed = git(m.origin, "rev-parse", "ralph-setup").trim();
    // Its commit is its own: the local branch stays.
    expect(git(path, "rev-parse", "ralph-setup").trim()).toBe(pushed);
    expect((await m.request("GET", "/api/p/widget/setup")).body.status).toBe("needs-setup");

    const resumed = await m.request("POST", "/api/p/widget/setup", { config });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(resumed.body.pr).toEqual({ url: "https://github.com/acme/widget/pull/7" });
    // The pushed commit is the one the PR carries: nothing was committed or pushed again.
    expect(git(m.origin, "rev-parse", "ralph-setup").trim()).toBe(pushed);
    expect(m.ghCalls().filter((call) => call[1] === "create")).toHaveLength(2);
    expect((await m.request("GET", "/api/p/widget/setup")).body.status).toBe("setup-pending");
  }, 30_000);

  it("refuses when origin already has a setup branch it did not push, touching nothing", async () => {
    const m = machine("setup-branch-left");
    const path = m.localClone("widget");
    git(path, "push", "--quiet", "origin", "main:ralph-setup");
    await m.request("POST", "/api/projects", { source: "local", path });
    const answer = await m.request("POST", "/api/p/widget/setup", { config });
    expect(answer.status).toBe(409);
    expect(answer.body.error).toBe("SetupBranchExists");
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    expect(git(path, "branch", "--list", "ralph-setup").trim()).toBe("");
  }, 30_000);
});

describe("reading a project's status while gh is down", () => {
  it("finds the base a loop worktree's config names without gh, and reads ready", async () => {
    const m = machine("status-worktree-base");
    const path = m.localClone("widget");
    // A loop worktree on `dev`, the base its config names and where that
    // config merged; the main checkout stays on main, which has none.
    const worktree = join(m.root, "widget-loop");
    git(path, "worktree", "add", "--quiet", "-b", "dev", worktree, "origin/main");
    mkdirSync(join(worktree, ".ralph"));
    writeFileSync(join(worktree, ".ralph", "config.json"), JSON.stringify({ baseBranch: "dev", repo: "acme/widget" }));
    git(worktree, "add", "-A");
    git(worktree, "commit", "--quiet", "-m", "Set up Ralph");
    git(worktree, "push", "--quiet", "origin", "dev");
    m.ghOutage("all");

    const added = await m.request("POST", "/api/projects", { source: "local", path });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ status: "ready" });
    expect((await m.request("GET", "/api/p/widget/setup")).body).toMatchObject({ status: "ready", baseBranch: "dev" });
    expect(m.ghCalls()).toEqual([]);
  }, 30_000);

  it("registers with an unread status and answers 503 ProjectStatusUnknown while the setup PR list fails, then needs-setup once gh is back", async () => {
    // A long TTL: needs-setup after the outage shows the failed read was not reused.
    const m = machine("status-pr-list-down", { statusTtlMs: 600_000 });
    const path = m.localClone("widget");
    m.ghOutage("pr list");

    const added = await m.request("POST", "/api/projects", { source: "local", path });
    // Registered, with the setup state left unread rather than a wrong needs-setup.
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ status: null });
    expect(m.registry.list().map((project) => project.path)).toEqual([path]);

    const unknown = await m.request("GET", "/api/p/widget/setup");
    expect(unknown.status).toBe(503);
    expect(unknown.body).toMatchObject({ error: "ProjectStatusUnknown", message: expect.stringContaining("gh pr list failed") });

    m.ghOutage("none");
    const read = await m.request("GET", "/api/p/widget/setup");
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ status: "needs-setup", baseBranch: "main" });
  }, 30_000);
});

describe("reading a project that is not set up", () => {
  const READS = ["/loops", "/usage", "/notifications", "/loops/ralph", "/frontier"];
  const config = {
    repo: "acme/widget",
    owner: "octo",
    baseBranch: "main",
    displayName: "widget",
    secrets: { runner: "none", withhold: [] },
    refuseFiles: [],
    envCheck: [],
    requiredChecks: ["test"],
    gates: {},
    promptFragment: ".ralph/prompt.md",
    coderFragment: ".ralph/coder.md",
    plan: ".ralph/plan.md",
    journal: { dir: "journal/widget" },
    loops: ["ralph"],
  };

  it("answers ProjectNotReady with its status while it needs setup and while its PR is open, and nothing changes once ready", async () => {
    const m = machine("reads-not-ready", { readsNeedConfig: true });
    const path = m.localClone("widget");
    await m.request("POST", "/api/projects", { source: "local", path });

    for (const read of READS) {
      const answer = await m.request("GET", `/api/p/widget${read}`);
      expect(answer.status, read).toBe(409);
      expect(answer.body).toMatchObject({ error: "ProjectNotReady", status: "needs-setup" });
      expect(answer.body.message).toContain("origin/main");
    }

    expect((await m.request("POST", "/api/p/widget/setup", { config })).status).toBe(200);
    for (const read of READS) {
      const answer = await m.request("GET", `/api/p/widget${read}`);
      expect(answer.status, read).toBe(409);
      expect(answer.body).toMatchObject({ error: "ProjectNotReady", status: "setup-pending" });
    }

    // Ready: a failed read is the failure it always was, and a good one is served.
    m.mergeSetup();
    const failed = await m.request("GET", "/api/p/widget/loops");
    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe("RalphContractError");
    git(path, "pull", "--quiet", "--ff-only", "origin", "main");
    const served = await m.request("GET", "/api/p/widget/loops");
    expect(served.status).toBe(200);
    expect(served.body.loops).toHaveLength(1);
  }, 60_000);
});

describe("the start gate", () => {
  it("answers 503 when the project's status cannot be read, without starting", async () => {
    const lifecycle = vi.fn(() => {
      throw new Error("reached");
    });
    const failing = new Proxy({} as never, {
      get: () => async () => {
        throw new Error("git timed out");
      },
    });
    const handler = createHandler({
      projects: () => [
        {
          project: { id: "widget", path: "/nowhere", addedAt: "2026-09-23T00:00:00.000Z", source: "local" },
          adapter: { read: async () => ({ roster: coderRoster("ralph"), loops: [], reconciliation: { orphaned: [], prunable: [] } }) },
        },
      ],
      shell: "",
      onboarding: failing,
      lifecycle,
    });
    const response = await handler(
      new Request("http://127.0.0.1/api/p/widget/start", { method: "POST", body: JSON.stringify({ loop: "ralph" }) }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "ProjectStatusUnknown", message: expect.stringContaining("git timed out") });
    expect(lifecycle).not.toHaveBeenCalled();
  });
});

describe("without onboarding mounted", () => {
  it("serves no add or setup route and gates no start", async () => {
    const lifecycle = vi.fn(() => {
      throw new Error("reached");
    });
    const handler = createHandler({
      adapter: {
        read: async () => ({
          roster: coderRoster("ralph"),
          loops: [],
          reconciliation: { orphaned: [], prunable: [] },
        }),
      },
      shell: "",
      lifecycle,
    });
    expect((await handler(new Request("http://127.0.0.1/api/projects", { method: "POST", body: "{}" }))).status).toBe(405);
    expect((await handler(new Request("http://127.0.0.1/api/setup"))).status).toBe(404);
  });
});
