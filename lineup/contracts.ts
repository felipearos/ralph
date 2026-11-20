/**
 * The lineup editor's own vocabulary, on this side of the process boundary.
 *
 * Nothing here imports a ralph TypeScript module. The shapes below are the
 * *narrowed* copies of what the runtime's JSON actually contains: the adapter
 * chooses the CLI invocations, owns their environment and narrows every
 * response, and it hands the HTTP layer these types. That is what keeps the
 * editor extractable — move the files, repoint the adapter, and the shape above
 * the seam is unchanged.
 *
 * The unions are declared as runtime arrays plus a type derived from them so the
 * adapter can validate JSON against the same list the type is built from; a
 * second, hand-written list is how a reader and a validator come to disagree.
 */

/**
 * A plain environment map.
 *
 * The app's `NodeJS.ProcessEnv` is augmented by Next.js to require `NODE_ENV`,
 * which the editor's own signatures have no business demanding. This keeps the
 * tool's public shape free of the app's type graph, the same way it stays free
 * of the app's imports.
 */
export type Env = Record<string, string | undefined>;

/**
 * Parsed `models.json` — or, above the adapter, one project's view of it: a
 * `default` block and one block per loop of that project.
 */
export type JsonObject = Record<string, unknown>;

/**
 * The project the editor edits when a request names none: the one whose loop
 * blocks the pre-project `models.json` held at its top level.
 */
export const DEFAULT_PROJECT = "loggd";

/**
 * `role` is the project's `@<role>` block — its default for every loop in that
 * role — and `project` its plain `default`.
 */
export const LINEUP_SOURCES = ["env", "loop", "role", "project", "default"] as const;
export type LineupSource = (typeof LINEUP_SOURCES)[number];

/** One stage as the resolver reports it from `models.ts --json`. */
export interface ResolvedStage {
  model: string;
  runner: string;
  effort?: string;
  fallback?: string[];
  fallbackEfforts?: Record<string, string>;
  source: LineupSource;
}

/** The resolved lineup for one loop name. */
export interface ResolvedLineup {
  /** The project the lineup was resolved for, when the resolver reports it. */
  project?: string;
  /**
   * The role the loop was resolved as, which is what decides the stage set
   * `stages` holds. Absent from an older resolver, which had one set for every
   * loop.
   */
  role?: string;
  loop: string;
  stages: Record<string, ResolvedStage>;
}

export const PROVIDER_PREFIXES = ["required", "forbidden", "optional"] as const;
export type ProviderPrefix = (typeof PROVIDER_PREFIXES)[number];

/**
 * The resolver's rules as reported by `models.ts --schema`.
 *
 * A form constrains its choices from this data — the per-stage runner set, the
 * Agent-tool alias set, the model-id pattern and provider rule — rather than
 * hardcoding a capability map or an alias list that would drift from the
 * validator.
 */
export interface RuntimeSchema {
  /**
   * The role these rules are for: `stages` is that role's set, not every stage
   * the resolver knows. Absent from an older resolver.
   */
  role?: string;
  stages: string[];
  runners: string[];
  runnersFor: Record<string, string[]>;
  effortRunnersFor?: Record<string, string[]>;
  agentToolStages: string[];
  /**
   * The named agent each Agent-tool stage runs as on `claude`; absent from an
   * older resolver, whose Agent-tool stages took an alias only.
   */
  agentNames?: Record<string, string>;
  /** The prefix of a full id a named agent takes; published with `agentNames`. */
  claudeIdPrefix?: string;
  aliases: string[];
  /** The full model each alias stands for today; absent from an older resolver. */
  aliasTargets: Record<string, string>;
  defaultFallback: string;
  defaultFallbacks: string[];
  modelId: {
    pattern: string;
    providerPrefix: Record<string, ProviderPrefix>;
  };
}

export const SHADOW_FIELDS = ["model", "runner", "effort"] as const;
export type ShadowField = (typeof SHADOW_FIELDS)[number];

/**
 * An environment override that would win over the file.
 *
 * The resolver never says *which* variable shadowed a stage, so the adapter
 * derives it from the environment it hands the CLI. `variable` is the exact
 * name the operator must unset — the legacy `RALPH_CODER_MODEL` for the
 * executor included.
 */
export interface Shadow {
  stage: string;
  field: ShadowField;
  variable: string;
}

/** The verdict `models.ts --validate` prints, as a value rather than an exit code. */
export interface ValidationResult {
  valid: boolean;
  problems: string[];
}

