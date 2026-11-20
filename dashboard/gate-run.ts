/**
 * Runs one of a project's gates (`gates` in `.ralph/config.json`) from the
 * Settings page's Run button (#690), in the project's main checkout.
 *
 * Asynchronous by design: the dashboard's Bun server has `idleTimeout: 255`,
 * the most Bun allows, and a project's full test gate can take longer than
 * that on a loaded host. So `start` returns the run's view at once and the
 * page polls `current` for its state; no HTTP request waits on the gate.
 *
 * One run per project at a time, and a second start is refused, not queued:
 * a queued run would start minutes later, unseen, against whatever the
 * checkout then holds, and two test gates at once double the host's load.
 *
 * The gate runs in its own process group (`detached`), and the time limit
 * kills that whole group: a gate like `bun run test` spawns many children,
 * and killing only `bash` would leave them running on the host. A timeout is
 * its own outcome, never a pass or a fail, even when the killed process then
 * reports a non-zero code.
 *
 * Only the output's tail is kept (a ring of lines plus the partial last
 * line), so a chatty gate cannot grow the dashboard's memory.
 */
import { spawn } from "node:child_process";
import type { GateRunState, GateRunView } from "./contracts";

export type { GateRunState, GateRunView };

export type GateSpec = { name: string; command: string };

/** A run started: its view now, and a promise of its view once it has settled. */
export type GateRunStarted = { started: true; view: GateRunView; done: Promise<GateRunView> };

/** A start refused because a run is in flight for the same key. */
export type GateRunRefused = { started: false; running: { gate: string; startedAt: string }; reason: string };

export type GateRunner = {
  start(key: string, cwd: string, gate: GateSpec): GateRunStarted | GateRunRefused;
  current(key: string): GateRunView | null;
};

export type GateRunnerOptions = {
  limitMs?: number;
  tailLines?: number;
  now?: () => number;
  /** Grace between the group's SIGTERM and SIGKILL on timeout. */
  killGraceMs?: number;
  /** The run's environment; `process.env` by default. Worktree setup adds the main checkout's path to it. */
  env?: NodeJS.ProcessEnv;
};

const DEFAULT_LIMIT_MS = 20 * 60 * 1000;
const DEFAULT_TAIL_LINES = 40;
const DEFAULT_KILL_GRACE_MS = 2000;
/** A partial line longer than this is cut, so one newline-free stream cannot grow without bound. */
const MAX_PARTIAL_CHARS = 64 * 1024;

// CSI sequences (colours, cursor moves) and OSC sequences (titles, links).
// oxlint-disable-next-line no-control-regex -- ANSI escapes start with ESC, a control character by definition
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export const stripAnsi = (text: string): string => text.replace(ANSI, "");

/**
 * The last `limit` lines of a run's output, in arrival order, plus each
 * stream's unfinished last line: a partial stdout line followed by a stderr
 * chunk must not be glued into one line.
 */
class Tail {
  private lines: string[] = [];
  private partial: Record<"out" | "err", string> = { out: "", err: "" };
  private dropped = false;

  constructor(private readonly limit: number) {}

  push(stream: "out" | "err", chunk: string): void {
    const parts = (this.partial[stream] + chunk).split("\n");
    let rest = parts.pop() ?? "";
    if (rest.length > MAX_PARTIAL_CHARS) rest = rest.slice(-MAX_PARTIAL_CHARS);
    this.partial[stream] = rest;
    for (const line of parts) this.lines.push(line.replace(/\r$/, ""));
    if (this.lines.length > this.limit) {
      this.lines.splice(0, this.lines.length - this.limit);
      this.dropped = true;
    }
  }

  view(): { output: string; truncated: boolean } {
    const partials = [this.partial.out, this.partial.err].filter((line) => line !== "");
    const lines = [...this.lines, ...partials];
    const kept = lines.slice(-this.limit);
    const truncated = this.dropped || kept.length < lines.length;
    return { output: stripAnsi(kept.join("\n")), truncated };
  }
}

