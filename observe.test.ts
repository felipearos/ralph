// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { LoopReport } from "./loop-state";
import {
  activeIssueFor,
  compactRecent,
  currentStep,
  activeWarning,
  issueFromBranch,
  rosterOrOwn,
  plainAction,
  presenceSummary,
  projectActors,
  readIssueHistory,
  renderLiveFrame,
  renderPresence,
  announceObserver,
  shouldAnnounceObserver,
  shouldAttemptAnnouncement,
  workflowPhase,
  type PresenceSnapshot,
} from "./observe";
import type { TimelineEvent } from "./timeline";

const LOGGD_LOOPS = ["ralph", "rafa", "remo", "rulo"] as const;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const report = (alive = true): Pick<LoopReport, "loopStatus" | "supervisor" | "state"> => ({
  loopStatus: alive ? "running" : "failed",
  supervisor: alive ? "alive" : "dead",
  state: {
    version: 1,
    run: "ralph-run-test",
    owner: { loop: "ralph", pid: 42, host: "test" },
    worktree: "/tmp/work",
    branch: "ralph/663-import-notifications",
    stage: "iteration",
    iteration: { index: 3, max: 100 },
    heartbeat: "2026-08-28T12:00:00.000Z",
    lastEvent: { name: "iteration-start", at: "2026-08-28T12:00:00.000Z" },
    stopReason: null,
  },
});

const event = (value: Partial<TimelineEvent>): TimelineEvent => ({
  ralph_stage: "executor",
  ralph_iteration: 3,
  ralph_run: "ralph-run-test",
  ralph_received_at: "2026-08-28T12:00:00.000Z",
  ...value,
});

const presenceFixture: PresenceSnapshot = {
  loop: "ralph",
  run: "ralph-run-test",
  status: "running",
  supervisor: "alive",
  issue: null,
  branch: "main",
  iteration: null,
  actors: [],
  recent: [],
  issues: [],
  failureReason: null,
  observedAt: "2026-09-13T00:00:00.000Z",
};

