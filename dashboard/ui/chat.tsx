import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ChevronDown, CircleAlert, History, LifeBuoy, MessageSquare, Send, ShieldAlert, Sparkles, Square, Wrench } from "lucide-react";

import type { ChatEventsPage, ChatMode, ChatView, HandbackResult, StartedChat, StopAndFixAnswer } from "../contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolState } from "@/components/ai-elements/tool";
import { cn } from "@/lib/utils";
import { api } from "./api";
import { CommandNotice, send } from "./command";
import { decodeAnswer, EMPTY_ANSWER, noticeText, type CommandError, type CommandPath, type Result } from "./command-model";
import {
  beginConfirm,
  chatControls,
  chatPaths,
  handbackProgress,
  HANDBACK_STEP_LABEL,
  initialChat,
  modeBody,
  pageNeedsView,
  reduceChat,
  sourceLine,
  transcript,
  answerBlocks,
  type AnswerBlock,
  type ChatPending,
  type ChatState,
  type Entry,
  type StatusTone,
} from "./chat-model";

const TONE_TEXT: Record<StatusTone, string> = {
  neutral: "text-muted-foreground",
  good: "text-status-good",
  warn: "text-status-warn",
  bad: "text-status-bad",
  info: "text-status-info",
};

const TONE_BORDER: Record<StatusTone, string> = {
  neutral: "border-border",
  good: "border-status-good/40",
  warn: "border-status-warn/40",
  bad: "border-status-bad/40",
  info: "border-status-info/40",
};

/** How long a failed poll waits before the next, so a down server is not hammered. */
const RETRY_MS = 3000;

/**
 * One GET of the chat's own state. Reads are not commands, so they stay a
 * plain fetch; the answer is decoded the way a command's is, so a refusal
 * carries the same `CommandError` (and its status, for the 404 → gone check).
 */
async function readChat<T>(path: string, signal?: AbortSignal): Promise<Result<T | null, CommandError>> {
  const response = await fetch(api(path), { cache: "no-store", ...(signal === undefined ? {} : { signal }) });
  return decodeAnswer<T>(response, signal);
}

