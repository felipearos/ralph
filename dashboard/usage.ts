/**
 * Usage and cost, read from the logs every loop already writes.
 *
 * Three sources, all under a worktree's `.ralph/logs`:
 *
 * - `iter-*.events.jsonl`, the tagged runner stream. A Claude run ends with a
 *   `result` event carrying `total_cost_usd` and a per-model breakdown — the
 *   cost the harness itself reports for that one invocation. Rate-limit events
 *   carry the plan's five-hour and seven-day utilisation.
 * - `usage-ledger.tsv`, where `usage.py` books tokens per step. Its labels name
 *   the issue a session worked on (`claim #874`), and delegated runners that
 *   do not report a cost book their tokens here.
 * - delegated `*.usage` sidecars paired with their redacted `*.log.jsonl`
 *   streams. OpenCode reports an incremental cost on each `step_finish`; the
 *   sidecar's exact token totals match that cost back to its ledger row.
 *
 * Nothing is priced here. A cost is a reported one or it is absent; tokens a
 * harness did not price stay tokens. That is the harness's rule for usage
 * reporting, and a dashboard that invented a figure would break it quietly.
 *
 * Read-only: the files are opened for reading and tailed from where the last
 * read stopped, so a long iteration's transcript is not re-read on every poll.
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import type {
  DailySpendView,
  LoopSpendView,
  ModelSpendView,
  PlanUsageView,
  SpendWindows,
  StageSpendView,
  TaskCostView,
  UsageReport,
  UsageWindowView,
} from "./contracts";

const LOGS_DIR = ".ralph/logs";
const LEDGER_FILE = "usage-ledger.tsv";
const EVENTS_FILE = /^iter-.*\.events\.jsonl$/;
const HOUR_MS = 3_600_000;
/** How far back the daily series reaches: UsageBar's longest spend range. */
export const DAILY_DAYS = 90;

