/**
 * The design preview's unblocker chat: `chat-routes.ts`'s routes over canned
 * answers, in memory, so the panel can be clicked through (and smoke-tested,
 * `ui/chat.e2e.test.ts`) without a `claude` or a redactor.
 *
 * It answers the same shapes the real routes do (`contracts.ts`'s chat
 * section) and refuses the same way: Fix without `confirm` is a 400, Fix
 * beside a live supervisor a 409 `SupervisorAlive`, a turn while one runs a
 * 409. Nothing here touches a loop but the preview's own in-memory copy,
 * through the callbacks `preview.ts` hands it.
 *
 * Two canned branches make the refusal paths visible: a summary containing
 * the word `dirty` is refused at the worktree step with two dirty paths, and
 * a turn containing `fail` ends in a withheld chat.
 */
import type {
  ChatEvent,
  ChatEventsPage,
  ChatMode,
  ChatStatus,
  ChatView,
  HandbackOutcome,
  HandbackResult,
  HandbackStep,
  HandbackStepResult,
  Liveness,
  StartedChat,
  StopAndFixAnswer,
} from "./contracts";

export interface PreviewChatLoops {
  /** The loop's halt, or null when it is not on the roster. */
  find: (loop: string) => { worktree: string; supervisor: Liveness; halted: boolean; ticket: number | null } | null;
  /** The soft stop Stop & fix sends: the preview loop's supervisor goes. */
  stop: (loop: string) => void;
  /** The restart a handback ends with. */
  start: (loop: string) => void;
}

interface FakeChat {
  view: Omit<ChatView, "events">;
  events: ChatEvent[];
  waiters: (() => void)[];
  turns: number;
}

/** How long the fake agent "thinks" before it answers, so the pane shows a turn in flight. */
const THINK_MS = 400;
/** How long Stop & fix's fake boundary takes. */
const BOUNDARY_MS = 1500;
const POLL_MS = 25_000;

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const refuse = (status: number, error: string, message: string): Response => json({ error, message }, status);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const assistant = (text: string): string => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
const toolUse = (name: string, input: Record<string, string>): string =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
const result = (text: string): string => JSON.stringify({ type: "result", subtype: "success", result: text, total_cost_usd: 0.04 });

/** The canned reply to a turn: the reason the fixture loop halted, as the agent would tell it. */
const REPLY =
  "(preview) I stopped because the gate failed three times on the same test: `media-mode.test.ts` times out waiting for the poster grid. " +
  "I believe it is a real regression from my change, not a flake — the timeout only appears with the new lazy loader. " +
  "If you agree, I will revert the lazy loader for posters and keep it for backdrops.";

const DRAFT =
  "What was wrong: the gate failed three times on media-mode.test.ts; the lazy poster loader regressed the grid.\n" +
  "What was decided: revert the lazy loader for posters only; keep it for backdrops.\n" +
  "What the loop should do next: resume the ticket, revert the poster path, rerun the gate.";

