#!/usr/bin/env bun
/**
 * The project seam: everything the harness needs to know about the project it
 * is working on, read from `<project>/.ralph/config.json`.
 *
 * The harness is shared — one checkout drives any number of project
 * worktrees — so nothing project-specific may live in it: not the repository,
 * not the account that owns claims, not which secrets manager injects the
 * environment or which of its secrets are withheld, not the gates. The project
 * commits this file and the harness reads it.
 *
 * Validation is strict and total. An unknown key is refused rather than
 * ignored (a misspelt `withold` would otherwise silently withhold nothing), and
 * every problem is collected so one run reports all of them.
 *
 * Usage:
 *   bun project-config.ts --json      the validated config as JSON
 *   bun project-config.ts --export    eval-able `export` lines for ralph.sh
 *   bun project-config.ts --role-of <loop>      the loop's role (`roles.ts`)
 *   bun project-config.ts --intake-gate-of <loop>
 *                                               the intake gate command its
 *                                               role declares, under $RALPH_HOME
 *   bun project-config.ts --poll-seconds-of [loop]
 *                                               how long that role's gate waits
 *                                               between polls by default; with
 *                                               no loop, the roster's first,
 *                                               as `ralph.sh` itself defaults
 *   bun project-config.ts --add-loop <name> [--role <role>]
 *                                               the config file with <name>
 *                                               appended to `loops`
 *   bun project-config.ts --remove-loop <name>  the config file without it
 *   bun project-config.ts --set-verifier        the config file with the
 *                                               `verifier` rules replaced by
 *                                               the JSON object on stdin
 *   bun project-config.ts --set-sentinel        the config file with the
 *                                               `sentinel` rules replaced by
 *                                               the JSON object on stdin
 *   bun project-config.ts --set-project         the config file with
 *                                               `displayName`,
 *                                               `baseBranch`, `gates`,
 *                                               `requiredChecks`,
 *                                               `refuseFiles` and/or
 *                                               `worktreeSetup` set from the
 *                                               JSON object on stdin
 *
 * `--json`, `--add-loop`, `--remove-loop`, `--set-verifier`, `--set-sentinel` and `--set-project` take
 * `--at <ref>` to read the config committed at a git ref (`git show <ref>:.ralph/config.json`) instead
 * of the working tree's: the roster the base branch holds, which is what a
 * roster PR edits and what a new loop waits to appear in. A roster edit prints
 * the whole file, validated by the same rules as a read, ready to commit.
 *
 * A `loops` entry is a loop name (a coder) or `{ "name", "role" }`. The
 * validated config reads both the same way: `loops` is every name, whatever
 * its role, and `roster` pairs each with its role — so `--json` reports a
 * string entry as `role: "coder"`, and every reader that wants names (the
 * claim fences, the dashboard) keeps reading `loops`.
 *
 * The project is `RALPH_PROJECT`, else the git toplevel of the cwd.
 * Exit 1 means the config is missing or invalid; the reason is on stderr.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, join, normalize } from "node:path";

import type { IssueType } from "./clerk/plan";
import { CONFIG_RELATIVE_PATH, projectRoot } from "./paths";
import { currentProjectId } from "./project-id";
import { DEFAULT_ROLE, ROLES, isRole, roleDescriptor, type Role } from "./roles";
import type { AppLabels } from "./triage/intake";

export interface ProjectConfig {
  /** `owner/name` on GitHub. */
  repo: string;
  /** The login claims are assigned to. */
  owner: string;
  /** The branch every base read and freshness check is against. */
  baseBranch: string;
  /** Human name, used in journal commit subjects and headings. */
  displayName: string;
  secrets: SecretsConfig;
  /** Files whose presence refuses startup (they would shadow the injected env). */
  refuseFiles: string[];
  /** argv run inside the project, under the injected env, before every child. Empty: no check. */
  envCheck: string[];
  /** Check names that must be green before a PR merges. */
  requiredChecks: string[];
  /**
   * Who merges a loop's pull request. `loop` (the default): the iteration
   * merges or enqueues it once it is green. `human`: it never does — a green,
   * conflict-free PR with no open thread is handed to a person (`tracker.ts
   * handoff`), and the orchestrator is denied `gh pr merge`. For a team that
   * reviews everything a loop writes before it lands, even on an integration
   * branch of the loop's own (a client app's PR, 2026-10-26).
   */
  merge: "loop" | "human";
  /**
   * How a loop's pull request merges, when the loop merges it (#51).
   * `mergify`: a `@mergifyio queue` comment enqueues it and Mergify's `queued`
   * label says it is in the queue. `github-queue`: GitHub's native merge queue,
   * entered with `gh pr merge` and read from the PR's `isInMergeQueue`.
   * `direct`: no queue; the loop runs `gh pr merge --squash` once the required
   * checks are green. Absent: today's behaviour, the enqueue command in the
   * project's prompt fragment and the wait reading Mergify's labels, so a
   * project that has not opted in runs unchanged.
   */
  mergeMethod?: MergeMethod;
  /**
   * How the dashboard saves a sentinel or verifier rules edit (#787).
   * `commit` (the default, read as absent): the validated config is committed
   * straight onto the base branch as a fast-forward, falling back to a config
   * PR when the push is refused. `pr`: always a config PR, for a project that
   * reviews every config change. Roster and Settings edits are PRs either way.
   */
  configChanges?: "commit" | "pr";
  /**
   * Whether this project's eval trials' patches may leave the host (#825).
   * A trial's patch is the project's code, so off (the default, read as
   * absent) keeps it on this host: the local dashboard shows it, the remote
   * one does not. On lets the bridge push the patches, scrubbed, to the
   * hosted store so the remote dashboard can show them too.
   */
  relayEvalPatches?: boolean;
  /**
   * The Slack intake's two app labels: the backoffice and pwa repos' labels on
   * the tracker. Required with a `clerk`, and for a triager on a Linear or Jira
   * tracker (`preflight.ts` `requiredLabelsFor`): the rules that send a report
   * to a person read them, and a harness default would be one team's names.
   */
  appLabels?: AppLabels;
  /**
   * Overrides of the eval test set suggestion ranker's weights (#858), each a
   * number >= 0; a key left out keeps the ranker's default.
   */
  evalSuggestionWeights?: Partial<Record<EvalSuggestionWeightKey, number>>;
  /**
   * The test set's noise-floor run (#859): how many identical live arms it
   * runs (absent: 3) and the share of the floor's cases that may come and go
   * before it is stale (absent: 0.2). Filled by `noiseFloorSettings`.
   */
  evalsNoiseFloor?: { arms?: number; staleShare?: number };
  /**
   * Saturated test-set cases (#860): how many newest set runs in a row every
   * arm must pass a case in before it is flagged saturated (absent: 3). Filled
   * by `saturationSettings`.
   */
  evalsSaturation?: { runs?: number };
  /**
   * The guardrail verdict's thresholds (#871): how much more a quality
   * proposal may cost (absent: 0.15) and how far a cost proposal must cut
   * tokens (absent: 0.10). Filled by `guardrailSettings`.
   */
  evalsGuardrails?: { maxCostRise?: number; minTokenCut?: number };
  /**
   * The improver's recommended run (#873): how many cases it takes at most
   * (absent: 12) and whether it includes the source run's failed cases
   * (absent: true; the cited cases always go first). Filled by `improverSettings`.
   * `autoMerge` (#875) defaults off and is not wired to anything yet: the
   * improver only ever opens a passed proposal's PR, and a person merges it
   * whatever the switch says. Read by `improverAutoMerge`.
   */
  evalsImprover?: { size?: number; failed?: boolean; autoMerge?: boolean };
  /** Named local gate commands, e.g. `{ "test": "bun run test" }`. */
  gates: Record<string, string>;
  /** Project-relative paths. */
  promptFragment: string;
  coderFragment: string;
  plan: string;
  /**
   * `dir` is where entries go. `branch`, when set, moves this project's
   * journal AND its project learnings out of the harness repository onto that
   * branch of the project's own repository (an orphan branch the publisher
   * creates). A client project's notes then stay with the client's code rather
   * than in a harness that may be shown to other people.
   */
  journal: { dir: string; branch?: string };
  /**
   * Plugins this project turns on, by directory name under the harness's
   * `plugins/`. Optional and empty by default: the loop needs none of them.
   * `RALPH_PLUGINS` overrides it for one run.
   */
  plugins?: string[];
  /**
   * Commands the executor's guard (`executor-guard/guard.ts`) refuses on top
   * of its built-in tool knowledge: `refuse` outright, `requireTargets` unless
   * given a narrow file target. Each is a command as typed — `bun run
   * test:integration`, `bunx knip` — and matches however the executor spells
   * the same script or tool. Optional; both lists default to empty.
   */
  executorGuard?: { refuse?: string[]; requireTargets?: string[] };
  /**
   * The rules a `ci-doctor` loop works under, each optional and each defaulting
   * to the harness's own value: `fixScope` and `neverTouch` are the globs its
   * diff guard holds it to, `testTimeoutCeilingMs` and `hookTimeoutCeilingMs`
   * the bounds that guard lets it raise a timeout to, `pollSeconds` its intake
   * gate's interval, `windowHours` how far back a candidate flake counts,
   * `autoRevert` whether it may revert a main regression unasked, and `retry`
   * how many failed jobs it may re-run.
   *
   * `retry` may only be LOWERED. One rerun per candidate is what distinguishes
   * a flake from a break; a second proves nothing new and spends a CI slot, and
   * the daily cap is there so a bad night cannot spend the whole pipeline.
   *
   * Optional as a block, and refused outright unless the roster names a
   * ci-doctor: a project with no such loop that carries these rules is stating
   * a policy nothing reads, and that reads as configured when it is not.
   */
  ciDoctor?: {
    fixScope?: string[];
    neverTouch?: string[];
    pollSeconds?: number;
    windowHours?: number;
    autoRevert?: boolean;
    testTimeoutCeilingMs?: number;
    hookTimeoutCeilingMs?: number;
    retry?: { perCandidate?: number; perDay?: number };
  };
  /**
   * The rules a `pr-medic` loop works under: `branches` is the glob list that
   * says whose pull requests it may touch, `quietMinutes` how recently the head
   * commit may have been pushed before the medic leaves the branch alone, and
   * `maxPushes` how many times it may push to one pull request while it stays
   * red (`PR_MEDIC_DEFAULTS` for the last two).
   *
   * `branches` has no default and cannot have one. It is the whole of the
   * medic's blast radius — every other guardrail is downstream of "is this
   * branch mine to touch" — and a harness-side default would be the harness
   * guessing which of somebody else's branches an agent may force-push.
   *
   * Its dialect is the harness's own, stated here because a "branch glob" means
   * different things in `git branch --list`, a refspec, GitHub's branch
   * protection and Mergify: `*` matches within ONE segment, `?` one character,
   * and `**` spans segments. Nothing else. A character class, a brace list or a
   * negation is REFUSED rather than escaped to a literal, because the escaping
   * reading and every conventional matcher's reading differ on exactly the
   * question the next key asks — `[r]alph/*` is literal here and matches
   * `ralph/123-x` under fnmatch — and a pattern that means two things is the one
   * thing a blast radius may not be.
   *
   * Optional as a block only because a project with no medic has nothing to
   * say here. `branches` is required whenever the block exists AT ALL, and a
   * rostered medic makes the whole block required; a block with no medic on the
   * roster is refused the way `ciDoctor`'s is: a policy nothing reads, which
   * reads as configured when it is not.
   */
  prMedic?: {
    branches?: string[];
    quietMinutes?: number;
    maxPushes?: number;
  };
  /**
   * What a `clerk` loop reads and writes (felipearos/ralph#315): the Slack
   * channel whose reports it files, the Jira site and project it files them
   * in, the canvases it rebuilds, whether it writes at all (`mode`), and the
   * timings and sizes `CLERK_DEFAULTS` fills in when the file leaves them out.
   *
   * `channel` and `jira` have no default and cannot have one: they are where
   * the clerk reads and where it writes, and a harness-side guess would file
   * one team's reports in another team's project. A rostered clerk therefore
   * makes the block required, and a block with no clerk on the roster is
   * refused the way `prMedic`'s is.
   *
   * `mode` defaults to `shadow`, which writes nothing to Slack or Jira and
   * records what it would have written instead. Going live is a reviewed edit
   * to this file, never the absence of one.
   *
   * `mode: "quiet"` (felipearos/ralph#443) is the test bench between the two:
   * every Jira write live makes — tickets on the intake board, the
   * confirmation sweep, the comments a thread reply becomes — and no Slack
   * write the team can see: no thread reply, no channel canvas, and the KPI
   * report goes to `operator` alone, as in shadow. The canvas is rebuilt from
   * the real board into `shadowCanvas`, or not at all without one.
   *
   * `holdOaMove` keeps test tickets off the team's board, in live or quiet: a
   * ticket confirmed for a person is held on the intake board, labelled
   * `para-mover-a-oa`, rather than created on `jira.project`. It defaults to
   * true in quiet and false in live, so a second, live clerk on a private
   * test channel can answer in Slack and file on the same intake board
   * without ever reaching OA. Shadow moves nothing, so the key is refused
   * there.
   *
   * `canvas` is the channel's canvas, rebuilt from the intake board in live mode;
   * `shadowCanvas` is the operator's private test canvas, rebuilt from the
   * shadow decisions. Each is optional because a missing or deleted canvas is
   * created and its new id logged — but shadow never writes `canvas`.
   *
   * `operator` is the Slack user id of the person running the clerk: a canvas
   * the clerk has to create is the bot's alone until it is shared, and it is
   * shared with them.
   *
   * `dashboardUrl` is the hosted intake page that lists every intake ticket
   * (felipearos/ralph#459): the canvas holds only its newest `rowCap` rows, so
   * it links there on a `Ver todo el backlog` line. Absent, the line is left
   * out.
   *
   * `jira.intakeProject` names the intake board (felipearos/ralph#443): the
   * Jira project a report is filed on to wait for a person's confirmation,
   * and the only place the clerk files, dedupes against and draws its canvas
   * from: there is no Linear path (felipearos/ralph#466). It is required in
   * live mode; a shadow clerk without it files nothing anywhere and offers
   * its batches no duplicate candidates. `jira.project` is the person board a
   * confirmed `para-persona` ticket moves to. `jira.storyPointsField` is the
   * custom field the suggested story points are written to; absent, they go
   * into the description. `jira.statuses` names the board's workflow statuses,
   * `CLERK_JIRA_DEFAULTS` filling the ones the file leaves out.
   * `jira.mergedStatus` is the intake board status a worked ticket moves to
   * once a merged PR in `prRepos` names it (`clerk/merged.ts`); absent, no
   * ticket is moved on a merge. `jira.parent` is the `project` ticket, such
   * as an epic, that every ticket moved there is filed under; absent, they
   * are filed at the top level. `jira.readyStatuses` are the `project`
   * board's statuses that mean the work is delivered, before Done (such as
   * "LISTO PARA QA"): a moved report's "resuelto" reply goes out when its
   * ticket reaches one (`clerk/outcomes.ts`); absent, only Done tells it.
   *
   * `kpiReport` is the daily intake KPI DM (felipearos/ralph#453), absent
   * meaning none is sent. `mode: "draft"` (the default) DMs `operator` alone;
   * `"send"` DMs `recipients`, Slack user ids, but only once the clerk is
   * live: shadow never reaches them. `channels` are Slack channel ids
   * (`C…`/`G…`) the same report is posted in, exactly when the recipients'
   * DMs go out. There is no team list: the team is the channel's members,
   * less `exclude`, Slack user ids the report never names.
   *
   * `ignoreUsers` are Slack user ids whose messages are never reports: the
   * team members who work the tickets and talk in the channel. Their
   * top-level messages are not filed, classified or counted, their replies
   * are not part of a reporter's report, and they get no "Recibido" reply.
   * A reply of theirs on a report already filed is still copied to its
   * ticket: only report detection skips them.
   *
   * `prRepos` are the app repos (`owner/name`) whose pull requests the intake
   * page links as a ticket's last stage, when one names the ticket's key,
   * and lists in its sidebar. Absent or empty, none are read.
   *
   * `pwaAgents` says whether an agent project works the pwa repo. Default
   * false, which is the case today: a pwa report then goes to a person
   * whatever the plan says. The validator and the prompt read the same key,
   * so the session is never told an app has agents the validator denies.
   */
  clerk?: {
    mode?: ClerkMode;
    pwaAgents?: boolean;
    /** Live or quiet: hold a confirmed to-person ticket on the intake board instead of creating it on `jira.project`. Default true in quiet, false in live. */
    holdOaMove?: boolean;
    channel?: string;
    canvas?: string;
    shadowCanvas?: string;
    operator?: string;
    dashboardUrl?: string;
    ignoreUsers?: string[];
    prRepos?: string[];
    jira?: {
      site?: string;
      project?: string;
      intakeProject?: string;
      storyPointsField?: string;
      statuses?: Partial<Record<ClerkStatus, string>>;
      mergedStatus?: string;
      parent?: string;
      readyStatuses?: string[];
    };
    settleMinutes?: number;
    joinMinutes?: number;
    canvasMinutes?: number;
    batchSize?: number;
    regressionDays?: number;
    rowCap?: number;
    attachmentMaxMb?: number;
    kpiReport?: Partial<KpiReportRules>;
    /**
     * Code context (felipearos/ralph#499): the local clone and ref of each app
     * whose filed tickets get a "Contexto de código" comment. Read leniently
     * (`clerkCodeContext`): absent or malformed, the feature is off and
     * nothing else changes, so the type says nothing about its shape.
     */
    codeContext?: unknown;
  };
  /**
   * How a `triager` loop settles what it triages (felipearos/ralph#396).
   *
   * `autoReady` (default false) makes a `propose` outcome add `ready-for-agent`
   * instead of `agent-proposed`, dropping the operator's approval step. Off by
   * default because a report the model judged agent-ready is still a guess,
   * and turning the approval off is a reviewed edit to this file, never the
   * absence of one.
   *
   * `jira` turns on the `to-person` path (felipearos/ralph#397): a report
   * meant for a person moves to the Jira project `jiraProject` on `jiraSite`.
   * Absent, a to-person outcome only records its reason, as before. `shadow`
   * writes the would-be Jira ticket as a Linear comment and holds no Jira
   * writer, so a week of shadow can be read before anything lands in the
   * team's Jira; `live` creates it. The credential, `RALPH_CLERK_JIRA_TOKEN`,
   * is only checked by the supervisor's gate, never read by the model.
   * `issueTypes` maps the report's type as clara writes it to the Jira issue
   * type name; a type it omits keeps its own name.
   */
  triage?: {
    autoReady?: boolean;
    jira?: TriageJiraMode;
    jiraSite?: string;
    jiraProject?: string;
    issueTypes?: Partial<Record<IssueType, string>>;
  };
  /**
   * What a `verifier` loop verifies after a merge (felipearos/ralph#560): the
   * production it watches, where it learns a deploy landed, the Sentry project
   * it reads, and the window, check-ins and revert thresholds
   * `VERIFIER_DEFAULTS` fills in when the file leaves them out.
   *
   * `productionUrl`, `deploy` and `sentry` have no default and cannot have
   * one: a guess would verify the wrong product. A rostered verifier therefore
   * makes the block required, and a block with no verifier on the roster is
   * refused the way `clerk`'s is.
   *
   * `mode` defaults to `observe`, which only records verdicts, so a verifier
   * that reports or acts is always a reviewed edit to this file.
   *
   * `enabled` (#789) defaults to `true`; `false` switches the verifier off
   * without taking it off the roster: its gate keeps polling and re-reading
   * the rules, and does nothing else until they say `true` again.
   */
  verifier?: {
    enabled?: boolean;
    productionUrl?: string;
    deploy?: { source?: DeploySource; project?: string; team?: string; environment?: string };
    sentry?: { org?: string; project?: string };
    windowHours?: number;
    checkIns?: number[];
    trafficFloor?: boolean;
    revert?: { rateFactor?: number; minEvents?: number; minUsers?: number };
    follow?: { loopPrs?: boolean; humanPrs?: boolean };
    mode?: VerifierMode;
    /**
     * The language the verifier's tracker comments and tickets are written
     * in. Hand-edited like `productionUrl`, not a rule: defaults to
     * `screenshots.locale`, else English.
     */
    language?: "en" | "es";
    /**
     * The `gh` arguments that merge or enqueue a PR on this project, `{pr}`
     * standing for its number (#568): how act mode merges its revert PR
     * through the project's own gates. Hand-edited, never a dashboard rule:
     * it is a command the gate runs.
     */
    mergeCommand?: string[];
  };
  /**
   * What a `sentinel` loop watches in production (felipearos/ralph#681, spec
   * #678): the error reporter it reads, how far back it looks, the bar an
   * issue must clear before it is worth a ticket, and how many tickets a day
   * it may file. `SENTINEL_DEFAULTS` fills in the rules the file leaves out.
   *
   * `reporter.org` and `reporter.project` have no default and cannot have one:
   * a guess would read the wrong project's errors. A rostered sentinel
   * therefore makes the block required, and a block with no sentinel on the
   * roster is refused the way `verifier`'s is.
   *
   * `mode` defaults to `observe`, which only records what it would file, so a
   * sentinel that files tickets is always a reviewed edit to this file.
   *
   * `enabled` (#789) defaults to `true`; `false` switches the sentinel off,
   * as the verifier's does.
   */
  sentinel?: {
    enabled?: boolean;
    reporter?: { kind?: SentinelReporterKind; org?: string; project?: string; environment?: string };
    lookbackHours?: number;
    minEvents?: number;
    minUsers?: number;
    maxPerDay?: number;
    mode?: SentinelMode;
    /**
     * The language the sentinel's tickets are written in. Defaults to
     * `screenshots.locale`, else English, as the verifier's does.
     */
    language?: "en" | "es";
  };
  /**
   * The loops that work this project, by name and whatever their role: the
   * roster its `loop-name` files, claim labels and lineup/Jav blocks are
   * checked against. The file may spell an entry as an object
   * (`LoopEntry`); validated, every entry here is its name.
   */
  loops: string[];
  /** `loops` again, each paired with its role. Derived, never written to the file. */
  roster: RosterEntry[];
  /**
   * Where this project's learnings live, as a path inside the HARNESS
   * repository — the one place every loop on the machine can read and write
   * through the journal lock. `false` when the project opts out.
   *
   * Resolved, so a reader never has to derive it: the file may say
   * `{"file": …}` or `false` or leave the key out, and what lands here is the
   * answer. The default pairs with the journal the way `learnings/README.md`
   * says it does — `journal/loggd` with `learnings/loggd.md` — because a
   * project that already named its journal dir has said which name is its own,
   * and asking twice is a second thing to keep in step.
   */
  learnings: { file: string } | false;
  /**
   * Where this project's tickets live (felipearos/ralph#330): GitHub issues on
   * `repo`, one Linear team, or one Jira project. Resolved, like `learnings`:
   * a file without the key means GitHub, and the states default, so a reader
   * never fills either in itself. `repo` stays required whatever the tracker,
   * because pull requests, checks and the base branch are still GitHub's.
   *
   * The credential for Linear or Jira is not here and must never be: it lives
   * on the host (`tracker/credentials.ts`).
   */
  tracker: TrackerConfig;
  /**
   * Before-and-after screenshots on a pull request that changes what a screen
   * shows (`ui-shots.ts`). Optional: a project without the block takes none,
   * and its loops are told so. The login and the backend the dev server talks
   * to are not here and must never be: they live on the host
   * (`ui-shots.ts`'s credential file), like a tracker's token.
   */
  screenshots?: ScreenshotsConfig;
  /**
   * The ordered steps a new agent worktree runs right after `git worktree
   * add` — installing dependencies, copying an env file from the main
   * checkout. Optional in the file; always present here, `[]` when absent, so
   * no caller needs an undefined check.
   */
  worktreeSetup: WorktreeSetupStep[];
  /**
   * The plan usage stop (`usage-stop.ts`): at `percent` of the account's
   * `window` utilisation a loop takes no new work and drains what it holds;
   * at `hardPercent` it parks until the window resets. Optional, and absent
   * means no early stop: the account's own limit (#407) is the only one. A
   * `loops` entry may carry its own, or `null` to exempt that loop. The
   * dashboard's edits go to a host-local override, never to this file.
   */
  usageStop?: UsageStopRule;
}

