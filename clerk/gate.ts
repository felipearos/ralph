#!/usr/bin/env bun
/**
 * The clerk's intake gate: block until the Slack channel holds a settled
 * report nobody has filed yet, then hand it over (felipearos/ralph#315).
 *
 * Same contract as `frontier-gate.ts`, `ci-doctor/gate.ts` and
 * `pr-medic/gate.ts`, and for their reason: a model turn spent learning that
 * the channel is quiet is a turn the gate could have answered with no model at
 * all. So the gate asks, and the supervisor spawns an iteration only on its
 * `work available — …` line. It honours the control inbox, stops when its
 * supervisor is gone, and an unreadable probe is "nothing to do this poll",
 * never a spawn and never a throw out of the poll.
 *
 * **One poll** (felipearos/ralph#317) reads the channel's top-level messages
 * after the cursor and the threads under them, groups them into reports
 * (`clerk/reports.ts`), and hands over the settled ones nobody has processed —
 * at most `clerk.batchSize`, oldest first — as one batch kept whole in the
 * clerk's store, so the session reads exactly what the gate saw. It then moves
 * the cursor past every report that is done with, and no further.
 *
 * **The canvas** (felipearos/ralph#319) is rebuilt by the same poll, after the
 * channel, once `clerk.canvasMinutes` have passed — in shadow, the operator's
 * test canvas from the would-be tickets (`rebuildCanvas`); live, the channel's
 * own canvas from the clerk's tickets on the Jira intake board
 * (felipearos/ralph#448); quiet, the operator's test canvas from that same
 * board, and never the channel's (felipearos/ralph#443). It is never a reason
 * to hand nothing over, and never a reason to stop.
 *
 * **Quiet mode** (felipearos/ralph#443) writes Jira as live does and nothing
 * in Slack the team can see: its write port holds no Slack client
 * (`quietPort`), its canvas writer can reach `clerk.shadowCanvas` alone
 * (`privateCanvas`), and its KPI report is a draft to the operator
 * (`clerk/kpi.ts` `targetsFor`).
 *
 * The first poll of a store sets the cursor to "now": the spec files nothing
 * from before the clerk started, and the operator moves the cursor again when
 * flipping to live.
 *
 * **Failures** never throw out of a poll and never spawn:
 *
 * - transient (a 5xx, a timeout, the network) is "nothing to do" with a wait
 *   that doubles per consecutive failure, up to an hour;
 * - a 429 waits exactly what `Retry-After` says;
 * - a denial — `invalid_auth`, `missing_scope`, `not_in_channel` and the rest
 *   of `clerk/slack.ts`'s list, or no token at all — stops the loop: the gate
 *   prints the remedy, raises a notification, and writes a `stop` command to
 *   the loop's own inbox, which the supervisor applies at its checkpoint.
 *   Retrying a revoked token all night would only hide it.
 *
 * Usage:
 *   clerk/gate.ts <poll-seconds>     wait until a report is settled, then exit 0
 *   clerk/gate.ts --once             one poll; 0 work, 1 none
 */
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  controlSliceSeconds,
  formatDuration,
  gateResume,
  secretRereadDue,
  secretRereadLine,
  sleepInSlices,
  supervisorGone,
  supervisorPidFrom,
} from "../frontier-gate";
import { hasPendingControl, writeInboxCommand } from "../control-inbox";
import { RALPH_HOME, projectRoot } from "../paths";
import { clerkCodeContext, clerkJira, clerkRules, holdsOaMove, loadProjectConfig, writesJira, type ClerkMode, type ClerkRules } from "../project-config";
import { push, type NotificationKind } from "../push-notification";
import { roleDescriptor } from "../roles";
import { INTAKE_LABEL, applyDecisions, emptyShadow, isPlaceholderKey, journalEntry, postFollowUps, reportAttachments, shadowPort, type Applied, type ShadowRecord, type WritePort } from "./apply";
import { attachPending, pruneAttachments, queueAttachments } from "./attachments";
import { handCodeContext, pruneCodeContext, queueCodeContext, settleCodeContext, type CodeContextDeps, type CodeContextIo } from "./code-context";
import { maxBytesOf } from "./files";
import { CLOSED_DAYS, intakeRows, renderCanvas, renderIntakeCanvas, shadowRows } from "./canvas";
import { readPlan } from "./batch";
import { boardTickets, intakeLinks, intakeSnapshotPath, recordIntakeSnapshot, shadowTickets, shownKeys, type BoardTrail } from "./intake-snapshot";
import { gatherIntakeCandidates } from "./candidates";
import { readOnly, sweep, type SweepBoard, type SweepResult } from "./confirm";
import { moveMerged } from "./merged";
import { scanOutcomes } from "./outcomes";
import { intakePort, issueBody, quietPort } from "./live";
import { appendEvent, clerkMetricsPath, type MetricsEvent } from "./metrics";
import { JIRA_TOKEN_ENV, JiraError, adfText, jiraClient, jqlString, parseJiraToken, toAdf, type JiraClient, type JiraFailure } from "./jira";
import { unclassified, validatePlan, type BatchReport, type Candidate, type Decision } from "./plan";
import { advanceCursor, groupReports, permalink, settled, type Me, type Report } from "./reports";
import { SLACK_TOKEN_ENV, SlackError, compareTs, msTs, slackClient, slackReader, type AuthIdentity, type SlackClient, type SlackFailure, type SlackMessage } from "./slack";
import { clerkStorePath, markProcessed, recordDetermination, withClerkStore, type Batch, type ClerkStore, type Reopened } from "./store";
import { WATCH_DAYS, watchThreads } from "./threads";
import { clerkKpiStatePath, sendDueReport, type KpiDeps } from "./kpi";
import { pullsCachePath, readPulls, type PullsRead } from "./pulls";
import { fetchReadable } from "./readable";

export interface Verdict {
  work: boolean;
  why: string;
  /** How long to wait before the next poll, when the poll's own answer says (a 429, a backoff). */
  waitSeconds?: number;
  /** The loop is to stop: a denial no wait can fix. `queued` says whether the stop reached the inbox. */
  stop?: { why: string; remedy: string; queued: boolean };
  /** What else the poll did that the supervisor log should keep: a canvas rebuilt, recreated, or not rebuilt and why. */
  notes?: string[];
}

export interface Denial {
  code: string;
  why: string;
  remedy: string;
}

export interface PollDeps {
  rules: ClerkRules;
  now: () => number;
  /** Null when the gate was handed no token: a denial, reported like any other. */
  slack: SlackClient | null;
  /**
   * Likewise for Jira: the intake board a live or quiet clerk files on, and
   * that every mode reads for duplicate candidates, the sweep and the canvas.
   * Holding one is not being live — only `portFor` chooses the writer, and
   * only on `rules.mode`. Null when the gate was handed no credential: a
   * denial in live and quiet mode, and no candidates in shadow.
   */
  jira: JiraClient | null;
  storePath: string;
  /** The plan file the session wrote for a batch, parsed, or why it could not be; undefined when there is none. */
  readPlan: (batchId: string) => unknown;
  /** The key the handed batch is signed with: a credential only the gate holds (the Slack token). */
  secret: string;
  /** Raise an alert that is not a denial: the loop keeps running. */
  alert: (alert: { occurrence: string; subject: string; body: string }) => void;
  /** Record one applied batch in the journal: write its draft and publish it, best-effort. */
  journal: (batchId: string, entry: string) => void;
  /** The interval a backoff doubles from. */
  intervalSeconds: number;
  /** Stop the loop: a `stop` command in its own inbox. False when it could not be written. */
  stop: (denial: Denial) => boolean;
  notify: (denial: Denial) => void;
  /**
   * Append one event to the intake metrics ledger (`clerk/metrics.ts`,
   * felipearos/ralph#447): false when the line was lost, which is a note and
   * never a failure. Absent, nothing is recorded.
   */
  ledger?: (event: MetricsEvent) => boolean;
  /** The daily KPI DM (felipearos/ralph#453); absent or null when `clerk.kpiReport` is not configured. */
  kpi?: KpiDeps | null;
  /**
   * The app repos' PRs for the intake page's Seguimiento column
   * (`clerk/pulls.ts`): cached, and a note rather than a throw when GitHub
   * cannot be read. Absent, the page shows no PRs.
   */
  pulls?: (nowMs: number) => Promise<PullsRead>;
  /**
   * Where code-context cases are prepared (felipearos/ralph#499): the loop's
   * worktree, and git and ffmpeg as a test fakes them. Absent or null, or
   * with no `clerk.codeContext`, the feature is off.
   */
  codeContext?: CodeContextDeps | null;
  /**
   * The worktree root the handed batch's PDFs and images are downloaded
   * under, for the session to read (`clerk/readable.ts`). Absent, none are:
   * the session classifies every report from its text.
   */
  filesRoot?: string;
}

/** What a poll remembers for the next one, in this process only. */
export interface Cached {
  /** Consecutive polls that failed transiently. */
  transientStreak: number;
}

export const noCache = (): Cached => ({ transientStreak: 0 });

export interface Polled {
  verdict: Verdict;
  cached: Cached;
}

/** The longest a transient backoff waits: an hour, so an outage is retried every hour all night. */
export const MAX_BACKOFF_SECONDS = 3600;

export const backoffSeconds = (intervalSeconds: number, streak: number): number =>
  Math.min(MAX_BACKOFF_SECONDS, intervalSeconds * 2 ** Math.max(0, streak - 1));

/** A batch's id: its first report's, so the same reports handed again are the same batch. */
export const batchId = (reports: readonly Report[]): string => `batch-${reports[0]!.id}`;

export const caseText = (batch: Batch, channel: string): string =>
  `${batch.reports.length} settled report${batch.reports.length === 1 ? "" : "s"} in ${channel} (${batch.id}, attempt ${batch.attempt}) — oldest ${batch.reports[0]!.permalink}`;

/** In the mode's own word: a quiet clerk is refused on live's terms, and says it is quiet. */
const noIntakeBoard = (mode: ClerkMode): Denial => ({
  code: "no_intake_board",
  why: `the clerk is ${mode} but 'clerk.jira.intakeProject' names no intake board to file reports on`,
  remedy: "set 'clerk.jira.intakeProject' in the project's .ralph/config.json to the Jira intake board's key, or set 'clerk.mode' back to 'shadow', and restart",
});

