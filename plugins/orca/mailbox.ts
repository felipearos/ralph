/**
 * The Orca route into a loop: the Run's mailbox and its decision gates,
 * delivered into the loop's local inbox, and the answers said back on the Run.
 *
 * The loop's control channel (`ralph/controls.ts`) reads one thing, the local
 * inbox, and applies what it finds through its own fences. This file is the
 * plugin's `inbox` hook: at every control checkpoint it reads the Run's
 * mailbox and writes each command it finds into the inbox as a file, under the
 * command's own key. Everything that makes a command safe — applied at most
 * once, refused once the run it named has been replaced, deferred on a held
 * lock — is the core's, so a command sent through Orca and one sent from the
 * dashboard obey exactly the same rules, and one sent both ways is applied
 * once.
 *
 * An operator sends a command as a payload on any Orca message to the Run:
 *
 *   orca orchestration send --run <run> --type status \
 *     --subject 'ralph control: pause' \
 *     --payload '{"control":{"command":"pause","run":"<RALPH_RUN_ID>","why":"…"}}'
 *
 * Decision gates are the other half. A pending gate on the loop's Task becomes
 * a `request-approval` command, and its resolution an `approve` or a `deny`.
 *
 * The answers go the other way, on the `on-event` hook: each `control` event
 * the core emits once its record is written is acknowledged on the Run when it
 * came from here, a refusal naming a replaced run is replied to on its own
 * message, and the two commands with a terminal side are carried out on the
 * attempt's Dispatch — `worker-abandon` for a stop nobody could confirm, and
 * `worker-release` for a release.
 *
 * Orca being unreachable is a degraded window, exactly as it is for the
 * mirror: the hook answers `ok:false` with the reason, no Orca subprocess is
 * made until the window passes, and the loop — which reads its own inbox
 * either way — is untouched. `RALPH_ORCA_CONTROLS=0` turns this route off.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { writeInboxCommand, isSafeCommandId } from "../../control-inbox";
import {
  COMMANDS,
  controlEnvelope,
  readControlState,
  type ControlSettled,
  type ControlState,
} from "../../controls";
import { writeJsonAtomically } from "../../loop-state";
import type { PluginEvent } from "../../plugins";
import { resolveOrcaConsumer } from "./binding";
import { invokeOrca, type Called } from "./cli";
import {
  ORCA_STATE_RELATIVE_PATH,
  isAlreadySettled,
  parseAdapterState,
  type AdapterState,
} from "./lifecycle";

/** What this route remembers between polls. Beside the mirror's record. */
export const MAILBOX_STATE_RELATIVE_PATH = ".ralph/logs/orca-mailbox.json";

/** How long the route stays quiet after Orca could not be reached. */
const DEFAULT_RETRY_MS = 60_000;

/** How many delivered keys are remembered, for replies and for skipping re-writes. */
const DELIVERED_LIMIT = 256;

/**
 * The verbs this route may run.
 *
 * A separate roster from the mirror's, and a shorter one than it looks: three
 * of these read, two answer, and the two that change anything —
 * `worker-abandon` and `worker-release` — are the two Orca itself documents as
 * taking no process action on an unsupervised dispatch. `worker-stop` is
 * deliberately absent even though the mirror may run it: a stop applied here
 * is applied on behalf of an operator who cannot see the process, and a verb
 * that claims termination is the wrong thing to hand that operator.
 */
export const CONTROL_VERBS = [
  "orchestration check",
  "orchestration run-current",
  "orchestration run-use",
  "orchestration reply",
  "orchestration send",
  "orchestration gate-list",
  "orchestration worker-abandon",
  "orchestration worker-release",
] as const;
export type ControlVerb = (typeof CONTROL_VERBS)[number];

const call = (verb: ControlVerb, args: string[]): Called =>
  invokeOrca(verb, args, CONTROL_VERBS, "orca-controls");

export const enabled = (): boolean => (process.env.RALPH_ORCA_CONTROLS ?? "1") !== "0";

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const integer = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

/* --------------------------------------------------------------------------
 * Reading Orca's receipts.
 * ----------------------------------------------------------------------- */

/** One command read off one Orca message. */
export interface MailedCommand {
  /** The idempotency key, safe to name a file after. */
  key: string;
  /** The `control` envelope, as the inbox takes it. */
  envelope: Record<string, unknown>;
  /** The message it arrived on, so a refusal can be replied to in place. */
  message: string | null;
  /** Orca's own ordering, so a batch is written in the order it was sent. */
  sequence: number;
}

