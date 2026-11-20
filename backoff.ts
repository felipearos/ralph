#!/usr/bin/env bun
/**
 * Back off a target that is not moving, instead of spending a model turn on it.
 *
 * The frontier gate answers "is there anything to do?", and for a pull request
 * this loop owns the answer is yes for as long as the PR is open. That is
 * right when the PR needs work. It is ruinous when the PR is waiting on
 * something no iteration can change: rafa, 2026-09-23 00:16–00:22, spent seven
 * fresh Opus sessions (~700k tokens each) a minute apart re-discovering that
 * Vercel was blocking every deployment on the account. Each ended DONE, which
 * the supervisor reads as "did work, go again", and the PR never changed. The
 * ninth ended NEEDS_TRIAGE to stop the spin, which stopped the loop for the
 * night over an outage it could have waited out.
 *
 * Two signals start a backoff, and both come from outside the model's prose:
 *
 *   external     the iteration ended `<ralph>RETRY_LATER</ralph>` — it found
 *                the work blocked on something outside the repository that
 *                will clear with time or with an operator's action elsewhere.
 *   no-progress  the gate named a PR to shepherd, and the iteration left that
 *                PR exactly as it found it (same head, labels, checks, state).
 *                Whatever it ended with, nothing moved, and the next iteration
 *                would find the same thing.
 *
 * A backoff is a wait with no model in it: exponential from a base to a
 * ceiling, polling the PR (the way `pr-wait.ts` reads it) so a push, a label
 * or a merge wakes it early. Then one iteration re-checks. The streak and the
 * time spent waiting carry across strikes; any iteration that moves its target
 * or ends any other way resets them. Once the budget is spent, waiting stops
 * being the answer and the supervisor stops for a human — the escalation the
 * operator would otherwise have got at the first minute.
 *
 * Usage (from the project root, as `ralph.sh` calls it):
 *   backoff.ts fingerprint <pr>          print the PR's state fingerprint; 1 if unreadable
 *   backoff.ts settle --sigil retry-later|done|other [--pr N] [--before FP] [--blocker-file PATH]
 *                                        record how the iteration ended, and what it waits on: the
 *                                        blocker file's {key, summary, clearedBy} if readable, else
 *                                        the shepherd PR's failing checks
 *   backoff.ts wait                      wait out the current backoff; exit 3 when the budget is spent,
 *                                        4 when an operator command is waiting in the control inbox.
 *                                        On a shared blocker the wait, its clear and its budget are the
 *                                        store's episode (#431), and a spent shared episode leaves
 *                                        {event, why} in .ralph/logs/backoff-exhausted.json for ralph.sh
 *
 * The state lives in `.ralph/logs/backoff.json`; `ralph.sh` deletes it when a
 * supervisor starts, because a restart is an operator saying "try now".
 *
 * Knobs, all whole seconds: RALPH_BACKOFF_BASE_SECONDS (300),
 * RALPH_BACKOFF_MAX_SECONDS (3600), RALPH_BACKOFF_BUDGET_SECONDS (21600),
 * RALPH_BACKOFF_POLL_SECONDS (60).
 *
 * A settle on a shared blocker also joins the host-wide blocker store
 * (RALPH_BLOCKER_STORE names another file) and escalates once when a second
 * loop waits on the same cause (#430). RALPH_PUSH_CLI and
 * RALPH_BACKOFF_BASE_LOOKUP name `.ts` scripts that replace the push and the
 * base-branch lookup — test seams, run under bun; RALPH_BASE_BRANCH (main)
 * is the branch that lookup reads.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  blockerStorePath,
  join as joinBlocker,
  leave as leaveBlocker,
  markCleared as markBlockerCleared,
  markExhausted as markBlockerExhausted,
  markNotified,
  withStore as storeWithLock,
  type Alive,
  type Blocker,
} from "./blocker-store";
import { hasPendingControl } from "./control-inbox";
import { identity } from "./host-lease";
import { RALPH_HOME } from "./paths";
import { parseCheck, readSnapshot, type Check, type PrSnapshot } from "./pr-wait";

/** Beside the rest of the loop's bookkeeping, and gitignored with it. */
export const STATE_RELATIVE_PATH = ".ralph/logs/backoff.json";

/**
 * What a spent SHARED episode tells `ralph.sh` to record instead of today's
 * per-loop `backoff-exhausted` (#431). Absent means today's record, so a
 * missing or broken file never changes how a loop stops.
 */
export const EXHAUSTED_RELATIVE_PATH = ".ralph/logs/backoff-exhausted.json";

/** The exit status that means "the budget is spent — stop for a human". */
export const EXHAUSTED_EXIT = 3;

/**
 * The exit status that means "an operator command is waiting": the supervisor
 * goes back to its control checkpoint rather than on to the gate. The rest of
 * the backoff is not lost — the time waited so far is written, and the next
 * wait picks the streak up where this one left it.
 */
export const CONTROL_EXIT = 4;

export type Reason = "external" | "no-progress";
export type Sigil = "retry-later" | "done" | "other";

/**
 * What a backoff is waiting on. `key` is the identity two loops must agree on
 * to know they wait on one cause, `summary` the line a human reads,
 * `clearedBy` the PR or ticket an iteration named as what will clear it (kept
 * verbatim; a reader probes it with `parseClearedBy`), and `shared` whether the key may be
 * matched against another loop's at all.
 */
export interface BlockerRef {
  key: string;
  summary: string;
  clearedBy: string | null;
  shared: boolean;
}

export interface BackoffState {
  version: 1;
  reason: Reason;
  /** The shepherd PR being watched, or null when the blocker has no PR. */
  pr: number | null;
  /** The PR as the last iteration left it; a different read wakes the wait. */
  fingerprint: string | null;
  /** Iterations in a row that ended without moving their target. */
  strikes: number;
  /** Seconds already spent waiting in this streak, counted against the budget. */
  waitedSeconds: number;
  /** When the streak began, ISO 8601. */
  since: string;
  /** What the backoff waits on, or null when nothing named it. */
  blocker: BlockerRef | null;
}