const noJiraCredential = (mode: ClerkMode): Denial => ({
  code: "no_jira_credential",
  why: `the clerk is ${mode} on the intake board but was handed no ${JIRA_TOKEN_ENV} to file reports with`,
  remedy: `store '<email>:<API token>' of a Jira account that can browse, create, transition and comment in 'clerk.jira.intakeProject' as ${JIRA_TOKEN_ENV} in the project's secrets scope and restart; the supervisor withholds one that fails clerk/jira.ts --check-token`,
});

/** The intake board's key, or null for a shadow clerk without one, which files nothing. */
const intakeOf = (rules: ClerkRules): string | null => clerkJira(rules.jira).intakeProject;

const NO_TOKEN: Denial = {
  code: "no_token",
  why: `the gate was handed no ${SLACK_TOKEN_ENV}`,
  remedy: `store the clerk's Slack bot token as ${SLACK_TOKEN_ENV} in the project's secrets scope and restart; the supervisor withholds one that fails clerk/slack.ts --check-token`,
};

/**
 * One poll. Never throws: whatever goes wrong inside is the poll's answer.
 */
export async function poll(deps: PollDeps, cached: Cached): Promise<Polled> {
  const { rules } = deps;
  if (deps.slack === null) return deny(deps, cached, NO_TOKEN);
  // Live without a board or a credential is refused, never quietly filed in
  // shadow: the operator chose live, and a shadow apply would mark the
  // reports processed. The config validator already refuses a live clerk
  // without a board; this is the gate not trusting a hand-spelled rules
  // object. Shadow files nothing: without either it only goes without
  // candidates, which its poll's notes say.
  // Quiet writes the board as live does, so it is refused on the same terms.
  if (writesJira(rules.mode) && intakeOf(rules) === null) return deny(deps, cached, noIntakeBoard(rules.mode));
  if (writesJira(rules.mode) && deps.jira === null) return deny(deps, cached, noJiraCredential(rules.mode));
  try {
    // The first poll of a store starts the clerk at "now": nothing posted
    // before it is filed. Recorded before Slack is asked anything, so a first
    // poll that fails still starts from the moment the clerk was started.
    const started = await withClerkStore(deps.storePath, rules.channel, (store, problem) => {
      if (store.cursor !== "") return null;
      store.cursor = msTs(deps.now());
      return `${problem === null ? "" : `${problem}; `}starting at ${store.cursor}: nothing posted before it is filed`;
    });
    if (started !== null) return { verdict: { work: false, why: started }, cached: noCache() };

    const identity = await deps.slack.authTest();
    let polled: Polled;
    try {
      // Only a poll that got all the way through clears the failure count: an
      // apply that succeeded followed by a history read that failed is still a
      // failed poll.
      polled = await succeeded(deps, await pollChannel(deps, deps.slack, identity));
    } catch (error) {
      polled = await failedPoll(deps, cached, error);
    }
    // The report files waiting for their tickets, after the channel so a
    // batch filed this poll has its files attached by it. Quiet and live
    // only: shadow records them and attaches nothing. Never throws, and a
    // file that fails is a note and a retry later, never a stop.
    if (writesJira(rules.mode) && deps.jira !== null && polled.verdict.stop === undefined && polled.verdict.waitSeconds === undefined) {
      const notes = await attachPending({
        rules,
        storePath: deps.storePath,
        now: deps.now,
        slack: deps.slack,
        jira: deps.jira,
        scopes: identity.scopes.length === 0 ? null : identity.scopes,
      });
      if (notes.length > 0) polled.verdict.notes = [...(polled.verdict.notes ?? []), ...notes];
    }
    // What the last code-context iteration wrote (felipearos/ralph#499),
    // validated and posted whatever this poll hands over: a result never
    // waits on the report channel. Never throws, never stops a poll.
    const codeContext = codeContextIo(deps, deps.slack, identity.scopes);
    if (codeContext !== null && polled.verdict.stop === undefined && polled.verdict.waitSeconds === undefined) {
      const notes = await settleCodeContext(codeContext);
      if (notes.length > 0) polled.verdict.notes = [...(polled.verdict.notes ?? []), ...notes];
    }
    // The confirmation sweep (felipearos/ralph#449) after the channel and
    // before the canvas, so a ticket it moves is drawn where it went. Under
    // the canvas's conditions, for the canvas's reasons.
    if (polled.verdict.stop === undefined && polled.verdict.waitSeconds === undefined) polled = await sweepIntake(deps, polled);
    // The merged move before the outcome scan, so a ticket it closes is
    // recorded, and its reporter told, on this poll. It writes the board, so
    // quiet and live only; it never throws and never stops a poll.
    if (
      polled.verdict.stop === undefined &&
      polled.verdict.waitSeconds === undefined &&
      writesJira(rules.mode) &&
      deps.jira !== null &&
      deps.pulls !== undefined &&
      clerkJira(rules.jira).mergedStatus !== null &&
      (rules.prRepos ?? []).length > 0
    ) {
      const notes = await moveMerged({ rules, jira: deps.jira, storePath: deps.storePath, now: deps.now, pulls: deps.pulls });
      if (notes.length > 0) polled.verdict.notes = [...(polled.verdict.notes ?? []), ...notes];
    }
    // The outcome scan (felipearos/ralph#450) after the sweep, so a ticket it
    // just moved is watched from this poll on. Read-only, so shadow runs it
    // too; it never throws and never stops a poll. Live, it also tells the
    // reporter in their thread once the work is done.
    if (polled.verdict.stop === undefined && polled.verdict.waitSeconds === undefined && intakeOf(rules) !== null && deps.jira !== null) {
      // The thread writer only the live port holds: shadow and quiet are
      // handed none, so their scan tells no reporter anything.
      const outcomeNotes: string[] = [];
      const threads = portFor(deps, emptyShadow(), (note) => outcomeNotes.push(note)).threads;
      const notes = await scanOutcomes({
        rules,
        jira: readOnly(deps.jira),
        storePath: deps.storePath,
        now: deps.now,
        ...(deps.ledger === undefined ? {} : { ledger: deps.ledger }),
        ...(threads === undefined ? {} : { threads }),
        // The reply waits for a merged PR only where PRs are read at all.
        ...(deps.pulls === undefined || (rules.prRepos ?? []).length === 0 ? {} : { pulls: deps.pulls }),
      });
      notes.push(...outcomeNotes);
      if (notes.length > 0) polled.verdict.notes = [...(polled.verdict.notes ?? []), ...notes];
    }
    // The canvas after the channel, so a batch applied this poll is in it; and
    // after the token has answered, so a revoked one stops the loop before
    // anything is written. Never on a stop: the loop is ending, and a rebuild
    // would only add a second failure to the log.
    // Nor during a backoff: a poll that is waiting out an outage or a 429 has
    // no business spending more calls on the same service.
    if (polled.verdict.stop === undefined && polled.verdict.waitSeconds === undefined) {
      const notes = await rebuildCanvas(deps, deps.slack);
      if (notes.length > 0) polled.verdict.notes = [...(polled.verdict.notes ?? []), ...notes];
    }
    // The daily KPI DM, on the same terms as the canvas: never a reason to
    // stop or to hand nothing over, and it never throws (`clerk/kpi.ts`).
    if (deps.kpi && polled.verdict.stop === undefined && polled.verdict.waitSeconds === undefined) {
      const notes = await sendDueReport(deps.kpi, deps.slack, deps.now());
      if (notes.length > 0) polled.verdict.notes = [...(polled.verdict.notes ?? []), ...notes];
    }
    // A code-context case last, and only on a poll that hands nothing else
    // over: report intake always comes first, and every step above ran on
    // the verdict it would have had without one.
    if (codeContext !== null && !polled.verdict.work && polled.verdict.stop === undefined && polled.verdict.waitSeconds === undefined) {
      const handed = await handCodeContext(codeContext);
      const notes = [...(polled.verdict.notes ?? []), ...handed.notes];
      polled = { ...polled, verdict: { ...polled.verdict, ...(handed.why === null ? {} : { work: true, why: handed.why }), ...(notes.length === 0 ? {} : { notes }) } };
    }
    return polled;
  } catch (error) {
    return failedPoll(deps, cached, error);
  }
}

/** The code-context steps' view of a poll; null with the feature off. */
function codeContextIo(deps: PollDeps, slack: SlackClient, scopes: readonly string[]): CodeContextIo | null {
  if (deps.rules.codeContext == null || deps.codeContext == null) return null;
  return {
    rules: deps.rules,
    storePath: deps.storePath,
    now: deps.now,
    deps: deps.codeContext,
    slack,
    jira: deps.jira,
    scopes: scopes.length === 0 ? null : scopes,
  };
}

/**
 * Act on the intake tickets a person confirmed or rejected (`clerk/confirm.ts`).
 * Its notes ride on the poll's verdict, and it never takes away a hand-over:
 * a live denial stops the loop only on a poll that has nothing to hand over,
 * and a poll that does hands it over and meets the denial again on the next.
 * Shadow is handed a read-only view of Jira, and without a credential it has
 * nothing to read, so it sweeps nothing.
 */
async function sweepIntake(deps: PollDeps, polled: Polled): Promise<Polled> {
  if (intakeOf(deps.rules) === null || deps.jira === null) return polled;
  let result: SweepResult;
  try {
    result = await sweep({
      rules: deps.rules,
      board: sweepBoard(deps.rules, deps.jira),
      storePath: deps.storePath,
      now: deps.now,
      ...(deps.ledger === undefined ? {} : { ledger: deps.ledger }),
    });
  } catch (error) {
    // `sweep` answers its own failures; this is the store, or a defect.
    result = { notes: [`the confirmation sweep failed: ${error instanceof Error ? error.message : String(error)}; tried again at the next poll`], denial: null };
  }
  const notes = [...(polled.verdict.notes ?? []), ...result.notes];
  if (result.denial !== null && writesJira(deps.rules.mode) && !polled.verdict.work) {
    const denied = deny(deps, polled.cached, result.denial);
    return { ...denied, verdict: { ...denied.verdict, notes } };
  }
  return notes.length === 0 ? polled : { ...polled, verdict: { ...polled.verdict, notes } };
}

