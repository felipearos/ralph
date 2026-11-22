/**
 * Markdown text with its code removed: fenced blocks and inline code spans.
 *
 * Text quoted as code is cited, not claimed, so no ticket reference inside it
 * ties a PR to a ticket — not for the frontier's fence (`frontier/next-tasks.ts`)
 * and not for clerk's merged-PR transitions (`clerk/pulls.ts`).
 * `tracker.ts pr-ref --criteria` relies on it, wrapping the ticket references
 * in the acceptance criteria it copies into a PR body (#17).
 *
 * The two shapes follow CommonMark closely enough for that purpose:
 * - a fence opens with three or more backticks or tildes (up to three spaces
 *   in) and closes only on a line of at least as many of the same character
 *   and nothing after them but spaces; a line like ```` ```js ```` inside a
 *   block is content, not its end. An unclosed fence runs to the end. A
 *   backtick opener whose info string holds a backtick is not a fence at all
 *   (```` ```AND-1``` ```` is a code span), so the prose after it stays.
 * - a code span is a run of N backticks closed by the next run of exactly N,
 *   so ``` ``AND-185`` ``` is one span, not two empty ones around a key.
 */
export function withoutCode(body: string | null | undefined): string {
  return (body ?? "")
    .replace(/^ {0,3}(([`~])\2{2,})(?:(?<=`)[^`\n]*|(?<=~)[^\n]*)\n[\s\S]*?(?:^ {0,3}\1\2*[ \t]*$|(?![\s\S]))/gm, "")
    .replace(/(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g, "");
}
