/**
 * Eval test set suggestions (#858): which merged PRs the loops struggled on,
 * ranked, so an operator curating the test set (#853) starts from the cases
 * most worth freezing rather than from a list of every merge.
 *
 * `rankSuggestions` is pure — every signal and every clock reading comes in on
 * its input — so the ranking is the same on every host and in every test.
 * `readSuggestSignals` is the real I/O around it (git, gh, the tracker, the
 * park store, the journal and the speed ledger); `gatherSignals` only wraps
 * the injected reads so each source is read on its own, and one that cannot be
 * read degrades to a named entry in `missing` instead of failing the screen,
 * so a down tracker still leaves a useful ranking.
 */
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { isLoopPr } from "./backtest";
import { spawnGh } from "./clerk/pulls";
import { stuckLabelFor } from "./frontier/next-tasks";
import { harnessJournalReader } from "./observe";
import { configuredParkStorePath, listStore } from "./park-store";
import { loadProjectConfig } from "./project-config";
import { currentProjectId } from "./project-id";
import { measureSpeed, readSpeedLedger, speedDir, type SpeedEvent } from "./speed";
import { createTracker } from "./tracker/index";
import type { Tracker } from "./tracker/types";

/** A merged PR as `gh pr list --state merged` reports it. */
export interface MergedPr {
  number: number;
  title: string;
  url: string;
  mergedAt: string;
  body: string;
  headRefName: string;
  /**
   * Submitted reviews on it (any state) by someone other than the PR's
   * author — the review rounds signal. A reply to a review thread is itself a
   * COMMENTED review by the replier, and the loop that replies is the author,
   * so counting every review would score a loop's own replies as rounds.
   */
  reviews: number;
  /** Issue numbers the PR closes (GitHub's closingIssuesReferences), may be empty. */
  closes: number[];
}

/** A signal source's read: its value, or why it could not be read. */
export type Source<T> = { ok: true; value: T } | { ok: false; why: string };
export type SignalSource = "pulls" | "tracker" | "parks" | "journal" | "speed";

export type SuggestionSignal = "blocked" | "parked" | "reverted" | "reviewRounds" | "doctor" | "slow" | "finishedByPerson";

export interface SuggestionWeights {
  blocked: number;
  parked: number;
  reverted: number;
  /** Weight per review round past `reviewRoundsThreshold`, capped at three rounds' worth. */
  reviewRounds: number;
  doctor: number;
  /** Weight per multiple of `slowHours` the slowest episode took, capped at three. */
  slow: number;
  finishedByPerson: number;
  /** More reviews than this is a struggle; up to it is an ordinary review. */
  reviewRoundsThreshold: number;
  /** A claim-to-hand-off longer than this many hours is slow. */
  slowHours: number;
}

/**
 * A revert or a block is the loudest evidence a PR was hard; review rounds and
 * a slow episode happen to ordinary work too, so they weigh least.
 */
export const DEFAULT_SUGGESTION_WEIGHTS: SuggestionWeights = {
  blocked: 5,
  parked: 4,
  reverted: 6,
  reviewRounds: 2,
  doctor: 3,
  slow: 2,
  finishedByPerson: 4,
  reviewRoundsThreshold: 2,
  slowHours: 24,
};

export const DEFAULT_SUGGESTION_LIMIT = 50;

export interface JournalEntry {
  name: string;
  body: string;
}

export interface BlockedEntry {
  ticket: number;
  loop: string;
}

