/**
 * The onboarding side of the runtime adapter: the git and `gh` commands that
 * add a project and set it up, and how their answers are read.
 *
 * A sibling of `lifecycle-adapter.ts`, and for the same reason: this is the
 * only code above the process boundary that names these commands.
 * It owns the executor too, behind `guarded()`, so `onboarding.ts` above it
 * asks for an operation and reads an answer: it never holds a command it
 * could run differently, and a spawn that throws (a dialog program that is
 * not installed, say) comes back as a null status instead of an unhandled
 * rejection, the same shape as any other command that could not run.
 *
 * The surface is a closed list. Reads: `rev-parse`, `cat-file`,
 * `symbolic-ref`, `remote get-url`, `status`, `gh repo list`, `gh repo view`,
 * `gh api user`, the base branch's check runs and commit status through
 * `gh api`, `gh pr list`, `ls-remote` and `log` of the setup branch,
 * `check-ignore` of the setup files, the harness's `project-config --json`,
 * and the host's folder dialog (`zenity`, or `osascript` on macOS), which
 * only prints the folder chosen.
 * Writes, each onto something the dashboard creates: `gh repo clone` into a
 * directory that does not exist yet; `fetch` of the base branch;
 * `switch -C ralph-setup` (the dashboard's own branch, recreated from the
 * base on each attempt), `add`, `commit`, `push` and `fetch` of it; `gh pr
 * create` for it; `checkout` back to where the main checkout was; and, when
 * an attempt fails before its commit, `restore --staged` of what it added and
 * `update-ref -d` of a local `ralph-setup` it created and made no commit on.
 * Nothing resets, cleans, stashes, force-pushes, or deletes anything else.
 */
import { join, resolve } from "node:path";

import { defaultBunPath, isRecord } from "./adapter";
import { GITHUB_REPO, type Env, type GithubRepoView } from "./contracts";
import { guarded, type ExecResult, type Executor, type Invocation } from "./control-adapter";

/** The branch a setup PR is opened from. Not a loop's `<loop>/<n>-…` shape. */
export const SETUP_BRANCH = "ralph-setup";

export const SETUP_COMMIT_MESSAGE = "Set up Ralph";

/** The config setup writes; the other three files are where it points. */
export const CONFIG_FILE = ".ralph/config.json";

/** The harness's template for each fragment setup writes beside the config, by the config key naming its path. */
export const SETUP_TEMPLATES = {
  promptFragment: "examples/.ralph/prompt.md",
  coderFragment: "examples/.ralph/coder.md",
  plan: "examples/plan.md",
} as const;

