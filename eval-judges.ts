/**
 * The judge calls a panel (#801) is built from: `claudeJudge` (#535) for the
 * Claude family and `codexJudge` for Codex, each a no-tool or sandboxed call
 * that reads the prompt on stdin and returns the model's last message.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { claudeJudge, type JudgeCall } from "./backtest-judge";
import type { JudgeSpec } from "./eval-panel";

const HERE = dirname(new URL(import.meta.url).pathname);

export interface JudgeCallOptions { cwd: string; logPath: string; timeoutMs: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal }

/**
 * One Codex judge through `judge-codex.sh`, which runs it in bubblewrap over
 * an empty directory. No GitHub token reaches it, and it runs in its own
 * process group so a timeout or abort reaches everything it started.
 */
export function codexJudge(opts: JudgeCallOptions & { model: string; script?: string }): JudgeCall {
  return (prompt) => new Promise((done) => {
    const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env) };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    mkdirSync(dirname(opts.logPath), { recursive: true });
    writeFileSync(opts.logPath, "");
    const scratch = mkdtempSync(join(tmpdir(), "judge-codex-"));
    const answer = join(scratch, "answer.txt");
    let settled = false;
    let why: string | null = null;
    const child = spawn("bash", [opts.script ?? join(HERE, "judge-codex.sh"), opts.model, answer], {
      cwd: opts.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const kill = (reason: string) => {
      why ??= reason;
      try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    const timer = setTimeout(() => kill(`judge timed out after ${Math.round(opts.timeoutMs / 1000)}s`), opts.timeoutMs);
    const onAbort = () => kill("judge aborted");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
    const finish = (result: Awaited<ReturnType<JudgeCall>>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      rmSync(scratch, { recursive: true, force: true });
      done(result);
    };
    // Codex's event stream is diagnosis only; drained so a chatty child never blocks on a full pipe.
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => appendFileSync(opts.logPath, chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => appendFileSync(opts.logPath, chunk));
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    child.on("error", (error) => finish({ ok: false, reason: `judge run failed: ${error.message}` }));
    child.on("close", (code) => {
      if (why !== null) return finish({ ok: false, reason: why });
      if (code !== 0) return finish({ ok: false, reason: `judge run failed: exit ${code}${code === 2 ? " (no sandbox: see the judge log)" : ""}` });
      if (!existsSync(answer)) return finish({ ok: false, reason: "judge wrote no answer" });
      finish({ ok: true, text: readFileSync(answer, "utf8") });
    });
  });
}

/** The call for one judge on the panel, by its family. */
export type JudgeFactory = (spec: JudgeSpec, opts: JudgeCallOptions) => JudgeCall;

export const productionJudge: JudgeFactory = (spec, opts) =>
  spec.runner === "codex" ? codexJudge({ ...opts, model: spec.model }) : claudeJudge({ ...opts, model: spec.model });
