#!/usr/bin/env bun
/**
 * The sentinel's intake gate: block until an error-reporter issue needs a
 * ticket drafted for it, then hand it over (felipearos/ralph#681, spec #678).
 *
 * Same contract as `frontier-gate.ts`, `verifier/gate.ts` and `clerk/gate.ts`,
 * and for their reason: a model turn spent learning that nothing broke is a
 * turn the gate could have answered with no model at all. So the gate asks,
 * and the supervisor spawns an iteration only on its `work available — …`
 * line. It honours the control inbox, stops when its supervisor is gone, and
 * an unreachable reporter is "nothing to do this poll", never a spawn and
 * never a throw out of the poll.
 *
 * Each poll lists the reporter's issues seen inside the lookback and keeps
 * the ones that qualify: unresolved, new inside the lookback or regressed,
 * and over the event or the user threshold. It records each in its issue
 * store, then hands over the oldest one no other sentinel holds and no
 * session has drafted: it leases it, reads its evidence — the trace, tags and
 * breadcrumbs of its latest event — stores it on the record, and answers with
 * the case. The gate reads because the Sentry token is the gate's alone: the
 * session reads only what the gate stored, and never holds the token.
 *
 * In `file` mode (felipearos/ralph#682) the gate is also the only writer of
 * the tracker: each poll it files the drafts sessions recorded, files a
 * templated ticket for an issue two sessions failed, adopts a ticket an
 * earlier pass already filed (found by its body marker) instead of handing
 * the issue over again, and stops taking issues once the day's cap of filed
 * tickets is reached, paging once that day. In `observe` mode it never
 * writes to the tracker: it writes only its own issue store.
 *
 * Recurrences (felipearos/ralph#683): each poll also reads the state of a
 * few filed tickets whose issue is still unresolved. On an open ticket whose
 * issue at least doubled it posts one comment a UTC day; a closed ticket
 * whose issue came back after the close starts a new cycle, handed over and
 * filed as a new ticket linking the closed one, which is never reopened.
 * Observe mode reads the tickets too, and records each would-be write.
 *
 * `enabled: false` in the rules (#789) switches all of it off: each poll
 * still re-reads the rules from origin, and answers `disabled in config`
 * without reading the reporter, the store or the tracker.
 *
 * Usage:
 *   sentinel/gate.ts <poll-seconds>  wait until an issue qualifies, then exit 0
 *   sentinel/gate.ts --once          one poll; 0 work, 1 none
 */
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
import { hasPendingControl } from "../control-inbox";
import { projectRoot } from "../paths";
import { createLiveRules, freshestConfig, withLiveRules } from "../live-rules";
import { loadProjectConfig, sentinelRules, type ProjectConfig, type SentinelRules } from "../project-config";
import { currentProjectId } from "../project-id";
import { push, type PushInput } from "../push-notification";
import { createSentryReporter } from "../reporter/sentry";
import { roleDescriptor } from "../roles";
import type { Candidate, Reporter } from "../reporter/types";
import { createTracker, type Tracker } from "../tracker/index";
import { boundedGh } from "../verifier/gate";
import { SENTRY_API_ENV, SENTRY_TOKEN_ENV } from "./credentials";
import { fileTicket, recurrenceComment, searchToken, templatedDraft } from "./file";
import {
  confirmComment,
  cycleOf,
  doubled,
  ensureBaseline,
  filedOn,
  handled,
  issueFree,
  issueKey,
  markCapAlerted,
  markChecked,
  readStore,
  recordCandidate,
  recordDraft,
  recordFiled,
  recordHandover,
  releaseComment,
  reopenRecord,
  reserveComment,
  storePathFromGit,
  takeIssueLease,
  ticketNumberOf,
  withStore,
  type Draft,
  type Holder,
  type IssueRecord,
  type Lease,
  type SentinelStore,
  utcDay,
} from "./store";

export { SENTRY_API_ENV, SENTRY_TOKEN_ENV };

export interface Verdict {
  work: boolean;
  why: string;
}

export interface PollDeps {
  rules: SentinelRules;
  /** The reporter, or why there is none (no token): then every poll is idle with that reason. */
  reporter: { read: Reporter } | { read: null; why: string };
  storePath: string;
  now: () => Date;
  holder: Holder;
  /**
   * The tracker file mode writes and the push its daily cap pages through, or
   * why there is none. Observe mode only reads it, for a filed ticket's state
   * (#683). Absent is no tracker.
   */
  filing?: { tracker: Tracker; push: (input: PushInput) => void } | { tracker: null; why: string };
}