export interface SuggestionInput {
  /** owner/name of the repository the PRs were merged into. */
  repo: string;
  pulls: Source<MergedPr[]>;
  /** Every case in the set — active, saturated and retired: a PR already curated is never suggested again. */
  held: readonly { repo: string; prs: readonly number[] }[];
  /** The roster's loop names. */
  loops: readonly string[];
  /** Roster names whose role is ci-doctor or pr-medic. */
  doctors: readonly string[];
  /** Tickets (open or closed) that carry `<loop>-blocked` now; a label since removed is not seen. */
  blocked: Source<readonly BlockedEntry[]>;
  /** Tickets parked now (park store). */
  parked: Source<readonly number[]>;
  journal: Source<readonly JournalEntry[]>;
  speed: Source<readonly SpeedEvent[]>;
  /**
   * The project the ranking is for. The speed ledger lives in the git common
   * dir and is shared by every project on it, so when this is set only events
   * whose `project` equals it count; null uses every event.
   */
  projectId: string | null;
  /**
   * Whether `MergedPr.closes` numbers are this project's ticket numbers (default
   * true). They are GitHub issue numbers, so on a Linear or Jira project they
   * would collide with unrelated tickets and must be ignored for linking.
   */
  closesAreTickets?: boolean;
  /** At most this many suggestions (default 50). */
  limit?: number;
}

export interface Suggestion {
  repo: string;
  pr: number;
  title: string;
  url: string;
  mergedAt: string;
  tickets: number[];
  score: number;
  reasons: { signal: SuggestionSignal; text: string }[];
}

export interface SuggestionsResult {
  /** Score desc, then mergedAt desc, then pr desc — deterministic. */
  suggestions: Suggestion[];
  /** Every source that could not be read. */
  missing: { source: SignalSource; why: string }[];
}

/** `#12`, `12` or a bare number to 12; anything else (a keyed ticket like `OA-12`) to null. */
function ticketNumber(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value !== "string") return null;
  const match = /^#?(\d+)$/.exec(value.trim());
  return match ? Number(match[1]) : null;
}

/**
 * A speed event's `pr` (a PR URL, or `#12`/`12`) to its number, or null.
 * A URL into another repository is null: its number would collide with ours.
 */
function prNumber(value: string | null | undefined, repo: string): number | null {
  if (typeof value !== "string") return null;
  const url = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i.exec(value);
  if (url) return url[1]!.toLowerCase() === repo.toLowerCase() ? Number(url[2]) : null;
  return ticketNumber(value);
}

const valueOf = <T>(source: Source<T>): T | null => (source.ok ? source.value : null);

/**
 * The PR numbers a merged PR reverts. GitHub's `Reverts [o/n]#n` body line
 * names the target exactly, so it wins; the `Revert "<title>"` title is only a
 * fallback for a revert without that line, and only matches PRs merged before
 * the revert — a re-land with the same title, merged after, was not reverted.
 */
function revertedBy(revert: MergedPr, pulls: readonly MergedPr[], repo: string): number[] {
  const out = new Set<number>();
  const line = new RegExp(`^\\s*Reverts\\s+(?:([\\w.-]+/[\\w.-]+))?#(\\d+)(?!\\d)`, "gim");
  let named = false;
  for (const match of revert.body.matchAll(line)) {
    named = true;
    if (match[1] !== undefined && match[1].toLowerCase() !== repo.toLowerCase()) continue;
    const n = Number(match[2]);
    if (n !== revert.number) out.add(n);
  }
  if (named) return [...out];
  const title = /^Revert "(.*)"$/.exec(revert.title.trim());
  if (title) {
    for (const pr of pulls) {
      if (pr.number !== revert.number && pr.title === title[1] && pr.mergedAt < revert.mergedAt) out.add(pr.number);
    }
  }
  return [...out];
}

/**
 * Who signed a journal entry. Coders write `Loop: **name**`; the doctors'
 * entries write `- **Loop:** name` or a bare `loop: name` line.
 */
function journalOwner(body: string): string | null {
  const found = /Loop: \*\*([^*\n]+)\*\*/.exec(body) ?? /\*\*Loop:\*\*\s*`?([a-z][a-z0-9]*)/i.exec(body) ?? /^\s*[-*]?\s*loop:\s*`?([a-z][a-z0-9]*)/im.exec(body);
  return found?.[1]?.trim() ?? null;
}

