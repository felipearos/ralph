/**
 * The loop's local command inbox: operator commands as files in its worktree.
 *
 * The only way into a loop. It used to be a mailbox on an external
 * orchestrator, reachable only through a bound consumer terminal, and a Stop
 * issued from the dashboard once went nowhere for 38 minutes while that
 * orchestrator was healthy. Almost all of the channel's safety was already
 * backed by records on disk — the applied-key fence, the run fence, the three
 * verdicts — and the mailbox only carried the message. This file is a carrier
 * that needs nothing but the disk.
 *
 * One command is one file, `.ralph/control/inbox/<command-id>.json`, written
 * atomically (a temp file in the same directory, then a rename) so a reader
 * never sees half of one:
 *
 *   {"version":1,"id":"<command-id>","command":"stop","loop":"ralph",
 *    "run":"<RALPH_RUN_ID>","why":"…","stop":"blocked","issuedAt":"…"}
 *
 * `run` is optional: a command naming a run is refused once that run no longer
 * holds the loop, and one naming no run is addressed to whoever does. `id` is
 * the idempotency key, shared by every writer — the dashboard, an operator, a
 * plugin through the `inbox` hook — so one command delivered twice, by one
 * writer or two, is applied once.
 *
 * `controls.ts poll` reads the inbox, applies each command through the fence,
 * and then — only after its record is written —
 * moves the file to `.ralph/control/processed/` with a `<id>.outcome.json`
 * beside it. That order is what makes a crash harmless: a poll killed before
 * the record lands applied nothing durable, and one killed after it finds the
 * key in the fence (or the outcome already written) and only finishes the move.
 *
 * The directory ignores itself with a `.gitignore` of `*`, written by whichever
 * side creates it first. The inbox is loop-local state, and a project that
 * commits `.ralph/` must not commit an operator's pending stop along with it.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { projectSleep } from "./project-sleep";

export const CONTROL_DIR_RELATIVE_PATH = ".ralph/control";
export const CONTROL_INBOX_RELATIVE_PATH = `${CONTROL_DIR_RELATIVE_PATH}/inbox`;
export const CONTROL_PROCESSED_RELATIVE_PATH = `${CONTROL_DIR_RELATIVE_PATH}/processed`;

/** The suffix of the record a settled command leaves beside itself. */
export const OUTCOME_SUFFIX = ".outcome.json";

/**
 * A command id that is safe to use as a file name, everywhere.
 *
 * Refused rather than escaped: two distinct ids escaping to one name would let
 * the second overwrite the first while it was still pending.
 */
