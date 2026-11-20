/**
 * The pure projection: typed runtime view models plus a clock, one dashboard.
 *
 * This is the primary test seam for the GUI. It knows nothing about processes,
 * HTTP or ralph's JSON — only the narrowed types the adapter produced. The
 * selection rules live here rather than in a request handler so they can be
 * asserted directly, and so SPEC B's write paths can never reach them.
 */
import { ROLE_PANELS, rosterNames } from "./contracts";
import type {
  ActorView,
  CiCaseView,
  CiHealthRead,
  ClaimStatus,
  ClaimView,
  Clock,
  Dashboard,
  DashboardLoop,
  LeaseView,
  JournalEntryView,
  Liveness,
  LoopRole,
  Ownership,
  OwnershipEntry,
  PresenceProblem,
  PresenceView,
  RunnerFailureProjection,
  RunnerFailureView,
  RuntimeLoop,
  RuntimeSnapshot,
  RolePanels,
  TimelineActivityView,
  TriageActivityView,
  TriageUnitView,
  UnattributedWorktree,
  UsageView,
} from "./contracts";

/** How many journal entries a panel shows. */
export const JOURNAL_LIMIT = 5;

/** How many decided units the triage panel lists (#147's acceptance criterion). */
export const TRIAGE_UNIT_LIMIT = 10;

/** How many timeline activities a panel shows. */
export const TIMELINE_LIMIT = 10;

/** The loop name the runtime records when it could not resolve one. */
const UNNAMED_LOOP = "unknown";

/**
 * Newest first by timestamp, and the later receipt first on a tie. The
 * timestamps are the runtime's own UTC ISO strings, compared as the runtime
 * sorts them. Copies before sorting: the snapshot is not the projection's.
 */
function newestFirst<T>(items: readonly T[], at: (item: T) => string): T[] {
  return items
    .map((item, order) => ({ item, order }))
    .sort((left, right) => {
      const a = at(left.item);
      const b = at(right.item);
      return a < b ? 1 : a > b ? -1 : right.order - left.order;
    })
    .map(({ item }) => item);
}

/**
 * The run's recent activity, newest first, capped.
 *
 * Only activity the runtime attributed to the panel's run is shown. A timeline
 * that could not be read, that does not exist, or whose run is unknown is
 * null — never an empty list, which would read as a loop doing nothing.
 */
function selectTimeline(worktree: RuntimeLoop, run: string | null): TimelineActivityView[] | null {
  const timeline = worktree.timeline ?? null;
  if (timeline === null || !timeline.exists || run === null) return null;
  const mine = timeline.activities.filter((activity) => activity.run === run);
  return newestFirst(mine, (activity) => activity.at).slice(0, TIMELINE_LIMIT);
}

/**
 * The newest runner failure recorded for the panel's run and loop.
 *
 * With none recorded, the answer is `none` only when the run did not fail: a
 * failed run whose record names no runner failure is unknown, because the
 * record is what would distinguish a provider outage from a model-level stop.
 *
 * A run spans many iterations, so the newest failure can be one the loop got
 * past long ago; `current` says whether it still stands.
 */
function selectRunnerFailure(worktree: RuntimeLoop, loop: string, run: string | null): RunnerFailureProjection {
  const record = worktree.runnerFailures ?? null;
  if (record === null || run === null) return { state: "unknown", reason: null, current: false };
  const mine = record.settled.filter(
    (failure: RunnerFailureView) => failure.run === run && (failure.loop === loop || failure.loop === UNNAMED_LOOP),
  );
  const reason = newestFirst(mine, (failure) => failure.at)[0] ?? null;
  const runFailed = worktree.loopStatus === "failed" || worktree.state?.stopReason?.kind === "failed";
  if (reason !== null) {
    const iteration = worktree.state?.iteration?.index ?? null;
    const current = runFailed || iteration === null || reason.iteration === null || reason.iteration >= iteration;
    return { state: "failed", reason, current };
  }
  return { state: runFailed ? "unknown" : "none", reason: null, current: false };
}

/**
 * Pick the worktree that *is* a roster loop.
 *
 * A loop can be named by more than one registry entry — a copy, a moved
 * checkout, a leftover after `git worktree move` — and only one of them has the
 * loop's durable record. Preferring the record-bearing entry keeps the panel
 * pinned to the checkout the loop actually writes to; a recordless duplicate
 * would otherwise win by directory order and show a healthy loop as unknown.
 */
