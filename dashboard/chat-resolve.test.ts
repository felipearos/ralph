// @vitest-environment node
/**
 * Session resolution, against real log files in a scratch worktree.
 *
 * The logs here are shaped like `ralph.sh`'s own: the supervisor log carries
 * the `===` headers and the models line, the iteration logs carry rendered
 * output, and the two meet only at the timestamp in the iteration log's name.
 * That join is the whole mechanism, so faking either half would test nothing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveSession, type ChatLoop } from "./chat";

const scratch: string[] = [];

afterEach(() => {
  scratch.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function worktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "ralph-chat-"));
  scratch.push(dir);
  mkdirSync(join(dir, ".ralph", "logs"), { recursive: true });
  return dir;
}

const write = (dir: string, name: string, text: string): void => writeFileSync(join(dir, ".ralph", "logs", name), text);

const MODELS = "Ralph: models — orchestrator claude-opus-5 on claude, mapper deepseek on opencode";

const loopOf = (dir: string, why: string | null): ChatLoop => ({
  name: "ralph",
  worktree: dir,
  stopReason: why === null ? null : { kind: "failed", why },
});

describe("resolveSession on a halted loop", () => {
  it("takes the last session of the iteration the stop reason names", () => {
    const dir = worktree();
    write(dir, "iter-20261007T105001.log", "[ts] assistant: working\n");
    write(
      dir,
      "supervisor-ralph-run-1.log",
      [
        MODELS,
        "=== Ralph iteration 6/50 (20261007T090000) session 11111111-1111-1111-1111-111111111111 ===",
        "Ralph: iteration 6 done.",
        "=== Ralph iteration 7/50 (20261007T105001) session 22222222-2222-2222-2222-222222222222 ===",
        "Ralph: iteration 7 yielded at implement.",
        "=== Ralph iteration 7: handoff session 33333333-3333-3333-3333-333333333333 (strike 1 of 3 on #252) ===",
        "",
      ].join("\n"),
    );

    const resolved = resolveSession(loopOf(dir, "iteration 7 ended without a sigil; see .ralph/logs/iter-20261007T105001.log"), {
      kind: "halt",
    });

    // The handoff session is the one that was alive at the stop; resuming the
    // numbered header's session would resume a session that had handed over.
    expect(resolved.session).toBe("33333333-3333-3333-3333-333333333333");
    expect(resolved.runner).toBe("claude");
    expect(resolved.source).toContain("iter-20261007T105001.log");
    expect(resolved.why).toBeNull();
  });

  it("does not run on into the next iteration's sessions", () => {
    const dir = worktree();
    write(dir, "iter-20261007T090000.log", "older\n");
    write(
      dir,
      "supervisor-ralph-run-1.log",
      [
        MODELS,
        "=== Ralph iteration 6/50 (20261007T090000) session 11111111-1111-1111-1111-111111111111 ===",
        "=== Ralph iteration 7/50 (20261007T105001) session 22222222-2222-2222-2222-222222222222 ===",
        "=== Ralph iteration 7: fresh session 44444444-4444-4444-4444-444444444444 for PR #250 (green) ===",
        "",
      ].join("\n"),
    );

    const resolved = resolveSession(loopOf(dir, "see .ralph/logs/iter-20261007T090000.log"), { kind: "halt" });

    expect(resolved.session).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("explains a stop reason that names no iteration log, and one that is missing", () => {
    const dir = worktree();
    expect(resolveSession(loopOf(dir, "the operator stopped the loop"), { kind: "halt" })).toMatchObject({
      session: null,
      why: expect.stringContaining("names no iteration log"),
    });
    expect(resolveSession(loopOf(dir, null), { kind: "halt" })).toMatchObject({
      session: null,
      why: expect.stringContaining("no stop reason"),
    });
  });

  it("explains a log whose session no supervisor log records", () => {
    const dir = worktree();
    write(dir, "supervisor-ralph-run-1.log", `${MODELS}\n=== Ralph iteration 1/50 (20260101T000000) session a ===\n`);

    expect(resolveSession(loopOf(dir, "see .ralph/logs/iter-20261007T105001.log"), { kind: "halt" })).toMatchObject({
      session: null,
      why: expect.stringContaining("20261007T105001"),
    });
  });
});

describe("resolveSession on a blocked ticket", () => {
  it("takes the newest iteration log that names the ticket AND a block", () => {
    const dir = worktree();
    // Named the ticket, never blocked it: the older log is the real one.
    write(dir, "iter-20261007T120000.log", "[ts] assistant: #252 looks adjacent to what I am doing.\n");
    write(dir, "iter-20261007T110000.log", "[ts] assistant: commenting `blocked: #252 needs the operator`.\n");
    write(dir, "iter-20261007T100000.log", "[ts] assistant: blocked: #999 is someone else's.\n");
    write(
      dir,
      "supervisor-ralph-run-1.log",
      [
        MODELS,
        "=== Ralph iteration 4/50 (20261007T110000) session 55555555-5555-5555-5555-555555555555 ===",
        "=== Ralph iteration 5/50 (20261007T120000) session 66666666-6666-6666-6666-666666666666 ===",
        "",
      ].join("\n"),
    );

    const resolved = resolveSession(loopOf(dir, null), { kind: "ticket", ticket: 252 });

    expect(resolved.session).toBe("55555555-5555-5555-5555-555555555555");
    expect(resolved.source).toContain("iter-20261007T110000.log");
  });

  it("does not take a ticket whose number is a prefix of another", () => {
    const dir = worktree();
    write(dir, "iter-20261007T110000.log", "[ts] assistant: blocked: #2520 is the one I parked.\n");

    expect(resolveSession(loopOf(dir, null), { kind: "ticket", ticket: 252 })).toMatchObject({
      session: null,
      why: expect.stringContaining("#252"),
    });
  });
});

describe("resolveSession and the runner", () => {
  it("refuses a one-role codex lineup, whose line ends in an effort rather than a comma", () => {
    const dir = worktree();
    write(dir, "iter-20260930T005024.log", "rendered\n");
    // Verbatim from this host's longest supervisor log, line 1837. Twenty of
    // its twenty codex announcements have this shape, and NONE has a comma
    // after the runner — a regex that required one read every real codex
    // iteration as claude and offered its id to `--resume`.
    write(
      dir,
      "supervisor-ralph-run-2.log",
      [
        "Ralph run ralph-run-20260930T001146-2907510 — usage ledger: .ralph/logs/usage-ledger.tsv",
        "Ralph: models — orchestrator gpt-5.6-terra on codex (orchestrator effort high)",
        "=== Ralph iteration 1/50 (20260930T005024) session 77777777-7777-7777-7777-777777777777 ===",
        "",
      ].join("\n"),
    );

    const resolved = resolveSession(loopOf(dir, "see .ralph/logs/iter-20260930T005024.log"), { kind: "halt" });

    expect(resolved.session).toBeNull();
    expect(resolved.runner).toBe("codex");
  });

  it("does not inherit a previous run's lineup across a restart", () => {
    const dir = worktree();
    write(dir, "iter-20260930T011543.log", "rendered\n");
    // One supervisor log is appended to across restarts. Walking back past the
    // run banner would answer with the FIRST run's claude, and a codex
    // iteration would then be resolved and resumed.
    write(
      dir,
      "supervisor-ralph-run-3.log",
      [
        "Ralph run ralph-run-A — usage ledger: .ralph/logs/usage-ledger.tsv",
        "Ralph: models — orchestrator claude-opus-5 on claude, mapper sonnet on claude",
        "=== Ralph iteration 1/50 (20260930T004000) session aaaa ===",
        "Ralph run ralph-run-B — usage ledger: .ralph/logs/usage-ledger.tsv",
        "=== Ralph iteration 1/50 (20260930T011543) session bbbb ===",
        "",
      ].join("\n"),
    );

    const resolved = resolveSession(loopOf(dir, "see .ralph/logs/iter-20260930T011543.log"), { kind: "halt" });

    // Run B announced no lineup, so the runner is unknown — not run A's.
    expect(resolved).toMatchObject({ session: "bbbb", runner: null });
  });

  it("refuses a codex-orchestrated iteration, naming the runner", () => {
    const dir = worktree();
    write(dir, "iter-20261007T105001.log", "rendered\n");
    write(
      dir,
      "supervisor-rafa-run-1.log",
      [
        "Rafa: models — orchestrator gpt-5 on codex, mapper deepseek on opencode",
        "=== Rafa iteration 7/50 (20261007T105001) session 22222222-2222-2222-2222-222222222222 ===",
        "",
      ].join("\n"),
    );

    const resolved = resolveSession(loopOf(dir, "see .ralph/logs/iter-20261007T105001.log"), { kind: "halt" });

    expect(resolved.session).toBeNull();
    expect(resolved.runner).toBe("codex");
    expect(resolved.why).toContain("codex");
    // The caller still needs to say WHERE it looked when it offers a fresh session.
    expect(resolved.source).toContain("iter-20261007T105001.log");
  });

  it("resolves a log that predates the models line, with no runner to report", () => {
    const dir = worktree();
    write(dir, "iter-20261007T105001.log", "rendered\n");
    write(dir, "supervisor-ralph-run-1.log", "=== Ralph iteration 7/50 (20261007T105001) session abc ===\n");

    expect(resolveSession(loopOf(dir, "see .ralph/logs/iter-20261007T105001.log"), { kind: "halt" })).toMatchObject({
      session: "abc",
      runner: null,
    });
  });
});

describe("resolveSession never throws on an unreadable worktree", () => {
  it("answers with a reason when the logs directory does not exist", () => {
    const dir = join(tmpdir(), "ralph-chat-absent-worktree");

    expect(resolveSession(loopOf(dir, null), { kind: "ticket", ticket: 1 })).toMatchObject({ session: null });
    expect(resolveSession(loopOf(dir, "see .ralph/logs/iter-20261007T105001.log"), { kind: "halt" })).toMatchObject({
      session: null,
    });
  });
});
