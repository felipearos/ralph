#!/usr/bin/env bun
/**
 * The verifier's intake gate: block until a merged pull request needs a look
 * in production, then hand it over (felipearos/ralph#560).
 *
 * Same contract as `frontier-gate.ts`, `ci-doctor/gate.ts` and
 * `clerk/gate.ts`, and for their reason: a model turn spent learning that
 * nothing merged is a turn the gate could have answered with no model at all.
 * So the gate asks, and the supervisor spawns an iteration only on its
 * `work available — …` line. It honours the control inbox, stops when its
 * supervisor is gone, and an unreadable probe is "nothing to do this poll",
 * never a spawn and never a throw out of the poll.
 *
 * Each poll opens a watch for every qualifying merged pull request whose
 * production deploy has landed (felipearos/ralph#563), timing its check-ins
 * from the deploy. Then it hands over the first due check-in no other
 * verifier holds (felipearos/ralph#565): it leases it, gathers the evidence —
 * the PR's changed files, the other PRs in the same deploy, Sentry health and
 * traffic — stores it on the check-in, and answers with the case. The gate
 * gathers because the Sentry token is the gate's alone (`roles.ts`): the
 * session reads what was stored, and never holds the token. The gate reads
 * GitHub, the deploy vendor, Sentry and the tracker, and writes its own watch
 * store. In `report` mode (felipearos/ralph#567) it also does the tracker
 * writes, each poll before the hand-over: it announces a watch the poll it
 * opens and settles a decided one the poll after the session decided it. In
 * `observe` mode it writes nothing to the tracker and sends no push.
 * `enabled: false` (#789) stops all of it: each poll still re-reads the rules
 * from origin, and answers `disabled in config` having read and written
 * nothing else.
 *
 * Usage:
 *   verifier/gate.ts <poll-seconds>  wait until a check-in is due, then exit 0
 *   verifier/gate.ts --once          one poll; 0 work, 1 none
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

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
import { push, type PushInput } from "../push-notification";
import { projectRoot } from "../paths";
import { currentProjectId } from "../project-id";
import { createLiveRules, freshestConfig, withLiveRules } from "../live-rules";
import {
  loadProjectConfig,
  verifierRules,
  type ProjectConfig,
  type RosterEntry,
  type VerifierRules,
  type TrackerConfig,
} from "../project-config";
import { roleDescriptor } from "../roles";
import { CommandError } from "../tracker/command";
import { createTracker, type Tracker } from "../tracker/index";
import { credentialPath, parseEnvFile } from "../ui-shots";
import { SENTRY_TOKEN_ENV, VERCEL_TOKEN_ENV } from "./credentials";
import { ghContains, githubLandedDeploy, vercelLandedDeploy, type DeploySourceReader, type Gh } from "./deploys";
import { listMerged, qualify, type Qualified } from "./merged";
import type { ActDeps } from "./act";
import { chainFromBody, chainFromRevertComment, reportWatch } from "./report";
import { realGit } from "./revert";
import { readHealth, readTraffic, routesFromFiles, type GatheredHealth, type GatheredTraffic } from "./sentry";
import type { DeployedPr } from "./verdict";
import {
  checkInFree,
  checkInKey,
  dueCheckIns,
  markReported,
  openWatches,
  readStore,
  recordEvidence,
  storePathFromGit,
  takeCheckInLease,
  withStore,
  type CheckIn,
  type CheckInEvidence,
  type Holder,
  type Watch,
  type WatchCandidate,
  type WatchStore,
} from "./watches";

export interface Verdict {
  work: boolean;
  why: string;
}

export interface PollDeps {
  rules: VerifierRules;
  gh: Gh;
  /** The deploy source, or why it cannot be read; then the poll opens nothing. */
  landed: { read: DeploySourceReader } | { read: null; why: string };
  storePath: string;
  now: () => Date;
  baseBranch: string;
  tracker: TrackerConfig;
  roster: RosterEntry[];
  /** Who the check-in lease names: the supervisor's run and loop. */
  holder: Holder;
  /** Is a lease's holder still running? Defaults to the store's own pid check. */
  alive?: (holder: { pid: number; host: string }) => boolean;
  /** Health and traffic since the deploy. Unreachable is evidence, never a throw. */
  sentry: {
    read(q: { deployedAt: string; now: Date; routes: string[] }): Promise<{ health: GatheredHealth; traffic: GatheredTraffic }>;
  };
  /**
   * The tracker report mode reads chains from and writes to, and the push it
   * alerts with; or why there is none, which only report mode's writes need.
   */
  reporter: { tracker: Tracker; push: (input: PushInput) => void } | { tracker: null; why: string };
  /** `owner/repo` of the watched PRs, which scopes report mode's fix-ticket marker. */
  repoSlug: string;
  /**
   * How long one tracker read, or one watch's report writes, may take before
   * it is a failed step: a hung Linear or Jira fetch must not hang the poll.
   */
  trackerTimeoutMs?: number;
  /**
   * What act mode reverts with (#568); null or absent where it cannot, and an
   * act watch's revert is then written as report mode's would-be revert.
   */
  act?: ActDeps | null;
}

