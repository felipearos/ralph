/**
 * Agent dispatch: add an agent, delete an agent's worktree, gate a new
 * agent's Start, and remove a project — over the injected agents adapter.
 *
 * The agent sibling of `lifecycle.ts`. It names no command: `agents-adapter.ts`
 * builds every invocation and narrows every answer, and this module decides
 * the order and when to stop. The properties it carries:
 *
 * 1. **The roster changes by pull request, never in place.** Adding an agent
 *    makes its worktree at once, but its name reaches `loops` only when the
 *    PR merges. Until `origin/<baseBranch>` names it, the agent is
 *    `pending-merge` and Start is refused: `ralph.sh` would refuse the name
 *    anyway, and a loop outside the roster writes claims nobody reads. Create
 *    checkout is the one path that edits no roster, because the name it is
 *    given is on it already.
 * 2. **A live supervisor is never orphaned.** Deleting a worktree and
 *    removing a project are refused while a supervisor there is alive, or
 *    while its liveness cannot be seen — the same `loop-state` read restart
 *    and Resume work refuse over. Unknown is never read as gone.
 * 3. **Nothing is deleted that the dashboard did not make.** Delete removes a
 *    linked worktree with `git worktree remove`, which itself refuses one with
 *    changes in it, and never the main checkout. Removing a project edits only
 *    the registry: no file, worktree, clone or GitHub state is touched.
 *
 * Everything that can be checked is checked before the first change, so a
 * refusal leaves nothing behind. What cannot — the push and the PR, after the
 * worktree exists or is gone — is reported as `pr-failed` with where it stopped.
 */
import { createHash } from "node:crypto";

import { READINESS_ITEMS, javRoutedRoles } from "./contracts";
import type {
  AddAgentResult,
  AgentPreflightView,
  AgentsView,
  CreateCheckoutResult,
  DeleteAgentResult,
  GuideView,
  LabelUserView,
  LabelsView,
  LoopRole,
  PendingAgentView,
  ProjectEdit,
  ProjectLabelView,
  ProposeProjectResult,
  ProposeSentinelResult,
  ProposeVerifierResult,
  ReadinessItem,
  ReadinessItemKey,
  ReadinessState,
  RemoveProjectResult,
  RerunSetupResult,
  RosterPrView,
  RulesSaveResult,
  SentinelPanelView,
  SentinelRules,
  SentinelRulesView,
  SentinelView,
  VerifierRules,
  VerifierRulesView,
  VerifierView,
  StartResult,
  WorktreeSetupRecord,
  WorktreeSetupStepConfig,
  WorktreeSetupStepView,
} from "./contracts";
import { CODER_FRONTIER_LABELS, SENTINEL_RULE_DEFAULTS, SENTINEL_RULE_KEYS, VERIFIER_RULE_DEFAULTS } from "./contracts";
import {
  LABEL_LIST_LIMIT,
  SETUP_DEFAULT_TIMEOUT_SECONDS,
  samePath,
  type AgentProjectConfig,
  type AgentsAdapter,
  type JavRoutes,
  type ProjectConfigEdit,
  type Read,
  type RosterEdit,
  type WorktreeSetupStepEdit,
} from "./agents-adapter";
import { start, type LifecycleDeps } from "./lifecycle";

export interface AgentsDeps {
  agents: AgentsAdapter;
}

/** A change to the registry, as the remove and worktrees-folder routes hand it over. */
export interface ProjectRegistryWrite {
  readonly readOnly: boolean;
  remove(id: string): boolean;
  /**
   * Sets (or, with null, clears) the folder the project's new agent worktrees
   * go in, and answers the entry as written. Throws, with the reason as its
   * message, when the folder is refused or the registry is read-only.
   */
  setWorktrees(id: string, folder: string | null): { worktrees?: string };
}

const baseRef = (config: AgentProjectConfig): string => `origin/${config.baseBranch}`;

const readConfig = (deps: AgentsDeps, options: { at?: string; ref?: string } = {}): Promise<Read<AgentProjectConfig>> =>
  deps.agents.readConfig(options);

/** Fetch the base branch, then read the roster it holds. */
const readBaseConfig = async (deps: AgentsDeps, config: AgentProjectConfig, cwd?: string): Promise<Read<AgentProjectConfig>> => {
  const fetched = await deps.agents.fetch(config.baseBranch, cwd);
  if (!fetched.ok) return { ok: false, why: `could not fetch ${baseRef(config)}: ${fetched.why}` };
  return readConfig(deps, { ...(cwd === undefined ? {} : { at: cwd }), ref: baseRef(config) });
};

const findPr = async (deps: AgentsDeps, repo: string, edit: RosterEdit, name: string): Promise<RosterPrView | null> => {
  const found = await deps.agents.findPr(repo, deps.agents.branchFor(edit, name));
  return found.ok ? found.value : null;
};

/** What a config PR is: its branch, and what it says on GitHub. */
interface ConfigPr {
  branch: string;
  title: string;
  body: string;
}

/** The adapter answers the bare reason; which step stopped is said here. */
const named = async (answer: Promise<Read<string>>, what: string): Promise<Read<string>> => {
  const result = await answer;
  return result.ok ? result : { ok: false, why: `${what} failed: ${result.why}` };
};

/**
 * Commit the edited config on top of the base branch in a private index, and
 * answer the commit's SHA. Nothing is pushed and no working tree is touched;
 * the parent is `origin/<baseBranch>` as last fetched, which is what makes a
 * push of it to the base branch a fast-forward or a refusal, never a rewrite.
 */
async function buildConfigCommit(deps: AgentsDeps, config: AgentProjectConfig, text: string, message: string): Promise<Read<string>> {
  const { agents } = deps;
  const staged = agents.stage(text);
  try {
    const read = await named(agents.readTree(staged, baseRef(config)), "git read-tree");
    if (!read.ok) return read;
    const blob = await named(agents.hashObject(staged), "git hash-object");
    if (!blob.ok) return blob;
    const updated = await named(agents.updateIndex(staged, blob.value), "git update-index");
    if (!updated.ok) return updated;
    const tree = await named(agents.writeTree(staged), "git write-tree");
    if (!tree.ok) return tree;
    return await named(agents.commitTree(staged, tree.value, baseRef(config), message), "git commit-tree");
  } finally {
    staged.dispose();
  }
}

/** Push a built commit as `pr.branch` and open the PR; the URL `gh pr create` prints is the PR's. */
async function pushConfigPr(deps: AgentsDeps, config: AgentProjectConfig, pr: ConfigPr, commit: string): Promise<Read<RosterPrView>> {
  const { agents } = deps;
  const { branch, title, body } = pr;
  const pushed = await named(agents.push(commit, branch), "git push");
  if (!pushed.ok) return pushed;
  const created = await named(agents.createPr({ repo: config.repo, base: config.baseBranch, branch, title, body }), "gh pr create");
  if (!created.ok) return created;
  const url = created.value.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("http")).pop();
  if (url === undefined) return { ok: false, why: "gh pr create printed no PR URL" };
  return { ok: true, value: { url, branch, state: "open" } };
}

/**
 * Commit the edited config on top of the base branch in a private index, push
 * it as `pr.branch` and open the PR. Roster, settings and rules PRs share it,
 * so all build their commit the same way and none touches a working tree.
 */
async function openConfigPr(deps: AgentsDeps, config: AgentProjectConfig, pr: ConfigPr, text: string): Promise<Read<RosterPrView>> {
  const commit = await buildConfigCommit(deps, config, text, pr.title);
  return commit.ok ? pushConfigPr(deps, config, pr, commit.value) : commit;
}

/** The roster PR adding or removing `name`. */
const openRosterPr = (deps: AgentsDeps, config: AgentProjectConfig, edit: RosterEdit, name: string, text: string): Promise<Read<RosterPrView>> =>
  openConfigPr(
    deps,
    config,
    {
      branch: deps.agents.branchFor(edit, name),
      title: edit === "add" ? `Ralph roster: add ${name}` : `Ralph roster: remove ${name}`,
      body:
        edit === "add"
          ? `Adds \`${name}\` to \`loops\` in \`.ralph/config.json\`.\n\nIts worktree is ready; the dashboard keeps its Start refused until this merges into \`${config.baseBranch}\`.`
          : `Removes \`${name}\` from \`loops\` in \`.ralph/config.json\`.\n\nIts worktree was deleted from the dashboard.`,
    },
    text,
  );

/* ------------------------------------------------------- readiness */

/**
 * A new agent's readiness: the steps of `adding-an-agent.md` the dashboard can
 * check for itself, so the four that were missed when `testo` failed to start
 * on 2026-09-28 are visible on its card before Start is pressed rather than in
 * a refusal afterwards.
 *
 * Three properties hold across all of it:
 *
 * 1. **Nothing here is a blocker.** Every item is read-only and advisory: the
 *    gate a Start is actually refused by is `preflight`'s, and these only say
 *    in advance what it will find.
 * 2. **A command that could not run reads `unknown`, never `fail`.** A failed
 *    read says nothing about the agent, and an operator shown `fail` would go
 *    looking for a step they had not missed. One item's failure never fails
 *    another, and one agent's never touches another agent's.
 * 3. **The role is read, never defaulted.** Three items depend on it, and a
 *    triager checked against a coder's labels would read as ready and then be
 *    denied by preflight with nothing saying why.
 */
const ITEM_LABELS: Record<ReadinessItemKey, string> = {
  "roster-pr": "roster PR merged",
  worktree: "worktree at the base branch",
  labels: "claim labels exist",
  lineup: "models.json has a loop block",
  jav: "Jav route exists",
  "node-modules": "node_modules present",
  preflight: "preflight verdict",
};

const item = (key: ReadinessItemKey, state: ReadinessState, reason: string): ReadinessItem => ({
  key,
  label: ITEM_LABELS[key],
  state,
  reason,
});

/**
 * The reads one `GET /api/agents` shares across every pending agent: the
 * project's labels and Jav's block for it. Both are per-project answers, and
 * asking them per agent would multiply a GitHub call and a process by the
 * number of cards on the page — the burst this project has already met.
 *
 * Read lazily and at most once: a page with no agent whose role needs labels
 * makes neither call.
 */
interface SharedReads {
  labels(): Promise<Read<string[]>>;
  jav(): Promise<Read<JavRoutes>>;
}

