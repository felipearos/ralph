#!/usr/bin/env bun
/**
 * The case's `ci-health` issue: found or created, then claimed (#159).
 *
 * Before the doctor fixes or reverts anything it needs an ordinary claimed
 * ticket to do it on, so that its work is visible to a human in the same place
 * every other loop's work is, and so that coders never see it as available.
 * This module is that step: the find-or-create, the claim, the hand-off a
 * failed fix ends in, the three store writes those leave behind, and the CLI
 * (`ensure` / `file` / `fix-failed`) the doctor's prompt runs. Everything that
 * reaches GitHub, the claim or the lease arrives as an injected function, so
 * the tests are about the decisions rather than about `gh`.
 *
 * **The identity of a filing lives on GitHub, in the issue body.**
 * `ci-doctor/store.ts` says of itself that it is a cache — "deleted or
 * unreadable, it starts empty" (`store.ts:7-12`) — so `Case.issue` cannot be
 * what tells a second `ensure` that the issue already exists. A body marker
 * can: it survives a lost store, a different worktree and a different host,
 * which is the same reason `triage/body.ts:73-78` puts the triager's op id
 * there. AC 2's "including after the store is deleted" is exactly this choice
 * being tested.
 *
 * The marker carries a HASH of the case key as well as the key itself, and the
 * hash is what is searched and compared. A case key is a test id, and test ids
 * contain `"`, `:`, `/` and `>` — punctuation that makes a quoted search
 * phrase unreliable and an unescaped `case="<key>"` ambiguous. The hash is
 * `[a-f0-9]{16}`, which searches exactly; the readable key stays in the marker
 * for the human who opens the issue, and is never parsed back out — a key with
 * a `"` in it could not be.
 *
 * #159's acceptance criteria live here: the label sets that decide whether a
 * coder's frontier offers an issue (AC 1), the marker dedupe (AC 2), the raced
 * filing (AC 3), and the hand-off a second failed fix does instead of blocking
 * (AC 4).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  CLAIM_REFUSED_EXIT,
  leasePathFromGit,
  readLeaseStore,
  releaseLease,
  withLeaseStoreLock,
  writeLeaseStore,
} from "../claim-lease";
import { isRateLimited, RATE_LIMITED_EXIT } from "../frontier/github-rate-limit";
import { projectRoot } from "../paths";

import { takeCaseLease } from "./case-lease";
import { CHECK_CASE_PREFIX } from "./classify";
import { write } from "./gh";
import type { Gh, Ran } from "./gate";
import { readStore, storePathFromGit, subjectOf, withStore, type Case, type CiHealthStore } from "./store";

/** The registry label every case issue carries — the list the gate reads. */
export const CASE_LABEL = "ci-health";

/**
 * What a doctor's OWN case issue is created with.
 *
 * Deliberately no `ready-for-agent` and deliberately no `<loop>-wip`. Absent
 * `ready-for-agent` is the whole of the coder fence — eligibility requires it
 * (`frontier/next-tasks.ts:820-824`) — and a `-wip` written at create time
 * would make the claim that follows refuse the doctor's own issue, because
 * `loopClaimObstruction` (`frontier/next-tasks.ts:2630-2642`) forbids EVERY
 * roster claim label including the asking loop's. #159's prose asks for the
 * label at creation; the claim it asks for in the next breath is what rules it
 * out, and the claim is the one that leaves a lease behind.
 */
export const DOCTOR_CASE_LABELS: readonly string[] = [CASE_LABEL];

/**
 * What an issue FILED FOR CODERS carries: out-of-scope work, E2E, PR-specific
 * failures, forward fixes and urgent regressions. The doctor never claims one.
 */
export const CODER_FILING_LABELS: readonly string[] = [CASE_LABEL, "ready-for-agent", "bug"];

/** How many of its own failed fixes a doctor gets before the coders take over. */
export const MAX_FIX_ATTEMPTS = 2;

