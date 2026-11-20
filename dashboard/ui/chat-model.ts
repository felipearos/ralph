/**
 * The unblocker chat panel's rules (spec #251, #256), pure so they are tested
 * without a browser: when Talk is offered, what the stream's events draw as,
 * and which of the panel's buttons may be pressed in which state.
 *
 * The server is the authority on every one of these. The panel only avoids
 * offering what the server would refuse anyway, and shows the server's own
 * reason when it refuses regardless: a Fix switch refused with 409 is a
 * message on the panel, not a button that silently did nothing.
 */
import type {
  ChatEvent,
  ChatEventsPage,
  ChatMode,
  ChatStatus,
  ChatView,
  DashboardLoop,
  FrontierView,
  HandbackOutcome,
  HandbackResult,
  HandbackStep,
  StartedChat,
  StopAndFixAnswer,
} from "../contracts";
import { HANDBACK_STEPS } from "../contracts";
import type { CommandError } from "./command-model";

/* ----------------------------------------------------------- where Talk is */

/** The stop kinds a loop records when it parks itself on something a person has to settle. */
const HALTING_STATUSES: ReadonlySet<DashboardLoop["loopStatus"]> = new Set(["blocked", "failed", "interrupted"]);

/**
 * Whether a loop card offers Talk: the loop is halted or stopped, so there is
 * a finished iteration to fork and nobody is talking to it already.
 *
 * A live supervisor is never "halted", whatever its last stop reason says:
 * the chat forks a FINISHED session and never one in flight (spec #251's
 * non-goals). A stuck ticket of a running loop is still offered, from the
 * backlog's row (`blockingLoop`), where Stop & fix is the way into Fix.
 */
export function talkOnCard(entry: Pick<DashboardLoop, "present" | "worktree" | "supervisor" | "stopReason" | "stage" | "loopStatus">): boolean {
  if (!entry.present || entry.worktree === null) return false;
  if (entry.supervisor === "alive") return false;
  return entry.stopReason !== null || entry.stage === "stopped" || HALTING_STATUSES.has(entry.loopStatus);
}

/** `ralph-blocked` → `ralph`; anything that is not a block label → null. */
export function loopOfBlockLabel(label: string | null): string | null {
  if (label === null || !label.endsWith("-blocked")) return null;
  const loop = label.slice(0, -"-blocked".length);
  return loop === "" ? null : loop;
}

/**
 * The loop whose `<loop>-blocked` label a stuck ticket wears, when it is on
 * the roster: the loop a stuck row's Talk opens a chat with.
 *
 * A stuck reason carries no label of its own, so it is looked up wherever the
 * frontier names one — the stuck bucket, the blocked bucket, the ready groups
 * and the tree. A label naming a loop off the roster has no checkout to fork
 * a session in, so it offers no Talk rather than a chat the server refuses.
 */
export function blockingLoop(view: FrontierView, ticket: number, roster: readonly string[]): string | null {
  const labels: (string | null)[] = [
    ...view.stuck.filter((entry) => entry.number === ticket).map((entry) => entry.label),
    ...view.blocked.filter((entry) => entry.number === ticket).map((entry) => entry.stuck),
    ...view.ready.flatMap((group) => group.tickets.filter((entry) => entry.number === ticket).map((entry) => entry.stuck)),
    ...treeLabels(view, ticket),
  ];
  for (const label of labels) {
    const loop = loopOfBlockLabel(label);
    if (loop !== null && roster.includes(loop)) return loop;
  }
  return null;
}

function treeLabels(view: FrontierView, ticket: number): (string | null)[] {
  const found: (string | null)[] = [];
  const walk = (nodes: FrontierView["tree"][number]["roots"]): void => {
    for (const node of nodes) {
      if (node.number === ticket) found.push(node.stuck);
      walk(node.children);
    }
  };
  for (const group of view.tree) {
    if (group.spec?.number === ticket) found.push(group.spec.stuck);
    walk(group.roots);
  }
  return found;
}

/* --------------------------------------------------------------- the header */

const ITERATION_STAMP = /iter-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.log/;

/**
 * The header's one line about where the chat's session came from.
 *
 * The server names the iteration by its log (`iter-<stamp>.log → supervisor-<run>.log`);
 * the iteration's number is not on the wire, so the stamp it opened at is
 * what identifies it. A fresh session says why there was none to resume, in
 * the server's words: that is the thing an operator needs to judge how much
 * the agent will remember.
 */
