/**
 * Which merged pull requests the verifier watches (felipearos/ralph#563, spec
 * #560): a recent merge into the base branch that closes a tracker ticket and
 * is a change to the product, not the harness's own bookkeeping.
 *
 * Nothing here throws: a list that cannot be read is a reason, which the gate
 * reports as "nothing to do this poll".
 */
import type { RosterEntry, VerifierRules, TrackerConfig } from "../project-config";
import type { Gh } from "./deploys";

/**
 * The prefix of the marker the verifier's revert ticket (felipearos/ralph#569
 * under spec #560) stamps its revert PRs with. A revert is the verifier's own
 * answer to a watch; watching it would have the verifier judge itself.
 */
export const VERIFIER_REVERT_MARKER = "<!-- verifier revert";

/** How many merged PRs one poll looks through; the window keeps the useful ones well under it. */
export const MERGED_PAGE = 100;

const HOUR_MS = 3_600_000;

export interface MergedPr {
  number: number;
  title: string;
  body: string;
  headRefName: string;
  mergeCommit: string | null;
  mergedAt: string | null;
  labels: string[];
  closingIssues: number[];
}

export interface QualifyContext {
  rules: Pick<VerifierRules, "windowHours" | "follow">;
  tracker: TrackerConfig;
  roster: readonly RosterEntry[];
  now: Date;
}

export interface Qualified {
  pr: number;
  ticket: number;
  ticketRef: string;
  mergeCommit: string;
  mergedAt: string;
}

export type Qualification = { kind: "qualified"; candidate: Qualified } | { kind: "skipped"; pr: number; why: string };

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The project's ticket key on a keyed tracker, null on GitHub. */
function trackerKey(tracker: TrackerConfig): string | null {
  switch (tracker.kind) {
    case "github": return null;
    case "linear": return tracker.team;
    case "jira": return tracker.project;
    case "local": return tracker.key;
  }
}

/**
 * The ticket a PR closes. GitHub links it (`closingIssuesReferences`) or the
 * body says `Closes #n`; a keyed tracker has only the `Ticket: KEY-n <url>`
 * line `tracker.ts pr-ref` writes, and a `#n` there is a GitHub issue or PR
 * number, never one of its tickets.
 */
export function ticketOf(pr: Pick<MergedPr, "body" | "closingIssues">, tracker: TrackerConfig): { ticket: number; ticketRef: string } | null {
  const key = trackerKey(tracker);
  if (key === null) {
    const linked = pr.closingIssues[0];
    if (linked !== undefined) return { ticket: linked, ticketRef: `#${linked}` };
    const closes = /^\s*(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/im.exec(pr.body);
    if (closes === null) return null;
    const ticket = Number(closes[1]);
    return { ticket, ticketRef: `#${ticket}` };
  }
  const line = new RegExp(`^\\s*Ticket:\\s+${escape(key)}-(\\d+)\\b`, "im").exec(pr.body);
  if (line === null) return null;
  const ticket = Number(line[1]);
  return { ticket, ticketRef: `${key}-${ticket}` };
}

/**
 * The roster loop a PR body is stamped for by the §5.3 provenance line, or
 * null for a human PR. `frontier-gate.ts` `provenance()` reads the roster of
 * the checkout it runs in; the verifier is handed its project's roster, so it
 * builds the same pattern from that.
 */
export function loopAuthor(body: string, roster: readonly RosterEntry[]): string | null {
  if (roster.length === 0) return null;
  const names = roster.map((entry) => escape(entry.name)).join("|");
  return new RegExp(`🤖 (${names}) loop`, "i").exec(body)?.[1]?.toLowerCase() ?? null;
}

/** Whether `pr` is one the verifier watches, or the first rule it fails. */
export function qualify(pr: MergedPr, ctx: QualifyContext): Qualification {
  const skip = (why: string): Qualification => ({ kind: "skipped", pr: pr.number, why });
  if (pr.mergeCommit === null || pr.mergedAt === null || !Number.isFinite(Date.parse(pr.mergedAt))) {
    return skip("has no merge commit or merge time");
  }
  // An older merge's watch window is already over, and a fresh verifier must
  // not open watches for months of history.
  if (ctx.now.getTime() - Date.parse(pr.mergedAt) > ctx.rules.windowHours * HOUR_MS) {
    return skip(`merged more than ${ctx.rules.windowHours}h ago`);
  }
  // Subjects `publish-journal.ts` writes: the harness's records, not the product.
  if (/^chore\([^)]*\): (journal|learning) /.test(pr.title)) return skip("is a journal or learnings commit");
  if (pr.body.includes("<!-- ci-doctor ") || pr.labels.includes("ci-health")) return skip("is a ci-doctor PR");
  const medics = ctx.roster.filter((entry) => entry.role === "pr-medic").map((entry) => `${entry.name}/`);
  if (pr.body.includes("<!-- pr-medic:") || medics.some((prefix) => pr.headRefName.startsWith(prefix))) {
    return skip("is a pr-medic PR");
  }
  if (pr.body.includes(VERIFIER_REVERT_MARKER)) return skip("is a verifier revert");
  const ticket = ticketOf(pr, ctx.tracker);
  if (ticket === null) return skip("closes no tracker ticket");
  const author = loopAuthor(pr.body, ctx.roster);
  if (author !== null && !ctx.rules.follow.loopPrs) return skip(`is a ${author} loop PR and verifier.follow.loopPrs is false`);
  if (author === null && !ctx.rules.follow.humanPrs) return skip("is a human PR and verifier.follow.humanPrs is false");
  return { kind: "qualified", candidate: { pr: pr.number, ...ticket, mergeCommit: pr.mergeCommit, mergedAt: pr.mergedAt } };
}

