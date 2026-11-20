/**
 * The backtest batch runner (felipearos/ralph#533): every agent trial of a
 * sample, one at a time, each inside the host lease, with the trial and batch
 * caps, a pause instead of a lost trial on a usage limit, and a state file a
 * rerun resumes from.
 *
 * Everything that touches a process, a repo or the lease store is a
 * dependency, so this module only orders trials, keeps their artifacts and
 * writes under `runDir`: it publishes nothing and spawns nothing.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { armList, codexJudgeModel, defaultPanelNote, judgeSpecs, OPUS_ALONE_NOTE, repeatCount, usageLimit, type BacktestConfig, type BacktestSample, type BacktestTicket } from "./backtest";
import { renderBacktestReport, scoreTrial, type ArmName, type ArmResolution, type BacktestReport, type RunResolution, type TrialRow } from "./backtest-report";
import type { BaseBuild, TrialResult } from "./trial-sandbox";
import { GUARD_MAX_WAIT_MS, guardWaitMs, usageRunners, type UsageReading, type UsageRunner } from "./usage-guard";
import { DEFAULT_MARGIN_SECONDS, DEFAULT_MIN_WAIT_SECONDS, DEFAULT_WAIT_SECONDS, readUsageLimit } from "./usage-limit";

/** One arm of one trial: `lineup` is `live` or a lineup file's name; `overlay` a prompt overlay directory, if any. */
export interface ArmSpec { arm: ArmName; lineup: string; overlay?: string | null }

export interface TrialHandle {
  run(options: { timeoutMs: number; signal: AbortSignal }): Promise<TrialResult>;
  /** The work tree's diff against the trial base, read before dispose; "" if none. */
  partialPatch(): string;
  /** Write a git bundle of every ref in the trial's origin to `path`, read before dispose: scoring checks the arm's commits out of it later. */
  keep(path: string): void;
  dispose(): void;
  /** What the starter resolved the arm to (#816); a starter that cannot say leaves it out. */
  resolved?: ArmResolution;
}

export type LeaseAcquired = { ok: true } | { ok: false; why: string };

export interface BacktestRunDeps {
  /** Absolute; created if missing. */
  runDir: string;
  /** May throw: the trial is reported as not run, left unsaved so a rerun retries it, and the batch goes on. */
  startTrial(ticket: BacktestTicket, arm: ArmSpec): Promise<TrialHandle>;
  /**
   * Build the case's merge-base once, inside the lease, before its first trial
   * (#820). A failure refuses every arm of the case as not run, unsaved, so a
   * rerun checks it again. Absent (no `scoring.setup`): no check.
   */
  checkBase?(ticket: BacktestTicket, options: { timeoutMs: number; signal: AbortSignal }): Promise<BaseBuild>;
  /** `signal` is the trial's: an operator abort must end a lease wait, not outlast it. */
  lease: { acquire(ticket: BacktestTicket, arm: ArmSpec, signal: AbortSignal): Promise<LeaseAcquired>; release(): Promise<void> };
  now(): number;
  /** Resolves early on abort. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  log(line: string): void;
  /** The operator's Ctrl-C: stop after killing the current trial; the state stays resumable. */
  signal?: AbortSignal;
  /**
   * A provider's fullest usage window (#801), read before each trial for every
   * provider the run spends (#822); null when there is no reading. Absent: no guard.
   */
  usage?: (runner: UsageRunner) => UsageReading | null;
  /** The runners the arms' lineups name (#822); the panel's come from the config. Absent: none beyond Claude. */
  armRunners?: readonly string[];
  /** The default panel's Codex judge model (#817); absent: the one models.json names. */
  codexModel?: string | null;
}

export interface BacktestState {
  version: 1;
  id: string;
  startedAt: string;
  config: BacktestConfig;
  sample: BacktestSample;
  /** Finished rows by `<oaKey>/<arm>`. A not-run or operator-killed trial is never here, so a rerun runs it. */
  rows: Record<string, TrialRow>;
  /**
   * What each arm resolved to when its first trial was built (#816), kept so
   * a resume reports the models the batch started with. Absent before #816.
   */
  resolved?: Record<ArmName, ArmResolution>;
}

