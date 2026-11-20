/**
 * The judge panel (#801): several blind judges, possibly of different model
 * families, score every candidate of one case on named axes with cited
 * evidence, say what each did better than the others, and rank them.
 *
 * Blind as the single judge was (#535): candidates are shown under neutral
 * labels in a seeded shuffle, and nothing in the prompt says which is the
 * reference or which lineup or prompt wrote the others. Labels become arms
 * again only after every call.
 *
 * Where two families disagree on an axis — one scores arm X above arm Y and
 * another Y above X — the axis is CONTESTED for that pair. That is reported,
 * never averaged away: it is where a person should look. A config may choose
 * the spread rule instead (#818): one arm's family means on an axis differ by
 * at least N points.
 */
import type { BacktestTicket } from "./backtest";
import { MAX_DIFF_CHARS, shuffleArms, type ArmId, type JudgeCall, type JudgeResult } from "./backtest-judge";

/** What each judge scores every candidate on. `review` is how well the change took review, first head to final. */
export const AXES = ["correctness", "scope", "tests", "maintainability", "review"] as const;
export type Axis = (typeof AXES)[number];

export const AXIS_QUESTIONS: Record<Axis, string> = {
  correctness: "Does the final change do what the ticket asks, and correctly?",
  scope: "Does it do no more than the ticket asks: no unrelated edits, no speculative extras?",
  tests: "Do its tests pin the changed behaviour, without weakening existing tests?",
  maintainability: "Does it fit the codebase's patterns, and is it clear and easy to change later?",
  review: "From its first head to its final head, did review rounds make it better? null when it shows one head only.",
};

export interface JudgeSpec {
  /** Shown in reports; unique within a panel. */
  name: string;
  /** The model family: two judges of one runner never contest each other. */
  runner: "claude" | "codex";
  model: string;
}

export interface Candidate {
  arm: ArmId;
  /** The diff of the arm's first pushed head against its base; null when it has one head, or it was not read. */
  first: string | null;
  final: string;
}

/** A 1–5 score with the evidence for it; null where the axis does not apply (a single head has no review). */
export type AxisScore = { score: number | null; evidence: string };

export type JudgeVerdict =
  | {
    judge: JudgeSpec; status: "ok";
    ranking: ArmId[][];
    arms: Record<string, { axes: Record<Axis, AxisScore>; better: string }>;
    reason: string;
  }
  | { judge: JudgeSpec; status: "unavailable"; reason: string };

/**
 * How the panel decides an axis is contested (#818): `inversion`, two families
 * order a pair of arms the opposite way; `spread`, two families' mean scores
 * for one arm differ by at least `points`.
 */
export type ContestedRule = { kind: "inversion" } | { kind: "spread"; points: number };

/** The rule in words, for reports. */
export function contestedRuleLabel(rule: ContestedRule): string {
  return rule.kind === "inversion" ? "ranking inversion between judge families" : `a spread of ${rule.points}+ points between judge families' mean scores`;
}

/** Two arms under `inversion`, one under `spread`. */
export interface Contested { axis: Axis; arms: ArmId[]; judges: string[] }

export interface PanelResult {
  seed: string;
  /** The order every judge saw the candidates in. */
  order: ArmId[];
  verdicts: JudgeVerdict[];
  contested: Contested[];
  /** The rule `contested` was found by; absent in scores written before #818, which read as inversion. */
  rule?: ContestedRule;
  /** The panel's ranking, the shape the single judge reported, so ledgers and reports read it unchanged. */
  aggregate: JudgeResult;
}

function fenced(diff: string): { body: string; note: string; fence: string } {
  const cut = diff.length > MAX_DIFF_CHARS;
  const body = cut ? diff.slice(0, MAX_DIFF_CHARS) : diff;
  // A diff of a Markdown file can hold its own ``` and would close a fixed fence early.
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  return { body, note: cut ? ` (truncated to its first ${MAX_DIFF_CHARS} characters of ${diff.length})` : "", fence: "`".repeat(Math.max(3, longest + 1)) };
}

