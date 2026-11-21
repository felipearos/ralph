/**
 * The app repos' pull requests, for the intake page's Seguimiento column: a
 * PR that names an intake ticket's key (OAI-n) or the team ticket it moved to
 * (OA-n) in its title, body or branch is the ticket's last stage.
 *
 * It is a best-effort read for people to look at, never an input to the
 * gate. So it is cheap — one `gh pr list` per repo per refresh, never one per
 * ticket, and at most one refresh every `PULLS_REFRESH_MS` — and it cannot
 * hold a poll up or fail it: each call is time-boxed, and a failure is a note
 * with the last list that was read (or none), never a throw.
 *
 * `gh search prs` with one OR query per refresh was the first idea, but
 * GitHub's search takes at most five OR operators and does not search branch
 * names, so a board of tickets would need a search per handful of keys; the
 * newest PRs of each repo, matched here, are fewer calls and also see the
 * branch.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { withoutCode } from "../markdown-code";

/** At most one refresh this often: a PR's state does not need to be fresher than the canvas. */
export const PULLS_REFRESH_MS = 15 * 60_000;

/** The newest PRs read per repo: far past the tickets an intake board holds open at once. */
export const PULLS_PER_REPO = 200;

/** A `gh` call that has not answered in this long is a failure, not a wait. */
export const GH_TIMEOUT_MS = 30_000;

export const PULL_STATES = ["abierto", "mergeado", "cerrado", "borrador"] as const;
export type PullState = (typeof PULL_STATES)[number];

/** One PR, as the cache keeps it: the ticket keys it names, never its body. */
export interface PullRef {
  repo: string;
  number: number;
  url: string;
  state: PullState;
  /** When it reached its state: merged, closed, else opened (ISO). */
  at: string | null;
  /** Every `ABC-123` its title, body or branch names, upper-cased. */
  keys: string[];
}

/** One row of `gh pr list --json`, as far as it is read. */
interface GhPull {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  headRefName?: unknown;
  state?: unknown;
  isDraft?: unknown;
  url?: unknown;
  createdAt?: unknown;
  mergedAt?: unknown;
  closedAt?: unknown;
}

const GH_FIELDS = "number,title,body,headRefName,state,isDraft,url,createdAt,mergedAt,closedAt";

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const isoOrNull = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/**
 * The ticket keys a text names. A branch is lower case (`oai-12-fix`), so
 * case is ignored; a key is not a key inside a longer word or number, so
 * `OAI-1` is not read out of `OAI-12` or `XOAI-1`.
 */
export function keysIn(...texts: string[]): string[] {
  const keys = new Set<string>();
  for (const value of texts) {
    for (const match of value.matchAll(/(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]*-\d+)(?!\d)/g)) keys.add(match[1]!.toUpperCase());
  }
  return [...keys];
}

/** `gh pr list --json` rows as the cache keeps them; a row missing its number or link is dropped. */
export function pullRefs(repo: string, rows: unknown): PullRef[] {
  if (!Array.isArray(rows)) throw new Error(`gh pr list for ${repo} printed no list`);
  return (rows as GhPull[]).flatMap((row) => {
    if (typeof row?.number !== "number" || text(row.url) === "") return [];
    const state: PullState = row.state === "MERGED" ? "mergeado" : row.state === "OPEN" ? (row.isDraft === true ? "borrador" : "abierto") : "cerrado";
    const at = state === "mergeado" ? isoOrNull(row.mergedAt) : state === "cerrado" ? isoOrNull(row.closedAt) : isoOrNull(row.createdAt);
    // A key the body quotes as code is cited, not claimed: a PR copying its
    // ticket's criteria (pr-ref --criteria, #17) must not move a sibling on merge.
    return [{ repo, number: row.number, url: text(row.url), state, at: at ?? isoOrNull(row.createdAt), keys: keysIn(text(row.title), withoutCode(text(row.body)), text(row.headRefName)) }];
  });
}

