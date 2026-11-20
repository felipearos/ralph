/**
 * The agent side of the runtime adapter: a project's worktrees, the roster on
 * its base branch, and the roster pull requests that change it.
 *
 * A sibling of `lifecycle-adapter.ts`, and for the same reason: this is the
 * only code above the process boundary that names `git worktree add` and
 * `remove`, the plumbing a roster commit is built with, `gh pr create` and
 * `gh pr list`, `project-config`'s roster flags, or where an agent's worktree
 * goes. `agents.ts` above it builds nothing and spawns nothing: it asks for a
 * config, a worktree or a commit step, and the adapter runs the commands on
 * the `Executor` it is given, guarded so no step ever rejects, and narrows
 * what came back.
 *
 * What it changes, it changes narrowly:
 *
 * - `git worktree add` makes a new checkout at a path nothing occupies, and
 *   `git worktree remove` — never `--force` — lets git itself refuse a
 *   worktree with changes in it. The main checkout is never removed.
 * - A roster change is committed without touching any working tree: the
 *   edited config is hashed into the object store, and the commit is built on
 *   `origin/<baseBranch>` in a private index file, then pushed as its own
 *   branch and proposed with `gh pr create`. The one commit that may land on
 *   the base branch itself is a sentinel or verifier rules save (#787), and
 *   only as a fast-forward: its parent is the freshly fetched
 *   `origin/<baseBranch>`, and nothing is force-pushed, so a base that moved
 *   meanwhile refuses the push rather than losing a commit.
 * - A new worktree gets its `.ralph/loop-name`. That, the private index and
 *   the staged config text are the only files written.
 *
 * The roster rules are `project-config`'s, reached by CLI: this module never
 * edits the config's JSON itself, and judges a loop name only by
 * `LOOP_NAME_SHAPE`, so a name is safe as a path segment before it is one.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ADAPTER_ENV, COMMAND_SURFACE, configCheckout, defaultBunPath, isRecord, narrowRoster, narrowSnapshot } from "./adapter";
import { SENTINEL_ISSUE_STATES, SENTINEL_MODES, VERIFIER_MODES } from "./contracts";
import type {
  ConfigChanges,
  Env,
  Liveness,
  LoopRole,
  ProjectEdit,
  RosterLoop,
  RosterPrState,
  RosterPrView,
  SentinelIssueRow,
  SentinelIssuesView,
  SentinelIssueState,
  SentinelMode,
  SentinelRules,
  SentinelRulesView,
  VerifierMode,
  VerifierRules,
  VerifierRulesView,
  WorktreeSetupRecord,
  WorktreeSetupStepConfig,
  WorktreeSetupStepState,
  WorktreeSetupStepView,
} from "./contracts";
import { guarded, type ExecResult, type Executor, type Invocation } from "./control-adapter";
import { createGateRunner, type GateRunView } from "./gate-run";

export { samePath } from "./lifecycle-adapter";

/**
 * `gh label list`'s limit: `preflight.ts`'s own `LABEL_LIMIT`, restated
 * because the seam forbids importing it. The Labels page warns when a read
 * comes back this full, since a label past it would read as missing.
 */
export const LABEL_LIST_LIMIT = 200;

/** The agent command surface — a closed list, asserted by a test. */
export const AGENT_SURFACE = {
  config: {
    script: "project-config.ts",
    json: "--json",
    at: "--at",
    add: "--add-loop",
    remove: "--remove-loop",
    role: "--role",
    setVerifier: "--set-verifier",
    setSentinel: "--set-sentinel",
    setProject: "--set-project",
  },
  git: {
    command: "git",
    fetch: ["fetch", "--quiet", "origin"],
    worktreeList: ["worktree", "list", "--porcelain"],
    worktreeAdd: ["worktree", "add"],
    worktreeRemove: ["worktree", "remove"],
    readTree: ["read-tree"],
    hashObject: ["hash-object", "-w", "--"],
    updateIndex: ["update-index", "--add", "--cacheinfo"],
    writeTree: ["write-tree"],
    commitTree: ["commit-tree"],
    // The roster commit is built in a private index, so a pre-push hook would
    // gate whatever the main checkout has checked out instead of this commit,
    // and a project's full-suite hook outlives the executor's timeout. The PR's
    // own CI checks the commit.
    push: ["push", "--no-verify", "origin"],
    // Given the full `refs/heads/<branch>`, not the bare name: a bare pattern
    // tail-matches, so `dev` would also answer for `refs/heads/felipe/dev`.
    remoteBranch: ["ls-remote", "--exit-code", "--heads", "origin"],
    status: ["status", "--porcelain"],
    isAncestor: ["merge-base", "--is-ancestor", "HEAD"],
    /**
     * The worktree readiness item compares HEAD and the base ref EXACTLY, with
     * two of these, because `isAncestor` above exits 0 for "behind or equal":
     * a worktree left on a stale commit after the roster PR merged — the
     * second thing missed when `testo` failed to start — would read as a pass.
     */
    revParse: ["rev-parse"],
    advance: ["checkout", "--detach", "--quiet"],
  },
  gh: {
    command: "gh",
    prCreate: ["pr", "create"],
    prList: ["pr", "list", "--state", "all", "--limit", "1", "--json", "url,state,headRefName"],
    // Every verifier rules PR has a branch of its own, so the open one is
    // found by its head's prefix among the open PRs, not by one exact name.
    openPrList: ["pr", "list", "--state", "open", "--limit", "100", "--json", "url,state,headRefName"],
    // Below the real count, Add agent would read an existing label as
    // missing and report it as uncreatable (see `LABEL_LIST_LIMIT`).
    // Colour and description are for the Labels page; Add agent reads names.
    labelList: ["label", "list", "--limit", String(LABEL_LIST_LIMIT), "--json", "name,color,description"],
    labelCreate: ["label", "create"],
    // The check names a repo has reported, for Settings to offer when the
    // operator edits `requiredChecks`: a name nothing reports would block
    // every hand-off. The base branch alone misses PR-only checks, so the
    // heads of the newest PRs, in any state, are asked too.
    recentPrHeads: ["pr", "list", "--state", "all", "--limit", "5", "--json", "headRefOid"],
    // `gh api` with no `--method` or field flags is a GET: a read, like the rest.
    api: ["api"],
  },
  /**
   * `preflight.ts --labels` is the one place that knows which labels a role
   * needs. Add-agent asks it rather than deriving the set, so a role whose
   * vocabulary grows does not leave new agents half-labelled.
   */
  preflight: {
    script: "preflight.ts",
    labels: "--labels",
    loop: "--loop",
    role: "--role",
    /**
     * `{ verdict, checks }` for one agent's worktree — the last readiness item,
     * and the only one the card asks for on its own. It runs `gh auth status`,
     * a `gh label list` of its own and `doppler secrets`, so it is never on the
     * five-second `GET /api/agents` poll.
     */
    json: "--json",
  },
  /**
   * Which lineup a new loop resolves: `stages.<stage>.source` is `'loop'` when
   * `models.json` holds a block for it, and names the block it falls back to
   * otherwise. A read-only JSON projection, like the lineup editor's.
   */
  models: {
    script: "models.ts",
    json: "--json",
    role: "--role",
    render: "--render-prompt",
  },
  /**
   * The sentinel's issue store as its panel draws it: a read, with no lock and
   * no write, run against the checkout holding the config like `--json`.
   */
  sentinel: {
    script: join("sentinel", "issues.ts"),
    json: "--json",
  },
  /** Jav's own projection of one project's block: `enabled` and `routes`. */
  jav: {
    script: "jav.ts",
    json: "--json",
  },
  /** Step 9 of the guide, checked by its presence in the agent's worktree. */
  nodeModules: "node_modules",
  /**
   * The guide itself, in the harness checkout beside the CLI: the dashboard
   * serves this file's bytes rather than a copy of its steps.
   */
  guide: "adding-an-agent.md",
  /** The same read-only liveness read restart and Resume work refuse over. */
  supervisors: COMMAND_SURFACE.loopState,
  loopName: ".ralph/loop-name",
  /**
   * The loop writes its iteration log, supervisor log and usage ledger here,
   * and `preflight`'s `logs-writable` check DENIES a start when the directory
   * is absent. Not every project tracks a file inside it — `felipearos/ralph`
   * itself does not — so a worktree git has just created may not have one, and
   * provisioning creates it rather than leaving the first start to be refused.
   */
  logsDir: ".ralph/logs",
  /**
   * The last worktree setup's record (#694), under `logsDir`: the worktree's
   * own, untracked, and beside the loop's other logs, so it survives the
   * dashboard and an operator can read why a setup stopped.
   */
  worktreeSetupRecord: ".ralph/logs/worktree-setup.json",
  configPath: ".ralph/config.json",
  /**
   * Where the agents live, under the XDG data directory
   * (`$XDG_DATA_HOME`, else `~/.local/share`): `<workspaces>/<project>/<name>-loop`.
   * Ralph's own data directory, not a workspace manager's: a manager that
   * scans its folder lists every agent as a task of its own, and its cleanup
   * offers to delete checkouts a live supervisor is running in.
   */
  workspaces: ["ralph", "workspaces"],
  worktreeSuffix: "-loop",
  /** A roster PR's branch: `ralph-roster/add-<name>` or `ralph-roster/remove-<name>`. */
  branchPrefix: "ralph-roster",
} as const;

