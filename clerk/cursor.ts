#!/usr/bin/env bun
/**
 * The clerk's cursor, read or moved to "now" by an operator
 * (felipearos/ralph#315, user story 45).
 *
 * Going live is a reviewed edit to the intake project's `clerk.mode`. The
 * channel's history up to that moment was already classified in shadow, and
 * filing it again for real would land a burst of old reports on the team in
 * one poll. So the flip is: stop the loop, merge the config change, move the
 * cursor to now with this, start the loop. Nothing posted before the move is
 * filed; everything after it is.
 *
 * `--since` moves it to a moment instead, past or present: the next polls read
 * the channel from then on, so a clerk moved to a channel that was already in
 * use can take the weeks before it started. The backlog drains a batch per
 * poll, oldest first — the gate reads only a batch's threads per poll, and a
 * 429 waits its `Retry-After` — and a report already processed is not handed
 * over again. A date or a time with no offset is read in America/Santiago,
 * where the team is; one with `Z` or `±HH:MM` is read as written.
 *
 * Usage (from the clerk loop's worktree, with RALPH_LOOP_NAME set or the
 * worktree's `.ralph/loop-name`):
 *   bun "$RALPH_HOME/clerk/cursor.ts"          print the cursor and what is pending
 *   bun "$RALPH_HOME/clerk/cursor.ts" --now    move it to now, dropping a handed batch
 *   bun "$RALPH_HOME/clerk/cursor.ts" --since 2026-10-01
 *                                              move it to that moment, dropping a handed batch
 *   bun "$RALPH_HOME/clerk/cursor.ts" --since 2026-10-01T09:30
 *   bun "$RALPH_HOME/clerk/cursor.ts" --since 2026-10-01 --redo
 *                                              and classify again, in shadow only,
 *                                              the reports posted from then on
 *
 * `--redo` is how a shadow clerk is re-run over history after a change to its
 * config or prompt. A plain `--since` keeps the processed reports, so moving
 * the cursor back reclassifies nothing; `--redo` also drops this channel's
 * processed reports and shadow decisions from the moment on, backs the store
 * up beside itself first, and appends a `superseded` event per dropped report
 * to the metrics ledger so the summary counts each report once, as its new
 * classification. It refuses a live clerk: there a redo would file real
 * tickets again.
 *
 * Exit codes: 0 · 3 the project has no clerk · 64 usage, or `--redo` on a live clerk.
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { LOOP_NAME_RELATIVE_PATH, projectRoot } from "../paths";
import { clerkRules, loadProjectConfig } from "../project-config";
import { appendEvent, clerkMetricsPath } from "./metrics";
import { msTs } from "./slack";

import { clerkStorePath, dropShadowDecisionsAfter, readClerkStore, withClerkStore } from "./store";

/** Where a `--since` with no offset is read: the team's clock, as the KPI report's default. */
export const SINCE_TIME_ZONE = "America/Santiago";

const SINCE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?(Z|[+-]\d{2}:\d{2})?$/;

/** How far `timeZone`'s wall clock is ahead of UTC at `ms`, in milliseconds. */
function zoneOffset(ms: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return wall - (ms - (ms % 1000));
}

/**
 * The epoch milliseconds `text` names — an ISO date (`2026-10-01`, its
 * midnight) or date and time (`2026-10-01T09:30`, seconds optional) — or why
 * it names none. Without an offset it is a wall time in `timeZone`; one a
 * DST change skips lands within an hour of it. A moment still to come is
 * refused: the cursor says what is done with, and nothing past now is.
 */
export function sinceMs(text: string, nowMs: number, timeZone = SINCE_TIME_ZONE): { ms: number } | { problem: string } {
  const match = SINCE.exec(text.trim());
  if (match === null) return { problem: `--since takes an ISO date or date and time, such as 2026-10-01 or 2026-10-01T09:30; got ${JSON.stringify(text)}` };
  const [, year, month, day, hour = "00", minute = "00", second = "00", fraction = "0", offset] = match;
  const wall = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(fraction.padEnd(3, "0")));
  const back = new Date(wall);
  // Date.UTC rolls 2026-02-30 over to March: a date that does not round-trip does not exist.
  if (back.getUTCMonth() !== Number(month) - 1 || back.getUTCDate() !== Number(day) || back.getUTCHours() !== Number(hour) || back.getUTCMinutes() !== Number(minute) || back.getUTCSeconds() !== Number(second)) {
    return { problem: `--since ${JSON.stringify(text)} is not a date and time that exists` };
  }
  let ms: number;
  if (offset === "Z") ms = wall;
  else if (offset !== undefined) {
    const sign = offset.startsWith("-") ? -1 : 1;
    ms = wall - sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6))) * 60_000;
  } else {
    // Twice: the first guess's offset can be the far side of a DST change.
    const first = wall - zoneOffset(wall, timeZone);
    ms = wall - zoneOffset(first, timeZone);
  }
  if (ms > nowMs) return { problem: `--since ${JSON.stringify(text)} is still to come; the cursor marks what is done with, and nothing after now is` };
  return { ms };
}

