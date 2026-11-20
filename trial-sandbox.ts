/**
 * A trial: one real, unmodified `ralph.sh` coder iteration on one ticket, in
 * a scratch sandbox from which nothing leaves the host (issue #530, spec #525).
 *
 * The iteration is the harness's own, so every channel it talks through has to
 * be a local stand-in before it starts: `gh` is the fake (`fake-gh.ts`), the
 * tracker is a file (`tracker/local.ts`), `origin` is a bare repo in the
 * scratch dir, plugins are off, and the journal publishes into a repository
 * with no remote. The work tree is a plain clone with its own git common dir,
 * so leases, claim locks and loop state never land in the source repo's or a
 * live loop's.
 *
 * The harness is staged too: a copy that is not a git repository, because
 * `ralph.sh` fetches its own checkout's origin whenever RALPH_HOME is one, and
 * that fetch reaches GitHub and moves the live harness's refs.
 *
 * Each pushed head is reviewed by the local Revisión Claude by default (real
 * model calls per head), capped at REVIEW_ROUND_CAP rounds.
 *
 * It fails closed. `trialPreflight` checks each channel as a fact read from
 * the sandbox, and any fact it cannot read is a refusal: `runTrial` never
 * spawns `ralph.sh` past one. A trial that reached GitHub, a real tracker or a
 * Slack channel would be a loop acting on a project nobody asked it to touch.
 */
