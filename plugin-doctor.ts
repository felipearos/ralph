#!/usr/bin/env bun
/**
 * The plugin doctor: say which part of an enabled plugin is broken, and offer
 * the repair that fits it.
 *
 * A plugin that is not doing its job fails quietly by design — the host
 * records it as that plugin's health and the loop carries on — which is right
 * for the loop and useless for an operator staring at a board that does not
 * show the loop. So a plugin may answer one more command, `doctor`, beside its
 * hooks, and this file is the only thing that runs it:
 *
 *   diagnose   the plugin's checks, in order, each `pass`, `fail` or
 *              `skipped` (a check that cannot be asked while an earlier one
 *              fails), with a plain-language detail and, for a failed one,
 *              the repairs that fit it.
 *   repair     one repair the plugin offered on one failed check. The request
 *              is judged against a fresh diagnosis first, so a repair the
 *              plugin does not offer right now is refused here, not tried.
 *   fix all    the checks in order: the first failing one gets its default
 *              repair, the checks are asked again, and the walk stops at the
 *              first check that has no default repair, whose repair failed, or
 *              that a repair did not clear — and says which, and why.
 *
 * What the plugin may touch to repair itself is the plugin's own allowlist to
 * hold, exactly as for its hooks. One repair is the host's instead: turning
 * the plugin off for the project (`disable-plugin`), since that is the
 * project's config and not the plugin's to write.
 *
 * Every diagnosis and every repair step is appended to
 * `.ralph/logs/plugin-doctor.jsonl` — which check, which action, what came of
 * it — and read back as the loop's repair history. Nothing here reads or
 * writes the loop's own state, control record or locks, and a loop never
 * waits on the doctor: it is run by an operator, beside the loop.
 *
 * Usage:
 *   plugin-doctor.ts [--plugin <name>] [--repair <check>:<repair> | --fix-all]
 *
 * Prints one JSON document and always exits 0.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { STATE_RELATIVE_PATH, parseLoopState, writeJsonAtomically } from "./loop-state";
import { CONFIG_RELATIVE_PATH, projectRoot } from "./paths";
import { enabledPlugins, endBackoff, readHealth, runPlugin } from "./plugins";
import { parseProjectConfig } from "./project-config";

type Env = Record<string, string | undefined>;

/** Where every diagnosis and repair is recorded, one JSON object per line. */
export const DOCTOR_RECORD_RELATIVE_PATH = ".ralph/logs/plugin-doctor.jsonl";

/** The one repair the host carries out itself: off for this project. */
export const DISABLE_REPAIR = "disable-plugin";

const DEFAULT_TIMEOUT_SECONDS = 120;
const HISTORY_LIMIT = 50;

export const CHECK_STATUSES = ["pass", "fail", "skipped"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const STEP_RESULTS = ["repaired", "failed", "not-repairable"] as const;
export type StepResult = (typeof STEP_RESULTS)[number];

export const HISTORY_KINDS = ["diagnosis", "repair", "fix-all"] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

export interface DoctorRepair {
  id: string;
  label: string;
  /** The repair Fix all applies. At most one per check. */
  default: boolean;
}

export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  /** What passed, or what failed, in words an operator can act on. */
  detail: string;
  /** Offered only on a failed check, and only the ones that can apply now. */
  repairs: DoctorRepair[];
}

export interface DoctorReport {
  plugin: string;
  /** How the plugin names itself on a panel. */
  title: string;
  checks: DoctorCheck[];
}

export interface DoctorStep {
  check: string;
  action: string | null;
  result: StepResult;
  why: string;
}

export interface DoctorEntry {
  version: 1;
  at: string;
  plugin: string;
  run: string | null;
  kind: HistoryKind;
  /** Who asked: the operator, or Fix all on the operator's behalf. */
  via: "operator" | "fix-all" | null;
  check: string | null;
  action: string | null;
  result: string;
  why: string;
  /** A diagnosis's checks, as they stood. */
  checks?: { id: string; status: CheckStatus }[];
}

export interface PluginDiagnosis {
  plugin: string;
  /** False when the plugin has no doctor; it is then left off any panel. */
  supported: boolean;
  /** Why there is no report: the plugin failed to answer, or has no doctor. */
  why: string | null;
  report: DoctorReport | null;
}

