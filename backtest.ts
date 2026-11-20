/**
 * `experiments.ts backtest <config> --dry-run` (felipearos/ralph#532): the
 * batch a clerk backtest would replay — the person tickets the clerk moved to
 * the team board whose work then merged as human PRs — validated, built and
 * printed, with no model call and no write anywhere but the clerk's local PR
 * cache, which `readPulls` refreshes when it is stale.
 *
 * Each ticket is frozen as it stood when the first human PR was opened: the
 * comments after it describe the answer the trial is meant to find.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isPlaceholderKey } from "./clerk/apply";
import { JIRA_TOKEN_ENV, JiraError, jiraClient, jqlString, parseJiraToken, type JiraClient } from "./clerk/jira";
import { clerkMetricsPath, readEvents, type MovedEvent } from "./clerk/metrics";
import { PULLS_PER_REPO, pullsCachePath, pullsNaming, readPulls, spawnGh, type GhRunner } from "./clerk/pulls";
import { clerkStorePath } from "./clerk/store";
import type { ContestedRule, JudgeSpec } from "./eval-panel";
import { fetchFromTracker } from "./issue-spec";
import { clerkRules, loadProjectConfig } from "./project-config";
import { projectRosterEntries, roleOf } from "./roster";
import { keyedProjectTracker } from "./tracker/project";
import type { Tracker } from "./tracker/types";

export interface BacktestConfig {
  project: string;
  /** The clerk whose moves are sampled; "" on a config with a PR `source`. */
  clerk: string;
  sample: {
    cap: number; since: string | null; repos: string[] | null;
    /** What the permanent ledger already holds (`backtest-ledger.ts`): set in code, never in the config file. Neither is sampled again. */
    recorded?: { tickets: string[]; prs: string[] };
  };
  /** Legacy arm C: a named lineup beside the live one. A config names this or `arms`, never both. */
  /**
   * Replay named merged PRs instead of sampling a clerk's moves (#801): the
   * A/B on one PR. Absent on a clerk backtest, whose `clerk` and `sample` say
   * what to replay; its `sample` is then a placeholder.
   */
  source?: PrSource | SetSource;
  lineup: string | null;
  /**
   * The arms, each a lineup plus an optional prompt overlay (#801). Absent on
   * a config that names none: `configArms` then derives B (live) and C
   * (`lineup`), and a run directory hashed before #801 keeps its hash.
   */
  arms?: ArmConfig[];
  caps: { trialMinutes: number; batchMinutes: number };
  /**
   * More trials per arm for a case whose arms disagree (#801), 0 to 3. Absent:
   * 2 on a PR source, where one case is the whole answer; 0 on a clerk
   * backtest, so the nightly batch costs what it did.
   */
  repeats?: number;
  /**
   * The Claude usage share (0–100) at or over which a trial waits for the
   * window to reset, so live loops keep priority (#801). Absent: 90; null: off.
   */
  usageGuard?: number | null;
  /**
   * This set run measures the test set's noise floor (#859): N identical live
   * arms over the whole set. Left in `trialConfig`, so in the run-dir hash, on
   * purpose: `measuredAt` is the nonce that makes a second measurement of an
   * unchanged set a new run directory rather than a resume of the first.
   */
  noiseFloor?: { measuredAt: string };
  rates: { inputPerMTok: number; outputPerMTok: number } | null;
  /** `owner/name` → an absolute path to a local checkout of that repo: where the run builds each trial from. */
  sources: Record<string, string>;
  /** How the scoring step reads an arm's tree; never changes a trial. */
  scoring: {
    testGlobs: string[]; testCommand: string; setup: string | null; review: boolean;
    /**
     * The blind judge panel; null when the config turns it off. A null seed
     * means the run's id. With `panel`, its judges; with `model` alone, one
     * Claude judge on it (#535); with neither (`defaultPanel`), Opus plus the
     * Codex model models.json names (#817).
     */
    judge: { model: string; seed: string | null; panel?: JudgeSpec[]; defaultPanel?: true; contested?: ContestedRule } | null;
    /** The unblinded analyst after the panel (#801); null when turned off. Absent from configs parsed before it: on. */
    analyst?: { model: string } | null;
  };
}

/**
 * The merged PRs one case replays: one ticket's work, which may span PRs.
 * `ticket` names the ticket they resolved — `#12` on GitHub, `OA-12` on the
 * project's Linear or Jira tracker; null reads it from the PRs' closing issue.
 */
export interface PrSource { kind: "pr"; repo: string; prs: number[]; ticket: string | null }

/**
 * The project's test set (#854): the cases committed under `evals/<projectId>/`
 * in ralph's repo. `tags` empty is no tag filter, `cases` empty no hand-picked
 * subset; both empty run every active case.
 */
export interface SetSource {
  kind: "set"; tags: string[]; cases: string[];
  /**
   * The set's commit the start read, pinned by `completePlan`. It is part of
   * the run directory's hash, so a start after the set changed runs the set as
   * it stands instead of resuming the old run's stored sample. Absent: whatever
   * the set is when sampled.
   */
  version?: string | null;
}

/** At most this many PRs make one case: more is a project, not a ticket. */
const MAX_SOURCE_PRS = 10;
/** At most this many tags or case ids on a set source. */
const MAX_SET_ENTRIES = 200;
const CASE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseSetList(value: unknown, name: string, valid: (entry: unknown) => boolean, what: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_SET_ENTRIES || !value.every(valid)) fail(`source.${name} must list at most ${MAX_SET_ENTRIES} ${what}`);
  return [...new Set(value as string[])];
}

