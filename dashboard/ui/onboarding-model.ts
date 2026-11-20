/**
 * The add-project dialog's and the setup form's view logic.
 *
 * Pure: the components hand in what the operator typed and what the server
 * answered. The server is the judge of every rule; this only shapes requests,
 * explains refusals, and maps a config to the form and back.
 */
import {
  GITHUB_REPO,
  type GithubRepoView,
  type ProjectSetupView,
  type TrackerConnectRequest,
} from "../contracts";
import type { CommandError } from "./command-model";

export type AddTab = "local" | "github";

/** The body `POST /api/projects` takes, or why the input cannot be sent yet. */
export function addRequest(
  tab: AddTab,
  input: string,
): { body: { source: "local"; path: string } | { source: "github"; repo: string } } | { error: string } {
  const value = input.trim();
  if (tab === "local") {
    if (value === "") return { error: "Enter the checkout's absolute path." };
    if (!value.startsWith("/")) return { error: "The path must be absolute, starting with /." };
    return { body: { source: "local", path: value } };
  }
  if (value === "") return { error: "Pick a repository or paste owner/name." };
  if (!GITHUB_REPO.test(value)) return { error: "Use the owner/name form, e.g. acme/widget." };
  return { body: { source: "github", repo: value } };
}

/**
 * Where a GitHub add will clone, as the footer names it: the server clones
 * `owner/name` into `~/<name>`. Null until the input is a whole `owner/name`.
 */
export function cloneTarget(input: string): { repo: string; folder: string } | null {
  const repo = input.trim();
  if (!GITHUB_REPO.test(repo)) return null;
  return { repo, folder: `~/${repo.slice(repo.indexOf("/") + 1)}` };
}

/**
 * Repos whose name or description contain the query, case-insensitively. A
 * query that is exactly one repo's name is a pick, not a filter: the whole
 * list stays, with that repo in it.
 */
export function filterRepos(repos: readonly GithubRepoView[], query: string): GithubRepoView[] {
  const needle = query.trim().toLowerCase();
  if (needle === "" || repos.some((repo) => repo.nameWithOwner.toLowerCase() === needle)) return [...repos];
  return repos.filter(
    (repo) => repo.nameWithOwner.toLowerCase().includes(needle) || (repo.description ?? "").toLowerCase().includes(needle),
  );
}

export interface RefusalView {
  /** What the notice says, through `CommandNotice`. */
  error: CommandError;
  /** A checkout already at the clone target, offered for local registration. */
  registerLocal: string | null;
}

/**
 * A refused add as the dialog shows it. Only `CloneTargetExists` offers its
 * path: the server names other paths too (the harness checkout), and those
 * must never be registered.
 */
export function refusalView(error: CommandError): RefusalView {
  return { error, registerLocal: error.kind === "CloneTargetExists" && error.path !== undefined ? error.path : null };
}

/** An input the dialog refuses before sending, shaped like the server's refusals so one notice shows both. */
export const inputRefusal = (message: string): RefusalView => refusalView({ kind: "Invalid", message, status: null });

/** What stands in for the agents grid: nothing when ready, else the form or the pending PR. */
export type SetupPanel =
  | { kind: "none" }
  | { kind: "form"; baseBranch: string }
  | { kind: "pending"; url: string; number: number | null; baseBranch: string };

export function setupPanel(view: ProjectSetupView | null): SetupPanel {
  if (view === null || view.status === "ready") return { kind: "none" };
  if (view.status === "setup-pending" && view.pr !== null) {
    return { kind: "pending", url: view.pr.url, number: view.pr.number, baseBranch: view.baseBranch };
  }
  return { kind: "form", baseBranch: view.baseBranch };
}

/**
 * What the header and the sidebar say about a project that is not ready, in
 * place of the error and the skeletons its failing reads would show. Null when
 * the project is ready or its status is not known yet.
 */
export interface SetupStamp {
  label: string;
  detail: string;
}

export function setupStamp(view: ProjectSetupView | null): SetupStamp | null {
  if (view === null || view.status === "ready") return null;
  if (view.status === "setup-pending") {
    return { label: "Setup PR open", detail: `Agents can start once the setup PR merges into ${view.baseBranch}.` };
  }
  return { label: "Needs setup", detail: `Its .ralph/config.json is not on origin/${view.baseBranch} yet.` };
}

