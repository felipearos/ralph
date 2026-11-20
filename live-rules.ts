/**
 * A gate's rules, read live from `origin/<baseBranch>:.ralph/config.json`
 * (felipearos/ralph#788).
 *
 * The sentinel and verifier gates used to read `.ralph/config.json` once, from
 * the worktree, when they started. The worktree is fast-forwarded only when
 * the supervisor starts, so a rules change merged at midnight waited for an
 * operator to restart the loop. Now each poll asks this module first: a
 * bounded fetch of the base branch (rate-limited, so a short poll cannot
 * hammer the remote), then the config as that branch has it, parsed and
 * validated by the same parser every other reader uses.
 *
 * It keeps the last valid rules. A fetch that fails or hangs, a ref that is
 * not there, a config that is not JSON or does not validate, a role block
 * that is gone: each is a one-line reason, and the gate goes on with the
 * rules it last held. The rules it started with count as the first ones held.
 * Nothing here throws out of a poll — the gate runs overnight, and a missing
 * or malformed signal must leave it running as it was, never stopped.
 *
 * The last valid config is also kept on disk, in the worktree's
 * `.ralph/logs/` (ignored, never committed), with the commit it came from.
 * A gate restarts after every hand-over, and an iteration reads the rules
 * too (`sentinel/issue.ts` records a draft's mode): {@link freshestConfig}
 * reads that copy when it is at least as new as the worktree, so a restarted
 * gate and the session it handed work to agree with the gate before them.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CONFIG_RELATIVE_PATH, LOGS_RELATIVE_DIR } from "./paths";
import { loadProjectConfig, parseProjectConfig, ProjectConfigError, type ProjectConfig } from "./project-config";

/** One bounded git call's outcome. Never a throw: a failure is `ok: false` with why. */
export interface GitResult {
  ok: boolean;
  stdout: string;
  /** The first line of stderr, or what bounded the call ("timed out after 30s"). */
  why: string;
}

/** How the module runs git; a seam for tests, real git by default. */
export type GitRunner = (args: string[], options: { cwd: string; timeoutMs: number }) => Promise<GitResult>;

export interface LiveRulesOptions<R> {
  /** The worktree the gate runs in: git runs here, and the last valid copy is kept under its `.ralph/logs/`. */
  root: string;
  /** Names the lines and the kept copy: `sentinel`, `verifier`. */
  role: string;
  baseBranch: string;
  /** The role's rules from a validated config, or null when it has no block for the role. May throw. */
  extract: (config: ProjectConfig) => R | null;
  /** What the gate started with: the first "last valid" rules. */
  initial: { config: ProjectConfig; rules: R; source: string };
  /** The least time between two fetches; a refresh inside it reads the ref as last fetched. */
  minFetchIntervalMs?: number;
  fetchTimeoutMs?: number;
  now?: () => number;
  git?: GitRunner;
  /** Where the last valid copy is kept; null keeps none. Defaults to {@link liveRulesStatePath}. */
  statePath?: string | null;
}

export interface RulesRefresh<R> {
  config: ProjectConfig;
  rules: R;
  /** Where the rules in hand came from: `origin/main@1a2b3c4d`, or the worktree. */
  source: string;
  /** The rules differ from the ones held before this refresh. */
  changed: boolean;
  /** Why the rules may be stale this refresh, or null when they were read and validated. */
  problem: string | null;
  /**
   * Lines to log, unprefixed: a change, once; a new reason the rules were
   * kept, once per distinct reason; and the recovery, once. Empty on a quiet poll.
   */
  lines: string[];
}

export interface LiveRules<R> {
  refresh(): Promise<RulesRefresh<R>>;
  /** The rules in hand, without reading anything. */
  current(): { config: ProjectConfig; rules: R; source: string };
}

/** A floor under the fetch interval: a 1-second poll must not fetch every second. */
export const MIN_FETCH_INTERVAL_MS = 30_000;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const LOCAL_GIT_TIMEOUT_MS = 10_000;
/** Past its timeout a killed git gets this long to exit before the call stops waiting on it. */
const KILL_GRACE_MS = 2_000;
const REASON_CHARS = 300;

/** The kept copy of a role's last valid config, in the worktree's ignored logs directory. */
export const liveRulesStatePath = (root: string, role: string): string => join(root, LOGS_RELATIVE_DIR, `live-rules-${role}.json`);

interface KeptState {
  version: 1;
  baseBranch: string;
  /** The commit the kept config was read from; null when none was read yet. */
  commit: string | null;
  text: string | null;
  /** Epoch ms of the last fetch attempt, so a restarted gate keeps to the rate limit. */
  fetchedAt: number;
}

const firstLine = (text: string): string => text.trim().split("\n")[0]?.trim() ?? "";

const cut = (text: string): string => (text.length > REASON_CHARS ? `${text.slice(0, REASON_CHARS - 1)}…` : text);

const errorText = (error: unknown): string => {
  if (error instanceof ProjectConfigError && error.problems.length > 0) return error.problems.join("; ");
  return firstLine((error as Error)?.message ?? String(error));
};

