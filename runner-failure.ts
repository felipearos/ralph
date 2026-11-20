#!/usr/bin/env bun
/**
 * What went wrong inside a runner, attributed and stripped of secrets.
 *
 * The loop spends its money in four processes, and until now only one of them
 * left a durable trace of its own failures. `ralph.sh` records the
 * orchestrator's boundaries — iteration started, iteration ended, no sigil —
 * and that is the whole record. The executor (`ralph/delegate.sh`) and the
 * three read-only stages (`ralph/inspect.sh`) exit 2 or 4, print a diagnostic
 * on stderr, and vanish into the middle of an iteration log that nothing reads
 * until someone goes looking. So the two failures that actually stop a loop
 * overnight — a permission the runner does not have, and a credential that
 * expired — look exactly like a slow iteration until the morning.
 *
 * This module is where a runner failure becomes a fact somebody can act on.
 * Four properties are what make it worth having:
 *
 * 1. **Attribution, not a log line.** Every observation names the loop, the
 *    run (`RALPH_RUN_ID`), the attempt (the iteration index and
 *    `RALPH_SESSION_ID`), the stage, and the owner — the claim lease's
 *    `<loop>@<host>` and the issue it is holding. Those five are what turn "a
 *    stage failed" into "rafa's run of #704, attempt 3, review.spec, denied".
 *    A log line has none of them, which is why grepping the logs after the
 *    fact has never been able to answer "which ticket did this cost us?".
 *
 * 2. **The classification is about the operator's next move.** Six kinds, in
 *    the order `ralph/runner-signals.json` lists them, and the order is the
 *    precedence: a denial and a credential failure in the same run report as
 *    the denial, because the denial is a one-line repair. Two things outrank
 *    the order. A KILL — exit 124, or the watchdog's own line — is always
 *    `timeout`, because it is the one fact nobody inferred. And a signal is
 *    only as good as its CHANNEL: the runner's own error output decides the
 *    kind, while a command the model ran can only ever report a rail refusal,
 *    and only for a stage that then failed (see `classify`).
 *    `permission-denied` and `authentication` are the two the issue that
 *    asked for this file was actually about.
 *
 * 3. **Nothing secret survives the write.** Everything recorded — every
 *    evidence line, every diagnostic — passes `redact()` first: values from
 *    this process's own secret-bearing environment, and the credential shapes
 *    that never went through an environment at all. The redactor is shared
 *    with `ralph/delegate-render.py` through `ralph/runner-signals.json`,
 *    because a redactor that strips a token here and prints it into the log
 *    two lines earlier is not a redactor.
 *
 * 4. **Observing grants nothing.** This file reads files and runs `git`, and
 *    the guard is mechanical rather than a convention: `ALLOWED_COMMANDS` and
 *    `ALLOWED_GIT_SUBCOMMANDS` refuse anything else before it is spawned, and
 *    every write is refused outside `.ralph/logs`. It opens no socket, starts
 *    no container, and cannot hand a runner a tool it did not already have —
 *    which is the whole point: observability that widens what the loop may do
 *    would be a strictly worse trade than the blindness it replaces.
 *
 * **Live versus post-hoc is observed, never assumed.** `delegate-render.py`
 * timestamps each denial as it passes it through to the console, and this file
 * compares that instant against when the run ended: a signal that reached the
 * operator while the runner was still working is `live`, and one that arrived
 * in the final flush is `post-hoc` and says so. It is not a property of the
 * harness we can state in advance — `claude -p` buffers its whole turn and
 * opencode block-buffers `--format json` into a pipe, so most of what happens
 * here IS post-hoc, and the record has to be honest about which.
 *
 * Usage:
 *   ralph/runner-failure.ts observe --stage <stage> --exit N
 *                                   [--runner <name>] [--model <id>]
 *                                   [--log <file>]     # pointer, not classified
 *                                   [--errors <file>]  # stderr, classified
 *                                   [--signals <file>] [--note <text>]
 *   ralph/runner-failure.ts status [--json | --line] [--run <id>]
 *   ralph/runner-failure.ts redact [--done <file>]   # stdin → stdout filter
 *
 * `observe` never fails a caller: like `loop-state.ts record`, a supervisor
 * that died because its bookkeeping could not be written would be worse than
 * the missing record.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { currentLoop } from "./frontier/next-tasks";
import type { ClaimLease, LeaseStore } from "./claim-lease";
import { projectRoot } from "./paths";

/** The harness checkout: the pattern file lives beside this module. */
const HERE = dirname(fileURLToPath(import.meta.url));
let cachedRoot: string | null = null;

/**
 * The project worktree whose `.ralph/logs` this process writes into.
 *
 * Resolved on first use rather than at import. ESM hoists a module's imports
 * above its statements, so a suite that sets `RALPH_PROJECT` after importing
 * this file used to get every default below pointing at the git toplevel of the
 * cwd — the harness checkout, and a live loop's own when it runs the suite as
 * its gate (#199).
 */
const projectDir = (): string => (cachedRoot ??= projectRoot());

/** Where observations accumulate. One line per observation, beside the logs. */
export const OBSERVATION_RELATIVE_PATH = ".ralph/logs/runner-failures.jsonl";

/** The directory every write from this file must land inside. */
export const WRITABLE_RELATIVE_DIR = ".ralph/logs";

/** The shared pattern file. Read once; both readers of it are described there. */
export const SIGNALS_RELATIVE_PATH = "runner-signals.json";

/**
 * How long before the end of a run a signal must have been seen to count as
 * having been visible *during* it.
 *
 * Two seconds, because the thing being distinguished is not a fast harness
 * from a slow one — it is a harness that flushed as it went from one that
 * flushed everything at once when it died. The second case puts every signal
 * inside the same instant as the run's end however long the run was.
 */
export const LIVE_MARGIN_MS = 2_000;

/**
 * The evidence bound used when the pattern file cannot supply one.
 *
 * The number itself lives in `ralph/runner-signals.json` beside the patterns,
 * because both readers apply it and a bound that is 300 here and 400 in the
 * renderer is the same drift the shared file exists to prevent. This constant
 * is only the floor for a config that could not be read at all.
 */
export const DEFAULT_EVIDENCE_MAX_CHARS = 300;

/** How many pieces of evidence one observation keeps. */
export const EVIDENCE_MAX_COUNT = 8;

