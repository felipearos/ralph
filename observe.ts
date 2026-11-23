#!/usr/bin/env bun
/** A read-only, operator-facing projection of one Ralph worktree. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { journalBlockKind } from "./block-reason";
import { leasePathFromGit, type ClaimLease } from "./claim-lease";
import { type Clock, type LoopReport, worktreeReport } from "./loop-state";
import { STAGES, type Stage } from "./models";
import { projectRoster } from "./roster";
import { leaseForRun } from "./runner-failure";
import { baseEvent, enabledPlugins, offerEvents } from "./plugins";
import {
  activitiesFor,
  stageEventFor,
  type TimelineActivity,
  type TimelineEvent,
} from "./timeline";
import { journalLocation } from "./journal-home";
import { RALPH_HOME, projectRoot } from "./paths";
import { loadProjectConfig } from "./project-config";

export type ActorState = "running" | "completed" | "failed" | "degraded" | "unknown";

export interface ActorPresence {
  stage: Stage;
  state: ActorState;
  invocation: string | null;
  runner: string | null;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  lastAction: string | null;
  activityAt: string | null;
}

export interface PresenceSnapshot {
  loop: string;
  run: string | null;
  status: string;
  supervisor: string;
  issue: number | null;
  branch: string | null;
  iteration: { index: number; max: number | null } | null;
  actors: ActorPresence[];
  recent: TimelineActivity[];
  issues: IssueHistory[];
  failureReason: string | null;
  observedAt: string;
}

export type IssueState = "active" | "merged" | "pr" | "handoff" | "blocked" | "failed";

export interface IssueHistory {
  issue: number;
  state: IssueState;
  pr: number | null;
  draft: boolean;
  title: string | null;
  detail: string | null;
  /** For a blocked outcome, whether it waits on a migration (`block-reason.ts`); else null. */
  block: "migration" | "other" | null;
  at: string;
}

const defaultClock = (): Clock => ({
  nowMs: Date.now(),
  loopStaleAfterMs: 60 * 60 * 1000,
  worktreeStaleAfterMs: 7 * 24 * 60 * 60 * 1000,
});

const actor = (stage: Stage): ActorPresence => ({
  stage,
  state: "unknown",
  invocation: null,
  runner: null,
  model: null,
  startedAt: null,
  endedAt: null,
  lastAction: null,
  activityAt: null,
});