export type RosterEdit = "add" | "remove";

/**
 * A project settings edit as `project-config --set-project` reads it: the
 * gates in the config's own name→command form. The page sends them as an
 * ordered list (`ProjectEdit`) so a repeated name can be refused first.
 * The setup steps go in the config's compact form, a default left out.
 */
export type ProjectConfigEdit = Omit<ProjectEdit, "gates" | "worktreeSetup"> & {
  gates?: Record<string, string>;
  worktreeSetup?: WorktreeSetupStepEdit[];
};

/** One setup step as the config spells it: `timeoutSeconds` and `installsDependencies` only when not their defaults. */
export interface WorktreeSetupStepEdit {
  name: string;
  command: string;
  timeoutSeconds?: number;
  installsDependencies?: boolean;
}

/** The project config fields the agent paths need, narrowed from `project-config --json`. */
export interface AgentProjectConfig {
  repo: string;
  /** The config's `owner`, or null when it spells none. */
  owner: string | null;
  baseBranch: string;
  /** The config's `displayName`, or null when it spells none. */
  displayName: string | null;
  loops: string[];
  /**
   * The same loops with their roles resolved, as `project-config` spells them
   * out: `loops` alone cannot say what a name's role is, and a loop given its
   * checkout from the roster needs the labels ITS role declares, not a
   * coder's.
   *
   * `null` when the roster could not be narrowed — a role this side of the
   * seam does not know, which `contracts.ts` expects to drift. Nullable rather
   * than required because exactly one caller reads it: making it a condition
   * of the config read would stop an operator deleting a worktree or
   * unregistering a project over a role neither of those paths looks at.
   */
  roster: RosterLoop[] | null;
  /**
   * Why the roster could not be narrowed: non-null exactly when `roster` is.
   * Carried rather than discarded because it is the only artefact naming the
   * JSON path and the offending value, and the five things `narrowRoster`
   * refuses are not one diagnosis a caller could restate for itself.
   */
  rosterWhy: string | null;
  /**
   * The rule keys the raw `verifier` block spells, or null when it has none.
   * Never a reason to fail the read, for the same reason as `roster`: only the
   * verifier settings read it.
   */
  verifier: VerifierRulesView | null;
  /** The rule keys the raw `sentinel` block spells, or null when it has none; never a reason to fail the read, as for `verifier`. */
  sentinel: SentinelRulesView | null;
  /**
   * How a sentinel or verifier rules save lands (#787): `pr` only when the
   * config spells it, `commit` otherwise — the default, and what an absent
   * key means. Never a reason to fail the read, as for `verifier`.
   */
  configChanges: ConfigChanges;
  /**
   * The prompt fragments the raw config names — `promptFragment`,
   * `coderFragment` and `plan` — as the relative paths it spells, each null
   * when it spells none or a non-string. Never a reason to fail the read, as
   * for `verifier`: only the Settings page's Prompts section reads them.
   */
  fragments: { prompt: string | null; coder: string | null; plan: string | null };
  /**
   * The config's `gates` as name and command, in the config's key order — the
   * order the harness exports them in. Empty when it spells none or spells
   * them malformed: only the Settings page reads them, so they are never a
   * reason to fail the read every agent path makes.
   */
  gates: { name: string; command: string }[];
  /** The config's `requiredChecks`, in order; empty when missing or malformed, as for `gates`. */
  requiredChecks: string[];
  /** The config's `refuseFiles`, in order; empty when missing or malformed, as for `gates`. */
  refuseFiles: string[];
  /**
   * The config's `worktreeSetup` steps, in order, defaults filled; empty when
   * missing or malformed, as for `gates`: only a new checkout's setup reads
   * them, never every agent path.
   */
  worktreeSetup: WorktreeSetupStepConfig[];
}

/**
 * `problems` is set only by a read that can name more than one reason — a
 * config that failed validation — so the Settings page can list them all,
 * where `why` keeps the one line every other caller already quotes.
 */
export type Read<T> = { ok: true; value: T } | { ok: false; why: string; problems?: string[] };

/** Every worktree's supervisor liveness, and the worktrees reconciliation lists. */
export interface CheckoutsSnapshot {
  /**
   * `owner` is the loop the worktree's loop record names, which the dashboard
   * attributes a worktree by before its `loop-name` (`identify` in adapter.ts);
   * `recorded` is whether it holds a record at all, the Reconciliation page's
   * test for listing an unattributed one.
   */
  loops: { worktree: string; liveness: Liveness; owner: string | null; recorded: boolean }[];
  orphaned: string[];
  prunable: string[];
}

/** A project file's text, or why not; `missing` tells an absent file from an unreadable one. */
export type FileRead = { ok: true; value: string } | { ok: false; missing: boolean; why: string };

/** A step that changes something and answers nothing but whether it worked. */
export type Step = { ok: true } | { ok: false; why: string };

/** One worktree of the project, as `git worktree list --porcelain` names it. */
export interface WorktreeEntry {
  path: string;
  /** The checked-out branch's short name; null when detached. */
  branch: string | null;
  /** The first entry is the repo's main checkout, which is never removed. */
  main: boolean;
}

/** A private index and a staged file, for building one commit off to the side. */
export interface StagedCommit {
  index: string;
  file: string;
  dispose(): void;
}

/** What a roster or verifier PR is opened with. */
export interface PrRequest {
  repo: string;
  base: string;
  branch: string;
  title: string;
  body: string;
}