/**
 * How recently a signal file must have been written to count as in flight.
 *
 * A stage cannot outlive its own timeout — `delegate.sh` and `inspect.sh` both
 * run under `timeout`, at 900s by default — so a signal file nobody has
 * touched in an hour belongs to a stage that is not running. Without this
 * bound the panel fills up: every supervisor that was killed mid-stage leaves
 * a file with no observation to settle it, and last Tuesday's denial is then
 * reported, forever, as something happening right now. The one thing a live
 * panel must never do is show a stale row as live.
 *
 * An hour rather than 900s exactly, and the same hour `loop-state.ts` uses for
 * a loop it can no longer see: both are timing an iteration, and being late to
 * drop a row costs an operator far less than dropping one early on a stage
 * that was merely slow. `RALPH_INFLIGHT_WINDOW_SECONDS` overrides it.
 */
export const DEFAULT_IN_FLIGHT_WINDOW_MS = 60 * 60 * 1000;

/* --------------------------------------------------------------------------
 * The mechanical half of "observability grants nothing".
 * ----------------------------------------------------------------------- */

/**
 * Every binary this file may run, and the reason it is a list rather than a
 * convention — the same reason a plugin keeps its own verb allowlist.
 *
 * A module that reads failures is a module that gets asked, one reasonable
 * commit at a time, to also fetch the PR, ask the API why, or peek in the
 * container. Each of those would hand the loop a capability its rails
 * deliberately withhold, arriving as observability rather than as a permission
 * change. So the guard is not "we don't do that": an unlisted binary throws
 * before it is spawned, and the tests assert it.
 */
export const ALLOWED_COMMANDS = ["git"] as const;

/** And within `git`, only reads. `rev-parse` is what finds the lease store. */
export const ALLOWED_GIT_SUBCOMMANDS = ["rev-parse"] as const;

/** How long the one `git` read this file makes may take. */
const GIT_TIMEOUT_MS = 10_000;

export function assertAllowedCommand(command: string, args: readonly string[]): void {
  if (!(ALLOWED_COMMANDS as readonly string[]).includes(command)) {
    throw new Error(
      `runner-failure: refusing to run '${command}' — observability may only run: ${ALLOWED_COMMANDS.join(", ")}`,
    );
  }
  const subcommand = args.find((arg) => !arg.startsWith("-"));
  if (command === "git" && !(ALLOWED_GIT_SUBCOMMANDS as readonly string[]).includes(subcommand ?? "")) {
    throw new Error(
      `runner-failure: refusing 'git ${subcommand ?? ""}' — only: ${ALLOWED_GIT_SUBCOMMANDS.join(", ")}`,
    );
  }
}

/**
 * The only way a subprocess starts in this file, so the guard above cannot be
 * routed around by a later caller reaching for `execFileSync` directly.
 * Bounded, read-only, and every failure is "no answer" rather than a throw.
 */