import { spawn, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { recordBase, runGates, type BaseRed } from "./base-red";
import { groupAlive, reapGroup } from "./experiments";
import { FAKE_GH_BIN, stopHookRunners } from "./fake-gh";
import { READY_LABEL } from "./frontier/next-tasks";
import { envNameFor, runnerEnvNameFor, type Stage } from "./models";
import { requiredLabels, roleLabels } from "./preflight";
import { loadProjectConfig, validateProjectConfig } from "./project-config";
import { projectIdFor } from "./project-id";
import { applyOverlay } from "./prompt-overlay";
import { WORKFLOW_PATH } from "./local-review";
import { buildRedactor } from "./runner-failure";
import { readSpeedLedger, type SpeedEvent } from "./speed";
import { seedLocalTracker, type LocalSeedIssue } from "./tracker/local";
import { summarizeReview, type TrialReview } from "./trial-review";

/** This module's directory: the harness a trial runs unless told otherwise. */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Config blocks that configure a role the trial's single-coder roster does
 * not have. The validator refuses each one without its role on the roster.
 */
const OTHER_ROLE_BLOCKS = ["ciDoctor", "prMedic", "clerk", "verifier", "sentinel", "triage"] as const;

/** The trial's loop name when the caller names none; a lineup resolved for a trial resolves for this loop. */
export const TRIAL_LOOP_NAME = "trial";

export interface TrialStage {
  model: string;
  runner?: string;
  effort?: string;
}

export interface TrialOptions {
  /**
   * The app's git repository. Only read: everything a trial writes is under
   * its scratch dir. Its working tree's `.ralph/` is the project config the
   * trial runs with, so point it at a live loop's checkout.
   */
  source: string;
  /** A commit-ish in `source` the trial starts from: the app code, not its `.ralph/`. */
  base: string;
  ticket: LocalSeedIssue;
  loopName?: string;
  trackerKey?: string;
  /** Stage (as `models.ts` spells it) → model, runner and effort for this run. */
  lineup?: Partial<Record<Stage, TrialStage>>;
  /** The harness to stage a copy of; this module's checkout by default. Never run in place. */
  harness?: string;
  /** A prompt overlay (`prompt-overlay.ts`) laid over the staged harness: an arm that varies the prompts (#801). */
  overlay?: string | null;
  /**
   * The fake gh's checks command. By default the project's gates, one
   * `trial/<gate>` check each, and the sandbox's `requiredChecks` become those
   * names. A caller-supplied command keeps the project's `requiredChecks`: it
   * must report checks under those names, or the PR wait never goes green.
   * Either way `fake-gh/review` is added to them whenever a review runs.
   */
  checksCommand?: string;
  /**
   * The fake gh's findings command. By default the staged harness's local
   * Revisión Claude (`localReviewFindingsCommand`); `null` runs no review.
   */
  findingsCommand?: string | null;
  /** The review rounds a PR gets before new heads go unreviewed; `REVIEW_ROUND_CAP` by default. */
  reviewRounds?: number;
  /**
   * Run in the base's own clone before its gates are recorded (the backtest's
   * `scoring.setup`, e.g. `npm ci`). Never run in the work tree: the iteration
   * must find it exactly as a fresh clone.
   */
  setup?: string | null;
  /** The bound on the base's gate run; {@link BASE_GATES_TIMEOUT_MS} by default. */
  baseGatesTimeoutMs?: number;
  /** Test-only: the HOME the run sees. */
  home?: string;
  scratchParent?: string;
  /** The id the lineup and the harness's per-project blocks are keyed by; the source's own by default. */
  projectId?: string;
}

export interface Trial {
  root: string;
  origin: string;
  work: string;
  /** The sandbox config commit, pushed to `origin`'s base branch: the patch is measured from it. */
  base: string;
  baseBranch: string;
  repo: string;
  loopName: string;
  trackerKey: string;
  trackerFile: string;
  ghState: string;
  tmp: string;
  journalHome: string;
  journalWorktree: string;
  journalLock: string;
  findingsRecord: string;
  log: string;
  /** The staged, non-git copy of the harness that `ralph.sh` runs from. */
  harness: string;
  projectId: string;
  lineup: Partial<Record<Stage, TrialStage>>;
  checksCommand: string | null;
  /** Where the base's red tests are recorded; null when the caller named its own checks or the project has no gates. */
  baseRed: string | null;
  findingsCommand: string | null;
  reviewRounds: number;
  home: string | null;
}

export type Leak = "gh" | "origin" | "tracker" | "plugins" | "harness";
export interface TrialPreflight {
  ok: boolean;
  failures: { leak: Leak; why: string }[];
}

export interface TrialResult {
  /** `failed`: the supervisor could not be started at all. `sigil` is read only for a finished run. */
  outcome: { kind: "finished" | "refused" | "timeout" | "aborted" | "failed"; exit: number | null; sigil: string | null };
  failures: TrialPreflight["failures"];
  base: string;
  finalHead: string | null;
  patch: string;
  logs: { path: string; text: string }[];
  tracker: unknown;
  github: unknown;
  /** The trial PR's review rounds and how each thread was answered; null when no review was configured. */
  review: TrialReview | null;
  models: { stage: string; model: string; runner: string }[];
  /**
   * The trial's own speed ledger (`speed.ts`): its claim, iterations and
   * hand-off, in time order. Absent from a result saved before it existed.
   */
  speed?: SpeedEvent[];
  /**
   * The tests the trial's base already failed (`base-red.ts`), which the
   * checks forgave. Null when none was recorded; absent from an older result.
   */
  baseRed?: BaseRed | null;
}

/** The parent environment with every supervisor and git location variable gone, as `experimentEnv` strips it. */
export function scrubbed(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(RALPH_|GIT_)/.test(key)) delete env[key];
  // The host's GitHub token is no project secret, and nothing in a trial may
  // reach GitHub: an iteration that went round the fake gh would find none.
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

/** git for building the sandbox. The identity is fixed so a host with none configured still builds one. */
function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync("git", ["-c", "user.name=ralph-trial", "-c", "user.email=trial@ralph.invalid", ...args], { cwd, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`trial: git ${args.join(" ")} failed: ${(result.stderr || result.error?.message || "").trim()}`);
  return result.stdout.trim();
}

/** Single-quoted for `sh -c`. */
export const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** How long the base's gates get before the trial goes on without a record. */
export const BASE_GATES_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Run the gates once on the trial's base, in a clone of its own beside `work`,
 * and record the tests already failing there into `out` (issue #579). Without
 * it a base that is already red fails every head's checks, whatever the agent
 * did. Never throws: any failure leaves no record, and the checks then judge
 * each gate by its exit code alone.
 */
async function recordBaseRed(root: string, origin: string, base: string, gates: Record<string, string>, out: string, options: TrialOptions, env: NodeJS.ProcessEnv): Promise<void> {
  const tree = join(root, "base-tree");
  const log = join(root, "base-gates.log");
  const note = (chunk: string) => { try { writeFileSync(log, chunk, { flag: "a" }); } catch { /* a log is a nicety */ } };
  try {
    // Copies, not hardlinks: a commit-graph write in origin mid-clone fails a hardlinked clone (#594).
    git(root, ["clone", "--quiet", "--no-hardlinks", "--no-checkout", origin, tree], env);
    git(tree, ["checkout", "--quiet", "--detach", base], env);
    const bound = options.baseGatesTimeoutMs ?? BASE_GATES_TIMEOUT_MS;
    const deadline = Date.now() + bound;
    if (options.setup) {
      // The async runner, not spawnSync: a long install must not block the event loop the trial's other work shares.
      // A failed setup is not fatal: the gates then fail on their own terms, and are recorded so.
      const [setup] = await runGates({ setup: options.setup }, tree, { timeoutMs: bound, env, stderr: note });
      if (!setup?.ok) note(`trial: base setup failed${setup?.timedOut ? " (timed out)" : ""}\n`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("no time left for the base's gates after setup");
    const record = await recordBase(gates, tree, { timeoutMs: remaining, env, base, stderr: note });
    // Written whole or not at all: a half-written record would read as no record.
    const tmp = `${out}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(tmp, out);
  } catch (error) {
    note(`trial: no base record, gates are judged by exit code: ${error instanceof Error ? error.message : String(error)}\n`);
    rmSync(out, { force: true });
  } finally {
    // It can be large (a whole node_modules), and nothing reads it again.
    rmSync(tree, { recursive: true, force: true });
  }
}

/** How much of a failed base setup's output a not-run case reports: the end, where the error is. */
const BASE_BUILD_TAIL_CHARS = 1_200;

/** A case's merge-base built once before any arm runs (#820). `aborted`: stopped, so it says nothing about the base. */
export type BaseBuild = { ok: true } | { ok: false; reason: string; aborted?: boolean };

/**
 * Clone `source` at `base` and run `setup` in it, once per case before any
 * trial (#820): a base that does not build fails every arm for a reason that
 * has nothing to do with the arm, so the case is refused before a model runs.
 * Only setup is run; red gates on a base that builds are base-red's (#579).
 * Never throws: a clone that fails is a base that does not build.
 */
export async function checkBaseBuild(options: {
  source: string;
  base: string;
  setup: string;
  timeoutMs: number;
  signal?: AbortSignal;
  scratchParent?: string;
  home?: string;
}): Promise<BaseBuild> {
  const env = { ...scrubbed(), ...(options.home ? { HOME: options.home } : {}) };
  let root: string;
  try {
    root = realpathSync(mkdtempSync(join(options.scratchParent ?? tmpdir(), "ralph-base-build-")));
  } catch (error) {
    return { ok: false, reason: `could not make a scratch directory: ${error instanceof Error ? error.message : String(error)}` };
  }
  const tree = join(root, "base");
  try {
    try {
      // Copies, not hardlinks, as the base-red clone (#594).
      git(root, ["clone", "--quiet", "--no-hardlinks", "--no-checkout", resolve(options.source), tree], env);
      git(tree, ["checkout", "--quiet", "--detach", options.base], env);
    } catch (error) {
      return { ok: false, reason: `could not check out the base: ${error instanceof Error ? error.message : String(error)}` };
    }
    const bound = Math.max(0, Math.min(options.timeoutMs, BASE_GATES_TIMEOUT_MS));
    const [run] = await runGates({ setup: options.setup }, tree, { timeoutMs: bound, env, ...(options.signal ? { signal: options.signal } : {}) });
    if (run === undefined || run.aborted) return { ok: false, reason: "the base build was stopped", aborted: true };
    if (run.ok) return { ok: true };
    const tail = run.output.trim().slice(-BASE_BUILD_TAIL_CHARS);
    return { ok: false, reason: `setup ${run.timedOut ? "timed out" : "failed"}${tail === "" ? "" : `:\n${tail}`}` };
  } finally {
    // A whole node_modules, and nothing reads it again: each trial installs in its own clone.
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The review rounds a trial's PR gets. The projects that run Revisión Claude
 * cap them at 5 in their `.ralph/prompt.md` ("Round 5: push nothing more").
 */
export const REVIEW_ROUND_CAP = 5;

/**
 * The fake gh's findings command for the local Revisión Claude in `harness`,
 * reviewing each head against the PR's base in `checkout` (the sandbox's bare
 * origin). `--repo` is passed, so it never reads a remote; a project without
 * the workflow comes back unavailable (exit 3), never as clean.
 */
export function localReviewFindingsCommand(harness: string, checkout: string): string {
  return `bun ${shQuote(join(harness, "local-review.ts"))} --checkout ${shQuote(checkout)} ` +
    `--base "$FAKE_GH_BASE_SHA" --head "$FAKE_GH_HEAD_SHA" --repo "$FAKE_GH_REPO" --fake-gh-findings`;
}

/** Paths a staged harness leaves out: the operator's state and pages, and what only its own tests read. */
const UNSTAGED = /^(dashboard|journal|learnings|backtests|incidents|fixtures|\.ralph|node_modules)(\/|$)|\.test\.ts$/;

/** Every file under `dir`, relative to it, without descending into a nested `.git`. */
function walkFiles(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.name === ".git") return [];
    return entry.isDirectory() ? walkFiles(dir, path) : [path];
  });
}

/**
 * Copy the harness into `dest` as a directory that is not a git repository:
 * its tracked files when it is one (what a deploy carries, not a developer's
 * scratch), else every file. `node_modules` is linked rather than copied.
 */
export function stageHarness(source: string, dest: string, env: NodeJS.ProcessEnv = scrubbed()): void {
  const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: source, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const files = tracked.status === 0 ? tracked.stdout.split("\0").filter((file) => file !== "") : walkFiles(source);
  mkdirSync(dest, { recursive: true });
  for (const file of files) {
    // A tracked file deleted in the working tree is not part of the harness that would run.
    if (UNSTAGED.test(file) || !existsSync(join(source, file))) continue;
    mkdirSync(dirname(join(dest, file)), { recursive: true });
    cpSync(join(source, file), join(dest, file));
  }
  if (existsSync(join(source, "node_modules"))) symlinkSync(realpathSync(join(source, "node_modules")), join(dest, "node_modules"));
}

/** Build a trial's sandbox in a fresh scratch dir; a build that fails leaves nothing behind. */
export async function buildTrial(options: TrialOptions): Promise<Trial> {
  const root = realpathSync(mkdtempSync(join(options.scratchParent ?? tmpdir(), "ralph-trial-")));
  try {
    return await buildTrialIn(root, options);
  } catch (error) {
    // A half-built sandbox is state outside any trial anybody holds.
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/**
 * The project's `.ralph/` (and Revisión Claude's workflow) as the live loop
 * runs it: every file the source tracks there, read from its working tree, so a fragment edited and
 * not yet committed is what the trial gets too. Runtime state is left out.
 * Empty when the source tracks no `.ralph/`; the caller then falls back to the
 * base commit's config.
 */
function liveProjectFiles(source: string, env: NodeJS.ProcessEnv): Map<string, string> {
  const files = new Map<string, string>();
  // Revisión Claude's workflow too: the trial's review rounds read it at the
  // sandbox base, and a base older than the workflow has none to read.
  const tracked = git(source, ["ls-files", "-z", "--", ".ralph", WORKFLOW_PATH], env).split("\0").filter(Boolean);
  for (const path of tracked) {
    if (/^\.ralph\/(logs\/|loop-name$)/.test(path)) continue;
    const onDisk = join(source, path);
    if (!existsSync(onDisk) || !statSync(onDisk).isFile()) continue;
    files.set(path, readFileSync(onDisk, "utf8"));
  }
  return files;
}

async function buildTrialIn(root: string, options: TrialOptions): Promise<Trial> {
  const loopName = options.loopName ?? TRIAL_LOOP_NAME;
  const trackerKey = options.trackerKey ?? "TRIAL";
  const env = { ...scrubbed(), ...(options.home ? { HOME: options.home } : {}) };
  const source = resolve(options.source);
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const trackerFile = join(root, "tracker.json");

  const baseCommit = git(source, ["rev-parse", "--verify", "--quiet", `${options.base}^{commit}`], env);
  const projectFiles = liveProjectFiles(source, env);
  const liveConfig = projectFiles.get(".ralph/config.json");
  const raw = JSON.parse(liveConfig ?? git(source, ["show", `${baseCommit}:.ralph/config.json`], env)) as Record<string, unknown>;
  const baseBranch = raw.baseBranch;
  if (typeof baseBranch !== "string") throw new Error("trial: the project's config names no baseBranch");

  git(root, ["init", "--quiet", "--bare", `--initial-branch=${baseBranch}`, origin], env);
  // A push into origin starts git's auto maintenance there, which may detach
  // and still be rewriting the commit-graph while the clones below copy it
  // (#594). The sandbox is thrown away after one trial, so origin never needs it.
  for (const [key, value] of [["receive.autogc", "false"], ["maintenance.auto", "false"], ["gc.auto", "0"]] as const) {
    git(origin, ["config", key, value], env);
  }
  // A push by sha writes no ref in the source: it is only read. `--no-verify`
  // because a pre-push hook could run a gate suite or write into the source.
  git(source, ["push", "--quiet", "--no-verify", origin, `${baseCommit}:refs/heads/${baseBranch}`], env);
  // Copies, not hardlinks: a commit-graph write in origin mid-clone fails a hardlinked clone (#594).
  git(root, ["clone", "--quiet", "--no-hardlinks", "--branch", baseBranch, origin, work], env);

  const reviewRounds = options.reviewRounds ?? REVIEW_ROUND_CAP;
  // The fake gh refuses a bad cap at its first call, mid-iteration: refuse it here instead.
  if (!Number.isInteger(reviewRounds) || reviewRounds <= 0) throw new Error(`trial: reviewRounds must be a positive integer, not ${reviewRounds}`);
  // The fake gh reads an empty FAKE_GH_FINDINGS_CMD as no review at all, so a
  // blank command would run uncapped and unreviewed while claiming a review.
  if (typeof options.findingsCommand === "string" && options.findingsCommand.trim() === "") {
    throw new Error("trial: findingsCommand must be a command or null, not empty");
  }
  const harness = join(root, "harness");
  const findingsCommand = options.findingsCommand === undefined ? localReviewFindingsCommand(harness, origin) : options.findingsCommand;

  const gates = raw.gates && typeof raw.gates === "object" ? (raw.gates as Record<string, string>) : {};
  // The review is a check too: without it the PR wait can hand back before
  // the threads exist. A capped or unavailable review is NEUTRAL, a skip, so
  // it cannot hold the wait.
  const reviewCheck = findingsCommand !== null ? ["fake-gh/review"] : [];
  const projectChecks = Array.isArray(raw.requiredChecks) ? (raw.requiredChecks as unknown[]) : [];
  const requiredChecks = options.checksCommand === undefined
    ? [...Object.keys(gates).map((name) => `trial/${name}`), ...reviewCheck]
    : [...new Set([...projectChecks, ...reviewCheck])];
  const config: Record<string, unknown> = {
    ...raw,
    // The default checks command reports `trial/<gate>`; a project's own names
    // (`buildkite/loggd`) would never be reported, and the PR wait would hang on them.
    // A caller's checks command keeps the project's names, plus the review's.
    ...(options.checksCommand === undefined || reviewCheck.length > 0 ? { requiredChecks } : {}),
    tracker: { kind: "local", key: trackerKey, file: trackerFile },
    plugins: [],
    merge: "human",
    learnings: false,
    loops: [loopName],
  };
  for (const key of OTHER_ROLE_BLOCKS) delete config[key];
  const problems = validateProjectConfig(config);
  if (problems.length > 0) throw new Error(`trial: the sandbox config does not validate:\n  - ${problems.join("\n  - ")}`);
  // The live loop's fragments over whatever the base carried: the trial asks
  // what the loop would do today, and a base cut before the project was set
  // up (or on a branch the config never landed on) carries none at all.
  for (const [path, content] of projectFiles) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), content);
  }
  writeFileSync(join(work, ".ralph", "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(work, ".ralph", "loop-name"), `${loopName}\n`);
  const ignored = spawnSync("git", ["check-ignore", "--quiet", ".ralph/loop-name"], { cwd: work, env }).status === 0;
  git(work, ["add", ".ralph/config.json", ...projectFiles.keys(), ...(ignored ? [] : [".ralph/loop-name"])], env);
  git(work, ["commit", "--quiet", "-m", "trial: sandbox config"], env);
  git(work, ["push", "--quiet", "origin", `HEAD:refs/heads/${baseBranch}`], env);
  const base = git(work, ["rev-parse", "HEAD"], env);
  // A dirty tree reads to the iteration as unexplained work it must account for.
  const dirty = git(work, ["status", "--porcelain"], env);
  if (dirty !== "") throw new Error(`trial: the work tree is not clean after build:\n${dirty}`);

  const labels = [...requiredLabels(loopName, roleLabels("coder")), READY_LABEL];
  const ticketLabels = options.ticket.labels ?? [];
  await seedLocalTracker(trackerFile, {
    key: trackerKey,
    labels,
    issue: { ...options.ticket, labels: ticketLabels.includes(READY_LABEL) ? ticketLabels : [...ticketLabels, READY_LABEL] },
  });

  const repo = typeof raw.repo === "string" ? raw.repo : "trial/sandbox";
  const ghState = join(root, "gh-state.json");
  writeFileSync(ghState, `${JSON.stringify({ version: 1, repo, nextNumber: 1, nextId: 1, prs: [], mergeAttempts: [] }, null, 2)}\n`);
  const tmp = join(root, "tmp");
  mkdirSync(tmp);
  // No remote: a journal publish fails here, locally, and never reaches the harness repository.
  const journalHome = join(root, "journal-home");
  git(root, ["init", "--quiet", journalHome], env);

  // The base's red tests are recorded only for the default checks: a caller's
  // own checks command never reads them.
  let checksCommand = options.checksCommand ?? null;
  let baseRed: string | null = null;
  if (options.checksCommand === undefined && Object.keys(gates).length > 0) {
    const gatesFile = join(root, "gates.json");
    baseRed = join(root, "base-red.json");
    writeFileSync(gatesFile, `${JSON.stringify(gates, null, 2)}\n`);
    await recordBaseRed(root, origin, base, gates, baseRed, options, env);
    // This module's own base-red.ts, not the staged harness's: a harness under test may not carry it.
    checksCommand = `bun ${shQuote(join(HERE, "base-red.ts"))} checks --gates ${shQuote(gatesFile)} --base-red ${shQuote(baseRed)}`;
  }

  stageHarness(resolve(options.harness ?? HERE), harness, env);
  // Over the staged copy only: the harness under test is never the one on disk.
  if (options.overlay) applyOverlay(options.overlay, harness);
  return {
    root, origin, work, base, baseBranch, repo, loopName, trackerKey, trackerFile, ghState, tmp, journalHome,
    journalWorktree: join(root, "journal-worktree"),
    journalLock: join(root, "journal.lock"),
    findingsRecord: join(root, "findings-record.jsonl"),
    log: join(root, "trial.log"),
    harness,
    projectId: options.projectId ?? projectIdFor(source).id,
    lineup: options.lineup ?? {},
    checksCommand,
    baseRed,
    findingsCommand,
    reviewRounds,
    home: options.home ?? null,
  };
}

/** The environment `ralph.sh` runs under: no supervisor or git state of the caller's, every channel pointed at the sandbox. */
export function trialEnv(trial: Trial): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...scrubbed(),
    ...(trial.home ? { HOME: trial.home } : {}),
    PATH: `${FAKE_GH_BIN}:${process.env.PATH ?? ""}`,
    RALPH_PROJECT: trial.work,
    // Unset, the id is the clone's basename `work`, and the lineup resolves under no project's block.
    RALPH_PROJECT_ID: trial.projectId,
    // Inherited by everything the iteration starts unless it clears its
    // environment: how the teardown finds a process that left the supervisor's
    // group and was orphaned out of its tree.
    RALPH_TRIAL_ROOT: trial.root,
    RALPH_LOOP_NAME: trial.loopName,
    RALPH_LOOP_ROLE: "coder",
    RALPH_STATE_ROOT: trial.work,
    // Set but empty is "none": unset would fall back to the config's list.
    RALPH_PLUGINS: "",
    RALPH_PUSH_NOTIFICATIONS: "0",
    RALPH_FINDINGS_DISABLED: "1",
    RALPH_JOURNAL_HOME: trial.journalHome,
    RALPH_JOURNAL_WORKTREE: trial.journalWorktree,
    RALPH_JOURNAL_LOCK: trial.journalLock,
    RALPH_FINDINGS_RECORD: trial.findingsRecord,
    // Unset, the ledger lands in the git common dir of whatever checkout the
    // iteration runs in, beside the host's live loops' ledgers.
    RALPH_SPEED_DIR: speedDirOf(trial),
    TMPDIR: trial.tmp,
    FAKE_GH_STATE: trial.ghState,
    FAKE_GH_ORIGIN: trial.origin,
    // The fake refuses a `--repo` that is not its own; the prompts pass the project's.
    FAKE_GH_REPO: trial.repo,
  };
  if (trial.checksCommand !== null) env.FAKE_GH_CHECKS_CMD = trial.checksCommand;
  else delete env.FAKE_GH_CHECKS_CMD;
  if (trial.findingsCommand !== null) {
    env.FAKE_GH_FINDINGS_CMD = trial.findingsCommand;
    env.FAKE_GH_REVIEW_ROUNDS = String(trial.reviewRounds);
  } else {
    delete env.FAKE_GH_FINDINGS_CMD;
    delete env.FAKE_GH_REVIEW_ROUNDS;
  }
  for (const [stage, choice] of Object.entries(trial.lineup) as [Stage, TrialStage | undefined][]) {
    if (!choice) continue;
    env[envNameFor(stage)] = choice.model;
    if (choice.runner !== undefined) env[runnerEnvNameFor(stage)] = choice.runner;
    if (choice.effort !== undefined) env[`${envNameFor(stage)}_EFFORT`] = choice.effort;
  }
  return env;
}

/** The first executable `gh` on `path`, or null. */
function firstGh(path: string): string | null {
  for (const dir of path.split(":")) {
    if (dir === "") continue;
    const candidate = join(dir, "gh");
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* not here */ }
  }
  return null;
}

function originProblem(work: string): string | null {
  const listed = spawnSync("git", ["remote", "-v"], { cwd: work, env: scrubbed(), encoding: "utf8" });
  if (listed.status !== 0) return `git remote -v failed: ${(listed.stderr || listed.error?.message || "").trim()}`;
  const lines = listed.stdout.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return "the work clone has no remote";
  for (const line of lines) {
    const match = /^(\S+)\t(.+) \((fetch|push)\)$/.exec(line);
    if (!match) return `unreadable remote line: ${line}`;
    const [, name, url] = match as unknown as [string, string, string];
    if (name !== "origin") return `a remote other than origin: ${name}`;
    // `scheme://…` and scp-style `host:path` both leave the host.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^/]*:/.test(url)) return `origin is not a local path: ${url}`;
    const dir = isAbsolute(url) ? url : resolve(work, url);
    try {
      if (!statSync(dir).isDirectory()) return `origin is not a directory: ${url}`;
    } catch {
      return `origin does not exist: ${url}`;
    }
    const bare = spawnSync("git", ["rev-parse", "--is-bare-repository"], { cwd: dir, env: scrubbed(), encoding: "utf8" });
    if (bare.status !== 0 || bare.stdout.trim() !== "true") return `origin is not a bare repository: ${url}`;
  }
  return null;
}

/** Whether every channel the iteration talks through is a local stand-in. An unreadable fact is a failure. */
export function trialPreflight(trial: Trial, env: NodeJS.ProcessEnv): TrialPreflight {
  const failures: TrialPreflight["failures"] = [];
  try {
    const gh = firstGh(env.PATH ?? "");
    const fake = realpathSync(join(FAKE_GH_BIN, "gh"));
    if (gh === null) failures.push({ leak: "gh", why: "no gh on PATH" });
    else if (realpathSync(gh) !== fake) failures.push({ leak: "gh", why: `the first gh on PATH is ${gh}, not the fake` });
  } catch (error) {
    failures.push({ leak: "gh", why: `cannot resolve gh: ${error instanceof Error ? error.message : String(error)}` });
  }
  try {
    const problem = originProblem(trial.work);
    if (problem !== null) failures.push({ leak: "origin", why: problem });
  } catch (error) {
    failures.push({ leak: "origin", why: `cannot read the remotes: ${error instanceof Error ? error.message : String(error)}` });
  }
  let plugins: string[] | null = null;
  try {
    const config = loadProjectConfig(trial.work);
    if (config.tracker.kind !== "local") failures.push({ leak: "tracker", why: `the config's tracker is '${config.tracker.kind}', not local` });
    plugins = config.plugins ?? [];
  } catch (error) {
    const why = `cannot load the config: ${error instanceof Error ? error.message : String(error)}`;
    failures.push({ leak: "tracker", why }, { leak: "plugins", why });
  }
  if (plugins !== null && plugins.length > 0) failures.push({ leak: "plugins", why: `the config turns on ${plugins.join(", ")}` });
  // Any git repository there makes `ralph.sh` fetch the harness's origin.
  const harnessGit = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: trial.harness, env: scrubbed(), encoding: "utf8" });
  if (harnessGit.error) failures.push({ leak: "harness", why: `cannot read the harness: ${harnessGit.error.message}` });
  else if (harnessGit.status === 0) failures.push({ leak: "harness", why: `the harness ${trial.harness} is in a git repository, so ralph.sh would fetch its origin` });
  if (env.RALPH_PLUGINS !== "") failures.push({ leak: "plugins", why: `RALPH_PLUGINS is ${JSON.stringify(env.RALPH_PLUGINS ?? null)}, not empty` });
  return { ok: failures.length === 0, failures };
}

/** How long a trial's processes get to exit on SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 3_000;
const KILL_TICK_MS = 10;
/** How often a running trial's process tree is read. */
const SCAN_INTERVAL_MS = 500;
/** How long the teardown waits, after SIGKILL, for the processes to be gone. */
const KILL_REAP_MS = 2_000;

/** One process as `/proc/<pid>/stat` spells it. `start` tells a live pid from a recycled one. */
interface ProcEntry { pid: number; ppid: number; pgid: number; start: string }

function readProc(pid: number): ProcEntry | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Fields after the `(comm)`, which may itself hold spaces and parens.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z") return null;
    return { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), start: fields[19] ?? "" };
  } catch {
    return null;
  }
}

