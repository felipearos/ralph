/**
 * The usage guard of an eval run (#801): live loops keep priority over
 * evaluation work. Before each trial the run reads, from UsageBar
 * (`codexbar usage --format json`, the reading the dashboard's usage bar
 * shows), the windows of every provider the run spends: Claude always, Codex
 * too when an arm or a judge runs on it (#822). When the fullest window is at
 * or over the plan's limit, it waits for that window to reset rather than
 * spend what the loops need.
 *
 * Every failure degrades to "no reading", and no reading lets the trial run:
 * a host without UsageBar runs evals exactly as it did before the guard.
 */
import { spawnSync } from "node:child_process";

/** A provider whose windows UsageBar reads, named as its `provider` field names it. */
export type UsageRunner = "claude" | "codex";

export interface UsageReading {
  /** The fullest window's used share, 0–100. */
  usedPercent: number;
  /** Its name as UsageBar shows it: Session, Weekly, or a model's own limit. */
  window: string;
  /** When it resets; null when UsageBar does not say. */
  resetsAt: string | null;
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** One provider's fullest standard window in a `codexbar usage --format json` print; null when it has none. Pure. */
export function fullestWindow(stdout: string, provider: UsageRunner): UsageReading | null {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  const providers = Array.isArray(parsed) ? parsed : [];
  const entry = providers.map(record).find((candidate) => candidate?.provider === provider);
  const usage = record(entry?.usage);
  if (!usage) return null;
  const windows: UsageReading[] = [];
  const add = (raw: unknown, name: string) => {
    const window = record(raw);
    const used = window?.usedPercent;
    if (window === null || typeof used !== "number" || !Number.isFinite(used) || window.isSyntheticPlaceholder === true) return;
    windows.push({ usedPercent: used, window: name, resetsAt: typeof window.resetsAt === "string" ? window.resetsAt : null });
  };
  // Both providers report their five-hour window first and their week second.
  add(usage.primary, "Session");
  add(usage.secondary, "Weekly");
  // A model's own limit (Opus, Fable, Codex Spark) only binds trials on that model, so it is left out.
  if (windows.length === 0) return null;
  return windows.reduce((fullest, window) => (window.usedPercent > fullest.usedPercent ? window : fullest));
}

/** The fullest Claude window in a `codexbar usage --format json` print; null when it has none. Pure. */
export const fullestClaudeWindow = (stdout: string): UsageReading | null => fullestWindow(stdout, "claude");

/**
 * The production reading: one `codexbar` call, bounded, for every provider at
 * once; a provider is null on any failure, so an unreadable Codex never
 * stops a guard that can still read Claude.
 */
export function readUsage(env: NodeJS.ProcessEnv = process.env): Record<UsageRunner, UsageReading | null> {
  const result = spawnSync(env.RALPH_CODEXBAR_BIN || "codexbar", ["usage", "--format", "json"], { encoding: "utf8", timeout: 60_000, env });
  // The CLI exits non-zero when any one provider failed, yet prints every provider: read stdout whatever the status.
  if (result.error || !result.stdout) return { claude: null, codex: null };
  return { claude: fullestWindow(result.stdout, "claude"), codex: fullestWindow(result.stdout, "codex") };
}

/**
 * The providers a run spends (#822): Claude always (the trial's supervisor and
 * the local review run on it), plus Codex when any arm's stage or any judge
 * runs on it. Another runner (opencode) has no UsageBar window to guard.
 */
export function usageRunners(runners: Iterable<string | null | undefined>): UsageRunner[] {
  const found = new Set<string | null | undefined>(runners);
  return found.has("codex") ? ["claude", "codex"] : ["claude"];
}

/** Re-read at least this often while waiting: a window that resets early, or a reading that was stale, ends the wait sooner. */
export const GUARD_RECHECK_MS = 15 * 60_000;

/**
 * The longest one trial waits on the guard. A weekly window can be days from
 * its reset; past this the trial runs, so a stale or stuck reading never holds
 * a run without end.
 */
export const GUARD_MAX_WAIT_MS = 6 * 3_600_000;

/** How long to wait before reading again: until the window resets, at most a recheck. */
export function guardWaitMs(reading: UsageReading, nowMs: number): number {
  const reset = reading.resetsAt === null ? Number.NaN : Date.parse(reading.resetsAt);
  if (!Number.isFinite(reset)) return GUARD_RECHECK_MS;
  return Math.max(60_000, Math.min(GUARD_RECHECK_MS, reset - nowMs + 60_000));
}