/**
 * Real git, bounded. Prompts are off (`GIT_TERMINAL_PROMPT=0`, ssh in batch
 * mode) because an unattended gate would sit on one forever, and git runs in
 * its own process group so a timeout kills the ssh it started as well. The
 * answer comes by the deadline plus a grace even if a killed child lingers.
 */
export const realGit: GitRunner = (args, { cwd, timeoutMs }) =>
  new Promise<GitResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn> | null = null;
    const limit = timeoutMs < 1000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1000)}s`;
    const finish = (result: GitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve(result);
    };
    const timer = setTimeout(() => {
      // Marked first: the exit the kill causes must not read as an answer.
      timedOut = true;
      try {
        if (child?.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      grace = setTimeout(() => finish({ ok: false, stdout, why: `timed out after ${limit}` }), KILL_GRACE_MS);
    }, timeoutMs);
    try {
      child = spawn("git", args, {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes" },
      });
    } catch (error) {
      finish({ ok: false, stdout: "", why: errorText(error) });
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => finish({ ok: false, stdout, why: errorText(error) }));
    child.on("close", (code) => {
      if (timedOut) finish({ ok: false, stdout, why: `timed out after ${limit}` });
      else finish({ ok: code === 0, stdout, why: code === 0 ? "" : firstLine(stderr) || `git exited ${code}` });
    });
  });

function readKept(path: string | null): KeptState | null {
  if (path === null) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<KeptState>;
    if (raw?.version !== 1 || typeof raw.baseBranch !== "string") return null;
    return {
      version: 1,
      baseBranch: raw.baseBranch,
      commit: typeof raw.commit === "string" ? raw.commit : null,
      text: typeof raw.text === "string" ? raw.text : null,
      fetchedAt: typeof raw.fetchedAt === "number" && Number.isFinite(raw.fetchedAt) ? raw.fetchedAt : 0,
    };
  } catch {
    return null;
  }
}

/** Best effort: a copy that cannot be written costs only the next restart's head start. */
function writeKept(path: string | null, state: KeptState): void {
  if (path === null) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state)}\n`);
    renameSync(tmp, path);
  } catch {
    // Ignored, see above.
  }
}

/**
 * The project config a gate or an iteration should start from: the copy the
 * gate last read from origin, when that commit is at or ahead of the
 * worktree's HEAD, else the worktree's own. Throws as `loadProjectConfig`
 * does when it falls back to a worktree config that cannot be read, so a
 * caller's existing refusal is unchanged.
 */
export function freshestConfig(
  root: string,
  role: string,
  statePath: string | null = liveRulesStatePath(root, role),
): { config: ProjectConfig; source: string; commit: string | null } {
  const kept = readKept(statePath);
  if (kept !== null && kept.commit !== null && kept.text !== null) {
    // HEAD an ancestor of the kept commit: the kept copy is at least as new.
    // A worktree moved past it (a fast-forward at the supervisor's start) wins.
    const ahead = spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", kept.commit], {
      cwd: root,
      stdio: "ignore",
      timeout: LOCAL_GIT_TIMEOUT_MS,
    });
    if (ahead.status === 0) {
      try {
        const source = `origin/${kept.baseBranch}@${kept.commit.slice(0, 8)}`;
        return { config: parseProjectConfig(kept.text, `${source}:${CONFIG_RELATIVE_PATH}`), source, commit: kept.commit };
      } catch {
        // A kept copy this build no longer accepts: the worktree's, as before.
      }
    }
  }
  return { config: loadProjectConfig(root), source: "the worktree", commit: null };
}

/** A rule's value as a change line shows it. */
function shown(value: unknown): string {
  if (value === undefined || value === null) return "none";
  if (typeof value === "string") return value === "" ? '""' : value;
  return JSON.stringify(value);
}

function flatten(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) flatten(inner, prefix === "" ? key : `${prefix}.${key}`, out);
    return;
  }
  out.set(prefix, value);
}

/** What changed between two sets of rules: `mode observe → file, maxPerDay 5 → 10`. Empty when nothing did. */
export function describeRulesChange(before: unknown, after: unknown): string {
  const a = new Map<string, unknown>();
  const b = new Map<string, unknown>();
  flatten(before, "", a);
  flatten(after, "", b);
  const keys = [...new Set([...a.keys(), ...b.keys()])];
  const changes: string[] = [];
  for (const key of keys) {
    const from = a.get(key);
    const to = b.get(key);
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    changes.push(`${key || "rules"} ${shown(from)} → ${shown(to)}`);
  }
  return changes.join(", ");
}

/**
 * The live rules of one role. `refresh` is what a gate calls at the top of
 * every poll; it never rejects.
 */
