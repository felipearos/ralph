/**
 * Branch claims — a live loop branch as a claim on its ticket (#480).
 *
 * A loop fences its ticket with a `<loop>-wip` label, but a label can vanish
 * (a rate-limit restart clears it) while the loop's branch `<loop>/<n>-<slug>`
 * still carries work that is neither pushed nor merged. The frontier would then
 * hand ticket n to a second loop. This module reads the other half of the
 * claim: a recent loop branch with commits ahead of the base branch names a
 * ticket some loop is still working on.
 *
 * It is a supervisor-side read, so it never throws: a git failure degrades to
 * "no branch claims", which is the behaviour the frontier had before it.
 */

/** Default {@link branchClaimMaxAgeMs}: one day. */
const DEFAULT_MAX_AGE_HOURS = 24;

const REMOTE_PREFIX = "origin/";

/**
 * Which loop and ticket a branch name carries, or null when it is not a loop
 * branch of this project.
 *
 * Accepts `rafa/480-slug`, `rafa/480` and the remote-tracking
 * `origin/rafa/480-slug`. The loop segment must be one of `roster`, so a
 * person's branch (`felipe/480-x`) is never read as a loop's claim; the number
 * has the same shape `linkKeyedPullRequests` reads from a PR head branch.
 */
export function parseLoopBranch(
  ref: string,
  roster: readonly string[],
): { loop: string; number: number } | null {
  const candidates = ref.startsWith(REMOTE_PREFIX) ? [ref, ref.slice(REMOTE_PREFIX.length)] : [ref];
  for (const name of candidates) {
    const match = /^([a-z][a-z0-9]*)\/([1-9][0-9]*)(?:-|$)/.exec(name);
    if (match !== null && roster.includes(match[1]!)) return { loop: match[1]!, number: Number(match[2]) };
  }
  return null;
}

/**
 * How old a branch tip may be and still claim its ticket, from
 * `RALPH_BRANCH_CLAIM_MAX_AGE_HOURS` (hours, default 24).
 *
 * The window exists because a squash-merged or abandoned branch stays "ahead"
 * of the base forever: without it, such a branch would hide its ticket from
 * every loop permanently. With it, an abandoned branch stops fencing its
 * ticket after a day, while a loop that was merely restarted mid-ticket keeps
 * its claim.
 */
export function branchClaimMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RALPH_BRANCH_CLAIM_MAX_AGE_HOURS?.trim() ?? "";
  const hours = raw === "" ? Number.NaN : Number(raw);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_MAX_AGE_HOURS) * 3_600_000;
}

export interface BranchClaimsIo {
  /** Run `git <args>` in the repository and resolve its stdout; rejects on failure. */
  git(args: string[]): Promise<string>;
  /** The ref a branch must be ahead of, e.g. `origin/main`. */
  base: string;
  roster: readonly string[];
  nowMs: number;
  maxAgeMs: number;
  /**
   * The open tickets, when the caller knows them. A branch for a closed or
   * unknown ticket fences nothing, so it is dropped before it costs a rev-list.
   */
  tickets?: ReadonlySet<number>;
  warn?(line: string): void;
}

/** One ticket's branch claim: the branch, and when its tip was committed. */
export interface BranchClaim {
  /** Local short name, without `origin/`. */
  branch: string;
  /** Committer time of the tip, in ms — what a later hand-back is compared to. */
  tipMs: number;
}

/**
 * Ticket number → branch claim for every recent loop branch with commits
 * ahead of `io.base`.
 *
 * The base is verified once up front, then one `for-each-ref` lists the
 * candidates; only refs that parse as a loop branch of an open ticket and are
 * recent reach `rev-list`, so the cost is bounded by the live loop branches,
 * not by every ref in the repository. A branch present both locally and on
 * `origin` costs one rev-list when its newer copy counts. When several
 * branches name one ticket, the most recent tip wins, ties broken by name, so
 * the answer does not depend on ref order.
 */
export async function readBranchClaims(io: BranchClaimsIo): Promise<Map<number, BranchClaim>> {
  const claims = new Map<number, BranchClaim>();
  try {
    await io.git(["rev-parse", "--verify", "--quiet", `${io.base}^{commit}`]);
  } catch {
    // Without a base nothing can be "ahead" of it: one warning, rather than a
    // failed rev-list per candidate that silently drops every claim.
    io.warn?.(`branch claims: base ${io.base} does not resolve, reading no branch claims`);
    return claims;
  }

  let listing: string;
  try {
    // Full refnames, not `:short`: a short name is ambiguous when a local branch
    // and a remote ref share it, and rev-list needs an unambiguous ref.
    listing = await io.git([
      "for-each-ref",
      "--format=%(refname)%09%(committerdate:unix)",
      "refs/heads",
      "refs/remotes/origin",
    ]);
  } catch (error) {
    io.warn?.(`branch claims: git for-each-ref failed, reading no branch claims: ${oneLine(error)}`);
    return claims;
  }

  // Copies of one branch name (local and `origin/`), grouped so the name is
  // asked about once.
  const byName = new Map<string, { number: number; copies: { ref: string; tipMs: number; local: boolean }[] }>();
  for (const line of listing.split("\n")) {
    const [ref, unix] = line.trim().split("\t");
    if (ref === undefined || ref === "" || unix === undefined) continue;
    const short = ref.startsWith("refs/heads/")
      ? ref.slice("refs/heads/".length)
      : ref.startsWith("refs/remotes/")
        ? ref.slice("refs/remotes/".length)
        : null;
    if (short === null) continue;
    const parsed = parseLoopBranch(short, io.roster);
    if (parsed === null) continue;
    if (io.tickets !== undefined && !io.tickets.has(parsed.number)) continue;
    const tipMs = Number(unix) * 1000;
    if (!Number.isFinite(tipMs) || io.nowMs - tipMs > io.maxAgeMs) continue;
    const local = ref.startsWith("refs/heads/");
    const name = local ? short : short.slice(REMOTE_PREFIX.length);
    const entry = byName.get(name) ?? { number: parsed.number, copies: [] };
    entry.copies.push({ ref, tipMs, local });
    byName.set(name, entry);
  }

  const ahead = async (ref: string): Promise<boolean> => {
    try {
      return Number((await io.git(["rev-list", "--count", `${io.base}..${ref}`])).trim()) > 0;
    } catch {
      // The base resolved, so this is one unreadable ref: only its claim is lost.
      return false;
    }
  };

  // Newest copy first, local before remote on a tie: the first copy that
  // counts carries the newest tip of the copies that count, so the rest are
  // never asked about.
  const counted = await Promise.all(
    [...byName].map(async ([name, { number, copies }]) => {
      copies.sort((a, b) => b.tipMs - a.tipMs || Number(b.local) - Number(a.local));
      for (const copy of copies) {
        if (await ahead(copy.ref)) return { name, number, tipMs: copy.tipMs };
      }
      return null;
    }),
  );

  for (const candidate of counted) {
    if (candidate === null) continue;
    const current = claims.get(candidate.number);
    if (
      current === undefined ||
      candidate.tipMs > current.tipMs ||
      (candidate.tipMs === current.tipMs && candidate.name < current.branch)
    ) {
      claims.set(candidate.number, { branch: candidate.name, tipMs: candidate.tipMs });
    }
  }
  return claims;
}

function oneLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "unknown error";
}