/** The chat's state and the requests that move it; one chat per sheet, kept across closing it. */
function useChat(loop: string, ticket: number | null, open: boolean) {
  const [state, dispatch] = useReducer(reduceChat, initialChat);
  const id = state.chat?.id ?? null;

  const refresh = useCallback(async (chat: string) => {
    try {
      const answer = await readChat<ChatView>(chatPaths.view(chat));
      if (answer.ok) {
        if (answer.value !== null) dispatch({ type: "view", view: answer.value });
      } else if (answer.error.status === 404) dispatch({ type: "connection", connection: "gone" });
    } catch {
      // The next poll says whether the server is there.
    }
  }, []);

  // Opened the first time: start the chat. Closing the sheet keeps it.
  // A refused start is not retried by itself: "Start a new chat" clears the
  // refusal, which is what runs this again.
  const starting = useRef(false);
  const refused = state.refusal !== null;
  useEffect(() => {
    if (!open || id !== null || starting.current || refused) return;
    starting.current = true;
    dispatch({ type: "pending", pending: "start" });
    (async () => {
      const answer = await send<StartedChat>("/api/chat", ticket === null ? { loop } : { loop, ticket });
      starting.current = false;
      if (!answer.ok) dispatch({ type: "refused", error: answer.error });
      else if (answer.value === null) dispatch({ type: "refused", error: EMPTY_ANSWER });
      else dispatch({ type: "started", chat: answer.value });
    })();
  }, [open, id, loop, ticket, refused]);

  // The stream, long-polled while the chat exists — open or not, so a turn
  // that finishes while the sheet is closed is there when it reopens.
  useEffect(() => {
    if (id === null) return;
    const controller = new AbortController();
    let after = 0;
    void refresh(id);
    (async () => {
      while (!controller.signal.aborted) {
        try {
          const answer = await readChat<ChatEventsPage>(chatPaths.events(id, after), controller.signal);
          if (!answer.ok) {
            if (answer.error.status === 404) {
              dispatch({ type: "connection", connection: "gone" });
              return;
            }
            throw new Error(noticeText(answer.error));
          }
          if (answer.value === null) throw new Error(noticeText(EMPTY_ANSWER));
          dispatch({ type: "page", page: answer.value });
          after = answer.value.next;
          if (pageNeedsView(answer.value)) void refresh(id);
          if (answer.value.status === "withheld" || answer.value.status === "closed") return;
        } catch {
          if (controller.signal.aborted) return;
          dispatch({ type: "connection", connection: "reconnecting" });
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
        }
      }
    })();
    return () => controller.abort();
  }, [id, refresh]);

  /** One write to the chat, with its refusal shown in the server's words; null when it was refused. */
  const request = useCallback(async <T,>(pending: ChatPending, path: CommandPath, chat: string, body: unknown): Promise<{ data: T | null } | null> => {
    dispatch({ type: "pending", pending });
    const answer = await send<T>(path, body, { params: { id: chat } });
    if (answer.ok) return { data: answer.value };
    dispatch({ type: "refused", error: answer.error });
    return null;
  }, []);

  const actions = {
    send: async (text: string): Promise<boolean> => {
      if (id === null) return false;
      // The answer arrives on the stream, which is what holds the composer
      // while the agent is answering.
      const sent = await request<null>("turn", "/api/chat/<id>/turn", id, { text });
      if (sent !== null) dispatch({ type: "sent" });
      return sent !== null;
    },
    mode: async (mode: ChatMode) => {
      if (id === null) return;
      const answer = await request<ChatView>("mode", "/api/chat/<id>/mode", id, modeBody(mode));
      if (answer === null) return;
      if (answer.data !== null) dispatch({ type: "view", view: answer.data });
      dispatch({ type: "settled" });
    },
    stopAndFix: async () => {
      if (id === null) return;
      const answer = await request<StopAndFixAnswer>("stop", "/api/chat/<id>/stop-and-fix", id, { confirm: true });
      if (answer !== null) {
        if (answer.data !== null) dispatch({ type: "stop-answer", answer: answer.data });
        else dispatch({ type: "refused", error: EMPTY_ANSWER });
      }
      void refresh(id);
    },
    /** End this chat and start another: what a withheld or swept chat leaves the operator. */
    restart: async () => {
      // Its failure is not shown: the chat is dropped either way, and the server sweeps an orphan.
      if (id !== null) await send<null>("/api/chat/<id>", undefined, { params: { id } });
      dispatch({ type: "reset" });
    },
    draft: async () => {
      if (id === null) return;
      dispatch({ type: "handback-open" });
      const answer = await send<{ draft: string }>("/api/chat/<id>/handback", { draft: true }, { params: { id } });
      if (answer.ok && answer.value !== null) {
        dispatch({ type: "drafted", text: answer.value.draft, note: null });
        return;
      }
      const error = answer.ok ? EMPTY_ANSWER : answer.error;
      dispatch({ type: "drafted", text: "", note: `${noticeText(error)} — write the decision yourself` });
    },
    confirm: async () => {
      const begun = id === null ? null : beginConfirm(state);
      if (id === null || begun === null) return;
      dispatch({ type: "confirm-begin" });
      const answer = await send<HandbackResult>("/api/chat/<id>/handback", { summary: begun.summary, confirm: true }, { params: { id } });
      if (!answer.ok) dispatch({ type: "confirm-failed", error: answer.error });
      else if (answer.value === null) dispatch({ type: "confirm-failed", error: EMPTY_ANSWER });
      else dispatch({ type: "handback-answer", result: answer.value });
      void refresh(id);
    },
  };

  return { state, dispatch, actions };
}

/* ---------------------------------------------------------------- pieces */

const TOOL_STATE: Record<Extract<AnswerBlock, { kind: "tool" }>["state"], ToolState> = {
  running: "input-available",
  done: "output-available",
  error: "output-error",
};

function Block({ block, streaming }: { block: AnswerBlock; streaming: boolean }) {
  switch (block.kind) {
    case "text":
      return (
        <MessageResponse className="text-sm leading-relaxed break-words" isAnimating={streaming}>
          {block.text}
        </MessageResponse>
      );
    case "tool":
      return (
        <Tool className="mb-0">
          <ToolHeader title={block.summary} state={TOOL_STATE[block.state]} className="gap-2 p-2 text-left [&_span]:truncate [&>div]:min-w-0" />
          <ToolContent className="space-y-3 p-3">
            {block.input !== "" && <ToolInput input={block.input} />}
            <ToolOutput output={block.state === "error" ? null : block.output} errorText={block.state === "error" ? block.output || "refused" : null} />
          </ToolContent>
        </Tool>
      );
    case "result":
      return <p className={cn("font-mono text-[11px]", block.error ? "text-status-bad" : "text-muted-foreground")}>{block.text}</p>;
    case "stderr":
      return <p className="font-mono text-xs break-all text-status-warn">stderr · {block.text}</p>;
    case "raw":
      return <p className="font-mono text-xs break-all text-muted-foreground">{block.text}</p>;
  }
}

