/**
 * Onboarding: adding a project, from a local path or from GitHub, and setting
 * up one that is not ready for Ralph yet.
 *
 * The sequences live here; every command they run is built and read by
 * `onboarding-adapter.ts`, which also runs it behind a guard, so this module
 * only sequences operations and a test of it still sees exactly the argv each
 * step would run, through the executor handed to the adapter.
 *
 *   - Local add takes an absolute path to a git checkout and registers its
 *     main checkout. A relative path, a missing directory, a directory git
 *     does not know, and a project already registered are each refused with
 *     the reason. So is the harness checkout (`RALPH_HOME`) or any worktree of
 *     it: setup switches a project's main checkout to its setup branch, which
 *     would change the harness under every running loop. Another clone of the
 *     same repo is an ordinary project.
 *   - GitHub add clones `owner/name` into `~/<name>` with `gh repo clone`,
 *     then is exactly a local add. It never clones over anything: when the
 *     target exists it refuses and names the checkout, which can be registered
 *     as a local project instead — unless the target is the harness, which is
 *     refused without that offer.
 *   - A project's status is derived, never stored: `ready` once its config is
 *     on `origin/<baseBranch>`, `setup-pending` while the setup PR is open,
 *     `needs-setup` otherwise. A project that is not ready fetches its base
 *     branch on each read (at most every `statusTtlMs`), so a merged setup PR
 *     turns it ready with nobody refreshing anything.
 *   - Setup validates the candidate with the harness's own `project-config`,
 *     so the dashboard can never write a config the loops would refuse, and
 *     `git check-ignore`s the four files, so an ignore rule that would fail
 *     `git add` is named before anything is touched; then it
 *     writes the four `.ralph/` files on a setup branch in the main checkout,
 *     pushes it, opens a PR, and puts the checkout back where it was. Its
 *     required checks default to the ones the base branch's latest commit
 *     reported; an empty list, which lets loops merge without waiting for
 *     CI, is refused unless the operator acknowledges it.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { isRecord } from "./adapter";
import {
  GITHUB_REPO,
  type AddProjectResult,
  type FolderPickResult,
  type GithubRepoView,
  type ProjectSetupView,
  type ProjectStatus,
  type ProjectView,
  type SetupDefaultsView,
  type SetupSubmitResult,
  type SetupValidation,
  type TrackerConnectReport,
  type TrackerConnectRequest,
  type TrackerSaveResult,
} from "./contracts";
import {
  CONFIG_FILE,
  failureOf,
  failureTail,
  gatesFromPackageJson,
  ONBOARDING_SURFACE,
  parsePrList,
  parseSetupBase,
  parseIgnored,
  parsePrUrl,
  parseRepoList,
  parseRepoView,
  repoFromRemote,
  requiredChecksFrom,
  SETUP_BRANCH,
  SETUP_COMMIT_MESSAGE,
  SETUP_TEMPLATES,
  succeeded,
  type OnboardingAdapter,
} from "./onboarding-adapter";
import { ProjectRegistryError, projectIdFor, type ProjectRegistry } from "./projects";

/** A refusal with its HTTP status and a name the page can branch on. */
export class OnboardingError extends Error {
  constructor(
    readonly status: number,
    name: string,
    message: string,
    readonly extra: { path?: string; problems?: string[] } = {},
  ) {
    super(message);
    this.name = name;
  }
}

export interface Onboarding {
  addLocal(path: string): Promise<AddProjectResult>;
  addFromGithub(repo: string): Promise<AddProjectResult>;
  githubRepos(): Promise<GithubRepoView[]>;
  /** The folder chosen in the host's folder dialog, or null when it was closed. */
  pickFolder(): Promise<FolderPickResult>;
  status(project: ProjectView): Promise<ProjectSetupView>;
  defaults(project: ProjectView): Promise<SetupDefaultsView>;
  validate(project: ProjectView, candidate: unknown): Promise<SetupValidation>;
  submit(project: ProjectView, candidate: unknown, options?: SetupSubmitOptions): Promise<SetupSubmitResult>;
  /** What the token can see: teams or projects, and the named one's states (#338). */
  testTracker(project: ProjectView, request: unknown): Promise<TrackerConnectReport>;
  /** Store the token on this host for the project's loops, once it has tested good. */
  saveTracker(project: ProjectView, request: unknown): Promise<TrackerSaveResult>;
}

