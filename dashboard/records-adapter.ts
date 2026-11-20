/**
 * The records the notification feed and the audit history are read from, and
 * the one thing written beside them: the feed's read mark.
 *
 * The only code that names these files. It reads them as they are, bounded,
 * and hands the text to `records.ts`; a file that is missing or cannot be read
 * is reported as such, never thrown. Nothing here runs a process.
 *
 * - `.ralph/logs/notifications.jsonl` — every alert the loop raised, and how
 *   each channel took it (`push-notification.ts`).
 * - `.ralph/control/inbox/` and `.ralph/control/processed/` — the commands
 *   waiting for the loop's poll, and the settled ones beside their outcome
 *   files (`control-inbox.ts`).
 * - `.ralph/control/signals.jsonl` — every Stop now refusal and signal
 *   (`interrupt-adapter.ts`).
 * - `.ralph/logs/plugin-doctor.jsonl` — the plugin doctor's repairs
 *   (`plugin-doctor.ts`).
 *
 * The read mark, `.ralph/control/notifications-read.json`, is the page's own:
 * which alerts the operator has seen. It lives in the control directory, which
 * ignores itself, so a project that commits `.ralph/` never commits it, and
 * it says nothing about what the loop did.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RawCommandFile, RawFeed, RawFile, RawHistory } from "./records";

export const RECORDS_SURFACE = {
  feed: ".ralph/logs/notifications.jsonl",
  readMark: { dir: ".ralph/control", path: ".ralph/control/notifications-read.json" },
  inbox: ".ralph/control/inbox",
  processed: ".ralph/control/processed",
  outcomeSuffix: ".outcome.json",
  signals: ".ralph/control/signals.jsonl",
  repairs: ".ralph/logs/plugin-doctor.jsonl",
} as const;

/** How much of a JSON-lines record is read: its newest part. */
const TAIL_BYTES = 1024 * 1024;
/** A command or outcome file is a few hundred bytes; anything past this is not one. */
const FILE_BYTES = 64 * 1024;
/** How many settled commands are read, newest first. */
const COMMAND_LIMIT = 100;

export interface RecordsAdapter {
  readFeed(): RawFeed;
  readHistory(): RawHistory;
  /**
   * Mark every alert at or before `through` read. The mark only moves forward,
   * so a page that was behind cannot unread what another has seen. Answers the
   * mark that stands, or why it could not be written.
   */
  markRead(through: string): { readThrough: string; why: string | null };
}

/** The error's code, else its message. */
const codeOf = (error: unknown): string =>
  (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));

/**
 * Read at most the last `limit` bytes of a file. A tail that starts mid-line
 * drops the partial line, so every line handed on is whole.
 */
export function readTail(path: string, limit: number): RawFile {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - limit);
    const buffer = Buffer.alloc(size - start);
    let offset = 0;
    while (offset < buffer.length) {
      const got = readSync(fd, buffer, offset, buffer.length - offset, start + offset);
      if (got === 0) break;
      offset += got;
    }
    let text = buffer.subarray(0, offset).toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return { state: "read", text };
  } catch (error) {
    return codeOf(error) === "ENOENT" ? { state: "missing" } : { state: "unreadable", why: codeOf(error) };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

const readSmall = (path: string): RawFile => readTail(path, FILE_BYTES);

/** The command files in one directory, newest first: `*.json`, not dotted, not an outcome. */
function commandFiles(dir: string): { name: string; mtimeMs: number }[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.startsWith(".") && !name.endsWith(RECORDS_SURFACE.outcomeSuffix))
    .flatMap((name) => {
      try {
        return [{ name, mtimeMs: statSync(join(dir, name)).mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function readCommands(root: string): RawHistory["commands"] {
  const inbox = join(root, RECORDS_SURFACE.inbox);
  const processed = join(root, RECORDS_SURFACE.processed);
  if (!existsSync(inbox) && !existsSync(processed)) return { state: "missing" };
  try {
    const files: RawCommandFile[] = [];
    for (const [dir, pending] of [[inbox, true], [processed, false]] as const) {
      if (!existsSync(dir)) continue;
      for (const { name, mtimeMs } of commandFiles(dir).slice(0, COMMAND_LIMIT)) {
        const stem = name.slice(0, -".json".length);
        files.push({
          stem,
          pending,
          modifiedAt: new Date(mtimeMs).toISOString(),
          command: readSmall(join(dir, name)),
          outcome: pending ? { state: "missing" } : readSmall(join(dir, `${stem}${RECORDS_SURFACE.outcomeSuffix}`)),
        });
      }
    }
    return { state: "read", files };
  } catch (error) {
    return { state: "unreadable", why: codeOf(error) };
  }
}

export function createRecordsAdapter({ root }: { root: string }): RecordsAdapter {
  return {
    readFeed: () => ({
      feed: readTail(join(root, RECORDS_SURFACE.feed), TAIL_BYTES),
      readMark: readSmall(join(root, RECORDS_SURFACE.readMark.path)),
    }),
    readHistory: () => ({
      commands: readCommands(root),
      signals: readTail(join(root, RECORDS_SURFACE.signals), TAIL_BYTES),
      repairs: readTail(join(root, RECORDS_SURFACE.repairs), TAIL_BYTES),
    }),
    markRead: (through) => {
      const target = join(root, RECORDS_SURFACE.readMark.path);
      const current = readSmall(target);
      if (current.state === "read") {
        try {
          const standing = (JSON.parse(current.text) as { readThrough?: unknown }).readThrough;
          if (typeof standing === "string" && Date.parse(standing) >= Date.parse(through)) {
            return { readThrough: standing, why: null };
          }
        } catch {
          // A mark that is not one is replaced.
        }
      }
      try {
        const dir = join(root, RECORDS_SURFACE.readMark.dir);
        mkdirSync(dir, { recursive: true });
        const ignore = join(dir, ".gitignore");
        if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
        const temp = `${target}.${process.pid}.tmp`;
        writeFileSync(temp, `${JSON.stringify({ version: 1, readThrough: through }, null, 2)}\n`);
        renameSync(temp, target);
        return { readThrough: through, why: null };
      } catch (error) {
        return { readThrough: through, why: `could not write ${RECORDS_SURFACE.readMark.path}: ${codeOf(error)}` };
      }
    },
  };
}
