/**
 * The eval test set store (#853): one JSON file per case under
 * `evals/<projectId>/<caseId>.json` on this repository's `main`.
 *
 * A case is a frozen coder ticket, the human PRs that resolved it, and the
 * curation that put it in the set. It stores only references to client code
 * (repo, commit SHAs, paths), never file contents, so the set can live in the
 * harness repository whatever the client's licence.
 *
 * Reads come from a fresh `origin/main`; writes go through the journal's
 * worktree with the same retry on a fresh tip as the backtest ledger, one
 * commit per write. A change re-reads the set on every attempt, so a writer
 * that lost the race decides again against what the winner pushed.
 *
 * `import-backtest` (#861) seeds the set from the clerk-vs-human backtest
 * ledger: one case per ledger ticket not yet in the set, all in one commit. It
 * only reads the ledger, and re-running it imports nothing twice. A `GH-<n>`
 * ticket is read from the PR's GitHub repo; any other key from where the
 * backtest read it (`backtestTickets`: the keyed tracker, or the clerk's Jira).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  backtestTickets, DEFAULT_TEST_GLOBS, parseBacktest, type BacktestConfig, type BacktestPr, type BacktestSample, type BacktestTicket,
  type BacktestTicketRead, type BacktestTickets, type CheckSpec,
} from "./backtest";
import { readRecorded, type LedgerEntry } from "./backtest-ledger";
import { verifyCheck, type CheckOutcome } from "./backtest-score";
import { spawnGh } from "./clerk/pulls";
import { checkAcceptance } from "./eval-evaluation-proposals";
import { AXES, type Axis } from "./eval-panel";
import { DEFAULT_STALE_SHARE, floorStatus, latestFloor, noiseFloorSettings, readNoiseFloors, type NoiseFloor, type NoiseStatus } from "./eval-noise-floor";
import { relaysPatches, runsNewestFirst, type EvalRunSummary } from "./eval-runs";
import { DEFAULT_SATURATION_RUNS, saturationById, saturationSettings, type CaseSaturation } from "./eval-saturation";
import { buildPrSample, prSampleDeps } from "./eval-source";
import { DEFAULT_SUGGESTION_LIMIT, rankSuggestions, readSuggestSignals, type SuggestSignals } from "./evals-suggest";
import { matchesGlob } from "./executor-guard/diff-guard";
import { RALPH_HOME, projectRoot } from "./paths";
import { loadProjectConfig } from "./project-config";
import { projectIdFor } from "./project-id";
import { defaultGit, DEFAULT_MAX_ATTEMPTS, ensureWorktree, LOCK_TIMEOUT_STATUS, type GitRunner } from "./publish-journal";
import { buildRedactor } from "./runner-failure";

export const EVALS_DIR = "evals";

export type CaseStatus = "active" | "saturated" | "retired";
export const CASE_STATUSES: readonly CaseStatus[] = ["active", "saturated", "retired"];

export interface EvalComment { author: string | null; createdAt: string; body: string }

export interface EvalCase {
  v: 1;
  /** `<owner>-<repo>-<first pr number>`, kebab: also the file's name. */
  id: string;
  kind: "coder";
  repo: string;
  prs: BacktestPr[];
  /** The merge base the sample froze: where every arm starts from. */
  baseCommit: string;
  startedAt: string;
  ticket: { ref: string; title: string; body: string; comments: EvalComment[]; dropped: number };
  reference: "person" | "loop" | "mixed";
  /** The human's tests the arms never see; graded only. */
  heldOut: string[];
  tags: string[];
  /** Why the case is in the set. */
  reason: string;
  /** Graded only: a curator's notes may give the answer away. */
  notes: string;
  /** Graded only: an operator check, stored only once it failed on the base and passed on the reference (#857). */
  check?: OperatorCheck;
  /** Graded only: operators' verdicts where they disagreed with the judge panel (#876). Absent on a case with none. */
  calibration?: CalibrationVerdict[];
  status: CaseStatus;
  /** When an operator last kept the case (#860): saturation counts only the set runs after it. Absent on a case never kept. */
  keptAt?: string;
  addedAt: string;
  addedBy: string;
}

/**
 * A check an operator attached and `evals-set.ts check` verified: it failed on
 * the case's base and passed on its reference. Both outcomes are stored as
 * literals, so a check that was never verified cannot parse as one that was.
 */
export type OperatorCheck = CheckSpec & { base: "fail"; reference: "pass"; acceptedAt: string; acceptedBy: string };

/**
 * An operator's calibration verdict (#876): which of two arms was better on
 * one axis, and why.
 */
export interface CalibrationVerdict { arms: [string, string]; axis: Axis; preferred: string; reason: string; by: string; at: string }

/** The fields an improver must never see: they would let it fit the grading instead of the ticket. */
export const GRADED_ONLY = ["heldOut", "notes", "check", "calibration"] as const;
export type GradedOnly = (typeof GRADED_ONLY)[number];
export type ImproverCase = Omit<EvalCase, GradedOnly>;

export function withoutGraded(c: EvalCase): ImproverCase {
  const copy: Record<string, unknown> = { ...c };
  for (const key of GRADED_ONLY) delete copy[key];
  return copy as unknown as ImproverCase;
}

export function gradedOf(c: EvalCase): Pick<EvalCase, GradedOnly> {
  return {
    heldOut: [...c.heldOut], notes: c.notes, ...(c.check !== undefined ? { check: { ...c.check } } : {}),
    ...(c.calibration !== undefined ? { calibration: c.calibration.map(copyVerdict) } : {}),
  };
}

const copyVerdict = (verdict: CalibrationVerdict): CalibrationVerdict => ({ ...verdict, arms: [verdict.arms[0], verdict.arms[1]] });

export function caseId(repo: string, prNumber: number): string {
  // Runs of non-kebab characters collapse to one dash, so `org/.github` still names a valid id.
  return `${repo.replace("/", "-")}-${prNumber}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export interface Curation {
  heldOut: string[];
  tags: string[];
  reason: string;
  notes: string;
  addedAt: string;
  addedBy: string;
}

/** The case for the one ticket `buildPrSample` returns; validated, so a bad curation fails here and not at read. */
export function caseFromTicket(ticket: BacktestTicket, curation: Curation): EvalCase {
  const first = ticket.humanPrs[0];
  if (first === undefined) fail("the ticket has no PR to name the case after");
  return parseCase({
    v: 1,
    id: caseId(ticket.repo, first!.number),
    kind: ticket.kind ?? "coder",
    repo: ticket.repo,
    prs: ticket.humanPrs.map((pr) => ({ ...pr })),
    baseCommit: ticket.mergeBase,
    startedAt: ticket.startedAt,
    ticket: {
      ref: ticket.ticketRef, title: ticket.frozen.title, body: ticket.frozen.body,
      comments: ticket.frozen.comments.map((comment) => ({ ...comment })), dropped: ticket.comments.dropped,
    },
    reference: ticket.reference ?? "person",
    heldOut: [...curation.heldOut],
    tags: [...curation.tags],
    reason: curation.reason,
    notes: curation.notes,
    status: "active",
    addedAt: curation.addedAt,
    addedBy: curation.addedBy,
  });
}

const fail = (message: string): never => { throw new Error(`evals case: ${message}`); };

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], prefix: string, where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${where}unknown key ${prefix}${key}`);
}

const CASE_KEYS = ["v", "id", "kind", "repo", "prs", "baseCommit", "startedAt", "ticket", "reference", "heldOut", "tags", "reason", "notes", "check", "calibration", "status", "keptAt", "addedAt", "addedBy"] as const;
const PR_KEYS = ["number", "url", "createdAt", "mergedAt", "headRefName", "firstCommit", "headRefOid"] as const;
const TICKET_KEYS = ["ref", "title", "body", "comments", "dropped"] as const;
const COMMENT_KEYS = ["author", "createdAt", "body"] as const;
const CALIBRATION_KEYS = ["arms", "axis", "preferred", "reason", "by", "at"] as const;
const CHECK_KEYS = ["test", "command", "base", "reference", "acceptedAt", "acceptedBy"] as const;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

/**
 * An operator check, strict: exactly one of `test` or `command`, and the two
 * outcomes it was accepted on. A `test` is a path inside the case's repo, so
 * an absolute path or a `..` segment would run something the case never held.
 */