/** The setup form's editable fields; the rest of the config keeps its defaults. */
export interface SetupForm {
  repo: string;
  owner: string;
  baseBranch: string;
  displayName: string;
  /** One `name: command` per line. */
  gates: string;
  /** Comma- or space-separated loop names. */
  loops: string;
  /** Comma-separated check names; a name may hold spaces (`Vercel – app`). */
  requiredChecks: string;
}

const checkNames = (text: string): string[] =>
  text
    .split(/[,\n]/)
    .map((name) => name.trim())
    .filter((name) => name !== "");

const loopNames = (text: string): string[] => text.split(/[\s,]+/).filter((name) => name !== "");

/** One entry of a list field as the config will hold it; a repeat is marked, not dropped, since the server refuses it. */
export interface ListChip {
  name: string;
  repeated: boolean;
}

/**
 * The loops or required checks as `configFromForm` will split them, so the
 * chips under each input show exactly what the config gets: a trailing comma
 * or a name typed twice is visible before Check.
 */
export function listChips(form: SetupForm, key: "loops" | "requiredChecks"): ListChip[] {
  const names = key === "loops" ? loopNames(form.loops) : checkNames(form.requiredChecks);
  const seen = new Set<string>();
  return names.map((name) => {
    const repeated = seen.has(name);
    seen.add(name);
    return { name, repeated };
  });
}

/** One gate line as `configFromForm` will read it; `line` is 1-based, for the editor's gutter. */
export interface GateChip {
  name: string;
  line: number;
  /** A line with no `:` (sent whole as the name), or a name an earlier line already took. */
  problem: "no-colon" | "repeated" | null;
}

/**
 * The gates as the config will hold them, one per non-blank line. A problem
 * is shown, not fixed: the line still goes to the server, which names it.
 */
export function gateChips(form: SetupForm): GateChip[] {
  const seen = new Set<string>();
  const chips: GateChip[] = [];
  form.gates.split("\n").forEach((text, index) => {
    if (text.trim() === "") return;
    const at = text.indexOf(":");
    const name = (at === -1 ? text : text.slice(0, at)).trim();
    const problem = at === -1 ? "no-colon" : seen.has(name) ? "repeated" : null;
    seen.add(name);
    chips.push({ name, line: index + 1, problem });
  });
  return chips;
}

/**
 * Whether the form names no required check, so loops would merge without
 * waiting for CI: the form asks for an acknowledgement before the PR opens.
 */
export const mergesWithoutCi = (form: SetupForm): boolean => checkNames(form.requiredChecks).length === 0;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

export function formFromConfig(config: Record<string, unknown>): SetupForm {
  const gates = typeof config.gates === "object" && config.gates !== null ? (config.gates as Record<string, unknown>) : {};
  return {
    repo: text(config.repo),
    owner: text(config.owner),
    baseBranch: text(config.baseBranch),
    displayName: text(config.displayName),
    gates: Object.entries(gates)
      .map(([name, command]) => `${name}: ${text(command)}`)
      .join("\n"),
    loops: Array.isArray(config.loops) ? config.loops.map(String).join(", ") : "",
    requiredChecks: Array.isArray(config.requiredChecks) ? config.requiredChecks.map(String).join(", ") : "",
  };
}

/**
 * The files the setup PR writes, as the header lists them: the config and the
 * three the defaults name, project-relative, so a fragment kept outside
 * `.ralph/` is shown where it really goes. Before the defaults load, the
 * paths `onboarding.ts` defaults to.
 */
export function setupFiles(defaults: Record<string, unknown> | null): string[] {
  const path = (key: string, fallback: string): string => {
    const value = defaults === null ? "" : text(defaults[key]);
    return value === "" ? fallback : value;
  };
  return [".ralph/config.json", path("promptFragment", ".ralph/prompt.md"), path("coderFragment", ".ralph/coder.md"), path("plan", ".ralph/plan.md")];
}

/**
 * The candidate config: the defaults with the form's fields over them. A gate
 * line without a `:` keeps its whole text as the name, so the server names
 * the problem rather than the form dropping the line.
 */