function procEnvironHas(pid: number, entry: string): boolean {
  try { return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(entry); } catch { return false; }
}

/**
 * Add to `known` every live process that belongs to the trial: descendants of
 * the supervisor or of a process already known, and any process carrying the
 * trial's `RALPH_TRIAL_ROOT`.
 *
 * WHY both, and why accumulated. GNU `timeout` (which `delegate.sh` and
 * `inspect.sh` wrap runners in) `setpgid`s, so the executor is outside the
 * supervisor's process group, and killing the group misses it. Its parent
 * link finds it only while the parent lives: once the supervisor exits, its
 * orphans are re-parented away. So the tree is read every
 * {@link SCAN_INTERVAL_MS} while it runs, and what was seen is kept, checked
 * against its start time so a recycled pid is never signalled. The env marker
 * catches what was started and orphaned between two reads, unless it cleared
 * its environment — and what clears it (the executor under `env -i`) is the
 * child of a long-lived parent, which a read does see. Without /proc (not
 * Linux) this finds nothing and the teardown degrades to the group alone.
 */
function scanTrial(supervisor: number, marker: string, known: Map<number, ProcEntry>): void {
  let pids: number[];
  try { pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(Number); } catch { return; }
  const live = new Map<number, ProcEntry>();
  for (const pid of pids) {
    const entry = readProc(pid);
    if (entry !== null) live.set(pid, entry);
  }
  for (const [pid, entry] of known) if (live.get(pid)?.start !== entry.start) known.delete(pid);
  const self = process.pid;
  for (const entry of live.values()) {
    if (entry.pid !== self && !known.has(entry.pid) && procEnvironHas(entry.pid, marker)) known.set(entry.pid, entry);
  }
  const children = new Map<number, ProcEntry[]>();
  for (const entry of live.values()) children.set(entry.ppid, [...(children.get(entry.ppid) ?? []), entry]);
  const queue = [supervisor, ...known.keys()];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift() as number) ?? []) {
      if (known.has(child.pid) || child.pid === self) continue;
      known.set(child.pid, child);
      queue.push(child.pid);
    }
  }
}