function selectWorktree(loops: readonly RuntimeLoop[], loop: string): RuntimeLoop | null {
  const candidates = loops.filter((entry) => entry.identity === loop);
  return candidates.find((entry) => entry.state !== null) ?? candidates[0] ?? null;
}

/**
 * The usage that belongs to this panel's run, or null.
 *
 * Usage is reported against a run id; a report for any other run — or for a
 * panel whose run is unknown — is somebody else's consumption, and showing it
 * here would attribute tokens to the wrong loop.
 */
function attributeUsage(worktree: RuntimeLoop, run: string | null): UsageView | null {
  const usage = worktree.usage ?? null;
  return usage !== null && run !== null && usage.runId === run ? usage : null;
}

/**
 * The loop's own recent entries, newest first.
 *
 * The runtime hands over the project's whole journal; an entry is this loop's
 * only when it signs it. Unsigned entries belong to no panel. A journal that
 * could not be read stays null, which is different from a loop with none.
 */
function selectJournal(
  journal: readonly JournalEntryView[] | null | undefined,
  loop: string,
  limit: number = JOURNAL_LIMIT,
): JournalEntryView[] | null {
  if (journal === null || journal === undefined) return null;
  return journal
    .filter((entry) => entry.loop === loop)
    .sort((left, right) => right.name.localeCompare(left.name))
    .slice(0, limit);
}

/**
 * The journal outcomes that applied nothing, from the triager's own closed
 * vocabulary (`prompts/triager.md`): `all blocked` took no unit at all, and
 * `retry later` stopped on something outside the repository before writing.
 *
 * `gave up` is NOT here: giving up leaves a marker comment on the issue, which
 * is a write and a decision — it is an applied unit like any other.
 *
 * The test fails OPEN: an entry whose outcome could not be read counts as
 * applied, because a unit the triager decided and this reader could not
 * classify belongs on the panel rather than silently off it.
 */
const UNAPPLIED_OUTCOMES = ["all blocked", "retry later"];

/** Whether a journal entry records a unit the triager actually applied. */
const applied = (entry: JournalEntryView): boolean => {
  if (entry.issue === null) return false;
  const outcome = entry.outcome?.trim().toLowerCase() ?? "";
  return !UNAPPLIED_OUTCOMES.some((word) => outcome.startsWith(word));
};

/**
 * The units a triager has applied, newest first, and the writes it has made.
 *
 * Null for a role the triage panel means nothing to: that is a different thing
 * from a triager with nothing to show. The units come from the journal rather
 * than from the plan files in the worktree, because an entry is the record that
 * outlives the plan — and they are taken off the runtime's whole window, not
 * off the five entries the loop's own journal panel keeps.
 *
 * Two filters and a dedupe: an entry with no issue number took no unit
 * (`--issue none`); an entry whose outcome applied nothing is not an applied
 * unit (`UNAPPLIED_OUTCOMES`); and a unit attempted more than once is ONE row,
 * its latest attempt winning. The dedupe runs before the cap, so ten units
 * still means ten rather than ten entries.
 */
function selectTriage(
  worktree: RuntimeLoop,
  loop: string,
  panels: RolePanels,
): TriageActivityView | null {
  if (!panels.triage) return null;
  const activity = worktree.triage ?? { writesLastHour: null, maxWrites: null, units: [] };
  // Over the whole window, then capped: a repeat attempt on one unit publishes
  // a second entry under the same issue, so deduping after a slice of ten
  // would have shown fewer than ten units and a duplicate React key.
  const entries = selectJournal(worktree.journal, loop, Number.POSITIVE_INFINITY) ?? [];
  const units = new Map<number, TriageUnitView>();
  for (const entry of entries) {
    if (!applied(entry)) continue;
    // Newest first already, so the first entry for an issue is its latest
    // attempt and the earlier ones are history, not separate units.
    if (!units.has(entry.issue!)) {
      units.set(entry.issue!, { issue: entry.issue!, at: entry.at, outcome: entry.outcome, title: entry.title });
    }
    if (units.size === TRIAGE_UNIT_LIMIT) break;
  }
  return { writesLastHour: activity.writesLastHour, maxWrites: activity.maxWrites, units: [...units.values()] };
}