const TRACKER_TIMEOUT_MS = 60_000;
// An act revert fetches, pushes and opens a PR on top of its tracker writes.
const ACT_REVERT_TIMEOUT_MS = 300_000;

/**
 * `promise`, or a rejection naming `what` once `ms` pass. The work itself is
 * not cancelled — no tracker call takes a signal — but the poll stops waiting
 * on it; its writes are guarded by markers, so a late one is not doubled.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`}`)), ms);
    // A pending deadline must not keep a finished gate process alive.
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** How many skip reasons an idle line names before it only counts them. */
const NAMED_SKIPS = 3;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const isoSeconds = (iso: string): string => iso.replace(/\.\d+Z$/, "Z");

const describeWatch = (watch: Watch): string =>
  `PR #${watch.pr} (${watch.ticketRef}) check-ins ${watch.checkIns.map((c) => isoSeconds(c.dueAt)).join(", ")}`;

/** `ralph.sh` reads one line: a newline in a vendor's message would split it. */
const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, " ");

/**
 * The case the gate hands over, the one line `ralph.sh` exports to the
 * session as `RALPH_INTAKE_CASE`. {@link parseCase} reads it back.
 */
export const caseText = (watch: Watch, checkIn: CheckIn): string =>
  oneLine(`verifier check-in +${checkIn.offsetHours}h of PR #${watch.pr} (${watch.ticketRef}), deploy ${watch.deployId}`);

const CASE = /^verifier check-in \+(\d+(?:\.\d+)?)h of PR #(\d+) \(.*\), deploy \S+$/;

/** The check-in a {@link caseText} names, or null for any other text. */
export function parseCase(text: string): { pr: number; offsetHours: number } | null {
  const match = CASE.exec(text.trim());
  if (match === null) return null;
  return { pr: Number(match[2]), offsetHours: Number(match[1]) };
}

/**
 * The idle reason of a verifier its config switched off (#789). The gate that
 * prints it is still polling and re-reading its rules: setting `enabled` back
 * to true applies on the next poll, with no restart.
 */
export const DISABLED_WHY = "disabled in config — not watching merges or handing over check-ins";

/**
 * One poll. Never throws: whatever goes wrong inside is the poll's answer,
 * "nothing to do", with the reason — a gate that threw would be a non-verdict
 * exit, which the supervisor retries and then stops on.
 */
export async function poll(deps: PollDeps): Promise<Verdict> {
  try {
    // Off means off (#789): no merge listed, no watch opened, no tracker
    // write or push from the report pass, no check-in handed to a session.
    // Watches already open stay in the store as they are; their check-ins
    // come due while it is off and are handed over, late, once it is on
    // again. Nothing that is read here would be acted on, so nothing is read.
    if (deps.rules.enabled === false) return { work: false, why: DISABLED_WHY };
    const now = deps.now();
    const idle = await openDue(deps, now);
    // Before the hand-over, so a watch is announced the poll it opens and a
    // decided one is settled the poll after; a report that fails is a note,
    // never a reason to hold back a due check-in.
    const reports = await reportPass(deps);
    // A watch opened this very poll is already in the store, so its first
    // check-in, if due, is handed over now rather than a poll later.
    const handed = await handOver(deps);
    // The work line is the case `ralph.sh` hands the session and `parseCase` reads back: nothing may follow it.
    if (handed.kind === "work") return { work: true, why: handed.why };
    if (handed.kind === "failed") return { work: false, why: oneLine([handed.why, ...reports].join("; ")) };
    return { work: false, why: oneLine([idle, ...reports, ...handed.notes].join("; ")) };
  } catch (error) {
    return { work: false, why: `the poll failed: ${firstLine((error as Error)?.message ?? String(error))}` };
  }
}