const hours = (seconds: number): number => Math.round(seconds / 3600);

const listTickets = (tickets: readonly number[]): string => tickets.map((t) => `#${t}`).join(", ");

export function rankSuggestions(input: SuggestionInput, weights: Partial<SuggestionWeights> = {}): SuggestionsResult {
  const w: SuggestionWeights = { ...DEFAULT_SUGGESTION_WEIGHTS, ...weights };
  const missing: SuggestionsResult["missing"] = [];
  const sources: [SignalSource, Source<unknown>][] = [
    ["pulls", input.pulls],
    ["tracker", input.blocked],
    ["parks", input.parked],
    ["journal", input.journal],
    ["speed", input.speed],
  ];
  for (const [source, read] of sources) if (!read.ok) missing.push({ source, why: read.why });
  if (!input.pulls.ok) return { suggestions: [], missing };

  const pulls = input.pulls.value;
  const repoKey = input.repo.toLowerCase();
  const held = new Set<number>();
  for (const entry of input.held) if (entry.repo.toLowerCase() === repoKey) for (const pr of entry.prs) held.add(pr);

  const blocked = valueOf(input.blocked);
  const parkedNow = valueOf(input.parked);
  const parkedSet = parkedNow === null ? null : new Set(parkedNow);
  const journal = valueOf(input.journal);
  const allEvents = valueOf(input.speed);
  const projectId = input.projectId;
  const events = allEvents === null || projectId === null ? allEvents : allEvents.filter((event) => event.project === projectId);
  const measured = events === null ? [] : measureSpeed(events).measured;
  const doctors = new Set(input.doctors.map((name) => name.toLowerCase()));

  // Revert detection runs over the whole list once: a revert names its target.
  const reverts = new Map<number, number[]>();
  for (const pr of pulls) {
    for (const target of revertedBy(pr, pulls, input.repo)) reverts.set(target, [...(reverts.get(target) ?? []), pr.number]);
  }

  const suggestions: Suggestion[] = [];
  for (const pr of pulls) {
    if (held.has(pr.number)) continue;
    // A PR's tickets: those it closes, plus those the speed ledger handed off as this PR.
    const tickets = new Set(input.closesAreTickets ?? true ? pr.closes : []);
    for (const event of events ?? []) {
      if (prNumber(event.pr, input.repo) !== pr.number) continue;
      const ticket = ticketNumber(event.ticket);
      if (ticket !== null) tickets.add(ticket);
    }
    const linked = [...tickets].sort((a, b) => a - b);
    const reasons: Suggestion["reasons"] = [];
    let score = 0;
    const add = (signal: SuggestionSignal, text: string, weight: number): void => {
      reasons.push({ signal, text });
      score += weight;
    };

    if (blocked !== null) {
      const hits = blocked.filter((entry) => tickets.has(entry.ticket));
      if (hits.length > 0) {
        const byTicket = new Map<number, Set<string>>();
        for (const hit of hits) byTicket.set(hit.ticket, (byTicket.get(hit.ticket) ?? new Set()).add(hit.loop));
        const parts = [...byTicket.entries()].sort(([a], [b]) => a - b).map(([ticket, loops]) => `blocked by ${[...loops].sort().join(", ")} on #${ticket}`);
        add("blocked", parts.join("; "), w.blocked);
      }
    }

    {
      const parkedHere = parkedSet === null ? [] : linked.filter((t) => parkedSet.has(t));
      const ledgerBlocked = linked.filter((t) => (events ?? []).some((e) => e.kind === "blocked" && ticketNumber(e.ticket) === t));
      const parts: string[] = [];
      if (parkedHere.length > 0) parts.push(`${listTickets(parkedHere)} parked now`);
      const onlyLedger = ledgerBlocked.filter((t) => !parkedHere.includes(t));
      if (onlyLedger.length > 0) parts.push(`the speed ledger records ${listTickets(onlyLedger)} blocked`);
      if (parts.length > 0) add("parked", parts.join("; "), w.parked);
    }

    const revertedIn = reverts.get(pr.number);
    if (revertedIn !== undefined) add("reverted", `reverted by ${listTickets(revertedIn.sort((a, b) => a - b))}`, w.reverted);

    if (pr.reviews > w.reviewRoundsThreshold) {
      const past = Math.min(3, pr.reviews - w.reviewRoundsThreshold);
      add("reviewRounds", `${pr.reviews} review rounds`, w.reviewRounds * past);
    }

    if (journal !== null) {
      // A heuristic: a doctor's journal entry that mentions the PR is taken to
      // be about it, though it may only cite it in passing.
      const mention = new RegExp(`#${pr.number}(?!\\d)`);
      const loopsSeen = new Set<string>();
      let hit = false;
      for (const entry of journal) {
        const owner = journalOwner(entry.body);
        const isDoctor = (owner !== null && doctors.has(owner.toLowerCase())) || entry.body.includes("**Case:**");
        if (!isDoctor || !mention.test(entry.body)) continue;
        hit = true;
        if (owner !== null) loopsSeen.add(owner);
      }
      if (hit) {
        const who = loopsSeen.size > 0 ? ` by ${[...loopsSeen].sort().join(", ")}` : "";
        add("doctor", `a doctor worked on it${who}`, w.doctor);
      }
    }

    {
      let slowest = 0;
      for (const m of measured) {
        const ticket = ticketNumber(m.ticket);
        if ((ticket !== null && tickets.has(ticket)) || prNumber(m.pr, input.repo) === pr.number) {
          slowest = Math.max(slowest, m.claimToHandoffSeconds);
        }
      }
      const limit = w.slowHours * 3600;
      if (slowest > limit) add("slow", `${hours(slowest)}h from claim to hand-off`, w.slow * Math.min(3, slowest / limit));
    }

    // Without a roster nothing tells a loop PR from a person's: every PR would
    // read as a person's, so the signal is skipped rather than guessed.
    if (input.loops.length > 0 && !isLoopPr(pr, input.loops)) {
      const claimers = new Set<string>();
      for (const event of events ?? []) {
        const ticket = ticketNumber(event.ticket);
        if (event.kind === "claimed" && ticket !== null && tickets.has(ticket)) claimers.add(event.loop);
      }
      for (const entry of blocked ?? []) if (tickets.has(entry.ticket)) claimers.add(entry.loop);
      if (claimers.size > 0) add("finishedByPerson", `finished by a person after ${[...claimers].sort().join(", ")} claimed it`, w.finishedByPerson);
    }

    if (reasons.length === 0) continue;
    // One decimal: the slow signal is fractional, and the screen shows the score.
    const rounded = Math.round(score * 10) / 10;
    suggestions.push({ repo: input.repo, pr: pr.number, title: pr.title, url: pr.url, mergedAt: pr.mergedAt, tickets: linked, score: rounded, reasons });
  }

  suggestions.sort((a, b) => b.score - a.score || (a.mergedAt < b.mergedAt ? 1 : a.mergedAt > b.mergedAt ? -1 : 0) || b.pr - a.pr);
  return { suggestions: suggestions.slice(0, Math.max(0, input.limit ?? DEFAULT_SUGGESTION_LIMIT)), missing };
}