function parseSource(value: unknown): PrSource | SetSource {
  if (!object(value)) return fail("source must be an object with kind, repo and prs");
  if (value.kind === "set") {
    onlyKeys(value, ["kind", "tags", "cases", "version"], "source.");
    if (value.version !== undefined && value.version !== null && (typeof value.version !== "string" || !/^[0-9a-f]{7,64}$/.test(value.version))) {
      fail("source.version must be the set's commit sha, or null for an uncommitted set");
    }
    return {
      kind: "set",
      tags: parseSetList(value.tags, "tags", (tag) => typeof tag === "string" && tag !== "", "non-empty tags"),
      cases: parseSetList(value.cases, "cases", (id) => typeof id === "string" && CASE_ID.test(id), "kebab-case case ids"),
      ...(value.version === undefined ? {} : { version: value.version as string | null }),
    };
  }
  onlyKeys(value, ["kind", "repo", "prs", "ticket"], "source.");
  if (value.kind !== "pr") fail("source.kind must be pr or set");
  if (typeof value.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(value.repo)) fail("source.repo must be an owner/name repo");
  if (!Array.isArray(value.prs) || value.prs.length === 0 || value.prs.length > MAX_SOURCE_PRS
    || value.prs.some((pr) => typeof pr !== "number" || !Number.isSafeInteger(pr) || pr < 1)) {
    fail(`source.prs must list 1 to ${MAX_SOURCE_PRS} PR numbers`);
  }
  let ticket: string | null = null;
  if (value.ticket !== undefined && value.ticket !== null) {
    if (typeof value.ticket !== "string" || !/^(?:#\d+|[A-Z][A-Z0-9_]*-\d+)$/.test(value.ticket)) fail("source.ticket must be #<number> on GitHub or a tracker key such as OA-12");
    ticket = value.ticket as string;
  }
  return { kind: "pr", repo: value.repo as string, prs: [...new Set(value.prs as number[])], ticket };
}

/** One arm: `lineup` is `live` or a lineup file's name; `overlay` an absolute path to a prompt overlay directory. */
export interface ArmConfig { name: string; lineup: string; overlay: string | null }

/** At most this many repeats of a disputed case: each is a whole iteration per arm. */
export const MAX_REPEATS = 3;

/** How many more trials per arm a disputed case gets. */
export function repeatCount(config: Pick<BacktestConfig, "repeats" | "source" | "noiseFloor">): number {
  // On a noise floor, identical arms disagreeing is the measurement, not a dispute to settle.
  return config.repeats ?? (config.source === undefined || config.noiseFloor !== undefined ? 0 : 2);
}

/** The usage share a trial waits below; null when the guard is off. */
export function usageLimit(config: Pick<BacktestConfig, "usageGuard">): number | null {
  return config.usageGuard === undefined ? DEFAULT_USAGE_GUARD : config.usageGuard;
}
export const DEFAULT_USAGE_GUARD = 90;

/** At most this many arms: every arm is a whole coder iteration per case. */
export const MAX_ARMS = 6;

/** The arms a config runs: its own list, else B on the live lineup and C on `lineup` when it names one. */
export function configArms(config: Pick<BacktestConfig, "arms" | "lineup">): ArmConfig[] {
  if (config.arms !== undefined) return config.arms;
  const b: ArmConfig = { name: "b", lineup: "live", overlay: null };
  return config.lineup === null ? [b] : [b, { name: "c", lineup: config.lineup, overlay: null }];
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (message: string): never => { throw new Error(`backtest config: ${message}`); };
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const DEFAULT_TEST_GLOBS: readonly string[] = ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx", "e2e/**"];
export const DEFAULT_TEST_COMMAND = "npx vitest run {file}";
export const DEFAULT_JUDGE_MODEL = "claude-opus-5-5";

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], prefix: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`unknown key ${prefix}${key}`);
}

/** Mirrors experiments.ts's `parseCutoff`, with the key's own name in the error. */
function parseSince(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  const message = `${name} must be an ISO 8601 time with a timezone, e.g. 2026-10-01T00:00:00Z`;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T[^Z+-]*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) fail(message);
  const text = value as string;
  // Date.parse rolls an impossible day over (02-30 becomes 03-02), so the
  // normalised time must still name the day the config wrote.
  const zone = /([+-])(\d{2}):(\d{2})$/.exec(text);
  const offset = zone ? (zone[1] === "-" ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3])) * 60_000 : 0;
  if (new Date(Date.parse(text) + offset).toISOString().slice(0, 10) !== text.slice(0, 10)) fail(`${message}; ${text} names a day that does not exist`);
  return new Date(text).toISOString();
}

const positive = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(`${name} must be a positive number`);
  return value as number;
};
const nonNegative = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(`${name} must be a non-negative number`);
  return value as number;
};

