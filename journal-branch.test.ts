// @vitest-environment node
/**
 * `journal.branch`: a project's journal and project learnings published onto a
 * branch of the PROJECT's own repository instead of the harness's main, and
 * every reader following them there. Real git throughout: one bare origin for
 * the harness, one for the project, and a clone of each.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { journalLocation } from "./journal-home";
import { main as journalRead } from "./journal-read";
import { readLearnings } from "./learnings-read";
import { harnessJournalReader } from "./observe";
import { parseProjectConfig, ProjectConfigError } from "./project-config";
import { JOURNAL_BRANCH_MARKER, publishJournal, publishLearning } from "./publish-journal";
import { fixtureGitEnv, stripGitLocationEnv } from "./test-git-env";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("publishes journals to a project branch through bun and git");

stripGitLocationEnv();

const BUN = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim();
const CLI = join(__dirname, "publish-journal.ts");

const IDENTITY = {
  GIT_AUTHOR_NAME: "Journal Test",
  GIT_AUTHOR_EMAIL: "journal@example.invalid",
  GIT_COMMITTER_NAME: "Journal Test",
  GIT_COMMITTER_EMAIL: "journal@example.invalid",
};
const GIT_ENV = fixtureGitEnv({ ...IDENTITY, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
Object.assign(process.env, IDENTITY);

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV });
const bare = (origin: string, ...args: string[]): string =>
  execFileSync("git", ["--git-dir", origin, ...args], { encoding: "utf8", env: GIT_ENV });

const CONFIG = {
  repo: "example/client-app",
  owner: "example",
  baseBranch: "dev",
  displayName: "Client",
  secrets: { runner: "none", withhold: [] },
  refuseFiles: [],
  envCheck: [],
  requiredChecks: [],
  gates: {},
  promptFragment: ".ralph/prompt.md",
  coderFragment: ".ralph/coder.md",
  plan: ".ralph/plan.md",
  journal: { dir: "journal/client", branch: "ralph-journal" },
  loops: ["ralph", "remo"],
};

interface World {
  harnessOrigin: string;
  harness: string;
  projectOrigin: string;
  project: string;
  worktree: string;
  draft: (issue?: string, body?: string) => string;
}

/** A repository with one commit on `branch`, pushed to a fresh bare origin. */
function repo(root: string, name: string, branch: string, files: Record<string, string>): { origin: string; clone: string } {
  const origin = join(root, `${name}.git`);
  execFileSync("git", ["init", "--quiet", "--bare", `--initial-branch=${branch}`, origin], { env: GIT_ENV });
  const clone = join(root, name);
  execFileSync("git", ["clone", "--quiet", origin, clone], { env: GIT_ENV, stdio: "ignore" });
  git(clone, "checkout", "--quiet", "-B", branch);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(clone, path, ".."), { recursive: true });
    writeFileSync(join(clone, path), content);
  }
  git(clone, "add", "-A");
  git(clone, "commit", "--quiet", "-m", "init");
  git(clone, "push", "--quiet", "origin", branch);
  return { origin, clone };
}

function world(config: object = CONFIG): World {
  stripGitLocationEnv();
  const root = mkdtempSync(join(tmpdir(), "ralph-journal-branch-"));
  roots.push(root);
  const harness = repo(root, "harness", "main", { "README.md": "harness\n", "learnings/harness.md": "# harness learnings\n\n## Open: fix these\n" });
  const project = repo(root, "project", "dev", {
    "app.ts": "export {};\n",
    ".ralph/config.json": JSON.stringify(config, null, 2),
    ".gitignore": ".ralph/logs/\n",
  });
  mkdirSync(join(project.clone, ".ralph", "logs"), { recursive: true });
  // The loop name is checked against this project's roster.
  process.env.RALPH_PROJECT = project.clone;
  let n = 0;
  return {
    harnessOrigin: harness.origin,
    harness: harness.clone,
    projectOrigin: project.origin,
    project: project.clone,
    worktree: join(root, "state", "journal-wt"),
    draft: (issue = "12", body = "# Remo #12\n\n**Outcome: merged.**\n") => {
      n += 1;
      const path = join(project.clone, ".ralph", "logs", `journal-draft-20261117T10000${n % 10}Z-${issue}-sess${n}.md`);
      writeFileSync(path, body);
      return path;
    },
  };
}

const publish = (w: World, draft: string, issue = "12") =>
  publishJournal({
    draft,
    issue,
    loop: "remo",
    project: w.project,
    displayName: "Client",
    journalDir: "journal/client",
    home: w.project,
    branch: "ralph-journal",
    worktree: w.worktree,
  });

