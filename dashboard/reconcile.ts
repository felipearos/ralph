/**
 * The loop reconciler: restart a loop whose supervisor died without choosing
 * an ending, and record every attempt where the page already reads.
 *
 * `ralph-dashboard.service` comes back by itself — `Restart=always` after an
 * oomd kill, `WantedBy=default.target` plus linger after a reboot — but the
 * loops it was supervising do not: nothing on the host starts them again, so
 * on 2026-10-19 one oomd kill left every loop dead until an operator noticed.
 * This module is what notices instead, as a pass on a timer and once at
 * startup, which is the pass that covers both of those failure modes.
 *
 * Three properties carry it, and each is a way to start a supervisor that
 * should not exist:
 *
 * 1. **Only a death, never an ending and never a doubt.** A loop is restarted
 *    when its record names no `stopReason` AND the process table says its
 *    supervisor is `dead`. `completed`, `blocked`, `failed` and `interrupted`
 *    are endings the loop chose, so they stay stopped — with one exception
 *    (#6, reversing #520's rule for shutdowns only): an `interrupted` the
 *    supervisor's own trap recorded on a SIGTERM BEFORE the host's current
 *    boot was the shutdown, not a choice, and a dead loop with that ending is
 *    restarted. A record that does not say who stopped it or with which
 *    signal, or a boot or stop time that cannot be read, stays stopped as
 *    before. Liveness `unknown` is
 *    "could not tell", which `classifyLoop` may still call `stale` on an old
 *    heartbeat — a heartbeat nobody could read is not evidence a supervisor is
 *    gone. A worktree with no record at all was never started here, so it is
 *    not restarted either.
 * 2. **The restart is the Start button's own path.** `gatedStart` into
 *    `start()`, exactly as `POST /api/p/<project>/start` calls it, so a
 *    restart cannot step around the new-agent gate, the supervisor lock or
 *    `start.sh`'s own duplicate prevention. A `prepareStart` refusal is an
 *    attempt like any other: recorded with its reason and counted, so a loop
 *    the gate keeps refusing stops being re-attempted rather than re-reading
 *    git every interval for ever.
 * 3. **The bound is read back from the records, never remembered.** At most
 *    `DEFAULT_ATTEMPTS` attempts per loop per `WINDOW_MS`, counted from the
 *    `loop-restarted` records in that loop's own feed. An in-memory counter
 *    would reset on every `Restart=always` cycle, which is precisely the cycle
 *    the bound exists for — so the process's own count is a SECOND ceiling
 *    beside the records, for the one case the records cannot cover: a push
 *    that could not be written leaves no attempt to count. A feed that cannot
 *    be read at all is not zero attempts, and the loop is left alone.
 *
 *    The attempts are deliberately NOT spaced out across the window. Three
 *    passes a minute apart therefore spend the bound in three minutes and the
 *    loop stays down for the remaining 57 — which is the cost of the rule
 *    #346 asked for ("it attempts again only once the hour has slid past"),
 *    and the alternative (a minimum gap of `WINDOW_MS / attempts`) would make
 *    three attempts in a row never reach the bound at all, which that ticket's
 *    acceptance criteria require. An operator who wants more attempts raises
 *    `RALPH_DASHBOARD_RESTART_ATTEMPTS`; the capped alert names the wait.
 *
 * Beside the deaths, a retry path: a `failed` stop on a transient fault
 * (`decide()`'s `retry`) is started again on `DEFAULT_RETRY_SCHEDULE_MINUTES`.
 * Its attempts are counted from its own `loop-retried` records raised after
 * `lastIterationEndAt` — a stretch, not a run, so a refused start or a
 * supervisor that exits before writing a record still counts. They are spaced,
 * unlike the restart bound, and a spent schedule raises one
 * `loop-retry-capped`. The kinds are separate from the restart path's, so the
 * two paths never spend each other's attempts.
 *
 * And one rule that is not the decision's: a stop nobody confirmed still on
 * the control record stops the restart, because a new supervisor adopts one
 * and exits on it — the ground `resumeWork` refuses to start over one.
 *
 * It reaches the harness the way every other adapter does — by CLI, through an
 * injected executor — because `read-only.test.ts` forbids the GUI from
 * importing ralph TypeScript. The one harness command it names is
 * `push-notification.ts push`; the migration watchdog beside it also reads two
 * things from `gh` (#434).
 */
import { readFileSync } from "node:fs";
import { gatedStart, type AgentsDeps } from "./agents";
import { defaultBunPath } from "./adapter";
import { rosterNames, type Env, type LoopRetryView, type RosterLoop, type StartResult } from "./contracts";
import { guarded, type Executor, type Invocation } from "./control-adapter";
import { readRecord, type LifecycleDeps } from "./lifecycle";
import type { LoopStateReport } from "./lifecycle-adapter";
import { raisedAt, raisedRows, type RawFile } from "./records";
import type { RecordsAdapter } from "./records-adapter";

/**
 * The reconciler's whole command surface — a closed list, asserted by a test.
 *
 * `RALPH_RUN_ID` is the DEAD run's id, and the three variables are set
 * together on purpose: unset, `push()` records `run: "adhoc"` and `loop: null`
 * and the record names nothing anybody can act on.
 */
export const RECONCILE_SURFACE = {
  push: {
    script: "push-notification.ts",
    args: ["push"],
    kinds: {
      restarted: "loop-restarted",
      capped: "loop-restart-capped",
      retried: "loop-retried",
      retryCapped: "loop-retry-capped",
      migrationStalled: "migration-applied-stalled",
    },
    env: { root: "RALPH_STATE_ROOT", loop: "RALPH_LOOP_NAME", run: "RALPH_RUN_ID" },
  },
  /**
   * The migration watchdog's two reads (#434), both run in a checkout of the
   * project so `gh` resolves the repository — and `{owner}/{repo}` — from it.
   * `{number}` is this module's placeholder, filled per pull request. The
   * events read prints one timestamp per apply; no `--slurp`, which `gh`
   * refuses beside `--jq`.
   */
  gh: {
    command: "gh",
    label: "migration-applied",
    list: ["pr", "list", "--state", "open", "--label", "migration-applied", "--json", "number,title,url"],
    events: [
      "api",
      "--paginate",
      "repos/{owner}/{repo}/issues/{number}/events",
      "--jq",
      '.[] | select(.event == "labeled" and .label.name == "migration-applied") | .created_at',
    ],
  },
  /**
   * The run the watchdog's alerts are keyed under. Fixed, not per process:
   * push-notification dedupes on `<run>:<occurrence>`, so a fixed run is what
   * keeps a dashboard restart from paging the same stalled PR again.
   */
  watchdog: { run: "migration-watchdog" },
} as const;

/** How often the pass runs, and the bound on attempts, when nothing says otherwise. */
export const DEFAULT_RECONCILE_MS = 60_000;
export const DEFAULT_ATTEMPTS = 3;
/** The window the bound counts over: an hour, as #329 asks for. */
export const WINDOW_MS = 3_600_000;
/** How long a PR may carry `migration-applied` before anyone is paged: an hour. */
export const DEFAULT_MIGRATION_ALERT_SECONDS = 3600;

/**
 * The gaps, in minutes, before each retry of a loop that stopped itself on a
 * transient fault: one gap before every attempt, so its length is the attempt
 * count. Spaced, unlike the dead-supervisor path's bound, because a transient
 * fault (a Doppler blip, a run that died for no reason it could name) needs
 * time to clear, and seven attempts in seven minutes would spend the bound on
 * the same outage.
 */
export const DEFAULT_RETRY_SCHEDULE_MINUTES = [5, 15, 45, 60, 60, 60, 60] as const;