export const ONBOARDING_SURFACE = {
  git: {
    command: "git",
    toplevel: ["rev-parse", "--show-toplevel"],
    configOn: (base: string): string[] => ["cat-file", "-e", `origin/${base}:${CONFIG_FILE}`],
    originHead: ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    /** Every checkout of the repo, the main one first: loop worktrees carry the config the main checkout may lack. */
    worktreeList: ["worktree", "list", "--porcelain"],
    remoteUrl: ["remote", "get-url", "origin"],
    fetchBase: (base: string): string[] => ["fetch", "--quiet", "origin", base],
    status: ["status", "--porcelain"],
    head: ["rev-parse", "--abbrev-ref", "HEAD"],
    headSha: ["rev-parse", "HEAD"],
    switchSetup: (base: string): string[] => ["switch", "--quiet", "-C", SETUP_BRANCH, `origin/${base}`],
    add: (files: readonly string[]): string[] => ["add", "--", ...files],
    // A fresh clone has no dependencies installed, so a project's hooks would
    // fail on four text files that its own review will read anyway.
    commit: ["commit", "--quiet", "--no-verify", "-m", SETUP_COMMIT_MESSAGE],
    push: ["push", "--quiet", "--set-upstream", "origin", SETUP_BRANCH],
    restore: (ref: string): string[] => ["checkout", "--quiet", ref],
    /** Exit 0: origin has the setup branch; exit 2: it does not. */
    remoteSetup: ["ls-remote", "--exit-code", "--heads", "origin", SETUP_BRANCH],
    fetchSetup: ["fetch", "--quiet", "origin", SETUP_BRANCH],
    setupSubject: ["log", "-1", "--format=%s", `origin/${SETUP_BRANCH}`],
    /**
     * Undo a failed attempt's `add` of one file; the file itself is put back
     * from a snapshot. One file per call: a path the index never had fails
     * the whole pathspec.
     */
    unstage: (file: string): string[] => ["restore", "--quiet", "--staged", "--", file],
    /**
     * Which of the files `.gitignore` (or `info/exclude`, or the global
     * excludes) would keep `git add` from adding, and the rule that does.
     * Exit 0: some are ignored; 1: none is; anything else: unreadable.
     */
    checkIgnore: (files: readonly string[]): string[] => ["check-ignore", "--verbose", "--", ...files],
    /** The local setup branch's tip; exit 1 when there is none. */
    localSetup: ["rev-parse", "--verify", "--quiet", `refs/heads/${SETUP_BRANCH}`],
    /**
     * Delete the local setup branch, only while it is still at `sha`: an
     * attempt removes the branch it made when it made no commit on it.
     */
    dropSetup: (sha: string): string[] => ["update-ref", "-d", `refs/heads/${SETUP_BRANCH}`, sha],
  },
  gh: {
    command: "gh",
    repoList: ["repo", "list", "--limit", "200", "--json", "nameWithOwner,description,isPrivate"],
    clone: (repo: string, target: string): string[] => ["repo", "clone", repo, target],
    repoView: ["repo", "view", "--json", "nameWithOwner"],
    login: ["api", "user", "--jq", ".login"],
    /** The check runs and the commit statuses reported on the base branch's latest commit. */
    checkRuns: (repo: string, base: string): string[] => ["api", `repos/${repo}/commits/${base}/check-runs?per_page=100`],
    commitStatus: (repo: string, base: string): string[] => ["api", `repos/${repo}/commits/${base}/status`],
    /**
     * The open setup PR. Listed without `--head`, which matches the head
     * branch exactly: a setup PR opened by hand from `<owner>/ralph-setup` is
     * still the setup PR, so `isSetupHead` picks it out of the list.
     */
    setupPr: ["pr", "list", "--state", "open", "--json", "number,url,headRefName,state,createdAt", "--limit", "100"],
    /**
     * The base the latest setup PR targeted, merged first, else open: where
     * the config lands when that is not origin's HEAD, which the main checkout
     * (still on its own branch) cannot tell. Without `--head`, as `setupPr`.
     */
    setupBase: ["pr", "list", "--state", "all", "--json", "headRefName,baseRefName,state,mergedAt,createdAt", "--limit", "100"],
    prCreate: (base: string, title: string, body: string): string[] => [
      "pr",
      "create",
      "--base",
      base,
      "--head",
      SETUP_BRANCH,
      "--title",
      title,
      "--body",
      body,
    ],
  },
  projectConfig: { script: "project-config.ts", args: ["--json"], env: "RALPH_PROJECT" },
  /**
   * The Add project dialog's Browse button: a browser page cannot learn a
   * folder's absolute path, so the server opens the host's own dialog, which
   * opens at `start` and prints the folder chosen. Exit 1 is a cancel on both.
   */
  folderPicker: {
    linux: {
      command: "zenity",
      args: (start: string): string[] => ["--file-selection", "--directory", "--title=Choose a project checkout", `--filename=${start}/`],
    },
    darwin: {
      command: "osascript",
      args: (start: string): string[] => [
        "-e",
        `POSIX path of (choose folder with prompt "Choose a project checkout" default location POSIX file ${JSON.stringify(start)})`,
      ],
    },
  },
  /**
   * The Tracker connector's two harness calls (#338). The request, token
   * included, goes on stdin; argv carries no secret.
   */
  tracker: {
    script: "tracker.ts",
    connectTest: ["connect-test"],
    connectSave: (projectId: string): string[] => ["connect-save", "--project", projectId],
  },
} as const;

