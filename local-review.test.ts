// @vitest-environment node
/**
 * The local review reads Revisión Claude out of the app repo's own workflow,
 * so a local run reviews the way CI does. These tests pin the extraction
 * against a verbatim copy of the real workflow: if the prompt drifts by a byte,
 * the local review is no longer the review the repo runs.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  localModeAddendum,
  matchesUi,
  parseReviewWorkflow,
  parseYaml,
  runLocalReview,
  type LocalReviewResult,
  type ReviewSpec,
  type ReviewVars,
} from "./local-review";
import { subprocessSuite } from "./test-timeouts";

// Vitest runs on Node, where the YAML parse goes through a `bun` child.
subprocessSuite("git fixture repos, bash install steps, a stub claude, and bun for YAML and the CLI");

const FIXTURE = readFileSync(join(import.meta.dirname, "fixtures/revision-claude/revision-claude.yml"), "utf8");

const VARS: ReviewVars = {
  repo: "example/client-pwa",
  pr: "local",
  base: "main",
  playwright: "si",
  runUrl: "file:///tmp/local-review/run",
};

function spec(text: string = FIXTURE, vars: ReviewVars = VARS): ReviewSpec {
  const result = parseReviewWorkflow(text, vars);
  if (!result.ok) throw new Error(result.reason);
  return result.spec;
}

function failure(text: string): string {
  const result = parseReviewWorkflow(text, VARS);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.reason;
}

describe("parseReviewWorkflow on the real workflow", () => {
  const parsed = spec();

  it("keeps the workflow's prompt byte for byte, with only the expressions substituted", () => {
    const doc = parseYaml(FIXTURE) as {
      jobs: Record<string, { steps: { uses?: string; with?: { prompt?: string } }[] }>;
    };
    const step = doc.jobs.revision?.steps.find((s) => s.uses?.startsWith("anthropics/claude-code-action@"));
    const raw = step?.with?.prompt;
    expect(typeof raw).toBe("string");
    const expected = (raw as string)
      .replaceAll(
        "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
        VARS.runUrl,
      )
      .replaceAll("${{ github.repository }}", VARS.repo)
      .replaceAll("${{ github.event.pull_request.number }}", VARS.pr)
      .replaceAll("${{ github.event.pull_request.base.ref }}", VARS.base)
      .replaceAll("${{ steps.ui.outputs.playwright }}", VARS.playwright);
    expect(parsed.prompt).toBe(expected);
    expect(parsed.prompt).not.toContain("${{");
    expect(parsed.prompt).toContain("REPO: example/client-pwa\nPR: local\nBASE: main\nPLAYWRIGHT: si\n");
    expect(parsed.prompt).toContain(`CORRIDA: ${VARS.runUrl}\n`);
    expect(parsed.unresolved).toEqual([]);
  });

  it("splits the tool list out of claude_args", () => {
    expect(parsed.claudeArgs).toEqual(["--model", "claude-opus-5-5", "--effort", "high", "--max-turns", "90"]);
    expect(parsed.allowedTools).toEqual([
      "mcp__github_inline_comment__create_inline_comment",
      "Bash(gh pr diff:*)",
      "Bash(gh pr view:*)",
      "Bash(gh api:*)",
      "Read",
      "Grep",
      "Glob",
      "Write(./tests/e2e/_revision-claude/**)",
      "Edit(./tests/e2e/_revision-claude/**)",
      "Bash(npx playwright test tests/e2e/_revision-claude:*)",
    ]);
  });

  it("reads settings, the step's env and its timeout", () => {
    expect(parsed.settings).toEqual({ env: { BASH_DEFAULT_TIMEOUT_MS: "300000", BASH_MAX_TIMEOUT_MS: "600000" } });
    expect(parsed.env.E2E_BUNDLED_CHROMIUM).toBe("1");
    expect(parsed.env.VITE_SUPABASE_URL).toBe("https://ci.supabase.invalid");
    expect(parsed.timeoutMinutes).toBe(30);
  });

  it("takes the UI pattern from the workflow's ui step", () => {
    expect(parsed.uiPattern).toBe("^src/.*\\.(tsx?|css)$");
    expect(parsed.uiPatternSource).toBe("workflow");
    expect(matchesUi(["src/a.tsx"], parsed.uiPattern)).toBe(true);
    expect(matchesUi(["README.md", "tests/x.ts"], parsed.uiPattern)).toBe(false);
  });

  it("takes the install step without --with-deps, which would sudo apt-get", () => {
    expect(parsed.installSource).toBe("workflow");
    expect(parsed.installCommand).toContain("npm ci");
    expect(parsed.installCommand).toContain("npx playwright install chromium-headless-shell");
    expect(parsed.installCommand).not.toContain("--with-deps");
  });

  it("finds the spec and screenshot directories", () => {
    expect(parsed.playwrightSpecDir).toBe("tests/e2e/_revision-claude");
    expect(parsed.screenshotDir).toBe("tests/e2e/_revision-claude/capturas");
  });
});

const MINIMAL = `
name: minimal
on: pull_request
jobs:
  review:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v6
      - uses: anthropics/claude-code-action@v1
        with:
          prompt: |
            Review \${{github.repository}} at \${{  github.sha  }}.
`;

describe("parseReviewWorkflow on other workflows", () => {
  it("drops env values and claude_args that hold expressions, and records them", () => {
    const parsed = spec(`
jobs:
  r:
    steps:
      - uses: anthropics/claude-code-action@v1
        env:
          ANTHROPIC_API_KEY: \${{ secrets.KEY }}
          KEEP: "1"
        with:
          prompt: hi
          claude_args: --model \${{ vars.M }} --max-turns 9 --flag=\${{ vars.F }}
`);
    expect(parsed.env).toEqual({ KEEP: "1" });
    expect(parsed.claudeArgs).toEqual(["--max-turns", "9"]);
    expect(parsed.unresolved).toEqual(["${{ vars.M }}", "${{ vars.F }}", "${{ secrets.KEY }}"]);
  });

  it("falls back to defaults when there is no ui or dependencias step", () => {
    const parsed = spec(MINIMAL);
    expect(parsed.uiPattern).toBe("^src/.*\\.(tsx?|css)$");
    expect(parsed.uiPatternSource).toBe("default");
    expect(parsed.installCommand).toBe("npm ci && npx playwright install chromium-headless-shell");
    expect(parsed.installSource).toBe("default");
    expect(parsed.claudeArgs).toEqual([]);
    expect(parsed.allowedTools).toEqual([]);
    expect(parsed.settings).toBeNull();
    expect(parsed.env).toEqual({});
    expect(parsed.timeoutMinutes).toBeNull();
    expect(parsed.screenshotDir).toBe("tests/e2e/_revision-claude/capturas");
  });

  it("matches expressions whatever their spacing, and records the unknown ones", () => {
    const parsed = spec(MINIMAL);
    expect(parsed.prompt).toBe("Review example/client-pwa at .\n");
    expect(parsed.unresolved).toEqual(["${{  github.sha  }}"]);
  });

  it("refuses invalid YAML", () => {
    expect(failure("jobs: [unclosed\n  - : :")).toMatch(/not valid YAML/);
  });

  it("refuses a document that is not a mapping", () => {
    expect(failure("- just\n- a list\n")).toMatch(/not a YAML mapping/);
  });

  it("refuses a workflow with no claude step", () => {
    expect(failure("jobs:\n  ci:\n    steps:\n      - run: npm test\n")).toMatch(
      /no anthropics\/claude-code-action step/,
    );
  });

  it("refuses a claude step with no prompt", () => {
    expect(
      failure("jobs:\n  r:\n    steps:\n      - uses: anthropics/claude-code-action@v1\n        with:\n          claude_args: --model x\n"),
    ).toMatch(/no string with\.prompt/);
  });

  it("refuses settings that are not JSON", () => {
    expect(
      failure(
        "jobs:\n  r:\n    steps:\n      - uses: anthropics/claude-code-action@v1\n        with:\n          prompt: hi\n          settings: '{not json'\n",
      ),
    ).toMatch(/with\.settings is not valid JSON/);
  });
});

describe("matchesUi", () => {
  it("is true when any path matches", () => {
    expect(matchesUi(["README.md", "src/styles/app.css"], "^src/.*\\.(tsx?|css)$")).toBe(true);
    expect(matchesUi([], "^src/.*\\.(tsx?|css)$")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runLocalReview against a temp repo, a stub claude and a recording gh.

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function g(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8" },
  );
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/** A repo whose branch `base` holds the workflow, and whose HEAD changes `change`. */
function makeRepo(workflow: string | null, change: Record<string, string>): string {
  const dir = temp("local-review-repo-");
  g(dir, "init", "-q", "-b", "main");
  writeFiles(dir, {
    "README.md": "hello\n",
    ...(workflow === null ? {} : { ".github/workflows/revision-claude.yml": workflow }),
  });
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "base");
  g(dir, "branch", "base");
  writeFiles(dir, change);
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "head");
  return dir;
}