/** The host's local calendar date of an instant, `YYYY-MM-DD`. */
export function localDay(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/* ------------------------------------------------------------------ records */

export interface ModelRun {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export interface ResultRecord {
  uuid: string;
  stage: string;
  run: string | null;
  iteration: number | null;
  session: string | null;
  at: string;
  costUsd: number | null;
  models: Record<string, ModelRun>;
}

/** The orchestrator's session for one iteration, from its `system init` event. */
export interface InitRecord {
  run: string | null;
  iteration: number | null;
  session: string;
  at: string;
}

export interface RateRecord {
  at: string;
  status: string;
  limitingWindow: string | null;
  usingOverage: boolean;
  fiveHour: RawWindow | null;
  sevenDay: RawWindow | null;
}

export interface RawWindow {
  utilization: number;
  resetsAt: string | null;
}

export interface LedgerRow {
  run: string;
  session: string;
  at: string;
  label: string;
  model: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface ExternalCostRecord {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export type UsageEvent =
  | { kind: "result"; value: ResultRecord }
  | { kind: "codexTokens"; value: CodexTokenRecord }
  | { kind: "init"; value: InitRecord }
  | { kind: "rate"; value: RateRecord };

export interface LoopLogs {
  loop: string;
  files: number;
  results: ResultRecord[];
  inits: InitRecord[];
  rates: RateRecord[];
  ledger: LedgerRow[];
  externalCosts: ExternalCostRecord[];
  codexTokens?: CodexTokenRecord[];
}

interface CodexTokenRecord extends Omit<LedgerRow, "label"> {
  id: string;
  iteration: number | null;
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

function windowOf(value: unknown): RawWindow | null {
  const raw = record(value);
  if (raw === null || typeof raw.utilization !== "number") return null;
  return {
    utilization: raw.utilization,
    resetsAt: typeof raw.resetsAt === "number" ? new Date(raw.resetsAt * 1000).toISOString() : null,
  };
}

/** One line of a runner stream, when it carries anything usage needs. */
export function parseEventLine(line: string): UsageEvent | null {
  // Cheap substring checks first: the stream is mostly tool traffic, and a
  // JSON.parse per line over tens of megabytes is the whole cost of this read.
  const maybeResult = line.includes('"total_cost_usd"');
  const maybeRate = line.includes('"rate_limit_event"');
  const maybeInit = line.includes('"init"') && line.includes('"orchestrator"');
  const maybeCodex = line.includes('"codex"');
  if (!maybeResult && !maybeRate && !maybeInit && !maybeCodex) return null;

  let event: Record<string, unknown> | null;
  try {
    event = record(JSON.parse(line));
  } catch {
    return null;
  }
  if (event === null) return null;
  const at = text(event.ralph_received_at);
  if (at === null) return null;
  const run = text(event.ralph_run);
  const iteration = typeof event.ralph_iteration === "number" ? event.ralph_iteration : null;

  if (event.runner === "codex" && event.ralph_stage === "orchestrator") {
    const session = text(event.session_id);
    const message = record(event.message);
    const usage = record(message?.usage);
    const id = text(message?.id);
    const model = text(message?.model);
    if (event.type === "assistant" && session && run && id && model?.startsWith("codex/") && usage) {
      return { kind: "codexTokens", value: {
        id, run, session, iteration, at, model,
        input: count(usage.input_tokens), output: count(usage.output_tokens),
        cacheRead: count(usage.cache_read_input_tokens), cacheWrite: 0,
      } };
    }
    if (event.type === "result" && session) {
      return { kind: "result", value: {
        uuid: text(event.uuid) ?? `${at}:${session}`, stage: "orchestrator",
        run, iteration, session, at, costUsd: null, models: {},
      } };
    }
  }

  if (event.type === "result" && typeof event.total_cost_usd === "number") {
    const models: Record<string, ModelRun> = {};
    for (const [model, raw] of Object.entries(record(event.modelUsage) ?? {})) {
      const usage = record(raw);
      if (usage === null) continue;
      models[model] = {
        input: count(usage.inputTokens),
        output: count(usage.outputTokens),
        cacheRead: count(usage.cacheReadInputTokens),
        cacheWrite: count(usage.cacheCreationInputTokens),
        costUsd: count(usage.costUSD),
      };
    }
    return {
      kind: "result",
      value: {
        uuid: text(event.uuid) ?? `${at}:${text(event.session_id) ?? ""}`,
        stage: text(event.ralph_stage) ?? "unknown",
        run,
        iteration,
        session: text(event.session_id),
        at,
        costUsd: event.total_cost_usd,
        models,
      },
    };
  }

  if (event.type === "rate_limit_event") {
    const info = record(event.rate_limit_info);
    if (info === null) return null;
    const windows = record(info.unifiedWindows) ?? {};
    const limiting = text(info.rateLimitType);
    // Older events carry only the limiting window's figures at the top level.
    const fiveHour = windowOf(windows.five_hour) ?? (limiting === "five_hour" ? windowOf(info) : null);
    const sevenDay = windowOf(windows.seven_day) ?? (limiting === "seven_day" ? windowOf(info) : null);
    return {
      kind: "rate",
      value: {
        at,
        status: text(info.status) ?? "unknown",
        limitingWindow: limiting,
        usingOverage: info.isUsingOverage === true || info.overageInUse === true,
        fiveHour,
        sevenDay,
      },
    };
  }

  if (event.type === "system" && event.subtype === "init" && event.ralph_stage === "orchestrator") {
    const session = text(event.session_id);
    return session === null ? null : { kind: "init", value: { run, iteration, session, at } };
  }
  return null;
}

/** One `usage-ledger.tsv` row: run, session, step, ts, label, model, then the five token columns. */
export function parseLedgerLine(line: string): LedgerRow | null {
  const parts = line.split("\t");
  if (parts.length < 11 || parts[0] === "run_id" || Number.isNaN(Date.parse(parts[3] ?? ""))) return null;
  const n = (value: string | undefined): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    run: parts[0]!,
    session: parts[1]!,
    at: parts[3]!,
    label: parts[4] ?? "",
    model: parts[5] ?? "",
    input: n(parts[6]),
    output: n(parts[7]),
    cacheWrite: n(parts[8]) + n(parts[9]),
    cacheRead: n(parts[10]),
  };
}

function parseExternalCostLine(line: string): number | null {
  if (!line.includes('"cost"') || !line.includes('"step_finish"')) return null;
  try {
    const event = record(JSON.parse(line));
    const part = record(event?.part);
    const cost = part?.cost;
    return event?.type === "step_finish" && typeof cost === "number" && Number.isFinite(cost) ? cost : null;
  } catch {
    return null;
  }
}

function externalUsage(textValue: string, costUsd: number): ExternalCostRecord | null {
  const values = new Map<string, string>();
  for (const line of textValue.split("\n")) {
    const split = line.indexOf("=");
    if (split > 0) values.set(line.slice(0, split), line.slice(split + 1));
  }
  const model = values.get("DELEGATE_MODEL");
  if (!model) return null;
  const n = (name: string): number => count(Number(values.get(name)));
  return {
    model,
    input: n("DELEGATE_INPUT"),
    output: n("DELEGATE_OUTPUT"),
    cacheRead: n("DELEGATE_CACHE_READ"),
    cacheWrite: n("DELEGATE_CACHE_WRITE"),
    costUsd,
  };
}

/* ------------------------------------------------------------------ tailing */

interface Tailed<T> {
  ino: number;
  size: number;
  mtimeMs: number;
  /** Byte offset just past the last complete line consumed. */
  offset: number;
  items: T[];
}

/**
 * Everything parsed from a file so far, reading only what was appended since
 * the last call. A trailing partial line waits for its newline; a file that
 * shrank or was replaced is read again from the start.
 */
export function readAppended<T>(
  cache: Map<string, Tailed<T>>,
  path: string,
  parse: (line: string) => T | null,
): T[] {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    cache.delete(path);
    return [];
  }
  let entry = cache.get(path);
  if (entry !== undefined && (stat.ino !== entry.ino || stat.size < entry.size)) entry = undefined;
  if (entry === undefined) {
    entry = { ino: stat.ino, size: -1, mtimeMs: -1, offset: 0, items: [] };
    cache.set(path, entry);
  }
  if (stat.size === entry.size && stat.mtimeMs === entry.mtimeMs) return entry.items;

  const length = stat.size - entry.offset;
  if (length > 0) {
    // Bound cold-read allocation independently of transcript size. Keep only
    // the current line between chunks, including UTF-8 split across chunks.
    const buffer = Buffer.alloc(Math.min(length, 64 * 1024));
    const fd = openSync(path, "r");
    let position = entry.offset;
    let fragments: Buffer[] = [];
    try {
      while (position < stat.size) {
        const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
        if (bytes === 0) break;
        let start = 0;
        for (let end = buffer.indexOf(10, start); end >= 0 && end < bytes; end = buffer.indexOf(10, start)) {
          const part = buffer.subarray(start, end);
          const line = (fragments.length === 0 ? part : Buffer.concat([...fragments, part])).toString("utf8");
          fragments = [];
          if (line !== "") {
            const item = parse(line);
            if (item !== null) entry.items.push(item);
          }
          entry.offset = position + end + 1;
          start = end + 1;
        }
        if (start < bytes) fragments.push(Buffer.from(buffer.subarray(start, bytes)));
        position += bytes;
      }
    } finally {
      closeSync(fd);
    }
  }
  entry.size = stat.size;
  entry.mtimeMs = stat.mtimeMs;
  return entry.items;
}

export interface UsageTarget {
  loop: string;
  worktree: string;
}

/** Reads each target's logs, keeping what it already parsed between calls. */
export function createUsageReader(): { read(targets: readonly UsageTarget[]): LoopLogs[] } {
  const events = new Map<string, Tailed<UsageEvent>>();
  const ledgers = new Map<string, Tailed<LedgerRow>>();
  const externalCosts = new Map<string, Tailed<number>>();

  return {
    read(targets) {
      const seen = new Set<string>();
      const logs = targets.map(({ loop, worktree }): LoopLogs => {
        const dir = join(worktree, LOGS_DIR);
        let names: string[] = [];
        try {
          names = readdirSync(dir).filter((name) => EVENTS_FILE.test(name));
        } catch {
          // No logs yet: the loop has simply cost nothing that can be read.
        }
        const out: LoopLogs = { loop, files: names.length, results: [], inits: [], rates: [], ledger: [], externalCosts: [], codexTokens: [] };
        for (const name of names) {
          const path = join(dir, name);
          seen.add(path);
          for (const event of readAppended(events, path, parseEventLine)) {
            if (event.kind === "result") out.results.push(event.value);
            else if (event.kind === "init") out.inits.push(event.value);
            else if (event.kind === "codexTokens") out.codexTokens!.push(event.value);
            else out.rates.push(event.value);
          }
        }
        const ledger = join(dir, LEDGER_FILE);
        seen.add(ledger);
        out.ledger = readAppended(ledgers, ledger, parseLedgerLine);
        let usageNames: string[] = [];
        try {
          usageNames = readdirSync(dir).filter((name) => name.endsWith(".usage"));
        } catch {
          // No delegated usage yet.
        }
        for (const name of usageNames) {
          const usagePath = join(dir, name);
          const eventsPath = join(dir, `${name.slice(0, -".usage".length)}.log.jsonl`);
          seen.add(eventsPath);
          let usageText: string;
          try {
            usageText = readFileSync(usagePath, "utf8");
          } catch {
            continue;
          }
          const costs = readAppended(externalCosts, eventsPath, parseExternalCostLine);
          if (costs.length === 0) continue;
          const parsed = externalUsage(usageText, costs.reduce((sum, cost) => sum + cost, 0));
          if (parsed !== null) out.externalCosts.push(parsed);
        }
        return out;
      });
      // Forget files that are gone, so a pruned worktree does not pin memory.
      for (const cache of [events, ledgers, externalCosts] as Map<string, unknown>[]) {
        for (const path of cache.keys()) if (!seen.has(path)) cache.delete(path);
      }
      return logs;
    },
  };
}

/* -------------------------------------------------------------- attribution */

const CLAIM = /\bclaim(?:ed|ing|s)?\b[^#\n]*#(\d+)/i;
const ISSUE = /#(\d+)/g;

/**
 * The issue a session worked on, from its ledger labels.
 *
 * A claim is the loop saying so outright. Without one, the issue the labels
 * mention most (ties to the later one) — a push or a PR note is about the work
 * in hand far more often than about a neighbour.
 */
export function issueForLabels(labels: readonly string[]): number | null {
  for (const label of labels) {
    const claim = CLAIM.exec(label);
    if (claim) return Number(claim[1]);
  }
  const tally = new Map<number, number>();
  let best: number | null = null;
  let bestCount = 0;
  for (const label of labels) {
    for (const match of label.matchAll(ISSUE)) {
      const issue = Number(match[1]);
      const seen = (tally.get(issue) ?? 0) + 1;
      tally.set(issue, seen);
      if (seen >= bestCount) {
        best = issue;
        bestCount = seen;
      }
    }
  }
  return best;
}

/* -------------------------------------------------------------- aggregation */

interface ModelTally {
  costUsd: number;
  priced: boolean;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function addModel(
  into: Map<string, ModelTally>,
  model: string,
  run: Omit<ModelRun, "costUsd">,
  costUsd: number | null,
): void {
  const tally = into.get(model) ?? { costUsd: 0, priced: false, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (costUsd !== null) {
    tally.costUsd += costUsd;
    tally.priced = true;
  }
  tally.input += run.input;
  tally.output += run.output;
  tally.cacheRead += run.cacheRead;
  tally.cacheWrite += run.cacheWrite;
  into.set(model, tally);
}

const tokensOf = (tally: ModelTally): number => tally.input + tally.output + tally.cacheRead + tally.cacheWrite;

const usageKey = (usage: Pick<LedgerRow, "model" | "input" | "output" | "cacheRead" | "cacheWrite">): string =>
  [usage.model, usage.input, usage.output, usage.cacheRead, usage.cacheWrite].join("\0");

const stageForExternal = (label: string): string => {
  for (const stage of ["mapper", "review.standards", "review.spec", "review.correctness"]) {
    if (label.startsWith(`${stage}:`)) return stage;
  }
  return "executor";
};

function modelViews(tallies: Map<string, ModelTally>): ModelSpendView[] {
  return [...tallies.entries()]
    .sort(([, left], [, right]) => right.costUsd - left.costUsd || tokensOf(right) - tokensOf(left))
    .map(([model, tally]) => ({
      model,
      costUsd: tally.priced ? tally.costUsd : null,
      tokens: { input: tally.input, output: tally.output, cacheRead: tally.cacheRead, cacheWrite: tally.cacheWrite },
    }));
}

interface TaskTally {
  loop: string;
  issue: number | null;
  costUsd: number;
  runs: number;
  iterations: Set<string>;
  unpricedTokens: number;
  unreported: boolean;
  firstAt: string;
  lastAt: string;
  stages: Map<string, number>;
  models: Map<string, ModelTally>;
}

const iterationKey = (run: string | null, iteration: number | null): string => `${run ?? "?"}#${iteration ?? "?"}`;

/**
 * Claude's stream can emit another `result` whenever a completed background
 * task wakes an otherwise-finished session. Each result has a fresh UUID, but
 * its cost and model usage are cumulative for the whole session. Keep the
 * newest snapshot for each stage/session; summing the snapshots bills the same
 * work once per notification. A missing session cannot be identified this way,
 * so retain the UUID-based behaviour for those records.
 */
function finalSessionResults(results: readonly ResultRecord[]): ResultRecord[] {
  const final = new Map<string, ResultRecord>();
  for (const result of results) {
    const key = result.session === null ? `uuid:${result.uuid}` : `session:${result.stage}:${result.session}`;
    const current = final.get(key);
    if (current === undefined || result.at >= current.at) final.set(key, result);
  }
  return [...final.values()];
}

function windowView(raw: RawWindow | null, nowMs: number): UsageWindowView | null {
  if (raw === null) return null;
  return {
    utilization: raw.utilization,
    resetsAt: raw.resetsAt,
    lapsed: raw.resetsAt !== null && Date.parse(raw.resetsAt) <= nowMs,
  };
}

/** Fold every loop's logs into one report. Pure: the clock is an argument. */
export function summarizeUsage(logs: readonly LoopLogs[], nowMs: number): UsageReport {
  const spend: SpendWindows = { last5h: 0, last24h: 0, last7d: 0, total: 0 };
  const tasks = new Map<string, TaskTally>();
  const weekModels = new Map<string, ModelTally>();
  const loops: LoopSpendView[] = [];
  const seenRuns = new Set<string>();
  let latestRate: { rate: RateRecord; loop: string } | null = null;
  let latestWindows: RateRecord | null = null;
  const sources = { files: 0, results: 0, ledgerRows: 0 };
  // Per local day, per model: the same reported costs and tokens the windows
  // above count, bucketed so the page can draw any range up to DAILY_DAYS.
  const firstDay = localDay(nowMs - (DAILY_DAYS - 1) * 24 * HOUR_MS);
  const days = new Map<string, Map<string, ModelTally>>();
  const addDaily = (at: string, model: string, run: Omit<ModelRun, "costUsd">, costUsd: number | null): void => {
    const ms = Date.parse(at);
    if (Number.isNaN(ms)) return;
    const day = localDay(ms);
    if (day < firstDay) return;
    let models = days.get(day);
    if (models === undefined) {
      models = new Map();
      days.set(day, models);
    }
    addModel(models, model, run, costUsd);
  };
  const NO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  const taskFor = (loop: string, issue: number | null, at: string): TaskTally => {
    const key = `${loop}:${issue ?? "none"}`;
    let task = tasks.get(key);
    if (task === undefined) {
      task = {
        loop,
        issue,
        costUsd: 0,
        runs: 0,
        iterations: new Set(),
        unpricedTokens: 0,
        unreported: false,
        firstAt: at,
        lastAt: at,
        stages: new Map(),
        models: new Map(),
      };
      tasks.set(key, task);
    }
    if (at < task.firstAt) task.firstAt = at;
    if (at > task.lastAt) task.lastAt = at;
    return task;
  };

  for (const loop of logs) {
    sources.files += loop.files;
    sources.ledgerRows += loop.ledger.length;

    const labels = new Map<string, string[]>();
    for (const row of loop.ledger) {
      const list = labels.get(row.session) ?? [];
      list.push(row.label);
      labels.set(row.session, list);
    }
    const issues = new Map<string, number | null>();
    const issueOf = (session: string | null): number | null => {
      if (session === null) return null;
      if (!issues.has(session)) issues.set(session, issueForLabels(labels.get(session) ?? []));
      return issues.get(session)!;
    };

    // An iteration's issue is the orchestrator's: the executor and inspectors
    // run in sessions of their own that the ledger never labels.
    const orchestratorSession = new Map<string, string>();
    for (const init of loop.inits) orchestratorSession.set(iterationKey(init.run, init.iteration), init.session);
    for (const result of loop.results) {
      const key = iterationKey(result.run, result.iteration);
      if (result.stage === "orchestrator" && result.session !== null && !orchestratorSession.has(key)) {
        orchestratorSession.set(key, result.session);
      }
    }

    const loopModels = new Map<string, ModelTally>();
    const loopView: LoopSpendView = { loop: loop.loop, costUsd: 0, last7d: 0, runs: 0, unpricedTokens: 0, models: [] };
    const reportedIterations = new Set<string>();
    const externalByUsage = new Map<string, number[]>();
    for (const external of loop.externalCosts) {
      const key = usageKey(external);
      const costs = externalByUsage.get(key) ?? [];
      costs.push(external.costUsd);
      externalByUsage.set(key, costs);
    }

    for (const result of finalSessionResults(loop.results)) {
      if (seenRuns.has(result.uuid)) continue;
      seenRuns.add(result.uuid);
      sources.results += 1;
      const key = iterationKey(result.run, result.iteration);
      if (result.stage === "orchestrator") reportedIterations.add(key);
      if (result.costUsd === null) {
        taskFor(loop.loop, issueOf(result.session), result.at).iterations.add(key);
        continue;
      }
      const ageMs = nowMs - Date.parse(result.at);
      const cost = result.costUsd;
      spend.total += cost;
      if (ageMs <= 5 * HOUR_MS) spend.last5h += cost;
      if (ageMs <= 24 * HOUR_MS) spend.last24h += cost;
      const inWeek = ageMs <= 168 * HOUR_MS;
      if (inWeek) spend.last7d += cost;

      loopView.costUsd += cost;
      loopView.runs += 1;
      if (inWeek) loopView.last7d += cost;

      const task = taskFor(loop.loop, issueOf(orchestratorSession.get(key) ?? null), result.at);
      task.costUsd += cost;
      task.runs += 1;
      task.iterations.add(key);
      task.stages.set(result.stage, (task.stages.get(result.stage) ?? 0) + cost);

      const entries = Object.entries(result.models);
      for (const [model, run] of entries) {
        addModel(loopModels, model, run, run.costUsd);
        addModel(task.models, model, run, run.costUsd);
        if (inWeek) addModel(weekModels, model, run, run.costUsd);
        addDaily(result.at, model, run, run.costUsd);
      }
      // A cost reported without a per-model split still belongs to its day.
      if (entries.length === 0) addDaily(result.at, "unknown", NO_TOKENS, cost);
    }

    // Delegated runners book `provider/model` rows. OpenCode's raw event log
    // also reports per-step cost; when its usage totals match the ledger row,
    // that row is priced. Runners without such a report remain token-only.
    for (const row of loop.ledger) {
      if (!row.model.includes("/")) continue;
      const tokens = row.input + row.output + row.cacheRead + row.cacheWrite;
      if (tokens === 0) continue;
      const run = { input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite };
      const task = taskFor(loop.loop, issueOf(row.session), row.at);
      const reportedCosts = externalByUsage.get(usageKey(row));
      const reportedCost = reportedCosts?.shift();
      if (reportedCost !== undefined) {
        const ageMs = nowMs - Date.parse(row.at);
        const inWeek = ageMs <= 168 * HOUR_MS;
        spend.total += reportedCost;
        if (ageMs <= 5 * HOUR_MS) spend.last5h += reportedCost;
        if (ageMs <= 24 * HOUR_MS) spend.last24h += reportedCost;
        if (inWeek) spend.last7d += reportedCost;
        loopView.costUsd += reportedCost;
        loopView.runs += 1;
        if (inWeek) loopView.last7d += reportedCost;
        task.costUsd += reportedCost;
        task.runs += 1;
        const stage = stageForExternal(row.label);
        task.stages.set(stage, (task.stages.get(stage) ?? 0) + reportedCost);
        addModel(task.models, row.model, run, reportedCost);
        addModel(loopModels, row.model, run, reportedCost);
        if (inWeek) addModel(weekModels, row.model, run, reportedCost);
        addDaily(row.at, row.model, run, reportedCost);
        continue;
      }
      task.unpricedTokens += tokens;
      addModel(task.models, row.model, run, null);
      addModel(loopModels, row.model, run, null);
      loopView.unpricedTokens += tokens;
      if (nowMs - Date.parse(row.at) <= 168 * HOUR_MS) addModel(weekModels, row.model, run, null);
      addDaily(row.at, row.model, run, null);
    }

    // Codex emits token deltas while a turn is running. Ledger checkpoints
    // contain those same tokens, so only add the part not booked there yet.
    // Delegated stages share the session/model but are independent usage.
    const tokenKey = (row: { run: string; session: string; model: string }) =>
      JSON.stringify([row.run, row.session, row.model]);
    const booked = new Map<string, ModelTally>();
    for (const row of loop.ledger) {
      if (row.model.startsWith("codex/") && !/^(delegated|mapper|review\.standards|review\.spec):/.test(row.label)) {
        addModel(booked, tokenKey(row), row, null);
      }
    }
    const streamed = new Map<string, { latest: CodexTokenRecord; totals: ModelTally }>();
    const seenTokens = new Set<string>();
    for (const row of loop.codexTokens ?? []) {
      const key = tokenKey(row);
      const identity = `${key}:${row.id}`;
      if (seenTokens.has(identity)) continue;
      seenTokens.add(identity);
      const current = streamed.get(key);
      const totals = current?.totals ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, priced: false };
      for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) totals[field] += row[field];
      streamed.set(key, { latest: current && current.latest.at > row.at ? current.latest : row, totals });
    }
    for (const [key, { latest, totals }] of streamed) {
      const recorded = booked.get(key);
      const extra = {
        input: Math.max(0, totals.input - (recorded?.input ?? 0)),
        output: Math.max(0, totals.output - (recorded?.output ?? 0)),
        cacheRead: Math.max(0, totals.cacheRead - (recorded?.cacheRead ?? 0)),
        cacheWrite: Math.max(0, totals.cacheWrite - (recorded?.cacheWrite ?? 0)),
      };
      const tokens = extra.input + extra.output + extra.cacheRead + extra.cacheWrite;
      if (tokens === 0) continue;
      const task = taskFor(loop.loop, issueOf(latest.session), latest.at);
      task.iterations.add(iterationKey(latest.run, latest.iteration));
      task.unpricedTokens += tokens;
      loopView.unpricedTokens += tokens;
      addModel(task.models, latest.model, extra, null);
      addModel(loopModels, latest.model, extra, null);
      if (nowMs - Date.parse(latest.at) <= 168 * HOUR_MS) addModel(weekModels, latest.model, extra, null);
      addDaily(latest.at, latest.model, extra, null);
    }

    // The newest iteration's orchestrator reports its cost only when it ends.
    const newest = loop.inits.reduce<InitRecord | null>((best, init) => (best === null || init.at > best.at ? init : best), null);
    if (newest !== null) {
      const key = iterationKey(newest.run, newest.iteration);
      if (!reportedIterations.has(key)) {
        const task = taskFor(loop.loop, issueOf(newest.session), newest.at);
        task.unreported = true;
        task.iterations.add(key);
      }
    }

    for (const rate of loop.rates) {
      if (latestRate === null || rate.at > latestRate.rate.at) latestRate = { rate, loop: loop.loop };
      if ((rate.fiveHour !== null || rate.sevenDay !== null) && (latestWindows === null || rate.at > latestWindows.at)) {
        latestWindows = rate;
      }
    }

    loopView.models = modelViews(loopModels);
    loops.push(loopView);
  }

  let plan: PlanUsageView | null = null;
  if (latestRate !== null) {
    const { rate, loop } = latestRate;
    const windows: RateRecord | null = latestWindows;
    plan = {
      at: rate.at,
      loop,
      status: rate.status,
      limitingWindow: rate.limitingWindow ?? windows?.limitingWindow ?? null,
      usingOverage: rate.usingOverage,
      windowsAt: windows?.at ?? null,
      fiveHour: windowView(windows?.fiveHour ?? null, nowMs),
      sevenDay: windowView(windows?.sevenDay ?? null, nowMs),
    };
  }

  const taskViews: TaskCostView[] = [...tasks.values()]
    .sort((left, right) => right.lastAt.localeCompare(left.lastAt))
    .map((task) => ({
      loop: task.loop,
      issue: task.issue,
      costUsd: task.costUsd,
      runs: task.runs,
      iterations: task.iterations.size,
      unpricedTokens: task.unpricedTokens,
      unreported: task.unreported,
      firstAt: task.firstAt,
      lastAt: task.lastAt,
      stages: [...task.stages.entries()]
        .map(([stage, costUsd]): StageSpendView => ({ stage, costUsd }))
        .sort((left, right) => right.costUsd - left.costUsd),
      models: modelViews(task.models),
    }));

  return {
    generatedAt: new Date(nowMs).toISOString(),
    plan,
    spend,
    loops,
    tasks: taskViews,
    models: modelViews(weekModels),
    daily: [...days.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, models]): DailySpendView => ({ date, models: modelViews(models) })),
    sources,
  };
}

/** Daily spend merged across projects: per day, each model's cost and tokens summed. */
export function mergeDaily(series: readonly (readonly DailySpendView[])[]): DailySpendView[] {
  const days = new Map<string, Map<string, ModelTally>>();
  for (const daily of series) {
    for (const day of daily) {
      let models = days.get(day.date);
      if (models === undefined) {
        models = new Map();
        days.set(day.date, models);
      }
      for (const model of day.models) addModel(models, model.model, model.tokens, model.costUsd);
    }
  }
  return [...days.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, models]) => ({ date, models: modelViews(models) }));
}