export interface OnboardingAdapter {
  /** Where GitHub projects are cloned: `<home>/<name>`. */
  readonly home: string;
  /** Absolute directory holding the harness, whose templates setup copies. */
  readonly cliDir: string;
  /**
   * The harness checkout the dashboard and the loops run from (`RALPH_HOME`).
   * It is never registered as a project: setup switches a project's main
   * checkout to its setup branch, which would change the harness under every
   * running loop.
   */
  readonly harness: string;
  git(cwd: string, args: readonly string[]): Promise<ExecResult>;
  gh(cwd: string, args: readonly string[]): Promise<ExecResult>;
  /**
   * What `project-config --json` reports against a checkout root holding a
   * candidate config; none when it is valid. A check that could not run is
   * itself a problem, so a broken harness never passes a config.
   */
  projectConfigProblems(root: string): Promise<string[]>;
  /**
   * `tracker.ts <args>` run from the harness, with `input` on its stdin: the
   * request carries the token, so argv never does.
   */
  tracker(args: readonly string[], input: string): Promise<ExecResult>;
  /** The host's folder dialog opened at `home`, and what the operator did with it. */
  pickFolder(): Promise<FolderPick>;
}

/**
 * The folder dialog's outcome. `none` covers a platform with no dialog and a
 * dialog program that could not be run (`command` set): either way the
 * operator types the path instead.
 */
export type FolderPick =
  | { kind: "picked"; path: string }
  | { kind: "cancelled" }
  | { kind: "none"; command: string | null }
  | { kind: "failed"; command: string; failure: string };

export interface OnboardingAdapterConfig {
  cliDir: string;
  /** The harness checkout; defaults to `cliDir`. */
  harness?: string;
  /** Defaults to `$HOME`. */
  home?: string;
  bunPath?: string;
  env?: Env;
  /** Defaults to `process.platform`; picks the folder dialog. */
  platform?: NodeJS.Platform;
  /** Runs every command; wrapped in `guarded()`, so a throw reads as a null status. */
  exec: Executor;
}

export function createOnboardingAdapter(config: OnboardingAdapterConfig): OnboardingAdapter {
  const cliDir = resolve(config.cliDir);
  const env: Env = { ...process.env, ...config.env };
  const home = resolve(config.home ?? env.HOME ?? "/");
  const bunPath = config.bunPath ?? defaultBunPath();
  const exec = guarded(config.exec);
  const invocation = (command: string, cwd: string, args: readonly string[]): Invocation => ({
    command,
    args: [...args],
    cwd,
    env,
  });
  return {
    home,
    cliDir,
    harness: resolve(config.harness ?? cliDir),
    git: (cwd, args) => exec(invocation(ONBOARDING_SURFACE.git.command, cwd, args)),
    gh: (cwd, args) => exec(invocation(ONBOARDING_SURFACE.gh.command, cwd, args)),
    projectConfigProblems: async (root) =>
      parseConfigProblems(
        await exec({
          command: bunPath,
          args: [join(cliDir, ONBOARDING_SURFACE.projectConfig.script), ...ONBOARDING_SURFACE.projectConfig.args],
          cwd: root,
          env: { ...env, [ONBOARDING_SURFACE.projectConfig.env]: root },
        }),
      ),
    tracker: (args, input) =>
      exec({
        command: bunPath,
        args: [join(cliDir, ONBOARDING_SURFACE.tracker.script), ...args],
        cwd: cliDir,
        env,
        input,
      }),
    pickFolder: async () => {
      const platform = config.platform ?? process.platform;
      const picker = platform === "linux" || platform === "darwin" ? ONBOARDING_SURFACE.folderPicker[platform] : null;
      if (picker === null) return { kind: "none", command: null };
      const picked = await exec(invocation(picker.command, home, picker.args(home)));
      // No status means it never started: the dialog's program is not installed.
      if (picked.status === null) return { kind: "none", command: picker.command };
      if (picked.status === 1) return { kind: "cancelled" };
      if (!succeeded(picked)) return { kind: "failed", command: picker.command, failure: failureOf(picked, picker.command) };
      // zenity ends a directory with `/`; the root itself keeps its one slash.
      const path = firstLine(picked.stdout).replace(/(?<=.)\/+$/, "");
      return path === "" ? { kind: "cancelled" } : { kind: "picked", path };
    },
  };
}

export const succeeded = (result: ExecResult): boolean => result.status === 0;

export const firstLine = (text: string): string => text.trim().split("\n")[0]?.trim() ?? "";

/** Why a command failed, in its own words when it gave any. */
export const failureOf = (result: ExecResult, what: string): string =>
  firstLine(result.stderr) || firstLine(result.stdout) || `${what} exited ${String(result.status)}`;