/** The searchable half of the marker: punctuation-free, so a search for it cannot under-return. */
export const caseToken = (key: string): string =>
  `ci-doctor-case-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;

/** `<!-- ci-doctor case="flake:src/a.test.ts > flaps" id=ci-doctor-case-0f… -->` */
export const caseMarker = (key: string): string => `<!-- ci-doctor case="${key}" id=${caseToken(key)} -->`;

/** Whether a body is this case's. The HASH decides; the readable key may contain anything. */
export const carriesCaseMarker = (body: string, key: string): boolean => body.includes(caseToken(key));

/**
 * WHICH of a case's keys the body carries, or null for none of them.
 *
 * There is more than one only after a #237 rekey: the case key changed, and the
 * marker on GitHub still names the key the issue was filed under
 * (`Case.filedAs`). The current key is tried first, so a re-stamped body is
 * recognised as itself and no second edit follows.
 */
export const markerKeyOf = (body: string, keys: readonly string[]): string | null =>
  keys.find((key) => carriesCaseMarker(body, key)) ?? null;

/** The body as it is filed: the marker first, so a truncated read still shows it. */
export const issueBodyWithCaseMarker = (body: string, key: string): string => `${caseMarker(key)}\n\n${body}`;

export interface CaseIssueIo {
  gh: Gh;
  /** `claim-lease.ts claim <n> --label <l>`, injected to stay out of the frontier's import cycle. */
  claim: (issue: number, label: string) => Promise<{ claimed: boolean; refusal: string | null }>;
  /**
   * `takeCaseLease` on the case key, which is what makes two doctors filing
   * the same case end with ONE issue (AC 3).
   *
   * The marker search cannot do that on its own: both doctors would read an
   * empty registry and both create. The lease can, because it decides inside
   * the store's lock — and the store is in Git's COMMON directory, so every
   * WORKTREE of the project shares it. Two doctors on two clones share
   * nothing, which is the residual exposure and matches what the project plans
   * for: "a project runs one doctor by design" (`store.ts:213-214`). Taking
   * the lease again from the iteration is free for the doctor that already
   * holds it — `free()` treats its own run's lease as available.
   */
  lease: (key: string) => Promise<{ taken: boolean; holder: string | null }>;
  /**
   * Drop this run's claim lease on an issue — what `claim-lease.ts release <n>`
   * does.
   *
   * The hand-off needs it and nothing else does. A lease goes only when its
   * run claims a different issue or releases it, and the supervisor's
   * heartbeat renews it meanwhile (`claim-lease.ts:232-236, 272-277`), so a
   * hand-off that only swapped the labels would leave the ticket visible in
   * READY — `isClaimed` reads the label, which is now gone — and refused to
   * every coder that tried to claim it, for the rest of the doctor's run.
   */
  release: (issue: number) => Promise<{ released: boolean }>;
}

export interface FoundIssue {
  number: number;
  state: string;
  labels: string[];
  /**
   * The case key whose marker the body actually carries, and the body it was
   * read from — both only so `ensureCaseIssue` can re-stamp an issue found
   * under a rekeyed case's OLD key (#237). Equal to the asked key in every
   * other case, which is every case that was never rekeyed.
   */
  markerKey?: string;
  body?: string;
}

interface SearchRow {
  number?: unknown;
  state?: unknown;
  body?: unknown;
  labels?: unknown;
}

/** A read's three answers. `null` is "there is no such issue"; `unreadable` is "could not tell". */
export type Lookup = FoundIssue | null | "unreadable";

const labelsOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .map((entry) => (entry as { name?: unknown } | null)?.name)
        .filter((name): name is string => typeof name === "string")
    : [];

function foundFrom(row: SearchRow, markerKey: string): FoundIssue | null {
  if (typeof row.number !== "number" || !Number.isInteger(row.number)) return null;
  return {
    number: row.number,
    state: typeof row.state === "string" ? row.state.toUpperCase() : "",
    labels: labelsOf(row.labels),
    markerKey,
    ...(typeof row.body === "string" ? { body: row.body } : {}),
  };
}

/**
 * The case's issue, by marker: `null` only when GitHub answered and had none.
 *
 * The distinction is the whole value of this function. A failed search that
 * read as "no issue exists" would file a duplicate on one 403, one secondary
 * throttle or one network blip — the outcome the marker exists to prevent — so
 * an unreadable answer is its own value and the callers refuse to create on it.
 *
 * The marker is re-checked locally against every row, because a search can
 * over-return and that must cost nothing.
 */
export async function findCaseIssue(key: string, io: Pick<CaseIssueIo, "gh">, also?: string | null): Promise<Lookup> {
  const keys = also && also !== key ? [key, also] : [key];
  // One search per token, the current key first: the old key's token is only
  // worth a second call when the current one found nothing, and the common
  // case — no rekey — makes none.
  for (const [index, candidate] of keys.entries()) {
    const found = await searchCaseIssue(candidate, keys, io);
    if (found !== null || index === keys.length - 1) return found;
  }
  return null;
}

async function searchCaseIssue(key: string, keys: readonly string[], io: Pick<CaseIssueIo, "gh">): Promise<Lookup> {
  const ran = await io.gh([
    "issue",
    "list",
    "--label",
    CASE_LABEL,
    "--state",
    "all",
    "--limit",
    "50",
    // The token, not the key: `[a-f0-9]{16}` searches exactly, where a key
    // full of `"`, `:`, `/` and `>` does not. Under-returning here is what
    // would file a duplicate; over-returning is free.
    "--search",
    `"${caseToken(key)}" in:body`,
    "--json",
    "number,state,labels,body",
  ]);
  if (!ran.ok) return "unreadable";
  let rows: SearchRow[];
  try {
    const parsed = JSON.parse(ran.stdout || "[]") as unknown;
    if (!Array.isArray(parsed)) return "unreadable";
    rows = parsed as SearchRow[];
  } catch {
    return "unreadable";
  }
  for (const candidate of rows) {
    if (typeof candidate.body !== "string") continue;
    const markerKey = markerKeyOf(candidate.body, keys);
    if (markerKey !== null) return foundFrom(candidate, markerKey);
  }
  return null;
}

/** One issue by number, when the marker still matches: the store's memory, verified. */
export async function readCaseIssue(
  issue: number,
  key: string,
  io: Pick<CaseIssueIo, "gh">,
  also?: string | null,
): Promise<Lookup> {
  const ran = await io.gh(["issue", "view", String(issue), "--json", "number,state,labels,body"]);
  // A number the cache remembers that cannot be read is not a verdict on the
  // case: the issue may have been deleted or transferred, and treating that as
  // "could not tell" would wedge the case for good — every `ensure` refusing
  // until a human edited the cache. The search below is the authority, and it
  // has its own unreadable answer.
  if (!ran.ok) return null;
  let row: SearchRow | null;
  try {
    row = JSON.parse(ran.stdout || "null") as SearchRow | null;
  } catch {
    return "unreadable";
  }
  if (row === null || typeof row.body !== "string") return "unreadable";
  const markerKey = markerKeyOf(row.body, also && also !== key ? [key, also] : [key]);
  return markerKey === null ? null : foundFrom(row, markerKey);
}