/** The project's label names alone: what Add agent and the labels item compare against. */
const labelNames = async (deps: AgentsDeps, repo: string): Promise<Read<string[]>> => {
  const listed = await deps.agents.listLabels(repo);
  return listed.ok ? { ok: true, value: listed.value.map((label) => label.name) } : listed;
};

const sharedReads = (deps: AgentsDeps, config: AgentProjectConfig): SharedReads => {
  let labels: Promise<Read<string[]>> | null = null;
  let jav: Promise<Read<JavRoutes>> | null = null;
  return {
    labels: () => (labels ??= labelNames(deps, config.repo)),
    jav: () => (jav ??= deps.agents.jav()),
  };
};

/**
 * The role the roster gives `name`: the base branch's roster for an agent
 * already on it, and the roster PR's own branch for one whose PR is still open
 * — which is the whole point of the ticket, since an agent's labels are worth
 * checking while its PR is open and not only afterwards.
 *
 * `origin/<pr.branch>` is read without fetching, as every read on this route
 * is: the dashboard pushed that branch itself, so the ref is local, and a
 * branch pushed from elsewhere reads as unknown rather than as wrong.
 */
async function roleOf(
  deps: AgentsDeps,
  config: AgentProjectConfig,
  agent: { name: string; status: PendingAgentView["status"]; pr: RosterPrView | null },
  base: Read<AgentProjectConfig>,
): Promise<{ role: LoopRole | null; why: string }> {
  const fromRoster = (read: Read<AgentProjectConfig>, where: string): { role: LoopRole | null; why: string } => {
    if (!read.ok) return { role: null, why: `the roster on ${where} could not be read: ${read.why}` };
    if (read.value.roster === null) {
      return { role: null, why: `the roster on ${where} could not be narrowed: ${read.value.rosterWhy ?? "unknown"}` };
    }
    const entry = read.value.roster.find((listed) => listed.name === agent.name);
    return entry === undefined
      ? { role: null, why: `${where} has no roster entry for ${agent.name}` }
      : { role: entry.role, why: `its role is ${entry.role}, from the roster on ${where}` };
  };
  if (agent.status === "ready") return fromRoster(base, baseRef(config));
  if (agent.pr === null) {
    return { role: null, why: `no roster PR for ${agent.name} could be found, so its role cannot be read anywhere` };
  }
  const ref = `origin/${agent.pr.branch}`;
  return fromRoster(await readConfig(deps, { ref }), ref);
}

/** Step 3: is the agent's name on the base branch's roster yet? */
const rosterPrItem = (agent: { status: PendingAgentView["status"]; pr: RosterPrView | null }, base: string): ReadinessItem => {
  if (agent.status === "ready") return item("roster-pr", "pass", `${base} lists it in 'loops'`);
  if (agent.pr === null) {
    return item("roster-pr", "fail", `${base} does not list it and no roster PR was found; Add agent opens one`);
  }
  return item(
    "roster-pr",
    "fail",
    agent.pr.state === "closed"
      ? `its roster PR was closed unmerged (${agent.pr.url}); it needs a new one`
      : `its roster PR is ${agent.pr.state} (${agent.pr.url}); Start stays refused until it merges into ${base}`,
  );
};

/**
 * Step 5: is the worktree AT the base branch, not merely behind it?
 *
 * An exact comparison of two `git rev-parse` reads. `merge-base --is-ancestor`
 * would not do: it exits 0 for "behind or equal", so a worktree left on a
 * stale commit after the roster PR merged — which is how `testo` came to run
 * with a config that lacked a required check — would read as a pass.
 */
async function worktreeItem(deps: AgentsDeps, worktree: string, base: string): Promise<ReadinessItem> {
  const { agents } = deps;
  const head = await agents.revParse(worktree, "HEAD");
  if (!head.ok) return item("worktree", "unknown", `its HEAD could not be read: ${head.why}`);
  const want = await agents.revParse(worktree, base);
  if (!want.ok) return item("worktree", "unknown", `${base} could not be read in the worktree: ${want.why}`);
  // No fetch is made on this route, so the comparison is against the base ref
  // as last fetched — by a running loop, or by the last Start.
  const against = `compared against ${base} as last fetched; this route runs no git fetch`;
  return head.value === want.value
    ? item("worktree", "pass", `its HEAD is ${base} (${head.value.slice(0, 7)}); ${against}`)
    : item(
        "worktree",
        "fail",
        `its HEAD is ${head.value.slice(0, 7)}, not ${base} (${want.value.slice(0, 7)}); ${against}. ` +
          "Start moves a ready agent's checkout up to the base branch first, so this is a warning, not a blocker",
      );
}

/** Step 6: does the project have every claim label this agent's ROLE requires? */
async function labelsItem(
  deps: AgentsDeps,
  shared: SharedReads,
  name: string,
  role: LoopRole,
): Promise<ReadinessItem> {
  const { agents } = deps;
  // `preflight.ts --labels` owns which labels a role needs, as Add agent's own
  // label creation does, so the card and the `loop-labels` check can never
  // disagree about what a start requires.
  const wanted = await agents.labels(name, role);
  if (!wanted.ok) return item("labels", "unknown", `the labels a ${role} needs could not be worked out: ${wanted.why}`);
  const existing = await shared.labels();
  if (!existing.ok) return item("labels", "unknown", `the project's labels could not be read: ${existing.why}`);
  // GitHub label names are unique case-insensitively, so the comparison is too.
  const have = new Set(existing.value.map((label) => label.toLowerCase()));
  const missing = wanted.value.filter((label) => !have.has(label.toLowerCase()));
  return missing.length === 0
    ? item("labels", "pass", `the project has all ${wanted.value.length} labels a ${role} needs`)
    : item(
        "labels",
        "fail",
        `the project has no ${missing.join(", ")} label, so preflight's loop-labels check will refuse the start`,
      );
}

/** Step 7: does `models.json` hold a block for this loop, or does it fall back? */
async function lineupItem(deps: AgentsDeps, name: string, role: LoopRole): Promise<ReadinessItem> {
  const { agents } = deps;
  const lineup = await agents.models(name, role);
  if (!lineup.ok) return item("lineup", "unknown", `its lineup could not be resolved: ${lineup.why}`);
  return lineup.value.source === "loop"
    ? item("lineup", "pass", "models.json holds a block of its own")
    : item(
        "lineup",
        "fail",
        `models.json holds no block for it: its orchestrator falls back to the '${lineup.value.source}' block`,
      );
}

/**
 * Step 8: has the loop a Jav route?
 *
 * Only when Jav is on for the project AND the role takes frontier work — a
 * triager or a ci-doctor is offered no route and `jav.ts` refuses one, so for
 * those the item is absent rather than failing over something that cannot be
 * done. `routes.default` counts: a coder without a route of its own falls back
 * to it, and a project with one is routed.
 */
async function javItem(deps: AgentsDeps, shared: SharedReads, name: string, role: LoopRole): Promise<ReadinessItem | null> {
  if (!javRoutedRoles.includes(role)) return null;
  const jav = await shared.jav();
  if (!jav.ok) return item("jav", "unknown", `Jav's config could not be read: ${jav.why}`);
  if (!jav.value.enabled) return null;
  // A route with no labels in it is not a route: Jav's own gate would hand the
  // loop nothing, which is the failure this item is about.
  const own = jav.value.routes[name]?.length ?? 0;
  const fallback = jav.value.routes.default?.length ?? 0;
  if (own > 0) return item("jav", "pass", `jav.json routes it on ${jav.value.routes[name]!.join(", ")}`);
  if (fallback > 0) {
    return item("jav", "pass", `jav.json has no route of its own for it; it falls back to 'default' (${jav.value.routes.default!.join(", ")})`);
  }
  return item("jav", "fail", "Jav is on for this project but routes neither it nor 'default', so its gate would find nothing");
}

/**
 * Step 9: are the worktree's dependencies installed? When the config names
 * steps that install them (#694), their recorded run is the answer: a
 * `node_modules` left by a failed install is no proof the install finished,
 * and the setup is what the operator re-runs. Without such a step, the
 * directory's presence is all there is to read.
 */
function nodeModulesItem(deps: AgentsDeps, config: AgentProjectConfig, worktree: string): ReadinessItem {
  const installs = config.worktreeSetup.filter((step) => step.installsDependencies);
  if (installs.length === 0) {
    return deps.agents.hasNodeModules(worktree)
      ? item("node-modules", "pass", "node_modules is in its worktree")
      : item("node-modules", "fail", "no node_modules in its worktree: run bun install there, or its first iteration's gates fail");
  }
  const record = deps.agents.readWorktreeSetup(worktree);
  for (const step of installs) {
    const ran = record?.steps.find((entry) => entry.name === step.name);
    if (ran === undefined) {
      return item("node-modules", "fail", `setup step '${step.name}' has not run in this worktree: use Rerun setup, or its first iteration's gates fail`);
    }
    if (ran.state !== "passed") {
      return item("node-modules", "fail", `setup step '${step.name}' ${stepState(ran)} on its last run: use Rerun setup, or its first iteration's gates fail`);
    }
  }
  const names = installs.map((step) => `'${step.name}'`).join(", ");
  return item("node-modules", "pass", `setup step${installs.length === 1 ? "" : "s"} ${names} installed its dependencies`);
}

/**
 * One agent's readiness, minus the preflight item, which has a route of its
 * own (`agentPreflight`).
 *
 * Every item is reached whatever the ones before it answered: the card's job is
 * to show the whole checklist, and an operator who can see only the first
 * failure learns one step per Start.
 */
async function readinessFor(
  deps: AgentsDeps,
  config: AgentProjectConfig,
  shared: SharedReads,
  agent: { name: string; worktree: string; status: PendingAgentView["status"]; pr: RosterPrView | null },
  base: Read<AgentProjectConfig>,
): Promise<{ role: LoopRole | null; readiness: ReadinessItem[] }> {
  const ref = baseRef(config);
  const { role, why } = await roleOf(deps, config, agent, base);
  const roleUnknown = (key: ReadinessItemKey): ReadinessItem =>
    item(key, "unknown", `its role could not be read, and this check is the role's: ${why}`);
  const items: (ReadinessItem | null)[] = [
    rosterPrItem(agent, ref),
    await worktreeItem(deps, agent.worktree, ref),
    role === null ? roleUnknown("labels") : await labelsItem(deps, shared, agent.name, role),
    role === null ? roleUnknown("lineup") : await lineupItem(deps, agent.name, role),
    // The Jav item is absent, not `unknown`, when the role could not be read:
    // whether it APPLIES is the role's answer, and a line saying "Jav route —
    // unknown" on a project with Jav off describes a step that does not exist.
    // The two items above already say the role could not be read.
    role === null ? null : await javItem(deps, shared, agent.name, role),
    nodeModulesItem(deps, config, agent.worktree),
  ];
  const order = (entry: ReadinessItem): number => READINESS_ITEMS.indexOf(entry.key);
  return {
    role,
    readiness: items.filter((entry): entry is ReadinessItem => entry !== null).sort((a, b) => order(a) - order(b)),
  };
}