export function parseBacktest(value: unknown): BacktestConfig {
  if (!object(value)) return fail("must be an object");
  onlyKeys(value, ["project", "clerk", "sample", "source", "lineup", "arms", "caps", "repeats", "usageGuard", "rates", "sources", "scoring", "noiseFloor"], "");
  let usageGuard: number | null | undefined;
  if (value.usageGuard === false) usageGuard = null;
  else if (value.usageGuard !== undefined && value.usageGuard !== null) {
    if (typeof value.usageGuard !== "number" || !(value.usageGuard > 0) || value.usageGuard > 100) fail("usageGuard must be a usage percentage from 1 to 100, or false");
    usageGuard = value.usageGuard as number;
  }
  let repeats: number | undefined;
  if (value.repeats !== undefined && value.repeats !== null) {
    if (typeof value.repeats !== "number" || !Number.isInteger(value.repeats) || value.repeats < 0 || value.repeats > MAX_REPEATS) fail(`repeats must be an integer from 0 to ${MAX_REPEATS}`);
    repeats = value.repeats as number;
  }
  if (typeof value.project !== "string" || !isAbsolute(value.project)) fail("project must be an absolute path to a checkout of the project");

  // A PR source replays the PRs it names: there is no clerk to sample from.
  let source: PrSource | SetSource | undefined;
  let clerk = "";
  let sample: BacktestConfig["sample"] = { cap: 1, since: null, repos: null };
  if (value.source !== undefined && value.source !== null) {
    if (value.clerk !== undefined || value.sample !== undefined) fail("a config with a source names no clerk or sample: the source says which PRs to replay");
    source = parseSource(value.source);
  } else {
    if (typeof value.clerk !== "string" || !KEBAB.test(value.clerk)) fail("clerk must be the clerk loop's name, lowercase kebab-case");
    clerk = value.clerk as string;
    if (!object(value.sample)) return fail("sample must be an object with cap");
    const given = value.sample;
    onlyKeys(given, ["cap", "since", "repos"], "sample.");
    if (typeof given.cap !== "number" || !Number.isSafeInteger(given.cap) || given.cap < 1) fail("sample.cap must be a positive integer");
    const since = parseSince(given.since, "sample.since");
    let repos: string[] | null = null;
    if (given.repos !== undefined && given.repos !== null) {
      if (!Array.isArray(given.repos) || given.repos.length === 0 || given.repos.some((repo) => typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo))) {
        fail("sample.repos must be a non-empty list of owner/name repos");
      }
      repos = [...new Set(given.repos as string[])];
    }
    sample = { cap: given.cap as number, since, repos };
  }

  let lineup: string | null = null;
  if (value.lineup !== undefined && value.lineup !== null) {
    if (typeof value.lineup !== "string" || !KEBAB.test(value.lineup)) fail("lineup must be a lineup name in kebab-case, or null");
    lineup = value.lineup as string;
  }

  let arms: ArmConfig[] | undefined;
  if (value.arms !== undefined && value.arms !== null) {
    if (lineup !== null) fail("name arms or lineup, not both: lineup is the old spelling of a second arm");
    arms = parseArms(value.arms);
  }

  let noiseFloor: BacktestConfig["noiseFloor"];
  if (value.noiseFloor !== undefined) {
    const given = value.noiseFloor;
    if (!object(given)) return fail("noiseFloor must be an object with measuredAt");
    onlyKeys(given, ["measuredAt"], "noiseFloor.");
    if (typeof given.measuredAt !== "string" || given.measuredAt === "" || Number.isNaN(Date.parse(given.measuredAt))) fail("noiseFloor.measuredAt must be a time Date.parse reads");
    if (source?.kind !== "set") fail("noiseFloor needs a set source: the floor is a test set's");
    if (repeats !== undefined && repeats !== 0) fail("noiseFloor runs no repeats: identical arms disagreeing is the measurement");
    if (arms === undefined || arms.length < 2 || arms.some((arm) => arm.lineup !== "live" || arm.overlay !== null)) fail("noiseFloor needs at least 2 arms, every one on the live lineup with no overlay");
    noiseFloor = { measuredAt: given.measuredAt as string };
  }

  if (!object(value.caps)) return fail("caps must be an object with trialMinutes and batchMinutes");
  onlyKeys(value.caps, ["trialMinutes", "batchMinutes"], "caps.");
  const trialMinutes = positive(value.caps.trialMinutes, "caps.trialMinutes");
  const batchMinutes = positive(value.caps.batchMinutes, "caps.batchMinutes");
  if (trialMinutes > batchMinutes) fail("caps.trialMinutes must not exceed caps.batchMinutes");

  let rates: BacktestConfig["rates"] = null;
  if (value.rates !== undefined && value.rates !== null) {
    if (!object(value.rates)) return fail("rates must be an object with inputPerMTok and outputPerMTok, or null");
    onlyKeys(value.rates, ["inputPerMTok", "outputPerMTok"], "rates.");
    rates = { inputPerMTok: nonNegative(value.rates.inputPerMTok, "rates.inputPerMTok"), outputPerMTok: nonNegative(value.rates.outputPerMTok, "rates.outputPerMTok") };
  }

  const sources: Record<string, string> = {};
  if (value.sources !== undefined && value.sources !== null) {
    if (!object(value.sources)) return fail("sources must be an object mapping owner/name to a checkout's absolute path");
    for (const [repo, path] of Object.entries(value.sources)) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return fail(`sources key ${repo} must be an owner/name repo`);
      if (typeof path !== "string" || !isAbsolute(path)) return fail(`sources.${repo} must be an absolute path`);
      sources[repo] = path;
    }
  }

  const scoring: BacktestConfig["scoring"] = {
    testGlobs: [...DEFAULT_TEST_GLOBS], testCommand: DEFAULT_TEST_COMMAND, setup: null, review: true,
    judge: { model: DEFAULT_JUDGE_MODEL, seed: null, defaultPanel: true },
  };
  if (value.scoring !== undefined && value.scoring !== null) {
    if (!object(value.scoring)) return fail("scoring must be an object with testGlobs, testCommand, setup, review, judge and analyst, each optional");
    const given = value.scoring;
    onlyKeys(given, ["testGlobs", "testCommand", "setup", "review", "judge", "analyst"], "scoring.");
    if (given.analyst === false) scoring.analyst = null;
    else if (given.analyst !== undefined) {
      if (!object(given.analyst)) fail("scoring.analyst must be false or an object with model");
      const analyst = given.analyst as Record<string, unknown>;
      onlyKeys(analyst, ["model"], "scoring.analyst.");
      if (analyst.model !== undefined && (typeof analyst.model !== "string" || analyst.model.trim() === "")) fail("scoring.analyst.model must be a model id");
      scoring.analyst = { model: (analyst.model as string | undefined) ?? DEFAULT_JUDGE_MODEL };
    }
    if (given.testGlobs !== undefined) {
      if (!Array.isArray(given.testGlobs) || given.testGlobs.length === 0 || given.testGlobs.some((glob) => typeof glob !== "string" || glob === "")) {
        fail("scoring.testGlobs must be a non-empty list of glob strings");
      }
      scoring.testGlobs = [...given.testGlobs as string[]];
    }
    if (given.testCommand !== undefined) {
      // One command per test file: without the placeholder every file would run the same command.
      if (typeof given.testCommand !== "string" || !given.testCommand.includes("{file}")) fail("scoring.testCommand must be a shell command containing {file}");
      scoring.testCommand = given.testCommand as string;
    }
    if (given.setup !== undefined && given.setup !== null) {
      if (typeof given.setup !== "string" || given.setup.trim() === "") fail("scoring.setup must be a shell command, or null");
      scoring.setup = given.setup as string;
    }
    if (given.review !== undefined) {
      if (typeof given.review !== "boolean") fail("scoring.review must be true or false");
      scoring.review = given.review as boolean;
    }
    if (given.judge === false) scoring.judge = null;
    else if (given.judge !== undefined) {
      if (!object(given.judge)) fail("scoring.judge must be false or an object with model and seed, each optional");
      const judge = given.judge as Record<string, unknown>;
      onlyKeys(judge, ["model", "seed", "panel", "contested"], "scoring.judge.");
      if (judge.model !== undefined && (typeof judge.model !== "string" || judge.model.trim() === "")) fail("scoring.judge.model must be a model id");
      if (judge.seed !== undefined && judge.seed !== null && (typeof judge.seed !== "string" || judge.seed === "")) fail("scoring.judge.seed must be a non-empty string, or null");
      scoring.judge = { model: (judge.model as string | undefined) ?? DEFAULT_JUDGE_MODEL, seed: (judge.seed as string | null | undefined) ?? null };
      if (judge.panel !== undefined) scoring.judge.panel = parsePanel(judge.panel);
      // Naming neither is choosing nothing: the default panel, as with no judge block at all.
      else if (judge.model === undefined) scoring.judge.defaultPanel = true;
      // Absent stays absent: readers take that as inversion, the rule before #818.
      if (judge.contested !== undefined) scoring.judge.contested = parseContested(judge.contested);
    }
  }

  return {
    project: value.project as string,
    clerk,
    sample,
    ...(source === undefined ? {} : { source }),
    lineup,
    ...(arms === undefined ? {} : { arms }),
    caps: { trialMinutes, batchMinutes },
    ...(repeats === undefined ? {} : { repeats }),
    ...(usageGuard === undefined ? {} : { usageGuard }),
    ...(noiseFloor === undefined ? {} : { noiseFloor }),
    rates,
    sources,
    scoring,
  };
}