/** The loop this worktree runs as: the environment, else `.ralph/loop-name`, as `ralph.sh` reads it. */
function loopName(root: string): string {
  const fromEnv = process.env.RALPH_LOOP_NAME?.trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(join(root, LOOP_NAME_RELATIVE_PATH), "utf8").trim() || "clerk";
  } catch {
    return "clerk";
  }
}

const USAGE = 'usage: bun "$RALPH_HOME/clerk/cursor.ts" [--now | --since <date or date-time> [--redo]]';

async function main(argv: string[]): Promise<number> {
  let target: { kind: "now" } | { kind: "since"; text: string } | null = null;
  let redo = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--redo" && !redo) {
      redo = true;
      continue;
    }
    if (target !== null) {
      console.error(USAGE);
      return 64;
    }
    if (arg === "--now") target = { kind: "now" };
    else if (arg === "--since" && argv[index + 1] !== undefined) target = { kind: "since", text: argv[++index]! };
    else if (arg.startsWith("--since=")) target = { kind: "since", text: arg.slice("--since=".length) };
    else {
      console.error(USAGE);
      return 64;
    }
  }
  // A redo says from when; "now" would drop nothing worth redoing.
  if (redo && target?.kind !== "since") {
    console.error(USAGE);
    return 64;
  }
  let to = Date.now();
  if (target?.kind === "since") {
    const since = sinceMs(target.text, to);
    if ("problem" in since) {
      console.error(`clerk-cursor: ${since.problem}`);
      return 64;
    }
    to = since.ms;
  }
  const root = projectRoot();
  const rules = clerkRules(loadProjectConfig(root));
  if (rules === null) {
    console.error("clerk-cursor: the project's .ralph/config.json has no 'clerk' block");
    return 3;
  }
  if (redo && rules.mode !== "shadow") {
    console.error(
      `clerk-cursor: --redo refused: clerk.mode is ${rules.mode}, and a redo hands every report from the moment on to be filed again — real tickets, twice. ` +
        "It is for a shadow clerk only; to read history live without refiling it, use --since alone",
    );
    return 64;
  }
  const loop = loopName(root);
  const path = clerkStorePath(loop, root);
  if (target === null) {
    const { store, problem } = readClerkStore(path, rules.channel);
    if (problem !== null) console.log(`clerk-cursor: ${problem}`);
    console.log(`clerk-cursor: ${rules.channel} (${rules.mode}) — cursor ${store.cursor || "not started"}, batch ${store.batch?.id ?? "none"}`);
    return 0;
  }
  const moved = await withClerkStore(path, rules.channel, (store, problem) => {
    if (problem !== null) console.log(`clerk-cursor: ${problem}`);
    const before = { cursor: store.cursor, batch: store.batch?.id ?? null };
    // Copied inside the lock and before the write, so the backup is exactly
    // the store the redo changed. A colon-free stamp: it is a file name.
    let backup: string | null = null;
    if (redo && existsSync(path)) {
      backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      copyFileSync(path, backup);
    }
    // One millisecond before the moment, because the cursor is what is done
    // with: a message posted at exactly `--since` is read. Processed reports
    // are kept, so moving it back hands over again none already dealt with —
    // unless this is a redo, which drops them from the moment on.
    store.cursor = msTs(target.kind === "since" ? Math.max(0, to - 1) : to);
    const dropped = redo ? dropShadowDecisionsAfter(store, store.cursor) : [];
    // A batch handed in shadow was classified against a shadow world; live,
    // it would be filed for real from a plan nobody checked as live.
    store.batch = null;
    store.progress = {};
    return { before, after: store.cursor, dropped, backup };
  });
  // After the store is written: a kill in between leaves events that will be
  // recorded again by the redone apply, uncancelled, which costs the summary
  // a double count of those reports — never a report not reclassified.
  let lost = 0;
  if (redo) {
    const ledger = clerkMetricsPath(loop, root);
    const at = new Date().toISOString();
    for (const report of moved.dropped) {
      if (!appendEvent(ledger, { v: 1, kind: "superseded", at, report, mode: "shadow" })) lost += 1;
    }
  }
  console.log(
    `clerk-cursor: ${rules.channel} cursor moved from ${moved.before.cursor || "not started"} to ${moved.after}` +
      `${moved.before.batch === null ? "" : `; dropped handed batch ${moved.before.batch}`} — nothing posted before it will be filed` +
      `${target.kind === "since" ? `, and the history after it is read from the next poll on, ${rules.batchSize} reports a batch` : ""}`,
  );
  if (redo) {
    console.log(
      `clerk-cursor: redo in shadow — ${moved.dropped.length} report${moved.dropped.length === 1 ? "" : "s"} dropped to be classified again` +
        `${moved.backup === null ? "" : `; the store before it is ${moved.backup}`}` +
        `${lost === 0 ? "" : `; ${lost} superseded event${lost === 1 ? "" : "s"} could not be written to the metrics ledger, so the summary counts those reports twice`}`,
    );
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`clerk-cursor: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 3;
  }
}
