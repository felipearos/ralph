/**
 * The Orca plugin's doctor: which part of the plugin is broken, and the repair
 * that fits it.
 *
 * Run by `ralph/plugin-doctor.ts` as `plugin.ts doctor`, never by the loop. It
 * answers five checks, in order, because each one is only worth asking once
 * the one before it holds:
 *
 *   cli       an `orca` to run at all. Nothing here can install one, so the
 *             only offer is the host's: turn the plugin off for the project.
 *   runtime   `orca status` says the runtime is reachable. Repaired by starting
 *             it — headless with `orca serve` by default, or the app with
 *             `orca open`.
 *   run       the mirror registered this loop's run as an Orca Run. Repaired by
 *             registering it from the loop's own record, the same Run the
 *             mirror would have created (`objectiveFor`), from the loop's own
 *             terminal when it has one, else from one this plugin opens.
 *   consumer  a terminal bound to that Run reads its mailbox, which is the
 *             only way a command sent from Orca reaches the loop. Repaired by
 *             rebinding the Run to the loop's terminal, or — when the loop was
 *             not started from an Orca terminal, or its terminal now belongs
 *             to another Run — to a terminal this plugin opens for it.
 *   backoff   the mirror, the command route and the host are not sitting out a
 *             back-off window. Repaired by ending the windows and reading the
 *             mailbox once, now.
 *
 * `DOCTOR_VERBS` is everything it may ask of Orca. It adds the three startup
 * verbs and `terminal create` to what the mirror already runs, refuses
 * `--command` so an opened terminal is only ever an idle shell, and — like
 * every other roster in this plugin — has no `worker-start`, no
 * `dispatch --inject` and no `terminal send`.
 *
 * Nothing here touches the loop's own records: its state, its control record,
 * its locks or its process. A repair writes only this plugin's records (the
 * mirror's, the binding's, the command route's), and the command route's
 * inbox delivery, which is exactly what the `inbox` hook itself does.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { DISABLE_REPAIR, type DoctorCheck, type DoctorRepair, type DoctorStep, type LoopIdentity } from "../../plugin-doctor";
import { reconcileOrcaConsumerBinding, resolveOrcaConsumer, type AdapterBindingIdentity } from "./binding";
import { invokeOrca, orcaCli, type Called } from "./cli";
import {
  ORCA_STATE_RELATIVE_PATH,
  blank,
  idFrom,
  objectiveFor,
  parseAdapterState,
  textFrom,
  writeAdapterState,
  type AdapterState,
} from "./lifecycle";
import { deliver, readMailboxState, writeMailboxState } from "./mailbox";

export const DOCTOR_VERBS = [
  "status",
  "serve",
  "open",
  "orchestration run-current",
  "orchestration run-use",
  "orchestration run-create",
  "terminal create",
] as const;
export type DoctorVerb = (typeof DOCTOR_VERBS)[number];

/** `--command` would make an opened terminal run something; it stays a shell. */
export const DOCTOR_FORBIDDEN_ARGS = ["--inject", "--command"] as const;

/** What the doctor may run. Injected so the checks can be tested verb by verb. */
export type DoctorCall = (verb: DoctorVerb, args: string[], timeoutMs?: number) => Called;

export const callOrcaForDoctor: DoctorCall = (verb, args, timeoutMs) =>
  invokeOrca(verb, args, DOCTOR_VERBS, "orca-doctor", DOCTOR_FORBIDDEN_ARGS, timeoutMs);

/**
 * `orca serve` runs in the foreground until stopped, so it is launched on its
 * own session with nothing attached, and outlives this process. Checked
 * against the roster like every other verb.
 */
export type Launch = (verb: DoctorVerb) => void;

