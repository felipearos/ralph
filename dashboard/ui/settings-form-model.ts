/**
 * The Settings page's Edit form (#691): its draft, its checks and what a
 * proposal came to, kept apart from the React so they are tested without a DOM.
 *
 * The checks are a hand-kept copy of `project-config.ts`'s read of
 * `displayName`, `baseBranch` and the gate keys, message for message: the
 * page may not import the harness, and a form that offers Save for what the
 * proposal then refuses is two rules. `settings-form-parity.test.ts` runs
 * both over the same cases.
 */
import type { ProjectEdit, ProjectSettingsView, ProposeProjectResult, SetWorktreesResult } from "../contracts";
import type { Tone } from "./agents-model";

export interface ProjectForm {
  displayName: string;
  baseBranch: string;
}

// The harness's own patterns, copied: see project-config.ts's BRANCH and ONE_LINE_BREAK.
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const ONE_LINE_BREAK = /[\n\r]/;

/**
 * The draft from the checkout's config, as `GET /api/settings` reads it, not
 * the base branch's: the server diffs the edit against the fetched base and
 * refuses "nothing to change" itself. A config without a display name seeds
 * an empty input.
 */
export function projectFormFromView(view: ProjectSettingsView): ProjectForm {
  return { displayName: view.config?.displayName ?? "", baseBranch: view.config?.baseBranch ?? "" };
}

function displayNameProblem(value: string): string | null {
  return value.trim() !== "" && !ONE_LINE_BREAK.test(value) ? null : "'displayName' must be a non-empty single-line string";
}

function baseBranchProblem(value: string): string | null {
  return BRANCH.test(value) ? null : "'baseBranch' must be a branch name";
}

/** Every reason the harness would refuse these values, in its words and its order. */
export function projectFormProblems(form: ProjectForm): string[] {
  return [baseBranchProblem(form.baseBranch), displayNameProblem(form.displayName)].filter(
    (problem): problem is string => problem !== null,
  );
}

/**
 * Only the keys the draft changes, or null when it changes nothing (and Save
 * has nothing to propose). An unchanged key is left out so the PR carries
 * only the operator's edit.
 */
export function projectEditFromForm(form: ProjectForm, view: ProjectSettingsView): ProjectEdit | null {
  const seed = projectFormFromView(view);
  const edit: ProjectEdit = {};
  if (form.displayName !== seed.displayName) edit.displayName = form.displayName;
  if (form.baseBranch !== seed.baseBranch) edit.baseBranch = form.baseBranch;
  return Object.keys(edit).length === 0 ? null : edit;
}

/**
 * The problems of the keys the draft would send. A config with no display
 * name seeds an empty input, which the full check refuses; left untouched it
 * is not sent, so it must not block a base-branch edit.
 */
export function projectEditProblems(form: ProjectForm, view: ProjectSettingsView): string[] {
  const edit = projectEditFromForm(form, view);
  if (edit === null) return [];
  return [
    edit.baseBranch === undefined ? null : baseBranchProblem(edit.baseBranch),
    edit.displayName === undefined ? null : displayNameProblem(edit.displayName),
  ].filter((problem): problem is string => problem !== null);
}

/**
 * The config keys the Gates form (#692) edits. The page may not import the
 * harness's `GATE_EDIT_KEYS`; `settings-form-parity.test.ts` pins the two
 * together, so a gate-related key the harness adds fails until this form
 * edits it too.
 */
export const GATES_FORM_KEYS = ["gates", "requiredChecks", "refuseFiles"] as const;

/** The Gates form's draft: the gates as rows, the two lists as textareas, one entry per line. */
export interface GatesForm {
  gates: { name: string; command: string }[];
  requiredChecks: string;
  refuseFiles: string;
}

// The harness's own gate-name pattern and reserved names, copied: see
// project-config.ts's GATE_NAME and RESERVED_GATE_NAMES (the parity test pins the list).
const GATE_NAME = /^[a-z][a-z0-9-]*$/;
export const RESERVED_GATE_NAMES: readonly string[] = ["env", "names", "rate-limit-max-seconds", "retry-max", "retry-max-seconds", "retry-seconds"];
const gateVar = (name: string): string => `RALPH_GATE_${name.toUpperCase().replace(/-/g, "_")}`;

