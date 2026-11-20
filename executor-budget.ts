#!/usr/bin/env bun
/**
 * How long one delegation may run, and what each side is told about it.
 *
 * `delegate.sh` used to run every executor under a flat
 * `timeout ${RALPH_DELEGATE_TIMEOUT:-900}`. On 2026-09-23 five Codex runs were
 * killed at 900s while still iterating — remo #1114 (route, loader, hook and
 * component in one slice, with many jest/typecheck cycles), remo #1115, rafa
 * #1219 (a whole directory as test scope), ralph #1221, rafa #1108 — on a host
 * a Buildkite agent was also loading. None had crashed; each orchestrator
 * finished the partial diff itself on its own, much dearer, model. And rafa
 * #1107's orchestrator wrapped `delegate.sh` in its own `timeout 590` — its
 * Bash tool cannot wait longer than 600s by default — and stopped waiting on a
 * run that was nearly done.
 *
 * So the budget is resolved here, once:
 *
 *   - a default longer than 900s (`RALPH_DELEGATE_TIMEOUT` still moves it);
 *   - a brief may declare its own with a `Budget: 1800s` (or `30m`) line, for
 *     the slice the orchestrator knows is wide;
 *   - a declared budget is held between a floor and a maximum
 *     (`RALPH_DELEGATE_MAX_TIMEOUT`), so no brief buys an unbounded run;
 *   - the executor is told its deadline and a wrap-up point at 80% of it, in
 *     wall-clock seconds it can compare with `date +%s`. Codex `exec` takes its
 *     prompt once and cannot be sent a message mid-run, so a deadline it knows
 *     from the start is the soft warning that actually reaches it;
 *   - the orchestrator's tool ceiling (`BASH_MAX_TIMEOUT_MS`, which ralph.sh
 *     sets from `orchestrator-wait-ms`) covers the largest budget plus a
 *     margin, so waiting on a delegation never needs a shorter shell timeout.
 *
 *   resolve <brief>              shell assignments: DELEGATE_BUDGET,
 *                                DELEGATE_BUDGET_SOURCE, DELEGATE_BUDGET_CLAMPED,
 *                                DELEGATE_WRAP_UP, DELEGATE_WAIT
 *   note <seconds> <wrap-up> <start-epoch>
 *                                the markdown section the executor reads
 *   orchestrator-wait-ms         the orchestrator's tool ceiling, in ms
 */
import { readFileSync } from "node:fs";

type Env = Record<string, string | undefined>;

/** Long enough for one layer with a few test cycles on a loaded host. */
export const DEFAULT_BUDGET_SECONDS = 1500;
/** The most a brief can ask for without the operator raising the ceiling. */
export const DEFAULT_MAX_BUDGET_SECONDS = 2400;
/** A declared budget below this is a typo, not a plan. */
export const MIN_BRIEF_BUDGET_SECONDS = 120;
/** The share of the budget after which the executor stops verifying. */
export const WRAP_UP_SHARE = 0.8;
/** What the orchestrator waits beyond the budget: delegate.sh's own summary. */
export const WAIT_MARGIN_SECONDS = 300;

export interface Budget {
  seconds: number;
  source: "default" | "env" | "brief";
  /** A declared budget was moved into [floor, max]. */
  clamped: boolean;
  maxSeconds: number;
  wrapUpSeconds: number;
}

const positive = (raw: string | undefined): number | null => {
  if (raw === undefined || !/^\s*\d+\s*$/.test(raw)) return null;
  const value = Number(raw);
  return value > 0 ? value : null;
};

/** The `Budget:` line of a brief, in seconds; null when there is none. */
export function declaredBudget(brief: string): number | null {
  const match = /^[\s>*_-]*budget[*_]*\s*:[*_]*\s*(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hours?)?\b/im.exec(brief);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  if (unit.startsWith("h")) return amount * 3600;
  if (unit.startsWith("m")) return amount * 60;
  return amount;
}

