#!/usr/bin/env bun
/**
 * `speed.ts` — how fast a loop works a ticket (felipearos/ralph#578).
 *
 * Every loop appends what it does to a ticket — claimed, each iteration's
 * start and end, handed off / merged, released, blocked — to an append-only
 * ledger, one JSONL file per loop under `<git-common-dir>/ralph/speed/`. The
 * report turns that into claim-to-hand-off time (wall clock from the first
 * claim to the PR being ready for a human) and active time (only the part an
 * iteration was actually running, minus the waits on CI, the queue or the
 * host lease the iteration itself reported). Only the supervisor's own waits
 * are reported — a PR wait, the host lease, an operator's hold at a phase
 * boundary. A wait the model runs inside its turn (a project's in-session
 * merge-queue wait) is still counted as active.
 *
 * Usage (from a project worktree):
 *   bun "$RALPH_HOME/speed.ts" record <kind> [--ticket <n>] [--pr <url>] [--outcome <s>] [--waited <seconds>]
 *   bun "$RALPH_HOME/speed.ts" report [--since <ISO date>] [--project <id>] [--loop <name>] [--json]
 *
 * `record` fills the loop, project, session, run and iteration from the
 * environment ralph.sh exports. A failed write is one line on stderr and exit
 * 0: an iteration must finish even with a read-only store.
 *
 * RALPH_SPEED_DIR, when set, is the ledger directory (tests and sandboxes).
 *
 * Exit codes: 0 · 1 no ledger to read (not inside a git repository) · 2 usage.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const SPEED_KINDS = [
  "claimed",
  "iteration-start",
  "iteration-end",
  "handed-off",
  "merged",
  "released",
  "blocked",
] as const;
export type SpeedKind = (typeof SPEED_KINDS)[number];

export interface SpeedEvent {
  v: 1;
  at: string;
  kind: SpeedKind;
  loop: string;
  project: string | null;
  ticket: string | null;
  session: string | null;
  run: string | null;
  iteration: number | null;
  /** iteration-end only. */
  outcome?: string | null;
  /** iteration-end only: model-free waiting inside the iteration (CI, queue, host lease). */
  waitedSeconds?: number;
  /** handed-off / merged only. */
  pr?: string | null;
}

type Env = Record<string, string | undefined>;

export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

/** The ledger directory: RALPH_SPEED_DIR, else the git common dir so every worktree of a project shares it. Throws outside a git repository. */
export function speedDir(env: Env = process.env, cwd = process.cwd()): string {
  if (env.RALPH_SPEED_DIR) return resolve(cwd, env.RALPH_SPEED_DIR);
  const out = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  });
  const common = out.status === 0 ? out.stdout.trim() : "";
  // No fallback inside the checkout: an untracked directory there could be
  // committed into a PR, or read as a dirty worktree. The caller reports it.
  if (!common) throw new Error(`${resolve(cwd)} is not inside a git repository`);
  return join(common, "ralph", "speed");
}

export function speedPath(loop: string, env: Env = process.env, cwd = process.cwd()): string {
  return join(speedDir(env, cwd), `${loop}.jsonl`);
}