/**
 * The `lastEvent` names a `failed` stop is retried for — transient faults, not
 * decisions. `secrets-env` is retried deliberately even though a local Doppler
 * scope problem raises it too and nothing there tells the two apart: the bound
 * turns the local case into seven retries and one alert, instead of a loop that
 * is down in silence. `preflight-denied` is here only when every check it
 * recorded is `doppler-scope` (`retryCause`); a missing signal is never
 * retried, per CLAUDE.md.
 *
 * `preflight-broken` is the stop a supervisor recorded, before #767, when the
 * preflight could not run at all — `bun: Text file busy` while bun was being
 * replaced, on 2026-11-10 — which says nothing about the loop's requirements.
 * Today's supervisor waits on it instead and never records it as a stop, so
 * this retries only a loop an older harness stopped that way. A `buildkite-logs`
 * denial an older harness raised over an unread token is NOT here: nothing in
 * its record tells it from a token that is really missing.
 */
export const RETRYABLE_EVENTS = ["secrets-env", "no-sigil", "preflight-denied", "preflight-broken"] as const;

/**
 * The two numbers an operator can move, read here rather than in
 * `config.ts`: they are this module's bounds, and `config.ts` is the
 * import-free module that says where the server listens and what it observes.
 */
export const RECONCILE_ENV = {
  interval: "RALPH_DASHBOARD_RECONCILE_MS",
  attempts: "RALPH_DASHBOARD_RESTART_ATTEMPTS",
  retrySchedule: "RALPH_DASHBOARD_RETRY_SCHEDULE",
  migrationAlert: "RALPH_MIGRATION_ALERT_SECONDS",
} as const;

export interface ReconcileConfig {
  /** 0 switches the reconciler off: no pass runs, not even the startup one. */
  intervalMs: number;
  attempts: number;
  /** The retry gaps in minutes; see `DEFAULT_RETRY_SCHEDULE_MINUTES`. */
  retryScheduleMinutes: number[];
  /** Seconds a PR may carry `migration-applied` before the watchdog pages. */
  migrationAlertSeconds: number;
}

/**
 * The reconciler's configuration out of the environment.
 *
 * An interval of exactly `0` is the off switch, and it is a real requirement
 * rather than a convenience: a reconciler left on starts loops, so anything
 * that boots a dashboard it does not want supervising — the suite's own HTTP
 * tests, an operator debugging a second instance beside the live one — has to
 * be able to say no, and stopping the whole service to do it would take the
 * page and every route with it.
 *
 * Any other value that is not a positive integer falls back to the default and
 * says so: this runs with nobody watching, and a typo that silently became a
 * pass per event-loop turn, or a loop nothing ever restarts, would both be
 * worse than an ignored variable. The retry schedule follows the same rule: a
 * malformed one falls back to the default gaps rather than to no retry at all,
 * because a loop down in silence is the stuck loop CLAUDE.md forbids.
 */
export function reconcileConfigFromEnv(env: Env, log: (line: string) => void = () => undefined): ReconcileConfig {
  const number = (name: string, fallback: number, off: boolean): number => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (off && value === 0) return 0;
    if (!Number.isInteger(value) || value <= 0) {
      log(`ralph-dashboard: ${name} must be a positive integer${off ? " (or 0 to switch the reconciler off)" : ""}; got '${raw}' — using ${String(fallback)}`);
      return fallback;
    }
    return value;
  };
  const schedule = (): number[] => {
    const fallback = [...DEFAULT_RETRY_SCHEDULE_MINUTES];
    const raw = env[RECONCILE_ENV.retrySchedule];
    if (raw === undefined) return fallback;
    const items = raw.split(",").map((item) => item.trim());
    // A digit regex rather than `Number()`: `Number` reads "", "1e1" and "0x5"
    // as numbers, and each of those is a typo here, not a gap.
    if (!items.every((item) => /^[0-9]+$/.test(item) && Number(item) > 0)) {
      log(`ralph-dashboard: ${RECONCILE_ENV.retrySchedule} must be comma-separated positive integers (minutes); got '${raw}' — using ${fallback.join(",")}`);
      return fallback;
    }
    return items.map(Number);
  };
  return {
    intervalMs: number(RECONCILE_ENV.interval, DEFAULT_RECONCILE_MS, true),
    attempts: number(RECONCILE_ENV.attempts, DEFAULT_ATTEMPTS, false),
    retryScheduleMinutes: schedule(),
    // No off switch: a watchdog nobody can see is off is the stall it exists
    // to catch, so a 0 falls back like any other bad value.
    migrationAlertSeconds: number(RECONCILE_ENV.migrationAlert, DEFAULT_MIGRATION_ALERT_SECONDS, false),
  };
}

/**
 * What an attempt ended as. `restarted` is a new supervisor; `already-running`
 * is `start.sh`'s own worktree lock saying no, which starts nothing; `refused`
 * is the start gate's (`prepareStart`); `failed` is anything else, including
 * an executor that could not run at all.
 */
export const RESTART_OUTCOMES = ["restarted", "already-running", "refused", "failed"] as const;
export type RestartOutcome = (typeof RESTART_OUTCOMES)[number];

/** One loop the pass considers: what to read it with, and what to start it with. */
export interface ReconcileTarget {
  /** The project's registry id, as the records and the page name it. */
  project: string;
  loop: string;
  worktree: string;
  /** The same deps `/api/start` builds for this loop's checkout. */
  lifecycle: LifecycleDeps;
  /** The same deps the start route gates with. */
  agents: AgentsDeps;
}

/**
 * The reconciler's and the migration watchdog's commands, as operations that
 * answer and never reject: both run on a timer with nobody watching, and a
 * rejection would end the pass for every other loop and project.
 */
export interface ReconcileAdapter {
  /** Write one record with `push-notification.ts push`. */
  push(input: PushInput): Promise<PushOutcome>;
  /** The open `migration-applied` PRs of the project checked out at `worktree`. */
  listMigrations(worktree: string): Promise<MigrationListOutcome>;
  /** When `pr` was last labelled `migration-applied`, as `gh` prints it. */
  appliedAt(worktree: string, pr: number): Promise<AppliedAtOutcome>;
}

/** Whether the record was written; `why` is what the push printed, or its status. */
export type PushOutcome = { ok: true } | { ok: false; why: string };

/** One open `migration-applied` PR, as `gh pr list --json` names it. */
export interface MigrationPr {
  number: number;
  title: string;
  url: string;
}

/** The PRs, or what `gh` said (its status when it said nothing) when they could not be read. */
export type MigrationListOutcome = { prs: MigrationPr[] } | { problem: string };

/** The newest apply's timestamp, or `gh`'s stderr — possibly empty — when there is none readable. */
export type AppliedAtOutcome = { at: string } | { problem: string };

export interface PushInput {
  kind: string;
  occurrence: string;
  subject: string;
  body: string;
  priority: "normal" | "high";
  /** The loop's worktree: where the record is written. */
  worktree: string;
  loop: string;
  /** The dead run, which the record is keyed and attributed to. */
  run: string;
  /** A retry's attempt number, the schedule's length and the cause, as `push --retry-*` carries them. */
  retry?: { attempt: number; of: number; cause: string };
}

export interface ReconcileAdapterConfig {
  /** Absolute directory holding the ralph CLI scripts. */
  cliDir: string;
  bunPath?: string;
  env?: Env;
  /** Runs every command; wrapped in `guarded` so a throw is a failed answer, never a rejection. */
  exec: Executor;
}

/**
 * The adapter the reconciler and the migration watchdog run their commands
 * through. It owns the executor, so neither pass wraps a command in a
 * try/catch: every operation resolves to its failure answer instead.
 */