function maxSeconds(env: Env): number {
  const configured = positive(env.RALPH_DELEGATE_MAX_TIMEOUT) ?? DEFAULT_MAX_BUDGET_SECONDS;
  // An operator who raised the default meant it; the ceiling follows.
  return Math.max(configured, positive(env.RALPH_DELEGATE_TIMEOUT) ?? 0);
}

export function resolveBudget(env: Env, brief: string): Budget {
  const max = maxSeconds(env);
  const declared = declaredBudget(brief);
  const fromEnv = positive(env.RALPH_DELEGATE_TIMEOUT);
  let seconds: number;
  let source: Budget["source"];
  let clamped = false;
  if (declared !== null) {
    seconds = Math.min(max, Math.max(MIN_BRIEF_BUDGET_SECONDS, declared));
    clamped = seconds !== declared;
    source = "brief";
  } else if (fromEnv !== null) {
    seconds = fromEnv;
    source = "env";
  } else {
    seconds = Math.min(max, DEFAULT_BUDGET_SECONDS);
    source = "default";
  }
  return { seconds, source, clamped, maxSeconds: max, wrapUpSeconds: Math.floor(seconds * WRAP_UP_SHARE) };
}

/** Seconds the orchestrator must be able to wait on any one delegation. */
export function orchestratorWaitSeconds(env: Env): number {
  return maxSeconds(env) + WAIT_MARGIN_SECONDS;
}

/** The section prepended to the executor's round: its deadline, in its own terms. */
export function budgetNote(budget: Pick<Budget, "seconds" | "wrapUpSeconds">, startEpoch: number): string {
  const killAt = startEpoch + budget.seconds;
  const wrapAt = startEpoch + budget.wrapUpSeconds;
  return [
    "## Time budget",
    "",
    `This round has ${budget.seconds}s of wall-clock time. It started at epoch ${startEpoch}; the process is`,
    `killed without warning at epoch ${killAt}, and anything unfinished then is lost to review.`,
    "",
    `- Check \`date +%s\` before each test, typecheck or lint run.`,
    `- At or after epoch ${wrapAt} (the wrap-up point): stop verifying and start no new edit.`,
    "  Leave the diff as it stands and end the round with what is done, what is",
    "  not, and which check you did not get to run. A reported half-slice is",
    "  worth more than a finished one the kill erased.",
    "- Run the narrowest check that proves the change (one test file, not a",
    "  directory), and do not repeat a passing check.",
  ].join("\n");
}

const USAGE = "usage: executor-budget.ts resolve <brief> | note <seconds> <wrap-up> <start-epoch> | orchestrator-wait-ms";

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const env = process.env as Env;
  const [first, second, third] = args;
  if (command === "resolve" && args.length === 1 && first !== undefined) {
    let brief: string;
    try {
      brief = readFileSync(first, "utf8");
    } catch (error) {
      console.error(`executor-budget: cannot read ${first}: ${(error as Error).message}`);
      process.exit(64);
    }
    const budget = resolveBudget(env, brief);
    process.stdout.write(
      [
        `DELEGATE_BUDGET=${budget.seconds}`,
        `DELEGATE_BUDGET_SOURCE=${budget.source}`,
        `DELEGATE_BUDGET_CLAMPED=${budget.clamped ? 1 : 0}`,
        `DELEGATE_WRAP_UP=${budget.wrapUpSeconds}`,
        `DELEGATE_WAIT=${budget.seconds + WAIT_MARGIN_SECONDS}`,
        "",
      ].join("\n"),
    );
  } else if (command === "note" && args.length === 3 && args.every((arg) => /^\d+$/.test(arg))) {
    const budget = { seconds: Number(first), wrapUpSeconds: Number(second) };
    process.stdout.write(`${budgetNote(budget, Number(third))}\n`);
  } else if (command === "orchestrator-wait-ms" && args.length === 0) {
    process.stdout.write(`${orchestratorWaitSeconds(env) * 1000}\n`);
  } else {
    console.error(USAGE);
    process.exit(64);
  }
}
