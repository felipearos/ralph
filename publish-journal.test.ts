// @vitest-environment node
/**
 * The journal publisher, against real git: a temp bare repository is the
 * harness origin, a clone of it is RALPH_HOME, and a fake project holds the
 * draft. Nothing here touches the network, the real remote, or $HOME — every
 * path the publisher would default under ~/.ralph is overridden.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { findEntry, type LearningEntry } from "./learnings";
import { harnessChangeRefusal } from "./findings";
import { commitSubject, publishJournal, validateDraft, type PublishOptions } from "./publish-journal";
import { fixtureGitEnv, stripGitLocationEnv } from "./test-git-env";
import { cleanupFixtures, scratchProject } from "./dashboard/fixtures";
import { subprocessSuite } from "./test-timeouts";

// The scratch projects this file registers with the fixtures; nothing drains
// them unless the suite says so (#271).
afterAll(cleanupFixtures);

subprocessSuite("publishes journals through bun, git and flock");

// A pre-push hook runs with `GIT_DIR` pointing at the outer checkout; the
// publisher reads process.env directly, so strip it before anything is built.
stripGitLocationEnv();

const BUN = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim();
const CLI = join(__dirname, "publish-journal.ts");

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const GIT_ENV: NodeJS.ProcessEnv = fixtureGitEnv({
  GIT_AUTHOR_NAME: "Journal Test",
  GIT_AUTHOR_EMAIL: "journal@example.invalid",
  GIT_COMMITTER_NAME: "Journal Test",
  GIT_COMMITTER_EMAIL: "journal@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});
// The publisher's own git calls read identity from the environment too.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: GIT_ENV.GIT_AUTHOR_NAME,
  GIT_AUTHOR_EMAIL: GIT_ENV.GIT_AUTHOR_EMAIL,
  GIT_COMMITTER_NAME: GIT_ENV.GIT_COMMITTER_NAME,
  GIT_COMMITTER_EMAIL: GIT_ENV.GIT_COMMITTER_EMAIL,
});
// The loop name is checked against the project's roster. This suite runs from
// the harness checkout, which is no project, so it names loggd's.
process.env.RALPH_PROJECT = scratchProject("publish-journal");

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV });

const LOGGD_CONFIG = {
  repo: "felipearos/loggd",
  owner: "felipearosr",
  baseBranch: "main",
  displayName: "Loggd",
  secrets: { runner: "none", withhold: [] },
  refuseFiles: [".env.local"],
  envCheck: [],
  requiredChecks: ["buildkite/loggd", "Vercel"],
  gates: { test: "bun run test" },
  promptFragment: ".ralph/prompt.md",
  coderFragment: ".ralph/coder.md",
  plan: ".ralph/plan.md",
  journal: { dir: "journal/loggd" },
  loops: ["ralph", "rafa", "remo", "rulo"],
};

interface World {
  root: string;
  origin: string;
  home: string;
  project: string;
  worktree: string;
  lock: string;
  draft: (issue?: string, body?: string, session?: string) => string;
  options: (draft: string, extra?: Partial<PublishOptions>) => PublishOptions;
  /** Push an unrelated commit to origin/main from a second clone. */
  landElsewhere: (label: string) => void;
  originFiles: () => string[];
}

