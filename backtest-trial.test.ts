import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BacktestConfig, BacktestTicket } from "./backtest";
import { runBacktest } from "./backtest-run";
import { hostLease, lineupFromFile, lineupPath, liveLineup, pinOverlays, rescoreBacktest, sandboxStarter, seedFromTicket, writeScoredReport } from "./backtest-trial";
import type { CalibratedCase } from "./eval-judge-accuracy";
import { measureFloor, NOISE_FLOOR_FILE, type NoiseReads } from "./eval-noise-floor";
import { mixedSetReport } from "./fixtures/evals/mixed-set";
import { noiseFloorReport } from "./fixtures/evals/noise-floor";
import { guardrailReport } from "./fixtures/evals/guardrail-arms";
import { emptyStore, readStore } from "./host-lease";
import { READY_LABEL } from "./frontier/next-tasks";
import { readOverlay } from "./prompt-overlay";
import { fixtureGitEnv } from "./test-git-env";
import { scratchDir } from "./test-scratch";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("builds a trial with git and runs a stub ralph.sh under bash");

const ticket = (overrides: Partial<BacktestTicket> = {}): BacktestTicket => ({
  oaKey: "OA-123",
  intakeKey: null,
  movedAt: "2026-10-01T10:00:00Z",
  repo: "your-org/your-repo",
  humanPrs: [],
  mergeBase: "main",
  startedAt: "2026-10-02T10:00:00Z",
  ticketRef: "OA-123",
  comments: { kept: 1, dropped: 0 },
  frozen: {
    title: "Do the thing",
    body: "Make it so.",
    comments: [{ author: "ana", createdAt: "2026-10-01T11:00:00Z", body: "Please hurry." }],
  },
  ...overrides,
});

describe("seedFromTicket", () => {
  it("splits the key, maps the frozen ticket and labels it for the coder", () => {
    expect(seedFromTicket(ticket())).toEqual({
      trackerKey: "OA",
      issue: {
        number: 123,
        title: "Do the thing",
        body: "Make it so.",
        comments: [{ author: "ana", createdAt: "2026-10-01T11:00:00Z", body: "Please hurry." }],
        labels: [READY_LABEL],
        state: "open",
      },
    });
  });

  it("throws on a key that is not <LETTERS>-<digits>", () => {
    expect(() => seedFromTicket(ticket({ oaKey: "OA_12" }))).toThrow(/OA_12/);
    expect(() => seedFromTicket(ticket({ oaKey: "123" }))).toThrow(/'123'/);
  });
});

describe("lineupFromFile", () => {
  const saved = process.env.RALPH_MODEL_EXECUTOR;
  afterEach(() => {
    if (saved === undefined) delete process.env.RALPH_MODEL_EXECUTOR;
    else process.env.RALPH_MODEL_EXECUTOR = saved;
  });

  it("resolves a named lineup to model, runner and effort per stage, without this process's env", () => {
    const home = scratchDir("backtest-lineup-");
    const path = lineupPath("codex", home);
    expect(path).toBe(join(home, ".ralph", "lineups", "codex.json"));
    mkdirSync(join(home, ".ralph", "lineups"), { recursive: true });
    writeFileSync(path, JSON.stringify({
      default: {
        orchestrator: { runner: "codex", model: "gpt-5.5", effort: "high" },
        executor: { runner: "codex", model: "gpt-5.5-mini" },
        mapper: { runner: "codex", model: "gpt-5.5-mini" },
        review: {
          standards: { runner: "codex", model: "gpt-5.5-mini" },
          spec: { runner: "codex", model: "gpt-5.5-mini" },
          correctness: { runner: "claude", model: "claude-opus-5-5", effort: "high" },
        },
      },
    }, null, 2));
    process.env.RALPH_MODEL_EXECUTOR = "leaked-model";
    const lineup = lineupFromFile(path, { projectId: "software-factory", loopName: "rafa" });
    expect(lineup).toEqual({
      orchestrator: { runner: "codex", model: "gpt-5.5", effort: "high" },
      executor: { runner: "codex", model: "gpt-5.5-mini" },
      mapper: { runner: "codex", model: "gpt-5.5-mini" },
      "review.standards": { runner: "codex", model: "gpt-5.5-mini" },
      "review.spec": { runner: "codex", model: "gpt-5.5-mini" },
      "review.correctness": { runner: "claude", model: "claude-opus-5-5", effort: "high" },
    });
  });

  it("throws on a lineup that is not there", () => {
    const home = scratchDir("backtest-lineup-");
    expect(() => lineupFromFile(lineupPath("nope", home), { projectId: "p", loopName: "rafa" }))
      .toThrow(`backtest: no lineup named nope (${lineupPath("nope", home)})`);
  });

  it("resolves the live lineup from a harness's models.json, and names the harness when it has none (#816)", () => {
    const harness = scratchDir("backtest-live-");
    expect(() => liveLineup(harness, { projectId: "p", loopName: "rafa" }))
      .toThrow(`backtest: the harness has no models.json (${join(harness, "models.json")})`);
    writeFileSync(join(harness, "models.json"), JSON.stringify({
      default: {
        orchestrator: { runner: "claude", model: "claude-opus-5-5", effort: "high" },
        executor: { runner: "claude", model: "claude-sonnet-5-5" },
        mapper: { runner: "claude", model: "claude-haiku-5-5" },
        review: { standards: { runner: "claude", model: "claude-sonnet-5-5" }, spec: { runner: "claude", model: "claude-sonnet-5-5" } },
      },
    }));
    expect(liveLineup(harness, { projectId: "p", loopName: "rafa" })).toMatchObject({
      orchestrator: { runner: "claude", model: "claude-opus-5-5", effort: "high" },
      executor: { runner: "claude", model: "claude-sonnet-5-5" },
    });
  });
});

