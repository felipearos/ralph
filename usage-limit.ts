#!/usr/bin/env bun
/**
 * Read a rejected usage limit, and when it resets, out of a turn's events.
 *
 * When the account's usage limit rejects a `claude -p` turn, the session ends
 * at once with no sigil, and the supervisor used to read that as a failed
 * iteration: 2026-10-21, a five_hour rejection stopped thirteen loops as
 * failed, each needing an operator to restart it after the reset. A limit is
 * not a failure — it clears on its own at a time the events already name — so
 * the supervisor should wait it out and go again (#407).
 *
 * The signal is the LAST `rate_limit_event` in the iteration's events file,
 * and only its `rate_limit_info.status`: `overageStatus` reads "rejected" on
 * ordinary allowed events, so it decides nothing. A rejection that overage
 * absorbed (`isUsingOverage` or `overageInUse` true) let the turn run and is
 * not a limit — `stream-render.py` applies the same rule. The reset is, first
 * that works:
 *
 *   event    `rate_limit_info.resetsAt` (unix seconds);
 *   text     the last "resets 10:30pm (America/Santiago)" in an assistant
 *            text block or a `result` — the next such wall-clock time in
 *            that zone after now;
 *   default  now + RALPH_USAGE_WAIT_DEFAULT_SECONDS (1800).
 *
 * An event or text reset gets RALPH_USAGE_RESET_MARGIN_SECONDS (120) added, so
 * the next turn does not land a second before the window rolls. Every wait is
 * capped at the limit's window (five_hour 5h, seven_day 7d, anything else 5h):
 * a stale or absurd reset can never park the loop longer than the window.
 * And none is shorter than RALPH_USAGE_MIN_WAIT_SECONDS (60, at least 1): the
 * wait spends no iteration, so a wait of nothing would retry with no delay.
 *
 * Usage (as `ralph.sh` calls it):
 *   usage-limit.ts detect --events <file> --state <file>
 *       limited: write the state file, print "waiting for usage reset until
 *       HH:MM (<window>, <source>)", exit 0. Not limited or any error: print
 *       nothing, exit 1.
 *   usage-limit.ts remaining --state <file>
 *       print whole seconds left until the state's reset (never negative),
 *       exit 0. Missing or malformed state: print 0, exit 1.
 *
 * Every failure degrades to "no wait" — a supervisor wait never halts a loop.
 * RALPH_USAGE_NOW_MS overrides the clock (tests only).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_MARGIN_SECONDS = 120;
export const DEFAULT_WAIT_SECONDS = 1800;
export const DEFAULT_MIN_WAIT_SECONDS = 60;

const WINDOW_SECONDS: Record<string, number> = { five_hour: 18_000, seven_day: 604_800 };
const FALLBACK_WINDOW_SECONDS = 18_000;

export type UsageLimitSource = "event" | "text" | "default";

export type UsageLimit = {
  untilMs: number;
  window: string;
  source: UsageLimitSource;
};

export type UsageLimitOptions = {
  marginSeconds: number;
  defaultSeconds: number;
  /** The shortest wait ever armed; at least 1. */
  minSeconds: number;
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLines(lines: string[]): Json[] {
  const events: Json[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isObject(parsed)) events.push(parsed);
    } catch {
      // A torn or foreign line is not evidence either way.
    }
  }
  return events;
}

function textsOf(event: Json): string[] {
  if (event.type === "result") return typeof event.result === "string" ? [event.result] : [];
  if (event.type !== "assistant" || !isObject(event.message)) return [];
  const content = event.message.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    isObject(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
  );
}

/** Milliseconds the zone's wall clock is ahead of UTC at `utcMs`. */
function zoneOffsetMs(format: Intl.DateTimeFormat, utcMs: number): number {
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const part = (name: string) => parts[name] ?? 0;
  const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour") % 24, part("minute"), part("second"));
  return wall - Math.floor(utcMs / 1000) * 1000;
}

/**
 * The next instant strictly after `nowMs` when the clock in `zone` reads
 * hour:minute; null for an unknown zone.
 */
export function nextWallClock(hour: number, minute: number, zone: string, nowMs: number): number | null {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23",
      year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
    });
  } catch {
    return null;
  }
  // Today's date in the zone, then try today, tomorrow and the day after: one
  // of them is the next occurrence even across a DST shift.
  const today = new Date(nowMs + zoneOffsetMs(format, nowMs));
  for (let day = 0; day <= 2; day++) {
    const wall = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + day, hour, minute);
    // Two passes settle the offset at the candidate itself, not at now.
    let utc = wall - zoneOffsetMs(format, wall);
    utc = wall - zoneOffsetMs(format, utc);
    if (utc > nowMs) return utc;
  }
  return null;
}

const RESETS_TEXT = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/gi;

