/**
 * Scores one sandboxed backtest trial and renders a batch of them.
 *
 * Pure on purpose: the batch runner owns every process and file, and this
 * module only turns what a trial left behind (`TrialResult`) into a row a
 * person can compare across arms. Every read of the fake GitHub state is
 * defensive, because a trial that died mid-write leaves whatever it left: a
 * malformed state scores as "no PR", never as a throw that loses the batch.
 */
import { listed, testCount } from "./base-red";
import { parseDiff, weakeningProblems } from "./executor-guard/diff-guard";
import { armList, describeArm, type SampleArms } from "./backtest";
import type { ArmScore, ReviewScore, TicketScore } from "./backtest-score";
import { renderAnalysis, type Analysis } from "./eval-analyst";
import { gradeRun, type ArmGrades, type CaseGrade, type RunGrades } from "./eval-grade";
// eval-noise-floor imports this module for types only, so the runtime import makes no cycle.
import { measureFloor, type AxisGap, type NoiseReport } from "./eval-noise-floor";
// Types only: eval-guardrails imports this module's types and nothing here runs it.
import type { GuardrailVerdict } from "./eval-guardrails";
// eval-judge-accuracy imports this module for types only, so the runtime import makes no cycle.
import { accuracyLabel, type JudgeAccuracy } from "./eval-judge-accuracy";
import { AXES, contestedRuleLabel, type Axis } from "./eval-panel";
import type { Tokens } from "./experiments";
import { measureSpeed } from "./speed";
import type { TrialResult } from "./trial-sandbox";

/** An agent arm's name: `b` and `c` on a legacy config, any kebab-case name but `a` since #801. */
export type ArmName = string;
export type TrialOutcome = "green-pr" | "failed" | "timed-out" | "refused" | "not-run";
/** A check on a head. `baseRed` names the tests forgiven because the trial's base already failed them (#579). */
export interface Gate { name: string; conclusion: string; baseRed?: string[] }

export interface TrialRow {
  ticket: string;
  arm: ArmName;
  /** `live`, or the arm's lineup name. */
  lineup: string;
  outcome: TrialOutcome;
  /** One line: the sigil, the refusal reasons, or why it failed. */
  detail: string;
  /** The checks on the final head; null when it has none. */
  gates: Gate[] | null;
  weakening: string[];
  /** Pushes after the first on the newest PR; null with no PR. */
  reviewRounds: number | null;
  reviewThreads: number | null;
  wallSeconds: number;
  /**
   * The trial's claim to its hand-off, from its own speed ledger (#578): the
   * clock the live loops' ledger keeps. Null when the trial handed nothing
   * off; absent from rows saved before it existed, which read as null.
   */
  handoffSeconds?: number | null;
  tokens: Tokens | null;
  cost: { usd: number | null; source: "reported" | "estimated" | "unknown" };
  artifacts: string;
  models: { stage: string; model: string; runner: string }[];
  /**
   * The commits scoring reads from the arm's bundle: the sandbox base, the
   * newest PR's first push (else the final head) and the final head. Optional
   * because rows saved before #534 lack it; a reader treats it as missing.
   */
  heads?: { base: string | null; first: string | null; final: string | null };
  /** The repeat this trial is, 1 to k, when its case was run again (#801); absent on the case's first trial. */
  repeat?: number;
}

/** One stage as an arm resolved it when its first trial was built (#816). */
export interface ResolvedStage { stage: string; runner: string; model: string; effort: string | null }
/** What an arm ran with: its stages, and the hash of its prompt overlay when it has one. */
export interface ArmResolution { stages: ResolvedStage[]; overlayHash: string | null }
/** The run's own configuration: absent from a report written before #816. */
export interface RunResolution {
  /** By arm name; an arm whose trials never built (or whose starter reported nothing) is absent. */
  arms: Record<ArmName, ArmResolution>;
  panel: { name: string; runner: string; model: string }[];
  /** The panel's shuffle seed; null when the config turns the panel off. */
  seed: string | null;
}

export interface BacktestReport {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  arms: SampleArms;
  rows: TrialRow[];
  skipped: { oaKey: string; reason: string }[];
  notes: string[];
  stoppedBy: "batch-cap" | null;
  /** Set once the batch is scored (#534); reports written before it lack the field. Each case's first trials only. */
  scores?: TicketScore[];
  /** Each repeat's scores, one per case and repeat (#821); absent before it. The verdict stays `scores`'. */
  repeatScores?: TicketScore[];
  /** The analyst's improvements after the panel (#801); absent before it, null when turned off. */
  analysis?: Analysis | null;
  /** What each arm and the panel resolved to (#816); absent before it. */
  resolved?: RunResolution;
  /**
   * On a test set run (#854): the set's commit (null: uncommitted) and the case ids selected; absent before it and on other sources.
   * `checks` (#855): the selected case ids that carry an operator check; absent on reports written before it.
   */
  set?: { version: string | null; selected: string[]; checks?: string[] };
  /** On a run that measured the set's noise floor (#859): when; its floor is `noise-floor.json` beside the report. */
  noiseFloor?: { measuredAt: string };
  /** On a later set run (#859): each arm's gap against the latest noise floor, objective and judge apart; absent before it. */
  noise?: NoiseReport;
  /** On a set run with a live baseline arm and one proposal arm (#871): the guardrail verdict for each goal; absent otherwise. */
  guardrails?: GuardrailVerdict;
  /** How often the panel agreed with the operator's calibration verdicts (#877); absent before #877 and off a set run. */
  judgeAccuracy?: JudgeAccuracy;
}

// NEUTRAL and SKIPPED do not block a merge on GitHub either.
export const PASSING: ReadonlySet<string> = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

/**
 * Token and cost totals from a trial's logs. Claude stream-json `result`
 * events carry both; a delegate's `.usage` file carries tokens for any
 * runner. The `.usage` file is rendered from the same delegate's
 * `.log.jsonl`, so where both exist the tokens are taken from `.usage` only
 * — summing both would count the executor twice. Cost comes only from events.
 */