function parseContested(value: unknown): ContestedRule {
  const why = "scoring.judge.contested must be \"inversion\" or { spread: <points above 0, at most 4> }";
  if (value === "inversion") return { kind: "inversion" };
  if (!object(value)) return fail(why);
  const given = value as Record<string, unknown>;
  onlyKeys(given, ["spread"], "scoring.judge.contested.");
  const points = given.spread;
  // Scores run 1–5, so no two families can differ by more than 4.
  if (typeof points !== "number" || !Number.isFinite(points) || points <= 0 || points > 4) return fail(why);
  return { kind: "spread", points };
}

const HARNESS = dirname(fileURLToPath(import.meta.url));

/**
 * The first codex model the harness's lineup names: the default panel's
 * second family, for the engine and the Run screen alike. Null, never a
 * throw, when models.json is missing, unreadable or malformed.
 */
export function codexJudgeModel(modelsPath = join(HARNESS, "models.json")): string | null {
  let models: unknown;
  try { models = JSON.parse(readFileSync(modelsPath, "utf8")); } catch { return null; }
  let found: string | null = null;
  const walk = (value: unknown): void => {
    if (found !== null || typeof value !== "object" || value === null) return;
    const entry = value as Record<string, unknown>;
    if (entry.runner === "codex" && typeof entry.model === "string") { found = entry.model; return; }
    for (const child of Object.values(entry)) walk(child);
  };
  walk(models);
  return found;
}

type JudgeChoice = { model: string; panel?: JudgeSpec[]; defaultPanel?: true };

/**
 * The judges a config's panel names: its own list; with no model and no panel
 * named, Opus plus the Codex model (#817), Opus alone when there is none;
 * else one Claude judge on `model`.
 */
export function judgeSpecs(judge: JudgeChoice, codex: string | null = codexJudgeModel()): JudgeSpec[] {
  if (judge.panel !== undefined) return judge.panel;
  if (judge.defaultPanel) {
    return [
      { name: "opus", runner: "claude", model: DEFAULT_JUDGE_MODEL },
      ...(codex === null ? [] : [{ name: "gpt", runner: "codex" as const, model: codex }]),
    ];
  }
  return [{ name: judge.model, runner: "claude", model: judge.model }];
}

export const OPUS_ALONE_NOTE = "judge panel: Opus alone — models.json names no Codex model for the default panel's second judge";

/** Why the default panel has one judge, for the report's notes; null when it has both. */
export function defaultPanelNote(judge: JudgeChoice | null, codex: string | null = codexJudgeModel()): string | null {
  if (judge === null || judge.panel !== undefined || !judge.defaultPanel || codex !== null) return null;
  return OPUS_ALONE_NOTE;
}

function parsePanel(value: unknown): JudgeSpec[] {
  if (!Array.isArray(value) || value.length === 0) return fail("scoring.judge.panel must be a non-empty list of { runner, model }");
  const names = new Set<string>();
  return value.map((entry, index) => {
    const at = `scoring.judge.panel[${index}]`;
    if (!object(entry)) return fail(`${at} must be an object with runner and model`);
    onlyKeys(entry, ["name", "runner", "model"], `${at}.`);
    if (entry.runner !== "claude" && entry.runner !== "codex") fail(`${at}.runner must be claude or codex`);
    if (typeof entry.model !== "string" || entry.model.trim() === "") fail(`${at}.model must be a model id`);
    if (entry.name !== undefined && (typeof entry.name !== "string" || !KEBAB.test(entry.name))) fail(`${at}.name must be kebab-case`);
    // The model id names the judge unless the config does: two judges on one model need names.
    const name = (entry.name as string | undefined) ?? (entry.model as string);
    if (names.has(name)) fail(`${at} is a second judge named ${name}; give one a name`);
    names.add(name);
    return { name, runner: entry.runner as JudgeSpec["runner"], model: entry.model as string };
  });
}