/** The usage windows a plan reports and a stop may watch. */
export const USAGE_STOP_WINDOWS = ["seven_day", "five_hour"] as const;
export type UsageStopWindow = (typeof USAGE_STOP_WINDOWS)[number];
/** The window a stop watches when it does not say: the week, the one that runs out. */
export const USAGE_STOP_DEFAULT_WINDOW: UsageStopWindow = "seven_day";
/** The park threshold when a stop does not say: never below its own `percent`. */
export const USAGE_STOP_DEFAULT_HARD_PERCENT = 95;

/** A `usageStop` as the file spells it. */
export interface UsageStopRule {
  percent: number;
  window?: UsageStopWindow;
  hardPercent?: number;
}

/**
 * Every problem with one `usageStop` value at `where`. `null` is allowed only
 * on a loop entry (`nullable`), where it exempts that loop from the project's.
 */
export function usageStopProblems(value: unknown, where: string, nullable: boolean): string[] {
  if (value === null && nullable) return [];
  if (!isObject(value)) {
    return [`'${where}' must be an object with a 'percent'${nullable ? ", or null to exempt the loop" : ""}`];
  }
  const problems: string[] = [];
  for (const key of Object.keys(value)) {
    if (key !== "percent" && key !== "window" && key !== "hardPercent") problems.push(`unknown key '${where}.${key}'`);
  }
  const percentOk = (raw: unknown): raw is number => Number.isInteger(raw) && (raw as number) >= 1 && (raw as number) <= 100;
  if (!percentOk(value.percent)) problems.push(`'${where}.percent' must be a whole number from 1 to 100`);
  if ("window" in value && !USAGE_STOP_WINDOWS.includes(value.window as UsageStopWindow)) {
    problems.push(`'${where}.window' must be one of ${USAGE_STOP_WINDOWS.join(", ")}`);
  }
  if ("hardPercent" in value) {
    if (!percentOk(value.hardPercent)) problems.push(`'${where}.hardPercent' must be a whole number from 1 to 100`);
    else if (percentOk(value.percent) && value.hardPercent < value.percent) {
      problems.push(`'${where}.hardPercent' must not be below '${where}.percent'`);
    }
  }
  return problems;
}

/** One `worktreeSetup` step, with its defaults filled in. */
export type WorktreeSetupStep = {
  /** Kebab-case, unique in the list: what a failure report names. */
  name: string;
  /** One-line shell command, run in the new worktree. */
  command: string;
  /** How long the step may run. */
  timeoutSeconds: number;
  /** Whether the step installs the project's dependencies. */
  installsDependencies: boolean;
};

/**
 * The most the whole `worktreeSetup` may take, every step's limit summed. The
 * dashboard runs the steps inside the Add agent / Create checkout request,
 * and its server drops a request idle for 255 s. WHY 150 and not near 255:
 * the same Add agent request also fetches, edits the roster, runs `git
 * worktree add`, creates labels, pushes and runs `gh pr create`, each of
 * which can take minutes on a loaded host, so the setup gets 150 s and the
 * rest of the request ~100 s to answer.
 */
export const WORKTREE_SETUP_MAX_SECONDS = 150;
/** A step's limit when it does not set `timeoutSeconds`. */
export const WORKTREE_SETUP_DEFAULT_SECONDS = 120;

/** The browser size a project is used at: a store worker's phone, or an office desktop. */
export type ScreenshotViewport = "phone" | "desktop";

export interface ScreenshotsConfig {
  viewport: ScreenshotViewport;
  /**
   * The one-line command that serves the app from a checkout, with `{port}`
   * where the port goes. It runs in a throwaway worktree at the ref being
   * photographed, with the host credential file's values in its environment.
   */
  serve: string;
  /** How the browser gets a session: a Supabase password login injected into storage, or none. */
  login: "supabase" | "none";
  /**
   * Credential values that must start with the given text, checked before the
   * server starts: the fence that keeps a loop's dev server, and every write
   * it makes while it is photographed, off a production backend even if the
   * host file is swapped for the wrong one.
   */
  requireEnv: Record<string, string>;
  /** Button names clicked, when one is showing, before each shot: a welcome tour that covers the page. */
  dismiss: string[];
  /** The language of the section written into the PR body. */
  locale: "en" | "es";
}

/** The workflow states a claim and a finished ticket move to, on a tracker that has states. */
export interface TrackerStates {
  claimed: string;
  done: string;
  /**
   * The state a CANCELLED issue moves to (#392). Optional and undefaulted:
   * Linear finds its own `canceled`-type state without being told, and a
   * default here would change what every existing project does.
   */
  canceled?: string;
  /**
   * The state a ticket handed to a person moves to when its PR is open and
   * green (`merge: "human"`). Optional and undefaulted: a workflow without a
   * review state (Jira OAI) leaves the ticket where the claim put it.
   */
  review?: string;
}

export type TrackerConfig =
  | { kind: "github" }
  | { kind: "linear"; team: string; workspace: string; scopeLabel: string | null; states: TrackerStates }
  | { kind: "jira"; site: string; project: string; scopeLabel: string | null; states: TrackerStates }
  | { kind: "local"; key: string; file: string; scopeLabel: string | null; states: TrackerStates };

/** What a tracker block that names no states gets: the states Linear and Jira ship with. */
export const TRACKER_STATE_DEFAULTS: TrackerStates = { claimed: "In Progress", done: "Done" };

/**
 * Roles that write to issues past what the `Tracker` interface carries, so
 * they run on GitHub issues only for now. The triager is not one: its keyed
 * writes (create, editBody, cancel) go through the `Tracker` seam since #392.
 */
export const GITHUB_ONLY_ROLES: readonly Role[] = ["ci-doctor"];

/**
 * A `loops` entry as the file spells it: a name, which is a coder, or an
 * object naming the role. `role` may be left out; it defaults to `coder`.
 */
export type LoopEntry = string | { name: string; role?: Role; usageStop?: UsageStopRule | null };

/** A roster entry with its role resolved. */
export interface RosterEntry {
  name: string;
  role: Role;
  /** The loop's own usage stop, or null when it is exempt; absent: the project's. */
  usageStop?: UsageStopRule | null;
}

/**
 * The apps a clerk's report is about: `APPS` in clerk/plan.ts, spelled again
 * here because importing clerk code into the config module would make the
 * clerk's own config reads a cycle. project-config.test.ts pins the two equal.
 */
const CLERK_APPS = ["Backoffice", "pwa", "both", "none"] as const;
export type ClerkApp = (typeof CLERK_APPS)[number];

/**
 * The intake board's workflow statuses the clerk acts on (felipearos/ralph#443):
 * where a filed ticket waits, the two a person ends that wait with, and where
 * a ticket moved to the person board is left.
 */
export const CLERK_STATUSES = ["pending", "confirmed", "rejected", "moved"] as const;
export type ClerkStatus = (typeof CLERK_STATUSES)[number];

/**
 * Whether a clerk writes to Slack and Jira (`live`), to Jira alone with Slack
 * kept silent (`quiet`), or only records what it would have (`shadow`).
 */
export const CLERK_MODES = ["shadow", "quiet", "live"] as const;
export type ClerkMode = (typeof CLERK_MODES)[number];

/** Whether a clerk in `mode` makes real Jira writes: live and quiet do, shadow never. */
export const writesJira = (mode: ClerkMode): boolean => mode !== "shadow";

/**
 * Whether a confirmed to-person ticket is held on the intake board rather
 * than created on OA: `holdOaMove` as configured, else the mode's default,
 * held in quiet and moved in live. A hand-spelled rules object without the
 * key gets the default too.
 */
export const holdsOaMove = (rules: Pick<ClerkRules, "mode" | "holdOaMove">): boolean => rules.holdOaMove ?? rules.mode === "quiet";

export type SecretsConfig =
  | { runner: "doppler"; project: string; config: string; withhold: string[] }
  | { runner: "none"; withhold: string[] };

export class ProjectConfigError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "ProjectConfigError";
  }
}

export const TOP_LEVEL_KEYS = [
  "repo",
  "owner",
  "baseBranch",
  "displayName",
  "secrets",
  "refuseFiles",
  "envCheck",
  "requiredChecks",
  "gates",
  "promptFragment",
  "coderFragment",
  "plan",
  "journal",
  "loops",
] as const;

/** Keys a project may leave out. Everything else is required. */
/**
 * `SuggestionWeights`' keys in evals-suggest.ts, spelled again here: that
 * module imports backtest and frontier code, which read this config, so
 * importing it here would make the config module part of a cycle.
 */
export const EVAL_SUGGESTION_WEIGHT_KEYS = [
  "blocked", "parked", "reverted", "reviewRounds", "doctor", "slow", "finishedByPerson", "reviewRoundsThreshold", "slowHours",
] as const;
export type EvalSuggestionWeightKey = (typeof EVAL_SUGGESTION_WEIGHT_KEYS)[number];