/** Append one event. Never throws: the error message, or null when the line was written. */
export function appendSpeedEvent(dir: string, event: SpeedEvent): string | null {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${event.loop}.jsonl`), `${JSON.stringify(event)}\n`, "utf8");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export interface SpeedLedger {
  events: SpeedEvent[];
  /** Lines that were not an event: a half-written last line, or garbage. */
  skippedLines: number;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** One parsed line, or null when it is not a v1 speed event. */
export function parseSpeedLine(line: string): SpeedEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || typeof r.at !== "string" || Number.isNaN(Date.parse(r.at))) return null;
  if (typeof r.kind !== "string" || !(SPEED_KINDS as readonly string[]).includes(r.kind)) return null;
  if (typeof r.loop !== "string" || r.loop === "") return null;
  const event: SpeedEvent = {
    v: 1,
    at: r.at,
    kind: r.kind as SpeedKind,
    loop: r.loop,
    project: stringOrNull(r.project),
    ticket: typeof r.ticket === "number" ? String(r.ticket) : stringOrNull(r.ticket),
    session: stringOrNull(r.session),
    run: stringOrNull(r.run),
    iteration: typeof r.iteration === "number" && Number.isInteger(r.iteration) ? r.iteration : null,
  };
  if (event.kind === "iteration-end") {
    event.outcome = stringOrNull(r.outcome);
    event.waitedSeconds =
      typeof r.waitedSeconds === "number" && Number.isFinite(r.waitedSeconds) && r.waitedSeconds > 0 ? r.waitedSeconds : 0;
  }
  if (event.kind === "handed-off" || event.kind === "merged") event.pr = stringOrNull(r.pr);
  return event;
}

function readFileEvents(path: string, into: SpeedLedger): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const event = parseSpeedLine(line);
    if (event) into.events.push(event);
    else into.skippedLines += 1;
  }
}

/** Every `*.jsonl` in the directory, in time order. A missing directory is a ledger with nothing in it yet. */
export function readSpeedLedger(dir: string): SpeedLedger {
  const ledger: SpeedLedger = { events: [], skippedLines: 0 };
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return ledger;
  }
  for (const name of names) readFileEvents(join(dir, name), ledger);
  ledger.events = byTime(ledger.events);
  return ledger;
}

/** Stable sort by `at`, so lines written in the same millisecond keep their file order. */
function byTime(events: readonly SpeedEvent[]): SpeedEvent[] {
  return events
    .map((event, index) => ({ event, index, t: Date.parse(event.at) }))
    .sort((a, b) => a.t - b.t || a.index - b.index)
    .map(({ event }) => event);
}

const CLOSES_CLAIM: ReadonlySet<SpeedKind> = new Set(["handed-off", "merged", "released", "blocked"]);

/**
 * The ticket an iteration event belongs to when the caller did not say: the
 * ticket this loop's run+iteration already named (latest wins), else the loop's
 * open claim, else null. ralph.sh records iteration-start before it knows the
 * ticket and iteration-end without parsing it, so the ledger is the source.
 */
export function resolveIterationTicket(
  events: readonly SpeedEvent[],
  loop: string,
  run: string | null,
  iteration: number | null,
): string | null {
  const mine = byTime(events.filter((event) => event.loop === loop));
  if (run !== null && iteration !== null) {
    let found: string | null = null;
    for (const event of mine) {
      if (event.ticket !== null && event.run === run && event.iteration === iteration) found = event.ticket;
    }
    if (found !== null) return found;
  }
  // Insertion order of a Map is claim order once a re-claim deletes and re-adds.
  const open = new Map<string, true>();
  for (const event of mine) {
    if (event.ticket === null) continue;
    if (event.kind === "claimed") {
      open.delete(event.ticket);
      open.set(event.ticket, true);
    } else if (CLOSES_CLAIM.has(event.kind)) {
      open.delete(event.ticket);
    }
  }
  return [...open.keys()].at(-1) ?? null;
}

export interface RecordFields {
  ticket?: string | null;
  pr?: string | null;
  outcome?: string | null;
  waitedSeconds?: number;
}

export interface RecordDeps {
  env?: Env;
  cwd?: string;
  now?: () => Date;
  err?: (line: string) => void;
}

function envOrNull(env: Env, name: string): string | null {
  const value = env[name];
  return value !== undefined && value !== "" ? value : null;
}

/**
 * Record one event for the current loop. Never throws and never fails the
 * caller: a lost line is one stderr message, because an iteration must finish
 * even when the store is read-only. Returns the error message, or null.
 */
export function recordSpeedEvent(kind: SpeedKind, fields: RecordFields = {}, deps: RecordDeps = {}): string | null {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const err = deps.err ?? ((line: string) => console.error(line));
  try {
    const loop = envOrNull(env, "RALPH_LOOP_NAME") ?? "ralph";
    const run = envOrNull(env, "RALPH_RUN_ID");
    const iterationRaw = envOrNull(env, "RALPH_ITERATION");
    const iteration = iterationRaw !== null && /^\d+$/.test(iterationRaw) ? Number(iterationRaw) : null;
    const dir = speedDir(env, cwd);
    let ticket = stringOrNull(fields.ticket);
    if (ticket === null && (kind === "iteration-start" || kind === "iteration-end")) {
      const ledger: SpeedLedger = { events: [], skippedLines: 0 };
      readFileEvents(join(dir, `${loop}.jsonl`), ledger);
      ticket = resolveIterationTicket(ledger.events, loop, run, iteration);
    }
    const event: SpeedEvent = {
      v: 1,
      at: (deps.now ?? (() => new Date()))().toISOString(),
      kind,
      loop,
      project: envOrNull(env, "RALPH_PROJECT_ID"),
      ticket,
      session: envOrNull(env, "RALPH_SESSION_ID"),
      run,
      iteration,
    };
    if (kind === "iteration-end") {
      event.outcome = stringOrNull(fields.outcome);
      const waited = fields.waitedSeconds;
      event.waitedSeconds = typeof waited === "number" && Number.isFinite(waited) && waited > 0 ? waited : 0;
    }
    if (kind === "handed-off" || kind === "merged") event.pr = stringOrNull(fields.pr);
    const problem = appendSpeedEvent(dir, event);
    if (problem !== null) err(`speed: could not record ${kind}: ${problem}`);
    return problem;
  } catch (error) {
    const problem = error instanceof Error ? error.message : String(error);
    err(`speed: could not record ${kind}: ${problem}`);
    return problem;
  }
}

export interface SpeedMeasurement {
  project: string | null;
  loop: string;
  ticket: string;
  claimedAt: string;
  endedAt: string;
  endKind: "handed-off" | "merged";
  pr: string | null;
  claimToHandoffSeconds: number;
  activeSeconds: number;
  iterations: number;
}

export interface SpeedInFlight {
  project: string | null;
  loop: string;
  ticket: string;
  claimedAt: string;
}

export interface SpeedMeasurements {
  measured: SpeedMeasurement[];
  inFlight: SpeedInFlight[];
}

interface IterationSpan {
  project: string | null;
  loop: string;
  ticket: string;
  start: number;
  end: number;
  waitedSeconds: number;
}

const groupKey = (project: string | null, loop: string, ticket: string): string =>
  JSON.stringify([project, loop, ticket]);

function iterationSpans(events: readonly SpeedEvent[]): IterationSpan[] {
  const starts = new Map<string, SpeedEvent>();
  const spans: IterationSpan[] = [];
  for (const event of events) {
    const key = JSON.stringify([event.loop, event.run, event.iteration]);
    if (event.kind === "iteration-start") {
      starts.set(key, event);
    } else if (event.kind === "iteration-end") {
      const start = starts.get(key);
      if (!start) continue;
      starts.delete(key);
      const ticket = event.ticket ?? start.ticket;
      if (ticket === null) continue;
      spans.push({
        project: event.project ?? start.project,
        loop: event.loop,
        ticket,
        start: Date.parse(start.at),
        end: Date.parse(event.at),
        waitedSeconds: event.waitedSeconds ?? 0,
      });
    }
  }
  return spans;
}

/**
 * One measurement per (project, loop, ticket) episode: from the first claim to
 * the first hand-off or merge after it, however many iterations it took.
 * Active time counts only the part of each iteration inside the episode, less
 * the waits it reported, so time between iterations (RETRY_LATER, usage
 * limits) is never active.
 */
export function measureSpeed(events: readonly SpeedEvent[]): SpeedMeasurements {
  const ordered = byTime(events);
  const spans = new Map<string, IterationSpan[]>();
  for (const span of iterationSpans(ordered)) {
    const key = groupKey(span.project, span.loop, span.ticket);
    spans.set(key, [...(spans.get(key) ?? []), span]);
  }
  const open = new Map<string, SpeedEvent>();
  // Released or blocked keeps the episode's first claim (a re-claim carries
  // on from it) but takes the ticket out of flight until that re-claim.
  const parked = new Set<string>();
  const measured: SpeedMeasurement[] = [];
  for (const event of ordered) {
    if (event.ticket === null) continue;
    const key = groupKey(event.project, event.loop, event.ticket);
    if (event.kind === "claimed") {
      if (!open.has(key)) open.set(key, event);
      parked.delete(key);
    } else if (event.kind === "released" || event.kind === "blocked") {
      if (open.has(key)) parked.add(key);
    } else if (event.kind === "handed-off" || event.kind === "merged") {
      const claim = open.get(key);
      if (!claim) continue;
      open.delete(key);
      parked.delete(key);
      const from = Date.parse(claim.at);
      const to = Date.parse(event.at);
      let active = 0;
      let iterations = 0;
      for (const span of spans.get(key) ?? []) {
        if (span.end < from || span.start > to) continue;
        iterations += 1;
        const overlap = Math.max(0, Math.min(span.end, to) - Math.max(span.start, from)) / 1000;
        active += Math.max(0, overlap - Math.min(span.waitedSeconds, overlap));
      }
      measured.push({
        project: event.project,
        loop: event.loop,
        ticket: event.ticket,
        claimedAt: claim.at,
        endedAt: event.at,
        endKind: event.kind,
        pr: event.pr ?? null,
        claimToHandoffSeconds: (to - from) / 1000,
        activeSeconds: active,
        iterations,
      });
    }
  }
  const inFlight = [...open.entries()].filter(([key]) => !parked.has(key)).map(([, claim]) => ({
    project: claim.project,
    loop: claim.loop,
    ticket: claim.ticket as string,
    claimedAt: claim.at,
  }));
  return { measured, inFlight };
}

/** Mean of the two middle values for an even count; null when empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2;
}

/** Nearest rank: the value at index ceil(0.9·n)−1 of the ascending list; null when empty. */
export function p90(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.9 * sorted.length) - 1] ?? null;
}

export interface SpeedReportOptions {
  since?: Date;
  project?: string;
  loop?: string;
  slowest?: number;
}

export interface SpeedReportGroup {
  project: string | null;
  loop: string;
  handedOff: number;
  inFlight: number;
  medianClaimToHandoffSeconds: number | null;
  p90ClaimToHandoffSeconds: number | null;
  medianActiveSeconds: number | null;
  slowest: SpeedMeasurement[];
}

export function speedReport(events: readonly SpeedEvent[], options: SpeedReportOptions = {}): SpeedReportGroup[] {
  const slowestN = options.slowest ?? 5;
  const { measured, inFlight } = measureSpeed(events);
  const wanted = (row: { project: string | null; loop: string }) =>
    (options.project === undefined || row.project === options.project) &&
    (options.loop === undefined || row.loop === options.loop);
  const since = options.since?.getTime();
  const groups = new Map<string, { project: string | null; loop: string; rows: SpeedMeasurement[]; inFlight: number }>();
  const group = (project: string | null, loop: string) => {
    const key = JSON.stringify([project, loop]);
    let found = groups.get(key);
    if (!found) {
      found = { project, loop, rows: [], inFlight: 0 };
      groups.set(key, found);
    }
    return found;
  };
  for (const row of measured) {
    if (!wanted(row)) continue;
    if (since !== undefined && Date.parse(row.endedAt) < since) continue;
    group(row.project, row.loop).rows.push(row);
  }
  for (const row of inFlight) {
    if (wanted(row)) group(row.project, row.loop).inFlight += 1;
  }
  return [...groups.values()]
    .sort((a, b) => (a.project ?? "").localeCompare(b.project ?? "") || a.loop.localeCompare(b.loop))
    .map(({ project, loop, rows, inFlight: inFlightCount }) => {
      const totals = rows.map((row) => row.claimToHandoffSeconds);
      return {
        project,
        loop,
        handedOff: rows.length,
        inFlight: inFlightCount,
        medianClaimToHandoffSeconds: median(totals),
        p90ClaimToHandoffSeconds: p90(totals),
        medianActiveSeconds: median(rows.map((row) => row.activeSeconds)),
        slowest: [...rows].sort((a, b) => b.claimToHandoffSeconds - a.claimToHandoffSeconds).slice(0, slowestN),
      };
    });
}

/** `45s`, `12m 05s`, `1h 05m`, `2d 03h`; `—` for no value. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const s = Math.round(seconds);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
  return `${Math.floor(s / 86_400)}d ${pad(Math.floor((s % 86_400) / 3600))}h`;
}

export function formatReport(groups: readonly SpeedReportGroup[], skippedLines: number): string {
  if (groups.length === 0) return skippedLines > 0 ? `no tickets recorded (${skippedLines} unreadable lines)` : "no tickets recorded";
  const header = ["project", "loop", "handed off", "in flight", "median", "p90", "median active"];
  const rows = groups.map((g) => [
    g.project ?? "—",
    g.loop,
    String(g.handedOff),
    String(g.inFlight),
    formatDuration(g.medianClaimToHandoffSeconds),
    formatDuration(g.p90ClaimToHandoffSeconds),
    formatDuration(g.medianActiveSeconds),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  const out = [line(header), ...rows.map(line)];
  for (const g of groups) {
    if (g.slowest.length === 0) continue;
    out.push("", `slowest — ${g.project ?? "—"} / ${g.loop}:`);
    for (const m of g.slowest) {
      const pr = m.pr ? `  ${m.pr}` : "";
      out.push(
        `  #${m.ticket}  ${formatDuration(m.claimToHandoffSeconds)} (active ${formatDuration(m.activeSeconds)}, ${m.iterations} iterations)${pr}`,
      );
    }
  }
  if (skippedLines > 0) out.push("", `${skippedLines} unreadable lines skipped`);
  return out.join("\n");
}