describe("Ralph observer projection", () => {
  it("announces itself only as the long-lived observer", () => {
    expect(shouldAnnounceObserver([])).toBe(true);
    expect(shouldAnnounceObserver(["--interval", "5"])).toBe(true);
    expect(shouldAnnounceObserver(["--once"])).toBe(false);
    expect(shouldAnnounceObserver(["--json"])).toBe(false);
  });
  it("announces on a new run at once, and otherwise once a minute", () => {
    expect(shouldAttemptAnnouncement(null, null, 0, 1_000)).toBe(false);
    expect(shouldAttemptAnnouncement("run-1", null, 0, 1_000)).toBe(true);
    expect(shouldAttemptAnnouncement("run-1", "run-1", 1_000, 2_000)).toBe(false);
    expect(shouldAttemptAnnouncement("run-1", "run-1", 1_000, 61_000)).toBe(true);
    expect(shouldAttemptAnnouncement("run-2", "run-1", 1_000, 2_000)).toBe(true);
  });
  it("keeps rendering when a plugin hearing the announcement fails", () => {
    const root = mkdtempSync(join(tmpdir(), "ralph-observer-announce-failure-"));
    roots.push(root);
    const plugins = join(root, "plugins");
    mkdirSync(join(plugins, "broken"), { recursive: true });
    writeFileSync(join(plugins, "broken", "plugin.ts"), 'throw new Error("boom");');
    const saved = { dir: process.env.RALPH_PLUGINS_DIR, list: process.env.RALPH_PLUGINS };
    process.env.RALPH_PLUGINS_DIR = plugins;
    process.env.RALPH_PLUGINS = "broken";
    try {
      expect(() => announceObserver(root, { ...presenceFixture, run: "ralph-run-test" })).not.toThrow();
    } finally {
      if (saved.dir === undefined) delete process.env.RALPH_PLUGINS_DIR;
      else process.env.RALPH_PLUGINS_DIR = saved.dir;
      if (saved.list === undefined) delete process.env.RALPH_PLUGINS;
      else process.env.RALPH_PLUGINS = saved.list;
    }
  });
  it("shows explicit stage lifecycle and the latest bounded action", () => {
    const actors = projectActors(
      [
        event({
          type: "ralph_stage",
          state: "started",
          invocation: "executor-1",
          runner: "opencode",
          model: "opencode-go/model",
        }),
        event({
          type: "tool_use",
          part: { tool: "bash", state: { input: { command: "bun run typecheck" } } },
          ralph_received_at: "2026-08-28T12:00:05.000Z",
        }),
        event({
          type: "ralph_stage",
          state: "completed",
          invocation: "executor-1",
          runner: "opencode",
          model: "opencode-go/model",
          ralph_received_at: "2026-08-28T12:00:10.000Z",
        }),
      ],
      report(),
    );

    expect(actors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "executor",
          state: "completed",
          runner: "opencode",
          lastAction: "tool bash — bun run typecheck",
        }),
        expect.objectContaining({ stage: "orchestrator", state: "running" }),
      ]),
    );
  });

  it("does not call an unmarked external stage idle or completed", () => {
    const actors = projectActors(
      [event({ type: "text", part: { text: "working" } })],
      report(false),
    );
    expect(actors[0]).toMatchObject({ stage: "executor", state: "unknown" });
  });

  it("uses only a live lease as evidence that an issue is active", () => {
    const now = Date.parse("2026-08-28T12:00:00.000Z");
    const live = report();
    expect(activeIssueFor({ issue: 663, expiresAt: "2026-08-28T12:01:00.000Z" }, live, now)).toBe(663);
    expect(activeIssueFor({ issue: 663, expiresAt: "2026-08-28T11:59:00.000Z" }, live, now)).toBeNull();
    expect(activeIssueFor({ issue: 663, expiresAt: "2026-08-28T12:01:00.000Z" }, report(false), now)).toBeNull();
  });

  it("renders a compact operator view and summary", () => {
    const presence: PresenceSnapshot = {
      loop: "ralph",
      run: "ralph-run-test",
      status: "running",
      supervisor: "alive",
      issue: 663,
      branch: "ralph/663-import-notifications",
      iteration: { index: 3, max: 100 },
      actors: [
        {
          stage: "executor",
          state: "running",
          invocation: "executor-1",
          runner: "opencode",
          model: "model",
          startedAt: "2026-08-28T12:00:00.000Z",
          endedAt: null,
          lastAction: "tool bash — bun run typecheck",
          activityAt: "2026-08-28T12:00:05.000Z",
        },
      ],
      recent: [],
      issues: [],
      failureReason: null,
      observedAt: "2026-08-28T12:00:06.000Z",
    };

    expect(presenceSummary(presence)).toBe(
      "ralph • #663 • 3/100 • executor • tool bash — bun run typecheck",
    );
    expect(renderPresence(presence, Date.parse(presence.observedAt))).toContain(
      "executor           RUNNING",
    );
    expect(renderPresence(presence, Date.parse(presence.observedAt))).not.toContain("\u001b[");
    expect(renderPresence(presence, Date.parse(presence.observedAt), true)).toContain(
      "\u001b[38;5;135mRALPH",
    );
  });

  it("updates only changed terminal rows after the first frame", () => {
    expect(renderLiveFrame(null, "one\ntwo\nthree")).toBe(
      "\u001b[?25l\u001b[2J\u001b[Hone\ntwo\nthree",
    );
    expect(renderLiveFrame("one\ntwo\nthree", "one\nchanged\nthree")).toBe(
      "\u001b[?25l\u001b[2;1H\u001b[2Kchanged\u001b[4;1H",
    );
    expect(renderLiveFrame("one\ntwo\nthree", "one\ntwo")).toBe(
      "\u001b[?25l\u001b[3;1H\u001b[2K\u001b[3;1H",
    );
    expect(renderLiveFrame("unchanged", "unchanged")).toBe("");
  });

  it("turns noisy timeline data into an operator-readable current step", () => {
    const presence: PresenceSnapshot = {
      loop: "ralph",
      run: "run",
      status: "running",
      supervisor: "alive",
      issue: 663,
      branch: "ralph/663",
      iteration: { index: 1, max: 100 },
      actors: [],
      recent: [
        {
          stage: "orchestrator",
          label: "system — thinking_tokens",
          at: "2026-08-28T12:00:00.000Z",
          iteration: 1,
          run: "run",
        },
        {
          stage: "orchestrator",
          label: 'tool Bash — until ! pgrep -f "inspect.sh review"; do sleep 20; done',
          at: "2026-08-28T12:00:01.000Z",
          iteration: 1,
          run: "run",
        },
        {
          stage: "orchestrator",
          label: "tool result ok — ok",
          at: "2026-08-28T12:00:02.000Z",
          iteration: 1,
          run: "run",
        },
      ],
      issues: [],
      failureReason: null,
      observedAt: "2026-08-28T12:00:02.000Z",
    };
    expect(currentStep(presence)).toEqual({
      stage: "orchestrator",
      action: "waiting for review agents",
    });
    expect(workflowPhase(presence)).toEqual({ index: 3, total: 5, label: "review" });
    expect(plainAction("text — ## **Review** `file.ts`")).toBe("text — Review file.ts");
  });

  it("collapses adjacent repeated events", () => {
    const row = {
      stage: "orchestrator" as const,
      label: "system — thinking_tokens",
      at: "2026-08-28T12:00:00.000Z",
      iteration: 1,
      run: "run",
    };
    expect(compactRecent([row, { ...row, at: "2026-08-28T12:00:01.000Z" }])).toEqual([
      expect.objectContaining({ label: "thinking", count: 2 }),
    ]);
  });

  it("projects current and previous issue outcomes from durable local records", () => {
    const root = mkdtempSync(join(tmpdir(), "ralph-observer-history-"));
    roots.push(root);
    mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
    // Published entries live on the harness repo's origin/main; the reader is
    // injected so the projection is tested without a git fixture.
    const journal = () => [
      {
        name: "20260828T210000Z-680-a1b.md",
        body: "# 2026-08-28 — #680: Review publication rules — MERGED\n\n**Outcome: merged.** Loop: **rafa**. Ticket #680 closed, PR **#737** squash-merged.\n",
      },
      {
        name: "20260827T210000Z-675-a1b.md",
        body: "# 2026-08-27 — #675: Profile reads (PR #717, DRAFT — migration hard rail)\n\n**Outcome: blocked (migration hard rail).** Loop: **rafa**. PR **#717** open as a **draft**.\n",
      },
      {
        name: "20260828T220000Z-683-a1b.md",
        body: "# 2026-08-28 — #683: Other loop\n\n**Outcome: merged.** Loop: **ralph**. PR **#731**.\n",
      },
      {
        name: "20260827T220000Z-676-a1b.md",
        body: "# 2026-08-27 — #676: Pushed for another operator\n\n**Outcome: handed off.** Loop: **rafa**. The branch is ready but has no PR.\n",
      },
      {
        name: "20260827T200000Z-677-a1b.md",
        body: "# 2026-08-27 — #677: Poster cache\n\n**Outcome: blocked (CI unreadable).** Loop: **rafa**. PR **#718** is a draft.\n",
      },
    ];
    writeFileSync(
      join(root, ".ralph", "logs", "runner-failures.jsonl"),
      `${JSON.stringify({ at: "2026-08-26T20:00:00.000Z", loop: "rafa", issue: 663, stage: "executor", kind: "timeout" })}\n`,
    );

    expect(readIssueHistory(root, "rafa", 690, 6, journal)).toEqual([
      expect.objectContaining({ issue: 690, state: "active", block: null }),
      expect.objectContaining({ issue: 680, state: "merged", pr: 737, block: null }),
      expect.objectContaining({ issue: 676, state: "handoff", pr: null }),
      // A migration hand-off and any other block read apart.
      expect.objectContaining({ issue: 675, state: "blocked", pr: 717, draft: true, title: "Profile reads", block: "migration" }),
      expect.objectContaining({ issue: 677, state: "blocked", pr: 718, block: "other" }),
      expect.objectContaining({ issue: 663, state: "failed", detail: "executor timeout", block: null }),
    ]);
  });

  it("keeps rate limits as a warning and the useful work as the current step", () => {
    const presence: PresenceSnapshot = {
      loop: "rafa",
      run: "run",
      status: "running",
      supervisor: "alive",
      issue: 690,
      branch: "rafa/690",
      iteration: { index: 1, max: 100 },
      actors: [],
      recent: [
        {
          stage: "orchestrator",
          label: "tool Bash — until ! gh pr checks 738 | grep -q pending; do sleep 30; done",
          at: "2026-08-28T12:00:00.000Z",
          iteration: 1,
          run: "run",
        },
        {
          stage: "orchestrator",
          label: "rate limit rejected",
          at: "2026-08-28T12:00:01.000Z",
          iteration: 1,
          run: "run",
        },
      ],
      issues: [{ issue: 690, state: "active", pr: null, draft: false, title: null, detail: null, block: null, at: "2026-08-28T12:00:00.000Z" }],
      failureReason: null,
      observedAt: "2026-08-28T12:00:02.000Z",
    };

    expect(activeWarning(presence, Date.parse(presence.observedAt))).toBe("rate limited, retrying");
    expect(currentStep(presence)?.action).toBe("waiting for CI");
    expect(workflowPhase(presence).index).toBe(4);
    const rendered = renderPresence(presence, Date.parse(presence.observedAt));
    expect(rendered).toContain("RAFA / AGENT WATCH");
    expect(rendered).toContain("RATE LIMITED");
    expect(rendered).toContain("ISSUES");
    expect(rendered).toContain("#690");
    expect(renderPresence(presence, Date.parse(presence.observedAt), false, 180, 40)).toContain(
      "─".repeat(178),
    );
  });

  it("drops the rate-limit warning once the runner moves on, and ignores quota reports", () => {
    const at = (second: number) => `2026-08-28T12:00:0${second}.000Z`;
    type Recent = PresenceSnapshot["recent"][number];
    const item = (label: string, second: number, stage: Recent["stage"] = "orchestrator"): Recent => ({
      stage,
      label,
      at: at(second),
      iteration: 1,
      run: "run",
    });
    const presence = (recent: PresenceSnapshot["recent"]): PresenceSnapshot => ({
      loop: "rafa",
      run: "run",
      status: "running",
      supervisor: "alive",
      issue: 690,
      branch: "rafa/690",
      iteration: { index: 1, max: 100 },
      actors: [],
      recent,
      issues: [],
      failureReason: null,
      observedAt: at(9),
    });
    const now = Date.parse(at(9));

    expect(activeWarning(presence([item("rate limit allowed", 1)]), now)).toBeNull();
    expect(activeWarning(presence([item("rate limit allowed_warning", 1)]), now)).toBeNull();
    expect(activeWarning(presence([item("rate limit overage", 1)]), now)).toBeNull();
    expect(
      activeWarning(presence([item("rate limit rejected", 1), item("thinking — ok", 2)]), now),
    ).toBeNull();
    expect(
      activeWarning(
        presence([item("rate limit rejected", 1), item("text — hi", 2, "executor")]),
        now,
      ),
    ).toBe("rate limited, retrying");
    expect(
      currentStep(presence([item("tool Bash — bun run typecheck", 1), item("rate limit allowed", 2)]))
        ?.action,
    ).toBe("running typecheck");
  });

  it("prints the recorded stop reason instead of presenting it as the last step", () => {
    const presence: PresenceSnapshot = {
      loop: "ralph",
      run: "run",
      status: "failed",
      supervisor: "dead",
      issue: 673,
      branch: "ralph/673",
      iteration: { index: 2, max: 100 },
      actors: [],
      recent: [],
      issues: [],
      failureReason: "iteration 2 ended without a sigil; see ralph/logs/iter-2.log",
      observedAt: "2026-08-28T12:00:02.000Z",
    };

    const rendered = renderPresence(presence, Date.parse(presence.observedAt));
    expect(rendered).toContain("STOPPED");
    expect(rendered).toContain("iteration 2 ended without a sigil");
    expect(rendered).not.toContain("LAST SEEN");
  });
});

