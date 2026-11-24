// @vitest-environment node
/**
 * A fresh session is only cheaper if it starts small and still knows the
 * rules. These pin both: the build sections are gone, the shipping sections
 * are the real `prompt.md` text, and the preamble says what to do next.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { phaseSections } from "./phase-prompt";
import { budgetPreamble, main, nextStep } from "./ship-prompt";
import { roleDescriptor } from "./roles";
import { scratchDir } from "./test-scratch";

const PROMPT = readFileSync(join(import.meta.dirname, "prompt.md"), "utf8");

describe("the sections a fresh session gets", () => {
  it("drops §0–§3 and keeps every other section of the real prompt verbatim", () => {
    const kept = phaseSections(PROMPT, "finish");
    for (const gone of ["## 0. Orient", "## 1. Take one task", "## 2. Claim", "## 3. Implement"]) {
      expect(kept).not.toContain(gone);
    }
    for (const kept_ of ["## Who you are", "## Model routing", "## Token reporting", "## 4. Verify", "## 5. Review gate", "## HARD RAIL", "## 6. Journal and stop"]) {
      expect(kept).toContain(kept_);
    }
    expect(kept.length).toBeLessThan(PROMPT.length * 0.75);
  });

  it("keeps a heading it does not know", () => {
    expect(phaseSections("# T\n## 3. Implement\nx\n## Project notes\ny\n", "finish")).toBe("# T\n## Project notes\ny\n");
  });
});

describe("the phase a fresh session is in", () => {
  it("tells a PR session it is past every boundary, and a budget handoff never to yield", async () => {
    const dir = scratchDir("ship-prompt-phase-");
    const wait = join(dir, "wait.json");
    writeFileSync(wait, JSON.stringify({ outcome: "green", pr: "7" }));
    const ship = await main(["ship", "--wait", wait, "--round", "1", "--max-rounds", "6", "--handoff", "h.md", "--iteration", "1"], PROMPT);
    expect(ship.out).toContain("This session is the `finish` phase");
    expect(ship.out).toContain("never end with `<ralph>PHASE …</ralph>`");
    expect(budgetPreamble({ used: 1, limit: 1, strike: 1, strikes: 2, issue: null, handoff: "h", iteration: "1" })).toContain(
      "Never `AWAIT_PR` or `PHASE` from here.",
    );
  });
});

describe("what the preamble says to do", () => {
  it.each([
    ["green", "AWAIT_PR 7 merge"],
    ["red", "second red"],
    ["merged", "§5.7"],
    ["dequeued", "**dequeued**"],
    ["rounds-exhausted", "Do not end with AWAIT_PR"],
    ["timeout", "hand off"],
  ])("%s → mentions %s", (outcome, phrase) => {
    expect(nextStep({ outcome, pr: "7" }, 1, 4)).toContain(phrase);
  });

  it("hands a re-queued PR back as the merge wait", () => {
    expect(nextStep({ outcome: "dequeued", pr: "7" }, 1, 4)).toContain("`<ralph>AWAIT_PR 7 merge</ralph>`");
  });

  it("sends a dequeue caused by an outage to RETRY_LATER rather than a requeue", () => {
    expect(nextStep({ outcome: "dequeued", pr: "7" }, 1, 4)).toContain("<ralph>RETRY_LATER</ralph>");
  });

  it("stops offering another wait once the rounds are used", () => {
    expect(nextStep({ outcome: "red", pr: "7" }, 1, 4)).toContain("AWAIT_PR 7 ci");
    expect(nextStep({ outcome: "red", pr: "7" }, 4, 4)).not.toContain("AWAIT_PR 7 ci");
  });

  it("makes the second budget strike the blocked exit", () => {
    const base = { used: 130e6, limit: 120e6, issue: "1121", handoff: "h.md", iteration: "3", strikes: 2 };
    expect(budgetPreamble({ ...base, strike: 1 })).toContain("leave the `-wip` claim in place");
    expect(budgetPreamble({ ...base, strike: 2 })).toContain("stuck path");
    expect(budgetPreamble({ ...base, strike: 1 })).toContain("130M tokens against a cap of 120M");
  });
});

describe("the command", () => {
  it("renders a ship prompt with the wait's evidence and earlier rounds", async () => {
    const dir = scratchDir("ralph-ship-");
    const wait = join(dir, "wait.json");
    const history = join(dir, "history.jsonl");
    writeFileSync(
      wait,
      JSON.stringify({
        outcome: "red",
        mode: "ci",
        pr: "1194",
        head: "0123456789abcdef",
        checks: [{ name: "buildkite/loggd", state: "fail", url: "https://buildkite.com/b/1840" }],
        detail: "failed: buildkite/loggd",
      }),
    );
    writeFileSync(history, `${JSON.stringify({ outcome: "red", mode: "ci", head: "fedcba9876543210" })}\n`);
    const { code, out } = await main(
      ["ship", "--wait", wait, "--history", history, "--round", "2", "--max-rounds", "4", "--handoff", ".ralph/logs/handoff-1121.md", "--iteration", "12"],
      PROMPT,
    );
    expect(code).toBe(0);
    expect(out).toContain("PR #1194");
    expect(out).toContain("buildkite/loggd: fail — https://buildkite.com/b/1840");
    expect(out).toContain("1. ci → red on fedcba987654");
    expect(out).toContain(".ralph/logs/handoff-1121.md");
    expect(out).toContain("## 6. Journal and stop");
    expect(out).not.toContain("## 0. Orient");
  });

  it("treats a missing or broken wait result as unreadable rather than failing", async () => {
    const { code, out } = await main(["ship", "--wait", "/nonexistent", "--handoff", "h.md"], PROMPT);
    expect(code).toBe(0);
    expect(out).toContain("Outcome: **unreadable**");
  });

  it("refuses an empty prompt or an unknown mode", async () => {
    expect((await main(["ship", "--wait", "w", "--handoff", "h"], "")).code).toBe(64);
    expect((await main(["later", "--handoff", "h"], PROMPT)).code).toBe(64);
  });
});

describe("a pr-medic's recovery turns", () => {
  // felipearos/ralph#248: the medic's pull request is the operator's. Every
  // session that picks its iteration up — after the CI wait, after the token
  // cap, after a missing sigil — must send it to the medic prompt's handover
  // or blocked path, and never to the coder's mergeability check and enqueue.
  const MEDIC = readFileSync(join(import.meta.dirname, "prompts", "pr-medic.md"), "utf8");
  const OUTCOMES = ["green", "red", "no-checks", "head-mismatch", "merged", "closed", "dequeued", "rounds-exhausted", "timeout", "unreadable"];
  /** Wording that would send a session to merge, enqueue or wait on a merge. */
  const MERGING = /AWAIT_PR \S+ merge|ci\|merge|gh pr merge|@mergifyio|check mergeability|and enqueue|re-queue|requeue|draft the PR/i;

  it.each(OUTCOMES)("%s → never a merge, an enqueue or a merge wait", (outcome) => {
    const step = nextStep({ outcome, pr: "7" }, 1, 4, "pr-medic");
    expect(step).not.toMatch(MERGING);
    // And it always ends the session with something the medic's prompt offers.
    expect(step).toMatch(/<ralph>DONE<\/ralph>|§5\.7/);
  });

  it("merges directly and reads a dequeued wait as a merge that did not land (mergeMethod: direct)", () => {
    const green = nextStep({ outcome: "green", pr: "41" }, 1, 4, "coder", "loop", "direct");
    expect(green).toContain("check mergeability and merge it");
    expect(green).toContain("`gh pr merge 41 --squash`");
    expect(green).toContain("`<ralph>AWAIT_PR 41 merge</ralph>`");
    expect(green).not.toContain("enqueue");
    const dequeued = nextStep({ outcome: "dequeued", pr: "41" }, 1, 4, "coder", "loop", "direct");
    expect(dequeued).toContain("The merge did not land");
    expect(dequeued).toContain("§5.6");
    expect(dequeued).toContain("Never re-queue");
    expect(dequeued).not.toContain("<ralph>AWAIT_PR 41 merge</ralph>");
    // Mergify, or no method, reads as it did.
    for (const outcome of ["green", "dequeued"]) {
      expect(nextStep({ outcome, pr: "41" }, 1, 4, "coder", "loop", "mergify")).toBe(nextStep({ outcome, pr: "41" }, 1, 4, "coder", "loop", ""));
    }
    // GitHub's queue puts no label on the PR, so green names the queue read instead.
    const queueGreen = nextStep({ outcome: "green", pr: "41" }, 1, 4, "coder", "loop", "github-queue");
    expect(queueGreen).toContain("`gh pr merge 41`");
    expect(queueGreen).toContain("`isInMergeQueue`");
    expect(queueGreen).not.toContain("queue's label");
    expect(queueGreen).toContain("`<ralph>AWAIT_PR 41 merge</ralph>`");
    expect(nextStep({ outcome: "dequeued", pr: "41" }, 1, 4, "coder", "loop", "github-queue")).toBe(
      nextStep({ outcome: "dequeued", pr: "41" }, 1, 4, "coder", "loop", ""),
    );
  });

  it("never sends a coder to merge at green when a person merges (merge: human)", () => {
    const green = nextStep({ outcome: "green", pr: "41" }, 1, 4, "coder", "human");
    expect(green).not.toMatch(/check mergeability and enqueue|<ralph>AWAIT_PR 41 merge<\/ralph> instead/);
    expect(green).toContain("hand the PR off as §5.6 says");
    expect(green).toContain("<ralph>DONE</ralph>");
    expect(nextStep({ outcome: "green", pr: "41" }, 1, 4, "coder", "loop")).toContain("check mergeability and enqueue");
  });

  it("hands over at green through case.ts done, and journals a red round for the gate to hand back", () => {
    const green = nextStep({ outcome: "green", pr: "7" }, 1, 4, "pr-medic");
    expect(green).toContain("§5.6");
    expect(green).toContain("`case.ts done 7`");
    expect(green).toContain("Never merge, never enqueue");
    const red = nextStep({ outcome: "red", pr: "7" }, 1, 4, "pr-medic");
    expect(red).toContain("§5.5's **red** branch");
    expect(red).toContain("§5.7's blocked path");
    expect(red).not.toContain("AWAIT_PR");
    expect(nextStep({ outcome: "head-mismatch", pr: "7" }, 1, 4, "pr-medic")).toContain("`case.ts drop 7`");
  });

  it("renders the medic's own finish sections under a preamble with no merge in it", async () => {
    const dir = scratchDir("ship-prompt-medic-");
    const wait = join(dir, "wait.json");
    writeFileSync(wait, JSON.stringify({ outcome: "green", pr: "2197", mode: "ci" }));
    const { code, out } = await main(
      ["ship", "--wait", wait, "--round", "1", "--max-rounds", "6", "--handoff", "h.md", "--iteration", "1", "--role", "pr-medic"],
      MEDIC,
    );
    expect(code).toBe(0);
    const preamble = out.slice(0, out.indexOf("# PR medic iteration"));
    expect(preamble).not.toMatch(MERGING);
    expect(preamble).toContain("you push to it only through `pr-medic/push.ts`");
    expect(out).toContain("## 5. Review gate, push, comment, CI, handover");
    expect(out).toContain("## 6. Journal and stop");
    expect(out).toContain("## The guardrails");
    expect(out).not.toContain("## 1. Diagnose");
  });

  it("gives the budget handoff no push and no draft", () => {
    const base = { used: 130e6, limit: 120e6, issue: null, handoff: "h.md", iteration: "3", strikes: 2, role: "pr-medic" as const };
    for (const strike of [1, 2]) {
      const text = budgetPreamble({ ...base, strike });
      expect(text).toContain("**Push nothing.**");
      expect(text).not.toMatch(/without force|draft the PR|Push commits/);
      expect(text).not.toMatch(MERGING);
      expect(text).toContain("Never `AWAIT_PR` or `PHASE` from here.");
    }
    expect(budgetPreamble({ ...base, strike: 1 })).toContain("leave the `-wip` claim in place");
    expect(budgetPreamble({ ...base, strike: 2 })).toContain("§5.7's blocked path");
  });

  it("tells the missing-sigil recovery turn the same", () => {
    const recovery = roleDescriptor("pr-medic").recoveryPrompt;
    expect(recovery).toContain("push to it only through pr-medic/push.ts, never merge or enqueue it");
    expect(recovery).not.toMatch(MERGING);
  });

  it("changes nothing for any other role, and falls back to the coder's text on an unknown one", async () => {
    for (const outcome of OUTCOMES) {
      const coder = nextStep({ outcome, pr: "7" }, 2, 4);
      for (const role of ["coder", "triager", "ci-doctor"] as const) {
        expect(nextStep({ outcome, pr: "7" }, 2, 4, role)).toBe(coder);
      }
    }
    const dir = scratchDir("ship-prompt-roles-");
    const wait = join(dir, "wait.json");
    writeFileSync(wait, JSON.stringify({ outcome: "green", pr: "7" }));
    const args = ["ship", "--wait", wait, "--round", "1", "--max-rounds", "6", "--handoff", "h.md", "--iteration", "1"];
    const plain = await main(args, PROMPT);
    for (const role of ["coder", "ci-doctor", "reviewer"]) {
      expect((await main([...args, "--role", role], PROMPT)).out).toBe(plain.out);
    }
    const budget = ["budget", "--used", "1", "--limit", "1", "--handoff", "h.md", "--iteration", "1"];
    expect((await main([...budget, "--role", "ci-doctor"], PROMPT)).out).toBe((await main(budget, PROMPT)).out);
  });
});
