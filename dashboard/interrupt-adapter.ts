/**
 * The one place the dashboard may signal a process: Stop now's target, its
 * checks, the signal, and the durable record of every one.
 *
 * The dashboard's rule used to be that it never signals a process, and the
 * rule was right for everything else it does. Stop now is the exception an
 * operator was already making by hand — finding a supervisor's process group
 * and killing it while a model held a turn open for most of an hour — and a
 * hand-typed `kill` has no checks at all. So the exception lives here, and
 * only here, under limits the code enforces:
 *
 * - The target is read from one file, `.ralph/logs/supervisor.pid` in the
 *   loop's own checkout, which `start.sh` writes. Nothing is found by pattern:
 *   every loop runs the same `ralph.sh`, so a pattern match hits all of them.
 * - Before any signal the pid must be alive, be running `ralph.sh`, and have
 *   that checkout as its working directory. The last is also what defeats a
 *   reused pid: a recycled number names some other process in some other
 *   directory.
 * - The signal goes to the process group, because the iteration's children
 *   are in it — and only to a group led by the supervisor itself (started by
 *   hand) or by its `start.sh` wrapper (the wrapper's `setsid`), never the
 *   dashboard's own. A group led by anything else could hold processes that
 *   are not the loop's.
 * - Every refusal and every signal is appended to `.ralph/control/signals.jsonl`
 *   in the checkout — target, checks, outcome and the operator's reason — and
 *   the entry for a signal is written before the signal is sent.
 *
 * `/proc` is read directly, as `loop-state.ts` reads it, rather than through a
 * ralph module: nothing on this side of the process boundary imports one.
 * `read-only.test.ts` pins that no other dashboard module signals anything.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { INTERRUPT_CHECKS, type InterruptCheck, type InterruptCheckName, type InterruptSignal, type InterruptTarget } from "./contracts";

/** The signal surface — a closed list, asserted by a test. */
export const SIGNAL_SURFACE = {
  /** Written by `start.sh`: the supervisor's pid, one line. */
  pidFile: ".ralph/logs/supervisor.pid",
  /** The supervisor's script, matched by basename as `loop-state.ts` matches it. */
  script: "ralph.sh",
  audit: { dir: ".ralph/control", path: ".ralph/control/signals.jsonl" },
  signals: ["SIGTERM", "SIGKILL"],
} as const satisfies { signals: readonly InterruptSignal[] } & Record<string, unknown>;

const PROC = "/proc";

/** What the checks found, and whether all of them passed. */
export interface InspectedTarget extends InterruptTarget {
  /** In order, ending at the first that failed. */
  checks: InterruptCheck[];
  ok: boolean;
}

/** One line of the audit file. */
export interface SignalAuditEntry {
  /** The Stop now's idempotency key: every line of one attempt shares it. */
  id: string;
  at: string;
  /** `refused` — nothing sent; `signal` — about to send `signal`; `outcome` — how it ended. */
  event: "refused" | "signal" | "outcome";
  loop: string;
  run: string | null;
  /** The operator's reason. */
  reason: string;
  target: InterruptTarget;
  checks: InterruptCheck[];
  signal: InterruptSignal | null;
  outcome: string | null;
  detail: string;
  /** Who asked when it was not the local operator (`"remote"` for a relayed Stop now). */
  via?: string;
}

export interface InterruptAdapter {
  /** The loop's checkout, resolved. */
  readonly worktree: string;
  /** Read the pid file and run every check in order, stopping at the first that fails. */
  inspect(): InspectedTarget;
  /** Send one signal to a whole process group. A failure is returned, never thrown. */
  signal(group: number, signal: InterruptSignal): string | null;
  /**
   * What is left of a target: is `pid` still this checkout's supervisor, does
   * the group have members at all, and is the group number provably still the
   * one `inspect` accepted (`ours`)? An exited process waiting to be reaped is
   * gone: it runs nothing.
   *
   * `ours` rests on how Linux hands out numbers. A process group's id is its
   * creator's pid, and the kernel does not give that number to a new process
   * while any process still holds it as its group, so the number can only be
   * reused after the group has emptied *and* the pid counter has come all the
   * way round to it. The group is therefore still the loop's while the leader
   * `inspect` accepted is alive (same start time), or while the counter has
   * not wrapped since the check — it only ever counts up, so a lower reading
   * is a wrap. A counter that cannot be read proves nothing.
   */
  remaining(target: { pid: number; group: number }): { supervisor: boolean; group: boolean; ours: boolean };
  /** Append one entry to the audit file. A failure is returned, never thrown. */
  audit(entry: SignalAuditEntry): string | null;
}

