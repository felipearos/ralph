/**
 * The dashboard's own vocabulary, on this side of the process boundary.
 *
 * Nothing here imports a ralph TypeScript module. The shapes below are the
 * *narrowed* copies of what the runtime's JSON actually contains: the adapter
 * is the only code that knows the CLI names, flags and raw JSON, and it hands
 * the aggregation these types. That is what makes the GUI extractable — move
 * the files, repoint the adapter, and the projection above the seam is
 * unchanged.
 *
 * The unions are declared as runtime arrays plus a type derived from them so
 * the adapter can validate JSON against the same list the type is built from;
 * a second, hand-written list is how a reader and a validator come to disagree.
 */

export const LOOP_STATUSES = [
  "running",
  "idle",
  "blocked",
  "stale",
  "orphaned",
  "failed",
  "completed",
  "interrupted",
  "unknown",
] as const;
export type LoopStatus = (typeof LOOP_STATUSES)[number];

export const WORKTREE_STATUSES = ["live", "stale", "prunable", "orphaned"] as const;
export type WorktreeStatus = (typeof WORKTREE_STATUSES)[number];

export const LIVENESSES = ["alive", "dead", "unknown"] as const;
export type Liveness = (typeof LIVENESSES)[number];

export const STAGES = [
  "starting",
  "preflight",
  "gate",
  "iteration",
  "paused",
  "stopped",
] as const;
export type Stage = (typeof STAGES)[number];

/** An iteration's phases, in `prompt.md`'s order; the runtime's roster is `ralph/phase.ts`. */
export const PHASES = ["select", "implement", "verify", "review", "finish"] as const;
export type Phase = (typeof PHASES)[number];

/**
 * The roles a loop can hold, mirroring the runtime's roster in `ralph/roles.ts`.
 * A role decides which of a loop's panels mean anything: only a coder shepherds
 * a pull request, waits on CI, takes the host lease or runs in phases.
 */
export const LOOP_ROLES = ["coder", "triager", "ci-doctor", "pr-medic", "clerk", "verifier", "sentinel"] as const;
export type LoopRole = (typeof LOOP_ROLES)[number];

/**
 * Which of a loop's panels its role gives any meaning. A triager neither opens
 * pull requests nor waits on CI nor takes the host lease nor runs in phases, so
 * a panel about any of those would describe something that cannot happen; it is
 * hidden rather than shown empty, which would read as "none yet".
 *
 * Mirrored from the role descriptors in `ralph/roles.ts` — `pr` from whether
 * the role may end an iteration with `AWAIT_PR`, `hostLease` and `phases` from
 * the fields of those names — and asserted against them in the dashboard's
 * tests. The panels themselves arrive with their own tickets; this
 * is the rule they are gated on.
 */
export interface RolePanels {
  /**
   * The loop shepherds a pull request of its own, and waits on its CI. One
   * field rather than two, because both are the same capability seen twice:
   * the role may end an iteration with `AWAIT_PR`, whose two forms are the CI
   * wait and the queue wait. A ci-doctor's CI *health* panel is a different
   * thing and has `ciHealth` below, with a source of its own — two booleans
   * that can never disagree only make an edit to the wrong one a silent
   * behaviour change, which is the argument `roles.ts` makes about
   * `requiresDifficultyLabels`.
   */
  pr: boolean;
  /** The loop can ask for the quiet-host lease. */
  hostLease: boolean;
  /** The loop's iteration runs in phases. */
  phases: boolean;
  /**
   * The loop has an intake of its own, so the triage panel means something for
   * it. Its own field, per the argument above: derived from the role here
   * rather than compared against `"triager"` at each reader, so a second role
   * that triages is one edit.
   */
  triage: boolean;
  /**
   * The loop diagnoses CI itself, so the CI health panel and the case line on
   * its card mean something for it.
   *
   * Derived, like `triage`, from what the role's descriptor already says
   * rather than from its name: the role whose preflight requires the
   * `ci-health` label is the role that files cases against it, which is the
   * role whose view of CI health is its own work rather than a bystander's.
   * `dashboard/adapter.test.ts` fences the two.
   */
  ciHealth: boolean;
}

export const ROLE_PANELS: Record<LoopRole, RolePanels> = {
  coder: { pr: true, hostLease: true, phases: true, triage: false, ciHealth: false },
  triager: { pr: false, hostLease: false, phases: false, triage: true, ciHealth: false },
  "ci-doctor": { pr: true, hostLease: true, phases: true, triage: false, ciHealth: true },
  // A medic shepherds a pull request — the operator's, which it hands back to
  // the CI wait exactly as a coder hands back its own — and runs in phases with
  // the host lease. `ciHealth` is false and the distinction is the point: the
  // medic reads a red build as a bystander, to tell this branch's own failure
  // from a flake, and the flake itself stays the doctor's case.
  "pr-medic": { pr: true, hostLease: true, phases: true, triage: false, ciHealth: false },
  // A clerk files Slack reports into Jira: no pull request, no host lease, no
  // phases, and neither the triage nor the CI panel is about its work.
  clerk: { pr: false, hostLease: false, phases: false, triage: false, ciHealth: false },
  // A verifier verifies merged work in production: the pull request is not its
  // own to shepherd, it takes no host lease, runs in one pass, and neither the
  // triage nor the CI panel is about its work.
  verifier: { pr: false, hostLease: false, phases: false, triage: false, ciHealth: false },
  // A sentinel drafts tickets from the error reporter in one pass: no pull
  // request, no host lease, and neither the triage nor the CI panel is its work.
  sentinel: { pr: false, hostLease: false, phases: false, triage: false, ciHealth: false },
};

/**
 * What each role does, in one line: the role badge's tooltip and the line
 * under Add agent's role picker. Mirrored from each descriptor's `summary` in
 * `ralph/roles.ts`, which the dashboard cannot import, and asserted against it
 * in the dashboard's tests.
 */
export const ROLE_SUMMARIES: Record<LoopRole, string> = {
  coder: "takes a ready ticket off the frontier, builds it and shepherds its pull request to merge",
  triager: "reads untriaged issues and makes them ready for a coder, or says why not",
  "ci-doctor": "watches the base branch's CI and diagnoses, retries or fixes what breaks it",
  "pr-medic": "takes a red run on one of the operator's pull requests and gets it back to green",
  clerk: "files the settled reports of one Slack channel on its Jira intake board, and keeps the channel's canvas in step",
  verifier: "follows merged pull requests into production and verifies them against their tickets",
  sentinel: "watches the error reporter and drafts diagnosed tickets for new or regressed production errors",
};

/**
 * The roles whose invariant is `clean-detached` (`roles.ts` `RoleInvariant`,
 * `readOnlyCheckout`): they leave the checkout clean with HEAD detached.
 * Unblock & resume checks a halted loop's worktree against it before
 * restarting (`chat-handback.ts`). A mirror, like the role list, and asserted
 * against the descriptors in `adapter.test.ts`.
 */
export const readOnlyCheckoutRoles: readonly LoopRole[] = ["triager", "clerk", "verifier", "sentinel"];

/**
 * The roles that take frontier work, so a Jav route can be made for them —
 * mirroring `roleDescriptor(role).javRouted` in `ralph/roles.ts`, the field
 * `jav.ts` (`:111-117`) and the frontier both gate on. Read off that rather
 * than off `role === "coder"` for the reason `jav.ts` gives: a role added
 * later with `javRouted: true` must not need a second edit here to be routed.
 * A new agent's Jav readiness item applies to these roles alone; for any other
 * it describes a route `jav.ts` would refuse. Asserted against the descriptors
 * in `adapter.test.ts`.
 */
export const javRoutedRoles: readonly LoopRole[] = ["coder"];

/** The loops that have an intake, in the order given. */
export const triagers = <T extends { role: LoopRole }>(loops: readonly T[]): T[] =>
  loops.filter((entry) => ROLE_PANELS[entry.role].triage);

/** The loops that diagnose CI, in the order given. */
export const doctors = <T extends { role: LoopRole }>(loops: readonly T[]): T[] =>
  loops.filter((entry) => ROLE_PANELS[entry.role].ciHealth);

/** The loops that follow merged work into production, in the order given. */
export const verifiers = <T extends { role: LoopRole }>(loops: readonly T[]): T[] =>
  loops.filter((entry) => entry.role === "verifier");

/**
 * One roster entry: the loop's name and the role it holds. The project config
 * may spell an entry as a bare name, which is a coder; by the time it reaches
 * the dashboard the role is always resolved, so nothing above the adapter has
 * to know the file's two forms.
 */
export interface RosterLoop {
  name: string;
  role: LoopRole;
}

/**
 * A roster of coders, by name — the shape every project had before roles, and
 * still the shape of most of them. Canned and fixture rosters say it this way
 * rather than repeating `role: "coder"` on every entry.
 */
export const coderRoster = (...names: string[]): RosterLoop[] => names.map((name) => ({ name, role: "coder" }));

/** A roster's names, in its own order, for the reads that only identify a loop. */
export const rosterNames = (roster: readonly RosterLoop[]): string[] => roster.map((entry) => entry.name);

export const STOP_KINDS = ["completed", "blocked", "failed", "interrupted"] as const;
export type StopKind = (typeof STOP_KINDS)[number];

/**
 * The kinds an orderly stop may ask for. `interrupted` is read, never sent:
 * the loop records it only after a Stop now's signal has ended the supervisor.
 */
export const ORDERLY_STOP_KINDS = ["completed", "blocked", "failed"] as const satisfies readonly StopKind[];

/**
 * The problems a durable record can have, matching the runtime's own names.
 *
 * Declared as a runtime array plus a derived type for the same reason as the
 * unions above: the adapter validates against this list, and a second
 * hand-written one is how a reader and a validator come to disagree. `null` is
 * "no problem", which is why the nullable form is its own alias.
 */
export const STATE_PROBLEMS = ["missing", "unreadable", "foreign"] as const;
export type StateProblem = (typeof STATE_PROBLEMS)[number] | null;

/** The checkouts Git reports as gone or prunable, kept off the loop panels. */
export interface Reconciliation {
  orphaned: string[];
  prunable: string[];
}

/**
 * A plain environment map.
 *
 * The app's `NodeJS.ProcessEnv` is augmented by Next.js to require `NODE_ENV`,
 * which the dashboard's own config signatures have no business demanding. This
 * keeps the tool's public shape free of the app's type graph, the same way it
 * stays free of the app's imports.
 */
export type Env = Record<string, string | undefined>;

export interface Iteration {
  index: number;
  max: number | null;
}

export interface StopReason {
  kind: StopKind;
  why: string;
  at: string;
  // Who ended the supervisor and with which signal (#6): the trap records
  // `self: true` and the signal on an `interrupted` stop, an operator's Stop
  // records `self: false`. Records written before #6 carry neither, so both are
  // optional and the reconciler treats their absence as "not known".
  signal?: string;
  self?: boolean;
}

export interface LoopEvent {
  name: string;
  at: string;
  detail?: string;
}

/** The durable loop record, narrowed from `loop-state status --json`. */
export interface LoopStateView {
  version: 1;
  run: string;
  owner: { loop: string; pid: number | null; host: string };
  worktree: string;
  branch: string | null;
  stage: Stage;
  iteration: Iteration | null;
  heartbeat: string;
  lastEvent: LoopEvent | null;
  stopReason: StopReason | null;
  /** The session of the iteration in progress, or of the last one, when recorded. */
  session?: string;
  /** The phase of the iteration in progress, when the record names one. */
  phase?: Phase;
  /** The phase an iteration resumed an interrupted ticket at, while it is still in it. */
  resumedAt?: Phase;
  /** When the loop last finished an iteration, across runs, when the record has one. */
  lastIterationEndAt?: string;
}

/** The runner stages a loop's timeline names, in the runtime's own order. */
export const ACTOR_STAGES = [
  "orchestrator",
  "executor",
  "mapper",
  "review.standards",
  "review.spec",
  "review.correctness",
] as const;
export type ActorStage = (typeof ACTOR_STAGES)[number];

/** `unknown` is a first-class answer: no boundary was observed for the stage. */
export const ACTOR_STATES = ["running", "completed", "failed", "degraded", "unknown"] as const;
export type ActorState = (typeof ACTOR_STATES)[number];

export const ISSUE_STATES = ["active", "merged", "pr", "handoff", "blocked", "failed"] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

/** One stage actor, as observe projects it from the iteration's timeline. */
export interface ActorView {
  stage: ActorStage;
  state: ActorState;
  invocation: string | null;
  runner: string | null;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  lastAction: string | null;
  activityAt: string | null;
}

/** One recorded outcome from the loop's own journal and failure ledger. */
export interface IssueHistoryView {
  issue: number;
  state: IssueState;
  pr: number | null;
  draft: boolean;
  title: string | null;
  detail: string | null;
  /** For a blocked outcome, whether it waits on a person applying a migration; else null. */
  block: JournalBlockKind | null;
  at: string;
}

/** One timeline event the observer surfaced as recent activity. */
export interface ActivityView {
  stage: string;
  label: string;
  at: string;
  iteration: number | null;
  run: string | null;
}

/** The observer's own reading of what the loop is doing right now. */
export interface StepView {
  stage: string;
  action: string;
}

export interface PhaseView {
  index: number;
  total: number;
  label: string;
}

/** One loop's live presence, narrowed from `observe --json`. */
export interface PresenceView {
  loop: string;
  run: string | null;
  status: LoopStatus;
  supervisor: Liveness;
  issue: number | null;
  branch: string | null;
  iteration: Iteration | null;
  observedAt: string;
  issues: IssueHistoryView[];
  actors: ActorView[];
  recent: ActivityView[];
  failureReason: string | null;
  step: StepView | null;
  phase: PhaseView;
  warning: string | null;
}

/** One scope's token counts, raw integers, as `usage.py --json` reports them. */
export interface TokenUsage {
  input: number;
  output: number;
  cache5m: number;
  cache1h: number;
  cacheRead: number;
  /** Every non-output column summed. */
  inputTotal: number;
}

/**
 * A loop's token usage, narrowed from `usage.py --json --no-record`.
 *
 * `run` is null when the worktree has no usage ledger, because without one the
 * run total would silently be just this session. `context.window` and
 * `context.percent` are null when the model's window is unknown, rather than
 * the `0` the CLI prints for them.
 */
export interface UsageView {
  session: string;
  runId: string;
  iteration: {
    turns: number;
    elapsedSeconds: number | null;
    usage: TokenUsage;
    models: { model: string; usage: TokenUsage }[];
  };
  run: { steps: number; usage: TokenUsage } | null;
  context: {
    model: string | null;
    tokens: number;
    window: number | null;
    percent: number | null;
  };
}

/**
 * One published journal entry, read from the harness's `origin/main`.
 *
 * Every field but `name` is what the entry itself says, and null when it does
 * not say it: `loop` is only ever the loop the entry signs (`Loop: **name**`),
 * never inferred.
 */
export interface JournalEntryView {
  name: string;
  at: string | null;
  issue: number | null;
  loop: string | null;
  title: string | null;
  outcome: string | null;
}

/** One timeline activity, narrowed from `timeline.ts --json`; `label` is ANSI-free. */
export interface TimelineActivityView {
  stage: ActorStage;
  label: string;
  at: string;
  iteration: number | null;
  run: string | null;
}

/**
 * One worktree's timeline for the loop's run. `exists` is false when no
 * iteration event file matched — absence, which the projection shows as
 * unknown rather than as a quiet loop.
 */
export interface TimelineView {
  exists: boolean;
  path: string | null;
  activities: TimelineActivityView[];
}

export const FAILURE_VISIBILITIES = ["live", "post-hoc"] as const;
export type FailureVisibility = (typeof FAILURE_VISIBILITIES)[number];

/**
 * One settled runner failure, narrowed from `runner-failure.ts status --json`.
 * `kind` is the runtime's classification (`api-error`, `timeout`, …), kept as
 * a string because the kinds live in the runtime's signal file, not here.
 */
export interface RunnerFailureView {
  at: string;
  /** The loop the runtime attributed the failure to, or `unknown`. */
  loop: string;
  run: string | null;
  iteration: number | null;
  stage: string;
  runner: string | null;
  model: string | null;
  issue: number | null;
  exitCode: number;
  kind: string;
  summary: string;
  visibility: FailureVisibility;
  /** The redacted evidence lines, in the order the runtime kept them. */
  evidence: string[];
  note: string | null;
}

/** The runner-failure ledger for one worktree, scoped to the loop's run. */
export interface RunnerFailuresView {
  settled: RunnerFailureView[];
}

/**
 * `failed` carries the reason; `none` is a readable record with nothing for a
 * run that did not fail; `unknown` is everything else — no readable record, no
 * known run, or a failed run whose record says nothing.
 */
export const RUNNER_FAILURE_STATES = ["failed", "none", "unknown"] as const;
export type RunnerFailureState = (typeof RUNNER_FAILURE_STATES)[number];

export interface RunnerFailureProjection {
  state: RunnerFailureState;
  reason: RunnerFailureView | null;
  /**
   * Whether `reason` still stands: it is from the loop's present iteration, or
   * the run failed, or either iteration is unknown. A failure from an earlier
   * iteration of a run that carried on is one the loop got past, and is not
   * raised on the card. False when there is no reason.
   */
  current: boolean;
}

/**
 * Why a panel carries no live presence. `unavailable` is observe that could
 * not be run or read for the worktree; `unattributed` is observe that ran but
 * named a different loop (or `unknown`) for it, so its actors are not this
 * loop's to show.
 */
export const PRESENCE_PROBLEMS = ["unavailable", "unattributed"] as const;
export type PresenceProblem = (typeof PRESENCE_PROBLEMS)[number] | null;

/**
 * An errored loop's place on the reconciler's retry schedule. `attempt` is
 * 1-based and `of` is the schedule's length, both copied from the newest
 * `loop-retried` record raised since the loop's last finished iteration.
 * `nextAt` is the ISO time of the next attempt, and null exactly when `spent`:
 * the attempt was the schedule's last.
 */
export interface LoopRetryView {
  attempt: number;
  of: number;
  cause: string;
  nextAt: string | null;
  spent: boolean;
}

/**
 * One registered worktree after the adapter has reconciled it.
 *
 * `identity` is the loop name the worktree is attributed to — the state owner
 * or `ralph/.loop-name`, narrowed to the roster — or null when the worktree is
 * not a loop at all. A null identity is what keeps `buildkite`, temporary and
 * unrelated checkouts out of the loop panels without dropping them from the
 * reconciliation section.
 */
