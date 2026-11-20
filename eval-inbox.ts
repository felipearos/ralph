/**
 * The recommended-runs inbox (#872): eval run plans waiting for the operator.
 * An agent or a person recommends a plan with a reason; the operator starts
 * it or dismisses it. `evals-inbox.ts` is the CLI over this store.
 *
 * This module only stores plans. It never starts one: starting is the
 * operator's decision, made through the CLI's `start` verb alone, and a test
 * pins that this file imports nothing that could start a run.
 *
 * The store is one file, `inbox.json`, beside the project's run directories.
 * The run lister only reads subdirectories there, so a file is never taken
 * for a run.
 */
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { experimentsRoot } from "./eval-runs";
import { writeJsonAtomically } from "./loop-state";

export interface InboxEntry {
  id: string;
  /** The plan as `experiments.ts start --json` takes it; may name host paths, so it never leaves the host. */
  plan: Record<string, unknown>;
  recommendedBy: { kind: "agent" | "person"; name: string };
  reason: string;
  /** ISO timestamp. */
  addedAt: string;
}

export interface InboxFile { version: 1; entries: InboxEntry[] }

export const inboxPath = (project: string): string => join(experimentsRoot(project), "inbox.json");

const fail = (message: string): never => { throw new Error(`inbox: ${message}`); };

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], prefix: string, where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${where}unknown key ${prefix}${key}`);
}

const FILE_KEYS = ["version", "entries"] as const;
const ENTRY_KEYS = ["id", "plan", "recommendedBy", "reason", "addedAt"] as const;
const BY_KEYS = ["kind", "name"] as const;

/** Strict: an unknown key or a wrong type names its dotted path, so a hand-edited file says where it went wrong. */
export function parseInbox(value: unknown, where?: string): InboxFile {
  const at = where ? `${where}: ` : "";
  const bad = (path: string, want: string): never => fail(`${at}${path} must be ${want}`);
  const text = (from: Record<string, unknown>, key: string, path: string): string => {
    const got = from[key];
    if (typeof got !== "string" || got.trim() === "") bad(path, "a non-empty string");
    return got as string;
  };
  if (!object(value)) return bad("inbox", "an object with version and entries");
  onlyKeys(value, FILE_KEYS, "", at);
  if (value.version !== 1) bad("version", "1");
  if (!Array.isArray(value.entries)) bad("entries", "a list");
  const seen = new Set<string>();
  const entries = (value.entries as unknown[]).map((raw, index): InboxEntry => {
    const path = `entries[${index}]`;
    if (!object(raw)) return bad(path, "an object");
    onlyKeys(raw, ENTRY_KEYS, `${path}.`, at);
    const id = text(raw, "id", `${path}.id`);
    if (seen.has(id)) bad(`${path}.id`, "unique");
    seen.add(id);
    if (!object(raw.plan)) bad(`${path}.plan`, "an object");
    const by = raw.recommendedBy;
    if (!object(by)) return bad(`${path}.recommendedBy`, "an object with kind and name");
    onlyKeys(by, BY_KEYS, `${path}.recommendedBy.`, at);
    if (by.kind !== "agent" && by.kind !== "person") bad(`${path}.recommendedBy.kind`, "\"agent\" or \"person\"");
    const name = text(by, "name", `${path}.recommendedBy.name`);
    const reason = text(raw, "reason", `${path}.reason`);
    const addedAt = text(raw, "addedAt", `${path}.addedAt`);
    if (Number.isNaN(Date.parse(addedAt))) bad(`${path}.addedAt`, "a date");
    return { id, plan: raw.plan as Record<string, unknown>, recommendedBy: { kind: by.kind as "agent" | "person", name }, reason, addedAt };
  });
  return { version: 1, entries };
}

/** The inbox on disk; a missing file is an empty inbox, a malformed one throws with its dotted path. */
export function readInbox(project: string): InboxEntry[] {
  const path = inboxPath(project);
  if (!existsSync(path)) return [];
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    return fail(`${path}: not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseInbox(raw, path).entries;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Run `critical` under an exclusive lock file beside the inbox: an agent may
 * add while the dashboard dismisses, and each is a read-modify-write. Each
 * critical section is a few milliseconds; a lock older than 10s belongs to a
 * process that died inside one, and is broken. The attempt cap (about 20s of
 * 50ms waits) outlasts that threshold, so a dead holder's lock is always
 * broken before a waiter gives up, and both stay inside the dashboard's 30s
 * exec timeout, so the page reads the refusal rather than a killed command.
 * `critical` may be async, so a caller holding a lock on another path (the
 * proposals, #874) can await an inbox add inside its own section.
 */
export async function withLock<T>(path: string, critical: () => T | Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    let fd: number | null = null;
    try { fd = openSync(lock, "wx"); } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 10_000) unlinkSync(lock); } catch {}
      if (attempt > 400) throw new Error(`inbox: the inbox is locked: ${lock}`);
      await sleep(50);
      continue;
    }
    try {
      return await critical();
    } finally {
      closeSync(fd);
      try { unlinkSync(lock); } catch {}
    }
  }
}