export function sourceLine(chat: Pick<StartedChat, "session" | "source" | "why">): { resumed: boolean; text: string } {
  if (chat.session === null) {
    return { resumed: false, text: `Fresh session — no resumable session: ${chat.why ?? "the server gave no reason"}` };
  }
  const stamp = chat.source === null ? null : ITERATION_STAMP.exec(chat.source);
  const iteration = stamp === null ? "the halting iteration" : `iteration ${stamp[1]}-${stamp[2]}-${stamp[3]} ${stamp[4]}:${stamp[5]}:${stamp[6]} UTC`;
  return { resumed: true, text: `Resumed from ${iteration} · forked from session ${chat.session.slice(0, 8)}` };
}

/* ---------------------------------------------------------- the transcript */

/** One readable piece of an `agent` line: claude's stream-json, already redacted. */
export type AgentPiece =
  | { kind: "text"; text: string }
  /** `text` is the one-line summary; `input` the whole call, for the expanded card. */
  | { kind: "tool"; text: string; id: string | null; name: string; input: string }
  /** `text` is the first line; `full` the whole result, capped, for the expanded card. */
  | { kind: "tool-result"; text: string; error: boolean; id: string | null; full: string }
  | { kind: "result"; text: string; error: boolean }
  | { kind: "stderr"; text: string }
  | { kind: "raw"; text: string };

const firstLine = (text: string, max = 160): string => {
  const line = text.split("\n").find((part) => part.trim() !== "")?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** What a tool call was asked to do, in one short line: its command, path or pattern. */
function toolInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const fields = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "url", "query"]) {
    if (typeof fields[key] === "string") return firstLine(fields[key]);
  }
  return "";
}

/** The most of a tool's input or result an expanded card shows. */
export const TOOL_TEXT_MAX = 4000;

const capped = (text: string): string => (text.length > TOOL_TEXT_MAX ? `${text.slice(0, TOOL_TEXT_MAX - 1)}…` : text);

function resultBody(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { text: string } => typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text)
    .join("\n");
}

function resultText(content: unknown): string {
  return firstLine(resultBody(content));
}

function inputText(input: unknown): string {
  if (input === undefined) return "";
  try {
    return capped(JSON.stringify(input, null, 2));
  } catch {
    return "";
  }
}

const idOf = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/**
 * The pieces one `agent` event draws as. A line that is not stream-json — a
 * CLI that printed plain text, or a `[stderr]` line — is shown as it came,
 * because every byte of it has crossed the redactor. Bookkeeping (the
 * `system` init, thinking blocks) draws as nothing.
 */
export function agentPieces(line: string): AgentPiece[] {
  if (line.startsWith("[stderr] ")) return [{ kind: "stderr", text: line.slice("[stderr] ".length) }];
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line.trim() === "" ? [] : [{ kind: "raw", text: line }];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [{ kind: "raw", text: line }];
  const fields = parsed as Record<string, unknown>;
  if (fields.type === "assistant" || fields.type === "user") {
    const content = (fields.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return [];
    const pieces: AgentPiece[] = [];
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const part = block as Record<string, unknown>;
      if (part.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
        pieces.push({ kind: "text", text: part.text });
      } else if (part.type === "tool_use" && typeof part.name === "string") {
        const input = toolInput(part.input);
        pieces.push({ kind: "tool", text: input === "" ? part.name : `${part.name} · ${input}`, id: idOf(part.id), name: part.name, input: inputText(part.input) });
      } else if (part.type === "tool_result") {
        pieces.push({
          kind: "tool-result",
          text: resultText(part.content),
          error: part.is_error === true,
          id: idOf(part.tool_use_id),
          full: capped(resultBody(part.content)),
        });
      }
    }
    return pieces;
  }
  if (fields.type === "result") {
    const error = fields.is_error === true || (typeof fields.subtype === "string" && fields.subtype !== "success");
    const cost = typeof fields.total_cost_usd === "number" ? ` · $${fields.total_cost_usd.toFixed(2)}` : "";
    return [{ kind: "result", text: error ? `turn ended: ${String(fields.subtype ?? "error")}${cost}` : `turn finished${cost}`, error }];
  }
  return [];
}

/**
 * What an answer draws as: its pieces, with each tool call and the result
 * that answers it folded into one card. A result is matched to its call by
 * `tool_use_id`. A result with no call in this answer is dropped unless it
 * failed, which draws as a card of its own. A call with no result is running
 * while the answer is open, and done once its turn has ended.
 */