function FixBadge() {
  return (
    <Badge variant="outline" className="border-status-warn/40 text-status-warn">
      <Wrench /> Fix
    </Badge>
  );
}

function EntryView({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case "operator":
      return (
        <Message from="user" data-chat="operator" className="max-w-[85%]">
          <MessageContent>
            {entry.fix && <FixBadge />}
            <p className="whitespace-pre-wrap break-words">{entry.text}</p>
          </MessageContent>
        </Message>
      );
    case "seed":
      return (
        <Collapsible data-chat="seed" className="group rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1 text-left select-none">
            <ChevronDown className="size-3 -rotate-90 transition-transform group-data-[state=open]:rotate-0" />
            Evidence sent with the first turn
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 max-h-60 overflow-auto font-mono whitespace-pre-wrap break-words">{entry.text}</pre>
          </CollapsibleContent>
        </Collapsible>
      );
    case "agent":
      return (
        <Message from="assistant" data-chat="agent">
          <MessageContent className="w-full gap-2">
            {entry.fix && <FixBadge />}
            {answerBlocks(entry.pieces, entry.open).map((block, index) => (
              <Block key={index} block={block} streaming={entry.open} />
            ))}
            {entry.open && <p className="animate-pulse text-xs text-muted-foreground">answering…</p>}
          </MessageContent>
        </Message>
      );
    case "status":
      return (
        <div data-chat={entry.source} className={cn("rounded-md border-l-2 py-1 pl-3 text-xs", TONE_BORDER[entry.tone])}>
          <span className={cn("font-medium", TONE_TEXT[entry.tone])}>{entry.label}</span>
          {entry.text !== "" && entry.source === "handback" && entry.label.startsWith("Draft · done") ? (
            <span className="text-muted-foreground"> — summary drafted</span>
          ) : entry.text !== "" && entry.label.startsWith("Decision") ? (
            <span className="text-muted-foreground"> — summary confirmed</span>
          ) : (
            entry.text !== "" && <span className="break-words text-muted-foreground"> — {entry.text}</span>
          )}
        </div>
      );
  }
}

