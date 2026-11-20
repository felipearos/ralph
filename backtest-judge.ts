/**
 * The blind pairwise judge of a backtest ticket (felipearos/ralph#535): one
 * Claude call ranks the arms' final diffs, shown under neutral labels in a
 * seeded shuffle, and the answer is mapped back to arms only after the call.
 * Nothing in the prompt says which diff is the human's or which lineup wrote
 * the others, so the ranking cannot lean on origin.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { BacktestTicket } from "./backtest";
import type { ArmName } from "./backtest-report";
import { parseClaudeOutput } from "./local-review";

export type ArmId = "a" | ArmName;

export type JudgeCall = (prompt: string) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;

export type JudgeResult =
  | { status: "ok"; seed: string; order: ArmId[]; ranking: ArmId[][]; winners: ArmId[]; tie: boolean; reason: string }
  | { status: "unavailable"; seed: string; order: ArmId[]; reason: string };

export interface JudgeInput {
  ticket: BacktestTicket;
  diffs: { arm: ArmId; diff: string }[];
  seed: string;
  call: JudgeCall;
}

/** Past this a diff is cut: one runaway arm must not push the others out of the context window. */
export const MAX_DIFF_CHARS = 150_000;

/** One no-tool call must not hold a ticket's scoring for a whole trial cap. */
export const JUDGE_TIMEOUT_MS = 20 * 60_000;

// FNV-1a: a stable 32-bit hash of the seed, so the shuffle needs no crypto and
// replays identically on any host.
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The arms in the order the judge sees them, fixed by the seed and the ticket so a rerun shows the same order. */
export function shuffleArms<T>(arms: readonly T[], seed: string, ticketKey: string): T[] {
  const random = mulberry32(hash(`${seed}\n${ticketKey}`));
  const out = [...arms];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The judge's whole input: the frozen ticket and each diff under its neutral label, nothing about where a diff came from. */
export function judgePrompt(frozen: BacktestTicket["frozen"], candidates: { label: string; diff: string }[]): string {
  const comments = frozen.comments.length === 0
    ? "(none)"
    : frozen.comments.map((c) => `--- ${c.createdAt}\n${c.body}`).join("\n\n");
  const shown = candidates.map(({ label, diff }) => {
    const cut = diff.length > MAX_DIFF_CHARS;
    const note = cut ? `\n(This diff was truncated to its first ${MAX_DIFF_CHARS} characters of ${diff.length}.)` : "";
    const body = cut ? diff.slice(0, MAX_DIFF_CHARS) : diff;
    // A diff of a Markdown file can hold its own ``` and would close a fixed fence early.
    const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(Math.max(3, longest + 1));
    return `## Candidate ${label}${note}\n\n${fence}diff\n${body}\n${fence}`;
  }).join("\n\n");
  const labels = candidates.map((c) => `"${c.label}"`).join(", ");
  return [
    "You are judging candidate changes for one ticket. Read the ticket, then the candidate diffs, and rank the",
    "candidates by how well each one resolves the ticket: correct, complete, and no more than the ticket asks.",
    "Judge only the diffs; the order they are listed in means nothing.",
    "",
    "# Ticket",
    "",
    `## Title\n\n${frozen.title}`,
    "",
    `## Description\n\n${frozen.body || "(empty)"}`,
    "",
    `## Comments\n\n${comments}`,
    "",
    "# Candidates",
    "",
    shown,
    "",
    "# Answer",
    "",
    "Answer with JSON only, no other text:",
    "",
    // Placeholders, not real labels: an example naming one would nudge the ranking toward it.
    "{\"ranking\": [[\"<label>\"], [\"<label>\", \"<label>\"]], \"reason\": \"<one or two sentences>\"}",
    "",
    "`ranking` lists tiers best first; labels in one tier are tied. Use every label exactly once:",
    `${labels}.`,
  ].join("\n");
}

type ParsedAnswer = { ok: true; ranking: string[][]; reason: string } | { ok: false; reason: string };

// The answer may come fenced or with prose around it: try the fenced block,
// then the outermost braces.
function jsonIn(text: string): unknown {
  const candidates: string[] = [];
  const fence = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/.exec(text);
  if (fence) candidates.push(fence[1]!);
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open !== -1 && close > open) candidates.push(text.slice(open, close + 1));
  candidates.push(text);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next.
    }
  }
  return undefined;
}