export function runAllowed(command: string, args: string[], cwd = projectDir()): string | null {
  assertAllowedCommand(command, args);
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Where the claim leases live — Git's common directory, so linked worktrees
 * share one store. `claim-lease.ts` resolves the same path; it is re-derived
 * here rather than imported so that every subprocess this file starts passes
 * the allowlist above, which is the whole basis of the "grants nothing" claim.
 */
export function leaseStorePath(cwd = projectDir()): string {
  const common = runAllowed("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  return common ? join(common, "ralph-claim-leases.json") : join(resolve(cwd), ".ralph-claim-leases.json");
}

/**
 * Refuse a write outside `.ralph/logs`.
 *
 * The record is the one thing this file creates, and `--log`/`--signals` are
 * operator-supplied paths that reach it. A relative path that climbs out of
 * the worktree is how a record comes to be appended over a source file.
 */
export function assertWritable(path: string, root = projectDir()): string {
  const target = resolve(root, path);
  const logs = resolve(root, WRITABLE_RELATIVE_DIR);
  const rel = relative(logs, target);
  if (rel.startsWith("..") || resolve(logs, rel) !== target) {
    throw new Error(`runner-failure: refusing to write outside ${WRITABLE_RELATIVE_DIR}: ${path}`);
  }
  return target;
}

/* --------------------------------------------------------------------------
 * The shared patterns.
 * ----------------------------------------------------------------------- */

export interface SecretPattern {
  label: string;
  pattern: string;
}

export interface FailureKindSpec {
  kind: string;
  summary: string;
  patterns: string[];
}

export interface SignalConfig {
  version: 1;
  evidenceMaxChars?: number;
  secretEnvNames: {
    match: string[];
    never: { match: string[]; except: string[] };
    minimumValueLength: number;
  };
  secretPatterns: { patterns: SecretPattern[] };
  failureSignals: { kinds: FailureKindSpec[]; toolOutputKinds?: string[]; benignLines?: string[] };
}

/**
 * The kinds a TOOL's output may speak for, when the pattern file does not say.
 * See `failureSignals.toolOutputKinds` and `classify`.
 */
export const DEFAULT_TOOL_OUTPUT_KINDS: readonly string[] = ["permission-denied"];

export const toolOutputKinds = (config: SignalConfig): readonly string[] => {
  const listed = config.failureSignals.toolOutputKinds;
  return Array.isArray(listed) && listed.every((kind) => typeof kind === "string")
    ? listed
    : DEFAULT_TOOL_OUTPUT_KINDS;
};

/**
 * The one line that says the watchdog killed the stage, whatever it exited
 * with. `opencode-run.sh` prints it; a stage that was killed was killed.
 */
const WATCHDOG_KILL = /watchdog-killed:/i;

let cachedConfig: SignalConfig | null = null;

/** The config a reader falls back to when the file cannot be used at all. */
export const NO_PATTERNS: SignalConfig = {
  version: 1,
  secretEnvNames: { match: [], never: { match: [], except: [] }, minimumValueLength: 8 },
  secretPatterns: { patterns: [] },
  failureSignals: { kinds: [] },
};

/**
 * Whether the last `loadSignalConfig` had real patterns to work with.
 *
 * This is not a diagnostic, it is a FENCE. An empty pattern set redacts
 * nothing, and the caller has to know that before it writes evidence to a
 * durable file — see `buildObservation`, which drops every quoted line rather
 * than write one it could not scrub.
 */
export const hasPatterns = (config: SignalConfig): boolean =>
  config.secretPatterns.patterns.length > 0 || config.secretEnvNames.match.length > 0;

export function loadSignalConfig(home = HERE): SignalConfig {
  if (cachedConfig && home === HERE) return cachedConfig;
  let parsed: Partial<SignalConfig>;
  try {
    // Read back as PARTIAL, the way `claim-lease.ts` reads its store: the file
    // is on disk and may be mid-edit, so the declared shape is a claim about it
    // rather than a fact, and a version check against a type that already says
    // `1` checks nothing.
    parsed = JSON.parse(
      readFileSync(join(home, SIGNALS_RELATIVE_PATH), "utf8"),
    ) as Partial<SignalConfig>;
  } catch (error) {
    // Degrade rather than throw, and say so — the same contract
    // `delegate-render.py` already keeps for the same file. Throwing here used
    // to take the whole observation with it, so a mid-edit pattern file meant
    // the loop recorded NO failure at all: the one input that is supposed to
    // make the redactor stricter instead deleted the record. What protects the
    // secret in this state is `buildObservation` refusing to quote anything,
    // not this function refusing to return.
    console.error(
      `runner-failure: cannot read ${SIGNALS_RELATIVE_PATH} (${error instanceof Error ? error.message : String(error)});` +
        " recording the failure WITHOUT evidence, since it cannot be redacted",
    );
    return NO_PATTERNS;
  }
  if (parsed.version !== 1) {
    console.error(
      `runner-failure: unsupported ${SIGNALS_RELATIVE_PATH} version ${String(parsed.version)};` +
        " recording the failure WITHOUT evidence, since it cannot be redacted",
    );
    return NO_PATTERNS;
  }
  const config: SignalConfig = {
    version: 1,
    evidenceMaxChars: parsed.evidenceMaxChars,
    secretEnvNames: parsed.secretEnvNames ?? NO_PATTERNS.secretEnvNames,
    secretPatterns: parsed.secretPatterns ?? NO_PATTERNS.secretPatterns,
    failureSignals: parsed.failureSignals ?? NO_PATTERNS.failureSignals,
  };
  if (home === HERE) cachedConfig = config;
  return config;
}

/**
 * The kinds, most actionable first, plus the two this file adds that no
 * pattern can find: `runner-error` is any other non-zero exit, and `none` is a
 * stage that failed at nothing.
 */
export function failureKinds(config = loadSignalConfig()): string[] {
  return [...config.failureSignals.kinds.map((k) => k.kind), "runner-error", "none"];
}

export type FailureKind = string;

/* --------------------------------------------------------------------------
 * Redaction.
 * ----------------------------------------------------------------------- */

/** The marker left behind, carrying WHY the run was struck but never what. */
export const redactedAs = (label: string): string => `[redacted:${label}]`;

/**
 * One pattern out of many, with a bad one dropped rather than fatal.
 *
 * Joined into a single alternation, ONE bad entry takes every other pattern in
 * the group with it — a typo in the twelfth denial pattern would silently stop
 * the first eleven matching. `delegate-render.py` skips bad patterns
 * individually and says which; this does the same, so the two readers degrade
 * alike instead of one narrowing and the other failing.
 */
const anyOf = (patterns: string[]): RegExp | null => {
  const usable = patterns.filter((pattern) => {
    try {
      new RegExp(pattern, "i");
      return true;
    } catch (error) {
      console.error(
        `runner-failure: skipping bad pattern ${JSON.stringify(pattern)} (${error instanceof Error ? error.message : String(error)})`,
      );
      return false;
    }
  });
  return usable.length === 0 ? null : new RegExp(usable.join("|"), "i");
};

/**
 * The values in `env` that must never be printed.
 *
 * Name-shaped, not a roster, because the loop runs under Doppler and a
 * credential added there next month would not be in any roster written today.
 * The `never` list is what keeps the rule from eating the identifiers an
 * operator needs — `NEXT_PUBLIC_*`, a bare `_URL`, a port — and its `except`
 * puts back the two `_URL`s that really are credentials.
 *
 * Values shorter than the configured minimum are skipped whatever their name:
 * a `SESSION_ENABLED=1` whose value is `1` would otherwise redact every digit
 * `1` in the log, which destroys the record to protect nothing.
 */
export function secretValuesFrom(
  env: Record<string, string | undefined>,
  config = loadSignalConfig(),
): { value: string; label: string }[] {
  const rules = config.secretEnvNames;
  const match = anyOf(rules.match);
  const never = anyOf(rules.never.match);
  const except = anyOf(rules.never.except);
  const found: { value: string; label: string }[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length < rules.minimumValueLength) continue;
    if (!match?.test(name)) continue;
    if (never?.test(name) && !except?.test(name)) continue;
    found.push({ value, label: `env:${name}` });
    // A MULTI-LINE value is also registered line by line, and that is not
    // belt-and-braces: the redactor is a streaming filter that emits whole
    // lines as they arrive, so it never holds two lines of a PEM private key
    // or a wrapped connection string at once and the full-value pattern can
    // never match. Each line on its own can. Short fragments are skipped for
    // the reason the length floor exists at all — a two-character line would
    // redact every occurrence of those two characters.
    // The JSON-ESCAPED form of the value, when it differs. Both fences `tee`
    // the harness's raw event stream to `${log}.jsonl` — the file their own
    // failure diagnostics tell an operator to go and read — and in that stream
    // every value is inside a JSON string, so a credential containing a quote
    // or a backslash appears as `Ab\\cd\"ef` and the literal pattern never
    // matches it. The renderer downstream is immune because it parses first;
    // the raw log is what needed this.
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) found.push({ value: escaped, label: `env:${name}` });
    if (value.includes("\n")) {
      for (const line of value.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length >= rules.minimumValueLength) {
          found.push({ value: trimmed, label: `env:${name}` });
        }
      }
    }
  }
  // Longest first: a value that contains another (a connection string holding a
  // password) must be struck whole, or the shorter match leaves the rest of the
  // credential in place around a placeholder.
  return found.sort((a, b) => b.value.length - a.value.length);
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A redactor bound to one environment and one pattern set.
 *
 * Built once and reused: `secretValuesFrom` walks the whole environment and
 * compiles a pattern per value, and doing that per line of a 40k-line
 * transcript is the difference between a redactor and a bottleneck.
 */