const journalTime = (name: string): string | null => {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(name);
  return match
    ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`
    : null;
};

/**
 * The roster a branch is read against. A worktree whose config is missing,
 * invalid or older than `loops` is still shown: the observer is read-only and
 * must not lose a loop over it, so it reads the branch against the loop's own
 * recorded name alone rather than guess a roster.
 */
export function rosterOrOwn(root: string, own: string | undefined): readonly string[] {
  try {
    return projectRoster(root);
  } catch {
    return own === undefined ? [] : [own];
  }
}

/**
 * The ticket a loop's branch names: `<loop>/<n>-…`, for a loop of the
 * project's roster (`loops` in its config). A branch no roster loop owns names
 * no ticket, however it is spelt.
 */
export const issueFromBranch = (branch: string | null | undefined, roster: readonly string[]): number | null => {
  const value = branch?.match(new RegExp(`(?:${roster.join("|")})\\/(\\d+)(?:-|$)`))?.[1];
  return value ? Number(value) : null;
};

// Any loop name the entry is signed with; `journalIssue` keeps only the loop
// it was asked about, so another loop's entry is never attributed to it.
const JOURNAL_OWNER = /Loop:\s*\*\*([a-z][a-z0-9]*)\*\*/i;

const journalIssue = (name: string, body: string, loop: string): IssueHistory | null => {
  const issue = Number((/^\d{8}T\d{6}Z-(\d+)-/.exec(name))?.[1]);
  const at = journalTime(name);
  const owner = JOURNAL_OWNER.exec(body)?.[1]?.toLowerCase();
  const outcome = (/^\*\*Outcome:\s*([^*]+?)\.\*\*/im.exec(body))?.[1]?.trim() ?? "";
  if (!Number.isInteger(issue) || !at || owner !== loop || !outcome) return null;

  const heading = (/^#\s+[^\n]*?#\d+:\s*(.+)$/m.exec(body))?.[1] ?? null;
  const title = heading
    ?.replace(/\s*\(PR\s+#\d+,[^)]*\)/i, "")
    .replace(/\s+[—-]\s+(?:MERGED|FAILED|BLOCKED).*$/i, "")
    .trim() ?? null;
  const prMatch = /PR\s+(?:\*\*)?#(\d+)(?:\*\*)?/i.exec(body);
  const pr = prMatch ? Number(prMatch[1]) : null;
  const draft = /\bDRAFT\b|open as a\s+\*\*draft\*\*/i.test(body.slice(0, 1_500));
  const lower = outcome.toLowerCase();
  const state: IssueState = lower.startsWith("merged")
    ? "merged"
    : lower.startsWith("blocked")
      ? "blocked"
      : lower.startsWith("failed")
        ? "failed"
        : pr
          ? "pr"
          : "handoff";
  const reason = (/\(([^)]+)\)/.exec(outcome))?.[1] ?? null;
  return { issue, state, pr, draft, title, detail: reason, block: state === "blocked" ? journalBlockKind(outcome) : null, at };
};

/** One published journal entry: its file name and body. */
export interface JournalEntry {
  name: string;
  body: string;
}

export type JournalReader = () => JournalEntry[];

/**
 * The published journal for the project at `root`: `<journal.dir>` on the
 * HARNESS repository's `origin/main`, which is where every loop's publisher
 * pushes — or on the project's own `origin/<journal.branch>` when it names one
 * (`journal-home.ts`). Read with bounded `git` calls and never fetched here
 * (the observer redraws often); any failure reads as no journal, unless
 * `options.strict` asks for it to be thrown.
 */
export function harnessJournalReader(
  root: string,
  home: string = RALPH_HOME,
  env: Record<string, string | undefined> = process.env,
  // strict: a journal that cannot be read throws instead of reading as no
  // journal, for a caller that must tell "none yet" from "unreadable".
  options: { strict?: boolean } = {},
): JournalReader {
  return () => {
    let dir = env.RALPH_JOURNAL_DIR?.trim() ?? "";
    if (dir === "") {
      try {
        dir = loadProjectConfig(root).journal.dir;
      } catch (error) {
        if (options.strict) throw error;
        return [];
      }
    }
    const local = journalLocation(root, env);
    const repo = local.projectSide ? local.home : home;
    const ref = local.ref;
    const git = (args: string[], input?: string): string =>
      execFileSync("git", ["-C", repo, ...args], {
        encoding: "utf8",
        input,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
    const entries: JournalEntry[] = [];
    try {
      const names = git(["ls-tree", "--name-only", ref, `${dir.replace(/\/+$/, "")}/`])
        .split("\n")
        .filter((path) => /\/\d{8}T\d{6}Z-[^/]*\.md$/.test(path))
        .sort()
        .slice(-200);
      if (names.length === 0) return entries;
      let output: string;
      try {
        output = git(["cat-file", "--batch"], names.map((path) => `${ref}:${path}\n`).join(""));
      } catch (error) {
        // A bounded batch may end midway through a later object. Keep its
        // complete prefix, as sequential reads kept entries before a failure.
        // Other failures (including timeouts) remain an unavailable journal.
        if (
          typeof error !== "object" || error === null || !("code" in error) ||
          error.code !== "ENOBUFS" || !("stdout" in error) || typeof error.stdout !== "string"
        ) throw error;
        output = error.stdout;
      }
      const bytes = Buffer.from(output, "utf8");
      let offset = 0;
      for (const path of names) {
        const end = bytes.indexOf(0x0a, offset);
        if (end === -1) break;
        const sizeText = /^\S+ blob (\d+)$/.exec(bytes.subarray(offset, end).toString("utf8"))?.[1];
        if (sizeText === undefined) break;
        const size = Number(sizeText);
        offset = end + 1;
        // Preserve the readable prefix on missing objects or malformed output,
        // just as sequential git show stopped at its first failed read.
        if (!Number.isSafeInteger(size) || offset + size >= bytes.length || bytes[offset + size] !== 0x0a) break;
        entries.push({ name: path.slice(path.lastIndexOf("/") + 1), body: bytes.subarray(offset, offset + size).toString("utf8") });
        offset += size + 1;
      }
    } catch (error) {
      // No harness repo, no origin/main, or no journal yet: current work remains visible.
      if (options.strict) throw error;
    }
    return entries;
  };
}

/** Recent outcomes for this loop, read from records the agents already write. */
export function readIssueHistory(
  root: string,
  loop: string,
  currentIssue: number | null,
  limit = 5,
  readJournal: JournalReader = harnessJournalReader(root),
): IssueHistory[] {
  const records: IssueHistory[] = [];
  try {
    for (const { name, body } of readJournal()) {
      const record = journalIssue(name, body, loop);
      if (record) records.push(record);
    }
  } catch {
    // An unreadable journal is no journal. Current work remains visible.
  }
  try {
    const ledger = readFileSync(join(root, ".ralph", "logs", "runner-failures.jsonl"), "utf8");
    for (const line of ledger.split("\n")) {
      if (!line.trim()) continue;
      try {
        const failure = JSON.parse(line) as Record<string, unknown>;
        if (failure.loop !== loop || !Number.isInteger(failure.issue)) continue;
        records.push({
          issue: failure.issue as number,
          state: "failed",
          pr: null,
          draft: false,
          title: null,
          detail: [failure.stage, failure.kind].filter((item) => typeof item === "string").join(" ") || null,
          block: null,
          at: typeof failure.at === "string" ? failure.at : new Date(0).toISOString(),
        });
      } catch {
        // A writer killed midway through its JSONL append does not hide older rows.
      }
    }
  } catch {
    // Failure history is optional.
  }

  const newest = new Map<number, IssueHistory>();
  for (const record of records.sort((left, right) => right.at.localeCompare(left.at))) {
    if (!newest.has(record.issue)) newest.set(record.issue, record);
  }
  if (currentIssue) {
    newest.delete(currentIssue);
    records.unshift({
      issue: currentIssue,
      state: "active",
      pr: null,
      draft: false,
      title: null,
      detail: null,
      block: null,
      at: new Date().toISOString(),
    });
  }
  const previous = [...newest.values()].sort((left, right) => right.at.localeCompare(left.at));
  return [...(currentIssue ? records.slice(0, 1) : []), ...previous].slice(0, limit);
}

export function projectActors(
  events: TimelineEvent[],
  report: Pick<LoopReport, "loopStatus" | "supervisor" | "state">,
): ActorPresence[] {
  const actors = new Map<Stage, ActorPresence>();
  const get = (stage: Stage): ActorPresence => {
    const current = actors.get(stage) ?? actor(stage);
    actors.set(stage, current);
    return current;
  };

  for (const event of events) {
    const boundary = stageEventFor(event);
    if (boundary) {
      const current = get(boundary.stage);
      if (current.invocation !== boundary.invocation && boundary.state === "started") {
        Object.assign(current, actor(boundary.stage));
      }
      current.invocation = boundary.invocation;
      current.runner = boundary.runner;
      current.model = boundary.model;
      if (boundary.state === "started") {
        current.state = "running";
        current.startedAt = boundary.at;
        current.endedAt = null;
      } else {
        current.state = boundary.state;
        current.endedAt = boundary.at;
      }
      continue;
    }
    for (const activity of activitiesFor(event)) {
      const current = get(activity.stage);
      current.lastAction = activity.label;
      current.activityAt = activity.at;
    }
  }

  if (report.state?.iteration && report.supervisor === "alive") {
    const orchestrator = get("orchestrator");
    if (orchestrator.state === "unknown") orchestrator.state = "running";
  }

  return STAGES.filter((stage) => actors.has(stage)).map((stage) => actors.get(stage)!);
}

export const activeIssueFor = (
  lease: Pick<ClaimLease, "issue" | "expiresAt"> | null,
  report: Pick<LoopReport, "loopStatus" | "supervisor" | "state">,
  nowMs: number,
): number | null =>
  lease !== null &&
  Date.parse(lease.expiresAt) > nowMs &&
  report.loopStatus === "running" &&
  report.supervisor === "alive" &&
  report.state?.stopReason === null
    ? lease.issue
    : null;

export function observeRun(root: string, clock: Clock = defaultClock()): PresenceSnapshot {
  const scoped = worktreeReport(root, clock);
  if (!scoped) {
    return {
      loop: "unknown",
      run: null,
      status: "unknown",
      supervisor: "unknown",
      issue: null,
      branch: null,
      iteration: null,
      actors: [],
      recent: [],
      issues: [],
      failureReason: null,
      observedAt: new Date(clock.nowMs).toISOString(),
    };
  }
  const { report, timeline } = scoped;
  const state = report.state;
  let lease = null;
  if (state) {
    try {
      lease = leaseForRun(state.run, leasePathFromGit(root), clock.nowMs);
    } catch {
      // The observer stays useful while git metadata is briefly unavailable.
    }
  }
  const issue = lease?.issue ?? issueFromBranch(report.branch, rosterOrOwn(root, state?.owner.loop));
  const activeIssue = activeIssueFor(lease, report, clock.nowMs);
  const loop = state?.owner.loop ?? "unknown";
  return {
    loop,
    run: state?.run ?? null,
    status: report.loopStatus,
    supervisor: report.supervisor,
    issue,
    branch: report.branch,
    iteration: state?.iteration ?? null,
    actors: projectActors(timeline.events, report),
    recent: timeline.activities.slice(-200),
    issues: readIssueHistory(root, loop, activeIssue),
    failureReason: state?.stopReason?.kind === "failed" ? state.stopReason.why : null,
    observedAt: new Date(clock.nowMs).toISOString(),
  };
}

/** How often a long-lived observer tells plugins it is watching. */
export const OBSERVER_EVENT_INTERVAL_MS = 60_000;

/**
 * Tell enabled plugins a long-lived observer is watching this run.
 *
 * A plugin may want the observer's pane for something — binding it as the
 * consumer of a mailbox, say — and only the observer's own process has that
 * pane's environment. Offered through the host, so rendering never waits
 * on a plugin longer than the host allows and survives any plugin failing.
 */
export function announceObserver(root: string, presence: PresenceSnapshot): void {
  if (presence.run === null) return;
  try {
    offerEvents(root, [{ ...baseEvent(root, "observer"), run: presence.run }]);
  } catch {
    // An announcement is a convenience. Rendering must survive its loss.
  }
}

export const shouldAnnounceObserver = (args: string[]): boolean =>
  !args.includes("--once") && !args.includes("--json");

/** Announce on a new run at once, and otherwise once per interval. */
export function shouldAttemptAnnouncement(
  run: string | null,
  previousRun: string | null,
  previousAt: number,
  nowMs: number,
  intervalMs = OBSERVER_EVENT_INTERVAL_MS,
): boolean {
  return run !== null && (run !== previousRun || nowMs - previousAt >= intervalMs);
}

const age = (at: string | null, now: number): string => {
  if (!at) return "—";
  const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
};

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  purple: "\u001b[38;5;135m",
  green: "\u001b[38;5;78m",
  yellow: "\u001b[38;5;221m",
  red: "\u001b[38;5;203m",
  violet: "\u001b[38;5;141m",
  gray: "\u001b[38;5;245m",
} as const;

const ISSUE_DISPLAY: Record<
  IssueState,
  { tone: keyof typeof ANSI; mark: string; label: string }
> = {
  active: { tone: "green", mark: "●", label: "ACTIVE" },
  merged: { tone: "green", mark: "✓", label: "MERGED" },
  pr: { tone: "violet", mark: "◆", label: "PR" },
  handoff: { tone: "violet", mark: "◇", label: "HANDOFF" },
  blocked: { tone: "yellow", mark: "◇", label: "BLOCKED" },
  failed: { tone: "red", mark: "!", label: "FAILED" },
};

const paint = (enabled: boolean, tone: keyof typeof ANSI, value: string): string =>
  enabled ? `${ANSI[tone]}${value}${ANSI.reset}` : value;

const stateTone = (state: string): keyof typeof ANSI => {
  if (state === "running" || state === "completed" || state === "alive") return "green";
  if (state === "failed" || state === "dead") return "red";
  return "yellow";
};

const compact = (value: string, limit = 120): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;

export const plainAction = (label: string): string =>
  label
    .replace(/\*\*/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(?:^|\s)#{1,6}\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const actionSummary = (stage: Stage, label: string): string => {
  const action = plainAction(label);
  const lower = action.toLowerCase();
  if (/^rate limit \S+$/.test(lower)) {
    return lower === "rate limit rejected" ? "rate limited, retrying" : "rate limit ok";
  }
  if (lower.includes("rate limit")) return "rate limited, retrying";
  if (lower.includes("inspect.sh review") && (lower.includes("until") || lower.includes("pgrep"))) {
    return "waiting for review agents";
  }
  if (lower.includes("inspect.sh review") || lower.includes("review-standards")) {
    return "checking review results";
  }
  if (lower.includes("bun run typecheck")) return "running typecheck";
  if (lower.includes("bun run test") || lower.includes("vitest")) return "running tests";
  if (lower.includes("gh pr checks")) return "waiting for CI";
  if (lower.includes("test files") || /tests?\s+\d+\s+passed/.test(lower)) return "tests passed";
  if (
    lower.includes("prototype-chain guard") ||
    (lower.includes("python3") && lower.includes("src/"))
  ) {
    return "applying review fixes";
  }
  if (lower.includes("thinking_tokens") || lower === "thinking —") return "thinking";
  if (lower.includes("task_started")) return "working";
  if (/^(?:tool\s+)?result ok\s+—\s+ok$/i.test(action)) return "command finished";
  if (lower.startsWith("text —")) {
    if (stage === "executor") return "implementing the issue";
    if (stage === "mapper") return "mapping relevant code";
    if (stage === "review.standards") return "checking code standards";
    if (stage === "review.spec") return "checking issue requirements";
    if (stage === "review.correctness") return "hunting bugs in the change";
    return "coordinating the iteration";
  }
  return action.replace(/^tool\s+/i, "").replace(/^system\s+—\s+/i, "");
};

interface RecentRow {
  stage: Stage;
  at: string;
  label: string;
  count: number;
}

export const compactRecent = (recent: TimelineActivity[]): RecentRow[] => {
  const rows: RecentRow[] = [];
  for (const item of recent) {
    const summary = actionSummary(item.stage, item.label);
    const label = summary === "thinking" || summary === "working" ? summary : plainAction(item.label);
    const previous = rows.at(-1);
    if (previous?.stage === item.stage && previous.label === label) {
      previous.at = item.at;
      previous.count += 1;
      continue;
    }
    rows.push({ stage: item.stage, at: item.at, label, count: 1 });
  }
  return rows;
};

export const currentStep = (presence: PresenceSnapshot): { stage: Stage; action: string } | null => {
  const external = presence.actors.find(
    (item) => item.stage !== "orchestrator" && item.state === "running",
  );
  if (external) {
    return {
      stage: external.stage,
      action: actionSummary(external.stage, external.lastAction ?? "working"),
    };
  }
  const meaningful = [...presence.recent]
    .reverse()
    .find(
      (item) =>
        !["thinking", "working", "command finished", "rate limited, retrying", "rate limit ok"].includes(
          actionSummary(item.stage, item.label),
        ),
    );
  if (meaningful) {
    return { stage: meaningful.stage, action: actionSummary(meaningful.stage, meaningful.label) };
  }
  const active = presence.actors.find((item) => item.state === "running");
  return active
    ? { stage: active.stage, action: actionSummary(active.stage, active.lastAction ?? "working") }
    : null;
};

export const activeWarning = (presence: PresenceSnapshot, now = Date.now()): string | null => {
  let index = presence.recent.length - 1;
  while (
    index >= 0 &&
    actionSummary(presence.recent[index]!.stage, presence.recent[index]!.label) !== "rate limited, retrying"
  ) {
    index -= 1;
  }
  if (index === -1) return null;
  const limit = presence.recent[index]!;
  if (now - Date.parse(limit.at) > 5 * 60 * 1000) return null;
  // Anything else the limited stage emits afterwards means its retry went through.
  const resumed = presence.recent
    .slice(index + 1)
    .some(
      (item) =>
        item.stage === limit.stage &&
        actionSummary(item.stage, item.label) !== "rate limited, retrying",
    );
  return resumed ? null : "rate limited, retrying";
};

/** The gate actions that mean the iteration is checking its own work. */
const VERIFY_ACTIONS = [
  "running typecheck",
  "running tests",
  "tests passed",
  "applying review fixes",
  "waiting for CI",
];

/**
 * Which of `prompt.md`'s five phases the iteration is in.
 *
 * Ordered by WHO is working, not by what they typed, and that ordering is the
 * whole of it. An executor's inner loop is write, typecheck, test, fix — so
 * reading the phase off the command made a running executor report "verify and
 * fix" the moment it first ran the suite, and `recent` is a 200-event window,
 * so it never read "implement" again for the rest of it. The rails compound
 * that: both the terminal one and the dashboard's tick every phase below the
 * index, so a wrong 4 also claimed a Review that had not run at all.
 *
 * Hence: a running review stage is review; a review stage that has RUN puts
 * the iteration after it, where fixes and gates live even when the fix is
 * delegated back to the executor; and a running executor is implementing,
 * whatever it types. The action-based test survives only as the fallback for
 * gates the orchestrator runs itself, which is the case it was written for.
 */
export const workflowPhase = (
  presence: PresenceSnapshot,
  step = currentStep(presence),
): { index: number; total: number; label: string } => {
  if (presence.status === "completed") return { index: 5, total: 5, label: "finish" };
  const isVerifyAction = (action: string): boolean => VERIFY_ACTIONS.includes(action);
  const running = (match: (stage: Stage) => boolean): boolean =>
    presence.actors.some((item) => match(item.stage) && item.state === "running");
  const reviewRan = presence.actors.some((item) => item.stage.startsWith("review."));

  if (
    running((stage) => stage.startsWith("review.")) ||
    step?.stage.startsWith("review.") === true ||
    // "applying review fixes" names the phase AFTER this one; it must not be
    // read as review merely for containing the word.
    (step !== null && !isVerifyAction(step.action) && step.action.includes("review"))
  ) {
    return { index: 3, total: 5, label: "review" };
  }
  if (reviewRan) return { index: 4, total: 5, label: "verify and fix" };
  if (running((stage) => stage === "executor") || step?.stage === "executor") {
    return { index: 2, total: 5, label: "implement" };
  }
  const recentActions = presence.recent.map((item) => actionSummary(item.stage, item.label));
  if ((step !== null && isVerifyAction(step.action)) || recentActions.some(isVerifyAction)) {
    return { index: 4, total: 5, label: "verify and fix" };
  }
  return { index: 1, total: 5, label: "select and map" };
};

export function presenceSummary(presence: PresenceSnapshot): string {
  const active = presence.actors.find((item) => item.state === "running") ?? presence.actors.at(-1);
  const where = presence.issue ? `#${presence.issue}` : "no ticket";
  const iteration = presence.iteration
    ? `${presence.iteration.index}/${presence.iteration.max ?? "?"}`
    : "no iteration";
  return [presence.loop, where, iteration, active?.stage, active?.lastAction]
    .filter(Boolean)
    .join(" • ");
}

