import { describe, expect, it } from "vitest";

import type { BacktestTicket } from "./backtest";
import type { JudgeCall } from "./backtest-judge";
import { AXES, aggregateRanking, contestedAxes, contestedRuleLabel, JUDGE_INSTRUCTIONS, judgePanel, panelPrompt, parsePanelAnswer, type Axis, type JudgeSpec, type JudgeVerdict } from "./eval-panel";

const ticket: BacktestTicket = {
  oaKey: "OA-7", intakeKey: null, movedAt: "2026-10-01T00:00:00Z", repo: "acme/app", humanPrs: [], mergeBase: "base",
  startedAt: "2026-10-02T00:00:00Z", ticketRef: "OA-7", comments: { kept: 0, dropped: 0 },
  frozen: { title: "Fix the button", body: "It stays disabled.", comments: [] },
};

const claude: JudgeSpec = { name: "opus", runner: "claude", model: "claude-opus-5-5" };
const codex: JudgeSpec = { name: "gpt", runner: "codex", model: "gpt-6-luna" };

const axes = (score: number, review: number | null = score) =>
  Object.fromEntries(AXES.map((axis) => [axis, { score: axis === "review" ? review : score, evidence: `${axis} evidence` }])) as Record<Axis, { score: number | null; evidence: string }>;

/** A judge that answers from the labels it was shown, in the prompt's own order: `scores[i]` for candidate i+1. */
function answering(scores: number[], ranking: number[][] = scores.map((_, i) => [i + 1])): { call: JudgeCall; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    call: async (prompt) => {
      prompts.push(prompt);
      const candidates = Object.fromEntries(scores.map((score, i) => [String(i + 1), { axes: axes(score), better: `candidate ${i + 1} is tidy` }]));
      return { ok: true, text: JSON.stringify({ candidates, ranking: ranking.map((tier) => tier.map(String)), reason: "because" }) };
    },
  };
}

const candidates = [
  { arm: "a", first: null, final: "diff --git a/x b/x\n+HUMAN" },
  { arm: "opus", first: "diff --git a/x b/x\n+FIRST", final: "diff --git a/x b/x\n+OPUS" },
];