/**
 * The case this doctor's own unexpired lease holds — what its card shows where
 * a coder's shows its ticket.
 *
 * Null when the role has no CI health panel, and null when the store was not
 * read or could not be: a card that said "no case" on the strength of a read
 * that did not happen would be the one wrong answer, and the panel's own
 * `problem` is where an unread store is reported.
 *
 * It reads `view.held`, which the fold builds from EVERY case, rather than
 * searching the lists the panel draws. That distinction is the whole of the
 * correctness here: a parked ticket is leasable — `ci-doctor/gate.ts` returns
 * `parked:<issue>` as a work verdict and the gate leases whatever key it
 * returns — but it is drawn in `parked` rather than in `cases`, so a search
 * over the drawn lists reported "holding no case" for a doctor that was
 * demonstrably mid-unpark. A closed incident is dropped from `incidents` for
 * the same kind of reason.
 *
 * One lease is exclusive, so one doctor against two cases means a lease
 * leaked. `held` is in cost order, so the first wins and the card's answer is
 * stable across polls rather than arbitrary.
 */
function selectCase(ciHealth: CiHealthRead | undefined, loop: string, panels: RolePanels): CiCaseView | null {
  if (!panels.ciHealth) return null;
  const view = ciHealth?.view ?? null;
  if (view === null) return null;
  return view.held.find((entry) => entry.heldBy === loop) ?? null;
}

/** A roster loop the runtime did not report at all. It is unknown, not absent-and-fine. */
function absentLoop(loop: string, role: LoopRole, claims: ClaimView[]): DashboardLoop {
  return {
    loop,
    role,
    present: false,
    worktree: null,
    loopStatus: "unknown",
    worktreeStatus: "unknown",
    branch: null,
    supervisor: "unknown",
    run: null,
    issue: null,
    iteration: null,
    stage: null,
    phase: null,
    resumedAt: null,
    stopReason: null,
    stateProblem: null,
    presence: null,
    heartbeat: null,
    lastEvent: null,
    repoUrl: null,
    issueTitle: null,
    actors: [],
    presenceProblem: "unavailable",
    claims,
    usage: null,
    journal: null,
    timeline: null,
    runnerFailure: { state: "unknown", reason: null, current: false },
    // A loop the runtime never reported has no ledgers and no journal to read,
    // whatever its role: unknown writes, an unknown cap, no units.
    triage: ROLE_PANELS[role].triage ? { writesLastHour: null, maxWrites: null, units: [] } : null,
    // A lease names the worktree's loop, and this one has no worktree the
    // runtime reported: it can hold nothing.
    case: null,
  };
}

/** Only an expiry still in the future is evidence of a live claim. */
function claimStatus(lease: LeaseView, clock: Clock): ClaimStatus {
  const expires = Date.parse(lease.expiresAt);
  if (Number.isNaN(expires)) return "unknown";
  return expires > clock.nowMs ? "active" : "expired";
}

/**
 * Join the two halves of a claim — the lease and the label — per loop.
 *
 * A lease makes a claim for the loop that holds it; a label makes one for the
 * loop it names; the same loop on both is one claim. A label with no lease for
 * its loop has no expiry to trust, so it is `unknown`. Leases are never
 * deleted, so a lapsed lease is listed only while something still points at
 * it: the loop's label, or the loop's current run.
 */
function attributeClaims(runtime: RuntimeSnapshot, clock: Clock): ClaimView[] {
  if (runtime.claims === undefined) return [];
  const { leases, github } = runtime.claims;
  const roster = rosterNames(runtime.roster);
  const key = (issue: number, loop: string): string => `${issue}#${loop}`;
  const titles = new Map<number, string>();
  for (const claim of github ?? []) if (!titles.has(claim.issue)) titles.set(claim.issue, claim.title);
  const labeled = new Set((github ?? []).map((claim) => key(claim.issue, claim.loop)));
  const currentRuns = new Set(runtime.loops.flatMap((entry) => (entry.state ? [entry.state.run] : [])));

  const claims = new Map<string, ClaimView>();
  for (const lease of leases ?? []) {
    const id = key(lease.issue, lease.loop);
    if (!roster.includes(lease.loop) || claims.has(id)) continue;
    const status = claimStatus(lease, clock);
    if (status === "expired" && !labeled.has(id) && !currentRuns.has(lease.run)) continue;
    claims.set(id, {
      issue: lease.issue,
      title: titles.get(lease.issue) ?? null,
      loop: lease.loop,
      status,
      claimedAt: lease.claimedAt,
      expiresAt: lease.expiresAt,
      run: lease.run,
      labeled: github === null ? null : labeled.has(id),
      leased: true,
    });
  }
  for (const label of github ?? []) {
    const id = key(label.issue, label.loop);
    if (!roster.includes(label.loop) || claims.has(id)) continue;
    claims.set(id, {
      issue: label.issue,
      title: label.title,
      loop: label.loop,
      status: "unknown",
      claimedAt: null,
      expiresAt: null,
      run: null,
      labeled: true,
      leased: false,
    });
  }
  return [...claims.values()].sort(
    (a, b) => a.issue - b.issue || roster.indexOf(a.loop) - roster.indexOf(b.loop),
  );
}

