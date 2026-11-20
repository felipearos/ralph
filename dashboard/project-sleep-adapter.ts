/**
 * A project's sleep, from the page's side of the process boundary.
 *
 * The page never writes the sleep marker itself: it runs the harness's
 * `project-sleep.ts`, which owns the marker's file and format in the repo's
 * git common directory, so the loops that read it and the page that sets it
 * cannot disagree about where it lives. This module names that one script and
 * its three verbs, and narrows what it prints.
 *
 * It owns the executor behind `guarded()`, so a timeout, a missing `bun` or an
 * executor that rejects outright all read as a view with a `problem`, never as
 * a 500: a broken sleep CLI must not take the project's header with it.
 *
 * The CLI runs in the project's registered checkout with `RALPH_STATE_ROOT`
 * set to it, as the other per-project adapters do; any worktree of the repo
 * resolves to the same git common directory, so which one does not matter.
 */
import { join, resolve } from "node:path";

import { ADAPTER_ENV, defaultBunPath, isRecord } from "./adapter";
import type { Env, ProjectSleepView } from "./contracts";
import { guarded, type ExecResult, type Executor } from "./executor";

/** The sleep's command surface: one script, three verbs, each asked for JSON. */
export const PROJECT_SLEEP_SURFACE = {
  status: { script: "project-sleep.ts", args: ["status", "--json"] },
  sleep: { script: "project-sleep.ts", args: ["sleep", "--json"] },
  wake: { script: "project-sleep.ts", args: ["wake", "--json"] },
} as const;

/** The flags a sleep may carry; `by` is always the page, so the marker says who set it. */
export const PROJECT_SLEEP_FLAGS = { why: "--why", by: "--by", byPage: "dashboard" } as const;

export interface ProjectSleepAdapter {
  status(): Promise<ProjectSleepView>;
  sleep(why: string | null): Promise<ProjectSleepView>;
  wake(): Promise<ProjectSleepView>;
}

export interface ProjectSleepAdapterConfig {
  /** The harness checkout `project-sleep.ts` is run from. */
  cliDir: string;
  /** The project's registered checkout: the CLI's cwd and its state root. */
  root: string;
  bunPath?: string;
  env?: Env;
  /** Runs the CLI; wrapped in `guarded()`, so a throw reads as a view with a problem. */
  exec: Executor;
}

const AWAKE: Omit<ProjectSleepView, "problem"> = { asleep: false, since: null, why: null, by: null };

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const problemView = (problem: string): ProjectSleepView => ({ ...AWAKE, problem });

/**
 * Narrow one run's answer. A non-zero exit, output that is not JSON, or JSON
 * that is not version 1 of the view is a `problem`; an asleep view without a
 * `since` is one too, because "asleep since when" is what the page shows.
 */
export function parseProjectSleepOutput(verb: string, result: ExecResult): ProjectSleepView {
  if (result.status !== 0) {
    const status = result.status === null ? "did not run" : `exited ${result.status}`;
    return problemView(text(result.stderr) ?? `project-sleep.ts ${verb} ${status} without saying why`);
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return problemView(`project-sleep.ts ${verb} did not print JSON: ${result.stdout.trim().slice(0, 200)}`);
  }
  if (!isRecord(value) || value.version !== 1 || typeof value.asleep !== "boolean") {
    return problemView(`project-sleep.ts ${verb} printed an unexpected shape: ${JSON.stringify(value)?.slice(0, 200)}`);
  }
  if (!value.asleep) return { ...AWAKE, problem: null };
  const since = text(value.since);
  if (since === null || Number.isNaN(Date.parse(since))) {
    return problemView(`project-sleep.ts ${verb} reports the project asleep without a readable 'since'`);
  }
  return { asleep: true, since, why: text(value.why), by: text(value.by), problem: null };
}

export function createProjectSleepAdapter(config: ProjectSleepAdapterConfig): ProjectSleepAdapter {
  const root = resolve(config.root);
  const bunPath = config.bunPath ?? defaultBunPath();
  const env: Env = { ...process.env, ...config.env, [ADAPTER_ENV.loopStateRoot]: root };
  const exec = guarded(config.exec);
  const run = async (verb: keyof typeof PROJECT_SLEEP_SURFACE, extra: string[] = []): Promise<ProjectSleepView> => {
    const surface = PROJECT_SLEEP_SURFACE[verb];
    const args = [join(resolve(config.cliDir), surface.script), ...surface.args, ...extra];
    return parseProjectSleepOutput(verb, await exec({ command: bunPath, args, cwd: root, env }));
  };
  return {
    status: () => run("status"),
    sleep: (why) =>
      run("sleep", [
        ...(why === null ? [] : [PROJECT_SLEEP_FLAGS.why, why]),
        PROJECT_SLEEP_FLAGS.by,
        PROJECT_SLEEP_FLAGS.byPage,
      ]),
    wake: () => run("wake"),
  };
}
