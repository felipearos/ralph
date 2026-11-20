/**
 * Scratch-machine fixtures shared by the adapter and HTTP suites.
 *
 * Test infrastructure, not shipped code, but kept out of `*.test.ts` so both
 * suites can drive the same fake `git`, project config and worktree state
 * without two divergent copies of it.
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `removeScratchDir` moved to `test-tmp.ts` with #271, so `test-scratch.ts`'s
// `scratchDir` can use the same retry; it is re-exported here because this is
// where every caller has always imported it from.
import { removeScratchDir } from "../test-tmp";

export { removeScratchDir };

const scratchRoots: string[] = [];
/** Distinguishes one `fakeBun` staging file from the next within a process. */
let counter = 0;

export function cleanupFixtures(): void {
  scratchRoots.splice(0).forEach((dir) => removeScratchDir(dir));
}

/**
 * Wait until none of `pids` is running, for at most `timeoutMs`; SIGKILL any
 * left after that. For teardown that has just signalled its own fake
 * processes and must not remove their directory under them.
 */
export async function waitForExit(pids: number[], timeoutMs = 10_000): Promise<void> {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + timeoutMs;
  while (pids.some(alive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const pid of pids.filter(alive)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

/** The bun running this suite, by absolute path — PATH is replaced in fixtures. */
export function bunPath(): string {
  try {
    return execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
  } catch {
    return process.execPath;
  }
}

/** The real git, by absolute path — the fixture's fake `git` shadows it on PATH. */
export function realGitPath(): string {
  try {
    return execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  } catch {
    return "git";
  }
}

export interface Fixture {
  root: string;
  bin: string;
  worktree: (name: string) => string;
  registry: (paths: string[]) => void;
  fakeBun: (body: string) => string;
  /** What the fake `gh issue list` prints. Defaults to `[]`. */
  githubIssues: (issues: unknown) => void;
  /** Make the fake `gh` exit non-zero, as an unauthenticated one does. */
  githubFails: () => void;
  /** The argv each fake `gh` call received, one line per call. */
  githubCalls: () => string[];
  /** Each fake `gh` call with the directory it ran in, to tell projects' reads apart. */
  githubCallsIn: () => { dir: string; args: string }[];
  /** Write the lease store `claim-lease status` reads under this root. */
  leases: (leases: Record<string, unknown>[], version?: number) => void;
  /**
   * A second project root on the same scratch machine, sharing the fake
   * `git`/`gh`: a main checkout at `<root>/<name>` with its own worktree
   * registry, answered when `git worktree list` runs there.
   */
  project: (name: string, loops?: RosterFixture) => FixtureProject;
}

/** A roster as `.ralph/config.json` spells it: loop names, or `{ name, role }` entries. */
export type RosterFixture = (string | { name: string; role?: string })[];

/**
 * A project's committed `.ralph/config.json`, which the dashboard reads the
 * roster from through `project-config --json`. `loops` defaults to the four
 * loggd runs.
 */
export function writeProjectConfig(root: string, loops: RosterFixture = ["ralph", "rafa", "remo", "rulo"]): void {
  mkdirSync(join(root, ".ralph"), { recursive: true });
  writeFileSync(
    join(root, ".ralph", "config.json"),
    JSON.stringify({
      repo: "your-org/your-repo",
      owner: "your-github-login",
      baseBranch: "main",
      displayName: "Fixture",
      secrets: { runner: "none", withhold: [] },
      refuseFiles: [],
      envCheck: [],
      requiredChecks: [],
      gates: {},
      promptFragment: ".ralph/prompt.md",
      coderFragment: ".ralph/coder.md",
      plan: ".ralph/plan.md",
      journal: { dir: "journal/fixture" },
      loops,
    }),
  );
}

/**
 * A scratch project that is nothing but its config. The harness checkout a
 * suite runs from is no project, so a suite that reads the roster in-process
 * points `RALPH_PROJECT` here.
 */
export function scratchProject(label: string, loops?: RosterFixture): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `ralph-${label}-project-`)));
  scratchRoots.push(root);
  writeProjectConfig(root, loops);
  return root;
}

