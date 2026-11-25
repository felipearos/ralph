// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { ChatEvent, DashboardLoop, FrontierView, HandbackResult, StopAndFixAnswer } from "../contracts";
import {
  agentPieces,
  beginConfirm,
  blockingLoop,
  chatControls,
  confirmFailed,
  handbackProgress,
  initialChat,
  loopOfBlockLabel,
  modeBody,
  pageNeedsView,
  reduceChat,
  sourceLine,
  talkOnCard,
  transcript,
  answerBlocks,
  TOOL_TEXT_MAX,
  type ChatAction,
  type ChatState,
} from "./chat-model";

const apply = (state: ChatState, ...actions: ChatAction[]): ChatState => actions.reduce(reduceChat, state);

let seq = 0;
const event = (kind: ChatEvent["kind"], text = "", extra: Partial<ChatEvent> = {}): ChatEvent => ({
  seq: ++seq,
  at: "2026-10-07T10:00:00.000Z",
  kind,
  text,
  ...extra,
});

/** A chat that has started and been read once: idle, in Ask. */
const ready = (overrides: Partial<ChatState> = {}): ChatState => ({
  ...initialChat,
  connection: "open",
  chat: { id: "c1", session: "abcdef12-3456", source: "iter-20261007T105001.log → supervisor-run.log", why: null },
  loop: "remo",
  ticket: 1040,
  status: "idle",
  ...overrides,
});

const card = (overrides: Partial<Parameters<typeof talkOnCard>[0]> = {}): Parameters<typeof talkOnCard>[0] => ({
  present: true,
  worktree: "/w/remo",
  supervisor: "dead",
  stopReason: { kind: "blocked", why: "the gate failed three times", at: "2026-10-07T09:00:00Z" } as DashboardLoop["stopReason"],
  stage: "stopped",
  loopStatus: "blocked",
  ...overrides,
});

describe("when Talk shows on a loop card", () => {
  it("shows on a halted loop: a stop reason and no supervisor", () => {
    expect(talkOnCard(card())).toBe(true);
    expect(talkOnCard(card({ stopReason: null, stage: "stopped", loopStatus: "completed" }))).toBe(true);
    expect(talkOnCard(card({ stopReason: null, stage: null, loopStatus: "failed" }))).toBe(true);
    expect(talkOnCard(card({ supervisor: "unknown" }))).toBe(true);
  });

  it("does not show on a running loop, whatever its last stop reason says", () => {
    expect(talkOnCard(card({ supervisor: "alive", loopStatus: "running", stage: "iteration" }))).toBe(false);
    expect(talkOnCard(card({ supervisor: "alive" }))).toBe(false);
  });

  it("does not show on an idle loop with nothing halted, nor on a loop with no checkout", () => {
    expect(talkOnCard(card({ stopReason: null, stage: null, loopStatus: "idle" }))).toBe(false);
    expect(talkOnCard(card({ present: false }))).toBe(false);
    expect(talkOnCard(card({ worktree: null }))).toBe(false);
  });
});

const frontier = (overrides: Partial<FrontierView> = {}): FrontierView => ({
  ready: [],
  occupied: [],
  specs: [],
  inFlight: [],
  blocked: [],
  gates: [],
  stuck: [],
  tree: [],
  stuckReasons: [],
  untriaged: [],
  triage: { staffing: 0, routing: 0, intake: 0, oversize: 0, rescue: 0 },
  human: [],
  dropped: [],
  ...overrides,
});