export function readIterationUsage(logs: { path: string; text: string }[]): { tokens: Tokens | null; reportedUsd: number | null } {
  const tokens: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let metered = false;
  let reportedUsd: number | null = null;
  const usageStems = new Set(logs.flatMap(({ path }) => (/delegate-[^/]*\.usage$/.test(path) ? [path.slice(0, -".usage".length)] : [])));
  for (const { path, text } of logs) {
    if (/delegate-[^/]*\.usage$/.test(path)) {
      const fields = { input: "INPUT", output: "OUTPUT", cacheRead: "CACHE_READ", cacheWrite: "CACHE_WRITE" } as const;
      for (const [key, field] of Object.entries(fields) as [keyof Tokens, string][]) {
        for (const match of text.matchAll(new RegExp(`^DELEGATE_${field}=(\\d+)\\s*$`, "gm"))) {
          metered = true;
          tokens[key] += Number(match[1]);
        }
      }
      continue;
    }
    if (!path.endsWith(".jsonl")) continue;
    const tokensCounted = !usageStems.has(path.replace(/\.log\.jsonl$/, ""));
    for (const line of text.split("\n")) {
      let event: unknown;
      try { event = JSON.parse(line); } catch { continue; /* runner diagnostics are not JSON */ }
      if (!isRecord(event) || event.type !== "result") continue;
      const cost = event.total_cost_usd;
      if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) reportedUsd = (reportedUsd ?? 0) + cost;
      if (!tokensCounted || !isRecord(event.usage)) continue;
      metered = true;
      tokens.input += count(event.usage.input_tokens);
      tokens.output += count(event.usage.output_tokens);
      tokens.cacheRead += count(event.usage.cache_read_input_tokens);
      tokens.cacheWrite += count(event.usage.cache_creation_input_tokens);
    }
  }
  return { tokens: metered ? tokens : null, reportedUsd };
}

interface NewestPr {
  heads: { sha: string; checks: Gate[] | null }[];
  headRefOid: string | null;
  threads: number;
}

