#!/usr/bin/env bun
/**
 * `clerk-intake.ts` — what the intake page shows (felipearos/ralph#459).
 *
 * Two read-only views for the dashboard, which reaches the clerk through this
 * CLI and never by import:
 *
 *   bun clerk-intake.ts --json             the tickets: the gate's intake snapshot
 *   bun clerk-intake.ts --metrics --json   the metrics: clerk-metrics rows by reporter, app and week, plus participation
 *
 * Run with RALPH_PROJECT naming the intake project's checkout (any worktree of
 * it: the snapshot and the ledger live in Git's common directory). The clerk
 * loop is the roster's clerk, or `--loop <name>`.
 *
 * It always prints one JSON object and exits 0 once its arguments parse: a
 * project with no clerk, no snapshot yet, or an unreadable config is
 * `available: false` with the reason in Spanish, which the page shows as is.
 *
 * Exit codes: 0 · 64 usage.
 */
import { report, type MetricsReport } from "./clerk-metrics";
import { clerkMetricsPath, participation, precision, readEvents, type ParticipationRow, type PrecisionView } from "./clerk/metrics";
import { INTAKE_SNAPSHOT_VERSION, intakeSnapshotPath, readIntakeSnapshot, type IntakeSnapshot } from "./clerk/intake-snapshot";
import { clerkStorePath } from "./clerk/store";
import { projectRoot } from "./paths";
import { loadProjectConfig } from "./project-config";
import { loopsWithRole } from "./roster";

export const EXIT = { ok: 0, usage: 64 } as const;

const USAGE = "usage: bun clerk-intake.ts [--metrics] --json [--loop <name>]";

export type IntakeTicketsOutput =
  | ({ available: true; loop: string; reason: null } & IntakeSnapshot)
  | { v: typeof INTAKE_SNAPSHOT_VERSION; available: false; loop: string | null; reason: string };

export interface IntakeMetricsOutput {
  v: 1;
  available: boolean;
  loop: string | null;
  reason: string | null;
  generatedAt: string;
  skippedLines: number;
  /** Reports per clerk mode in the ledger, so the page can say how much of it is test data (felipearos/ralph#443). */
  modes: MetricsReport["modes"];
  byReporter: MetricsReport["rows"];
  byApp: MetricsReport["rows"];
  byWeek: MetricsReport["rows"];
  participation: ParticipationRow[];
  /** How often confirmers corrected the clerk, field by field: the Precisión tab. */
  precision: PrecisionView;
}

/** The clerk loop of the project at `root`, or why there is none. */
export function clerkLoop(root: string, named?: string): { loop: string } | { reason: string } {
  if (named !== undefined) return { loop: named };
  try {
    const [loop] = loopsWithRole("clerk", loadProjectConfig(root).roster);
    return loop === undefined ? { reason: "Este proyecto no tiene un clerk en su roster." } : { loop };
  } catch (error) {
    return { reason: `No se pudo leer la configuración del proyecto: ${(error as Error).message}` };
  }
}

export function tickets(root: string, named?: string): IntakeTicketsOutput {
  const found = clerkLoop(root, named);
  if ("reason" in found) return { v: INTAKE_SNAPSHOT_VERSION, available: false, loop: null, reason: found.reason };
  const snapshot = readIntakeSnapshot(intakeSnapshotPath(clerkStorePath(found.loop, root)));
  if (snapshot === null) {
    return {
      v: INTAKE_SNAPSHOT_VERSION,
      available: false,
      loop: found.loop,
      reason: "El clerk todavía no ha publicado los tickets: aparecen en la próxima actualización del canvas.",
    };
  }
  return { ...snapshot, available: true, loop: found.loop, reason: null };
}

export function metrics(root: string, named?: string, nowMs = Date.now()): IntakeMetricsOutput {
  const found = clerkLoop(root, named);
  const empty = {
    v: 1 as const,
    generatedAt: new Date(nowMs).toISOString(),
    skippedLines: 0,
    modes: { shadow: 0, quiet: 0, live: 0 },
    byReporter: [],
    byApp: [],
    byWeek: [],
    participation: [],
    precision: precision([]),
  };
  if ("reason" in found) return { ...empty, available: false, loop: null, reason: found.reason };
  const path = clerkMetricsPath(found.loop, root);
  const by = (group: "reporter" | "app" | "week") => report(path, { json: true, by: group });
  const reporter = by("reporter");
  const { events } = readEvents(path);
  return {
    ...empty,
    available: true,
    loop: found.loop,
    reason: null,
    skippedLines: reporter.skippedLines,
    modes: reporter.modes,
    byReporter: reporter.rows,
    byApp: by("app").rows,
    byWeek: by("week").rows,
    participation: participation(events, nowMs),
    precision: precision(events),
  };
}

export function main(argv: readonly string[]): number {
  let wantMetrics = false;
  let json = false;
  let loop: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--metrics") wantMetrics = true;
    else if (arg === "--json") json = true;
    else if (arg === "--loop" && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) loop = argv[++i]!.trim();
    else {
      console.error(`clerk-intake: unknown argument: ${arg}\n${USAGE}`);
      return EXIT.usage;
    }
  }
  if (!json) {
    console.error(`clerk-intake: --json is required: this is the dashboard's read\n${USAGE}`);
    return EXIT.usage;
  }
  const root = projectRoot();
  console.log(JSON.stringify(wantMetrics ? metrics(root, loop) : tickets(root, loop)));
  return EXIT.ok;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