/**
 * Open watches for the merged PRs whose deploy landed, and answer the idle
 * reason. A failure here is only that reason: the check-ins already in the
 * store are handed over regardless, since Sentry is all they need.
 */
async function openDue(deps: PollDeps, now: Date): Promise<string> {
  const { rules } = deps;
  if (deps.landed.read === null) return deps.landed.why;
  const read = deps.landed.read;

  const listed = await listMerged(deps.gh, deps.baseBranch, new Date(now.getTime() - rules.windowHours * 3_600_000));
  if (!listed.ok) return listed.why;

  const qualified: Qualified[] = [];
  const skipped: string[] = [];
  for (const pr of listed.prs) {
    const result = qualify(pr, { rules, tracker: deps.tracker, roster: deps.roster, now });
    if (result.kind === "qualified") qualified.push(result.candidate);
    // Out-of-window merges are the whole history; naming them would bury the rest.
    else if (!result.why.startsWith("merged more than")) skipped.push(`PR #${result.pr} ${result.why}`);
  }

  const watched = readStore(deps.storePath).watches;
  const fresh = qualified.filter((q) => watched[String(q.pr)] === undefined);

  // Every vendor read happens before the lock: the critical section stays short.
  const candidates: WatchCandidate[] = [];
  const pending: Qualified[] = [];
  const unavailable: string[] = [];
  const unchained: string[] = [];
  for (const q of fresh) {
    const deploy = await read(q.mergeCommit, q.mergedAt);
    if (deploy.kind === "landed") {
      const chain = await chainOf(deps, q.ticket, rules.mode);
      if ("why" in chain) {
        unchained.push(`PR #${q.pr}: ${chain.why}`);
        continue;
      }
      candidates.push({ ...q, deployId: deploy.id, deployedAt: deploy.deployedAt, deployUrl: deploy.url, mode: rules.mode, ...chain });
    } else if (deploy.kind === "pending") {
      pending.push(q);
    } else {
      unavailable.push(`PR #${q.pr}: ${deploy.why}`);
    }
  }

  let opened: Watch[] = [];
  if (candidates.length > 0) {
    try {
      opened = await withStore(deps.storePath, (store) => openWatches(store, candidates, rules.checkIns, now));
    } catch (error) {
      return `could not open watches: ${firstLine((error as Error)?.message ?? String(error))}`;
    }
  }

  const parts: string[] = [];
  if (opened.length > 0) parts.push(`opened ${plural(opened.length, "watch", "watches")}: ${opened.map(describeWatch).join(", ")}`);
  if (pending.length > 0) {
    parts.push(`${plural(pending.length, "merged PR")} ${pending.length === 1 ? "awaits its" : "await their"} production deploy (${pending.map((q) => `#${q.pr}`).join(", ")})`);
  }
  if (unavailable.length > 0) parts.push(`deploy source unavailable for ${unavailable.join("; ")}`);
  if (unchained.length > 0) parts.push(`ticket unreadable, watch not opened yet for ${unchained.join("; ")}`);
  if (parts.length === 0) {
    const named = skipped.slice(0, NAMED_SKIPS).join("; ");
    const more = skipped.length > NAMED_SKIPS ? `; ${skipped.length - NAMED_SKIPS} more` : "";
    const why = qualified.length > 0
      ? `every qualifying PR merged in the last ${rules.windowHours}h is already watched`
      : `nothing merged in the last ${rules.windowHours}h qualifies`;
    parts.push(skipped.length === 0 ? why : `${why} (${skipped.length} skipped: ${named}${more})`);
  }
  return parts.join("; ");
}

/**
 * The fix-ticket chain a ticket continues, read off its body: `{}` for a
 * first watch (round 1). Where the tracker is written to (report, act), a
 * ticket that cannot be read — or no tracker at all — is a why, so the watch
 * waits for a poll that can read it: opened as round 1, the chain would be
 * lost for good, and with it the third-failure stop. Observe writes nothing,
 * so it opens at round 1 as it always did rather than wait on the tracker.
 */
async function chainOf(
  deps: PollDeps,
  ticket: number,
  mode: VerifierRules["mode"],
): Promise<Pick<WatchCandidate, "root" | "round" | "lineage"> | { why: string }> {
  const { reporter } = deps;
  if ("why" in reporter) return mode === "observe" ? {} : { why: `tracker unavailable: ${reporter.why}` };
  try {
    const issue = await withDeadline(reporter.tracker.issue(ticket), deps.trackerTimeoutMs ?? TRACKER_TIMEOUT_MS, `reading ticket ${ticket}`);
    const chain = chainFromBody(issue.body);
    if (chain !== null) return chain;
    // An act revert reopens the root rather than filing a fix ticket, so the
    // next PR closing the root continues the chain its reopen comment records.
    const comments = await withDeadline(reporter.tracker.comments(ticket), deps.trackerTimeoutMs ?? TRACKER_TIMEOUT_MS, `reading ticket ${ticket}'s comments`);
    for (const comment of [...comments].reverse()) {
      const reverted = chainFromRevertComment(comment.body);
      if (reverted !== null) return reverted;
    }
    return {};
  } catch (error) {
    return mode === "observe" ? {} : { why: firstLine((error as Error)?.message ?? String(error)) };
  }
}

/** The lease key that fences one watch's report writes to one gate. */
const reportKey = (pr: number): string => `report@${pr}`;

/**
 * Advance report mode's tracker writes for every watch that has any left, in
 * PR order, and answer one note per watch that wrote or failed. Never throws:
 * a watch that fails here is retried, from where it stopped, next poll.
 */
async function reportPass(deps: PollDeps): Promise<string[]> {
  let store: WatchStore;
  try {
    store = readStore(deps.storePath);
  } catch (error) {
    return [`report pass skipped: ${firstLine((error as Error)?.message ?? String(error))}`];
  }
  const owed = Object.values(store.watches).filter(owesReport).sort((a, b) => a.pr - b.pr);
  if (owed.length === 0) return [];
  const { reporter } = deps;
  if ("why" in reporter) {
    return [`tracker unavailable, nothing reported for ${owed.map((w) => `PR #${w.pr}`).join(", ")}: ${reporter.why}`];
  }
  const notes: string[] = [];
  for (const { pr } of owed) {
    const key = reportKey(pr);
    // Two verifier gates on one host share the store: the lease keeps both
    // from filing the same fix ticket between one's create and its record.
    let taken = false;
    try {
      const lease = await takeCheckInLease(deps.storePath, key, deps.holder, { nowMs: deps.now().getTime(), ...(deps.alive ? { alive: deps.alive } : {}) });
      taken = lease.taken;
      if (!taken) continue;
      // Re-read under the lease: another gate may have recorded writes since this poll's read.
      const fresh = readStore(deps.storePath);
      const watch = fresh.watches[String(pr)];
      if (watch === undefined || !owesReport(watch)) continue;
      const record = async (patch: Parameters<typeof markReported>[2]): Promise<void> => {
        await withStore(deps.storePath, (s) => {
          markReported(s, pr, patch);
        });
      };
      const reverting = watch.mode === "act" && watch.verdict?.verdict === "revert";
      const result = await withDeadline(
        reportWatch(watch, fresh, record, {
          tracker: reporter.tracker,
          push: reporter.push,
          language: deps.rules.language,
          now: deps.now,
          repo: deps.repoSlug,
          act: deps.act ?? null,
        }),
        deps.trackerTimeoutMs ?? (reverting ? ACT_REVERT_TIMEOUT_MS : TRACKER_TIMEOUT_MS),
        reverting ? "the act revert" : "the tracker writes",
      );
      if (result.error !== null) notes.push(`report for PR #${pr} failed: ${firstLine(result.error)}`);
      else if (result.wrote.length > 0) notes.push(`reported PR #${pr}: ${result.wrote.join(", ")}`);
    } catch (error) {
      notes.push(`report for PR #${pr} failed: ${firstLine((error as Error)?.message ?? String(error))}`);
    } finally {
      if (taken) await release(deps, key);
    }
  }
  return notes;
}

/**
 * Does a report-mode watch have tracker writes left? An open one until it is
 * announced; a decided one until it is settled, announced or not, since the
 * settle skips the announce of a watch decided before it.
 */
const owesReport = (watch: Watch): boolean =>
  watch.mode !== "observe"
  && watch.reported.settledAt === undefined
  && (watch.verdict !== null || watch.reported.announcedAt === undefined);

type HandOver = { kind: "work"; why: string } | { kind: "failed"; why: string } | { kind: "idle"; notes: string[] };

/**
 * Lease the first due check-in no other live holder has, gather its evidence
 * and store it. The vendor reads run with the lease held but outside the
 * store lock, which stays short; the lease is what keeps a second gate off
 * the check-in meanwhile.
 */
async function handOver(deps: PollDeps): Promise<HandOver> {
  // A fresh clock, not the poll's: opening watches can take long enough that
  // a lease dated from the poll's start would be born already expired.
  let now = deps.now();
  const store = readStore(deps.storePath);
  const due = dueCheckIns(store, now);
  const free = due.filter(({ watch, checkIn }) =>
    checkInFree(store.leases, checkInKey(watch.pr, checkIn.offsetHours), deps.holder, now.getTime(), deps.alive));
  // One check-in that cannot be attributed must not starve the others behind it.
  const failures: string[] = [];
  for (const { watch, checkIn } of free) {
    const key = checkInKey(watch.pr, checkIn.offsetHours);
    // A failed gather before this one took its own time; date this lease afresh too.
    if (failures.length > 0) now = deps.now();
    const lease = await takeCheckInLease(deps.storePath, key, deps.holder, { nowMs: now.getTime(), ...(deps.alive ? { alive: deps.alive } : {}) });
    if (!lease.taken) continue;
    try {
      const gathered = await gather(deps, store, watch, now);
      if ("why" in gathered) {
        await release(deps, key);
        failures.push(gathered.why);
        continue;
      }
      await withStore(deps.storePath, (s) => recordEvidence(s, watch.pr, checkIn.offsetHours, gathered, now));
    } catch (error) {
      await release(deps, key);
      failures.push(`could not hand over ${key}: ${firstLine((error as Error)?.message ?? String(error))}`);
      continue;
    }
    return { kind: "work", why: caseText(watch, checkIn) };
  }
  if (failures.length > 0) {
    const more = failures.length > 1 ? ` (${failures.length} due check-ins could not be handed over)` : "";
    return { kind: "failed", why: `${failures[0]}${more}` };
  }

  const notes: string[] = [];
  // Every due one is held by now: the free ones went to a racing gate between the read and the lock.
  if (due.length > 0) notes.push(`${plural(due.length, "due check-in")} held by another verifier`);
  const next = nextCheckIn(store, now.getTime());
  if (next !== null) notes.push(`next check-in +${next.checkIn.offsetHours}h of PR #${next.watch.pr} at ${isoSeconds(next.checkIn.dueAt)}`);
  return { kind: "idle", notes };
}

/** The earliest check-in not yet due among the open watches, each watch's next undecided one. */
function nextCheckIn(store: WatchStore, nowMs: number): { watch: Watch; checkIn: CheckIn } | null {
  let next: { watch: Watch; checkIn: CheckIn } | null = null;
  for (const watch of Object.values(store.watches)) {
    if (watch.verdict !== null) continue;
    const checkIn = watch.checkIns.find((c) => c.result?.decision == null);
    if (checkIn === undefined || Date.parse(checkIn.dueAt) <= nowMs) continue;
    if (next === null || Date.parse(checkIn.dueAt) < Date.parse(next.checkIn.dueAt)) next = { watch, checkIn };
  }
  return next;
}

/** The evidence for one check-in, or why its PRs cannot be attributed. */
async function gather(
  deps: PollDeps,
  store: WatchStore,
  watch: Watch,
  now: Date,
): Promise<{ why: string } | CheckInEvidence> {
  const pr = await deployedPr(deps.gh, watch.pr);
  if ("why" in pr) return pr;
  // The deploy's exact PR set needs the previous deploy, which the store does
  // not hold, so this is a SUPERSET: every PR merged to the base within the
  // window before the deploy, watched or not — a deploy-mate the verifier
  // skipped (no ticket, a medic's PR, an unfollowed human's) still shipped —
  // plus the watches on the same deploy. A superset can only make an issue
  // look shared, which turns a revert into a ticket, never the reverse: the
  // safe direction for a revert rule.
  const deployedMs = Date.parse(watch.deployedAt);
  const listed = await listMerged(deps.gh, deps.baseBranch, new Date(deployedMs - deps.rules.windowHours * 3_600_000));
  if (!listed.ok) return { why: `could not list the PRs merged before PR #${watch.pr}'s deploy: ${listed.why}` };
  const numbers = new Set<number>();
  for (const merged of listed.prs) {
    if (merged.mergedAt !== null && Date.parse(merged.mergedAt) <= deployedMs) numbers.add(merged.number);
  }
  for (const other of Object.values(store.watches)) if (other.deployId === watch.deployId) numbers.add(other.pr);
  numbers.delete(watch.pr);
  const otherPrs: DeployedPr[] = [];
  for (const other of [...numbers].sort((a, b) => a - b)) {
    const read = await deployedPr(deps.gh, other);
    if ("why" in read) return read;
    otherPrs.push(read);
  }
  let sentry: { health: GatheredHealth; traffic: GatheredTraffic };
  try {
    sentry = await deps.sentry.read({ deployedAt: watch.deployedAt, now, routes: pr.routes });
  } catch (error) {
    // The reader should not throw; if it does, that is an unreachable Sentry,
    // which the session decides "inconclusive" on, not a lost check-in.
    const why = `reading Sentry failed: ${firstLine((error as Error)?.message ?? String(error))}`;
    sentry = { health: { reachable: false, issues: [], why }, traffic: { reachable: false, hits: 0, why } };
  }
  return { gatheredAt: now.toISOString(), health: sentry.health, traffic: sentry.traffic, pr, otherPrs };
}

async function deployedPr(gh: Gh, number: number): Promise<DeployedPr | { why: string }> {
  const ran = await gh(["pr", "view", String(number), "--json", "files", "--jq", ".files[].path"]);
  if (!ran.ok) return { why: `could not read PR #${number}'s changed files: ${firstLine(ran.stderr.trim()) || "gh pr view failed"}` };
  const files = ran.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return { number, files, routes: routesFromFiles(files) };
}

/**
 * Drop this holder's lease, so the check-in is not fenced for a lease's worth
 * of polls. Only its own: a lease already retaken by another holder stays.
 * A failure here is left to the lease's expiry.
 */
async function release(deps: PollDeps, key: string): Promise<void> {
  try {
    await withStore(deps.storePath, (store) => {
      const lease = store.leases[key];
      if (lease !== undefined && lease.run === deps.holder.run && lease.loop === deps.holder.loop) delete store.leases[key];
    });
  } catch {}
}

const firstLine = (text: string): string => text.split("\n")[0] ?? "";

/* --------------------------------------------------------------------------
 * CLI.
 * ----------------------------------------------------------------------- */

const PREFIX = "verifier-gate";

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
export const DEFAULT_POLL_SECONDS = roleDescriptor("verifier").pollSeconds;

export function pollSeconds(argv: string | undefined): number {
  if (argv !== undefined && /^\d+$/.test(argv) && Number(argv) >= 1) return Number(argv);
  return DEFAULT_POLL_SECONDS;
}

/** The real `gh`, run in the project, bounded so a hung call is a failed read rather than a hung gate. */
export function ghIn(root: string, timeoutMs = 60_000): Gh {
  return (args) =>
    new Promise((resolve) => {
      execFile("gh", args, { cwd: root, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ ok: error === null, stdout: String(stdout), stderr: String(stderr || (error?.message ?? "")) });
      });
    });
}