export interface BackoffConfig {
  baseSeconds: number;
  maxSeconds: number;
  budgetSeconds: number;
  pollSeconds: number;
}

const KNOBS: [keyof BackoffConfig, string, number][] = [
  ["baseSeconds", "RALPH_BACKOFF_BASE_SECONDS", 300],
  ["maxSeconds", "RALPH_BACKOFF_MAX_SECONDS", 3600],
  ["budgetSeconds", "RALPH_BACKOFF_BUDGET_SECONDS", 21600],
  ["pollSeconds", "RALPH_BACKOFF_POLL_SECONDS", 60],
];

/**
 * The knobs, or a thrown error naming the bad one. Positive whole seconds
 * only: a zero base or poll would turn every wait into a tight loop against
 * the GitHub API, which is the thing this file exists to prevent.
 */
export function parseConfig(env: Record<string, string | undefined>): BackoffConfig {
  const config = {} as BackoffConfig;
  for (const [key, name, fallback] of KNOBS) {
    const raw = env[name];
    if (raw === undefined || raw === "") {
      config[key] = fallback;
      continue;
    }
    if (!/^\d+$/.test(raw) || Number(raw) < 1) {
      throw new Error(`${name} must be a positive whole number of seconds; got '${raw}'`);
    }
    config[key] = Number(raw);
  }
  return config;
}

/**
 * What an iteration can do to a PR, as one comparable string: its state, its
 * head, its labels and its checks' states. Sorted, because `gh` does not
 * promise an order. Check URLs are left out on purpose — a re-run moves them
 * without anything having changed.
 */
export function fingerprint(snapshot: PrSnapshot): string {
  const labels = [...snapshot.labels].sort().join(",");
  const checks = snapshot.checks
    .map((check) => `${check.name}=${check.state}`)
    .sort()
    .join(",");
  return `${snapshot.state}|${snapshot.head}|labels:${labels}|checks:${checks}`;
}

const MAX_KEY_LENGTH = 120;

/**
 * One spelling per cause, so two loops that word the same blocker differently
 * still land on one key. `<step>` is everything after the second `:`; there a
 * Buildkite `:shortcode:` emoji is decoration, not identity, and a leftover
 * `:` would read as another separator.
 */