function resetFromText(events: Json[], nowMs: number): number | null {
  let last: RegExpExecArray | null = null;
  for (const event of events) {
    for (const text of textsOf(event)) {
      for (const match of text.matchAll(RESETS_TEXT)) last = match;
    }
  }
  if (!last) return null;
  const hour12 = Number(last[1]);
  const minute = last[2] === undefined ? 0 : Number(last[2]);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  // 12am is midnight, 12pm is noon.
  const hour = (hour12 % 12) + ((last[3] ?? "").toLowerCase() === "pm" ? 12 : 0);
  return nextWallClock(hour, minute, (last[4] ?? "").trim(), nowMs);
}

export function readUsageLimit(lines: string[], nowMs: number, opts: UsageLimitOptions): UsageLimit | null {
  const events = parseLines(lines);
  const limitEvent = events.filter((event) => event.type === "rate_limit_event").at(-1);
  if (!limitEvent || !isObject(limitEvent.rate_limit_info)) return null;
  const info = limitEvent.rate_limit_info;
  if (info.status !== "rejected") return null;
  if (info.isUsingOverage === true || info.overageInUse === true) return null;

  const window = typeof info.rateLimitType === "string" && info.rateLimitType ? info.rateLimitType : "unknown";
  const capMs = nowMs + (WINDOW_SECONDS[window] ?? FALLBACK_WINDOW_SECONDS) * 1000;
  // A wait the supervisor never sleeps is a retry with no delay: the wait does
  // not spend the iteration cap, so a reset already past with no margin (or a
  // limit that outlasts the reset it named) would spawn rejected turns back to
  // back for as long as it lasts. The floor bounds that to one per minimum.
  const floorMs = nowMs + Math.max(1, opts.minSeconds) * 1000;
  const bounded = (untilMs: number): number => Math.max(Math.min(untilMs, capMs), floorMs);

  const resetsAt = info.resetsAt;
  let source: UsageLimitSource = "event";
  let resetMs = typeof resetsAt === "number" && Number.isFinite(resetsAt) ? resetsAt * 1000 : null;
  if (resetMs === null) {
    source = "text";
    resetMs = resetFromText(events, nowMs);
  }
  if (resetMs === null) {
    return { untilMs: bounded(nowMs + opts.defaultSeconds * 1000), window, source: "default" };
  }
  const untilMs = Math.max(resetMs, nowMs) + opts.marginSeconds * 1000;
  return { untilMs: bounded(untilMs), window, source };
}

/** A non-negative integer knob; anything else is the default, never an error. */
export function knob(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !/^\s*\d+\s*$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : fallback;
}

function nowMs(): number {
  const raw = process.env.RALPH_USAGE_NOW_MS;
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) && raw?.trim() ? value : Date.now();
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hhmm(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function detect(args: string[]): number {
  const eventsPath = flag(args, "--events");
  const statePath = flag(args, "--state");
  if (!eventsPath || !statePath) return 1;
  const now = nowMs();
  const limit = readUsageLimit(readFileSync(eventsPath, "utf8").split("\n"), now, {
    marginSeconds: knob(process.env.RALPH_USAGE_RESET_MARGIN_SECONDS, DEFAULT_MARGIN_SECONDS),
    defaultSeconds: knob(process.env.RALPH_USAGE_WAIT_DEFAULT_SECONDS, DEFAULT_WAIT_SECONDS),
    minSeconds: knob(process.env.RALPH_USAGE_MIN_WAIT_SECONDS, DEFAULT_MIN_WAIT_SECONDS),
  });
  if (!limit) return 1;
  const state = {
    until: new Date(limit.untilMs).toISOString(),
    window: limit.window,
    source: limit.source,
    armedAt: new Date(now).toISOString(),
  };
  mkdirSync(dirname(statePath), { recursive: true });
  // tmp+rename so a reader racing the write never sees half a file.
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  renameSync(tmp, statePath);
  console.log(`waiting for usage reset until ${hhmm(limit.untilMs)} (${limit.window}, ${limit.source})`);
  return 0;
}

function remaining(args: string[]): number {
  const statePath = flag(args, "--state");
  let untilMs = NaN;
  try {
    const state: unknown = statePath ? JSON.parse(readFileSync(statePath, "utf8")) : null;
    if (isObject(state) && typeof state.until === "string") untilMs = Date.parse(state.until);
  } catch {
    // Unreadable state is no wait.
  }
  if (!Number.isFinite(untilMs)) {
    console.log("0");
    return 1;
  }
  console.log(String(Math.max(0, Math.ceil((untilMs - nowMs()) / 1000))));
  return 0;
}

export function main(args: string[]): number {
  try {
    if (args[0] === "detect") return detect(args.slice(1));
    if (args[0] === "remaining") return remaining(args.slice(1));
  } catch {
    // Never fatal to a loop: an unreadable limit means no wait.
  }
  return 1;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