export interface InterruptAdapterConfig {
  /** The loop's checkout: the configured root. */
  root: string;
  /** The last pid the kernel allocated; `/proc/loadavg`'s last field unless a test supplies one. */
  lastPid?: () => number | null;
}

/** The last pid allocated in this pid namespace: `/proc/loadavg`'s fifth field. */
function lastAllocatedPid(): number | null {
  try {
    const last = Number(readFileSync(join(PROC, "loadavg"), "utf8").trim().split(/\s+/)[4]);
    return Number.isSafeInteger(last) && last > 0 ? last : null;
  } catch {
    return null;
  }
}

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

const errorCode = (error: unknown): string =>
  (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));

/**
 * `ppid`, `pgrp` and `starttime` out of `/proc/<pid>/stat`, read after the
 * command's closing parenthesis. The start time is what tells a process from
 * a later one given the same pid.
 */
function statOf(pid: number | "self"): { ppid: number; group: number; started: string } | null {
  let raw: string;
  try {
    raw = readFileSync(join(PROC, String(pid), "stat"), "utf8");
  } catch {
    return null;
  }
  const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(fields[1]);
  const group = Number(fields[2]);
  const started = fields[19] ?? "";
  return Number.isSafeInteger(ppid) && Number.isSafeInteger(group) && started !== "" ? { ppid, group, started } : null;
}

const argvOf = (pid: number): string[] | null => {
  try {
    return readFileSync(join(PROC, String(pid), "cmdline"), "utf8").split("\0").filter((part) => part !== "");
  } catch {
    return null;
  }
};

/**
 * Is this argv a supervisor? `bash …/ralph.sh N` is; a shell running `-c`
 * whose command line merely mentions the path is not — `loop-state.ts`'s rule.
 */
const runsScript = (argv: string[]): boolean =>
  !argv.includes("-c") && argv.some((arg) => basename(arg) === SIGNAL_SURFACE.script);