export function normaliseBlockerKey(raw: string): string {
  let key = raw.trim().toLowerCase();
  const first = key.indexOf(":");
  const second = first === -1 ? -1 : key.indexOf(":", first + 1);
  const clean = (part: string): string => part.replace(/[^a-z0-9:#/+._-]+/g, "-").replace(/-+/g, "-");
  if (second === -1) {
    key = clean(key);
  } else {
    const step = key
      .slice(second + 1)
      .replace(/:[a-z0-9_+-]+:/g, "")
      .replace(/:/g, "-");
    key = `${clean(key.slice(0, second + 1))}${clean(step).replace(/^[\s-]+|[\s-]+$/g, "")}`;
  }
  return key.slice(0, MAX_KEY_LENGTH);
}

/**
 * Only a check AND its step, or the PR/ticket that clears it, may be matched
 * across loops: a project can run its whole pipeline behind one required
 * check, so a check alone would make two unrelated reds look like one cause.
 */
export function isSharedBlockerKey(key: string): boolean {
  return /^ci:[^:]+:[^:]+$/.test(key) || /^ref:[^/\s#:]+\/[^/\s#:]+#[1-9]\d*$/.test(key);
}

/** `#n` against the project's repo, or `owner/repo#n`; anything else is null. */
export function parseClearedBy(
  raw: string | null,
  repo: string | null,
): { repo: string; number: number } | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  const local = /^#([1-9]\d*)$/.exec(text);
  if (local) return repo === null ? null : { repo, number: Number(local[1]) };
  const full = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)$/.exec(text);
  return full ? { repo: full[1] as string, number: Number(full[2]) } : null;
}

/** The project's `repo` from `<cwd>/.ralph/config.json`, or null on any failure. */
export function readProjectRepo(cwd: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(cwd, ".ralph/config.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const repo = (parsed as Record<string, unknown>).repo;
    return typeof repo === "string" && repo.trim() !== "" ? repo.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The blocker an iteration wrote, or null. Missing, unreadable and malformed
 * are all "none named": a bad file must never cost the loop its backoff.
 */
export function readBlockerFile(path: string): BlockerRef | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const { key: rawKey, summary, clearedBy } = parsed as Record<string, unknown>;
    if (typeof rawKey !== "string" || rawKey.trim() === "") return null;
    const key = normaliseBlockerKey(rawKey);
    if (key === "") return null;
    return {
      key,
      summary: typeof summary === "string" && summary.trim() !== "" ? summary.trim() : key,
      clearedBy: typeof clearedBy === "string" && clearedBy.trim() !== "" ? clearedBy.trim() : null,
      shared: isSharedBlockerKey(key),
    };
  } catch {
    return null;
  }
}

/**
 * The blocker the supervisor can see for itself: the shepherd PR's failing
 * checks. Never shared — it cannot see the step, so the key is for the log
 * line and the state file, not for matching loops.
 */
export function derivedBlocker(pr: number, snapshot: PrSnapshot): BlockerRef | null {
  const failing = snapshot.checks
    .filter((check) => check.state === "fail")
    .map((check) => check.name)
    .sort();
  if (failing.length === 0) return null;
  return {
    key: normaliseBlockerKey(`check:${failing.join("+")}`),
    summary: `PR #${pr} has failing checks: ${failing.join(", ")}`,
    clearedBy: null,
    shared: false,
  };
}

export interface SettleInput {
  sigil: Sigil;
  /** The PR the gate named to shepherd before this iteration, if any. */
  pr: number | null;
  before: string | null;
  after: string | null;
  now: string;
  /** What the iteration is waiting on; it is recorded, and decides nothing. */
  blocker?: BlockerRef | null;
}

/**
 * The backoff after an iteration, or null for none. Pure: this is the whole
 * decision about what counts as progress.
 *
 * A DONE is a strike only when there was a shepherd target and it was READ,
 * unchanged, on both sides. An unreadable PR is not an unchanged one — that
 * would turn a `gh` blip into a wait — and frontier work needs no dedupe,
 * because claiming a ticket changes the frontier by itself.
 */
export function settle(prev: BackoffState | null, input: SettleInput): BackoffState | null {
  let reason: Reason;
  if (input.sigil === "retry-later") reason = "external";
  else if (
    input.sigil === "done" &&
    input.pr !== null &&
    input.before !== null &&
    input.after !== null &&
    input.before === input.after
  ) {
    reason = "no-progress";
  } else return null;

  const sameTarget = prev !== null && prev.pr === input.pr;
  return {
    version: 1,
    reason,
    pr: input.pr,
    fingerprint: input.after,
    strikes: sameTarget ? prev.strikes + 1 : 1,
    waitedSeconds: sameTarget ? prev.waitedSeconds : 0,
    since: sameTarget ? prev.since : input.now,
    blocker: input.blocker ?? null,
  };
}

/** Base, doubling per strike, held at the ceiling. */
export function delaySeconds(strikes: number, config: BackoffConfig): number {
  const exponent = Math.max(0, Math.min(strikes - 1, 30));
  return Math.min(config.baseSeconds * 2 ** exponent, config.maxSeconds);
}

export interface WaitDeps {
  /** The PR's fingerprint now, or null when it cannot be read. */
  read: (pr: number) => string | null;
  sleep: (seconds: number) => Promise<void>;
  log: (line: string) => void;
  /** Whether an operator command is waiting; a backoff must not sleep through a stop. */
  controlPending?: () => boolean;
  /** The project's shared blocker store (#431); absent is today's per-loop wait. */
  shared?: SharedWait;
}

export interface WaitResult {
  outcome: "elapsed" | "changed" | "exhausted" | "control";
  state: BackoffState;
}

const target = (state: BackoffState): string => (state.pr === null ? "the external blocker" : `PR #${state.pr}`);

/**
 * Wait out one backoff. Never sleeps past the budget: the last wait is cut to
 * what is left of it, so the re-check lands at the budget's edge rather than
 * an hour beyond it. A budget already spent is `exhausted` without sleeping.
 *
 * With `deps.shared` and a shared key, the store is read once here and that
 * read decides the whole call (#431): re-reading per poll would see `prune`
 * drop a waiter and demote the last loop back to a lone one. An episode that
 * was ever shared (`notified`) is cleared and spent for everyone from its
 * `first`; a wait is shared only while two loops are on it.
 */
export async function backoffWait(
  state: BackoffState,
  config: BackoffConfig,
  deps: WaitDeps,
): Promise<WaitResult> {
  const blocker = state.blocker ?? null;
  let view: SharedBlockerView | null = null;
  if (deps.shared !== undefined && blocker !== null && blocker.shared) {
    try {
      view = await deps.shared.blocker();
    } catch (error) {
      deps.log(`backoff: could not read the shared blocker (${message(error)}) — waiting alone this time.`);
    }
  }
  const firstMs = view === null ? Number.NaN : Date.parse(view.first);
  // An unparseable `first` cannot be aged, so it cannot hold a shared budget either.
  const episode = view !== null && view.notified !== null && Number.isFinite(firstMs) ? view : null;
  const sharedWait = episode !== null && episode.waiters.length >= 2;
  const sharedLeft = config.budgetSeconds - Math.floor((Date.now() - firstMs) / 1000);

  if (episode !== null && episode.clearedAt !== null) {
    deps.log(`backoff: shared blocker ${blocker?.key} was cleared at ${episode.clearedAt} — re-checking now.`);
    return { outcome: "changed", state };
  }
  // A notified episode is spent for every loop on it, even the last one left;
  // during a shared wait this replaces the per-loop budget, which may predate
  // an episode `join` reopened minutes ago.
  if (episode !== null && (episode.exhaustedNotified !== null || sharedLeft <= 0)) {
    return { outcome: "exhausted", state };
  }
  const left = config.budgetSeconds - state.waitedSeconds;
  if (!sharedWait && left <= 0) return { outcome: "exhausted", state };

  let delay: number;
  if (sharedWait) {
    delay = Math.min(config.maxSeconds, sharedLeft);
    deps.log(
      `backoff: waiting ${delay}s before re-checking ${target(state)} (strike ${state.strikes}) — ` +
        `blocker ${blocker?.key} is shared with ${episode.waiters.join(", ")}, ` +
        `${config.budgetSeconds - sharedLeft}s of ${config.budgetSeconds}s budget used since ${episode.first} ` +
        `— no model turn while it does.`,
    );
  } else {
    delay = Math.min(delaySeconds(state.strikes, config), left);
    // The last waiter of a shared episode still re-checks at the episode's edge.
    if (episode !== null) delay = Math.min(delay, sharedLeft);
    deps.log(
      `backoff: waiting ${delay}s before re-checking ${target(state)} (strike ${state.strikes}, ` +
        `${state.waitedSeconds}s of ${config.budgetSeconds}s budget used) — no model turn while it does.`,
    );
  }

  // Whether the episode cleared during this poll. A rejection costs this poll
  // only; the next one asks again.
  const clearedNow = async (shared: SharedWait, ref: BlockerRef, seen: SharedBlockerView): Promise<boolean> => {
    try {
      const now = await shared.blocker();
      if (now !== null && now.clearedAt !== null) {
        deps.log(`backoff: shared blocker ${ref.key} was cleared by another loop — re-checking now.`);
        return true;
      }
      const latest = now ?? seen;
      const probe = { ...latest, key: ref.key, pr: state.pr, clearedBy: latest.clearedBy ?? ref.clearedBy };
      if (!(await shared.cleared(probe))) return false;
    } catch (error) {
      deps.log(`backoff: could not probe the shared blocker (${message(error)}) — trying again next poll.`);
      return false;
    }
    // The probe said clear: that ends this wait whether or not the record lands.
    try {
      const won = await shared.markCleared();
      deps.log(`backoff: shared blocker ${ref.key} cleared${won ? " — cleared for every waiting loop" : ""}.`);
    } catch (error) {
      deps.log(`backoff: shared blocker ${ref.key} cleared, but could not record it (${message(error)}).`);
    }
    return true;
  };

  let waited = 0;
  let outcome: WaitResult["outcome"] = "elapsed";
  while (waited < delay) {
    const step = Math.min(config.pollSeconds, delay - waited);
    await deps.sleep(step);
    waited += step;
    if (deps.controlPending?.() === true) {
      outcome = "control";
      deps.log(`backoff: an operator command is waiting after ${waited}s — handing back to the supervisor.`);
      break;
    }
    // Before the fingerprint: the key's check passing also moves the PR's
    // fingerprint, and a wake on that would skip `markCleared` for the others.
    if (episode !== null && deps.shared !== undefined && blocker !== null) {
      if (await clearedNow(deps.shared, blocker, episode)) {
        outcome = "changed";
        break;
      }
      // The probe spawns `gh` and may take a while; a command that arrived
      // during it must not wait out another poll.
      if (deps.controlPending?.() === true) {
        outcome = "control";
        deps.log(`backoff: an operator command is waiting after ${waited}s — handing back to the supervisor.`);
        break;
      }
    }
    if (state.pr !== null && state.fingerprint !== null) {
      const now = deps.read(state.pr);
      if (now !== null && now !== state.fingerprint) {
        outcome = "changed";
        deps.log(`backoff: PR #${state.pr} changed after ${waited}s — re-checking now.`);
        break;
      }
    }
  }
  return { outcome, state: { ...state, waitedSeconds: state.waitedSeconds + waited } };
}

const isBlocker = (value: unknown): value is BlockerRef => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.key === "string" &&
    typeof v.summary === "string" &&
    (v.clearedBy === null || typeof v.clearedBy === "string") &&
    typeof v.shared === "boolean"
  );
};