export type AnswerBlock =
  | Exclude<AgentPiece, { kind: "tool" } | { kind: "tool-result" }>
  | { kind: "tool"; summary: string; name: string; input: string; output: string | null; state: "running" | "done" | "error" };

export function answerBlocks(pieces: readonly AgentPiece[], open = false): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  const calls = new Map<string, Extract<AnswerBlock, { kind: "tool" }>>();
  for (const piece of pieces) {
    if (piece.kind === "tool") {
      const block: Extract<AnswerBlock, { kind: "tool" }> = { kind: "tool", summary: piece.text, name: piece.name, input: piece.input, output: null, state: "running" };
      if (piece.id !== null) calls.set(piece.id, block);
      blocks.push(block);
    } else if (piece.kind === "tool-result") {
      const call = piece.id === null ? undefined : calls.get(piece.id);
      if (call === undefined) {
        if (piece.error) blocks.push({ kind: "tool", summary: piece.text || "refused", name: "tool", input: "", output: piece.full, state: "error" });
        continue;
      }
      call.output = piece.full;
      call.state = piece.error ? "error" : "done";
    } else {
      blocks.push(piece);
    }
  }
  if (!open) for (const block of blocks) if (block.kind === "tool" && block.state === "running") block.state = "done";
  return blocks;
}

export type StatusTone = "neutral" | "good" | "warn" | "bad" | "info";

/**
 * What the panel draws, in stream order.
 *
 * - `operator`: what the operator typed; `fix` when a `fix-turn` marker came
 *   ahead of it, so the badge says under which rails the turn ran.
 * - `seed`: the evidence the first turn sent, collapsed by default.
 * - `agent`: one turn's answer, every `agent` line up to the `turn-end`.
 * - `status`: `mode`, `stop`, `handback` and `withheld`, each a line of its own.
 */
export type Entry =
  | { kind: "operator"; seq: number; at: string; text: string; fix: boolean }
  | { kind: "seed"; seq: number; at: string; text: string }
  | { kind: "agent"; seq: number; at: string; pieces: AgentPiece[]; fix: boolean; open: boolean }
  | { kind: "status"; seq: number; at: string; source: "mode" | "stop" | "handback" | "withheld"; tone: StatusTone; label: string; text: string };

const HANDBACK_TONE: Record<HandbackOutcome, StatusTone> = {
  asked: "info",
  confirmed: "info",
  done: "good",
  already: "neutral",
  skipped: "neutral",
  refused: "warn",
  failed: "bad",
};

export const HANDBACK_STEP_LABEL: Record<HandbackStep, string> = {
  draft: "Draft",
  decision: "Decision",
  worktree: "Worktree",
  comment: "Comment",
  label: "Label",
  journal: "Journal",
  restart: "Restart",
};

/** Fold the stream into what the panel draws. */
export function transcript(events: readonly ChatEvent[]): Entry[] {
  const entries: Entry[] = [];
  let fix = false;
  let answer: Extract<Entry, { kind: "agent" }> | null = null;
  const close = (): void => {
    if (answer !== null) answer.open = false;
    answer = null;
  };
  for (const event of events) {
    switch (event.kind) {
      case "fix-turn":
        fix = true;
        break;
      case "operator":
        close();
        entries.push({ kind: "operator", seq: event.seq, at: event.at, text: event.text, fix });
        break;
      case "seed":
        entries.push({ kind: "seed", seq: event.seq, at: event.at, text: event.text });
        break;
      case "agent": {
        if (answer === null) {
          answer = { kind: "agent", seq: event.seq, at: event.at, pieces: [], fix, open: true };
          entries.push(answer);
        }
        answer.pieces.push(...agentPieces(event.text));
        break;
      }
      case "turn-end":
        close();
        fix = false;
        break;
      case "withheld":
        close();
        fix = false;
        entries.push({ kind: "status", seq: event.seq, at: event.at, source: "withheld", tone: "bad", label: "Withheld", text: event.text });
        break;
      case "mode":
        entries.push({
          kind: "status",
          seq: event.seq,
          at: event.at,
          source: "mode",
          tone: event.mode === "fix" ? "warn" : "info",
          label: event.mode === "fix" ? "Fix" : "Ask",
          text: event.text,
        });
        break;
      case "stop":
        entries.push({ kind: "status", seq: event.seq, at: event.at, source: "stop", tone: "info", label: "Stop & fix", text: event.text });
        break;
      case "handback": {
        // The draft and the decision are summaries, and a summary is shown
        // whole where it is edited; the stream says only that it happened.
        const outcome = event.outcome ?? "done";
        const step = event.step ?? "draft";
        entries.push({
          kind: "status",
          seq: event.seq,
          at: event.at,
          source: "handback",
          tone: HANDBACK_TONE[outcome],
          label: `${HANDBACK_STEP_LABEL[step]} · ${outcome}`,
          text: event.text,
        });
        break;
      }
    }
  }
  return entries;
}

