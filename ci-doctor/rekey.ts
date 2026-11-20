/**
 * The one-off rekey #237's second acceptance criterion asks for: the rows and
 * cases a jest failure left behind while the digest could not name its file.
 *
 * Before #237, a jest `● describe › test` block from a job that ran more than
 * one test file was stored as `testId: "describe > test"` with `file: null`.
 * The digest now attaches the path from jest's `FAIL <path>` header, so the
 * same failure arrives as `<file> > describe > test` — a DIFFERENT key. Left
 * alone that is a second filing: the identity of a case issue is a hash of its
 * case key in the issue body (`ci-doctor/case-issue.ts`), so the new key would
 * find no marker and file a fresh `ci-health` issue for a flake that already
 * has one, which is the "paged twice" AC 2 forbids.
 *
 * Aging the old keys out cannot avoid that at all. `prune` prunes builds,
 * failures, `jobsSeen` and metrics — never `cases` — and `mergeCases` keeps
 * every case in `MANAGED_STATES`, and every `confirmed` flake, for good
 * (`classify.ts`). A `filed` case under the old key therefore never retires:
 * it sits in the store with its open issue while the new key files beside it.
 * So this moves the old identity onto the new key instead, which also carries
 * the filing, the fix attempts and the paged marks across.
 *
 * It is NOT a store version bump. Bumping `CI_HEALTH_VERSION` would discard a
 * live 72-hour window (`store.ts:7-12`) AND the `filed` state with it, which
 * is the very record that stops the second page.
 *
 * The mapping comes from the store itself: a row that now carries a file says
 * that `<file> > <bare>` and `<bare>` are the same test. It is deliberately
 * NOT gated on an unkeyed row surviving the window — the case is what pages,
 * and a flake that last failed four days ago still has its open issue when the
 * first keyed row arrives. The mapping is in hand either way.
 *
 * What the mapping refuses: a bare name claimed by two different files, which
 * is ambiguous, because one wrong adoption would move a filing onto the wrong
 * test. It cannot refuse a single WRONG claimant — a vitest row's `testId` has
 * the same `<file> > <suite> > <test>` shape, so a vitest test whose suite and
 * test names are byte-identical to a jest test's, inside the same 72-hour
 * window, would be that one claimant and the jest case would move onto its
 * file. That residue is accepted knowingly: refusing every claim is not the
 * safe side of the trade, it is the guaranteed double page this module exists
 * to prevent.
 *
 * Once no `file: null` jest row and no bare case key is left, the whole pass
 * is a no-op, so it costs an idle doctor one walk of a pruned store per poll.
 */
import { MANAGED_STATES } from "./classify";
import { subjectOf, type Case, type CiHealthStore } from "./store";

/** The case kinds whose key ends in a test id — the only keys a rekey may touch. */
const REKEYABLE = ["flake:", "regression:", "pr-specific:"] as const;

/**
 * A rekeyable case key split into the part that is not a test id and the test
 * id itself: `flake:<id>`, `regression:<id>`, `pr-specific:<branch>:<id>`.
 *
 * `store.ts`'s `subjectOf` is the repo's primitive for the first two, and is
 * used here rather than re-derived. `pr-specific:` has a branch between the
 * two colons, and a git branch cannot contain `:`, so its second colon is the
 * one that ends the prefix. Returns null for every other key — `infra:` keys
 * are signatures and `parked:` keys are issue numbers, neither of which is a
 * test id the mapping could speak about.
 */
export function splitCaseKey(key: string): { prefix: string; subject: string } | null {
  if (!REKEYABLE.some((candidate) => key.startsWith(candidate))) return null;
  if (key.startsWith("pr-specific:")) {
    const branchEnd = key.indexOf(":", "pr-specific:".length);
    if (branchEnd === -1) return null;
    return { prefix: key.slice(0, branchEnd + 1), subject: key.slice(branchEnd + 1) };
  }
  return { prefix: key.slice(0, key.indexOf(":") + 1), subject: subjectOf(key) };
}

/**
 * bare test id → the single file that owns it, from the rows that now carry
 * one. A bare id two files claim is dropped rather than guessed.
 */
export function fileByBareTestId(store: CiHealthStore): Map<string, string> {
  const claims = new Map<string, Set<string>>();
  for (const row of store.failures ?? []) {
    if (row.file === null || row.file === undefined) continue;
    const prefix = `${row.file} > `;
    if (!row.testId.startsWith(prefix)) continue;
    const bare = row.testId.slice(prefix.length);
    if (bare === "") continue;
    const owners = claims.get(bare) ?? new Set<string>();
    owners.add(row.file);
    claims.set(bare, owners);
  }
  const resolved = new Map<string, string>();
  for (const [bare, owners] of claims) {
    const only = [...owners];
    if (only.length === 1) resolved.set(bare, only[0]!);
  }
  return resolved;
}

/**
 * What a case the rekey leaves behind must hand to its new key: the fields a
 * scan cannot rebuild, because they record what a later stage DID.
 *
 * The policy is `classify.ts`'s `mergeCases` with one difference, and the
 * difference is the whole reason this is a second function: `mergeCases` folds
 * a PROPOSAL into a stored case, so the stored side always wins (`issue:
 * prev.issue`, unconditionally). Here both sides are STORED — a doctor may
 * have filed under the new key already, which is further along than this
 * migration — so the new key wins only where it HAS an answer, and `??` fills
 * the holes instead. For the same reason the confirmed-flake branch tests the
 * OLD case's kind, where `mergeCases` tests the proposal's.
 *
 * `evidence` and `cost72h` are deliberately not carried: `classify` rebuilds
 * both from the rows, which this pass has just rewritten.
 */
