#!/usr/bin/env bun
/**
 * The plan usage stop: a loop that stops spending the account's plan at a
 * share of it the operator chose, instead of at the account's own limit.
 *
 * The limit itself (#407, `usage-limit.ts`) rejects a turn only at 100%, and
 * by then every loop on the account has spent the week the operator wanted to
 * keep for their own interactive use. A `usageStop` puts the line earlier:
 *
 *   below `percent`        run as usual;
 *   at `percent`           drain — claim nothing new, finish the ticket held;
 *   at `hardPercent`       park — no iteration at all — until the window resets.
 *
 * Effective rule, first that says anything (a loop entry's `null` exempts it):
 *
 *   override for the loop   host-local, `<git-common-dir>/ralph-usage-stop.json`
 *   override for "*"        the same file, the project-wide key
 *   config, the loop entry  `loops[i].usageStop` in `.ralph/config.json`
 *   config, the project     top-level `usageStop`
 *
 * The override is the dashboard's and the operator's knob: it applies at the
 * loop's next checkpoint, never touches the project's repository, and is read
 * fresh every time — the committed config is only read once at startup by
 * `ralph.sh`, so it could not wake a parked loop. A `waive` in the override
 * runs the loop past its stop until the window it watches resets.
 *
 * The reading is the loop's own: the newest `rate_limit_event` in its
 * `.ralph/logs/iter-*.events.jsonl` that reports the watched window. Events
 * name no account, and loops on one host do run on different ones, so another
 * loop's reading could be a stranger's plan. A loop learns its number only by
 * spending, so it may pass the line by one iteration; it never aborts a turn.
 *
 * Every doubt runs: no rule, no reading, a reading whose window already reset,
 * an unreadable override or config. A missing signal falls back to today's
 * behaviour, never to a stuck loop.
 *
 * Usage:
 *   usage-stop.ts check --loop <name>
 *       one line, tab-separated: <run|drain|park> <seconds> <key> <detail>.
 *       seconds: until the watched window resets (0 for run); key: the window
 *       and its reset, which dedupes a park's notification, or `-` when there
 *       is none (a tab is whitespace to bash's `read`, so an empty field
 *       between two would vanish). Always exit 0.
 *   usage-stop.ts show --loop <name>
 *       the rule, its source, the reading and the verdict, as JSON, read from
 *       the worktree it runs in.
 *   usage-stop.ts show [--json]
 *       every loop of the roster, in roster order, each read from its own
 *       worktree (the one whose `.ralph/loop-name` names it): one tab-separated
 *       line each (loop, rule, source, waiver, verdict, detail), then one
 *       `unnamed worktree <path>: <n> events, not credited` line for each
 *       worktree that has run but names no roster loop. With --json, an
 *       object: `loops`, an array of what `show --loop` prints for each plus
 *       `stale`, and `unnamed`, an array of `{ path, events }`.
 *       The detail carries the reading's age (`read 5m ago`); a reading older
 *       than an hour is stale, and a `run` it would decide in a live window
 *       reads `unknown (stale reading)` with the detail
 *       `<window> <percent>% <age>` (an idle loop's old number is not
 *       today's). A park or drain on an old reading stands: usage only rises
 *       inside a window.
 *   usage-stop.ts set --loop <name|*> --percent <n> [--window <w>] [--hard <n>]
 *   usage-stop.ts set --loop <name|*> --off
 *       write the override (`--off`: no stop for it, whatever the config says).
 *   usage-stop.ts clear --loop <name|*>
 *       drop the override; the committed config applies again.
 *   usage-stop.ts waive --loop <name> [--until <iso>]
 *       run past the stop until the watched window resets (or <iso>).
 *
 * RALPH_USAGE_NOW_MS overrides the clock and RALPH_USAGE_STOP_FILE the
 * override's path (tests only).
 */
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DEFAULT_MARGIN_SECONDS, knob } from "./usage-limit";
import { parseWorktreeRegistry } from "./loop-state";
import { LOGS_RELATIVE_DIR, LOOP_NAME_RELATIVE_PATH, projectRoot } from "./paths";
import {
  loadProjectConfig,
  USAGE_STOP_DEFAULT_HARD_PERCENT,
  USAGE_STOP_DEFAULT_WINDOW,
  usageStopProblems,
  type ProjectConfig,
  type UsageStopRule,
  type UsageStopWindow,
} from "./project-config";