export function gatesFormFromView(view: ProjectSettingsView): GatesForm {
  const config = view.config;
  return {
    gates: (config?.gates ?? []).map((gate) => ({ ...gate })),
    requiredChecks: (config?.requiredChecks ?? []).join("\n"),
    refuseFiles: (config?.refuseFiles ?? []).join("\n"),
  };
}

/**
 * A textarea as the list it stands for. Blank lines and the spaces around an
 * entry are dropped: they are how a textarea is typed in, not entries the
 * operator meant to send.
 */
export function gatesFormList(text: string): string[] {
  return text
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export function gatesFormLists(form: GatesForm): { requiredChecks: string[]; refuseFiles: string[] } {
  return { requiredChecks: gatesFormList(form.requiredChecks), refuseFiles: gatesFormList(form.refuseFiles) };
}

/**
 * `path.normalize` for a relative POSIX path, without node:path (the page runs
 * in a browser): only whether the result climbs out matters here.
 */
function climbsOut(value: string): boolean {
  const kept: string[] = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." && kept.length > 0 && kept[kept.length - 1] !== "..") kept.pop();
    else kept.push(segment);
  }
  return kept[0] === "..";
}

// A copy of project-config.ts's relativePathProblem, message for message.
function relativePathProblem(value: string): string | null {
  if (value.trim() === "") return "must be a non-empty string";
  if (/[\s\0]/.test(value)) return "must not contain whitespace";
  if (value.startsWith("/")) return "must be relative to the project root";
  if (climbsOut(value)) return "must stay inside the project";
  return null;
}

// The server's own checks (dashboard/agents.ts's gateNameProblems): the
// config's name → command object cannot hold an empty or a repeated name.
export function gateListProblems(gates: GatesForm["gates"]): string[] {
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
}

// Deduplicated: two rows sharing a bad name are one entry in the harness's
// name -> command object, so it names the problem once, and so does the form.
function gatesProblems(gates: GatesForm["gates"]): string[] {
  const problems = gateListProblems(gates);
  for (const { name, command } of gates) {
    // An empty name is already refused above; the harness's checks are of a named gate.
    if (name.trim() === "") continue;
    if (!GATE_NAME.test(name)) problems.push(`gate name '${name}' must be lowercase kebab-case`);
    else if (RESERVED_GATE_NAMES.includes(name)) problems.push(`gate name '${name}' is reserved: the harness exports its own ${gateVar(name)}`);
    if (command.trim() === "" || ONE_LINE_BREAK.test(command)) problems.push(`'gates.${name}' must be a one-line command`);
  }
  return [...new Set(problems)];
}

function requiredChecksProblems(checks: string[]): string[] {
  // One message for the whole list, as the harness gives it. After the split
  // no entry is blank or multi-line, so this holds only for a list built by hand.
  return checks.every((name) => name.trim() !== "" && !ONE_LINE_BREAK.test(name)) ? [] : ["'requiredChecks' must be an array of check names"];
}

function refuseFilesProblems(paths: string[]): string[] {
  return paths.flatMap((path, index) => {
    const problem = relativePathProblem(path);
    return problem === null ? [] : [`'refuseFiles[${index}]' ${problem}`];
  });
}

/** Every reason the server or the harness would refuse this draft, all at once, in their words. */
export function gatesFormProblems(form: GatesForm): string[] {
  const lists = gatesFormLists(form);
  return [...refuseFilesProblems(lists.refuseFiles), ...requiredChecksProblems(lists.requiredChecks), ...gatesProblems(form.gates)];
}

const sameList = <T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean): boolean =>
  a.length === b.length && a.every((item, index) => same(item, b[index] as T));

/**
 * Only the keys the draft changes, or null when it changes nothing. Lists
 * are compared by value and order: reordering gates changes the order they
 * run in, so it is an edit.
 */
export function gatesEditFromForm(form: GatesForm, view: ProjectSettingsView): ProjectEdit | null {
  const seed = gatesFormFromView(view);
  const lists = gatesFormLists(form);
  const seedLists = gatesFormLists(seed);
  const edit: ProjectEdit = {};
  if (!sameList(form.gates, seed.gates, (a, b) => a.name === b.name && a.command === b.command)) {
    edit.gates = form.gates.map((gate) => ({ ...gate }));
  }
  if (!sameList(lists.requiredChecks, seedLists.requiredChecks, (a, b) => a === b)) edit.requiredChecks = lists.requiredChecks;
  if (!sameList(lists.refuseFiles, seedLists.refuseFiles, (a, b) => a === b)) edit.refuseFiles = lists.refuseFiles;
  return Object.keys(edit).length === 0 ? null : edit;
}