function parseArms(value: unknown): ArmConfig[] {
  if (!Array.isArray(value) || value.length === 0) return fail("arms must be a non-empty list of { name, lineup, overlay }");
  if (value.length > MAX_ARMS) fail(`arms names ${value.length} arms; at most ${MAX_ARMS}, since each is a whole iteration per case`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const at = `arms[${index}]`;
    if (!object(entry)) return fail(`${at} must be an object with name, and lineup and overlay each optional`);
    onlyKeys(entry, ["name", "lineup", "overlay"], `${at}.`);
    // "a" is the reference's: the merged PR every arm is compared with.
    if (typeof entry.name !== "string" || !KEBAB.test(entry.name) || entry.name === "a") fail(`${at}.name must be a kebab-case name other than "a", which is the reference`);
    const name = entry.name as string;
    if (seen.has(name)) fail(`${at}.name ${name} is used twice`);
    seen.add(name);
    let lineup = "live";
    if (entry.lineup !== undefined && entry.lineup !== null) {
      if (typeof entry.lineup !== "string" || !KEBAB.test(entry.lineup)) fail(`${at}.lineup must be "live" or a lineup name in kebab-case`);
      lineup = entry.lineup as string;
    }
    let overlay: string | null = null;
    if (entry.overlay !== undefined && entry.overlay !== null) {
      if (typeof entry.overlay !== "string" || !isAbsolute(entry.overlay)) fail(`${at}.overlay must be an absolute path to a prompt overlay directory`);
      overlay = entry.overlay as string;
    }
    return { name, lineup, overlay };
  });
}

/** A ticket as the sample freezes it, or why it could not be read. */
export type BacktestTicketRead =
  | { ok: true; ref: string; title: string; body: string; comments: { author: string | null; createdAt: string; body: string }[] }
  | { ok: false; reason: string };
/** Where a moved ticket is read: the OA key first, then the intake key. */
export interface BacktestTickets { read(oaKey: string, intakeKey: string | null): Promise<BacktestTicketRead> }

export interface BacktestDeps {
  gh: GhRunner;
  tickets: BacktestTickets;
  prRepos: readonly string[];
  loopNames: readonly string[];
  nowMs: number;
}

export interface BacktestPr {
  number: number; url: string; createdAt: string; mergedAt: string; headRefName: string;
  /** The PR's first and last commits: what scoring compares the arms against. */
  firstCommit: string; headRefOid: string;
}
export interface BacktestTicket {
  oaKey: string;
  intakeKey: string | null;
  movedAt: string;
  repo: string;
  humanPrs: BacktestPr[];
  mergeBase: string;
  /** The earliest-opened human PR's createdAt: the ticket is frozen as it stood then. */
  startedAt: string;
  ticketRef: string;
  comments: { kept: number; dropped: number };
  /** What the trial will be given: the comments before `startedAt`; the title and description are as fetched today. */
  frozen: { title: string; body: string; comments: { author: string | null; createdAt: string; body: string }[] };
  /** What the case replays (#801): a coder iteration, the only kind so far. Absent on samples stored before it. */
  kind?: "coder";
  /** Who wrote the reference PRs (#801). A clerk backtest keeps only a person's, and leaves this out. */
  reference?: "person" | "loop" | "mixed";
}
export interface BacktestSkip { oaKey: string; intakeKey: string | null; reason: string }
export interface BacktestSample {
  tickets: BacktestTicket[];
  skipped: BacktestSkip[];
  notes: string[];
  /** The legacy pair on a config without `arms`, so samples stored before #801 read the same; else the arms. */
  arms: SampleArms;
  /**
   * On a set source (#854): the set's commit the run read (null: uncommitted) and every case id it selected, runnable or not.
   * `checks` (#855): the selected case ids that carry an operator check; absent on samples stored before it.
   * `checkRuns` (#857): case id → its accepted check, which grades each agent arm; absent on samples written before it.
   */
  set?: { version: string | null; selected: string[]; checks?: string[]; checkRuns?: Record<string, CheckSpec> };
}
/**
 * A case's operator check (#857), for a case no objective grader covers.
 * `test` is a repo-relative test file path read from the reference commit and
 * run with `scoring.testCommand`; `command` is a shell command run at the
 * tree's root, exit 0 = pass.
 */
export type CheckSpec = { test: string } | { command: string };
export type SampleArms = { b: "live lineup"; c: string | null } | ArmConfig[];

/** Every arm a sample or report names, whichever shape it was stored in. */
export function armList(arms: SampleArms): ArmConfig[] {
  if (Array.isArray(arms)) return arms;
  const b: ArmConfig = { name: "b", lineup: "live", overlay: null };
  return arms.c === null ? [b] : [b, { name: "c", lineup: arms.c, overlay: null }];
}

/** One line per arm: what it ran. */
export function describeArm(arm: ArmConfig): string {
  const lineup = arm.lineup === "live" ? "live lineup" : `lineup ${arm.lineup}`;
  return arm.overlay === null ? lineup : `${lineup}, prompt overlay ${arm.overlay}`;
}

/** The line every loop PR body carries; generic, so a loop since removed from the roster still counts. */
const PROVENANCE = /🤖 [A-Za-z][\w-]* loop — run/i;

/** Whether a loop wrote the PR: its provenance line, or a `<loop>/` branch. */
export function isLoopPr(view: Pick<GhPrView, "body" | "headRefName">, loopNames: readonly string[]): boolean {
  return PROVENANCE.test(view.body) || loopNames.some((name) => view.headRefName.startsWith(`${name}/`));
}