export const MERGE_METHODS = ["mergify", "github-queue", "direct"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export const OPTIONAL_KEYS = ["plugins", "executorGuard", "ciDoctor", "prMedic", "clerk", "verifier", "sentinel", "triage", "learnings", "tracker", "merge", "mergeMethod", "screenshots", "worktreeSetup", "configChanges", "usageStop", "relayEvalPatches", "appLabels", "evalSuggestionWeights", "evalsNoiseFloor", "evalsSaturation", "evalsGuardrails", "evalsImprover"] as const;

/**
 * A loop name: one lowercase word. It becomes a label (`<loop>-wip`), a branch
 * prefix (`<loop>/<n>-…`) and a key in `models.json`, so no separators.
 */
export const LOOP_NAME = /^[a-z][a-z0-9]*$/;
/**
 * A lineup's top-level keys: a loop named like one would read as a lineup in
 * `models.json`. The heads of `models.ts`'s `STAGES`, restated because
 * `models.ts` imports this module; `models.test.ts` pins the two together.
 */
const STAGE_HEADS = ["orchestrator", "executor", "mapper", "review"];
/** A plugin is named by its directory under the harness's `plugins/`. */
export const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/;

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GATE_NAME = /^[a-z][a-z0-9-]*$/;
/**
 * Gate names whose `RALPH_GATE_<NAME>` export is one of the harness's own
 * settings (ralph.sh, frontier-gate.ts): a gate named `retry-max` would export
 * its command as the retry count and every loop would refuse to start, and
 * `names` would be overwritten by `RALPH_GATE_NAMES`. Refused, now that the
 * Settings page can add a gate in one Save (#692).
 */
export const RESERVED_GATE_NAMES: readonly string[] = ["env", "names", "rate-limit-max-seconds", "retry-max", "retry-max-seconds", "retry-seconds"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** A newline in a value that becomes one line of a report or one shell word. */
const ONE_LINE_BREAK = /[\n\r]/;

/**
 * A project-relative path: not absolute, not climbing out, no whitespace or
 * control characters (these values become shell words in `--export`).
 */
function relativePathProblem(value: unknown): string | null {
  if (!isText(value)) return "must be a non-empty string";
  if (/[\s\0]/.test(value)) return "must not contain whitespace";
  if (isAbsolute(value)) return "must be relative to the project root";
  const normal = normalize(value);
  if (normal === ".." || normal.startsWith("../")) return "must stay inside the project";
  return null;
}

/**
 * A path inside the harness repository: the same shape as a project-relative
 * path, said in the right words. `learnings.file` is the one config path that
 * does NOT live in the project — the files are shared across every project on
 * the machine, so they live beside the journals in the harness — and a refusal
 * that told an operator to keep it "inside the project" would send them to the
 * wrong repository.
 */
function harnessPathProblem(value: unknown): string | null {
  if (!isText(value)) return "must be a non-empty string";
  if (/[\s\0]/.test(value)) return "must not contain whitespace or control characters";
  if (isAbsolute(value)) return "must be relative to the harness repository root";
  const normal = normalize(value);
  if (normal === ".." || normal.startsWith("../")) return "must stay inside the harness repository";
  // Held to the shape `learnings/README.md` and `defaultLearningsFile` both
  // promise, and not only for tidiness: the publisher cleans the file's
  // DIRECTORY before each attempt, so a path at the repository root would
  // widen that to the whole shared publishing worktree.
  if (!/^learnings\/[^/]+\.md$/.test(normal)) return "must be a .md file directly under learnings/";
  return null;
}

/**
 * Where a project's learnings live when it does not say: the journal's own
 * name, under `learnings/`. `journal/loggd` pairs with `learnings/loggd.md`,
 * which is the pairing `learnings/README.md` documents.
 */
function defaultLearningsFile(journalDir: string): string {
  return `learnings/${basename(journalDir)}.md`;
}

/** Every problem with `raw`, in document order. Empty means valid. */
export function validateProjectConfig(raw: unknown): string[] {
  const problems: string[] = [];
  if (!isObject(raw)) return ["the config must be a JSON object"];

  for (const key of Object.keys(raw)) {
    if (![...TOP_LEVEL_KEYS, ...OPTIONAL_KEYS].includes(key as never)) problems.push(`unknown key '${key}'`);
  }
  for (const key of TOP_LEVEL_KEYS) {
    if (!(key in raw)) problems.push(`missing '${key}'`);
  }

  if ("repo" in raw && !(typeof raw.repo === "string" && REPO.test(raw.repo))) {
    problems.push("'repo' must be 'owner/name'");
  }
  if ("owner" in raw && !(typeof raw.owner === "string" && LOGIN.test(raw.owner))) {
    problems.push("'owner' must be a GitHub login");
  }
  if ("baseBranch" in raw && !(typeof raw.baseBranch === "string" && BRANCH.test(raw.baseBranch))) {
    problems.push("'baseBranch' must be a branch name");
  }
  if ("displayName" in raw && !(isText(raw.displayName) && !ONE_LINE_BREAK.test(raw.displayName))) {
    problems.push("'displayName' must be a non-empty single-line string");
  }

  if ("secrets" in raw) {
    const secrets = raw.secrets;
    if (!isObject(secrets)) {
      problems.push("'secrets' must be an object");
    } else {
      const runner = secrets.runner;
      if (runner !== "doppler" && runner !== "none") {
        problems.push("'secrets.runner' must be 'doppler' or 'none'");
      }
      const allowed = runner === "none" ? ["runner", "withhold"] : ["runner", "project", "config", "withhold"];
      for (const key of Object.keys(secrets)) {
        if (!allowed.includes(key)) problems.push(`unknown key 'secrets.${key}'${runner === "none" ? " for runner 'none'" : ""}`);
      }
      if (runner === "doppler") {
        for (const key of ["project", "config"] as const) {
          if (!(typeof secrets[key] === "string" && SCOPE.test(secrets[key] as string))) {
            problems.push(`'secrets.${key}' must be a Doppler ${key} name`);
          }
        }
      }
      if (!Array.isArray(secrets.withhold)) {
        problems.push("'secrets.withhold' must be an array of environment variable names");
      } else {
        secrets.withhold.forEach((name, index) => {
          if (!(typeof name === "string" && ENV_NAME.test(name))) {
            problems.push(`'secrets.withhold[${index}]' must be an environment variable name`);
          }
        });
      }
    }
  }

  if ("refuseFiles" in raw) {
    if (!Array.isArray(raw.refuseFiles)) {
      problems.push("'refuseFiles' must be an array of project-relative paths");
    } else {
      raw.refuseFiles.forEach((path, index) => {
        const problem = relativePathProblem(path);
        if (problem) problems.push(`'refuseFiles[${index}]' ${problem}`);
      });
    }
  }

  if ("envCheck" in raw) {
    if (!Array.isArray(raw.envCheck) || !raw.envCheck.every((word) => typeof word === "string" && !word.includes("\0"))) {
      problems.push("'envCheck' must be an argv array of strings (empty for no check)");
    } else if (raw.envCheck.length > 0 && !isText(raw.envCheck[0])) {
      problems.push("'envCheck[0]' must name a command");
    }
  }

  if ("requiredChecks" in raw) {
    if (!Array.isArray(raw.requiredChecks) || !raw.requiredChecks.every((name) => isText(name) && !ONE_LINE_BREAK.test(name))) {
      problems.push("'requiredChecks' must be an array of check names");
    }
  }

  if ("gates" in raw) {
    if (!isObject(raw.gates)) {
      problems.push("'gates' must be an object of name → command");
    } else {
      for (const [name, command] of Object.entries(raw.gates)) {
        if (!GATE_NAME.test(name)) problems.push(`gate name '${name}' must be lowercase kebab-case`);
        else if (RESERVED_GATE_NAMES.includes(name)) problems.push(`gate name '${name}' is reserved: the harness exports its own ${gateVar(name)}`);
        if (!(isText(command) && !ONE_LINE_BREAK.test(command))) problems.push(`'gates.${name}' must be a one-line command`);
      }
    }
  }

  for (const key of ["promptFragment", "coderFragment", "plan"] as const) {
    if (key in raw) {
      const problem = relativePathProblem(raw[key]);
      if (problem) problems.push(`'${key}' ${problem}`);
    }
  }

  if ("journal" in raw) {
    if (!isObject(raw.journal)) {
      problems.push("'journal' must be an object with a 'dir'");
    } else {
      for (const key of Object.keys(raw.journal)) {
        if (key !== "dir" && key !== "branch") problems.push(`unknown key 'journal.${key}'`);
      }
      const problem = relativePathProblem(raw.journal.dir);
      if (problem) problems.push(`'journal.dir' ${problem}`);
      if ("branch" in raw.journal) {
        const branch = raw.journal.branch;
        // The publisher pushes straight to this branch, without review. Naming
        // the base (or a conventional default) would land journal commits in
        // the project's code history, so those are refused outright.
        if (!(typeof branch === "string" && BRANCH.test(branch))) {
          problems.push("'journal.branch' must be a branch name");
        } else if (branch === raw.baseBranch || ["main", "master", "dev", "develop"].includes(branch)) {
          problems.push(`'journal.branch' must not be the base branch or a default branch name; got '${branch}'`);
        }
      }
    }
  }

  if ("learnings" in raw && raw.learnings !== false) {
    if (!isObject(raw.learnings)) {
      problems.push("'learnings' must be an object with a 'file', or false to opt out");
    } else {
      for (const key of Object.keys(raw.learnings)) {
        if (key !== "file") problems.push(`unknown key 'learnings.${key}'`);
      }
      const problem = harnessPathProblem(raw.learnings.file);
      if (problem) problems.push(`'learnings.file' ${problem}`);
    }
  }

  if ("merge" in raw && raw.merge !== "loop" && raw.merge !== "human") {
    problems.push("'merge' must be 'loop' or 'human'");
  }

  if ("mergeMethod" in raw && !(MERGE_METHODS as readonly unknown[]).includes(raw.mergeMethod)) {
    problems.push(`'mergeMethod' must be one of ${MERGE_METHODS.map((m) => `'${m}'`).join(", ")}`);
  }

  if ("configChanges" in raw && raw.configChanges !== "commit" && raw.configChanges !== "pr") {
    problems.push("'configChanges' must be 'commit' or 'pr'");
  }

  if ("relayEvalPatches" in raw && typeof raw.relayEvalPatches !== "boolean") {
    problems.push("'relayEvalPatches' must be true or false");
  }

  if ("appLabels" in raw) problems.push(...appLabelsProblems(raw.appLabels));

  if ("evalSuggestionWeights" in raw) {
    const weights = raw.evalSuggestionWeights;
    if (!isObject(weights)) {
      problems.push("'evalSuggestionWeights' must be an object");
    } else {
      for (const [key, value] of Object.entries(weights)) {
        if (!EVAL_SUGGESTION_WEIGHT_KEYS.includes(key as EvalSuggestionWeightKey)) {
          problems.push(`unknown key 'evalSuggestionWeights.${key}'`);
        } else if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          problems.push(`'evalSuggestionWeights.${key}' must be a number >= 0`);
        }
      }
    }
  }

  if ("evalsNoiseFloor" in raw) {
    if (!isObject(raw.evalsNoiseFloor)) {
      problems.push("'evalsNoiseFloor' must be an object with 'arms' and/or 'staleShare'");
    } else {
      const floor = raw.evalsNoiseFloor;
      for (const key of Object.keys(floor)) {
        if (key !== "arms" && key !== "staleShare") problems.push(`unknown key 'evalsNoiseFloor.${key}'`);
      }
      // 6 is backtest.ts's MAX_ARMS, restated: backtest.ts imports this module, so importing it back would be a cycle.
      if ("arms" in floor && (typeof floor.arms !== "number" || !Number.isInteger(floor.arms) || floor.arms < 2 || floor.arms > 6)) {
        problems.push("'evalsNoiseFloor.arms' must be an integer from 2 to 6");
      }
      if ("staleShare" in floor && (typeof floor.staleShare !== "number" || !(floor.staleShare > 0) || floor.staleShare > 1)) {
        problems.push("'evalsNoiseFloor.staleShare' must be a number above 0 and at most 1");
      }
    }
  }

  if ("evalsSaturation" in raw) {
    if (!isObject(raw.evalsSaturation)) {
      problems.push("'evalsSaturation' must be an object with 'runs'");
    } else {
      const saturation = raw.evalsSaturation;
      for (const key of Object.keys(saturation)) {
        if (key !== "runs") problems.push(`unknown key 'evalsSaturation.${key}'`);
      }
      if ("runs" in saturation && (typeof saturation.runs !== "number" || !Number.isInteger(saturation.runs) || saturation.runs < 1 || saturation.runs > 20)) {
        problems.push("'evalsSaturation.runs' must be an integer from 1 to 20");
      }
    }
  }

  if ("evalsGuardrails" in raw) {
    if (!isObject(raw.evalsGuardrails)) {
      problems.push("'evalsGuardrails' must be an object with 'maxCostRise' and/or 'minTokenCut'");
    } else {
      const guardrails = raw.evalsGuardrails;
      for (const key of Object.keys(guardrails)) {
        if (key !== "maxCostRise" && key !== "minTokenCut") problems.push(`unknown key 'evalsGuardrails.${key}'`);
      }
      // A rise of 0 is a real choice (never pay more); a cut of 0 or 1 is not: one passes any spend, the other none.
      if ("maxCostRise" in guardrails && (typeof guardrails.maxCostRise !== "number" || !(guardrails.maxCostRise >= 0) || guardrails.maxCostRise > 10)) {
        problems.push("'evalsGuardrails.maxCostRise' must be a number from 0 to 10");
      }
      if ("minTokenCut" in guardrails && (typeof guardrails.minTokenCut !== "number" || !(guardrails.minTokenCut > 0) || guardrails.minTokenCut >= 1)) {
        problems.push("'evalsGuardrails.minTokenCut' must be a number above 0 and below 1");
        }
      }
    }

  if ("evalsImprover" in raw) {
    if (!isObject(raw.evalsImprover)) {
      problems.push("'evalsImprover' must be an object with 'size', 'failed' and/or 'autoMerge'");
    } else {
      const improver = raw.evalsImprover;
      for (const key of Object.keys(improver)) {
        if (key !== "size" && key !== "failed" && key !== "autoMerge") problems.push(`unknown key 'evalsImprover.${key}'`);
      }
      if ("size" in improver && (typeof improver.size !== "number" || !Number.isInteger(improver.size) || improver.size < 1 || improver.size > 200)) {
        problems.push("'evalsImprover.size' must be an integer from 1 to 200");
      }
      if ("failed" in improver && typeof improver.failed !== "boolean") {
        problems.push("'evalsImprover.failed' must be a boolean");
      }
      if ("autoMerge" in improver && typeof improver.autoMerge !== "boolean") {
        problems.push("'evalsImprover.autoMerge' must be a boolean");
      }
    }
  }

  if ("plugins" in raw) {
    if (!Array.isArray(raw.plugins) || !raw.plugins.every((name) => typeof name === "string" && PLUGIN_NAME.test(name))) {
      problems.push("'plugins' must be an array of plugin names (lowercase kebab-case)");
    }
  }

  if ("executorGuard" in raw) {
    const guard = raw.executorGuard;
    if (!isObject(guard)) {
      problems.push("'executorGuard' must be an object with 'refuse' and/or 'requireTargets'");
    } else {
      for (const key of Object.keys(guard)) {
        if (key !== "refuse" && key !== "requireTargets") problems.push(`unknown key 'executorGuard.${key}'`);
      }
      for (const key of ["refuse", "requireTargets"] as const) {
        if (key in guard && !(Array.isArray(guard[key]) && guard[key].every((command) => isText(command) && !ONE_LINE_BREAK.test(command)))) {
          problems.push(`'executorGuard.${key}' must be an array of one-line commands`);
        }
      }
    }
  }

  if ("ciDoctor" in raw) problems.push(...ciDoctorProblems(raw.ciDoctor, raw.loops));

  // Unconditional, unlike `ciDoctor`'s: a rostered medic with no block at all
  // is the case the check exists for, so it cannot be gated on the key being
  // present.
  problems.push(...prMedicProblems("prMedic" in raw ? raw.prMedic : undefined, raw.loops));

  // Unconditional for the medic's reason: a rostered clerk with no block has
  // no channel to read and no project to file in.
  problems.push(...clerkProblems("clerk" in raw ? raw.clerk : undefined, raw.loops));
  // A clerk files every ticket under an app label, so it cannot start without them.
  if ("clerk" in raw && !("appLabels" in raw)) {
    problems.push("'appLabels' is required with 'clerk': the clerk files each ticket under its app's label ({ \"backoffice\": …, \"pwa\": … })");
  }

  // Unconditional for the clerk's reason: a rostered verifier with no block
  // has no production to watch and no deploy to wait for.
  problems.push(...verifierProblems("verifier" in raw ? raw.verifier : undefined, raw.loops));

  // Unconditional for the verifier's reason: a rostered sentinel with no block
  // has no reporter to read.
  problems.push(...sentinelProblems("sentinel" in raw ? raw.sentinel : undefined, raw.loops));

  if ("triage" in raw) problems.push(...triageProblems(raw.triage));

  if ("tracker" in raw) problems.push(...trackerProblems(raw.tracker, raw.loops));

  if ("screenshots" in raw) problems.push(...screenshotsProblems(raw.screenshots));

  if ("worktreeSetup" in raw) problems.push(...worktreeSetupProblems(raw.worktreeSetup));

  if ("usageStop" in raw) problems.push(...usageStopProblems(raw.usageStop, "usageStop", false));

  if ("loops" in raw) problems.push(...loopsProblems(raw.loops));

  return problems;
}

/** A Linear team key: what prefixes its issue identifiers (`AND` in `AND-184`). */
const LINEAR_TEAM = /^[A-Z][A-Z0-9]{0,9}$/;
/** A Linear workspace URL key: `exampleorg` in `linear.app/exampleorg/...`. */
const LINEAR_WORKSPACE = /^[a-z0-9][a-z0-9-]*$/;

/** Every problem with a `tracker` block, in document order. */
function trackerProblems(block: unknown, loops: unknown): string[] {
  if (!isObject(block)) return ["'tracker' must be an object with a 'kind'"];
  const kind = block.kind;
  if (kind !== "github" && kind !== "linear" && kind !== "jira" && kind !== "local") {
    return [`'tracker.kind' must be 'github', 'linear', 'jira' or 'local'; got ${JSON.stringify(kind)}`];
  }
  const problems: string[] = [];
  const known =
    kind === "github"
      ? ["kind"]
      : kind === "linear"
        ? ["kind", "team", "workspace", "scopeLabel", "states"]
        : kind === "jira"
          ? ["kind", "site", "project", "scopeLabel", "states"]
          : // No scopeLabel: a local file is one sandbox's tickets, with no sibling project's to tell apart.
            ["kind", "key", "file", "states"];
  for (const key of Object.keys(block)) {
    if (!known.includes(key)) problems.push(`unknown key 'tracker.${key}' for kind '${kind}'`);
  }
  if (kind === "linear" && !(typeof block.team === "string" && LINEAR_TEAM.test(block.team))) {
    problems.push(`'tracker.team' must be a Linear team key such as 'AND'; got ${JSON.stringify(block.team)}`);
  }
  // The workspace's URL key, which every issue link starts with; the connector
  // reads it off the token's organization.
  if (kind === "linear" && !(typeof block.workspace === "string" && LINEAR_WORKSPACE.test(block.workspace))) {
    problems.push(`'tracker.workspace' must be the Linear workspace URL key such as 'acme'; got ${JSON.stringify(block.workspace)}`);
  }
  // One team or project often holds several repositories' tickets. The scope
  // label is what makes an issue this project's; without it a loop would take
  // a sibling repo's ready tickets.
  if (kind !== "github" && "scopeLabel" in block && !(isText(block.scopeLabel) && !ONE_LINE_BREAK.test(block.scopeLabel))) {
    problems.push("'tracker.scopeLabel' must be a label name");
  }
  if (kind === "jira") {
    if (!(typeof block.site === "string" && JIRA_SITE.test(block.site))) {
      problems.push(`'tracker.site' must be a host name such as 'example.atlassian.net'; got ${JSON.stringify(block.site)}`);
    }
    if (!(typeof block.project === "string" && JIRA_PROJECT.test(block.project))) {
      problems.push(`'tracker.project' must be a Jira project key such as 'OA'; got ${JSON.stringify(block.project)}`);
    }
  }
  if (kind === "local") {
    if (!(typeof block.key === "string" && LINEAR_TEAM.test(block.key))) {
      problems.push(`'tracker.key' must be an issue key prefix such as 'SBX'; got ${JSON.stringify(block.key)}`);
    }
    // Every `bun tracker.ts` call runs in whichever directory its caller is
    // in; a relative path would point each one at a different file.
    if (!(isText(block.file) && !ONE_LINE_BREAK.test(block.file))) {
      problems.push("'tracker.file' must be the absolute path of the tickets file");
    } else if (!isAbsolute(block.file)) {
      problems.push(`'tracker.file' must be an absolute path; got ${JSON.stringify(block.file)}`);
    }
  }
  if ("states" in block) {
    const states = block.states;
    if (!isObject(states)) {
      problems.push("'tracker.states' must be an object with 'claimed', 'done', 'canceled' and/or 'review'");
    } else {
      for (const key of Object.keys(states)) {
        if (key !== "claimed" && key !== "done" && key !== "canceled" && key !== "review") problems.push(`unknown key 'tracker.states.${key}'`);
      }
      for (const key of ["claimed", "done", "canceled", "review"] as const) {
        if (key in states && !(isText(states[key]) && !ONE_LINE_BREAK.test(states[key] as string))) {
          problems.push(`'tracker.states.${key}' must be a workflow state name`);
        }
      }
    }
  }
  // Refused here rather than at the first write: a role that cannot create
  // or edit issues would fail mid-iteration, holding a claim, overnight.
  if (kind !== "github" && Array.isArray(loops)) {
    for (const entry of loops) {
      if (isObject(entry) && GITHUB_ONLY_ROLES.includes(entry.role as Role)) {
        problems.push(
          `loop '${String(entry.name)}' has the ${String(entry.role)} role, which runs on GitHub issues only; a '${kind}' tracker supports coder and triager loops`,
        );
      }
    }
  }
  return problems;
}

/** The tracker a validated file names, with the default filled in. */
function resolveTracker(block: unknown): TrackerConfig {
  if (!isObject(block) || block.kind === "github") return { kind: "github" };
  const spelt = isObject(block.states) ? block.states : {};
  const states: TrackerStates = {
    claimed: (spelt.claimed as string | undefined) ?? TRACKER_STATE_DEFAULTS.claimed,
    done: (spelt.done as string | undefined) ?? TRACKER_STATE_DEFAULTS.done,
    // Left off when the file does not spell it, so an adapter can tell
    // "the operator named a cancelled state" from "find your own".
    ...(typeof spelt.canceled === "string" ? { canceled: spelt.canceled } : {}),
    ...(typeof spelt.review === "string" ? { review: spelt.review } : {}),
  };
  const scopeLabel = typeof block.scopeLabel === "string" ? block.scopeLabel : null;
  if (block.kind === "linear") return { kind: "linear", team: block.team as string, workspace: block.workspace as string, scopeLabel, states };
  if (block.kind === "local") return { kind: "local", key: block.key as string, file: block.file as string, scopeLabel: null, states };
  return { kind: "jira", site: block.site as string, project: block.project as string, scopeLabel, states };
}

/** A whole number at least `least`, as the problem with it or null. */
function wholeNumberProblem(value: unknown, where: string, least: number): string | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < least) {
    return `'${where}' must be a whole number of at least ${least}; got ${JSON.stringify(value)}`;
  }
  return null;
}

/**
 * The ceilings `retry` may not be raised past, and the whole reason the key is
 * validated rather than read raw: these are the numbers that bound what the
 * doctor spends on somebody else's CI, and a config is exactly where a
 * well-meaning edit would raise them.
 */
export const RETRY_CEILINGS = { perCandidate: 1, perDay: 6 } as const;

/**
 * Every problem with a `ciDoctor` block, in document order.
 *
 * `loops` comes in because the block is role-gated and the roster is the only
 * thing that can say whether the role exists here. Passed as the raw value, not
 * a parsed roster: validation never throws and must survive a `loops` that is
 * itself nonsense.
 *
 * The validated key set is deliberately WIDER than the one felipearos/ralph#158
 * lists. `executor-guard/diff-guard.ts` already reads `testTimeoutCeilingMs`
 * and `hookTimeoutCeilingMs` (they shipped with #152) and the README documents
 * them, so refusing them as unknown keys would make a config the harness
 * already honours invalid.
 */