export interface RuntimeLoop {
  worktree: string;
  identity: string | null;
  loopStatus: LoopStatus;
  worktreeStatus: WorktreeStatus;
  branch: string | null;
  state: LoopStateView | null;
  stateProblem: StateProblem;
  supervisor: Liveness;
  /** From the per-worktree observe fan-out; null when it could not be read. */
  presence: PresenceView | null;
  /** The checkout's `origin` as a GitHub web URL; null or absent when it is not on GitHub or unreadable. */
  repoUrl?: string | null;
  /** Token usage for the recorded run and session; null or absent when unknown. */
  usage?: UsageView | null;
  /** The project's recent journal, every loop's entries; null or absent when unreadable. */
  journal?: JournalEntryView[] | null;
  /**
   * What this worktree's triage apply ledgers say it has written. The adapter
   * reads them only for a worktree the roster names a triager; every other
   * loop is null, because a `readdir` per coder per poll would be work for a
   * panel that is null anyway.
   */
  triage?: TriageActivityView | null;
  /** The loop's run timeline; null or absent when it could not be read. */
  timeline?: TimelineView | null;
  /** The loop's run's runner failures; null or absent when they could not be read. */
  runnerFailures?: RunnerFailuresView | null;
  /**
   * Where the loop stands on the retry schedule. Absent means "not being
   * retried, or the feed could not be read" — deliberately one state on the
   * page, which has nothing different to show for the two.
   */
  retry?: LoopRetryView;
}

/**
 * Everything the adapter read in one pass: the roster, every discovered
 * worktree, and the reconciliation the runtime reported for checkouts that are
 * gone or prunable.
 */
export interface RuntimeSnapshot {
  roster: readonly RosterLoop[];
  loops: RuntimeLoop[];
  reconciliation: Reconciliation;
  /**
   * The claim sources. Optional so a snapshot built without them (an older
   * adapter, a test double) reads as "claims unknown", never as "no claims".
   */
  claims?: RuntimeClaims;
  /** The backlog picture. Optional for the same reason as `claims`. */
  frontier?: FrontierRead;
  /**
   * The project's CI health, from the ci-doctor's store. Per PROJECT, not per
   * loop: the store lives in the git common directory and every worktree of
   * the project shares one. Optional for the same reason as `claims`.
   */
  ciHealth?: CiHealthRead;
  /**
   * The open learnings for this project and for the harness. Per PROJECT, and
   * read out of the HARNESS repository's `origin/main` — that is where every
   * loop publishes, so it is the only ref that holds what the other loops
   * learned. Optional for the same reason as `claims`.
   */
  learnings?: LearningsRead;
  /**
   * What the project's verifier is following, from its watch store. Per
   * PROJECT, like `ciHealth`, and read only when the roster names a verifier:
   * absent means no verifier here, not an empty store.
   */
  following?: FollowingRead;
  /** Where the project's tickets link and how they are spelt. Optional: absent reads as GitHub issues. */
  tracker?: TrackerLinkView;
}

/**
 * Where a ticket number links and how it is written (#339): `#184` on the
 * repo's GitHub issues, `AND-184` in a Linear workspace, `OA-410` on a Jira
 * site. `link` holds `{n}` where the number goes; null when unknown.
 */
export interface TrackerLinkView {
  kind: "github" | "linear" | "jira" | "local";
  prefix: string;
  link: string | null;
}

/**
 * The local half of a snapshot: the roster and every worktree's durable loop
 * state, from `loop-state status --json` and the project config alone. No
 * `gh` and no per-loop reads: it is how a project the operator is not looking
 * at is read.
 */
export interface LocalSnapshot {
  roster: readonly RosterLoop[];
  loops: Pick<RuntimeLoop, "worktree" | "identity" | "loopStatus" | "worktreeStatus" | "state" | "supervisor">[];
}