export function parseOperatorCheck(value: unknown, where?: string, path = "check"): OperatorCheck {
  const at = where ? `${where}: ` : "";
  const bad = (field: string, want: string): never => fail(`${at}${field} must be ${want}`);
  if (!object(value)) return bad(path, "an object with test or command, base, reference, acceptedAt and acceptedBy");
  onlyKeys(value, CHECK_KEYS, `${path}.`, at);
  const nonEmpty = (key: string): string => {
    const got = value[key];
    if (typeof got !== "string" || got.trim() === "") bad(`${path}.${key}`, "a non-empty string");
    return got as string;
  };
  const hasTest = value.test !== undefined;
  if (hasTest === (value.command !== undefined)) bad(path, "exactly one of test or command");
  let spec: CheckSpec;
  if (hasTest) {
    const test = nonEmpty("test");
    if (test.startsWith("/") || test.split(/[\\/]/).includes("..")) bad(`${path}.test`, "a relative path with no .. segment");
    spec = { test };
  } else {
    spec = { command: nonEmpty("command") };
  }
  if (value.base !== "fail") bad(`${path}.base`, "fail");
  if (value.reference !== "pass") bad(`${path}.reference`, "pass");
  return { ...spec, base: "fail", reference: "pass", acceptedAt: nonEmpty("acceptedAt"), acceptedBy: nonEmpty("acceptedBy") };
}

/**
 * A calibration verdict, strict: two distinct arms, an axis the panel scores,
 * and a preferred arm that is one of the two, so a verdict always says which
 * side of a real comparison the operator took.
 */
export function parseCalibrationVerdict(value: unknown, where?: string, path = "calibration[0]"): CalibrationVerdict {
  const at = where ? `${where}: ` : "";
  const bad = (field: string, want: string): never => fail(`${at}${field} must be ${want}`);
  if (!object(value)) return bad(path, "an object with arms, axis, preferred, reason, by and at");
  onlyKeys(value, CALIBRATION_KEYS, `${path}.`, at);
  const nonEmpty = (key: string): string => {
    const got = value[key];
    if (typeof got !== "string" || got.trim() === "") bad(`${path}.${key}`, "a non-empty string");
    return got as string;
  };
  const arms = value.arms;
  if (!Array.isArray(arms) || arms.length !== 2 || !arms.every((arm) => typeof arm === "string" && arm.trim() !== "") || arms[0] === arms[1]) {
    bad(`${path}.arms`, "two distinct non-empty arm names");
  }
  const [first, second] = arms as [string, string];
  if (!AXES.includes(value.axis as Axis)) bad(`${path}.axis`, `one of ${AXES.join(", ")}`);
  if (value.preferred !== first && value.preferred !== second) bad(`${path}.preferred`, `one of the arms, ${first} or ${second}`);
  return {
    arms: [first, second], axis: value.axis as Axis, preferred: value.preferred as string,
    reason: nonEmpty("reason"), by: nonEmpty("by"), at: nonEmpty("at"),
  };
}

/** Strict: an unknown key or a wrong type names its dotted path, so a hand-edited file says where it went wrong. */
export function parseCase(value: unknown, where?: string): EvalCase {
  const at = where ? `${where}: ` : "";
  const bad = (path: string, want: string): never => fail(`${at}${path} must be ${want}`);
  const text = (from: Record<string, unknown>, key: string, path: string, nonEmpty = false): string => {
    const got = from[key];
    if (typeof got !== "string" || (nonEmpty && got.trim() === "")) bad(path, nonEmpty ? "a non-empty string" : "a string");
    return got as string;
  };
  const texts = (from: Record<string, unknown>, key: string, path: string): string[] => {
    const got = from[key];
    if (!Array.isArray(got)) return bad(path, "a list of strings");
    (got as unknown[]).forEach((entry, index) => { if (typeof entry !== "string") bad(`${path}.${index}`, "a string"); });
    return [...(got as string[])];
  };
  const count = (from: Record<string, unknown>, key: string, path: string, min: number): number => {
    const got = from[key];
    if (typeof got !== "number" || !Number.isSafeInteger(got) || got < min) bad(path, min > 0 ? "a positive integer" : "a non-negative integer");
    return got as number;
  };

  if (!object(value)) return fail(`${at}must be an object`);
  onlyKeys(value, CASE_KEYS, "", at);
  if (value.v !== 1) bad("v", "1");
  const id = text(value, "id", "id", true);
  if (!ID.test(id)) bad("id", "kebab-case");
  if (value.kind !== "coder") bad("kind", "coder");
  const repo = text(value, "repo", "repo", true);
  if (!REPO.test(repo)) bad("repo", "an owner/name repo");

  if (!Array.isArray(value.prs) || value.prs.length === 0) return bad("prs", "a non-empty list of PRs");
  const prs = (value.prs as unknown[]).map((entry, index): BacktestPr => {
    const path = `prs.${index}`;
    if (!object(entry)) return bad(path, "an object");
    onlyKeys(entry, PR_KEYS, `${path}.`, at);
    return {
      number: count(entry, "number", `${path}.number`, 1),
      url: text(entry, "url", `${path}.url`, true),
      createdAt: text(entry, "createdAt", `${path}.createdAt`, true),
      mergedAt: text(entry, "mergedAt", `${path}.mergedAt`, true),
      headRefName: text(entry, "headRefName", `${path}.headRefName`, true),
      firstCommit: text(entry, "firstCommit", `${path}.firstCommit`, true),
      headRefOid: text(entry, "headRefOid", `${path}.headRefOid`, true),
    };
  });
  const baseCommit = text(value, "baseCommit", "baseCommit", true);
  const startedAt = text(value, "startedAt", "startedAt", true);

  if (!object(value.ticket)) return bad("ticket", "an object");
  const given = value.ticket;
  onlyKeys(given, TICKET_KEYS, "ticket.", at);
  if (!Array.isArray(given.comments)) return bad("ticket.comments", "a list of comments");
  const comments = (given.comments as unknown[]).map((entry, index): EvalComment => {
    const path = `ticket.comments.${index}`;
    if (!object(entry)) return bad(path, "an object");
    onlyKeys(entry, COMMENT_KEYS, `${path}.`, at);
    if (entry.author !== null && typeof entry.author !== "string") bad(`${path}.author`, "a string or null");
    return { author: entry.author as string | null, createdAt: text(entry, "createdAt", `${path}.createdAt`, true), body: text(entry, "body", `${path}.body`) };
  });
  const ticket = {
    ref: text(given, "ref", "ticket.ref", true), title: text(given, "title", "ticket.title"), body: text(given, "body", "ticket.body"),
    comments, dropped: count(given, "dropped", "ticket.dropped", 0),
  };

  const reference = value.reference;
  if (reference !== "person" && reference !== "loop" && reference !== "mixed") bad("reference", "person, loop or mixed");
  const heldOut = texts(value, "heldOut", "heldOut");
  const tags = texts(value, "tags", "tags");
  const reason = text(value, "reason", "reason", true);
  const notes = text(value, "notes", "notes");
  // A free-text check (before #857) had no runner and no case on main carries one: it is refused, not upgraded.
  const check = value.check === undefined ? undefined : parseOperatorCheck(value.check, where);
  if (value.calibration !== undefined && !Array.isArray(value.calibration)) bad("calibration", "a list of verdicts");
  const verdicts = ((value.calibration ?? []) as unknown[]).map((entry, index) => parseCalibrationVerdict(entry, where, `calibration[${index}]`));
  // An empty list reads as absent, so a case's text is the same whether or not it ever held an empty one.
  const calibration = verdicts.length > 0 ? verdicts : undefined;
  if (!CASE_STATUSES.includes(value.status as CaseStatus)) bad("status", CASE_STATUSES.join(", ").replace(/, (?=[^,]*$)/, " or "));
  const keptAt = value.keptAt === undefined ? undefined : text(value, "keptAt", "keptAt", true);
  const addedAt = text(value, "addedAt", "addedAt", true);
  const addedBy = text(value, "addedBy", "addedBy", true);

  // Built in CASE_KEYS order, so serializeCase's output is stable whatever order the input had.
  return {
    v: 1, id, kind: "coder", repo, prs, baseCommit, startedAt, ticket, reference: reference as EvalCase["reference"],
    heldOut, tags, reason, notes, ...(check !== undefined ? { check } : {}),
    ...(calibration !== undefined ? { calibration } : {}), status: value.status as CaseStatus,
    ...(keptAt !== undefined ? { keptAt } : {}), addedAt, addedBy,
  };
}

/** One stable text per case, so a write that changes one field diffs as one line. */
export function serializeCase(c: EvalCase): string {
  return `${JSON.stringify(parseCase(c), null, 2)}\n`;
}

