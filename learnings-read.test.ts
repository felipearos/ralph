// @vitest-environment node
/**
 * The read half of the learnings path. Read-only by design, so the suite's job
 * is mostly to prove the refusals are soft: a project that opted out, a file
 * that is not on `origin/main` yet, and a harness that has no learnings at all
 * must each orient a loop rather than fail it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { bunPath, cleanupFixtures, removeScratchDir, writeProjectConfig } from "./dashboard/fixtures";
import { HARNESS_FILE } from "./learnings";
import { capBytes, projectFile, readLearnings, renderLearnings } from "./learnings-read";
import { fixtureGitEnv, stripGitLocationEnv } from "./test-git-env";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("drives git against a fixture harness repository");
stripGitLocationEnv();

const GIT_ENV = fixtureGitEnv({
  GIT_AUTHOR_NAME: "Learnings Test",
  GIT_AUTHOR_EMAIL: "learnings@example.invalid",
  GIT_COMMITTER_NAME: "Learnings Test",
  GIT_COMMITTER_EMAIL: "learnings@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeScratchDir(root);
  cleanupFixtures();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV });

const PROJECT_LEARNINGS = `# loggd learnings

## Open: fix these

### A missing TMDB fixture parks PRs (2026-09-30)
<!-- learning: tmdb-fixture-missing -->
- **Seen:** the hermetic stub has no genre-discover fixture.
- **Fix:** #1890.

## Fixed: kept for context

| Problem | Fixed by |
| --- | --- |
| Something old | #1 |
`;

const HARNESS_LEARNINGS = `# Harness learnings

## Open: fix these

### Parked PRs starve the loops (2026-09-30)
<!-- learning: parked-prs-starve-loops -->
- **Seen:** 5 loops idled 6-8 h behind 3 parked PRs.
- **Fix:** ralph #155.
`;

interface World {
  /** A harness checkout whose `origin/main` carries the committed learnings. */
  home: string;
  /** A scratch project with a `.ralph/config.json`. */
  project: string;
}

/**
 * A harness repository with a real `origin/main`: a bare origin plus a clone,
 * so `git show origin/main:<file>` resolves the way it does in production and
 * a file left only in the working tree is correctly invisible.
 */
function world(files: Record<string, string> = {}): World {
  const root = mkdtempSync(join(tmpdir(), "ralph-learnings-read-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const home = join(root, "home");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  execFileSync("git", ["clone", "--quiet", origin, home], { encoding: "utf8", env: GIT_ENV });
  writeFileSync(join(home, "README.md"), "harness\n");
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(home, file)), { recursive: true });
    writeFileSync(join(home, file), text);
  }
  git(home, "add", "--all");
  git(home, "commit", "--quiet", "-m", "learnings");
  git(home, "push", "--quiet", "origin", "HEAD:main");
  const project = join(root, "project");
  mkdirSync(join(project, ".ralph", "logs"), { recursive: true });
  writeProjectConfig(project);
  return { home, project };
}

describe("projectFile", () => {
  it("prefers the exported path, and reads an empty export as opted out", () => {
    const { project } = world();
    expect(projectFile(project, { RALPH_LEARNINGS_FILE: "learnings/elsewhere.md" })).toBe("learnings/elsewhere.md");
    expect(projectFile(project, { RALPH_LEARNINGS_FILE: "" })).toBe("opted-out");
    expect(projectFile(project, { RALPH_LEARNINGS_FILE: "   " })).toBe("opted-out");
  });

  it("falls back to the config when nothing is exported", () => {
    const { project } = world();
    // dashboard/fixtures writes journal.dir journal/fixture.
    expect(projectFile(project, {})).toBe("learnings/fixture.md");
  });

  it("tells opting out apart from a config it could not read", () => {
    const { project } = world();
    writeFileSync(
      join(project, ".ralph", "config.json"),
      JSON.stringify({ ...JSON.parse(readFileSync(join(project, ".ralph", "config.json"), "utf8")), learnings: false }),
    );
    expect(projectFile(project, {})).toBe("opted-out");
    // Two states, not one: the publisher refuses on both and must say which.
    const bare = mkdtempSync(join(tmpdir(), "ralph-no-config-"));
    roots.push(bare);
    expect(projectFile(bare, {})).toBe("unreadable");
  });
});