/**
 * The account's plan across projects. The limits are the account's, so the
 * rule is `summarizeUsage`'s across one project's loops, applied across
 * projects: the newest status any project's loop reported, with the newest
 * window figures any reported.
 */
export function accountPlan(
  readings: readonly { project: string; plan: PlanUsageView | null }[],
): (PlanUsageView & { project: string }) | null {
  let status: { project: string; plan: PlanUsageView } | null = null;
  let windows: PlanUsageView | null = null;
  for (const { project, plan } of readings) {
    if (plan === null) continue;
    if (status === null || plan.at > status.plan.at) status = { project, plan };
    if (plan.windowsAt !== null && (windows === null || plan.windowsAt > windows.windowsAt!)) windows = plan;
  }
  if (status === null) return null;
  return {
    ...status.plan,
    project: status.project,
    limitingWindow: status.plan.limitingWindow ?? windows?.limitingWindow ?? null,
    windowsAt: windows?.windowsAt ?? null,
    fiveHour: windows?.fiveHour ?? null,
    sevenDay: windows?.sevenDay ?? null,
  };
}

/** Trailing-window spend summed across projects: each project's cost is its own, so the sum is the account's. */
export function sumSpend(spends: readonly SpendWindows[]): SpendWindows {
  const total: SpendWindows = { last5h: 0, last24h: 0, last7d: 0, total: 0 };
  for (const spend of spends) {
    total.last5h += spend.last5h;
    total.last24h += spend.last24h;
    total.last7d += spend.last7d;
    total.total += spend.total;
  }
  return total;
}

