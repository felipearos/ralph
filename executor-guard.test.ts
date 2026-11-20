// @vitest-environment node
/**
 * The executor's command guard: repo-wide verification is refused before it
 * starts, whatever the brief said and whether or not the model read it.
 *
 * On 2026-09-23 two Codex executors spent their whole 900s budget on checks
 * nobody asked for. rafa #1108 ran `bun run test` with no paths as "final
 * verification" (the brief forbade exactly that), the integration tests
 * stalled, and it was killed. ralph #1221 ran `bun lint` over the whole repo,
 * Codex lost the process, and it was killed too. Both commands are here
 * verbatim, against a project whose scripts are Loggd's.
 *
 * The verdicts are checked against a real directory tree, because "is this
 * target the whole repository" is a question about the filesystem; the shim is
 * then run for real, with the real `bun`, to prove a refusal never reaches the
 * command it refused.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { REFUSED_DIFF_EXIT } from "./executor-guard/diff-guard";
import { judge, loadContext, refusalMessage, REFUSED_EXIT } from "./executor-guard/guard";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs the executor guard through bash");

const HOME = dirname(new URL(import.meta.url).pathname);
const SHIMS = join(HOME, "executor-guard", "bin");

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

/** Loggd's scripts that matter here, exactly as its package.json has them. */
const LOGGD_SCRIPTS = {
  build: "next build",
  dev: "next dev -p 3500",
  lint: "eslint src/ mobile/ packages/",
  typecheck: "node_modules/typescript7/bin/tsc --noEmit",
  test: "bun x vitest run",
  "test:watch": "bun x vitest",
  "test:security": "bun x vitest run --config vitest.security.config.ts",
  "test:ci-conformance": "bun x vitest run scripts/affected-scopes.test.ts scripts/ci-scope-guard.test.ts",
  "test:e2e": "playwright test",
  "db:seed:e2e": "bun run scripts/seed-e2e.ts",
  lighthouse: "bun run build && lhci autorun --config=lighthouserc.cjs",
  "analyze:typography": "bun run scripts/analyze-typography.ts",
  storybook: "storybook dev -p 6006",
};

function project(executorGuard?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "executor-guard-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: LOGGD_SCRIPTS }));
  for (const path of ["src/server/queries", "mobile/components", "packages/shared/src", "scripts", ".ralph"]) {
    mkdirSync(join(root, path), { recursive: true });
  }
  for (const path of [
    "src/server/queries/listProgress.ts",
    "src/server/queries/listProgress.test.ts",
    "packages/shared/src/diary-filters.ts",
    "packages/shared/src/diary-filters.test.ts",
    "scripts/affected-scopes.test.ts",
    "scripts/ci-scope-guard.test.ts",
  ]) {
    writeFileSync(join(root, path), "");
  }
  if (executorGuard !== undefined) {
    writeFileSync(join(root, ".ralph", "config.json"), JSON.stringify({ executorGuard }));
  }
  return root;
}

const verdict = (root: string, command: string, cwd = root) => judge(command.split(" "), loadContext(cwd));
const allowed = (root: string, command: string, cwd?: string) => verdict(root, command, cwd).allowed;

describe("the commands that cost two executors their budget", () => {
  const root = project();

  it("refuses `bun run test` with no paths, the rafa #1108 command", () => {
    const result = verdict(root, "bun run test");
    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.reason).toMatch(/vitest.*no file targets/);
  });

  it("refuses `bun lint`, the ralph #1221 command, because the script lints whole top-level directories", () => {
    const result = verdict(root, "bun lint");
    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.reason).toMatch(/eslint.*src\//);
    expect(allowed(root, "bun run lint")).toBe(false);
    // Appending a file does not narrow a script that already names src/.
    expect(allowed(root, "bun run lint src/server/queries/listProgress.ts")).toBe(false);
  });

  it("still allows the targeted checks both executors ran before and after", () => {
    expect(allowed(root, "bun run test src/server/queries/listProgress.test.ts")).toBe(true);
    expect(allowed(root, "bun run test packages/shared/src/diary-filters.test.ts src/server/queries/listProgress.test.ts")).toBe(true);
    expect(allowed(root, "bun run test -- src/server/queries/listProgress.test.ts")).toBe(true);
    expect(allowed(root, "bun x eslint packages/shared/src/diary-filters.ts packages/shared/src/diary-filters.test.ts")).toBe(true);
    expect(allowed(root, "bunx eslint src/server/queries/listProgress.ts")).toBe(true);
    expect(allowed(root, "bun run typecheck")).toBe(true);
  });
});