describe("the roster, as the observer reads it", () => {
  it("still reads a loop's own branch when its worktree's config names no roster", () => {
    const root = mkdtempSync(join(tmpdir(), "ralph-observer-no-roster-"));
    roots.push(root);
    expect(rosterOrOwn(root, "rafa")).toEqual(["rafa"]);
    expect(issueFromBranch("rafa/812-offline-sync", rosterOrOwn(root, "rafa"))).toBe(812);
    expect(rosterOrOwn(root, undefined)).toEqual([]);
  });

  // The branch pattern derives from the project's roster; a loop the roster
  // names must be readable here without this file being told about it.
  it.each(LOGGD_LOOPS)("reads the ticket out of a '%s/<n>-…' branch", (loop) => {
    expect(issueFromBranch(`${loop}/701-push-registration`, LOGGD_LOOPS)).toBe(701);
    expect(issueFromBranch(`${loop}/701`, LOGGD_LOOPS)).toBe(701);
  });

  it("does not read a ticket out of a branch nobody in the roster owns", () => {
    expect(issueFromBranch("feat/701-push-registration", LOGGD_LOOPS)).toBeNull();
    expect(issueFromBranch(null, LOGGD_LOOPS)).toBeNull();
    // Another project's roster: its loops' branches are its own.
    expect(issueFromBranch("ralph/701-push-registration", ["nova"])).toBeNull();
    expect(issueFromBranch("nova/701-push-registration", ["nova"])).toBe(701);
  });

  it.each(LOGGD_LOOPS)("attributes a journal entry signed by '%s' to that loop and no other", (loop) => {
    const root = mkdtempSync(join(tmpdir(), "ralph-observer-roster-"));
    roots.push(root);
    const journal = () => [
      {
        name: "20260907T090000Z-701-a1b.md",
        body: `# 2026-09-07 — #701: Register any device — MERGED\n\n**Outcome: merged.** Loop: **${loop}**. Ticket #701 closed, PR **#800** squash-merged.\n`,
      },
    ];
    expect(readIssueHistory(root, loop, null, 5, journal)).toEqual([
      expect.objectContaining({ issue: 701, state: "merged", pr: 800 }),
    ]);
    const other = LOGGD_LOOPS.find((name) => name !== loop) ?? loop;
    expect(readIssueHistory(root, other, null, 5, journal)).toEqual([]);
  });
});