/** The highest-numbered PR in the fake's state, read field by field; null when there is none or the state is malformed. */
function newestPr(github: unknown): NewestPr | null {
  if (!isRecord(github) || !Array.isArray(github.prs)) return null;
  const prs = github.prs.filter(isRecord);
  if (prs.length === 0) return null;
  const pr = prs.reduce((newest, candidate) => (count(candidate.number) >= count(newest.number) ? candidate : newest));
  const heads = (Array.isArray(pr.heads) ? pr.heads : []).filter(isRecord).flatMap((head) => {
    if (typeof head.sha !== "string") return [];
    const checks = Array.isArray(head.checks)
      ? head.checks.filter(isRecord).map((check): Gate => {
        const gate: Gate = { name: String(check.name ?? ""), conclusion: String(check.conclusion ?? "") };
        // Only a well-formed list is kept: a malformed one says nothing about which tests were forgiven.
        if (Array.isArray(check.baseRed) && check.baseRed.every((test) => typeof test === "string")) gate.baseRed = check.baseRed as string[];
        return gate;
      })
      : null;
    return [{ sha: head.sha, checks }];
  });
  return {
    heads,
    headRefOid: typeof pr.headRefOid === "string" ? pr.headRefOid : null,
    threads: Array.isArray(pr.reviewThreads) ? pr.reviewThreads.length : 0,
  };
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const forgiven = (gate: Gate): boolean => PASSING.has(gate.conclusion) && (gate.baseRed?.length ?? 0) > 0;

/** `trial/test (1 test), trial/lint (2 tests)` over the gates that passed only by forgiving base-red tests. */
const forgivenList = (gates: Gate[]): string =>
  gates.filter(forgiven).map((gate) => `${gate.name} (${testCount(gate.baseRed!.length)})`).join(", ");

/** A Gates cell: passing over total, with the base-red forgiven ones counted when there are any. */
function gatesCell(gates: Gate[] | null): string {
  if (!gates) return "—";
  const baseRed = gates.filter(forgiven).length;
  return `${gates.filter((gate) => PASSING.has(gate.conclusion)).length}/${gates.length}${baseRed > 0 ? ` (${baseRed} base-red)` : ""}`;
}

/**
 * A failed row whose every failing gate a rescore re-judged as passing only
 * by forgiving tests the base already failed, turned green. A gate re-judged
 * as passing without base-red tests is a flake, not the base's fault, and a
 * re-judged failure is the agent's own: either leaves the row as it was.
 */
export function forgiveBaseRed(row: TrialRow, gates: ArmScore["gates"]): TrialRow {
  if (row.outcome !== "failed" || row.gates === null || gates === null) return row;
  const failing = row.gates.filter((gate) => !PASSING.has(gate.conclusion));
  if (failing.length === 0) return row;
  const rejudged = new Map<string, Gate>();
  for (const gate of failing) {
    const again = gates.find((candidate) => candidate.name === gate.name);
    if (!again || !forgiven(again)) return row;
    rejudged.set(gate.name, again);
  }
  const merged = row.gates.map((gate) => (PASSING.has(gate.conclusion) ? gate : rejudged.get(gate.name)!));
  // The old detail is `failing checks: …; <ralph>…</ralph>`; the sigil is what the iteration said, so it stays.
  const separator = row.detail.indexOf("; ");
  const rest = separator === -1 ? "" : row.detail.slice(separator + 2);
  const sigil = rest.startsWith("<ralph>") ? `; ${rest}` : "";
  return { ...row, outcome: "green-pr", gates: merged, detail: `green apart from base-red tests: ${forgivenList(merged)}${sigil}` };
}

export function scoreTrial(input: {
  ticket: string;
  arm: ArmName;
  lineup: string;
  result: TrialResult;
  wallSeconds: number;
  partialPatch: string;
  artifacts: string;
  rates: { inputPerMTok: number; outputPerMTok: number } | null;
}): TrialRow {
  const { result } = input;
  const pr = newestPr(result.github);
  const finalSha = result.finalHead ?? pr?.headRefOid ?? null;
  const finalHead = pr?.heads.find((head) => head.sha === finalSha) ?? null;
  const gates = finalHead?.checks && finalHead.checks.length > 0 ? finalHead.checks : null;
  const green = gates !== null && gates.every((gate) => PASSING.has(gate.conclusion));
  const killed = result.outcome.kind === "timeout" || result.outcome.kind === "aborted";

  // A killed run that pushed nothing still wrote code; the batch runner saves
  // that as the partial patch, and a weakened test in it counts all the same.
  const patch = killed && result.finalHead === null && input.partialPatch !== "" ? input.partialPatch : result.patch;
  const weakening = weakeningProblems(parseDiff(patch));

  let outcome: TrialOutcome;
  let detail: string;
  if (result.outcome.kind === "refused") {
    outcome = "refused";
    detail = result.failures.map((failure) => `${failure.leak}: ${oneLine(failure.why)}`).join("; ") || "refused with no reason given";
  } else if (killed) {
    // Timed out wins over green: a killed run did not hand anything over.
    outcome = "timed-out";
    detail = `killed by a trial or batch cap (${result.outcome.kind})`;
  } else if (green) {
    outcome = "green-pr";
    detail = oneLine(result.outcome.sigil ?? "green PR, no sigil");
    // A forgiven check is SUCCESS, so it is green; the detail says what was forgiven.
    const baseRed = forgivenList(gates!);
    if (baseRed !== "") detail = `${detail}; base-red forgiven: ${baseRed}`;
  } else {
    outcome = "failed";
    const failing = gates?.filter((gate) => !PASSING.has(gate.conclusion)).map((gate) => `${gate.name} ${gate.conclusion}`) ?? [];
    const why = result.outcome.kind === "failed" ? "the supervisor could not start"
      : pr === null ? "no PR opened"
      : failing.length > 0 ? `failing checks: ${failing.join(", ")}`
      : "no checks on the final head";
    detail = result.outcome.sigil ? `${why}; ${oneLine(result.outcome.sigil)}` : why;
  }

  const { tokens, reportedUsd } = readIterationUsage(result.logs);
  let cost: TrialRow["cost"];
  if (reportedUsd !== null) cost = { usd: reportedUsd, source: "reported" };
  else if (tokens !== null && input.rates !== null) {
    // The config carries only an input and an output rate, so cache reads and
    // writes are priced at the input rate: an upper bound, since cache reads
    // are billed far below it.
    const inputSide = tokens.input + tokens.cacheRead + tokens.cacheWrite;
    cost = { usd: (inputSide * input.rates.inputPerMTok + tokens.output * input.rates.outputPerMTok) / 1_000_000, source: "estimated" };
  } else cost = { usd: null, source: "unknown" };

  return {
    ticket: input.ticket,
    arm: input.arm,
    lineup: input.lineup,
    outcome,
    detail,
    gates,
    weakening,
    reviewRounds: pr === null ? null : Math.max(0, pr.heads.length - 1),
    reviewThreads: pr === null ? null : pr.threads,
    wallSeconds: input.wallSeconds,
    // `speed` is absent from a result saved before the ledger existed.
    handoffSeconds: measureSpeed(result.speed ?? []).measured[0]?.claimToHandoffSeconds ?? null,
    tokens,
    cost,
    artifacts: input.artifacts,
    models: result.models,
    heads: { base: result.base, first: pr?.heads[0]?.sha ?? result.finalHead, final: result.finalHead },
  };
}

const median = (values: number[]): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length === 0 ? null : sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
const seconds = (value: number): string => `${Math.round(value)}s`;
const usd = (value: number): string => `$${value.toFixed(4)}`;

/** An arm's total cost over the trials that ran: the known sum, marked a lower bound when some cost is unknown. */
function armCost(ran: TrialRow[]): string {
  // A trial that never ran says nothing about the arm: the caller leaves it out, it is not a miss.
  const known = ran.filter((row) => row.cost.usd !== null).reduce((sum, row) => sum + row.cost.usd!, 0);
  const unknown = ran.filter((row) => row.cost.usd === null).length;
  return ran.length === 0 ? "—" : unknown === 0 ? usd(known) : `≥ ${usd(known)} (${unknown} unknown)`;
}

/**
 * Why each trial that did not run did not, one line per case and reason: the
 * table says only `not-run`, and a case refused for a base that does not build
 * (#820) must say so, or it reads as an arm's failure to start.
 */
function renderNotRun(rows: readonly TrialRow[]): string[] {
  const byReason = new Map<string, { ticket: string; reason: string; arms: string[] }>();
  for (const row of rows) {
    if (row.outcome !== "not-run") continue;
    const reason = oneLine(row.detail);
    const key = `${row.ticket}\n${reason}`;
    const arm = `${row.arm}${row.repeat === undefined ? "" : ` r${row.repeat}`}`;
    const entry = byReason.get(key);
    if (entry) entry.arms.push(arm);
    else byReason.set(key, { ticket: row.ticket, reason, arms: [arm] });
  }
  if (byReason.size === 0) return [];
  return ["", "## Not run", "", ...[...byReason.values()].map((entry) => `- ${entry.ticket} (${entry.arms.join(", ")}): ${entry.reason}`)];
}

export function renderBacktestReport(report: BacktestReport): string {
  const lines = [
    `# Backtest ${report.id}`,
    "",
    `Started ${report.startedAt}; ${report.finishedAt ? `finished ${report.finishedAt}` : "not finished"}.${report.stoppedBy === "batch-cap" ? " Stopped by the batch cap." : ""}`,
    Array.isArray(report.arms)
      ? `Arms: ${report.arms.map((arm) => `${arm.name} (${describeArm(arm)})`).join("; ")}.`
      : `Arm B: ${report.arms.b}. Arm C: ${report.arms.c ?? "not run"}.`,
    ...(report.set === undefined ? [] : [`Test set ${report.set.version ?? "(uncommitted)"}: ${report.set.selected.length} cases selected.`]),
    ...renderResolution(report),
    "",
    "| Ticket | Arm | Outcome | Gates | Weakening | Review rounds | Wall time | Tokens in / out | Cost |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of report.rows) {
    const gates = gatesCell(row.gates);
    const tokens = row.tokens ? `${row.tokens.input + row.tokens.cacheRead + row.tokens.cacheWrite} / ${row.tokens.output}` : "—";
    const cost = row.cost.usd === null ? "unknown" : `${usd(row.cost.usd)} (${row.cost.source})`;
    lines.push(`| ${cell(row.ticket)} | ${row.arm}${row.repeat === undefined ? "" : ` r${row.repeat}`} (${cell(row.lineup)}) | ${row.outcome} | ${gates} | ${row.weakening.length} | ${row.reviewRounds ?? "—"} | ${seconds(row.wallSeconds)} | ${tokens} | ${cost} |`);
  }
  lines.push("");
  const agentArms = armList(report.arms).map((arm) => arm.name);
  // A case's first trials only: repeats are counted in their own section.
  const firsts = report.rows.filter((row) => row.repeat === undefined);
  for (const arm of agentArms) {
    const rows = firsts.filter((row) => row.arm === arm);
    if (rows.length === 0) continue;
    const ran = rows.filter((row) => row.outcome !== "not-run");
    const wall = median(ran.map((row) => row.wallSeconds));
    const total = armCost(ran);
    const notRun = rows.length - ran.length;
    const green = `${ran.filter((row) => row.outcome === "green-pr").length}/${ran.length} green PRs${notRun === 0 ? "" : ` (${notRun} not run)`}`;
    lines.push(`- Arm ${armName(arm)}: ${green}; median wall time ${wall === null ? "—" : seconds(wall)}; total cost ${total}.`);
  }
  lines.push(
    "",
    "Tokens in counts input plus cache reads and writes. An estimated cost prices all of them at the input rate, so it is an upper bound; a reported cost is the runner's own figure.",
  );
  lines.push(...renderSummary(firsts, report.scores ?? [], agentArms), ...renderGrades(gradeRun(report, agentArms)), ...renderNoise(report), ...renderGuardrails(report), ...renderJudgeAccuracy(report), ...renderRepeats(report, agentArms));
  if (report.scores && report.scores.length > 0) lines.push(...renderScoring(report.scores, firsts, agentArms), ...renderJudge(report.scores), ...renderPanel(report.scores));
  lines.push(...renderAnalysis(report.analysis));
  lines.push(...renderNotRun(report.rows));
  if (report.skipped.length > 0) {
    // On a set run a skipped case is one the set selected but this host could not run.
    lines.push("", report.set === undefined ? "## Skipped" : "## Unrunnable", "");
    for (const skip of report.skipped) lines.push(`- ${skip.oaKey}: ${oneLine(skip.reason)}`);
  }
  if (report.notes.length > 0) {
    lines.push("", "## Notes", "");
    for (const note of report.notes) lines.push(`- ${oneLine(note)}`);
  }
  lines.push(
    "",
    "A sample this small shows direction, not significance. Nothing was published: every trial ran against a fake GitHub and tracker on this host.",
    "",
  );
  return lines.join("\n");
}

/**
 * The models each arm and the panel actually ran with (#816): a lineup name
 * says what was asked for, this says what it resolved to on the day.
 */
function renderResolution(report: BacktestReport): string[] {
  const resolved = report.resolved;
  if (resolved === undefined) return [];
  const lines = armList(report.arms).map((arm) => {
    const entry = Object.hasOwn(resolved.arms, arm.name) ? resolved.arms[arm.name] : undefined;
    if (entry === undefined) return `Arm ${cell(armName(arm.name))}: models not recorded.`;
    const stages = entry.stages
      .map((stage) => `${cell(oneLine(`${stage.stage} ${stage.runner} ${stage.model}`))}${stage.effort === null ? "" : ` (${cell(oneLine(stage.effort))})`}`)
      .join("; ");
    const overlay = entry.overlayHash === null ? "" : ` Overlay sha256 ${cell(oneLine(entry.overlayHash))}.`;
    return `Arm ${cell(armName(arm.name))}: ${stages === "" ? "no stages recorded" : stages}.${overlay}`;
  });
  const panel = resolved.panel.map((judge) => cell(oneLine(`${judge.name} (${judge.runner} ${judge.model})`))).join(", ");
  if (panel === "" && resolved.seed === null) lines.push("Panel: off.");
  else lines.push(`Panel: ${panel === "" ? "none" : panel}.${resolved.seed === null ? "" : ` Seed ${cell(oneLine(resolved.seed))}.`}`);
  return lines;
}

/** `b` reads B, as the reports always spelt the legacy arms; a longer name is kept as written. */
const armName = (arm: string): string => (arm.length === 1 ? arm.toUpperCase() : arm);
const armLabel = (arm: ArmScore["arm"]): string => (arm === "a" ? "A (human)" : armName(arm));

function heldOutCell(heldOut: ArmScore["heldOut"]): string {
  if (heldOut === null) return "source";
  if (heldOut.status === "not-applicable") return "n/a (did not apply)";
  if (heldOut.status === "none") return "—";
  const passed = heldOut.files.filter((file) => file.result === "pass").length;
  // A test that already passed before the human's change proves nothing about the arm, so it is said apart.
  const baselinePassing = heldOut.files.filter((file) => file.baseline === "pass").length;
  return `${passed}/${heldOut.files.length} pass${baselinePassing > 0 ? `, ${baselinePassing} already passing on baseline` : ""}`;
}

function reviewCell(review: ReviewScore | undefined): string {
  if (review === undefined) return "—";
  if (review.status === "unavailable") return "unreviewed";
  return `P1 ${review.counts.P1} · P2 ${review.counts.P2} · P3 ${review.counts.P3}`;
}

function duration(totalSeconds: number): string {
  const minutes = Math.round(totalSeconds / 60);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** `passed/total` over an agent arm's held-out evidence files; null when no score has the arm. */
function heldOutEvidence(scores: TicketScore[], arm: ArmName): string | null {
  if (!scores.some((score) => score.arms.some((entry) => entry.arm === arm))) return null;
  // Only files that failed on the merge base are evidence: they pass because of the change, not before it.
  const evidence = scores.flatMap((score) => score.arms.filter((entry) => entry.arm === arm))
    .flatMap((entry) => (entry.heldOut?.status === "ok" ? entry.heldOut.files : []))
    .filter((file) => file.baseline === "fail");
  return `${evidence.filter((file) => file.result === "pass").length}/${evidence.length}`;
}

const plural = (n: number, word: string, many: string): string => `${n} ${n === 1 ? word : many}`;

/** The arms side by side: one row per arm, each cell computed the same way for every arm that has it. */
function renderSummary(rows: TrialRow[], scores: TicketScore[], agentArms: readonly string[]): string[] {
  const arms: ArmScore["arm"][] = [];
  if (scores.some((score) => score.arms.some((entry) => entry.arm === "a"))) arms.push("a");
  for (const arm of agentArms) {
    if (rows.some((row) => row.arm === arm) || scores.some((score) => score.arms.some((entry) => entry.arm === arm))) arms.push(arm);
  }
  if (arms.length === 0) return [];
  const lines = [
    "",
    "## Summary",
    "",
    "| Arm | Gates | Held-out | Median findings | Judge wins | Median rounds | Median wall time | Median claim to hand-off | Cost |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const arm of arms) {
    const entries = scores.flatMap((score) => score.arms.filter((entry) => entry.arm === arm));
    // A trial that never ran says nothing about the arm, so every agent cell reads only the ones that did.
    const ran = arm === "a" ? [] : rows.filter((row) => row.arm === arm && row.outcome !== "not-run");
    const gateSets = arm === "a" ? entries.map((entry) => entry.gates) : ran.map((row) => row.gates);
    const gated = gateSets.filter((gates) => gates !== null);
    const gates = gated.length === 0 ? "—" : `${gated.filter((set) => set.every((gate) => PASSING.has(gate.conclusion))).length}/${gated.length}`;
    const heldOut = arm === "a" ? "—" : heldOutEvidence(scores, arm) ?? "—";

    const finals = entries.flatMap((entry) => (entry.review ? [entry.review.final] : []));
    const found = median(finals.flatMap((review) => (review.status === "ok" ? [review.counts.P1 + review.counts.P2 + review.counts.P3] : [])));
    const unreviewed = finals.filter((review) => review.status === "unavailable").length;
    const findings = `${found ?? "—"}${unreviewed > 0 ? ` (${unreviewed} unreviewed)` : ""}`;

    let judged = 0;
    let wins = 0;
    let ties = 0;
    // An arm with no diff is not a candidate; counted apart, so a win rate over one ticket reads as one.
    let leftOut = 0;
    for (const score of scores) {
      if (score.judge?.status !== "ok") continue;
      if (!score.judge.order.includes(arm)) {
        if (score.arms.some((entry) => entry.arm === arm)) leftOut++;
        continue;
      }
      judged++;
      if (score.judge.winners.length === 1 && score.judge.winners[0] === arm) wins++;
      else if (score.judge.tie && score.judge.winners.includes(arm)) ties++;
    }
    const judge = `${judged === 0 ? "—" : `${plural(wins, "win", "wins")}, ${plural(ties, "tie", "ties")} / ${judged}`}${leftOut > 0 ? ` (${leftOut} without a diff)` : ""}`;

    const rounds = median(arm === "a"
      ? entries.flatMap((entry) => (entry.human?.rounds != null ? [entry.human.rounds] : []))
      : ran.flatMap((row) => (row.reviewRounds !== null ? [row.reviewRounds] : [])));
    const wall = arm === "a"
      ? median(entries.flatMap((entry) => (entry.human?.openToMergeSeconds != null ? [entry.human.openToMergeSeconds] : [])))
      : median(ran.map((row) => row.wallSeconds));
    const wallCell = wall === null ? "—" : arm === "a" ? duration(wall) : seconds(wall);
    // For the human, opening the PR to its merge is the nearest thing to a
    // claim-to-hand-off the history records, so it is the wall value again.
    const handoff = arm === "a"
      ? wall
      : median(ran.flatMap((row) => (row.handoffSeconds != null ? [row.handoffSeconds] : [])));
    const handoffCell = handoff === null ? "—" : arm === "a" ? duration(handoff) : seconds(handoff);
    const cost = arm === "a" ? "—" : armCost(ran);
    lines.push(`| ${armLabel(arm)} | ${gates} | ${heldOut} | ${findings} | ${judge} | ${rounds ?? "—"} | ${wallCell} | ${handoffCell} | ${cost} |`);
  }
  lines.push("");
  if (arms.includes("a")) {
    lines.push(
      "The human's wall time and claim to hand-off are its PR's open-to-merge time, a different clock from a trial's run time; "
        + "an agent arm's claim to hand-off is the trial's claim to its hand-off, the same clock the live loops' speed ledger uses.",
    );
  }
  const verdicts = scores.flatMap((score) => (score.judge ? [score.judge] : []));
  if (verdicts.length > 0) {
    const judged = verdicts.filter((verdict) => verdict.status === "ok").length;
    lines.push(`Judge: ${judged} of ${verdicts.length} tickets judged; ${verdicts.length - judged} unavailable.`);
  }
  return lines;
}

/** How a case is graded, with a case whose base already passed its held-out tests named as such. */
export const graderLabel = (grade: Pick<CaseGrade, "grader" | "noEvidence">): string =>
  grade.noEvidence ? `${grade.grader} (no evidence)` : grade.grader;

/** An arm's objective total; pending checks are named apart because no runner decides them yet. */
export function objectiveCell(objective: ArmGrades["objective"]): string {
  const pending = objective.pending > 0 ? plural(objective.pending, "check pending", "checks pending") : null;
  if (objective.graded === 0) return pending ?? "—";
  return `${objective.passed}/${objective.graded} cases${pending === null ? "" : `, ${pending}`}`;
}

const judgeValue = (value: number | null): string => (value === null ? "—" : value.toFixed(2));

/** What the Objective and judge scores section says first, in report.md and RESULTS.md alike. */
export const GRADES_INTRO = "Reported side by side and never combined. The objective score counts the cases an objective grader decides (held-out tests the base fails, or an operator check); the judge score is the panel's mean 1–5 over every case it scored.";

/**
 * A test-set run's objective and judge scores (#855), in separate columns
 * and never combined: a blended number would let a diff that only reads well
 * to the judges hide behind a test that passed elsewhere, or the reverse.
 */
function renderGrades(grades: RunGrades | null): string[] {
  if (grades === null) return [];
  const lines = [
    "",
    "## Objective and judge scores",
    "",
    GRADES_INTRO,
    "",
    "| Arm | Objective | Judge |",
    "| --- | --- | --- |",
  ];
  for (const arm of grades.arms) {
    const judge = arm.judge.mean === null ? "—" : `${judgeValue(arm.judge.mean)} over ${plural(arm.judge.cases, "case", "cases")}`;
    lines.push(`| ${armLabel(arm.arm)} | ${objectiveCell(arm.objective)} | ${judge} |`);
  }
  const arms = grades.arms.map((arm) => arm.arm);
  lines.push("", `| Case | Grader | ${arms.map(armLabel).join(" | ")} |`, `| --- | --- | ${arms.map(() => "---").join(" | ")} |`);
  for (const graded of grades.cases) {
    const cells = arms.map((arm) => {
      const entry = graded.arms.find((candidate) => candidate.arm === arm);
      return `${entry?.objective ?? "—"} · judge ${judgeValue(entry?.judge ?? null)}`;
    });
    lines.push(`| ${cell(graded.case)} | ${graderLabel(graded)} | ${cells.join(" | ")} |`);
  }
  return lines;
}

const shortVersion = (version: string): string => version.slice(0, 7);
const signed = (value: number): string => `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
const spreadValue = (value: number | null): string => (value === null ? "—" : value.toFixed(2));
const percent = (share: number): string => `${Math.round(share * 100)}%`;

/**
 * The noise floor (#859), after the scores it qualifies: on the run that
 * measured it, the spread its identical arms showed; on a later set run, each
 * gap against it. Objective and judge stay apart here too.
 */
function renderNoise(report: BacktestReport): string[] {
  if (report.noiseFloor !== undefined) {
    // stampNoise stores no floor from a stopped run, so the page must not show one either.
    if (report.finishedAt === null || report.stoppedBy !== null) return ["", "## Noise floor", "", "This run set out to measure the noise floor but stopped before the end: no floor was stored."];
    const floor = measureFloor(report, report.noiseFloor.measuredAt);
    if (floor === null) return [];
    return [
      "",
      "## Noise floor",
      "",
      `This run measured the noise floor of set ${shortVersion(floor.version)} over ${floor.arms.length} identical arms: what they differ by is noise.`,
      "",
      `- Objective spread: ${spreadValue(floor.spread.objective)} (pass-rate points)`,
      `- Judge spread: ${spreadValue(floor.spread.judge)}`,
    ];
  }
  const noise = report.noise;
  if (noise === undefined) return [];
  const lines = ["", "## Against the noise floor", "", noiseStatusLine(noise)];
  if (noise.gaps.length === 0) return lines;
  lines.push("", "| Arm | vs | Objective gap | Judge gap |", "| --- | --- | --- | --- |");
  for (const gap of noise.gaps) lines.push(`| ${armLabel(gap.arm)} | ${armLabel(gap.vs)} | ${gapCell(gap.objective)} | ${gapCell(gap.judge)} |`);
  return lines;
}

function noiseStatusLine(noise: NoiseReport): string {
  if (noise.state === "missing" || noise.floor === null) return "No noise floor measured — gaps are not judged.";
  const { floor } = noise;
  if (noise.state === "stale") {
    const drift = noise.drift ?? { added: 0, retired: 0, share: 1 };
    return `Floor from ${floor.measuredAt} on ${shortVersion(floor.version)} is stale for this run — this run ran ${drift.added} case(s) it never measured and left out ${drift.retired} it did (${percent(drift.share)} of its cases, over ${percent(noise.staleShare)}).`;
  }
  return `Floor measured ${floor.measuredAt} on ${shortVersion(floor.version)}: objective ±${spreadValue(floor.spread.objective)}, judge ±${spreadValue(floor.spread.judge)}.`;
}

function gapCell(axis: AxisGap): string {
  if (axis.gap === null) return "—";
  const label = axis.verdict === "stale" ? "(floor stale)" : axis.verdict === "no-floor" ? "(no floor)" : axis.verdict ?? "";
  return `${signed(axis.gap)} ${label}`.trim();
}

/**
 * The guardrail verdict (#871), after the gaps it reads: per goal, pass or
 * fail, and every condition with its reason, so a failed verdict says which
 * condition lost it.
 */
function renderGuardrails(report: BacktestReport): string[] {
  const verdict = report.guardrails;
  if (verdict === undefined) return [];
  const lines = ["", "## Guardrails", "", `${armLabel(verdict.proposal)} against the baseline ${armLabel(verdict.baseline)}.`];
  for (const goal of verdict.goals) {
    lines.push("", `### ${goal.goal === "quality" ? "Quality" : "Cost"} goal: ${goal.pass ? "pass" : "fail"}`, "");
    for (const condition of goal.conditions) lines.push(`- ${condition.pass ? "pass" : "fail"} — ${condition.id}: ${condition.reason}`);
  }
  return lines;
}