export interface GatherDeps {
  /** Null when no tracker could be built: `blocked` is then `{ok: false}` with `trackerWhy`. */
  tracker: Tracker | null;
  trackerWhy?: string;
  loops: readonly string[];
  parked(): readonly number[];
  journal(): readonly JournalEntry[];
  speed(): readonly SpeedEvent[];
  /**
   * Give up on the blocked read after this long. A rate-limited tracker retries
   * for minutes, and the dashboard kills the CLI at 120 s: a late tracker must
   * cost its own source, not the whole ranking.
   */
  trackerDeadlineMs?: number;
}

export type GatheredSignals = Omit<SuggestionInput, "repo" | "pulls" | "held" | "loops" | "doctors" | "projectId" | "closesAreTickets">;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function read<T>(fn: () => T): Source<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, why: message(error) };
  }
}

async function readBlocked(tracker: Tracker, loops: readonly string[]): Promise<Source<readonly BlockedEntry[]>> {
  try {
    // In parallel, so the deadline covers one round trip rather than one per
    // roster entry: read in turn, a slow tracker passed it on a long roster.
    const lists = await Promise.all(loops.map(async (loop) => (await tracker.withLabel(stuckLabelFor(loop), { state: "all" })).map((issue) => ({ ticket: issue.number, loop }))));
    return { ok: true, value: lists.flat() };
  } catch (error) {
    return { ok: false, why: message(error) };
  }
}