export function createReconcileAdapter(config: ReconcileAdapterConfig): ReconcileAdapter {
  const bunPath = config.bunPath ?? defaultBunPath();
  const baseEnv: Env = { ...process.env, ...config.env };
  const run = guarded(config.exec);
  const push = RECONCILE_SURFACE.push;
  const gh = RECONCILE_SURFACE.gh;
  const pushInvocation = (input: PushInput): Invocation => ({
    command: bunPath,
    args: [
      `${config.cliDir}/${push.script}`,
      ...push.args,
      "--kind",
      input.kind,
      "--occurrence",
      input.occurrence,
      "--subject",
      input.subject,
      "--body",
      input.body,
      "--priority",
      input.priority,
      ...(input.retry === undefined
        ? []
        : [
            "--retry-attempt",
            String(input.retry.attempt),
            "--retry-of",
            String(input.retry.of),
            "--retry-cause",
            input.retry.cause,
          ]),
    ],
    cwd: input.worktree,
    env: {
      ...baseEnv,
      [push.env.root]: input.worktree,
      [push.env.loop]: input.loop,
      [push.env.run]: input.run,
    },
  });
  return {
    push: async (input) => {
      const result = await run(pushInvocation(input));
      return result.status === 0 ? { ok: true } : { ok: false, why: result.stderr.trim() || String(result.status) };
    },
    listMigrations: async (worktree) => {
      const listed = await run({ command: gh.command, args: [...gh.list], cwd: worktree, env: baseEnv });
      const prs = listed.status === 0 ? parsePrs(listed.stdout) : null;
      return prs === null ? { problem: listed.stderr.trim() || String(listed.status) } : { prs };
    },
    appliedAt: async (worktree, pr) => {
      const read = await run({
        command: gh.command,
        args: gh.events.map((arg) => arg.replace("{number}", String(pr))),
        cwd: worktree,
        env: baseEnv,
      });
      // The LAST line is the newest apply: a label removed and put back marks
      // a fresh apply, and the wait is counted from it.
      const at = read.status === 0 ? (read.stdout.trim().split("\n").at(-1)?.trim() ?? "") : "";
      return at === "" || Number.isNaN(Date.parse(at)) ? { problem: read.stderr.trim() } : { at };
    },
  };
}

/** One project as the pass walks it: its registry id, and its own local read. */
export interface ReconcileProject {
  project: string;
  /**
   * The project's local read (`loop-state status --json` plus the roster,
   * no `gh`), as `createRalphAdapter(...).readLocal()` answers it.
   */
  read: () => Promise<{ loops: readonly { identity: string | null; worktree: string }[] }>;
}

/**
 * The targets for one pass: every loop of every registered project, with what
 * to read and start each one through.
 *
 * Extracted from `main()` rather than written there because a registry walk is
 * logic — a dropped loop or a project id gone astray would ship invisibly in
 * a function the ticket exempts from testing. A project whose read throws is
 * logged and skipped: the other projects' loops are still recovered. Given
 * `said`, the failure is logged once per reason and its recovery once.
 */
export async function targetsFrom(
  projects: readonly ReconcileProject[],
  build: (target: { project: string; loop: string; worktree: string }) => Pick<ReconcileTarget, "lifecycle" | "agents">,
  log: (line: string) => void = () => undefined,
  said?: Said,
): Promise<ReconcileTarget[]> {
  const found = await Promise.all(
    projects.map(async (entry): Promise<ReconcileTarget[]> => {
      const key = `read:${entry.project}`;
      let loops: readonly { identity: string | null; worktree: string }[];
      try {
        loops = (await entry.read()).loops;
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        // Every pass reads every project again — that IS the retry — but a
        // project that stays unreadable is said once, not once a minute.
        if (said === undefined) log(`reconcile: could not read ${entry.project}: ${why}`);
        else sayOnce(said, key, why, `reconcile: could not read ${entry.project}: ${why}`, log);
        return [];
      }
      // The recovery is said once too, so a logged failure is never the last
      // word on a project that came back.
      if (said?.delete(key) === true) log(`reconcile: ${entry.project} is readable again`);
      return loops.flatMap((loop) => {
        // A worktree the roster attributes to no loop cannot be started by
        // name, and `start.sh` would refuse it; it is not a target.
        if (loop.identity === null) return [];
        const target = { project: entry.project, loop: loop.identity, worktree: loop.worktree };
        return [{ ...target, ...build(target) }];
      });
    }),
  );
  return found.flat();
}

/**
 * What this PROCESS last logged per key (`read:<project>`, `loop:<project>/<loop>`):
 * the reason, so a state that persists across passes is said once rather than
 * every minute, and a changed reason is said again. Per process on purpose: a
 * dashboard restart says each standing state once more, which is the journal
 * line an operator looking after a reboot needs.
 */
export type Said = Map<string, string>;

/** Logs `line` only when `reason` is not what was last logged for `key`. */
function sayOnce(said: Said, key: string, reason: string, line: string, log: (line: string) => void): void {
  if (said.get(key) === reason) return;
  said.set(key, reason);
  log(line);
}

/** A project as the watchdog walk reads it: the local read with its roster. */
export interface WatchProject {
  project: string;
  read: () => Promise<{ roster: readonly RosterLoop[]; loops: readonly { identity: string | null; worktree: string }[] }>;
}

/**
 * The migration watchdog's projects: one entry per registered project, with
 * the root `watchRoot` picks from its roster and worktrees. A project whose
 * read fails is logged and left out of this pass — the next tick reads it
 * again — so one broken project never keeps the others from being watched.
 */
export async function watchProjectsFrom(
  projects: readonly WatchProject[],
  log: (line: string) => void = () => undefined,
  said?: Said,
): Promise<MigrationWatchDeps["projects"]> {
  const found = await Promise.all(
    projects.map(async (entry): Promise<MigrationWatchDeps["projects"]> => {
      const key = `watch:${entry.project}`;
      try {
        const { roster, loops } = await entry.read();
        said?.delete(key);
        return [{ project: entry.project, root: watchRoot(loops, rosterNames(roster)) }];
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        // It runs after every reconcile pass over the same reads, so a project
        // that stays unreadable is said once here too, not every minute (#765).
        if (said === undefined) log(`migration-watchdog: could not read ${entry.project}: ${why}`);
        else sayOnce(said, key, why, `migration-watchdog: could not read ${entry.project}: ${why}`, log);
        return [];
      }
    }),
  );
  return found.flat();
}

export interface ReconcileDeps {
  /** The loops to consider: the registry's worktrees, as the server walks them. */
  targets: () => Promise<readonly ReconcileTarget[]> | readonly ReconcileTarget[];
  /** The loop's own records, which the bound is counted from. */
  records: (worktree: string) => Pick<RecordsAdapter, "readFeed">;
  adapter: ReconcileAdapter;
  now?: () => Date;
  /** The bound: attempts per loop per window. Defaults to `DEFAULT_ATTEMPTS`. */
  attempts?: number;
  windowMs?: number;
  /**
   * The gaps, in minutes, before each retry of a loop that stopped itself on
   * a transient fault (`Verdict.retry`). Defaults to
   * `DEFAULT_RETRY_SCHEDULE_MINUTES`; its length is the attempt count.
   */
  retrySchedule?: readonly number[];
  /**
   * What this PROCESS remembers per worktree: the bound's second ceiling.
   * Handed in rather than kept here so it survives between passes without the
   * module holding state, and so a test can see it. Absent, only the records
   * bound the restarts — which is the whole bound when the dashboard has just
   * come back, and not enough when a push cannot be written.
   */
  seen?: Seen;
  /**
   * The retry path's own second ceiling, for the same reason as `seen`: a
   * retry whose push fails writes no `loop-retried` record, and counted from
   * the records alone the schedule would never be spent. Its own map, never
   * `seen`, because the two paths do not share a bound.
   */
  retrySeen?: RetrySeen;
  /**
   * What this process has already said about a loop left down. Absent, those
   * skips stay silent, as they were before #765; present, each is logged once
   * per reason, because a down loop with no line anywhere is how three
   * projects stayed down after a reboot unnoticed.
   */
  said?: Said;
  /**
   * When the host booted, in epoch milliseconds, or null when it cannot be
   * read. A self-recorded SIGTERM `interrupted` older than this was the host
   * shutdown and is restarted (#6). Defaults to `readBootTimeMs`; injected so
   * a test never reads the real host.
   */
  bootTime?: () => number | null;
  log?: (line: string) => void;
}

