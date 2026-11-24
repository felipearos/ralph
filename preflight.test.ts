// @vitest-environment node
/**
 * What the startup preflight asks, and what it does with each answer.
 *
 * The preflight exists because the alternative is paying for the answer: a
 * worktree with no `rafa-wip` label, an unauthenticated `gh`, or a `claude`
 * that is not on PATH does not fail as itself — it fails as a full-price
 * orchestrator turn that claimed nothing. So the properties pinned here are
 * the ones that make it worth running at all:
 *
 *   - *Denied and unavailable are different answers.* A missing credential is
 *     refused with a remedy; an unreachable service is a wait. Getting that
 *     backwards is either a supervisor that waits forever on a broken setup,
 *     or a network blip that permanently ends a loop left running overnight.
 *   - *Ambiguity resolves to denied.* One loud message an operator can act on
 *     beats a silent unbounded wait.
 *   - *It is read-only.* Every probe is a read, but for creating a missing
 *     label named in `roles.ts`'s `CREATED_LABELS` (and, on Linear or Jira,
 *     the tracker's `ensureLabels`); a preflight that claimed a ticket would
 *     hand it to a process that has not started yet.
 *   - *It is bounded.* A supervisor started with `nohup` has no terminal, so
 *     an unbounded probe is indistinguishable from a running loop.
 *
 * The end-to-end cases drive the REAL `ralph/preflight.ts` against fake `gh`,
 * `doppler`, `git`, `claude`, `python3` and `uuidgen` binaries on PATH: the
 * seams this file depends on are subprocesses, and a fake binary tests the
 * seam where a mock would test the mock. Nothing here touches GitHub, Doppler,
 * or git.
 *
 * Prerequisites, and they are the loop's own: `bun` on PATH, and
 * `RALPH_LOOP_NAME` set to a name the claim fence reads (`ralph.sh` exports
 * it; these tests pass it explicitly, as a hand-run preflight must).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyVerdicts,
  checkActionsLogs,
  checkBuildkiteLogs,
  checkBuildkiteRetry,
  checkClerkCredentials,
  checkClerkIntakeBoard,
  checkExecutorTools,
  checkFrontierPrerequisites,
  checkLogsWritable,
  checkProjectConfig,
  checkRepositoryState,
  checkVerifierCredentials,
  checkVerifierDeploySource,
  classifyFailure,
  HARNESS_FILES,
  missingLabels,
  report,
  requiredLabels,
  requiredLabelsFor,
  resolveLoopName,
  summarize,
  roleFor,
  roleLabels,
  type CheckResult,
} from "./preflight";
import { parseProjectConfig, type ProjectConfig } from "./project-config";
import { INTAKE_WORKFLOW, fakeJira } from "./clerk/fakes";
import { jiraClient } from "./clerk/jira";
import { CREATED_LABELS, PREFLIGHT_CHECKS, ROLE_DESCRIPTORS, TRIAGE_LABELS, without, type PreflightCheck } from "./roles";
import type { LoopName } from "./frontier/next-tasks";
import { subprocessSuite } from "./test-timeouts";
import { keyedTriagerLabels } from "./triage/intake";

subprocessSuite("runs preflight through bash and bun");

const REPO_ROOT = __dirname;

const scratchRoots: string[] = [];
afterAll(() => scratchRoots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const writeExecutable = (path: string, lines: string[]): void => {
  writeFileSync(path, [...lines, ""].join("\n"));
  chmodSync(path, 0o755);
};

/** The bun that is running this suite, by absolute path — PATH is replaced. */
const BUN = ((): string => {
  try {
    return execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
  } catch {
    return process.execPath;
  }
})();

interface Fakes {
  bin: string;
  /** Every argv the fake `gh` and `git` saw, one per line. */
  calls: () => string[];
}

/**
 * A PATH holding nothing but stand-ins, so a tool can be made missing by
 * leaving it out. Each fake is steered by environment variables and records
 * what it was asked, which is how the read-only property is asserted.
 */
function fakes(options: { omit?: string[] } = {}): Fakes {
  const root = mkdtempSync(join(tmpdir(), "loggd-preflight-"));
  scratchRoots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const callsFile = join(root, "calls.log");
  writeFileSync(callsFile, "");
  const omit = new Set(options.omit ?? []);

  const install = (name: string, lines: string[]): void => {
    if (omit.has(name)) return;
    const record = `printf '%s %s\\n' ${JSON.stringify(name)} "$*" >> ${JSON.stringify(callsFile)}`;
    writeExecutable(join(bin, name), ["#!/bin/sh", record, ...lines]);
  };

  // The repository's labels, in a file rather than inline: a JSON default
  // nested inside `${VAR:-…}` inside a shell string is one quoting layer too
  // many, and it fails as a preflight bug rather than as a broken fake.
  const labelsFile = join(root, "labels.json");
  writeFileSync(
    labelsFile,
    // Trailing newline on purpose: `read` drops a final line without one.
    `${JSON.stringify(
      [...requiredLabels("ralph"), ...requiredLabels("rafa"), "migration-applied"].map((name) => ({ name })),
    )}\n`,
  );

  install("gh", [
    'if [ "$1 $2" = "auth status" ]; then',
    '  [ -n "${FAKE_GH_AUTH_ERROR:-}" ] && { printf \'%s\\n\' "$FAKE_GH_AUTH_ERROR" >&2; exit 1; }',
    // A hang with no `sleep` to reach: PATH holds nothing but these fakes, so
    // the wait has to be built out of shell builtins. The preflight's own
    // timeout is what ends it.
    '  [ -n "${FAKE_GH_AUTH_HANG:-}" ] && { while :; do :; done; }',
    "  exit 0",
    "fi",
    'if [ "$1 $2" = "label list" ]; then',
    '  [ -n "${FAKE_GH_NOISE:-}" ] && printf \'%s\\n\' "$FAKE_GH_NOISE" >&2',
    '  [ -n "${FAKE_GH_LABEL_ERROR:-}" ] && { printf \'%s\\n\' "$FAKE_GH_LABEL_ERROR" >&2; exit 1; }',
    '  if [ -n "${FAKE_GH_LABELS:-}" ]; then printf \'%s\\n\' "$FAKE_GH_LABELS"; exit 0; fi',
    // `read`, not `cat`: PATH is fakes-only, so every external command a fake
    // reaches for is one more thing that can fail as a preflight bug.
    `  while IFS= read -r line; do printf '%s\\n' "$line"; done < ${JSON.stringify(labelsFile)}`,
    "  exit 0",
    "fi",
    // A repository that refuses label creation: how a test pins a role
    // label's denial now that preflight creates the ones it can.
    'if [ "$1 $2" = "label create" ]; then',
    '  [ -n "${FAKE_GH_LABEL_CREATE_ERROR:-}" ] && { printf \'%s\\n\' "$FAKE_GH_LABEL_CREATE_ERROR" >&2; exit 1; }',
    "  exit 0",
    "fi",
    "exit 0",
  ]);
  install("doppler", [
    '[ -n "${FAKE_DOPPLER_ERROR:-}" ] && { printf \'%s\\n\' "$FAKE_DOPPLER_ERROR" >&2; exit 1; }',
    'printf \'%s\\n\' "[]"',
    "exit 0",
  ]);
  install("git", [
    'case "$1 $2" in',
    '  "rev-parse --git-dir") [ -n "${FAKE_NOT_A_REPO:-}" ] && exit 1; echo .git; exit 0 ;;',
    "esac",
    'case "$2" in',
    '  --verify) [ -n "${FAKE_NO_ORIGIN_MAIN:-}" ] && exit 1; echo aaaa111; exit 0 ;;',
    "esac",
    "exit 0",
  ]);
  install("claude", ["exit 0"]);
  install("codex", ["exit 0"]);
  install("python3", ["exit 0"]);
  install("uuidgen", ["echo 00000000-0000-4000-8000-000000000000"]);

  return {
    bin,
    calls: () => readFileSync(callsFile, "utf8").split("\n").filter(Boolean),
  };
}

/** A repository whose labels this token may read but not create. */
const CREATE_REFUSED = { FAKE_GH_LABEL_CREATE_ERROR: "HTTP 403: Resource not accessible by integration" };

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
  verdict: string;
  checks: CheckResult[];
}

/** Loggd's `.ralph/config.json`, which the scratch project commits. */
const LOGGD_CONFIG = {
  repo: "felipearos/loggd",
  owner: "felipearosr",
  baseBranch: "main",
  displayName: "Loggd",
  secrets: {
    runner: "doppler",
    project: "loggd-web",
    config: "dev",
    withhold: ["PRODUCTION_MIGRATIONS_DATABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
  },
  refuseFiles: [".env.local"],
  envCheck: ["bun", "--no-env-file", "scripts/check-loop-env.ts"],
  requiredChecks: ["buildkite/loggd", "Vercel"],
  gates: { test: "bun run test" },
  promptFragment: ".ralph/prompt.md",
  coderFragment: ".ralph/coder.md",
  plan: ".ralph/plan.md",
  journal: { dir: "journal/loggd" },
  loops: ["ralph", "rafa", "remo", "rulo"],
};

/** A project worktree with loggd's config, its fragments, plan and logs dir. */
function scratchProject(config: unknown = LOGGD_CONFIG): string {
  const root = mkdtempSync(join(tmpdir(), "loggd-preflight-project-"));
  scratchRoots.push(root);
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  writeFileSync(join(root, ".ralph", "config.json"), JSON.stringify(config));
  for (const file of ["prompt.md", "coder.md", "plan.md"]) writeFileSync(join(root, ".ralph", file), "x\n");
  return root;
}

function runPreflight(fake: Fakes, env: Record<string, string> = {}, project: string = scratchProject()): Ran {
  const result = spawnSync(BUN, [join(REPO_ROOT, "preflight.ts"), "--json"], {
    cwd: project,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: fake.bin,
      RALPH_LOOP_NAME: "ralph",
      RALPH_PROJECT: project,
      // What ralph.sh exports once `bk-log.ts --check-token` passed.
      RALPH_BUILDKITE_READ_TOKEN: "read-only-token",
      ...env,
    },
  });
  let parsed: { verdict: string; checks: CheckResult[] } = { verdict: "", checks: [] };
  try {
    parsed = JSON.parse(result.stdout) as typeof parsed;
  } catch {
    // A non-JSON run is a broken preflight; `status` is what the test asserts.
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
    verdict: parsed.verdict,
    checks: parsed.checks,
  };
}

const check = (run: Ran, name: PreflightCheck): CheckResult | undefined =>
  run.checks.find((result) => result.name === name);

describe("one verdict from many checks", () => {
  // Real check names: `CheckResult.name` is the one vocabulary a role's list
  // is a subset of, so a synthetic "a" is no longer a thing a result can be.
  const ok = (name: PreflightCheck): CheckResult => ({ name, outcome: { status: "ok" } });
  const denied = (name: PreflightCheck): CheckResult => ({
    name,
    outcome: { status: "denied", why: "no", remedy: "do this" },
  });
  const unavailable = (name: PreflightCheck): CheckResult => ({
    name,
    outcome: { status: "unavailable", why: "unreachable" },
  });

  it("is ready only when every check passed", () => {
    expect(summarize([ok("tools"), ok("logs-writable")])).toBe("ready");
  });

  it("lets a denied requirement outrank an unavailable service", () => {
    // A worktree with no label AND an unreachable GitHub is a broken setup,
    // not a waiting loop: waiting would hide it for as long as the operator
    // left the loop running.
    expect(summarize([unavailable("github-credentials"), denied("loop-labels")])).toBe("denied");
  });

  it("waits when nothing is denied but something could not be reached", () => {
    expect(summarize([ok("tools"), unavailable("github-credentials")])).toBe("unavailable");
  });

  it("prints the remedy with the failure, because the message is the product", () => {
    const lines = report([denied("loop-labels")], "denied");
    expect(lines[0]).toContain("loop-labels");
    expect(lines[1]).toContain("do this");
    expect(lines.at(-1)).toContain("refusing to start");
  });

  it("starts past a warning, and says so", () => {
    const warn: CheckResult = { name: "buildkite-logs", outcome: { status: "warn", why: "no token", remedy: "add one" } };
    expect(summarize([ok("tools"), warn])).toBe("ready");
    const lines = report([ok("tools"), warn], "ready");
    expect(lines[0]).toBe("preflight: buildkite-logs — no token (warning, not fatal)");
    expect(lines[1]).toContain("add one");
    expect(lines.at(-1)).toBe("preflight: ready — 1 checks passed, 1 warning");
  });

  it("says nothing was claimed when it is only waiting", () => {
    expect(report([unavailable("doppler-scope")], "unavailable").at(-1)).toContain(
      "nothing has been claimed",
    );
  });
});