export const isSafeCommandId = (id: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.endsWith(".tmp");

/** Create the control directory, and make it ignore itself. */
export function ensureControlDir(root: string, sub: string): string {
  const base = join(root, CONTROL_DIR_RELATIVE_PATH);
  mkdirSync(join(root, sub), { recursive: true });
  const ignore = join(base, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  return join(root, sub);
}

export type InboxEntry = {
  /** The file name inside the inbox. */
  name: string;
  /** The name without `.json`: the id a command falls back to. */
  stem: string;
  path: string;
} & (
  | { kind: "command"; value: Record<string, unknown> }
  | { kind: "malformed"; why: string }
);

/**
 * Everything waiting in the inbox, oldest first.
 *
 * Only `*.json` files count. A dotfile or a `.tmp` is a write in flight — the
 * writer renames it into place when it is whole — and reading one would be
 * reading half a command. Anything else that is not a JSON object is
 * `malformed`: recorded and moved aside by the caller, never allowed to hold,
 * stop or fail the loop.
 */
export function readInbox(root: string): InboxEntry[] {
  const dir = join(root, CONTROL_INBOX_RELATIVE_PATH);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: (InboxEntry & { mtime: number })[] = [];
  for (const name of names) {
    if (name.startsWith(".") || !name.endsWith(".json")) continue;
    const path = join(dir, name);
    const stem = name.slice(0, -".json".length);
    let mtime = 0;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      mtime = stat.mtimeMs;
    } catch {
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      entries.push({ name, stem, path, mtime, kind: "malformed", why: `unreadable: ${reason(error)}` });
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      entries.push({ name, stem, path, mtime, kind: "malformed", why: "not valid JSON" });
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      entries.push({ name, stem, path, mtime, kind: "malformed", why: "not a JSON object" });
      continue;
    }
    entries.push({ name, stem, path, mtime, kind: "command", value: value as Record<string, unknown> });
  }
  entries.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
  return entries.map(({ mtime: _mtime, ...entry }) => entry);
}

/** What a settled command left behind, beside the command itself. */
export interface InboxOutcome {
  key: string | null;
  command: string | null;
  outcome: string;
  why: string;
  at: string;
}

const outcomePath = (root: string, stem: string): string =>
  join(root, CONTROL_PROCESSED_RELATIVE_PATH, `${stem}${OUTCOME_SUFFIX}`);

/**
 * The outcome an earlier poll already recorded for this file, if any.
 *
 * The last line of the at-most-once defence: the applied fence is capped, and
 * a file whose move was interrupted long enough ago to have aged out of it
 * would otherwise be applied a second time.
 */
export function settledOutcome(root: string, stem: string): InboxOutcome | null {
  try {
    const value: unknown = JSON.parse(readFileSync(outcomePath(root, stem), "utf8"));
    if (typeof value !== "object" || value === null) return null;
    const row = value as Record<string, unknown>;
    return typeof row.outcome === "string"
      ? {
          key: typeof row.key === "string" ? row.key : null,
          command: typeof row.command === "string" ? row.command : null,
          outcome: row.outcome,
          why: typeof row.why === "string" ? row.why : "",
          at: typeof row.at === "string" ? row.at : "",
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * Move one inbox file aside with its outcome written next to it.
 *
 * The outcome is written first and the file moved second, so an interruption
 * between the two leaves a file `settledOutcome` already answers for. Returns
 * why it could not, or null — a failure here is reported, never thrown: an
 * inbox that cannot be tidied is an untidy inbox, not a stopped loop.
 */
export function settleInboxEntry(
  root: string,
  entry: Pick<InboxEntry, "name" | "stem" | "path">,
  outcome: InboxOutcome,
): string | null {
  try {
    const dir = ensureControlDir(root, CONTROL_PROCESSED_RELATIVE_PATH);
    const target = outcomePath(root, entry.stem);
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(outcome, null, 2)}\n`);
    renameSync(temp, target);
    renameSync(entry.path, join(dir, entry.name));
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !existsSync(entry.path)) return null;
    return `could not move ${entry.name} out of the inbox: ${reason(error)}`;
  }
}

const reason = (error: unknown): string =>
  (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));

/**
 * Deliver one command into the inbox, atomically: a dotted temp name in the
 * inbox itself, then a rename, so a reader never sees half of it.
 *
 * For writers that run beside the loop — a plugin's `inbox` hook, an operator's
 * script. The dashboard keeps its own writer, which follows the same rule.
 * Returns why it could not, or null; never throws.
 */
export function writeInboxCommand(root: string, command: Record<string, unknown> & { id: string }): string | null {
  if (!isSafeCommandId(command.id)) return `'${command.id}' is not a safe command id`;
  try {
    const dir = ensureControlDir(root, CONTROL_INBOX_RELATIVE_PATH);
    const temp = join(dir, `.${command.id}.json.${process.pid}.tmp`);
    writeFileSync(temp, `${JSON.stringify({ version: 1, ...command }, null, 2)}\n`);
    renameSync(temp, join(dir, `${command.id}.json`));
    return null;
  } catch (error) {
    return `could not write ${command.id} into the inbox: ${reason(error)}`;
  }
}

/**
 * Whether the inbox holds a command no poll has answered yet.
 *
 * For the loop's long waits — the frontier gate, a backoff, a blocked wait —
 * none of which is an iteration boundary. They used to sleep through the
 * inbox, so a stop sent to an idle loop sat unread for as long as the
 * frontier stayed empty, which could be hours. They ask this between slices
 * instead and hand back to the supervisor, whose checkpoint applies the
 * command. A file an earlier poll already answered (its outcome is written,
 * only the move is left) does not count, or a move that keeps failing would
 * wake every wait for good.
 */
export function hasPendingCommand(root: string): boolean {
  return readInbox(root).some((entry) => settledOutcome(root, entry.stem) === null);
}

/**
 * `hasPendingCommand`, or the project put to sleep (`ralph/project-sleep.ts`).
 *
 * For the waits BETWEEN iterations — a gate waiting for work, a backoff — and
 * only those. A loop idling in its gate must not wake to new work and claim it
 * while its project sleeps: it hands back, and the checkpoint between
 * iterations holds it until the project is woken. The host lease's wait
 * between two turns of one iteration asks `hasPendingCommand` alone, because
 * the sleep lets an iteration that has started finish.
 */
export function hasPendingControl(root: string): boolean {
  return hasPendingCommand(root) || projectSleep(root) !== null;
}
