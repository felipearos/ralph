/**
 * The PR a passed eval proposal opens against ralph (#875): its title, commit
 * message and body, rendered from the proposal and its full-set run. Pure: the
 * caller owns git and gh, so what the PR says is testable without either.
 *
 * Everything the reviewer needs to judge the change sits in the body — the set
 * version and panel it was proven against, the scorecard, the guardrail verdict
 * and the contested cases — because the PR is the one place a person reads
 * before merging, and the improver never merges.
 */
import { isPromptKind, type PromptContent, type PromptKind } from "./eval-evaluation-proposals";
import type { LineupContent, OverlayContent } from "./eval-improver";
import { EVAL_INSTRUCTION_FILES } from "./eval-instructions";
import { accuracyLabel } from "./eval-judge-accuracy";
import { AXES } from "./eval-panel";
import type { ProposalState, StoredPromptVerdict, StoredProposal } from "./eval-proposals";
import type { EvalArmTotal, EvalRunSummary } from "./eval-runs";

/** One arm of the quality-vs-cost plot, as numbers. */
export interface QualityCostPoint {
  arm: string;
  /** The panel's mean score (1–5) over every judge, axis and case; null when no judge scored the arm. */
  quality: number | null;
  /** The held-out pass rate, 0..1; null when the arm has none. */
  heldOut: number | null;
  heldOutLabel: string | null;
  /** In `unit`; null is UNKNOWN, never zero. */
  cost: number | null;
  costPartial: boolean;
  costLabel: string;
}

export interface QualityCostPoints { unit: "usd" | "tokens"; points: QualityCostPoint[] }

const costLabel = (usd: number, partial: boolean): string => `${partial ? "≥ " : ""}$${usd.toFixed(2)}`;
const tokensLabel = (tokens: number): string =>
  tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`;

/** `"3/4"` → 0.75; null when absent, unparsable or out of nothing. */
function heldOutRate(heldOut: string | null): number | null {
  const match = heldOut === null ? null : /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(heldOut);
  if (match === null) return null;
  const pass = Number(match[1]);
  const total = Number(match[2]);
  return total === 0 || pass > total ? null : pass / total;
}

/**
 * Each arm's quality against cost. It mirrors the Results screen's plot
 * (`qualityCostPlot`, #826) maths for maths so the PR shows the numbers the
 * operator saw; it is copied rather than imported because ralph never imports
 * from dashboard/. Null in the same cases the plot draws nothing.
 */
export function qualityCostPoints(run: EvalRunSummary): QualityCostPoints | null {
  if (run.running || run.totals.length < 2) return null;
  const withCost = run.totals.filter((total) => total.costUsd !== null || total.tokens !== null);
  // Dollars only when every arm with a figure has dollars: mixing units would misplace arms.
  const unit = withCost.length > 0 && withCost.every((total) => total.costUsd !== null) ? "usd" : "tokens";
  const points = run.totals.map((total): QualityCostPoint => {
    const scores: number[] = [];
    for (const entry of run.cases) {
      for (const arm of entry.arms) {
        if (arm.arm !== total.arm) continue;
        for (const judge of arm.axes) {
          for (const score of Object.values(judge.scores)) if (score !== null) scores.push(score);
        }
      }
    }
    const quality = scores.length === 0 ? null : scores.reduce((sum, score) => sum + score, 0) / scores.length;
    const cost = unit === "usd" ? total.costUsd : total.tokens;
    const costPartial = unit === "usd" && cost !== null && total.costPartial;
    return {
      arm: total.arm,
      quality,
      heldOut: heldOutRate(total.heldOut),
      heldOutLabel: total.heldOut,
      cost,
      costPartial,
      costLabel: cost === null ? "unknown" : unit === "usd" ? costLabel(cost, costPartial) : tokensLabel(cost),
    };
  });
  if (points.every((point) => point.quality === null && point.heldOut === null)) return null;
  return { unit, points };
}

const SUBJECT_MAX = 100;

/** The changed files or stages, shortened with "…" so the subject stays under SUBJECT_MAX. */
function subject(area: string, lead: string, items: string[], tail = " (#803)"): string {
  const head = `${area}: ${lead}`;
  const room = SUBJECT_MAX - head.length - tail.length;
  let list = items.join(", ");
  if (list.length > room) {
    const kept: string[] = [];
    for (const item of items) {
      if ([...kept, item].join(", ").length + ", …".length > room) break;
      kept.push(item);
    }
    list = kept.length === 0 ? "…" : `${kept.join(", ")}, …`;
  }
  return `${head}${list}${tail}`;
}

const overlayFiles = (content: unknown): string[] => {
  const files = (content as Partial<OverlayContent> | null)?.files;
  return files !== null && typeof files === "object" ? Object.keys(files) : [];
};

const lineupStages = (content: unknown): [string, { model: string; runner?: string }][] => {
  const stages = (content as Partial<LineupContent> | null)?.stages;
  return stages !== null && typeof stages === "object"
    ? Object.entries(stages).flatMap(([stage, value]) => (value === undefined ? [] : [[stage, value] as [string, { model: string; runner?: string }]]))
    : [];
};

const promptWho = (kind: PromptKind): string => (kind === "judge-prompt" ? "judge" : "analyst");

export function proposalPrTitle(proposal: Pick<StoredProposal, "id" | "kind" | "content">): string {
  if (isPromptKind(proposal.kind)) return subject("evals", `${promptWho(proposal.kind)} prompt from proposal ${proposal.id}`, [], " (#878)");
  if (proposal.kind === "lineup") {
    return subject("models", `apply eval proposal ${proposal.id} lineup: `, lineupStages(proposal.content).map(([stage, value]) => `${stage} → ${value.model}`));
  }
  return subject("prompts", `apply eval proposal ${proposal.id} to `, overlayFiles(proposal.content));
}

export function proposalCommitMessage(proposal: StoredProposal, run: Pick<EvalRunSummary, "id">): string {
  return [
    proposalPrTitle(proposal),
    "",
    `The eval improver proposed this change to improve ${proposal.goal}.`,
    "",
    proposal.rationale.trim(),
    "",
    isPromptKind(proposal.kind)
      ? `Re-judged on the calibrated cases of run ${run.id}, the proposed ${promptWho(proposal.kind)} instructions agreed with the operators' verdicts more often than the current ones.`
      : `Its full-set run ${run.id} passed the ${proposal.goal} guardrails.`,
  ].join("\n");
}