export function buildRedactor(
  env: Record<string, string | undefined> = process.env,
  config = loadSignalConfig(),
): (text: string) => string {
  const values = secretValuesFrom(env, config).map((entry) => ({
    label: entry.label,
    pattern: new RegExp(escapeRegExp(entry.value), "g"),
  }));
  const shapes = config.secretPatterns.patterns.map((entry) => ({
    label: entry.label,
    pattern: new RegExp(entry.pattern, "gi"),
  }));
  return (text: string): string => {
    let out = text;
    // Environment values first. They are exact strings, so striking them before
    // the shape patterns run means a token that is BOTH (a `ghp_…` sitting in
    // `SELF_HOSTED_RUNNER_GH_PAT`) is attributed to the variable it came from,
    // which is the more useful half of the two answers.
    // A FUNCTION replacement, not a string: `String.replace` expands `$&`,
    // `$1` and friends inside a replacement string, and the labels are built
    // from environment variable names. Nothing can arrive there today that
    // would expand — but the cost of the function form is nothing, and the
    // failure it prevents is a placeholder that quietly puts the matched
    // secret back into the line it was struck from.
    for (const { label, pattern } of values) out = out.replace(pattern, () => redactedAs(label));
    for (const { label, pattern } of shapes) out = out.replace(pattern, () => redactedAs(label));
    return out;
  };
}

/** One-shot redaction. Prefer `buildRedactor` for anything line-by-line. */
export function redact(
  text: string,
  env: Record<string, string | undefined> = process.env,
  config = loadSignalConfig(),
): string {
  return buildRedactor(env, config)(text);
}

/* --------------------------------------------------------------------------
 * Classification.
 * ----------------------------------------------------------------------- */

export interface Signal {
  kind: FailureKind;
  /** The line that matched, redacted and bounded. */
  evidence: string;
  /** When the renderer saw it, when it came from a live stream. */
  at?: string;
  visibility: "live" | "post-hoc";
  /**
   * Which channel said it. `runner` is the harness itself — its stderr, its
   * error events, its own denial list, a shell fence's note. `tool` is the
   * output of a command the model ran, which is whatever the code under test
   * printed. Absent means `runner`: every signal file written before the
   * label existed came from a renderer that did not tell them apart.
   */
  source?: "runner" | "tool";
}

export interface Classification {
  kind: FailureKind;
  summary: string;
  signals: Signal[];
  /**
   * `live` when at least one signal reached the operator while the runner was
   * still working. Post-hoc otherwise — including for every stage classified
   * only from its finished log, which is most of them.
   */
  visibility: "live" | "post-hoc";
}

/**
 * The kind an exit status alone implies, before any text is read.
 *
 * The two shell fences publish these: 2 is a degrade (the harness is not there,
 * or this lineup runs the stage in-session) and 4 is a failure, of which 124
 * from `timeout` is the one shape the status can name on its own.
 */
export function kindFromExit(exitCode: number): FailureKind {
  if (exitCode === 0) return "none";
  if (exitCode === 124) return "timeout";
  if (exitCode === 2) return "unavailable";
  return "runner-error";
}

export const evidenceMaxChars = (config: SignalConfig): number => {
  const configured = config.evidenceMaxChars;
  return typeof configured === "number" && configured > 0
    ? configured
    : DEFAULT_EVIDENCE_MAX_CHARS;
};

const trimEvidence = (line: string, max: number): string => {
  const squashed = line.replace(/\s+/g, " ").trim();
  return squashed.length <= max ? squashed : `${squashed.slice(0, max - 1)}…`;
};

/**
 * Read a stage's error output and say what kind of failure it was.
 *
 * `text` MUST be error output — a non-zero stage's diagnostics, a failed tool
 * result, a harness's own stderr — and never assistant prose. A review whose
 * report discusses a permission denial is a review that WORKED, and no pattern
 * list can tell the two apart from the words alone: the separation is made by
 * the caller, at the point where it still knows which stream it is holding.
 *
 * This was got wrong once, and it is worth saying how, because the shape of
 * the mistake is the reason the rule is stated three times in this repository.
 * Every caller obeyed the rule as written and then handed over `$log` — the
 * RENDERED transcript, which is exactly where the assistant's prose ends up.
 * A clean `review.spec` whose report quoted "401" was recorded as an
 * authentication failure and shown in the panel as one. The rule was fine; the
 * only input any caller actually had was the wrong one.
 *
 * So the fix is not a stricter rule, it is a different input. `buildObservation`
 * no longer accepts the rendered log for classification at all — it takes
 * `errorsPath` (a genuine stderr capture) and the shell fence's own `note`, and
 * `logPath` survives only as a pointer for the operator. A caller that has
 * nothing but a rendered log now classifies nothing, which is the honest
 * answer and the one that cannot invent a denial.
 */
