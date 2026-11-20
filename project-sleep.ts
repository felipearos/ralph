#!/usr/bin/env bun
/**
 * A project's sleep: one switch that softly pauses every loop of a project.
 *
 * An operator going to bed, or handing the machine to something else for a
 * while, wants every agent of a project to stand down without killing any of
 * them and without visiting each loop to pause it. Pausing loop by loop has
 * two holes besides the clicks: a loop started after the round of pauses is
 * not paused, and one the dashboard's reconciler restarts is a new run that
 * a pause addressed to the old one may not reach.
 *
 * So the sleep is not a command to any loop. It is one marker in git's common
 * directory, `ralph-sleep.json` beside the claim and host leases, which every
 * worktree of the repository shares — and every loop of a project is a
 * worktree of its repository. Each loop reads it at the checkpoint before its
 * next iteration (`controls.ts poll`), and holds there while it stands:
 *
 *   - SOFT. Only a poll between iterations, or at one of the supervisor's
 *     idle waits, holds for it; a poll at a phase boundary inside an
 *     iteration ignores it. Whatever a loop is in the middle of — a PR it is
 *     shipping, a ticket half done — it finishes first.
 *   - DERIVED, never recorded in a loop's own control record. Waking the
 *     project is removing the marker, and every loop goes on at its next poll
 *     with nothing left behind to clear by hand. An operator's own pause of
 *     one loop is a different instruction and outlives a wake.
 *   - FAIL-OPEN. A marker nobody can read is no marker: a loop must never be
 *     held overnight by a file it cannot make sense of (see CLAUDE.md).
 *
 * Usage, from any checkout of the project (or with RALPH_STATE_ROOT set):
 *   ralph/project-sleep.ts status [--json]
 *   ralph/project-sleep.ts sleep  [--why <text>] [--by <who>] [--json]
 *   ralph/project-sleep.ts wake   [--json]
 *
 * `--json` prints the view the dashboard reads:
 *   {"version":1,"asleep":true,"since":"<iso>","why":"…","by":"dashboard"}
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { commonStatePath } from "./claim-lease";

/** The marker's name in git's common directory. */
export const SLEEP_FILE_NAME = "ralph-sleep.json";

export interface ProjectSleep {
  since: string;
  why: string | null;
  by: string | null;
}

export interface SleepView {
  version: 1;
  asleep: boolean;
  since: string | null;
  why: string | null;
  by: string | null;
}

/** Where the marker for the project `root` belongs to lives. */
export function sleepPathFor(root: string): string {
  return commonStatePath(SLEEP_FILE_NAME, root);
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/**
 * The marker, or null when there is none — or none anybody can read. A torn
 * write, a hand edit gone wrong, a version from the future: each reads as
 * awake, because the alternative is a loop held by a file it cannot parse.
 */
export function parseSleep(raw: string): ProjectSleep | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return null;
  const since = text(record.since);
  if (since === null || Number.isNaN(Date.parse(since))) return null;
  return { since, why: text(record.why), by: text(record.by) };
}

export function readSleep(path: string): ProjectSleep | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return parseSleep(raw);
}

/** Is the project `root` belongs to asleep? Never throws. */
export function projectSleep(root: string): ProjectSleep | null {
  try {
    return readSleep(sleepPathFor(root));
  } catch {
    return null;
  }
}

/**
 * Put the project to sleep. Already asleep, the marker is left as it is: the
 * time it fell asleep, and why, are what an operator reads in the morning, and
 * a second click must not rewrite them.
 */
export function sleep(path: string, options: { why?: string | null; by?: string | null; now?: Date } = {}): ProjectSleep {
  const current = readSleep(path);
  if (current !== null) return current;
  const marker: ProjectSleep = {
    since: (options.now ?? new Date()).toISOString(),
    why: text(options.why),
    by: text(options.by),
  };
  mkdirSync(dirname(path), { recursive: true });
  // A temp file and a rename, so a loop polling mid-write never reads half a
  // marker — which would read as awake, and let it take one more ticket.
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, ...marker }, null, 2)}\n`);
  renameSync(temp, path);
  return marker;
}

/** Wake the project. Waking one that is awake is not an error. */
export function wake(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function viewOf(marker: ProjectSleep | null): SleepView {
  return marker === null
    ? { version: 1, asleep: false, since: null, why: null, by: null }
    : { version: 1, asleep: true, ...marker };
}

/** The line a loop's pane and record show while it holds for the sleep. */
export function sleepReason(marker: ProjectSleep): string {
  const who = marker.by === null ? "" : ` by ${marker.by}`;
  return `the project is asleep since ${marker.since}${who}${marker.why === null ? "" : ` — ${marker.why}`}; wake it to go on`;
}

function flag(argv: string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? null : (argv[at + 1] ?? null);
}

const USAGE = "usage: project-sleep.ts status|sleep|wake [--why <text>] [--by <who>] [--json]";

function main(argv: string[]): number {
  const root = process.env.RALPH_STATE_ROOT ?? process.cwd();
  const path = sleepPathFor(root);
  const [command = "status", ...rest] = argv;
  if (command === "sleep") sleep(path, { why: flag(rest, "why"), by: flag(rest, "by") });
  else if (command === "wake") wake(path);
  else if (command !== "status") {
    console.error(USAGE);
    return 64;
  }
  const view = viewOf(readSleep(path));
  if (rest.includes("--json")) {
    console.log(JSON.stringify(view));
  } else if (view.asleep) {
    console.log(`asleep — ${sleepReason(view as ProjectSleep)}`);
  } else {
    console.log(existsSync(path) ? "awake (the sleep marker is unreadable, so it is ignored)" : "awake");
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`project-sleep: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