describe("panelPrompt", () => {
  it("shows each candidate's first head only when it differs from the final, and names every axis", () => {
    const prompt = panelPrompt(ticket.frozen, [
      { label: "1", first: "diff\n+same", final: "diff\n+same" },
      { label: "2", first: "diff\n+early", final: "diff\n+late" },
    ]);
    expect(prompt.match(/### First head/g)).toHaveLength(1);
    expect(prompt).toContain("+early");
    for (const axis of AXES) expect(prompt).toContain(`\`${axis}\``);
    expect(prompt).not.toMatch(/human|lineup|overlay|opus|\barm\b/i);
  });

  it("opens with today's instructions by default, byte for byte (#878)", () => {
    const today = [
      "You are one judge on a panel comparing candidate changes for one ticket. Read the ticket, then each",
      "candidate's diffs: its final head, and its first head where it shows one. Judge only the diffs;",
      "the order they are listed in means nothing, and nothing tells you who or what wrote them.",
    ].join("\n");
    expect(JUDGE_INSTRUCTIONS).toBe(today);
    const shown = [{ label: "1", first: null, final: "diff\n+x" }, { label: "2", first: null, final: "diff\n+y" }];
    expect(panelPrompt(ticket.frozen, shown)).toBe(panelPrompt(ticket.frozen, shown, today));
    expect(panelPrompt(ticket.frozen, shown).startsWith(`${today}\n\n# Ticket\n`)).toBe(true);
  });

  it("replaces only the opening instructions with an override, keeping every other section (#878)", () => {
    const shown = [{ label: "1", first: null, final: "diff\n+x" }, { label: "2", first: null, final: "diff\n+y" }];
    const prompt = panelPrompt(ticket.frozen, shown, "Judge strictly.");
    expect(prompt.startsWith("Judge strictly.\n\n# Ticket\n")).toBe(true);
    expect(prompt).not.toContain("You are one judge on a panel");
    expect(prompt.slice("Judge strictly.".length)).toBe(panelPrompt(ticket.frozen, shown).slice(JUDGE_INSTRUCTIONS.length));
  });
});

describe("parsePanelAnswer", () => {
  const good = { candidates: { 1: { axes: axes(4), better: "b" }, 2: { axes: axes(2, null), better: "c" } }, ranking: [["1"], ["2"]], reason: "r" };
  it("reads scores, evidence, better and ranking", () => {
    const parsed = parsePanelAnswer(`Here:\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``, ["1", "2"]);
    expect(parsed).toMatchObject({ ok: true, ranking: [["1"], ["2"]], reason: "r" });
    if (parsed.ok) expect(parsed.candidates["2"]!.axes.review).toEqual({ score: null, evidence: "review evidence" });
  });
  it.each([
    [{ ...good, ranking: [["1"]] }, "leaves out candidate 2"],
    [{ ...good, ranking: [["1", "1"], ["2"]] }, "names candidate 1 twice"],
    [{ ...good, candidates: { 1: good.candidates[1] } }, "candidate 2 has no axis scores"],
    [{ ...good, candidates: { ...good.candidates, 1: { axes: { ...axes(4), scope: { score: 9 } } } } }, "candidate 1's scope score is not 1–5"],
    [{ ...good, candidates: { ...good.candidates, 1: { axes: { ...axes(4), tests: { score: null } } } } }, "candidate 1's tests score is not 1–5"],
  ])("refuses an incomplete answer: %#", (answer, why) => {
    expect(parsePanelAnswer(JSON.stringify(answer), ["1", "2"])).toEqual({ ok: false, reason: expect.stringContaining(why) });
  });
});

describe("contestedAxes", () => {
  const verdict = (judge: JudgeSpec, scores: Record<string, Partial<Record<Axis, number>>>): JudgeVerdict => ({
    judge, status: "ok", ranking: [Object.keys(scores)], reason: "",
    arms: Object.fromEntries(Object.entries(scores).map(([arm, given]) => [arm, { axes: Object.fromEntries(AXES.map((axis) => [axis, { score: given[axis] ?? 3, evidence: "" }])) as Record<Axis, { score: number | null; evidence: string }>, better: "" }])),
  });

  it("flags an axis two families order a pair oppositely, and nothing they agree on", () => {
    const contested = contestedAxes([
      verdict(claude, { a: { scope: 5, tests: 4 }, b: { scope: 2, tests: 2 } }),
      verdict(codex, { a: { scope: 1, tests: 5 }, b: { scope: 4, tests: 1 } }),
    ], ["a", "b"]);
    expect(contested).toEqual([{ axis: "scope", arms: ["a", "b"], judges: ["opus", "gpt"] }]);
  });

  it("never contests within one family, and ignores a judge that abstained", () => {
    const other: JudgeSpec = { name: "sonnet", runner: "claude", model: "claude-sonnet-5-5" };
    expect(contestedAxes([
      verdict(claude, { a: { scope: 5 }, b: { scope: 1 } }),
      verdict(other, { a: { scope: 1 }, b: { scope: 5 } }),
      { judge: codex, status: "unavailable", reason: "timed out" },
    ], ["a", "b"])).toEqual([]);
  });

  it("under spread 2, flags an arm two families score 5 and 3, not 4 and 3 (#818)", () => {
    const spread = { kind: "spread", points: 2 } as const;
    expect(contestedAxes([
      verdict(claude, { a: { scope: 5, tests: 4 }, b: {} }),
      verdict(codex, { a: { scope: 3, tests: 3 }, b: {} }),
    ], ["a", "b"], spread)).toEqual([{ axis: "scope", arms: ["a"], judges: ["opus", "gpt"] }]);
  });

  it("under spread, takes a family's mean over its judges and contests nothing with one family (#818)", () => {
    const spread = { kind: "spread", points: 2 } as const;
    const sonnet: JudgeSpec = { name: "sonnet", runner: "claude", model: "claude-sonnet-5-5" };
    expect(contestedAxes([verdict(claude, { a: { scope: 5 } }), verdict(sonnet, { a: { scope: 1 } })], ["a"], spread)).toEqual([]);
    // Claude's mean is (5 + 3) / 2 = 4, one point from Codex's 3.
    expect(contestedAxes([verdict(claude, { a: { scope: 5 } }), verdict(sonnet, { a: { scope: 3 } }), verdict(codex, { a: { scope: 3 } })], ["a"], spread)).toEqual([]);
  });

  it("under spread, counts an exact spread between three-judge means despite float rounding (#818)", () => {
    const spread = { kind: "spread", points: 2 } as const;
    const sonnet: JudgeSpec = { name: "sonnet", runner: "claude", model: "claude-sonnet-5-5" };
    const haiku: JudgeSpec = { name: "haiku", runner: "claude", model: "claude-haiku-5-5" };
    const mini: JudgeSpec = { name: "mini", runner: "codex", model: "gpt-mini" };
    const nano: JudgeSpec = { name: "nano", runner: "codex", model: "gpt-nano" };
    // 13/3 - 7/3 is 1.9999999999999996 in floating point; the spread is exactly 2.
    expect(contestedAxes([
      verdict(claude, { a: { scope: 5 } }), verdict(sonnet, { a: { scope: 4 } }), verdict(haiku, { a: { scope: 4 } }),
      verdict(codex, { a: { scope: 3 } }), verdict(mini, { a: { scope: 2 } }), verdict(nano, { a: { scope: 2 } }),
    ], ["a"], spread).map((entry) => entry.axis)).toEqual(["scope"]);
  });

  it("labels each rule in words (#818)", () => {
    expect(contestedRuleLabel({ kind: "inversion" })).toBe("ranking inversion between judge families");
    expect(contestedRuleLabel({ kind: "spread", points: 1.5 })).toBe("a spread of 1.5+ points between judge families' mean scores");
  });
});

describe("aggregateRanking", () => {
  it("ranks arms by their mean place across judges, and ties equal means", () => {
    const v = (ranking: string[][]): JudgeVerdict => ({ judge: claude, status: "ok", ranking, arms: {}, reason: "r" });
    expect(aggregateRanking([v([["a"], ["b"]]), v([["b"], ["a"]])], "s", ["a", "b"])).toMatchObject({ ranking: [["a", "b"]], tie: true });
    expect(aggregateRanking([v([["a"], ["b"], ["c"]]), v([["a"], ["c"], ["b"]])], "s", ["a", "b", "c"])).toMatchObject({ ranking: [["a"], ["b", "c"]], winners: ["a"], tie: false });
  });
  it("is unavailable, with every judge's reason, when none answered", () => {
    expect(aggregateRanking([{ judge: claude, status: "unavailable", reason: "exit 1" }], "s", ["a"]))
      .toEqual({ status: "unavailable", seed: "s", order: ["a"], reason: "opus: exit 1" });
  });
});

describe("judgePanel", () => {
  it("asks every judge the same blind prompt and maps labels back to arms after the calls", async () => {
    const one = answering([5, 2]);
    const two = answering([4, 3]);
    const panel = await judgePanel({ ticket, candidates, seed: "seed-1", judges: [{ spec: claude, call: one.call }, { spec: codex, call: two.call }] });
    expect(one.prompts).toEqual(two.prompts);
    expect(one.prompts[0]).not.toContain("opus");
    expect(panel.verdicts.map((verdict) => verdict.status)).toEqual(["ok", "ok"]);
    // Whatever the shuffle, the first-shown arm got 5 from judge one.
    const first = panel.order[0]!;
    const verdict = panel.verdicts[0]!;
    if (verdict.status === "ok") expect(verdict.arms[first]!.axes.correctness.score).toBe(5);
    expect(panel.aggregate).toMatchObject({ status: "ok", winners: [first] });
    expect(panel.contested).toEqual([]);
  });

  it("asks every judge with the instructions it is given (#878)", async () => {
    const one = answering([5, 2]);
    await judgePanel({ ticket, candidates, seed: "seed-1", judges: [{ spec: claude, call: one.call }], instructions: "Judge strictly." });
    expect(one.prompts[0]!.startsWith("Judge strictly.\n\n# Ticket\n")).toBe(true);
  });

  it("records a malformed answer as that judge abstaining, and still answers with the rest", async () => {
    const good = answering([5, 2]);
    const panel = await judgePanel({
      ticket, candidates, seed: "s",
      judges: [{ spec: claude, call: good.call }, { spec: codex, call: async () => ({ ok: true, text: "I prefer the first one." }) }],
    });
    expect(panel.verdicts[1]).toEqual({ judge: codex, status: "unavailable", reason: "answered with no JSON object" });
    expect(panel.aggregate.status).toBe("ok");
  });

  it("calls no judge when fewer than two candidates have a diff", async () => {
    const judge = answering([5]);
    const panel = await judgePanel({ ticket, candidates: [candidates[0]!, { arm: "opus", first: null, final: "  " }], seed: "s", judges: [{ spec: claude, call: judge.call }] });
    expect(judge.prompts).toEqual([]);
    expect(panel.aggregate).toMatchObject({ status: "unavailable", reason: "fewer than two arms produced a diff" });
    expect(panel.rule).toEqual({ kind: "inversion" });
  });

  it("records the contested rule it used, inversion when none is given (#818)", async () => {
    const judges = () => [{ spec: claude, call: answering([5, 2]).call }, { spec: codex, call: answering([3, 2]).call }];
    expect((await judgePanel({ ticket, candidates, seed: "s", judges: judges() })).rule).toEqual({ kind: "inversion" });
    const spread = await judgePanel({ ticket, candidates, seed: "s", judges: judges(), contested: { kind: "spread", points: 2 } });
    expect(spread.rule).toEqual({ kind: "spread", points: 2 });
    // The first-shown arm got 5 from Claude and 3 from Codex on every axis; the other got 2 from both.
    expect(spread.contested.map((c) => c.arms)).toEqual(AXES.map(() => [spread.order[0]!]));
  });
});
