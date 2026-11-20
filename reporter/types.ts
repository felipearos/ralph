/**
 * The interface every error reporter (Sentry first) gives the loops
 * (felipearos/ralph#680), shaped like `tracker/`: one contract, an in-memory
 * fake, and adapters held to the same suite (`contract.ts`).
 *
 * No method throws. A loop reads a reporter unattended, overnight, so any
 * failed call (network down, 5xx, a body it cannot parse) resolves to
 * `Unreachable` with a one-line reason the loop can log and move past. A
 * token that can write is a different outcome: the reporter is reachable but
 * `checkAccess` refuses it, because a loop must never hold a token that could
 * resolve, delete or edit what it is only meant to read.
 */

/** The fetch an adapter is built with, injected so tests never reach the network. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type ReporterKind = "sentry" | "fake";

/** A call that did not get an answer. `why` is one non-empty line. */
export interface Unreachable {
  reachable: false;
  why: string;
}

export type IssueStatus = "unresolved" | "resolved" | "ignored";

export type AccessCheck =
  | { reachable: true; access: "ok"; scopes: string[] }
  /** The token is invalid, cannot see the project, or carries a write scope (named in `why`). */
  | { reachable: true; access: "refused"; why: string }
  | Unreachable;

export interface CandidateQuery {
  /** ISO 8601 cursor: only issues last seen at or after it. */
  since: string;
  lookbackHours: number;
  now: Date;
}

export interface Candidate {
  id: string;
  title: string;
  culprit: string;
  level: string;
  status: IssueStatus;
  regressed: boolean;
  firstSeen: string;
  lastSeen: string;
  /** Events inside the lookback window, not over the issue's lifetime. */
  events: number;
  /** Distinct users inside the lookback window; events with no user count none. */
  users: number;
  permalink: string;
}

export type CandidateList = { reachable: true; issues: Candidate[]; truncated: boolean } | Unreachable;

export interface Frame {
  file: string;
  function: string;
  line: number | null;
  inApp: boolean;
}

export interface Breadcrumb {
  at: string;
  category: string;
  level: string;
  message: string;
}

/** What one issue's latest event says, already cut to the bound in `evidence.ts`. */
export interface Evidence {
  issueId: string;
  release: string | null;
  environment: string | null;
  /** In-app frames first, then the rest; innermost (crash site) first within each. */
  frames: Frame[];
  framesOmitted: number;
  tags: { browser?: string; os?: string; url?: string; transaction?: string };
  /** The most recent breadcrumbs, in chronological order. */
  breadcrumbs: Breadcrumb[];
  breadcrumbsOmitted: number;
}

export type EvidenceRead = { reachable: true; evidence: Evidence } | Unreachable;

export interface Reporter {
  readonly kind: ReporterKind;
  /** Whether the token reads the project, and only reads it. */
  checkAccess(): Promise<AccessCheck>;
  /**
   * The issues with at least one event inside the lookback
   * `[now - lookbackHours, now]` whose `lastSeen >= since`, newest `lastSeen`
   * first. `events` and `users` count the event total and the distinct users
   * inside the lookback only. `truncated` is true when the implementation
   * stopped at its page cap with more matches left, so the caller knows the
   * list is not the whole picture.
   */
  listCandidates(query: CandidateQuery): Promise<CandidateList>;
  /** The bounded evidence for one issue; an id the reporter does not know is `Unreachable`. */
  readEvidence(issueId: string): Promise<EvidenceRead>;
}

/**
 * Every scope that is not read-only. Sentry's write-capable scopes do not
 * share one suffix (`project:write`, `event:admin`, `org:ci`,
 * `project:releases`), so read-only is defined the other way round: a scope
 * that ends in `:read`.
 */
export function writeScopes(scopes: string[]): string[] {
  return scopes.filter((scope) => !scope.endsWith(":read"));
}
