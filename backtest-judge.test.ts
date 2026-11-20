import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { BacktestTicket } from "./backtest";
import {
  claudeJudge, judgePrompt, judgeTicket, MAX_DIFF_CHARS, parseJudgeAnswer, shuffleArms, type ArmId, type JudgeCall,
} from "./backtest-judge";
import { scratchDir } from "./test-scratch";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("a stub claude written as a sh script");

const ticket = (oaKey = "OA-7"): BacktestTicket => ({
  oaKey, intakeKey: null, movedAt: "2026-10-01T00:00:00Z", repo: "org/app", humanPrs: [], mergeBase: "abc",
  startedAt: "2026-10-02T00:00:00Z", ticketRef: oaKey, comments: { kept: 1, dropped: 0 },
  frozen: {
    title: "Export button drops the last row",
    body: "The CSV export misses the final record.",
    comments: [{ author: "felipe", createdAt: "2026-10-01T10:00:00Z", body: "Repro on any table with 3 rows." }],
  },
});

const diffs: { arm: ArmId; diff: string }[] = [
  { arm: "a", diff: "diff --git a/x.ts b/x.ts\n-old human\n+DIFF-A" },
  { arm: "b", diff: "diff --git a/y.ts b/y.ts\n+DIFF-B" },
  { arm: "c", diff: "diff --git a/z.ts b/z.ts\n+DIFF-C" },
];

// A judge that always names whatever it was shown first as the best.
const firstWins = (calls: string[]): JudgeCall => async (prompt) => {
  calls.push(prompt);
  return { ok: true, text: "{\"ranking\": [[\"1\"], [\"2\", \"3\"]], \"reason\": \"first is best\"}" };
};