/**
 * The end of what a failed command printed, for a failure whose first line
 * only names the step: a hook's `bun run typecheck` says why it failed at the
 * bottom. The last `lines` lines of stderr and stdout, at most `chars` long.
 */
export function failureTail(result: ExecResult, what: string, lines = 20, chars = 2_000): string {
  const printed = [result.stderr, result.stdout]
    .join("\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  const tail = printed.slice(-lines).join("\n");
  if (tail === "") return `${what} exited ${String(result.status)}`;
  return tail.length > chars ? `…${tail.slice(-chars)}` : tail;
}

/** Narrow `gh repo list --json nameWithOwner,description,isPrivate`. */
export function parseRepoList(stdout: string): GithubRepoView[] {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    isRecord(entry) && typeof entry.nameWithOwner === "string" && GITHUB_REPO.test(entry.nameWithOwner)
      ? [
          {
            nameWithOwner: entry.nameWithOwner,
            description: typeof entry.description === "string" && entry.description !== "" ? entry.description : null,
            isPrivate: entry.isPrivate === true,
          },
        ]
      : [],
  );
}

/**
 * A setup PR's head: the dashboard's own `ralph-setup`, or one under an owner
 * or user prefix (`felipearosr/ralph-setup`), as a setup pushed by hand names it.
 */
export function isSetupHead(head: unknown): boolean {
  return typeof head === "string" && (head === SETUP_BRANCH || new RegExp(`^[^/]+/${SETUP_BRANCH}$`).test(head));
}

/** The records of a `gh pr list --json` answer whose head is a setup branch, newest first. */
function setupPrsOf(stdout: string): Record<string, unknown>[] {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const prs = value.filter((entry): entry is Record<string, unknown> => isRecord(entry) && isSetupHead(entry.headRefName));
  const createdAt = (pr: Record<string, unknown>): string => (typeof pr.createdAt === "string" ? pr.createdAt : "");
  // A stable sort: entries without a date keep gh's own newest-first order.
  return prs.sort((a, b) => createdAt(b).localeCompare(createdAt(a)));
}

const isMerged = (pr: Record<string, unknown>): boolean =>
  (typeof pr.mergedAt === "string" && pr.mergedAt !== "") || pr.state === "MERGED";
// A PR with no state is read as `--state open` listed it: open.
const isOpen = (pr: Record<string, unknown>): boolean => pr.state === undefined || pr.state === "OPEN";

/**
 * Narrow `gh pr list --json headRefName,baseRefName,...` to the base of the
 * newest merged setup PR, else the newest open one. A closed, unmerged PR's
 * base never received the config.
 */
export function parseSetupBase(stdout: string): string | null {
  const prs = setupPrsOf(stdout);
  const chosen = prs.find(isMerged) ?? prs.find(isOpen);
  return chosen !== undefined && typeof chosen.baseRefName === "string" && chosen.baseRefName !== "" ? chosen.baseRefName : null;
}

/** Narrow `gh pr list --json number,url,headRefName,...` to the newest open setup PR. */
export function parsePrList(stdout: string): { number: number | null; url: string } | null {
  const record = setupPrsOf(stdout).find((pr) => isOpen(pr) && !isMerged(pr) && typeof pr.url === "string");
  if (record === undefined) return null;
  return { number: typeof record.number === "number" ? record.number : null, url: record.url as string };
}

/** The PR URL `gh pr create` prints, on its last line. */
export function parsePrUrl(stdout: string): string | null {
  const lines = stdout.trim().split("\n");
  const url = lines[lines.length - 1]?.trim() ?? "";
  return /^https?:\/\/\S+$/.test(url) ? url : null;
}

/** `owner/name` from an origin URL, over https or ssh. */
export function repoFromRemote(url: string): string | null {
  const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match !== null && GITHUB_REPO.test(match[1]!) ? match[1]! : null;
}

/** `gh repo view --json nameWithOwner`. */
export function parseRepoView(stdout: string): string | null {
  try {
    const value: unknown = JSON.parse(stdout);
    return isRecord(value) && typeof value.nameWithOwner === "string" && GITHUB_REPO.test(value.nameWithOwner)
      ? value.nameWithOwner
      : null;
  } catch {
    return null;
  }
}

