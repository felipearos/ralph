// @vitest-environment node
/**
 * The push fence against real git: a scratch bare repository is `origin`, one
 * clone of it is the operator's checkout and another is the medic's. GitHub is
 * the one fake — the pull request's re-read is answered from a function (or,
 * for the CLI, a `gh` script on PATH) — because what it reports is exactly
 * what the fence has to distrust: a head the operator may already have moved.
 *
 * Every refusal is asserted twice: its exit code, and that the remote branch
 * is where the operator left it.
 *
 * felipearos/ralph#247
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { diffGuardProblems } from "../executor-guard/diff-guard";
import {
  eligibilityProblems,
  fence,
  fenceProject,
  INELIGIBLE_EXIT,
  LEASE_LOST_EXIT,
  leaseLost,
  newFindings,
  ownerOf,
  parseArgs,
  REFUSED_DIFF_EXIT,
  UNSIGNED_EXIT,
  USAGE_EXIT,
  type FenceProject,
  type PullRequestView,
  type PushDeps,
  type Ran,
} from "./push";
import type { Unattended } from "./adoption";
import { medicPushes } from "./gate";
import { fixtureGitEnv } from "../test-git-env";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("drives git against a scratch remote");

const BUN = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim();
const CLI = join(__dirname, "push.ts");
const BRANCH = "felipearosr/7-feature";
const LOOP = "medi";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

// No global or system config: a developer's `diff.external`, hooks path or
// signing key must not decide what these fixtures commit or diff.
const GIT_ENV: NodeJS.ProcessEnv = fixtureGitEnv({
  GIT_AUTHOR_NAME: "Fence Test",
  GIT_AUTHOR_EMAIL: "fence@example.invalid",
  GIT_COMMITTER_NAME: "Fence Test",
  GIT_COMMITTER_EMAIL: "fence@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();

const CONFIG = {
  repo: "felipearos/loggd",
  owner: "felipearosr",
  baseBranch: "main",
  displayName: "Loggd",
  secrets: { runner: "none", withhold: [] },
  refuseFiles: [".env.local"],
  envCheck: [],
  requiredChecks: ["buildkite/loggd"],
  gates: { test: "bun run test" },
  promptFragment: ".ralph/prompt.md",
  coderFragment: ".ralph/coder.md",
  plan: ".ralph/plan.md",
  journal: { dir: "journal/loggd" },
  loops: ["ralph", "rafa", { name: LOOP, role: "pr-medic" }],
  prMedic: { branches: ["felipearosr/*"] },
};

const TESTS = [
  'import { expect, it } from "vitest";',
  'import { add, sub } from "./app";',
  'it("adds", () => { expect(add(1, 2)).toBe(3); });',
  'it("subtracts", () => { expect(sub(3, 2)).toBe(1); });',
  "",
].join("\n");

const OTHER_TESTS = [
  'import { expect, it } from "vitest";',
  'it("lists", () => { expect([1].length).toBe(1); });',
  'it("counts", () => { expect([1, 2].length).toBe(2); });',
  "",
].join("\n");

interface World {
  origin: string;
  operator: string;
  medic: string;
  /** The PR head the medic fetched. */
  sha: string;
  /** Write (or, for null, delete) files in `dir` and commit them. */
  commit: (dir: string, files: Record<string, string | null>, message: string) => string;
  remoteHead: (branch?: string) => string;
}

