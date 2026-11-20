/**
 * What an apply has already done, so a rerun finishes it rather than repeating it.
 *
 * Triage writes are not transactional: a plan is a dozen GitHub calls, and the
 * apply can die between any two of them — a 403, a killed process, a host
 * reboot. The ledger is the record that makes the rerun safe. Every op carries
 * an `opId`, every completed write appends a line here, and a rerun skips what
 * the ledger already claims.
 *
 * It is append-only JSONL, one file per unit, under the project's ignored
 * `.ralph/logs/`. JSONL because the failure mode that matters is a kill in the
 * middle of a write: a truncated last line costs the reader one entry, where a
 * truncated JSON document would cost it all of them.
 *
 * The ledger is a fast path, never the authority. A comment or issue is also
 * looked up by its op-id marker on GitHub before it is posted (`triage/apply.ts`),
 * because the line recording it is written AFTER the write it records — the one
 * ordering that can lose an entry.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { LOGS_RELATIVE_DIR, projectRoot } from "../paths";
import type { TriageOp } from "./plan";

export interface LedgerEntry {
  opId: string;
  op: TriageOp["op"];
  /** ISO 8601, as the process saw it; only ever read by a human. */
  at: string;
  /**
   * `applied` means the GitHub write happened. `skipped` records that a rerun
   * found the write already done — kept because it is the evidence that the
   * idempotency check fired, which a rerun test has no other way to see.
   */
  result: "applied" | "skipped";
  /** The issue a `create-issue` produced, so a later ref resolves after a crash. */
  issue?: number;
  commentId?: string;
  detail?: string;
}

export function ledgerPath(unit: number, root: string = projectRoot()): string {
  return join(root, LOGS_RELATIVE_DIR, `triage-apply-${unit}.jsonl`);
}

/** Missing file means nothing has been applied yet, which is not an error. */
export function readLedger(path: string): LedgerEntry[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const entries: LedgerEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      // A half-written last line is the expected shape of a kill mid-apply.
      // Skipping it loses at most the record of one write, and that write is
      // re-checked against GitHub anyway.
      continue;
    }
    if (isEntry(parsed)) entries.push(parsed);
  }
  return entries;
}

export function appendLedger(path: string, entry: LedgerEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * The ops the ledger says are done, newest record per id.
 *
 * A `skipped` entry does not enter the map: it records a rerun observing the
 * write, not the write, and letting it answer for an op would make a ledger
 * whose only line for an id is `skipped` look like a completed one.
 */
export function doneOps(entries: readonly LedgerEntry[]): Map<string, LedgerEntry> {
  const done = new Map<string, LedgerEntry>();
  for (const entry of entries) {
    if (entry.result === "applied") done.set(entry.opId, entry);
  }
  return done;
}

/** The issue numbers `create-issue` ops produced, by op id, for ref resolution after a crash. */
export function createdIssues(entries: readonly LedgerEntry[]): Map<string, number> {
  const created = new Map<string, number>();
  for (const entry of entries) {
    if (entry.result === "applied" && entry.op === "create-issue" && typeof entry.issue === "number") {
      created.set(entry.opId, entry.issue);
    }
  }
  return created;
}

function isEntry(value: unknown): value is LedgerEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.opId === "string" &&
    entry.opId !== "" &&
    typeof entry.op === "string" &&
    typeof entry.at === "string" &&
    (entry.result === "applied" || entry.result === "skipped")
  );
}