/**
 * The sweep's view of the board by mode, chosen here and nowhere else: shadow
 * a read-only one, quiet and live the writer, with the OA move held when
 * `clerk.holdOaMove` says so (by default in quiet, not in live).
 */
function sweepBoard(rules: ClerkRules, jira: JiraClient): SweepBoard {
  if (rules.mode === "shadow") return { mode: "shadow", jira: readOnly(jira) };
  return { mode: rules.mode, jira, holdOaMove: holdsOaMove(rules) };
}

/**
 * A poll that failed: counted towards the alert unless it is a denial, which
 * stops the loop and says so itself, then answered as `caught` answers it.
 */
async function failedPoll(deps: PollDeps, cached: Cached, error: unknown): Promise<Polled> {
  if (!((error instanceof SlackError || error instanceof JiraError) && error.failure.kind === "denied")) {
    await countFailure(deps, (error as Error).message);
  }
  return caught(deps, cached, error);
}

function caught(deps: PollDeps, cached: Cached, error: unknown): Polled {
  if (error instanceof SlackError || error instanceof JiraError) return failed(deps, cached, error.failure);
  // A defect of the gate's own, not of Slack's: still nothing to do this
  // poll, with the reason, and a backoff — never a spawn on a read that did
  // not complete, and never an exit the supervisor would retry and stop on.
  return failed(deps, cached, { kind: "transient", why: `the poll failed: ${(error as Error).message}` });
}

/**
 * The channel's half of a poll, once the token has answered: settle the
 * pending batch, then hand over the next. What the apply had to say on the
 * way — a ticket not moved to its status, points Jira refused, a ledger line
 * lost — rides on whichever verdict the poll ends with.
 */
async function pollChannel(deps: PollDeps, slack: SlackClient, identity: AuthIdentity): Promise<Verdict> {
  const notes: string[] = [];
  const verdict = await readChannel(deps, slack, identity, notes);
  const all = [...notes, ...(verdict.notes ?? [])];
  return all.length === 0 ? verdict : { ...verdict, notes: all };
}

async function readChannel(deps: PollDeps, slack: SlackClient, identity: AuthIdentity, notes: string[]): Promise<Verdict> {
  const { rules } = deps;
  // The batch an iteration was handed is settled before the channel is read
  // again: applied if its plan is valid, handed back once if not, filed
  // unclassified if it was refused twice.
  const pending = await resolvePending(deps, notes);
  if (pending !== null) return pending;

  const me: Me = { userId: identity.userId, botId: identity.botId };
  const { cursor } = await withClerkStore(deps.storePath, rules.channel, (store) => ({ cursor: store.cursor }));
  // One read serves both halves of the poll: the messages after the cursor
  // are where new reports come from, and everything in the watch window is
  // where the threads of reports already done with live (felipearos/ralph#321).
  const watchFrom = msTs(deps.now() - WATCH_DAYS * 86_400_000);
  const history = await slack.history(rules.channel, compareTs(watchFrom, cursor) < 0 ? watchFrom : cursor);
  const topLevel = history.filter((message) => compareTs(message.ts, cursor) > 0);
  // A report a person confirmed for the team moved to the OA board
  // (`clerk/confirm.ts`), and its thread's replies follow it there: the OA
  // key the sweep recorded, never a shadow one or a move quiet held back,
  // which no board holds.
  const movedTo = writesJira(rules.mode)
    ? (key: string): Promise<string | null> =>
        withClerkStore(deps.storePath, rules.channel, (store) => {
          const oaKey = store.confirmed?.[key]?.oaKey;
          return oaKey === undefined || isPlaceholderKey(oaKey) ? null : oaKey;
        })
    : undefined;
  // Replies on filed reports become comments on their tickets, and an
  // ignored report somebody asked to have filed is re-opened — both through
  // the mode's port, so shadow records them and writes nothing, and quiet
  // writes the comments to Jira. The watch reads threads and writes none.
  await watchThreads(
    {
      rules,
      slack: slackReader(slack),
      port: portFor(deps, await shadowRecord(deps), (note) => notes.push(note)),
      storePath: deps.storePath,
      me,
      workspaceUrl: identity.url,
      now: deps.now,
      movedTo,
    },
    history,
  );
  await retryFollowUps(deps, identity.url, notes);
  const { processed, reopened } = await withClerkStore(deps.storePath, rules.channel, (store) => ({
    processed: new Set(Object.keys(store.processed)),
    reopened: store.reopened ?? {},
  }));
  const ignore = new Set(rules.ignoreUsers ?? []);
  const group = (threads: ReadonlyMap<string, SlackMessage[]>, messages: readonly SlackMessage[] = topLevel, joinMinutes = rules.joinMinutes) =>
    groupReports({ topLevel: messages, threads, me, channel: rules.channel, workspaceUrl: identity.url, joinMinutes, ignore });
  const now = deps.now();
  // Reports are handed over in the order they were written, oldest first,
  // and never past one still being written: a newer report filed before an
  // older one would put the team's backlog out of order, and in a backfill
  // (`cursor.ts --since`) would file the weeks out of sequence. So the walk
  // stops at the first unsettled report, which the next polls wait on.
  //
  // Threads are read only for reports nobody has processed, oldest first,
  // and only until `batchSize` of them are settled: no more can be handed
  // over this poll. Grouping needs no thread, so the reports are known
  // before any is read. Reading every thread after the cursor instead would
  // grow with the backlog — a cursor moved weeks back (`cursor.ts --since`)
  // or held behind one unsettled report — until a poll could no longer
  // finish inside Slack's rate limit, and since a 429 drops the poll's reads,
  // the next poll would hit it at the same place and the clerk would stop
  // making progress at all. Bounded, every poll reads at most a batch's
  // threads, and the backlog drains one batch per poll.
  const threads = new Map<string, SlackMessage[]>();
  const byTs = new Map(topLevel.map((message) => [message.ts, message]));
  const examined = new Set<string>();
  let settledSeen = 0;
  for (const report of group(threads)) {
    if (settledSeen >= rules.batchSize) break;
    if (processed.has(report.id) || Object.hasOwn(reopened, report.id)) continue;
    const roots = report.roots.map((root) => byTs.get(root)!);
    for (const root of roots) {
      if ((root.reply_count ?? 0) > 0) threads.set(root.ts, await slack.replies(rules.channel, root.ts));
    }
    examined.add(report.id);
    // The report alone, its threads read: whether it has settled counts its replies.
    const whole = group(threads, roots, Number.MAX_SAFE_INTEGER)[0];
    if (whole === undefined || !settled(whole, now, rules.settleMinutes)) break;
    settledSeen += 1;
  }
  const reports = group(threads);

  const { ready: settledReady, waiting } = await withClerkStore(deps.storePath, rules.channel, (store) => {
    const done = (id: string): boolean => Object.hasOwn(store.processed, id);
    store.cursor = advanceCursor(store.cursor, topLevel, reports, done);
    prune(store, now);
    const unfiled = reports.filter((report) => !done(report.id) && !Object.hasOwn(reopened, report.id));
    // Only a report the walk above reached can be handed over: one past the
    // bound looks quiet only because its replies were not asked for, and one
    // past an unsettled report would be filed before an older one.
    return { waiting: unfiled.length, ready: unfiled.filter((report) => examined.has(report.id) && settled(report, now, rules.settleMinutes)) };
  });
  // A re-opened report goes first, and without waiting to settle: a person
  // has just said it should have been filed, which is the answer settling
  // waits for.
  const again = await reopenedReports(deps, history, reopened, me, identity.url);
  const ready = [...again, ...settledReady];
  if (ready.length === 0) {
    return {
      work: false,
      why:
        waiting === 0
          ? `no unfiled report in ${rules.channel}`
          : `${waiting} report${waiting === 1 ? "" : "s"} in ${rules.channel} still being written (settled after ${rules.settleMinutes}m quiet)`,
    };
  }
  // Everything the session needs is gathered here, by code, before it
  // starts: who wrote what, and which tickets each report might already be.
  // Live, a Jira failure here hands nothing over — a batch without its
  // candidates invites the duplicates they exist to prevent. Shadow writes
  // nothing real, so a shadow clerk with no board or no credential (live
  // without either was denied above), or one Jira will not answer, hands its
  // batch over with no candidates instead of stalling all night, and says so
  // in the poll's notes: "no duplicates" and "never looked" must not read the
  // same.
  const handed = ready.slice(0, rules.batchSize);
  let candidates = new Map<string, Candidate[]>();
  if (intakeOf(rules) === null) {
    notes.push("no 'clerk.jira.intakeProject': this shadow batch is offered no duplicate candidates");
  } else {
    if (deps.jira === null) {
      // Live without a credential was denied above.
      notes.push(`no ${JIRA_TOKEN_ENV}: this batch is offered no duplicate candidates`);
    } else if (writesJira(rules.mode)) {
      // Quiet files real tickets, so it guards against duplicates as live does.
      candidates = await gatherIntakeCandidates(deps.jira, rules, handed, deps.now());
    } else {
      try {
        candidates = await gatherIntakeCandidates(deps.jira, rules, handed, deps.now());
      } catch (error) {
        notes.push(`the Jira intake board could not be read for duplicate candidates (${error instanceof Error ? error.message : String(error)}): this batch is offered none`);
      }
    }
  }
  const names = await userNames(slack, handed);
  const batchReports: BatchReport[] = handed.map((report) => ({
    ...report,
    authorName: names[report.author] ?? report.author,
    names: Object.fromEntries(report.messages.map((message) => [message.user, names[message.user] ?? message.user])),
    candidates: candidates.get(report.id) ?? [],
    ...(Object.hasOwn(reopened, report.id) ? { hint: names[reopened[report.id]!.by] ?? reopened[report.id]!.by } : {}),
  }));
  // Before the batch is stored, so the session that starts on it finds its
  // files there; a file that could not be fetched is a note, never a hold.
  if (deps.filesRoot !== undefined) notes.push(...(await fetchReadable(slack, deps.filesRoot, batchId(batchReports), batchReports)));
  const verdict = await withClerkStore(deps.storePath, rules.channel, (store): Verdict => {
    const id = batchId(batchReports);
    store.batch = { id, handedAt: new Date(now).toISOString(), attempt: 1, reports: batchReports, mac: batchMac({ id, reports: batchReports }, deps.secret) };
    // The candidates' notes are in `notes`, which `pollChannel` puts on this verdict.
    return { work: true, why: caseText(store.batch, rules.channel) };
  });
  return verdict;
}

