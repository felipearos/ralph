/**
 * Agents and project removal over HTTP: thin routes over agent dispatch.
 *
 *   - `GET /api/agents` — the project's agents its roster does not list yet,
 *     each `pending-merge` or `ready`, with its roster PR and its readiness
 *     items. Read-only.
 *   - `GET /api/agents/guide` — `adding-an-agent.md` and the project's values
 *     for its examples, which the Add-agent panel renders. Read-only.
 *   - `GET /api/agents/preflight?name=<name>` — one pending agent's preflight
 *     verdict, as a readiness item. Read-only, and off the agents poll.
 *   - `POST /api/agents` `{ name }` — Add agent.
 *   - `POST /api/agents/delete` `{ name, confirm: true }` — Delete agent
 *     worktree. The confirmation is the server's to enforce, as for restart.
 *   - `POST /api/agents/checkout` `{ name }` — Create checkout: the worktree
 *     for a loop the base branch's roster already lists. No confirmation: it
 *     creates, and removes nothing.
 *   - `POST /api/agents/start` `{ name }` — Start a new agent the roster does
 *     not list yet, through the same gate and `start.sh` as `POST /api/start`.
 *   - `GET /api/agents/verifier` — the verifier's rules as the base branch's
 *     config spells them, whether a roster loop is a verifier, and the open
 *     rules PR, if any. Read-only.
 *   - `POST /api/agents/verifier` `{ rules }` — propose new verifier rules as
 *     a PR changing only the `verifier` block's rules.
 *   - `GET /api/agents/sentinel` — the sentinel's rules as the base branch's
 *     config spells them, whether a roster loop is a sentinel, and the open
 *     rules PR, if any. Read-only.
 *   - `POST /api/agents/sentinel` `{ rules }` — propose new sentinel rules as
 *     a PR changing only the `sentinel` block's rules.
 *   - `GET /api/labels` — every label the roster's loops need, which loops
 *     need each and whether the repository has it, then the repository's
 *     other labels. Read-only.
 *   - `GET /api/settings` — the Settings overview: the project's checkout,
 *     worktrees and config, as `settings.ts` reads them. Read-only.
 *   - `GET /api/settings/prompts` — the Settings Prompts section: the prompt
 *     fragments the config names and each roster role's rendered prompt, as
 *     `settings-prompts.ts` reads them. Read-only, and its own body because
 *     each render runs a process.
 *   - `GET /api/sentinel` — the Sentinel panel: the checkout's sentinel rules
 *     and its issue store, as `agents.ts` `sentinelPanel` reads them.
 *     Read-only.
 *   - `POST /api/settings/gates/run` `{ gate }` — run one of the config's
 *     gates, by name, in the project's main checkout. Answers at once with
 *     the run `running`; `GET` on the same path reads the run, for polling.
 *     Local-only: it executes on the host.
 *   - `POST /api/settings/worktrees/cleanup` `{ paths, confirm: true }` —
 *     Clean up worktrees: remove git's registration of each listed stale
 *     worktree, one path at a time, as `worktree-cleanup.ts` judges them.
 *     Local-only: it changes this host's git.
 *   - `POST /api/projects/remove` `{ project, confirm: true }` — unregister a
 *     project. Served at the top level, beside `GET /api/projects`.
 *
 * What lives here is the HTTP contract, in the shape of `lifecycle-routes.ts`:
 * validate, call `agents.ts`, serialize. Whether an action went ahead or was
 * refused is agent dispatch's answer, returned as a 200 whose `outcome` says
 * so. No command, flag or path is named here.
 */
