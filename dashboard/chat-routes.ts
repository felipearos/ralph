/**
 * The unblocker chat over HTTP, under `/api/p/:project/`.
 *
 *   POST   /api/chat                   `{ loop, ticket? }` → `{ id, session, source, why }`
 *   POST   /api/chat/:id/turn          `{ text }` → 202; the answer arrives on the stream
 *   GET    /api/chat/:id/events?after= the stream, long-polled
 *   GET    /api/chat/:id               the chat and everything said in it
 *   DELETE /api/chat/:id               end it and release what it holds
 *   POST   /api/chat/:id/mode          `{ mode: "fix", confirm: true }` | `{ mode: "ask" }`
 *   POST   /api/chat/:id/stop-and-fix  `{ confirm: true }` → stop at the boundary, then Fix
 *   POST   /api/chat/:id/handback      `{ draft: true }` → `{ draft }`, the agent's decision summary;
 *                                       `{ summary, confirm: true }` → Unblock & resume (`chat-handback.ts`)
 *
 * The turn route answers 202 rather than the answer itself: a turn takes as
 * long as a model does, and a request held open for it would be
 * indistinguishable from a hung one. The operator's page reads `events`, which
 * holds its poll open until there is something to report — the same shape the
 * output pane uses, long-polled rather than SSE because a chat's events are
 * few, ordered and individually meaningful.
 *
 * Three ways to be unknown, three refusals. An unknown PROJECT never reaches
 * here: `server.ts` answers it before the scoped handler is built. An unknown
 * LOOP is `targetFor`'s 404, the one every write route already gives. An
 * unknown CHAT ID is `ChatSessions`' own 404 — ids are minted here and held in
 * memory, so an id nobody issued is not a chat whatever it looks like.
 *
 * A KNOWN but different project is the fourth, and it is not free: one
 * `ChatSessions` serves every project's handler, so the chat is stamped with
 * the project that started it and `ChatSessions.get` refuses another's. Without
 * that, `GET /api/p/<other>/chat/<id>` would answer with this project's
 * transcript.
 */
import { ControlRouteError, invalid, json, optionalText, readBody } from "./command-requests";
import type { Dashboard } from "./contracts";
import { CHAT_MODES, ChatError, type ChatMode, type ChatSessions, type ChatTarget, type HandbackStep } from "./chat";
import { fixGate, stopForFix, type FixFactory, type StopForFixOutcome } from "./chat-fix";
import { handBack, type HandbackResult } from "./chat-handback";
import type { HandbackAdapter } from "./chat-handback-adapter";
import type { ChatEvidence } from "./chat-seed";
import { targetFor } from "./control-routes";

export const CHAT_PATH = "/api/chat";
const CHAT_ID_PATH = /^\/api\/chat\/([^/]+)(\/turn|\/events|\/mode|\/stop-and-fix|\/handback)?$/;
/** Unblock & resume starts a loop, so `server.ts` gates it on a ready project as it gates Start. */
export const HANDBACK_PATH = /^\/api\/chat\/[^/]+\/handback$/;

/** The longest summary a handback posts: a decision, not a transcript. */
export const HANDBACK_SUMMARY_CHARS = 8_000;

/** How long a poll with nothing to say waits before answering empty. */
export const CHAT_POLL_MS = 25_000;

export interface ChatRouteOptions {
  chats: ChatSessions;
  dashboard: () => Promise<Dashboard>;
  /** The project this handler serves; a chat belongs to exactly one. */
  project?: string;
  pollMs?: number;
  /**
   * The loop's control and lifecycle adapters, as the lifecycle routes build
   * them: what Fix's supervisor check and Stop & fix's soft stop run against
   * (`chat-fix.ts`). Absent, Fix is refused — a gate that cannot read the
   * supervisor does not open.
   */
  fix?: FixFactory;
  /**
   * What Unblock & resume writes through for a loop: the ticket's `gh` calls
   * and the journal publisher (`chat-handback-adapter.ts`). Absent — or with
   * no `fix` to restart the loop through — the handback is refused.
   */
  handback?: HandbackFactory;
  now?: () => Date;
}

/** The handback's adapter, executor and all, for one loop's checkout. */
export type HandbackFactory = (target: { loop: string; worktree: string }) => HandbackAdapter;

export type HandbackRequestBody = { kind: "draft" } | { kind: "confirm"; summary: string };