/** This process's own group, which a teardown must never signal: it is the caller's (a test runner's). */
function ownGroup(): number | null {
  return readProc(process.pid)?.pgid ?? null;
}

function signalTrial(supervisor: number, known: Map<number, ProcEntry>, signal: NodeJS.Signals): void {
  const own = ownGroup();
  const groups = new Set([supervisor, ...[...known.values()].map((entry) => entry.pgid)]);
  for (const group of groups) {
    if (group > 1 && group !== own) { try { process.kill(-group, signal); } catch { /* already gone */ } }
  }
  for (const pid of known.keys()) { try { process.kill(pid, signal); } catch { /* already gone */ } }
}

function trialAlive(supervisor: number, known: Map<number, ProcEntry>): boolean {
  if (groupAlive(supervisor)) return true;
  return [...known.values()].some((entry) => readProc(entry.pid)?.start === entry.start);
}

async function waitGone(supervisor: number, known: Map<number, ProcEntry>, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (trialAlive(supervisor, known) && Date.now() < deadline) await new Promise((resume) => setTimeout(resume, KILL_TICK_MS));
}

/**
 * SIGTERM everything the trial started, SIGKILL what is left after the grace,
 * then a bounded wait. Resolves either way: a process that will not die costs
 * the caller the bound, never its result.
 */