export const OVERRIDE_FILE = "ralph-usage-stop.json";
/** The override's project-wide key. */
export const PROJECT_KEY = "*";
/** How many of the newest events files a reading is looked for in. */
const READING_FILES = 12;
const EVENTS_FILE = /^iter-.*\.events\.jsonl$/;

export interface ResolvedRule {
  percent: number;
  hardPercent: number;
  window: UsageStopWindow;
}

export type RuleSource = "override" | "override-project" | "config-loop" | "config" | "none";

export interface OverrideEntry {
  /** The rule, or null for "no stop"; absent when the entry only waives. */
  rule?: UsageStopRule | null;
  /** ISO time the stop is waived until. */
  waiveUntil?: string;
  at: string;
}

export interface Override {
  entries: Record<string, OverrideEntry>;
}

export interface Reading {
  /** 0..1, as the plan reports it. */
  utilization: number;
  resetsAtMs: number;
  at: string | null;
}

export type Verdict = "run" | "drain" | "park";

export interface Decision {
  verdict: Verdict;
  /** Seconds until the watched window resets, margin included; 0 for run. */
  seconds: number;
  /** `<window>:<resetsAt seconds>`, empty for run. */
  key: string;
  detail: string;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** A rule with its defaults filled in. */
export function resolveRule(rule: UsageStopRule): ResolvedRule {
  return {
    percent: rule.percent,
    window: rule.window ?? USAGE_STOP_DEFAULT_WINDOW,
    hardPercent: rule.hardPercent ?? Math.max(USAGE_STOP_DEFAULT_HARD_PERCENT, rule.percent),
  };
}

/** The rule that applies to `loop`, and where it came from. */
export function effectiveRule(
  loop: string,
  config: Pick<ProjectConfig, "usageStop" | "roster"> | null,
  override: Override | null,
): { rule: ResolvedRule | null; source: RuleSource } {
  const pick = (entry: OverrideEntry | undefined) => (entry !== undefined && entry.rule !== undefined ? entry.rule : undefined);
  const layers: Array<[RuleSource, UsageStopRule | null | undefined]> = [
    ["override", pick(override?.entries[loop])],
    ["override-project", pick(override?.entries[PROJECT_KEY])],
    ["config-loop", config?.roster.find((entry) => entry.name === loop)?.usageStop],
    ["config", config?.usageStop],
  ];
  for (const [source, rule] of layers) {
    if (rule === undefined) continue;
    return { rule: rule === null ? null : resolveRule(rule), source };
  }
  return { rule: null, source: "none" };
}

/** The override file's content, or null with the reason when it is unusable. */
export function parseOverride(text: string): { override: Override | null; problem: string | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { override: null, problem: `not JSON: ${(error as Error).message}` };
  }
  if (!isObject(raw) || !isObject(raw.entries)) return { override: null, problem: "must be an object with 'entries'" };
  const entries: Record<string, OverrideEntry> = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(raw.entries)) {
    if (!isObject(value)) {
      problems.push(`'${key}' is not an object`);
      continue;
    }
    const entry: OverrideEntry = { at: typeof value.at === "string" ? value.at : "" };
    if ("rule" in value) {
      const ruleProblems = usageStopProblems(value.rule, `entries.${key}.rule`, true);
      if (ruleProblems.length > 0) problems.push(...ruleProblems);
      else entry.rule = value.rule as UsageStopRule | null;
    }
    if (typeof value.waiveUntil === "string" && Number.isFinite(Date.parse(value.waiveUntil))) entry.waiveUntil = value.waiveUntil;
    entries[key] = entry;
  }
  // A bad entry is dropped, never the whole file: one typo must not undo
  // every other loop's override.
  return { override: { entries }, problem: problems.length > 0 ? problems.join("; ") : null };
}

