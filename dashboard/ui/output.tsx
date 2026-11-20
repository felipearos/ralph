import { useEffect, useLayoutEffect, useReducer, useRef } from "react";
import { ShieldAlert } from "lucide-react";

import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { initialOutput, parseOutputEvent, reduceOutput, type Connection } from "./output-model";
import { api } from "./api";

const CONNECTION: Record<Connection, { label: string; dot: string }> = {
  connecting: { label: "connecting", dot: "bg-muted-foreground" },
  open: { label: "live", dot: "bg-status-good animate-pulse" },
  reconnecting: { label: "reconnecting", dot: "bg-status-warn" },
};

/**
 * What the loop is printing, live: its iteration log, redacted by the harness,
 * held open over server-sent events. Read-only — the page only listens.
 */
export function LiveOutput({ loop, className }: { loop: string; className?: string }) {
  const [state, dispatch] = useReducer(reduceOutput, initialOutput);
  const scroller = useRef<HTMLPreElement>(null);
  // Follow the bottom only while the operator is already there.
  const pinned = useRef(true);

  useEffect(() => {
    const source = new EventSource(api(`/api/loops/${encodeURIComponent(loop)}/output`));
    source.onopen = () => dispatch({ type: "connection", connection: "open" });
    source.onerror = () => dispatch({ type: "connection", connection: "reconnecting" });
    source.onmessage = (message: MessageEvent<string>) => {
      const event = parseOutputEvent(message.data);
      if (event !== null) dispatch({ type: "event", event });
    };
    // Closing the page closes the stream, and the server stops following.
    return () => source.close();
  }, [loop]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null && pinned.current) element.scrollTop = element.scrollHeight;
  }, [state.lines]);

  const look = CONNECTION[state.connection];
  const empty = state.lines.length === 0;

  return (
    <Card className={cn("gap-4 py-5 shadow-none", className)}>
      <CardHeader className="px-5">
        <CardTitle className="text-sm">Live output</CardTitle>
        <CardAction className="flex items-center gap-2 text-xs text-muted-foreground">
          {state.log && <span className="font-mono">{state.log}</span>}
          <span className="inline-flex items-center gap-1.5">
            <span className={cn("size-1.5 rounded-full", look.dot)} />
            {look.label}
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="px-5">
        {state.withheld !== null ? (
          <div className="flex items-start gap-2 rounded-md border border-status-warn/40 p-3 text-sm">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-status-warn" />
            <div className="space-y-1">
              <p className="font-medium">Output withheld</p>
              <p className="text-muted-foreground">
                The loop's output could not be redacted, so none of it is shown. Retrying every minute.{" "}
                {state.withheld}
              </p>
            </div>
          </div>
        ) : empty ? (
          <p className="text-sm text-muted-foreground">
            {state.connection === "connecting" ? "Connecting…" : (state.reason ?? "Nothing printed yet.")}
          </p>
        ) : (
          <>
            {state.reason && <p className="mb-2 text-xs text-muted-foreground">{state.reason}</p>}
            <pre
              ref={scroller}
              onScroll={(event) => {
                const element = event.currentTarget;
                pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
              }}
              className="max-h-96 overflow-auto rounded-md border bg-muted/30 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-muted-foreground"
            >
              {state.lines.join("\n")}
            </pre>
          </>
        )}
      </CardContent>
    </Card>
  );
}