describe("whole-suite and whole-repo spellings", () => {
  const root = project();

  it.each([
    "bunx vitest run",
    "bun x vitest run",
    "bun x vitest",
    "npx vitest run",
    "pnpm exec vitest run",
    "npm test",
    "npm run test",
    "yarn test",
    "vitest run",
    "node node_modules/.bin/vitest run",
    "./node_modules/.bin/vitest run",
    "bun test",
    "bunx jest",
    "bun run test:watch",
    "bun run test:security",
    "bunx eslint .",
    "bunx eslint ./",
    "bunx eslint src",
    "bunx eslint src/**/*.ts",
    "npx eslint mobile/",
    "bunx oxlint",
    "bunx vitest run --config vitest.security.config.ts",
    "bunx vitest run src/",
  ])("refuses %s", (command) => {
    expect(allowed(root, command)).toBe(false);
  });

  it.each([
    "bunx vitest run src/server/queries/listProgress.test.ts",
    "bunx vitest run listProgress",
    "bunx vitest related src/server/queries/listProgress.ts",
    "bunx vitest run --changed",
    "bunx vitest run -t filters packages/shared/src/diary-filters.test.ts",
    "bunx eslint --fix src/server/queries/listProgress.ts",
    "bun test src/server/queries/listProgress.test.ts",
    "bun run test:ci-conformance",
    "bunx jest components/__tests__/ListCard.test.tsx --runInBand",
  ])("allows %s", (command) => {
    expect(allowed(root, command)).toBe(true);
  });

  it("measures a target against the package root, not the shell's cwd", () => {
    const shared = join(root, "packages", "shared");
    // `src` two levels down is one package's sources, not the repository...
    expect(allowed(root, "bunx vitest run src", shared)).toBe(true);
    expect(allowed(root, "bunx vitest run packages/shared/src")).toBe(true);
    // ...and climbing back up to a top-level directory is still the repository.
    expect(allowed(root, "bunx vitest run ../../src", shared)).toBe(false);
  });
});

describe("builds, e2e and servers", () => {
  const root = project();

  it.each([
    "bun run build",
    "bun build ./src/index.ts",
    "npx next build",
    "bun run test:e2e",
    "bunx playwright test src/server/queries/listProgress.test.ts",
    "bun run db:seed:e2e",
    "bun run lighthouse",
    "bun run dev",
    "bun run storybook",
    "bunx vitest watch src/server/queries/listProgress.test.ts",
  ])("refuses %s even with a target", (command) => {
    expect(allowed(root, command)).toBe(false);
  });

  it.each([
    "bun scripts/check.ts",
    "bun run scripts/check.ts",
    "bun run analyze:typography",
    "bun install --frozen-lockfile",
    "node --version",
    "node /ralph-codex/node_modules/@openai/codex/bin/codex.js exec --json -",
    "bun",
    "git status",
  ])("leaves %s alone", (command) => {
    expect(allowed(root, command)).toBe(true);
  });
});