describe("telling a denial from an outage", () => {
  it.each([
    "error connecting to api.github.com",
    "dial tcp: lookup api.github.com: no such host (EAI_AGAIN)",
    "HTTP 503: Service Unavailable",
    "You have exceeded a secondary rate limit. Please wait a few minutes",
    "connection refused",
  ])("reads %s as unavailable", (output) => {
    expect(classifyFailure(output)).toBe("unavailable");
  });

  it.each([
    "You are not logged into any GitHub hosts. To log in, run: gh auth login",
    "Doppler Error: you must specify a project",
    "HTTP 401: Bad credentials",
  ])("reads %s as denied", (output) => {
    expect(classifyFailure(output)).toBe("denied");
  });

  it("reads a probe that said nothing as denied, not as an outage", () => {
    // The two mistakes are not symmetrical: a denial misread as unavailable is
    // a supervisor that waits forever in silence.
    expect(classifyFailure("")).toBe("denied");
  });

  it("reads a probe that ran out of time as unavailable", () => {
    expect(classifyFailure("", true)).toBe("unavailable");
  });
});

describe("the labels a loop cannot claim without", () => {
  it("names all three, per loop", () => {
    expect(requiredLabels("rafa")).toEqual(["rafa-wip", "rafa-blocked", "rafa-done"]);
  });

  it("reports exactly the ones the repository is missing", () => {
    expect(missingLabels("rafa", ["rafa-wip", "ralph-done"])).toEqual([
      "rafa-blocked",
      "rafa-done",
    ]);
  });

  it("matches the way GitHub does, case-insensitively", () => {
    expect(missingLabels("ralph", ["Ralph-WIP", "ralph-blocked", "ralph-done"])).toEqual([]);
  });

  it("ignores the other loop's labels entirely", () => {
    expect(missingLabels("rafa", requiredLabels("ralph"))).toEqual(requiredLabels("rafa"));
  });
});

describe("the loop identity a claim would carry", () => {
  // The fence reads the project's roster; this suite runs from the harness
  // checkout, which is no project, so it points at loggd's.
  beforeAll(() => {
    process.env.RALPH_PROJECT = scratchProject();
  });
  afterAll(() => {
    delete process.env.RALPH_PROJECT;
  });

  it("accepts a name the claim fence reads", () => {
    expect(resolveLoopName("rafa")).toBe("rafa");
  });

  it.each([undefined, "", "ralphie"])("refuses %s", (raw) => {
    expect(resolveLoopName(raw)).toBeNull();
  });
});

describe("the preflight end to end", () => {
  it("is ready when every prerequisite answers", () => {
    const run = runPreflight(fakes());

    expect(run.status).toBe(0);
    expect(run.verdict).toBe("ready");
    expect(run.checks.every((result) => result.outcome.status === "ok")).toBe(true);
  });

  it("asks a coder every check in the vocabulary but the doctor's and the clerk's own, in the vocabulary's order", () => {
    // The other direction of the type: `PreflightCheck` stops a role naming a
    // check that does not exist, but nothing stops the VOCABULARY naming one
    // that nothing produces — and such a name is expressible dead
    // configuration, since `runs()` would answer true for a branch that is not
    // there. So each role's run is pinned to the names it should produce, order
    // included, with the exception spelled as a literal here rather than read
    // back from the descriptor: a dead vocabulary name, a check that stops
    // being produced, and an edit to either role's `checks:` list all fail.
    //
    // `buildkite-retry` is the one name a coder cannot produce. It is in the
    // coder's declared list — every role's list is the whole vocabulary minus
    // what it deliberately drops — but `checkBuildkiteRetry` answers null for a
    // role that declares no retry token, which is what makes #158 AC 3 ("a
    // coder's results are unchanged") true without the coder refusing a check.
    //
    // `clerk-credentials` is the same kind of name: every role but the clerk
    // declares no `RALPH_CLERK_*` secret, so it answers null for them; and
    // `verifier-credentials` answers null for every role but a verifier.
    const coder = runPreflight(fakes()).checks.map((result) => result.name);

    // `clerk-intake-board` likewise answers null for every role but a clerk.
    expect(coder).toEqual(without("buildkite-retry", "clerk-credentials", "verifier-credentials", "clerk-intake-board"));

    const project = scratchProject({ ...LOGGD_CONFIG, loops: ["ralph", { name: "doct", role: "ci-doctor" }] });
    const labels = JSON.stringify(requiredLabels("doct", ["ci-health", "priority:urgent"]).map((name) => ({ name })));
    const doctor = runPreflight(fakes(), { RALPH_LOOP_NAME: "doct", FAKE_GH_LABELS: labels }, project).checks.map(
      (result) => result.name,
    );

    expect(doctor).toEqual(without("frontier-prerequisites", "clerk-credentials", "verifier-credentials", "clerk-intake-board"));
  });

  it("refuses a coder's missing claim label in the words the checklist quotes", () => {
    // `adding-an-agent.md` §6 quotes this line verbatim, and AC 1 is that a
    // coder's results are unchanged. Without this, rewording it — or flipping
    // the role branch's polarity — passes the suite and falsifies the doc.
    const run = runPreflight(fakes(), { RALPH_LOOP_NAME: "rafa", FAKE_GH_LABELS: '[{"name":"ralph-wip"}]' });
    expect((check(run, "loop-labels")!.outcome as { why: string }).why).toBe(
      "the repository has no rafa-wip, rafa-blocked, rafa-done label, so this loop could claim nothing",
    );
  });

  it("warns, but starts, when iterations could not read Buildkite logs", () => {
    const run = runPreflight(fakes(), { RALPH_BUILDKITE_READ_TOKEN: "" });
    expect(run.status).toBe(0);
    expect(run.verdict).toBe("ready");
    const outcome = check(run, "buildkite-logs")!.outcome as { status: string; remedy: string };
    expect(outcome.status).toBe("warn");
    expect(outcome.remedy).toContain("RALPH_BUILDKITE_READ_TOKEN in Doppler loggd-web/dev");
    // With the token: ok, asked offline (ralph.sh proved it read-only before
    // exporting it), and its value appears nowhere in the output.
    const fake = fakes();
    const armed = runPreflight(fake);
    expect(check(armed, "buildkite-logs")!.outcome.status).toBe("ok");
    expect(armed.stdout + armed.stderr).not.toContain("read-only-token");
    expect(fake.calls().some((call) => /buildkite|curl/.test(call))).toBe(false);
  });

  it("asks nothing about Buildkite of a project without a Buildkite check", () => {
    const run = runPreflight(fakes(), { RALPH_BUILDKITE_READ_TOKEN: "" }, scratchProject({ ...LOGGD_CONFIG, requiredChecks: ["ci"] }));
    expect(run.status).toBe(0);
    expect(check(run, "buildkite-logs")).toBeUndefined();
  });

  it("requires Codex instead of Claude for a Codex orchestrator", () => {
    const run = runPreflight(fakes({ omit: ["claude"] }), {
      RALPH_RUNNER_ORCHESTRATOR: "codex", RALPH_MODEL_ORCHESTRATOR: "gpt-5.6-terra",
    });
    expect(run.status).toBe(0);
    const missing = runPreflight(fakes({ omit: ["codex"] }), {
      RALPH_RUNNER_ORCHESTRATOR: "codex", RALPH_MODEL_ORCHESTRATOR: "gpt-5.6-terra",
    });
    expect(missing.status).toBe(1);
    expect(JSON.stringify(check(missing, "tools"))).toContain("not on PATH: codex");
  });

  it("never writes but to create a missing migration-applied — every other probe is a read", () => {
    // The allowlist IS the read-only property: a claim, any other label
    // creation, or a pull request would all have to appear here first. The
    // second run is the one where the create happens, so the one write the
    // allowlist admits is exercised rather than merely permitted.
    const { color, description } = CREATED_LABELS["migration-applied"]!;
    const create = `gh label create migration-applied --color ${color} --description ${description}`;
    const reads = /^(gh auth status|gh label list --limit \d+ --json name|gh api repos\/felipearos\/loggd\/actions\/runs\?per_page=1|doppler secrets --only-names --json -p loggd-web -c dev|git rev-parse( --verify --quiet origin\/main| --git-dir))$/;

    const ready = fakes();
    runPreflight(ready);
    for (const call of ready.calls()) expect(call).toMatch(reads);
    expect(ready.calls().length).toBeGreaterThan(0);

    const creating = fakes();
    runPreflight(creating, { RALPH_LOOP_NAME: "rafa", FAKE_GH_LABELS: JSON.stringify(requiredLabels("rafa").map((name) => ({ name }))) });
    for (const call of creating.calls()) {
      if (call !== create) expect(call).toMatch(reads);
    }
    expect(creating.calls()).toContain(create);
  });

  it("refuses a missing label with the command that creates it", () => {
    const run = runPreflight(fakes(), {
      RALPH_LOOP_NAME: "rafa",
      FAKE_GH_LABELS: '[{"name":"rafa-wip"},{"name":"ralph-done"}]',
    });

    expect(run.status).toBe(1);
    expect(run.verdict).toBe("denied");
    const labels = check(run, "loop-labels")!.outcome as { why: string; remedy: string };
    expect(labels.why).toContain("rafa-blocked");
    expect(labels.remedy).toContain("gh label create rafa-blocked");
  });

  it("creates a missing role label rather than refusing the start", () => {
    // #432: a coder's `migration-applied` is declared after loops already run,
    // so every GitHub coder would otherwise refuse its next start overnight.
    const fake = fakes();
    const run = runPreflight(fake, { RALPH_LOOP_NAME: "rafa", FAKE_GH_LABELS: JSON.stringify(requiredLabels("rafa").map((name) => ({ name }))) });

    expect(fake.calls().some((call) => call.startsWith("gh label create migration-applied --color 0e8a16 --description "))).toBe(true);
    expect(check(run, "loop-labels")!.outcome).toEqual({ status: "ok", detail: "rafa-wip rafa-blocked rafa-done migration-applied" });
  });

  it("refuses a role label it could not create, with the command that creates it", () => {
    const run = runPreflight(fakes(), {
      RALPH_LOOP_NAME: "rafa",
      ...CREATE_REFUSED,
      FAKE_GH_LABELS: JSON.stringify(requiredLabels("rafa").map((name) => ({ name }))),
    });

    expect(run.status).toBe(1);
    const labels = check(run, "loop-labels")!.outcome as { status: string; why: string; remedy: string };
    expect(labels.status).toBe("denied");
    expect(labels.why).toBe("the repository has no migration-applied label, so this loop could not label its work as a coder");
    expect(labels.remedy).toBe("gh label create migration-applied");
  });

  it("waits, rather than refuses, when the create cannot reach GitHub", () => {
    // A network blip is not a broken setup: denied would end a loop left
    // running overnight over a label it could have created a minute later.
    const run = runPreflight(fakes(), {
      RALPH_LOOP_NAME: "rafa",
      FAKE_GH_LABEL_CREATE_ERROR: "error connecting to api.github.com: dial tcp: i/o timeout",
      FAKE_GH_LABELS: JSON.stringify(requiredLabels("rafa").map((name) => ({ name }))),
    });

    expect(check(run, "loop-labels")!.outcome.status).toBe("unavailable");
  });

  it("never creates the loop's own claim labels", () => {
    const fake = fakes();
    const run = runPreflight(fake, { RALPH_LOOP_NAME: "rafa", FAKE_GH_LABELS: "[]" });

    const labels = check(run, "loop-labels")!.outcome as { status: string; why: string; remedy: string };
    expect(labels.status).toBe("denied");
    expect(labels.remedy).toBe("gh label create rafa-wip && gh label create rafa-blocked && gh label create rafa-done");
    expect(fake.calls().filter((call) => call.startsWith("gh label create")).map((call) => call.split(" ")[3])).toEqual(["migration-applied"]);
  });

  it("refuses an unauthenticated GitHub CLI", () => {
    const run = runPreflight(fakes(), {
      FAKE_GH_AUTH_ERROR: "You are not logged into any GitHub hosts. To log in, run: gh auth login",
    });

    expect(run.status).toBe(1);
    expect(run.verdict).toBe("denied");
    expect((check(run, "github-credentials")!.outcome as { remedy: string }).remedy).toBe(
      "gh auth login",
    );
  });

  it("waits, rather than refusing, when GitHub cannot be reached", () => {
    const run = runPreflight(fakes(), {
      FAKE_GH_AUTH_ERROR: "error connecting to api.github.com: dial tcp: lookup api.github.com",
    });

    expect(run.status).toBe(2);
    expect(run.verdict).toBe("unavailable");
    expect(check(run, "github-credentials")!.outcome.status).toBe("unavailable");
  });

  it("asks for no Doppler at all when the project has no secrets manager", () => {
    const fake = fakes({ omit: ["doppler"] });
    const run = runPreflight(
      fake,
      {},
      scratchProject({ ...LOGGD_CONFIG, secrets: { runner: "none", withhold: [] } }),
    );
    expect(run.status).toBe(0);
    expect(check(run, "doppler-scope")).toBeUndefined();
    expect(fake.calls().some((call) => call.startsWith("doppler"))).toBe(false);
  });

  it("refuses a project with no valid .ralph/config.json before asking anything remote", () => {
    const fake = fakes();
    const project = scratchProject();
    writeFileSync(join(project, ".ralph", "config.json"), JSON.stringify({ ...LOGGD_CONFIG, withold: [] }));
    const run = runPreflight(fake, {}, project);
    expect(run.status).toBe(1);
    expect((check(run, "project-config")!.outcome as { why: string }).why).toContain("unknown key 'withold'");
  });

  it("refuses an unscoped worktree but waits out a Doppler outage", () => {
    const unscoped = runPreflight(fakes(), {
      FAKE_DOPPLER_ERROR: "Doppler Error: you must specify a project",
    });
    expect(unscoped.status).toBe(1);
    expect((check(unscoped, "doppler-scope")!.outcome as { remedy: string }).remedy).toContain(
      "doppler setup",
    );

    const outage = runPreflight(fakes(), {
      FAKE_DOPPLER_ERROR: "Doppler Error: HTTP 503 Service Unavailable",
    });
    expect(outage.status).toBe(2);
    expect(check(outage, "doppler-scope")!.outcome.status).toBe("unavailable");
  });

  it("waits out a Doppler failure that names no denial, and refuses an expired login with its output", () => {
    // 2026-10-21: a boot-time output matched no pattern and seven loops
    // stopped as denied. Unrecognised Doppler output is a wait.
    const unknown = runPreflight(fakes(), {
      FAKE_DOPPLER_ERROR: "Doppler Error: unexpected end of JSON input",
    });
    expect(unknown.status).toBe(2);
    const waiting = check(unknown, "doppler-scope")!.outcome as { status: string; why: string };
    expect(waiting.status).toBe("unavailable");
    expect(waiting.why).toContain("unexpected end of JSON input");

    const expired = runPreflight(fakes(), {
      FAKE_DOPPLER_ERROR: "Doppler Error:\n   Unauthorized: token has expired",
    });
    expect(expired.status).toBe(1);
    const denied = check(expired, "doppler-scope")!.outcome as { status: string; why: string; remedy: string };
    expect(denied.status).toBe("denied");
    expect(denied.remedy).toMatch(/doppler (login|setup)/);
    expect(denied.why).toContain("missing access or expired auth");
    expect(denied.why).toContain("Doppler Error: Unauthorized: token has expired");
  });

  it("also writes the verdict to RALPH_PREFLIGHT_JSON for the supervisor", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-preflight-json-"));
    try {
      const path = join(dir, "preflight.json");
      const run = runPreflight(fakes(), {
        FAKE_DOPPLER_ERROR: "Doppler Error: HTTP 503 Service Unavailable",
        RALPH_PREFLIGHT_JSON: path,
      });
      expect(run.status).toBe(2);
      const written = JSON.parse(readFileSync(path, "utf8")) as { verdict: string; checks: CheckResult[] };
      expect(written.verdict).toBe("unavailable");
      expect(written.checks.map((c) => c.name)).toEqual(run.checks.map((c) => c.name));
      expect(written.checks.find((c) => c.name === "doppler-scope")!.outcome.status).toBe("unavailable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a loop identity no claim fence reads, without asking GitHub about it", () => {
    const fake = fakes();
    const run = runPreflight(fake, { RALPH_LOOP_NAME: "ralphie" });

    expect(run.status).toBe(1);
    expect((check(run, "loop-identity")!.outcome as { why: string }).why).toContain("ralphie");
    expect(fake.calls().filter((call) => call.startsWith("gh label list"))).toHaveLength(0);
  });

  it("names the missing CLI rather than blaming the service it would have called", () => {
    const fake = fakes({ omit: ["claude"] });
    // Pin the orchestrator: a Codex-hosted lineup needs codex, not claude.
    const run = runPreflight(fake, { RALPH_RUNNER_ORCHESTRATOR: "claude" });

    expect(run.status).toBe(1);
    expect((check(run, "tools")!.outcome as { why: string }).why).toContain("claude");
    // The network probes never ran: "not authenticated" would be the wrong
    // answer to "there is no gh on this PATH".
    expect(fake.calls().filter((call) => call.startsWith("gh "))).toHaveLength(0);
    expect(check(run, "github-credentials")).toBeUndefined();
  });

  it("refuses a missing stream renderer runtime before starting Claude", () => {
    const run = runPreflight(fakes({ omit: ["python3"] }));

    expect(run.status).toBe(1);
    expect((check(run, "tools")!.outcome as { why: string }).why).toContain("python3");
  });

  it("keeps a CLI's chatter out of what it parses", () => {
    // `gh` writes its new-release notice to stderr on a SUCCESSFUL command. A
    // preflight that parsed both streams would refuse a perfectly healthy
    // setup on any machine with an outdated `gh`.
    const run = runPreflight(fakes(), {
      FAKE_GH_NOISE: "A new release of gh is available: 2.40.0 → 2.62.0",
    });

    expect(run.status).toBe(0);
    expect(check(run, "loop-labels")!.outcome.status).toBe("ok");
  });

  it("reads a permission denial as denied even though gh names the API host", () => {
    // `gh` prints `https://api.github.com/…` in an ordinary 403, so the host
    // alone must never be the thing that starts an unbounded wait.
    const run = runPreflight(fakes(), {
      FAKE_GH_LABEL_ERROR:
        "HTTP 403: Resource not accessible by integration (https://api.github.com/repos/loggd/loggd/labels)",
    });

    expect(run.status).toBe(1);
    expect(check(run, "loop-labels")!.outcome.status).toBe("denied");
  });

  it("is bounded, so a probe that hangs cannot look like a running loop", () => {
    const started = Date.now();
    const run = runPreflight(fakes(), {
      FAKE_GH_AUTH_HANG: "1",
      RALPH_PREFLIGHT_TIMEOUT_MS: "1500",
    });

    // The hang is killed and reported as unavailable — the operator's setup is
    // not what failed.
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(run.status).toBe(2);
    expect(check(run, "github-credentials")!.outcome.status).toBe("unavailable");
  });
});

/**
 * The three checks that read the worktree rather than a service. Driven
 * in-process against a scratch directory, because what they answer about is
 * the current directory itself — the states below are exactly the ones a
 * worktree three commits behind, or one created without `.ralph/logs`, arrives
 * in, and every one of them used to surface mid-iteration instead.
 */
describe("the checks that read the worktree", () => {
  const inDirectory = async <T>(
    dir: string,
    env: Record<string, string>,
    body: () => Promise<T>,
  ): Promise<T> => {
    const cwd = process.cwd();
    const path = process.env.PATH;
    Object.assign(process.env, env);
    process.chdir(dir);
    try {
      return await body();
    } finally {
      process.chdir(cwd);
      process.env.PATH = path;
      for (const name of Object.keys(env)) delete process.env[name];
    }
  };

  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "loggd-preflight-tree-"));
    scratchRoots.push(dir);
    return dir;
  };

  it("refuses a worktree with nowhere to write this run's logs", async () => {
    const dir = scratch();
    const absent = await inDirectory(dir, {}, checkLogsWritable);
    expect(absent.outcome.status).toBe("denied");
    expect((absent.outcome as { remedy: string }).remedy).toContain("mkdir -p .ralph/logs");

    mkdirSync(join(dir, ".ralph", "logs"), { recursive: true });
    expect((await inDirectory(dir, {}, checkLogsWritable)).outcome.status).toBe("ok");
  });

  it("refuses a logs path that is a file rather than a directory", async () => {
    const dir = scratch();
    mkdirSync(join(dir, ".ralph"));
    writeFileSync(join(dir, ".ralph", "logs"), "");

    const result = await inDirectory(dir, {}, checkLogsWritable);
    expect(result.outcome.status).toBe("denied");
    expect((result.outcome as { why: string }).why).toContain("not a directory");
  });

  it("refuses somewhere that is not a git worktree at all", async () => {
    const fake = fakes();
    const result = await inDirectory(
      scratch(),
      { PATH: fake.bin, FAKE_NOT_A_REPO: "1" },
      checkRepositoryState,
    );

    expect(result.outcome.status).toBe("denied");
    expect((result.outcome as { why: string }).why).toContain("not a git worktree");
  });

  it("refuses a worktree that has never heard of origin/main", async () => {
    // `prompt.md` works from `origin/<base>` throughout and the gate fences from
    // `origin/<base>:.ralph/plan.md`, so this is not a stale base — it is every
    // base read failing.
    const fake = fakes();
    const result = await inDirectory(
      scratch(),
      { PATH: fake.bin, FAKE_NO_ORIGIN_MAIN: "1" },
      checkRepositoryState,
    );

    expect(result.outcome.status).toBe("denied");
    expect((result.outcome as { remedy: string }).remedy).toContain("git fetch origin main");
  });

  it("names the harness files an old harness checkout is missing", async () => {
    const home = scratch();
    const missing = await checkFrontierPrerequisites(null, home);
    expect(missing.outcome.status).toBe("denied");
    expect((missing.outcome as { why: string }).why).toContain(join(home, "frontier-gate.ts"));
    expect((missing.outcome as { why: string }).why).toContain(join(home, "frontier", "next-tasks.ts"));
    expect((missing.outcome as { remedy: string }).remedy).toContain(`git -C ${home} pull`);

    mkdirSync(join(home, "frontier"));
    mkdirSync(join(home, "prompts"));
    // Seeded from the list itself: a file added there — a new role's prompt
    // template, say — must make an old checkout report staleness, and a
    // hand-copied list here would quietly stop testing that.
    for (const file of HARNESS_FILES) writeFileSync(join(home, file), "");
    expect((await checkFrontierPrerequisites(null, home)).outcome.status).toBe("ok");
  });

  it("names the project files its config points at when they are missing", async () => {
    const dir = scratch();
    const config = { ...LOGGD_CONFIG, secrets: { runner: "none" as const, withhold: [] }, loops: ["ralph"], roster: [{ name: "ralph", role: "coder" as const }], learnings: { file: "learnings/loggd.md" }, tracker: { kind: "github" as const }, merge: "loop" as const, worktreeSetup: [] };
    const missing = await inDirectory(dir, {}, () =>
      checkFrontierPrerequisites(config as Parameters<typeof checkFrontierPrerequisites>[0]),
    );
    expect(missing.outcome.status).toBe("denied");
    expect((missing.outcome as { why: string }).why).toContain(".ralph/prompt.md");
    expect((missing.outcome as { why: string }).why).toContain(".ralph/plan.md");

    mkdirSync(join(dir, ".ralph"));
    for (const file of ["prompt.md", "coder.md", "plan.md"]) writeFileSync(join(dir, ".ralph", file), "");
    expect(
      (await inDirectory(dir, {}, () =>
        checkFrontierPrerequisites(config as Parameters<typeof checkFrontierPrerequisites>[0]),
      )).outcome.status,
    ).toBe("ok");
  });
});

