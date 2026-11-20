/**
 * An in-memory reporter for tests (felipearos/ralph#680), built from the same
 * seed the contract suite hands every adapter. It pages its candidates the
 * way a real reporter does, so a page cap and its `truncated` flag are
 * testable without a network.
 */
import { boundEvidence } from "./evidence";
import {
  writeScopes,
  type AccessCheck,
  type Breadcrumb,
  type Candidate,
  type CandidateList,
  type CandidateQuery,
  type EvidenceRead,
  type Frame,
  type IssueStatus,
  type Reporter,
  type Unreachable,
} from "./types";

/** One event of an issue: when it happened and whose it was, if anyone's. */
export interface SeedEvent {
  at: string;
  user: string | null;
}

export interface SeedIssue {
  id: string;
  title: string;
  culprit: string;
  level: string;
  /** "muted" reads back as "ignored": Sentry calls some ignored issues muted. */
  status: IssueStatus | "muted";
  regressed?: boolean;
  firstSeen: string;
  lastSeen: string;
  permalink: string;
  events: SeedEvent[];
  release?: string | null;
  environment?: string | null;
  /** Outermost first, crash site last, as Sentry sends them. */
  frames?: Frame[];
  /** Chronological. */
  breadcrumbs?: Breadcrumb[];
  tags?: Record<string, string>;
}

export interface ReporterSeed {
  issues: SeedIssue[];
  access: { tokenValid: boolean; projectVisible: boolean; scopes: string[] };
  /** When set, every call is unreachable with this reason. */
  outage?: string;
}

export interface FakeReporterOptions {
  /** Candidates per page. */
  pageSize?: number;
  /** Pages read before `listCandidates` stops and reports `truncated`. */
  pageCap?: number;
}

const HOUR_MS = 3_600_000;

/** A reason is one line however it was seeded: it goes into a log line. */
const unreachable = (why: string): Unreachable => ({
  reachable: false,
  why: why.replace(/\s+/g, " ").trim() || "unreachable",
});

export function createFakeReporter(seed: ReporterSeed, options: FakeReporterOptions = {}): Reporter {
  const pageSize = options.pageSize ?? 100;
  const pageCap = options.pageCap ?? 10;

  return {
    kind: "fake",

    async checkAccess(): Promise<AccessCheck> {
      if (seed.outage !== undefined) return unreachable(seed.outage);
      if (!seed.access.tokenValid) return { reachable: true, access: "refused", why: "token is invalid" };
      if (!seed.access.projectVisible) {
        return { reachable: true, access: "refused", why: "token cannot see the project" };
      }
      const writes = writeScopes(seed.access.scopes);
      if (writes.length > 0) {
        return { reachable: true, access: "refused", why: `token can write: ${writes.join(", ")}` };
      }
      return { reachable: true, access: "ok", scopes: [...seed.access.scopes] };
    },

    async listCandidates(query: CandidateQuery): Promise<CandidateList> {
      if (seed.outage !== undefined) return unreachable(seed.outage);
      const end = query.now.getTime();
      const start = end - query.lookbackHours * HOUR_MS;
      const since = Date.parse(query.since);
      const matches: Candidate[] = [];
      for (const issue of seed.issues) {
        if (Date.parse(issue.lastSeen) < since) continue;
        const inside = issue.events.filter((event) => {
          const at = Date.parse(event.at);
          return at >= start && at <= end;
        });
        if (inside.length === 0) continue;
        const users = new Set(inside.flatMap((event) => (event.user === null ? [] : [event.user])));
        matches.push({
          id: issue.id,
          title: issue.title,
          culprit: issue.culprit,
          level: issue.level,
          status: issue.status === "muted" ? "ignored" : issue.status,
          regressed: issue.regressed ?? false,
          firstSeen: issue.firstSeen,
          lastSeen: issue.lastSeen,
          events: inside.length,
          users: users.size,
          permalink: issue.permalink,
        });
      }
      matches.sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
      // Read page by page like an adapter would, stopping at the cap.
      const issues: Candidate[] = [];
      let offset = 0;
      for (let page = 0; page < pageCap && offset < matches.length; page += 1) {
        issues.push(...matches.slice(offset, offset + pageSize));
        offset += pageSize;
      }
      return { reachable: true, issues, truncated: offset < matches.length };
    },

    async readEvidence(issueId: string): Promise<EvidenceRead> {
      if (seed.outage !== undefined) return unreachable(seed.outage);
      const issue = seed.issues.find((candidate) => candidate.id === issueId);
      if (issue === undefined) return unreachable(`no issue with id ${issueId}`);
      return {
        reachable: true,
        evidence: boundEvidence({
          issueId: issue.id,
          release: issue.release ?? null,
          environment: issue.environment ?? null,
          frames: issue.frames ?? [],
          tags: issue.tags ?? {},
          breadcrumbs: issue.breadcrumbs ?? [],
        }),
      };
    },
  };
}