/**
 * What `GET /api/lineup` returns: the project's view of the file, the resolved
 * lineup, the rules, the shadows.
 */
export interface LineupRead {
  root: string;
  project: string;
  loop: string;
  /** The project's view: its `default` (own, else the file's) and its loop blocks. */
  config: JsonObject;
  resolved: ResolvedLineup;
  schema: RuntimeSchema;
  shadows: Shadow[];
}

/** What `POST /api/lineup/preview` returns. `resolved` is null when the candidate is invalid. */
export interface LineupPreview {
  root: string;
  project: string;
  loop: string;
  valid: boolean;
  problems: string[];
  resolved: ResolvedLineup | null;
  schema: RuntimeSchema;
  shadows: Shadow[];
}

/** The fields one edit sets on a stage; `null` removes `effort`/`fallback`. */
export interface StageChange {
  runner?: string;
  model?: string;
  effort?: string | null;
  fallback?: string[] | null;
  fallbackEfforts?: Record<string, string> | null;
}

/**
 * One edit to a candidate: set a stage (runner and model together, so a runner
 * change never strands the block's model), create a named loop's complete
 * block from `default`, or remove a named loop's block so it falls back.
 */
export type LineupEditOp =
  | { kind: "stage"; stage: string; change: StageChange }
  | { kind: "create" }
  | { kind: "remove" };

/** What `POST /api/lineup/edit` returns: the edited candidate and its re-resolved preview. */
export interface LineupEdit extends LineupPreview {
  config: JsonObject;
}

/** What `POST /api/lineup/save` returns; on reject the caller also gets a 400. */
export interface LineupSave {
  root: string;
  project: string;
  loop: string;
  valid: boolean;
  problems: string[];
}

/** One model a harness offers, as `harness-catalog.ts --json` reports it. */
export interface CatalogModelView {
  id: string;
  upgradeTo?: string;
  label?: string;
  efforts?: string[];
  contextWindow?: number;
}

/** What one harness can run, or why it could not be asked. */
export interface RunnerCatalogView {
  available: boolean;
  reason: string | null;
  source: string;
  version: string | null;
  models: CatalogModelView[];
  efforts: string[];
  /** Alias to the id it resolves to today, for a harness that has aliases. */
  aliases: Record<string, string>;
}

/** What `GET /api/lineup/catalog` returns: every runner's catalogue, keyed by runner name. */
export interface HarnessCatalogView {
  fetchedAt: string;
  runners: Record<string, RunnerCatalogView>;
}

/** What one block's `updates` says, as `model-updates.ts --json` reports it (#851). */
export const MODEL_UPDATE_POLICIES = ["ask", "auto", "pinned"] as const;
export type ModelUpdatePolicy = (typeof MODEL_UPDATE_POLICIES)[number];

/** The operator's answers for one block; each is `model-updates.ts --answer`'s. */
export const MODEL_UPDATE_ANSWERS = ["update", "snooze", "skip", "pin", "auto", "ask"] as const;
export type ModelUpdateAnswer = (typeof MODEL_UPDATE_ANSWERS)[number];

/** One stage on an older Claude id, and the id it would move to. */
export interface ModelUpdateStageView {
  stage: string;
  model: string;
  latest: string;
}

/** One `models.json` block: its outdated stages, its policy, and whether to ask now. */
export interface ModelUpdateAgentView {
  /** Null for the file's own `default` block, which every project falls back to. */
  project: string | null;
  block: string;
  policy: ModelUpdatePolicy;
  skip: string[];
  snoozedUntil: string | null;
  /** The block's `updates` was unreadable, so it is treated as `pinned`. */
  malformed: boolean;
  outdated: ModelUpdateStageView[];
  ask: boolean;
}

/** What `GET /api/lineup/updates` returns. */
export interface ModelUpdatesView {
  root: string;
  project: string;
  /** Family to latest id, as this host's Claude Code resolves its aliases. */
  latest: Record<string, string>;
  latestSource: string;
  agents: ModelUpdateAgentView[];
}

/** One stage an answer moved. */
export interface ModelUpdateChangeView {
  project: string | null;
  block: string;
  stage: string;
  from: string;
  to: string;
}

/** What `POST /api/lineup/updates/answer` returns. */
export interface ModelUpdateResult {
  root: string;
  project: string | null;
  block: string;
  answer: ModelUpdateAnswer;
  changes: ModelUpdateChangeView[];
  /** The block as it reads after the answer; null when the CLI could not report it. */
  agent: ModelUpdateAgentView | null;
}

/** The same shape both sides of the adapter use for an object check. */
export const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
