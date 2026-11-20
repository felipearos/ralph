/**
 * "Has the production deploy containing commit X landed, and when?"
 * (felipearos/ralph#563, spec #560). The verifier opens a watch only once a
 * merge is live, and times its check-ins from the deploy, not the merge.
 * Two sources answer it: Vercel's deployment list, and GitHub Deployments
 * (#564) for a project that records its production deploys there.
 *
 * Nothing here throws: a vendor that cannot be read is `unavailable`, which
 * the gate treats as "look again next poll", never as a stopped loop.
 */
import type { VerifierRules } from "../project-config";
import { CALL_TIMEOUT_MS, type Fetch } from "./credentials";

export type LandedDeploy =
  | { kind: "landed"; id: string; url: string | null; deployedAt: string }
  | { kind: "pending"; why: string }
  | { kind: "unavailable"; why: string };

export type DeploySourceReader = (mergeCommit: string, mergedAt: string) => Promise<LandedDeploy>;

/** Is `ancestor` in `descendant`'s history? null = could not tell. */
export type Contains = (ancestor: string, descendant: string) => Promise<boolean | null>;

/** One gh command's outcome, the shape ci-doctor's gate uses. */
export type Gh = (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/** How many recent production deploys one read looks through. */
export const DEPLOY_PAGE = 50;

interface VercelDeployment {
  uid: string;
  url: string | null;
  deployedAt: number;
  sha: string;
}

function parseDeployments(body: unknown): VercelDeployment[] | null {
  if (typeof body !== "object" || body === null) return null;
  const list = (body as { deployments?: unknown }).deployments;
  if (!Array.isArray(list)) return null;
  const out: VercelDeployment[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const d = item as { uid?: unknown; url?: unknown; created?: unknown; ready?: unknown; meta?: { githubCommitSha?: unknown } };
    const sha = d.meta?.githubCommitSha;
    // A deploy with no commit (a CLI deploy, a redeploy of a build) cannot be placed in history.
    if (typeof sha !== "string" || sha === "" || typeof d.uid !== "string") continue;
    const at = typeof d.ready === "number" ? d.ready : typeof d.created === "number" ? d.created : null;
    if (at === null) continue;
    out.push({ uid: d.uid, url: typeof d.url === "string" ? d.url : null, deployedAt: at, sha });
  }
  return out;
}

/** The Vercel reader for a project whose `verifier.deploy.source` is vercel. */
export function vercelLandedDeploy(
  deploy: Extract<VerifierRules["deploy"], { source: "vercel" }>,
  token: string,
  fetcher: Fetch,
  contains: Contains,
  // Overridable so a spawned gate test can point it at a local responder.
  origin = "https://api.vercel.com",
): DeploySourceReader {
  const { project, team } = deploy;
  // Same spelling rule as credentials.ts: a team id goes in `teamId`, a slug in `slug`.
  const teamQuery = team === null ? "" : team.startsWith("team_") ? `&teamId=${encodeURIComponent(team)}` : `&slug=${encodeURIComponent(team)}`;
  const url =
    `${origin}/v6/deployments?projectId=${encodeURIComponent(project)}` +
    `&target=production&state=READY&limit=${DEPLOY_PAGE}${teamQuery}`;

  return async (mergeCommit, mergedAt) => {
    // Only deploys since the merge: the page is newest first, so without this
    // a busy day could push the earliest deploy carrying the merge off it.
    const sinceQuery = Number.isFinite(Date.parse(mergedAt)) ? `&since=${Date.parse(mergedAt)}` : "";
    let response: Response;
    try {
      response = await fetcher(`${url}${sinceQuery}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (error) {
      return { kind: "unavailable", why: `Vercel could not be reached: ${firstLine((error as Error)?.message ?? String(error))}` };
    }
    if (!response.ok) return { kind: "unavailable", why: `Vercel answered ${response.status} listing deployments of ${project}` };
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      return { kind: "unavailable", why: `Vercel's deployment list was not JSON: ${firstLine((error as Error)?.message ?? String(error))}` };
    }
    const deployments = parseDeployments(body);
    if (deployments === null) return { kind: "unavailable", why: "Vercel's deployment list had no 'deployments' array" };

    const since = Date.parse(mergedAt);
    // Earliest first: the first deploy that carries the merge is when it went live.
    const candidates = deployments.filter((d) => d.deployedAt >= since).sort((a, b) => a.deployedAt - b.deployedAt);
    for (const d of candidates) {
      let has: boolean | null;
      try {
        has = await contains(mergeCommit, d.sha);
      } catch {
        has = null;
      }
      // Skipping an undecidable candidate could pick a later deploy and time check-ins wrongly.
      if (has === null) return { kind: "unavailable", why: `could not tell whether deploy ${d.uid} (${d.sha.slice(0, 12)}) contains ${mergeCommit.slice(0, 12)}` };
      if (has) return { kind: "landed", id: d.uid, url: d.url, deployedAt: new Date(d.deployedAt).toISOString() };
    }
    return { kind: "pending", why: `no READY production deploy of ${project} since ${mergedAt} contains ${mergeCommit.slice(0, 12)}` };
  };
}

/** How many statuses of one GitHub deployment a read looks through. */
const STATUS_PAGE = 20;

/**
 * How many pages of GitHub deployments one read walks back through. GitHub's
 * list has no `since` filter, so a busy day can push the earliest deployment
 * since a merge off the first page; past this cap the read says so rather than
 * anchor check-ins on a later deployment.
 */
export const GITHUB_DEPLOY_PAGES = 5;

interface GithubDeployment {
  id: number;
  sha: string;
  createdAt: number;
}

function parseGithubDeployments(body: unknown, environment: string): GithubDeployment[] | null {
  if (!Array.isArray(body)) return null;
  const out: GithubDeployment[] = [];
  for (const item of body) {
    if (typeof item !== "object" || item === null) continue;
    const d = item as { id?: unknown; sha?: unknown; environment?: unknown; created_at?: unknown };
    // The query filters by environment already; checked again so an ignored filter cannot land a preview.
    // GitHub matches environment names regardless of case, and integrations record `Production`.
    if (typeof d.environment !== "string" || d.environment.toLowerCase() !== environment.toLowerCase()) continue;
    if (typeof d.id !== "number" || typeof d.sha !== "string" || d.sha === "") continue;
    const at = typeof d.created_at === "string" ? Date.parse(d.created_at) : NaN;
    if (!Number.isFinite(at)) continue;
    out.push({ id: d.id, sha: d.sha, createdAt: at });
  }
  return out;
}

/**
 * When a deployment first went live, from its statuses: the earliest
 * `success`. Not the newest status alone — GitHub marks an older successful
 * deployment `inactive` once a newer one succeeds, and it was still live
 * from its success on. null = it never succeeded (failed, errored, pending).
 */
function firstSuccess(body: unknown[]): { at: number; url: string | null } | null {
  let best: { at: number; url: string | null } | null = null;
  for (const item of body) {
    if (typeof item !== "object" || item === null) continue;
    const s = item as { state?: unknown; created_at?: unknown; environment_url?: unknown; target_url?: unknown };
    if (s.state !== "success") continue;
    const at = typeof s.created_at === "string" ? Date.parse(s.created_at) : NaN;
    if (!Number.isFinite(at)) continue;
    const url = nonEmpty(s.environment_url) ?? nonEmpty(s.target_url);
    if (best === null || at < best.at) best = { at, url };
  }
  return best;
}

const nonEmpty = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** Runs one `gh api` read and parses its JSON; a string is the reason it could not. */
async function ghJson(gh: Gh, path: string, failed: string, what: string): Promise<{ body: unknown } | string> {
  let ran: Awaited<ReturnType<Gh>>;
  try {
    ran = await gh(["api", path]);
  } catch (error) {
    return `${failed}: ${firstLine((error as Error)?.message ?? String(error))}`;
  }
  if (!ran.ok) return `${failed}: ${firstLine(ran.stderr)}`;
  try {
    return { body: JSON.parse(ran.stdout) };
  } catch (error) {
    return `GitHub's ${what} was not JSON: ${firstLine((error as Error)?.message ?? String(error))}`;
  }
}

/** The GitHub Deployments reader for a project whose `verifier.deploy.source` is github-deployments. */
export function githubLandedDeploy(
  deploy: Extract<VerifierRules["deploy"], { source: "github-deployments" }>,
  gh: Gh,
  contains: Contains,
): DeploySourceReader {
  const { environment } = deploy;
  const listPath = `repos/{owner}/{repo}/deployments?environment=${encodeURIComponent(environment)}&per_page=${DEPLOY_PAGE}`;

  return async (mergeCommit, mergedAt) => {
    const since = Date.parse(mergedAt);
    const deployments: GithubDeployment[] = [];
    for (let page = 1; ; page++) {
      const path = page === 1 ? listPath : `${listPath}&page=${page}`;
      const listed = await ghJson(gh, path, "GitHub deployments could not be listed", "deployments list");
      if (typeof listed === "string") return { kind: "unavailable", why: listed };
      if (!Array.isArray(listed.body)) return { kind: "unavailable", why: "GitHub's deployments list was not an array" };
      deployments.push(...(parseGithubDeployments(listed.body, environment) ?? []));
      // Newest first: a short page is the end of the list, and an entry older
      // than the merge means every deployment since it has been seen. An
      // unparsable merge time filters nothing, so the first page is all it reads.
      if (listed.body.length < DEPLOY_PAGE || !Number.isFinite(since)) break;
      const oldest = Math.min(...listed.body.map((item: { created_at?: unknown } | null) => Date.parse(String(item?.created_at))).filter(Number.isFinite));
      if (oldest < since) break;
      if (page >= GITHUB_DEPLOY_PAGES) {
        return { kind: "unavailable", why: `more than ${GITHUB_DEPLOY_PAGES * DEPLOY_PAGE} GitHub deployments since ${mergedAt}; the earliest carrying ${mergeCommit.slice(0, 12)} cannot be told` };
      }
    }

    // A deployment created before the merge cannot contain it.
    const recent = Number.isFinite(since) ? deployments.filter((d) => d.createdAt >= since) : deployments;
    recent.sort((a, b) => a.createdAt - b.createdAt);

    // Earliest creation first. A deployment goes live no earlier than it is
    // created, so once one carrying the merge is live, none created after that
    // moment can beat it, and their statuses need not be read.
    let best: { id: number; url: string | null; liveAt: number } | null = null;
    for (const d of recent) {
      if (best !== null && d.createdAt >= best.liveAt) break;
      const statuses = await ghJson(
        gh,
        `repos/{owner}/{repo}/deployments/${d.id}/statuses?per_page=${STATUS_PAGE}`,
        `GitHub statuses of deployment ${d.id} could not be read`,
        `status list of deployment ${d.id}`,
      );
      if (typeof statuses === "string") return { kind: "unavailable", why: statuses };
      if (!Array.isArray(statuses.body)) return { kind: "unavailable", why: `GitHub's statuses of deployment ${d.id} were not an array` };
      const live = firstSuccess(statuses.body);
      if (live === null || (best !== null && live.at >= best.liveAt)) continue;
      let has: boolean | null;
      try {
        has = await contains(mergeCommit, d.sha);
      } catch {
        has = null;
      }
      // Skipping an undecidable candidate could pick a later deployment and time check-ins wrongly.
      if (has === null) return { kind: "unavailable", why: `could not tell whether GitHub deployment ${d.id} (${d.sha.slice(0, 12)}) contains ${mergeCommit.slice(0, 12)}` };
      if (has) best = { id: d.id, url: live.url, liveAt: live.at };
    }
    if (best !== null) return { kind: "landed", id: String(best.id), url: best.url, deployedAt: new Date(best.liveAt).toISOString() };
    return { kind: "pending", why: `no successful ${environment} deployment since ${mergedAt} contains ${mergeCommit.slice(0, 12)}` };
  };
}

/** `contains` from GitHub's compare API, run through gh in the project's repo. */
export function ghContains(gh: Gh): Contains {
  return async (ancestor, descendant) => {
    if (ancestor === descendant) return true;
    let ran: Awaited<ReturnType<Gh>>;
    try {
      ran = await gh(["api", `repos/{owner}/{repo}/compare/${ancestor}...${descendant}`, "--jq", ".status"]);
    } catch {
      return null;
    }
    if (!ran.ok) return null;
    const status = ran.stdout.trim();
    if (status === "identical" || status === "ahead") return true;
    if (status === "behind" || status === "diverged") return false;
    return null;
  };
}

const firstLine = (text: string): string => text.split("\n")[0] ?? "";
