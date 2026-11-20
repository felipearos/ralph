/**
 * The roles a loop can hold, and the one place each declares how it differs
 * from a coder.
 *
 * Every loop used to be a coder: it takes a ready ticket off the frontier,
 * builds it and shepherds the pull request to merge. A roster entry may now
 * name another role — `{ "name": "tria", "role": "triager" }` in
 * `.ralph/config.json` `loops` — and a plain string is still a coder, so a
 * roster of strings reads exactly as it always has.
 *
 * A role's behaviour hangs off its descriptor here rather than off `role ===`
 * checks scattered through the harness: the prompt, the stage set, the
 * preflight checks, the intake gate, the sigils, the phases, the secrets and
 * the host lease each become a field when the ticket that needs them lands.
 * The intake has landed — `intakeGate`, `frontierBucket` and `javRouted` below —
 * and so has the prompt: `prompt` and `fragmentSection`. So has the startup
 * check list: `preflight`. The rest still say only what the roster needs.
 *
 * What a role never changes is the claim fence: a triager's or a doctor's
 * `-wip` fences coders off an issue, and a coder's fences them, because every
 * fence reads every roster name whatever its role (`frontier/next-tasks.ts`).
 *
 * Imports nothing from the harness: `project-config.ts` validates the roster
 * against this module, so it must not import that one back.
 */

/** Every role, in the order problems and usage lines list them. */
export const ROLES = ["coder", "triager", "ci-doctor", "pr-medic", "clerk", "verifier", "sentinel"] as const;

export type Role = (typeof ROLES)[number];

/** The role of a roster entry that names none: a plain string, or an object without `role`. */
export const DEFAULT_ROLE: Role = "coder";

/**
 * Which of the frontier's buckets a role's intake takes work from.
 *
 * `ready` is the coder's: the frontier's own READY NOW picks, one per staffing
 * group, handed over one at a time. `triage` is the triager's, and it is four
 * buckets behind one name — a tree that needs staffing, tickets difficulty
 * routing strands, issues nobody has looked at, and a ticket too big for one
 * agent — offered as a UNIT, which for routing is a batch rather than a single
 * ticket. Both go through the same claim lock and write the same lease; only
 * which tickets are offered, and how many at a time, differs.
 */
export type FrontierBucket = "ready" | "triage";

/**
 * A sigil a session may end with (`prompt.md`'s HARD RAIL, `ralph/phase.ts`).
 *
 * The five terminal ones plus the three hand-backs, which is every ending the
 * supervisor knows how to read. A role declares the subset its sessions may
 * use; see `sigils` below for what happens to the rest.
 */
export const SIGILS = [
  "DONE",
  "ALL_BLOCKED",
  "COMPLETE",
  "NEEDS_TRIAGE",
  "RETRY_LATER",
  "AWAIT_PR",
  "AWAIT_HOST",
  "PHASE",
] as const;

export type Sigil = (typeof SIGILS)[number];

/**
 * The lineup stages a run resolves a model for, as dotted names, because that
 * is how the config nests them.
 *
 * Here rather than in `models.ts` for the reason `PREFLIGHT_CHECKS` is here
 * rather than in `preflight.ts`: a role's stage set has to be a typed SUBSET of
 * one list, `models.ts` already imports this module, and the import the other
 * way would be a cycle. A second copy of the names would drift, and a role
 * naming a stage that does not exist would be a lineup silently never
 * resolved rather than a compile error. `models.ts` re-exports both names, so
 * the resolver is still where everything else reads them from.
 */
export const CODER_STAGES = [
  "orchestrator",
  "executor",
  "mapper",
  "review.standards",
  "review.spec",
  // The third review axis (correctness): an adversarial bug hunt over the
  // diff. Last, and defaulted in `models.ts` (`BUILT_IN_STAGES`), because every
  // block was written before it existed and must keep resolving.
  "review.correctness",
] as const;

/**
 * Every stage the resolver knows: the coder's six, and the clerk's
 * `code-context` session (felipearos/ralph#499). That one is not a stage of the
 * coder's iteration at all: it is the model a clerk runs its code-context
 * iterations on, which read the application code behind a filed ticket. It is
 * a stage so that it resolves, validates, exports and shows in the lineup
 * editor like every other model choice, and only the clerk has it.
 */
export const STAGES = [...CODER_STAGES, "code-context"] as const;

export type Stage = (typeof STAGES)[number];

/**
 * Every check the startup preflight can be asked for, by the name its result
 * line and its `--json` are keyed by, in the order `preflight.ts` asks them.
 *
 * The vocabulary lives here rather than in `preflight.ts` because a role's
 * check list has to be a typed SUBSET of one list, and this is the module
 * `preflight.ts` already imports — the reverse import would be a cycle, and a
 * second copy of the names would drift the way `role-behaviour.ts` once
 * drifted from `phase.ts`'s sigils. `preflight.ts` types its own result names
 * against this list too, so a role naming a check that does not exist is a
 * compile error rather than a check that silently never runs.
 */

/**
 * The three checks every role is held to whatever its list says.
 *
 * The role itself is read out of the project's config and the loop's name, so a
 * run that skipped them would be deciding what to check from what it had
 * refused to look at — and `tools` guards every probe after it, since a missing
 * `gh` makes each one fail as "not authenticated" instead. A descriptor that
 * dropped one would be a declaration that lies: `preflight.ts` runs them
 * regardless. `roles.test.ts` fences it instead.
 */
export const MANDATORY_CHECKS = ["project-config", "tools", "loop-identity"] as const;

export const PREFLIGHT_CHECKS = [
  "project-config",
  "tools",
  "loop-identity",
  "logs-writable",
  "repository-state",
  "frontier-prerequisites",
  "executor-tools",
  "buildkite-logs",
  "buildkite-retry",
  "clerk-credentials",
  "verifier-credentials",
  "github-credentials",
  "loop-labels",
  "clerk-intake-board",
  "doppler-scope",
] as const;

export type PreflightCheck = (typeof PREFLIGHT_CHECKS)[number];

/** The severity a role gives a check that FAILS. */
export type CheckSeverity = "warn" | "denied";