export function classify(
  input: {
    exitCode: number;
    text?: string;
    /** Signals a renderer already timestamped while the run was in flight. */
    liveSignals?: Signal[];
    /** When the run ended; live signals are dated against it. */
    endedAt?: number;
  },
  config = loadSignalConfig(),
  redactor: (text: string) => string = buildRedactor(),
): Classification {
  const order = config.failureSignals.kinds;
  const max = evidenceMaxChars(config);
  const toolKinds = toolOutputKinds(config);
  // Chatter a runner logs on the way (see `benignLines`) is not evidence of anything.
  const benign = anyOf(config.failureSignals.benignLines ?? []);
  const seen = new Map<FailureKind, Signal>();
  const signals: Signal[] = [];

  const push = (signal: Signal): void => {
    if (benign?.test(signal.evidence)) return;
    // One piece of evidence per kind: a transcript that says "permission
    // denied" forty times is one repair, and forty copies of it in the record
    // buries the OTHER kind that fired once. When a kind was raised on both
    // channels, the runner's own word is the one kept — it is the one that
    // can decide the kind below.
    const held = seen.get(signal.kind);
    if (held) {
      if (held.source === "tool" && signal.source !== "tool") {
        signals[signals.indexOf(held)] = signal;
        seen.set(signal.kind, signal);
      }
      return;
    }
    if (signals.length >= EVIDENCE_MAX_COUNT) return;
    seen.set(signal.kind, signal);
    signals.push(signal);
  };

  for (const signal of input.liveSignals ?? []) {
    const at = signal.at ? Date.parse(signal.at) : Number.NaN;
    const endedAt = input.endedAt ?? Date.now();
    const visibility: "live" | "post-hoc" =
      Number.isFinite(at) && endedAt - at >= LIVE_MARGIN_MS ? "live" : "post-hoc";
    push({
      ...signal,
      evidence: trimEvidence(redactor(signal.evidence), max),
      visibility,
      source: signal.source === "tool" ? "tool" : "runner",
    });
  }

  // The text is the note and a stderr capture: the runner channel by
  // construction (see `buildObservation`).
  const lines = (input.text ?? "").split("\n");
  for (const spec of order) {
    const pattern = anyOf(spec.patterns);
    if (!pattern) continue;
    const line = lines.find((candidate) => pattern.test(candidate) && !benign?.test(candidate));
    if (line === undefined) continue;
    push({
      kind: spec.kind,
      evidence: trimEvidence(redactor(line), max),
      visibility: "post-hoc",
      source: "runner",
    });
  }

  // What a signal is allowed to decide depends on the channel it came from.
  // The runner's own word always counts. A command's output counts only for a
  // rail refusal (`toolOutputKinds`), and only when the stage then FAILED: a
  // stage that exited 0 did its work, and a refusal it recovered from is kept
  // as evidence, not raised as a failure. This is the whole of the 2026-09-23
  // fix — five clean runs and three timeouts were classified by what a test
  // suite or a `sed` printed, and three of them paged the operator about a
  // credential that was fine.
  const decides = (signal: Signal): boolean =>
    signal.source !== "tool" || (input.exitCode !== 0 && toolKinds.includes(signal.kind));

  // A kill is a fact, not an inference, and it outranks every pattern: exit
  // 124 is `timeout` saying the watchdog fired, and so is the watchdog's own
  // line. Whatever else the stage said on the way stays in the evidence.
  const killed =
    input.exitCode === 124 ||
    signals.some((signal) => signal.source !== "tool" && WATCHDOG_KILL.test(signal.evidence));

  // Otherwise precedence is the order in the file, and the exit-derived kind is
  // the fallback rather than the answer: a stage that exits 4 having said
  // "requires approval" is a denial, and reporting it as `runner-error` would
  // send an operator to read a 900-line transcript for a one-line repair.
  const ranked = order.map((spec) => spec.kind);
  const best = ranked.find((kind) => {
    const signal = seen.get(kind);
    return signal !== undefined && decides(signal);
  });
  const kind = killed ? "timeout" : (best ?? kindFromExit(input.exitCode));
  const summary =
    order.find((spec) => spec.kind === kind)?.summary ??
    (kind === "none"
      ? signals.length > 0
        ? "the stage exited cleanly; what matched was in its tool output, which is not a runner failure"
        : "the stage did not fail"
      : "the runner exited non-zero for an unrecognised reason");
  return {
    kind,
    summary,
    signals,
    visibility: signals.some((signal) => signal.visibility === "live") ? "live" : "post-hoc",
  };
}

/* --------------------------------------------------------------------------
 * Attribution.
 * ----------------------------------------------------------------------- */

export interface Attribution {
  loop: string;
  run: string | null;
  attempt: { iteration: number | null; session: string | null };
  stage: string;
  runner: string | null;
  model: string | null;
  /** `<loop>@<host>` from the claim lease this run holds, when it holds one. */
  owner: string | null;
  /** The ticket that lease is on — the thing the failure actually cost. */
  issue: number | null;
}

/**
 * The lease this run is holding, if any.
 *
 * Read rather than derived from the branch: on the loop's most common path the
 * branch is not yet the ticket's, and by the time it is, it is gone again.
 * A missing, unreadable or unparseable store is no lease — every one of those
 * is an ordinary state for a file a loop may not have written yet, and none of
 * them is worth failing an observation over.
 */
export function leaseForRun(
  run: string | null,
  leasePath: string,
  now = Date.now(),
): ClaimLease | null {
  if (!run) return null;
  try {
    if (!existsSync(leasePath)) return null;
    const store = JSON.parse(readFileSync(leasePath, "utf8")) as LeaseStore;
    const mine = Object.values(store?.leases ?? {}).filter((lease) => lease?.run === run);
    if (mine.length === 0) return null;
    // Leases are never deleted, so a run that has worked more than one ticket
    // has more than one here — and `find` returned whichever issue number
    // sorted first in the object, which is an arbitrary answer that attributes
    // the failure to the WRONG ticket. Prefer a lease that has not expired,
    // and among those the most recently claimed: that is the one the run was
    // actually holding when the stage failed.
    const live = mine.filter((lease) => Date.parse(lease.expiresAt) > now);
    const ranked = (live.length > 0 ? live : mine).slice().sort(
      (a, b) => Date.parse(b.claimedAt) - Date.parse(a.claimedAt),
    );
    return ranked[0] ?? null;
  } catch {
    return null;
  }
}

export function attribute(
  input: { stage: string; runner?: string | null; model?: string | null },
  env: Record<string, string | undefined> = process.env,
  leasePath: string = leaseStorePath(),
): Attribution {
  let loop: string;
  try {
    loop = currentLoop(env);
  } catch {
    // An unresolvable loop name is a real fault, and `ralph.sh` refuses to
    // start on it — but refusing to RECORD on it would throw away the
    // observation that says why. Named as unknown rather than guessed at.
    loop = "unknown";
  }
  // `||`, deliberately, wherever a trimmed environment value is read here:
  // `??` would keep the EMPTY STRING, and an exported-but-blank
  // `RALPH_SESSION_ID` would then be recorded as a real session id. The lint
  // rule prefers `??` and is right in general and wrong for this shape.
  const run = env.RALPH_RUN_ID?.trim() || null;
  const iterationRaw = Number(env.RALPH_ITERATION);
  const lease = leaseForRun(run, leasePath);
  return {
    loop,
    run,
    attempt: {
      iteration: Number.isInteger(iterationRaw) && iterationRaw > 0 ? iterationRaw : null,
      session: env.RALPH_SESSION_ID?.trim() || null,
    },
    stage: input.stage,
    runner: input.runner?.trim() || null,
    model: input.model?.trim() || null,
    owner: lease?.owner ?? null,
    issue: lease?.issue ?? null,
  };
}

/* --------------------------------------------------------------------------
 * The record.
 * ----------------------------------------------------------------------- */

