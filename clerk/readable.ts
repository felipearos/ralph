/**
 * A batch's PDFs and images, downloaded where the clerk session can read them.
 *
 * The session holds no Slack token and no network, so a report that lives
 * in a file ("Pille 4 cosas" and a PDF of four bugs, OAI-29) used to be
 * classified from its one line of text: filed as a single ticket for a person
 * to open the file and split it by hand. The gate holds the token, so when it
 * hands a batch over it downloads each readable file of the batch's reports
 * (`files:read`, as the attachments do) into the worktree's ignored logs
 * directory, and `clerk/batch.ts` lists each local copy beside its message for
 * the session to read.
 *
 * Nothing here holds a batch up or fails a poll: a missing scope, a failed
 * download or a file over `READABLE_MAX_BYTES` is a note, and the session
 * classifies that report from its text, as it did before. Only the batch
 * being handed keeps its files; every other batch's are removed.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { AttachableFile } from "./files";
import type { BatchReport } from "./plan";
import type { SlackClient } from "./slack";

/** Where a worktree keeps the batches' files, relative to its root: ignored, like the plan beside it. */
export const READABLE_DIR = ".ralph/logs/clerk-files";

/** The biggest file the session is handed: a PDF of bug reports or a screenshot, never a video. */
export const READABLE_MAX_BYTES = 20 * 1024 * 1024;

/** How many files one batch downloads, so a burst of screenshots cannot keep a poll from handing its batch over. */
export const READABLE_PER_BATCH = 12;

const READABLE_TYPES = /^(application\/pdf|image\/(png|jpe?g|gif|webp))$/i;
const READABLE_NAMES = /\.(pdf|png|jpe?g|gif|webp)$/i;

/** Whether the session can read `file`: a PDF or an image, by its media type or, when Slack does not say, its name. */
export const isReadable = (file: Pick<AttachableFile, "name" | "type">): boolean =>
  file.type !== undefined && file.type !== "" ? READABLE_TYPES.test(file.type) : READABLE_NAMES.test(file.name);

/**
 * Where a file of batch `batchId` is kept, relative to the worktree root. The
 * Slack file id keeps two files of the same name apart; the name keeps its
 * extension, which is how the session's Read tool tells a PDF from an image.
 */
export const readablePath = (batchId: string, file: Pick<AttachableFile, "id" | "name">): string =>
  `${READABLE_DIR}/${batchId}/${file.id.replace(/[^A-Za-z0-9]/g, "")}-${file.name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "")}`;

/** Every readable file of a batch's reports, oldest message first, each once. */
export function readableFiles(reports: readonly Pick<BatchReport, "messages">[]): AttachableFile[] {
  const seen = new Set<string>();
  const out: AttachableFile[] = [];
  for (const report of reports) {
    for (const message of report.messages) {
      for (const file of message.attachments ?? []) {
        if (!isReadable(file) || seen.has(file.id)) continue;
        seen.add(file.id);
        out.push(file);
      }
    }
  }
  return out;
}

/**
 * Download the readable files of the batch `batchId` under `root`, and remove
 * every other batch's. A file already there is kept, so a batch handed again
 * downloads nothing twice. Never throws; returns the notes for the poll.
 */
export async function fetchReadable(
  slack: Pick<SlackClient, "downloadFile">,
  root: string,
  batchId: string,
  reports: readonly Pick<BatchReport, "messages">[],
): Promise<string[]> {
  const notes: string[] = [];
  try {
    const base = join(root, READABLE_DIR);
    if (existsSync(base)) {
      for (const entry of readdirSync(base)) if (entry !== batchId) rmSync(join(base, entry), { recursive: true, force: true });
    }
    const files = readableFiles(reports);
    if (files.length > READABLE_PER_BATCH) {
      notes.push(`${batchId}: ${files.length} readable files; the session is handed the first ${READABLE_PER_BATCH}, and the rest only by link`);
    }
    for (const file of files.slice(0, READABLE_PER_BATCH)) {
      const dest = join(root, readablePath(batchId, file));
      if (existsSync(dest)) continue;
      if (file.size !== null && file.size > READABLE_MAX_BYTES) {
        notes.push(`${batchId}: ${file.name} is too large to hand to the session (${file.size} bytes); it is classified from its text`);
        continue;
      }
      mkdirSync(join(root, READABLE_DIR, batchId), { recursive: true });
      // Written beside its final name and renamed once whole, so a poll killed
      // mid-download never leaves a truncated PDF that reads as the report.
      const partial = `${dest}.part`;
      try {
        const got = await slack.downloadFile(file.url, partial, READABLE_MAX_BYTES);
        if (got.kind === "too-large") {
          notes.push(`${batchId}: ${file.name} is too large to hand to the session (${got.bytes} bytes); it is classified from its text`);
          rmSync(partial, { force: true });
          continue;
        }
        renameSync(partial, dest);
      } catch (error) {
        rmSync(partial, { force: true });
        notes.push(`${batchId}: ${file.name} could not be downloaded for the session (${error instanceof Error ? error.message : String(error)}); it is classified from its text`);
      }
    }
  } catch (error) {
    notes.push(`${batchId}: the report files could not be prepared for the session (${error instanceof Error ? error.message : String(error)}); they are classified from their text`);
  }
  return notes;
}

/** The local copies of `files` that are there, for the session to read: paths relative to `root`. */
export const localCopies = (root: string, batchId: string, files: readonly AttachableFile[] | undefined): string[] =>
  (files ?? []).filter(isReadable).map((file) => readablePath(batchId, file)).filter((path) => existsSync(join(root, path)));