/** The problems of the keys the draft would send, as `projectEditProblems` does for its form. */
export function gatesEditProblems(form: GatesForm, view: ProjectSettingsView): string[] {
  const edit = gatesEditFromForm(form, view);
  if (edit === null) return [];
  return [
    ...(edit.refuseFiles === undefined ? [] : refuseFilesProblems(edit.refuseFiles)),
    ...(edit.requiredChecks === undefined ? [] : requiredChecksProblems(edit.requiredChecks)),
    ...(edit.gates === undefined ? [] : gatesProblems(edit.gates)),
  ];
}

/**
 * The config keys the Worktree setup form (#694) edits, pinned to the
 * harness's `WORKTREE_SETUP_EDIT_KEYS` by `settings-form-parity.test.ts`.
 */
export const WORKTREE_SETUP_FORM_KEYS = ["worktreeSetup"] as const;

/**
 * The Worktree setup form's draft: one row per step, in the order they run.
 * The limit is the text its input holds; blank means the harness's default.
 */
export interface SetupForm {
  steps: { name: string; command: string; timeoutSeconds: string; installsDependencies: boolean }[];
}

// Copied, not imported: project-config.ts's WORKTREE_SETUP_MAX_SECONDS and
// WORKTREE_SETUP_DEFAULT_SECONDS. The sum cap exists because the dashboard runs
// every step inside one request its server drops after 255 s idle.
export const SETUP_MAX_SECONDS = 150;
export const SETUP_DEFAULT_SECONDS = 120;

export function setupFormFromView(view: ProjectSettingsView): SetupForm {
  return {
    steps: (view.config?.worktreeSetup ?? []).map((step) => ({
      name: step.name,
      command: step.command,
      timeoutSeconds: String(step.timeoutSeconds),
      installsDependencies: step.installsDependencies,
    })),
  };
}

/**
 * The limit a row's input stands for, as it would sit in the config: absent
 * when blank (the default), a number when the text reads as one, else the text
 * itself, which the harness then refuses as not a whole number.
 */
export function setupTimeoutValue(text: string): number | string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : text;
}

const validLimit = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= SETUP_MAX_SECONDS;

/** Every step's limit summed, the default for a blank one; a bad limit counts nothing, as in the harness. */
export function setupTotalSeconds(form: SetupForm): number {
  return form.steps.reduce((total, step) => {
    const limit = setupTimeoutValue(step.timeoutSeconds);
    if (limit === undefined) return total + SETUP_DEFAULT_SECONDS;
    return validLimit(limit) ? total + limit : total;
  }, 0);
}

// A copy of project-config.ts's worktreeSetupProblems, message for message,
// for the steps a form can build (always objects, no unknown keys, a boolean flag).
function setupStepsProblems(steps: SetupForm["steps"]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  steps.forEach((step, index) => {
    const at = `worktreeSetup[${index}]`;
    if (!GATE_NAME.test(step.name)) {
      problems.push(`'${at}.name' must be lowercase kebab-case; got ${JSON.stringify(step.name)}`);
    } else if (seen.has(step.name)) {
      problems.push(`'${at}.name' '${step.name}' is a duplicate; every step needs its own name`);
    } else {
      seen.add(step.name);
    }
    if (step.command.trim() === "" || ONE_LINE_BREAK.test(step.command)) problems.push(`'${at}.command' must be a one-line command`);
    const limit = setupTimeoutValue(step.timeoutSeconds);
    if (limit !== undefined && !validLimit(limit)) {
      problems.push(`'${at}.timeoutSeconds' must be a whole number of seconds from 1 to ${SETUP_MAX_SECONDS}; got ${JSON.stringify(limit)}`);
    }
  });
  const total = setupTotalSeconds({ steps });
  if (total > SETUP_MAX_SECONDS) {
    problems.push(
      `'worktreeSetup' may take at most ${SETUP_MAX_SECONDS} s in all (every step's 'timeoutSeconds', ${SETUP_DEFAULT_SECONDS} when unset), ` +
        `because the dashboard runs the steps inside one request and its server times out an idle request at 255 s; these add up to ${total} s`,
    );
  }
  return problems;
}