describe("when Talk shows on a stuck-ticket row", () => {
  it("reads the loop off its block label", () => {
    expect(loopOfBlockLabel("ralph-blocked")).toBe("ralph");
    expect(loopOfBlockLabel("pr-medic-blocked")).toBe("pr-medic");
    expect(loopOfBlockLabel("-blocked")).toBeNull();
    expect(loopOfBlockLabel("ready-for-agent")).toBeNull();
    expect(loopOfBlockLabel(null)).toBeNull();
  });

  it("targets the blocking loop, wherever the frontier names the label", () => {
    const view = frontier({
      stuck: [{ number: 1040, title: "Import CSV", label: "remo-blocked" }],
      blocked: [{ number: 1080, title: "Fade", blockers: [1073], stuck: "rafa-blocked" }],
      ready: [{ spec: null, staffingGroup: null, waiting: 0, tickets: [{ number: 1090, title: "x", frees: 0, stuck: "ralph-blocked" }] }],
      tree: [
        {
          spec: null,
          under: null,
          subSpecs: [],
          total: 1,
          complete: false,
          specStillOpen: false,
          roots: [
            {
              number: 1, title: "root", state: "open", stuck: null, detail: null, otherBlockers: [], heldBy: null, frees: 0, human: null,
              children: [{ number: 1219, title: "Region", state: "open", stuck: "rafa-blocked", detail: null, otherBlockers: [], heldBy: null, frees: 0, human: null, children: [] }],
            },
          ],
        },
      ],
    });
    const roster = ["ralph", "rafa", "remo"];
    expect(blockingLoop(view, 1040, roster)).toBe("remo");
    expect(blockingLoop(view, 1080, roster)).toBe("rafa");
    expect(blockingLoop(view, 1090, roster)).toBe("ralph");
    expect(blockingLoop(view, 1219, roster)).toBe("rafa");
  });

  it("offers no Talk for a loop off the roster or a ticket with no block label", () => {
    const view = frontier({ stuck: [{ number: 1040, title: "Import CSV", label: "gone-blocked" }] });
    expect(blockingLoop(view, 1040, ["ralph"])).toBeNull();
    expect(blockingLoop(view, 9999, ["ralph"])).toBeNull();
  });
});

describe("the source header", () => {
  it("says which iteration a resumed chat forked", () => {
    expect(sourceLine({ session: "abcdef12-3456-7890", source: "iter-20261007T105001.log → supervisor-run.log", why: null })).toEqual({
      resumed: true,
      text: "Resumed from iteration 2026-10-07 10:50:01 UTC · forked from session abcdef12",
    });
  });

  it("says why a fresh session had nothing to resume", () => {
    expect(sourceLine({ session: null, source: null, why: "no stop reason recorded" })).toEqual({
      resumed: false,
      text: "Fresh session — no resumable session: no stop reason recorded",
    });
  });
});