/** Each author's and replier's name, asked once per user; a name Slack will not give is the user id. */
async function userNames(slack: SlackClient, reports: readonly Report[]): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  for (const user of new Set(reports.flatMap((report) => report.messages.map((message) => message.user)))) {
    try {
      names[user] = await slack.userName(user);
    } catch {
      // A name is a courtesy in a ticket's description, never a reason to
      // hold a batch back: the id still says who it was.
      names[user] = user;
    }
  }
  return names;
}

/**
 * How many failed polls in a row raise an alert: three, as the spec decides.
 * One is a blip the backoff absorbs; a clerk that has failed three times
 * running — Slack or Jira down, every write rate limited — is one an operator
 * should hear about before morning, whatever it was doing when it failed.
 */
export const FAILURES_BEFORE_ALERT = 3;

/**
 * Count one failed poll in the store, so a restarted gate keeps the count, and
 * raise the alert on the third in a row. Best-effort throughout: a count or an
 * alert that cannot be written must never replace the failure being reported.
 */
async function countFailure(deps: PollDeps, why: string): Promise<void> {
  try {
    const failure = await withClerkStore(deps.storePath, deps.rules.channel, (store) => {
      store.failures = (store.failures ?? 0) + 1;
      return { count: store.failures, batch: store.batch?.id ?? null };
    });
    if (failure.count === FAILURES_BEFORE_ALERT) {
      deps.alert({
        occurrence: `clerk-failing:${failure.batch ?? "poll"}`,
        subject: `The clerk failed ${FAILURES_BEFORE_ALERT} polls in a row`,
        body: `${why}${failure.batch === null ? "" : `. ${failure.batch} is kept and retried on every poll`}.`,
      });
    }
  } catch {}
}

/** A poll that got all the way through: its verdict, with the failure count cleared. */
async function succeeded(deps: PollDeps, verdict: Verdict): Promise<Polled> {
  try {
    await withClerkStore(deps.storePath, deps.rules.channel, (store) => {
      if (store.failures !== undefined && store.failures !== 0) store.failures = 0;
    });
  } catch {}
  return { verdict, cached: noCache() };
}

/**
 * How many hand-overs in a row may end with no plan at all before the batch
 * counts as refused. A session that never ran — a pause or a stop between the
 * hand-over and the turn, a supervisor restart, a runner outage, a session
 * that ended `RETRY_LATER` — has not refused anything, and burning the one
 * retry on it would file real reports unclassified overnight. Bounded, so a
 * batch nobody ever plans for still ends.
 */
export const MISSES_BEFORE_REFUSAL = 3;

/** A batch's MAC: an HMAC-SHA256 of its id and reports, keyed with a credential the session never holds. */
export const batchMac = (batch: Pick<Batch, "id" | "reports">, secret: string): string =>
  createHmac("sha256", secret).update(JSON.stringify({ id: batch.id, reports: batch.reports })).digest("hex");

/**
 * Settle the batch the last iteration was handed, if there is one. Returns the
 * poll's verdict when the batch was handed back, and null once it is applied
 * and the poll may read the channel.
 *
 * The plan is validated against the batch as it was handed, and only the
 * reports not yet processed are applied: a poll that failed halfway resumes at
 * the report it failed on. The journal entry is written from every report in
 * the batch, whichever poll finished it, and only then is the batch cleared.
 */
async function resolvePending(deps: PollDeps, pollNotes: string[]): Promise<Verdict | null> {
  const { rules } = deps;
  const batch = await withClerkStore(deps.storePath, rules.channel, (store) => store.batch);
  if (batch === null) return null;
  const finished = await withClerkStore(deps.storePath, rules.channel, (store) =>
    batch.reports.every((report) => Object.hasOwn(store.processed, report.id)),
  );
  let decisions: Decision[] = [];
  let notes: string[] = [];
  let fallback = false;
  if (!finished) {
    const intact = batch.mac === batchMac(batch, deps.secret);
    const raw = intact ? deps.readPlan(batch.id) : null;
    if (intact && raw === undefined && (batch.misses ?? 0) < MISSES_BEFORE_REFUSAL - 1) {
      return withClerkStore(deps.storePath, rules.channel, (store): Verdict => {
        store.batch = { ...batch, misses: (batch.misses ?? 0) + 1, handedAt: new Date(deps.now()).toISOString() };
        return { work: true, why: `${caseText(store.batch, rules.channel)} — no plan was written; handed over again` };
      });
    }
    const validated = intact ? validatePlan(raw ?? "no plan was written", batch.id, batch.reports, { pwaAgents: rules.pwaAgents === true, apps: rules.appLabels }) : null;
    if (validated !== null && !validated.ok && batch.attempt < 2) {
      // One more session, told what was wrong. The reports wait where they
      // are: the cursor cannot pass them until they are processed.
      return withClerkStore(deps.storePath, rules.channel, (store): Verdict => {
        store.batch = { ...batch, attempt: batch.attempt + 1, misses: 0, problems: validated.problems, handedAt: new Date(deps.now()).toISOString() };
        return { work: true, why: `${caseText(store.batch, rules.channel)} — the last plan was refused: ${validated.problems.length} problem(s)` };
      });
    }
    if (validated === null) {
      // The batch was changed on disk after it was handed over: its
      // candidates — what a report may be merged into — can no longer be
      // trusted, and neither can a plan written against them. Every report is
      // filed for a person to sort, and somebody is told.
      try {
        deps.alert({
          occurrence: `clerk-tampered:${batch.id}`,
          subject: "The clerk's handed batch was changed on disk",
          body: `${batch.id} no longer matches what the gate handed over; its reports are filed unclassified.`,
        });
      } catch {}
    }
    fallback = validated === null || !validated.ok;
    decisions = validated !== null && validated.ok ? validated.decisions : unclassified(batch.reports);
    notes =
      validated === null
        ? ["the batch was changed after it was handed over"]
        : validated.ok
          ? validated.notes
          : validated.problems.map((problem) => `refused twice: ${problem}`);
    await applyBatch(deps, batch, decisions, pollNotes);
  }
  const lines = await withClerkStore(deps.storePath, rules.channel, (store) =>
    batch.reports.map((report) => store.processed[report.id]?.line ?? `${report.permalink} — processed`),
  );
  deps.journal(
    batch.id,
    journalEntry({ batch: batch.id, mode: rules.mode, attempt: batch.attempt, fallback, lines, notes, at: new Date(deps.now()).toISOString() }),
  );
  await withClerkStore(deps.storePath, rules.channel, (store) => {
    if (store.batch?.id === batch.id) store.batch = null;
  });
  return null;
}

/**
 * The mode's write port, and the only place one is chosen. The shadow port
 * holds no client, so nothing in shadow can reach Slack or Jira whatever a
 * plan or a thread says, and the live port is built only when the project's
 * reviewed config says `live`: `intakePort`, which files on the Jira intake
 * board (felipearos/ralph#447). Quiet's (felipearos/ralph#443) is handed the
 * Jira client alone, so its thread replies have no Slack to reach. `poll`
 * denies a live or quiet clerk without a board or a credential before
 * anything reaches here.
 */
function portFor(deps: PollDeps, shadow: ShadowRecord, note: (line: string) => void = () => {}): WritePort {
  const { rules } = deps;
  const board = intakeOf(rules) !== null;
  if (rules.mode === "live" && board && deps.slack !== null && deps.jira !== null) return intakePort(deps.jira, deps.slack, rules, note);
  if (rules.mode === "quiet" && board && deps.jira !== null) return quietPort(deps.jira, rules, note);
  return shadowPort(shadow, deps.now, (record) =>
    withClerkStore(deps.storePath, rules.channel, (store) => {
      store.shadow = record;
    }),
  );
}

/** The shadow record as the store holds it now. */
const shadowRecord = (deps: PollDeps): Promise<ShadowRecord> =>
  withClerkStore(deps.storePath, deps.rules.channel, (store) => structuredClone(store.shadow));

/**
 * The reports a person asked to have filed, rebuilt from the channel: their
 * roots from `history` and their threads read whole, so the session sees the
 * report and the reply that asked for it. One that cannot be rebuilt — its
 * roots deleted, or out of the read — goes back to being ignored, with the
 * outcome it had, rather than waiting in `reopened` for ever.
 */
async function reopenedReports(
  deps: PollDeps,
  history: readonly SlackMessage[],
  reopened: Readonly<Record<string, Reopened>>,
  me: Me,
  workspaceUrl: string,
): Promise<Report[]> {
  const out: Report[] = [];
  for (const [id, entry] of Object.entries(reopened)) {
    const roots = history.filter((message) => entry.roots.includes(message.ts));
    const threads = new Map<string, SlackMessage[]>();
    for (const root of roots) if ((root.reply_count ?? 0) > 0) threads.set(root.ts, await deps.slack!.replies(deps.rules.channel, root.ts));
    const rebuilt = groupReports({
      topLevel: roots,
      threads,
      me,
      channel: deps.rules.channel,
      workspaceUrl,
      joinMinutes: Number.MAX_SAFE_INTEGER,
      ignore: new Set(deps.rules.ignoreUsers ?? []),
    }).find(
      (report) => report.id === id,
    );
    if (rebuilt !== undefined) {
      out.push(rebuilt);
      continue;
    }
    await withClerkStore(deps.storePath, deps.rules.channel, (store) => {
      if (store.reopened !== undefined) delete store.reopened[id];
      if (entry.outcome !== undefined) store.processed[id] = entry.outcome;
    });
  }
  return out;
}

/**
 * Post again the grouping replies an apply could not ("Agregado al reporte de
 * arriba"), live only: the port of shadow and quiet carries no `threads`, so
 * there is nothing to retry there. Each one posted is dropped from the store
 * at once; one that fails again is a note and waits for the next poll. A
 * report past the thread watch is given up on, with a note, rather than
 * retried for ever.
 */
