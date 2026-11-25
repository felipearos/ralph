#!/usr/bin/env bun
/**
 * The triager's intake gate (felipearos/ralph#397): the frontier gate, plus
 * one Jira handoff pass before every poll.
 *
 * A to-person report on a keyed tracker is moved to the team's Jira project
 * by `triage/handoff.ts`, and that move needs `RALPH_CLERK_JIRA_TOKEN`. The
 * token is a gate secret: `ralph.sh`'s `run_intake_gate` exports it to the
 * role's intake gate only, never to a model session. So the move happens
 * here. `frontier-gate.ts` writes only when the supervisor runs it with
 * `--claim`, and then only to claim the one ticket it reports (#5); this file
 * remains the one place the triager's gate writes.
 *
 * With no `triage.jira` block, or on a GitHub tracker, this is the frontier
 * gate and nothing else.
 *
 * The pass never ends the gate and never spawns: a tracker that is not
 * connected skips it (the frontier probe reports the tracker itself), a
 * throttle or an outage ends it until the next poll, and one report that
 * cannot be moved is logged and passed over. A denial — a revoked token, a
 * missing permission — raises a notification and queues a `stop` in the
 * loop's own inbox, which the frontier gate's inbox check hands back to the
 * supervisor to apply. Retrying a revoked token all night would only hide it.
 *
 * Usage:
 *   ralph/triage/gate.ts <poll-seconds>   hand off, wait until there is work, then exit 0
 *   ralph/triage/gate.ts --once           hand off, then report the verdict; 0 work, 1 none
 */
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";

import { commonStatePath } from "../claim-lease";
import { jiraClient, parseJiraToken, type JiraClient } from "../clerk/jira";
import { writeInboxCommand } from "../control-inbox";
import { runFrontierGate } from "../frontier-gate";
import { projectRoot } from "../paths";
import { loadProjectConfig, triageRules, type ProjectConfig, type TriageJira } from "../project-config";
import { currentProjectId } from "../project-id";
import { push, type NotificationKind } from "../push-notification";
import { createTracker, TrackerUnavailableError, type Tracker } from "../tracker/index";
import { writeSpacingMs } from "../triage-apply";
import { handOff, pendingHandoffs, type HandoffResult } from "./handoff";

const PREFIX = "triage-gate";

type Denial = NonNullable<HandoffResult["denial"]>;

export interface HandoffPassDeps {
  tracker: Tracker;
  /** Null in shadow, and in live when the host holds no credential. */
  jira: JiraClient | null;
  rules: TriageJira;
  scopeLabel: string | null;
  log: (line: string) => void;
  notify: (denial: Denial) => void;
  stop: (denial: Denial) => void;
  /** One report that could not be moved: raised so it is not only a log line. */
  alert: (ref: string, problem: string) => void;
  /**
   * The pass's exclusive lock: a release function, or null when another
   * triager's gate holds it. Two triagers on one project poll the same
   * pending list, and both moving one report would file two tickets.
   */
  lock: () => (() => void) | null;
  sleep: (ms: number) => Promise<void>;
  spacingMs: number;
}

/** One result as the supervisor log keeps it. */
export function resultLine(ref: string, result: HandoffResult): string {
  switch (result.outcome) {
    case "moved":
      return `${PREFIX}: ${ref} moved to ${result.key}`;
    case "shadowed":
      return `${PREFIX}: ${ref} shadowed`;
    default:
      return `${PREFIX}: ${ref} ${result.outcome}: ${result.problem}`;
  }
}

/**
 * Hand every pending to-person report over, lowest number first. Never
 * throws: a tracker that is not connected, or anything else unexpected, is
 * one log line and the end of this pass.
 */
export async function handoffPass(deps: HandoffPassDeps): Promise<void> {
  const { tracker, rules } = deps;
  let release: (() => void) | null;
  try {
    release = deps.lock();
  } catch (error) {
    deps.log(`${PREFIX}: could not take the handoff lock, skipping this pass: ${message(error)}`);
    return;
  }
  if (release === null) {
    deps.log(`${PREFIX}: another triager's gate is handing off; skipping this pass`);
    return;
  }
  try {
    const pending = await pendingHandoffs(tracker, { scopeLabel: deps.scopeLabel, mode: rules.mode });
    for (const number of pending) {
      const result = await handOff(number, { tracker, jira: deps.jira, rules, sleep: deps.sleep, spacingMs: deps.spacingMs });
      deps.log(resultLine(tracker.ref(number), result));
      // A throttle or an outage is shared by every report behind this one;
      // the next poll retries them all.
      if (result.outcome === "waiting") return;
      if (result.outcome === "failed") {
        try {
          deps.alert(tracker.ref(number), result.problem ?? "failed");
        } catch (error) {
          deps.log(`${PREFIX}: could not raise the failure notification: ${message(error)}`);
        }
      }
      if (result.outcome === "denied") {
        const denial = result.denial ?? { code: "denied", why: result.problem ?? "refused", remedy: "check the triager's Jira credential and permissions" };
        // Each best-effort: a notification that cannot be raised must not keep
        // the stop from being queued, and neither may end the gate.
        try {
          deps.notify(denial);
        } catch (error) {
          deps.log(`${PREFIX}: could not raise the denial notification: ${message(error)}`);
        }
        try {
          deps.stop(denial);
        } catch (error) {
          deps.log(`${PREFIX}: could not queue the stop: ${message(error)}`);
        }
        return;
      }
    }
  } catch (error) {
    if (error instanceof TrackerUnavailableError) {
      deps.log(`${PREFIX}: the tracker is not connected, skipping the handoff: ${error.message}`);
      return;
    }
    deps.log(`${PREFIX}: handoff pass failed: ${message(error)}`);
  } finally {
    try {
      release();
    } catch (error) {
      deps.log(`${PREFIX}: could not release the handoff lock: ${message(error)}`);
    }
  }
}

