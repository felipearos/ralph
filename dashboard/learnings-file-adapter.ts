/**
 * Filing one learning as a ticket, from the page's side of the process
 * boundary.
 *
 * The page never opens an issue itself: it runs the harness's `findings.ts
 * file`, which publishes the entry through the journal publisher, under its
 * lock, so the registry and the per-host record keep it to one ticket however
 * often the button is pressed. This module names that one verb and narrows
 * what it prints.
 *
 * It owns the executor behind `guarded()`, so a timeout, a missing `bun` or an
 * executor that rejects all read as a view with a `problem`, never a 500.
 *
 * The CLI runs in the project's registered checkout (its config names the
 * project's learnings file) against the harness checkout the page reads the
 * learnings from, named by `RALPH_JOURNAL_HOME` so the two cannot differ.
 */
import { join, resolve } from "node:path";

import { defaultBunPath, isRecord } from "./adapter";
import type { Env, LearningFiledView } from "./contracts";
import { guarded, type ExecResult, type Executor } from "./executor";

/** The one write: one verb, one entry, one scope. */
export const LEARNINGS_FILE_SURFACE = {
  file: { script: "findings.ts", args: ["file"] },
} as const;

export const LEARNINGS_FILE_FLAGS = { scope: "--scope" } as const;

export type LearningScopeName = "project" | "harness";

export interface LearningsFileAdapter {
  file(slug: string, scope: LearningScopeName): Promise<LearningFiledView>;
}

export interface LearningsFileAdapterConfig {
  /** The harness checkout `findings.ts` is run from, and the one whose learnings it edits. */
  cliDir: string;
  /** The project's registered checkout: the CLI's cwd. */
  root: string;
  bunPath?: string;
  env?: Env;
  /** Runs the CLI; wrapped in `guarded()`, so a throw reads as a view with a problem. */
  exec: Executor;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/** The last line the CLI wrote to stderr: `findings: <why>`, without the prefix. */
const lastLine = (stderr: string): string | null =>
  text(stderr.trim().split("\n").at(-1)?.replace(/^findings:\s*/, "").replace(/^Error:\s*/, ""));

export function parseLearningsFileOutput(slug: string, result: ExecResult): LearningFiledView {
  const problem = (why: string): LearningFiledView => ({ slug, url: null, problem: why });
  if (result.status !== 0) {
    return problem(lastLine(result.stderr) ?? `findings.ts file ${result.status === null ? "did not run" : `exited ${result.status}`}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    return problem(`findings.ts file did not print JSON: ${result.stdout.trim().slice(0, 200)}`);
  }
  if (!isRecord(value) || value.version !== 1 || value.slug !== slug) {
    return problem(`findings.ts file printed an unexpected shape: ${JSON.stringify(value)?.slice(0, 200)}`);
  }
  const url = text(value.url);
  return { slug, url: url !== null && url.startsWith("https://github.com/") ? url : null, problem: null };
}

export function createLearningsFileAdapter(config: LearningsFileAdapterConfig): LearningsFileAdapter {
  const root = resolve(config.root);
  const cliDir = resolve(config.cliDir);
  const bunPath = config.bunPath ?? defaultBunPath();
  const env: Env = { ...process.env, ...config.env, RALPH_JOURNAL_HOME: cliDir };
  const exec = guarded(config.exec);
  return {
    file: async (slug, scope) => {
      const { script, args } = LEARNINGS_FILE_SURFACE.file;
      const argv = [join(cliDir, script), ...args, slug, LEARNINGS_FILE_FLAGS.scope, scope];
      return parseLearningsFileOutput(slug, await exec({ command: bunPath, args: argv, cwd: root, env }));
    },
  };
}