export function configFromForm(
  defaults: Record<string, unknown>,
  form: SetupForm,
  tracker: Record<string, unknown> | null = null,
): Record<string, unknown> {
  const gates: Record<string, string> = {};
  for (const line of form.gates.split("\n")) {
    if (line.trim() === "") continue;
    const at = line.indexOf(":");
    if (at === -1) gates[line.trim()] = "";
    else gates[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return {
    ...defaults,
    repo: form.repo.trim(),
    owner: form.owner.trim(),
    baseBranch: form.baseBranch.trim(),
    displayName: form.displayName.trim(),
    gates,
    loops: loopNames(form.loops),
    requiredChecks: checkNames(form.requiredChecks),
    ...(tracker === null ? {} : { tracker }),
  };
}

/**
 * The trackers the connector offers, in the order it shows them. A `local`
 * tracker (felipearos/ralph#527) is a file a trial sandbox writes on the host,
 * not somewhere an operator keeps tickets, so it is never one of them.
 */
export const TRACKER_KINDS: readonly { kind: TrackerDraft["kind"]; label: string }[] = [
  { kind: "github", label: "GitHub issues" },
  { kind: "linear", label: "Linear" },
  { kind: "jira", label: "Jira" },
];

/**
 * The Tracker connector's state (felipearos/ralph#338): which tracker holds
 * the project's tickets, the token to reach it, and what the operator picked
 * from what the token can see. GitHub needs none of it: `gh` has its own
 * login, and a config without a `tracker` block means GitHub issues.
 */
export interface TrackerDraft {
  kind: "github" | "linear" | "jira";
  /** Linear's personal API key. */
  apiKey: string;
  /** Jira's site, account email and API token. */
  site: string;
  email: string;
  apiToken: string;
  /** The Linear team key or Jira project key picked from the token's list. */
  key: string;
  /** Linear's workspace URL key, read off the token. */
  workspace: string;
  claimed: string;
  done: string;
  /** Only issues carrying it are this project's, when the team or project holds several repos'. */
  scopeLabel: string;
}

export const EMPTY_TRACKER: TrackerDraft = {
  kind: "github",
  apiKey: "",
  site: "",
  email: "",
  apiToken: "",
  key: "",
  workspace: "",
  claimed: "",
  done: "",
  scopeLabel: "",
};

/** A Jira site as the config wants it: the host, whatever the operator pasted around it. */
const jiraSite = (site: string): string => site.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

/** What the Test button sends, or null while the token is not filled in (or on GitHub). */
export function connectRequest(draft: TrackerDraft): TrackerConnectRequest | null {
  const key = draft.key.trim();
  if (draft.kind === "linear") {
    if (draft.apiKey.trim() === "") return null;
    return { kind: "linear", apiKey: draft.apiKey.trim(), ...(key === "" ? {} : { team: key }) };
  }
  if (draft.kind === "jira") {
    if (draft.site.trim() === "" || draft.email.trim() === "" || draft.apiToken.trim() === "") return null;
    return {
      kind: "jira",
      site: jiraSite(draft.site),
      email: draft.email.trim(),
      apiToken: draft.apiToken.trim(),
      ...(key === "" ? {} : { project: key }),
    };
  }
  return null;
}

/**
 * The claimed and done states to preselect: the names Linear and Jira ship
 * with when the team or project has them, else its first state for each, so
 * the operator changes a pick rather than starting from nothing.
 */
export function defaultStates(states: readonly string[]): { claimed: string; done: string } {
  const named = (wanted: string): string | undefined => states.find((state) => state.toLowerCase() === wanted.toLowerCase());
  return { claimed: named("In Progress") ?? states[0] ?? "", done: named("Done") ?? states.at(-1) ?? "" };
}

/** The `tracker` block the config carries, or null for GitHub, which needs none. */
export function trackerBlock(draft: TrackerDraft): Record<string, unknown> | null {
  if (draft.kind === "github") return null;
  const scope = draft.scopeLabel.trim() === "" ? {} : { scopeLabel: draft.scopeLabel.trim() };
  const states = { claimed: draft.claimed, done: draft.done };
  return draft.kind === "linear"
    ? { kind: "linear", team: draft.key.trim(), workspace: draft.workspace, ...scope, states }
    : { kind: "jira", site: jiraSite(draft.site), project: draft.key.trim(), ...scope, states };
}

/**
 * Why the setup PR cannot open yet on account of the tracker, or null when it
 * can. A Linear or Jira config whose token was never saved would give the
 * loops a tracker they cannot reach.
 */
export function trackerHold(draft: TrackerDraft, saved: boolean): string | null {
  if (draft.kind === "github") return null;
  if (draft.key.trim() === "") return `pick the ${draft.kind === "linear" ? "Linear team" : "Jira project"} first`;
  if (draft.claimed === "" || draft.done === "") return "pick the claimed and done states first";
  if (!saved) return "save the tracker connection first, so the loops can reach it";
  return null;
}