export interface RolePreflight {
  /**
   * The checks the preflight asks for this role — every one but
   * `MANDATORY_CHECKS`, which no list can drop.
   *
   * A check this list omits is not RUN, not merely left out of the report: the
   * point of dropping `doppler-scope` for a role given no application
   * environment is that no Doppler probe happens, so a host with no such
   * credential at all still starts.
   */
  checks: readonly PreflightCheck[];
  /**
   * Checks whose failing verdict this role replaces.
   *
   * `buildkite-logs` is the case it exists for: no read token is a warning for
   * a coder, which explains a red check worse without it, and a denial for the
   * ci-doctor, whose entire iteration is reading those logs. Without the
   * override that role would start, find it cannot see the build, and spend an
   * orchestrator turn discovering a setup fault.
   *
   * An override applies only to an outcome that came back `warn` or `denied`.
   * `unavailable` is deliberately left alone: it means an external service
   * could not be reached, which is a wait for every role, and promoting it
   * would let one network blip permanently refuse a loop left running
   * overnight.
   */
  verdicts: Readonly<Partial<Record<PreflightCheck, CheckSeverity>>>;
  /**
   * Project labels `loop-labels` requires for this role on top of the per-loop
   * triple.
   *
   * Required rather than warned about, for the same reason the triple is: a
   * role whose verdict label does not exist writes nothing to the issue and
   * reports success, and the operator learns about it one full iteration
   * later.
   */
  labels: readonly string[];
  /**
   * Whether the project's Jav difficulty labels are required too.
   *
   * They are the triager's working vocabulary — the labels it applies and
   * every coder's intake is routed by — and they are configured per project
   * (`jav.json`), so they cannot be listed above.
   *
   * Spelled out rather than `javLabels`, because `javRouted` above is a
   * different question with the opposite answer for every role: a coder's
   * intake is NARROWED by those labels and requires none of them to exist,
   * while a triager applies them and requires all of them. Two near-identical
   * booleans would make an edit to the wrong one a silent behaviour change.
   */
  requiresDifficultyLabels: boolean;
}

/**
 * The triage vocabulary a triager writes its verdicts with.
 *
 * The one list to quote: the preflight requires exactly these, and this is where
 * a change to the vocabulary is made. `prompts/triager.md` names the intake
 * VERDICTS it has to name in prose, because a prompt cannot import TypeScript and
 * a model has to be told which one to pick; it restates no more of the list than
 * that, so what a triager may write and what preflight requires cannot drift.
 */
export const TRIAGE_LABELS = [
  "needs-triage",
  "needs-info",
  "ready-for-agent",
  "ready-for-human",
  "wontfix",
  "spec",
  "duplicate",
] as const;

/** Which process a role's secret is exported to. */
export type SecretTarget = "iteration" | "gate";

export interface RoleSecret {
  /** The environment variable, which is also the name read from the secrets scope. */
  name: string;
  /**
   * The command that proves the credential is the narrow one this role asked
   * for, as a path under `$RALPH_HOME` with its flags, or null while no check
   * exists yet.
   *
   * Null is not "no check needed": an unproved credential is withheld exactly
   * as a failed check's is, with the same one-line warning. It is a placeholder
   * for a secret whose checker ships with the ticket that first uses it, so the
   * supervisor can already carry the secret's declaration.
   */
  check: string | null;
  /**
   * Where the value goes. `iteration` exports it to the model session;
   * `gate` exports it to the role's intake gate alone and strips it from the
   * iteration (`RALPH_ENV_FILTER`), so a credential the gate needs to act with
   * never reaches a model turn. Both is both.
   */
  targets: readonly SecretTarget[];
}

export interface RoleSecrets {
  /**
   * Whether the project's secrets manager (`secrets.runner`) wraps this role's
   * children at all.
   *
   * A coder's gates validate against the configuration the project is really
   * deployed with, so they run under it. A triager runs no gates and touches no
   * application code, so it is given no application environment — and with
   * nothing injected the project's own env check has nothing to verify, so it
   * is skipped too rather than refusing every triager start.
   */
  manager: boolean;
  /** The named credentials the supervisor reads, checks and exports itself. */
  named: readonly RoleSecret[];
}

/**
 * A post-iteration check on the worktree a role must leave behind.
 *
 * `clean-detached` is the read-only role's: nothing uncommitted, and HEAD
 * detached at the base branch. A violation is repaired rather than fatal — the
 * diff is saved, the checkout restored and a `role-invariant` notification
 * pushed — because a read-only role that wrote something has a prompt bug, and
 * stopping the run leaves the stray edit in the worktree the next loop reads.
 */
export type RoleInvariant = "clean-detached";