const projectDir = (projectId: string) => `${EVALS_DIR}/${projectId}`;
const casePath = (projectId: string, id: string) => `${projectDir(projectId)}/${id}.json`;
const why = (result: { stderr: string; stdout: string; status: number }) => (result.stderr || result.stdout).trim() || `exit ${result.status}`;
const byId = (a: EvalCase, b: EvalCase) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A file is named for its case: a mismatch would let two files claim one id. */
function parseFile(text: string, path: string): EvalCase {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`evals case: ${path}: not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = parseCase(json, path);
  if (`${parsed.id}.json` !== path.split("/").pop()) throw new Error(`evals case: ${path}: id ${parsed.id} does not match the file name`);
  return parsed;
}

/** The set on `origin/main`, fresh; a failed fetch or a bad file throws rather than reading as a smaller set. */
export function readSet(projectId: string, home: string = RALPH_HOME, git: GitRunner = defaultGit, options: { fetch?: boolean } = {}): { version: string | null; cases: EvalCase[] } {
  if (options.fetch !== false) {
    const fetched = git(["-C", home, "fetch", "--quiet", "origin", "main"]);
    if (fetched.status !== 0) throw new Error(`cannot read the eval set: git fetch failed: ${why(fetched)}`);
  }
  const dir = projectDir(projectId);
  const logged = git(["-C", home, "log", "-1", "--format=%H", "origin/main", "--", dir]);
  if (logged.status !== 0) throw new Error(`cannot read the eval set: git log failed: ${why(logged)}`);
  const version = logged.stdout.trim();
  if (version === "") return { version: null, cases: [] };
  const listed = git(["-C", home, "ls-tree", "--name-only", `origin/main:${dir}/`]);
  // The directory was touched once and since removed: an empty set, but a versioned one.
  if (listed.status !== 0) {
    if (git(["-C", home, "cat-file", "-e", `origin/main:${dir}`]).status !== 0) return { version, cases: [] };
    throw new Error(`cannot list ${dir}: ${why(listed)}`);
  }
  const cases = listed.stdout.split("\n").map((name) => name.trim()).filter((name) => name.endsWith(".json")).map((name) => {
    const path = `${dir}/${name}`;
    const shown = git(["-C", home, "show", `origin/main:${path}`]);
    if (shown.status !== 0) throw new Error(`cannot read ${path}: ${why(shown)}`);
    return parseFile(shown.stdout, path);
  });
  return { version, cases: cases.sort(byId) };
}

function readWorktreeSet(wt: string, projectId: string): EvalCase[] {
  const dir = join(wt, projectDir(projectId));
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).sort()
    .map((name) => parseFile(readFileSync(join(dir, name), "utf8"), `${projectDir(projectId)}/${name}`)).sort(byId);
}

/**
 * Commit many cases to `origin/main` in one commit. `change` sees the set as it
 * stands on the fresh tip of each attempt and returns the cases to write; it
 * throws to refuse, and the refusal propagates with nothing committed. An empty
 * list commits nothing: a batch whose every entry a racing writer already landed
 * is done, not an error.
 */
export function writeCases(options: {
  projectId: string; home: string; worktree: string; git?: GitRunner; maxAttempts?: number; beforePush?: (attempt: number) => void;
  /** A function names the commit for the cases this attempt actually writes, which a racing writer may have thinned. */
  message: string | ((cases: EvalCase[]) => string); change: (current: EvalCase[]) => EvalCase[];
}): { sha: string | null; cases: EvalCase[] } {
  const git = options.git ?? defaultGit;
  const wt = resolve(options.worktree);
  const must = (args: string[]): string => {
    const result = git(["-C", wt, ...args]);
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${why(result)}`);
    return result.stdout;
  };
  ensureWorktree(options.home, wt, git);
  let rejection = "";
  for (let attempt = 1; attempt <= (options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS); attempt += 1) {
    must(["fetch", "--quiet", "origin", "main"]);
    must(["checkout", "--quiet", "--detach", "--force", "origin/main"]);
    git(["-C", wt, "clean", "-fdq", "--", projectDir(options.projectId)]);
    const next = options.change(readWorktreeSet(wt, options.projectId)).map((c) => parseCase(c));
    if (next.length === 0) return { sha: null, cases: [] };
    const files = next.map((c) => ({ path: casePath(options.projectId, c.id), text: serializeCase(c) }));
    // A commit with no change would fail as a git error; say what happened instead.
    if (files.every((file) => existsSync(join(wt, file.path)) && readFileSync(join(wt, file.path), "utf8") === file.text)) {
      throw new Error(`evals case: ${next.map((c) => c.id).join(", ")} ${next.length === 1 ? "is" : "are"} already as written; nothing to commit`);
    }
    mkdirSync(join(wt, projectDir(options.projectId)), { recursive: true });
    for (const file of files) writeFileSync(join(wt, file.path), file.text);
    const paths = files.map((file) => file.path);
    must(["add", "--", ...paths]);
    const message = typeof options.message === "string" ? options.message : options.message(next);
    must(["commit", "--quiet", "-m", message, "--", ...paths]);
    options.beforePush?.(attempt);
    const pushed = git(["-C", wt, "push", "--quiet", "origin", "HEAD:main"]);
    if (pushed.status === 0) return { sha: must(["rev-parse", "HEAD"]).trim(), cases: next };
    rejection = why(pushed);
  }
  throw new Error(`the eval case push was rejected every attempt. Last: ${rejection}`);
}

/** Commit one case: `writeCases` with a one-case change. */
export function writeCase(options: {
  projectId: string; home: string; worktree: string; git?: GitRunner; maxAttempts?: number; beforePush?: (attempt: number) => void;
  message: string; change: (current: EvalCase[]) => EvalCase;
}): { sha: string; case: EvalCase } {
  const { change, ...rest } = options;
  const written = writeCases({ ...rest, change: (current) => [change(current)] });
  // One case always commits or throws, so a null sha here is unreachable.
  return { sha: written.sha!, case: written.cases[0]! };
}

/** GitHub names are case-insensitive: `Org/App` and `org/app` are one repo, so one PR must not join two cases. */
const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A `change` for a new case: one ticket's PRs belong to one case, or the set would grade the same work twice. */
export function addCase(current: readonly EvalCase[], next: EvalCase): EvalCase {
  if (current.some((existing) => existing.id === next.id)) fail(`a case ${next.id} is already in the set`);
  for (const pr of next.prs) {
    const holder = current.find((existing) => sameRepo(existing.repo, next.repo) && existing.prs.some((held) => held.number === pr.number));
    if (holder !== undefined) fail(`${next.repo}#${pr.number} is already in case ${holder.id}`);
  }
  return next;
}

/** Who in `held` already holds one of `next`'s PRs, by the same repo rule as `addCase`. */
const prHolder = (held: readonly EvalCase[], repo: string, prs: readonly number[]): EvalCase | undefined =>
  held.find((existing) => sameRepo(existing.repo, repo) && existing.prs.some((pr) => prs.includes(pr.number)));

/**
 * A `change` for a batch: the candidates whose id and PRs no case holds, first
 * wins within the batch. It drops rather than throws, so an entry a racing
 * writer already imported falls out on retry instead of failing the batch.
 */
export function addNewCases(current: readonly EvalCase[], candidates: readonly EvalCase[]): EvalCase[] {
  const kept: EvalCase[] = [];
  for (const candidate of candidates) {
    const held = [...current, ...kept];
    if (held.some((existing) => existing.id === candidate.id)) continue;
    if (prHolder(held, candidate.repo, candidate.prs.map((pr) => pr.number)) !== undefined) continue;
    kept.push(candidate);
  }
  return kept;
}

/** A `change` that retires a case: the file stays, so the history of what was graded stays readable. */
export function retireCase(current: readonly EvalCase[], id: string): EvalCase {
  const found = current.find((existing) => existing.id === id);
  if (found === undefined) return fail(`no case ${id} in the set`);
  return { ...found, status: "retired" };
}

/**
 * A `change` that keeps a case an operator saw flagged saturated (#860): it
 * stays active and its saturation window restarts at `at`. A retired case is
 * never flagged, so keeping one is refused rather than silently reactivated.
 */
export function keepCase(current: readonly EvalCase[], id: string, at: string): EvalCase {
  const found = current.find((existing) => existing.id === id);
  if (found === undefined) return fail(`no case ${id} in the set`);
  if (found.status === "retired") return fail(`${id} is retired; only a case in the set can be kept`);
  return { ...found, status: "active", keptAt: at };
}

