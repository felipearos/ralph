// @vitest-environment node
/**
 * The project seam's config. Strict on purpose: the file names a secrets scope
 * and the credentials withheld from the loop, so a typo must be refused rather
 * than silently read as "withhold nothing".
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { globToRegExp } from "./executor-guard/diff-guard";
import { improverAutoMerge } from "./eval-improver";
import { DEFAULT_SUGGESTION_WEIGHTS } from "./evals-suggest";
import { APPS } from "./clerk/plan";
import { clerkAppLabels, CLERK_DEFAULTS, CODE_CONTEXT_MAIN_REF, clerkCodeContext, EVAL_SUGGESTION_WEIGHT_KEYS, CLERK_JIRA_DEFAULTS, KPI_REPORT_DEFAULTS, PR_MEDIC_DEFAULTS, SENTINEL_DEFAULTS, VERIFIER_DEFAULTS, clerkConfigWarnings, clerkJira, clerkRules, editProject, editRoster, editSentinel, editVerifier, exportLines, WORKTREE_SETUP_DEFAULT_SECONDS, WORKTREE_SETUP_MAX_SECONDS, worktreeSetupProblems, loopsProblems, parseProjectConfig, segmentGlob, sentinelRules, verifierRules, triageRules, validateProjectConfig } from "./project-config";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs project-config through bash, bun and git");

const LOGGD = {
  repo: "felipearos/loggd",
  owner: "felipearosr",
  baseBranch: "main",
  displayName: "Loggd",
  secrets: {
    runner: "doppler",
    project: "loggd-web",
    config: "dev",
    withhold: [
      "PRODUCTION_MIGRATIONS_DATABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "SELF_HOSTED_RUNNER_GH_PAT",
      "BUILDKITE_AGENT_TOKEN",
      "BUILDKITE_API_TOKEN",
      "BUILDKITE_OPERATOR_TOKEN",
      "RENOVATE_TOKEN",
    ],
  },
  refuseFiles: [".env.local"],
  envCheck: ["bun", "--no-env-file", "scripts/check-loop-env.ts"],
  requiredChecks: ["buildkite/loggd", "Vercel"],
  gates: { test: "bun run test", typecheck: "bun run typecheck", build: "bun run build" },
  promptFragment: ".ralph/prompt.md",
  coderFragment: ".ralph/coder.md",
  plan: ".ralph/plan.md",
  journal: { dir: "journal/loggd" },
  loops: ["ralph", "rafa", "remo", "rulo"],
};

/** `LOGGD` with a ci-doctor on the roster: what the `ciDoctor` block needs. */
const DOCTOR = { ...LOGGD, loops: [...LOGGD.loops, { name: "doct", role: "ci-doctor" }] };

/** `LOGGD` with a pr-medic on the roster: what the `prMedic` block needs. */
const MEDIC = { ...LOGGD, loops: [...LOGGD.loops, { name: "medi", role: "pr-medic" }] };

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("validating .ralph/config.json", () => {
  it("accepts loggd's config as written", () => {
    expect(validateProjectConfig(LOGGD)).toEqual([]);
  });

  it("accepts a project with no secrets manager", () => {
    expect(
      validateProjectConfig({ ...LOGGD, secrets: { runner: "none", withhold: [] }, envCheck: [] }),
    ).toEqual([]);
  });

  it("refuses an unknown key rather than ignoring it", () => {
    expect(validateProjectConfig({ ...LOGGD, withold: [] })).toContain("unknown key 'withold'");
    expect(
      validateProjectConfig({ ...LOGGD, secrets: { ...LOGGD.secrets, withold: ["X"] } }),
    ).toContain("unknown key 'secrets.withold'");
  });

  it("collects every problem in one pass", () => {
    const { repo: _repo, owner: _owner, ...rest } = LOGGD;
    const problems = validateProjectConfig({ ...rest, baseBranch: "" });
    expect(problems).toEqual(
      expect.arrayContaining(["missing 'repo'", "missing 'owner'", "'baseBranch' must be a branch name"]),
    );
  });

  it("requires a doppler scope, and forbids one for runner none", () => {
    expect(
      validateProjectConfig({ ...LOGGD, secrets: { runner: "doppler", withhold: [] } }),
    ).toEqual(expect.arrayContaining(["'secrets.project' must be a Doppler project name"]));
    expect(
      validateProjectConfig({ ...LOGGD, secrets: { runner: "none", project: "p", withhold: [] } }),
    ).toContain("unknown key 'secrets.project' for runner 'none'");
    expect(validateProjectConfig({ ...LOGGD, secrets: { ...LOGGD.secrets, runner: "vault" } })).toContain(
      "'secrets.runner' must be 'doppler' or 'none'",
    );
  });

  it("refuses withheld names that are not environment variable names", () => {
    expect(
      validateProjectConfig({ ...LOGGD, secrets: { ...LOGGD.secrets, withhold: ["OK_NAME", "rm -rf"] } }),
    ).toContain("'secrets.withhold[1]' must be an environment variable name");
  });

  it("keeps every path inside the project and free of whitespace", () => {
    expect(validateProjectConfig({ ...LOGGD, plan: "/etc/plan.md" })).toContain(
      "'plan' must be relative to the project root",
    );
    expect(validateProjectConfig({ ...LOGGD, refuseFiles: ["../.env"] })).toContain(
      "'refuseFiles[0]' must stay inside the project",
    );
    expect(validateProjectConfig({ ...LOGGD, journal: { dir: "journal/my project" } })).toContain(
      "'journal.dir' must not contain whitespace",
    );
  });

  it("defaults the learnings file to the journal's own name, and lets a project move or refuse it", () => {
    const parse = (extra: object) => parseProjectConfig(JSON.stringify({ ...LOGGD, ...extra }));
    // journal/loggd pairs with learnings/loggd.md, the pairing learnings/README.md documents.
    expect(parse({}).learnings).toEqual({ file: "learnings/loggd.md" });
    expect(parse({ journal: { dir: "journal/software-factory" } }).learnings).toEqual({
      file: "learnings/software-factory.md",
    });
    expect(parse({ learnings: { file: "learnings/elsewhere.md" } }).learnings).toEqual({
      file: "learnings/elsewhere.md",
    });
    expect(parse({ learnings: false }).learnings).toBe(false);
  });

  it("holds learnings.file to the harness repository, and says so in the harness's words", () => {
    expect(validateProjectConfig({ ...LOGGD, learnings: { file: "/etc/learnings.md" } })).toContain(
      "'learnings.file' must be relative to the harness repository root",
    );
    expect(validateProjectConfig({ ...LOGGD, learnings: { file: "../outside.md" } })).toContain(
      "'learnings.file' must stay inside the harness repository",
    );
    expect(validateProjectConfig({ ...LOGGD, learnings: { file: "learnings/my file.md" } })).toContain(
      "'learnings.file' must not contain whitespace or control characters",
    );
    // The publisher cleans the file's directory, so a root-level path would
    // widen that to the whole shared publishing worktree.
    expect(validateProjectConfig({ ...LOGGD, learnings: { file: "notes.md" } })).toContain(
      "'learnings.file' must be a .md file directly under learnings/",
    );
    expect(validateProjectConfig({ ...LOGGD, learnings: { file: "learnings/deep/x.md" } })).toContain(
      "'learnings.file' must be a .md file directly under learnings/",
    );
    expect(validateProjectConfig({ ...LOGGD, learnings: { file: "learnings/x.txt" } })).toContain(
      "'learnings.file' must be a .md file directly under learnings/",
    );
    expect(validateProjectConfig({ ...LOGGD, learnings: { file: "learnings/x.md", scope: "harness" } })).toContain(
      "unknown key 'learnings.scope'",
    );
    expect(validateProjectConfig({ ...LOGGD, learnings: true })).toContain(
      "'learnings' must be an object with a 'file', or false to opt out",
    );
    // false is the one scalar it takes, and the key may be left out entirely.
    expect(validateProjectConfig({ ...LOGGD, learnings: false })).toEqual([]);
    expect(validateProjectConfig(LOGGD)).toEqual([]);
  });

  it("accepts the executor guard's optional project commands, and refuses a malformed one", () => {
    expect(
      validateProjectConfig({ ...LOGGD, executorGuard: { refuse: ["bun run db:seed:e2e"], requireTargets: ["bunx knip"] } }),
    ).toEqual([]);
    expect(validateProjectConfig({ ...LOGGD, executorGuard: { refuse: [] } })).toEqual([]);
    expect(validateProjectConfig({ ...LOGGD, executorGuard: { refuse: "bun run build" } })).toContain(
      "'executorGuard.refuse' must be an array of one-line commands",
    );
    expect(validateProjectConfig({ ...LOGGD, executorGuard: { requireTargets: [""] } })).toContain(
      "'executorGuard.requireTargets' must be an array of one-line commands",
    );
    expect(validateProjectConfig({ ...LOGGD, executorGuard: { allow: [] } })).toContain(
      "unknown key 'executorGuard.allow'",
    );
  });

  it("accepts the ci-doctor's whole rule block on a roster that has one", () => {
    // The block as felipearos/ralph#158 writes it, plus the two timeout
    // ceilings #152 already shipped and `diff-guard.ts` already reads.
    expect(
      validateProjectConfig({
        ...DOCTOR,
        ciDoctor: {
          fixScope: ["**/*.test.ts", "**/*.test.tsx", "**/__tests__/**", "src/test/**"],
          neverTouch: [".buildkite/**", ".mergify.yml", ".github/**", ".ralph/**", "scripts/buildkite-*"],
          pollSeconds: 300,
          windowHours: 72,
          autoRevert: true,
          retry: { perCandidate: 1, perDay: 6 },
        },
      }),
    ).toEqual([]);
    // Every key is optional, the block included: an absent one takes the
    // harness's own default, so an empty block states nothing and is valid.
    expect(validateProjectConfig({ ...DOCTOR, ciDoctor: {} })).toEqual([]);
    expect(validateProjectConfig(DOCTOR)).toEqual([]);
    expect(validateProjectConfig({ ...DOCTOR, ciDoctor: { testTimeoutCeilingMs: 30_000, hookTimeoutCeilingMs: 120_000 } })).toEqual([]);
  });

  it("lets the doctor's retry budget be lowered and never raised", () => {
    // The point of validating the key at all. These two numbers bound what the
    // doctor spends on somebody else's CI, and a config file is exactly where a
    // well-meaning edit would raise them.
    expect(validateProjectConfig({ ...DOCTOR, ciDoctor: { retry: { perCandidate: 0, perDay: 0 } } })).toEqual([]);
    expect(validateProjectConfig({ ...DOCTOR, ciDoctor: { retry: { perCandidate: 1, perDay: 6 } } })).toEqual([]);
    expect(validateProjectConfig({ ...DOCTOR, ciDoctor: { retry: { perCandidate: 2 } } })).toContain(
      "'ciDoctor.retry.perCandidate' may be lowered but not raised; 1 is the most the doctor may spend",
    );
    expect(validateProjectConfig({ ...DOCTOR, ciDoctor: { retry: { perDay: 7 } } })).toContain(
      "'ciDoctor.retry.perDay' may be lowered but not raised; 6 is the most the doctor may spend",
    );
    expect(validateProjectConfig({ ...DOCTOR, ciDoctor: { retry: { perDay: -1 } } })).toContain(
      "'ciDoctor.retry.perDay' must be a whole number of at least 0; got -1",
    );
    expect(validateProjectConfig({ ...DOCTOR, ciDoctor: { retry: [] } })).toContain(
      "'ciDoctor.retry' must be an object with 'perCandidate' and/or 'perDay'",
    );
    expect(validateProjectConfig({ ...DOCTOR, ciDoctor: { retry: { perHour: 1 } } })).toContain("unknown key 'ciDoctor.retry.perHour'");
  });

  it("refuses a malformed value in the doctor's block, at either level", () => {
    expect(validateProjectConfig({ ...DOCTOR, ciDoctor: { fixScope: "spec/**" } })).toContain(
      "'ciDoctor.fixScope' must be a non-empty array of one-line globs",
    );
    // An empty list is not "no rules": `diff-guard.ts` reads an empty array as
    // absent and takes the default, so a project that meant to allow nothing
    // would silently get the harness's whole scope.
    expect(validateProjectConfig({ ...DOCTOR, ciDoctor: { neverTouch: [] } })).toContain(
      "'ciDoctor.neverTouch' must be a non-empty array of one-line globs",
    );
    expect(validateProjectConfig({ ...DOCTOR, ciDoctor: { pollSeconds: 0 } })).toContain(
      "'ciDoctor.pollSeconds' must be a whole number of at least 1; got 0",
    );
    expect(validateProjectConfig({ ...DOCTOR, ciDoctor: { pollSeconds: 1.5 } })).toContain(
      "'ciDoctor.pollSeconds' must be a whole number of at least 1; got 1.5",
    );
    expect(validateProjectConfig({ ...DOCTOR, ciDoctor: { windowHours: -1 } })).toContain(
      "'ciDoctor.windowHours' must be a whole number of at least 1; got -1",
    );
    expect(validateProjectConfig({ ...DOCTOR, ciDoctor: { testTimeoutCeilingMs: 0 } })).toContain(
      "'ciDoctor.testTimeoutCeilingMs' must be a whole number of at least 1; got 0",
    );
    expect(validateProjectConfig({ ...DOCTOR, ciDoctor: { autoRevert: "yes" } })).toContain(
      "'ciDoctor.autoRevert' must be true or false; got \"yes\"",
    );
    expect(validateProjectConfig({ ...DOCTOR, ciDoctor: { autoRevertt: true } })).toContain("unknown key 'ciDoctor.autoRevertt'");
    expect(validateProjectConfig({ ...DOCTOR, ciDoctor: [] })).toContain("'ciDoctor' must be an object of the ci-doctor's rules");
    expect(validateProjectConfig({ ...DOCTOR, ciDoctor: null })).toContain("'ciDoctor' must be an object of the ci-doctor's rules");
  });

  it("refuses the doctor's block on a roster with no ci-doctor in it", () => {
    // A project carrying rules no loop of its reads has stated a policy that
    // looks configured and is not — the failure mode the whole key exists to
    // avoid, since every one of these values has a silent harness default.
    expect(validateProjectConfig({ ...LOGGD, ciDoctor: { autoRevert: false } })).toContain(
      "'ciDoctor' needs a roster entry with the ci-doctor role; no loop in 'loops' has it",
    );
    expect(validateProjectConfig({ ...DOCTOR, ciDoctor: { autoRevert: false } })).toEqual([]);
    // A roster that is not an array is `loopsProblems`'s to report. Answering
    // one malformed key with two complaints, the second unactionable, is what
    // this skips.
    const problems = validateProjectConfig({ ...LOGGD, loops: 7, ciDoctor: { autoRevert: false } });
    expect(problems).toEqual(["'loops' must be an array of loop names"]);
  });

  it("accepts the medic's whole rule block on a roster that has one", () => {
    expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: ["felipearosr/*"], quietMinutes: 15, maxPushes: 3 } })).toEqual([]);
    // Every key but `branches` may be left out: those two have defaults.
    expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: ["felipearosr/*", "renovate/**"] } })).toEqual([]);
    expect(PR_MEDIC_DEFAULTS).toEqual({ quietMinutes: 15, maxPushes: 3 });
  });

  it("requires 'prMedic.branches' from a roster that has a medic, block or no block", () => {
    // The one key with no default, and the reason this check does not wait for
    // the key to be present: a rostered medic with no block at all is a loop
    // started with no answer to "whose branches may I push to".
    const missing = "'prMedic.branches' is required: a loop in 'loops' has the pr-medic role, and nothing says whose branches it may touch";
    expect(validateProjectConfig(MEDIC)).toEqual([missing]);
    expect(validateProjectConfig({ ...MEDIC, prMedic: {} })).toContain("'prMedic.branches' must be a non-empty array of one-line branch globs");
    expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: [] } })).toContain(
      "'prMedic.branches' must be a non-empty array of one-line branch globs",
    );
    expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: "felipearosr/*" } })).toContain(
      "'prMedic.branches' must be a non-empty array of one-line branch globs",
    );
    expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: ["one\ntwo"] } })).toContain(
      "'prMedic.branches' must be a non-empty array of one-line branch globs",
    );
    // A project with no medic is asked for nothing.
    expect(validateProjectConfig(LOGGD)).toEqual([]);
  });

  it("refuses a branch glob that reaches a roster loop's own branches", () => {
    // The spec's non-goal: an agent's pull request belongs to the loop that
    // opened it, and two agents force-pushing one branch is what this stops.
    expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: ["ralph/*"] } })).toEqual([
      "'prMedic.branches[0]' is 'ralph/*', which matches the 'ralph/' branches the ralph loop owns; a medic never touches an agent's own pull request",
    ]);
    // Including the medic's own name.
    expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: ["medi/**"] } })).toEqual(["'prMedic.branches[0]' is 'medi/**', which matches the 'medi/' branches the medi loop owns; a medic never touches an agent's own pull request"]);
    // A wildcard first segment and a bare or leading `**` reach EVERY loop's
    // branches, and the problem names every one of them: naming only the first
    // would have the operator narrow the glob and be refused again for the next.
    const all = "the 'ralph/', 'rafa/', 'remo/', 'rulo/', 'medi/' branches the ralph, rafa, remo, rulo, medi loops own";
    expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: ["*/*"] } })).toEqual([
      `'prMedic.branches[0]' is '*/*', which matches ${all}; a medic never touches an agent's own pull request`,
    ]);
    expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: ["**"] } })).toEqual([
      `'prMedic.branches[0]' is '**', which matches ${all}; a medic never touches an agent's own pull request`,
    ]);
    expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: ["**/fix"] } })).toEqual([
      `'prMedic.branches[0]' is '**/fix', which matches ${all}; a medic never touches an agent's own pull request`,
    ]);
    // The index is the glob's, so an operator with a long list is told which.
    expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: ["felipearosr/*", "rafa/*"] } })).toEqual([
      "'prMedic.branches[1]' is 'rafa/*', which matches the 'rafa/' branches the rafa loop owns; a medic never touches an agent's own pull request",
    ]);
    // `ralph/1*` matches `ralph/123-x` and no sample path a validator could
    // guess, which is why the check reads the glob's first segment rather than
    // probing one branch name.
    expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: ["ralph/1*"] } })).toEqual(["'prMedic.branches[0]' is 'ralph/1*', which matches the 'ralph/' branches the ralph loop owns; a medic never touches an agent's own pull request"]);
    // And a glob that merely starts like a loop name is not that loop's.
    expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: ["ralphs-fork/*", "felipearosr/**"] } })).toEqual([]);
  });

  it("refuses a branch glob outside the harness's own dialect", () => {
    // The hole this closes: `[r]alph/*` is escaped to a literal by this repo's
    // matcher, so the loop-prefix check above reads it as harmless — and under
    // fnmatch, minimatch, or anything brace-aware it matches `ralph/123-x`. A
    // pattern that means two things cannot be a blast radius, so the character
    // classes, brace lists and negations that differ are refused outright
    // rather than escaped.
    const refusal = (glob: string, meta: string): string =>
      `'prMedic.branches[0]' is '${glob}', which uses '${meta}'; a branch glob here is '*' (within one segment), '?' and '**' only, ` +
      "so a pattern other matchers would read differently is refused";
    expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: ["[r]alph/*"] } })).toEqual([refusal("[r]alph/*", "[")]);
    expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: ["{ralph,rafa}/*"] } })).toEqual([refusal("{ralph,rafa}/*", "{")]);
    expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: ["!ralph/*"] } })).toEqual([refusal("!ralph/*", "!")]);
    expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: ["(a|b)/*"] } })).toEqual([refusal("(a|b)/*", "(")]);
    expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: ["ral\\ph/*"] } })).toEqual([refusal("ral\\ph/*", "\\")]);
    expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: ["^ralph/*"] } })).toEqual([refusal("^ralph/*", "^")]);
    // The dialect check runs BEFORE the overlap check, so a refused glob is
    // reported once and as what it is, not as a branch it may or may not reach.
    expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: ["[r]alph/*"] } })).toHaveLength(1);
    // A full ref is refused too: the medic matches the branch name a pull
    // request carries, and `refs/heads/ralph/*` would otherwise sail past the
    // loop-prefix check on its first segment.
    expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: ["refs/heads/ralph/*"] } })).toEqual([
      "'prMedic.branches[0]' is 'refs/heads/ralph/*'; match the branch name a pull request carries ('felipearosr/*'), not a full ref",
    ]);
    // And the dialect the harness does use is accepted.
    expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: ["felipearosr/*", "felipearosr/**", "dependabot/?pm/*"] } })).toEqual([]);
  });

  it("refuses the medic's block on a roster with no pr-medic in it, and its stray keys", () => {
    expect(validateProjectConfig({ ...LOGGD, prMedic: { branches: ["felipearosr/*"] } })).toEqual([
      "'prMedic' needs a roster entry with the pr-medic role; no loop in 'loops' has it",
    ]);
    expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: ["felipearosr/*"], quiet: 5 } })).toContain("unknown key 'prMedic.quiet'");
    expect(validateProjectConfig({ ...MEDIC, prMedic: [] })).toContain("'prMedic' must be an object of the medic's rules");
    expect(validateProjectConfig({ ...MEDIC, prMedic: null })).toContain("'prMedic' must be an object of the medic's rules");
    // A roster that is not an array is `loopsProblems`'s to report, as with the
    // doctor's block.
    expect(validateProjectConfig({ ...LOGGD, loops: 7, prMedic: { branches: ["felipearosr/*"] } })).toEqual([
      "'loops' must be an array of loop names",
    ]);
  });

  it("holds the medic's two numbers to a whole number of at least 1", () => {
    for (const key of ["quietMinutes", "maxPushes"] as const) {
      // 0 would be a medic that acts on a branch mid-push, or one that can never
      // push at all — a mode nothing implements, which would read as configured.
      expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: ["felipearosr/*"], [key]: 0 } })).toContain(
        `'prMedic.${key}' must be a whole number of at least 1; got 0`,
      );
      expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: ["felipearosr/*"], [key]: 1.5 } })).toContain(
        `'prMedic.${key}' must be a whole number of at least 1; got 1.5`,
      );
      expect(validateProjectConfig({ ...MEDIC, prMedic: { branches: ["felipearosr/*"], [key]: "3" } })).toContain(
        `'prMedic.${key}' must be a whole number of at least 1; got "3"`,
      );
    }
  });

  it("reads one glob segment exactly as the executor's diff guard does", () => {
    // `segmentGlob` duplicates `executor-guard/diff-guard.ts`'s dialect on
    // purpose: importing it would add a fourth entry to the two scratch
    // harnesses that copy this module's import closure by hand and flatten it,
    // and `start.sh`'s failure when one is missing is a silent fallback rather
    // than an error. This is what keeps the copy honest — the push fence
    // (felipearos/ralph#247) will read a `prMedic.branches` glob with the
    // guard's matcher, and the two must agree about what a segment matches.
    //
    // Driven off the escape class ITSELF, one metacharacter at a time. A
    // hand-written table of segments is what this test used to be, and it
    // exercised two of the eleven: dropping '|' from either implementation left
    // it green.
    for (const meta of [".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\", "*", "?"]) {
      for (const segment of [`a${meta}b`, meta, `${meta}a`]) {
        for (const name of [`a${meta}b`, "aXb", "ab", "a", meta, ""]) {
          expect([segment, name, segmentGlob(segment).test(name)]).toEqual([segment, name, globToRegExp(segment).test(name)]);
        }
      }
    }
    // And the shapes a branch glob's first segment actually takes.
    for (const segment of ["felipearosr", "ralph", "*", "ralph*", "r?lph", "ralph1*", "feature-1"]) {
      for (const name of ["felipearosr", "ralph", "ralphs", "ralphs-fork", "rafa", "", "a/b"]) {
        expect([segment, name, segmentGlob(segment).test(name)]).toEqual([segment, name, globToRegExp(segment).test(name)]);
      }
    }
  });

  it("accepts a roster of loops", () => {
    expect(validateProjectConfig({ ...LOGGD, loops: ["ralph", "rafa", "remo", "rulo"] })).toEqual([]);
    expect(validateProjectConfig({ ...LOGGD, loops: ["nova"] })).toEqual([]);
  });

  it("reports every problem with a bad roster at once", () => {
    expect(validateProjectConfig({ ...LOGGD, loops: [] })).toContain("'loops' must name at least one loop");
    expect(validateProjectConfig({ ...LOGGD, loops: "ralph" })).toContain("'loops' must be an array of loop names");
    const problems = validateProjectConfig({ ...LOGGD, loops: ["ralph", "Rafa", "ralph", "re-mo", 7, "default", "", "mapper"] });
    expect(problems).toEqual([
      "'loops[1]' must be one lowercase word (a-z, then a-z or 0-9); got 'Rafa'",
      "'loops[2]' repeats 'ralph'",
      "'loops[3]' must be one lowercase word (a-z, then a-z or 0-9); got 're-mo'",
      "'loops[4]' must be one lowercase word (a-z, then a-z or 0-9); got 7",
      "'loops[5]' is 'default', which names the fallback block in models.json and jav.json",
      "'loops[6]' must be one lowercase word (a-z, then a-z or 0-9); got ''",
      "'loops[7]' is 'mapper', which names a stage in models.json",
    ]);
  });

  it("accepts a roster entry naming its role, alongside plain names", () => {
    expect(validateProjectConfig({ ...LOGGD, loops: ["ralph", { name: "tria", role: "triager" }, { name: "doc", role: "ci-doctor" }] })).toEqual([]);
    expect(validateProjectConfig({ ...LOGGD, loops: [{ name: "nova", role: "coder" }, { name: "vera" }] })).toEqual([]);
  });

  it("reads every entry as its name and role, a plain name as a coder", () => {
    const config = parseProjectConfig(JSON.stringify({ ...LOGGD, loops: ["ralph", { name: "tria", role: "triager" }, { name: "vera" }] }));
    expect(config.loops).toEqual(["ralph", "tria", "vera"]);
    expect(config.roster).toEqual([
      { name: "ralph", role: "coder" },
      { name: "tria", role: "triager" },
      { name: "vera", role: "coder" },
    ]);
    expect(parseProjectConfig(JSON.stringify(LOGGD)).roster).toEqual(LOGGD.loops.map((name) => ({ name, role: "coder" })));
  });

  it("refuses an unknown role, a stray key or a nameless entry", () => {
    expect(loopsProblems(["ralph", { name: "tria", role: "reviewer" }])).toEqual([
      "'loops[1].role' must be one of coder, triager, ci-doctor, pr-medic, clerk, verifier, sentinel; got \"reviewer\"",
    ]);
    expect(loopsProblems([{ name: "tria", role: 7 }])).toEqual(["'loops[0].role' must be one of coder, triager, ci-doctor, pr-medic, clerk, verifier, sentinel; got 7"]);
    expect(loopsProblems([{ name: "tria", role: "triager", model: "x" }])).toEqual(["unknown key 'loops[0].model'"]);
    expect(loopsProblems([{ role: "triager" }])).toEqual(["missing 'loops[0].name'"]);
  });

  it("holds an object's name to the rules a plain name keeps", () => {
    expect(loopsProblems([{ name: "Tria", role: "triager" }, { name: "default" }, { name: "review", role: "ci-doctor" }, { name: 3 }])).toEqual([
      "'loops[0].name' must be one lowercase word (a-z, then a-z or 0-9); got 'Tria'",
      "'loops[1].name' is 'default', which names the fallback block in models.json and jav.json",
      "'loops[2].name' is 'review', which names a stage in models.json",
      "'loops[3].name' must be one lowercase word (a-z, then a-z or 0-9); got 3",
    ]);
  });

  it("keeps names unique across both forms and every role", () => {
    expect(loopsProblems(["ralph", { name: "ralph", role: "triager" }])).toEqual(["'loops[1].name' repeats 'ralph'"]);
    expect(loopsProblems([{ name: "tria", role: "triager" }, "tria"])).toEqual(["'loops[1]' repeats 'tria'"]);
    expect(loopsProblems([{ name: "doc", role: "ci-doctor" }, { name: "doc", role: "triager" }])).toEqual(["'loops[1].name' repeats 'doc'"]);
  });

  it("requires the project to name its loops", () => {
    const { loops: _loops, ...unnamed } = LOGGD;
    expect(validateProjectConfig(unnamed)).toEqual(["missing 'loops'"]);
    expect(() => parseProjectConfig(JSON.stringify(unnamed))).toThrow(/missing 'loops'/);
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, loops: ["nova"] })).loops).toEqual(["nova"]);
  });

  it("names the file and every problem when parsing fails", () => {
    expect(() => parseProjectConfig("{", "cfg.json")).toThrow(/cfg\.json is not valid JSON/);
    expect(() => parseProjectConfig(JSON.stringify({ ...LOGGD, gates: { Build: "x" } }), "cfg.json")).toThrow(
      /gate name 'Build'/,
    );
  });
});