export interface RoleDescriptor {
  /** The role, as a roster entry spells it. */
  role: Role;
  /** What a loop in this role does, in one line. */
  summary: string;
  /**
   * The intake gate the supervisor runs to decide whether to spend an
   * iteration, as a path under `$RALPH_HOME`.
   *
   * A role declares a command rather than inheriting `frontier-gate.ts`
   * because what counts as "there is work" differs: a doctor's gate asks
   * Buildkite, not the backlog. The contract does not differ — exit 0 with a
   * `work available — …` line, block or wait otherwise, honour the control
   * inbox, never spawn on an unreadable probe — which is why the supervisor
   * reads any of them the same way.
   */
  intakeGate: string;
  /**
   * The frontier bucket `frontier/next.ts --take-one --role <role>` offers, or
   * null when the role does not take work off the frontier at all.
   *
   * Null is the ci-doctor: its case is a red build, which the backlog cannot
   * see, so it finds the case itself and claims the issue by number
   * (`claim-lease.ts claim <n>`). The alternative would be teaching the
   * frontier to offer work it cannot observe, which puts a bucket nobody can
   * verify inside the fence everything else depends on.
   */
  frontierBucket: FrontierBucket | null;
  /**
   * Whether difficulty routing (Jav) narrows this role's intake.
   *
   * Routes are written per coder, to keep a hard ticket away from a loop on a
   * small model. A triager reads exactly what no coder's route matches, and a
   * doctor reads CI, so a route would filter their intake to nothing.
   */
  javRouted: boolean;
  /**
   * The prompt template the supervisor renders for a loop in this role, as a
   * path under `$RALPH_HOME`.
   *
   * The coder's is `prompt.md`, which every role's prompt descends from; the
   * others live under `prompts/`. A role's template is a template and not a
   * variant of the coder's, because what an iteration of it does differs at
   * every step — a triager never opens a pull request — and a prompt built by
   * subtracting sections from another role's would have to be re-read in full
   * to know what it now says.
   */
  prompt: string;
  /**
   * The prefix this role's sections carry in a project's prompt fragment
   * (`.ralph/prompt.md`), or `''` for the coder's, which carry none.
   *
   * One fragment file holds every role's project guidance, because it is one
   * project speaking and its rails (the migrations rail, the gate commands)
   * are quoted by more than one role. A role's template places
   * `{{PROJECT_PROMPT_TRIAGER_X}}` against `<!-- ralph:section TRIAGER_X -->`,
   * and the unplaced-section refusal (`models.ts`) skips whatever another role
   * owns — otherwise adding a triager's guidance would break every coder's
   * render, which is the one thing roles must never do.
   *
   * Unprefixed is the coder's rather than shared, so that a project written
   * before roles existed keeps meaning exactly what it meant.
   *
   * **No role's prefix may be a prefix of another's.** `sectionRole` answers
   * with the first that matches, so a role declaring `CI` would take
   * `CI_DOCTOR_RETRY` off the doctor — and the doctor would then stop refusing
   * its own unplaced sections, silently. `roles.test.ts` fences it.
   */
  fragmentSection: string;
  /**
   * The sigils a session of this role may end with.
   *
   * A sigil outside the set is not read at all: it falls to the missing-sigil
   * recovery (`recover_missing_sigil`), and a second such ending stops the
   * supervisor as a no-sigil death does. Refused rather than reinterpreted,
   * because every reading of an out-of-role sigil is a guess — a triager's
   * `AWAIT_PR` names a pull request it never opened, and treating it as DONE
   * would report work that did not happen.
   */
  sigils: readonly Sigil[];
  /**
   * What the recovery turn tells a session of this role, when it ended without
   * a sigil the role may use.
   *
   * Per role because the text is a menu of endings: offering a triager
   * `AWAIT_PR` invites the exact ending that got it here.
   */
  recoveryPrompt: string;
  /**
   * Whether an iteration of this role runs in phases (`ralph/phase.ts`).
   *
   * Off skips the whole mechanism — `phase_resume`, the ledger under
   * `.ralph/logs/phases/`, and `PHASE` handling — for a role whose iteration has
   * no boundaries to yield at. A triager reads and writes labels in one pass;
   * a doctor reuses the coder's phases for the fixes it opens.
   */
  phases: boolean;
  /**
   * Whether the number in this role's `PHASE` sigils is a tracker ticket the
   * supervisor may read at a boundary to see if it was closed outside the
   * loops (#809). Off for a role whose phase number is something else — the
   * pr-medic's is the pull request's — where that read would ask the tracker
   * about an unrelated ticket; off for a role whose wrap-up would have more to
   * undo than a branch and a claim (the ci-doctor's case store); and off for a
   * role with no phases.
   */
  phaseTicketProbe: boolean;
  /** The environment the supervisor gives this role. */
  secrets: RoleSecrets;
  /** The post-iteration check on the worktree, or null for a role that may write. */
  invariant: RoleInvariant | null;
  /**
   * The startup checks this role is held to, and the labels it cannot work
   * without (`preflight.ts`).
   *
   * Per role because a check whose answer cannot matter is not free: it is a
   * subprocess on the critical path of every start, and — worse — a refusal
   * for a prerequisite the role never reaches. A triager denied for an
   * unreadable Doppler scope it is never given is a loop that cannot start for
   * a reason that does not apply to it.
   */
  preflight: RolePreflight;
  /**
   * The lineup stages a loop in this role resolves, validates and reports
   * (`models.ts`).
   *
   * Per role because a stage this role never runs is not free either: it is a
   * model an operator has to choose, keep current and pay for, and a
   * `models.json` block that names it is a lineup whose author believes it
   * applies somewhere. A block naming a stage outside the set is refused for
   * the same reason a bare loop block is.
   *
   * The set is in `STAGES` order and contains `orchestrator`, because every
   * role runs a model session whatever else it does. `roles.test.ts` fences
   * both, so a set written out of order or without one cannot ship.
   */
  stages: readonly Stage[];
  /**
   * Whether this role takes part in the host lease (`host-lease.ts`).
   *
   * False for a role that runs no local gates: it never holds the host, is
   * never held waiting for it, and may not request it — `AWAIT_HOST` is simply
   * not in its sigils. Holding a triager behind a busy host would pay an
   * iteration's latency for a fence its work cannot trip.
   *
   * It does still run a model session on that host, and now never registers as
   * inside a turn, so a coder may be granted a "quiet host" while a triager is
   * mid-turn. That is the trade: the lease fences heavy LOCAL COMMANDS, and a
   * role that runs none cannot make the host un-quiet in the way it measures.
   */
  hostLease: boolean;
  /**
   * Whether this role's intake gate holds on an unchanged verdict (#771).
   *
   * True for a gate that reads `gate-verdict-store.ts`: it answers "no work"
   * while the verdict it last handed an iteration is unchanged, so the
   * supervisor drops its `gate-disagreement` halt for this role — the hold is
   * what stops the gate and the iteration from disagreeing forever. A gate
   * that does not hold keeps the halt, so a stable disagreement there still
   * stops for a human instead of spending a model turn per interval.
   */
  gateHolds: boolean;
  /**
   * How long this role's intake gate waits between polls when the operator
   * names no `RALPH_WAIT_FOR_WORK` (`start.sh`).
   *
   * Per role because the interval is a guess about how fast this role's INPUT
   * changes, and the roles differ by an order of magnitude. A coder's input is
   * the frontier, which another loop's merge can change at any moment. A
   * triager's is the SHAPE of the backlog — a tree nobody has staffed, an
   * issue nobody has read — which changes when a human files something or a
   * coder finishes, on the scale of an iteration rather than a minute. Polling
   * it as often as a coder polls the frontier spends GitHub reads on an answer
   * that cannot have moved, and every one of those reads is shared with the
   * loops that do have work.
   */
  pollSeconds: number;
  /**
   * Extra rails for this role's ORCHESTRATOR session: a Claude Code settings
   * file inside the harness whose `permissions.deny` is added to the session
   * with `--settings`, or null for none.
   *
   * The executor's rails (`claude-executor-settings.json`, the codex
   * executor's prefix rules) are one set for every role and already deny it
   * `git push`. The orchestrator is where pushing lives — a coder pushes its
   * own branch from there — so a role that must push only through a fence
   * needs its rail HERE, and only for itself: null leaves a role's
   * orchestrator command line byte-identical to the one that predates this
   * field. The codex orchestrator has no rail a session can be handed this
   * way, so `ralph.sh` refuses to start a role that declares one under it
   * rather than run it unfenced.
   */
  orchestratorSettings: string | null;
}

/**
 * Every check but the named ones.
 *
 * A role states what it DROPS rather than what it asks for, so a check added
 * later applies to every role that has not deliberately refused it. The other
 * way round, a new prerequisite would silently go unchecked for every role but
 * the coder — and the checks worth adding are the ones whose absence is
 * expensive.
 */
export const without = (...dropped: readonly PreflightCheck[]): PreflightCheck[] =>
  PREFLIGHT_CHECKS.filter((check) => !dropped.includes(check));

