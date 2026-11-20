// @vitest-environment node
/**
 * A phase boundary is a checkpoint, never a way for an iteration to stall.
 * These pin the vocabulary the supervisor and the prompt share, the order a
 * final message is read in, and what a boundary leaves on disk.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  appendLedger,
  clearLedger,
  LEDGER_DIR,
  ledgerPath,
  main,
  notePath,
  PHASE_SIGIL_SOURCE,
  PHASES,
  readLedger,
  readLedgerHistory,
  resumePrompt,
  sessionSignal,
  STOP_SIGILS,
} from "./phase";

const RALPH_SH = readFileSync(join(import.meta.dirname, "ralph.sh"), "utf8");
const PROMPT = readFileSync(join(import.meta.dirname, "prompt.md"), "utf8");

const scratch: string[] = [];
afterAll(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const worktree = (): string => {
  const root = mkdtempSync(join(tmpdir(), "ralph-phase-"));
  scratch.push(root);
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  return root;
};

describe("the vocabulary the supervisor and the prompt share", () => {
  it("gives ralph.sh the same sigil pattern as the roster", () => {
    const line = /^PHASE_SIGIL='(.*)'$/m.exec(RALPH_SH)?.[1];
    expect(line).toBe(PHASE_SIGIL_SOURCE);
  });

  it("gives ralph.sh the same stop sigils", () => {
    const line = /^STOP_SIGILS='<ralph>\((.*)\)<\/ralph>'$/m.exec(RALPH_SH)?.[1];
    expect(line?.split("|").sort()).toEqual([...STOP_SIGILS].sort());
  });

  it("puts every boundary in the prompt, in the roster's order", () => {
    const at = PHASES.slice(1).map((phase) => PROMPT.indexOf(`<ralph>PHASE ${phase} <n></ralph>`));
    expect(at.every((index) => index > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const phase of PHASES.slice(0, -1)) expect(PROMPT).toContain(`.ralph/logs/phase-<n>-${phase}.md`);
    // The boundaries follow the sections they close.
    expect(at[0]).toBeGreaterThan(PROMPT.indexOf("## 3. Implement"));
    expect(at[1]).toBeLessThan(PROMPT.indexOf("## 4. Verify"));
    expect(at[2]).toBeLessThan(PROMPT.indexOf("## 5. Review gate"));
    expect(at[3]).toBeLessThan(PROMPT.indexOf("3. Push and `gh pr create`"));
  });

  it("lists PHASE among the endings, as a hand-back rather than an ending", () => {
    const endings = PROMPT.indexOf("End your output with exactly one of:");
    expect(PROMPT.indexOf("`<ralph>PHASE <next> <n></ralph>` — a phase boundary", endings)).toBeGreaterThan(endings);
  });
});

describe("reading a session's final message", () => {
  it("reads a phase sigil, with or without its ticket", () => {
    expect(sessionSignal("done mapping\n<ralph>PHASE implement 612</ralph>")).toEqual({ kind: "phase", next: "implement", ticket: 612 });
    expect(sessionSignal("<ralph>PHASE verify #7</ralph>")).toEqual({ kind: "phase", next: "verify", ticket: 7 });
    expect(sessionSignal("<ralph>PHASE finish</ralph>")).toEqual({ kind: "phase", next: "finish", ticket: null });
  });

  it("reads AWAIT_HOST above AWAIT_PR and PHASE, and below every stop sigil", () => {
    expect(sessionSignal("<ralph>AWAIT_HOST 1604</ralph>")).toEqual({ kind: "host", ticket: 1604 });
    expect(sessionSignal("<ralph>PHASE finish 1</ralph>\n<ralph>AWAIT_PR 9 ci</ralph>\n<ralph>AWAIT_HOST #1604</ralph>")).toEqual({ kind: "host", ticket: 1604 });
    expect(sessionSignal("<ralph>AWAIT_HOST 1604</ralph>\n<ralph>DONE</ralph>")).toEqual({ kind: "stop", sigil: "DONE" });
  });

  it("gives ralph.sh a host sigil the reader agrees with", () => {
    const line = /^HOST_SIGIL='(.*)'$/m.exec(RALPH_SH)?.[1];
    expect(line).toBe("<ralph>AWAIT_HOST #?[0-9]+</ralph>");
    expect(PROMPT).toContain("`<ralph>AWAIT_HOST <n></ralph>` — only as §4's host lease describes");
  });

  it("lets the last phase sigil win, as the supervisor's tail does", () => {
    expect(sessionSignal("<ralph>PHASE implement 1</ralph>\n<ralph>PHASE verify 1</ralph>")).toMatchObject({ next: "verify" });
  });

  it.each([
    ["DONE", "<ralph>PHASE review 3</ralph>\n<ralph>DONE</ralph>"],
    ["DONE", "<ralph>DONE</ralph>\n<ralph>PHASE review 3</ralph>"],
    ["NEEDS_TRIAGE", "<ralph>PHASE implement 3</ralph> <ralph>NEEDS_TRIAGE</ralph>"],
    ["RETRY_LATER", "<ralph>RETRY_LATER</ralph><ralph>PHASE finish 3</ralph>"],
    ["ALL_BLOCKED", "<ralph>ALL_BLOCKED</ralph> <ralph>PHASE finish 3</ralph>"],
    ["COMPLETE", "<ralph>COMPLETE</ralph> <ralph>PHASE finish 3</ralph>"],
  ])("lets a terminal sigil (%s) win over a phase sigil", (sigil, final) => {
    expect(sessionSignal(final)).toEqual({ kind: "stop", sigil });
  });

  it("keeps the supervisor's order among the terminal sigils", () => {
    expect(sessionSignal("<ralph>DONE</ralph><ralph>NEEDS_TRIAGE</ralph>")).toEqual({ kind: "stop", sigil: "NEEDS_TRIAGE" });
    expect(sessionSignal("<ralph>DONE</ralph><ralph>RETRY_LATER</ralph>")).toEqual({ kind: "stop", sigil: "RETRY_LATER" });
  });

  it("lets AWAIT_PR win over a phase sigil, and lose to a terminal one", () => {
    expect(sessionSignal("<ralph>PHASE finish 3</ralph>\n<ralph>AWAIT_PR 9 ci</ralph>")).toEqual({ kind: "await", pr: 9, mode: "ci" });
    expect(sessionSignal("<ralph>AWAIT_PR 9 merge</ralph>\n<ralph>PHASE finish 3</ralph>")).toEqual({ kind: "await", pr: 9, mode: "merge" });
    expect(sessionSignal("<ralph>AWAIT_PR 9</ralph>")).toEqual({ kind: "await", pr: 9, mode: "ci" });
    expect(sessionSignal("<ralph>AWAIT_PR 9 ci</ralph><ralph>DONE</ralph>")).toEqual({ kind: "stop", sigil: "DONE" });
  });

  it.each([
    "<ralph>PHASE</ralph>",
    "<ralph>PHASE daydream 3</ralph>",
    "<ralph>PHASE Implement 3</ralph>",
    "<ralph>PHASE implement three</ralph>",
    "<ralph>PHASE implement 3",
    "PHASE implement 3",
    "",
  ])("reads a malformed phase sigil (%j) as no sigil at all", (final) => {
    expect(sessionSignal(final)).toEqual({ kind: "none" });
  });

  it("agrees with the supervisor's grep on what is a phase sigil", () => {
    const grep = new RegExp(PHASE_SIGIL_SOURCE);
    for (const final of ["<ralph>PHASE review 3</ralph>", "<ralph>PHASE daydream 3</ralph>", "<ralph>PHASE implement three</ralph>"]) {
      expect(grep.test(final)).toBe(sessionSignal(final).kind === "phase");
    }
  });
});

describe("what a boundary leaves on disk", () => {
  const env = { RALPH_RUN_ID: "ralph-run-1", RALPH_SESSION_ID: "00000000-0000-4000-8000-000000000000" };
  const now = new Date("2026-09-23T10:00:00Z");

  it("appends the finished phase with its note to the ticket's ledger", () => {
    const root = worktree();
    writeFileSync(join(root, notePath(612, "select")), "mapped the loader\n");
    const first = main(["boundary", "--from", "select", "--next", "implement", "--ticket", "612", "--iteration", "3"], root, env, now);
    const second = main(["boundary", "--from", "implement", "--next", "verify", "--ticket", "612", "--iteration", "3"], root, env, now);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);

    expect(readLedger(root, 612)).toEqual([
      {
        version: 1,
        ticket: 612,
        phase: "select",
        next: "implement",
        note: ".ralph/logs/phase-612-select.md",
        at: "2026-09-23T10:00:00.000Z",
        run: "ralph-run-1",
        iteration: 3,
        session: env.RALPH_SESSION_ID,
        attempt: 1,
        retry: false,
      },
      // No note on disk is recorded as none, never as a path that is not there.
      expect.objectContaining({ phase: "implement", next: "verify", note: null }),
    ]);
    expect(readFileSync(join(root, ledgerPath(612)), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("hands the resumed session a prompt, and asks for a note that was not written", () => {
    const root = worktree();
    writeFileSync(join(root, notePath(612, "select")), "x\n");
    const written = main(["boundary", "--from", "select", "--next", "implement", "--ticket", "612"], root, env, now).out;
    expect(written).toContain("`select` → `implement`");
    expect(written).toContain("same session");
    expect(written).toContain("`.ralph/logs/phase-612-select.md`");
    expect(written).toContain("<ralph>PHASE verify 612</ralph>");

    const missing = main(["boundary", "--from", "implement", "--next", "verify", "--ticket", "612"], root, env, now).out;
    expect(missing).toContain("write it now");
  });

  it("still resumes when the ticket is unknown, and writes no ledger for it", () => {
    const root = worktree();
    const out = main(["boundary", "--from", "select", "--next", "implement"], root, env, now);
    expect(out.code).toBe(0);
    expect(out.out).toContain("<ralph>PHASE verify <n></ralph>");
    expect(readLedger(root, 0)).toEqual([]);
  });

  it("still resumes when the ledger cannot be written", () => {
    const root = worktree();
    // A file where the ledger's directory should be.
    writeFileSync(join(root, ".ralph", "logs", "phases"), "");
    const out = main(["boundary", "--from", "select", "--next", "implement", "--ticket", "5"], root, env, now);
    expect(out.code).toBe(0);
    expect(out.out).toContain("`implement`");
  });

  it("says there is nothing after finish", () => {
    expect(resumePrompt({ from: "review", next: "finish", ticket: 5, note: null })).toContain("There are no more boundaries");
  });

  it("refuses a phase it does not know", () => {
    expect(main(["boundary", "--from", "select", "--next", "daydream"], worktree(), env, now).code).toBe(64);
    expect(main(["nonsense"], worktree(), env, now).code).toBe(64);
  });

  it("skips a ledger line cut short by a kill", () => {
    const root = worktree();
    appendLedger(root, { version: 1, ticket: 9, phase: "select", next: "finish", note: null, at: now.toISOString(), run: null, iteration: null, session: null, attempt: 1, retry: false });
    writeFileSync(join(root, ledgerPath(9)), readFileSync(join(root, ledgerPath(9)), "utf8") + '{"version":1,"ticket":9,"pha');
    expect(readLedger(root, 9)).toHaveLength(1);
  });
});

describe("a phase that finishes again supersedes, never deletes", () => {
  const env = { RALPH_RUN_ID: "ralph-run-1", RALPH_SESSION_ID: "s-1" };
  const now = new Date("2026-09-23T10:00:00Z");
  const boundary = (root: string, from: string, next: string, ...extra: string[]) =>
    main(["boundary", "--from", from, "--next", next, "--ticket", "612", "--iteration", "3", ...extra], root, env, now);

  it("keeps both attempts in the history, and answers readLedger with the latest", () => {
    const root = worktree();
    boundary(root, "select", "implement");
    boundary(root, "implement", "verify");
    boundary(root, "verify", "review");
    boundary(root, "review", "finish");
    boundary(root, "review", "finish", "--retry");

    const history = readLedgerHistory(root, 612);
    expect(history.map((row) => [row.phase, row.attempt, row.retry, row.superseded])).toEqual([
      ["select", 1, false, false],
      ["implement", 1, false, false],
      ["verify", 1, false, false],
      ["review", 1, false, true],
      ["review", 2, true, false],
    ]);
    const current = readLedger(root, 612);
    expect(current.map((entry) => `${entry.phase}#${entry.attempt}`)).toEqual(["select#1", "implement#1", "verify#1", "review#2"]);
    expect(current.at(-1)).toMatchObject({ phase: "review", next: "finish", retry: true });
    expect(current.every((entry) => !("superseded" in entry))).toBe(true);
    // Appended, never rewritten: every line is still on disk.
    expect(readFileSync(join(root, ledgerPath(612)), "utf8").trim().split("\n")).toHaveLength(5);
  });

  it("reads a line written before attempts were counted as the first, and supersedes it by position", () => {
    const root = worktree();
    mkdirSync(join(root, ".ralph", "logs", "phases"), { recursive: true });
    const old = { version: 1, ticket: 7, phase: "verify", next: "review", note: null, at: "T", run: null, iteration: 1, session: null };
    writeFileSync(join(root, ledgerPath(7)), `${JSON.stringify(old)}\n${JSON.stringify({ ...old, attempt: "two" })}\n`);
    const history = readLedgerHistory(root, 7);
    expect(history.map((row) => [row.attempt, row.retry, row.superseded])).toEqual([
      [1, false, true],
      [1, false, false],
    ]);
    expect(readLedger(root, 7)).toHaveLength(1);
  });
});

describe("the checkout a ledger line was written on, and clearing it", () => {
  const env = { RALPH_RUN_ID: "ralph-run-1", RALPH_SESSION_ID: "s-1" };
  const now = new Date("2026-09-23T10:00:00Z");

  it("records the branch and head a phase finished on, and leaves them out when unknown", () => {
    const root = worktree();
    main(["boundary", "--from", "select", "--next", "implement", "--ticket", "612", "--branch", "ralph/612-x", "--head", "abc123"], root, env, now);
    main(["boundary", "--from", "implement", "--next", "verify", "--ticket", "612", "--branch", ""], root, env, now);
    const [first, second] = readLedger(root, 612);
    expect(first).toMatchObject({ phase: "select", branch: "ralph/612-x", head: "abc123" });
    expect(second).not.toHaveProperty("branch");
    expect(second).not.toHaveProperty("head");
  });

  it("clears a ticket's ledger and every note, and nothing of another ticket's", () => {
    const root = worktree();
    for (const ticket of [612, 613]) {
      main(["boundary", "--from", "select", "--next", "implement", "--ticket", String(ticket)], root, env, now);
      for (const phase of PHASES) writeFileSync(join(root, notePath(ticket, phase)), `${phase}\n`);
    }
    expect(main(["clear", "--ticket", "612"], root, env, now)).toEqual({ code: 0, out: "cleared the phase ledger of #612" });
    expect(existsSync(join(root, ledgerPath(612)))).toBe(false);
    for (const phase of PHASES) expect(existsSync(join(root, notePath(612, phase)))).toBe(false);
    expect(readLedger(root, 613)).toHaveLength(1);
    for (const phase of PHASES) expect(existsSync(join(root, notePath(613, phase)))).toBe(true);
    // Nothing there is nothing to clear, not a failure.
    expect(() => clearLedger(root, 612)).not.toThrow();
    expect(() => clearLedger(join(root, "no-such-worktree"), 612)).not.toThrow();
    expect(main(["clear"], root, env, now).code).toBe(64);
  });

  it("gives ralph.sh the ledger directory it looks for", () => {
    expect(RALPH_SH).toContain(`${LEDGER_DIR}/*.jsonl`);
  });
});