/**
 * The `/api/usage` source: which worktrees belong to which loop, refreshed at
 * most every `ttlMs` (listing them walks every checkout), and their logs read
 * incrementally on every call.
 */
export function createUsageSource({
  targets,
  ttlMs = 30_000,
  now = () => Date.now(),
}: {
  targets: () => Promise<UsageTarget[]>;
  ttlMs?: number;
  now?: () => number;
}): (() => Promise<UsageReport>) & { close(): void } {
  let listed: { at: number; targets: UsageTarget[] } | null = null;
  let worker: Worker | null = null;
  let pending: { resolve(report: UsageReport): void; reject(error: Error): void } | null = null;
  let inFlight: Promise<UsageReport> | null = null;
  let closed = false;

  const discard = (active: Worker, error: Error) => {
    if (worker !== active) return;
    worker = null;
    const request = pending;
    pending = null;
    request?.reject(error);
    void active.terminate();
  };
  const getWorker = (): Worker => {
    if (worker !== null) return worker;
    const active = new Worker(new URL("./usage-worker.ts", import.meta.url));
    worker = active;
    active.on("message", (message: { report?: UsageReport; error?: string }) => {
      if (worker !== active || pending === null) return;
      if (message.error !== undefined) {
        discard(active, new Error(message.error));
        return;
      }
      if (message.report === undefined) {
        discard(active, new Error("usage worker returned no report"));
        return;
      }
      const request = pending;
      pending = null;
      active.unref();
      request.resolve(message.report);
    });
    active.on("error", (error) => discard(active, error));
    active.on("exit", (code) => discard(active, new Error(`usage worker exited (${code})`)));
    active.unref();
    return active;
  };

  const source = (): Promise<UsageReport> => {
    if (closed) return Promise.reject(new Error("usage source is closed"));
    if (inFlight !== null) return inFlight;
    inFlight = (async () => {
      const nowMs = now();
      if (listed === null || nowMs - listed.at > ttlMs) listed = { at: nowMs, targets: await targets() };
      if (closed) throw new Error("usage source is closed");
      const active = getWorker();
      return new Promise<UsageReport>((resolve, reject) => {
        pending = { resolve, reject };
        active.ref();
        try {
          active.postMessage({ targets: listed!.targets, nowMs });
        } catch (error) {
          discard(active, error instanceof Error ? error : new Error(String(error)));
        }
      });
    })().finally(() => { inFlight = null; });
    return inFlight;
  };
  source.close = () => {
    closed = true;
    if (worker !== null) discard(worker, new Error("usage source is closed"));
  };
  return source;
}