/**
 * The role labels preflight may create itself, with how GitHub shows them.
 *
 * A label a release declares would otherwise deny every GitHub loop's next
 * start until somebody ran `gh label create`, and nobody is awake for that.
 * Every other role label — the triage vocabulary, Jav's difficulty labels, a
 * ci-doctor's — stays DENIED when missing: those are spelt by an operator, and
 * a misspelt one must be refused, not created.
 */
export const CREATED_LABELS: Readonly<Record<string, { color: string; description: string }>> = {
  "migration-applied": { color: "0e8a16", description: "The ticket's migration was applied to production by hand" },
  // The verifier's verdict vocabulary (felipearos/ralph#560): the harness
  // spells these, not an operator, so a verifier's first start creates them
  // rather than being refused over labels nobody had a reason to make yet.
  following: { color: "1d76db", description: "A verifier is watching this merged ticket in production" },
  verified: { color: "0e8a16", description: "A verifier verified this ticket in production" },
  unexercised: { color: "c5def5", description: "No production traffic reached this ticket's change in its watch window" },
  inconclusive: { color: "fbca04", description: "A verifier could not verify this ticket: a signal was unavailable" },
  "needs-human": { color: "b60205", description: "A verifier stopped routing fixes for this ticket after two failed rounds" },
  // The sentinel's tickets carry it (spec felipearos/ralph#678 has preflight
  // create it), so its first start needs no hand-made label. It is also triage
  // vocabulary, so a triager's missing `ready-for-human` is now created rather
  // than refused: the label means the same thing to both.
  "ready-for-human": { color: "d4c5f9", description: "A person decides whether a loop should take this ticket" },
};