function ciDoctorProblems(block: unknown, loops: unknown): string[] {
  const problems: string[] = [];
  // A roster that is not an array has already been reported by `loopsProblems`,
  // and a role cannot be read out of it. Reporting the gate too would answer
  // one malformed key with two unrelated complaints, the second of which the
  // operator cannot act on.
  // `satisfies Role` rather than a bare literal: a typo here would silently
  // refuse every `ciDoctor` block forever instead of failing loudly, and this
  // is the only place in the harness that compares a role as a string.
  const DOCTOR = "ci-doctor" satisfies Role;
  if (Array.isArray(loops) && !loops.some((entry) => isObject(entry) && entry.role === DOCTOR)) {
    problems.push(`'ciDoctor' needs a roster entry with the ci-doctor role; no loop in 'loops' has it`);
  }
  if (!isObject(block)) return [...problems, "'ciDoctor' must be an object of the ci-doctor's rules"];

  const known = [
    "fixScope",
    "neverTouch",
    "pollSeconds",
    "windowHours",
    "autoRevert",
    "testTimeoutCeilingMs",
    "hookTimeoutCeilingMs",
    "retry",
  ];
  for (const key of Object.keys(block)) {
    if (!known.includes(key)) problems.push(`unknown key 'ciDoctor.${key}'`);
  }
  for (const key of ["fixScope", "neverTouch"] as const) {
    if (
      key in block &&
      !(Array.isArray(block[key]) && block[key].length > 0 && block[key].every((glob) => isText(glob) && !ONE_LINE_BREAK.test(glob)))
    ) {
      problems.push(`'ciDoctor.${key}' must be a non-empty array of one-line globs`);
    }
  }
  for (const key of ["pollSeconds", "windowHours", "testTimeoutCeilingMs", "hookTimeoutCeilingMs"] as const) {
    if (key in block) {
      const problem = wholeNumberProblem(block[key], `ciDoctor.${key}`, 1);
      if (problem !== null) problems.push(problem);
    }
  }
  if ("autoRevert" in block && typeof block.autoRevert !== "boolean") {
    problems.push(`'ciDoctor.autoRevert' must be true or false; got ${JSON.stringify(block.autoRevert)}`);
  }
  if ("retry" in block) {
    const retry = block.retry;
    if (!isObject(retry)) {
      problems.push("'ciDoctor.retry' must be an object with 'perCandidate' and/or 'perDay'");
    } else {
      for (const key of Object.keys(retry)) {
        if (key !== "perCandidate" && key !== "perDay") problems.push(`unknown key 'ciDoctor.retry.${key}'`);
      }
      for (const key of ["perCandidate", "perDay"] as const) {
        if (!(key in retry)) continue;
        const problem = wholeNumberProblem(retry[key], `ciDoctor.retry.${key}`, 0);
        if (problem !== null) {
          problems.push(problem);
        } else if ((retry[key] as number) > RETRY_CEILINGS[key]) {
          problems.push(`'ciDoctor.retry.${key}' may be lowered but not raised; ${RETRY_CEILINGS[key]} is the most the doctor may spend`);
        }
      }
    }
  }
  return problems;
}

/**
 * What `prMedic.quietMinutes` and `prMedic.maxPushes` mean when the file leaves
 * them out, as felipearos/ralph#244 decided them.
 *
 * Declared here and applied elsewhere: the intake gate (`pr-medic/gate.ts`'s
 * `rulesFrom`, felipearos/ralph#246) reads both — it skips a PR inside the
 * quiet period, and one whose top `maxPushes` commits carry the `Pr-Medic`
 * trailer the push fence (`pr-medic/push.ts`, felipearos/ralph#247) requires
 * on every medic push — and this validator only bounds what an operator may
 * write. It is one constant rather than a number in each reader so they cannot
 * disagree — a quiet period
 * spelled twice is a medic that skips a branch its own cap would have let it
 * push to — and it is the `ciDoctor` precedent, whose defaults also live beside
 * the validator and are applied by `ci-doctor/retry.ts`.
 */
export const PR_MEDIC_DEFAULTS = { quietMinutes: 15, maxPushes: 3 } as const;

/**
 * Every problem with a `prMedic` block, in document order.
 *
 * Called with `undefined` when the file carries no block, because the absence
 * is itself a problem once a medic is rostered — `branches` is the one key with
 * no default (see the interface).
 *
 * `loops` comes in raw rather than as a parsed roster for `ciDoctorProblems`'
 * reason: validation never throws and has to survive a `loops` that is itself
 * nonsense, which `loopsProblems` has already reported.
 */
function prMedicProblems(block: unknown, loops: unknown): string[] {
  const problems: string[] = [];
  // `satisfies Role` so a typo here fails the build instead of silently
  // switching the whole gate off, as `ciDoctorProblems` does.
  const MEDIC = "pr-medic" satisfies Role;
  // A `loops` that is not an array has already been reported by `loopsProblems`
  // and no role can be read out of it, so the gate below stays quiet rather than
  // answering one malformed key with a second complaint nobody can act on.
  const readable = Array.isArray(loops);
  const rostered = readable && loops.some((entry) => isObject(entry) && entry.role === MEDIC);
  if (block === undefined) {
    if (rostered) {
      problems.push(
        "'prMedic.branches' is required: a loop in 'loops' has the pr-medic role, and nothing says whose branches it may touch",
      );
    }
    return problems;
  }
  if (readable && !rostered) {
    problems.push("'prMedic' needs a roster entry with the pr-medic role; no loop in 'loops' has it");
  }
  if (!isObject(block)) return [...problems, "'prMedic' must be an object of the medic's rules"];

  const known = ["branches", "quietMinutes", "maxPushes"];
  for (const key of Object.keys(block)) {
    if (!known.includes(key)) problems.push(`unknown key 'prMedic.${key}'`);
  }
  const globs = block.branches;
  if (!(Array.isArray(globs) && globs.length > 0 && globs.every((glob) => isText(glob) && !ONE_LINE_BREAK.test(glob)))) {
    problems.push("'prMedic.branches' must be a non-empty array of one-line branch globs");
  } else {
    const names = readable ? loops.map((entry) => (isObject(entry) ? entry.name : entry)).filter(isText) : [];
    for (const [index, glob] of globs.filter(isText).entries()) {
      // Before the overlap question, because the overlap answer is only as
      // meaningful as the dialect: a glob the harness escapes to a literal and
      // a conventional matcher reads as a wildcard would pass this check and
      // then reach the branches it was checked against (see `branches`' doc).
      const offender = OUTSIDE_GLOB_DIALECT.exec(glob);
      if (offender !== null) {
        problems.push(
          `'prMedic.branches[${index}]' is '${glob}', which uses '${offender[0]}'; a branch glob here is '*' (within one segment), '?' and '**' only, so a pattern other matchers would read differently is refused`,
        );
        continue;
      }
      if (glob.startsWith("refs/")) {
        problems.push(`'prMedic.branches[${index}]' is '${glob}'; match the branch name a pull request carries ('felipearosr/*'), not a full ref`);
        continue;
      }
      // The medic's non-goal, enforced where it is cheapest to enforce: an agent
      // loop's own branches belong to that loop, which shepherds its own pull
      // request, and a medic pushing to one would be two agents force-pushing the
      // same branch. Checked against the roster rather than against a fixed list
      // of prefixes, because the prefixes ARE the roster names.
      //
      // Every owner, not the first: a wildcard first segment reaches all of
      // them, and naming one would have the operator narrow the glob and be
      // refused again for the next.
      const owners = names.filter((name) => overlapsLoopPrefix(glob, name));
      if (owners.length > 0) {
        problems.push(
          `'prMedic.branches[${index}]' is '${glob}', which matches the ${owners.map((name) => `'${name}/'`).join(", ")} branches ` +
            `the ${owners.join(", ")} ${owners.length === 1 ? "loop owns" : "loops own"}; a medic never touches an agent's own pull request`,
        );
      }
    }
  }
  for (const key of ["quietMinutes", "maxPushes"] as const) {
    if (key in block) {
      // At least 1 for both. A `quietMinutes` of 0 would let the medic pick a
      // branch the operator is mid-push on, and a `maxPushes` of 0 would roster
      // a medic that can never act — a mode nothing implements, and one that
      // would read as configured rather than as off.
      const problem = wholeNumberProblem(block[key], `prMedic.${key}`, 1);
      if (problem !== null) problems.push(problem);
    }
  }
  return problems;
}

/**
 * What a clerk's timings and sizes mean when the file leaves them out, as
 * felipearos/ralph#315 decided them: a report is settled after ten quiet
 * minutes, one author's messages within three minutes are one report, the
 * canvas is rebuilt every fifteen, a model turn takes at most twenty reports,
 * a match closed within thirty days is a possible regression, and a canvas
 * table shows forty rows before "y N más".
 *
 * One constant beside the validator, the `PR_MEDIC_DEFAULTS` precedent, so the
 * gate and the apply cannot disagree about a window.
 */
export const CLERK_DEFAULTS = {
  mode: "shadow",
  settleMinutes: 10,
  joinMinutes: 3,
  canvasMinutes: 15,
  batchSize: 20,
  regressionDays: 30,
  // At the ceiling: below it since the shadow canvas grew to nine columns
  // (felipearos/ralph#444), a default past it would be a canvas Slack refuses.
  rowCap: 32,
  // A report's files are copied onto its Jira ticket (felipearos/ralph#315
  // follow-up): one bigger than this is linked instead. Well under the Jira
  // site's 1 GB, because a poll streams each file through the host's disk.
  attachmentMaxMb: 100,
} as const;

/** The Jira site's own attachment limit, which `clerk.attachmentMaxMb` may not exceed. */
export const CLERK_ATTACHMENT_CEILING_MB = 1024;

/**
 * The repo labels a report carries, by the app it is about: `both` carries
 * both; `none` goes to backoffice because the triager there judges a report no
 * app claims (felipearos/ralph#391). Its own name because the intake board
 * (#443) labels its tickets by it. The names are the project's `appLabels`.
 */
export function clerkAppLabels(apps: AppLabels): Record<ClerkApp, readonly string[]> {
  return { Backoffice: [apps.backoffice], pwa: [apps.pwa], both: [apps.backoffice, apps.pwa], none: [apps.backoffice] };
}

/**
 * The intake board's workflow status names when the file leaves them out, as
 * felipearos/ralph#443 decided them. Spanish because they are the names the
 * team reads on the board.
 */
export const CLERK_JIRA_DEFAULTS = {
  statuses: {
    pending: "Por confirmar",
    confirmed: "Confirmado",
    rejected: "Descartado",
    moved: "Movido",
  },
} as const satisfies { statuses: Record<ClerkStatus, string> };

/**
 * The most rows a canvas table may hold. Slack refuses a table of more than
 * 300 cells, the widest section has nine columns (the shadow canvas's open
 * sections, with Dificultad and Puntos since felipearos/ralph#444), and the
 * header row is a row: 9 × (32 + 1) = 297 is the last count that fits.
 */
export const CLERK_ROW_CAP_CEILING = 32;

/** The most reports one model turn is handed: a plan bigger than this is a plan nobody reads back. */
export const CLERK_BATCH_CEILING = 50;

/** A Slack channel id: public (`C…`) or private (`G…`). */
const SLACK_CHANNEL = /^[CG][A-Z0-9]{6,}$/;
/** A Slack user id: a member (`U…`) or an Enterprise Grid one (`W…`). */
const SLACK_USER = /^[UW][A-Z0-9]{6,}$/;

/**
 * A link the canvas may carry: https, one line, no space or markdown bracket
 * that would end the link early, and short enough to read.
 */
function isDashboardUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 500 || /[\s()[\]<>|]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}
/** A Slack canvas is a file, and its id is a file id. */
const SLACK_CANVAS = /^F[A-Z0-9]{6,}$/;
/** An Atlassian site's host name, without a scheme or a path. */
const JIRA_SITE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
/** A Jira project key. */
const JIRA_PROJECT = /^[A-Z][A-Z0-9_]+$/;
/** A Jira custom field id, as the REST API names it. */
const JIRA_CUSTOM_FIELD = /^customfield_\d+$/;

/** A clerk's whole configuration, every default filled in. */
export interface ClerkRules {
  mode: ClerkMode;
  /**
   * A confirmed to-person ticket is held on the intake board, never created
   * on the person board. Optional in the type only, as `dashboardUrl` is;
   * `clerkRules` always fills it with the mode's default (`holdsOaMove`).
   */
  holdOaMove?: boolean;
  channel: string;
  canvas: string | null;
  shadowCanvas: string | null;
  operator: string | null;
  /**
   * The hosted intake page the canvas links to; null or absent leaves the link
   * out. Optional in the type only, as `ClerkJira`'s intake keys are, so a
   * rules object spelled by hand keeps compiling; `clerkRules` always fills it.
   */
  dashboardUrl?: string | null;
  /**
   * Slack user ids whose messages are never reports. Optional in the type
   * only, as `dashboardUrl` is; `clerkRules` always fills it, empty by default.
   */
  ignoreUsers?: string[];
  /** The app repos the intake page reads PRs from. Optional in the type only; `clerkRules` fills it, absent meaning none. */
  prRepos?: string[] | null;
  /** The project's `appLabels`, which the validator requires beside a `clerk`. */
  appLabels: AppLabels;
  /** The project's `displayName`, the intake page's title. Optional in the type only; `clerkRules` fills it. */
  title?: string;
  jira: ClerkJira;
  settleMinutes: number;
  joinMinutes: number;
  canvasMinutes: number;
  batchSize: number;
  regressionDays: number;
  rowCap: number;
  /**
   * The largest report file, in MB, the clerk copies onto a ticket. Optional
   * in the type only, as `dashboardUrl` is; `clerkRules` always fills it.
   */
  attachmentMaxMb?: number;
  /** The daily KPI DM; null (or absent, in a hand-spelled rules object) sends none. */
  kpiReport?: KpiReportRules | null;
  /** Code context comments (felipearos/ralph#499); null or absent is the feature off. */
  codeContext?: CodeContextRules | null;
  /**
   * Whether an agent project works the pwa repo. Optional in the type only, as
   * `dashboardUrl` is; `clerkRules` always fills it, false by default.
   */
  pwaAgents?: boolean;
}

/**
 * A clerk's Jira: the site, the person board (`project`) and the intake board.
 *
 * The intake keys are optional in the type only so a rules object a test or a
 * caller spells by hand keeps compiling: `clerkRules` always fills all three,
 * `null` meaning "not configured", and a reader that may be handed a
 * hand-spelled object goes through `clerkJira`.
 */
export interface ClerkJira {
  site: string;
  project: string;
  /** The intake board's key; null for a shadow clerk with no board, which files nothing. */
  intakeProject?: string | null;
  /** The story points custom field; null puts the points in the description. */
  storyPointsField?: string | null;
  statuses?: Record<ClerkStatus, string>;
  /** Where a worked intake ticket goes once its PR is merged; null moves none. */
  mergedStatus?: string | null;
  /** The person board's ticket a moved one is filed under; null files it at the top level. */
  parent?: string | null;
  /** The person board's statuses that tell a moved report it is resolved before Done; empty, only Done does. */
  readyStatuses?: string[];
}

/** A clerk's Jira with every intake key filled: absent ones are not configured, and the statuses default. */
export function clerkJira(jira: Omit<ClerkJira, "statuses"> & { statuses?: Partial<Record<ClerkStatus, string>> }): Required<ClerkJira> {
  return {
    site: jira.site,
    project: jira.project,
    intakeProject: jira.intakeProject ?? null,
    storyPointsField: jira.storyPointsField ?? null,
    statuses: { ...CLERK_JIRA_DEFAULTS.statuses, ...jira.statuses },
    mergedStatus: jira.mergedStatus ?? null,
    parent: jira.parent ?? null,
    readyStatuses: [...(jira.readyStatuses ?? [])],
  };
}

/**
 * The project's `clerk` block with every default applied, or null when there
 * is none. Read from a VALIDATED config only, which is why it can trust the
 * required keys: `clerkProblems` has already refused a block without them.
 */
export function clerkRules(config: ProjectConfig): ClerkRules | null {
  const block = config.clerk;
  if (block === undefined) return null;
  return {
    mode: block.mode ?? CLERK_DEFAULTS.mode,
    holdOaMove: holdsOaMove({ mode: block.mode ?? CLERK_DEFAULTS.mode, ...(block.holdOaMove === undefined ? {} : { holdOaMove: block.holdOaMove }) }),
    channel: block.channel ?? "",
    canvas: block.canvas ?? null,
    shadowCanvas: block.shadowCanvas ?? null,
    operator: block.operator ?? null,
    dashboardUrl: block.dashboardUrl ?? null,
    ignoreUsers: [...(block.ignoreUsers ?? [])],
    prRepos: block.prRepos === undefined ? null : [...block.prRepos],
    // Validated beside the clerk block; the empty pair is never reached on a validated config.
    appLabels: { backoffice: config.appLabels?.backoffice ?? "", pwa: config.appLabels?.pwa ?? "" },
    title: config.displayName,
    pwaAgents: block.pwaAgents === true,
    jira: clerkJira({
      site: block.jira?.site ?? "",
      project: block.jira?.project ?? "",
      intakeProject: block.jira?.intakeProject ?? null,
      storyPointsField: block.jira?.storyPointsField ?? null,
      statuses: block.jira?.statuses ?? {},
      mergedStatus: block.jira?.mergedStatus ?? null,
      parent: block.jira?.parent ?? null,
      readyStatuses: block.jira?.readyStatuses ?? [],
    }),
    settleMinutes: block.settleMinutes ?? CLERK_DEFAULTS.settleMinutes,
    joinMinutes: block.joinMinutes ?? CLERK_DEFAULTS.joinMinutes,
    canvasMinutes: block.canvasMinutes ?? CLERK_DEFAULTS.canvasMinutes,
    batchSize: block.batchSize ?? CLERK_DEFAULTS.batchSize,
    regressionDays: block.regressionDays ?? CLERK_DEFAULTS.regressionDays,
    rowCap: block.rowCap ?? CLERK_DEFAULTS.rowCap,
    attachmentMaxMb: block.attachmentMaxMb ?? CLERK_DEFAULTS.attachmentMaxMb,
    codeContext: clerkCodeContext(block.codeContext).rules,
    // Absent rather than null without a block, so a config with no report reads exactly as it did before #453.
    ...(block.kpiReport === undefined
      ? {}
      : { kpiReport: { ...KPI_REPORT_DEFAULTS, ...block.kpiReport, recipients: [...(block.kpiReport.recipients ?? [])], channels: [...(block.kpiReport.channels ?? [])], exclude: [...(block.kpiReport.exclude ?? [])] } }),
  };
}

/** The apps a code-context case reads: the clerk's apps that are code, in the order a verdict names them. */
export const CODE_CONTEXT_APPS = ["pwa", "Backoffice"] as const;
export type CodeContextApp = (typeof CODE_CONTEXT_APPS)[number];

/** One app's code: the local clone the gate fetches, the ref it reads, and the ref that is deployed. */
export interface CodeContextRepo {
  /** An absolute path to a clone; the gate never touches its checkout or branches. */
  path: string;
  /** What the session reads, e.g. `origin/dev`. */
  ref: string;
  /** What is in production, e.g. `origin/main`: "fixed on dev but not deployed" is told by it. */
  mainRef: string;
}

export interface CodeContextRules {
  /** At least one app; an app absent here gets no case. */
  repos: Partial<Record<CodeContextApp, CodeContextRepo>>;
}

