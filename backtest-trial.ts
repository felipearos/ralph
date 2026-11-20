/**
 * The backtest's real dependencies (felipearos/ralph#533): what
 * `backtest-run.ts` takes as `startTrial` and `lease`, built on the trial
 * sandbox (`trial-sandbox.ts`), a named lineup file and the host lease
 * (`host-lease.ts`).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { armList, codexJudgeModel, DEFAULT_JUDGE_MODEL, repeatCount, type BacktestConfig, type BacktestSample, type BacktestTicket } from "./backtest";
import { forgiveBaseRed, renderBacktestReport, type ArmResolution, type BacktestReport, type ResolvedStage, type TrialRow } from "./backtest-report";
import { panelNotes, panelRecord, runBacktest, trialConfig, writeAtomic, type BacktestRunDeps } from "./backtest-run";
import { GIT_TIMEOUT_MS, scoreBacktest, scoreRepeats, type ScoreDeps, type TicketScore } from "./backtest-score";
import { claudeJudge, JUDGE_TIMEOUT_MS } from "./backtest-judge";
import { spawnGh } from "./clerk/pulls";
import { analyse, type Analysis } from "./eval-analyst";
import { guardrailSettings, stampGuardrails, type GuardrailThresholds } from "./eval-guardrails";
import { stampJudgeAccuracy, type CalibratedCase } from "./eval-judge-accuracy";
import { NOISE_FLOOR_FILE, noiseFloorSettings, readNoiseFloors, stampNoise, type NoiseReads } from "./eval-noise-floor";
import { sampleFor } from "./eval-source";
import { readSet } from "./evals-set";
import { readUsage, type UsageReading, type UsageRunner } from "./usage-guard";
import { READY_LABEL } from "./frontier/next-tasks";
import { acquire, parsePolicy, partyAlive, readCi, releaseRun, storePathFromGit, withStore, type CiRead, type LeaseRequest, type Party } from "./host-lease";
import { abortLocalReviews, runLocalReview } from "./local-review";
import { loadConfig, resolveLineup, STAGES, type Stage } from "./models";
import { loadProjectConfig } from "./project-config";
import { projectIdFor } from "./project-id";
import { readOverlay } from "./prompt-overlay";
import type { LocalSeedIssue } from "./tracker/local";
import { buildTrial, checkBaseBuild, disposeTrial, runTrial, TRIAL_LOOP_NAME, type TrialStage } from "./trial-sandbox";

/** This module's checkout: the harness `buildTrial` stages by default, so the live arm resolves against its models.json. */
const HARNESS = dirname(fileURLToPath(import.meta.url));

/** `OA-123` → the local tracker's key `OA` and ticket 123, so the trial's ticket reads as the one the human worked. */
export function seedFromTicket(ticket: BacktestTicket): { trackerKey: string; issue: LocalSeedIssue } {
  const match = /^([A-Za-z]+)-(\d+)$/.exec(ticket.oaKey);
  if (match === null) throw new Error(`backtest: ticket key '${ticket.oaKey}' is not <LETTERS>-<digits>`);
  return {
    trackerKey: match[1]!,
    issue: {
      number: Number(match[2]),
      title: ticket.frozen.title,
      body: ticket.frozen.body,
      comments: ticket.frozen.comments.map((comment) => ({ body: comment.body, createdAt: comment.createdAt, author: comment.author })),
      // The label the coder's frontier takes a ticket by; `buildTrial` adds it too, this keeps the seed honest on its own.
      labels: [READY_LABEL],
      state: "open",
    },
  };
}

/** Where `ralph-lineup-switch` keeps a named lineup: a whole models.json. */
export function lineupPath(name: string, home = homedir()): string {
  return join(home, ".ralph", "lineups", `${name}.json`);
}

/**
 * A named arm's lineup, resolved from its lineup file. The env is empty so this
 * process's RALPH_MODEL_* overrides never leak into the arm under test.
 */
export function lineupFromFile(path: string, options: { projectId: string; loopName: string }): Partial<Record<Stage, TrialStage>> {
  if (!existsSync(path)) throw new Error(`backtest: no lineup named ${basename(path, ".json")} (${path})`);
  return resolveStages(path, options);
}