export function adoptCase(target: Case, old: Case): Case {
  const keepsOldState =
    (MANAGED_STATES.has(old.state) || (old.kind === "flake" && old.state === "confirmed")) &&
    !MANAGED_STATES.has(target.state);
  return {
    ...target,
    state: keepsOldState ? old.state : target.state,
    issue: target.issue ?? old.issue,
    pr: target.pr ?? old.pr,
    fixAttempts: Math.max(target.fixAttempts, old.fixAttempts),
    unparks: Object.keys(target.unparks).length > 0 ? target.unparks : old.unparks,
    rule: target.rule ?? old.rule ?? null,
    parkedOn: target.parkedOn ?? old.parkedOn ?? null,
    culprit: target.culprit ?? old.culprit ?? null,
    notified: target.notified ?? old.notified ?? null,
    fixedAt: target.fixedAt ?? old.fixedAt ?? null,
    filedAs: target.filedAs ?? old.filedAs ?? null,
  };
}

export interface RekeyResult {
  /** How many failure rows gained their file. */
  rows: number;
  /** old case key → the key it became. */
  cases: Record<string, string>;
}

/**
 * Move every `file: null` jest identity the store still holds onto the keyed
 * one, in place. Safe to run on every poll: it is a no-op once nothing bare is
 * left, and running it twice changes nothing the first run did not.
 */
export function rekeyJestIdentities(store: CiHealthStore): RekeyResult {
  const byBare = fileByBareTestId(store);
  const result: RekeyResult = { rows: 0, cases: {} };
  if (byBare.size === 0) return result;
  const keyed = (bare: string): string | null => {
    const file = byBare.get(bare);
    return file === undefined ? null : `${file} > ${bare}`;
  };

  for (const row of store.failures ?? []) {
    if (row.file !== null && row.file !== undefined) continue;
    const file = byBare.get(row.testId);
    if (file === undefined) continue;
    row.testId = `${file} > ${row.testId}`;
    row.file = file;
    result.rows += 1;
  }

  const cases = store.cases ?? {};
  for (const [key, value] of Object.entries(cases)) {
    const split = splitCaseKey(key);
    if (split === null) continue;
    const subject = keyed(split.subject);
    if (subject === null) continue;
    const newKey = `${split.prefix}${subject}`;
    const target = cases[newKey];
    // The key the issue's marker on GitHub carries, which is NOT this case key
    // any more. `case-issue.ts` re-checks the marker against the key it was
    // asked about, so without this the rekeyed case reads its own issue as
    // somebody else's and files a second one — the double page AC 2 forbids.
    // Only the FIRST move records it: a case rekeyed twice still has its
    // marker from the original filing.
    const moved = value.issue === null ? value : { ...value, filedAs: value.filedAs ?? key };
    cases[newKey] = target === undefined ? moved : adoptCase(target, moved);
    delete cases[key];
    result.cases[key] = newKey;
  }

  // Everywhere else a test id or a case key is stored. A missed rename here is
  // not cosmetic: a retry cap is spent on a case nothing can find again, and a
  // parked ticket's unpark record goes unread, which has the gate offer it on
  // every poll — the failure `unpark.ts`'s `diagnosisKeyFor` documents.
  const retries = store.retries?.byCase;
  if (retries) {
    // `retries.byCase` is keyed by TEST ID (`retry.ts:354`), not by case key.
    for (const [testId, job] of Object.entries(retries)) {
      const next = keyed(testId);
      if (next === null || next === testId) continue;
      retries[next] = retries[next] ?? job;
      delete retries[testId];
    }
  }
  for (const revert of Object.values(store.reverts ?? {})) {
    const next = result.cases[revert.case];
    if (next !== undefined) revert.case = next;
  }
  // `store.leases` is keyed by case key (`case-lease.ts`). A lease left under
  // the old key expires on its own in `CASE_LEASE_SECONDS`, so this is for the
  // holder's sake rather than correctness: it keeps "held by another doctor"
  // naming the case the holder is actually on.
  const leases = store.leases;
  if (leases) {
    for (const [key, lease] of Object.entries(leases)) {
      const next = result.cases[key];
      if (next === undefined || leases[next] !== undefined) continue;
      leases[next] = lease;
      delete leases[key];
    }
  }
  // A `parked:<n>` case is never itself rekeyed — its key is an issue number —
  // but two of its FIELDS hold a test id: `rule` is the flake the block names
  // (`gate.ts`'s `parkedCase`) and every `unparks` key is a `flake:<test id>`
  // case key (`unpark.ts`'s `diagnosisKeyFor`).
  for (const [key, value] of Object.entries(cases)) {
    if (!key.startsWith("parked:")) continue;
    const rule = value.rule === null || value.rule === undefined ? null : keyed(value.rule);
    const unparks: Record<string, string[]> = {};
    let movedUnpark = false;
    for (const [diagnosis, at] of Object.entries(value.unparks)) {
      const next = result.cases[diagnosis];
      if (next !== undefined && unparks[next] === undefined) movedUnpark = true;
      unparks[next ?? diagnosis] = unparks[next ?? diagnosis] ?? at;
    }
    if (rule === null && !movedUnpark) continue;
    cases[key] = { ...value, ...(rule === null ? {} : { rule }), ...(movedUnpark ? { unparks } : {}) };
  }
  return result;
}
