/**
 * The Executor port: one subprocess call as data in, its status and streams
 * out. Every adapter is handed an `Executor`; `guarded` makes one total, and
 * `createProcessExecutor` is the real one — the one module that spawns for
 * the adapters.
 *
 * It imports no adapter, so the adapters and the CLI read module can all
 * import it by value without a cycle.
 */
import { execFile } from "node:child_process";

import type { Env } from "./contracts";

/**
 * One subprocess to run: an absolute-ish command, its argv, where it runs, and
 * the environment it sees. The unit the injected executor consumes and the
 * recording executor captures.
 */
export interface Invocation {
  command: string;
  args: string[];
  cwd: string;
  env: Env;
  /** Written to the child's stdin: how a secret reaches a CLI without entering argv. */
  input?: string;
  /** Per-invocation budget in ms; falls back to the executor's constructor timeout. */
  timeoutMs?: number;
}

export interface ExecResult {
  /** Exit code, or null when the process never reached a status (spawn error). */
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run a subprocess and return its status and streams. Injected everywhere. */
export type Executor = (invocation: Invocation) => Promise<ExecResult>;

/**
 * The executor, made total: a call that rejects, or throws before it returns a
 * promise, resolves to a null status carrying the error as stderr. Callers then
 * read one shape — the parsers already treat a null status as a step that never
 * ran — instead of each wrapping its own try/catch around every invocation.
 */
export const guarded =
  (executor: Executor): Executor =>
  async (invocation) => {
    try {
      return await executor(invocation);
    } catch (error) {
      return { status: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    }
  };

/**
 * The default executor: a real subprocess, resolving rather than rejecting on a
 * non-zero exit so the classifier can read the status and stderr.
 */
export function createProcessExecutor(options: { timeoutMs?: number } = {}): Executor {
  const timeout = options.timeoutMs ?? 30_000;
  return (invocation) =>
    new Promise<ExecResult>((resolvePromise) => {
      const child = execFile(
        invocation.command,
        invocation.args,
        {
          cwd: invocation.cwd,
          env: invocation.env as NodeJS.ProcessEnv,
          timeout: invocation.timeoutMs ?? timeout,
          maxBuffer: 16 * 1024 * 1024,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : (error as NodeJS.ErrnoException).code;
          // A child killed by the timeout, or one that never spawned, printed
          // nothing: the error's own message names the cause instead.
          const errText = (stderr ?? "") === "" && error !== null ? error.message : (stderr ?? "");
          resolvePromise({
            status: typeof code === "number" ? code : error === null ? 0 : null,
            stdout: stdout ?? "",
            stderr: errText,
          });
        },
      );
      // Always ended, input or not, so a child that reads stdin gets EOF
      // instead of hanging until the timeout. A child that exits before
      // reading its input must not crash the server.
      child.stdin?.on("error", () => {});
      child.stdin?.end(invocation.input);
    });
}
