#!/usr/bin/env bun
/**
 * The plugin host: the one place the loop hands anything to a plugin.
 *
 * The loop is complete without plugins. It records its own state, reads its
 * own control inbox and keeps its own notification record; a plugin is
 * something that wants to hear about those, or to add commands to the inbox.
 * Three hooks carry all of it:
 *
 *   on-event  every event the loop recorded durably (and a periodic `pulse`
 *             while an iteration holds a turn open), handed over as JSON.
 *   inbox     asked at every control checkpoint, before the inbox is read, so
 *             a plugin can deliver operator commands into it as files. The
 *             commands then go through the same apply-once and run fences as
 *             any other, because the core cannot tell who wrote a file.
 *   notify    an alert the loop raised, after the loop has recorded it.
 *
 * A plugin is a directory, `plugins/<name>/plugin.ts`, run as a subprocess:
 * `bun plugins/<name>/plugin.ts <hook>` with the payload on stdin. Nothing in
 * the core imports plugin code, so the core cannot come to depend on one.
 *
 * The host enforces what a plugin may do to a loop, for every plugin, so no
 * plugin has to be trusted to hold up its end:
 *
 * - **Bounded time.** A hook is killed after `RALPH_PLUGIN_TIMEOUT_SECONDS`
 *   (60 by default), and a plugin that timed out — or failed after taking
 *   `RALPH_PLUGIN_SLOW_SECONDS` (10) or more — is not offered anything else
 *   for `RALPH_PLUGIN_RETRY_SECONDS` (60), so one that hangs costs one timeout
 *   per window rather than one per event. The loop's ending and settled
 *   control commands are still offered inside the window: there is no later
 *   event to recover either into.
 * - **Output discarded.** A hook answers with one JSON line on stdout,
 *   `{"ok":true}` or `{"ok":false,"why":"…"}`; the host reads that and throws
 *   the rest away. Nothing a plugin prints reaches the loop's log.
 * - **Failures are the plugin's health, never the loop's.** A crash, a
 *   timeout, garbage, or a plugin's own `ok:false` is written to
 *   `.ralph/logs/plugins.json` under that plugin's name. The host never throws
 *   and its CLI always exits 0, so no failure path can hold, stop or fail a
 *   loop.
 *
 * A plugin runs as the loop's own user with the loop's own environment, so it
 * cannot gain a permission the loop does not have. What it may do with those
 * permissions is the plugin's own allowlist to hold.
 *
 * Which plugins are enabled: `RALPH_PLUGINS` for this run when it is set (an
 * empty value means none), otherwise the project's `plugins` list in
 * `.ralph/config.json`, otherwise none. Off by default.
 *
 * Usage:
 *   plugins.ts event --event <name> [the flags `loop-state.ts record` takes]
 *   plugins.ts pulse [--watch]
 *   plugins.ts enabled
 *   plugins.ts status [--line | --json]
 *
 * `status` prints one health line, then each enabled plugin's own panel lines
 * (`plugin.ts status`) indented beneath it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { currentLoop } from "./frontier/next-tasks";
import { STAGES, STOP_KINDS, writeJsonAtomically, type Stage, type StopKind } from "./loop-state";
import { RALPH_HOME, projectRoot } from "./paths";
import { PLUGIN_NAME, loadProjectConfig } from "./project-config";

type Env = Record<string, string | undefined>;

export const PLUGIN_HOOKS = ["on-event", "inbox", "notify"] as const;
export type PluginHook = (typeof PLUGIN_HOOKS)[number];

/** Where the host records how each plugin is doing. Beside the loop's records. */
export const PLUGIN_HEALTH_RELATIVE_PATH = ".ralph/logs/plugins.json";

const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_RETRY_SECONDS = 60;
const DEFAULT_PULSE_SECONDS = 30;
/** A failed answer that took at least this long is backed off from like a timeout. */
const DEFAULT_SLOW_SECONDS = 10;

const seconds = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** The directory plugins are installed in. Overridable for tests. */
export const pluginsDir = (env: Env = process.env): string =>
  env.RALPH_PLUGINS_DIR?.trim() || join(RALPH_HOME, "plugins");

/** The installed plugins: every well-named directory holding a `plugin.ts`. */
export function availablePlugins(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => PLUGIN_NAME.test(name) && existsSync(join(dir, name, "plugin.ts")))
      .sort();
  } catch {
    return [];
  }
}

/** A list as an operator types one: commas or spaces, `none` for nothing. */
export function parsePluginList(raw: string): string[] {
  const names = raw
    .split(/[\s,]+/)
    .map((name) => name.trim())
    .filter((name) => name !== "" && name !== "none");
  return [...new Set(names)];
}