/** The mainRef an entry that leaves it out reads. */
export const CODE_CONTEXT_MAIN_REF = "origin/main";

/** A ref git takes as one argument and never as an option. */
const GIT_REF = /^(?!-)[A-Za-z0-9._/-]+$/;

/**
 * `clerk.codeContext`, read leniently: the rules, or null with why. Unlike
 * every other clerk key a malformed value is not a problem that refuses the
 * config: the feature is opt-in, and a typo in it must never stop a clerk
 * that files reports fine without it. Absent is null with no problem.
 */
export function clerkCodeContext(value: unknown): { rules: CodeContextRules | null; problem: string | null } {
  if (value === undefined) return { rules: null, problem: null };
  const off = (why: string) => ({ rules: null, problem: `'clerk.codeContext' ${why}; code context is off` });
  if (!isObject(value)) return off("must be an object with 'repos'");
  for (const key of Object.keys(value)) if (key !== "repos") return off(`has an unknown key '${key}'`);
  const repos = value.repos;
  if (!isObject(repos) || Object.keys(repos).length === 0) return off("'repos' must map 'pwa' and/or 'Backoffice' to a clone");
  const out: Partial<Record<CodeContextApp, CodeContextRepo>> = {};
  for (const [app, entry] of Object.entries(repos)) {
    if (!(CODE_CONTEXT_APPS as readonly string[]).includes(app)) return off(`'repos.${app}' is not an app; use ${CODE_CONTEXT_APPS.map((one) => `'${one}'`).join(" or ")}`);
    if (!isObject(entry)) return off(`'repos.${app}' must be an object with 'path' and 'ref'`);
    for (const key of Object.keys(entry)) if (!["path", "ref", "mainRef"].includes(key)) return off(`'repos.${app}' has an unknown key '${key}'`);
    if (!(typeof entry.path === "string" && entry.path.startsWith("/") && !/[\0\n]/.test(entry.path))) return off(`'repos.${app}.path' must be an absolute path to a clone`);
    if (!(typeof entry.ref === "string" && GIT_REF.test(entry.ref))) return off(`'repos.${app}.ref' must be a git ref such as 'origin/dev'`);
    if ("mainRef" in entry && !(typeof entry.mainRef === "string" && GIT_REF.test(entry.mainRef))) return off(`'repos.${app}.mainRef' must be a git ref such as 'origin/main'`);
    out[app as CodeContextApp] = { path: entry.path, ref: entry.ref, mainRef: typeof entry.mainRef === "string" ? entry.mainRef : CODE_CONTEXT_MAIN_REF };
  }
  return { rules: { repos: out }, problem: null };
}

/**
 * The clerk's report types (`clerk/plan.ts` `TYPES`), each mapped to itself:
 * the default `triage.issueTypes`, since clara's names are the OA project's
 * own. Spelled here rather than imported because this module is loaded by
 * scratch harnesses that copy it with only its leaf imports; the `satisfies`
 * makes a type added to the clerk a type error here.
 */
const DEFAULT_ISSUE_TYPES = { Error: "Error", Tarea: "Tarea" } as const satisfies Record<IssueType, IssueType>;
const TYPES = Object.keys(DEFAULT_ISSUE_TYPES) as IssueType[];

/** How a triager's `to-person` outcome writes to Jira. */
export type TriageJiraMode = "shadow" | "live";

/** A triager's Jira person path, every default filled in. */
export interface TriageJira {
  mode: TriageJiraMode;
  site: string;
  project: string;
  issueTypes: Record<IssueType, string>;
  /** The ticket every moved one is filed under; null or absent files them at the top level. */
  parent?: string | null;
}

/** A triager's rules, every default filled in. */
export interface TriageRules {
  autoReady: boolean;
  /** Null when the block has no `jira`: the to-person outcome moves nothing. */
  jira: TriageJira | null;
}

/**
 * What a verifier does with a verdict: `observe` records it, `report` also
 * comments it on the ticket, `act` also routes a fix or a revert.
 */
export const VERIFIER_MODES = ["observe", "report", "act"] as const;
export type VerifierMode = (typeof VERIFIER_MODES)[number];

/** Where a verifier learns a merge reached production. */
export const DEPLOY_SOURCES = ["vercel", "github-deployments"] as const;
export type DeploySource = (typeof DEPLOY_SOURCES)[number];

/**
 * The `verifier` keys that are rules — how it judges, not where it looks. The
 * dashboard's form edits exactly these (`editVerifier`); the production URL,
 * deploy source, Sentry project and language stay hand-edited. One list, so a
 * new rule is both validated and editable.
 */
export const VERIFIER_RULE_KEYS: readonly string[] = ["enabled", "windowHours", "checkIns", "trafficFloor", "revert", "follow", "mode"];

/**
 * What a verifier's window, check-ins and thresholds mean when the file leaves
 * them out, as felipearos/ralph#560 decided them: a merge is watched for a day
 * and looked at one, six and twenty-four hours after its deploy; a revert is
 * proposed only for an issue whose rate is five times its baseline and whose
 * impact reaches ten events or two distinct users (`verifier/verdict.ts` reads
 * the impact bar as either; `minEvents` has no default in the spec, so ten is
 * this file's choice).
 *
 * One constant beside the validator, the `CLERK_DEFAULTS` precedent, so the
 * gate and the apply cannot disagree about a window.
 */
export const VERIFIER_DEFAULTS = {
  // On unless the file says otherwise (#789): every verifier before the switch was on.
  enabled: true,
  windowHours: 24,
  checkIns: [1, 6, 24],
  // A quiet production says nothing about a change: without the floor, no
  // traffic would read as "no errors" and verify it.
  trafficFloor: true,
  revert: { rateFactor: 5, minEvents: 10, minUsers: 2 },
  follow: { loopPrs: true, humanPrs: true },
  // Observe only: reporting or acting is always a reviewed edit to the file.
  mode: "observe",
  // GitHub's own name for the environment a production deploy targets.
  environment: "production",
} as const;

/** A verifier's whole configuration, every default filled in. */
export interface VerifierRules {
  productionUrl: string;
  deploy: { source: "vercel"; project: string; team: string | null } | { source: "github-deployments"; environment: string };
  sentry: { org: string; project: string };
  /** False: the gate polls and re-reads its rules, and does nothing else (#789). */
  enabled: boolean;
  windowHours: number;
  checkIns: number[];
  trafficFloor: boolean;
  revert: { rateFactor: number; minEvents: number; minUsers: number };
  follow: { loopPrs: boolean; humanPrs: boolean };
  mode: VerifierMode;
  language: "en" | "es";
  /** Null when absent: act mode then only proposes its revert PR. */
  mergeCommand: string[] | null;
}

/**
 * The project's `verifier` block with every default applied, or null when
 * there is none. Read from a VALIDATED config only, which is why it can trust
 * the required keys: `verifierProblems` has already refused a block without them.
 */
export function verifierRules(config: ProjectConfig): VerifierRules | null {
  const block = config.verifier;
  if (block === undefined) return null;
  const deploy = block.deploy ?? {};
  return {
    productionUrl: block.productionUrl ?? "",
    deploy:
      deploy.source === "github-deployments"
        ? { source: "github-deployments", environment: deploy.environment ?? VERIFIER_DEFAULTS.environment }
        : { source: "vercel", project: deploy.project ?? "", team: deploy.team ?? null },
    sentry: { org: block.sentry?.org ?? "", project: block.sentry?.project ?? "" },
    enabled: block.enabled ?? VERIFIER_DEFAULTS.enabled,
    windowHours: block.windowHours ?? VERIFIER_DEFAULTS.windowHours,
    checkIns: [...(block.checkIns ?? VERIFIER_DEFAULTS.checkIns)],
    trafficFloor: block.trafficFloor ?? VERIFIER_DEFAULTS.trafficFloor,
    revert: { ...VERIFIER_DEFAULTS.revert, ...block.revert },
    follow: { ...VERIFIER_DEFAULTS.follow, ...block.follow },
    mode: block.mode ?? VERIFIER_DEFAULTS.mode,
    // A project that already said which language its PRs speak has said it for its tickets too.
    language: block.language ?? config.screenshots?.locale ?? "en",
    mergeCommand: block.mergeCommand === undefined ? null : [...block.mergeCommand],
  };
}

/** A Sentry organization or project slug. */
const SENTRY_SLUG = /^[a-z0-9_-]+$/;

const isPositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** An absolute http(s) URL with a host and no credentials in it. */
function isProductionUrl(value: unknown): boolean {
  if (typeof value !== "string" || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname !== "" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/** Every problem with a `verifier` block, in document order. `loops` comes in raw, as for `clerkProblems`. */
function verifierProblems(block: unknown, loops: unknown): string[] {
  const problems: string[] = [];
  const VERIFIER = "verifier" satisfies Role;
  const readable = Array.isArray(loops);
  const rostered = readable && loops.some((entry) => isObject(entry) && entry.role === VERIFIER);
  if (block === undefined) {
    if (rostered) {
      problems.push("'verifier' is required: a loop in 'loops' has the verifier role, and nothing says which production it watches or where it learns a deploy landed");
    }
    return problems;
  }
  if (readable && !rostered) problems.push("'verifier' needs a roster entry with the verifier role; no loop in 'loops' has it");
  if (!isObject(block)) return [...problems, "'verifier' must be an object of the verifier's production, deploy source, Sentry project and rules"];

  const known = ["productionUrl", "deploy", "sentry", "language", "mergeCommand", ...VERIFIER_RULE_KEYS];
  for (const key of Object.keys(block)) {
    if (!known.includes(key)) problems.push(`unknown key 'verifier.${key}'`);
  }
  if (!isProductionUrl(block.productionUrl)) {
    problems.push(`'verifier.productionUrl' must be an absolute http(s) URL such as 'https://loggd.app'; got ${JSON.stringify(block.productionUrl)}`);
  }

  const deploy = block.deploy;
  if (!isObject(deploy)) {
    problems.push(`'verifier.deploy' must be an object with a 'source' of 'vercel' or 'github-deployments'; got ${JSON.stringify(deploy)}`);
  } else if (!(DEPLOY_SOURCES as readonly unknown[]).includes(deploy.source)) {
    problems.push(`'verifier.deploy.source' must be 'vercel' or 'github-deployments'; got ${JSON.stringify(deploy.source)}`);
  } else {
    // Each source reads its own keys: the other's would read as configured and be ignored.
    const keys = deploy.source === "vercel" ? ["source", "project", "team"] : ["source", "environment"];
    for (const key of Object.keys(deploy)) {
      if (!keys.includes(key)) problems.push(`unknown key 'verifier.deploy.${key}'`);
    }
    if (deploy.source === "vercel" && !isText(deploy.project)) {
      problems.push(`'verifier.deploy.project' must be the Vercel project id or name; got ${JSON.stringify(deploy.project)}`);
    }
    for (const key of deploy.source === "vercel" ? ["team"] : ["environment"]) {
      if (key in deploy && !isText(deploy[key])) problems.push(`'verifier.deploy.${key}' must be a non-empty string; got ${JSON.stringify(deploy[key])}`);
    }
  }

  const sentry = block.sentry;
  if (!isObject(sentry)) {
    problems.push(`'verifier.sentry' must be an object with 'org' and 'project'; got ${JSON.stringify(sentry)}`);
  } else {
    for (const key of Object.keys(sentry)) {
      if (key !== "org" && key !== "project") problems.push(`unknown key 'verifier.sentry.${key}'`);
    }
    for (const key of ["org", "project"] as const) {
      if (!(typeof sentry[key] === "string" && SENTRY_SLUG.test(sentry[key] as string))) {
        problems.push(`'verifier.sentry.${key}' must be a Sentry slug (lowercase letters, digits, '-' or '_'); got ${JSON.stringify(sentry[key])}`);
      }
    }
  }

  const windowOk = !("windowHours" in block) || isPositive(block.windowHours);
  if (!windowOk) problems.push(`'verifier.windowHours' must be a positive number; got ${JSON.stringify(block.windowHours)}`);
  // A shorter window with the default check-ins would schedule a check-in
  // after the watch has ended, so a window below the last default asks for
  // check-ins of its own rather than having some silently dropped.
  const lastDefault = VERIFIER_DEFAULTS.checkIns[VERIFIER_DEFAULTS.checkIns.length - 1]!;
  if (!("checkIns" in block) && windowOk && "windowHours" in block && (block.windowHours as number) < lastDefault) {
    problems.push(
      `'verifier.checkIns' must be set when 'verifier.windowHours' is under ${lastDefault}: the default check-ins (${VERIFIER_DEFAULTS.checkIns.join(", ")} hours) pass a ${block.windowHours as number}-hour window`,
    );
  }
  if ("checkIns" in block) {
    const checkIns = block.checkIns;
    if (!Array.isArray(checkIns) || checkIns.length === 0) {
      problems.push(`'verifier.checkIns' must be a non-empty list of hours after the deploy; got ${JSON.stringify(checkIns)}`);
    } else {
      const window = windowOk ? ((block.windowHours as number | undefined) ?? VERIFIER_DEFAULTS.windowHours) : null;
      for (const [index, hours] of checkIns.entries()) {
        if (!isPositive(hours)) {
          problems.push(`'verifier.checkIns[${index}]' must be a positive number; got ${JSON.stringify(hours)}`);
          continue;
        }
        const previous = checkIns[index - 1];
        if (index > 0 && isPositive(previous) && hours <= previous) {
          problems.push(`'verifier.checkIns[${index}]' must come after ${previous}: check-ins are strictly ascending; got ${hours}`);
        }
        // A check-in past the window would look at a merge nobody follows any more.
        if (window !== null && hours > window) {
          problems.push(`'verifier.checkIns[${index}]' must be within the ${window}-hour window; got ${hours}`);
        }
      }
    }
  }

  if ("trafficFloor" in block && typeof block.trafficFloor !== "boolean") {
    problems.push(`'verifier.trafficFloor' must be true or false; got ${JSON.stringify(block.trafficFloor)}`);
  }

  if ("revert" in block) {
    const revert = block.revert;
    if (!isObject(revert)) {
      problems.push(`'verifier.revert' must be an object of 'rateFactor', 'minEvents' and 'minUsers'; got ${JSON.stringify(revert)}`);
    } else {
      for (const key of Object.keys(revert)) {
        if (!["rateFactor", "minEvents", "minUsers"].includes(key)) problems.push(`unknown key 'verifier.revert.${key}'`);
      }
      // A factor of 1 or less would read a flat or falling rate as a rise, and
      // `verifier/verdict.ts` skips the rate rule for one — so it is refused
      // here rather than accepted and silently ignored.
      if ("rateFactor" in revert && !(isPositive(revert.rateFactor) && revert.rateFactor > 1)) {
        problems.push(`'verifier.revert.rateFactor' must be a number greater than 1; got ${JSON.stringify(revert.rateFactor)}`);
      }
      for (const key of ["minEvents", "minUsers"] as const) {
        if (!(key in revert)) continue;
        const problem = wholeNumberProblem(revert[key], `verifier.revert.${key}`, 1);
        if (problem) problems.push(problem);
      }
    }
  }

  if ("follow" in block) {
    const follow = block.follow;
    if (!isObject(follow)) {
      problems.push(`'verifier.follow' must be an object of 'loopPrs' and 'humanPrs'; got ${JSON.stringify(follow)}`);
    } else {
      for (const key of Object.keys(follow)) {
        if (key !== "loopPrs" && key !== "humanPrs") problems.push(`unknown key 'verifier.follow.${key}'`);
      }
      for (const key of ["loopPrs", "humanPrs"] as const) {
        if (key in follow && typeof follow[key] !== "boolean") problems.push(`'verifier.follow.${key}' must be true or false; got ${JSON.stringify(follow[key])}`);
      }
      // Following nothing is a verifier that never verifies anything while reading as running.
      if (follow.loopPrs === false && follow.humanPrs === false) problems.push("'verifier.follow' must follow loop PRs, human PRs or both");
    }
  }

  if ("enabled" in block && typeof block.enabled !== "boolean") {
    problems.push(`'verifier.enabled' must be true or false; got ${JSON.stringify(block.enabled)}`);
  }
  if ("mode" in block && !(VERIFIER_MODES as readonly unknown[]).includes(block.mode)) {
    problems.push(`'verifier.mode' must be 'observe', 'report' or 'act'; got ${JSON.stringify(block.mode)}`);
  }
  if ("language" in block && block.language !== "en" && block.language !== "es") {
    problems.push(`'verifier.language' must be 'en' or 'es'; got ${JSON.stringify(block.language)}`);
  }
  if ("mergeCommand" in block) {
    const command = block.mergeCommand;
    if (!Array.isArray(command) || command.length === 0 || !command.every(isText)) {
      problems.push(`'verifier.mergeCommand' must be a non-empty list of non-empty gh arguments such as ["pr", "merge", "{pr}", "--squash"]; got ${JSON.stringify(command)}`);
    } else if (!command.some((arg) => arg.includes("{pr}"))) {
      // A command with no PR in it would merge whatever gh picks from the current branch.
      problems.push(`'verifier.mergeCommand' must name the PR with '{pr}' in one of its arguments; got ${JSON.stringify(command)}`);
    }
  }
  return problems;
}

/**
 * What a sentinel does with an issue that clears its bar: `observe` records
 * the ticket it would file, `file` files it.
 */
export const SENTINEL_MODES = ["observe", "file"] as const;
export type SentinelMode = (typeof SENTINEL_MODES)[number];

/**
 * The `sentinel` keys that are rules — how high its bar is and what it does
 * past it, not which reporter it reads. The dashboard's form edits exactly
 * these (`editSentinel`); the reporter and language stay hand-edited, the
 * `VERIFIER_RULE_KEYS` precedent.
 */
export const SENTINEL_RULE_KEYS = ["enabled", "lookbackHours", "minEvents", "minUsers", "maxPerDay", "mode"] as const;

/** The error reporters a sentinel reads; `reporter/` has an adapter for each. */
export const REPORTER_KINDS = ["sentry"] as const;
/** Named apart from `reporter/types.ts`'s `ReporterKind`, which also admits the test fake. */
export type SentinelReporterKind = (typeof REPORTER_KINDS)[number];

/**
 * What a sentinel's lookback, bar and daily cap mean when the file leaves them
 * out: a day of errors, an issue worth a ticket at ten events or two distinct
 * users (the verifier's revert bar, so the two roles agree on what matters),
 * and at most five tickets a day, so a noisy production cannot flood the
 * backlog overnight.
 *
 * One constant beside the validator, the `VERIFIER_DEFAULTS` precedent.
 */
export const SENTINEL_DEFAULTS = {
  // On unless the file says otherwise (#789), as the verifier's.
  enabled: true,
  lookbackHours: 24,
  minEvents: 10,
  minUsers: 2,
  maxPerDay: 5,
  // Observe only: filing tickets is always a reviewed edit to the file.
  mode: "observe",
} as const;

/** A sentinel's whole configuration, every default filled in. */
export interface SentinelRules {
  /** `environment` is null when absent: every environment is read. */
  reporter: { kind: SentinelReporterKind; org: string; project: string; environment: string | null };
  /** False: the gate polls and re-reads its rules, and does nothing else (#789). */
  enabled: boolean;
  lookbackHours: number;
  minEvents: number;
  minUsers: number;
  maxPerDay: number;
  mode: SentinelMode;
  language: "en" | "es";
}

/**
 * The project's `sentinel` block with every default applied, or null when
 * there is none. Read from a VALIDATED config only, which is why it can trust
 * the required keys: `sentinelProblems` has already refused a block without them.
 */
export function sentinelRules(config: ProjectConfig): SentinelRules | null {
  const block = config.sentinel;
  if (block === undefined) return null;
  const reporter = block.reporter ?? {};
  return {
    reporter: { kind: reporter.kind ?? "sentry", org: reporter.org ?? "", project: reporter.project ?? "", environment: reporter.environment ?? null },
    enabled: block.enabled ?? SENTINEL_DEFAULTS.enabled,
    lookbackHours: block.lookbackHours ?? SENTINEL_DEFAULTS.lookbackHours,
    minEvents: block.minEvents ?? SENTINEL_DEFAULTS.minEvents,
    minUsers: block.minUsers ?? SENTINEL_DEFAULTS.minUsers,
    maxPerDay: block.maxPerDay ?? SENTINEL_DEFAULTS.maxPerDay,
    mode: block.mode ?? SENTINEL_DEFAULTS.mode,
    // A project that already said which language its PRs speak has said it for its tickets too.
    language: block.language ?? config.screenshots?.locale ?? "en",
  };
}

/** Every problem with a `sentinel` block, in document order. `loops` comes in raw, as for `verifierProblems`. */
function sentinelProblems(block: unknown, loops: unknown): string[] {
  const problems: string[] = [];
  const SENTINEL = "sentinel" satisfies Role;
  const readable = Array.isArray(loops);
  const rostered = readable && loops.some((entry) => isObject(entry) && entry.role === SENTINEL);
  if (block === undefined) {
    if (rostered) problems.push("'sentinel' is required: a loop in 'loops' has the sentinel role, and nothing says which error reporter it reads");
    return problems;
  }
  if (readable && !rostered) problems.push("'sentinel' needs a roster entry with the sentinel role; no loop in 'loops' has it");
  if (!isObject(block)) return [...problems, "'sentinel' must be an object of the sentinel's reporter and rules"];

  // The rule keys from their one list, so the form's edit and this check cannot drift.
  const known: readonly string[] = ["reporter", ...SENTINEL_RULE_KEYS, "language"];
  for (const key of Object.keys(block)) {
    if (!known.includes(key)) problems.push(`unknown key 'sentinel.${key}'`);
  }
  const reporter = block.reporter;
  if (!isObject(reporter)) {
    problems.push(`'sentinel.reporter' must be an object with a 'kind' of 'sentry', an 'org' and a 'project'; got ${JSON.stringify(reporter)}`);
  } else {
    for (const key of Object.keys(reporter)) {
      if (!["kind", "org", "project", "environment"].includes(key)) problems.push(`unknown key 'sentinel.reporter.${key}'`);
    }
    if (!(REPORTER_KINDS as readonly unknown[]).includes(reporter.kind)) {
      problems.push(`'sentinel.reporter.kind' must be 'sentry'; got ${JSON.stringify(reporter.kind)}`);
    }
    for (const key of ["org", "project"]) {
      if (!(typeof reporter[key] === "string" && SENTRY_SLUG.test(reporter[key] as string))) {
        problems.push(`'sentinel.reporter.${key}' must be a Sentry slug (lowercase letters, digits, '-' or '_'); got ${JSON.stringify(reporter[key])}`);
      }
    }
    if ("environment" in reporter && !isText(reporter.environment)) {
      problems.push(`'sentinel.reporter.environment' must be a non-empty string; got ${JSON.stringify(reporter.environment)}`);
    }
  }
  if ("enabled" in block && typeof block.enabled !== "boolean") {
    problems.push(`'sentinel.enabled' must be true or false; got ${JSON.stringify(block.enabled)}`);
  }
  if ("lookbackHours" in block && !isPositive(block.lookbackHours)) {
    problems.push(`'sentinel.lookbackHours' must be a positive number; got ${JSON.stringify(block.lookbackHours)}`);
  }
  for (const key of ["minEvents", "minUsers", "maxPerDay"]) {
    if (!(key in block)) continue;
    const problem = wholeNumberProblem(block[key], `sentinel.${key}`, 1);
    if (problem !== null) problems.push(problem);
  }
  if ("mode" in block && !(SENTINEL_MODES as readonly unknown[]).includes(block.mode)) {
    problems.push(`'sentinel.mode' must be 'observe' or 'file'; got ${JSON.stringify(block.mode)}`);
  }
  if ("language" in block && block.language !== "en" && block.language !== "es") {
    problems.push(`'sentinel.language' must be 'en' or 'es'; got ${JSON.stringify(block.language)}`);
  }
  return problems;
}

/**
 * The project's `triage` block with the default applied. Unlike `clerkRules`
 * never null: a project with no block triages with the operator's approval
 * step, which is what every triager did before the block existed.
 */
export function triageRules(config: ProjectConfig): TriageRules {
  const block = config.triage;
  const jira: TriageJira | null =
    block?.jira === undefined
      ? null
      : {
          mode: block.jira,
          site: block.jiraSite ?? "",
          project: block.jiraProject ?? "",
          issueTypes: { ...DEFAULT_ISSUE_TYPES, ...block.issueTypes },
        };
  return { autoReady: block?.autoReady ?? false, jira };
}

/** Every problem with a `screenshots` block, in document order. */
export function screenshotsProblems(block: unknown): string[] {
  if (!isObject(block)) return ["'screenshots' must be an object with a 'viewport' and a 'serve' command"];
  const problems: string[] = [];
  const known = ["viewport", "serve", "login", "requireEnv", "dismiss", "locale"];
  for (const key of Object.keys(block)) {
    if (!known.includes(key)) problems.push(`unknown key 'screenshots.${key}'`);
  }
  if (block.viewport !== "phone" && block.viewport !== "desktop") {
    problems.push(`'screenshots.viewport' must be 'phone' or 'desktop'; got ${JSON.stringify(block.viewport)}`);
  }
  if (!(isText(block.serve) && !ONE_LINE_BREAK.test(block.serve) && block.serve.includes("{port}"))) {
    problems.push("'screenshots.serve' must be a one-line command with '{port}' where the port goes");
  }
  if ("login" in block && block.login !== "supabase" && block.login !== "none") {
    problems.push(`'screenshots.login' must be 'supabase' or 'none'; got ${JSON.stringify(block.login)}`);
  }
  if ("requireEnv" in block) {
    const fence = block.requireEnv;
    if (!isObject(fence) || !Object.entries(fence).every(([name, prefix]) => ENV_NAME.test(name) && isText(prefix))) {
      problems.push("'screenshots.requireEnv' must be an object from an environment variable name to the text its value must start with");
    }
  }
  if ("dismiss" in block && !(Array.isArray(block.dismiss) && block.dismiss.every((name) => isText(name) && !ONE_LINE_BREAK.test(name)))) {
    problems.push("'screenshots.dismiss' must be an array of button names");
  }
  if ("locale" in block && block.locale !== "en" && block.locale !== "es") {
    problems.push(`'screenshots.locale' must be 'en' or 'es'; got ${JSON.stringify(block.locale)}`);
  }
  return problems;
}

/** Every problem with a `worktreeSetup` list, in document order. */
export function worktreeSetupProblems(value: unknown): string[] {
  if (!Array.isArray(value)) return ["'worktreeSetup' must be an array of steps, each with a 'name' and a 'command'"];
  const problems: string[] = [];
  const known = ["name", "command", "timeoutSeconds", "installsDependencies"];
  const seen = new Set<string>();
  let total = 0;
  value.forEach((step, index) => {
    const at = `worktreeSetup[${index}]`;
    if (!isObject(step)) {
      problems.push(`'${at}' must be an object with a 'name' and a 'command'`);
      return;
    }
    for (const key of Object.keys(step)) {
      if (!known.includes(key)) problems.push(`unknown key '${at}.${key}'`);
    }
    if (!(typeof step.name === "string" && GATE_NAME.test(step.name))) {
      problems.push(`'${at}.name' must be lowercase kebab-case; got ${JSON.stringify(step.name)}`);
    } else if (seen.has(step.name)) {
      problems.push(`'${at}.name' '${step.name}' is a duplicate; every step needs its own name`);
    } else {
      seen.add(step.name);
    }
    if (!(isText(step.command) && !ONE_LINE_BREAK.test(step.command))) {
      problems.push(`'${at}.command' must be a one-line command`);
    }
    if ("timeoutSeconds" in step) {
      const limit = step.timeoutSeconds;
      if (!(Number.isInteger(limit) && (limit as number) >= 1 && (limit as number) <= WORKTREE_SETUP_MAX_SECONDS)) {
        problems.push(`'${at}.timeoutSeconds' must be a whole number of seconds from 1 to ${WORKTREE_SETUP_MAX_SECONDS}; got ${JSON.stringify(limit)}`);
      } else {
        total += limit as number;
      }
    } else {
      total += WORKTREE_SETUP_DEFAULT_SECONDS;
    }
    if ("installsDependencies" in step && typeof step.installsDependencies !== "boolean") {
      problems.push(`'${at}.installsDependencies' must be true or false; got ${JSON.stringify(step.installsDependencies)}`);
    }
  });
  // WHY a sum and not only a per-step cap: the dashboard runs every step inside
  // one Add agent / Create checkout request, and the server drops a request
  // idle for 255 s, so the whole setup must fit in that one request.
  if (total > WORKTREE_SETUP_MAX_SECONDS) {
    problems.push(
      `'worktreeSetup' may take at most ${WORKTREE_SETUP_MAX_SECONDS} s in all (every step's 'timeoutSeconds', ${WORKTREE_SETUP_DEFAULT_SECONDS} when unset), ` +
        `because the dashboard runs the steps inside one request and its server times out an idle request at 255 s; these add up to ${total} s`,
    );
  }
  return problems;
}

/** A valid `worktreeSetup` list with its defaults filled in. */
export function resolveWorktreeSetup(value: unknown): WorktreeSetupStep[] {
  if (!Array.isArray(value)) return [];
  return value.map((step: Record<string, unknown>) => ({
    name: step.name as string,
    command: step.command as string,
    timeoutSeconds: (step.timeoutSeconds as number | undefined) ?? WORKTREE_SETUP_DEFAULT_SECONDS,
    installsDependencies: (step.installsDependencies as boolean | undefined) ?? false,
  }));
}

/** A valid `screenshots` block with its defaults filled in. */
export function resolveScreenshots(block: Record<string, unknown>): ScreenshotsConfig {
  return {
    viewport: block.viewport as ScreenshotViewport,
    serve: block.serve as string,
    login: (block.login as ScreenshotsConfig["login"] | undefined) ?? "supabase",
    requireEnv: (block.requireEnv as Record<string, string> | undefined) ?? {},
    dismiss: (block.dismiss as string[] | undefined) ?? [],
    locale: (block.locale as ScreenshotsConfig["locale"] | undefined) ?? "en",
  };
}

/** Every problem with a `triage` block, in document order. */
function triageProblems(block: unknown): string[] {
  if (!isObject(block)) return ["'triage' must be an object of the triager's rules"];
  const problems: string[] = [];
  const known = ["autoReady", "jira", "jiraSite", "jiraProject", "issueTypes"];
  for (const key of Object.keys(block)) {
    if (!known.includes(key)) problems.push(`unknown key 'triage.${key}'`);
  }
  if ("autoReady" in block && typeof block.autoReady !== "boolean") {
    problems.push(`'triage.autoReady' must be true or false; got ${JSON.stringify(block.autoReady)}`);
  }
  if ("jira" in block) {
    if (block.jira !== "shadow" && block.jira !== "live") {
      problems.push(`'triage.jira' must be 'shadow' or 'live'; got ${JSON.stringify(block.jira)}`);
    }
    if (!(typeof block.jiraSite === "string" && JIRA_SITE.test(block.jiraSite))) {
      problems.push(`'triage.jiraSite' must be a host name such as 'example.atlassian.net'; got ${JSON.stringify(block.jiraSite)}`);
    }
    if (!(typeof block.jiraProject === "string" && JIRA_PROJECT.test(block.jiraProject))) {
      problems.push(`'triage.jiraProject' must be a Jira project key such as 'OA'; got ${JSON.stringify(block.jiraProject)}`);
    }
  } else {
    // A half-configured block must not look valid: a site with no mode moves
    // nothing, and whoever wrote it believes it does.
    for (const key of ["jiraSite", "jiraProject", "issueTypes"]) {
      if (key in block) problems.push(`'triage.${key}' needs 'triage.jira' ('shadow' or 'live'); without it nothing moves to Jira`);
    }
  }
  if ("issueTypes" in block) {
    const types = block.issueTypes;
    if (!isObject(types)) {
      problems.push(`'triage.issueTypes' must be an object from a report type (${TYPES.join(", ")}) to a Jira issue type; got ${JSON.stringify(types)}`);
    } else {
      for (const [key, value] of Object.entries(types)) {
        if (!(TYPES as readonly string[]).includes(key)) {
          problems.push(`unknown key 'triage.issueTypes.${key}': a report's type is one of ${TYPES.join(", ")}`);
        } else if (!(typeof value === "string" && value.trim() !== "")) {
          problems.push(`'triage.issueTypes.${key}' must be a Jira issue type name; got ${JSON.stringify(value)}`);
        }
      }
    }
  }
  return problems;
}

/** Every problem with an `appLabels` block: two distinct one-line label names. */
function appLabelsProblems(block: unknown): string[] {
  if (!isObject(block)) return ["'appLabels' must be an object with 'backoffice' and 'pwa' label names"];
  const problems: string[] = [];
  for (const key of Object.keys(block)) {
    if (key !== "backoffice" && key !== "pwa") problems.push(`unknown key 'appLabels.${key}'`);
  }
  for (const key of ["backoffice", "pwa"] as const) {
    const value = block[key];
    if (!(isText(value) && !ONE_LINE_BREAK.test(value))) problems.push(`'appLabels.${key}' must be a label name`);
  }
  if (isText(block.backoffice) && block.backoffice === block.pwa) problems.push("'appLabels.backoffice' and 'appLabels.pwa' must be different labels");
  return problems;
}

/**
 * Every problem with a `clerk` block, in document order. Called with
 * `undefined` when the file carries none, because a rostered clerk without one
 * has nowhere to read and nowhere to write.
 */
function clerkProblems(block: unknown, loops: unknown): string[] {
  const problems: string[] = [];
  const CLERK = "clerk" satisfies Role;
  const readable = Array.isArray(loops);
  const rostered = readable && loops.some((entry) => isObject(entry) && entry.role === CLERK);
  if (block === undefined) {
    if (rostered) {
      problems.push("'clerk' is required: a loop in 'loops' has the clerk role, and nothing says which channel it reads or where it files");
    }
    return problems;
  }
  if (readable && !rostered) problems.push("'clerk' needs a roster entry with the clerk role; no loop in 'loops' has it");
  if (!isObject(block)) return [...problems, "'clerk' must be an object of the clerk's channel, Jira project and rules"];

  // `codeContext` is known but never a problem: malformed, it is the
  // feature off (`clerkCodeContext`), never a clerk refused at startup.
  const known = ["mode", "pwaAgents", "holdOaMove", "channel", "canvas", "shadowCanvas", "operator", "dashboardUrl", "ignoreUsers", "prRepos", "jira", "kpiReport", "codeContext", ...NUMBER_KEYS];
  for (const key of Object.keys(block)) {
    if (!known.includes(key)) problems.push(`unknown key 'clerk.${key}'`);
  }
  if ("mode" in block && !(CLERK_MODES as readonly unknown[]).includes(block.mode)) {
    problems.push(`'clerk.mode' must be 'shadow', 'quiet' or 'live'; got ${JSON.stringify(block.mode)}`);
  }
  if ("holdOaMove" in block) {
    if (typeof block.holdOaMove !== "boolean") {
      problems.push(`'clerk.holdOaMove' must be true or false; got ${JSON.stringify(block.holdOaMove)}`);
    } else if (block.mode !== "live" && block.mode !== "quiet") {
      // Shadow moves nothing whatever the key says: it would read as a
      // switch it is not.
      problems.push("'clerk.holdOaMove' is only read in live or quiet mode, and shadow never moves a ticket; remove it, or set 'clerk.mode'");
    }
  }
  if ("pwaAgents" in block && typeof block.pwaAgents !== "boolean") {
    problems.push(`'clerk.pwaAgents' must be true or false; got ${JSON.stringify(block.pwaAgents)}`);
  }
  if (!(typeof block.channel === "string" && SLACK_CHANNEL.test(block.channel))) {
    problems.push(`'clerk.channel' must be a Slack channel id ('C…' or 'G…'); got ${JSON.stringify(block.channel)}`);
  }
  for (const key of ["canvas", "shadowCanvas"] as const) {
    if (key in block && !(typeof block[key] === "string" && SLACK_CANVAS.test(block[key] as string))) {
      problems.push(`'clerk.${key}' must be a Slack canvas id ('F…'); got ${JSON.stringify(block[key])}`);
    }
  }
  if ("operator" in block && !(typeof block.operator === "string" && SLACK_USER.test(block.operator))) {
    problems.push(`'clerk.operator' must be a Slack user id ('U…' or 'W…'); got ${JSON.stringify(block.operator)}`);
  }
  if ("ignoreUsers" in block) {
    const ignore = block.ignoreUsers;
    if (!Array.isArray(ignore)) {
      problems.push(`'clerk.ignoreUsers' must be a list of Slack user ids ('U…' or 'W…'); got ${JSON.stringify(ignore)}`);
    } else {
      for (const [index, id] of ignore.entries()) {
        if (!(typeof id === "string" && SLACK_USER.test(id))) {
          problems.push(`'clerk.ignoreUsers[${index}]' must be a Slack user id ('U…' or 'W…', from their Slack profile, Copy member ID); got ${JSON.stringify(id)}`);
        }
      }
    }
  }
  if ("prRepos" in block) {
    const repos = block.prRepos;
    if (!Array.isArray(repos) || !repos.every((repo) => typeof repo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))) {
      problems.push(`'clerk.prRepos' must be a list of GitHub repos such as 'example-org/backoffice'; got ${JSON.stringify(repos)}`);
    }
  }
  if ("dashboardUrl" in block && !isDashboardUrl(block.dashboardUrl)) {
    problems.push(`'clerk.dashboardUrl' must be an https URL such as 'https://example.vercel.app/p/project/intake'; got ${JSON.stringify(block.dashboardUrl)}`);
  }
  // One canvas for both would make the shadow week write the team's canvas,
  // which is the one thing shadow promises never to do.
  if (typeof block.canvas === "string" && block.canvas === block.shadowCanvas) {
    problems.push("'clerk.shadowCanvas' must not be 'clerk.canvas': shadow never writes the channel's canvas");
  }
  const jira = block.jira;
  if (!isObject(jira)) {
    problems.push("'clerk.jira' must be an object with 'site' and 'project'");
  } else {
    for (const key of Object.keys(jira)) {
      if (!["site", "project", "intakeProject", "storyPointsField", "statuses", "mergedStatus", "parent", "readyStatuses"].includes(key)) problems.push(`unknown key 'clerk.jira.${key}'`);
    }
    if (!(typeof jira.site === "string" && JIRA_SITE.test(jira.site))) {
      problems.push(`'clerk.jira.site' must be a host name such as 'example.atlassian.net'; got ${JSON.stringify(jira.site)}`);
    }
    if (!(typeof jira.project === "string" && JIRA_PROJECT.test(jira.project))) {
      problems.push(`'clerk.jira.project' must be a Jira project key such as 'OA'; got ${JSON.stringify(jira.project)}`);
    }
    problems.push(...clerkIntakeProblems(jira));
    // A live or quiet clerk files on the intake board and nowhere else (felipearos/ralph#466).
    if ((block.mode === "live" || block.mode === "quiet") && !("intakeProject" in jira)) {
      problems.push(`'clerk.jira.intakeProject' is required when 'clerk.mode' is '${block.mode}': nothing says which Jira intake board a report is filed on`);
    }
  }
  if ("kpiReport" in block) problems.push(...kpiReportProblems(block.kpiReport));
  for (const key of NUMBER_KEYS) {
    if (!(key in block)) continue;
    const problem = wholeNumberProblem(block[key], `clerk.${key}`, 1);
    if (problem !== null) {
      problems.push(problem);
      continue;
    }
    const value = block[key] as number;
    if (key === "rowCap" && value > CLERK_ROW_CAP_CEILING) {
      problems.push(`'clerk.rowCap' may be at most ${CLERK_ROW_CAP_CEILING}: Slack refuses a canvas table of more than 300 cells; got ${value}`);
    }
    if (key === "attachmentMaxMb" && value > CLERK_ATTACHMENT_CEILING_MB) {
      problems.push(`'clerk.attachmentMaxMb' may be at most ${CLERK_ATTACHMENT_CEILING_MB}: the Jira site refuses an attachment over 1 GB; got ${value}`);
    }
    if (key === "batchSize" && value > CLERK_BATCH_CEILING) {
      problems.push(`'clerk.batchSize' may be at most ${CLERK_BATCH_CEILING}; got ${value}`);
    }
  }
  // A join window as long as the settle window would let a report be handed
  // over and filed, and then an author's next message join it — a report
  // already processed, so that message would never be filed. Settling has to
  // outlast joining.
  const join = typeof block.joinMinutes === "number" ? block.joinMinutes : CLERK_DEFAULTS.joinMinutes;
  const settle = typeof block.settleMinutes === "number" ? block.settleMinutes : CLERK_DEFAULTS.settleMinutes;
  if (Number.isInteger(join) && Number.isInteger(settle) && join >= 1 && settle >= 1 && join >= settle) {
    problems.push(`'clerk.joinMinutes' (${join}) must be less than 'clerk.settleMinutes' (${settle}): a report must settle after its last message can no longer join it`);
  }
  return problems;
}

/**
 * The clerk's daily KPI DM (felipearos/ralph#453). A draft goes to the
 * operator alone, so the team sees nothing until the numbers have been read
 * by someone who can tell a wrong one; `send` is the reviewed edit that lets
 * it reach `recipients`, and shadow mode overrides even that.
 */
export interface KpiReportRules {
  mode: "draft" | "send";
  /** Slack user ids (`U…`/`W…`): the bot opens the DM itself, so a channel id from someone's own client is no use. */
  recipients: string[];
  /**
   * Slack channel ids (`C…` public, `G…` private) the report is also posted
   * in, as a top-level message, when it reaches `recipients`: `send` and a
   * live clerk, never a draft. The bot must be a member of each.
   */
  channels: string[];
  /** Local `HH:MM` in `timezone`: the report is sent at the first poll on or after it. */
  time: string;
  timezone: string;
  /** Monday to Friday only. */
  weekdays: boolean;
  /** A channel member with no report in this many days is listed as quiet. */
  quietDays: number;
  /**
   * Slack user ids (`U…`/`W…`) the report names nowhere: not in "Por persona",
   * "Señal y ruido" or "Participación". For people in the channel who are not
   * part of the pilot. Unlike `clerk.ignoreUsers`, their messages are still
   * reports, so the totals keep counting them.
   */
  exclude: string[];
}

export const KPI_REPORT_DEFAULTS: KpiReportRules = {
  mode: "draft",
  recipients: [],
  channels: [],
  time: "09:00",
  timezone: "America/Santiago",
  weekdays: true,
  quietDays: 7,
  exclude: [],
};

const KPI_REPORT_KEYS = ["mode", "recipients", "channels", "time", "timezone", "weekdays", "quietDays", "exclude"] as const;

/** A Slack DM channel id, as someone's own client shows a conversation: not one the bot can post to. */
const SLACK_DM = /^D[A-Z0-9]{6,}$/;

function kpiReportProblems(report: unknown): string[] {
  if (!isObject(report)) return [`'clerk.kpiReport' must be an object of the daily report's rules; got ${JSON.stringify(report)}`];
  const problems: string[] = [];
  for (const key of Object.keys(report)) {
    if (key === "team") {
      problems.push("unknown key 'clerk.kpiReport.team': the team is the intake channel's members, read from Slack; remove it");
    } else if (!(KPI_REPORT_KEYS as readonly string[]).includes(key)) problems.push(`unknown key 'clerk.kpiReport.${key}'`);
  }
  if ("mode" in report && report.mode !== "draft" && report.mode !== "send") {
    problems.push(`'clerk.kpiReport.mode' must be 'draft' or 'send'; got ${JSON.stringify(report.mode)}`);
  }
  if ("recipients" in report) {
    const recipients = report.recipients;
    if (!Array.isArray(recipients)) {
      problems.push(`'clerk.kpiReport.recipients' must be a list of Slack user ids ('U…'); got ${JSON.stringify(recipients)}`);
    } else {
      for (const [index, id] of recipients.entries()) {
        if (typeof id === "string" && SLACK_DM.test(id)) {
          problems.push(
            `'clerk.kpiReport.recipients[${index}]' is a DM channel id (${JSON.stringify(id)}), which the bot cannot post to; give the person's member id ('U…', from their Slack profile, Copy member ID) instead`,
          );
        } else if (!(typeof id === "string" && SLACK_USER.test(id))) {
          problems.push(`'clerk.kpiReport.recipients[${index}]' must be a Slack user id ('U…' or 'W…'); got ${JSON.stringify(id)}`);
        }
      }
    }
  }
  if ("channels" in report) {
    const channels = report.channels;
    if (!Array.isArray(channels)) {
      problems.push(`'clerk.kpiReport.channels' must be a list of Slack channel ids ('C…' or 'G…'); got ${JSON.stringify(channels)}`);
    } else {
      for (const [index, id] of channels.entries()) {
        if (typeof id === "string" && SLACK_DM.test(id)) {
          problems.push(
            `'clerk.kpiReport.channels[${index}]' is a DM channel id (${JSON.stringify(id)}), which the bot cannot post to; give a channel's id ('C…' or 'G…', from the channel's details) instead`,
          );
        } else if (!(typeof id === "string" && SLACK_CHANNEL.test(id))) {
          problems.push(`'clerk.kpiReport.channels[${index}]' must be a Slack channel id ('C…' or 'G…'); got ${JSON.stringify(id)}`);
        }
      }
    }
  }
  const mode = report.mode ?? KPI_REPORT_DEFAULTS.mode;
  // Channels alone are a valid audience: a report posted in a team channel needs no DM as well.
  const nonEmpty = (value: unknown): boolean => Array.isArray(value) && value.length > 0;
  if (mode === "send" && !nonEmpty(report.recipients) && !nonEmpty(report.channels)) {
    problems.push("'clerk.kpiReport.recipients' must name at least one Slack user id when 'clerk.kpiReport.mode' is 'send'");
  }
  if ("time" in report && !(typeof report.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(report.time))) {
    problems.push(`'clerk.kpiReport.time' must be a local time as HH:MM, such as '09:00'; got ${JSON.stringify(report.time)}`);
  }
  if ("timezone" in report && !(typeof report.timezone === "string" && validTimeZone(report.timezone))) {
    problems.push(`'clerk.kpiReport.timezone' must be an IANA time zone such as 'America/Santiago'; got ${JSON.stringify(report.timezone)}`);
  }
  if ("weekdays" in report && typeof report.weekdays !== "boolean") {
    problems.push(`'clerk.kpiReport.weekdays' must be true or false; got ${JSON.stringify(report.weekdays)}`);
  }
  if ("quietDays" in report) {
    const problem = wholeNumberProblem(report.quietDays, "clerk.kpiReport.quietDays", 1);
    if (problem !== null) problems.push(problem);
  }
  if ("exclude" in report) {
    const exclude = report.exclude;
    if (!Array.isArray(exclude)) {
      problems.push(`'clerk.kpiReport.exclude' must be a list of Slack user ids ('U…' or 'W…'); got ${JSON.stringify(exclude)}`);
    } else {
      for (const [index, id] of exclude.entries()) {
        if (!(typeof id === "string" && SLACK_USER.test(id))) {
          problems.push(`'clerk.kpiReport.exclude[${index}]' must be a Slack user id ('U…' or 'W…', from their Slack profile, Copy member ID); got ${JSON.stringify(id)}`);
        }
      }
    }
  }
  return problems;
}

/**
 * What a valid config leaves the clerk unable to do, as warnings rather than
 * problems: a missing setting turns one feature off and must never stop a
 * clerk at startup. Today one: a draft KPI report with no operator to send it
 * to, which is the report off (felipearos/ralph#453).
 */
export function clerkConfigWarnings(config: ProjectConfig): string[] {
  const rules = clerkRules(config);
  const report = rules?.kpiReport;
  if (rules == null || report == null || rules.operator !== null) return [];
  // A live clerk in send mode reaches the recipients and needs no operator.
  if (report.mode === "send" && rules.mode === "live") return [];
  return ["'clerk.kpiReport' is set but 'clerk.operator' is not, so the daily KPI report is off: until the clerk is live and the report switched to 'send', it goes to the operator alone; set 'clerk.operator' to your Slack user id ('U…')"];
}

function validTimeZone(zone: string): boolean {
  if (zone.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every problem with the intake board keys of a clerk's `jira` block
 * (felipearos/ralph#443). Each is optional in shadow; a live clerk needs
 * `intakeProject`, which `clerkProblems` checks.
 */
function clerkIntakeProblems(jira: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if ("intakeProject" in jira) {
    const intake = jira.intakeProject;
    if (!(typeof intake === "string" && JIRA_PROJECT.test(intake))) {
      problems.push(`'clerk.jira.intakeProject' must be a Jira project key in capitals such as 'OAI'; got ${JSON.stringify(intake)}`);
    } else if (intake === jira.project) {
      // A to-person ticket moves from the intake board to the person board:
      // one project for both would move a ticket onto itself.
      problems.push(`'clerk.jira.intakeProject' must not be 'clerk.jira.project' (${JSON.stringify(intake)}): confirmed tickets for a person move from the intake board to the person board`);
    }
  }
  if ("storyPointsField" in jira && !(typeof jira.storyPointsField === "string" && JIRA_CUSTOM_FIELD.test(jira.storyPointsField))) {
    problems.push(
      `'clerk.jira.storyPointsField' must be a Jira custom field id such as 'customfield_10016' (Jira's field list names it); got ${JSON.stringify(jira.storyPointsField)}`,
    );
  }
  if ("statuses" in jira) {
    const statuses = jira.statuses;
    if (!isObject(statuses)) {
      return [...problems, `'clerk.jira.statuses' must be an object of ${CLERK_STATUSES.join(", ")} to workflow status names; got ${JSON.stringify(statuses)}`];
    }
    for (const key of Object.keys(statuses)) {
      if (!(CLERK_STATUSES as readonly string[]).includes(key)) problems.push(`unknown key 'clerk.jira.statuses.${key}'`);
    }
    for (const key of CLERK_STATUSES) {
      if (!(key in statuses)) continue;
      const name = statuses[key];
      if (!(typeof name === "string" && name.trim() !== "" && !/[\r\n]/.test(name))) {
        problems.push(`'clerk.jira.statuses.${key}' must be a workflow status name on one line, as the intake board spells it; got ${JSON.stringify(name)}`);
      }
    }
    // Two roles on one status would make a ticket waiting for confirmation
    // read as confirmed, or a confirmed one as rejected.
    const named = { ...CLERK_JIRA_DEFAULTS.statuses, ...statuses } as Record<string, unknown>;
    for (const [index, key] of CLERK_STATUSES.entries()) {
      const twin = CLERK_STATUSES.slice(0, index).find((other) => named[other] === named[key]);
      if (twin !== undefined && typeof named[key] === "string") {
        problems.push(`'clerk.jira.statuses.${key}' must differ from 'clerk.jira.statuses.${twin}' (${JSON.stringify(named[key])}): each status means one step of the confirmation`);
      }
    }
  }
  if ("mergedStatus" in jira) {
    const merged = jira.mergedStatus;
    const named = { ...CLERK_JIRA_DEFAULTS.statuses, ...(isObject(jira.statuses) ? jira.statuses : {}) } as Record<string, unknown>;
    const twin = CLERK_STATUSES.find((key) => named[key] === merged);
    if (!(typeof merged === "string" && merged.trim() !== "" && !/[\r\n]/.test(merged))) {
      problems.push(`'clerk.jira.mergedStatus' must be a workflow status name on one line, as the intake board spells it; got ${JSON.stringify(merged)}`);
    } else if (twin !== undefined) {
      // A merge would then read as a confirmation step: "Movido" to the sweep,
      // or a ticket put back to wait for a person.
      problems.push(`'clerk.jira.mergedStatus' must differ from 'clerk.jira.statuses.${twin}' (${JSON.stringify(merged)}): a merge is not a step of the confirmation`);
    }
  }
  if ("readyStatuses" in jira) {
    const ready = jira.readyStatuses;
    if (!(Array.isArray(ready) && ready.every((name) => typeof name === "string" && name.trim() !== "" && !/[\r\n]/.test(name)))) {
      problems.push(`'clerk.jira.readyStatuses' must be a list of workflow status names on one line, as the team board spells them; got ${JSON.stringify(ready)}`);
    }
  }
  if ("parent" in jira) {
    const parent = jira.parent;
    if (!(typeof parent === "string" && /^[A-Z][A-Z0-9_]+-\d+$/.test(parent))) {
      problems.push(`'clerk.jira.parent' must be a Jira issue key such as 'OA-471'; got ${JSON.stringify(parent)}`);
    } else if (typeof jira.project === "string" && !parent.startsWith(`${jira.project}-`)) {
      // Jira files a ticket only under a parent in its own project: every move would drop it.
      problems.push(`'clerk.jira.parent' must be a ticket on 'clerk.jira.project' (${JSON.stringify(jira.project)}), where moved tickets are filed; got ${JSON.stringify(parent)}`);
    }
  }
  return problems;
}

/** The clerk's whole-number keys, each at least 1. */
const NUMBER_KEYS = ["settleMinutes", "joinMinutes", "canvasMinutes", "batchSize", "regressionDays", "rowCap", "attachmentMaxMb"] as const;

/**
 * What a `prMedic.branches` glob may not contain: the metacharacters whose
 * meaning differs between this harness's dialect and every other one an
 * operator has used. See `branches`' doc comment for why they are refused
 * rather than escaped.
 */
const OUTSIDE_GLOB_DIALECT = /[[\]{}()|!^$\\]/;

/**
 * Whether `glob` can match a branch under `<loop>/`.
 *
 * Structural rather than a probe against one sample branch name: `ralph/1*`
 * matches `ralph/123-x` and no probe path a validator could guess, so the
 * question is asked of the glob's FIRST segment, which is the only one that can
 * be the loop's prefix. A single-segment glob reaches below the top level only
 * when it is `**`, and a LEADING `**` spans into one, so both answer true here
 * rather than inside the segment translator — `**` is not a thing one segment
 * can be.
 */
function overlapsLoopPrefix(glob: string, loop: string): boolean {
  const [first, ...rest] = glob.split("/");
  if (first === "**") return true;
  if (rest.length === 0) return false;
  return segmentGlob(first as string).test(loop);
}

/**
 * One path segment's glob as a RegExp: `*` and `?` within the segment, and
 * nothing else — a segment cannot contain `/`, so it cannot be `**`.
 *
 * Translated here rather than through `executor-guard/diff-guard.ts`'s
 * `matchesGlob`, which is the same dialect and the obvious thing to import. Two
 * scratch harnesses — `ralph.test.ts` and `start.test.ts` — copy this module's
 * import closure in BY HAND and `cpSync` it FLAT into one directory, so a
 * nested `executor-guard/diff-guard.ts` needs an `mkdirSync` in each as well as
 * an entry; and that module cannot move to a shared leaf at the root, because it
 * is mounted into the executor's sandbox and may import nothing from the
 * harness. `start.sh`'s failure when an entry is missing is also a SILENT
 * fallback to the default poll interval rather than an error. One segment of
 * glob is not worth that. `project-config.test.ts` pins the two dialects
 * against each other, metacharacter by metacharacter, so the copy cannot drift.
 */
export function segmentGlob(segment: string): RegExp {
  return new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);
}

/** The problem with a loop name found at `where` (quoted, e.g. `'loops[2]'`), or null. */
function loopNameProblem(name: unknown, where: string): string | null {
  if (!(typeof name === "string" && LOOP_NAME.test(name))) {
    return `${where} must be one lowercase word (a-z, then a-z or 0-9); got ${typeof name === "string" ? `'${name}'` : JSON.stringify(name)}`;
  }
  if (name === "default") return `${where} is 'default', which names the fallback block in models.json and jav.json`;
  if (STAGE_HEADS.includes(name)) return `${where} is '${name}', which names a stage in models.json`;
  return null;
}

/**
 * Every problem with a `loops` value, in order. Empty means valid.
 *
 * An entry is a name or `{ "name", "role" }`, and the name rules are the same
 * for both. Names are unique across the whole roster, whatever the form or the
 * role: a name is a claim label, and two loops sharing one would share a claim.
 */
export function loopsProblems(loops: unknown): string[] {
  if (!Array.isArray(loops)) return ["'loops' must be an array of loop names"];
  if (loops.length === 0) return ["'loops' must name at least one loop"];
  const problems: string[] = [];
  const seen = new Set<string>();
  loops.forEach((entry, index) => {
    let name: unknown = entry;
    let where = `'loops[${index}]'`;
    if (isObject(entry)) {
      for (const key of Object.keys(entry)) {
        if (key !== "name" && key !== "role" && key !== "usageStop") problems.push(`unknown key 'loops[${index}].${key}'`);
      }
      if ("usageStop" in entry) problems.push(...usageStopProblems(entry.usageStop, `loops[${index}].usageStop`, true));
      if ("role" in entry && !isRole(entry.role)) {
        problems.push(`'loops[${index}].role' must be one of ${ROLES.join(", ")}; got ${JSON.stringify(entry.role)}`);
      }
      if (!("name" in entry)) {
        problems.push(`missing 'loops[${index}].name'`);
        return;
      }
      name = entry.name;
      where = `'loops[${index}].name'`;
    }
    const problem = loopNameProblem(name, where);
    if (problem !== null) {
      problems.push(problem);
    } else if (seen.has(name as string)) {
      problems.push(`${where} repeats '${name as string}'`);
    } else {
      seen.add(name as string);
    }
  });
  return problems;
}

/** A valid entry's name. */
export const loopEntryName = (entry: LoopEntry): string => (typeof entry === "string" ? entry : entry.name);

/** Valid `loops` entries with their roles resolved: a string, or an object without `role`, is a coder. */
export function rosterEntries(loops: readonly LoopEntry[]): RosterEntry[] {
  return loops.map((entry) =>
    typeof entry === "string"
      ? { name: entry, role: DEFAULT_ROLE }
      : {
          name: entry.name,
          role: entry.role ?? DEFAULT_ROLE,
          // Only when spelt, so a roster without stops reads as it always did.
          ...(entry.usageStop !== undefined ? { usageStop: entry.usageStop } : {}),
        },
  );
}

/** Parse and validate config text, or throw with every problem listed. */
export function parseProjectConfig(text: string, source = CONFIG_RELATIVE_PATH): ProjectConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ProjectConfigError(`${source} is not valid JSON: ${(error as Error).message}`);
  }
  const problems = validateProjectConfig(raw);
  if (problems.length > 0) {
    throw new ProjectConfigError(`${source} is invalid:\n  - ${problems.join("\n  - ")}`, problems);
  }
  const roster = rosterEntries((raw as { loops: LoopEntry[] }).loops);
  const spelt = raw as { journal: { dir: string }; learnings?: false | { file: string } };
  const learnings =
    spelt.learnings === false
      ? false
      : { file: spelt.learnings?.file ?? defaultLearningsFile(spelt.journal.dir) };
  return {
    ...(raw as object),
    loops: roster.map((entry) => entry.name),
    roster,
    merge: (raw as { merge?: "loop" | "human" }).merge ?? "loop",
    learnings,
    tracker: resolveTracker((raw as { tracker?: unknown }).tracker),
    ...(isObject((raw as { screenshots?: unknown }).screenshots)
      ? { screenshots: resolveScreenshots((raw as { screenshots: Record<string, unknown> }).screenshots) }
      : {}),
    worktreeSetup: resolveWorktreeSetup((raw as { worktreeSetup?: unknown }).worktreeSetup),
  } as ProjectConfig;
}

/** The project's config, read from `<root>/.ralph/config.json`. */
export function loadProjectConfig(root: string = projectRoot()): ProjectConfig {
  const path = join(root, CONFIG_RELATIVE_PATH);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ProjectConfigError(
      `cannot read ${path} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}); ` +
        "a project opts in to the harness by committing .ralph/config.json",
    );
  }
  return parseProjectConfig(text, path);
}