describe("shuffleArms", () => {
  it("is fixed by seed and ticket, and moves with the seed", () => {
    const arms = ["a", "b", "c"];
    expect(shuffleArms(arms, "run-1", "OA-7")).toEqual(shuffleArms(arms, "run-1", "OA-7"));
    expect([...shuffleArms(arms, "run-1", "OA-7")].sort()).toEqual(arms);
    const orders = new Set(Array.from({ length: 20 }, (_, i) => shuffleArms(arms, `seed-${i}`, "OA-7").join("")));
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe("judgeTicket", () => {
  it("records the seeded shuffle and maps the first candidate back to the arm shown first", async () => {
    // Two seeds that show a different arm first, so a fixed "Candidate 1" answer must win for different arms.
    const seeds = Array.from({ length: 50 }, (_, i) => `seed-${i}`);
    const firstShown = (seed: string) => shuffleArms(diffs, seed, "OA-7")[0]!.arm;
    const one = seeds[0]!;
    const other = seeds.find((seed) => firstShown(seed) !== firstShown(one))!;
    expect(other).toBeDefined();

    for (const seed of [one, other]) {
      const calls: string[] = [];
      const result = await judgeTicket({ ticket: ticket(), diffs, seed, call: firstWins(calls) });
      const order = shuffleArms(diffs, seed, "OA-7").map((d) => d.arm);
      expect(result).toMatchObject({ status: "ok", seed, order, winners: [order[0]], tie: false, reason: "first is best" });
      if (result.status !== "ok") throw new Error("unreachable");
      expect(result.ranking).toEqual([[order[0]], [order[1], order[2]]]);
      // Candidate 1 in the prompt is the winning arm's diff.
      const shownFirst = diffs.find((d) => d.arm === order[0])!.diff;
      expect(calls[0]!.indexOf(shownFirst)).toBeGreaterThan(-1);
      expect(calls[0]!.indexOf(shownFirst)).toBeLessThan(calls[0]!.indexOf("## Candidate 2"));
      // Same seed, same order.
      const again = await judgeTicket({ ticket: ticket(), diffs, seed, call: firstWins([]) });
      expect(again.order).toEqual(order);
    }
  });

  it("maps wins back when the arms come in reversed", async () => {
    const two = diffs.slice(0, 2);
    const call: JudgeCall = async () => ({ ok: true, text: "{\"ranking\": [[\"1\"], [\"2\"]], \"reason\": \"first\"}" });
    const forward = await judgeTicket({ ticket: ticket(), diffs: two, seed: "s", call });
    const reversed = await judgeTicket({ ticket: ticket(), diffs: [...two].reverse(), seed: "s", call });
    for (const result of [forward, reversed]) {
      if (result.status !== "ok") throw new Error(`judge unavailable: ${result.reason}`);
      expect(result.winners).toEqual([result.order[0]]);
    }
    // The same seed shuffles positions, so reversed input shows the other arm first.
    expect(forward.order).toEqual([...reversed.order].reverse());
    expect(forward.status === "ok" && reversed.status === "ok" && forward.winners[0] !== reversed.winners[0]).toBe(true);
  });

  it("reports a tied top tier with both arms", async () => {
    const call: JudgeCall = async () => ({ ok: true, text: "{\"ranking\": [[\"1\", \"2\"]], \"reason\": \"equal\"}" });
    const result = await judgeTicket({ ticket: ticket(), diffs: diffs.slice(1), seed: "s", call });
    expect(result).toMatchObject({ status: "ok", tie: true });
    if (result.status !== "ok") throw new Error("unreachable");
    expect([...result.winners].sort()).toEqual(["b", "c"]);
  });

  it("is unavailable without calling when fewer than two arms have a diff", async () => {
    const calls: string[] = [];
    const result = await judgeTicket({ ticket: ticket(), diffs: [diffs[0]!, { arm: "b", diff: "  \n" }], seed: "s", call: firstWins(calls) });
    expect(result).toMatchObject({ status: "unavailable", order: ["a"] });
    expect(calls).toEqual([]);
  });

  it("is unavailable when the call fails, throws or answers nonsense", async () => {
    const failing: JudgeCall = async () => ({ ok: false, reason: "judge timed out after 600s" });
    expect(await judgeTicket({ ticket: ticket(), diffs, seed: "s", call: failing }))
      .toMatchObject({ status: "unavailable", reason: "judge timed out after 600s" });
    const throwing: JudgeCall = async () => { throw new Error("boom"); };
    expect(await judgeTicket({ ticket: ticket(), diffs, seed: "s", call: throwing }))
      .toMatchObject({ status: "unavailable", reason: "judge call threw: boom" });
    const prose: JudgeCall = async () => ({ ok: true, text: "They are all fine." });
    expect(await judgeTicket({ ticket: ticket(), diffs, seed: "s", call: prose })).toMatchObject({ status: "unavailable" });
  });
});

describe("judgePrompt", () => {
  it("carries the ticket and every diff, and nothing about origin", async () => {
    const calls: string[] = [];
    await judgeTicket({ ticket: ticket(), diffs, seed: "s", call: firstWins(calls) });
    const prompt = calls[0]!;
    expect(prompt).toContain("Export button drops the last row");
    expect(prompt).toContain("Repro on any table with 3 rows.");
    for (const { diff } of diffs) expect(prompt).toContain(diff);
    // "human" here would only come from the diff text itself, which the judge must see as written.
    const withoutDiffs = diffs.reduce((text, { diff }) => text.replace(diff, ""), prompt);
    expect(withoutDiffs).not.toMatch(/human|lineup|\barm\b|\barms\b|\bArm [abc]\b|felipe/i);
    expect(withoutDiffs).toContain("Candidate 1");
    expect(withoutDiffs).toContain("Candidate 3");
  });

  it("says when a diff was cut", () => {
    const prompt = judgePrompt(ticket().frozen, [{ label: "1", diff: "x".repeat(MAX_DIFF_CHARS + 1) }, { label: "2", diff: "y" }]);
    expect(prompt).toContain("truncated");
    expect(prompt).not.toContain("x".repeat(MAX_DIFF_CHARS + 1));
  });

  it("fences a diff longer than any backtick run inside it", () => {
    const diff = "diff --git a/README.md b/README.md\n+````sh\n+run\n+````";
    const prompt = judgePrompt(ticket().frozen, [{ label: "1", diff }, { label: "2", diff: "y" }]);
    expect(prompt).toContain(`\`\`\`\`\`diff\n${diff}\n\`\`\`\`\``);
    expect(prompt).toContain("```diff\ny\n```");
  });
});

describe("parseJudgeAnswer", () => {
  const labels = ["1", "2", "3"];
  it("reads fenced JSON with prose around it", () => {
    const text = "Here is my ranking.\n```json\n{\"ranking\": [[\"3\"], [\"1\", \"2\"]], \"reason\": \"3 fixes it\"}\n```\nDone.";
    expect(parseJudgeAnswer(text, labels)).toEqual({ ok: true, ranking: [["3"], ["1", "2"]], reason: "3 fixes it" });
  });
  it.each([
    ["{\"ranking\": [[\"1\"], [\"1\", \"2\", \"3\"]]}", "twice"],
    ["{\"ranking\": [[\"1\"], [\"2\"]]}", "leaves out candidate 3"],
    ["{\"ranking\": [[\"1\"], [\"2\", \"3\", \"4\"]]}", "unknown candidate 4"],
    ["no json here", "no JSON object"],
  ])("refuses %s", (text, reason) => {
    const parsed = parseJudgeAnswer(text, labels);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain(reason);
  });
});

describe("claudeJudge", () => {
  // A stub claude in a fresh dir; `body` is the sh that runs after it records argv, stdin and env.
  const stub = (body: string) => {
    const dir = scratchDir("backtest-judge-");
    const bin = join(dir, "claude");
    writeFileSync(bin, `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg"; done > "${dir}/argv"
cat > "${dir}/stdin"
env > "${dir}/env"
touch "${dir}/started"
${body}
`);
    chmodSync(bin, 0o755);
    const judge = (timeoutMs: number, signal?: AbortSignal) => claudeJudge({
      model: "claude-test-model", cwd: dir, logPath: join(dir, "logs", "judge.log"), timeoutMs, signal,
      env: { ...process.env, RALPH_CLAUDE_BIN: bin, GH_TOKEN: "gh-secret", GITHUB_TOKEN: "github-secret" },
    });
    return { dir, judge };
  };

  it("runs claude isolated, with the prompt on stdin, and returns the result text", async () => {
    const answer = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "{\"ranking\":[[\"1\"]],\"reason\":\"x\"}" });
    const { dir, judge } = stub(`printf '%s' '${answer}'`);
    const result = await judge(60_000)("PROMPT-BODY\nsecond line");
    expect(result).toEqual({ ok: true, text: "{\"ranking\":[[\"1\"]],\"reason\":\"x\"}" });
    const argv = readFileSync(join(dir, "argv"), "utf8").split("\n");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-test-model");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(readFileSync(join(dir, "stdin"), "utf8")).toBe("PROMPT-BODY\nsecond line");
    const env = readFileSync(join(dir, "env"), "utf8");
    expect(env).not.toMatch(/^GH_TOKEN=/m);
    expect(env).not.toMatch(/^GITHUB_TOKEN=/m);
  });

  it("is unavailable on a non-zero exit", async () => {
    const { judge } = stub("exit 3");
    expect(await judge(60_000)("p")).toEqual({ ok: false, reason: "judge run failed: exit 3" });
  });

  it("says the judge's output, not a review's, was unreadable", async () => {
    const { judge } = stub("echo not json");
    const result = await judge(60_000)("p");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/^judge output unreadable: /);
  });

  it("kills a run past its timeout", async () => {
    const { judge } = stub("sleep 30");
    const started = Date.now();
    const result = await judge(300)("p");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("kills a run when aborted", async () => {
    const { dir, judge } = stub("sleep 30");
    const controller = new AbortController();
    const started = Date.now();
    const pending = judge(60_000, controller.signal)("p");
    // Abort only once the stub is really running, so the kill reaches a live child.
    const poll = setInterval(() => {
      if (existsSync(join(dir, "started"))) {
        clearInterval(poll);
        controller.abort();
      }
    }, 20);
    const result = await pending;
    clearInterval(poll);
    expect(result).toEqual({ ok: false, reason: "judge aborted" });
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});