export function createLiveRules<R>(options: LiveRulesOptions<R>): LiveRules<R> {
  const { root, role, baseBranch, extract } = options;
  const git = options.git ?? realGit;
  const now = options.now ?? Date.now;
  const minInterval = Math.max(MIN_FETCH_INTERVAL_MS, options.minFetchIntervalMs ?? 0);
  const fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const statePath = options.statePath === undefined ? liveRulesStatePath(root, role) : options.statePath;
  const ref = `origin/${baseBranch}`;

  let held = { config: options.initial.config, rules: options.initial.rules, source: options.initial.source };
  const kept = readKept(statePath);
  // The rate limit carries across restarts only for the same branch.
  let fetchedAt = kept !== null && kept.baseBranch === baseBranch ? kept.fetchedAt : 0;
  let keptCommit: string | null = kept !== null && kept.baseBranch === baseBranch ? kept.commit : null;
  let keptText: string | null = kept !== null && kept.baseBranch === baseBranch ? kept.text : null;
  let lastProblem: string | null = null;

  const persist = (): void => writeKept(statePath, { version: 1, baseBranch, commit: keptCommit, text: keptText, fetchedAt });

  async function read(): Promise<{ fetchProblem: string | null; result: { config: ProjectConfig; rules: R; commit: string } | { problem: string } }> {
    let fetchProblem: string | null = null;
    const at = now();
    if (at - fetchedAt >= minInterval || at < fetchedAt) {
      // Stamped before the call, so a fetch that fails or hangs is not retried
      // on the very next poll either.
      fetchedAt = at;
      const fetched = await git(["fetch", "--quiet", "origin", baseBranch], { cwd: root, timeoutMs: fetchTimeoutMs });
      if (!fetched.ok) fetchProblem = `could not fetch ${ref}: ${cut(fetched.why)}`;
      persist();
    }
    const resolved = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: root, timeoutMs: LOCAL_GIT_TIMEOUT_MS });
    const commit = resolved.stdout.trim();
    if (!resolved.ok || commit === "") return { fetchProblem, result: { problem: fetchProblem ?? `${ref} is not known in this clone` } };
    const shownFile = await git(["show", `${commit}:${CONFIG_RELATIVE_PATH}`], { cwd: root, timeoutMs: LOCAL_GIT_TIMEOUT_MS });
    const where = `${ref}:${CONFIG_RELATIVE_PATH}`;
    if (!shownFile.ok) return { fetchProblem, result: { problem: `could not read ${where}: ${cut(shownFile.why)}` } };
    let config: ProjectConfig;
    try {
      config = parseProjectConfig(shownFile.stdout, where);
    } catch (error) {
      const why = error instanceof ProjectConfigError && error.problems.length > 0 ? `${where} is invalid: ${error.problems.join("; ")}` : errorText(error);
      return { fetchProblem, result: { problem: cut(why) } };
    }
    let rules: R | null;
    try {
      rules = extract(config);
    } catch (error) {
      return { fetchProblem, result: { problem: cut(`${where}: ${errorText(error)}`) } };
    }
    if (rules === null) return { fetchProblem, result: { problem: `${where} has no '${role}' block` } };
    if (commit !== keptCommit) {
      keptCommit = commit;
      keptText = shownFile.stdout;
      persist();
    }
    return { fetchProblem, result: { config, rules, commit } };
  }

  async function refresh(): Promise<RulesRefresh<R>> {
    const lines: string[] = [];
    let changed = false;
    let problem: string | null;
    try {
      const { fetchProblem, result } = await read();
      if ("problem" in result) {
        problem = result.problem;
      } else {
        const diff = describeRulesChange(held.rules, result.rules);
        const source = `${ref}@${result.commit.slice(0, 8)}`;
        if (diff !== "") {
          changed = true;
          lines.push(`rules changed on ${ref} — ${diff}`);
        }
        held = { config: result.config, rules: result.rules, source };
        // Read and valid, but from the ref as last fetched: still worth saying once.
        problem = fetchProblem === null ? null : `${fetchProblem}; using ${ref} as last fetched`;
      }
    } catch (error) {
      // `read` handles its own failures; this is the guard on that promise.
      problem = cut(`the rules could not be read: ${errorText(error)}`);
    }
    if (problem !== null && problem !== lastProblem) {
      lines.push(`rules may be stale — ${problem}; keeping the rules from ${held.source}`);
    } else if (problem === null && lastProblem !== null) {
      lines.push(`rules read from ${held.source} again`);
    }
    lastProblem = problem;
    return { config: held.config, rules: held.rules, source: held.source, changed, problem, lines };
  }

  return { refresh, current: () => ({ ...held }) };
}

/**
 * A gate's deps with the rules of this poll: refreshed, the change and the
 * reasons logged, and the deps rebuilt from the new config when the rules
 * changed, so every read the poll makes (mode, caps, thresholds, the
 * reporter's project) follows the new rules. A rebuild that throws keeps the
 * old wiring with the new rules swapped in. Never rejects.
 */
export async function withLiveRules<R, D extends { rules: R }>(
  live: LiveRules<R>,
  deps: D,
  rewire: (config: ProjectConfig) => D,
  log: (line: string) => void,
): Promise<D> {
  let fresh: RulesRefresh<R>;
  try {
    fresh = await live.refresh();
  } catch {
    return deps;
  }
  for (const line of fresh.lines) log(line);
  if (!fresh.changed) return deps;
  try {
    return rewire(fresh.config);
  } catch (error) {
    log(`rules changed, but the gate could not be rewired for them (${errorText(error)}); the new rules apply with the old wiring`);
    return { ...deps, rules: fresh.rules };
  }
}