/**
 * The `live` arm's lineup as the trial's supervisor will resolve it: the
 * harness's own models.json for the trial's project and loop (#816). Only
 * recorded — the trial itself still runs an empty lineup.
 */
export function liveLineup(harness: string, options: { projectId: string; loopName: string }): Partial<Record<Stage, TrialStage>> {
  const path = join(harness, "models.json");
  if (!existsSync(path)) throw new Error(`backtest: the harness has no models.json (${path})`);
  return resolveStages(path, options);
}

/** A models.json resolved for one project and loop, the way the trial's supervisor reads it. */
function resolveStages(path: string, options: { projectId: string; loopName: string }): Partial<Record<Stage, TrialStage>> {
  // Not migrated: the file is the operator's, and a read must never rewrite it.
  const config = loadConfig(path, false);
  const lineup = resolveLineup({ config, loopName: options.loopName, project: options.projectId, role: "coder", env: {} });
  const stages: Partial<Record<Stage, TrialStage>> = {};
  for (const stage of STAGES) {
    const resolved = lineup[stage];
    if (resolved === undefined) continue;
    stages[stage] = { model: resolved.model, runner: resolved.runner, ...(resolved.effort === undefined ? {} : { effort: resolved.effort }) };
  }
  return stages;
}

/** What an arm is recorded as having run with (#816), in `STAGES` order. */
export function armResolution(lineup: Partial<Record<Stage, TrialStage>>, overlayHash: string | null): ArmResolution {
  const stages: ResolvedStage[] = [];
  for (const stage of STAGES) {
    const choice = lineup[stage];
    if (choice === undefined) continue;
    // A resolved lineup always names its runner. A hand-built one that does
    // not leaves the trial on the staged models.json's runner for the stage
    // (there is no fixed default), which this record cannot see.
    stages.push({ stage, runner: choice.runner ?? "unknown", model: choice.model, effort: choice.effort ?? null });
  }
  return { stages, overlayHash };
}

/** The parent environment without git location variables, so a git read lands on the trial's work tree and nowhere else. */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return env;
}