export interface EnabledPlugins {
  /** Installed and enabled, in the order they were named. */
  names: string[];
  /** Enabled but not installed. Reported, never run. */
  unknown: string[];
  /** Where the list came from. */
  source: "run" | "project" | "default";
}

export function enabledPlugins(root: string, env: Env = process.env): EnabledPlugins {
  let requested: string[];
  let source: EnabledPlugins["source"];
  if (env.RALPH_PLUGINS !== undefined) {
    requested = parsePluginList(env.RALPH_PLUGINS);
    source = "run";
  } else {
    try {
      requested = loadProjectConfig(root).plugins ?? [];
      source = requested.length > 0 ? "project" : "default";
    } catch {
      // No config, or a broken one: the loop refuses to start on that itself,
      // and a display reading it must not be the thing that throws.
      requested = [];
      source = "default";
    }
  }
  const installed = new Set(availablePlugins(pluginsDir(env)));
  return {
    names: requested.filter((name) => installed.has(name)),
    unknown: requested.filter((name) => !installed.has(name)),
    source,
  };
}

/* --------------------------------------------------------------------------
 * Health.
 * ----------------------------------------------------------------------- */

export interface HookHealth {
  ok: boolean;
  why: string | null;
  at: string;
}

export interface PluginDegraded {
  hook: string;
  why: string;
  at: string;
  /** Set only after a timeout: the host does not offer this plugin anything before it. */
  retryAt: string | null;
}

export interface PluginHealth {
  hooks: Partial<Record<PluginHook, HookHealth>>;
  degraded: PluginDegraded | null;
}

export interface PluginHealthRecord {
  version: 1;
  plugins: Record<string, PluginHealth>;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Read the health record back, treating every unusable file as none. */
export function parsePluginHealth(raw: string): PluginHealthRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.plugins)) return null;
  const plugins: Record<string, PluginHealth> = {};
  for (const [name, row] of Object.entries(value.plugins)) {
    if (!isRecord(row)) continue;
    const hooks: PluginHealth["hooks"] = {};
    if (isRecord(row.hooks)) {
      for (const hook of PLUGIN_HOOKS) {
        const entry = row.hooks[hook];
        if (isRecord(entry) && typeof entry.ok === "boolean") {
          hooks[hook] = { ok: entry.ok, why: text(entry.why), at: text(entry.at) ?? "" };
        }
      }
    }
    const degraded = isRecord(row.degraded) && text(row.degraded.why) !== null
      ? {
          hook: text(row.degraded.hook) ?? "",
          why: text(row.degraded.why)!,
          at: text(row.degraded.at) ?? "",
          retryAt: text(row.degraded.retryAt),
        }
      : null;
    plugins[name] = { hooks, degraded };
  }
  return { version: 1, plugins };
}

export function readHealth(root: string): PluginHealthRecord {
  const path = join(root, PLUGIN_HEALTH_RELATIVE_PATH);
  try {
    return parsePluginHealth(readFileSync(path, "utf8")) ?? { version: 1, plugins: {} };
  } catch {
    return { version: 1, plugins: {} };
  }
}

/**
 * Record one hook's answer. Read-modify-write, and deliberately unlocked: two
 * writers racing (the pulse watcher beside a foreground event) can lose one
 * health line, which the next answer rewrites. A lock here would be one more
 * thing a plugin failure could hold a loop on.
 */
function recordHealth(root: string, plugin: string, hook: PluginHook, answer: Answer, nowIso: string, env: Env): void {
  try {
    const record = readHealth(root);
    const previous = record.plugins[plugin] ?? { hooks: {}, degraded: null };
    const hooks = { ...previous.hooks, [hook]: { ok: answer.ok, why: answer.ok ? null : answer.why, at: nowIso } };
    const degraded: PluginDegraded | null = answer.ok
      ? null
      : {
          hook,
          why: answer.why,
          at: nowIso,
          retryAt: answer.slow
            ? new Date(Date.parse(nowIso) + seconds(env.RALPH_PLUGIN_RETRY_SECONDS, DEFAULT_RETRY_SECONDS) * 1000).toISOString()
            : null,
        };
    record.plugins[plugin] = { hooks, degraded };
    writeJsonAtomically(join(root, PLUGIN_HEALTH_RELATIVE_PATH), record);
  } catch {
    // Health that cannot be written is a missing line on a panel, never a
    // failed loop.
  }
}

/**
 * End the host's back-off window for one plugin, so its next hook runs.
 *
 * The degraded reason is kept: nothing has shown the plugin well yet, and its
 * next answer rewrites the line either way. Only the doctor calls this, after
 * a repair it recorded, since a repair is new evidence the window predates.
 */
