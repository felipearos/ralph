#!/usr/bin/env bun
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { STAGES, type Stage } from "./models";
import { projectRoot } from "./paths";

export interface TimelineEvent extends Record<string, unknown> {
  ralph_stage?: unknown;
  ralph_iteration?: unknown;
  ralph_run?: unknown;
  ralph_received_at?: unknown;
}

export interface TimelineActivity {
  stage: Stage;
  label: string;
  at: string;
  iteration: number | null;
  run: string | null;
}

export const STAGE_STATES = ["started", "completed", "failed", "degraded"] as const;
export type TimelineStageState = (typeof STAGE_STATES)[number];

export interface TimelineStageEvent {
  stage: Stage;
  state: TimelineStageState;
  invocation: string;
  runner: string;
  model: string;
  at: string;
  iteration: number | null;
  run: string | null;
}

export interface TimelineRead {
  exists: boolean;
  path: string | null;
  events: TimelineEvent[];
  activities: TimelineActivity[];
}

const compact = (value: unknown, maximum = 240): string => {
  const text =
    typeof value === "string"
      ? value.replace(/\s+/g, " ").trim()
      : value === null || value === undefined
        ? ""
        : JSON.stringify(value);
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
};

const summarizeToolInput = (input: unknown): string => {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return compact(input);
  const fields = input as Record<string, unknown>;
  for (const key of [
    "command",
    "filePath",
    "file_path",
    "path",
    "pattern",
    "query",
    "description",
  ]) {
    if (typeof fields[key] === "string" && fields[key].trim())
      return compact(fields[key]);
  }
  return compact(input);
};

const activity = (
  event: TimelineEvent,
  label: string,
): TimelineActivity | null => {
  if (
    typeof event.ralph_stage !== "string" ||
    !(STAGES as readonly string[]).includes(event.ralph_stage) ||
    typeof event.ralph_received_at !== "string" ||
    !label
  ) {
    return null;
  }
  return {
    stage: event.ralph_stage as Stage,
    label,
    at: event.ralph_received_at,
    iteration:
      typeof event.ralph_iteration === "number" ? event.ralph_iteration : null,
    run: typeof event.ralph_run === "string" ? event.ralph_run : null,
  };
};

export function activitiesFor(event: TimelineEvent): TimelineActivity[] {
  const found: TimelineActivity[] = [];
  const push = (label: string): void => {
    const value = activity(event, label);
    if (value) found.push(value);
  };
  const type = event.type;

  if (type === "ralph_stage") {
    const state = typeof event.state === "string" ? event.state : "unknown";
    const runner = typeof event.runner === "string" ? event.runner : "unknown";
    push(`stage ${state} · ${runner}`);
    return found;
  }

  if (type === "assistant") {
    const message =
      event.message && typeof event.message === "object" ? event.message : {};
    const content = (message as { content?: unknown }).content;
    for (const block of Array.isArray(content) ? content : []) {
      if (!block || typeof block !== "object") continue;
      const item = block as Record<string, unknown>;
      if (item.type === "tool_use") {
        const name = typeof item.name === "string" ? item.name : "unknown";
        push(
          `tool ${name} — ${summarizeToolInput(item.input)}`.replace(/ — $/, ""),
        );
      } else if (item.type === "thinking")
        push(`thinking — ${compact(item.thinking)}`);
      else if (item.type === "text") push(`text — ${compact(item.text)}`);
    }
    return found;
  }

  if (type === "user") {
    const message =
      event.message && typeof event.message === "object" ? event.message : {};
    const content = (message as { content?: unknown }).content;
    for (const block of Array.isArray(content) ? content : []) {
      if (!block || typeof block !== "object") continue;
      const item = block as Record<string, unknown>;
      if (item.type === "tool_result") {
        push(
          `tool result ${item.is_error ? "error" : "ok"} — ${compact(item.content)}`,
        );
      }
    }
    return found;
  }

  if (type === "tool_use") {
    const part =
      event.part && typeof event.part === "object"
        ? (event.part as Record<string, unknown>)
        : {};
    const state =
      part.state && typeof part.state === "object"
        ? (part.state as Record<string, unknown>)
        : {};
    const tool = typeof part.tool === "string" ? part.tool : "tool";
    if (state.status === "error") {
      push(
        `tool ${tool} error — ${compact(state.error ?? state.output ?? state.message)}`,
      );
    } else {
      push(
        `tool ${tool} — ${summarizeToolInput(state.input)}`.replace(/ — $/, ""),
      );
    }
    return found;
  }

  if (type === "text") {
    const part =
      event.part && typeof event.part === "object"
        ? (event.part as Record<string, unknown>)
        : {};
    push(`text — ${compact(part.text)}`);
    return found;
  }

  if (type === "item.started" || type === "item.completed") {
    const item =
      event.item && typeof event.item === "object"
        ? (event.item as Record<string, unknown>)
        : {};
    if (item.type === "command_execution")
      push(`tool bash — ${compact(item.command)}`);
    else if (item.type === "agent_message")
      push(`text — ${compact(item.text)}`);
    else if (typeof item.type === "string") push(`tool ${item.type}`);
    return found;
  }

  if (type === "rate_limit_event") {
    // Claude reports its quota on most turns ("allowed", "allowed_warning"); only
    // a rejection that overage is not absorbing actually stalls the runner.
    const info =
      event.rate_limit_info && typeof event.rate_limit_info === "object"
        ? (event.rate_limit_info as Record<string, unknown>)
        : {};
    const status = typeof info.status === "string" ? info.status : "unknown";
    const absorbed = info.isUsingOverage === true || info.overageInUse === true;
    push(`rate limit ${status === "rejected" && absorbed ? "overage" : status}`);
  } else if (type === "system") push(`system — ${compact(event.subtype)}`);
  else if (type === "invalid") push("invalid event");
  return found;
}

