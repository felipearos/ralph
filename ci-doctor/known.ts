/**
 * What the ci-health store already knows about a red build's failing tests,
 * rendered as the `known:` lines `bk-log.ts` prints beside each failure.
 *
 * This is the read side of the doctor's memory, and the first thing in the
 * ci-doctor tree a CODER uses: `prompt.md` §5.4 asks a loop to decide whether
 * a red is a flake, and before this it decided by guessing. One `known:` line
 * — "confirmed flake, 9 reds in the window, fix PR open" — turns that into a
 * decision from recorded evidence, and stops a loop re-running into a flake
 * the doctor has already filed.
 *
 * Pure, and deliberately a leaf: it imports `./store` and nothing else. In
 * particular it must never import `../bk-log`, which `ci-doctor/scan.ts` does
 * — hence `FailureRef` carries the three plain fields `identify` needs rather
 * than bk-log's `Digest`. Reading the store is the caller's job (`readStore`
 * never throws), so a missing or corrupt store reaches here as an empty one
 * and yields no lines at all.
 */
import { identify, subjectOf, weigh, type Case, type CaseState, type CiHealthStore } from "./store";

/** One failing test as `bk-log.ts` has it: a title, the digest's file list, and its own file. */
export interface FailureRef {
  title: string;
  /** The digest's failing files — `identify` needs them for a jest-style title. */
  files: readonly string[];
  /** This failure's own file, when the digest knows it (#237). */
  file?: string | null;
}

/** What the digest knows about the build the failures came from. */
export interface KnownContext {
  /** The build's branch, for a `pr-specific:<branch>:<testId>` case. */
  branch: string | null;
  /** The project's repo slug (`loggd` out of `felipearos/loggd`), or null. */
  repoSlug: string | null;
}

export interface KnownNotes {
  /**
   * Store `testId` → its lines, in flake / regression / branch order. Only
   * ids that matched.
   *
   * Keyed by the resolved id, never by the failure title: a jest-style `●`
   * title resolves through `digest.files`, so one title in two jobs with
   * different file lists is two different tests. Keyed by title, the second
   * job's verdict silently replaced the first's and was then printed under
   * BOTH — a wrong `known:` attribution, which is the class of error this
   * whole surface exists to prevent.
   */
  byTestId: Record<string, string[]>;
  /** Open infra incidents, one line each. */
  incidents: string[];
}

/**
 * How many infra incidents a digest will spend lines on. Three, because the
 * thing a coder came for is the failing test above them: a store mid-outage
 * can hold a dozen bootstrap signatures, and a digest that opens with all of
 * them has scrolled the failure out of view. The rest are counted, not hidden.
 */
export const INFRA_LIMIT = 3;

/**
 * States in which a case no longer describes CI as it is now. A `fixed` case
 * is history, and `mergeCases` keeps it — with its evidence — after the rows
 * stop supporting it, so a reader that only filters `retired` would assert
 * "main red since build 2701 — not the diff" off a regression that landed its
 * fix a day ago. The one direction a stale claim must never point is the one
 * that stops a coder working on their own failure.
 */
const SETTLED = new Set<CaseState>(["retired", "fixed"]);

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** This case's red builds in the window, tolerating a malformed case (see `lastKind`). */
const reds72h = (kase: Case): number => kase.cost72h?.redBuilds ?? 0;

/**
 * The kind the case was last seen failing with, or null when it has no
 * evidence. Optional-chained because the store is a CACHE whose version gate
 * only guards the top level: `readStore` merges a version-1 document's `cases`
 * through untouched, so one hand-edited or half-written case must degrade to a
 * quieter line rather than throw and cost every OTHER failure its verdict.
 */
const lastKind = (kase: Case): string | null => kase.evidence?.at(-1)?.kind ?? null;