export const ROLE_DESCRIPTORS: Readonly<Record<Role, RoleDescriptor>> = {
  coder: {
    role: "coder",
    summary: "takes a ready ticket off the frontier, builds it and shepherds its pull request to merge",
    // The coder's six, as the role the whole vocabulary was written for.
    stages: [...CODER_STAGES],
    intakeGate: "frontier-gate.ts",
    frontierBucket: "ready",
    javRouted: true,
    prompt: "prompt.md",
    fragmentSection: "",
    // Every sigil: the coder is the role the vocabulary was written for.
    sigils: [...SIGILS],
    recoveryPrompt: "Your previous Ralph turn ended without a control sigil while work was pending. This is the only recovery turn. Inspect the current worktree state. Do not start background work or promise a future turn. Finish anything that can be finished now, or journal and hand off the remaining work. If a pushed PR is only waiting on CI or the merge queue, end with <ralph>AWAIT_PR <pr> ci</ralph> or <ralph>AWAIT_PR <pr> merge</ralph> and the supervisor waits for it. If you had just finished a phase and written its handoff note, end with <ralph>PHASE <next> <n></ralph> and the supervisor resumes this session. If the work is blocked only on something outside the repository that time or an operator will clear (a CI or deploy provider outage, blocked deployments), journal it and end with <ralph>RETRY_LATER</ralph>; the supervisor backs off and re-checks. Otherwise end with exactly one valid Ralph sigil on its own final line: <ralph>DONE</ralph>, <ralph>ALL_BLOCKED</ralph>, <ralph>COMPLETE</ralph>, or <ralph>NEEDS_TRIAGE</ralph>.",
    phases: true,
    phaseTicketProbe: true,
    // The project's environment, plus the one credential the supervisor reads
    // by name: the dedicated Buildkite READ token an iteration needs to explain
    // a red check (`bk-log.ts`). Exported only after the check proves every
    // scope on it is `read_*`, and only to the iteration — a coder's gate is
    // the frontier, which asks GitHub and never Buildkite.
    secrets: {
      manager: true,
      named: [{ name: "RALPH_BUILDKITE_READ_TOKEN", check: "bk-log.ts --check-token", targets: ["iteration"] }],
    },
    // The whole check list, as the role every one of them was written for: a
    // check added later applies to a coder without an edit here, and a coder's
    // preflight report stays byte-identical to the one that predates roles.
    // `migration-applied` is the label the operator's `migration-applied.ts`
    // (felipearos/ralph#432) puts on an issue and its PR; declared here so
    // preflight creates it (it is in `CREATED_LABELS`), and no operator has
    // to by hand. A literal, not
    // `APPLIED_LABEL`: that module's imports reach this one, and
    // `roles.test.ts` pins the two equal.
    preflight: { checks: [...PREFLIGHT_CHECKS], verdicts: {}, labels: ["migration-applied"], requiresDifficultyLabels: false },
    invariant: null,
    hostLease: true,
    gateHolds: true,
    orchestratorSettings: null,
    // `start.sh`'s long-standing default, unchanged: the number every
    // operator's muscle memory and every doc line already carries.
    pollSeconds: 300,
  },
  triager: {
    role: "triager",
    summary: "reads untriaged issues and makes them ready for a coder, or says why not",
    // No `executor`: a triager delegates no code. No `review.standards`: it
    // reviews no diff against the repo's standards. What is left is the session
    // itself, the mapper it reads a ticket's code with, and the spec axis —
    // which for this role is the question it exists to answer.
    stages: ["orchestrator", "mapper", "review.spec"],
    // The frontier gate plus the Jira handoff of to-person reports (#397): the
    // intake gate is the one place a gate secret like the Jira token reaches,
    // and the frontier gate itself stays read-only for every coder.
    intakeGate: "triage/gate.ts",
    frontierBucket: "triage",
    javRouted: false,
    prompt: "prompts/triager.md",
    fragmentSection: "TRIAGER",
    // No pull request, no local gate, no phases: the three hand-backs are all
    // endings a triager cannot honestly reach.
    sigils: ["DONE", "ALL_BLOCKED", "RETRY_LATER", "NEEDS_TRIAGE"],
    recoveryPrompt: "Your previous Ralph turn ended without a control sigil while work was pending. This is the only recovery turn. Inspect what you have already written to the tracker. Do not start background work or promise a future turn. Finish the triage you can finish now, or say on the issue what is missing and leave it. You open no pull requests, run no local gates, and work in one pass rather than in phases, so there is nothing to hand a wait back for; the worktree must be left clean and detached at the base branch. If the work is blocked only on something outside the tracker that time or an operator will clear, say so on the issue and end with <ralph>RETRY_LATER</ralph>; the supervisor backs off and re-checks. Otherwise end with exactly one valid Ralph sigil on its own final line: <ralph>DONE</ralph>, <ralph>ALL_BLOCKED</ralph>, or <ralph>NEEDS_TRIAGE</ralph>.",
    phases: false,
    phaseTicketProbe: false,
    // No application environment. One named secret, for the GATE alone: the
    // Jira credential the intake gate moves a to-person report with when
    // `triage.jira` is live (#397), so no model session that reads issue text
    // ever holds a token that writes Jira. A triager with no live `triage.jira`
    // runs without it — the supervisor only warns on a missing named secret,
    // and `clerk-credentials` asks nothing of it.
    secrets: {
      manager: false,
      named: [{ name: "RALPH_CLERK_JIRA_TOKEN", check: "clerk/jira.ts --check-token", targets: ["gate"] }],
    },
    // Three drops, each a prerequisite this role never reaches: it delegates no
    // code, so the executor's sandbox is nothing to it; it reads no CI logs; and
    // it is given no application environment at all (`secrets.manager` above),
    // so a Doppler scope it can never be handed would refuse every start for a
    // credential it cannot use.
    //
    // Its labels ARE required. A triager's product is a label, and one that does
    // not exist in the repository makes `gh issue edit` fail on an issue the
    // triager then reports as triaged — the same expensive silence a missing
    // `-wip` is. `javLabels` because the difficulty labels a triager applies are
    // configured per project, and they are what every coder's intake is routed by.
    preflight: {
      checks: without("executor-tools", "buildkite-logs", "doppler-scope"),
      verdicts: {},
      labels: [...TRIAGE_LABELS],
      requiresDifficultyLabels: true,
    },
    invariant: "clean-detached",
    hostLease: false,
    gateHolds: true,
    orchestratorSettings: null,
    // Twice the coder's. Its bucket answers "what has nobody looked at",
    // and nothing but a human filing an issue or a coder finishing one can
    // change that answer, so half the polls read the same backlog twice.
    pollSeconds: 600,
  },
  "ci-doctor": {
    role: "ci-doctor",
    summary: "watches the base branch's CI and diagnoses, retries or fixes what breaks it",
    // The coder's six: a doctor delegates a fix and reviews the diff exactly
    // as a coder does, because the ticket it opens is a coder's ticket.
    stages: [...CODER_STAGES],
    // Named before it exists: the gate itself ships with the ci-doctor's own
    // ticket, and nothing checks the file until the role preflight lands, so a
    // roster that names a ci-doctor today starts a loop that dies on its first
    // poll. Declaring it here is what lets that gate be written against a
    // supervisor that already runs it.
    intakeGate: "ci-doctor/gate.ts",
    frontierBucket: null,
    javRouted: false,
    prompt: "prompts/ci-doctor.md",
    fragmentSection: "CI_DOCTOR",
    // The coder's set minus COMPLETE: a doctor watches a branch that is never
    // "drained", so the one ending that retires a loop is not available to it.
    sigils: ["DONE", "ALL_BLOCKED", "NEEDS_TRIAGE", "RETRY_LATER", "AWAIT_PR", "AWAIT_HOST", "PHASE"],
    recoveryPrompt: "Your previous Ralph turn ended without a control sigil while work was pending. This is the only recovery turn. Inspect the current worktree state. Do not start background work or promise a future turn. Finish anything that can be finished now, or journal and hand off the remaining work. If a pushed PR is only waiting on CI or the merge queue, end with <ralph>AWAIT_PR <pr> ci</ralph> or <ralph>AWAIT_PR <pr> merge</ralph> and the supervisor waits for it. If you had just finished a phase and written its handoff note, end with <ralph>PHASE <next> <n></ralph> and the supervisor resumes this session. If the work is blocked only on something outside the repository that time or an operator will clear (a CI or deploy provider outage, blocked deployments), journal it and end with <ralph>RETRY_LATER</ralph>; the supervisor backs off and re-checks. Otherwise end with exactly one valid Ralph sigil on its own final line: <ralph>DONE</ralph>, <ralph>ALL_BLOCKED</ralph>, or <ralph>NEEDS_TRIAGE</ralph>.",
    // On, and the coder's five: a doctor that fixes a regression opens a pull
    // request exactly as a coder does, and its diagnosis is that ticket's
    // `select`.
    phases: true,
    // Off: its number is a case issue, and the coder-shaped wrap-up knows
    // nothing of the case store a closed case would have to leave.
    phaseTicketProbe: false,
    secrets: {
      manager: true,
      named: [
        // Its gate reads Buildkite to find the case at all, and the iteration
        // reads the same logs to explain it, so the read token goes to both.
        { name: "RALPH_BUILDKITE_READ_TOKEN", check: "bk-log.ts --check-token", targets: ["iteration", "gate"] },
        // The retry token can rebuild a job, which is a write: the gate acts
        // with it and the model session never sees it. Its check accepts only a
        // token whose scope list is EXACTLY `write_builds` — not a superset, so
        // the read token's own powers cannot arrive on it (#161).
        { name: "RALPH_BUILDKITE_RETRY_TOKEN", check: "bk-log.ts --check-retry-token", targets: ["gate"] },
      ],
    },
    // `frontier-prerequisites` drops out because this role takes no work off the
    // frontier at all (`frontierBucket` is null above), and `buildkite-logs`
    // becomes a denial: a doctor that cannot read the build has no case to work,
    // where a coder merely explains a red check worse. Its own checks — the one
    // that proves the RETRY token is narrow — arrive with the ci-doctor's
    // preflight ticket; this field is what makes them expressible without
    // touching `preflight.ts`'s pass again.
    //
    // The denial is only as reachable as the check: `checkBuildkiteLogs` returns
    // nothing at all for a project whose required checks name no Buildkite one,
    // and a doctor there has no build to read in the first place.
    //
    // `ci-health` marks the issue a case is filed against, and `priority:urgent`
    // is the frontier's priority lane for a broken base branch
    // (`frontier/next-tasks.ts`); no other role's work involves either. These
    // are labels the project must HAVE, not labels this role writes — the
    // doctor's own filings carry `ci-health`/`ready-for-agent`/`bug`
    // (`ci-doctor/case-issue.ts`), on top of which `ci-doctor/revert.ts`
    // writes and later removes `priority:urgent` for a regression it did not
    // revert — the one role that touches that label.
    preflight: {
      checks: without("frontier-prerequisites"),
      verdicts: { "buildkite-logs": "denied" },
      labels: ["ci-health", "priority:urgent"],
      requiresDifficultyLabels: false,
    },
    invariant: null,
    hostLease: true,
    gateHolds: false,
    orchestratorSettings: null,
    // The coder's, and for the opposite reason: its case is a red build on the
    // base branch, which is at its most expensive the minute after it lands.
    pollSeconds: 300,
  },
  "pr-medic": {
    role: "pr-medic",
    summary: "takes a red run on one of the operator's pull requests and gets it back to green",
    // The coder's six, and for the coder's reason: the medic fixes a branch's
    // own diff the way a coder fixes its own, so it delegates an implementation
    // and reviews what comes back against both axes.
    stages: [...CODER_STAGES],
    // Shipped with felipearos/ralph#246: it claims a red operator PR with this
    // loop's `-wip` label and hands it over as `RALPH_INTAKE_PR` and
    // `RALPH_INTAKE_REASON`, which `ralph.sh` reads off its verdict line.
    intakeGate: "pr-medic/gate.ts",
    // Its case is a pull request, not an issue, so there is no bucket of the
    // backlog for it to be handed: the gate asks GitHub for red operator PRs
    // directly.
    frontierBucket: null,
    javRouted: false,
    prompt: "prompts/pr-medic.md",
    fragmentSection: "PR_MEDIC",
    // The ci-doctor's set, for the same reason: a medic watches the operator's
    // open pull requests, which are never "drained", so COMPLETE — the one
    // ending that retires a loop — is not an ending it can honestly reach.
    sigils: ["DONE", "ALL_BLOCKED", "NEEDS_TRIAGE", "RETRY_LATER", "AWAIT_PR", "AWAIT_HOST", "PHASE"],
    recoveryPrompt:
      "Your previous Ralph turn ended without a control sigil while work was pending. This is the only recovery turn. Inspect the current worktree state. Do not start background work or promise a future turn. You are working on the operator's pull request: push to it only through pr-medic/push.ts, never merge or enqueue it, and never touch it if it is a draft. Finish anything that can be finished now, or comment on the pull request and hand off what is left. If the pull request you pushed to is only waiting on CI, end with <ralph>AWAIT_PR <pr> ci</ralph> and the supervisor waits for it. If you had just finished a phase and written its handoff note, end with <ralph>PHASE <next> <n></ralph> and the supervisor resumes this session. If the work is blocked only on something outside the repository that time or an operator will clear (a CI or deploy provider outage, blocked deployments), say so on the pull request and end with <ralph>RETRY_LATER</ralph>; the supervisor backs off and re-checks. Otherwise end with exactly one valid Ralph sigil on its own final line: <ralph>DONE</ralph>, <ralph>ALL_BLOCKED</ralph>, or <ralph>NEEDS_TRIAGE</ralph>.",
    // On, and the coder's shape: diagnosing the red is a `select`, the rebase or
    // the fix is an `implement`, and the gates it runs before pushing to
    // somebody else's branch are a `verify` worth yielding at.
    phases: true,
    // Its phase number is the pull request's, not a tracker ticket.
    phaseTicketProbe: false,
    secrets: {
      manager: true,
      named: [
        // The same split as the ci-doctor's, and deliberately the same two
        // tokens: the gate reads Buildkite to find a red run on an operator's
        // pull request at all, and the iteration reads the same logs to explain
        // it, so READ goes to both.
        { name: "RALPH_BUILDKITE_READ_TOKEN", check: "bk-log.ts --check-token", targets: ["iteration", "gate"] },
        // Re-running a job is a write, and the medic's one re-run of a known
        // flake (felipearos/ralph#244 step 3) is the gate's to spend, not the
        // model session's.
        //
        // The re-run shares the doctor's daily cap rather than having one of
        // its own: the gate spends it through `ci-doctor/retry.ts`'s
        // `retryHead`, which counts in the same `retries.count` of the same
        // ci-health store under the same lock as the doctor's `retryOnce`, so
        // the two roles get six a day between them (felipearos/ralph#246). A
        // project that rosters a medic and no doctor cannot set `ciDoctor` and
        // so cannot LOWER that cap, but it cannot double it either: the
        // ceiling is the harness's `RETRY_CEILINGS`.
        { name: "RALPH_BUILDKITE_RETRY_TOKEN", check: "bk-log.ts --check-retry-token", targets: ["gate"] },
      ],
    },
    // `frontier-prerequisites` drops out because this role takes nothing off the
    // frontier (`frontierBucket` is null above), and `buildkite-logs` becomes a
    // denial for the doctor's reason: a medic that cannot read the failed build
    // cannot tell the branch's own failure from a flake, which is the whole of
    // its first decision. Starting one anyway would push a guess to the
    // operator's branch.
    //
    // No extra labels. The three the ticket names — `medi-wip`, `medi-blocked`,
    // `medi-done` — are the per-loop triple every role already requires
    // (`preflight.ts`'s `requiredLabels`), not a vocabulary of this role's own;
    // the medic merely applies them to a pull request rather than to an issue,
    // which is not something preflight can check for.
    preflight: {
      checks: without("frontier-prerequisites"),
      verdicts: { "buildkite-logs": "denied" },
      labels: [],
      requiresDifficultyLabels: false,
    },
    // Null, not `clean-detached`: the medic checks out the operator's branch and
    // works in it, so a worktree left dirty between its phases is its working
    // state rather than a violation.
    invariant: null,
    hostLease: true,
    gateHolds: false,
    // The push fence's other half (felipearos/ralph#247): `pr-medic/push.ts` is
    // the only route to the operator's branch, so the session is denied the
    // raw `git push` that would go round it.
    orchestratorSettings: "pr-medic/orchestrator-settings.json",
    // The ci-doctor's, and for a related reason: a red pull request is most
    // worth greening while the operator is still in that branch. The quiet
    // period (`prMedic.quietMinutes`) is what keeps a short poll from picking a
    // branch the operator is mid-push on, so the two numbers are independent.
    pollSeconds: 300,
  },
  clerk: {
    role: "clerk",
    summary: "files the settled reports of one Slack channel on its Jira intake board, and keeps the channel's canvas in step",
    // The session only classifies: it reads a batch of reports and writes a
    // plan. It delegates no code, maps no codebase and has no diff to review,
    // so every coder stage but the session itself would be a model nobody
    // runs. `code-context` is its second session kind (felipearos/ralph#499):
    // an iteration the gate hands a filed ticket to, which reads the code
    // behind it and writes one comment. Its own model because it reads a
    // codebase rather than a batch of messages, and defaulted (Opus, high) so
    // a lineup written before it existed still resolves.
    stages: ["orchestrator", "code-context"],
    // Its case is a Slack channel, which the backlog cannot see, so it has a
    // gate of its own and no frontier bucket — the ci-doctor's shape. Named
    // `clerk`, not `intake`: "intake gate" and `RALPH_INTAKE_*` already name
    // the hand-over every role has (felipearos/ralph#315).
    intakeGate: "clerk/gate.ts",
    frontierBucket: null,
    javRouted: false,
    prompt: "prompts/clerk.md",
    fragmentSection: "CLERK",
    // A classify-and-apply pass: no pull request to hand back, no local gate
    // to wait on the host for, no phases to yield at, and no COMPLETE — a
    // channel is never drained, so the ending that retires a loop is not one
    // it can honestly reach.
    sigils: ["DONE", "ALL_BLOCKED", "NEEDS_TRIAGE", "RETRY_LATER"],
    recoveryPrompt: "Your previous Ralph turn ended without a control sigil while work was pending. This is the only recovery turn. You classify reports and write one plan file; you never write to Slack or Jira, open no pull requests, run no local gates and work in one pass rather than in phases, and the worktree must be left clean and detached at the base branch. Finish the plan you can finish now: every report in the batch gets an entry, because a batch whose plan is missing or invalid twice is filed unclassified. If the work is blocked only on something outside the repository that time or an operator will clear, end with <ralph>RETRY_LATER</ralph>; the supervisor backs off and re-checks. Otherwise end with exactly one valid Ralph sigil on its own final line: <ralph>DONE</ralph>, <ralph>ALL_BLOCKED</ralph>, or <ralph>NEEDS_TRIAGE</ralph>.",
    phases: false,
    phaseTicketProbe: false,
    // No application environment: the clerk touches no application code and
    // runs no gate, so there is nothing for the project's secrets manager to
    // inject. Its own credentials are named secrets, and both go to the GATE
    // alone: the gate reads Slack and Jira and makes every write, and the
    // session only classifies what the gate stored for it. A model turn that
    // reads untrusted Slack text all day is never handed a token that could
    // write anywhere — so a message carrying instructions can at worst produce
    // a wrong classification, which the plan validator then bounds.
    secrets: {
      manager: false,
      named: [
        // The Slack bot token (`xoxb-…`), proved by `auth.test` and its granted
        // scopes before the supervisor hands it over (felipearos/ralph#317).
        { name: "RALPH_CLERK_SLACK_TOKEN", check: "clerk/slack.ts --check-token", targets: ["gate"] },
        // The Jira credential, `<email>:<API token>`, proved by reading the
        // configured project (felipearos/ralph#318). The gate reads candidates
        // with it and, live, files with it.
        { name: "RALPH_CLERK_JIRA_TOKEN", check: "clerk/jira.ts --check-token", targets: ["gate"] },
      ],
    },
    // Only `frontier-prerequisites` drops, as the spec decides: it takes
    // nothing off the frontier, and a harness checkout missing the coder's
    // gate is no reason to refuse a loop that never runs it. Everything else
    // still applies — its claim labels exist on the intake repository like
    // every loop's — and no difficulty labels, because it routes nothing.
    preflight: {
      checks: without("frontier-prerequisites"),
      verdicts: {},
      labels: [],
      requiresDifficultyLabels: false,
    },
    // It writes nothing to the repository: Slack and Jira are written by code
    // outside the session, and the plan lives under `.ralph/logs/`.
    invariant: "clean-detached",
    hostLease: false,
    gateHolds: false,
    // Its own rails (felipearos/ralph#318): the harness's, plus no web tools,
    // no `curl` and no `wget`. The session needs no network — everything it
    // classifies is in the batch the gate stored — so a Slack message asking
    // it to fetch or post something has no habit to ride on.
    orchestratorSettings: "clerk/orchestrator-settings.json",
    // The spec's poll: five minutes, which is also the scale of its settle
    // window. A report is not filed until it has been quiet for ten minutes,
    // so polling faster would only re-read a channel nothing can be taken from.
    pollSeconds: 300,
  },
  verifier: {
    role: "verifier",
    summary: "follows merged pull requests into production and verifies them against their tickets",
    // The session only checks: it follows one merged change into production
    // and judges it against its ticket. It delegates no code, maps no codebase
    // and has no diff to review, so every stage but the session itself would
    // be a model nobody runs.
    stages: ["orchestrator"],
    // Its case is a merged pull request on its way to production, which the
    // backlog's ready bucket cannot see, so it has a gate of its own and no
    // frontier bucket — the ci-doctor's and the clerk's shape
    // (felipearos/ralph#560).
    intakeGate: "verifier/gate.ts",
    frontierBucket: null,
    javRouted: false,
    prompt: "prompts/verifier.md",
    fragmentSection: "VERIFIER",
    // One check-in per iteration: no pull request of its own to hand back, no
    // local gate to wait on the host for, no phases to yield at, and no
    // COMPLETE — merges never stop arriving. Act mode's reverts
    // (felipearos/ralph#568) are the gate's, not the session's: the gate opens
    // and merges the revert PR, so no session waits on one with AWAIT_PR.
    sigils: ["DONE", "ALL_BLOCKED", "NEEDS_TRIAGE", "RETRY_LATER"],
    recoveryPrompt: "Your previous Ralph turn ended without a control sigil while work was pending. This is the only recovery turn. You verify one check-in in one pass rather than in phases; you write no code, open no pull requests and run no local gates, and the worktree must be left clean and detached at the base branch. Record what you can conclude about the check-in now. If the work is blocked only on something outside the repository that time or an operator will clear, end with <ralph>RETRY_LATER</ralph>; the supervisor backs off and re-checks. Otherwise end with exactly one valid Ralph sigil on its own final line: <ralph>DONE</ralph>, <ralph>ALL_BLOCKED</ralph>, or <ralph>NEEDS_TRIAGE</ralph>.",
    phases: false,
    phaseTicketProbe: false,
    // No application environment: the verifier touches no application code
    // and runs no gate, so there is nothing for the project's secrets manager
    // to inject. Its production credentials are named secrets, `gate`-only:
    // the gate reads deploys and Sentry, and a model turn reading production
    // pages is never handed a token. A `github-deployments` source reads
    // through gh's own credential, so the Vercel token is asked only of a
    // `vercel` source (`checkVerifierCredentials` in `preflight.ts`).
    secrets: {
      manager: false,
      named: [
        { name: "RALPH_VERIFIER_SENTRY_TOKEN", check: "verifier/credentials.ts --check-token sentry", targets: ["gate"] },
        { name: "RALPH_VERIFIER_VERCEL_TOKEN", check: "verifier/credentials.ts --check-token vercel", targets: ["gate"] },
      ],
    },
    // `frontier-prerequisites` drops because it takes nothing off the
    // frontier, and a harness checkout missing the coder's gate is no reason to
    // refuse a loop that never runs it. `buildkite-logs` drops too, as the
    // triager's does: it never reads why a CI check is red, so a missing read
    // token would warn on every start of a loggd verifier over nothing it
    // needs, and train the operator to skip warnings. Its verdict labels are the spec's loop-labels
    // requirement (felipearos/ralph#560): a ticket it follows is marked with
    // one of them, so a project missing any of them would fail the first
    // verdict it writes. They are in `CREATED_LABELS`, so preflight makes them
    // on a GitHub tracker. No difficulty labels, because it routes nothing.
    preflight: {
      checks: without("frontier-prerequisites", "buildkite-logs"),
      verdicts: {},
      labels: ["following", "verified", "unexercised", "inconclusive", "needs-human"],
      requiresDifficultyLabels: false,
    },
    // It writes nothing to the repository: what it concludes goes on the
    // ticket and in the journal under `.ralph/logs/`.
    invariant: "clean-detached",
    hostLease: false,
    gateHolds: false,
    // It checks production as the test account (felipearos/ralph#566), so
    // its rails deny every database client and hand-made requests, and it
    // writes no code in any mode: act mode's revert is the gate's (#568).
    orchestratorSettings: "verifier/orchestrator-settings.json",
    // Five minutes: a deploy takes minutes to reach production, so polling
    // faster would only re-read a change that cannot have landed yet.
    pollSeconds: 300,
  },
  sentinel: {
    role: "sentinel",
    summary: "watches the error reporter and drafts diagnosed tickets for new or regressed production errors",
    // The session only diagnoses: it reads one production error the gate
    // stored and drafts a ticket for it. It delegates no code, maps no
    // codebase and has no diff to review, so every stage but the session
    // itself would be a model nobody runs.
    stages: ["orchestrator"],
    // Its case is a reporter issue, which the backlog's ready bucket cannot
    // see, so it has a gate of its own and no frontier bucket — the
    // verifier's shape (felipearos/ralph#681, spec #678).
    intakeGate: "sentinel/gate.ts",
    frontierBucket: null,
    javRouted: false,
    prompt: "prompts/sentinel.md",
    fragmentSection: "SENTINEL",
    // One reporter issue per iteration: no pull request of its own to hand
    // back, no local gate to wait on the host for, no phases to yield at, and
    // no COMPLETE — production errors never stop arriving. Filing the draft is
    // the gate's, not the session's, so no session waits on anything.
    sigils: ["DONE", "ALL_BLOCKED", "NEEDS_TRIAGE", "RETRY_LATER"],
    recoveryPrompt: "Your previous Ralph turn ended without a control sigil while work was pending. This is the only recovery turn. You draft one reporter issue's ticket in one pass rather than in phases, with `sentinel/issue.ts draft`; you write no code, write nothing to the tracker and run no local gates, and the worktree must be left clean and detached at the base branch. Record the draft you can make for the issue now. If the work is blocked only on something outside the repository that time or an operator will clear, end with <ralph>RETRY_LATER</ralph>; the supervisor backs off and re-checks. Otherwise end with exactly one valid Ralph sigil on its own final line: <ralph>DONE</ralph>, <ralph>ALL_BLOCKED</ralph>, or <ralph>NEEDS_TRIAGE</ralph>.",
    phases: false,
    phaseTicketProbe: false,
    // No application environment: the sentinel touches no application code
    // and runs no gate, so there is nothing for the project's secrets manager
    // to inject. Its reporter token is a named secret, `gate`-only: the gate
    // reads Sentry and stores the evidence, and a model turn reading
    // production stack frames is never handed a token.
    secrets: {
      manager: false,
      named: [{ name: "RALPH_SENTINEL_SENTRY_TOKEN", check: "sentinel/credentials.ts --check-token sentry", targets: ["gate"] }],
    },
    // The verifier's checks, for the verifier's reasons: it takes nothing off
    // the frontier and never reads why a CI check is red. Its tickets carry
    // `ready-for-human`, so a project missing it would fail the first ticket
    // filed; it is in `CREATED_LABELS`, so preflight makes it on a GitHub
    // tracker. No difficulty labels, because it routes nothing.
    preflight: {
      checks: without("frontier-prerequisites", "buildkite-logs"),
      verdicts: {},
      labels: ["ready-for-human"],
      requiresDifficultyLabels: false,
    },
    // It writes nothing to the repository: its drafts go under `.ralph/logs/`.
    invariant: "clean-detached",
    hostLease: false,
    gateHolds: false,
    // Its own rails: the harness's, plus no edits, no tracker writes and no
    // network — production errors are data, and the reporter token is the
    // gate's alone, so the session has nothing to fetch.
    orchestratorSettings: "sentinel/orchestrator-settings.json",
    // Five minutes: a new error needs a few events before it is worth a
    // ticket, so polling faster would only re-read issues still settling.
    pollSeconds: 300,
  },
};