/** `gh issue create` prints the new issue's URL; the number is its last segment. `triage/apply.ts:366` is the other copy of this parse. */
export function issueNumberOf(stdout: string): number | null {
  const match = /\/(\d+)\s*$/.exec(stdout.trim());
  return match === null ? null : Number(match[1]);
}

export interface FileRequest {
  key: string;
  title: string;
  body: string;
  /**
   * The issue the store already remembers for this case (`cases[key].issue`),
   * consulted BEFORE the search.
   *
   * GitHub's issue index is not synchronous, so a second filing moments after
   * the first can search a body that is not indexed yet. The marker stays the
   * authority — a store that has forgotten, or never knew, falls straight
   * through to the search, which is what keeps AC 2 true after the store is
   * deleted.
   */
  known?: number | null;
  /**
   * The case key this issue's marker was filed under, when a #237 rekey moved
   * the case since (`Case.filedAs`). Looked up as well as `key`, and the body
   * re-stamped with `key`'s marker when it is what matched — after which the
   * store clears the field and GitHub carries the new identity alone.
   */
  filedAs?: string | null;
}

export interface EnsureRequest extends FileRequest {
  loop: string;
}

/** Why an `ensure` ended as it did. The CLI's exit code is a function of this and nothing else. */
export type EnsureKind = "claimed" | "held" | "unreadable" | "refused";

export interface EnsureResult {
  kind: EnsureKind;
  /**
   * Whether the issue's body was re-stamped with this case key's marker,
   * because it was found under the key a #237 rekey moved the case off. The
   * caller clears `Case.filedAs` on a true: GitHub now carries the current
   * identity, so the bridge has done its one job.
   */
  restamped?: boolean;
  /** Null when nothing was filed: the case lease went elsewhere, or GitHub could not be read. */
  issue: number | null;
  created: boolean;
  claimed: boolean;
  refusal: string | null;
}

/** The store's memory first, then the marker search. `unreadable` from either is fatal to the filing. */
async function lookUp(request: FileRequest, io: Pick<CaseIssueIo, "gh">): Promise<Lookup> {
  if (request.known !== undefined && request.known !== null) {
    const known = await readCaseIssue(request.known, request.key, io, request.filedAs);
    if (known !== null) return known;
  }
  return findCaseIssue(request.key, io, request.filedAs);
}

/**
 * The case's issue, claimed by this doctor.
 *
 * A refusal is a RESULT, not an exception: two doctors filing the same case
 * concurrently both arrive here, and the one that loses the case lease — or
 * the claim — is told so and goes and asks the gate for another case (AC 3).
 */
export async function ensureCaseIssue(request: EnsureRequest, io: CaseIssueIo): Promise<EnsureResult> {
  const wip = `${request.loop}-wip`;
  const lease = await io.lease(request.key);
  if (!lease.taken) {
    return {
      kind: "held",
      issue: null,
      created: false,
      claimed: false,
      refusal: `the case is held by ${lease.holder ?? "another doctor"}`,
    };
  }
  const existing = await lookUp(request, io);
  if (existing === "unreadable") {
    return {
      kind: "unreadable",
      issue: null,
      created: false,
      claimed: false,
      refusal: "GitHub could not be read for this case",
    };
  }
  if (existing !== null) {
    // The marker is the filing identity and `case-issue.ts` keeps it on GitHub
    // so AC 2 survives a lost store (`countFailedFix`). A rekeyed case breaks
    // that, because the body names the key it was filed under — so the body is
    // re-stamped here, ONCE, with the current key's marker. The old marker is
    // left in place: a doctor on an older deploy still has to find this issue,
    // and a second token costs the search nothing.
    const restamped = existing.markerKey !== undefined && existing.markerKey !== request.key;
    if (restamped) {
      await write(io, [
        "issue",
        "edit",
        String(existing.number),
        "--body",
        issueBodyWithCaseMarker(existing.body ?? "", request.key),
      ]);
    }
    // A case that recurs after its fix reopens its own issue rather than
    // filing a second one: the marker is that case's identity for good, and a
    // doctor claiming a CLOSED ticket would be working something no frontier,
    // no dashboard and no coder ever shows — `classify` reads open issues only.
    if (existing.state === "CLOSED") await write(io, ["issue", "reopen", String(existing.number)]);
    if (existing.labels.includes(wip)) {
      // Some `<loop>` run holds it, which is not quite the same as THIS run
      // holding it: a label left by a dead run is adopted here with no claim
      // lease of our own, so the heartbeat renews nothing for it. Going
      // through `io.claim` anyway is not an option — `loopClaimObstruction`
      // refuses the asking loop's own `-wip` too — and coders stay off it
      // either way, because `isClaimed` reads an absent lease as claimed.
      return { kind: "claimed", issue: existing.number, created: false, claimed: true, refusal: null, restamped };
    }
    const claim = await io.claim(existing.number, wip);
    return {
      kind: claim.claimed ? "claimed" : "refused",
      issue: existing.number,
      created: false,
      claimed: claim.claimed,
      refusal: claim.refusal,
      restamped,
    };
  }
  const args = ["issue", "create", "--title", request.title, "--body", issueBodyWithCaseMarker(request.body, request.key)];
  for (const label of DOCTOR_CASE_LABELS) args.push("--label", label);
  const ran = await write(io, args);
  const number = issueNumberOf(ran.stdout);
  if (number === null) throw new Error(`could not read the new issue number from ${ran.stdout.trim()}`);
  const claim = await io.claim(number, wip);
  return {
    kind: claim.claimed ? "claimed" : "refused",
    issue: number,
    created: true,
    claimed: claim.claimed,
    refusal: claim.refusal,
  };
}