/** A `change` that attaches a verified check, replacing any the case had: the new one passed the same verification. */
export function attachCheck(current: readonly EvalCase[], id: string, check: OperatorCheck): EvalCase {
  const found = current.find((existing) => existing.id === id);
  if (found === undefined) return fail(`no case ${id} in the set`);
  return { ...found, check: { ...check } };
}

/**
 * A `change` that records a calibration verdict (#876). Verdicts only append:
 * the dashboard records every operator `by dashboard`, so treating a later
 * verdict on the same axis and pair as a change of mind would silently drop
 * another person's. A retired case keeps its history, so it may still be
 * calibrated.
 */
export function calibrateCase(current: readonly EvalCase[], id: string, verdict: CalibrationVerdict): EvalCase {
  const found = current.find((existing) => existing.id === id);
  if (found === undefined) return fail(`no case ${id} in the set`);
  return { ...found, calibration: [...(found.calibration ?? []).map(copyVerdict), copyVerdict(verdict)] };
}

/** What an edit replaces; a field left out keeps its value. */
export interface CaseEdit { tags?: string[]; notes?: string }

/** A `change` that replaces a case's curation tags and/or notes: the frozen ticket and grading stay as added. */
export function editCase(current: readonly EvalCase[], id: string, edit: CaseEdit): EvalCase {
  const found = current.find((existing) => existing.id === id);
  if (found === undefined) return fail(`no case ${id} in the set`);
  return {
    ...found,
    ...(edit.tags !== undefined ? { tags: [...edit.tags] } : {}),
    ...(edit.notes !== undefined ? { notes: edit.notes } : {}),
  };
}

/** Tags as typed by hand: trimmed, blanks dropped, duplicates dropped, first order kept. */
export function normaliseTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag !== ""))];
}

export type GraderKind = "held-out tests" | "check" | "gates";

export interface EvalSetRow {
  id: string;
  repo: string;
  prs: number[];
  title: string;
  tags: string[];
  graders: GraderKind[];
  status: CaseStatus;
  addedAt: string;
  addedBy: string;
  /** The newest eval run that holds this case. */
  lastRun: { run: string; startedAt: string } | null;
  /** Whether every arm passed the case in its last N set runs since it was kept (#860); null for a retired case, which is never flagged. */
  saturation: CaseSaturation | null;
  /** How many calibration verdicts the case holds (#876): relayed on every project, unlike the verdicts themselves. */
  calibrations: number;
  reason?: string;
  notes?: string;
  /** The verdicts with their reasons, only when details is on. */
  calibration?: CalibrationVerdict[];
}

/** A case the panel contested on its newest set run (#876): where an operator's verdict is worth asking for. */
export interface CalibrationSuggestion {
  id: string;
  title: string;
  contested: { axis: Axis; arms: string[] }[];
  run: string;
  calibrations: number;
}

export interface EvalSetView {
  version: string | null;
  /** The project's `relayEvalPatches`: only then do rows carry the curator's reason and notes. */
  details: boolean;
  cases: EvalSetRow[];
  /** Whether the latest noise floor still describes this set (#859): what the screen says beside its Measure action. */
  noiseFloor: NoiseStatus;
  /** Uncalibrated cases first, then newest run, then id. */
  calibrationSuggestions: CalibrationSuggestion[];
}

const samePrs = (a: readonly number[], b: readonly number[]): boolean => {
  const left = [...new Set(a)].sort((x, y) => x - y);
  const right = [...new Set(b)].sort((x, y) => x - y);
  return left.length === right.length && left.every((n, index) => n === right[index]);
};

/**
 * The non-retired cases the panel contested on the newest set run that
 * judged them, for an operator to calibrate (#876). Only that newest run
 * counts: an older disagreement the panel has since settled is not worth a
 * verdict. A run that holds the case with no panel (stopped, its judges
 * unavailable, or mid-way through its repeats) says nothing either way, so
 * the search goes past it. On a set run the case id is the case's key. It carries no reasons, so it is the
 * same on a summary-only project.
 */
export function calibrationSuggestions(cases: readonly EvalCase[], runs: readonly EvalRunSummary[]): CalibrationSuggestion[] {
  const newest = runs.filter((run) => run.source.kind === "set").sort((a, b) => (b.startedAt < a.startedAt ? -1 : b.startedAt > a.startedAt ? 1 : 0));
  const found: { suggestion: CalibrationSuggestion; startedAt: string }[] = [];
  for (const c of cases) {
    if (c.status === "retired") continue;
    let held: EvalRunSummary["cases"][number] | undefined;
    const run = newest.find((candidate) => (held = candidate.cases.find((entry) => entry.key === c.id && entry.contestedRule !== null)) !== undefined);
    if (run === undefined || held === undefined || held.contested.length === 0) continue;
    found.push({
      suggestion: {
        id: c.id, title: c.ticket.title, contested: held.contested.map((entry) => ({ axis: entry.axis, arms: [...entry.arms] })),
        run: run.id, calibrations: c.calibration?.length ?? 0,
      },
      startedAt: run.startedAt,
    });
  }
  found.sort((a, b) =>
    (a.suggestion.calibrations === 0 ? 0 : 1) - (b.suggestion.calibrations === 0 ? 0 : 1)
    || (b.startedAt < a.startedAt ? -1 : b.startedAt > a.startedAt ? 1 : 0)
    || (a.suggestion.id < b.suggestion.id ? -1 : a.suggestion.id > b.suggestion.id ? 1 : 0));
  return found.map((entry) => entry.suggestion);
}

/**
 * The Test set screen's projection. The dashboard pushes it to the remote
 * store, so it is built field by field: a summary-only project (#801, #802)
 * shows titles, tags and grader kinds, and no project ever relays the
 * reference, held-out paths, check text, ticket body or comments.
 */
export function setView(set: { version: string | null; cases: readonly EvalCase[] }, runs: readonly EvalRunSummary[], details: boolean, noiseFloor: NoiseStatus, saturationRuns: number): EvalSetView {
  const newest = [...runs].sort((a, b) => (b.startedAt < a.startedAt ? -1 : b.startedAt > a.startedAt ? 1 : 0));
  // A retired case is never flagged, so it is not computed either.
  const saturation = saturationById(set.cases.filter((c) => c.status !== "retired"), runs, saturationRuns);
  return {
    version: set.version,
    details,
    cases: set.cases.map((c): EvalSetRow => {
      const prs = c.prs.map((pr) => pr.number);
      const run = newest.find((candidate) => candidate.cases.some((held) => sameRepo(held.repo, c.repo) && samePrs(held.prs, prs)));
      // Agrees with eval-set-source.ts's `checks` (the cases a check grades): a stored check is always a verified one.
      const graders: GraderKind[] = [
        ...(c.heldOut.length > 0 ? ["held-out tests" as const] : []),
        ...(c.check !== undefined ? ["check" as const] : []),
        "gates",
      ];
      return {
        id: c.id, repo: c.repo, prs, title: c.ticket.title, tags: [...c.tags], graders, status: c.status,
        addedAt: c.addedAt, addedBy: c.addedBy,
        lastRun: run === undefined ? null : { run: run.id, startedAt: run.startedAt },
        // keptAt only moves the window; the row does not relay it.
        saturation: c.status === "retired" ? null : saturation.get(c.id) ?? null,
        calibrations: c.calibration?.length ?? 0,
        ...(details ? { reason: c.reason, notes: c.notes } : {}),
        ...(details && c.calibration !== undefined ? { calibration: c.calibration.map(copyVerdict) } : {}),
      };
    }),
    noiseFloor,
    calibrationSuggestions: calibrationSuggestions(set.cases, runs),
  };
}

// ---------------------------------------------------------------------------
// The CLI: the dashboard and later tickets call the store over a process
// boundary, so every command prints JSON on stdout and nothing else there.
// ---------------------------------------------------------------------------

/** One write the locked section performs: already built, so no gh or network runs under the lock. */
export type WriteRequest = { projectId: string } & (
  | { kind: "add"; case: EvalCase }
  | { kind: "retire"; id: string }
  | { kind: "keep"; id: string }
  | { kind: "import"; cases: EvalCase[] }
  | { kind: "edit"; id: string; edit: CaseEdit }
  | { kind: "check"; id: string; check: OperatorCheck }
  | { kind: "calibrate"; id: string; verdict: CalibrationVerdict }
);

/** add, retire, keep, edit, check and calibrate answer `{sha, case}`; import answers `{sha, cases}`, with a null sha when nothing was new. */
export type WriteResult = { sha: string | null; case?: EvalCase; cases?: EvalCase[] };