function world(): World {
  const root = mkdtempSync(join(tmpdir(), "ralph-pr-medic-push-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const operator = join(root, "operator");
  const medic = join(root, "medic");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: GIT_ENV });
  execFileSync("git", ["clone", "-q", origin, operator], { env: GIT_ENV, stdio: "ignore" });

  const commit = (dir: string, files: Record<string, string | null>, message: string): string => {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) {
        git(dir, "rm", "-q", path);
        continue;
      }
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
      git(dir, "add", path);
    }
    git(dir, "commit", "-q", "-m", message);
    return git(dir, "rev-parse", "HEAD");
  };

  git(operator, "checkout", "-q", "-b", "main");
  commit(
    operator,
    {
      "src/app.ts": "export const add = (a: number, b: number) => a + b;\nexport const sub = (a: number, b: number) => a - b;\n",
      "src/app.test.ts": TESTS,
      "src/list.test.ts": OTHER_TESTS,
      "src/util.ts": "export const id = <T>(x: T) => x;\n",
      ".buildkite/pipeline.yml": "steps:\n  - command: bun run test\n",
    },
    "initial",
  );
  git(operator, "push", "-q", "origin", "main");
  git(operator, "checkout", "-q", "-b", BRANCH);
  commit(operator, { "src/app.ts": "export const add = (a: number, b: number) => a + b;\nexport const sub = (a: number, b: number) => a - b;\nexport const mul = (a: number, b: number) => a * b;\n" }, "feature: mul");
  git(operator, "push", "-q", "-u", "origin", BRANCH);

  execFileSync("git", ["clone", "-q", origin, medic], { env: GIT_ENV, stdio: "ignore" });
  git(medic, "checkout", "-q", "-B", BRANCH, `origin/${BRANCH}`);
  // The project's config, as a loop's checkout has it — untracked here so it
  // is never part of a diff the fence judges.
  mkdirSync(join(medic, ".ralph"), { recursive: true });
  writeFileSync(join(medic, ".ralph", "config.json"), JSON.stringify(CONFIG, null, 2));
  appendFileSync(join(medic, ".git", "info", "exclude"), ".ralph/\n");

  return {
    origin,
    operator,
    medic,
    sha: git(medic, "rev-parse", "HEAD"),
    commit,
    remoteHead: (branch = BRANCH) => git(origin, "rev-parse", `refs/heads/${branch}`),
  };
}

const signed = (message: string, loop = LOOP): string => `${message}\n\nPr-Medic: ${loop}`;

/** The pull request as GitHub reports it, the fetched head unless told otherwise. */
const view = (w: World, overrides: Partial<PullRequestView> = {}): PullRequestView => ({
  state: "OPEN",
  isDraft: false,
  headRefName: BRANCH,
  headRefOid: w.sha,
  baseRefName: "main",
  isCrossRepository: false,
  body: "",
  ...overrides,
});

/**
 * Real git in the medic's checkout, a fake `gh`; `afterRead` runs once GitHub
 * has answered. `unattended` is the unattended set, counted on each read.
 */
