/**
 * The analyst (#801): one unblinded call after the panel. Unlike the judges it
 * knows which arm ran which lineup and prompts, and turns the run's metrics
 * and the panel's verdicts into improvements aimed at a knob — a prompt file,
 * a lineup stage, a model, a gate, the review — each citing the cases it
 * rests on. These are for a person today and the improver's input in #803.
 *
 * Its answer is parsed strictly: an improvement with no knob or no evidence
 * is dropped with a note, and an unreadable answer leaves the run without an
 * analysis, never without its report.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { armList, describeArm, type ArmConfig } from "./backtest";
import type { JudgeCall } from "./backtest-judge";
import type { BacktestReport } from "./backtest-report";
import { AXES } from "./eval-panel";
import { readOverlay } from "./prompt-overlay";

export const KNOBS = ["prompt", "lineup", "model", "gate", "review"] as const;
export type Knob = (typeof KNOBS)[number];

export interface Improvement {
  knob: Knob;
  /** What the knob is: a prompt file (`coder.md`), a lineup stage (`executor`), a gate name. */
  target: string;
  /** The change, concrete enough to make. */
  change: string;
  /** The arm whose run showed the need, or `all`. */
  arm: string;
  /** Case keys the improvement rests on. */
  evidence: string[];
}

export type Analysis =
  | { status: "ok"; model: string; summary: string; improvements: Improvement[]; dropped: string[] }
  | { status: "unavailable"; model: string; reason: string };

/** Past this an overlay file is cut: the analyst needs what changed, not a whole prompt twice. */
const MAX_OVERLAY_CHARS = 20_000;