/** Everything in `work` since `base`, committed or not, untracked included; "" when git cannot say. */
function workPatch(work: string, base: string): string {
  const env = gitEnv();
  const run = (args: string[]) => spawnSync("git", args, { cwd: work, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  // Staging is harmless here: the trial is over and its tree is disposed next.
  if (run(["add", "-A"]).status !== 0) return "";
  const diff = run(["diff", "--cached", "--binary", base]);
  return diff.status === 0 ? diff.stdout : "";
}

export function sandboxStarter(options: {
  source: (ticket: BacktestTicket) => string;
  /** Each named lineup an arm runs, resolved; `live` needs no entry, since an empty lineup is the project's own. */
  lineups: Record<string, Partial<Record<Stage, TrialStage>>>;
  harness?: string;
  scratchParent?: string;
  home?: string;
  /** `scoring.setup`, run in the base's clone before its gates are recorded. */
  setup?: string | null;
  /**
   * The `live` lineup resolved ahead of time, for the record only (#816): the
   * trial still runs an empty lineup. Absent or null, a live arm records nothing.
   */
  live?: Partial<Record<Stage, TrialStage>> | null;
  /** Each overlay arm's overlay hash by arm name, as pinned for the batch; an arm with none is hashed here. */
  overlayHashes?: Record<string, string>;
}): BacktestRunDeps["startTrial"] {
  return async (ticket, arm) => {
    const lineup = arm.lineup === "live" ? {} : options.lineups[arm.lineup];
    if (lineup === undefined) throw new Error(`backtest: arm ${arm.arm} for ${ticket.oaKey} names lineup ${arm.lineup}, which was not resolved`);
    const { trackerKey, issue } = seedFromTicket(ticket);
    const trial = await buildTrial({
      source: options.source(ticket),
      base: ticket.mergeBase,
      ticket: issue,
      trackerKey,
      // The live lineup is the project's own, which an empty lineup means.
      lineup,
      ...(arm.overlay ? { overlay: arm.overlay } : {}),
      ...(options.harness === undefined ? {} : { harness: options.harness }),
      ...(options.scratchParent === undefined ? {} : { scratchParent: options.scratchParent }),
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.setup === undefined ? {} : { setup: options.setup }),
    });
    const recorded = arm.lineup === "live" ? options.live ?? null : lineup;
    let overlayHash: string | null = null;
    if (arm.overlay) {
      overlayHash = options.overlayHashes?.[arm.arm] ?? null;
      if (overlayHash === null) {
        // A record only: an unreadable overlay must not fail a trial that built.
        try { overlayHash = readOverlay(arm.overlay).hash; } catch { overlayHash = null; }
      }
    }
    // A live lineup that did not resolve still has a known overlay: keep that half of the record.
    const resolved = recorded !== null ? armResolution(recorded, overlayHash) : overlayHash !== null ? { stages: [], overlayHash } : null;
    return {
      ...(resolved === null ? {} : { resolved }),
      run: ({ timeoutMs, signal }) => runTrial(trial, { timeoutMs, signal }),
      partialPatch: () => {
        try { return workPatch(trial.work, trial.base); } catch { return ""; }
      },
      keep: (path) => {
        mkdirSync(dirname(path), { recursive: true });
        const create = (args: string[]) =>
          spawnSync("git", ["bundle", "create", path, ...args], { cwd: trial.origin, env: gitEnv(), encoding: "utf8", timeout: GIT_TIMEOUT_MS });
        // Only the arm's own commits: the scoring clone always has the merge
        // base. git refuses an empty bundle (nothing past the base), and a
        // whole bundle is then still a correct one.
        // Resolved in the source: a branch name would read the trial origin's own ref, which the scoring clone lacks.
        const base = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ticket.mergeBase}^{commit}`],
          { cwd: options.source(ticket), env: gitEnv(), encoding: "utf8", timeout: GIT_TIMEOUT_MS }).stdout?.trim() ?? "";
        let bundle = create(base === "" ? ["--all"] : ["--all", `^${base}`]);
        if (bundle.error || bundle.status !== 0) bundle = create(["--all"]);
        if (bundle.error) throw bundle.error;
        if (bundle.status !== 0) throw new Error(`git bundle create exited ${bundle.status}: ${bundle.stderr.trim()}`);
      },
      dispose: () => disposeTrial(trial),
    };
  };
}

/**
 * The backtest as its own host-lease party. The live loops' admission limits
 * (asks and grants per ticket, the per-loop cooldown) ration one ticket's
 * single heavy command; a batch takes the lease once per trial, so those are
 * lifted. Spacing, queue, drain and idle reads stay: they give the live loops
 * their turns between trials.
 */
export function hostLease(options: {
  storePath: (ticket: BacktestTicket) => string;
  runId: string;
  trialMinutes: number;
  ci: (ticket: BacktestTicket) => CiRead;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  alive?: (party: { pid: number; host: string }) => boolean;
  log?: (line: string) => void;
}): BacktestRunDeps["lease"] {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const alive = options.alive ?? partyAlive;
  const log = options.log ?? ((line: string) => console.error(`backtest: ${line}`));
  const configured = parsePolicy(env);
  const policy = {
    ...configured,
    perTicket: Number.MAX_SAFE_INTEGER,
    asksPerTicket: Number.MAX_SAFE_INTEGER,
    loopCooldownSeconds: 0,
    // The grant must outlive the trial, or another party could be granted mid-trial.
    grantSeconds: Math.max(configured.grantSeconds, options.trialMinutes * 60 + 600),
  };
  const party: Party = { run: options.runId, loop: "backtest", pid: process.pid, host: env.HOSTNAME ?? hostname() };
  let held: string | null = null;

  return {
    async acquire(ticket, arm, signal) {
      if (signal.aborted) return { ok: false, why: "aborted" };
      const path = options.storePath(ticket);
      // Ticket 0 is no real ticket, so the backtest's asks never count against a live one's.
      const request: LeaseRequest = {
        ticket: 0,
        command: `backtest trial ${ticket.oaKey} arm ${arm.arm}`,
        criterion: "the backtest compares the agent's trial against the human's merged work",
        whyNotCi: "a trial is a whole local coder iteration; no CI job runs one",
        fenceEvidence: "a batch runs trials one at a time on the host the live loops share",
      };
      held = path;
      // A wait that rejects on abort: `acquire`'s own catch then takes this
      // run out of the store's queue and returns, so Ctrl-C never waits out a lease.
      const abortable = async (ms: number): Promise<void> => {
        if (signal.aborted) throw new Error("aborted");
        let onAbort = (): void => {};
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error("aborted"));
          signal.addEventListener("abort", onAbort, { once: true });
        });
        try { await Promise.race([sleep(ms), aborted]); }
        finally { signal.removeEventListener("abort", onAbort); }
        if (signal.aborted) throw new Error("aborted");
      };
      const result = await acquire(request, 0, { path, party, policy, now, sleep: abortable, alive, ci: () => options.ci(ticket), log });
      return result.outcome === "granted" ? { ok: true } : { ok: false, why: `${result.outcome}: ${result.detail}` };
    },
    async release() {
      if (held === null) return;
      const path = held;
      held = null;
      await withStore(path, (store) => releaseRun(store, options.runId, now()));
    },
  };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A timer that resolves early, and never rejects, when the operator stops the batch. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal.aborted) { done(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); done(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** The run's default directory: one per config, so rerunning the same config resumes the same batch. */
export function backtestRunDir(config: BacktestConfig): string {
  // Scoring options are left out: a rescore with other test globs reads the same batch.
  const hash = createHash("sha256").update(JSON.stringify(trialConfig(config))).digest("hex").slice(0, 12);
  return join(config.project, ".ralph", "logs", "experiments", `${config.source === undefined ? "backtest" : "eval"}-${hash}`);
}

/**
 * `experiments.ts backtest <config>` without `--dry-run`: the batch on the
 * real sandbox, lineup file and host lease. Everything that can be refused
 * without a model — a repo with no checkout, a missing lineup — is refused
 * before the first lease, so a bad config costs nothing overnight.
 */
export async function runBacktestCommand(config: BacktestConfig, options: {
  runDir?: string;
  signal: AbortSignal;
  log: (line: string) => void;
  scoreDeps?: Omit<ScoreDeps, "log">;
}): Promise<{ report: BacktestReport; runDir: string }> {
  const { signal, log } = options;
  const runDir = options.runDir ?? backtestRunDir(config);
  const statePath = join(runDir, "state.json");
  // A resume replays the batch it started (runBacktest reads the stored
  // sample too), so no ledger or gh read happens on a rerun.
  const sample: BacktestSample = existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, "utf8")) as { sample: BacktestSample }).sample
    : await sampleFor(config);

  const repos = checkSources(config, sample);
  const source = (ticket: BacktestTicket): string => config.sources[ticket.repo]!;

  // The arms the batch replays: a resumed one keeps those it started with.
  const arms = armList(sample.arms);
  // Refused here, before any lease: a bad overlay would otherwise fail every trial of its arm overnight.
  const overlays: Record<string, string> = {};
  for (const arm of arms) if (arm.overlay !== null) overlays[arm.name] = readOverlay(arm.overlay).hash;
  pinOverlays(runDir, overlays);
  // One starter per repo: a named lineup resolves against the project id the
  // trial runs as, which is the source checkout's (buildTrial's default).
  const starters = new Map<string, BacktestRunDeps["startTrial"]>();
  // Every runner an arm's stage names (#822), so the usage guard also watches Codex's window when an arm spends it.
  const armRunners = new Set<string>();
  for (const repo of repos) {
    const lineups: Record<string, Partial<Record<Stage, TrialStage>>> = {};
    for (const name of new Set(arms.map((arm) => arm.lineup).filter((name) => name !== "live"))) {
      lineups[name] = lineupFromFile(lineupPath(name), { projectId: projectIdFor(config.sources[repo]!).id, loopName: TRIAL_LOOP_NAME });
    }
    // The live arm's models, for the report only: a harness whose lineup does
    // not resolve leaves the arm "not recorded" rather than costing the batch.
    let live: Partial<Record<Stage, TrialStage>> | null = null;
    if (arms.some((arm) => arm.lineup === "live")) {
      try {
        live = liveLineup(HARNESS, { projectId: projectIdFor(config.sources[repo]!).id, loopName: TRIAL_LOOP_NAME });
      } catch (error) {
        log(`${repo}: live lineup not recorded: ${message(error)}`);
      }
    }
    for (const lineup of [...Object.values(lineups), ...(live === null ? [] : [live])]) {
      for (const stage of Object.values(lineup)) if (stage?.runner !== undefined) armRunners.add(stage.runner);
    }
    starters.set(repo, sandboxStarter({ source, lineups, setup: config.scoring.setup, live, overlayHashes: overlays }));
  }

  // The CI read is per repo; an unreadable project config is said once, and
  // the lease then goes by the host's idleness alone.
  const ciReads = new Map<string, (ticket: BacktestTicket) => CiRead>();
  const ciFor = (ticket: BacktestTicket): CiRead => {
    let read = ciReads.get(ticket.repo);
    if (read === undefined) {
      try {
        const project = loadProjectConfig(source(ticket));
        read = () => readCi(ticket.repo, project.baseBranch, project.requiredChecks);
      } catch (error) {
        const detail = `CI not read: ${message(error)}`;
        log(`${ticket.repo}: ${detail}`);
        read = () => ({ busy: false, detail });
      }
      ciReads.set(ticket.repo, read);
    }
    return read(ticket);
  };

  // One UsageBar call serves every provider of one guard check: the guard asks
  // Claude then Codex within the same second, and codexbar calls each
  // provider's own rate-limited endpoint.
  let usageRead: { atMs: number; readings: Record<UsageRunner, UsageReading | null> } | null = null;
  const usageFor = (runner: UsageRunner): UsageReading | null => {
    if (usageRead === null || Date.now() - usageRead.atMs > 30_000) usageRead = { atMs: Date.now(), readings: readUsage() };
    return usageRead.readings[runner];
  };

  const deps: BacktestRunDeps = {
    runDir,
    startTrial: (ticket, arm) => starters.get(ticket.repo)!(ticket, arm),
    // Only a setup can fail on a base that checks out: with none, the build
    // itself refuses a missing base, arm by arm, as before (#820).
    ...(config.scoring.setup === null ? {} : {
      checkBase: (ticket: BacktestTicket, { timeoutMs, signal }: { timeoutMs: number; signal: AbortSignal }) =>
        checkBaseBuild({ source: source(ticket), base: ticket.mergeBase, setup: config.scoring.setup!, timeoutMs, signal }),
    }),
    lease: hostLease({
      storePath: (ticket) => storePathFromGit(source(ticket)),
      runId: `backtest-${basename(runDir)}-${process.pid}`,
      trialMinutes: config.caps.trialMinutes,
      ci: ciFor,
      log,
    }),
    now: Date.now,
    sleep: abortableSleep,
    log,
    signal,
    usage: (runner) => usageFor(runner),
    armRunners: [...armRunners],
  };
  const report = await runBacktest(sample, config, deps);
  // A stopped batch is not scored: the operator asked for the host back, and a rerun or a rescore scores it.
  if (signal.aborted) return { report, runDir };
  let scored: BacktestReport;
  try {
    scored = await scoreReport(runDir, config, report, { signal, log, scoreDeps: options.scoreDeps });
  } catch (error) {
    // The trial report is already on disk; a scoring failure must not cost it.
    log(`scoring failed, the report stays unscored: ${message(error)}`);
    return { report, runDir };
  }
  // A case the panel contested runs again too (#801), once it is scored, and
  // its repeats are scored and judged as the first trials were (#821). The
  // first trials are not scored again: their verdict is the one the ledger keeps.
  const contested = contestedCases(scored).filter((ticket) => !report.rows.some((row) => row.ticket === ticket && row.repeat !== undefined));
  if (contested.length > 0 && repeatCount(config) > 0 && scored.scores !== undefined) {
    log(`repeating ${contested.length} contested case(s): ${contested.join(", ")}`);
    const repeated = await runBacktest(sample, config, deps, { repeatCases: contested });
    const firsts = scored.scores!;
    scored = { ...scored, rows: forgiveRows(repeated.rows, firsts, scored.repeatScores ?? [], log), stoppedBy: repeated.stoppedBy, finishedAt: repeated.finishedAt };
    if (signal.aborted) return { report: writeScoredReport(runDir, config, scored), runDir };
    const more = await scoreRepeatPass(runDir, config, firsts, { signal, log, scoreDeps: options.scoreDeps, tickets: contested });
    if (more === null) return { report: writeScoredReport(runDir, config, scored), runDir };
    const repeatScores = [...(scored.repeatScores ?? []).filter((score) => !contested.includes(score.ticket)), ...more];
    scored = { ...scored, rows: forgiveRows(repeated.rows, firsts, repeatScores, log), repeatScores };
  }
  return { report: writeScoredReport(runDir, config, await withAnalysis(runDir, config, scored, { signal, log, scoreDeps: options.scoreDeps })), runDir };
}

/** The cases where the panel's families contested an axis. */
function contestedCases(report: BacktestReport): string[] {
  return (report.scores ?? []).filter((score) => (score.panel?.contested.length ?? 0) > 0).map((score) => score.ticket);
}

/**
 * A row whose only failing gates the scoring re-judged as base-red is green:
 * a rescore fixes a report written before #579. A repeat is judged by its own
 * round's scores (#821); one not scored yet keeps its verdict.
 */
function forgiveRows(rows: readonly TrialRow[], scores: readonly TicketScore[], repeatScores: readonly TicketScore[], log: (line: string) => void): TrialRow[] {
  return rows.map((row) => {
    const score = row.repeat === undefined
      ? scores.find((entry) => entry.ticket === row.ticket)
      : repeatScores.find((entry) => entry.ticket === row.ticket && entry.repeat === row.repeat);
    const arm = score?.arms.find((candidate) => candidate.arm === row.arm);
    if (arm === undefined) return row;
    const forgiven = forgiveBaseRed(row, arm.gates);
    if (forgiven !== row) log(`${row.ticket}/${row.arm}${row.repeat === undefined ? "" : ` r${row.repeat}`}: ${row.outcome} → ${forgiven.outcome}, base-red only`);
    return forgiven;
  });
}

/** The noise floor's real reads (#859): the stored floors and the project's stale share. */
export const realNoiseReads: NoiseReads = {
  floors: readNoiseFloors,
  staleShare: (project) => noiseFloorSettings(loadProjectConfig(project)).staleShare,
};

/** The project's guardrail thresholds; an unreadable config is the defaults, never a lost report. */
export function realGuardrailThresholds(project: string): GuardrailThresholds {
  try {
    return guardrailSettings(loadProjectConfig(project));
  } catch {
    return guardrailSettings({});
  }
}

/** The set's cases with their calibration verdicts (#877); an unreadable set is null, never a lost report. */
export function realCalibratedCases(project: string): CalibratedCase[] | null {
  try {
    return readSet(projectIdFor(project).id).cases;
  } catch {
    return null;
  }
}

/**
 * A scored report, written with its noise stamp (#859): a floor run stores
 * `noise-floor.json` beside it, a later set run carries its gaps against the
 * latest floor. A set run with a live baseline arm also carries its guardrail
 * verdict (#871), and a set run its judge accuracy against the set's
 * calibration verdicts (#877). A rescore rewrites all of them.
 */
export function writeScoredReport(runDir: string, config: BacktestConfig, scored: BacktestReport, reads: NoiseReads = realNoiseReads, thresholds: (project: string) => GuardrailThresholds = realGuardrailThresholds, calibrated: (project: string) => CalibratedCase[] | null = realCalibratedCases): BacktestReport {
  const stamped = stampNoise(scored, config, reads);
  const { floor } = stamped;
  // The verdict reads the noise stamp just made, so the two never disagree on the floor (#871).
  const guarded = stampGuardrails(stamped.report, thresholds(config.project));
  // Only a set run that is not a floor run reads the set: the read fetches origin, and elsewhere it has nothing to check.
  const isSetRun = guarded.set !== undefined && guarded.noiseFloor === undefined;
  const report = stampJudgeAccuracy(guarded, isSetRun ? calibrated(config.project) : null);
  writeAtomic(join(runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeAtomic(join(runDir, "report.md"), renderBacktestReport(report));
  if (floor !== null) writeAtomic(join(runDir, NOISE_FLOOR_FILE), `${JSON.stringify(floor, null, 2)}\n`);
  return report;
}

/** The report with the analyst's improvements, when the config runs the analyst. */
async function withAnalysis(runDir: string, config: BacktestConfig, report: BacktestReport, options: {
  signal: AbortSignal;
  log: (line: string) => void;
  scoreDeps?: Omit<ScoreDeps, "log">;
}): Promise<BacktestReport> {
  if (options.signal.aborted || report.scores === undefined) return report;
  const analysis = await analyseReport(runDir, config, report, options);
  return analysis === undefined ? report : { ...report, analysis };
}

/**
 * Each arm's overlay hash, kept in the run directory as `overlays.json`: the
 * prompts the run started with. A resume whose overlay was edited since would
 * mix two prompts under one arm's name, so it is refused.
 */
export function pinOverlays(runDir: string, overlays: Record<string, string>): void {
  const path = join(runDir, "overlays.json");
  if (existsSync(path)) {
    const pinned = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    for (const [arm, hash] of Object.entries(overlays)) {
      if (pinned[arm] !== undefined && pinned[arm] !== hash) {
        throw new Error(`eval: arm ${arm}'s prompt overlay changed since this run started; restore it, or run the plan in a fresh run directory`);
      }
    }
    return;
  }
  if (Object.keys(overlays).length > 0) writeAtomic(path, `${JSON.stringify(overlays, null, 2)}\n`);
}