function deps(
  w: World,
  pr: PullRequestView,
  afterRead: () => void = () => {},
  unattended: Unattended | null = null,
): PushDeps & { ghCalls: string[][]; unattendedReads: () => number } {
  const ghCalls: string[][] = [];
  let reads = 0;
  return {
    ghCalls,
    unattendedReads: () => reads,
    unattended: () => {
      reads += 1;
      return unattended;
    },
    git(args, input): Ran {
      const out = spawnSync("git", args, { cwd: w.medic, input, encoding: "utf8", env: GIT_ENV });
      return { status: out.status ?? 1, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
    },
    gh(args): Ran {
      ghCalls.push(args);
      const answer = { status: 0, stdout: JSON.stringify(pr), stderr: "" };
      afterRead();
      return answer;
    },
    read: (path) => readFileSync(path, "utf8"),
    exists: (path) => {
      try {
        readFileSync(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}

const push = (w: World, pr: PullRequestView = view(w), options: { loop?: string; expect?: string; afterRead?: () => void } = {}) =>
  fence(deps(w, pr, options.afterRead), {
    pr: 2197,
    expect: options.expect ?? w.sha,
    loop: options.loop ?? LOOP,
    project: fenceProject(w.medic),
  });

describe("an eligible push", () => {
  it("lands, pinned to the fetched head, and re-reads the pull request first", () => {
    const w = world();
    const fix = w.commit(w.medic, { "src/util.ts": "export const id = <T>(value: T): T => value;\n" }, signed("fix: type the identity"));
    const d = deps(w, view(w));
    const verdict = fence(d, { pr: 2197, expect: w.sha, loop: LOOP, project: fenceProject(w.medic) });
    expect(verdict.exit).toBe(0);
    expect(verdict.lines.join("\n")).toContain(`to ${BRANCH} (#2197, 1 commit)`);
    expect(w.remoteHead()).toBe(fix);
    expect(d.ghCalls).toEqual([["pr", "view", "2197", "--repo", "felipearos/loggd", "--json", expect.stringContaining("headRefOid")]]);
    // An operator's branch never asks which loops are unattended.
    expect(d.unattendedReads()).toBe(0);
  });

  it("lands on an unattended loop's branch the medic adopted (#425)", () => {
    const w = world();
    const adopted = "ralph/612-dup-rows";
    git(w.medic, "push", "-q", "origin", `HEAD:refs/heads/${adopted}`);
    const fix = w.commit(w.medic, { "src/util.ts": "export const id = <T>(value: T): T => value;\n" }, signed("fix: type the identity"));
    const pr = view(w, { headRefName: adopted, labels: [{ name: `${LOOP}-wip` }] });
    const unattended: Unattended = new Map([["ralph", { loop: "ralph", stopKind: "completed", downSince: "2026-10-22T00:00:00Z" }]]);
    const verdict = fence(deps(w, pr, undefined, unattended), { pr: 2197, expect: w.sha, loop: LOOP, project: fenceProject(w.medic) });
    expect(verdict.exit).toBe(0);
    expect(w.remoteHead(adopted)).toBe(fix);
    expect(w.remoteHead()).toBe(w.sha);

    // The same push with the set unread is refused, and the branch stays put.
    w.commit(w.medic, { "src/util.ts": "export const id = <T>(x: T): T => x;\n" }, signed("fix: again"));
    const refused = fence(deps(w, { ...pr, headRefOid: fix }, undefined, null), {
      pr: 2197,
      expect: fix,
      loop: LOOP,
      project: fenceProject(w.medic),
    });
    expect(refused.exit).toBe(INELIGIBLE_EXIT);
    expect(refused.lines.join("\n")).toContain("could not be read");
    expect(w.remoteHead(adopted)).toBe(fix);
  });

  it("accepts an abbreviated --expect, and pins the lease to the full sha", () => {
    const w = world();
    const fix = w.commit(w.medic, { "src/util.ts": "export const id = <T>(value: T): T => value;\n" }, signed("fix"));
    expect(push(w, view(w), { expect: w.sha.slice(0, 10) }).exit).toBe(0);
    expect(w.remoteHead()).toBe(fix);
  });

  it("pushes nothing, and says so, when HEAD is still the fetched head", () => {
    const w = world();
    const verdict = push(w);
    expect(verdict.exit).toBe(0);
    expect(verdict.lines.join("\n")).toContain("nothing to push");
    expect(w.remoteHead()).toBe(w.sha);
  });
});

describe("the eligibility re-read (exit 3)", () => {
  const refusedWith = (overrides: (w: World) => Partial<PullRequestView>, pattern: RegExp): void => {
    const w = world();
    w.commit(w.medic, { "src/util.ts": "export const id = <T>(value: T): T => value;\n" }, signed("fix"));
    const verdict = push(w, view(w, overrides(w)));
    expect(verdict.exit).toBe(INELIGIBLE_EXIT);
    expect(verdict.lines.join("\n")).toMatch(pattern);
    expect(w.remoteHead()).toBe(w.sha);
  };

  it("refuses an agent's branch", () => refusedWith(() => ({ headRefName: "ralph/612-dup-rows" }), /matches none of prMedic\.branches/));
  it("refuses a draft", () => refusedWith(() => ({ isDraft: true }), /draft/));
  it("refuses a head that moved since the fetch", () => refusedWith(() => ({ headRefOid: "f".repeat(40) }), /somebody pushed/));
  it("refuses a closed pull request", () => refusedWith(() => ({ state: "MERGED" }), /merged, not open/));
  it("refuses a fork's branch", () => refusedWith(() => ({ isCrossRepository: true }), /fork/));

  it("refuses a loop that is not the project's medic", () => {
    const w = world();
    w.commit(w.medic, { "src/util.ts": "export const id = <T>(value: T): T => value;\n" }, signed("fix", "ralph"));
    const verdict = push(w, view(w), { loop: "ralph" });
    expect(verdict.exit).toBe(INELIGIBLE_EXIT);
    expect(verdict.lines.join("\n")).toContain("'ralph' is not a pr-medic");
    expect(w.remoteHead()).toBe(w.sha);
  });
});

describe("the diff guard (exit 10)", () => {
  it("refuses a weakened test", () => {
    const w = world();
    w.commit(w.medic, { "src/app.test.ts": TESTS.replace('it("subtracts"', 'it.skip("subtracts"') }, signed("fix: quiet the flake"));
    const verdict = push(w);
    expect(verdict.exit).toBe(REFUSED_DIFF_EXIT);
    expect(verdict.lines.join("\n")).toContain("src/app.test.ts: adds `.skip`");
    expect(w.remoteHead()).toBe(w.sha);
  });

  it("refuses a CI-configuration edit", () => {
    const w = world();
    w.commit(w.medic, { ".buildkite/pipeline.yml": "steps:\n  - command: bun run test || true\n" }, signed("ci: tolerate"));
    const verdict = push(w);
    expect(verdict.exit).toBe(REFUSED_DIFF_EXIT);
    expect(verdict.lines.join("\n")).toContain(".buildkite/pipeline.yml: CI configuration");
    expect(w.remoteHead()).toBe(w.sha);
  });

  it("has no fix scope: the branch's own source is the medic's to fix", () => {
    const w = world();
    w.commit(w.medic, { "src/app.ts": "export const add = (a: number, b: number): number => a + b;\nexport const sub = (a: number, b: number) => a - b;\nexport const mul = (a: number, b: number) => a * b;\n" }, signed("fix: lint"));
    expect(push(w).exit).toBe(0);
  });
});

describe("the trailer (exit 5)", () => {
  it("refuses a commit without it", () => {
    const w = world();
    const bare = w.commit(w.medic, { "src/util.ts": "export const id = <T>(value: T): T => value;\n" }, "fix: unsigned");
    const verdict = push(w);
    expect(verdict.exit).toBe(UNSIGNED_EXIT);
    expect(verdict.lines.join("\n")).toContain(bare.slice(0, 12));
    expect(w.remoteHead()).toBe(w.sha);
  });

  it("refuses one signed by another loop", () => {
    const w = world();
    w.commit(w.medic, { "src/util.ts": "export const id = <T>(value: T): T => value;\n" }, signed("fix", "other"));
    expect(push(w).exit).toBe(UNSIGNED_EXIT);
  });

  it("requires it on every new commit, not only the last", () => {
    const w = world();
    w.commit(w.medic, { "src/util.ts": "export const id = <T>(value: T): T => value;\n" }, "fix: unsigned first");
    w.commit(w.medic, { "src/util.ts": "export const id = <T>(v: T): T => v;\n" }, signed("fix: signed second"));
    expect(push(w).exit).toBe(UNSIGNED_EXIT);
  });

  it("refuses a push that only removes the operator's commits", () => {
    const w = world();
    git(w.medic, "reset", "-q", "--hard", "HEAD~1");
    const verdict = push(w);
    expect(verdict.exit).toBe(UNSIGNED_EXIT);
    expect(verdict.lines.join("\n")).toContain("only removes commits");
    expect(w.remoteHead()).toBe(w.sha);
  });
});

describe("the lease (exit 4)", () => {
  /** The operator's own next commit, pushed from their checkout. */
  const operatorPushes = (w: World): string => {
    const theirs = w.commit(w.operator, { "src/operator.ts": "export const mine = true;\n" }, "operator: keep going");
    git(w.operator, "push", "-q", "origin", BRANCH);
    return theirs;
  };

  it("refuses when the operator pushes between the re-read and the push, and their commit survives", () => {
    const w = world();
    w.commit(w.medic, { "src/util.ts": "export const id = <T>(value: T): T => value;\n" }, signed("fix"));
    let theirs = "";
    const verdict = push(w, view(w), { afterRead: () => (theirs = operatorPushes(w)) });
    expect(verdict.exit).toBe(LEASE_LOST_EXIT);
    expect(verdict.lines.join("\n")).toContain("do not retry");
    expect(w.remoteHead()).toBe(theirs);
    expect(git(w.origin, "show", `${BRANCH}:src/operator.ts`)).toBe("export const mine = true;");
  });

  it("holds even after a fetch moved the remote-tracking ref, which a bare lease would not", () => {
    const w = world();
    w.commit(w.medic, { "src/util.ts": "export const id = <T>(value: T): T => value;\n" }, signed("fix"));
    const theirs = operatorPushes(w);
    // `origin/<branch>` now IS the operator's commit: `--force-with-lease`
    // without a sha would compare against it and let the push through.
    git(w.medic, "fetch", "-q", "origin");
    expect(git(w.medic, "rev-parse", `origin/${BRANCH}`)).toBe(theirs);
    expect(push(w).exit).toBe(LEASE_LOST_EXIT);
    expect(w.remoteHead()).toBe(theirs);
  });

  it("refuses through the CLI with a gh on PATH, the operator pushing from inside that gh", () => {
    const w = world();
    w.commit(w.medic, { "src/util.ts": "export const id = <T>(value: T): T => value;\n" }, signed("fix"));
    const bin = join(dirname(w.medic), "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "pr.json"), JSON.stringify(view(w)));
    // GitHub answers with the head the medic fetched — and the operator's push
    // lands in the window after that answer, before the fence's own push.
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/bin/bash",
        `cat ${JSON.stringify(join(bin, "pr.json"))}`,
        `cd ${JSON.stringify(w.operator)}`,
        "printf 'export const mine = true;\\n' > src/operator.ts",
        "git add src/operator.ts && git commit -qm 'operator: keep going' && git push -q origin HEAD",
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "gh"), 0o755);
    const run = spawnSync(BUN, [CLI, "2197", "--expect", w.sha], {
      cwd: w.medic,
      encoding: "utf8",
      env: { ...GIT_ENV, PATH: `${bin}:${process.env.PATH ?? ""}`, RALPH_LOOP_NAME: LOOP, RALPH_PROJECT: w.medic },
    });
    expect(run.stderr).toContain("the branch moved since you fetched it");
    expect(run.status).toBe(LEASE_LOST_EXIT);
    const theirs = git(w.operator, "rev-parse", "HEAD");
    expect(w.remoteHead()).toBe(theirs);
    expect(git(w.origin, "show", `${BRANCH}:src/operator.ts`)).toBe("export const mine = true;");
  });

  it("pushes through the CLI when nobody raced it", () => {
    const w = world();
    const fix = w.commit(w.medic, { "src/util.ts": "export const id = <T>(value: T): T => value;\n" }, signed("fix"));
    const bin = join(dirname(w.medic), "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), `#!/bin/bash\nprintf '%s' ${JSON.stringify(JSON.stringify(view(w)))}\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const run = spawnSync(BUN, [CLI, "2197", "--expect", w.sha], {
      cwd: w.medic,
      encoding: "utf8",
      env: { ...GIT_ENV, PATH: `${bin}:${process.env.PATH ?? ""}`, RALPH_LOOP_NAME: LOOP, RALPH_PROJECT: w.medic },
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(w.remoteHead()).toBe(fix);
  });
});

describe("after a rebase onto a moved main", () => {
  /**
   * Main gains commits the medic would be refused for had it written them —
   * a deleted test and a pipeline edit — and the medic rebases the operator's
   * branch over them. Those are main's, so they must not count.
   */
  const mainMoves = (w: World): void => {
    git(w.operator, "checkout", "-q", "main");
    w.commit(
      w.operator,
      {
        "src/list.test.ts": OTHER_TESTS.split("\n").filter((line) => !line.includes('"counts"')).join("\n"),
        ".buildkite/pipeline.yml": "steps:\n  - command: bun run test --shard 1/2\n",
      },
      "main: retire a test, shard the pipeline",
    );
    git(w.operator, "push", "-q", "origin", "main");
    git(w.operator, "checkout", "-q", BRANCH);
    git(w.medic, "fetch", "-q", "origin");
  };

  it("passes the guard when the PR's own diff is clean, though <sha>..HEAD alone would not", () => {
    const w = world();
    mainMoves(w);
    git(w.medic, "rebase", "-q", "origin/main");
    const fix = w.commit(w.medic, { "src/util.ts": "export const id = <T>(value: T): T => value;\n" }, signed("fix: after the rebase"));
    // The naive range carries main's commits, and the guard would refuse them.
    expect(diffGuardProblems(git(w.medic, "diff", w.sha, "HEAD") + "\n")).not.toEqual([]);

    const verdict = push(w);
    expect(verdict.lines.join("\n")).toContain("pushed");
    expect(verdict.exit).toBe(0);
    expect(w.remoteHead()).toBe(fix);
    // The operator's rebased commit carried no trailer, and needed none: it is
    // their own work replayed, patch for patch.
    expect(git(w.origin, "log", "--format=%s", `main..${BRANCH}`).split("\n")).toEqual(["fix: after the rebase", "feature: mul"]);
  });

  it("refuses a pure rebase that ends on a replayed commit: the push would not count against the cap", () => {
    const w = world();
    mainMoves(w);
    git(w.medic, "rebase", "-q", "origin/main");
    const verdict = push(w);
    expect(verdict.exit).toBe(UNSIGNED_EXIT);
    expect(verdict.lines.join("\n")).toContain("new HEAD lacks");
    expect(verdict.lines.join("\n")).toContain("--allow-empty");
    expect(w.remoteHead()).toBe(w.sha);
  });

  it("lands a pure rebase marked with an empty trailered commit, which the gate's cap counts", () => {
    const w = world();
    mainMoves(w);
    git(w.medic, "rebase", "-q", "origin/main");
    const base = git(w.medic, "rev-parse", "origin/main");
    git(w.medic, "commit", "-q", "--allow-empty", "-m", signed(`Rebase onto ${base}`));
    const marked = git(w.medic, "rev-parse", "HEAD");
    expect(push(w).exit).toBe(0);
    expect(w.remoteHead()).toBe(marked);
    // The replayed operator commit still needed no trailer of its own.
    expect(git(w.origin, "log", "--format=%s", `main..${BRANCH}`).split("\n")).toEqual([`Rebase onto ${base}`, "feature: mul"]);

    // The intake gate reads the branch's commits off `gh pr list`, oldest
    // first; the same commits, read from the remote, spend one push.
    const commits = git(w.origin, "rev-list", "--reverse", `main..${BRANCH}`)
      .split("\n")
      .map((oid) => ({ oid, messageBody: git(w.origin, "show", "-s", "--format=%b", oid) }));
    expect(medicPushes({ number: 1, isDraft: false, headRefName: BRANCH, headRefOid: marked, commits })).toBe(1);
  });

  it("forgives what the operator's own diff already did, and nothing the medic adds", () => {
    const w = world();
    // The operator's pull request legitimately retires a test.
    const own = w.commit(w.operator, { "src/app.test.ts": TESTS.split("\n").filter((line) => !line.includes('"subtracts"')).join("\n") }, "operator: drop sub's test");
    git(w.operator, "push", "-q", "origin", BRANCH);
    git(w.medic, "pull", "-q", "--ff-only", "origin", BRANCH);
    const sha = own;
    mainMoves(w);
    git(w.medic, "rebase", "-q", "origin/main");
    git(w.medic, "commit", "-q", "--allow-empty", "-m", signed("Rebase onto main"));
    expect(push(w, view(w, { headRefOid: sha }), { expect: sha }).exit).toBe(0);

    // The same rebase with a `.skip` slipped in is the medic's, and refused.
    git(w.medic, "reset", "-q", "--hard", sha);
    git(w.medic, "rebase", "-q", "origin/main");
    w.commit(w.medic, { "src/app.test.ts": TESTS.split("\n").filter((line) => !line.includes('"subtracts"')).join("\n").replace('it("adds"', 'it.skip("adds"') }, signed("fix"));
    git(w.origin, "update-ref", `refs/heads/${BRANCH}`, sha);
    expect(push(w, view(w, { headRefOid: sha }), { expect: sha }).exit).toBe(REFUSED_DIFF_EXIT);
  });

  it("forgives a stale stack's test deletions the old merge-base netted out, and nothing the medic adds (loggd #2201)", () => {
    const w = world();
    // The parent PR adds two tests; this PR, stacked on it, retires them again.
    const extra = 'it("multiplies", () => { expect(2 * 3).toBe(6); });\nit("doubles", () => { expect(2 + 2).toBe(4); });\n';
    const parent = w.commit(w.operator, { "src/app.test.ts": TESTS + extra }, "parent: more tests");
    const own = w.commit(w.operator, { "src/app.test.ts": TESTS }, "operator: retire the parent's tests");
    git(w.operator, "push", "-q", "origin", BRANCH);
    git(w.medic, "pull", "-q", "--ff-only", "origin", BRANCH);
    // The parent squash-merges into main: the same content, a different commit.
    git(w.operator, "checkout", "-q", "main");
    w.commit(w.operator, { "src/app.test.ts": TESTS + extra }, "parent (#1)");
    git(w.operator, "push", "-q", "origin", "main");
    git(w.operator, "checkout", "-q", BRANCH);
    git(w.medic, "fetch", "-q", "origin");

    // Against the old merge-base the deletions net to nothing; onto the
    // squashed parent they surface whole, though the operator wrote them.
    git(w.medic, "rebase", "-q", "--onto", "origin/main", parent);
    git(w.medic, "commit", "-q", "--allow-empty", "-m", signed("Rebase onto main"));
    expect(diffGuardProblems(git(w.medic, "diff", "origin/main", "HEAD") + "\n")).not.toEqual([]);
    const verdict = push(w, view(w, { headRefOid: own }), { expect: own });
    expect(verdict.lines.join("\n")).toContain("pushed");
    expect(verdict.exit).toBe(0);

    // The same rebase with one more test deleted by the medic is refused.
    git(w.medic, "reset", "-q", "--hard", own);
    git(w.medic, "rebase", "-q", "--onto", "origin/main", parent);
    w.commit(w.medic, { "src/app.test.ts": TESTS.split("\n").filter((line) => !line.includes('"subtracts"')).join("\n") }, signed("fix"));
    git(w.origin, "update-ref", `refs/heads/${BRANCH}`, own);
    expect(push(w, view(w, { headRefOid: own }), { expect: own }).exit).toBe(REFUSED_DIFF_EXIT);
    expect(w.remoteHead()).toBe(own);
  });

  it("requires the trailer on a commit the rebase changed, which is the medic's writing", () => {
    const w = world();
    // Main touches the line the operator's commit touches, so the rebase conflicts.
    git(w.operator, "checkout", "-q", "main");
    w.commit(w.operator, { "src/app.ts": "export const add = (a: number, b: number) => a + b;\nexport const sub = (a: number, b: number) => a - b;\nexport const div = (a: number, b: number) => a / b;\n" }, "main: div");
    git(w.operator, "push", "-q", "origin", "main");
    git(w.medic, "fetch", "-q", "origin");
    spawnSync("git", ["-C", w.medic, "rebase", "origin/main"], { env: GIT_ENV, stdio: "ignore" });
    writeFileSync(
      join(w.medic, "src/app.ts"),
      "export const add = (a: number, b: number) => a + b;\nexport const sub = (a: number, b: number) => a - b;\nexport const div = (a: number, b: number) => a / b;\nexport const mul = (a: number, b: number) => a * b;\n",
    );
    git(w.medic, "add", "src/app.ts");
    execFileSync("git", ["-C", w.medic, "-c", "core.editor=true", "rebase", "--continue"], { env: GIT_ENV, stdio: "ignore" });
    expect(push(w).exit).toBe(UNSIGNED_EXIT);

    git(w.medic, "commit", "-q", "--amend", "--no-edit", "--trailer", `Pr-Medic: ${LOOP}`);
    expect(push(w).exit).toBe(0);
  });
});

describe("the pure parts", () => {
  const project: FenceProject = {
    repo: "felipearos/loggd",
    branches: ["**"],
    roster: [
      { name: "ralph", role: "coder" },
      { name: LOOP, role: "pr-medic" },
    ],
    root: "/nonexistent",
  };
  const pr: PullRequestView = {
    state: "OPEN",
    isDraft: false,
    headRefName: "ralph/612-dup-rows",
    headRefOid: "a".repeat(40),
    baseRefName: "main",
    isCrossRepository: false,
    body: "",
  };

  it("refuses a loop's branch even under a glob that would match it", () => {
    expect(ownerOf("ralph/612-dup-rows", project.roster)).toBe("ralph");
    expect(ownerOf("ralphie/1", project.roster)).toBeNull();
    expect(eligibilityProblems(pr, "a".repeat(40), project)).toEqual([
      "'ralph/612-dup-rows' is the ralph loop's branch; a medic never touches an agent's pull request",
    ]);
  });

  describe("an adoption (#425)", () => {
    const OWNER_LINE = "'ralph/612-dup-rows' is the ralph loop's branch; a medic never touches an agent's pull request";
    const unattended: Unattended = new Map([["ralph", { loop: "ralph", stopKind: "failed", downSince: "2026-10-22T00:00:00Z" }]]);
    const wip = { ...pr, labels: [{ name: `${LOOP}-wip` }] };
    const noGlob = { ...project, branches: ["felipearosr/*"] };

    it("is allowed when the owner is unattended and the PR carries <medic>-wip, whatever the glob says", () => {
      expect(eligibilityProblems(wip, "a".repeat(40), noGlob, { loop: LOOP, unattended })).toEqual([]);
      expect(eligibilityProblems(wip, "a".repeat(40), { ...project, branches: [] }, { loop: LOOP, unattended })).toEqual([]);
    });

    it("still applies every other check", () => {
      expect(eligibilityProblems({ ...wip, isDraft: true }, "b".repeat(40), noGlob, { loop: LOOP, unattended })).toEqual([
        "it is a draft; the medic waits until the operator marks it ready",
        `its head is ${"a".repeat(12)}, not the ${"b".repeat(12)} you fetched; somebody pushed — re-read it`,
      ]);
    });

    it("is refused when the owner is back", () => {
      expect(eligibilityProblems(wip, "a".repeat(40), project, { loop: LOOP, unattended: new Map() })).toEqual([
        `${OWNER_LINE} — not an adoption: the ralph loop is back`,
      ]);
    });

    it("is refused without <medic>-wip, including another medic's", () => {
      expect(eligibilityProblems(pr, "a".repeat(40), project, { loop: LOOP, unattended })).toEqual([
        `${OWNER_LINE} — not an adoption: it carries no ${LOOP}-wip`,
      ]);
      expect(eligibilityProblems({ ...pr, labels: [{ name: "doc-wip" }] }, "a".repeat(40), project, { loop: LOOP, unattended })).toEqual([
        `${OWNER_LINE} — not an adoption: it carries no ${LOOP}-wip`,
      ]);
    });

    it("is refused when the unattended loops could not be read", () => {
      expect(eligibilityProblems(wip, "a".repeat(40), project, { loop: LOOP, unattended: null })).toEqual([
        `${OWNER_LINE} — the unattended loops could not be read, so an adoption cannot be confirmed`,
      ]);
    });
  });

  it("refuses everything for a project with no prMedic.branches", () => {
    expect(eligibilityProblems({ ...pr, headRefName: "felipearosr/1" }, "a".repeat(40), { ...project, branches: [] })).toEqual([
      "the project's config has no prMedic.branches, so no branch is the medic's",
    ]);
  });

  it("subtracts findings as a multiset", () => {
    expect(newFindings(["a", "a", "b"], ["a"])).toEqual(["a", "b"]);
    expect(newFindings(["x: deletes 2 tests"], ["x: deletes 1 test"])).toEqual(["x: deletes 2 tests"]);
    expect(newFindings([], ["a"])).toEqual([]);
  });

  it("reads a lease failure from git's porcelain, and nothing else as one", () => {
    expect(leaseLost({ status: 1, stdout: `!\trefs/heads/x:refs/heads/x\t[rejected] (stale info)\n`, stderr: "" })).toBe(true);
    expect(leaseLost({ status: 1, stdout: "", stderr: "error: failed to push some refs (pre-receive hook declined)" })).toBe(false);
  });

  it("takes a PR number and a sha, and nothing looser", () => {
    expect(parseArgs(["2197", "--expect", "abc1234"])).toEqual({ pr: 2197, expect: "abc1234" });
    expect(parseArgs(["--expect", "abc1234", "2197"])).toEqual({ pr: 2197, expect: "abc1234" });
    expect(parseArgs(["2197", "--expect", "origin/main"])).toBeNull();
    expect(parseArgs(["2197"])).toBeNull();
    expect(parseArgs(["2197", "--expect", "abc1234", "--force"])).toBeNull();
  });

  it("exits 64 for an --expect this checkout does not have", () => {
    const w = world();
    expect(push(w, view(w), { expect: "deadbeefdeadbeef" }).exit).toBe(USAGE_EXIT);
  });
});