async function teardown(supervisor: number, marker: string, known: Map<number, ProcEntry>): Promise<void> {
  scanTrial(supervisor, marker, known);
  if (!trialAlive(supervisor, known)) return;
  signalTrial(supervisor, known, "SIGTERM");
  await waitGone(supervisor, known, KILL_GRACE_MS);
  scanTrial(supervisor, marker, known);
  signalTrial(supervisor, known, "SIGKILL");
  await reapGroup(supervisor);
  await waitGone(supervisor, known, KILL_REAP_MS);
}

type RunKind = "finished" | "timeout" | "aborted" | "failed";

/** Spawn the supervisor in its own process group, wait for it, and tear down everything it started, however it ended. */
function spawnSupervisor(trial: Trial, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<{ kind: RunKind; exit: number | null }> {
  const note = (text: string) => { try { writeFileSync(trial.log, `trial: ${text}\n`, { flag: "a" }); } catch { /* the result still comes back */ } };
  return new Promise((accept) => {
    let fd: number;
    let child;
    try {
      fd = openSync(trial.log, "a");
    } catch {
      accept({ kind: "failed", exit: null });
      return;
    }
    try {
      child = spawn("bash", [join(trial.harness, "ralph.sh"), "1"], { cwd: trial.work, env, detached: true, stdio: ["ignore", fd, fd] });
    } catch (error) {
      try { closeSync(fd); } catch { /* already closed */ }
      note(`cannot spawn ralph.sh: ${error instanceof Error ? error.message : String(error)}`);
      accept({ kind: "failed", exit: null });
      return;
    }
    const marker = `RALPH_TRIAL_ROOT=${trial.root}`;
    const known = new Map<number, ProcEntry>();
    const pid = child.pid;
    let killed: "timeout" | "aborted" | null = null;
    let spawnFailed = false;
    let exited = false;
    let tearing: Promise<void> | null = null;
    const tear = (): Promise<void> => {
      if (tearing === null) tearing = pid ? teardown(pid, marker, known).catch(() => undefined) : Promise.resolve();
      return tearing;
    };
    const scanner = setInterval(() => { if (pid) scanTrial(pid, marker, known); }, SCAN_INTERVAL_MS);
    const kill = (why: "timeout" | "aborted") => {
      if (killed !== null || exited) return;
      killed = why;
      void tear();
    };
    const onAbort = () => kill("aborted");
    const timer = setTimeout(() => kill("timeout"), Math.max(1, timeoutMs));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.on("error", (error) => {
      // An asynchronous spawn failure (ENOENT for bash) still ends in `close`.
      spawnFailed = child.pid === undefined;
      note(error.message);
    });
    child.on("close", (code) => {
      exited = true;
      clearTimeout(timer);
      clearInterval(scanner);
      signal?.removeEventListener("abort", onAbort);
      try { closeSync(fd); } catch { /* already closed */ }
      // After a normal finish too: whatever the iteration backgrounded must not
      // outlive it into the caller's dispose of the scratch dir.
      tear().then(() => accept({ kind: spawnFailed ? "failed" : killed ?? "finished", exit: code }));
    });
  });
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function filesUnder(dir: string): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() ? [path] : [];
  });
}