describe("project-configured commands", () => {
  it("adds the project's own refusals and target requirements to the built-in ones", () => {
    const root = project({ refuse: ["npm run analyze:typography", "lhci"], requireTargets: ["bun run check-scripts", "knip"] });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { ...LOGGD_SCRIPTS, "check-scripts": "bun scripts/check.ts" } }),
    );
    // A pattern names the script, whichever package manager it was written for.
    expect(allowed(root, "bun run analyze:typography")).toBe(false);
    expect(allowed(root, "bunx lhci autorun")).toBe(false);
    expect(allowed(root, "bun run check-scripts")).toBe(false);
    expect(allowed(root, "bun check-scripts src/server/queries/listProgress.ts")).toBe(true);
    expect(allowed(root, "bunx knip")).toBe(false);
    expect(allowed(root, "bunx knip src/server/queries/listProgress.ts")).toBe(true);
    // The built-ins still hold.
    expect(allowed(root, "bun run test")).toBe(false);
  });

  it("reads the project's config from a subdirectory", () => {
    const root = project({ refuse: ["lhci"], requireTargets: [] });
    expect(allowed(root, "bunx lhci", join(root, "src"))).toBe(false);
  });
});

describe("the refusal the executor reads", () => {
  it("names the command, why, and what to run instead", () => {
    const root = project();
    const argv = ["bun", "run", "test"];
    const result = judge(argv, loadContext(root));
    expect(result.allowed).toBe(false);
    const message = refusalMessage(argv, result as Extract<typeof result, { allowed: false }>);
    expect(message).toContain("refused `bun run test`");
    expect(message).toMatch(/orchestrator/);
    expect(message).toMatch(/files you touched/);
    expect(message).toMatch(/bun run test path\/to\/changed\.test\.ts/);
  });
});

describe("the shim on PATH", () => {
  /**
   * A project whose `vitest` and `eslint` are fakes that say they ran, so an
   * allowed command proves the shim handed over to the real `bun`, and a
   * refused one proves nothing ran at all.
   */
  function shimmed() {
    const root = project();
    const bin = join(root, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    for (const tool of ["vitest", "eslint"]) {
      writeFileSync(join(bin, tool), `#!/usr/bin/env bash\necho "${tool} ran: $*"\n`);
      chmodSync(join(bin, tool), 0o755);
    }
    const run = (command: string) =>
      spawnSync("bash", ["-c", command], {
        cwd: root,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, PATH: `${SHIMS}:${process.env.PATH ?? ""}` },
      });
    return { root, run };
  }

  it("refuses the whole suite before anything runs, with the guard's message", () => {
    const { run } = shimmed();
    const result = run("bun run test");
    expect(result.status).toBe(126);
    expect(result.stdout).not.toContain("vitest ran");
    expect(result.stderr).toContain("refused `bun run test`");
  });

  it("refuses a whole-repo lint through `bun lint`", () => {
    const { run } = shimmed();
    const result = run("bun lint");
    expect(result.status).toBe(126);
    expect(result.stdout).not.toContain("eslint ran");
  });

  it("hands a targeted run to the real bun, arguments intact", () => {
    const { run } = shimmed();
    const result = run("bun run test src/server/queries/listProgress.test.ts");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("vitest ran: run src/server/queries/listProgress.test.ts");
  });

  it("serves `bunx` as `bun x` when no standalone bunx is installed", () => {
    const { run } = shimmed();
    const result = run("bunx eslint src/server/queries/listProgress.ts");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("eslint ran: src/server/queries/listProgress.ts");
  });

  it("runs the command unchecked, loudly, when the guard itself breaks", () => {
    const { root, run } = shimmed();
    // An unreadable package.json is a guard failure, not a refusal: the
    // executor keeps working and the warning says why nothing was checked.
    writeFileSync(join(root, "package.json"), "{ not json");
    const result = run("bun x vitest run");
    expect(result.stdout).toContain("vitest ran: run");
    expect(result.stderr).toMatch(/executor guard failed/);
  });
});