/**
 * The tools a brief tells the executor to run. On 2026-09-23 the Codex
 * sandbox had `bun` and no `bunx`, and four of five overnight runs lost steps
 * to `bunx: command not found` before switching spelling. The preflight asks
 * the executor's own environment, so a regression refuses startup instead.
 */
describe("the tool shims the executor runs briefs with", () => {
  const scratchBin = (tools: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "loggd-preflight-shims-"));
    scratchRoots.push(dir);
    for (const [name, body] of Object.entries(tools)) writeExecutable(join(dir, name), ["#!/bin/sh", body]);
    return dir;
  };

  const withPath = async <T>(path: string, body: () => Promise<T>): Promise<T> => {
    const saved = process.env.PATH;
    process.env.PATH = path;
    try {
      return await body();
    } finally {
      process.env.PATH = saved;
    }
  };

  it("refuses a runner PATH that has bun but no bunx", async () => {
    const bin = scratchBin({ bun: "exit 0" });
    const result = await withPath(bin, () => checkExecutorTools("opencode"));

    expect(result.outcome.status).toBe("denied");
    expect((result.outcome as { why: string }).why).toContain("bunx");
  });

  it("accepts a runner PATH with every shim beside its runtime, or no runtime at all", async () => {
    const all = scratchBin({ bun: "exit 0", bunx: "exit 0", node: "exit 0", npm: "exit 0", npx: "exit 0" });
    expect((await withPath(all, () => checkExecutorTools("claude"))).outcome.status).toBe("ok");
    expect((await withPath(scratchBin({}), () => checkExecutorTools("opencode"))).outcome.status).toBe("ok");
  });

  it("asks the Codex sandbox itself, and refuses with what it could not resolve", async () => {
    const bin = scratchBin({ bwrap: "exit 0" });
    const failing = scratchBin({
      probe: "echo 'ok bun /ralph-runtimes/bun'; echo 'missing bunx: not on the executor PATH'; exit 1",
    });
    const result = await withPath(bin, () => checkExecutorTools("codex", [join(failing, "probe")]));

    expect(result.outcome.status).toBe("denied");
    expect((result.outcome as { why: string }).why).toContain("missing bunx");
    expect((result.outcome as { remedy: string }).remedy).toContain("--probe-tools");

    const passing = scratchBin({ probe: "echo 'ok bunx /ralph-runtimes/bunx'; exit 0" });
    expect(
      (await withPath(bin, () => checkExecutorTools("codex", [join(passing, "probe")]))).outcome.status,
    ).toBe("ok");
  });

  it("leaves a Codex executor with no bubblewrap to delegate.sh, which degrades on it", async () => {
    const failing = scratchBin({ probe: "exit 1" });
    const result = await withPath(scratchBin({}), () => checkExecutorTools("codex", [join(failing, "probe")]));
    expect(result.outcome.status).toBe("ok");
  });
});