export interface AgentsAdapter {
  /** The project's main checkout. */
  readonly root: string;
  readonly project: string;
  /** Where the agent named `name` gets its worktree. */
  worktreeFor(name: string): string;
  branchFor(edit: RosterEdit, name: string): string;
  /** `project-config --json` against `at` (default: the checkout holding the config, see `configCheckout`), optionally at a git ref. */
  readConfig(options?: { at?: string; ref?: string }): Promise<Read<AgentProjectConfig>>;
  /**
   * The config file at `ref` with `name` added to or removed from `loops`,
   * validated. An added loop's `role` is passed through, so `project-config`
   * writes a coder as a bare name and any other role as an object — the
   * dashboard never decides that spelling itself.
   */
  editRoster(edit: RosterEdit, name: string, ref: string, role?: LoopRole): Promise<Read<string>>;
  /** The config file at `ref` with the `verifier` block's rules replaced by `rules`, validated. */
  editVerifier(rules: VerifierRules, ref: string): Promise<Read<string>>;
  /**
   * A new verifier rules PR's branch, unique per proposal (`stamp` is the
   * time it was made). One fixed name would be refused by the push for good
   * once a merged PR's head branch was left on origin, and the dashboard may
   * not delete or force-push a branch.
   */
  verifierBranch(stamp: string): string;
  /** The open verifier rules PR among the repository's open PRs, or null when there is none. */
  verifierPr(repo: string): Promise<Read<RosterPrView | null>>;
  /** The config file at `ref` with the `sentinel` block's rules replaced by `rules`, validated. */
  editSentinel(rules: SentinelRules, ref: string): Promise<Read<string>>;
  /** A new sentinel rules PR's branch, unique per proposal, for the same reason as `verifierBranch`. */
  sentinelBranch(stamp: string): string;
  /** The open sentinel rules PR among the repository's open PRs, or null when there is none. */
  sentinelPr(repo: string): Promise<Read<RosterPrView | null>>;
  /**
   * `sentinel/issues.ts --json`, narrowed. A failed read is unknown, never
   * "the sentinel saw nothing": a missing store is an empty view, not a failure.
   */
  sentinelIssues(): Promise<Read<SentinelIssuesView>>;
  /** The config file at `ref` with `displayName` and/or `baseBranch` set to `values`, validated. */
  editProject(values: ProjectConfigEdit, ref: string): Promise<Read<string>>;
  /**
   * A project settings PR's branch: `key` names the change itself (a hash of
   * the edited values), so the same Save finds its own open PR again, and
   * `stamp` keeps it unique per proposal, for the same reason as
   * `verifierBranch`.
   */
  projectBranch(key: string, stamp: string): string;
  /** The open project settings PR for the change `key` names, or null when there is none. */
  projectPr(repo: string, key: string): Promise<Read<RosterPrView | null>>;
  /** `git fetch` of the base branch; the bare reason on failure, for the caller to prefix. */
  fetch(baseBranch: string, cwd?: string): Promise<Step>;
  listWorktrees(): Promise<Read<WorktreeEntry[]>>;
  /** The labels a loop in `role` needs: its own triple, plus its role's vocabulary. */
  labels(name: string, role: LoopRole): Promise<Read<string[]>>;
  /** The project's existing labels, with each one's colour and description. */
  listLabels(repo: string): Promise<Read<RepoLabel[]>>;
  createLabel(repo: string, label: string): Promise<Step>;
  /** The liveness of every worktree's supervisor, as `loop-state` reads it for the project. */
  supervisors(): Promise<Read<{ worktree: string; liveness: Liveness }[]>>;
  /**
   * The same `loop-state` read as `supervisors`, keeping the reconciliation
   * lists too: the Settings page must call a worktree unowned exactly when the
   * Reconciliation page lists it, so both read one snapshot.
   */
  checkouts(): Promise<Read<CheckoutsSnapshot>>;
  readLoopName(worktree: string): string | null;
  /**
   * Make a fresh worktree into a loop's checkout: its `loop-name`, and the log
   * directory a start is refused without. Both paths that create a worktree go
   * through this one function, which is what keeps a checkout made from the
   * roster identical to one Add agent makes.
   */
  provisionWorktree(worktree: string, name: string): void;
  addWorktree(path: string, ref: string): Promise<Step>;
  removeWorktree(path: string): Promise<Step>;
  /** Stage config text for a commit built in a private index. */
  stage(text: string): StagedCommit;
  /** The plumbing a staged commit is built with; each answers its trimmed stdout. */
  readTree(staged: StagedCommit, ref: string): Promise<Read<string>>;
  hashObject(staged: StagedCommit): Promise<Read<string>>;
  updateIndex(staged: StagedCommit, blob: string): Promise<Read<string>>;
  writeTree(staged: StagedCommit): Promise<Read<string>>;
  commitTree(staged: StagedCommit, tree: string, parent: string, message: string): Promise<Read<string>>;
  push(commit: string, branch: string): Promise<Read<string>>;
  /** `gh pr create`'s trimmed stdout; the caller finds the URL in it. */
  createPr(pr: PrRequest): Promise<Read<string>>;
  /** True when `origin` already has `branch`, false when it does not; a failure when that cannot be told. */
  remoteBranch(branch: string): Promise<Read<boolean>>;
  /**
   * The distinct check-run names and commit-status contexts `repo` reported
   * on `ref` and on the heads of its five newest PRs (gh's default order),
   * sorted. Any one read failing fails the whole: a partial list would read as
   * "these are all the names", which is the claim the caller warns on. Each
   * commit is read one page of 100 deep; a commit with more checks than that
   * can only cost a false warning, never a refusal.
   */
  reportedChecks(repo: string, ref: string): Promise<Read<string[]>>;
  /** The newest PR, in any state, from `branch`. */
  findPr(repo: string, branch: string): Promise<Read<RosterPrView | null>>;
  /** The worktree's own checkout: its trimmed porcelain status, "" when clean. */
  status(worktree: string): Promise<Read<string>>;
  /** Whether the worktree's HEAD is behind or at `ref`; anything but a clean yes is false. */
  isAncestor(worktree: string, ref: string): Promise<boolean>;
  advance(worktree: string, ref: string): Promise<Step>;
  /** One revision resolved inside `worktree`: `HEAD`, or `origin/<baseBranch>`. */
  revParse(worktree: string, rev: string): Promise<Read<string>>;
  /** `preflight.ts --json` in the agent's own worktree, under its loop name. */
  preflight(worktree: string, name: string): Promise<Read<PreflightVerdict>>;
  /** The lineup `name` would resolve in `role`, so the card can name its fallback. */
  models(name: string, role: LoopRole): Promise<Read<LineupSource>>;
  /** Jav's block for this project: whether it is on, and what is routed. */
  jav(): Promise<Read<JavRoutes>>;
  /** Step 9: are the worktree's dependencies installed? */
  hasNodeModules(worktree: string): boolean;
  /** The guide's own bytes, out of the harness checkout. */
  readGuide(): Read<string>;
  /**
   * One file of the checkout holding the config, by a path relative to it —
   * a fragment the config names. `missing` is set exactly when the file does
   * not exist, so the Prompts section can say "missing" rather than "empty".
   * An absolute path or one escaping the checkout is refused: the path comes
   * from a config file, and the dashboard reads nothing outside the checkout.
   */
  readProjectFile(path: string): FileRead;
  /**
   * `models.ts --render-prompt --role <role>` as `loop` would see it, against
   * the checkout holding the config: the prompt the harness itself renders,
   * so the Prompts section shows what a session receives, not a re-creation.
   */
  renderPrompt(role: LoopRole, loop: string): Promise<Read<string>>;
  /** The directory this project's agent worktrees go under. */
  worktreesDir(): string;
  /** Where the worktrees go without a folder of the project's own: `<workspaces>/<project>`. */
  defaultWorktreesDir(): string;
  /** Whether the project's registry entry names its own worktrees folder. */
  worktreesDirSet(): boolean;
  /**
   * Run the project's `worktreeSetup` steps in `worktree`, in order, so a new
   * checkout is ready to start (dependencies installed, env files copied from
   * the main checkout, named by `RALPH_MAIN_CHECKOUT`). The first step that
   * does not pass stops the rest, recorded `skipped`: a later step most often
   * needs what the earlier one made, and running it would bury the real
   * failure under its own.
   *
   * Each step goes through `gate-run.ts`, so its limit kills the whole process
   * group and its output is a bounded tail. The record is written to
   * `worktreeSetupRecord` (atomically) before the first step, with no steps,
   * and after every step, so a rerun in progress never shows the last run's
   * pass and a dashboard killed mid-setup leaves what finished; a write that
   * fails does not throw, since the returned record is the answer and the
   * file only its copy. No steps write nothing: there is no setup to record.
   *
   * One setup per worktree at a time: a second call while one runs, or a call
   * for a directory that does not exist, runs and writes nothing and answers
   * a record whose first step `failed` with the reason.
   */
  runWorktreeSetup(worktree: string, steps: readonly WorktreeSetupStepConfig[]): Promise<WorktreeSetupRecord>;
  /** The worktree's last setup record, or null when it has none or it cannot be read as one. */
  readWorktreeSetup(worktree: string): WorktreeSetupRecord | null;
  /** Whether a `runWorktreeSetup` is in flight in this worktree, from this dashboard process. */
  setupRunning(worktree: string): boolean;
  /** Whether `path` exists as a directory. */
  worktreeExists(path: string): boolean;
}

export interface AgentsAdapterConfig {
  /** Absolute directory holding the ralph CLI scripts. */
  cliDir: string;
  /** The project's main checkout. */
  root: string;
  /** The project's registry id: the directory its agents' worktrees go under. */
  project: string;
  /** The directory holding every project's agent worktrees; `AGENT_SURFACE.workspaces` under the XDG data directory by default. */
  workspaces?: string;
  /**
   * The project's own folder for agent worktrees, from the project registry;
   * when set it replaces `<workspaces>/<project>`.
   */
  worktreesDir?: string;
  bunPath?: string;
  env?: Env;
  /** Runs every command; wrapped in `guarded` so a throw is a failed step, never a rejection. */
  exec: Executor;
}

const firstLine = (text: string): string => text.trim().split("\n")[0]?.trim() ?? "";

const failure = (result: ExecResult, what: string): string =>
  firstLine(result.stderr) || firstLine(result.stdout) || `${what} exited ${String(result.status)}`;

// A null status is a step that never exited on its own: killed (most often at
// the executor's timeout) or never started. Its first output line is then
// whatever it printed before, not why it stopped.
const why = (result: ExecResult, what: string): string =>
  result.status === null
    ? `${what} did not exit (killed, timed out or never started)`
    : failure(result, what);

/**
 * Why `git push` was refused, in a few words. Its first stderr line is no
 * reason — it is `To <remote>` — and the operator is shown this when a rules
 * save falls back to a PR, so the line that says why is looked for: GitHub's
 * protected-branch refusal, or the `! [rejected]` / `! [remote rejected]`
 * line's parenthesised reason (`fetch first`, `non-fast-forward`,
 * `pre-receive hook declined`). Null when no such line is there.
 */
