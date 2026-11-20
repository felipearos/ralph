/**
 * The page's writes, bound to the browser (spec #607): `send` posts one
 * command through `command-model.ts` with the window's fetch, the page's
 * project and whether this is the remote page; `useCommandAvailability` is
 * its lock; `useCommand` is the lock plus one send's pending and queued
 * state; `CommandNotice` is what a failed one says; `LocalOnlyNote` is the
 * line beside an affordance whose route the remote page cannot serve.
 *
 * The rules all live in the pure model, so a view never decides by itself
 * whether a route relays, stays local or is addressed at the top level.
 */
import { useCallback, useContext, useState } from "react";

import { cn } from "@/lib/utils";
import { isRemote } from "./api";
import { availability, noticeText, sendCommand, type CommandError, type CommandPath, type Result, type SendDeps } from "./command-model";
import { BridgeContext } from "./remote";
import { screenProject } from "./screen-project";
import { LOCAL_ONLY } from "./remote-model";

export interface SendOptions {
  onQueued?: SendDeps["onQueued"];
  signal?: AbortSignal;
  params?: SendDeps["params"];
  /** The project to send to, where it is not the one the page shows (a rail tile's menu). */
  project?: string;
}

/** One command, settled; never throws. */
export function send<T>(path: CommandPath, body?: unknown, options: SendOptions = {}): Promise<Result<T | null, CommandError>> {
  return sendCommand<T>(path, body, {
    // Bound: a bare `window.fetch` called off the window throws "Illegal invocation".
    fetch: window.fetch.bind(window),
    remote: isRemote(),
    ...options,
    project: options.project ?? screenProject(),
  });
}

/** Whether a command's affordance is offered, and the tooltip saying why not. */
export function useCommandAvailability(path: CommandPath): { disabled: boolean; why: string | null } {
  return availability(path, { remote: isRemote(), bridge: useContext(BridgeContext) });
}

/**
 * Beside an affordance the remote page shows but cannot act on. Rendered from
 * the route's availability, so it appears only where the command module locks
 * the command as local-only: nothing locally, nothing beside a relay or open
 * route. Lives here rather than in `remote.tsx`, which this file imports.
 */
export function LocalOnlyNote({ route, className }: { route: CommandPath; className?: string }) {
  const { why } = useCommandAvailability(route);
  if (why !== LOCAL_ONLY) return null;
  return <span className={cn("text-xs text-muted-foreground", className)}>{LOCAL_ONLY}</span>;
}

export interface Command {
  disabled: boolean;
  why: string | null;
  /** A send is in flight. */
  pending: boolean;
  /** The in-flight send was relayed and waits for the machine; only a relay route ever sets it. */
  queued: boolean;
  /** Sends `body` to the hook's route, or to `path` when a view posts several routes behind one lock. */
  send: <T>(body?: unknown, options?: SendOptions, path?: CommandPath) => Promise<Result<T | null, CommandError>>;
}

/**
 * A view's command: whether it is offered here, and the state of one send.
 * The queued flag comes from the route's relay metadata through the model,
 * so a view cannot forget to show it.
 */
export function useCommand(route: CommandPath): Command {
  const { disabled, why } = useCommandAvailability(route);
  const [pending, setPending] = useState(false);
  const [queued, setQueued] = useState(false);
  const run = useCallback(
    async <T,>(body?: unknown, options: SendOptions = {}, path: CommandPath = route): Promise<Result<T | null, CommandError>> => {
      setPending(true);
      try {
        return await send<T>(path, body, {
          ...options,
          onQueued: (relay) => {
            setQueued(true);
            options.onQueued?.(relay);
          },
        });
      } finally {
        setPending(false);
        setQueued(false);
      }
    },
    [route],
  );
  return { disabled, why, pending, queued, send: run };
}

/** A failed command's text and its problems; the caller's own notice box frames it. */
export function CommandNotice({ error }: { error: CommandError }) {
  return (
    <>
      <span>{noticeText(error)}</span>
      {error.problems !== undefined && error.problems.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
          {error.problems.map((problem, index) => (
            <li key={index}>{problem}</li>
          ))}
        </ul>
      )}
    </>
  );
}
