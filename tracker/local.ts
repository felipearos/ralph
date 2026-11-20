/**
 * A tracker kept in one JSON file on the host (felipearos/ralph#527).
 *
 * It is the keyed fake (`fake.ts`) with its state on disk: refs read
 * `<KEY>-n`, a claim and a finish move workflow states, labels must exist
 * before they are used, the way the Linear-shaped fake behaves. One iteration
 * runs many separate `bun tracker.ts …` processes, and the supervisor and the
 * prompts must all see the same tickets, so nothing is kept in memory between
 * calls: every operation takes the file's lock, rebuilds a fake from the file,
 * runs the fake's own logic, and writes the result back atomically.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { IssueComment } from "../block-reason";
import { createFakeTracker, type FakeIssue, type FakeTracker, type FakeTrackerOptions } from "./fake";
import type { Tracker } from "./types";

/** The file, as it is written. `version` lets a later format refuse an older one rather than misread it. */
export interface LocalTrackerFile {
  version: 1;
  key: string;
  /** Labels that exist, used on an issue or not. */
  labels: string[];
  issues: FakeIssue[];
}

export interface LocalTrackerOptions {
  /** The JSON file holding every ticket. A missing file is an empty tracker. */
  file: string;
  /** The project key refs are spelled with (`LOC` makes `LOC-7`); it wins over the key a file was written under. */
  key: string;
  states?: FakeTrackerOptions["states"];
  /** Who `assign()` with no login assigns. */
  self?: string;
}

function readFile(path: string, key: string): LocalTrackerFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, key, labels: [], issues: [] };
    throw error;
  }
  // A file nobody can parse is lost tickets, not an empty tracker: treating it
  // as empty would let the next write overwrite whatever was left of it.
  let value: Partial<LocalTrackerFile>;
  try {
    value = JSON.parse(raw) as Partial<LocalTrackerFile>;
  } catch (error) {
    throw new Error(`the local tracker file is not valid JSON: ${path} (${(error as Error).message})`);
  }
  if (value === null || typeof value !== "object" || value.version !== 1 || !Array.isArray(value.issues)) {
    throw new Error(`unsupported local tracker file: ${path}`);
  }
  return { version: 1, key: value.key ?? key, labels: value.labels ?? [], issues: value.issues };
}

function writeFile(path: string, contents: LocalTrackerFile): void {
  mkdirSync(dirname(path), { recursive: true });
  // Written beside it and renamed over it, so a writer killed mid-write leaves
  // the old file whole and a stray temp, never a half-written tracker. Synced
  // before the rename, so a power cut cannot leave an empty file in its place.
  const temp = `${path}.${process.pid}.tmp`;
  const fd = openSync(temp, "w");
  try {
    writeFileSync(fd, `${JSON.stringify(contents, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Every critical section is a few milliseconds; a lock this old belongs to a process that died inside one. */
const STALE_LOCK_MS = 10_000;
/** Longer than `STALE_LOCK_MS`, so a waiter outlives a dead holder's lock and breaks it rather than failing. */
const LOCK_WAIT_MS = 20_000;

const readToken = (lock: string): string | null => {
  try {
    return readFileSync(lock, "utf8");
  } catch {
    return null;
  }
};

/** Remove the lock only while it still holds `token`, so nobody deletes a lock another process has since taken. */
const unlinkIfHeld = (lock: string, token: string): void => {
  if (readToken(lock) === token) {
    try { unlinkSync(lock); } catch {}
  }
};

/**
 * Run `critical` under the file's exclusive lock, as `withStore` in
 * `host-lease.ts` does. The lock holds a token naming its holder: a stale
 * lock is broken only if it still holds the token that was seen stale, and a
 * holder releases only its own, so a slow holder whose lock was broken cannot
 * delete its successor's.
 */
async function withFile<T>(path: string, key: string, critical: (contents: LocalTrackerFile) => Promise<{ result: T; write: boolean }>): Promise<T> {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const token = `${process.pid} ${crypto.randomUUID()}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lock, "wx");
    } catch (error) {
      // Only a held lock is worth waiting on; anything else (a read-only or
      // vanished directory) is the real failure, reported as itself.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const seen = readToken(lock);
        if (seen !== null && Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) unlinkIfHeld(lock, seen);
      } catch {}
      if (Date.now() > deadline) throw new Error(`the local tracker file is locked: ${lock}`);
      await sleep(50);
      continue;
    }
    try {
      writeFileSync(fd, token);
    } finally {
      closeSync(fd);
    }
    try {
      const contents = readFile(path, key);
      const { result, write } = await critical(contents);
      if (write) writeFile(path, contents);
      return result;
    } finally {
      unlinkIfHeld(lock, token);
    }
  }
}