/**
 * A key the inbox can name a file after.
 *
 * The operator's own id, else the Orca message id — which is why a replayed
 * Delivery is safe without the operator having to think about it at all. An
 * id the inbox would refuse is hashed rather than dropped, so it is still one
 * stable key per command.
 */
export function inboxKey(raw: string): string {
  return isSafeCommandId(raw) ? raw : `orca-${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
}

/**
 * Read a command off one Orca message, or decide it is not one.
 *
 * Recognised by payload SHAPE rather than by message type, on purpose. Orca's
 * type roster is a closed set this file does not own (`status`, `escalation`,
 * `question`, …), and pinning the channel to one of them would mean a command
 * sent as the wrong type is silently ignored — the worst failure a control
 * channel can have. A payload carrying `control.command` is unambiguous
 * whatever envelope it arrived in.
 */
export function commandFrom(message: unknown): MailedCommand | null {
  if (typeof message !== "object" || message === null) return null;
  const row = message as Record<string, unknown>;
  const id = text(row.id);
  const envelope = controlEnvelope(row.payload);
  if (envelope === null) return null;
  if (!(COMMANDS as readonly string[]).includes(String(envelope.command))) return null;
  const raw = text(envelope.id) ?? id;
  if (raw === null) return null;
  return { key: inboxKey(raw), envelope, message: id, sequence: integer(row.sequence) ?? 0 };
}

export interface Delivery {
  messages: Record<string, unknown>[];
  /** What `check --ack` wants, when the runtime named it. */
  ack: string | null;
}

/**
 * Pull the messages and the acknowledgement token out of a `check` receipt.
 *
 * Tolerant on the ack and strict on nothing, because the two have different
 * costs. Missing messages means no commands this poll, which is the ordinary
 * case. A missing ack token means the batch replays — which the core's fence
 * absorbs, at the cost of a slightly longer mailbox. So the ack is looked for
 * under each name a receipt has been seen to use and simply skipped when none
 * of them is there.
 */
export function deliveryFrom(result: Record<string, unknown> | null): Delivery {
  const messages = Array.isArray(result?.messages)
    ? (result.messages as unknown[]).filter(
        (row): row is Record<string, unknown> => typeof row === "object" && row !== null,
      )
    : [];
  const delivery = result?.delivery;
  const ack =
    text(result?.deliveryId) ??
    text(result?.delivery_id) ??
    (typeof delivery === "object" && delivery !== null
      ? text((delivery as Record<string, unknown>).id)
      : text(delivery));
  return { messages, ack };
}

export interface Gate {
  id: string;
  task: string | null;
  status: string;
  question: string;
  resolution: string | null;
}

/** The gate rows out of a `gate-list` receipt, under whichever key holds them. */
export function gatesFrom(result: Record<string, unknown> | null): Gate[] {
  const raw = result?.gates ?? result?.rows ?? result?.decisionGates;
  if (!Array.isArray(raw)) return [];
  const gates: Gate[] = [];
  for (const row of raw) {
    if (typeof row !== "object" || row === null) continue;
    const value = row as Record<string, unknown>;
    const id = text(value.id) ?? text(value.gate_id);
    if (id === null) continue;
    gates.push({
      id,
      task: text(value.task_id) ?? text(value.taskId),
      status: text(value.status) ?? "pending",
      question: text(value.question) ?? "",
      resolution: text(value.resolution),
    });
  }
  return gates;
}

/**
 * Does this gate resolution mean "no"?
 *
 * Deliberately narrow, and deliberately fails towards *approved*. A resolution
 * exists because a human wrote one, so the ambiguous case is a human who
 * answered in words this regex does not know — and holding a loop forever on
 * text nobody will re-read is a worse outcome than letting it proceed on an
 * answer that was, after all, given. A human who means stop has `stop`.
 */
export function isDenial(resolution: string | null): boolean {
  return resolution !== null && /^\s*(deny|denied|reject|rejected|no|blocked)\b/i.test(resolution);
}

/* --------------------------------------------------------------------------
 * The route's own record.
 * ----------------------------------------------------------------------- */

export interface Delivered {
  key: string;
  /** The Orca message it came on, or null for one this route made (a gate's). */
  message: string | null;
  at: string;
}

export interface MailboxState {
  version: 1;
  delivered: Delivered[];
  /** Per gate: how many times a hold has been requested for it. */
  gates: Record<string, number>;
  degraded: { why: string; at: string; retryAt: string } | null;
}

const blankMailbox = (): MailboxState => ({ version: 1, delivered: [], gates: {}, degraded: null });

export function parseMailboxState(raw: string): MailboxState | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (row.version !== 1) return null;
  const delivered = Array.isArray(row.delivered)
    ? row.delivered.flatMap((entry): Delivered[] => {
        if (typeof entry !== "object" || entry === null) return [];
        const e = entry as Record<string, unknown>;
        const key = text(e.key);
        return key === null ? [] : [{ key, message: text(e.message), at: text(e.at) ?? "" }];
      })
    : [];
  const gates: Record<string, number> = {};
  if (typeof row.gates === "object" && row.gates !== null) {
    for (const [id, count] of Object.entries(row.gates as Record<string, unknown>)) {
      const n = integer(count);
      if (n !== null) gates[id] = n;
    }
  }
  const d = row.degraded as Record<string, unknown> | null | undefined;
  const degraded =
    typeof d === "object" && d !== null && text(d.why) !== null && text(d.retryAt) !== null
      ? { why: text(d.why)!, at: text(d.at) ?? text(d.retryAt)!, retryAt: text(d.retryAt)! }
      : null;
  return { version: 1, delivered, gates, degraded };
}

const readMailbox = (root: string): MailboxState => readMailboxState(root) ?? blankMailbox();

/** This route's record, or null when there is none or it cannot be read. */
export function readMailboxState(root: string): MailboxState | null {
  const path = join(root, MAILBOX_STATE_RELATIVE_PATH);
  try {
    return existsSync(path) ? parseMailboxState(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}

/** The typed door onto the shared atomic write, as `writeAdapterState` is for the mirror. */
export function writeMailboxState(root: string, state: MailboxState): void {
  writeJsonAtomically(join(root, MAILBOX_STATE_RELATIVE_PATH), state);
}

const readAdapter = (root: string): AdapterState | null => {
  const path = join(root, ORCA_STATE_RELATIVE_PATH);
  return existsSync(path) ? parseAdapterState(readFileSync(path, "utf8")) : null;
};

const retryMs = (): number => {
  const raw = Number(process.env.RALPH_ORCA_RETRY_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : DEFAULT_RETRY_MS;
};

/* --------------------------------------------------------------------------
 * The `inbox` hook.
 * ----------------------------------------------------------------------- */

export interface Answer {
  ok: boolean;
  why?: string;
}

export interface LoopIdentity {
  run: string;
  loop: string;
  worktree: string;
}

/**
 * Read the Run's mailbox and gates, and deliver what they hold into the inbox.
 *
 * The acknowledgement is sent only once every command in the batch is on disk
 * in the inbox: from then on the core owns it, and a lost ack costs a replay
 * the core's fence absorbs. A command whose file could not be written is left
 * unacknowledged, so Orca hands it back.
 */
export function deliver(root: string, identity: LoopIdentity, terminal: string | null): Answer {
  if (!enabled()) return { ok: true };
  const nowIso = new Date().toISOString();
  const state = readMailbox(root);
  const adapter = readAdapter(root);
  const save = (next: MailboxState): void => writeMailboxState(root, next);
  const degrade = (why: string): Answer => {
    save({ ...state, degraded: { why, at: nowIso, retryAt: new Date(Date.parse(nowIso) + retryMs()).toISOString() } });
    return { ok: false, why };
  };

  // Inside the window: no subprocess at all. A held loop polls every few
  // seconds, and paying a timeout on each would make an absent Orca cost more
  // than the route is worth.
  const window = state.degraded;
  if (window !== null && Date.parse(window.retryAt) > Date.parse(nowIso)) {
    return { ok: false, why: window.why };
  }

  const consumer = resolveOrcaConsumer(
    root,
    adapter,
    { ralphRun: identity.run, worktree: resolve(identity.worktree) },
    terminal,
  );
  if (consumer === null) return degrade("no safe Orca consumer is available");

  const checked = call("orchestration check", ["--terminal", consumer]);
  if (!checked.ok) return degrade(checked.why);
  const delivery = deliveryFrom(checked.result);

  const commands = delivery.messages
    // Its own mail is not a command. The mirror sends every heartbeat and
    // status to this same Run mailbox, and a route that read its own payloads
    // back would be one malformed field away from obeying itself.
    .filter((row) => text(row.from_handle) !== consumer)
    .map(commandFrom)
    .filter((command): command is MailedCommand => command !== null)
    .sort((a, b) => a.sequence - b.sequence);

  let delivered = state.delivered;
  let unwritten = false;
  for (const command of commands) {
    // Written again even when delivered before: the file may have been lost
    // with its worktree's inbox, and the core answers a repeat from its fence.
    const failed = writeInboxCommand(root, { ...command.envelope, id: command.key, via: "orca" });
    if (failed !== null) {
      unwritten = true;
      continue;
    }
    delivered = remembered(delivered, { key: command.key, message: command.message, at: nowIso });
  }
  if (delivery.ack !== null && !unwritten) {
    call("orchestration check", ["--terminal", consumer, "--ack", delivery.ack]);
  }

  const gated = reconcileGates(root, { ...state, delivered }, adapter, nowIso);
  save({ ...gated, degraded: null });
  return { ok: true };
}

function remembered(delivered: Delivered[], entry: Delivered): Delivered[] {
  const next = [...delivered.filter((row) => row.key !== entry.key), entry];
  return next.slice(Math.max(0, next.length - DELIVERED_LIMIT));
}

/**
 * Turn the loop's Task's decision gates into commands.
 *
 * Gates are the other half of approval, and the half an operator is more
 * likely to use: `gate-create --task <task>` is how Orca already expresses
 * "this work needs a decision", and a loop that ignored one would carry on
 * working a ticket somebody had explicitly gated.
 *
 * Read against the core's record, which is the only truth about what holds
 * the loop. A pending gate asks for a hold only while nothing else holds it —
 * a pause an operator took by hand outranks a gate — and asks again whenever
 * its last request has been settled and the loop is free, which is how a
 * gate still pending after an approval from elsewhere holds the loop again.
 * A resolved gate is answered with `approve` or `deny`, because the two
 * answers are different endings: a denial is a stop the loop must not need a
 * second command to obey.
 */
function reconcileGates(
  root: string,
  state: MailboxState,
  adapter: AdapterState | null,
  nowIso: string,
): MailboxState {
  const run = adapter?.orcaRun ?? null;
  if (run === null) return state;
  const listed = call("orchestration gate-list", ["--run", run]);
  if (!listed.ok) return state;
  const task = adapter?.task?.id ?? null;
  const gates = gatesFrom(listed.result).filter(
    // A gate on another Task in the same Run belongs to whoever owns that
    // task; this loop holds one ticket at a time and answers only for it.
    (gate) => task === null || gate.task === null || gate.task === task,
  );
  const record: ControlState | null = readControlState(root);
  const fenced = (key: string): boolean => record?.applied.some((row) => row.key === key) ?? false;
  let next = state;
  const send = (key: string, envelope: Record<string, unknown>): void => {
    if (writeInboxCommand(root, { ...envelope, id: key, via: "orca" }) === null) {
      next = { ...next, delivered: remembered(next.delivered, { key, message: null, at: nowIso }) };
    }
  };

  const held = record?.hold?.kind === "approval" ? record.hold.gate : null;
  if (held !== null) {
    const gate = gates.find((row) => row.id === held);
    if (gate === undefined || gate.status === "pending") return next;
    const key = inboxKey(`orca-gate-${gate.id}-answer`);
    if (fenced(key)) return next;
    send(key, {
      command: isDenial(gate.resolution) ? "deny" : "approve",
      gate: gate.id,
      why: `decision gate ${gate.id}: ${gate.resolution ?? "resolved"}`,
    });
    return next;
  }

  if (record?.hold != null) return next;
  const pending = gates.find((gate) => gate.status === "pending");
  if (pending === undefined) return next;
  const asked = next.gates[pending.id] ?? 0;
  const last = asked > 0 ? inboxKey(`orca-gate-${pending.id}-hold-${asked}`) : null;
  // A request still waiting in the inbox is not asked twice.
  if (last !== null && !fenced(last)) return next;
  next = { ...next, gates: { ...next.gates, [pending.id]: asked + 1 } };
  send(inboxKey(`orca-gate-${pending.id}-hold-${asked + 1}`), {
    command: "request-approval",
    gate: pending.id,
    why: `decision gate ${pending.id}: ${pending.question}`,
  });
  return next;
}

/* --------------------------------------------------------------------------
 * Answering, on the `on-event` hook.
 * ----------------------------------------------------------------------- */

const isGateKey = (key: string | null): boolean => key !== null && key.startsWith("orca-gate-");

/**
 * Say each settled command where it was issued, and carry out its terminal side.
 *
 * Only a command this route delivered is acknowledged on the Run: an inbox
 * command's answer is the outcome file beside it, and one from the dashboard
 * has the dashboard. The terminal side — fencing an unreachable attempt,
 * releasing an attempt's resource — is carried out whoever issued it, because
 * it is about the Dispatch this plugin opened.
 */
export function answer(root: string, events: PluginEvent[]): Answer {
  if (!enabled()) return { ok: true };
  const settled = events
    .map((event) => ({ event, control: event.control as unknown as ControlSettled | undefined }))
    .filter((row): row is { event: PluginEvent; control: ControlSettled } => row.control !== undefined);
  if (settled.length === 0) return { ok: true };
  const adapter = readAdapter(root);
  const state = readMailbox(root);
  const problems: string[] = [];

  for (const { event, control } of settled) {
    const ours = adapter !== null && adapter.ralphRun === event.run ? adapter : null;
    const orcaRun = ours?.orcaRun ?? null;
    const dispatch = ours?.attempt?.dispatch ?? null;
    const runArgs = orcaRun !== null ? ["--run", orcaRun] : [];

    // An unreachable owner's attempt is FENCED and not reported: nothing here
    // knows what became of that runner, and `worker-abandon` is the one verb
    // that says exactly that. A supervisor stopping itself leaves its own
    // attempt to the mirror, which settles it at the boundary it records.
    if (control.command === "stop" && control.outcome === "applied" && control.confirmation !== "confirmed" && dispatch !== null) {
      const fenced = call("orchestration worker-abandon", ["--dispatch", dispatch]);
      if (!fenced.ok && !isAlreadySettled(fenced)) problems.push(`could not fence dispatch ${dispatch}: ${fenced.why}`);
    }
    // The terminal side of a release, whether or not there was still a lease
    // to drop. Orca reports an unsupervised dispatch as `retained` with no
    // process action, which is the truthful answer and not an error.
    if (control.command === "release" && control.outcome === "applied" && dispatch !== null) {
      const released = call("orchestration worker-release", ["--dispatch", dispatch]);
      if (!released.ok && !isAlreadySettled(released)) problems.push(`could not release dispatch ${dispatch}: ${released.why}`);
    }

    if (control.outcome === "carried-out") {
      // Said where the stop was issued: an operator who left a stop for a loop
      // nobody could reach has no other way to learn that it finally took.
      call("orchestration send", [
        ...runArgs,
        "--type",
        "status",
        "--subject",
        `${event.loop} control: stop carried out`,
        "--body",
        control.why,
        "--payload",
        JSON.stringify({ loop: event.loop, ralphRun: event.run, control: "stop", outcome: "applied", confirmation: "confirmed" }),
      ]);
      continue;
    }
    if (control.via !== "orca" || isGateKey(control.key)) continue;

    if (control.outcome === "needs-reconfirmation") {
      const message = state.delivered.find((row) => row.key === control.key)?.message ?? null;
      if (message !== null) {
        call("orchestration reply", [
          "--id",
          message,
          "--body",
          `${event.loop}: ${control.command} not applied — ${control.why}`,
        ]);
      }
      continue;
    }
    if (control.outcome !== "applied" && control.outcome !== "refused") continue;
    // Said on the Run, not only in the worktree: the operator issued this from
    // a board, and an instruction that produces no visible answer there is one
    // they have to come into the worktree to verify.
    call("orchestration send", [
      // Named explicitly: the supervisor's terminal is bound to this Run, so
      // an omitted `--run` usually lands in the right mailbox — and "usually"
      // is the wrong property for the message that says a command landed.
      ...runArgs,
      "--type",
      "status",
      "--subject",
      `${event.loop} control: ${control.command} ${control.givenUp ? "given up" : control.outcome}`,
      "--body",
      control.why,
      "--payload",
      JSON.stringify({
        loop: event.loop,
        ralphRun: event.run,
        control: control.command,
        outcome: control.outcome,
        confirmation: control.confirmation,
        // The link itself, so a retry's two attempt identities are legible on
        // the board rather than only in this worktree's record.
        ...(control.attempt !== null ? { attempt: control.attempt, retryOf: control.retryOf } : {}),
        ...(control.command === "retry" && dispatch !== null ? { dispatch, session: ours?.attempt?.session ?? null } : {}),
      }),
    ]);
  }
  return problems.length === 0 ? { ok: true } : { ok: false, why: problems.join("; ") };
}

/** One line for the plugin's status. */
export function mailboxLine(root: string): string {
  if (!enabled()) return "Orca controls: Orca route off (RALPH_ORCA_CONTROLS=0); the local inbox is still read";
  const state = readMailbox(root);
  if (state.degraded !== null) {
    return `Orca controls: degraded — ${state.degraded.why} (retrying after ${state.degraded.retryAt})`;
  }
  return `Orca controls: listening — ${state.delivered.length} command(s) delivered into the inbox`;
}