/** One durable claim lease, narrowed from `claim-lease status --json`. */
export interface LeaseView {
  issue: number;
  run: string;
  loop: string;
  owner: string;
  host: string;
  worktree: string;
  branch: string | null;
  claimedAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

/**
 * One open GitHub issue carrying a roster loop's claim label, narrowed from
 * `gh issue list --json`. The adapter resolves the label to `loop`, so the
 * label convention stays on its side of the seam.
 */
export interface GithubClaimView {
  issue: number;
  title: string;
  loop: string;
}

/** Each source is null when it could not be read: unknown, not empty. */
export interface RuntimeClaims {
  leases: LeaseView[] | null;
  github: GithubClaimView[] | null;
}

export const CLAIM_STATUSES = ["active", "expired", "unknown"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/**
 * One ticket a loop claims. `active` only when a lease for that loop has an
 * expiry still in the future; a label with no lease, an unreadable lease
 * store or an unparseable expiry is `unknown`, and a lapsed lease `expired`.
 */
export interface ClaimView {
  issue: number;
  title: string | null;
  loop: string;
  status: ClaimStatus;
  /** When the lease was taken; null for a label with no lease, which nobody can date. */
  claimedAt: string | null;
  expiresAt: string | null;
  run: string | null;
  /** The loop's claim label is on the issue; null when GitHub could not be read. */
  labeled: boolean | null;
  leased: boolean;
}

export const OWNERSHIP_STATUSES = ["active", "expired", "unknown", "contested"] as const;
export type OwnershipStatus = (typeof OWNERSHIP_STATUSES)[number];

/**
 * Who owns one claimed or in-flight issue, machine-wide. `owner` is set only
 * when exactly one loop contends for it; two or more is `contested`, and an
 * issue whose every claim has lapsed has no owner at all.
 */
export interface OwnershipEntry {
  issue: number;
  title: string | null;
  owner: string | null;
  status: OwnershipStatus;
  /** Every loop with a claim on the issue, expired ones included. */
  loops: string[];
  /** Loops currently running with this issue as their work. */
  working: string[];
  claims: ClaimView[];
}

export type SourceHealth = "ok" | "unavailable";

export interface Ownership {
  issues: OwnershipEntry[];
  contested: number[];
  sources: { leases: SourceHealth; github: SourceHealth };
}

/* -------------------------------------------------------------- frontier */

/**
 * Why a stuck ticket is stuck, as `block-reason.ts` reads its comments:
 * `migration` waits only on a person applying a migration; `ci-flake` is a
 * coder parking a pull request on a flaky test, which the panel shows as the
 * ci-doctor's rather than as human triage; `other` is any other recorded
 * reason; `unknown` is no record, or none could be read.
 *
 * A hand-kept copy of `block-reason.ts`'s own list, because this module is the
 * dashboard's standalone contract surface and imports nothing from the
 * harness. The two must move together: `adapter.ts` validates an incoming
 * `kind` against this list with `oneOf`, which THROWS on a value it does not
 * hold, and `frontier/next-tasks.ts` spreads raw `BlockReason`s into
 * `stuckReasons`. `dashboard/contract-parity.test.ts` is what keeps them
 * honest.
 */
export const BLOCK_KINDS = ["migration", "ci-flake", "other", "unknown"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

/**
 * As `block-reason.ts`'s `JOURNAL_BLOCK_KINDS`: what a journal `**Outcome:**`
 * line can name, which is narrower than what a block comment can. A list, not
 * only a type, because `adapter.ts` validates it at runtime — and pinned
 * against the harness's copy by `dashboard/contract-parity.test.ts`.
 */
export const JOURNAL_BLOCK_KINDS = ["migration", "other"] as const;
export type JournalBlockKind = (typeof JOURNAL_BLOCK_KINDS)[number];

/** One stuck ticket and its block reason. */
export interface StuckReason extends FrontierTicket {
  kind: BlockKind;
  /** The block record's first line, as the loop wrote it. */
  reason: string | null;
  /** The PR it names: for a migration, the draft carrying the finished code. */
  pr: number | null;
  /** The migration file to apply, when the record names one. */
  migration: string | null;
  at: string | null;
  /** The frontier's park for this ticket, or null when no live park names it (#776/#777). */
  park: ParkReason | null;
}

/**
 * What a parked ticket can wait on, in order. A hand-kept copy of
 * `park-store.ts`'s `CONDITION_KINDS`: `adapter.ts` validates an incoming
 * `kind` against it with `oneOf`, which throws on one it does not hold, so
 * `dashboard/contract-parity.test.ts` pins the two together.
 */
export const PARK_CONDITION_KINDS = ["reference", "check", "step", "label-removed"] as const;
export type ParkConditionKind = (typeof PARK_CONDITION_KINDS)[number];

/** A mirror of `park-store.ts`'s `Condition`: the wake condition a park waits on. */
export type ParkCondition =
  | { kind: "reference"; ref: string }
  | { kind: "check"; name: string; on: "pr" | "main" }
  | { kind: "step"; check: string; step: string }
  | { kind: "label-removed"; label: string };

/**
 * The frontier's park for a stuck ticket (#776/#777): what it waits on and how
 * long before the park probe gives up on it. A mirror of
 * `frontier/next-tasks.ts`'s `ParkReason`, pinned by
 * `dashboard/contract-parity.test.ts`.
 */
export interface ParkReason {
  loop: string;
  /** The `<loop>-blocked` label the park was recorded with. */
  label: string;
  pr: number | null;
  summary: string;
  condition: ParkCondition;
  since: string;
  budgetUntil: string;
  /** Whole seconds from the report's clock to `budgetUntil`, never below 0. */
  remainingSeconds: number;
  expired: boolean;
  escalatedAt: string | null;
}

/** A backlog ticket as the frontier names it. */
/**
 * The triager's intake buckets, in the intake's own priority order.
 *
 * A mirror of `frontier/next-tasks.ts`'s list, not an import: `contracts.ts`
 * imports no ralph module, so the dashboard can be read without the harness.
 * `dashboard/adapter.test.ts` fences the two against each other.
 */
export const TRIAGE_BUCKETS = ["staffing", "routing", "intake", "oversize", "rescue"] as const;
export type TriageBucket = (typeof TRIAGE_BUCKETS)[number];

/**
 * One unit a triager has decided, as its journal entry records it.
 *
 * The journal is the record of a triage decision that outlives the plan file,
 * so it is what the panel lists. `outcome` is the triager's own vocabulary
 * (`routed (7 tickets)`, `split into #a, #b`, `gave up`, …), not a closed set
 * the dashboard can narrow — it is prose, shown as written.
 */
export interface TriageUnitView {
  issue: number;
  at: string | null;
  outcome: string | null;
  title: string | null;
}

/**
 * `RALPH_TRIAGE_MAX_WRITES`'s default, mirrored from `triage/validate.ts`.
 *
 * A mirror because this file imports no ralph module — the same reason the
 * bucket list is one. `dashboard/adapter-triage.test.ts` fences the two against
 * the real `triageLimits`.
 */
export const TRIAGE_MAX_WRITES_DEFAULT = 30;

/** A triager's recent intake work: what it wrote, and the units it decided. */
export interface TriageActivityView {
  /**
   * GitHub writes this triager applied in the TRAILING hour, from its apply
   * ledgers. Null when they could not be read, which is not the same as a
   * triager that has written nothing. The trailing hour rather than the clock
   * hour because the number is about pace, and a clock hour reads zero at
   * 14:00 however much landed at 13:59.
   */
  writesLastHour: number | null;
  /**
   * The cap a plan would be held to in the DASHBOARD's environment —
   * `RALPH_TRIAGE_MAX_WRITES`, else the documented default the validator
   * applies. That is the triager's cap too unless a host sets the variable for
   * one process and not the other. Null only when the runtime never read this
   * loop's triage at all, which is unknown rather than uncapped.
   *
   * It is a PER-PLAN cap, not a per-hour budget: nothing in the harness
   * rate-limits a triager by the hour. It is shown beside `writesLastHour` as
   * the scale a plan is measured on, not as a limit the writes above are
   * approaching.
   */
  maxWrites: number | null;
  /** The newest units first, as many as the panel asked for. */
  units: TriageUnitView[];
}

export interface FrontierTicket {
  number: number;
  title: string;
}

/** One READY NOW staffing group: the spec it belongs to and the ticket it offers. */
export interface FrontierGroup {
  spec: FrontierTicket | null;
  staffingGroup: string | null;
  /** Unblocked siblings held back because this group's ticket is the pick. */
  waiting: number;
  tickets: (FrontierTicket & { frees: number; stuck: string | null })[];
}

export const TREE_STATES = ["done", "ready", "in-flight", "occupied", "blocked", "open"] as const;
export type TreeState = (typeof TREE_STATES)[number];

/**
 * Why a ticket waits on the operator rather than a loop, as
 * `frontier/next-tasks.ts`'s `humanReason` decides it: triaged for a person,
 * waiting on its reporter, held by `plan.md`'s out-of-scope list, or untriaged
 * with no triager to triage it.
 */
export const HUMAN_REASONS = ["ready-for-human", "needs-info", "held", "untriaged"] as const;
export type HumanReason = (typeof HUMAN_REASONS)[number];

/** One ticket in the by-spec tree, nested under the sibling that blocks it. */
export interface FrontierTreeNode {
  number: number;
  title: string;
  state: TreeState;
  /** The `<loop>-blocked` label it carries, or null. */
  stuck: string | null;
  /** Who holds it, or which ticket holds its group. */
  detail: string | null;
  /** Blockers its position in the tree does not already show. */
  otherBlockers: number[];
  /** For an occupied ticket, the ticket holding its staffing group. */
  heldBy: number | null;
  frees: number;
  /** Why it waits on the operator; null for agent work. */
  human: HumanReason | null;
  children: FrontierTreeNode[];
}

/** One spec and its tickets, or a parentless ticket as its own group. */
export interface FrontierTreeGroup {
  spec: {
    number: number;
    title: string | null;
    state: TreeState | null;
    detail: string | null;
    stuck: string | null;
    blockers: number[];
  } | null;
  under: number | null;
  subSpecs: number[];
  /** Children ever written, open and closed. */
  total: number;
  /** Every child has closed. */
  complete: boolean;
  specStillOpen: boolean;
  roots: FrontierTreeNode[];
}

/**
 * The project's backlog as `frontier/next-tasks.ts --dry-run --json` buckets
 * it: what a loop would start now, what is held behind a pick, what is in
 * flight and under whose claim, and what is blocked and by which ticket. A
 * read-only picture; the dashboard never claims from it.
 */
export interface FrontierView {
  ready: FrontierGroup[];
  occupied: (FrontierTicket & { heldBy: number })[];
  specs: (FrontierTicket & { children: number })[];
  inFlight: (FrontierTicket & { loop: string | null; claim: string; queued: boolean })[];
  blocked: (FrontierTicket & { blockers: number[]; stuck: string | null })[];
  /** Blockers that gate queued work but are not themselves queued. */
  gates: FrontierTicket[];
  stuck: (FrontierTicket & { label: string })[];
  /** The same backlog grouped by spec, as the script's `--tree` draws it. */
  tree: FrontierTreeGroup[];
  /** Why each ticket carrying a `<loop>-blocked` label is stuck, wherever it is bucketed. */
  stuckReasons: StuckReason[];
  /**
   * Ready tickets carrying none of the project's Jav labels, which no loop
   * takes while routing is on — except a ci-doctor filing, which routing exempts
   * and every loop is offered (`ROUTING_EXEMPT_LABELS`, felipearos/ralph#233).
   * Each is also in `ready` or `occupied`, so this is a second view of them, not
   * a bucket of its own. Empty when the project configures no Jav labels — which
   * is why an empty list reads as "nothing to route", not as "routing is off".
   */
  untriaged: FrontierTicket[];
  /**
   * How many units wait in each of the triager's intake buckets.
   *
   * The intake hands over only the first non-empty bucket, so a non-zero count
   * below the leading one is backlog a triager has not reached — not work in
   * hand, and not a queue anyone is stuck behind. `routing` is `untriaged`
   * after the triager's own eligibility fence, so it is never larger.
   */
  triage: Record<TriageBucket, number>;
  /**
   * Open tickets that wait on the operator rather than a loop, and why — the
   * tree's `human` marks, flat. Empty from a frontier that predates the field.
   */
  human: (FrontierTicket & { reason: HumanReason })[];
  /**
   * Open tickets with a reference under `## Blocked by` or `## Parent` the
   * frontier does not count as an edge (another repository's or tracker's), so
   * such a ticket may only look unblocked. Empty from a frontier that predates
   * the field.
   */
  dropped: (FrontierTicket & { references: FrontierDroppedReference[] })[];
}

/** One reference the frontier dropped, as `frontier/next-tasks.ts` reports it. */
export interface FrontierDroppedReference {
  /** The section it sat under: "Blocked by" or "Parent". */
  heading: string;
  /** The reference as written, e.g. "example-org/other#15" or "OPS-12". */
  reference: string;
  /** Why it is not an edge, in one plain sentence. */
  reason: string;
}

/**
 * The frontier read, stamped with when it was taken. The read is slow — one
 * tracker census per call — so the adapter serves it from a short cache and
 * `readAt` says how old the picture is. `view` is null when it could not be
 * read: unknown, never an empty backlog.
 */
export interface FrontierRead {
  /** When `view` was read: on a stale read, the last census that succeeded. */
  readAt: string;
  view: FrontierView | null;
  /**
   * Why the latest read failed: with a null `view`, why there is nothing to
   * show; with a view, why it is stale (see `failedAt`).
   */
  problem: string | null;
  /**
   * When the latest refresh failed while `view` is the last good census kept
   * from an earlier one. Absent or null: `view`, when present, is fresh.
   */
  failedAt?: string | null;
  /**
   * Where each ticket's pull request stands, read beside the frontier rather
   * than inside it: the loops' census needs only that a PR exists, and asking
   * it for check runs would make every claim pay for the dashboard's colours.
   * Absent or null is unknown, and the backlog then draws no PR state at all.
   */
  prs?: PullStatusView[] | null;
}

/**
 * A pull request's standing, as an operator reads it at a glance: landed, in
 * the merge queue, green and waiting, still being tested, or red. `open` is a
 * PR with no checks reported at all, which is neither green nor testing.
 */
export const PULL_STATES = ["merged", "queued", "green", "testing", "failing", "open"] as const;
export type PullState = (typeof PULL_STATES)[number];

/** The newest PR that closes one ticket: an open PR beats a merged one, since it is the work in hand. */
export interface PullStatusView {
  issue: number;
  pr: number;
  state: PullState;
  draft: boolean;
  /** When a merged PR landed; null for an open one, or when GitHub did not say. */
  mergedAt: string | null;
}

/**
 * The source of "now" for the projection.
 *
 * Injected rather than read from `Date` so the pure aggregation can be tested
 * against a fixed instant instead of around it. The adapter gathers the
 * runtime; the clock is the only other input.
 */
export interface Clock {
  nowMs: number;
}

/**
 * One loop panel in the dashboard. `present` is false for a roster loop with no
 * attributed worktree, and such a panel says `unknown` rather than success.
 */
export interface DashboardLoop {
  loop: string;
  /** The role the roster gives this loop; a loop the config names as a bare string is a coder. */
  role: LoopRole;
  present: boolean;
  worktree: string | null;
  loopStatus: LoopStatus;
  worktreeStatus: WorktreeStatus | "unknown";
  branch: string | null;
  supervisor: Liveness;
  run: string | null;
  issue: number | null;
  iteration: Iteration | null;
  stage: Stage | null;
  /** The phase of the iteration in progress; null between iterations or when unrecorded. */
  phase: Phase | null;
  /** Set while the iteration is in the phase it resumed an interrupted ticket at, from the ticket's ledger. */
  resumedAt: Phase | null;
  stopReason: StopReason | null;
  stateProblem: StateProblem;
  /** Only presence observe attributed to this loop; null otherwise. */
  presence: PresenceView | null;
  /** From the durable record; null when there is none to read. */
  heartbeat: string | null;
  lastEvent: LoopEvent | null;
  /** Where `#issue` and `#pr` link to; null when the loop's repo is unknown. */
  repoUrl: string | null;
  /** The tickets this loop claims, by issue number. */
  claims: ClaimView[];
  /** Derived from the loop's issue history, else its `<loop>/<issue>-<slug>` branch. */
  issueTitle: string | null;
  /** Stage actors; a `running` actor with no live supervisor reads `unknown`. */
  actors: ActorView[];
  presenceProblem: PresenceProblem;
  /** Usage attributed to this loop's run; null is unknown, never zero. */
  usage: UsageView | null;
  /** This loop's recent entries, newest first; null is unknown, `[]` is none. */
  journal: JournalEntryView[] | null;
  /** This run's recent timeline activity, newest first; null is unknown, `[]` is none. */
  timeline: TimelineActivityView[] | null;
  /** The newest runner failure recorded for this run, or why there is none to show. */
  runnerFailure: RunnerFailureProjection;
  /**
   * This triager's recent intake work. Null when the loop is not a triager —
   * the panel does not apply, which is why it is null rather than an empty
   * activity. A triager whose ledgers could not be read is present here with
   * `writesLastHour: null`.
   */
  triage: TriageActivityView | null;
  /**
   * The case this doctor's own unexpired lease holds — what its card shows
   * where a coder's shows its ticket, which is why it sits beside `issue`.
   *
   * Null three ways, and the panel must not tell them apart: the loop is not a
   * ci-doctor so the line does not apply; it is one and holds nothing; or the
   * store was not read at all. A card that said "no case" on the strength of a
   * read that did not happen would be the one wrong answer, so a loop whose
   * store is unknown is null here and the panel's own `problem` says why.
   *
   * (`case` is a statement keyword, not a reserved property name.)
   */
  case: CiCaseView | null;
  /**
   * Where the loop stands on the retry schedule. Absent means "not being
   * retried, or the feed could not be read" — deliberately one state on the
   * page, which has nothing different to show for the two.
   */
  retry?: LoopRetryView;
}

/**
 * A worktree carrying a loop record that resolves to no roster loop — a
 * copied or moved record, an unreadable one, or an owner the roster does not
 * name. Reported so it is not silently dropped, and never as a loop panel.
 */
export interface UnattributedWorktree {
  worktree: string;
  owner: string | null;
  loopStatus: LoopStatus;
  stateProblem: StateProblem;
}

export interface Dashboard {
  generatedAt: string;
  loops: DashboardLoop[];
  /** Orphaned/prunable checkouts, surfaced apart from the loop panels. */
  reconciliation: Reconciliation;
  unattributed: UnattributedWorktree[];
  /** Machine-wide map of claimed and in-flight work to the owning loop. */
  ownership: Ownership;
  /** The project's backlog buckets, or null when no adapter supplied them. */
  frontier: FrontierRead | null;
  /** The project's CI health, or null when no adapter supplied it. */
  ciHealth: CiHealthRead | null;
  /** The open learnings, or null when no adapter supplied them. */
  learnings: LearningsRead | null;
  /** What the verifier is following, or null when the roster names no verifier or no adapter supplied it. */
  following: FollowingRead | null;
  /** Where tickets link and how they are spelt; null or absent when no adapter said, which reads as GitHub issues. */
  tracker?: TrackerLinkView | null;
}

/* -------------------------------------------------------------- learnings */

/*
 * The short, current list of what to know, as the dashboard says it.
 *
 * Read-only here: loops write these files through the journal publisher, and
 * the dashboard's job is only to show an operator how long the list has grown
 * and let them open it. Two files, because the split says whose problem a fix
 * is — this project's, or Ralph's.
 */

/** One open entry, its labelled lines read out so the panel can show them in place. */
export interface LearningEntryView {
  /** From `<!-- learning: <slug> -->`, or null for an entry written before slugs. */
  slug: string | null;
  /** The heading text, without its trailing date. */
  title: string;
  /** The heading's `(YYYY-MM-DD)`, or null when it carries none. */
  date: string | null;
  /** The heading's anchor in the rendered file, GitHub's way. */
  anchor: string;
  seen: string | null;
  workaround: string | null;
  fix: string | null;
  change: string | null;
  verify: string | null;
  /** Each `Seen again` line's value, in file order: how often it recurred. */
  seenAgain: readonly string[];
  /**
   * True when the Fix starts with `no issue yet`, the placeholder the findings
   * filer turns into a ticket. Decided here, by the same leaf the filer reads it
   * with, so the panel cannot call an entry queued that the filer will skip.
   */
  fixPending: boolean;
}

/** One row of a file's Fixed table. */
export interface LearningFixedView {
  problem: string;
  fixedBy: string;
}

/** One learnings file's open entries. */
export interface LearningsSourceView {
  scope: "project" | "harness";
  /** The path inside the harness repository. */
  file: string;
  /** Every open entry, newest first, as the file orders them. */
  entries: readonly LearningEntryView[];
  /** The Fixed table, oldest first. */
  fixed: readonly LearningFixedView[];
  /** False when the file is not on its ref at all. */
  present: boolean;
  /**
   * This file's own blob base, when it does not live in the harness: a
   * project learnings file under `journal.branch` is on the project's
   * repository. Absent means `LearningsRead.base`.
   */
  base?: string | null;
}

export interface LearningsRead {
  /**
   * The harness repository's blob base for linking a file, or null when the
   * remote could not be read. Null makes the entries plain text rather than
   * dead links.
   */
  base: string | null;
  /** The project's file then the harness's; a project that opted out has only the harness's. */
  sources: readonly LearningsSourceView[];
}

/**
 * What `POST /api/learnings/file` answers: the ticket the harness filed for
 * one entry, or why it did not. `url` null with no `problem` means the entry
 * was published as queued and the next reconciliation files it.
 */
export interface LearningFiledView {
  slug: string;
  url: string | null;
  problem: string | null;
}

/* ------------------------------------------------------------- ci health */

/*
 * The ci-doctor's view of CI, as the dashboard says it.
 *
 * Every union below is a hand-kept copy of `ci-doctor/store.ts`'s, for the
 * reason the top of this file gives, and `dashboard/contract-parity.test.ts`
 * is the fence. The ORDER is part of the contract: the lists are compared as
 * arrays, and `dashboard/ci-health.ts` validates a store's JSON against the
 * same list the type is built from.
 */

/** Mirrors `CaseKind` in `ci-doctor/store.ts`. */
export const CI_CASE_KINDS = ["flake", "regression", "infra", "pr-specific", "parked"] as const;
export type CiCaseKind = (typeof CI_CASE_KINDS)[number];

/** Mirrors `CaseState` in `ci-doctor/store.ts`. */
export const CI_CASE_STATES = [
  "candidate",
  "confirmed",
  "filed",
  "fixing",
  "fixed",
  "retired",
  "handed-off",
] as const;
export type CiCaseState = (typeof CI_CASE_STATES)[number];

/** Mirrors `CiHealthStore["main"]["state"]` in `ci-doctor/store.ts`. */
export const CI_MAIN_STATES = ["green", "red", "unknown"] as const;
export type CiMainState = (typeof CI_MAIN_STATES)[number];

/** Mirrors `Revert["state"]` in `ci-doctor/store.ts`. */
export const CI_REVERT_STATES = ["open", "merged", "abandoned"] as const;
export type CiRevertState = (typeof CI_REVERT_STATES)[number];

/**
 * The case states in which a flake is still COSTING CI time — what "a known
 * flake" means wherever this file says it.
 *
 * A `candidate` is out because the doctor has not confirmed it is a flake at
 * all, and `fixed` and `retired` are out because they are over. `handed-off`
 * is IN, which is the one that is easy to get wrong: it means the doctor filed
 * the flake for the coders (`ci-doctor/case-issue.ts`'s `recordHandedOff`), so
 * the test is still flaking and still burning builds — it is merely somebody
 * else's to fix. `ci-doctor/known.ts` says the same thing by printing
 * `flake handed to the coders` WITH its cost clause.
 *
 * This is not a mirror of `known.ts`'s `flakeClaim` switch. That one answers
 * what to tell a coder about a failing test, which is a different question
 * from whether the test is costing CI time. `dashboard/contract-parity.test.ts`
 * fences this list for exhaustiveness over `CaseState` instead, so a new state
 * cannot default into either answer unread.
 */
export const CI_KNOWN_FLAKE_STATES = [
  "confirmed",
  "filed",
  "fixing",
  "handed-off",
] as const satisfies readonly CiCaseState[];

/**
 * `ciDoctor.retry.perDay`'s default, mirrored from `project-config.ts`'s
 * `RETRY_CEILINGS.perDay` — which is also its ceiling, since the key may be
 * lowered but never raised. A mirror because this file imports no ralph
 * module; `dashboard/contract-parity.test.ts` fences the two.
 */
export const CI_RETRY_PER_DAY_DEFAULT = 6;

/**
 * One case in the store: a flake, a main regression, an infra incident, a
 * failure specific to one branch, or a parked ticket.
 *
 * Every count is a number rather than `number | null`: the store writes
 * `cost72h` on every case, so a cost that cannot be read is drift rather than
 * an absence, and it reads as zero. The case is KEPT — its kind, state and
 * subject are the row's point and they are checked. The consequence is worth
 * knowing: a case whose costs are unreadable sorts to the bottom of a table
 * capped at `CASE_ROW_LIMIT`, so drift hides a case rather than announcing
 * itself. `dashboard/ci-health.test.ts` pins the behaviour.
 */
export interface CiCaseView {
  /** The store key, e.g. `flake:src/a.test.ts > flaps`. Unique, so the React key. */
  key: string;
  /** The key past its `<kind>:` prefix — the test id, the signature, or the issue. */
  subject: string;
  kind: CiCaseKind;
  state: CiCaseState;
  /** `cost72h` — what the case has cost in the store's 72-hour window. */
  redBuilds: number;
  mainReds: number;
  dequeues: number;
  /** The issue the doctor filed, and the fix PR; null when it has filed neither. */
  issue: number | null;
  pr: number | null;
  /** Which zero-cost rule confirmed it, or what made the case what it is. */
  rule: string | null;
  /**
   * The doctor loop whose UNEXPIRED case lease holds this case, null when none
   * does. An expired lease holds nothing, so it reads as null rather than as
   * the loop that let it lapse.
   */
  heldBy: string | null;
  /**
   * Whether the doctor has already pushed a notification for this case.
   *
   * It is the whole of its response to an infra incident — an incident starts
   * no iteration — so for one of those this is the difference between
   * "somebody has been told" and "this is sitting here unreported", which is
   * the first thing an operator reading an open incident wants to know.
   */
  notified: boolean;
}

/** One entry of a parked ticket's unpark history. */
export interface CiUnparkView {
  /** The diagnosis key the ticket was unparked for. */
  diagnosis: string;
  at: string;
}

/**
 * A coder ticket parked on a flaky test, from the store's `parked:<issue>`
 * case.
 *
 * The ticket's TITLE and the loop whose `-blocked` label it wears are
 * deliberately absent: `ci-doctor/gate.ts` rebuilds those from a GitHub
 * search on every poll and never writes them down, and this panel makes no
 * network call. The issue number links, which is enough to follow.
 */
export interface CiParkedView {
  /** From the `parked:<issue>` key. */
  issue: number;
  state: CiCaseState;
  /** The flake the block named; null when the case records none. */
  rule: string | null;
  /** Newest first. Empty means never unparked, not unknown. */
  unparks: CiUnparkView[];
  /**
   * The doctor whose unexpired lease holds this parked ticket.
   *
   * A parked ticket IS leasable: `ci-doctor/gate.ts` returns `parked:<issue>`
   * as a work verdict and the gate takes a lease on whatever key it returns.
   * Forgetting that is how a doctor mid-unpark came to read as holding nothing.
   */
  heldBy: string | null;
}

/** A revert of a main regression's culprit, and the forward fix it leaves behind. */
export interface CiRevertView {
  /** The reverted commit — the store's own key. */
  culprit: string;
  /** The case key the revert answers. */
  case: string;
  issue: number;
  pr: number | null;
  forwardIssue: number | null;
  state: CiRevertState;
}

/** The doctor's job retries, against the cap it is held to. */
export interface CiRetriesView {
  /**
   * The UTC day the count belongs to. Null when the store names none, which is
   * also what an empty store says (`emptyStore()` writes `day: ""`), so it
   * reads as "no retry has ever been recorded" rather than as "none today".
   */
  day: string | null;
  count: number;
  /** `ciDoctor.retry.perDay`, else `CI_RETRY_PER_DAY_DEFAULT`. */
  cap: number;
  /**
   * Whether `day` is the day the read was taken.
   *
   * The store carries ONE day's count and the scan rolls it over lazily, so a
   * count read the morning after is yesterday's. Without this a panel headed
   * "retries today" would present a stale number as today's, which is the one
   * thing a budget figure must not do. False when `day` is null.
   */
  today: boolean;
}

/**
 * What known flakes have cost CI in the last 24 hours.
 *
 * An ESTIMATE from BUILD wall time, not the per-job time the figure is really
 * about: nothing persists a job duration anywhere — `ci-doctor/scan.ts`
 * records a step's effective STATE and no timing — so a build is the finest
 * grain on disk. It therefore over-states a flake in a short job inside a long
 * build, and the panel says "estimated" for that reason rather than for
 * modesty.
 */
export interface CiLostTimeView {
  /** Reds inside the window attributable to a known flake. */
  reds: number;
  /** Median wall-clock minutes of a red build in the window; null when none could be timed. */
  medianBuildMinutes: number | null;
  /** `reds × medianBuildMinutes`, rounded; null when the median is. */
  minutes: number | null;
}

/** How many UTC days of per-day metrics the panel draws. The store keeps 30. */
export const CI_METRICS_TREND_DAYS = 14;

/**
 * One UTC day of the ci-doctor's own success measure (#163).
 *
 * `knownFlakeReds` is a running MAXIMUM, not a tally: `ci-doctor/scan.ts`
 * recomputes it from a 72-hour window of evidence but keeps 30 days of
 * metrics, so assigning would zero out a day the window has moved past. The
 * series therefore never falls, and a case reclassified out of a flake state
 * does not lower a past day.
 */
export interface CiMetricsDayView {
  /** `2026-10-05`. */
  day: string;
  /** Red builds that day whose failing tests were ALL known flakes. */
  knownFlakeReds: number;
  /** The highest number of coder tickets parked on a flake that day. */
  parkedOnFlake: number;
}

/**
 * The 14-day trend of the two per-day metrics.
 *
 * `days` is exactly `CI_METRICS_TREND_DAYS` long, oldest first, ending on the
 * UTC day of the read — a day the store has nothing for is a zero rather than
 * a gap, because a day with no reds is a real and good answer and a chart with
 * holes in it reads as missing data.
 */
export interface CiMetricsView {
  days: CiMetricsDayView[];
  /** Known-flake reds across the window. */
  reds: number;
  /** The worst single day's parked count in the window. */
  parkedPeak: number;
  /**
   * Whether the store holds any metrics day at all — which tells a doctor that
   * has recorded nothing here apart from fourteen genuinely quiet days. The
   * zero-filled series alone cannot.
   */
  recorded: boolean;
}

/**
 * The median minutes one coder iteration spent WAITING on CI, and on the merge
 * queue, over a trailing window (#163).
 *
 * Computed from the wait results under each coder worktree's `.ralph/logs`
 * (`ralph.sh` redirects `pr-wait.ts`'s stdout into one per round;
 * `merge-wait.ts` files its own in the same shape), summed per iteration and
 * per mode, then medianed across iterations. Nothing here calls an API and
 * nothing runs a process.
 *
 * A median rather than a mean because the distribution has a long tail — one
 * 25-minute timeout would move a mean more than the typical wait it is meant
 * to describe.
 */
export interface CiWaitWindowView {
  /** Iterations that waited on CI at all in the window. */
  ciIterations: number;
  /** Median minutes one of them spent waiting on CI; null when none did. */
  ciMinutes: number | null;
  /** Iterations that waited on the merge queue. */
  queueIterations: number;
  /** Median minutes one of them spent waiting on the queue; null when none did. */
  queueMinutes: number | null;
}

/** The wait medians over 24 hours and over 7 days. */
export interface CiWaitsView {
  day: CiWaitWindowView;
  week: CiWaitWindowView;
  /**
   * Worktrees whose `.ralph/logs` could not be listed. Named so a panel
   * showing no waits can say whether nobody waited or nobody looked; empty is
   * the normal case.
   */
  unreadable: string[];
}

/**
 * The whole CI health picture, folded from one read of `ci-health.json`.
 *
 * Every list is empty rather than null when there is nothing in it: the store
 * is the only source, so "the store says nothing" is a real answer. Not
 * knowing at all is `CiHealthRead.view === null`.
 */
export interface CiHealthView {
  /**
   * The base branch's colour and when it took it. `since` is null when the
   * store's is the empty string and `build` null when it is `0` —
   * `ci-doctor/classify.ts` writes both that way on `unknown`, and a panel
   * must not print "since" with nothing after it.
   */
  main: { state: CiMainState; since: string | null; build: number | null };
  /**
   * Every case except the parked tickets and the infra incidents, which have
   * their own lists below. Worst first by `mainReds×3 + dequeues×2 +
   * redBuilds` — `ci-doctor/store.ts`'s own `weigh` — then by key, so the
   * order is total.
   */
  cases: CiCaseView[];
  /**
   * The OPEN infra incidents, same ordering. Never also in `cases`.
   *
   * Open means not `fixed` and not `retired`. The scan never moves a case out
   * of a managed state (`ci-doctor/classify.ts`'s `MANAGED_STATES`) and never
   * deletes an `infra:check:` case at all, so a long-fixed incident stays in
   * the store for ever; listing it under "open" would be false, and it is
   * history rather than something wrong now.
   */
  incidents: CiCaseView[];
  /** Parked tickets, by issue number ascending. */
  parked: CiParkedView[];
  retries: CiRetriesView;
  /**
   * Reverts, open first and then by culprit sha, so the order is stable across
   * polls. The store records no timestamp on a revert, so "recent" cannot be
   * expressed and is not claimed.
   */
  reverts: CiRevertView[];
  lostTime: CiLostTimeView;
  /** The ci-doctor's own success measure, as a 14-day trend. */
  metrics: CiMetricsView;
  /** Median CI and queue minutes per coder iteration, over 24 h and 7 d. */
  waits: CiWaitsView;
  /**
   * Every case an unexpired lease holds, whatever list above draws it —
   * including the parked tickets and the closed incidents, which are not in
   * `cases` or `incidents` at all.
   *
   * One flat list rather than a search across the others, because a reader
   * asking "what is this doctor working on" must not depend on which list a
   * case happened to land in: it is a `parked:<n>` key that the first version
   * of this missed, and the card then said "holding no case" while the doctor
   * was demonstrably working one.
   */
  held: CiCaseView[];
}

/**
 * One read of the ci-health store, stamped with when it was taken.
 *
 * A MISSING, empty, unparseable or wrong-version store is an EMPTY `view`,
 * never null: the store is a cache the next scan rebuilds from Buildkite, and
 * an absent one means the doctor has not run here, which is a true and
 * complete answer. `view` is null only when the store's PATH could not be
 * resolved — the checkout's `.git` was unreadable — which is genuinely
 * unknown; `problem` then says why.
 */
export interface CiHealthRead {
  readAt: string;
  view: CiHealthView | null;
  /** Why `view` is null, when it is. Null whenever `view` is not. */
  problem: string | null;
}

/* ------------------------------------------------------------ following */

/*
 * `bun verifier/following.ts --json`, mirrored by hand: the dashboard never
 * imports ralph TypeScript, so these types are the contract and
 * `contract-parity.test.ts` fences the enums against the CLI's.
 */

/** Where one watch stands: still checking in, or judged. */
export const FOLLOWING_STATES = ["in-progress", "finished"] as const;
export type FollowingState = (typeof FOLLOWING_STATES)[number];

/** The actions observe mode held back, as `decideVerdict` names them. */
export const FOLLOWING_WOULD_BE = ["ticket", "revert", "needs-human"] as const;
export type FollowingWouldBe = (typeof FOLLOWING_WOULD_BE)[number];

/** A verifier verdict, as the watch store records it. */
export interface FollowingVerdictView {
  verdict: string;
  reason: string;
  act: boolean;
  wouldHaveBeen: string | null;
}

/** One merged pull request the verifier is following, or has judged. */
export interface FollowingWatchView {
  pr: number;
  ticket: number;
  ticketRef: string;
  mode: string;
  round: number;
  mergedAt: string;
  deployedAt: string;
  deployUrl: string | null;
  openedAt: string;
  state: FollowingState;
  /** The first check-in without a result; null once the watch is finished. */
  nextCheckIn: { offsetHours: number; dueAt: string } | null;
  checkInsDone: number;
  checkInsTotal: number;
  /** The terminal verdict, or null while none is in. */
  verdict: FollowingVerdictView | null;
  /** What observe mode held back; `at` is the check-in's offset, null for the terminal verdict. */
  wouldBe: { verdict: FollowingWouldBe; reason: string; at: number | null }[];
  /** Acceptance criteria a check-in could not verify against production. */
  notVerifiableLive: { criterion: string; detail: string | null }[];
}

/** The whole watch store as the CLI prints it: in progress first, then finished. */
export interface FollowingView {
  version: 1;
  watches: FollowingWatchView[];
}

/**
 * One read of the Following view, stamped with when it was taken. `view` is
 * null when it could not be read — the CLI failed, or printed something this
 * dashboard was not written against — which is unknown, never "nothing
 * followed"; `problem` then says why. A missing store is an empty `view`.
 */
export interface FollowingRead {
  readAt: string;
  view: FollowingView | null;
  /** Why `view` is null, when it is. Null whenever `view` is not. */
  problem: string | null;
}

/* ---------------------------------------------------------------- usage */

/** One Claude plan window as the newest rate-limit reading reported it. */
export interface UsageWindowView {
  /** 0–1, as the harness reported it. */
  utilization: number;
  resetsAt: string | null;
  /** The window has reset since the reading was taken, so the figure is stale. */
  lapsed: boolean;
}

/** The Claude plan's limits, from the newest `rate_limit_event` in any loop's logs. */
export interface PlanUsageView {
  at: string;
  /** The loop whose runner reported it. The plan is shared, so any loop can. */
  loop: string;
  /** `allowed`, `allowed_warning`, `rejected`, or whatever the harness sent. */
  status: string;
  limitingWindow: string | null;
  usingOverage: boolean;
  /** When the window figures below were reported; a bare status event carries none. */
  windowsAt: string | null;
  fiveHour: UsageWindowView | null;
  sevenDay: UsageWindowView | null;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** `costUsd` is null for a model whose harness reports no cost (opencode, codex). */
export interface ModelSpendView {
  model: string;
  costUsd: number | null;
  tokens: TokenTotals;
}

export interface StageSpendView {
  stage: string;
  costUsd: number;
}

/**
 * What one task cost: every run attributed to one issue in one loop.
 *
 * Costs are only ever what a harness reported for a run. Tokens from a harness
 * that reports none are counted in `unpricedTokens`, never priced here.
 */
export interface TaskCostView {
  loop: string;
  /** Null when no ledger label names the issue the runs worked on. */
  issue: number | null;
  costUsd: number;
  /** Runs that reported a cost. */
  runs: number;
  iterations: number;
  unpricedTokens: number;
  /** An iteration of this task has no final cost report yet: still running, or ended without one. */
  unreported: boolean;
  firstAt: string;
  lastAt: string;
  stages: StageSpendView[];
  models: ModelSpendView[];
}

export interface LoopSpendView {
  loop: string;
  costUsd: number;
  last7d: number;
  runs: number;
  unpricedTokens: number;
  models: ModelSpendView[];
}

export interface SpendWindows {
  last5h: number;
  last24h: number;
  last7d: number;
  total: number;
}

/** One day of spend, the host's local date, per model. */
export interface DailySpendView {
  /** `YYYY-MM-DD` in the dashboard host's time zone. */
  date: string;
  /** `costUsd` is null for a model whose harness reports no cost. */
  models: ModelSpendView[];
}

export interface UsageReport {
  generatedAt: string;
  /** The newest plan reading in these loops' own logs. */
  plan: PlanUsageView | null;
  /** Reported cost over trailing windows, across every loop. */
  spend: SpendWindows;
  loops: LoopSpendView[];
  /** Newest activity first. */
  tasks: TaskCostView[];
  /** Spend per model over the last 7 days. */
  models: ModelSpendView[];
  /** Spend per day and model over the last `DAILY_DAYS` days, oldest first; days with nothing are absent. */
  daily: DailySpendView[];
  sources: { files: number; results: number; ledgerRows: number };
}

/**
 * The plan is the account's, not a project's: every project's loops draw on
 * the same limits. So the usage route carries, beside the project's own
 * spend, the newest plan reading across every registered project's logs.
 */
export interface AccountUsageView {
  scope: "all-projects";
  /** The newest reading across every project, and the project whose loop reported it. */
  plan: (PlanUsageView & { project: string }) | null;
  /** The projects whose logs were read for it, in registration order. */
  projects: string[];
  /** Projects whose logs could not be read, and why: the plan may be older than it looks. */
  unread: { project: string; why: string }[];
  /** Reported cost over trailing windows, summed across every project read. */
  spend: SpendWindows;
  /** Each project's own share of `spend`, in registration order. */
  projectSpend: { project: string; spend: SpendWindows }[];
  /** Every project's daily spend, merged per day and model. */
  daily: DailySpendView[];
}

/** One limit window as UsageBar reports it: a percentage used, and when it resets. */
export interface UsageBarWindowView {
  /** `Session (5h)`, `Weekly`, `Sonnet`, … as UsageBar's popover names it. */
  label: string;
  /** 0–100; may exceed 100 for a provider that reports overage. */
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: string | null;
  resetDescription: string | null;
  /** UsageBar's pace forecast for the window, when it has one. */
  pace: string | null;
}

export interface UsageBarProviderView {
  /** `claude`, `codex`, … */
  provider: string;
  source: string | null;
  account: string | null;
  plan: string | null;
  updatedAt: string | null;
  windows: UsageBarWindowView[];
  /** Why this provider's latest read failed, when it did. */
  error: string | null;
  /**
   * The read failed and `windows` are the last good reading's, carried
   * forward as UsageBar carries them, so a rate-limited provider keeps its bars.
   */
  stale: boolean;
}

/**
 * The machine's UsageBar reading (`codexbar usage --format json`): every
 * provider the operator enabled there, read from the providers themselves.
 */
export type UsageBarView =
  | { state: "read"; readAt: string; providers: UsageBarProviderView[] }
  /** The first read after the server started is still running. */
  | { state: "reading" }
  | { state: "unavailable"; readAt: string; why: string };

/**
 * The machine's spend as UsageBar's cost view reads it (`codexbar cost`):
 * every Claude and Codex session on this host, loops or not, priced at list
 * API rates — an estimate, unlike the runners' reported cost.
 */
export type MachineSpendView =
  | { state: "read"; readAt: string; daily: DailySpendView[] }
  /** The first read is still running: the CLI scans every session log, which takes minutes. */
  | { state: "reading" }
  | { state: "unavailable"; readAt: string; why: string };

/** `GET /api/p/:project/usage`: the project's own spend, and the account's plan. */
export interface ProjectUsageReport extends UsageReport {
  /** Absent when the server observes one project with no registry. */
  account?: AccountUsageView;
  /** Absent when the server has no UsageBar reader. */
  usagebar?: UsageBarView;
  /** Absent when the server has no UsageBar reader. */
  machineSpend?: MachineSpendView;
}

/* ------------------------------------------------------------- controls */

/*
 * The write routes' answers and the control view, as the page reads them.
 *
 * The modules that produce them (`dispatch.ts`, `control-view.ts`,
 * `lifecycle.ts`) sit behind the process boundary and import Node; the page
 * cannot. So the wire shapes live here, and each route checks with
 * `satisfies` that what it serializes still is one, so the two cannot drift.
 */

/** The commands the dashboard writes into a loop's inbox, applied by its next poll. */
export const CONTROL_COMMANDS = [
  "pause",
  "resume",
  "stop",
  "approve",
  "deny",
  "arm-gate",
  "disarm-gate",
  "retry",
  "abandon",
  "release",
  "retry-phase",
] as const;
export type ControlCommand = (typeof CONTROL_COMMANDS)[number];

/** The outcome vocabulary of the control record, plus `replayed`. */
export const CONTROL_OUTCOMES = [
  "applied",
  "refused",
  "replayed",
  "needs-reconfirmation",
  "not-for-this-loop",
  "deferred",
] as const;
export type ControlOutcome = (typeof CONTROL_OUTCOMES)[number];

export type ControlStopConfirmation = "confirmed" | "unreachable" | "pending";

/** What `POST /api/control` answers. */
export interface ControlResult {
  loop: string;
  action: ControlCommand;
  /** The idempotency key the command was sent under. */
  key: string;
  run: string | null;
  /** The ticket `abandon` or `release` named; null for every other command. */
  issue: number | null;
  outcome: ControlOutcome;
  /** True when `outcome` was read back from the loop's own record. */
  recorded: boolean;
  why: string;
  at: string;
  stop: { kind: StopKind; confirmation: ControlStopConfirmation } | null;
}

/**
 * The one-word answer a control view leads with, most urgent first. A recorded
 * stop outranks a hold; the durable blocked reason comes next; a degraded
 * channel only when nothing recorded says more.
 */
export type ControlViewStatus =
  | "stopped"
  | "stop-pending"
  | "stop-unreachable"
  | "held"
  | "blocked"
  | "degraded"
  | "clear"
  | "unknown";

/**
 * `ok` is a readable record outside a degraded window; `no-record` is a loop
 * nobody has commanded yet; `degraded` is the record's own degraded window;
 * `unreachable` is a record that could not be read at all.
 */
export type ControlChannelState = "ok" | "no-record" | "degraded" | "unreachable";

/**
 * What `GET /api/controls` answers: every roster loop's control view, keyed by
 * loop name. One runtime read serves them all, so a page showing every loop's
 * controls does not cost one full runtime read per loop.
 */
export interface ControlsView {
  loops: Record<string, ControlView>;
}

/** What `GET /api/loops/:name/control` answers: what the loop's records know. */
export interface ControlView {
  loop: string;
  generatedAt: string;
  present: boolean;
  worktree: string | null;
  run: string | null;
  loopStatus: LoopStatus;
  status: ControlViewStatus;
  channel: {
    state: ControlChannelState;
    why: string | null;
    since: string | null;
    retryAt: string | null;
  };
  hold: {
    kind: "pause" | "approval";
    why: string;
    since: string;
    gate: string | null;
    /** Set for a hold at a phase boundary: the phase it is held before. */
    phase?: Phase;
    /** Set for a hold at a phase boundary: the phase just finished, which `retry-phase` runs again. */
    after?: Phase;
  } | null;
  /** Why a parked loop is parked, from the durable loop state. */
  blocked: { source: "stop" | "hold" | "frontier"; reason: string; since: string | null } | null;
  stop: {
    kind: StopKind;
    why: string;
    at: string;
    confirmation: ControlStopConfirmation;
    /** For an `interrupted` stop: the iteration the signal cut short, and the ticket still claimed. */
    iteration: number | null;
    issue: number | null;
    /** Set for a stop carried out at a phase boundary: the phase it stopped before. */
    phase?: Phase;
  } | null;
  commands: {
    key: string;
    command: string;
    outcome: Exclude<ControlOutcome, "deferred">;
    at: string;
    why: string;
  }[];
  pendingApprovals: { gate: string | null; question: string; since: string }[];
  /** The gates armed before a named phase, in phase order; each asks for approval every time it is reached. */
  gates: { phase: Phase; since: string; why: string | null }[];
  deferrals: { key: string; command: string; since: string; attempts: number }[];
  /** Commands the channel deferred until it gave up; `remedy` says what to do. */
  givenUp: { key: string; command: string; at: string; attempts: number; remedy: string }[];
}

export type StartOutcome = "started" | "already-running" | "failed";

/**
 * What `POST /api/start` answers. `already-running` launched nothing, and
 * neither did `refused`: the loop's name is not yet in `loops` on the base
 * branch (a new agent whose roster PR has not merged), or its checkout could
 * not be brought up to the base branch that names it.
 */
export interface StartResult {
  loop: string;
  action: "start";
  worktree: string;
  outcome: StartOutcome | "refused" | "not-for-this-loop";
  pid: number | null;
  why: string;
  at: string;
}

/** What a restart would leave in the worktree — reported, never repaired. */
export interface CheckoutReport {
  worktree: string;
  branch: string | null;
  /** False when `git status` could not be read; `dirty` then says nothing. */
  readable: boolean;
  dirty: boolean;
  /** `git status --porcelain` lines, verbatim. */
  changes: string[];
  claims: { issue: number; run: string; loop: string; branch: string | null }[];
  /** A claim is held for this worktree: a ticket is in flight here. */
  midTicket: boolean;
  /** Commits on HEAD that no remote-tracking ref has, as `<sha> <subject>`; null when git could not say. */
  unpushed: string[] | null;
}

export type RestartHalt =
  | "stop-refused"
  | "stop-unreachable"
  | "stop-pending"
  | "supervisor-running"
  | "supervisor-unknown";

/** What `POST /api/restart` answers. `halted` started nothing; `halt` says why. */
export interface RestartResult {
  loop: string;
  action: "restart-to-apply";
  key: string;
  worktree: string;
  outcome: StartOutcome | "halted" | "not-for-this-loop";
  halt: RestartHalt | null;
  why: string;
  at: string;
  /** The stop sent, or null when none was needed or none was sent. */
  stop: ControlResult | null;
  confirmation: ControlStopConfirmation | null;
  start: { outcome: StartOutcome; pid: number | null; why: string } | null;
  checkout: CheckoutReport | null;
}

/**
 * One message on `GET /api/loops/:name/output`, the loop page's live pane.
 *
 * - `reset` clears the pane: the stream is now showing `log` (a file name under
 *   the worktree's `.ralph/logs`, or null when there is none), and `reason`
 *   says why the pane is empty or restarted, or is null.
 * - `append` adds redacted text: whole lines, each ending in a newline.
 * - `withheld` ends the stream: the harness's redactor could not redact, so
 *   nothing it would have scrubbed is shown. It is sent after a one-minute
 *   `retry:`, so the browser reconnects — and tries a fresh filter — once a
 *   minute rather than every few seconds.
 */
export type OutputEvent =
  | { kind: "reset"; log: string | null; reason: string | null }
  | { kind: "append"; text: string }
  | { kind: "withheld"; reason: string };

/* ------------------------------------------------------------- plugin doctor */

/** What the page may ask of an enabled plugin's doctor. */
export const DOCTOR_ACTIONS = ["diagnose", "repair", "fix-all"] as const;
export type DoctorAction = (typeof DOCTOR_ACTIONS)[number];

/** The one repair the harness carries out itself: the plugin off for the project. */
export const DOCTOR_DISABLE_REPAIR = "disable-plugin";

export const DOCTOR_HISTORY_KINDS = ["diagnosis", "repair", "fix-all"] as const;
export type DoctorHistoryKind = (typeof DOCTOR_HISTORY_KINDS)[number];

export type DoctorCheckStatus = "pass" | "fail" | "skipped";
export type DoctorStepResult = "repaired" | "failed" | "not-repairable";

export interface DoctorRepairView {
  id: string;
  label: string;
  /** The one Fix all applies for this check. */
  default: boolean;
}

export interface DoctorCheckView {
  id: string;
  label: string;
  status: DoctorCheckStatus;
  detail: string;
  /** Only on a failed check, and only repairs that can apply now. */
  repairs: DoctorRepairView[];
}

/** One enabled plugin's diagnosis, or why it could not be diagnosed. */
export interface DoctorPluginView {
  plugin: string;
  title: string;
  checks: DoctorCheckView[];
  /** Set, with `checks` empty, when the plugin's doctor did not answer. */
  problem: string | null;
}

export interface DoctorStepView {
  check: string;
  action: string | null;
  result: DoctorStepResult;
  why: string;
}

/** One recorded diagnosis or repair, from the loop's repair history. */
export interface DoctorHistoryEntry {
  at: string;
  plugin: string;
  run: string | null;
  kind: DoctorHistoryKind;
  via: "operator" | "fix-all" | null;
  check: string | null;
  action: string | null;
  result: string;
  why: string;
}

/** `POST /api/doctor`'s answer. `plugins` is empty when none is enabled. */
export interface DoctorView {
  loop: string;
  plugins: DoctorPluginView[];
  steps: DoctorStepView[];
  /** Why Fix all stopped short. */
  stopped: string | null;
  /** Oldest first. */
  history: DoctorHistoryEntry[];
  /** The doctor could not be run or read; nothing else in the view is known. */
  problem: string | null;
}

/* ------------------------------------------------------------- stop now */

/**
 * What Stop now verifies about its target before any signal, in order. A
 * failed check ends the list, and nothing is sent.
 *
 * - `pid-file` — `.ralph/logs/supervisor.pid` in the loop's checkout names a pid;
 * - `alive` — that pid is running;
 * - `ralph.sh` — it is running `ralph.sh`, not a shell that mentions it;
 * - `cwd` — its working directory is this checkout, which also defeats a reused pid;
 * - `group` — its process group is led by it or by its `start.sh` wrapper, and
 *   is not the dashboard's own.
 */
export const INTERRUPT_CHECKS = ["pid-file", "alive", "ralph.sh", "cwd", "group"] as const;
export type InterruptCheckName = (typeof INTERRUPT_CHECKS)[number];

export interface InterruptCheck {
  check: InterruptCheckName;
  ok: boolean;
  detail: string;
}

export type InterruptSignal = "SIGTERM" | "SIGKILL";

/** What Stop now aimed at: the pid file (worktree-relative), the pid it names, and that pid's process group. */
export interface InterruptTarget {
  pidFile: string;
  pid: number | null;
  group: number | null;
}

/**
 * How a Stop now ended. `interrupted` — the supervisor is gone; `refused` — a
 * check failed or the signal could not be recorded, and nothing was sent;
 * `survived` — signalled, and still running after SIGKILL;
 * `needs-reconfirmation` — the request named a run the loop no longer holds;
 * `not-for-this-loop` — the request named another loop.
 */
export type StopNowOutcome = "interrupted" | "refused" | "survived" | "needs-reconfirmation" | "not-for-this-loop";

/** What `POST /api/stop-now` answers. */
export interface StopNowResult {
  loop: string;
  action: "stop-now";
  key: string;
  worktree: string;
  /** The run on record when the signal was sent. */
  run: string | null;
  outcome: StopNowOutcome;
  why: string;
  at: string;
  target: InterruptTarget;
  checks: InterruptCheck[];
  /** The signals sent to the group, in order. Empty when nothing was sent. */
  signals: InterruptSignal[];
  /** True when the loop's own record now holds the stop. */
  recorded: boolean;
  stop: { kind: StopKind; confirmation: ControlStopConfirmation; iteration: number | null; issue: number | null } | null;
  /** The worktree-relative file every signal and refusal is appended to. */
  audit: string;
}

/**
 * What `POST /api/resume-work` answers: a start in the same worktree that
 * leaves HEAD where the interrupted iteration left it. `refused` started
 * nothing.
 */
export interface ResumeWorkResult {
  loop: string;
  action: "resume-work";
  worktree: string;
  outcome: StartOutcome | "refused" | "not-for-this-loop";
  pid: number | null;
  why: string;
  at: string;
  checkout: CheckoutReport | null;
}

/**
 * Jav, difficulty routing, as `GET /api/jav` serves it: `jav.ts --json` for
 * one project, narrowed. `config` is the project's block as written (else the
 * `default` block, else Jav off), so a block with problems can still be opened
 * and fixed on the page. A route may be keyed `default`: every loop of the
 * project without a route of its own.
 */
export interface JavConfigView {
  enabled: boolean;
  labels: string[];
  routes: Record<string, string[]>;
}

export interface JavView {
  path: string;
  exists: boolean;
  /** The project this view is of: its block is the one `config` shows and a save writes. */
  project: string;
  /** False while the project routes by the `default` block (or none): a save gives it its own. */
  own: boolean;
  config: JavConfigView;
  problems: string[];
  /** The loop roster a route may name. */
  loops: string[];
  /** Labels the loop already uses, which a difficulty label may not be. */
  reserved: string[];
}

/** What `POST /api/jav/save` answers. Invalid leaves the file untouched. */
export interface JavSaveResult {
  valid: boolean;
  problems: string[];
}

/* ------------------------------------------------------------ project sleep */

/**
 * A project's sleep, as `GET /api/sleep` and `POST /api/sleep` answer it: the
 * harness's `project-sleep.ts --json` view, narrowed. One marker in the repo's
 * git common directory, so every loop of the project reads the same answer:
 * asleep, each finishes its iteration and parks at the next boundary.
 *
 * `problem` is set when the CLI could not be run or its answer could not be
 * read; the other fields are then the awake defaults and mean nothing, so the
 * page shows the problem instead of a state it does not know.
 */
export interface ProjectSleepView {
  asleep: boolean;
  /** When the project was put to sleep (ISO), or null while awake. */
  since: string | null;
  /** The operator's reason, if one was given. */
  why: string | null;
  /** Who put it to sleep (`dashboard` from the page), if recorded. */
  by: string | null;
  problem: string | null;
}

/** The longest reason the page may send with a sleep; the marker is a one-line note, not a log. */
export const PROJECT_SLEEP_WHY_MAX = 500;

/* ------------------------------------------------- notifications and history */

/**
 * How one channel took an alert. `delivered` — it said it had it;
 * `failed` — it answered, and did not deliver it (`why` says why);
 * `skipped` — it was never asked (a plugin being backed off from, one not
 * installed); `unconfirmed` — no answer was recorded, so nobody can say it
 * arrived.
 */
export type DeliveryState = "delivered" | "failed" | "skipped" | "unconfirmed";

export interface DeliveryView {
  channel: "plugin" | "github";
  /** The plugin's name, or `github` for the ticket comment. */
  name: string;
  state: DeliveryState;
  why: string | null;
  at: string | null;
}

/** One alert a loop raised, as its local feed recorded it. Text arrives redacted. */
export interface NotificationView {
  /** `<run>:<occurrence>`: unique within a loop. */
  id: string;
  loop: string;
  run: string | null;
  kind: string;
  subject: string;
  body: string;
  priority: "normal" | "high";
  ticket: number | null;
  iteration: number | null;
  at: string;
  /** At or before the loop's read mark. */
  read: boolean;
  /** One per plugin it was offered to, then the ticket comment when the ticket was eligible. Empty: the feed was the only channel. */
  deliveries: DeliveryView[];
  /** Why it was sent nowhere but the feed — pushes switched off, the record not claimed — or null. */
  unsent: string | null;
}

/**
 * Why a list is empty or partial. `missing` — no record has been written yet,
 * which is the ordinary state of a loop that has raised nothing;
 * `unreadable` — a record exists and could not be read; `no-checkout` — the
 * loop has nowhere to keep one.
 */
export interface RecordProblem {
  kind: "missing" | "unreadable" | "no-checkout";
  detail: string;
}

/** One loop's notification feed, newest first. */
export interface NotificationFeed {
  loop: string;
  notifications: NotificationView[];
  unread: number;
  /** The read mark: every alert at or before it is read. */
  readThrough: string | null;
  problem: RecordProblem | null;
}

/** `GET /api/notifications`: every loop's feed, and the newest alerts across them. */
export interface NotificationsView {
  generatedAt: string;
  loops: NotificationFeed[];
  /** Every loop's alerts merged, newest first, at most 50. */
  recent: NotificationView[];
  unread: number;
}

export const HISTORY_SOURCES = ["command", "signal", "repair"] as const;
export type HistorySource = (typeof HISTORY_SOURCES)[number];

/**
 * One thing an operator did to a loop, and what came of it.
 *
 * - `command` — a control command from the inbox. `outcome` is the recorded
 *   one (`applied`, `refused`, `replayed`, `needs-reconfirmation`,
 *   `not-for-this-loop`), or `pending` while it waits in the inbox.
 * - `signal` — a Stop now: `interrupted`, `refused` (a check failed and nothing
 *   was sent), `survived`, or `pending` when it was signalled and never said how
 *   it ended.
 * - `repair` — a plugin repair or Fix all: `repaired`, `failed`,
 *   `not-repairable`, or Fix all's summary.
 *
 * `detail` is the recorded answer — for a refusal, the reason. `reason` is the
 * operator's own.
 */
export interface HistoryEntryView {
  source: HistorySource;
  id: string;
  at: string;
  /** `pause`, `stop`, `release` …; `stop-now`; `<plugin> <check>: <repair>`. */
  action: string;
  outcome: string;
  detail: string | null;
  reason: string | null;
  run: string | null;
  /** Who sent it, when not the local operator: a plugin, or Fix all. */
  via: string | null;
  issue: number | null;
  /** A Stop now's failed check, when that is why it was refused. */
  failedCheck: InterruptCheckName | null;
  signals: InterruptSignal[];
}

/** `GET /api/loops/:name/history`: the loop's audit history, newest first. */
export interface HistoryView {
  loop: string;
  generatedAt: string;
  entries: HistoryEntryView[];
  /** Per record: why it added nothing, when it did not. The others still count. */
  problems: { source: HistorySource; problem: RecordProblem }[];
}

/** `POST /api/notifications/read`'s answer. */
export interface MarkReadResult {
  loop: string;
  readThrough: string;
  recorded: boolean;
  why: string | null;
}

/* -------------------------------------------------------------- projects */

export const PROJECT_SOURCES = ["local", "github"] as const;
export type ProjectSource = (typeof PROJECT_SOURCES)[number];

/** One registered project, as `projects.json` stores it and `GET /api/projects` lists it. */
export interface ProjectView {
  /** A short slug, unique in the registry, that names the project in URLs. */
  id: string;
  /** Absolute path of the repo's main checkout. */
  path: string;
  addedAt: string;
  source: ProjectSource;
  /**
   * Absolute folder new agent worktrees are created in (each as
   * `<agent>-loop`); absent means the dashboard's default folder. Host-local,
   * so it lives here and never in `.ralph/config.json`.
   */
  worktrees?: string;
}

/** `GET /api/projects`: the registered projects, in registration order. */
export interface ProjectsView {
  projects: ProjectView[];
}

/**
 * A project's health, read cheaply for the switcher: `needs-you` when a loop
 * waits on the operator, `degraded` when a loop is stale, orphaned or unknown
 * or its control record cannot be read, `running` when a loop is working,
 * `idle` otherwise, and `unknown` when the project could not be read at all.
 */
export const PROJECT_HEALTHS = ["needs-you", "degraded", "running", "idle", "unknown"] as const;
export type ProjectHealth = (typeof PROJECT_HEALTHS)[number];

/** Why a loop needs the operator: an approval hold, a block, or a stop that errored. */
export const NEEDS_YOU_REASONS = ["approval", "blocked", "errored"] as const;
export type NeedsYouReason = (typeof NEEDS_YOU_REASONS)[number];

/** One project's health, from its local loop state and control records. */
/**
 * One loop as the sidebar's project rail marks it: what the floor's agent
 * state is read from, and nothing more, so the health read stays local.
 */
export interface HealthAgentView {
  loop: string;
  loopStatus: LoopStatus;
  supervisor: Liveness;
  stage: Stage | null;
  /** The last event's name; a `-wait` one is a loop parked on CI or a merge. */
  lastEvent: string | null;
}

export interface ProjectHealthView {
  project: string;
  readAt: string;
  health: ProjectHealth;
  /** How many loops need the operator; a loop counts once, for its most pressing reason. */
  needsYou: number;
  needs: { loop: string; reason: NeedsYouReason }[];
  /** Roster loops with a checkout, and how many of them are running. */
  loops: number;
  running: number;
  /** Each roster loop's marks, for the project rail; absent from a bridge that predates it. */
  agents?: HealthAgentView[];
  /** Why the project could not be read; null when it was. */
  problem: string | null;
  /**
   * What kind of unreadable it is, so the rail can say it plainly: a folder
   * that is not a Ralph project yet, a folder that is gone, a config that does
   * not validate, or anything else. Absent from a bridge that predates it, and
   * on a project that was read.
   */
  problemKind?: HealthProblemKind;
}

/** Why a project's health is unknown, in the words the rail uses. */
export const HEALTH_PROBLEM_KINDS = ["not-set-up", "missing", "invalid-config", "unreadable"] as const;
export type HealthProblemKind = (typeof HEALTH_PROBLEM_KINDS)[number];

/**
 * `GET /api/projects/health?selected=<id>`: every registered project but the
 * selected one, whose full snapshot the page already polls.
 */
export interface ProjectsHealthView {
  selected: string | null;
  projects: ProjectHealthView[];
}

/* ------------------------------------------------------------ onboarding */

/**
 * Where a project stands on the way to running loops, derived on every read:
 * `ready` once `.ralph/config.json` is on `origin/<baseBranch>`,
 * `setup-pending` while the setup PR is open, `needs-setup` otherwise.
 */
export const PROJECT_STATUSES = ["needs-setup", "setup-pending", "ready"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** `GET /api/p/:project/setup`: the project's status and, while pending, its PR. */
export interface ProjectSetupView {
  project: string;
  status: ProjectStatus;
  /** The branch the config must reach. */
  baseBranch: string;
  /** The open setup PR; null unless `setup-pending`. */
  pr: { number: number | null; url: string } | null;
}

/** `GET /api/p/:project/setup/defaults`: a candidate config pre-filled from git, `gh` and `package.json`. */
export interface SetupDefaultsView {
  project: string;
  config: Record<string, unknown>;
}

/** `POST /api/p/:project/setup/validate`: every problem `project-config` finds, at once. */
export interface SetupValidation {
  valid: boolean;
  problems: string[];
}

/**
 * `POST /api/p/:project/setup/tracker/test` and `/setup/tracker/save`: what
 * the Tracker connector sends (felipearos/ralph#338). The token travels in
 * this body and from the server only to `tracker.ts`, on stdin; it is never
 * logged, put in argv, or echoed back.
 */
export type TrackerConnectRequest =
  | { kind: "linear"; apiKey: string; team?: string }
  | { kind: "jira"; site: string; email: string; apiToken: string; project?: string };

/** What `tracker.ts connect-test` saw: mirrors the harness's `ConnectReport`. */
export type TrackerConnectReport =
  | {
      ok: true;
      kind: "linear" | "jira";
      user: string;
      workspace?: string;
      options: { key: string; name: string }[];
      states?: string[];
      labels?: string[];
    }
  | { ok: false; reason: "refused" | "unknown" | "unreachable" | "invalid"; message: string };

/** `POST /api/p/:project/setup/tracker/save`: the credential is on this host now. */
export interface TrackerSaveResult {
  saved: true;
}

/** `POST /api/p/:project/setup`: the setup PR that was opened. */
export interface SetupSubmitResult {
  project: string;
  branch: string;
  /** The files written on the setup branch, project-relative. */
  files: string[];
  pr: { url: string };
}

/** `owner/name` on GitHub, as `project-config` accepts a `repo`. */
export const GITHUB_REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

/** One entry of `GET /api/github/repos`. */
export interface GithubRepoView {
  nameWithOwner: string;
  description: string | null;
  isPrivate: boolean;
}

export interface GithubReposView {
  repos: GithubRepoView[];
}

/**
 * `POST /api/projects/pick-folder`: the folder the operator chose in the
 * host's own folder dialog, or null when they closed it without choosing.
 */
export interface FolderPickResult {
  path: string | null;
}

/** `POST /api/projects`: the project registered, and where it stands. */
export interface AddProjectResult {
  project: ProjectView;
  /**
   * Null when the project registered but its setup state could not be read
   * (a `gh` outage): the project's own page reads it again, and a wrong
   * `needs-setup` would offer setup for a project that has it (#765).
   */
  status: ProjectStatus | null;
}

/**
 * A refused onboarding request. `path` is set on `CloneTargetExists`: the
 * checkout that is already there, which can be registered as a local project.
 */
export interface OnboardingRefusal {
  error: string;
  message: string;
  path?: string;
  problems?: string[];
  /** Set on `ProjectNotReady`: where the project stands instead. */
  status?: ProjectStatus;
}

/** `POST /api/projects/remove`'s answer. `refused` left the registry as it was. */
export interface RemoveProjectResult {
  project: string;
  outcome: "removed" | "refused";
  why: string;
  /** The project's worktrees whose supervisor is alive, or cannot be seen. */
  running: string[];
}

/* ---------------------------------------------------------------- agents */

/**
 * A new agent's standing. `pending-merge`: its name is not in `loops` on
 * `origin/<baseBranch>` yet, and Start is refused. `ready`: it is, and Start
 * unlocks — the project's own checkout may not have caught up to list it.
 * A `ready` agent whose supervisor is alive is not listed at all.
 */
export const AGENT_STATUSES = ["pending-merge", "ready"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const ROSTER_PR_STATES = ["open", "merged", "closed"] as const;
export type RosterPrState = (typeof ROSTER_PR_STATES)[number];

/** The pull request that adds or removes a loop in the project's `loops`. */
export interface RosterPrView {
  url: string;
  branch: string;
  state: RosterPrState;
}

export const READINESS_STATES = ["pass", "fail", "unknown"] as const;
/**
 * How one readiness item reads. `unknown` is its own answer, never collapsed
 * into `fail`: a command that could not run says nothing about the agent, and
 * an operator told "fail" would go looking for a step they had not missed.
 */
export type ReadinessState = (typeof READINESS_STATES)[number];

/**
 * The steps of `adding-an-agent.md` a new agent's card can check for itself,
 * in the order the card shows them — the guide's own order (its `## Checklist`
 * rows 3 to 11). `roster-pr` is step 3, `worktree` step 5, `labels` step 6,
 * `lineup` step 7, `jav` step 8, `node-modules` step 9 and `preflight` step 11.
 */
export const READINESS_ITEMS = [
  "roster-pr",
  "worktree",
  "labels",
  "lineup",
  "jav",
  "node-modules",
  "preflight",
] as const;
export type ReadinessItemKey = (typeof READINESS_ITEMS)[number];

/** One readiness check of a new agent, as its card shows it. */
export interface ReadinessItem {
  key: ReadinessItemKey;
  /** The item's name on the card, e.g. `roster PR merged`. */
  label: string;
  state: ReadinessState;
  /**
   * One line: why it reads that way, and for anything but a pass what would
   * change it. It is all the card shows beside the state, so a reason that
   * only restates the label leaves the operator where the markdown guide left
   * them.
   */
  reason: string;
}

/** A worktree whose `loop-name` names a loop the project's roster does not list yet. */
export interface PendingAgentView {
  name: string;
  worktree: string;
  status: AgentStatus;
  /** The roster PR adding it, when one can be found. */
  pr: RosterPrView | null;
  /**
   * The role the roster gives it — the base branch's for a `ready` agent, the
   * roster PR's branch for a `pending-merge` one — or null when neither could
   * be read. Never defaulted to `coder`: the role-dependent items then read
   * `unknown`, because a triager checked against a coder's labels starts and
   * is denied by preflight with nothing saying why.
   */
  role: LoopRole | null;
  /**
   * The readiness items, in `READINESS_ITEMS` order, minus the ones that do
   * not apply to this agent's role or to this project: the Jav item is absent
   * where Jav is off, and where the role takes no frontier work or could not
   * be read at all.
   *
   * `preflight` is NOT among them, and that is deliberate: the UI polls
   * `GET /api/agents` every five seconds (`dashboard/ui/agents.tsx`), while
   * `preflight.ts --json` runs `gh auth status`, a `gh label list` of its own
   * and `doppler secrets` — three network calls per agent per poll, plus a
   * `gh label create` for a missing label in `roles.ts`'s `CREATED_LABELS` —
   * against a project that has already met this GitHub burst limit. It has a route of
   * its own that the card asks for.
   */
  readiness: ReadinessItem[];
}

/** `GET /api/agents`: the project's agents that are not in its roster yet. */
export interface AgentsView {
  project: string;
  baseBranch: string | null;
  pending: PendingAgentView[];
  /** Why the base branch's roster could not be read; every agent then reads as pending. */
  problem: string | null;
}

/**
 * `GET /api/agents/guide`: the "adding a new agent" guide, and what its Loggd
 * examples stand for on this project.
 *
 * The markdown travels verbatim and is parsed in the page, so `adding-an-agent.md`
 * stays the single source of the steps and of both its tables — the dashboard
 * holds no second copy of either (`dashboard/guide-model.test.ts` pins that).
 */
export interface GuideView {
  /** `adding-an-agent.md`, verbatim, or the empty string when `problem` says why not. */
  markdown: string;
  /** What the guide's examples are rewritten to; null when the config could not be read. */
  values: GuideValues | null;
  /** Why the guide or the project's values could not be read, else null. */
  problem: string | null;
}

/** The project's own values, in place of the guide's Loggd examples. */
export interface GuideValues {
  /** The project's registry id, which its worktree paths and `models.json` block are under. */
  project: string;
  repo: string;
  baseBranch: string;
  /** The project's main checkout. */
  root: string;
  /** The directory this project's agent worktrees go under. */
  worktrees: string;
}

/** `GET /api/agents/preflight`: one agent's preflight verdict, as a readiness item. */
export interface AgentPreflightView {
  name: string;
  item: ReadinessItem;
}

/**
 * The labels every coder's frontier reads but no preflight declares:
 * `READY_LABEL` and `URGENT_LABEL` in `frontier/next-tasks.ts`, hand-kept and
 * pinned by `contract-parity.test.ts`. A coder's preflight requires only its
 * triple, so without these the Labels page would file `ready-for-agent` — the
 * label without which a coder claims nothing — under the repository's
 * leftovers.
 */
export const CODER_FRONTIER_LABELS = ["ready-for-agent", "priority:urgent"] as const;

/** A roster loop that needs a label, and the role it needs it for. */
export interface LabelUserView {
  loop: string;
  role: LoopRole;
}

/**
 * One label of the project: one a roster loop needs (`usedBy` non-empty), or
 * one the repository carries that no loop needs.
 */
export interface ProjectLabelView {
  /** The spelling `preflight --labels` gives, else the repository's. */
  name: string;
  /**
   * The loops whose preflight requires it — and, for a coder, whose frontier
   * reads it (`CODER_FRONTIER_LABELS`) — in roster order. Empty for a
   * repository-only label.
   */
  usedBy: LabelUserView[];
  /**
   * Whether the repository has it, compared case-insensitively as GitHub does.
   * Null when the repository's labels could not be read: unknown is not missing.
   */
  onRepo: boolean | null;
  /** The repository's hex colour, without `#`, when it has the label. */
  color: string | null;
  description: string | null;
}

/** `GET /api/labels`: every label the project's loops need, and the rest of its repository's. */
export interface LabelsView {
  project: string;
  repo: string | null;
  labels: ProjectLabelView[];
  /** What could not be read — the config, a loop's labels, the repository's — one sentence each. */
  problems: string[];
}

/** `POST /api/agents`'s answer. */
export interface AddAgentResult {
  name: string;
  /** Where the worktree is, or would have been. */
  worktree: string;
  /**
   * `added`: the worktree exists and the roster PR is open. `pr-failed`: the
   * worktree exists but the PR could not be opened (`why` says where it
   * stopped). `refused`: nothing was created.
   */
  outcome: "added" | "pr-failed" | "refused";
  status: AgentStatus | null;
  pr: RosterPrView | null;
  /**
   * Why the new loop's labels are not all there, or null when they are. Its
   * own field rather than a sentence in `why`, because a missing label triple
   * is not a cosmetic shortfall: `preflight`'s `loop-labels` check DENIES the
   * start, so an agent reported as added would never run.
   */
  labels: string | null;
  /**
   * The worktree's `worktreeSetup` run (#694), or null when the config has no
   * steps or no worktree was made. A step that did not pass does not change
   * `outcome` once the roster PR is open — the PR does not depend on the
   * worktree's dependencies — so `why` names it and this field carries it.
   */
  setup: WorktreeSetupRecord | null;
  why: string;
}

/**
 * `POST /api/agents/checkout`'s answer: a worktree for a loop the roster
 * already lists, so there is no roster PR to report.
 */
export interface CreateCheckoutResult {
  name: string;
  /** Where the worktree is, or would have been. */
  worktree: string;
  /**
   * `created`: the worktree exists and carries its `loop-name` and log
   * directory, so Start applies to it. `incomplete`: it exists but could not
   * be provisioned, or a `worktreeSetup` step did not pass, and needs a hand
   * before it will start (`why` says what failed). `refused`: nothing was
   * created.
   */
  outcome: "created" | "incomplete" | "refused";
  /**
   * Why the loop's labels are not all there, or null when they are — the same
   * field, for the same reason, as `AddAgentResult.labels`: `preflight`'s
   * `loop-labels` check denies the start over a missing triple.
   */
  labels: string | null;
  /** The worktree's `worktreeSetup` run (#694), or null when the config has no steps or no worktree was made. */
  setup: WorktreeSetupRecord | null;
  why: string;
}

/** `POST /api/agents/delete`'s answer. */
export interface DeleteAgentResult {
  name: string;
  worktree: string | null;
  /**
   * `deleted`: the worktree is gone, and the roster PR is open when the base
   * branch listed the name. `pr-failed`: the worktree is gone but the PR could
   * not be opened. `refused`: nothing was removed.
   */
  outcome: "deleted" | "pr-failed" | "refused";
  pr: RosterPrView | null;
  why: string;
}

/**
 * Settings' "Clean up worktrees" (#696): the stale registrations removed, and
 * every other one with why it was left, re-judged at the moment of the call.
 */
export interface CleanUpWorktreesResult {
  project: string;
  /** "done" when the registry and the loops' state were read; "refused" when nothing was attempted. */
  outcome: "done" | "refused";
  pruned: { path: string; branch: string | null }[];
  /**
   * The paths sent that were not removed, and every orphaned registration
   * (one only a hand can clear), each with its reason. `registered` is false
   * for a sent path git no longer lists: already gone, nothing in the way.
   */
  skipped: { path: string; branch: string | null; reason: string; registered: boolean }[];
  why: string;
}

/* ------------------------------------------------------- rules saves */

/**
 * How a sentinel or verifier rules save lands: the project config's
 * `configChanges` (#787), `commit` when it says nothing. `commit` pushes the
 * validated config straight onto the base branch as a fast-forward, and opens
 * a config PR only when that push is refused; `pr` always opens one.
 */
export const CONFIG_CHANGES = ["commit", "pr"] as const;
export type ConfigChanges = (typeof CONFIG_CHANGES)[number];

/** A rules commit pushed straight onto the base branch. */
export interface RulesCommitView {
  /** The base branch it now heads. */
  branch: string;
  /** The commit's full SHA. */
  sha: string;
  /** Its subject, which names what changed. */
  subject: string;
}

/** `POST /api/agents/sentinel`'s and `POST /api/agents/verifier`'s answer. */
export type RulesSaveResult =
  /** The rules are on the base branch: the push was a fast-forward of the freshly fetched `origin/<baseBranch>`. */
  | { outcome: "committed"; commit: RulesCommitView }
  /**
   * The rules PR is open. `notCommitted` is why a direct commit was refused,
   * when the project saves by commit and fell back to the PR; absent when the
   * project asked for PRs (`configChanges: "pr"`).
   */
  | { outcome: "proposed"; pr: RosterPrView; notCommitted?: string }
  /** Nothing was pushed: the config, the branch or the rules themselves refused. */
  | { outcome: "refused"; why: string }
  /** The branch may be pushed, but the PR was not opened: `why` says where it stopped. */
  | { outcome: "pr-failed"; why: string };

/* ------------------------------------------------------- verifier rules */

/**
 * A verifier's rules as the settings form edits them: a hand-kept copy of
 * `project-config.ts`'s `VERIFIER_MODES` and the rule part of its
 * `VERIFIER_DEFAULTS` (`contract-parity.test.ts` fences the two). The
 * production URL, deploy source and Sentry project are not rules here: the
 * form never changes where a verifier looks, only how it judges.
 */
export const VERIFIER_MODES = ["observe", "report", "act"] as const;
export type VerifierMode = (typeof VERIFIER_MODES)[number];

/** A verifier's rules, every key spelled. */
export interface VerifierRules {
  /** False switches the verifier off; its gate keeps polling (#789). */
  enabled: boolean;
  windowHours: number;
  checkIns: number[];
  trafficFloor: boolean;
  revert: { rateFactor: number; minEvents: number; minUsers: number };
  follow: { loopPrs: boolean; humanPrs: boolean };
  mode: VerifierMode;
}

export const VERIFIER_RULE_DEFAULTS = {
  enabled: true,
  windowHours: 24,
  checkIns: [1, 6, 24],
  trafficFloor: true,
  revert: { rateFactor: 5, minEvents: 10, minUsers: 2 },
  follow: { loopPrs: true, humanPrs: true },
  mode: "observe",
} as const satisfies VerifierRules;

/**
 * The rules as the base branch's `verifier` block actually spells them: a key
 * it leaves out is absent here, so the form can tell a default from a value
 * someone chose.
 */
export interface VerifierRulesView {
  enabled?: boolean;
  windowHours?: number;
  checkIns?: number[];
  trafficFloor?: boolean;
  revert?: Partial<VerifierRules["revert"]>;
  follow?: Partial<VerifierRules["follow"]>;
  mode?: VerifierMode;
}

/** `GET /api/agents/verifier`'s answer. */
export interface VerifierView {
  baseBranch: string;
  /** A roster loop on the base branch has the role `verifier`. */
  rostered: boolean;
  /** The base branch's config has a `verifier` block. */
  configured: boolean;
  /** That block's rule keys, or null when there is no block. */
  rules: VerifierRulesView | null;
  /** The open PR proposing new rules, if there is one. */
  pending: RosterPrView | null;
  /** How a save lands: committed to the base branch, or proposed as a PR. */
  configChanges: ConfigChanges;
}

/** `POST /api/agents/verifier`'s answer. */
export type ProposeVerifierResult = RulesSaveResult;

/* ------------------------------------------------------- sentinel rules */

/**
 * A sentinel's rules as the settings form edits them: a hand-kept copy of
 * `project-config.ts`'s `SENTINEL_MODES`, `SENTINEL_RULE_KEYS` and
 * `SENTINEL_DEFAULTS` (`contract-parity.test.ts` fences them). The reporter
 * and language are not rules here, as for the verifier: the form never
 * changes where a sentinel looks, only how high its bar is.
 */
export const SENTINEL_MODES = ["observe", "file"] as const;
export type SentinelMode = (typeof SENTINEL_MODES)[number];

export const SENTINEL_RULE_KEYS = ["enabled", "lookbackHours", "minEvents", "minUsers", "maxPerDay", "mode"] as const;

/** A sentinel's rules, every key spelled. */
export interface SentinelRules {
  /** False switches the sentinel off; its gate keeps polling (#789). */
  enabled: boolean;
  lookbackHours: number;
  minEvents: number;
  minUsers: number;
  maxPerDay: number;
  mode: SentinelMode;
}

export const SENTINEL_RULE_DEFAULTS = {
  enabled: true,
  lookbackHours: 24,
  minEvents: 10,
  minUsers: 2,
  maxPerDay: 5,
  mode: "observe",
} as const satisfies SentinelRules;

/**
 * The rules as the base branch's `sentinel` block actually spells them: a key
 * it leaves out is absent here, so the form can tell a default from a value
 * someone chose.
 */
export interface SentinelRulesView {
  enabled?: boolean;
  lookbackHours?: number;
  minEvents?: number;
  minUsers?: number;
  maxPerDay?: number;
  mode?: SentinelMode;
}

/*
 * `bun sentinel/issues.ts --json`, mirrored by hand: the dashboard never
 * imports ralph TypeScript, so these types are the contract and
 * `contract-parity.test.ts` fences the enums and version against the CLI's.
 */

/** Where one issue stands in the sentinel's store. */
export const SENTINEL_ISSUE_STATES = ["observed", "drafted", "filed", "failed"] as const;
export type SentinelIssueState = (typeof SENTINEL_ISSUE_STATES)[number];

/** One reporter issue the sentinel has seen, as the CLI prints it: the draft's title only, never its body. */
export interface SentinelIssueRow {
  /** The store's key, `${reporter}:${id}`. */
  key: string;
  reporter: string;
  id: string;
  title: string;
  /** The reporter's link to the issue, when the candidate carries one. */
  permalink: string | null;
  state: SentinelIssueState;
  events: number;
  users: number;
  attempts: number;
  /** The tracker ref once filed. */
  ticket: string | null;
  ticketNumber: number | null;
  mode: SentinelMode;
  /** What was, or would have been, filed. */
  draftTitle: string | null;
  observedAt: string;
  updatedAt: string;
  cycle: number;
  /** The ref of the closed ticket the current cycle regressed after. */
  regressedAfter: string | null;
}

/** The whole issue store as the CLI prints it, most recently changed first. */
export interface SentinelIssuesView {
  version: 1;
  issues: SentinelIssueRow[];
  /** Today's (UTC) filing ledger: how many were filed, and whether the cap alert went out. */
  today: { day: string; filed: number; alerted: boolean };
}

/**
 * `GET /api/sentinel`'s answer: the Sentinel panel's relayed read (#685). It
 * reads the checkout's config, not the base branch's, because the panel shows
 * what the running sentinel does. It carries no draft body or evidence: the
 * issues are the CLI's own view, titles only.
 */
export interface SentinelPanelView {
  /** The checkout's roster has a loop with the role `sentinel`. */
  rostered: boolean;
  /** The checkout's `sentinel` block with `SENTINEL_RULE_DEFAULTS` filled in, or null when it has none. */
  rules: SentinelRules | null;
  /** The issue store; null when no loop is a sentinel, or when the read failed. */
  issues: SentinelIssuesView | null;
  /** Why `issues` is null after a failed read; null otherwise. */
  problem: string | null;
}

/** `GET /api/agents/sentinel`'s answer, as `VerifierView` for the verifier. */
export interface SentinelView {
  baseBranch: string;
  /** A roster loop on the base branch has the role `sentinel`. */
  rostered: boolean;
  /** The base branch's config has a `sentinel` block. */
  configured: boolean;
  /** That block's rule keys, or null when there is no block. */
  rules: SentinelRulesView | null;
  /** The open PR proposing new rules, if there is one. */
  pending: RosterPrView | null;
  /** How a save lands: committed to the base branch, or proposed as a PR. */
  configChanges: ConfigChanges;
}

/** `POST /api/agents/sentinel`'s answer. */
export type ProposeSentinelResult = RulesSaveResult;

/**
 * The project settings the Settings page edits through a config PR (#691),
 * as `project-config --set-project` reads them on stdin. An absent key is
 * left as the config has it.
 */
export interface ProjectEdit {
  displayName?: string;
  baseBranch?: string;
  /**
   * An ordered list rather than the config's name→command object: a JSON
   * object would silently keep only the last of two gates sharing a name,
   * and the edit must be able to refuse that.
   */
  gates?: { name: string; command: string }[];
  requiredChecks?: string[];
  refuseFiles?: string[];
  /**
   * The worktree setup steps (#694), complete and in order; an empty list
   * clears them. The config's compact form (defaults omitted) is
   * `proposeProject`'s to write.
   */
  worktreeSetup?: WorktreeSetupStepConfig[];
}

/** What proposing project settings came to. */
export type ProposeProjectResult =
  /**
   * The settings PR is open. `warnings` (empty when none) are what the edit
   * may get wrong but is not refused for, such as a required check nothing
   * has reported; the PR body lists them too.
   */
  | { outcome: "proposed"; pr: RosterPrView; warnings: string[] }
  /** The same change already has an open PR; nothing was pushed, and that PR is linked again, with the same warnings. */
  | { outcome: "reused"; pr: RosterPrView; warnings: string[] }
  /** Nothing was pushed: the config, the change itself, the PR list or the new base branch refused. */
  | { outcome: "refused"; why: string }
  /** The branch may be pushed, but the PR was not opened: `why` says where it stopped. */
  | { outcome: "pr-failed"; why: string };

/* ---------------------------------------------------------- unblocker chat */

/**
 * The unblocker chat's wire shapes (spec #251), as `chat-routes.ts` serves
 * them and the chat panel (`ui/chat-model.ts`) reads them. A mirror of
 * `chat.ts`, `chat-routes.ts` and `chat-handback.ts`, which import the harness
 * and so cannot be read by the page; `contract-parity.test.ts` fences the two.
 */
export const CHAT_MODES = ["ask", "fix"] as const;
export type ChatMode = (typeof CHAT_MODES)[number];

export type ChatStatus = "idle" | "running" | "withheld" | "closed";

/** Unblock & resume's steps, in the order a `handback` event reports them. */
export const HANDBACK_STEPS = ["draft", "decision", "worktree", "comment", "label", "journal", "restart"] as const;
export type HandbackStep = (typeof HANDBACK_STEPS)[number];

export type HandbackOutcome = "asked" | "confirmed" | "done" | "already" | "skipped" | "refused" | "failed";

export type ChatEventKind = "operator" | "seed" | "agent" | "turn-end" | "withheld" | "mode" | "fix-turn" | "stop" | "handback";

/** One entry on a chat's stream; every byte of `text` has crossed the redactor. */
export interface ChatEvent {
  /** 1-based and gapless: `?after=<seq>` is "everything newer than this". */
  seq: number;
  at: string;
  kind: ChatEventKind;
  text: string;
  /** On `mode`, `fix-turn` and `stop`: the chat's mode once the event has happened. */
  mode?: ChatMode;
  /** On `handback`: which step of Unblock & resume, and how it went. */
  step?: HandbackStep;
  outcome?: HandbackOutcome;
}

/** What `POST /api/chat` answers. */
export interface StartedChat {
  id: string;
  /** The session this chat forks FROM, or null when it starts fresh. */
  session: string | null;
  source: string | null;
  /** Why there is no session to resume, when there is none. */
  why: string | null;
}

/** What `GET /api/chat/:id` answers, and `POST /api/chat/:id/mode`. */
export interface ChatView extends StartedChat {
  loop: string;
  /** What a handback comments on: the ticket the chat was opened on, else the halted loop's own. */
  ticket: number | null;
  /** An Unblock & resume is running its steps. */
  handingBack: boolean;
  mode: ChatMode;
  /** A Stop & fix is waiting on the loop's iteration boundary. */
  stopping: boolean;
  status: ChatStatus;
  /** The forked session every turn after the first resumes, once it is known. */
  fork: string | null;
  events: ChatEvent[];
  transcript: string;
  transcriptProblem: string | null;
}

/** What `GET /api/chat/:id/events?after=` answers. */
export interface ChatEventsPage {
  events: ChatEvent[];
  next: number;
  status: ChatStatus;
}

/** What `POST /api/chat/:id/stop-and-fix` answers: `fix` once the chat switched, else why not. */
export interface StopAndFixAnswer {
  outcome: "fix" | "pending" | "refused" | "unknown";
  why: string;
  mode: ChatMode;
  /** A stop is still out, and a re-issue waits on it rather than sending another. */
  stopping: boolean;
}

export interface HandbackStepResult {
  step: HandbackStep;
  outcome: HandbackOutcome;
  why: string;
}

/** What `POST /api/chat/:id/handback` answers to a confirmed summary. */
export interface HandbackResult {
  loop: string;
  /** `resumed`: every step passed and the loop was started; else the step it stopped at. */
  outcome: "resumed" | "refused" | "failed";
  step: HandbackStep | null;
  why: string;
  ticket: number | null;
  steps: HandbackStepResult[];
  /** The worktree's paths that refused the handback; empty otherwise. */
  dirty: string[];
  checkout: CheckoutReport | null;
  restart: StartResult | ResumeWorkResult | null;
}

/* --------------------------------------------------------- remote dashboard */

/**
 * The shape version of every pushed snapshot. The bridge stamps it on its row
 * and the remote app compares it with its own (`RALPH_SNAPSHOT_SCHEMA`); bump
 * it whenever a contract a snapshot carries changes shape, so a machine on an
 * older `~/ralph` shows as one instead of as a broken page.
 */
export const SNAPSHOT_SCHEMA = 1;

/**
 * The `ralph.snapshot.project` the `_/` keys (`_/projects`, `_/health`) are
 * stored under. They span every project and the column is NOT NULL, so the
 * bridge writes them under a reserved placeholder and the remote app reads them back with
 * it. A project id starts alphanumeric (`project-id.ts`), so `_` never names a
 * real one.
 */
export const GLOBAL_SNAPSHOT_PROJECT = "_";

/* ------------------------------------------------------------------ evals */

/** The five axes a judge scores an arm on (#801), as `eval-panel.ts` names them. */
export const EVAL_AXES = ["correctness", "scope", "tests", "maintainability", "review"] as const;
export type EvalAxis = (typeof EVAL_AXES)[number];

export interface EvalArmConfigView { name: string; lineup: string; overlay: string | null }
export interface EvalJudgeView { name: string; runner: "claude" | "codex"; model: string }

/** One arm on one case: its trial's numbers and every judge's scores. The reference is arm `a`. */
export interface EvalCaseArmView {
  arm: string;
  outcome: string | null;
  gates: string | null;
  heldOut: string | null;
  findings: { P1: number; P2: number; P3: number } | null;
  rounds: number | null;
  wallSeconds: number | null;
  tokens: number | null;
  costUsd: number | null;
  axes: { judge: string; scores: Record<EvalAxis, number | null>; better: string }[];
  /** A test-set run's objective result for the arm (#855); null for the reference, off a set run, or with no objective grader. */
  objective: "pass" | "fail" | "pending" | null;
  /** The arm's mean axis score over the answering judges, to 2 decimals (#855): never combined with `objective`. */
  judge: number | null;
}

export interface EvalCaseView {
  key: string;
  title: string;
  repo: string;
  prs: number[];
  reference: "person" | "loop" | "mixed" | null;
  arms: EvalCaseArmView[];
  ranking: string[][] | null;
  judges: { name: string; runner: string; status: "ok" | "unavailable"; reason: string }[];
  /** Two arms under the inversion rule, one under spread. */
  contested: { axis: EvalAxis; arms: string[] }[];
  /** The rule that decided `contested`, in words; null when the case has no panel. */
  contestedRule: string | null;
  /** What decides the case objectively on a test-set run (#855); null off a set run or when unscored. */
  grade: { grader: "tests" | "check" | "judge-only"; noEvidence: boolean } | null;
}

export interface EvalArmTotalView {
  arm: string;
  ran: number;
  green: number;
  judged: number;
  wins: number;
  costUsd: number | null;
  costPartial: boolean;
  tokens: number | null;
  medianWallSeconds: number | null;
  heldOut: string | null;
  /** A test-set run's objective tally (#855): tests cases passed of graded, check cases pending; null off a set run. */
  objective: { passed: number; graded: number; pending: number } | null;
  /** A test-set run's mean judge score and the cases it is over (#855), kept apart from `objective`; null off a set run. */
  judge: { mean: number | null; cases: number } | null;
}

/** An arm's axis over its trials: the mean of each trial's panel score, and the lowest and highest (#821). */
export interface EvalAxisSpreadView { mean: number; min: number; max: number }

/** One arm of one repeated case across every trial it ran (#821). The verdict stays the first trial's. */
export interface EvalRepeatView {
  case: string;
  arm: string;
  ran: number;
  green: number;
  /** The trials the panel scored, which `axes` is over. */
  judged: number;
  axes: Record<EvalAxis, EvalAxisSpreadView | null>;
  first: { outcome: string | null; rank: { position: number; of: number; tied: boolean } | null };
}

export interface EvalImprovementView { knob: string; target: string; change: string; arm: string; evidence: string[] }

/** One stage as an eval arm resolved it when its first trial was built (#816). */
export interface EvalResolvedStageView { stage: string; runner: string; model: string; effort: string | null }
/** What an eval arm ran with: its stages, and its prompt overlay's hash when it has one (#816). */
export interface EvalArmResolutionView { stages: EvalResolvedStageView[]; overlayHash: string | null }

/** How far identical arms drift apart, objective and judge apart (#859); null below two arms. */
export interface EvalNoiseSpreadView { objective: number | null; judge: number | null }

/** Mirror of `eval-noise-floor.ts`'s NoiseStatus (#859): whether the latest noise floor still describes the set. */
export interface EvalNoiseStatusView {
  state: "fresh" | "stale" | "missing";
  floor: { version: string; measuredAt: string; runId: string; spread: EvalNoiseSpreadView } | null;
  /** Cases in play the floor never ran, and floor cases no longer in play; null when missing. */
  drift: { added: number; retired: number; share: number } | null;
  staleShare: number;
}

/** One axis of an arm's gap against the floor; a missing or stale floor never says "beyond". */
export interface EvalAxisGapView { gap: number | null; verdict: "within" | "beyond" | "stale" | "no-floor" | null }
export interface EvalArmGapView { arm: string; vs: string; objective: EvalAxisGapView; judge: EvalAxisGapView }
/** Mirror of `eval-noise-floor.ts`'s NoiseReport: a set run's gaps against the latest floor (#859). */
export interface EvalNoiseReportView extends EvalNoiseStatusView { gaps: EvalArmGapView[] }

/** Mirror of `eval-guardrails.ts`'s GuardrailCondition (#871): one condition a goal needs, and why it held or not. */
export interface EvalGuardrailConditionView { id: string; pass: boolean; reason: string }
/** Mirror of `eval-guardrails.ts`'s GoalVerdict: a goal passes only when every one of its conditions does. */
export interface EvalGoalVerdictView { goal: "quality" | "cost"; pass: boolean; conditions: EvalGuardrailConditionView[] }
/** Mirror of `eval-guardrails.ts`'s GuardrailVerdict: whether the proposal arm earns a PR against the baseline arm, per goal. */
export interface EvalGuardrailVerdictView { baseline: string; proposal: string; goals: EvalGoalVerdictView[] }

/** Mirror of `eval-judge-accuracy.ts`'s Tally (#877): verdicts the panel agreed with, of those counted; accuracy null at none. */
export interface EvalAccuracyTallyView { agree: number; total: number; accuracy: number | null }
/** Mirror of the judge accuracy a run carries: overall, per axis, and the verdicts on contested axes left out. */
export interface EvalJudgeAccuracyView { overall: EvalAccuracyTallyView; axes: Record<EvalAxis, EvalAccuracyTallyView>; contested: number }

/** One run as the Evals tab lists it: a summary, never a diff (`eval-runs.ts`). */
export interface EvalRunView {
  id: string;
  dir: string;
  kind: "eval" | "backtest" | "nightly";
  startedAt: string;
  finishedAt: string | null;
  running: boolean;
  stoppedBy: string | null;
  source:
    | { kind: "pr"; repo: string; prs: number[]; ticket: string | null }
    | { kind: "clerk"; clerk: string }
    /** A run over the test set (#854): the set's commit, the filter it ran, and the cases it could not. */
    | { kind: "set"; version: string | null; tags: string[]; cases: string[]; unrunnable: { id: string; reason: string }[] };
  arms: EvalArmConfigView[];
  /** The panel the run recorded it used, else the one its config names. */
  panel: { name: string; runner: string; model: string }[];
  /** Each arm's resolved models by arm name and the panel's seed; null for a run from before #816. */
  resolved: { arms: Record<string, EvalArmResolutionView>; seed: string | null } | null;
  repeats: number;
  cases: EvalCaseView[];
  totals: EvalArmTotalView[];
  repeated: EvalRepeatView[];
  analysis: { status: "ok"; summary: string; improvements: EvalImprovementView[] } | { status: "unavailable"; reason: string } | null;
  /** A later set run's gaps against the noise floor (#859); null before it or off a set run. */
  noise: EvalNoiseReportView | null;
  /** On a run that measures the noise floor (#859): when, and whether its floor was stored. */
  noiseFloor: { measuredAt: string; stored: boolean; spread: EvalNoiseSpreadView | null } | null;
  /** A set run's guardrail verdict (#871); null when the report has none or it does not parse. */
  guardrails: EvalGuardrailVerdictView | null;
  /** The panel's accuracy against the set's calibration verdicts (#877); null off a set run, from an older harness, or when it does not parse. */
  judgeAccuracy: EvalJudgeAccuracyView | null;
  problem: string | null;
}

/** `GET /api/evals`: the project's eval runs and what the Run screen starts from. */
export interface EvalsView {
  runs: EvalRunView[];
  lineups: string[];
  /** The project's clerks, which the Run card offers a clerk source from; empty hides it. */
  clerks: string[];
  /**
   * The app repos (`owner/name`), besides the project's own, a clerk's sample
   * draws from. A clerk run clones its trials from a local checkout of each,
   * so the Run card asks a checkout path for every one.
   */
  clerkRepos: string[];
  /** `noiseFloorArms`: the identical arms a noise-floor run uses (#859). */
  defaults: { panel: EvalJudgeView[]; trialMinutes: number; repeats: number; noiseFloorArms: number };
  history: { trialSeconds: number | null; trialTokens: number | null; trials: number };
  /** Whether the remote page may open a trial's patch: the project's `relayEvalPatches` opt-in (#825). */
  relayPatches: boolean;
  /** Why the runs could not be read; the lists are then empty. */
  problem: string | null;
}

/**
 * `GET /api/evals/patches`, and what the bridge pushes as the `evals-patches`
 * key (#825): every trial patch the project lets the bridge relay, newest run
 * first, each naming its run, case and arm. A list rather than a record keyed
 * `<run>/<case>/<arm>`, since the scrubber blanks strings under keys that look
 * like credentials (an arm named `lean-tokens`). Empty unless the project
 * opted in; `omitted` counts the patches left out to keep the snapshot bounded.
 */
export interface EvalPatchesView {
  enabled: boolean;
  patches: { run: string; case: string; arm: string; text: string; truncated: boolean }[];
  omitted: number;
  /** Why the patches could not be read; the view is then empty and disabled. */
  problem: string | null;
}

/** What `POST /api/evals/start` answers: the run it started, or why not. */
export type EvalStartResult = { ok: true; id: string } | { ok: false; why: string };
/** What `POST /api/evals/stop` answers. */
export interface EvalStopResult { stopped: boolean; why: string | null }

/**
 * What `POST /api/evals/set/add`, `/edit`, `/retire`, `/keep` and `/calibrate` answer (#856, #860, #876): the
 * case written and the commit that wrote it, or why not.
 */
export type EvalSetWriteResult = { ok: true; id: string; sha: string } | { ok: false; why: string };

/** Which graders a test-set case carries, as `evals-set.ts view` prints them. */
export type EvalSetGrader = "held-out tests" | "check" | "gates";

/**
 * Whether a test-set case is saturated (#860): a mirror of `evals-set.ts
 * view`'s row field. `passes` counts full passes among the newest `window`
 * set runs since the case was last kept; `saturated` once it reaches `window`.
 */
export interface EvalSaturationView {
  saturated: boolean;
  passes: number;
  window: number;
}

/**
 * One case in the Test set view: a mirror of `evals-set.ts view`'s rows, not
 * an import of them (the dashboard never imports ralph TypeScript). `reason`
 * and `notes` are present only when the project set `relayEvalPatches`.
 */
export interface EvalSetRowView {
  id: string;
  repo: string;
  prs: number[];
  title: string;
  tags: string[];
  graders: EvalSetGrader[];
  status: "active" | "saturated" | "retired";
  addedAt: string;
  addedBy: string;
  lastRun: { run: string; startedAt: string } | null;
  /**
   * Whether the agents pass this case every time (#860); null for a retired
   * case, and for one whose saturation an older harness did not print or this
   * page could not read: the page never flags what it could not read.
   */
  saturation: EvalSaturationView | null;
  /**
   * How many calibration verdicts the case holds (#876): relayed on every
   * project, since a count says nothing of the operator's reasons.
   */
  calibrations: number;
  reason?: string;
  notes?: string;
  /** The verdicts with their reasons (#876): present only when the project set `relayEvalPatches`, like `reason` and `notes`. */
  calibration?: EvalCalibrationVerdictView[];
}

/**
 * An operator's calibration verdict on a case (#876): a mirror of
 * `evals-set.ts`'s `CalibrationVerdict`. Which of two arms was better on one
 * axis, and why; only relayed with details on, since the reason is the
 * operator's own words about the case.
 */
export interface EvalCalibrationVerdictView {
  arms: [string, string];
  axis: EvalAxis;
  preferred: string;
  reason: string;
  by: string;
  at: string;
}

/**
 * A case the panel contested on its newest set run (#876): where an
 * operator's verdict is worth asking for. A mirror of `evals-set.ts`'s
 * `CalibrationSuggestion`; it carries the axes and arms and a verdict count,
 * never a reason, so it is relayed on every project.
 */
export interface EvalCalibrationSuggestionView {
  id: string;
  title: string;
  contested: { axis: EvalAxis; arms: string[] }[];
  run: string;
  calibrations: number;
}

/**
 * `GET /api/evals/set`, and what the bridge pushes as the `evals-set` key
 * (#856): the committed test set at `version`; `details` says whether rows
 * carry reason and notes.
 */
export interface EvalSetView {
  version: string | null;
  details: boolean;
  cases: EvalSetRowView[];
  /** Whether the latest noise floor still describes the set (#859); missing when none or unreadable. */
  noiseFloor: EvalNoiseStatusView;
  /**
   * Contested cases worth a calibration verdict (#876), uncalibrated first;
   * empty from a harness older than #876 or when none was contested.
   */
  calibrationSuggestions: EvalCalibrationSuggestionView[];
  /** Why the set could not be read; `cases` is then empty. */
  problem: string | null;
}

/** `GET /api/evals/set/case?id=…` (local only): what the edit form fills in. */
export interface EvalSetCaseDetail {
  id: string;
  tags: string[];
  reason: string;
  notes: string;
}

/**
 * One merged PR the Suggestions screen offers as a test-set case (#858): a
 * mirror of `evals-set.ts suggest`'s rows, not an import of them. Its PR
 * title and the reasons the loop struggled only: no diff, no ticket body.
 */
export interface EvalSuggestionView {
  repo: string;
  pr: number;
  title: string;
  url: string;
  mergedAt: string;
  /** The tickets linked to the PR: those it closes, and those the speed ledger handed off as it. */
  tickets: number[];
  score: number;
  /** Why it ranks: `signal` is the ranker's name for it (blocked, parked, reverted, …), `text` says it plainly. */
  reasons: { signal: string; text: string }[];
}

/**
 * `GET /api/evals/suggestions`, and what the bridge pushes as the
 * `evals-suggestions` key (#858): merged PRs ranked by how the loop struggled
 * on them, against the test set at `version`; `missing` names every signal
 * source that could not be read, so a thin list says why it is thin.
 */
export interface EvalSuggestionsView {
  version: string | null;
  suggestions: EvalSuggestionView[];
  missing: { source: string; why: string }[];
  /** Why the suggestions could not be read; `suggestions` is then empty. */
  problem: string | null;
  /** True while the first run is still reading GitHub and the tracker; `suggestions` is then empty. */
  pending?: boolean;
}

/**
 * One recommended run in the inbox (#872): a mirror of `evals-inbox.ts list`'s
 * rows, not an import. It carries the plan's source kind and counts and the
 * recommender's reason, never the plan itself, so any project's may be relayed.
 */
export interface EvalInboxRowView {
  id: string;
  /** What the plan runs, as one label: "PR #12", "test set (tags: a, b)", "clerk acme, up to 20 cases". */
  source: string;
  arms: string[];
  repeats: number;
  /** Worst-case trials, cases × arms × (1 + repeats); null when the test set picks the cases at start. */
  trials: number | null;
  recommendedBy: { kind: "agent" | "person"; name: string };
  reason: string;
  addedAt: string;
}

/**
 * `GET /api/evals/inbox`, and what the bridge pushes as the `evals-inbox` key
 * (#872): the runs waiting for the operator, oldest first as the CLI lists them.
 */
export interface EvalInboxView {
  entries: EvalInboxRowView[];
  /** Why the inbox could not be read; `entries` is then empty. */
  problem: string | null;
}

/**
 * What `POST /api/evals/inbox/add`, `/start` and `/dismiss` answer (#872): the
 * entry added, the run started and the entry it removed, or the entry
 * dismissed; or why not.
 */
export type EvalInboxWriteResult =
  | { ok: true; entry?: EvalInboxRowView; run?: string; removed?: string }
  | { ok: false; why: string };

/**
 * What `POST /api/evals/improve/propose` answers (#873): the improver started
 * in the background on the run, toward the goal; or why not. The proposal
 * itself lands in the inbox minutes later.
 */
export type EvalImproveResult =
  | { ok: true; started: true; run: string; goal: "quality" | "cost" }
  | { ok: false; why: string };

/**
 * What `POST /api/evals/proposals/open-pr` answers (#875): the PR a passed
 * proposal stands for, opened now or already open, and whether the project's
 * `evalsImprover.autoMerge` switch is on (reported, never acted on); or why
 * not, the CLI's refusal.
 */
export type EvalOpenPrResult =
  | { ok: true; kind: "opened" | "exists"; number: number; url: string; proposal: string; autoMerge: boolean }
  | { ok: false; why: string };

/**
 * Mirror of `eval-proposals.ts`'s ProposalStatus (#874): where an improver
 * proposal stands, following its runs. A test-set proposal (#878) is
 * `suggested` until an operator acts on it in the set, then `confirmed`.
 */
export type EvalProposalStatus = "proposed" | "subset-run" | "full-run" | "passed" | "failed" | "suggested" | "confirmed";

/** Mirror of `eval-proposals.ts`'s proposal kinds (#874, #878): the run-config kinds, the prompt kinds and the test-set kinds. */
export type EvalProposalKind =
  | "prompt-overlay" | "lineup" | "judge-prompt" | "analyst-prompt" | "case" | "check" | "retire-suggestion";

/**
 * Mirror of `eval-proposals.ts`'s ProposalSuggestion (#878): what the Test set
 * screen's Confirm sends to the existing set command (add, check, retire).
 */
export type EvalProposalSuggestionView =
  | { kind: "case"; repo: string; prs: number[]; reason: string; tags: string[] }
  // A test file only: an improver's check never names a command, which Confirm would run on the host.
  | { kind: "check"; case: string; test: string }
  | { kind: "retire-suggestion"; case: string; reason: string };

/**
 * One improver proposal (#874): a mirror of `evals-proposals.ts list`'s rows,
 * not an import. It never carries the proposal's content, overlay, lineup or a
 * diff; the rationale and the analyst's answers only on a project that relays
 * eval patches (`relayEvalPatches`).
 */
export interface EvalProposalRowView {
  id: string;
  /** The run the improver read. */
  run: string;
  goal: "quality" | "cost";
  kind: EvalProposalKind;
  status: EvalProposalStatus;
  /** The goal's guardrail verdict on the run that settled it; null until one did. */
  verdict: { pass: boolean; conditions: EvalGuardrailConditionView[] } | null;
  reason: string | null;
  createdAt: string;
  /** The subset and full-set runs it earned, by run id; null until started. */
  runs: { subset: string | null; full: string | null };
  rationale?: string;
  answers?: { knob: string; target: string; change: string }[];
  /** A test-set proposal's one-line target, e.g. "retire c1" (#878); with details only. */
  target?: string;
  /** What confirming a test-set proposal sends (#878); with details only. */
  suggestion?: EvalProposalSuggestionView;
}

/**
 * `GET /api/evals/proposals`, and what the bridge pushes as the
 * `evals-proposals` key (#874): the improver's proposals, newest first as the
 * CLI lists them.
 */
export interface EvalProposalsView {
  /** Whether the rows may carry rationale and answers: the project relays eval patches. */
  details: boolean;
  proposals: EvalProposalRowView[];
  /** Proposals or runs the CLI could not read or advance, printed beside the rows. */
  problems: string[];
  /** Why the proposals could not be read; `proposals` is then empty. */
  problem: string | null;
}

/**
 * A key in the remote store's `ralph.snapshot`: which local route's body it
 * holds. The `_/` keys span every project; the rest are per project, the
 * `…/<loop>` ones per loop.
 */
export type SnapshotKey =
  | "_/projects"
  | "_/health"
  | "dashboard"
  | "notifications"
  | "usage"
  | "setup"
  | "agents"
  | "roots"
  | "jav"
  | "settings"
  | "sentinel"
  | "evals"
  | "evals-patches"
  | "evals-set"
  | "evals-suggestions"
  | "evals-inbox"
  | "evals-proposals"
  | "prompts"
  | "intake"
  | "intake-metrics"
  | "controls"
  | `control/${string}`
  | `checkout/${string}`
  | `history/${string}`
  | `lineup/${string}`;

/** Where a relayed command is: the lifecycle of a `ralph.command` row. */
export const RELAYED_COMMAND_STATES = ["queued", "claimed", "done", "refused", "expired", "failed"] as const;
export type RelayedCommandState = (typeof RELAYED_COMMAND_STATES)[number];

/** The closed list of commands the remote dashboard relays to the machine. */
export const RELAYED_COMMAND_KINDS = ["control", "start", "restart", "stop-now", "resume-work", "agent-start", "mark-read", "eval-start", "eval-stop", "eval-set-add", "eval-set-edit", "eval-set-retire", "eval-set-check", "eval-set-keep", "eval-inbox-add", "eval-inbox-start", "eval-inbox-dismiss", "eval-improve-propose", "eval-set-calibrate", "eval-proposal-open-pr"] as const;
export type RelayedCommandKind = (typeof RELAYED_COMMAND_KINDS)[number];

/** `GET /api/commands/:id` on the remote dashboard: one relayed command. */
export interface RelayedCommandView {
  id: string;
  kind: RelayedCommandKind;
  state: RelayedCommandState;
  createdAt: string;
  /** The latest time the bridge may start it. */
  expiresAt: string;
  finishedAt: string | null;
  /** What the local route answered once it has; `result` is its body, verbatim. */
  httpStatus: number | null;
  result: unknown;
  /** Why it was refused, expired or failed without a local answer. */
  why: string | null;
}

/**
 * A remote command POST's answer when the machine has not finished it within
 * the function's wait: the page polls `GET /api/commands/:id` from here.
 */
export interface RelayAccepted {
  relay: { id: string; state: RelayedCommandState; expiresAt: string };
}

/** `GET /api/bridge` on the remote dashboard: whether the machine is there, and what it allows. */
export interface BridgeStatusView {
  /** The bridge holds an unexpired lease: it heartbeat within the last 45 s. */
  live: boolean;
  /** This project's snapshot cadence. */
  snapshots: "hot" | "idle";
  /** The bridge's last heartbeat, in database time; null when it never beat. */
  lastSeenAt: string | null;
  wake: "realtime" | "poll-only";
  local: "ok" | "dashboard-down" | "redactor-degraded";
  /** Enabled only when live, local ok, the schemas match and the machine allows remote control. */
  controls: "enabled" | "disabled";
  /** Why controls are disabled; null when they are not. */
  why: string | null;
  schema: { bridge: number; app: number };
}

/** `GET /api/versions` (#731): each asked snapshot key's current version, null when it has none. */
export interface VersionsView {
  versions: Record<string, number | null>;
}

/* ------------------------------------------------------------ intake page */

/**
 * The clerk's intake page (felipearos/ralph#459): `clerk-intake.ts --json`
 * and `--metrics --json`, mirrored here because the dashboard reaches the
 * clerk only by CLI. `contract-parity.test.ts` holds each copy to the
 * clerk's own type.
 */
export const INTAKE_STAGES = ["abierto", "cerrado", "movido"] as const;
export type IntakeStage = (typeof INTAKE_STAGES)[number];
export const INTAKE_ASSIGNEES = ["agente", "persona"] as const;
export type IntakeAssignee = (typeof INTAKE_ASSIGNEES)[number];

export interface IntakeTicketView {
  key: string;
  url: string;
  summary: string;
  app: string | null;
  type: string | null;
  priority: string | null;
  difficulty: string | null;
  storyPoints: number | null;
  assignee: IntakeAssignee | null;
  status: string;
  stage: IntakeStage;
  reporter: string | null;
  created: string | null;
  closedAt: string | null;
  movedTo: string | null;
  movedToUrl: string | null;
  reports: number;
  /** Shown on the channel's canvas right now: the Recientes tab. */
  onCanvas: boolean;
  /** Every stage the report went through, oldest first: the Seguimiento column. */
  trail: IntakeStepView[];
}

export const INTAKE_PR_STATES = ["abierto", "mergeado", "cerrado", "borrador"] as const;
export type IntakePrState = (typeof INTAKE_PR_STATES)[number];

/** One stage of a ticket's trail (`clerk/intake-snapshot.ts` `IntakeStep`). */
export type IntakeStepView =
  | { kind: "slack"; url: string | null; at: string | null; reporter: string | null }
  | { kind: "intake"; key: string; url: string | null; status: string; at: string | null }
  | { kind: "team"; key: string | null; url: string | null; status: string | null; held: boolean; at: string | null }
  | { kind: "pr"; repo: string; number: number; url: string; state: IntakePrState; at: string | null };

/** `GET /api/intake`: every intake ticket. Open to whoever can open the page. */
export interface IntakeView {
  v: 1;
  available: boolean;
  /** Why there is nothing to show, in Spanish; null when there is. */
  reason: string | null;
  loop: string | null;
  generatedAt: string | null;
  source: "shadow" | "jira" | null;
  /** `quiet` (felipearos/ralph#443): real tickets on the intake board that nobody in Slack was told about. */
  mode: "shadow" | "quiet" | "live" | null;
  canvasRowCap: number | null;
  /** The project's name, the page's title; null in a snapshot written before it. */
  title: string | null;
  /** The sidebar's shortcuts, from the clerk's config; empty when it names none. */
  links: IntakeLinkView[];
  tickets: IntakeTicketView[];
}

/** One sidebar shortcut (`clerk/intake-snapshot.ts` `IntakeLink`). */
export interface IntakeLinkView {
  group: "GitHub" | "Jira";
  label: string;
  url: string;
}

/** One `clerk-metrics.ts --json` row (`clerk/metrics.ts` `SummaryRow`). */
export interface IntakeMetricsRow {
  key: string;
  label?: string;
  reports: number;
  valuable: number;
  noise: number;
  pending: number;
  /** Reports of work already reported, counted apart from noise. */
  duplicates: number;
  noiseRate: number | null;
  confirmed: number;
  overrideRate: number | null;
  overridesByField: Record<string, number>;
  overrideRateByField: Record<string, number>;
  topChanges: { field: string; agent: string | number | null; human: string | number | null; count: number }[];
  medianConfirmLatencyMs: number | null;
}

export interface IntakeParticipationRow {
  key: string;
  label?: string;
  reports: number;
  last7Days: number;
  last30Days: number;
  lastReportAt: string | null;
  activeWeeks: number;
}

/** A value on either side of a correction: what the clerk proposed, what the person left. */
export type IntakeOverrideValue = string | number | null;

/** One field's precision (`clerk/metrics.ts` `PrecisionFieldRow`). */
export interface IntakePrecisionFieldRow {
  field: string;
  confirmed: number;
  corrected: number;
  precision: number | null;
  topChanges: { agent: IntakeOverrideValue; human: IntakeOverrideValue; count: number }[];
}

export interface IntakePrecisionWeekRow {
  week: string;
  confirmed: number;
  exact: number;
  precision: number | null;
  correctedByField: Record<string, number>;
}

export interface IntakePrecisionCorrection {
  key: string;
  report: string;
  at: string;
  by: string | null;
  field: string;
  agent: IntakeOverrideValue;
  human: IntakeOverrideValue;
}

/** How often confirmers corrected the clerk: the Precisión tab, behind the metrics password. */
export interface IntakePrecisionView {
  confirmed: number;
  exact: number;
  precision: number | null;
  byField: IntakePrecisionFieldRow[];
  byWeek: IntakePrecisionWeekRow[];
  corrections: IntakePrecisionCorrection[];
}

/**
 * `GET /api/intake/metrics`: the operator's numbers. The remote dashboard
 * serves it only behind the metrics password (`remote/intake-auth.ts`).
 */
export interface IntakeMetricsView {
  v: 1;
  available: boolean;
  reason: string | null;
  loop: string | null;
  generatedAt: string;
  skippedLines: number;
  /**
   * Reports per clerk mode in the ledger (felipearos/ralph#443): the rows mix
   * every mode, so the page says how many of them are a quiet or shadow test.
   */
  modes: { shadow: number; quiet: number; live: number };
  byReporter: IntakeMetricsRow[];
  byApp: IntakeMetricsRow[];
  byWeek: IntakeMetricsRow[];
  participation: IntakeParticipationRow[];
  precision: IntakePrecisionView;
}

/**
 * `GET /api/intake/session`, and the answer to a login: whether this browser
 * may read the metrics. `local` is the machine's own dashboard, which has no
 * login; `unconfigured` is a remote deployment with no password set, locked
 * for everyone.
 */
export interface IntakeSessionView {
  access: "local" | "unlocked" | "locked" | "unconfigured";
}

/**
 * How a worktree of a project stands on the Settings page (#689): `in-use`
 * when a roster loop's supervisor is alive or cannot be seen (loop-state never
 * reported it), `idle` when a roster loop's supervisor is dead, `unowned` when
 * no roster loop owns it or the Reconciliation page lists it.
 */
export const WORKTREE_USES = ["in-use", "idle", "unowned"] as const;
export type WorktreeUse = (typeof WORKTREE_USES)[number];

/** One worktree of the project, as the Settings page lists it. */
export interface SettingsWorktreeView {
  path: string;
  /** The checked-out branch's short name; null when detached. */
  branch: string | null;
  /** The repo's main checkout. */
  main: boolean;
  /** The loop its record names, else its `.ralph/loop-name`, else null — the dashboard's own attribution. */
  loop: string | null;
  use: WorktreeUse;
  /** What the Reconciliation page lists it as, or null when it does not list it. */
  reconciliation: "orphaned" | "prunable" | "unattributed" | null;
}

/**
 * What setting or clearing a project's worktrees folder answers (#693).
 * Existing worktrees stay where they are: only worktrees created after this
 * use the new folder.
 */
export interface SetWorktreesResult {
  project: string;
  /** The folder new agent worktrees are created in from now on. */
  worktreesDir: string;
  /** True when the project now sets no folder of its own, so `worktreesDir` is the default. */
  worktreesDefault: boolean;
  /** Where worktrees go when the project's folder is cleared. */
  defaultWorktreesDir: string;
}

/** The Settings page's read-only overview of one project (#689). */
export interface ProjectSettingsView {
  project: string;
  /** The main checkout and when it was added to the project registry (ISO, or null if unknown). */
  checkout: { path: string; addedAt: string | null };
  /** The folder new agent worktrees are created in. */
  worktreesDir: string;
  /** True when the project sets no folder of its own, so `worktreesDir` is the dashboard's default. */
  worktreesDefault: boolean;
  /** Where worktrees go when the project's folder is cleared. */
  defaultWorktreesDir: string;
  /** Null when the config could not be read or failed validation; `problems` says why. */
  config: {
    repo: string;
    owner: string | null;
    baseBranch: string;
    displayName: string | null;
    /** Every gate command of `.ralph/config.json`, by name, in the config's order — what the harness runs. */
    gates: { name: string; command: string }[];
    /** The CI checks the config requires green before a hand-off, in order. */
    requiredChecks: string[];
    /** The files whose presence refuses a loop's startup (they would shadow the injected env), in the config's order. */
    refuseFiles: string[];
    /** The worktree setup steps (#694), defaults filled, in the order they run; empty when the config has none. */
    worktreeSetup: WorktreeSetupStepConfig[];
  } | null;
  /** Every validation problem of `.ralph/config.json` (or the one reason it could not be read). Empty when valid. */
  problems: string[];
  /** Null when the worktrees could not be listed; `worktreesProblem` says why. */
  worktrees: SettingsWorktreeView[] | null;
  worktreesProblem: string | null;
}

/**
 * One prompt fragment the project's config names (#695), as the Settings
 * page's Prompts section shows it. A fragment the config does not name is
 * left out of the list rather than drawn as missing: naming none is a choice,
 * while a named file that is absent is a broken config an operator must see.
 */
export interface PromptFragmentView {
  /** Which config key names it: `promptFragment`, `coderFragment` or `plan`. */
  kind: "prompt" | "coder" | "plan";
  /** The path as the config spells it, relative to the project checkout. */
  path: string;
  /** The file's text; null when it is missing or unreadable. */
  text: string | null;
  /** True when the named file does not exist, told apart from one that cannot be read. */
  missing: boolean;
  /** Why a file that exists could not be read; null when it was read or is merely missing. */
  problem: string | null;
}

/**
 * One role's prompt as `models.ts --render-prompt` renders it (#695). Each
 * role is rendered as the first roster loop holding it: a render needs a loop
 * name, and the loops of one role share the template and the fragments.
 */
export interface PromptRenderView {
  role: LoopRole;
  /** The roster loop the role was rendered as. */
  loop: string;
  /** The rendered prompt, whole; null when the render failed. */
  prompt: string | null;
  /** Why the render failed; null when it succeeded. A failed render never hides the fragments. */
  error: string | null;
}

/**
 * The Settings page's Prompts section (#695): the fragments the config names
 * and each roster role's rendered prompt. Its own snapshot key, not part of
 * `ProjectSettingsView`, because each render costs a process per role, which
 * the overview's other readers (Edit, Gates) should not wait on.
 */
export interface ProjectPromptsView {
  /** The named fragments, in the order prompt, coder, plan. */
  fragments: PromptFragmentView[];
  /** One render per distinct roster role, in roster order; empty when the roster cannot be read. */
  renders: PromptRenderView[];
  /** Why the config or its roster could not be read; empty when both were. */
  problems: string[];
}

/** A Settings gate run's state (#690): `timeout` is its own outcome, never a pass or a fail. */
export type GateRunState = "running" | "passed" | "failed" | "timeout";

/** One gate run from the Settings page, as `dashboard/gate-run.ts` keeps it. */
export interface GateRunView {
  gate: string;
  command: string;
  state: GateRunState;
  /** ISO time the run started. */
  startedAt: string;
  /** Null while running. */
  durationMs: number | null;
  /** Null while running, on timeout, on a signal death, or on a spawn error. */
  exitCode: number | null;
  /** The last `tailLines` lines of stdout and stderr, in arrival order, ANSI stripped. */
  output: string;
  /** The output had more lines than were kept. */
  truncated: boolean;
  limitMs: number;
  /** The spawn failure (e.g. a missing cwd), else null. */
  error: string | null;
}

/** `GET` and `POST /api/settings/gates/run`: the project's latest run, or null when none has run. */
export interface GateRunAnswer {
  run: GateRunView | null;
}

/**
 * One `worktreeSetup` step of `.ralph/config.json` (#694), as `project-config
 * --json` prints it: defaults already filled, so the dashboard decides none.
 */
export interface WorktreeSetupStepConfig {
  name: string;
  command: string;
  timeoutSeconds: number;
  installsDependencies: boolean;
}

/** A setup step's outcome: `skipped` is a step never run because an earlier one did not pass. */
export type WorktreeSetupStepState = "passed" | "failed" | "timeout" | "skipped";

/** One setup step as it ran, kept in the worktree so the operator can read why a setup stopped. */
export interface WorktreeSetupStepView {
  name: string;
  command: string;
  state: WorktreeSetupStepState;
  /** Null for a skipped step. */
  durationMs: number | null;
  /** Null for a skipped step, on timeout, on a signal death, or on a spawn error. */
  exitCode: number | null;
  /** The output's tail, ANSI stripped, as for a gate run; "" for a skipped step. */
  output: string;
  truncated: boolean;
  limitMs: number;
  /** The spawn failure, else null. */
  error: string | null;
}

/** A worktree's last setup run: when it started, and every step in config order. */
export interface WorktreeSetupRecord {
  /** ISO time the setup started. */
  ranAt: string;
  steps: WorktreeSetupStepView[];
}

/**
 * `POST /api/agents/setup`'s answer (#694): the `worktreeSetup` steps re-run in
 * an existing loop's worktree. `passed`: every step passed. `failed`: one did
 * not (`why` names it; the record has its output). `refused`: nothing ran.
 */
export interface RerunSetupResult {
  name: string;
  /** The worktree the steps ran in, or null when none was found. */
  worktree: string | null;
  outcome: "passed" | "failed" | "refused";
  setup: WorktreeSetupRecord | null;
  why: string;
}