/**
 * Map every claimed or in-flight issue to the loop that owns it.
 *
 * A contender is a loop with a claim that has not lapsed — `unknown` counts,
 * because a claim nobody can date may still be live — or a running loop whose
 * current issue it is. Exactly one contender owns the issue; two or more is
 * `contested`, which is the thing the operator is looking for. An issue with
 * only lapsed claims has no owner, and ownership is `active` only when the
 * owner's own claim is.
 */
function ownershipOf(runtime: RuntimeSnapshot, loops: DashboardLoop[], claims: ClaimView[]): Ownership {
  const working = new Map<number, string[]>();
  for (const entry of loops) {
    if (!entry.present || entry.loopStatus !== "running" || entry.issue === null) continue;
    working.set(entry.issue, [...(working.get(entry.issue) ?? []), entry.loop]);
  }
  const roster = rosterNames(runtime.roster);
  const inRosterOrder = (names: Iterable<string>): string[] => {
    const set = new Set(names);
    return roster.filter((loop) => set.has(loop));
  };
  const issueNumbers = [...new Set([...claims.map((claim) => claim.issue), ...working.keys()])].sort(
    (a, b) => a - b,
  );
  const issues = issueNumbers.map((issue): OwnershipEntry => {
    const mine = claims.filter((claim) => claim.issue === issue);
    const workingLoops = working.get(issue) ?? [];
    const contenders = inRosterOrder([
      ...mine.filter((claim) => claim.status !== "expired").map((claim) => claim.loop),
      ...workingLoops,
    ]);
    const owner = contenders.length === 1 ? contenders[0]! : null;
    const status =
      contenders.length > 1
        ? "contested"
        : owner === null
          ? "expired"
          : mine.some((claim) => claim.loop === owner && claim.status === "active")
            ? "active"
            : "unknown";
    return {
      issue,
      title: mine.find((claim) => claim.title !== null)?.title ?? null,
      owner,
      status,
      loops: inRosterOrder(mine.map((claim) => claim.loop)),
      working: workingLoops,
      claims: mine,
    };
  });
  return {
    issues,
    contested: issues.filter((entry) => entry.status === "contested").map((entry) => entry.issue),
    sources: {
      leases: runtime.claims?.leases ? "ok" : "unavailable",
      github: runtime.claims?.github ? "ok" : "unavailable",
    },
  };
}

/**
 * The presence observe reported for this worktree, if it is this loop's.
 *
 * observe names the loop from the record it found for the root it was given;
 * a different name — `unknown` when it could not find one — means the actors
 * and issue it carries cannot be attributed to the panel's loop.
 */
function attributedPresence(
  worktree: RuntimeLoop,
  loop: string,
): { presence: PresenceView | null; problem: PresenceProblem } {
  if (worktree.presence === null) return { presence: null, problem: "unavailable" };
  if (worktree.presence.loop !== loop) return { presence: null, problem: "unattributed" };
  return { presence: worktree.presence, problem: null };
}

/**
 * A `started` boundary with no end is also what a killed loop leaves behind,
 * so `running` is only believed while the process table says the supervisor
 * is alive. Anything else is unknown — never carried forward as healthy.
 */
const projectActors = (actors: readonly ActorView[], supervisor: Liveness): ActorView[] =>
  actors.map((actor) =>
    actor.state === "running" && supervisor !== "alive" ? { ...actor, state: "unknown" } : actor,
  );

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `<loop>/<issue>-<slug>`, the branch shape a loop cuts for a ticket. */
function branchIssue(branch: string | null, loop: string): { issue: number; slug: string | null } | null {
  if (branch === null) return null;
  const match = new RegExp(`^${escapeRegExp(loop)}/(\\d+)(?:-(.+))?$`).exec(branch);
  if (!match) return null;
  const slug = match[2]?.replace(/[-_]+/g, " ").trim();
  return { issue: Number(match[1]), slug: slug ? slug : null };
}

