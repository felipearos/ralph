#!/usr/bin/env bun
/**
 * The newest journal entries, for a loop's orientation step.
 *
 *     bun "$RALPH_HOME/journal-read.ts" recent [--count 8]
 *
 * Every prompt used to read the journal with its own `git -C "$RALPH_HOME"`
 * pipeline against the harness's `origin/main`. Since `journal.branch` a
 * project's entries may live on a branch of the project's own repository
 * instead, and one reader that resolves that (`journal-home.ts`) is how the
 * prompts cannot drift from the publisher.
 *
 * It fetches the one ref first, bounded, because these are every loop's
 * entries and the point is to see the one another loop wrote an hour ago. A
 * failed fetch still prints what the last fetch left: a stale journal is
 * worth reading, and a loop must never stop over it.
 */
import { spawnSync } from "node:child_process";

import { journalLocation } from "./journal-home";
import { harnessJournalReader } from "./observe";
import { projectRoot } from "./paths";

const DEFAULT_COUNT = 8;
const FETCH_TIMEOUT_MS = 30_000;

export function main(args: string[], env: Record<string, string | undefined> = process.env): number {
  if (args[0] !== "recent") {
    process.stderr.write("usage: journal-read.ts recent [--count <n>]\n");
    return 2;
  }
  const at = args.indexOf("--count");
  const raw = at < 0 ? DEFAULT_COUNT : Number(args[at + 1]);
  const count = Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_COUNT;
  const root = projectRoot(process.cwd(), env);
  const place = journalLocation(root, env);
  spawnSync("git", ["-C", place.home, "fetch", "--quiet", "origin", `+refs/heads/${place.branch}:refs/remotes/${place.ref}`], {
    timeout: FETCH_TIMEOUT_MS,
    stdio: "ignore",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const entries = harnessJournalReader(root, place.projectSide ? undefined : place.home, env)().slice(-count);
  if (entries.length === 0) {
    process.stdout.write(`(no journal entries yet on ${place.ref} of ${place.home})\n`);
    return 0;
  }
  for (const entry of entries) process.stdout.write(`\n=== ${entry.name}\n${entry.body}`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