describe("the exports ralph.sh evals", () => {
  const evalIn = (lines: string[], script: string): string =>
    spawnSync("bash", ["-c", `${lines.join("\n")}\n${script}`], { encoding: "utf8" }).stdout;

  it("round-trips the withhold list, envCheck argv and check names through bash", () => {
    const lines = exportLines(parseProjectConfig(JSON.stringify(LOGGD)), "/work/loggd");
    expect(
      evalIn(
        lines,
        [
          'read -r -a w <<< "$RALPH_WITHHELD_SECRETS"; printf "withhold=%s\\n" "${#w[@]}"',
          'eval "check=($RALPH_ENV_CHECK)"; printf "arg=[%s]\\n" "${check[@]}"',
          'printf "checks=%s\\n" "$RALPH_REQUIRED_CHECKS"',
          'printf "scope=%s/%s base=%s repo=%s\\n" "$RALPH_SECRETS_PROJECT" "$RALPH_SECRETS_CONFIG" "$RALPH_BASE_BRANCH" "$RALPH_PROJECT_REPO"',
          'printf "prompt=%s gates=%s build=%s\\n" "$RALPH_PROMPT_FRAGMENT" "$RALPH_GATE_NAMES" "$RALPH_GATE_BUILD"',
        ].join("\n"),
      ),
    ).toBe(
      [
        "withhold=7",
        "arg=[bun]",
        "arg=[--no-env-file]",
        "arg=[scripts/check-loop-env.ts]",
        "checks=buildkite/loggd",
        "Vercel",
        "scope=loggd-web/dev base=main repo=felipearos/loggd",
        "prompt=/work/loggd/.ralph/prompt.md gates=test typecheck build build=bun run build",
        "",
      ].join("\n"),
    );
  });

  it("exports who merges, the loop unless the project says a person does", () => {
    const merge = (config: object) => evalIn(exportLines(parseProjectConfig(JSON.stringify(config)), "/work/loggd"), 'printf "%s" "$RALPH_MERGE"');
    expect(merge(LOGGD)).toBe("loop");
    expect(merge({ ...LOGGD, merge: "human" })).toBe("human");
    expect(() => parseProjectConfig(JSON.stringify({ ...LOGGD, merge: "never" }))).toThrow("'merge' must be 'loop' or 'human'");
  });

  it("accepts how the dashboard saves rules edits, commit or pr, and refuses anything else (#787)", () => {
    // Absent stays absent: the dashboard reads a missing key as `commit`.
    expect(parseProjectConfig(JSON.stringify(LOGGD)).configChanges).toBeUndefined();
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, configChanges: "commit" })).configChanges).toBe("commit");
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, configChanges: "pr" })).configChanges).toBe("pr");
    for (const value of ["push", true, null]) {
      expect(() => parseProjectConfig(JSON.stringify({ ...LOGGD, configChanges: value }))).toThrow("'configChanges' must be 'commit' or 'pr'");
    }
  });

  it("accepts whether eval patches may leave the host, true or false, and refuses anything else (#825)", () => {
    // Absent stays absent: the harness reads a missing key as off.
    expect(parseProjectConfig(JSON.stringify(LOGGD)).relayEvalPatches).toBeUndefined();
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, relayEvalPatches: true })).relayEvalPatches).toBe(true);
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, relayEvalPatches: false })).relayEvalPatches).toBe(false);
    for (const value of ["yes", 1, null]) {
      expect(() => parseProjectConfig(JSON.stringify({ ...LOGGD, relayEvalPatches: value }))).toThrow("'relayEvalPatches' must be true or false");
    }
  });

  it("accepts the eval suggestion ranker's weights, and refuses an unknown key or a bad value (#858)", () => {
    expect(parseProjectConfig(JSON.stringify(LOGGD)).evalSuggestionWeights).toBeUndefined();
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, evalSuggestionWeights: { blocked: 0, slowHours: 12.5 } })).evalSuggestionWeights).toEqual({ blocked: 0, slowHours: 12.5 });
    expect(() => parseProjectConfig(JSON.stringify({ ...LOGGD, evalSuggestionWeights: { louder: 1 } }))).toThrow("unknown key 'evalSuggestionWeights.louder'");
    for (const value of [-1, "3", null, true]) {
      expect(() => parseProjectConfig(JSON.stringify({ ...LOGGD, evalSuggestionWeights: { blocked: value } }))).toThrow("'evalSuggestionWeights.blocked' must be a number >= 0");
    }
    expect(() => parseProjectConfig(JSON.stringify({ ...LOGGD, evalSuggestionWeights: [1] }))).toThrow("'evalSuggestionWeights' must be an object");
  });

  it("spells the eval suggestion weight keys as the ranker does", () => {
    expect([...EVAL_SUGGESTION_WEIGHT_KEYS].sort()).toEqual(Object.keys(DEFAULT_SUGGESTION_WEIGHTS).sort());
  });

  it("accepts the noise floor's arms and stale share, and refuses anything else (#859)", () => {
    expect(parseProjectConfig(JSON.stringify(LOGGD)).evalsNoiseFloor).toBeUndefined();
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, evalsNoiseFloor: {} })).evalsNoiseFloor).toEqual({});
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, evalsNoiseFloor: { arms: 2, staleShare: 1 } })).evalsNoiseFloor).toEqual({ arms: 2, staleShare: 1 });
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, evalsNoiseFloor: { arms: 6, staleShare: 0.05 } })).evalsNoiseFloor).toEqual({ arms: 6, staleShare: 0.05 });
    for (const value of [null, 3, [], "x"]) {
      expect(() => parseProjectConfig(JSON.stringify({ ...LOGGD, evalsNoiseFloor: value }))).toThrow("'evalsNoiseFloor' must be an object");
    }
    expect(() => parseProjectConfig(JSON.stringify({ ...LOGGD, evalsNoiseFloor: { cases: 3 } }))).toThrow("unknown key 'evalsNoiseFloor.cases'");
    for (const arms of [1, 7, 2.5, "3", null]) {
      expect(() => parseProjectConfig(JSON.stringify({ ...LOGGD, evalsNoiseFloor: { arms } }))).toThrow("'evalsNoiseFloor.arms' must be an integer from 2 to 6");
    }
    for (const staleShare of [0, -0.1, 1.5, "0.2", null]) {
      expect(() => parseProjectConfig(JSON.stringify({ ...LOGGD, evalsNoiseFloor: { staleShare } }))).toThrow("'evalsNoiseFloor.staleShare' must be a number above 0 and at most 1");
    }
  });

  it("accepts the saturation window, and refuses anything else (#860)", () => {
    expect(parseProjectConfig(JSON.stringify(LOGGD)).evalsSaturation).toBeUndefined();
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, evalsSaturation: {} })).evalsSaturation).toEqual({});
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, evalsSaturation: { runs: 1 } })).evalsSaturation).toEqual({ runs: 1 });
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, evalsSaturation: { runs: 20 } })).evalsSaturation).toEqual({ runs: 20 });
    for (const value of [null, 3, [], "x"]) {
      expect(() => parseProjectConfig(JSON.stringify({ ...LOGGD, evalsSaturation: value }))).toThrow("'evalsSaturation' must be an object");
    }
    expect(() => parseProjectConfig(JSON.stringify({ ...LOGGD, evalsSaturation: { window: 3 } }))).toThrow("unknown key 'evalsSaturation.window'");
    for (const runs of [0, 21, 2.5, "3", null]) {
      expect(() => parseProjectConfig(JSON.stringify({ ...LOGGD, evalsSaturation: { runs } }))).toThrow("'evalsSaturation.runs' must be an integer from 1 to 20");
    }
  });

  it("accepts the guardrail thresholds, and refuses anything else (#871)", () => {
    expect(parseProjectConfig(JSON.stringify(LOGGD)).evalsGuardrails).toBeUndefined();
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, evalsGuardrails: {} })).evalsGuardrails).toEqual({});
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, evalsGuardrails: { maxCostRise: 0, minTokenCut: 0.5 } })).evalsGuardrails).toEqual({ maxCostRise: 0, minTokenCut: 0.5 });
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, evalsGuardrails: { maxCostRise: 0.15 } })).evalsGuardrails).toEqual({ maxCostRise: 0.15 });
    for (const value of [null, 3, [], "x"]) {
      expect(() => parseProjectConfig(JSON.stringify({ ...LOGGD, evalsGuardrails: value }))).toThrow("'evalsGuardrails' must be an object");
    }
    expect(() => parseProjectConfig(JSON.stringify({ ...LOGGD, evalsGuardrails: { costRise: 0.1 } }))).toThrow("unknown key 'evalsGuardrails.costRise'");
    for (const maxCostRise of [-0.1, 11, "0.15", null]) {
      expect(() => parseProjectConfig(JSON.stringify({ ...LOGGD, evalsGuardrails: { maxCostRise } }))).toThrow("'evalsGuardrails.maxCostRise' must be a number from 0 to 10");
    }
    for (const minTokenCut of [0, 1, -0.1, "0.1", null]) {
      expect(() => parseProjectConfig(JSON.stringify({ ...LOGGD, evalsGuardrails: { minTokenCut } }))).toThrow("'evalsGuardrails.minTokenCut' must be a number above 0 and below 1");
      }
    });

  it("accepts the improver's subset settings, and refuses anything else (#873)", () => {
    expect(parseProjectConfig(JSON.stringify(LOGGD)).evalsImprover).toBeUndefined();
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, evalsImprover: {} })).evalsImprover).toEqual({});
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, evalsImprover: { size: 1, failed: false } })).evalsImprover).toEqual({ size: 1, failed: false });
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, evalsImprover: { size: 200 } })).evalsImprover).toEqual({ size: 200 });
    for (const value of [null, 3, [], "x"]) {
      expect(() => parseProjectConfig(JSON.stringify({ ...LOGGD, evalsImprover: value }))).toThrow("'evalsImprover' must be an object");
    }
    expect(() => parseProjectConfig(JSON.stringify({ ...LOGGD, evalsImprover: { runs: 3 } }))).toThrow("unknown key 'evalsImprover.runs'");
    for (const size of [0, 201, 2.5, "3", null]) {
      expect(() => parseProjectConfig(JSON.stringify({ ...LOGGD, evalsImprover: { size } }))).toThrow("'evalsImprover.size' must be an integer from 1 to 200");
    }
    for (const failed of ["true", 1, null]) {
      expect(() => parseProjectConfig(JSON.stringify({ ...LOGGD, evalsImprover: { failed } }))).toThrow("'evalsImprover.failed' must be a boolean");
    }
  });

  it("accepts the improver's autoMerge switch, off when absent, and refuses a non-boolean (#875)", () => {
    const absent = parseProjectConfig(JSON.stringify(LOGGD));
    expect(absent.evalsImprover?.autoMerge).toBeUndefined();
    expect(improverAutoMerge(absent)).toBe(false);
    expect(improverAutoMerge(parseProjectConfig(JSON.stringify({ ...LOGGD, evalsImprover: { size: 3 } })))).toBe(false);
    const on = parseProjectConfig(JSON.stringify({ ...LOGGD, evalsImprover: { autoMerge: true } }));
    expect(on.evalsImprover).toEqual({ autoMerge: true });
    expect(improverAutoMerge(on)).toBe(true);
    for (const autoMerge of ["yes", 1, null]) {
      expect(() => parseProjectConfig(JSON.stringify({ ...LOGGD, evalsImprover: { autoMerge } }))).toThrow("'evalsImprover.autoMerge' must be a boolean");
    }
  });

  it("exports the project's id and roster for the supervisor's identity check", () => {
    const lines = exportLines(parseProjectConfig(JSON.stringify({ ...LOGGD, loops: ["nova", "vera"] })), "/work/loggd");
    expect(evalIn(lines, 'printf "%s|%s|%s" "$RALPH_PROJECT_ID" "$RALPH_PROJECT_LOOPS" "${RALPH_PROJECT_LOOPS%% *}"')).toBe(
      "loggd|nova vera|nova",
    );
    expect(evalIn(exportLines(parseProjectConfig(JSON.stringify(LOGGD)), "/w/x", "loggd-2"), 'printf "%s" "$RALPH_PROJECT_ID"')).toBe(
      "loggd-2",
    );
  });

  it("exports the same variables for a roster of names, and names only in RALPH_PROJECT_LOOPS whatever the roles", () => {
    const names = (lines: string[]) => lines.map((line) => /^export ([A-Z_]+)=/.exec(line)?.[1]);
    const strings = exportLines(parseProjectConfig(JSON.stringify(LOGGD)), "/work/loggd", "loggd");
    expect(names(strings)).toEqual([
      "RALPH_PROJECT_ID",
      "RALPH_PROJECT_LOOPS",
      "RALPH_PROJECT_REPO",
      "RALPH_PROJECT_OWNER",
      "RALPH_BASE_BRANCH",
      "RALPH_PROJECT_DISPLAY_NAME",
      "RALPH_SECRETS_RUNNER",
      "RALPH_SECRETS_PROJECT",
      "RALPH_SECRETS_CONFIG",
      "RALPH_WITHHELD_SECRETS",
      "RALPH_REFUSE_FILES",
      "RALPH_ENV_CHECK",
      "RALPH_REQUIRED_CHECKS",
      "RALPH_MERGE",
      "RALPH_PROMPT_FRAGMENT",
      "RALPH_CODER_FRAGMENT",
      "RALPH_PLAN",
      "RALPH_JOURNAL_DIR",
      "RALPH_JOURNAL_BRANCH",
      "RALPH_LEARNINGS_FILE",
      "RALPH_PROJECT_PLUGINS",
      "RALPH_TRACKER_KIND",
      "RALPH_TRACKER_KEY",
      "RALPH_GATE_TEST",
      "RALPH_GATE_TYPECHECK",
      "RALPH_GATE_BUILD",
      "RALPH_GATE_NAMES",
    ]);
    const mixed = { ...LOGGD, loops: ["ralph", { name: "tria", role: "triager" }, { name: "rafa", role: "coder" }] };
    const lines = exportLines(parseProjectConfig(JSON.stringify(mixed)), "/work/loggd", "loggd");
    expect(evalIn(lines, 'printf "%s" "$RALPH_PROJECT_LOOPS"')).toBe("ralph tria rafa");
    // Only the loops line differs from the all-strings export of the same names.
    const same = exportLines(parseProjectConfig(JSON.stringify({ ...LOGGD, loops: ["ralph", "tria", "rafa"] })), "/work/loggd", "loggd");
    expect(lines).toEqual(same);
  });

  it("exports an empty learnings file for a project that opted out", () => {
    const off = exportLines(parseProjectConfig(JSON.stringify({ ...LOGGD, learnings: false })), "/work/loggd", "loggd");
    expect(evalIn(off, 'printf "%s" "$RALPH_LEARNINGS_FILE"')).toBe("");
    const on = exportLines(parseProjectConfig(JSON.stringify(LOGGD)), "/work/loggd", "loggd");
    expect(evalIn(on, 'printf "%s" "$RALPH_LEARNINGS_FILE"')).toBe("learnings/loggd.md");
  });

  it("quotes a hostile value so eval cannot run it", () => {
    const lines = exportLines(
      parseProjectConfig(JSON.stringify({ ...LOGGD, displayName: "x'; echo pwned; '", envCheck: ["sh", "-c", "echo $(id) 'q'"] })),
      "/p",
    );
    const out = evalIn(lines, 'printf "%s\\n" "$RALPH_PROJECT_DISPLAY_NAME"; eval "c=($RALPH_ENV_CHECK)"; printf "[%s]" "${c[@]}"');
    expect(out).toBe("x'; echo pwned; '\n[sh][-c][echo $(id) 'q']");
  });

  it("the CLI reads the project named by RALPH_PROJECT and refuses a missing config", () => {
    const root = mkdtempSync(join(tmpdir(), "ralph-project-config-"));
    roots.push(root);
    const cli = join(__dirname, "project-config.ts");
    const bun = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim();

    const missing = spawnSync(bun, [cli, "--json"], { encoding: "utf8", env: { ...process.env, RALPH_PROJECT: root } });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(".ralph/config.json");

    mkdirSync(join(root, ".ralph"));
    writeFileSync(join(root, ".ralph", "config.json"), JSON.stringify(LOGGD));
    const ok = spawnSync(bun, [cli, "--json"], { encoding: "utf8", env: { ...process.env, RALPH_PROJECT: root } });
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual({ ...LOGGD, learnings: { file: "learnings/loggd.md" }, roster: LOGGD.loops.map((name) => ({ name, role: "coder" })), tracker: { kind: "github" }, merge: "loop", worktreeSetup: [] });

    writeFileSync(join(root, ".ralph", "config.json"), JSON.stringify({ ...LOGGD, loops: ["nova", "vera"] }));
    const own = spawnSync(bun, [cli, "--json"], { encoding: "utf8", env: { ...process.env, RALPH_PROJECT: root } });
    expect(JSON.parse(own.stdout).loops).toEqual(["nova", "vera"]);

    writeFileSync(join(root, ".ralph", "config.json"), JSON.stringify({ ...LOGGD, loops: [] }));
    const empty = spawnSync(bun, [cli, "--json"], { encoding: "utf8", env: { ...process.env, RALPH_PROJECT: root } });
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("'loops' must name at least one loop");
  });

  it("the CLI reports each loop with its role, and one loop's role", () => {
    const root = mkdtempSync(join(tmpdir(), "ralph-project-config-"));
    roots.push(root);
    const cli = join(__dirname, "project-config.ts");
    const bun = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim();
    const run = (...args: string[]) => spawnSync(bun, [cli, ...args], { encoding: "utf8", env: { ...process.env, RALPH_PROJECT: root } });
    mkdirSync(join(root, ".ralph"));
    writeFileSync(join(root, ".ralph", "config.json"), JSON.stringify({ ...LOGGD, loops: ["ralph", { name: "tria", role: "triager" }] }));

    const json = run("--json");
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      loops: ["ralph", "tria"],
      roster: [
        { name: "ralph", role: "coder" },
        { name: "tria", role: "triager" },
      ],
    });

    expect(run("--role-of", "tria")).toMatchObject({ status: 0, stdout: "triager\n" });
    expect(run("--role-of", "ralph")).toMatchObject({ status: 0, stdout: "coder\n" });
    const stranger = run("--role-of", "nova");
    expect(stranger.status).toBe(1);
    expect(stranger.stderr).toContain("'nova' is not one of this project's loops (ralph, tria)");
    expect(run("--role-of").status).toBe(2);
    expect(run("--role-of", "tria", "--at", "HEAD").status).toBe(2);

    // The supervisor asks for the gate rather than deriving it from the role,
    // so `roles.ts` stays the one place a role says what differs.
    expect(run("--intake-gate-of", "ralph")).toMatchObject({ status: 0, stdout: "frontier-gate.ts\n" });
    expect(run("--intake-gate-of", "tria")).toMatchObject({ status: 0, stdout: "triage/gate.ts\n" });
    expect(run("--intake-gate-of", "nope").status).toBe(1);
    expect(run("--intake-gate-of").status).toBe(2);
  });

  it("reports the gate of a role whose intake is not the frontier at all", () => {
    const root = mkdtempSync(join(tmpdir(), "ralph-project-config-"));
    roots.push(root);
    const cli = join(__dirname, "project-config.ts");
    const bun = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim();
    mkdirSync(join(root, ".ralph"));
    writeFileSync(
      join(root, ".ralph", "config.json"),
      JSON.stringify({ ...LOGGD, loops: [{ name: "doco", role: "ci-doctor" }] }),
    );
    const gate = spawnSync(bun, [cli, "--intake-gate-of", "doco"], {
      encoding: "utf8",
      env: { ...process.env, RALPH_PROJECT: root },
    });
    expect(gate).toMatchObject({ status: 0, stdout: "ci-doctor/gate.ts\n" });
  });
});