const FIELDS = "number,title,body,headRefName,mergeCommit,mergedAt,labels,closingIssuesReferences";

function parsePr(row: unknown): MergedPr | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.number !== "number") return null;
  const oid = (r.mergeCommit as { oid?: unknown } | null | undefined)?.oid;
  const names = (list: unknown, field: "name" | "number"): unknown[] =>
    Array.isArray(list) ? list.map((item) => (item as Record<string, unknown> | null)?.[field]) : [];
  return {
    number: r.number,
    title: typeof r.title === "string" ? r.title : "",
    body: typeof r.body === "string" ? r.body : "",
    headRefName: typeof r.headRefName === "string" ? r.headRefName : "",
    mergeCommit: typeof oid === "string" && oid !== "" ? oid : null,
    mergedAt: typeof r.mergedAt === "string" && r.mergedAt !== "" ? r.mergedAt : null,
    labels: names(r.labels, "name").filter((name): name is string => typeof name === "string"),
    closingIssues: names(r.closingIssuesReferences, "number").filter((n): n is number => typeof n === "number"),
  };
}

/**
 * The PRs merged into `base` since `since`, or why they could not be read.
 * Bounded by a merge-date search, not by the page: gh lists by creation date,
 * so a PR opened long ago and merged today would sit below a page of newer
 * ones, and the long-lived PRs are the risky ones.
 */
export async function listMerged(gh: Gh, base: string, since: Date): Promise<{ ok: true; prs: MergedPr[] } | { ok: false; why: string }> {
  const search = `merged:>=${since.toISOString().replace(/\.\d+Z$/, "Z")} sort:updated-desc`;
  let ran: Awaited<ReturnType<Gh>>;
  try {
    ran = await gh(["pr", "list", "--state", "merged", "--base", base, "--search", search, "--limit", String(MERGED_PAGE), "--json", FIELDS]);
  } catch (error) {
    return { ok: false, why: `gh pr list failed: ${firstLine((error as Error)?.message ?? String(error))}` };
  }
  if (!ran.ok) return { ok: false, why: `gh pr list failed: ${firstLine(ran.stderr.trim()) || "no output"}` };
  let rows: unknown;
  try {
    rows = JSON.parse(ran.stdout);
  } catch {
    return { ok: false, why: "gh pr list did not answer JSON" };
  }
  if (!Array.isArray(rows)) return { ok: false, why: "gh pr list did not answer a list" };
  return { ok: true, prs: rows.map(parsePr).filter((pr): pr is MergedPr => pr !== null) };
}

const firstLine = (text: string): string => text.split("\n")[0] ?? "";