export function endBackoff(root: string, plugin: string): boolean {
  try {
    const record = readHealth(root);
    const degraded = record.plugins[plugin]?.degraded ?? null;
    if (degraded?.retryAt == null) return false;
    record.plugins[plugin] = { ...record.plugins[plugin]!, degraded: { ...degraded, retryAt: null } };
    writeJsonAtomically(join(root, PLUGIN_HEALTH_RELATIVE_PATH), record);
    return true;
  } catch {
    return false;
  }
}

/** One line for a panel: which plugins are on, and whether each is well. */
export function healthLine(record: PluginHealthRecord | null, enabled: string[], unknown: string[] = []): string {
  if (enabled.length === 0 && unknown.length === 0) return "Plugins: none enabled";
  const parts = enabled.map((name) => {
    const degraded = record?.plugins[name]?.degraded ?? null;
    if (degraded === null) return `${name} ok`;
    const retry = degraded.retryAt === null ? "" : ` (backing off until ${degraded.retryAt})`;
    return `${name} degraded (${degraded.hook}) — ${degraded.why}${retry}`;
  });
  for (const name of unknown) parts.push(`${name} not installed`);
  return `Plugins: ${parts.join("; ")}`;
}

/* --------------------------------------------------------------------------
 * Running a hook.
 * ----------------------------------------------------------------------- */

interface Answer {
  ok: boolean;
  why: string;
  /** It cost the caller its timeout; back off from it. */
  slow: boolean;
}

/** The last line of stdout that is a hook answer, or null. */
function answerFrom(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const last = lines[lines.length - 1];
  if (last === undefined) return null;
  try {
    const value: unknown = JSON.parse(last);
    return isRecord(value) && typeof value.ok === "boolean" ? value : null;
  } catch {
    return null;
  }
}

/** The Bun that runs a plugin: this one, when the host itself runs under Bun. */
const bun = (): string => ("bun" in process.versions ? process.execPath : "bun");

/** A plugin's answer, and the whole JSON line it answered with when it was one. */
export interface PluginRun extends Answer {
  value: Record<string, unknown> | null;
}

/**
 * Run `plugin.ts <command>` with `payload` on stdin, bounded by `timeoutMs`.
 *
 * The one place a plugin subprocess is spawned for anything that answers: the
 * three hooks, and the doctor (`plugin-doctor.ts`). stderr is discarded at the
 * source and stdout is read for the answer line only.
 */