/** `read`, or a named failure once `ms` has passed; the timer never holds the process open. */
async function withDeadline<T>(read: Promise<Source<T>>, ms: number | undefined): Promise<Source<T>> {
  if (ms === undefined) return read;
  // readBlocked never rejects, but an abandoned promise must not surface as
  // an unhandled rejection whatever it does after the deadline.
  read.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Source<T>>((resolve) => {
    const said = ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
    timer = setTimeout(() => resolve({ ok: false, why: `the tracker did not answer within ${said}` }), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([read, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Every source read independently: one failure never fails the others, and this never throws. */
export async function gatherSignals(deps: GatherDeps): Promise<GatheredSignals> {
  const blocked: Source<readonly BlockedEntry[]> =
    deps.tracker === null
      ? { ok: false, why: deps.trackerWhy ?? "no tracker" }
      : await withDeadline(readBlocked(deps.tracker, deps.loops), deps.trackerDeadlineMs);
  return { blocked, parked: read(deps.parked), journal: read(deps.journal), speed: read(deps.speed) };
}

/** What `evals-set.ts suggest` ranks: every signal but the held set, which the caller reads. */
export interface SuggestSignals extends GatheredSignals {
  /** owner/name of the project's GitHub origin, or null when it has none. */
  repo: string | null;
  pulls: Source<MergedPr[]>;
  loops: string[];
  doctors: string[];
  weights: Partial<SuggestionWeights>;
  /** The project id speed events are filtered to, or null when it cannot be told. */
  projectId: string | null;
  /** False on a Linear or Jira tracker, where GitHub's closing references are not ticket numbers. */
  closesAreTickets: boolean;
}

const DOCTOR_ROLES = new Set(["ci-doctor", "pr-medic"]);

/** `git@github.com:o/n.git` or `https://github.com/o/n` to `o/n`; anything not on GitHub to null. */
export function githubRepoFromRemote(url: string): string | null {
  const match = /github\.com[/:]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

function originRepo(projectPath: string): string | null {
  const result = spawnSync("git", ["-C", projectPath, "remote", "get-url", "origin"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return result.status === 0 ? githubRepoFromRemote(result.stdout ?? "") : null;
}

interface GhMergedPr {
  number: number;
  title: string;
  url: string;
  mergedAt: string | null;
  body: string | null;
  headRefName: string;
  author: { login?: string | null } | null;
  reviews: { author?: { login?: string | null } | null }[] | null;
  closingIssuesReferences: { number: number }[] | null;
}

/** Reviews by someone other than the PR's author; a review with no author counts. */
export function reviewsByOthers(row: Pick<GhMergedPr, "author" | "reviews">): number {
  if (!Array.isArray(row.reviews)) return 0;
  const author = row.author?.login?.toLowerCase() ?? null;
  return row.reviews.filter((review) => {
    const login = review?.author?.login?.toLowerCase() ?? null;
    return author === null || login === null || login !== author;
  }).length;
}

async function mergedPulls(repo: string): Promise<Source<MergedPr[]>> {
  try {
    const text = await spawnGh([
      "pr", "list", "--repo", repo, "--state", "merged", "--limit", "200",
      "--json", "number,title,url,mergedAt,body,headRefName,author,reviews,closingIssuesReferences",
    ]);
    const rows = JSON.parse(text) as GhMergedPr[];
    if (!Array.isArray(rows)) throw new Error("gh pr list did not answer a list");
    return {
      ok: true,
      value: rows.map((row) => ({
        number: row.number, title: row.title, url: row.url, mergedAt: row.mergedAt ?? "", body: row.body ?? "", headRefName: row.headRefName,
        reviews: reviewsByOthers(row),
        closes: (row.closingIssuesReferences ?? []).map((ref) => ref.number).filter((n) => Number.isSafeInteger(n)),
      })),
    };
  } catch (error) {
    return { ok: false, why: message(error) };
  }
}

/** The speed ledger; a directory not created yet is an empty ledger, one that cannot be listed is a failure. */
function readSpeedEvents(projectPath: string): readonly SpeedEvent[] {
  const dir = speedDir(process.env, projectPath);
  // readSpeedLedger reads an unlistable directory as empty, which would hide
  // a broken ledger as "no slow work"; probe it so it reads as missing.
  if (existsSync(dir)) readdirSync(dir);
  return readSpeedLedger(dir).events;
}

/**
 * Every source the ranker reads for the project at `projectPath`, each on its
 * own: a failure becomes that source's `{ok: false}` (or an empty roster, which
 * the tracker source then reports), and this never throws.
 */
export async function readSuggestSignals(projectPath: string): Promise<SuggestSignals> {
  const repo = originRepo(projectPath);
  const noRepo: Source<never> = { ok: false, why: "the project has no GitHub origin" };
  let projectId: string | null = null;
  let projectIdWhy = "";
  try {
    projectId = currentProjectId(projectPath);
  } catch (error) {
    // An unnamed project still ranks; its speed events are then not filtered.
    projectIdWhy = message(error);
  }
  if (repo === null) {
    // Nothing to rank without merged PRs: skip the tracker and gh calls the caller would throw away.
    return { repo, pulls: noRepo, loops: [], doctors: [], weights: {}, projectId, closesAreTickets: true, blocked: noRepo, parked: noRepo, journal: noRepo, speed: noRepo };
  }
  // Started now, not after the tracker: a slow tracker read must not eat the time gh needs.
  const pulls = mergedPulls(repo);
  let loops: string[] = [];
  let doctors: string[] = [];
  let weights: Partial<SuggestionWeights> = {};
  let tracker: Tracker | null = null;
  let trackerWhy = "";
  let closesAreTickets = true;
  try {
    const config = loadProjectConfig(projectPath);
    loops = config.roster.map((entry) => entry.name);
    doctors = config.roster.filter((entry) => DOCTOR_ROLES.has(entry.role)).map((entry) => entry.name);
    weights = config.evalSuggestionWeights ?? {};
    closesAreTickets = config.tracker.kind === "github";
    if (projectId === null) throw new Error(projectIdWhy);
    tracker = createTracker(config, { projectId });
  } catch (error) {
    trackerWhy = message(error);
  }
  const [gathered, merged] = await Promise.all([
    gatherSignals({
      tracker, trackerWhy, loops, trackerDeadlineMs: 45_000,
      parked: () => listStore(configuredParkStorePath(process.env, projectPath)).map((park) => park.ticket).filter((t) => Number.isSafeInteger(t)),
      journal: harnessJournalReader(projectPath, undefined, process.env, { strict: true }),
      speed: () => readSpeedEvents(projectPath),
    }),
    pulls,
  ]);
  return { ...gathered, repo, pulls: merged, loops, doctors, weights, projectId, closesAreTickets };
}