/** `(timeout, 9 reds/72h)`, or `""` when there is nothing to put in it. */
function cost(kase: Case): string {
  const kind = lastKind(kase);
  const reds = reds72h(kase);
  if (kind === null && reds === 0) return "";
  const parts = [kind, reds > 0 ? `${plural(reds, "red")}/72h` : null].filter((part) => part !== null && part !== "");
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/**
 * The issue reference and the fix PR around a case's claim: a case the doctor
 * has filed says so, and an open fix PR is the single most useful thing a
 * coder can learn from a red — it means do not fix this here.
 */
function decorate(claim: string, kase: Case, repoSlug: string | null): string {
  // `?? null`, never `=== null`: a malformed case reaches here with the field
  // ABSENT, and `#undefined` is worse than no reference at all.
  const issue = kase.issue ?? null;
  const reference = issue === null ? null : `${repoSlug === null ? "" : `${repoSlug} `}#${issue}`;
  return `${reference === null ? "" : `${reference} — `}${claim}${fixClause(kase)}`;
}

/**
 * The fix PR, said only as strongly as the store can support. `Case.pr` is a
 * number with no state of its own, so "open" is inferred from the case: a
 * `fixed` case's PR has landed, and claiming it is still open would tell a
 * coder to leave a failure alone that is now theirs.
 */
function fixClause(kase: Case): string {
  const pr = kase.pr ?? null;
  if (pr === null) return "";
  return kase.state === "fixed" ? `, fixed by PR #${pr}` : `, fix PR #${pr} open`;
}

/** A flake case's claim, or null when its state reports nothing. */
function flakeClaim(kase: Case): string | null {
  switch (kase.state) {
    case "confirmed":
    case "filed":
    case "fixing":
      return `confirmed flake${cost(kase)}`;
    case "candidate":
      return `flake candidate${cost(kase)} — not confirmed yet`;
    case "fixed": {
      const build = kase.fixedAt?.build;
      return build === undefined || build === null ? "flake fixed" : `flake fixed after build ${build}`;
    }
    case "handed-off":
      return `flake handed to the coders${cost(kase)}`;
    case "retired":
      return null;
    default: {
      // `kase.state` is `never` here, so an eighth `CaseState` still fails the
      // build. The arm exists for RUNTIME: a version-1 case whose `state` the
      // store's top-level version gate let through ABSENT matches nothing
      // above, and without this fell off the end as `undefined` — which
      // `decorate` then printed as the literal line `known: undefined`. Round
      // 1 of this ticket's review introduced exactly that by deleting the
      // original `default`. Say nothing instead.
      const unreachable: never = kase.state;
      void unreachable;
      return null;
    }
  }
}

/**
 * A regression's claim. The build is the earliest one the case has evidence
 * for, which is the build this TEST went red on — not necessarily the build
 * main went red on, and the more useful of the two to a coder reading one
 * failure. It falls back to the store's own main-red boundary, and says
 * nothing rather than printing a `0` when neither is known.
 */
function regressionClaim(kase: Case, main: CiHealthStore["main"]): string {
  const builds = (kase.evidence ?? []).map((entry) => entry.build).filter((build) => build > 0);
  const since = builds.length > 0 ? Math.min(...builds) : main.build > 0 ? main.build : null;
  const from = since === null ? "" : ` ${since}`;
  switch (main.state) {
    case "red":
      // The line the ticket specifies, and the only one that claims main is red NOW.
      return since === null ? "main red on this test — not the diff" : `main red since build ${since} on this test — not the diff`;
    case "green":
      return `main was red on this test${since === null ? "" : ` from build${from}`} — not the diff`;
    default:
      // `unknown` is `emptyStore`'s default and what `mainState` says when the
      // window holds no tested main build: report the evidence, claim no colour.
      return `main red on this test${since === null ? "" : ` from build${from}`} — not the diff`;
  }
}

/**
 * An open infra incident. The signature leads, because it is what a reader
 * recognises, and the issue reference trails — the opposite of a per-test
 * line, where the filed issue is the first thing worth knowing. The `infra:`
 * prefix is dropped the way `ci-doctor/gate.ts`'s `subjectOf` drops it: the
 * section header already said `known infra:`.
 *
 * A case the doctor has filed or is fixing says so. The alternative readings
 * are both worse: listing it bare claims nobody is on it, and hiding it (which
 * is what the gate does, since it is asking a different question — "is there
 * work here?") would keep a coder guessing about a red CI someone is already
 * repairing.
 */
function infraLine(key: string, kase: Case, repoSlug: string | null): string {
  const subject = subjectOf(key);
  const rule = kase.rule ? ` — ${kase.rule}` : "";
  const reds = reds72h(kase);
  const count = reds > 0 ? ` (${plural(reds, "red build")}/72h)` : "";
  // `?? null` for the same reason as `flakeClaim`'s default arm: an absent
  // state must not print `, undefined` into the digest.
  const state = kase.state === "confirmed" || (kase.state ?? null) === null ? "" : `, ${kase.state}`;
  const issue = kase.issue ?? null;
  const reference = issue === null ? "" : `, ${repoSlug === null ? "" : `${repoSlug} `}#${issue}`;
  return `${subject}${rule}${count}${state}${reference}${fixClause(kase)}`;
}

/**
 * The store's lines for these failures. A store that knows nothing about any
 * of them — the ordinary case before the doctor runs — yields empty
 * collections, and the caller prints nothing extra.
 */
export function knownNotes(
  store: CiHealthStore,
  failures: readonly FailureRef[],
  context: KnownContext,
): KnownNotes {
  // `readStore`'s version gate guards the top level and then spreads, so a
  // version-1 document can arrive with `cases` or `main` explicitly null.
  // Reading them raw threw, and `readKnown`'s catch then cost every OTHER
  // failure its verdict — the harm the defensive reads exist to prevent.
  const cases = store.cases ?? {};
  const main = store.main ?? { state: "unknown" as const, since: "", build: 0 };
  const byTestId: Record<string, string[]> = {};
  for (const failure of failures) {
    const { testId } = identify(failure.title, failure.files, failure.file);
    if (byTestId[testId] !== undefined) continue;
    const lines: string[] = [];

    const flake = cases[`flake:${testId}`];
    // `fixed` is kept here, unlike the regression and infra branches: "flake
    // fixed after build 2750" tells a coder the red they are looking at should
    // not be this flake any more, which is information. A stale "not the diff"
    // or a stale open incident only mislead.
    if (flake !== undefined && flake.state !== "retired") {
      const claim = flakeClaim(flake);
      if (claim !== null) lines.push(decorate(claim, flake, context.repoSlug));
    }

    const regression = cases[`regression:${testId}`];
    if (regression !== undefined && !SETTLED.has(regression.state)) {
      lines.push(decorate(regressionClaim(regression, main), regression, context.repoSlug));
    }

    if (context.branch !== null) {
      const branchCase = cases[`pr-specific:${context.branch}:${testId}`];
      if (branchCase !== undefined && !SETTLED.has(branchCase.state)) {
        const reds = reds72h(branchCase);
        const count = reds > 0 ? ` (${plural(reds, "red")}/72h)` : "";
        lines.push(decorate(`red only on this branch${count} — likely the diff`, branchCase, context.repoSlug));
      }
    }

    if (lines.length > 0) byTestId[testId] = lines;
  }

  // "Open": the issue asks for open incidents, and a settled one is not open.
  // Sorted, never left in the scan's insertion order: the three that get lines
  // must be the three worth knowing, and two readers of one store must rank
  // them alike. By `weigh`, the same weight `ci-doctor/gate.ts` ranks cases
  // with — not by `redBuilds`, which `classify.ts` hard-zeroes for a
  // `scheduled-wait` and for EVERY `infra:check:*` case, so a required check
  // red across ten PRs would always have sorted last and been the first thing
  // the cap dropped. Evidence count breaks the tie those zeroed families share.
  const open = Object.entries(cases)
    .filter(([, kase]) => kase.kind === "infra" && !SETTLED.has(kase.state))
    .sort(
      ([keyA, a], [keyB, b]) =>
        weigh(b.cost72h) - weigh(a.cost72h) ||
        (b.evidence?.length ?? 0) - (a.evidence?.length ?? 0) ||
        keyA.localeCompare(keyB),
    );
  const incidents = open.slice(0, INFRA_LIMIT).map(([key, kase]) => infraLine(key, kase, context.repoSlug));
  if (open.length > INFRA_LIMIT) {
    incidents.push(`… ${plural(open.length - INFRA_LIMIT, "more infra incident")} in the store`);
  }

  return { byTestId, incidents };
}
