#!/usr/bin/env bun
/**
 * Best-effort notifications for Ralph problems and terminal states.
 *
 * The loop decides what is worth an alert, records each one once in
 * `.ralph/logs/push-notifications.json`, comments on the ticket it holds when
 * the ticket is eligible, and offers the alert to enabled plugins through the
 * `notify` hook (`ralph/plugins.ts`). The record names the plugins an alert was
 * offered to, and says so when there were none: an alert nobody heard is
 * still an alert the loop raised.
 *
 * Every alert is also written to the local feed,
 * `.ralph/logs/notifications.jsonl`, which the dashboard reads. The feed is
 * the one delivery that needs nothing to be enabled: one `raised` line,
 * redacted, before the alert is offered anywhere, then one `delivery` line for
 * each plugin's answer and for the ticket comment. An alert whose `raised`
 * line has no answer from a plugin it names was never confirmed delivered.
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { leasePathFromGit, readLeaseStore } from "./claim-lease";
import { enabledPlugins, offer } from "./plugins";
import {
  buildRedactor,
  hasPatterns,
  loadSignalConfig,
  observationPath,
  pushArgsForObservation,
  readObservations,
} from "./runner-failure";
import { writeJsonAtomically } from "./loop-state";
import { RALPH_HOME, projectRoot } from "./paths";
import { projectTrackerConfig, runTrackerCli } from "./tracker/project";

export const PUSH_STATE_RELATIVE_PATH = ".ralph/logs/push-notifications.json";
/** The local feed: every alert raised, and how each channel took it. Append-only. */
export const NOTIFICATION_FEED_RELATIVE_PATH = ".ralph/logs/notifications.jsonl";
export const MAX_GITHUB_COMMENTS_PER_TICKET = 5;
const DEFAULT_TIMEOUT_MS = 15_000;
export const NOTIFICATION_KINDS = [
  "permission-denial",
  "credential-expiry",
  "rate-limit",
  "gate-failure",
  "stage-timeout",
  "no-sigil",
  "pr-opened",
  "pr-merged",
  "ticket-blocked",
  "run-finished",
  // A role's post-iteration invariant failed — a triager that left the
  // worktree dirty — and the supervisor restored it. The restore is silent
  // otherwise, and a role breaking its own fence is worth a human's eye.
  "role-invariant",
  // The ci-doctor saw an infrastructure incident. Its occurrence key is
  // `ci-incident:<signature>:<first build>`, so an incident that spans a
  // hundred red builds pages once rather than a hundred times. Once per RUN,
  // to be exact: the record this dedupes against is keyed `<run>:<occurrence>`
  // and lives in the worktree, so a doctor restarted mid-incident raises it
  // again. That is the record's rule, not this kind's.
  "ci-incident",
  // The dashboard's reconciler restarted a loop whose supervisor died without
  // writing an ending, or stopped re-attempting one. `loop-restarted` is
  // pushed for every ATTEMPT — including one the start gate refused — because
  // the bound on attempts is counted back from these very records, and a
  // refusal that wrote nothing would never be counted. Its occurrence key
  // carries the attempt's timestamp: a loop that dies before it writes a new
  // `state.json` keeps the old run id, and the record dedupes on
  // `<run>:<occurrence>`.
  "loop-restarted",
  "loop-restart-capped",
  // The dashboard's reconciler retried a loop that stopped itself on a
  // transient fault (secrets-env, no-sigil, a doppler-scope preflight denial):
  // `loop-retried` for every retry attempt, since the schedule is counted back
  // from these records, and `loop-retry-capped` once when the schedule is
  // spent. Separate from `loop-restarted` / `loop-restart-capped` so the
  // dead-supervisor path's bound and dedupe never count this path's records.
  "loop-retried",
  "loop-retry-capped",
  // A preflight wait outlasted RALPH_PREFLIGHT_ALERT_SECONDS. Pushed by the
  // supervisor once per wait, naming the unavailable check, so an outage that
  // never clears is seen; the supervisor keeps waiting rather than stopping.
  "preflight-stalled",
  // A pull request labelled `migration-applied` stayed open past
  // RALPH_MIGRATION_ALERT_SECONDS: prod now runs ahead of main and every other
  // PR of the project reds until it merges. Pushed by the dashboard's
  // migration watchdog, on the reconciler's timer, once per PR and apply time, deduped under a fixed run id so
  // a dashboard restart does not repeat it.
  "migration-applied-stalled",
  // A second loop started waiting on a blocker another loop already waits on.
  // Not `ticket-blocked`: it is about one cause many loops wait on — a red
  // check on main, an unmerged PR — not about a ticket. Pushed by the
  // backoff, once per episode: the store's set-once `notified` decides it
  // across loops, and the occurrence `shared-blocker:<key>:<first>` names the
  // episode, so a cause that comes back escalates again.
  "shared-blocker",
  // The verifier's report mode (#567) pages when a merge would have been
  // reverted, or when a root ticket hit the round cap and is handed to a
  // human: either way production may be hurting and no loop will fix it.
  // Occurrence `verifier-alert:<pr>`, so a watch pages once.
  "verifier-alert",
  // The sentinel's file mode (#682) pages when its daily cap holds issues
  // back: production keeps raising them and no ticket is filed until the next
  // UTC day. Occurrence `sentinel-alert:<YYYY-MM-DD>`, so a day pages once.
  "sentinel-alert",
  // A gate has held on the same verdict past RALPH_GATE_HOLD_BUDGET_HOURS
  // (#771): the supervisor dropped its disagreement halt for a holding gate,
  // so this is what tells a person the hold is not clearing by itself. Pushed
  // by the supervisor once per HOLD, occurrence
  // `gate-hold-exhausted:<kind>:<ticket>:<first>` — per hold rather than per
  // run because the verdict record's own `notified` flag survives a restart,
  // and the run-keyed dedupe does not.
  "gate-hold-exhausted",
  // A loop crossed its plan usage stop (`usage-stop.ts`) and parked until the
  // window it watches resets. Pushed by the supervisor once per park,
  // occurrence `usage-stop:<loop>:<window>:<reset>`, and never with a ticket:
  // the ticket did nothing wrong, and on a client's repository a comment
  // about our plan is not theirs to read.
  "usage-stop",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export const PUSH_PRIORITIES = ["normal", "high"] as const;
export type PushPriority = (typeof PUSH_PRIORITIES)[number];

export interface PushOccurrence {
  kind: string;
  at: string;
  ticket: number | null;
  /**
   * The plugins enabled when the alert was raised, which it is offered to
   * through `notify`. Whether each one delivered it is that plugin's health
   * in `.ralph/logs/plugins.json`.
   */
  plugins: string[];
  /** Why no plugin heard it, when none did. */
  unoffered: string | null;
  github: "eligible" | "reserved" | "posted" | "attempted" | "capped" | "unavailable" | "unheld" | "absent";
}

export interface PushState {
  version: 1;
  occurrences: Record<string, PushOccurrence>;
  ticketComments: Record<string, number>;
}

export interface PushInput {
  kind: NotificationKind;
  occurrence: string;
  subject: string;
  body: string;
  priority: PushPriority;
  ticket: number | null;
  /** The iteration that raised it; `RALPH_ITERATION` when the caller does not say. */
  iteration?: number | null;
  /** A reconciler retry: its 1-based attempt, the schedule's length, and the `lastEvent.name` retried for. */
  retry?: PushRetry;
}

export interface PushRetry {
  attempt: number;
  of: number;
  cause: string;
}

/** How a ticket comment ended, as the feed records it. */
export type CommentFeedOutcome = "posted" | "capped" | "unavailable" | "unheld" | "ambiguous";

/** One line of the local feed. */
export type FeedLine =
  | {
      version: 1;
      event: "raised";
      /** `<run>:<occurrence>`, the key the alert is recorded under. */
      id: string;
      at: string;
      run: string;
      loop: string | null;
      kind: NotificationKind;
      subject: string;
      body: string;
      priority: PushPriority;
      ticket: number | null;
      iteration: number | null;
      /** The plugins it is about to be offered to, enabled but not installed included. */
      plugins: string[];
      github: PushOccurrence["github"];
      /** Why the alert went nowhere but the feed, when it could not be sent at all. */
      unsent?: string;
      /** Which reconciler retry raised it, when one did. */
      retry?: PushRetry;
    }
  | {
      version: 1;
      event: "delivery";
      id: string;
      at: string;
      channel: "plugin" | "github";
      name: string;
      ok: boolean;
      /** For a plugin: whether it was asked at all (not while backed off from, not when missing). */
      ran?: boolean;
      /** Why it did not arrive, redacted; null when it did. */
      why: string | null;
      /** For the ticket comment: how the comment ended. */
      outcome?: CommentFeedOutcome;
    };

/** Append one line to the feed. A feed that cannot be written never stops the alert. */
function appendFeed(root: string, line: FeedLine): void {
  try {
    const path = join(root, NOTIFICATION_FEED_RELATIVE_PATH);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(line)}\n`);
  } catch {
    // Notifications never fail the loop's own work.
  }
}

const positiveInteger = (raw: string | undefined): number | null => {
  const value = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isSafeInteger(value) && value > 0 ? value : null;
};

function inferredTicket(root: string, run: string): number | null {
  try {
    const path = process.env.RALPH_CLAIM_LEASE_PATH?.trim() || leasePathFromGit(root);
    const live = Object.values(readLeaseStore(path).leases)
      .filter((lease) => lease.run === run && Date.parse(lease.expiresAt) > Date.now())
      .sort((a, b) => Date.parse(b.claimedAt) - Date.parse(a.claimedAt));
    return live[0]?.issue ?? null;
  } catch {
    return null;
  }
}

export function pushInputsForRecord(argv: string[], ticket: number | null): PushInput[] {
  const event = flag(argv, "event")?.trim();
  if (!event) return [];
  const stop = flag(argv, "stop")?.trim();
  const iteration = flag(argv, "iteration")?.trim() || "run";
  const iterationNumber = positiveInteger(flag(argv, "iteration"));
  const why = flag(argv, "why")?.trim() || flag(argv, "detail")?.trim() || event;
  const key = `record:${event}:${iteration}:${stop ?? "none"}`;
  const found: PushInput[] = [];
  if (["gate-broken", "gate-disagreement", "preflight-broken", "preflight-denied", "secrets-env", "needs-triage"].includes(event)) {
    found.push({
      kind: "gate-failure",
      occurrence: key,
      subject: `Loop gate failed at ${event}`,
      body: why,
      priority: "high",
      ticket,
      iteration: iterationNumber,
    });
  }
  // A usage limit whose wait could not be armed stops the run; it is a rate
  // limit to the operator, not an iteration that lost its sigil.
  if (event === "usage-limit-stop") {
    found.push({
      kind: "rate-limit",
      occurrence: key,
      subject: `Iteration ${iteration} stopped on a usage limit`,
      body: why,
      priority: "high",
      ticket,
      iteration: iterationNumber,
    });
  }
  if (event === "no-sigil") {
    found.push({
      kind: "no-sigil",
      occurrence: key,
      subject: `Iteration ${iteration} ended without a sigil`,
      body: why,
      priority: "high",
      ticket,
      iteration: iterationNumber,
    });
  }
  if (
    ((event === "stop" || event === "gate-disagreement" || event === "control-stop" || event === "backoff-exhausted") &&
      stop === "blocked") ||
    (event === "cap-reached" && ticket !== null)
  ) {
    found.push({
      kind: "ticket-blocked",
      occurrence: `${key}:ticket-blocked`,
      subject: ticket === null ? "Loop blocked" : `Ticket #${ticket} blocked`,
      body: why,
      priority: "high",
      ticket,
      iteration: iterationNumber,
    });
  }
  if (
    ["frontier-empty", "stop", "gate-disagreement", "backoff-exhausted", "backoff-exhausted-shared", "gate-broken", "preflight-broken", "preflight-denied", "secrets-env", "needs-triage", "no-sigil", "usage-limit-stop", "control-stop", "cap-reached"].includes(event)
  ) {
    found.push({
      kind: "run-finished",
      occurrence: `${key}:run-finished`,
      subject: "Loop run finished",
      body: why,
      priority: stop === "completed" ? "normal" : "high",
      ticket,
      iteration: iterationNumber,
    });
  }
  return found;
}