export interface Observation extends Attribution {
  version: 1;
  at: string;
  host: string;
  exitCode: number;
  kind: FailureKind;
  summary: string;
  visibility: "live" | "post-hoc";
  signals: Signal[];
  /** The transcript, for the operator who wants the other 900 lines. */
  log: string | null;
  /** The signal file this stage's renderer wrote, so a panel can settle it. */
  signalsFile: string | null;
  note: string | null;
}

/**
 * Signals a renderer timestamped while the run was in flight.
 *
 * One JSON object per line, written by `delegate-render.py` as each one passed
 * through it. Unparseable lines are skipped rather than thrown on: the file is
 * appended to by a process that can be killed mid-line, exactly like the
 * loop's other records.
 */
export function readLiveSignals(path: string): Signal[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const signals: Signal[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { kind?: string; evidence?: string; at?: string; source?: string };
      if (typeof parsed.kind !== "string" || typeof parsed.evidence !== "string") continue;
      signals.push({
        kind: parsed.kind,
        evidence: parsed.evidence,
        at: parsed.at,
        visibility: "post-hoc",
        source: parsed.source === "tool" ? "tool" : "runner",
      });
    } catch {
      continue;
    }
  }
  return signals;
}

export function readObservations(path: string): Observation[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const rows: Observation[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Observation;
      if (parsed?.version === 1) rows.push(parsed);
    } catch {
      continue;
    }
  }
  return rows;
}

/**
 * Where the record goes, and the one way that can be redirected.
 *
 * `RALPH_RUNNER_FAILURE_LOG` exists because a test that drives the real
 * `delegate.sh` and `inspect.sh` would otherwise append invented failures to
 * the operator's actual panel — a suite run at lunchtime showing up at 2am as
 * denials that never happened is worse than no test.
 *
 * It is deliberately NOT held to the `.ralph/logs` confinement, and the reason
 * is that the two paths have different authors. `--log` and `--signals` are
 * arguments, and an argument can be anything; this is an environment variable,
 * set by `ralph.sh` or by a test, and NO RUNNER CAN REACH IT — the executor
 * and every read-only stage are started under `env -i` with an allowlist that
 * does not include it. So the guard stays on the derived path, which is the
 * one a caller can steer.
 */
export function observationPath(
  env: Record<string, string | undefined> = process.env,
  root = projectDir(),
): string {
  const override = env.RALPH_RUNNER_FAILURE_LOG?.trim();
  if (override) return resolve(root, override);
  return assertWritable(OBSERVATION_RELATIVE_PATH, root);
}