/** What Stop & fix answered: `fix` once the chat switched, else why it did not. */
export interface StopAndFixAnswer {
  outcome: "fix" | Exclude<StopForFixOutcome, "exited">;
  why: string;
  mode: ChatMode;
  /** A stop is still out, and a re-issue waits on it rather than sending another. */
  stopping: boolean;
}

export const isChatPath = (pathname: string): boolean => pathname === CHAT_PATH || CHAT_ID_PATH.test(pathname);

/** `{ loop, ticket? }`: which loop, and the ticket when the block is a ticket's. */
export function parseStart(body: unknown): { loop: string; target: ChatTarget } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("the request body must be a JSON object");
  const fields = body as Record<string, unknown>;
  const loop = optionalText(fields, "loop");
  if (loop === null) throw invalid("'loop' is required: name the loop whose block this chat is about");
  const ticket = fields.ticket;
  if (ticket === undefined || ticket === null) return { loop, target: { kind: "halt" } };
  if (typeof ticket !== "number" || !Number.isInteger(ticket) || ticket <= 0) {
    throw invalid("'ticket' must be a positive issue number");
  }
  return { loop, target: { kind: "ticket", ticket } };
}

export function parseTurn(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("the request body must be a JSON object");
  const text = optionalText(body as Record<string, unknown>, "text");
  if (text === null) throw invalid("'text' is required: there is nothing to say to the agent");
  return text;
}

/** `{ mode }`, and for Fix the same `confirm: true` every other write route asks for. */
export function parseMode(body: unknown): ChatMode {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("the request body must be a JSON object");
  const fields = body as Record<string, unknown>;
  const mode = optionalText(fields, "mode");
  if (mode === null || !(CHAT_MODES as readonly string[]).includes(mode)) {
    throw invalid(`'mode' must be one of ${CHAT_MODES.join(", ")}`);
  }
  if (mode === "fix" && fields.confirm !== true) {
    throw new ControlRouteError(
      400,
      "ConfirmationRequired",
      'Fix runs the agent under the loop\'s executor rails, in its worktree, able to edit it: send it with "confirm": true',
    );
  }
  return mode as ChatMode;
}

/** `{ confirm: true, why? }`: Stop & fix stops a loop, so it is confirmed like restart. */
export function parseStopAndFix(body: unknown): { why: string | null } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("the request body must be a JSON object");
  const fields = body as Record<string, unknown>;
  if (fields.confirm !== true) {
    throw new ControlRouteError(
      400,
      "ConfirmationRequired",
      'stop & fix stops the loop at its next iteration boundary and then switches the chat to Fix: send it with "confirm": true',
    );
  }
  return { why: optionalText(fields, "why") };
}

/**
 * `{ draft: true }` asks the chat for a summary; `{ summary, confirm: true }`
 * hands the block back. The confirmation is the server's, as for every write
 * route: this one comments on a ticket, publishes a journal entry and starts
 * a loop.
 */
export function parseHandback(body: unknown): HandbackRequestBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("the request body must be a JSON object");
  const fields = body as Record<string, unknown>;
  if (fields.draft === true) return { kind: "draft" };
  const summary = optionalText(fields, "summary");
  if (summary === null) {
    throw invalid("'summary' is required: the operator's decision, as the ticket and the journal will carry it (or send \"draft\": true for one)");
  }
  if (summary.length > HANDBACK_SUMMARY_CHARS) throw invalid(`'summary' is longer than ${HANDBACK_SUMMARY_CHARS} characters`);
  if (fields.confirm !== true) {
    throw new ControlRouteError(
      400,
      "ConfirmationRequired",
      'unblock & resume comments on the ticket, drops its block label, publishes a journal entry and starts the loop: send it with "confirm": true',
    );
  }
  return { kind: "confirm", summary };
}

const methodNotAllowed = (allow: string): Response => new Response("method not allowed", { status: 405, headers: { allow } });