/**
 * The newest reading of `window` in an events stream's lines, or null. A
 * reading without a reset time is not one: it could not be told stale.
 */
export function readingIn(lines: readonly string[], window: UsageStopWindow): Reading | null {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    // Cheap test first: the stream is mostly tool traffic.
    if (!line.includes('"rate_limit_event"') || !line.includes(window)) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(event) || event.type !== "rate_limit_event" || !isObject(event.rate_limit_info)) continue;
    const info = event.rate_limit_info;
    const windows = isObject(info.unifiedWindows) ? info.unifiedWindows : {};
    let raw: Json | null = isObject(windows[window]) ? (windows[window] as Json) : null;
    // An older event shape reports the binding window at the top level only.
    if (raw === null && info.rateLimitType === window) raw = info;
    if (raw === null) continue;
    const utilization = raw.utilization;
    const resetsAt = raw.resetsAt;
    if (typeof utilization !== "number" || !Number.isFinite(utilization)) continue;
    if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) continue;
    return {
      utilization,
      resetsAtMs: resetsAt * 1000,
      at: typeof event.ralph_received_at === "string" ? event.ralph_received_at : null,
    };
  }
  return null;
}

/** The newest reading of `window` in a loop's logs directory, or null. */
export function latestReading(logsDir: string, window: UsageStopWindow): Reading | null {
  let files: Array<{ path: string; mtime: number }>;
  try {
    files = readdirSync(logsDir)
      .filter((name) => EVENTS_FILE.test(name))
      .map((name) => {
        const path = join(logsDir, name);
        return { path, mtime: statSync(path).mtimeMs };
      });
  } catch {
    return null;
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const { path } of files.slice(0, READING_FILES)) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const reading = readingIn(text.split("\n"), window);
    if (reading !== null) return reading;
  }
  return null;
}

const percentOf = (utilization: number): number => Math.round(utilization * 1000) / 10;

/**
 * How old a reading may be before the roster view calls it stale. `check` has
 * no freshness rule of its own (a loop refreshes its reading by spending), so
 * an hour is the fallback: an idle loop's days-old number must not read as
 * today's verdict.
 */
export const STALE_READING_MS = 3600_000;

/**
 * A reading's age in ms at `nowMs`, or null when no age is known (no reading,
 * no `at`, an `at` that does not parse). A future `at` (clock skew) is age 0.
 */
export function readingAgeMs(reading: Reading | null, nowMs: number): number | null {
  if (reading === null || reading.at === null) return null;
  const at = Date.parse(reading.at);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, nowMs - at);
}