/** One pending agent, located cheaply: enough to run its preflight, and no more. */
export interface PendingAgentLocation {
  name: string;
  worktree: string;
  status: PendingAgentView["status"];
}

/**
 * Find one pending agent by name, with the cheap reads alone.
 *
 * The preflight route needs a worktree and a standing, not a page: running the
 * whole readiness fold to resolve one path would put that fold's `gh label
 * list` and its three process starts in front of every "Check preflight"
 * press, which is the cost the route exists to keep off the poll. So this asks
 * the same two questions `listPendingAgents` builds its candidates from — the
 * worktree list and each worktree's `loop-name` — plus the base roster for the
 * standing. No `gh`, and no fetch.
 */
export async function locatePendingAgent(deps: AgentsDeps, name: string): Promise<Read<PendingAgentLocation>> {
  const { agents } = deps;
  const config = await readConfig(deps);
  if (!config.ok) return { ok: false, why: `cannot read the project config: ${config.why}` };
  const listed = await agents.listWorktrees();
  if (!listed.ok) return { ok: false, why: `cannot list the project's worktrees: ${listed.why}` };
  const found = listed.value.find(({ path }) => agents.readLoopName(path) === name);
  if (found === undefined || config.value.loops.includes(name)) {
    return { ok: false, why: `no new agent '${name}'` };
  }
  const base = await readConfig(deps, { ref: baseRef(config.value) });
  return {
    ok: true,
    value: { name, worktree: found.path, status: base.ok && base.value.loops.includes(name) ? "ready" : "pending-merge" },
  };
}

/**
 * Step 11, on a route of its own: the loop's own `preflight.ts --json` verdict,
 * run in its worktree.
 *
 * It is not part of `GET /api/agents` because the page polls that every five
 * seconds while preflight runs `gh auth status`, a `gh label list` of its own
 * and `doppler secrets` — three network calls per agent per poll, plus a
 * `gh label create` for a missing label in `roles.ts`'s `CREATED_LABELS`. The card asks
 * for this one when an operator wants it.
 *
 * `denied` is a `fail` naming the check that denied it, `unavailable` is
 * `unknown` (preflight could not judge, which is not the agent's fault), and a
 * preflight that could not be asked at all reports that no verdict is
 * available. Its non-zero exit is not a failure here: preflight exits 1 on
 * `denied` and 2 on `unavailable` by design.
 */
export async function agentPreflight(deps: AgentsDeps, agent: PendingAgentLocation): Promise<AgentPreflightView> {
  const { agents } = deps;
  const { name, worktree } = agent;
  // A pending-merge agent cannot be judged, and saying so is the answer. Its
  // worktree's config does not list it yet, and `resolveLoopName` accepts only
  // a name already on that roster, so preflight would deny on identity — a
  // `fail` that says nothing about the agent and everything about the clock.
  if (agent.status === "pending-merge") {
    return {
      name,
      item: item(
        "preflight",
        "unknown",
        `no verdict is available until its roster PR merges: preflight resolves a loop name only against the roster ` +
          `its worktree's own config holds, and that config does not list ${name} yet`,
      ),
    };
  }
  const read = await agents.preflight(worktree, name);
  if (!read.ok) return { name, item: item("preflight", "unknown", `no verdict is available: ${read.why}`) };
  switch (read.value.verdict) {
    case "ready":
      return { name, item: item("preflight", "pass", "preflight is ready: every local requirement is met") };
    case "denied":
      return {
        name,
        item: item(
          "preflight",
          "fail",
          read.value.denied.length === 0
            ? "preflight denies the start; run it in the worktree for the check that refused"
            : `preflight denies the start: ${read.value.denied.join(", ")}`,
        ),
      };
    case "unavailable":
      return { name, item: item("preflight", "unknown", "preflight could not judge: something it reads was unavailable") };
  }
}

/**
 * The guide the Add-agent panel renders, and what its Loggd examples stand for
 * on this project. The file's own bytes: the dashboard holds no second copy of
 * its steps or of either of its tables.
 */
export async function agentGuide(deps: AgentsDeps): Promise<GuideView> {
  const { agents } = deps;
  const guide = agents.readGuide();
  const config = await readConfig(deps);
  const problems = [...(guide.ok ? [] : [guide.why]), ...(config.ok ? [] : [`the project config could not be read: ${config.why}`])];
  return {
    markdown: guide.ok ? guide.value : "",
    values: config.ok
      ? {
          project: agents.project,
          repo: config.value.repo,
          baseBranch: config.value.baseBranch,
          root: agents.root,
          worktrees: agents.worktreesDir(),
        }
      : null,
    problem: problems.length === 0 ? null : problems.join("; "),
  };
}

/**
 * The project's agents whose names its roster does not list yet: worktrees
 * whose `loop-name` is outside the main checkout's `loops`. Each reads as
 * `ready` once `origin/<baseBranch>` names it, else `pending-merge`, with the
 * PR that adds it. A `ready` agent whose supervisor is alive has been started
 * and is left out, even while the main checkout sits on a branch that predates
 * its roster entry. The base branch is as last fetched — every running loop
 * fetches it each iteration, and a Start fetches first — except when GitHub
 * calls an agent's roster PR merged and that ref does not list it yet: then
 * it is fetched once and read again, since on a project with no loop running
 * nothing else would, and the card would wait on a merge already made. A
 * fetch moves only `origin/<baseBranch>`; no checkout is touched.
 */
export async function listPendingAgents(deps: AgentsDeps): Promise<AgentsView> {
  const { agents } = deps;
  const answer = (fields: Partial<AgentsView>): AgentsView => ({
    project: agents.project,
    baseBranch: null,
    pending: [],
    problem: null,
    ...fields,
  });
  const config = await readConfig(deps);
  if (!config.ok) return answer({ problem: `cannot read the project config: ${config.why}` });
  const listed = await agents.listWorktrees();
  if (!listed.ok) return answer({ baseBranch: config.value.baseBranch, problem: `cannot list the project's worktrees: ${listed.why}` });
  const candidates = listed.value.flatMap(({ path }) => {
    const name = agents.readLoopName(path);
    return name !== null && !config.value.loops.includes(name) ? [{ name, worktree: path }] : [];
  });
  if (candidates.length === 0) return answer({ baseBranch: config.value.baseBranch });
  let base = await readConfig(deps, { ref: baseRef(config.value) });
  const onBase = (name: string): boolean => base.ok && base.value.loops.includes(name);
  // The PRs of the agents the base does not list yet, read before the base is
  // trusted: one GitHub calls merged means that ref is behind, so fetch it.
  const waiting = new Map<string, RosterPrView | null>();
  for (const { name } of candidates) {
    if (!onBase(name)) waiting.set(name, await findPr(deps, config.value.repo, "add", name));
  }
  if ([...waiting.values()].some((pr) => pr?.state === "merged")) {
    // A failed fetch keeps the read already made: the card says pending, as before.
    const fresh = await readBaseConfig(deps, config.value);
    if (fresh.ok) base = fresh;
  }
  // A merged agent whose supervisor is alive has been started: the card's job
  // is done, however far behind the main checkout's own branch is.
  const supervisors = candidates.some(({ name }) => onBase(name))
    ? await deps.agents.supervisors()
    : null;
  const alive = (worktree: string): boolean =>
    supervisors?.ok === true &&
    supervisors.value.some((entry) => entry.liveness === "alive" && samePath(entry.worktree, worktree));
  const pending: PendingAgentView[] = [];
  const shared = sharedReads(deps, config.value);
  for (const candidate of candidates) {
    if (onBase(candidate.name) && alive(candidate.worktree)) continue;
    const agent = {
      ...candidate,
      status: onBase(candidate.name) ? ("ready" as const) : ("pending-merge" as const),
      pr: waiting.has(candidate.name) ? waiting.get(candidate.name)! : await findPr(deps, config.value.repo, "add", candidate.name),
    };
    // Readiness is a fold over reads that each degrade on their own, so one
    // agent whose every command fails still leaves the other cards complete.
    pending.push({ ...agent, ...(await readinessFor(deps, config.value, shared, agent, base)) });
  }
  return answer({
    baseBranch: config.value.baseBranch,
    pending,
    problem: base.ok ? null : `cannot read the roster on ${baseRef(config.value)}: ${base.why}`,
  });
}

/**
 * Every label the project's roster needs, which loops need each, and whether
 * the repository has it — then the repository's other labels, needed by no
 * loop. Read-only, like `listPendingAgents`: it asks `preflight --labels` per
 * roster loop, adds the frontier's labels to each coder's, and asks `gh label
 * list` once. It creates nothing.
 *
 * A read that fails is reported in `problems` and the rest still answers: a
 * loop whose labels cannot be worked out drops out of `usedBy`, and a
 * repository that cannot be read leaves every `onRepo` null rather than
 * painting every label missing.
 */