/** Every repo the sample names must have a checkout: the trials and the scoring both clone from it. */
function checkSources(config: BacktestConfig, sample: BacktestSample): string[] {
  const repos = [...new Set(sample.tickets.map((ticket) => ticket.repo))];
  for (const repo of repos) {
    const path = config.sources[repo];
    if (path === undefined) throw new Error(`backtest: no checkout of ${repo}; add "sources": { "${repo}": "<absolute path to a clone>" } to the config`);
    if (!existsSync(path)) throw new Error(`backtest: sources.${repo} (${path}) does not exist`);
  }
  return repos;
}

/** Score the run dir, then rewrite report.json and report.md with the scores, as runBacktest writes them. */
async function scoreReport(runDir: string, config: BacktestConfig, report: BacktestReport, options: {
  signal: AbortSignal;
  log: (line: string) => void;
  scoreDeps?: Omit<ScoreDeps, "log">;
}): Promise<BacktestReport> {
  const { signal, log } = options;
  const { deps, codex } = scoringDeps(options);
  // Every repeat is scored and judged as its case's first trials are (#821).
  const passed = await whileScoring(signal, async () => {
    const scores = await scoreBacktest(runDir, config, deps);
    if (signal.aborted) return { scores, repeatScores: [] };
    return { scores, repeatScores: await scoreRepeats(runDir, config, deps, { references: scores }) };
  });
  // A stopped scoring is a partial one; the report on disk is the last whole one.
  if (signal.aborted) {
    log("scoring was stopped; the report is kept as it was");
    return report;
  }
  const { scores, repeatScores } = passed;
  // Written now, before the analyst: a failed or stopped analysis must not cost the scores.
  // A rescore may score with another panel or seed than the batch did: the record says which one these scores came from.
  const resolved = report.resolved === undefined ? {} : {
    resolved: { ...report.resolved, ...panelRecord(config, report.id, codex) },
    notes: panelNotes(report.notes, config, codex),
  };
  // A rescore replaces the repeats' scores too: none left from an earlier pass.
  const { repeatScores: _earlier, ...rest } = report;
  return writeScoredReport(runDir, config, {
    ...rest, ...resolved, rows: forgiveRows(report.rows, scores, repeatScores, log), scores,
    ...(repeatScores.length === 0 ? {} : { repeatScores }),
  });
}

