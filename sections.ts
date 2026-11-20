/**
 * Where one `## heading` section of an issue body starts and ends.
 *
 * A leaf on purpose: no imports, and nothing in the repo may import it for
 * anything but this. Three modules need the same answer and they sit in three
 * layers, so neither of the other two homes works —
 *
 *   - `frontier/next-tasks.ts` counts acceptance criteria to size a ticket.
 *     It is the LOWEST layer: `triage/` imports it, the supervisor's redaction
 *     path reaches it through `currentLoop`, and every role's gate loads it. A
 *     parser living above it would invert that, which is not academic — it
 *     made `runner-failure.ts` pull in the whole triage write engine, and the
 *     scratch harness in `ralph.test.ts` stopped being able to redact stderr.
 *   - `triage/body.ts` REWRITES a section, and `triage/validate.ts` asks what
 *     text a rescue is replacing so it can insist the triager quotes it
 *     (felipearos/ralph#150). Those two must agree to the character: one of
 *     them decides what the history was, the other destroys it.
 *
 * So the anchor lives here, once, and all three compose it.
 */

/**
 * The span of the section under `heading`, or null when the body has no such
 * heading. `contentStart` is just past the heading line; `end` is the start of
 * the next `##` heading, or the end of the body.
 */
export function sectionRange(
  body: string,
  heading: string,
): { start: number; contentStart: number; end: number } | null {
  const anchor = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im");
  const match = anchor.exec(body);
  if (match === null) return null;
  const start = match.index;
  const contentStart = start + match[0].length;
  const rest = body.slice(contentStart);
  const next = /^##\s+/m.exec(rest);
  return { start, contentStart, end: next === null ? body.length : contentStart + next.index };
}

/**
 * The text under one `## heading`, or null when the body has no such heading.
 *
 * Null, not the whole body, so a caller can tell "the heading is missing" from
 * "the section is empty". The caller that wants the whole-body fallback —
 * sizing a ticket whose criteria carry no heading — composes it in one line.
 */
export function sectionIfPresent(body: string, heading: string): string | null {
  const range = sectionRange(body, heading);
  return range === null ? null : body.slice(range.contentStart, range.end);
}