/** The lock file's name in git's common directory. */
export const HANDOFF_LOCK = "ralph-triage-handoff.lock";

/** Past this, a holder is taken to have died mid-pass whatever its pid says. */
export const HANDOFF_LOCK_STALE_MS = 10 * 60 * 1000;

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM is a live process this user cannot signal; only ESRCH is gone.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

/**
 * Take the file lock at `path`: created exclusively, holding `{pid, at}`. A
 * lock older than `HANDOFF_LOCK_STALE_MS`, or whose pid is gone, is stale and
 * taken over, so a gate killed mid-pass cannot fence the handoff forever.
 * Returns the release function, or null while a live other holds it.
 */
export function acquireHandoffLock(path: string, now: () => number = Date.now, alive: (pid: number) => boolean = pidAlive): (() => void) | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() }));
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          unlinkSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (attempt > 0) return null;
    let holder: { pid?: unknown; at?: unknown } = {};
    let written = Number.NaN;
    try {
      written = statSync(path).mtimeMs;
      holder = JSON.parse(readFileSync(path, "utf8")) as typeof holder;
    } catch {
      // Half-written by a holder that has just created it: judged by the
      // file's age, so a fresh one is not taken over mid-write.
    }
    if (Number.isNaN(written)) continue; // Released between the two calls: try again.
    const at = typeof holder.at === "string" ? Date.parse(holder.at) : written;
    const pid = typeof holder.pid === "number" ? holder.pid : null;
    const stale = Number.isNaN(at) || now() - at > HANDOFF_LOCK_STALE_MS || (pid !== null && !alive(pid));
    if (!stale) return null;
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return null;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const KIND: Readonly<Record<string, NotificationKind>> = {
  no_jira_credential: "credential-expiry",
  no_jira_token: "credential-expiry",
  jira_unauthorized: "credential-expiry",
};

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The real I/O for one pass, built anew on each poll so a tracker connected
 * while the loop idles is picked up. Null skips the pass.
 */
function wire(root: string, config: ProjectConfig, rules: TriageJira, env: NodeJS.ProcessEnv): HandoffPassDeps | null {
  if (config.tracker.kind === "github") return null;
  let tracker: Tracker;
  try {
    tracker = createTracker(config, { projectId: currentProjectId(root) });
  } catch (error) {
    if (!(error instanceof TrackerUnavailableError)) throw error;
    console.log(`${PREFIX}: the tracker is not connected, skipping the handoff: ${error.message}`);
    return null;
  }
  // Shadow holds no Jira writer at all, so the token is never even parsed.
  const credential = rules.mode === "live" ? parseJiraToken(env.RALPH_CLERK_JIRA_TOKEN) : null;
  const loop = env.RALPH_LOOP_NAME?.trim() || "triager";
  const run = env.RALPH_RUN_ID?.trim() || null;
  return {
    tracker,
    jira: credential === null ? null : jiraClient(rules.site, credential),
    rules,
    scopeLabel: config.tracker.scopeLabel,
    log: (line) => console.log(line),
    notify: (denial) =>
      push(root, {
        kind: KIND[denial.code] ?? "permission-denial",
        occurrence: `triage-denied:${denial.code}`,
        subject: `The triager's Jira handoff was refused: ${denial.code}`,
        body: `${denial.why}. ${denial.remedy}.`,
        priority: "high",
        ticket: null,
      }),
    stop: (denial) => {
      const problem = writeInboxCommand(root, {
        version: 1,
        // One per denial per run: a second poll refused the same way is the
        // same command, applied once.
        id: `triage-denied-${denial.code}-${run ?? Date.now()}`.replace(/[^A-Za-z0-9_.-]/g, "-"),
        command: "stop",
        loop,
        ...(run === null ? {} : { run }),
        why: `${denial.why}; ${denial.remedy}`,
        stop: "blocked",
        issuedAt: new Date().toISOString(),
        via: PREFIX,
      });
      // Null is written; a string says why it was not.
      if (problem !== null) console.log(`${PREFIX}: the stop could not be queued: ${problem}`);
    },
    alert: (ref, problem) =>
      push(root, {
        kind: "gate-failure",
        // Deduped per run and occurrence: once per run, not once per poll.
        occurrence: `triage-handoff-failed:${ref}`,
        subject: `The triager could not move ${ref} to Jira`,
        body: `${problem}.`,
        priority: "high",
        ticket: null,
      }),
    lock: () => acquireHandoffLock(commonStatePath(HANDOFF_LOCK, env.RALPH_STATE_ROOT ?? root)),
    sleep: realSleep,
    spacingMs: writeSpacingMs(env),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const root = projectRoot();
  const config = loadProjectConfig(root);
  const rules = triageRules(config).jira;
  if (rules === null || config.tracker.kind === "github") {
    await runFrontierGate(argv);
    return;
  }
  await runFrontierGate(argv, {
    beforePoll: async () => {
      const deps = wire(root, config, rules, process.env);
      if (deps !== null) await handoffPass(deps);
    },
  });
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(message(error));
    process.exitCode = 2;
  }
}