function synthetic(install: string): string {
  const indented = install
    .split("\n")
    .map((line) => `          ${line}`)
    .join("\n");
  return `
jobs:
  revision:
    steps:
      - id: ui
        run: |
          if grep -qE '^src/.*\\.(tsx?|css)$' <<<"$archivos"; then echo si; fi
      - id: dependencias
        run: |
${indented}
      - uses: anthropics/claude-code-action@v1
        timeout-minutes: 5
        env:
          REVIEW_ENV: from-workflow
        with:
          prompt: |
            REPO: \${{ github.repository }}
            PLAYWRIGHT: \${{ steps.ui.outputs.playwright }}
            Read the diff with gh pr diff.
          claude_args: |
            --model claude-opus-5-5
            --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash(gh pr diff:*),Read"
`;
}

const STUB_CLAUDE = `#!/bin/bash
d="$STUB_DIR"
printf '%s\\0' "$@" > "$d/argv"
pwd > "$d/cwd"
env > "$d/env"
# The diff file sits beside the worktree, outside it.
cp ../review.diff "$d/review.diff" 2>/dev/null
if [ -e "$d/hang" ]; then
  echo $$ > "$d/pid.tmp" && mv "$d/pid.tmp" "$d/pid"
  exec sleep 30
fi
# Whatever the model tries, nothing may reach GitHub.
gh api -X POST repos/o/r/pulls/1/comments -f body=hi 2>>"$d/gh-refused"; echo "api $?" >> "$d/gh-exits"
gh pr comment 1 --body hi 2>>"$d/gh-refused"; echo "comment $?" >> "$d/gh-exits"
mkdir -p tests/e2e/_revision-claude/capturas/login
printf 'PNG' > tests/e2e/_revision-claude/capturas/login/shot.png
cat "$d/response.json"
exit "$(cat "$d/exit")"
`;