/** Answer a chat route, or return null when the path is not one. */
export async function handleChatRoute(request: Request, pathname: string, options: ChatRouteOptions): Promise<Response | null> {
  if (!isChatPath(pathname)) return null;
  try {
    if (pathname === CHAT_PATH) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      const { loop, target } = parseStart(await readBody(request));
      // The roster read is what refuses an unknown loop, and the same call
      // gives the checkout the chat runs in: a loop with no checkout has no
      // worktree to resume a session in, and is refused with that reason.
      const resolved = await targetFor(options.dashboard, loop);
      const dashboard = await options.dashboard();
      const started = options.chats.start(
        { name: resolved.loop, worktree: resolved.worktree, stopReason: stopReasonOf(dashboard, resolved.loop) },
        target,
        options.project ?? null,
        evidenceOf(dashboard, resolved.loop, target),
      );
      return json(started, 201);
    }

    const [, id, tail] = CHAT_ID_PATH.exec(pathname)!;
    const chat = decodeURIComponent(id!);

    const project = options.project ?? null;

    if (tail === "/turn") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      const text = parseTurn(await readBody(request));
      // Asked again before EVERY Fix turn, not only at the switch: a loop
      // started again after the switch is a running loop, and a Fix turn
      // beside it is two writers in one worktree.
      if (options.chats.view(chat, project).mode === "fix") await requireStopped(chat, options);
      options.chats.send(chat, text, project);
      return new Response(null, { status: 202 });
    }

    if (tail === "/mode") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      const mode = parseMode(await readBody(request));
      if (mode === "ask") return json(options.chats.setMode(chat, "ask", "the operator went back to Ask", project));
      await requireStopped(chat, options);
      return json(options.chats.setMode(chat, "fix", "the loop's supervisor is not running", project));
    }

    if (tail === "/stop-and-fix") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      const { why } = parseStopAndFix(await readBody(request));
      return json((await stopAndFix(chat, why, options)) satisfies StopAndFixAnswer);
    }

    if (tail === "/handback") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      const asked = parseHandback(await readBody(request));
      if (asked.kind === "draft") {
        // The draft is a turn like any other, so a Fix chat's is gated like one.
        if (options.chats.view(chat, project).mode === "fix") await requireStopped(chat, options);
        return json({ draft: await options.chats.draft(chat, project) });
      }
      return json((await handBackChat(chat, asked.summary, options)) satisfies HandbackResult);
    }

    if (tail === undefined && request.method === "DELETE") {
      options.chats.close(chat, project);
      return new Response(null, { status: 204 });
    }

    if (request.method !== "GET") return methodNotAllowed(tail === undefined ? "GET, DELETE" : "GET");

    if (tail === "/events") {
      const after = Number(new URL(request.url).searchParams.get("after") ?? "0");
      if (!Number.isInteger(after) || after < 0) throw invalid("'after' must be a sequence number");
      return json(await options.chats.waitSince(chat, after, options.pollMs ?? CHAT_POLL_MS, request.signal, project));
    }

    return json(options.chats.view(chat, project));
  } catch (error) {
    if (error instanceof ChatError || error instanceof ControlRouteError) {
      return json({ error: error.name, message: error.message }, error.status);
    }
    throw error;
  }
}

/** The chat's loop, resolved through the roster, and the deps Fix's checks run against. */
async function fixDepsFor(chat: string, options: ChatRouteOptions): Promise<Parameters<typeof fixGate>[0]> {
  const project = options.project ?? null;
  if (options.fix === undefined) {
    throw new ChatError(409, "FixUnavailable", "this dashboard cannot read the loop's supervisor, so Fix is not available");
  }
  const target = await targetFor(options.dashboard, options.chats.view(chat, project).loop);
  return {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...options.fix(target),
    loop: target.loop,
  };
}

/** Refuse with 409 and the reason unless the loop's supervisor is gone. */
async function requireStopped(chat: string, options: ChatRouteOptions): Promise<void> {
  const gate = await fixGate(await fixDepsFor(chat, options));
  if (!gate.open) throw new ChatError(409, gate.liveness === "alive" ? "SupervisorAlive" : "SupervisorUnknown", gate.why);
}

/**
 * Stop & fix: one soft stop, a wait for the boundary, and Fix once the
 * supervisor has gone. Every step is marked on the chat's stream, so the
 * operator's page shows "stopping" while this request is still waiting.
 */