/**
 * A judge accuracy tally as report lines (#877): overall, then each axis an
 * operator verdict reached, then the contested verdicts set aside. The ledger
 * renders its re-tally through this too, so the two read alike.
 */
export function judgeAccuracyLines(accuracy: JudgeAccuracy): string[] {
  // Every verdict on a contested axis is calibration all the same: "no calibration yet" would deny it.
  const overall = accuracy.overall.total === 0 && accuracy.contested > 0 ? "no verdict counted" : accuracyLabel(accuracy.overall);
  const lines = [`Overall: ${overall}.`];
  // With no verdict counted, one "no calibration yet" says it; a row per empty axis would repeat it.
  if (accuracy.overall.total > 0) {
    lines.push("");
    for (const axis of AXES) {
      const tally = accuracy.axes[axis];
      if (tally !== undefined && tally.total > 0) lines.push(`- ${axis}: ${accuracyLabel(tally)}`);
    }
  }
  if (accuracy.contested > 0) {
    lines.push("", `${accuracy.contested} verdict${accuracy.contested === 1 ? "" : "s"} on an axis the panel contested ${accuracy.contested === 1 ? "is" : "are"} excluded.`);
  }
  return lines;
}

/** How often the panel agreed with the operator's calibration verdicts (#877), after the guardrails. */
function renderJudgeAccuracy(report: BacktestReport): string[] {
  const accuracy = report.judgeAccuracy;
  if (accuracy === undefined) return [];
  return ["", "## Judge accuracy", "", ...judgeAccuracyLines(accuracy)];
}