// `blocker` is not checked here: a state file from before it existed, or one
// with a mangled blocker, is still a good backoff — `readState` reads it as null.
const isState = (value: unknown): value is Omit<BackoffState, "blocker"> => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    (v.reason === "external" || v.reason === "no-progress") &&
    (v.pr === null || (typeof v.pr === "number" && Number.isInteger(v.pr) && v.pr > 0)) &&
    (v.fingerprint === null || typeof v.fingerprint === "string") &&
    typeof v.strikes === "number" &&
    Number.isInteger(v.strikes) &&
    v.strikes >= 1 &&
    typeof v.waitedSeconds === "number" &&
    v.waitedSeconds >= 0 &&
    typeof v.since === "string"
  );
};

/** Missing and corrupt both read as "no backoff": the safe answer is to try. */
export function readState(path: string): BackoffState | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isState(parsed)) return null;
    const blocker = (parsed as { blocker?: unknown }).blocker;
    return { ...parsed, blocker: isBlocker(blocker) ? blocker : null };
  } catch {
    return null;
  }
}

/** Written whole and renamed into place; null removes it. */
export function writeState(path: string, state: BackoffState | null): void {
  if (state === null) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

/** The PR through `gh`, as `pr-wait.ts` reads it; null if unreadable. */
function readPr(pr: number): PrSnapshot | null {
  const got = readSnapshot(String(pr), process.env.RALPH_PROJECT_REPO?.trim() || null);
  return got.ok ? got.snapshot : null;
}

/** The PR's fingerprint; null if unreadable. */
function readFingerprint(pr: number): string | null {
  const snapshot = readPr(pr);
  return snapshot === null ? null : fingerprint(snapshot);
}

/* --------------------------------------------------------------------------
 * Sharing the blocker with the other loops of the project (#430).
 * ----------------------------------------------------------------------- */

export interface BaseRead {
  baseSha: string | null;
  baseFailing: boolean | null;
}

/** The base branch's head, and whether the key's check fails on it; a throw is "could not tell". */
export type BaseLookup = (key: string) => BaseRead | Promise<BaseRead>;

/** Performs one push; `argv` is `push-notification.ts`'s. A throw is a push that failed. */
export type Notify = (argv: string[]) => void | Promise<void>;

export interface ShareDeps {
  notify?: Notify;
  baseLookup?: BaseLookup;
  withStore?: typeof storeWithLock;
  storePath?: string;
  alive?: Alive;
  /** What `wait`'s clear probe reads through (#431); a test injects one so no `gh` runs. */
  probeReader?: ProbeReader;
}

/** Every spawn here is bounded: a backoff that hangs holds the loop it exists to keep moving. */
const SPAWN_TIMEOUT_MS = 60_000;

const spawnFailure = (what: string, out: ReturnType<typeof spawnSync>): string | null => {
  if (out.error) return `${what}: ${out.error.message}`;
  if (out.status !== 0) return `${what} exited ${out.status ?? out.signal}`;
  return null;
};

/**
 * The push, through `push-notification.ts` under bun: the CLI is not
 * executable, so spawning it directly would fail EACCES and be swallowed.
 * `RALPH_PUSH_CLI` names another one, which is how a test counts pushes.
 */
export function defaultNotify(env: Record<string, string | undefined>, cwd: string): Notify {
  return (argv) => {
    const cli = env.RALPH_PUSH_CLI?.trim() || join(RALPH_HOME, "push-notification.ts");
    const out = spawnSync(process.execPath, [cli, ...argv], {
      cwd, env, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"], timeout: SPAWN_TIMEOUT_MS,
    });
    const failed = spawnFailure("the push", out);
    if (failed !== null) throw new Error(failed);
  };
}

const isBaseRead = (value: unknown): value is BaseRead => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.baseSha === null || typeof v.baseSha === "string") &&
    (v.baseFailing === null || typeof v.baseFailing === "boolean")
  );
};

/** `stdout` of a bounded spawn with `main`'s env, or a throw naming what failed. */
const spawnText = (
  what: string,
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  cwd: string,
): string => {
  const out = spawnSync(command, args, {
    cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: SPAWN_TIMEOUT_MS,
  });
  const failed = spawnFailure(what, out);
  if (failed !== null) throw new Error(failed);
  return String(out.stdout);
};