/**
 * Every problem `project-config` reported. It exits 1 with
 * `project-config: <path> is invalid:` and one `  - <problem>` line each, or a
 * single line when the file is not JSON at all.
 */
export function parseConfigProblems(result: ExecResult): string[] {
  if (result.status === 0) return [];
  const listed = result.stderr
    .split("\n")
    .filter((line) => line.startsWith("  - "))
    .map((line) => line.slice(4).trim());
  if (listed.length > 0) return listed;
  return [failureOf(result, "project-config").replace(/^project-config:\s*/, "")];
}

/** A path `git check-ignore` says is ignored, and the rule that ignores it. */
export interface IgnoredPath {
  path: string;
  /** The file the rule is in, e.g. `.gitignore`. */
  source: string;
  line: number;
  pattern: string;
}

/**
 * Read `git check-ignore --verbose`: one `<source>:<line>:<pattern>\t<path>`
 * line per matched path. (`-z` would need `--stdin`.) A negated pattern
 * (`!…`) matched means the path is NOT ignored, so it is left out, and so is
 * any line that does not read.
 */
export function parseIgnored(stdout: string): IgnoredPath[] {
  return stdout.split("\n").flatMap((line) => {
    const match = /^(.+?):(\d+):(.*)\t(.+)$/.exec(line);
    if (match === null || match[3]!.startsWith("!")) return [];
    return [{ path: match[4]!, source: match[1]!, line: Number(match[2]), pattern: match[3]! }];
  });
}

/**
 * Checks that report on a commit without gating its merge: dependency and
 * code-scanning bots, Pages deploys, and preview comment bots.
 */
const NOT_A_MERGE_GATE = /dependabot|codeql|pages build and deployment|preview comments/i;

/** Conclusions a check that never ran as a gate ends with. */
const NOT_RUN = new Set(["skipped", "neutral", "stale"]);

/**
 * The checks to require by default: every check run and commit status the
 * base branch's latest commit reported, in that order and once each, less the
 * ones that are clearly not merge gates. Either answer may be missing (null)
 * or unreadable; what the other one lists still counts.
 */
export function requiredChecksFrom(checkRuns: string | null, status: string | null): string[] {
  const parse = (text: string | null): unknown => {
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  const names: string[] = [];
  const runs = parse(checkRuns);
  if (isRecord(runs) && Array.isArray(runs.check_runs)) {
    for (const run of runs.check_runs) {
      if (!isRecord(run) || typeof run.name !== "string") continue;
      if (typeof run.conclusion === "string" && NOT_RUN.has(run.conclusion)) continue;
      const app = isRecord(run.app) && typeof run.app.slug === "string" ? run.app.slug : "";
      if (NOT_A_MERGE_GATE.test(run.name) || NOT_A_MERGE_GATE.test(app)) continue;
      names.push(run.name);
    }
  }
  const combined = parse(status);
  if (isRecord(combined) && Array.isArray(combined.statuses)) {
    for (const entry of combined.statuses) {
      if (isRecord(entry) && typeof entry.context === "string" && !NOT_A_MERGE_GATE.test(entry.context)) names.push(entry.context);
    }
  }
  return [...new Set(names.map((name) => name.trim()).filter((name) => name !== "" && !/[\n\r]/.test(name)))];
}

/** Scripts that make a gate when a project's `package.json` has them. */
const GATE_SCRIPTS = ["test", "typecheck", "lint"] as const;

/**
 * Gates from a `package.json` and the lockfiles beside it: each known check
 * script, run by the package manager the lockfile names.
 */
export function gatesFromPackageJson(text: string | null, lockfiles: readonly string[]): Record<string, string> {
  if (text === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(value) || !isRecord(value.scripts)) return {};
  const runner = lockfiles.some((name) => name === "bun.lock" || name === "bun.lockb")
    ? "bun run"
    : lockfiles.includes("pnpm-lock.yaml")
      ? "pnpm run"
      : lockfiles.includes("yarn.lock")
        ? "yarn run"
        : "npm run";
  const scripts = value.scripts;
  const gates: Record<string, string> = {};
  for (const name of GATE_SCRIPTS) {
    if (typeof scripts[name] === "string") gates[name] = `${runner} ${name}`;
  }
  return gates;
}