import { LOOP_ROLES } from "./contracts";
import type {
  AddAgentResult,
  AgentPreflightView,
  AgentsView,
  CleanUpWorktreesResult,
  GuideView,
  CreateCheckoutResult,
  DeleteAgentResult,
  GateRunAnswer,
  LabelsView,
  LoopRole,
  ProjectEdit,
  ProjectPromptsView,
  ProjectSettingsView,
  ProposeProjectResult,
  ProposeSentinelResult,
  ProposeVerifierResult,
  RemoveProjectResult,
  SentinelPanelView,
  SentinelView,
  RerunSetupResult,
  SetWorktreesResult,
  VerifierView,
  StartResult,
  WorktreeSetupStepConfig,
} from "./contracts";
import { ControlRouteError, LOOP_NAME_SHAPE, invalid, json, optionalText, parseAgentName, readBody } from "./command-requests";
import {
  addAgent,
  agentGuide,
  agentPreflight,
  createCheckout,
  deleteAgent,
  listPendingAgents,
  locatePendingAgent,
  listProjectLabels,
  proposeProject,
  proposeSentinel,
  proposeVerifier,
  readSentinel,
  readVerifier,
  removeProject,
  sentinelPanel,
  rerunWorktreeSetup,
  startAgent,
  type AgentsDeps,
  type ProjectRegistryWrite,
} from "./agents";
import { projectSettings } from "./settings";
import { projectPrompts } from "./settings-prompts";
import { cleanUpWorktrees } from "./worktree-cleanup";
import type { GateRunner } from "./gate-run";
import type { LifecycleFactory } from "./lifecycle-routes";

export const AGENTS_PATH = "/api/agents";
/** The guide the Add-agent panel renders, as `adding-an-agent.md`'s own bytes. */
export const AGENTS_GUIDE_PATH = "/api/agents/guide";
/**
 * One pending agent's preflight verdict. Its own route, and asked for rather
 * than polled: `GET /api/agents` is re-read every five seconds, and preflight
 * makes three network calls per agent.
 */
export const AGENT_PREFLIGHT_PATH = "/api/agents/preflight";
export const DELETE_AGENT_PATH = "/api/agents/delete";
export const CREATE_CHECKOUT_PATH = "/api/agents/checkout";
/** Re-run the project's `worktreeSetup` steps in a loop's existing worktree (#694). */
export const RERUN_SETUP_PATH = "/api/agents/setup";
export const START_AGENT_PATH = "/api/agents/start";
/** The verifier's rules: GET reads them off the base branch, POST proposes new ones as a PR. */
export const VERIFIER_PATH = "/api/agents/verifier";
/** The sentinel's rules: GET reads them off the base branch, POST proposes new ones as a PR. */
export const SENTINEL_PATH = "/api/agents/sentinel";
export const LABELS_PATH = "/api/labels";
export const REMOVE_PROJECT_PATH = "/api/projects/remove";
/** The Settings overview of the project: a read, so the bridge may relay it. */
export const SETTINGS_PATH = "/api/settings";
/**
 * The Settings Prompts section: a read, so the bridge may relay it. Apart from
 * `SETTINGS_PATH` because it renders one prompt per roster role, a process
 * each, which the page's overview, Edit and Gates reads should not wait on.
 * The bridge still collects it at the config cadence, as it does the overview.
 */
export const SETTINGS_PROMPTS_PATH = "/api/settings/prompts";
/** The Sentinel panel: a read of the checkout's rules and issue store, so the bridge may relay it. */
export const SENTINEL_PANEL_PATH = "/api/sentinel";
/**
 * Proposes the project's display name and base branch as a config PR. A
 * write, so it is local-only: the bridge relays reads and never this.
 */
export const SETTINGS_PROJECT_PATH = "/api/settings/project";
/**
 * Runs one of the project's gates (POST) and reads that run (GET). Local-only
 * both ways: it executes a command on the host. The gates list itself rides
 * the relayed `GET /api/settings` snapshot.
 */
export const SETTINGS_GATE_RUN_PATH = "/api/settings/gates/run";
/**
 * Sets or clears the folder the project's new agent worktrees go in. It writes
 * this host's project registry, so it is local-only, and is served only when
 * the server was handed the registry.
 */
export const SETTINGS_WORKTREES_PATH = "/api/settings/worktrees";
/**
 * Removes the stale worktree registrations the operator confirmed (#696). It
 * changes this host's git, so it is local-only; always served, as it needs
 * nothing beyond the agents adapter.
 */
export const SETTINGS_WORKTREES_CLEANUP_PATH = "/api/settings/worktrees/cleanup";

/** The keys a project settings edit may carry; anything else is refused before `project-config` sees it. */
export const PROJECT_EDIT_KEYS = ["displayName", "baseBranch", "gates", "requiredChecks", "refuseFiles", "worktreeSetup"] as const;
/** The same keys as a message names them. */
const PROJECT_EDIT_NAMES = PROJECT_EDIT_KEYS.map((key) => `'${key}'`).join(", ");