export interface DoctorOutput {
  version: 1;
  loop: LoopIdentity;
  enabled: string[];
  plugins: PluginDiagnosis[];
  steps: DoctorStep[];
  /** Why Fix all stopped short, or null when it did not run or did not stop. */
  stopped: string | null;
  history: DoctorEntry[];
}

export interface LoopIdentity {
  run: string | null;
  loop: string;
  worktree: string;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/* --------------------------------------------------------------------------
 * Reading a plugin's answer.
 * ----------------------------------------------------------------------- */

function parseCheck(value: unknown): DoctorCheck | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const status = text(value.status);
  if (id === null || status === null || !(CHECK_STATUSES as readonly string[]).includes(status)) return null;
  const repairs =
    status === "fail" && Array.isArray(value.repairs)
      ? value.repairs.flatMap((row): DoctorRepair[] => {
          if (!isRecord(row)) return [];
          const repairId = text(row.id);
          return repairId === null ? [] : [{ id: repairId, label: text(row.label) ?? repairId, default: row.default === true }];
        })
      : [];
  // One default at most: Fix all must never have to choose.
  let defaulted = false;
  for (const repair of repairs) {
    if (repair.default && defaulted) repair.default = false;
    if (repair.default) defaulted = true;
  }
  return { id, label: text(value.label) ?? id, status: status as CheckStatus, detail: text(value.detail) ?? "", repairs };
}

/** A plugin's diagnosis, or null for anything that is not one. */
export function parseReport(value: unknown, plugin: string): DoctorReport | null {
  if (!isRecord(value) || !Array.isArray(value.checks)) return null;
  const checks = value.checks.map(parseCheck);
  if (checks.length === 0 || checks.some((check) => check === null)) return null;
  return { plugin, title: text(value.title) ?? plugin, checks: checks as DoctorCheck[] };
}

function parseStep(value: unknown): DoctorStep | null {
  if (!isRecord(value)) return null;
  const check = text(value.check);
  const result = text(value.result);
  if (check === null || result === null || !(STEP_RESULTS as readonly string[]).includes(result)) return null;
  return { check, action: text(value.action), result: result as StepResult, why: text(value.why) ?? "" };
}

/* --------------------------------------------------------------------------
 * The record.
 * ----------------------------------------------------------------------- */

/** Read the record back, newest last, skipping any line that is not an entry. */
export function parseDoctorRecord(raw: string): DoctorEntry[] {
  return raw.split("\n").flatMap((line): DoctorEntry[] => {
    if (line.trim() === "") return [];
    try {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value) || value.version !== 1) return [];
      const plugin = text(value.plugin);
      const kind = text(value.kind);
      if (plugin === null || kind === null || !(HISTORY_KINDS as readonly string[]).includes(kind)) return [];
      const via = value.via === "operator" || value.via === "fix-all" ? value.via : null;
      const checks = Array.isArray(value.checks)
        ? value.checks.flatMap((row): { id: string; status: CheckStatus }[] => {
            if (!isRecord(row)) return [];
            const id = text(row.id);
            const status = text(row.status);
            return id !== null && status !== null && (CHECK_STATUSES as readonly string[]).includes(status)
              ? [{ id, status: status as CheckStatus }]
              : [];
          })
        : undefined;
      return [
        {
          version: 1,
          at: text(value.at) ?? "",
          plugin,
          run: text(value.run),
          kind: kind as HistoryKind,
          via,
          check: text(value.check),
          action: text(value.action),
          result: text(value.result) ?? "",
          why: text(value.why) ?? "",
          ...(checks === undefined ? {} : { checks }),
        },
      ];
    } catch {
      return [];
    }
  });
}

export function readDoctorHistory(root: string): DoctorEntry[] {
  try {
    const entries = parseDoctorRecord(readFileSync(join(root, DOCTOR_RECORD_RELATIVE_PATH), "utf8"));
    return entries.slice(Math.max(0, entries.length - HISTORY_LIMIT));
  } catch {
    return [];
  }
}

/**
 * Append one entry. A record that cannot be written is a missing history
 * line, never a failed repair: the repair has happened either way, and the
 * answer the operator is shown still says what it was.
 */