/** A table cell: untrusted text kept on one line, with its pipes unable to split the row. */
const cell = (text: string): string => text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");

function provenAgainst(run: EvalRunSummary): string[] {
  const version = run.source.kind === "set" ? (run.source.version ?? "an uncommitted set (no version)") : "not a set run";
  const panel = run.panel.length === 0 ? ["- none recorded"] : run.panel.map((judge) => `- ${judge.name} (${judge.runner}, ${judge.model})`);
  return [
    "## Proven against",
    "",
    `- Test set version: ${version}`,
    "- Panel:",
    ...panel.map((line) => `  ${line}`),
    `- Noise floor: ${noiseWords(run)}`,
  ];
}

const spreadWords = (spread: { objective: number | null; judge: number | null } | null): string =>
  spread === null ? "no spread recorded" : `spread objective ${spread.objective ?? "unknown"}, judge ${spread.judge ?? "unknown"}`;

/** The floor in plain words: which run measured it and when, how wide it is, and whether it still fits the set. */
function noiseWords(run: EvalRunSummary): string {
  if (run.noise !== null) {
    const floor = run.noise.floor;
    if (floor === null) return `no noise floor recorded (state ${run.noise.state})`;
    const drift = run.noise.drift === null ? "" : `; ${run.noise.drift.added} cases added and ${run.noise.drift.retired} retired since`;
    return `measured by run ${floor.runId} at ${floor.measuredAt} on set version ${floor.version}, ${spreadWords(floor.spread)}; ${run.noise.state}${drift}`;
  }
  // The run measured a floor itself rather than being judged against one.
  if (run.noiseFloor !== null) {
    return `this run measured one at ${run.noiseFloor.measuredAt} (${run.noiseFloor.stored ? "stored" : "not stored"}), ${spreadWords(run.noiseFloor.spread)}`;
  }
  return "no noise floor recorded";
}

