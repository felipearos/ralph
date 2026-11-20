/**
 * Which tests already fail on a trial's base, and whether a head's gate run
 * fails for anything else (issue #579).
 *
 * A backtest trial scores the agent by the project's gates, run as fake CI
 * checks `trial/<gate>`. When the trial's base is already red — a test that
 * fails before the agent touched anything — every trial would be scored
 * failed, whatever it did. So the gates run once on the base (`record`), the
 * failing tests are kept, and each head's run (`checks`) is judged against
 * them: a gate that fails only on tests the base already failed passes, with
 * those tests named; one new failure keeps it red. A test file that fails to
 * load (vitest's `FAIL  file [ file ]`, jest's `Test suite failed to run`
 * under its `FAIL  file` line) counts by its path, so a file
 * the base cannot load either is forgiven and one only the head breaks is not
 * (#593). Colour is no part of an id: the base and a head may be run with and
 * without it.
 *
 * It errs towards red. A failed gate whose output names no test it can parse
 * stays FAILURE, because nothing proves the failure is the base's; and a
 * missing or unreadable base record means every gate is judged by its exit
 * code, as the trial checks were judged before #579. Nor is a failure
 * forgiven when the run timed out, was stopped or outgrew the output cap,
 * when the runner reports a failure that is not a test (an unhandled error, a
 * crashed worker, a coverage threshold), when its summary counts more failed
 * tests than the output names, or when a test fails more often than on the base.
 */
import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export interface BaseGate { conclusion: "SUCCESS" | "FAILURE"; failures: string[] }
/** Keyed by check name, e.g. "trial/test". */
export interface BaseRed { version: 1; base: string | null; gates: Record<string, BaseGate> }
export interface GateCheck { name: string; conclusion: "SUCCESS" | "FAILURE"; summary?: string; baseRed?: string[] }
export interface GateRun { name: string; ok: boolean; output: string; timedOut: boolean; truncated: boolean; aborted: boolean }
/** What `judgeGate` reads of a run; a flag left out counts as false. */
export type JudgedRun = Pick<GateRun, "ok" | "output"> & Partial<Pick<GateRun, "timedOut" | "truncated" | "aborted">>;
/** `timeoutMs` bounds the whole run of gates, not each one. */
export interface RunGatesOptions { timeoutMs: number; env: NodeJS.ProcessEnv; stderr?: (chunk: string) => void; signal?: AbortSignal }

/** The tail of a gate's output kept for parsing: a summary is at the end, and a chatty suite must not hold gigabytes. */
const OUTPUT_CAP = 2 * 1024 * 1024;
/** How many tests a summary names before it counts the rest. */
const SUMMARY_LIST_CAP = 5;
/** The whole run's bound in the CLI. */
const DEFAULT_TIMEOUT_MS = 90 * 60 * 1000;
/** How long a gate's pipes may stay open after its shell exited: a descendant outside the group (setsid, a daemon) can hold them forever. */
const CLOSE_GRACE_MS = 2000;

/**
 * Runner output saying something failed that is not a named test: an
 * unhandled error, a crashed worker, a coverage threshold. The failed tests
 * may all be the base's while the gate is red for one of these, so any of
 * them keeps it red. jest's `Test suite failed to run` is not here: it comes
 * with the file's own FAIL line, which names it.
 */
const RUNNER_MARKERS: readonly RegExp[] = [
  // vitest: `Unhandled Errors`, `Unhandled Rejection`, `Vitest caught 2 unhandled errors`.
  /unhandled errors?/i,
  /unhandled rejection/i,
  /caught \d+ unhandled/i,
  /worker exited unexpectedly/i,
  // vitest and istanbul: `ERROR: Coverage for lines (50%) does not meet global threshold (80%)`.
  /does not meet .*threshold/i,
  // jest: `Jest: "global" coverage threshold for lines (80%) not met`.
  /coverage threshold for .* not met/i,
];
/** vitest's `      Tests  2 failed | 40 passed (42)` and jest's `Tests:       2 failed, 40 passed, 42 total`. */
const TESTS_SUMMARY = /^\s*Tests:?\s+(\d+)\s+failed\b/;

// Matching the escape character is the point: colour codes split a FAIL line from its test name.
// oxlint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
/** vitest's and jest's `FAIL` lines, after an optional vitest `|project|` tag. */
const FAIL_LINE = /^\s*FAIL\s+(?:\|[^|]+\|\s+)?(\S.*?)\s*$/;
/**
 * A FAIL line's project tag as a coloured badge, ` unit ` on a background
 * colour, which vitest draws instead of `|unit|` when colour is on. Stripping
 * the colour alone would leave `unit  src/a.test.ts`, and a base recorded with
 * colour (the backtest service) would share no id with a head checked without
 * it (an agent's shell): OA-476's 60 base failures all read as new (#593).
 */