/**
 * Usage pauses one trial may take in one invocation. Past them the trial is
 * not run, never failed (#822): a limit says nothing about the arm, so the
 * trial stays out of the state and a rerun after the reset runs it.
 */
const MAX_USAGE_PAUSES = 3;

const PROVIDER: Record<UsageRunner, string> = { claude: "Claude", codex: "Codex" };

/** How long a trial waits before asking again for a host lease it was not granted. */
export const LEASE_RETRY_MS = 5 * 60_000;

const iso = (ms: number): string => new Date(ms).toISOString();
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A single path segment: no separator, and never `.` or `..`, whatever the tracker spells a key as. */
export function segment(text: string): string {
  const safe = text.replace(/[^\w.-]/g, "_");
  return safe === "" || safe.startsWith(".") ? `_${safe}` : safe;
}

/** Write then rename, so a kill mid-write leaves the previous file, never half of one. */
export function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The arms rotated by one per ticket (B then C, then C then B, for two), so
 * no arm always runs on the fresher host. The arms are the sample's, not the
 * config's: a resumed batch replays the arms it started with.
 */
export function trialOrder(sample: BacktestSample): { ticket: BacktestTicket; arm: ArmSpec }[] {
  const arms: ArmSpec[] = armList(sample.arms).map((arm) => ({ arm: arm.name, lineup: arm.lineup, ...(arm.overlay === null ? {} : { overlay: arm.overlay }) }));
  return sample.tickets.flatMap((ticket, index) => {
    const shift = index % arms.length;
    return [...arms.slice(shift), ...arms.slice(0, shift)].map((arm) => ({ ticket, arm }));
  });
}

/** A row for a trial that produced no result to score: a refusal before it ran, or one the batch cap left. */
function bareRow(ticket: BacktestTicket, arm: ArmSpec, outcome: TrialRow["outcome"], detail: string, artifacts: string): TrialRow {
  return {
    ticket: ticket.oaKey, arm: arm.arm, lineup: arm.lineup, outcome, detail,
    gates: null, weakening: [], reviewRounds: null, reviewThreads: null, wallSeconds: 0, handoffSeconds: null,
    tokens: null, cost: { usd: null, source: "unknown" }, artifacts, models: [],
    heads: { base: null, first: null, final: null },
  };
}

function writeTicket(dir: string, ticket: BacktestTicket): void {
  writeAtomic(join(dir, "ticket.json"), json({
    oaKey: ticket.oaKey, ticketRef: ticket.ticketRef, mergeBase: ticket.mergeBase, startedAt: ticket.startedAt, frozen: ticket.frozen,
  }));
}

/** Everything a trial left, the logs as files of their own: result.json would otherwise carry megabytes of them. */
function writeArtifacts(dir: string, ticket: BacktestTicket, result: TrialResult, partialPatch: string): void {
  writeTicket(dir, ticket);
  const { outcome, failures, base, finalHead, models, github, tracker, speed } = result;
  // `speed` is the trial's claim-to-hand-off ledger: kept so a saved trial can be re-scored.
  writeAtomic(join(dir, "result.json"), json({ outcome, failures, base, finalHead, models, github, tracker, speed: speed ?? [] }));
  writeAtomic(join(dir, "patch.diff"), result.patch);
  if (partialPatch !== "") writeAtomic(join(dir, "partial.patch"), partialPatch);
  for (const log of result.logs) writeAtomic(join(dir, "logs", segment(log.path.replace(/[\\/]+/g, "__"))), log.text);
}

type Attempt =
  | { kind: "row"; row: TrialRow }
  /** A trial that never ran: reported, never saved, so a rerun retries it. */
  | { kind: "not-run"; row: TrialRow }
  | { kind: "lease-refused"; why: string }
  | { kind: "capped" }
  | { kind: "aborted" }
  | { kind: "usage-limit"; untilMs: number; window: string; result: TrialResult; partialPatch: string };

/**
 * The newest `.events.jsonl` log's lines. Inside a trial `ralph.sh` waits out a
 * usage limit itself and reruns the iteration, so an older file may end in a
 * rejection the run already got past; the names carry the timestamp
 * (`iter-<ts>-<pid>-<i>.events.jsonl`), so the last by basename is the newest.
 */
