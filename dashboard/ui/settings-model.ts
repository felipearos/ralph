/**
 * The Settings page's read-only overview (#689), as the page draws it: the
 * project's fields, the config's problems, and one row per worktree. Pure, so
 * every state the server can answer is tested without React.
 */
import type { ProjectSettingsView, WorktreeSetupStepConfig, WorktreeUse } from "../contracts";
import { chileDateTime } from "./chile-time";

/** The shell's tone words; kept as a local union so this module stays free of React. */
export type SettingsTone = "good" | "warn" | "neutral";

export interface SettingsField {
  label: string;
  value: string;
  /** A path, shown in a monospace face. */
  mono: boolean;
}

export interface SettingsRow {
  path: string;
  /** The branch, or "detached". */
  branch: string;
  /** The loop that owns the worktree, or null. */
  loop: string | null;
  use: WorktreeUse;
  tone: SettingsTone;
  /** "main checkout", "orphaned", "prunable", joined; null when there is nothing to add. */
  detail: string | null;
}

/** One gate command as the harness reads it from the config. */
export interface SettingsGate {
  name: string;
  command: string;
}

export interface SettingsModel {
  /** The project's fields; null when the config is invalid, and `problems` says why. */
  fields: SettingsField[] | null;
  problems: string[];
  /** Where the checkout and its worktrees live, shown whatever the config's state. */
  location: SettingsField[];
  /** Null when the worktrees could not be listed; `worktreesProblem` says why. */
  rows: SettingsRow[] | null;
  worktreesProblem: string | null;
  /** The config's gates, in order; null when the config is invalid. */
  gates: SettingsGate[] | null;
  /** The CI checks the config requires, in order; null when the config is invalid. */
  requiredChecks: string[] | null;
  /** The files whose presence refuses a loop's startup, in order; null when the config is invalid. */
  refuseFiles: string[] | null;
  /** The worktree setup steps (#694), in the order they run; null when the config is invalid. */
  worktreeSetup: WorktreeSetupStepConfig[] | null;
}

// A worktree a live loop holds reads good; one nobody owns is worth a look.
const USE_TONE: Record<WorktreeUse, SettingsTone> = { "in-use": "good", idle: "neutral", unowned: "warn" };

/** The added stamp the way the intake page shows its dates; a missing one is "unknown", not a dash. */
function addedOn(addedAt: string | null): string {
  if (addedAt === null) return "unknown";
  const stamp = chileDateTime(addedAt);
  return stamp === "-" ? "unknown" : stamp;
}

/**
 * An older bridge pushes a snapshot whose config predates `gates` and
 * `requiredChecks` (#690): a missing or malformed list reads as empty rather
 * than breaking the page.
 */
function gatesOf(config: NonNullable<ProjectSettingsView["config"]>): SettingsGate[] {
  const gates: unknown = (config as Partial<typeof config>).gates;
  if (!Array.isArray(gates)) return [];
  return gates
    .filter((gate): gate is SettingsGate => typeof gate?.name === "string" && typeof gate?.command === "string")
    .map((gate) => ({ name: gate.name, command: gate.command }));
}

function stringsOf(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.filter((entry): entry is string => typeof entry === "string");
}

function requiredChecksOf(config: NonNullable<ProjectSettingsView["config"]>): string[] {
  return stringsOf((config as Partial<typeof config>).requiredChecks);
}

// `refuseFiles` came later still (#692), so an older snapshot lacks it too.
function refuseFilesOf(config: NonNullable<ProjectSettingsView["config"]>): string[] {
  return stringsOf((config as Partial<typeof config>).refuseFiles);
}

// `worktreeSetup` came with #694, so an older snapshot lacks it; a step
// missing one of its four keys is dropped rather than drawn half-filled.
function worktreeSetupOf(config: NonNullable<ProjectSettingsView["config"]>): WorktreeSetupStepConfig[] {
  const steps: unknown = (config as Partial<typeof config>).worktreeSetup;
  if (!Array.isArray(steps)) return [];
  return steps
    .filter(
      (step): step is WorktreeSetupStepConfig =>
        typeof step?.name === "string" &&
        typeof step?.command === "string" &&
        typeof step?.timeoutSeconds === "number" &&
        typeof step?.installsDependencies === "boolean",
    )
    .map((step) => ({ name: step.name, command: step.command, timeoutSeconds: step.timeoutSeconds, installsDependencies: step.installsDependencies }));
}

export function settingsModel(view: ProjectSettingsView): SettingsModel {
  const config = view.config;
  const fields: SettingsField[] | null =
    config === null
      ? null
      : [
          { label: "Display name", value: config.displayName ?? view.project, mono: false },
          { label: "Repository", value: config.repo, mono: true },
          { label: "Owner", value: config.owner ?? "unknown", mono: false },
          { label: "Base branch", value: config.baseBranch, mono: true },
        ];
  const location: SettingsField[] = [
    { label: "Main checkout", value: view.checkout.path, mono: true },
    { label: "Added", value: addedOn(view.checkout.addedAt), mono: false },
    // Says whether the folder is the project's own or the dashboard's default.
    { label: "Agent worktrees folder", value: `${view.worktreesDir}${view.worktreesDefault ? " (default)" : ""}`, mono: true },
  ];
  const rows =
    view.worktrees === null
      ? null
      : view.worktrees.map((worktree): SettingsRow => {
          const details = [worktree.main ? "main checkout" : null, worktree.reconciliation].filter(
            (detail): detail is string => detail !== null,
          );
          return {
            path: worktree.path,
            branch: worktree.branch ?? "detached",
            loop: worktree.loop,
            use: worktree.use,
            // The project's own checkout is unowned by design, not a stray worth a look.
            tone: worktree.main && worktree.use === "unowned" ? "neutral" : USE_TONE[worktree.use],
            detail: details.length === 0 ? null : details.join(", "),
          };
        });
  return {
    fields,
    problems: config === null ? view.problems : [],
    location,
    rows,
    // A listing that failed with no reason still says something rather than leaving a blank where the table was.
    worktreesProblem: view.worktrees === null ? (view.worktreesProblem ?? "the worktrees could not be listed") : null,
    gates: config === null ? null : gatesOf(config),
    requiredChecks: config === null ? null : requiredChecksOf(config),
    refuseFiles: config === null ? null : refuseFilesOf(config),
    worktreeSetup: config === null ? null : worktreeSetupOf(config),
  };
}