export function createInterruptAdapter(config: InterruptAdapterConfig): InterruptAdapter {
  const worktree = real(config.root);
  const lastPid = config.lastPid ?? lastAllocatedPid;

  const cwdOf = (pid: number): string | null => {
    try {
      return realpathSync(join(PROC, String(pid), "cwd"));
    } catch {
      return null;
    }
  };

  // What each accepted inspection saw, by group: the leader's start time —
  // the leader `remaining` vouches for must be that process, not a later one
  // given the same number — and the pid counter at the time.
  const checked = new Map<number, { leader: string; lastPid: number | null }>();

  const isSupervisor = (pid: number): boolean => {
    const argv = argvOf(pid);
    return argv !== null && runsScript(argv) && cwdOf(pid) === worktree;
  };

  const inspect = (): InspectedTarget => {
    const checks: InterruptCheck[] = [];
    let pid: number | null = null;
    let group: number | null = null;
    const done = (): InspectedTarget => ({
      pidFile: SIGNAL_SURFACE.pidFile,
      pid,
      group,
      checks,
      ok: checks.length === INTERRUPT_CHECKS.length && checks.every((check) => check.ok),
    });
    const fail = (check: InterruptCheckName, detail: string): InspectedTarget => {
      checks.push({ check, ok: false, detail });
      return done();
    };
    const pass = (check: InterruptCheckName, detail: string): void => {
      checks.push({ check, ok: true, detail });
    };

    let raw: string;
    try {
      raw = readFileSync(join(worktree, SIGNAL_SURFACE.pidFile), "utf8");
    } catch (error) {
      return fail("pid-file", `${SIGNAL_SURFACE.pidFile} could not be read (${errorCode(error)}): no supervisor start.sh launched is on record here`);
    }
    const line = raw.split("\n")[0]?.trim() ?? "";
    if (line === "") return fail("pid-file", `${SIGNAL_SURFACE.pidFile} is empty: start.sh is starting a supervisor, or never finished starting one`);
    if (!/^[1-9][0-9]{0,9}$/.test(line)) return fail("pid-file", `${SIGNAL_SURFACE.pidFile} does not hold a pid: '${line.slice(0, 40)}'`);
    pid = Number(line);
    pass("pid-file", `${SIGNAL_SURFACE.pidFile} names pid ${pid}`);

    const stat = statOf(pid);
    const argv = argvOf(pid);
    if (stat === null || argv === null || argv.length === 0) return fail("alive", `pid ${pid} is not running`);
    pass("alive", `pid ${pid} is running`);

    const shown = argv.slice(0, 3).join(" ").slice(0, 120);
    if (!runsScript(argv)) return fail("ralph.sh", `pid ${pid} is running '${shown}', not ${SIGNAL_SURFACE.script}`);
    pass("ralph.sh", `pid ${pid} is running '${shown}'`);

    const cwd = cwdOf(pid);
    if (cwd === null) return fail("cwd", `the working directory of pid ${pid} cannot be read`);
    if (cwd !== worktree) return fail("cwd", `pid ${pid} is working in ${cwd}, not this checkout (${worktree})`);
    pass("cwd", `pid ${pid} is working in ${cwd}`);

    group = stat.group;
    const own = statOf("self")?.group ?? null;
    if (own === null) return fail("group", "the dashboard's own process group cannot be read");
    if (group <= 1 || group === own) {
      return fail("group", `pid ${pid} is in process group ${group}, the dashboard's own: signalling it would reach the dashboard`);
    }
    if (group !== pid && group !== stat.ppid) {
      return fail(
        "group",
        `pid ${pid} is in process group ${group}, led by neither it nor its parent ${stat.ppid}: that group may hold processes that are not the loop's`,
      );
    }
    const leader = group === pid ? stat : statOf(group);
    if (leader === null || leader.group !== group) return fail("group", `the leader of process group ${group} cannot be read`);
    checked.set(group, { leader: leader.started, lastPid: lastPid() });
    pass("group", group === pid ? `pid ${pid} leads its own process group` : `pid ${pid}'s process group ${group} is led by its start.sh wrapper`);
    return done();
  };

  return {
    worktree,
    inspect,
    signal: (group, signal) => {
      if (!SIGNAL_SURFACE.signals.includes(signal) || !Number.isSafeInteger(group) || group <= 1) {
        return `refusing to send ${signal} to process group ${group}`;
      }
      try {
        process.kill(-group, signal);
        return null;
      } catch (error) {
        return `${signal} to process group ${group} failed: ${errorCode(error)}`;
      }
    },
    remaining: ({ pid, group }) => {
      let members = true;
      try {
        process.kill(-group, 0);
      } catch (error) {
        // EPERM is a member this user cannot signal: still a member.
        members = (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
      const seen = checked.get(group);
      const leading = statOf(group);
      const leader =
        seen !== undefined &&
        leading !== null &&
        leading.group === group &&
        leading.started === seen.leader &&
        (argvOf(group)?.length ?? 0) > 0;
      const now = lastPid();
      const unwrapped = seen?.lastPid != null && now !== null && now >= seen.lastPid;
      return { supervisor: isSupervisor(pid), group: members, ours: leader || unwrapped };
    },
    audit: (entry) => {
      try {
        const dir = join(worktree, SIGNAL_SURFACE.audit.dir);
        mkdirSync(dir, { recursive: true });
        const ignore = join(dir, ".gitignore");
        if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
        appendFileSync(join(worktree, SIGNAL_SURFACE.audit.path), `${JSON.stringify(entry)}\n`);
        return null;
      } catch (error) {
        return `could not append to ${SIGNAL_SURFACE.audit.path}: ${errorCode(error)}`;
      }
    },
  };
}