function newestEventLines(logs: TrialResult["logs"]): string[] {
  const events = logs.filter((entry) => entry.path.endsWith(".events.jsonl"));
  if (events.length === 0) return [];
  const newest = [...events].sort((a, b) => {
    const left = basename(a.path);
    const right = basename(b.path);
    return left < right ? -1 : left > right ? 1 : 0;
  }).at(-1)!;
  return newest.text.split("\n");
}

/**
 * The config without what only scoring reads, or only when trials start: the
 * part a resumed batch's trials must agree on. The usage guard decides when
 * a trial runs, never what it runs.
 */
export function trialConfig(config: BacktestConfig): Omit<BacktestConfig, "scoring" | "usageGuard"> {
  const { scoring: _scoring, usageGuard: _usageGuard, ...rest } = config;
  return rest;
}

/**
 * The cases to repeat: those whose arms that ran disagree on green, plus any
 * the caller names. A case where every arm failed, or every arm went green,
 * is a clear answer and is not paid for again.
 */
export function repeatedCases(rows: readonly TrialRow[], named: readonly string[]): Set<string> {
  const cases = new Set(named);
  const byCase = new Map<string, boolean[]>();
  for (const row of rows) {
    if (row.repeat !== undefined || row.outcome === "not-run") continue;
    byCase.set(row.ticket, [...(byCase.get(row.ticket) ?? []), row.outcome === "green-pr"]);
  }
  for (const [ticket, greens] of byCase) if (greens.includes(true) && greens.includes(false)) cases.add(ticket);
  return cases;
}

/**
 * The report's notes plus why the default panel lost its second judge (#817),
 * once. A rescore replaces the batch's note: a Codex model named since then
 * means the panel that scored had both judges, and the old note would contradict it.
 */
export function panelNotes(notes: string[], config: BacktestConfig, codex: string | null = codexJudgeModel()): string[] {
  const note = defaultPanelNote(config.scoring.judge, codex);
  const kept = notes.filter((entry) => entry !== OPUS_ALONE_NOTE);
  return note === null ? kept : [...kept, note];
}

/**
 * The panel and seed a config scores with (#816): the seed by the rule
 * `scoreBacktest` uses, so the recorded one is the one the judges were
 * shuffled by. A rescore recomputes it, since it may score with a new panel.
 */
export function panelRecord(config: BacktestConfig, runId: string, codex: string | null = codexJudgeModel()): Pick<RunResolution, "panel" | "seed"> {
  const judge = config.scoring.judge;
  if (judge === null) return { panel: [], seed: null };
  return { panel: judgeSpecs(judge, codex).map((spec) => ({ name: spec.name, runner: spec.runner, model: spec.model })), seed: judge.seed ?? runId };
}