export function pushRefusal(stderr: string): string | null {
  const lines = stderr.split("\n").map((line) => line.trim());
  if (lines.some((line) => /GH006|protected branch/i.test(line))) return "the branch is protected";
  for (const line of lines) {
    const rejected = /^! \[(?:remote )?rejected\].*\((.+)\)\s*$/.exec(line);
    if (rejected === null) continue;
    const reason = rejected[1]!;
    return /fetch first|non-fast-forward/.test(reason) ? `${reason}: the branch moved since it was fetched` : reason;
  }
  return null;
}

const isCount = (field: unknown): field is number => typeof field === "number" && Number.isFinite(field);

/**
 * Copy the seven rule keys out of a raw `verifier` block, each only when it has
 * the right JSON type. Whether a value is a good rule is `project-config`'s
 * call; this only keeps the form from rendering a string as a number.
 */
export function narrowVerifierRules(block: unknown): VerifierRulesView | null {
  if (!isRecord(block)) return null;
  const rules: VerifierRulesView = {};
  if (typeof block.enabled === "boolean") rules.enabled = block.enabled;
  if (isCount(block.windowHours)) rules.windowHours = block.windowHours;
  if (Array.isArray(block.checkIns) && block.checkIns.every(isCount)) rules.checkIns = [...(block.checkIns as number[])];
  if (typeof block.trafficFloor === "boolean") rules.trafficFloor = block.trafficFloor;
  if (isRecord(block.revert)) {
    const revert: NonNullable<VerifierRulesView["revert"]> = {};
    if (isCount(block.revert.rateFactor)) revert.rateFactor = block.revert.rateFactor;
    if (isCount(block.revert.minEvents)) revert.minEvents = block.revert.minEvents;
    if (isCount(block.revert.minUsers)) revert.minUsers = block.revert.minUsers;
    rules.revert = revert;
  }
  if (isRecord(block.follow)) {
    const follow: NonNullable<VerifierRulesView["follow"]> = {};
    if (typeof block.follow.loopPrs === "boolean") follow.loopPrs = block.follow.loopPrs;
    if (typeof block.follow.humanPrs === "boolean") follow.humanPrs = block.follow.humanPrs;
    rules.follow = follow;
  }
  if (typeof block.mode === "string" && (VERIFIER_MODES as readonly string[]).includes(block.mode)) rules.mode = block.mode as VerifierMode;
  return rules;
}

/**
 * Copy the six rule keys out of a raw `sentinel` block, each only when it has
 * the right JSON type, as `narrowVerifierRules` does. The reporter and
 * language are not rules the form edits, so they are left behind.
 */
export function narrowSentinelRules(block: unknown): SentinelRulesView | null {
  if (!isRecord(block)) return null;
  const rules: SentinelRulesView = {};
  if (typeof block.enabled === "boolean") rules.enabled = block.enabled;
  if (isCount(block.lookbackHours)) rules.lookbackHours = block.lookbackHours;
  if (isCount(block.minEvents)) rules.minEvents = block.minEvents;
  if (isCount(block.minUsers)) rules.minUsers = block.minUsers;
  if (isCount(block.maxPerDay)) rules.maxPerDay = block.maxPerDay;
  if (typeof block.mode === "string" && (SENTINEL_MODES as readonly string[]).includes(block.mode)) rules.mode = block.mode as SentinelMode;
  return rules;
}

const PROBLEM_PREFIX = "  - ";

const optionalText = (field: unknown): string | null => (typeof field === "string" ? field : null);

/** `gates` as an ordered list, dropping any command that is not a string. */
const narrowGates = (field: unknown): { name: string; command: string }[] =>
  isRecord(field)
    ? Object.entries(field).flatMap(([name, command]) => (typeof command === "string" ? [{ name, command }] : []))
    : [];

/** `project-config`'s defaults for a step that spells no limit or install flag (`resolveWorktreeSetup`). */
export const SETUP_DEFAULT_TIMEOUT_SECONDS = 120;

/**
 * `worktreeSetup` as an ordered list, dropping any entry without a string name
 * and command and filling a missing or mistyped limit or flag with its default.
 */
const narrowWorktreeSetup = (field: unknown): WorktreeSetupStepConfig[] =>
  Array.isArray(field)
    ? field.flatMap((step) =>
        isRecord(step) && typeof step.name === "string" && typeof step.command === "string"
          ? [
              {
                name: step.name,
                command: step.command,
                timeoutSeconds:
                  isCount(step.timeoutSeconds) && step.timeoutSeconds > 0 ? step.timeoutSeconds : SETUP_DEFAULT_TIMEOUT_SECONDS,
                installsDependencies: typeof step.installsDependencies === "boolean" ? step.installsDependencies : false,
              },
            ]
          : [],
      )
    : [];

const SETUP_STATES: readonly WorktreeSetupStepState[] = ["passed", "failed", "timeout", "skipped"];

const nullableCount = (field: unknown): field is number | null => field === null || isCount(field);

/** A record read back from a worktree, or null when any part of it is not one. */
const narrowSetupRecord = (value: unknown): WorktreeSetupRecord | null => {
  if (!isRecord(value) || typeof value.ranAt !== "string" || !Array.isArray(value.steps)) return null;
  const steps: WorktreeSetupStepView[] = [];
  for (const step of value.steps) {
    if (
      !isRecord(step) ||
      typeof step.name !== "string" ||
      typeof step.command !== "string" ||
      typeof step.state !== "string" ||
      !(SETUP_STATES as readonly string[]).includes(step.state) ||
      !nullableCount(step.durationMs) ||
      !nullableCount(step.exitCode) ||
      typeof step.output !== "string" ||
      typeof step.truncated !== "boolean" ||
      !isCount(step.limitMs) ||
      !(step.error === null || typeof step.error === "string")
    ) {
      return null;
    }
    steps.push({
      name: step.name,
      command: step.command,
      state: step.state as WorktreeSetupStepState,
      durationMs: step.durationMs,
      exitCode: step.exitCode,
      output: step.output,
      truncated: step.truncated,
      limitMs: step.limitMs,
      error: step.error,
    });
  }
  return { ranAt: value.ranAt, steps };
};

/**
 * The resolved worktree paths with a setup in flight. Module-level, not per
 * adapter: the server builds a fresh adapter per request (`compose.ts`), and
 * two requests running one worktree's setup at once would race its install
 * and its record.
 */
const setupsInFlight = new Set<string>();

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** A setup that ran nothing: the first step `failed` with why, the rest `skipped`. */
const refusedSetup = (steps: readonly WorktreeSetupStepConfig[], why: string): WorktreeSetupRecord => ({
  ranAt: new Date().toISOString(),
  steps: steps.map((step, index) => ({
    name: step.name,
    command: step.command,
    state: index === 0 ? "failed" : "skipped",
    durationMs: null,
    exitCode: null,
    output: "",
    truncated: false,
    limitMs: step.timeoutSeconds * 1000,
    error: index === 0 ? why : null,
  })),
});

/** A settled gate run as a setup step; a gate run never settles `running`, but a stray one is no pass. */
const setupStepFromRun = (run: GateRunView): WorktreeSetupStepView => ({
  name: run.gate,
  command: run.command,
  state: run.state === "running" ? "failed" : run.state,
  durationMs: run.durationMs,
  exitCode: run.exitCode,
  output: run.output,
  truncated: run.truncated,
  limitMs: run.limitMs,
  error: run.error,
});

/** A list of strings (`requiredChecks`, `refuseFiles`), dropping any entry that is not one. */
const narrowStrings = (field: unknown): string[] =>
  Array.isArray(field) ? field.filter((name): name is string => typeof name === "string") : [];

// The caller warns with this line alone, so it names the read that failed:
// gh's own stderr ("HTTP 404") does not say which commit it was about. A null
// status already names it.
const namedWhy = (result: ExecResult, what: string): string =>
  result.status === null ? why(result, what) : `${what}: ${failure(result, what)}`;

/** The `headRefOid`s of a `gh pr list --json headRefOid`, or why there are none. */
const parsePrHeads = (result: ExecResult, what: string): Read<string[]> => {
  if (result.status !== 0) return { ok: false, why: namedWhy(result, what) };
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return { ok: false, why: `${what} did not return JSON` };
  }
  if (!Array.isArray(value)) return { ok: false, why: `${what} did not return a list` };
  return { ok: true, value: value.flatMap((pr) => (isRecord(pr) && typeof pr.headRefOid === "string" ? [pr.headRefOid] : [])) };
};