describe("hostLease", () => {
  const T0 = Date.parse("2026-10-28T02:00:00Z");
  const idle = () => ({ busy: false, detail: "idle" });
  const live = new AbortController().signal;
  const setup = (env: NodeJS.ProcessEnv, onSleep: () => void = () => {}) => {
    const path = join(scratchDir("backtest-lease-"), "ralph-host-lease.json");
    let now = T0;
    const lease = hostLease({
      storePath: () => path,
      runId: "backtest-run",
      trialMinutes: 90,
      ci: idle,
      env: { HOSTNAME: "box", RALPH_HOST_LEASE_POLL_SECONDS: "1", ...env },
      now: () => now,
      sleep: async (ms) => { onSleep(); now += ms; },
      alive: () => true,
      log: () => {},
    });
    return { path, lease };
  };

  it("grants the backtest as its own party, releases, and grants again with no per-ticket or cooldown limit", async () => {
    const { path, lease } = setup({ RALPH_HOST_LEASE_SPACING_SECONDS: "0" });
    await lease.release(); // nothing acquired: a no-op
    expect(existsSync(path)).toBe(false);
    for (let round = 0; round < 4; round++) {
      expect(await lease.acquire(ticket(), { arm: round % 2 === 0 ? "b" : "c", lineup: "x" }, live)).toEqual({ ok: true });
      const store = readStore(path);
      expect(store.holder).toMatchObject({ run: "backtest-run", loop: "backtest", ticket: 0, host: "box", pid: process.pid, state: "granted" });
      // The grant outlives a 90-minute trial.
      expect(Date.parse(store.holder!.expiresAt!) - Date.parse(store.holder!.since)).toBeGreaterThanOrEqual((90 * 60 + 600) * 1000);
      await lease.release();
      expect(readStore(path).holder).toBeNull();
    }
  });

  it("waits behind another holder and gives up with queue-timeout", async () => {
    const { path, lease } = setup({ RALPH_HOST_LEASE_QUEUE_SECONDS: "5" });
    const future = new Date(T0 + 3_600_000).toISOString();
    writeFileSync(path, JSON.stringify({
      ...emptyStore(),
      holder: {
        run: "remo-run", loop: "remo", pid: 7, host: "box", ticket: 2, command: "bun run build", queuedAt: new Date(T0).toISOString(),
        state: "granted", since: new Date(T0).toISOString(), drainDeadline: future, expiresAt: future,
      },
    }));
    const result = await lease.acquire(ticket(), { arm: "b", lineup: "live" }, live);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.why).toMatch(/^queue-timeout: /);
    expect(readStore(path).holder).toMatchObject({ run: "remo-run" });
    expect(readStore(path).queue).toEqual([]);
  });
  const holdByRemo = (path: string): void => {
    const future = new Date(T0 + 3_600_000).toISOString();
    writeFileSync(path, JSON.stringify({
      ...emptyStore(),
      holder: {
        run: "remo-run", loop: "remo", pid: 7, host: "box", ticket: 2, command: "bun run build", queuedAt: new Date(T0).toISOString(),
        state: "granted", since: new Date(T0).toISOString(), drainDeadline: future, expiresAt: future,
      },
    }));
  };

  it("ends a lease wait on abort and leaves no queue entry for the run", async () => {
    const operator = new AbortController();
    let sleeps = 0;
    const { path, lease } = setup({ RALPH_HOST_LEASE_QUEUE_SECONDS: "3600" }, () => { sleeps++; operator.abort(); });
    holdByRemo(path);
    const result = await lease.acquire(ticket(), { arm: "b", lineup: "live" }, operator.signal);
    expect(result.ok).toBe(false);
    expect(sleeps).toBe(1);
    expect(readStore(path).holder).toMatchObject({ run: "remo-run" });
    expect(readStore(path).queue.filter((waiter) => waiter.run === "backtest-run")).toEqual([]);
  });

  it("does not ask for the lease once the signal has aborted", async () => {
    const { path, lease } = setup({});
    const operator = new AbortController();
    operator.abort();
    expect(await lease.acquire(ticket(), { arm: "b", lineup: "live" }, operator.signal)).toEqual({ ok: false, why: "aborted" });
    expect(existsSync(path)).toBe(false);
  });
});

/** A one-commit app repo with a fixture project config, a temp HOME and a harness dir whose `ralph.sh` runs `script`. */
function appFixture(script: string[]) {
  const root = realpathSync(scratchDir("backtest-trial-"));
  const source = join(root, "app");
  const home = join(root, "home");
  const harness = join(root, "harness");
  const env = fixtureGitEnv({
    HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  });
  const git = (cwd: string, args: string[]) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  };
  mkdirSync(join(source, ".ralph"), { recursive: true });
  mkdirSync(home);
  mkdirSync(harness);
  writeFileSync(join(source, ".ralph", "config.json"), JSON.stringify({
    repo: "your-org/your-repo",
    owner: "your-github-login",
    baseBranch: "main",
    displayName: "Fixture",
    secrets: { runner: "none", withhold: [] },
    refuseFiles: [],
    envCheck: [],
    requiredChecks: [],
    gates: { test: "true" },
    promptFragment: ".ralph/prompt.md",
    coderFragment: ".ralph/coder.md",
    plan: ".ralph/plan.md",
    journal: { dir: "journal/fixture" },
    loops: ["ralph"],
  }, null, 2));
  for (const name of ["prompt.md", "coder.md", "plan.md"]) writeFileSync(join(source, ".ralph", name), `${name}\n`);
  writeFileSync(join(source, "README.md"), "app\n");
  git(root, ["init", "--quiet", "--initial-branch=main", source]);
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "initial"]);
  writeFileSync(join(harness, "ralph.sh"), ["#!/usr/bin/env bash", "set -e", 'cd "$RALPH_PROJECT"', ...script, ""].join("\n"));
  chmodSync(join(harness, "ralph.sh"), 0o755);
  return { root, source, home, harness, env, git };
}