/** Single-quoted for `eval`, with the one escape that form needs. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const gateVar = (name: string): string => `RALPH_GATE_${name.toUpperCase().replace(/-/g, "_")}`;

/**
 * `export` lines for `ralph.sh` to `eval`. Lists that are shell words
 * (withheld names, refused paths) are space-separated — the validator forbids
 * whitespace inside them. `RALPH_ENV_CHECK` is a sequence of quoted words, for
 * `eval "argv=($RALPH_ENV_CHECK)"`. Check names may contain spaces, so they are
 * newline-separated. `RALPH_PROJECT_ID` keys this project's blocks in the
 * harness's `models.json` and `jav.json`; `RALPH_PROJECT_LOOPS` is its roster,
 * space-separated (a loop name is one word): names only, whatever their roles.
 * A loop's role is loop-specific, so `ralph.sh` asks for it with `--role-of`
 * once it knows which loop it is (`RALPH_LOOP_ROLE`).
 */
export function exportLines(config: ProjectConfig, root: string, id: string = currentProjectId(root, {})): string[] {
  const lines = [
    `export RALPH_PROJECT_ID=${shellQuote(id)}`,
    `export RALPH_PROJECT_LOOPS=${shellQuote(config.loops.join(" "))}`,
    `export RALPH_PROJECT_REPO=${shellQuote(config.repo)}`,
    `export RALPH_PROJECT_OWNER=${shellQuote(config.owner)}`,
    `export RALPH_BASE_BRANCH=${shellQuote(config.baseBranch)}`,
    `export RALPH_PROJECT_DISPLAY_NAME=${shellQuote(config.displayName)}`,
    `export RALPH_SECRETS_RUNNER=${shellQuote(config.secrets.runner)}`,
    `export RALPH_SECRETS_PROJECT=${shellQuote(config.secrets.runner === "doppler" ? config.secrets.project : "")}`,
    `export RALPH_SECRETS_CONFIG=${shellQuote(config.secrets.runner === "doppler" ? config.secrets.config : "")}`,
    `export RALPH_WITHHELD_SECRETS=${shellQuote(config.secrets.withhold.join(" "))}`,
    `export RALPH_REFUSE_FILES=${shellQuote(config.refuseFiles.join(" "))}`,
    `export RALPH_ENV_CHECK=${shellQuote(config.envCheck.map(shellQuote).join(" "))}`,
    `export RALPH_REQUIRED_CHECKS=${shellQuote(config.requiredChecks.join("\n"))}`,
    `export RALPH_MERGE=${shellQuote(config.merge)}`,
    // Empty when the project declares no method: every reader falls back to today's Mergify path.
    `export RALPH_MERGE_METHOD=${shellQuote(config.mergeMethod ?? "")}`,
    `export RALPH_PROMPT_FRAGMENT=${shellQuote(join(root, config.promptFragment))}`,
    `export RALPH_CODER_FRAGMENT=${shellQuote(join(root, config.coderFragment))}`,
    `export RALPH_PLAN=${shellQuote(config.plan)}`,
    `export RALPH_JOURNAL_DIR=${shellQuote(config.journal.dir)}`,
    // Empty means the harness repository's main, as before `journal.branch`.
    `export RALPH_JOURNAL_BRANCH=${shellQuote(config.journal.branch ?? "")}`,
    `export RALPH_LEARNINGS_FILE=${shellQuote(config.learnings === false ? "" : config.learnings.file)}`,
    `export RALPH_PROJECT_PLUGINS=${shellQuote((config.plugins ?? []).join(" "))}`,
    `export RALPH_TRACKER_KIND=${shellQuote(config.tracker.kind)}`,
    // The team or project key Linear and Jira identifiers start with; empty on GitHub.
    `export RALPH_TRACKER_KEY=${shellQuote(trackerKey(config.tracker) ?? "")}`,
  ];
  const gates = Object.keys(config.gates);
  for (const name of gates) lines.push(`export ${gateVar(name)}=${shellQuote(config.gates[name]!)}`);
  lines.push(`export RALPH_GATE_NAMES=${shellQuote(gates.join(" "))}`);
  return lines;
}

