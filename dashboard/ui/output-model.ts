/**
 * The live output pane's state, folded from the stream's events. Pure, so the
 * pane's rules — a reset clears it, withheld drops what was shown, the pane
 * keeps a bounded tail — are tested without a browser.
 */
import type { OutputEvent } from "../contracts";

/** The most lines the pane keeps; older ones fall off the top. */
export const MAX_LINES = 2000;

export type Connection = "connecting" | "open" | "reconnecting";

export interface OutputState {
  connection: Connection;
  /** The log being shown, a file name under `.ralph/logs`. */
  log: string | null;
  /** Why the pane is empty or was restarted, from the server. */
  reason: string | null;
  lines: string[];
  /** Set when the redactor could not run; nothing is shown then. */
  withheld: string | null;
}

export const initialOutput: OutputState = {
  connection: "connecting",
  log: null,
  reason: null,
  lines: [],
  withheld: null,
};

export type OutputAction = { type: "event"; event: OutputEvent } | { type: "connection"; connection: Connection };

export function reduceOutput(state: OutputState, action: OutputAction): OutputState {
  if (action.type === "connection") return { ...state, connection: action.connection };
  const { event } = action;
  switch (event.kind) {
    case "reset":
      return { ...state, connection: "open", log: event.log, reason: event.reason, lines: [], withheld: null };
    case "withheld":
      return { ...state, connection: "open", lines: [], withheld: event.reason };
    case "append": {
      const added = event.text.endsWith("\n") ? event.text.slice(0, -1).split("\n") : event.text.split("\n");
      const lines = state.lines.concat(added);
      return { ...state, connection: "open", lines: lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines };
    }
  }
}

/** Parse one server-sent message, or null for anything that is not an event. */
export function parseOutputEvent(data: string): OutputEvent | null {
  try {
    const value = JSON.parse(data) as { kind?: unknown };
    return value.kind === "reset" || value.kind === "append" || value.kind === "withheld" ? (value as OutputEvent) : null;
  } catch {
    return null;
  }
}
