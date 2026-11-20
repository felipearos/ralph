/**
 * The Sentinel panel's derivations (felipearos/ralph#685).
 *
 * What the sentinel has seen in the error reporter, read from its issue store
 * through `GET /api/sentinel`: the issues grouped by where they stand, what
 * observe mode would have filed, and today's cap. `.tsx` has no tests, so
 * every string this panel draws is decided here.
 */
import type { SentinelIssueRow, SentinelIssueState, SentinelPanelView } from "../contracts";
import { since } from "./backlog-model";
import { issueHref, issueRef } from "./issue-link";
import { OFF_CARD } from "./rules-save-model";

/** One reporter issue as the panel draws it. */
export interface SentinelRow {
  key: string;
  title: string;
  /** `12 events · 3 users`. */
  counts: string;
  /** `2 attempts to file`, or null before any attempt. */
  attempts: string | null;
  /** The reporter's page for the issue, or null when the candidate carried none. */
  sentryUrl: string | null;
  /** The filed ticket, or null before one is filed. `href` is null where the tracker gives nowhere to link. */
  ticket: { label: string; href: string | null } | null;
  /** `regressed after #12`, or null for an issue on its first cycle. */
  regressed: string | null;
  /** `updated 3h ago`, or `updated at an unknown time`. */
  updated: string;
  updatedAt: string;
}

export interface SentinelGroup {
  state: SentinelIssueState;
  label: string;
  rows: SentinelRow[];
}

/** One draft observe mode held back. */
export interface SentinelDraftRow {
  key: string;
  /** `would have filed: <draft title>`. */
  text: string;
  sentryUrl: string | null;
}

export interface SentinelPanel {
  /** `Off: disabled in config`, else `Observe mode: nothing is filed`, else null (file mode, or no rules). */
  headline: string | null;
  /** `2 of 5 filed today`, or null with no rules to name a cap. */
  cap: string | null;
  /** `cap reached, alert sent` once today's cap alert went out; null otherwise. */
  capAlert: string | null;
  /** Why the store could not be read; null whenever the groups below are real. */
  problem: string | null;
  /** The sentence for an empty store, or null when there is something to show. */
  empty: string | null;
  groups: SentinelGroup[];
  wouldHaveFiled: SentinelDraftRow[];
}

/**
 * The order the panel lists them in: what reached the tracker first, then
 * what is on its way, then what went wrong, and last what stayed under the bar.
 */
const GROUPS: readonly { state: SentinelIssueState; label: string }[] = [
  { state: "filed", label: "Filed" },
  { state: "drafted", label: "Drafted" },
  { state: "failed", label: "Failed to file" },
  { state: "observed", label: "Observed (over the bar, not drafted yet)" },
];

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/**
 * The ticket as the store spelt it, linked where the tracker allows. A ref
 * that is already a URL (a tracker with no short form) links to itself.
 */
function ticketLink(issue: SentinelIssueRow, repoUrl: string | null): SentinelRow["ticket"] {
  if (issue.ticket !== null && /^https?:\/\//.test(issue.ticket)) return { label: issue.ticket, href: issue.ticket };
  if (issue.ticketNumber !== null) {
    return { label: issue.ticket ?? issueRef(issue.ticketNumber), href: issueHref(repoUrl, issue.ticketNumber) };
  }
  return issue.ticket === null ? null : { label: issue.ticket, href: null };
}

/** Cycle 0 is the first sighting; a later cycle names the closed ticket it came back after. */
function regressedWord(issue: SentinelIssueRow): string | null {
  if (issue.regressedAfter !== null) {
    return issue.cycle > 1 ? `regressed after ${issue.regressedAfter} (recurrence ${issue.cycle})` : `regressed after ${issue.regressedAfter}`;
  }
  return issue.cycle > 0 ? `recurrence ${issue.cycle}` : null;
}

const row = (issue: SentinelIssueRow, now: Date, repoUrl: string | null): SentinelRow => {
  const age = since(issue.updatedAt, now.getTime());
  return {
    key: issue.key,
    title: issue.title,
    counts: `${plural(issue.events, "event", "events")} · ${plural(issue.users, "user", "users")}`,
    attempts: issue.attempts > 0 ? plural(issue.attempts, "attempt to file", "attempts to file") : null,
    sentryUrl: issue.permalink,
    ticket: ticketLink(issue, repoUrl),
    regressed: regressedWord(issue),
    updated: age === null ? "updated at an unknown time" : `updated ${age} ago`,
    updatedAt: issue.updatedAt,
  };
};

/**
 * The panel, or null when no loop is a sentinel.
 *
 * Null rather than an empty panel for the reason `followingPanel` gives: with
 * no sentinel nobody is watching the reporter, and "nothing seen yet" would
 * read as all clear rather than as a question nobody is asking.
 */
export function sentinelPanel(view: SentinelPanelView, now: Date, repoUrl: string | null): SentinelPanel | null {
  // Not rostered and no problem is a project with no sentinel. Not rostered
  // WITH a problem is a config the dashboard could not read: it cannot tell
  // whether there is a sentinel, so it says so rather than vanishing.
  if (!view.rostered && view.problem === null) return null;
  const rules = view.rules;
  const today = view.issues?.today ?? null;
  // With no rules there is no cap to measure against; with no store, no count to measure.
  const cap = rules === null ? null : `${today?.filed ?? 0} of ${rules.maxPerDay} filed today`;
  const capAlert = rules !== null && today?.alerted === true ? "cap reached, alert sent" : null;
  // Off outranks the mode (#789): a switched-off sentinel files nothing in either.
  const headline = rules?.enabled === false ? OFF_CARD : rules?.mode === "observe" ? "Observe mode: nothing is filed" : null;
  if (view.issues === null) {
    return {
      headline,
      cap,
      capAlert,
      // The rules still draw: they come from the config, not the store.
      problem: view.rostered
        ? `The sentinel's issue store could not be read: ${view.problem ?? "no reason was reported"}`
        : `The dashboard cannot tell whether this project has a sentinel: ${view.problem ?? "no reason was reported"}`,
      empty: null,
      groups: [],
      wouldHaveFiled: [],
    };
  }
  const issues = view.issues.issues;
  return {
    headline,
    cap,
    capAlert,
    problem: null,
    empty: issues.length === 0 ? "Nothing seen yet" : null,
    groups: GROUPS.map(({ state, label }) => ({
      state,
      label,
      rows: issues.filter((issue) => issue.state === state).map((issue) => row(issue, now, repoUrl)),
    })),
    // Only observe mode holds a draft back; a file-mode draft is on its way to the tracker.
    wouldHaveFiled: issues
      .filter((issue) => issue.mode === "observe" && issue.draftTitle !== null)
      .map((issue) => ({ key: issue.key, text: `would have filed: ${issue.draftTitle}`, sentryUrl: issue.permalink })),
  };
}
