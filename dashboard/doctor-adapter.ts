/**
 * The plugin doctor, from the page's side of the process boundary.
 *
 * The page never talks to a plugin's backend, and never runs a plugin: it
 * runs the harness's `plugin-doctor.ts`, which runs each enabled plugin's own
 * `doctor` command and holds it to that plugin's allowlist. So this module
 * names one script and its flags, and knows nothing about what any plugin
 * checks or repairs — the checks, their words and their repairs all arrive in
 * the answer.
 *
 * It owns the executor too, behind `guarded()`, so the route asks for one
 * run and reads a view. A timeout or a missing `bun` already resolves as a
 * null status; `guarded()` covers an executor that rejects outright, so that
 * too reads as a failed view with a `problem`, never as a 500.
 *
 * The doctor runs with `RALPH_PLUGINS` removed, so the project's own config
 * says which plugins are enabled: a page is not a run, and one started from a
 * loop's shell must not inherit that run's override.
 */
import { join, resolve } from "node:path";

import { ADAPTER_ENV, defaultBunPath, isRecord } from "./adapter";
import { DOCTOR_DISABLE_REPAIR, DOCTOR_HISTORY_KINDS } from "./contracts";
import type {
  DoctorAction,
  DoctorCheckStatus,
  DoctorCheckView,
  DoctorHistoryEntry,
  DoctorHistoryKind,
  DoctorPluginView,
  DoctorStepResult,
  DoctorStepView,
  DoctorView,
  Env,
} from "./contracts";
import { guarded, type ExecResult, type Executor } from "./control-adapter";

/** The doctor's command surface: one script, and the one repair it carries out itself. */
export const DOCTOR_SURFACE = {
  script: "plugin-doctor.ts",
  flags: { plugin: "--plugin", repair: "--repair", fixAll: "--fix-all" },
  /** Cleared, never set: the project's config decides, not an inherited run. */
  clearedEnv: ["RALPH_PLUGINS"],
  /** Turns the plugin off for the project, so the page asks for confirmation. */
  disableRepair: DOCTOR_DISABLE_REPAIR,
} as const;

export interface DoctorRequest {
  action: DoctorAction;
  plugin: string | null;
  check: string | null;
  repair: string | null;
}

export interface DoctorAdapter {
  run(loop: string, request: DoctorRequest): Promise<DoctorView>;
}

export interface DoctorAdapterConfig {
  cliDir: string;
  root: string;
  bunPath?: string;
  env?: Env;
  /** Runs the doctor; wrapped in `guarded()`, so a throw reads as a null status and a failed view. */
  exec: Executor;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const CHECK_STATUSES: readonly DoctorCheckStatus[] = ["pass", "fail", "skipped"];
const STEP_RESULTS: readonly DoctorStepResult[] = ["repaired", "failed", "not-repairable"];

function narrowCheck(value: unknown): DoctorCheckView | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const status = text(value.status) as DoctorCheckStatus | null;
  if (id === null || status === null || !CHECK_STATUSES.includes(status)) return null;
  return {
    id,
    label: text(value.label) ?? id,
    status,
    detail: text(value.detail) ?? "",
    repairs: Array.isArray(value.repairs)
      ? value.repairs.filter(isRecord).flatMap((row) => {
          const repairId = text(row.id);
          return repairId === null ? [] : [{ id: repairId, label: text(row.label) ?? repairId, default: row.default === true }];
        })
      : [],
  };
}

function narrowStep(value: unknown): DoctorStepView | null {
  if (!isRecord(value)) return null;
  const check = text(value.check);
  const result = text(value.result) as DoctorStepResult | null;
  if (check === null || result === null || !STEP_RESULTS.includes(result)) return null;
  return { check, action: text(value.action), result, why: text(value.why) ?? "" };
}

function narrowHistory(value: unknown): DoctorHistoryEntry | null {
  if (!isRecord(value)) return null;
  const plugin = text(value.plugin);
  const kind = text(value.kind) as DoctorHistoryKind | null;
  if (plugin === null || kind === null || !DOCTOR_HISTORY_KINDS.includes(kind)) return null;
  return {
    at: text(value.at) ?? "",
    plugin,
    run: text(value.run),
    kind,
    via: value.via === "operator" || value.via === "fix-all" ? value.via : null,
    check: text(value.check),
    action: text(value.action),
    result: text(value.result) ?? "",
    why: text(value.why) ?? "",
  };
}

/**
 * Narrow the doctor's JSON. Anything unreadable is a `problem` on the view,
 * never a thrown error: a broken doctor must not take the loop page with it.
 */
export function parseDoctorOutput(loop: string, result: ExecResult): DoctorView {
  const empty: DoctorView = { loop, plugins: [], steps: [], stopped: null, history: [], problem: null };
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return { ...empty, problem: result.stderr.trim() || `the plugin doctor exited ${String(result.status)} without an answer` };
  }
  if (!isRecord(value) || value.version !== 1) {
    return { ...empty, problem: isRecord(value) && text(value.error) !== null ? String(value.error) : "the plugin doctor's answer is not version 1" };
  }
  const plugins: DoctorPluginView[] = (Array.isArray(value.plugins) ? value.plugins : [])
    .filter(isRecord)
    // A plugin without a doctor has no panel: it has nothing to diagnose.
    .filter((row) => row.supported !== false)
    .flatMap((row): DoctorPluginView[] => {
      const plugin = text(row.plugin);
      if (plugin === null) return [];
      const report = isRecord(row.report) ? row.report : null;
      const checks = Array.isArray(report?.checks) ? report.checks.map(narrowCheck) : [];
      if (report === null || checks.length === 0 || checks.some((check) => check === null)) {
        return [{ plugin, title: plugin, checks: [], problem: text(row.why) ?? "the plugin's doctor did not answer" }];
      }
      return [{ plugin, title: text(report.title) ?? plugin, checks: checks as DoctorCheckView[], problem: null }];
    });
  return {
    loop,
    plugins,
    steps: (Array.isArray(value.steps) ? value.steps : []).map(narrowStep).filter((step): step is DoctorStepView => step !== null),
    stopped: text(value.stopped),
    history: (Array.isArray(value.history) ? value.history : [])
      .map(narrowHistory)
      .filter((entry): entry is DoctorHistoryEntry => entry !== null),
    problem: null,
  };
}

export function createDoctorAdapter(config: DoctorAdapterConfig): DoctorAdapter {
  const root = resolve(config.root);
  const bunPath = config.bunPath ?? defaultBunPath();
  const env: Env = { ...process.env, ...config.env, [ADAPTER_ENV.loopStateRoot]: root };
  for (const name of DOCTOR_SURFACE.clearedEnv) delete env[name];
  const { flags } = DOCTOR_SURFACE;
  const exec = guarded(config.exec);
  return {
    run: async (loop, request) => {
      const args = [join(resolve(config.cliDir), DOCTOR_SURFACE.script)];
      if (request.plugin !== null) args.push(flags.plugin, request.plugin);
      if (request.action === "repair") args.push(flags.repair, `${request.check ?? ""}:${request.repair ?? ""}`);
      if (request.action === "fix-all") args.push(flags.fixAll);
      return parseDoctorOutput(loop, await exec({ command: bunPath, args, cwd: root, env }));
    },
  };
}