const fakeFrom = (contents: LocalTrackerFile, options: Omit<LocalTrackerOptions, "file">): FakeTracker =>
  createFakeTracker({
    kind: "local",
    key: options.key,
    ...(options.states === undefined ? {} : { states: options.states }),
    ...(options.self === undefined ? {} : { self: options.self }),
    labels: contents.labels,
    issues: contents.issues,
  });

/** Copy the fake's state back into the file contents, which `withFile` then writes. */
const snapshot = (fake: FakeTracker, contents: LocalTrackerFile, key: string): void => {
  contents.key = key;
  contents.labels = [...fake.existingLabels];
  contents.issues = [...fake.issues.values()].sort((a, b) => a.number - b.number);
};

export function createLocalTracker(options: LocalTrackerOptions): Tracker {
  // Only for the pure parts (ref, url, states, failure classification); every
  // read and write below rebuilds its own from the file.
  const shape = createFakeTracker({ kind: "local", key: options.key, ...(options.states === undefined ? {} : { states: options.states }) });

  const run = <T>(write: boolean, op: (fake: FakeTracker) => Promise<T>): Promise<T> =>
    withFile(
      options.file,
      options.key,
      async (contents) => {
        const fake = fakeFrom(contents, options);
        // A throw leaves `contents` unwritten, so a failed op never touches the file.
        const result = await op(fake);
        if (write) snapshot(fake, contents, options.key);
        return { result, write };
      },
    );
  const read = <T>(op: (fake: FakeTracker) => Promise<T>): Promise<T> => run(false, op);
  const write = <T>(op: (fake: FakeTracker) => Promise<T>): Promise<T> => run(true, op);

  return {
    kind: "local",
    ref: shape.ref,
    url: shape.url,
    openIssues: () => read((fake) => fake.openIssues()),
    closedIssues: () => read((fake) => fake.closedIssues()),
    issue: (number) => read((fake) => fake.issue(number)),
    live: (number) => read((fake) => fake.live(number)),
    comments: (number) => read((fake) => fake.comments(number)),
    withLabel: (label, listOptions) => read((fake) => fake.withLabel(label, listOptions)),
    addLabels: (number, labels) => write((fake) => fake.addLabels(number, labels)),
    removeLabels: (number, labels) => write((fake) => fake.removeLabels(number, labels)),
    assign: (number, login) => write((fake) => fake.assign(number, login)),
    comment: (number, body) => write((fake) => fake.comment(number, body)),
    claim: (number, claimLabel) => write((fake) => fake.claim(number, claimLabel)),
    done: (number, doneLabel) => write((fake) => fake.done(number, doneLabel)),
    handoff: (number, doneLabel) => write((fake) => fake.handoff(number, doneLabel)),
    blocked: (number, stuckLabel) => write((fake) => fake.blocked(number, stuckLabel)),
    create: (issue) => write((fake) => fake.create(issue)),
    editBody: (number, body) => write((fake) => fake.editBody(number, body)),
    cancel: (number) => write((fake) => fake.cancel(number)),
    reopen: (number) => write((fake) => fake.reopen(number)),
    findByBodyMarker: (marker, listOptions) => read((fake) => fake.findByBodyMarker(marker, listOptions)),
    ensureLabels: (labels) => write((fake) => fake.ensureLabels(labels)),
    workflowStates: () => shape.workflowStates!(),
    classifyFailure: shape.classifyFailure,
  };
}

/** One ticket as `seedLocalTracker` writes it. */
export interface LocalSeedIssue {
  number: number;
  title: string;
  body?: string;
  comments?: IssueComment[];
  labels?: string[];
  state?: "open" | "closed";
  /** The workflow state; the first one (`Todo`) when open and `Done` when closed, if omitted. */
  status?: string;
}

/**
 * Write one ticket into the file, creating the file if it is missing and
 * replacing a ticket with the same number. Its labels, and `labels`, are made
 * to exist, so a seeded ticket never carries a label `ensureLabels` would miss.
 */
export async function seedLocalTracker(
  file: string,
  seed: { key?: string; labels?: string[]; issue: LocalSeedIssue },
): Promise<void> {
  await withFile(
    file,
    seed.key ?? "LOC",
    async (contents) => {
      const fake = fakeFrom(contents, { key: contents.key });
      const { issue } = seed;
      fake.put({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        comments: issue.comments ?? [],
        labels: issue.labels ?? [],
        state: issue.state ?? "open",
        ...(issue.status === undefined ? {} : { status: issue.status }),
      });
      for (const label of [...(seed.labels ?? []), ...(issue.labels ?? [])]) fake.existingLabels.add(label);
      snapshot(fake, contents, contents.key);
      return { result: undefined, write: true };
    },
  );
}