/**
 * An empty scratch directory, made and registered for {@link cleanupFixtures}
 * without spawning anything — unlike {@link createFixture}, which looks up the
 * real git. For suites that script every read and need only a root on disk.
 */
export function scratchRoot(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `ralph-${label}-root-`)));
  scratchRoots.push(root);
  return root;
}

export interface FixtureProject {
  /** The project's main checkout: a `.git` directory, as a clone leaves one. */
  root: string;
  /** A linked worktree of the project, as `git worktree add` leaves one. */
  worktree: (name: string) => string;
  registry: (paths: string[]) => void;
}

/** `git worktree list --porcelain` for these paths. */
const porcelain = (paths: string[]): string =>
  `${paths.flatMap((path) => [`worktree ${path}`, "HEAD abc1234", "branch refs/heads/main", ""]).join("\n")}\n`;

/** Where a fixture project keeps the worktree list its fake `git` answers with. */
const PROJECT_REGISTRY = ".fixture-worktrees";

export function createFixture(label: string): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `loggd-dashboard-${label}-`)));
  scratchRoots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  // Dashboard startup warms the harness catalogs. Keep those probes inside
  // the fixture: real CLIs can install packages into its HOME after teardown.
  for (const runner of ["claude", "codex", "opencode"]) {
    const executable = join(bin, runner);
    writeFileSync(executable, "#!/bin/sh\nexit 1\n");
    chmodSync(executable, 0o755);
  }

  const registryFile = join(root, "registry.txt");
  writeFileSync(registryFile, "");
  writeProjectConfig(root);
  writeFileSync(
    join(bin, "git"),
    [
      "#!/bin/sh",
      // Journal reads go to a real repository (`createJournalRepo`); only the
      // worktree registry and branch lookups are faked.
      `if [ "$1" = "-C" ]; then case "$3" in ls-tree|cat-file) exec ${JSON.stringify(realGitPath())} "$@";; esac; fi`,
      'if [ "$1 $2" = "worktree list" ]; then',
      // A project made by `project()` answers with its own list.
      `  list=${JSON.stringify(registryFile)}; here=$(pwd -P); if [ -e "$here/${PROJECT_REGISTRY}" ]; then list="$here/${PROJECT_REGISTRY}"; fi`,
      `  while IFS= read -r line; do printf '%s\\n' "$line"; done < "$list"`,
      "  exit 0",
      "fi",
      'if [ "$1" = "symbolic-ref" ]; then printf \'%s\\n\' "ralph/919-scaffold"; exit 0; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "git"), 0o755);
  // A fake `gh` is always installed: the real one would reach the network from
  // every suite that builds a snapshot.
  const ghIssues = join(root, "gh-issues.json");
  const ghFail = join(root, "gh-fail");
  const ghCalls = join(root, "gh-calls.txt");
  const ghCallsIn = join(root, "gh-calls-in.txt");
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(ghCalls)}`,
      `printf '%s\\t%s\\n' "$(pwd -P)" "$*" >> ${JSON.stringify(ghCallsIn)}`,
      `if [ -e ${JSON.stringify(ghFail)} ]; then echo "gh: not logged in" >&2; exit 4; fi`,
      // The frontier's open-issue census is one GraphQL read; answer it with an empty page.
      `if [ "$1 $2" = "api graphql" ]; then echo '{"data":{"repository":{"issues":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}'; exit 0; fi`,
      `if [ -e ${JSON.stringify(ghIssues)} ]; then cat ${JSON.stringify(ghIssues)}; else echo "[]"; fi`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "gh"), 0o755);
  return {
    root,
    bin,
    // A worktree is a checkout of the project, so it carries the committed
    // config — and with it the roster the observer reads branches against.
    worktree: (name: string): string => {
      const path = join(root, name);
      mkdirSync(join(path, ".ralph", "logs"), { recursive: true });
      writeProjectConfig(path);
      return path;
    },
    registry: (paths: string[]): void => writeFileSync(registryFile, porcelain(paths)),
    fakeBun: (body: string): string => {
      const path = join(bin, "bun");
      // Swapped in by rename, never truncated in place: a suite that rewrites
      // the fake mid-run (to make one read fail, then restore it) would
      // otherwise let a still-running child read a half-written script, which
      // exits without exec'ing bun and looks like contract drift.
      const staging = `${path}.${process.pid}.${(counter += 1)}`;
      writeFileSync(staging, body);
      chmodSync(staging, 0o755);
      renameSync(staging, path);
      return path;
    },
    githubIssues: (issues: unknown): void => writeFileSync(ghIssues, JSON.stringify(issues)),
    githubFails: (): void => writeFileSync(ghFail, ""),
    githubCalls: (): string[] => {
      try {
        return readFileSync(ghCalls, "utf8").split("\n").filter((line) => line !== "");
      } catch {
        return [];
      }
    },
    githubCallsIn: (): { dir: string; args: string }[] => {
      try {
        return readFileSync(ghCallsIn, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => {
            const [dir, ...args] = line.split("\t");
            return { dir: dir!, args: args.join("\t") };
          });
      } catch {
        return [];
      }
    },
    // The fake `git` answers `rev-parse --git-common-dir` with nothing, so the
    // lease CLI falls back to `<root>/.ralph-claim-leases.json`.
    leases: (leases: Record<string, unknown>[], version = 1): void =>
      writeFileSync(
        join(root, ".ralph-claim-leases.json"),
        JSON.stringify({
          version,
          leases: Object.fromEntries(leases.map((lease) => [String(lease.issue), lease])),
        }),
      ),
    project: (name: string, loops?: RosterFixture): FixtureProject => {
      const main = join(root, name);
      mkdirSync(join(main, ".git", "worktrees"), { recursive: true });
      mkdirSync(join(main, ".ralph", "logs"), { recursive: true });
      writeProjectConfig(main, loops);
      writeFileSync(join(main, PROJECT_REGISTRY), porcelain([]));
      return {
        root: main,
        worktree: (worktree: string): string => {
          const path = join(root, `${name}-${worktree}`);
          mkdirSync(join(path, ".ralph", "logs"), { recursive: true });
          writeProjectConfig(path, loops);
          mkdirSync(join(main, ".git", "worktrees", worktree), { recursive: true });
          writeFileSync(join(path, ".git"), `gitdir: ${join(main, ".git", "worktrees", worktree)}\n`);
          return path;
        },
        registry: (paths: string[]): void => writeFileSync(join(main, PROJECT_REGISTRY), porcelain(paths)),
      };
    },
  };
}

/** A complete lease record, as `claim-lease.ts` writes one. */
export function leaseRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    issue: 919,
    run: "run-ralph",
    owner: "ralph@test",
    loop: "ralph",
    pid: null,
    host: "test",
    worktree: "/checkout/ralph",
    branch: "ralph/919-scaffold",
    claim: "ralph-wip",
    logs: ".ralph/logs",
    usageLedger: ".ralph/logs/usage-ledger.tsv",
    claimedAt: "2026-09-13T11:00:00.000Z",
    heartbeatAt: "2026-09-13T11:59:00.000Z",
    expiresAt: "2026-09-13T12:01:00.000Z",
    leaseMs: 120_000,
    attempt: 1,
    history: [],
    ...over,
  };
}

/** One stage boundary as the harness appends it to an iteration's event timeline. */
export interface StageBoundary {
  stage: string;
  state: "started" | "completed" | "failed" | "degraded";
  invocation: string;
  runner: string;
  model: string;
  at: string;
}

/**
 * Write the iteration timeline `observe` projects actors from. Keyed on the
 * same run and iteration `writeLoopState` records, so the real CLI selects it.
 */
export function writeTimeline(
  worktree: string,
  over: { loop?: string; run?: string; iteration?: number; boundaries: StageBoundary[] },
): void {
  const run = over.run ?? `run-${over.loop ?? "ralph"}`;
  const iteration = over.iteration ?? 3;
  const lines = over.boundaries.map((boundary) =>
    JSON.stringify({
      type: "ralph_stage",
      ralph_stage: boundary.stage,
      state: boundary.state,
      invocation: boundary.invocation,
      runner: boundary.runner,
      model: boundary.model,
      ralph_received_at: boundary.at,
      ralph_iteration: iteration,
      ralph_run: run,
    }),
  );
  writeFileSync(
    join(worktree, ".ralph", "logs", `iter-${run}-${iteration}.events.jsonl`),
    `${lines.join("\n")}\n`,
  );
}

export function writeLoopState(
  worktree: string,
  over: {
    loop?: string;
    run?: string;
    stage?: string;
    heartbeat?: string;
    /** Override the recorded path, to make a copied/moved record `foreign`. */
    recordedWorktree?: string;
    /** The last event's detail; `ralph.sh` records `session <uuid>` at iteration-start. */
    detail?: string;
    /** The iteration's session, as the record keeps it once the detail has moved on. */
    session?: string;
  } = {},
): void {
  const heartbeat = over.heartbeat ?? new Date().toISOString();
  const state = {
    version: 1,
    run: over.run ?? `run-${over.loop ?? "ralph"}`,
    owner: { loop: over.loop ?? "ralph", pid: null, host: "test" },
    worktree: over.recordedWorktree ?? realpathSync(worktree),
    branch: "ralph/919-scaffold",
    stage: over.stage ?? "iteration",
    iteration: { index: 3, max: 50 },
    heartbeat,
    lastEvent: {
      name: "iteration-start",
      at: heartbeat,
      ...(over.detail === undefined ? {} : { detail: over.detail }),
    },
    stopReason: null,
    ...(over.session === undefined ? {} : { session: over.session }),
  };
  writeFileSync(join(worktree, ".ralph", "logs", "state.json"), JSON.stringify(state));
}

/**
 * Append one observation to the worktree's runner-failure ledger, as
 * `runner-failure.ts observe` writes it. Returns the row written.
 */
export function writeRunnerFailure(
  worktree: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const row = {
    version: 1,
    at: "2026-09-13T11:30:00.000Z",
    host: "test",
    loop: "ralph",
    run: "run-ralph",
    attempt: { iteration: 3, session: null },
    stage: "executor",
    runner: "claude",
    model: "opus",
    owner: null,
    issue: 919,
    exitCode: 1,
    kind: "api-error",
    summary: "the provider answered with an error",
    visibility: "post-hoc",
    signals: [{ kind: "api-error", evidence: "overloaded_error: try again later", visibility: "post-hoc" }],
    log: null,
    signalsFile: null,
    note: null,
    ...over,
  };
  appendFileSync(join(worktree, ".ralph", "logs", "runner-failures.jsonl"), `${JSON.stringify(row)}\n`);
  return row;
}

/** One assistant turn as Claude Code writes it into a session transcript. */
export const assistantTurn = (
  id: string,
  model: string,
  usage: Record<string, number>,
): unknown => ({
  type: "assistant",
  timestamp: "2026-09-13T12:00:00Z",
  message: { id, model, usage },
});

/** A session transcript where `usage.py` looks for it: `$HOME/.claude/projects/<slug>/`. */
export function writeTranscript(
  home: string,
  worktree: string,
  session: string,
  records: unknown[],
): void {
  const slug = realpathSync(worktree).replaceAll("/", "-").replaceAll(".", "-").replaceAll("_", "-");
  const dir = join(home, ".claude", "projects", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${session}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}

/**
 * A real git repository standing in for the harness checkout: the journal
 * entries committed under `dir`, with `origin/main` pointing at them unless
 * `origin` is false. A non-entry file sits beside them, as the README does.
 */
export function createJournalRepo(
  parent: string,
  dir: string,
  entries: { name: string; body: string }[],
  { origin = true }: { origin?: boolean } = {},
): string {
  const repo = join(parent, "harness");
  mkdirSync(join(repo, dir), { recursive: true });
  const git = (...args: string[]): string =>
    execFileSync(
      realGitPath(),
      ["-C", repo, "-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  git("init", "--quiet");
  writeFileSync(join(repo, dir, "README.md"), "not an entry\n");
  for (const entry of entries) writeFileSync(join(repo, dir, entry.name), entry.body);
  git("add", "-A");
  git("commit", "--quiet", "--no-verify", "-m", "journal");
  if (origin) git("update-ref", "refs/remotes/origin/main", "HEAD");
  return repo;
}
