#!/usr/bin/env bun
/**
 * The clerk session's one window onto its work: the batch the gate handed
 * over, read from the clerk's store (felipearos/ralph#315).
 *
 * Read-only, and it needs no credential. The gate has already read Slack and
 * gathered each report's dedupe candidates from the intake board; this prints what it
 * stored, so the session classifies exactly what the gate saw and never holds
 * a token that could write to either service. `--check` runs the same
 * validator the gate will run on the plan file, so a session can fix its plan
 * before it ends rather than spend its one retry.
 *
 * Usage (from the loop's worktree):
 *   bun "$RALPH_HOME/clerk/batch.ts"            the batch, as JSON
 *   bun "$RALPH_HOME/clerk/batch.ts" --check    validate the plan file; exit 0 valid, 1 not
 *
 * Exit codes: 0 · 1 the plan is invalid · 3 no batch is waiting · 64 usage.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { projectRoot } from "../paths";
import { clerkRules, loadProjectConfig } from "../project-config";
import { planPath, validatePlan, type BatchReport } from "./plan";
import { localCopies } from "./readable";
import { clerkStorePath, readClerkStore, type Batch } from "./store";

/**
 * What the session is shown: the batch, where its plan goes, and what was
 * wrong with the last one. Under `root`, each message also lists the local
 * copies of its PDFs and images the gate downloaded (`clerk/readable.ts`).
 */
export function batchView(batch: Batch, root?: string): Record<string, unknown> {
  const readableOf = (message: BatchReport["messages"][number]): { readable?: string[] } => {
    const copies = root === undefined ? [] : localCopies(root, batch.id, message.attachments);
    return copies.length === 0 ? {} : { readable: copies };
  };
  return {
    batch: batch.id,
    attempt: batch.attempt,
    plan: planPath(batch.id),
    previousProblems: batch.problems ?? [],
    reports: batch.reports.map((report: BatchReport, index) => ({
      report: report.id,
      permalink: report.permalink,
      author: report.authorName,
      // Only on a report that was ignored before and that a person then
      // asked, in its thread, to have filed: it may not be ignored again.
      ...(report.hint === undefined ? {} : { hint: `${report.hint} pidió en el hilo que se registre: no se puede ignorar` }),
      messages: report.messages.map((message) => ({
        author: report.names[message.user] ?? message.user,
        reply: message.reply,
        text: message.text,
        files: message.files,
        ...readableOf(message),
      })),
      candidates: report.candidates,
      // The reports before it in this batch, oldest first: filed before it
      // is, so it may duplicate one of them. The board candidates were read
      // before any of the batch was filed and cannot hold them.
      earlierReports: batch.reports.slice(0, index).map((earlier) => earlier.id),
    })),
  };
}

/** The plan file, parsed, or why it could not be; undefined when the session wrote none. */
export function readPlan(root: string, batchId: string): unknown {
  const path = join(root, planPath(batchId));
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    return `${planPath(batchId)} is not JSON: ${(error as Error).message}`;
  }
}

function main(argv: string[]): number {
  const check = argv.includes("--check");
  if (argv.some((arg) => arg !== "--check")) {
    console.error('usage: bun "$RALPH_HOME/clerk/batch.ts" [--check]');
    return 64;
  }
  const root = projectRoot();
  const rules = clerkRules(loadProjectConfig(root));
  if (rules === null) {
    console.error("clerk-batch: the project's .ralph/config.json has no 'clerk' block");
    return 3;
  }
  const loop = process.env.RALPH_LOOP_NAME?.trim() || "clerk";
  const { store } = readClerkStore(clerkStorePath(loop, root), rules.channel);
  const batch = store.batch;
  if (batch === null) {
    console.error("clerk-batch: no batch is waiting; the gate hands one over before an iteration starts");
    return 3;
  }
  if (!check) {
    console.log(JSON.stringify(batchView(batch, root), null, 2));
    return 0;
  }
  const validated = validatePlan(readPlan(root, batch.id) ?? `no plan at ${planPath(batch.id)}`, batch.id, batch.reports, { pwaAgents: rules.pwaAgents === true, apps: rules.appLabels });
  if (!validated.ok) {
    console.log(`clerk-batch: the plan for ${batch.id} is invalid:`);
    for (const problem of validated.problems) console.log(`  - ${problem}`);
    return 1;
  }
  console.log(`clerk-batch: the plan for ${batch.id} is valid: ${validated.decisions.length} report(s)`);
  for (const note of validated.notes) console.log(`  - note: ${note}`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`clerk-batch: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 3;
  }
}