/** One bounded `gh api` read as an object; throws on any failure. Exported for park-probe.ts (#775). */
export const ghJson = (path: string, env: Record<string, string | undefined>, cwd: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(spawnText(`gh api ${path}`, "gh", ["api", path], env, cwd));
  if (typeof parsed !== "object" || parsed === null) throw new Error(`gh api ${path} printed no object`);
  return parsed as Record<string, unknown>;
};

const upper = (value: unknown): unknown => (typeof value === "string" ? value.toUpperCase() : value);

/**
 * Whether `check` is red on the base commit. Both endpoints, because a legacy
 * StatusContext such as `buildkite/loggd` is no check run. `parseCheck` was
 * written for the rollup's upper-case GraphQL values; `gh api` is lower-case.
 * Pending is not failing: a rerun in flight is no evidence the base was red.
 */
function readBaseFailing(
  repo: string,
  baseSha: string,
  check: string,
  env: Record<string, string | undefined>,
  cwd: string,
): boolean | null {
  const runs = ghJson(`repos/${repo}/commits/${baseSha}/check-runs?per_page=100`, env, cwd).check_runs;
  const statuses = ghJson(`repos/${repo}/commits/${baseSha}/status`, env, cwd).statuses;
  if (!Array.isArray(runs) || !Array.isArray(statuses)) throw new Error("gh api printed no check_runs/statuses");
  const entries = [
    ...runs.map((run: Record<string, unknown>) => ({
      name: run?.name,
      status: upper(run?.status),
      conclusion: upper(run?.conclusion) ?? null,
    })),
    ...statuses.map((status: Record<string, unknown>) => ({ context: status?.context, state: upper(status?.state) })),
  ];
  const states = entries.flatMap((raw) => {
    const entry = parseCheck(raw);
    return entry !== null && normaliseBlockerKey(entry.name) === check ? [entry.state] : [];
  });
  if (states.includes("fail")) return true;
  if (states.includes("pass") || states.includes("skip")) return false;
  return null;
}

/**
 * `RALPH_BACKOFF_BASE_LOOKUP` names a `.ts` script that prints one JSON line
 * `{"baseSha":…,"baseFailing":…}` for the key, so no test reaches the network.
 * Without it, `git` reads the base sha and `gh` its checks — both from `env`'s
 * PATH, which is how a test stubs them. Only a `ci:<check>:<step>` key names a
 * check; any other key records the sha with `baseFailing: null`.
 */
export function defaultBaseLookup(env: Record<string, string | undefined>, cwd: string): BaseLookup {
  return (key) => {
    const script = env.RALPH_BACKOFF_BASE_LOOKUP?.trim();
    if (!script) {
      const branch = env.RALPH_BASE_BRANCH?.trim() || "main";
      const baseSha = spawnText("git rev-parse", "git", ["rev-parse", `origin/${branch}`], env, cwd).trim();
      if (baseSha === "") throw new Error(`git rev-parse origin/${branch} printed nothing`);
      const repo = readProjectRepo(cwd);
      if (repo === null) throw new Error("the base lookup found no repo in .ralph/config.json");
      const ci = /^ci:([^:]+):/.exec(key);
      if (!ci) return { baseSha, baseFailing: null };
      return { baseSha, baseFailing: readBaseFailing(repo, baseSha, ci[1] as string, env, cwd) };
    }
    const out = spawnSync(process.execPath, [script, key], {
      cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: SPAWN_TIMEOUT_MS,
    });
    const failed = spawnFailure("the base lookup", out);
    if (failed !== null) throw new Error(failed);
    const line = String(out.stdout).trim().split("\n").pop() ?? "";
    const parsed: unknown = JSON.parse(line);
    if (!isBaseRead(parsed)) throw new Error(`the base lookup printed no {baseSha, baseFailing}: ${line}`);
    return { baseSha: parsed.baseSha, baseFailing: parsed.baseFailing };
  };
}

const sharedKey = (state: BackoffState | null): string | null =>
  state?.blocker?.shared === true ? state.blocker.key : null;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The push for an episode that just got its second waiter: its cause, who waits, what clears it. */
export function escalationArgv(blocker: Blocker): string[] {
  const waiters = Object.values(blocker.waiters).map(
    (waiter) => `${waiter.loop} (${waiter.pr === null ? "no PR" : `PR #${waiter.pr}`})`,
  );
  const body = [
    blocker.summary,
    `Waiting: ${waiters.join(", ")}.`,
    ...(blocker.clearedBy === null ? [] : [`Cleared by: ${blocker.clearedBy}.`]),
  ].join("\n");
  return [
    "push",
    "--kind", "shared-blocker",
    "--occurrence", `shared-blocker:${blocker.key}:${blocker.first}`,
    "--subject", `${waiters.length} loops are waiting on ${blocker.key}`,
    "--body", body,
    "--priority", "high",
  ];
}

/**
 * After a settle: join the shared blocker store, leave the cause this loop no
 * longer waits on, and escalate once when a second loop waits on the same
 * cause. Returns the lines to print — one per thing that degraded, none when
 * all went well. Nothing here throws: a backoff that cannot reach the store
 * keeps today's per-loop backoff, and the state file is already written.
 *
 * Only a `shared: true` blocker is joined: the derived check-only key cannot
 * tell two causes apart, so matching on it would merge unrelated reds.
 */