async function retryFollowUps(deps: PollDeps, workspaceUrl: string, notes: string[]): Promise<void> {
  const { rules } = deps;
  if (rules.mode !== "live") return;
  const pending = await withClerkStore(deps.storePath, rules.channel, (store) =>
    Object.entries(store.processed)
      .filter(([, outcome]) => (outcome.pendingFollowUps ?? []).length > 0)
      .map(([id, outcome]) => ({ id, roots: outcome.pendingFollowUps! })),
  );
  if (pending.length === 0) return;
  const threads = portFor(deps, emptyShadow(), (note) => notes.push(note)).threads;
  if (threads === undefined) return;
  const drop = (id: string, root: string | null): Promise<void> =>
    withClerkStore(deps.storePath, rules.channel, (store) => {
      const outcome = store.processed[id];
      if (outcome === undefined) return;
      const left = root === null ? [] : (outcome.pendingFollowUps ?? []).filter((one) => one !== root);
      if (left.length === 0) delete outcome.pendingFollowUps;
      else outcome.pendingFollowUps = left;
    });
  for (const report of pending) {
    if (deps.now() - Number(report.id) * 1000 > WATCH_DAYS * 86_400_000) {
      notes.push(`${permalink(workspaceUrl, rules.channel, report.id)}: gave up on the grouping replies of ${report.roots.length} follow-up message(s) after ${WATCH_DAYS} days`);
      await drop(report.id, null);
      continue;
    }
    await postFollowUps(threads, permalink(workspaceUrl, rules.channel, report.id), report.roots, (note) => notes.push(note), (root) => drop(report.id, root));
  }
}

/**
 * Apply `decisions` through the mode's write port, saving each step and each
 * finished report as it goes.
 */
async function applyBatch(deps: PollDeps, batch: Batch, decisions: readonly Decision[], notes: string[] = []): Promise<Applied[]> {
  const { rules } = deps;
  const snapshot = await withClerkStore(deps.storePath, rules.channel, (store) => ({
    processed: new Map(Object.entries(store.processed).map(([id, entry]) => [id, entry.key ?? null])),
    progress: structuredClone(store.progress),
    shadow: structuredClone(store.shadow),
  }));
  const port = portFor(deps, snapshot.shadow, (note) => notes.push(note));
  const decisionOf = new Map(decisions.map((decision) => [decision.report, decision]));
  let lost = 0;
  const save = (change: (store: ClerkStore) => void): Promise<void> =>
    withClerkStore(deps.storePath, rules.channel, (store) => {
      // The shadow record lives in memory while the port writes to it, and
      // goes to disk with every step, so what was recorded is never older than
      // the progress that says it was.
      store.shadow = snapshot.shadow;
      change(store);
    });
  const applied = await applyDecisions(
    // Every decision, the finished ones included: they are skipped, and a
    // later report that duplicates one still finds the ticket it became.
    decisions,
    batch.reports,
    {
      rules,
      port,
      now: deps.now,
      finished: (report) => (snapshot.processed.has(report) ? { key: snapshot.processed.get(report) ?? null } : undefined),
      progress: (report) => snapshot.progress[report] ?? {},
      saveProgress: (report, progress) => {
        snapshot.progress[report] = progress;
        return save((store) => {
          store.progress[report] = progress;
        });
      },
      note: (line) => notes.push(line),
      done: async (applied) => {
        const report = batch.reports.find((one) => one.id === applied.report);
        const at = new Date(deps.now()).toISOString();
        await save((store) => {
          markProcessed(store, applied.report, {
            state: applied.outcome === "ignore" ? "ignored" : applied.outcome === "comment" ? "commented" : "filed",
            key: applied.key,
            at,
            line: applied.line,
            ...(applied.pendingFollowUps === undefined ? {} : { pendingFollowUps: applied.pendingFollowUps }),
            // Its threads are watched from here on (felipearos/ralph#321, #323).
            // A filed report's from its first root, not its last activity: a
            // reply of `clerk.ignoreUsers` is left out of the report, so one
            // written before it was filed — the team's "¿no te llegó
            // ninguna?" between the reporter's lines — is in no ticket and is
            // copied like a later one. The report's own replies are in what
            // was filed, and are skipped. An ignored report is watched only
            // for a mention asking to file it, so from what it last saw.
            ...(report === undefined
              ? {}
              : applied.outcome === "ignore"
                ? { roots: report.roots, copiedThrough: report.lastActivity }
                : {
                    roots: report.roots,
                    copiedThrough: report.id,
                    inTicket: report.messages.filter((message) => message.reply).map((message) => message.ts),
                  }),
          });
          // The report's files, onto the ticket it was filed as or folded
          // into, in the same write: a rerun finds them queued, never twice.
          // A split report's other tickets get them too: each problem's
          // evidence may be anywhere in the report's files.
          if (applied.key !== null && applied.outcome !== "ignore" && report !== undefined) {
            for (const key of [applied.key, ...(applied.parts ?? []).map((part) => part.key)]) {
              queueAttachments(store, key, reportAttachments(report), { mode: port.mode, maxBytes: maxBytesOf(rules), report: report.id, at });
            }
          }
          // A ticket filed for an app whose code the clerk can read gets a
          // code-context case (felipearos/ralph#499), in the same write: a
          // rerun finds it queued. Only a filed ticket: a duplicate's comment
          // goes on a ticket that has, or never needed, its own.
          if (applied.key !== null && applied.issue !== undefined && report !== undefined) {
            queueCodeContext(store, rules.codeContext, { key: applied.key, report: report.id, issue: applied.issue, files: reportAttachments(report), at });
          }
          // What a confirmation is compared against (felipearos/ralph#447),
          // in the same write that marks the report done, so neither is kept
          // without the other.
          const filed = [
            ...(applied.key !== null && applied.issue !== undefined ? [{ key: applied.key, issue: applied.issue }] : []),
            ...(applied.parts ?? []),
          ];
          for (const { key, issue } of filed) {
            recordDetermination(store, key, {
              type: issue.type,
              priority: issue.priority,
              app: issue.app,
              assignee: issue.assignee,
              difficulty: issue.difficulty,
              storyPoints: issue.storyPoints,
              filedAt: at,
              // What the confirmer's edits are told from (felipearos/ralph#449):
              // the description as Jira will read it back, not as it was sent.
              summary: issue.summary,
              description: adfText(toAdf(issueBody(issue))).trim(),
              permalink: issue.permalink,
            });
          }
        });
        // After the report is marked done, so a rerun never records it twice:
        // a kill in between costs its lines, which the ledger can spare.
        if (report !== undefined) lost += recordApplied(deps, report, applied, decisionOf.get(applied.report), at);
      },
    },
  );
  if (lost > 0) notes.push(`the intake metrics ledger could not be written: ${lost} event${lost === 1 ? "" : "s"} lost`);
  return applied;
}

/**
 * The ledger lines of one applied report (felipearos/ralph#447): `reported`,
 * then what the clerk made of it — `classified` for a ticket filed, `ignored`
 * or `duplicate` — marked with the mode, shadow included. How many were lost;
 * a ledger that cannot be written never fails the apply.
 */
function recordApplied(deps: PollDeps, report: BatchReport, applied: Applied, decision: Decision | undefined, at: string): number {
  if (deps.ledger === undefined) return 0;
  const mode = deps.rules.mode;
  const key = applied.key ?? undefined;
  const base = { v: 1 as const, at, report: report.id, mode, ...(key === undefined ? {} : { key }) };
  const first = report.messages[0]?.ts ?? report.id;
  const events: MetricsEvent[] = [
    {
      ...base,
      kind: "reported",
      reporter: report.author,
      ...(report.authorName !== report.author ? { reporterName: report.authorName } : {}),
      channel: deps.rules.channel,
      reportedAt: new Date(msOf(first)).toISOString(),
    },
  ];
  if (applied.outcome === "ignore") {
    events.push({ ...base, kind: "ignored", reason: decision?.verdict === "ignore" ? decision.reason : applied.line });
  } else if (applied.outcome === "comment") {
    events.push({ ...base, kind: "duplicate", of: applied.key ?? "" });
  } else if (applied.issue !== undefined) {
    const { issue } = applied;
    events.push({
      ...base,
      kind: "classified",
      verdict: decision?.verdict ?? "issue",
      type: issue.type,
      app: issue.app,
      priority: issue.priority,
      assigneeKind: issue.assignee,
      difficulty: issue.difficulty,
      ...(issue.storyPoints === null ? {} : { storyPoints: issue.storyPoints }),
      summary: issue.summary,
      // The session's words, whole: the corpus an override of the
      // description is compared against later (felipearos/ralph#443).
      description: decision !== undefined && decision.verdict !== "ignore" ? decision.description : issue.description,
    });
  }
  let lost = 0;
  for (const event of events) {
    let written = false;
    try {
      written = deps.ledger(event);
    } catch {}
    if (!written) lost += 1;
  }
  return lost;
}

/** A Slack ts as epoch milliseconds; an unreadable one as now's, rather than an invalid date. */
const msOf = (ts: string): number => {
  const ms = Number(ts) * 1000;
  return Number.isFinite(ms) ? Math.round(ms) : Date.now();
};

/** How long a processed report is remembered once the cursor has passed it. */
export const PROCESSED_KEEP_DAYS = 90;

/**
 * Forget processed reports the cursor passed long ago. Past the cursor they are
 * never read again; within the window they are kept, because a report filed
 * today may still be answered in its thread next week.
 */
function prune(store: ClerkStore, nowMs: number): void {
  const old = (at: string): boolean => nowMs - Date.parse(at) > PROCESSED_KEEP_DAYS * 86_400_000;
  for (const [id, outcome] of Object.entries(store.processed)) {
    if (compareTs(id, store.cursor) <= 0 && old(outcome.at)) delete store.processed[id];
  }
  // The shadow record on the same clock: the whole store is rewritten on
  // every step of an apply, and a shadow run left on for months must not
  // make each of those writes slower than the last.
  for (const [key, ticket] of Object.entries(store.shadow.tickets)) {
    if (old(ticket.createdAt)) delete store.shadow.tickets[key];
  }
  store.shadow.writes = store.shadow.writes.filter((entry) => !old(entry.at));
  // What the clerk determined, on the same clock: a ticket nobody confirmed
  // in 90 days is compared against nothing.
  for (const [key, determination] of Object.entries(store.determinations ?? {})) {
    if (old(determination.filedAt)) delete store.determinations![key];
  }
  pruneAttachments(store, nowMs);
  pruneCodeContext(store, nowMs);
}