const RECORDING_GH = `#!/bin/sh
echo "$*" >> "$STUB_DIR/gh.log"
`;

const FINDINGS = [
  { priority: "P1", path: "src/a.tsx", line: 3, title: "Crash", text: "Se cae." },
  { priority: "P3", path: "README.md", line: null, title: "Typo", text: "Falta una coma." },
];

function answer(findings: unknown = FINDINGS): string {
  return "Revisé el diff.\n\n```json\n" + JSON.stringify({ findings }) + "\n```\n";
}

type Stub = { dir: string; env: NodeJS.ProcessEnv; out: string };

function stub(result: string = answer(), exit = 0, extra: Record<string, unknown> = {}): Stub {
  const dir = temp("local-review-stub-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(dir, "claude"), STUB_CLAUDE);
  chmodSync(join(dir, "claude"), 0o755);
  writeFileSync(join(bin, "gh"), RECORDING_GH);
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(
    join(dir, "response.json"),
    JSON.stringify({ type: "result", is_error: false, result, total_cost_usd: 0.25, duration_ms: 1234, ...extra }),
  );
  writeFileSync(join(dir, "exit"), String(exit));
  return {
    dir,
    out: join(dir, "out"),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      STUB_DIR: dir,
      RALPH_CLAUDE_BIN: join(dir, "claude"),
      GH_TOKEN: "secret-gh",
      GITHUB_TOKEN: "secret-github",
    },
  };
}

