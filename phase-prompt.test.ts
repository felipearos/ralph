// @vitest-environment node
/**
 * A fresh session knows only what its prompt and the disk tell it. These pin
 * the per-phase cut of the real `prompt.md` for every phase, where a retried
 * phase starts from, and what its session is told.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { appendLedger, notePath, PHASES, type Phase } from "./phase";
import {
  type Checkout,
  gitCheckout,
  handoffInto,
  main,
  phasePrompt,
  phaseSections,
  PROMPT_SECTIONS,
  resumePoint,
  resumePreamble,
  retryPreamble,
} from "./phase-prompt";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("builds fixture git repos");

const PROMPT = readFileSync(join(import.meta.dirname, "prompt.md"), "utf8");

const scratch: string[] = [];
afterAll(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const worktree = (): string => {
  const root = mkdtempSync(join(tmpdir(), "ralph-phase-prompt-"));
  scratch.push(root);
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  return root;
};

const NUMBERED: Record<number, string> = {
  0: "## 0. Orient",
  1: "## 1. Take one task",
  2: "## 2. Claim",
  3: "## 3. Implement",
  4: "## 4. Verify locally",
  5: "## 5. Review gate",
  6: "## 6. Journal and stop",
};
const SHARED = ["# Ralph iteration", "## Who you are", "## Model routing", "## Token reporting", "## Phases — yield at every boundary", "## HARD RAIL"];

describe("the sections each phase's fresh session gets", () => {
  it.each(PHASES.map((phase) => [phase]))("%s: its own numbered sections, every shared one, verbatim", (phase) => {
    const kept = phaseSections(PROMPT, phase);
    for (const [n, heading] of Object.entries(NUMBERED)) {
      if (PROMPT_SECTIONS[phase].includes(Number(n))) expect(kept).toContain(heading);
      else expect(kept).not.toContain(heading);
    }
    for (const heading of SHARED) expect(kept).toContain(heading);
    // Verbatim: the phase's text is the prompt's own, not a paraphrase.
    const section = (n: number) => PROMPT.slice(PROMPT.indexOf(NUMBERED[n]!)).split(/\n(?=## )/)[0]!;
    for (const n of PROMPT_SECTIONS[phase]) expect(kept).toContain(section(n));
    expect(kept.length).toBeLessThan(PROMPT.length);
  });

  it("gives every phase but finish the boundary line that ends it", () => {
    const ends: Record<Exclude<Phase, "finish">, string> = {
      select: "<ralph>PHASE implement <n></ralph>",
      implement: "<ralph>PHASE verify <n></ralph>",
      verify: "<ralph>PHASE review <n></ralph>",
      review: "<ralph>PHASE finish <n></ralph>",
    };
    for (const [phase, end] of Object.entries(ends)) expect(phaseSections(PROMPT, phase as Phase)).toContain(end);
  });

  it("keeps a heading it does not know, and puts the preamble first", () => {
    const rendered = "# T\n## 3. Implement\nx\n## 4. Verify\nv\n## Project notes\ny\n";
    expect(phaseSections(rendered, "verify")).toBe("# T\n## 4. Verify\nv\n## Project notes\ny\n");
    expect(phasePrompt(rendered, "implement", "PRE\n")).toBe("PRE\n# T\n## 3. Implement\nx\n## Project notes\ny\n");
  });
});

describe("where a retried phase starts from", () => {
  const entry = (phase: Phase, next: Phase, note: string | null) => ({
    version: 1 as const, ticket: 612, phase, next, note, at: "T", run: null, iteration: 1, session: null, attempt: 1, retry: false,
  });
  const note = (root: string, phase: Phase) => writeFileSync(join(root, notePath(612, phase)), `${phase}\n`);

  it("is the note of the phase that led into it, as the ledger records", () => {
    const root = worktree();
    note(root, "select");
    note(root, "verify");
    appendLedger(root, entry("select", "implement", notePath(612, "select")));
    appendLedger(root, entry("implement", "verify", null));
    appendLedger(root, entry("verify", "review", notePath(612, "verify")));
    appendLedger(root, entry("review", "finish", null));
    expect(handoffInto(root, 612, "review")).toBe(".ralph/logs/phase-612-verify.md");
    expect(handoffInto(root, 612, "implement")).toBe(".ralph/logs/phase-612-select.md");
  });

  it("follows a skipped phase: a shepherded PR's finish starts from select", () => {
    const root = worktree();
    note(root, "select");
    appendLedger(root, entry("select", "finish", notePath(612, "select")));
    expect(handoffInto(root, 612, "finish")).toBe(".ralph/logs/phase-612-select.md");
  });

  it("falls back to the nearest earlier note on disk, and to none", () => {
    const root = worktree();
    expect(handoffInto(root, 612, "review")).toBeNull();
    expect(handoffInto(root, 612, "select")).toBeNull();
    note(root, "implement");
    expect(handoffInto(root, 612, "review")).toBe(".ralph/logs/phase-612-implement.md");
    // A ledger line whose note has since gone is no note at all.
    appendLedger(root, entry("verify", "review", notePath(612, "verify")));
    expect(handoffInto(root, 612, "review")).toBe(".ralph/logs/phase-612-implement.md");
  });
});

describe("what a retried phase's session is told", () => {
  it.each(PHASES.map((phase) => [phase]))("%s: a fresh session, its starting note, and how it ends", (phase) => {
    const next = PHASES[PHASES.indexOf(phase) + 1] ?? null;
    const said = retryPreamble({ phase, next, ticket: 612, note: ".ralph/logs/phase-612-x.md", iteration: "3" });
    expect(said).toContain(`# Retrying the \`${phase}\` phase of iteration 3 on #612`);
    expect(said).toContain("You are a FRESH session");
    expect(said).toContain("`.ralph/logs/phase-612-x.md`");
    if (next === null) {
      expect(said).toContain("There are no more boundaries");
      expect(said).not.toContain("<ralph>PHASE");
    } else {
      expect(said).toContain(`<ralph>PHASE ${next} 612</ralph>`);
      expect(said).toContain(`\`.ralph/logs/phase-612-${phase}.md\` afresh`);
    }
    if (phase === "select") expect(said).toContain("do not take or claim another one");
    else expect(said).toContain(`Do NOT run the phases before \`${phase}\``);
  });

  it("ends by naming the phase the first attempt went on to, and copes with no note or ticket", () => {
    expect(retryPreamble({ phase: "select", next: "finish", ticket: 612, note: null, iteration: "1" })).toContain(
      "<ralph>PHASE finish 612</ralph>",
    );
    expect(retryPreamble({ phase: "select", next: "implement", ticket: 612, note: null, iteration: "1" })).toContain(
      "There is no phase before `select`",
    );
    const blind = retryPreamble({ phase: "review", next: "finish", ticket: null, note: null, iteration: "1" });
    expect(blind).toContain("No handoff note from the phase before `review` was found");
    expect(blind).toContain("<ralph>PHASE finish <n></ralph>");
  });
});

describe("the command", () => {
  it("builds a retry prompt from the ledger and the rendered prompt", () => {
    const root = worktree();
    writeFileSync(join(root, notePath(612, "verify")), "gates green\n");
    const out = main(["retry", "--phase", "review", "--next", "finish", "--ticket", "612", "--iteration", "4"], PROMPT, root);
    expect(out.code).toBe(0);
    expect(out.out.startsWith("# Retrying the `review` phase of iteration 4 on #612")).toBe(true);
    expect(out.out).toContain("`.ralph/logs/phase-612-verify.md`");
    expect(out.out).toContain("## 5. Review gate");
    expect(out.out).not.toContain("## 3. Implement");
  });

  it("refuses what it cannot build from, so the supervisor resumes instead", () => {
    const root = worktree();
    expect(main(["retry", "--phase", "daydream"], PROMPT, root).code).toBe(64);
    expect(main(["retry", "--phase", "review", "--next", "later"], PROMPT, root).code).toBe(64);
    expect(main(["retry", "--phase", "review"], "  ", root).code).toBe(64);
    expect(main(["resume", "--phase", "review"], PROMPT, root).code).toBe(64);
    // A ticket nobody can read is no ticket, not a failure.
    expect(main(["retry", "--phase", "review", "--ticket", "x"], PROMPT, root).out).toContain("<ralph>PHASE finish <n></ralph>");
  });
});

describe("whether an interrupted ticket resumes from its ledger", () => {
  const HEAD = "aaaa1111bbbb2222";
  const on = (branch: string | null, history: string[] = [HEAD]): Checkout => ({ branch, contains: (sha) => history.includes(sha) });
  const entry = (phase: Phase, next: Phase, note: string | null, checkout: { branch?: string; head?: string } = { branch: "ralph/612-x", head: HEAD }) => ({
    version: 1 as const, ticket: 612, phase, next, note, at: "T", run: null, iteration: 1, session: null, attempt: 1, retry: false, ...checkout,
  });
  const interrupted = (): string => {
    const root = worktree();
    writeFileSync(join(root, notePath(612, "select")), "mapped\n");
    writeFileSync(join(root, notePath(612, "implement")), "built\n");
    appendLedger(root, entry("select", "implement", notePath(612, "select")));
    appendLedger(root, entry("implement", "verify", notePath(612, "implement")));
    return root;
  };

  it("resumes at the phase after the last one that finished, when the worktree agrees", () => {
    const point = resumePoint(interrupted(), 612, on("ralph/612-x"));
    expect(point).toMatchObject({ resume: true, phase: "verify", note: ".ralph/logs/phase-612-implement.md" });
    expect(point.why).toBe("implement finished at aaaa1111bb on ralph/612-x");
    // Work past the recorded head is the interrupted phase's, and still resumable.
    expect(resumePoint(interrupted(), 612, on("ralph/612-x", ["cccc", HEAD])).resume).toBe(true);
  });

  it("follows the latest attempt: a retried phase's line is the one that counts", () => {
    const root = interrupted();
    appendLedger(root, { ...entry("select", "implement", notePath(612, "select")), attempt: 2, retry: true });
    expect(resumePoint(root, 612, on("ralph/612-x"))).toMatchObject({ resume: true, phase: "implement" });
  });

  it.each([
    ["missing", (root: string) => rmSync(join(root, ".ralph", "logs", "phases"), { recursive: true }), on("ralph/612-x"), "#612 has no phase ledger"],
    ["unrecorded", (root: string) => appendLedger(root, entry("verify", "review", notePath(612, "implement"), {})), on("ralph/612-x"), "#612's ledger ends at verify → review without the branch and head it was written on"],
    ["stale", (root: string) => rmSync(join(root, notePath(612, "implement"))), on("ralph/612-x"), "#612's implement handoff note .ralph/logs/phase-612-implement.md is gone"],
    ["stale", (root: string) => appendLedger(root, entry("verify", "review", null)), on("ralph/612-x"), "#612's ledger ends at verify → review with no verify handoff note"],
    ["mismatched", () => undefined, on("ralph/613-y"), "#612's ledger was written on ralph/612-x, but the worktree is on ralph/613-y"],
    ["mismatched", () => undefined, on(null), "#612's ledger was written on ralph/612-x, but the worktree is on a detached HEAD"],
    ["mismatched", () => undefined, on("ralph/612-x", ["rebased"]), "#612's ledger head aaaa1111bb is not in ralph/612-x's history"],
  ] as const)("falls back when the ledger is %s, and says why", (reason, spoil, checkout, why) => {
    const root = interrupted();
    spoil(root);
    expect(resumePoint(root, 612, checkout)).toEqual({ resume: false, reason, why });
  });

  it("tells the fresh session where it starts, what it must not redo, and how it ends", () => {
    const point = resumePoint(interrupted(), 612, on("ralph/612-x"));
    if (!point.resume) throw new Error("expected a resume");
    const said = resumePreamble(612, point, "5");
    expect(said).toContain("# Resuming #612 at the `verify` phase, iteration 5");
    expect(said).toContain("You are a FRESH session");
    expect(said).toContain("`.ralph/logs/phase-612-implement.md`");
    expect(said).toContain("`.ralph/logs/phases/612.jsonl`");
    expect(said).toContain("`git log --oneline aaaa1111bb..HEAD`");
    expect(said).toContain("Do NOT run the phases before `verify`");
    expect(said).toContain("<ralph>PHASE review 612</ralph>");
    const last = resumePreamble(612, { ...point, phase: "finish" }, "5");
    expect(last).toContain("never\nopen a second PR");
    expect(last).toContain("There are no more boundaries");
  });

  it("answers the supervisor with one machine line, then the prompt cut to the phase", () => {
    const root = interrupted();
    const resumed = main(["resume", "--ticket", "612", "--iteration", "5"], PROMPT, root, () => on("ralph/612-x"));
    expect(resumed.code).toBe(0);
    const [line, ...prompt] = resumed.out.split("\n");
    expect(line).toBe("resume\tverify\timplement\timplement finished at aaaa1111bb on ralph/612-x");
    expect(prompt.join("\n").startsWith("# Resuming #612 at the `verify` phase")).toBe(true);
    expect(resumed.out).toContain("## 4. Verify locally");
    expect(resumed.out).not.toContain("## 1. Take one task");

    const refused = main(["resume", "--ticket", "612"], PROMPT, root, () => on("main"));
    expect(refused).toEqual({ code: 0, out: "fallback\tmismatched\t-\t#612's ledger was written on ralph/612-x, but the worktree is on main" });
    expect(main(["resume"], PROMPT, root).code).toBe(64);
    expect(main(["resume", "--ticket", "0"], PROMPT, root).code).toBe(64);
    expect(main(["resume", "--ticket", "612"], "", root).code).toBe(64);
  });

  it("reads the branch and the history from the worktree's own git", () => {
    const root = worktree();
    const git = (...args: string[]) =>
      spawnSync("git", args, {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      });
    git("init", "--quiet", "--initial-branch=ralph/612-x");
    git("commit", "--quiet", "--allow-empty", "-m", "first");
    const first = git("rev-parse", "HEAD").stdout.trim();
    git("commit", "--quiet", "--allow-empty", "-m", "second");
    const checkout = gitCheckout(root);
    expect(checkout.branch).toBe("ralph/612-x");
    expect(checkout.contains(first)).toBe(true);
    expect(checkout.contains("0123456789abcdef0123456789abcdef01234567")).toBe(false);
    expect(checkout.contains("--not-a-sha")).toBe(false);
    git("checkout", "--quiet", "--detach");
    expect(gitCheckout(root).branch).toBeNull();
  });
});
