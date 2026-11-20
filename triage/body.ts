/**
 * Editing an issue body one `## Section` at a time.
 *
 * A triager never rewrites a body wholesale: the prose belongs to whoever
 * opened the issue, and the sections the frontier reads as structure are the
 * only parts a plan may touch. Keeping the edit to a named heading is what
 * makes the before-image restore in `triage/apply.ts` meaningful — a revert
 * puts back exactly the section that changed.
 *
 * Shared by the simulation and the apply so both compute the same body. Two
 * implementations would let a plan pass a frontier simulation of a body GitHub
 * never receives.
 */
import { sectionRange } from "../sections";
import type { SectionHeading } from "./plan";

/**
 * The body with `## <heading>` set to `text`.
 *
 * `replace` swaps the section's contents (an empty `text` removes the section
 * entirely, which is how `## Blocked by` is cleared). `append` adds to it. A
 * heading the body does not carry is added at the end, because a section a
 * plan asks for is one the frontier is about to read.
 */
export function applySection(
  body: string,
  heading: SectionHeading,
  mode: "replace" | "append",
  text: string,
): string {
  const normalised = body.replace(/\r\n/g, "\n");
  const found = sectionRange(normalised, heading);
  const block = text.trim() === "" ? "" : `## ${heading}\n\n${text.trim()}\n`;

  if (found === null) {
    if (block === "") return normalised;
    const separator = normalised.trim() === "" ? "" : "\n";
    return `${normalised.replace(/\n+$/, "\n")}${separator}${block}`;
  }

  const current = normalised.slice(found.contentStart, found.end).trim();
  // An append whose text is already the section's tail is not a second append.
  // The apply can crash between a successful `gh issue edit` and the ledger
  // line recording it, so the rerun sees its own work in a fresh census; without
  // this it would append the same acceptance criteria or blocker a second time.
  if (mode === "append" && current.endsWith(text.trim()) && text.trim() !== "") return normalised;
  const merged =
    mode === "append" && current !== ""
      ? `## ${heading}\n\n${current}\n\n${text.trim()}\n`
      : block;
  const before = normalised.slice(0, found.start);
  const after = normalised.slice(found.end);
  if (merged === "") {
    // Dropping the section must not leave the blank line that separated it, or
    // a repeated clear grows the body a line at a time. Trimmed at the SPLICE
    // only: a collapse over the whole body would rewrite the author's prose —
    // a fenced block with two blank lines in it is theirs, not ours.
    const head = before.replace(/\n{2,}$/, "\n\n");
    const tail = after.replace(/^\n+/, "");
    return tail === "" ? head.replace(/\n{2,}$/, "\n") : `${head}${tail}`;
  }
  // The merged block already ends in a newline, so a trailing section needs
  // nothing after it. Adding one anyway would make the edit a non-fixed-point:
  // re-applying the same section would grow the body by a line every time, and
  // an apply that cannot recognise its own result is not idempotent.
  const tail = after === "" ? "" : after.startsWith("\n") ? after : `\n${after}`;
  return `${before}${merged}${tail.replace(/^\n{2,}/, "\n")}`;
}

/**
 * The idempotency marker a triage write carries.
 *
 * A comment or an issue created by an op is looked up by this before it is
 * posted again, because the ledger line recording a write is appended AFTER
 * the write — the one ordering that can lose the record of something that
 * really happened. The marker lives on GitHub, so it survives a lost ledger,
 * a different worktree, and a different host.
 */
export const opMarker = (opId: string): string => `<!-- ralph:triage-op id=${opId} -->`;

/** A comment's marker goes at the end, where nothing parses the text below it. */
export const withOpMarker = (text: string, opId: string): string =>
  `${text.replace(/\s+$/, "")}\n\n${opMarker(opId)}`;

/**
 * An ISSUE body's marker goes at the TOP, above the first heading.
 *
 * Appended, it would land inside whatever section came last — and for a split
 * child that is `## Staffing group`, whose content `parseStaffingGroup`
 * (`frontier/next-tasks.ts`) requires to be one kebab-case word. It throws on
 * anything else, `buildTickets` calls it for every body, and the frontier then
 * dies for every loop on the project. Nor could the apply undo it: only
 * `set-section` ops keep a before-image, so a created body is not restorable.
 */
export const issueBodyWithOpMarker = (body: string, opId: string): string =>
  `${opMarker(opId)}\n\n${body.replace(/^\s+/, "")}`;

export const carriesOpMarker = (text: string, opId: string): boolean => text.includes(opMarker(opId));