describe("sandboxStarter", () => {
  it("runs a trial, reads its committed and uncommitted work as the partial patch, and disposes it", async () => {
    const { root, source, home, harness } = appFixture([
      "echo committed > committed.txt",
      "git add committed.txt",
      "git -c user.name=stub -c user.email=stub@example.invalid commit --quiet -m 'stub work'",
      "echo uncommitted > uncommitted.txt",
      "echo \"${RALPH_MODEL_EXECUTOR-unset}\" > \"$RALPH_TRIAL_ROOT/executor-seen.txt\"",
      "echo '<ralph>COMPLETE</ralph>'",
    ]);

    const start = sandboxStarter({
      source: () => source,
      lineups: { sonnet: { executor: { runner: "claude", model: "claude-sonnet-5-5", effort: "low" } } },
      live: { executor: { runner: "claude", model: "live-only-model" }, orchestrator: { runner: "claude", model: "claude-opus-5-5", effort: "high" } },
      harness, scratchParent: root, home,
    });
    await expect(start(ticket(), { arm: "c", lineup: "codex" })).rejects.toThrow(/arm c for OA-123 names lineup codex/);
    // The record per arm (#816): the live arm's is the resolved live lineup, in STAGES order.
    const named = await start(ticket(), { arm: "s", lineup: "sonnet" });
    expect(named.resolved).toEqual({ stages: [{ stage: "executor", runner: "claude", model: "claude-sonnet-5-5", effort: "low" }], overlayHash: null });
    named.dispose();
    const handle = await start(ticket(), { arm: "b", lineup: "live" });
    expect(handle.resolved).toEqual({
      stages: [
        { stage: "orchestrator", runner: "claude", model: "claude-opus-5-5", effort: "high" },
        { stage: "executor", runner: "claude", model: "live-only-model", effort: null },
      ],
      overlayHash: null,
    });
    const result = await handle.run({ timeoutMs: 20_000, signal: new AbortController().signal });
    expect(result.outcome).toMatchObject({ kind: "finished", exit: 0 });
    // Recorded only: the live trial still ran the project's own lineup, with no stage set from the record.
    const [trial] = readdirSync(root).filter((entry) => entry.startsWith("ralph-trial-"));
    expect(readFileSync(join(root, trial!, "executor-seen.txt"), "utf8")).toBe(`${process.env.RALPH_MODEL_EXECUTOR ?? "unset"}\n`);
    const patch = handle.partialPatch();
    expect(patch).toContain("+++ b/committed.txt");
    expect(patch).toContain("+++ b/uncommitted.txt");
    const trials = () => readdirSync(root).filter((entry) => entry.startsWith("ralph-trial-"));
    expect(trials()).toHaveLength(1);
    handle.dispose();
    expect(trials()).toEqual([]);
  });

  it("runs an arm's prompt overlay in its staged harness and leaves the harness on disk alone (#801)", async () => {
    const { root, source, home, harness } = appFixture([
      "cat \"$(dirname \"$0\")/coder.md\" > \"$RALPH_TRIAL_ROOT/coder-seen.txt\"",
      "echo '<ralph>COMPLETE</ralph>'",
    ]);
    writeFileSync(join(harness, "coder.md"), "live coder\n");
    const overlay = join(root, "overlay");
    mkdirSync(overlay);
    writeFileSync(join(overlay, "coder.md"), "candidate coder\n");
    const start = sandboxStarter({ source: () => source, lineups: {}, harness, scratchParent: root, home });
    const handle = await start(ticket(), { arm: "short-prompt", lineup: "live", overlay });
    // No live lineup given: no models recorded, but the overlay's hash still is (#816).
    expect(handle.resolved).toEqual({ stages: [], overlayHash: readOverlay(overlay).hash });
    await handle.run({ timeoutMs: 20_000, signal: new AbortController().signal });
    const [trial] = readdirSync(root).filter((entry) => entry.startsWith("ralph-trial-"));
    expect(readFileSync(join(root, trial!, "coder-seen.txt"), "utf8")).toBe("candidate coder\n");
    expect(readFileSync(join(harness, "coder.md"), "utf8")).toBe("live coder\n");
    handle.dispose();

    // The overlay's hash in the record: the batch's pinned one when given, else hashed here (#816).
    const recorded = sandboxStarter({ source: () => source, lineups: {}, live: {}, harness, scratchParent: root, home });
    const hashed = await recorded(ticket(), { arm: "short-prompt", lineup: "live", overlay });
    expect(hashed.resolved).toEqual({ stages: [], overlayHash: readOverlay(overlay).hash });
    hashed.dispose();
    const pinned = await sandboxStarter({ source: () => source, lineups: {}, live: {}, overlayHashes: { "short-prompt": "pinned-hash" }, harness, scratchParent: root, home })(
      ticket(), { arm: "short-prompt", lineup: "live", overlay });
    expect(pinned.resolved?.overlayHash).toBe("pinned-hash");
    pinned.dispose();
  });
});

