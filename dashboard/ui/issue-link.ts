/**
 * Where a ticket number links and how it is written (felipearos/ralph#339):
 * `#184` under the repo's GitHub issues, `AND-184` in a Linear workspace,
 * `OA-410` on a Jira site.
 *
 * One page shows one project, and every view that names a ticket needs its
 * project's answer, so it is set once from the snapshot (`setTrackerLinks`)
 * rather than threaded through each model beside `repoUrl`. Before a snapshot
 * says otherwise, a ticket is a GitHub issue, as it always was here.
 */
import type { TrackerLinkView } from "../contracts";

let current: TrackerLinkView | null = null;

/** The project the page is showing; null or absent means GitHub issues. */
export function setTrackerLinks(view: TrackerLinkView | null | undefined): void {
  current = view ?? null;
}

/** The ticket's page, or null when there is nowhere to link it. */
export function issueHref(repoUrl: string | null | undefined, issue: number): string | null {
  if (current !== null && current.link !== null) return current.link.replace("{n}", String(issue));
  // A Linear or Jira ticket with no known link must not point at a GitHub issue of the same number.
  if (current !== null && current.kind !== "github") return null;
  return repoUrl ? `${repoUrl}/issues/${issue}` : null;
}

/** `#184`, `AND-184`, `OA-410`. */
export function issueRef(issue: number): string {
  return `${current?.prefix ?? "#"}${issue}`;
}