export function stageEventFor(event: TimelineEvent): TimelineStageEvent | null {
  if (
    event.type !== "ralph_stage" ||
    typeof event.ralph_stage !== "string" ||
    !(STAGES as readonly string[]).includes(event.ralph_stage) ||
    typeof event.state !== "string" ||
    !(STAGE_STATES as readonly string[]).includes(event.state) ||
    typeof event.invocation !== "string" ||
    !event.invocation ||
    typeof event.runner !== "string" ||
    typeof event.model !== "string" ||
    typeof event.ralph_received_at !== "string"
  ) {
    return null;
  }
  return {
    stage: event.ralph_stage as Stage,
    state: event.state as TimelineStageState,
    invocation: event.invocation,
    runner: event.runner,
    model: event.model,
    at: event.ralph_received_at,
    iteration: typeof event.ralph_iteration === "number" ? event.ralph_iteration : null,
    run: typeof event.ralph_run === "string" ? event.ralph_run : null,
  };
}

export function parseTimeline(raw: string): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        events.push(value as TimelineEvent);
      }
    } catch {
      // A panel remains useful if an old writer left one torn line behind.
    }
  }
  return events;
}

export function readTimeline(
  worktree: string,
  options: { iteration?: number; run?: string } = {},
): TimelineRead {
  const logs = join(worktree, ".ralph/logs");
  let files: { name: string; modified: number; iteration: number }[];
  try {
    files = readdirSync(logs)
      .filter((name) => /^iter-.*\.events\.jsonl$/.test(name))
      .map((name) => ({
        name,
        modified: statSync(join(logs, name)).mtimeMs,
        iteration: Number(/-(\d+)\.events\.jsonl$/.exec(name)?.[1] ?? -1),
      }))
      .sort(
        (left, right) =>
          right.modified - left.modified || right.iteration - left.iteration,
      );
  } catch {
    return { exists: false, path: null, events: [], activities: [] };
  }

  for (const file of files) {
    const path = join(logs, file.name);
    let events: TimelineEvent[];
    try {
      events = parseTimeline(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const matching = events.filter(
      (event) =>
        (options.iteration === undefined ||
          event.ralph_iteration === options.iteration) &&
        (options.run === undefined || event.ralph_run === options.run),
    );
    if (
      matching.length === 0 &&
      (options.iteration !== undefined || options.run !== undefined)
    )
      continue;
    const selected = matching.length > 0 ? matching : events;
    const activities = selected
      .flatMap(activitiesFor)
      .sort((left, right) =>
        left.at < right.at ? -1 : left.at > right.at ? 1 : 0,
      );
    return { exists: true, path, events: selected, activities };
  }
  return { exists: false, path: null, events: [], activities: [] };
}

export const lastTimelineActivity = (
  worktree: string,
  options: { iteration?: number; run?: string } = {},
): { exists: boolean; activity: TimelineActivity | null } => {
  const timeline = readTimeline(worktree, options);
  return {
    exists: timeline.exists,
    activity: timeline.activities.at(-1) ?? null,
  };
};

/** Bumped only for a shape change a reader cannot absorb. */
export const TIMELINE_JSON_VERSION = 1;

/**
 * What `timeline.ts --json` prints: a stable, machine-readable contract.
 *
 * The field names are the contract — rename one and every consumer (the
 * operator dashboard's runtime adapter) breaks, so change them only with a
 * `version` bump. `activities` are exactly the ones the text mode renders, in
 * the same receipt order and under the same `--iteration`/`--run` filters,
 * with ANSI escape codes stripped from `label`. A missing or unmatched
 * timeline is `exists: false` with an empty list, not an error: absence is
 * unknown state, not a failed read.
 */
export interface TimelineJson {
  version: typeof TIMELINE_JSON_VERSION;
  exists: boolean;
  /** Absolute path of the selected iteration event file, or null. */
  path: string | null;
  activities: TimelineActivity[];
}

// CSI sequences (colors, cursor moves) plus the bare OSC/two-byte escapes.
const ANSI = /(?:\[[0-?]*[ -/]*[@-~]|\][^]*(?:|\\)|[@-Z\\-_])/g;

export const stripAnsi = (text: string): string => text.replace(ANSI, "");

export function timelineJson(timeline: TimelineRead): TimelineJson {
  return {
    version: TIMELINE_JSON_VERSION,
    exists: timeline.exists,
    path: timeline.path,
    activities: timeline.activities.map((item) => ({
      stage: item.stage,
      label: stripAnsi(item.label),
      at: item.at,
      iteration: item.iteration,
      run: item.run,
    })),
  };
}

const flag = (argv: string[], name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};

function main(): void {
  const argv = process.argv.slice(2);
  const root =
    process.env.RALPH_TIMELINE_ROOT ??
    projectRoot();
  const iterationRaw =
    flag(argv, "iteration") ?? argv.find((arg) => /^\d+$/.test(arg));
  const run = flag(argv, "run");
  const timeline = readTimeline(root, {
    ...(iterationRaw ? { iteration: Number(iterationRaw) } : {}),
    ...(run ? { run } : {}),
  });
  if (argv.includes("--json")) {
    console.log(JSON.stringify(timelineJson(timeline), null, 2));
    return;
  }
  if (!timeline.exists) {
    console.error("timeline: no matching iteration event file");
    process.exitCode = 1;
    return;
  }
  for (const item of timeline.activities) {
    console.log(`[${item.at}] [${item.stage}] ${item.label}`);
  }
}

if (import.meta.main) main();