describe("the diff subcommand", () => {
  /**
   * The ci-doctor's diff guard shares this binary (felipearos/ralph#152), so
   * what is pinned here is the wiring — stdin, the project's `ciDoctor`
   * block, the exit code — and not the rules, which
   * `executor-guard/diff-guard.test.ts` pins.
   */
  const SKIP_DIFF = [
    "diff --git a/src/a.test.ts b/src/a.test.ts",
    "--- a/src/a.test.ts",
    "+++ b/src/a.test.ts",
    "@@ -1 +1 @@",
    '-  it("x", () => {});',
    '+  it.skip("x", () => {});',
    "",
  ].join("\n");

  const CLEAN_DIFF = SKIP_DIFF.replace("it.skip(", "it(");

  const judgeDiff = (root: string, diff: string, args: string[] = []) =>
    spawnSync("bun", [join(HOME, "executor-guard", "guard.ts"), "diff", "--cwd", root, ...args], {
      input: diff,
      encoding: "utf8",
      timeout: 60_000,
    });

  it("refuses a weakening on stdin with REFUSED_EXIT and names the finding", () => {
    const result = judgeDiff(project(), SKIP_DIFF);
    expect(result.status).toBe(10);
    expect(result.stderr).toContain("ralph ci-doctor diff guard: refused this diff (1 finding)");
    expect(result.stderr).toContain("adds `.skip`");
    expect(result.stderr).toContain("A refusal is a finding");
  });

  it("allows a diff that breaks no rule", () => {
    const result = judgeDiff(project(), CLEAN_DIFF);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("reads the project's ciDoctor fix scope", () => {
    const root = project();
    writeFileSync(join(root, ".ralph", "config.json"), JSON.stringify({ ciDoctor: { fixScope: ["spec/**"] } }));
    const result = judgeDiff(root, CLEAN_DIFF);
    expect(result.status).toBe(10);
    expect(result.stderr).toContain("outside the doctor's fix scope (spec/**)");
  });

  it("takes the timeout evidence from a PR body file", () => {
    const root = project();
    const raise = [
      "diff --git a/src/a.test.ts b/src/a.test.ts",
      "--- a/src/a.test.ts",
      "+++ b/src/a.test.ts",
      "@@ -1,2 +1,2 @@",
      '   it("walks", () => {',
      "-  }, 5000);",
      "+  }, 20000);",
      "",
    ].join("\n");
    expect(judgeDiff(root, raise).status).toBe(10);

    const body = join(root, "pr-body.md");
    writeFileSync(body, "## Why\n\ntimeout-evidence: ci=9s local=2s\n");
    expect(judgeDiff(root, raise, ["--pr-body", body]).status).toBe(0);
  });

  it("has no --revert flag, which the executor could use to clear any diff", () => {
    // The exception skips the weakening and timeout rules, so a caller free
    // to name the comparison clears everything by naming a copy of itself.
    const root = project();
    const copy = join(root, "self.diff");
    writeFileSync(copy, SKIP_DIFF);
    const result = judgeDiff(root, SKIP_DIFF, ["--revert", copy]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: bun guard.ts diff");
  });

  it("refuses with the same exit code the command guard uses", () => {
    // The two are declared in different files so that `diff-guard.ts` stays
    // importable on its own; nothing but this keeps them in step.
    expect(REFUSED_DIFF_EXIT).toBe(REFUSED_EXIT);
  });

  it("exits 2 on an unknown flag rather than silently dropping it", () => {
    // A mistyped `--pr-bodyy` that is ignored refuses the diff for want of
    // evidence that was in fact supplied, and says nothing about why.
    const result = spawnSync("bun", [join(HOME, "executor-guard", "guard.ts"), "diff", "--cwd", ".", "--pr-bodyy", "x"], {
      input: "",
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: bun guard.ts diff");
  });

  it("explains itself rather than guessing when --cwd is missing", () => {
    const result = spawnSync("bun", [join(HOME, "executor-guard", "guard.ts"), "diff"], {
      input: "",
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: bun guard.ts diff --cwd <dir>");
  });
});

describe("the standing executor rails", () => {
  it("say repo-wide verification is refused and the orchestrator's", () => {
    const coder = readFileSync(join(HOME, "coder.md"), "utf8");
    expect(coder).toMatch(/Targeted checks only/);
    expect(coder).toMatch(/refused/);
  });
});