/**
 * The host's boot time from `/proc/stat`'s `btime` line, in epoch
 * milliseconds, or null when it cannot be read. Never throws: a boot time
 * nobody could read only means a shutdown's stop is not restarted.
 */
export function readBootTimeMs(read: () => string = () => readFileSync("/proc/stat", "utf8")): number | null {
  try {
    const match = /^btime (\d+)$/m.exec(read());
    if (match === null) return null;
    const ms = Number(match[1]) * 1000;
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/**
 * What one process remembers about one worktree: when it attempted a restart,
 * and when it last said the bound was reached.
 *
 * Times, not a count, because the bound is per WINDOW: a count would never age
 * out, so a loop that spent its three attempts would be capped for as long as
 * the dashboard ran and its hourly bound would quietly become a permanent one.
 * `cappedAt` is remembered for the same reason the attempts are — with pushes
 * failing there is no record to key the capped stretch to, and without it the
 * alert would be attempted again on every pass.
 */
export interface SeenAttempts {
  /** Epoch milliseconds, newest last, pruned to the window on every read. */
  attempts: number[];
  cappedAt: number | null;
}

/** The second ceiling, by worktree. `main()` owns one for the process's life. */
export type Seen = Map<string, SeenAttempts>;

/**
 * The retry path's second ceiling, by worktree: when this process attempted a
 * retry and when it raised the cap, in epoch milliseconds. Pruned to the
 * stretch (after `lastIterationEndAt`) rather than to a window, as the
 * records it stands beside are counted.
 */
export type RetrySeen = Map<string, { attempts: number[]; cappedAt: number | null }>;

/** One restart attempt, as the pass reports it and the record carries it. */
export interface ReconcileAttempt {
  project: string;
  loop: string;
  worktree: string;
  /** The run that died. */
  run: string;
  at: string;
  outcome: RestartOutcome;
  why: string;
  /** The new supervisor's pid, when one was started. */
  pid: number | null;
  /** Set on the retry path: which attempt of the schedule this was, and why. */
  retry?: { attempt: number; of: number; cause: string };
}

/** What one pass did. Nothing here is remembered: the next pass reads again. */
export interface ReconcilePass {
  at: string;
  considered: number;
  attempts: ReconcileAttempt[];
  /** Loops the bound held this pass, and whether this pass raised its one alert. */
  capped: { loop: string; project: string; attempts: number; alerted: boolean; retry?: true }[];
  /** Loops left alone, with the reading that left them. */
  skipped: { loop: string; project: string; why: string }[];
}

/** Whether this loop is a death to undo, or a state to leave alone. */
export type Verdict =
  /** `shutdown` marks a loop the host shutdown stopped before this boot (#6). */
  | { restart: true; reason: string; shutdown?: true }
  /** `retry` marks a stop the loop chose on a transient fault, and names the event it is retried for. */
  | { restart: false; why: string; retry?: { cause: string } };

/**
 * The event a `failed` stop is retried for, or null when it is not retryable.
 * A `preflight-denied` counts only when its recorded checks (comma-separated,
 * as `ralph.sh` writes them) are all `doppler-scope`: one local-config check,
 * an empty item or no checks at all, and it is a stop for a human.
 */
const retryCause = (report: LoopStateReport): string | null => {
  const event = report.lastEvent;
  if (report.stopReason?.kind !== "failed" || event === undefined) return null;
  if (!(RETRYABLE_EVENTS as readonly string[]).includes(event.name)) return null;
  if (event.name !== "preflight-denied") return event.name;
  const checks = (event.detail ?? "").split(",").map((check) => check.trim());
  return checks.every((check) => check === "doppler-scope") ? event.name : null;
};

/**
 * The decision, over one reading of `loop-state status --json`.
 *
 * Narrower than the status word on purpose: `classifyLoop` answers `stale` for
 * liveness `unknown` with an old heartbeat, and a heartbeat the reconciler
 * could not read says nothing about whether the supervisor is still there.
 */
export function decide(report: LoopStateReport, bootMs: number | null = null): Verdict {
  if (!report.recorded) return { restart: false, why: "no durable record: this worktree was never started" };
  if (report.stopReason !== null) {
    const why = `the loop ended: ${report.stopReason.kind} — ${report.stopReason.why}`;
    if (report.stopReason.kind === "interrupted") return decideInterrupted(report, report.stopReason, why, bootMs);
    const cause = retryCause(report);
    return cause === null ? { restart: false, why } : { restart: false, why, retry: { cause } };
  }
  if (report.liveness === "alive") return { restart: false, why: "supervisor alive" };
  if (report.liveness !== "dead") return { restart: false, why: `supervisor ${report.liveness}: ${report.why}` };
  return {
    restart: true,
    reason: `supervisor ${report.pid === null ? "(pid unrecorded)" : String(report.pid)} gone, no stopReason`,
  };
}

/**
 * An `interrupted` ending (#6): restarted only when the supervisor's own trap
 * recorded a SIGTERM before the host's current boot — the shutdown stopped it,
 * nobody chose to. A manual kill after boot, an operator's Stop, SIGINT or
 * SIGHUP, and every record that cannot prove the shutdown stay stopped.
 */
function decideInterrupted(
  report: LoopStateReport,
  stop: NonNullable<LoopStateReport["stopReason"]>,
  why: string,
  bootMs: number | null,
): Verdict {
  if (stop.self === undefined || (stop.self === true && stop.signal === undefined)) {
    return {
      restart: false,
      why: `${why}; its record does not say which signal stopped it or who recorded it, so it stays stopped as before`,
    };
  }
  if (stop.self !== true || stop.signal !== "SIGTERM") return { restart: false, why };
  if (bootMs === null) return { restart: false, why: `${why}; the host's boot time could not be read, so it stays stopped` };
  const stoppedAt = Date.parse(stop.at);
  if (Number.isNaN(stoppedAt)) return { restart: false, why: `${why}; its stop time could not be read, so it stays stopped` };
  if (stoppedAt >= bootMs) return { restart: false, why };
  // Liveness exactly as the no-stopReason path reads it: a supervisor that is
  // there, or could not be seen, is never started beside.
  if (report.liveness === "alive") return { restart: false, why: "supervisor alive" };
  if (report.liveness !== "dead") return { restart: false, why: `supervisor ${report.liveness}: ${report.why}` };
  return { restart: true, reason: "stopped by the host shutdown before this boot", shutdown: true };
}

/** How a `start.sh` answer reads as an attempt's outcome. */
const outcomeOf = (result: StartResult): RestartOutcome => {
  switch (result.outcome) {
    case "started":
      return "restarted";
    case "already-running":
      return "already-running";
    case "refused":
      return "refused";
    default:
      return "failed";
  }
};

const bodyOf = (attempt: ReconcileAttempt, reason: string): string =>
  [
    `project: ${attempt.project}`,
    `loop: ${attempt.loop}`,
    `worktree: ${attempt.worktree}`,
    `dead run: ${attempt.run}`,
    `reason: ${reason}`,
    `outcome: ${attempt.outcome}${attempt.pid === null ? "" : ` (pid ${String(attempt.pid)})`} — ${attempt.why}`,
  ].join("\n");

/**
 * One pass over every target: read, decide, and restart what died.
 *
 * A target that throws is reported as skipped and nothing else: this runs on a
 * timer with nobody watching, so one unreadable worktree may not stop the
 * others from being recovered.
 */
export async function reconcile(deps: ReconcileDeps): Promise<ReconcilePass> {
  const now = deps.now ?? ((): Date => new Date());
  const limit = deps.attempts ?? DEFAULT_ATTEMPTS;
  const windowMs = deps.windowMs ?? WINDOW_MS;
  const log = deps.log ?? ((): void => undefined);
  // Read once per pass: the boot time does not change within one. A throwing
  // injected reader is a boot time nobody could read, never a failed pass.
  const bootMs = ((): number | null => {
    try {
      return (deps.bootTime ?? readBootTimeMs)();
    } catch {
      return null;
    }
  })();
  const pass: ReconcilePass = { at: now().toISOString(), considered: 0, attempts: [], capped: [], skipped: [] };
  let targets: readonly ReconcileTarget[];
  try {
    targets = await deps.targets();
  } catch (error) {
    log(`reconcile: could not list the loops: ${error instanceof Error ? error.message : String(error)}`);
    return pass;
  }
  for (const target of targets) {
    pass.considered += 1;
    const skip = (why: string): void => {
      pass.skipped.push({ loop: target.loop, project: target.project, why });
    };
    /**
     * A skip the operator needs to know about: the loop IS dead and the
     * reconciler declined to recover it. An alive supervisor says nothing; an
     * ending on a dead one is said once per reason through `said` (#765). These
     * two leave a loop down for a reason the reconciler itself holds, and
     * `pass.skipped` reaches nobody: `main()` drops the pass's answer, because
     * nothing in the server reads it.
     */
    const declined = (why: string): void => {
      skip(why);
      log(`reconcile: ${target.project}/${target.loop} is down and was NOT restarted: ${why}`);
    };
    try {
      // Through the loop's OWN lifecycle adapter, the one the start route
      // reads it with: its guarded executor turns a worktree whose read throws
      // into `unknown`, which is never a restart, rather than failing the pass
      // for every other loop.
      const report = await target.lifecycle.lifecycle.loopState();
      const verdict = decide(report, bootMs);
      const saidKey = `loop:${target.project}/${target.loop}`;
      // Keyed on the run as well as the reason, so a loop restarted by hand
      // that dies again the same way between two passes is said again.
      const sayLoop = (reason: string, line: string): void => {
        if (deps.said !== undefined) sayOnce(deps.said, saidKey, `${report.run ?? ""}\0${reason}`, `reconcile: ${target.project}/${target.loop} ${line}`, log);
      };
      // A loop that is up again, or that the pass acts on, forgets what was
      // said about it, so a later identical death is said again.
      if (report.liveness === "alive") deps.said?.delete(saidKey);
      if (!verdict.restart) {
        if (verdict.retry === undefined) {
          skip(verdict.why);
          // The two skips that leave a loop down with nobody told: an ending
          // on a dead supervisor (a SIGTERM at shutdown records `interrupted`,
          // which stays stopped only when it does not predate this boot or its
          // record cannot prove the shutdown — #6 restarts the rest, reversing
          // #520's rule for shutdowns only), and a supervisor that could not be
          // seen. A worktree with no record reads `unknown` too, whether it
          // was never started or its read failed, and the two cannot be told
          // apart here, so it stays silent with live supervisors.
          if (report.recorded && report.liveness === "dead") sayLoop(verdict.why, `is down and stays stopped: ${verdict.why}`);
          else if (report.recorded && report.liveness === "unknown") {
            sayLoop(
              verdict.why,
              report.stopReason === null
                ? `could not be seen, so it is left alone: ${verdict.why}`
                : `has an ending and its supervisor could not be seen, so it is left alone: ${verdict.why}`,
            );
          }
        }
        // A retryable stop on a supervisor that is still there, or that could
        // not be seen, waits: a start now could land beside a live one.
        else if (report.liveness !== "dead") {
          const why = `${verdict.why}; supervisor ${report.liveness}, so the retry waits`;
          skip(why);
          if (report.liveness === "unknown") sayLoop(why, `could not be seen, so the retry waits: ${why}`);
        } else {
          deps.said?.delete(saidKey);
          await retryStopped(deps, target, report, { why: verdict.why, cause: verdict.retry.cause }, pass, { skip, declined });
        }
        continue;
      }
      deps.said?.delete(saidKey);
      // A stop the supervisor never confirmed is still on the record, and a
      // new supervisor ADOPTS one and exits on it — which is why `resumeWork`
      // refuses to start over one (`lifecycle.ts`). The oomd kill this feature
      // exists for can land in exactly that gap: Stop now signalled the
      // process group and the confirming write never happened, leaving
      // `stopReason: null` with a pending stop. Restarting then would record a
      // restart that immediately exited.
      const pending = await pendingStop(target);
      if (pending !== null) {
        declined(pending);
        continue;
      }
      // `recorded` is true here, so the record named a run; the fallback keeps
      // the push attributable rather than letting it record `adhoc`.
      const dead = report.run ?? "unknown-run";
      const past = pastAttempts(deps, target, now().getTime(), windowMs);
      if (past === null) {
        // The bound is counted from this file. Unreadable, the count would
        // read as zero and nothing would bound the restarts at all, so the
        // loop is left alone until it can be read.
        declined(`cannot read ${target.loop}'s notification feed, so the restart bound cannot be counted`);
        continue;
      }
      const remembered = recall(deps.seen, target.worktree, now().getTime() - windowMs);
      const attemptsNow = Math.max(past.attempts.length, remembered.attempts.length);
      if (attemptsNow >= limit) {
        const alerted = await raiseCap(deps, target, dead, past, remembered, limit, windowMs);
        pass.capped.push({ loop: target.loop, project: target.project, attempts: attemptsNow, alerted });
        continue;
      }
      if (verdict.shutdown === true) {
        log(`reconcile: ${target.project}/${target.loop} was stopped by the host shutdown before this boot — restarting`);
      }
      const at = now().toISOString();
      const started = await startTarget(target);
      const attempt: ReconcileAttempt = {
        project: target.project,
        loop: target.loop,
        worktree: target.worktree,
        run: dead,
        at,
        outcome: outcomeOf(started),
        why: started.why,
        pid: started.pid,
      };
      pass.attempts.push(attempt);
      // The second ceiling, for the one way the first can be lost: the record
      // below is what the bound counts, and a push that fails writes nothing.
      // Memory alone would be no bound at all (`Restart=always` resets it on
      // the very cycle the bound exists for); memory BESIDE the records bounds
      // a runaway whose records are never written.
      remembered.attempts.push(Date.parse(at));
      // The attempt's timestamp is in the occurrence key because the push
      // record dedupes on `<run>:<occurrence>`, and a loop that dies before it
      // writes a new `state.json` keeps the old run id: without the timestamp
      // a second restart would be dropped, and the bound — which counts these
      // records — would never trip.
      await push(deps, {
        kind: RECONCILE_SURFACE.push.kinds.restarted,
        occurrence: `${RECONCILE_SURFACE.push.kinds.restarted}:${target.project}:${target.loop}:${at}`,
        subject: `${target.loop} (${target.project}): restart ${attempt.outcome}`,
        body: bodyOf(attempt, verdict.reason),
        priority: attempt.outcome === "restarted" ? "normal" : "high",
        worktree: target.worktree,
        loop: target.loop,
        run: dead,
      });
      log(`reconcile: ${target.project}/${target.loop} ${attempt.outcome}: ${attempt.why}`);
    } catch (error) {
      skip(`could not be reconciled: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return pass;
}

/**
 * Why a start now would be undone at once, or null: a stop on the control
 * record nobody confirmed, which a new supervisor adopts and exits on.
 */
async function pendingStop(target: ReconcileTarget): Promise<string | null> {
  const stop = (await readRecord(target.lifecycle))?.stop ?? null;
  if (stop === null || stop.confirmation === "confirmed") return null;
  return `an earlier ${stop.kind} stop is still ${stop.confirmation} on the record — a new supervisor would adopt it and exit`;
}

/**
 * The one start both paths make: the Start button's own gated path, so the
 * restart and the retry are pinned to it together (`read-only.test.ts`).
 */
const startTarget = (target: ReconcileTarget): Promise<StartResult> =>
  gatedStart(target.agents, target.lifecycle, { name: target.loop, worktree: target.worktree });

/** A parsed time, or null for one that is absent or will not parse. */
const parsedMs = (at: string | undefined): number | null => {
  if (at === undefined) return null;
  const parsed = Date.parse(at);
  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * Where a loop stands on the retry schedule, for the page: the newest
 * `loop-retried` record raised after `lastIterationEndAt`, the bound
 * `retryStopped` counts within, so the page reads the stretch the reconciler
 * counts. It reads only the records, though: a malformed row, which the
 * reconciler still counts, is skipped here, and the reconciler's in-process
 * `retrySeen` is invisible to the page, so with pushes failing the page can
 * lag the reconciler's count. The attempt is the record's own, not a count of
 * rows: a record the feed lost would otherwise move the page off the number
 * the alert said. Pure — the clock, the env and the feed's I/O are the
 * caller's — and null when there is nothing to show or the feed is unreadable.
 */
export function retryView(
  feed: RawFile,
  lastIterationEndAt: string | null | undefined,
  scheduleMinutes: readonly number[],
): LoopRetryView | null {
  const rows = raisedRows(feed, RECONCILE_SURFACE.push.kinds.retried);
  if (rows === null) return null;
  const boundaryMs = parsedMs(lastIterationEndAt ?? undefined);
  const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;
  let newest: { atMs: number; attempt: number; of: number; cause: string } | null = null;
  for (const row of rows) {
    // A malformed record is skipped rather than shown: a wrong attempt on the
    // page is worse than the next well-formed one.
    const atMs = parsedMs(row.at);
    const retry = row.retry;
    if (atMs === null || typeof retry !== "object" || retry === null) continue;
    const { attempt, of, cause } = retry as Record<string, unknown>;
    if (!isCount(attempt) || !isCount(of) || typeof cause !== "string" || cause === "") continue;
    if (boundaryMs !== null && atMs <= boundaryMs) continue;
    if (newest === null || atMs > newest.atMs) newest = { atMs, attempt, of, cause };
  }
  if (newest === null) return null;
  const gap = scheduleMinutes[newest.attempt];
  const { attempt, of, cause } = newest;
  return gap === undefined
    ? { attempt, of, cause, nextAt: null, spent: true }
    : { attempt, of, cause, nextAt: new Date(newest.atMs + gap * 60_000).toISOString(), spent: false };
}

/**
 * The retry path: a loop that stopped itself (`failed`) on a transient fault,
 * started again on the spaced schedule, and left stopped with one alert once
 * the schedule is spent.
 *
 * The count is this loop's `loop-retried` records raised after
 * `lastIterationEndAt` — a stretch with no finished work, not a run — so a
 * refused start, or a supervisor that exits before it writes a record of its
 * own, still spends an attempt. Beside the records stands `retrySeen`, this
 * process's memory of its attempts in the same stretch, and the count is the
 * larger of the two. It never reads or writes `seen`: that is the
 * dead-supervisor bound's second ceiling, and the two paths do not share one.
 */
async function retryStopped(
  deps: ReconcileDeps,
  target: ReconcileTarget,
  report: LoopStateReport,
  { why, cause }: { why: string; cause: string },
  pass: ReconcilePass,
  say: { skip: (why: string) => void; declined: (why: string) => void },
): Promise<void> {
  const kinds = RECONCILE_SURFACE.push.kinds;
  const schedule = deps.retrySchedule ?? DEFAULT_RETRY_SCHEDULE_MINUTES;
  const of = schedule.length;
  // One reading of the clock, for the gap and for the record's `at` both.
  const nowDate = deps.now?.() ?? new Date();
  const nowMs = nowDate.getTime();
  const log = deps.log ?? ((): void => undefined);
  const pending = await pendingStop(target);
  if (pending !== null) {
    say.declined(pending);
    return;
  }
  const feed = deps.records(target.worktree).readFeed().feed;
  const retried = raisedAt(feed, kinds.retried);
  const capped = raisedAt(feed, kinds.retryCapped);
  if (retried === null || capped === null) {
    // Unreadable is not zero attempts: counted as zero, nothing would bound
    // the retries at all.
    say.declined(`cannot read ${target.loop}'s notification feed, so the retry schedule cannot be counted`);
    return;
  }
  // No boundary — no iteration ever finished — and every record counts. A
  // record whose time will not parse is dropped, which errs toward one more
  // attempt rather than toward a loop nothing recovers.
  const boundaryMs = parsedMs(report.lastIterationEndAt);
  const inStretch = (times: string[]): number[] =>
    times.map(parsedMs).filter((at): at is number => at !== null && (boundaryMs === null || at > boundaryMs));
  const inBoundary = (at: number): boolean => boundaryMs === null || at > boundaryMs;
  const records = inStretch(retried);
  // The second ceiling, beside the records: with pushes failing there are no
  // records, and memory is what still spends the schedule.
  const kept = deps.retrySeen?.get(target.worktree) ?? { attempts: [], cappedAt: null };
  const remembered = {
    attempts: kept.attempts.filter(inBoundary),
    cappedAt: kept.cappedAt !== null && inBoundary(kept.cappedAt) ? kept.cappedAt : null,
  };
  deps.retrySeen?.set(target.worktree, remembered);
  const counted = Math.max(records.length, remembered.attempts.length);
  const run = report.run ?? "unknown-run";
  if (counted >= of) {
    // One alert per stretch: a cap raised after the boundary is this one's,
    // on the record or in this process's memory.
    const alerted = inStretch(capped).length === 0 && remembered.cappedAt === null;
    if (alerted) {
      remembered.cappedAt = nowMs;
      const boundary = boundaryMs === null ? "never" : new Date(boundaryMs).toISOString();
      await push(deps, {
        kind: kinds.retryCapped,
        occurrence: `${kinds.retryCapped}:${target.project}:${target.loop}:${boundary}`,
        subject: `${target.loop} (${target.project}): retries capped`,
        body: [
          `project: ${target.project}`,
          `loop: ${target.loop}`,
          `worktree: ${target.worktree}`,
          `run: ${run}`,
          `cause: ${cause}`,
          `reason: ${String(counted)} retry attempts since ${boundaryMs === null ? "the loop was first recorded" : boundary} spent the schedule of ${String(of)}`,
          "outcome: the loop stays stopped; press Start once the cause is fixed",
        ].join("\n"),
        priority: "high",
        worktree: target.worktree,
        loop: target.loop,
        run,
      });
    }
    pass.capped.push({ loop: target.loop, project: target.project, attempts: counted, alerted, retry: true });
    return;
  }
  // The gap runs from the newest attempt, or from the stop for the first one.
  // An anchor that will not parse reads as elapsed: one more attempt.
  const anchorMs = counted > 0 ? Math.max(...records, ...remembered.attempts) : parsedMs(report.stopReason?.at);
  const gapMs = (schedule[counted] ?? 0) * 60_000;
  const attemptNo = counted + 1;
  if (anchorMs !== null && nowMs - anchorMs < gapMs) {
    say.skip(`retry ${String(attemptNo)} of ${String(of)} for ${cause} is due at ${new Date(anchorMs + gapMs).toISOString()}`);
    return;
  }
  const at = nowDate.toISOString();
  const started = await startTarget(target);
  const retry = { attempt: attemptNo, of, cause };
  const attempt: ReconcileAttempt = {
    project: target.project,
    loop: target.loop,
    worktree: target.worktree,
    run,
    at,
    outcome: outcomeOf(started),
    why: started.why,
    pid: started.pid,
    retry,
  };
  pass.attempts.push(attempt);
  // Remembered before the push, as the restart path does: a push that fails
  // writes no record, and this is then the only count of the attempt.
  remembered.attempts.push(nowMs);
  // The timestamp is in the occurrence key for the restart path's reason: the
  // record dedupes on `<run>:<occurrence>`, and a supervisor that exits before
  // writing a new `state.json` keeps the old run id.
  await push(deps, {
    kind: kinds.retried,
    occurrence: `${kinds.retried}:${target.project}:${target.loop}:${at}`,
    subject: `${target.loop} (${target.project}): retry ${String(attemptNo)} of ${String(of)} ${attempt.outcome}`,
    body: [bodyOf(attempt, why), `cause: ${cause}`, `attempt: ${String(attemptNo)} of ${String(of)}`].join("\n"),
    priority: attempt.outcome === "restarted" ? "normal" : "high",
    worktree: target.worktree,
    loop: target.loop,
    run,
    retry,
  });
  log(`reconcile: ${target.project}/${target.loop} retry ${String(attemptNo)} of ${String(of)} ${attempt.outcome}: ${attempt.why}`);
}

/**
 * What this process remembers about one worktree, pruned to the window and
 * stored back, so the caller can append to the same object.
 *
 * With no `seen` map the answer is an empty record that nothing reads again:
 * the records are then the whole bound, which is what every test of the bound
 * drives, and what a freshly restarted dashboard has anyway.
 */
function recall(seen: Seen | undefined, worktree: string, sinceMs: number): SeenAttempts {
  if (seen === undefined) return { attempts: [], cappedAt: null };
  const kept = seen.get(worktree) ?? { attempts: [], cappedAt: null };
  const pruned: SeenAttempts = {
    attempts: kept.attempts.filter((at) => at > sinceMs),
    // A cap alert older than the window belongs to a stretch that has ended.
    cappedAt: kept.cappedAt !== null && kept.cappedAt > sinceMs ? kept.cappedAt : null,
  };
  seen.set(worktree, pruned);
  return pruned;
}

/**
 * This loop's restart attempts inside the window, and the last cap alert, from
 * its own feed. `null` means the feed could not be read, which is not zero.
 */
function pastAttempts(
  deps: ReconcileDeps,
  target: ReconcileTarget,
  nowMs: number,
  windowMs: number,
): { attempts: { at: string }[]; cappedAt: string | null } | null {
  const kinds = RECONCILE_SURFACE.push.kinds;
  const feed = deps.records(target.worktree).readFeed().feed;
  const restarted = raisedAt(feed, kinds.restarted);
  const capped = raisedAt(feed, kinds.capped);
  if (restarted === null || capped === null) return null;
  // A record whose `at` will not parse is dropped from the count, which errs
  // toward one more restart rather than toward a loop nothing recovers. The
  // process's own count covers that case anyway, since it never reads a file.
  const attempts = restarted
    .filter((at) => {
      const parsed = Date.parse(at);
      return !Number.isNaN(parsed) && nowMs - parsed < windowMs;
    })
    .map((at) => ({ at }));
  return { attempts, cappedAt: capped[0] ?? null };
}

/**
 * Raise the bound's one alert for this capped stretch, if it has not been
 * raised yet.
 *
 * A stretch is identified by the newest attempt in it: an alert at or after
 * that attempt is this stretch's, and an older one belongs to a stretch the
 * window has since slid past. That is what keeps it one alert per stretch
 * rather than one per pass, with nothing remembered between passes.
 */
async function raiseCap(
  deps: ReconcileDeps,
  target: ReconcileTarget,
  dead: string,
  past: { attempts: { at: string }[]; cappedAt: string | null },
  remembered: SeenAttempts,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  // The stretch is keyed to its newest attempt, from whichever source saw one:
  // with pushes failing there is no record, and only this process knows.
  const newestMs = Math.max(
    past.attempts[0] === undefined ? 0 : Date.parse(past.attempts[0].at),
    remembered.attempts.at(-1) ?? 0,
  );
  // An unparseable time is 0, not NaN: `Math.max(NaN, …)` is NaN and
  // `NaN >= newestMs` is false for ever, which would re-raise this alert on
  // every pass — the same storm the window exists to stop, by another route.
  const recorded = past.cappedAt === null ? 0 : Date.parse(past.cappedAt);
  const alertedMs = Math.max(Number.isNaN(recorded) ? 0 : recorded, remembered.cappedAt ?? 0);
  if (alertedMs >= newestMs) return false;
  const newest = new Date(newestMs).toISOString();
  remembered.cappedAt = (deps.now?.() ?? new Date()).getTime();
  const minutes = Math.round(windowMs / 60_000);
  await push(deps, {
    kind: RECONCILE_SURFACE.push.kinds.capped,
    occurrence: `${RECONCILE_SURFACE.push.kinds.capped}:${target.project}:${target.loop}:${newest}`,
    subject: `${target.loop} (${target.project}): restarts capped`,
    body: [
      `project: ${target.project}`,
      `loop: ${target.loop}`,
      `worktree: ${target.worktree}`,
      `dead run: ${dead}`,
      `reason: ${String(Math.max(past.attempts.length, remembered.attempts.length))} restart attempts in the last ${String(minutes)} minutes reached the bound of ${String(limit)}`,
      `outcome: nothing more is attempted for this loop until the window slides past ${past.attempts.at(-1)?.at ?? new Date(remembered.attempts[0] ?? newestMs).toISOString()}`,
    ].join("\n"),
    priority: "high",
    worktree: target.worktree,
    loop: target.loop,
    run: dead,
  });
  return true;
}

/**
 * Write one record. A push that fails is logged and never thrown: it is
 * bookkeeping. Answers whether it was written, which the watchdog's
 * in-process set keys on.
 */
async function push(deps: Pick<ReconcileDeps, "adapter" | "log">, input: PushInput): Promise<boolean> {
  const outcome = await deps.adapter.push(input);
  if (!outcome.ok) {
    (deps.log ?? ((): void => undefined))(`reconcile: ${input.kind} for ${input.loop} was not recorded: ${outcome.why}`);
    return false;
  }
  return true;
}

/** The loop a project's watchdog alerts are written under, and where. */
export interface WatchRoot {
  loop: string;
  worktree: string;
}

/**
 * The one loop of a project the watchdog reads `gh` in and writes its alerts
 * to.
 *
 * Chosen from what is on disk, never from what this process saw first: the
 * durable dedupe is push-notification's state file AT the root, so a root
 * that moved between restarts would page the same stalled PR again. The
 * roster's first loop leads; a loop the roster does not name comes after
 * those; ties, and a project with no roster, fall to the smallest worktree
 * path. A worktree with no identity has no loop to attribute a record to.
 */
export function watchRoot(
  loops: readonly { identity: string | null; worktree: string }[],
  rosterNames: readonly string[],
): WatchRoot | null {
  const rank = (identity: string): number => {
    const at = rosterNames.indexOf(identity);
    return at === -1 ? Number.POSITIVE_INFINITY : at;
  };
  const named = loops.flatMap((loop) => (loop.identity === null ? [] : [{ loop: loop.identity, worktree: loop.worktree }]));
  named.sort((a, b) => {
    const byRoster = rank(a.loop) - rank(b.loop);
    if (byRoster !== 0 && !Number.isNaN(byRoster)) return byRoster;
    return a.worktree < b.worktree ? -1 : a.worktree > b.worktree ? 1 : 0;
  });
  return named[0] ?? null;
}

export interface MigrationWatchDeps {
  /** One entry per project — not per loop — with the root its reads run in. */
  projects: readonly { project: string; root: WatchRoot | null }[];
  adapter: ReconcileAdapter;
  alertSeconds: number;
  /** Epoch milliseconds; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Occurrences this PROCESS has already written, so a stalled PR does not
   * respawn a `bun` push every tick. Only a saving: the dedupe that holds
   * across restarts is push-notification's own record at the root.
   */
  pushed?: Set<string>;
  log?: (line: string) => void;
}

/** What one watchdog pass did, for the tests: nothing here is remembered. */
export interface MigrationWatchPass {
  /** PRs this pass alerted on (or found already alerted in this process). */
  alerted: { project: string; pr: number }[];
  /** Projects or PRs left alone this pass, and why. */
  skipped: { project: string; pr: number | null; why: string }[];
}

/** `3h 05m`, or `42m` under an hour: what the subject says the PR has waited. */
const waited = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours === 0 ? `${String(minutes)}m` : `${String(hours)}h ${String(minutes % 60).padStart(2, "0")}m`;
};

/** The open `migration-applied` PRs out of `gh pr list --json`, or null. */
const parsePrs = (stdout: string): MigrationPr[] | null => {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return null;
    return parsed.flatMap((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return [];
      const { number, title, url } = entry as Record<string, unknown>;
      if (typeof number !== "number" || !Number.isInteger(number)) return [];
      return [{ number, title: typeof title === "string" ? title : "", url: typeof url === "string" ? url : "" }];
    });
  } catch {
    return null;
  }
};

/**
 * One pass of the migration watchdog (#434): page once for every open PR that
 * has carried `migration-applied` longer than the threshold.
 *
 * A hand-applied migration puts prod ahead of main, and every other PR of the
 * project reds until the one that carries it merges (loggd #2760) — a stall
 * nobody sees overnight. Once per project, not per loop, because the label is
 * the project's. Every read that fails is logged and retried next tick: this
 * runs with nobody watching, and a page missed for one tick is cheaper than a
 * pass that throws.
 */
export async function watchMigrations(deps: MigrationWatchDeps): Promise<MigrationWatchPass> {
  const now = deps.now ?? ((): number => Date.now());
  const log = deps.log ?? ((): void => undefined);
  const kind = RECONCILE_SURFACE.push.kinds.migrationStalled;
  const pass: MigrationWatchPass = { alerted: [], skipped: [] };
  for (const { project, root } of deps.projects) {
    if (root === null) {
      pass.skipped.push({ project, pr: null, why: "no loop worktree to read gh in" });
      continue;
    }
    const listed = await deps.adapter.listMigrations(root.worktree);
    if (!("prs" in listed)) {
      const why = `could not list ${RECONCILE_SURFACE.gh.label} PRs: ${listed.problem}`;
      log(`migration-watchdog: ${project}: ${why}`);
      pass.skipped.push({ project, pr: null, why });
      continue;
    }
    for (const pr of listed.prs) {
      const read = await deps.adapter.appliedAt(root.worktree, pr.number);
      if (!("at" in read)) {
        const why = "apply time unreadable, retrying next tick";
        log(`migration-watchdog: ${project} PR #${String(pr.number)}: ${why}${read.problem === "" ? "" : ` (${read.problem})`}`);
        pass.skipped.push({ project, pr: pr.number, why });
        continue;
      }
      const appliedAt = read.at;
      const appliedMs = Date.parse(appliedAt);
      const age = now() - appliedMs;
      if (age < deps.alertSeconds * 1000) continue;
      // Keyed by the apply time AS READ, so a re-apply is a new page and the
      // same apply never is — across ticks and, through the fixed run, restarts.
      const occurrence = `${kind}:${String(pr.number)}:${appliedAt}`;
      if (deps.pushed?.has(occurrence) === true) {
        pass.alerted.push({ project, pr: pr.number });
        continue;
      }
      const written = await push(deps, {
        kind,
        occurrence,
        subject: `PR #${String(pr.number)} has waited ${waited(age)} since its migration was applied`,
        body: [
          `project: ${project}`,
          `pr: ${pr.title}`,
          `url: ${pr.url}`,
          `migration applied: ${appliedAt}`,
          `every other PR of the project reds until this one merges`,
        ].join("\n"),
        priority: "high",
        worktree: root.worktree,
        loop: root.loop,
        run: RECONCILE_SURFACE.watchdog.run,
      });
      if (written) deps.pushed?.add(occurrence);
      pass.alerted.push({ project, pr: pr.number });
    }
  }
  return pass;
}

export interface ScheduleOptions {
  /** Defaults to `DEFAULT_RECONCILE_MS`. */
  intervalMs?: number;
  /** The clock the interval is measured with; defaults to `Date.now`. */
  now?: () => number;
  /** How it waits between passes; defaults to `setTimeout`. A test hands over its own. */
  wait?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface ScheduleHandle {
  /**
   * Stop after the pass in flight. A stop issued while the schedule is in its
   * interval takes effect when that wait returns — the wait is injected, so
   * there is nothing here to interrupt — which is why nothing but the process
   * stops the server's own schedule.
   */
  stop(): void;
  /** Settles once the loop has stopped: what a test awaits instead of a real interval. */
  readonly done: Promise<void>;
}

/**
 * Run `pass` now and then every interval, until stopped.
 *
 * The first pass is immediate, and it is the one that matters most: the
 * service comes back by itself after an oomd kill or a reboot, and that
 * startup pass is what brings the loops back with it. The wait is the
 * remainder of the interval, so a slow pass does not push the next one out.
 */
export function schedule(pass: () => Promise<unknown>, options: ScheduleOptions = {}): ScheduleHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_RECONCILE_MS;
  const now = options.now ?? ((): number => Date.now());
  const wait = options.wait ?? ((ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms)));
  const log = options.log ?? ((): void => undefined);
  let stopped = false;
  const loop = async (): Promise<void> => {
    while (!stopped) {
      const startedMs = now();
      try {
        await pass();
      } catch (error) {
        // A pass that throws must not end the schedule: the next one reads again.
        log(`reconcile: pass failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (stopped) break;
      try {
        await wait(Math.max(0, intervalMs - (now() - startedMs)));
      } catch (error) {
        // Nor may the wait: `done` settles on a stop and on nothing else, so a
        // rejected wait would otherwise be an unhandled rejection at a call
        // site that has deliberately dropped the handle.
        log(`reconcile: the interval wait failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  return { stop: () => { stopped = true; }, done: loop() };
}