/** Each ticket's blind verdict, with the shuffled order the judge saw so a reader can check it was blind. */
function renderJudge(scores: TicketScore[]): string[] {
  if (!scores.some((score) => score.judge)) return [];
  const lines = ["", "## Judge", ""];
  for (const score of scores) {
    const verdict = score.judge;
    if (!verdict) continue;
    if (verdict.status === "unavailable") {
      lines.push(`- ${oneLine(score.ticket)}: not judged — ${oneLine(verdict.reason)}`);
      continue;
    }
    const ranking = verdict.ranking.map((tier) => tier.map(armLabel).join(" = ")).join(" > ");
    const shown = verdict.order.map((arm, index) => `${index + 1}: ${armName(arm)}`).join(", ");
    lines.push(`- ${oneLine(score.ticket)}: ${ranking} — ${oneLine(verdict.reason)} (shown as ${shown}; seed ${oneLine(verdict.seed)})`);
  }
  return lines;
}

/** An arm's axis across its trials: the mean of each trial's panel score, and the lowest and highest of them. */
export interface AxisSpread { mean: number; min: number; max: number }

/** Where the first trial's panel ranked an arm: 1-based, out of how many candidates, and whether it shared that place. */
export interface FirstRank { position: number; of: number; tied: boolean }

/** One arm of one repeated case across all its trials (#821). */
export interface RepeatSummary {
  case: string;
  arm: ArmName;
  /** The trials that ran, the first included, and how many of them were green. */
  ran: number;
  green: number;
  /** The trials the panel scored: the ones the axes below are over. */
  judged: number;
  axes: Record<Axis, AxisSpread | null>;
  /** The first trial's verdict, which the ledger keeps: its outcome and where the panel ranked it. */
  first: { outcome: TrialOutcome | null; rank: FirstRank | null };
}