function record(root: string, entry: Omit<DoctorEntry, "version" | "at">, now: Date): void {
  try {
    const path = join(root, DOCTOR_RECORD_RELATIVE_PATH);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ version: 1, at: now.toISOString(), ...entry })}\n`);
  } catch {
    // See above.
  }
}

/* --------------------------------------------------------------------------
 * Asking a plugin.
 * ----------------------------------------------------------------------- */

export interface DoctorOptions {
  env?: Env;
  now?: () => Date;
}

/** The loop's own identity, from its durable state: whose Run a repair is for. */
export function loopIdentity(root: string, env: Env = process.env): LoopIdentity {
  let state = null;
  try {
    state = parseLoopState(readFileSync(join(root, STATE_RELATIVE_PATH), "utf8"));
  } catch {
    // A loop that has not started has no run; the plugin says what that costs.
  }
  return {
    run: state?.run ?? null,
    loop: state?.owner.loop ?? (env.RALPH_LOOP_NAME?.trim() || "ralph"),
    worktree: resolve(state?.worktree ?? root),
  };
}

const timeoutMs = (env: Env): number => {
  const raw = Number(env.RALPH_PLUGIN_DOCTOR_TIMEOUT_SECONDS);
  return (Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_SECONDS) * 1000;
};

interface Asked {
  ok: boolean;
  why: string;
  report: DoctorReport | null;
  step: DoctorStep | null;
  /** The plugin answered, but has no doctor to answer with. */
  unsupported: boolean;
}

function ask(root: string, plugin: string, request: Record<string, unknown>, env: Env): Asked {
  const loop = loopIdentity(root, env);
  // The host's own back-off, which only the host can see: a plugin checking
  // its back-off windows would otherwise report clear while this one holds.
  const degraded = readHealth(root).plugins[plugin]?.degraded ?? null;
  const ran = runPlugin(root, plugin, "doctor", { ...request, loop, host: { degraded } }, env, timeoutMs(env));
  const report = parseReport(ran.value, plugin);
  const step = parseStep(ran.value?.step);
  if (!ran.ok) {
    return { ok: false, why: ran.why, report, step, unsupported: /unknown hook/.test(ran.why) };
  }
  if (report === null) {
    return { ok: false, why: "the plugin's doctor answered without a diagnosis", report: null, step, unsupported: false };
  }
  return { ok: true, why: "", report, step, unsupported: false };
}

const failing = (report: DoctorReport): DoctorCheck[] => report.checks.filter((check) => check.status === "fail");

/**
 * Record a diagnosis — unless the record's last entry is the same diagnosis.
 * The page diagnoses on every visit, and a history of identical re-checks
 * would push the repairs, which are what an operator reads it for, out of it.
 */
function recordDiagnosis(root: string, report: DoctorReport, via: DoctorEntry["via"], now: Date): void {
  const failed = failing(report);
  const checks = report.checks.map((check) => ({ id: check.id, status: check.status }));
  const last = readDoctorHistory(root).at(-1);
  if (
    last?.kind === "diagnosis" &&
    last.plugin === report.plugin &&
    last.run === loopIdentity(root).run &&
    JSON.stringify(last.checks) === JSON.stringify(checks)
  ) {
    return;
  }
  record(
    root,
    {
      plugin: report.plugin,
      run: loopIdentity(root).run,
      kind: "diagnosis",
      via,
      check: null,
      action: null,
      result: failed.length === 0 ? "healthy" : "failing",
      why: failed.map((check) => `${check.label}: ${check.detail}`).join("; "),
      checks,
    },
    now,
  );
}

function recordStep(root: string, plugin: string, step: DoctorStep, via: "operator" | "fix-all", now: Date): void {
  record(
    root,
    { plugin, run: loopIdentity(root).run, kind: "repair", via, check: step.check, action: step.action, result: step.result, why: step.why },
    now,
  );
}

/** Diagnose one plugin, and record what was found. */
export function diagnose(root: string, plugin: string, options: DoctorOptions = {}): PluginDiagnosis {
  const env = options.env ?? process.env;
  const asked = ask(root, plugin, { mode: "diagnose" }, env);
  if (asked.report === null || !asked.ok) {
    return { plugin, supported: !asked.unsupported, why: asked.why, report: null };
  }
  recordDiagnosis(root, asked.report, "operator", (options.now ?? (() => new Date()))());
  return { plugin, supported: true, why: null, report: asked.report };
}

/**
 * Turn the plugin off for the project: its name out of `.ralph/config.json`'s
 * `plugins`. A loop already running keeps what it started with — its plugin
 * list is resolved once, at start — so the answer says so.
 */
function disablePlugin(root: string, plugin: string): DoctorStep {
  const path = join(root, CONFIG_RELATIVE_PATH);
  const step = (result: StepResult, why: string): DoctorStep => ({ check: "", action: DISABLE_REPAIR, result, why });
  let raw: Record<string, unknown>;
  try {
    const contents = readFileSync(path, "utf8");
    parseProjectConfig(contents, path);
    raw = JSON.parse(contents) as Record<string, unknown>;
  } catch (error) {
    return step("failed", `could not read ${CONFIG_RELATIVE_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const listed = Array.isArray(raw.plugins) ? (raw.plugins as string[]) : [];
  if (!listed.includes(plugin)) {
    return step("not-repairable", `'${plugin}' is not in ${CONFIG_RELATIVE_PATH}'s plugins; it is enabled by RALPH_PLUGINS for a run, and is turned off there`);
  }
  const rest = listed.filter((name) => name !== plugin);
  const { plugins: _plugins, ...others } = raw;
  try {
    writeJsonAtomically(path, rest.length === 0 ? others : { ...others, plugins: rest });
  } catch (error) {
    return step("failed", `could not write ${CONFIG_RELATIVE_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return step(
    "repaired",
    `removed '${plugin}' from ${CONFIG_RELATIVE_PATH}; a loop already running keeps it until it restarts, and the change is the project's to commit`,
  );
}

export interface RepairResult {
  report: DoctorReport | null;
  step: DoctorStep;
}

/**
 * Apply one repair to one failed check, as offered by a fresh diagnosis.
 *
 * `pre` is that diagnosis when the caller already has it (Fix all does). The
 * step is recorded whatever it came to, and a repair that worked also ends
 * the host's back-off window, so the plugin is offered the loop's next event
 * rather than sitting out a window its failure opened.
 */
export function repair(
  root: string,
  plugin: string,
  checkId: string,
  action: string,
  options: DoctorOptions & { via?: "operator" | "fix-all"; pre?: DoctorReport } = {},
): RepairResult {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const via = options.via ?? "operator";
  const done = (report: DoctorReport | null, step: DoctorStep): RepairResult => {
    recordStep(root, plugin, step, via, now());
    if (step.result === "repaired") endBackoff(root, plugin);
    if (report !== null && via === "operator") recordDiagnosis(root, report, via, now());
    return { report, step };
  };
  const refuse = (report: DoctorReport | null, why: string): RepairResult =>
    done(report, { check: checkId, action, result: "not-repairable", why });

  let pre = options.pre ?? null;
  if (pre === null) {
    const asked = ask(root, plugin, { mode: "diagnose" }, env);
    if (asked.report === null) return refuse(null, `the plugin could not be diagnosed: ${asked.why}`);
    pre = asked.report;
  }
  const check = pre.checks.find((row) => row.id === checkId);
  if (check === undefined) return refuse(pre, `the plugin has no '${checkId}' check`);
  if (check.status !== "fail") return refuse(pre, `${check.label} is not failing (${check.status}), so there is nothing to repair`);
  if (!check.repairs.some((row) => row.id === action)) {
    const offered = check.repairs.map((row) => row.id).join(", ") || "none";
    return refuse(pre, `'${action}' is not a repair ${check.label} offers now (offered: ${offered})`);
  }

  if (action === DISABLE_REPAIR) {
    return done(pre, { ...disablePlugin(root, plugin), check: checkId });
  }
  const asked = ask(root, plugin, { mode: "repair", check: checkId, repair: action }, env);
  const step = asked.step ?? {
    check: checkId,
    action,
    result: "failed" as const,
    why: asked.ok ? "the plugin's doctor did not say what the repair came to" : asked.why,
  };
  return done(asked.report, { ...step, check: checkId, action });
}

export interface FixAllResult {
  report: DoctorReport | null;
  steps: DoctorStep[];
  stopped: string | null;
}

/**
 * Walk the checks in order, repairing each failure with its default repair,
 * and stop at the first that cannot be repaired — saying why.
 */
export function fixAll(root: string, plugin: string, options: DoctorOptions = {}): FixAllResult {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const steps: DoctorStep[] = [];
  const finish = (report: DoctorReport | null, stopped: string | null): FixAllResult => {
    if (report !== null) recordDiagnosis(root, report, "fix-all", now());
    record(
      root,
      {
        plugin,
        run: loopIdentity(root).run,
        kind: "fix-all",
        via: "operator",
        check: null,
        action: null,
        result: stopped === null ? "healthy" : "stopped",
        why: stopped ?? `${steps.length} repair(s) applied; every check passes`,
      },
      now(),
    );
    return { report, steps, stopped };
  };

  const asked = ask(root, plugin, { mode: "diagnose" }, env);
  if (asked.report === null) return finish(null, `the plugin could not be diagnosed: ${asked.why}`);
  let report = asked.report;
  // Each check is repaired at most once: a repair that did not clear its
  // check is a stop, so the walk ends in at most one pass.
  for (let guard = 0; guard <= report.checks.length; guard += 1) {
    const check = failing(report)[0];
    if (check === undefined) return finish(report, null);
    const chosen = check.repairs.find((row) => row.default);
    if (chosen === undefined) {
      const offered = check.repairs.map((row) => row.label);
      return finish(
        report,
        `${check.label} failed: ${check.detail} — no repair applies automatically${offered.length === 0 ? "" : `; offered: ${offered.join(", ")}`}`,
      );
    }
    const repaired = repair(root, plugin, check.id, chosen.id, { env, now, via: "fix-all", pre: report });
    steps.push(repaired.step);
    if (repaired.step.result !== "repaired") {
      return finish(repaired.report ?? report, `${check.label}: ${chosen.label} ${repaired.step.result} — ${repaired.step.why}`);
    }
    if (repaired.report === null) return finish(null, `${check.label}: the plugin answered the repair without a diagnosis`);
    report = repaired.report;
    const again = report.checks.find((row) => row.id === check.id);
    if (again?.status === "fail") {
      return finish(report, `${check.label} still fails after ${chosen.label}: ${again.detail}`);
    }
  }
  return finish(report, "the checks did not settle; stopped rather than repair in a circle");
}

/* --------------------------------------------------------------------------
 * CLI.
 * ----------------------------------------------------------------------- */

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

export function runDoctor(root: string, argv: string[], env: Env = process.env): DoctorOutput {
  const enabled = enabledPlugins(root, env).names;
  const named = flag(argv, "plugin");
  const targets = named === undefined ? enabled : enabled.filter((name) => name === named);
  const output: DoctorOutput = {
    version: 1,
    loop: loopIdentity(root, env),
    enabled,
    plugins: [],
    steps: [],
    stopped: null,
    history: [],
  };
  const repairArg = flag(argv, "repair");
  const wantsFix = argv.includes("--fix-all");
  if ((repairArg !== undefined || wantsFix) && named !== undefined && targets.length === 1) {
    const plugin = targets[0]!;
    if (wantsFix) {
      const fixed = fixAll(root, plugin, { env });
      output.plugins.push({ plugin, supported: true, why: fixed.report === null ? fixed.stopped : null, report: fixed.report });
      output.steps = fixed.steps;
      output.stopped = fixed.stopped;
    } else {
      const [check = "", action = ""] = repairArg!.split(":");
      const repaired = repair(root, plugin, check, action, { env });
      output.plugins.push({ plugin, supported: true, why: null, report: repaired.report });
      output.steps = [repaired.step];
    }
  } else if (repairArg !== undefined || wantsFix) {
    output.stopped =
      named === undefined
        ? "a repair names its plugin with --plugin"
        : `plugin '${named}' is not enabled for this project`;
  } else {
    for (const plugin of targets) output.plugins.push(diagnose(root, plugin, { env }));
  }
  output.history = readDoctorHistory(root);
  return output;
}

if (import.meta.main) {
  const root = process.env.RALPH_STATE_ROOT ?? projectRoot();
  let output: unknown;
  try {
    output = runDoctor(root, process.argv.slice(2));
  } catch (error) {
    output = { version: 1, error: error instanceof Error ? error.message : String(error) };
  }
  console.log(JSON.stringify(output, null, 2));
}