/* --------------------------------------------------------------------------
 * The checks and labels each ROLE is held to (#136).
 * ----------------------------------------------------------------------- */

describe("the labels a role needs beyond its own three", () => {
  it("gives a coder only migration-applied, whatever the project routes by", () => {
    // AC 1, at the label seam: a coder's required set is the triple plus the
    // one label #432's operator command writes. Preflight creates that one
    // itself (`CREATED_LABELS`); a token that cannot create labels still denies
    // the start, naming `gh label create migration-applied` as the remedy.
    expect(roleLabels("coder")).toEqual(["migration-applied"]);
    expect(roleLabels("coder", ["difficulty:easy"])).toEqual(["migration-applied"]);
    expect(requiredLabels("ralph")).toEqual(["ralph-wip", "ralph-blocked", "ralph-done"]);
  });

  it("gives a triager its whole vocabulary, and the project's difficulty labels with it", () => {
    expect(roleLabels("triager")).toEqual([...TRIAGE_LABELS]);
    expect(roleLabels("triager", ["difficulty:easy", "difficulty:hard"])).toEqual([
      ...TRIAGE_LABELS,
      "difficulty:easy",
      "difficulty:hard",
    ]);
  });

  it("gives the ci-doctor its own two, and no difficulty label", () => {
    expect(roleLabels("ci-doctor", ["difficulty:hard"])).toEqual(["ci-health", "priority:urgent"]);
  });

  it("gives a pr-medic nothing beyond its claim triple", () => {
    // AC 3. The three labels the medic needs — `medi-wip`, `medi-blocked`,
    // `medi-done` — ARE the per-loop triple; what differs is that it puts them
    // on a pull request rather than on an issue, which is not something a
    // descriptor can say or a preflight can check.
    expect(roleLabels("pr-medic")).toEqual([]);
    expect(roleLabels("pr-medic", ["difficulty:hard"])).toEqual([]);
    expect(requiredLabels("medi")).toEqual(["medi-wip", "medi-blocked", "medi-done"]);
  });

  it("counts a label named twice once", () => {
    // A vocabulary label that is ALSO a difficulty label would otherwise be
    // reported missing twice, and the remedy would tell the operator to create
    // it twice — which reads as a bug in the preflight rather than in jav.json.
    expect(requiredLabels("tria", ["spec", "spec"])).toEqual(["tria-wip", "tria-blocked", "tria-done", "spec"]);
    // And across case, which is the one that bites: GitHub's label names are
    // unique case-insensitively, so `Spec` beside `spec` is one label, and a
    // remedy naming both would have its second `gh label create` fail. First
    // spelling wins, because that is the one the project wrote down.
    expect(requiredLabels("tria", ["Spec", "spec"])).toEqual(["tria-wip", "tria-blocked", "tria-done", "Spec"]);
    expect(missingLabels("tria", ["tria-wip", "tria-blocked", "tria-done"], ["spec", "spec"])).toEqual(["spec"]);
  });

  it("gives a triager on a keyed tracker the intake's labels too, once each (#396)", () => {
    // A missing jav.json is no difficulty labels, so the answer does not depend
    // on what this checkout's own file says.
    const before = process.env.RALPH_JAV;
    process.env.RALPH_JAV = join(tmpdir(), `no-jav-${process.pid}.json`);
    try {
      const apps = { backoffice: "acme-backoffice", pwa: "acme-pwa" };
      const keyed = requiredLabelsFor("tria", "triager", [], { keyed: true, apps });
      const triple = ["tria-wip", "tria-blocked", "tria-done"];
      expect(keyed).toEqual({
        labels: [...triple, ...TRIAGE_LABELS, ...keyedTriagerLabels(apps).filter((l) => l !== "ready-for-agent")],
      });
      expect(keyed).toMatchObject({ labels: expect.arrayContaining(["acme-pwa"]) });
      // Without the project's app labels the intake's rules cannot be checked: refused before it starts.
      expect(requiredLabelsFor("tria", "triager", [], { keyed: true })).toEqual({ why: expect.stringContaining("'appLabels'") });
      expect(requiredLabelsFor("tria", "triager", [])).toEqual({ labels: [...triple, ...TRIAGE_LABELS] });
      expect(requiredLabelsFor("ralph", "coder", [], { keyed: true })).toEqual({ labels: requiredLabels("ralph", ["migration-applied"]) });
    } finally {
      if (before === undefined) delete process.env.RALPH_JAV;
      else process.env.RALPH_JAV = before;
    }
  });

  it("holds an extra label to the same case-insensitive match as a claim label", () => {
    expect(missingLabels("tria", ["TRIA-WIP", "tria-blocked", "tria-done", "Ready-For-Agent"], ["ready-for-agent"])).toEqual([]);
  });
});

describe("a role's verdict overrides", () => {
  const plan = { checks: [...PREFLIGHT_CHECKS], labels: [], requiresDifficultyLabels: false } as const;
  const warned: CheckResult = { name: "buildkite-logs", outcome: { status: "warn", why: "no token", remedy: "add one" } };

  it("turns a coder's warning into the ci-doctor's denial, keeping the reason and the remedy", () => {
    // AC 3. The doctor's whole iteration is reading those logs, so the check a
    // coder starts past is the one it cannot start without.
    const result = applyVerdicts([warned], ROLE_DESCRIPTORS["ci-doctor"].preflight)[0]!;
    expect(result.outcome).toEqual({ status: "denied", why: "no token", remedy: "add one" });
    expect(summarize([result])).toBe("denied");
    // And the coder's own answer is untouched.
    expect(applyVerdicts([warned], ROLE_DESCRIPTORS.coder.preflight)).toEqual([warned]);
  });

  it("can soften a denial to a warning as well, since the override is the role's answer", () => {
    const denied: CheckResult = { name: "loop-labels", outcome: { status: "denied", why: "no label", remedy: "create it" } };
    const result = applyVerdicts([denied], { ...plan, verdicts: { "loop-labels": "warn" } })[0]!;
    expect(result.outcome).toEqual({ status: "warn", why: "no label", remedy: "create it" });
    expect(summarize([result])).toBe("ready");
  });

  it("never promotes an outage, and never touches a check that passed", () => {
    // An `unavailable` is a wait for every role. Promoting it would let one
    // network blip permanently refuse a loop meant to be left running.
    const outage: CheckResult = { name: "buildkite-logs", outcome: { status: "unavailable", why: "unreachable" } };
    const passed: CheckResult = { name: "buildkite-logs", outcome: { status: "ok" } };
    const verdicts = { ...plan, verdicts: { "buildkite-logs": "denied" } } as const;
    expect(applyVerdicts([outage], verdicts)).toEqual([outage]);
    expect(applyVerdicts([passed], verdicts)).toEqual([passed]);
  });

  it("turns an unread warning it would deny into a wait, and a plain one into a denial (#767)", () => {
    const verdicts = { ...plan, verdicts: { "buildkite-logs": "denied" } } as const;
    const unread: CheckResult = {
      name: "buildkite-logs",
      outcome: { status: "warn", why: "could not be read", remedy: "wait", unread: true },
    };
    expect(applyVerdicts([unread], verdicts)[0]!.outcome).toEqual({ status: "unavailable", why: "could not be read" });
    expect(summarize(applyVerdicts([unread], verdicts))).toBe("unavailable");
    const plain: CheckResult = { name: "buildkite-logs", outcome: { status: "warn", why: "no token", remedy: "add one" } };
    expect(applyVerdicts([plain], verdicts)[0]!.outcome).toEqual({ status: "denied", why: "no token", remedy: "add one" });
    // Kept a warning, an unread warning stays one.
    expect(applyVerdicts([unread], { ...plan, verdicts: { "buildkite-logs": "warn" } })).toEqual([unread]);
  });

  it("leaves a check the role declares no verdict for exactly as it came back", () => {
    expect(applyVerdicts([warned], { ...plan, verdicts: {} })).toEqual([warned]);
  });
});

describe("a triager's preflight, end to end", () => {
  /** Loggd's config with a triager on the roster, and Jav listing two labels. */
  const triagerProject = (jav: unknown = { default: { enabled: false, labels: ["difficulty:easy", "difficulty:hard"], routes: {} } }): { project: string; env: Record<string, string> } => {
    const project = scratchProject({ ...LOGGD_CONFIG, loops: ["ralph", { name: "tria", role: "triager" }] });
    const javFile = join(project, "jav.json");
    writeFileSync(javFile, `${JSON.stringify(jav)}\n`);
    // RALPH_JAV explicitly: `runPreflight` inherits this process's environment,
    // so without it the scratch run would read the REAL harness's jav.json.
    // The block is keyed `default`, so no project id is involved either.
    return { project, env: { RALPH_LOOP_NAME: "tria", RALPH_JAV: javFile } };
  };

  const everyLabel = (loop: string, extra: readonly string[]): string =>
    JSON.stringify([...requiredLabels(loop, extra), ...requiredLabels("ralph")].map((name) => ({ name })));

  it("skips the three checks a triager can never reach, and asks Doppler nothing", () => {
    // AC 2. Skipped means NOT RUN: the fake `doppler` records every call, so a
    // probe that merely went unreported would still show up here.
    const { project, env } = triagerProject();
    const fake = fakes();
    const run = runPreflight(fake, { ...env, FAKE_GH_LABELS: everyLabel("tria", [...TRIAGE_LABELS, "difficulty:easy", "difficulty:hard"]) }, project);

    expect(run.status).toBe(0);
    expect(run.verdict).toBe("ready");
    expect(check(run, "executor-tools")).toBeUndefined();
    expect(check(run, "buildkite-logs")).toBeUndefined();
    expect(check(run, "doppler-scope")).toBeUndefined();
    expect(fake.calls().some((call) => call.startsWith("doppler"))).toBe(false);
    // And it still asks everything a triager does reach.
    for (const name of ["project-config", "tools", "loop-identity", "github-credentials", "loop-labels", "frontier-prerequisites"] as const) {
      expect(check(run, name)?.outcome.status).toBe("ok");
    }
  });

  it("refuses to start when a vocabulary label is missing, naming the command that creates it", () => {
    // AC 2: denied, not warned. A triager whose verdict label does not exist
    // writes nothing to the issue and reports success.
    const { project, env } = triagerProject();
    const fake = fakes();
    const run = runPreflight(
      fake,
      { ...env, FAKE_GH_LABELS: everyLabel("tria", [...TRIAGE_LABELS.filter((label) => label !== "needs-info"), "difficulty:easy", "difficulty:hard"]) },
      project,
    );

    expect(run.status).toBe(1);
    expect(run.verdict).toBe("denied");
    const labels = check(run, "loop-labels")!.outcome as { why: string; remedy: string };
    expect(labels.why).toContain("needs-info");
    expect(labels.remedy).toBe("gh label create needs-info");
    // Denied without trying: only a `CREATED_LABELS` label is ever created.
    expect(fake.calls().filter((call) => call.startsWith("gh label create"))).toEqual([]);
  });

  it("refuses to start when a difficulty label the project routes by is missing", () => {
    const { project, env } = triagerProject();
    const fake = fakes();
    const run = runPreflight(fake, { ...env, FAKE_GH_LABELS: everyLabel("tria", TRIAGE_LABELS) }, project);

    expect(run.status).toBe(1);
    const labels = check(run, "loop-labels")!.outcome as { why: string; remedy: string };
    expect(labels.why).toContain("difficulty:easy");
    expect(labels.why).toContain("difficulty:hard");
    // Denied without trying: only a `CREATED_LABELS` label is ever created.
    expect(fake.calls().filter((call) => call.startsWith("gh label create"))).toEqual([]);
  });

  it("refuses with the path when the project's difficulty labels cannot be read at all", () => {
    // `readJav` throws on a malformed block deliberately. Caught, or preflight
    // exits 3 and `ralph.sh` reports its own fence as broken.
    const { project, env } = triagerProject({ default: { enabled: true, labels: [], routes: {} } });
    const run = runPreflight(fakes(), env, project);

    expect(run.status).toBe(1);
    const labels = check(run, "loop-labels")!.outcome as { why: string; remedy: string };
    // Reported as the BLOCK being unreadable rather than as a label being
    // missing: `readJav` refuses a bad `routes` block as readily as a bad
    // `labels` one, and "difficulty labels are missing" would misdescribe that.
    expect(labels.why).toContain("the labels a triager needs could not be read");
    expect(labels.remedy).toContain("jav.json");
  });

  it("does not require the secrets CLI of a role given no application environment", () => {
    // The triager runs no gate and is injected nothing, so a host with no
    // `doppler` at all must still start it — where a coder is rightly refused.
    const { project, env } = triagerProject();
    const noDoppler = fakes({ omit: ["doppler"] });
    const run = runPreflight(noDoppler, { ...env, FAKE_GH_LABELS: everyLabel("tria", [...TRIAGE_LABELS, "difficulty:easy", "difficulty:hard"]) }, project);
    expect(run.status).toBe(0);

    const coder = runPreflight(fakes({ omit: ["doppler"] }), { RALPH_LOOP_NAME: "ralph" }, project);
    expect(coder.status).toBe(1);
    expect(JSON.stringify(check(coder, "tools"))).toContain("not on PATH: doppler");
  });

  it("reads the role off the roster, not off RALPH_LOOP_ROLE", () => {
    // The preflight is also run by hand (step 11 of adding an agent), where the
    // operator has exported nothing. A role taken from the environment would
    // hold a triager to a coder's list and refuse it for prerequisites it never
    // reaches — or, as here, skip a coder's checks because a stale variable said so.
    const { project } = triagerProject();
    const run = runPreflight(fakes(), { RALPH_LOOP_NAME: "ralph", RALPH_LOOP_ROLE: "triager" }, project);
    expect(check(run, "executor-tools")).toBeDefined();
    expect(check(run, "doppler-scope")).toBeDefined();
  });
});