/** The PRs that name any of `keys`, oldest first by the time each reached its state. */
export function pullsNaming(pulls: readonly PullRef[], keys: readonly string[]): PullRef[] {
  const wanted = new Set(keys.map((key) => key.toUpperCase()));
  const ms = (pull: PullRef): number => (pull.at === null ? 0 : Date.parse(pull.at) || 0);
  return pulls.filter((pull) => pull.keys.some((key) => wanted.has(key))).sort((a, b) => ms(a) - ms(b) || a.number - b.number);
}

/** Run `gh` with `args`, its stdout or a throw; the default spawns it, time-boxed. */
export type GhRunner = (args: string[]) => Promise<string>;

export const spawnGh: GhRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile("gh", args, { encoding: "utf8", timeout: GH_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${(stderr || error.message).trim().split("\n")[0]}`));
      else resolve(stdout);
    });
  });

interface PullsCache {
  v: 1;
  /** When a refresh was last tried, whether or not it worked: the clock the next one waits on. */
  triedAt: string;
  repos: string[];
  pulls: PullRef[];
}

function readCache(path: string): PullsCache | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<PullsCache>;
    return value?.v === 1 && Array.isArray(value.pulls) && Array.isArray(value.repos) && typeof value.triedAt === "string" ? (value as PullsCache) : null;
  } catch {
    return null;
  }
}

function writeCache(path: string, cache: PullsCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(cache)}\n`);
    renameSync(temp, path);
  } catch {
    // Only the cache is lost: the next rebuild reads GitHub again.
  }
}

/** Beside the clerk store: `<loop>.json` becomes `<loop>.pulls.json`. */
export const pullsCachePath = (storePath: string): string => storePath.replace(/(\.json)?$/, ".pulls.json");

export interface PullsRead {
  pulls: PullRef[];
  /** Why the list is old or empty, for the poll's log; null when it is fresh or still fresh enough. */
  note: string | null;
}

/**
 * The repos' PRs: the cached list while it is younger than `PULLS_REFRESH_MS`,
 * else one `gh pr list` per repo. A refresh that fails keeps the last list
 * that was read, if any, and waits the same interval before trying again, so
 * a GitHub outage costs one note a quarter hour and never a poll.
 */
export async function readPulls(options: { cachePath: string; repos: readonly string[]; nowMs: number; gh?: GhRunner }): Promise<PullsRead> {
  const { cachePath, repos, nowMs } = options;
  if (repos.length === 0) return { pulls: [], note: null };
  const cache = readCache(cachePath);
  const sameRepos = cache !== null && cache.repos.join("\n") === repos.join("\n");
  const age = cache === null ? Number.POSITIVE_INFINITY : nowMs - Date.parse(cache.triedAt);
  if (sameRepos && age >= 0 && age < PULLS_REFRESH_MS) return { pulls: cache.pulls, note: null };
  const kept = sameRepos ? cache.pulls : [];
  const triedAt = new Date(nowMs).toISOString();
  try {
    const gh = options.gh ?? spawnGh;
    const pulls: PullRef[] = [];
    for (const repo of repos) {
      const out = await gh(["pr", "list", "--repo", repo, "--state", "all", "--limit", String(PULLS_PER_REPO), "--json", GH_FIELDS]);
      pulls.push(...pullRefs(repo, JSON.parse(out)));
    }
    writeCache(cachePath, { v: 1, triedAt, repos: [...repos], pulls });
    return { pulls, note: null };
  } catch (error) {
    writeCache(cachePath, { v: 1, triedAt, repos: [...repos], pulls: kept });
    const what = kept.length === 0 ? "the intake page shows no PRs" : `the intake page keeps the ${kept.length} read before`;
    return { pulls: kept, note: `pull requests not read from ${repos.join(", ")} — ${(error as Error).message}; ${what}, tried again in ${PULLS_REFRESH_MS / 60_000}m` };
  }
}