export async function shareBlocker(
  prev: BackoffState | null,
  next: BackoffState | null,
  env: Record<string, string | undefined>,
  cwd: string,
  deps: ShareDeps = {},
): Promise<string[]> {
  const before = sharedKey(prev);
  const after = sharedKey(next);
  // Nothing shared either side: no identity, no lock, no line on a settle that
  // never touched the store.
  if (before === null && after === null) return [];
  const lines: string[] = [];

  // Identity first: a throw after the lock is taken would rewrite the store for nothing.
  let party: ReturnType<typeof identity>;
  try {
    party = identity(env);
  } catch (error) {
    return [`backoff: could not share the blocker with other loops (${message(error)}) — backing off alone.`];
  }

  // Outside the lock: it spawns, and a slow call inside would hold the lock
  // past its 30s staleness break.
  let base: BaseRead = { baseSha: null, baseFailing: null };
  if (after !== null) {
    try {
      base = await (deps.baseLookup ?? defaultBaseLookup(env, cwd))(after);
    } catch (error) {
      lines.push(`backoff: could not read the base branch for ${after} (${message(error)}) — recording it as not known.`);
    }
  }

  const leaving = before !== null && before !== after ? before : null;
  let escalate: Blocker | null = null;
  try {
    const path = deps.storePath ?? (env.RALPH_BLOCKER_STORE?.trim() || blockerStorePath(cwd));
    const now = new Date().toISOString();
    // One critical section for the leave and the join, and markNotified's own
    // answer is the whole of "once" across loops.
    escalate = await (deps.withStore ?? storeWithLock)(
      path,
      (store) => {
        if (leaving !== null) leaveBlocker(store, leaving, party.loop);
        if (after === null || next?.blocker == null) return null;
        const blocker = joinBlocker(
          store,
          {
            key: after,
            loop: party.loop,
            pid: party.pid,
            host: party.host,
            pr: next.pr,
            summary: next.blocker.summary,
            clearedBy: next.blocker.clearedBy,
            baseSha: base.baseSha,
            baseFailing: base.baseFailing,
          },
          now,
        );
        if (Object.keys(blocker.waiters).length < 2) return null;
        return markNotified(store, after, now) ? structuredClone(blocker) : null;
      },
      deps.alive,
    );
  } catch (error) {
    lines.push(`backoff: could not share the blocker with other loops (${message(error)}) — backing off alone.`);
    return lines;
  }

  // After the lock is released: the push spawns and uses the network. Should
  // it fail, the episode is already marked, and losing one escalation beats a
  // loop that cannot settle.
  if (escalate !== null) {
    try {
      await (deps.notify ?? defaultNotify(env, cwd))(escalationArgv(escalate));
    } catch (error) {
      lines.push(`backoff: could not escalate ${escalate.key} (${message(error)}) — the loops keep waiting.`);
    }
  }
  return lines;
}

/* --------------------------------------------------------------------------
 * Clearing a shared blocker (#431). When two loops wait on one cause, the
 * first to see it gone clears it for both, so neither sleeps out a budget on
 * a blocker that already went away. The probes read through `ProbeReader`, so
 * no test reaches `gh`, and every failure is "not cleared": a probe that
 * cannot answer leaves the loop on today's wait, never stuck or crashed.
 * ------------------------------------------------------------------------ */

export interface SharedBlockerView {
  first: string;
  /** Set by sibling C when it first saw two or more live waiters. */
  notified: string | null;
  exhaustedNotified: string | null;
  clearedAt: string | null;
  clearedBy: string | null;
  baseSha: string | null;
  baseFailing: boolean | null;
  waiters: string[];
}

export interface SharedWait {
  /** The blocker as the store has it now, pruned, or null when absent. */
  blocker: () => Promise<SharedBlockerView | null>;
  /** Claim `clearedAt` for everyone; true when THIS call set it. */
  markCleared: () => Promise<boolean>;
  /** Claim `exhaustedNotified` for everyone; true when THIS call set it. */
  markExhausted: () => Promise<boolean>;
  /** The three clear probes: the PR's own check, the base head, the reference. */
  cleared: (probe: SharedBlockerView & { key: string; pr: number | null }) => Promise<boolean>;
}

export interface ProbeReader {
  /** The PR's checks, via `parseCheck` over `statusCheckRollup`. */
  prChecks: (pr: number) => Promise<Check[] | null>;
  /** The base branch head and its checks, from BOTH endpoints. */
  baseChecks: () => Promise<{ sha: string; checks: Check[] } | null>;
  /** A referenced PR's state: merged, closed or open. */
  prState: (repo: string, number: number) => Promise<"merged" | "closed" | "open" | null>;
}

/** `ci:<check>:<step>` split in two; null for any key `isSharedBlockerKey` would not share. */
export function parseCiKey(key: string): { check: string; step: string } | null {
  if (!isSharedBlockerKey(key)) return null;
  const ci = /^ci:([^:]+):([^:]+)$/.exec(key);
  return ci ? { check: ci[1] as string, step: ci[2] as string } : null;
}

const REST_FAILED_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale",
]);

const restText = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/**
 * One REST `check_runs` or combined-status `statuses` entry. `parseCheck` is
 * for the rollup's upper-case GraphQL values and would read every lower-case
 * REST entry as pending, so the base probe would never clear.
 */
export function parseRestCheck(raw: unknown): Check | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  if ("context" in entry && !("name" in entry)) {
    const name = restText(entry.context);
    if (name === null) return null;
    const state = restText(entry.state);
    return {
      name,
      state: state === "success" ? "pass" : state === "failure" || state === "error" ? "fail" : "pending",
      url: restText(entry.target_url),
    };
  }
  const name = restText(entry.name);
  if (name === null) return null;
  const url = restText(entry.html_url) ?? restText(entry.details_url);
  if (entry.status !== "completed") return { name, state: "pending", url };
  const conclusion = restText(entry.conclusion);
  if (conclusion === "success") return { name, state: "pass", url };
  if (conclusion === "neutral" || conclusion === "skipped") return { name, state: "skip", url };
  if (conclusion !== null && REST_FAILED_CONCLUSIONS.has(conclusion)) return { name, state: "fail", url };
  return { name, state: "pending", url };
}

/** A check name spelled the way a key spells it, so `Buildkite/Loggd` meets `buildkite/loggd`. */
const keyCheck = (name: string): string | null => parseCiKey(normaliseBlockerKey(`ci:${name}:x`))?.check ?? null;

const checkPasses = (checks: Check[] | null, check: string): boolean =>
  checks !== null && checks.some((entry) => entry.state === "pass" && keyCheck(entry.name) === check);