export async function runBacktest(sample: BacktestSample, config: BacktestConfig, deps: BacktestRunDeps,
  options: { repeatCases?: readonly string[] } = {}): Promise<BacktestReport> {
  const { runDir, log } = deps;
  const codex = deps.codexModel === undefined ? codexJudgeModel() : deps.codexModel;
  const statePath = join(runDir, "state.json");
  mkdirSync(runDir, { recursive: true });

  let state: BacktestState;
  if (existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, "utf8")) as BacktestState;
    // Another batch's directory resumed under this config would mix two
    // batches' rows in one report.
    // Scoring options never change a trial, and a state written before #534
    // has no `scoring` at all, so they are left out of the comparison.
    if (JSON.stringify(trialConfig(state.config)) !== JSON.stringify(trialConfig(config))) {
      throw new Error(`backtest: ${statePath} belongs to a batch with a different config; use a fresh run directory`);
    }
    // Its sample, not the passed one: the ledger may have moved on since, and
    // a resume must replay the batch it started.
    log(`resumed ${state.id}: ${Object.keys(state.rows).length} trial(s) already finished`);
  } else {
    const startedMs = deps.now();
    state = {
      version: 1,
      id: `backtest-${iso(startedMs).replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`,
      startedAt: iso(startedMs),
      config,
      sample,
      rows: {},
    };
    writeAtomic(statePath, json(state));
  }

  // Every provider the run spends (#822): a Codex arm or judge spends Codex's
  // window, which the loops on this host may need as much as Claude's.
  const guarded = usageRunners([
    ...(deps.armRunners ?? []),
    ...(config.scoring.judge === null ? [] : judgeSpecs(config.scoring.judge, codex).map((spec) => spec.runner)),
  ]);

  const batchMs = config.caps.batchMinutes * 60_000;
  const trialMs = config.caps.trialMinutes * 60_000;
  const invokedAt = deps.now();
  // Time asleep on a usage limit is the provider's, not the batch's.
  let pausedMs = 0;
  const remainingMs = (): number => batchMs - (deps.now() - invokedAt - pausedMs);

  const rows: TrialRow[] = [];
  let stopped = false;
  let capped = false;
  // Each case's base build this invocation (#820): null when it built, else why
  // not. Never in the state file, so a rerun builds the base again.
  const baseBuilds = new Map<string, string | null>();
  const baseRefusal = (ticket: BacktestTicket): string | null => {
    const failed = baseBuilds.get(ticket.oaKey);
    return failed === undefined || failed === null ? null : `the base does not build, so no arm ran: ${failed}`;
  };

  const attempt = async (ticket: BacktestTicket, arm: ArmSpec, dir: string, artifacts: string): Promise<Attempt> => {
    // The lease is taken before the trial is built: building clones a repo,
    // and nothing heavy may run on the host outside it.
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (deps.signal?.aborted) controller.abort();
    deps.signal?.addEventListener("abort", onAbort);
    let deadline: ReturnType<typeof setTimeout> | null = null;
    try {
      let leased: LeaseAcquired;
      try { leased = await deps.lease.acquire(ticket, arm, controller.signal); } catch (error) { leased = { ok: false, why: message(error) }; }
      // Before the build: no trial is started after a Ctrl-C, granted or not.
      if (deps.signal?.aborted) return { kind: "aborted" };
      if (!leased.ok) {
        writeTicket(dir, ticket);
        writeAtomic(join(dir, "result.json"), json({ outcome: { kind: "not-run" }, detail: `host lease: ${leased.why}` }));
        return { kind: "lease-refused", why: leased.why };
      }
      if (deps.checkBase && !baseBuilds.has(ticket.oaKey)) {
        if (remainingMs() <= 0) return { kind: "capped" };
        let built: BaseBuild;
        try { built = await deps.checkBase(ticket, { timeoutMs: remainingMs(), signal: controller.signal }); } catch (error) {
          built = { ok: false, reason: message(error) };
        }
        // A stopped build is no verdict on the base: nothing is cached, and the batch stops or retries.
        if (deps.signal?.aborted) return { kind: "aborted" };
        if (!built.ok && built.aborted) {
          writeTicket(dir, ticket);
          writeAtomic(join(dir, "result.json"), json({ outcome: { kind: "not-run" }, detail: built.reason }));
          return { kind: "not-run", row: bareRow(ticket, arm, "not-run", built.reason, artifacts) };
        }
        baseBuilds.set(ticket.oaKey, built.ok ? null : built.reason);
        if (!built.ok) log(`${ticket.oaKey}: the base does not build; its arms are not run: ${built.reason.split("\n")[0]}`);
      }
      const refused = baseRefusal(ticket);
      if (refused !== null) {
        writeTicket(dir, ticket);
        writeAtomic(join(dir, "result.json"), json({ outcome: { kind: "not-run" }, detail: refused }));
        return { kind: "not-run", row: bareRow(ticket, arm, "not-run", refused, artifacts) };
      }
      let handle: TrialHandle;
      try { handle = await deps.startTrial(ticket, arm); } catch (error) {
        // A build that failed says nothing about the arm, so it is no verdict: a rerun retries it.
        const detail = `could not build the trial: ${message(error)}`;
        writeTicket(dir, ticket);
        writeAtomic(join(dir, "result.json"), json({ outcome: { kind: "not-run" }, detail }));
        return { kind: "not-run", row: bareRow(ticket, arm, "not-run", detail, artifacts) };
      }
      // The first build per arm is the record: a later one (or a resume after
      // models.json moved) must not rewrite what the batch started with.
      // Own keys only: an arm named like an Object.prototype member (`constructor`) must still record.
      if (handle.resolved !== undefined && !(state.resolved !== undefined && Object.hasOwn(state.resolved, arm.arm))) {
        state.resolved = { ...state.resolved, [arm.arm]: handle.resolved };
        writeAtomic(statePath, json(state));
      }
      try {
        if (deps.signal?.aborted) return { kind: "aborted" };
        // The lease wait and the build can outlast the batch: a trial started
        // with no time left would be killed at once and saved as timed out.
        if (remainingMs() <= 0) return { kind: "capped" };
        const remaining = remainingMs();
        const timeoutMs = Math.max(0, Math.min(trialMs, remaining));
        // The timeout already ends the trial by the batch deadline; this is the
        // backstop for a sandbox that overruns it.
        deadline = setTimeout(() => controller.abort(), Math.max(0, remaining));
        deadline.unref?.();
        const started = deps.now();
        let result: TrialResult | null = null;
        let threw: string | null = null;
        try { result = await handle.run({ timeoutMs, signal: controller.signal }); } catch (error) { threw = message(error); }
        const wallSeconds = (deps.now() - started) / 1000;
        let partialPatch = "";
        try { partialPatch = handle.partialPatch(); } catch (error) { log(`${artifacts}: could not read the partial patch: ${message(error)}`); }
        // Dispose removes the trial's origin, so its commits are bundled now or never.
        const keep = (): void => {
          try { handle.keep(join(dir, "arm.bundle")); } catch (error) { log(`${artifacts}: could not keep the arm's commits: ${message(error)}`); }
        };
        if (deps.signal?.aborted) {
          if (result) {
            writeArtifacts(dir, ticket, result, partialPatch);
            keep();
          }
          return { kind: "aborted" };
        }
        if (result === null) {
          writeTicket(dir, ticket);
          writeAtomic(join(dir, "result.json"), json({ outcome: { kind: "failed" }, detail: threw }));
          if (partialPatch !== "") writeAtomic(join(dir, "partial.patch"), partialPatch);
          return { kind: "row", row: { ...bareRow(ticket, arm, "failed", `the trial threw: ${threw}`, artifacts), wallSeconds } };
        }
        // A run that ended with a sigil got past any limit it met.
        if (result.outcome.kind !== "refused" && result.outcome.sigil === null) {
          const limit = readUsageLimit(newestEventLines(result.logs), deps.now(), {
            marginSeconds: DEFAULT_MARGIN_SECONDS, defaultSeconds: DEFAULT_WAIT_SECONDS, minSeconds: DEFAULT_MIN_WAIT_SECONDS,
          });
          if (limit) {
            // No bundle: a limited attempt is never scored, and its logs and patch are kept beside the trial's.
            return { kind: "usage-limit", untilMs: limit.untilMs, window: limit.window, result, partialPatch };
          }
        }
        writeArtifacts(dir, ticket, result, partialPatch);
        keep();
        const row = scoreTrial({ ticket: ticket.oaKey, arm: arm.arm, lineup: arm.lineup, result, wallSeconds, partialPatch, artifacts, rates: config.rates });
        return { kind: "row", row };
      } finally {
        try { handle.dispose(); } catch (error) { log(`${artifacts}: could not dispose of the trial: ${message(error)}`); }
      }
    } finally {
      if (deadline !== null) clearTimeout(deadline);
      deps.signal?.removeEventListener("abort", onAbort);
      try { await deps.lease.release(); } catch (error) { log(`${artifacts}: could not release the host lease: ${message(error)}`); }
    }
  };

  /**
   * One trial under `key`, resumed from the state when it already finished.
   * "break" when the operator stopped the batch; the caller ends there.
   */
  const runKey = async (ticket: BacktestTicket, arm: ArmSpec, key: string, artifacts: string, repeat?: number): Promise<"next" | "break"> => {
    const tag = (row: TrialRow): TrialRow => (repeat === undefined ? row : { ...row, repeat });
    const done = state.rows[key];
    if (done) { rows.push(done); return "next"; }
    if (stopped || deps.signal?.aborted) { stopped = true; return "break"; }
    // The case's base already failed to build this invocation: its other arms
    // cost no lease and no wait, and stay unsaved so a rerun tries again.
    const refused = baseRefusal(ticket);
    if (refused !== null) {
      rows.push(tag(bareRow(ticket, arm, "not-run", refused, artifacts)));
      log(`${key}: not run — the base does not build; a rerun retries it`);
      return "next";
    }
    if (capped || remainingMs() <= 0) {
      capped = true;
      rows.push(tag(bareRow(ticket, arm, "not-run", "batch cap reached", artifacts)));
      return "next";
    }

    // Live loops first (#801): with the usage window this full, the trial waits
    // for it to reset. The wait is the provider's time, not the batch's.
    // Bounded: a reading that never drops (a stale UsageBar, a window that
    // does not reset when it says) runs the trial after GUARD_MAX_WAIT_MS
    // rather than holding the run without end.
    const limit = usageLimit(state.config);
    const guardStarted = deps.now();
    while (deps.usage && limit !== null && !deps.signal?.aborted) {
      // The fullest provider over the limit decides the wait; a provider with
      // no reading guards nothing, and the others still do.
      let over: { runner: UsageRunner; reading: UsageReading } | null = null;
      for (const runner of guarded) {
        let reading: UsageReading | null = null;
        try { reading = deps.usage(runner); } catch (error) { log(`${key}: ${PROVIDER[runner]} usage not read (${message(error)})`); }
        if (reading === null || reading.usedPercent < limit) continue;
        if (over === null || reading.usedPercent > over.reading.usedPercent) over = { runner, reading };
      }
      if (over === null) break;
      const { runner, reading } = over;
      if (deps.now() - guardStarted >= GUARD_MAX_WAIT_MS) {
        log(`${key}: the ${PROVIDER[runner]} ${reading.window} window still reads ${reading.usedPercent}% after ${GUARD_MAX_WAIT_MS / 3_600_000} hours of waiting; running anyway`);
        break;
      }
      const before = deps.now();
      const waitMs = guardWaitMs(reading, before);
      log(`${key}: ${PROVIDER[runner]} ${reading.window} window ${reading.usedPercent}% used, at or over the ${limit}% limit; waiting ${Math.round(waitMs / 60_000)} minutes${reading.resetsAt ? ` (resets ${reading.resetsAt})` : ""}`);
      try { await deps.sleep(waitMs, deps.signal ?? new AbortController().signal); } catch (error) {
        // A sleep that cannot sleep would turn this into a busy loop on codexbar.
        log(`${key}: the usage wait failed (${message(error)}); running`);
        break;
      }
      pausedMs += Math.max(0, deps.now() - before);
    }
    if (deps.signal?.aborted) { stopped = true; return "break"; }

    const dir = join(runDir, artifacts);
    // A trial killed by an earlier invocation left its files; a rerun starts it clean.
    rmSync(dir, { recursive: true, force: true });
    log(`${key}: starting (${arm.lineup})`);
    let row: TrialRow | null = null;
    let unsaved: TrialRow | null = null;
    let leaseWhy: string | null = null;
    for (let pauses = 0; row === null && !stopped; ) {
      if ((pauses > 0 || leaseWhy !== null) && remainingMs() <= 0) { capped = true; break; }
      const outcome = await attempt(ticket, arm, dir, artifacts);
      if (outcome.kind === "aborted") { stopped = true; break; }
      if (outcome.kind === "row") { row = outcome.row; break; }
      if (outcome.kind === "not-run") { unsaved = outcome.row; break; }
      if (outcome.kind === "capped") { leaseWhy = null; capped = true; break; }
      if (outcome.kind === "lease-refused") {
        leaseWhy = outcome.why;
        log(`${key}: host lease not granted (${outcome.why}); asking again in ${LEASE_RETRY_MS / 60_000} minutes`);
        // Host time, not the provider's: this wait counts against the batch cap.
        try { await deps.sleep(LEASE_RETRY_MS, deps.signal ?? new AbortController().signal); } catch (error) { log(`${key}: the lease wait ended early: ${message(error)}`); }
        if (deps.signal?.aborted) stopped = true;
        continue;
      }
      // The rejected run does not count: its files are kept beside the trial's, and the same trial runs again.
      writeArtifacts(join(dir, `usage-limited-${pauses + 1}`), ticket, outcome.result, outcome.partialPatch);
      if (pauses >= MAX_USAGE_PAUSES) {
        // Not run, never failed (#822): the limit held, not the arm. Unsaved, so a rerun after the reset runs it.
        const detail = `usage limit: the ${outcome.window} window still rejected it after ${MAX_USAGE_PAUSES} pauses; resets ${iso(outcome.untilMs)}`;
        writeTicket(dir, ticket);
        writeAtomic(join(dir, "result.json"), json({ outcome: { kind: "not-run" }, detail }));
        unsaved = bareRow(ticket, arm, "not-run", detail, artifacts);
        break;
      }
      pauses++;
      const before = deps.now();
      const waitMs = Math.max(0, outcome.untilMs - before);
      log(`${key}: ${outcome.window} usage limit; pausing until ${iso(outcome.untilMs)} (pause ${pauses}/${MAX_USAGE_PAUSES}), then rerunning`);
      try { await deps.sleep(waitMs, deps.signal ?? new AbortController().signal); } catch (error) { log(`${key}: the usage pause ended early: ${message(error)}`); }
      pausedMs += Math.max(0, deps.now() - before);
      if (deps.signal?.aborted) stopped = true;
    }
    if (stopped) { log(`${key}: stopped by the operator; a rerun on ${runDir} redoes it`); return "break"; }
    if (unsaved !== null) {
      rows.push(tag(unsaved));
      log(`${key}: not run — ${unsaved.detail}; a rerun retries it`);
      return "next";
    }
    if (row === null) {
      capped = true;
      const detail = leaseWhy === null ? "batch cap reached" : `batch cap reached (host lease: ${leaseWhy})`;
      rows.push(tag(bareRow(ticket, arm, "not-run", detail, artifacts)));
      return "next";
    }
    const saved = tag(row);
    rows.push(saved);
    state.rows[key] = saved;
    writeAtomic(statePath, json(state));
    log(`${key}: ${saved.outcome} — ${saved.detail}`);
    return "next";
  };

  const order = trialOrder(state.sample);
  for (const { ticket, arm } of order) {
    if (await runKey(ticket, arm, `${ticket.oaKey}/${arm.arm}`, `${segment(ticket.oaKey)}/${arm.arm}`) === "break") break;
  }

  // Repeats (#801): a case whose arms disagree — one green, another not —
  // or that the caller names (a panel that contested it) runs k more times
  // per arm, so one lucky trial does not decide the comparison. Each repeat
  // is scored and judged too (#821); the verdict stays the first trial's.
  const k = repeatCount(state.config);
  if (k > 0 && !stopped) {
    const cases = repeatedCases(rows, options.repeatCases ?? []);
    for (const ticket of state.sample.tickets.filter((entry) => cases.has(entry.oaKey))) {
      if (stopped) break;
      for (let repeat = 1; repeat <= k && !stopped; repeat++) {
        for (const { arm } of order.filter((entry) => entry.ticket.oaKey === ticket.oaKey)) {
          const key = `${ticket.oaKey}/${arm.arm}/r${repeat}`;
          if (await runKey(ticket, arm, key, `${segment(ticket.oaKey)}/${arm.arm}-r${repeat}`, repeat) === "break") break;
        }
      }
    }
  }

  const report: BacktestReport = {
    id: state.id,
    startedAt: state.startedAt,
    finishedAt: stopped ? null : iso(deps.now()),
    arms: state.sample.arms,
    rows,
    skipped: state.sample.skipped.map((skip) => ({ oaKey: skip.oaKey, reason: skip.reason })),
    notes: panelNotes(state.sample.notes, config, codex),
    stoppedBy: capped ? "batch-cap" : null,
    resolved: { arms: state.resolved ?? {}, ...panelRecord(config, state.id, codex) },
    ...(state.sample.set === undefined ? {} : { set: {
      version: state.sample.set.version,
      selected: [...state.sample.set.selected],
      ...(state.sample.set.checks === undefined ? {} : { checks: [...state.sample.set.checks] }),
    } }),
  };
  writeAtomic(join(runDir, "report.json"), json(report));
  writeAtomic(join(runDir, "report.md"), renderBacktestReport(report));
  return report;
}