/** Every reason the harness would refuse this draft, all at once, in its words and order. */
export function setupFormProblems(form: SetupForm): string[] {
  return setupStepsProblems(form.steps);
}

/**
 * The edit Save sends, or null when the draft holds the seed's steps by value
 * and order (reordering changes the order they run in, so it is an edit, and
 * so is an emptied list: it clears the steps). The steps go out complete, a
 * blank limit as the default, since the route takes all four keys.
 */
export function setupEditFromForm(form: SetupForm, view: ProjectSettingsView): ProjectEdit | null {
  const seed = setupFormFromView(view);
  const limitOf = (text: string): number | string => setupTimeoutValue(text) ?? SETUP_DEFAULT_SECONDS;
  const same = sameList(
    form.steps,
    seed.steps,
    (a, b) =>
      a.name === b.name && a.command === b.command && limitOf(a.timeoutSeconds) === limitOf(b.timeoutSeconds) && a.installsDependencies === b.installsDependencies,
  );
  if (same) return null;
  return {
    worktreeSetup: form.steps.map((step) => ({
      name: step.name,
      command: step.command,
      // Only sent once the problems are empty, so the limit is a whole number here.
      timeoutSeconds: limitOf(step.timeoutSeconds) as number,
      installsDependencies: step.installsDependencies,
    })),
  };
}

/** The problems of the draft when it would send anything, as `gatesEditProblems` does for its form. */
export function setupEditProblems(form: SetupForm, view: ProjectSettingsView): string[] {
  return setupEditFromForm(form, view) === null ? [] : setupFormProblems(form);
}

export interface ProjectSaveNotice {
  tone: Tone;
  text: string;
  url?: string;
}

/**
 * A PR that opened with warnings (a required check nothing has reported, say)
 * is not refused, but it is not plainly good either: the operator should read
 * them before merging.
 */
function withWarnings(text: string, url: string, warnings: readonly string[]): ProjectSaveNotice {
  if (warnings.length === 0) return { tone: "good", text, url };
  return { tone: "warn", text: `${text} Warnings: ${warnings.join("; ")}`, url };
}

export function projectSaveNotice(result: ProposeProjectResult): ProjectSaveNotice {
  switch (result.outcome) {
    case "proposed":
      return withWarnings("Proposed. The change applies once the PR is merged and the loops are restarted.", result.pr.url, result.warnings);
    case "reused":
      return withWarnings("A PR for this change is already open. It applies once that PR is merged and the loops are restarted.", result.pr.url, result.warnings);
    case "refused":
      return { tone: "bad", text: `Not proposed: ${result.why}` };
    case "pr-failed":
      return { tone: "warn", text: `The settings branch may be pushed, but the PR was not opened: ${result.why}` };
  }
}

/**
 * The Agent worktrees form (#693): one input holding the project's own folder.
 * The default folder is the placeholder, not the value, so an empty input
 * reads as "no folder of its own".
 */
export function worktreesFormFromView(view: ProjectSettingsView): string {
  return view.worktreesDefault ? "" : view.worktreesDir;
}

/**
 * The shape checks only, in `checkWorktreesFolder`'s words where it has them:
 * whether the folder is writable or inside another project's checkout only
 * the server can tell. The text is checked as sent, untrimmed, so the page
 * and the server see the same string; `settings-form-parity.test.ts` holds the
 * wording to the server's.
 */
export function worktreesFolderProblems(text: string): string[] {
  if (text.trim() === "") return ["enter a folder, or use the default"];
  if (!text.startsWith("/")) return [`must be an absolute path; got '${text}'`];
  return [];
}

/** The body Save sends, or null when the input still holds the folder in effect. */
export function worktreesEditFromForm(text: string, view: ProjectSettingsView): { folder: string } | null {
  return text === worktreesFormFromView(view) ? null : { folder: text };
}

export function worktreesSaveNotice(result: SetWorktreesResult): ProjectSaveNotice {
  return {
    tone: "good",
    text: `Saved: new worktrees go in ${result.worktreesDir}${result.worktreesDefault ? " (default)" : ""}`,
  };
}