describe("a trial from a base that is already red (#579)", () => {
  // The stub iteration waits for its PR's checks the way the supervisor's PR
  // wait does, then hands off only if trial/test passes, as the prompt says.
  const iteration = (extraFailure: boolean) => [
    // The head keeps the base's red test and adds one of its own.
    ...(extraFailure ? ["printf '%s\\n' \"echo ' FAIL  src/a.test.ts > a > already red'\" \"echo ' FAIL  src/b.test.ts > b > breaks'\" 'exit 1' > check.sh"] : []),
    "echo work > work.txt",
    "git add -A",
    "git -c user.name=stub -c user.email=stub@example.invalid commit --quiet -m 'stub work'",
    "git push --quiet origin HEAD:refs/heads/trial/1-x",
    "gh pr create --title t --body b --head trial/1-x",
    "until test=$(gh pr checks 1 --json name,state,description | jq -c '.[] | select(.name == \"trial/test\")') && [ -n \"$test\" ] && ! printf '%s' \"$test\" | grep -q PENDING; do sleep 0.2; done",
    "printf '%s\\n' \"$test\" > \"$RALPH_TRIAL_ROOT/trial-test.json\"",
    "if printf '%s' \"$test\" | grep -q SUCCESS; then echo '<ralph>DONE</ralph>'; else echo '<ralph>RETRY_LATER</ralph>'; fi",
  ];

  const redBase = (extraFailure: boolean) => {
    const f = appFixture(iteration(extraFailure));
    const configPath = join(f.source, ".ralph", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...config, gates: { test: "sh check.sh" } }, null, 2));
    // The base's one red test, printed the way vitest prints it.
    writeFileSync(join(f.source, "check.sh"), "echo ' FAIL  src/a.test.ts > a > already red'\nexit 1\n");
    f.git(f.source, ["add", "."]);
    f.git(f.source, ["commit", "--quiet", "-m", "red base"]);
    return f;
  };

  it("reports green checks with a base-red note when the patch adds no failure, and the iteration hands off", async () => {
    const { root, source, home, harness } = redBase(false);
    const handle = await sandboxStarter({ source: () => source, lineups: {}, harness, scratchParent: root, home })(ticket(), { arm: "b", lineup: "live" });
    const result = await handle.run({ timeoutMs: 60_000, signal: new AbortController().signal });
    expect(result.outcome).toMatchObject({ kind: "finished", sigil: "<ralph>DONE</ralph>" });
    expect(result.baseRed?.gates["trial/test"]).toEqual({ conclusion: "FAILURE", failures: ["src/a.test.ts > a > already red"] });
    const seen = readdirSync(root).filter((entry) => entry.startsWith("ralph-trial-")).map((dir) => JSON.parse(readFileSync(join(root, dir, "trial-test.json"), "utf8")) as { state: string; description: string });
    expect(seen).toEqual([expect.objectContaining({ state: "SUCCESS", description: expect.stringContaining("src/a.test.ts > a > already red") })]);
    handle.dispose();
  });

  it("keeps the check red when the patch adds a failure on top of the base's", async () => {
    const { root, source, home, harness } = redBase(true);
    const handle = await sandboxStarter({ source: () => source, lineups: {}, harness, scratchParent: root, home })(ticket(), { arm: "b", lineup: "live" });
    const result = await handle.run({ timeoutMs: 60_000, signal: new AbortController().signal });
    expect(result.outcome).toMatchObject({ kind: "finished", sigil: "<ralph>RETRY_LATER</ralph>" });
    const seen = readdirSync(root).filter((entry) => entry.startsWith("ralph-trial-")).map((dir) => JSON.parse(readFileSync(join(root, dir, "trial-test.json"), "utf8")) as { state: string; description: string });
    expect(seen).toEqual([expect.objectContaining({ state: "FAILURE", description: expect.stringContaining("src/b.test.ts > b > breaks") })]);
    handle.dispose();
  });
});

describe("a backtest on the real sandbox and host lease", () => {
  it("publishes nothing: the iteration's push, PR and comment land in the trial's fakes", async () => {
    const { root, source, home, harness } = appFixture([
      "echo work > work.txt",
      "git add work.txt",
      "git -c user.name=stub -c user.email=stub@example.invalid commit --quiet -m 'stub work'",
      "git push --quiet origin HEAD:refs/heads/trial/1-x",
      "gh pr create --title t --body b --head trial/1-x",
      "gh pr comment 1 --body hi",
      "echo '<ralph>DONE</ralph>'",
    ]);
    // Tripwires right after the fake gh: a gh or curl that slipped past the
    // fake would reach these before the host's real ones.
    const tripwires = join(root, "tripwires");
    mkdirSync(tripwires);
    for (const name of ["gh", "curl"]) {
      writeFileSync(join(tripwires, name), `#!/usr/bin/env bash\ntouch ${JSON.stringify(join(root, `${name}.tripped`))}\nexit 1\n`);
      chmodSync(join(tripwires, name), 0o755);
    }
    const refs = () => spawnSync("git", ["for-each-ref"], { cwd: source, encoding: "utf8" }).stdout;
    const refsBefore = refs();
    const homeBefore = readdirSync(home, { recursive: true }).map(String);
    const runDir = join(root, "run");
    let leaseNow = Date.now();
    const lease = hostLease({
      storePath: () => join(root, "ralph-host-lease.json"),
      runId: "backtest-e2e",
      trialMinutes: 2,
      ci: () => ({ busy: false, detail: "idle" }),
      env: { HOSTNAME: "box", RALPH_HOST_LEASE_POLL_SECONDS: "1", RALPH_HOST_LEASE_SPACING_SECONDS: "0" },
      now: () => leaseNow,
      sleep: async (ms) => { leaseNow += ms; },
      alive: () => true,
      log: () => {},
    });
    const config: BacktestConfig = {
      project: source, clerk: "clara", sample: { cap: 1, since: null, repos: null }, lineup: null,
      caps: { trialMinutes: 2, batchMinutes: 5 }, rates: null, sources: { "your-org/your-repo": source },
      scoring: { testGlobs: ["**/*.test.ts"], testCommand: "npx vitest run {file}", setup: null, review: false, judge: null, analyst: null },
    };
    const sample = { tickets: [ticket()], skipped: [], notes: [], arms: { b: "live lineup" as const, c: null } };
    const path = process.env.PATH;
    process.env.PATH = `${tripwires}:${path ?? ""}`;
    let report;
    try {
      report = await runBacktest(sample, config, {
        runDir,
        startTrial: sandboxStarter({ source: () => source, lineups: {}, harness, scratchParent: root, home }),
        lease,
        now: Date.now,
        sleep: async () => {},
        log: () => {},
      });
    } finally { process.env.PATH = path; }

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.outcome).not.toMatch(/refused|not-run/);
    const result = JSON.parse(readFileSync(join(runDir, "OA-123", "b", "result.json"), "utf8")) as { github: { prs: { head: string; comments: unknown[] }[] } };
    expect(result.github.prs).toMatchObject([{ head: "trial/1-x", comments: [{ body: "hi" }] }]);
    expect(existsSync(join(root, "gh.tripped"))).toBe(false);
    expect(existsSync(join(root, "curl.tripped"))).toBe(false);
    // The push went to the trial's own origin, never to the source repo.
    expect(refs()).toBe(refsBefore);
    // The origin is gone with the scratch dir, but its commits survive in the bundle.
    const bundle = join(runDir, "OA-123", "b", "arm.bundle");
    const verify = spawnSync("git", ["bundle", "verify", bundle], { cwd: source, encoding: "utf8" });
    expect(verify.status, verify.stderr).toBe(0);
    const listed = spawnSync("git", ["bundle", "list-heads", bundle], { cwd: source, encoding: "utf8" }).stdout;
    expect(listed).toContain("refs/heads/trial/1-x");
    expect(report.rows[0]!.heads?.final).toBe(listed.match(/^(\w+) refs\/heads\/trial\/1-x$/m)?.[1]);
    // The journal home has no remote and lives in the trial's scratch dir, so
    // a publish can only have gone through the trial's origin; that scratch dir is gone.
    expect(readdirSync(root).filter((entry) => entry.startsWith("ralph-trial-"))).toEqual([]);
    // The operator's HOME gained no Slack or push-notification state (bun's
    // install cache under .bun is the only thing a trial may leave there).
    const added = readdirSync(home, { recursive: true }).map(String).filter((entry) => !homeBefore.includes(entry));
    expect(added.filter((entry) => !/^\.bun(\/|$)/.test(entry))).toEqual([]);
    expect(added.filter((entry) => /slack|push-notification/i.test(entry))).toEqual([]);
  });
});