/** A short kebab-safe slug, unique in the inbox it joins. */
function newId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `rec-${randomBytes(4).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * Add a recommendation. The inbox is read inside the lock, so a malformed
 * file refuses the add instead of being overwritten with only the new entry.
 */
export function addEntry(project: string, add: { plan: Record<string, unknown>; recommendedBy: InboxEntry["recommendedBy"]; reason: string }, now: string): Promise<InboxEntry> {
  const path = inboxPath(project);
  return withLock(path, () => {
    const entries = readInbox(project);
    const entry: InboxEntry = { id: newId(new Set(entries.map((e) => e.id))), plan: add.plan, recommendedBy: add.recommendedBy, reason: add.reason, addedAt: now };
    // Parsed as stored, so nothing the reader would refuse is ever written.
    const next = parseInbox({ version: 1, entries: [...entries, entry] }, path);
    writeJsonAtomically(path, next);
    return entry;
  });
}

/** Remove one recommendation; null when the inbox has no such id. */
export function removeEntry(project: string, id: string): Promise<InboxEntry | null> {
  const path = inboxPath(project);
  return withLock(path, () => {
    const entries = readInbox(project);
    const found = entries.find((e) => e.id === id);
    if (found === undefined) return null;
    writeJsonAtomically(path, { version: 1, entries: entries.filter((e) => e.id !== id) });
    return found;
  });
}

/**
 * Put back an entry a refused start had taken out, as it was: same id, same
 * time. A no-op when the id is back already.
 */
export function restoreEntry(project: string, entry: InboxEntry): Promise<void> {
  const path = inboxPath(project);
  return withLock(path, () => {
    const entries = readInbox(project);
    if (entries.some((e) => e.id === entry.id)) return;
    // Back in its place by age, so the inbox still lists oldest first.
    const next = [...entries, entry].sort((a, b) => Date.parse(a.addedAt) - Date.parse(b.addedAt));
    writeJsonAtomically(path, parseInbox({ version: 1, entries: next }, path));
  });
}

const positiveInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;
const isClerkPlan = (plan: Record<string, unknown>): boolean => (plan.source === undefined || plan.source === null) && plan.clerk !== undefined;
const sourceOf = (plan: Record<string, unknown>): Record<string, unknown> | null => (object(plan.source) ? plan.source : null);
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * The worst-case trial count of a stored plan, counted as `completePlan`
 * counts it for the batch cap: a clerk plan runs its sample cap, a PR plan
 * one case, a set plan the cases it names. Null when only the test set can
 * say: a set plan selected by tags, or by nothing.
 */
export function planTrials(plan: Record<string, unknown>): number | null {
  const source = sourceOf(plan);
  const clerk = isClerkPlan(plan);
  let cases: number;
  if (clerk) {
    // completePlan counts a cap that is not a positive integer as one; the parser refuses it at start.
    const cap = (plan.sample as { cap?: unknown } | undefined)?.cap;
    cases = positiveInt(cap) ? cap : 1;
  } else if (source?.kind === "pr") {
    // One PR run backtests one ticket, however many PRs resolved it.
    cases = 1;
  } else if (source?.kind === "set") {
    const named = listOf(source.cases);
    if (named.length === 0) return null;
    cases = named.length;
  } else {
    return null;
  }
  // Counted from the same arms the row names, so a plan without `arms` is not shown two and counted as one.
  return cases * armNames(plan).length * (1 + planRepeats(plan));
}

/** completePlan's default: a clerk or noise-floor plan repeats nothing, any other twice. */
function planRepeats(plan: Record<string, unknown>): number {
  if (typeof plan.repeats === "number") return plan.repeats;
  const noiseFloor = plan.noiseFloor !== undefined && plan.noiseFloor !== null;
  return isClerkPlan(plan) || noiseFloor ? 0 : 2;
}

/** One inbox row as a page shows it: a summary, never the plan, whose paths are the host's. */
export interface InboxRowView {
  id: string;
  /** One human label for what the plan runs. */
  source: string;
  arms: string[];
  repeats: number;
  trials: number | null;
  recommendedBy: InboxEntry["recommendedBy"];
  reason: string;
  addedAt: string;
}

function sourceLabel(plan: Record<string, unknown>): string {
  const source = sourceOf(plan);
  if (isClerkPlan(plan)) {
    const cap = (plan.sample as { cap?: unknown } | undefined)?.cap;
    return `clerk ${String(plan.clerk)}${positiveInt(cap) ? `, up to ${cap} cases` : ""}`;
  }
  if (source?.kind === "pr") return `PR ${listOf(source.prs).map((pr) => `#${String(pr)}`).join(", ")}`;
  if (source?.kind === "set") {
    const cases = listOf(source.cases);
    const tags = listOf(source.tags);
    if (cases.length > 0) return `test set (${cases.length} case${cases.length === 1 ? "" : "s"})`;
    if (tags.length > 0) return `test set (tags: ${tags.map(String).join(", ")})`;
    return "test set";
  }
  return "unknown source";
}

/** The arms' names; a plan without `arms` runs the engine's default arms (configArms): `b`, and `c` with a lineup. */
function armNames(plan: Record<string, unknown>): string[] {
  if (!Array.isArray(plan.arms)) return typeof plan.lineup === "string" ? ["b", "c"] : ["b"];
  return plan.arms.map((arm, index) => (object(arm) && typeof arm.name === "string" ? arm.name : `arm ${index + 1}`));
}

/** The rows the CLI's `list` prints; relayed to a remote page, so every field is a summary. */
export function inboxView(entries: readonly InboxEntry[]): InboxRowView[] {
  return entries.map((entry) => {
    const { plan } = entry;
    return {
      id: entry.id,
      source: sourceLabel(plan),
      arms: armNames(plan),
      repeats: planRepeats(plan),
      trials: planTrials(plan),
      recommendedBy: { kind: entry.recommendedBy.kind, name: entry.recommendedBy.name },
      reason: entry.reason,
      addedAt: entry.addedAt,
    };
  });
}