/** An age in its largest whole unit: `30s ago`, `5m ago`, `2h ago`, `3d ago`. */
export function ageText(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** A reset as the operator reads it on the host: `Tue 17 11:02`. */
export function whenText(ms: number): string {
  const date = new Date(ms);
  const day = date.toLocaleDateString("en-US", { weekday: "short" });
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${day} ${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** What the loop should do now. Pure: the clock and the margin are arguments. */
export function decide(
  rule: ResolvedRule | null,
  reading: Reading | null,
  nowMs: number,
  marginSeconds: number,
  waiveUntilMs: number | null = null,
): Decision {
  const run = (detail: string): Decision => ({ verdict: "run", seconds: 0, key: "", detail });
  if (rule === null) return run("no usage stop");
  const line = `${rule.window} stop at ${rule.percent}%, park at ${rule.hardPercent}%`;
  if (waiveUntilMs !== null && waiveUntilMs > nowMs) return run(`${line}; waived until ${whenText(waiveUntilMs)}`);
  if (reading === null) return run(`${line}; no ${rule.window} reading yet`);
  // A window that has reset is a number about a week that is over.
  if (reading.resetsAtMs <= nowMs) return run(`${line}; the last ${rule.window} reading is from a window that has reset`);
  const used = percentOf(reading.utilization);
  const untilMs = reading.resetsAtMs + marginSeconds * 1000;
  const seconds = Math.max(1, Math.ceil((untilMs - nowMs) / 1000));
  const key = `${rule.window}:${Math.round(reading.resetsAtMs / 1000)}`;
  const resets = whenText(untilMs);
  if (used >= rule.hardPercent) {
    return { verdict: "park", seconds, key, detail: `${rule.window} ${used}% ≥ ${rule.hardPercent}% — parked until ${resets}` };
  }
  if (used >= rule.percent) {
    return {
      verdict: "drain",
      seconds,
      key,
      detail: `${rule.window} ${used}% ≥ ${rule.percent}% — no new work until ${resets}; parks at ${rule.hardPercent}%`,
    };
  }
  return run(`${rule.window} ${used}% < ${rule.percent}%`);
}

/* ------------------------------------------------------------------ I/O */

function nowMs(): number {
  const raw = process.env.RALPH_USAGE_NOW_MS;
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) && raw?.trim() ? value : Date.now();
}

/** Where the override lives: git's common directory, beside the leases. */
export function overridePath(root: string): string {
  const pinned = process.env.RALPH_USAGE_STOP_FILE?.trim();
  if (pinned) return pinned;
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    if (common) return join(common, OVERRIDE_FILE);
  } catch {
    // Not a git checkout: the worktree's own state directory.
  }
  return join(root, ".ralph", OVERRIDE_FILE);
}

function readOverride(path: string): Override | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const { override, problem } = parseOverride(text);
  if (problem !== null) console.error(`usage-stop: ignoring part of ${path}: ${problem}`);
  return override;
}

function writeOverride(path: string, override: Override): void {
  mkdirSync(dirname(path), { recursive: true });
  // tmp+rename so a loop reading at its checkpoint never sees half a file.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(override, null, 2)}\n`);
  renameSync(tmp, path);
}