/**
 * A trial's score on each axis: the mean of the judges that scored it. Null
 * where none did (an abstaining panel, an arm left out for having no diff,
 * `review` on a single head).
 */
function trialAxes(score: TicketScore | undefined, arm: ArmName): Record<Axis, number | null> | null {
  const verdicts = (score?.panel?.verdicts ?? []).flatMap((verdict) => (verdict.status === "ok" && verdict.arms[arm] !== undefined ? [verdict.arms[arm]!] : []));
  if (verdicts.length === 0) return null;
  return Object.fromEntries(AXES.map((axis) => {
    const given = verdicts.map((entry) => entry.axes[axis]?.score).filter((value): value is number => typeof value === "number");
    return [axis, given.length === 0 ? null : given.reduce((a, b) => a + b, 0) / given.length];
  })) as Record<Axis, number | null>;
}

function firstRank(score: TicketScore | undefined, arm: ArmName): FirstRank | null {
  const verdict = score?.judge;
  if (verdict?.status !== "ok") return null;
  let position = 1;
  for (const tier of verdict.ranking) {
    if (tier.includes(arm)) return { position, of: verdict.order.length, tied: tier.length > 1 };
    position += tier.length;
  }
  return null;
}

/**
 * Each repeated case's arms across every trial they ran (#821): green runs,
 * and the panel's axis scores as a mean with their spread, beside the first
 * trial's verdict. A case is repeated when its arms disagreed or its panel
 * contested it; the repeats are evidence about the verdict, never a new one.
 */
