#!/usr/bin/env bun
/**
 * Whether a parked ticket's wake condition holds, decided without a model.
 *
 * Why it exists: #775, for #770. A ticket parked under `<loop>-blocked`
 * records in `park-store.ts` what it waits on — a referenced PR or issue
 * closing, a check going green, a Buildkite step passing, a label coming off.
 * Spending a model session to look at that is waste, so the supervisor asks
 * this module instead, and only a condition that holds wakes the ticket.
 *
 * `evaluatePark` is the read-only half: it reads, it never writes. It
 * reuses `backoff.ts`'s read seam (`ProbeReader`, `defaultProbeReader`,
 * `parseClearedBy`) rather than inventing a second one, and follows
 * `clearedProbe`'s rule: a read that throws or has no answer is "waiting",
 * never "woke" — a GitHub hiccup must not unblock a ticket whose cause stands.
 * "error" is kept for a condition that cannot be evaluated at all.
 *
 * `sweep` is the acting half, `bun park-probe.ts sweep` from the project's
 * worktree. Per park, at most once per RALPH_PARK_MIN_INTERVAL_SECONDS and
 * under a cap on every remote read (RALPH_PARK_SWEEP_READS, Buildkite's
 * included): a closed or claimed ticket, or one whose blocked label is gone,
 * drops its park; a park past its budget pages once; a held condition wakes.
 * Its only writes are the store, `gh pr ready`, `tracker.ts label remove` and
 * the one escalation push.
 *
 * A wake writes ready → label → unpark, deliberately the reverse of
 * `migration-applied.ts`. Here the park is the only record that the ticket
 * waits, and a park whose label is gone is dropped — so with the label off
 * first, a crash before the draft flip would strand an eligible ticket behind
 * an open draft PR that reads as a claim, with no park left to retry it. The
 * price is a window, one `tracker.ts` call long, where a ready PR sits on a
 * ticket still labelled blocked; its own loop resuming a second early is the
 * cheaper risk.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { defaultNotify, defaultProbeReader, ghJson, type Notify, parseClearedBy, readProjectRepo, type ProbeReader } from "./backoff";
import { Buildkite, jobsNamed, pipelineFromChecks, resolveOrg, tokenFrom, type Build } from "./bk-log";
import {
  type ListedPark,
  listStore,
  claimCheck,
  markChecked,
  markEscalated,
  type Park,
  configuredParkStorePath,
  unparkIf,
  withStore,
} from "./park-store";
import { RALPH_HOME } from "./paths";
import { loadProjectConfig } from "./project-config";
import { currentProjectId } from "./project-id";
import { createTracker } from "./tracker/index";

export type ParkVerdict = "woke" | "waiting" | "error";

export interface IssueLive {
  state: "open" | "closed";
  labels: string[];
  assignees: string[];
}

export interface PrDraft {
  state: "open" | "closed" | "merged";
  isDraft: boolean;
}

/**
 * Every remote read the probe makes. Each may throw or answer null for "no
 * answer"; the caller treats both as "cannot tell yet".
 */
export interface ParkReader extends ProbeReader {
  /**
   * An issue's state. `prState` reads the pulls endpoint, which answers null
   * for an issue number, so a reference to an issue needs its own read.
   */
  issueState: (repo: string, number: number) => Promise<"closed" | "open" | null>;
  /**
   * Whether the job(s) of step key `step` passed in the latest base-branch
   * build of the pipeline the check `buildkite/<pipeline>` names.
   */
  stepPassed: (check: string, step: string) => Promise<boolean | null>;
  /** The ticket's live state, labels and assignees, through the project's Tracker. */
  issueLive: (ticket: number) => Promise<IssueLive | null>;
  /** A PR's state and draft flag. */
  prDraft: (pr: number) => Promise<PrDraft | null>;
}

const sameCheck = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

const passes = (checks: { name: string; state: string }[] | null, name: string): boolean =>
  checks !== null && checks.some((check) => check.state === "pass" && sameCheck(check.name, name));

/**
 * Whether `park`'s condition holds now. `repo` resolves a bare `#n`
 * reference. Never throws: a failed read is "waiting".
 */
