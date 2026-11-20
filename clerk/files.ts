/**
 * A report's files, as the clerk copies them onto its Jira ticket: which of a
 * message's files can be attached, the size cap, and the lines a description
 * or a comment carries for them. Pure, and a leaf: `clerk/reports.ts`,
 * `clerk/apply.ts` and `clerk/threads.ts` all read it, and the I/O that does
 * the copying lives in `clerk/attachments.ts`.
 *
 * A file is attachable when Slack hosts it: it has an id (what the store
 * records it by, so a rerun never attaches it twice), a name (what the ticket
 * shows) and a `url_private_download` (what the bot downloads, with
 * `files:read`). Anything else — a link to another service, a deleted file, a
 * stored batch from before files were attached — is linked as it always was.
 */
import { CLERK_DEFAULTS, type ClerkRules } from "../project-config";
import type { SlackFile } from "./slack";

/** A file the clerk can copy onto a ticket. */
export interface AttachableFile {
  /** Slack's file id: the store records an upload by it. */
  id: string;
  /** The original file name, which the ticket keeps. */
  name: string;
  /** Bytes, as Slack reports them; null when it does not say. */
  size: number | null;
  /** The media type, so Jira previews it; absent when Slack does not say. */
  type?: string;
  /** Where the bot downloads it from. */
  url: string;
  /** The file's Slack permalink: the fallback when it cannot be attached. */
  permalink: string;
}

export const MB = 1024 * 1024;

/** The files of a message the clerk can attach, in the order Slack lists them. */
export function attachableFiles(files: readonly SlackFile[] | undefined): AttachableFile[] {
  const out: AttachableFile[] = [];
  for (const file of files ?? []) {
    if (typeof file.id !== "string" || file.id === "") continue;
    if (typeof file.name !== "string" || file.name === "") continue;
    if (typeof file.url_private_download !== "string" || file.url_private_download === "") continue;
    // A deleted file, or a link to Drive and the like: nothing to download.
    if (file.mode === "tombstone" || file.mode === "external") continue;
    out.push({
      id: file.id,
      name: file.name,
      size: typeof file.size === "number" && Number.isFinite(file.size) ? file.size : null,
      ...(typeof file.mimetype === "string" && file.mimetype !== "" ? { type: file.mimetype } : {}),
      url: file.url_private_download,
      permalink: typeof file.permalink === "string" ? file.permalink : "",
    });
  }
  return out;
}

/** `clerk.attachmentMaxMb` in bytes; the default for a rules object spelled by hand. */
export const maxBytesOf = (rules: Pick<ClerkRules, "attachmentMaxMb">): number => (rules.attachmentMaxMb ?? CLERK_DEFAULTS.attachmentMaxMb) * MB;

/** Whether Slack says the file is over the cap. One whose size it does not say is found out on download. */
export const isTooLarge = (file: Pick<AttachableFile, "size">, maxBytes: number): boolean => file.size !== null && file.size > maxBytes;

/** A size as a person reads it: `250 MB`, `1.5 MB`. */
export const megabytes = (bytes: number): string => `${Number((bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0))} MB`;

/** The line a file too large to attach leaves: which file, how big, and where it still is. */
export const tooLargeLine = (file: Pick<AttachableFile, "name" | "permalink">, bytes: number, maxBytes: number): string =>
  `${file.name}: demasiado grande para adjuntar (${megabytes(bytes)}; el límite es ${megabytes(maxBytes)})${file.permalink === "" ? "" : `, en Slack: ${file.permalink}`}`;

/** The heading of the files a ticket carries as attachments. */
export const ATTACHED_HEADING = "Adjuntos en el ticket:";

/**
 * The block a description or a comment carries for its attachable files:
 * each by name, the attachment the ticket holds, and one over the cap by
 * name, size and Slack link instead. Empty without any.
 */
export function attachedBlock(files: readonly AttachableFile[], maxBytes: number): string[] {
  if (files.length === 0) return [];
  const lines = files.map((file) => `- ${isTooLarge(file, maxBytes) ? tooLargeLine(file, file.size!, maxBytes) : file.name}`);
  return [`${ATTACHED_HEADING}\n${lines.join("\n")}`];
}