/**
 * The panel prompt's opening instructions (#878). Separate from the sections that carry the case so an
 * evaluation proposal can replace them (eval-instructions.ts reads the harness file) and leave the ticket,
 * candidates, axes and answer format as they are.
 */
export const JUDGE_INSTRUCTIONS = [
  "You are one judge on a panel comparing candidate changes for one ticket. Read the ticket, then each",
  "candidate's diffs: its final head, and its first head where it shows one. Judge only the diffs;",
  "the order they are listed in means nothing, and nothing tells you who or what wrote them.",
].join("\n");

/** The panel's whole input: the frozen ticket and each candidate's heads under a neutral label. */
export function panelPrompt(frozen: BacktestTicket["frozen"], candidates: { label: string; first: string | null; final: string }[],
  instructions: string = JUDGE_INSTRUCTIONS): string {
  const comments = frozen.comments.length === 0 ? "(none)" : frozen.comments.map((c) => `--- ${c.createdAt}\n${c.body}`).join("\n\n");
  const shown = candidates.map(({ label, first, final }) => {
    const parts = [`## Candidate ${label}`];
    if (first !== null && first !== final) {
      const f = fenced(first);
      parts.push("", `### First head${f.note}`, "", `${f.fence}diff\n${f.body}\n${f.fence}`);
    }
    const f = fenced(final);
    parts.push("", `### Final head${f.note}`, "", `${f.fence}diff\n${f.body}\n${f.fence}`);
    return parts.join("\n");
  }).join("\n\n");
  const labels = candidates.map((c) => `"${c.label}"`).join(", ");
  const axes = AXES.map((axis) => `- \`${axis}\`: ${AXIS_QUESTIONS[axis]}`).join("\n");
  return [
    instructions,
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
    "# Axes",
    "",
    "Score every candidate 1 (poor) to 5 (excellent) on each axis, with the evidence for the score: a file",
    "and line from its diff, or what is missing.",
    "",
    axes,
    "",
    "# Answer",
    "",
    "Answer with JSON only, no other text. Placeholders are in angle brackets:",
    "",
    "{\"candidates\": {\"<label>\": {\"axes\": {\"correctness\": {\"score\": <1-5>, \"evidence\": \"<file:line or what is missing>\"}, "
      + "\"scope\": {…}, \"tests\": {…}, \"maintainability\": {…}, \"review\": {\"score\": <1-5 or null>, \"evidence\": \"…\"}}, "
      + "\"better\": \"<what this candidate did better than the others, one sentence>\"}}, "
      + "\"ranking\": [[\"<label>\"], [\"<label>\", \"<label>\"]], \"reason\": \"<one or two sentences>\"}",
    "",
    "`ranking` lists tiers best first; labels in one tier are tied. Use every label exactly once, in `ranking`",
    `and in \`candidates\`: ${labels}.`,
  ].join("\n");
}

// The answer may come fenced or with prose around it: try the fenced block, then the outermost braces.
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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

type Parsed =
  | { ok: true; ranking: string[][]; candidates: Record<string, { axes: Record<Axis, AxisScore>; better: string }>; reason: string }
  | { ok: false; reason: string };