/**
 * Each step of the latest Unblock & resume, as the stream reports it: the
 * steps after the newest `decision`, the last word on each, in the order the
 * sequence runs them. Empty before any confirm.
 */
export function handbackProgress(events: readonly ChatEvent[]): { step: HandbackStep; outcome: HandbackOutcome; why: string }[] {
  let from = -1;
  events.forEach((event, at) => {
    if (event.kind === "handback" && event.step === "decision") from = at;
  });
  if (from === -1) return [];
  const last = new Map<HandbackStep, { outcome: HandbackOutcome; why: string }>();
  for (const event of events.slice(from + 1)) {
    if (event.kind !== "handback" || event.step === undefined || event.outcome === undefined) continue;
    last.set(event.step, { outcome: event.outcome, why: event.text });
  }
  return HANDBACK_STEPS.filter((step) => last.has(step)).map((step) => ({ step, ...last.get(step)! }));
}

/* --------------------------------------------------------------- the state */

export type ChatConnection = "connecting" | "open" | "reconnecting" | "gone";

/** What the operator is waiting on from the server, one request at a time. */
export type ChatPending = "start" | "turn" | "mode" | "stop" | "draft" | "confirm" | "close";

/**
 * Unblock & resume's own steps, on the page: ask for a draft, edit it, arm
 * the confirm, send it. `refused`/`failed` keep the text, so a dirty worktree
 * cleaned up in Fix can be handed back again without retyping.
 */
export type HandbackStage =
  | { stage: "closed" }
  | { stage: "drafting" }
  | { stage: "editing"; text: string; note: string | null }
  | { stage: "armed"; text: string }
  | { stage: "sending"; text: string }
  | { stage: "answered"; text: string; result: HandbackResult };

export interface ChatState {
  connection: ChatConnection;
  chat: StartedChat | null;
  loop: string | null;
  ticket: number | null;
  mode: ChatMode;
  stopping: boolean;
  handingBack: boolean;
  status: ChatStatus | null;
  events: ChatEvent[];
  /** The sequence the next poll asks after. */
  next: number;
  /** The newest event held when the last turn was sent. */
  turnFrom: number;
  pending: ChatPending | null;
  /** The last write that failed: the server's refusal in its own words, or the page's own (`Network`, `LocalOnly`, `Malformed`). */
  refusal: CommandError | null;
  /** The last Stop & fix answer that did not switch: `pending`, `refused`, `unknown`. */
  stop: StopAndFixAnswer | null;
  handback: HandbackStage;
}

export const initialChat: ChatState = {
  connection: "connecting",
  chat: null,
  loop: null,
  ticket: null,
  mode: "ask",
  stopping: false,
  handingBack: false,
  status: null,
  events: [],
  next: 0,
  turnFrom: 0,
  pending: null,
  refusal: null,
  stop: null,
  handback: { stage: "closed" },
};

export type ChatAction =
  | { type: "started"; chat: StartedChat }
  | { type: "view"; view: ChatView }
  | { type: "page"; page: ChatEventsPage }
  | { type: "connection"; connection: ChatConnection }
  | { type: "pending"; pending: ChatPending }
  | { type: "refused"; error: CommandError }
  | { type: "settled" }
  /** A turn was taken (202): the agent is answering until the stream says otherwise. */
  | { type: "sent" }
  | { type: "reset" }
  | { type: "stop-answer"; answer: StopAndFixAnswer }
  | { type: "confirm-begin" }
  | { type: "confirm-failed"; error: CommandError }
  | { type: "handback-open" }
  | { type: "drafted"; text: string; note: string | null }
  | { type: "handback-edit"; text: string }
  | { type: "handback-arm" }
  | { type: "handback-disarm" }
  | { type: "handback-answer"; result: HandbackResult }
  | { type: "handback-close" };