describe("workflowPhase reads who is working, not what they typed", () => {
  const stageActor = (
    stage: PresenceSnapshot["actors"][number]["stage"],
    state: PresenceSnapshot["actors"][number]["state"],
    lastAction: string | null = null,
  ): PresenceSnapshot["actors"][number] => ({
    stage,
    state,
    invocation: null,
    runner: null,
    model: null,
    startedAt: "2026-09-15T21:41:00.000Z",
    endedAt: state === "running" ? null : "2026-09-15T21:45:00.000Z",
    lastAction,
    activityAt: "2026-09-15T21:45:00.000Z",
  });

  const activity = (stage: PresenceSnapshot["actors"][number]["stage"], label: string) => ({
    stage,
    label,
    at: "2026-09-15T21:44:00.000Z",
    iteration: 1,
    run: "ralph-run-test",
  });

  it("calls a running executor implement, whatever commands it runs", () => {
    // Write, typecheck, test, fix IS the executor's inner loop. Reading the
    // phase off the command made ralph's #875 iteration report "verify and
    // fix" while it was still writing route handlers, because it had run the
    // suite once and `recent` holds 200 events.
    const presence: PresenceSnapshot = {
      ...presenceFixture,
      actors: [stageActor("executor", "running", "tool Bash — bun x eslint src/app/api/route.test.ts")],
      recent: [
        activity("executor", "tool Bash — bun run typecheck 2>&1 | tail -40"),
        activity("executor", "tool Bash — bun run test src/app/api/v1/users/me 2>&1 | tail -80"),
        activity("executor", "tool Bash — bun x eslint src/app/api/route.test.ts"),
      ],
    };

    expect(workflowPhase(presence)).toEqual({ index: 2, total: 5, label: "implement" });
  });

  it("does not tick Review for an iteration that never reviewed", () => {
    // The rails draw a check for every phase below the index, so a wrong 4
    // asserts a completed Review as fact. That is the part an operator acts on.
    const presence: PresenceSnapshot = {
      ...presenceFixture,
      actors: [stageActor("executor", "running")],
      recent: [activity("executor", "tool Bash — bun run test 2>&1 | tail -80")],
    };

    expect(workflowPhase(presence).index).toBeLessThan(3);
  });

  it("stays in review while a review stage is running", () => {
    const presence: PresenceSnapshot = {
      ...presenceFixture,
      actors: [stageActor("executor", "completed"), stageActor("review.spec", "running")],
      recent: [activity("executor", "tool Bash — bun run test 2>&1 | tail -80")],
    };

    expect(workflowPhase(presence)).toEqual({ index: 3, total: 5, label: "review" });
  });

  it("moves past review once its stages have run, even when the fix is delegated", () => {
    // Fixes are typed by the executor, so a second executor after review is
    // still verify-and-fix — the phase is where the iteration is, not who is
    // holding the keyboard.
    const presence: PresenceSnapshot = {
      ...presenceFixture,
      actors: [
        stageActor("review.standards", "completed"),
        stageActor("review.spec", "completed"),
        stageActor("executor", "running"),
      ],
      recent: [activity("orchestrator", "text — applying the review findings")],
    };

    expect(workflowPhase(presence)).toEqual({ index: 4, total: 5, label: "verify and fix" });
  });

  it("reads gates the orchestrator runs itself as verify and fix", () => {
    // The action test survives as the fallback for exactly this: no stage is
    // running, and the orchestrator is checking its own work.
    const presence: PresenceSnapshot = {
      ...presenceFixture,
      recent: [activity("orchestrator", "tool Bash — bun run typecheck 2>&1 | tail -40")],
    };

    expect(workflowPhase(presence)).toEqual({ index: 4, total: 5, label: "verify and fix" });
  });

  it("keeps 'applying review fixes' in verify, not review", () => {
    // It names the phase after review; matching it on the word "review" would
    // walk the rail backwards.
    const presence: PresenceSnapshot = {
      ...presenceFixture,
      recent: [activity("orchestrator", "tool Bash — python3 fix.py src/app/api/route.ts")],
    };

    expect(currentStep(presence)?.action).toBe("applying review fixes");
    expect(workflowPhase(presence).index).toBe(4);
  });
});