export function renderPresence(
  presence: PresenceSnapshot,
  now = Date.now(),
  color = false,
  width = 96,
  height = 32,
): string {
  const iteration = presence.iteration
    ? `${presence.iteration.index}/${presence.iteration.max ?? "?"}`
    : "—";
  const runState = presence.status.toUpperCase();
  const supervisor = presence.supervisor.toUpperCase();
  const step = currentStep(presence);
  const phase = workflowPhase(presence, step);
  const live = presence.status === "running" && presence.supervisor === "alive";
  const failed = Boolean(presence.failureReason);
  const warning = activeWarning(presence, now);
  const stepLabel = live ? "NOW" : failed ? "STOPPED" : "LAST SEEN";
  const stepBody = failed
    ? paint(color, "red", compact(presence.failureReason!, Math.max(72, width - 8)))
    : step
      ? `${paint(color, "purple", step.stage)}  ${paint(color, "bold", step.action)}`
      : paint(color, "gray", "waiting for activity");
  const divider = "─".repeat(Math.max(40, width - 2));
  const phases = ["SELECT + MAP", "IMPLEMENT", "REVIEW", "VERIFY + FIX", "FINISH"];
  const phaseRail = phases
    .map((label, index) => {
      const number = index + 1;
      const mark = number < phase.index ? "✓" : number === phase.index ? "●" : "○";
      const tone = number < phase.index ? "green" : number === phase.index ? "violet" : "gray";
      return paint(color, tone, `${mark} ${label}`);
    })
    .join(paint(color, "dim", "  ──  "));
  const lines = [
    `${paint(color, "purple", presence.loop.toUpperCase())} ${paint(color, "gray", "/")} ${paint(color, "bold", "AGENT WATCH")}`,
    `${paint(color, stateTone(presence.status), "●")} ${paint(color, stateTone(presence.status), runState.padEnd(9))}  issue ${paint(color, "bold", presence.issue ? `#${presence.issue}` : "—")}  iteration ${paint(color, "bold", iteration)}`,
    `${paint(color, stateTone(presence.supervisor), "●")} supervisor ${paint(color, stateTone(presence.supervisor), supervisor.toLowerCase())}  ${paint(color, "gray", compact(presence.branch ?? "no branch", 72))}`,
    paint(color, "dim", `run ${presence.run ?? "none"}`),
    ...(warning
      ? [`${paint(color, "yellow", "!")} ${paint(color, "yellow", "RATE LIMITED")}  retrying automatically`]
      : []),
    "",
    `${paint(color, failed ? "red" : live ? "violet" : "yellow", `┌─ ${stepLabel}`)} ${paint(color, "bold", `PHASE ${phase.index}/${phase.total}`)} ${paint(color, "violet", phase.label.toUpperCase())}`,
    `${paint(color, failed ? "red" : live ? "violet" : "yellow", "│")}  ${stepBody}`,
    paint(color, failed ? "red" : live ? "violet" : "yellow", `└${divider.slice(1)}`),
    "",
    paint(color, "violet", "WORKFLOW"),
    phaseRail,
    "",
    paint(color, "violet", "ISSUES"),
  ];
  if (presence.issues.length === 0) lines.push(paint(color, "gray", "no issue history yet"));
  for (const issue of presence.issues) {
    const display = ISSUE_DISPLAY[issue.state];
    const detail = issue.state === "active"
      ? phase.label
      : [issue.pr ? `PR #${issue.pr}` : null, issue.draft ? "draft" : null, issue.detail, issue.title]
          .filter(Boolean)
          .join(" · ");
    lines.push(
      `${paint(color, display.tone, display.mark)} ${paint(color, "bold", `#${issue.issue}`.padEnd(6))} ${paint(color, display.tone, display.label.padEnd(9))} ${paint(color, "gray", compact(detail || "recorded outcome", Math.max(40, width - 28)))}`,
    );
  }
  lines.push(
    "",
    paint(color, "violet", "AGENTS"),
    paint(color, "dim", divider),
  );
  if (presence.actors.length === 0) lines.push("no stage activity yet");
  for (const item of presence.actors) {
    const action = plainAction(item.lastAction ?? "waiting for activity");
    const identity = [item.runner, item.model].filter(Boolean).join(" · ");
    const displayState = item.state === "unknown" ? "untracked" : item.state;
    lines.push(
      `${paint(color, stateTone(item.state), "●")} ${paint(color, "purple", item.stage.padEnd(18))} ${paint(color, stateTone(item.state), displayState.toUpperCase().padEnd(9))}${identity ? ` ${paint(color, "gray", compact(identity, 42))}` : ""}  ${paint(color, "dim", age(item.activityAt ?? item.startedAt, now))}`,
      `  ${paint(color, "gray", "└")} ${compact(action, Math.max(40, width - 4))}`,
    );
  }
  lines.push(
    "",
    paint(color, "violet", "RECENT"),
    paint(color, "dim", divider),
  );
  if (presence.recent.length === 0) lines.push("no timeline events yet");
  const fixedRows = 23 + presence.issues.length + presence.actors.length * 2 + (warning ? 1 : 0);
  const recentLimit = Math.max(8, Math.min(80, height - fixedRows));
  for (const item of compactRecent(presence.recent).slice(-recentLimit)) {
    const count = item.count > 1 ? paint(color, "yellow", ` ×${item.count}`) : "";
    lines.push(
      `${paint(color, "dim", item.at.slice(11, 19))} ${paint(color, "purple", item.stage.padEnd(18))} ${compact(item.label, Math.max(40, width - 30))}${count}`,
    );
  }
  return lines.join("\n");
}