describe("the roster at a ref, and a roster edit for a PR", () => {
  const cli = join(__dirname, "project-config.ts");
  const bun = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim();
  const git = (cwd: string, ...args: string[]) =>
    spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  const run = (root: string, ...args: string[]) =>
    spawnSync(bun, [cli, ...args], { encoding: "utf8", env: { ...process.env, RALPH_PROJECT: root } });

  /** A repo whose commit `base` holds `committed`, and whose working tree holds something else. */
  function repoAt(committed: object): string {
    const root = mkdtempSync(join(tmpdir(), "ralph-project-config-ref-"));
    roots.push(root);
    git(root, "init", "--quiet", "--initial-branch=main");
    mkdirSync(join(root, ".ralph"));
    writeFileSync(join(root, ".ralph", "config.json"), `${JSON.stringify(committed, null, 2)}\n`);
    git(root, "add", ".ralph/config.json");
    git(root, "commit", "--quiet", "-m", "config");
    git(root, "tag", "base");
    writeFileSync(join(root, ".ralph", "config.json"), JSON.stringify({ ...LOGGD, loops: ["worktree"] }));
    return root;
  }

  it("--json --at reads the config committed at the ref, not the working tree", () => {
    const root = repoAt({ ...LOGGD, loops: ["ralph", "rafa"] });
    const at = run(root, "--json", "--at", "base");
    expect(at.status).toBe(0);
    expect(JSON.parse(at.stdout).loops).toEqual(["ralph", "rafa"]);
    const missing = run(root, "--json", "--at", "no-such-ref");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("no-such-ref");
  });

  it("--add-loop prints the ref's config with the loop appended, formatted as committed", () => {
    const root = repoAt({ ...LOGGD, loops: ["ralph", "rafa"] });
    const added = run(root, "--add-loop", "nova", "--at", "base");
    expect(added.status).toBe(0);
    expect(added.stdout).toBe(`${JSON.stringify({ ...LOGGD, loops: ["ralph", "rafa", "nova"] }, null, 2)}\n`);
  });

  it("--add-loop --role writes a role loop as an object, and a coder as a plain name", () => {
    const root = repoAt({ ...LOGGD, loops: ["ralph", { name: "doc", role: "ci-doctor" }] });
    const triager = run(root, "--add-loop", "tria", "--role", "triager", "--at", "base");
    expect(triager.status).toBe(0);
    expect(triager.stdout).toBe(
      `${JSON.stringify({ ...LOGGD, loops: ["ralph", { name: "doc", role: "ci-doctor" }, { name: "tria", role: "triager" }] }, null, 2)}\n`,
    );
    const plain = run(root, "--add-loop", "nova", "--at", "base");
    expect(JSON.parse(plain.stdout).loops).toEqual(["ralph", { name: "doc", role: "ci-doctor" }, "nova"]);
    const coder = run(root, "--add-loop", "nova", "--role", "coder", "--at", "base");
    expect(coder.stdout).toBe(plain.stdout);
  });

  it("--add-loop refuses an unknown role, a repeated name across forms, and --role without --add-loop", () => {
    const root = repoAt({ ...LOGGD, loops: ["ralph", { name: "doc", role: "ci-doctor" }] });
    const unknown = run(root, "--add-loop", "tria", "--role", "reviewer", "--at", "base");
    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toContain("'loops[2].role' must be one of coder, triager, ci-doctor, pr-medic, clerk, verifier, sentinel");
    const repeat = run(root, "--add-loop", "doc", "--at", "base");
    expect(repeat.status).toBe(1);
    expect(repeat.stderr).toContain("'loops[2]' repeats 'doc'");
    expect(run(root, "--remove-loop", "doc", "--role", "triager", "--at", "base").status).toBe(2);
    expect(run(root, "--json", "--role", "triager").status).toBe(2);
    expect(run(root, "--add-loop", "tria", "--role").status).toBe(2);
  });

  it("--remove-loop drops an object entry by its name and keeps the others' form", () => {
    const root = repoAt({ ...LOGGD, loops: ["ralph", { name: "tria", role: "triager" }, { name: "doc", role: "ci-doctor" }] });
    const removed = run(root, "--remove-loop", "tria", "--at", "base");
    expect(removed.status).toBe(0);
    expect(JSON.parse(removed.stdout).loops).toEqual(["ralph", { name: "doc", role: "ci-doctor" }]);
    // The roster edit writes the file's own form back, never the derived `roster`.
    expect(JSON.parse(removed.stdout)).not.toHaveProperty("roster");
  });

  it("edits a roster of plain names exactly as before roles", () => {
    const text = `${JSON.stringify(LOGGD, null, 2)}\n`;
    expect(editRoster(text, { add: "nova" })).toBe(`${JSON.stringify({ ...LOGGD, loops: [...LOGGD.loops, "nova"] }, null, 2)}\n`);
    expect(editRoster(text, { remove: "rafa" })).toBe(`${JSON.stringify({ ...LOGGD, loops: ["ralph", "remo", "rulo"] }, null, 2)}\n`);
  });

  /** `LOGGD` with a verifier rostered and a block that sets some rules, `verifier` before a later key. */
  const { journal, ...beforeJournal } = LOGGD;
  const WATCHED = {
    ...beforeJournal,
    loops: [...LOGGD.loops, { name: "sent", role: "verifier" }],
    verifier: {
      productionUrl: "https://loggd.app",
      deploy: { source: "vercel", project: "prj_loggd" },
      sentry: { org: "loggd", project: "web" },
      windowHours: 12,
      checkIns: [1, 6, 12],
      mode: "report",
    },
    journal,
  };
  const watchedText = `${JSON.stringify(WATCHED, null, 2)}\n`;

  it("edits the verifier's rules, keeping its production, deploy, Sentry and every other key in place", () => {
    const edited = editVerifier(watchedText, { windowHours: 24, follow: { loopPrs: true, humanPrs: false }, mode: "act" });
    const { windowHours: _w, checkIns: _c, mode: _m, ...kept } = WATCHED.verifier;
    expect(edited).toBe(
      `${JSON.stringify({ ...WATCHED, verifier: { ...kept, windowHours: 24, follow: { loopPrs: true, humanPrs: false }, mode: "act" } }, null, 2)}\n`,
    );
    // `verifier` stays where the file had it, ahead of `journal`.
    expect(Object.keys(JSON.parse(edited))).toEqual(Object.keys(WATCHED));
    // The omitted `checkIns` is dropped: absent means the default.
    expect(JSON.parse(edited).verifier).not.toHaveProperty("checkIns");
  });

  it("refuses a non-rule key, a non-object, an invalid rule, and a file with no verifier", () => {
    expect(() => editVerifier(watchedText, { productionUrl: "https://evil.example", mode: "act" })).toThrow("refused 'productionUrl'");
    expect(() => editVerifier(watchedText, { deploy: {}, sentry: {}, x: 1 })).toThrow("refused 'deploy', 'sentry', 'x'");
    expect(() => editVerifier(watchedText, [])).toThrow("the verifier rules must be an object");
    expect(() => editVerifier(watchedText, { follow: { loopPrs: false, humanPrs: false } })).toThrow("'verifier.follow' must follow loop PRs, human PRs or both");
    // No verifier on the roster: the input is valid, but the rules alone are not a block.
    expect(() => editVerifier(`${JSON.stringify(LOGGD, null, 2)}\n`, { mode: "act" })).toThrow("'verifier' needs a roster entry with the verifier role");
    // A rostered verifier without its block: the input itself is refused.
    const { verifier: _s, ...unblocked } = WATCHED;
    expect(() => editVerifier(JSON.stringify(unblocked), { mode: "act" })).toThrow("'verifier' is required");
  });

  it("--set-verifier prints the ref's config with the stdin rules, and refuses bad JSON or an invalid rule", () => {
    const root = repoAt(WATCHED);
    const set = (input: string, ...args: string[]) =>
      spawnSync(bun, [cli, "--set-verifier", ...args], { encoding: "utf8", input, env: { ...process.env, RALPH_PROJECT: root } });
    const rules = { trafficFloor: false, mode: "observe" };
    const edited = set(JSON.stringify(rules), "--at", "base");
    expect(edited.status).toBe(0);
    expect(edited.stdout).toBe(editVerifier(watchedText, rules));

    const garbled = set("{ not json", "--at", "base");
    expect(garbled.status).toBe(1);
    expect(garbled.stdout).toBe("");
    expect(garbled.stderr).toMatch(/^project-config: /);

    const invalid = set(JSON.stringify({ follow: { loopPrs: false, humanPrs: false } }), "--at", "base");
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("'verifier.follow' must follow loop PRs, human PRs or both");

    expect(run(root, "--set-verifier", "--role", "triager", "--at", "base").status).toBe(2);
  });

  it("switches the verifier off and on as a rule (#789), and --set-verifier carries it", () => {
    const off = editVerifier(watchedText, { enabled: false, mode: "report" });
    expect(JSON.parse(off).verifier.enabled).toBe(false);
    expect(verifierRules(parseProjectConfig(off))!.enabled).toBe(false);
    expect(verifierRules(parseProjectConfig(editVerifier(off, { mode: "report" })))!.enabled).toBe(true);
    expect(() => editVerifier(watchedText, { enabled: 0 })).toThrow("'verifier.enabled' must be true or false; got 0");

    const root = repoAt(WATCHED);
    const set = spawnSync(bun, [cli, "--set-verifier", "--at", "base"], {
      encoding: "utf8",
      input: JSON.stringify({ enabled: false }),
      env: { ...process.env, RALPH_PROJECT: root },
    });
    expect(set.status).toBe(0);
    expect(set.stdout).toBe(editVerifier(watchedText, { enabled: false }));
  });

  /** `LOGGD` with a sentinel on the roster and its block, ahead of `journal`. */
  const SENTRIED = {
    ...LOGGD,
    loops: [...LOGGD.loops, { name: "sent", role: "sentinel" }],
    sentinel: { reporter: { kind: "sentry", org: "loggd", project: "web" }, lookbackHours: 12, minEvents: 20, language: "es" },
    journal,
  };
  const sentriedText = `${JSON.stringify(SENTRIED, null, 2)}\n`;

  it("edits the sentinel's rules, keeping its reporter, language and every other key in place", () => {
    const edited = editSentinel(sentriedText, { lookbackHours: 6, maxPerDay: 3, mode: "file" });
    const { lookbackHours: _l, minEvents: _e, ...kept } = SENTRIED.sentinel;
    expect(edited).toBe(`${JSON.stringify({ ...SENTRIED, sentinel: { ...kept, lookbackHours: 6, maxPerDay: 3, mode: "file" } }, null, 2)}\n`);
    expect(Object.keys(JSON.parse(edited))).toEqual(Object.keys(SENTRIED));
    // The omitted `minEvents` is dropped: absent means the default.
    expect(JSON.parse(edited).sentinel).not.toHaveProperty("minEvents");
  });

  it("refuses a non-rule key, a non-object, an invalid rule, and a block made of rules alone", () => {
    expect(() => editSentinel(sentriedText, { reporter: { kind: "sentry", org: "evil", project: "x" } })).toThrow("refused 'reporter'");
    expect(() => editSentinel(sentriedText, { language: "en", x: 1 })).toThrow("refused 'language', 'x'");
    expect(() => editSentinel(sentriedText, [])).toThrow("the sentinel rules must be an object");
    expect(() => editSentinel(sentriedText, { maxPerDay: 0 })).toThrow("'sentinel.maxPerDay' must be a whole number of at least 1; got 0");
    expect(() => editSentinel(sentriedText, { mode: "loud" })).toThrow("'sentinel.mode' must be 'observe' or 'file'; got \"loud\"");
    // No sentinel on the roster: the input is valid, but the rules alone are not a block.
    expect(() => editSentinel(`${JSON.stringify(LOGGD, null, 2)}\n`, { mode: "file" })).toThrow("'sentinel.reporter' must be an object");
  });

  it("switches the sentinel off and on as a rule (#789): `enabled` is written, refused when not a boolean, and dropped when omitted", () => {
    const off = editSentinel(sentriedText, { enabled: false, lookbackHours: 12, minEvents: 20 });
    expect(JSON.parse(off).sentinel).toEqual({ ...SENTRIED.sentinel, enabled: false });
    expect(sentinelRules(parseProjectConfig(off))!.enabled).toBe(false);
    // The editors replace every rule key: a save that leaves `enabled` out turns it back on.
    const on = editSentinel(off, { lookbackHours: 12, minEvents: 20 });
    expect(JSON.parse(on).sentinel).not.toHaveProperty("enabled");
    expect(sentinelRules(parseProjectConfig(on))!.enabled).toBe(true);
    expect(() => editSentinel(sentriedText, { enabled: "no" })).toThrow("'sentinel.enabled' must be true or false; got \"no\"");
  });

  it("--set-sentinel prints the ref's config with the stdin rules, and refuses bad JSON or an invalid rule", () => {
    const root = repoAt(SENTRIED);
    const set = (input: string, ...args: string[]) =>
      spawnSync(bun, [cli, "--set-sentinel", ...args], { encoding: "utf8", input, env: { ...process.env, RALPH_PROJECT: root } });
    const rules = { minUsers: 3, mode: "observe" };
    const edited = set(JSON.stringify(rules), "--at", "base");
    expect(edited.status).toBe(0);
    expect(edited.stdout).toBe(editSentinel(sentriedText, rules));

    const garbled = set("{ not json", "--at", "base");
    expect(garbled.status).toBe(1);
    expect(garbled.stdout).toBe("");
    expect(garbled.stderr).toMatch(/^project-config: /);

    const invalid = set(JSON.stringify({ mode: "loud" }), "--at", "base");
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("'sentinel.mode' must be 'observe' or 'file'");

    expect(run(root, "--set-sentinel", "--role", "triager", "--at", "base").status).toBe(2);
  });

  const loggdText = `${JSON.stringify(LOGGD, null, 2)}\n`;

  it("editProject sets only the display name and base branch, keeping every other key and the file's order", () => {
    const edited = editProject(loggdText, { displayName: "Loggd Web", baseBranch: "dev" });
    const { displayName: _d, baseBranch: _b, ...rest } = JSON.parse(edited);
    const { displayName: _od, baseBranch: _ob, ...original } = LOGGD;
    expect(rest).toEqual(original);
    expect(Object.keys(JSON.parse(edited))).toEqual(Object.keys(LOGGD));
    expect(JSON.parse(edited)).toMatchObject({ displayName: "Loggd Web", baseBranch: "dev" });
    expect(edited.endsWith("}\n")).toBe(true);
  });

  it("editProject sets one key alone, leaving the other as the file has it", () => {
    expect(JSON.parse(editProject(loggdText, { displayName: "Loggd Web" }))).toEqual({ ...LOGGD, displayName: "Loggd Web" });
    expect(JSON.parse(editProject(loggdText, { baseBranch: "release/2" }))).toEqual({ ...LOGGD, baseBranch: "release/2" });
  });

  it("editProject refuses an unknown key, an empty edit, a non-object, a bad name and a bad branch", () => {
    expect(() => editProject(loggdText, { repo: "evil/repo", displayName: "x" })).toThrow("may only set displayName, baseBranch, gates, requiredChecks, refuseFiles, worktreeSetup; refused 'repo'");
    expect(() => editProject(loggdText, {})).toThrow("the project values must set");
    expect(() => editProject(loggdText, [])).toThrow("the project values must be an object");
    for (const displayName of ["", "  ", "two\nlines", 7]) {
      expect(() => editProject(loggdText, { displayName })).toThrow("'displayName' must be a non-empty single-line string");
    }
    for (const baseBranch of ["-x", "a b", ""]) {
      expect(() => editProject(loggdText, { baseBranch })).toThrow("'baseBranch' must be a branch name");
    }
  });

  it("editProject replaces the gates, required checks and refused files whole, changing only those keys", () => {
    const values = { gates: { test: "bun run test", "e2e-smoke": "bun run e2e" }, requiredChecks: ["ci/test"], refuseFiles: [".env", "apps/web/.env.local"] };
    const edited = JSON.parse(editProject(loggdText, values));
    expect(edited).toEqual({ ...LOGGD, ...values });
    expect(Object.keys(edited)).toEqual(Object.keys(LOGGD));
    expect(JSON.parse(editProject(loggdText, { requiredChecks: [] }))).toEqual({ ...LOGGD, requiredChecks: [] });
  });

  it("editProject refuses a gate whose export is one of the harness's own settings", () => {
    expect(() => editProject(loggdText, { gates: { "retry-max": "bun run x" } })).toThrow(
      "gate name 'retry-max' is reserved: the harness exports its own RALPH_GATE_RETRY_MAX",
    );
    expect(() => editProject(loggdText, { gates: { names: "x" } })).toThrow("gate name 'names' is reserved");
  });

  it("editProject refuses bad gate values with every problem at once", () => {
    let message = "";
    try {
      editProject(loggdText, { gates: { Test: "x", lint: "a\nb" }, requiredChecks: [""], refuseFiles: ["../up"] });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("gate name 'Test' must be lowercase kebab-case");
    expect(message).toContain("'gates.lint' must be a one-line command");
    expect(message).toContain("'requiredChecks' must be an array of check names");
    expect(message).toContain("'refuseFiles[0]' must stay inside the project");
  });

  it("--set-project prints the ref's config with the stdin values, and refuses a bad edit", () => {
    const root = repoAt(LOGGD);
    const set = (input: string, ...args: string[]) =>
      spawnSync(bun, [cli, "--set-project", ...args], { encoding: "utf8", input, env: { ...process.env, RALPH_PROJECT: root } });
    const values = { displayName: "Loggd Web", baseBranch: "dev" };
    const edited = set(JSON.stringify(values), "--at", "base");
    expect(edited.status).toBe(0);
    expect(edited.stdout).toBe(editProject(loggdText, values));

    const refused = set(JSON.stringify({ owner: "someone" }), "--at", "base");
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("project-config: the project values may only set displayName, baseBranch, gates, requiredChecks, refuseFiles, worktreeSetup; refused 'owner'");

    const garbled = set("{ not json", "--at", "base");
    expect(garbled.status).toBe(1);
    expect(garbled.stdout).toBe("");
    expect(garbled.stderr).toMatch(/^project-config: /);

    expect(run(root, "--set-project", "--role", "triager", "--at", "base").status).toBe(2);
  });

  it("--add-loop refuses a ref whose config names no loops", () => {
    const { loops: _loops, ...unnamed } = LOGGD;
    const root = repoAt(unnamed);
    const added = run(root, "--add-loop", "nova", "--at", "base");
    expect(added.status).toBe(1);
    expect(added.stderr).toContain("missing 'loops'");
  });

  it("--add-loop refuses a name the roster rules refuse, with every problem", () => {
    const root = repoAt({ ...LOGGD, loops: ["ralph", "rafa"] });
    for (const [name, problem] of [
      ["rafa", "repeats 'rafa'"],
      ["Nova", "must be one lowercase word"],
      ["default", "'default'"],
      ["executor", "names a stage"],
    ] as const) {
      const refused = run(root, "--add-loop", name, "--at", "base");
      expect(refused.status).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain(problem);
    }
  });

  it("--remove-loop drops the loop, and refuses one not in the roster or the last one", () => {
    const root = repoAt({ ...LOGGD, loops: ["ralph", "rafa"] });
    const removed = run(root, "--remove-loop", "rafa", "--at", "base");
    expect(removed.status).toBe(0);
    expect(JSON.parse(removed.stdout).loops).toEqual(["ralph"]);

    const absent = run(root, "--remove-loop", "nova", "--at", "base");
    expect(absent.status).toBe(1);
    expect(absent.stderr).toContain("'nova' is not one of this project's loops");

    const last = repoAt({ ...LOGGD, loops: ["ralph"] });
    const emptied = run(last, "--remove-loop", "ralph", "--at", "base");
    expect(emptied.status).toBe(1);
    expect(emptied.stderr).toContain("'loops' must name at least one loop");
  });
});

describe("a clerk's block", () => {
  /** The clerk fixture's config: an intake project with one clerk and nothing else. */
  const INTAKE = JSON.parse(readFileSync(join(__dirname, "fixtures", "clerk", ".ralph", "config.json"), "utf8")) as Record<string, unknown> & {
    clerk: Record<string, unknown>;
  };
  const withClerk = (clerk: unknown): Record<string, unknown> => ({ ...INTAKE, clerk });

  it("accepts the fixture's block, empty gates and required checks included", () => {
    // The spec's intake project holds only `.ralph/`: no gate to run, no check
    // to wait on. Both empties are what it commits.
    expect(validateProjectConfig(INTAKE)).toEqual([]);
    expect(INTAKE.gates).toEqual({});
    expect(INTAKE.requiredChecks).toEqual([]);
  });

  it("accepts every key, and fills each one the file leaves out with the spec's default", () => {
    const full = {
      mode: "live",
      pwaAgents: true,
      channel: "C0TEAMCHAN1",
      canvas: "F0CHANCANV1",
      shadowCanvas: "F0SHADOWCV1",
      operator: "U0OPERATOR1",
      dashboardUrl: "https://ralph-intake.example.test/p/acme-intake/intake",
      ignoreUsers: ["U0TEAMMEM01", "W0GRIDMEM01"],
      prRepos: ["example-org/acme-pwa"],
      jira: { site: "example.atlassian.net", project: "OA", intakeProject: "OAI" },
      settleMinutes: 15,
      joinMinutes: 2,
      canvasMinutes: 30,
      batchSize: 10,
      regressionDays: 14,
      rowCap: 32,
      attachmentMaxMb: 250,
    };
    expect(validateProjectConfig(withClerk(full))).toEqual([]);
    expect(clerkRules(parseProjectConfig(JSON.stringify(withClerk(full))))).toEqual({
      ...full,
      // Live moves to OA unless told to hold: false by default.
      holdOaMove: false,
      jira: { ...full.jira, storyPointsField: null, statuses: { ...CLERK_JIRA_DEFAULTS.statuses }, mergedStatus: null, parent: null, readyStatuses: [] },
      codeContext: null,
      appLabels: { backoffice: "acme-backoffice", pwa: "acme-pwa" },
      title: "Acme intake",
    });

    expect(CLERK_DEFAULTS).toEqual({
      mode: "shadow",
      settleMinutes: 10,
      joinMinutes: 3,
      canvasMinutes: 15,
      batchSize: 20,
      regressionDays: 30,
      rowCap: 32,
      attachmentMaxMb: 100,
    });
    const minimal = { channel: "C0TESTCHAN1", jira: { site: "example.atlassian.net", project: "OA" } };
    expect(clerkRules(parseProjectConfig(JSON.stringify(withClerk(minimal))))).toEqual({
      ...CLERK_DEFAULTS,
      holdOaMove: false,
      channel: "C0TESTCHAN1",
      canvas: null,
      shadowCanvas: null,
      operator: null,
      dashboardUrl: null,
      ignoreUsers: [],
      // Absent: the gate reads no app repos.
      prRepos: null,
      // No agent project works the pwa repo unless the file says one does.
      pwaAgents: false,
      jira: { site: "example.atlassian.net", project: "OA", intakeProject: null, storyPointsField: null, statuses: { ...CLERK_JIRA_DEFAULTS.statuses }, mergedStatus: null, parent: null, readyStatuses: [] },
      // Code context is opt-in (#499): off unless the file names a repo.
      codeContext: null,
      appLabels: { backoffice: "acme-backoffice", pwa: "acme-pwa" },
      title: "Acme intake",
    });
    // A project with no clerk has no rules at all, rather than an empty set.
    expect(clerkRules(parseProjectConfig(JSON.stringify(LOGGD)))).toBeNull();
  });

  it("reads the intake board's keys, filling the statuses the file leaves out (#443)", () => {
    expect(CLERK_JIRA_DEFAULTS).toEqual({ statuses: { pending: "Por confirmar", confirmed: "Confirmado", rejected: "Descartado", moved: "Movido" } });
    const jira = {
      site: "example.atlassian.net",
      project: "OA",
      intakeProject: "OAI",
      storyPointsField: "customfield_10016",
      statuses: { confirmed: "Aprobado" },
    };
    expect(validateProjectConfig(withClerk({ ...INTAKE.clerk, jira }))).toEqual([]);
    expect(clerkRules(parseProjectConfig(JSON.stringify(withClerk({ ...INTAKE.clerk, jira }))))?.jira).toEqual({
      ...jira,
      statuses: { pending: "Por confirmar", confirmed: "Aprobado", rejected: "Descartado", moved: "Movido" },
      mergedStatus: null,
      parent: null,
      readyStatuses: [],
    });
    // The fixture names the board and leaves the points field unset, so the
    // description fallback is what its tests exercise.
    expect(clerkRules(parseProjectConfig(JSON.stringify(INTAKE)))?.jira).toEqual({
      site: "example.atlassian.net",
      project: "OA",
      intakeProject: "OAI",
      storyPointsField: null,
      statuses: { ...CLERK_JIRA_DEFAULTS.statuses },
      mergedStatus: null,
      parent: null,
      readyStatuses: [],
    });
  });

  it("reads a shadow config without an intake board, every other rule as it was", () => {
    const jira = { site: "example.atlassian.net", project: "OA" };
    const rules = clerkRules(parseProjectConfig(JSON.stringify(withClerk({ ...INTAKE.clerk, jira }))));
    expect(rules?.jira.intakeProject).toBeNull();
    expect(rules?.jira.storyPointsField).toBeNull();
    const withBoard = clerkRules(parseProjectConfig(JSON.stringify(INTAKE)));
    expect({ ...rules, jira: null }).toEqual({ ...withBoard, jira: null });
  });

  it("fills a hand-spelled Jira the way the config would", () => {
    expect(clerkJira({ site: "example.atlassian.net", project: "OA" })).toEqual({
      site: "example.atlassian.net",
      project: "OA",
      intakeProject: null,
      storyPointsField: null,
      statuses: { ...CLERK_JIRA_DEFAULTS.statuses },
      mergedStatus: null,
      parent: null,
      readyStatuses: [],
    });
  });

  it("refuses a bad intake board key with what to write instead", () => {
    const problems = (extra: Record<string, unknown>): string[] =>
      validateProjectConfig(withClerk({ ...INTAKE.clerk, jira: { site: "example.atlassian.net", project: "OA", ...extra } }));
    expect(problems({ intakeProject: "oai" })).toEqual(["'clerk.jira.intakeProject' must be a Jira project key in capitals such as 'OAI'; got \"oai\""]);
    expect(problems({ intakeProject: "OA" })).toEqual([
      "'clerk.jira.intakeProject' must not be 'clerk.jira.project' (\"OA\"): confirmed tickets for a person move from the intake board to the person board",
    ]);
    expect(problems({ storyPointsField: "points" })).toEqual([
      "'clerk.jira.storyPointsField' must be a Jira custom field id such as 'customfield_10016' (Jira's field list names it); got \"points\"",
    ]);
    expect(problems({ storyPointsField: 10016 })).toHaveLength(1);
    expect(problems({ statuses: "Por confirmar" })).toEqual([
      "'clerk.jira.statuses' must be an object of pending, confirmed, rejected, moved to workflow status names; got \"Por confirmar\"",
    ]);
    expect(problems({ statuses: { done: "Hecho" } })).toEqual(["unknown key 'clerk.jira.statuses.done'"]);
    for (const name of ["", "  ", "Por\nconfirmar", 3]) {
      expect(problems({ statuses: { pending: name } })).toEqual([
        `'clerk.jira.statuses.pending' must be a workflow status name on one line, as the intake board spells it; got ${JSON.stringify(name)}`,
      ]);
    }
    expect(problems({ statuses: { rejected: "Confirmado" } })).toEqual([
      "'clerk.jira.statuses.rejected' must differ from 'clerk.jira.statuses.confirmed' (\"Confirmado\"): each status means one step of the confirmation",
    ]);
    expect(problems({ intakeProject: "OAI", storyPointsField: "customfield_10016", statuses: { moved: "Hecho" } })).toEqual([]);
  });

  it("reads the merged status, opt-in and apart from the confirmation's", () => {
    const problems = (jira: Record<string, unknown>): string[] =>
      validateProjectConfig(withClerk({ ...INTAKE.clerk, jira: { site: "example.atlassian.net", project: "OA", intakeProject: "OAI", ...jira } }));
    expect(problems({ mergedStatus: "Mergeado" })).toEqual([]);
    expect(clerkRules(parseProjectConfig(JSON.stringify(withClerk({ ...INTAKE.clerk, jira: { site: "example.atlassian.net", project: "OA", intakeProject: "OAI", mergedStatus: "Mergeado" } }))))?.jira.mergedStatus).toBe("Mergeado");
    expect(clerkRules(parseProjectConfig(JSON.stringify(INTAKE)))?.jira.mergedStatus).toBeNull();
    expect(problems({ mergedStatus: "" })).toEqual(["'clerk.jira.mergedStatus' must be a workflow status name on one line, as the intake board spells it; got \"\""]);
    expect(problems({ mergedStatus: "Movido" })).toEqual([
      "'clerk.jira.mergedStatus' must differ from 'clerk.jira.statuses.moved' (\"Movido\"): a merge is not a step of the confirmation",
    ]);
    expect(problems({ statuses: { moved: "Hecho" }, mergedStatus: "Movido" })).toEqual([]);
  });

  it("reads the parent moved tickets are filed under, a ticket on the person board", () => {
    const problems = (jira: Record<string, unknown>): string[] =>
      validateProjectConfig(withClerk({ ...INTAKE.clerk, jira: { site: "example.atlassian.net", project: "OA", intakeProject: "OAI", ...jira } }));
    expect(problems({ parent: "OA-471" })).toEqual([]);
    expect(clerkRules(parseProjectConfig(JSON.stringify(withClerk({ ...INTAKE.clerk, jira: { site: "example.atlassian.net", project: "OA", intakeProject: "OAI", parent: "OA-471" } }))))?.jira.parent).toBe("OA-471");
    expect(clerkRules(parseProjectConfig(JSON.stringify(INTAKE)))?.jira.parent).toBeNull();
    for (const parent of ["oa-471", "OA", "https://example.atlassian.net/browse/OA-471", 471]) {
      expect(problems({ parent })).toEqual([`'clerk.jira.parent' must be a Jira issue key such as 'OA-471'; got ${JSON.stringify(parent)}`]);
    }
    expect(problems({ parent: "OAI-3" })).toEqual(["'clerk.jira.parent' must be a ticket on 'clerk.jira.project' (\"OA\"), where moved tickets are filed; got \"OAI-3\""]);
  });

  it("reads the team board's ready statuses, which tell a moved report before Done", () => {
    const problems = (jira: Record<string, unknown>): string[] =>
      validateProjectConfig(withClerk({ ...INTAKE.clerk, jira: { site: "example.atlassian.net", project: "OA", intakeProject: "OAI", ...jira } }));
    expect(problems({ readyStatuses: ["LISTO PARA QA", "QA"] })).toEqual([]);
    expect(clerkRules(parseProjectConfig(JSON.stringify(withClerk({ ...INTAKE.clerk, jira: { site: "example.atlassian.net", project: "OA", readyStatuses: ["LISTO PARA QA"] } }))))?.jira.readyStatuses).toEqual(["LISTO PARA QA"]);
    expect(clerkRules(parseProjectConfig(JSON.stringify(INTAKE)))?.jira.readyStatuses).toEqual([]);
    for (const readyStatuses of ["LISTO PARA QA", [""], ["LISTO\nPARA QA"], [3]]) {
      expect(problems({ readyStatuses })).toEqual([
        `'clerk.jira.readyStatuses' must be a list of workflow status names on one line, as the team board spells them; got ${JSON.stringify(readyStatuses)}`,
      ]);
    }
  });

  it("reads the KPI report block, filling its defaults (#453)", () => {
    expect(KPI_REPORT_DEFAULTS).toEqual({ mode: "draft", recipients: [], channels: [], time: "09:00", timezone: "America/Santiago", weekdays: true, quietDays: 7, exclude: [] });
    const clerk = { ...INTAKE.clerk, operator: "U0OPERATOR1", kpiReport: { recipients: ["U0LEADER01"], quietDays: 5 } };
    expect(validateProjectConfig(withClerk(clerk))).toEqual([]);
    expect(clerkRules(parseProjectConfig(JSON.stringify(withClerk(clerk))))?.kpiReport).toEqual({ ...KPI_REPORT_DEFAULTS, recipients: ["U0LEADER01"], quietDays: 5 });
    // No block, no report: nothing is sent.
    const { kpiReport: _none, ...noReport } = clerk;
    expect(clerkRules(parseProjectConfig(JSON.stringify(withClerk(noReport))))?.kpiReport).toBeUndefined();
  });

  it("refuses a bad KPI report block with what to write instead (#453)", () => {
    const { operator: _operator, ...noOperator } = INTAKE.clerk as Record<string, unknown>;
    const problems = (kpiReport: unknown, operator: unknown = "U0OPERATOR1"): string[] =>
      validateProjectConfig(withClerk({ ...noOperator, ...(operator === null ? {} : { operator }), kpiReport }));
    expect(problems({ recipients: ["D0LEADER01"] })).toEqual([
      "'clerk.kpiReport.recipients[0]' is a DM channel id (\"D0LEADER01\"), which the bot cannot post to; give the person's member id ('U…', from their Slack profile, Copy member ID) instead",
    ]);
    expect(problems({ recipients: ["marta"] })).toEqual(["'clerk.kpiReport.recipients[0]' must be a Slack user id ('U…' or 'W…'); got \"marta\""]);
    expect(problems({ recipients: "U0LEADER01" })).toHaveLength(1);
    expect(problems({ team: ["U0LEADER01"] })).toEqual([
      "unknown key 'clerk.kpiReport.team': the team is the intake channel's members, read from Slack; remove it",
    ]);
    expect(problems({ mode: "live" })).toEqual(["'clerk.kpiReport.mode' must be 'draft' or 'send'; got \"live\""]);
    expect(problems({ mode: "send" })).toEqual(["'clerk.kpiReport.recipients' must name at least one Slack user id when 'clerk.kpiReport.mode' is 'send'"]);
    // Channels: public or private ids; a DM id is refused as it is for recipients.
    expect(problems({ channels: ["C0KPICHAN01", "G0PRIVATE01"] })).toEqual([]);
    expect(problems({ mode: "send", channels: ["C0KPICHAN01"] })).toEqual([]);
    expect(problems({ channels: ["D0LEADER01"] })).toEqual([
      "'clerk.kpiReport.channels[0]' is a DM channel id (\"D0LEADER01\"), which the bot cannot post to; give a channel's id ('C…' or 'G…', from the channel's details) instead",
    ]);
    expect(problems({ channels: ["#intake"] })).toEqual(["'clerk.kpiReport.channels[0]' must be a Slack channel id ('C…' or 'G…'); got \"#intake\""]);
    expect(problems({ channels: ["U0LEADER01"] })).toHaveLength(1);
    expect(problems({ channels: "C0KPICHAN01" })).toEqual(["'clerk.kpiReport.channels' must be a list of Slack channel ids ('C…' or 'G…'); got \"C0KPICHAN01\""]);
    expect(clerkRules(parseProjectConfig(JSON.stringify(withClerk({ ...noOperator, kpiReport: { channels: ["C0KPICHAN01"] } }))))?.kpiReport?.channels).toEqual(["C0KPICHAN01"]);
    // No operator is the report off, a warning: never a problem that stops the clerk at startup.
    expect(problems({}, null)).toEqual([]);
    const config = (clerk: Record<string, unknown>) => parseProjectConfig(JSON.stringify(withClerk(clerk)));
    expect(clerkConfigWarnings(config({ ...noOperator, kpiReport: {} }))).toEqual([expect.stringContaining("the daily KPI report is off")]);
    expect(clerkConfigWarnings(config({ ...noOperator, kpiReport: { mode: "send", recipients: ["U0LEADER01"] } }))).toHaveLength(1);
    expect(clerkConfigWarnings(config({ ...noOperator, operator: "U0OPERATOR1", kpiReport: {} }))).toEqual([]);
    expect(clerkConfigWarnings(config({ ...noOperator, kpiReport: undefined }))).toEqual([]);
    expect(problems({ mode: "send", recipients: ["U0LEADER01"] }, null)).toEqual([]);
    expect(problems({ time: "9:00" })).toEqual(["'clerk.kpiReport.time' must be a local time as HH:MM, such as '09:00'; got \"9:00\""]);
    expect(problems({ time: "24:00" })).toHaveLength(1);
    expect(problems({ timezone: "Mars/Olympus" })).toEqual(["'clerk.kpiReport.timezone' must be an IANA time zone such as 'America/Santiago'; got \"Mars/Olympus\""]);
    expect(problems({ weekdays: "yes" })).toHaveLength(1);
    expect(problems({ exclude: ["U0LEADER01"] })).toEqual([]);
    expect(problems({ exclude: ["Monfallet"] })).toEqual([
      "'clerk.kpiReport.exclude[0]' must be a Slack user id ('U…' or 'W…', from their Slack profile, Copy member ID); got \"Monfallet\"",
    ]);
    expect(problems({ exclude: "U0LEADER01" })).toHaveLength(1);
    expect(problems({ quietDays: 0 })).toEqual(["'clerk.kpiReport.quietDays' must be a whole number of at least 1; got 0"]);
    expect(problems("draft")).toHaveLength(1);
  });

  it("labels each app's tickets with the project's app labels, spelling the apps the way the clerk's plan does", () => {
    const labels = clerkAppLabels({ backoffice: "acme-backoffice", pwa: "acme-pwa" });
    expect(labels).toEqual({
      Backoffice: ["acme-backoffice"],
      pwa: ["acme-pwa"],
      both: ["acme-backoffice", "acme-pwa"],
      none: ["acme-backoffice"],
    });
    expect(Object.keys(labels)).toEqual([...APPS]);
    expect(clerkRules(parseProjectConfig(JSON.stringify(INTAKE)))?.appLabels).toEqual({ backoffice: "acme-backoffice", pwa: "acme-pwa" });
  });

  it("requires the app labels beside a clerk, as two different label names, because the harness spells no team's", () => {
    const { appLabels: _labels, ...bare } = INTAKE;
    expect(validateProjectConfig(bare)).toEqual([
      "'appLabels' is required with 'clerk': the clerk files each ticket under its app's label ({ \"backoffice\": …, \"pwa\": … })",
    ]);
    const withLabels = (appLabels: unknown) => validateProjectConfig({ ...INTAKE, appLabels });
    expect(withLabels("acme")).toEqual(["'appLabels' must be an object with 'backoffice' and 'pwa' label names"]);
    expect(withLabels({ backoffice: "acme-backoffice" })).toEqual(["'appLabels.pwa' must be a label name"]);
    expect(withLabels({ backoffice: "same", pwa: "same" })).toEqual(["'appLabels.backoffice' and 'appLabels.pwa' must be different labels"]);
    expect(withLabels({ backoffice: "a", pwa: "b", web: "c" })).toEqual(["unknown key 'appLabels.web'"]);
  });

  it("defaults to shadow, so going live is a reviewed edit and never an omission", () => {
    const { mode: _mode, ...noMode } = INTAKE.clerk;
    expect(clerkRules(parseProjectConfig(JSON.stringify(withClerk(noMode))))?.mode).toBe("shadow");
  });

  it("refuses unknown keys, at the top of the block and inside 'jira'", () => {
    expect(validateProjectConfig(withClerk({ ...INTAKE.clerk, channels: ["C0TESTCHAN1"] }))).toEqual(["unknown key 'clerk.channels'"]);
    expect(validateProjectConfig(withClerk({ ...INTAKE.clerk, jira: { site: "example.atlassian.net", project: "OA", token: "x" } }))).toEqual([
      "unknown key 'clerk.jira.token'",
    ]);
  });

  it("accepts quiet mode, and 'holdOaMove' in live or quiet: held by default in quiet, moved by default in live (#443)", () => {
    expect(validateProjectConfig(withClerk({ ...INTAKE.clerk, mode: "quiet" }))).toEqual([]);
    const rulesOf = (clerk: unknown) => clerkRules(parseProjectConfig(JSON.stringify(withClerk(clerk))));
    expect(rulesOf({ ...INTAKE.clerk, mode: "quiet" })).toMatchObject({ mode: "quiet", holdOaMove: true });
    expect(rulesOf({ ...INTAKE.clerk, mode: "live" })).toMatchObject({ mode: "live", holdOaMove: false });
    for (const mode of ["quiet", "live"]) {
      for (const holdOaMove of [true, false]) {
        expect(validateProjectConfig(withClerk({ ...INTAKE.clerk, mode, holdOaMove }))).toEqual([]);
        expect(rulesOf({ ...INTAKE.clerk, mode, holdOaMove })?.holdOaMove, `${mode} ${holdOaMove}`).toBe(holdOaMove);
      }
    }
    expect(validateProjectConfig(withClerk({ ...INTAKE.clerk, mode: "live", holdOaMove: "yes" }))).toEqual([
      `'clerk.holdOaMove' must be true or false; got "yes"`,
    ]);
    // Shadow moves nothing, whatever the key says.
    const notShadow = "'clerk.holdOaMove' is only read in live or quiet mode, and shadow never moves a ticket; remove it, or set 'clerk.mode'";
    expect(validateProjectConfig(withClerk({ ...INTAKE.clerk, mode: "shadow", holdOaMove: true }))).toEqual([notShadow]);
    const { mode: _mode, ...noMode } = INTAKE.clerk;
    expect(validateProjectConfig(withClerk({ ...noMode, holdOaMove: false }))).toEqual([notShadow]);
  });

  it("refuses an unknown mode", () => {
    for (const mode of ["dry-run", "LIVE", "QUIET", "", true, null]) {
      expect(validateProjectConfig(withClerk({ ...INTAKE.clerk, mode }))).toEqual([
        `'clerk.mode' must be 'shadow', 'quiet' or 'live'; got ${JSON.stringify(mode)}`,
      ]);
    }
  });

  it("refuses bad types for every key", () => {
    const problems = (clerk: unknown): string[] => validateProjectConfig(withClerk(clerk));
    // Whether an agent project works the pwa repo: a boolean, false by default.
    expect(problems({ ...INTAKE.clerk, pwaAgents: "yes" })).toEqual([`'clerk.pwaAgents' must be true or false; got "yes"`]);
    for (const pwaAgents of [true, false]) expect(problems({ ...INTAKE.clerk, pwaAgents })).toEqual([]);
    const rulesOf = (clerk: unknown) => clerkRules(parseProjectConfig(JSON.stringify(withClerk(clerk))));
    expect(rulesOf(INTAKE.clerk)?.pwaAgents).toBe(false);
    expect(rulesOf({ ...INTAKE.clerk, pwaAgents: true })?.pwaAgents).toBe(true);
    expect(problems({ ...INTAKE.clerk, channel: "general" })).toEqual([
      "'clerk.channel' must be a Slack channel id ('C…' or 'G…'); got \"general\"",
    ]);
    expect(problems({ ...INTAKE.clerk, shadowCanvas: 12 })).toEqual(["'clerk.shadowCanvas' must be a Slack canvas id ('F…'); got 12"]);
    expect(problems({ ...INTAKE.clerk, canvas: "C0TESTCHAN1" })).toEqual(["'clerk.canvas' must be a Slack canvas id ('F…'); got \"C0TESTCHAN1\""]);
    expect(problems({ ...INTAKE.clerk, operator: "felipe" })).toEqual(["'clerk.operator' must be a Slack user id ('U…' or 'W…'); got \"felipe\""]);
    // The canvas links the intake page (#459): https only, one link the markdown cannot break.
    for (const dashboardUrl of ["http://ralph.example.test/p/x/intake", "ralph.example.test", "https://a b.test/", "https://x.test/p/(x)", "https://user:pw@x.test/", 7, ""]) {
      expect(problems({ ...INTAKE.clerk, dashboardUrl })).toEqual([
        `'clerk.dashboardUrl' must be an https URL such as 'https://example.vercel.app/p/project/intake'; got ${JSON.stringify(dashboardUrl)}`,
      ]);
    }
    expect(problems({ ...INTAKE.clerk, dashboardUrl: "https://ralph-intake.vercel.app/p/acme-intake/intake" })).toEqual([]);
    // The team members whose messages are never reports: member ids only.
    expect(problems({ ...INTAKE.clerk, ignoreUsers: "U0TEAMMEM01" })).toEqual(["'clerk.ignoreUsers' must be a list of Slack user ids ('U…' or 'W…'); got \"U0TEAMMEM01\""]);
    expect(problems({ ...INTAKE.clerk, ignoreUsers: ["U0TEAMMEM01", "felipe", "C0TESTCHAN1", 7] })).toEqual([
      "'clerk.ignoreUsers[1]' must be a Slack user id ('U…' or 'W…', from their Slack profile, Copy member ID); got \"felipe\"",
      "'clerk.ignoreUsers[2]' must be a Slack user id ('U…' or 'W…', from their Slack profile, Copy member ID); got \"C0TESTCHAN1\"",
      "'clerk.ignoreUsers[3]' must be a Slack user id ('U…' or 'W…', from their Slack profile, Copy member ID); got 7",
    ]);
    expect(problems({ ...INTAKE.clerk, ignoreUsers: [] })).toEqual([]);
    expect(problems({ ...INTAKE.clerk, ignoreUsers: ["U0TEAMMEM01", "W0GRIDMEM01"] })).toEqual([]);
    // The app repos the intake page reads PRs from: owner/name, or none.
    for (const prRepos of ["example-org/acme-pwa", ["acme-pwa"], ["https://github.com/a/b"], [7]]) {
      expect(problems({ ...INTAKE.clerk, prRepos })).toEqual([
        `'clerk.prRepos' must be a list of GitHub repos such as 'example-org/backoffice'; got ${JSON.stringify(prRepos)}`,
      ]);
    }
    expect(problems({ ...INTAKE.clerk, prRepos: [] })).toEqual([]);
    expect(problems({ ...INTAKE.clerk, prRepos: ["example-org/acme-backoffice", "example-org/acme-pwa"] })).toEqual([]);
    expect(problems({ ...INTAKE.clerk, jira: "OA" })).toEqual(["'clerk.jira' must be an object with 'site' and 'project'"]);
    expect(problems({ ...INTAKE.clerk, jira: { site: "https://example.atlassian.net", project: "oa" } })).toEqual([
      "'clerk.jira.site' must be a host name such as 'example.atlassian.net'; got \"https://example.atlassian.net\"",
      "'clerk.jira.project' must be a Jira project key such as 'OA'; got \"oa\"",
    ]);
    for (const key of ["settleMinutes", "joinMinutes", "canvasMinutes", "batchSize", "regressionDays", "rowCap"]) {
      expect(problems({ ...INTAKE.clerk, [key]: "10" })).toEqual([`'clerk.${key}' must be a whole number of at least 1; got "10"`]);
      expect(problems({ ...INTAKE.clerk, [key]: 0 })).toEqual([`'clerk.${key}' must be a whole number of at least 1; got 0`]);
      expect(problems({ ...INTAKE.clerk, [key]: 2.5 })).toEqual([`'clerk.${key}' must be a whole number of at least 1; got 2.5`]);
    }
  });

  it("holds the row cap under Slack's 300-cell table and the batch to one plan a person can read", () => {
    expect(validateProjectConfig(withClerk({ ...INTAKE.clerk, rowCap: 33 }))).toEqual([
      "'clerk.rowCap' may be at most 32: Slack refuses a canvas table of more than 300 cells; got 33",
    ]);
    expect(validateProjectConfig(withClerk({ ...INTAKE.clerk, batchSize: 51 }))).toEqual(["'clerk.batchSize' may be at most 50; got 51"]);
    expect(validateProjectConfig(withClerk({ ...INTAKE.clerk, attachmentMaxMb: 1025 }))).toEqual([
      "'clerk.attachmentMaxMb' may be at most 1024: the Jira site refuses an attachment over 1 GB; got 1025",
    ]);
  });

  it("refuses a join window that does not end before the settle window", () => {
    expect(validateProjectConfig(withClerk({ ...INTAKE.clerk, joinMinutes: 10 }))).toEqual([
      "'clerk.joinMinutes' (10) must be less than 'clerk.settleMinutes' (10): a report must settle after its last message can no longer join it",
    ]);
    expect(validateProjectConfig(withClerk({ ...INTAKE.clerk, settleMinutes: 3 }))).toHaveLength(1);
    expect(validateProjectConfig(withClerk({ ...INTAKE.clerk, joinMinutes: 9 }))).toEqual([]);
  });

  it("refuses a shadow canvas that is the channel's own canvas", () => {
    expect(validateProjectConfig(withClerk({ ...INTAKE.clerk, canvas: "F0SHADOWCV1" }))).toEqual([
      "'clerk.shadowCanvas' must not be 'clerk.canvas': shadow never writes the channel's canvas",
    ]);
  });

  it("requires the block, channel and Jira project included, from a roster that has a clerk", () => {
    const { clerk: _clerk, ...noBlock } = INTAKE;
    expect(validateProjectConfig(noBlock)).toEqual([
      "'clerk' is required: a loop in 'loops' has the clerk role, and nothing says which channel it reads or where it files",
    ]);
    expect(validateProjectConfig(withClerk({ mode: "shadow" }))).toEqual([
      "'clerk.channel' must be a Slack channel id ('C…' or 'G…'); got undefined",
      "'clerk.jira' must be an object with 'site' and 'project'",
    ]);
    expect(validateProjectConfig(withClerk([]))).toEqual(["'clerk' must be an object of the clerk's channel, Jira project and rules"]);
  });

  it("requires an intake board of a live clerk and not of a shadow one, and has no Linear block (#466)", () => {
    const noBoard = { ...INTAKE.clerk, jira: { site: "example.atlassian.net", project: "OA" } };
    expect(validateProjectConfig(withClerk({ ...noBoard, mode: "live" }))).toEqual([
      "'clerk.jira.intakeProject' is required when 'clerk.mode' is 'live': nothing says which Jira intake board a report is filed on",
    ]);
    expect(validateProjectConfig(withClerk({ ...noBoard, mode: "shadow" }))).toEqual([]);
    expect(validateProjectConfig(withClerk({ ...INTAKE.clerk, mode: "live" }))).toEqual([]);
    // Quiet writes the board for real, so it needs one as live does.
    expect(validateProjectConfig(withClerk({ ...noBoard, mode: "quiet" }))).toEqual([
      "'clerk.jira.intakeProject' is required when 'clerk.mode' is 'quiet': nothing says which Jira intake board a report is filed on",
    ]);
    // The Linear filing path is gone: its block is an unknown key now.
    expect(validateProjectConfig(withClerk({ ...INTAKE.clerk, linear: { team: "AND", workspace: "example" } }))).toEqual(["unknown key 'clerk.linear'"]);
  });

  it("reads 'codeContext' leniently: a malformed one is the feature off, never a problem (#499)", () => {
    const repos = {
      pwa: { path: "/srv/acme-pwa", ref: "origin/dev", mainRef: "origin/main" },
      Backoffice: { path: "/srv/acme-backoffice", ref: "origin/dev" },
    };
    const rulesOf = (codeContext: unknown) => clerkRules(parseProjectConfig(JSON.stringify(withClerk({ ...INTAKE.clerk, codeContext }))))!.codeContext;
    expect(validateProjectConfig(withClerk({ ...INTAKE.clerk, codeContext: { repos } }))).toEqual([]);
    // mainRef defaults to origin/main.
    expect(rulesOf({ repos })).toEqual({ repos: { pwa: repos.pwa, Backoffice: { ...repos.Backoffice, mainRef: CODE_CONTEXT_MAIN_REF } } });
    expect(clerkCodeContext(undefined)).toEqual({ rules: null, problem: null });
    const malformed: [unknown, string][] = [
      ["yes", "must be an object with 'repos'"],
      [{ repos: {} }, "'repos' must map"],
      [{ repos, extra: 1 }, "unknown key 'extra'"],
      [{ repos: { both: repos.pwa } }, "'repos.both' is not an app"],
      [{ repos: { pwa: { ...repos.pwa, path: "relative/pwa" } } }, "'repos.pwa.path' must be an absolute path"],
      [{ repos: { pwa: { ...repos.pwa, ref: "--upload-pack=x" } } }, "'repos.pwa.ref' must be a git ref"],
      [{ repos: { pwa: { ...repos.pwa, mainRef: 7 } } }, "'repos.pwa.mainRef' must be a git ref"],
      [{ repos: { pwa: { ...repos.pwa, branch: "dev" } } }, "unknown key 'branch'"],
    ];
    for (const [value, why] of malformed) {
      // Never a problem that refuses the config: the clerk still starts, without code context.
      expect(validateProjectConfig(withClerk({ ...INTAKE.clerk, codeContext: value }))).toEqual([]);
      expect(rulesOf(value)).toBeNull();
      expect(clerkCodeContext(value).problem).toContain(why);
    }
  });

  it("refuses the block from a roster with no clerk: a policy nothing reads", () => {
    expect(validateProjectConfig({ ...LOGGD, appLabels: INTAKE.appLabels, clerk: INTAKE.clerk })).toEqual([
      "'clerk' needs a roster entry with the clerk role; no loop in 'loops' has it",
    ]);
  });
});

describe("the sentinel block", () => {
  /** `LOGGD` with a sentinel on the roster: what the `sentinel` block needs. */
  const WATCHING = { ...LOGGD, loops: [...LOGGD.loops, { name: "sent", role: "sentinel" }] };
  const MINIMAL = { reporter: { kind: "sentry", org: "acme", project: "web" } };
  const withSentinel = (sentinel: unknown): Record<string, unknown> => ({ ...WATCHING, sentinel });
  const problemsOf = (extra: Record<string, unknown>): string[] =>
    validateProjectConfig(withSentinel({ ...MINIMAL, ...extra }));

  it("requires the block from a roster with a sentinel, and refuses it from one without", () => {
    expect(validateProjectConfig(WATCHING)).toEqual(["'sentinel' is required: a loop in 'loops' has the sentinel role, and nothing says which error reporter it reads"]);
    expect(validateProjectConfig({ ...LOGGD, sentinel: MINIMAL })).toEqual(["'sentinel' needs a roster entry with the sentinel role; no loop in 'loops' has it"]);
    expect(validateProjectConfig(withSentinel(MINIMAL))).toEqual([]);
    expect(validateProjectConfig(withSentinel([]))).toEqual(["'sentinel' must be an object of the sentinel's reporter and rules"]);
    expect(validateProjectConfig(withSentinel({}))).toEqual([
      "'sentinel.reporter' must be an object with a 'kind' of 'sentry', an 'org' and a 'project'; got undefined",
    ]);
  });

  it("refuses a reporter without its org or project, of another kind, or with unknown keys", () => {
    expect(problemsOf({ reporter: { kind: "sentry", project: "web" } })).toEqual([
      "'sentinel.reporter.org' must be a Sentry slug (lowercase letters, digits, '-' or '_'); got undefined",
    ]);
    expect(problemsOf({ reporter: { kind: "sentry", org: "acme" } })).toEqual([
      "'sentinel.reporter.project' must be a Sentry slug (lowercase letters, digits, '-' or '_'); got undefined",
    ]);
    expect(problemsOf({ reporter: { kind: "bugsnag", org: "Acme", project: "web", environment: "", x: 1 } })).toEqual([
      "unknown key 'sentinel.reporter.x'",
      "'sentinel.reporter.kind' must be 'sentry'; got \"bugsnag\"",
      "'sentinel.reporter.org' must be a Sentry slug (lowercase letters, digits, '-' or '_'); got \"Acme\"",
      "'sentinel.reporter.environment' must be a non-empty string; got \"\"",
    ]);
  });

  it("refuses a bad mode, a non-whole threshold, a non-positive lookback and unknown keys", () => {
    expect(problemsOf({ mode: "act" })).toEqual(["'sentinel.mode' must be 'observe' or 'file'; got \"act\""]);
    expect(problemsOf({ minEvents: 2.5, minUsers: 0, maxPerDay: "5" })).toEqual([
      "'sentinel.minEvents' must be a whole number of at least 1; got 2.5",
      "'sentinel.minUsers' must be a whole number of at least 1; got 0",
      "'sentinel.maxPerDay' must be a whole number of at least 1; got \"5\"",
    ]);
    expect(problemsOf({ lookbackHours: 0 })).toEqual(["'sentinel.lookbackHours' must be a positive number; got 0"]);
    expect(problemsOf({ language: "fr", x: 1 })).toEqual(["unknown key 'sentinel.x'", "'sentinel.language' must be 'en' or 'es'; got \"fr\""]);
  });

  it("fills every default, and is null with no block", () => {
    const rules = (raw: Record<string, unknown>) => sentinelRules(parseProjectConfig(JSON.stringify(raw)));
    expect(rules(withSentinel(MINIMAL))).toEqual({
      reporter: { kind: "sentry", org: "acme", project: "web", environment: null },
      enabled: true,
      lookbackHours: 24,
      minEvents: 10,
      minUsers: 2,
      maxPerDay: 5,
      mode: "observe",
      language: "en",
    });
    expect(SENTINEL_DEFAULTS.mode).toBe("observe");
    const full = {
      reporter: { kind: "sentry", org: "acme", project: "web", environment: "production" },
      enabled: false,
      lookbackHours: 12.5,
      minEvents: 20,
      minUsers: 3,
      maxPerDay: 1,
      mode: "file",
      language: "es",
    };
    expect(problemsOf(full)).toEqual([]);
    expect(rules(withSentinel(full))).toEqual(full);
    // The language follows the screenshots locale, as the verifier's does.
    expect(rules({ ...withSentinel(MINIMAL), screenshots: { viewport: "phone", serve: "bun dev --port {port}", locale: "es" } })!.language).toBe("es");
    expect(sentinelRules(parseProjectConfig(JSON.stringify(LOGGD)))).toBeNull();
  });

  it("takes an optional boolean `enabled`, on when absent (#789)", () => {
    const rules = (raw: Record<string, unknown>) => sentinelRules(parseProjectConfig(JSON.stringify(raw)));
    expect(rules(withSentinel(MINIMAL))!.enabled).toBe(true);
    expect(rules(withSentinel({ ...MINIMAL, enabled: true }))!.enabled).toBe(true);
    expect(rules(withSentinel({ ...MINIMAL, enabled: false }))!.enabled).toBe(false);
    expect(problemsOf({ enabled: "false" })).toEqual(["'sentinel.enabled' must be true or false; got \"false\""]);
    expect(problemsOf({ enabled: null })).toEqual(["'sentinel.enabled' must be true or false; got null"]);
  });
});

describe("a verifier's block", () => {
  /** `LOGGD` with a verifier on the roster: what the `verifier` block needs. */
  const WATCHED = { ...LOGGD, loops: [...LOGGD.loops, { name: "sent", role: "verifier" }] };
  const MINIMAL = {
    productionUrl: "https://loggd.app",
    deploy: { source: "vercel", project: "prj_loggd" },
    sentry: { org: "loggd", project: "web" },
  };
  const withVerifier = (verifier: unknown): Record<string, unknown> => ({ ...WATCHED, verifier });
  const problemsOf = (extra: Record<string, unknown>): string[] => validateProjectConfig(withVerifier({ ...MINIMAL, ...extra }));

  it("refuses the block under the role's former name (#679)", () => {
    // The former name now belongs to #678's sentinel, so a verifier block
    // left under it is refused as a sentinel block, never read as a verifier.
    const problems = validateProjectConfig({ ...WATCHED, sentinel: MINIMAL });
    expect(problems).toContain("unknown key 'sentinel.productionUrl'");
    expect(problems).toContain("'sentinel' needs a roster entry with the sentinel role; no loop in 'loops' has it");
    expect(problems.some((problem) => problem.startsWith("'verifier' is required"))).toBe(true);
  });

  it("accepts a minimal block and fills every default", () => {
    expect(validateProjectConfig(withVerifier(MINIMAL))).toEqual([]);
    expect(verifierRules(parseProjectConfig(JSON.stringify(withVerifier(MINIMAL))))).toEqual({
      productionUrl: "https://loggd.app",
      deploy: { source: "vercel", project: "prj_loggd", team: null },
      sentry: { org: "loggd", project: "web" },
      enabled: true,
      windowHours: 24,
      checkIns: [1, 6, 24],
      trafficFloor: true,
      revert: { rateFactor: 5, minEvents: 10, minUsers: 2 },
      follow: { loopPrs: true, humanPrs: true },
      mode: "observe",
      language: "en",
      mergeCommand: null,
    });
    expect(VERIFIER_DEFAULTS.mode).toBe("observe");
    expect(verifierRules(parseProjectConfig(JSON.stringify(LOGGD)))).toBeNull();
  });

  it("accepts every key, and both deploy sources", () => {
    const full = {
      ...MINIMAL,
      deploy: { source: "vercel", project: "prj_loggd", team: "team_loggd" },
      enabled: false,
      windowHours: 12.5,
      checkIns: [0.5, 6, 12.5],
      trafficFloor: false,
      revert: { rateFactor: 2.5, minEvents: 20, minUsers: 3 },
      follow: { loopPrs: true, humanPrs: false },
      mode: "act",
      language: "es",
      mergeCommand: ["pr", "comment", "{pr}", "--body", "@mergifyio queue"],
    };
    expect(validateProjectConfig(withVerifier(full))).toEqual([]);
    expect(verifierRules(parseProjectConfig(JSON.stringify(withVerifier(full))))).toEqual(full);

    const github = { ...MINIMAL, deploy: { source: "github-deployments" } };
    expect(validateProjectConfig(withVerifier(github))).toEqual([]);
    expect(verifierRules(parseProjectConfig(JSON.stringify(withVerifier(github))))!.deploy).toEqual({ source: "github-deployments", environment: "production" });
    const staging = { ...MINIMAL, deploy: { source: "github-deployments", environment: "prod-eu" } };
    expect(validateProjectConfig(withVerifier(staging))).toEqual([]);
    expect(verifierRules(parseProjectConfig(JSON.stringify(withVerifier(staging))))!.deploy).toEqual({ source: "github-deployments", environment: "prod-eu" });
  });

  it("requires the block from a roster with a verifier, and refuses it from one without", () => {
    expect(validateProjectConfig(WATCHED)).toEqual([
      "'verifier' is required: a loop in 'loops' has the verifier role, and nothing says which production it watches or where it learns a deploy landed",
    ]);
    expect(validateProjectConfig({ ...LOGGD, verifier: MINIMAL })).toEqual(["'verifier' needs a roster entry with the verifier role; no loop in 'loops' has it"]);
    expect(validateProjectConfig(withVerifier([]))).toEqual(["'verifier' must be an object of the verifier's production, deploy source, Sentry project and rules"]);
    expect(validateProjectConfig(withVerifier({}))).toEqual([
      "'verifier.productionUrl' must be an absolute http(s) URL such as 'https://loggd.app'; got undefined",
      "'verifier.deploy' must be an object with a 'source' of 'vercel' or 'github-deployments'; got undefined",
      "'verifier.sentry' must be an object with 'org' and 'project'; got undefined",
    ]);
  });

  it("refuses a relative production URL and a Sentry name that is not a slug", () => {
    expect(problemsOf({ productionUrl: "loggd.app", sentry: { org: "Loggd", project: "web" } })).toEqual([
      "'verifier.productionUrl' must be an absolute http(s) URL such as 'https://loggd.app'; got \"loggd.app\"",
      "'verifier.sentry.org' must be a Sentry slug (lowercase letters, digits, '-' or '_'); got \"Loggd\"",
    ]);
  });

  it("refuses a missing or unknown deploy source, and the other source's keys", () => {
    expect(problemsOf({ deploy: { project: "prj_loggd" } })).toEqual(["'verifier.deploy.source' must be 'vercel' or 'github-deployments'; got undefined"]);
    expect(problemsOf({ deploy: { source: "netlify" } })).toEqual(["'verifier.deploy.source' must be 'vercel' or 'github-deployments'; got \"netlify\""]);
    expect(problemsOf({ deploy: { source: "vercel", environment: "production" } })).toEqual([
      "unknown key 'verifier.deploy.environment'",
      "'verifier.deploy.project' must be the Vercel project id or name; got undefined",
    ]);
    expect(problemsOf({ deploy: { source: "github-deployments", project: "prj_loggd", team: "team_loggd" } })).toEqual([
      "unknown key 'verifier.deploy.project'",
      "unknown key 'verifier.deploy.team'",
    ]);
    expect(problemsOf({ deploy: { source: "vercel", project: "prj_loggd", team: "" } })).toEqual(["'verifier.deploy.team' must be a non-empty string; got \"\""]);
  });

  it("refuses an unknown mode and unknown keys at every level", () => {
    expect(problemsOf({ mode: "revert" })).toEqual(["'verifier.mode' must be 'observe', 'report' or 'act'; got \"revert\""]);
    expect(problemsOf({ x: 1, sentry: { org: "loggd", project: "web", x: 1 }, revert: { x: 1 }, follow: { x: 1 } })).toEqual([
      "unknown key 'verifier.x'",
      "unknown key 'verifier.sentry.x'",
      "unknown key 'verifier.revert.x'",
      "unknown key 'verifier.follow.x'",
    ]);
    expect(problemsOf({ deploy: { ...MINIMAL.deploy, x: 1 } })).toEqual(["unknown key 'verifier.deploy.x'"]);
  });

  it("refuses a non-positive window, check-in or threshold", () => {
    expect(problemsOf({ windowHours: 0 })).toEqual(["'verifier.windowHours' must be a positive number; got 0"]);
    expect(problemsOf({ checkIns: [0, 6] })).toEqual(["'verifier.checkIns[0]' must be a positive number; got 0"]);
    expect(problemsOf({ checkIns: [] })).toEqual(["'verifier.checkIns' must be a non-empty list of hours after the deploy; got []"]);
    expect(problemsOf({ revert: { rateFactor: 0, minEvents: 0, minUsers: 1.5 } })).toEqual([
      "'verifier.revert.rateFactor' must be a number greater than 1; got 0",
      "'verifier.revert.minEvents' must be a whole number of at least 1; got 0",
      "'verifier.revert.minUsers' must be a whole number of at least 1; got 1.5",
    ]);
  });

  it("refuses check-ins out of order or past the window, the default window included", () => {
    expect(problemsOf({ checkIns: [6, 1] })).toEqual(["'verifier.checkIns[1]' must come after 6: check-ins are strictly ascending; got 1"]);
    expect(problemsOf({ checkIns: [1, 1] })).toEqual(["'verifier.checkIns[1]' must come after 1: check-ins are strictly ascending; got 1"]);
    expect(problemsOf({ checkIns: [1, 48] })).toEqual(["'verifier.checkIns[1]' must be within the 24-hour window; got 48"]);
    expect(problemsOf({ windowHours: 6, checkIns: [1, 12] })).toEqual(["'verifier.checkIns[1]' must be within the 6-hour window; got 12"]);
    // A shorter window cannot keep the default check-ins: the last would fall after the watch ended.
    expect(problemsOf({ windowHours: 12 })).toEqual([
      "'verifier.checkIns' must be set when 'verifier.windowHours' is under 24: the default check-ins (1, 6, 24 hours) pass a 12-hour window",
    ]);
    expect(problemsOf({ windowHours: 48 })).toEqual([]);
  });

  it("refuses following nothing, and non-boolean flags", () => {
    expect(problemsOf({ follow: { loopPrs: false, humanPrs: false } })).toEqual(["'verifier.follow' must follow loop PRs, human PRs or both"]);
    expect(problemsOf({ trafficFloor: "yes", follow: { loopPrs: 1 } })).toEqual([
      "'verifier.trafficFloor' must be true or false; got \"yes\"",
      "'verifier.follow.loopPrs' must be true or false; got 1",
    ]);
  });

  it("writes in the block's language, else the screenshots locale, else English, and refuses any other", () => {
    const languageOf = (config: Record<string, unknown>): string | undefined => verifierRules(parseProjectConfig(JSON.stringify(config)))?.language;
    const SHOTS = { viewport: "phone", serve: "bun dev --port {port}" };
    expect(languageOf(withVerifier(MINIMAL))).toBe("en");
    expect(languageOf({ ...withVerifier(MINIMAL), screenshots: { ...SHOTS, locale: "es" } })).toBe("es");
    expect(languageOf({ ...withVerifier({ ...MINIMAL, language: "en" }), screenshots: { ...SHOTS, locale: "es" } })).toBe("en");
    expect(languageOf(withVerifier({ ...MINIMAL, language: "es" }))).toBe("es");
    expect(problemsOf({ language: "fr" })).toEqual([`'verifier.language' must be 'en' or 'es'; got "fr"`]);
  });

  it("refuses a merge command that is not a list of arguments naming the PR", () => {
    expect(problemsOf({ mergeCommand: ["pr", "merge", "{pr}", "--squash"] })).toEqual([]);
    expect(problemsOf({ mergeCommand: "gh pr merge {pr}" })).toEqual([
      `'verifier.mergeCommand' must be a non-empty list of non-empty gh arguments such as ["pr", "merge", "{pr}", "--squash"]; got "gh pr merge {pr}"`,
    ]);
    expect(problemsOf({ mergeCommand: [] })).toHaveLength(1);
    expect(problemsOf({ mergeCommand: ["pr", "", "{pr}"] })).toHaveLength(1);
    expect(problemsOf({ mergeCommand: ["pr", "merge", "--squash"] })).toEqual([
      `'verifier.mergeCommand' must name the PR with '{pr}' in one of its arguments; got ["pr","merge","--squash"]`,
    ]);
  });

  it("takes an optional boolean `enabled`, on when absent (#789)", () => {
    const rules = (raw: Record<string, unknown>) => verifierRules(parseProjectConfig(JSON.stringify(raw)));
    expect(rules(withVerifier(MINIMAL))!.enabled).toBe(true);
    expect(rules(withVerifier({ ...MINIMAL, enabled: false }))!.enabled).toBe(false);
    expect(problemsOf({ enabled: 1 })).toEqual(["'verifier.enabled' must be true or false; got 1"]);
  });

  it("still reads a plain-string roster entry as a coder, and still refuses an unknown role", () => {
    expect(parseProjectConfig(JSON.stringify(withVerifier(MINIMAL))).roster).toEqual([
      ...LOGGD.loops.map((name) => ({ name, role: "coder" })),
      { name: "sent", role: "verifier" },
    ]);
    expect(loopsProblems([{ name: "sent", role: "sentry" }])).toEqual([
      "'loops[0].role' must be one of coder, triager, ci-doctor, pr-medic, clerk, verifier, sentinel; got \"sentry\"",
    ]);
  });
});

describe("a triager's block", () => {
  it("accepts autoReady and resolves it, defaulting to false", () => {
    expect(validateProjectConfig({ ...LOGGD, triage: { autoReady: true } })).toEqual([]);
    expect(triageRules(parseProjectConfig(JSON.stringify({ ...LOGGD, triage: { autoReady: true } })))).toEqual({ autoReady: true, jira: null });
    expect(triageRules(parseProjectConfig(JSON.stringify({ ...LOGGD, triage: {} })))).toEqual({ autoReady: false, jira: null });
    expect(triageRules(parseProjectConfig(JSON.stringify(LOGGD)))).toEqual({ autoReady: false, jira: null });
  });

  it("refuses an unknown key, a non-boolean autoReady and a non-object block", () => {
    expect(validateProjectConfig({ ...LOGGD, triage: { autoReady: false, colour: "red" } })).toEqual(["unknown key 'triage.colour'"]);
    expect(validateProjectConfig({ ...LOGGD, triage: { autoReady: "yes" } })).toEqual([
      "'triage.autoReady' must be true or false; got \"yes\"",
    ]);
    expect(validateProjectConfig({ ...LOGGD, triage: true })).toEqual(["'triage' must be an object of the triager's rules"]);
  });
});

describe("a triager's Jira person path (#397)", () => {
  const SITE = "example.atlassian.net";
  const rules = (triage: object) => triageRules(parseProjectConfig(JSON.stringify({ ...LOGGD, triage })));

  it("accepts a shadow or live block and resolves it, issue types defaulting to clara's own names", () => {
    for (const mode of ["shadow", "live"] as const) {
      const triage = { jira: mode, jiraSite: SITE, jiraProject: "OA" };
      expect(validateProjectConfig({ ...LOGGD, triage })).toEqual([]);
      expect(rules(triage)).toEqual({
        autoReady: false,
        jira: { mode, site: SITE, project: "OA", issueTypes: { Error: "Error", Tarea: "Tarea" } },
      });
    }
  });

  it("fills a partial issueTypes map from the default", () => {
    const triage = { jira: "live", jiraSite: SITE, jiraProject: "OA", issueTypes: { Tarea: "Task" } };
    expect(validateProjectConfig({ ...LOGGD, triage })).toEqual([]);
    expect(rules(triage).jira?.issueTypes).toEqual({ Error: "Error", Tarea: "Task" });
  });

  it("refuses a bad mode, and a mode without its site and project", () => {
    expect(validateProjectConfig({ ...LOGGD, triage: { autoReady: false, jira: "OA", jiraSite: SITE, jiraProject: "OA" } })).toEqual([
      "'triage.jira' must be 'shadow' or 'live'; got \"OA\"",
    ]);
    expect(validateProjectConfig({ ...LOGGD, triage: { jira: "shadow" } })).toEqual([
      "'triage.jiraSite' must be a host name such as 'example.atlassian.net'; got undefined",
      "'triage.jiraProject' must be a Jira project key such as 'OA'; got undefined",
    ]);
    expect(validateProjectConfig({ ...LOGGD, triage: { jira: "live", jiraSite: "https://example.atlassian.net", jiraProject: "oa" } })).toEqual([
      "'triage.jiraSite' must be a host name such as 'example.atlassian.net'; got \"https://example.atlassian.net\"",
      "'triage.jiraProject' must be a Jira project key such as 'OA'; got \"oa\"",
    ]);
  });

  it("refuses a site, project or issueTypes with no mode: a half-configured block moves nothing", () => {
    expect(validateProjectConfig({ ...LOGGD, triage: { jiraSite: SITE, jiraProject: "OA", issueTypes: {} } })).toEqual([
      "'triage.jiraSite' needs 'triage.jira' ('shadow' or 'live'); without it nothing moves to Jira",
      "'triage.jiraProject' needs 'triage.jira' ('shadow' or 'live'); without it nothing moves to Jira",
      "'triage.issueTypes' needs 'triage.jira' ('shadow' or 'live'); without it nothing moves to Jira",
    ]);
  });

  it("refuses an issueTypes map with an unknown type, an empty name or the wrong shape", () => {
    const base = { jira: "live", jiraSite: SITE, jiraProject: "OA" };
    expect(validateProjectConfig({ ...LOGGD, triage: { ...base, issueTypes: { Bug: "Bug", Error: " " } } })).toEqual([
      "unknown key 'triage.issueTypes.Bug': a report's type is one of Error, Tarea",
      "'triage.issueTypes.Error' must be a Jira issue type name; got \" \"",
    ]);
    expect(validateProjectConfig({ ...LOGGD, triage: { ...base, issueTypes: ["Error"] } })).toEqual([
      "'triage.issueTypes' must be an object from a report type (Error, Tarea) to a Jira issue type; got [\"Error\"]",
    ]);
  });
});

describe("the tracker block", () => {
  const LINEAR = { kind: "linear", team: "AND", workspace: "exampleorg" };
  const JIRA = { kind: "jira", site: "example.atlassian.net", project: "OA" };

  it("means GitHub issues when the file has none", () => {
    expect(parseProjectConfig(JSON.stringify(LOGGD)).tracker).toEqual({ kind: "github" });
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, tracker: { kind: "github" } })).tracker).toEqual({ kind: "github" });
  });

  it("accepts a Linear team and a Jira project, with the states defaulted", () => {
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, tracker: LINEAR })).tracker).toEqual({
      kind: "linear",
      team: "AND",
      workspace: "exampleorg",
      scopeLabel: null,
      states: { claimed: "In Progress", done: "Done" },
    });
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, tracker: { ...JIRA, states: { done: "Listo" } } })).tracker).toEqual({
      kind: "jira",
      site: "example.atlassian.net",
      project: "OA",
      scopeLabel: null,
      states: { claimed: "In Progress", done: "Listo" },
    });
  });

  it("accepts a local tracker file, with the states defaulted", () => {
    const LOCAL = { kind: "local", key: "SBX", file: "/srv/sandbox/tickets.json" };
    expect(validateProjectConfig({ ...LOGGD, tracker: LOCAL })).toEqual([]);
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, tracker: LOCAL })).tracker).toEqual({
      kind: "local",
      key: "SBX",
      file: "/srv/sandbox/tickets.json",
      scopeLabel: null,
      states: { claimed: "In Progress", done: "Done" },
    });
    expect(validateProjectConfig({ ...LOGGD, tracker: { ...LOCAL, file: "tickets.json" } })).toEqual([
      "'tracker.file' must be an absolute path; got \"tickets.json\"",
    ]);
    expect(validateProjectConfig({ ...LOGGD, tracker: { kind: "local", file: "/srv/t.json", team: "SBX" } })).toEqual([
      "unknown key 'tracker.team' for kind 'local'",
      "'tracker.key' must be an issue key prefix such as 'SBX'; got undefined",
    ]);
    expect(validateProjectConfig({ ...LOGGD, tracker: { kind: "local", key: "SBX" } })).toEqual([
      "'tracker.file' must be the absolute path of the tickets file",
    ]);
    // A local file is one sandbox's tickets: no scope label to filter by.
    expect(validateProjectConfig({ ...LOGGD, tracker: { ...LOCAL, scopeLabel: "sbx" } })).toEqual([
      "unknown key 'tracker.scopeLabel' for kind 'local'",
    ]);
  });

  it("carries a cancelled state only when the file spells one", () => {
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, tracker: { ...LINEAR, states: { canceled: "Cancelado" } } })).tracker).toMatchObject({
      states: { claimed: "In Progress", done: "Done", canceled: "Cancelado" },
    });
    // Undefaulted on purpose: Linear finds its own canceled-type state, and a
    // default here would move what every existing project does (#392).
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, tracker: LINEAR })).tracker).toEqual({
      kind: "linear",
      team: "AND",
      workspace: "exampleorg",
      scopeLabel: null,
      states: { claimed: "In Progress", done: "Done" },
    });
    expect(validateProjectConfig({ ...LOGGD, tracker: { ...LINEAR, states: { canceled: 7 } } })).toEqual([
      "'tracker.states.canceled' must be a workflow state name",
    ]);
  });

  it("refuses an unknown kind, unknown keys and malformed keys", () => {
    expect(validateProjectConfig({ ...LOGGD, tracker: { kind: "trello" } })).toEqual([
      "'tracker.kind' must be 'github', 'linear', 'jira' or 'local'; got \"trello\"",
    ]);
    expect(validateProjectConfig({ ...LOGGD, tracker: "linear" })).toEqual(["'tracker' must be an object with a 'kind'"]);
    expect(validateProjectConfig({ ...LOGGD, tracker: { kind: "github", team: "AND" } })).toEqual([
      "unknown key 'tracker.team' for kind 'github'",
    ]);
    expect(validateProjectConfig({ ...LOGGD, tracker: { kind: "linear", team: "and", workspace: "exampleorg" } })).toEqual([
      "'tracker.team' must be a Linear team key such as 'AND'; got \"and\"",
    ]);
    expect(validateProjectConfig({ ...LOGGD, tracker: { kind: "linear", team: "AND", scopeLabel: "" } })).toEqual([
      "'tracker.workspace' must be the Linear workspace URL key such as 'acme'; got undefined",
      "'tracker.scopeLabel' must be a label name",
    ]);
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, tracker: { ...LINEAR, scopeLabel: "acme-backoffice" } })).tracker).toMatchObject({
      scopeLabel: "acme-backoffice",
    });
    expect(validateProjectConfig({ ...LOGGD, tracker: { kind: "jira", site: "https://x", project: "oa" } })).toEqual([
      "'tracker.site' must be a host name such as 'example.atlassian.net'; got \"https://x\"",
      "'tracker.project' must be a Jira project key such as 'OA'; got \"oa\"",
    ]);
    expect(validateProjectConfig({ ...LOGGD, tracker: { ...LINEAR, states: { claimed: "", wip: "x" } } })).toEqual([
      "unknown key 'tracker.states.wip'",
      "'tracker.states.claimed' must be a workflow state name",
    ]);
  });

  it("accepts the triager but refuses ci-doctor on a Linear or Jira project", () => {
    const loops = ["ralph", { name: "tria", role: "triager" }, { name: "doc", role: "ci-doctor" }];
    expect(validateProjectConfig({ ...LOGGD, loops, tracker: LINEAR })).toEqual([
      "loop 'doc' has the ci-doctor role, which runs on GitHub issues only; a 'linear' tracker supports coder and triager loops",
    ]);
    expect(validateProjectConfig({ ...LOGGD, loops: ["ralph", { name: "tria", role: "triager" }], tracker: LINEAR })).toEqual([]);
    expect(validateProjectConfig({ ...LOGGD, loops: ["ralph", { name: "tria", role: "triager" }] })).toEqual([]);
  });

  it("exports the kind and the key for the supervisor", () => {
    const run = (config: object) =>
      spawnSync("bash", ["-c", `${exportLines(parseProjectConfig(JSON.stringify(config)), "/w", "p").join("\n")}\nprintf "%s|%s" "$RALPH_TRACKER_KIND" "$RALPH_TRACKER_KEY"`], {
        encoding: "utf8",
      }).stdout;
    expect(run(LOGGD)).toBe("github|");
    expect(run({ ...LOGGD, tracker: LINEAR })).toBe("linear|AND");
    expect(run({ ...LOGGD, tracker: JIRA })).toBe("jira|OA");
  });
});