/** The key a keyed tracker prefixes its issue numbers with (`AND`, `OA`), or null on GitHub. */
export function trackerKey(tracker: TrackerConfig): string | null {
  if (tracker.kind === "linear") return tracker.team;
  if (tracker.kind === "jira") return tracker.project;
  if (tracker.kind === "local") return tracker.key;
  return null;
}

/** The config text committed at `ref`, read with `git show` in the project. */
export function readProjectConfigAt(root: string, ref: string): string {
  try {
    return execFileSync("git", ["show", `${ref}:${CONFIG_RELATIVE_PATH}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim().split("\n")[0];
    throw new ProjectConfigError(`cannot read ${CONFIG_RELATIVE_PATH} at ${ref} in ${root}${stderr ? ` (${stderr})` : ""}`);
  }
}

/**
 * The config file with its roster edited: `name` appended, or removed. The
 * result is validated as a whole, so a name the roster rules refuse, a repeat,
 * an unknown role or an emptied roster throws with every problem. Formatted as
 * `JSON.stringify(…, null, 2)`, keys in the file's order.
 *
 * An added coder is written as a plain name, like every loop before roles; a
 * loop in any other role as `{ "name", "role" }`. The other entries keep the
 * form the file gave them.
 */
export function editRoster(
  text: string,
  edit: { add: string; role?: string } | { remove: string },
  source = CONFIG_RELATIVE_PATH,
): string {
  const current = parseProjectConfig(text, source);
  const raw = JSON.parse(text) as Record<string, unknown>;
  const entries = raw.loops as LoopEntry[];
  let loops: unknown[];
  if ("add" in edit) {
    const role = edit.role ?? DEFAULT_ROLE;
    loops = [...entries, role === DEFAULT_ROLE ? edit.add : { name: edit.add, role }];
  } else {
    if (!current.loops.includes(edit.remove)) {
      throw new ProjectConfigError(`'${edit.remove}' is not one of this project's loops (${current.loops.join(", ")})`);
    }
    loops = entries.filter((entry) => loopEntryName(entry) !== edit.remove);
  }
  const next = `${JSON.stringify({ ...raw, loops }, null, 2)}\n`;
  parseProjectConfig(next, source);
  return next;
}

/**
 * The config file with its `verifier` rules replaced by `rules`. The block's
 * production, deploy and Sentry settings are kept as the file has them — the
 * form never sends them, and a key outside the rules is refused rather than
 * written, so a form cannot repoint a verifier at another production. A rule
 * the old block held and `rules` omits is dropped: absent means the default,
 * so the caller sends every rule it wants written. Validated as a whole, like
 * `editRoster`, so every `verifierProblems` message throws at once.
 */
export function editVerifier(text: string, rules: unknown, source = CONFIG_RELATIVE_PATH): string {
  parseProjectConfig(text, source);
  if (!isObject(rules)) throw new ProjectConfigError(`the verifier rules must be an object; got ${JSON.stringify(rules)}`);
  const refused = Object.keys(rules).filter((key) => !VERIFIER_RULE_KEYS.includes(key));
  if (refused.length > 0) {
    throw new ProjectConfigError(
      `the verifier rules may only set ${VERIFIER_RULE_KEYS.join(", ")}; refused ${refused.map((key) => `'${key}'`).join(", ")}`,
    );
  }
  const raw = JSON.parse(text) as Record<string, unknown>;
  const current = isObject(raw.verifier) ? raw.verifier : {};
  const kept = Object.fromEntries(Object.entries(current).filter(([key]) => !VERIFIER_RULE_KEYS.includes(key)));
  const next = `${JSON.stringify({ ...raw, verifier: { ...kept, ...rules } }, null, 2)}\n`;
  parseProjectConfig(next, source);
  return next;
}

/**
 * The config file with its `sentinel` rules replaced by `rules`, the
 * `editVerifier` shape: the reporter and language are kept as the file has
 * them, a key outside the rules is refused rather than written (so a form
 * cannot repoint a sentinel at another Sentry project), and a rule `rules`
 * omits is dropped, because absent means the default. A file with no block
 * gets one from the rules alone, which the whole-file read then refuses with
 * `sentinelProblems`' message: rules are not a reporter.
 */
export function editSentinel(text: string, rules: unknown, source = CONFIG_RELATIVE_PATH): string {
  parseProjectConfig(text, source);
  if (!isObject(rules)) throw new ProjectConfigError(`the sentinel rules must be an object; got ${JSON.stringify(rules)}`);
  const ruleKeys: readonly string[] = SENTINEL_RULE_KEYS;
  const refused = Object.keys(rules).filter((key) => !ruleKeys.includes(key));
  if (refused.length > 0) {
    throw new ProjectConfigError(
      `the sentinel rules may only set ${ruleKeys.join(", ")}; refused ${refused.map((key) => `'${key}'`).join(", ")}`,
    );
  }
  const raw = JSON.parse(text) as Record<string, unknown>;
  const current = isObject(raw.sentinel) ? raw.sentinel : {};
  const kept = Object.fromEntries(Object.entries(current).filter(([key]) => !ruleKeys.includes(key)));
  const next = `${JSON.stringify({ ...raw, sentinel: { ...kept, ...rules } }, null, 2)}\n`;
  parseProjectConfig(next, source);
  return next;
}

/**
 * The keys that decide what a hand-off must pass (#692): the local gate
 * commands, the CI checks required green, and the files whose presence
 * refuses startup. The Settings page's Gates form edits exactly these, and
 * `settings-form-parity.test.ts` fails when the schema gains a key nobody
 * has classified, so a new gate-related key cannot silently miss the form.
 */
export const GATE_EDIT_KEYS: readonly string[] = ["gates", "requiredChecks", "refuseFiles"];

/**
 * The steps a new agent worktree runs after `git worktree add`. Kept out of
 * `GATE_EDIT_KEYS`: they decide how a checkout is prepared, not what a
 * hand-off must pass, and that list is pinned to the Gates form.
 */
export const WORKTREE_SETUP_EDIT_KEYS: readonly string[] = ["worktreeSetup"];

/**
 * The project keys the dashboard's Settings form may edit. Nothing else: the
 * repo, owner and secrets decide what a loop can reach, so a form that could
 * rewrite them would be a way round reviewing that change by hand. The gate
 * and worktree setup keys are editable because the change still lands only
 * as a config PR a person merges, and the strict read below judges the whole
 * file first.
 */
export const PROJECT_EDIT_KEYS: readonly string[] = ["displayName", "baseBranch", ...GATE_EDIT_KEYS, ...WORKTREE_SETUP_EDIT_KEYS];

/**
 * The config file with any of `PROJECT_EDIT_KEYS` set from `values`; a gate
 * key's value replaces the whole list or object, as `worktreeSetup`'s
 * replaces its whole list (`[]` included). Every other key keeps its value
 * and place: the rest of these keys are required (`TOP_LEVEL_KEYS` lists
 * them), so a valid file already holds them and spreading the edit over it
 * moves nothing; `worktreeSetup` is optional, and a file without it gains it
 * at the end. Validated as a whole, like `editVerifier`, so a blank name,
 * a bad branch, a gate name that is not kebab-case or a refused path that
 * climbs out throws with the read's message, every problem at once. Whether
 * the branch exists on the remote, or a required check was ever reported, is
 * the caller's question, not this file's.
 */
export function editProject(text: string, values: unknown, source = CONFIG_RELATIVE_PATH): string {
  parseProjectConfig(text, source);
  if (!isObject(values)) throw new ProjectConfigError(`the project values must be an object; got ${JSON.stringify(values)}`);
  const keys = Object.keys(values);
  // An empty edit would open a config PR that changes nothing.
  if (keys.length === 0) throw new ProjectConfigError(`the project values must set ${PROJECT_EDIT_KEYS.join(" or ")}; got {}`);
  const refused = keys.filter((key) => !PROJECT_EDIT_KEYS.includes(key));
  if (refused.length > 0) {
    throw new ProjectConfigError(
      `the project values may only set ${PROJECT_EDIT_KEYS.join(", ")}; refused ${refused.map((key) => `'${key}'`).join(", ")}`,
    );
  }
  const raw = JSON.parse(text) as Record<string, unknown>;
  const next = `${JSON.stringify({ ...raw, ...values }, null, 2)}\n`;
  parseProjectConfig(next, source);
  return next;
}

function main(argv: string[]): number {
  const mode = argv[0];
  const atIndex = argv.indexOf("--at");
  const ref = atIndex === -1 ? null : argv[atIndex + 1];
  const roleIndex = argv.indexOf("--role");
  const role = roleIndex === -1 ? null : argv[roleIndex + 1];
  const edit = mode === "--add-loop" || mode === "--remove-loop" ? argv[1] : undefined;
  // The rules come on stdin as JSON: the dashboard's form sends a whole object.
  const setVerifier = mode === "--set-verifier";
  const setSentinel = mode === "--set-sentinel";
  // Likewise the Settings form's project values and gates.
  const setProject = mode === "--set-project";
  // Three questions about one loop, answered from the same roster lookup: which
  // role it holds, which intake gate that role declares, and how long that
  // gate waits between polls. The callers ask rather than derive, so the
  // descriptor in `roles.ts` stays the only place a role says what differs.
  // `--poll-seconds-of` alone means the roster's FIRST loop, which is exactly
  // what `ralph.sh` starts when neither the environment nor `.ralph/loop-name`
  // names one. Without that, `start.sh` would hand a default-named triager a
  // coder's interval — the one case the per-role interval exists for.
  const pollOf = mode === "--poll-seconds-of";
  const roleOf = mode === "--role-of" || mode === "--intake-gate-of" || pollOf ? argv[1] : undefined;
  const usage = (): number => {
    console.error(
      "usage: bun project-config.ts --json [--at <ref>] | --export | --role-of <loop> | " +
        "--intake-gate-of <loop> | --poll-seconds-of [loop] | " +
        `--add-loop <name> [--role <${ROLES.join("|")}>] [--at <ref>] | --remove-loop <name> [--at <ref>] | ` +
        "--set-verifier [--at <ref>] (rules JSON on stdin) | --set-sentinel [--at <ref>] (rules JSON on stdin) | " +
        "--set-project [--at <ref>] (values JSON on stdin)",
    );
    return 2;
  };
  if (mode !== "--json" && mode !== "--export" && edit === undefined && roleOf === undefined && !pollOf && !setVerifier && !setSentinel && !setProject) return usage();
  if (ref === undefined || (ref !== null && (mode === "--export" || roleOf !== undefined))) return usage();
  if ((edit !== undefined && edit.startsWith("--")) || (roleOf !== undefined && roleOf.startsWith("--"))) return usage();
  if (role === undefined || (role !== null && (mode !== "--add-loop" || role.startsWith("--")))) return usage();
  const root = projectRoot();
  try {
    if (ref !== null || edit !== undefined || setVerifier || setSentinel || setProject) {
      const source = ref === null ? join(root, CONFIG_RELATIVE_PATH) : `${ref}:${CONFIG_RELATIVE_PATH}`;
      const text = ref === null ? readFileSync(source, "utf8") : readProjectConfigAt(root, ref);
      if (setVerifier) {
        process.stdout.write(editVerifier(text, JSON.parse(readFileSync(0, "utf8")), source));
      } else if (setSentinel) {
        process.stdout.write(editSentinel(text, JSON.parse(readFileSync(0, "utf8")), source));
      } else if (setProject) {
        process.stdout.write(editProject(text, JSON.parse(readFileSync(0, "utf8")), source));
      } else if (edit === undefined) {
        console.log(JSON.stringify(parseProjectConfig(text, source), null, 2));
      } else {
        const change = mode === "--add-loop" ? { add: edit, ...(role === null ? {} : { role }) } : { remove: edit };
        process.stdout.write(editRoster(text, change, source));
      }
      return 0;
    }
  } catch (error) {
    console.error(`project-config: ${(error as Error).message}`);
    return 1;
  }
  let config: ProjectConfig;
  try {
    config = loadProjectConfig(root);
  } catch (error) {
    console.error(`project-config: ${(error as Error).message}`);
    return 1;
  }
  if (mode === "--json") {
    console.log(JSON.stringify(config, null, 2));
    return 0;
  }
  if (roleOf !== undefined || pollOf) {
    const named = roleOf === undefined || roleOf === "" ? (config.roster[0]?.name ?? "") : roleOf;
    const entry = config.roster.find((candidate) => candidate.name === named);
    if (entry === undefined) {
      console.error(`project-config: '${named}' is not one of this project's loops (${config.loops.join(", ")})`);
      return 1;
    }
    const descriptor = roleDescriptor(entry.role);
    console.log(
      mode === "--intake-gate-of"
        ? descriptor.intakeGate
        : mode === "--poll-seconds-of"
          ? String(descriptor.pollSeconds)
          : entry.role,
    );
    return 0;
  }
  let id: string;
  try {
    id = currentProjectId(root);
  } catch (error) {
    console.error(`project-config: ${(error as Error).message}`);
    return 1;
  }
  console.log(exportLines(config, root, id).join("\n"));
  return 0;
}

if (import.meta.main) {
  // exitCode, not exit(): see models.ts — exiting at once truncates piped stdout.
  process.exitCode = main(process.argv.slice(2));
}