const flag = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

/**
 * Paint the first dashboard once, then touch only rows whose text changed.
 * Clearing the whole terminal on every poll makes an embedded terminal
 * flash even when the underlying agent state barely moved.
 */
export function renderLiveFrame(previous: string | null, next: string): string {
  if (previous === next) return "";
  if (previous === null) return `\u001b[?25l\u001b[2J\u001b[H${next}`;

  const before = previous.split("\n");
  const after = next.split("\n");
  const rows = Math.max(before.length, after.length);
  let update = "\u001b[?25l";
  for (let index = 0; index < rows; index += 1) {
    if (before[index] === after[index]) continue;
    update += `\u001b[${index + 1};1H\u001b[2K${after[index] ?? ""}`;
  }
  return `${update}\u001b[${after.length + 1};1H`;
}

function main(): void {
  const args = process.argv.slice(2);
  const root = process.env.RALPH_OBSERVER_ROOT ?? projectRoot();
  let lastAnnouncedRun: string | null = null;
  let lastAnnouncedAt = 0;
  const announcing = shouldAnnounceObserver(args);
  const frame = (): string => {
    const presence = observeRun(root);
    if (announcing) {
      const now = Date.now();
      // Asked at each announcement rather than once, so a plugin enabled while
      // the observer runs is announced to; with none, no plugin call is made.
      if (
        shouldAttemptAnnouncement(presence.run, lastAnnouncedRun, lastAnnouncedAt, now) &&
        enabledPlugins(root).names.length > 0
      ) {
        lastAnnouncedRun = presence.run;
        lastAnnouncedAt = now;
        announceObserver(root, presence);
      }
    }
    // The JSON form carries the same derived reading the text frame paints, so
    // a consumer (the dashboard) shows the observer's step and phase rather
    // than re-deriving them from the raw actors and timeline.
    if (args.includes("--json")) {
      const step = currentStep(presence);
      return JSON.stringify(
        { ...presence, step, phase: workflowPhase(presence, step), warning: activeWarning(presence) },
        null,
        2,
      );
    }
    return renderPresence(
      presence,
      Date.now(),
      Boolean(process.stdout.isTTY) && !("NO_COLOR" in process.env),
      process.stdout.columns ?? 96,
      process.stdout.rows ?? 32,
    );
  };
  if (args.includes("--once") || args.includes("--json")) {
    console.log(frame());
    return;
  }
  const interval = Math.max(1, Number(flag(args, "interval") ?? 2)) * 1000;
  if (!process.stdout.isTTY) {
    console.log(frame());
    setInterval(() => console.log(frame()), interval);
    return;
  }

  let previous: string | null = null;
  let paintedRows = 0;
  const redraw = (): void => {
    const next = frame();
    process.stdout.write(renderLiveFrame(previous, next));
    previous = next;
    paintedRows = next.split("\n").length;
  };
  redraw();
  const timer = setInterval(redraw, interval);
  process.stdout.on("resize", () => {
    previous = null;
    redraw();
  });
  const stop = (exitCode: number): void => {
    clearInterval(timer);
    process.stdout.write(`\u001b[?25h\u001b[${paintedRows + 1};1H\n`);
    process.exitCode = exitCode;
  };
  process.once("SIGINT", () => stop(130));
  process.once("SIGTERM", () => stop(143));
  process.once("exit", () => process.stdout.write("\u001b[?25h"));
}

if (import.meta.main) main();