function readConfig(root: string): ProjectConfig | null {
  try {
    return loadProjectConfig(root);
  } catch (error) {
    console.error(`usage-stop: the committed config is unreadable, so only the override applies: ${(error as Error).message}`);
    return null;
  }
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

interface Assessment {
  loop: string;
  rule: ResolvedRule | null;
  source: RuleSource;
  waiveUntil: string | null;
  reading: Reading | null;
  decision: Decision;
}

function assess(root: string, loop: string): Assessment {
  return assessWith(root, loop, readConfig(root), readOverride(overridePath(root)));
}

/**
 * `assess` with the config and override already read, so a roster pass reads
 * each once. `now` is the caller's clock reading, so a roster judges a line's
 * verdict and its reading's age at the same instant.
 */
function assessWith(
  root: string | null,
  loop: string,
  config: ProjectConfig | null,
  override: Override | null,
  now: number = nowMs(),
): Assessment {
  const { rule, source } = effectiveRule(loop, config, override);
  const waiveUntil = override?.entries[loop]?.waiveUntil ?? null;
  // No worktree is no reading: the loop's events live in its own worktree only.
  const reading = rule === null || root === null ? null : latestReading(join(root, LOGS_RELATIVE_DIR), rule.window);
  const margin = knob(process.env.RALPH_USAGE_RESET_MARGIN_SECONDS, DEFAULT_MARGIN_SECONDS);
  const decision = decide(rule, reading, now, margin, waiveUntil === null ? null : Date.parse(waiveUntil));
  if (root === null && rule !== null) decision.detail += "; no worktree of this clone runs this loop";
  return { loop, rule, source, waiveUntil, reading, decision };
}

const oneLine = (text: string): string => text.replace(/[\t\r\n]+/g, " ");

function check(root: string, loop: string): number {
  let decision: Decision;
  try {
    decision = assess(root, loop).decision;
  } catch (error) {
    decision = { verdict: "run", seconds: 0, key: "", detail: `usage stop unreadable: ${(error as Error).message}` };
  }
  console.log([decision.verdict, String(decision.seconds), decision.key || "-", oneLine(decision.detail)].join("\t"));
  return 0;
}

/** When a worktree's loop last wrote an events file, or null if it never has. */
function lastEventsMs(worktree: string): number | null {
  const logsDir = join(worktree, LOGS_RELATIVE_DIR);
  let newest: number | null = null;
  try {
    for (const name of readdirSync(logsDir)) {
      if (!EVENTS_FILE.test(name)) continue;
      const mtime = statSync(join(logsDir, name)).mtimeMs;
      if (newest === null || mtime > newest) newest = mtime;
    }
  } catch {
    // No logs directory: this worktree never ran a loop.
  }
  return newest;
}

/**
 * Each loop's worktree, by the name in its `.ralph/loop-name`. A loop's reading
 * is its own account's (see the header), so the roster view must read every
 * loop from its own worktree rather than every loop from the caller's.
 *
 * A worktree is credited to a loop only when its name file is readable and
 * names a roster loop. One that has run without such a name (no file, an
 * empty or unreadable one, a name not in the roster) is listed as unnamed
 * instead: guessing it is the first loop would credit another loop's spend to
 * that loop and hide the real loop's worktree. A worktree that never ran is
 * not a loop and is left out. Where several worktrees answer for one loop (a
 * loop recreated beside its old worktree), the one that wrote events last is
 * the live one.
 */
function loopWorktrees(root: string, rosterNames: string[]): { byLoop: Map<string, string>; unnamed: string[] } {
  let paths = [root];
  try {
    const porcelain = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    const listed = parseWorktreeRegistry(porcelain).map((entry) => entry.path);
    if (listed.length > 0) paths = listed;
  } catch {
    // Not a git checkout, or git unreadable: the caller's worktree is all we know.
  }
  const named = new Map<string, Array<{ path: string; at: number }>>();
  const unnamed: string[] = [];
  for (const path of paths) {
    const at = lastEventsMs(path);
    let name = "";
    try {
      // Every whitespace character goes, as ralph.sh's `tr -d '[:space:]'` drops
      // it, so a name ralph.sh runs under is the name credited here.
      name = readFileSync(join(path, LOOP_NAME_RELATIVE_PATH), "utf8").replace(/\s+/g, "");
    } catch {
      // No name file, or an unreadable one: it names no loop.
    }
    if (!rosterNames.includes(name)) {
      if (at !== null) unnamed.push(path);
      continue;
    }
    named.set(name, [...(named.get(name) ?? []), { path, at: at ?? -1 }]);
  }
  const byLoop = new Map<string, string>();
  for (const [name, candidates] of named) {
    byLoop.set(name, candidates.reduce((best, next) => (next.at > best.at ? next : best)).path);
  }
  return { byLoop, unnamed };
}

/**
 * The lines of a file holding anything but whitespace, read in fixed chunks so
 * a large events history costs a bounded buffer, not the whole file in memory.
 */
function nonEmptyLines(path: string): number {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let count = 0;
    let lineHasContent = false;
    for (let read = readSync(fd, buffer); read > 0; read = readSync(fd, buffer)) {
      for (let i = 0; i < read; i++) {
        const byte = buffer[i];
        if (byte === 0x0a) {
          if (lineHasContent) count++;
          lineHasContent = false;
        } else if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d && byte !== 0x0b && byte !== 0x0c) {
          lineHasContent = true;
        }
      }
    }
    return lineHasContent ? count + 1 : count;
  } finally {
    closeSync(fd);
  }
}