export function repeatSummaries(report: Pick<BacktestReport, "rows" | "arms" | "scores" | "repeatScores">): RepeatSummary[] {
  const repeated = [...new Set(report.rows.filter((row) => row.repeat !== undefined).map((row) => row.ticket))];
  const arms = armList(report.arms).map((arm) => arm.name);
  return repeated.flatMap((ticket) => arms.map((arm): RepeatSummary => {
    const ran = report.rows.filter((row) => row.ticket === ticket && row.arm === arm && row.outcome !== "not-run");
    const first = report.rows.find((row) => row.ticket === ticket && row.arm === arm && row.repeat === undefined);
    const firstScore = report.scores?.find((score) => score.ticket === ticket);
    const scored = ran.map((row) => trialAxes(row.repeat === undefined
      ? firstScore
      : report.repeatScores?.find((score) => score.ticket === ticket && score.repeat === row.repeat), arm))
      .filter((axes): axes is Record<Axis, number | null> => axes !== null);
    const axes = Object.fromEntries(AXES.map((axis) => {
      const values = scored.map((entry) => entry[axis]).filter((value): value is number => value !== null);
      return [axis, values.length === 0 ? null : { mean: values.reduce((a, b) => a + b, 0) / values.length, min: Math.min(...values), max: Math.max(...values) }];
    })) as Record<Axis, AxisSpread | null>;
    return {
      case: ticket, arm, ran: ran.length, green: ran.filter((row) => row.outcome === "green-pr").length, judged: scored.length, axes,
      first: { outcome: first?.outcome ?? null, rank: firstRank(firstScore, arm) },
    };
  }));
}

const decimal = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1));
const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

/** `3.7 (3–4)`: the mean, then the range it spreads over; a single value or no spread is the value alone. */
export function spreadCell(spread: AxisSpread | null): string {
  if (spread === null) return "—";
  return spread.min === spread.max ? decimal(spread.mean) : `${decimal(spread.mean)} (${decimal(spread.min)}–${decimal(spread.max)})`;
}

export function rankLabel(rank: FirstRank | null): string {
  return rank === null ? "not judged" : `${rank.tied ? "tied " : ""}${ordinal(rank.position)} of ${rank.of}`;
}

/**
 * Each repeated case per arm (#801, #821): green in how many runs, the panel's
 * mean axis scores across them and their spread, and the first trial's
 * verdict, which is the one the ledger and the summary above keep.
 */
function renderRepeats(report: BacktestReport, agentArms: readonly string[]): string[] {
  const summaries = repeatSummaries(report).filter((entry) => agentArms.includes(entry.arm));
  if (summaries.length === 0) return [];
  const lines = [
    "",
    "## Repeats",
    "",
    "The arms disagreed on these cases, or the panel contested them, so each ran again and every run was scored and judged. "
      + "Axis scores are each run's judges' mean, then the mean over the arm's runs with the lowest and highest in brackets. "
      + "The verdict stays the first trial's.",
    "",
    `| Case | Arm | Green | Judged | ${AXES.join(" | ")} | First trial |`,
    `| --- | --- | --- | --- | ${AXES.map(() => "---").join(" | ")} | --- |`,
  ];
  for (const entry of summaries) {
    const first = `${entry.first.outcome ?? "—"}, ${rankLabel(entry.first.rank)}`;
    lines.push(`| ${cell(entry.case)} | ${cell(armName(entry.arm))} | ${entry.ran === 0 ? "—" : `${entry.green}/${entry.ran}`} | ${entry.judged} | ${AXES.map((axis) => spreadCell(entry.axes[axis])).join(" | ")} | ${first} |`);
  }
  return lines;
}