describe("the screenshots block", () => {
  const SHOTS = { viewport: "phone", serve: "node ./node_modules/vite/bin/vite.js --port {port} --strictPort" };

  it("is optional, and absent from a config that has none", () => {
    expect(parseProjectConfig(JSON.stringify(LOGGD)).screenshots).toBeUndefined();
  });

  it("fills in its defaults", () => {
    const config = parseProjectConfig(JSON.stringify({ ...LOGGD, screenshots: SHOTS }));
    expect(config.screenshots).toEqual({ ...SHOTS, login: "supabase", requireEnv: {}, dismiss: [], locale: "en" });
  });

  it("refuses a viewport, a serve command or a fence it cannot use", () => {
    expect(validateProjectConfig({ ...LOGGD, screenshots: { ...SHOTS, viewport: "tablet" } })).toEqual([
      `'screenshots.viewport' must be 'phone' or 'desktop'; got "tablet"`,
    ]);
    // Without `{port}` two loops' servers would fight over the app's default port.
    expect(validateProjectConfig({ ...LOGGD, screenshots: { ...SHOTS, serve: "npm run dev" } })).toEqual([
      "'screenshots.serve' must be a one-line command with '{port}' where the port goes",
    ]);
    expect(validateProjectConfig({ ...LOGGD, screenshots: { ...SHOTS, requireEnv: { VITE_SUPABASE_URL: "" } } })).toEqual([
      "'screenshots.requireEnv' must be an object from an environment variable name to the text its value must start with",
    ]);
    expect(validateProjectConfig({ ...LOGGD, screenshots: { ...SHOTS, login: "magic", locale: "fr", extra: 1 } })).toEqual([
      "unknown key 'screenshots.extra'",
      `'screenshots.login' must be 'supabase' or 'none'; got "magic"`,
      `'screenshots.locale' must be 'en' or 'es'; got "fr"`,
    ]);
  });
});