export async function evaluatePark(park: Park, reader: ParkReader, repo: string | null): Promise<ParkVerdict> {
  const condition = park.condition;
  // Shape errors are decided before any read, so they cost no request.
  if (condition.kind === "reference" && parseClearedBy(condition.ref, repo) === null) return "error";
  if (condition.kind === "check" && condition.on === "pr" && park.pr === null) return "error";
  try {
    switch (condition.kind) {
      case "reference": {
        const target = parseClearedBy(condition.ref, repo)!;
        const state = await reader.prState(target.repo, target.number);
        if (state === "merged" || state === "closed") return "woke";
        // An issue number reads as null on the pulls endpoint, so ask the
        // issues endpoint before calling it open.
        if (state === null && (await reader.issueState(target.repo, target.number)) === "closed") return "woke";
        return "waiting";
      }
      case "check": {
        if (condition.on === "pr") return passes(await reader.prChecks(park.pr!), condition.name) ? "woke" : "waiting";
        const head = await reader.baseChecks();
        return head !== null && passes(head.checks, condition.name) ? "woke" : "waiting";
      }
      case "step":
        return (await reader.stepPassed(condition.check, condition.step)) === true ? "woke" : "waiting";
      case "label-removed": {
        // Any `-blocked` label, not only the park's own: a ticket may wait on
        // another loop releasing it.
        const live = await reader.issueLive(park.ticket);
        return live !== null && !live.labels.includes(condition.label) ? "woke" : "waiting";
      }
    }
  } catch {
    // A read that cannot answer is no wake.
  }
  return "waiting";
}

/** A read whose every failure is "no answer", as backoff.ts's `quietly`. */
const quietly = async <T>(read: () => T | Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch {
    return null;
  }
};

/**
 * The real reads: `defaultProbeReader` for the three shared ones, bounded
 * `gh api` reads for issues and drafts, the Buildkite API for steps and the
 * project's Tracker for the ticket's live labels.
 */
export function defaultParkReader(env: Record<string, string | undefined>, cwd: string): ParkReader {
  const base = defaultProbeReader(env, cwd);
  const branch = env.RALPH_BASE_BRANCH?.trim() || "main";
  return {
    ...base,
    issueState: (repo, number) =>
      quietly(() => {
        const issue = ghJson(`repos/${repo}/issues/${number}`, env, cwd);
        return issue.state === "closed" ? "closed" : issue.state === "open" ? "open" : null;
      }),
    stepPassed: (check, step) =>
      quietly(async () => {
        const token = tokenFrom(env as NodeJS.ProcessEnv);
        // Spelt as `pipelineFromChecks` wants it: a `check` condition matches case-blind, so a step's should too.
        const pipeline = pipelineFromChecks([check.trim().toLowerCase()]);
        if (token === null || pipeline === null) return null;
        const api = new Buildkite(token);
        const org = await resolveOrg(api, env as NodeJS.ProcessEnv, pipeline);
        const builds = await api.json<Build[]>(
          `/organizations/${encodeURIComponent(org)}/pipelines/${encodeURIComponent(pipeline)}/builds?branch=${encodeURIComponent(branch)}&per_page=1`,
        );
        const latest = Array.isArray(builds) ? builds[0] : undefined;
        if (latest === undefined) return null;
        const jobs = jobsNamed(latest, step);
        // No such job in the latest build is no answer, not a pass.
        if (jobs.length === 0) return null;
        return jobs.every((job) => job.state === "passed");
      }),
    issueLive: (ticket) =>
      quietly(async () => {
        const tracker = createTracker(loadProjectConfig(cwd), { projectId: currentProjectId(cwd, env) });
        const live = await tracker.live(ticket);
        return { state: live.state, labels: live.labels, assignees: live.assignees };
      }),
    prDraft: (pr) =>
      quietly(() => {
        const repo = readProjectRepo(cwd);
        if (repo === null) return null;
        const got = ghJson(`repos/${repo}/pulls/${pr}`, env, cwd);
        const merged = got.merged === true || (typeof got.merged_at === "string" && got.merged_at !== "");
        const state = merged ? "merged" : got.state === "closed" ? "closed" : got.state === "open" ? "open" : null;
        if (state === null) return null;
        return { state, isDraft: got.draft === true };
      }),
  };
}

/* --------------------------------------------------------------------------
 * The sweep: walk every park, wake, drop or escalate.
 * ----------------------------------------------------------------------- */

/** Every write the sweep makes outside the store. Each throws on failure. */
export interface ParkWriter {
  /** Take a draft PR out of draft. */
  prReady: (pr: number) => void | Promise<void>;
  /** Take `label` off the ticket, through `tracker.ts`. */
  removeLabel: (ticket: number, label: string) => void | Promise<void>;
  /** One `push-notification.ts` call. */
  notify: Notify;
}