describe("a ci-doctor's preflight, end to end", () => {
  const doctorProject = (): string =>
    scratchProject({ ...LOGGD_CONFIG, loops: ["ralph", { name: "doct", role: "ci-doctor" }] });
  /** The doctor's claim triple plus its two role labels, as `gh label list` would answer. */
  const doctorLabels = (): string =>
    JSON.stringify(requiredLabels("doct", ["ci-health", "priority:urgent"]).map((name) => ({ name })));

  it("refuses to start with no Buildkite token, where a coder only warns", () => {
    // AC 3, wired rather than unit-tested: without a run through the real
    // preflight, deleting both `applyVerdicts` calls leaves the suite green and
    // a doctor starts `ready` with no build it can read.
    const project = doctorProject();
    const doctor = runPreflight(
      fakes(),
      { RALPH_LOOP_NAME: "doct", RALPH_BUILDKITE_READ_TOKEN: "", FAKE_GH_LABELS: doctorLabels() },
      project,
    );

    expect(doctor.status).toBe(1);
    expect(doctor.verdict).toBe("denied");
    const outcome = check(doctor, "buildkite-logs")!.outcome as { status: string; why: string; remedy: string };
    expect(outcome.status).toBe("denied");
    // The override replaces the severity and keeps the reason and the remedy.
    expect(outcome.why).toContain("read-only Buildkite token");
    expect(outcome.remedy).toContain("RALPH_BUILDKITE_READ_TOKEN");

    // Same project, same missing token, a coder: a warning, and it starts.
    const coder = runPreflight(fakes(), { RALPH_LOOP_NAME: "ralph", RALPH_BUILDKITE_READ_TOKEN: "" }, project);
    expect(coder.status).toBe(0);
    expect(check(coder, "buildkite-logs")!.outcome.status).toBe("warn");
  });

  it("waits, rather than refusing, when the read token could not be read (#767)", () => {
    // 2026-10-28: Doppler could not read the token through a keyring still
    // locked at boot, the missing-token warn was promoted to a denial, and doc
    // stopped. An UNREAD token may well be stored, so it is a wait.
    const project = doctorProject();
    const doctor = runPreflight(
      fakes(),
      {
        RALPH_LOOP_NAME: "doct",
        RALPH_BUILDKITE_READ_TOKEN: "",
        RALPH_ROLE_SECRETS_UNREAD: "RALPH_BUILDKITE_READ_TOKEN",
        FAKE_GH_LABELS: doctorLabels(),
      },
      project,
    );

    expect(doctor.verdict).toBe("unavailable");
    expect(doctor.status).toBe(2);
    expect(check(doctor, "buildkite-logs")!.outcome).toEqual({
      status: "unavailable",
      why: "RALPH_BUILDKITE_READ_TOKEN could not be read from the secrets manager in Doppler loggd-web/dev",
    });

    // The same unread token for a coder, for whom the check is only a warning:
    // still a warning, and it starts — the supervisor reads the token again
    // before each poll (#759), so holding the loop here would be over-reach.
    const coder = runPreflight(
      fakes(),
      { RALPH_LOOP_NAME: "ralph", RALPH_BUILDKITE_READ_TOKEN: "", RALPH_ROLE_SECRETS_UNREAD: "RALPH_BUILDKITE_READ_TOKEN" },
      project,
    );
    expect(coder.status).toBe(0);
    expect(coder.verdict).toBe("ready");
    expect(check(coder, "buildkite-logs")!.outcome).toMatchObject({ status: "warn", unread: true });
  });

  it("asks nothing of the frontier, and requires its own two labels", () => {
    const project = doctorProject();
    const fake = fakes();
    const missing = runPreflight(fake, { RALPH_LOOP_NAME: "doct", FAKE_GH_LABELS: JSON.stringify(requiredLabels("doct").map((name) => ({ name }))) }, project);

    expect(check(missing, "frontier-prerequisites")).toBeUndefined();
    expect(missing.status).toBe(1);
    const why = (check(missing, "loop-labels")!.outcome as { why: string }).why;
    expect(why).toContain("ci-health");
    expect(why).toContain("priority:urgent");
    // Role-neutral wording: a ci-doctor triages nothing.
    expect(why).toContain("not label its work as a ci-doctor");
    expect(why).not.toContain("triages");
    // Denied without trying: only a `CREATED_LABELS` label is ever created.
    expect(fake.calls().filter((call) => call.startsWith("gh label create"))).toEqual([]);
  });

  it("warns about a missing retry token and still starts", () => {
    // AC 2. The doctor without it classifies and fixes exactly as before; all
    // it loses is asking Buildkite to re-run a candidate flake's job, so it
    // sees a second verdict only on a rerun somebody else triggered.
    const project = doctorProject();
    const run = runPreflight(fakes(), { RALPH_LOOP_NAME: "doct", FAKE_GH_LABELS: doctorLabels() }, project);

    expect(run.status).toBe(0);
    expect(run.verdict).toBe("ready");
    const outcome = check(run, "buildkite-retry")!.outcome as { status: string; why: string; remedy: string };
    expect(outcome.status).toBe("warn");
    expect(outcome.why).toContain("no write-capable Buildkite token");
    expect(outcome.remedy).toContain("RALPH_BUILDKITE_RETRY_TOKEN");
    expect(outcome.remedy).toContain("write_builds");
  });

  it("reads the supervisor's availability list, not the environment, for a gate secret", () => {
    // The trap this check was nearly written into. The retry token is a `gate`
    // secret: `ralph.sh` keeps one copy for the intake gate's invocation and
    // `unset`s the rest, including from the shell the preflight is spawned
    // from. Asking the environment would therefore warn on every start of a
    // correctly configured doctor, and the operator's fix — storing the token —
    // would not silence it.
    const project = doctorProject();
    const env = {
      RALPH_LOOP_NAME: "doct",
      FAKE_GH_LABELS: doctorLabels(),
      RALPH_ROLE_SECRETS_AVAILABLE: "RALPH_BUILDKITE_READ_TOKEN RALPH_BUILDKITE_RETRY_TOKEN",
    };
    const run = runPreflight(fakes(), env, project);

    expect(check(run, "buildkite-retry")!.outcome).toEqual({ status: "ok" });

    // A list naming only the read token leaves the warning in place.
    const partial = runPreflight(fakes(), { ...env, RALPH_ROLE_SECRETS_AVAILABLE: "RALPH_BUILDKITE_READ_TOKEN" }, project);
    expect(check(partial, "buildkite-retry")!.outcome.status).toBe("warn");
  });

  it("tells a stored-but-withheld token apart from a missing one", () => {
    // The case that would otherwise make this check permanently inert and its
    // remedy wrong: an operator who stored the token would be told to store it
    // again, every start, forever. Since #161 the retry token HAS a checker, so
    // withheld now means that checker refused what is stored — and the remedy
    // names the check to look at rather than the storing the operator has done.
    const project = doctorProject();
    const run = runPreflight(
      fakes(),
      { RALPH_LOOP_NAME: "doct", FAKE_GH_LABELS: doctorLabels(), RALPH_ROLE_SECRETS_WITHHELD: "RALPH_BUILDKITE_RETRY_TOKEN" },
      project,
    );

    expect(run.status).toBe(0);
    const outcome = check(run, "buildkite-retry")!.outcome as { status: string; why: string; remedy: string };
    expect(outcome.status).toBe("warn");
    expect(outcome.why).toContain("stored but withheld");
    expect(outcome.remedy).toContain("find why bk-log.ts --check-retry-token refused it");
    // And it is not the ABSENT branch's remedy. Discriminated by the absent
    // branch's own words rather than by "in Doppler", which only separates the
    // two for a project whose secrets runner happens to be Doppler.
    const missing = checkBuildkiteRetry(parseProjectConfig(JSON.stringify(LOGGD_CONFIG)), "ci-doctor", {
      RALPH_BUILDKITE_RETRY_TOKEN: "",
    })!.outcome as { why: string; remedy: string };
    expect(missing.why).toContain("no write-capable Buildkite token");
    expect(outcome.why).not.toContain("no write-capable Buildkite token");
    expect(outcome.remedy).not.toBe(missing.remedy);
  });

  it("answers an unread retry token as an unread warning, and leaves withheld and absent alone (#767)", () => {
    const config = parseProjectConfig(JSON.stringify(LOGGD_CONFIG));
    const unread = checkBuildkiteRetry(config, "ci-doctor", {
      RALPH_BUILDKITE_RETRY_TOKEN: "",
      RALPH_ROLE_SECRETS_UNREAD: "RALPH_BUILDKITE_RETRY_TOKEN",
    })!.outcome;
    expect(unread).toEqual({
      status: "warn",
      why: "RALPH_BUILDKITE_RETRY_TOKEN could not be read from the secrets manager in Doppler loggd-web/dev",
      remedy: "nothing to do if it reads on a later try; the supervisor reads it again before each poll",
      unread: true,
    });
    // A name the supervisor DID read outranks a stale unread entry for another.
    expect(
      checkBuildkiteRetry(config, "ci-doctor", {
        RALPH_ROLE_SECRETS_AVAILABLE: "RALPH_BUILDKITE_RETRY_TOKEN",
        RALPH_ROLE_SECRETS_UNREAD: "RALPH_BUILDKITE_READ_TOKEN",
      })!.outcome,
    ).toEqual({ status: "ok" });
    // Withheld and absent keep today's warnings when nothing is unread.
    const withheld = checkBuildkiteRetry(config, "ci-doctor", {
      RALPH_ROLE_SECRETS_WITHHELD: "RALPH_BUILDKITE_RETRY_TOKEN",
      RALPH_ROLE_SECRETS_UNREAD: "RALPH_BUILDKITE_READ_TOKEN",
    })!.outcome as { status: string; why: string };
    expect(withheld.status).toBe("warn");
    expect(withheld.why).toContain("stored but withheld");
    const absent = checkBuildkiteRetry(config, "ci-doctor", { RALPH_BUILDKITE_RETRY_TOKEN: "" })!.outcome as { status: string; why: string };
    expect(absent.status).toBe("warn");
    expect(absent.why).toContain("no write-capable Buildkite token");
  });

  it("asks nothing about a retry token of a role that declares none, or a project off Buildkite", () => {
    // Unit level, because the two nulls are what AC 3 rests on and a run can
    // only show the absence, not which clause produced it.
    const config = parseProjectConfig(JSON.stringify(LOGGD_CONFIG));
    const noRetry = { RALPH_BUILDKITE_RETRY_TOKEN: "" };

    expect(checkBuildkiteRetry(config, "coder", noRetry)).toBeNull();
    expect(checkBuildkiteRetry(config, "triager", noRetry)).toBeNull();
    expect(checkBuildkiteRetry(config, "ci-doctor", noRetry)?.outcome.status).toBe("warn");
    // A project whose required checks are not Buildkite's has no job to retry.
    const elsewhere = parseProjectConfig(JSON.stringify({ ...LOGGD_CONFIG, requiredChecks: ["test"] }));
    expect(checkBuildkiteRetry(elsewhere, "ci-doctor", noRetry)).toBeNull();
    expect(checkBuildkiteRetry(null, "ci-doctor", noRetry)).toBeNull();
    // A VISIBLE token is reachable only on a hand-run preflight — under the
    // supervisor a gate secret is unset before the preflight is spawned,
    // whether or not the host exported it. What it may be read as depends on
    // whether the declaration carries a check: without one, `ralph.sh` hands
    // the gate nothing it has proved, and `ok` would tell an operator running
    // under their secrets manager that a credential works while every
    // supervisor start withholds it.
    const seen = checkBuildkiteRetry(config, "ci-doctor", { RALPH_BUILDKITE_RETRY_TOKEN: "write-builds-token" })!.outcome as {
      status: string;
      why: string;
    };
    // #161 shipped that checker, so the env branch is an `ok` again — and the
    // assertion that keeps the inversion from coming back is the IMPLICATION,
    // not the status: `ok` on a visible token is right exactly while the
    // declaration carries a check, and must flip back the moment it does not.
    const proved = ROLE_DESCRIPTORS["ci-doctor"].secrets.named.find((named) => named.name === "RALPH_BUILDKITE_RETRY_TOKEN")!.check;
    expect(proved).toBe("bk-log.ts --check-retry-token");
    // Flat, not `proved === null ? "warn" : "ok"`: a self-adjusting expectation
    // cannot fail. The `check: null` half of the implication is fenced where it
    // is reachable — `ralph.test.ts`'s fake gate secret for the supervisor's
    // third answer, and `role-behaviour.test.ts` for the descriptor mapping.
    expect(seen.status).toBe("ok");

    // Withheld by NAME is still withheld, whatever the environment shows: this
    // is the reading under the supervisor, and the one an operator trusts most.
    const supervised = checkBuildkiteRetry(config, "ci-doctor", {
      RALPH_BUILDKITE_RETRY_TOKEN: "write-builds-token",
      RALPH_ROLE_SECRETS_WITHHELD: "RALPH_BUILDKITE_RETRY_TOKEN",
    })!.outcome as { status: string; why: string };
    expect(supervised.status).toBe("warn");
    expect(supervised.why).toContain("stored but withheld");
  });
});