const emptyState = (): PushState => ({ version: 1, occurrences: {}, ticketComments: {} });

export function parsePushState(raw: string): PushState {
  try {
    const value = JSON.parse(raw) as Partial<PushState>;
    if (value.version !== 1) return emptyState();
    return {
      version: 1,
      occurrences:
        value.occurrences && typeof value.occurrences === "object" ? value.occurrences : {},
      ticketComments:
        value.ticketComments && typeof value.ticketComments === "object" ? value.ticketComments : {},
    };
  } catch {
    return emptyState();
  }
}

function timeoutMs(): number {
  const raw = Number(process.env.RALPH_PUSH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

export function assertAllowedPushCommand(command: "usage" | "github" | "tracker" | "lock", args: string[]): void {
  const lockPrefix =
    (args.length === 11 || args.length === 13) &&
    args[0] === "-x" &&
    args[1] === "-w" &&
    Number(args[2]) > 0 &&
    args[3]?.endsWith(".lock") &&
    args[4] === process.execPath &&
    args[5] === fileURLToPath(import.meta.url);
  const lockClaim =
    args[6] === "claim" &&
    args[7] === "--kind" &&
    (NOTIFICATION_KINDS as readonly string[]).includes(args[8] ?? "") &&
    args[9] === "--occurrence" &&
    args[10] !== "" &&
    (args.length === 11 || (args[11] === "--ticket" && /^\d+$/.test(args[12] ?? "")));
  const lockReserve =
    args.length === 11 &&
    args[6] === "reserve" &&
    args[7] === "--occurrence" &&
    args[8] !== "" &&
    args[9] === "--ticket" &&
    /^\d+$/.test(args[10] ?? "");
  const lockFinalize =
    args.length === 13 &&
    args[6] === "finalize" &&
    args[7] === "--occurrence" &&
    args[8] !== "" &&
    args[9] === "--outcome" &&
    ["posted", "unavailable", "unheld"].includes(args[10] ?? "") &&
    args[11] === "--ticket" &&
    /^\d+$/.test(args[12] ?? "");
  const allowed =
    command === "usage"
      ? args.length === 3 && args[0] === "--step" && args[1] !== "" && args[2] === "--md"
      : command === "github"
        ? args.length === 5 &&
          args[0] === "issue" &&
          args[1] === "comment" &&
          /^\d+$/.test(args[2] ?? "") &&
          args[3] === "--body"
        : command === "tracker"
          ? args.length === 4 && args[0] === "comment" && /^\d+$/.test(args[1] ?? "") && args[2] === "--body-file" && args[3] === "-"
          : lockPrefix && (lockClaim || lockReserve || lockFinalize);
  if (!allowed) throw new Error(`push-notification: refusing ${command} ${args.join(" ")}`);
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function inputFrom(argv: string[]): PushInput | null {
  const kind = flag(argv, "kind")?.trim();
  const occurrence = flag(argv, "occurrence")?.trim();
  const subject = flag(argv, "subject")?.trim();
  const body = flag(argv, "body")?.trim();
  const priority = flag(argv, "priority")?.trim() || "normal";
  if (
    !kind ||
    !(NOTIFICATION_KINDS as readonly string[]).includes(kind) ||
    !(PUSH_PRIORITIES as readonly string[]).includes(priority) ||
    !occurrence ||
    !subject ||
    !body
  ) return null;
  const ticketRaw = Number(flag(argv, "ticket"));
  const retry = retryFrom(argv);
  return {
    kind: kind as NotificationKind,
    occurrence,
    subject,
    body,
    priority: priority as PushPriority,
    ticket: Number.isSafeInteger(ticketRaw) && ticketRaw > 0 ? ticketRaw : null,
    ...(retry === null ? {} : { retry }),
  };
}

/**
 * The retry the flags describe, or null when any piece is missing or
 * malformed. Never a reason to refuse the push: the record is what the
 * reconciler counts, and a dropped push would lose a count.
 */
function retryFrom(argv: string[]): PushRetry | null {
  const attemptRaw = flag(argv, "retry-attempt")?.trim();
  const ofRaw = flag(argv, "retry-of")?.trim();
  const cause = flag(argv, "retry-cause")?.trim();
  if (!attemptRaw || !ofRaw || !cause || !/^\d+$/.test(attemptRaw) || !/^\d+$/.test(ofRaw)) return null;
  const attempt = Number(attemptRaw);
  const of = Number(ofRaw);
  if (!Number.isSafeInteger(attempt) || !Number.isSafeInteger(of) || attempt < 1 || attempt > of) return null;
  return { attempt, of, cause };
}

function heldTicket(root: string, run: string, ticket: number): boolean {
  try {
    const path = process.env.RALPH_CLAIM_LEASE_PATH?.trim() || leasePathFromGit(root);
    const lease = readLeaseStore(path).leases[String(ticket)];
    return lease?.run === run && Date.parse(lease.expiresAt) > Date.now();
  } catch {
    return false;
  }
}

/**
 * The usage CLI that writes a ticket comment's footer: the harness's own
 * `usage.py`, not one inside the project — the harness no longer lives there,
 * and a footer that cannot be produced drops the comment.
 */
export function usageCli(env: NodeJS.ProcessEnv = process.env): string {
  return env.RALPH_USAGE_CLI?.trim() || join(RALPH_HOME, "usage.py");
}

function usageFooter(root: string, kind: string, ticket: number): string {
  const cli = usageCli();
  const args = ["--step", `push ${kind} for #${ticket}`, "--md"];
  assertAllowedPushCommand("usage", args);
  const result = spawnSync(cli, args, {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs(),
    maxBuffer: 1024 * 1024,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function comment(
  root: string,
  ticket: number,
  subject: string,
  body: string,
  footer: string,
): "posted" | "failed" | "ambiguous" {
  const fullBody = [`### ${subject}`, "", body, "", footer].join("\n");
  // A Linear or Jira ticket is commented on its own tracker (#334), the body on
  // stdin; GitHub keeps its `gh issue comment`.
  const tracker = projectTrackerConfig(root);
  if (tracker !== null && tracker.kind !== "github") {
    const trackerArgs = ["comment", String(ticket), "--body-file", "-"];
    assertAllowedPushCommand("tracker", trackerArgs);
    const posted = runTrackerCli(root, trackerArgs, { timeoutMs: timeoutMs(), input: fullBody });
    return posted.ok ? "posted" : posted.timedOut ? "ambiguous" : "failed";
  }
  const args = ["issue", "comment", String(ticket), "--body", fullBody];
  assertAllowedPushCommand("github", args);
  const result = spawnSync("gh", args, {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs(),
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status === 0) return "posted";
  return result.error && "code" in result.error && result.error.code === "ETIMEDOUT"
    ? "ambiguous"
    : "failed";
}

interface ClaimInput {
  kind: NotificationKind;
  occurrence: string;
  ticket: number | null;
}

interface ClaimResult {
  github: PushOccurrence["github"];
  plugins: string[];
}

type CommentOutcome = "posted" | "unavailable" | "unheld";

function claimInputFrom(argv: string[]): ClaimInput | null {
  const kind = flag(argv, "kind")?.trim();
  const occurrence = flag(argv, "occurrence")?.trim();
  if (!kind || !(NOTIFICATION_KINDS as readonly string[]).includes(kind) || !occurrence) return null;
  const ticketRaw = Number(flag(argv, "ticket"));
  return {
    kind: kind as NotificationKind,
    occurrence,
    ticket: Number.isSafeInteger(ticketRaw) && ticketRaw > 0 ? ticketRaw : null,
  };
}

function claimState(root: string, run: string, input: ClaimInput): ClaimResult | null {
  const path = join(root, PUSH_STATE_RELATIVE_PATH);
  const occurrenceKey = `${run}:${input.occurrence}`;
  const state = existsSync(path) ? parsePushState(readFileSync(path, "utf8")) : emptyState();
  if (state.occurrences[occurrenceKey]) return null;
  const plugins = enabledPlugins(root).names;
  const ticketHeld = input.ticket !== null && heldTicket(root, run, input.ticket);
  const github: PushOccurrence["github"] =
    input.ticket === null
      ? "absent"
      : !ticketHeld
        ? "unheld"
        : "eligible";

  state.occurrences[occurrenceKey] = {
    kind: input.kind,
    at: new Date().toISOString(),
    ticket: input.ticket,
    plugins,
    unoffered: plugins.length === 0 ? "no notify plugin is enabled" : null,
    github,
  };
  writeJsonAtomically(path, state);
  return { github, plugins };
}

function reserveComment(root: string, run: string, occurrence: string, ticket: number): "reserved" | "capped" | null {
  const path = join(root, PUSH_STATE_RELATIVE_PATH);
  if (!existsSync(path)) return null;
  const state = parsePushState(readFileSync(path, "utf8"));
  const occurrenceState = state.occurrences[`${run}:${occurrence}`];
  if (occurrenceState?.github !== "eligible") return null;
  const commentKey = `${run}:${ticket}`;
  const posted = state.ticketComments[commentKey] ?? 0;
  const reserved = Object.entries(state.occurrences).filter(
    ([key, value]) =>
      key.startsWith(`${run}:`) && value.ticket === ticket && value.github === "reserved",
  ).length;
  const result = posted + reserved >= MAX_GITHUB_COMMENTS_PER_TICKET ? "capped" : "reserved";
  occurrenceState.github = result;
  writeJsonAtomically(path, state);
  return result;
}

function finalizeComment(
  root: string,
  run: string,
  occurrence: string,
  ticket: number,
  outcome: CommentOutcome,
): void {
  const path = join(root, PUSH_STATE_RELATIVE_PATH);
  if (!existsSync(path)) return;
  const state = parsePushState(readFileSync(path, "utf8"));
  const occurrenceState = state.occurrences[`${run}:${occurrence}`];
  if (occurrenceState?.github !== "eligible" && occurrenceState?.github !== "reserved") return;
  occurrenceState.github = outcome;
  if (outcome === "posted") {
    const commentKey = `${run}:${ticket}`;
    state.ticketComments[commentKey] = (state.ticketComments[commentKey] ?? 0) + 1;
  }
  writeJsonAtomically(path, state);
}

/** The claim, `duplicate` when this occurrence was already claimed, or `failed` when the record could not say. */
function lockedClaim(root: string, run: string, input: ClaimInput): ClaimResult | "duplicate" | "failed" {
  const path = join(root, PUSH_STATE_RELATIVE_PATH);
  const args = [
    "-x",
    "-w",
    String(timeoutMs() / 1000),
    `${path}.lock`,
    process.execPath,
    fileURLToPath(import.meta.url),
    "claim",
    "--kind",
    input.kind,
    "--occurrence",
    input.occurrence,
    ...(input.ticket === null ? [] : ["--ticket", String(input.ticket)]),
  ];
  assertAllowedPushCommand("lock", args);
  const result = spawnSync("flock", args, {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs() + 1_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, RALPH_RUN_ID: run },
  });
  if (result.status !== 0) return "failed";
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (parsed === null) return "duplicate";
    if (typeof parsed !== "object") return "failed";
    const value = parsed as Partial<ClaimResult>;
    const github = value.github;
    const plugins = value.plugins;
    if (
      github === undefined ||
      !["eligible", "reserved", "posted", "attempted", "capped", "unavailable", "unheld", "absent"].includes(github) ||
      !Array.isArray(plugins) ||
      !plugins.every((name) => typeof name === "string")
    ) return "failed";
    return { github, plugins };
  } catch {
    return "failed";
  }
}

function lockedReserve(root: string, run: string, input: ClaimInput): "reserved" | "capped" | null {
  if (input.ticket === null) return null;
  const path = join(root, PUSH_STATE_RELATIVE_PATH);
  const args = [
    "-x",
    "-w",
    String(timeoutMs() / 1000),
    `${path}.lock`,
    process.execPath,
    fileURLToPath(import.meta.url),
    "reserve",
    "--occurrence",
    input.occurrence,
    "--ticket",
    String(input.ticket),
  ];
  assertAllowedPushCommand("lock", args);
  const result = spawnSync("flock", args, {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs() + 1_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, RALPH_RUN_ID: run },
  });
  if (result.status !== 0) return null;
  return result.stdout === "reserved" || result.stdout === "capped" ? result.stdout : null;
}

function lockedFinalize(
  root: string,
  run: string,
  input: ClaimInput,
  outcome: CommentOutcome,
): void {
  if (input.ticket === null) return;
  const path = join(root, PUSH_STATE_RELATIVE_PATH);
  const args = [
    "-x",
    "-w",
    String(timeoutMs() / 1000),
    `${path}.lock`,
    process.execPath,
    fileURLToPath(import.meta.url),
    "finalize",
    "--occurrence",
    input.occurrence,
    "--outcome",
    outcome,
    "--ticket",
    String(input.ticket),
  ];
  assertAllowedPushCommand("lock", args);
  spawnSync("flock", args, {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs() + 1_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, RALPH_RUN_ID: run },
  });
}

export function push(root: string, input: PushInput): void {
  const run = process.env.RALPH_RUN_ID?.trim() || "adhoc";
  const path = join(root, PUSH_STATE_RELATIVE_PATH);
  // The pattern file is the harness's (beside runner-failure.ts), never the project's.
  const signalConfig = loadSignalConfig();
  const redactable = hasPatterns(signalConfig);
  const redact = buildRedactor(process.env, signalConfig);
  const subject = redactable ? redact(input.subject) : `Ralph ${input.kind}`;
  const body = redactable
    ? redact(input.body)
    : "Details withheld because runner-signals.json could not be read.";
  const id = `${run}:${input.occurrence}`;
  const nowIso = (): string => new Date().toISOString();
  const raisedLine = (plugins: string[], github: PushOccurrence["github"], unsent?: string): FeedLine => ({
    version: 1,
    event: "raised",
    id,
    at: nowIso(),
    run,
    loop: process.env.RALPH_LOOP_NAME?.trim() || null,
    kind: input.kind,
    subject,
    body,
    priority: input.priority,
    ticket: input.ticket,
    iteration: input.iteration ?? positiveInteger(process.env.RALPH_ITERATION),
    plugins,
    github,
    ...(unsent === undefined ? {} : { unsent }),
    ...(input.retry === undefined ? {} : { retry: input.retry }),
  });
  // With pushes switched off the alert is still raised, and the local feed is
  // the one delivery that needs nothing: it goes there and nowhere else.
  if ((process.env.RALPH_PUSH_NOTIFICATIONS ?? "1") === "0") {
    appendFeed(root, raisedLine([], "absent", "pushes are switched off (RALPH_PUSH_NOTIFICATIONS=0)"));
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const claimed = lockedClaim(root, run, input);
  if (claimed === "duplicate") return;
  if (claimed === "failed") {
    // The record could not be claimed, so nothing may be sent (it could be a
    // second sender), but the alert is not allowed to vanish: the feed shows
    // it, and a replay that does claim it is folded into this line by id.
    appendFeed(root, raisedLine([], "absent", "the notification record could not be locked, so nothing was sent"));
    return;
  }

  // A plugin enabled but not installed is offered too, so the host records
  // it and the feed shows the alert did not reach it.
  let missing: string[] = [];
  try {
    missing = enabledPlugins(root).unknown;
  } catch {
    missing = [];
  }
  const plugins = [...missing, ...claimed.plugins];
  appendFeed(root, raisedLine(plugins, claimed.github));
  const clean = (text: string): string =>
    redactable ? redact(text) : "Details withheld because runner-signals.json could not be read.";
  const commented = (outcome: CommentFeedOutcome, why: string | null): void =>
    appendFeed(root, {
      version: 1,
      event: "delivery",
      id,
      at: nowIso(),
      channel: "github",
      name: "github",
      ok: outcome === "posted",
      why,
      outcome,
    });

  if (plugins.length > 0) {
    // Redacted before it leaves: a plugin sees what a ticket comment would.
    const answers = offer(root, "notify", {
      alert: {
        kind: input.kind,
        occurrence: input.occurrence,
        subject,
        body,
        priority: input.priority,
        ticket: input.ticket,
        run,
      },
    });
    for (const answer of answers) {
      appendFeed(root, {
        version: 1,
        event: "delivery",
        id,
        at: nowIso(),
        channel: "plugin",
        name: answer.plugin,
        ok: answer.ok,
        ran: answer.ran,
        why: answer.ok ? null : clean(answer.why ?? "the plugin gave no reason"),
      });
    }
  }
  if (claimed.github === "eligible" && input.ticket !== null) {
    const unheld = `this run no longer holds a live claim on #${input.ticket}`;
    const footer = usageFooter(root, input.kind, input.ticket);
    if (footer === "") {
      lockedFinalize(root, run, input, "unavailable");
      commented("unavailable", "the usage footer every ticket comment carries could not be produced");
    } else if (!heldTicket(root, run, input.ticket)) {
      lockedFinalize(root, run, input, "unheld");
      commented("unheld", unheld);
    } else {
      const reserved = lockedReserve(root, run, input);
      if (reserved === "capped") {
        commented("capped", `this run has already commented ${MAX_GITHUB_COMMENTS_PER_TICKET} times on #${input.ticket}`);
      } else if (reserved === null) {
        commented("unavailable", "the notification record could not be locked to reserve the comment");
      } else if (!heldTicket(root, run, input.ticket)) {
        lockedFinalize(root, run, input, "unheld");
        commented("unheld", unheld);
      } else {
        const delivery = comment(root, input.ticket, subject, body, footer);
        if (delivery === "ambiguous") {
          commented("ambiguous", "GitHub did not answer in time; the comment may or may not have been posted");
        } else {
          lockedFinalize(root, run, input, delivery === "posted" ? "posted" : "unavailable");
          commented(delivery === "posted" ? "posted" : "unavailable", delivery === "posted" ? null : "GitHub refused the comment");
        }
      }
    }
  }
}

function main(): void {
  const root = resolve(
    process.env.RALPH_STATE_ROOT?.trim() || projectRoot(),
  );
  process.chdir(root);
  const argv = process.argv.slice(2);
  let pushArgv: string[];
  if (argv[0] === "claim") {
    const input = claimInputFrom(argv.slice(1));
    if (input !== null) {
      const run = process.env.RALPH_RUN_ID?.trim() || "adhoc";
      process.stdout.write(JSON.stringify(claimState(root, run, input)));
    }
    return;
  } else if (argv[0] === "finalize") {
    const occurrence = flag(argv.slice(1), "occurrence")?.trim();
    const outcome = flag(argv.slice(1), "outcome")?.trim();
    const ticket = Number(flag(argv.slice(1), "ticket"));
    if (
      occurrence &&
      (outcome === "posted" || outcome === "unavailable" || outcome === "unheld") &&
      Number.isSafeInteger(ticket) &&
      ticket > 0
    ) {
      const run = process.env.RALPH_RUN_ID?.trim() || "adhoc";
      finalizeComment(root, run, occurrence, ticket, outcome);
    }
    return;
  } else if (argv[0] === "reserve") {
    const occurrence = flag(argv.slice(1), "occurrence")?.trim();
    const ticket = Number(flag(argv.slice(1), "ticket"));
    if (occurrence && Number.isSafeInteger(ticket) && ticket > 0) {
      const run = process.env.RALPH_RUN_ID?.trim() || "adhoc";
      process.stdout.write(reserveComment(root, run, occurrence, ticket) ?? "");
    }
    return;
  } else if (argv[0] === "observation") {
    const stage = flag(argv.slice(1), "stage")?.trim();
    if (!stage) return;
    const run = process.env.RALPH_RUN_ID?.trim() || null;
    const session = process.env.RALPH_SESSION_ID?.trim() || null;
    const observation = readObservations(observationPath(process.env, root))
      .filter((row) => row.stage === stage && row.run === run)
      .filter((row) => session === null || row.attempt.session === session)
      .at(-1);
    const mapped = observation ? pushArgsForObservation(observation) : null;
    if (mapped === null) return;
    pushArgv = mapped.slice(1);
  } else if (argv[0] === "record") {
    const run = process.env.RALPH_RUN_ID?.trim() || "adhoc";
    for (const input of pushInputsForRecord(argv.slice(1), inferredTicket(root, run))) push(root, input);
    return;
  } else if (argv[0] === "push") {
    pushArgv = argv.slice(1);
  } else {
    return;
  }
  const input = inputFrom(pushArgv);
  if (input !== null) push(root, input);
}

if (import.meta.main) {
  try {
    main();
  } catch {
    // Notifications never fail the loop's own work.
  }
}