describe("readLearnings", () => {
  it("reads both files out of origin/main, project first", () => {
    const { home, project } = world({
      "learnings/fixture.md": PROJECT_LEARNINGS,
      [HARNESS_FILE]: HARNESS_LEARNINGS,
    });
    const sources = readLearnings(project, home, {});
    expect(sources.map((one) => [one.scope, one.file, one.present])).toEqual([
      ["project", "learnings/fixture.md", true],
      ["harness", HARNESS_FILE, true],
    ]);
    expect(sources[0]?.open).toContain("### A missing TMDB fixture parks PRs (2026-09-30)");
    expect(sources[1]?.open).toContain("### Parked PRs starve the loops (2026-09-30)");
  });

  it("gives the Open section only — never Fixed, and never the prose preamble", () => {
    const { home, project } = world({ "learnings/fixture.md": PROJECT_LEARNINGS });
    const open = readLearnings(project, home, {})[0]?.open as string;
    expect(open).toContain("- **Fix:** #1890.");
    expect(open).not.toContain("## Fixed");
    expect(open).not.toContain("Something old");
    expect(open).not.toContain("# loggd learnings");
  });

  it("tolerates a missing file rather than failing the orientation", () => {
    const { home, project } = world({ [HARNESS_FILE]: HARNESS_LEARNINGS });
    const sources = readLearnings(project, home, {});
    expect(sources[0]).toMatchObject({ scope: "project", present: false, open: "" });
    expect(sources[1]).toMatchObject({ scope: "harness", present: true });
    // A harness with no learnings at all is also fine.
    const bare = world();
    expect(readLearnings(bare.project, bare.home, {}).every((one) => !one.present)).toBe(true);
  });

  it("does not see a file that exists only in the harness's working tree", () => {
    const { home, project } = world();
    mkdirSync(join(home, "learnings"), { recursive: true });
    writeFileSync(join(home, "learnings", "fixture.md"), PROJECT_LEARNINGS);
    expect(readLearnings(project, home, {})[0]?.present).toBe(false);
  });

  it("says a harness it could not read is UNKNOWN, not 'nothing learned so far'", () => {
    // The prompt declares these entries binding while a loop diagnoses, so
    // "nothing has been learned" over a broken checkout would send it off to
    // re-diagnose from scratch — the failure this whole path exists to end.
    const { project } = world();
    const noRepo = mkdtempSync(join(tmpdir(), "ralph-not-a-repo-"));
    roots.push(noRepo);
    const sources = readLearnings(project, noRepo, {});
    expect(sources.every((one) => !one.present)).toBe(true);
    expect(sources.every((one) => !one.readable)).toBe(true);
    const out = renderLearnings(sources);
    expect(out).toContain("could not be read — treat this list as UNKNOWN, not empty");
    expect(out).not.toContain("nothing learned so far");
  });

  it("marks a readable harness as such, so a missing file really is absent", () => {
    const { home, project } = world({ [HARNESS_FILE]: HARNESS_LEARNINGS });
    const sources = readLearnings(project, home, {});
    expect(sources.every((one) => one.readable)).toBe(true);
    expect(renderLearnings(sources)).toContain("nothing learned so far");
  });

  it("drops the project file entirely when the project opted out", () => {
    const { home, project } = world({ [HARNESS_FILE]: HARNESS_LEARNINGS });
    const sources = readLearnings(project, home, { RALPH_LEARNINGS_FILE: "" });
    expect(sources).toHaveLength(1);
    expect(sources[0]?.scope).toBe("harness");
  });

  it("caps each file independently and says what it dropped", () => {
    const many = ["a", "b", "c", "d", "e", "f"]
      .map((slug) => `### Entry ${slug}\n<!-- learning: slug-${slug} -->\n- **Seen:** a long enough line to cost bytes.`)
      .join("\n\n");
    const { home, project } = world({
      "learnings/fixture.md": `# x learnings\n\n## Open: fix these\n\n${many}\n`,
      [HARNESS_FILE]: HARNESS_LEARNINGS,
    });
    const capped = readLearnings(project, home, { RALPH_LEARNINGS_CAP_BYTES: "200" });
    expect(capped[0]?.open).toContain("older entries dropped (cap 0.2 KB), still open:");
    // The harness file is small, so the same cap leaves it whole.
    expect(capped[1]?.open).not.toContain("dropped");
    expect(readLearnings(project, home, {})[0]?.open).not.toContain("dropped");
  });
});