/**
 * File the case for the coders and claim nothing.
 *
 * Out-of-scope work, E2E, PR-specific failures, forward fixes and urgent
 * regressions are a coder's ticket: the doctor's job there is to have written
 * the diagnosis down. This path takes no case lease, so the store's memory and
 * the marker are all that stand between a second filing and a duplicate.
 */
export async function fileForCoders(
  request: FileRequest & { loop?: string },
  io: Pick<CaseIssueIo, "gh" | "release">,
): Promise<{ issue: number | null; created: boolean; opened: boolean }> {
  const existing = await lookUp(request, io);
  if (existing === "unreadable") return { issue: null, created: false, opened: false };
  if (existing !== null) {
    // The same re-stamp `ensureCaseIssue` does, for the same reason (#237):
    // found under the key a rekey moved the case off, the body is given this
    // key's marker as well so the next search needs no store to find it.
    if (existing.markerKey !== undefined && existing.markerKey !== request.key) {
      await write(io, ["issue", "edit", String(existing.number), "--body", issueBodyWithCaseMarker(existing.body ?? "", request.key)]);
    }
    if (existing.state === "CLOSED") await write(io, ["issue", "reopen", String(existing.number)]);
    // The found issue may be the doctor's OWN, `ensure`d earlier: `ci-health`,
    // a claim label, no `ready-for-agent`. Returning it unchanged would print
    // "filed for the coders", mark the case `handed-off` — which
    // `ci-doctor/gate.ts:265` then skips for good — and leave a ticket no
    // coder can see and no doctor comes back to. So the found path opens it,
    // which is the same act as the hand-off.
    const opened = await openToCoders({ issue: existing.number, labels: existing.labels, loop: request.loop }, io);
    return { issue: existing.number, created: false, opened };
  }
  const args = ["issue", "create", "--title", request.title, "--body", issueBodyWithCaseMarker(request.body, request.key)];
  for (const label of CODER_FILING_LABELS) args.push("--label", label);
  const ran = await write(io, args);
  const number = issueNumberOf(ran.stdout);
  if (number === null) throw new Error(`could not read the new issue number from ${ran.stdout.trim()}`);
  return { issue: number, created: true, opened: true };
}

/**
 * Make an issue one a coder's frontier offers, and let go of it.
 *
 * Built from the labels the issue ACTUALLY carries, for the reason `prompt.md`
 * gives a coder: `gh` 404s on removing a label that is not there, and the
 * state a hand-off finds is not the state it assumes — a `-wip` may already
 * have been cleared, and a `-blocked` may be on, which `classify`'s queued
 * filter (`frontier/next-tasks.ts:822-825`) drops however ready the ticket
 * looks. A hand-off that threw on either would post its findings and then
 * leave the ticket exactly as it was.
 *
 * The claim lease goes BEFORE the relabel. Either order can be interrupted;
 * this one fails safe. Released first and relabelled never, the ticket keeps
 * its claim label and stays hidden (`isClaimed` reads an absent lease as
 * claimed), so the hand-off can simply be run again. Relabelled first and
 * released never, it is offered in READY and refused to every coder that
 * tries to claim it — the exact harm the release exists to prevent.
 */
async function openToCoders(
  args: { issue: number; labels: readonly string[]; loop?: string },
  io: Pick<CaseIssueIo, "gh" | "release">,
): Promise<boolean> {
  const drop = args.labels.filter((label) => label.endsWith("-wip") || label.endsWith("-blocked"));
  const add = CODER_FILING_LABELS.filter((label) => !args.labels.includes(label));
  const mine = args.loop !== undefined && drop.includes(`${args.loop}-wip`);
  if (mine) await io.release(args.issue);
  if (drop.length === 0 && add.length === 0) return false;
  const edit = ["issue", "edit", String(args.issue)];
  for (const label of drop) edit.push("--remove-label", label);
  for (const label of add) edit.push("--add-label", label);
  await write(io, edit);
  return true;
}

/**
 * A second failed fix on the doctor's own case: hand the issue to the coders
 * rather than parking it as `<loop>-blocked` (AC 4).
 *
 * The findings go on first. A reader who arrives at a freshly
 * `ready-for-agent` ticket with no comment has nothing to work from, and the
 * coder's frontier can offer it the moment the label lands.
 */
export async function handOffToCoders(
  args: { issue: number; loop: string; findings: string; labels: readonly string[] },
  io: Pick<CaseIssueIo, "gh" | "release">,
): Promise<{ handedOff: boolean }> {
  await write(io, ["issue", "comment", String(args.issue), "--body", args.findings]);
  const handedOff = await openToCoders({ issue: args.issue, labels: args.labels, loop: args.loop }, io);
  return { handedOff };
}

