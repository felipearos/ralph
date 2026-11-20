#!/usr/bin/env bun
/**
 * The eval CLI (#801). `eval <plan>` replays merged work against arms — each
 * a lineup plus an optional prompt overlay — in sandboxed coder iterations,
 * scores every arm the same way, has a blind judge panel and an unblinded
 * analyst read the results, and writes a report. Nothing is published: no PR,
 * push, tracker write or Slack message. The plan's `source` names one PR's
 * work (the A/B on a PR); a plan with `clerk` and `sample` is the clerk
 * backtest (#525), which `backtest <config>` still runs under its old name.
 *
 * The single-ticket executor comparison that lived here (`run`, `report`) is
 * retired: the sandbox runs the whole iteration with its review rounds, which
 * the bare executor never did.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseBacktest, renderBacktestSample } from "./backtest";
import { renderBacktestReport } from "./backtest-report";
import { rescoreBacktest, runBacktestCommand } from "./backtest-trial";
import { listRuns, readPatch, relayedPatches, startRun, stopRun } from "./eval-runs";
import { sampleFor } from "./eval-source";
import { projectRoot } from "./paths";
import { buildRedactor } from "./runner-failure";

type Command = string[];
export interface CommandResult { exit: number | null; timedOut: boolean; seconds: number }
export interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number }

/** How long a timed-out command waits for the group it killed to be gone.
 *
 * `close` fires when the SHELL has been reaped, which is not the same as the
 * group being empty: 4 of 25 timed-out runs on a loaded host still had the
 * orphaned child in state `R` at that moment, 1-2 ms from death (#353). A
 * caller that then deletes the clone or reads its tree races the processes it
 * asked to kill. Bounded and degrading, because a member nobody reaps must
 * cost a trial two seconds rather than the whole experiment. */
const GROUP_REAP_WAIT_MS = 2_000;
const GROUP_REAP_TICK_MS = 5;

/** Whether any member of `pid`'s process group is left.
 *
 * Every error reads as gone: ESRCH because the group is empty, EPERM because it
 * is no longer ours. Two imprecisions are deliberate, because this only gates a
 * bounded wait and neither can outlast it: a zombie still answers signal 0, so
 * a member nobody reaps reads as alive for the whole bound (the test's
 * definition of dead is gone OR `Z`, which is the looser one); and a recycled
 * pid that has become some other group's leader reads as alive too. */
export function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

/** Poll until `pid`'s process group is empty or the bound expires. Resolves
 * either way — a group that will not die costs a trial two seconds, never the
 * experiment (CLAUDE.md: a wait degrades on error, it does not throw). */
export async function reapGroup(pid: number): Promise<void> {
  const deadline = Date.now() + GROUP_REAP_WAIT_MS;
  while (groupAlive(pid) && Date.now() < deadline) await new Promise((resume) => setTimeout(resume, GROUP_REAP_TICK_MS));
}

/** Kill the process group as well as its shell: a timed-out trial must not
 * continue spending tokens or testing in a clone that is being removed. */
export async function runCommand(command: Command, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, log: string, signal?: AbortSignal): Promise<CommandResult> {
  const start = Date.now();
  const redact = buildRedactor();
  mkdirSync(resolve(log, ".."), { recursive: true });
  writeFileSync(log, "");
  return new Promise((accept) => {
    const child = spawn(command[0]!, command.slice(1), { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let timedOut = false;
    let bytes = 0;
    const buffers = new Map<string, string>();
    const write = (text: string) => {
      if (bytes > 32 * 1024 * 1024) return;
      const safe = redact(text);
      appendFileSync(log, safe);
      bytes += Buffer.byteLength(safe);
    };
    const consume = (channel: string, chunk: Buffer) => {
      const lines = ((buffers.get(channel) ?? "") + chunk.toString()).split("\n");
      buffers.set(channel, lines.pop() ?? "");
      for (const line of lines) write(`${line}\n`);
    };
    child.stdout.on("data", (chunk: Buffer) => consume("out", chunk));
    child.stderr.on("data", (chunk: Buffer) => consume("err", chunk));
    const kill = () => {
      timedOut = true;
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } }
    };
    const timer = setTimeout(kill, Math.max(1, timeoutMs));
    signal?.addEventListener("abort", kill, { once: true });
    if (signal?.aborted) kill();
    child.on("error", (error) => write(`${error.message}\n`));
    child.on("close", (exit) => {
      // The listener stays synchronous so that nothing can strand the caller: an
      // async listener's throw (appendFileSync on a removed log directory, ENOSPC)
      // becomes a rejected promise nobody observes, and `accept` is never called.
      const seconds = (Date.now() - start) / 1000;
      const done = () => accept({ exit, timedOut, seconds });
      try {
        clearTimeout(timer);
        signal?.removeEventListener("abort", kill);
        for (const text of buffers.values()) write(text);
      } catch { /* a failed log write must not cost the caller its result */ }
      // Only the killed path waits, and it polls rather than sleeping: a command
      // that ended on its own has no group left to outlive it. `seconds` is read
      // before the wait, so the report still measures the command, not the reap.
      if (!(timedOut && child.pid)) return done();
      reapGroup(child.pid).then(done, done);
    });
  });
}