describe("the transcript", () => {
  it("draws each event kind distinctly, and badges the turn after a fix-turn", () => {
    const events = [
      event("seed", "```operator-chat\nevidence\n```"),
      event("operator", "why are you blocked?"),
      event("agent", JSON.stringify({ type: "system", subtype: "init", session_id: "fork-1" })),
      event("agent", JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "The gate failed." }] } })),
      event("turn-end"),
      event("mode", "Fix mode: the loop's executor rails — the supervisor is not running", { mode: "fix" }),
      event("fix-turn", "runs under the executor's rails in /w/remo", { mode: "fix" }),
      event("operator", "fix the test"),
      event("agent", JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "a.ts" } }] } })),
      event("turn-end"),
      event("stop", "stopping — waiting for the iteration boundary", { mode: "ask" }),
      event("handback", "comment posted", { step: "comment", outcome: "done" }),
      event("withheld", "output withheld: the redactor exited"),
    ];
    const entries = transcript(events);
    expect(entries.map((entry) => entry.kind)).toEqual(["seed", "operator", "agent", "status", "operator", "agent", "status", "status", "status"]);
    expect(entries[1]).toMatchObject({ kind: "operator", fix: false });
    expect(entries[2]).toMatchObject({ kind: "agent", pieces: [{ kind: "text", text: "The gate failed." }], open: false, fix: false });
    expect(entries[3]).toMatchObject({ kind: "status", source: "mode", label: "Fix", tone: "warn" });
    expect(entries[4]).toMatchObject({ kind: "operator", text: "fix the test", fix: true });
    expect(entries[5]).toMatchObject({ kind: "agent", fix: true, pieces: [{ kind: "tool", text: "Edit · a.ts" }] });
    expect(entries[6]).toMatchObject({ source: "stop", label: "Stop & fix" });
    expect(entries[7]).toMatchObject({ source: "handback", label: "Comment · done", tone: "good" });
    expect(entries[8]).toMatchObject({ source: "withheld", tone: "bad" });
  });

  it("folds each tool call and its result into one card", () => {
    const call = (id: string, name: string, input: unknown) =>
      agentPieces(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } }));
    const result = (id: string, content: unknown, isError = false) =>
      agentPieces(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } }));
    const pieces = [
      ...agentPieces(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Looking." }] } })),
      ...call("t1", "Bash", { command: "git status" }),
      ...call("t2", "Read", { file_path: "a.ts" }),
      ...result("t1", [{ type: "text", text: "clean\nnothing to commit" }]),
      ...result("t2", "denied", true),
      ...call("t3", "Grep", { pattern: "x" }),
      ...result("orphan", "fine"),
      ...result("orphan-error", "boom", true),
    ];
    expect(answerBlocks(pieces, true)).toEqual([
      { kind: "text", text: "Looking." },
      { kind: "tool", summary: "Bash · git status", name: "Bash", input: '{\n  "command": "git status"\n}', output: "clean\nnothing to commit", state: "done" },
      { kind: "tool", summary: "Read · a.ts", name: "Read", input: '{\n  "file_path": "a.ts"\n}', output: "denied", state: "error" },
      { kind: "tool", summary: "Grep · x", name: "Grep", input: '{\n  "pattern": "x"\n}', output: null, state: "running" },
      { kind: "tool", summary: "boom", name: "tool", input: "", output: "boom", state: "error" },
    ]);
    // Once the turn has ended, a call that never answered is no longer running.
    expect(answerBlocks(pieces).find((block) => block.kind === "tool" && block.name === "Grep")).toMatchObject({ state: "done", output: null });
  });

  it("caps a tool's input and result for the expanded card", () => {
    const [piece] = agentPieces(
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "y".repeat(TOOL_TEXT_MAX + 50) }] } }),
    );
    expect(piece).toMatchObject({ kind: "tool-result" });
    expect((piece as { full: string }).full).toHaveLength(TOOL_TEXT_MAX);
  });

  it("keeps an answer open until its turn ends", () => {
    const entries = transcript([event("operator", "hi"), event("agent", "plain text from the CLI")]);
    expect(entries[1]).toMatchObject({ kind: "agent", open: true, pieces: [{ kind: "raw", text: "plain text from the CLI" }] });
  });

  it("reads stream-json into pieces, and anything else as it came", () => {
    expect(agentPieces("[stderr] boom")).toEqual([{ kind: "stderr", text: "boom" }]);
    expect(agentPieces("not json")).toEqual([{ kind: "raw", text: "not json" }]);
    expect(agentPieces(JSON.stringify({ type: "system", subtype: "init" }))).toEqual([]);
    expect(
      agentPieces(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "Permission to use Edit has been denied" }] } })),
    ).toEqual([
      { kind: "tool-result", text: "Permission to use Edit has been denied", error: true, id: null, full: "Permission to use Edit has been denied" },
    ]);
    expect(agentPieces(JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.123 }))).toEqual([
      { kind: "result", text: "turn finished · $0.12", error: false },
    ]);
    expect(agentPieces(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }))).toEqual([
      { kind: "result", text: "turn ended: error_max_turns", error: true },
    ]);
  });

  it("reports the latest handback's steps in order, after its decision", () => {
    const events = [
      event("handback", "first try", { step: "decision", outcome: "confirmed" }),
      event("handback", "dirty: a.ts", { step: "worktree", outcome: "refused" }),
      event("handback", "second try", { step: "decision", outcome: "confirmed" }),
      event("handback", "clean", { step: "worktree", outcome: "done" }),
      event("handback", "posted", { step: "comment", outcome: "done" }),
      event("handback", "no label", { step: "label", outcome: "already" }),
    ];
    expect(handbackProgress(events)).toEqual([
      { step: "worktree", outcome: "done", why: "clean" },
      { step: "comment", outcome: "done", why: "posted" },
      { step: "label", outcome: "already", why: "no label" },
    ]);
    expect(handbackProgress([])).toEqual([]);
  });
});