describe("capBytes", () => {
  it("defaults to 8 KB and ignores a value that is not a positive number", () => {
    expect(capBytes({})).toBe(8 * 1024);
    expect(capBytes({ RALPH_LEARNINGS_CAP_BYTES: "" })).toBe(8 * 1024);
    expect(capBytes({ RALPH_LEARNINGS_CAP_BYTES: "nonsense" })).toBe(8 * 1024);
    expect(capBytes({ RALPH_LEARNINGS_CAP_BYTES: "-5" })).toBe(8 * 1024);
    expect(capBytes({ RALPH_LEARNINGS_CAP_BYTES: "4096" })).toBe(4096);
  });
});

describe("renderLearnings", () => {
  it("heads each file with its scope and path", () => {
    const { home, project } = world({
      "learnings/fixture.md": PROJECT_LEARNINGS,
      [HARNESS_FILE]: HARNESS_LEARNINGS,
    });
    const out = renderLearnings(readLearnings(project, home, {}));
    expect(out).toContain("=== open learnings (project): learnings/fixture.md");
    expect(out).toContain("=== open learnings (harness): learnings/harness.md");
    expect(out.indexOf("(project)")).toBeLessThan(out.indexOf("(harness)"));
    expect(out.endsWith("\n")).toBe(true);
  });

  it("says in words that a file is absent or empty, rather than printing a blank", () => {
    const { home, project } = world();
    const out = renderLearnings(readLearnings(project, home, {}));
    expect(out).toContain("(not published yet — nothing learned so far)");
    const empty = world({ [HARNESS_FILE]: "# Harness learnings\n\n## Open: fix these\n" });
    expect(renderLearnings(readLearnings(empty.project, empty.home, {}))).toContain("(no open entries)");
    expect(renderLearnings([])).toBe("No learnings are configured for this project.\n");
  });
});

describe("the CLI", () => {
  it("prints both files and exits 0, and refuses an unknown command", () => {
    const { home, project } = world({
      "learnings/fixture.md": PROJECT_LEARNINGS,
      [HARNESS_FILE]: HARNESS_LEARNINGS,
    });
    const env = {
      ...GIT_ENV,
      RALPH_PROJECT: project,
      RALPH_LEARNINGS_HOME: home,
      RALPH_LEARNINGS_FILE: "learnings/fixture.md",
    };
    const show = spawnSync(bunPath(), [join(import.meta.dirname, "learnings-read.ts"), "show"], {
      encoding: "utf8",
      cwd: project,
      env,
    });
    expect(show.stderr).toBe("");
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("=== open learnings (project): learnings/fixture.md");
    expect(show.stdout).toContain("### Parked PRs starve the loops (2026-09-30)");

    const bad = spawnSync(bunPath(), [join(import.meta.dirname, "learnings-read.ts")], {
      encoding: "utf8",
      cwd: project,
      env,
    });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("usage: learnings-read.ts show");
  });
});