/**
 * Every judge's axis scores per arm, what each arm did better, and the axes
 * two families contested (#801). A contested axis is listed, never averaged:
 * it is where a person should read the diffs.
 */
function renderPanel(scores: TicketScore[]): string[] {
  const panels = scores.filter((score) => score.panel && score.panel.verdicts.some((verdict) => verdict.status === "ok"));
  if (panels.length === 0) return [];
  const lines = ["", "## Panel", "", `Scores are 1–5 per axis: ${AXES.join(", ")}. \`review\` is how the change took review, first head to final; — where it showed one head.`];
  for (const score of panels) {
    const panel = score.panel!;
    lines.push("", `### ${oneLine(score.ticket)}`, "", `| Arm | Judge | ${AXES.join(" | ")} | Did better |`, `| --- | --- | ${AXES.map(() => "---").join(" | ")} | --- |`);
    for (const arm of panel.order) {
      for (const verdict of panel.verdicts) {
        if (verdict.status !== "ok") continue;
        const scored = verdict.arms[arm];
        if (scored === undefined) continue;
        const cells = AXES.map((axis) => {
          const flagged = panel.contested.some((entry) => entry.axis === axis && entry.arms.includes(arm));
          return `${scored.axes[axis].score ?? "—"}${flagged ? " ⚑" : ""}`;
        });
        lines.push(`| ${armLabel(arm)} | ${cell(verdict.judge.name)} | ${cells.join(" | ")} | ${cell(scored.better)} |`);
      }
    }
    for (const verdict of panel.verdicts) {
      if (verdict.status === "unavailable") lines.push("", `- ${cell(verdict.judge.name)} abstained: ${oneLine(verdict.reason)}`);
    }
    // scores.json written before #818 carries no rule; inversion was the only one then.
    const rule = contestedRuleLabel(panel.rule ?? { kind: "inversion" });
    // Named even when nothing is contested: a quiet spread run must not read as an inversion one.
    if (panel.contested.length === 0) lines.push("", `Nothing contested by ${rule}.`);
    else {
      lines.push("", `Contested (⚑) by ${rule}, so read the diffs:`, "");
      // Two arms under inversion, one under spread.
      for (const entry of panel.contested) lines.push(`- ${entry.axis}: ${entry.arms.map((arm) => armLabel(arm)).join(" vs ")} (${entry.judges.map(cell).join(", ")})`);
    }
  }
  return lines;
}

/** Each ticket's gates that were already red on its merge base, and the tests that failed there. */
function renderBaseRed(scores: TicketScore[]): string[] {
  const entries = scores.flatMap((score) => {
    const gates = Object.entries(score.baseRed?.gates ?? {}).filter(([, gate]) => gate.conclusion === "FAILURE");
    return gates.map(([name, gate]) => {
      const why = gate.failures.length === 0
        ? "failing on the merge base, no test named"
        : `${testCount(gate.failures.length)} already failing on the merge base: ${listed(gate.failures)}`;
      return `- ${oneLine(score.ticket)}: ${oneLine(name)} — ${why}`;
    });
  });
  if (entries.length === 0) return [];
  return [
    "",
    "### Base-red gates",
    "",
    ...entries,
    "",
    "A gate whose only failures are base-red counts as passing for every arm, the human's included.",
  ];
}

/** A finding's text is the reviewer's whole paragraph; the report keeps enough to tell what it is about. */
const FINDING_TEXT_CHARS = 300;

function renderScoring(scores: TicketScore[], rows: TrialRow[], agentArms: readonly string[]): string[] {
  const lines = [
    "",
    "## Scoring",
    "",
    "| Ticket | Arm | Held-out | Gates | Review first | Review final | Open-to-merge | Rounds |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const score of scores) {
    for (const arm of score.arms) {
      const gates = gatesCell(arm.gates);
      const time = arm.human?.openToMergeSeconds != null ? duration(arm.human.openToMergeSeconds) : "—";
      const rounds = arm.arm === "a"
        ? arm.human?.rounds ?? null
        : rows.find((row) => row.ticket === score.ticket && row.arm === arm.arm)?.reviewRounds ?? null;
      lines.push(`| ${cell(score.ticket)} | ${armLabel(arm.arm)} | ${heldOutCell(arm.heldOut)} | ${gates} | ${reviewCell(arm.review?.first)} | ${reviewCell(arm.review?.final)} | ${time} | ${rounds ?? "—"} |`);
    }
  }
  lines.push("");
  for (const arm of agentArms) {
    const evidence = heldOutEvidence(scores, arm);
    if (evidence === null) continue;
    lines.push(`- Arm ${armLabel(arm)} held-out: ${evidence} evidence files pass`);
  }
  lines.push(...renderBaseRed(scores));

  const findings: string[] = [];
  for (const score of scores) {
    for (const arm of score.arms) {
      for (const which of ["first", "final"] as const) {
        const review = arm.review?.[which];
        if (review?.status !== "ok" || review.findings.length === 0) continue;
        findings.push("", `${cell(score.ticket)} ${armLabel(arm.arm)}, ${which} head:`, "");
        for (const finding of review.findings) {
          findings.push(`- [${finding.priority}] ${oneLine(finding.path)}${finding.line === null ? "" : `:${finding.line}`} — ${oneLine(finding.title)}`);
          const text = oneLine(finding.text);
          if (text !== "") findings.push(`  ${text.length > FINDING_TEXT_CHARS ? `${text.slice(0, FINDING_TEXT_CHARS).trimEnd()}…` : text}`);
        }
        for (const shot of review.screenshots) findings.push(`- screenshot: ${oneLine(shot)}`);
      }
    }
  }
  if (findings.length > 0) lines.push("", "### Findings", ...findings);

  const notes = scores.flatMap((score) => score.arms.flatMap((arm) => arm.notes.map((note) => `- ${oneLine(score.ticket)} ${armLabel(arm.arm)}: ${oneLine(note)}`)));
  if (notes.length > 0) lines.push("", "### Scoring notes", "", ...notes);
  return lines;
}
