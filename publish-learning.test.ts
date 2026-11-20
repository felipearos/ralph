// @vitest-environment node
/**
 * The write half of the learnings path.
 *
 * Journals and learnings share a publisher, but they do not share the hard
 * part. A journal entry is a new file nobody else can be writing, so a rejected
 * push only has to be re-applied. A learnings file is shared and
 * read-modify-write, so the question this suite exists to answer is whether an
 * entry can be LOST — overwritten by a second writer that read the file before
 * the first one landed. Two tests drive that directly: one lands a competing
 * entry between the read and the push, and one runs two publishers for real.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanupFixtures, scratchProject, writeProjectConfig } from "./dashboard/fixtures";
import { parseLearnings } from "./learnings";
import { promoteFinding, reconcileFindings, type FindingGh } from "./findings";
import {
  LEARNING_DRAFT_NAME,
  learningSubject,
  learningTarget,
  mode,
  publishLearning,
  validateLearningDraft,
} from "./publish-journal";
import { fixtureGitEnv, stripGitLocationEnv } from "./test-git-env";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs the publisher through bun, flock and git");
stripGitLocationEnv();

const BUN = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim();
const CLI = join(__dirname, "publish-journal.ts");

const GIT_ENV: NodeJS.ProcessEnv = fixtureGitEnv({
  RALPH_FINDINGS_DISABLED: "1",
  GIT_AUTHOR_NAME: "Learning Test",
  GIT_AUTHOR_EMAIL: "learning@example.invalid",
  GIT_COMMITTER_NAME: "Learning Test",
  GIT_COMMITTER_EMAIL: "learning@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});
// The in-process publisher's own git calls read identity from process.env.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: GIT_ENV.GIT_AUTHOR_NAME,
  GIT_AUTHOR_EMAIL: GIT_ENV.GIT_AUTHOR_EMAIL,
  GIT_COMMITTER_NAME: GIT_ENV.GIT_COMMITTER_NAME,
  GIT_COMMITTER_EMAIL: GIT_ENV.GIT_COMMITTER_EMAIL,
});
// `safeLoop` checks the loop against a roster, and this suite runs from the
// harness checkout, which is no project.
process.env.RALPH_PROJECT = scratchProject("publish-learning");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  cleanupFixtures();
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV });

const PROJECT_FILE = "learnings/loggd.md";

const SEEDED = `# loggd learnings

Lessons from running Ralph on loggd.

## Open: fix these

### A missing TMDB fixture parks PRs (2026-09-30)
<!-- learning: tmdb-fixture-missing -->
- **Seen:** the hermetic stub has no genre-discover fixture.
- **Fix:** #1890.

## Host hygiene: check these first when loops go slow or red

- **Leaked E2E servers.** A \`next start\` ran for 21 h.
`;

const HARNESS_SEEDED = `# Harness learnings

## Open: fix these

### Parked PRs starve the loops (2026-09-30)
<!-- learning: parked-prs-starve-loops -->
- **Seen:** 5 loops idled behind 3 parked PRs.
- **Fix:** ralph #155.
`;

const entryBody = (slug: string, title = "The executor runner is unavailable") =>
  `### ${title}\n<!-- learning: ${slug} -->\n- **Seen:** PR #233, build #9, 2026-10-06.\n- **Workaround:** implement in session.\n- **Fix:** no issue yet.\n`;

interface World {
  root: string;
  origin: string;
  home: string;
  project: string;
  worktree: string;
  lock: string;
  /** Write a learning draft for `slug` into the project's `.ralph/logs`. */
  draft: (slug: string, body?: string) => string;
  options: (extra?: Record<string, unknown>) => Record<string, unknown>;
  /** The learnings file as `origin/main` has it. */
  onMain: (file?: string) => string;
  /** Another writer lands its own entry in the same file, from its own clone. */
  landEntry: (slug: string) => void;
  log: () => string[];
}