/** The string `field` of every record in `body[list]`: check-run names or status contexts. */
const parseNames = (result: ExecResult, what: string, list: string, field: string): Read<string[]> => {
  if (result.status !== 0) return { ok: false, why: namedWhy(result, what) };
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return { ok: false, why: `${what} did not return JSON` };
  }
  const entries = isRecord(value) ? value[list] : undefined;
  if (!Array.isArray(entries)) return { ok: false, why: `${what} returned no ${list}` };
  return { ok: true, value: entries.flatMap((entry) => (isRecord(entry) && typeof entry[field] === "string" ? [entry[field]] : [])) };
};

/** Narrow `project-config --json` to what the agent paths need. */
export function parseAgentConfig(result: ExecResult): Read<AgentProjectConfig> {
  if (result.status !== 0) {
    // `project-config` lists every validation problem as a `  - ` line under
    // its first (`parseProjectConfig` in project-config.ts); `why` keeps that
    // first line, `problems` keeps the list.
    const problems = result.stderr
      .split("\n")
      .filter((line) => line.startsWith(PROBLEM_PREFIX))
      .map((line) => line.slice(PROBLEM_PREFIX.length));
    const why = failure(result, "project-config");
    return problems.length > 0 ? { ok: false, why, problems } : { ok: false, why };
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return { ok: false, why: "project-config did not return JSON" };
  }
  if (
    !isRecord(value) ||
    typeof value.repo !== "string" ||
    typeof value.baseBranch !== "string" ||
    !Array.isArray(value.loops) ||
    !value.loops.every((loop) => typeof loop === "string")
  ) {
    return { ok: false, why: "project-config returned no repo, baseBranch or loops" };
  }
  // The roster is narrowed by the same function the snapshot read uses, so an
  // unknown role is drift here too — but drift in a field one caller reads is
  // no reason to fail the read every agent path makes. It throws; this never
  // does, and the one consumer refuses on `null`, quoting `rosterWhy`.
  let roster: RosterLoop[] | null = null;
  let rosterWhy: string | null = null;
  try {
    roster = narrowRoster(value);
  } catch (error) {
    rosterWhy = error instanceof Error ? error.message : String(error);
  }
  return {
    ok: true,
    value: {
      repo: value.repo,
      owner: optionalText(value.owner),
      baseBranch: value.baseBranch,
      displayName: optionalText(value.displayName),
      loops: value.loops as string[],
      roster,
      rosterWhy,
      verifier: narrowVerifierRules(value.verifier),
      sentinel: narrowSentinelRules(value.sentinel),
      configChanges: value.configChanges === "pr" ? "pr" : "commit",
      fragments: {
        prompt: optionalText(value.promptFragment),
        coder: optionalText(value.coderFragment),
        plan: optionalText(value.plan),
      },
      gates: narrowGates(value.gates),
      requiredChecks: narrowStrings(value.requiredChecks),
      refuseFiles: narrowStrings(value.refuseFiles),
      worktreeSetup: narrowWorktreeSetup(value.worktreeSetup),
    },
  };
}

/** Narrow `git worktree list --porcelain` to its paths and branches, main checkout first. */
export function parseWorktreeList(result: ExecResult): Read<WorktreeEntry[]> {
  if (result.status !== 0) return { ok: false, why: failure(result, "git worktree list") };
  const entries: WorktreeEntry[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      entries.push({ path: line.slice("worktree ".length), branch: null, main: entries.length === 0 });
    } else if (line.startsWith("branch ") && entries.length > 0) {
      // Blocks are blank-line separated and each opens with `worktree`, so a
      // `branch` line belongs to the last one opened. A detached head prints
      // `detached` instead and keeps null.
      const ref = line.slice("branch ".length);
      entries[entries.length - 1]!.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    }
  }
  return { ok: true, value: entries };
}

const PR_STATES: Record<string, RosterPrState> = { OPEN: "open", MERGED: "merged", CLOSED: "closed" };

/** Narrow `gh pr list --json url,state,headRefName` to its first PR. */
export function parsePrList(result: ExecResult): Read<RosterPrView | null> {
  const listed = parsePrs(result);
  return listed.ok ? { ok: true, value: listed.value[0] ?? null } : listed;
}

/** Every PR `gh pr list --json url,state,headRefName` printed; one it cannot read fails the read. */
function parsePrs(result: ExecResult): Read<RosterPrView[]> {
  if (result.status !== 0) return { ok: false, why: failure(result, "gh pr list") };
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return { ok: false, why: "gh pr list did not return JSON" };
  }
  if (!Array.isArray(value)) return { ok: false, why: "gh pr list did not return a list" };
  const prs: RosterPrView[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry) || typeof entry.url !== "string" || typeof entry.headRefName !== "string") {
      return { ok: false, why: "gh pr list returned a PR with no url" };
    }
    const state = typeof entry.state === "string" ? PR_STATES[entry.state] : undefined;
    if (state === undefined) return { ok: false, why: `gh pr list returned an unknown state '${String(entry.state)}'` };
    prs.push({ url: entry.url, branch: entry.headRefName, state });
  }
  return { ok: true, value: prs };
}

const known = <T extends string>(allowed: readonly T[], text: unknown): text is T =>
  typeof text === "string" && (allowed as readonly string[]).includes(text);
const nullableText = (field: unknown): field is string | null => field === null || typeof field === "string";

/** One row of the sentinel's view, or null when this dashboard cannot read it. */
function sentinelIssueRow(entry: unknown): SentinelIssueRow | null {
  if (!isRecord(entry)) return null;
  const { key, reporter, id, title, permalink, state, events, users, attempts, ticket, ticketNumber, mode } = entry;
  const { draftTitle, observedAt, updatedAt, cycle, regressedAfter } = entry;
  if (!known<SentinelIssueState>(SENTINEL_ISSUE_STATES, state) || !known<SentinelMode>(SENTINEL_MODES, mode)) return null;
  if (typeof key !== "string" || typeof reporter !== "string" || typeof id !== "string" || typeof title !== "string") return null;
  if (typeof observedAt !== "string" || typeof updatedAt !== "string") return null;
  if (!isCount(events) || !isCount(users) || !isCount(attempts) || !isCount(cycle)) return null;
  if (!nullableText(permalink) || !nullableText(ticket) || !nullableText(draftTitle) || !nullableText(regressedAfter)) return null;
  if (ticketNumber !== null && !isCount(ticketNumber)) return null;
  return {
    key,
    reporter,
    id,
    title,
    permalink,
    state,
    events,
    users,
    attempts,
    ticket,
    ticketNumber,
    mode,
    draftTitle,
    observedAt,
    updatedAt,
    cycle,
    regressedAfter,
  };
}

/**
 * Narrow `sentinel/issues.ts --json`. A wrong top level, version or ledger is
 * drift and fails the read; one row whose state or mode this dashboard does
 * not know is dropped instead, so a newer CLI's addition costs that row, not
 * the panel — as `narrowFollowing` treats its watches.
 */
export function parseSentinelIssues(result: ExecResult): Read<SentinelIssuesView> {
  const what = "sentinel/issues.ts";
  if (result.status === null) return { ok: false, why: why(result, what) };
  // The CLI says why the store is unreadable on stderr, under its own prefix.
  if (result.status !== 0) return { ok: false, why: firstLine(result.stderr).replace(/^sentinel-issues: /, "") || failure(result, what) };
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return { ok: false, why: `${what} did not return JSON` };
  }
  if (!isRecord(value)) return { ok: false, why: `${what} did not return an object` };
  if (value.version !== 1) return { ok: false, why: `${what} printed version ${JSON.stringify(value.version) ?? "undefined"}, this dashboard reads 1` };
  if (!Array.isArray(value.issues)) return { ok: false, why: `${what} returned no issues list` };
  const today = value.today;
  if (!isRecord(today) || typeof today.day !== "string" || !isCount(today.filed) || typeof today.alerted !== "boolean") {
    return { ok: false, why: `${what} returned no today ledger` };
  }
  const issues = (value.issues as unknown[]).map(sentinelIssueRow).filter((row): row is SentinelIssueRow => row !== null);
  return { ok: true, value: { version: 1, issues, today: { day: today.day, filed: today.filed, alerted: today.alerted } } };
}

const textOrNull = (field: unknown): string | null => (typeof field === "string" && field !== "" ? field : null);

/** A repository label as `gh label list` describes it. */
export interface RepoLabel {
  name: string;
  color: string | null;
  description: string | null;
}

/**
 * The project's labels, out of `gh label list --json name,color,description`.
 * Only the name is required: colour and description are decoration, and a
 * label without them is still a label a loop can claim with.
 */
export function parseLabelDetails(result: ExecResult): Read<RepoLabel[]> {
  if (result.status !== 0) return { ok: false, why: failure(result, "gh label list") };
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return { ok: false, why: "gh label list did not return JSON" };
  }
  if (!Array.isArray(value)) return { ok: false, why: "gh label list did not return a list" };
  const labels: RepoLabel[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== "string") return { ok: false, why: "gh label list returned a label with no name" };
    labels.push({ name: item.name, color: textOrNull(item.color), description: textOrNull(item.description) });
  }
  return { ok: true, value: labels };
}