export interface EvalsSetDeps {
  /** The harness clone the set is read from. */
  home: string;
  git: GitRunner;
  projectId: (projectPath: string) => string;
  /** `buildPrSample` with its real deps; refuses an unmerged PR by throwing. */
  sample: (config: BacktestConfig) => Promise<BacktestSample>;
  /** The paths one PR changed; only paths, never contents. */
  changedFiles: (repo: string, pr: number) => Promise<string[]>;
  /** One commit on `main` through the journal lock. */
  write: (request: WriteRequest) => WriteResult;
  /** The project's backtest ledger on `origin/main`; throws when it cannot be read. */
  ledger: (projectId: string) => LedgerEntry[];
  /** Where the backtest read the ledger's non-GitHub tickets; throws when that source cannot be opened or proved. */
  ledgerTickets: (projectPath: string) => Promise<BacktestTickets>;
  /** `buildPrSample` whose non-`#<n>` ticket reads go to `read` instead of the project's keyed tracker. */
  ledgerSample: (config: BacktestConfig, read: (ref: string) => Promise<BacktestTicketRead>) => Promise<BacktestSample>;
  /** Run the check on the case's base and on its reference; an outcome is `error` when the check cannot run there. */
  verifyCheck: (c: EvalCase, spec: CheckSpec, options: { projectPath: string; source?: string; timeoutMs?: number }) => Promise<{ base: CheckOutcome; reference: CheckOutcome; notes: string[] }>;
  /** Every signal `suggest` ranks on but the held set; reads degrade per source and never throw. */
  suggestSignals: (projectPath: string) => Promise<SuggestSignals>;
  /** The project's stored noise floors and the share of cases that makes one stale (#859). */
  noiseFloors: (projectPath: string) => { floors: NoiseFloor[]; staleShare: number };
  /** N, the set runs in a row that make a case saturated (#860): the project's `evalsSaturation.runs` or the default. */
  saturationRuns: (projectPath: string) => number;
  now: () => string;
  user: () => string;
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = [
  "usage: evals-set.ts list [--status active|saturated|retired] [--project <path>]",
  "       evals-set.ts show <id> [--project <path>]",
  "       evals-set.ts add --repo <owner/name> --pr <n> [--pr <m> ...] --reason <text> [--ticket <ref>] [--tag <t> ...] [--notes <text>] [--held-out <path> ...] [--by <name>] [--project <path>]",
  "       evals-set.ts retire <id> [--project <path>]",
  "       evals-set.ts keep <id> [--project <path>]",
  "       evals-set.ts import-backtest [--by <name>] [--project <checkout>]",
  "       evals-set.ts edit <id> [--tag <t> ... | --no-tags] [--notes <text>] [--project <path>]",
  "       evals-set.ts check --case <id> (--test <path> | --command <cmd>) [--source <checkout>] [--timeout <seconds>] [--by <name>] [--project <path>]",
  "       evals-set.ts calibrate --case <id> --arm <a> --arm <b> --axis <axis> --prefer <arm> --reason <text> [--by <name>] [--project <path>]",
  "       evals-set.ts view [--project <path>]",
  "       evals-set.ts suggest [--limit <n>] [--project <path>]",
].join("\n");

class UsageError extends Error {}

const REPEATABLE = new Set(["pr", "tag", "held-out", "arm"]);
/** Flags that take no value. */
const SWITCHES = new Set(["no-tags"]);
const FLAGS: Record<string, readonly string[]> = {
  list: ["project", "status"],
  show: ["project"],
  add: ["project", "repo", "pr", "ticket", "reason", "tag", "notes", "held-out", "by"],
  retire: ["project"],
  keep: ["project"],
  "import-backtest": ["project", "by"],
  edit: ["project", "tag", "no-tags", "notes"],
  view: ["project"],
  check: ["project", "case", "test", "command", "source", "timeout", "by"],
  calibrate: ["project", "case", "arm", "axis", "prefer", "reason", "by"],
  suggest: ["project", "limit"],
};

/** `--flag value` pairs and positionals; an unknown flag or a missing value is a usage error, not a guess. */
function parseArgs(command: string, rest: string[]): { positional: string[]; flags: Map<string, string[]> } {
  const allowed = FLAGS[command] ?? [];
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const name = arg.slice(2);
    const value = rest[index + 1];
    if (!allowed.includes(name)) throw new UsageError(`unknown flag ${arg} for ${command}`);
    if (SWITCHES.has(name)) {
      if (flags.has(name)) throw new UsageError(`${arg} given twice`);
      flags.set(name, [""]);
      continue;
    }
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value`);
    if (flags.has(name) && !REPEATABLE.has(name)) throw new UsageError(`${arg} given twice`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
    index += 1;
  }
  return { positional, flags };
}

/** The test files the PRs changed: the human's tests become the held-out grading the arms never see. */
async function defaultHeldOut(repo: string, prs: readonly number[], deps: EvalsSetDeps): Promise<string[]> {
  const paths = new Set<string>();
  for (const pr of prs) {
    for (const path of await deps.changedFiles(repo, pr)) {
      if (DEFAULT_TEST_GLOBS.some((glob) => matchesGlob(glob, path))) paths.add(path);
    }
  }
  return [...paths].sort();
}

/** The PR source spells a GitHub issue `#<n>` (see eval-source.ts); the ledger keys it `GH-<n>`. */
const sourceTicket = (key: string): string => key.replace(/^GH-(\d+)$/, "#$1");

const GITHUB_KEY = /^GH-\d+$/;

/**
 * One case per ledger ticket not yet in the set, in one commit. An entry that
 * cannot be built is skipped with its reason and the rest still import: one
 * unreadable PR must not hold back the whole seed. The ledger read, the set
 * read, the ticket source and the write fail the command, and so does a run
 * where every entry was skipped: that is a failed seed, not "nothing new".
 */
async function importBacktest(projectPath: string, projectId: string, by: string | undefined, deps: EvalsSetDeps): Promise<number> {
  const redact = buildRedactor();
  const entries = deps.ledger(projectId);
  // An absent ledger reads as empty; seeding from it would print an empty answer as if it were the seed.
  if (entries.length === 0) { deps.err(`evals-set: no backtest ledger entries for ${projectId}; pass the clerk project's checkout as --project`); return 1; }
  const current = readSet(projectId, deps.home, deps.git).cases;
  // Opened once, before any sample, and only when a non-GitHub ticket will be
  // read: a bad credential fails the run once instead of skipping every entry.
  const needsSource = entries.some((entry) => {
    try {
      const prs = entry.prs.map((pr) => pr.number);
      return prs.length > 0 && !GITHUB_KEY.test(entry.ticket) && prHolder(current, entry.repo, prs) === undefined;
    } catch {
      return false;
    }
  });
  const tickets = needsSource ? await deps.ledgerTickets(projectPath) : null;
  const built: { ticket: string; case: EvalCase }[] = [];
  const already: { ticket: string; case: string }[] = [];
  const skipped: { ticket: string; reason: string }[] = [];
  for (const entry of entries) {
    try {
      const prs = entry.prs.map((pr) => pr.number);
      if (prs.length === 0) { skipped.push({ ticket: entry.ticket, reason: "the ledger entry names no PR" }); continue; }
      // Checked before any gh call: building a sample costs API calls, and a held PR would be dropped at write anyway.
      const holder = prHolder([...current, ...built.map((b) => b.case)], entry.repo, prs);
      if (holder !== undefined) { already.push({ ticket: entry.ticket, case: holder.id }); continue; }
      const config = parseBacktest({
        project: projectPath, source: { kind: "pr", repo: entry.repo, prs, ticket: sourceTicket(entry.ticket) },
        caps: { trialMinutes: 1, batchMinutes: 1 },
      });
      // A `GH-<n>` key goes as `#<n>` and never reaches `read`. The ledger keeps the
      // intake key the backtest fell back to; the tracker key alone may not resolve.
      const sample = await deps.ledgerSample(config, async (ref) => tickets === null
        ? { ok: false, reason: `${ref}: no ticket source was opened` }
        : tickets.read(entry.ticket, entry.intakeKey));
      const ticket = sample.tickets[0];
      if (ticket === undefined) throw new Error(`${entry.repo}: the PRs gave no ticket`);
      built.push({
        ticket: entry.ticket,
        case: caseFromTicket(ticket, {
          heldOut: await defaultHeldOut(entry.repo, prs, deps), tags: ["clerk-backtest"],
          reason: `clerk-vs-human backtest: ${entry.ticket} (ledger run ${entry.run}, recorded ${entry.recordedAt})`,
          notes: "", addedAt: deps.now(), addedBy: by ?? deps.user(),
        }),
      });
    } catch (error) {
      skipped.push({ ticket: entry.ticket, reason: redact(error instanceof Error ? error.message : String(error)) });
    }
  }
  for (const skip of skipped) deps.err(`evals-set: skipped ${skip.ticket}: ${skip.reason}`);
  if (built.length === 0) {
    deps.err(`evals-set: nothing new to import; ${already.length} already in the set, ${skipped.length} skipped`);
    deps.out(JSON.stringify({ sha: null, imported: [], already, skipped }));
    return already.length === 0 && skipped.length > 0 ? 1 : 0;
  }
  const written = deps.write({ projectId, kind: "import", cases: built.map((b) => b.case) });
  const imported = (written.cases ?? []).map((c) => c.id);
  // A racing writer landed these first: they are in the set, so every ledger ticket still appears once.
  for (const b of built) if (!imported.includes(b.case.id)) already.push({ ticket: b.ticket, case: b.case.id });
  deps.out(JSON.stringify({ sha: written.sha, imported, already, skipped }));
  return 0;
}

/**
 * Verify an operator check on a case and store it only when it fails on the
 * base and passes on the reference: a check that passes on the base grades
 * nothing, one that fails on the reference would fail the human's own fix.
 * The answer echoes no check text of its own, though a refusal's reason may
 * name the test path the operator typed; the set view never carries it.
 * The reason is the last `evals-set: ` line: the dashboard shows that one.
 */
async function checkCase(projectPath: string, projectId: string, flags: Map<string, string[]>, deps: EvalsSetDeps): Promise<number> {
  const one = (name: string): string | undefined => flags.get(name)?.[0];
  const id = one("case");
  if (id === undefined) throw new UsageError("check needs --case <id>");
  const test = one("test");
  const command = one("command");
  if ((test === undefined) === (command === undefined)) throw new UsageError("check takes exactly one of --test <path> or --command <cmd>");
  const timeout = one("timeout");
  if (timeout !== undefined && !/^[1-9]\d*$/.test(timeout)) throw new UsageError("--timeout must be a positive integer of seconds");
  const spec: CheckSpec = test !== undefined ? { test } : { command: command! };
  // Validated before any clone: a bad path is refused in the stored shape's own words.
  parseOperatorCheck({ ...spec, base: "fail", reference: "pass", acceptedAt: "-", acceptedBy: "-" });

  const found = readSet(projectId, deps.home, deps.git).cases.find((c) => c.id === id);
  if (found === undefined) { deps.err(`evals-set: no case ${id} in the set`); return 1; }
  // No run samples a retired case, so verifying a check for it would cost two runs for nothing.
  if (found.status === "retired") { deps.err(`evals-set: refused: ${id} is retired; no run grades its check`); return 1; }
  const source = one("source");
  const verified = await deps.verifyCheck(found, spec, {
    projectPath, ...(source !== undefined ? { source: resolve(source) } : {}), ...(timeout !== undefined ? { timeoutMs: Number(timeout) * 1000 } : {}),
  });
  const { base, reference } = verified;
  const refused = (reason: string): number => {
    deps.out(JSON.stringify({ sha: null, case: id, base, reference }));
    deps.err(`evals-set: refused: ${reason}`);
    return 1;
  };
  // One rule for an operator's check and an improver's suggested one (#878): fail on the base, pass on the reference.
  const why = checkAcceptance({ base, reference }, { base: found.baseCommit, reference: found.prs.at(-1)!.headRefOid });
  if (why !== null) return refused(why);
  const written = deps.write({
    projectId, kind: "check", id,
    check: { ...spec, base: "fail", reference: "pass", acceptedAt: deps.now(), acceptedBy: one("by") ?? deps.user() },
  });
  deps.out(JSON.stringify({ sha: written.sha, case: id, base: "fail", reference: "pass" }));
  return 0;
}

/** Exit status: 0 done, 1 refused or failed, 64 bad usage. */
export async function runEvalsSet(argv: string[], deps: EvalsSetDeps): Promise<number> {
  const [command, ...rest] = argv;
  const print = (value: unknown) => deps.out(JSON.stringify(value));
  try {
    if (command === undefined || !(command in FLAGS)) throw new UsageError(command === undefined ? "no command" : `unknown command ${command}`);
    const { positional, flags } = parseArgs(command, rest);
    const one = (name: string): string | undefined => flags.get(name)?.[0];
    const projectPath = resolve(one("project") ?? projectRoot());
    const projectId = deps.projectId(projectPath);

    if (command === "list") {
      if (positional.length > 0) throw new UsageError("list takes no arguments");
      const status = one("status");
      if (status !== undefined && !CASE_STATUSES.includes(status as CaseStatus)) throw new UsageError(`--status must be one of ${CASE_STATUSES.join(", ")}`);
      const set = readSet(projectId, deps.home, deps.git);
      print({ version: set.version, cases: status === undefined ? set.cases : set.cases.filter((c) => c.status === status) });
      return 0;
    }

    if (command === "show") {
      if (positional.length !== 1) throw new UsageError("show takes one case id");
      const set = readSet(projectId, deps.home, deps.git);
      const found = set.cases.find((c) => c.id === positional[0]);
      if (found === undefined) { deps.err(`evals-set: no case ${positional[0]} in ${projectId}`); return 1; }
      print({ version: set.version, case: found });
      return 0;
    }

    if (command === "retire") {
      if (positional.length !== 1) throw new UsageError("retire takes one case id");
      print(deps.write({ projectId, kind: "retire", id: positional[0]! }));
      return 0;
    }

    if (command === "keep") {
      if (positional.length !== 1) throw new UsageError("keep takes one case id");
      print(deps.write({ projectId, kind: "keep", id: positional[0]! }));
      return 0;
    }

    if (command === "import-backtest") {
      if (positional.length > 0) throw new UsageError("import-backtest takes flags only");
      return await importBacktest(projectPath, projectId, one("by"), deps);
    }

    if (command === "edit") {
      if (positional.length !== 1) throw new UsageError("edit takes one case id");
      if (flags.has("tag") && flags.has("no-tags")) throw new UsageError("edit takes --tag or --no-tags, not both");
      const edit: CaseEdit = {
        ...(flags.has("tag") ? { tags: normaliseTags(flags.get("tag")!) } : flags.has("no-tags") ? { tags: [] } : {}),
        ...(flags.has("notes") ? { notes: one("notes")! } : {}),
      };
      if (edit.tags === undefined && edit.notes === undefined) throw new UsageError("edit needs --tag, --no-tags or --notes");
      print(deps.write({ projectId, kind: "edit", id: positional[0]!, edit }));
      return 0;
    }

    if (command === "check") {
      if (positional.length > 0) throw new UsageError("check takes flags only");
      return await checkCase(projectPath, projectId, flags, deps);
    }

    if (command === "calibrate") {
      if (positional.length > 0) throw new UsageError("calibrate takes flags only");
      const id = one("case");
      if (id === undefined) throw new UsageError("calibrate needs --case <id>");
      const arms = flags.get("arm") ?? [];
      if (arms.length !== 2) throw new UsageError("calibrate needs exactly two --arm <name>");
      const axis = one("axis");
      if (axis === undefined) throw new UsageError("calibrate needs --axis <axis>");
      const preferred = one("prefer");
      if (preferred === undefined) throw new UsageError("calibrate needs --prefer <arm>");
      const reason = one("reason");
      if (reason === undefined) throw new UsageError("calibrate needs --reason <text>");
      // Parsed as the store would read it, so a malformed verdict is refused before the lock.
      const verdict = parseCalibrationVerdict({ arms, axis, preferred, reason, by: one("by") ?? deps.user(), at: deps.now() }, undefined, "verdict");
      print(deps.write({ projectId, kind: "calibrate", id, verdict }));
      return 0;
    }

    if (command === "view") {
      if (positional.length > 0) throw new UsageError("view takes no arguments");
      // No fetch: the page polls this every minute, and an unlocked fetch of
      // the harness home races the journal publisher's locked one for
      // origin/main's ref. Every write on this host, and every journal
      // publish, moves origin/main already.
      const set = readSet(projectId, deps.home, deps.git, { fetch: false });
      // runsNewestFirst skips a run directory that cannot be read; relaysPatches reads doubt as off.
      // An unreadable floor store is no floor: the page must still show the set.
      let noise: { floors: NoiseFloor[]; staleShare: number };
      try { noise = deps.noiseFloors(projectPath); } catch { noise = { floors: [], staleShare: DEFAULT_STALE_SHARE }; }
      const status = floorStatus(latestFloor(noise.floors), set.cases, noise.staleShare);
      // Likewise a window that cannot be read, or is not a positive integer, is
      // the default: a flag is only a suggestion and must not cost the page.
      let saturationRuns = DEFAULT_SATURATION_RUNS;
      try {
        const runs = deps.saturationRuns(projectPath);
        if (Number.isInteger(runs) && runs >= 1) saturationRuns = runs;
      } catch { /* default */ }
      print(setView(set, runsNewestFirst(projectPath).runs, relaysPatches(projectPath), status, saturationRuns));
      return 0;
    }

    if (command === "suggest") {
      if (positional.length > 0) throw new UsageError("suggest takes no arguments");
      const limitText = one("limit");
      const limit = limitText === undefined ? DEFAULT_SUGGESTION_LIMIT : /^\d+$/.test(limitText) ? Number(limitText) : Number.NaN;
      if (!Number.isSafeInteger(limit) || limit < 1) throw new UsageError("--limit must be a positive integer");
      // Every status, unfetched, for view's reasons: the page polls this too.
      // A set that cannot be read throws to a refusal: suggesting PRs it may
      // already hold would be wrong.
      const set = readSet(projectId, deps.home, deps.git, { fetch: false });
      const signals = await deps.suggestSignals(projectPath);
      if (signals.repo === null) {
        print({ version: set.version, suggestions: [], missing: [{ source: "pulls", why: signals.pulls.ok ? "the project has no GitHub origin" : signals.pulls.why }] });
        return 0;
      }
      const held = set.cases.map((c) => ({ repo: c.repo, prs: c.prs.map((pr) => pr.number) }));
      const { repo, pulls, loops, doctors, weights, blocked, parked, journal, speed, projectId: signalsProject, closesAreTickets } = signals;
      const result = rankSuggestions({ repo, pulls, held, loops, doctors, blocked, parked, journal, speed, projectId: signalsProject, closesAreTickets, limit }, weights);
      print({ version: set.version, ...result });
      return 0;
    }

    // add
    if (positional.length > 0) throw new UsageError("add takes flags only");
    const repo = one("repo");
    const reason = one("reason");
    if (repo === undefined || !REPO.test(repo)) throw new UsageError("add needs --repo <owner/name>");
    if (reason === undefined || reason.trim() === "") throw new UsageError("add needs --reason <text>");
    const prs = (flags.get("pr") ?? []).map((text) => (/^\d+$/.test(text) ? Number(text) : Number.NaN));
    if (prs.length === 0 || prs.some((pr) => !Number.isSafeInteger(pr) || pr < 1)) throw new UsageError("add needs --pr <number> for each PR");

    // Refuse before any gh call: building a sample costs API calls, and the PRs' case would be refused at write anyway.
    const current = readSet(projectId, deps.home, deps.git).cases;
    for (const pr of prs) {
      const holder = current.find((c) => sameRepo(c.repo, repo) && c.prs.some((held) => held.number === pr));
      if (holder !== undefined) { deps.err(`evals-set: ${repo}#${pr} is already in case ${holder.id}`); return 1; }
    }

    const config = parseBacktest({
      project: projectPath, source: { kind: "pr", repo, prs, ticket: one("ticket") ?? null },
      // parseBacktest wants caps for a run; a sample never runs, so any valid value will do.
      caps: { trialMinutes: 1, batchMinutes: 1 },
    });
    const sample = await deps.sample(config);
    const ticket = sample.tickets[0];
    if (ticket === undefined) throw new Error(`${repo}: the PRs gave no ticket`);
    const heldOut = flags.has("held-out") ? [...new Set(flags.get("held-out"))].sort() : await defaultHeldOut(repo, prs, deps);
    const built = caseFromTicket(ticket, {
      heldOut, tags: [...new Set(flags.get("tag") ?? [])], reason, notes: one("notes") ?? "",
      addedAt: deps.now(), addedBy: one("by") ?? deps.user(),
    });
    print(deps.write({ projectId, kind: "add", case: built }));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      deps.err(`evals-set: ${error.message}`);
      deps.err(USAGE);
      return 64;
    }
    deps.err(`evals-set: ${buildRedactor()(error instanceof Error ? error.message : String(error))}`);
    return 1;
  }
}

/** RALPH_HOME is where this file lives; tests point the store at a scratch clone instead. */
// The journal publisher's own override: one variable keeps the store's home and the shared worktree's home the same repo.
const evalsHome = (): string => process.env.RALPH_JOURNAL_HOME?.trim() || RALPH_HOME;

/**
 * How long a write waits for the journal lock, in seconds: 300 from a shell.
 * The dashboard sets `RALPH_EVALS_SET_LOCK_WAIT` lower, because its request
 * must answer inside the local server's idle timeout, and a write that
 * commits after the page gave up would read as failed though it landed.
 */
export function lockWaitSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const given = Number(env.RALPH_EVALS_SET_LOCK_WAIT);
  return Number.isSafeInteger(given) && given > 0 ? given : 300;
}