/** Build what agent dispatch runs against for this project. */
export type AgentsFactory = () => AgentsDeps;

export interface AgentRouteOptions {
  agents: AgentsFactory;
  /** Absent, `POST /api/agents/start` is not served. */
  lifecycle?: LifecycleFactory;
  /** The project's registry id, handed on to a started loop. */
  project?: string;
  /**
   * The project's registry entry, which the Settings overview shows as its
   * checkout. Absent (the single-project shorthand, tests), it is read off
   * the agents adapter, with no registration date.
   */
  registered?: { id: string; path: string; addedAt: string | null };
  /**
   * Runs the Settings page's gates. The server passes one for its whole
   * process, so one run per project holds across requests. Absent, the gate
   * run route is not served: a runner made here would hold in-flight state
   * nobody else sees, and its one-run-per-project refusal would be a fiction.
   */
  gates?: GateRunner;
  /** The registry the worktrees folder is written to. Absent, `POST /api/settings/worktrees` is not served. */
  registry?: Pick<ProjectRegistryWrite, "setWorktrees">;
  now?: () => Date;
}

/** The agent routes that only read, and so answer GET and nothing else. */
const READ_ONLY: readonly string[] = [AGENTS_GUIDE_PATH, AGENT_PREFLIGHT_PATH, LABELS_PATH, SETTINGS_PATH, SETTINGS_PROMPTS_PATH, SENTINEL_PANEL_PATH];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The role a new agent is to hold. Absent is `coder`, so a request made before
 * roles existed still means what it meant then; anything outside the roster's
 * vocabulary is refused here rather than reaching `project-config` as an argv
 * word.
 */
const requireRole = (raw: Record<string, unknown>): LoopRole => {
  const role = optionalText(raw, "role");
  if (role === null) return "coder";
  if (!(LOOP_ROLES as readonly string[]).includes(role)) {
    throw invalid(`'role' must be one of ${LOOP_ROLES.join(", ")}; got '${role}'`);
  }
  return role as LoopRole;
};

/**
 * The shape of a project settings edit, and only the shape: whether a name,
 * branch, gate or path is acceptable is `project-config`'s (or, for a gate
 * name only the ordered list can show, `proposeProject`'s) to say, and it
 * comes back as a `refused` result in its own words.
 */
const requireProjectEdit = (raw: unknown): ProjectEdit => {
  if (!isObject(raw)) throw invalid(`the body must be a JSON object with any of ${PROJECT_EDIT_NAMES}`);
  const unknown = Object.keys(raw).filter((key) => !(PROJECT_EDIT_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) throw invalid(`unknown key(s) ${unknown.map((key) => `'${key}'`).join(", ")}: only ${PROJECT_EDIT_NAMES} can be edited`);
  const edit: ProjectEdit = {};
  for (const key of ["displayName", "baseBranch"] as const) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (typeof value !== "string") throw invalid(`'${key}' must be a string`);
    edit[key] = value;
  }
  if ("gates" in raw) {
    const gates = raw.gates;
    // Exactly `name` and `command`: another key would be dropped on the way
    // to the config's object form, and the operator would not see it go.
    const isGate = (gate: unknown): gate is { name: string; command: string } =>
      isObject(gate) &&
      Object.keys(gate).length === 2 &&
      typeof gate.name === "string" &&
      typeof gate.command === "string";
    if (!Array.isArray(gates) || !gates.every(isGate)) {
      throw invalid("'gates' must be an array of { \"name\": string, \"command\": string } objects, with no other keys");
    }
    edit.gates = gates.map((gate) => ({ name: gate.name, command: gate.command }));
  }
  for (const key of ["requiredChecks", "refuseFiles"] as const) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw invalid(`'${key}' must be an array of strings`);
    edit[key] = [...value];
  }
  if ("worktreeSetup" in raw) {
    const steps = raw.worktreeSetup;
    // Complete steps, exactly these four keys: the defaults are the config's
    // to omit, and another key would be dropped without the operator seeing it go.
    const isStep = (step: unknown): step is WorktreeSetupStepConfig =>
      isObject(step) &&
      Object.keys(step).length === 4 &&
      typeof step.name === "string" &&
      typeof step.command === "string" &&
      typeof step.timeoutSeconds === "number" &&
      typeof step.installsDependencies === "boolean";
    if (!Array.isArray(steps) || !steps.every(isStep)) {
      throw invalid(
        "'worktreeSetup' must be an array of { \"name\": string, \"command\": string, \"timeoutSeconds\": number, \"installsDependencies\": boolean } objects, with no other keys",
      );
    }
    edit.worktreeSetup = steps.map((step) => ({
      name: step.name,
      command: step.command,
      timeoutSeconds: step.timeoutSeconds,
      installsDependencies: step.installsDependencies,
    }));
  }
  if (Object.keys(edit).length === 0) throw invalid(`send at least one of ${PROJECT_EDIT_NAMES}`);
  return edit;
};