/** The labels an issue carries right now, for a caller about to edit them. Empty when it cannot be read. */
export async function labelsOn(issue: number, io: Pick<CaseIssueIo, "gh">): Promise<string[]> {
  const ran = await io.gh(["issue", "view", String(issue), "--json", "labels"]);
  if (!ran.ok) throw new Error(`could not read the labels of #${issue}: ${ran.stderr.trim()}`);
  try {
    return labelsOf((JSON.parse(ran.stdout || "{}") as { labels?: unknown }).labels);
  } catch {
    throw new Error(`could not read the labels of #${issue}`);
  }
}

/* --------------------------------------------------------------------------
 * The store side: what the doctor's own record learns from a filing.
 * ----------------------------------------------------------------------- */

/** What a `fix-failed` decided, so the caller can report it without re-reading. */
export interface FixFailure {
  attempts: number;
  handedOff: boolean;
  issue: number | null;
}

export interface StoreIo {
  path: string;
  /** `withStore`, injected so the tests can hold a real temp store. */
  with: <T>(path: string, critical: (store: CiHealthStore) => T) => Promise<T>;
  /** `readStore`: a read that takes no lock and rewrites nothing, for the one read that needs neither. */
  read: (path: string) => CiHealthStore;
}

/** The case as it stands once its issue exists: `filed`, carrying the number. */
export const filedCase = (value: Case, issue: number): Case => ({ ...value, issue, state: "filed" });

export const attemptedFix = (value: Case): Case => ({ ...value, fixAttempts: value.fixAttempts + 1 });

export const shouldHandOff = (value: Case, max: number = MAX_FIX_ATTEMPTS): boolean => value.fixAttempts >= max;

/**
 * The issue the store remembers for a case, if it remembers the case at all.
 *
 * Lock-free, unlike the writes: `withStore` takes an exclusive lock and
 * rewrites the file even for a critical section that changed nothing, and this
 * runs before every filing.
 */
export const knownIssue = (key: string, store: StoreIo): number | null => store.read(store.path).cases[key]?.issue ?? null;

/** The key this case's marker was filed under, when a #237 rekey moved it since. Same read, same reason it takes no lock. */
export const filedAsKey = (key: string, store: StoreIo): string | null => store.read(store.path).cases[key]?.filedAs ?? null;

/**
 * Forget the old filing key: the issue's body now carries this case key's own
 * marker, so the bridge `Case.filedAs` provided is spent. Left in place on a
 * case the store has lost, for the reason `recordFiled` gives — it is a cache.
 */
export async function clearFiledAs(key: string, store: StoreIo): Promise<boolean> {
  return store.with(store.path, (open) => {
    const value = open.cases[key];
    if (value === undefined || value.filedAs === undefined || value.filedAs === null) return false;
    open.cases[key] = { ...value, filedAs: null };
    return true;
  });
}

/** Record the case's issue: `issue` set and the case `filed`. A case the store has lost is not an error — it is a cache, and the next scan rebuilds it. */
export async function recordFiled(key: string, issue: number, store: StoreIo): Promise<boolean> {
  return store.with(store.path, (open) => {
    const value = open.cases[key];
    if (value === undefined) return false;
    open.cases[key] = filedCase(value, issue);
    return true;
  });
}

/**
 * The newest build this case has evidence for — the boundary a rejection is
 * taken as of. A case with no build evidence yields 0, so any later build
 * passes it; the boundary deliberately fails OPEN, because one that could
 * never be overtaken would bury a case the next red genuinely re-opens.
 *
 * `?? []` for `known.ts`'s reason: the store is a cache whose version gate
 * guards only the top level, so a field can be missing on a case read back.
 */
export const rejectedBuild = (value: Case): number => Math.max(0, ...(value.evidence ?? []).map((seen) => seen.build));

/**
 * Keys a rejection must refuse, because the fold could never give the case
 * back — and a rejection with no way back is worse than the re-offer #240 set
 * out to stop.
 *
 * Both are cases the SCAN never proposes, and `mergeCases`' first loop is the
 * only thing that clears a spent `rejectedAt`:
 *
 * - `infra:check:` comes from GitHub, not Buildkite. `checkIncidents` writes
 *   every evidence row with `build: 0`, so the boundary is 0 and nothing can
 *   ever exceed it; the delete sweep skips the prefix, and the gate's own
 *   check merge preserves `state` and `rejectedAt` through `...prev`. A
 *   rejected check case would be inert forever, and the gate would report "CI
 *   is healthy" through a live outage.
 * - `parked:` is the gate's record of a coder's ticket, rewritten from
 *   scratch by `parkedCase` on every poll, so a rejection there is erased
 *   rather than honoured. Priority 4 and `unparks` are how a parked ticket is
 *   settled.
 *
 * Refusing takes nothing away in either case: a rejection there never
 * suppressed anything. An `infra:` verdict is `work: false`, and priority 4
 * reads a parked ticket's flake case and the `unparks` map — never the parked
 * case's own `state` or `rejectedAt`.
 *
 * `CHECK_CASE_PREFIX` is imported rather than restated: it is the same
 * constant the delete sweep skips on, and a second literal would let a rename
 * desync the guard from the sweep with nothing going red.
 */
export const UNREJECTABLE_PREFIXES: readonly string[] = [CHECK_CASE_PREFIX, "parked:"];

/** The prefix refusing this key, if any. */
export const unrejectable = (key: string): string | undefined =>
  UNREJECTABLE_PREFIXES.find((prefix) => key.startsWith(prefix));