export function appendObservation(
  observation: Observation,
  root = projectDir(),
  env: Record<string, string | undefined> = process.env,
): void {
  const path = observationPath(env, root);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(observation)}\n`);
}

export interface ObserveInput {
  stage: string;
  exitCode: number;
  runner?: string | null;
  model?: string | null;
  /**
   * The rendered transcript. A POINTER, recorded so an operator can go and
   * read it — never an input to classification, because it carries the
   * assistant's own prose. See `classify`.
   */
  logPath?: string | null;
  /**
   * A capture of the runner's stderr, and the only free text this file will
   * classify. The caller is asserting, by using this flag rather than
   * `logPath`, that nothing a model wrote is in it.
   */
  errorsPath?: string | null;
  signalsPath?: string | null;
  note?: string | null;
  endedAt?: number;
}

/**
 * Build the observation for one finished stage.
 *
 * Separated from the write so the classification is testable without a
 * filesystem to inspect afterwards, and so `observe` can decide not to write
 * at all: a clean stage with nothing to say produces `kind: "none"` and no
 * signals, and appending one of those per stage per iteration would bury the
 * failures in a record whose entire job is showing them.
 */
export function buildObservation(
  input: ObserveInput,
  env: Record<string, string | undefined> = process.env,
  options: { leasePath?: string; root?: string; home?: string; now?: number } = {},
): Observation {
  const root = options.root ?? projectDir();
  const config = loadSignalConfig(options.home ?? HERE);
  const redactor = buildRedactor(env, config);
  const now = options.now ?? Date.now();

  // Only the error capture, never `logPath`. See `classify` for what went
  // wrong when this line read the rendered transcript instead.
  let text = "";
  if (input.errorsPath) {
    try {
      text = readFileSync(resolve(root, input.errorsPath), "utf8");
    } catch {
      text = "";
    }
  }
  const liveSignals = input.signalsPath ? readLiveSignals(resolve(root, input.signalsPath)) : [];
  // The note is classified WITH the error capture, and first, because on every
  // path that fails before a harness starts it is the only error output there
  // is. The four `exit 2` degrades in `inspect.sh` write nothing else at all,
  // and "no opencode credential" versus "opencode not on PATH" is precisely
  // the distinction their shared exit code cannot carry. A note that went into
  // the record unclassified would have left both reading `unavailable`.
  //
  // It is error output by construction: notes are written by the shell fences
  // at a failure site, never by a model.
  const classification = classify(
    {
      exitCode: input.exitCode,
      text: input.note ? `${input.note}\n${text}` : text,
      liveSignals,
      endedAt: input.endedAt ?? now,
    },
    config,
    redactor,
  );
  const attribution = attribute(
    { stage: input.stage, runner: input.runner, model: input.model },
    env,
    options.leasePath ?? leaseStorePath(),
  );
  // FAIL CLOSED on content, open on the fact. With no patterns there is no
  // redactor, and every quoted line would go to a durable file unscrubbed — so
  // the quotes are dropped and the reason is put in their place. The failure
  // itself, its kind and its attribution still get recorded: losing the
  // evidence costs an operator a trip to the transcript, and losing the whole
  // observation would cost them the knowledge that anything happened.
  const redactable = hasPatterns(config);
  if (!redactable) {
    return {
      version: 1,
      at: new Date(now).toISOString(),
      host: env.HOSTNAME ?? hostname(),
      ...attribution,
      exitCode: input.exitCode,
      kind: classification.kind,
      summary: classification.summary,
      visibility: classification.visibility,
      signals: [],
      log: input.logPath ?? null,
      signalsFile: input.signalsPath ?? null,
      note: `evidence withheld: ${SIGNALS_RELATIVE_PATH} could not be read, so nothing could be redacted`,
    };
  }
  return {
    version: 1,
    at: new Date(now).toISOString(),
    host: env.HOSTNAME ?? hostname(),
    ...attribution,
    exitCode: input.exitCode,
    kind: classification.kind,
    summary: classification.summary,
    visibility: classification.visibility,
    signals: classification.signals,
    log: input.logPath ?? null,
    signalsFile: input.signalsPath ?? null,
    note: input.note ? trimEvidence(redactor(input.note), evidenceMaxChars(config)) : null,
  };
}

/** Whether an observation is worth a durable line. See `buildObservation`. */
export const worthRecording = (observation: Observation): boolean =>
  observation.exitCode !== 0 || observation.signals.length > 0;

const PUSH_KINDS: Record<string, { kind: string; subject: string }> = {
  "permission-denied": { kind: "permission-denial", subject: "Runner permission denied" },
  authentication: { kind: "credential-expiry", subject: "Runner credential failed" },
  timeout: { kind: "stage-timeout", subject: "Runner stage timed out" },
};

/** CLI arguments for the notification channel, or null for a non-pushing observation. */
export function pushArgsForObservation(observation: Observation): string[] | null {
  const rateLimited =
    observation.kind === "usage-limit" ||
    observation.kind === "api-error" &&
    (/rate.?limit|too many requests|\b429\b|usage limit|quota (?:exceeded|exhausted)|insufficient (?:credit|quota|balance)/i.exec([observation.summary, observation.note ?? "", ...observation.signals.map((signal) => signal.evidence)]
      .join("\n")));
  const mapped = rateLimited
    ? { kind: "rate-limit", subject: "Runner hit a rate limit" }
    : PUSH_KINDS[observation.kind];
  if (!mapped) return null;
  const stableSource = observation.signalsFile ?? observation.log ?? observation.note ?? observation.kind;
  const occurrence = [
    "runner",
    observation.stage,
    observation.attempt.session ?? observation.attempt.iteration ?? "adhoc",
    stableSource,
    observation.kind,
    observation.exitCode,
  ].join(":");
  const evidence = observation.signals.slice(0, 3).map((signal) => signal.evidence);
  const body = [
    observation.summary,
    ...evidence,
    observation.log ? `Log: ${observation.log}` : "",
  ].filter(Boolean).join("\n");
  return [
    "push",
    "--kind", mapped.kind,
    "--occurrence", occurrence,
    "--subject", `${mapped.subject} in ${observation.stage}`,
    "--body", body,
    "--priority", "high",
    ...(observation.issue === null ? [] : ["--ticket", String(observation.issue)]),
  ];
}

/* --------------------------------------------------------------------------
 * Reporting.
 * ----------------------------------------------------------------------- */

/**
 * A denial that has been raised but whose stage has not ended yet.
 *
 * This is the half of the record that is visible WHILE a runner is still
 * working, and it exists because the durable line is written at the stage's
 * exit — which for a review is up to fifteen minutes after the denial that
 * made the review worthless. `delegate-render.py` appends and flushes each
 * signal as it passes it through, so the file is readable in the meantime, and
 * an operator asking "what is it doing?" gets the refusal rather than silence.
 *
 * A signal file is IN FLIGHT until an observation names it. That is what keeps
 * a finished stage's denials from being reported twice — once as in-flight
 * forever, once in the record — and it needs no clock, no pid and no lock:
 * every path that ends a stage writes an observation naming the file, and a
 * stage whose supervisor was killed before it could leaves a file that stays
 * in flight, which is the truth about it.
 */
export function inFlightSignals(
  settled: Observation[],
  root = projectDir(),
  options: { now?: number; windowMs?: number } = {},
): { file: string; signals: Signal[] }[] {
  const logsDir = resolve(root, WRITABLE_RELATIVE_DIR);
  const now = options.now ?? Date.now();
  const configured = Number(process.env.RALPH_INFLIGHT_WINDOW_SECONDS);
  const windowMs =
    options.windowMs ??
    (Number.isFinite(configured) && configured > 0
      ? configured * 1000
      : DEFAULT_IN_FLIGHT_WINDOW_MS);
  const done = new Set(
    settled.flatMap((row) => (row.signalsFile ? [resolve(root, row.signalsFile)] : [])),
  );
  let names: string[];
  try {
    names = readdirSync(logsDir);
  } catch {
    return [];
  }
  const found: { file: string; signals: Signal[] }[] = [];
  for (const name of names) {
    if (!name.startsWith("signals-") || !name.endsWith(".jsonl")) continue;
    const file = join(logsDir, name);
    if (done.has(file)) continue;
    try {
      if (now - statSync(file).mtimeMs > windowMs) continue;
    } catch {
      continue;
    }
    const signals = readLiveSignals(file);
    if (signals.length > 0) found.push({ file, signals });
  }
  return found;
}

export function summarise(rows: Observation[], run?: string | null): string[] {
  const scoped = run ? rows.filter((row) => row.run === run) : rows;
  if (scoped.length === 0) return [];
  return scoped.slice(-10).map((row) => {
    const attempt =
      row.attempt.iteration === null ? "attempt ?" : `iteration ${row.attempt.iteration}`;
    const ticket = row.issue === null ? "no claim" : `#${row.issue}`;
    const owner = row.owner ?? row.loop;
    const evidence = row.signals[0]?.evidence ?? row.summary;
    return `${row.at}  ${row.kind.padEnd(17)} ${row.stage.padEnd(16)} ${attempt}, ${ticket}, ${owner} (${row.visibility})\n    ${evidence}`;
  });
}