/** The scoring's real dependencies, with the Codex judge model read once per pass: the panel that judges every ticket is the one the report records. */
function scoringDeps(options: { signal: AbortSignal; log: (line: string) => void; scoreDeps?: Omit<ScoreDeps, "log"> }): { deps: ScoreDeps; codex: string | null } {
  const codex = options.scoreDeps?.codexModel === undefined ? codexJudgeModel() : options.scoreDeps.codexModel;
  return { deps: { review: runLocalReview, gh: spawnGh, ...options.scoreDeps, codexModel: codex, log: options.log, signal: options.signal }, codex };
}

/** A review is a whole model session; Ctrl-C mid-scoring must end it rather than wait it out. */
async function whileScoring<T>(signal: AbortSignal, score: () => Promise<T>): Promise<T> {
  const onAbort = (): void => abortLocalReviews();
  signal.addEventListener("abort", onAbort, { once: true });
  try { return await score(); }
  finally { signal.removeEventListener("abort", onAbort); }
}

/**
 * The repeats of `tickets` scored on their own, after the contested cases ran
 * again (#821): the first trials keep the scores they have. Null when the
 * scoring was stopped, so the report keeps what it had.
 */
async function scoreRepeatPass(runDir: string, config: BacktestConfig, references: readonly TicketScore[], options: {
  signal: AbortSignal;
  log: (line: string) => void;
  scoreDeps?: Omit<ScoreDeps, "log">;
  tickets: readonly string[];
}): Promise<TicketScore[] | null> {
  const { deps } = scoringDeps(options);
  const scores = await whileScoring(options.signal, () => scoreRepeats(runDir, config, deps, { references, tickets: options.tickets }));
  if (options.signal.aborted) {
    options.log("scoring the repeats was stopped; the report keeps them unscored");
    return null;
  }
  return scores;
}