function world(): World {
  // The in-process publisher reads process.env at call time; strip the hook's
  // git variables again here so it can never be pointed at the outer checkout.
  stripGitLocationEnv();
  const root = mkdtempSync(join(tmpdir(), "ralph-publish-journal-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin], { env: GIT_ENV });
  const home = join(root, "home");
  execFileSync("git", ["clone", "--quiet", origin, home], { env: GIT_ENV, stdio: "ignore" });
  git(home, "checkout", "--quiet", "-B", "main");
  writeFileSync(join(home, "README.md"), "harness\n");
  git(home, "add", "README.md");
  git(home, "commit", "--quiet", "-m", "init");
  git(home, "push", "--quiet", "origin", "main");

  const other = join(root, "other");
  execFileSync("git", ["clone", "--quiet", origin, other], { env: GIT_ENV, stdio: "ignore" });

  const project = join(root, "project");
  mkdirSync(join(project, ".ralph", "logs"), { recursive: true });
  writeFileSync(join(project, ".ralph", "config.json"), JSON.stringify(LOGGD_CONFIG, null, 2));

  const worktree = join(root, "state", "journal-wt");
  const lock = join(root, "state", "journal.lock");
  let n = 0;
  return {
    root,
    origin,
    home,
    project,
    worktree,
    lock,
    draft: (issue = "849", body = "# Remo #849\n\n**Outcome: merged.**\n", session = "b6542345-b66") => {
      n += 1;
      const path = join(project, ".ralph", "logs", `journal-draft-20260913T22000${n % 10}Z-${issue}-${session}.md`);
      writeFileSync(path, body);
      return path;
    },
    options: (draft, extra = {}) => ({
      draft,
      issue: "849",
      loop: "remo",
      project,
      displayName: "Loggd",
      journalDir: "journal/loggd",
      home,
      worktree,
      ...extra,
    }),
    landElsewhere: (label) => {
      git(other, "pull", "--quiet", "--rebase", "origin", "main");
      writeFileSync(join(other, `${label}.txt`), `${label}\n`);
      git(other, "add", `${label}.txt`);
      git(other, "commit", "--quiet", "-m", label);
      git(other, "push", "--quiet", "origin", "HEAD:main");
    },
    originFiles: () =>
      execFileSync("git", ["--git-dir", origin, "ls-tree", "-r", "--name-only", "main"], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean),
  };
}

const originLog = (w: World): string[] =>
  execFileSync("git", ["--git-dir", w.origin, "log", "--format=%s", "main"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

describe("publishing a journal entry into the harness repository", () => {
  it("commits exactly the entry to origin/main, deletes the draft, and leaves the project alone", () => {
    const w = world();
    const draft = w.draft();
    const before = readFileSync(join(w.project, ".ralph", "config.json"), "utf8");

    const result = publishJournal(w.options(draft));

    expect(result).toMatchObject({ path: "journal/loggd/20260913T220001Z-849-b6542345-b66.md", attempts: 1 });
    expect(originLog(w)[0]).toBe("chore(remo): journal loggd #849");
    expect(w.originFiles()).toContain("journal/loggd/20260913T220001Z-849-b6542345-b66.md");
    const shown = execFileSync("git", ["--git-dir", w.origin, "show", `main:${result.path}`], { encoding: "utf8" });
    expect(shown).toBe("# Remo #849\n\n**Outcome: merged.**\n");
    expect(execFileSync("git", ["--git-dir", w.origin, "rev-parse", "main"], { encoding: "utf8" }).trim()).toBe(result.sha);
    const touched = execFileSync("git", ["--git-dir", w.origin, "show", "--name-only", "--format=", "main"], {
      encoding: "utf8",
    }).trim();
    expect(touched).toBe(result.path);
    expect(existsSync(draft)).toBe(false);
    expect(readFileSync(join(w.project, ".ralph", "config.json"), "utf8")).toBe(before);
    // The harness checkout itself is not moved either.
    expect(git(w.home, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
  });

  it("names none-issue entries as such", () => {
    expect(commitSubject("ralph", "Loggd", "none")).toBe("chore(ralph): journal loggd #none");
    const w = world();
    const result = publishJournal(w.options(w.draft("none"), { issue: "none", loop: "ralph" }));
    expect(result.path).toMatch(/-none-b6542345-b66\.md$/);
    expect(originLog(w)[0]).toBe("chore(ralph): journal loggd #none");
  });

  it("retries a push rejected because another writer landed first", () => {
    const w = world();
    const draft = w.draft();
    const result = publishJournal(
      w.options(draft, { beforePush: (attempt) => (attempt === 1 ? w.landElsewhere("raced") : undefined) }),
    );
    expect(result.attempts).toBe(2);
    expect(w.originFiles()).toEqual(expect.arrayContaining(["raced.txt", result.path]));
    expect(originLog(w)[0]).toBe("chore(remo): journal loggd #849");
    expect(existsSync(draft)).toBe(false);
  });

  it("gives up after five rejected pushes and keeps the draft", () => {
    const w = world();
    const draft = w.draft();
    let pushes = 0;
    expect(() =>
      publishJournal(
        w.options(draft, {
          beforePush: (attempt) => {
            pushes = attempt;
            w.landElsewhere(`raced-${attempt}`);
          },
        }),
      ),
    ).toThrow(/rejected 5 times; the draft is kept/);
    expect(pushes).toBe(5);
    expect(existsSync(draft)).toBe(true);
    expect(w.originFiles().some((file) => file.startsWith("journal/"))).toBe(false);
  });

  it("treats identical content already on origin/main as published", () => {
    const w = world();
    const first = w.draft("849", "# same\n", "sess-1");
    const published = publishJournal(w.options(first));
    // The same draft again — e.g. a publisher killed after its push landed.
    const again = join(w.project, ".ralph", "logs", `journal-draft-${published.path.split("/").pop()}`);
    writeFileSync(again, "# same\n");
    const result = publishJournal(w.options(again));
    expect(result.alreadyPublished).toBe(true);
    expect(existsSync(again)).toBe(false);
    expect(originLog(w).filter((subject) => subject.startsWith("chore("))).toHaveLength(1);

    writeFileSync(again, "# different\n");
    expect(() => publishJournal(w.options(again))).toThrow(/different content/);
    expect(existsSync(again)).toBe(true);
  });

  it("re-creates a publishing worktree whose directory vanished", () => {
    const w = world();
    publishJournal(w.options(w.draft("849", "# one\n", "sess-a")));
    rmSync(w.worktree, { recursive: true, force: true });
    const result = publishJournal(w.options(w.draft("849", "# two\n", "sess-b")));
    expect(w.originFiles()).toContain(result.path);
  });
});

describe("what the publisher refuses", () => {
  it("refuses a draft outside the project's .ralph/logs", () => {
    const w = world();
    const outside = join(w.project, "journal-draft-20260913T220000Z-849-abc.md");
    writeFileSync(outside, "# x\n");
    expect(() => validateDraft({ draft: outside, issue: "849", project: w.project })).toThrow(/directly inside/);
    const nested = join(w.project, ".ralph", "logs", "sub");
    mkdirSync(nested);
    writeFileSync(join(nested, "journal-draft-20260913T220000Z-849-abc.md"), "# x\n");
    expect(() =>
      validateDraft({ draft: join(nested, "journal-draft-20260913T220000Z-849-abc.md"), issue: "849", project: w.project }),
    ).toThrow(/directly inside/);
  });

  it.each([
    "entry.md",
    "journal-draft-2026-09-13-849-abc.md",
    "journal-draft-20260913T220000Z-abc-abc.md",
    "journal-draft-20260913T220000Z-849-a_b.md",
  ])("refuses a draft named %s", (name) => {
    const w = world();
    const path = join(w.project, ".ralph", "logs", name);
    writeFileSync(path, "# x\n");
    expect(() => validateDraft({ draft: path, issue: "849", project: w.project })).toThrow(/must be named/);
  });

  it("refuses an empty draft, and an --issue that disagrees with the name", () => {
    const w = world();
    const empty = w.draft("849", "");
    expect(() => validateDraft({ draft: empty, issue: "849", project: w.project })).toThrow(/missing or empty/);
    const draft = w.draft("849", "# x\n", "other");
    expect(() => validateDraft({ draft, issue: "850", project: w.project })).toThrow(/does not match/);
  });

  it("refuses a loop name no claim fence reads", () => {
    const w = world();
    expect(() => publishJournal(w.options(w.draft(), { loop: "nova" }))).toThrow(/RALPH_LOOP_NAME/);
  });
});

describe("the CLI", () => {
  const cliEnv = (w: World): NodeJS.ProcessEnv => ({
    ...GIT_ENV,
    RALPH_PROJECT: w.project,
    RALPH_LOOP_NAME: "rafa",
    RALPH_JOURNAL_HOME: w.home,
    RALPH_JOURNAL_WORKTREE: w.worktree,
    RALPH_JOURNAL_LOCK: w.lock,
    RALPH_JOURNAL_DIR: "",
    RALPH_PROJECT_DISPLAY_NAME: "",
    RALPH_JOURNAL_LOCKED: "",
  });

  const runCli = (w: World, draft: string, issue = "849") =>
    new Promise<{ status: number; stdout: string; stderr: string }>((resolvePromise) => {
      const child = spawn(BUN, [CLI, "--draft", draft, "--issue", issue], { env: cliEnv(w) });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => resolvePromise({ status: code ?? -1, stdout, stderr }));
    });

  it("reads journal.dir and displayName from the project config", async () => {
    const w = world();
    const run = await runCli(w, w.draft());
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/journal published: journal\/loggd\/.*-849-.*\.md at [0-9a-f]{40}/);
    expect(originLog(w)[0]).toBe("chore(rafa): journal loggd #849");
  });

  it("serialises two concurrent publishers behind the lock, and both land", async () => {
    const w = world();
    const one = w.draft("849", "# one\n", "sess-one");
    const two = w.draft("850", "# two\n", "sess-two");
    const [first, second] = await Promise.all([runCli(w, one, "849"), runCli(w, two, "850")]);
    expect([first.status, second.status, first.stderr, second.stderr]).toEqual([0, 0, "", ""]);
    const journals = w.originFiles().filter((file) => file.startsWith("journal/loggd/"));
    expect(journals).toHaveLength(2);
    // Serialised, not raced: neither needed a retry.
    expect(first.stdout + second.stdout).not.toContain("attempt");
    expect(existsSync(one) || existsSync(two)).toBe(false);
  }, 30_000);

  it("fails with the draft kept when the lock stays held", () => {
    const w = world();
    const draft = w.draft();
    mkdirSync(join(w.root, "state"), { recursive: true });
    const holder = spawn("flock", [w.lock, "sleep", "5"]);
    try {
      execFileSync("sleep", ["0.3"]);
      const run = spawnSync(BUN, [CLI, "--draft", draft, "--issue", "849"], {
        env: { ...cliEnv(w), RALPH_JOURNAL_LOCK_SECONDS: "1" },
        encoding: "utf8",
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("stayed locked");
      expect(existsSync(draft)).toBe(true);
    } finally {
      holder.kill();
    }
  });
});

describe("harnessChangeRefusal (#815)", () => {
  const entry = (change: string | null, fix = "no issue yet."): LearningEntry => {
    const text = [
      "### A learning (2026-11-17)",
      "<!-- learning: a-learning -->",
      "- **Seen:** pr-wait.ts timed out on ralph.sh's watch",
      "- **Workaround:** waited by hand",
      `- **Fix:** ${fix}`,
      ...(change === null ? [] : [`- **Change:** ${change}`]),
    ].join("\n");
    return findEntry(`# Learnings\n\n## Open\n\n${text}\n`, "a-learning") as LearningEntry;
  };
  const repos = { projectRepo: "felipearos/loggd", harnessRepo: "felipearos/ralph" };

  it.each([
    ["pr-wait.ts", "make pr-wait.ts poll the merge queue"],
    ["ralph.sh", "have ralph.sh retry the gate"],
    ["frontier/", "teach frontier/next-tasks.ts the new label"],
    ["$RALPH_HOME", "read $RALPH_HOME/models.json for the runner"],
    ["${RALPH_HOME}", "read ${RALPH_HOME}/models.json for the runner"],
    ["supervisor", "Supervisor's CI wait learns a queued outcome"],
  ])("refuses a project Change naming %s", (marker, change) => {
    const refusal = harnessChangeRefusal(entry(change), { scope: "project", ...repos });
    expect(refusal).toContain(marker);
    expect(refusal).toContain("felipearos/loggd");
    expect(refusal).toContain("--scope harness");
  });

  it("never refuses --scope harness", () => {
    expect(harnessChangeRefusal(entry("make pr-wait.ts poll"), { scope: "harness", ...repos })).toBeNull();
  });

  it("refuses nothing whose ticket is already filed", () => {
    const linked = entry("make pr-wait.ts poll", "https://github.com/felipearos/loggd/issues/3451");
    expect(harnessChangeRefusal(linked, { scope: "project", ...repos })).toBeNull();
  });

  it("refuses nothing without a Change line, even when other fields name the harness", () => {
    expect(harnessChangeRefusal(entry(null), { scope: "project", ...repos })).toBeNull();
  });

  it("allows a Change naming only project files, a project frontier/ directory included", () => {
    expect(harnessChangeRefusal(entry("guard apps/web/foo.ts against a null user"), { scope: "project", ...repos })).toBeNull();
    expect(harnessChangeRefusal(entry("split apps/web/frontier/map.ts"), { scope: "project", ...repos })).toBeNull();
  });

  it("allows a harness Change when the project is the harness, whatever the repo's case", () => {
    const same = { projectRepo: "FelipeAros/ralph", harnessRepo: "felipearos/ralph" };
    expect(harnessChangeRefusal(entry("make pr-wait.ts poll"), { scope: "project", ...same })).toBeNull();
  });

  it("refuses nothing when either repo is unknown", () => {
    expect(harnessChangeRefusal(entry("make pr-wait.ts poll"), { scope: "project", projectRepo: null, harnessRepo: "felipearos/ralph" })).toBeNull();
    expect(harnessChangeRefusal(entry("make pr-wait.ts poll"), { scope: "project", projectRepo: "felipearos/loggd", harnessRepo: null })).toBeNull();
  });
});