const refuseUnrejectable = (key: string): void => {
  const prefix = unrejectable(key);
  if (prefix !== undefined) {
    throw new Error(
      `reject cannot take a ${prefix}* case (${key}): the scan never proposes one, so nothing could ever lift the rejection`,
    );
  }
};

/**
 * The case as a doctor's rejection leaves it: `retired`, with the boundary and
 * the reason. `retired` rather than a new state because `dashboard/contracts.ts`,
 * two exhaustive fences in `contract-parity.test.ts` and `known.ts`'s switch
 * all enumerate `CaseState`, and a rejection needs no new vocabulary — what it
 * needs is the mark `rejectedAt` provides.
 */
export const rejectedCase = (value: Case, reason: string, at: string): Case => ({
  ...value,
  state: "retired",
  rejectedAt: { build: rejectedBuild(value), at, reason },
});

/**
 * The coders' parked tickets that were waiting on this case.
 *
 * A `parked:<n>` case carries the flake it names in `rule` (`gate.ts`'s
 * `parkedCase`), and `actionable` unparks a ticket only when its case is
 * `confirmed` or `fixed` — so a rejected case unparks nobody, and a ticket
 * parked on it stays parked until an operator acts. That is usually the RIGHT
 * answer, because a rejection says the failure is not a flake and so is
 * probably the branch's own. But it is never the right SILENT answer: parked
 * tickets starving their loops is a failure this project has already had.
 */
export const parkedOnCase = (store: CiHealthStore, key: string): number[] => {
  // Only for a `flake:` key. `actionable` looks a parked ticket up as
  // `flake:<testId>`, so rejecting a `regression:` case of the same subject
  // leaves the flake case untouched and priority 4 may well unpark those
  // tickets — claiming otherwise would be a false warning.
  if (!key.startsWith("flake:")) return [];
  const subject = subjectOf(key);
  return Object.entries(store.cases)
    .filter(([parkedKey, value]) => value.kind === "parked" && value.rule === subject && parkedKey.startsWith("parked:"))
    .map(([parkedKey]) => Number(subjectOf(parkedKey)))
    .filter((number) => Number.isInteger(number))
    .sort((a, b) => a - b);
};

/** What a recorded rejection answers with. `null` instead means the store had no such case. */
export interface Rejection {
  /** The newest build the case had evidence for — the boundary the rejection is taken as of. */
  build: number;
  /** Coders' tickets parked on this case, which the rejection does NOT unpark. */
  parked: number[];
}

/**
 * Record a doctor's rejection, answering with the boundary build it was taken
 * as of and the parked tickets it leaves parked — or `null` for a case the
 * store has lost, which is not an error but a cache miss, as for `recordFiled`.
 *
 * Both answers come from inside the critical section rather than from a second
 * read: the lock is the only moment at which the evidence the boundary is
 * computed from is the evidence that was written.
 */
export async function recordRejected(
  key: string,
  reason: string,
  store: StoreIo,
  at: string = new Date().toISOString(),
): Promise<Rejection | null> {
  // Enforced here and not only in `runReject`: both this and `rejectedCase`
  // are exported, and `gate.ts` already writes cases in process, so a future
  // caller could otherwise re-open the unliftable-rejection hole in silence.
  refuseUnrejectable(key);
  return store.with(store.path, (open) => {
    const value = open.cases[key];
    if (value === undefined) return null;
    open.cases[key] = rejectedCase(value, reason, at);
    return { build: rejectedBuild(value), parked: parkedOnCase(open, key) };
  });
}

/** Record an issue filed for the coders: the case is `handed-off`, not the doctor's. */
export async function recordHandedOff(key: string, issue: number, store: StoreIo): Promise<boolean> {
  return store.with(store.path, (open) => {
    const value = open.cases[key];
    if (value === undefined) return false;
    open.cases[key] = { ...value, issue, state: "handed-off" };
    return true;
  });
}

/**
 * Count one failed fix of the doctor's own and say whether that spends the
 * budget (AC 4).
 *
 * The count is the store's, and a lost store resets it — unlike the filing
 * identity, which is on GitHub because AC 2 asks it to survive. That asymmetry
 * is deliberate: a reset count costs one extra fix attempt, where a lost
 * filing identity costs a duplicate issue on every poll.
 */
export async function countFailedFix(key: string, store: StoreIo, max: number = MAX_FIX_ATTEMPTS): Promise<FixFailure> {
  return store.with(store.path, (open) => {
    const value = open.cases[key];
    if (value === undefined) {
      throw new Error(`no case ${key} in the ci-health store — the gate writes one before an iteration starts`);
    }
    const next = attemptedFix(value);
    open.cases[key] = next;
    return { attempts: next.fixAttempts, handedOff: shouldHandOff(next, max), issue: next.issue };
  });
}

/* --------------------------------------------------------------------------
 * CLI. The doctor's prompt runs these; nothing else does.
 * ----------------------------------------------------------------------- */

const PREFIX = "case-issue";