/** The trial PR's head, else the newest pushed branch tip that is not the base branch, else null. */
function finalHeadOf(trial: Trial, github: unknown): string | null {
  const prs = (github as { prs?: { number: number; headRefOid?: string }[] } | null)?.prs;
  if (Array.isArray(prs) && prs.length > 0) {
    const newest = [...prs].sort((a, b) => b.number - a.number)[0];
    if (newest?.headRefOid) return newest.headRefOid;
  }
  const refs = spawnSync("git", ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short) %(objectname)", "refs/heads"], { cwd: trial.origin, env: scrubbed(), encoding: "utf8" });
  if (refs.status !== 0) return null;
  for (const line of refs.stdout.split("\n")) {
    const [name, sha] = line.trim().split(" ");
    if (name && sha && name !== trial.baseBranch) return sha;
  }
  return null;
}

/** `<stage> <model> on <runner>, …` from the supervisor's last `models — ` line. */
export function parseModelsLine(text: string): TrialResult["models"] {
  const lines = text.split("\n").filter((line) => line.includes("models — "));
  const last = lines.at(-1);
  if (last === undefined) return [];
  const summary = last.slice(last.indexOf("models — ") + "models — ".length).replace(/ \(orchestrator effort [^)]*\)\s*$/, "").trim();
  return summary.split(", ").flatMap((part) => {
    const match = /^(\S+) (\S*) on (\S*)$/.exec(part.trim());
    return match ? [{ stage: match[1] as string, model: match[2] as string, runner: match[3] as string }] : [];
  });
}