export function createGateRunner(options: GateRunnerOptions = {}): GateRunner {
  const limitMs = options.limitMs ?? DEFAULT_LIMIT_MS;
  const tailLines = Math.max(1, options.tailLines ?? DEFAULT_TAIL_LINES);
  const now = options.now ?? Date.now;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const env = options.env ?? process.env;

  const running = new Map<string, () => GateRunView>();
  const finished = new Map<string, GateRunView>();

  const start = (key: string, cwd: string, gate: GateSpec): GateRunStarted | GateRunRefused => {
    const inFlight = running.get(key);
    if (inFlight) {
      const view = inFlight();
      return {
        started: false,
        running: { gate: view.gate, startedAt: view.startedAt },
        reason: `gate '${view.gate}' is already running for this project (started ${view.startedAt}); wait for it to finish`,
      };
    }

    const startedMs = now();
    const startedAt = new Date(startedMs).toISOString();
    const tail = new Tail(tailLines);
    const base = { gate: gate.name, command: gate.command, startedAt, limitMs };
    const live = (): GateRunView => ({
      ...base,
      state: "running",
      durationMs: null,
      exitCode: null,
      ...tail.view(),
      error: null,
    });
    running.set(key, live);

    const done = new Promise<GateRunView>((resolve) => {
      let timedOut = false;
      let settled = false;
      let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      let limitTimer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let closeGrace: ReturnType<typeof setTimeout> | undefined;
      let child: ReturnType<typeof spawn> | undefined;

      const settle = (state: GateRunState, exitCode: number | null, error: string | null): void => {
        if (settled) return;
        settled = true;
        // Every timer goes with the run: a group kill fired after it settled
        // could reach an unrelated group that has since taken the pid.
        clearTimeout(limitTimer);
        clearTimeout(killTimer);
        clearTimeout(closeGrace);
        // Nothing more is read: a process that left the group (`setsid`, a
        // detached helper) may hold the pipes open for good, and must not hold
        // the run, or the project's Run, with it.
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        const view: GateRunView = { ...base, state, durationMs: now() - startedMs, exitCode, ...tail.view(), error };
        finished.set(key, view);
        // Released on every path, so the next start for this key succeeds.
        if (running.get(key) === live) running.delete(key);
        resolve(view);
      };

      // How the run ends once the gate has exited (or the limit has passed).
      const outcome = (): void => {
        if (timedOut) settle("timeout", null, null);
        else if (exited?.code === 0) settle("passed", 0, null);
        else settle("failed", exited?.signal ? null : (exited?.code ?? null), null);
      };

      // A signal to the whole group; a group already gone is not an error.
      const signalGroup = (pid: number | undefined, signal: NodeJS.Signals): void => {
        if (pid === undefined) return;
        try {
          process.kill(-pid, signal);
        } catch {
          // ESRCH: the group has exited.
        }
      };

      try {
        child = spawn("bash", ["-c", gate.command], {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
      } catch (caught) {
        settle("failed", null, `could not start gate '${gate.name}': ${caught instanceof Error ? caught.message : String(caught)}`);
        return;
      }
      const spawned = child;

      // Decoded per stream, so a multibyte character split across two reads
      // (vitest's check marks) is not turned into replacement characters.
      spawned.stdout?.setEncoding("utf8");
      spawned.stderr?.setEncoding("utf8");
      spawned.stdout?.on("data", (chunk: string) => tail.push("out", chunk));
      spawned.stderr?.on("data", (chunk: string) => tail.push("err", chunk));

      spawned.on("error", (caught) => {
        // A spawn failure (missing cwd, no bash) emits `error` and no `close`
        // with a code; a kill failure after spawn also lands here and is not fatal.
        if (spawned.pid === undefined) settle("failed", null, `could not start gate '${gate.name}': ${caught.message}`);
      });

      spawned.on("exit", (code, signal) => {
        exited = { code, signal };
        // Children left in the group (a backgrounded `&`) die with the gate.
        signalGroup(spawned.pid, "SIGKILL");
        // `close` waits for the pipes, so the tail holds the last output; but
        // a process outside the group can hold them open forever, so the run
        // settles a short grace after the exit whether or not they close.
        if (!settled) closeGrace = setTimeout(outcome, killGraceMs);
      });
      spawned.on("close", outcome);

      limitTimer = setTimeout(() => {
        timedOut = true;
        signalGroup(spawned.pid, "SIGTERM");
        // The limit bounds the run itself, not only the gate: past the grace
        // the group is killed and the run settles, closed pipes or not.
        killTimer = setTimeout(() => {
          signalGroup(spawned.pid, "SIGKILL");
          settle("timeout", null, null);
        }, killGraceMs);
      }, limitMs);
    });

    return { started: true, view: live(), done };
  };

  const current = (key: string): GateRunView | null => running.get(key)?.() ?? finished.get(key) ?? null;

  return { start, current };
}