/** Every worktree's supervisor liveness, out of `loop-state status --json`. */
export function parseSupervisors(result: ExecResult): Read<{ worktree: string; liveness: Liveness }[]> {
  const read = parseCheckouts(result);
  return read.ok ? { ok: true, value: read.value.loops.map(({ worktree, liveness }) => ({ worktree, liveness })) } : read;
}

/** Supervisor liveness and the reconciliation lists, out of `loop-state status --json`. */
export function parseCheckouts(result: ExecResult): Read<CheckoutsSnapshot> {
  if (result.status !== 0) return { ok: false, why: `loop-state could not run: ${failure(result, "loop-state")}` };
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return { ok: false, why: "loop-state did not return JSON" };
  }
  try {
    const snapshot = narrowSnapshot(value);
    return {
      ok: true,
      value: {
        loops: snapshot.loops.map((loop) => ({
          worktree: loop.worktree,
          liveness: loop.supervisor,
          owner: loop.state?.owner.loop ?? null,
          // As `unattributedWorktrees` in aggregate.ts: a record someone wrote,
          // even one that cannot be read, is reported rather than dropped.
          recorded: loop.state !== null || loop.stateProblem === "unreadable" || loop.stateProblem === "foreign",
        })),
        orphaned: snapshot.reconciliation.orphaned,
        prunable: snapshot.reconciliation.prunable,
      },
    };
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message : String(error) };
  }
}

/** `preflight.ts --json`'s answer, narrowed to what a card shows. */
export interface PreflightVerdict {
  verdict: "ready" | "denied" | "unavailable";
  /** The names of the checks that denied it, so the card can say which one. */
  denied: string[];
}

/** Where a loop's orchestrator model came from, out of `models.ts --json`. */
export interface LineupSource {
  /** `'loop'` when `models.json` holds a block for it; else the block it fell back to. */
  source: string;
}

/** Jav's block for one project, narrowed to what the Jav readiness item needs. */
export interface JavRoutes {
  enabled: boolean;
  routes: Record<string, string[]>;
}

const PREFLIGHT_VERDICTS = ["ready", "denied", "unavailable"] as const;

/**
 * Narrow `preflight.ts --json`'s `{ verdict, checks }`.
 *
 * The exit status is NOT a failure here: preflight exits 1 on `denied` and 2 on
 * `unavailable` by design, so the verdict is read off stdout and only the
 * absence of one is a failed read. `checks` is narrowed leniently — a card that
 * cannot name the denied check still shows the verdict, which is the answer the
 * item is about.
 */
export function parsePreflightJson(result: ExecResult): Read<PreflightVerdict> {
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return { ok: false, why: failure(result, "preflight --json") };
  }
  if (!isRecord(value) || typeof value.verdict !== "string") {
    return { ok: false, why: "preflight --json returned no verdict" };
  }
  const verdict = PREFLIGHT_VERDICTS.find((known) => known === value.verdict);
  if (verdict === undefined) return { ok: false, why: `preflight --json returned an unknown verdict '${value.verdict}'` };
  const denied: string[] = [];
  if (Array.isArray(value.checks)) {
    for (const check of value.checks) {
      // `preflight.ts`'s own shape: `{ name, outcome: { status } }`, where
      // `status` is `ok | denied | unavailable | warn` (`CheckResult`,
      // `Outcome`). The nesting is the contract — a reader that looked for a
      // flat `state` would find none and quietly name no check at all.
      if (!isRecord(check) || typeof check.name !== "string") continue;
      const outcome = check.outcome;
      if (isRecord(outcome) && outcome.status === "denied") denied.push(check.name);
    }
  }
  return { ok: true, value: { verdict, denied } };
}

/** Narrow `models.ts --json` to where its orchestrator stage came from. */
export function parseLineupSource(result: ExecResult): Read<LineupSource> {
  if (result.status !== 0) return { ok: false, why: failure(result, "models --json") };
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return { ok: false, why: "models --json did not return JSON" };
  }
  // The orchestrator is the one stage every role has, which is why the lineup's
  // provenance is read off it rather than off a stage a role may not run.
  const stages = isRecord(value) ? value.stages : undefined;
  const orchestrator = isRecord(stages) ? stages.orchestrator : undefined;
  if (!isRecord(orchestrator) || typeof orchestrator.source !== "string") {
    return { ok: false, why: "models --json returned no orchestrator source" };
  }
  return { ok: true, value: { source: orchestrator.source } };
}

/**
 * Narrow `jav.ts --json` to `enabled` and `routes`.
 *
 * Leniently, in the spirit of `narrowJavConfig`: the file as written may be
 * invalid, which is what the Jav page is for fixing, and a readiness item is
 * not the place that refuses over it. A malformed `routes` reads as none,
 * which the item reports as a missing route rather than as a broken read.
 */
export function parseJavRoutes(result: ExecResult): Read<JavRoutes> {
  if (result.status !== 0) return { ok: false, why: failure(result, "jav --json") };
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return { ok: false, why: "jav --json did not return JSON" };
  }
  const config = isRecord(value) ? value.config : undefined;
  if (!isRecord(config)) return { ok: false, why: "jav --json returned no config" };
  const routes: Record<string, string[]> = {};
  if (isRecord(config.routes)) {
    for (const [loop, labels] of Object.entries(config.routes)) {
      if (Array.isArray(labels) && labels.every((label) => typeof label === "string")) routes[loop] = labels as string[];
    }
  }
  return { ok: true, value: { enabled: config.enabled === true, routes } };
}