function lastSigil(text: string): string | null {
  const all = text.match(/<ralph>[\s\S]*?<\/ralph>/g);
  return all ? (all.at(-1) as string) : null;
}

/**
 * The iteration's last sigil. The supervisor does not echo a turn's result
 * into its own output: each turn's final text lands in its own
 * `.ralph/logs/*.final.txt`, so the newest of those is read when the output
 * names none.
 */
function iterationSigil(supervisor: string, logFiles: string[]): string | null {
  const said = lastSigil(supervisor);
  if (said !== null) return said;
  const finals = logFiles.filter((path) => path.endsWith(".final.txt")).flatMap((path) => {
    try { return [{ path, at: statSync(path).mtimeMs }]; } catch { return []; }
  });
  // Stable on equal mtimes: the names carry a timestamp, so the later name is the later turn.
  finals.sort((a, b) => a.at - b.at || (a.path < b.path ? -1 : 1));
  for (const { path } of finals.reverse()) {
    try {
      const sigil = lastSigil(readFileSync(path, "utf8"));
      if (sigil !== null) return sigil;
    } catch { /* unreadable: try the one before */ }
  }
  return null;
}

function speedDirOf(trial: Trial): string {
  return join(trial.root, "speed");
}

/** The base record, or null when there is none or it is not one. */
function baseRedOf(trial: Trial): BaseRed | null {
  if (trial.baseRed === null) return null;
  const record = readJson(trial.baseRed) as BaseRed | null;
  return record?.version === 1 && typeof record.gates === "object" && record.gates !== null ? record : null;
}