/** The title of a canvas the gate creates: says what it is, and that it is not the team's. */
export const SHADOW_CANVAS_TITLE = "Clerk: reportes en modo shadow (prueba)";

/**
 * Rebuild the canvas when `canvasMinutes` have passed since the last rebuild —
 * code only, no model turn — replacing it whole. Returns the lines the
 * supervisor log keeps; never throws, because a table that could not be
 * redrawn must never keep a report from being handed over or a plan from
 * being applied.
 *
 * In shadow the rows are the would-be tickets the shadow apply recorded and
 * the canvas is `shadowCanvas`, the operator's private test canvas — never
 * `canvas`, the channel's. One that is gone, or none configured, is created,
 * and its id stored, so later rebuilds write it, and logged, so the operator
 * can open it and put it in the config.
 *
 * The first rebuild of a store is at its first poll that reaches Slack, not
 * an interval later: a canvas id that is wrong shows up minutes after a start,
 * not a quarter of an hour.
 */
export async function rebuildCanvas(deps: PollDeps, slack: SlackClient): Promise<string[]> {
  const { rules } = deps;
  // Live rows come from the intake board (felipearos/ralph#448), and the live
  // canvas is the channel's (felipearos/ralph#322). Shadow never reaches that
  // branch, so it never writes `clerk.canvas`. Live without a Jira token is
  // denied before the poll gets here.
  if (rules.mode === "live") return deps.jira === null ? [] : rebuildLiveCanvas(deps, slack, deps.jira);
  // Quiet draws the real board on the operator's canvas, through a writer
  // that can reach no other (felipearos/ralph#443).
  if (rules.mode === "quiet") return deps.jira === null ? [] : rebuildQuietCanvas(deps, privateCanvas(slack, rules), deps.jira);
  try {
    const nowMs = deps.now();
    const due = await withClerkStore(deps.storePath, rules.channel, (store) => {
      const last = store.canvas.rebuiltAt === null ? NaN : Date.parse(store.canvas.rebuiltAt);
      if (Number.isFinite(last) && nowMs - last < rules.canvasMinutes * 60_000) return null;
      // A canvas created in place of the configured one is used for as long as
      // the config still names that one; a new configured id wins at once.
      const created = store.canvas.id !== null && store.canvas.configured === rules.shadowCanvas ? store.canvas.id : null;
      return { target: created ?? rules.shadowCanvas, rows: shadowRows(store.shadow), shadow: store.shadow };
    });
    if (due === null) return [];
    const markdown = renderCanvas({ rows: due.rows, nowMs, rowCap: rules.rowCap, source: { kind: "shadow" }, dashboardUrl: rules.dashboardUrl ?? null, apps: rules.appLabels });
    // The page with every ticket (felipearos/ralph#459), before Slack is asked
    // anything: a canvas write that fails must not keep it from what was read.
    const intake = recordIntakeSnapshot(intakeSnapshotPath(deps.storePath), {
      source: "shadow",
      mode: "shadow",
      canvasRowCap: rules.rowCap,
      title: rules.title ?? "",
      links: intakeLinks(rules),
      nowMs,
      tickets: shadowTickets(due.shadow, shownKeys(markdown), rules.appLabels),
    });
    const noted = (lines: string[]): string[] => (intake === null ? lines : [intake, ...lines]);
    // The validator refuses a config whose two canvases are one; this holds
    // even for a store that says otherwise.
    if (due.target !== null && due.target === rules.canvas) {
      return noted([`shadow canvas not rebuilt — ${due.target} is the channel's canvas ('clerk.canvas'), which shadow never writes`]);
    }
    let id = due.target;
    let gone: string | null = null;
    if (id !== null && (await slack.replaceCanvas(id, markdown)) === "gone") gone = id;
    const shared: string[] = [];
    if (id === null || gone !== null) {
      id = await slack.createCanvas(SHADOW_CANVAS_TITLE, markdown);
      // A canvas the bot creates is the bot's alone: nobody else can open it
      // until it is shared. With `clerk.operator` set, the operator can.
      if (rules.operator !== null) {
        try {
          await slack.shareCanvas(id, rules.operator);
          shared.push(`shared with ${rules.operator}`);
        } catch (error) {
          shared.push(`not shared with ${rules.operator}: ${error instanceof SlackError ? error.failure.why : (error as Error).message}`);
        }
      } else {
        shared.push("owned by the bot alone; set 'clerk.operator' to have the clerk share what it creates");
      }
    }
    const at = new Date(nowMs).toISOString();
    const created = id;
    try {
      await withClerkStore(deps.storePath, rules.channel, (store) => {
        // Writing the configured canvas itself drops any stand-in, so a later
        // switch back to an old configured id does not revive an old stand-in.
        store.canvas = created === rules.shadowCanvas ? { id: null, configured: null, rebuiltAt: at } : { id: created, configured: rules.shadowCanvas, rebuiltAt: at };
      });
    } catch (error) {
      // The canvas exists; only the record of it was lost. Its id goes to the
      // log, so the operator can configure it rather than collect orphans.
      return noted([`shadow canvas ${created} written, but the store could not record it (${(error as Error).message}); set 'clerk.shadowCanvas' to ${created}`]);
    }
    const rows = `${due.rows.length} would-be ticket${due.rows.length === 1 ? "" : "s"}`;
    if (gone !== null) {
      return noted([`shadow canvas ${gone} is gone or no longer reachable; created ${id} in its place (${rows}, ${shared.join("; ")}) — later rebuilds write ${id}; set 'clerk.shadowCanvas' to it`]);
    }
    if (due.target === null) {
      return noted([`no 'clerk.shadowCanvas' configured; created shadow canvas ${id} (${rows}, ${shared.join("; ")}) — later rebuilds write it; set 'clerk.shadowCanvas' to it`]);
    }
    return noted([`shadow canvas ${id} rebuilt (${rows})`]);
  } catch (error) {
    // Transient, a 429, even a denial: the next poll tries again. A token
    // that is really refused is caught by the gate's own calls on that poll,
    // which stop the loop with the remedy; a canvas call alone never does.
    const why = error instanceof SlackError ? error.failure.why : (error as Error).message;
    return [`shadow canvas not rebuilt — ${why}; tried again at the next poll`];
  }
}

/**
 * The most of the intake board's open, and of its closed, tickets one live
 * rebuild reads, newest first, so past the cap it is the oldest that drop out.
 * Past the open cap a section's "y N más" undercounts, and a channel with
 * that many open reports has a backlog no canvas fixes. Closed ones only
 * matter for the last week, so the closed read is the ones updated in it — a
 * superset of the ones closed in it, whatever their age — and the renderer
 * keeps those closed in the window.
 */
export const LIVE_CANVAS_OPEN = 100;
export const LIVE_CANVAS_CLOSED = 40;

/** The intake board's open `slack-intake` tickets, newest first. */
export const openIntakeJql = (project: string): string =>
  `project = ${jqlString(project)} AND labels = ${jqlString(INTAKE_LABEL)} AND statusCategory != Done ORDER BY created DESC`;

/**
 * Its closed ones touched in the last week. Asked by `updated` because a
 * workflow may close a ticket without a resolution, and a JQL on `resolved`
 * would never find that one.
 */
export const closedIntakeJql = (project: string): string =>
  `project = ${jqlString(project)} AND labels = ${jqlString(INTAKE_LABEL)} AND statusCategory = Done AND updated >= -${CLOSED_DAYS}d ORDER BY updated DESC`;

/**
 * The live canvas: the channel's own, `clerk.canvas`, rebuilt from the Jira
 * intake board every `canvasMinutes` with no model turn (felipearos/ralph#322,
 * #448). Only `slack-intake` tickets are read, in two searches — open ones,
 * and the newest closed ones, which the renderer keeps to the last seven
 * days — with their status, labels, story points and comments, and the whole
 * document is replaced. With no `clerk.jira.intakeProject` there is no board
 * to read, and the rebuild says so and waits the interval like any failure.
 *
 * A channel canvas that is gone, or none configured, is the channel's own
 * canvas if it has one (`conversations.info`), and is created as the
 * channel's canvas otherwise; either way its id is stored and logged. A
 * failed rebuild leaves the canvas as it was and waits the interval before
 * it reads Jira again.
 */
/** The last rebuild or the last failed try, whichever is later, is within the interval: nothing is due. */
function canvasDue(store: ClerkStore, rules: ClerkRules, nowMs: number): boolean {
  const tried = [store.canvas.rebuiltAt, store.canvas.triedAt ?? null].filter((at): at is string => at !== null).map((at) => Date.parse(at));
  const latest = tried.length === 0 ? NaN : Math.max(...tried);
  return !(Number.isFinite(latest) && nowMs - latest < rules.canvasMinutes * 60_000);
}

/**
 * The intake board as the canvas draws it: both reads before any write, so a
 * failed one leaves the canvas as it was, and the page with every ticket
 * (felipearos/ralph#459) recorded before Slack is asked anything. Live and
 * quiet draw the same board; only where the drawing goes differs.
 */
async function readBoardCanvas(
  deps: PollDeps,
  jira: JiraClient,
  nowMs: number,
): Promise<{ intake: string; rows: ReturnType<typeof intakeRows>; markdown: string; noted: (lines: string[]) => string[] }> {
  const { rules } = deps;
  const intake = intakeOf(rules);
  if (intake === null) throw new Error("no 'clerk.jira.intakeProject' configured, and the canvas is read from the intake board");
  const options = { storyPointsField: rules.jira.storyPointsField ?? null };
  const open = await jira.search(openIntakeJql(intake), LIVE_CANVAS_OPEN, undefined, options);
  const issues = [...open, ...(await jira.search(closedIntakeJql(intake), LIVE_CANVAS_CLOSED, undefined, options))];
  const rows = intakeRows(issues, { site: rules.jira.site, project: rules.jira.project, statuses: clerkJira(rules.jira).statuses });
  const markdown = renderIntakeCanvas({ rows, nowMs, rowCap: rules.rowCap, intakeProject: intake, site: rules.jira.site, dashboardUrl: rules.dashboardUrl ?? null, apps: rules.appLabels });
  const { trail, notes } = await readTrail(deps, jira, rows, nowMs);
  const snapshot = recordIntakeSnapshot(intakeSnapshotPath(deps.storePath), {
    source: "jira",
    mode: rules.mode === "quiet" ? "quiet" : "live",
    canvasRowCap: rules.rowCap,
    title: rules.title ?? "",
    links: intakeLinks(rules),
    nowMs,
    tickets: boardTickets(issues, rows, rules.jira.site, shownKeys(markdown), rules.appLabels, trail),
    // Fewer than the cap came back, so an open ticket not among them is closed.
    openComplete: open.length < LIVE_CANVAS_OPEN,
  });
  const extra = snapshot === null ? notes : [snapshot, ...notes];
  return { intake, rows, markdown, noted: (lines) => [...extra, ...lines] };
}