/** The shape of a worktrees folder edit: a string sets it, null clears it. Whether the folder will do is the registry's to say. */
const requireWorktreesFolder = (raw: unknown): string | null => {
  if (!isObject(raw) || !("folder" in raw)) throw invalid("'folder' is required: an absolute path, or null for the default");
  const { folder } = raw;
  if (folder !== null && typeof folder !== "string") throw invalid("'folder' must be an absolute path (a string) or null");
  return folder;
};

/** The stale worktree paths the operator confirmed; which of them are removed is the cleanup's to judge. */
const requireCleanupPaths = (raw: Record<string, unknown>): string[] => {
  const { paths } = raw;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((path) => typeof path === "string" && path !== "")) {
    throw invalid("'paths' is required: a non-empty list of the worktree paths to clean up");
  }
  return paths as string[];
};

const confirmed = (body: Record<string, unknown>, what: string): void => {
  if (body.confirm !== true) throw new ControlRouteError(400, "ConfirmationRequired", `${what}: send it with "confirm": true`);
};

/**
 * Answer an agent route, or return null when the path is not one.
 *
 * Client errors are answered here; anything else propagates to the server's
 * own error mapping.
 */
export async function handleAgentRoute(
  request: Request,
  pathname: string,
  options: AgentRouteOptions,
): Promise<Response | null> {
  const paths = [
    AGENTS_PATH,
    AGENTS_GUIDE_PATH,
    AGENT_PREFLIGHT_PATH,
    LABELS_PATH,
    DELETE_AGENT_PATH,
    CREATE_CHECKOUT_PATH,
    RERUN_SETUP_PATH,
    VERIFIER_PATH,
    SENTINEL_PATH,
    SETTINGS_PATH,
    SETTINGS_PROMPTS_PATH,
    SENTINEL_PANEL_PATH,
    SETTINGS_PROJECT_PATH,
    SETTINGS_WORKTREES_CLEANUP_PATH,
    ...(options.gates === undefined ? [] : [SETTINGS_GATE_RUN_PATH]),
    ...(options.registry === undefined ? [] : [SETTINGS_WORKTREES_PATH]),
    ...(options.lifecycle === undefined ? [] : [START_AGENT_PATH]),
  ];
  if (!paths.includes(pathname)) return null;
  // The reads are GET only: none has a write path, so a POST to any
  // is refused here rather than falling through to a shape that has one.
  const allowed = READ_ONLY.includes(pathname) ? ["GET"] : [AGENTS_PATH, VERIFIER_PATH, SENTINEL_PATH, SETTINGS_GATE_RUN_PATH].includes(pathname) ? ["GET", "POST"] : ["POST"];
  if (!allowed.includes(request.method)) {
    return new Response("method not allowed", { status: 405, headers: { allow: allowed.join(", ") } });
  }
  try {
    const deps = options.agents();
    if (pathname === AGENTS_PATH && request.method === "GET") {
      return json((await listPendingAgents(deps)) satisfies AgentsView);
    }
    if (pathname === AGENTS_GUIDE_PATH) return json((await agentGuide(deps)) satisfies GuideView);
    if (pathname === SETTINGS_PATH) {
      const registered = options.registered ?? { id: options.project ?? deps.agents.project, path: deps.agents.root, addedAt: null };
      return json((await projectSettings(deps, registered)) satisfies ProjectSettingsView);
    }
    if (pathname === SETTINGS_PROMPTS_PATH) return json((await projectPrompts(deps)) satisfies ProjectPromptsView);
    if (pathname === SETTINGS_GATE_RUN_PATH) {
      // The main checkout is both where the gate runs and the runner's key,
      // so projects sharing one runner never refuse each other.
      const checkout = options.registered?.path ?? deps.agents.root;
      const runner = options.gates!;
      if (request.method === "GET") return json({ run: runner.current(checkout) } satisfies GateRunAnswer);
      const raw = await readBody(request);
      if (!isObject(raw)) throw invalid("the body must be a JSON object with 'gate'");
      const name = optionalText(raw, "gate");
      if (name === null) throw invalid("'gate' is required: name one of the project's gates");
      // The command comes from the config, read now, never from the request:
      // a page may only ask for a gate the project already declares. Read
      // from the checkout the gate runs in, so the command and the tree it
      // judges are one checkout's; one with no config is refused, not run
      // against another branch's gate.
      const config = await deps.agents.readConfig({ at: checkout });
      if (!config.ok) throw new ControlRouteError(502, "ConfigUnreadable", config.why);
      const gate = config.value.gates.find((candidate) => candidate.name === name);
      if (gate === undefined) {
        const names = config.value.gates.map((candidate) => `'${candidate.name}'`);
        const has = names.length === 0 ? "the config has no gates" : `the config's gates are ${names.join(", ")}`;
        throw new ControlRouteError(404, "UnknownGate", `no gate '${name}': ${has}`);
      }
      // Answered at once: a gate can outlast the server's idle timeout, so the
      // page polls GET for the outcome rather than waiting on `done`.
      const started = runner.start(checkout, checkout, { name: gate.name, command: gate.command });
      if (!started.started) throw new ControlRouteError(409, "GateRunInFlight", started.reason);
      return json({ run: started.view } satisfies GateRunAnswer);
    }
    if (pathname === AGENT_PREFLIGHT_PATH) {
      // The agent must be one this project has a pending card for: preflight
      // runs in its worktree, and the worktree is the route's to find, never
      // the request's to name.
      const name = new URL(request.url).searchParams.get("name");
      if (name === null || name === "") throw invalid("'name' is required: name the agent");
      if (!LOOP_NAME_SHAPE.test(name)) throw invalid(`'name' must be one lowercase word (a-z, then a-z or 0-9); got '${name}'`);
      const agent = await locatePendingAgent(deps, name);
      if (!agent.ok) {
        throw new ControlRouteError(404, "UnknownAgent", `${agent.why}; a roster loop's preflight runs from its own page`);
      }
      return json((await agentPreflight(deps, agent.value)) satisfies AgentPreflightView);
    }
    if (pathname === LABELS_PATH) return json((await listProjectLabels(deps)) satisfies LabelsView);
    if (pathname === VERIFIER_PATH && request.method === "GET") {
      const verifier = await readVerifier(deps);
      if (!verifier.ok) throw new ControlRouteError(502, "VerifierUnreadable", verifier.why);
      return json(verifier.value satisfies VerifierView);
    }
    if (pathname === SENTINEL_PANEL_PATH) return json((await sentinelPanel(deps)) satisfies SentinelPanelView);
    if (pathname === SENTINEL_PATH && request.method === "GET") {
      const sentinel = await readSentinel(deps);
      if (!sentinel.ok) throw new ControlRouteError(502, "SentinelUnreadable", sentinel.why);
      return json(sentinel.value satisfies SentinelView);
    }
    const raw = await readBody(request);
    if (pathname === AGENTS_PATH) {
      const { body, name } = parseAgentName(raw);
      return json((await addAgent(deps, { name, role: requireRole(body) })) satisfies AddAgentResult);
    }
    if (pathname === VERIFIER_PATH) {
      // Only the shape: which keys and values are rules is `project-config`'s
      // answer, returned as a refusal in its own words.
      if (!isObject(raw) || !isObject(raw.rules)) throw invalid("'rules' is required: a JSON object of verifier rules");
      return json((await proposeVerifier(deps, raw.rules)) satisfies ProposeVerifierResult);
    }
    if (pathname === SENTINEL_PATH) {
      // As for the verifier: only the shape is judged here.
      if (!isObject(raw) || !isObject(raw.rules)) throw invalid("'rules' is required: a JSON object of sentinel rules");
      return json((await proposeSentinel(deps, raw.rules)) satisfies ProposeSentinelResult);
    }
    if (pathname === SETTINGS_PROJECT_PATH) {
      return json((await proposeProject(deps, requireProjectEdit(raw))) satisfies ProposeProjectResult);
    }
    if (pathname === SETTINGS_WORKTREES_PATH) {
      const folder = requireWorktreesFolder(raw);
      const id = options.registered?.id ?? options.project ?? deps.agents.project;
      let entry: { worktrees?: string };
      try {
        // Non-null: the path is only served when a registry was handed over.
        entry = options.registry!.setWorktrees(id, folder);
      } catch (error) {
        // A refusal in the registry's own words (relative, unwritable, inside
        // a checkout, read-only for the run). Matched by name: the import
        // allow-list keeps `./projects` out of this file. A registry that
        // cannot be locked or read is not a refused folder, so it falls
        // through to the server's 500.
        if (error instanceof Error && error.name === "WorktreesFolderRefused") {
          throw new ControlRouteError(409, "WorktreesRefused", error.message);
        }
        throw error;
      }
      // This request's adapter was built from the entry as it was, so the
      // answer is read off what the registry wrote, not off the adapter.
      const defaultWorktreesDir = deps.agents.defaultWorktreesDir();
      return json({
        project: id,
        worktreesDir: entry.worktrees ?? defaultWorktreesDir,
        worktreesDefault: entry.worktrees === undefined,
        defaultWorktreesDir,
      } satisfies SetWorktreesResult);
    }
    if (pathname === SETTINGS_WORKTREES_CLEANUP_PATH) {
      if (!isObject(raw)) throw invalid("the body must be a JSON object with 'paths' and 'confirm'");
      confirmed(raw, "cleaning up worktrees removes git's registration of each stale worktree listed");
      return json((await cleanUpWorktrees(deps, { paths: requireCleanupPaths(raw) })) satisfies CleanUpWorktreesResult);
    }
    if (pathname === CREATE_CHECKOUT_PATH) {
      const { name } = parseAgentName(raw);
      return json((await createCheckout(deps, { name })) satisfies CreateCheckoutResult);
    }
    if (pathname === RERUN_SETUP_PATH) {
      const { name } = parseAgentName(raw);
      return json((await rerunWorktreeSetup(deps, { name })) satisfies RerunSetupResult);
    }
    if (pathname === DELETE_AGENT_PATH) {
      const { body, name } = parseAgentName(raw);
      confirmed(body, "deleting an agent's worktree removes its checkout and opens a PR taking it out of the roster");
      return json((await deleteAgent(deps, { name })) satisfies DeleteAgentResult);
    }
    const { name } = parseAgentName(raw);
    const lifecycle = options.lifecycle!;
    const result = await startAgent(
      deps,
      (worktree) => ({
        ...lifecycle({ loop: name, worktree, supervisor: "unknown", ...(options.project === undefined ? {} : { project: options.project }) }),
        loop: name,
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
      name,
    );
    if (result === null) throw new ControlRouteError(404, "UnknownAgent", `no new agent '${name}'; a roster loop starts through /api/start`);
    return json(result satisfies StartResult);
  } catch (error) {
    if (error instanceof ControlRouteError) return json({ error: error.name, message: error.message }, error.status);
    throw error;
  }
}

export interface ProjectRemovalOptions {
  /** The registered project ids. */
  projects: () => Promise<readonly string[]>;
  registry: ProjectRegistryWrite;
  /** What agent dispatch runs against for the project `id`. */
  agents: (id: string) => AgentsDeps;
}

/** Answer `POST /api/projects/remove`, or return null when the path is not it. */
export async function handleProjectRemoval(
  request: Request,
  pathname: string,
  options: ProjectRemovalOptions,
): Promise<Response | null> {
  if (pathname !== REMOVE_PROJECT_PATH) return null;
  if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
  try {
    const raw = await readBody(request);
    if (!isObject(raw)) throw invalid("the request body must be a JSON object");
    const id = optionalText(raw, "project");
    if (id === null) throw invalid("'project' is required: name the project to remove");
    confirmed(raw, "removing a project unregisters it from the dashboard");
    if (!(await options.projects()).includes(id)) throw new ControlRouteError(404, "UnknownProject", `no project '${id}'`);
    return json((await removeProject(options.agents(id), options.registry)) satisfies RemoveProjectResult);
  } catch (error) {
    if (error instanceof ControlRouteError) return json({ error: error.name, message: error.message }, error.status);
    throw error;
  }
}