/* --------------------------------------------------------------------------
 * CLI.
 * ----------------------------------------------------------------------- */

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function main(argv: string[]): number {
  const command = argv[0];

  if (command === "redact") {
    /**
     * `--done <file>` is touched when the stream ends, and it exists so the
     * CALLER does not have to be a compound command.
     *
     * `ralph.sh` needs to know the capture is complete before it classifies
     * it, and the obvious shape — `2> >(redact > "$err"; : > "$done")` — is a
     * trap: bash WAITS for a compound process substitution when the command it
     * decorates is in a pipeline, so the `;` reintroduced exactly the unbounded
     * block the marker was added to bound. Measured at 6s against an orphan
     * holding stderr for 6s, against 0s for a single command.
     *
     * Writing the marker from in here keeps the substitution a single command,
     * which bash does not wait on. It is written on EVERY ending, including the
     * fail-closed one, because its meaning is "the filter has finished" and not
     * "the filter succeeded".
     */
    const donePath = flag(argv, "done");
    const markDone = (): void => {
      if (!donePath) return;
      try {
        appendFileSync(assertWritable(donePath), "");
      } catch {
        // The caller's wait is bounded regardless; a marker that cannot be
        // written costs it that bound and nothing else.
      }
    };
    // A STREAMING filter, line by line, because this sits in the middle of a
    // live pipeline: `harness | redact | tee raw.jsonl | render`. Reading all
    // of stdin first would hold a whole transcript in memory and, worse, stop
    // anything downstream from appearing until the runner exited — which is
    // precisely the live visibility the rest of this file exists to protect.
    //
    // It fails CLOSED and loudly: with no patterns to redact by, a filter that
    // passed its input through would be a filter that quietly wrote
    // credentials to the file its caller believes is scrubbed.
    //
    // But it DRAINS while it fails, and that is not politeness. Returning
    // immediately closed the read end of a live pipe, so every subsequent
    // write by the process upstream — `claude -p`'s stderr, mid-turn — took
    // EPIPE or SIGPIPE. A redactor that cannot redact must degrade; one that
    // kills the orchestrator it was added to protect is a worse failure than
    // the leak. So the stream is consumed and discarded, nothing is written,
    // and the non-zero status is reported at the end.
    //
    // Downstream still gets the fail-closed outcome it needs: an empty
    // transcript means no sigil, which stops the loop loudly.
    const config = loadSignalConfig();
    if (!hasPatterns(config)) {
      console.error(
        `runner-failure: ${SIGNALS_RELATIVE_PATH} has no patterns — discarding this stream rather than writing it unredacted`,
      );
      process.stdin.resume();
      process.stdin.on("data", () => {});
      process.stdin.on("end", () => {
        markDone();
        process.exitCode = 1;
      });
      return 0;
    }
    const redactor = buildRedactor(process.env, config);
    let carry = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      // Split on the last newline and keep the remainder: a secret straddling
      // a chunk boundary would otherwise be matched against half of itself and
      // written out whole.
      const buffered = carry + chunk;
      const cut = buffered.lastIndexOf("\n");
      if (cut === -1) {
        carry = buffered;
        return;
      }
      carry = buffered.slice(cut + 1);
      // Backpressure: `write` returns false when the downstream `tee` has not
      // drained, and ignoring it lets a slow consumer turn this filter into an
      // unbounded buffer holding a whole transcript. Pause the source until it
      // drains instead.
      if (!process.stdout.write(redactor(buffered.slice(0, cut + 1)))) {
        process.stdin.pause();
        process.stdout.once("drain", () => process.stdin.resume());
      }
    });
    process.stdin.on("end", () => {
      if (carry) process.stdout.write(redactor(carry));
      markDone();
    });
    return 0;
  }

  if (command === "observe") {
    const stage = flag(argv, "stage");
    if (!stage) {
      console.error("runner-failure: observe needs --stage");
      return 0;
    }
    const exitCode = Number(flag(argv, "exit") ?? "0");
    const observation = buildObservation({
      stage,
      exitCode: Number.isFinite(exitCode) ? exitCode : 1,
      runner: flag(argv, "runner"),
      model: flag(argv, "model"),
      logPath: flag(argv, "log"),
      errorsPath: flag(argv, "errors"),
      signalsPath: flag(argv, "signals"),
      note: flag(argv, "note"),
    });
    // The signal file has done its job either way: everything in it is now
    // either quoted in the observation or was not worth quoting, and leaving
    // it behind would grow `.ralph/logs` by one file per stage per iteration
    // AND leave a settled stage looking like one still in flight. Removed
    // before the write, so a crash between the two leaves the file to age out
    // rather than a record pointing at something that is gone.
    const settled = flag(argv, "signals");
    if (settled) {
      try {
        // Through the same fence as the write. It is the only other filesystem
        // path this file touches from an operator-supplied argument, and a
        // deletion that is not held to the rule the write is held to is the
        // more dangerous of the two.
        rmSync(assertWritable(settled), { force: true });
      } catch {
        // A file that cannot be removed ages out of the in-flight window on
        // its own. Never worth failing an observation over.
      }
    }
    if (!worthRecording(observation)) return 0;
    appendObservation(observation);
    // Said out loud, once, on stderr: the record is for the panel, and an
    // operator watching the console is the reader this exists for.
    const ticket = observation.issue === null ? "no claim" : `#${observation.issue}`;
    console.error(
      `runner-failure: ${observation.stage} — ${observation.kind} (${observation.visibility}); ` +
        `${ticket}, ${observation.owner ?? observation.loop}, ${observation.run ?? "no run"}`,
    );
    for (const signal of observation.signals.slice(0, 3)) {
      console.error(`  ${signal.kind}: ${signal.evidence}`);
    }
    return 0;
  }

  if (command === "status") {
    const rows = readObservations(observationPath());
    const run = flag(argv, "run") ?? process.env.RALPH_RUN_ID ?? null;
    if (argv.includes("--json")) {
      const scoped = run ? rows.filter((row) => row.run === run) : rows;
      console.log(
        JSON.stringify(
          { inFlight: inFlightSignals(rows), settled: scoped },
          null,
          2,
        ),
      );
      return 0;
    }
    const pending = inFlightSignals(rows);
    const lines = summarise(rows, run);
    if (argv.includes("--line")) {
      const scoped = run ? rows.filter((row) => row.run === run) : rows;
      const live = pending.flatMap((entry) => entry.signals);
      console.log(
        live.length > 0
          ? `runner failures: ${live.length} raised by a stage still running — ${live[0]?.kind}`
          : scoped.length === 0
            ? "runner failures: none recorded for this run"
            : `runner failures: ${scoped.length} in this run — ${scoped[scoped.length - 1]?.kind} in ${scoped[scoped.length - 1]?.stage}`,
      );
      return 0;
    }
    // In flight FIRST, because it is the only part an operator can still act
    // on: the stage is running right now and is being refused right now.
    for (const entry of pending) {
      for (const signal of entry.signals) {
        console.log(`IN FLIGHT     ${signal.kind.padEnd(17)} ${signal.at ?? "?"}\n    ${signal.evidence}`);
      }
    }
    if (lines.length === 0 && pending.length === 0) {
      console.log("no runner failures recorded");
      return 0;
    }
    for (const line of lines) console.log(line);
    return 0;
  }

  console.error("runner-failure: expected one of: observe, status, redact");
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    // Never fatal, for the reason the header gives.
    console.error(`runner-failure: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 0;
  }
}