describe("reduceChat", () => {
  it("merges pages without doubling a re-delivered event, and follows the mode on the stream", () => {
    const one = event("operator", "hi");
    const two = event("mode", "Fix", { mode: "fix" });
    const state = apply(
      ready(),
      { type: "page", page: { events: [one], next: one.seq, status: "running" } },
      { type: "page", page: { events: [one, two], next: two.seq, status: "idle" } },
    );
    expect(state.events.map((entry) => entry.seq)).toEqual([one.seq, two.seq]);
    expect(state).toMatchObject({ mode: "fix", status: "idle", next: two.seq });
  });

  it("keeps a refusal in the server's words until the next request", () => {
    const error = { kind: "SupervisorAlive", message: "ralph's supervisor is running", status: 409 };
    const refused = apply(ready(), { type: "pending", pending: "mode" }, { type: "refused", error });
    expect(refused).toMatchObject({ pending: null, refusal: error });
    expect(reduceChat(refused, { type: "pending", pending: "turn" }).refusal).toBeNull();
  });

  it("walks a handback from draft to answer, and back to the editor on a refused step", () => {
    const drafting = reduceChat(ready(), { type: "handback-open" });
    expect(drafting).toMatchObject({ pending: "draft", handback: { stage: "drafting" } });
    const editing = reduceChat(drafting, { type: "drafted", text: "What was wrong: …", note: null });
    expect(editing.handback).toEqual({ stage: "editing", text: "What was wrong: …", note: null });
    const edited = reduceChat(editing, { type: "handback-edit", text: "Decided: rebaseline." });
    const armed = reduceChat(edited, { type: "handback-arm" });
    expect(armed.handback).toEqual({ stage: "armed", text: "Decided: rebaseline." });
    const confirm = beginConfirm(armed)!;
    expect(confirm.summary).toBe("Decided: rebaseline.");
    expect(confirm.state).toMatchObject({ pending: "confirm", handback: { stage: "sending" } });
    const result: HandbackResult = {
      loop: "remo", outcome: "refused", step: "worktree", why: "dirty", ticket: 1040,
      steps: [{ step: "worktree", outcome: "refused", why: "dirty" }], dirty: ["src/a.ts"], checkout: null, restart: null,
    };
    const answered = reduceChat(confirm.state, { type: "handback-answer", result });
    expect(answered.handback).toMatchObject({ stage: "answered", text: "Decided: rebaseline.", result: { dirty: ["src/a.ts"] } });
    const failed = confirmFailed(confirm.state, { kind: "HandbackInFlight", message: "", status: 409 });
    expect(failed.handback).toEqual({ stage: "editing", text: "Decided: rebaseline.", note: null });
    expect(failed).toMatchObject({ pending: null, refusal: { kind: "HandbackInFlight", status: 409 } });
  });

  it("does not arm an empty summary", () => {
    const editing = reduceChat(ready(), { type: "drafted", text: "", note: "DraftFailed: error_max_turns" });
    expect(editing.handback).toEqual({ stage: "editing", text: "", note: "DraftFailed: error_max_turns" });
    expect(reduceChat(editing, { type: "handback-arm" }).handback.stage).toBe("editing");
    expect(beginConfirm(editing)).toBeNull();
  });
});

const stopAnswer = (outcome: StopAndFixAnswer["outcome"], stopping: boolean): StopAndFixAnswer => ({
  outcome,
  why: outcome === "pending" ? "the supervisor is still running after 2 minutes" : "done",
  mode: outcome === "fix" ? "fix" : "ask",
  stopping,
});