export function createPreviewChat(loops: PreviewChatLoops) {
  const chats = new Map<string, FakeChat>();

  const emit = (chat: FakeChat, kind: ChatEvent["kind"], text: string, extra: Partial<ChatEvent> = {}): void => {
    chat.events.push({ seq: chat.events.length + 1, at: new Date().toISOString(), kind, text, ...extra });
    chat.waiters.splice(0).forEach((wake) => wake());
  };
  const viewOf = (chat: FakeChat): ChatView => ({ ...chat.view, events: [...chat.events] });
  const page = (chat: FakeChat, after: number): ChatEventsPage => ({
    events: chat.events.filter((event) => event.seq > after),
    next: Math.max(after, chat.events.at(-1)?.seq ?? 0),
    status: chat.view.status,
  });
  const setStatus = (chat: FakeChat, status: ChatStatus): void => {
    chat.view.status = status;
    chat.waiters.splice(0).forEach((wake) => wake());
  };
  const setMode = (chat: FakeChat, mode: ChatMode, why: string): void => {
    if (chat.view.mode === mode) return;
    chat.view.mode = mode;
    const label = mode === "fix" ? "Fix mode: the loop's executor rails, in its worktree" : "Ask mode: read-only tools";
    emit(chat, "mode", `${label} — ${why}`, { mode });
  };
  const handback = (chat: FakeChat, step: HandbackStep, outcome: HandbackOutcome, text: string): HandbackStepResult => {
    emit(chat, "handback", text, { step, outcome });
    return { step, outcome, why: text };
  };

  async function turn(chat: FakeChat, text: string): Promise<void> {
    setStatus(chat, "running");
    if (chat.view.mode === "fix") emit(chat, "fix-turn", `the next turn runs under the executor's rails, in ${chat.view.loop}'s worktree`, { mode: "fix" });
    if (chat.turns === 0) {
      emit(
        chat,
        "seed",
        [
          "```operator-chat",
          `The operator is talking to you from the dashboard about ${chat.view.loop}'s block. This is a ${chat.view.session === null ? "FRESH session" : "fork of your session"}; nothing reaches the loop unless the operator hands it back.`,
          `Stop reason: blocked — The gate failed three times on the same test.`,
          "Iteration log tail: bun run test exited 1 — media-mode.test.ts timed out after 30000ms",
          "```",
        ].join("\n"),
      );
    }
    chat.turns += 1;
    emit(chat, "operator", text);
    await sleep(THINK_MS);
    if (!chats.has(chat.view.id)) return;
    emit(chat, "agent", JSON.stringify({ type: "system", subtype: "init", session_id: `fork-${chat.view.id}` }));
    if (/\bfail\b/i.test(text)) {
      emit(chat, "withheld", "output withheld: the redactor exited before the turn's end marker (preview)");
      setStatus(chat, "withheld");
      return;
    }
    chat.view.fork ??= `fork-${chat.view.id}`;
    if (chat.view.mode === "fix") {
      emit(chat, "agent", toolUse("Edit", { file_path: "src/media/poster-grid.tsx" }));
      emit(chat, "agent", assistant("(preview) Reverted the lazy loader for posters. The worktree has the change uncommitted."));
    } else {
      emit(chat, "agent", toolUse("Bash", { command: "git log --oneline -3" }));
      emit(chat, "agent", assistant(REPLY));
    }
    emit(chat, "agent", result("ok"));
    emit(chat, "turn-end", "");
    setStatus(chat, "idle");
  }

  async function stopAndFix(chat: FakeChat): Promise<StopAndFixAnswer> {
    const answer = (outcome: StopAndFixAnswer["outcome"], why: string): StopAndFixAnswer => ({ outcome, why, mode: chat.view.mode, stopping: chat.view.stopping });
    if (chat.view.mode === "fix") return answer("fix", "the chat is already in Fix");
    const loop = loops.find(chat.view.loop);
    if (loop === null) return answer("unknown", "the loop is not on the roster");
    if (loop.supervisor !== "alive") {
      setMode(chat, "fix", "the loop's supervisor is not running");
      return answer("fix", "the loop's supervisor is not running");
    }
    chat.view.stopping = true;
    emit(chat, "stop", "stopping — waiting for the iteration boundary", { mode: chat.view.mode });
    await sleep(BOUNDARY_MS);
    loops.stop(chat.view.loop);
    chat.view.stopping = false;
    emit(chat, "stop", "the supervisor exited at the iteration boundary", { mode: chat.view.mode });
    setMode(chat, "fix", "the supervisor exited at the iteration boundary");
    return answer("fix", "the supervisor exited at the iteration boundary");
  }

  async function confirm(chat: FakeChat, summary: string): Promise<HandbackResult> {
    chat.view.handingBack = true;
    const steps: HandbackStepResult[] = [];
    const base = { loop: chat.view.loop, ticket: chat.view.ticket, checkout: null, restart: null };
    try {
      handback(chat, "decision", "confirmed", summary);
      await sleep(150);
      if (/\bdirty\b/i.test(summary)) {
        const dirty = ["src/media/poster-grid.tsx", "src/media/lazy.ts"];
        steps.push(handback(chat, "worktree", "refused", `${dirty.length} uncommitted paths outside .ralph/`));
        return { ...base, outcome: "refused", step: "worktree", why: `${dirty.length} uncommitted paths outside .ralph/`, steps, dirty };
      }
      steps.push(handback(chat, "worktree", "done", "the worktree is clean and detached"));
      if (chat.view.ticket === null) {
        steps.push(handback(chat, "comment", "skipped", "no ticket"), handback(chat, "label", "skipped", "no ticket"));
      } else {
        steps.push(handback(chat, "comment", "done", `posted the operator decision on #${chat.view.ticket} (preview: nothing was posted)`));
        steps.push(handback(chat, "label", "done", `removed ${chat.view.loop}-blocked (preview)`));
      }
      steps.push(handback(chat, "journal", "done", "published the journal entry (preview)"));
      loops.start(chat.view.loop);
      steps.push(handback(chat, "restart", "done", `started ${chat.view.loop} (preview: nothing was started)`));
      return { ...base, outcome: "resumed", step: null, why: `${chat.view.loop} is running again`, steps, dirty: [] };
    } finally {
      chat.view.handingBack = false;
    }
  }

  const busy = (chat: FakeChat): Response | null =>
    chat.view.status === "withheld"
      ? refuse(409, "ChatWithheld", "this chat's output was withheld; start a new one")
      : chat.view.status === "running"
        ? refuse(409, "TurnInFlight", "a turn is still running; wait for its answer")
        : chat.view.handingBack
          ? refuse(409, "HandbackInFlight", "an unblock & resume is running")
          : null;

  const fixRefusal = (chat: FakeChat): Response | null => {
    const loop = loops.find(chat.view.loop);
    if (loop?.supervisor === "dead") return null;
    return loop?.supervisor === "alive"
      ? refuse(409, "SupervisorAlive", `${chat.view.loop}'s supervisor is running: Fix needs a stopped loop — use Stop & fix, which stops it at the iteration boundary`)
      : refuse(409, "SupervisorUnknown", `${chat.view.loop}'s supervisor could not be read, and cannot tell is not stopped`);
  };

  const body = async (request: Request): Promise<Record<string, unknown>> => {
    const value: unknown = await request.json().catch(() => null);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  };

  /** Answer a chat path, or null when the path is not one. */
  return async function handle(request: Request, pathname: string): Promise<Response | null> {
    if (pathname === "/api/chat") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
      const fields = await body(request);
      const name = typeof fields.loop === "string" ? fields.loop : "";
      const loop = loops.find(name);
      if (loop === null) return refuse(404, "UnknownLoop", `no loop '${name}' in the roster`);
      const ticket = typeof fields.ticket === "number" ? fields.ticket : null;
      const id = crypto.randomUUID().slice(0, 12);
      // A halt resolves to the halting iteration's session; a ticket, in the
      // preview, to nothing — so both of the header's readings can be seen.
      const started: StartedChat =
        ticket === null && loop.halted
          ? { id, session: "5f0c2a9e-7d41-4b8e-9c55-0a6f1e2d3b4c", source: "iter-20261007T105001.log → supervisor-run-remo-01.log", why: null }
          : { id, session: null, source: null, why: `none of the newest 40 iteration logs records a block of #${ticket ?? "?"} by '${name}' (preview)` };
      chats.set(id, {
        view: {
          ...started,
          loop: name,
          ticket: ticket ?? loop.ticket,
          handingBack: false,
          mode: "ask",
          stopping: false,
          status: "idle",
          fork: null,
          transcript: `${loop.worktree}/.ralph/logs/chat-${id}.jsonl`,
          transcriptProblem: null,
        },
        events: [],
        waiters: [],
        turns: 0,
      });
      return json(started, 201);
    }
    const match = /^\/api\/chat\/([^/]+)(\/turn|\/events|\/mode|\/stop-and-fix|\/handback)?$/.exec(pathname);
    if (match === null) return null;
    const chat = chats.get(decodeURIComponent(match[1]!));
    if (chat === undefined) return refuse(404, "UnknownChat", "no such chat: it ended, or the dashboard restarted");
    const tail = match[2];

    if (tail === undefined) {
      if (request.method === "DELETE") {
        chats.delete(chat.view.id);
        chat.view.status = "closed";
        chat.waiters.splice(0).forEach((wake) => wake());
        return new Response(null, { status: 204 });
      }
      return json(viewOf(chat));
    }
    if (tail === "/events") {
      const after = Number(new URL(request.url).searchParams.get("after") ?? "0");
      if (chat.events.some((event) => event.seq > after)) return json(page(chat, after));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, POLL_MS);
        const wake = (): void => {
          clearTimeout(timer);
          resolve();
        };
        chat.waiters.push(wake);
        request.signal.addEventListener("abort", wake, { once: true });
      });
      return json(page(chat, after));
    }
    if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
    const fields = await body(request);

    if (tail === "/turn") {
      const text = typeof fields.text === "string" ? fields.text.trim() : "";
      if (text === "") return refuse(400, "InvalidRequest", "'text' is required: there is nothing to say to the agent");
      const refused = busy(chat) ?? (chat.view.mode === "fix" ? fixRefusal(chat) : null);
      if (refused !== null) return refused;
      void turn(chat, text);
      return new Response(null, { status: 202 });
    }
    if (tail === "/mode") {
      if (fields.mode === "ask") {
        setMode(chat, "ask", "the operator went back to Ask");
        return json(viewOf(chat));
      }
      if (fields.mode !== "fix") return refuse(400, "InvalidRequest", "'mode' must be one of ask, fix");
      if (fields.confirm !== true) return refuse(400, "ConfirmationRequired", 'Fix runs the agent under the loop\'s executor rails: send it with "confirm": true');
      const refused = busy(chat) ?? fixRefusal(chat);
      if (refused !== null) return refused;
      setMode(chat, "fix", "the loop's supervisor is not running");
      return json(viewOf(chat));
    }
    if (tail === "/stop-and-fix") {
      if (fields.confirm !== true) return refuse(400, "ConfirmationRequired", 'stop & fix stops the loop: send it with "confirm": true');
      return json(await stopAndFix(chat));
    }
    // `/handback`
    const refused = busy(chat);
    if (refused !== null) return refused;
    if (fields.draft === true) {
      handback(chat, "draft", "asked", "asked the agent for an operator-decision summary");
      await sleep(THINK_MS);
      emit(chat, "agent", assistant(DRAFT));
      emit(chat, "turn-end", "");
      handback(chat, "draft", "done", DRAFT);
      return json({ draft: DRAFT });
    }
    const summary = typeof fields.summary === "string" ? fields.summary.trim() : "";
    if (summary === "") return refuse(400, "InvalidRequest", "'summary' is required");
    if (fields.confirm !== true) return refuse(400, "ConfirmationRequired", 'unblock & resume starts the loop: send it with "confirm": true');
    return json(await confirm(chat, summary));
  };
}