export function runPlugin(
  root: string,
  plugin: string,
  command: string,
  payload: unknown,
  env: Env,
  timeoutMs: number,
): PluginRun {
  const entry = join(pluginsDir(env), plugin, "plugin.ts");
  const started = Date.now();
  // A failure that cost the caller real time is backed off from, whatever
  // shape it took: a plugin that fails after 59s would otherwise cost 59s on
  // every event without ever timing out.
  const slowed = (): boolean =>
    Date.now() - started >= seconds(env.RALPH_PLUGIN_SLOW_SECONDS, DEFAULT_SLOW_SECONDS) * 1000;
  const ran = spawnSync(bun(), [entry, command], {
    cwd: root,
    env: { ...env, RALPH_STATE_ROOT: root },
    input: JSON.stringify({ hook: command, ...(isRecord(payload) ? payload : { payload }) }),
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 256 * 1024,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const error = ran.error as NodeJS.ErrnoException | undefined;
  if (error?.code === "ETIMEDOUT" || (ran.signal !== null && ran.status === null && error === undefined)) {
    return { ok: false, why: `${command} timed out after ${timeoutMs / 1000}s`, slow: true, value: null };
  }
  if (error !== undefined) {
    return { ok: false, why: `${command} could not run (${error.code ?? error.message})`, slow: false, value: null };
  }
  if (ran.status !== 0) {
    return { ok: false, why: `${command} exited ${String(ran.status ?? ran.signal)}`, slow: slowed(), value: null };
  }
  const value = answerFrom(ran.stdout ?? "");
  if (value === null) {
    return { ok: false, why: `${command} answered with something that is not a hook answer`, slow: slowed(), value: null };
  }
  return value.ok === true
    ? { ok: true, why: "", slow: false, value }
    : { ok: false, why: text(value.why) ?? `${command} reported a problem without a reason`, slow: slowed(), value };
}

function runHook(root: string, plugin: string, hook: PluginHook, payload: unknown, env: Env): Answer {
  const timeoutMs = seconds(env.RALPH_PLUGIN_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS) * 1000;
  const { ok, why, slow } = runPlugin(root, plugin, hook, payload, env, timeoutMs);
  return { ok, why, slow };
}

export interface HookResult {
  plugin: string;
  /** Whether the plugin was run at all (not while backing off, not when missing). */
  ran: boolean;
  ok: boolean;
  why: string | null;
}

export interface OfferOptions {
  env?: Env;
  /** The loop's ending: offered even to a plugin the host is backing off from. */
  urgent?: boolean;
}

/**
 * Offer one hook to every enabled plugin, in order, and record how each did.
 *
 * Never throws. With no plugin enabled it returns at once, having made no
 * subprocess and written nothing.
 */
export function offer(root: string, hook: PluginHook, payload: unknown, options: OfferOptions = {}): HookResult[] {
  const env = options.env ?? process.env;
  let enabled: EnabledPlugins;
  try {
    enabled = enabledPlugins(root, env);
  } catch {
    return [];
  }
  const results: HookResult[] = [];
  const nowIso = (): string => new Date().toISOString();
  for (const plugin of enabled.unknown) {
    const why = `plugin '${plugin}' is enabled but not installed in ${pluginsDir(env)}`;
    recordHealth(root, plugin, hook, { ok: false, why, slow: false }, nowIso(), env);
    results.push({ plugin, ran: false, ok: false, why });
  }
  for (const plugin of enabled.names) {
    try {
      const degraded = readHealth(root).plugins[plugin]?.degraded ?? null;
      if (
        !options.urgent &&
        degraded?.retryAt != null &&
        Date.parse(degraded.retryAt) > Date.now()
      ) {
        results.push({ plugin, ran: false, ok: false, why: `backing off until ${degraded.retryAt}: ${degraded.why}` });
        continue;
      }
      const answer = runHook(root, plugin, hook, payload, env);
      recordHealth(root, plugin, hook, answer, nowIso(), env);
      results.push({ plugin, ran: true, ok: answer.ok, why: answer.ok ? null : answer.why });
    } catch (error) {
      results.push({ plugin, ran: false, ok: false, why: error instanceof Error ? error.message : String(error) });
    }
  }
  // Unknown plugins come first, then installed ones in the order enabled.
  return results;
}

/* --------------------------------------------------------------------------
 * Events.
 * ----------------------------------------------------------------------- */

/**
 * One event, as every plugin receives it.
 *
 * The recorded fields are exactly the ones `loop-state.ts record` takes, so a
 * plugin sees what the durable record saw. `control` is set on the events the
 * control channel emits for each command it settles.
 */
export interface PluginEvent {
  name: string;
  at: string;
  run: string;
  loop: string;
  session: string | null;
  /** The supervisor's pid, when a supervisor emitted the event. */
  pid: number | null;
  stage?: Stage;
  iteration?: number;
  max?: number | null;
  stop?: StopKind;
  why?: string;
  detail?: string;
  control?: Record<string, unknown>;
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

const integer = (raw: string | undefined): number | undefined =>
  raw !== undefined && Number.isInteger(Number(raw)) ? Number(raw) : undefined;

/**
 * Build an event from `record` flags, or refuse it.
 *
 * Refused exactly where `loop-state.ts record` refuses it: an event the
 * durable record did not take is not an event that was recorded durably, and
 * a plugin must not be told about one the loop's own record does not have.
 */
export function eventFromFlags(argv: string[], env: Env, loop: string): PluginEvent | null {
  const name = flag(argv, "event");
  if (name === undefined || name.trim() === "") return null;
  const stage = flag(argv, "stage");
  const stop = flag(argv, "stop");
  if (stage !== undefined && !(STAGES as readonly string[]).includes(stage)) return null;
  if (stop !== undefined && !(STOP_KINDS as readonly string[]).includes(stop)) return null;
  const iteration = integer(flag(argv, "iteration"));
  const why = flag(argv, "why");
  const detail = flag(argv, "detail");
  const pid = integer(env.RALPH_SUPERVISOR_PID);
  return {
    name,
    at: new Date().toISOString(),
    run: env.RALPH_RUN_ID?.trim() || "adhoc",
    loop,
    session: env.RALPH_SESSION_ID?.trim() || null,
    pid: pid !== undefined && pid > 0 ? pid : null,
    ...(stage !== undefined ? { stage: stage as Stage } : {}),
    ...(iteration !== undefined ? { iteration } : {}),
    ...(iteration !== undefined || flag(argv, "max") !== undefined ? { max: integer(flag(argv, "max")) ?? null } : {}),
    ...(stop !== undefined ? { stop: stop as StopKind } : {}),
    ...(why !== undefined ? { why } : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
}

/** A base event for a caller that is not relaying `record` flags. */
export function baseEvent(root: string, name: string, env: Env = process.env): PluginEvent {
  const pid = integer(env.RALPH_SUPERVISOR_PID);
  return {
    name,
    at: new Date().toISOString(),
    run: env.RALPH_RUN_ID?.trim() || "adhoc",
    loop: loopName(root, env),
    session: env.RALPH_SESSION_ID?.trim() || null,
    pid: pid !== undefined && pid > 0 ? pid : null,
  };
}

/**
 * Offer events to `on-event`. Urgent when any of them is the loop's ending or
 * a settled control command: neither is offered again, so a plugin answering
 * for one (fencing a stop, acknowledging where it was issued) would lose it
 * for good to a back-off window.
 */
export function offerEvents(root: string, events: PluginEvent[], env: Env = process.env): HookResult[] {
  if (events.length === 0) return [];
  const urgent = events.some((event) => event.stop !== undefined || event.control !== undefined);
  return offer(root, "on-event", { events }, { env, urgent });
}

function loopName(root: string, env: Env): string {
  try {
    return currentLoop(env, join(root, ".ralph/loop-name"));
  } catch {
    return env.RALPH_LOOP_NAME?.trim() || "ralph";
  }
}

/* --------------------------------------------------------------------------
 * CLI.
 * ----------------------------------------------------------------------- */

function supervisorAlive(env: Env): boolean {
  const pid = Number(env.RALPH_SUPERVISOR_PID);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The pulse: an `on-event` of kind `pulse` on a timer.
 *
 * `record` only fires at the boundaries around a runner's turn, and that turn
 * holds for tens of minutes; a plugin showing liveness needs something that
 * moves in between. Ends at once when nothing is enabled, and on the first
 * pulse after its supervisor is gone, so it never reports a dead loop as
 * working.
 */
function runPulse(root: string, argv: string[]): void {
  if (enabledPlugins(root).names.length === 0) return;
  if (!supervisorAlive(process.env)) return;
  const pulse = (): void => {
    offerEvents(root, [baseEvent(root, "pulse")]);
  };
  pulse();
  if (!argv.includes("--watch")) return;
  const every = seconds(process.env.RALPH_PLUGIN_PULSE_SECONDS, DEFAULT_PULSE_SECONDS) * 1000;
  setInterval(() => {
    if (!supervisorAlive(process.env)) process.exit(0);
    try {
      pulse();
    } catch {
      // A missed pulse, never a dead watcher.
    }
  }, every);
}

/**
 * A plugin's own panel lines: `plugin.ts status`, bounded like a hook.
 *
 * Shown rather than discarded, because this is a display an operator asked
 * for and not a hook a loop waits on. Indented under the health line, and
 * dropped whole if the plugin cannot produce them in time.
 */
function pluginPanel(root: string, plugin: string, env: Env): string[] {
  const ran = spawnSync(bun(), [join(pluginsDir(env), plugin, "plugin.ts"), "status"], {
    cwd: root,
    env: { ...env, RALPH_STATE_ROOT: root },
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (ran.status !== 0) return [];
  return (ran.stdout ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(0, 8)
    .map((line) => `  ${line}`);
}

function runStatus(root: string, argv: string[]): void {
  const enabled = enabledPlugins(root);
  const record = readHealth(root);
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ enabled, health: record }, null, 2));
    return;
  }
  console.log(healthLine(record, enabled.names, enabled.unknown));
  for (const name of enabled.names) {
    for (const line of pluginPanel(root, name, process.env)) console.log(line);
  }
  if (argv.includes("--line")) return;
  for (const name of enabled.names) {
    for (const [hook, entry] of Object.entries(record.plugins[name]?.hooks ?? {})) {
      console.log(`  ${name} ${hook}: ${entry.ok ? "ok" : `failed — ${entry.why ?? "no reason"}`} at ${entry.at}`);
    }
  }
}

function main(): void {
  const root = process.env.RALPH_STATE_ROOT ?? projectRoot();
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command === "event") {
    const event = eventFromFlags(argv.slice(1), process.env, loopName(root, process.env));
    if (event !== null) offerEvents(root, [event]);
  } else if (command === "pulse") {
    runPulse(root, argv.slice(1));
  } else if (command === "enabled") {
    console.log(enabledPlugins(root).names.join(" "));
  } else if (command === "status" || command === undefined) {
    runStatus(root, argv.slice(1));
  }
}

if (import.meta.main) {
  try {
    main();
  } catch {
    // Never fatal and never noisy: the host is called with its output
    // discarded, and a host that could fail a loop would defeat its purpose.
  }
}