/**
 * The default `SharedWait["cleared"]`. `repo` resolves a bare `#n`. The base
 * probe is armed only when the episode saw the base red: a green new head
 * says nothing about a cause that was never on the base. Never throws.
 */
export function clearedProbe(reader: ProbeReader, repo: string | null): SharedWait["cleared"] {
  return async (probe) => {
    const ci = parseCiKey(probe.key);
    const ownPr = async (): Promise<boolean> => {
      if (ci === null || probe.pr === null) return false;
      return checkPasses(await reader.prChecks(probe.pr), ci.check);
    };
    const base = async (): Promise<boolean> => {
      if (ci === null || probe.baseFailing !== true || probe.baseSha === null) return false;
      const head = await reader.baseChecks();
      return head !== null && head.sha !== probe.baseSha && checkPasses(head.checks, ci.check);
    };
    const reference = async (): Promise<boolean> => {
      const own = /^ref:(.+)$/.exec(probe.key);
      const target = parseClearedBy(probe.clearedBy ?? (own ? (own[1] as string) : null), repo);
      if (target === null) return false;
      const state = await reader.prState(target.repo, target.number);
      return state === "merged" || state === "closed";
    };
    for (const read of [ownPr, base, reference]) {
      try {
        if (await read()) return true;
      } catch {
        // One probe that cannot answer is no clear, and no reason to skip the others.
      }
    }
    return false;
  };
}

/** The store's episode for `key`, as `backoffWait` sees it. */
const blockerView = (blocker: Blocker): SharedBlockerView => ({
  first: blocker.first,
  notified: blocker.notified,
  exhaustedNotified: blocker.exhaustedNotified,
  clearedAt: blocker.clearedAt,
  clearedBy: blocker.clearedBy,
  baseSha: blocker.baseSha,
  baseFailing: blocker.baseFailing,
  waiters: Object.values(blocker.waiters).map((waiter) => waiter.loop),
});

/**
 * The real `SharedWait` over the host's blocker store. Every member takes the
 * store's lock for one short section — `withStore` prunes dead waiters, so a
 * read never counts a loop that died — and holds it across no spawn.
 */
export function sharedWaitFor(
  key: string,
  storePath: string,
  cleared: SharedWait["cleared"],
  deps: Pick<ShareDeps, "withStore" | "alive"> = {},
): SharedWait {
  const locked = <T>(critical: Parameters<typeof storeWithLock<T>>[1]): Promise<T> =>
    (deps.withStore ?? storeWithLock)(storePath, critical, deps.alive);
  return {
    blocker: () =>
      locked((store) => {
        const blocker = store.blockers[key];
        return blocker === undefined ? null : blockerView(blocker);
      }),
    markCleared: () => locked((store) => markBlockerCleared(store, key, new Date().toISOString())),
    markExhausted: () => locked((store) => markBlockerExhausted(store, key, new Date().toISOString())),
    cleared,
  };
}

/** A bounded read whose every failure is "no answer": the probe must not throw. */
const quietly = <T>(read: () => T): Promise<T | null> => {
  try {
    return Promise.resolve(read());
  } catch {
    return Promise.resolve(null);
  }
};

/**
 * The reads `clearedProbe` makes, through `gh` and `git` on `env`'s PATH. The
 * base head goes through `parseRestCheck`: the REST endpoints answer in
 * lower case, which `parseCheck` would read as pending for ever.
 */
export function defaultProbeReader(env: Record<string, string | undefined>, cwd: string): ProbeReader {
  return {
    prChecks: (pr) =>
      quietly(() => {
        const got = readSnapshot(String(pr), env.RALPH_PROJECT_REPO?.trim() || null);
        return got.ok ? got.snapshot.checks : null;
      }),
    baseChecks: () =>
      quietly(() => {
        // The head from GitHub, not `origin/<branch>`: nothing fetches while
        // every loop on the host sleeps, so the local ref would never move.
        const branch = env.RALPH_BASE_BRANCH?.trim() || "main";
        const repo = readProjectRepo(cwd);
        if (repo === null) return null;
        const head = ghJson(`repos/${repo}/commits/${encodeURIComponent(branch)}`, env, cwd).sha;
        if (typeof head !== "string" || head === "") return null;
        const sha = head;
        const runs = ghJson(`repos/${repo}/commits/${sha}/check-runs?per_page=100`, env, cwd).check_runs;
        const statuses = ghJson(`repos/${repo}/commits/${sha}/status`, env, cwd).statuses;
        if (!Array.isArray(runs) || !Array.isArray(statuses)) return null;
        const checks = [...runs, ...statuses].flatMap((raw: unknown) => {
          const check = parseRestCheck(raw);
          return check === null ? [] : [check];
        });
        return { sha, checks };
      }),
    prState: (repo, number) =>
      quietly(() => {
        const pr = ghJson(`repos/${repo}/pulls/${number}`, env, cwd);
        if (pr.merged === true || (typeof pr.merged_at === "string" && pr.merged_at !== "")) return "merged";
        if (pr.state === "closed") return "closed";
        if (pr.state === "open") return "open";
        return null;
      }),
  };
}

/**
 * On a spent shared episode, claim its one escalation and leave `ralph.sh` the
 * record to write. The loop that wins names every waiter; the rest say it was
 * already escalated, so the operator is not told once per loop. Returns the
 * degrade line, or null; on a degrade no file is written, which is today's record.
 */
async function writeSharedExhaustion(
  shared: SharedWait,
  key: string,
  loop: string,
  config: BackoffConfig,
  file: string,
): Promise<string | null> {
  try {
    const view = await shared.blocker();
    // A never-shared episode is a lone loop's exhaustion: today's record. So
    // is a loop whose own streak ran out while the episode still has budget —
    // claiming it would stop every other loop on a blocker with hours left.
    if (view === null || view.notified === null) return null;
    const age = Math.floor((Date.now() - Date.parse(view.first)) / 1000);
    if (view.exhaustedNotified === null && !(age >= config.budgetSeconds)) return null;
    const won = await shared.markExhausted();
    const spent = `shared blocker ${key} did not clear in ${config.budgetSeconds}s`;
    const record = won
      ? {
          event: "backoff-exhausted",
          why: `${spent}; waiting loops: ${[...new Set([...view.waiters, loop])].sort().join(", ")}; needs human triage`,
        }
      : { event: "backoff-exhausted-shared", why: `${spent}; already escalated on this host` };
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(tmp, file);
    return null;
  } catch (error) {
    return `backoff: could not record the shared exhaustion of ${key} (${message(error)}) — recording it as this loop's own.`;
  }
}