/**
 * The tracker adapter's `gh`: bounded like {@link ghIn}, but rejecting on a
 * failure, as the adapter expects of its runner, with the stdout its
 * rate-limit classifier reads.
 */
export function boundedGh(root: string, timeoutMs = 60_000): (args: string[]) => Promise<string> {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile("gh", args, { cwd: root, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new CommandError(`gh ${args.join(" ")} failed: ${String(stderr) || error.message}`, String(stdout)));
        else resolve(String(stdout));
      });
    });
}

/** Overridable so a spawned gate test can answer for Vercel locally. */
export const VERCEL_API_ENV = "RALPH_VERIFIER_VERCEL_API";

/** Overridable so a spawned gate test can answer for Sentry locally. */
export const SENTRY_API_ENV = "RALPH_VERIFIER_SENTRY_API";

/**
 * The ui-shots test account's email, which the Sentry reads exclude so the
 * verifier's own probes never count as traffic or impact. Only that key is
 * read, and the file is never printed; a missing or unreadable file is null.
 */
function shotsEmail(root: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const email = parseEnvFile(readFileSync(credentialPath(currentProjectId(root, env), env), "utf8")).SHOTS_EMAIL?.trim();
    return email ? email : null;
  } catch {
    return null;
  }
}

/**
 * The project's verifier rules and the real reads. The rules are loaded
 * strictly, as the clerk's gate loads its own: the validator is what refuses
 * a verifier with no production URL or no deploy source, and a gate that
 * guessed either would verify the wrong product. A throw here is exit 2,
 * which the supervisor retries and then stops on with the reason logged. A
 * missing token is not a throw: it is the poll's reason, every poll, until
 * the token is stored. A missing Sentry token is not one either: every read
 * then answers unreachable, and the session records "inconclusive".
 *
 * `config` is the one to wire from: the freshest the gate has (#788), read
 * from origin by `live-rules.ts`; the worktree's when none is given. The
 * gate wires again from a new config when its verifier rules change, so a
 * new deploy source or Sentry project takes effect on the next poll as the
 * mode does.
 */