/** The most team tickets one rebuild reads the status of: one search, newest moves first. */
export const TEAM_STATUS_MAX = 100;

/** How many times one rebuild asks again after dropping a team key Jira does not have. */
const TEAM_STATUS_RETRIES = 4;

/**
 * What the page's Seguimiento column adds to the board: the OA key the sweep
 * recorded for each move, the team tickets' statuses (one search), and the
 * app repos' PRs (cached). Each is for people to read, so each failure is a
 * note and an emptier column — never a canvas left unbuilt.
 */
async function readTrail(deps: PollDeps, jira: JiraClient, rows: ReturnType<typeof intakeRows>, nowMs: number): Promise<{ trail: BoardTrail; notes: string[] }> {
  const notes: string[] = [];
  const movedKeys = new Map<string, string>();
  try {
    await withClerkStore(deps.storePath, deps.rules.channel, (store) => {
      for (const [key, record] of Object.entries(store.confirmed ?? {})) if (record.oaKey !== undefined) movedKeys.set(key, record.oaKey);
    });
  } catch (error) {
    notes.push(`intake page: the store's moves not read (${(error as Error).message}); a move no comment names shows no team ticket`);
  }
  const teamKeys = [
    ...new Set(rows.flatMap((row) => [row.teamKey, movedKeys.get(row.key) ?? null]).filter((key): key is string => key !== null && !isPlaceholderKey(key))),
  ].slice(0, TEAM_STATUS_MAX);
  const teamStatuses = new Map<string, string>();
  // Jira refuses a whole `key in (...)` naming one key it does not have (a
  // team ticket deleted since), and names that key: it is dropped and the
  // search asked again, a few times at most, never once per key.
  let wanted = teamKeys;
  for (let attempt = 0; wanted.length > 0 && attempt < TEAM_STATUS_RETRIES; attempt++) {
    try {
      for (const issue of await jira.search(`key in (${wanted.map(jqlString).join(", ")})`, wanted.length)) teamStatuses.set(issue.key, issue.status);
      break;
    } catch (error) {
      const why = error instanceof JiraError ? error.failure.why : (error as Error).message;
      const missing = /key '([^']+)' does not exist/.exec(why)?.[1];
      if (missing !== undefined && wanted.includes(missing) && attempt + 1 < TEAM_STATUS_RETRIES) {
        wanted = wanted.filter((key) => key !== missing);
        continue;
      }
      notes.push(`intake page: the team tickets' statuses not read (${why}); they show none until the next rebuild`);
      break;
    }
  }
  let pulls: BoardTrail["pulls"] = [];
  if (deps.pulls !== undefined) {
    try {
      const read = await deps.pulls(nowMs);
      pulls = read.pulls;
      if (read.note !== null) notes.push(`intake page: ${read.note}`);
    } catch (error) {
      notes.push(`intake page: pull requests not read (${(error as Error).message}); the page shows none`);
    }
  }
  return { trail: { movedKeys, teamStatuses, pulls }, notes };
}

async function rebuildLiveCanvas(deps: PollDeps, slack: SlackClient, jira: JiraClient): Promise<string[]> {
  const { rules } = deps;
  const nowMs = deps.now();
  try {
    const due = await withClerkStore(deps.storePath, rules.channel, (store) => {
      if (!canvasDue(store, rules, nowMs)) return null;
      const created = store.canvas.id !== null && store.canvas.configured === rules.canvas ? store.canvas.id : null;
      return { target: created ?? rules.canvas };
    });
    if (due === null) return [];
    const { intake, rows, markdown, noted } = await readBoardCanvas(deps, jira, nowMs);
    let id = due.target;
    let gone: string | null = null;
    let adopted = false;
    if (id !== null && (await slack.replaceCanvas(id, markdown)) === "gone") gone = id;
    if (id === null || gone !== null) {
      // The channel's own canvas, if it already has one: a channel holds at
      // most one, and writing it heals the view without a config edit.
      const own = await slack.channelCanvasOf(rules.channel);
      if (own !== null && own !== gone && (await slack.replaceCanvas(own, markdown)) === "replaced") {
        id = own;
        adopted = true;
      } else {
        id = await slack.createChannelCanvas(rules.channel, markdown);
      }
    }
    const at = new Date(nowMs).toISOString();
    const written = id;
    await withClerkStore(deps.storePath, rules.channel, (store) => {
      store.canvas =
        written === rules.canvas ? { id: null, configured: null, rebuiltAt: at, triedAt: null } : { id: written, configured: rules.canvas, rebuiltAt: at, triedAt: null };
    });
    const count = `${rows.length} ticket${rows.length === 1 ? "" : "s"}`;
    const how = adopted ? `wrote ${rules.channel}'s existing canvas ${written}` : `created ${written} as ${rules.channel}'s canvas`;
    if (gone !== null) return noted([`channel canvas ${gone} is gone or no longer reachable; ${how} (${count}) — set 'clerk.canvas' to it`]);
    if (due.target === null) return noted([`no 'clerk.canvas' configured; ${how} (${count}) — set 'clerk.canvas' to it`]);
    return noted([`channel canvas ${written} rebuilt from the intake board ${intake} (${count})`]);
  } catch (error) {
    // A Jira or Slack hiccup — a JiraError, a thrown fetch, no intake board,
    // anything — costs one rebuild, never a report, and the next try waits the
    // interval; a refused token is caught by the gate's own calls.
    try {
      await withClerkStore(deps.storePath, rules.channel, (store) => {
        store.canvas = { ...store.canvas, triedAt: new Date(nowMs).toISOString() };
      });
    } catch {}
    const why = error instanceof SlackError || error instanceof JiraError ? error.failure.why : (error as Error).message;
    return [`channel canvas not rebuilt — ${why}; tried again in ${rules.canvasMinutes}m`];
  }
}

/**
 * The one canvas a quiet clerk may write: `clerk.shadowCanvas`, a canvas of
 * the operator's, and never the channel's. Built from the rules alone and
 * holding nothing but that id's replace, so no code path in quiet can create
 * a canvas, write another or reach the channel's. Null when there is no such
 * canvas: none configured, or one the config also names as the channel's.
 */
export interface PrivateCanvas {
  id: string;
  replace(markdown: string): Promise<"replaced" | "gone">;
}

export function privateCanvas(slack: SlackClient, rules: ClerkRules): PrivateCanvas | null {
  const id = rules.shadowCanvas;
  if (id === null || id === rules.canvas) return null;
  return { id, replace: (markdown) => slack.replaceCanvas(id, markdown) };
}

/**
 * The quiet canvas (felipearos/ralph#443): the intake board drawn as live
 * draws it, every `canvasMinutes`, onto the operator's canvas. Without one,
 * or with one that is gone, nothing is written — quiet creates no canvas,
 * because a canvas the bot creates is one more thing somebody may see — and
 * the dashboard's snapshot is still recorded from the board.
 */
async function rebuildQuietCanvas(deps: PollDeps, canvas: PrivateCanvas | null, jira: JiraClient): Promise<string[]> {
  const { rules } = deps;
  const nowMs = deps.now();
  const at = new Date(nowMs).toISOString();
  try {
    const due = await withClerkStore(deps.storePath, rules.channel, (store) => canvasDue(store, rules, nowMs));
    if (!due) return [];
    const { rows, markdown, noted } = await readBoardCanvas(deps, jira, nowMs);
    const count = `${rows.length} ticket${rows.length === 1 ? "" : "s"}`;
    if (canvas === null) {
      await withClerkStore(deps.storePath, rules.channel, (store) => {
        store.canvas = { id: null, configured: null, rebuiltAt: at, triedAt: null };
      });
      return noted([`quiet: no canvas written (${count}) — 'clerk.shadowCanvas' is not set, and quiet never writes the channel's canvas or creates one; set it to a canvas of yours to see the board there`]);
    }
    if ((await canvas.replace(markdown)) === "gone") {
      await withClerkStore(deps.storePath, rules.channel, (store) => {
        store.canvas = { ...store.canvas, triedAt: at };
      });
      return noted([`quiet: shadow canvas ${canvas.id} is gone or no longer reachable, and quiet creates none; set 'clerk.shadowCanvas' to a canvas of yours`]);
    }
    await withClerkStore(deps.storePath, rules.channel, (store) => {
      store.canvas = { id: null, configured: null, rebuiltAt: at, triedAt: null };
    });
    return noted([`quiet: shadow canvas ${canvas.id} rebuilt from the intake board ${intakeOf(rules)} (${count})`]);
  } catch (error) {
    try {
      await withClerkStore(deps.storePath, rules.channel, (store) => {
        store.canvas = { ...store.canvas, triedAt: at };
      });
    } catch {}
    const why = error instanceof SlackError || error instanceof JiraError ? error.failure.why : (error as Error).message;
    return [`quiet: shadow canvas not rebuilt — ${why}; tried again in ${rules.canvasMinutes}m`];
  }
}

function failed(deps: PollDeps, cached: Cached, failure: SlackFailure | JiraFailure): Polled {

  if (failure.kind === "denied") return deny(deps, cached, { code: failure.code, why: failure.why, remedy: failure.remedy });
  if (failure.kind === "rate-limited") {
    return { verdict: { work: false, why: failure.why, waitSeconds: failure.retryAfterSeconds }, cached };
  }
  const streak = cached.transientStreak + 1;
  const wait = backoffSeconds(deps.intervalSeconds, streak);
  return {
    verdict: { work: false, why: `${failure.why} (${streak} in a row; next try in ${wait}s)`, waitSeconds: wait },
    cached: { transientStreak: streak },
  };
}