describe("checkBuildkiteLogs and the supervisor's unread list", () => {
  const config = parseProjectConfig(JSON.stringify(LOGGD_CONFIG));

  it("answers an unread token as an unread warning, a present one as ok, and an absent one as today's warn (#767)", () => {
    expect(checkBuildkiteLogs(config, { RALPH_ROLE_SECRETS_UNREAD: "RALPH_CLERK_SLACK_TOKEN RALPH_BUILDKITE_READ_TOKEN" })!.outcome).toEqual({
      status: "warn",
      why: "RALPH_BUILDKITE_READ_TOKEN could not be read from the secrets manager in Doppler loggd-web/dev",
      remedy: "nothing to do if it reads on a later try; the supervisor reads it again before each poll",
      unread: true,
    });
    // A value in hand wins over the list: there is nothing left to wait for.
    expect(
      checkBuildkiteLogs(config, { RALPH_BUILDKITE_READ_TOKEN: "read-only-token", RALPH_ROLE_SECRETS_UNREAD: "RALPH_BUILDKITE_READ_TOKEN" })!.outcome,
    ).toEqual({ status: "ok" });
    const absent = checkBuildkiteLogs(config, { RALPH_ROLE_SECRETS_UNREAD: "RALPH_BUILDKITE_RETRY_TOKEN" })!.outcome as { status: string; why: string };
    expect(absent.status).toBe("warn");
    expect(absent.why).toContain("no read-only Buildkite token");
    expect(absent).not.toHaveProperty("unread");
  });
});

describe("which role's checks a run is held to", () => {
  it("falls back to the coder when there is no config or no known loop", () => {
    // The strictest list, and it cannot turn a denial into a `ready`:
    // `project-config` and `loop-identity` are already denying in both cases.
    expect(roleFor(null, null)).toBe("coder");
    expect(roleFor(null, "tria" as LoopName)).toBe("coder");
  });

  it("answers from the roster even when the environment says otherwise", () => {
    // The mutant this kills: `?? (isRole(env.RALPH_LOOP_ROLE) ? … )`. It shows
    // up only on the fallback path, which is why the roster must be asserted
    // against a CONTRADICTING variable in both directions.
    const roster = [{ name: "ralph", role: "coder" }, { name: "tria", role: "triager" }] as const;
    const config = { ...parseProjectConfig(JSON.stringify(LOGGD_CONFIG)), roster: [...roster], loops: ["ralph", "tria"] };
    const previous = process.env.RALPH_LOOP_ROLE;
    process.env.RALPH_LOOP_ROLE = "ci-doctor";
    try {
      expect(roleFor(config, "tria")).toBe("triager");
      expect(roleFor(config, "ralph")).toBe("coder");
      // And on the fallback path, which is the only place such a read could
      // hide: a name the roster does not carry is a coder, not whatever the
      // variable says.
      expect(roleFor(config, "nope" as LoopName)).toBe("coder");
    } finally {
      if (previous === undefined) delete process.env.RALPH_LOOP_ROLE;
      else process.env.RALPH_LOOP_ROLE = previous;
    }
  });
});

describe("the labels the Add-agent flow creates", () => {
  /** Run on a PATH of fakes, so every probe it could make is recorded. */
  const labelsOf = (
    env: Record<string, string>,
    project: string,
    extra: string[] = [],
  ): { status: number; lines: string[]; stderr: string; calls: string[] } => {
    const fake = fakes();
    const result = spawnSync(BUN, [join(REPO_ROOT, "preflight.ts"), "--labels", ...extra], {
      cwd: project,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PATH: fake.bin, RALPH_PROJECT: project, ...env },
    });
    return { status: result.status ?? -1, lines: result.stdout.split("\n").filter(Boolean), stderr: result.stderr, calls: fake.calls() };
  };

  it("prints a coder's three and its role label, and answers without touching the network", () => {
    // AC 4. These are the labels an operator creates BEFORE a preflight can
    // pass, so the answer may not depend on a single probe.
    const answer = labelsOf({ RALPH_LOOP_NAME: "ralph" }, scratchProject());
    expect(answer.status).toBe(0);
    expect(answer.lines).toEqual(["ralph-wip", "ralph-blocked", "ralph-done", "migration-applied"]);
    // Not one subprocess: a `--labels` that ran the preflight first would be
    // asking GitHub for the labels it is about to tell you to create.
    expect(answer.calls).toEqual([]);
  });

  it("answers for an agent that is not on the roster yet, which is the Add-agent case", () => {
    // Its roster PR is still open, so resolving the name against the roster
    // would refuse the one question Add agent has to ask.
    const project = scratchProject();
    const coder = labelsOf({}, project, ["--loop", "nova", "--role", "coder"]);
    expect(coder.status).toBe(0);
    expect(coder.lines).toEqual(["nova-wip", "nova-blocked", "nova-done", "migration-applied"]);
    expect(coder.calls).toEqual([]);
    const triager = labelsOf({}, project, ["--loop", "nova", "--role", "triager"]);
    expect(triager.status).toBe(0);
    expect(triager.lines.slice(0, 3)).toEqual(["nova-wip", "nova-blocked", "nova-done"]);
    expect(triager.lines).toEqual(expect.arrayContaining(["needs-triage", "ready-for-agent"]));
  });

  it("refuses a half-given or unknown --loop/--role pair rather than guessing", () => {
    const project = scratchProject();
    for (const argv of [["--loop", "nova"], ["--role", "triager"]]) {
      const answer = labelsOf({}, project, argv);
      expect(answer.status).toBe(2);
      expect(answer.stderr).toContain("together");
    }
    const unknown = labelsOf({}, project, ["--loop", "nova", "--role", "sleuth"]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("--role must be one of");
  });

  it("prints a triager's vocabulary and the project's difficulty labels too", () => {
    const project = scratchProject({ ...LOGGD_CONFIG, loops: ["ralph", { name: "tria", role: "triager" }] });
    const javFile = join(project, "jav.json");
    writeFileSync(javFile, `${JSON.stringify({ default: { enabled: false, labels: ["difficulty:easy"], routes: {} } })}\n`);
    const answer = labelsOf({ RALPH_LOOP_NAME: "tria", RALPH_JAV: javFile }, project);

    expect(answer.status).toBe(0);
    expect(answer.lines).toEqual(["tria-wip", "tria-blocked", "tria-done", ...TRIAGE_LABELS, "difficulty:easy"]);
  });

  it("says what is wrong rather than printing a partial list", () => {
    // A flow that looped over a partial answer would create some labels and
    // leave the loop denied on the rest, which is worse than creating none.
    const answer = labelsOf({ RALPH_LOOP_NAME: "nobody" }, scratchProject());
    expect(answer.status).toBe(1);
    expect(answer.lines).toEqual([]);
    expect(answer.stderr).toContain("one of this project's loops");
  });
});

describe("a clerk's preflight, end to end", () => {
  // The clerk fixture's config: an intake project with one clerk, `clara`.
  const clerkProject = (): string =>
    scratchProject(JSON.parse(readFileSync(join(REPO_ROOT, "fixtures", "clerk", ".ralph", "config.json"), "utf8")));
  const clerkLabels = (): string => JSON.stringify(requiredLabels("clara").map((name) => ({ name })));
  const run = (env: Record<string, string>): Ran =>
    runPreflight(fakes(), { RALPH_LOOP_NAME: "clara", FAKE_GH_LABELS: clerkLabels(), RALPH_CLERK_SLACK_TOKEN: "", ...env }, clerkProject());

  it("is ready once the supervisor has proved the Slack token, and never asks the frontier", () => {
    const ready = run({ RALPH_ROLE_SECRETS_AVAILABLE: "RALPH_CLERK_SLACK_TOKEN RALPH_CLERK_JIRA_TOKEN" });
    expect(ready.verdict, ready.stdout).toBe("ready");
    expect(check(ready, "clerk-credentials")?.outcome).toEqual({ status: "ok", detail: "RALPH_CLERK_SLACK_TOKEN, RALPH_CLERK_JIRA_TOKEN" });
    expect(check(ready, "frontier-prerequisites")).toBeUndefined();
  });

  it("denies a missing token, naming the secret and the scope to store it in", () => {
    const missing = run({});
    expect(missing.status).toBe(1);
    expect(missing.verdict).toBe("denied");
    const outcome = check(missing, "clerk-credentials")!.outcome as { status: string; why: string; remedy: string };
    expect(outcome.status).toBe("denied");
    expect(outcome.why).toContain("no RALPH_CLERK_SLACK_TOKEN");
    expect(outcome.remedy).toBe("store the clerk's token as RALPH_CLERK_SLACK_TOKEN in Doppler acme-intake/prd, and restart");
  });

  it("denies a token its check refused — an invalid one, or one missing a scope — as withheld, not as missing", () => {
    // `ralph.sh` withholds a token `clerk/slack.ts --check-token` refused,
    // whichever refusal it was; `clerk/slack.test.ts` pins the check itself.
    const withheld = run({ RALPH_ROLE_SECRETS_WITHHELD: "RALPH_CLERK_SLACK_TOKEN" });
    expect(withheld.verdict).toBe("denied");
    const outcome = check(withheld, "clerk-credentials")!.outcome as { status: string; why: string; remedy: string };
    expect(outcome.why).toBe("RALPH_CLERK_SLACK_TOKEN is stored but withheld: its check refused it");
    expect(outcome.remedy).toContain("clerk/slack.ts --check-token");
    // Withheld outranks a value a hand-run preflight can see in its own environment.
    expect(run({ RALPH_ROLE_SECRETS_WITHHELD: "RALPH_CLERK_SLACK_TOKEN", RALPH_CLERK_SLACK_TOKEN: "xoxb-seen" }).verdict).toBe("denied");
  });

  it("waits rather than denies on a token the secrets manager could not hand over", () => {
    // 2026-10-29: the boot-time reconciler started clara before the login
    // keyring unlocked. Both tokens were stored; reading them as missing
    // refused a loop whose setup was fine, and the 09:00 report never went out.
    const unread = run({ RALPH_ROLE_SECRETS_UNREAD: "RALPH_CLERK_SLACK_TOKEN RALPH_CLERK_JIRA_TOKEN" });
    expect(unread.status).toBe(2);
    expect(unread.verdict).toBe("unavailable");
    expect(check(unread, "clerk-credentials")!.outcome).toEqual({
      status: "unavailable",
      why: "RALPH_CLERK_SLACK_TOKEN could not be read from the secrets manager in Doppler acme-intake/prd",
    });
    // A token that was read and refused is still a denial: waiting fixes nothing.
    expect(run({ RALPH_ROLE_SECRETS_UNREAD: "RALPH_CLERK_JIRA_TOKEN", RALPH_ROLE_SECRETS_WITHHELD: "RALPH_CLERK_SLACK_TOKEN" }).verdict).toBe("denied");
  });

  it("denies a missing or unusable Jira token the same way (felipearos/ralph#318)", () => {
    const missing = run({ RALPH_ROLE_SECRETS_AVAILABLE: "RALPH_CLERK_SLACK_TOKEN" });
    expect(missing.verdict).toBe("denied");
    expect((check(missing, "clerk-credentials")!.outcome as { why: string }).why).toContain("no RALPH_CLERK_JIRA_TOKEN");
    const refused = run({ RALPH_ROLE_SECRETS_AVAILABLE: "RALPH_CLERK_SLACK_TOKEN", RALPH_ROLE_SECRETS_WITHHELD: "RALPH_CLERK_JIRA_TOKEN" });
    expect(refused.verdict).toBe("denied");
    expect((check(refused, "clerk-credentials")!.outcome as { remedy: string }).remedy).toContain("clerk/jira.ts --check-token");
  });

  it("asks no other role about the clerk's credentials", () => {
    for (const role of ["coder", "triager", "ci-doctor", "pr-medic"] as const) {
      expect(checkClerkCredentials(null, role, {}), role).toBeNull();
    }
  });
});