/** How many events a worktree's loop wrote: the non-empty lines of its events files. */
function eventCount(worktree: string): number {
  const logsDir = join(worktree, LOGS_RELATIVE_DIR);
  let count = 0;
  try {
    for (const name of readdirSync(logsDir)) {
      if (!EVENTS_FILE.test(name)) continue;
      try {
        count += nonEmptyLines(join(logsDir, name));
      } catch {
        // An events file that vanished or is unreadable counts as none.
      }
    }
  } catch {
    // No logs directory: no events.
  }
  return count;
}

/** `show` without --loop: every loop of the roster, in roster order. */
function showRoster(root: string, json: boolean): number {
  let config: ProjectConfig;
  try {
    config = loadProjectConfig(root);
  } catch (error) {
    console.error(`usage-stop: the committed config is unreadable, so there is no roster to show: ${(error as Error).message}`);
    return 2;
  }
  if (config.roster.length === 0) {
    console.error("usage-stop: the project's roster is empty; pass --loop <name>");
    return 2;
  }
  const override = readOverride(overridePath(root));
  const { byLoop, unnamed } = loopWorktrees(root, config.roster.map((entry) => entry.name));
  // An events file with no lines (an iteration killed before it wrote one) is
  // no events: such a worktree has not run, so it is not listed.
  const unnamedEvents = unnamed.map((path) => ({ path, events: eventCount(path) })).filter(({ events }) => events > 0);
  const now = nowMs();
  const rows = config.roster.map((entry) => {
    const assessment = assessWith(byLoop.get(entry.name) ?? null, entry.name, config, override, now);
    // A lapsed waiver stays in the override file but no longer counts.
    const waived = assessment.waiveUntil !== null && Date.parse(assessment.waiveUntil) > now;
    const age = readingAgeMs(assessment.reading, now);
    // `stale` is the plain fact that the number is old; an unknown age is
    // every doubt, which is never stale.
    const stale = assessment.rule !== null && age !== null && age > STALE_READING_MS;
    // Only a `run` drawn from an old number in a live window is unknown: usage
    // only rises inside a window, so an old reading is a floor and a park or
    // drain on it stays true (and is what `check` has the loop do). A waiver
    // or a window that has reset runs whatever the number was.
    const reading = assessment.reading;
    const unknown =
      stale && !waived && assessment.decision.verdict === "run" && reading !== null && reading.resetsAtMs > now;
    return { assessment, waived, age, stale, unknown };
  });
  if (json) {
    const loops = rows.map(({ assessment, stale }) => ({ ...assessment, stale }));
    console.log(JSON.stringify({ loops, unnamed: unnamedEvents }, null, 2));
    return 0;
  }
  for (const { assessment, waived, age, unknown } of rows) {
    const { loop, rule, source, waiveUntil, reading, decision } = assessment;
    const ruleText = rule === null ? "no usage stop" : `${rule.window} ${rule.percent}%/${rule.hardPercent}%`;
    // Fixed columns, `-` for no waiver, so `cut -f` finds the verdict on every
    // line.
    const waiver = waived ? `waived until ${waiveUntil}` : "-";
    let verdict: string = decision.verdict;
    let detail = decision.detail;
    if (unknown && rule !== null && reading !== null && age !== null) {
      verdict = "unknown (stale reading)";
      detail = `${rule.window} ${percentOf(reading.utilization)}% ${ageText(age)}`;
    } else if (rule !== null && reading !== null && age !== null) {
      detail += `; read ${ageText(age)}`;
    }
    console.log([loop, ruleText, source, waiver, verdict, oneLine(detail)].join("\t"));
  }
  for (const { path, events } of unnamedEvents) {
    console.log(`unnamed worktree ${path}: ${events} ${events === 1 ? "event" : "events"}, not credited`);
  }
  return 0;
}

function editOverride(root: string, key: string, change: (entry: OverrideEntry | undefined) => OverrideEntry | null): void {
  const path = overridePath(root);
  const override = readOverride(path) ?? { entries: {} };
  const next = change(override.entries[key]);
  if (next === null) delete override.entries[key];
  else override.entries[key] = next;
  writeOverride(path, override);
}