export interface GhPrView { number: number; url: string; body: string; headRefName: string; createdAt: string; mergedAt: string; baseRefOid: string; headRefOid: string; firstCommit: string }

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function viewPr(gh: GhRunner, repo: string, number: number, url: string): Promise<GhPrView> {
  const out = await gh(["pr", "view", String(number), "--repo", repo, "--json", "number,body,headRefName,createdAt,mergedAt,baseRefOid,headRefOid,commits"]);
  const row = JSON.parse(out) as Record<string, unknown>;
  return {
    number, url, body: text(row.body), headRefName: text(row.headRefName), createdAt: text(row.createdAt),
    mergedAt: text(row.mergedAt), baseRefOid: text(row.baseRefOid), headRefOid: text(row.headRefOid),
    firstCommit: Array.isArray(row.commits) && object(row.commits[0]) ? text(row.commits[0].oid) : "",
  };
}

/** The tracker's number for `key` when the tracker spells it that way, else null. */
function numberIn(tracker: Tracker, key: string | null): number | null {
  const match = key === null ? null : /^[A-Z][A-Z0-9_]*-(\d+)$/.exec(key);
  const number = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(number) && number >= 1 && tracker.ref(number) === key ? number : null;
}

/** Tickets read from a keyed project tracker, which spells the clerk's keys as its own. */
export function trackerTickets(tracker: Tracker): BacktestTickets {
  return {
    async read(oaKey, intakeKey) {
      const number = numberIn(tracker, oaKey) ?? numberIn(tracker, intakeKey);
      if (number === null) return { ok: false, reason: `neither ${[oaKey, intakeKey].filter(Boolean).join(" nor ")} is in the project's tracker` };
      const fetched = await fetchFromTracker(tracker, number);
      if (!fetched.ok) return { ok: false, reason: fetched.error };
      return {
        ok: true, ref: fetched.issue.ref ?? tracker.ref(number), title: fetched.issue.title, body: fetched.issue.body,
        comments: fetched.issue.comments.map((comment) => ({ author: comment.author?.login ?? null, createdAt: comment.createdAt, body: comment.body })),
      };
    },
  };
}

/**
 * Tickets read from the clerk's own Jira, for a project whose tracker is not
 * keyed. Reads only: the dry run promises nothing is written to the tracker.
 */
export function clerkJiraTickets(client: JiraClient): BacktestTickets {
  return {
    async read(oaKey, intakeKey) {
      const keys = [oaKey, intakeKey].filter((key): key is string => key !== null);
      for (const key of keys) {
        let entries;
        try { entries = await client.commentEntries(key); }
        catch (error) {
          // A key Jira does not have (an OA ticket never created, say) falls through to the intake key.
          if (error instanceof JiraError && error.failure.kind === "denied" && error.failure.code === "jira_not_found") continue;
          return { ok: false, reason: message(error) };
        }
        let issue;
        try { [issue] = await client.search(`key in (${jqlString(key)})`, 1); }
        catch (error) { return { ok: false, reason: message(error) }; }
        if (issue === undefined) return { ok: false, reason: `Jira found no ${key} although it has its comments` };
        return {
          ok: true, ref: key, title: issue.summary, body: issue.description,
          comments: entries.map((entry) => ({ author: entry.author === "" ? null : entry.author, createdAt: entry.created, body: entry.text })),
        };
      }
      return { ok: false, reason: `neither ${keys.join(" nor ")} is in the clerk's Jira` };
    },
  };
}

class Skip extends Error {}