const USAGE = [
  "usage: bun speed.ts record <kind> [--ticket <n>] [--pr <url>] [--outcome <s>] [--waited <seconds>]",
  "       bun speed.ts report [--since <ISO date>] [--project <id>] [--loop <name>] [--json]",
  `kinds: ${SPEED_KINDS.join(", ")}`,
].join("\n");

export interface MainDeps {
  env?: Env;
  cwd?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  now?: () => Date;
}

/** Flags that take a value, then the boolean ones; anything else is a usage error. */
function parseArgs(
  argv: readonly string[],
  valued: readonly string[],
  booleans: readonly string[],
): { values: Record<string, string>; flags: Set<string> } | { problem: string } {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (valued.includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined) return { problem: `${arg} needs a value` };
      values[arg] = value;
      i += 1;
    } else if (booleans.includes(arg)) {
      flags.add(arg);
    } else {
      return { problem: `unknown argument ${arg}` };
    }
  }
  return { values, flags };
}

export function main(argv: readonly string[], deps: MainDeps = {}): number {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const usage = (problem: string) => {
    err(`speed: ${problem}\n${USAGE}`);
    return EXIT.usage;
  };
  const [command, ...rest] = argv;
  if (command === "record") {
    const [kind, ...flagArgs] = rest;
    if (kind === undefined || !(SPEED_KINDS as readonly string[]).includes(kind)) {
      return usage(kind === undefined ? "record needs a kind" : `unknown kind ${kind}`);
    }
    const parsed = parseArgs(flagArgs, ["--ticket", "--pr", "--outcome", "--waited"], []);
    if ("problem" in parsed) return usage(parsed.problem);
    let waitedSeconds: number | undefined;
    if (parsed.values["--waited"] !== undefined) {
      waitedSeconds = Number(parsed.values["--waited"]);
      if (!Number.isFinite(waitedSeconds) || waitedSeconds < 0) return usage(`--waited must be seconds >= 0`);
    }
    // A write failure is reported by recordSpeedEvent and swallowed here on purpose.
    recordSpeedEvent(
      kind as SpeedKind,
      {
        ticket: parsed.values["--ticket"],
        pr: parsed.values["--pr"],
        outcome: parsed.values["--outcome"],
        waitedSeconds,
      },
      { env, cwd, now: deps.now, err },
    );
    return EXIT.ok;
  }
  if (command === "report") {
    const parsed = parseArgs(rest, ["--since", "--project", "--loop"], ["--json"]);
    if ("problem" in parsed) return usage(parsed.problem);
    let since: Date | undefined;
    if (parsed.values["--since"] !== undefined) {
      since = new Date(parsed.values["--since"]);
      if (Number.isNaN(since.getTime())) return usage(`--since ${parsed.values["--since"]} is not a date`);
    }
    let dir: string;
    try {
      dir = speedDir(env, cwd);
    } catch (error) {
      err(`speed: ${error instanceof Error ? error.message : String(error)}`);
      return EXIT.failed;
    }
    const ledger = readSpeedLedger(dir);
    const groups = speedReport(ledger.events, {
      since,
      project: parsed.values["--project"],
      loop: parsed.values["--loop"],
    });
    if (parsed.flags.has("--json")) {
      out(JSON.stringify({ v: 1, since: since?.toISOString() ?? null, groups, skippedLines: ledger.skippedLines }));
    } else {
      out(formatReport(groups, ledger.skippedLines));
    }
    return EXIT.ok;
  }
  return usage(command === undefined ? "missing command" : `unknown command ${command}`);
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