/**
 * A session that failed this many times is never handed the issue again: the
 * templated fallback takes it, so a model that always fails cannot burn a
 * session every poll.
 */
export const MAX_ATTEMPTS = 2;

/** Tracker failures one filing pass tolerates before it stops: an outage fails every create. */
const MAX_FILING_FAILURES = 3;

/** Tracker failures the recurrence pass tolerates before it stops, for the same reason. */
const MAX_RECURRENCE_FAILURES = 3;

/**
 * How long after a ticket closed an event still counts as the old bug. A fix
 * merged closes the ticket before it is deployed, and the old release keeps
 * throwing until then; without a grace, almost every close of a busy error
 * would file "Regressed after" for a fix not yet live. Sentry's own
 * `regressed` flag skips the wait: it is set only when the issue was resolved
 * there and came back.
 */
export const REGRESSION_GRACE_HOURS = 24;

/**
 * Filed tickets one poll reads the state of. The least recently checked go
 * first, so a project with many filed issues still has each one checked in
 * turn, and a poll stays a bounded number of tracker calls.
 */
export const MAX_TICKET_READS = 10;

const HOUR_MS = 3_600_000;
const TITLE_CHARS = 120;

/** `ralph.sh` reads one line: a newline in a reporter's title would split it. */
const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, " ");

const firstLine = (text: string): string => text.split("\n")[0] ?? "";

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