const USAGE = "usage: experiments.ts eval <plan.json> [--dry-run | [--rescore] [--run-dir <dir>]] (backtest <config.json> is the same command)"
  + " | runs --json | start --json (plan on stdin) | stop <run> --json | patch <run> <case> <arm> | patches --json";

/**
 * The dashboard's verbs (#801), run in the project's checkout: the runs as
 * a summary view, start a run from a plan on stdin, stop one, read one
 * trial's patch, and every patch the project lets the bridge relay (#825). JSON out, one line of error on stderr and exit 1 on refusal.
 */
async function dashboardVerb(command: string, rest: string[]): Promise<boolean> {
  const project = projectRoot();
  if (command === "runs" && rest.join(" ") === "--json") {
    console.log(JSON.stringify(listRuns(project)));
    return true;
  }
  if (command === "start" && rest.join(" ") === "--json") {
    const plan = JSON.parse(await Bun.stdin.text()) as unknown;
    console.log(JSON.stringify({ version: 1, run: startRun(project, plan) }));
    return true;
  }
  if (command === "stop" && rest.length === 2 && rest[1] === "--json") {
    console.log(JSON.stringify({ version: 1, ...stopRun(project, rest[0]!) }));
    return true;
  }
  if (command === "patch" && rest.length === 3) {
    const patch = readPatch(project, rest[0]!, rest[1]!, rest[2]!);
    if (patch === null) throw new Error(`no patch for ${rest[1]}/${rest[2]} in ${rest[0]}`);
    process.stdout.write(patch);
    return true;
  }
  if (command === "patches" && rest.join(" ") === "--json") {
    console.log(JSON.stringify(relayedPatches(project)));
    return true;
  }
  return false;
}

/** The flags: `--dry-run`, or `--rescore` and `--run-dir <dir>`, each at most once. */
function parseRunArgs(rest: string[]): { dryRun: boolean; rescore: boolean; runDir: string | null } {
  let dryRun = false;
  let rescore = false;
  let runDir: string | null = null;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--dry-run" && !dryRun) dryRun = true;
    else if (arg === "--rescore" && !rescore) rescore = true;
    else if (arg === "--run-dir" && runDir === null && rest[index + 1] !== undefined) {
      index += 1;
      runDir = resolve(rest[index]!);
    } else throw new Error(USAGE);
  }
  // A dry run writes no run directory, so naming one is a mistake worth saying.
  if (dryRun && runDir !== null) throw new Error(`--dry-run and --run-dir do not go together; ${USAGE}`);
  // A rescore reads a run that happened; a dry run has none to read.
  if (dryRun && rescore) throw new Error(`--dry-run and --rescore do not go together; ${USAGE}`);
  return { dryRun, rescore, runDir };
}

if (import.meta.main) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const [command, file, ...rest] = process.argv.slice(2);
  // Each command's own name in its log lines: a nightly unit greps for `backtest:`.
  const name = command === "backtest" ? "backtest" : "eval";
  try {
    if (command !== undefined && ["runs", "start", "stop", "patch", "patches"].includes(command)) {
      if (!(await dashboardVerb(command, [file, ...rest].filter((arg): arg is string => arg !== undefined)))) throw new Error(USAGE);
    } else {
      if (!file || (command !== "eval" && command !== "backtest")) {
        if (command === "run" || command === "report") throw new Error(`${command} is retired; compare arms on a merged PR with eval (README: "Compare arms on merged work"). ${USAGE}`);
        throw new Error(USAGE);
      }
      const { dryRun, rescore, runDir } = parseRunArgs(rest);
      const config = parseBacktest(JSON.parse(readFileSync(file, "utf8")));
      if (dryRun) console.log(renderBacktestSample(await sampleFor(config), config));
      else {
        // The batch checks the signal between and during trials; Ctrl-C kills the current one and keeps the state resumable.
        process.on("SIGINT", cancel);
        process.on("SIGTERM", cancel);
        // A rescore checks it too: Ctrl-C ends the review in flight.
        const result = await (rescore ? rescoreBacktest : runBacktestCommand)(config, {
          ...(runDir === null ? {} : { runDir }),
          signal: controller.signal,
          log: (line) => console.error(`${name}: ${line}`),
        });
        console.log(renderBacktestReport(result.report));
        console.log(`Artifacts: ${result.runDir}`);
        if (result.report.finishedAt === null) process.exitCode = 1;
      }
    }
  } catch (error) { console.error(`experiments: ${buildRedactor()(String(error))}`); process.exitCode = 1; }
  finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
}