describe("rescoreBacktest", () => {
  it("scores a finished run dir into report.json and report.md without running a trial", async () => {
    const { root, source } = appFixture([]);
    const runDir = join(root, "run");
    const config: BacktestConfig = {
      project: source, clerk: "clara", sample: { cap: 1, since: null, repos: null }, lineup: null,
      caps: { trialMinutes: 2, batchMinutes: 5 }, rates: null, sources: { "your-org/your-repo": source },
      scoring: { testGlobs: ["**/*.test.ts"], testCommand: "true {file}", setup: null, review: true, judge: null, analyst: null },
    };
    const sample = { tickets: [ticket()], skipped: [], notes: [], arms: { b: "live lineup" as const, c: null } };
    const signal = new AbortController().signal;
    const scoreDeps = {
      review: async () => ({ status: "unavailable" as const, reason: "stub", base: null, head: null }),
      gh: async () => "[]",
      fetchHumanPr: () => {},
    };
    await expect(rescoreBacktest(config, { runDir, signal, log: () => {}, scoreDeps })).rejects.toThrow(/state\.json; run the batch first/);

    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "state.json"), JSON.stringify({ version: 1, id: "bt", startedAt: "2026-10-28T00:00:00Z", config, sample, rows: {} }));
    await expect(rescoreBacktest(config, { runDir, signal, log: () => {}, scoreDeps })).rejects.toThrow(/report\.json; run the batch first/);

    // Scored by the batch with a panel this rescore's config turns off (#816).
    const armRecord = { stages: [{ stage: "coder", runner: "claude", model: "claude-opus-5-5", effort: null }], overlayHash: null };
    const report = {
      id: "bt", startedAt: "2026-10-28T00:00:00Z", finishedAt: "2026-10-28T01:00:00Z", arms: sample.arms, rows: [], skipped: [], notes: [], stoppedBy: null,
      resolved: { arms: { b: armRecord }, panel: [{ name: "old", runner: "claude", model: "claude-opus-5-5" }], seed: "old-seed" },
    };
    writeFileSync(join(runDir, "report.json"), JSON.stringify(report));
    const result = await rescoreBacktest(config, { runDir, signal, log: () => {}, scoreDeps });

    expect(result.runDir).toBe(runDir);
    // The record names the panel these scores came from, and keeps what the arms ran with.
    expect(result.report.resolved).toEqual({ arms: { b: armRecord }, panel: [], seed: null });
    expect(result.report.scores?.map((score) => score.ticket)).toEqual(["OA-123"]);
    const saved = JSON.parse(readFileSync(join(runDir, "report.json"), "utf8")) as { id: string; scores?: unknown[] };
    expect(saved.id).toBe("bt");
    expect(saved.scores).toHaveLength(1);
    expect(readFileSync(join(runDir, "report.md"), "utf8")).toContain("## Scoring");
    // No trial ran: no arm directory and no trial sandbox exist.
    expect(existsSync(join(runDir, "OA-123", "b"))).toBe(false);
    expect(readdirSync(root).filter((entry) => entry.startsWith("ralph-trial-"))).toEqual([]);
  });

  it("scores and judges every repeat into its own scores file and the report's Repeats, keeping the first trial's verdict (#821)", async () => {
    const { root, source } = appFixture([]);
    const runDir = join(root, "run");
    const config: BacktestConfig = {
      project: source, clerk: "clara", sample: { cap: 1, since: null, repos: null }, lineup: null,
      caps: { trialMinutes: 2, batchMinutes: 5 }, rates: null, sources: { "your-org/your-repo": source },
      scoring: { testGlobs: ["**/*.test.ts"], testCommand: "true {file}", setup: null, review: false, judge: { model: "m", seed: "s" }, analyst: null },
    };
    const sample = { tickets: [ticket()], skipped: [], notes: [], arms: { b: "live lineup" as const, c: null } };
    const trial = (repeat?: number) => ({
      ticket: "OA-123", arm: "b", lineup: "live", outcome: repeat === undefined ? "green-pr" : "failed", detail: "DONE", gates: [], weakening: [], reviewRounds: 0, reviewThreads: 0,
      wallSeconds: 60, tokens: null, cost: { usd: null, source: "unknown" }, artifacts: repeat === undefined ? "OA-123/b" : `OA-123/b-r${repeat}`, models: [],
      heads: { base: null, first: null, final: null }, ...(repeat === undefined ? {} : { repeat }),
    });
    const rows = [trial(), trial(1), trial(2)];
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "state.json"), JSON.stringify({
      version: 1, id: "bt", startedAt: "2026-10-28T00:00:00Z", config, sample, rows: { "OA-123/b": rows[0], "OA-123/b/r1": rows[1], "OA-123/b/r2": rows[2] },
    }));
    writeFileSync(join(runDir, "report.json"), JSON.stringify({ id: "bt", startedAt: "s", finishedAt: "f", arms: sample.arms, rows, skipped: [], notes: [], stoppedBy: null }));
    const scoreDeps = {
      review: async () => ({ status: "unavailable" as const, reason: "stub", base: null, head: null }),
      gh: async () => "[]",
      fetchHumanPr: () => {},
      panelJudge: () => async () => ({ ok: true as const, text: JSON.stringify({ candidates: {}, ranking: [], reason: "r" }) }),
    };
    const { report } = await rescoreBacktest(config, { runDir, signal: new AbortController().signal, log: () => {}, scoreDeps });

    // The first trial and each repeat are scored rounds of their own, each with its panel's seed.
    expect(report.scores?.map((score) => `${score.ticket} ${score.repeat} ${score.judge?.seed}`)).toEqual(["OA-123 undefined s"]);
    expect(report.repeatScores?.map((score) => `${score.ticket} r${score.repeat} ${score.judge?.seed}`)).toEqual(["OA-123 r1 s/r1", "OA-123 r2 s/r2"]);
    for (const repeat of [1, 2]) {
      expect(JSON.parse(readFileSync(join(runDir, "OA-123", `scores-r${repeat}.json`), "utf8"))).toEqual(report.repeatScores![repeat - 1]);
    }
    const md = readFileSync(join(runDir, "report.md"), "utf8");
    expect(md).toContain("| OA-123 | B | 1/3 | 0 |");
    // The verdict is the first trial's: the summary counts it alone.
    expect(md).toContain("- Arm B: 1/1 green PRs");
  });

  it("runs the analyst over the scored report, keeps analysis.json and adds the section (#801)", async () => {
    const { root, source } = appFixture([]);
    const runDir = join(root, "run");
    const config: BacktestConfig = {
      project: source, clerk: "clara", sample: { cap: 1, since: null, repos: null }, lineup: null,
      caps: { trialMinutes: 2, batchMinutes: 5 }, rates: null, sources: { "your-org/your-repo": source },
      scoring: { testGlobs: ["**/*.test.ts"], testCommand: "true {file}", setup: null, review: false, judge: null, analyst: { model: "claude-sonnet-5-5" } },
    };
    const sample = { tickets: [ticket()], skipped: [], notes: [], arms: { b: "live lineup" as const, c: null } };
    const row = {
      ticket: "OA-123", arm: "b", lineup: "live", outcome: "green-pr", detail: "DONE", gates: [], weakening: [], reviewRounds: 0, reviewThreads: 0,
      wallSeconds: 60, tokens: null, cost: { usd: null, source: "unknown" }, artifacts: "OA-123/b", models: [], heads: { base: null, first: null, final: null },
    };
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "state.json"), JSON.stringify({ version: 1, id: "bt", startedAt: "2026-10-28T00:00:00Z", config, sample, rows: { "OA-123/b": row } }));
    writeFileSync(join(runDir, "report.json"), JSON.stringify({ id: "bt", startedAt: "s", finishedAt: "f", arms: sample.arms, rows: [row], skipped: [], notes: [], stoppedBy: null }));
    const asked: { model: string; prompt: string }[] = [];
    const scoreDeps = {
      review: async () => ({ status: "unavailable" as const, reason: "stub", base: null, head: null }),
      gh: async () => "[]",
      fetchHumanPr: () => {},
      analyst: (opts: { model: string }) => async (prompt: string) => {
        asked.push({ model: opts.model, prompt });
        return { ok: true as const, text: JSON.stringify({ summary: "B handed off fast.", improvements: [{ knob: "lineup", target: "executor", change: "Try Sonnet.", arm: "b", evidence: ["OA-123"] }] }) };
      },
    };
    const result = await rescoreBacktest(config, { runDir, signal: new AbortController().signal, log: () => {}, scoreDeps });
    expect(asked.map((call) => call.model)).toEqual(["claude-sonnet-5-5"]);
    expect(asked[0]!.prompt).toContain("- arm b: green-pr — DONE");
    expect(result.report.analysis).toMatchObject({ status: "ok", improvements: [{ knob: "lineup", change: "Try Sonnet." }] });
    expect(JSON.parse(readFileSync(join(runDir, "analysis.json"), "utf8"))).toEqual(result.report.analysis);
    expect(readFileSync(join(runDir, "report.md"), "utf8")).toContain("- **lineup · executor** (arm b; OA-123): Try Sonnet.");
  });

  it("turns an old-style failed row green when its only failing gate is base-red", async () => {
    const { root, source, env, git } = appFixture([]);
    const sha = (cwd: string) => spawnSync("git", ["rev-parse", "HEAD"], { cwd, env, encoding: "utf8" }).stdout.trim();
    // The merge base's test gate already fails one test: the input-guard of OA-481.
    const config0 = JSON.parse(readFileSync(join(source, ".ralph", "config.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(source, ".ralph", "config.json"), JSON.stringify({ ...config0, gates: { test: "sh check.sh" } }, null, 2));
    writeFileSync(join(source, "check.sh"), "echo ' FAIL  src/guard.test.ts > input guard > rejects'\nexit 1\n");
    git(source, ["add", "."]);
    git(source, ["commit", "--quiet", "-m", "red base"]);
    const mergeBase = sha(source);
    git(source, ["checkout", "--quiet", "-b", "arm-b"]);
    writeFileSync(join(source, "work.txt"), "the agent's work\n");
    git(source, ["add", "."]);
    git(source, ["commit", "--quiet", "-m", "agent work"]);
    const final = sha(source);
    git(source, ["checkout", "--quiet", "main"]);
    const runDir = join(root, "run");
    mkdirSync(join(runDir, "OA-123", "b"), { recursive: true });
    git(source, ["bundle", "create", "--quiet", join(runDir, "OA-123", "b", "arm.bundle"), "arm-b"]);
    git(source, ["branch", "--quiet", "-D", "arm-b"]);

    const config: BacktestConfig = {
      project: source, clerk: "clara", sample: { cap: 1, since: null, repos: null }, lineup: null,
      caps: { trialMinutes: 2, batchMinutes: 5 }, rates: null, sources: { "your-org/your-repo": source },
      scoring: { testGlobs: ["**/*.test.ts"], testCommand: "true {file}", setup: null, review: false, judge: null, analyst: null },
    };
    const sample = { tickets: [ticket({ mergeBase })], skipped: [], notes: [], arms: { b: "live lineup" as const, c: null } };
    const row = {
      ticket: "OA-123", arm: "b", lineup: "live", outcome: "failed", detail: "failing checks: trial/test FAILURE; <ralph>RETRY_LATER</ralph>",
      gates: [{ name: "trial/typecheck", conclusion: "SUCCESS" }, { name: "trial/test", conclusion: "FAILURE" }, { name: "trial/build", conclusion: "SUCCESS" }],
      weakening: [], reviewRounds: 0, reviewThreads: 0, wallSeconds: 60, tokens: null, cost: { usd: null, source: "unknown" },
      artifacts: "OA-123/b", models: [], heads: { base: mergeBase, first: final, final },
    };
    writeFileSync(join(runDir, "state.json"), JSON.stringify({ version: 1, id: "bt", startedAt: "2026-10-28T00:00:00Z", config, sample, rows: { "OA-123/b": row } }));
    const report = { id: "bt", startedAt: "2026-10-28T00:00:00Z", finishedAt: "2026-10-28T01:00:00Z", arms: sample.arms, rows: [row], skipped: [], notes: [], stoppedBy: null };
    writeFileSync(join(runDir, "report.json"), JSON.stringify(report));
    const state = readFileSync(join(runDir, "state.json"), "utf8");
    const logged: string[] = [];
    const scoreDeps = {
      review: async () => ({ status: "unavailable" as const, reason: "stub", base: null, head: null }),
      gh: async () => "[]",
      fetchHumanPr: () => {},
    };
    await rescoreBacktest(config, { runDir, signal: new AbortController().signal, log: (line) => logged.push(line), scoreDeps });

    const saved = JSON.parse(readFileSync(join(runDir, "report.json"), "utf8")) as { rows: { outcome: string; detail: string; gates: { name: string; conclusion: string; baseRed?: string[] }[] }[] };
    expect(saved.rows[0]!.outcome).toBe("green-pr");
    expect(saved.rows[0]!.detail).toMatch(/^green apart from base-red tests/);
    expect(saved.rows[0]!.detail).toContain("<ralph>RETRY_LATER</ralph>");
    expect(saved.rows[0]!.gates[1]).toEqual({ name: "trial/test", conclusion: "SUCCESS", baseRed: ["src/guard.test.ts > input guard > rejects"] });
    expect(logged).toContain("OA-123/b: failed → green-pr, base-red only");
    expect(readFileSync(join(runDir, "report.md"), "utf8")).toContain("### Base-red gates");
    // The batch's own record is left as it ran.
    expect(readFileSync(join(runDir, "state.json"), "utf8")).toBe(state);
  });

  it("refuses a sample repo with no checkout", async () => {
    const { root, source } = appFixture([]);
    const runDir = join(root, "run");
    const config: BacktestConfig = {
      project: source, clerk: "clara", sample: { cap: 1, since: null, repos: null }, lineup: null,
      caps: { trialMinutes: 2, batchMinutes: 5 }, rates: null, sources: {},
      scoring: { testGlobs: ["**/*.test.ts"], testCommand: "true {file}", setup: null, review: false, judge: null, analyst: null },
    };
    const sample = { tickets: [ticket()], skipped: [], notes: [], arms: { b: "live lineup" as const, c: null } };
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "state.json"), JSON.stringify({ version: 1, id: "bt", startedAt: "x", config, sample, rows: {} }));
    writeFileSync(join(runDir, "report.json"), "{}");
    await expect(rescoreBacktest(config, { runDir, signal: new AbortController().signal, log: () => {} })).rejects.toThrow(/no checkout of your-org\/your-repo/);
  });
});