const flag = (argv: string[], name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};

const prNumber = (raw: string | undefined): number | null =>
  raw !== undefined && /^[1-9]\d*$/.test(raw) ? Number(raw) : null;

const USAGE =
  "usage: backoff.ts fingerprint <pr> | settle --sigil retry-later|done|other [--pr N] [--before FP] [--blocker-file PATH] | wait";

export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
  deps: ShareDeps = {},
): Promise<number> {
  const [command, ...rest] = argv;
  let config: BackoffConfig;
  try {
    config = parseConfig(env);
  } catch (error) {
    console.error(`backoff: ${error instanceof Error ? error.message : String(error)}`);
    return 64;
  }
  const path = join(cwd, STATE_RELATIVE_PATH);

  switch (command) {
    case "fingerprint": {
      const pr = prNumber(rest[0]);
      if (pr === null) {
        console.error(`backoff: ${USAGE}`);
        return 64;
      }
      const print = readFingerprint(pr);
      if (print === null) return 1;
      console.log(print);
      return 0;
    }
    case "settle": {
      const raw = flag(rest, "sigil");
      if (raw !== "retry-later" && raw !== "done" && raw !== "other") {
        console.error(`backoff: ${USAGE}`);
        return 64;
      }
      const pr = prNumber(flag(rest, "pr"));
      const before = flag(rest, "before") || null;
      // One read serves both the fingerprint and the derived blocker.
      const snapshot = pr === null ? null : readPr(pr);
      const after = snapshot === null ? null : fingerprint(snapshot);
      const blockerFile = flag(rest, "blocker-file");
      const blocker =
        (blockerFile ? readBlockerFile(resolve(cwd, blockerFile)) : null) ??
        (pr !== null && snapshot !== null ? derivedBlocker(pr, snapshot) : null);
      const prev = readState(path);
      const next = settle(prev, {
        sigil: raw,
        pr,
        before,
        after,
        now: new Date().toISOString(),
        blocker,
      });
      writeState(path, next);
      if (next !== null) {
        const why =
          next.reason === "external"
            ? "the iteration ended RETRY_LATER — blocked on something external"
            : `PR #${next.pr} is exactly as the iteration found it — no progress`;
        const on = next.blocker === null ? "" : `; waiting on: ${next.blocker.summary}`;
        console.log(
          `backoff: ${why}${on}; backing off instead of re-spawning ` +
            `(strike ${next.strikes}, next check in ${Math.min(delaySeconds(next.strikes, config), Math.max(0, config.budgetSeconds - next.waitedSeconds))}s, ` +
            `${next.waitedSeconds}s of ${config.budgetSeconds}s budget used).`,
        );
      }
      // After the settle line, which stays as it was; whatever degrades here
      // adds a line of its own and never changes the exit or the state.
      for (const line of await shareBlocker(prev, next, env, cwd, deps)) console.log(line);
      return 0;
    }
    case "wait": {
      const state = readState(path);
      if (state === null) return 0;
      // Only a shared key reaches the store: an unshared one waits exactly as before.
      let shared: SharedWait | undefined;
      let loop = "";
      if (state.blocker !== null && state.blocker.shared) {
        try {
          loop = identity(env).loop;
          const storePath = deps.storePath ?? (env.RALPH_BLOCKER_STORE?.trim() || blockerStorePath(cwd));
          const cleared = clearedProbe(deps.probeReader ?? defaultProbeReader(env, cwd), readProjectRepo(cwd));
          shared = sharedWaitFor(state.blocker.key, storePath, cleared, deps);
        } catch (error) {
          console.log(`backoff: could not share the wait on ${state.blocker.key} (${message(error)}) — waiting alone.`);
        }
      }
      const supervisor = process.ppid;
      const result = await backoffWait(state, config, {
        read: readFingerprint,
        sleep: async (seconds) => {
          await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
          // The supervisor is gone (a `kill -9` runs no trap): stop waiting
          // for nobody. Its successor starts without the backoff anyway.
          if (process.ppid !== supervisor) process.exit(0);
        },
        log: (line) => console.log(line),
        controlPending: () => hasPendingControl(cwd),
        ...(shared === undefined ? {} : { shared }),
      });
      if (result.outcome === "exhausted") {
        const blocker =
          state.reason === "external"
            ? "an external blocker"
            : `PR #${state.pr}, which no iteration has moved`;
        console.log(
          `backoff: spent ${state.waitedSeconds}s of the ${config.budgetSeconds}s budget waiting on ${blocker} ` +
            `(${state.strikes} strikes since ${state.since}) — escalating to a human.`,
        );
        // A file left by an earlier episode must not colour this one's record.
        const exhaustedFile = join(cwd, EXHAUSTED_RELATIVE_PATH);
        try {
          rmSync(exhaustedFile, { force: true });
        } catch (error) {
          console.log(`backoff: could not remove ${EXHAUSTED_RELATIVE_PATH} (${message(error)}).`);
        }
        if (shared !== undefined && state.blocker !== null) {
          const degraded = await writeSharedExhaustion(shared, state.blocker.key, loop, config, exhaustedFile);
          if (degraded !== null) console.log(degraded);
        }
        return EXHAUSTED_EXIT;
      }
      writeState(path, result.state);
      return result.outcome === "control" ? CONTROL_EXIT : 0;
    }
    default:
      console.error(`backoff: ${USAGE}`);
      return 64;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // Never fatal to a loop: an unrunnable backoff means no backoff.
      console.error(`backoff: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 0;
    },
  );
}