/** Events after the newest held, in order: a re-delivered page or a view never doubles a line. */
function merge(held: ChatEvent[], incoming: readonly ChatEvent[]): ChatEvent[] {
  const last = held.at(-1)?.seq ?? 0;
  const fresh = incoming.filter((event) => event.seq > last);
  return fresh.length === 0 ? held : held.concat(fresh);
}

export function reduceChat(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "started":
      return { ...state, chat: action.chat, pending: null, refusal: null };
    case "view": {
      const { view } = action;
      const events = merge(state.events, view.events);
      return {
        ...state,
        chat: { id: view.id, session: view.session, source: view.source, why: view.why },
        loop: view.loop,
        ticket: view.ticket,
        mode: view.mode,
        stopping: view.stopping,
        handingBack: view.handingBack,
        status: view.status,
        events,
        next: Math.max(state.next, events.at(-1)?.seq ?? 0),
      };
    }
    case "page": {
      const events = merge(state.events, action.page.events);
      // A `mode` event is the mode now in force, so the pill follows the
      // stream without waiting on the next view.
      const moded = [...action.page.events].reverse().find((event) => event.mode !== undefined);
      return {
        ...state,
        connection: "open",
        events,
        next: Math.max(state.next, action.page.next),
        status: action.page.status,
        mode: moded?.mode ?? state.mode,
      };
    }
    case "connection":
      return { ...state, connection: action.connection };
    case "pending":
      return { ...state, pending: action.pending, refusal: null, turnFrom: action.pending === "turn" ? (state.events.at(-1)?.seq ?? 0) : state.turnFrom };
    case "refused":
      return { ...state, pending: null, refusal: action.error };
    case "settled":
      return { ...state, pending: null };
    case "sent": {
      // Unless the stream already carried the turn's end: a quick answer's
      // page can land before the 202 does, and must not be overwritten.
      const ended = state.events.some((event) => event.seq > state.turnFrom && (event.kind === "turn-end" || event.kind === "withheld"));
      return { ...state, pending: null, status: state.status === "idle" && !ended ? "running" : state.status };
    }
    case "reset":
      return initialChat;
    case "confirm-begin":
      return beginConfirm(state)?.state ?? state;
    case "confirm-failed":
      return confirmFailed(state, action.error);
    case "stop-answer":
      return {
        ...state,
        pending: null,
        mode: action.answer.mode,
        stopping: action.answer.stopping,
        stop: action.answer.outcome === "fix" ? null : action.answer,
      };
    case "handback-open":
      return { ...state, handback: { stage: "drafting" }, pending: "draft", refusal: null };
    case "drafted":
      return { ...state, pending: null, handback: { stage: "editing", text: action.text, note: action.note } };
    case "handback-edit":
      return state.handback.stage === "editing" || state.handback.stage === "armed" || state.handback.stage === "answered"
        ? { ...state, handback: { stage: "editing", text: action.text, note: null } }
        : state;
    case "handback-arm":
      return state.handback.stage === "editing" && state.handback.text.trim() !== ""
        ? { ...state, handback: { stage: "armed", text: state.handback.text } }
        : state;
    case "handback-disarm":
      return state.handback.stage === "armed" ? { ...state, handback: { stage: "editing", text: state.handback.text, note: null } } : state;
    case "handback-answer":
      return {
        ...state,
        pending: null,
        handback: { stage: "answered", text: "text" in state.handback ? state.handback.text : "", result: action.result },
      };
    case "handback-close":
      return { ...state, handback: { stage: "closed" } };
  }
}

/** The send a confirmed handback carries, with the stage moved to `sending`. */
export function beginConfirm(state: ChatState): { state: ChatState; summary: string } | null {
  if (state.handback.stage !== "armed") return null;
  const summary = state.handback.text.trim();
  return { state: { ...state, pending: "confirm", refusal: null, handback: { stage: "sending", text: state.handback.text } }, summary };
}

/** Restore the editor after a confirm the server refused outright (a 4xx/5xx, not a step). */
export function confirmFailed(state: ChatState, error: CommandError): ChatState {
  const text = "text" in state.handback ? state.handback.text : "";
  return { ...state, pending: null, refusal: error, handback: { stage: "editing", text, note: null } };
}

/* ------------------------------------------------------------- the buttons */

export interface Control {
  enabled: boolean;
  /** Why it is not, in the operator's terms; null when it is. */
  why: string | null;
}