describe("pinOverlays", () => {
  it("records each arm's overlay hash once, and refuses a resume whose overlay changed (#801)", () => {
    const runDir = scratchDir("overlay-pin-");
    pinOverlays(runDir, { short: "aaa" });
    expect(JSON.parse(readFileSync(join(runDir, "overlays.json"), "utf8"))).toEqual({ short: "aaa" });
    pinOverlays(runDir, { short: "aaa" });
    expect(() => pinOverlays(runDir, { short: "bbb" })).toThrow("arm short's prompt overlay changed since this run started");
    // No overlay, no file.
    const plain = scratchDir("overlay-pin-");
    pinOverlays(plain, {});
    expect(existsSync(join(plain, "overlays.json"))).toBe(false);
  });
});

describe("writeScoredReport (#859)", () => {
  const MEASURED = "2026-11-19T04:00:00Z";
  const config = (project: string, noiseFloor?: BacktestConfig["noiseFloor"]): BacktestConfig => ({
    project, clerk: "clara", sample: { cap: 1, since: null, repos: null }, lineup: null,
    caps: { trialMinutes: 2, batchMinutes: 5 }, rates: null, sources: {},
    scoring: { testGlobs: [], testCommand: "true {file}", setup: null, review: false, judge: null, analyst: null },
    ...(noiseFloor === undefined ? {} : { noiseFloor }),
  });
  const reads: NoiseReads = { floors: () => [], staleShare: () => 0.2 };
  const thresholds = () => ({ maxCostRise: 0.15, minTokenCut: 0.1 });
  // A set run must never reach the real set reader (it fetches origin): these stubs stand in for it.
  const uncalibrated = (): CalibratedCase[] => [];

  it("stores the floor beside a finished floor run's report, and the report says it is one", () => {
    const runDir = scratchDir("noise-floor-run-");
    const report = writeScoredReport(runDir, config(runDir, { measuredAt: MEASURED }), noiseFloorReport(), reads, thresholds, uncalibrated);
    expect(report.noiseFloor).toEqual({ measuredAt: MEASURED });
    expect(JSON.parse(readFileSync(join(runDir, NOISE_FLOOR_FILE), "utf8"))).toEqual(measureFloor(noiseFloorReport(), MEASURED));
    expect(JSON.parse(readFileSync(join(runDir, "report.json"), "utf8")).noiseFloor).toEqual({ measuredAt: MEASURED });
    expect(readFileSync(join(runDir, "report.md"), "utf8")).toContain("## Noise floor");
  });

  it("stores no floor for a stopped floor run or a run that is not one", () => {
    const stopped = scratchDir("noise-floor-stopped-");
    writeScoredReport(stopped, config(stopped, { measuredAt: MEASURED }), { ...noiseFloorReport(), stoppedBy: "batch-cap" }, reads, thresholds, uncalibrated);
    expect(existsSync(join(stopped, NOISE_FLOOR_FILE))).toBe(false);
    expect(existsSync(join(stopped, "report.json"))).toBe(true);

    const later = scratchDir("noise-floor-later-");
    const report = writeScoredReport(later, config(later), mixedSetReport(), reads, thresholds, uncalibrated);
    expect(existsSync(join(later, NOISE_FLOOR_FILE))).toBe(false);
    expect(report.noise?.state).toBe("missing");
    expect(JSON.parse(readFileSync(join(later, "report.json"), "utf8")).noise.state).toBe("missing");
    expect(readFileSync(join(later, "report.md"), "utf8")).toContain("## Against the noise floor");
  });

  it("stamps the guardrail verdict with the project's thresholds, and none on a floor run (#871)", () => {
    const later = scratchDir("guardrails-later-");
    const seen: string[] = [];
    const cases = [{ id: "case-kept", live: { result: "pass" as const }, proposal: { result: "pass" as const } }];
    const report = writeScoredReport(later, config(later), guardrailReport(cases), reads, (project) => {
      seen.push(project);
      return { maxCostRise: 0.5, minTokenCut: 0.2 };
    }, uncalibrated);
    expect(seen).toEqual([later]);
    expect(report.guardrails?.goals.map((goal) => goal.goal)).toEqual(["quality", "cost"]);
    expect(report.guardrails?.goals.find((goal) => goal.goal === "cost")?.conditions.find((c) => c.id === "tokens-down")?.reason).toContain("needs at most -20%");
    expect(JSON.parse(readFileSync(join(later, "report.json"), "utf8")).guardrails.baseline).toBe("live");
    expect(readFileSync(join(later, "report.md"), "utf8")).toContain("## Guardrails");

    const floorRun = scratchDir("guardrails-floor-");
    const floored = writeScoredReport(floorRun, config(floorRun, { measuredAt: MEASURED }), noiseFloorReport(), reads, () => ({ maxCostRise: 0.15, minTokenCut: 0.1 }), uncalibrated);
    expect(floored.guardrails).toBeUndefined();
  });

  it("stamps a set run's judge accuracy from the set's calibration verdicts, and none when the set is unreadable (#877)", () => {
    const later = scratchDir("judge-accuracy-later-");
    const seen: string[] = [];
    const verdict = { arms: ["b", "c"] as [string, string], axis: "correctness" as const, preferred: "b", reason: "b is right", by: "op", at: "2026-11-19T00:00:00Z" };
    const report = writeScoredReport(later, config(later), mixedSetReport(), reads, thresholds, (project) => {
      seen.push(project);
      return [{ id: "case-tests", calibration: [verdict] }];
    });
    expect(seen).toEqual([later]);
    expect(report.judgeAccuracy?.overall).toEqual({ agree: 1, total: 1, accuracy: 1 });
    expect(report.judgeAccuracy?.checks).toEqual([{ case: "case-tests", axis: "correctness", arms: ["b", "c"], preferred: "b", panel: "b", outcome: "agree" }]);
    expect(JSON.parse(readFileSync(join(later, "report.json"), "utf8")).judgeAccuracy.overall.total).toBe(1);

    const unread = scratchDir("judge-accuracy-unread-");
    const plain = writeScoredReport(unread, config(unread), mixedSetReport(), reads, thresholds, () => null);
    expect(plain.judgeAccuracy).toBeUndefined();
    expect(JSON.parse(readFileSync(join(unread, "report.json"), "utf8"))).not.toHaveProperty("judgeAccuracy");

    // A floor run and a run off the set never read the set at all.
    const never = () => {
      throw new Error("the set must not be read");
    };
    const floorRun = scratchDir("judge-accuracy-floor-");
    expect(writeScoredReport(floorRun, config(floorRun, { measuredAt: MEASURED }), noiseFloorReport(), reads, thresholds, never).judgeAccuracy).toBeUndefined();
    const offSet = scratchDir("judge-accuracy-off-set-");
    const { set: _set, ...notSet } = mixedSetReport();
    expect(writeScoredReport(offSet, config(offSet), notSet, reads, thresholds, never).judgeAccuracy).toBeUndefined();
  });
});