/**
 * The analyst over the scored report (#801): undefined when the config turns
 * it off, so the report carries no field. Its answer is kept as
 * `analysis.json`; a failed call is recorded as unavailable, never a lost report.
 */
async function analyseReport(runDir: string, config: BacktestConfig, report: BacktestReport, options: {
  signal: AbortSignal;
  log: (line: string) => void;
  scoreDeps?: Omit<ScoreDeps, "log">;
}): Promise<Analysis | undefined> {
  // A config parsed before #801 has no `analyst` key: the default is on.
  const analyst = config.scoring.analyst === undefined ? { model: DEFAULT_JUDGE_MODEL } : config.scoring.analyst;
  if (analyst === null) return undefined;
  const scratch = mkdtempSync(join(tmpdir(), "eval-analyst-"));
  try {
    // The scratch dir, as the judges: no project CLAUDE.md to read.
    const call = (options.scoreDeps?.analyst ?? claudeJudge)({
      model: analyst.model, cwd: scratch, logPath: join(runDir, "analyst.log"), timeoutMs: JUDGE_TIMEOUT_MS, env: options.scoreDeps?.env, signal: options.signal,
    });
    const analysis = await analyse(report, analyst.model, call);
    writeAtomic(join(runDir, "analysis.json"), `${JSON.stringify(analysis, null, 2)}\n`);
    options.log(analysis.status === "ok" ? `analyst: ${analysis.improvements.length} improvement(s)` : `analyst unavailable: ${analysis.reason}`);
    return analysis;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * `experiments.ts backtest <config> --rescore`: score a batch that already
 * ran, from its run dir alone. No trial, sandbox or host lease: the arms'
 * bundles and the stored sample are all scoring reads.
 */
export async function rescoreBacktest(config: BacktestConfig, options: {
  runDir?: string;
  signal: AbortSignal;
  log: (line: string) => void;
  scoreDeps?: Omit<ScoreDeps, "log">;
}): Promise<{ report: BacktestReport; runDir: string }> {
  const runDir = options.runDir ?? backtestRunDir(config);
  for (const name of ["state.json", "report.json"]) {
    const path = join(runDir, name);
    if (!existsSync(path)) throw new Error(`backtest: no ${path}; run the batch first`);
  }
  const sample = (JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as { sample: BacktestSample }).sample;
  checkSources(config, sample);
  const report = JSON.parse(readFileSync(join(runDir, "report.json"), "utf8")) as BacktestReport;
  const scored = await scoreReport(runDir, config, report, options);
  if (scored === report) return { report, runDir };
  return { report: writeScoredReport(runDir, config, await withAnalysis(runDir, config, scored, options)), runDir };
}
