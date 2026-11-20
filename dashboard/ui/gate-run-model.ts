/**
 * The Settings page's gate Run (#690), as the page draws it: a run's state
 * label and tone, its duration and exit code in words, whether a Run button
 * is offered and why not, and whether the page keeps polling. Pure, so every
 * state the server can answer is tested without React.
 */
import type { GateRunState, GateRunView } from "../contracts";
import { chileDateTime } from "./chile-time";

/** The shell's tone words; kept as a local union so this module stays free of React. */
export type GateRunTone = "good" | "warn" | "bad" | "info";

/** How often the page re-reads a run in flight. */
export const GATE_RUN_POLL_MS = 2000;

// A timeout is its own outcome: the command never answered, which says
// something different from a command that answered "no", so it is worded and
// coloured apart from a failure.
const STATUS: Record<GateRunState, { label: string; tone: GateRunTone }> = {
  running: { label: "Running", tone: "info" },
  passed: { label: "Passed", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
  timeout: { label: "Timed out", tone: "warn" },
};

export function gateRunStatus(state: GateRunState): { label: string; tone: GateRunTone } {
  // An unknown state from a newer server still draws as something rather than crashing the row.
  return STATUS[state] ?? { label: String(state), tone: "info" };
}

/** `850 ms`, `12.3 s`, `2 min 5 s`, `1 h 3 min`: precise where a gate is quick, coarse where it is slow. */
export function formatGateDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)} s`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 3600) {
    const rest = seconds % 60;
    return rest === 0 ? `${Math.floor(seconds / 60)} min` : `${Math.floor(seconds / 60)} min ${rest} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${rest} min`;
}

export interface GateRunResult {
  label: string;
  tone: GateRunTone;
  /** "exit 1", "no exit code" when the process never exited on its own; null while running. */
  exit: string | null;
  /** Null while running. */
  duration: string | null;
  started: string;
  /** Why the run never started (a spawn error), else null. */
  error: string | null;
  /** The output tail; empty when the command printed nothing. */
  output: string;
  truncated: boolean;
}

/** The project's run as a row draws it, or null when the run is not this gate's. */
export function gateRunResult(run: GateRunView | null, gate: string): GateRunResult | null {
  if (run === null || run.gate !== gate) return null;
  const status = gateRunStatus(run.state);
  const running = run.state === "running";
  return {
    ...status,
    exit: running ? null : run.exitCode === null ? (run.state === "timeout" ? `stopped after ${formatGateDuration(run.limitMs)}` : "no exit code") : `exit ${run.exitCode}`,
    duration: running || run.durationMs === null ? null : formatGateDuration(run.durationMs),
    started: chileDateTime(run.startedAt),
    error: run.error,
    output: run.output,
    truncated: run.truncated,
  };
}

/**
 * Whether a gate's Run is offered. The command's own lock (the remote page)
 * comes first; then one run at a time per project — the server refuses a
 * second anyway, but the button says why before it is pressed.
 */
export function gateRunAvailability(
  run: GateRunView | null,
  command: { disabled: boolean; why: string | null; pending: boolean },
): { disabled: boolean; why: string | null } {
  if (command.disabled) return { disabled: true, why: command.why };
  if (run !== null && run.state === "running") return { disabled: true, why: `gate '${run.gate}' is running` };
  if (command.pending) return { disabled: true, why: "starting a run" };
  return { disabled: false, why: null };
}

/** The page re-reads only while a run is in flight; a settled one never changes again. */
export function keepPolling(run: GateRunView | null): boolean {
  return run !== null && run.state === "running";
}