export interface SweepDeps {
  storePath: string;
  reader: ParkReader;
  writer: ParkWriter;
  now: () => string;
  /** Resolves a bare `#n` reference. */
  repo: string | null;
  /** The most remote reads one sweep may make (RALPH_PARK_SWEEP_READS). */
  readCap: number;
  /** A park checked this recently is skipped without a read. */
  minIntervalSeconds: number;
  log: (line: string) => void;
  /**
   * Whether a park recorded by `loop` is this project's to act on. The store
   * lives in git's common dir, so every worktree of one clone shares it, and
   * two projects on one clone (RALPH_PROJECT_ID) number their tickets in
   * different trackers: acting on the other project's park would read, drop
   * or unlabel the wrong ticket. Omitted, every park is this project's.
   */
  ownsLoop?: (loop: string) => boolean;
}

export interface SweepTally {
  parks: number;
  woke: number;
  dropped: number;
  escalated: number;
  waiting: number;
  errors: number;
  /** Checked within the minimum interval, so not read. */
  skipped: number;
  /** Recorded by a loop of another project; left alone. */
  foreign: number;
  /** Replaced by a newer park, or gone, between the read and the act. */
  raced: number;
  /** A write threw; the park stays and is retried after the interval. */
  failed: number;
  reads: number;
  capped: boolean;
}

export const DEFAULT_SWEEP_READS = 60;
export const DEFAULT_MIN_INTERVAL_SECONDS = 120;

/**
 * What one read costs against the cap. `baseChecks` is a head read plus its
 * check-runs and statuses; `stepPassed` resolves the org, then lists builds —
 * both several requests, and Buildkite's count as much as GitHub's (AC2).
 */
const READ_COST: Record<keyof ParkReader, number> = {
  prChecks: 1,
  baseChecks: 3,
  prState: 1,
  issueState: 1,
  stepPassed: 3,
  issueLive: 1,
  prDraft: 1,
};

/** The most `evaluatePark` can read for `park`'s condition, by `READ_COST`. */
const conditionCost = (park: Park): number => {
  const condition = park.condition;
  switch (condition.kind) {
    case "reference": return READ_COST.prState + READ_COST.issueState;
    case "check": return condition.on === "pr" ? READ_COST.prChecks : READ_COST.baseChecks;
    case "step": return READ_COST.stepPassed;
    // Answered from the ticket's labels, already read.
    case "label-removed": return 0;
  }
};

/** Thrown by a read the cap refused; the sweep stops at the next look at `capped`. */
class CapHit extends Error {}

