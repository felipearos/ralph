#!/usr/bin/env bun
/**
 * The Orca plugin: a loop mirrored onto Orca's board, and a second way in.
 *
 * Run by the plugin host (`ralph/plugins.ts`) as `plugin.ts <hook>` with the
 * payload on stdin, and answers with one JSON line. Everything Orca does for a
 * loop hangs off the three hooks:
 *
 *   on-event  the lifecycle mirror (`lifecycle.ts`): a Run for the supervisor,
 *             a Task for the ticket, a Dispatch per attempt, a heartbeat on
 *             every `pulse`. Plus the answers to `control` events
 *             (`mailbox.ts`), and the observer's consumer binding.
 *   inbox     the Run's mailbox and decision gates, delivered into the loop's
 *             local inbox as commands (`mailbox.ts`).
 *   notify    an alert, sent to the Run as a message of its own type.
 *
 * And, outside the loop, `doctor` (`doctor.ts`): run by `ralph/plugin-doctor.ts`
 * for an operator, it diagnoses the plugin and carries out the repairs.
 *
 * Off unless a project lists `orca` in `.ralph/config.json`'s `plugins`, or a
 * run sets `RALPH_PLUGINS=orca`. The verb allowlists in `lifecycle.ts`,
 * `mailbox.ts` and `binding.ts` are what this plugin may ask of Orca, and none
 * of them contains `worker-start`, `dispatch --inject` or `terminal send`.
 *
 * `plugin.ts status` prints the plugin's own panel lines, for `status.sh`.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { projectRoot } from "../../paths";
import type { PluginEvent } from "../../plugins";
import { BINDING_VERBS, readAdapterBindingIdentity, readOrcaConsumerBinding, reconcileOrcaConsumerBinding } from "./binding";
import { invokeOrca } from "./cli";
import { contextFrom, doctor } from "./doctor";
import {
  ORCA_STATE_RELATIVE_PATH,
  callOrca,
  enabled as lifecycleEnabled,
  heartbeat,
  lineFor,
  mirrorEvent,
  parseAdapterState,
} from "./lifecycle";
import { answer, deliver, mailboxLine } from "./mailbox";

const present = (value: string | undefined): string | null => {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
};

interface Answer {
  ok: boolean;
  why?: string;
}

const readAdapter = (root: string) => {
  try {
    return parseAdapterState(readFileSync(join(root, ORCA_STATE_RELATIVE_PATH), "utf8"));
  } catch {
    return null;
  }
};

/**
 * Every event the host handed over, in order.
 *
 * The mirror's own degraded window is the answer: a board the loop is not on
 * is a plugin that is not doing its job, and the host records it as such.
 */
function onEvent(root: string, events: PluginEvent[]): Answer {
  const controls: PluginEvent[] = [];
  for (const event of events) {
    if (event.name === "control") controls.push(event);
    else if (event.name === "pulse") heartbeat(root, event.run);
    else if (event.name === "observer") bindObserver(root, event.run);
    else mirrorEvent(root, event);
  }
  const answered = answer(root, controls);
  if (!answered.ok) return answered;
  if (!lifecycleEnabled()) return { ok: true };
  const degraded = readAdapter(root)?.degraded ?? null;
  return degraded === null ? { ok: true } : { ok: false, why: `lifecycle: ${degraded.why}` };
}

/**
 * Bind the observer's terminal to the loop's Run, so it can consume the
 * mailbox. Offered by `observe.ts` as an `observer` event from inside the
 * observer's own pane, whose `ORCA_TERMINAL_HANDLE` is the one to bind.
 */
function bindObserver(root: string, run: string): void {
  const result = reconcileOrcaConsumerBinding(
    root,
    readAdapterBindingIdentity(root),
    run,
    present(process.env.ORCA_TERMINAL_HANDLE),
    (verb, args) => invokeOrca(verb, args, BINDING_VERBS, "orca-observer-binding"),
  );
  if (result.status === "failed") throw new Error(result.why);
}

/** An alert, on the Run it belongs to. Not sent for a run this mirror does not hold. */
function notify(root: string, alert: Record<string, unknown>): Answer {
  const run = typeof alert.run === "string" ? alert.run : null;
  const adapter = readAdapter(root);
  if (adapter === null || adapter.ralphRun !== run || adapter.orcaRun === null) {
    return { ok: false, why: "no Orca Run to send the alert to" };
  }
  const priorTimeout = process.env.RALPH_ORCA_TIMEOUT_MS;
  if (priorTimeout === undefined && process.env.RALPH_PUSH_TIMEOUT_MS !== undefined) {
    process.env.RALPH_ORCA_TIMEOUT_MS = process.env.RALPH_PUSH_TIMEOUT_MS;
  }
  const sent = callOrca("orchestration send", [
    "--run",
    adapter.orcaRun,
    "--type",
    String(alert.kind),
    "--subject",
    String(alert.subject),
    "--body",
    String(alert.body),
    "--priority",
    String(alert.priority),
  ]);
  return sent.ok ? { ok: true } : { ok: false, why: sent.why };
}

/**
 * A loop not started from an Orca terminal has no `ORCA_TERMINAL_HANDLE`, and
 * every Orca call made without one has no sender. When the doctor has bound a
 * terminal to this run's Run, that terminal is the loop's in Orca, so the
 * hooks speak from it — the mirror included — exactly as they would from the
 * pane a loop was started in.
 */
function adoptBoundTerminal(root: string): void {
  if (present(process.env.ORCA_TERMINAL_HANDLE) !== null) return;
  const run = present(process.env.RALPH_RUN_ID);
  let binding = null;
  try {
    binding = readOrcaConsumerBinding(root);
  } catch {
    return;
  }
  if (binding !== null && run !== null && binding.ralphRun === run && resolve(binding.worktree) === resolve(root)) {
    process.env.ORCA_TERMINAL_HANDLE = binding.consumer;
  }
}

function main(): Answer | null {
  const root = process.env.RALPH_STATE_ROOT ?? projectRoot();
  const hook = process.argv[2];
  if (hook === "doctor") {
    // Run from wherever the operator's page runs, which may itself be an Orca
    // pane: no call here may act from that pane by accident. Every verb that
    // needs a sender names one with `--from`.
    delete process.env.ORCA_TERMINAL_HANDLE;
    const input = JSON.parse(readFileSync(0, "utf8")) as Record<string, unknown>;
    return doctor(contextFrom(root, input), input);
  }
  adoptBoundTerminal(root);
  if (hook === "status") {
    const state = readAdapter(root);
    console.log(lineFor(state, lifecycleEnabled()));
    console.log(mailboxLine(root));
    return null;
  }
  const input = JSON.parse(readFileSync(0, "utf8")) as Record<string, unknown>;
  switch (hook) {
    case "on-event":
      return onEvent(root, Array.isArray(input.events) ? (input.events as PluginEvent[]) : []);
    case "inbox":
      return deliver(
        root,
        {
          run: String(input.run ?? process.env.RALPH_RUN_ID ?? "adhoc"),
          loop: String(input.loop ?? "ralph"),
          worktree: String(input.worktree ?? root),
        },
        present(process.env.ORCA_TERMINAL_HANDLE),
      );
    case "notify":
      return notify(root, (input.alert ?? {}) as Record<string, unknown>);
    default:
      return { ok: false, why: `unknown hook '${String(hook)}'` };
  }
}

if (import.meta.main) {
  let result: Answer | null;
  try {
    result = main();
  } catch (error) {
    result = { ok: false, why: error instanceof Error ? error.message : String(error) };
  }
  if (result !== null) console.log(JSON.stringify(result));
}