function issueTitleFor(
  issue: number | null,
  presence: PresenceView | null,
  fromBranch: ReturnType<typeof branchIssue>,
): string | null {
  if (issue === null) return null;
  const recorded = presence?.issues.find((entry) => entry.issue === issue && entry.title !== null);
  if (recorded?.title) return recorded.title;
  return fromBranch?.issue === issue ? fromBranch.slug : null;
}

/**
 * Worktrees holding a loop record that resolves to no roster loop. A checkout
 * with no record at all (buildkite, a temporary clone) is not a loop and is
 * left out; one with a record someone wrote is reported rather than dropped.
 */
function unattributedWorktrees(runtime: RuntimeSnapshot): UnattributedWorktree[] {
  const roster = new Set(rosterNames(runtime.roster));
  return runtime.loops
    .filter(
      (entry) =>
        (entry.identity === null || !roster.has(entry.identity)) &&
        (entry.state !== null || entry.stateProblem === "unreadable" || entry.stateProblem === "foreign"),
    )
    .map((entry) => ({
      worktree: entry.worktree,
      owner: entry.state?.owner.loop ?? null,
      loopStatus: entry.loopStatus,
      stateProblem: entry.stateProblem,
    }));
}

/**
 * Assemble the dashboard.
 *
 * The roster drives the output, not the runtime's worktree list: a worktree the
 * roster does not name is never a panel, however healthy the runtime says it
 * is. Reconciliation is passed through untouched and rendered apart from the
 * loops, because an orphaned checkout is a Git fact rather than a loop state.
 */
export function aggregateDashboard(runtime: RuntimeSnapshot, clock: Clock): Dashboard {
  const claims = attributeClaims(runtime, clock);
  const loops = runtime.roster.map(({ name: loop, role }): DashboardLoop => {
    const mine = claims.filter((claim) => claim.loop === loop);
    const worktree = selectWorktree(runtime.loops, loop);
    if (!worktree) return absentLoop(loop, role, mine);
    const { presence, problem } = attributedPresence(worktree, loop);
    const fromBranch = branchIssue(worktree.branch, loop);
    const issue = presence?.issue ?? fromBranch?.issue ?? null;
    const run = worktree.state?.run ?? presence?.run ?? null;
    return {
      loop,
      role,
      present: true,
      worktree: worktree.worktree,
      loopStatus: worktree.loopStatus,
      worktreeStatus: worktree.worktreeStatus,
      branch: worktree.branch,
      supervisor: worktree.supervisor,
      run,
      issue,
      iteration: worktree.state?.iteration ?? presence?.iteration ?? null,
      stage: worktree.state?.stage ?? null,
      phase: worktree.state?.phase ?? null,
      resumedAt: worktree.state?.resumedAt ?? null,
      stopReason: worktree.state?.stopReason ?? null,
      stateProblem: worktree.stateProblem,
      heartbeat: worktree.state?.heartbeat ?? null,
      lastEvent: worktree.state?.lastEvent ?? null,
      repoUrl: worktree.repoUrl ?? null,
      presence,
      issueTitle: issueTitleFor(issue, presence, fromBranch),
      actors: presence === null ? [] : projectActors(presence.actors, worktree.supervisor),
      presenceProblem: problem,
      claims: mine,
      usage: attributeUsage(worktree, run),
      journal: selectJournal(worktree.journal, loop),
      timeline: selectTimeline(worktree, run),
      runnerFailure: selectRunnerFailure(worktree, loop, run),
      triage: selectTriage(worktree, loop, ROLE_PANELS[role]),
      case: selectCase(runtime.ciHealth, loop, ROLE_PANELS[role]),
      ...(worktree.retry === undefined ? {} : { retry: worktree.retry }),
    };
  });
  return {
    generatedAt: new Date(clock.nowMs).toISOString(),
    loops,
    reconciliation: runtime.reconciliation,
    unattributed: unattributedWorktrees(runtime),
    ownership: ownershipOf(runtime, loops, claims),
    frontier: runtime.frontier ?? null,
    ciHealth: runtime.ciHealth ?? null,
    following: runtime.following ?? null,
    learnings: runtime.learnings ?? null,
    tracker: runtime.tracker ?? null,
  };
}