function objectiveCell(total: EvalArmTotal): string {
  if (total.objective === null) return "—";
  const { passed, graded, pending } = total.objective;
  return `${passed}/${graded}${pending > 0 ? ` +${pending} pending` : ""}`;
}

function costCell(total: EvalArmTotal): string {
  if (total.costUsd !== null) return costLabel(total.costUsd, total.costPartial);
  if (total.tokens !== null) return `${tokensLabel(total.tokens)} tokens`;
  return "unknown";
}

function scorecard(run: EvalRunSummary): string[] {
  const rows = run.totals.map((total) => {
    const judge = total.judge === null ? "—" : `${total.judge.mean === null ? "—" : total.judge.mean.toFixed(2)} (${total.judge.cases} cases)`;
    return `| ${cell(total.arm)} | ${objectiveCell(total)} | ${judge} | ${costCell(total)} | ${cell(total.heldOut ?? "—")} |`;
  });
  return [
    "## Scorecard",
    "",
    "| Arm | Objective | Judge mean | Cost | Held-out |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ];
}

function guardrailSection(proposal: StoredProposal, run: EvalRunSummary): string[] {
  const head = ["## Guardrail verdict", ""];
  if (run.guardrails === null) return [...head, "The run recorded no guardrail verdict."];
  const goal = run.guardrails.goals.find((entry) => entry.goal === proposal.goal);
  if (goal === undefined) return [...head, `The run recorded no verdict for the ${proposal.goal} goal.`];
  return [
    ...head,
    `${goal.pass ? "PASS" : "FAIL"}: the ${goal.goal} guardrails, ${run.guardrails.proposal} against ${run.guardrails.baseline}.`,
    "",
    ...goal.conditions.map((condition) => `- ${condition.pass ? "pass" : "FAIL"} — ${condition.id}: ${condition.reason}`),
  ];
}

function qualityCostSection(run: EvalRunSummary): string[] {
  const head = ["## Quality vs cost", ""];
  const plot = qualityCostPoints(run);
  if (plot === null) {
    const why = run.running ? "the run is still going" : run.totals.length < 2 ? "fewer than two arms" : "no arm has a panel score or held-out rate";
    return [...head, `no plot: ${why}.`];
  }
  return [
    ...head,
    `The Results screen's quality-vs-cost plot as numbers (cost in ${plot.unit === "usd" ? "dollars" : "tokens"}).`,
    "",
    "| Arm | Quality | Held-out | Cost |",
    "| --- | --- | --- | --- |",
    ...plot.points.map((point) =>
      `| ${cell(point.arm)} | ${point.quality === null ? "—" : `${point.quality.toFixed(2)}/5`} | ${cell(point.heldOutLabel ?? "—")} | ${point.costLabel} |`),
  ];
}

function contestedSection(run: EvalRunSummary): string[] {
  const contested = run.cases.filter((entry) => entry.contested.length > 0);
  const head = ["## Contested cases", ""];
  if (contested.length === 0) return [...head, "none"];
  return [
    ...head,
    ...contested.flatMap((entry) => [
      `- ${entry.key}${entry.contestedRule === null ? "" : ` (${entry.contestedRule})`}`,
      ...entry.contested.map((item) => `  - ${item.axis}: arms ${item.arms.join(" vs ")}`),
    ]),
  ];
}

const meanWords = (mean: number | null): string => (mean === null ? "none" : mean.toFixed(2));

/** A prompt proposal's evidence (#878): its judge accuracy against the operators' verdicts, current against proposed. */
function accuracySection(verdict: StoredPromptVerdict | undefined): string[] {
  const head = ["## Accuracy evidence", ""];
  if (verdict === undefined) return [...head, "No re-judge verdict recorded."];
  const { current, proposed } = verdict;
  const axisRows = AXES.map((axis) => {
    const now = current.axes?.[axis];
    const next = proposed.axes?.[axis];
    const label = (tally: typeof now): string => (tally === undefined ? "—" : accuracyLabel(tally));
    return `| ${cell(axis)} | ${cell(label(now))} | ${cell(label(next))} |`;
  });
  return [
    ...head,
    `Re-judged at ${verdict.at} on ${verdict.cases.length} calibrated case${verdict.cases.length === 1 ? "" : "s"}: ${verdict.cases.length === 0 ? "none" : verdict.cases.join(", ")}.`,
    "",
    "| Accuracy | Current | Proposed |",
    "| --- | --- | --- |",
    `| overall | ${cell(accuracyLabel(current.accuracy))} | ${cell(accuracyLabel(proposed.accuracy))} |`,
    ...axisRows,
    "",
    `Mean score: ${meanWords(current.meanScore)} → ${meanWords(proposed.meanScore)} (reported only: raising scores alone never passes).`,
    "",
    `${verdict.pass ? "PASS" : "FAIL"}:`,
    "",
    ...verdict.conditions.map((condition) => `- ${condition.pass ? "pass" : "FAIL"} — ${condition.id}: ${condition.reason}`),
  ];
}

/** A Markdown code fence longer than any backtick run in the text, so instructions holding their own ``` cannot close it early. */
function fence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

function changeSection(proposal: StoredProposal): string[] {
  const head = ["## The change", ""];
  if (isPromptKind(proposal.kind)) {
    const instructions = (proposal.content as Partial<PromptContent> | null)?.instructions ?? "";
    const f = fence(instructions);
    return [...head, `Replaces \`${EVAL_INSTRUCTION_FILES[proposal.kind]}\` whole with:`, "", `${f}markdown`, instructions, f];
  }
  if (proposal.kind === "lineup") {
    const stages = lineupStages(proposal.content);
    return [...head, ...(stages.length === 0 ? ["no stage"] : stages.map(([stage, value]) => `- ${stage} → ${value.model} (${value.runner ?? "current runner"})`))];
  }
  const files = overlayFiles(proposal.content);
  return [...head, "Replaces these prompt files whole:", "", ...(files.length === 0 ? ["no file"] : files.map((file) => `- \`${file}\``))];
}

export interface ProposalPrInput {
  proposal: StoredProposal;
  state: ProposalState;
  run: EvalRunSummary;
  /** A judge- or analyst-prompt proposal's re-judge verdict (#878), rendered in place of the run's guardrails. */
  verdict?: StoredPromptVerdict;
  /** An HTML comment the caller finds the PR again by; first so a search never misses it. */
  marker: string;
}

export function proposalPrBody(input: ProposalPrInput): string {
  const { proposal, state, run, verdict, marker } = input;
  const prompt = isPromptKind(proposal.kind);
  // A prompt proposal is proven by its re-judge, not by an A/B run: the run is only its source.
  const runs = prompt
    ? [`- Source run: ${run.id}`]
    : [`- Subset run: ${state.runs.subset ?? "none"}`, `- Full run: ${state.runs.full ?? run.id}`];
  const evidence = prompt
    ? accuracySection(verdict)
    : [...scorecard(run), "", ...guardrailSection(proposal, run), "", ...qualityCostSection(run), "", ...contestedSection(run)];
  const answers = proposal.answers.length === 0
    ? ["- none"]
    : proposal.answers.map((answer) => `- ${answer.knob} / ${answer.target}: ${answer.change}`);
  return [
    marker,
    "",
    "## Summary",
    "",
    `- Proposal: ${proposal.id} (${proposal.kind})`,
    `- Goal: ${proposal.goal}`,
    ...runs,
    "",
    "Rationale:",
    "",
    proposal.rationale.trim(),
    "",
    "Answers:",
    "",
    ...answers,
    "",
    ...provenAgainst(run),
    "",
    ...evidence,
    "",
    ...changeSection(proposal),
    "",
    "Opened by the eval improver (#875). It never merges: a person reviews and merges or closes this PR.",
    "",
  ].join("\n");
}