/** Build the agents adapter over one project's main checkout. */
export function createAgentsAdapter(config: AgentsAdapterConfig): AgentsAdapter {
  const cliDir = resolve(config.cliDir);
  const root = resolve(config.root);
  const bunPath = config.bunPath ?? defaultBunPath();
  const baseEnv: Env = { ...process.env, ...config.env };
  const dataHome = baseEnv.XDG_DATA_HOME?.trim() || join(baseEnv.HOME?.trim() || "/", ".local", "share");
  const workspaces = resolve(config.workspaces ?? join(dataHome, ...AGENT_SURFACE.workspaces));
  const surface = AGENT_SURFACE;
  const run = guarded(config.exec);
  const defaultWorktreesDir = join(workspaces, config.project);
  const worktreesDir = config.worktreesDir === undefined ? defaultWorktreesDir : resolve(config.worktreesDir);

  const bun = (args: string[], at: string = root): Invocation => ({
    command: bunPath,
    args: [join(cliDir, surface.config.script), ...args],
    cwd: at,
    env: { ...baseEnv, [ADAPTER_ENV.project]: at },
  });
  const git = (args: readonly string[], options: { cwd?: string; env?: Env } = {}): Invocation => ({
    command: surface.git.command,
    args: [...args],
    cwd: options.cwd ?? root,
    env: { ...baseEnv, ...options.env },
  });
  const gh = (args: string[]): Invocation => ({ command: surface.gh.command, args, cwd: root, env: baseEnv });
  const indexed = (staged: StagedCommit): Env => ({ GIT_INDEX_FILE: staged.index });
  const verifierPrefix = `${surface.branchPrefix}/verifier-rules-`;
  const sentinelPrefix = `${surface.branchPrefix}/sentinel-rules-`;
  // The trailing `-` ends the key, so one key can never prefix-match another.
  const projectPrefix = (key: string): string => `${surface.branchPrefix}/project-settings-${key}-`;

  /* The invocations, private: nothing above the adapter sees a command. */

  // Asked per call, not once: a loop worktree that carries the config may
  // appear after the dashboard started (the main checkout may have none).
  const configInvocation = ({ at = configCheckout(root), ref }: { at?: string; ref?: string } = {}): Invocation =>
    bun([surface.config.json, ...(ref === undefined ? [] : [surface.config.at, ref])], at);
  const rosterEditInvocation = (edit: RosterEdit, name: string, ref: string, role?: LoopRole): Invocation =>
    bun([
      edit === "add" ? surface.config.add : surface.config.remove,
      name,
      // Only an add carries one; `--remove-loop` names the loop alone.
      ...(role === undefined ? [] : [surface.config.role, role]),
      surface.config.at,
      ref,
    ]);
  const verifierEditInvocation = (rules: VerifierRules, ref: string): Invocation => ({
    ...bun([surface.config.setVerifier, surface.config.at, ref]),
    // On stdin, as `project-config` reads it: a JSON object is no argv word.
    input: JSON.stringify(rules),
  });
  const sentinelEditInvocation = (rules: SentinelRules, ref: string): Invocation => ({
    ...bun([surface.config.setSentinel, surface.config.at, ref]),
    input: JSON.stringify(rules),
  });
  // Against the checkout holding the config, asked per call as `--json` is:
  // the CLI finds the store through that checkout's git common directory.
  const sentinelIssuesInvocation = (): Invocation => {
    const at = configCheckout(root);
    return {
      command: bunPath,
      args: [join(cliDir, surface.sentinel.script), surface.sentinel.json],
      cwd: at,
      env: { ...baseEnv, [ADAPTER_ENV.project]: at },
    };
  };
  const projectEditInvocation = (values: ProjectConfigEdit, ref: string): Invocation => ({
    ...bun([surface.config.setProject, surface.config.at, ref]),
    input: JSON.stringify(values),
  });
  const supervisorsInvocation = (): Invocation => ({
    command: bunPath,
    args: [join(cliDir, surface.supervisors.script), ...surface.supervisors.args],
    cwd: root,
    env: { ...baseEnv, [ADAPTER_ENV.loopStateRoot]: root },
  });
  const labelsInvocation = (name: string, role: LoopRole): Invocation => ({
    command: bunPath,
    args: [
      join(cliDir, surface.preflight.script),
      surface.preflight.labels,
      surface.preflight.loop,
      name,
      surface.preflight.role,
      role,
    ],
    cwd: root,
    env: { ...baseEnv, [ADAPTER_ENV.project]: root },
  });
  // In the agent's OWN worktree: preflight chdirs to the project root it
  // finds itself in, and every check it makes is about that checkout.
  const preflightInvocation = (worktree: string, name: string): Invocation => ({
    command: bunPath,
    args: [join(cliDir, surface.preflight.script), surface.preflight.json],
    cwd: worktree,
    env: { ...baseEnv, [ADAPTER_ENV.project]: worktree, RALPH_LOOP_NAME: name },
  });
  const modelsInvocation = (name: string, role: LoopRole): Invocation => ({
    command: bunPath,
    args: [join(cliDir, surface.models.script), surface.models.json, surface.models.role, role],
    cwd: root,
    // `RALPH_PROJECT_ID` is load-bearing: without it the project is unset and
    // only the file's `default` applies, so a loop falling back to its
    // PROJECT's block would be reported as falling back to the file's.
    env: { ...baseEnv, RALPH_LOOP_NAME: name, RALPH_PROJECT_ID: config.project },
  });
  // Against the checkout holding the config, as `ralph.sh` renders from the
  // project worktree: the fragments are read relative to it. The env is
  // `baseEnv` like every other invocation here, plus the project id and loop
  // name a render resolves its lineup by (see `modelsInvocation`).
  const renderInvocation = (role: LoopRole, loop: string): Invocation => {
    const at = configCheckout(root);
    return {
      command: bunPath,
      args: [join(cliDir, surface.models.script), surface.models.render, surface.models.role, role],
      cwd: at,
      env: { ...baseEnv, [ADAPTER_ENV.project]: at, RALPH_PROJECT_ID: config.project, RALPH_LOOP_NAME: loop },
    };
  };
  const javInvocation = (): Invocation => ({
    command: bunPath,
    args: [join(cliDir, surface.jav.script), surface.jav.json],
    cwd: root,
    env: { ...baseEnv, [ADAPTER_ENV.project]: root, RALPH_PROJECT_ID: config.project },
  });

  /* What came back, narrowed. */

  // A null status never exited, so its stderr is not `project-config`'s
  // refusal: it may be the executor's own error (a throw `guarded` caught),
  // which must read the same as a timeout kill.
  const parseRosterEdit = (result: ExecResult): Read<string> =>
    result.status === 0 && result.stdout.trim() !== ""
      ? { ok: true, value: result.stdout }
      : result.status === null
        ? { ok: false, why: why(result, "project-config") }
        : { ok: false, why: result.stderr.trim().replace(/^project-config: /, "") || failure(result, "project-config") };
  const parseLabels = (result: ExecResult): Read<string[]> =>
    result.status === 0
      ? { ok: true, value: result.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "") }
      : { ok: false, why: result.stderr.trim().replace(/^preflight: /, "") || failure(result, "preflight --labels") };
  const parseRevParse = (result: ExecResult): Read<string> =>
    result.status === 0 && result.stdout.trim() !== ""
      ? { ok: true, value: result.stdout.trim() }
      : { ok: false, why: failure(result, "git rev-parse") };

  /** A command that changes something: exit 0, or the bare reason it did not. */
  const step = async (invocation: Invocation, what: string): Promise<Step> => {
    const result = await run(invocation);
    return result.status === 0 ? { ok: true } : { ok: false, why: why(result, what) };
  };
  /** A command whose answer is its output: trimmed stdout on exit 0, else the bare reason. */
  const output = async (invocation: Invocation, what: string): Promise<Read<string>> => {
    const result = await run(invocation);
    return result.status === 0 ? { ok: true, value: result.stdout.trim() } : { ok: false, why: why(result, what) };
  };

  return {
    root,
    project: config.project,
    worktreeFor: (name) => join(worktreesDir, `${name}${surface.worktreeSuffix}`),
    branchFor: (edit, name) => `${surface.branchPrefix}/${edit}-${name}`,
    readConfig: async (options) => parseAgentConfig(await run(configInvocation(options))),
    editRoster: async (edit, name, ref, role) => parseRosterEdit(await run(rosterEditInvocation(edit, name, ref, role))),
    editVerifier: async (rules, ref) => parseRosterEdit(await run(verifierEditInvocation(rules, ref))),
    verifierBranch: (stamp) => `${verifierPrefix}${stamp}`,
    verifierPr: async (repo) => {
      const listed = parsePrs(await run(gh([...surface.gh.openPrList, "--repo", repo])));
      if (!listed.ok) return listed;
      return { ok: true, value: listed.value.find((pr) => pr.state === "open" && pr.branch.startsWith(verifierPrefix)) ?? null };
    },
    editSentinel: async (rules, ref) => parseRosterEdit(await run(sentinelEditInvocation(rules, ref))),
    sentinelBranch: (stamp) => `${sentinelPrefix}${stamp}`,
    sentinelPr: async (repo) => {
      const listed = parsePrs(await run(gh([...surface.gh.openPrList, "--repo", repo])));
      if (!listed.ok) return listed;
      return { ok: true, value: listed.value.find((pr) => pr.state === "open" && pr.branch.startsWith(sentinelPrefix)) ?? null };
    },
    sentinelIssues: async () => parseSentinelIssues(await run(sentinelIssuesInvocation())),
    editProject: async (values, ref) => parseRosterEdit(await run(projectEditInvocation(values, ref))),
    projectBranch: (key, stamp) => `${projectPrefix(key)}${stamp}`,
    projectPr: async (repo, key) => {
      const listed = parsePrs(await run(gh([...surface.gh.openPrList, "--repo", repo])));
      if (!listed.ok) return listed;
      const prefix = projectPrefix(key);
      return { ok: true, value: listed.value.find((pr) => pr.state === "open" && pr.branch.startsWith(prefix)) ?? null };
    },
    fetch: (baseBranch, cwd = root) => step(git([...surface.git.fetch, baseBranch], { cwd }), "git fetch"),
    listWorktrees: async () => parseWorktreeList(await run(git(surface.git.worktreeList))),
    supervisors: async () => parseSupervisors(await run(supervisorsInvocation())),
    checkouts: async () => parseCheckouts(await run(supervisorsInvocation())),
    readLoopName: (worktree) => {
      try {
        const name = readFileSync(join(worktree, surface.loopName), "utf8").trim();
        return name === "" ? null : name;
      } catch {
        return null;
      }
    },
    provisionWorktree: (worktree, name) => {
      // Each directory in its own right: that `logsDir` happens to sit under
      // `loopName`'s parent is not a property either constant declares, and
      // the day one of them moves the write must not start failing.
      mkdirSync(dirname(join(worktree, surface.loopName)), { recursive: true });
      mkdirSync(join(worktree, surface.logsDir), { recursive: true });
      writeFileSync(join(worktree, surface.loopName), `${name}\n`);
    },
    addWorktree: (path, ref) => step(git([...surface.git.worktreeAdd, path, ref]), "git worktree add"),
    removeWorktree: (path) => step(git([...surface.git.worktreeRemove, path]), "git worktree remove"),
    stage: (text) => {
      const dir = mkdtempSync(join(tmpdir(), "ralph-roster-"));
      const file = join(dir, "config.json");
      writeFileSync(file, text);
      return { index: join(dir, "index"), file, dispose: () => rmSync(dir, { recursive: true, force: true }) };
    },
    readTree: (staged, ref) => output(git([...surface.git.readTree, ref], { env: indexed(staged) }), "git read-tree"),
    hashObject: (staged) => output(git([...surface.git.hashObject, staged.file]), "git hash-object"),
    updateIndex: (staged, blob) =>
      output(git([...surface.git.updateIndex, `100644,${blob},${surface.configPath}`], { env: indexed(staged) }), "git update-index"),
    writeTree: (staged) => output(git(surface.git.writeTree, { env: indexed(staged) }), "git write-tree"),
    commitTree: (_staged, tree, parent, message) =>
      output(git([...surface.git.commitTree, tree, "-p", parent, "-m", message]), "git commit-tree"),
    // Never `+` or `--force`: to the base branch this is a fast-forward or nothing.
    push: async (commit, branch) => {
      const result = await run(git([...surface.git.push, `${commit}:refs/heads/${branch}`]));
      if (result.status === 0) return { ok: true, value: result.stdout.trim() };
      return { ok: false, why: (result.status === null ? null : pushRefusal(result.stderr)) ?? why(result, "git push") };
    },
    createPr: ({ repo, base, branch, title, body }) =>
      output(
        gh([...surface.gh.prCreate, "--repo", repo, "--base", base, "--head", branch, "--title", title, "--body", body]),
        "gh pr create",
      ),
    // `ls-remote --exit-code` exits 2 for "no such ref": the one non-zero exit
    // that is an answer rather than a failure to ask. A listing that holds
    // only other refs ending the same way is a "no" too: only the exact ref is
    // the branch.
    remoteBranch: async (branch) => {
      const ref = `refs/heads/${branch}`;
      const result = await run(git([...surface.git.remoteBranch, ref]));
      if (result.status === 0) {
        return { ok: true, value: result.stdout.split("\n").some((line) => line.trim().split(/\s+/)[1] === ref) };
      }
      if (result.status === 2) return { ok: true, value: false };
      return { ok: false, why: why(result, "git ls-remote") };
    },
    reportedChecks: async (repo, ref) => {
      const heads = parsePrHeads(await run(gh([...surface.gh.recentPrHeads, "--repo", repo])), "gh pr list");
      if (!heads.ok) return heads;
      const commits = [ref, ...heads.value];
      const reads = await Promise.all(
        commits.flatMap((commit) => [
          (async () =>
            parseNames(
              await run(gh([...surface.gh.api, `repos/${repo}/commits/${commit}/check-runs?per_page=100`])),
              `gh api check-runs for ${commit}`,
              "check_runs",
              "name",
            ))(),
          (async () =>
            parseNames(
              await run(gh([...surface.gh.api, `repos/${repo}/commits/${commit}/status?per_page=100`])),
              `gh api status for ${commit}`,
              "statuses",
              "context",
            ))(),
        ]),
      );
      const names = new Set<string>();
      for (const read of reads) {
        if (!read.ok) return read;
        for (const name of read.value) names.add(name);
      }
      return { ok: true, value: [...names].sort() };
    },
    findPr: async (repo, branch) => parsePrList(await run(gh([...surface.gh.prList, "--repo", repo, "--head", branch]))),
    labels: async (name, role) => parseLabels(await run(labelsInvocation(name, role))),
    listLabels: async (repo) => parseLabelDetails(await run(gh([...surface.gh.labelList, "--repo", repo]))),
    createLabel: (repo, label) => step(gh([...surface.gh.labelCreate, label, "--repo", repo]), "gh label create"),
    status: (worktree) => output(git(surface.git.status, { cwd: worktree }), "git status"),
    isAncestor: async (worktree, ref) => (await run(git([...surface.git.isAncestor, ref], { cwd: worktree }))).status === 0,
    advance: (worktree, ref) => step(git([...surface.git.advance, ref], { cwd: worktree }), "git checkout"),
    revParse: async (worktree, rev) => parseRevParse(await run(git([...surface.git.revParse, rev], { cwd: worktree }))),
    preflight: async (worktree, name) => parsePreflightJson(await run(preflightInvocation(worktree, name))),
    models: async (name, role) => parseLineupSource(await run(modelsInvocation(name, role))),
    jav: async () => parseJavRoutes(await run(javInvocation())),
    hasNodeModules: (worktree) => existsSync(join(worktree, surface.nodeModules)),
    readGuide: () => {
      const path = join(cliDir, surface.guide);
      try {
        return { ok: true, value: readFileSync(path, "utf8") };
      } catch (error) {
        return { ok: false, why: `${path} could not be read: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
    readProjectFile: (path) => {
      const at = configCheckout(root);
      const full = resolve(at, path);
      const outside = (from: string, to: string): boolean => {
        const inside = relative(from, to);
        return inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
      };
      const refused = { ok: false, missing: false, why: `${path} is not a path inside the project checkout` } as const;
      if (isAbsolute(path) || outside(at, full)) return refused;
      try {
        // Checked again once links are resolved: a committed symlink would
        // otherwise pass the lexical check and relay a file from elsewhere.
        if (outside(realpathSync(at), realpathSync(full))) return refused;
        return { ok: true, value: readFileSync(full, "utf8") };
      } catch (error) {
        const missing = (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
        return { ok: false, missing, why: `${full} could not be read: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
    renderPrompt: async (role, loop) => {
      const result = await run(renderInvocation(role, loop));
      if (result.status === 0) return { ok: true, value: result.stdout };
      // Not `failure`: a render that dies part-way may have printed some of
      // the prompt, and its first line is no reason.
      const what = "models.ts --render-prompt";
      return { ok: false, why: result.stderr.trim() || (result.status === null ? why(result, what) : `${what} exited ${String(result.status)}`) };
    },
    worktreesDir: () => worktreesDir,
    defaultWorktreesDir: () => defaultWorktreesDir,
    worktreesDirSet: () => config.worktreesDir !== undefined,
    runWorktreeSetup: async (worktree, steps) => {
      const record: WorktreeSetupRecord = { ranAt: new Date().toISOString(), steps: [] };
      if (steps.length === 0) return record;
      if (!isDirectory(worktree)) return refusedSetup(steps, `the worktree directory ${worktree} does not exist`);
      const key = resolve(worktree);
      if (setupsInFlight.has(key)) return refusedSetup(steps, "a setup is already running in this worktree");
      setupsInFlight.add(key);
      try {
        const file = join(worktree, surface.worktreeSetupRecord);
        const save = (): void => {
          // WHY the `.git` check: a worktree removed mid-setup must not be
          // brought back as a bare directory holding only the record.
          if (!existsSync(join(worktree, ".git"))) return;
          const temp = `${file}.${process.pid}.tmp`;
          try {
            mkdirSync(dirname(file), { recursive: true });
            // A temp file and a rename, so a reader never sees half a record.
            writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
            renameSync(temp, file);
          } catch {
            // The returned record is the answer; the file is only its copy.
            try {
              rmSync(temp, { force: true });
            } catch {
              // A leftover temp file is harmless; the next save replaces it.
            }
          }
        };
        // The starting record, so a rerun in progress never shows the last run's pass.
        save();
        // The main checkout's path, so a step can copy what git does not carry
        // (an untracked env file) from it into the new worktree.
        const env = { ...baseEnv, RALPH_MAIN_CHECKOUT: root };
        let stopped = false;
        for (const step of steps) {
          const limitMs = step.timeoutSeconds * 1000;
          if (stopped) {
            record.steps.push({
              name: step.name,
              command: step.command,
              state: "skipped",
              durationMs: null,
              exitCode: null,
              output: "",
              truncated: false,
              limitMs,
              error: null,
            });
            continue;
          }
          // A fresh runner per step: each has its own limit, and one key per
          // runner means nothing is ever refused as already running.
          const started = createGateRunner({ limitMs, env }).start(step.name, worktree, { name: step.name, command: step.command });
          const view: WorktreeSetupStepView = started.started
            ? setupStepFromRun(await started.done)
            : { name: step.name, command: step.command, state: "failed", durationMs: null, exitCode: null, output: "", truncated: false, limitMs, error: started.reason };
          record.steps.push(view);
          stopped = view.state !== "passed";
          save();
        }
        // The skipped steps were added after the last write.
        if (stopped) save();
        return record;
      } finally {
        setupsInFlight.delete(key);
      }
    },
    readWorktreeSetup: (worktree) => {
      try {
        return narrowSetupRecord(JSON.parse(readFileSync(join(worktree, surface.worktreeSetupRecord), "utf8")));
      } catch {
        return null;
      }
    },
    setupRunning: (worktree) => setupsInFlight.has(resolve(worktree)),
    worktreeExists: (path) => isDirectory(path),
  };
}