export async function buildBacktestSample(config: BacktestConfig, deps: BacktestDeps): Promise<BacktestSample> {
  for (const repo of config.sample.repos ?? []) {
    if (!deps.prRepos.includes(repo)) fail(`sample.repos names ${repo}, which is not one of the project's prRepos (${deps.prRepos.join(", ")})`);
  }
  const notes: string[] = [];
  const ledger = clerkMetricsPath(config.clerk, config.project);
  if (!existsSync(ledger)) notes.push(`no ledger at ${ledger}: clerk ${config.clerk} has recorded no moves here`);
  const { events, skippedLines } = readEvents(ledger);
  if (skippedLines > 0) notes.push(`${skippedLines} unreadable ledger line${skippedLines === 1 ? "" : "s"} skipped`);
  const since = config.sample.since === null ? null : Date.parse(config.sample.since);
  const latest = new Map<string, MovedEvent>();
  for (const event of events) {
    if (event.kind !== "moved" || isPlaceholderKey(event.oaKey)) continue;
    const at = Date.parse(event.at);
    if (since !== null && !(at >= since)) continue;
    const seen = latest.get(event.oaKey);
    if (seen === undefined || Date.parse(seen.at) <= at) latest.set(event.oaKey, event);
  }
  const moves = [...latest.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const read = await readPulls({ cachePath: pullsCachePath(clerkStorePath(config.clerk, config.project)), repos: deps.prRepos, nowMs: deps.nowMs, gh: deps.gh });
  if (read.note !== null) notes.push(read.note);

  // The cache holds each repo's newest PULLS_PER_REPO PRs. Where a repo's list
  // is full, a ticket moved before its oldest entry may have lost its first PR
  // off the end, and a later follow-up would then pose as the start of the work.
  let reach = -Infinity;
  for (const repo of config.sample.repos ?? deps.prRepos) {
    const ats = read.pulls.filter((pull) => pull.repo === repo).map((pull) => Date.parse(pull.at ?? "")).filter(Number.isFinite);
    if (ats.length >= PULLS_PER_REPO) reach = Math.max(reach, Math.min(...ats));
  }

  const tickets: BacktestTicket[] = [];
  const skipped: BacktestSkip[] = [];
  const sampledPrs = new Set<string>(config.sample.recorded?.prs ?? []);
  const recorded = new Set(config.sample.recorded?.tickets ?? []);
  for (const move of moves) {
    if (tickets.length >= config.sample.cap) break;
    if (recorded.has(move.oaKey)) continue;
    const intakeKey = move.key ?? null;
    try {
      if (Date.parse(move.at) < reach) throw new Skip(`PR list too short: the cached PRs reach back only to ${new Date(reach).toISOString()}`);
      const ticket = await sampleTicket(config, deps, read.pulls, read.note, move.oaKey, intakeKey, move.at);
      // One intake key moved twice, or one PR naming two tickets, must not count the same human work twice.
      const ids = ticket.humanPrs.map((pr) => `${ticket.repo}#${pr.number}`);
      if (ids.some((id) => sampledPrs.has(id))) throw new Skip(`PR already sampled: ${ids.filter((id) => sampledPrs.has(id)).join(", ")}`);
      ids.forEach((id) => sampledPrs.add(id));
      tickets.push(ticket);
    } catch (error) {
      if (!(error instanceof Skip)) throw error;
      skipped.push({ oaKey: move.oaKey, intakeKey, reason: error.message });
    }
  }
  return { tickets, skipped, notes, arms: config.arms ?? { b: "live lineup", c: config.lineup } };
}

async function sampleTicket(config: BacktestConfig, deps: BacktestDeps, pulls: Awaited<ReturnType<typeof readPulls>>["pulls"],
  pullsNote: string | null, oaKey: string, intakeKey: string | null, movedAt: string): Promise<BacktestTicket> {
  const repos = config.sample.repos;
  const candidates = pullsNaming(pulls, intakeKey === null ? [oaKey] : [oaKey, intakeKey]).filter((pull) => pull.state === "mergeado");
  // An unread PR list says nothing about the ticket, so say so rather than "no merged PR".
  if (candidates.length === 0) throw new Skip(pullsNote === null ? "no merged PR" : `no merged PR in the cached list (${pullsNote})`);

  const views: (GhPrView & { repo: string })[] = [];
  try {
    for (const pull of candidates) views.push({ ...(await viewPr(deps.gh, pull.repo, pull.number, pull.url)), repo: pull.repo });
  } catch (error) {
    throw new Skip(`unreadable PR: ${message(error)}`);
  }
  const loopPr = (view: GhPrView): boolean => isLoopPr(view, deps.loopNames);
  const human = views.filter((view) => !loopPr(view));
  if (human.length === 0) throw new Skip("only loop PRs");
  const humanRepos = [...new Set(human.map((view) => view.repo))];
  // A trial clones exactly one repo, so work split across two cannot be replayed.
  // The filter comes after that check, so it cannot turn split work into half a human arm.
  if (humanRepos.length > 1) throw new Skip(`unknown repo: human PRs in ${humanRepos.join(", ")}`);
  if (repos !== null && !repos.includes(humanRepos[0]!)) throw new Skip(`unknown repo: ${humanRepos[0]} is outside sample.repos`);
  const ms = (iso: string): number => Date.parse(iso) || 0;
  human.sort((a, b) => ms(a.mergedAt) - ms(b.mergedAt) || a.number - b.number);
  // The arm is listed in merge order, but work began when the first PR was
  // OPENED: a follow-up opened earlier and merged later still started it, and
  // every comment after that point can describe the answer.
  const first = [...human].sort((a, b) => ms(a.createdAt) - ms(b.createdAt) || a.number - b.number)[0]!;

  let mergeBase: string;
  try {
    // From the PR's first commit, not its final head: a branch later updated
    // from the base would move the merge-base past work merged in between,
    // follow-up PRs of this same ticket included.
    const from = first.firstCommit || first.headRefOid;
    mergeBase = (await deps.gh(["api", `repos/${first.repo}/compare/${first.baseRefOid}...${from}`, "--jq", ".merge_base_commit.sha"])).trim();
  } catch (error) {
    throw new Skip(`unreadable PR: ${message(error)}`);
  }
  if (mergeBase === "") throw new Skip(`unreadable PR: no merge-base for ${first.repo}#${first.number}`);

  const fetched = await deps.tickets.read(oaKey, intakeKey);
  if (!fetched.ok) throw new Skip(`unreadable ticket: ${fetched.reason}`);
  // The rule of experiments.ts's comment cutoff: a comment without a readable
  // time cannot be shown to predate the first PR, so it goes too.
  const cutoff = Date.parse(first.createdAt);
  const kept = fetched.comments.filter((comment) => Date.parse(comment.createdAt) < cutoff);

  return {
    oaKey, intakeKey, movedAt, repo: first.repo,
    humanPrs: human.map(({ number: n, url, createdAt, mergedAt, headRefName, firstCommit, headRefOid }) => ({ number: n, url, createdAt, mergedAt, headRefName, firstCommit, headRefOid })),
    mergeBase, startedAt: first.createdAt, ticketRef: fetched.ref,
    comments: { kept: kept.length, dropped: fetched.comments.length - kept.length },
    frozen: { title: fetched.title, body: fetched.body, comments: kept },
  };
}

export function renderBacktestSample(sample: BacktestSample, config: BacktestConfig): string {
  const source = config.source;
  const lines = [source === undefined
    ? `Backtest dry run — clerk ${config.clerk}, ${sample.tickets.length} of at most ${config.sample.cap} tickets`
    : source.kind === "set"
      ? `Eval dry run — test set ${sample.set?.version ?? "(uncommitted)"}, ${sample.set?.selected.length ?? sample.tickets.length + sample.skipped.length} cases selected`
        + `${source.tags.length === 0 ? "" : `, tags ${source.tags.join(", ")}`}${source.cases.length === 0 ? "" : `, subset ${source.cases.join(", ")}`}`
      : `Eval dry run — ${source.repo} ${source.prs.map((pr) => `#${pr}`).join(", ")}${source.ticket === null ? "" : `, ticket ${source.ticket}`}`];
  for (const ticket of sample.tickets) {
    lines.push("", `${ticket.oaKey}${ticket.intakeKey === null ? "" : ` (intake ${ticket.intakeKey})`} — ${ticket.repo}`);
    lines.push(`  moved: ${ticket.movedAt}`);
    for (const pr of ticket.humanPrs) lines.push(`  PR #${pr.number} ${pr.headRefName} — opened ${pr.createdAt}, merged ${pr.mergedAt} ${pr.url}`);
    lines.push(`  merge-base: ${ticket.mergeBase}`, `  started: ${ticket.startedAt}`);
    lines.push(`  frozen ticket ${ticket.ticketRef}: ${ticket.comments.kept} comment${ticket.comments.kept === 1 ? "" : "s"} kept, ${ticket.comments.dropped} dropped`);
    if (ticket.reference !== undefined) lines.push(`  reference: ${ticket.reference === "person" ? "a person's" : ticket.reference === "loop" ? "a loop's" : "partly a loop's"} merged work`);
  }
  if (sample.skipped.length > 0) {
    lines.push("", "Skipped");
    for (const skip of sample.skipped) lines.push(`  ${skip.oaKey}${skip.intakeKey === null ? "" : ` (intake ${skip.intakeKey})`}: ${skip.reason}`);
  }
  if (Array.isArray(sample.arms)) lines.push("", "Arms", ...sample.arms.map((arm) => `  ${arm.name}: ${describeArm(arm)}`));
  else lines.push("", "Arms", `  B: ${sample.arms.b}`, `  C: ${sample.arms.c ?? "(none)"}`);
  if (sample.notes.length > 0) lines.push("", "Notes", ...sample.notes.map((note) => `  ${note}`));
  lines.push("", "Dry run: no model was called and nothing was written to the tracker, Slack or GitHub (only the local PR cache may refresh).");
  return lines.join("\n");
}

/**
 * Where a project's backtest tickets are read: its keyed tracker, or else the
 * clerk's Jira. Shared with the eval set's ledger import (#861), which must
 * read a ledger's tickets from the same place the backtest did.
 */
export async function backtestTickets(
  projectPath: string,
  options: { env?: NodeJS.ProcessEnv; fetch?: Parameters<typeof jiraClient>[2] } = {},
): Promise<BacktestTickets> {
  const { env = process.env } = options;
  let tracker: Tracker | null;
  try { tracker = keyedProjectTracker(projectPath); }
  catch (error) { throw new Error(`backtest: cannot open the project's tracker: ${message(error)}`); }
  if (tracker !== null) return trackerTickets(tracker);

  // An unreadable config is the same answer as no clerk block: a bare project id
  // given as a path lands here, and must not read as a project with no tickets.
  let rules: ReturnType<typeof clerkRules>;
  try { rules = clerkRules(loadProjectConfig(projectPath)); }
  catch { rules = null; }
  if (rules === null) throw new Error(`backtest: no keyed tracker and no clerk block at ${projectPath}; pass the project's checkout as --project`);
  // No keyed tracker: the tickets live in the clerk's Jira. The credential is
  // proved here, before sampling, so a bad one fails the run once rather than
  // skipping every ticket as unreadable.
  const credential = parseJiraToken(env[JIRA_TOKEN_ENV]);
  if (credential === null) {
    throw new Error(`backtest: the project has no keyed tracker, so its tickets are read from the clerk's Jira, but ${env[JIRA_TOKEN_ENV]?.trim() ? `${JIRA_TOKEN_ENV} is not '<email>:<API token>'` : `there is no ${JIRA_TOKEN_ENV} in the environment`}`);
  }
  const client = jiraClient(rules.jira.site, credential, options.fetch);
  // The intake board too: Jira answers 404 for an issue the account cannot
  // see, so an unreadable OAI would pass every ticket off as "not in Jira".
  for (const project of [rules.jira.project, rules.jira.intakeProject].filter((key): key is string => typeof key === "string" && key !== "")) {
    try { await client.project(project); }
    catch (error) {
      const failure = error instanceof JiraError ? error.failure : null;
      const why = failure === null ? message(error) : failure.kind === "denied" ? `${failure.why}; ${failure.remedy}` : failure.why;
      throw new Error(`backtest: ${JIRA_TOKEN_ENV} cannot read the clerk's Jira project ${project} on ${rules.jira.site}: ${why}`);
    }
  }
  return clerkJiraTickets(client);
}

/** The deps from the real world: `gh`, the project's tracker (or the clerk's Jira), its prRepos and its roster. */
export async function backtestDeps(
  config: BacktestConfig,
  options: { nowMs?: number; env?: NodeJS.ProcessEnv; fetch?: Parameters<typeof jiraClient>[2] } = {},
): Promise<BacktestDeps> {
  const { nowMs = Date.now() } = options;
  const projectConfig = loadProjectConfig(config.project);
  const rules = clerkRules(projectConfig);
  if (rules === null) throw new Error(`backtest: project has no clerk block (${config.project})`);
  const roster = projectRosterEntries(config.project);
  // A misspelt clerk reads an empty ledger and would print an empty sample as if it were the answer.
  if (roleOf(config.clerk, roster) !== "clerk") throw new Error(`backtest config: clerk ${config.clerk} is not a clerk on the project's roster`);
  const prRepos = rules.prRepos ?? [];
  // No repo read means every ticket would print as "no merged PR".
  if (prRepos.length === 0) throw new Error("backtest: the project's clerk.prRepos is empty, so no PR can be read");
  const loopNames = [...new Set([...roster.map((entry) => entry.name), "ralph"])];
  return { gh: spawnGh, tickets: await backtestTickets(config.project, { env: options.env, fetch: options.fetch }), prRepos, loopNames, nowMs };
}