describe("the worktree setup steps", () => {
  const INSTALL = { name: "install", command: "bun install --frozen-lockfile", timeoutSeconds: 120, installsDependencies: true };
  const ENV = { name: "env", command: 'cp "$RALPH_MAIN_CHECKOUT/.env.local" .env.local' };
  const loggdText = `${JSON.stringify(LOGGD, null, 2)}\n`;

  it("is optional, and an empty list on a config that has none", () => {
    expect(parseProjectConfig(JSON.stringify(LOGGD)).worktreeSetup).toEqual([]);
  });

  it("fills in each step's defaults, keeping the order", () => {
    // 120 + 120 would pass the cap, so the env step sets its own limit here.
    const config = parseProjectConfig(JSON.stringify({ ...LOGGD, worktreeSetup: [INSTALL, { ...ENV, timeoutSeconds: 30 }] }));
    expect(config.worktreeSetup).toEqual([INSTALL, { ...ENV, timeoutSeconds: 30, installsDependencies: false }]);
    expect(parseProjectConfig(JSON.stringify({ ...LOGGD, worktreeSetup: [ENV] })).worktreeSetup).toEqual([
      { ...ENV, timeoutSeconds: WORKTREE_SETUP_DEFAULT_SECONDS, installsDependencies: false },
    ]);
  });

  it("is carried by --json's parsed form", () => {
    const config = parseProjectConfig(JSON.stringify({ ...LOGGD, worktreeSetup: [INSTALL] }));
    expect(JSON.parse(JSON.stringify(config)).worktreeSetup).toEqual([INSTALL]);
  });

  it("refuses a value that is not a list of objects", () => {
    expect(validateProjectConfig({ ...LOGGD, worktreeSetup: { install: "bun install" } })).toEqual([
      "'worktreeSetup' must be an array of steps, each with a 'name' and a 'command'",
    ]);
    expect(worktreeSetupProblems(["bun install"])).toEqual(["'worktreeSetup[0]' must be an object with a 'name' and a 'command'"]);
  });

  it("refuses an unknown key, a bad name and a duplicate name", () => {
    expect(worktreeSetupProblems([{ ...ENV, foo: 1 }])).toEqual(["unknown key 'worktreeSetup[0].foo'"]);
    expect(worktreeSetupProblems([{ ...ENV, name: "Env File" }])).toEqual([`'worktreeSetup[0].name' must be lowercase kebab-case; got "Env File"`]);
    expect(worktreeSetupProblems([{ command: "x", timeoutSeconds: 1 }])).toEqual(["'worktreeSetup[0].name' must be lowercase kebab-case; got undefined"]);
    expect(worktreeSetupProblems([{ ...ENV, timeoutSeconds: 10 }, { ...ENV, timeoutSeconds: 10 }])).toEqual([
      "'worktreeSetup[1].name' 'env' is a duplicate; every step needs its own name",
    ]);
  });

  it("refuses an empty, missing or multi-line command", () => {
    for (const command of ["", "  ", "a\nb", "a\rb", undefined, 3]) {
      expect(worktreeSetupProblems([{ name: "env", command }])).toEqual(["'worktreeSetup[0].command' must be a one-line command"]);
    }
  });

  it("refuses a limit that is not a whole number of seconds from 1 to 150", () => {
    for (const timeoutSeconds of [0, 151, 1.5, "60", -1, null]) {
      expect(worktreeSetupProblems([{ ...ENV, timeoutSeconds }])).toEqual([
        `'worktreeSetup[0].timeoutSeconds' must be a whole number of seconds from 1 to ${WORKTREE_SETUP_MAX_SECONDS}; got ${JSON.stringify(timeoutSeconds)}`,
      ]);
    }
    expect(worktreeSetupProblems([{ ...ENV, timeoutSeconds: 1 }])).toEqual([]);
    expect(worktreeSetupProblems([{ ...ENV, timeoutSeconds: 150 }])).toEqual([]);
  });

  it("refuses an installsDependencies that is not a boolean", () => {
    expect(worktreeSetupProblems([{ ...ENV, installsDependencies: "yes" }])).toEqual([
      `'worktreeSetup[0].installsDependencies' must be true or false; got "yes"`,
    ]);
  });

  it("refuses steps whose limits, defaults included, sum past what one dashboard request allows", () => {
    // 120 + the default 120 = 240 > 150.
    const problems = worktreeSetupProblems([INSTALL, ENV]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("'worktreeSetup' may take at most 150 s in all");
    expect(problems[0]).toContain("255 s");
    expect(problems[0]).toContain("these add up to 240 s");
    expect(worktreeSetupProblems([{ ...INSTALL, timeoutSeconds: 30 }, ENV])).toEqual([]);
    expect(worktreeSetupProblems([{ ...INSTALL, timeoutSeconds: 31 }, ENV])).toHaveLength(1);
  });

  it("editProject writes the list whole, an empty one included", () => {
    const steps = [{ ...INSTALL, timeoutSeconds: 30 }, ENV];
    const edited = editProject(loggdText, { worktreeSetup: steps });
    expect(JSON.parse(edited)).toEqual({ ...LOGGD, worktreeSetup: steps });
    expect(Object.keys(JSON.parse(edited))).toEqual([...Object.keys(LOGGD), "worktreeSetup"]);
    expect(JSON.parse(editProject(edited, { worktreeSetup: [] }))).toEqual({ ...LOGGD, worktreeSetup: [] });
    expect(JSON.parse(editProject(loggdText, { worktreeSetup: [] }))).toEqual({ ...LOGGD, worktreeSetup: [] });
  });

  it("editProject refuses an invalid list with the read's problem", () => {
    expect(() => editProject(loggdText, { worktreeSetup: [INSTALL, ENV] })).toThrow("'worktreeSetup' may take at most 150 s in all");
    expect(() => editProject(loggdText, { worktreeSetup: [{ ...ENV, command: "a\nb" }] })).toThrow("'worktreeSetup[0].command' must be a one-line command");
  });
});