/** What a subcommand needs. Separated from `main` so the wiring is testable without a process. */
export interface CommandDeps {
  io: CaseIssueIo;
  store: StoreIo;
  loop: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** `--flag value` out of an argv, with a refusal naming the flag rather than the position. */
export function flagValue(argv: readonly string[], flag: string): string | null {
  const at = argv.indexOf(flag);
  if (at === -1) return null;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

function caseKeyArg(argv: readonly string[]): string {
  const key = argv[0];
  if (key === undefined || key.startsWith("--")) throw new Error(`${PREFIX} needs a case key, e.g. "flake:src/a.test.ts > flaps"`);
  return key;
}

function bodyArg(argv: readonly string[], flag: string, read = readFileSync): string {
  const inline = flagValue(argv, flag);
  if (inline !== null) return inline;
  const file = flagValue(argv, `${flag}-file`);
  if (file === null) throw new Error(`${PREFIX} needs ${flag} or ${flag}-file`);
  return read(file, "utf8") as string;
}

/** `ensure <case key> --title <t> (--body <b> | --body-file <f>)`. Exit code, 0 or `CLAIM_REFUSED_EXIT`. */
export async function runEnsure(argv: readonly string[], deps: CommandDeps): Promise<number> {
  const key = caseKeyArg(argv);
  const title = flagValue(argv, "--title");
  if (title === null) throw new Error("ensure needs --title");
  const body = bodyArg(argv, "--body");
  const known = knownIssue(key, deps.store);
  const filedAs = filedAsKey(key, deps.store);
  const result = await ensureCaseIssue({ key, title, body, loop: deps.loop, known, filedAs }, deps.io);
  // Recorded whatever the claim did. An issue created and then not claimed is
  // still this case's issue for good, and a number the store never learned is
  // a number the next `ensure` must find by search alone — against an index
  // that may not have caught up, which is the duplicate `known` exists to
  // prevent.
  if (result.issue !== null) await recordFiled(key, result.issue, deps.store);
  if (result.restamped === true) await clearFiledAs(key, deps.store);
  if (result.kind !== "claimed") {
    const what = result.issue === null ? key : `#${result.issue} (${result.created ? "created" : "found"}) for ${key}`;
    deps.err(`${PREFIX}: ${what} ${result.kind === "unreadable" ? "not filed" : "refused"} — ${result.refusal ?? "unknown"}`);
    // A read that failed is a fault to report, not a race to lose: exit 3
    // means "somebody else has this case", and the caller acts differently on
    // the two.
    return result.kind === "unreadable" ? 1 : CLAIM_REFUSED_EXIT;
  }
  deps.out(`${PREFIX}: #${result.issue} ${result.created ? "created" : "found"} and claimed for ${key}`);
  return 0;
}

/** `file <case key> --title <t> (--body <b> | --body-file <f>)` — the coders' ticket. */
export async function runFile(argv: readonly string[], deps: CommandDeps): Promise<number> {
  const key = caseKeyArg(argv);
  const title = flagValue(argv, "--title");
  if (title === null) throw new Error("file needs --title");
  const body = bodyArg(argv, "--body");
  const known = knownIssue(key, deps.store);
  const result = await fileForCoders({ key, title, body, known, filedAs: filedAsKey(key, deps.store), loop: deps.loop }, deps.io);
  if (result.issue === null) {
    deps.err(`${PREFIX}: GitHub could not be read for ${key} — nothing filed`);
    return 1;
  }
  await recordHandedOff(key, result.issue, deps.store);
  const how = result.created ? "filed" : result.opened ? "found and opened" : "found";
  deps.out(`${PREFIX}: #${result.issue} ${how} for the coders — ${key}`);
  return 0;
}

/** `fix-failed <case key> (--findings <f> | --findings-file <p>)` — count one, hand over on the second. */
export async function runFixFailed(argv: readonly string[], deps: CommandDeps): Promise<number> {
  const key = caseKeyArg(argv);
  // Read before counting: the whole argv is validated before the budget is
  // spent, as `claim-lease.ts`'s `runClaim` validates before it writes. A
  // mistyped invocation that burned an attempt would hand a ticket over with
  // no fix ever tried.
  const findings = bodyArg(argv, "--findings");
  const outcome = await countFailedFix(key, deps.store);
  if (!outcome.handedOff) {
    deps.out(`${PREFIX}: ${key} has had ${outcome.attempts} of ${MAX_FIX_ATTEMPTS} fix attempts — try again`);
    return 0;
  }
  if (outcome.issue === null) throw new Error(`${key} has no issue to hand over — run \`${PREFIX} ensure\` first`);
  const labels = await labelsOn(outcome.issue, deps.io);
  const { handedOff } = await handOffToCoders(
    { issue: outcome.issue, loop: deps.loop, findings, labels },
    deps.io,
  );
  await recordHandedOff(key, outcome.issue, deps.store);
  deps.out(
    `${PREFIX}: #${outcome.issue} ${handedOff ? "handed to the coders as ready-for-agent" : "was already the coders'"}` +
      ` after ${outcome.attempts} fix attempts`,
  );
  return 0;
}

/**
 * `reject <case key> (--reason <r> | --reason-file <f>)` — the doctor turns a
 * case down, as a store transition rather than as a sentence in a journal
 * nothing reads (#240).
 *
 * No GitHub write and no claim, so no `identity()` and no
 * `CLAIM_REFUSED_EXIT`: the only failure is a store that has lost the case.
 */
export async function runReject(argv: readonly string[], deps: CommandDeps): Promise<number> {
  const key = caseKeyArg(argv);
  // Before the reason is read, so a mistyped key cannot reach the store.
  refuseUnrejectable(key);
  const trimmed = bodyArg(argv, "--reason").trim();
  // A rejection with no reason is the one thing the record must not allow: the
  // reason is what reaches the journal, and an empty string would leave a case
  // inert with nothing saying why.
  if (trimmed === "") throw new Error("reject needs a non-empty --reason");
  const done = await recordRejected(key, trimmed, deps.store);
  if (done === null) {
    deps.err(`${PREFIX}: the ci-health store has no case ${key} — nothing rejected`);
    return 1;
  }
  deps.out(`${PREFIX}: ${key} rejected as of build ${done.build} — ${trimmed}`);
  // Reported, not refused: sometimes a rejection is right and the parked
  // ticket is genuinely the branch's own problem. But the doctor has to know
  // it is leaving them parked, because nothing else will unpark them.
  if (done.parked.length > 0) {
    deps.err(
      `${PREFIX}: this rejection unparks nothing — ${done.parked.map((number) => `#${number}`).join(", ")} ` +
        `stay parked on ${key}. File it for the coders instead if the failure is theirs.`,
    );
  }
  return 0;
}

/** The real `gh`, as `ci-doctor/gate.ts` runs it — same 32 MB buffer, because a search asks for fifty bodies. */
const realGh: Gh = (args) =>
  new Promise<Ran>((resolve) => {
    execFile("gh", args, { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout, stderr });
    });
  });

