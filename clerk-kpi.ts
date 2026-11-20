#!/usr/bin/env bun
/**
 * `clerk-kpi.ts` — the clerk's daily KPI report, rendered from the metrics
 * ledger (felipearos/ralph#453, spec #443).
 *
 * The gate sends it (`clerk/kpi.ts`, from the poll); this prints it, so an
 * operator can read what tomorrow's DM will say without Slack, and the tests
 * pin the text the same way.
 *
 * Usage (from the intake project's worktree):
 *   bun "$RALPH_HOME/clerk-kpi.ts" --print [--date YYYY-MM-DD] [--members U1,U2] [--loop <name>]
 *
 * `--print` writes the report to stdout and makes no Slack call. The channel's
 * members are Slack's to say, so without `--members` the participation
 * section says the data was not available, exactly as a failed read does.
 * `--date` is the local day the report is for (default today in the report's
 * time zone); it covers the days before it.
 *
 * The rules come from the project's `clerk.kpiReport` block, `KPI_REPORT_DEFAULTS`
 * when it has none. The loop defaults to RALPH_LOOP_NAME, else `.ralph/loop-name`.
 *
 * Exit codes: 0 · 64 usage.
 */
import { loopName } from "./clerk-metrics";
import { kpiText, localNow, reportWindow, targetsFor, type Members } from "./clerk/kpi";
import { clerkMetricsPath, readEvents } from "./clerk/metrics";
import { projectRoot } from "./paths";
import { KPI_REPORT_DEFAULTS, clerkRules, loadProjectConfig, type ClerkMode, type KpiReportRules } from "./project-config";

export const EXIT = { ok: 0, usage: 64 } as const;

const USAGE = `usage: bun clerk-kpi.ts --print [--date YYYY-MM-DD] [--members U1,U2] [--loop <name>]

  --print           write the report to stdout; no Slack call is made
  --date <day>      the local day the report is for (default today)
  --members <ids>   the channel's members, comma-separated, for participation
  --loop <name>     the clerk loop; default RALPH_LOOP_NAME, else .ralph/loop-name`;

export interface Flags {
  print: boolean;
  date?: string;
  members?: string[];
  loop?: string;
}

export function parseFlags(argv: readonly string[]): { flags: Flags } | { problem: string } {
  const flags: Flags = { print: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = (): string | null => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) return null;
      i += 1;
      return next;
    };
    if (arg === "--print") flags.print = true;
    else if (arg === "--date") {
      const date = value();
      if (date === null || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) {
        return { problem: "--date takes a date as YYYY-MM-DD" };
      }
      flags.date = date;
    } else if (arg === "--members") {
      const members = value();
      if (members === null) return { problem: "--members takes Slack user ids, comma-separated" };
      flags.members = members
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id !== "");
    } else if (arg === "--loop") {
      const loop = value();
      if (loop === null || loop.trim() === "") return { problem: "--loop takes a loop name" };
      flags.loop = loop.trim();
    } else return { problem: `unknown argument: ${arg}` };
  }
  if (!flags.print) return { problem: "--print is required: the gate sends the report, this only prints it" };
  return { flags };
}

interface Setting {
  rules: KpiReportRules;
  mode: ClerkMode;
  operator: string | null;
}

/** The project's report rules; the defaults when it has no clerk or no report block, or a config that does not load. */
function setting(root: string): Setting {
  try {
    const clerk = clerkRules(loadProjectConfig(root));
    if (clerk !== null) return { rules: clerk.kpiReport ?? KPI_REPORT_DEFAULTS, mode: clerk.mode, operator: clerk.operator };
  } catch {}
  return { rules: KPI_REPORT_DEFAULTS, mode: "shadow", operator: null };
}

export function render(root: string, flags: Flags, nowMs = Date.now()): string {
  const { rules, mode, operator } = setting(root);
  const day = flags.date ?? localNow(nowMs, rules.timezone).day;
  const members: Members =
    flags.members === undefined ? { ok: false, why: "--print no consulta Slack; pase --members" } : { ok: true, current: flags.members, previous: null };
  const { events } = readEvents(clerkMetricsPath(flags.loop ?? loopName(root), root));
  const targets = targetsFor(rules, mode, operator);
  return kpiText(
    events,
    { day, window: reportWindow(day, rules), timezone: rules.timezone, quietDays: rules.quietDays, members, exclude: rules.exclude ?? [] },
    {
      draft: targets.draft,
      ...(targets.draftWhy === undefined ? {} : { draftWhy: targets.draftWhy }),
      recipients: rules.recipients,
      channels: rules.channels,
    },
  );
}

export function main(argv: readonly string[]): number {
  const parsed = parseFlags(argv);
  if ("problem" in parsed) {
    console.error(`clerk-kpi: ${parsed.problem}\n${USAGE}`);
    return EXIT.usage;
  }
  console.log(render(projectRoot(), parsed.flags));
  return EXIT.ok;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