/** Ask or Fix, as a pill: Fix is confirmed before it is asked for, and the server may still refuse it. */
function ModePill({ state, live, onMode }: { state: ChatState; live: boolean; onMode: (mode: ChatMode) => void }) {
  const controls = chatControls(state, live);
  const [arming, setArming] = useState(false);
  useEffect(() => {
    if (state.mode === "fix") setArming(false);
  }, [state.mode]);
  return (
    <div className="space-y-2">
      <ToggleGroup
        type="single"
        size="sm"
        className="inline-flex border p-0.5"
        aria-label="Chat mode"
        value={state.mode}
        // Radix reports "" when the active item is clicked again: the mode stays. Fix is armed, not set, until confirmed.
        onValueChange={(mode) => {
          if (mode === "ask") onMode("ask");
          else if (mode === "fix") setArming(true);
        }}
      >
        <ToggleGroupItem
          value="ask"
          disabled={state.mode !== "ask" && !controls.ask.enabled}
          title={controls.ask.why ?? "Read-only tools"}
          className="h-auto py-1 text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-status-info/15 data-[state=on]:text-status-info"
        >
          Ask
        </ToggleGroupItem>
        <ToggleGroupItem
          value="fix"
          disabled={state.mode !== "fix" && !controls.fix.enabled}
          title={controls.fix.why ?? "The loop's executor rails, in its worktree"}
          className="h-auto py-1 text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-status-warn/15 data-[state=on]:text-status-warn"
        >
          Fix
        </ToggleGroupItem>
      </ToggleGroup>
      {arming && state.mode === "ask" && (
        <div className="space-y-2 rounded-md border border-status-warn/40 p-3 text-xs">
          <p>
            Fix runs the agent under the loop's executor rails, in its worktree, able to edit it. The server checks the loop
            is stopped first.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="destructive"
              disabled={!controls.fix.enabled}
              onClick={() => {
                setArming(false);
                onMode("fix");
              }}
            >
              Switch to Fix
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setArming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Unblock & resume: the draft, the operator's edit, the confirm, and each step's outcome. */
function Handback({
  state,
  onEdit,
  onArm,
  onDisarm,
  onConfirm,
  onClose,
}: {
  state: ChatState;
  onEdit: (text: string) => void;
  onArm: () => void;
  onDisarm: () => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const stage = state.handback;
  const steps = handbackProgress(state.events);
  if (stage.stage === "closed") return null;
  const target = state.ticket === null ? "no ticket" : `#${state.ticket}`;
  return (
    <div data-chat-handback="" className="space-y-2 rounded-lg border border-status-good/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Unblock &amp; resume</p>
        {(stage.stage === "editing" || stage.stage === "answered") && (
          <Button size="xs" variant="ghost" onClick={onClose}>
            Close
          </Button>
        )}
      </div>
      {stage.stage === "drafting" ? (
        <p className="animate-pulse text-xs text-muted-foreground">Asking the agent for a decision summary…</p>
      ) : (
        <>
          {stage.stage === "editing" && stage.note !== null && <p className="text-xs text-status-warn">{stage.note}</p>}
          <Textarea
            aria-label="Decision summary"
            rows={6}
            readOnly={stage.stage === "sending"}
            value={stage.text}
            placeholder="What was wrong, what was decided, what the loop should do next"
            onChange={(event) => onEdit(event.target.value)}
          />
          {stage.stage === "editing" && (
            <Button size="sm" disabled={stage.text.trim() === ""} onClick={onArm}>
              Hand back…
            </Button>
          )}
          {stage.stage === "armed" && (
            <div className="space-y-2 rounded-md border border-status-warn/40 p-2 text-xs">
              <p>
                This posts the summary as an "Operator decision" on {target}, drops <code>{state.loop}-blocked</code>,
                publishes a journal entry and starts {state.loop}.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="xs" onClick={onConfirm}>
                  Confirm &amp; resume
                </Button>
                <Button size="xs" variant="ghost" onClick={onDisarm}>
                  Back to editing
                </Button>
              </div>
            </div>
          )}
          {stage.stage === "sending" && <p className="animate-pulse text-xs text-muted-foreground">Handing back…</p>}
        </>
      )}
      {steps.length > 0 && (
        <ol className="space-y-1 text-xs">
          {steps.map((step) => (
            <li key={step.step} data-step={step.step} className="flex gap-2">
              <span className="w-16 shrink-0 text-muted-foreground">{HANDBACK_STEP_LABEL[step.step]}</span>
              <span
                className={cn(
                  "font-medium",
                  step.outcome === "done" ? "text-status-good" : step.outcome === "refused" ? "text-status-warn" : step.outcome === "failed" ? "text-status-bad" : "text-muted-foreground",
                )}
              >
                {step.outcome}
              </span>
              <span className="min-w-0 break-words text-muted-foreground">{step.why}</span>
            </li>
          ))}
        </ol>
      )}
      {stage.stage === "answered" && (
        <div className="space-y-1 text-xs">
          <p className={cn("font-medium", stage.result.outcome === "resumed" ? "text-status-good" : "text-status-warn")}>
            {stage.result.outcome === "resumed" ? `${stage.result.loop} resumed` : `${stage.result.outcome} at ${stage.result.step ?? "?"}`}: {stage.result.why}
          </p>
          {stage.result.dirty.length > 0 && (
            <div>
              <p className="text-muted-foreground">Uncommitted in the worktree:</p>
              <ul className="font-mono break-all">
                {stage.result.dirty.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- panel */

/**
 * The chat with the agent that hit a block: the loop's own session, forked,
 * talked to over the server's redacted stream (spec #251). Thin: every rule
 * about what may be pressed is `chat-model.ts`'s.
 */
export function ChatSheet({
  loop,
  ticket = null,
  live,
  open,
  onOpenChange,
}: {
  loop: string;
  ticket?: number | null;
  /** The loop's supervisor is alive, from the dashboard's own poll. */
  live: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { state, dispatch, actions } = useChat(loop, ticket, open);
  const [draft, setDraft] = useState("");
  const controls = chatControls(state, live);
  const entries = transcript(state.events);
  const source = state.chat === null ? null : sourceLine(state.chat);
  const submit = async () => {
    const text = draft.trim();
    if (text === "" || !controls.composer.enabled) return;
    setDraft("");
    if (!(await actions.send(text))) setDraft(text);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-4xl" data-chat-panel="">
        <SheetHeader className="gap-2 border-b pr-10">
          <SheetTitle className="flex flex-wrap items-baseline gap-x-2">
            <span>Talk to {loop}</span>
            {(state.ticket ?? ticket) !== null && <span className="font-mono text-sm text-muted-foreground">#{state.ticket ?? ticket}</span>}
          </SheetTitle>
          {/* A div, not Radix's default p: a refusal's problems are a list. */}
          <SheetDescription asChild className="flex items-start gap-1.5 text-xs" data-chat-source="">
            <div>
              {source === null ? (
                state.refusal !== null && state.chat === null ? (
                  <div className="text-status-bad">
                    Could not start: <CommandNotice error={state.refusal} />
                  </div>
                ) : (
                  <span>Resolving the session behind the block…</span>
                )
              ) : (
                <>
                  {source.resumed ? <History className="mt-0.5 size-3.5 shrink-0" /> : <Sparkles className="mt-0.5 size-3.5 shrink-0" />}
                  <span className="min-w-0 break-words" title={state.chat?.source ?? undefined}>
                    {source.text}
                  </span>
                </>
              )}
            </div>
          </SheetDescription>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <ModePill state={state} live={live} onMode={(mode) => void actions.mode(mode)} />
            {controls.stopAndFix.shown && (
              <Button
                size="sm"
                variant="outline"
                disabled={!controls.stopAndFix.enabled}
                title={controls.stopAndFix.why ?? "Soft-stop the loop at its iteration boundary, then switch to Fix"}
                onClick={() => void actions.stopAndFix()}
                className="max-w-full whitespace-normal"
              >
                <Square /> {controls.stopAndFix.label}
              </Button>
            )}
          </div>
        </SheetHeader>

        <Conversation className="min-h-0" data-chat-transcript="">
          <ConversationContent className="gap-4 p-4">
          {entries.length === 0 && state.chat !== null && (
            <p className="text-sm text-muted-foreground">
              Ask why it stopped. The first turn carries the block comment, the stop reason, the journal entry and the
              iteration log's tail. Nothing reaches the loop unless you hand it back.
            </p>
          )}
          {entries.map((entry) => (
            <EntryView key={entry.seq} entry={entry} />
          ))}
          <Handback
            state={state}
            onEdit={(text) => dispatch({ type: "handback-edit", text })}
            onArm={() => dispatch({ type: "handback-arm" })}
            onDisarm={() => dispatch({ type: "handback-disarm" })}
            onConfirm={() => void actions.confirm()}
            onClose={() => dispatch({ type: "handback-close" })}
          />
          </ConversationContent>
          <ConversationScrollButton className="bottom-2" />
        </Conversation>

        <div className="space-y-2 border-t p-4">
          {state.status === "withheld" && (
            <p className="flex items-start gap-1.5 text-xs text-status-bad">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" /> The chat's output could not be redacted, so it was withheld.
            </p>
          )}
          {controls.banner !== null && (
            <p data-chat-banner="" className={cn("text-xs", TONE_TEXT[controls.banner.tone])}>
              {controls.banner.text}
            </p>
          )}
          {(state.status === "withheld" || state.status === "closed" || state.connection === "gone" || (state.chat === null && state.refusal !== null)) && (
            <Button size="xs" variant="outline" onClick={() => void actions.restart()}>
              Start a new chat
            </Button>
          )}
          {state.refusal !== null && state.chat !== null && (
            <div data-chat-refusal="" className="flex items-start gap-1.5 text-xs text-status-bad">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              <div className="min-w-0 break-words">
                <CommandNotice error={state.refusal} />
              </div>
            </div>
          )}
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Textarea
              aria-label="Message"
              rows={2}
              value={draft}
              disabled={!controls.composer.enabled}
              placeholder={controls.composer.why ?? (state.mode === "fix" ? "Tell it what to fix…" : "Ask why it is blocked…")}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
              className="flex-1 resize-none"
            />
            <Button type="submit" size="icon" aria-label="Send" disabled={!controls.composer.enabled || draft.trim() === ""}>
              <Send />
            </Button>
          </form>
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            disabled={!controls.unblock.enabled}
            title={controls.unblock.why ?? "Draft a decision summary, edit it, then post it and restart the loop"}
            onClick={() => void actions.draft()}
          >
            <LifeBuoy /> Unblock &amp; resume
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The Talk button. It stops the click where it is pressed: on a loop card it
 * sits inside the card's link, which would otherwise navigate away.
 */
export function TalkButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <Button
      size="xs"
      variant="outline"
      className={className}
      data-talk=""
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
    >
      <MessageSquare /> Talk
    </Button>
  );
}

/** Talk and its sheet together, for a place that is not itself a link. */
export function Talk({ loop, ticket = null, live, className }: { loop: string; ticket?: number | null; live: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <TalkButton className={className} onClick={() => setOpen(true)} />
      <ChatSheet loop={loop} ticket={ticket} live={live} open={open} onOpenChange={setOpen} />
    </>
  );
}