describe("a verifier's preflight", () => {
  const verifierConfig = (deploy: Record<string, unknown> = { source: "vercel", project: "prj_loggd" }) =>
    parseProjectConfig(
      JSON.stringify({
        ...LOGGD_CONFIG,
        loops: ["ralph", { name: "sent", role: "verifier" }],
        verifier: { productionUrl: "https://loggd.app", deploy, sentry: { org: "loggd", project: "web" } },
      }),
    );
  const outcome = (result: ReturnType<typeof checkVerifierCredentials>) =>
    result!.outcome as { status: string; why?: string; remedy?: string; detail?: string };
  const BOTH = "RALPH_VERIFIER_SENTRY_TOKEN RALPH_VERIFIER_VERCEL_TOKEN";

  it("asks no other role about the verifier's credentials", () => {
    for (const role of ["coder", "triager", "ci-doctor", "pr-medic", "clerk"] as const) {
      expect(checkVerifierCredentials(verifierConfig(), role, {}), role).toBeNull();
    }
  });

  it("denies a project with no verifier block, naming the file and its keys", () => {
    for (const config of [null, parseProjectConfig(JSON.stringify(LOGGD_CONFIG))]) {
      const result = checkVerifierCredentials(config, "verifier", { RALPH_ROLE_SECRETS_AVAILABLE: BOTH });
      expect(result!.name).toBe("verifier-credentials");
      expect(outcome(result).status).toBe("denied");
      expect(outcome(result).why).toContain("no `verifier` block");
      for (const key of [".ralph/config.json", "productionUrl", "deploy.source", "sentry"]) expect(outcome(result).remedy).toContain(key);
    }
  });

  it("denies a vercel source missing either token, saying what the gate cannot do and where to store it", () => {
    const noSentry = outcome(checkVerifierCredentials(verifierConfig(), "verifier", { RALPH_ROLE_SECRETS_AVAILABLE: "RALPH_VERIFIER_VERCEL_TOKEN" }));
    expect(noSentry.status).toBe("denied");
    expect(noSentry.why).toBe("no RALPH_VERIFIER_SENTRY_TOKEN, so the verifier's gate cannot read Sentry for the errors a change brings");
    expect(noSentry.remedy).toBe("store a read-only Sentry token as RALPH_VERIFIER_SENTRY_TOKEN in Doppler loggd-web/dev, and restart");
    const noVercel = outcome(checkVerifierCredentials(verifierConfig(), "verifier", { RALPH_ROLE_SECRETS_AVAILABLE: "RALPH_VERIFIER_SENTRY_TOKEN" }));
    expect(noVercel.status).toBe("denied");
    expect(noVercel.why).toContain("see a Vercel deploy land");
    expect(noVercel.remedy).toBe("store a read-only Vercel token as RALPH_VERIFIER_VERCEL_TOKEN in Doppler loggd-web/dev, and restart");
  });

  it("names the supervisor's environment when the project has no Doppler scope", () => {
    const config: ProjectConfig = { ...verifierConfig(), secrets: { runner: "none", withhold: [] } };
    const result = outcome(checkVerifierCredentials(config, "verifier", { RALPH_ROLE_SECRETS_AVAILABLE: "RALPH_VERIFIER_VERCEL_TOKEN" }));
    expect(result.remedy).toBe("store a read-only Sentry token as RALPH_VERIFIER_SENTRY_TOKEN in the supervisor's environment, and restart");
  });

  it("asks a github-deployments source only for the Sentry token", () => {
    const config = verifierConfig({ source: "github-deployments", environment: "production" });
    expect(outcome(checkVerifierCredentials(config, "verifier", {})).why).toContain("no RALPH_VERIFIER_SENTRY_TOKEN");
    expect(outcome(checkVerifierCredentials(config, "verifier", { RALPH_ROLE_SECRETS_AVAILABLE: "RALPH_VERIFIER_SENTRY_TOKEN" }))).toEqual({
      status: "ok",
      detail: "RALPH_VERIFIER_SENTRY_TOKEN; deploy source github-deployments reads through gh",
    });
  });

  describe("probing that gh can read a github-deployments source", () => {
    const SENTRY = { RALPH_ROLE_SECRETS_AVAILABLE: "RALPH_VERIFIER_SENTRY_TOKEN" };
    const github = () => verifierConfig({ source: "github-deployments", environment: "production" });
    const reader = (answer: { ok: boolean; output?: string; timedOut?: boolean }) => {
      const calls: string[][] = [];
      const read = async (args: string[]) => {
        calls.push(args);
        return { ok: answer.ok, stdout: answer.ok ? "[]" : "", output: answer.output ?? "", timedOut: answer.timedOut ?? false };
      };
      return { calls, read };
    };

    it("is ok when gh reads the project's deployments, named by the config's repo", async () => {
      const { calls, read } = reader({ ok: true });
      const result = await checkVerifierDeploySource(github(), "verifier", SENTRY, read);
      expect(result).toEqual({
        name: "verifier-credentials",
        outcome: {
          status: "ok",
          detail: "RALPH_VERIFIER_SENTRY_TOKEN; deploy source github-deployments reads felipearos/loggd deployments (production) through gh",
        },
      });
      expect(calls).toEqual([["api", "repos/felipearos/loggd/deployments?environment=production&per_page=1"]]);
    });

    it("denies a gh that cannot read deployments, with the remedy", async () => {
      const { read } = reader({ ok: false, output: "{\"message\":\"Resource not accessible by personal access token\"}\ngh: Resource not accessible by personal access token (HTTP 403)\n" });
      expect(outcome(await checkVerifierDeploySource(github(), "verifier", SENTRY, read))).toEqual({
        status: "denied",
        why: "gh cannot read felipearos/loggd's deployments, so the verifier's gate could never see a deploy land: gh: Resource not accessible by personal access token (HTTP 403)",
        remedy: "give gh's token read access to deployments on felipearos/loggd (classic: repo or repo_deployment; fine-grained: Deployments read), and restart",
      });
    });

    it("is unavailable when GitHub cannot be reached", async () => {
      const { read } = reader({ ok: false, timedOut: true });
      expect(outcome(await checkVerifierDeploySource(github(), "verifier", SENTRY, read))).toEqual({
        status: "unavailable",
        why: "GitHub could not be reached to read felipearos/loggd's deployments",
      });
    });

    it("returns the credentials answer unchanged, without probing, for a vercel source or a denial", async () => {
      const { calls, read } = reader({ ok: true });
      const vercelEnv = { RALPH_ROLE_SECRETS_AVAILABLE: "RALPH_VERIFIER_SENTRY_TOKEN RALPH_VERIFIER_VERCEL_TOKEN" };
      expect(await checkVerifierDeploySource(verifierConfig(), "verifier", vercelEnv, read)).toEqual(
        checkVerifierCredentials(verifierConfig(), "verifier", vercelEnv),
      );
      expect(await checkVerifierDeploySource(github(), "verifier", {}, read)).toEqual(checkVerifierCredentials(github(), "verifier", {}));
      expect(await checkVerifierDeploySource(github(), "coder", SENTRY, read)).toBeNull();
      expect(calls).toEqual([]);
    });
  });

  it("denies a token its check refused as withheld, with the check to run", () => {
    const result = outcome(
      checkVerifierCredentials(verifierConfig(), "verifier", {
        RALPH_ROLE_SECRETS_AVAILABLE: "RALPH_VERIFIER_SENTRY_TOKEN",
        RALPH_ROLE_SECRETS_WITHHELD: "RALPH_VERIFIER_VERCEL_TOKEN",
      }),
    );
    expect(result.status).toBe("denied");
    expect(result.why).toBe("RALPH_VERIFIER_VERCEL_TOKEN is stored but withheld: its check refused it");
    expect(result.remedy).toContain("verifier/credentials.ts --check-token vercel");
  });

  it("waits rather than denies on a token the secrets manager could not hand over", () => {
    expect(outcome(checkVerifierCredentials(verifierConfig(), "verifier", { RALPH_ROLE_SECRETS_UNREAD: BOTH }))).toEqual({
      status: "unavailable",
      why: "RALPH_VERIFIER_SENTRY_TOKEN could not be read from the secrets manager in Doppler loggd-web/dev",
    });
  });

  it("is ok once the supervisor has proved both tokens for a vercel source", () => {
    expect(outcome(checkVerifierCredentials(verifierConfig(), "verifier", { RALPH_ROLE_SECRETS_AVAILABLE: BOTH }))).toEqual({
      status: "ok",
      detail: "RALPH_VERIFIER_SENTRY_TOKEN, RALPH_VERIFIER_VERCEL_TOKEN",
    });
  });
});

describe("a triager's Jira token (#397)", () => {
  const triagerConfig = (jira?: "shadow" | "live") =>
    parseProjectConfig(
      JSON.stringify({
        ...LOGGD_CONFIG,
        loops: ["ralph", { name: "tria", role: "triager" }],
        ...(jira === undefined ? {} : { triage: { jira, jiraSite: "example.atlassian.net", jiraProject: "OA" } }),
      }),
    );
  const outcome = (result: ReturnType<typeof checkClerkCredentials>) =>
    result!.outcome as { status: string; why?: string; remedy?: string; detail?: string };

  it("asks nothing of a triager whose Jira path is absent or in shadow", () => {
    // Neither writes to Jira, so a missing token is no reason to refuse it.
    expect(checkClerkCredentials(triagerConfig(), "triager", {})).toBeNull();
    expect(checkClerkCredentials(triagerConfig("shadow"), "triager", {})).toBeNull();
  });

  it("is ok once the supervisor has proved the token for a live Jira path", () => {
    const result = checkClerkCredentials(triagerConfig("live"), "triager", { RALPH_ROLE_SECRETS_AVAILABLE: "RALPH_CLERK_JIRA_TOKEN" });
    expect(result!.name).toBe("clerk-credentials");
    expect(outcome(result)).toEqual({ status: "ok", detail: "RALPH_CLERK_JIRA_TOKEN" });
  });

  it("denies a live Jira path with no token, naming the handoff rather than a channel", () => {
    const result = outcome(checkClerkCredentials(triagerConfig("live"), "triager", {}));
    expect(result.status).toBe("denied");
    expect(result.why).toContain("no RALPH_CLERK_JIRA_TOKEN");
    expect(result.why).toContain("move to-person reports to Jira");
    expect(result.why).not.toContain("channel");
    expect(result.remedy).toContain("RALPH_CLERK_JIRA_TOKEN");
    expect(result.remedy).not.toContain("clerk");
  });

  it("denies a live Jira path whose token its check refused as withheld", () => {
    const result = outcome(checkClerkCredentials(triagerConfig("live"), "triager", { RALPH_ROLE_SECRETS_WITHHELD: "RALPH_CLERK_JIRA_TOKEN" }));
    expect(result.status).toBe("denied");
    expect(result.why).toBe("RALPH_CLERK_JIRA_TOKEN is stored but withheld: its check refused it");
    expect(result.remedy).toContain("clerk/jira.ts --check-token");
  });
});