/**
 * Commit under the journal's lock: the worktree is shared with every publisher
 * on the host. Outside the lock, re-exec this file under `flock` with the
 * request in a temp file; the child prints its `WriteResult` on stdout.
 */
export function lockedWrite(request: WriteRequest): WriteResult {
  if (process.env.RALPH_JOURNAL_LOCKED !== "1") {
    const lock = resolve(process.env.RALPH_JOURNAL_LOCK?.trim() || join(homedir(), ".ralph", "journal.lock"));
    mkdirSync(dirname(lock), { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "evals-set-"));
    try {
      let target: string[];
      if (request.kind === "add") {
        const file = join(dir, "case.json");
        writeFileSync(file, serializeCase(request.case));
        target = ["--add", file];
      } else if (request.kind === "import") {
        const file = join(dir, "cases.json");
        writeFileSync(file, JSON.stringify(request.cases));
        target = ["--import", file];
      } else if (request.kind === "edit") {
        const file = join(dir, "edit.json");
        writeFileSync(file, JSON.stringify({ id: request.id, ...request.edit }));
        target = ["--edit", file];
      } else if (request.kind === "check") {
        const file = join(dir, "check.json");
        writeFileSync(file, JSON.stringify({ id: request.id, check: request.check }));
        target = ["--check", file];
      } else if (request.kind === "calibrate") {
        const file = join(dir, "calibrate.json");
        writeFileSync(file, JSON.stringify({ id: request.id, verdict: request.verdict }));
        target = ["--calibrate", file];
      } else if (request.kind === "keep") {
        target = ["--keep", request.id];
      } else {
        target = ["--retire", request.id];
      }
      const child = spawnSync("flock", ["-w", String(lockWaitSeconds()), "-E", String(LOCK_TIMEOUT_STATUS), lock, process.execPath, fileURLToPath(import.meta.url), "_write", "--project-id", request.projectId, ...target], {
        // An import answers with every case in full: the default 1 MiB cap would fail a run whose commit already landed.
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, env: { ...process.env, RALPH_JOURNAL_LOCKED: "1" },
      });
      if (child.status !== 0) {
        // The child already said `evals-set: <why>`; strip the prefix so the caller's own prefix is not doubled.
        const said = (child.stderr ?? "").trim().replace(/^evals-set: (?:Error: )?/, "");
        throw new Error(said || `the write did not run (flock exit ${child.status ?? child.error?.message})`);
      }
      return JSON.parse(child.stdout) as WriteResult;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const worktree = process.env.RALPH_JOURNAL_WORKTREE?.trim() || join(homedir(), ".ralph", "journal-wt");
  const base = { projectId: request.projectId, home: evalsHome(), worktree };
  if (request.kind === "add") {
    const built = request.case;
    return writeCase({ ...base, message: `chore(evals): add ${built.id} to ${request.projectId}`, change: (current) => addCase(current, built) });
  }
  if (request.kind === "import") {
    const cases = request.cases;
    return writeCases({ ...base, message: (landed) => `chore(evals): import ${landed.length} backtest cases to ${request.projectId}`, change: (current) => addNewCases(current, cases) });
  }
  if (request.kind === "edit") {
    const { id, edit } = request;
    return writeCase({ ...base, message: `chore(evals): edit ${id} in ${request.projectId}`, change: (current) => editCase(current, id, edit) });
  }
  if (request.kind === "check") {
    const { id, check } = request;
    return writeCase({ ...base, message: `chore(evals): attach a check to ${id} in ${request.projectId}`, change: (current) => attachCheck(current, id, check) });
  }
  if (request.kind === "calibrate") {
    const { id, verdict } = request;
    return writeCase({ ...base, message: `chore(evals): calibrate ${id} in ${request.projectId}`, change: (current) => calibrateCase(current, id, verdict) });
  }
  if (request.kind === "keep") {
    const id = request.id;
    // The write's own time: runs that started before the operator kept the case no longer count.
    const at = new Date().toISOString();
    return writeCase({ ...base, message: `chore(evals): keep ${id} in ${request.projectId}`, change: (current) => keepCase(current, id, at) });
  }
  const id = request.id;
  return writeCase({ ...base, message: `chore(evals): retire ${id} in ${request.projectId}`, change: (current) => retireCase(current, id) });
}

/** An edit request file, `{id, tags?, notes?}`: strict, so a malformed one refuses rather than editing the wrong field. */
export function parseEditRequest(value: unknown, where: string): { id: string; edit: CaseEdit } {
  const bad = (what: string): never => fail(`${where}: ${what}`);
  if (!object(value)) return bad("must be an object");
  onlyKeys(value, ["id", "tags", "notes"], "", `${where}: `);
  if (typeof value.id !== "string" || !ID.test(value.id)) bad("id must be a kebab-case case id");
  if (value.tags !== undefined && (!Array.isArray(value.tags) || !(value.tags as unknown[]).every((tag) => typeof tag === "string"))) bad("tags must be a list of strings");
  if (value.notes !== undefined && typeof value.notes !== "string") bad("notes must be a string");
  if (value.tags === undefined && value.notes === undefined) bad("an edit needs tags or notes");
  return {
    id: value.id as string,
    edit: { ...(value.tags !== undefined ? { tags: [...(value.tags as string[])] } : {}), ...(value.notes !== undefined ? { notes: value.notes as string } : {}) },
  };
}

/** A check request file, `{id, check}`: the check parses as a stored one, so the lock never writes what a read would refuse. */
export function parseCheckRequest(value: unknown, where: string): { id: string; check: OperatorCheck } {
  if (!object(value)) return fail(`${where}: must be an object`);
  onlyKeys(value, ["id", "check"], "", `${where}: `);
  if (typeof value.id !== "string" || !ID.test(value.id)) fail(`${where}: id must be a kebab-case case id`);
  return { id: value.id as string, check: parseOperatorCheck(value.check, where) };
}

/** A calibrate request file, `{id, verdict}`: the verdict parses as a stored one, so the lock never writes what a read would refuse. */
export function parseCalibrateRequest(value: unknown, where: string): { id: string; verdict: CalibrationVerdict } {
  if (!object(value)) return fail(`${where}: must be an object`);
  onlyKeys(value, ["id", "verdict"], "", `${where}: `);
  if (typeof value.id !== "string" || !ID.test(value.id)) fail(`${where}: id must be a kebab-case case id`);
  return { id: value.id as string, verdict: parseCalibrationVerdict(value.verdict, where, "verdict") };
}

/** `_write --project-id <id> (--add <file> | --retire <id> | --keep <id> | --import <file> | --edit <file> | --check <file> | --calibrate <file>)`: the internal command the lock re-execs. */
function internalWrite(argv: string[]): number {
  const [flag, projectId, kind, value, ...extra] = argv;
  if (flag !== "--project-id" || !projectId || !value || extra.length > 0 || (kind !== "--add" && kind !== "--retire" && kind !== "--keep" && kind !== "--import" && kind !== "--edit" && kind !== "--check" && kind !== "--calibrate")) {
    console.error("usage: evals-set.ts _write --project-id <id> (--add <case.json> | --retire <id> | --keep <id> | --import <cases.json> | --edit <edit.json> | --check <check.json> | --calibrate <calibrate.json>)");
    return 64;
  }
  const parsed = (): unknown => JSON.parse(readFileSync(value, "utf8"));
  let request: WriteRequest;
  if (kind === "--add") request = { projectId, kind: "add", case: parseCase(parsed(), value) };
  else if (kind === "--retire") request = { projectId, kind: "retire", id: value };
  else if (kind === "--keep") request = { projectId, kind: "keep", id: value };
  else if (kind === "--edit") request = { projectId, kind: "edit", ...parseEditRequest(parsed(), value) };
  else if (kind === "--check") request = { projectId, kind: "check", ...parseCheckRequest(parsed(), value) };
  else if (kind === "--calibrate") request = { projectId, kind: "calibrate", ...parseCalibrateRequest(parsed(), value) };
  else {
    const list = parsed();
    if (!Array.isArray(list)) throw new Error(`${value}: must be a JSON list of cases`);
    request = { projectId, kind: "import", cases: list.map((entry, index) => parseCase(entry, `${value}#${index}`)) };
  }
  console.log(JSON.stringify(lockedWrite(request)));
  return 0;
}

export function realEvalsSetDeps(): EvalsSetDeps {
  return {
    home: evalsHome(),
    git: defaultGit,
    projectId: (path) => projectIdFor(path).id,
    sample: (config) => buildPrSample(config, prSampleDeps(config)),
    changedFiles: async (repo, pr) => (await spawnGh(["api", `repos/${repo}/pulls/${pr}/files`, "--paginate", "--jq", ".[] | select(.status != \"removed\") | .filename"]))
      .split("\n").map((line) => line.trim()).filter((line) => line !== ""),
    write: lockedWrite,
    ledger: (id) => readRecorded(id, evalsHome(), defaultGit),
    ledgerTickets: (path) => backtestTickets(path),
    ledgerSample: (config, read) => {
      const base = prSampleDeps(config);
      return buildPrSample(config, { ...base, readTicket: (ref) => (/^#\d+$/.test(ref) ? base.readTicket(ref) : read(ref)) });
    },
    verifyCheck: (c, spec, options) => {
      const own = options.source === undefined;
      // The project's worktree setup fits the project's own checkout, as completePlan
      // uses it; another checkout's setup is not the project's to name.
      const setup = own ? loadProjectConfig(options.projectPath).worktreeSetup.map((step) => step.command).join(" && ") : "";
      const config = parseBacktest({
        project: options.projectPath, source: { kind: "pr", repo: c.repo, prs: c.prs.map((pr) => pr.number), ticket: null },
        // trialMinutes bounds each run of the check when no --timeout is given: ten minutes.
        caps: { trialMinutes: 10, batchMinutes: 10 },
        sources: { [c.repo]: options.source ?? options.projectPath },
        ...(setup === "" ? {} : { scoring: { setup } }),
      });
      // The dashboard gives up on this process at its own bound with a SIGTERM:
      // stop the run in flight (its process group) and remove the scratch clone,
      // and since the outcome is then an error, nothing is written.
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      return verifyCheck(config, { repo: c.repo, baseCommit: c.baseCommit, humanPrs: c.prs, spec }, {
        log: (line) => console.error(line), signal: controller.signal, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      }).finally(() => {
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
      });
    },
    suggestSignals: readSuggestSignals,
    noiseFloors: (path) => {
      // A config that cannot be loaded is the default stale share; the floors are still the project's.
      let staleShare = DEFAULT_STALE_SHARE;
      try { staleShare = noiseFloorSettings(loadProjectConfig(path)).staleShare; } catch { /* default */ }
      return { floors: readNoiseFloors(path), staleShare };
    },
    saturationRuns: (path) => {
      // A broken config is the default window: it must not cost the page.
      try { return saturationSettings(loadProjectConfig(path)).runs; } catch { return DEFAULT_SATURATION_RUNS; }
    },
    now: () => new Date().toISOString(),
    user: () => process.env.RALPH_LOOP_NAME?.trim() || userInfo().username,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
}

if (import.meta.main) {
  try {
    const argv = process.argv.slice(2);
    process.exitCode = argv[0] === "_write" ? internalWrite(argv.slice(1)) : await runEvalsSet(argv, realEvalsSetDeps());
    // suggest gives up on a tracker read past its deadline, but the abandoned
    // request (and its retries) may still hold the event loop open; the answer
    // is already printed, so exit rather than hang until the dashboard kills us.
    if (argv[0] === "suggest") {
      // Flush the printed answer first: exiting with a pipe's write still queued would cut it off.
      await new Promise<void>((done) => process.stdout.write("", () => done()));
      process.exit(process.exitCode);
    }
  } catch (error) {
    console.error(`evals-set: ${buildRedactor()(String(error))}`);
    process.exitCode = 1;
  }
}