/** One judge's answer, valid only when every label is ranked once and scored on every axis. */
export function parsePanelAnswer(text: string, labels: readonly string[]): Parsed {
  const doc = jsonIn(text);
  if (!isRecord(doc)) return { ok: false, reason: "answered with no JSON object" };
  const { ranking, candidates, reason } = doc;
  if (!Array.isArray(ranking) || ranking.length === 0) return { ok: false, reason: "the answer has no ranking" };
  const seen = new Set<string>();
  const tiers: string[][] = [];
  for (const tier of ranking) {
    if (!Array.isArray(tier) || tier.length === 0) return { ok: false, reason: "a ranking tier is not a non-empty list" };
    const out: string[] = [];
    for (const raw of tier) {
      const label = typeof raw === "number" ? String(raw) : raw;
      if (typeof label !== "string" || !labels.includes(label)) return { ok: false, reason: `the ranking names unknown candidate ${String(raw)}` };
      if (seen.has(label)) return { ok: false, reason: `the ranking names candidate ${label} twice` };
      seen.add(label);
      out.push(label);
    }
    tiers.push(out);
  }
  const missing = labels.filter((label) => !seen.has(label));
  if (missing.length > 0) return { ok: false, reason: `the ranking leaves out candidate ${missing.join(", ")}` };
  if (!isRecord(candidates)) return { ok: false, reason: "the answer scores no candidates" };
  const scored: Record<string, { axes: Record<Axis, AxisScore>; better: string }> = {};
  for (const label of labels) {
    const entry = candidates[label];
    if (!isRecord(entry) || !isRecord(entry.axes)) return { ok: false, reason: `candidate ${label} has no axis scores` };
    const axes = {} as Record<Axis, AxisScore>;
    for (const axis of AXES) {
      const given = entry.axes[axis];
      if (!isRecord(given)) return { ok: false, reason: `candidate ${label} has no ${axis} score` };
      const score = given.score;
      // Only `review` may be null: a single head has no review to judge.
      const valid = (typeof score === "number" && Number.isInteger(score) && score >= 1 && score <= 5) || (score === null && axis === "review");
      if (!valid) return { ok: false, reason: `candidate ${label}'s ${axis} score is not 1–5` };
      axes[axis] = { score: score as number | null, evidence: typeof given.evidence === "string" ? given.evidence : "" };
    }
    scored[label] = { axes, better: typeof entry.better === "string" ? entry.better : "" };
  }
  return { ok: true, ranking: tiers, candidates: scored, reason: typeof reason === "string" ? reason : "" };
}

/**
 * The axes two judge families disagree on, by `rule`. Under inversion, every
 * pair of arms whose order on an axis two families invert; under spread, every
 * arm whose families' mean scores on an axis differ by at least `points`. A
 * family's view is the mean of its judges' scores, so two Claude judges never
 * contest each other, only another family.
 */
export function contestedAxes(verdicts: readonly JudgeVerdict[], arms: readonly ArmId[], rule: ContestedRule = { kind: "inversion" }): Contested[] {
  const ok = verdicts.filter((verdict): verdict is Extract<JudgeVerdict, { status: "ok" }> => verdict.status === "ok");
  const families = [...new Set(ok.map((verdict) => verdict.judge.runner))];
  if (families.length < 2) return [];
  const out: Contested[] = [];
  if (rule.kind === "spread") {
    for (const axis of AXES) {
      for (const arm of arms) {
        // Each family's mean for this arm; a null score (review on a single head) is no score.
        const means = new Map<string, number>();
        for (const family of families) {
          const scores = ok.filter((verdict) => verdict.judge.runner === family).flatMap((verdict) => {
            const score = verdict.arms[arm]?.axes[axis]?.score;
            return typeof score === "number" ? [score] : [];
          });
          if (scores.length > 0) means.set(family, scores.reduce((a, b) => a + b, 0) / scores.length);
        }
        if (means.size < 2) continue;
        const values = [...means.values()];
        // A three-judge mean is a float: 13/3 - 7/3 is 1.9999999999999996, and an exact spread must still count.
        if (Math.max(...values) - Math.min(...values) >= rule.points - 1e-9) {
          const judges = ok.filter((verdict) => means.has(verdict.judge.runner)).map((verdict) => verdict.judge.name);
          out.push({ axis, arms: [arm], judges });
        }
      }
    }
    return out;
  }
  for (const axis of AXES) {
    for (let i = 0; i < arms.length; i++) {
      for (let j = i + 1; j < arms.length; j++) {
        const x = arms[i]!;
        const y = arms[j]!;
        const signs = new Map<string, number>();
        for (const family of families) {
          const diffs = ok.filter((verdict) => verdict.judge.runner === family).flatMap((verdict) => {
            const sx = verdict.arms[x]?.axes[axis]?.score;
            const sy = verdict.arms[y]?.axes[axis]?.score;
            return typeof sx === "number" && typeof sy === "number" ? [sx - sy] : [];
          });
          if (diffs.length === 0) continue;
          const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
          if (mean !== 0) signs.set(family, Math.sign(mean));
        }
        const values = [...signs.values()];
        if (values.includes(1) && values.includes(-1)) {
          const judges = ok.filter((verdict) => signs.has(verdict.judge.runner)).map((verdict) => verdict.judge.name);
          out.push({ axis, arms: [x, y], judges });
        }
      }
    }
  }
  return out;
}