describe("the buttons", () => {
  it("offers Fix on a stopped loop and Stop & fix, not Fix, on a running one", () => {
    const stopped = chatControls(ready(), false);
    expect(stopped.fix.enabled).toBe(true);
    expect(stopped.stopAndFix.shown).toBe(false);
    expect(stopped.composer.enabled).toBe(true);

    const running = chatControls(ready(), true);
    expect(running.fix).toEqual({ enabled: false, why: "the loop is running: Fix needs a stopped loop — use Stop & fix" });
    expect(running.stopAndFix).toMatchObject({ shown: true, enabled: true, label: "Stop & fix" });
    expect(running.composer.enabled).toBe(true);
  });

  it("goes back to Ask at any time, and hides Stop & fix once in Fix", () => {
    const fix = chatControls(ready({ mode: "fix" }), false);
    expect(fix.ask.enabled).toBe(true);
    expect(fix.fix.enabled).toBe(false);
    expect(fix.stopAndFix.shown).toBe(false);
  });

  it("refuses a Fix turn once the loop is running again, and says so", () => {
    const controls = chatControls(ready({ mode: "fix" }), true);
    expect(controls.composer.enabled).toBe(false);
    expect(controls.banner?.tone).toBe("warn");
    expect(controls.ask.enabled).toBe(true);
  });

  it("shows the wait while Stop & fix is out, and Fix pending when the window ran out", () => {
    const waiting = chatControls(ready({ pending: "stop", stopping: true }), true);
    expect(waiting.stopAndFix).toMatchObject({ shown: true, enabled: false, label: "Stopping — waiting for the iteration boundary" });
    expect(waiting.banner).toEqual({ tone: "info", text: "Stopping — waiting for the iteration boundary" });
    expect(waiting.composer.enabled).toBe(false);

    const pending = reduceChat(ready({ pending: "stop" }), { type: "stop-answer", answer: stopAnswer("pending", true) });
    const controls = chatControls(pending, true);
    expect(controls.stopAndFix).toMatchObject({ shown: true, enabled: true, label: "Keep waiting for the stop" });
    expect(controls.banner?.text).toMatch(/^Fix pending: the supervisor is still running after 2 minutes/);
    expect(controls.fix.enabled).toBe(false);

    const switched = reduceChat(pending, { type: "stop-answer", answer: stopAnswer("fix", false) });
    expect(switched).toMatchObject({ mode: "fix", stopping: false, stop: null });
    expect(chatControls(switched, false).composer.enabled).toBe(true);
  });

  it("holds every button while a turn runs or a handback is in flight", () => {
    for (const state of [ready({ status: "running" }), ready({ handingBack: true }), ready({ pending: "confirm" })]) {
      const controls = chatControls(state, false);
      expect(controls.composer.enabled).toBe(false);
      expect(controls.fix.enabled).toBe(false);
      expect(controls.unblock.enabled).toBe(false);
    }
    expect(chatControls(ready({ handingBack: true }), false).unblock.why).toBe("handing back to the loop");
  });

  it("ends everything on a withheld or closed chat", () => {
    expect(chatControls(ready({ status: "withheld" }), false).composer.why).toBe("the chat's output was withheld; start a new one");
    expect(chatControls(ready({ connection: "gone" }), false).unblock.enabled).toBe(false);
    expect(chatControls(initialChat, false).composer.why).toBe("the chat is starting");
  });

  it("offers Unblock & resume while the summary is not already being written", () => {
    expect(chatControls(ready(), false).unblock.enabled).toBe(true);
    expect(chatControls(ready({ handback: { stage: "editing", text: "x", note: null } }), false).unblock.enabled).toBe(false);
  });
});

describe("the requests", () => {
  it("confirms Fix and nothing else", () => {
    expect(modeBody("fix")).toEqual({ mode: "fix", confirm: true });
    expect(modeBody("ask")).toEqual({ mode: "ask" });
  });

  it("re-reads the view after events the stream cannot carry the state of", () => {
    expect(pageNeedsView({ events: [event("agent", "{}")], next: 1, status: "running" })).toBe(false);
    expect(pageNeedsView({ events: [event("stop", "stopping")], next: 1, status: "idle" })).toBe(true);
  });
});