export interface ChatControls {
  composer: Control;
  /** Switch to Fix: confirmed first, refused by the server with its reason while the loop runs. */
  fix: Control;
  /** Back to Ask: always allowed, unconfirmed. */
  ask: Control;
  /** Shown only while the loop's supervisor is alive and the chat is in Ask. */
  stopAndFix: Control & { shown: boolean; label: string };
  unblock: Control;
  /** A one-line status the panel shows above the composer, or null. */
  banner: { tone: StatusTone; text: string } | null;
}

const on: Control = { enabled: true, why: null };
const off = (why: string): Control => ({ enabled: false, why });

/**
 * Which buttons may be pressed, given the chat and whether the loop's
 * supervisor is alive (`live`, from the dashboard's own poll).
 *
 * One request at a time: a turn, a mode switch, a stop or a handback in
 * flight disables the rest, as the server would refuse them (409) anyway.
 */
export function chatControls(state: ChatState, live: boolean): ChatControls {
  const ended =
    state.status === "withheld"
      ? "the chat's output was withheld; start a new one"
      : state.status === "closed" || state.connection === "gone"
        ? "this chat has ended; start a new one"
        : state.chat === null
          ? "the chat is starting"
          : null;
  const busy =
    state.pending === "turn" || state.status === "running"
      ? "the agent is answering"
      : state.pending === "stop"
        ? "stopping — waiting for the iteration boundary"
        : state.handingBack || state.pending === "confirm"
          ? "handing back to the loop"
          : state.pending === "draft"
            ? "drafting the decision summary"
            : state.pending !== null
              ? "waiting on the server"
              : null;
  const blocked = ended ?? busy;

  const fixWhileLive = state.mode === "fix" && live ? "the loop is running again: Fix needs a stopped loop — go back to Ask, or Stop & fix" : null;
  const composer = blocked !== null ? off(blocked) : fixWhileLive !== null ? off(fixWhileLive) : on;

  const fix =
    state.mode === "fix"
      ? off("the chat is in Fix")
      : blocked !== null
        ? off(blocked)
        : state.stopping
          ? off("a Stop & fix is waiting on the iteration boundary")
          : live
            ? off("the loop is running: Fix needs a stopped loop — use Stop & fix")
            : on;
  const ask = state.mode === "ask" ? off("the chat is in Ask") : blocked !== null ? off(blocked) : on;

  const stopShown = state.mode === "ask" && (live || state.stopping);
  const stopAndFix = {
    shown: stopShown,
    ...(blocked !== null ? off(blocked) : on),
    label: state.pending === "stop" ? "Stopping — waiting for the iteration boundary" : state.stopping ? "Keep waiting for the stop" : "Stop & fix",
  };

  const unblock =
    blocked !== null
      ? off(blocked)
      : state.handback.stage !== "closed" && state.handback.stage !== "answered"
        ? off("the decision is being written")
        : on;

  const banner: ChatControls["banner"] =
    state.pending === "stop" || (state.stopping && state.pending === null && state.stop === null)
      ? { tone: "info", text: "Stopping — waiting for the iteration boundary" }
      : state.stop !== null
        ? {
            tone: state.stop.outcome === "pending" ? "info" : "warn",
            text:
              state.stop.outcome === "pending"
                ? `Fix pending: ${state.stop.why}. Still in Ask; press again to keep waiting on the same stop.`
                : `Stop & fix ${state.stop.outcome}: ${state.stop.why}. Still in Ask.`,
          }
        : fixWhileLive !== null
          ? { tone: "warn", text: fixWhileLive }
          : null;

  return { composer, fix, ask, stopAndFix, unblock, banner };
}

/* ------------------------------------------------------------ the requests */

/**
 * The paths the panel reads, relative to the project; `api()` scopes them.
 * Its writes are `command-model.ts` routes, sent through `send`.
 */
export const chatPaths = {
  view: (id: string) => `/api/chat/${encodeURIComponent(id)}`,
  events: (id: string, after: number) => `/api/chat/${encodeURIComponent(id)}/events?after=${after}`,
};

/** The body each mode switch sends: Fix carries the server's `confirm`. */
export const modeBody = (mode: ChatMode): Record<string, unknown> => (mode === "fix" ? { mode, confirm: true } : { mode });

/** Whether a page carries something the view has and the stream does not: `stopping`, `handingBack`. */
export const pageNeedsView = (page: ChatEventsPage): boolean =>
  page.events.some((event) => event.kind === "stop" || event.kind === "handback" || event.kind === "mode" || event.kind === "withheld");