describe("publishing onto a project's journal branch", () => {
  it("creates the branch with no shared history, then lands the entry on it alone", () => {
    const w = world();
    const devBefore = bare(w.projectOrigin, "rev-parse", "dev").trim();
    const harnessBefore = bare(w.harnessOrigin, "rev-parse", "main").trim();

    const result = publish(w, w.draft());

    expect(result.path).toBe("journal/client/20261117T100001Z-12-sess1.md");
    expect(bare(w.projectOrigin, "rev-parse", "ralph-journal").trim()).toBe(result.sha);
    expect(bare(w.projectOrigin, "log", "--format=%s", "ralph-journal").trim().split("\n")).toEqual([
      "chore(remo): journal client #12 [skip ci]",
      "chore(ralph): start the journal branch [skip ci]",
    ]);
    expect(bare(w.projectOrigin, "ls-tree", "-r", "--name-only", "ralph-journal").trim().split("\n").sort()).toEqual(
      ["README.md", "journal/client/20261117T100001Z-12-sess1.md", "vercel.json"],
    );
    expect(bare(w.projectOrigin, "show", "ralph-journal:README.md")).toContain(JOURNAL_BRANCH_MARKER);
    expect(JSON.parse(bare(w.projectOrigin, "show", "ralph-journal:vercel.json"))).toEqual({ git: { deploymentEnabled: false } });
    // An orphan: nothing in common with the code.
    expect(spawnSync("git", ["--git-dir", w.projectOrigin, "merge-base", "dev", "ralph-journal"], { env: GIT_ENV }).status).toBe(1);
    // The base, the harness and the project's worktree list are all untouched.
    expect(bare(w.projectOrigin, "rev-parse", "dev").trim()).toBe(devBefore);
    expect(bare(w.harnessOrigin, "rev-parse", "main").trim()).toBe(harnessBefore);
    expect(git(w.project, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(git(w.project, "status", "--porcelain")).toBe("");
  });

  it("stacks later entries, and retries when another host pushed first", () => {
    const w = world();
    publish(w, w.draft("12"));
    const result = publishJournal({
      draft: w.draft("13", "# thirteen\n"),
      issue: "13",
      loop: "remo",
      project: w.project,
      displayName: "Client",
      journalDir: "journal/client",
      home: w.project,
      branch: "ralph-journal",
      worktree: w.worktree,
      beforePush: (attempt) => {
        if (attempt !== 1) return;
        // Another publisher's entry lands between the fetch and the push.
        const other = join(w.project, "..", "other");
        execFileSync("git", ["clone", "--quiet", "--branch", "ralph-journal", w.projectOrigin, other], { env: GIT_ENV, stdio: "ignore" });
        mkdirSync(join(other, "journal/client"), { recursive: true });
        writeFileSync(join(other, "journal/client/20261117T090000Z-9-x.md"), "# nine\n");
        git(other, "add", "-A");
        git(other, "commit", "--quiet", "-m", "raced");
        git(other, "push", "--quiet", "origin", "ralph-journal");
      },
    });
    expect(result.attempts).toBe(2);
    expect(bare(w.projectOrigin, "ls-tree", "-r", "--name-only", "ralph-journal", "journal/client/").trim().split("\n")).toHaveLength(3);
  });

  it("refuses to push to an existing branch that is not a journal branch", () => {
    const w = world();
    git(w.project, "push", "--quiet", "origin", "dev:refs/heads/ralph-journal");
    expect(() => publish(w, w.draft())).toThrow(/not a Ralph journal branch/);
    expect(bare(w.projectOrigin, "rev-parse", "ralph-journal").trim()).toBe(bare(w.projectOrigin, "rev-parse", "dev").trim());
  });

  it("puts a project learning on the branch too", () => {
    const w = world();
    const stamp = "20261117T100000Z";
    const draft = join(w.project, ".ralph", "logs", `learning-draft-${stamp}-flaky-seed.md`);
    writeFileSync(draft, "### Flaky seed (2026-11-17)\n<!-- learning: flaky-seed -->\n\n**Seen:** twice.\n");
    const result = publishLearning({
      action: { kind: "entry", draft },
      scope: "project",
      loop: "remo",
      project: w.project,
      displayName: "Client",
      file: "learnings/client.md",
      home: w.project,
      branch: "ralph-journal",
      worktree: w.worktree,
      date: "2026-11-17",
    });
    expect(result.outcome).toBe("added");
    expect(bare(w.projectOrigin, "show", "ralph-journal:learnings/client.md")).toContain("flaky-seed");
    expect(bare(w.projectOrigin, "log", "-1", "--format=%s", "ralph-journal").trim()).toBe(
      "chore(remo): learning client flaky-seed [skip ci]",
    );
  });
});

describe("the CLI with journal.branch in the project config", () => {
  it("publishes into the project even though RALPH_JOURNAL_HOME names the harness", () => {
    const w = world();
    const draft = w.draft();
    const run = spawnSync(BUN, [CLI, "--draft", draft, "--issue", "12"], {
      encoding: "utf8",
      env: {
        ...GIT_ENV,
        RALPH_PROJECT: w.project,
        RALPH_LOOP_NAME: "remo",
        RALPH_JOURNAL_HOME: w.harness,
        RALPH_JOURNAL_WORKTREE: w.worktree,
        RALPH_JOURNAL_LOCK: join(w.worktree, "..", "journal.lock"),
        RALPH_JOURNAL_LOCKED: "",
      },
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(bare(w.projectOrigin, "ls-tree", "-r", "--name-only", "ralph-journal")).toContain("journal/client/");
    expect(bare(w.harnessOrigin, "ls-tree", "-r", "--name-only", "main")).not.toContain("journal/");
  });
});

describe("readers follow the branch", () => {
  it("resolves the location from the config, and from the exported env", () => {
    const w = world();
    expect(journalLocation(w.project, {})).toMatchObject({ home: w.project, ref: "origin/ralph-journal", projectSide: true });
    expect(journalLocation(w.project, { RALPH_JOURNAL_BRANCH: "", RALPH_JOURNAL_HOME: w.harness })).toMatchObject({
      home: w.harness,
      ref: "origin/main",
      projectSide: false,
    });
  });

  it("reads the journal and the project learnings from the branch, the harness file from the harness", () => {
    const w = world();
    publish(w, w.draft("12", "# twelve\n"));
    const stamp = "20261117T100000Z";
    const draft = join(w.project, ".ralph", "logs", `learning-draft-${stamp}-flaky-seed.md`);
    writeFileSync(draft, "### Flaky seed (2026-11-17)\n<!-- learning: flaky-seed -->\n\n**Seen:** twice.\n");
    publishLearning({
      action: { kind: "entry", draft },
      scope: "project",
      loop: "remo",
      project: w.project,
      displayName: "Client",
      file: "learnings/client.md",
      home: w.project,
      branch: "ralph-journal",
      worktree: w.worktree,
      date: "2026-11-17",
    });
    git(w.harness, "fetch", "--quiet", "origin");

    expect(harnessJournalReader(w.project, w.harness, {})()).toEqual([{ name: "20261117T100001Z-12-sess1.md", body: "# twelve\n" }]);
    const sources = readLearnings(w.project, w.harness, { RALPH_LEARNINGS_FILE: "learnings/client.md" });
    expect(sources.map(({ scope, file, present, readable }) => ({ scope, file, present, readable }))).toEqual([
      { scope: "project", file: "learnings/client.md", present: true, readable: true },
      { scope: "harness", file: "learnings/harness.md", present: true, readable: true },
    ]);
    expect(sources[0]?.open).toContain("flaky-seed");
  });

  it("prints the newest entries for a prompt from the branch, fetching it first", () => {
    const w = world();
    publish(w, w.draft("12", "# twelve\n"));
    publish(w, w.draft("13", "# thirteen\n"), "13");
    // A fresh clone has never fetched the journal branch: the reader must.
    const fresh = join(w.project, "..", "fresh");
    execFileSync("git", ["clone", "--quiet", "--branch", "dev", w.projectOrigin, fresh], { env: GIT_ENV, stdio: "ignore" });
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (out.push(String(chunk)), true));
    try {
      expect(journalRead(["recent", "--count", "1"], { RALPH_PROJECT: fresh })).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(out.join("")).toBe("\n=== 20261117T100002Z-13-sess2.md\n# thirteen\n");
  });

  it("reads a branch nobody has published to yet as nothing learned, not unreadable", () => {
    const w = world();
    const [project] = readLearnings(w.project, w.harness, { RALPH_LEARNINGS_FILE: "learnings/client.md" });
    expect(project).toMatchObject({ present: false, readable: true });
  });
});

describe("journal.branch in the config", () => {
  const parse = (journal: object, baseBranch = "dev") =>
    parseProjectConfig(JSON.stringify({ ...CONFIG, baseBranch, journal: { dir: "journal/client", ...journal } }));

  it("accepts a branch and leaves it out when unset", () => {
    expect(parse({ branch: "ralph-journal" }).journal).toEqual({ dir: "journal/client", branch: "ralph-journal" });
    expect(parse({}).journal).toEqual({ dir: "journal/client" });
  });

  it("refuses the base branch, default branch names, and non-branch text", () => {
    expect(() => parse({ branch: "dev" })).toThrow(/must not be the base branch/);
    expect(() => parse({ branch: "main" }, "release")).toThrow(/must not be the base branch/);
    expect(() => parse({ branch: "has space" })).toThrow(ProjectConfigError);
    expect(() => parse({ branch: 7 })).toThrow(/must be a branch name/);
  });
});