// The FAIL badge, a background-colour opener, the name (spaces allowed), the `\x1b[49m` closer.
// oxlint-disable-next-line no-control-regex
const COLOUR_PROJECT = /^((?:\x1b\[[0-9;]*m|\s)*FAIL(?:\x1b\[[0-9;]*m|\s)+?)\x1b\[(?:4[0-7]|10[0-7])m(?:\x1b\[[0-9;]*m)* ?([^\x1b]+?) ?(?:\x1b\[[0-9;]*m)*?\x1b\[49m/;
/** jest's failure headers: `● suite › test`. */
const JEST_LINE = /^\s*●\s+(\S.*?)\s*$/;
/** tsc without `--pretty`: `src/a.ts(10,5): error TS2322: …`. */
const TSC_PAREN = /^\s*(\S.*?)\(\d+,\d+\): error (TS\d+): (.*?)\s*$/;
/** tsc with `--pretty`: `src/a.ts:10:5 - error TS2322: …`. */
const TSC_COLON = /^\s*(\S.*?):\d+:\d+ - error (TS\d+): (.*?)\s*$/;

/**
 * Trailing decoration a runner adds to a FAIL line: vitest's ` [ file ]` and a
 * parenthesised duration, jest's ` (5.2 s)`. A bare trailing `5s` is left: it
 * may be the test's own name (`waits 5s`), and vitest's summary FAIL lines
 * carry no duration.
 */
function undecorate(id: string): string {
  let out = id;
  for (;;) {
    const next = out
      .replace(/\s+\[ [^\]]* \]$/, "")
      .replace(/\s+\(\d+(?:\.\d+)?\s*m?s\)$/, "")
      .trim();
    if (next === out) return out;
    out = next;
  }
}

/**
 * The failure identifiers in a gate's combined output, sorted, one entry per
 * occurrence: two identical tsc errors in a file are two failures, and the
 * head may not have more of one than the base. Line and column are dropped from tsc errors: an unrelated
 * edit above the error shifts them, and the same error must still match.
 */
export function failingTests(output: string): string[] {
  const found: string[] = [];
  for (const line of output.split(/\r?\n|\r/)) {
    // The badge pattern only on FAIL lines: run on every line of a 2 MB output it would cost more than it saves.
    const raw = (line.includes("FAIL") ? line.replace(COLOUR_PROJECT, "$1|$2|") : line).replace(ANSI, "");
    let match = FAIL_LINE.exec(raw);
    if (match) {
      const id = undecorate(match[1]!);
      if (id !== "") found.push(id);
      continue;
    }
    match = JEST_LINE.exec(raw);
    if (match) {
      // jest's `● Console` heads captured console output, not a failure.
      const id = undecorate(match[1]!).replace(/ › /g, " > ");
      if (id !== "" && id !== "Console") found.push(id);
      continue;
    }
    match = TSC_PAREN.exec(raw) ?? TSC_COLON.exec(raw);
    if (match) found.push(`${match[1]}: ${match[2]}: ${match[3]}`);
  }
  return found.sort();
}

/** The tests a summary names, the first few and a count of the rest. */
export function listed(tests: string[]): string {
  const shown = tests.slice(0, SUMMARY_LIST_CAP).join("; ");
  return tests.length > SUMMARY_LIST_CAP ? `${shown}; … and ${tests.length - SUMMARY_LIST_CAP} more` : shown;
}

export const testCount = (n: number): string => `${n} test${n === 1 ? "" : "s"}`;

const counts = (tests: string[]): Map<string, number> => {
  const counted = new Map<string, number>();
  for (const test of tests) counted.set(test, (counted.get(test) ?? 0) + 1);
  return counted;
};

/** The largest failed count a vitest or jest summary line reports; null when there is none. */
function summaryFailed(output: string): number | null {
  let most: number | null = null;
  for (const line of output.split(/\r?\n|\r/)) {
    const match = TESTS_SUMMARY.exec(line);
    if (match) most = Math.max(most ?? 0, Number(match[1]));
  }
  return most;
}

/** Why a failed run cannot be forgiven whatever tests it names; null when nothing stands in the way. */
function unforgivable(run: JudgedRun, clean: string, failures: string[]): string | null {
  if (run.timedOut) return "the run timed out";
  if (run.aborted) return "the run was stopped";
  if (run.truncated) return "the output outgrew the cap, so some failures may be unread";
  const marker = RUNNER_MARKERS.find((pattern) => pattern.test(clean));
  if (marker !== undefined) return `the runner reports a failure that is not a test (${marker.source})`;
  // Test-level ids only: a vitest file that failed to load names no test, and is not in the count.
  const counted = summaryFailed(clean);
  const named = failures.filter((test) => test.includes(" > ")).length;
  if (counted !== null && counted > named) return `the summary counts ${testCount(counted)} failed, the output names ${named}`;
  return null;
}

/** One gate's check, judged against the base record when there is one. */
export function judgeGate(name: string, run: JudgedRun, base: BaseRed | null): GateCheck {
  if (run.ok) return { name, conclusion: "SUCCESS" };
  const baseGate = base?.gates[name];
  if (baseGate === undefined || baseGate.conclusion !== "FAILURE") return { name, conclusion: "FAILURE" };
  const failures = failingTests(run.output);
  if (failures.length === 0) return { name, conclusion: "FAILURE" };
  const why = unforgivable(run, run.output.replace(ANSI, ""), failures);
  if (why !== null) return { name, conclusion: "FAILURE", summary: `not judged against the base: ${why}` };
  const known = counts(baseGate.failures);
  const fresh = [...counts(failures)].filter(([test, n]) => n > (known.get(test) ?? 0)).map(([test]) => test);
  if (fresh.length === 0) {
    return {
      name,
      conclusion: "SUCCESS",
      summary: `passes apart from ${testCount(failures.length)} already failing on the trial base: ${listed(failures)}`,
      baseRed: failures,
    };
  }
  return known.size > 0
    ? { name, conclusion: "FAILURE", summary: `new failures not on the base: ${listed(fresh)}` }
    : { name, conclusion: "FAILURE" };
}

function runGate(name: string, command: string, cwd: string, opts: RunGatesOptions, deadline: number): Promise<GateRun> {
  return new Promise((accept) => {
    let output = "";
    let truncated = false;
    const finish = (ok: boolean, extra: string, state: { timedOut?: boolean; aborted?: boolean } = {}) =>
      accept({ name: `trial/${name}`, ok, output: output + extra, timedOut: state.timedOut ?? false, truncated, aborted: state.aborted ?? false });
    if (opts.signal?.aborted) return finish(false, `\nbase-red: gate ${name} was stopped before it started\n`, { aborted: true });
    const remaining = deadline - Date.now();
    if (remaining <= 0) return finish(false, `\nbase-red: no time left for gate ${name} of the ${opts.timeoutMs}ms bound\n`, { timedOut: true });
    const take = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      opts.stderr?.(text);
      output += text;
      if (output.length > OUTPUT_CAP) {
        truncated = true;
        output = output.slice(-OUTPUT_CAP);
      }
    };
    // Its own process group, so a timeout reaches the runner's workers and not just the shell.
    const child = spawn("sh", ["-c", command], { cwd, env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const killGroup = () => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    };
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const settle = (ok: boolean, extra = "", state: { timedOut?: boolean; aborted?: boolean } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      opts.signal?.removeEventListener("abort", onAbort);
      // Nothing more is read: a process outside the group may hold the pipes open for good, and must not hold this promise.
      child.stdout.destroy();
      child.stderr.destroy();
      finish(ok, extra, state);
    };
    const timer = setTimeout(() => {
      killGroup();
      settle(false, `\nbase-red: gate ${name} timed out, the gates' ${opts.timeoutMs}ms bound is spent\n`, { timedOut: true });
    }, remaining);
    const onAbort = () => {
      killGroup();
      settle(false, `\nbase-red: gate ${name} was stopped\n`, { aborted: true });
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    let exitCode: number | null = null;
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("exit", (code) => {
      exitCode = code;
      // A server or watcher the gate left behind would hold the pipes open, and `close` would never come.
      killGroup();
      if (!settled) grace = setTimeout(() => settle(exitCode === 0), CLOSE_GRACE_MS);
    });
    child.on("error", (error) => settle(false, `\nbase-red: could not run gate ${name}: ${error.message}\n`));
    child.on("close", (code) => settle((exitCode ?? code) === 0));
  });
}

/**
 * Each gate as `sh -c` in `cwd`, in order, one after another so they do not
 * compete for the host. `timeoutMs` is one deadline for them all: each gate
 * gets what is left of it, and one started with nothing left has timed out.
 * After an abort no further gate starts, so the runs may be fewer than the gates.
 */
export async function runGates(gates: Record<string, string>, cwd: string, opts: RunGatesOptions): Promise<GateRun[]> {
  const deadline = Date.now() + opts.timeoutMs;
  const runs: GateRun[] = [];
  for (const [name, command] of Object.entries(gates)) {
    if (opts.signal?.aborted) break;
    runs.push(await runGate(name, command, cwd, opts, deadline));
  }
  return runs;
}

/** The base's record: each gate's conclusion and the tests it fails. */
export async function recordBase(gates: Record<string, string>, cwd: string, opts: RunGatesOptions & { base: string | null }): Promise<BaseRed> {
  const record: BaseRed = { version: 1, base: opts.base, gates: {} };
  for (const run of await runGates(gates, cwd, opts)) {
    // A stopped gate says nothing about the base; left out, it is judged by exit code.
    if (run.aborted) continue;
    record.gates[run.name] = run.ok ? { conclusion: "SUCCESS", failures: [] } : { conclusion: "FAILURE", failures: failingTests(run.output) };
  }
  return record;
}

function readGates(path: string): Record<string, string> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not a JSON object");
  for (const [name, command] of Object.entries(value)) {
    if (typeof command !== "string") throw new Error(`gate ${name} is not a command string`);
  }
  return value as Record<string, string>;
}

/** The base record, or null with the reason: a bad record must judge by exit code, never crash the checks. */
function readBaseRed(path: string): { record: BaseRed | null; problem?: string } {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<BaseRed>;
    if (value?.version !== 1 || typeof value.gates !== "object" || value.gates === null) return { record: null, problem: "not a version 1 record" };
    const gates: Record<string, BaseGate> = {};
    for (const [name, gate] of Object.entries(value.gates)) {
      if ((gate?.conclusion === "SUCCESS" || gate?.conclusion === "FAILURE") && Array.isArray(gate.failures)) {
        gates[name] = { conclusion: gate.conclusion, failures: gate.failures.filter((test): test is string => typeof test === "string") };
      }
    }
    return { record: { version: 1, base: typeof value.base === "string" ? value.base : null, gates } };
  } catch (error) {
    return { record: null, problem: error instanceof Error ? error.message : String(error) };
  }
}

const USAGE = `usage: bun base-red.ts record --gates <gates.json> --out <base-red.json> [--base <sha>] [--timeout-ms N]
       bun base-red.ts checks --gates <gates.json> [--base-red <base-red.json>] [--timeout-ms N]`;

function parseFlags(args: string[], known: string[]): { values: Record<string, string> } | { problem: string } {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (!known.includes(flag)) return { problem: `unknown argument ${flag}` };
    if (value === undefined) return { problem: `${flag} needs a value` };
    values[flag] = value;
  }
  return { values };
}

export async function main(argv: string[], cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const err = (line: string) => process.stderr.write(`${line}\n`);
  const usage = (problem: string) => {
    err(`base-red: ${problem}\n${USAGE}`);
    return 1;
  };
  const [command, ...rest] = argv;
  if (command !== "record" && command !== "checks") return usage(command === undefined ? "needs a command" : `unknown command ${command}`);
  const parsed = parseFlags(rest, command === "record" ? ["--gates", "--out", "--base", "--timeout-ms"] : ["--gates", "--base-red", "--timeout-ms"]);
  if ("problem" in parsed) return usage(parsed.problem);
  const { values } = parsed;
  if (values["--gates"] === undefined) return usage("--gates is required");
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (values["--timeout-ms"] !== undefined) {
    timeoutMs = Number(values["--timeout-ms"]);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) return usage("--timeout-ms must be a positive integer");
  }
  let gates: Record<string, string>;
  try {
    gates = readGates(values["--gates"]);
  } catch (error) {
    return usage(`cannot read gates ${values["--gates"]}: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Gate output goes to stderr in both commands: stdout is the checks array the fake gh parses.
  const opts: RunGatesOptions = { timeoutMs, env, stderr: (chunk) => process.stderr.write(chunk) };
  if (command === "record") {
    const out = values["--out"];
    if (out === undefined) return usage("--out is required");
    const record = await recordBase(gates, cwd, { ...opts, base: values["--base"] ?? null });
    // Written whole or not at all: a half-written record would read as no record, silently.
    const tmp = `${out}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(tmp, out);
    return 0;
  }
  let base: BaseRed | null = null;
  if (values["--base-red"] !== undefined) {
    const read = readBaseRed(values["--base-red"]);
    base = read.record;
    if (read.problem !== undefined) err(`base-red: no usable base record at ${values["--base-red"]} (${read.problem}); judging gates by exit code`);
  }
  const checks = (await runGates(gates, cwd, opts)).map((run) => judgeGate(run.name, run, base));
  process.stdout.write(`${JSON.stringify(checks)}\n`);
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