/** `reader` with every call counted against `cap`. A call that would pass the cap is refused before it starts. */
function countedReader(reader: ParkReader, cap: number): { reader: ParkReader; fits: (cost: number) => boolean; state: { reads: number; capped: boolean } } {
  const state = { reads: 0, capped: false };
  const fits = (cost: number): boolean => {
    if (state.reads + cost > cap) state.capped = true;
    return !state.capped;
  };
  const counted = {} as Record<string, unknown>;
  for (const key of Object.keys(READ_COST) as (keyof ParkReader)[]) {
    const read = reader[key] as (...args: unknown[]) => Promise<unknown>;
    counted[key] = async (...args: unknown[]) => {
      if (!fits(READ_COST[key])) throw new CapHit("read cap");
      state.reads += READ_COST[key];
      return read(...args);
    };
  }
  return { reader: counted as unknown as ParkReader, fits, state };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The one page for a park whose budget ran out (AC7): the park's own fields, nothing read. */
export function escalationArgv(park: Park): string[] {
  const n = String(park.ticket);
  return [
    "push", "--kind", "ticket-blocked", "--priority", "high", "--ticket", n,
    "--occurrence", `park-expired:${n}:${park.since}`,
    "--subject", `Ticket #${n} parked 48h`,
    "--body", `${park.summary}\n\nwaiting on: ${JSON.stringify(park.condition)}`,
  ];
}

/** Never-checked first, then least recently checked, so a cap does not starve the same parks every sweep. */
const checkedAt = (park: ListedPark): number => {
  const at = park.lastChecked === null ? NaN : Date.parse(park.lastChecked);
  return Number.isFinite(at) ? at : -Infinity;
};

/**
 * One pass over every park. Every remote read happens outside `withStore`,
 * whose critical section is synchronous, so each act re-checks the park's
 * `since` inside the lock: a park replaced while this sweep read GitHub is
 * another wait, and is left alone. One park's failure is logged and never
 * stops the others; only a store that cannot be locked throws.
 */
export async function sweep(deps: SweepDeps): Promise<SweepTally> {
  const { storePath, writer, repo, log } = deps;
  const startedAt = deps.now();
  const parks = listStore(storePath, startedAt).sort((a, b) => checkedAt(a) - checkedAt(b));
  const counted = countedReader(deps.reader, deps.readCap);
  const reader = counted.reader;
  const tally: SweepTally = {
    parks: parks.length, woke: 0, dropped: 0, escalated: 0, waiting: 0, errors: 0, skipped: 0, foreign: 0, raced: 0, failed: 0, reads: 0, capped: false,
  };
  const intervalMs = deps.minIntervalSeconds * 1000;

  // A write or a store act on the park as read at `since`; false when it was replaced meanwhile.
  const mark = (park: Park): Promise<boolean> =>
    withStore(storePath, (store) => markChecked(store, park.ticket, park.since, deps.now()));
  const raced = (park: Park, what: string): void => {
    tally.raced += 1;
    log(`#${park.ticket}: replaced or unparked while it was read; not ${what}`);
  };

  for (const park of parks) {
    if (deps.ownsLoop !== undefined && !deps.ownsLoop(park.loop)) {
      tally.foreign += 1;
      continue;
    }
    const last = checkedAt(park);
    if (Number.isFinite(last) && Date.parse(deps.now()) - last < intervalMs) {
      tally.skipped += 1;
      continue;
    }
    // The cap is judged on the park's worst-case reads before the stamp, so
    // a cap never cuts a park halfway and stamps one it did not read.
    if (!counted.fits(READ_COST.issueLive + conditionCost(park))) break;
    // Re-read under the lock: another sweep may have checked it since this one listed the store.
    if (!(await withStore(storePath, (store) => claimCheck(store, park.ticket, park.since, deps.now(), intervalMs)))) {
      tally.skipped += 1;
      continue;
    }

    let live: IssueLive | null = null;
    try {
      live = await reader.issueLive(park.ticket);
    } catch {
      live = null;
    }
    if (counted.state.capped) break;

    // An unknown is no drop: a hiccup must not discard a live wait.
    if (live === null) {
      tally.waiting += 1;
      if (!(await mark(park))) raced(park, "marked checked");
      continue;
    }

    const labelGone = !live.labels.includes(park.label);
    const sameLabelWake = park.condition.kind === "label-removed" && park.condition.label === park.label;
    const claimed = live.assignees.length > 0 || live.labels.some((label) => label.endsWith("-wip"));
    // A person or another tool got there first. An assignee from before the
    // block also drops it (`tracker.ts blocked` never unassigns): the safe
    // direction, since the blocked label stays on in front of a person.
    if (live.state === "closed" || claimed || (labelGone && !sameLabelWake)) {
      const why = live.state === "closed" ? "closed" : claimed ? "claimed" : `${park.label} is gone`;
      if (await withStore(storePath, (store) => unparkIf(store, park.ticket, park.since))) {
        tally.dropped += 1;
        log(`#${park.ticket}: dropped, ${why}`);
      } else raced(park, "dropped");
      continue;
    }

    if (park.expired) {
      if (park.escalatedAt !== null) {
        tally.waiting += 1;
        if (!(await mark(park))) raced(park, "marked checked");
        continue;
      }
      // Stamped under the lock BEFORE the push: several loops sweep one
      // store, and only the one whose stamp lands pages.
      if (!(await withStore(storePath, (store) => markEscalated(store, park.ticket, park.since, deps.now())))) {
        raced(park, "escalated");
        continue;
      }
      tally.escalated += 1;
      try {
        await writer.notify(escalationArgv(park));
        log(`#${park.ticket}: parked past its budget; escalated`);
      } catch (error) {
        // Never retried: one lost page beats one on every sweep.
        log(`#${park.ticket}: escalation push failed and will not be retried: ${message(error)}`);
      }
      continue;
    }

    // The ticket's labels are already read; a label-removed condition asks for them again.
    const verdict = await evaluatePark(park, { ...reader, issueLive: async () => live }, repo);
    if (counted.state.capped) break;

    if (verdict !== "woke") {
      if (verdict === "error") {
        tally.errors += 1;
        log(`#${park.ticket}: the ${park.condition.kind} condition cannot be evaluated`);
      } else tally.waiting += 1;
      if (!(await mark(park))) raced(park, "marked checked");
      continue;
    }

    // The draft read is part of the wake; refuse it before acting rather than halfway.
    if (park.pr !== null && !counted.fits(READ_COST.prDraft)) break;
    if (!(await mark(park))) {
      raced(park, "woken");
      continue;
    }
    // Ready, then label, then unpark: the reverse of migration-applied.ts,
    // see the module header.
    try {
      if (park.pr !== null) {
        const draft = await reader.prDraft(park.pr);
        if (draft === null) throw new Error(`PR #${park.pr}'s draft state could not be read`);
        if (draft.state === "open" && draft.isDraft) await writer.prReady(park.pr);
      }
      await writer.removeLabel(park.ticket, park.label);
    } catch (error) {
      tally.failed += 1;
      log(`#${park.ticket}: woke, but a write failed; retried after the interval: ${message(error)}`);
      continue;
    }
    if (await withStore(storePath, (store) => unparkIf(store, park.ticket, park.since))) {
      tally.woke += 1;
      log(`#${park.ticket}: woke on its ${park.condition.kind} condition; ${park.label} removed`);
    } else raced(park, "unparked");
  }

  tally.reads = counted.state.reads;
  tally.capped = counted.state.capped;
  if (tally.capped) log(`read cap of ${deps.readCap} hit (RALPH_PARK_SWEEP_READS); the remaining parks wait for the next sweep`);
  return tally;
}

/* --------------------------------------------------------------------------
 * The real writer and the CLI.
 * ----------------------------------------------------------------------- */

const WRITE_TIMEOUT_MS = 60_000;

function run(what: string, command: string, args: string[], env: Record<string, string | undefined>, cwd: string): void {
  const out = spawnSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"], timeout: WRITE_TIMEOUT_MS });
  if (out.error) throw new Error(`${what}: ${out.error.message}`);
  if (out.status !== 0) throw new Error(`${what} exited ${out.status ?? out.signal}: ${(out.stderr ?? "").trim()}`);
}

/** `gh pr ready`, `tracker.ts label remove` and `push-notification.ts`, each bounded; a non-zero exit throws. */
export function defaultParkWriter(env: Record<string, string | undefined>, cwd: string, repo: string | null): ParkWriter {
  return {
    prReady: (pr) => run(`gh pr ready ${pr}`, "gh", ["pr", "ready", String(pr), ...(repo === null ? [] : ["-R", repo])], env, cwd),
    removeLabel: (ticket, label) =>
      run(`tracker.ts label remove ${ticket}`, process.execPath, [join(RALPH_HOME, "tracker.ts"), "label", "remove", String(ticket), label], env, cwd),
    notify: defaultNotify(env, cwd),
  };
}

/** A whole number at least `min`, else the default: a malformed knob must not stop the sweep. */
const knob = (raw: string | undefined, fallback: number, min: number): number => {
  const value = raw?.trim();
  return value && /^\d+$/.test(value) && Number(value) >= min ? Number(value) : fallback;
};

const USAGE = "usage: park-probe.ts sweep";

/**
 * `sweep` from the project's worktree. 0 whatever the parks said; 1 only when
 * the store cannot be locked or written; 64 on usage, as `park-store.ts`.
 */
export async function main(argv: string[], env: Record<string, string | undefined> = process.env, cwd = process.cwd()): Promise<number> {
  if (argv.length !== 1 || argv[0] !== "sweep") {
    console.error(USAGE);
    return 64;
  }
  const storePath = configuredParkStorePath(env, cwd);
  // Nothing parked is nothing to read: no reader, no request, no output.
  if (listStore(storePath).length === 0) return 0;
  const repo = readProjectRepo(cwd);
  const readCap = knob(env.RALPH_PARK_SWEEP_READS, DEFAULT_SWEEP_READS, 1);
  let loops: Set<string>;
  try {
    loops = new Set(loadProjectConfig(cwd).loops);
  } catch (error) {
    // Without the roster no park can be told this project's: act on none.
    console.log(`park-probe: the project config cannot be read, so no park is swept: ${message(error)}`);
    return 0;
  }
  try {
    const tally = await sweep({
      storePath,
      reader: defaultParkReader(env, cwd),
      writer: defaultParkWriter(env, cwd, repo),
      now: () => new Date().toISOString(),
      repo,
      readCap,
      minIntervalSeconds: knob(env.RALPH_PARK_MIN_INTERVAL_SECONDS, DEFAULT_MIN_INTERVAL_SECONDS, 0),
      // Printed as it happens: a sweep killed by its caller's timeout keeps what it did.
      log: (line) => console.log(`park-probe: ${line}`),
      ownsLoop: (loop) => loops.has(loop),
    });
    console.log(
      `park-probe: ${tally.parks} parked, ${tally.woke} woke, ${tally.dropped} dropped, ${tally.escalated} escalated, ` +
        `${tally.waiting} waiting, ${tally.errors} error, ${tally.skipped} skipped, ${tally.foreign} foreign, ${tally.raced} raced, ${tally.failed} failed, ` +
        `${tally.reads}/${readCap} reads${tally.capped ? ", capped" : ""}`,
    );
    return 0;
  } catch (error) {
    console.error(`park-probe: the park store cannot be used: ${message(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      console.error(`park-probe: ${message(error)}`);
      process.exitCode = 1;
    },
  );
}