function set(root: string, loop: string, args: string[]): number {
  let rule: UsageStopRule | null;
  if (args.includes("--off")) {
    rule = null;
  } else {
    const number = (name: string) => {
      const raw = flag(args, name);
      return raw === undefined ? undefined : /^\d+$/.test(raw) ? Number(raw) : raw;
    };
    const candidate: Json = { percent: number("--percent") };
    if (flag(args, "--window") !== undefined) candidate.window = flag(args, "--window");
    if (flag(args, "--hard") !== undefined) candidate.hardPercent = number("--hard");
    const problems = usageStopProblems(candidate, "usageStop", false);
    if (problems.length > 0) {
      console.error(`usage-stop: ${problems.join("; ")}`);
      return 2;
    }
    rule = candidate as unknown as UsageStopRule;
  }
  const at = new Date(nowMs()).toISOString();
  // A new rule ends any waiver: the operator has just said where the line is.
  editOverride(root, loop, () => ({ rule, at }));
  console.log(rule === null ? `usage stop for ${loop}: off` : `usage stop for ${loop}: ${JSON.stringify(resolveRule(rule))}`);
  return 0;
}

function waive(root: string, loop: string, args: string[]): number {
  let untilMs = flag(args, "--until") === undefined ? NaN : Date.parse(flag(args, "--until")!);
  if (flag(args, "--until") === undefined) {
    const { rule, reading } = assess(root, loop);
    if (rule === null || reading === null || reading.resetsAtMs <= nowMs()) {
      console.error(`usage-stop: ${loop} has no live reading to waive until; pass --until <iso>`);
      return 2;
    }
    untilMs = reading.resetsAtMs + knob(process.env.RALPH_USAGE_RESET_MARGIN_SECONDS, DEFAULT_MARGIN_SECONDS) * 1000;
  }
  if (!Number.isFinite(untilMs)) {
    console.error("usage-stop: --until must be an ISO time");
    return 2;
  }
  const at = new Date(nowMs()).toISOString();
  editOverride(root, loop, (entry) => ({ ...entry, waiveUntil: new Date(untilMs).toISOString(), at }));
  console.log(`usage stop for ${loop}: waived until ${whenText(untilMs)}`);
  return 0;
}

export function main(args: string[]): number {
  const command = args[0];
  const loop = flag(args, "--loop");
  // Only `show` with nothing but `--json` asks for the roster: a bare `--loop`
  // (an empty variable in a script) or a `--loop=rafa` is still the usage
  // error it always was, never a silently unfiltered answer.
  if (command === "show" && args.slice(1).every((arg) => arg === "--json")) {
    try {
      return showRoster(projectRoot(), args.includes("--json"));
    } catch (error) {
      console.error(`usage-stop: ${(error as Error).message}`);
      return 1;
    }
  }
  if (command === undefined || loop === undefined || loop === "") {
    console.error("usage: usage-stop.ts show [--loop <name>] [--json] | check|set|clear|waive --loop <name> [...]");
    return command === "check" ? (console.log("run\t0\t-\tno loop named"), 0) : 2;
  }
  const root = projectRoot();
  if (command === "check") return check(root, loop);
  try {
    if (command === "show") {
      console.log(JSON.stringify(assess(root, loop), null, 2));
      return 0;
    }
    if (command === "set") return set(root, loop, args.slice(1));
    if (command === "clear") {
      editOverride(root, loop, () => null);
      console.log(`usage stop for ${loop}: override cleared`);
      return 0;
    }
    if (command === "waive") {
      if (loop === PROJECT_KEY) {
        console.error("usage-stop: a waiver is per loop");
        return 2;
      }
      return waive(root, loop, args.slice(1));
    }
  } catch (error) {
    console.error(`usage-stop: ${(error as Error).message}`);
    return 1;
  }
  console.error(`usage-stop: unknown command '${command}'`);
  return 2;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