function identity(): { run: string; loop: string } {
  const run = process.env.RALPH_RUN_ID?.trim();
  const loop = process.env.RALPH_LOOP_NAME?.trim();
  if (!run || !loop) throw new Error(`${PREFIX} needs RALPH_RUN_ID and RALPH_LOOP_NAME`);
  return { run, loop };
}

/** The case lease, as `ci-doctor/gate.ts` takes it. */
const realLease = (path: string): CaseIssueIo["lease"] => async (key) => {
  const taken = await takeCaseLease(path, key, identity());
  return { taken: taken.taken, holder: taken.holder === null ? null : `${taken.holder.loop} run ${taken.holder.run}` };
};

/** `claim-lease.ts claim`, reached the way `claim-lease.ts` itself reaches it: dynamically, to leave the frontier's import cycle alone. */
const realClaim: CaseIssueIo["claim"] = async (issue, label) => {
  const { claimByNumberWithLock } = await import("../frontier/next-tasks");
  const outcome = await claimByNumberWithLock(issue, { label });
  return { claimed: outcome.claimed, refusal: outcome.refusal };
};

/** `claim-lease.ts release <n>`, in process and under the same lock. */
const realRelease: CaseIssueIo["release"] = async (issue) => {
  const who = identity();
  const path = leasePathFromGit();
  // Polled, as `withClaimLock` polls: the lock is the claim lock, and another
  // loop holds it across a whole claim walk including live GitHub reads. A
  // single attempt would fail routinely, and a failed release leaves a claim
  // behind on a ticket about to be offered.
  for (let attempt = 0; attempt < 100; attempt++) {
    const released = withLeaseStoreLock(path, () => {
      const result = releaseLease(readLeaseStore(path), issue, who);
      if (result.released) writeLeaseStore(path, result.store);
      return result.released;
    });
    if (released !== undefined) return { released };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the claim lock was held for 10s; #${issue}'s claim lease was not released`);
};

/**
 * The live `gh`, claim, lease and release, as `main` below wires them.
 *
 * Exported for `ci-doctor/revert.ts`, which calls `ensureCaseIssue` and
 * `fileForCoders` from its own CLI. A second copy of the claim, lease and
 * release wirings there would be three chances for the two callers to drift —
 * most dangerously on `realRelease`'s polled lock, whose single-attempt
 * version leaves a claim behind on a ticket about to be offered. (`revert.ts`
 * substitutes `gate.ts`'s `ghRunner` for the `gh` field, because it shares one
 * runner with its own reads; the two are the same `execFile` call with the
 * same 32 MB buffer.)
 *
 * `storePath` is the ci-health store the case lease lives beside
 * (`storePathFromGit`), not the claim-lease store, which `realRelease`
 * resolves for itself.
 */
export function liveCaseIssueIo(storePath: string): CaseIssueIo {
  return { gh: realGh, claim: realClaim, lease: realLease(storePath), release: realRelease };
}

async function main(): Promise<number> {
  // Anchored like `ci-doctor/gate.ts`, and for its reason: unanchored, every
  // `gh` and `git` probe answers for whatever directory this was invoked from,
  // so `ensure` would file the issue on the harness's own repository and write
  // a store the gate never reads.
  process.chdir(projectRoot());
  const command = process.argv[2];
  const argv = process.argv.slice(3);
  const storePath = storePathFromGit(process.cwd());
  const deps: CommandDeps = {
    io: liveCaseIssueIo(storePath),
    store: { path: storePath, with: withStore, read: readStore },
    loop: process.env.RALPH_LOOP_NAME?.trim() || "",
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
  if (command === "ensure" || command === "fix-failed") identity();
  if (command === "ensure") return runEnsure(argv, deps);
  if (command === "file") return runFile(argv, deps);
  if (command === "fix-failed") return runFixFailed(argv, deps);
  if (command === "reject") return runReject(argv, deps);
  throw new Error(`${PREFIX}: unknown command ${command ?? "(none)"} — ensure | file | fix-failed | reject`);
}

if (import.meta.main) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`${PREFIX}: ${error instanceof Error ? error.message : String(error)}`);
      // A throttle is time, not a fault: `RATE_LIMITED_EXIT` is the code the
      // supervisor waits out instead of stopping for a human.
      process.exitCode = isRateLimited(error) ? RATE_LIMITED_EXIT : 1;
    });
}