export interface SetupSubmitOptions {
  /**
   * The operator saw that an empty `requiredChecks` lets loops merge without
   * waiting for CI, and wants it anyway. Without it, an empty list is refused.
   */
  acknowledgeNoRequiredChecks?: boolean;
}

export interface OnboardingDeps {
  adapter: OnboardingAdapter;
  registry: ProjectRegistry;
  /** How long a derived status is reused. */
  statusTtlMs?: number;
  now?: () => number;
}

const SURFACE = ONBOARDING_SURFACE;

const PR_BODY = [
  "Adds the project's Ralph config, written by the dashboard's setup form:",
  "",
  "- `.ralph/config.json` — repo, base branch, gates and the loop roster",
  "- the prompt and coder fragments, and the plan's scope fences, from the harness's templates",
  "",
  "Loops can start once this is on the base branch.",
].join("\n");

const refuseReadOnly = (registry: ProjectRegistry): void => {
  if (registry.readOnly) {
    throw new OnboardingError(409, "RegistryReadOnly", "RALPH_DASHBOARD_ROOTS names this run's projects, so none can be added");
  }
};

const physical = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

export function createOnboarding({ adapter, registry, statusTtlMs = 15_000, now = Date.now }: OnboardingDeps): Onboarding {
  const git = (cwd: string, args: readonly string[]) => adapter.git(cwd, args);
  const gh = (cwd: string, args: readonly string[]) => adapter.gh(cwd, args);

  /** Whether `path` is the harness checkout, or a worktree of its repo. */
  const isHarness = (path: string): boolean => {
    const harness = physical(adapter.harness);
    return physical(path) === harness || projectIdFor(physical(path)).path === projectIdFor(harness).path;
  };
  const refuseHarness = (path: string, instead: string): never => {
    throw new OnboardingError(
      409,
      "HarnessCheckout",
      `${path} is the Ralph harness checkout the dashboard and the loops run from; setup would switch its branch under every running loop. ${instead}`,
    );
  };

  const statuses = new Map<string, { at: number; view: Promise<ProjectSetupView> }>();
  const keyOf = (project: ProjectView): string => `${project.id}\0${project.path}`;

  /** The non-empty `baseBranch` a checkout's own `.ralph/config.json` names, else null. */
  const baseBranchIn = (checkout: string): string | null => {
    try {
      const config: unknown = JSON.parse(readFileSync(join(checkout, CONFIG_FILE), "utf8"));
      if (isRecord(config) && typeof config.baseBranch === "string" && config.baseBranch !== "") return config.baseBranch;
    } catch {
      // No readable config in this checkout.
    }
    return null;
  };

  /**
   * The base branch: the one the checkout's own config names, else the one a
   * linked worktree of the repo names, else the one the latest setup PR
   * targeted, else origin's HEAD, else `main`.
   */
  const baseBranchOf = async (root: string): Promise<string> => {
    const own = baseBranchIn(root);
    if (own !== null) return own;
    // The main checkout may sit behind its base, without the config, while
    // the loop worktrees of the same repo carry it: asking them first answers
    // without the network, so a gh outage cannot hide a set-up project.
    const listed = await git(root, SURFACE.git.worktreeList);
    if (succeeded(listed)) {
      const self = physical(root);
      for (const line of listed.stdout.split("\n")) {
        if (!line.startsWith("worktree ")) continue;
        const checkout = line.slice("worktree ".length);
        if (physical(checkout) === self) continue;
        const named = baseBranchIn(checkout);
        if (named !== null) return named;
      }
    }
    // The main checkout stays on its own branch after setup, so a config that
    // merged into a base other than origin's HEAD is only found through the PR.
    const setup = await gh(root, SURFACE.gh.setupBase);
    const targeted = succeeded(setup) ? parseSetupBase(setup.stdout) : null;
    if (targeted !== null) return targeted;
    const head = await git(root, SURFACE.git.originHead);
    const named = succeeded(head) ? head.stdout.trim().replace(/^origin\//, "") : "";
    return named === "" ? "main" : named;
  };

  const deriveStatus = async (project: ProjectView): Promise<ProjectSetupView> => {
    const baseBranch = await baseBranchOf(project.path);
    const view = (status: ProjectStatus, pr: ProjectSetupView["pr"] = null): ProjectSetupView => ({
      project: project.id,
      status,
      baseBranch,
      pr,
    });
    if (succeeded(await git(project.path, SURFACE.git.configOn(baseBranch)))) return view("ready");
    // Not on the base branch as last fetched: it may have merged since.
    await git(project.path, SURFACE.git.fetchBase(baseBranch));
    if (succeeded(await git(project.path, SURFACE.git.configOn(baseBranch)))) return view("ready");
    const prs = await gh(project.path, SURFACE.gh.setupPr);
    // A list that failed says nothing about a setup PR: answering needs-setup
    // would offer setup again for a project whose PR is open. The cache drops
    // the rejection, so the next ask reads afresh.
    if (!succeeded(prs)) {
      throw new OnboardingError(
        503,
        "ProjectStatusUnknown",
        `cannot tell whether ${project.id} is set up: gh pr list failed: ${failureOf(prs, "gh pr list")}`,
      );
    }
    const pr = parsePrList(prs.stdout);
    return pr === null ? view("needs-setup") : view("setup-pending", pr);
  };

  const status = (project: ProjectView): Promise<ProjectSetupView> => {
    const key = keyOf(project);
    const cached = statuses.get(key);
    if (cached !== undefined && now() - cached.at < statusTtlMs) return cached.view;
    const view = deriveStatus(project);
    statuses.set(key, { at: now(), view });
    // A failed read is not reused.
    view.catch(() => statuses.delete(key));
    return view;
  };

  const register = async (path: string, source: ProjectView["source"]): Promise<AddProjectResult> => {
    refuseReadOnly(registry);
    const top = await git(path, SURFACE.git.toplevel);
    if (!succeeded(top) || top.stdout.trim() === "") {
      throw new OnboardingError(422, "NotAGitRepository", `${path} is not a git repository`);
    }
    const main = projectIdFor(top.stdout.trim());
    if (isHarness(main.path)) refuseHarness(path, "Clone the repo into a separate directory and add that checkout instead.");
    const registered = registry.list();
    const clash = registered.find((entry) => entry.path === main.path);
    if (clash !== undefined) {
      throw new OnboardingError(409, "AlreadyRegistered", `project '${clash.id}' at ${clash.path} is already registered`);
    }
    // Another repo with the same directory name gets a suffixed id, as the seed does.
    let id = main.id;
    for (let n = 2; registered.some((entry) => entry.id === id); n += 1) id = `${main.id}-${n}`;
    let project: ProjectView;
    try {
      project = registry.add({ path: main.path, id, source });
    } catch (error) {
      if (error instanceof ProjectRegistryError) throw new OnboardingError(409, "AlreadyRegistered", error.message);
      throw error;
    }
    try {
      return { project, status: (await status(project)).status };
    } catch (error) {
      // The project IS registered; only its setup state is unknown, and its
      // page reads it again. A refusal here would tell the operator it was
      // not added, and a second Add would then be refused as a duplicate.
      if (error instanceof OnboardingError && error.name === "ProjectStatusUnknown") return { project, status: null };
      throw error;
    }
  };

  const addLocal = async (path: string): Promise<AddProjectResult> => {
    if (!isAbsolute(path)) {
      throw new OnboardingError(422, "RelativePath", `a project path must be absolute; got '${path}'`);
    }
    let directory = false;
    try {
      directory = statSync(path).isDirectory();
    } catch {
      // Missing: refused below.
    }
    if (!directory) throw new OnboardingError(422, "NoSuchDirectory", `no directory at ${path}`);
    return register(resolve(path), "local");
  };

  const addFromGithub = async (repo: string): Promise<AddProjectResult> => {
    if (!GITHUB_REPO.test(repo)) throw new OnboardingError(422, "InvalidRepo", `'${repo}' is not 'owner/name'`);
    refuseReadOnly(registry);
    const target = join(adapter.home, repo.split("/")[1]!);
    // Never offered as the existing checkout to register.
    if (isHarness(target)) {
      refuseHarness(target, `Clone ${repo} into another directory and add it as a local checkout instead.`);
    }
    if (existsSync(target)) {
      throw new OnboardingError(
        409,
        "CloneTargetExists",
        `${target} already exists, so ${repo} was not cloned; register it as a local project instead`,
        { path: target },
      );
    }
    const clone = await gh(adapter.home, SURFACE.gh.clone(repo, target));
    if (!succeeded(clone)) throw new OnboardingError(502, "CloneFailed", `gh repo clone ${repo}: ${failureOf(clone, "gh repo clone")}`);
    return register(target, "github");
  };

  const githubRepos = async (): Promise<GithubRepoView[]> => {
    const list = await gh(adapter.home, SURFACE.gh.repoList);
    if (!succeeded(list)) throw new OnboardingError(502, "GithubUnavailable", `gh repo list: ${failureOf(list, "gh repo list")}`);
    return parseRepoList(list.stdout);
  };

  const pickFolder = async (): Promise<FolderPickResult> => {
    const picked = await adapter.pickFolder();
    switch (picked.kind) {
      case "none":
        throw new OnboardingError(
          501,
          "NoFolderPicker",
          picked.command === null ? "this host has no folder dialog; type the path" : `${picked.command} could not be run; type the path`,
        );
      case "cancelled":
        return { path: null };
      case "failed":
        throw new OnboardingError(502, "FolderPickerFailed", `${picked.command}: ${picked.failure}`);
      case "picked":
        return { path: picked.path };
    }
  };

  const defaults = async (project: ProjectView): Promise<SetupDefaultsView> => {
    const root = project.path;
    const [baseBranch, view, remote, login] = await Promise.all([
      baseBranchOf(root),
      gh(root, SURFACE.gh.repoView),
      git(root, SURFACE.git.remoteUrl),
      gh(root, SURFACE.gh.login),
    ]);
    const repo =
      (succeeded(view) ? parseRepoView(view.stdout) : null) ?? (succeeded(remote) ? repoFromRemote(remote.stdout) : null);
    const owner = (succeeded(login) ? login.stdout.trim() : "") || (repo?.split("/")[0] ?? "");
    // The checks the base branch reported, so loops wait on the project's CI
    // unless the operator removes them. Unreadable, the list starts empty and
    // the form asks for it.
    let requiredChecks: string[] = [];
    if (repo !== null) {
      const [runs, statuses] = await Promise.all([
        gh(root, SURFACE.gh.checkRuns(repo, baseBranch)),
        gh(root, SURFACE.gh.commitStatus(repo, baseBranch)),
      ]);
      requiredChecks = requiredChecksFrom(
        succeeded(runs) ? runs.stdout : null,
        succeeded(statuses) ? statuses.stdout : null,
      );
    }
    let packageJson: string | null = null;
    try {
      packageJson = readFileSync(join(root, "package.json"), "utf8");
    } catch {
      // No package.json: no gates to guess.
    }
    let files: string[] = [];
    try {
      files = readdirSync(root);
    } catch {
      // Unreadable: the lockfile guess falls back to npm.
    }
    return {
      project: project.id,
      config: {
        repo: repo ?? "",
        owner,
        baseBranch,
        displayName: repo?.split("/")[1] ?? basename(root),
        secrets: { runner: "none", withhold: [] },
        refuseFiles: [],
        envCheck: [],
        requiredChecks,
        gates: gatesFromPackageJson(packageJson, files),
        promptFragment: ".ralph/prompt.md",
        coderFragment: ".ralph/coder.md",
        plan: ".ralph/plan.md",
        journal: { dir: `journal/${project.id}` },
        loops: ["ralph"],
      },
    };
  };

  /**
   * Run `project-config` against the candidate in a scratch root: every
   * problem it has, at once. A config it accepts is then checked against the
   * checkout: a setup file its ignore rules cover would fail `git add` after
   * setup had already switched branches, so each is a problem, with its rule.
   */
  const validate = async (project: ProjectView, candidate: unknown): Promise<SetupValidation> => {
    const scratch = mkdtempSync(join(tmpdir(), "ralph-setup-"));
    try {
      mkdirSync(join(scratch, dirname(CONFIG_FILE)), { recursive: true });
      writeFileSync(join(scratch, CONFIG_FILE), `${JSON.stringify(candidate, null, 2)}\n`);
      const problems = await adapter.projectConfigProblems(scratch);
      if (problems.length === 0 && isRecord(candidate)) {
        const paths = [CONFIG_FILE, ...Object.keys(SETUP_TEMPLATES).map((key) => String(candidate[key]))];
        if (new Set(paths.map((path) => resolve("/", path))).size !== paths.length) {
          problems.push("'promptFragment', 'coderFragment' and 'plan' must be different files, none of them the config");
        } else {
          // Unreadable (exit 128, say) adds nothing: `git add` still reports it.
          const checked = await git(project.path, SURFACE.git.checkIgnore(paths));
          const base = typeof candidate.baseBranch === "string" ? candidate.baseBranch : "the base branch";
          for (const ignored of checked.status === 0 ? parseIgnored(checked.stdout) : []) {
            problems.push(
              `'${ignored.path}' is ignored by ${ignored.source}:${ignored.line} ('${ignored.pattern}'), so setup could not commit it; un-ignore it on ${base} first`,
            );
          }
        }
      }
      return { valid: problems.length === 0, problems };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  const submit = async (
    project: ProjectView,
    candidate: unknown,
    { acknowledgeNoRequiredChecks = false }: SetupSubmitOptions = {},
  ): Promise<SetupSubmitResult> => {
    const validation = await validate(project, candidate);
    if (!validation.valid) {
      throw new OnboardingError(422, "InvalidConfig", "the config is invalid", { problems: validation.problems });
    }
    if (isRecord(candidate) && Array.isArray(candidate.requiredChecks) && candidate.requiredChecks.length === 0 && !acknowledgeNoRequiredChecks) {
      throw new OnboardingError(
        422,
        "NoRequiredChecks",
        "'requiredChecks' is empty, so loops would merge without waiting for CI; name the checks, or acknowledge merging without them",
      );
    }
    const config = candidate as { baseBranch: string; promptFragment: string; coderFragment: string; plan: string };
    const current = await status(project);
    if (current.status !== "needs-setup") {
      throw new OnboardingError(
        409,
        "NotNeedingSetup",
        current.status === "ready"
          ? `${project.id} is already set up on ${current.baseBranch}`
          : `${project.id} already has a setup PR open: ${current.pr?.url ?? ""}`,
      );
    }
    const root = project.path;
    const dirty = await git(root, SURFACE.git.status);
    if (!succeeded(dirty)) throw new OnboardingError(409, "CheckoutUnreadable", `git status: ${failureOf(dirty, "git status")}`);
    if (dirty.stdout.trim() !== "") {
      throw new OnboardingError(
        409,
        "CheckoutDirty",
        `${root} has uncommitted changes; setup switches its branch, so commit or move them first`,
      );
    }
    const head = await git(root, SURFACE.git.head);
    const named = succeeded(head) ? head.stdout.trim() : "";
    const sha = named === "HEAD" || named === "" ? await git(root, SURFACE.git.headSha) : null;
    const back = sha === null ? named : succeeded(sha) ? sha.stdout.trim() : "";
    if (back === "") throw new OnboardingError(409, "CheckoutUnreadable", `cannot tell which branch ${root} is on`);
    const step = async (args: readonly string[], what: string): Promise<void> => {
      const result = await git(root, args);
      if (!succeeded(result)) throw new OnboardingError(502, "SetupFailed", `${what}: ${failureOf(result, what)}`);
    };
    const base = config.baseBranch;
    const files: string[] = [CONFIG_FILE, config.promptFragment, config.coderFragment, config.plan];
    const openPr = async (): Promise<string> => {
      const pr = await gh(root, SURFACE.gh.prCreate(base, SETUP_COMMIT_MESSAGE, PR_BODY));
      const opened = succeeded(pr) ? parsePrUrl(pr.stdout) : null;
      if (opened === null) throw new OnboardingError(502, "SetupFailed", `gh pr create: ${failureOf(pr, "gh pr create")}`);
      return opened;
    };

    // A setup branch already on origin with no open PR: an earlier attempt
    // pushed and then failed to open its PR, which is resumed; anything else
    // (a closed PR, someone else's branch) is left alone and refused.
    const remote = await git(root, SURFACE.git.remoteSetup);
    if (remote.status !== 0 && remote.status !== 2) {
      throw new OnboardingError(502, "SetupFailed", `git ls-remote origin: ${failureOf(remote, "git ls-remote")}`);
    }
    if (remote.status === 0) {
      await step(SURFACE.git.fetchSetup, `git fetch origin ${SETUP_BRANCH}`);
      const subject = await git(root, SURFACE.git.setupSubject);
      if (!(succeeded(subject) && subject.stdout.trim() === SETUP_COMMIT_MESSAGE)) {
        throw new OnboardingError(
          409,
          "SetupBranchExists",
          `origin already has a ${SETUP_BRANCH} branch this dashboard did not push; delete it on GitHub, then set up again`,
        );
      }
      const url = await openPr();
      statuses.delete(keyOf(project));
      return { project: project.id, branch: SETUP_BRANCH, files, pr: { url } };
    }

    await step(SURFACE.git.fetchBase(base), `git fetch origin ${base}`);
    // A local setup branch this attempt makes is removed again if it fails
    // before committing on it, so no stray branch is left for the next one.
    const hadSetup = succeeded(await git(root, SURFACE.git.localSetup));
    await step(SURFACE.git.switchSetup(base), `git switch ${SETUP_BRANCH}`);
    const madeAt = hadSetup ? null : await git(root, SURFACE.git.localSetup);
    const made = madeAt !== null && succeeded(madeAt) ? madeAt.stdout.trim() : null;
    // What is there before writing — tracked on the base or ignored — so a
    // failed attempt puts it back byte for byte and removes only what it made.
    const before = new Map(files.flatMap((file) => (existsSync(join(root, file)) ? [[file, readFileSync(join(root, file))]] : [])));
    const madeDirs = files.flatMap((file) => missingDirs(root, dirname(file)));
    let committed = false;
    let url: string;
    try {
      writeSetupFile(root, CONFIG_FILE, `${JSON.stringify(candidate, null, 2)}\n`);
      for (const [key, template] of Object.entries(SETUP_TEMPLATES)) {
        writeSetupFile(root, config[key as keyof typeof SETUP_TEMPLATES], readFileSync(join(adapter.cliDir, template), "utf8"));
      }
      await step(SURFACE.git.add(files), "git add");
      await step(SURFACE.git.commit, "git commit");
      committed = true;
      // A push a pre-push hook refuses says why at the end of its output,
      // and the commit it refused is still here to push by hand.
      const pushed = await git(root, SURFACE.git.push);
      if (!succeeded(pushed)) {
        throw new OnboardingError(
          502,
          "SetupFailed",
          `git push origin ${SETUP_BRANCH} failed. The setup commit is on the local branch ${SETUP_BRANCH}: push it by hand, or set up again.\n${failureTail(pushed, "git push")}`,
        );
      }
      url = await openPr();
    } finally {
      if (!committed) {
        // Nothing reached a commit: leave no trace for the checkout to carry
        // back. An unstage fails harmlessly for a file `add` never staged.
        for (const file of files) await git(root, SURFACE.git.unstage(file));
        for (const file of files) {
          const previous = before.get(file);
          try {
            if (previous === undefined) unlinkSync(join(root, file));
            else writeFileSync(join(root, file), previous);
          } catch {
            // Never written.
          }
        }
        for (const dir of [...new Set(madeDirs)].sort((a, b) => b.length - a.length)) {
          try {
            rmdirSync(dir);
          } catch {
            // Not empty, or never made.
          }
        }
      }
      // The files are committed on the setup branch; the checkout goes back to where it was.
      const restored = await git(root, SURFACE.git.restore(back));
      // Only while it is still where this attempt made it: a branch with a
      // commit of its own is kept.
      if (!committed && made !== null && succeeded(restored)) await git(root, SURFACE.git.dropSetup(made));
      statuses.delete(keyOf(project));
    }
    return { project: project.id, branch: SETUP_BRANCH, files, pr: { url } };
  };

  /**
   * One connect call through `tracker.ts`, the request on stdin. Its stdout is
   * one JSON report whether or not the connection worked; anything else is the
   * harness failing, said in its own words, which never include the token.
   */
  const connect = async (args: readonly string[], request: object): Promise<Record<string, unknown>> => {
    const result = await adapter.tracker(args, JSON.stringify(request));
    try {
      return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
    } catch {
      throw new OnboardingError(502, "TrackerUnavailable", `tracker.ts ${args[0]}: ${failureOf(result, `tracker.ts ${args[0]}`)}`);
    }
  };

  const testTracker = async (_project: ProjectView, request: unknown): Promise<TrackerConnectReport> =>
    (await connect(SURFACE.tracker.connectTest, trackerRequest(request))) as TrackerConnectReport;

  // Tested again here rather than trusted from the form: a token is only ever
  // stored once the tracker has accepted it, whatever the page sent.
  const saveTracker = async (project: ProjectView, request: unknown): Promise<TrackerSaveResult> => {
    const checked = trackerRequest(request);
    const report = (await connect(SURFACE.tracker.connectTest, checked)) as TrackerConnectReport;
    if (!report.ok) throw new OnboardingError(422, "TrackerRefused", report.message);
    const credential =
      checked.kind === "linear"
        ? { kind: "linear", apiKey: checked.apiKey }
        : { kind: "jira", email: checked.email, apiToken: checked.apiToken };
    const saved = await connect(SURFACE.tracker.connectSave(project.id), credential);
    if (saved.ok !== true) throw new OnboardingError(422, "TrackerRefused", String(saved.message ?? "the credential was not saved"));
    return { saved: true };
  };

  return { addLocal, addFromGithub, githubRepos, pickFolder, status, defaults, validate, submit, testTracker, saveTracker };
}

/** The connector's request, refused with the field at fault; the token itself is never quoted. */
function trackerRequest(raw: unknown): TrackerConnectRequest {
  const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
  if (!isRecord(raw)) throw new OnboardingError(422, "InvalidTracker", "the tracker request must be an object");
  if (raw.kind === "linear") {
    if (!text(raw.apiKey)) throw new OnboardingError(422, "InvalidTracker", "a Linear connection needs an API key");
    return { kind: "linear", apiKey: raw.apiKey, ...(text(raw.team) ? { team: raw.team } : {}) };
  }
  if (raw.kind === "jira") {
    if (!text(raw.site) || !text(raw.email) || !text(raw.apiToken)) {
      throw new OnboardingError(422, "InvalidTracker", "a Jira connection needs the site, the account email and an API token");
    }
    return { kind: "jira", site: raw.site, email: raw.email, apiToken: raw.apiToken, ...(text(raw.project) ? { project: raw.project } : {}) };
  }
  throw new OnboardingError(422, "InvalidTracker", "the tracker kind must be linear or jira");
}

/** The directories on the way to `relative` under `root` that do not exist yet, outermost first. */
function missingDirs(root: string, relative: string): string[] {
  const dirs: string[] = [];
  for (let dir = relative; dir !== "." && dir !== "/" && dir !== ""; dir = dirname(dir)) {
    if (!existsSync(join(root, dir))) dirs.unshift(join(root, dir));
  }
  return dirs;
}

function writeSetupFile(root: string, relative: string, text: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