export const launchDetached: Launch = (verb) => {
  if (!(DOCTOR_VERBS as readonly string[]).includes(verb)) throw new Error(`orca-doctor may not run '${verb}'`);
  const child = spawn(orcaCli(), verb.split(" "), { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
};

export interface Context {
  root: string;
  loop: LoopIdentity;
  /** The plugin host's own back-off for this plugin, which only it can see. */
  host: { why: string; retryAt: string | null } | null;
  now: () => number;
  call: DoctorCall;
  launch: Launch;
  /** How long a started runtime is waited for. */
  startTimeoutMs: number;
  sleep: (ms: number) => void;
}

/** The host's shapes, narrowed to what this plugin answers with. */
type Repair = DoctorRepair;
export interface Check extends DoctorCheck {
  id: "cli" | "runtime" | "run" | "consumer" | "backoff";
}
export interface Step extends DoctorStep {
  action: string;
}

const LABELS: Record<Check["id"], string> = {
  cli: "Orca CLI present",
  runtime: "Orca runtime reachable",
  run: "Run registered",
  consumer: "Consumer bound",
  backoff: "Back-off window",
};

/** The host's, carried out by it: named here only so the check can offer it. */
const DISABLE: Repair = { id: DISABLE_REPAIR, label: "Disable the Orca plugin for this project", default: false };

const pass = (id: Check["id"], detail: string): Check => ({ id, label: LABELS[id], status: "pass", detail, repairs: [] });
const fail = (id: Check["id"], detail: string, repairs: Repair[]): Check => ({ id, label: LABELS[id], status: "fail", detail, repairs });
const skip = (id: Check["id"], detail: string): Check => ({ id, label: LABELS[id], status: "skipped", detail, repairs: [] });

const readAdapter = (root: string): AdapterState | null => {
  const path = join(root, ORCA_STATE_RELATIVE_PATH);
  if (!existsSync(path)) return null;
  try {
    return parseAdapterState(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

/** The mirror's record, only when it is this loop's: this run, this worktree. */
const ownAdapter = (ctx: Context): AdapterState | null => {
  const adapter = readAdapter(ctx.root);
  return adapter !== null && adapter.ralphRun === ctx.loop.run && resolve(adapter.worktree) === resolve(ctx.root)
    ? adapter
    : null;
};

const boundRunOf = (called: Called): string | null => idFrom(called.result, "run");

/* --------------------------------------------------------------------------
 * The checks.
 * ----------------------------------------------------------------------- */

interface Found {
  checks: Check[];
  adapter: AdapterState | null;
  /** The terminal the consumer check found reading the Run, if any. */
  consumer: string | null;
}

export function diagnose(ctx: Context): Found {
  const checks: Check[] = [];
  const found = (): Found => ({ checks, adapter: ownAdapter(ctx), consumer });
  let consumer: string | null = null;
  const rest = (from: Check["id"], why: string): Found => {
    const order: Check["id"][] = ["cli", "runtime", "run", "consumer"];
    for (const id of order.slice(order.indexOf(from))) checks.push(skip(id, why));
    checks.push(backoff(ctx, why));
    return found();
  };

  // --- cli, runtime: one `status` answers both ---------------------------
  const status = ctx.call("status", []);
  if (status.kind === "missing-cli" || status.kind === "unlaunchable") {
    checks.push(
      fail(
        "cli",
        status.kind === "missing-cli"
          ? `No Orca CLI on PATH (looked for '${orcaCli()}'). Install Orca, or turn the plugin off for this project.`
          : `The Orca CLI is there but will not run: ${status.why}.`,
        [DISABLE],
      ),
    );
    return rest("runtime", "Needs the Orca CLI.");
  }
  checks.push(pass("cli", `'${orcaCli()}' runs.`));

  const runtime = status.ok && typeof status.result?.runtime === "object" && status.result.runtime !== null
    ? (status.result.runtime as Record<string, unknown>)
    : null;
  if (runtime?.reachable !== true) {
    const state = typeof runtime?.state === "string" ? runtime.state : null;
    checks.push(
      fail(
        "runtime",
        status.ok
          ? `The Orca runtime is ${state ?? "not reachable"}, so nothing the plugin sends arrives.`
          : `orca status failed: ${status.why}. The runtime is probably not running.`,
        [
          { id: "serve", label: "Start Orca headless (orca serve)", default: true },
          { id: "open", label: "Open the Orca app (orca open)", default: false },
        ],
      ),
    );
    return rest("run", "Needs a reachable Orca runtime.");
  }
  checks.push(pass("runtime", `The runtime is ${String(runtime.state ?? "ready")} and reachable.`));

  // --- run ----------------------------------------------------------------
  if (ctx.loop.run === null) {
    // A failure, not a skip: Fix all must stop here and say so, rather than
    // report a loop it could not look at as healthy.
    checks.push(fail("run", "The loop has no run on record in this worktree yet, so there is no Run to register; start the loop first.", []));
    return rest("consumer", "Needs a registered Run.");
  }
  const adapter = ownAdapter(ctx);
  if (adapter?.orcaRun == null) {
    const recorded = readAdapter(ctx.root);
    const why =
      recorded === null
        ? `The board has no record of this loop: no Orca Run was ever registered for run ${ctx.loop.run}.`
        : recorded.ralphRun !== ctx.loop.run
          ? `The board's record is for an earlier run (${recorded.ralphRun}); run ${ctx.loop.run} was never registered.`
          : `Run ${ctx.loop.run} was never registered${recorded.degraded === null ? "" : `: ${recorded.degraded.why}`}.`;
    const own = registrationTerminal(ctx, adapter);
    checks.push(
      fail("run", why, [
        {
          id: "register",
          label: own === null ? "Register the Run from a terminal the plugin opens for this loop" : `Register the Run from the loop's terminal ${own}`,
          default: true,
        },
      ]),
    );
    return rest("consumer", "Needs a registered Run.");
  }
  checks.push(pass("run", `Orca Run ${adapter.orcaRun} mirrors loop run ${ctx.loop.run}.`));
  const orcaRun = adapter.orcaRun;

  // --- consumer -----------------------------------------------------------
  // What the `inbox` hook would resolve: the loop's own terminal is the
  // fallback, exactly as the hook sees it from inside the loop.
  const candidate = resolveOrcaConsumer(ctx.root, adapter, { ralphRun: ctx.loop.run, worktree: ctx.root }, adapter.terminal);
  const nothingReads = "so nothing reads its mailbox and commands sent from Orca never reach the loop";
  const bindNew = (isDefault: boolean): Repair => ({
    id: "bind-new",
    label: "Bind a terminal the plugin opens for this loop",
    default: isDefault,
  });
  if (candidate === null) {
    checks.push(
      fail(
        "consumer",
        adapter.terminal === null
          ? `The loop was not started from an Orca terminal and no terminal is bound to Run ${orcaRun}, ${nothingReads}.`
          : `The loop's terminal ${adapter.terminal} was taken by another Run and no other terminal is bound to Run ${orcaRun}, ${nothingReads}.`,
        [bindNew(true)],
      ),
    );
  } else {
    const current = ctx.call("orchestration run-current", ["--from", candidate]);
    const bound = current.ok ? boundRunOf(current) : null;
    if (!current.ok) {
      checks.push(fail("consumer", `Terminal ${candidate} cannot be reached (${current.why}), ${nothingReads}.`, [bindNew(true)]));
    } else if (bound === orcaRun) {
      consumer = candidate;
      checks.push(pass("consumer", `Terminal ${candidate} is bound to Run ${orcaRun} and reads its mailbox.`));
    } else if (bound === null) {
      checks.push(
        fail("consumer", `Terminal ${candidate} is not bound to Run ${orcaRun}, ${nothingReads}.`, [
          { id: "rebind", label: `Rebind Run ${orcaRun} to terminal ${candidate}`, default: true },
          bindNew(false),
        ]),
      );
    } else {
      checks.push(
        fail("consumer", `Terminal ${candidate} is bound to another Run (${bound}), ${nothingReads}.`, [bindNew(true)]),
      );
    }
  }

  // --- backoff ------------------------------------------------------------
  const failed = checks.some((check) => check.status === "fail");
  checks.push(backoff(ctx, failed ? "Not cleared while an earlier check fails; clearing it now would only open a new window." : null));
  return found();
}

/** Every back-off window still open, in words. */
function windows(ctx: Context): string[] {
  const open: string[] = [];
  const nowMs = ctx.now();
  const until = (retryAt: string | null): boolean => retryAt !== null && Date.parse(retryAt) > nowMs;
  if (ctx.host !== null && until(ctx.host.retryAt)) open.push(`the plugin host: ${ctx.host.why} (until ${ctx.host.retryAt})`);
  const adapter = ownAdapter(ctx);
  if (adapter?.degraded != null && until(adapter.degraded.retryAt)) {
    open.push(`the board mirror: ${adapter.degraded.why} (until ${adapter.degraded.retryAt})`);
  }
  const mailbox = readMailboxState(ctx.root);
  if (mailbox?.degraded != null && until(mailbox.degraded.retryAt)) {
    open.push(`the command route: ${mailbox.degraded.why} (until ${mailbox.degraded.retryAt})`);
  }
  return open;
}

function backoff(ctx: Context, blockedBy: string | null): Check {
  const open = windows(ctx);
  if (open.length === 0) return pass("backoff", "Nothing is backing off: the next event and the next control checkpoint reach Orca.");
  const detail = `Waiting before trying Orca again — ${open.join("; ")}.`;
  if (blockedBy !== null) return skip("backoff", `${detail} ${blockedBy}`);
  return fail("backoff", detail, [{ id: "retry-now", label: "Clear the back-off and retry now", default: true }]);
}

/**
 * The loop's own terminal, when it can coordinate a Run for it: alive, and
 * bound to nothing else. A terminal bound elsewhere is never taken.
 */
function registrationTerminal(ctx: Context, adapter: AdapterState | null): string | null {
  const terminal = adapter?.terminal ?? readAdapter(ctx.root)?.terminal ?? null;
  if (terminal === null) return null;
  const current = ctx.call("orchestration run-current", ["--from", terminal]);
  if (!current.ok) return null;
  const bound = boundRunOf(current);
  return bound === null || textFrom(current.result, "run", "objective") === objectiveFor(identityOf(ctx)) ? terminal : null;
}

const identityOf = (ctx: Context) => ({ loop: ctx.loop.loop, run: ctx.loop.run ?? "adhoc", worktree: resolve(ctx.root) });

/* --------------------------------------------------------------------------
 * The repairs.
 * ----------------------------------------------------------------------- */

/** Open an idle terminal in the loop's worktree, for the plugin to bind. */
function openTerminal(ctx: Context): { handle: string } | { why: string } {
  const created = ctx.call("terminal create", ["--worktree", `path:${resolve(ctx.root)}`, "--title", `${ctx.loop.loop} Orca mailbox`]);
  if (!created.ok) return { why: created.why };
  const result = created.result ?? {};
  const nested = (key: string): string | null => {
    const value = result[key];
    return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).handle === "string"
      ? ((value as Record<string, unknown>).handle as string)
      : null;
  };
  const handle = nested("terminal") ?? nested("startupTerminal") ?? (typeof result.handle === "string" ? result.handle : null);
  return handle === null ? { why: "orca terminal create returned no terminal handle" } : { handle };
}

const bindingIdentity = (adapter: AdapterState): AdapterBindingIdentity => ({
  ralphRun: adapter.ralphRun,
  orcaRun: adapter.orcaRun,
  worktree: adapter.worktree,
});

function bindTo(ctx: Context, adapter: AdapterState, terminal: string, opened: boolean): Omit<Step, "check" | "action"> {
  const bound = reconcileOrcaConsumerBinding(ctx.root, bindingIdentity(adapter), ctx.loop.run, terminal, ctx.call);
  if ("binding" in bound) {
    return {
      result: "repaired",
      why: `${opened ? `Opened terminal ${terminal} in this worktree and bound` : `Bound`} it to Run ${adapter.orcaRun}; it reads the Run's mailbox from now on.`,
    };
  }
  return { result: "failed", why: `Could not bind terminal ${terminal}: ${bound.why}` };
}

function waitForRuntime(ctx: Context): boolean {
  const deadline = ctx.now() + ctx.startTimeoutMs;
  for (;;) {
    const status = ctx.call("status", []);
    const runtime = status.ok ? (status.result?.runtime as Record<string, unknown> | undefined) : undefined;
    if (runtime?.reachable === true) return true;
    if (ctx.now() >= deadline) return false;
    ctx.sleep(1000);
  }
}

function register(ctx: Context): Omit<Step, "check" | "action"> {
  const run = ctx.loop.run;
  if (run === null) return { result: "not-repairable", why: "The loop has no run on record to register." };
  const previous = readAdapter(ctx.root);
  const own = previous !== null && previous.ralphRun === run ? previous : null;
  let terminal = registrationTerminal(ctx, own);
  let opened = false;
  if (terminal === null) {
    const created = openTerminal(ctx);
    if ("why" in created) return { result: "failed", why: `Could not open a terminal to register from: ${created.why}` };
    terminal = created.handle;
    opened = true;
  }
  const identity = identityOf(ctx);
  const objective = objectiveFor(identity);
  // Adopted when the terminal already coordinates this run's Run: a
  // registration that committed and lost its receipt is not made twice.
  const current = ctx.call("orchestration run-current", ["--from", terminal]);
  let orcaRun = current.ok && textFrom(current.result, "run", "objective") === objective ? boundRunOf(current) : null;
  if (orcaRun === null) {
    const created = ctx.call("orchestration run-create", ["--objective", objective, "--from", terminal]);
    if (!created.ok) return { result: "failed", why: `orca run-create failed: ${created.why}` };
    orcaRun = idFrom(created.result, "run");
    if (orcaRun === null) return { result: "failed", why: "orca run-create returned no run id" };
  }
  const state: AdapterState = {
    ...(own ?? blank({ run, loop: ctx.loop.loop, worktree: resolve(ctx.root), terminal: null }, new Date(ctx.now()).toISOString())),
    orcaRun,
  };
  writeAdapterState(join(ctx.root, ORCA_STATE_RELATIVE_PATH), state);
  const bound = bindTo(ctx, state, terminal, false);
  return bound.result === "repaired"
    ? {
        result: "repaired",
        why: `Registered Run ${orcaRun} for loop run ${run} from ${opened ? "a terminal opened for it" : "the loop's terminal"} ${terminal}, which now reads its mailbox.`,
      }
    : { result: "failed", why: `Registered Run ${orcaRun}, but ${bound.why}` };
}

function retryNow(ctx: Context, found: Found): Omit<Step, "check" | "action"> {
  const nowIso = new Date(ctx.now()).toISOString();
  // Ended, not erased: a window's reason is what the mirror reports on the
  // board as the gap it was dark for, once it is back.
  const adapter = found.adapter;
  if (adapter?.degraded != null) {
    writeAdapterState(join(ctx.root, ORCA_STATE_RELATIVE_PATH), { ...adapter, degraded: { ...adapter.degraded, retryAt: nowIso } });
  }
  const mailbox = readMailboxState(ctx.root);
  if (mailbox?.degraded != null) {
    writeMailboxState(ctx.root, { ...mailbox, degraded: { ...mailbox.degraded, retryAt: nowIso } });
  }
  if (ctx.loop.run === null) return { result: "repaired", why: "Cleared the back-off." };
  const read = deliver(ctx.root, { run: ctx.loop.run, loop: ctx.loop.loop, worktree: ctx.root }, adapter?.terminal ?? null);
  return read.ok
    ? { result: "repaired", why: "Cleared the back-off and read the Run's mailbox just now; the loop applies what it held at its next checkpoint." }
    : { result: "failed", why: `Cleared the back-off, but reading the mailbox failed again: ${read.why ?? "no reason given"}` };
}

/**
 * Apply one repair. The host has already judged it against a fresh
 * diagnosis; it is judged again here, because the host cannot know what a
 * repair needs and the world may have moved in between.
 */
export function repair(ctx: Context, checkId: string, action: string): Step {
  const found = diagnose(ctx);
  const step = (outcome: Omit<Step, "check" | "action">): Step => ({ check: checkId, action, ...outcome });
  const check = found.checks.find((row) => row.id === checkId);
  if (check?.status !== "fail" || !check.repairs.some((row) => row.id === action)) {
    return step({ result: "not-repairable", why: `${LABELS[checkId as Check["id"]] ?? checkId} does not offer '${action}' now.` });
  }
  switch (action) {
    case "serve":
      ctx.launch("serve");
      return step(
        waitForRuntime(ctx)
          ? { result: "repaired", why: "Started a headless Orca runtime (orca serve); it is reachable." }
          : { result: "failed", why: `Started orca serve, but the runtime was not reachable within ${ctx.startTimeoutMs / 1000}s.` },
      );
    case "open": {
      const opened = ctx.call("open", [], Math.max(ctx.startTimeoutMs, 15_000));
      if (!opened.ok) return step({ result: "failed", why: `orca open failed: ${opened.why}` });
      return step(
        waitForRuntime(ctx)
          ? { result: "repaired", why: "Opened the Orca app; the runtime is reachable." }
          : { result: "failed", why: "Opened the Orca app, but the runtime is still not reachable." },
      );
    }
    case "register":
      return step(register(ctx));
    case "rebind": {
      const adapter = found.adapter;
      const terminal = adapter === null
        ? null
        : resolveOrcaConsumer(ctx.root, adapter, { ralphRun: ctx.loop.run ?? "", worktree: ctx.root }, adapter.terminal);
      if (adapter === null || terminal === null) return step({ result: "not-repairable", why: "There is no terminal of the loop's to rebind." });
      return step(bindTo(ctx, adapter, terminal, false));
    }
    case "bind-new": {
      const adapter = found.adapter;
      if (adapter === null) return step({ result: "not-repairable", why: "There is no registered Run to bind a terminal to." });
      const created = openTerminal(ctx);
      if ("why" in created) return step({ result: "failed", why: `Could not open a terminal: ${created.why}` });
      return step(bindTo(ctx, adapter, created.handle, true));
    }
    case "retry-now":
      return step(retryNow(ctx, found));
    default:
      return step({ result: "not-repairable", why: `'${action}' is not a repair this plugin knows.` });
  }
}

/* --------------------------------------------------------------------------
 * The `doctor` command.
 * ----------------------------------------------------------------------- */

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** A context over the real Orca, from the host's payload. */
export function contextFrom(root: string, input: Record<string, unknown>): Context {
  const loop = typeof input.loop === "object" && input.loop !== null ? (input.loop as Record<string, unknown>) : {};
  const host = typeof input.host === "object" && input.host !== null ? (input.host as Record<string, unknown>) : {};
  const degraded = typeof host.degraded === "object" && host.degraded !== null ? (host.degraded as Record<string, unknown>) : null;
  const startTimeout = Number(process.env.RALPH_ORCA_START_TIMEOUT_MS);
  return {
    root,
    loop: {
      run: typeof loop.run === "string" && loop.run !== "" ? loop.run : null,
      loop: typeof loop.loop === "string" && loop.loop !== "" ? loop.loop : "ralph",
      worktree: typeof loop.worktree === "string" ? loop.worktree : root,
    },
    host:
      degraded !== null && typeof degraded.why === "string"
        ? { why: degraded.why, retryAt: typeof degraded.retryAt === "string" ? degraded.retryAt : null }
        : null,
    now: () => Date.now(),
    call: callOrcaForDoctor,
    launch: launchDetached,
    startTimeoutMs: Number.isFinite(startTimeout) && startTimeout > 0 ? startTimeout : 30_000,
    sleep: sleepSync,
  };
}

export interface DoctorAnswer {
  ok: true;
  title: string;
  checks: Check[];
  step?: Step;
}

/** Answer the host: a diagnosis, or a repair followed by the diagnosis after it. */
export function doctor(ctx: Context, input: Record<string, unknown>): DoctorAnswer {
  if (input.mode === "repair") {
    const step = repair(ctx, String(input.check ?? ""), String(input.repair ?? ""));
    return { ok: true, title: "Orca", checks: diagnose(ctx).checks, step };
  }
  return { ok: true, title: "Orca", checks: diagnose(ctx).checks };
}