function world(files: Record<string, string> = { [PROJECT_FILE]: SEEDED }): World {
  stripGitLocationEnv();
  const root = mkdtempSync(join(tmpdir(), "ralph-publish-learning-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin], { env: GIT_ENV });
  const home = join(root, "home");
  execFileSync("git", ["clone", "--quiet", origin, home], { env: GIT_ENV, stdio: "ignore" });
  git(home, "checkout", "--quiet", "-B", "main");
  writeFileSync(join(home, "README.md"), "harness\n");
  mkdirSync(join(home, "learnings"), { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(home, file), text);
  git(home, "add", "--all");
  git(home, "commit", "--quiet", "-m", "init");
  git(home, "push", "--quiet", "origin", "main");

  const other = join(root, "other");
  execFileSync("git", ["clone", "--quiet", origin, other], { env: GIT_ENV, stdio: "ignore" });

  const project = join(root, "project");
  mkdirSync(join(project, ".ralph", "logs"), { recursive: true });
  // The CLI checks --loop against this project's roster, so it needs a config.
  writeProjectConfig(project);

  let n = 0;
  return {
    root,
    origin,
    home,
    project,
    worktree: join(root, "state", "journal-wt"),
    lock: join(root, "state", "journal.lock"),
    draft: (slug, body) => {
      n += 1;
      const path = join(project, ".ralph", "logs", `learning-draft-20261006T01000${n % 10}Z-${slug}.md`);
      writeFileSync(path, body ?? entryBody(slug));
      return path;
    },
    options: (extra = {}) => ({
      scope: "project" as const,
      loop: "remo",
      project,
      displayName: "Loggd",
      file: PROJECT_FILE,
      home,
      worktree: join(root, "state", "journal-wt"),
      date: "2026-10-06",
      ...extra,
    }),
    onMain: (file = PROJECT_FILE) =>
      execFileSync("git", ["--git-dir", origin, "show", `main:${file}`], { encoding: "utf8" }),
    landEntry: (slug) => {
      git(other, "pull", "--quiet", "--rebase", "origin", "main");
      const path = join(other, PROJECT_FILE);
      const text = execFileSync("cat", [path], { encoding: "utf8" });
      // The competing writer makes the same shape of edit this publisher does.
      writeFileSync(path, text.replace(/## Open: fix these\n/, `## Open: fix these\n\n${entryBody(slug)}`));
      git(other, "add", "--", PROJECT_FILE);
      git(other, "commit", "--quiet", "-m", `chore(rafa): learning loggd ${slug}`);
      git(other, "push", "--quiet", "origin", "HEAD:main");
    },
    log: () =>
      execFileSync("git", ["--git-dir", origin, "log", "--format=%s", "main"], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean),
  };
}

describe("publishing a new entry", () => {
  it("prepends it, commits only that file, and deletes the draft", () => {
    const w = world();
    const draft = w.draft("opencode-runner-down");
    const result = publishLearning({ ...w.options(), action: { kind: "entry", draft } } as never);
    expect(result.outcome).toBe("added");
    expect(result.slug).toBe("opencode-runner-down");
    expect(result.attempts).toBe(1);
    expect(result.path).toBe(PROJECT_FILE);
    expect(existsSync(draft)).toBe(false);

    const landed = w.onMain();
    expect(parseLearnings(landed).open.map((one) => one.slug)).toEqual([
      "opencode-runner-down",
      "tmdb-fixture-missing",
    ]);
    // The sections around Open are untouched.
    expect(landed).toContain("## Host hygiene: check these first when loops go slow or red");
    expect(w.log()[0]).toBe("chore(remo): learning loggd opencode-runner-down");
    expect(
      execFileSync("git", ["--git-dir", w.origin, "show", "--name-only", "--format=", "main"], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean),
    ).toEqual([PROJECT_FILE]);
  });

  it("writes a harness learning to learnings/harness.md and says 'harness' in the subject", () => {
    const w = world({ [PROJECT_FILE]: SEEDED, "learnings/harness.md": HARNESS_SEEDED });
    const draft = w.draft("host-lease-starves-loops");
    const result = publishLearning({
      ...w.options({ scope: "harness", file: "learnings/harness.md" }),
      action: { kind: "entry", draft },
    } as never);
    expect(result.path).toBe("learnings/harness.md");
    expect(w.log()[0]).toBe("chore(remo): learning harness host-lease-starves-loops");
    expect(parseLearnings(w.onMain("learnings/harness.md")).open).toHaveLength(2);
    // The project's file is not touched by a harness learning.
    expect(w.onMain()).toBe(SEEDED);
  });

  it("creates the file for a project that has learned nothing yet", () => {
    const w = world({ "learnings/harness.md": HARNESS_SEEDED });
    publishLearning({ ...w.options(), action: { kind: "entry", draft: w.draft("first-lesson") } } as never);
    const landed = w.onMain();
    expect(landed).toContain("# loggd learnings");
    expect(landed).toContain("## Open: fix these");
    expect(parseLearnings(landed).open.map((one) => one.slug)).toEqual(["first-lesson"]);
  });
});

describe("publishing a slug that is already open", () => {
  it("appends a Seen again line instead of a second entry", () => {
    const w = world();
    const result = publishLearning({
      ...w.options(),
      action: { kind: "entry", draft: w.draft("tmdb-fixture-missing") },
    } as never);
    expect(result.outcome).toBe("seen-again");
    const parsed = parseLearnings(w.onMain());
    expect(parsed.open).toHaveLength(1);
    expect(parsed.open[0]?.body).toContain("- **Seen again:** 2026-10-06");
    // The original text of the entry survives above the new line.
    expect(parsed.open[0]?.body).toContain("- **Fix:** #1890.");
    expect(w.log()[0]).toBe("chore(remo): learning loggd tmdb-fixture-missing");
  });
});

describe("revising an open entry", () => {
  const corrected = (slug: string) =>
    `### A missing TMDB fixture parks PRs (2026-10-12)\n<!-- learning: ${slug} -->\n- **Seen:** the stub has no genre-discover fixture; the hold it used to name is gone.\n- **Workaround:** skip the genre suites.\n- **Fix:** #1890.\n`;

  it("replaces the entry in place, stays open, and adds no Seen again line", () => {
    const w = world();
    const result = publishLearning({
      ...w.options(),
      action: { kind: "revise", draft: w.draft("tmdb-fixture-missing", corrected("tmdb-fixture-missing")) },
    } as never);
    expect(result.outcome).toBe("revised");
    const parsed = parseLearnings(w.onMain());
    expect(parsed.open).toHaveLength(1);
    expect(parsed.open[0]?.slug).toBe("tmdb-fixture-missing");
    expect(parsed.open[0]?.title).toBe("A missing TMDB fixture parks PRs (2026-10-12)");
    expect(parsed.open[0]?.body).toContain("- **Workaround:** skip the genre suites.");
    expect(parsed.open[0]?.body).not.toContain("Seen again");
    expect(parsed.fixed).toEqual([]);
    expect(w.onMain()).toContain("## Host hygiene");
    expect(w.log()[0]).toBe("chore(remo): learning loggd tmdb-fixture-missing");
  });

  it("deletes the draft once the revision has landed", () => {
    const w = world();
    const draft = w.draft("tmdb-fixture-missing", corrected("tmdb-fixture-missing"));
    publishLearning({ ...w.options(), action: { kind: "revise", draft } } as never);
    expect(existsSync(draft)).toBe(false);
  });

  it("keeps a neighbour's entry when the revision lands on a rejected push", () => {
    const w = world();
    const draft = w.draft("tmdb-fixture-missing", corrected("tmdb-fixture-missing"));
    const result = publishLearning({
      ...w.options(),
      action: { kind: "revise", draft },
      beforePush: (attempt: number) => {
        if (attempt === 1) w.landEntry("other-loops-entry");
      },
    } as never);
    expect([result.outcome, result.attempts]).toEqual(["revised", 2]);
    const parsed = parseLearnings(w.onMain());
    expect(parsed.open.map((one) => one.slug)).toEqual(["other-loops-entry", "tmdb-fixture-missing"]);
    expect(parsed.open[1]?.body).toContain("skip the genre suites");
  });

  it("says the revision is already published when main already says it, committing nothing", () => {
    const w = world();
    const body = corrected("tmdb-fixture-missing");
    const first = publishLearning({
      ...w.options(),
      action: { kind: "revise", draft: w.draft("tmdb-fixture-missing", body) },
    } as never);
    const again = publishLearning({
      ...w.options(),
      action: { kind: "revise", draft: w.draft("tmdb-fixture-missing", body) },
    } as never);
    expect(again.outcome).toBe("revised");
    expect(again.alreadyPublished).toBe(true);
    expect(again.sha).toBe(first.sha);
    // One commit for the two runs: the second had nothing to say.
    expect(w.log().filter((subject) => subject.includes("tmdb-fixture-missing"))).toHaveLength(1);
  });

  it("carries the entry's Seen again lines over a correction that omits them", () => {
    const w = world();
    publishLearning({
      ...w.options(),
      action: { kind: "entry", draft: w.draft("tmdb-fixture-missing") },
    } as never);
    expect(parseLearnings(w.onMain()).open[0]?.body).toContain("- **Seen again:** 2026-10-06");
    publishLearning({
      ...w.options(),
      action: { kind: "revise", draft: w.draft("tmdb-fixture-missing", corrected("tmdb-fixture-missing")) },
    } as never);
    const body = parseLearnings(w.onMain()).open[0]?.body as string;
    expect(body).toContain("- **Workaround:** skip the genre suites.");
    expect(body.match(/\*\*Seen again:\*\*/g)).toHaveLength(1);
  });

  it("refuses a slug that is not open, rather than adding it", () => {
    const w = world();
    expect(() =>
      publishLearning({
        ...w.options(),
        action: { kind: "revise", draft: w.draft("never-seen", entryBody("never-seen")) },
      } as never),
    ).toThrow(/no open learning carries the slug 'never-seen'/);
    expect(parseLearnings(w.onMain()).open).toHaveLength(1);
    expect(w.log()).toEqual(["init"]);
  });

  it("refuses a file that is not on origin/main, saying there is nothing to revise", () => {
    const bare = world({ "learnings/harness.md": HARNESS_SEEDED });
    expect(() =>
      publishLearning({
        ...bare.options(),
        action: { kind: "revise", draft: bare.draft("x", entryBody("x")) },
      } as never),
    ).toThrow(/is not on the harness's origin\/main, so there is nothing to revise/);
  });
});

describe("closing an entry", () => {
  it("moves it into the Fixed table against the PR that fixed it", () => {
    const w = world();
    const result = publishLearning({
      ...w.options(),
      action: { kind: "close", slug: "tmdb-fixture-missing", pr: 1890 },
    } as never);
    expect(result.outcome).toBe("closed");
    const parsed = parseLearnings(w.onMain());
    expect(parsed.open).toEqual([]);
    expect(parsed.fixed).toEqual([{ problem: "A missing TMDB fixture parks PRs", fixedBy: "#1890" }]);
    expect(w.onMain()).toContain("## Host hygiene");
    expect(w.log()[0]).toBe("chore(remo): learning loggd tmdb-fixture-missing");
  });

  it("refuses a slug that is not open, and a file that is not on origin/main", () => {
    const w = world();
    expect(() =>
      publishLearning({ ...w.options(), action: { kind: "close", slug: "never-seen", pr: 1 } } as never),
    ).toThrow(/no open learning carries the slug 'never-seen'/);
    const bare = world({ "learnings/harness.md": HARNESS_SEEDED });
    expect(() =>
      publishLearning({ ...bare.options(), action: { kind: "close", slug: "x", pr: 1 } } as never),
    ).toThrow(/is not on the harness's origin\/main, so there is nothing to close/);
  });
});

describe("a competing writer", () => {
  it("re-reads origin/main on a rejected push and keeps both entries", () => {
    const w = world();
    const draft = w.draft("ours");
    const result = publishLearning({
      ...w.options(),
      action: { kind: "entry", draft },
      // The other loop lands its own entry in the SAME file after we read it.
      beforePush: (attempt: number) => (attempt === 1 ? w.landEntry("theirs") : undefined),
    } as never);
    expect(result.attempts).toBe(2);
    const slugs = parseLearnings(w.onMain()).open.map((one) => one.slug);
    // Neither entry is lost: the retry read the other loop's file, not ours.
    expect(slugs).toContain("ours");
    expect(slugs).toContain("theirs");
    expect(slugs).toContain("tmdb-fixture-missing");
    expect(existsSync(draft)).toBe(false);
  });

  it("turns our new entry into a Seen again when the other loop filed it first", () => {
    const w = world();
    const result = publishLearning({
      ...w.options(),
      action: { kind: "entry", draft: w.draft("same-lesson") },
      beforePush: (attempt: number) => (attempt === 1 ? w.landEntry("same-lesson") : undefined),
    } as never);
    // The outcome is decided per attempt, against what main holds at the time.
    expect(result.outcome).toBe("seen-again");
    const parsed = parseLearnings(w.onMain());
    expect(parsed.open.filter((one) => one.slug === "same-lesson")).toHaveLength(1);
    expect(parsed.open.find((one) => one.slug === "same-lesson")?.body).toContain("- **Seen again:** 2026-10-06");
  });

  it("gives up after five rejections and keeps the draft", () => {
    const w = world();
    const draft = w.draft("ours");
    let n = 0;
    expect(() =>
      publishLearning({
        ...w.options(),
        action: { kind: "entry", draft },
        beforePush: () => w.landEntry(`theirs-${(n += 1)}`),
      } as never),
    ).toThrow(/the push was rejected 5 times; the draft is kept/);
    expect(existsSync(draft)).toBe(true);
    expect(parseLearnings(w.onMain()).open.map((one) => one.slug)).not.toContain("ours");
  });
});

describe("finding promotion survives publication failures", () => {
  it("keeps the evidence when GitHub fails, then links a ticket on a later retry", () => {
    const w = world();
    const draft = w.draft("github-outage");
    const first = publishLearning({ ...w.options(), action: { kind: "entry", draft },
      promote: () => { throw new Error("GitHub unavailable"); } } as never);
    expect(first.outcome).toBe("added");
    expect(w.onMain()).toContain("no issue yet");
    const second = publishLearning({ ...w.options(), action: { kind: "revise", draft: w.draft("github-outage") },
      promote: (entry: { text: string }) => entry.text.replace("no issue yet.", "https://github.com/your-org/your-repo/issues/42") } as never);
    expect(second.outcome).toBe("revised");
    expect(w.onMain()).toContain("issues/42");
  });

  it("reuses a created ticket when the learning push failed after filing", () => {
    const w = world();
    const rows: { number: number; body: string; url: string }[] = [];
    let created = 0;
    const gh: FindingGh = (args) => {
      // Shaped like `gh api --paginate --slurp`: one array of raw issue pages.
      if (args[0] === "api") return JSON.stringify([rows.map(({ url, ...row }) => ({ ...row, html_url: url }))]);
      if (args[0] === "label") return "";
      created += 1;
      rows.push({ number: 42, body: readFileSync(args[args.indexOf("--body-file") + 1]!, "utf8"), url: "https://github.com/your-org/your-repo/issues/42" });
      return rows[0]!.url;
    };
    const promote = (entry: import("./learnings").LearningEntry) => promoteFinding(entry, { repo: "your-org/your-repo", file: PROJECT_FILE }, gh, join(w.root, "findings.json"));
    const draft = w.draft("filing-before-push");
    expect(() => publishLearning({ ...w.options(), action: { kind: "entry", draft }, promote,
      maxAttempts: 1, beforePush: () => w.landEntry("competing-lesson") } as never)).toThrow("rejected");
    expect(existsSync(draft)).toBe(true);
    publishLearning({ ...w.options(), action: { kind: "entry", draft }, promote } as never);
    expect(created).toBe(1);
    expect(w.onMain()).toContain("https://github.com/your-org/your-repo/issues/42");
    expect(w.onMain()).toContain("competing-lesson");
  });

  const URL = "https://github.com/your-org/your-repo/issues/42";
  // A registry read that never shows the tickets this run created (#481/#482).
  function lagging() {
    let created = 0;
    const gh: FindingGh = (args) => {
      if (args[0] === "api") return JSON.stringify([[]]);
      if (args[0] === "label") return "";
      created += 1;
      return URL;
    };
    return { gh, created: () => created };
  }
  const promoteWith = (gh: FindingGh, record: string) =>
    (entry: import("./learnings").LearningEntry) => promoteFinding(entry, { repo: "your-org/your-repo", file: PROJECT_FILE }, gh, record);

  it("files once across a rejected push even when the registry never shows the ticket", () => {
    const w = world();
    const io = lagging();
    const result = publishLearning({ ...w.options(), action: { kind: "entry", draft: w.draft("lagging-registry") },
      promote: promoteWith(io.gh, join(w.root, "findings.json")), maxAttempts: 3,
      beforePush: (attempt: number) => (attempt === 1 ? w.landEntry("competing-lesson") : undefined) } as never);
    expect(result.attempts).toBe(2);
    expect(io.created()).toBe(1);
    expect(w.onMain()).toContain(`- **Fix:** ${URL}`);
  });

  it("keeps a linked Fix when a stale revise draft still says no issue yet, filing nothing", () => {
    const w = world();
    // Another process already linked the ticket on main...
    const linked = entryBody("stale-revise").replace("- **Fix:** no issue yet.", "- **Fix:** https://github.com/your-org/your-repo/issues/481");
    publishLearning({ ...w.options(), action: { kind: "entry", draft: w.draft("stale-revise", linked) } } as never);
    expect(w.onMain()).toContain("issues/481");
    // ...and this revise was drafted from a snapshot taken before that.
    const io = lagging();
    const result = publishLearning({ ...w.options(), action: { kind: "revise", draft: w.draft("stale-revise") },
      promote: promoteWith(io.gh, join(mkdtempSync(join(w.root, "record-")), "findings.json")) } as never);
    expect(result.outcome).toBe("revised");
    expect(parseLearnings(w.onMain()).open.find((one) => one.slug === "stale-revise")?.body)
      .toContain("- **Fix:** https://github.com/your-org/your-repo/issues/481");
    expect(io.created()).toBe(0);
  });

  // Root writes through a read-only directory, so the failure would not happen.
  it.skipIf(process.getuid?.() === 0)("still links the created ticket when the record cannot be written", () => {
    const w = world();
    const io = lagging();
    const locked = join(w.root, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o555);
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")); });
    try {
      publishLearning({ ...w.options(), action: { kind: "entry", draft: w.draft("unwritable-record") },
        promote: promoteWith(io.gh, join(locked, "findings.json")) } as never);
    } finally {
      spy.mockRestore();
      chmodSync(locked, 0o755);
    }
    expect(io.created()).toBe(1);
    expect(errors.filter((line) => line.startsWith("findings record not written"))).toHaveLength(1);
    expect(w.onMain()).toContain(`- **Fix:** ${URL}`);
  });

  it("publishes the evidence but files nothing when the record is corrupt", () => {
    const w = world();
    const io = lagging();
    const record = join(w.root, "findings.json");
    writeFileSync(record, "{not json");
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")); });
    try {
      expect(publishLearning({ ...w.options(), action: { kind: "entry", draft: w.draft("corrupt-record") },
        promote: promoteWith(io.gh, record) } as never).outcome).toBe("added");
    } finally { spy.mockRestore(); }
    expect(io.created()).toBe(0);
    expect(errors).toContainEqual(expect.stringMatching(/^finding not promoted: .*findings record .* unreadable; no issue created.*; learning kept for retry$/));
    expect(parseLearnings(w.onMain()).open.find((one) => one.slug === "corrupt-record")?.body).toContain("no issue yet");
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
    RALPH_PROJECT_DISPLAY_NAME: "Loggd",
    RALPH_JOURNAL_DIR: "journal/loggd",
    RALPH_LEARNINGS_FILE: PROJECT_FILE,
    RALPH_JOURNAL_LOCKED: "",
  });

  const run = (w: World, ...args: string[]) =>
    new Promise<{ status: number; stdout: string; stderr: string }>((done) => {
      const child = spawn(BUN, [CLI, ...args], { env: cliEnv(w) });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => done({ status: code ?? -1, stdout, stderr }));
    });

  it("publishes an entry, repeats it, and closes it, each as one commit", async () => {
    const w = world();
    const added = await run(w, "--learning", w.draft("opencode-runner-down"), "--scope", "project");
    expect(added.stderr).toBe("");
    expect(added.status).toBe(0);
    expect(added.stdout).toMatch(/learning added: opencode-runner-down in learnings\/loggd\.md at [0-9a-f]{40}/);

    const again = await run(w, "--learning", w.draft("opencode-runner-down"), "--scope", "project");
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("learning seen-again: opencode-runner-down");

    const closed = await run(w, "--close", "opencode-runner-down", "--pr", "233", "--scope", "project");
    expect(closed.status).toBe(0);
    expect(closed.stdout).toContain("learning closed: opencode-runner-down");

    // The three subjects are byte-identical, so asserting them alone would pass
    // a close that emitted two commits. The length is what pins "one commit".
    expect(w.log()).toEqual([
      "chore(rafa): learning loggd opencode-runner-down",
      "chore(rafa): learning loggd opencode-runner-down",
      "chore(rafa): learning loggd opencode-runner-down",
      "init",
    ]);
    const parsed = parseLearnings(w.onMain());
    expect(parsed.open.map((one) => one.slug)).toEqual(["tmdb-fixture-missing"]);
    expect(parsed.fixed).toEqual([{ problem: "The executor runner is unavailable", fixedBy: "#233" }]);
  }, 60_000);

  it("leaves the project's .ralph alone apart from removing the draft", async () => {
    const w = world();
    const ralph = join(w.project, ".ralph");
    const tree = () =>
      readdirSync(ralph, { recursive: true, withFileTypes: true })
        .map((one) => join(one.parentPath.slice(ralph.length), one.name))
        .sort();
    const draft = w.draft("opencode-runner-down");
    const before = tree();
    const published = await run(w, "--learning", draft, "--scope", "project");
    expect(published.status).toBe(0);
    // Exactly one change, and it is the draft going away.
    expect(tree()).toEqual(before.filter((path) => !path.endsWith(basename(draft))));
    expect(before).toContain(join("/logs", basename(draft)));
  }, 60_000);

  it("serialises two concurrent publishers of the same file, and loses neither entry", async () => {
    const w = world();
    const [one, two] = await Promise.all([
      run(w, "--learning", w.draft("first-lesson"), "--scope", "project"),
      run(w, "--learning", w.draft("second-lesson"), "--scope", "project"),
    ]);
    expect([one.status, two.status]).toEqual([0, 0]);
    expect(one.stderr).toBe("");
    expect(two.stderr).toBe("");
    const slugs = parseLearnings(w.onMain()).open.map((entry) => entry.slug);
    expect(slugs).toContain("first-lesson");
    expect(slugs).toContain("second-lesson");
    expect(slugs).toContain("tmdb-fixture-missing");
    expect(w.log().filter((subject) => subject.startsWith("chore(rafa): learning"))).toHaveLength(2);
    // Serialised by the lock, so neither had to retry.
    expect(`${one.stdout}${two.stdout}`).not.toContain("attempt");
  }, 60_000);

  it("revises an open entry through the CLI, as one commit", async () => {
    const w = world();
    const draft = w.draft(
      "tmdb-fixture-missing",
      `### A missing TMDB fixture parks PRs (2026-10-12)\n<!-- learning: tmdb-fixture-missing -->\n- **Seen:** still no genre-discover fixture.\n- **Workaround:** skip the genre suites.\n- **Fix:** #1890.\n`,
    );
    const out = await run(w, "--revise", draft, "--scope", "project");
    expect(out.stderr).toBe("");
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/learning revised: tmdb-fixture-missing in learnings\/loggd\.md at [0-9a-f]{40}/);
    expect(w.log()).toEqual(["chore(rafa): learning loggd tmdb-fixture-missing", "init"]);
    expect(parseLearnings(w.onMain()).open[0]?.body).toContain("skip the genre suites");
    expect(existsSync(draft)).toBe(false);
  }, 60_000);

  it("refuses a bad command without taking the lock", async () => {
    const w = world();
    const noScope = await run(w, "--learning", w.draft("x"));
    expect(noScope.status).toBe(1);
    expect(noScope.stderr).toContain("learning not published: --scope must be 'project' or 'harness'");

    const reviseNoScope = await run(w, "--revise", w.draft("tmdb-fixture-missing"));
    expect(reviseNoScope.status).toBe(1);
    expect(reviseNoScope.stderr).toContain("learning not published: --scope must be 'project' or 'harness'");

    const noPr = await run(w, "--close", "tmdb-fixture-missing", "--scope", "project");
    expect(noPr.status).toBe(2);
    expect(noPr.stderr).toContain("usage: publish-journal.ts --draft");

    const badPr = await run(w, "--close", "tmdb-fixture-missing", "--pr", "zero", "--scope", "project");
    expect(badPr.status).toBe(1);
    expect(badPr.stderr).toContain("--pr must be a pull request number; got 'zero'");

    const nothing = await run(w);
    expect(nothing.status).toBe(2);
    expect(nothing.stderr).toContain("publish-journal.ts --learning <draft> --scope project|harness");
    // Nothing landed on main.
    expect(w.log()).toEqual(["init"]);
  }, 60_000);

  it("refuses a project learning whose Change is harness code, naming --scope harness (#815)", async () => {
    const w = world();
    // The harness checkout reads as another repository, as ~/ralph does to loggd.
    const config = JSON.parse(readFileSync(join(w.project, ".ralph", "config.json"), "utf8"));
    mkdirSync(join(w.home, ".ralph"), { recursive: true });
    writeFileSync(join(w.home, ".ralph", "config.json"), JSON.stringify({ ...config, repo: "your-org/harness" }));
    const harnessChange = (slug: string) => `${entryBody(slug)}- **Change:** add a queued outcome to pr-wait.ts.\n`;

    const draft = w.draft("ci-wait-queued", harnessChange("ci-wait-queued"));
    const refused = await run(w, "--learning", draft, "--scope", "project");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("learning not published: the Change line names harness code (pr-wait.ts)");
    expect(refused.stderr).toContain("--scope harness");
    // Nothing landed, and the draft is kept for the right scope.
    expect(w.log()).toEqual(["init"]);
    expect(existsSync(draft)).toBe(true);

    const harness = await run(w, "--learning", draft, "--scope", "harness");
    expect(harness.stderr).toBe("");
    expect(harness.status).toBe(0);
    expect(harness.stdout).toContain("learning added: ci-wait-queued in learnings/harness.md");

    // An entry already in the project file has nowhere else to go: a sighting
    // and a revision of it still publish, and only the filing is skipped.
    const sighting = await run(w, "--learning", w.draft("tmdb-fixture-missing", harnessChange("tmdb-fixture-missing")), "--scope", "project");
    expect(sighting.status).toBe(0);
    expect(sighting.stdout).toContain("learning seen-again: tmdb-fixture-missing");
    // Its Fix is linked, so the revision files nothing and says nothing.
    const revised = await run(w, "--revise", w.draft("tmdb-fixture-missing", harnessChange("tmdb-fixture-missing")), "--scope", "project");
    expect(revised.stderr).toBe("");
    expect(revised.status).toBe(0);
    expect(revised.stdout).toContain("learning revised: tmdb-fixture-missing");
  }, 60_000);

  it("revises a pending project entry with a harness Change but files nothing, so reconcile cannot wedge on it (#815)", async () => {
    const pending = `${entryBody("ci-wait-queued")}- **Change:** add a queued outcome to pr-wait.ts.\n`;
    const w = world({ [PROJECT_FILE]: SEEDED.replace("## Open: fix these\n", `## Open: fix these\n\n${pending}`) });
    const config = JSON.parse(readFileSync(join(w.project, ".ralph", "config.json"), "utf8"));
    mkdirSync(join(w.home, ".ralph"), { recursive: true });
    writeFileSync(join(w.home, ".ralph", "config.json"), JSON.stringify({ ...config, repo: "your-org/harness" }));
    const revised = await run(w, "--revise", w.draft("ci-wait-queued", pending.replace("implement in session", "wait it out")), "--scope", "project");
    expect(revised.status).toBe(0);
    expect(revised.stdout).toContain("learning revised: ci-wait-queued");
    expect(revised.stderr).toContain("finding not filed: ci-wait-queued — the Change line names harness code (pr-wait.ts)");
    expect(parseLearnings(w.onMain()).open.find((one) => one.slug === "ci-wait-queued")?.body).toContain("wait it out");
  }, 60_000);

  it("reconcile skips a pending project entry with a harness Change rather than spending its batch on it (#815)", () => {
    const pending = `${entryBody("ci-wait-queued")}- **Change:** add a queued outcome to pr-wait.ts.\n`;
    const w = world({ [PROJECT_FILE]: SEEDED.replace("## Open: fix these\n", `## Open: fix these\n\n${pending}`) });
    const config = JSON.parse(readFileSync(join(w.project, ".ralph", "config.json"), "utf8"));
    writeFileSync(join(w.project, ".ralph", "config.json"), JSON.stringify({ ...config, learnings: { file: PROJECT_FILE } }));
    mkdirSync(join(w.home, ".ralph"), { recursive: true });
    writeFileSync(join(w.home, ".ralph", "config.json"), JSON.stringify({ ...config, repo: "your-org/harness" }));
    vi.stubEnv("RALPH_FINDINGS_DISABLED", "");
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: string) => void errors.push(line));
    try {
      // Nothing else is pending, so a skipped entry publishes nothing at all.
      expect(reconcileFindings(w.project, w.home)).toBe(0);
    } finally {
      spy.mockRestore();
      vi.unstubAllEnvs();
    }
    expect(errors).toContainEqual(expect.stringMatching(/^findings: skipped ci-wait-queued: the Change line names harness code \(pr-wait\.ts\)/));
    expect(w.log()).toEqual(["init"]);
  });

  it("refuses a project learning when the project opted out", async () => {
    const w = world();
    const out = await new Promise<{ status: number; stderr: string }>((done) => {
      const child = spawn(BUN, [CLI, "--learning", w.draft("x"), "--scope", "project"], {
        env: { ...cliEnv(w), RALPH_LEARNINGS_FILE: "" },
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => done({ status: code ?? -1, stderr }));
    });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("this project has no learnings file");
  }, 60_000);
});

describe("the draft contract", () => {
  it("names the slug in the file name and the body, and refuses a disagreement", () => {
    const w = world();
    expect(validateLearningDraft(w.draft("good-slug"), w.project).slug).toBe("good-slug");
    const mismatched = w.draft("named-one", entryBody("body-says-another"));
    expect(() => validateLearningDraft(mismatched, w.project)).toThrow(
      /named 'named-one' but its body says 'body-says-another'/,
    );
    const noComment = w.draft("no-comment", "### A title\n- **Seen:** nothing.\n");
    expect(() => validateLearningDraft(noComment, w.project)).toThrow(/carries no '<!-- learning: no-comment -->'/);
  });

  it("refuses a draft outside .ralph/logs, a misnamed one, and an empty one", () => {
    const w = world();
    const outside = join(w.root, "learning-draft-20261006T010000Z-slug.md");
    writeFileSync(outside, entryBody("slug"));
    expect(() => validateLearningDraft(outside, w.project)).toThrow(/must be a file directly inside/);

    const misnamed = join(w.project, ".ralph", "logs", "learning-draft-nope.md");
    writeFileSync(misnamed, entryBody("slug"));
    expect(() => validateLearningDraft(misnamed, w.project)).toThrow(
      /must be named learning-draft-<YYYYMMDDTHHMMSSZ>-<slug>\.md/,
    );

    const empty = join(w.project, ".ralph", "logs", "learning-draft-20261006T010000Z-empty.md");
    writeFileSync(empty, "");
    expect(() => validateLearningDraft(empty, w.project)).toThrow(/the draft is missing or empty/);
  });

  it("accepts only a lowercase-hyphen slug in the name", () => {
    expect(LEARNING_DRAFT_NAME.test("learning-draft-20261006T010000Z-a-good-slug.md")).toBe(true);
    expect(LEARNING_DRAFT_NAME.test("learning-draft-20261006T010000Z-Bad_Slug.md")).toBe(false);
    expect(LEARNING_DRAFT_NAME.test("learning-draft-2026-10-06-slug.md")).toBe(false);
  });
});

describe("the flags", () => {
  it("tells the four modes apart, and an empty command from all of them", () => {
    expect(mode(["--draft", "d", "--issue", "1"])).toBe("journal");
    expect(mode(["--learning", "d", "--scope", "project"])).toBe("learning");
    expect(mode(["--revise", "d", "--scope", "harness"])).toBe("revise");
    expect(mode(["--close", "slug", "--pr", "2", "--scope", "harness"])).toBe("close");
    expect(mode([])).toBeNull();
    // A learning wins over a stray --draft: the modes are not combinable, and
    // reading it as a journal would publish the wrong thing silently.
    expect(mode(["--learning", "d", "--draft", "x"])).toBe("learning");
  });

  it("names the file and the commit's word per scope", () => {
    const w = world();
    expect(learningTarget("harness", { project: w.project })).toEqual({ file: "learnings/harness.md" });
    expect(
      learningTarget("project", { project: w.project, env: { RALPH_LEARNINGS_FILE: "learnings/ralph.md" } }),
    ).toEqual({ file: "learnings/ralph.md" });
    expect(learningSubject("rafa", "harness", "a-slug")).toBe("chore(rafa): learning harness a-slug");
    // The project token is the display name lower-cased, which is what the
    // journal's own subject does (`chore(rafa): journal software factory #164`).
    expect(learningSubject("rafa", "software factory", "a-slug")).toBe(
      "chore(rafa): learning software factory a-slug",
    );
  });
});
