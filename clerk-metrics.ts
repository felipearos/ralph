#!/usr/bin/env bun
/**
 * `clerk-metrics.ts` — what the clerk's intake reports came to
 * (felipearos/ralph#443, #446).
 *
 * Reads the clerk loop's metrics ledger (`clerk/metrics.ts`) and prints, per
 * reporter, app or ISO week, how many reports were valuable, noise or still
 * pending, how often the team overrode the classification, and how long
 * confirmation took.
 *
 * Usage (from the intake project's worktree):
 *   bun "$RALPH_HOME/clerk-metrics.ts" [--json] [--by reporter|app|week] [--since YYYY-MM-DD] [--mode shadow|quiet|live[,…]] [--loop <name>]
 *
 * The loop defaults to RALPH_LOOP_NAME, else the worktree's `.ralph/loop-name`.
 * Reporters are Slack ids, or the name the `reported` event recorded: this
 * never calls Slack, so it runs anywhere the ledger is readable.
 *
 * Every event carries the clerk mode it was recorded in. `--mode` keeps the
 * reports of the modes named — `--mode live` leaves out the test data a quiet
 * or shadow run recorded (felipearos/ralph#443) — and the output always says
 * how many reports each mode holds, so a mixed ledger never reads as one.
 *
 * `--json` prints `{ v: 1, by, rows, skippedLines, modes }`; the dashboard
 * reads that shape. A missing ledger is the empty summary, exit 0.
 *
 * Exit codes: 0 · 64 usage.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { METRICS_MODES, clerkMetricsPath, readEvents, reportsByMode, summarise, type MetricsMode, type SummaryBy, type SummaryRow } from "./clerk/metrics";
import { LOOP_NAME_RELATIVE_PATH, projectRoot } from "./paths";

export const EXIT = { ok: 0, usage: 64 } as const;

const USAGE = `usage: bun clerk-metrics.ts [--json] [--by reporter|app|week] [--since YYYY-MM-DD] [--mode shadow|quiet|live[,…]] [--loop <name>]

  --json            print { v: 1, by, rows, skippedLines, modes }
  --by <group>      reporter (default), app or week (ISO, America/Santiago)
  --since <day>     only reports posted on or after this day
  --mode <modes>    only reports recorded in these clerk modes (comma-separated); default all
  --loop <name>     the clerk loop; default RALPH_LOOP_NAME, else .ralph/loop-name`;

export interface Flags {
  json: boolean;
  by: SummaryBy;
  since?: string;
  /** Only reports recorded in these modes; absent, every mode. */
  modes?: MetricsMode[];
  loop?: string;
}

export function parseFlags(argv: readonly string[]): { flags: Flags } | { problem: string } {
  const flags: Flags = { json: false, by: "reporter" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = (): string | null => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) return null;
      i += 1;
      return next;
    };
    if (arg === "--json") flags.json = true;
    else if (arg === "--by") {
      const by = value();
      if (by !== "reporter" && by !== "app" && by !== "week") return { problem: "--by takes reporter, app or week" };
      flags.by = by;
    } else if (arg === "--since") {
      const since = value();
      if (since === null || !isDay(since)) return { problem: "--since takes a date as YYYY-MM-DD" };
      flags.since = since;
    } else if (arg === "--mode") {
      const modes = value()?.split(",").map((mode) => mode.trim());
      if (modes === undefined || modes.length === 0 || !modes.every((mode): mode is MetricsMode => (METRICS_MODES as readonly string[]).includes(mode))) {
        return { problem: "--mode takes shadow, quiet or live, or several comma-separated" };
      }
      flags.modes = [...new Set(modes)];
    } else if (arg === "--loop") {
      const loop = value();
      if (loop === null || loop.trim() === "") return { problem: "--loop takes a loop name" };
      flags.loop = loop.trim();
    } else return { problem: `unknown argument: ${arg}` };
  }
  return { flags };
}

const isDay = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));

/** The loop this worktree runs as, as `ralph.sh` and `clerk/cursor.ts` read it. */
export function loopName(root: string, env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.RALPH_LOOP_NAME?.trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(join(root, LOOP_NAME_RELATIVE_PATH), "utf8").trim() || "clerk";
  } catch {
    return "clerk";
  }
}

export interface MetricsReport {
  v: 1;
  by: SummaryBy;
  rows: SummaryRow[];
  skippedLines: number;
  /** Reports per mode in the whole ledger, before `--mode` or `--since`: what the rows may be mixing. */
  modes: Record<MetricsMode, number>;
}

export function report(path: string, flags: Flags): MetricsReport {
  const { events, skippedLines } = readEvents(path);
  const rows = summarise(events, {
    by: flags.by,
    ...(flags.since !== undefined ? { since: flags.since } : {}),
    ...(flags.modes !== undefined ? { modes: flags.modes } : {}),
  });
  return { v: 1, by: flags.by, rows, skippedLines, modes: reportsByMode(events) };
}

const percent = (rate: number | null): string => (rate === null ? "-" : `${Math.round(rate * 100)}%`);

function duration(ms: number | null): string {
  if (ms === null) return "-";
  const minutes = ms / 60_000;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  return hours < 48 ? `${hours.toFixed(1)}h` : `${(hours / 24).toFixed(1)}d`;
}

const shown = (value: string | number | null): string => (value === null ? "none" : String(value));

/** A plain table: one header, one line per group, columns padded to fit. */
export function formatTable(result: MetricsReport): string {
  const header = [result.by, "reports", "valuable", "noise", "pending", "duplicates", "noise%", "override%", "overrides", "confirm p50", "top changes"];
  const lines = result.rows.map((row) => [
    row.label !== undefined ? `${row.label} (${row.key})` : row.key,
    String(row.reports),
    String(row.valuable),
    String(row.noise),
    String(row.pending),
    String(row.duplicates),
    percent(row.noiseRate),
    percent(row.overrideRate),
    Object.entries(row.overridesByField)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([field, count]) => `${field}:${count}(${percent(row.overrideRateByField[field] ?? null)})`)
      .join(",") || "-",
    duration(row.medianConfirmLatencyMs),
    row.topChanges.map((change) => `${change.field} ${shown(change.agent)}→${shown(change.human)} x${change.count}`).join(", ") || "-",
  ]);
  const table = [header, ...lines];
  const widths = header.map((_, column) => Math.max(...table.map((cells) => cells[column]!.length)));
  const out = table.map((cells) => cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd());
  if (result.rows.length === 0) out.push("(no reports)");
  if (result.skippedLines > 0) out.push(`skipped ${result.skippedLines} unreadable ledger line(s)`);
  // Said whenever the ledger holds test data, so quiet or shadow reports are never read as the team's.
  if (result.modes.quiet > 0 || result.modes.shadow > 0) {
    out.push(`ledger reports by mode: ${METRICS_MODES.map((mode) => `${mode} ${result.modes[mode]}`).join(", ")} (--mode live for the team's alone)`);
  }
  return out.join("\n");
}

export function main(argv: readonly string[]): number {
  const parsed = parseFlags(argv);
  if ("problem" in parsed) {
    console.error(`clerk-metrics: ${parsed.problem}\n${USAGE}`);
    return EXIT.usage;
  }
  const { flags } = parsed;
  const root = projectRoot();
  const path = clerkMetricsPath(flags.loop ?? loopName(root), root);
  const result = report(path, flags);
  console.log(flags.json ? JSON.stringify(result) : formatTable(result));
  return EXIT.ok;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