function deny(deps: PollDeps, cached: Cached, denial: Denial): Polled {
  // Each is best-effort and independent: a notification that cannot be sent
  // must not keep the stop from being written, and neither may throw out of
  // the poll.
  try {
    deps.notify(denial);
  } catch {}
  let queued = false;
  try {
    queued = deps.stop(denial);
  } catch {}
  return { verdict: { work: false, why: denial.why, stop: { why: denial.why, remedy: denial.remedy, queued } }, cached };
}

/* --------------------------------------------------------------------------
 * CLI.
 * ----------------------------------------------------------------------- */

const PREFIX = "clerk-gate";

export const verdictLine = (verdict: Verdict): string =>
  `${PREFIX}: ${verdict.work ? "work available" : "nothing to do"} — ${verdict.why}`;

/** Matched by `ralph.sh`, which goes back to its control checkpoint instead of spawning. */
export const CONTROL_PENDING_LINE = `${PREFIX}: control command waiting — handing back to the supervisor`;

/** The poll's notes, each a line of its own in the supervisor log. */
export const noteLines = (verdict: Verdict): string[] => (verdict.notes ?? []).map((note) => `${PREFIX}: ${note}`);

export const remedyLine = (stop: { why: string; remedy: string }): string => `${PREFIX}: stopping the loop — ${stop.why}; ${stop.remedy}`;

export function waitingLine(
  verdict: Verdict,
  state: { poll: number; waitingSince: Date; now: Date; waitSeconds: number },
): string {
  const idle = Math.max(0, Math.round((state.now.getTime() - state.waitingSince.getTime()) / 1000));
  const at = state.now.toISOString().replace(/\.\d+Z$/, "Z");
  return `${PREFIX}: ${verdict.why} at ${at} — waiting ${state.waitSeconds}s (poll ${state.poll}, idle ${formatDuration(idle)})`;
}

/** From the role descriptor, as every role's is: `roles.ts` says how long a role's gate waits. */
export const DEFAULT_POLL_SECONDS = roleDescriptor("clerk").pollSeconds;

export function pollSeconds(argv: string | undefined): number {
  if (argv !== undefined && /^\d+$/.test(argv) && Number(argv) >= 1) return Number(argv);
  return DEFAULT_POLL_SECONDS;
}

/** `--once`: one poll, as lines and an exit code — 0 work, 1 none, 2 a denial. */
export async function runOnce(deps: PollDeps): Promise<{ lines: string[]; code: number }> {
  const { verdict } = await poll(deps, noCache());
  const lines = verdict.stop === undefined ? [] : [remedyLine(verdict.stop)];
  lines.push(...noteLines(verdict), verdictLine(verdict));
  // A denial is not "nothing to do": exit 1 would be recorded as a drained
  // frontier and a completed run. Exit 2 is the gate failing to reach a
  // verdict, which the supervisor retries and then stops on as `gate-broken`.
  return { lines, code: verdict.work ? 0 : verdict.stop === undefined ? 1 : 2 };
}

/**
 * Write an applied batch's journal draft and publish it through the harness's
 * publisher, exactly as an iteration publishes its own. Best-effort: a draft
 * that could not be pushed stays in `.ralph/logs/`, where the publisher leaves
 * every draft it could not land, and a failure here never fails the poll.
 */
function publishJournal(root: string, batch: string, entry: string): void {
  try {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const session = `clerk-${batch.replace(/[^0-9]/g, "")}`.slice(0, 40);
    const draft = join(root, ".ralph", "logs", `journal-draft-${stamp}-none-${session}.md`);
    mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
    writeFileSync(draft, entry);
    spawnSync("bun", [join(RALPH_HOME, "publish-journal.ts"), "--draft", draft, "--issue", "none"], {
      cwd: root,
      stdio: "ignore",
      timeout: 180_000,
    });
  } catch {}
}

const KIND: Readonly<Record<string, NotificationKind>> = {
  invalid_auth: "credential-expiry",
  not_authed: "credential-expiry",
  token_revoked: "credential-expiry",
  token_expired: "credential-expiry",
  account_inactive: "credential-expiry",
  no_token: "credential-expiry",
  no_jira_credential: "credential-expiry",
  jira_unauthorized: "credential-expiry",
};

/**
 * The real I/O. The project's clerk rules are loaded strictly, as the medic's
 * gate loads its branches: the validator is what refuses a clerk with no
 * channel or no Jira project, and a gate that guessed either would be the
 * harness choosing where a team's reports are filed. A throw here is exit 2,
 * which the supervisor retries and then stops on with the reason logged.
 */
function wire(root: string, env: NodeJS.ProcessEnv, intervalSeconds: number): PollDeps {
  const rules = clerkRules(loadProjectConfig(root));
  if (rules === null) throw new Error("clerk-gate: the project's .ralph/config.json has no 'clerk' block");
  const loop = env.RALPH_LOOP_NAME?.trim() || "clerk";
  const token = env.RALPH_CLERK_SLACK_TOKEN?.trim() ?? "";
  const jiraCredential = parseJiraToken(env.RALPH_CLERK_JIRA_TOKEN);
  const run = env.RALPH_RUN_ID?.trim() || null;
  // Resolved once: it asks git, and an apply appends several lines per report.
  const metricsPath = clerkMetricsPath(loop, root);
  return {
    rules,
    now: () => Date.now(),
    slack: token === "" ? null : slackClient(token, fetch, rules.channel),
    jira: jiraCredential === null ? null : jiraClient(rules.jira.site, jiraCredential),
    storePath: clerkStorePath(loop, root),
    ledger: (event) => appendEvent(metricsPath, event),
    readPlan: (batch) => readPlan(root, batch),
    secret: token,
    alert: (alert) => push(root, { kind: "gate-failure", occurrence: alert.occurrence, subject: alert.subject, body: alert.body, priority: "high", ticket: null }),
    journal: (batch, entry) => publishJournal(root, batch, entry),
    intervalSeconds,
    notify: (denial) =>
      push(root, {
        kind: KIND[denial.code] ?? "permission-denial",
        occurrence: `clerk-denied:${denial.code}`,
        subject: `The clerk was refused: ${denial.code}`,
        body: `${denial.why}. ${denial.remedy}.`,
        priority: "high",
        ticket: null,
      }),
    stop: (denial) =>
      writeInboxCommand(root, {
        version: 1,
        // One per denial per run: a second poll in the same run refused the
        // same way is the same command, applied once.
        id: `clerk-denied-${denial.code}-${run ?? Date.now()}`.replace(/[^A-Za-z0-9_.-]/g, "-"),
        command: "stop",
        loop,
        ...(run === null ? {} : { run }),
        why: `${denial.why}; ${denial.remedy}`,
        stop: "blocked",
        issuedAt: new Date().toISOString(),
        via: PREFIX,
      }) !== null,
    filesRoot: root,
    pulls: (nowMs) => readPulls({ cachePath: pullsCachePath(clerkStorePath(loop, root)), repos: rules.prRepos ?? [], nowMs }),
    kpi:
      rules.kpiReport == null
        ? null
        : {
            rules: rules.kpiReport,
            clerkMode: rules.mode,
            operator: rules.operator,
            channel: rules.channel,
            ignoreUsers: rules.ignoreUsers ?? [],
            metricsPath,
            statePath: clerkKpiStatePath(loop, root),
            memo: { doneDay: null },
          },
    codeContext: { root },
  };
}

async function main(): Promise<void> {
  // Anchored like the other gates, so every relative path resolves from the
  // worktree root wherever this was invoked from.
  process.chdir(projectRoot());
  const root = process.cwd();
  const argv = process.argv.slice(2);
  const once = argv.includes("--once");
  const interval = pollSeconds(argv.find((arg) => !arg.startsWith("--")));
  const deps = wire(root, process.env, interval);
  // Malformed, code context is off and the clerk runs as it did without it;
  // said once per gate run, so the operator learns why no comment appears.
  const codeContextProblem = clerkCodeContext(loadProjectConfig(root).clerk?.codeContext).problem;
  if (codeContextProblem !== null) console.log(`${PREFIX}: ${codeContextProblem}`);

  if (once) {
    const { lines, code } = await runOnce(deps);
    for (const line of lines) console.log(line);
    process.exitCode = code;
    return;
  }

  const { waitingSince, firstPoll } = gateResume(process.env, new Date());
  const supervisorPid = supervisorPidFrom(process.env, process.ppid);
  const slice = controlSliceSeconds(process.env.RALPH_CONTROL_POLL_SECONDS);
  let cached = noCache();

  for (let count = firstPoll; ; count++) {
    const polled = await poll(deps, cached);
    cached = polled.cached;
    const { verdict } = polled;
    for (const line of noteLines(verdict)) console.log(line);
    if (verdict.work) {
      console.log(verdictLine(verdict));
      return;
    }
    if (verdict.stop !== undefined) {
      console.log(remedyLine(verdict.stop));
      if (!verdict.stop.queued) {
        // The inbox could not be written, so handing back to the checkpoint
        // would find nothing to apply and re-gate straight into the same
        // denial, with no wait between. A non-verdict exit instead: the
        // supervisor retries a few times and stops as `gate-broken`.
        console.log(`${PREFIX}: the stop could not be written to the inbox — failing so the supervisor stops`);
        process.exitCode = 2;
        return;
      }
      // The stop command is in the inbox; the checkpoint the supervisor goes
      // back to applies it.
      console.log(CONTROL_PENDING_LINE);
      return;
    }
    const wait = verdict.waitSeconds ?? interval;
    console.log(waitingLine(verdict, { poll: count, waitingSince, now: new Date(), waitSeconds: wait }));
    // No sleep here: the supervisor re-reads its unread secrets (#759), then runs the gate again.
    if (secretRereadDue(process.env, count)) {
      console.log(secretRereadLine(PREFIX, wait, count));
      return;
    }
    const woke = await sleepInSlices(wait, slice, () => {
      if (supervisorGone(supervisorPid)) return "orphaned" as const;
      return hasPendingControl(root) ? ("control" as const) : null;
    });
    if (woke === "orphaned") {
      console.log(`${PREFIX}: supervisor ${supervisorPid} is gone — stopping.`);
      return;
    }
    if (woke === "control") {
      console.log(CONTROL_PENDING_LINE);
      return;
    }
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