function armSection(arm: ArmConfig): string {
  const lines = [`## Arm ${arm.name}`, "", `Runs: ${describeArm(arm)}.`];
  if (arm.overlay !== null && existsSync(arm.overlay)) {
    try {
      const overlay = readOverlay(arm.overlay);
      for (const file of overlay.files) {
        const text = readFileSync(join(arm.overlay, file), "utf8");
        const cut = text.length > MAX_OVERLAY_CHARS ? `${text.slice(0, MAX_OVERLAY_CHARS)}\n(truncated)` : text;
        lines.push("", `### Overlay replaces ${file}`, "", "````markdown", cut, "````");
      }
    } catch (error) {
      lines.push("", `(The overlay could not be read: ${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return lines.join("\n");
}

function caseSection(report: BacktestReport, ticket: string): string {
  const lines = [`## Case ${ticket}`, ""];
  for (const row of report.rows.filter((entry) => entry.ticket === ticket)) {
    const gates = row.gates === null ? "no checks" : row.gates.map((gate) => `${gate.name} ${gate.conclusion}`).join(", ");
    const tokens = row.tokens === null ? "tokens unknown" : `${row.tokens.input + row.tokens.cacheRead + row.tokens.cacheWrite} in / ${row.tokens.output} out`;
    const cost = row.cost.usd === null ? "cost unknown" : `$${row.cost.usd.toFixed(2)} (${row.cost.source})`;
    lines.push(`- arm ${row.arm}: ${row.outcome} — ${row.detail}; ${gates}; review rounds ${row.reviewRounds ?? "—"}; ${Math.round(row.wallSeconds)}s; ${tokens}; ${cost}`);
  }
  const score = report.scores?.find((entry) => entry.ticket === ticket);
  for (const arm of score?.arms ?? []) {
    const held = arm.heldOut?.status === "ok" ? `${arm.heldOut.files.filter((file) => file.baseline === "fail" && file.result === "pass").length}/${arm.heldOut.files.filter((file) => file.baseline === "fail").length} held-out tests that failed on the base now pass` : "no held-out evidence";
    const review = arm.review?.final.status === "ok" ? `final review P1 ${arm.review.final.counts.P1} P2 ${arm.review.final.counts.P2} P3 ${arm.review.final.counts.P3}` : "final head unreviewed";
    const findings = arm.review?.final.status === "ok" ? arm.review.final.findings.slice(0, 5).map((finding) => `[${finding.priority}] ${finding.title}`).join("; ") : "";
    lines.push(`- ${arm.arm === "a" ? "reference (the merged PR)" : `arm ${arm.arm}`} scoring: ${held}; ${review}${findings ? ` — ${findings}` : ""}`);
  }
  for (const verdict of score?.panel?.verdicts ?? []) {
    if (verdict.status !== "ok") { lines.push(`- judge ${verdict.judge.name} abstained: ${verdict.reason}`); continue; }
    lines.push(`- judge ${verdict.judge.name} (${verdict.judge.runner}) ranked ${verdict.ranking.map((tier) => tier.join(" = ")).join(" > ")}: ${verdict.reason}`);
    for (const [arm, scored] of Object.entries(verdict.arms)) {
      const axes = AXES.map((axis) => `${axis} ${scored.axes[axis].score ?? "—"} (${scored.axes[axis].evidence})`).join("; ");
      lines.push(`  - ${arm === "a" ? "reference" : `arm ${arm}`}: ${axes}. Did better: ${scored.better}`);
    }
  }
  for (const entry of score?.panel?.contested ?? []) lines.push(`- contested: ${entry.axis} ${entry.arms.length === 1 ? `for ${entry.arms[0]}, the families' scores spread apart` : `between ${entry.arms.join(" and ")}`}`);
  return lines.join("\n");
}

/**
 * The analyst prompt's opening instructions (#878), apart from the run's sections so an evaluation
 * proposal can replace them (eval-instructions.ts reads the harness file).
 */
export const ANALYST_INSTRUCTIONS = [
  "You are the analyst of an evaluation run. Several arms — each a model lineup and, optionally, replacement",
  "prompt files for the coding harness — each worked the same cases from the same base. `a` is the reference:",
  "the change that actually merged. A blind panel of judges then scored every arm. You are told which arm ran",
  "what. Say what the arms' results show and what to change so the next run does better: on code quality, or",
  "on spend (tokens, a cheaper model where it held up).",
  "",
  "Every improvement must name the knob it changes and cite the cases it rests on. Prefer few, concrete",
  "improvements over many vague ones. Do not propose a change the evidence does not support.",
].join("\n");

/** Everything the analyst sees: the arms' configurations, each case's metrics and every judge's verdict. */
export function analystPrompt(report: BacktestReport, instructions: string = ANALYST_INSTRUCTIONS): string {
  const tickets = [...new Set(report.rows.filter((row) => row.outcome !== "not-run").map((row) => row.ticket))];
  return [
    instructions,
    "",
    "# Arms",
    "",
    ...armList(report.arms).map(armSection),
    "",
    "# Cases",
    "",
    ...tickets.map((ticket) => caseSection(report, ticket)),
    "",
    "# Answer",
    "",
    "Answer with JSON only, no other text. Placeholders are in angle brackets:",
    "",
    `{"summary": "<two to four sentences>", "improvements": [{"knob": "<${KNOBS.join("|")}>", "target": "<a prompt file, lineup stage, model, gate or review>", `
      + `"change": "<the change, concrete enough to make>", "arm": "<the arm that showed it, or all>", "evidence": ["<case key>"]}]}`,
  ].join("\n");
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function jsonIn(text: string): unknown {
  const tries: string[] = [];
  const fence = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/.exec(text);
  if (fence) tries.push(fence[1]!);
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open !== -1 && close > open) tries.push(text.slice(open, close + 1));
  tries.push(text);
  for (const attempt of tries) {
    try { return JSON.parse(attempt); } catch { /* the next */ }
  }
  return undefined;
}

/** The analyst's answer. An improvement without a knob, a change or a case it names is dropped, with why. */
export function parseAnalysis(text: string, model: string, cases: readonly string[]): Analysis {
  const doc = jsonIn(text);
  if (!isRecord(doc)) return { status: "unavailable", model, reason: "the analyst answered with no JSON object" };
  if (typeof doc.summary !== "string" || !Array.isArray(doc.improvements)) return { status: "unavailable", model, reason: "the answer has no summary or no improvements list" };
  const improvements: Improvement[] = [];
  const dropped: string[] = [];
  doc.improvements.forEach((entry, index) => {
    const at = `improvement ${index + 1}`;
    if (!isRecord(entry)) { dropped.push(`${at}: not an object`); return; }
    if (typeof entry.knob !== "string" || !(KNOBS as readonly string[]).includes(entry.knob)) { dropped.push(`${at}: knob ${String(entry.knob)} is not one of ${KNOBS.join(", ")}`); return; }
    if (typeof entry.change !== "string" || entry.change.trim() === "") { dropped.push(`${at}: no change`); return; }
    const evidence = Array.isArray(entry.evidence) ? entry.evidence.filter((key): key is string => typeof key === "string" && cases.includes(key)) : [];
    if (evidence.length === 0) { dropped.push(`${at}: cites no case of this run`); return; }
    improvements.push({
      knob: entry.knob as Knob, target: typeof entry.target === "string" ? entry.target : "", change: entry.change,
      arm: typeof entry.arm === "string" ? entry.arm : "all", evidence,
    });
  });
  return { status: "ok", model, summary: doc.summary, improvements, dropped };
}

/** One analyst call over a scored report. A model problem is `unavailable`, never a throw. */
export async function analyse(report: BacktestReport, model: string, call: JudgeCall, instructions?: string): Promise<Analysis> {
  const cases = [...new Set(report.rows.map((row) => row.ticket))];
  let answer: Awaited<ReturnType<JudgeCall>>;
  try { answer = await call(analystPrompt(report, instructions)); } catch (error) { answer = { ok: false, reason: `the call threw: ${error instanceof Error ? error.message : String(error)}` }; }
  if (!answer.ok) return { status: "unavailable", model, reason: answer.reason };
  return parseAnalysis(answer.text, model, cases);
}

/** The report's `## Analyst` section. */
export function renderAnalysis(analysis: Analysis | null | undefined): string[] {
  if (!analysis) return [];
  if (analysis.status === "unavailable") return ["", "## Analyst", "", `Not analysed (${analysis.model}): ${analysis.reason.replace(/\s+/g, " ")}`];
  const lines = ["", "## Analyst", "", analysis.summary.replace(/\s+/g, " ").trim(), ""];
  if (analysis.improvements.length === 0) lines.push("No improvement the evidence supports.");
  for (const entry of analysis.improvements) {
    lines.push(`- **${entry.knob}${entry.target ? ` · ${entry.target}` : ""}** (arm ${entry.arm}; ${entry.evidence.join(", ")}): ${entry.change.replace(/\s+/g, " ").trim()}`);
  }
  if (analysis.dropped.length > 0) lines.push("", `Dropped from the answer: ${analysis.dropped.join("; ")}.`);
  lines.push("", `The analyst (${analysis.model}) knew which arm ran what; the judges did not.`);
  return lines;
}