function argv(s: Stub): string[] {
  return readFileSync(join(s.dir, "argv"), "utf8").split("\0").slice(0, -1);
}

function argAfter(s: Stub, flag: string): string {
  const args = argv(s);
  return args[args.indexOf(flag) + 1] ?? "";
}

function review(checkout: string, s: Stub, extra: { head?: string } = {}): Promise<LocalReviewResult> {
  return runLocalReview({ checkout, base: "base", out: s.out, env: s.env, ...extra });
}

function ok(result: LocalReviewResult): Extract<LocalReviewResult, { status: "ok" }> {
  if (result.status !== "ok") throw new Error(`expected ok, got: ${result.reason}`);
  return result;
}

function reason(result: LocalReviewResult): string {
  expect(result.status).toBe("unavailable");
  expect(result).not.toHaveProperty("findings");
  return result.status === "unavailable" ? result.reason : "";
}

function worktreeCount(repo: string): number {
  return g(repo, "worktree", "list").trim().split("\n").length;
}

describe("runLocalReview", () => {
  it("prompts with the workflow's own prompt plus the local-mode addendum, without GitHub tools", async () => {
    const repo = makeRepo(FIXTURE, { "README.md": "changed\n" });
    const s = stub();
    const result = ok(await review(repo, s));

    const base = g(repo, "rev-parse", "base").trim();
    const head = g(repo, "rev-parse", "HEAD").trim();
    expect(result.base).toBe(base);
    expect(result.head).toBe(head);
    const expected = spec(FIXTURE, {
      repo: "local/repo",
      pr: "local",
      base: "base",
      playwright: "no",
      runUrl: `file://${s.out}`,
    });
    const diffPath = /read (\/\S+\/review\.diff) with the Read tool/.exec(argAfter(s, "-p"))?.[1] ?? "";
    expect(diffPath).not.toBe("");
    expect(argAfter(s, "-p")).toBe(expected.prompt + localModeAddendum(base, head, diffPath));
    expect(argAfter(s, "-p")).toContain(`git diff ${base}...${head}`);
    expect(readFileSync(join(s.dir, "review.diff"), "utf8")).toContain("+changed");

    const tools = argAfter(s, "--allowedTools").split(",");
    expect(tools.some((t) => t.startsWith("mcp__") || t.startsWith("Bash(gh") || t.startsWith("Bash(git"))).toBe(false);
    expect(tools).toEqual(expect.arrayContaining(["Read", "Grep", "Glob"]));

    const args = argv(s);
    expect(args).toEqual(
      expect.arrayContaining(["--output-format", "json", "--permission-mode", "dontAsk", "--strict-mcp-config"]),
    );
    expect(argAfter(s, "--setting-sources")).toBe("");
    expect(args).toEqual(expect.arrayContaining(["--model", "claude-opus-5-5", "--max-turns", "90"]));
    expect(JSON.parse(argAfter(s, "--settings"))).toEqual(expected.settings);

    // The run happens in a throwaway worktree of head, never in the checkout.
    expect(readFileSync(join(s.dir, "cwd"), "utf8").trim()).not.toBe(repo);
    const env = readFileSync(join(s.dir, "env"), "utf8");
    expect(env).not.toMatch(/^GH_TOKEN=/m);
    expect(env).not.toMatch(/^GITHUB_TOKEN=/m);
    expect(env).toMatch(/^E2E_BUNDLED_CHROMIUM=1$/m);
    expect(env).toMatch(/^CI=true$/m);
  });

  it("returns the findings, the cost and the duration", async () => {
    const repo = makeRepo(FIXTURE, { "README.md": "changed\n" });
    const result = ok(await review(repo, stub()));
    expect(result.findings).toEqual(FINDINGS);
    expect(result.costUsd).toBe(0.25);
    expect(result.durationMs).toBe(1234);
    expect(result.workflow).toEqual({ path: ".github/workflows/revision-claude.yml", ref: result.base });
  });

  it("skips Playwright when the diff touches no UI file", async () => {
    const marker = join(temp("local-review-marker-"), "installed");
    const repo = makeRepo(synthetic(`echo ran > ${marker}`), { "README.md": "changed\n" });
    const s = stub();
    const result = ok(await review(repo, s));
    expect(result.playwright).toBe("skipped");
    expect(result.playwrightNote).toBe("the diff touches no file matching ^src/.*\\.(tsx?|css)$");
    expect(existsSync(marker)).toBe(false);
    expect(argAfter(s, "-p")).toContain("PLAYWRIGHT: no\n");
  });

  it("installs for Playwright when the diff touches src/a.tsx", async () => {
    const marker = join(temp("local-review-marker-"), "installed");
    const repo = makeRepo(synthetic(`echo one\necho ran > ${marker}`), { "src/a.tsx": "export {};\n" });
    const s = stub();
    const result = ok(await review(repo, s));
    expect(result.playwright).toBe("ran");
    expect(result.playwrightNote).toBeNull();
    expect(readFileSync(marker, "utf8")).toBe("ran\n");
    expect(argAfter(s, "-p")).toContain("PLAYWRIGHT: si\n");
    expect(readFileSync(join(s.dir, "env"), "utf8")).toMatch(/^REVIEW_ENV=from-workflow$/m);
    expect(argAfter(s, "--allowedTools")).toBe("Read");
  });

  it("fences the install like the review: CI set, no token, gh refused", async () => {
    const marker = join(temp("local-review-marker-"), "installed");
    const install = `gh api -X POST x || true\necho "CI=$CI token=\${GH_TOKEN:-none}" > ${marker}`;
    const repo = makeRepo(synthetic(install), { "src/a.tsx": "export {};\n" });
    const s = stub();
    const result = ok(await review(repo, s));
    expect(result.playwright).toBe("ran");
    expect(readFileSync(marker, "utf8")).toBe("CI=true token=none\n");
    expect(existsSync(join(s.dir, "gh.log"))).toBe(false);
  });

  it("degrades, but still reviews, when the install fails", async () => {
    const repo = makeRepo(synthetic("echo partial\nexit 1"), { "src/a.tsx": "export {};\n" });
    const s = stub();
    const result = ok(await review(repo, s));
    expect(result.playwright).toBe("degraded");
    expect(result.playwrightNote).toBe("dependency install failed (exit 1); the review read the code only");
    expect(argAfter(s, "-p")).toContain("PLAYWRIGHT: no\n");
    expect(result.findings).toEqual(FINDINGS);
  });

  it("posts nothing, even when the model tries gh", async () => {
    const repo = makeRepo(FIXTURE, { "README.md": "changed\n" });
    const s = stub();
    ok(await review(repo, s));
    expect(readFileSync(join(s.dir, "gh-exits"), "utf8")).toBe("api 1\ncomment 1\n");
    expect(readFileSync(join(s.dir, "gh-refused"), "utf8")).toMatch(/disabled/);
    expect(existsSync(join(s.dir, "gh.log"))).toBe(false);
  });

  it("leaves the caller's checkout exactly as it was", async () => {
    const repo = makeRepo(FIXTURE, { "README.md": "changed\n" });
    const before = g(repo, "rev-parse", "HEAD");
    ok(await review(repo, stub()));
    expect(g(repo, "status", "--porcelain")).toBe("");
    expect(worktreeCount(repo)).toBe(1);
    expect(g(repo, "rev-parse", "HEAD")).toBe(before);
  });

  it("keeps the screenshots the review took", async () => {
    const repo = makeRepo(FIXTURE, { "README.md": "changed\n" });
    const s = stub();
    const result = ok(await review(repo, s));
    const shot = join(s.out, "screenshots", "login", "shot.png");
    expect(result.screenshots).toEqual([shot]);
    expect(readFileSync(shot, "utf8")).toBe("PNG");
  });

  it("is unavailable when base has no workflow", async () => {
    const repo = makeRepo(null, { "README.md": "changed\n" });
    expect(reason(await review(repo, stub()))).toBe("no .github/workflows/revision-claude.yml at base");
  });

  it("reviews with a caller's workflow file when the base predates the workflow", async () => {
    const repo = makeRepo(null, { "README.md": "changed\n" });
    const file = join(temp("local-review-wf-"), "revision-claude.yml");
    writeFileSync(file, FIXTURE);
    const s = stub();
    const result = ok(await runLocalReview({ checkout: repo, base: "base", out: s.out, env: s.env, workflowFile: file }));
    expect(result.findings).toEqual(FINDINGS);
    expect(result.workflow).toEqual({ path: ".github/workflows/revision-claude.yml", ref: `file:${file}` });
  });

  it("is unavailable when the caller's workflow file cannot be read", async () => {
    const repo = makeRepo(FIXTURE, { "README.md": "changed\n" });
    const s = stub();
    const missing = join(temp("local-review-wf-"), "absent.yml");
    expect(reason(await runLocalReview({ checkout: repo, base: "base", out: s.out, env: s.env, workflowFile: missing })))
      .toContain(`cannot read the workflow file ${missing}`);
  });

  it("is unavailable when the workflow does not parse", async () => {
    const repo = makeRepo("jobs: [unclosed\n  - : :", { "README.md": "changed\n" });
    expect(reason(await review(repo, stub()))).toMatch(/not valid YAML/);
  });

  it("is unavailable on a bad ref", async () => {
    const repo = makeRepo(FIXTURE, { "README.md": "changed\n" });
    expect(reason(await review(repo, stub(), { head: "no-such-ref" }))).toMatch(/head no-such-ref is not a commit/);
  });

  it("is unavailable when claude exits 1, and still cleans up", async () => {
    const repo = makeRepo(FIXTURE, { "README.md": "changed\n" });
    expect(reason(await review(repo, stub(answer(), 1)))).toBe("review run failed: exit 1");
    expect(worktreeCount(repo)).toBe(1);
  });

  it("is unavailable when claude answers with no json block", async () => {
    const repo = makeRepo(FIXTURE, { "README.md": "changed\n" });
    expect(reason(await review(repo, stub("No encontré nada.")))).toBe("review answered with no findings block");
  });

  it("keeps a finding whose text holds a fenced snippet", async () => {
    const repo = makeRepo(FIXTURE, { "README.md": "changed\n" });
    const fenced = [{ priority: "P2", path: "src/a.ts", line: 4, title: "Fence", text: "Así:\n```ts\nconst a = 1;\n```\nfin." }];
    expect(ok(await review(repo, stub(answer(fenced)))).findings).toEqual(fenced);
  });

  it("reads a finding with no line as line null", async () => {
    const repo = makeRepo(FIXTURE, { "README.md": "changed\n" });
    const noLine = [{ priority: "P2", path: "src/a.ts", title: "t", text: "x" }];
    expect(ok(await review(repo, stub(answer(noLine)))).findings).toEqual([{ ...noLine[0], line: null }]);
  });

  it("is unavailable on an invalid finding or an error result", async () => {
    const repo = makeRepo(FIXTURE, { "README.md": "changed\n" });
    const bad = answer([{ priority: "P4", path: "a", line: 1, title: "t", text: "x" }]);
    expect(reason(await review(repo, stub(bad)))).toMatch(/finding #1 is invalid: priority/);
    expect(reason(await review(repo, stub(answer(), 0, { is_error: true })))).toMatch(/review ended in error/);
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("local-review.ts CLI", () => {
  function cli(s: Stub, ...args: string[]) {
    return spawnSync("bun", ["local-review.ts", ...args], { cwd: import.meta.dirname, env: s.env, encoding: "utf8" });
  }

  it("prints the result as JSON and exits 0", () => {
    const repo = makeRepo(FIXTURE, { "README.md": "changed\n" });
    const s = stub();
    const run = cli(s, "--checkout", repo, "--base", "base", "--out", s.out, "--repo", "o/r");
    expect(run.status).toBe(0);
    expect(ok(JSON.parse(run.stdout) as LocalReviewResult).findings).toEqual(FINDINGS);
    expect(argAfter(s, "-p")).toContain("REPO: o/r\n");
    expect(run.stderr).toContain(s.out);
  });

  it("exits 3 when unavailable and 64 on bad usage", () => {
    const repo = makeRepo(null, { "README.md": "changed\n" });
    const s = stub();
    const unavailable = cli(s, "--checkout", repo, "--base", "base", "--out", s.out);
    expect(unavailable.status).toBe(3);
    expect(JSON.parse(unavailable.stdout)).toMatchObject({ status: "unavailable" });
    const usage = cli(s, "--checkout", repo);
    expect(usage.status).toBe(64);
    expect(usage.stdout).toBe("");
    const file = join(temp("local-review-wf-"), "revision-claude.yml");
    writeFileSync(file, FIXTURE);
    expect(cli(s, "--checkout", repo, "--base", "base", "--out", s.out, "--workflow-file", file).status).toBe(0);
    // setTimeout would clamp a longer timeout to 1 ms.
    expect(cli(s, "--checkout", repo, "--base", "base", "--timeout-minutes", "1441").status).toBe(64);
  });

  it("prints a bare findings array for the fake gh, and fails when unavailable", () => {
    const s = stub();
    const good = cli(s, "--checkout", makeRepo(FIXTURE, { "README.md": "changed\n" }), "--base", "base", "--out", s.out, "--fake-gh-findings");
    expect(good.status).toBe(0);
    expect(JSON.parse(good.stdout)).toEqual(FINDINGS.map(({ text, ...rest }) => ({ ...rest, body: text })));
    const bad = cli(s, "--checkout", makeRepo(null, { "README.md": "changed\n" }), "--base", "base", "--out", s.out, "--fake-gh-findings");
    expect(bad.status).toBe(3);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toContain("no .github/workflows/revision-claude.yml at base");
  });

  it("on SIGTERM kills the review and removes its worktree", async () => {
    const repo = makeRepo(FIXTURE, { "README.md": "changed\n" });
    const s = stub();
    writeFileSync(join(s.dir, "hang"), "");
    const child = spawn("bun", ["local-review.ts", "--checkout", repo, "--base", "base", "--out", s.out], {
      cwd: import.meta.dirname,
      env: s.env,
      stdio: "ignore",
    });
    const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
    const pidFile = join(s.dir, "pid");
    while (!existsSync(pidFile)) await new Promise((r) => setTimeout(r, 25));
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(alive(pid)).toBe(true);
    child.kill("SIGTERM");
    expect(await exited).toBe(143);
    while (alive(pid)) await new Promise((r) => setTimeout(r, 25));
    expect(worktreeCount(repo)).toBe(1);
  });
});