export const isRole = (value: unknown): value is Role => typeof value === "string" && (ROLES as readonly string[]).includes(value);

/** The descriptor for `role`. */
export const roleDescriptor = (role: Role): RoleDescriptor => ROLE_DESCRIPTORS[role];

/** The stages a loop in `role` resolves, in `STAGES` order. */
export const stagesFor = (role: Role): readonly Stage[] => ROLE_DESCRIPTORS[role].stages;

/**
 * Whether a loop in `role` has a pull request of its own to shepherd, and so
 * whether its intake gate should ask about one at all.
 *
 * A role that opened pull requests and left every one to a human — never
 * handing a wait back — would be read as shepherding nothing and its green
 * pull request would go unread. No role does that today, and the one that
 * wanted to should declare the fact rather than widen this.
 *
 * Derived from the sigils rather than declared, because `AWAIT_PR` IS the
 * question: a role that may hand a pull request's CI or merge wait back to the
 * supervisor is a role that opens pull requests, and one that may not never
 * has one to find. A second field saying the same thing could only drift, and
 * the drift would be silent — a gate that spends a `gh pr list` on every poll
 * for a role whose PRs cannot exist, or worse, one that skips the probe for a
 * role whose PR is sitting there green.
 */
export const shepherds = (role: Role): boolean => ROLE_DESCRIPTORS[role].sigils.includes("AWAIT_PR");

/**
 * Whether a loop in `role` must leave the checkout clean and detached.
 *
 * Named beside `shepherds` because the same question is asked in two places
 * with opposite consequences — `ralph.sh`'s `role_invariant` repairs the
 * violation, `frontier-gate.ts` refuses to read it as work — and a bare
 * `invariant === "clean-detached"` in each is the fact spelled twice.
 */
export const readOnlyCheckout = (role: Role): boolean => ROLE_DESCRIPTORS[role].invariant === "clean-detached";

/**
 * The role whose guidance fragment section `name` is.
 *
 * A section belongs to a role when it is that role's prefix or starts with it
 * and an underscore: `TRIAGER` and `TRIAGER_VERIFY` are the triager's,
 * `TRIAGERS` is not. Everything else is the coder's, the default section
 * (`''`) included.
 */
export const sectionRole = (name: string): Role =>
  ROLES.find((role) => {
    const prefix = ROLE_DESCRIPTORS[role].fragmentSection;
    return prefix !== "" && (name === prefix || name.startsWith(`${prefix}_`));
  }) ?? DEFAULT_ROLE;