/** The panel's ranking: arms by their mean tier position across the judges that answered; equal means tie. */
export function aggregateRanking(verdicts: readonly JudgeVerdict[], seed: string, order: ArmId[]): JudgeResult {
  const ok = verdicts.filter((verdict): verdict is Extract<JudgeVerdict, { status: "ok" }> => verdict.status === "ok");
  if (ok.length === 0) {
    const why = verdicts.map((verdict) => `${verdict.judge.name}: ${verdict.reason}`).join("; ") || "no judge on the panel";
    return { status: "unavailable", seed, order, reason: why };
  }
  const position = new Map<ArmId, number>();
  for (const arm of order) {
    const places = ok.map((verdict) => verdict.ranking.findIndex((tier) => tier.includes(arm)));
    position.set(arm, places.reduce((a, b) => a + b, 0) / places.length);
  }
  const means = [...new Set(position.values())].sort((a, b) => a - b);
  const ranking = means.map((mean) => order.filter((arm) => position.get(arm) === mean));
  const winners = ranking[0]!;
  const reason = ok.length === 1 ? ok[0]!.reason : ok.map((verdict) => `${verdict.judge.name}: ${verdict.reason}`).join(" ");
  return { status: "ok", seed, order, ranking, winners, tie: winners.length > 1, reason };
}

/** Judge one case with every judge on the panel. A judge that fails abstains; the panel never throws. */
export async function judgePanel(input: {
  ticket: BacktestTicket;
  candidates: Candidate[];
  seed: string;
  judges: { spec: JudgeSpec; call: JudgeCall }[];
  /** Absent is inversion, the rule before #818. */
  contested?: ContestedRule;
  /** The prompt's opening instructions (#878); absent: JUDGE_INSTRUCTIONS. */
  instructions?: string;
}): Promise<PanelResult> {
  const rule: ContestedRule = input.contested ?? { kind: "inversion" };
  const present = input.candidates.filter((candidate) => candidate.final.trim() !== "");
  const shown = shuffleArms(present, input.seed, input.ticket.oaKey);
  const order = shown.map((candidate) => candidate.arm);
  if (shown.length < 2) {
    const reason = "fewer than two arms produced a diff";
    const verdicts: JudgeVerdict[] = input.judges.map((judge) => ({ judge: judge.spec, status: "unavailable", reason }));
    return { seed: input.seed, order, verdicts, contested: [], rule, aggregate: { status: "unavailable", seed: input.seed, order, reason } };
  }
  const labels = shown.map((_, index) => String(index + 1));
  const prompt = panelPrompt(input.ticket.frozen, shown.map((candidate, index) => ({ label: labels[index]!, first: candidate.first, final: candidate.final })), input.instructions);
  const verdicts = await Promise.all(input.judges.map(async ({ spec, call }): Promise<JudgeVerdict> => {
    let answer: Awaited<ReturnType<JudgeCall>>;
    try { answer = await call(prompt); } catch (error) { answer = { ok: false, reason: `the call threw: ${error instanceof Error ? error.message : String(error)}` }; }
    if (!answer.ok) return { judge: spec, status: "unavailable", reason: answer.reason };
    const parsed = parsePanelAnswer(answer.text, labels);
    if (!parsed.ok) return { judge: spec, status: "unavailable", reason: parsed.reason };
    // Only now does a label become an arm again.
    const arm = (label: string): ArmId => order[Number(label) - 1]!;
    const arms: Record<string, { axes: Record<Axis, AxisScore>; better: string }> = {};
    for (const [label, scored] of Object.entries(parsed.candidates)) arms[arm(label)] = scored;
    return { judge: spec, status: "ok", ranking: parsed.ranking.map((tier) => tier.map(arm)), arms, reason: parsed.reason };
  }));
  return { seed: input.seed, order, verdicts, contested: contestedAxes(verdicts, order, rule), rule, aggregate: aggregateRanking(verdicts, input.seed, order) };
}