export async function listProjectLabels(deps: AgentsDeps): Promise<LabelsView> {
  const { agents } = deps;
  const config = await readConfig(deps);
  if (!config.ok) {
    return { project: agents.project, repo: null, labels: [], problems: [`cannot read the project config: ${config.why}`] };
  }
  const { repo, roster, rosterWhy } = config.value;
  const problems: string[] = [];
  if (roster === null) problems.push(`cannot read the project's roster: ${rosterWhy ?? "unknown"}`);
  // One `bun` each, all at once: a roster is a handful of loops, and the page
  // should not wait for them in turn.
  const [needs, existing] = await Promise.all([
    Promise.all(
      (roster ?? []).map(async (entry) => ({
        entry,
        labels: await agents.labels(entry.name, entry.role),
      })),
    ),
    agents.listLabels(repo),
  ]);
  if (!existing.ok) problems.push(`cannot read ${repo}'s labels: ${existing.why}`);
  else if (existing.value.length >= LABEL_LIST_LIMIT) {
    problems.push(`${repo} has at least ${LABEL_LIST_LIMIT} labels and only that many were read: a label past them reads as missing here`);
  }
  // GitHub label names are unique case-insensitively, so every key here is too.
  const onRepo = new Map((existing.ok ? existing.value : []).map((label) => [label.name.toLowerCase(), label]));
  const byName = new Map<string, ProjectLabelView>();
  for (const { entry, labels } of needs) {
    if (!labels.ok) {
      problems.push(`cannot work out ${entry.name}'s labels: ${labels.why}`);
      continue;
    }
    const user: LabelUserView = { loop: entry.name, role: entry.role };
    // A coder's frontier reads labels its preflight does not require.
    const names = entry.role === "coder" ? [...labels.value, ...CODER_FRONTIER_LABELS] : labels.value;
    for (const name of names) {
      const key = name.toLowerCase();
      const known = byName.get(key);
      if (known !== undefined) {
        // Once per loop, however many of its sources name the label.
        if (!known.usedBy.some((other) => other.loop === user.loop)) known.usedBy.push(user);
        continue;
      }
      const repoLabel = onRepo.get(key);
      byName.set(key, {
        name,
        usedBy: [user],
        onRepo: existing.ok ? repoLabel !== undefined : null,
        color: repoLabel?.color ?? null,
        description: repoLabel?.description ?? null,
      });
    }
  }
  const unused = [...onRepo.entries()]
    .filter(([key]) => !byName.has(key))
    .map(([, label]): ProjectLabelView => ({ ...label, usedBy: [], onRepo: true }));
  return { project: agents.project, repo, labels: [...byName.values(), ...unused], problems };
}

/**
 * Create the labels a new agent needs that the project does not have: its own
 * `-wip`/`-blocked`/`-done` triple, plus whatever vocabulary its role declares.
 * `preflight.ts --labels` is asked for the set rather than deriving it here, so
 * the flow and the `loop-labels` check can never disagree about what a start
 * requires.
 *
 * Reported, never fatal: the agent's worktree and roster PR are the point of
 * Add agent, and a label that could not be created is something the preflight
 * will name again with a remedy. Labels the project already has are left alone,
 * which is what makes re-adding a deleted agent work.
 */
async function createLabels(
  deps: AgentsDeps,
  config: AgentProjectConfig,
  name: string,
  role: LoopRole,
): Promise<string | null> {
  const { agents } = deps;
  const wanted = await agents.labels(name, role);
  if (!wanted.ok) return `its labels could not be worked out: ${wanted.why}`;
  const existing = await labelNames(deps, config.repo);
  if (!existing.ok) return `the project's labels could not be read: ${existing.why}`;
  // GitHub label names are unique case-insensitively, so the comparison is too.
  const have = new Set(existing.value.map((label) => label.toLowerCase()));
  const failed: string[] = [];
  for (const label of wanted.value) {
    if (have.has(label.toLowerCase())) continue;
    const created = await agents.createLabel(config.repo, label);
    if (!created.ok) failed.push(label);
  }
  return failed.length === 0 ? null : `these labels could not be created: ${failed.join(", ")}`;
}

/**
 * Whether a worktree for `name` already exists: its path is taken, or some
 * worktree already carries that `loop-name`. Both paths that make a worktree
 * ask this first, so neither can give one loop a second checkout.
 */
async function worktreeClash(deps: AgentsDeps, name: string, worktree: string): Promise<Read<null>> {
  const { agents } = deps;
  const listed = await agents.listWorktrees();
  if (!listed.ok) return { ok: false, why: `cannot list the project's worktrees: ${listed.why}` };
  const clash = listed.value.find(({ path }) => samePath(path, worktree) || agents.readLoopName(path) === name);
  return clash === undefined ? { ok: true, value: null } : { ok: false, why: `the worktree at ${clash.path} is already ${name}` };
}

/**
 * Where `makeWorktree` stopped. The distinction is the one the callers' answers
 * turn on: a worktree that exists must never be reported as a refusal, because
 * a refusal is what tells the operator nothing was created.
 */
type Made =
  | { ok: true; setup: WorktreeSetupRecord | null }
  | { ok: false; stopped: "add" | "provision"; why: string }
  | { ok: false; stopped: "setup"; why: string; setup: WorktreeSetupRecord };

/** A setup step's recorded state, as a clause: "failed with exit code 1", "timed out after 120s". */
function stepState(step: WorktreeSetupStepView): string {
  switch (step.state) {
    case "passed":
      return "passed";
    case "skipped":
      return "was skipped";
    case "timeout":
      return `timed out after ${Math.round(step.limitMs / 1000)}s`;
    case "failed":
      if (step.error !== null) return `could not start (${step.error})`;
      return step.exitCode === null ? "was killed by a signal" : `failed with exit code ${step.exitCode}`;
  }
}

/** The last lines of a step's output, joined on one line: enough to name the error, short enough for a `why`. */
function outputTail(output: string, lines = 5): string {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .slice(-lines)
    .join(" / ");
}

/** The first step of `record` that did not pass, or null when every one did. */
const failedStep = (record: WorktreeSetupRecord): WorktreeSetupStepView | null =>
  record.steps.find((step) => step.state !== "passed") ?? null;

/** Why a setup did not pass: the step, its state, its output's last lines. */
function setupWhy(step: WorktreeSetupStepView): string {
  const tail = outputTail(step.output);
  return `setup step '${step.name}' ${stepState(step)}` + (tail === "" ? "" : ` (${tail})`);
}

/**
 * Run the setup steps, never throwing: an adapter that rejects is reported as
 * a first step that could not start and the rest skipped, the same shape as a
 * run that stopped there, so the callers keep the worktree and say so.
 */
async function runSetup(deps: AgentsDeps, worktree: string, steps: readonly WorktreeSetupStepConfig[]): Promise<WorktreeSetupRecord> {
  const ranAt = new Date().toISOString();
  try {
    return await deps.agents.runWorktreeSetup(worktree, steps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ranAt,
      steps: steps.map((step, index) => ({
        name: step.name,
        command: step.command,
        state: index === 0 ? "failed" : "skipped",
        durationMs: null,
        exitCode: null,
        output: "",
        truncated: false,
        limitMs: step.timeoutSeconds * 1000,
        error: index === 0 ? message : null,
      })),
    };
  }
}

/**
 * Make a loop's checkout: the worktree detached at `ref`, then provisioned.
 * The one function both Add agent and Create checkout create a worktree
 * through, so a checkout made from the roster is identical to an added
 * agent's — the same path, the same ref, the same `loop-name` and log
 * directory. `made` separates a refusal that left nothing behind from a
 * worktree that exists but needs a hand.
 */