function wire(root: string, env: NodeJS.ProcessEnv = process.env, config: ProjectConfig = loadProjectConfig(root)): PollDeps {
  const rules = verifierRules(config);
  if (rules === null) throw new Error("verifier-gate: the project's .ralph/config.json has no 'verifier' block");
  const gh = ghIn(root);
  let landed: PollDeps["landed"];
  if (rules.deploy.source === "github-deployments") {
    // No token: the deployments are read through gh's own credential, bounded like every other gh read.
    landed = { read: githubLandedDeploy(rules.deploy, gh, ghContains(gh)) };
  } else {
    const token = env[VERCEL_TOKEN_ENV]?.trim() ?? "";
    landed = token === ""
      ? { read: null, why: `no Vercel token — ${VERCEL_TOKEN_ENV} is not set, so no deploy can be confirmed` }
      : { read: vercelLandedDeploy(rules.deploy, token, fetch, ghContains(gh), env[VERCEL_API_ENV]?.trim() || undefined) };
  }
  const sentryQuery = {
    org: rules.sentry.org,
    project: rules.sentry.project,
    token: env[SENTRY_TOKEN_ENV]?.trim() ?? "",
    excludeEmail: shotsEmail(root, env),
    fetcher: fetch,
    apiBase: env[SENTRY_API_ENV]?.trim() || undefined,
  };
  let reporter: PollDeps["reporter"];
  try {
    // An unconnected Linear or Jira is not a wire failure: observe needs no
    // tracker at all, and report mode says why it wrote nothing, every poll.
    // GitHub's adapter gets a bounded `gh`, so a hung call fails rather than hangs.
    const tracker = createTracker(config, { projectId: currentProjectId(root, env), github: { gh: boundedGh(root) } });
    reporter = { tracker, push: (input) => push(root, input) };
  } catch (error) {
    reporter = { tracker: null, why: firstLine((error as Error)?.message ?? String(error)) };
  }
  const baseBranch = env.RALPH_BASE_BRANCH?.trim() || config.baseBranch;
  return {
    rules,
    gh,
    landed,
    reporter,
    act: {
      gh,
      git: realGit,
      repoRoot: root,
      baseBranch,
      merge: config.merge,
      mergeCommand: rules.mergeCommand,
      requiredChecks: config.requiredChecks,
    },
    repoSlug: `${config.owner}/${config.repo}`,
    storePath: storePathFromGit(root),
    now: () => new Date(),
    baseBranch,
    tracker: config.tracker,
    roster: config.roster,
    holder: { run: env.RALPH_RUN_ID || "manual", loop: env.RALPH_LOOP_NAME || "verifier" },
    sentry: {
      read: async ({ deployedAt, now, routes }) => {
        const [health, traffic] = await Promise.all([
          readHealth({ ...sentryQuery, deployedAt, now }),
          readTraffic({ ...sentryQuery, deployedAt, now, routes }),
        ]);
        return { health, traffic };
      },
    },
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
  const start = freshestConfig(root, "verifier");
  let deps = wire(root, process.env, start.config);
  const interval = pollSeconds(argv.find((arg) => !arg.startsWith("--")));
  // Every poll reads the rules from origin first (#788): a merged change
  // applies on the next poll, and one that does not validate is ignored.
  const live = createLiveRules({
    root,
    role: "verifier",
    baseBranch: deps.baseBranch,
    extract: verifierRules,
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
    // No sleep here: the supervisor re-reads its unread secrets (#759), then runs the gate again.
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
