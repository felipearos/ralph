/**
 * Types for `lineup-view.js`, the page's pure view helpers and HTTP client.
 *
 * The module itself is plain JavaScript so the page is served with no build
 * step; this declaration lets the Vitest suites import it typed. Every shape is
 * the editor's own HTTP view model from `../contracts` — nothing here names a
 * CLI command, flag or JSON shape of the runtime.
 */
import type {
  JsonObject,
  LineupEdit,
  LineupEditOp,
  LineupPreview,
  LineupRead,
  LineupSave,
  LineupSource,
  ResolvedLineup,
  RuntimeSchema,
  Shadow,
  StageChange,
} from "../contracts";

/** The block every loop without its own falls back to. */
export const DEFAULT_LOOP: "default";

/** The apply-timing copy the page shows beside save. */
export const APPLY_TIMING: string;

/** One stage's fields as the file has them; any may be absent in a hand edit. */
export interface StageValues {
  runner?: string;
  model?: string;
  effort?: string;
  fallback?: string[];
}

/** A stage's form state. An empty fallback array means "use the default chain". */
export interface StageDraft {
  runner: string;
  model: string;
  effort: string;
  fallback: string[];
}

/** Which controls a stage offers for a runner, all derived from the runtime schema. */
export interface StageControls {
  runners: string[];
  effort: boolean;
  fallback: boolean;
  /** The only models the stage accepts on this runner, or null for a free model id. */
  modelChoices: string[] | null;
  fallbackChoices: string[];
  defaultFallback: string;
  defaultFallbacks: string[];
}

export interface PreviewRow {
  stage: string;
  runner: string;
  model: string;
  effort?: string;
  fallback?: string[];
  source: LineupSource;
  /** The live environment overrides that win over the file for this stage. */
  overrides: Shadow[];
}

export function loopNames(config: JsonObject, extra?: readonly string[]): string[];
export function hasBlock(config: JsonObject, loop: string): boolean;
export function stageValues(config: JsonObject, loop: string, stage: string): StageValues | null;
export function draftFor(config: JsonObject, loop: string, stage: string): StageDraft;
export function stageControls(schema: RuntimeSchema, stage: string, runner: string): StageControls;
export function modelProblem(schema: RuntimeSchema, stage: string, runner: string, model: string): string | null;
export function draftProblems(schema: RuntimeSchema, stage: string, draft: StageDraft): string[];
export function buildChange(schema: RuntimeSchema, stage: string, draft: StageDraft): StageChange;
export function previewRows(schema: RuntimeSchema, resolved: ResolvedLineup, shadows: readonly Shadow[]): PreviewRow[];
export function shadowWarning(shadow: Shadow): string;

/** A non-2xx response the API did not answer with a view model. */
export class LineupHttpError extends Error {
  readonly status: number;
  readonly kind: string;
}

export interface Selector {
  root?: string;
  loop?: string;
}

export interface LineupClient {
  roots(): Promise<string[]>;
  read(selector?: Selector): Promise<LineupRead>;
  preview(input: Selector & { config: JsonObject }): Promise<LineupPreview>;
  edit(input: Selector & { config: JsonObject; edit: LineupEditOp }): Promise<LineupEdit>;
  /** A refused candidate is a returned verdict (`valid: false`), not a thrown error. */
  save(input: Selector & { config: JsonObject }): Promise<LineupSave>;
}

export function createLineupClient(fetchImpl: typeof fetch, base?: string): LineupClient;