async function stopAndFix(chat: string, why: string | null, options: ChatRouteOptions): Promise<StopAndFixAnswer> {
  const project = options.project ?? null;
  const chats = options.chats;
  const answer = (outcome: StopAndFixAnswer["outcome"], said: string): StopAndFixAnswer => {
    const view = chats.view(chat, project);
    return { outcome, why: said, mode: view.mode, stopping: view.stopping };
  };
  if (chats.view(chat, project).mode === "fix") return answer("fix", "the chat is already in Fix");
  const deps = await fixDepsFor(chat, options);
  const { key, send } = chats.beginStop(chat, project);
  let result: Awaited<ReturnType<typeof stopForFix>>;
  try {
    result = await stopForFix(deps, {
      key,
      send,
      why,
      onWaiting: () => chats.markStop(chat, "stopping — waiting for the iteration boundary", false, project),
    });
  } catch (error) {
    // Nothing is known to be out there to wait on: the next press starts over.
    if (send) chats.markStop(chat, `the stop could not be sent: ${error instanceof Error ? error.message : String(error)}`, true, project);
    throw error;
  }
  switch (result.outcome) {
    case "exited":
      chats.markStop(chat, result.why, true, project);
      chats.setMode(chat, "fix", result.why, project);
      return answer("fix", result.why);
    case "pending":
      // Still out: a re-issue waits on this stop and sends no other.
      chats.markStop(chat, `${result.why}; still in Ask`, false, project);
      return answer("pending", result.why);
    case "unknown":
      // Settled only when this press was the one to send: an earlier stop is
      // still out there, and the next press must keep waiting on it.
      chats.markStop(chat, `${result.why}; still in Ask`, send, project);
      return answer("unknown", result.why);
    case "refused":
      chats.markStop(chat, `${result.why}; still in Ask`, true, project);
      return answer("refused", result.why);
  }
}

/**
 * Unblock & resume for one chat: the confirmed summary, through
 * `chat-handback.ts`'s sequence, with every step marked on the chat.
 *
 * The chat is claimed for the length of it, so a second confirm — a double
 * click — is refused rather than racing the first to an empty ticket and
 * posting twice; and no turn runs in the worktree while it is checked.
 */
async function handBackChat(chat: string, summary: string, options: ChatRouteOptions): Promise<HandbackResult> {
  const project = options.project ?? null;
  const chats = options.chats;
  if (options.handback === undefined || options.fix === undefined) {
    throw new ChatError(409, "HandbackUnavailable", "this dashboard cannot write to the ticket or start the loop, so it cannot hand back");
  }
  const view = chats.view(chat, project);
  const target = await targetFor(options.dashboard, view.loop);
  const panel = (await options.dashboard()).loops.find((entry) => entry.loop === target.loop);
  chats.beginHandback(chat, project);
  try {
    // What an earlier attempt finished, as the transcript says: the journal is
    // published once however often the operator retries.
    const done = new Set<HandbackStep>(
      view.events.flatMap((event) =>
        event.kind === "handback" && event.step !== undefined && (event.outcome === "done" || event.outcome === "already") ? [event.step] : [],
      ),
    );
    chats.markHandback(chat, "decision", "confirmed", summary, project);
    return await handBack(
      {
        ...options.fix(target),
        ...(options.now === undefined ? {} : { now: options.now }),
        loop: target.loop,
        handback: options.handback(target),
      },
      {
        chat,
        role: panel?.role ?? "coder",
        ticket: view.ticket,
        summary,
        transcript: view.transcript,
        session: view.fork ?? view.session,
        stamp: chats.handbackStamp(chat, project),
        done,
        mark: (step, outcome, why) => chats.markHandback(chat, step, outcome, why, project),
      },
    );
  } finally {
    chats.endHandback(chat, project);
  }
}

/** The loop's stop reason, which is what resolution reads for a halt and the seed quotes. */
function stopReasonOf(dashboard: Dashboard, loop: string): { kind: string; why: string; at: string } | null {
  const panel = dashboard.loops.find((entry) => entry.loop === loop);
  const stop = panel?.stopReason ?? null;
  return stop === null ? null : { kind: stop.kind, why: stop.why, at: stop.at };
}

/**
 * What the dashboard has already read about the block, for the seed (#253).
 *
 * Every field comes off the snapshot the page itself is drawn from, so the
 * chat cannot disagree with the card the operator clicked: the block record
 * is the frontier's `stuckReasons` (`block-reason.ts`, newest record wins),
 * and the journal is the loop panel's. A halt names no ticket, so it is
 * about the loop's own. A frontier that was not read leaves the block null,
 * and the seed says it found none rather than inventing one.
 */
export function evidenceOf(dashboard: Dashboard, loop: string, target: ChatTarget): ChatEvidence {
  const panel = dashboard.loops.find((entry) => entry.loop === loop);
  const ticket = target.kind === "ticket" ? target.ticket : (panel?.issue ?? null);
  const stuck = ticket === null ? undefined : dashboard.frontier?.view?.stuckReasons.find((entry) => entry.number === ticket);
  return {
    ticket,
    block:
      stuck === undefined
        ? null
        : { kind: stuck.kind, reason: stuck.reason, pr: stuck.pr, migration: stuck.migration, at: stuck.at },
    journal: panel?.journal ?? null,
  };
}
