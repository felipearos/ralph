/**
 * The project's tracker, for the harness CLIs that each ran `gh issue` on
 * their own (`issue-spec.ts`, `controls.ts`, `push-notification.ts`,
 * `preflight.ts`; felipearos/ralph#334).
 *
 * Those callers keep their own `gh` path on GitHub, argv for argv, because
 * their suites pin it and every live loop runs it; only a project whose
 * tickets live in Linear or Jira takes the tracker. A checkout without a
 * readable config is a GitHub one, as it always was to these callers.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { RALPH_HOME } from "../paths";
import { loadProjectConfig, type TrackerConfig } from "../project-config";
import { currentProjectId } from "../project-id";
import { createTracker } from "./index";
import type { Tracker } from "./types";

/** The project's tracker block, or null when the checkout has no readable config. */
export function projectTrackerConfig(root: string): TrackerConfig | null {
  try {
    return loadProjectConfig(root).tracker;
  } catch {
    return null;
  }
}

/**
 * The keyed tracker (Linear, Jira or local) of the project at `root`, or null on GitHub.
 * Throws `TrackerUnavailableError` when the project names one but this host
 * has no usable credential, which each caller reports as its own failure.
 */
export function keyedProjectTracker(root: string): Tracker | null {
  const tracker = projectTrackerConfig(root);
  if (tracker === null || tracker.kind === "github") return null;
  return createTracker(loadProjectConfig(root), { projectId: currentProjectId(root) });
}

export type TrackerCliResult = { ok: true; stdout: string } | { ok: false; why: string; timedOut: boolean };

/**
 * `tracker.ts` run synchronously, for a caller whose flow is synchronous (a
 * control's `apply`, a notification). Bounded by `timeoutMs`, like the `gh`
 * call it stands in for; `input` is the stdin a `--body-file -` reads.
 */
export function runTrackerCli(root: string, args: string[], options: { timeoutMs: number; input?: string }): TrackerCliResult {
  const result = spawnSync("bun", [join(RALPH_HOME, "tracker.ts"), ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  const timedOut = result.error !== undefined && "code" in result.error && result.error.code === "ETIMEDOUT";
  if (result.error) return { ok: false, why: result.error.message, timedOut };
  if (result.status !== 0) {
    return { ok: false, why: (result.stderr || result.stdout || `tracker.ts exited ${result.status}`).trim(), timedOut: false };
  }
  return { ok: true, stdout: result.stdout };
}