const cut = (text: string): string => (text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS - 1)}…` : text);

/**
 * The case the gate hands over, the one line `ralph.sh` exports to the
 * session as `RALPH_INTAKE_CASE`. {@link parseCase} reads it back.
 */
export const caseText = (record: IssueRecord): string =>
  // A reporter may send an empty title; the case still needs text after the
  // dash, or the trimmed line would no longer parse back.
  `sentinel issue ${issueKey(record.reporter, record.id)} — ${cut(oneLine(record.candidate.title).trim()) || "(untitled)"}`;

const CASE = /^sentinel issue ([a-z]+):(\S+) — .*$/;

/** The issue key (`sentry:123`) a {@link caseText} names, or null for any other text. */
export function parseCase(text: string): string | null {
  const match = CASE.exec(text.trim());
  if (match === null) return null;
  return issueKey(match[1]!, match[2]!);
}

/**
 * Worth a ticket: still open (Sentry reports a regressed issue as unresolved
 * again, so resolved and ignored ones are left alone), new inside the
 * lookback or come back, and hurting enough events or users to matter.
 */
function qualifies(candidate: Candidate, rules: SentinelRules, startMs: number, reopened: boolean): boolean {
  if (candidate.status !== "unresolved") return false;
  const firstSeen = Date.parse(candidate.firstSeen);
  const fresh = Number.isFinite(firstSeen) && firstSeen >= startMs;
  // A record the recurrence pass reopened came back after its ticket closed:
  // it is due a new ticket even when Sentry no longer flags it regressed.
  if (!fresh && !candidate.regressed && !reopened) return false;
  return overThreshold(candidate, rules);
}

const overThreshold = (candidate: Candidate, rules: SentinelRules): boolean =>
  candidate.events >= rules.minEvents || candidate.users >= rules.minUsers;

/** Oldest first, so an issue that has waited longest is drafted first; ties by id, so the order is stable. */
function oldestFirst(a: Candidate, b: Candidate): number {
  const byAge = Date.parse(a.firstSeen) - Date.parse(b.firstSeen);
  if (byAge !== 0 && Number.isFinite(byAge)) return byAge;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * One poll. Never throws: whatever goes wrong inside is the poll's answer,
 * "nothing to do", with the reason — a gate that threw would be a non-verdict
 * exit, which the supervisor retries and then stops on.
 */
export async function poll(deps: PollDeps): Promise<Verdict> {
  try {
    return await pollOnce(deps);
  } catch (error) {
    return { work: false, why: `the poll failed: ${firstLine((error as Error)?.message ?? String(error))}` };
  }
}

/** The reporter's name as an operator knows it, for the disabled line. */
const REPORTER_NAMES: Record<SentinelRules["reporter"]["kind"], string> = { sentry: "Sentry" };

/**
 * The idle reason of a sentinel its config switched off (#789). The gate that
 * prints it is still polling and re-reading its rules: setting `enabled` back
 * to true applies on the next poll, with no restart.
 */
export const disabledWhy = (rules: SentinelRules): string =>
  `disabled in config — not polling ${REPORTER_NAMES[rules.reporter.kind] ?? rules.reporter.kind}`;

async function pollOnce(deps: PollDeps): Promise<Verdict> {
  // Off means off (#789): checked before anything else, so a disabled
  // sentinel reads no reporter, files no draft or templated fallback, posts
  // no recurrence comment, pages no cap and hands nothing to a session. The
  // cheap reads it could still make (its own store, a filed ticket's state)
  // are skipped too: nothing would act on them, and "it does nothing" is
  // simpler to trust than a list of what it still does. Ahead of the token
  // check, so a switched-off sentinel with no token says it is off.
  if (deps.rules.enabled === false) return { work: false, why: disabledWhy(deps.rules) };
  if (deps.reporter.read === null) return { work: false, why: oneLine(deps.reporter.why) };
  const reporter = deps.reporter.read;
  const { rules } = deps;
  // The store key's reporter is the configured kind, not the adapter's: a
  // fake standing in for Sentry in a test still names Sentry's issues.
  const kind = rules.reporter.kind;
  const now = deps.now();
  const startMs = now.getTime() - rules.lookbackHours * HOUR_MS;

  const listed = await reporter.listCandidates({
    since: new Date(startMs).toISOString(),
    lookbackHours: rules.lookbackHours,
    now,
  });
  if (!listed.reachable) return { work: false, why: oneLine(`the error reporter could not be read: ${listed.why}`) };

  const seen = plural(listed.issues.length, "candidate");
  const filing = deps.filing ?? { tracker: null, why: "no tracker wired" };
  // The tracker this poll writes to: file mode's only. Observe mode may read
  // a filed ticket's state through `filing.tracker`, and never writes.
  const tracker = rules.mode === "file" ? filing.tracker : null;
  const day = utcDay(now);

  // Before the main pass, so a record it reopens is handed over this poll.
  const recurrenceNotes = await recurrencePass(deps, reporter, filing, listed.issues, tracker, now);
  const reopened = reopenedKeys(readStore(deps.storePath));
  const qualifying = listed.issues
    .filter((candidate) => qualifies(candidate, rules, startMs, reopened.has(issueKey(kind, candidate.id))))
    .sort(oldestFirst);

  // Recorded before the hand-over, so the store shows every issue the gate
  // judged worth a ticket, even the ones held or already drafted.
  const { order, cycles, skipped, toFile, templatedNow, filedToday } = await withStore(deps.storePath, (store) => {
    // The fallback in observe mode: an issue two sessions failed gets the
    // templated draft recorded, so the store shows what file mode would file.
    const templatedNow = new Set<string>();
    if (rules.mode === "observe") {
      for (const [key, record] of oldestRecords(store.issues)) {
        if (handled(record) || record.attempts < MAX_ATTEMPTS) continue;
        if (!issueFree(store.leases, key, deps.holder, now.getTime())) continue;
        recordDraft(store, key, templatedDraft(record, rules.language, now), "observe", now);
        templatedNow.add(key);
      }
    }
    const order: string[] = [];
    const cycles: Record<string, number> = {};
    let skippedHandled = 0;
    let skippedAttempts = 0;
    let skippedTemplated = 0;
    let held: Lease | null = null;
    for (const candidate of qualifying) {
      const record = recordCandidate(store, kind, candidate, rules.mode, now);
      const key = issueKey(kind, candidate.id);
      if (templatedNow.has(key)) { skippedTemplated++; continue; }
      if (handled(record)) { skippedHandled++; continue; }
      if (record.attempts >= MAX_ATTEMPTS) { skippedAttempts++; continue; }
      if (!issueFree(store.leases, key, deps.holder, now.getTime())) { held ??= store.leases[key] ?? null; continue; }
      order.push(key);
      cycles[key] = cycleOf(record);
    }
    // What the filing pass files, over every record and not only this poll's
    // qualifying ones: a draft is filed even once its issue stops qualifying.
    const toFile: string[] = [];
    if (tracker !== null) {
      for (const [key, record] of oldestRecords(store.issues)) {
        if (fileable(record) !== null) toFile.push(key);
      }
    }
    return {
      order,
      cycles,
      skipped: { handled: skippedHandled, attempts: skippedAttempts, templated: skippedTemplated, held },
      toFile,
      templatedNow,
      filedToday: filedOn(store, day),
    };
  });

  const counts = { filed: 0, adopted: 0, templated: templatedNow.size };
  let adoptedOnHandover = 0;
  let capHeld = 0;
  let filedSoFar = filedToday;
  let filingError: string | null = null;
  let filingFailures = 0;
  if (tracker !== null) {
    for (const [index, key] of toFile.entries()) {
      if (filedSoFar >= rules.maxPerDay) { capHeld += toFile.length - index; break; }
      const taken = await takeIssueLease(deps.storePath, key, deps.holder, { nowMs: deps.now().getTime(), allowDrafted: true });
      if (!taken.taken) continue;
      // Read again under the lease: a session may have drafted it, or another
      // gate filed it, since the list above was taken.
      const record = readStore(deps.storePath).issues[key];
      const which = record === undefined ? null : fileable(record);
      if (record === undefined || which === null) {
        await withStore(deps.storePath, (store) => releaseOwn(store, key, deps.holder));
        continue;
      }
      const draft: Draft = which === "draft" ? record.draft! : templatedDraft(record, rules.language, now);
      let filed;
      try {
        // Outside the store lock: no network inside `withStore`.
        filed = await fileTicket(tracker, record, draft, rules.language);
      } catch (error) {
        // Left as it was, so the next poll retries; the marker makes that
        // retry adopt a ticket this call may have created after all. The
        // pass goes on: one draft the tracker always refuses (an oversized
        // body, say) sits first in this list every poll, and stopping on it
        // would starve every draft behind it. Up to a bound, though: an
        // outage fails every create, and each is a bounded call that can
        // take a minute.
        filingError ??= firstLine((error as Error)?.message ?? String(error));
        filingFailures++;
        await withStore(deps.storePath, (store) => releaseOwn(store, key, deps.holder));
        if (filingFailures >= MAX_FILING_FAILURES) break;
        continue;
      }
      const adopted = filed.kind === "adopted";
      const recorded = await withStore(deps.storePath, (store) => {
        if (store.issues[key]?.state === "filed") { releaseOwn(store, key, deps.holder); return false; }
        recordFiled(store, key, { ticket: tracker.ref(filed.number), number: filed.number, draft, adopted }, "file", now);
        return true;
      });
      if (!recorded) continue;
      if (adopted) counts.adopted++;
      else { counts.filed++; filedSoFar++; }
      if (which === "templated") counts.templated++;
    }
  }

  // The daily cap: once the day's tickets are filed, no new issue is taken
  // this poll, since a session's draft would only wait for tomorrow's filing.
  const capReached = rules.mode === "file" && filedSoFar >= rules.maxPerDay;
  if (capReached) {
    const waiting = capHeld + order.length;
    if (waiting > 0) {
      // The ledger's set-once flag decides it, so the day pages once across
      // polls and gates; marked only when there is a push to send it through.
      const alert = filing.tracker !== null && await withStore(deps.storePath, (store) => markCapAlerted(store, day));
      if (alert && filing.tracker !== null) {
        try {
          filing.push({
            kind: "sentinel-alert",
            occurrence: `sentinel-alert:${day}`,
            subject: "Sentinel daily cap reached",
            body: `${plural(filedSoFar, "ticket")} filed today (${day}, UTC), ${plural(waiting, "issue")} ${waiting === 1 ? "waits" : "wait"} for the next UTC day.`,
            priority: "high",
            ticket: null,
          });
        } catch {
          // A page that cannot be sent must not turn the poll into a throw.
        }
      }
      return {
        work: false,
        why: `daily cap of ${rules.maxPerDay} tickets reached for ${day}; ${plural(waiting, "issue")} ${waiting === 1 ? "waits" : "wait"} for the next UTC day`,
      };
    }
  }

  let raced: Lease | null = null;
  const unreadable: string[] = [];
  for (const key of capReached ? [] : order) {
    // The clock is read again here, not at the poll's start: listing can take
    // minutes on a slow reporter, and a lease dated from then could be written
    // already expired, free for a second gate to take.
    const taken = await takeIssueLease(deps.storePath, key, deps.holder, { nowMs: deps.now().getTime() });
    if (!taken.taken) { raced ??= taken.holder; continue; }
    const id = key.slice(kind.length + 1);
    if (tracker !== null) {
      // A ticket already filed for the issue — a store lost, or a gate that
      // died between create and record — is adopted, not drafted again. A
      // failed search goes on: filing searches again before it creates.
      let hit: number | null = null;
      try {
        // The record's own cycle: a new cycle must not adopt the closed
        // ticket of the one before, which carries the same issue's marker.
        hit = (await tracker.findByBodyMarker(searchToken(kind, id, cycles[key] ?? 0)))[0]?.number ?? null;
      } catch {}
      if (hit !== null) {
        const number = hit;
        await withStore(deps.storePath, (store) => {
          if (store.issues[key]?.state === "filed") releaseOwn(store, key, deps.holder);
          else recordFiled(store, key, { ticket: tracker.ref(number), number, draft: null, adopted: true }, "file", now);
        });
        counts.adopted++;
        adoptedOnHandover++;
        continue;
      }
    }
    const read = await reporter.readEvidence(id);
    if (!read.reachable) {
      // One issue whose evidence cannot be read (deleted, merged, its latest
      // event aged out) must not stop the queue: release it, so the heartbeat
      // does not renew it all night, and try the next one.
      unreadable.push(`${key} (${read.why})`);
      await withStore(deps.storePath, (store) => { delete store.leases[key]; });
      continue;
    }
    const record = await withStore(deps.storePath, (store) => recordHandover(store, key, read.evidence, rules.mode, now));
    // The work line is the case `ralph.sh` hands the session and `parseCase` reads back: nothing may follow it.
    return { work: true, why: caseText(record) };
  }

  if (unreadable.length > 0) return { work: false, why: oneLine(`the evidence could not be read for ${unreadable.join(", ")}`) };
  const notes = [qualifying.length === 0 ? `${seen}, none qualifies` : `${seen}, ${plural(qualifying.length, "qualifying issue")}`];
  if (skipped.handled > 0) notes.push(`${skipped.handled} already drafted`);
  if (skipped.attempts > 0) notes.push(`${skipped.attempts} failed ${MAX_ATTEMPTS} sessions`);
  const holder = skipped.held ?? raced;
  const heldCount = qualifying.length - skipped.handled - skipped.attempts - skipped.templated - adoptedOnHandover;
  if (heldCount > 0) notes.push(`${heldCount} held${holder === null ? "" : ` by ${holder.loop}`}`);
  if (counts.filed > 0) notes.push(`filed ${counts.filed}`);
  if (counts.adopted > 0) notes.push(`adopted ${counts.adopted}`);
  if (counts.templated > 0) notes.push(`${counts.templated} templated`);
  if (filingError !== null) notes.push(`filing failed for ${filingFailures}: ${filingError}`);
  if (rules.mode === "file" && filing.tracker === null) notes.push(`files nothing: ${filing.why}`);
  notes.push(...recurrenceNotes);
  return { work: false, why: oneLine(notes.join(", ")) };
}

/** Never checked first, then the oldest check, so every filed ticket is read in turn. */
function leastRecentlyChecked(a: { checkedAt: string | null }, b: { checkedAt: string | null }): number {
  if (a.checkedAt === b.checkedAt) return 0;
  if (a.checkedAt === null) return -1;
  if (b.checkedAt === null) return 1;
  return a.checkedAt < b.checkedAt ? -1 : 1;
}

/** Records in a new cycle not yet drafted or filed: due a hand-over like a fresh issue. */
function reopenedKeys(store: SentinelStore): Set<string> {
  const keys = new Set<string>();
  for (const [key, record] of Object.entries(store.issues)) {
    if (cycleOf(record) > 0 && !handled(record)) keys.add(key);
  }
  return keys;
}

/**
 * The recurrence pass: read the state of the filed tickets whose issue is
 * still unresolved, comment on an open one whose issue doubled, and start a
 * new cycle for a closed one whose issue came back. In observe mode a
 * drafted record stands for the ticket file mode would have filed: always
 * open, never read. Never throws: whatever fails is a note in the verdict.
 */
async function recurrencePass(
  deps: PollDeps,
  reporter: Reporter,
  filing: NonNullable<PollDeps["filing"]>,
  candidates: Candidate[],
  writeTracker: Tracker | null,
  now: Date,
): Promise<string[]> {
  const notes: string[] = [];
  try {
    await checkRecurrences(deps, reporter, filing, candidates, writeTracker, now, notes);
  } catch (error) {
    notes.push(`the recurrence check failed: ${firstLine((error as Error)?.message ?? String(error))}`);
  }
  return notes;
}

async function checkRecurrences(
  deps: PollDeps,
  reporter: Reporter,
  filing: NonNullable<PollDeps["filing"]>,
  candidates: Candidate[],
  writeTracker: Tracker | null,
  now: Date,
  notes: string[],
): Promise<void> {
  const { rules } = deps;
  const kind = rules.reporter.kind;
  const readTracker = filing.tracker;
  const day = utcDay(now);
  const snapshot = readStore(deps.storePath);

  const filed: { key: string; candidate: Candidate; number: number; checkedAt: string | null }[] = [];
  const wouldBe: { key: string; candidate: Candidate }[] = [];
  for (const candidate of candidates) {
    if (candidate.status !== "unresolved") continue;
    const key = issueKey(kind, candidate.id);
    const record = snapshot.issues[key];
    if (record === undefined) continue;
    const number = ticketNumberOf(record);
    if (record.state === "filed" && number !== null) {
      filed.push({ key, candidate, number, checkedAt: record.recurrence?.checkedAt ?? null });
    } else if (rules.mode === "observe" && record.state === "drafted" && record.mode === "observe") {
      wouldBe.push({ key, candidate });
    }
  }
  filed.sort(leastRecentlyChecked);

  let failures = 0;
  let firstError: string | null = null;
  const fail = (error: unknown): void => {
    firstError ??= firstLine((error as Error)?.message ?? String(error));
    failures++;
  };
  let commented = 0;
  let wouldComment = 0;
  let regressed = 0;

  /**
   * One comment a UTC day on an open ticket whose issue at least doubled. The
   * day is reserved under the lock before the post, so two gates never post
   * twice; a failed post gives the reservation back for the next poll.
   */
  const onOpen = async (key: string, candidate: Candidate, number: number | null): Promise<void> => {
    const reserved = await withStore(deps.storePath, (store) => {
      const record = store.issues[key];
      if (record === undefined) return null;
      const recurrence = ensureBaseline(store, key, candidate.events);
      if (!doubled(recurrence, candidate.events)) return null;
      const previous = reserveComment(store, key, day);
      if (previous === false) return null;
      return { previous, baseline: recurrence.baseline, record: structuredClone(record) };
    });
    if (reserved === null) return;
    let release = reserved.record.evidence?.release ?? null;
    try {
      const read = await reporter.readEvidence(candidate.id);
      if (read.reachable) release = read.evidence.release;
    } catch {
      // The stored release will do: the comment is about the counts.
    }
    const at = deps.now().toISOString();
    const counted = { events: candidate.events, users: candidate.users, lastSeen: candidate.lastSeen, release };
    const body = recurrenceComment(reserved.record, { ...counted, baseline: reserved.baseline }, rules.language);
    const post = writeTracker !== null && number !== null;
    if (post) {
      try {
        await writeTracker.comment(number, body);
      } catch (error) {
        fail(error);
        await withStore(deps.storePath, (store) => {
          if (store.issues[key] !== undefined) releaseComment(store, key, day, reserved.previous);
        });
        return;
      }
    }
    await withStore(deps.storePath, (store) => {
      if (store.issues[key] !== undefined) confirmComment(store, key, { at, ...counted, body, posted: post });
    });
    if (post) commented++;
    else wouldComment++;
  };

  if (readTracker === null) {
    if (filed.length > 0) notes.push(`recurrences unchecked: ${oneLine(filing.why)}`);
  } else {
    for (const { key, candidate, number } of filed.slice(0, MAX_TICKET_READS)) {
      if (failures >= MAX_RECURRENCE_FAILURES) break;
      let ticket;
      try {
        ticket = await readTracker.issue(number);
      } catch (error) {
        fail(error);
        // Stamped anyway, to the back of the rotation: a deleted or
        // transferred ticket fails every read, and a few of them left at the
        // front would use up the failure budget before any other is checked.
        await withStore(deps.storePath, (store) => {
          if (store.issues[key] !== undefined) markChecked(store, key, now);
        });
        continue;
      }
      // Re-checked under the lock: another gate may have reopened or refiled it.
      const still = await withStore(deps.storePath, (store) => {
        const record = store.issues[key];
        if (record === undefined || record.state !== "filed" || ticketNumberOf(record) !== number) return false;
        // The baseline first, from this poll's count: a record filed before
        // recurrences existed has none, and its first check sets it rather
        // than comments on the count it was filed with.
        ensureBaseline(store, key, candidate.events);
        markChecked(store, key, now);
        return true;
      });
      if (!still) continue;
      if (ticket.state === "open") {
        await onOpen(key, candidate, number);
        continue;
      }
      // A ticket closed as a duplicate or not planned was a person deciding
      // the issue needs no ticket of its own: filing it again would argue.
      if (ticket.closedAs === "canceled") continue;
      // Seen after the close, still hurting enough to matter, and either
      // flagged regressed by Sentry (it was resolved there and came back) or
      // still firing past the grace for the fix's deploy. Sentry's flag only
      // counts with an event after the close: it outlives the event that set
      // it, so a ticket closed after a regression is not one. No close time:
      // cannot tell.
      const closedMs = ticket.closedAt === null ? NaN : Date.parse(ticket.closedAt);
      if (!Number.isFinite(closedMs)) continue;
      const lastSeenMs = Date.parse(candidate.lastSeen);
      const pastGrace = lastSeenMs > closedMs + REGRESSION_GRACE_HOURS * HOUR_MS;
      if (!(lastSeenMs > closedMs) || !(candidate.regressed || pastGrace) || !overThreshold(candidate, rules)) continue;
      const reopenedNow = await withStore(deps.storePath, (store) => {
        const record = store.issues[key];
        if (record === undefined || record.state !== "filed" || ticketNumberOf(record) !== number) return false;
        reopenRecord(store, key, now, candidate.events);
        return true;
      });
      if (reopenedNow) regressed++;
    }
  }
  // Observe mode's would-be tickets are always open and need no read.
  for (const { key, candidate } of wouldBe) await onOpen(key, candidate, null);

  if (commented > 0) notes.push(`commented ${commented}`);
  if (wouldComment > 0) notes.push(`would comment ${wouldComment}`);
  if (regressed > 0) notes.push(`regressed ${regressed}`);
  if (firstError !== null) notes.push(`recurrence check failed for ${failures}: ${firstError}`);
}

/** The store's records, oldest observed first; ties by key, so the order is stable. */
function oldestRecords(issues: Record<string, IssueRecord>): [string, IssueRecord][] {
  return Object.entries(issues).sort(([ka, a], [kb, b]) => {
    const byAge = Date.parse(a.observedAt) - Date.parse(b.observedAt);
    if (byAge !== 0 && Number.isFinite(byAge)) return byAge;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * What file mode would file for a record: the session's draft, the templated
 * one for an issue two sessions failed, or nothing. A draft recorded in
 * observe mode is never filed: switching a project to file mode would flood
 * its tracker with every would-have-been of the weeks it was observed.
 */
function fileable(record: IssueRecord): "draft" | "templated" | null {
  if (record.state === "drafted") return record.mode === "file" && record.draft !== null ? "draft" : null;
  // Only for attempts made in file mode, for the same reason: sessions that
  // failed under observe (a record the #681 build wrote, which had no observe
  // fallback) must not become an undiagnosed ticket filed weeks later, the
  // day the project switches to file mode.
  if (!handled(record) && record.attempts >= MAX_ATTEMPTS && record.mode === "file") return "templated";
  return null;
}

/** Drop the lease on `key` only if `holder` has it: another gate's lease is never this one's to free. */
function releaseOwn(store: { leases: Record<string, Lease> }, key: string, holder: Holder): void {
  const lease = store.leases[key];
  if (lease !== undefined && lease.run === holder.run && lease.loop === holder.loop) delete store.leases[key];
}

/* --------------------------------------------------------------------------
 * CLI.
 * ----------------------------------------------------------------------- */

const PREFIX = "sentinel-gate";

export const verdictLine = (verdict: Verdict): string =>
  `${PREFIX}: ${verdict.work ? "work available" : "nothing to do"} — ${verdict.why}`;

/** Matched by `ralph.sh`, which goes back to its control checkpoint instead of spawning. */
export const CONTROL_PENDING_LINE = `${PREFIX}: control command waiting — handing back to the supervisor`;

export function waitingLine(
  verdict: Verdict,
  state: { poll: number; waitingSince: Date; now: Date; waitSeconds: number },
): string {
  const idle = Math.max(0, Math.round((state.now.getTime() - state.waitingSince.getTime()) / 1000));
  const at = state.now.toISOString().replace(/\.\d+Z$/, "Z");
  return `${PREFIX}: ${verdict.why} at ${at} — waiting ${state.waitSeconds}s (poll ${state.poll}, idle ${formatDuration(idle)})`;
}

/** From the role descriptor, as every role's is: `roles.ts` says how long a role's gate waits. */
export const DEFAULT_POLL_SECONDS = roleDescriptor("sentinel").pollSeconds;

export function pollSeconds(argv: string | undefined): number {
  if (argv !== undefined && /^\d+$/.test(argv) && Number(argv) >= 1) return Number(argv);
  return DEFAULT_POLL_SECONDS;
}

/**
 * The project's sentinel rules and the real reporter. A config with no
 * `sentinel` block is a throw, exit 2, which the supervisor retries and then
 * stops on with the reason logged. A missing token is not a throw: it is the
 * poll's reason, every poll, until the token is stored. The token is read
 * here and only here, and goes nowhere but the reporter.
 *
 * `config` is the one to wire from: the freshest the gate has (#788), read
 * from origin by `live-rules.ts`; the worktree's when none is given. The
 * gate wires again from a new config when its sentinel rules change, so a
 * new reporter project takes effect on the next poll as the mode does.
 */
export function wire(root: string, env: NodeJS.ProcessEnv = process.env, config: ProjectConfig = loadProjectConfig(root)): PollDeps {
  const rules = sentinelRules(config);
  if (rules === null) throw new Error("sentinel-gate: the project's .ralph/config.json has no 'sentinel' block");
  const token = env[SENTRY_TOKEN_ENV]?.trim() ?? "";
  const reporter: PollDeps["reporter"] = token === ""
    ? { read: null, why: `no Sentry token — ${SENTRY_TOKEN_ENV} is not set` }
    : {
        read: createSentryReporter({
          org: rules.reporter.org,
          project: rules.reporter.project,
          environment: rules.reporter.environment,
          token,
          fetcher: fetch,
          apiBase: env[SENTRY_API_ENV]?.trim() || undefined,
        }),
      };
  let filing: PollDeps["filing"];
  try {
    // An unconnected Linear or Jira is not a wire failure: it is the reason
    // file mode files nothing, every poll. GitHub's adapter gets a bounded
    // `gh`, so a hung call fails rather than hangs. Observe mode builds one
    // too, to read a filed ticket's state for recurrences; it never writes.
    const tracker = createTracker(config, { projectId: currentProjectId(root, env), github: { gh: boundedGh(root) } });
    filing = { tracker, push: (input) => push(root, input) };
  } catch (error) {
    filing = { tracker: null, why: firstLine((error as Error)?.message ?? String(error)) };
  }
  return {
    rules,
    reporter,
    filing,
    storePath: storePathFromGit(root),
    now: () => new Date(),
    holder: { run: env.RALPH_RUN_ID || "manual", loop: env.RALPH_LOOP_NAME || "sentinel" },
  };
}

async function main(): Promise<void> {
  // Anchored like the other gates, so every relative path resolves from the
  // worktree root wherever this was invoked from.
  process.chdir(projectRoot());
  const root = process.cwd();
  const argv = process.argv.slice(2);
  // The freshest config the last gate held, when it is newer than the
  // worktree: a restart after a hand-over must not fall back to old rules.
  const start = freshestConfig(root, "sentinel");
  let deps = wire(root, process.env, start.config);
  const interval = pollSeconds(argv.find((arg) => !arg.startsWith("--")));
  // Every poll reads the rules from origin first (#788): a merged change
  // applies on the next poll, and one that does not validate is ignored.
  const live = createLiveRules({
    root,
    role: "sentinel",
    baseBranch: process.env.RALPH_BASE_BRANCH?.trim() || start.config.baseBranch,
    extract: sentinelRules,
    initial: { config: start.config, rules: deps.rules, source: start.source },
    minFetchIntervalMs: interval * 1000,
  });
  const fresh = (): Promise<PollDeps> =>
    withLiveRules(live, deps, (config) => wire(root, process.env, config), (line) => console.log(`${PREFIX}: ${line}`));

  if (argv.includes("--once")) {
    deps = await fresh();
    const verdict = await poll(deps);
    console.log(verdictLine(verdict));
    process.exitCode = verdict.work ? 0 : 1;
    return;
  }

  const { waitingSince, firstPoll } = gateResume(process.env, new Date());
  const supervisorPid = supervisorPidFrom(process.env, process.ppid);
  const slice = controlSliceSeconds(process.env.RALPH_CONTROL_POLL_SECONDS);

  for (let count = firstPoll; ; count++) {
    deps = await fresh();
    const verdict = await poll(deps);
    if (verdict.work) {
      console.log(verdictLine(verdict));
      return;
    }
    console.log(waitingLine(verdict, { poll: count, waitingSince, now: new Date(), waitSeconds: interval }));
    // No sleep here: the supervisor re-reads its unread secrets, then sleeps
    // what is left of this interval, so the next poll comes no later than it
    // does today and carries the token if the read and its check passed.
    if (secretRereadDue(process.env, count)) {
      console.log(secretRereadLine(PREFIX, interval, count));
      return;
    }
    const woke = await sleepInSlices(interval, slice, () => {
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