describe("the Jira intake board a clerk files on (felipearos/ralph#447)", () => {
  const CREDENTIAL = { RALPH_CLERK_JIRA_TOKEN: "clerk@example.com:fake" };
  const clerkConfig = (mode: "live" | "shadow", jira: Record<string, unknown> = {}) => {
    const raw = JSON.parse(readFileSync(join(REPO_ROOT, "fixtures", "clerk", ".ralph", "config.json"), "utf8")) as {
      clerk: Record<string, unknown> & { jira: Record<string, unknown> };
    };
    raw.clerk.mode = mode;
    raw.clerk.jira = { ...raw.clerk.jira, ...jira };
    for (const [key, value] of Object.entries(raw.clerk.jira)) if (value === undefined) delete raw.clerk.jira[key];
    return parseProjectConfig(JSON.stringify(raw));
  };
  const board = (options: Parameters<typeof fakeJira>[1] = {}) => {
    const jira = fakeJira("OA", { projects: ["OAI"], workflows: { OAI: INTAKE_WORKFLOW }, ...options });
    return { jira, build: (site: string, credential: { email: string; token: string }) => jiraClient(site, credential, jira.fetch) };
  };
  const outcome = (result: Awaited<ReturnType<typeof checkClerkIntakeBoard>>) =>
    result!.outcome as { status: string; why?: string; remedy?: string; detail?: string };

  it("is not asked of another role, of a shadow clerk with no board, or without the credential", async () => {
    const never = () => {
      throw new Error("no Jira client should be built");
    };
    for (const role of ["coder", "triager", "ci-doctor", "pr-medic"] as const) {
      expect(await checkClerkIntakeBoard(clerkConfig("live"), role, CREDENTIAL, never), role).toBeNull();
    }
    expect(await checkClerkIntakeBoard(clerkConfig("shadow", { intakeProject: undefined }), "clerk", CREDENTIAL, never)).toBeNull();
    // `clerk-credentials` already names a missing token.
    expect(await checkClerkIntakeBoard(clerkConfig("live"), "clerk", {}, never)).toBeNull();
  });

  it("is ok for a readable board with every status and the points field, writing nothing", async () => {
    const { jira, build } = board();
    const result = await checkClerkIntakeBoard(clerkConfig("live", { storyPointsField: "customfield_10016" }), "clerk", CREDENTIAL, build);
    expect(result!.name).toBe("clerk-intake-board");
    expect(outcome(result)).toEqual({ status: "ok", detail: "OAI: Por confirmar, Confirmado, Descartado, Movido, customfield_10016" });
    expect(jira.writes()).toEqual([]);
  });

  it("denies a board the account cannot read when live, and only warns in shadow", async () => {
    const { build } = board({ projects: [] });
    const live = outcome(await checkClerkIntakeBoard(clerkConfig("live"), "clerk", CREDENTIAL, build));
    expect(live.status).toBe("denied");
    expect(live.why).toContain("the Jira intake board OAI cannot be read");
    expect(live.remedy).toContain("clerk.jira.intakeProject");
    expect(outcome(await checkClerkIntakeBoard(clerkConfig("shadow"), "clerk", CREDENTIAL, build)).status).toBe("warn");
  });

  it("is a wait, not a denial, when Jira cannot be reached for a live clerk", async () => {
    const { jira, build } = board();
    jira.fail("/rest/api/3/project/OAI", { status: 503 });
    expect(outcome(await checkClerkIntakeBoard(clerkConfig("live"), "clerk", CREDENTIAL, build)).status).toBe("unavailable");
  });

  it("names a configured status the workflow lacks, with the config key to fix", async () => {
    const { build } = board();
    const renamed = { statuses: { pending: "Pendiente" } };
    const live = outcome(await checkClerkIntakeBoard(clerkConfig("live", renamed), "clerk", CREDENTIAL, build));
    expect(live.status).toBe("denied");
    expect(live.why).toContain("no workflow status named 'Pendiente'");
    expect(live.remedy).toContain("clerk.jira.statuses.pending");
    expect(outcome(await checkClerkIntakeBoard(clerkConfig("shadow", renamed), "clerk", CREDENTIAL, build)).status).toBe("warn");
  });

  it("warns, live or not, when the merged status is not on the board, and names it when it is", async () => {
    const { build } = board();
    const live = outcome(await checkClerkIntakeBoard(clerkConfig("live", { mergedStatus: "Mergeado" }), "clerk", CREDENTIAL, build));
    expect(live.status).toBe("warn");
    expect(live.why).toContain("no workflow status named 'Mergeado', so no ticket moves there when its PR is merged");
    expect(live.remedy).toContain("clerk.jira.mergedStatus");
    const listed = board();
    expect(outcome(await checkClerkIntakeBoard(clerkConfig("live", { mergedStatus: "Listo" }), "clerk", CREDENTIAL, listed.build))).toEqual({
      status: "ok",
      detail: "OAI: Por confirmar, Confirmado, Descartado, Movido, Listo",
    });
  });

  it("warns, live or not, that points go in the description when the field does not exist", async () => {
    const { build } = board({ fields: [{ id: "summary", name: "Summary" }] });
    const result = outcome(await checkClerkIntakeBoard(clerkConfig("live", { storyPointsField: "customfield_10016" }), "clerk", CREDENTIAL, build));
    expect(result.status).toBe("warn");
    expect(result.why).toContain("story points will go in the description");
  });
});

describe("a pr-medic's preflight, end to end", () => {
  const MEDIC_CONFIG = {
    ...LOGGD_CONFIG,
    loops: ["ralph", { name: "medi", role: "pr-medic" }],
    prMedic: { branches: ["felipearosr/*"] },
  };
  const medicProject = (): string => scratchProject(MEDIC_CONFIG);
  /** The medic's claim triple, as `gh label list` would answer. */
  const medicLabels = (): string => JSON.stringify(requiredLabels("medi").map((name) => ({ name })));

  it("reports the three claim labels and the read token, and starts", () => {
    // AC 3, run through the real preflight rather than unit-tested: the three
    // labels and the token are the whole of what a medic is asked for.
    const run = runPreflight(fakes(), { RALPH_LOOP_NAME: "medi", FAKE_GH_LABELS: medicLabels() }, medicProject());

    expect(run.verdict).toBe("ready");
    expect(run.status).toBe(0);
    // The report NAMES them, which is what "reports the three labels" asks for.
    expect(check(run, "loop-labels")!.outcome).toEqual({ status: "ok", detail: "medi-wip medi-blocked medi-done" });
    expect(check(run, "buildkite-logs")!.outcome.status).toBe("ok");
    // Nothing off the frontier, so nothing asked of it.
    expect(check(run, "frontier-prerequisites")).toBeUndefined();
  });

  it("names the missing claim labels", () => {
    const run = runPreflight(fakes(), { RALPH_LOOP_NAME: "medi", FAKE_GH_LABELS: "[]" }, medicProject());

    expect(run.status).toBe(1);
    const outcome = check(run, "loop-labels")!.outcome as { why: string; remedy: string };
    for (const label of ["medi-wip", "medi-blocked", "medi-done"]) {
      expect(outcome.why).toContain(label);
      expect(outcome.remedy).toContain(label);
    }
  });

  it("refuses to start with no Buildkite token, where a coder only warns", () => {
    // The medic's first decision on a red pull request is "is this failure the
    // branch's own, or a flake that is doc's" — and it reads the build to make
    // it. Starting without one would push a guess to the operator's branch.
    const project = medicProject();
    const medic = runPreflight(
      fakes(),
      { RALPH_LOOP_NAME: "medi", RALPH_BUILDKITE_READ_TOKEN: "", FAKE_GH_LABELS: medicLabels() },
      project,
    );

    expect(medic.status).toBe(1);
    expect(medic.verdict).toBe("denied");
    const outcome = check(medic, "buildkite-logs")!.outcome as { status: string; why: string; remedy: string };
    expect(outcome.status).toBe("denied");
    expect(outcome.why).toContain("read-only Buildkite token");
    expect(outcome.remedy).toContain("RALPH_BUILDKITE_READ_TOKEN");

    // The same project and the same missing token for a coder: a warning, and
    // it starts. Nothing about the other roles moved.
    const coder = runPreflight(fakes(), { RALPH_LOOP_NAME: "ralph", RALPH_BUILDKITE_READ_TOKEN: "" }, project);
    expect(coder.status).toBe(0);
    expect(check(coder, "buildkite-logs")!.outcome.status).toBe("warn");
  });

  it("waits, rather than refusing, when the read token could not be read (#767)", () => {
    const project = medicProject();
    const medic = runPreflight(
      fakes(),
      {
        RALPH_LOOP_NAME: "medi",
        RALPH_BUILDKITE_READ_TOKEN: "",
        RALPH_ROLE_SECRETS_UNREAD: "RALPH_BUILDKITE_READ_TOKEN",
        FAKE_GH_LABELS: medicLabels(),
      },
      project,
    );

    expect(medic.verdict).toBe("unavailable");
    expect(medic.status).toBe(2);
    expect(check(medic, "buildkite-logs")!.outcome.status).toBe("unavailable");
  });

  it("refuses the whole config when a rostered medic has no branch list", () => {
    // AC 2 where an operator meets it: `prMedic.branches` is the medic's blast
    // radius, so a roster that names one and says nothing about branches is a
    // config error, and the `project-config` check is where it surfaces.
    const { prMedic: _prMedic, ...noBranches } = MEDIC_CONFIG;
    const run = runPreflight(fakes(), { RALPH_LOOP_NAME: "medi", FAKE_GH_LABELS: medicLabels() }, scratchProject(noBranches));

    expect(run.status).toBe(1);
    const outcome = check(run, "project-config")!.outcome as { status: string; why: string };
    expect(outcome.status).toBe("denied");
    expect(outcome.why).toContain("'prMedic.branches' is required");
  });
});

describe("a clerk's KPI report with no operator (#453)", () => {
  const fixture = JSON.parse(readFileSync(join(REPO_ROOT, "fixtures", "clerk", ".ralph", "config.json"), "utf8")) as { clerk: Record<string, unknown> };

  it("is a warning that the report is off, never a refusal that stops the clerk", () => {
    const { operator: _operator, ...clerk } = fixture.clerk;
    const { result, config } = checkProjectConfig(scratchProject({ ...fixture, clerk }));
    expect(config).not.toBeNull();
    expect(result.outcome.status).toBe("warn");
    expect((result.outcome as { why: string }).why).toContain("the daily KPI report is off");
  });

  it("is ok with the operator set", () => {
    expect(checkProjectConfig(scratchProject(fixture)).result.outcome.status).toBe("ok");
  });
});

describe("--doppler-failure, the classifier ralph.sh's per-turn scope probe asks (#759)", () => {
  const classify = (stdin: string): { status: number; stdout: string } => {
    const result = spawnSync(BUN, [join(REPO_ROOT, "preflight.ts"), "--doppler-failure"], {
      cwd: tmpdir(),
      input: stdin,
      encoding: "utf8",
      timeout: 60_000,
    });
    return { status: result.status ?? -1, stdout: result.stdout.trim() };
  };

  it("answers denied for an auth failure, so the loop stops with the remedy", () => {
    expect(classify("Doppler Error: Unauthorized\n")).toEqual({ status: 0, stdout: "denied" });
  });

  it("answers unavailable for a transient failure and for no output at all", () => {
    // A locked keyring or a network blip is a wait, never a stopped loop.
    expect(classify("Doppler Error: failed to unlock correct collection\n")).toEqual({ status: 0, stdout: "unavailable" });
    expect(classify("")).toEqual({ status: 0, stdout: "unavailable" });
  });
});

describe("whether gh can read a project's GitHub Actions logs (#50)", () => {
  const config = (requiredChecks: string[]) =>
    parseProjectConfig(JSON.stringify({ ...LOGGD_CONFIG, repo: "acme-org/acme-app", requiredChecks }));
  const reader = (answer: { ok: boolean; output?: string; timedOut?: boolean }) => {
    const calls: string[][] = [];
    const read = async (args: string[]) => {
      calls.push(args);
      return { ok: answer.ok, stdout: answer.ok ? "{}" : "", output: answer.output ?? "", timedOut: answer.timedOut ?? false };
    };
    return { calls, read };
  };

  it("is ok when gh reads the project's Actions runs, named by the config's repo", async () => {
    const { calls, read } = reader({ ok: true });
    expect(await checkActionsLogs(config(["buildkite/acme-app", "test"]), read)).toEqual({ name: "actions-logs", outcome: { status: "ok" } });
    expect(calls).toEqual([["api", "repos/acme-org/acme-app/actions/runs?per_page=1"]]);
  });

  it("warns, never denies, a gh that cannot read Actions, with the remedy", async () => {
    const { read } = reader({ ok: false, output: "{\"message\":\"Resource not accessible by personal access token\"}\ngh: Resource not accessible by personal access token (HTTP 403)\n" });
    expect((await checkActionsLogs(config(["test"]), read))!).toEqual({
      name: "actions-logs",
      outcome: {
        status: "warn",
        why: "gh cannot read acme-org/acme-app's GitHub Actions runs, so iterations cannot read why a CI check is red: gh: Resource not accessible by personal access token (HTTP 403)",
        remedy: "give gh's token read access to Actions on acme-org/acme-app (classic: repo; fine-grained: Actions read), and restart",
      },
    });
  });

  it("warns, never waits, when GitHub cannot be reached", async () => {
    const { read } = reader({ ok: false, timedOut: true });
    expect((await checkActionsLogs(config(["test"]), read))!).toEqual({
      name: "actions-logs",
      outcome: {
        status: "warn",
        why: "GitHub could not be reached to check that gh can read acme-org/acme-app's Actions logs: gh printed nothing",
        remedy: "nothing to do if GitHub is down; otherwise check gh auth status, and restart",
      },
    });
    const { read: down } = reader({ ok: false, output: "gh: Bad Gateway (HTTP 502)\n" });
    expect((await checkActionsLogs(config(["test"]), down))!.outcome).toMatchObject({ status: "warn", why: expect.stringContaining("could not be reached") });
  });

  it("asks gh nothing of a project with no required check that could be an Actions job", async () => {
    const { calls, read } = reader({ ok: true });
    expect(await checkActionsLogs(config(["buildkite/acme-app"]), read)).toBeNull();
    expect(await checkActionsLogs(config([]), read)).toBeNull();
    expect(await checkActionsLogs(null, read)).toBeNull();
    expect(calls).toEqual([]);
  });
});