/** The judge's ranking, valid only when every label appears exactly once and nothing else does. */
export function parseJudgeAnswer(text: string, labels: readonly string[]): ParsedAnswer {
  const doc = jsonIn(text);
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { ok: false, reason: "judge answered with no JSON object" };
  const { ranking, reason } = doc as { ranking?: unknown; reason?: unknown };
  if (!Array.isArray(ranking) || ranking.length === 0) return { ok: false, reason: "judge's answer has no ranking" };
  const seen = new Set<string>();
  const tiers: string[][] = [];
  for (const tier of ranking) {
    if (!Array.isArray(tier) || tier.length === 0) return { ok: false, reason: "judge's ranking has a tier that is not a non-empty list" };
    const out: string[] = [];
    for (const raw of tier) {
      const label = typeof raw === "number" ? String(raw) : raw;
      if (typeof label !== "string") return { ok: false, reason: "judge's ranking has a label that is not a string" };
      if (!labels.includes(label)) return { ok: false, reason: `judge's ranking names unknown candidate ${label}` };
      if (seen.has(label)) return { ok: false, reason: `judge's ranking names candidate ${label} twice` };
      seen.add(label);
      out.push(label);
    }
    tiers.push(out);
  }
  const missing = labels.filter((label) => !seen.has(label));
  if (missing.length > 0) return { ok: false, reason: `judge's ranking leaves out candidate ${missing.join(", ")}` };
  return { ok: true, ranking: tiers, reason: typeof reason === "string" ? reason : "" };
}

/** Rank one ticket's arms blind. A model problem is `unavailable`, never a throw. */
export async function judgeTicket(input: JudgeInput): Promise<JudgeResult> {
  const present = input.diffs.filter((d) => d.diff.trim() !== "");
  const shown = shuffleArms(present, input.seed, input.ticket.oaKey);
  const order = shown.map((d) => d.arm);
  if (shown.length < 2) return { status: "unavailable", seed: input.seed, order, reason: "fewer than two arms produced a diff" };
  const labels = shown.map((_, i) => String(i + 1));
  const prompt = judgePrompt(input.ticket.frozen, shown.map((d, i) => ({ label: labels[i]!, diff: d.diff })));
  let answer: Awaited<ReturnType<JudgeCall>>;
  try {
    answer = await input.call(prompt);
  } catch (error) {
    answer = { ok: false, reason: `judge call threw: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!answer.ok) return { status: "unavailable", seed: input.seed, order, reason: answer.reason };
  const parsed = parseJudgeAnswer(answer.text, labels);
  if (!parsed.ok) return { status: "unavailable", seed: input.seed, order, reason: parsed.reason };
  // Only now does a label become an arm again.
  const ranking = parsed.ranking.map((tier) => tier.map((label) => order[Number(label) - 1]!));
  const winners = ranking[0]!;
  return { status: "ok", seed: input.seed, order, ranking, winners, tie: winners.length > 1, reason: parsed.reason };
}

/**
 * The production judge: a `claude -p` with no tools at all (`--tools ""`),
 * reading the prompt on stdin, since a ticket with three large diffs is too
 * big for an argument. Isolated like a local review: no MCP servers, no user
 * settings or hooks, and no GitHub token, so nothing can look up which diff
 * is the human's merged PR. In its own process group, so a timeout or abort
 * reaches everything it started.
 */
export function claudeJudge(opts: { model: string; cwd: string; logPath: string; timeoutMs: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal }): JudgeCall {
  return (prompt) => new Promise((done) => {
    const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env) };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    const bin = env.RALPH_CLAUDE_BIN || "claude";
    mkdirSync(dirname(opts.logPath), { recursive: true });
    writeFileSync(opts.logPath, "");
    let stdout = "";
    let settled = false;
    let why: string | null = null;
    // Each variadic flag (`--setting-sources`, `--tools`) is followed by its value, never by another flag.
    const args = [
      "-p",
      "--output-format", "json",
      "--model", opts.model,
      "--permission-mode", "dontAsk",
      "--strict-mcp-config",
      "--setting-sources", "",
      "--tools", "",
    ];
    const child = spawn(bin, args, {
      cwd: opts.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const kill = (reason: string) => {
      why ??= reason;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
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
      done(result);
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    // Kept in the log for diagnosis; drained so a chatty child never blocks on a full pipe.
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => appendFileSync(opts.logPath, chunk));
    // A child that dies before reading all of stdin raises EPIPE here; the exit code tells the story.
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    child.on("error", (error) => finish({ ok: false, reason: `judge run failed: ${error.message}` }));
    child.on("close", (code) => {
      appendFileSync(opts.logPath, stdout);
      if (why !== null) return finish({ ok: false, reason: why });
      if (code !== 0) return finish({ ok: false, reason: `judge run failed: exit ${code}` });
      const output = parseClaudeOutput(stdout);
      finish(output.ok ? { ok: true, text: output.value.result } : { ok: false, reason: `judge output unreadable: ${output.reason}` });
    });
  });
}