async function makeWorktree(
  deps: AgentsDeps,
  name: string,
  worktree: string,
  ref: string,
  steps: readonly WorktreeSetupStepConfig[],
): Promise<Made> {
  const added = await deps.agents.addWorktree(worktree, ref);
  if (!added.ok) {
    return { ok: false, stopped: "add", why: `git worktree add failed: ${added.why}` };
  }
  try {
    deps.agents.provisionWorktree(worktree, name);
  } catch (error) {
    return {
      ok: false,
      stopped: "provision",
      // Not "its loop-name could not be written": provisioning makes two
      // directories before that write, and an EACCES on either would be
      // reported as a failure of a step that was never reached.
      why: `its checkout could not be provisioned: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // No steps, no call: a project without `worktreeSetup` makes its worktrees
  // exactly as before. A step that did not pass leaves the worktree where it
  // is — removing it would throw away the output the operator needs, and
  // Rerun setup re-runs the steps in place.
  if (steps.length === 0) return { ok: true, setup: null };
  const setup = await runSetup(deps, worktree, steps);
  const failed = failedStep(setup);
  if (failed === null) return { ok: true, setup };
  return {
    ok: false,
    stopped: "setup",
    setup,
    why: `${setupWhy(failed)}; the worktree is kept, and Rerun setup re-runs the steps`,
  };
}

/**
 * Add an agent: validate the name against the roster rules as the base branch
 * holds them, make its worktree from the base branch, write its `loop-name`,
 * and open the PR adding it to `loops`.
 *
 * The role is the roster entry's, defaulting to `coder` so a request that
 * names none behaves exactly as it did before roles.
 */
export async function addAgent(deps: AgentsDeps, request: { name: string; role?: LoopRole }): Promise<AddAgentResult> {
  const { agents } = deps;
  const { name, role = "coder" } = request;
  const worktree = agents.worktreeFor(name);
  const refused = (reason: string): AddAgentResult => ({
    name,
    worktree,
    outcome: "refused",
    status: null,
    pr: null,
    labels: null,
    setup: null,
    why: reason,
  });

  const config = await readConfig(deps);
  if (!config.ok) return refused(`cannot read the project config: ${config.why}`);
  const clash = await worktreeClash(deps, name, worktree);
  if (!clash.ok) return refused(clash.why);

  const fetched = await agents.fetch(config.value.baseBranch);
  if (!fetched.ok) return refused(`could not fetch ${baseRef(config.value)}: ${fetched.why}`);
  const edited = await agents.editRoster("add", name, baseRef(config.value), role);
  if (!edited.ok) return refused(edited.why);
  // An old roster branch would reject the push only after the worktree exists.
  const branch = agents.branchFor("add", name);
  const stale = await agents.remoteBranch(branch);
  if (!stale.ok) return refused(`cannot tell whether origin has ${branch}: ${stale.why}`);
  if (stale.value) return refused(`origin already has ${branch}; delete that branch (or merge or close its PR) first`);

  const partial = (reason: string, labels: string | null, setup: WorktreeSetupRecord | null = null, setupNote: string | null = null): AddAgentResult => ({
    name,
    worktree,
    outcome: "pr-failed",
    status: "pending-merge",
    pr: null,
    labels,
    setup,
    why:
      `the worktree is at ${worktree}, but ${reason}` +
      (labels === null ? "" : `. Its labels also need a hand: ${labels}`) +
      (setupNote === null ? "" : `. Its setup also needs a hand: ${setupNote}`),
  });
  const made = await makeWorktree(deps, name, worktree, baseRef(config.value), config.value.worktreeSetup);
  if (!made.ok && made.stopped !== "setup") return made.stopped === "provision" ? partial(made.why, null) : refused(made.why);
  // A setup step that did not pass does not stop Add agent: the worktree is
  // the agent's whatever its dependencies, and the roster PR does not depend
  // on them. So the labels and the PR go ahead, `outcome` stays what the PR
  // makes it (`added`, or the `pr-failed` partial), and the failure rides in
  // `why` and `setup` — readiness keeps Start's checklist red until a rerun.
  const setup = made.setup;
  const setupNote = made.ok ? null : made.why;
  // Before the PR, because the labels are the new loop's own and a PR that
  // could not be opened is no reason to leave them uncreated.
  const labels = await createLabels(deps, config.value, name, role);
  const pr = await openRosterPr(deps, config.value, "add", name, edited.value);
  if (!pr.ok) return partial(`the roster PR was not opened: ${pr.why}`, labels, setup, setupNote);
  return {
    name,
    worktree,
    outcome: "added",
    status: "pending-merge",
    pr: pr.value,
    labels,
    setup,
    why:
      `${name} is at ${worktree}; Start unlocks once ${pr.value.url} merges into ${config.value.baseBranch}` +
      (labels === null ? "" : `. Its labels need a hand: ${labels}`) +
      (setupNote === null ? "" : `. Its setup needs a hand: ${setupNote}`),
  };
}

/* ------------------------------------------------------- rules saves */

/** One rule a save changes, as its commit names it: `revert.minEvents`, never the nested object. */
export interface RuleChange {
  key: string;
  from: unknown;
  to: unknown;
}

/** A rule's value as a commit message spells it: `observe`, `24`, `[1, 6, 24]`. */
const ruleWord = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map(ruleWord).join(", ")}]` : typeof value === "string" ? value : JSON.stringify(value);

/**
 * The rules that differ, in `keys`' order. Both sides have their defaults
 * filled first, so writing out a value the block left to its default is no
 * change, and leaving out one it spelled as the default is none either.
 */
const ruleChanges = (keys: readonly string[], before: Record<string, unknown>, after: Record<string, unknown>): RuleChange[] =>
  keys
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => ({ key, from: before[key], to: after[key] }));

/** The sentinel rules a save changes, against the base branch's block. */
export const sentinelChanges = (before: SentinelRulesView | null, after: SentinelRules): RuleChange[] =>
  ruleChanges(SENTINEL_RULE_KEYS, { ...SENTINEL_RULE_DEFAULTS, ...before }, { ...SENTINEL_RULE_DEFAULTS, ...after });

/** The verifier's rules flattened, so a nested rule is named by its own path. */
const flatVerifier = (rules: VerifierRulesView | null): Record<string, unknown> => {
  const full = {
    ...VERIFIER_RULE_DEFAULTS,
    ...rules,
    revert: { ...VERIFIER_RULE_DEFAULTS.revert, ...rules?.revert },
    follow: { ...VERIFIER_RULE_DEFAULTS.follow, ...rules?.follow },
  };
  const { revert, follow, ...top } = full;
  return {
    ...top,
    ...Object.fromEntries(Object.entries(revert).map(([key, value]) => [`revert.${key}`, value])),
    ...Object.fromEntries(Object.entries(follow).map(([key, value]) => [`follow.${key}`, value])),
  };
};
const VERIFIER_CHANGE_KEYS = Object.keys(flatVerifier(null));

/** The verifier rules a save changes, against the base branch's block. */
export const verifierChanges = (before: VerifierRulesView | null, after: VerifierRules): RuleChange[] =>
  ruleChanges(VERIFIER_CHANGE_KEYS, flatVerifier(before), flatVerifier(after));

/**
 * A direct rules commit's message. Its subject names what changed, so the
 * base branch's log reads as a history of the rules: one change spelled out
 * (`ralph: sentinel rules — mode observe → file`), several by their keys.
 * The body lists every change either way.
 */
export function rulesCommitMessage(kind: "sentinel" | "verifier", changes: readonly RuleChange[]): { subject: string; message: string } {
  const spelled = (change: RuleChange): string => `${change.key} ${ruleWord(change.from)} → ${ruleWord(change.to)}`;
  const subject =
    changes.length === 1 ? `ralph: ${kind} rules — ${spelled(changes[0]!)}` : `ralph: ${kind} rules — ${joinWords(changes.map((change) => change.key))}`;
  const body = [
    `Saved from the dashboard's ${kind === "sentinel" ? "Sentinel" : "Verifier"} sheet. Changes only these \`${kind}\` rules in \`.ralph/config.json\`:`,
    "",
    ...changes.map((change) => `- ${spelled(change)}`),
  ].join("\n");
  return { subject, message: `${subject}\n\n${body}` };
}

/** What differs between the sentinel's and the verifier's save: everything else is `saveRules`. */
interface RulesKind {
  kind: "sentinel" | "verifier";
  /** The open rules PR, for the one-at-a-time refusal. */
  openPr(repo: string): Promise<Read<RosterPrView | null>>;
  /** A new rules PR's branch, unique per proposal. */
  branch(stamp: string): string;
  /** The config at `ref` with the rules replaced, validated by `project-config`. */
  edit(ref: string): Promise<Read<string>>;
  /** What the save changes against the base branch's config. */
  changes(base: AgentProjectConfig): RuleChange[];
  /** The PR's body, which says what it keeps. */
  prBody(baseBranch: string): string;
}

/**
 * Save new rules. Only the shape is judged here — the route has checked
 * `rules` is an object; whether the rules are good is `project-config`'s
 * answer, returned verbatim as a refusal so the form shows the validator's
 * own sentence.
 *
 * With `configChanges: "commit"` (the default) the validated config is
 * committed onto the freshly fetched `origin/<baseBranch>` and pushed to the
 * base branch itself, never forced: if anything moved the base since the
 * fetch, git refuses the push as a non-fast-forward rather than overwrite it.
 * A refused push — protection, a race, the network — is never the end of the
 * save: the same commit goes up as a rules PR, and the answer says why it is a
 * PR. With `"pr"`, it is a PR exactly as before #787.
 *
 * One rules PR at a time, wherever a PR is opened: two open ones would each
 * change the same block, and whichever merged second would silently undo the
 * first. Branches left behind by merged or closed PRs are no obstacle, since
 * each proposal pushes a branch of its own. A direct commit does not wait on
 * an open PR: it lands on the base the PR will have to merge into anyway.
 */
async function saveRules(deps: AgentsDeps, rules: RulesKind): Promise<RulesSaveResult> {
  // To the millisecond: two proposals in one second would otherwise share a branch.
  const now = new Date();
  const { agents } = deps;
  const { kind } = rules;
  const refused = (reason: string): RulesSaveResult => ({ outcome: "refused", why: reason });
  const prFailed = (reason: string): RulesSaveResult => ({ outcome: "pr-failed", why: `the ${kind} rules PR was not opened: ${reason}` });

  const config = await readConfig(deps);
  if (!config.ok) return refused(`cannot read the project config: ${config.why}`);
  const base = await readBaseConfig(deps, config.value);
  if (!base.ok) return refused(`cannot read the config on ${baseRef(config.value)}: ${base.why}`);
  /** Why a new rules PR may not be opened, or null when it may. */
  const prBlocked = async (): Promise<string | null> => {
    const open = await rules.openPr(base.value.repo);
    if (!open.ok) return `cannot tell whether a ${kind} rules PR is open: ${open.why}`;
    return open.value === null ? null : `a ${kind} rules PR is already open: ${open.value.url}; merge or close it first`;
  };
  const byPr = base.value.configChanges === "pr";
  if (byPr) {
    const blocked = await prBlocked();
    if (blocked !== null) return refused(blocked);
  }
  const edited = await rules.edit(baseRef(base.value));
  if (!edited.ok) return refused(edited.why);
  const pr: ConfigPr = {
    branch: rules.branch(now.toISOString().replace(/[-:.]/g, "")),
    title: `Ralph ${kind}: rules`,
    body: rules.prBody(base.value.baseBranch),
  };

  if (byPr) {
    const opened = await openConfigPr(deps, base.value, pr, edited.value);
    return opened.ok ? { outcome: "proposed", pr: opened.value } : prFailed(opened.why);
  }

  const changes = rules.changes(base.value);
  if (changes.length === 0) return refused(`nothing to save: these are already the ${kind} rules on ${baseRef(base.value)}`);
  const { subject, message } = rulesCommitMessage(kind, changes);
  const commit = await buildConfigCommit(deps, base.value, edited.value, message);
  if (!commit.ok) return refused(`the rules commit was not built: ${commit.why}`);
  const pushed = await agents.push(commit.value, base.value.baseBranch);
  if (pushed.ok) return { outcome: "committed", commit: { branch: base.value.baseBranch, sha: commit.value, subject } };

  // The fallback: the same commit, as a rules PR, saying why it is one.
  const notCommitted = pushed.why;
  const blocked = await prBlocked();
  if (blocked !== null) return refused(`could not commit to ${base.value.baseBranch} (${notCommitted}), and ${blocked}`);
  const opened = await pushConfigPr(
    deps,
    base.value,
    { ...pr, body: `${pr.body}\n\nOpened as a PR because the dashboard could not commit to \`${base.value.baseBranch}\` directly: ${notCommitted}.` },
    commit.value,
  );
  return opened.ok
    ? { outcome: "proposed", pr: opened.value, notCommitted }
    : prFailed(`could not commit to ${base.value.baseBranch} directly (${notCommitted}), and then ${opened.why}`);
}

/* ------------------------------------------------------- verifier rules */

/**
 * The verifier's rules as the base branch holds them — the file the verifier
 * reads — and the rules PR still open, if any. The checkout's own config may
 * be behind or ahead of that, so it is not read.
 */
export async function readVerifier(deps: AgentsDeps): Promise<Read<VerifierView>> {
  const config = await readConfig(deps);
  if (!config.ok) return { ok: false, why: `cannot read the project config: ${config.why}` };
  const base = await readBaseConfig(deps, config.value);
  if (!base.ok) return { ok: false, why: `cannot read the config on ${baseRef(config.value)}: ${base.why}` };
  // Only an open PR is pending: a merged one is already in `rules`, a closed
  // one proposes nothing. An unreadable list shows no banner; the proposal
  // itself refuses on it.
  const found = await deps.agents.verifierPr(base.value.repo);
  const pending = found.ok ? found.value : null;
  return {
    ok: true,
    value: {
      baseBranch: base.value.baseBranch,
      rostered: (base.value.roster ?? []).some((loop) => loop.role === "verifier"),
      configured: base.value.verifier !== null,
      rules: base.value.verifier,
      pending,
      configChanges: base.value.configChanges,
    },
  };
}

/** Save new verifier rules: a commit onto the base branch, or a PR (see `saveRules`). */
export function proposeVerifier(deps: AgentsDeps, rules: unknown): Promise<ProposeVerifierResult> {
  // `rules` is typed for the edit only: `project-config` refuses any key or value that is not a rule.
  const typed = rules as VerifierRules;
  return saveRules(deps, {
    kind: "verifier",
    openPr: (repo) => deps.agents.verifierPr(repo),
    branch: (stamp) => deps.agents.verifierBranch(stamp),
    edit: (ref) => deps.agents.editVerifier(typed, ref),
    changes: (base) => verifierChanges(base.verifier, typed),
    prBody: (baseBranch) =>
      "Changes only the `verifier` rules in `.ralph/config.json`; its production URL, deploy source and Sentry project are kept.\n\n" +
      `The verifier reads them once this merges into \`${baseBranch}\`.`,
  });
}

/* ------------------------------------------------------- sentinel rules */

/**
 * The Sentinel panel's read: the checkout's config, not the base branch's,
 * since the panel shows what the running sentinel does, and its issue store.
 * Never throws: a read that failed is `problem`, so the relayed snapshot
 * still carries the rules. Without a sentinel in the roster the CLI is not
 * run at all: there is no store to read, and no reason to run it for one.
 */
export async function sentinelPanel(deps: AgentsDeps): Promise<SentinelPanelView> {
  try {
    const config = await readConfig(deps);
    if (!config.ok) return { rostered: false, rules: null, issues: null, problem: `cannot read the project config: ${config.why}` };
    // An unreadable roster is not "no sentinel": say why, so the panel warns instead of vanishing.
    if (config.value.roster === null) {
      return { rostered: false, rules: null, issues: null, problem: `cannot read the project's roster: ${config.value.rosterWhy ?? "no reason was reported"}` };
    }
    const rostered = config.value.roster.some((loop) => loop.role === "sentinel");
    const block = config.value.sentinel;
    const rules: SentinelRules | null = block === null ? null : { ...SENTINEL_RULE_DEFAULTS, ...block };
    if (!rostered) return { rostered, rules, issues: null, problem: null };
    const issues = await deps.agents.sentinelIssues();
    return issues.ok ? { rostered, rules, issues: issues.value, problem: null } : { rostered, rules, issues: null, problem: issues.why };
  } catch (error) {
    return { rostered: false, rules: null, issues: null, problem: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The sentinel's rules as the base branch holds them and the rules PR still
 * open, if any — as `readVerifier`, and for the same reason.
 */
export async function readSentinel(deps: AgentsDeps): Promise<Read<SentinelView>> {
  const config = await readConfig(deps);
  if (!config.ok) return { ok: false, why: `cannot read the project config: ${config.why}` };
  const base = await readBaseConfig(deps, config.value);
  if (!base.ok) return { ok: false, why: `cannot read the config on ${baseRef(config.value)}: ${base.why}` };
  // As for the verifier: an unreadable PR list shows no banner, and the
  // proposal itself refuses on it.
  const found = await deps.agents.sentinelPr(base.value.repo);
  const pending = found.ok ? found.value : null;
  return {
    ok: true,
    value: {
      baseBranch: base.value.baseBranch,
      rostered: (base.value.roster ?? []).some((loop) => loop.role === "sentinel"),
      configured: base.value.sentinel !== null,
      rules: base.value.sentinel,
      pending,
      configChanges: base.value.configChanges,
    },
  };
}

/** Save new sentinel rules, as `proposeVerifier`: a commit onto the base branch, or a PR (see `saveRules`). */
export function proposeSentinel(deps: AgentsDeps, rules: unknown): Promise<ProposeSentinelResult> {
  // `rules` is typed for the edit only: `project-config` refuses any key or value that is not a rule.
  const typed = rules as SentinelRules;
  return saveRules(deps, {
    kind: "sentinel",
    openPr: (repo) => deps.agents.sentinelPr(repo),
    branch: (stamp) => deps.agents.sentinelBranch(stamp),
    edit: (ref) => deps.agents.editSentinel(typed, ref),
    changes: (base) => sentinelChanges(base.sentinel, typed),
    prBody: (baseBranch) =>
      "Changes only the `sentinel` rules in `.ralph/config.json`; its reporter and language are kept.\n\n" +
      `The sentinel reads them once this merges into \`${baseBranch}\`.`,
  });
}

/** The keys a settings edit changes, in the order its PR names them. */
const PROJECT_EDIT_ORDER = ["displayName", "baseBranch", "gates", "requiredChecks", "refuseFiles", "worktreeSetup"] as const;
const PROJECT_EDIT_WORDS: Record<(typeof PROJECT_EDIT_ORDER)[number], string> = {
  displayName: "display name",
  baseBranch: "base branch",
  gates: "gates",
  requiredChecks: "required checks",
  refuseFiles: "refused files",
  worktreeSetup: "worktree setup steps",
};
const changedProjectKeys = (changed: ProjectEdit): (typeof PROJECT_EDIT_ORDER)[number][] =>
  PROJECT_EDIT_ORDER.filter((key) => changed[key] !== undefined);

/** `a`, `a and b`, `a, b and c`: a PR title reads as a sentence. */
const joinWords = (words: string[]): string =>
  words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;

/** By value and order: a reordered list is a change, since gates run, and are exported, in that order. */
const sameList = <T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean): boolean =>
  a.length === b.length && a.every((entry, index) => same(entry, b[index]!));
const sameGate = (x: { name: string; command: string }, y: { name: string; command: string }): boolean =>
  x.name === y.name && x.command === y.command;
const sameStep = (x: WorktreeSetupStepConfig, y: WorktreeSetupStepConfig): boolean =>
  x.name === y.name && x.command === y.command && x.timeoutSeconds === y.timeoutSeconds && x.installsDependencies === y.installsDependencies;

/** A step without project-config's defaults, so a hand-written config is not rewritten with them. */
const compactStep = (step: WorktreeSetupStepConfig): WorktreeSetupStepEdit => ({
  name: step.name,
  command: step.command,
  ...(step.timeoutSeconds === SETUP_DEFAULT_TIMEOUT_SECONDS ? {} : { timeoutSeconds: step.timeoutSeconds }),
  ...(step.installsDependencies ? { installsDependencies: true } : {}),
});

/** The problems an edit's own `why` lists (`project-config`'s `  - ` lines), or the whole `why` as one when it lists none. */
const PROBLEM_LINE = "  - ";
const problemsOf = (why: string): string[] => {
  const listed = why
    .split("\n")
    .filter((line) => line.startsWith(PROBLEM_LINE))
    .map((line) => line.slice(PROBLEM_LINE.length));
  return listed.length > 0 ? listed : [why];
};

/**
 * The gate-name problems the config's name→command object cannot show: by
 * the time `project-config` sees it, an empty name is a key it may still
 * accept, and a repeated one has already been overwritten.
 */
export const gateNameProblems = (gates: readonly { name: string }[]): string[] => {
  const problems: string[] = [];
  gates.forEach((gate, index) => {
    if (gate.name.trim() === "") problems.push(`gate name ${index + 1} must not be empty`);
  });
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const { name } of gates) {
    if (name.trim() === "") continue;
    if (seen.has(name)) repeated.add(name);
    seen.add(name);
  }
  for (const name of repeated) problems.push(`gate name '${name}' is listed more than once`);
  return problems;
};

/**
 * Propose the project's settings — `displayName`, `baseBranch`, `gates`,
 * `requiredChecks` and `refuseFiles` — as a PR against the current base
 * branch, where the config lives. Like the verifier rules PR, nothing touches
 * a working tree: the edit is `project-config`'s, and the commit is built by
 * `openConfigPr`.
 *
 * Only the keys that differ from the base branch's config are proposed, so an
 * unchanged Save opens no empty PR. The change is named by a hash of exactly
 * those values and the base branch the PR targets, carried in the branch: a
 * second Save of the same change while its PR is open links that PR again
 * rather than opening a duplicate, and a different change (or the same one
 * after the base moved) gets a PR of its own.
 *
 * Unlike the verifier, which allows one rules PR at a time, two different
 * settings PRs may be open at once: each changes only its own keys from the
 * base, so merging the second conflicts on the same lines rather than
 * silently undoing the first.
 *
 * A refusal lists every problem at once — the gate names this side checks
 * and everything `project-config` refuses — so one Save shows the operator
 * the whole list rather than one problem per round trip.
 *
 * A new required check nothing has reported is a warning, not a refusal: a
 * check a repository has not run yet (a new workflow) is a legitimate name,
 * but a typo would hold every hand-off, so the operator is told either way.
 *
 * A new base branch must already exist on origin and carry a readable config,
 * since loops and PRs move to it once this merges and a loop reads its config
 * from there.
 */
export async function proposeProject(deps: AgentsDeps, values: ProjectEdit): Promise<ProposeProjectResult> {
  // To the millisecond: two proposals in one second would otherwise share a branch.
  const now = new Date();
  const { agents } = deps;
  const refused = (reason: string): ProposeProjectResult => ({ outcome: "refused", why: reason });

  const config = await readConfig(deps);
  if (!config.ok) return refused(`cannot read the project config: ${config.why}`);
  const base = await readBaseConfig(deps, config.value);
  if (!base.ok) return refused(`cannot read the config on ${baseRef(config.value)}: ${base.why}`);

  // Compared with the base branch, not the checkout: that is the file the PR changes.
  const same = (x: string, y: string): boolean => x === y;
  const changed: ProjectEdit = {};
  if (values.baseBranch !== undefined && values.baseBranch !== base.value.baseBranch) changed.baseBranch = values.baseBranch;
  if (values.displayName !== undefined && values.displayName !== base.value.displayName) changed.displayName = values.displayName;
  if (values.gates !== undefined && !sameList(values.gates, base.value.gates, sameGate)) changed.gates = values.gates;
  if (values.requiredChecks !== undefined && !sameList(values.requiredChecks, base.value.requiredChecks, same)) {
    changed.requiredChecks = values.requiredChecks;
  }
  if (values.refuseFiles !== undefined && !sameList(values.refuseFiles, base.value.refuseFiles, same)) changed.refuseFiles = values.refuseFiles;
  // An empty list is a change too: it clears the steps.
  if (values.worktreeSetup !== undefined && !sameList(values.worktreeSetup, base.value.worktreeSetup, sameStep)) {
    changed.worktreeSetup = values.worktreeSetup;
  }
  const keys = changedProjectKeys(changed);
  if (keys.length === 0) return refused(`nothing to change: ${base.value.baseBranch} already has these settings`);

  // Validated first, so a malformed value is refused in the config's words
  // rather than as a branch origin lacks. Run even when the gate names
  // already failed, so the refusal carries the config's problems too.
  const ownProblems = changed.gates === undefined ? [] : gateNameProblems(changed.gates);
  const { gates: gateList, worktreeSetup: steps, ...rest } = changed;
  // The config's own form; with a repeated name the record keeps the last,
  // which is moot, since that edit is refused above.
  const edit: ProjectConfigEdit = {
    ...rest,
    ...(gateList === undefined ? {} : { gates: Object.fromEntries(gateList.map((gate) => [gate.name, gate.command])) }),
    ...(steps === undefined ? {} : { worktreeSetup: steps.map(compactStep) }),
  };
  const edited = await agents.editProject(edit, baseRef(base.value));
  if (ownProblems.length > 0) {
    // An empty name is already reported by position; project-config's own
    // words for it ("gate name ''", "'gates.'") would only say it again.
    const configProblems = (edited.ok ? [] : problemsOf(edited.why)).filter(
      (problem) => !problem.startsWith("gate name '' ") && !problem.startsWith("'gates.' "),
    );
    const problems = [...ownProblems, ...configProblems];
    return refused(`the project settings are invalid:\n${problems.map((problem) => `${PROBLEM_LINE}${problem}`).join("\n")}`);
  }
  if (!edited.ok) return refused(edited.why);

  // Read once, and only for names the base does not already require: those
  // were the operator's call before this edit.
  const warnings: string[] = [];
  const newChecks = (changed.requiredChecks ?? []).filter((name) => !base.value.requiredChecks.includes(name));
  if (newChecks.length > 0) {
    const reported = await agents.reportedChecks(base.value.repo, base.value.baseBranch);
    if (!reported.ok) {
      warnings.push(`could not check the new required check names against what ${base.value.repo} reports: ${reported.why}`);
    } else {
      for (const name of newChecks) {
        if (!reported.value.includes(name)) {
          warnings.push(`no check named '${name}' has been reported on ${base.value.repo} recently; a required check nothing reports holds every hand-off`);
        }
      }
    }
  }

  // Canonical: keys sorted, absent ones omitted, so the same change always
  // hashes the same; the target base is in it so a PR against an old base is
  // never linked as this one. Lists keep their order, which is part of the change.
  const canonical = JSON.stringify({
    base: base.value.baseBranch,
    changed: Object.fromEntries(Object.entries(changed).sort(([a], [b]) => a.localeCompare(b))),
  });
  const key = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  const open = await agents.projectPr(base.value.repo, key);
  if (!open.ok) return refused(`cannot tell whether a project settings PR is open: ${open.why}`);
  if (open.value !== null) return { outcome: "reused", pr: open.value, warnings };

  // Checked before anything is pushed: a config naming a branch origin lacks,
  // or one with no config of its own, would leave every loop and PR pointed
  // at nothing once it merged.
  let staleBase: string | null = null;
  if (changed.baseBranch !== undefined) {
    const next = changed.baseBranch;
    const exists = await agents.remoteBranch(next);
    if (!exists.ok) return refused(`cannot tell whether the base branch '${next}' exists on origin: ${exists.why}`);
    if (!exists.value) return refused(`the base branch '${next}' does not exist on origin`);
    // Fetched and read the way the current base is: only the branch differs.
    const nextConfig = await readBaseConfig(deps, { ...base.value, baseBranch: next });
    if (!nextConfig.ok) return refused(`the base branch '${next}' has no readable .ralph/config.json: ${nextConfig.why}`);
    // A loop restarted on the new base reads that branch's config, so one
    // still naming another base would move it straight back.
    if (nextConfig.value.baseBranch !== next) staleBase = nextConfig.value.baseBranch;
  }

  // Every key here but the base branch is read once at start, like the display name.
  const restart =
    changed.baseBranch === undefined
      ? "After the merge, restart the project's loops for it to take effect: a loop reads its config once, at start."
      : `After the merge, loops and their PRs move to \`${changed.baseBranch}\`; this PR itself targets \`${base.value.baseBranch}\`, where the config lives today. ` +
        `For it to take effect, stop each of the project's loops, check out \`${changed.baseBranch}\` in its worktree and start it again: a loop reads its config once, at start.`;
  const stale =
    staleBase === null
      ? ""
      : `\n\n**\`${changed.baseBranch}\`'s own \`.ralph/config.json\` still names \`${staleBase}\` as its base branch** and must get the same change, ` +
        `or a loop restarted on \`${changed.baseBranch}\` reads it and moves back to \`${staleBase}\`.`;
  const warned = warnings.length === 0 ? "" : `\n\n**Warnings:**\n\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
  const pr = await openConfigPr(
    deps,
    base.value,
    {
      branch: agents.projectBranch(key, now.toISOString().replace(/[-:.]/g, "")),
      title: `Ralph settings: ${joinWords(keys.map((name) => PROJECT_EDIT_WORDS[name]))}`,
      body:
        `Changes only ${joinWords(keys.map((name) => `\`${name}\``))} in \`.ralph/config.json\`.\n\n` +
        `It applies once this merges into \`${base.value.baseBranch}\`. ${restart}${stale}${warned}`,
    },
    edited.value,
  );
  return pr.ok
    ? { outcome: "proposed", pr: pr.value, warnings }
    : { outcome: "pr-failed", why: `the project settings PR was not opened: ${pr.why}` };
}

/**
 * Give a roster loop the checkout it has none of: the worktree Add agent would
 * have made, without a roster PR, because the base branch's `loops` already
 * names it.
 *
 * The case this exists for is a project onboarded through the dashboard, whose
 * `loops` came from the setup PR rather than from Add agent: every one of
 * those names is on the roster with no worktree anywhere, and Add agent
 * refuses them for exactly that reason (felipearos/ralph#189). So the roster
 * test here is the mirror of Add agent's: the name must ALREADY be listed, as
 * `origin/<baseBranch>` holds it, which is the same roster Start is gated on.
 * Nothing on GitHub changes but the loop's labels, which its role declares and
 * `preflight` would otherwise deny the start over.
 */
export async function createCheckout(deps: AgentsDeps, request: { name: string }): Promise<CreateCheckoutResult> {
  const { agents } = deps;
  const { name } = request;
  const worktree = agents.worktreeFor(name);
  const refused = (reason: string): CreateCheckoutResult => ({ name, worktree, outcome: "refused", labels: null, setup: null, why: reason });

  const config = await readConfig(deps);
  if (!config.ok) return refused(`cannot read the project config: ${config.why}`);
  const clash = await worktreeClash(deps, name, worktree);
  if (!clash.ok) return refused(clash.why);

  const base = await readBaseConfig(deps, config.value);
  if (!base.ok) return refused(`cannot read the roster on ${baseRef(config.value)}: ${base.why}`);
  if (!base.value.loops.includes(name)) {
    return refused(
      `${baseRef(config.value)} does not list ${name} in its roster (${base.value.loops.join(", ")}); ` +
        "a name that is not on the roster yet gets its worktree and its roster PR from Add agent",
    );
  }
  // The roster is where the role lives, and the labels a start needs are the
  // role's. Neither unknown is defaulted to `coder`: a triager given a coder's
  // triple starts and is then denied by `preflight`'s `loop-labels` check,
  // with nothing on the ticket saying why.
  if (base.value.roster === null) {
    return refused(`cannot read the roster on ${baseRef(config.value)}: ${base.value.rosterWhy ?? "it could not be narrowed"}`);
  }
  const entry = base.value.roster.find((listed) => listed.name === name);
  if (entry === undefined) {
    return refused(`${baseRef(config.value)} lists ${name} in 'loops' but its roster has no entry for it`);
  }
  const role = entry.role;

  const made = await makeWorktree(deps, name, worktree, baseRef(config.value), config.value.worktreeSetup);
  if (!made.ok && made.stopped !== "setup") {
    return made.stopped === "provision"
      ? { name, worktree, outcome: "incomplete", labels: null, setup: null, why: `the worktree is at ${worktree}, but ${made.why}` }
      : refused(made.why);
  }
  // Labels on a setup failure too: the worktree exists and is this loop's,
  // so the rerun is the only hand it needs before Start.
  const labels = await createLabels(deps, config.value, name, role);
  if (!made.ok) {
    return {
      name,
      worktree,
      outcome: "incomplete",
      labels,
      setup: made.setup,
      why: `the worktree is at ${worktree}, but ${made.why}` + (labels === null ? "" : `. Its labels also need a hand: ${labels}`),
    };
  }
  return {
    name,
    worktree,
    outcome: "created",
    labels,
    setup: made.setup,
    why:
      `${name} is at ${worktree}, detached at ${baseRef(config.value)}; Start applies to it now` +
      (labels === null ? "" : `. Its labels need a hand: ${labels}`),
  };
}

/** The worktrees whose supervisor is alive, or cannot be seen, among `worktrees` (all of them when absent). */
async function runningIn(deps: AgentsDeps, worktrees?: readonly string[]): Promise<Read<string[]>> {
  const read = await deps.agents.supervisors();
  if (!read.ok) return read;
  const running = read.value.filter((entry) => entry.liveness !== "dead").map((entry) => entry.worktree);
  if (worktrees === undefined) return { ok: true, value: running };
  const unseen = worktrees.filter((path) => !read.value.some((entry) => samePath(entry.worktree, path)));
  return {
    ok: true,
    value: [...running.filter((path) => worktrees.some((wanted) => samePath(wanted, path))), ...unseen],
  };
}

/**
 * Re-run the `worktreeSetup` steps in `name`'s existing worktree (#694): the
 * hand a setup failure asks for. Refused, with nothing run, when the config
 * cannot be read or has no steps, when no worktree is `name`, and while a
 * supervisor is alive there — or cannot be seen — because reinstalling
 * `node_modules` under a running loop breaks its gates mid-iteration; while
 * a setup already runs there; and when its directory is gone.
 */
export async function rerunWorktreeSetup(deps: AgentsDeps, request: { name: string }): Promise<RerunSetupResult> {
  const { agents } = deps;
  const { name } = request;
  const refused = (worktree: string | null, reason: string): RerunSetupResult => ({
    name,
    worktree,
    outcome: "refused",
    setup: null,
    why: reason,
  });

  const config = await readConfig(deps);
  if (!config.ok) return refused(null, `cannot read the project config: ${config.why}`);
  const listed = await agents.listWorktrees();
  if (!listed.ok) return refused(null, `cannot list the project's worktrees: ${listed.why}`);
  // Found the way `worktreeClash` finds one, so the worktree Rerun setup acts
  // on is the one Add agent and Create checkout would have refused over.
  const expected = agents.worktreeFor(name);
  const target = listed.value.find(({ path }) => samePath(path, expected) || agents.readLoopName(path) === name);
  if (target === undefined) return refused(null, `no worktree of ${agents.project} is ${name}`);
  // The setup prepares an agent's worktree; the main checkout is the
  // operator's own, and reinstalling or copying files into it is not ours.
  if (target.main) return refused(target.path, `${name} runs in the project's main checkout; Rerun setup runs only in an agent's own worktree`);
  const steps = config.value.worktreeSetup;
  if (steps.length === 0) return refused(target.path, "the project config has no worktreeSetup steps, so there is nothing to run");
  if (!agents.worktreeExists(target.path)) {
    return refused(target.path, `the worktree directory ${target.path} does not exist; delete ${name} and add it again`);
  }
  if (agents.setupRunning(target.path)) {
    return refused(target.path, `a worktree setup is already running in ${target.path}; rerun it once that setup has finished`);
  }
  const running = await runningIn(deps, [target.path]);
  if (!running.ok) return refused(target.path, `cannot tell whether ${name}'s supervisor is running (${running.why}), so nothing was run`);
  if (running.value.length > 0) {
    return refused(target.path, `${name}'s supervisor is running, or cannot be seen; stop it before re-running its setup`);
  }

  const setup = await runSetup(deps, target.path, steps);
  const failed = failedStep(setup);
  if (failed !== null) {
    return { name, worktree: target.path, outcome: "failed", setup, why: `${setupWhy(failed)}; the worktree is kept, and Rerun setup re-runs the steps` };
  }
  return { name, worktree: target.path, outcome: "passed", setup, why: `every setup step passed in ${target.path}` };
}

/**
 * Delete an agent's worktree: refused while its supervisor is alive or unseen,
 * while a worktree setup runs in it, and for the main checkout. Otherwise `git worktree remove`, then the PR
 * removing the name from `loops` when the base branch lists it.
 */
export async function deleteAgent(deps: AgentsDeps, request: { name: string }): Promise<DeleteAgentResult> {
  const { agents } = deps;
  const { name } = request;
  const refused = (worktree: string | null, reason: string): DeleteAgentResult => ({
    name,
    worktree,
    outcome: "refused",
    pr: null,
    why: reason,
  });

  const config = await readConfig(deps);
  if (!config.ok) return refused(null, `cannot read the project config: ${config.why}`);
  const listed = await agents.listWorktrees();
  if (!listed.ok) return refused(null, `cannot list the project's worktrees: ${listed.why}`);
  const matches = listed.value.filter(({ path }) => agents.readLoopName(path) === name);
  if (matches.length === 0) return refused(null, `no worktree of ${agents.project} is ${name}`);
  if (matches.length > 1) {
    return refused(null, `${matches.length} worktrees are ${name} (${matches.map((entry) => entry.path).join(", ")}); remove the extra one by hand`);
  }
  const target = matches[0]!;
  if (target.main) {
    return refused(target.path, `${name} runs in the project's main checkout; the dashboard never deletes a clone`);
  }
  // Removing the worktree under a running install leaves the setup writing
  // into a directory git no longer knows.
  if (agents.setupRunning(target.path)) {
    return refused(target.path, `a worktree setup is running in ${target.path}; delete ${name} once the setup has finished`);
  }
  const running = await runningIn(deps, [target.path]);
  if (!running.ok) return refused(target.path, `cannot tell whether ${name}'s supervisor is running (${running.why}), so nothing was removed`);
  if (running.value.length > 0) {
    return refused(target.path, `${name}'s supervisor is running, or cannot be seen; stop it before deleting its worktree`);
  }

  const base = await readBaseConfig(deps, config.value);
  if (!base.ok) return refused(target.path, base.why);
  const listedOnBase = base.value.loops.includes(name);
  let text: string | null = null;
  if (listedOnBase) {
    const edited = await agents.editRoster("remove", name, baseRef(config.value));
    if (!edited.ok) return refused(target.path, edited.why);
    text = edited.value;
  }

  const removed = await agents.removeWorktree(target.path);
  if (!removed.ok) return refused(target.path, `git worktree remove refused: ${removed.why}`);
  if (text === null) {
    const open = await findPr(deps, config.value.repo, "add", name);
    return {
      name,
      worktree: target.path,
      outcome: "deleted",
      pr: null,
      why:
        open?.state === "open"
          ? `removed ${target.path}; ${name} was never on ${config.value.baseBranch}, so close ${open.url} rather than merge it`
          : `removed ${target.path}; ${name} is not on ${config.value.baseBranch}, so the roster needs no PR`,
    };
  }
  const pr = await openRosterPr(deps, config.value, "remove", name, text);
  if (!pr.ok) {
    return { name, worktree: target.path, outcome: "pr-failed", pr: null, why: `removed ${target.path}, but the roster PR was not opened: ${pr.why}` };
  }
  return { name, worktree: target.path, outcome: "deleted", pr: pr.value, why: `removed ${target.path}; ${pr.value.url} takes ${name} out of loops` };
}

/**
 * Whether the loop `name` in `worktree` may start. A worktree whose own config
 * names it starts as it always did, with one extra read. One whose config
 * cannot be read is left to `ralph.sh`, which refuses it with its own reason:
 * the gate adds no new way for an existing loop to fail to start. One whose
 * config reads but does not name it is a new agent: it may start only once
 * `origin/<baseBranch>` names it, and then its clean checkout is moved up to
 * that commit — the fast-forward `ralph.sh` itself makes, but before it reads
 * the roster rather than after.
 */
export async function prepareStart(
  deps: AgentsDeps,
  target: { name: string; worktree: string },
): Promise<StartGate> {
  const { agents } = deps;
  const own = await readConfig(deps, { at: target.worktree });
  if (!own.ok || own.value.loops.includes(target.name)) return { ok: true, note: "" };

  const ref = baseRef(own.value);
  const base = await readBaseConfig(deps, own.value, target.worktree);
  if (!base.ok) return { ok: false, why: base.why };
  if (!base.value.loops.includes(target.name)) {
    return { ok: false, why: `${target.name} is pending merge: it is not in loops on ${ref} yet, so its roster PR has not landed` };
  }
  const status = await agents.status(target.worktree);
  if (!status.ok) return { ok: false, why: `cannot read ${target.name}'s checkout: ${status.why}` };
  if (status.value !== "") {
    return { ok: false, why: `${target.name}'s checkout has changes and predates its roster entry; update it to ${ref} by hand` };
  }
  const behind = await agents.isAncestor(target.worktree, ref);
  if (!behind) {
    return { ok: false, why: `${target.name}'s checkout is not behind ${ref}, and does not list it in loops; update it by hand` };
  }
  const advanced = await agents.advance(target.worktree, ref);
  if (!advanced.ok) return { ok: false, why: `could not move ${target.name}'s checkout to ${ref}: ${advanced.why}` };
  return { ok: true, note: ` (moved its checkout up to ${ref}, which lists ${target.name})` };
}

export type StartGate = { ok: true; note: string } | { ok: false; why: string };

/** The start answer for a gate that said no: nothing was started. */
export const refusedStart = (loop: string, worktree: string, reason: string, now: Date = new Date()): StartResult => ({
  loop,
  action: "start",
  worktree,
  outcome: "refused",
  pid: null,
  why: reason,
  at: now.toISOString(),
});

/**
 * Start through `start.sh` once the gate agrees, its note appended to the
 * answer. Refused while a worktree setup runs there: a loop started on a
 * half-installed checkout fails its first gates.
 */
export async function gatedStart(
  deps: AgentsDeps,
  lifecycle: LifecycleDeps,
  target: { name: string; worktree: string },
): Promise<StartResult> {
  if (deps.agents.setupRunning(target.worktree)) {
    return refusedStart(target.name, target.worktree, `a worktree setup is running in ${target.worktree}; start it once the setup has finished`, lifecycle.now?.());
  }
  const gate = await prepareStart(deps, target);
  if (!gate.ok) return refusedStart(target.name, target.worktree, gate.why, lifecycle.now?.());
  const result = await start(lifecycle, { loop: target.name });
  return { ...result, why: `${result.why}${gate.note}` };
}

/**
 * Start a new agent the roster does not list yet, found by name among the
 * project's worktrees; null when there is no such agent.
 */
export async function startAgent(
  deps: AgentsDeps,
  lifecycleFor: (worktree: string) => LifecycleDeps,
  name: string,
): Promise<StartResult | null> {
  const agent = (await listPendingAgents(deps)).pending.find((entry) => entry.name === name);
  if (agent === undefined) return null;
  return gatedStart(deps, lifecycleFor(agent.worktree), { name, worktree: agent.worktree });
}

/**
 * Unregister a project: refused while any of its worktrees' supervisors is
 * alive, or while that cannot be seen. Only the registry changes.
 */
export async function removeProject(
  deps: AgentsDeps,
  registry: ProjectRegistryWrite,
): Promise<RemoveProjectResult> {
  const project = deps.agents.project;
  const refused = (reason: string, running: string[] = []): RemoveProjectResult => ({ project, outcome: "refused", why: reason, running });
  if (registry.readOnly) return refused("the registry is read-only for this run: the dashboard was started with fixed roots");
  const running = await runningIn(deps);
  if (!running.ok) return refused(`cannot tell whether ${project}'s supervisors are running (${running.why}), so it stays registered`);
  if (running.value.length > 0) {
    return refused(`${running.value.length} supervisor(s) of ${project} are running or cannot be seen; stop them first`, running.value);
  }
  if (!registry.remove(project)) return refused(`${project} is not registered`);
  return {
    project,
    outcome: "removed",
    why: `unregistered ${project}; its checkout, worktrees and GitHub repo are untouched`,
    running: [],
  };
}