function collect(trial: Trial, outcome: TrialResult["outcome"], failures: TrialPreflight["failures"]): TrialResult {
  const redact = buildRedactor();
  const read = (path: string): string => { try { return readFileSync(path, "utf8"); } catch { return ""; } };
  const supervisor = read(trial.log);
  const logFiles = filesUnder(join(trial.work, ".ralph", "logs"));
  const logs = [...logFiles, ...(existsSync(trial.log) ? [trial.log] : [])]
    .map((path) => ({ path: relative(trial.root, path), text: redact(read(path)) }));
  const github = readJson(trial.ghState);
  const finalHead = outcome.kind === "refused" ? null : finalHeadOf(trial, github);
  let patch = "";
  if (finalHead !== null) {
    const diff = spawnSync("git", ["diff", trial.base, finalHead], { cwd: trial.origin, env: scrubbed(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (diff.status === 0) patch = redact(diff.stdout);
  }
  return {
    // A killed run's newest `.final.txt` is an EARLIER turn's: it says nothing of how the run ended.
    outcome: { ...outcome, sigil: outcome.kind === "finished" ? outcome.sigil ?? iterationSigil(supervisor, logFiles) : null },
    failures,
    base: trial.base,
    finalHead,
    patch,
    logs,
    tracker: readJson(trial.trackerFile),
    github,
    review: trial.findingsCommand === null ? null : summarizeReview(github, trial.reviewRounds),
    models: parseModelsLine(supervisor),
    speed: readSpeedLedger(speedDirOf(trial)).events,
    baseRed: baseRedOf(trial),
  };
}

/** Preflight the trial and, only if every channel is local, run one `ralph.sh` iteration in it. Never rejects. */
export async function runTrial(
  trial: Trial,
  // `env` is laid over `trialEnv` and then preflighted like the rest: a test's way to plant a leak.
  options: { timeoutMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<TrialResult> {
  const env = { ...trialEnv(trial), ...options.env };
  const preflight = trialPreflight(trial, env);
  if (!preflight.ok) return collect(trial, { kind: "refused", exit: null, sigil: null }, preflight.failures);
  try { writeFileSync(trial.log, ""); } catch { /* `spawnSupervisor` reports a log it cannot open as failed */ }
  const run = await spawnSupervisor(trial, env, options.timeoutMs, options.signal);
  // The fake gh's hook runners are detached from the supervisor's group: a
  // trial that ended, however it ended, must not leave them running its gates.
  try { stopHookRunners(trial.ghState); } catch { /* a teardown that cannot read the state still returns the result */ }
  return collect(trial, { kind: run.kind, exit: run.exit, sigil: null }, []);
}

/** Remove the trial's scratch dir, and everything in it. */
export function disposeTrial(trial: Trial): void {
  rmSync(trial.root, { recursive: true, force: true });
}
