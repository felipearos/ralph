# Software Factory — operating the backlog loop

Software Factory runs autonomous Claude Code loops against a project's backlog. Its
harness is called Ralph: the supervisor is `ralph.sh`, the settings are `RALPH_*`, and
each project keeps its config in `.ralph/`.

Ralph works one backlog item per iteration. The harness is one shared checkout
(`RALPH_HOME`, conventionally `~/ralph`) that runs against any project worktree
(`RALPH_PROJECT`, the git toplevel of the directory you launch it from). The
project opts in by committing `.ralph/config.json` plus its prompt fragments;
the harness never carries project-specific knowledge.

[prompt.md](prompt.md) owns the agent's generic behaviour, the project's
fragments own its local rules, scripts own execution, and GitHub owns the
backlog. This guide covers install, per-project setup, observation, recovery,
and the boundaries an operator must preserve.

## Install

```bash
git clone git@github.com:felipearos/software-factory.git ~/ralph
cd ~/ralph && bun install
```

Every command below is run from **inside a project worktree** and names the
harness by path. Update the harness with `git -C ~/ralph pull --ff-only` when no
loop is mid-iteration; a supervisor warns (but still starts) when the harness is
behind its `origin/main`, and refuses when the project worktree is behind its
base branch.

## Per-project setup

A project commits a `.ralph/` directory. [examples/.ralph/](examples/.ralph/)
is a starting point; Loggd's is the reference (`fixtures/loggd/.ralph/` mirrors
it for the render test).

```text
.ralph/config.json   what the harness needs to know (validated strictly)
.ralph/prompt.md     project guidance spliced into the orchestrator prompt
.ralph/coder.md      project conventions spliced into the executor rails
.ralph/plan.md       scope fences: never-pick issues, parent closure exceptions
```

and ignores per-worktree state:

```gitignore
.ralph/logs/
.ralph/loop-name
.ralph/control/
```

(`.ralph/control/` also ignores itself with its own `.gitignore`, so a project
that commits `.ralph/` never commits a pending operator command.)

`.ralph/config.json` (Loggd's values):

```json
{
  "repo": "felipearos/loggd",
  "owner": "felipearosr",
  "baseBranch": "main",
  "displayName": "Loggd",
  "secrets": { "runner": "doppler", "project": "loggd-web", "config": "dev",
    "withhold": ["PRODUCTION_MIGRATIONS_DATABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SELF_HOSTED_RUNNER_GH_PAT", "BUILDKITE_AGENT_TOKEN", "BUILDKITE_API_TOKEN", "BUILDKITE_OPERATOR_TOKEN", "RENOVATE_TOKEN"] },
  "refuseFiles": [".env.local"],
  "envCheck": ["bun", "--no-env-file", "scripts/check-loop-env.ts"],
  "requiredChecks": ["buildkite/loggd", "Vercel"],
  "gates": { "test": "bun run test", "typecheck": "bun run typecheck", "build": "bun run build" },
  "promptFragment": ".ralph/prompt.md",
  "coderFragment": ".ralph/coder.md",
  "plan": ".ralph/plan.md",
  "journal": { "dir": "journal/loggd" }
}
```

| Field | Meaning |
| --- | --- |
| `repo`, `owner` | GitHub repository and the login claims are assigned to |
| `baseBranch` | every freshness check and base read is against `origin/<baseBranch>` |
| `displayName` | used in journal commit subjects |
| `secrets.runner` | `doppler` (explicit `project`/`config` scope), `dotenv` (a `file` on the host; see "Environment") or `none` |
| `secrets.withhold` | names stripped from every child after injection — a deny list |
| `refuseFiles` | files whose presence refuses startup (they would shadow the env) |
| `envCheck` | argv run inside the project, under the injected env, before every child; `[]` for none |
| `requiredChecks`, `gates` | the project's merge checks and local gate commands |
| `merge` | optional; `loop` (default) or `human`. With `human` the loop never merges: a green PR with no open thread is handed to a person (`tracker.ts handoff`: claim off, `ready-for-agent` off, `<loop>-done` on ticket and PR, the ticket moved to `tracker.states.review` when named), and the orchestrator is denied `gh pr merge`. A person takes `<loop>-done` off the PR to hand it back |
| `configChanges` | optional; `commit` (default) or `pr`. How the dashboard's Sentinel and Verifier sheets save a rules edit: `commit` pushes the validated config straight onto `baseBranch` as a fast-forward (and opens a config PR instead when that push is refused — a protected branch, a race, the network); `pr` always opens a config PR. Roster and Settings edits are PRs either way |
| `relayEvalPatches` | optional; `false` (default) or `true`. Off: a trial's patch is read on the host only — the bridge pushes no patch and the remote Evals tab offers no Patch link. On: the bridge pushes the newest trials' patches (each cut at 256 KiB, 768 KiB in all; older trials beyond that open only locally) through the scrubber to the hosted store, and the remote page opens them. Turning it off withdraws them only when the bridge next reads the key (minutes while the bridge runs); it does not purge the store. The same flag decides whether the Test set's snapshot carries each case's curation `reason` and `notes` (#856); off, the remote Test set shows titles, tags and grader kinds only. For a project whose code may leave the host |
| `evalSuggestionWeights` | optional; an object overriding the Evals Suggestions ranker's weights (#858): any of `blocked`, `parked`, `reverted`, `reviewRounds`, `doctor`, `slow`, `finishedByPerson`, plus the thresholds `reviewRoundsThreshold` (default 2 reviews) and `slowHours` (default 24), each a number >= 0. A key left out keeps the default; an unknown key is refused |
| `evalsNoiseFloor` | optional; `{ arms?, staleShare? }`. The test set's noise-floor run (#859): `arms` is how many identical live arms it runs, an integer from 2 to 6 (default 3); `staleShare` is the share of the floor's cases that may be added or retired before the floor no longer describes the set, above 0 and at most 1 (default 0.2). A noise-floor plan always runs the whole set, with no repeats |
| `evalsSaturation` | optional; `{ runs? }`. Saturated test-set cases (#860): `runs` is N, how many newest set runs in a row every arm must pass a case in before the Test set screen flags it saturated, an integer from 1 to 20 (default 3) |
| `evalsGuardrails` | optional; `{ maxCostRise?, minTokenCut? }`. The guardrail verdict's thresholds (#871): `maxCostRise` is how much more a quality proposal may cost than the baseline, a number from 0 to 10 (default 0.15, +15%); `minTokenCut` is how far a cost proposal must cut tokens, a number above 0 and below 1 (default 0.10, −10%) |
| `evalsImprover` | optional; `{ size?, failed?, autoMerge? }`. The improver's recommended run (#873): `size` is the most cases it takes, an integer from 1 to 200 (default 12); `failed` is whether the source run's failed cases go in first, a boolean (default true). `autoMerge` (#875) is a boolean, default off, and not wired to anything: a person merges every PR the improver opens |
| `promptFragment`, `coderFragment`, `plan` | project-relative paths |
| `journal.dir` | where this project's journal entries live in the harness repo |
| `journal.branch` | optional: publish this project's journal and project learnings to this branch of the project's own repo instead (see [The journal](#the-journal)) |
| `loops` | the roster: each entry a loop name (a coder) or `{ "name": "tria", "role": "triager" }` — see [GitHub side](#github-side) |
| `plugins` | optional; plugins to turn on, by name (e.g. `["orca"]`). Off by default — see [Plugins](#plugins) |
| `executorGuard` | optional; `{ "refuse": [...], "requireTargets": [...] }` — project commands the executor may not run at all, or only with file targets, on top of the built-in ones (see [Delegated code generation](#delegated-code-generation)) |
| `ciDoctor` | optional, and only on a roster that names a `ci-doctor`; `{ "fixScope": [...], "neverTouch": [...], "pollSeconds": 300, "windowHours": 72, "autoRevert": true, "testTimeoutCeilingMs": 30000, "hookTimeoutCeilingMs": 120000, "retry": { "perCandidate": 1, "perDay": 6 } }` — every key optional and defaulted by the harness. `retry` may be lowered, never raised (see [The CI doctor](#the-ci-doctor)) |
| `prMedic` | optional, and required once the roster names a `pr-medic`; `{ "branches": ["felipearosr/*"], "quietMinutes": 15, "maxPushes": 3 }`. `branches` says whose pull requests the medic may touch and has no default — a glob reaching a roster loop's own `<loop>/` branches, or one outside the harness's `*`/`?`/`**` dialect, is refused. The other two are bounded here and defaulted by the medic's own tickets (see [The PR medic](#the-pr-medic)) |
| `clerk` | optional, and required once the roster names a `clerk`; `{ "mode": "shadow", "channel": "C…", "canvas": "F…", "shadowCanvas": "F…", "operator": "U…", "dashboardUrl": "https://…/p/<project>/intake", "ignoreUsers": ["U…"], "jira": { "site": "example.atlassian.net", "project": "OA", "intakeProject": "OAI" }, "settleMinutes": 10, "joinMinutes": 3, "canvasMinutes": 15, "batchSize": 20, "regressionDays": 30, "rowCap": 32, "attachmentMaxMb": 100 }`. `channel` and `jira` have no default; `jira.intakeProject` is the Jira intake board a live clerk files on and reads its duplicate candidates from (required in `live` and `quiet`; see [Slack intake on a Jira board](#slack-intake-on-a-jira-board)) and `jira.project` the person board a confirmed ticket moves to; `operator` is the Slack user a canvas the clerk has to create is shared with; `ignoreUsers` (optional, Slack `U…`/`W…` ids, empty by default) are the team members whose messages are never reports (see [The clerk](#the-clerk)); `prRepos` (optional, `owner/name` repos, default `example-org/acme-backoffice` and `example-org/acme-pwa`, empty for none) are the app repos whose PRs the intake page links when one names a ticket's key; `dashboardUrl` (optional, https) is the intake page the canvas links to on a `Ver todo el backlog:` line, left out when absent (see `dashboard/README.md`, "The intake page"); `mode` defaults to `shadow`, which writes nothing to Slack or Jira, and `quiet` writes Jira as live does and nothing the team sees in Slack (see [Quiet mode](#quiet-mode)); `holdOaMove` (live or quiet; default true in quiet, false in live) keeps a confirmed to-person ticket on the intake board instead of creating it on `jira.project`; `pwaAgents` (optional, default false) says an agent project works the pwa repo, so a `pwa` report the session judges `agent` is not forced to a person; the plan validator and the clerk's prompt both read it; the numbers default to the values shown, `rowCap` may not exceed 32, `batchSize` 50 and `attachmentMaxMb` (the largest report file attached to a ticket, in MB) 1024 (see [The clerk](#the-clerk) and [Report files on the ticket](#report-files-on-the-ticket)) |
| `appLabels` | optional, and required beside a `clerk` and for a triager on a Linear or Jira tracker; `{ "backoffice": "<label>", "pwa": "<label>" }`. The Slack intake's two app labels on the tracker: the clerk files each ticket under its app's label, and the rules that send a report to a person (both apps, or the pwa app with no agent project) read them. Not a harness default, because they are one deployment's label names; a keyed triager without them is refused at preflight, and a plan applied without them sends the report to a person. |
| `verifier` | optional, and required once the roster names a `verifier` (and refused when it names none); `{ "productionUrl": "https://…", "deploy": { "source": "vercel" \| "github-deployments", … }, "sentry": { "org": "…", "project": "…" }, "windowHours": 24, "checkIns": [1, 6, 24], "trafficFloor": true, "revert": { "rateFactor": 5, "minEvents": 10, "minUsers": 2 }, "follow": { "loopPrs": true, "humanPrs": true }, "mode": "observe" }`, plus optional `language` and `mergeCommand`, and `enabled` (default `true`; `false` switches the verifier off while its gate keeps polling). `productionUrl`, `deploy` and `sentry` have no default (see [The verifier](#the-verifier)) |
| `sentinel` | optional, and required once the roster names a `sentinel` (and refused when it names none); `{ "reporter": { "kind": "sentry", "org": "…", "project": "…", "environment": "production" }, "lookbackHours": 24, "minEvents": 10, "minUsers": 2, "maxPerDay": 5, "mode": "observe" }`, plus optional `language`, and `enabled` (default `true`; `false` switches the sentinel off while its gate keeps polling). `reporter.kind`, `reporter.org` and `reporter.project` have no default; `reporter.environment` is optional, and absent reads every environment (see [The sentinel](#the-sentinel)) |
| `worktreeSetup` | optional; the ordered steps a new agent worktree runs right after `git worktree add`, e.g. `[{ "name": "install", "command": "bun install --frozen-lockfile", "timeoutSeconds": 120, "installsDependencies": true }]`. `name` is kebab-case and unique, `command` one line; `timeoutSeconds` (1–150, default 120) and `installsDependencies` (default false) are optional. Every step's limit, defaults included, may sum to at most 150 s: the dashboard runs the steps inside the Add agent / Create checkout request, alongside its fetch, roster edit, push and PR, and its server times out an idle request at 255 s. Absent means `[]`, and a worktree is made exactly as before. Add agent and Create checkout run the steps in the new worktree, with the main checkout's path in their environment, so a step can copy an untracked env file from it (`dashboard/README.md` names the variable); the first step that fails or times out stops the rest and keeps the worktree, and the agent's page has Rerun setup. With an `installsDependencies` step, the readiness checklist's dependencies item reads that step's recorded result (`.ralph/logs/worktree-setup.json` in the worktree) instead of looking for `node_modules` (see `dashboard/README.md`) |

Unknown keys are refused, not ignored. Check a config with
`bun ~/ralph/project-config.ts --json`.

`displayName`, `baseBranch`, `gates`, `requiredChecks`, `refuseFiles` and
`worktreeSetup` are the keys the dashboard's Settings page may change.
`--set-project` reads a JSON object on stdin that sets any of them (a gate
key's value replaces the whole object or list, and `worktreeSetup`'s the whole
list, `[]` included), nothing else, and prints the whole config, validated, ready to
commit; the Settings page runs it to open a config pull request
(`ralph-roster/project-settings-*`):

```bash
echo '{ "baseBranch": "dev" }' |
  bun ~/ralph/project-config.ts --set-project --at origin/main
```

A loop reads the config once, at start: after the change merges, restart the
project's loops (for a new base branch, stop each, check out the new base in
its worktree, start it). The sentinel's and the verifier's rules are the
exception: their gates read them from `origin/<baseBranch>` every poll (see
those sections).

Fragments are split into sections with `<!-- ralph:section NAME -->` markers;
the harness templates place each section with a `{{PROJECT_PROMPT_NAME}}` /
`{{PROJECT_CODER_NAME}}` placeholder (text before the first marker fills
`{{PROJECT_PROMPT}}`). A section the template does not place is refused rather
than silently dropped. `bun ~/ralph/models.ts --render-prompt ~/ralph/prompt.md`
prints the fully rendered prompt for the project you are standing in.

One fragment carries every role's guidance, namespaced by a prefix the role
declares: `TRIAGER_*` sections are the triager's, `CI_DOCTOR_*` the doctor's,
and unprefixed sections are the coder's. A render walks past the sections
another role owns, so adding a triager's guidance cannot break a coder's
prompt — while each role still refuses its own unplaced sections, and a
template that places another role's section is refused outright. The refusal
is therefore per role, not absolute: a section under a prefix no loop on the
roster holds reaches no model and nothing says so, because the render that
would refuse it never runs. Each role
also names the template it renders (`prompt.md` for a coder, `prompts/<role>.md`
otherwise): `--render-prompt --role triager` renders that one, and the
supervisor passes nothing but the role.

Five parts of the prompt are generated from `loops` rather than written out, so
they name the project's own roster ([`roster-prompt.ts`](roster-prompt.ts)): the
"Who you are" section, §1's `git ls-remote` branch globs, and §5.3's provenance
lines, head-branch globs and `<Loop>` capitalisation example. The "Who you are"
block lists the **coders**, because it tells the reader who its peers are at
taking tickets; the other four list **every loop on the roster whatever its
role**, because they tell the reader whose branch, whose `-wip` and whose
provenance line are not theirs to touch. So a triager joining the roster does
change a coder's prompt — in those four lists and nowhere else, which
`prompt-render.test.ts` holds it to. How many LINES move is a different
question: the provenance list wraps, so a long enough roster spills it onto
further lines and shifts the paragraphs after it down.


### Linear and Jira projects

A project's tickets may live in GitHub issues (the default), one Linear team, or
one Jira project (felipearos/ralph#330). Pull requests, checks and branches stay
on GitHub whatever the tracker; only the tickets move.

**Connect it from the dashboard.** In the project's setup form, the Tracker
section takes the token (a Linear personal API key, or a Jira site, account
email and API token), tests it, and lists what it can see. Pick the team or
project, the state a claim moves to and the state a finished ticket moves to
(preselected to `In Progress` and `Done` when the tracker has them), and an
optional scope label. **Save connection** stores the token on this machine; the
`tracker` block goes into `.ralph/config.json` through the setup PR:

```json
"tracker": { "kind": "linear", "team": "AND", "workspace": "exampleorg", "scopeLabel": "acme-backoffice" }
"tracker": { "kind": "jira", "site": "example.atlassian.net", "project": "OA", "states": { "claimed": "En curso", "done": "Listo" } }
```

A third keyed kind, `local`, keeps a trial sandbox's tickets in one JSON file on
the host (felipearos/ralph#527): `{ "kind": "local", "key": "SBX", "file":
"/abs/path/tickets.json" }`. It needs no credential, `file` must be absolute
(every `tracker.ts` call runs from its caller's directory), and it takes no
`scopeLabel`. `seedLocalTracker` in `tracker/local.ts` writes a ticket into it.
The dashboard's connector never offers it.

`states` defaults to `{ "claimed": "In Progress", "done": "Done" }`. A third,
`canceled`, has no default and is only worth spelling when a ticket routed
elsewhere should not land in the state the two above name: on Linear the
adapter finds the team's own `canceled`-type state unaided, whatever it is
called, and on Jira — which has no cancelled status type — a cancel falls back
to the `done` state rather than leaving the ticket open. A fourth, `review`,
also undefaulted, is where a ticket handed to a person goes on a
`merge: "human"` project (`For Review` on the backoffice's Linear team); a
workflow without one leaves the ticket where the claim put it.
`scopeLabel`, when set, narrows every listing to the issues carrying it: one
Linear team often holds several repositories' tickets, and without it a loop
would take a sibling repo's ready work.

**The credential** is `$XDG_CONFIG_HOME/ralph/trackers/<project-id>.json` (else
`~/.config/ralph/trackers/…`), mode 0600, never in the repo. A file other users
can read is refused. The orchestrator's rails deny reading the directory; the
session reaches the tracker only through `bun "$RALPH_HOME/tracker.ts"`, which
loads the file itself. With no credential, preflight refuses to start (pointing
at the dashboard), and a running loop's gate waits, naming why, until the
project is connected again; it never halts over it.

**Filing a ticket.** `bun tracker.ts create --title <text> (--body <text> |
--body-file <path|->) [--label <name>]...` opens one issue through the same
door, on whichever tracker the project uses; use it instead of
`gh issue create`. It makes any missing label first and opens nothing when a
label cannot be made, then prints `<ref>\t<url>` on one line.

**Ticket numbers stay integers.** The project is pinned to one team or project,
so `AND-184` is ticket 184: branches are `<loop>/184-…`, the lease is 184, the
spec file is `spec-184.md`. `tracker.ts ref 184` prints the tracker's spelling.
In a Linear or Jira body only `<KEY>-n` is a ticket reference (`## Parent`,
`## Blocked by`, `plan.md`'s fences); `#73` there is a GitHub pull request. A
reference with another key is ignored with a warning. The tracker's native
parent and "blocks" relations count as `## Parent` and `## Blocked by`.

**Claims.** A claim adds `<loop>-wip` and moves the ticket to the claimed state;
finishing moves it to the done state, removes every `-wip` and adds
`<loop>-done`; a stuck ticket gets `<loop>-blocked` and keeps its state. A
failed state move is a warning: the label is the fence. The tracker cannot see
GitHub, so an open PR fences its ticket when its branch is `<loop>/<n>-…` or its
body names `<KEY>-n` outside code, and the PR body carries `tracker.ts pr-ref <n>`'s line
(`Ticket: AND-184 <link>`) instead of `Closes #184`, which would close an
unrelated GitHub issue. With `--criteria` it also prints the ticket's
`## Acceptance criteria` section, every ticket reference in it quoted as code,
so a criterion naming a sibling ticket neither closes nor fences it.

**Roles.** Coder loops and the triager run on Linear or Jira. There the triager
does the Slack intake only (#396): an open `slack-intake` report in scope with
no outcome label is either rewritten into an agent brief and labelled
`agent-proposed` (`ready-for-agent` with `triage.autoReady: true` in
`.ralph/config.json`), or recorded as a person's with a one-line Spanish
reason. A person's report is moved to Jira by the triager's intake gate
([`triage/gate.ts`](triage/gate.ts), #397), never by the model: with
`triage.jira: "live"` (plus `jiraSite`, `jiraProject` and an optional
`issueTypes` map from `Error`/`Tarea`) it files the Jira ticket with clara's
fields, the reason and links back, comments `Pasa al equipo: OA-n`, adds
`moved-to-jira` and cancels the Linear issue, each step re-runnable after a
crash; `"shadow"` writes one `Se crearía OA-? con: …` comment and the label
and makes no Jira call. Reports routed in shadow stay open with the label, and
switching to live does not re-send them: close them by hand. Only one
triager's gate hands off at a time (a lock in git's common directory). `RALPH_CLERK_JIRA_TOKEN` is a gate-only secret of the
triager, checked at preflight only when live, and a denied Jira call stops the
loop with the remedy. Its plan is applied through the tracker interface
([`triage/keyed.ts`](triage/keyed.ts)), and a report with a `Prioridad: Highest`
line, `por-decidir`, both app labels, or the pwa label outside a pwa project is
always a person's (the labels are the project's `appLabels`; a keyed triager
without them is refused at preflight). The ci-doctor still creates issues past what the interface
carries, so the config refuses it on such a project, and findings skip filing a
ticket.

### Screenshots of a UI change

A loop whose diff changes what a screen draws photographs each screen it
touches, as the base draws it and as its head does, looks at both itself
before the PR, and puts them side by side in the PR body
([`ui-shots.ts`](ui-shots.ts)). A person reviewing then sees the change
instead of imagining it from JSX, and a broken layout is caught by the loop
rather than by them. A project opts in with a `screenshots` block:

```json
"screenshots": {
  "viewport": "phone",
  "serve": "node ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port {port} --strictPort",
  "requireEnv": { "VITE_SUPABASE_URL": "https://example-ref.supabase.co" },
  "dismiss": ["Ahora no"],
  "locale": "es"
}
```

`viewport` is the size the project's users hold it at: `phone` (393×852 at 2×,
an iPhone 15, with its safe areas emulated and its Dynamic Island drawn over
the shot, for the PWA) or `desktop` (1440×900, for the backoffice). The
browser's locale follows `locale` (`es-CL` or `en-US`). `serve`
runs in a throwaway worktree at the photographed commit, with the project's
`node_modules` hard-linked in (Vite will not serve fonts through a symlink).
`login` is `supabase` (the default: a password sign-in, injected as the session
supabase-js keeps in localStorage) or `none`. `requireEnv` is checked before
the server starts, so a swapped credential file cannot point a loop's dev
server at production. `dismiss` names buttons clicked when showing, before each
shot: a welcome tour that covers the page. `locale` is the PR section's
language.

**The credential** is `$XDG_CONFIG_HOME/ralph/screenshots/<project-id>.env`
(else `~/.config/ralph/screenshots/…`), mode 0600, never in the repo:
`SHOTS_EMAIL` and `SHOTS_PASSWORD` are the test account, every
other `KEY=value` line goes to the dev server's environment. The orchestrator's
rails deny the directory. Without the file, or without a chromium in
Playwright's cache, `ui-shots.ts status` says why and the loop notes in the PR
that it took none; it never blocks a ticket over it.

A route reaches a state no URL does with steps after it, `|`-separated, run
before its shot: `click:<name>`, `fill:<label>=<value>`, `press:<key>`,
`wait:<text>`, `eval:<js>` — `"/|click:Abrir menú lateral|click:Almacenamiento"`.
A failed step is reported, and so is a page that shows a password field: a
login under the route's own URL is still a login.

`publish <pr>` commits the PNGs to the repository's `ralph-screenshots` branch
through the GitHub API, under `pr-<n>/<stamp>/`, and links them from the PR
body, so the PR's own diff carries no images and a private repository's images
show to anyone who can read the PR. Delete the branch whenever it grows; an
old PR's images go with it.

## Roles

Each loop on the roster holds a **role** ([`roles.ts`](roles.ts)): `coder`,
`triager`, `ci-doctor`, `pr-medic`, `clerk`, `verifier` or `sentinel`. The role is the one
place a loop's behaviour is declared — which stages it runs, which prompt it renders, what its intake asks,
which preflight checks apply, which labels it needs and which verdicts it may
end on. No decision reads the role from the environment: `RALPH_LOOP_ROLE` is
exported FROM the roster and never read as the source of truth, so a hand-run
command asks the same questions the supervisor does.

### The roster

The roster is `loops` in the project's committed `.ralph/config.json`, required
and non-empty. An entry takes either form:

```json
"loops": ["ralph", "rafa", { "name": "tria", "role": "triager" },
          { "name": "doc", "role": "ci-doctor" }, { "name": "nova" }]
```

A plain name is a **coder**, exactly as before roles existed; any other role is
written as an object. `role` may be left out and defaults to `coder`, so `nova`
above is a coder too. Names are one lowercase word (`a-z`, then `a-z` or `0-9`)
and unique across both forms and every role; `default` and the stage heads
`orchestrator`, `executor`, `mapper` and `review` are reserved and refused as
loop names. Every claim fence reads every name whatever its role, so a
triager's `tria-wip` keeps coders off an issue and a coder's `-wip` keeps the
triager off.

```bash
bun ~/ralph/project-config.ts --json             # each loop's role, under `roster`
bun ~/ralph/project-config.ts --role-of tria     # one loop's role
bun ~/ralph/project-config.ts --add-loop tria --role triager
```

`--add-loop` without `--role` writes a bare string rather than an object, so a
roster of coders stays spelled the way it always was.

### What each role is

| | `coder` | `triager` | `ci-doctor` | `pr-medic` | `clerk` | `verifier` | `sentinel` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Does | takes a ready ticket off the frontier, builds it and shepherds its pull request to merge | reads untriaged issues and makes them ready for a coder, or says why not | watches the base branch's CI and diagnoses, retries or fixes what breaks it | takes a red run on one of the operator's pull requests and gets it back to green | files the settled reports of one Slack channel as Linear issues, and keeps the channel's canvas in step | follows merged pull requests into production and verifies each against its ticket | watches the error reporter and files diagnosed `ready-for-human` tickets for new or regressed production errors |
| Never does | triages nothing: applies no difficulty label and promotes nothing | writes no code, opens no pull request, waits for no CI | takes nothing off the frontier | merges nothing, and touches an agent loop's own branch only to adopt the red pull request of a loop that is unattended, handing it back when that loop returns | writes nothing from the session: it only classifies, and code makes every Slack and Linear write | writes no code and opens no pull request from the session: act mode's revert is the gate's | writes no code, never writes to Sentry and never labels `ready-for-agent`; the session makes no tracker write — code does |
| Stages | all six | `orchestrator`, `mapper`, `review.spec` | all six | all six | `orchestrator`, `code-context` | `orchestrator` | `orchestrator` |
| Intake gate | `frontier-gate.ts` | `frontier-gate.ts` | `ci-doctor/gate.ts` | `pr-medic/gate.ts` | `clerk/gate.ts` | `verifier/gate.ts` | `sentinel/gate.ts` |
| Frontier bucket | READY NOW | the triage buckets | none — a case lease, then the issue by number | none — a red operator pull request, or an unattended loop's adopted one, claimed with `-wip` on the PR | none — settled reports in its Slack channel | none — a due check-in of a watch, leased | none — a qualifying reporter issue, leased |
| Prompt | [`prompt.md`](prompt.md) | [`prompts/triager.md`](prompts/triager.md) | [`prompts/ci-doctor.md`](prompts/ci-doctor.md) | [`prompts/pr-medic.md`](prompts/pr-medic.md) | [`prompts/clerk.md`](prompts/clerk.md) | [`prompts/verifier.md`](prompts/verifier.md) | [`prompts/sentinel.md`](prompts/sentinel.md) |
| Fragment prefix | none (unprefixed) | `TRIAGER` | `CI_DOCTOR` | `PR_MEDIC` | `CLERK` | `VERIFIER` | `SENTINEL` |
| Poll interval | 300s | 600s | 300s | 300s | 300s | 300s | 300s |
| Phases | yes | no | yes | yes | no | no | no |
| Host lease | yes | no | yes | yes | no | no | no |
| Worktree invariant | none | `clean-detached` | none | none | `clean-detached` | `clean-detached` | `clean-detached` |
| Jav-routed | yes | no | no | no | no | no | no |
| Sigils | all eight | `DONE`, `ALL_BLOCKED`, `RETRY_LATER`, `NEEDS_TRIAGE` | all but `COMPLETE` | all but `COMPLETE` | `DONE`, `ALL_BLOCKED`, `RETRY_LATER`, `NEEDS_TRIAGE` | `DONE`, `ALL_BLOCKED`, `RETRY_LATER`, `NEEDS_TRIAGE` | `DONE`, `ALL_BLOCKED`, `RETRY_LATER`, `NEEDS_TRIAGE` |
| Labels beyond the triple | none | the seven triage labels, plus the project's Jav difficulty labels | `ci-health`, `priority:urgent` | none — its triple goes on the pull request | none | `following`, `verified`, `unexercised`, `inconclusive`, `needs-human` | `ready-for-human` |

The five stages are `orchestrator`, `executor`, `mapper`, `review.standards`
and `review.spec`. The eight sigils are `DONE`, `ALL_BLOCKED`, `COMPLETE`,
`NEEDS_TRIAGE`, `RETRY_LATER`, `AWAIT_PR`, `AWAIT_HOST` and `PHASE`. The seven
triage labels are `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`, `spec` and `duplicate`. Every loop also needs its
own `<loop>-wip`, `<loop>-blocked` and `<loop>-done` whatever its role. The
behaviours in the last four rows are the ones the supervisor used to hold for a
coder alone; [GitHub side](#github-side) describes what each of them does.

### The prompt a role renders

[Per-project setup](#per-project-setup) covers the templates, the fragment
prefixes and how a section reaches a placeholder. One thing it does not say:
there is no fallback. A role's template is a descriptor value, and an
unreadable one is an error rather than some other role's template quietly
rendered in its place.

```bash
bun ~/ralph/models.ts --render-prompt --role triager
```

### Stages and the lineup

A role declares WHICH stages it runs, so a block written for a triager names
three and is refused for naming a fourth, while the `default` blocks stay
complete over all five because every role falls back to them. A project's
`@<role>` block is the default for every loop in that role.
[Models and harnesses](#models-and-harnesses) has the resolution order and the
rest.

### Preflight

Which checks run is the role's answer, and a dropped check is not run at all
rather than left out of the report; a role may also add to the labels
`loop-labels` requires. [Preflight and frontier](#preflight-and-frontier) has
the per-role lists. Either form of the question answers with this loop's whole
label set:

```bash
RALPH_LOOP_NAME=tria bun ~/ralph/preflight.ts --labels
bun ~/ralph/preflight.ts --labels --loop tria --role triager   # before it is rostered
```

### The triager's guardrails

- **Read-only on code.** A triager writes no code, edits no worktree, runs no
  gate, opens no pull request and never waits for CI. The fence is its
  `clean-detached` invariant rather than a sandbox: a violation saves the diff
  against the base ref to `.ralph/logs/<role>-violation-<ts>-<pid>.patch`,
  detaches before resetting so a branch it wrongly created is abandoned rather
  than rewritten, pushes a `role-invariant` notification and carries on. It is
  a repair, so the evidence survives it.
- **Writes only through `triage-apply.ts`.** It runs no `gh issue edit`,
  `create` or `close` to carry out a decision: it writes the decision to
  `.ralph/logs/triage-plan-<unit>.json` and hands it over to be validated,
  simulated, ordered, paced and replayed, and a refusal makes no writes at all.
  [Applying a triage decision](#applying-a-triage-decision) has the rules the
  tool holds.
- **It promotes and closes on its own authority.** No person approves a
  promotion to `ready-for-agent` and no person confirms a close. What the
  authority costs is evidence: a close carries `done-in` or `duplicate-of`, and
  a close without it, or of a spec, a claimed issue or one with an open pull
  request, is refused.
- **It decides a product question only from a cited documented rule** — a
  quote that resolves at `origin/<baseBranch>` and is named in a comment on the
  issue, never the working tree and never precedent in the code. With no such
  rule the issue goes to `ready-for-human` instead.
- **A migration alone is not `ready-for-human`** where the project's
  `TRIAGER_READINESS` section gives its coders a safe-migration path
  (felipearos/ralph#324): then only an evidently destructive or data change — a
  drop, a rename, a tightened constraint, a backfill — goes to a person, and an
  additive schema change is an ordinary ticket. A project whose section is
  stricter, or says nothing about migrations, keeps today's behaviour: an
  unstated path is no path, and every migration is a person's.
- **It applies exactly one difficulty label per ticket**, from the project's
  Jav vocabulary (`bun ~/ralph/jav.ts --json`, never invented), saying why for
  each; when unsure it routes hard, and it never removes a difficulty label it
  did not set. That one is its prompt's rule rather than the validator's, which
  fences the vocabulary and not the count.
- **It may clear a coder's block, bounded, and only through `unblock`.**
  `remove-label` on any `*-blocked` is still refused outright, so every guard
  hangs off the one op that is allowed to: the ticket must be ready, non-spec,
  unheld, free of an open PR, carrying exactly one coder's block whose newest
  record is an ordinary `blocked:` — not a migration, not a flaky test, not
  unreadable — and the **same plan must change the spec or the route**, since
  an unblock alone hands the identical ticket back. At most twice per ticket
  ever and once per `RALPH_TRIAGE_UNBLOCK_DAYS` (7), counted off the
  `op=unblock` markers on the ticket itself so the bound survives a fresh
  checkout — read in full for the op, where the Rescue bucket below sees only
  the census's comment tail, so the bucket may offer a ticket the op then
  refuses.
- **It sets its own `<loop>-blocked`** by hand on the stuck path, with
  `gh issue edit` — the one pair of writes no plan carries. That one is its own
  label, and the restriction above is about a coder's.

### What is live for the ci-doctor

The role, its descriptor, its case lease, its gate (`ci-doctor/gate.ts`), the
case issue it files and claims before it works (below), the supervisor wiring
that runs that gate and the model-facing prompt (`prompts/ci-doctor.md`,
felipearos/ralph#157) are live: a rostered ci-doctor starts, passes preflight,
polls Buildkite, claims a case and works it — fixing a confirmed in-scope
flake through the coder's five phases, filing anything out of scope, and
unparking a coder ticket that was parked on a flake. The prompt calls the diff
guard and `unpark.ts`, so neither is hand-run any more.

The dashboard reads the doctor too (felipearos/ralph#160). A **CI health**
page in the project's sidebar (`/ci`) shows the base branch's colour and since when, any
open infra incident, the flake and regression table with what each has cost in
72 hours, the tickets parked on a flake and their unpark history, the estimated
CI time lost to known flakes, the day's retries against their cap, and any
revert with its forward fix. A ci-doctor's loop card leads with the case its
lease holds rather than with a ticket, and a ticket parked on a flake is listed
as the doctor's work rather than under "needs triage". The whole panel is one
`readFileSync` of `<git-common-dir>/ralph/ci-health.json` — no API call, and a
missing store renders an empty panel rather than an error. The reverts list is
live as of #162 — `ci-doctor/revert.ts` writes `reverts` — and the section is
hidden while no culprit has been reverted. The retries line is live —
`ci-doctor/retry.ts` writes `retries` — and reads "no failed job has been
retried yet" on a day the doctor spent none of its six. The CI-time figure is an
estimate from the median red BUILD's wall time, because nothing persists a
per-job duration.

The auto-revert of a main regression is live as of felipearos/ralph#162 and the
prompt offers it at §2.4: on an unambiguous culprit the doctor opens a revert
pull request through the ordinary required checks and files the forward fix
behind it, and on anything else — an ambiguous culprit, a culprit that is
itself a revert or touches `ciDoctor.neverTouch`, a culprit whose one attempt
is spent, a revert that will not apply, or `ciDoctor.autoRevert: false` — it
files the regression for the coders as `priority:urgent` instead.
`ci-doctor/revert.ts` opens the pull request and stops: enqueueing is the
project's own command and the merge wait is the supervisor's, so no revert
reaches main without the checks every other change passes.

The failed-job retry, by contrast, is live and the
prompt offers it nowhere, on purpose — `ci-doctor/gate.ts` makes it with no
model turn (see "The second token: the ci-doctor's retry"). The five project fragment sections the prompt places
— `CI_DOCTOR` in the preamble, `CI_DOCTOR_JOB_COMMANDS`,
`CI_DOCTOR_KNOWN_FLAKES` and `CI_DOCTOR_HOST_FENCE` in §3.1's measurement, and
`CI_DOCTOR_GATES` at the head of §4 — render empty for a project that defines
none of them, and loggd's are a loggd pull request: the five bodies to apply
there are written out in two comments on felipearos/ralph#164, which owns
loggd's roster change, and `bun sync-fixtures.ts` refreshes the mirror once
they are on loggd's `main`.

The three SEAMS between those pieces are covered by
`ci-doctor/end-to-end.test.ts` (felipearos/ralph#164), over one scratch
repository with a `doc` loop in its roster: the gate's verdict reaching a
`ci-health` issue the doctor claims with `doc-wip`; that flake's fix reaching
the coder ticket parked on it — unparked, and then accepted by the coder's own
shepherd answer, on the pull request `unpark.ts` itself readied; and a culprit
the doctor may not touch reaching the coders as `priority:urgent`, ahead of a
backlog that outranks it on every other key the frontier ranks by, losing the
label again when the regression retires. `case-issue.ts`, `unpark.ts` and
`revert.ts` run there as real subprocesses; the gate runs in-process, because
`bk-log.ts`'s `API` is a module constant and cannot be pointed at a fake
Buildkite across a process boundary. The first criterion is only partly
executed: the provenance line comes out of the rendered prompt and the gate is
shown offering a pull request carrying it, but the `doc-done` label and the
journal's `**Case:**` line are the model's steps that no CLI performs — those
are **pinned against the rendered prompt** — and "merged" is reached by nothing
there at all.

One defect that suite found — an urgent `ci-health` filing carrying no
difficulty label, which routing used to drop, so a red base branch was offered
to no coder while the ordinary backlog proceeded — was fixed in
felipearos/ralph#233: routing now exempts such a filing. The suite pins the
fixed behaviour, with a fixture of exactly that shape. See
[Jav: difficulty routing](#jav-difficulty-routing).

Loggd's doctor also has its lineup already — `loggd.@ci-doctor` in
[`models.json`](models.json), a role default that serves whatever loggd names
the loop — and the five labels a `doc` loop needs (`doc-wip`, `doc-blocked`,
`doc-done`, `ci-health`, `priority:urgent`) exist on that repository. What is
still outstanding for loggd itself is the roster pull request above, the two
Buildkite tokens in the operator's Doppler, and the first supervised night.

### The ci-doctor's case issue

The doctor does not fix or revert anything off the books. Before it touches a
diff it turns the case into an ordinary claimed ticket, with
`ci-doctor/case-issue.ts`:

```bash
# Find or create the case's ci-health issue and claim it.
RALPH_RUN_ID=$RALPH_RUN_ID RALPH_LOOP_NAME=doc bun ci-doctor/case-issue.ts ensure "flake:src/a.test.ts > flaps" \
  --title "Flake: src/a.test.ts > flaps" --body-file .ralph/logs/diagnosis.md

# File a case for the coders instead — out of scope, E2E, PR-specific,
# a forward fix, an urgent regression. Never claimed by the doctor.
bun ci-doctor/case-issue.ts file "regression:src/b.test.ts > does" \
  --title "Regression: src/b.test.ts > does" --body-file .ralph/logs/diagnosis.md

# Count a failed fix of its own, and hand the issue over on the second.
RALPH_RUN_ID=$RALPH_RUN_ID RALPH_LOOP_NAME=doc bun ci-doctor/case-issue.ts fix-failed "flake:src/a.test.ts > flaps" \
  --findings-file .ralph/logs/findings.md
```

`ensure` exits 0 when the issue is claimed, 3 when another doctor holds the
case or the claim, 75 when GitHub throttled a write, and 1 on a fault —
`claim-lease.ts`'s and `frontier/github-rate-limit.ts`'s codes, because
neither losing a race nor being throttled is a fault.

Four things about it are worth knowing, because each is a decision rather
than a detail:

- **The dedupe key is a body marker**,
  `<!-- ci-doctor case="<case key>" id=ci-doctor-case-<hash> -->`, and the
  HASH is what is searched and compared. It is on GitHub and not in the
  ci-health store because that store is a cache that may be deleted, and a
  filing identity that dies with it would file a duplicate issue on every
  poll. The hash rather than the key because a case key is a test id, and test
  ids carry `"`, `:`, `/` and `>` — punctuation that makes a search phrase
  unreliable, where `[a-f0-9]{16}` searches exactly. A read that merely
  *failed* is kept distinct from one that found nothing, for the same reason:
  "none" licenses a create, so one 403 read as "none" would file the duplicate
  the marker exists to prevent. The issue the store remembers is checked first,
  because GitHub's index is not synchronous.
- **A doctor's own case issue is created with `ci-health` alone** — no
  `ready-for-agent`, which is what a coder's frontier requires, and no
  `<loop>-wip` either. The claim writes the wip label, through the same
  `claimByNumberWithLock` every other claim path uses; creating the issue
  already wearing it would make that claim refuse the doctor's own issue.
  What a coder is offered instead carries `ci-health`, `ready-for-agent` and
  `bug`.
- **A case key that CHANGES shape is a second filing, so BOTH halves of the
  identity move.** A jest `● describe › test` block names no file, and before
  #237 `identify` could resolve one only when the whole job had named exactly
  one test file — so every failure from a job that ran hundreds landed as
  `describe > test` with `file: null`. The digest now carries the path from
  jest's `FAIL <path>` header, which is a different key for the same test, and
  the marker above would find nothing and file a fresh issue for a flake that
  already has one. Two moves, because the identity lives in two places:
  `ci-doctor/rekey.ts` runs in `applyBatch` before the classification and moves
  the STORE's half — the case key itself, its issue, pull request, fix attempts
  and state, plus the lease, the retry ledger, a revert's case key and a parked
  ticket's unpark record — mapping bare id to file from the rows that now carry
  one and refusing any bare id two files claim. The marker on GITHUB is the
  other half, and it still names the key the issue was filed under, so the
  rekey records that key in `Case.filedAs` and `ensureCaseIssue` looks it up as
  well and re-stamps the body with the new marker once; after that GitHub
  carries the new identity alone and the bridge is cleared. Aging the old keys
  out instead is not an option at all: `prune` never touches `cases` and
  `mergeCases` keeps a `filed` one for good, so there is nothing to age. Nor is
  a `CI_HEALTH_VERSION` bump — that would discard the live 72-hour window and
  the `filed` state with it, which is the record that stops the second page.
- **The case lease, not the search, is what stops two doctors filing twice.**
  Both would read an empty registry and both create; the lease decides inside
  the store's lock, and the store lives in Git's common directory, so every
  worktree of the project shares it. Two doctors on two clones share nothing —
  the residual exposure, and one this project does not plan for, since it runs
  one doctor by design.

A second failed fix of the doctor's own does not park the ticket as
`<loop>-blocked`. It comments the findings, **releases the claim lease**, and
then swaps whichever claim or stuck label the issue actually carries for
`ready-for-agent` and `bug`; the ticket becomes a coder's, because a fix the
doctor cannot land is work, not a dead end.

Two details there are the whole of why it is more than one `gh` call. The lease
release is not tidiness: a lease outlives the label, the supervisor's heartbeat
renews it, and a ticket whose label went but whose lease stayed is offered in
READY and refused to every coder that tries to claim it. And the labels are
read off the issue rather than assumed — `gh` 404s on removing a label that is
not there, and a ticket handed over still wearing `<loop>-blocked` is dropped
by the frontier however ready it looks.

`file` opens what it finds for the same reason. A case the doctor had already
`ensure`d has its own issue, with a claim on it and no `ready-for-agent`;
returning that unchanged would print "filed for the coders", mark the case
handed-off — which the gate then skips for good — and leave a ticket nobody
can see. Two doctors filing one coder case concurrently can still both create,
though: that path takes no case lease, and one doctor per project is the
design.

### The ci-doctor's unpark

A coder whose pull request goes red a fourth time on a test its diff does not
touch parks the work: `blocked: PR #<pr> red on a flaky test (<file>), not the
diff` on the ticket (`prompt.md` §5.4), and the pull request marked a draft
(§6). That is
the right move and it is also a dead end. A stamped draft is deliberately
never shepherded again, and the `<loop>-blocked` label hides the ticket from
every frontier, so finished work goes invisible — loggd #1557/PR #1681,
#1574/PR #1662 and #1537/PR #1710 all sit there.

`ci-doctor/unpark.ts` is the way back out, and the doctor is the one that may
take it, because it is the only agent that can say the test rather than the
diff was at fault:

```bash
bun ci-doctor/unpark.ts 1557 --pr 1681 \
  --diagnosis "flake:src/queue/retry.test.ts > retries" \
  --evidence-file .ralph/logs/diagnosis.md
```

It exits 0 when it unparked, resumed, declined or found nothing to do; 1 when
it refuses its arguments or cannot attribute what it is being asked to change;
and 75 when GitHub throttled it, read or write, because a throttle is time
rather than a fault.

Three writes, in an order where a crash between any two is harmless:

1. comment the diagnosis on the issue — first line `unparked: <diagnosis>`,
   then the evidence, then a marker;
2. `--remove-label <owner>-blocked`, the owner being the loop the draft's
   provenance line names;
3. `gh pr ready <pr>`, which makes the pull request shepherdable again, so the
   owning coder's own gate picks it up and re-runs CI.

**Step 3 is last on purpose.** Interrupted before it, the ticket is unblocked
and the pull request is still a draft nobody shepherds — visibly unfinished,
and the next poll completes it. The other order would leave a ready pull
request on a ticket still labelled blocked, which reads as done to everything
that looks at it.

Three things decide, and they are deliberately not the same thing:

- **What is left to do is read off GitHub every run** — the marker in the
  comments, the label on the issue, the draft flag on the pull request. Not one
  of the three steps is taken because a previous run said so. That is the whole
  of why a second run writes nothing and a killed run finishes, without either
  being a special case in the code.
- **The budget is counted off the issue's comments**, not off the ci-health
  store: at most one unpark per (ticket, diagnosis) and two per ticket ever,
  counted as distinct `diagnosis=<hash>` markers. The store says in its own
  header that it is a cache which may be deleted and rebuilt from a scan, and a
  budget kept only there would reset with it — while the thing it protects is a
  coder's attention. Past the budget the doctor only comments, once per
  diagnosis, under a separate `unpark-declined` marker so a refusal cannot
  spend the allowance it is reporting.
- **Whether a resume is a resume is decided by the ORDER of the comments.**
  This is the one state nothing else can see. A chronic flake's steady state is
  that the ticket is unparked, the pull request goes red on the same test
  again, and the coder parks it a second time — and on GitHub that is
  byte-identical to an unpark interrupted after step 1: marker present, label
  present, draft. Read as a resume it would be unparked again, silently, with
  no comment and no bound, for as long as the test stays flaky. So a block
  record NEWER than the diagnosis' marker means parked again; no newer record
  means unfinished, which it completes. Position rather than a timestamp,
  because `gh` lists comments oldest first and that needs no clock and no
  `createdAt`. The newer record's KIND then picks the refusal: another
  `ci-flake` is a re-park, which the one-per-diagnosis budget refuses, while a
  `migration` or an ordinary block means the ticket became somebody else's
  problem and unparking over either would undo their decision.

"Nothing to do" is asked before any of that, and from the three steps alone —
marker on, no block label, not a draft. Nothing else can change that answer,
and asking anything else first is how a completed unpark comes back to write a
second comment on a ticket that has since been blocked for an unrelated reason.

The store record is written last of all, because the gate reads it to stop
offering a ticket it has already unparked for this diagnosis. It is the first
writer of `Case.unparks`, whose reader had been waiting in
`ci-doctor/gate.ts`. Written any earlier it would strand a draft with the gate
convinced the work was done.

Two things about that record are easy to get wrong, and both cost an iteration
per poll rather than anything visible:

- **It is keyed the way the gate READS it**, which is the parked case's own
  `rule` and not the `--diagnosis` the doctor was given. The gate derives that
  rule from the coder's block comment, so it is often the bare test file where
  a ci-health case key is `flake:<file> > <test>`. Recorded under the doctor's
  spelling the gate's lookup misses and the ticket comes back for ever, with
  the record sitting right there — which is why `--diagnosis` must be a
  `flake:` key at all: it is the only shape the gate ever looks up.
- **A refusal is recorded too, and so is a run that finds nothing to do.** A
  refused ticket keeps its block label, so it stays in the gate's parked
  search, and its refusal comment is suppressed by its own marker — a run that
  wrote neither GitHub nor the store would be offered again every poll in
  silence. A completed unpark has dropped the label and left that search, so
  there the record only closes the window where the search answer is still
  cached. Only a fault records nothing, because a fault has established
  nothing.

What the doctor may not do is a fence in the code rather than a line in a
brief: the only label verb is `--remove-label` on a `*-blocked`, and the only
`pr` verb is `ready`. It never removes a `-wip` — the claim is the coder's —
and never pushes, rebases, requeues or closes a coder's pull request. Three
things it refuses rather than guesses at, each because the wrong guess writes
to somebody else's work: a `*-blocked` label the draft's provenance line does
not account for (whose block it is has to be read), a `--pr` whose body does
not name the ticket (a transposed number would ready a stranger's draft), and
a `--diagnosis` that is not a `<kind>:<subject>` case key (the gate reads the
test id back out of the case it would write, and never re-reads a ticket it
already has a case for, so a malformed key blinds it for good).

A block record written that way now reads as its own `BlockKind`, `ci-flake`
(`block-reason.ts`), so the triager's rescue bucket skips it — re-specifying a
ticket whose test was at fault changes nothing — and the dashboard's stuck
chips say `flaky test` rather than the loop's own block label, which is how an
operator tells the doctor's intake from the tickets actually waiting on a
person. The kind keys on the flake vocabulary, a `flak` stem on the record's
first line, rather than on the exact sentence `prompt.md` mandates, so a block
lightly reworded by hand still reads as one.

### The PR medic

Nobody looks after a red pull request that no loop opened: a coder owns only
its own branch, and the ci-doctor's guardrail 4 forbids it from touching
another loop's branch — neither of them is the operator's. The `pr-medic` role (felipearos/ralph#244) takes a red
required check — or a conflicting branch — on one of the operator's open,
**ready** pull requests and gets it back to green. It rebases a stale branch,
fixes a failure that comes from the branch's own diff under the doctor's
guardrails, and leaves a known flake or an open infrastructure incident to the
doctor. It **stops at green** and comments: merging and enqueueing stay the
operator's.

**What is live is the declaration (felipearos/ralph#245), the push fence
(felipearos/ralph#247), the intake gate (felipearos/ralph#246) and the
iteration prompt (felipearos/ralph#248).** The role's descriptor is reachable
from `roles.ts`, `prMedic` is validated, a `pr-medic` loop's preflight asks for
its claim triple and the read token, `pr-medic/gate.ts` picks and claims a PR,
and [`prompts/pr-medic.md`](prompts/pr-medic.md) works it. What is left is a
project's onboarding (felipearos/ralph#249): its roster entry, its
`PR_MEDIC_*` prompt sections and a first supervised run.

The iteration diagnoses `RALPH_INTAKE_PR` with `bk-log.ts` and its `known:`
lines, sorts every failure into one of three bins, and acts on each:

| Bin | What the iteration does |
| --- | --- |
| stale or conflicting | rebases onto `origin/<base>`, resolving only mechanical conflicts (a resolved commit is signed); a conflict that needs a product judgement is aborted and the PR labelled `<loop>-blocked` with both sides |
| red from the branch's own diff | fixes it the coder's way — delegated, reviewed, one signed commit — under the diff guard |
| a flake or infra incident the gate could not retry away | `case.ts handoff`: a comment naming the doctor's case, and the claim dropped |

**Migrations are a case of the first bin, and the production ledger is what
decides it** (felipearos/ralph#324, for loggd's safe-migration path,
felipearos/loggd#2543). A migration-number collision — two branches that both
wrote the next number — is mechanical while the branch's migration is **not**
in the production ledger: the medic takes the base's generated migration and
snapshot, regenerates the branch's with the project's own generate command,
which also refreshes the journal `when`, and signs that commit. It never
renames a migration file by hand, because the migrator orders by the journal
`when` and a renumbered file whose entry stayed behind is skipped in silence.
Once the ledger holds the migration, the collision is the operator's: the fix
is a new migration, not a renumbered one. A ledger check that reports *pending
safe apply* — the branch's migrations next in sequence and classified safe, so
the queue applies them on merge — **passes**, so it is green, it starts no case
and it is never a reason to block; a verdict that calls a statement *unsafe* is
the operator's, with the classifier's per-statement reasons quoted and the
expand/contract split sketched. The triager narrows with it: needing a
migration alone is no longer `ready-for-human`, and only an evidently
destructive or data change — a drop, a rename, a tightened constraint, a
backfill — stays there, unless a project's own readiness section is stricter.

It runs the project's gates behind the host fence, pushes only through
`push.ts` (each exit code has one answer in §5.3; a lost lease means the
operator is in the branch, so it steps back and never retries), comments what
was red, what it changed and which commits, and ends `AWAIT_PR <pr> ci`. At
green it says "green, ready for you to merge" and releases the claim to
`<loop>-done`; red again, it keeps the claim and the gate hands the PR back to
a fresh iteration, until the push cap sends it to `<loop>-blocked`. Nothing in
the prompt, its PR-wait session or its budget handoff (`ship-prompt.ts
--role pr-medic`) merges, enqueues, drafts or waits on a merge.

The claim's release is `pr-medic/case.ts`, which re-reads the PR before every
write and refuses what the reading does not support:

| Verb | Writes |
| --- | --- |
| `status <pr>` | nothing: where the PR stands (`green`, `red`, `conflicting`, `pending`, `draft`, `closed`), its head, red and pending required checks, medic pushes against the cap, this loop's labels |
| `done <pr> --comment-file f` | the green comment, then `-wip` → `-done`; refused (exit 3) unless every required check on the head is green, none pending, and the branch not `DIRTY` |
| `blocked <pr> --comment-file f` | the diagnosis, whose first line starts `blocked:`, then `-wip` → `-blocked` |
| `handoff <pr> --comment-file f` | the comment naming the doctor's case, then drops `-wip`; labels nothing |
| `drop <pr>` | drops `-wip` only, no comment — a PR that was closed, merged or turned into a draft |

Each comment carries a marker naming the verb, the loop and the head, so a
re-run never says it twice. Exit 0 done or nothing to do, 1 gh unreadable, 3
refused, 64 usage, 75 throttled.

The five project fragment sections the prompt places — `PR_MEDIC` in the
preamble, `PR_MEDIC_STALE` (what goes red on a branch merely behind the base:
allowlist ratchets, visual baselines) and `PR_MEDIC_JOB_COMMANDS` (the failed
job → local command map) in §1's diagnosis, `PR_MEDIC_HOST_FENCE` in §3.1, and
`PR_MEDIC_GATES` at the head of §4 — render empty for a project that defines
none of them. A project can reuse its `CI_DOCTOR_JOB_COMMANDS`,
`CI_DOCTOR_HOST_FENCE` and `CI_DOCTOR_GATES` bodies; loggd's are its own pull
request (felipearos/ralph#249), mirrored here by `bun sync-fixtures.ts` once on
its `main`.

The gate takes an open, **ready** PR whose head branch a `prMedic.branches`
glob matches and no roster loop's `<loop>/` prefix does, when a required check
on its head commit is red or GitHub reports it conflicting (`DIRTY`), its head
commit is older than `quietMinutes`, no medic has labelled it `<loop>-blocked`
or holds another `<loop>-wip` on it, and fewer than `maxPushes` commits at the
top of the branch carry a `Pr-Medic: <loop>` trailer — the count runs back to
the newest commit without one, so an operator push clears it. Oldest PR first.
It claims by adding `<loop>-wip` under a machine-wide lock
(`<git-common-dir>/ralph/pr-medic-claim.lock`), after re-reading the PR's labels
and head, and reads the labels back afterwards: a claim that finds another
medic's `-wip` beside its own takes its own back. The case line is
`operator PR #<n> on <branch> — <reason>`, which `ralph.sh` exports as
`RALPH_INTAKE_PR` and `RALPH_INTAKE_REASON` (`red: <checks>`, `conflicting`, or
both) and hands to the backoff as the PR the iteration must move. A PR this loop
already labelled is resumed without a second claim — including a green one, so
the iteration can release it.

**Adoption** (felipearos/ralph#425). A roster loop's own pull request has no
caretaker once that loop dies, so the gate reads `bun loop-state.ts unattended
--json` once per poll and may adopt an **unattended** owner's red or
conflicting PR — never a green one, a draft, or one inside `quietMinutes` or
at `maxPushes` — whatever `prMedic.branches` says, since a loop's branch
matches no glob by construction. One per poll, a `migration-applied` one
first, then the lowest number, and none while the medic already holds one: it
takes the ticket's claim lease (`<owner>/<n>-…` names the ticket) under its
own run and the supervisor's pid, so the heartbeat renews exactly that lease,
and refuses when the owner's lease is still live. The `-wip` on the PR is what
keeps a returning owner off it (`frontier-gate.ts`'s `adoptedBy`), and one
comment says who adopted it from whom, the owner's stop kind and how long it
has been down. A failed or unparseable unattended read adopts nothing. The
iteration ends an adoption as it ends any case (`case.ts done`, `blocked`,
`handoff`, `drop`), each of which also releases the lease; when the owner is
no longer unattended the gate hands the PR over as `handback: <loop> is back`
and `case.ts handback` comments once and drops the claim with no push. An
adopted PR the operator closes is released by the gate on a re-read that shows
it is not open — never on its absence from the capped list. The medic still
merges nothing. `push.ts` lifts its glob and owner refusals only for an
adopted push (owner unattended, `-wip` present), and refuses when the
unattended set cannot be read.

A PR red **only** on confirmed flakes, or on a job with no test failure that an
open infra incident in the ci-health store has evidence on for that build
(`pr-medic/known-red.ts`, reading the same `known:` verdicts `bk-log.ts`
prints), starts no iteration: the gate re-runs its failed jobs once per head
commit (`ci-doctor/retry.ts`'s `retryHead`) and then leaves it to the doctor.
That retry spends the **doctor's** daily cap — the same `retries.count` in the
same store — so the two roles share six a day. A medic-only project cannot
lower that cap (`ciDoctor` needs a rostered doctor), but cannot raise it either.
`--once --dry-run` prints the verdict without claiming or retrying.

Three fences will be the whole of its safety, and they are why `prMedic` is
validated as strictly as it is:

- **`branches`.** The medic touches only a pull request whose head branch one
  of these globs matches, and the config refuses a glob that reaches a roster
  loop's own `<loop>/` branches — an agent's pull request belongs to the loop
  that opened it. The dialect is the harness's own: `*` within one segment, `?`
  one character, `**` across segments, and nothing else. A character class, a
  brace list, a negation or a full `refs/` path is refused rather than quietly
  escaped to a literal, because `[r]alph/*` is a literal here and matches
  `ralph/123-x` under fnmatch — and a blast radius may not mean two things.
- **`quietMinutes`** (15, applied by the gate). A head commit younger than this
  is skipped: the operator is probably still working on the branch.
- **`maxPushes`** (3, applied by the gate). At most this many medic pushes to
  one pull request while it stays red; after that it comments, labels the pull
  request `<loop>-blocked` and stops. A new operator push clears the count. The
  gate counts the `Pr-Medic: <loop>` commits after the newest commit without
  one, and the push fence refuses any push whose new HEAD does not carry that
  trailer — so a pure rebase lands an empty trailered commit and counts too.

#### The push fence

`bun pr-medic/push.ts <pr> --expect <sha>` is the only way a medic writes to a
branch; `<sha>` is the head it fetched. Its session is denied a raw `git push`
(`pr-medic/orchestrator-settings.json`, which `ralph.sh` adds with `--settings`
for this role alone; a medic whose lineup names the codex orchestrator refuses
to start, because that runner cannot carry the rail). The fence checks, in
order, and exits with a code the iteration can tell apart:

| Exit | Refused because |
| --- | --- |
| 3 | The pull request, re-read now, is not open, is a draft or a fork, its branch matches no `prMedic.branches` glob or sits under a roster loop's `<loop>/` prefix, or its head is no longer `<sha>`. Also: this loop is not a `pr-medic` on the roster. |
| 10 | The diff guard (`ci-doctor/verify.ts`'s rules, without the doctor's fix scope) refused what the medic wrote: a weakened test, a raised timeout without evidence, or a `neverTouch` path. After a rebase onto a moved base it judges the PR's own diff against the new base and forgives findings the operator's diff already had, so main's commits never count. |
| 5 | A commit the medic wrote lacks `Pr-Medic: <loop>`. A commit a clean rebase replayed patch for patch is the operator's and needs none; one the rebase changed (a resolved conflict) does. The new HEAD must itself carry the trailer, so a pure rebase ends with `git commit --allow-empty` naming the base sha it rebased onto — that commit is what the gate's `maxPushes` counts. A HEAD that only drops commits is refused here too. |
| 4 | The lease failed: the operator pushed since `<sha>`. Their commit stands. Re-read and re-diagnose; do not retry. |

The push itself is `--force-with-lease=<branch>:<sha>`, never a bare force and
never a lease without a sha: a bare lease compares against `origin/<branch>`,
which the next `git fetch` silently moves onto the operator's new commit.

### The clerk

A `clerk` loop (felipearos/ralph#315) watches one Slack channel dedicated to
reporting issues, decides for each settled report whether it is an issue, a
decision for the team or nothing to file, and files it on the Jira intake board
for a person to confirm; a table in the channel's canvas, rebuilt from that
board, shows what the channel
reported and where each report stands. It is hosted in a Ralph project of its own that holds only
`.ralph/` — empty `gates` and `requiredChecks`, a `clerk` block, and its
`CLERK_*` guidance — with one clerk on the roster and that loop's `-wip`,
`-blocked` and `-done` labels on the repo.

The model only classifies. Its session reads a batch of reports and writes a
plan; code validates the plan and makes every Slack and Jira write, and in
`mode: "shadow"` it makes none and records what it would have written instead.

What is live:

- **The declaration** (felipearos/ralph#316) — the descriptor, the validated
  `clerk` block, the prompt template with its `CLERK`, `CLERK_APPS` and
  `CLERK_PRIORITY` sections. The fixture project is
  [`fixtures/clerk/.ralph/`](fixtures/clerk/.ralph/).
- **The gate reads the channel** (felipearos/ralph#317). `clerk/gate.ts` reads
  the channel's messages after its cursor and their threads
  ([`clerk/slack.ts`](clerk/slack.ts)), groups them into reports
  ([`clerk/reports.ts`](clerk/reports.ts)) — a top-level message and its thread
  are one report, and one author's consecutive messages each within
  `joinMinutes` of the last are one report — and hands over the reports that
  have been quiet for `settleMinutes`, at most `batchSize` of them, oldest
  first. Reports go over in the order they were written: a report still
  being written holds back every newer one until it settles, so no poll
  files a newer report before an older one. Threads are read only for the
  reports one batch can take, so a long backlog costs each poll a batch's
  `conversations.replies` calls, never the whole backlog's. The clerk's own
  messages are never reports and never activity, and neither are those of
  `clerk.ignoreUsers` (Slack `U…`/`W…` ids, empty by default): the team
  members who work the tickets and talk in the channel. Their top-level
  messages open no report, get no "Recibido" reply and are not counted
  (the KPI DM leaves them out of the channel's members), and their replies in
  a reporter's thread are not part of the report and do not hold it from
  settling. Only detection skips them: a reply of theirs on a report already
  filed is copied to its ticket like anyone's, because a team member
  answering in the thread is context the ticket should carry. The
  batch, the cursor and the processed reports live in the clerk's store,
  `<git-common-dir>/ralph/clerk/<loop>.json`, so a restarted gate neither
  re-hands nor skips a report; the first poll of a store starts the cursor at
  "now", so nothing posted before the clerk started is filed.

  **Moving the cursor.** `bun ~/ralph/clerk/cursor.ts` (in the loop's
  worktree) prints it; `--now` moves it to now; `--since 2026-10-01` (or
  `--since 2026-10-01T09:30`, read in America/Santiago, or with a `Z`/`±HH:MM`
  offset as written) moves it to that moment, so the next polls read the
  channel from then on and nothing before it. Both drop a handed batch;
  processed reports are kept, so moving the cursor back hands none over
  twice. A backfill of weeks drains one batch per poll, oldest first, and a
  429 waits its `Retry-After` before the next poll resumes where it was.
  Stop the loop, move the cursor, start it.

  **Redoing shadow history.** After a change to a shadow clerk's config or
  prompt, `cursor.ts --since 2026-10-01 --redo` also drops this channel's
  processed reports and shadow decisions (would-be tickets, intended writes,
  determinations) from that moment on, so the next polls classify them
  again. It copies the store to `<loop>.json.bak-<time>` beside it first, and
  appends a `superseded` event per dropped report to the metrics ledger,
  which every ledger reader honours: a redone report counts once, as its new
  classification. It exits 64 unless `clerk.mode` is `shadow`, because live
  it would file every one of those reports a second time.

  **Changing `clerk.channel`.** The store records its channel. A store
  written for another channel starts the new channel's reading over — no
  cursor (so the first poll starts at "now"), no processed or re-opened
  reports, no handed batch — and keeps what is keyed by ticket: the shadow
  would-be tickets, the determinations, the confirmation and outcome records
  and the canvas. No manual store step is needed: stop the loop, merge the
  new channel, run `cursor.ts --since …` if the new channel's history
  should be read, and start it. The old channel's cursor is gone once the
  new one is written; moving back starts that channel at "now" too.

  The Slack bot token is `RALPH_CLERK_SLACK_TOKEN`, a `gate` secret: the
  supervisor proves it with `bun clerk/slack.ts --check-token` (`auth.test`,
  and every one of `channels:history`, `channels:read`, `users:read`,
  `canvases:read`, `canvases:write`, `chat:write` granted), hands it to the gate
  alone, and strips it from every other role. The preflight's
  `clerk-credentials` check denies a clerk start without it, or with one its
  check refused. `files:read` is not required, only warned about: it is what
  attaches a report's files to its ticket (below), and without it the files
  stay linked.

  A transient Slack failure (a 5xx, a timeout, the network) is "nothing to do"
  with a wait that doubles per failure in a row, up to an hour; a 429 waits what
  `Retry-After` says. A denial — `invalid_auth`, `token_revoked`,
  `missing_scope`, `not_in_channel`, `channel_not_found` and the like — stops
  the loop: the gate prints the remedy, raises a `credential-expiry` or
  `permission-denial` notification, and writes a `stop` command to the loop's
  own inbox, which the supervisor applies at its checkpoint.

- **The daily KPI DM** (felipearos/ralph#453, [`clerk/kpi.ts`](clerk/kpi.ts)).
  With a `clerk.kpiReport` block, the gate's poll DMs a short Spanish report
  from the metrics ledger once per local day, at the first poll on or after
  `time` (default `09:00` `America/Santiago`, Monday to Friday): intake volume,
  confirmation and overrides, signal versus noise per reporter, delivery, and
  participation (channel members, minus bots, with no report in `quietDays`,
  and who joined or left since the last report). `exclude` (Slack `U…` ids)
  names people the report leaves out of every per-person line, for channel
  members outside the pilot; unlike `clerk.ignoreUsers` their messages are
  still reports and still count in the totals. `mode: "draft"` (the
  default) sends it to `clerk.operator` alone; `"send"` reaches `recipients`
  (Slack `U…` ids; a `D…` DM id is refused) only while the clerk is live.
  `channels` (Slack `C…` or `G…` ids; a `D…` id is refused) are posted the
  same report as a top-level message, exactly when the recipients are DMed:
  `send` and live, never a draft, never in shadow or quiet. The bot must be
  invited to each; a post it is refused (`not_in_channel`,
  `channel_not_found`) or that fails is a log note naming the channel and
  saying to invite the bot, retried at the next poll, and `--check-token`
  warns about a channel it cannot read. With
  no operator to send a draft to, the report is off: the preflight's
  `project-config` check warns and every poll logs a note, but the clerk runs. The
  day, the text and who it reached are kept in
  `<git-common-dir>/ralph/clerk/<loop>.kpi.json`, so a restart sends nothing
  twice (to a person or in a channel) and a missed 09:00 sends late. It needs `im:write`, `chat:write`,
  `channels:read` and `groups:read`; `--check-token` names a missing one as a
  warning, and a refused or failed send is a log note retried at the next poll,
  never a stop. `bun clerk-kpi.ts --print [--date YYYY-MM-DD] [--members U1,U2]`
  prints the report without calling Slack.

- **The iteration classifies, code applies, in shadow** (felipearos/ralph#318).
  When the gate hands a batch over it has already gathered each report's
  dedupe candidates from the intake board
  ([`clerk/candidates.ts`](clerk/candidates.ts), felipearos/ralph#447): every
  open `slack-intake` ticket (fifty at most), plus the 25 most recently
  updated done ones, kept when they reached done within `regressionDays`. A
  done one labelled `moved-to-jira` was moved to the team's OA board and is
  still live there, so it carries the OA key named in its comments. A shadow
  clerk reads them too when it holds a Jira credential and names a board;
  without either its batches go out with no candidates, and the poll's notes
  say so. The
  session ([`prompts/clerk.md`](prompts/clerk.md)) reads the batch with
  `bun clerk/batch.ts`, writes one plan to `.ralph/logs/clerk-plan-<batch>.json`,
  checks it with `bun clerk/batch.ts --check`, and ends. It holds no Slack or
  Jira credential, and its own rails (`clerk/orchestrator-settings.json`) deny
  it the web tools, `curl` and `wget`.

  The gate's next poll validates the plan ([`clerk/plan.ts`](clerk/plan.ts)):
  an unknown enum value, a missing field or a report left out refuses the whole
  plan, and the batch is handed to a fresh session once more with the
  problems; a second refusal files every report as a `Tarea` at
  `Sin Prioridad` labelled `intake-sin-clasificar`. A `duplicate_of` the report
  was not offered is downgraded to a new ticket marked "posible duplicado
  (no verificado)" rather than refusing the plan. The valid plan is applied
  ([`clerk/apply.ts`](clerk/apply.ts)) report by report, each step saved before
  the next, so a gate killed halfway resumes where it stopped and records
  nothing twice. Every write goes through one port: in `shadow` it is the
  shadow port, which holds no client at all and records each intended write —
  and each would-be ticket — in the clerk's store. Each applied batch is a
  journal entry (`publish-journal.ts`, `#none`): what was filed, commented,
  replied, and every ignored report with its permalink and reason.

  The Jira credential is `RALPH_CLERK_JIRA_TOKEN`, written
  `<email>:<API token>`, a `gate` secret proved by
  `bun clerk/jira.ts --check-token` (a read of `clerk.jira.project` on
  `clerk.jira.site`). A 401, 403, 404 or 400 from Jira is a denial and stops
  the loop like Slack's; a 5xx or a timeout backs off; a 429 waits
  `Retry-After`. The gate signs each batch it hands over with a key the
  session never holds, and files a batch changed on disk unclassified, with an
  alert.
- **Live writes** (felipearos/ralph#320, #447). With `mode: "live"` the same
  apply goes through the live port ([`clerk/live.ts`](clerk/live.ts)), which
  files on the Jira intake board `clerk.jira.intakeProject`. A new issue or
  decision is a ticket in "Por confirmar", titled with the Spanish summary and
  labelled as [Slack intake on a Jira board](#slack-intake-on-a-jira-board)
  lists. Its description quotes the report, names the reporter, links the
  permalink and the screenshots, and states the type, priority, app,
  difficulty, suggested points and who does it. Every new report gets the
  thread reply "Recibido, en revisión." at once, tagging nobody. A sure
  duplicate of an open ticket is a comment on it plus a thread reply "Ya está
  reportado: OAI-xxx (reporte original)", linking the Slack message the ticket
  was filed from when its description still names it; of one moved to OA, the
  comment still goes on the intake ticket and the reply names the OA key ("Ya
  está reportado: OA-xxx"). A duplicate of any other ticket done within `regressionDays` is a
  new ticket noted "Posible regresión", and an unsure duplicate one noted
  "posible duplicado", each linked to the ticket it names. Every ticket the
  clerk files carries a marker built from the report's permalink, and before
  every create the port searches the board for a ticket carrying it, so a
  crash between the create and the save files nothing twice. Three failed
  applies in a row raise one `gate-failure` alert; the batch is kept and
  retried every poll.

  <a id="grouping-replies"></a>**Grouping replies.** Slack cannot move a
  message into a thread, so when a report was joined from several top-level
  messages (`joinMinutes`), a live clerk makes the grouping visible with
  replies. The first message's reply lists the others as Slack links with
  their Chile time (America/Santiago): "Recibido, en revisión. Este reporte
  incluye también: <enlace|mensaje de 09:02>, …" — a duplicate's "Ya está
  reportado: OAI-xxx." is extended the same way, and a one-message report
  keeps the plain reply. Each follow-up message then gets the reply
  "Agregado al reporte de arriba: <enlace|ver reporte>", pointing at the
  first. Each posted follow-up reply is recorded in the report's progress,
  and the thread is read for it before every post, so a rerun posts none
  twice. A post that fails is a note in the poll, never a failed apply: the
  report is still marked processed, the follow-up is kept in
  `pendingFollowUps` in the clerk's store and retried every live poll until
  it lands or the thread leaves the 14-day watch. Shadow and quiet post none
  of these: only the live port carries the Slack writer they need, and the
  shadow record keeps the plain reply. The follow-up messages' threads are
  watched like the first one's, so a later reply there is still copied to the
  ticket (see "Threads after filing").

  The clerk has no Linear path (felipearos/ralph#466): it was never live
  there, so nothing had to drain. A live clerk needs `clerk.jira.intakeProject`
  (the config validator refuses one without it) and `RALPH_CLERK_JIRA_TOKEN`
  (denied `no_jira_credential` and stopped rather than filed in shadow). A
  shadow clerk without a board files nothing anywhere: its batches go out with
  no candidates, and the shadow port records what live would write. Going live
  is the cutover in [Slack intake on a Jira board](#slack-intake-on-a-jira-board).

  <a id="quiet-mode"></a>**Quiet mode** (felipearos/ralph#443), `"mode": "quiet"`,
  is the test bench between the two: everything live does on Jira, on the real
  intake board, and nothing in Slack the team can see.

  | | shadow | quiet | live |
  | --- | --- | --- | --- |
  | Tickets on the intake board (labels, points, links, comments, idempotency) | recorded only | yes | yes |
  | Duplicate candidates from the board | when it can read it | yes | yes |
  | Confirmation sweep (overrides, `ready-for-agent`, Descartado) | recorded only | yes | yes |
  | Move a confirmed to-person ticket to OA | never | held by default | yes, unless `holdOaMove` |
  | Thread replies copied to Jira comments | recorded only | yes | yes |
  | "Recibido", grouping, "Resuelto" and other thread replies | never | never | yes |
  | Canvas | `shadowCanvas`, from the shadow record | `shadowCanvas`, from the board; skipped without one, never created | the channel's `canvas` |
  | KPI report | draft to `operator` | draft to `operator` | `recipients` and `channels` when `send` |
  | Ledger `mode` | `shadow` | `quiet` | `live` |

  The Slack fence is in code, not in checks at each call: the quiet write port
  (`clerk/live.ts` `quietPort`) is handed no Slack client, the thread watch
  gets a read-only Slack view, and the quiet canvas writer
  (`clerk/gate.ts` `privateCanvas`) holds only `clerk.shadowCanvas`'s replace.
  Quiet needs `jira.intakeProject` and `RALPH_CLERK_JIRA_TOKEN` as live does,
  and the preflight's board check denies a missing board or status as for
  live; `clerk/slack.ts --check-token` does not require `canvases:write` or
  `chat:write` in quiet (it warns that the operator's canvas and KPI draft
  need them).

  **Holding the move to OA.** With `holdOaMove` true — the default in quiet,
  and settable in live — a ticket confirmed for a person is not created on
  `jira.project`: it stays on the intake board in the confirmed status, the
  sweep labels it `para-mover-a-oa`, and the ledger gets a `moved` event with
  `held: true` and a placeholder key `HELD-<key>`. That is how a second, live
  clerk on a private test channel answers in Slack and files on the shared
  intake board without ever putting a test ticket on the team's board. A held
  ticket stays held: flipping the key later does not move it, so move it by
  hand if it should go to the team.

  Quiet data is test data: `bun clerk-metrics.ts --mode live` leaves it out,
  every summary says how many reports each mode holds, and the dashboard's
  intake page labels the share that is quiet or shadow. `cursor.ts --redo`
  refuses anything but shadow, quiet included.

- **The shadow canvas** (felipearos/ralph#319). The gate itself — code, no
  model turn — redraws the operator's private test canvas, `clerk.shadowCanvas`,
  at its first poll that reaches Slack and then whenever `canvasMinutes` have
  passed since the last rebuild (kept in the clerk's store), replacing the
  whole document with `canvases.edit`. The rows are the would-be tickets the
  shadow apply recorded; [`clerk/canvas.ts`](clerk/canvas.ts) renders them, a
  pure function, into four tables — open errors (Highest to Low, then
  `Sin Prioridad`, oldest first), open requests, "por decidir", and closed in
  the last 7 days — each capped at `rowCap` rows and ending in "y N más" past
  it, under a header saying the canvas is generated and manual edits are
  overwritten. A would-be ticket links to its report's permalink, since it has
  no Jira page. Shadow writes no other canvas: never `clerk.canvas`, and no
  channel canvas. A test canvas that was deleted or that the bot can no longer
  reach (`canvas_not_found`, `canvas_deleted`, `access_denied`,
  `no_permission`, `not_found`) is created again with `canvases.create`, as is
  one when none is configured; the new id is stored, written by every later
  rebuild, and logged as a `clerk-gate:` line in the supervisor log — put it in
  `clerk.shadowCanvas`. A created canvas belongs to the bot alone until it is
  shared: with `clerk.operator` set, the clerk shares it with that user
  (`canvases.access.set`, write access). The simplest setup is a test canvas
  the operator creates and shares with the bot, named in `clerk.shadowCanvas`.
  A rebuild that fails for any other reason is logged and retried at the next
  poll; it never stops the loop and never holds a report back.

- **Threads after filing** (felipearos/ralph#321). Each poll's history read
  reaches back 14 days, and a reply posted in the thread of a report already
  filed becomes a Jira comment on its ticket — the ticket it created, or the
  one it was folded into as a duplicate — naming who wrote it, quoting it and
  listing its files. The clerk's own replies are never copied; each report
  remembers the newest reply it copied, advanced reply by reply after each
  comment lands, so a failed write leaves the rest for a later poll and a
  comment already there is not written again. A report joined from several
  messages has its every message's thread watched, the follow-ups' included,
  merged into one timeline. In shadow the comment is
  recorded, not written. Live, once a person confirmed the report for the
  team and the confirmation sweep moved it to OA, its replies go to the OA
  ticket the sweep recorded instead, from the next reply on.
- **Report files on the ticket.** Every file a report carries — images,
  videos, PDFs, anything Slack hosts — is attached to its Jira ticket under its
  original name; see [Report files on the ticket](#report-files-on-the-ticket).
- **Code context on filed tickets** (felipearos/ralph#499). Opt-in per
  project: each ticket the clerk files for an app with a configured repo gets
  a "Contexto de código" comment written by a session that read the code; see
  [Code context on filed tickets](#code-context-on-filed-tickets).
- **Reports that live in a file, and reports of several problems.** When the
  gate hands a batch over, it downloads each report's PDFs and images (at most
  12 per batch, 20 MB each, with `files:read`) into the worktree's ignored
  `.ralph/logs/clerk-files/<batch>/`, removing every other batch's, and
  `clerk/batch.ts` lists each local copy under its message's `readable`; the
  session reads them before it classifies. A file the gate could not fetch is
  a note in the poll, and its report is classified from its text as before
  (`clerk/readable.ts`). A report that describes independent problems — a PDF
  of four bugs — is split: the plan entry's `additional_issues` are filed as
  tickets of their own, numbered "Parte n de N", linked to the report's own
  ticket (and to a candidate one names, as a likely duplicate, never a
  comment), each carrying the report's files and its own marker
  (`<permalink>#parte-n`), so a rerun files none of them twice. Thread
  replies are copied to the report's own ticket only, and the metrics ledger
  counts the report once, by its own ticket.
- **The live channel canvas** (felipearos/ralph#322, felipearos/ralph#448).
  In `live` mode the gate rebuilds the channel's own canvas, `clerk.canvas`,
  from the Jira intake board (`clerk.jira.intakeProject`) every
  `canvasMinutes`, replacing it whole, with no model turn. Two searches read the board's
  `slack-intake` tickets, with the story points field when
  `clerk.jira.storyPointsField` is set: at most 100 open, newest first, and at
  most 40 closed ones updated in the last 7 days. The sections, in order:
  "Por confirmar" (open and not yet with the agents, whatever its status),
  "Para agente" (open with `ready-for-agent` or a `*-wip` claim), "En el
  equipo" (`moved-to-jira` or the moved status, with the OA key a comment
  names, linked to Jira), "Cerrados en los últimos 7 días" and "Descartados"
  (the rejected status). Every section has the columns Ticket, Resumen, App,
  Tipo, Prioridad, Dificultad (from `difficulty:*`), Puntos (the field, else
  the description's `Puntos de historia sugeridos` line), Estado (the OA key
  in "En el equipo") and Reportes (one plus every "Nuevo reporte del mismo
  problema" comment). Each section lists the newest first and stops at
  `rowCap` rows with a "y N más" line. A channel canvas that is gone, or none
  configured, is the channel's own canvas if it has one, or is created as the
  channel's canvas (`conversations.canvases.create`); its id is stored and
  logged. A failed read, or no `intakeProject`, leaves the canvas as it was,
  logs why and waits the interval; it never stops the loop or holds back a
  batch. Shadow never builds or writes this canvas.
- **"Esto es un reporte"** (felipearos/ralph#323). A reply on an ignored
  report that mentions the clerk's bot and says "esto es un reporte" (any case
  or accents) hands that report over again at the next poll, with the name of
  who asked as a `hint`; the plan validator refuses `ignore` for it. The same
  mention on a report already filed is one more reply, copied as a comment,
  and files nothing new. A mention written while the report was still being
  written is simply part of the report the session reads: only one after the
  report was ignored re-opens it. A re-opened report that can no longer be
  rebuilt (its message deleted) goes back to being ignored.

### Report files on the ticket

A report's files are copied onto its ticket on the intake board as Jira
attachments ([`clerk/attachments.ts`](clerk/attachments.ts),
[`clerk/files.ts`](clerk/files.ts)), so a person confirming it sees the
screenshot or the video without opening Slack.

- **Which files.** Every file Slack hosts on the report's messages, joined
  follow-ups and thread replies included: one with an id, a name and a
  `url_private_download`. A link to another service or a deleted file stays a
  link under "Capturas:", as before. A file posted later in a filed report's
  thread goes onto the ticket beside the comment that copies the reply (#321).
- **How.** Filing never waits on a file. The store write that records a ticket
  or a copied reply queues its files (`attachments` in the clerk's store, by
  ticket and Slack file id); after the channel is read, each poll attaches up
  to 10 due files: downloaded with the bot token (`Authorization: Bearer`,
  redirects followed), **streamed to a temporary file** rather than held in
  memory, and uploaded from that file to `POST /rest/api/3/issue/{key}/attachments`
  (multipart field `file`, `X-Atlassian-Token: no-check`) under the original
  name and media type. Download and upload each time out after 10 minutes.
- **What the ticket says.** The description (or the reply's comment) lists
  the attached files by name under "Adjuntos en el ticket:" instead of their
  Slack links, and keeps the report's own permalink, which leads to every file
  in Slack. A file over `clerk.attachmentMaxMb` (default 100, at most 1024,
  the Jira site's 1 GB) is never downloaded: its line names it, its size and
  its Slack link. One whose size Slack does not state and that turns out
  larger stops downloading at the cap, and the poll's note says so.
- **Failures.** A missing `files:read`, a failed download (Slack answering its
  sign-in page counts) or a failed upload is a `clerk-gate:` note and a retry
  later, 5 minutes after the first failure, doubling, at most 6 hours apart; a
  file that has failed for 14 days, or whose ticket is gone, is given up on
  with a note. None of them fails a poll, holds back a batch or stops the loop,
  and the ticket is filed either way. `clerk/slack.ts --check-token` warns,
  and does not refuse, a token without `files:read`: add the scope to the
  clerk's Slack app, reinstall it and store the new bot token.
- **Never twice.** The store records each file per ticket, so a rerun queues
  and uploads nothing again; a file claimed for an upload is held for 25
  minutes so a gate and a backfill never both send it. A kill between an
  upload and its save is caught by reading the ticket's attachments first: one
  with the same name and size is taken as that file (the size matters, since
  every pasted screenshot is `image.png`).
- **Modes.** Shadow downloads and uploads nothing and records each file it
  would attach (`state: "shadow"`). Quiet and live attach, since an
  attachment is a Jira write; quiet only reads Slack to download, and posts
  nothing there.

**Backfilling tickets filed before.** `clerk/attachments.ts --backfill` reads
every `slack-intake` ticket on `clerk.jira.intakeProject` (oldest first, at
most 1000), finds the reports it carries from the clerk's own lines — the
description's `Reportado por … en Slack:` and each duplicate comment's `Nuevo
reporte del mismo problema por … en Slack:` — reads each report's thread
(every root of a joined report the store still remembers), queues the files
the bot did not post, and attaches them as the gate would, waiting out a 429.
It does not rewrite the old descriptions, which keep their links. It is
idempotent: a second run queues nothing, and with the store lost the ticket's
own attachments keep it from attaching twice. In shadow it records and
attaches nothing. It exits 0 when nothing is left, 1 when a file failed (the
running gate retries it on its backoff).

It needs the gate's two secrets, `RALPH_CLERK_SLACK_TOKEN` and
`RALPH_CLERK_JIRA_TOKEN`. `ralph.sh` reads each by name from the project's
secrets scope (`secrets.project` and `secrets.config` in `.ralph/config.json`,
with `doppler secrets get`), proves it with its `--check-token`, and exports it
only into the preflight and the gate's subshell, never an iteration; the
backfill is run by hand the same way, from the clerk loop's worktree (which
gives it the clerk block and, through `.ralph/loop-name` or
`RALPH_LOOP_NAME`, the loop's store):

```sh
cd ~/.local/share/ralph/workspaces/<project>/<clerk>-loop   # or ~/orca/workspaces/… for a loop not moved yet
doppler run -p <secrets.project> -c <secrets.config> -- bun ~/ralph/clerk/attachments.ts --backfill
```

A secret stored under another name (`<NAME>_SECRET` in the supervisor's
environment) is exported under the clerk's name by hand instead. The loop may
keep running meanwhile.

### Code context on filed tickets

The clerk files a report from its text alone: its session has no network and
never sees the application code, so a ticket cannot say which file is
involved, whether the bug is already fixed on the integration branch, or
whether it works as designed. With `clerk.codeContext` set, every ticket it
files (live or quiet) for an app with a configured repo also gets a comment,
written by a second kind of clerk iteration that reads the code
(felipearos/ralph#499).

**Turning it on.** Map the clerk's apps to a local clone and the ref to read,
in the project's `.ralph/config.json`:

```json
"clerk": {
  "codeContext": {
    "repos": {
      "pwa": { "path": "/srv/acme-pwa", "ref": "origin/dev", "mainRef": "origin/main" },
      "Backoffice": { "path": "/srv/acme-backoffice", "ref": "origin/dev", "mainRef": "origin/main" }
    }
  }
}
```

`ref` is what the session reads (the integration branch); `mainRef` is what
is deployed, so the session can tell "fixed on dev, not deployed yet" from
"not fixed". An app with no entry gets no comment; a `none` ticket never does;
`both` gets both repos. Absent or malformed, the feature is off and nothing
else changes.

**What happens.** Filing queues a case in the clerk's store. Report batches
always go first: only when none is waiting does the gate prepare one queued
case — fetch the clone, check `ref` out detached under
`.ralph/logs/code/<app>` (a worktree of the clone; the clone's own checkout
and branches are never touched), download the report's Slack files (with
frames for a video when `ffmpeg` is installed), write
`.ralph/logs/code-context/<KEY>/case.json`, and hand it over as
`clerk-gate: work available — code context OAI-62 (pwa)`. The supervisor runs
THAT iteration with [`prompts/clerk-code-context.md`](prompts/clerk-code-context.md)
on the lineup's `code-context` model, under the clerk's own rails
(`clerk/orchestrator-settings.json`: no web tools, no `curl`/`wget`, no
secrets CLI) and with neither clerk token; every other iteration, and the
sigil-recovery turn of a report batch, is unchanged. The session reads the
case with `bun clerk/code-context.ts --show`, reads the code read-only, and
writes one `result.json` with the comment: six sections (Dónde está, Qué hace
hoy el código, Causa probable, Estado, Propuesta, Estimación), in Spanish, no
emoji, with its confidence stated. The gate's next poll validates it (the
case's key, 200–6000 characters, the `Contexto de código` header, no emoji)
and posts it as a comment on the intake ticket; shadow records it instead. A
refused result is handed back once with the problems, then dropped with a
note in the gate log. A case never holds back report intake.

**The model.** `code-context` is a lineup stage of the clerk alone, shaped like
the orchestrator (`runner`, `model`, `effort`), and `claude` is its only
runner, because only a claude session carries the clerk's rails. Without an
entry it runs `claude-opus-5-5` at effort `high`. To choose another, name it
in the project's `@clerk` block (or the clerk loop's own) — a block that
names it replaces the default wholly, so an entry without `effort` runs with
none:

```json
"@clerk": {
  "orchestrator": { "runner": "claude", "model": "claude-opus-5", "effort": "medium" },
  "code-context": { "runner": "claude", "model": "claude-sonnet-5", "effort": "medium" }
}
```

`bun ~/ralph/models.ts --list --role clerk` shows both; the supervisor log's
`models —` line names it, and each code-context iteration logs
`iteration N is code context OAI-62 — prompts/clerk-code-context.md on <model>`.
`RALPH_MODEL_CODE_CONTEXT`, `RALPH_RUNNER_CODE_CONTEXT` and
`RALPH_MODEL_CODE_CONTEXT_EFFORT` override it for one launch, like every
stage. The lineup is read when the loop starts: restart the clerk to apply a
change.

**What it costs.** One fresh session per filed ticket that has a configured
app — twice for a ticket whose result is refused once — on the
`code-context` model, reading a codebase rather than a short batch: much more
than a classification, and on Opus at high effort by default. It is bounded
like every iteration by `RALPH_ITERATION_TOKEN_CAP`, and booked under the
clerk loop in the usage ledger and the dashboard's usage page, so a week of it
is easy to read back before deciding. A cheaper model in `@clerk` is the knob
for cost; the volume is the channel's.

**Fail soft.** A clerk whose code-context prompt cannot be rendered, or whose
lineup gives `code-context` no claude model, still starts: the supervisor log
says `code context is off for this run`, and a code-context case that arrives
then runs as an ordinary clerk iteration (which finds no batch and ends
`ALL_BLOCKED`) with a line saying so.

**Turning it off.** Remove `clerk.codeContext` from `.ralph/config.json`: no
case is queued from then on. Nothing in the lineup has to change — an unused
`code-context` entry costs nothing.

### Slack intake on a Jira board

The clerk, a person and the coders together take a report from a Slack
channel to a merged fix (felipearos/ralph#391, #443). The clerk files every
report onto a Jira project of its own, `clerk.jira.intakeProject`, the
**intake board**, and a person confirms each ticket there before anyone works
on it. There is no triager on this pipeline: the clerk classifies in one pass
and the person on the board is the review. `end-to-end.test.ts` runs the whole
chain against fakes.

1. **clara files it** in "Por confirmar" with a Spanish spec-style description,
   type, priority, app, difficulty, suggested story points and who does it,
   labelled `slack-intake`, the app's repo label (`acme-backoffice`,
   `acme-pwa`), `difficulty:easy|medium|hard` and `para-agente` or
   `para-persona`. What it determined is kept in the clerk's store.
2. **A person confirms it** on the board: fixes any field that is wrong
   (changing `para-agente`/`para-persona` changes who does it) and moves it to
   "Confirmado", or to "Descartado".
3. **The gate acts on it** at its next poll ([`clerk/confirm.ts`](clerk/confirm.ts)):
   a confirmed `para-agente` ticket gets `ready-for-agent` and stays on the
   board; a confirmed `para-persona` one is filed on the OA board, gets
   `moved-to-jira` and moves to "Movido". Every field the person changed is
   kept in the metrics ledger with both values.
4. **A coder takes it** off the intake board like any ready ticket: the
   frontier gates on `ready-for-agent` and Jav routes on the difficulty label,
   so a ticket nobody has confirmed is offered to no loop
   ([`frontier/intake-board.test.ts`](frontier/intake-board.test.ts)).
5. **The outcome is recorded** ([`clerk/outcomes.ts`](clerk/outcomes.ts),
   felipearos/ralph#450). After the sweep, every poll reads the board's
   tickets in Jira's done category (at most 100, other than the rejected and
   moved ones) and the OA tickets the sweep moved (by key, 50 per search, at
   most 100 a poll, the least recently read first) and writes one `closed`
   event per ticket with its resolution and status. A report confirmed and
   closed with a resolution that kept the work is **valuable**; one ignored,
   a duplicate, rejected, or closed as Won't Do, Won't Fix, Duplicate, Cannot
   Reproduce or Descartado is **noise**. It only reads, so it runs in shadow
   too, and a Jira failure is a note in the supervisor log and a retry at the
   next poll, never a stop. `bun ~/ralph/clerk-metrics.ts [--json] [--by
   reporter|app|week] [--since YYYY-MM-DD]` summarises the ledger
   (`<git-common-dir>/ralph/clerk/<loop>.metrics.jsonl`). A live clerk also
   tells the reporter: a confirmed ticket closed as
   valuable gets one reply in its Slack report's thread, "Resuelto: OAI-22 ya
   está listo. Gracias por reportarlo." (the OA key for a report moved
   there), once a merged PR in `clerk.prRepos` names the ticket (its OA or
   intake key): done in Jira is not shipped while a person still reviews the
   PR, so the reply waits for the merge, for up to 30 days. A Won't Do close,
   a rejection and a ticket filed by hand get none; shadow and quiet post none. The reply is queued in the clerk's store with
   the close and the thread is read for it before each post, so a rerun or a
   kill posts it once; a Slack failure is a note and a retry at the next poll,
   for up to 7 days after the merge.
6. **Moves merged work** (`clerk/merged.ts`), quiet and live, when
   `clerk.jira.mergedStatus` names a status ("Mergeado" on OAI): a worked
   intake ticket (any status but the confirmation's four) that a merged PR in
   `clerk.prRepos` names takes the transition there. The coder loops on
   `merge: "human"` projects leave a handed-off ticket in its work status, so
   this is what tells the board a person merged it. A ticket still waiting
   for, or just past, its confirmation is never moved by a PR that names it.
   The status is in the done category, so the outcome scan records the close
   and tells the reporter on the same poll. Absent, nothing moves.

**The Jira project** is the operator's to create, once, on the clerk's site:
a project (key `OAI` in the fixtures) whose workflow has the statuses
"Por confirmar" (where a ticket is created), "Confirmado", "Descartado" and
"Movido" (both done category), plus the coder loops' claimed and done states
("En curso" and "Listo" below), with transitions from "Por confirmar" to
"Confirmado" and "Descartado", from "Confirmado" to "En curso", "Movido" and
"Descartado", and from "En curso" to "Listo". A board with no "Movido" closes a
moved ticket by any done transition instead. Add a story points field to the
create and edit screens if the points should land in a field; without one they
go in the description as `Puntos de historia sugeridos: N`. The clerk's
`RALPH_CLERK_JIRA_TOKEN` needs to browse, create and edit issues and
transition them on both boards.

**The `clerk.jira` keys**, in the clerk project's `.ralph/config.json`:

```json
"jira": {
  "site": "example.atlassian.net",
  "project": "OA",
  "intakeProject": "OAI",
  "storyPointsField": "customfield_10016",
  "statuses": { "pending": "Por confirmar", "confirmed": "Confirmado", "rejected": "Descartado", "moved": "Movido" }
}
```

`project` is the person board a confirmed `para-persona` ticket moves to.
`storyPointsField`, `statuses` and `mergedStatus` (a done-category status the
board's work statuses can reach, such as "Mergeado") are optional (the
statuses default to the names above); preflight checks that the board is readable, that each status
exists, and warns when the points field does not.
`readyStatuses` (optional) lists the `project` board's statuses that mean
the work is delivered, before Done, such as `["LISTO PARA QA", "QA"]`: a
report moved there gets its "Resuelto" reply in the Slack thread as soon as
its ticket reaches one, without waiting for a merged PR. Without it, only
Done (plus a merged PR naming the ticket) tells the reporter.

**The backoffice repository's switch** is operator config in that repository,
not in this one: its `.ralph/config.json` points the coder loops at the intake
board, with the states its workflow uses for a claim and a finish,

```json
"tracker": {
  "kind": "jira",
  "site": "example.atlassian.net",
  "project": "OAI",
  "scopeLabel": "acme-backoffice",
  "states": { "claimed": "En curso", "done": "Listo" }
}
```

connected from the dashboard like any Jira project (see [Linear and Jira
projects](#linear-and-jira-projects)), and its block in `jav.json` lists the
three labels the clerk writes, routing each to the loops that should take it:

```json
"acme-backoffice": {
  "enabled": true,
  "labels": ["difficulty:easy", "difficulty:medium", "difficulty:hard"],
  "routes": { "rafa": ["difficulty:hard", "difficulty:medium"], "rulo": ["difficulty:easy"] }
}
```

`scopeLabel` keeps the backoffice loops off the board's `acme-pwa` tickets.

**Cutover**, in this order:

1. **Shadow week.** Set `intakeProject` with `mode: "shadow"`: the clerk
   classifies and records what it would file (shadow canvas, ledger events
   marked shadow) and writes nothing to Jira or Slack.
   Optionally, a **quiet** run next (`mode: "quiet"`, see [Quiet
   mode](#quiet-mode)): real tickets on the intake board from the real
   channel, the sweep acting on confirmations, nothing in Slack and nothing
   on OA.
2. **Live.** Stop the loop, merge `"mode": "live"` and the channel's `canvas`,
   run `bun ~/ralph/clerk/cursor.ts --now` in the loop's worktree so nothing
   classified in shadow is filed again, and start it.
3. **The coder loops.** Merge the backoffice repository's `tracker` and Jav
   change, connect its Jira credential from the dashboard, and restart its
   loops. Until then nothing on the intake board is picked up, which is safe:
   confirmed tickets wait with `ready-for-agent`.

**Linear.** The clerk files nowhere else: its Linear filing, dedupe and
canvas path was removed (felipearos/ralph#466). It was never live there, so
there was nothing to drain; any `slack-intake` issue filed in Linear by hand is
left where it is. The triager's keyed Slack intake on Linear or Jira (#396,
#397, see [Linear and Jira projects](#linear-and-jira-projects)) is unchanged.

### Slack intake on a Jira board

With `clerk.jira.intakeProject` set (felipearos/ralph#443), the clerk files
every report onto a Jira project of its own, the **intake board**, instead of
Linear, and a person confirms each ticket there before anyone works on it.
There is no triager on this pipeline: the clerk classifies in one pass and the
person on the board is the review.

1. **clara files it** in "Por confirmar" with a Spanish spec-style description,
   type, priority, app, difficulty, suggested story points and who does it,
   labelled `slack-intake`, the app's repo label (`acme-backoffice`,
   `acme-pwa`), `difficulty:easy|medium|hard` and `para-agente` or
   `para-persona`. What it determined is kept in the clerk's store.
2. **A person confirms it** on the board: fixes any field that is wrong
   (changing `para-agente`/`para-persona` changes who does it) and moves it to
   "Confirmado", or to "Descartado".
3. **The gate acts on it** at its next poll ([`clerk/confirm.ts`](clerk/confirm.ts)):
   a confirmed `para-agente` ticket gets `ready-for-agent` and stays on the
   board; a confirmed `para-persona` one is filed on the OA board, gets
   `moved-to-jira` and moves to "Movido". Every field the person changed is
   kept in the metrics ledger with both values.
4. **A coder takes it** off the intake board like any ready ticket: the
   frontier gates on `ready-for-agent` and Jav routes on the difficulty label,
   so a ticket nobody has confirmed is offered to no loop
   ([`frontier/intake-board.test.ts`](frontier/intake-board.test.ts)).
5. **The outcome is recorded** ([`clerk/outcomes.ts`](clerk/outcomes.ts),
   felipearos/ralph#450). After the sweep, every poll reads the board's
   tickets in Jira's done category (at most 100, other than the rejected and
   moved ones) and the OA tickets the sweep moved (by key, 50 per search, at
   most 100 a poll, the least recently read first) and writes one `closed`
   event per ticket with its resolution and status. A report confirmed and
   closed with a resolution that kept the work is **valuable**; one ignored,
   a duplicate, rejected, or closed as Won't Do, Won't Fix, Duplicate, Cannot
   Reproduce or Descartado is **noise**. It only reads, so it runs in shadow
   too, and a Jira failure is a note in the supervisor log and a retry at the
   next poll, never a stop. `bun ~/ralph/clerk-metrics.ts [--json] [--by
   reporter|app|week] [--since YYYY-MM-DD]` summarises the ledger
   (`<git-common-dir>/ralph/clerk/<loop>.metrics.jsonl`). A live clerk also
   tells the reporter: a confirmed ticket closed as
   valuable gets one reply in its Slack report's thread, "Resuelto: OAI-22 ya
   está listo. Gracias por reportarlo." (the OA key for a report moved
   there), once a merged PR in `clerk.prRepos` names the ticket (its OA or
   intake key): done in Jira is not shipped while a person still reviews the
   PR, so the reply waits for the merge, for up to 30 days. A Won't Do close,
   a rejection and a ticket filed by hand get none; shadow and quiet post none. The reply is queued in the clerk's store with
   the close and the thread is read for it before each post, so a rerun or a
   kill posts it once; a Slack failure is a note and a retry at the next poll,
   for up to 7 days after the merge.
6. **Moves merged work** (`clerk/merged.ts`), quiet and live, when
   `clerk.jira.mergedStatus` names a status ("Mergeado" on OAI): a worked
   intake ticket (any status but the confirmation's four) that a merged PR in
   `clerk.prRepos` names takes the transition there. The coder loops on
   `merge: "human"` projects leave a handed-off ticket in its work status, so
   this is what tells the board a person merged it. A ticket still waiting
   for, or just past, its confirmation is never moved by a PR that names it.
   The status is in the done category, so the outcome scan records the close
   and tells the reporter on the same poll. Absent, nothing moves.

**The Jira project** is the operator's to create, once, on the clerk's site:
a project (key `OAI` in the fixtures) whose workflow has the statuses
"Por confirmar" (where a ticket is created), "Confirmado", "Descartado" and
"Movido" (both done category), plus the coder loops' claimed and done states
("En curso" and "Listo" below), with transitions from "Por confirmar" to
"Confirmado" and "Descartado", from "Confirmado" to "En curso", "Movido" and
"Descartado", and from "En curso" to "Listo". A board with no "Movido" closes a
moved ticket by any done transition instead. Add a story points field to the
create and edit screens if the points should land in a field; without one they
go in the description as `Puntos de historia sugeridos: N`. The clerk's
`RALPH_CLERK_JIRA_TOKEN` needs to browse, create and edit issues and
transition them on both boards.

**The `clerk.jira` keys**, in the clerk project's `.ralph/config.json`:

```json
"jira": {
  "site": "example.atlassian.net",
  "project": "OA",
  "intakeProject": "OAI",
  "storyPointsField": "customfield_10016",
  "statuses": { "pending": "Por confirmar", "confirmed": "Confirmado", "rejected": "Descartado", "moved": "Movido" }
}
```

`project` is the person board a confirmed `para-persona` ticket moves to.
`storyPointsField`, `statuses` and `mergedStatus` (a done-category status the
board's work statuses can reach, such as "Mergeado") are optional (the
statuses default to the names above); preflight checks that the board is readable, that each status
exists, and warns when the points field does not.
`readyStatuses` (optional) lists the `project` board's statuses that mean
the work is delivered, before Done, such as `["LISTO PARA QA", "QA"]`: a
report moved there gets its "Resuelto" reply in the Slack thread as soon as
its ticket reaches one, without waiting for a merged PR. Without it, only
Done (plus a merged PR naming the ticket) tells the reporter.

**The backoffice repository's switch** is operator config in that repository,
not in this one: its `.ralph/config.json` points the coder loops at the intake
board, with the states its workflow uses for a claim and a finish,

```json
"tracker": {
  "kind": "jira",
  "site": "example.atlassian.net",
  "project": "OAI",
  "scopeLabel": "acme-backoffice",
  "states": { "claimed": "En curso", "done": "Listo" }
}
```

connected from the dashboard like any Jira project (see [Linear and Jira
projects](#linear-and-jira-projects)), and its block in `jav.json` lists the
three labels the clerk writes, routing each to the loops that should take it:

```json
"acme-backoffice": {
  "enabled": true,
  "labels": ["difficulty:easy", "difficulty:medium", "difficulty:hard"],
  "routes": { "rafa": ["difficulty:hard", "difficulty:medium"], "rulo": ["difficulty:easy"] }
}
```

`scopeLabel` keeps the backoffice loops off the board's `acme-pwa` tickets.

**Cutover**, in this order:

1. **Shadow week.** Set `intakeProject` with `mode: "shadow"`: the clerk
   classifies and records what it would file (shadow canvas, ledger events
   marked shadow) and writes nothing to Jira or Slack.
   Optionally, a **quiet** run next (`mode: "quiet"`, see [Quiet
   mode](#quiet-mode)): real tickets on the intake board from the real
   channel, the sweep acting on confirmations, nothing in Slack and nothing
   on OA.
2. **Live.** Stop the loop, merge `"mode": "live"` and the channel's `canvas`,
   run `bun ~/ralph/clerk/cursor.ts --now` in the loop's worktree so nothing
   classified in shadow is filed again, and start it.
3. **The coder loops.** Merge the backoffice repository's `tracker` and Jav
   change, connect its Jira credential from the dashboard, and restart its
   loops. Until then nothing on the intake board is picked up, which is safe:
   confirmed tickets wait with `ready-for-agent`.

**Linear intake issues** already filed are not migrated. The clerk was never
live on Linear, so there are none to drain; any filed by hand are left where
they are.

### The verifier

A `verifier` loop (felipearos/ralph#560) follows merged pull requests into
production and checks each one against the ticket it closed: did the change
work for a real user, and did it break anything. It writes no code. Its session
runs one check-in at a time — it signs in to production as the test account
and walks the ticket's acceptance criteria — and code does everything else:
the gate (`verifier/gate.ts`) finds the merges, waits for their deploys, reads
Sentry and traffic, computes the verdict (`verifier/verdict.ts`) and makes
every tracker write and, in act mode, the revert. A project adds one with
`{ "name": "veri", "role": "verifier" }` on the roster and a `verifier` block
in `.ralph/config.json`; [`adding-an-agent.md`](adding-an-agent.md) walks the
setup, credentials and preflight: the gate alone holds the Sentry read token
and, for a Vercel deploy source, the Vercel one, and the session signs in with
the test account in the `ui-shots` credential store.

**What it watches.** A merged pull request opens a watch when it merged within
`windowHours` and closes a tracker ticket (a GitHub closing reference or a
`Closes|Fixes|Resolves #n` line; on Linear or Jira, a `Ticket: KEY-n` line).
Skipped: journal and learnings commits, ci-doctor and pr-medic pull requests,
the verifier's own reverts, loop pull requests (`🤖 <Name> loop` in the body)
when `follow.loopPrs` is false, and anyone else's when `follow.humanPrs` is
false. The watch is anchored on the production deploy that contains the merge
commit, not on the merge: it opens only once that deploy has landed, and the
check-ins (`checkIns`, default 1, 6 and 24 hours) are timed from the deploy.
Each pull request is watched at most once.

**Verdicts.** Each check-in yields one; the first terminal one ends the watch (an
`inconclusive` before the last check-in does not).

| Verdict | Means |
| --- | --- |
| `pending` | Nothing wrong yet and more check-ins are due. |
| `verified` | The last check-in found nothing wrong and the acceptance check ran; with `trafficFloor` on, production also exercised the change. |
| `unexercised` | Nothing went wrong, but with `trafficFloor` on the changed routes saw no traffic, so nothing was proven. |
| `inconclusive` | At the last check-in: Sentry or traffic (with the floor on) was unreachable, no changed route could be measured with the floor on, or the acceptance check never ran, recorded nothing or was itself inconclusive. An earlier check-in that cannot see a signal is also recorded as `inconclusive`, but the watch stays open for the next one. |
| `ticket` | A failed acceptance criterion, or a new Sentry issue that does not meet the revert rule: a linked fix ticket. |
| `revert` | The change is clearly the cause of real harm; see the revert rule below. |
| `needs-human` | A third failed round on the same root ticket: the loop has tried twice. |

An issue is **new** when Sentry first saw it after the deploy, or its rate
since the deploy is at least `revert.rateFactor` times its rate before. Older
issues are noise. "Not verifiable live" on a criterion never fails it.

**The revert rule.** A verdict is `revert` only for a hard break at the
acceptance check (a 500 on the changed page), or a new Sentry issue that is
all of: attributable to this pull request (its frames or routes overlap the
files or routes it changed), not shared with another pull request in the same
deploy, and over the impact bar — `revert.minEvents` events or
`revert.minUsers` distinct users, the test account's own excluded. Anything
less is a `ticket`. An unreachable Sentry or traffic signal is never a revert:
it waits for the next check-in, and at the last one it is `inconclusive`.
The verifier never reverts a pull request that is itself a revert, one already
reverted, or one whose revert conflicts; each of those becomes an urgent fix
ticket with a push and a comment instead.

In act mode the gate opens the revert from `verifier/revert-<pr>`; its body
says `Reopens <root>`, never `Closes`. Where the project's `merge` is `loop`
and `verifier.mergeCommand` is set, the gate waits until the revert is green
and mergeable and runs that command — the project's own gates, never another
way. Otherwise it only proposes the revert with a push, and a person merges
it — within 24 hours, or the watch gives up on it (below). The root ticket is reopened (`ready-for-agent` and a comment with the
evidence) only once the revert has merged, so no coder fixes forward on a base
that still holds the broken change. A revert closed unmerged, red, not merged within 24 hours of being opened
(whoever was to merge it), or refused by the merge command ends the watch
with a push and a comment, and leaves the root closed.

**The round cap.** A fix ticket carries its lineage, so the watch of the pull
request that closes it knows which failed round it is on. Rounds one and two
may file a ticket or revert; a third failure is `needs-human`: the root ticket
gets `needs-human` and a comment summarising every round, a high-priority
`verifier-alert` push goes out, and no fix ticket is filed.

**Labels.** Preflight's `loop-labels` check creates the five on the tracker
(GitHub, Linear or Jira); a label the tracker refuses to create denies
startup. `ready-for-agent` and `priority:urgent` are not created: a project
whose tracker lacks them (one with no coder or ci-doctor) must add them, or the
first fix ticket fails to file.
The verifier writes them only in `report` and `act` mode (see Modes below).

| Label | On | Applied | Removed |
| --- | --- | --- | --- |
| `following` | the watched ticket | when the watch opens, with one announce comment | when the watch settles |
| `verified`, `unexercised`, `inconclusive` | the watched ticket | at the verdict of that name, with a comment saying why | never |
| `needs-human` | the root ticket | at the round cap | by a person |
| `ready-for-agent` | the fix ticket; a reopened root | when a fix ticket is filed; when a revert has merged | not by the verifier |
| `priority:urgent` | the fix ticket | when the fix ticket stands in for a revert (report mode, or a revert act mode will not make) | never |

**Modes.** `verifier.mode` decides what a verdict may write:

- **`observe`** (the default) — verdicts are computed and recorded in the
  watch store; nothing is written to the tracker and no push is sent. What it
  would have done is recorded as `wouldHaveBeen` and shown under "would have
  acted" in the dashboard.
- **`report`** — the labels and comments above, a linked `ready-for-agent`
  fix ticket for `ticket`, and for `revert` an urgent fix ticket and a
  `verifier-alert` push. It never opens a pull request.
- **`act`** — what report does for every verdict but `revert`, which opens
  the revert pull request as described above instead of filing an urgent fix
  ticket; a push goes out only when the revert needs a person (proposed,
  refused, closed, red, stale or failed).

**Off.** `"enabled": false` in the `verifier` block switches the verifier off
without taking it off the roster (#789). The gate keeps polling and keeps
re-reading its rules from origin, so setting it back to `true` (or deleting
the key) applies on the next poll, with no restart. While it is off it does
nothing else: no merge is listed and no watch opened, no tracker write or
push is made, and no check-in is handed to a session; each poll logs
`verifier-gate: disabled in config — not watching merges or handing over
check-ins`. Watches already open stay in the store, and their check-ins due
meanwhile are handed over, late, once it is on again. A session still running
when it was switched off cannot record a decision (`checkin.ts decide` exits
3) or reach production (`acceptance.ts` exits 3, inconclusive). The
dashboard's Verifier sheet has an On/Off switch that saves at once, through
the same commit-or-PR path as the rules (`ralph: verifier rules — enabled
true → false`), and the verifier's card says `Off: disabled in config`.

A watch keeps the mode it was opened in: promoting or demoting a project
changes only the watches opened afterwards. Promotion is an edit of `mode`,
either from the dashboard's Verifier sheet or by hand. The sheet validates
the config and commits it straight onto the base branch, as a fast-forward
whose subject names the change (`ralph: verifier rules — mode observe →
report`); with `"configChanges": "pr"` in the project config, or when that
push is refused (a protected branch, a race), it opens a config pull request
instead (`ralph-roster/verifier-rules-*`, one at a time) and says why. The
JSON replaces all seven rule keys — a rule it leaves out goes back
to its default, and a left-out `enabled` is `true` — so pass every rule the
project has set, not only `mode`:

```bash
echo '{ "mode": "report", "checkIns": [1, 6, 24], "trafficFloor": true }' |
  bun ~/ralph/project-config.ts --set-verifier --at origin/main
```

which prints the whole config, validated, ready to commit. No restart is
needed: every poll the gate fetches `origin/<baseBranch>` (bounded, at most
once per poll interval) and reads its rules from
`origin/<baseBranch>:.ralph/config.json`, so a merged change applies on the
next poll and the log says `verifier-gate: rules changed on origin/main — mode
observe → report`. A config that does not parse or validate, a `verifier`
block that is gone, or a fetch that fails changes nothing: the gate keeps the
rules it last held and logs why once (`verifier-gate: rules may be stale — …`).
It keeps the last valid copy in the worktree's `.ralph/logs/live-rules-verifier.json`,
which a restarted gate and the check-in session both read while it is newer
than the worktree. A change outside the `verifier` block (the tracker, the
roster) still applies only when the gate restarts, which it does after every
hand-over. Run `observe` for about a week and read what it would have
done, then `report`, then `act`.

**The config block.** Every key, with its default where it has one:

```json
"verifier": {
  "enabled": true,
  "productionUrl": "https://app.example.com",
  "deploy": { "source": "vercel", "project": "app", "team": "acme" },
  "sentry": { "org": "acme", "project": "app" },
  "windowHours": 24,
  "checkIns": [1, 6, 24],
  "trafficFloor": true,
  "revert": { "rateFactor": 5, "minEvents": 10, "minUsers": 2 },
  "follow": { "loopPrs": true, "humanPrs": true },
  "mode": "observe",
  "language": "en",
  "mergeCommand": ["pr", "merge", "{pr}", "--squash"]
}
```

`productionUrl`, `deploy` and `sentry` are required. `deploy.source` is
`vercel` (`project` required, `team` optional) or `github-deployments`
(`environment`, default `production`). `checkIns` are hours after the deploy,
strictly ascending, none past `windowHours`; a `windowHours` under 24 needs its
own `checkIns`. `follow.loopPrs` and `follow.humanPrs` may not both be false.
`language` defaults to `screenshots.locale`, else `en`. `mergeCommand` has no
default: without it, act mode only proposes its reverts. `enabled` defaults to
`true` (see Off above). The settings form and `--set-verifier` edit only
`enabled`, `windowHours`, `checkIns`, `trafficFloor`, `revert`, `follow` and
`mode`; the rest are hand edits.

**Operator tools.**

```bash
bun ~/ralph/verifier/following.ts --json   # every watch, open and finished
bun ~/ralph/verifier/gate.ts --once        # one real poll: 0 work, 1 none, 2 config error
```

Run both in the loop's worktree. `following.ts` only reads. `gate.ts --once`
is not a dry run: it does the gate's real work — opens watches, makes report
and act mode's tracker writes and reverts, and leases a due check-in no session
will decide — so inspect with `following.ts`. The watches live in
`<git-common-dir>/ralph/verifier-watches.json`, shared by the loops on the
host. The dashboard's Following panel shows them — in progress, finished,
would have acted, not verifiable live
([`dashboard/README.md`](dashboard/README.md)).

### The sentinel

A `sentinel` loop (felipearos/ralph#678) watches the project's error reporter
and files a diagnosed ticket for each new or regressed production error worth
one. It writes no code. Its session diagnoses one reporter issue at a time —
it reads the evidence the gate stored and the code, read-only, and drafts a
title and body — and code does everything else: the gate (`sentinel/gate.ts`)
reads the reporter, decides what qualifies, files the ticket, dedupes and
comments on recurrences. A project adds one (run one per project; nothing
enforces it) with `{ "name": "senti", "role": "sentinel" }` on the roster and
a `sentinel` block in `.ralph/config.json`;
[`adding-an-agent.md`](adding-an-agent.md#a-sentinels-prerequisites) walks the
prerequisites, the read-only Sentry token among them (its variable is named
in step 10 there). The gate alone holds that token, and reaches the reporter
through the `Reporter` interface in [`reporter/`](reporter/) (Sentry today);
the session never holds it.

**What qualifies.** Each poll lists the reporter's issues seen inside
`lookbackHours` and keeps the ones that are all of:

- `unresolved`. Ignored, muted and resolved issues are left alone until Sentry
  reports one regressed, which makes it unresolved again.
- new (first seen inside the lookback) or regressed.
- over the bar inside the lookback: `events >= minEvents` or
  `users >= minUsers` (defaults 10 and 2).
- not already drafted or filed in the store.

The oldest `firstSeen` goes first. When nothing qualifies the poll is idle and
no session is spawned.

**The session.** One issue per session. The gate leases the issue, reads its
evidence (the trace, tags and breadcrumbs of its latest event), stores it, and
hands the case over in `RALPH_INTAKE_CASE`. The session prints the evidence
with `bun "$RALPH_HOME/sentinel/issue.ts" show`, reads the code read-only, and
records its ticket with
`bun "$RALPH_HOME/sentinel/issue.ts" draft --title … --body-file …` (a title
of at most 200 characters). It writes only the store; the gate files the draft
on its next poll and adds the markers, the Sentry link and the label. Its rails
are `sentinel/orchestrator-settings.json`, probed by
`claude-executor-rails-probe.sh`.

**`ready-for-human`.** Every ticket the sentinel files carries
`ready-for-human`, never `ready-for-agent`: it is a model's diagnosis of
production, so a person reads it before any coder may take it. The frontier
already keeps loops off `ready-for-human`.

**Modes.** `sentinel.mode` decides what the gate may write:

- **`observe`** (the default) — drafts and would-be recurrence comments are
  recorded in the store; nothing is written to the tracker and no push is
  sent. A draft recorded in observe mode is never filed later, and its issue
  is never handed to a session again, so switching to file mode does not
  flood the tracker with weeks of would-have-beens — and an error drafted
  during the observe week gets no ticket after the switch, however often it
  keeps firing, unless it regresses after a close.
- **`file`** — drafts are filed as `ready-for-human` tickets, and recurrences
  are commented or filed as below.

**Off.** `"enabled": false` in the `sentinel` block switches the sentinel off
without taking it off the roster (#789). The gate keeps polling and keeps
re-reading its rules from origin, so setting it back to `true` (or deleting
the key) applies on the next poll, with no restart. While it is off it reads
no reporter and writes nothing: no draft or templated fallback is filed, no
recurrence is commented or filed, no cap alert is paged, and no issue is
handed to a session; each poll logs `sentinel-gate: disabled in config — not
polling Sentry`. A session still running when it was switched off cannot
record its draft (`issue.ts draft` exits 3). Issues that qualified while it
was off are picked up afterwards if they are still inside `lookbackHours`.
The dashboard's Sentinel sheet has an On/Off switch that saves at once,
through the same commit-or-PR path as the rules (`ralph: sentinel rules —
enabled true → false`), and the Sentinel panel and the sentinel's card say
`Off: disabled in config`.

The switch is an edit of `sentinel.mode`, either from the dashboard's
Sentinel sheet or by hand. The sheet validates the config and commits it
straight onto the base branch, as a fast-forward whose subject names the
change (`ralph: sentinel rules — mode observe → file`); with
`"configChanges": "pr"` in the project config, or when that push is refused
(a protected branch, a race), it opens a config pull request instead
(`ralph-roster/sentinel-rules-*`, one at a time) and says why. The JSON replaces
all six rule keys — a rule it leaves out goes back to its default, and a
left-out `enabled` is `true` — so pass every rule the project has set, not
only `mode`:

```bash
echo '{ "mode": "file", "minEvents": 10, "minUsers": 2, "maxPerDay": 5, "lookbackHours": 24 }' |
  bun ~/ralph/project-config.ts --set-sentinel --at origin/main
```

which prints the whole config, validated, ready to commit. The settings form
and `--set-sentinel` edit only `enabled`, `lookbackHours`, `minEvents`,
`minUsers`, `maxPerDay` and `mode`; `reporter` and `language` are hand edits. No restart
is needed: every poll the gate fetches `origin/<baseBranch>` (bounded, at most
once per poll interval) and reads its rules from
`origin/<baseBranch>:.ralph/config.json`, so a merged change applies on the
next poll, a new `reporter` project included, and the log says
`sentinel-gate: rules changed on origin/main — mode observe → file`. A config
that does not parse or validate, a `sentinel` block that is gone, or a fetch
that fails changes nothing: the gate keeps the rules it last held and logs why
once (`sentinel-gate: rules may be stale — …`). The last valid copy is kept in
the worktree's `.ralph/logs/live-rules-sentinel.json`; a restarted gate and the
drafting session (`sentinel/issue.ts`, which records the mode a draft was made
in) read it while it is newer than the worktree, so they agree with the gate.

**Dedupe.** Every filed body ends with the Sentry link and two markers:
`<!-- ralph-sentinel: sentry:<id> -->` for a person reading it (a later cycle
adds ` cycle <n>`), and a one-word search token
(`<!-- ralphsentinelsentry<id>end -->`, `r<n>` before `end` for a later cycle)
that the tracker's body search matches reliably. Before it hands an issue over
or files it, the gate searches the tracker for that token and adopts a ticket
it finds, so a lost store or a gate that died between create and record never
files twice.

**The cap.** In file mode at most `maxPerDay` tickets are filed per UTC day.
At the cap the gate takes no new issue, and the rest wait until the next UTC
day — drafts unfiled, issues not yet handed over still `observed`. When any
are waiting, one `sentinel-alert` push ("Sentinel daily cap reached") goes out
that day.

**Recurrence.** Each poll also reads the state of up to ten filed tickets
whose issue is still unresolved, least recently checked first:

- An open ticket gets one comment a UTC day when the issue's events in the
  lookback at least doubled since the count last posted (or counted at filing).
- A closed ticket, unless it was closed as canceled (a duplicate or not
  planned), whose issue was seen after the close, is still over the bar, and is
  either flagged regressed by Sentry or seen more than 24 hours after the close,
  starts a new cycle: a new ticket whose body opens `Regressed after <ref>.` (`Regresión después de <ref>.` in
  `es`)
  and links the closed one, which is never reopened.

Observe mode reads the tickets too, and records each would-be comment instead
of posting it.

**The fallback.** An issue handed to two sessions that both ended without a
draft is never handed over again: code builds a templated "Not diagnosed."
ticket from the stored evidence, filed in file mode and recorded in observe
mode.

**The store.** `<git-common-dir>/ralph/sentinel-issues.json`, shared by every
worktree of the project and changed only by a locked read-modify-write. Each
issue is `observed`, `drafted` or `filed` (the type also allows `failed`, but
nothing sets it: an issue two sessions failed stays `observed` with two
attempts until the fallback drafts or files it); a per-day ledger counts the
cap. It is not a cache: never delete it to "reset" the sentinel.

**Operator tools.**

```bash
bun ~/ralph/sentinel/issues.ts --json                   # every issue in the store, and today's cap use
bun ~/ralph/sentinel/gate.ts --once                     # one real poll: 0 work, 1 none, 2 config error
bun ~/ralph/sentinel/credentials.ts --check-token sentry # 0 usable (or unproved), 1 refused
```

Run them in the loop's worktree. `issues.ts` only reads. `gate.ts --once` is not a dry run, in either
mode: a work answer leases the issue and spends one of its two session
attempts, so two by-hand runs on one issue send it straight to the templated
fallback; and in file mode it also files, comments and pages as a poll does. `--check-token` refuses a
token with any scope not ending `:read`, and hands over unproved (exit 0) a
token it cannot check because Sentry is unreachable. `ralph.sh` withholds a
token whose check fails, and a gate with no token logs every poll
`sentinel-gate: no Sentry token — … is not set at <time> — waiting 300s …` (`--once` prints `nothing to do — no Sentry token …`).
An unreachable reporter is the same: one quiet waiting poll, never a spawn and
never a stuck loop.

Rolling one out on loggd is in
[`adding-an-agent.md`](adding-an-agent.md#rolling-out-a-sentinel-on-loggd).

### The ci-doctor's diff guard

The doctor may make a flaky test reliable and a slow test fast. It may not buy
green by weakening a test, and it may not touch CI configuration at all. The
diff guard enforces that on the diff rather than in the prompt, because a
sentence in a brief has already failed once (see
[Delegated code generation](#delegated-code-generation)). It refuses a diff
that:

- touches a path outside `ciDoctor.fixScope`, or any `ciDoctor.neverTouch` path;
- adds `.skip`, `.only`, `.todo`, `.fails`, `.fixme`, `skipIf`, `runIf`, `xit`,
  `xdescribe` or a retry count — each counted **net within one hunk**, so
  moving or reindenting a line that already had one is not a refusal, but
  taking one off one test and putting it on another is;
- adds an `exclude` entry or drops a coverage threshold in a test runner's config;
- deletes an assertion or a test without replacing it, or deletes a test file;
- raises a timeout further than its evidence allows.

A raised bound is the one weakening move with a legitimate use — a whole-tree
walk needs more than the 5 s default — so it is permitted on three conditions:
the PR body carries a `timeout-evidence: ci=<t> local=<t>` line, the new bound
is at most 3× the worst observed CI duration, and it stays under the ceiling
for its kind (`ciDoctor.testTimeoutCeilingMs`, 30 s by default;
`ciDoctor.hookTimeoutCeilingMs`, 120 s).

The evidence is **one pair of times for the whole diff**, not one per test:
the PR body carries a single line, so a raise anywhere in the diff is judged
against the same worst observed duration. A diff raising bounds in two files
with very different runtimes should be two PRs.

**The ceiling is the control; the evidence is not.** The doctor writes its own
PR body, so the measured times are self-attested and the 3× rule binds only an
honest claim. What the evidence rule actually buys is that a raise cannot be
silent — the number has to be written down, next to the bound it justifies,
where a human reviewing the PR can see both. The ceiling is what binds the
dishonest case.

**The shipped defaults refuse loggd #1728**, the diff this guard was specified
around, and a project adopting it should know why before it meets the refusal.
That commit raises five bounds to 120 s: two `beforeAll` hooks, which the
120 s hook ceiling allows, and three `it(…)` bounds, four times the 30 s
per-test ceiling. A project whose conformance walks legitimately run that long
sets `ciDoctor.testTimeoutCeilingMs` to `120000`; the guard then accepts the
diff whole. Separately, #1728's real PR body carries no measured durations at
all — a bound raised *because* the walk timed out has no worst observed
duration to measure — so adopting the rule means those PRs must start carrying
a `timeout-evidence` line. Both points belong on felipearos/ralph#152, which
is where the rule and the acceptance criterion were written.

The **exact-revert exception** is for the auto-revert path: a diff
byte-identical to `git revert <culprit>` on the same base may leave the fix
scope, because it is the culprit's own change backwards rather than the
doctor's writing. Being the culprit's own change, it also skips the weakening
and timeout rules — reverting a commit that weakened a test is the point, not
a violation. It buys nothing against `neverTouch`, which is refused either
way.

Because the exception skips almost everything, only a caller that *generated*
the comparison may offer one. `ci-doctor/verify.ts --revert-of <sha>` derives
it from git; `guard.ts diff` has no such flag at all, because in the sandbox
its caller is the executor, which could otherwise clear any diff by offering
a copy of itself as the revert it reverts.

Both places that judge a diff run the same rules, in
`executor-guard/diff-guard.ts`:

```bash
# the verify phase: collects the diff itself, working tree and untracked included
bun ci-doctor/verify.ts [--base <ref>] [--revert-of <sha>] [--pr-body <file>] [--json]

# the doctor's executor, through the guard already on its PATH; diff on stdin
git diff | bun executor-guard/guard.ts diff --cwd . [--revert <file>] [--pr-body <file>]
```

Both exit `0` when the diff may land and `10` when it is refused, with the
findings on stderr. A refusal is a finding, not a crash: the fix goes back to
implement, or it is filed. On a diff it cannot read — a combined diff, or
anything that is not `git diff` output — it refuses rather than passing: a
guard whose default on confusion is "allow" is no guard.

The doctor's own iteration calls the first of those entry points:
`prompts/ci-doctor.md` §4 runs `ci-doctor/verify.ts` after the local gates and
reads exit 10 as a finding — the fix goes back to `implement`, or the case is
filed for the coders. The executor's entry point is reached through the same
brief, which states the guardrails the guard enforces.

`ciDoctor` is a validated key of `.ralph/config.json` ([Project config](#project-config)):
unknown keys are refused at both levels, every key is optional and falls back to
the harness's own default, and the whole block is refused unless the roster
names a `ci-doctor`. A project with no such loop that carries these rules has
configured nothing: every value here has a silent default, so the block would
look live while no loop of this project ever read it. `retry.perCandidate` and
`retry.perDay` may be lowered and never raised past 1 and 6: they bound what
the doctor spends on somebody else's CI. An empty `fixScope` or `neverTouch` is
refused rather than read as "no rules", because an empty list takes the
default, which is the whole scope.

The guard and the gate still READ the block leniently, each for its own reason:
`executor-guard/diff-guard.ts` is mounted into the sandbox and may import
nothing from the harness, and `ci-doctor/gate.ts` may be pointed at a project
whose config predates the key. Neither diagnoses a config it cannot parse —
`preflight.ts` has already refused the start by then.

## Commands

```bash
~/ralph/start.sh                        # background, waits for eligible work
~/ralph/ralph-once.sh                   # one watched iteration
~/ralph/ralph.sh 5                      # bounded foreground run
RALPH_WAIT_FOR_WORK=60 RALPH_MAX_ITERATIONS=10 ~/ralph/start.sh
bun ~/ralph/frontier/next.ts -- --dry-run   # inspect independent ready groups
```

Run bare, `frontier/next.ts` assigns every READY NOW ticket to the project's
owner, which is the operator's bulk claim. Inside a loop session (`RALPH_RUN_ID`
set, which `ralph.sh` exports) a run that is neither `--take-one` nor
`--dry-run` is read-only instead, as `--dry-run`, and says so on stderr: an
agent that ran it only to look once left every loop of a project waiting on
tickets the owner never took (#786). Loops claim through `--take-one`. The
fence covers the iteration's own session; a delegated executor or an
`inspect.sh` stage runs with a cleared environment that carries no
`RALPH_RUN_ID`, and is kept off the tracker by its rails instead.

`start.sh` is idempotent within a worktree and survives terminal closure. Its
worktree-local lock (`.ralph/logs/supervisor.lock`), and a check that the pid in
`.ralph/logs/supervisor.pid` is not a live supervisor of this worktree, prevent
duplicate supervisors. Where a systemd user manager answers, it runs the
supervisor in a transient user scope of its own,
`ralph-loop-<project>-<loop>.scope` (`<project>` is `RALPH_PROJECT_ID`, which
the dashboard's start route sets, else the worktree directory's name), so
`systemctl --user status ralph-loop-<project>-<loop>.scope` shows it and a kill
of the dashboard's cgroup leaves it running. A scope still held by a dead
supervisor's children is stopped before the name is taken again. Without
`systemd-run --user`, or when it refuses, it falls back to `nohup setsid`;
`loop.stdout` says which path it took. `RALPH_LOOP_SCOPE=off` forces the
fallback (the test suite sets it). A reboot is covered by the dashboard's
reconciler, which restarts every loop that died without choosing to stop and,
since #6, every loop the shutdown itself stopped: a supervisor's trap records
the SIGTERM a reboot sends it, and a SIGTERM recorded before the current boot
is restarted, while a Stop now or a `kill` after boot stays stopped
(`dashboard/README.md`, "A shutdown is restarted at the next boot").

Waiting does not consume an iteration; the cap counts spawned turns. All loops
on a machine run the same `~/ralph/ralph.sh`; each is told apart by its working
directory.

**Holding at the gate.** A gated coder or triager loop does not respawn on a
verdict its iteration already refuted. When an iteration ends `ALL_BLOCKED` or
`COMPLETE` on a frontier ticket or a closable spec the gate named, the
supervisor records that verdict in `.ralph/logs/gate-verdict.json`
(`gate-verdict-store.ts`), and the gate holds on it: it keeps polling, spawns
nothing, and logs each poll as `holding on an unchanged verdict`. The hold ends
when the verdict changes: another ticket or another kind is reported as work,
or a definite "nothing to do" (an empty or fully held frontier) releases it.
Unchanged means the same kind and ticket; a title edit or an `(open PRs
unreadable…)` note is still the same verdict. An undetermined or throttled poll
never releases a hold.

A hold has a budget, `RALPH_GATE_HOLD_BUDGET_HOURS` (default 48; a positive
whole number, or the supervisor refuses to start). Past it the supervisor
pushes one `gate-hold-exhausted` alert, and the loop reads `blocked` (needs
you) until the hold is released. It still spawns nothing.

The record survives a supervisor restart, unlike `backoff.json`. To unstick a
held loop by hand:

```bash
cd <worktree> && bun ~/ralph/gate-verdict-store.ts clear   # also: read, describe
```

A coder or triager loop no longer stops with `gate-disagreement` after two empty
iterations in a row, so the three pushes that halt raised are gone for those two
roles, on purpose. Every other role (ci-doctor, pr-medic, clerk, verifier,
sentinel) keeps that halt.
It also remains the fallback for a coder or triager when the record cannot be
written, or when the gate offers the held verdict again (the hold did not
take). An ungated `ralph.sh N` still stops on `ALL_BLOCKED`, and `--once` is
unchanged.

An iteration blocked only on something external (a CI or deploy provider
outage, blocked deployments) ends `<ralph>RETRY_LATER</ralph>`, and one that
leaves its shepherd PR exactly as it found it is treated the same way. The
supervisor then backs off with no model turn: `RALPH_BACKOFF_BASE_SECONDS`
(300), doubling to `RALPH_BACKOFF_MAX_SECONDS` (3600), polling the PR every
`RALPH_BACKOFF_POLL_SECONDS` (60) so a change wakes it early. Once a streak has
waited `RALPH_BACKOFF_BUDGET_SECONDS` (21600) it stops as blocked for a human.
A restart clears the backoff. See `backoff.ts`.

When two or more loops back off on one shared blocker (a `ci:<check>:<step>` or
`ref:<owner/repo#n>` key, escalated once on the host's blocker store), the wait
is shared: the interval holds at the ceiling, the budget runs from the
blocker's first sighting rather than per loop, and the first loop to see it
clear (the key's check passing on its PR or, when the episode began red there,
on a new base head; or the named PR merging) clears it for every waiter. A
shared episode that never clears still stops every loop, but only the first
records `backoff-exhausted`; the rest record `backoff-exhausted-shared`, which
pushes no second blocked notification.

A turn the account's usage limit rejected (the stream's `rate_limit_event`
with `status: rejected`, rendered `rate limit: rejected — five_hour`) ends at
once with no sigil. That is a wait, not a failure: the supervisor skips the
sigil recovery, keeps the claim, and waits with no model until the reset the
event names (`resetsAt`, else the "resets 10:30pm (<zone>)" text, else
`RALPH_USAGE_WAIT_DEFAULT_SECONDS`, 1800), plus `RALPH_USAGE_RESET_MARGIN_SECONDS`
(120), never longer than the limit's window and never shorter than
`RALPH_USAGE_MIN_WAIT_SECONDS` (60), so a retry is never back to back. The
dashboard shows the loop as parked on `usage-wait`; Stop now and pause still
reach it. The wait lives in `.ralph/logs/usage-wait.json` and survives a
restart, which would only hit the same limit (delete the file to retry now); it
does not spend the iteration cap. Only the Claude runner reports a limit this
way: the Codex orchestrator emits no `rate_limit_event`, so it stops as before.
See `usage-limit.ts`.

The account's limit only rejects at 100%, by which time the loops have spent
the week you meant to keep for yourself. A **plan usage stop** draws the line
earlier, in `.ralph/config.json`:

```json
"usageStop": { "percent": 80, "window": "seven_day", "hardPercent": 95 }
```

`window` is `seven_day` (the default) or `five_hour`; `hardPercent` defaults to
95, never below `percent`. A `loops` entry may carry its own
(`{ "name": "tria", "role": "triager", "usageStop": { "percent": 95 } }`) or
`"usageStop": null` to exempt that loop. Because utilisation belongs to the
account, different thresholds are priority tiers: a loop stopped at 60% leaves
the rest of the plan to the ones that stop at 90%. Without the key nothing
changes.

At `percent` the loop **drains**: it takes no new ticket and spawns only on
work it already holds (a PR of its own to shepherd, its unfinished claim, local
recovery work). Once nothing held is left, or at `hardPercent`, it **parks**:
no model, claim kept, until the window resets plus
`RALPH_USAGE_RESET_MARGIN_SECONDS`. Roles other than the coder have no held
work to drain, so for them the stop parks straight away. The reading is the
loop's own newest `rate_limit_event` for the window (events name no account,
and loops on one host may run on different ones), so a loop learns it crossed
the line only by spending, and may pass it by one iteration; it never aborts a
turn. No reading, a reading from a window that has since reset, or a check
that cannot run all mean "run". The dashboard shows the park as `usage-stop`
(blocked) and the drain as `usage-drain`; a park pages once (`usage-stop`
notification, never a ticket comment).

The committed value is read once at startup, so the live knob is a host-local
override in git's common directory (`ralph-usage-stop.json`), re-read at every
checkpoint (`RALPH_USAGE_STOP_RECHECK_SECONDS`, 300, while parked):

```bash
bun ~/ralph/usage-stop.ts show  --loop rafa                 # rule, source, reading, verdict
bun ~/ralph/usage-stop.ts show  [--json]                    # every roster loop, each from its own worktree;
                                                            # a worktree naming no roster loop is listed, not credited
bun ~/ralph/usage-stop.ts set   --loop rafa --percent 90    # or --loop '*' for the project
bun ~/ralph/usage-stop.ts set   --loop doc --off            # no stop, whatever the config says
bun ~/ralph/usage-stop.ts clear --loop rafa                 # back to the committed config
bun ~/ralph/usage-stop.ts waive --loop rafa                 # run past it until the window resets
```

The override wins over the config, the loop's entry over the project's (`*`).
Run it from the loop's worktree. The roster `show` gives each reading's age;
a `run` drawn from one older than an hour reads `unknown (stale reading)`,
since an idle loop's last number is not today's. A park or drain on an old
reading stands: usage only rises until the window resets. See `usage-stop.ts`.

The one block time will not clear by itself is a project host fence that
refuses a heavy local command while CI is busy, when a hard acceptance
criterion needs that command's output and no CI job produces it (loggd #1604:
a bundle measurement from two production builds). The loops are what keep the
host busy, so the session asks the supervisors for a quiet window instead: it
writes `.ralph/logs/host-lease-request.json` and ends
`<ralph>AWAIT_HOST <n></ralph>`. `host-lease.ts` queues the request FIFO; at the
head it holds every other loop of the project before its next model turn,
waits until none is inside one and no required check is pending on any open PR
or the base branch, grants the host for `RALPH_HOST_LEASE_SECONDS` (3600), and
the same session resumes with the answer. The lease is released when that turn
ends. It is narrow on purpose: one request per iteration, only for the claimed
ticket, `RALPH_HOST_LEASE_PER_TICKET` (2) grants and
`RALPH_HOST_LEASE_ASKS_PER_TICKET` (3) asks per ticket ever, one grant per loop
every `RALPH_HOST_LEASE_LOOP_COOLDOWN_SECONDS` (21600),
`RALPH_HOST_LEASE_SPACING_SECONDS` (1800) between leases, a queue of
`RALPH_HOST_LEASE_QUEUE_MAX` (2), and bounded waits
(`RALPH_HOST_LEASE_DRAIN_SECONDS` 5400, `RALPH_HOST_LEASE_QUEUE_SECONDS`
10800). A refusal or a timeout sends the ticket down the ordinary blocked path.
A loop held before its next turn looks at its control inbox every control-poll
slice and hands an operator command back to the supervisor's checkpoint, so a
Stop sent to a loop parked behind a sibling's lease is read within a slice
rather than after the lease.
`bun ~/ralph/host-lease.ts status` shows the holder and the queue.

All loops share one GitHub account, so the frontier keeps its request count
flat: open issues arrive with their blockers in one paged GraphQL query, and
the per-ticket reads that remain run `RALPH_FRONTIER_CONCURRENCY` (2) at a
time. A throttled read (GitHub's secondary limit, or a spent hourly quota)
waits out `Retry-After` or backs off with jitter for up to
`RALPH_FRONTIER_RATE_LIMIT_BUDGET_SECONDS` (120), then `--take-one` answers
`rateLimited: true` and exits 75. The iteration ends `RETRY_LATER` on it; the
gate logs "GitHub rate-limited the frontier read" and waits its poll interval,
doubling per throttled poll up to `RALPH_GATE_RATE_LIMIT_MAX_SECONDS` (1800),
with ±25% jitter. See `frontier/github-rate-limit.ts`.

An iteration yields at each boundary between its five phases (select,
implement, verify, review, finish): it writes a handoff note
(`.ralph/logs/phase-<n>-<phase>.md`) and ends with
`<ralph>PHASE <next> <n></ralph>`. The supervisor records the phase in the
loop state, appends the finished one to `.ralph/logs/phases/<n>.jsonl`, and
resumes the same session. `RALPH_PHASE_YIELDS` (12) bounds the boundaries one
iteration may take. See `phase.ts`.

At every boundary but `select → finish` (the shepherd path, which runs on a
closed ticket by design), a coder's supervisor first reads the
ticket's state (`tracker.ts view --json`, bounded by
`RALPH_RECOVERY_PROBE_TIMEOUT`). When it was closed outside the loops — a PR
merged by hand while the loop worked on it — the session does not go on into
the next phase: it is resumed once with a wrap-up that commits unpushed,
comments, drops the `-wip`, detaches and ends `DONE`, and the ticket's claim
lease is released. A read that fails or says anything but `closed` changes
nothing. No other role is probed: the pr-medic's phase number is a pull request's,
and a ci-doctor case has its own store to settle.

A pause or stop sent with `"scope": "phase"` (the dashboard's "At next phase")
takes effect at the next phase boundary rather than the next iteration, which
stays the default. A pause holds the loop there with the session intact —
no model runs and no tokens are spent while held, and the claim lease keeps
renewing — and resume continues the same session into the next phase. A stop
there ends the iteration with the claim kept and records the phase it stopped
before. See `controls.ts`.

While a loop is held at a phase boundary, `retry-phase` (the dashboard's
"Retry <phase>") runs the phase that just finished again, in a fresh session
whose prompt is the previous phase's handoff note plus that phase's sections of
`prompt.md` (`phase-prompt.ts`, which also builds the PR-wait and budget
sessions). It is refused, with the reason, anywhere else. The retry spends
from the iteration's token cap like any other session; its ledger line is the
next `attempt` of the phase and supersedes the earlier one without removing it.

Before any PR wait starts, `await-pr-check.ts` judges the number in
`AWAIT_PR <n>` (#807: a session waited on its issue, 2694, read off its branch
name, while its PR was 2768). When gh says `<n>` is no pull request at all, no
wait starts: the SAME session is resumed with the branch's open PR (or, with
none open, a request to open one) and a `pr-sigil-refused` event is recorded.
A real PR is never refused for belonging to another branch, since a session may
shepherd a queued PR from a checkout still on a different one.
`RALPH_AWAIT_PR_REFUSALS` (default 2) bounds the refusals per iteration; past
it, or whenever the check cannot judge (gh down), the wait starts as asked.

A gate before a named phase (`{"command": "arm-gate", "phase": "finish"}`, or
the dashboard's "Arm a gate before…") holds the loop for approval every time an
iteration reaches that phase; a gate before `select` asks at the top of each
iteration. It stays armed across iterations and supervisor restarts, in
`.ralph/logs/controls.json`, until `disarm-gate` names the same phase. The hold
is an ordinary approval: `approve` continues the same session into the phase,
and `deny` ends the iteration there with the claim kept and the stop recorded,
as a phase stop does. With no gate armed, nothing changes.

An iteration cut off between phases (a phase stop, a gate deny, Stop now, a
crash, a restart) is resumed from the phase after the last one it finished. Each ledger
line records the branch and head the phase finished on. When the next
iteration resumes this loop's claim, or the ticket Stop now interrupted,
`phase-prompt.ts resume` checks the ledger against the worktree: same branch,
the head still in its history, the handoff note on disk. If it agrees, the
iteration starts a fresh session at the next phase, and the dashboard shows
"resuming at `<phase>`". That session enters its phase across the phase's
boundary, so a phase pause or stop, an armed gate or `retry-phase` still
applies there: a gate denied before `finish` is asked again, not skipped. A missing, stale or mismatched ledger falls back to
the whole prompt and §1's claim recovery, and the supervisor log and the
iteration's record say why. DONE, `release` and `abandon` clear the ticket's
ledger and notes.

`RALPH_PROJECT` may be exported to point a command at a project other than the
current directory's; the supervisor exports it (and `RALPH_HOME`) to every child.

### Marking a hand-applied migration

A coder may not apply a migration. When its diff carries one it parks the
work as a draft pull request and blocks the ticket with a comment that starts
`needs-migration:` (`prompt.md` §6), naming the PR and the migration file. That
comment ends with the command to run once the SQL is applied to production by
hand, with the paths already filled in:

```bash
cd /path/to/project-worktree && bun /path/to/ralph/migration-applied.ts 1242
```

Run it from the project's worktree, since it reads the project's tracker and
GitHub repository from there. It reads the ticket's newest block record and
refuses, writing nothing, unless that record is a `needs-migration` block that
names a PR. Otherwise it writes four things, in this order:

1. a comment on the ticket that the migration was applied, carrying a marker;
2. removal of every `*-blocked` label the ticket carries (its `*-wip`, if any,
   is left alone);
3. the `migration-applied` label on the ticket and on the PR. The label is
   created on the GitHub repository first, because on a Linear or Jira project
   the tracker's label is not the repository's and `gh pr edit` refuses a label
   the repository lacks;
4. `gh pr ready <pr>`, last, so the PR is not shepherdable before the ticket
   is unblocked. A merged or closed PR is never readied.

Every step is decided from what the tracker and GitHub show now, so a run
that dies part-way is finished by running it again, and a second run on a
finished ticket writes nothing. The marker only stops a second comment. A
ticket blocked again on a new migration after an earlier apply gets a new
comment.

Exit codes: 0 done or nothing to do; 1 refused, or a write failed; 2 usage;
69 the project's tracker is not connected; 75 GitHub or the tracker throttled
it.

Nobody creates the `migration-applied` label by hand: coder preflight creates
it on the project's tracker (the coder role declares it in `roles.ts`), and
the command itself runs `gh label create` on the GitHub repository whenever
the ticket or the PR still lacks the label, treating "already exists" as done.

### Operator dashboard

```bash
bun ~/ralph/dashboard/server.ts          # http://127.0.0.1:8791
```

A local-only, read-only page showing all four loops at once, with each loop's
token usage (`usage.py --json --no-record`) and recent journal entries. It binds
`127.0.0.1`, consumes the same read-only projections as the CLI, and never
writes loop state. See [dashboard/README.md](dashboard/README.md) for its
configuration.

### Lineup editor

```bash
bun ~/ralph/lineup/server.ts             # http://127.0.0.1:8792
```

The local-only lineup editor page and its HTTP adapter: edit each loop's
stages — one project's keys at a time — from a form constrained by the runtime schema, preview the resolved
lineup with sources and env overrides, and save. Read the current
`models.json` with each stage's resolved model, runner and `source`; re-resolve
a candidate; commit a validated one atomically. Every read, preview and save
spawns `ralph/models.ts` (`--json`, `--schema`, `--validate`) through a single
runtime adapter — the handlers import no `ralph/*.ts` and hold no validation
logic — and a save takes effect at the next `start.sh`, never mid-turn. See
[lineup/README.md](lineup/README.md) for its configuration and HTTP surface.

### Keeping models current

`models.json` names a full id per stage, so a loop pinned to `claude-opus-5`
keeps running it after `claude-opus-5-5` ships, and nothing says so (#851).
The dashboard's **Agents** page lists every block of the project — and the
file's own `default` — with a stage on an older Claude id than its family's
latest, and asks per block:

| Answer | What it writes | Asked again |
| --- | --- | --- |
| Update to … | the outdated stages' `model`, nothing else | when the next model ships |
| Not now | `updates.snoozedUntil` = now + 7 days | after the snooze |
| Skip … | the latest ids into `updates.skip` | only for a newer id |
| Never for … | `updates.policy: "pinned"` | never (Ask again undoes it) |
| Always update … automatically | `updates.policy: "auto"`, and moves now | never |

"Latest" is the installed Claude Code's own `latest_per_family` map (what
`--model opus` means on this host), read out of the binary even when `claude`
on `PATH` is a wrapper script; `models.ts` `ALIASES` answers only when no
binary can be read. Only `claude`-runner stages with a `claude-<family>-<n>`
id are moved; aliases, other runners and fallback chains are left alone, and
nothing is ever moved to an older id. A missing `updates` object means
`ask`; a malformed one is read as `pinned`, so a bad file never changes a model.

A change applies when the loop next starts: `ralph.sh` runs
`model-updates.ts --apply-auto --project <id>` before it resolves the lineup,
moves the project's `auto` blocks, and logs one line per change. That step is
best effort — if it fails, the loop starts on the lineup as configured and the
log says why. Nothing here restarts a loop.

```bash
bun ~/ralph/model-updates.ts --json --project loggd          # every block, its outdated stages and policy
bun ~/ralph/model-updates.ts --answer skip --project loggd --block testo
bun ~/ralph/model-updates.ts --answer pin --file-default     # the file's own default block
```

### Jav: difficulty routing

`jav.json` in the harness (beside `models.json`) says which loop takes which
kind of ticket, per project: one block per project id, plus an optional
`default` block for a project with none. It is off when the file, or the
project's block, is absent. Edit a project's block from its dashboard
**Routing** page, which writes that project's block and no other, or by hand:

```json
{
  "loggd": {
    "enabled": true,
    "labels": ["difficulty:easy", "difficulty:hard"],
    "routes": { "ralph": ["difficulty:hard"], "rafa": ["difficulty:hard"],
                "default": ["difficulty:easy"] }
  }
}
```

A route may only name a **coder**: a triager or a ci-doctor never picks from the
frontier, so `routes.tria` is refused, and a `default` route counts as draining a
label only when some coder actually falls back to it. A block written before roles
that routes a non-coder must have that key deleted **by hand** — every loop's pick
fails until it is, and the Routing page lists no row for the offending loop, so it
cannot untick it for you. Claim labels go the other
way — every roster loop's `-wip`/`-blocked`/`-done` is refused as a difficulty
label, whatever the loop's role.

A loop's labels resolve `routes.<loop>`, then `routes.default`, in its
project's block, else in the `default` block. The project id is
`RALPH_PROJECT_ID` (the supervisor exports it), else the directory name of the
repo's main checkout (`loggd`). A file from before project keys (one unkeyed
block) is moved under `loggd` on its first read. When it is on, `--take-one` offers a loop only the tickets that carry one of
its labels. A ticket with none of the configured labels is untriaged, and no
loop picks it. A loop with no route picks nothing, so its gate waits.

Two labels — `priority:urgent` and `ci-health` — **exempt** a ticket routing
would otherwise strand, meaning one that carries none of the configured
difficulty labels at all: routing keeps such a ticket for every loop that takes
anything. Those two mark the ci-doctor's filings for the coders, and routing
them does the opposite of what they are for. A red base branch blocks the merge
queue for every loop, so the one lane that puts it in front of the queue must
not be the lane nobody is offered, and the doctor cannot label its own filings
because a regression's difficulty is not knowable from the failure.
`ci-health` rather than `priority:urgent` alone is what extends the exemption to
the forward fix and the `fix-failed` hand-off, which carry no urgency
(`CODER_FILING_LABELS`, felipearos/ralph#233). The exemption is by label, not by
author, so a human filing a regression by hand gets the same lane, and so does
any other unlabelled ticket somebody marks urgent — the lane is the operator's
to use, and only an operator or the doctor can apply the label
(`NEVER_TOUCHED_LABELS`); every label a filing carries is reserved, so no
project can route on one and turn the exemption off by accident; a loop with no
route at all still picks nothing; and the triager's routing bucket skips an
exempt ticket, since there is no difficulty for it to apply.

The exemption is narrow on purpose: an urgent ticket a triager HAS labelled is
filtered like any other, because some loop takes it and the lane puts it first
there — rescuing it everywhere would hand hard work to a small model on the
strength of its urgency. Only a ticket no route could match is rescued. Loops read
the file on every pick, so a change applies without a restart. A broken file is
reported as the pick's `error`, never read as "off". `bun ~/ralph/jav.ts --json`
prints this project's block with its problems. `RALPH_JAV` points at a different file.
Applying the labels is the **triager's** work, not Jav's: one of this same
`labels` list per ticket, added through `triage-apply.ts` like any other label
it sets (see [Roles](#roles) and [The triager's intake](#the-triagers-intake)).
Jav never applies a difficulty label; it only routes on the ones already there,
and a project running no triager applies them by hand.

### The triager's intake

`--take-one --role triager` asks the same frontier the same way a coder does —
one GraphQL census, one claim lock, the same `<loop>-wip` and the same lease —
but hands over a **unit** rather than a ticket, from the first non-empty of five
buckets:

| # | Bucket | What it offers |
|---|--------|----------------|
| 1 | Staffing | a spec parent whose tree holds somebody and still has a child with no `## Staffing group` |
| 2 | Routing | up to `RALPH_TRIAGE_ROUTE_BATCH` (10) tickets carrying none of the project's Jav labels, bar the ones routing exempts |
| 3 | Intake | an issue labelled `needs-triage`, or carrying no state label at all |
| 4 | Oversize | a queued ticket past the split thresholds (`RALPH_TRIAGE_SPLIT_CRITERIA`, default 8 acceptance-criteria checkboxes; `RALPH_TRIAGE_SPLIT_SURFACES`, default 3 of web/mobile/api/db) |
| 5 | Rescue | a ready ticket a coder parked with its `<loop>-blocked` for an ordinary reason, due again under `RALPH_TRIAGE_UNBLOCK_DAYS` (7) |

The order is what is STALLED, not how much work each holds: an ungrouped tree
makes coders collide, and with Jav on an unlabelled ticket is invisible to every
coder unless routing exempts it. Rescue is last for the same reason rather than despite it — a parked
ticket is already in front of a person, so it is the one bucket where waiting an
iteration costs nothing that was not already lost. A routing unit's whole batch is claimed under one lock, and a unit that
loses some of its tickets to another triager still takes the rest.

`--dry-run --json` reports every bucket's size under `triage`, not just the one
the intake would hand over, so a reader can see the backlog behind the leading
bucket. `triage.routing` is `untriaged` after the fences below, so it is never
larger than it.

No bucket offers a ticket somebody already holds, one either of the plan's
lists fences out (a triager is fenced off the **Parent closure exceptions** too,
where a coder treats them as a maintenance task), one this project's owner did
not open, one carrying any loop's `-blocked` — Rescue excepted, since lifting
one is its whole subject — or one whose triage decision still stands. That last is a marker the triager leaves on
its own comment:

```
<!-- ralph:triage attempt=1 outcome=routed body=3f2a1c9e5b70 -->
```

`body=` is a hash of the issue body the decision was made against, so an edit —
or anyone's later comment — brings the issue back. Two attempts ending
`outcome=gave-up` retire it until a person intervenes.

An apply adds `loop=`, `unit=`, `op=` and `labels=` to the same marker. They are
extra fields the reader ignores, deliberately: a second marker format would not
parse here, and the issue would then sit in the intake bucket forever.

### Applying a triage decision

A triager never runs `gh issue edit`, `create` or `close`. It writes the
decision to `.ralph/logs/triage-plan-<unit>.json` and hands it over:

```bash
bun ~/ralph/triage-apply.ts --plan .ralph/logs/triage-plan-142.json [--dry-run] [--json]
```

The plan is JSON: `unit`, `loop`, `attempt`, `outcome`, an `ops` array, and an
optional `decisions` array. The ops are `add-label`, `remove-label`,
`set-section` (only `Parent`, `Blocked by`, `Staffing group`,
`Acceptance criteria`, `What to build`), `comment`, `create-issue`,
`add-blocker`, `close` and `unblock`; each carries an `opId` that is its replay
key. `unblock` is the Rescue bucket's op and the only one that may remove
another loop's label; its conditions are above.

The tool is the one place the rules live:

- **Validate.** A label must exist and be in the role's set; no loop's claim
  triple but this one's, and never `queued`, `dequeued`, `ready-to-merge` or
  `priority:urgent`. A claimed issue takes only a `## Staffing group` edit. A
  `close` carries evidence — `done-in` with a file or test per acceptance
  criterion, or `duplicate-of` an issue that is open or closed as completed —
  and never closes a spec, a claimed issue, one with an open PR, or either of
  `plan.md`'s lists. A plan that decides a product question carries
  `decisions: [{ question, rule, quote }]`, and the rule has to resolve at
  `origin/<baseBranch>` with the quote in it verbatim and named in a comment on
  the unit. Only the owner's issues are touched. At most
  `RALPH_TRIAGE_MAX_WRITES` (30) mutations and `RALPH_TRIAGE_MAX_NEW_ISSUES` (6)
  creations.
- **Simulate.** The plan's bodies and labels are substituted into the census and
  the real `buildTickets`/`classify` run over the result. Refused if the
  frontier would throw, if a tree comes out partly annotated, or if a container
  reaches READY NOW — and the same question is asked of every INTERMEDIATE
  state of the ordered writes, so a plan that would offer a half-written child
  between two `gh` calls is refused before the first one.
- **Order.** Children are created without `ready-for-agent`, the parent is
  demoted, structure and difficulty land, then the children are promoted, then
  the comment, then any close.
- **Pace and replay.** One write at a time, `RALPH_TRIAGE_WRITE_SPACING_MS`
  (1500) apart; a 403 stops the apply and exits 75. Every op is logged to
  `.ralph/logs/triage-apply-<unit>.jsonl`, and comments, new issues and the
  release marker carry their op id in a marker GitHub itself holds — so a rerun
  after a crash finishes the plan without duplicates, ledger or no ledger.
- **Verify and release.** `frontier/next.ts --dry-run --json` runs after the
  writes. If it says the backlog cannot be read, every body a `set-section`
  changed is restored and the tool exits 6; a created issue is not restorable,
  which is why its op marker goes above the first heading rather than inside
  the last section. A throttled or unrunnable check reverts nothing and is
  reported as unverified. Then the `<loop>-wip` comes off, the lease is
  released, and the marker comment lands.

A refusal writes nothing at all. Exit codes: 0 applied, 1 a write failed,
3 refused, 6 reverted, 64 usage, 75 rate limited.

### Preflight and frontier

```bash
bun ~/ralph/preflight.ts --json
bun ~/ralph/frontier-gate.ts --once
```

A hand-run preflight needs the identity exported, for example
`RALPH_LOOP_NAME=rafa bun ~/ralph/preflight.ts`. The supervisor resolves it for
you. Preflight validates the project config first, then distinguishes denied
access (repair the reported prerequisite) from unavailable services (wait and
recheck). Doppler is read the other way round from GitHub: a failed
`doppler secrets` read is denied only when its output names an authentication,
setup or scope problem, and is waited out otherwise, with Doppler's own words
in the reason. A wait that outlasts `RALPH_PREFLIGHT_ALERT_SECONDS` (default
1800) pushes one high-priority `preflight-stalled` notification naming the
check, and keeps waiting. (The dashboard's `migration-applied-stalled` alert,
for a PR left open after its migration was applied by hand, and the variable
that sets its threshold are documented beside the reconciler in
`dashboard/README.md`.)
A refusal records the failing check names as the
`preflight-denied` event's detail, so the dashboard can tell a Doppler refusal
from a local config one without reading the log. A broken check is not
evidence of readiness, and neither is it evidence of a denial: a preflight
that could not run at all (the runtime failed to start, as `bun: Text file
busy` did on 2026-11-10, exit 126 or 127; the preflight crashed; or it exited
1 without writing a verdict, a `preflight.ts` bun could not load) waits and
asks again, its wait doubling from the preflight's interval up to ten
minutes, or the poll interval if longer, and never stops the loop (#767). It
also checks that the executor can run the tools briefs name (`bunx`, `npm`,
`npx` beside `bun` and `node`). For a Codex executor it asks from inside the sandbox, through
`bash ~/ralph/codex-executor.sh --probe-tools`. A `buildkite-logs` warning
means iterations cannot read CI logs (see "Buildkite logs"); warnings never
stop a start — though a role may override one: it is a denial for the ci-doctor,
whose whole iteration is reading those logs. An `actions-logs` warning is its
GitHub Actions counterpart: gh's token cannot read the repo's Actions runs, so
iterations cannot read a red Actions check's logs; it is only ever a warning,
and asked only of a project with a required check not named `buildkite/…`. A
`buildkite-retry` warning means the ci-doctor cannot re-run a candidate
flake's failed job itself and so only ever sees a second verdict on a rerun somebody else triggered; it is asked of
the ci-doctor alone, since that is the one role declaring the token, and it
reads the supervisor's lists of resolved and withheld secrets rather than the
environment, which that token — a `gate` secret — is deliberately kept out of.
It distinguishes a token that is **missing** from one that is **stored but
withheld** — `ralph.sh` withholds a credential whose check refused it exactly as
it does one with no checker at all — and the withheld remedy names the check to
go and look at rather than telling an operator to store a token they have
already stored. The supervisor's own lists outrank what the environment shows,
and withheld is read before available: a hand-run preflight under the secrets
manager can see a value the start it is reporting on refused.

A named secret has a third answer besides a value and **absent**: **unread**,
when the secrets manager failed for a reason other than "not found". Every
named secret is read through one secret-source seam (`secrets/`), which tells
the three apart, because they need different handling. Loops start unattended
after the daily reboot, often before the login keyring unlocks, and an unread
token taken as absent cost the run that token until somebody restarted it. So
`ralph.sh` reads every unread secret again before each gate poll and each
iteration, at most once per poll interval and without lengthening it. A gate
that polled without one hands back to the supervisor for that read instead of
sleeping. A secret that passes its read and its check reaches its targets from
then on. Absent and withheld secrets are never read again: storing or fixing
them is an operator's job. An unread secret is never a denial (#767): a
check that would deny on it waits instead (`clerk-credentials`,
`verifier-credentials`, and `buildkite-logs` for the ci-doctor and the
pr-medic), while a warning stays a warning (`buildkite-logs` for a coder,
`buildkite-retry`) and the secret is read again before each poll. Likewise, a
turn whose secrets scope cannot be read
(`doppler run` fails) waits and asks again on the preflight's interval rather
than running and being recorded as a failure; a failure that names auth or
setup (the preflight's "denied") stops the loop with the remedy instead. A
dotenv project's file that is missing, unreadable or malformed at two probes in
a row stops the loop too; once is waited on, as a file mid-save.

**Which checks run is the loop's role's answer** (`roles.ts`, `preflight`), read
off the project's roster and never off `RALPH_LOOP_ROLE`, so a hand-run
preflight asks the same list the supervisor does. A triager drops
`executor-tools`, `buildkite-logs`, `actions-logs`, `doppler-scope` and
`secrets-file` — it delegates no code, reads no CI logs, and is given no
application environment, so the secrets CLI is
not required of it either — and a ci-doctor drops `frontier-prerequisites`,
taking no work off the frontier. A dropped check is not run at all, not merely
left out of the report. A role also adds to the labels `loop-labels` requires:
a coder's `migration-applied`, a triager's verdict vocabulary plus the
project's Jav difficulty labels, a ci-doctor's `ci-health` and
`priority:urgent`, a verifier's `following`, `verified`, `unexercised`,
`inconclusive` and `needs-human`, a sentinel's `ready-for-human`. Missing ones are DENIED rather than warned about, for the
reason the claim triple is — a role whose verdict label does not exist writes
nothing and reports success. The exception is a label in `roles.ts`'s
`CREATED_LABELS` (`migration-applied`, the verifier's five and the sentinel's `ready-for-human`, which a triager's preflight now creates too): a label a release declares
would otherwise refuse every loop's next start, so preflight creates it with
`gh label create`, and denies it only if the token may not create labels (a
network failure reads as unavailable). On Linear or Jira the tracker's
`ensureLabels` creates the labels a loop needs.
`bun ~/ralph/preflight.ts --labels` prints the whole set for this loop, one per
line, which is what the Add-agent flow creates from
(`adding-an-agent.md` §6). The frontier is read-only; the iteration atomically claims work
when it begins.

`.ralph/plan.md` holds local exclusions, not another backlog; the gate reads it
from `origin/<baseBranch>`. Child issues under a spec share one staffing group
unless explicitly and consistently split through their `## Staffing group`
sections. Different worktrees do not make competing edits safe.

The gate's exit is a verdict: work available, or (`--once`) nothing to do.
Anything else means it never got to ask, and that is sometimes transient —
loggd's rafa took `ETXTBSY: text file is busy, posix_spawn 'bun'` while idle at
the gate on 2026-10-07, with the self-hosted runner writing at the time, and
the supervisor stopped for 25 minutes over a frontier that was merely empty. So
the supervisor retries such an ask instead. `RALPH_GATE_RETRY_MAX` (3) bounds
the ASKS, so at the default it retries twice, waiting
`RALPH_GATE_RETRY_SECONDS` (15) and doubling, held at
`RALPH_GATE_RETRY_MAX_SECONDS` (120) — a ceiling only a `RALPH_GATE_RETRY_MAX`
above 3 reaches, since the defaults wait 15s and then 30s and then stop. The
wait goes through the control inbox, so a stop is not slept through, and each
try is recorded in `.ralph/logs/runner-failures.jsonl` under the `gate` stage,
classified `spawn-failure` rather than "the harness is not installed". That
recorder is itself a `bun` script: under a sustained spawn failure it is the
first thing that cannot run, and the supervisor's own line is then the only
evidence. A signal counts as a non-verdict exit too, so killing an idle loop's
gate takes the retries before the supervisor stops. Only a gate that keeps
failing stops the loop, with the message, event and exit status it always had.
The streak is per ask, so a gate that recovers starts the next one fresh.

### Models and harnesses

[`models.json`](models.json) owns the lineup. Loop blocks nest under their project
id, so two projects' `ralph`s run their own lineups; a loop resolves
`<project>.<loop>`, then `<project>.@<role>`, then `<project>.default`, then the
top-level `default`, and the environment overrides below still win over all four.
`@<role>` is a project's default for every loop in that role — `@triager` covers
a second triager with no edit at all — and the `@` keeps such a key from
colliding with a loop named after its role.

A role also declares WHICH stages it runs ([`roles.ts`](roles.ts) `stages`):
coders, ci-doctors and pr-medics resolve all six, a triager resolves `orchestrator`,
`mapper` and `review.spec`, a verifier or a sentinel `orchestrator` alone, and a clerk resolves `orchestrator` and
`code-context`, a stage no other role has, which a block may leave out
(it then runs `claude-opus-5-5` at `high`; see
[Code context on filed tickets](#code-context-on-filed-tickets)). The coder's
sixth is `review.correctness`, the third pre-PR review axis: an adversarial bug
hunt over the diff (races, failure paths, missing permission or visibility
checks) whose brief carries the base, the files and the change's purpose but
never the author's reasoning. It came after every block was written, so a
block may leave it out too and then runs `claude-opus-5-5` at `high`; every
checked-in block names it. Its P1/P2 findings are checked against the code
before they are fixed, and each iteration journals the tally. So a triager's lineup holds three stages, its
`--export` sets three stage variables, and it defines two named subagents
rather than three. A block written FOR a role — its loop's own, or its `@role`
default — is complete over that role's stages and is refused for naming one
outside them; the `default` blocks stay complete over all five, because every
role falls back to them. `--role <role>` on any `models.ts` command resolves as
that role; without it, the roster answers for the loop being resolved. The
dashboard's lineup form sends it on every call it makes — the read, the preview
and the save — because the roster that declares a loop's role lives in the
PROJECT's `.ralph/config.json` while the form edits a HARNESS checkout. Without
it a triager's form offers five stages, and `--validate` (which needs the loop's
identity as well as the role, since it keys the role by `RALPH_PROJECT_ID` and
`RALPH_LOOP_NAME`) then refuses the three-stage block the form helped write. A file from before
project keys (loop blocks at the top level) is moved under `loggd` on its first
read, values unchanged (`bun ~/ralph/models.ts --migrate` does it by hand);
after that a bare top-level loop block is refused. Inspect the resolved model
and runner before starting rather than copying model IDs from an old run:

```bash
bun ~/ralph/models.ts --list
bun ~/ralph/models.ts mapper --runner
bun ~/ralph/models.ts --list --role triager   # as a triager: its stages, its @triager block
```

Overrides are resolved by [`models.ts`](models.ts). Change model and runner
together when moving a stage between providers. The orchestrator supports Claude
Code and Codex; executors support OpenCode, Claude Code and Codex. Mapping and
the review stages support all three runners. A runner change must preserve the stage's permissions, not just accept its model ID.

To run every stage on Codex for one launch (choose a model available to your
Codex login):

```bash
export RALPH_RUNNER_ORCHESTRATOR=codex RALPH_MODEL_ORCHESTRATOR=gpt-5.6-terra
export RALPH_RUNNER_EXECUTOR=codex RALPH_MODEL_EXECUTOR=gpt-5.6-terra
export RALPH_RUNNER_MAPPER=codex RALPH_MODEL_MAPPER=gpt-5.6-terra
export RALPH_RUNNER_REVIEW_STANDARDS=codex RALPH_MODEL_REVIEW_STANDARDS=gpt-5.6-terra
export RALPH_RUNNER_REVIEW_SPEC=codex RALPH_MODEL_REVIEW_SPEC=gpt-5.6-terra
export RALPH_RUNNER_REVIEW_CORRECTNESS=codex RALPH_MODEL_REVIEW_CORRECTNESS=gpt-5.6-terra
export RALPH_MODEL_ORCHESTRATOR_EFFORT=high
bun ~/ralph/models.ts --list
~/ralph/start.sh
```

The lineup editor offers the same choices for permanent configuration. Existing
lineups keep their selected runners. `effort` maps to Claude's `--effort` or
Codex's `model_reasoning_effort` on every Codex stage, and to the named agent's
`effort` on a Claude mapping or review stage. Each loop stores its own
stage efforts; for example, choose `gpt-5.6-luna` with `xhigh` in the lineup
editor. An unset effort uses the CLI default. Override a single stage with
`RALPH_MODEL_EXECUTOR_EFFORT=xhigh` (or the corresponding stage name).

Install and authenticate Codex with `codex login`; see the
[official non-interactive execution documentation](https://learn.chatgpt.com/docs/non-interactive-mode).
Codex execution and inspection require Linux with working Bubblewrap user namespaces and file authentication
in `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`). The executor receives
no project secrets, cannot write Git or loop metadata, has no MCP or web tools,
and its model-generated commands have no network access. It can edit source and
run local checks. `delegate.sh --continue` resumes only that run's recorded
Codex thread. Missing prerequisites degrade through the existing fallback path.

The Codex orchestrator has the same trusted automation role as the Claude
orchestrator: it can run project gates, GitHub operations and journal publication
without interactive approvals. Ralph tracks its thread explicitly for recovery,
starts fresh threads after PR waits, and redacts events before storing them.
Live token counts come from Codex's native session records; the final exec usage
summary reconciles them without counting cached input twice.

With a Claude orchestrator, a mapping or review stage on the `claude` runner is a
named subagent (`ralph-mapper`, `ralph-review-standards`, `ralph-review-spec`,
`ralph-review-correctness`).
`ralph.sh` defines them for each run through `claude --agents`, each with the
stage's model (an alias or a full `claude-…` id), its effort, the rails in
`inspector.md`, and read-only tools plus Bash. For example, to review on
Opus 5.5 at medium effort:

```json
"review": {
  "standards": { "runner": "claude", "model": "claude-opus-5-5", "effort": "medium" },
  "spec": { "runner": "claude", "model": "claude-opus-5-5", "effort": "medium" }
}
```

Mixed lineups work too: a Codex orchestrator invokes Claude mapping/review stages
through an isolated `claude -p` process with file-reading tools, a supplied
base-branch diff, and the same model and effort. That path also requires
Bubblewrap and Claude's file credential. The usage ledger books subagent turns
under the model their transcript records, read from the session's
`subagents/` directory.

Fallback rows have independent harness and model selectors. Codex fallbacks also
offer an effort selector. Their optional settings are stored in the stage's
`fallbackEfforts` map (for example, `{"gpt-5.6-luna": "xhigh"}`); a fallback
without an effort uses the CLI default rather than the primary model's effort.

Three additive, machine-readable surfaces let a tool consume the lineup across
a process boundary without importing `models.ts`:

```bash
bun ~/ralph/models.ts --json [F]   # resolved lineup as JSON (F defaults to models.json)
bun ~/ralph/models.ts --schema     # allowed runners and effort per stage, agent names, alias set, model-id rules
                                   #   --role R reports R's stages, which is the set a new block must be complete over
bun ~/ralph/models.ts --validate F # validate a candidate config; F is a path or '-' for stdin
```

`--json` prints `{ "project": …, "loop": …, "role": …, "stages": { "<stage>": { model, runner, effort?, fallback?: string[], source } } }`
with `source` one of `env`/`loop`/`role`/`project`/`default` (`role` is the
project's `@<role>` block, `project` its own `default`) and `stages` holding the
role's stages alone; a stage omits a field it does not have. `--validate`
judges the whole document (the `default` block and every project's blocks), prints `{ "valid": bool, "problems": string[] }` — the resolver's
complete collected list, not the first failure — exits 0 when valid and 1 when
not, and never writes. It reads the candidate as-is, without the environment
overrides `--json` applies, so a candidate is judged on its own.

For a read-only stage on an external runner, `fallback` is an ordered model-id
array. `provider/model` entries run through OpenCode, bare model ids through
Codex, and the Agent aliases (`opus`, `sonnet`, `haiku`, `fable`) as an ad-hoc
Agent call. A Claude fallback takes an alias only. A claude primary takes no
fallback: it runs in-session, so no harness can be missing.
The next route is tried after an unavailable or failed external inspection.

### Environment

The supervisor runs every child under the project's secrets runner with an
explicit scope — for Loggd, Doppler `loggd-web/dev` — never a per-directory
setup. It then strips `secrets.withhold` from the child environment
(`RALPH_WITHHELD_SECRETS` carries the list), and runs the project's `envCheck`
inside the project before launch, including recovery turns and redactors. A
failing check stops the child; the check must not print credentials. Loggd's
check verifies the database URLs and public API URL target its development
project.

| Loggd withholds from orchestrator children | Reason |
| --- | --- |
| `PRODUCTION_MIGRATIONS_DATABASE_URL` | Production audit belongs to CI/operators |
| `SUPABASE_SERVICE_ROLE_KEY` | No Auth/Storage admin bypass needed |
| `SELF_HOSTED_RUNNER_GH_PAT` | GitHub uses the CLI's own credential store |
| `BUILDKITE_AGENT_TOKEN`, `BUILDKITE_API_TOKEN`, `BUILDKITE_OPERATOR_TOKEN`, `RENOVATE_TOKEN` | Infrastructure administration is outside the loop's task; the operator token can retry, cancel and start builds. CI logs are read with a separate, dedicated `RALPH_BUILDKITE_READ_TOKEN`, and the ci-doctor and the pr-medic re-run failed jobs with a second, gate-only `RALPH_BUILDKITE_RETRY_TOKEN` (see "Buildkite logs") |

It is a deny list: new secrets otherwise pass through. Review it when adding
secrets. The secrets CLI stays authenticated on the host, so a claude
orchestrator is denied it and its store by `claude-orchestrator-settings.json`
(a tripwire; the executor has the same in `claude-executor-settings.json`), and
every role's prompt states the rule — the only fence a codex orchestrator has,
since no settings file can be handed to one. Refusing `refuseFiles` (Loggd:
`.env.local`) prevents an accidental local override; do not work around it by
fabricating env files.

#### A dotenv file instead of a secrets manager

A project with no secrets manager can hand the loops a dotenv file:

```json
"secrets": { "runner": "dotenv", "file": "/etc/ralph/acme-app.env", "withhold": ["ACME_ADMIN_TOKEN"] }
```

`file` is absolute, or relative to the project root; the dashboard's setup
form offers it beside `none`. Every child runs under
`secrets/dotenv-run.sh <file> --`, which exports the file's `KEY=value` lines
with the shell builtin (no value ever sits in a process's argv) and execs the
command, so a file variable overrides an inherited one exactly as under
`doppler run`; `withhold` is then stripped and `envCheck` runs, the same as for
Doppler. Named secrets a role reads (`secrets/read.ts`) come from the same file.
The parser takes blank and `#` lines, an optional `export `, single-quoted
literals and double-quoted values with `\n`/`\t`/`\"`/`\\` escapes, which may
span lines.

The preflight's `secrets-file` check refuses to start when the file is
missing, unreadable, malformed (it names the line number, never the text),
tracked by git in the project, or inside the project and not git-ignored (a
coder's `git add -A` would publish it), and says which. A file that cannot be
read at two per-turn probes in a row stops the loop before the turn; once is
waited on, since an operator saving it clears by the next probe.

The supervisor keeps `RALPH_SECRETS_FILE` out of every child's environment,
but the file stays readable by the loop's user, and `.ralph/config.json` names
it: like Doppler's own fence, that is a tripwire, not a boundary. So do not
put a name you would `withhold` in the file at all; `withhold` strips the
environment, not the file. Keep the file outside the worktree.

Migration generation is allowed; SQL execution and migration application remain
human-owned. The executor receives `env -i` plus its explicit allowlist and no
injected credentials. Permission files deny credential recovery tools.

### CI logs: one command, either provider

```bash
bun ~/ralph/ci-log.ts --pr 12                        # the failing check's reader, picked for you
bun ~/ralph/ci-log.ts --pr 12 --job test --grep 'FAIL'
bun ~/ralph/ci-log.ts --pr 12 --rerun                # GitHub Actions only: re-run the failed jobs once
bun ~/ralph/gh-actions-log.ts --check-token --repo <owner/name>
```

`ci-log.ts` is what the prompt names for a red check (#50). It hands its
arguments, unchanged, to the reader of the check's CI provider:
`gh-actions-log.ts` when the failing check links a GitHub Actions run,
`bk-log.ts` when it links a Buildkite build, and otherwise by the project's
required checks (a `buildkite/…` one means Buildkite). A Buildkite project
reads exactly what `bk-log.ts` printed before.

`gh-actions-log.ts` prints the same digest as `bk-log.ts` (no `history:` or
`known:` lines) and reads through gh, so it needs no token of its own: gh's
must read Actions on the repository, which the `actions-logs` preflight
warning checks. `--rerun` re-runs the run's failed jobs once and refuses a
run that is still going, one already on its second attempt, or one of a
commit that is not the PR's head: one re-run per red, as on the Buildkite path.
A Buildkite check has no session re-run here; the prompt's retry stands.

### Buildkite logs

```bash
bun ~/ralph/bk-log.ts --pr 1710                   # the build the PR's check links
bun ~/ralph/bk-log.ts 2425 --full .ralph/logs     # a build number or URL; save full logs
bun ~/ralph/bk-log.ts --branch mergify/merge-queue/<id>
bun ~/ralph/bk-log.ts 3205 --job e2e --grep '^\[step-timing\]'  # any job's log, passing ones too
cd ~/loggd && doppler run -- bun ~/ralph/bk-log.ts 2425   # by hand (injects RALPH_BUILDKITE_READ_TOKEN)
```

`bk-log.ts` prints a bounded digest of each failed job: its name and step,
the command it was running, the failing tests with the first lines of their
error, a `timeout only` marker, the runner's totals and the exit line. The
prompt makes an iteration read it before any re-run or block, and quote its
failing line in a CI block.

The digest opens failed jobs only. When the evidence is in a job that passed
(a measurement a green e2e job printed, as #1898's step timings were), `--job
<step-key>` prints that job's whole cleaned log in any state, and `--grep
<regex>` narrows it to the matching lines with their line numbers.

Once the ci-doctor has scanned the pipeline, the digest also carries what the
doctor already knows. Under each failing test the store recognises:

```
   - FAIL src/feed.test.ts > Private feed controls > persists
       known: loggd #1901 — confirmed flake (timeout, 9 reds/72h), fix PR #1910 open
       known: main red since build 2701 on this test — not the diff
```

and, just before `history:`, a `known infra:` section for open infra cases (a
bootstrap failure, a long scheduled wait, a non-Buildkite required check red
across several PRs) — the three costliest by the same weight the doctor's gate
ranks cases with, then `… 2 more infra incidents in the store`, so an outage
cannot scroll the failing test out of view.

That turns the prompt's flake branch from a guess into a read of recorded
evidence, and stops a loop re-running into a flake the doctor has already
filed. It costs no API call: the lines come from
`<git-common-dir>/ralph/ci-health.json`, the same local store the doctor
writes, and a missing or unreadable one changes neither the digest nor the
exit code. `--json` carries the same thing as a `known` key, keyed by the
store's test id, `null` when the store knows nothing.

It reads `RALPH_BUILDKITE_READ_TOKEN`, a token that exists for this alone.
Create a Buildkite API access token (Personal Settings → API Access Tokens)
with **only** `read_builds`, `read_build_logs` and `read_artifacts`, for the
project's organization.
`read_artifacts` is what lets a loop download a failed Playwright run's
`-actual.png` to update a screenshot baseline after an intended layout change;
without it the loop parks the ticket for a human (loggd #2013). `--check-token`
names any of the three the token lacks, and the supervisor prints that line at
startup. Store it in the loop's secrets scope:

```bash
doppler secrets set RALPH_BUILDKITE_READ_TOKEN -p loggd-web -c dev
```

It is deliberately not `BUILDKITE_API_TOKEN`. Loggd withholds that one from
every child (see the table above) because it is a shared infrastructure
credential with wider reach; the harness never reads it. A dedicated token
keeps the loop's access to exactly "read builds and their logs", revocable on
its own.

At startup the supervisor reads it (`doppler secrets get
RALPH_BUILDKITE_READ_TOKEN` in the configured scope; a `<NAME>_SECRET` variable
names a differently spelt entry to read in place of `<NAME>`) and exports it only
after `bk-log.ts --check-token` shows every scope is `read_*`. It is the coder's
one named secret: a role declares which credentials the supervisor reads by name,
what proves each one narrow, and which process gets it.
A token with any write scope is refused and stripped from the children's
environment, since `doppler run` would inject it again. No token, or a refused
one, is a one-line warning plus a `buildkite-logs` preflight warning, and the
loop starts without logs. A token Doppler could not hand over (unread, not
absent) is read again before each later iteration, and the first iteration
after a read that passes has the logs. An operator-set
`RALPH_BUILDKITE_READ_TOKEN` is checked the same way. The value is never
logged; the redactors strike it by name and by its `bkua_` shape.

The pipeline is `RALPH_BUILDKITE_PIPELINE`, else the project's one
`buildkite/<slug>` required check; the organization is `RALPH_BUILDKITE_ORG`,
else the one the token's recent builds of that pipeline are under. A build URL
supplies both.

#### The second token: the ci-doctor's retry

There are **two** Buildkite tokens, and the difference between them is the
whole of the loops' write access to CI:

| | `RALPH_BUILDKITE_READ_TOKEN` | `RALPH_BUILDKITE_RETRY_TOKEN` |
| --- | --- | --- |
| Scopes | `read_builds`, `read_build_logs`, `read_artifacts` | exactly `write_builds`, and nothing else |
| Proved by | `bk-log.ts --check-token` — every scope is `read_*` | `bk-log.ts --check-retry-token` — the scope list IS `["write_builds"]` |
| Held by | the coder's and the doctor's model sessions, and the doctor's gate | the ci-doctor's **intake gate alone** |
| Roles | coder, ci-doctor | ci-doctor |
| Used for | reading a failed job's log and its artifacts | re-running one candidate flake's failed job |

```bash
doppler secrets set RALPH_BUILDKITE_RETRY_TOKEN -p loggd-web -c dev
```

The retry token is declared `targets: ["gate"]` (`roles.ts`), so `ralph.sh`
exports it to `ci-doctor/gate.ts` and strips it from the iteration with
`RALPH_ENV_FILTER` — whether or not its check passed. **No model turn, of any
role, is ever handed it.** That is the fence: the doctor's gate can re-run a
job, and the model that decides what the red means cannot. A token with any
scope beyond `write_builds` is refused and stripped too, because a superset
would make the write token a drop-in for the read one. The value is never
logged; the redactors strike it by name and by its `bkua_` shape, and
`ci-doctor/retry.ts` is handed a bound `put` rather than the token, so no code
path in it can print one.

Without the token — or with one the check refuses — the doctor runs on natural
reruns alone, exactly as it did before the exception existed. The
`buildkite-retry` preflight check says which of the three states a start is in
(available / stored but withheld / absent) and never denies.

What the gate may then do with it is capped by code, not by instruction
(`ci-doctor/retry.ts`): at most **one retry per candidate per 72-hour window**
and **six per UTC day** across every doctor sharing the store, lowerable (never
raisable) through `ciDoctor.retry` in `.ralph/config.json`; only a `flake`/`candidate` case, never
a confirmed one, a regression, an infra failure or a PR-specific one; never a
`mergify/merge-queue/*` build, an unfinished build, or a PR branch whose head
has moved off the build's commit; and only while the host is idle —
`host-lease.ts`'s `readCi` reports no required check pending and no host lease
is held or queued, with an unreadable answer counting as busy. One retry per
poll at most.

That idle read costs three `gh` calls, and they are spent on the doctor gate's
own GitHub allowance (`ci-doctor/gh-budget.ts`, twelve an hour) rather than
beside it: the retry asks whether it can afford them before reading, reports
what it reserved, and the poll records it on the same ledger as its own reads.
An hour with no room left makes no retry, which is the right way round — the
ceiling is what protects the account. It is asked LAST, after the local
host-lease file and after the eligibility rules, so a poll with nothing to
retry and a poll on a busy host both cost nothing — and the Buildkite
organization is resolved lazily, once per process and only when there is a
retry to make, for the same reason. The gate logs the retry's outcome only
when it CHANGES: both "nothing to retry" and "the host is busy" are steady
states, and either repeated every five minutes would bury the lines that
matter.

**The retry needs the read token too.** `resolveOrg` finds the organization by
listing builds, which a `write_builds`-only token cannot do, so a doctor with
the retry token and no read token makes no retry at all. In practice this costs
nothing — the doctor's gate already requires the read token to find a case —
but it is why the gate checks for both.

The window in "one per candidate" is the store's own: the guard is the retried
job's row, and `ci-doctor/scan.ts` prunes rows older than 72 hours. A test that
is still a candidate three days after its retry may be retried again, which is
a second measurement of a test that has stayed unexplained for three days
rather than a cap that leaked. The six-a-day ceiling bounds it either way.

A retry can **confirm** a flake and can never, by itself, convict one. The next
scan records the retried job, a pass gives `classify.ts` its "same tree, both
colours" rule, and a second red is a `retried: true` row that every rule leaves
out of its evidence.

### Watch it

```bash
~/ralph/status.sh
~/ralph/status.sh -w
bun ~/ralph/observe.ts --once
bun ~/ralph/observe.ts --json
bun ~/ralph/timeline.ts
bun ~/ralph/timeline.ts --iteration 3
bun ~/ralph/timeline.ts --json
bun ~/ralph/runner-failure.ts status --json
bun ~/ralph/loop-state.ts status
bun ~/ralph/loop-state.ts unattended --json
```

`unattended` lists the loops that died rather than decided to stop — a
`failed` ending, or a dead supervisor with none — and have stayed down past 30
minutes (`RALPH_UNATTENDED_AFTER_SECONDS` overrides), as `loop`, `stopKind` and
`downSince`. It sees only the worktrees of the clone it runs in.

Use the timeline to correlate stages and the failure record to distinguish a
runner denial, provider outage, timeout, or model-level stop. Absence of a signal
is unknown state, not successful execution. Logs and durable state live under
the project's `.ralph/logs/`; they are gitignored and scoped to the worktree/run.

Keep stderr separate from model prose. Transcripts must be redacted before
persistence, with the same injected environment available to the redactor as to
the child. Observability must not gain write/network permissions merely to
inspect another stage. Do not publish raw credential-bearing logs.

### Token reporting

```bash
~/ralph/usage.py --step peek --no-record
~/ralph/usage.py --step review --md
~/ralph/usage.py --step review --json
```

`--no-record` inspects without advancing the baseline. The normal command records
step, iteration, and run usage. `--json` prints the same `step`, `iteration`, `run`,
and `context` scopes as one raw-number object (`input`, `output`, `cache_5m`,
`cache_1h`, `cache_read`, `input_total` per scope) for a panel or script to
consume; `context.window` is `null` when the model is unknown. Preserve
run/session attribution and existing GitHub provenance footers; do not infer costs
or context limits from old transcripts.

### Loop speed

```bash
bun ~/ralph/speed.ts report                       # per project and loop
bun ~/ralph/speed.ts report --since 2026-10-01 --json
```

Every coder loop appends to `<git-common-dir>/ralph/speed/<loop>.jsonl`: the
frontier's claim, each iteration's start and end (with its sigil and the seconds
it spent in a PR wait or the host lease), and `handed-off` / `merged` /
`blocked` / `released` from `tracker.ts`. The report gives, per project and
loop, the tickets handed off, median and p90 claim-to-hand-off (first claim to
the hand-off, however many iterations), median active time (iterations only,
the supervisor's PR waits, host lease and operator holds taken out; a wait the
model runs inside its own turn still counts as active) and the slowest tickets.
`tracker.ts done|handoff <n> --pr <url>` carries the PR into the ledger. A write that fails is a line in the
supervisor log; it never stops an iteration. `RALPH_SPEED_DIR` moves the
ledger, which backtest trials use to keep their own: the scorecard's agent arms
report the same claim-to-hand-off beside the human's open-to-merge.

### Delegated code generation

```bash
~/ralph/delegate.sh <brief-file>
~/ralph/delegate.sh --continue <brief-file>
~/ralph/inspect.sh <stage> <brief-file>
```

A successful executor exit does not prove its changes correct: review the diff
and run appropriate checks. Exit 2 means unavailable, 3 invalid usage/lineup,
and 4 an error or timeout; inspect partial work before retrying.

Each round runs under a time budget ([executor-budget.ts](executor-budget.ts)):
25 minutes by default (`RALPH_DELEGATE_TIMEOUT`, in seconds), or what the
brief declares on a `Budget: 1800s` / `Budget: 30m` line, held between 2 minutes
and `RALPH_DELEGATE_MAX_TIMEOUT` (40 minutes by default). The executor is told
its deadline and a wrap-up point at 80% of it, after which it stops verifying
and leaves the diff. `delegate.sh` prints the budget, the wait it needs, and a
done-file (`<log>.exit`) holding its exit code once it ends. On a timeout it
also saves the partial diff to `<log>.partial.diff` and prints the executor's
last activity. `ralph.sh` raises the orchestrator's `BASH_MAX_TIMEOUT_MS` above
the largest budget, so the orchestrator never needs a shorter shell timeout to
wait on a delegation. The permission
files and [coder.md](coder.md) (with the project's coder fragment) define
executor rails; [inspector.md](inspector.md) and the read-only harness
configuration define inspection rails.

Repo-wide verification is refused to the executor by the harness, not only by
the brief. `executor-guard/bin` shims `bun`, `bunx`, `node`, `npx`, `npm`,
`pnpm` and `yarn` first on the executor's PATH (mounted inside Bubblewrap for
Codex, prepended by `delegate.sh` for the other runners), and
[executor-guard/guard.ts](executor-guard/guard.ts) judges what each command
would run — expanding package scripts — before the real binary starts. Builds,
e2e, dev servers and watchers are refused outright; test runners and linters
are refused with no file target or with `.`/a top-level directory, so
`bun run test` and `bun lint` fail at once with a message pointing at targeted
checks, while `bun run test path/to/a.test.ts` runs normally. A project adds
its own commands with `executorGuard` in `.ralph/config.json`. The guard is a
tripwire against a model ignoring its brief, not a boundary: the real binaries
remain reachable by absolute path.

Read-only stages must stay confined to the checkout and unable to write through
shell redirects, Git options, metadata, or credential-store paths. A harness's
sandbox label alone does not establish those guarantees. Verify changed harnesses
with the existing inspection/delegation tests.

### When a runner never reaches the model

Inspect its failure record before widening a timeout. The OpenCode watchdog
separates a pre-request startup stall from a healthy long-running request; it
must not kill a process that is making progress or belongs to another invocation.
The implementation owns its signals and bounded retry policy.

```bash
RALPH_OPENCODE_FIRST_STREAM_SECONDS=120 ~/ralph/ralph.sh
RALPH_OPENCODE_STALL_SECONDS=180 ~/ralph/ralph.sh
RALPH_OPENCODE_WATCHDOG=0 ~/ralph/ralph.sh
```

Disabling the watchdog removes recovery, not the underlying stall. Inspect the
current defaults in the runner wrapper before changing them.

### GitHub side

`ready-for-agent` makes an unassigned ticket eligible. `<loop>-wip` is an active
claim, `<loop>-blocked` needs human attention, and `<loop>-done` records completion.

`priority:urgent` is the frontier's one priority lane. An eligible ticket that
carries it is offered before every other READY NOW ticket, and within a
staffing group it is picked over a sibling that frees more work. It reorders
and nothing more: a claimed, stuck, blocked, spec or `--exclude`-fenced ticket
stays unofferable, and an urgent ticket whose staffing group already has one in
flight waits like any other. Jav difficulty routing filters after the ordering
but **exempts** a `priority:urgent` or `ci-health` ticket that carries no
difficulty label at all (felipearos/ralph#233), so such a ticket is still
offered — the lane would otherwise be the one thing routing hid, which is the
opposite of its purpose. See
[Jav: difficulty routing](#jav-difficulty-routing). Both terminal views name it — `READY NOW`
tags the ticket `URGENT`, under `--tree` too — and both JSON surfaces, the
`--json` report and `--take-one`'s line, carry `urgent: true` on it and only on
it. The dashboard's panel reorders with them but shows no tag: its contract
narrows the report field by field, and adding one belongs with the panel.

The ci-doctor writes the label, and it is the only role that does. Its
regression path (`ci-doctor/revert.ts`, felipearos/ralph#162) adds
`priority:urgent` as a second write on top of the `ci-health`,
`ready-for-agent` and `bug` that `fileForCoders` applies, and takes it off
again with `revert.ts retire` once the case has retired and main is green — a
lane full of regressions that were fixed days ago puts nothing at the front of
anyone's frontier. No triager may touch it (`NEVER_TOUCHED_LABELS`).

The loop identity comes from `RALPH_LOOP_NAME` or its worktree's `.ralph/loop-name`.
The roster is the project's: `loops` in its `.ralph/config.json` (one lowercase
word each, unique, non-empty, and required). Loop names may repeat across
projects.

Each loop holds a role — [Roles](#roles) has the two roster forms and what
each role does. What matters on this side is that every claim fence reads
every name whatever its role, so a triager's `tria-wip` keeps coders off that
issue and a coder's `-wip` keeps the triager off. The supervisor exports the
loop's role as `RALPH_LOOP_ROLE`; `RALPH_PROJECT_LOOPS` stays names only.

A claim has two halves, and both fence a `--take-one`: the `<loop>-wip` label
GitHub holds, and the durable lease in `claim-lease.ts`'s store. **A dry run
reads the lease too** (felipearos/ralph#328). It used to read only the label, so
a lease that outlived its label — a loop that parked its ticket `<loop>-blocked`
while its supervisor kept renewing — left the gate reporting `work available`
for a ticket that every iteration then failed to claim: on 2026-10-17 loggd's
triager spent about 40 of its 50 iterations that way. The dry run now obstructs
exactly where the real claim refuses, in the same words
(`lease <status> for issue #<n>`), and the gate waits instead. It never
obstructs on the asking loop's own lease (both `run` and `loop` must match),
an expired lease is still offered even with no label on the issue, and a store
that will not parse falls back to offering the ticket rather than fencing every
loop off every candidate.

A role also declares its **intake**: which command the supervisor runs to decide
whether to spend an iteration, and which of the frontier's buckets that
iteration may claim from. `--intake-gate-of <loop>` prints the first — a coder's
and a triager's is `frontier-gate.ts`, the ci-doctor's is its own, because its
case is a red build and the backlog cannot see one. For the second,
`bun ~/ralph/frontier/next.ts --take-one --role <role>` offers a coder the
frontier's READY NOW picks (the default, and unchanged without the flag) and a
triager the tickets difficulty routing strands; the ci-doctor takes nothing off
the frontier and claims its issue by number instead, with
`bun ~/ralph/claim-lease.ts claim <n> [--label <loop>-wip]` — the same claim
lock, the same `-wip` and the same lease, exiting 3 when the issue is already
held. "Already held" includes by the claiming loop itself: the fence reads every
roster claim label without excepting the caller's, so a loop resuming its own
work reads the label rather than re-claiming it, and `--label` is refused unless
it is one of the roster's. `--role` is only accepted with `--take-one`; the
rendered frontier and `--dry-run --json` always picture the whole backlog.

The same descriptor says **how often that gate asks** and **which questions it
asks at all**. `--poll-seconds-of <loop>` prints the interval `start.sh` uses
when the start line names no `RALPH_WAIT_FOR_WORK` — 300s for a coder or a
ci-doctor, 600s for a triager, whose bucket answers "what has nobody looked at"
and so cannot change as fast as a coder's frontier (with no loop named it
answers for the roster's first, as `ralph.sh` itself defaults). And a role that
may never hand back `AWAIT_PR` opens no pull request, so its gate spends no
`gh pr list`: for such a role a dirty worktree is not recovery work either but
a violation of its own `clean-detached` invariant, named in the gate's waiting
line and repaired by the supervisor whenever an iteration next ends.
Difficulty routing (Jav) narrows a coder's intake only. Whichever gate answers,
the supervisor reads its `work available — <case>` line the same way and hands
the case to the iteration as `RALPH_INTAKE_CASE`; a pr-medic's case is also split into `RALPH_INTAKE_PR` and `RALPH_INTAKE_REASON`. The ci-doctor's prompt reads
it as the first thing it does (`prompts/ci-doctor.md` §0), because a red build
is not a ticket number it could look up; a coder's prompt reads the backlog and
ignores it.

The ci-doctor's gate (`ci-doctor/gate.ts`) answers the same way, from a
different question: it runs one Buildkite poll into the ci-health store
(`ci-doctor/scan.ts`) and hands over the first of six cases — its own open pull
request, its own unfinished claim, a regression on `main` with no open
`ci-health` issue, a coder ticket parked on a flake that has since been
confirmed or fixed, the confirmed flake with the highest 72-hour cost
(`mainReds×3 + dequeues×2 + redBuilds`), or a fixed flake that came back. Three
things deliberately start no iteration: an **infrastructure** case, which the
doctor has no operator token to fix and which is pushed once per signature as a
`ci-incident` and then sat out; a flake still short of confirming evidence; and
a case another doctor already holds.

Two bounds make it safe to poll forever. A **case lease** in the store
(`ci-doctor/case-lease.ts`, 120 s, renewed by the heartbeat) is what stops two
doctors being handed one flake — the case is not a GitHub object, so there is no
label to claim. And a **GitHub budget** (`ci-doctor/gh-budget.ts`) of twelve
`gh` calls per idle hour, per doctor, persisted in the store so a restarted gate
gets no fresh allowance: three fifteen-minute cadences (open pull requests with
their check rollup, the `ci-health` registry, one OR'd search over every coder's
`-blocked` label) plus one read of each newly parked ticket's block comments,
recorded as a `parked:<n>` case so it is never read twice. A cadence is stamped
only when its read succeeds, and a read with no cached answer yet — `--once`, or
a restarted gate — is always attempted, so only the ceiling ever refuses one.

A throttled read starts no iteration at all, before any of the six priorities
are considered: the model would otherwise be handed a store whose GitHub half
the gate could not refresh. It then waits five minutes, or whatever GitHub asked
for when it said — which is only when the message carries it, since
`classifyRateLimit` reads `retry-after` off response headers and neither
`gh pr list` nor `gh issue list` can be asked for them.

A role finally declares the five behaviours the supervisor used to hold for a
coder alone (`roles.ts`; `bun ~/ralph/role-behaviour.ts --json <role>` prints
what a given role answers, and `--export <role>` the shell `ralph.sh` evals):

- **Sigils**, and the recovery text that offers only those. A sigil outside the
  role's set is not read at all — it takes the missing-sigil recovery turn, and
  a second such ending stops the supervisor as a no-sigil death does. A triager
  may end `DONE`, `ALL_BLOCKED`, `RETRY_LATER` or `NEEDS_TRIAGE`; the ci-doctor
  has the coder's set minus `COMPLETE`, since the branch it watches is never
  drained.
- **Phases.** Off for the triager: no `phase_resume`, no ledger under
  `.ralph/logs/phases/`, no `PHASE` handling, and no phase on its records. On
  for the ci-doctor, which reuses the coder's five for the fixes it opens.
- **Secrets**, each with a check command and a target. `iteration` reaches the
  model session; `gate` reaches the role's intake gate alone and is stripped
  from the iteration, which is how a credential that can retry a build stays
  out of every model turn. A declared name must also be listed in
  `runner-signals.json`'s `never.except`, or the redactor does not know it is a
  credential; `role-behaviour.test.ts` fails if one is missing. A secret whose check fails — or that has no checker
  yet — is withheld with a one-line warning, never a stop, and another role's
  declared secrets are stripped by name, because the manager injects the whole
  scope into every child. The triager is given no application environment at
  all, and the project's env check is skipped with it.
- **An invariant** on the worktree the role must leave behind. The triager's is
  `clean-detached`: nothing uncommitted, HEAD detached at the base branch. A
  violation saves the diff against the base ref to
  `.ralph/logs/<role>-violation-<ts>-<pid>.patch` (so a commit the role should
  never have made is in it too), detaches before resetting so a branch it
  wrongly created is abandoned rather than rewritten, pushes a `role-invariant`
  notification and carries on; a role with no invariant (a coder, whose whole
  job is a branch) is never touched.
- **The host lease.** A role that runs no local gates takes no part in it: it
  never holds the host, is never held waiting for one, and cannot ask, since
  `AWAIT_HOST` is not among its sigils.

Existing owned PRs and unfinished claims are recovered before new work. Never
remove another live loop's claim to take its ticket. After a merge, finalization
must clear the issue's in-flight claim and finish the provenance/usage handoff;
a merged PR alone is not proof that cleanup completed.

`main` merges only through a merge queue (Mergify, configured in the project's
`.mergify.yml`). An iteration never runs `gh pr merge`: it comments
`@mergifyio queue` on a green PR and then runs `bun ~/ralph/merge-wait.ts <pr>`,
which polls the PR and exits 0 only on `MERGED`. Its other exits — dequeued,
closed, timeout, unreadable — are findings to act on or hand off, never a
merge. Being behind the base branch is no longer a reason to rebase; the queue
builds the combination itself, and a rebase is reserved for a real conflict.

### A Qodo review as a merge condition

A project whose PRs Qodo Code Review reviews can make that review a merge
condition: its `.ralph/prompt.md` reviewer section (`CODEX`, spliced just
before §5 step 6) tells the loop to run

```bash
bun ~/ralph/qodo-review.ts <pr> [--wait <seconds>] [--json]
```

It reads Qodo's "Code Review by Qodo" summary comment and answers whether a
finished review covers the PR head: the summary names the reviewed commit,
is not a failed run, and carries a finished body (the counts line, numbered
findings, "no issues found" or "no open findings"). Exit 0 reviewed with no open finding,
1 reviewed with open findings (listed by number, severity, type and link,
read from the summary: Qodo publishes them there, not as review threads),
3 pending, 4 gave up, 5 unreadable, 75 throttled. A failed Qodo run ("Sorry,
something went wrong"), or a review of an older commit five minutes after the
head was first seen, is asked again with `/agentic_review`, once per head.
The wait is bounded: each call polls for at most `--wait` seconds (240,
capped at 480), and past `RALPH_QODO_REVIEW_MINUTES` (30) from when the tool
first saw the head it exits 4, which the prompt turns into a hand-off to a
person, never a merge. When it first saw each head, and whether it asked
again, is kept in `<git-common-dir>/ralph/qodo-review.json`. Qodo edits its summary in
place while it reviews, so a finished-looking summary counts only once it
has gone unedited for `RALPH_QODO_QUIET_MINUTES` (5). The loop answers
the findings in one PR comment starting `@qodo `, so Qodo reads it. This
repository's own gate (fix valid High and Medium findings, report Low ones,
stop after two rounds) is in its `.ralph/prompt.md`.

### Controlling a loop

```bash
bun ~/ralph/controls.ts status --json
bun ~/ralph/controls.ts poll
```

A command reaches a loop one way: its **local inbox**, which needs nothing but
the loop's worktree. The dashboard writes it, an operator can write it by hand,
and an enabled plugin can write it through its `inbox` hook. One command is one
file, written atomically (temp file, then rename) as
`.ralph/control/inbox/<id>.json`:

```json
{"version":1,"id":"pause-1","command":"pause","loop":"ralph","run":"<RALPH_RUN_ID>","why":"frontier needs triage"}
```

`id` is the idempotency key, shared by every writer, so the same command
delivered twice is applied once. `run` is optional: a command naming a run is
refused `needs-reconfirmation` once that run no longer holds the loop, and one
naming no run is addressed to whoever does. Once its record is written
(`.ralph/logs/controls.json`), the poller moves each file to
`.ralph/control/processed/` with `<id>.outcome.json` beside it. A malformed
file is moved aside as `malformed` and never holds or stops the loop.

The commands are `pause`, `resume`, `stop`, `request-approval`, `approve`,
`deny`, `arm-gate`, `disarm-gate`, `retry`, `abandon` and `release`. Pause, resume, and stop take effect
between iterations. They do not interrupt an in-flight model turn. Approval
controls answer a pending `request-approval` hold; they do not grant unrelated
task permissions. A command for an old owner must not silently control a new
run. Inspect the recorded outcome: an unreachable owner is not a confirmed stop.
Repeated delivery must not repeat an already applied command.

### Putting a project to sleep

```bash
bun ~/ralph/project-sleep.ts sleep --why "overnight: CI is being migrated"
bun ~/ralph/project-sleep.ts status
bun ~/ralph/project-sleep.ts wake
```

Run from any checkout of the project, these softly pause **every** loop of
it at once: coders, the triager, ci-doctor, pr-medic, sentinel and the rest.
Each loop finishes the iteration it is in (the PR it is shipping, the ticket
it is halfway through), then holds before its next one, as if paused (`sleep`
in its pane, `paused` on the dashboard). A loop idling in its gate or a
backoff hands back and holds too, so it does not claim new work. Waking the
project lets them all go on at their next poll, every
`RALPH_CONTROL_POLL_SECONDS`. The dashboard's **Sleep project** button does
the same thing.

The sleep is one marker, `ralph-sleep.json` in git's common directory beside
the claim leases, so every worktree of the repository shares it. Loops started
or restarted while it stands hold at their first checkpoint. It is read at
each poll and never copied into a loop's own control record, so there is
nothing per loop to clear after a wake. An operator's own `pause` of one loop
is a separate instruction: it outlives a wake, and a `resume` does not wake
one loop of a sleeping project. A stop still ends a sleeping loop. A marker
that cannot be parsed counts as awake.

### Plugins

The loop runs, is controlled and reports its state with no plugin at all. A
plugin is a directory, `plugins/<name>/plugin.ts`, that the host
(`plugins.ts`) runs as a subprocess on three hooks: `on-event` (every event
the loop recorded durably, and a `pulse` while an iteration runs), `inbox`
(deliver commands into the local inbox, at every control checkpoint) and
`notify` (an alert the loop raised and recorded). The host bounds each hook
(`RALPH_PLUGIN_TIMEOUT_SECONDS`, default 60), backs off from a plugin that
timed out (`RALPH_PLUGIN_RETRY_SECONDS`, default 60), discards everything a
plugin prints, and records every failure as that plugin's health in
`.ralph/logs/plugins.json` — never as the loop's. A plugin cannot hold, stop,
slow or fail a loop.

Plugins are off by default. A project turns one on with `"plugins": ["orca"]`
in `.ralph/config.json`; `RALPH_PLUGINS` overrides that for one run
(`RALPH_PLUGINS=orca` to turn it on, `RALPH_PLUGINS=` to turn every plugin
off). With none enabled, no plugin subprocess is made at all.

The `slack` plugin posts alerts to a channel, `pr-opened` by default, so a
team that merges by hand (`merge: "human"`) hears of each PR where it works.
Its settings hold a bot token, so they live on the host, never in `.ralph/`:
`~/.config/ralph/slack/<project id>.json`, with `token` (`xoxb-…`, `chat:write`,
the bot invited to the channel), `channel` (the id), and optionally `kinds`
and a `template` over `{loop} {pr} {url} {title} {ticket}`.

```bash
bun ~/ralph/plugins.ts status        # which plugins are on, their health and panel lines
bun ~/ralph/plugin-doctor.ts         # diagnose each enabled plugin: its checks, and the repair for each failure
bun ~/ralph/plugin-doctor.ts --plugin orca --fix-all
```

A plugin may also answer `doctor`, outside the loop: `plugin-doctor.ts` runs it
for an operator (and the dashboard's **Fix** panel runs `plugin-doctor.ts`,
never a plugin's backend). The plugin names its checks in order, each passed,
failed or not checked, with the repairs that fit a failed one; `--repair
<check>:<repair>` applies one it offered, and `--fix-all` applies each failing
check's default repair in turn, stopping at the first that cannot be repaired
and saying why. Turning a plugin off for the project (`disable-plugin`, which
edits `.ralph/config.json`) is carried out by the doctor host, not the plugin.
Every diagnosis and repair is appended to `.ralph/logs/plugin-doctor.jsonl`, the
loop's repair history. The doctor reads and writes none of the loop's own
records, so no repair can hold, stop or slow a loop.

Every alert a loop raises — a gate failure, a runner failure, a blocked
ticket, the run's end — is also written to `.ralph/logs/notifications.jsonl`,
the local feed the dashboard reads. It is the one delivery that needs nothing
enabled: one `raised` line (kind, ticket, iteration, time, and the subject and
body redacted through `runner-signals.json`) before the alert is offered
anywhere, then one `delivery` line for each plugin's answer and for the ticket
comment. The feed is written even with pushes switched off
(`RALPH_PUSH_NOTIFICATIONS=0`) and when the notification record cannot be
locked: the alert then reaches nothing else, and its line says why
(`unsent`). An alert a plugin could not take — backed off from, not installed, or
answering that it had nowhere to send it — stays in the feed as undelivered,
with the plugin's reason.

**Orca** (`plugins/orca/`) mirrors a loop onto Orca's board — a Run for the
supervisor, a Task for the ticket, a Dispatch per attempt, a heartbeat on every
pulse — reads the Run's mailbox and decision gates into the local inbox, and
sends alerts to the Run. A command sent through Orca therefore obeys exactly
the fences a dashboard command does:

```bash
orca orchestration send --run <run> --type status --subject 'ralph control: pause' \
  --payload '{"control":{"command":"pause","run":"<RALPH_RUN_ID>","why":"frontier needs triage"}}'
```

Its verb allowlists refuse `worker-start`, `dispatch --inject` and
`terminal send`. `RALPH_ORCA_LIFECYCLE=0` turns the board mirror off and
`RALPH_ORCA_CONTROLS=0` the mailbox route, with the plugin still enabled. The
long-lived `observe.ts` process announces itself to plugins, and the Orca
plugin binds its terminal as the replaceable mailbox consumer, at a bounded
interval and immediately when the Run changes. A terminal already bound to
another Run is never stolen. `--once` and `--json` observations announce
nothing.

The Orca plugin's doctor checks, in order: the **CLI** is present (if not, the
only offer is to turn the plugin off); the **runtime** is reachable (`orca
status`; started with `orca serve`, headless, by default, or `orca open`); the
loop's **Run is registered** (re-registered from the loop's own record, from its
terminal or one the plugin opens); a **consumer is bound** to that Run, without
which a command sent from Orca never reaches the loop (the Run rebound to the
loop's terminal, or to an idle terminal the plugin opens in the worktree — never
one that runs a command); and nothing is in a **back-off window** (ended, and
the mailbox read once, now). A loop not started from an Orca terminal speaks to
Orca from the terminal the doctor bound for its run.

### Stop it and recover work

Use the run's `stop` control for an orderly stop at the next iteration boundary.
An idle loop is already at one: the frontier gate, a backoff, a blocked wait and
a turn held for the host lease check the control inbox every
`RALPH_CONTROL_POLL_SECONDS` (15s by default; the backoff checks on its own 60s
poll) and hand the command to the supervisor's checkpoint. A loop held for the
host answers it at the hold rather than at the next iteration boundary, which
it may not reach for hours.
For an emergency, use the loop page's **Stop now** rather than a hand-typed
`kill`. It signals only the process group named by the checkout's
`.ralph/logs/supervisor.pid`. Before any signal it checks that the pid is alive,
is running `ralph.sh`, and works in that checkout; that last check also catches
a reused pid. It also checks that the group is led by the supervisor or its
`start.sh` wrapper and is not the dashboard's own. A target that fails a check
is refused with the mismatch named, and nothing is sent. Stop now sends SIGTERM
to the group, then SIGKILL if anything in it, a child that ignored SIGTERM
included, is still running after ten seconds. SIGKILL goes only to a group that
is still provably the loop's: the kernel keeps a group's number while any member
holds it, so it could only be reused after the pid counter wrapped, and Stop now
checks that it has not. Every refusal and signal, with its target, checks,
outcome and the operator's reason, is appended to
`.ralph/control/signals.jsonl`. The entry for a signal is written before the
signal is sent. Once the supervisor is gone, the loop's own `controls.ts
interrupted` records the stop as `confirmed`, with the stop kind `interrupted`,
the iteration it cut short and the ticket. Do not use broad `pkill` commands:
every loop runs the same `ralph.sh`, so a pattern match hits all of them.

A killed iteration may leave commits, uncommitted files, and a claim. Stop now
keeps the claim, so no other loop takes the ticket while its work is in flight,
and the lease lapses on its own. The stopped loop's page shows the branch,
uncommitted changes and unpushed commits, and offers **Resume work** and
**Release**. Resume work runs `start.sh` in the same worktree with
`RALPH_RESUME_WORK=1` and `RALPH_RESUME_ISSUE` naming the ticket. `ralph.sh`
then leaves HEAD where it is: it never resets or fast-forwards to `origin/main`.
The new run reconnects that one ticket's claim, even a lease that lapsed
meanwhile, as long as no other run has taken it. Release gives the ticket back
and leaves the branch and commits as they are. Do not reset to `origin/main`
while recovery work remains. A clean checkout behind main must be refreshed
before starting; a mid-ticket checkout must be recovered first.

A loop's branch is a claim too (#480). A `<loop>/<n>-…` branch, local or on
`origin`, whose tip is recent and which has commits ahead of the base branch
keeps ticket n out of every loop's frontier, even after its `-wip` label is
lost, as in a rate-limit restart. "Recent" is `RALPH_BRANCH_CLAIM_MAX_AGE_HOURS`
(default 24). A stuck label on the ticket, or a hand-back comment newer than
the branch tip (a `blocked:` or `needs-migration:` record, a triager's
decision, an `### Operator decision`), ends the branch claim; any other comment
leaves it. The operator's **Release** does not delete the branch, so a
released ticket stays fenced until the window passes or the branch is deleted.

`abandon` may reclaim only an expired lease; a PID missing on this host does not
prove an owner on another host is dead. A lease past its expiry is not expired
while the supervisor that holds it still runs on this host: neither `abandon`
nor another loop's frontier takes it, and its heartbeat renews it again. It
expires once that supervisor is gone. `release` applies only to the owning run,
even once its lease has expired — another run's lapsed claim is `abandon`'s.
Both take the claim's `<loop>-wip` label off the issue before dropping the
lease, so every loop can claim the ticket again. If the label edit fails, the
command is refused with `gh`'s answer and nothing changes, so sending it again
is safe. A `release` that finds no lease still removes this loop's leftover
label, and never another loop's.
`retry` applies only when the last attempt failed, once per failure. The loop
page offers all three; with the supervisor gone it applies them at once through
the loop's own poll, with the Orca route off, under the worktree's
`supervisor.lock` so it never runs beside a supervisor.

A role may hold a lease outside that store — the ci-doctor's case lease, in
`<git-common-dir>/ralph/ci-health.json`, which expires in 120s. A role
registers its store in `role-leases.ts`, and the supervisor's heartbeat renews
whatever the running loop's role declares on the same pulse that renews the
claim, for as long as that run holds it. A holder the beat finds gone is
cleared from that store, under the rule `abandon` follows above — a pid
missing on this host says nothing about a holder on another one, so a reader
of those leases still honours their expiry. A role that registers no store,
which is every coder and triager, reads no file and takes no lock.

If recovery reports a stale `next-tasks-claim.lock`, verify no writer owns it
before clearing it, then reissue the command. Never break a lock to beat a live owner.

## Running a second loop

Use a separate worktree and a supported identity. Never check `main` out in the
loop worktree. Check `bun ~/ralph/frontier/next.ts -- --dry-run` first: a second
loop needs an independent ready staffing group, not merely another ticket under
the same spec.

The name must be in the project's `loops` (`.ralph/config.json`); adding a loop
means adding it there, through a reviewed PR, before its first start. For a
fresh `rafa` worktree of a project that already commits `.ralph/` with `rafa` in
its `loops`, after verifying the path is available:

```bash
git fetch origin
git worktree add --detach /path/to/project-rafa origin/main
cd /path/to/project-rafa
echo rafa > .ralph/loop-name
# The log directory preflight denies a start without (`logs-writable`). Git
# creates it only where the project tracks a file inside `.ralph/logs`.
mkdir -p .ralph/logs
# Create missing labels only; do not overwrite an existing loop's labels.
gh label create rafa-wip --color 1D76DB
gh label create rafa-blocked --color D93F0B
gh label create rafa-done --color 0E8A16
# A loop whose role is not `coder` needs more than the triple — its verdict
# vocabulary, and the project's difficulty labels. Ask, do not remember:
#   RALPH_LOOP_NAME=rafa bun ~/ralph/preflight.ts --labels
bun install
RALPH_LOOP_NAME=rafa bun ~/ralph/preflight.ts
RALPH_LOOP_NAME=rafa bun ~/ralph/frontier-gate.ts --once
~/ralph/start.sh
```

Authenticate the secrets CLI with access to the configured scope
(`secrets.project`/`secrets.config`; Loggd: `loggd-web/dev`); the supervisor
pins that scope itself. No per-directory `doppler setup` is required. Remove or
relocate an existing refused file (Loggd: `.env.local`) deliberately before
startup. To refresh a clean, finished checkout, fetch and run
`git checkout --detach origin/main`; never do that over an unfinished claim or
uncommitted recovery work.

If board visibility is wanted, enable the Orca plugin (`"plugins": ["orca"]`, or
`RALPH_PLUGINS=orca` for one run) and start from an Orca terminal in this
worktree; `ORCA_TERMINAL_HANDLE` identifies the pane. Verify
`bun ~/ralph/plugins.ts status` after launch. Missing mirroring is not proof the
loop never started.

If `git fetch` refuses to update a checked-out local `main`, inspect the fetch
refspec. Remove only an unintended self-updating `refs/heads/main` mapping; the
normal remote-tracking ref must remain. Do not delete a branch to bypass the error.

Loops share GitHub, provider quotas, development data, and physical CI capacity.
Separate worktrees isolate files; they do not isolate those services.

## Editing Ralph

Use [prompt.md](prompt.md), [models.json](models.json), and the relevant script as
the source of truth; project rules belong in the project's fragments, never
here. Update the stage's permission configuration whenever its runner changes.
Run the focused owning tests; shared lifecycle changes also need
[end-to-end.test.ts](end-to-end.test.ts), which exercises multiple loops
together, and prompt changes need [prompt-render.test.ts](prompt-render.test.ts),
which renders against Loggd's fragments in `fixtures/loggd/.ralph/`.

The suite has to pass on a loaded host, since the pre-push hook and a loop's
`test` gate both run it there. A test file that spawns `bash`, `bun`, `git` or
another process calls `subprocessSuite("<what it spawns>")` from
[test-timeouts.ts](test-timeouts.ts) at the top. That gives it a 30 s budget in
place of Vitest's 5 s, and a hang still fails. Don't raise `testTimeout` in
`vitest.config.ts`. The worker count follows the host's free cores
([test-workers.ts](test-workers.ts)); `RALPH_TEST_MAX_WORKERS=<n>` overrides it.

## The name guard

This repository is public and the loops push to it unattended, so every clone
a loop pushes from carries a pre-push hook, [name-guard.ts](name-guard.ts). It
refuses a push whose new commits add a name the host keeps private: in an
added line, a path, a commit message or an author. The names are not in the
repository (that would publish them). They live on the host, one
case-insensitive regex per line, in `~/.config/ralph/name-guard` (or the file
`RALPH_NAME_GUARD` names).

```bash
bun ~/ralph/name-guard.ts --install          # run inside each clone
bun ~/ralph/name-guard.ts --scan origin/main # check existing commits by hand
```

The guard fails closed: with the hook installed and no list, every push is
refused with the reason. A refused journal publish leaves its draft in place,
and a refused loop push fails that iteration; neither publishes anything.
Removed lines are not scanned, so a commit that deletes a name passes.

## The journal

[The journal guide](journal/README.md) owns naming and format. Journals live in
**this** repository, under each project's `journal.dir`. An iteration writes its
entry as a draft in the project (`.ralph/logs/journal-draft-<ts>-<n>-<session>.md`)
and runs `bun "$RALPH_HOME/publish-journal.ts" --draft <draft> --issue <n>`.

The publisher takes a lock (`~/.ralph/journal.lock`, or `RALPH_JOURNAL_LOCK`,
waiting up to `RALPH_JOURNAL_LOCK_SECONDS`), works in a harness-owned worktree
(`~/.ralph/journal-wt`, or `RALPH_JOURNAL_WORKTREE`) of the harness repo
(`RALPH_JOURNAL_HOME`, default this checkout) detached at `origin/main`,
commits exactly `<journal.dir>/<name>.md` as
`chore(<loop>): journal <project> #<n>`, pushes `HEAD:main`, and retries a
rejected push up to five times from a fresh `origin/main`. Every git call is
bounded by `RALPH_JOURNAL_COMMAND_TIMEOUT_MS`. It then deletes the draft; on
failure the draft stays for the next iteration. It never touches the project
checkout. `RALPH_JOURNAL_DIR` overrides the config's journal dir. Readers —
the prompt's orientation step (`journal-read.ts recent`), `status.sh`,
`observe.ts`, the dashboard — read `origin/main:<journal.dir>` from the
harness repo. The old `journal/loggd/progress.md` is an archive, not the
active journal.

### A journal in the project's repository (`journal.branch`)

A project whose journal should not sit in the harness — a client's, say, when
the harness is shared with someone — sets `"journal": { "dir": …, "branch":
"ralph-journal" }`. Its journal entries and its project learnings file then go
to that branch of the **project's** repository; `learnings/harness.md` stays
here. `journal-home.ts` resolves the location, and every writer and reader goes
through it.

- The first publish creates the branch as an orphan (no shared history with
  the code) holding a marked `README.md` and a `vercel.json` that turns off
  Vercel's git deployments for it. The publisher refuses any existing branch
  whose README lacks the marker, so a typo naming a code branch is never
  pushed to. The config refuses the base branch and `main`/`master`/`dev`/
  `develop` outright.
- Commits are built with plumbing (a private index and `commit-tree`), not a
  worktree, so nothing is added to the project's `git worktree list`. Subjects
  end in `[skip ci]`.
- Same lock, same five retries, same draft-kept-on-failure as the harness.

Moving an existing project: seed the branch from the harness's
`<journal.dir>/` and `learnings/<name>.md` first, then set the key, then
restart its loops so `ralph.sh` re-exports `RALPH_JOURNAL_BRANCH`.

## Continuous improvement from findings

Systemic findings live in the existing learnings files. When a learning has
a **Fix** that starts with `no issue yet`, publishing it now creates or reuses a
GitHub ticket and puts the ticket URL at the head of that field in the same
learning commit. Whatever the loop wrote after the placeholder (`no issue yet.
Make the parser read one line`) stays after the link and goes into the ticket
as its **Suggested fix**.
Project findings go to the project's configured repository; harness findings
go to the harness repository. The learning stays open until its fix merges.

An actionable finding also carries these fields:

```markdown
- **Change:** the bounded code change that removes the cause.
- **Verify:** the reproducible check that proves the cause is fixed.
```

With both fields, the ticket carries `learning-fix` and `ready-for-agent`.
Without them it carries `learning-fix` and `needs-triage`, and so does a fix
whose suggested text names an operator, a human, a person or something done by
hand: that is not a coder's ticket however well the code side is described. Every ticket includes
the evidence, current workaround and acceptance criteria. A ready finding with
no difficulty label remains available to routed coders; an explicit difficulty
label still controls which coder takes it. Coders use their normal claim,
implementation, review and merge gates, then retire the learning through
`publish-journal.ts --close` as before.

The publisher serialises filing and linking under the journal lock. A marker
in the ticket body identifies the learning across retries, including a failed
push; a paginated read includes closed tickets and avoids GitHub search-index
delays. This serialises loops on one host, as the journal publisher does.
Because even that read can miss a ticket created seconds earlier, the host
also keeps its own record of filed markers, `~/.ralph/findings.json`
(`RALPH_FINDINGS_RECORD` moves it), written the moment a ticket is created.
A record that exists but does not parse stops every filing on the host until
it is fixed or removed — reading it as empty is how a second ticket gets filed
— and each refusal prints `finding not promoted: findings record <path>
unreadable`. A revise also keeps a linked `Fix` over a draft that still says
`no issue yet`, so resetting one is a hand edit of the learnings file.
GitHub failures keep the pending learning for retry. Supervisors reconcile a
bounded batch before intake, with a 60-second startup ceiling, and coders retry
at orientation. To reconcile an existing backlog manually:

```bash
bun "$RALPH_HOME/findings.ts" reconcile
```

Each call handles at most three pending entries with stable learning slugs.
Set `RALPH_FINDINGS_DISABLED=1` to keep publishing evidence while disabling
automatic ticket creation. Entries that already name a fix are left alone.

To file one entry now, whatever its Fix says (the dashboard's **File ticket**):

```bash
bun "$RALPH_HOME/findings.ts" file <slug> --scope project|harness
```

It rewrites the entry's Fix to `no issue yet — <what it said>` and publishes
it through the same publisher, so the lock, the registry and the host record
still keep it to one ticket. The old Fix text becomes the ticket's suggested
fix, so an operator's job still goes to triage. It refuses an entry whose Fix
already names a ticket or a duplicate, or that lacks Seen or Workaround. It
prints `{ version, slug, url }`; `url` is null when the publish landed but
GitHub refused the issue, which leaves the entry queued for reconciliation.
`RALPH_FINDINGS_DISABLED` does not hold it: the operator asked by name.

## Compare arms on merged work

`experiments.ts eval <plan>` replays merged work against several **arms** and
compares them. Each arm runs one real coder iteration in a trial sandbox from
the work's merge-base, the same way a backtest trial does (below): the frozen
ticket, the simulated Revisión Claude review rounds up to the real cap, and a
fake GitHub and tracker, so nothing leaves the host. Every arm is then scored
the same way, a blind **judge panel** scores them on named axes, and an
unblinded **analyst** says what to change. The merged PR is the **reference**,
reported as arm `a`.

```bash
bun "$RALPH_HOME/experiments.ts" eval plan.json --dry-run
bun "$RALPH_HOME/experiments.ts" eval plan.json [--run-dir <dir>]
bun "$RALPH_HOME/experiments.ts" eval plan.json --rescore [--run-dir <dir>]
```

A plan with a `source` replays the PRs it names: the A/B on one PR.

```json
{
  "project": "/abs/path/to/the/project",
  "source": { "kind": "pr", "repo": "felipearos/loggd", "prs": [2731], "ticket": "#2702" },
  "arms": [
    { "name": "opus" },
    { "name": "sonnet", "lineup": "sonnet-coder" },
    { "name": "short-prompt", "overlay": "/abs/path/to/overlays/short-prompt" }
  ],
  "caps": { "trialMinutes": 90, "batchMinutes": 360 },
  "sources": { "felipearos/loggd": "/abs/path/to/loggd" },
  "scoring": {
    "setup": "bun install --frozen-lockfile",
    "judge": { "panel": [{ "runner": "claude", "model": "claude-opus-5-5" }, { "runner": "codex", "model": "gpt-6-luna", "name": "gpt" }] },
    "analyst": { "model": "claude-opus-5-5" }
  }
}
```

- `source.prs` are one ticket's merged PRs (1 to 10), in one repo. The case
  starts from the merge-base of the earliest-opened PR's first commit, and the
  ticket keeps only the comments from before that PR opened. `source.ticket`
  is `#<n>` for a GitHub issue of that repo or a key of the project's Linear
  or Jira tracker; left out, it is the one issue the first PR closes. A PR
  that is not merged, or a ticket that cannot be read or named, is refused
  before any model runs. A loop's merged PR may be the reference too; the
  dry run and the report say whose work it was.
- A plan whose `source` is `{ "kind": "set", "tags": [...], "cases": [...] }`
  runs the project's test set (#854), the cases committed under
  `evals/<project id>/` in ralph's repository (`evals-set.ts`). Both lists are
  optional (at most 200 entries each): no list runs every active and
  saturated case, `tags` keeps a case carrying any of them, `cases` keeps only
  the listed ids. A retired case never runs, the source names no `repo` (each
  case carries its own), and a selection that matches nothing is refused. A
  selected case whose checkout, base commit or PRs cannot be read here, or a
  picked id that is retired or gone, is listed under `## Unrunnable` with its
  reason while the rest run; the report records the set's commit as
  `set.version`. The Run screen offers it as "Test set" (all, by tag or
  hand-picked) and shows the trial count before the start.
- `arms` (1 to 6) each name a `lineup` — `live` (the default), or a file
  `~/.ralph/lineups/<name>.json` as `ralph-lineup-switch` keeps them — and an
  optional `overlay`: an absolute path to a directory of replacement prompt
  files (`prompt.md`, `coder.md`, `inspector.md`, `prompts/*.md`). The
  overlay is laid over the trial's staged copy of the harness, never the one
  on disk; any other file, a symlink, or a file the harness does not have is
  refused before the first lease. The run keeps each overlay's content hash
  in `overlays.json`, and a resume whose overlay was edited since is refused:
  one arm's name never covers two prompts. Names are kebab-case; `a` is the
  reference's. Arms rotate per case, so none always runs on the fresher host.
- `caps`, `rates`, `sources` and the rest of `scoring` mean what they mean for
  a backtest, below.

- `repeats` (0 to 3; 2 on a plan with a `source`, 0 on a clerk backtest or a
  noise-floor plan)
  is how many more trials each arm gets on a **disputed** case: one whose arms
  disagree on a green PR, or whose panel contested an axis. A case every arm
  passed, or every arm failed, is a clear answer and is not paid for again.
  Repeats run after the case's first trials (contested ones after scoring).
  Each repeat is scored and judged as a first trial is — held-out tests,
  gates, review, panel — into `<case>/scores-r<n>.json`, with its judges'
  logs in `<case>/scoring-logs-r<n>/` and its own shuffle seed (`<seed>/r<n>`).
  The merged PR is the same every time, so a repeat reuses its gates, review
  and rounds from the first scoring; its diff still goes to the panel.
  `## Repeats` in report.md, and Repeats on the Evals tab, show per case and
  arm the green runs, each axis's mean over the runs the panel scored with
  its lowest and highest, and the first trial's outcome and rank. The verdict
  stays the first trial's: the summary, the judge section and the ledger read
  only it, so a case's verdict means one thing.

- `usageGuard` (default 90; `false` turns it off) keeps the live loops
  first. Before each trial the run reads the session and weekly windows of
  every provider it spends from UsageBar (`codexbar usage --format json`,
  what the dashboard's usage bar shows): Claude's always, and Codex's too
  when an arm's lineup or a judge of the panel runs on Codex. When the
  fullest of them is at or over that share, the trial waits for it to reset,
  rereading at least every 15 minutes. The wait is not counted against
  `caps.batchMinutes`, and a trial waits at most 6 hours: past that, or when
  the wait itself fails, it runs. No UsageBar, or a provider it cannot read,
  guards nothing for that provider; with no reading at all the trial runs.

A plan with `clerk` and `sample` instead of `source` is a clerk backtest;
`experiments.ts backtest <config>` is the same command under its old name, so
existing configs and the nightly unit keep working.

### The judge panel and the analyst

`scoring.judge.panel` lists the judges, each a `runner` (`claude` or `codex`)
and a `model`, with a `name` when two share a model. A config that names
neither a panel nor `scoring.judge.model` (no `judge` block, or one with only a
`seed`) is judged by the default panel: `opus` (Claude, `claude-opus-5-5`) and
`gpt` (Codex, the first `codex` model the harness's `models.json` names) — the
panel the Run screen shows. When `models.json` names no Codex model, Opus judges
alone and the report's notes say why. A `model` without a panel keeps one
Claude judge on that model, as before. Every judge gets the
same prompt: the frozen ticket and each candidate's final head, plus its first
pushed head where review changed it, under neutral labels in an order shuffled
from the seed. It scores each candidate 1 to 5 on five axes, with evidence
(a file and line, or what is missing):

| Axis | Question |
| --- | --- |
| correctness | Does the final change do what the ticket asks, and correctly? |
| scope | No more than the ticket asks: no unrelated edits, no speculative extras? |
| tests | Do its tests pin the changed behaviour, without weakening others? |
| maintainability | Does it fit the codebase's patterns, clear and easy to change? |
| review | Did its review rounds make it better, first head to final? (— on one head) |

Each judge also says what each candidate did better than the others, and
ranks them. Where two **families** disagree on an axis, the axis is
**contested**: the report's `## Panel` section and the Evals view mark it ⚑,
list it and name the rule that decided it. It is never averaged away; it is
where to read the diffs. `scoring.judge.contested` picks the rule (#818):
`"inversion"`, the default when the key is absent, contests a pair of arms two
families order the opposite way; `{ "spread": N }` (above 0, at most 4)
contests one arm whose families' mean scores on the axis differ by N points or
more. A family's score is the mean of its judges', so a one-family panel never
contests anything. A judge
whose answer does not parse, or whose call fails, abstains, and the rest still
answer. The panel's ranking is each arm's mean place across the judges that
answered; it fills the old `## Judge` section and the ledger.

A Codex judge runs through `judge-codex.sh`: `codex exec` in bubblewrap over
an empty directory, with an in-memory Codex home holding only `auth.json`.
Codex cannot run without a shell, and its read-only sandbox does not scope
reads, so without bubblewrap a judge could read the scoring clone and tell the
human's diff from the agents'. No `bwrap` or no `auth.json` is that judge
abstaining, logged in `scoring-logs/judge-<name>.log`.

The **analyst** runs once after the panel (`scoring.analyst`, on by default on
`claude-opus-5-5`; `false` turns it off). Unlike the judges it is told which
arm ran which lineup and prompt overlay, with the overlay's prompt text, each
case's metrics and every verdict. It returns improvements, each tagged with
the **knob** it changes (`prompt`, `lineup`, `model`, `gate`, `review`), its
target, the change, and the cases it rests on. An improvement that cites no
case of the run is dropped, and the report says so. The answer is kept in
`analysis.json` and the report's `## Analyst` section. Its improvements are
suggestions for a person to try as another arm; nothing applies them.

## Backtest human tickets

A backtest replays tickets people already solved and compares the loop's work
with theirs. The human's merged PRs are arm A, the live lineup is arm B, and an
optional second lineup is arm C. Every arm's result is scored the same way and
judged blind, and the batch ends with one summary table.

`experiments.ts backtest` picks the batch a clerk backtest would replay: the
person tickets the clerk moved to the team board whose work merged as human
PRs. `--dry-run` only prints that batch; without it the batch runs.

```bash
bun "$RALPH_HOME/experiments.ts" backtest backtest.json --dry-run
bun "$RALPH_HOME/experiments.ts" backtest backtest.json [--run-dir <dir>]
bun "$RALPH_HOME/experiments.ts" backtest backtest.json --rescore [--run-dir <dir>]
```

```json
{
  "project": "/abs/path/to/the/clerk/project",
  "clerk": "clara",
  "sample": { "cap": 10, "since": "2026-10-01T00:00:00Z", "repos": ["example-org/acme-backoffice"] },
  "lineup": "codex",
  "caps": { "trialMinutes": 90, "batchMinutes": 720 },
  "rates": { "inputPerMTok": 15, "outputPerMTok": 75 },
  "sources": { "example-org/acme-backoffice": "/abs/path/to/acme-backoffice" },
  "scoring": { "review": true, "judge": { "model": "claude-opus-5-5" } }
}
```

- `project` (absolute) is a checkout of the clerk's project; its ledger and PR
  cache are read from that checkout's git common dir. `clerk` is the clerk
  loop's name, and must be a clerk on that project's roster.
- `sample.cap` is how many tickets to include. `sample.since` (optional, ISO
  time with a timezone) drops moves before it. `sample.repos` (optional) narrows
  to some of the project's `clerk.prRepos`; any other repo is an error.
- `lineup` (optional) is arm C's lineup, the file
  `~/.ralph/lineups/<name>.json`; arm B is always the live lineup.
- `sources` (optional; the run needs it) maps each sampled `owner/name` repo to
  the absolute path of a local checkout; the dry run ignores it. Point it at
  the checkout the live loops' worktrees belong to: the host lease lives in
  that checkout's git common dir, so a separate clone takes a lease no live
  loop reads. A trial also runs with that checkout's `.ralph/` and its
  `.github/workflows/revision-claude.yml` (tracked files, read from the working
  tree), not the base commit's, so it uses the config and the review the live
  loop gets today, even from a base that predates them; scoring reviews every
  arm, the human's included, with that same workflow file.
- `caps.trialMinutes` and `caps.batchMinutes` are positive, trial at most batch.
  `rates` (optional) needs both `inputPerMTok` and `outputPerMTok`.
- Unknown keys are refused, and every error names its key's dotted path.

The dry run reads the clerk's `moved` events (newest first, one per OA key,
`HELD-`/`SHADOW-` placeholders dropped) and the cached PR list, then for each
ticket views its merged PRs. The ticket is frozen at the earliest-opened human
PR, whose merge-base the trial starts from; the PRs are listed in merge order. Loop PRs (a `🤖 <loop> loop — run` line in the
body, or a `<loop>/` branch) are left out. It prints, per included ticket, the
keys, the repo, the human PRs in merge order, the first PR's merge-base and
start time, and how many ticket comments predate that start (kept) or not
(dropped); then the skipped tickets with a reason (`no merged PR`, `only loop
PRs`, `unknown repo` — split across repos, or outside `sample.repos`, `unreadable PR`, `unreadable ticket`), the arms and any
notes. It calls no model and writes nothing to the tracker, Slack or GitHub;
the one write is the clerk's local PR cache, refreshed when it is stale (a
failed refresh still stamps it, so the live clerk skips its next one for 15
minutes). Only comments are cut off: the title and description are as fetched.
The merge-base is taken from the first PR's first commit. A ticket moved before
the oldest PR of a full cached list (200 per repo) is skipped, as is one whose
PRs another sampled ticket already holds. On a clerk project without a keyed
`tracker` (GitHub's, or none), the tickets are read from the clerk's Jira
(`clerk.jira`: the OA key first, then the OAI one) with `RALPH_CLERK_JIRA_TOKEN`,
which is checked against `clerk.jira.project` before anything is sampled.

The run replays every ticket in a fresh trial sandbox built from its repo's
`sources` clone at the merge-base: arm B, then arm C when `lineup` is set,
alternating which goes first per ticket. Before any trial it refuses a sampled
repo with no `sources` entry (naming the key to add) and a missing lineup
file. Trials run one at a time, each under the host lease as its own `backtest`
party, so the live loops keep their turns between trials. A trial is killed at
`caps.trialMinutes`; when `caps.batchMinutes` runs out, the trials left are
reported as not run. A host lease not granted is asked for again every 5
minutes, and that wait counts against the batch cap. A trial that never ran
(no lease, a sandbox that would not build, the cap) is reported as not run and
left out of the state, so a rerun retries it. A usage limit the trial's own
supervisor waits out inside the trial counts against the trial and batch caps.
Only the batch runner's own pause, for a trial that ended without a sigil on a
usage limit, does not: it waits for the reset and reruns the trial, up to
three times. A trial still rejected after the third pause is reported as not
run, with the window and its reset (`usage limit: the five_hour window still
rejected it after 3 pauses; resets …`), never as failed against its arm: it
stays out of the state, so a rerun after the reset runs it. Each rejected
attempt's files are kept under `<ticket>/<arm>/usage-limited-<n>/`.

The run directory defaults to
`<project>/.ralph/logs/experiments/backtest-<hash of the config>`, so rerunning
the same config resumes the batch where it stopped, with the sample it started
with; `--run-dir` names another. The hash leaves out `scoring`, so a rescore
with other scoring settings reads the same dir. Each trial writes `<ticket>/<arm>/`:
`ticket.json` (the frozen ticket), `result.json`, `patch.diff` (what it pushed),
`partial.patch` (its whole work tree against the base, pushed or not),
`arm.bundle` (its commits past the merge base) and its `logs/`. The batch writes `report.md` and `report.json`, and prints the
report. Ctrl-C kills the current trial and exits 1; rerun to resume. Nothing is
published: no PR, push, tracker write or Slack message.

Under its header the report records what the run actually used (#816), so two
runs of one lineup name can be told apart: each arm's stages as runner, model
and effort, resolved when the arm's first trial was built (`live` from the
harness's `models.json`) and kept across a resume, its overlay's sha256, and
the judge panel with its seed. A rescore rewrites the panel and seed to the ones
it scored with. `report.json` carries the same under `resolved`; a report from
before it has none, and the Evals tab shows it as before.

A trial's patch is the project's code, so the Evals tab's Patch link opens it
on the local dashboard always, and on the remote dashboard only for a project
that set `relayEvalPatches` in its config (#825); without it the remote page
shows no Patch link.

The Evals tab's **Test set** screen (#856) lists the committed cases
(`evals-set.ts view`) and adds, edits and retires them through `evals-set.ts
add|edit|retire`, one commit each; both pages can do it, since the three
writes are relayed commands. The remote store must know the new command
kinds: run `dashboard/remote/migrations/20261119-eval-set-commands.sql` once,
as its header says, or the remote page's writes fail on `command_kind_check`.
A case's notes and reason reach the remote page only under
`relayEvalPatches`; the local edit form reads them from a local-only route.

**Attach check** (#857) gives a case with no objective grader an operator
check: `evals-set.ts check --case <id> (--test <path> | --command <cmd>)`. A
`--test` path is read from the case's reference commit and run with
`scoring.testCommand`; a `--command` runs at the tree's root, exit 0 passing.
The CLI clones the source, runs the check on the case's base and on its
reference, and stores it, with both outcomes, only when it fails on the base
and passes on the reference. Passing on the base, failing on the reference, or
not running at all (a missing file, a missing command, a timeout) is refused
with the reason, and nothing is stored. `--source <checkout>` names the repo's
checkout when it is not the project's; `--timeout <seconds>` bounds each run
(the dashboard passes 45, so all four runs, setup included, fit its 240 s bound). The remote page's Attach check needs
`dashboard/remote/migrations/20261119-eval-set-check-command.sql` run once as
well.

The **Suggestions** screen (#858) ranks the project's last 200 merged PRs by
how much the loops struggled on them (`evals-set.ts suggest`): a linked ticket
carrying a `<loop>-blocked` label or parked, a revert, review rounds past a
threshold, a ci-doctor or pr-medic journal entry naming the PR, a slow
claim-to-hand-off in the speed ledger, or a person finishing a ticket a loop
claimed. Each suggestion states
its reasons; a PR any case holds, retired included, is never suggested, and a
source that cannot be read is named on the screen instead of failing it. Its
Add opens the Test set's add form prefilled; nothing is added on its own. The
weights are `evalSuggestionWeights` in the project config.

After the batch, every arm is scored, and the report gains a `## Scoring`
section. Each ticket's source is cloned into a scratch dir; each agent arm's
commits come from its `<ticket>/<arm>/arm.bundle`, and the human arm's from
its PRs. The held-out tests are the test files the human PRs' own commits
changed: first-parent, no merges, so a test a PR branch merged in from main
does not count, and each PR's tests are read from that PR. They run first on
the merge base: a file that already passes there is no evidence, and the
report says so. Then they run on each agent arm's final tree; a test that does
not apply there is `n/a`. The human arm's gates run on its final head; an agent
arm keeps its trial's. Gates are read from the merge base's `.ralph/config.json`,
or from an arm's sandbox base when the merge base has none.

A base that is already red is not held against anyone (#579). Before the
iteration starts, the trial runs the gates once on its base, in a clone beside
the work tree (after `scoring.setup`), and records which tests fail there:
vitest and jest `FAIL` lines and tsc errors. A trial check that fails only on
those tests reports green, with a note naming them. Any new failure, or a
failure whose output names no test, stays red. Scoring records the merge
base's red tests in the same way. It judges the human arm's gates against
them. It also re-runs an agent arm's failing gate when the base fails that gate
too. A trial row whose only red is base-red is rewritten `green-pr`, so a
rescore corrects a run made before this. The report lists each ticket's
base-red gates under `### Base-red gates`, and a Gates cell counts forgiven
ones as `(1 base-red)`. Without `setup`, a project that needs its dependencies
installed records no test names on the base, and its gates are judged by exit
code as before. The trial keeps `gates.json`, `base-red.json` (the record)
and `base-gates.log` under its scratch root. Scoring writes
`scoring-logs/base-gates.log`, `a-gates.log` and `<arm>-gates.log`. Both run
`bun base-red.ts record --gates <gates.json> --out <record>` for the base and
`bun base-red.ts checks --gates <gates.json> --base-red <record>` for a head,
and either command can be run by hand to see how a gate is judged.

A local Revisión Claude reviews each arm's first and
final heads against the base. The human arm also gets its open-to-merge time
and its review rounds: the distinct commits reviewed on each PR, less one per
PR. An agent's rounds are its pushes after the first. The two are close, not
identical. Each ticket writes `<ticket>/scores.json` and its command logs in
`<ticket>/scoring-logs/` (rewritten on each rescore), each review
`<ticket>/<arm>/review-<first|final>/`, and report.json and report.md are
rewritten with the scores. A scoring failure leaves the trial report as it
was. A stopped batch is not scored, and a Ctrl-C during scoring keeps the
previous report and scores. `--rescore` scores a run dir again
without running a trial: it needs the dir's `state.json` and `report.json`.

The optional `scoring` block sets how arms are scored:

```json
"scoring": { "testGlobs": ["**/*.test.ts"], "testCommand": "npx vitest run {file}", "setup": "npm ci", "review": true, "judge": { "model": "claude-opus-5-5", "seed": "march" } }
```

- `testGlobs` picks the held-out files from the human PRs' changes; the
  default is `**/*.test.ts`, `**/*.test.tsx`, `**/*.spec.ts`, `**/*.spec.tsx`
  and `e2e/**`.
- `testCommand` runs one file, with `{file}` replaced by its path; the default
  is `npx vitest run {file}`. Each command is killed at `caps.trialMinutes`.
- `setup` (default none) runs once in each tree before its tests or gates.
  Before a case's first trial, under the host lease, the merge base is cloned
  and `setup` is run there once (#820). A case whose setup fails or times out
  runs no trial: every arm is reported not run, with the setup's tail under
  `## Not run`, and is left unsaved so a rerun builds the base again. A base
  that builds but whose gates are red still runs; base-red covers that.
- `review` (default `true`) turns the local review on or off.
- `judge` (default on) configures the blind judge below. With neither `model`
  nor `panel` it is the default panel: Opus plus the Codex model `models.json`
  names, Opus alone (with a report note) when it names none. `model` alone is
  one Claude judge on that model. `seed` fixes the shuffle and defaults to the
  run's id. `false` turns the judge off. `panel` lists Claude and Codex judges
  scored on axes (see "The judge panel and the analyst" above).
- `analyst` (default on, model `claude-opus-5-5`) runs the analyst after the
  panel; `false` turns it off.

With `model` and no panel, the judge makes one Claude call per ticket. That
call gets the frozen ticket and every arm's final diff, each labelled only
"Candidate 1", "Candidate 2" and
so on, in an order shuffled from the seed and the ticket key. It runs with no
tools, in a scratch directory, so nothing tells it which diff the human wrote
or which lineup wrote the others. It ranks the candidates in tiers, best first,
and a shared top tier is a tie. The labels are mapped back to arms only after
the call. The verdict, the order the judge saw and the seed are kept in
`scores.json` and listed under `## Judge` in the report. The human candidate
is each PR's own change in merge order, read like the held-out tests: the
paths its first-parent, non-merge commits touched, diffed from the PR's first
commit's parent to its head. Files only main changed stay out, whether main
was merged into the branch or moved between two PRs. A file the PR touched
shows its whole change, including any main merged into that same file. A run is held to 20
minutes, or `caps.trialMinutes` if that is shorter. An arm with no diff is left out of the
candidates, with a note saying why. With fewer than two candidates, a failed
call or an answer that does not name every candidate exactly once, the ticket
is reported as not judged. The run does not stop.

### What the numbers mean

`report.md` opens its comparison with `## Summary`, one row per arm:

- **Gates**: the share of tickets whose required checks all passed on the
  final head. The agents' come from their trials. The human's are rerun on
  scoring.
- **Held-out**: the human's own tests that failed on the merge base and pass on
  the arm's final tree. Tests that already passed on the base are left out,
  because a pass there proves nothing. The human arm has none: those tests are
  its own.
- **Median findings**: the local review's P1 to P3 count on the final head.
  Unreviewed heads are counted beside it, never as zero.
- **Judge wins**: outright wins and ties among the tickets the judge ranked
  that arm on. A ticket where the arm had no diff is counted beside them
  (`without a diff`), never as a loss.
- **Median rounds, wall time, cost**: an agent's rounds are its pushes after
  the first, and its time is the trial's run time. The human's rounds are its
  re-reviewed commits, and its time is open-to-merge. The clocks differ, so
  compare times within an arm across batches, not between A and an agent. The
  human arm has no cost.

A test-set run (#855) adds `## Objective and judge scores` after the summary.
Each case gets a grader:

- `tests`: at least one held-out test fails on the base.
- `check`: the case carries an operator check, and no held-out test fails on
  the base. Scoring runs the check on each agent arm's final tree; a check
  that cannot run there fails the arm. A score written before #857 ran no
  check, and its check cases read as *pending*.
- `judge-only`: anything else. UI and refactor cases belong here, and they
  stay in the set.

A case whose held-out tests all already pass on the base is also flagged
`no evidence`.

Per arm, the section shows two scores:

- **Objective**: the graded cases the arm passed (every held-out test the base
  failed now passes, or the operator check passes), out of the graded cases,
  with any pending checks counted beside it.
- **Judge**: the panel's mean 1–5 over the cases it scored, with that count.
  Each case's score pools the non-null axis scores of the judges that answered.

The two are never added, averaged or weighted into one number. The same
columns appear in the Evals run view and, for graded ledger lines, in
`RESULTS.md`. Ledger lines carry them as optional `grade`, `objective` and
`judge` fields.

### The noise floor (#859)

A gap between two arms means something only when it is wider than what
identical arms already differ by. **Measure noise floor** on the Test set
screen starts a plan with `noiseFloor: { measuredAt }`: N identical arms on the
live lineup with no overlay (`evalsNoiseFloor.arms`, default 3), over the whole
set, with no repeats. The card shows its trial count and usage before the
button, like any run. `parseBacktest` refuses a `noiseFloor` plan off a set
source, with a non-live arm or an overlay, fewer than 2 arms or repeats above
0, and `completePlan` refuses one that names tags or cases. `measuredAt` is in
the run-directory hash, so measuring an unchanged set again is a new run.

A floor run that finishes whole writes `noise-floor.json` beside its report:
the set version, the cases, and the spread (highest minus lowest) of the
arms' objective pass rate and judge mean, both over the cases every arm
graded, set-wide and per case. Its report.md says `## Noise floor`. A run the
batch cap stopped stores none; a rescore of a finished one rewrites it.

Every later set run's report carries `noise`, its gaps against the newest
floor, and report.md adds `## Against the noise floor`: each later agent arm
against the first, objective and judge in separate columns, `within` or
`beyond`. The floor is **stale** when the cases this run ran and the cases
the floor measured differ by more than `evalsNoiseFloor.staleShare` (default
0.2) of the floor's cases; exactly at the share it is still fresh. On a
whole-set run that is the cases added plus retired since the floor; a run
over a slice of the set reads stale against a whole-set floor. A stale or
missing floor labels a gap `(floor stale)` or `(no floor)`, never `beyond`.
The Test set screen says whether the newest floor still fits the current set,
and each run card repeats its gap lines.

### Saturated cases (#860)

A case every agent arm passed in each of its last N set runs no longer tells
arms apart. `evals-set.ts view` flags it per row (`saturation`), and the Test
set screen shows it **saturated**, suggested for retirement. N is
`evalsSaturation.runs` (default 3). A run counts when it is a finished set run
that graded the case; one run in the window that any arm did not pass clears
the flag, and fewer than N runs never raise it. An arm passes a tests or check
case when its objective result is `pass` (a pending check is not a pass), and
a judge-only case when the panel ranked it at or above the reference.

The flag only suggests. A case's stored status changes only through the
operator: **Retire** (`evals-set.ts retire <id>`), or **Keep**
(`evals-set.ts keep <id>`), which commits `keptAt` so only set runs started
after it count, and the case is flagged again only after N more full passes.
Keep is a relayed command like the other writes; the remote store needs
`dashboard/remote/migrations/20261119-eval-set-keep-command.sql` run once.

**Calibration verdicts (#876).** When the operator thinks the panel got a
case wrong, **I disagree** on any Results case records which of two arms was
better on one axis, and why:

```bash
bun evals-set.ts calibrate --case <id> --arm <a> --arm <b> --axis <axis> --prefer <a|b> --reason "<why>" [--by <name>]
```

The verdict is stored on the test-set case (`calibration`), in one commit,
through the same locked write as every other case change. A case the set
does not hold is refused, and so is a malformed verdict, by its dotted path.
Verdicts are graded-only: `withoutGraded` drops them, so an improver never
fits to a person's verdicts. A Results case from a run that did not come from
the set is matched to the set by repo and PRs. The Test set screen counts each
case's verdicts and lists them with their reasons only when the project relays
details (`relayEvalPatches`). A summary-only project shows the counts and never
the reasons. **Calibrate next** lists the cases that the newest set run holding
them contested, with the cases that have no verdict yet first: there a person's
verdict matters most. A verdict sent from the dashboard is recorded `by
dashboard`, because no page knows who the operator is. I disagree is a
relayed command; the remote store needs
`dashboard/remote/migrations/20261119-eval-set-calibrate-command.sql` run once.

**Judge accuracy (#877).** The share of calibration verdicts the panel agrees
with, per axis and overall, each with the number of verdicts it rests on. The
panel's side on a verdict's axis is the arm with the higher mean judge score;
equal means disagree, since the operator saw a difference the panel did not.
A verdict on an axis the panel contested for those arms is left out, and
counted as such. A verdict whose case or arms the run lacks counts nowhere.
With no verdict counted it reads "no calibration yet", never 0% or 100%, or
"no verdict counted" when every verdict was on a contested axis. The means
read only the judges that scored both arms. A noise-floor run gets none. A
set run carries it in three places:

- **Results**, computed fresh from the set (read without a fetch) each time
  the run list is read, so a verdict recorded after the run counts.
- **`report.json` / `## Judge accuracy` in `report.md`**, against the
  verdicts as they stood when the report was written; a rescore re-reads them.
- **The ledger**, where each line keeps the verdicts its case was checked
  against (`calibration`), since a line is written once; `RESULTS.md`
  re-tallies them under `## Judge accuracy`. A line written before #877 has
  none, and the page renders as it did.

The budget bounds hours, not dollars. `caps.trialMinutes` kills one trial,
`caps.batchMinutes` leaves the rest not run, and a not-run trial counts in no
rate. Costs without a runner figure or `rates` stay unknown, and a total that
has unknown costs in it is marked as a lower bound.

These numbers show direction, not significance. A batch is ten tickets or
so, picked from one clerk's board. Judges have their own biases, which a
panel of two families narrows but does not remove, and the human arm had
reviewers and context the agents did not. Read a gap between arms as a reason
to look at the diffs, never as a verdict on its own. The skipped
tickets section says which tickets could not be replayed and why. A sample
that skips most of the board describes the tickets that were left.

### Guardrail verdict (#871)

A set run with exactly two agent arms, one of them the live setup (lineup
`live`, no overlay) and the other the proposal, carries a guardrail verdict in
`report.json`, under `## Guardrails` in `report.md`, and on its Results card.
Runs carry no goal yet, so it judges both goals, each condition with its
reason:

- **quality**: every selected case ran on both arms; objective score up
  beyond the noise floor (a gap exactly at the floor is no gain); no case the
  baseline passes is lost; judge score not down; cost at most
  `evalsGuardrails.maxCostRise` more (default +15%).
- **cost**: every selected case ran on both arms; tokens down at least
  `evalsGuardrails.minTokenCut` (default 10%); no case lost; objective score
  not down; judge score down by no more than the noise floor.

Scores and spend are compared on the cases both arms ran. Cost is reported
USD when every trial of both arms reported it, else tokens. A missing or
stale noise floor fails the floor-bound condition with "remeasure the noise
floor", so the verdict never passes on it. Two live arms, none, or more than
two agent arms get no verdict.

### Recommended-runs inbox (#872)

The inbox is a per-project queue of run plans waiting for the operator, kept
in `.ralph/logs/experiments/inbox.json` beside the run directories. Each entry
is a plan as the Run screen builds it, plus who recommended it (an `agent` or
a `person`), why, and when. `evals-inbox.ts` reads and writes it:

```bash
bun evals-inbox.ts list
bun evals-inbox.ts add --reason "<why>" [--by <name>] [--agent] < plan.json
bun evals-inbox.ts start <id>
bun evals-inbox.ts dismiss <id>
```

`add` stores a plan only if it passes every check a start makes before it
launches, and is refused in the plan parser's words otherwise. `start` takes
the entry out of the inbox, then launches its plan through the same function
as the Run screen's Start (`startRun`, behind `experiments.ts start`). A
second Start of the same entry, from the local or the remote page, finds
nothing. A refused start puts the entry back. `dismiss`
removes an entry without running it. Nothing starts an inbox run by itself:
the store module cannot start a run, and only `start` does, on an operator's
command.

The Evals tab's **Inbox** screen lists the waiting runs, each with its reason,
its worst-case trial count, and an estimate of its usage from the project's
median trial. **Start** and **Dismiss** act on one entry. On the Run screen,
**Add to inbox** stores the form's plan, with the operator as recommender,
instead of starting it. Its rows carry a plan's summary and never the plan
itself, so every project's inbox is relayed in full, summary-only projects
included. Add, start and dismiss are relayed commands; the remote store needs
`dashboard/remote/migrations/20261119-eval-inbox-commands.sql` run once.

### The improver: Propose improvement (#873)

The improver is a one-shot Claude session on a finished run that has an
analysis. It is not a roster role: it takes no claims, leases, labels or
frontier. The operator picks a **goal**, `quality` or `cost`:

```bash
bun evals-improve.ts propose --run <id> --goal quality|cost [--project <path>] [--model <id>] [--detach]
```

Its input is built by `improverInput` in `eval-improver.ts`, which is the
overfitting guard. It takes field by field the analyst's improvements, the
arms' configurations, the live lineup, the arms' own diffs, trial logs and
review threads (title, priority, answer), the current text of every prompt
file an improvement targets, and each case's id, tags, ticket title and body.
Patches keep their head and logs their tail, at 20 000 characters each, and
the whole input stops at 300 000; what that drops is counted for the model. It never takes held-out tests, checks, operator
notes, report scores, or the reference arm `a`'s diff, the change that
actually merged.

The model answers with one **proposal**:

- a goal, and a kind: `prompt-overlay` (the full text of prompt files, held to
  the overlay rule that only `prompt.md`, `coder.md`, `inspector.md` and
  `prompts/*.md` may be replaced) or `lineup` (stage → model and runner).
  A cost proposal may move a stage to a cheaper model.
- content, and a rationale citing the analyst improvements it answers.

A malformed proposal is refused with the reason, and nothing is stored. So is
an overlay file that drops a `{{…}}` placeholder its current text has, and a
lineup that `models.json`'s validator refuses. A stage moved to another runner
keeps only its runner and model, not the old runner's effort or fallback.

An accepted proposal is stored as
`.ralph/logs/experiments/<run>/proposals/<prop-id>.json`. An overlay
proposal's files go beside it under `<prop-id>/overlay/`. A lineup proposal is
written as `~/.ralph/lineups/improver-<prop-id>.json`: the live `models.json`
with those stages changed.

The proposal then puts a **recommended run** in the inbox, recommended by the
agent `improver`. That run is the current setup against the proposal, on a
subset of the test set. The subset is the cases the cited improvements rest
on, the source run's failed cases, and the active cases sharing a tag with
those, in that order, capped. The size and whether failed cases are included
are `.ralph/config.json`'s `evalsImprover: { "size": 12, "failed": true }`.
Only a test-set run can be proposed on, and a subset with no active case is
refused, since an empty case list reads as the whole set. Nothing starts the
run.

On the Results screen, a finished test-set run with analyst improvements
shows **Propose improvement** with a goal picker. It sends the command
`POST /api/evals/improve/propose` (`{run, goal}`, relayed remotely), which runs
the CLI with `--detach`. The run is checked at once, and the model session
runs in the background. Each propose logs to its own
`<run>/improver-<nonce>.log`, and the model's transcript goes to
`improver-<nonce>.model.log`. A refusal after the start is recorded only
there. The
remote store needs
`dashboard/remote/migrations/20261119-eval-improve-command.sql` run once.

### Proposals: from subset run to verdict (#874)

The Evals tab's **Proposals** screen lists every proposal for the project,
newest first, with its goal, kind, status and verdict, and links to the run it
came from and to its subset and full-set runs. Its status is never stored: it
is read off the runs that carry the proposal's arm (lineup
`improver-<prop-id>`, or an overlay under `proposals/<prop-id>/overlay`):

| Status       | Means |
| ------------ | ----- |
| `proposed`   | its subset run waits in the inbox |
| `subset-run` | the subset run is running, or finished promising and its full-set run is not yet recommended |
| `full-run`   | the full-set run is recommended in the inbox, or running |
| `passed` / `failed` | the guardrail verdict (#871) on the full-set run, per condition; for a prompt proposal, its `rejudge` verdict (#878) |
| `suggested` / `confirmed` | a test-set proposal (#878) waiting on the operator's Confirm, or one the set now shows done |

A subset run is **promising** when every condition of the proposal's goal
passes except the noise-floor ones (`objective-up`, `judge-within-floor`):
the floor is measured on the whole set, so a few cases say nothing against it.
A promising subset run earns exactly one full-set run in the inbox (same arms,
scoring and repeats, `cases: []`), recommended by the agent `improver` the next
time the proposals are read (`bun evals-proposals.ts list`, which the page and
the bridge call); the proposal file records it as `full`, under a lock, so it
is never recommended twice, and a dismissed one is not asked again. An
unpromising subset run marks the proposal `failed` with the conditions that
lost it and recommends nothing. A failed proposal stays listed with its
verdict, so the operator can see what was tried and why it lost.

The rows never carry the proposal's overlay, lineup or a diff. The rationale
and the analyst improvements it answers are shown only when the project set
`relayEvalPatches`; a summary-only project relays goal, kind, status and
verdict. The read is `GET /api/evals/proposals`, relayed as the
`evals-proposals` snapshot at the feed cadence; it needs no migration.

### Open PR: a passed proposal becomes a change a person merges (#875)

A `passed` row has one action, **Open PR**. It is a command request
(`POST /api/evals/proposals/open-pr {"proposal"}`, relayed as
`eval-proposal-open-pr`), and the machine runs
`bun evals-proposals.ts open-pr <prop-id>`, which:

- recomputes the proposal's status from its runs and refuses anything but
  `passed`, so a stale or forged page cannot open a PR;
- answers the PR already open on `evals/proposal-<prop-id>` instead of opening
  a second, and refuses when a merged or closed one exists (a person decided);
- applies the change in a scratch worktree of ralph off `origin/main`: an
  overlay's prompt files, or the lineup laid over the CURRENT `models.json`
  (not the trial's snapshot, which would revert later edits). An overlay
  replaces files whole, so the improver records each file's base hash when it
  proposes, and open-pr refuses when `origin/main`'s copy differs (propose
  again on the current prompts). What is staged is fenced to prompt files or
  `models.json` alone;
- commits `prompts: …` or `models: … (#803)` with the rationale as its why,
  pushes the branch, and opens the PR with `gh`. Its body carries the set
  version, the panel and the noise floor it was proven against, the
  scorecard, the guardrail verdict with each condition's reason, the
  quality-vs-cost plot as a table of its numbers, and the contested cases.

Nothing merges it: no code path calls `gh pr merge`, and a test pins that.
`evalsImprover.autoMerge` parses and defaults off but changes nothing. A store
created before this needs
`dashboard/remote/migrations/20261120-eval-proposal-open-pr-command.sql`.

### Evaluation proposals: judges, analyst and the test set (#878)

The improver may also propose a change to the evaluation itself, under rules
that keep it from grading itself up. Five more kinds:

| Kind | Content | Settled by |
| ---- | ------- | ---------- |
| `judge-prompt` | new opening instructions for the judge panel | `rejudge` |
| `analyst-prompt` | new opening instructions for the analyst | `rejudge` (always fails today) |
| `case` | a new case from merged PRs no case holds | the operator, on Test set |
| `check` | a test file as the check for a case that has none | the operator, on Test set |
| `retire-suggestion` | retire a case its set runs show saturated | the operator, on Test set |

The judges' and the analyst's opening instructions live in
`eval-prompts/judge.md` and `eval-prompts/analyst.md`. Every scoring pass reads
them, so a file there changes all judging. When a file is missing or empty, the
text built into `eval-panel.ts` and `eval-analyst.ts` is used, which is the
normal case.

A **prompt proposal** queues no subset run. Instead,
`bun evals-proposals.ts rejudge <prop-id>` scores the run the improver read
twice, in scratch copies (the source run is never written), on the cases that
carry calibration verdicts: once with the current instructions and once with
the proposed ones. It passes only when judge accuracy against the operators'
calibration verdicts rises AND no arm's objective outcome changes. The mean
score is reported, but raising scores alone never passes. The verdict is stored
once, in `proposals/<prop-id>/verdict.json`, and is final: to try again,
propose again. Accuracy is compared only on the same verdicts (the
`same-verdicts` condition), so a prompt cannot gain by contesting the ones it
would get wrong. A `rejudge.lock` beside the verdict fences two re-judges of
one proposal; if a re-judge died, remove the lock it names. An analyst prompt
is not rescored: its instructions never reach the judges, so it fails at once
on `measurable` until an analyst-accuracy measure exists. A passed one has **Open PR**. The PR changes only its
`eval-prompts/` file, is refused when `origin/main`'s copy has moved since the
proposal was measured, and carries an **Accuracy evidence** section (current
vs proposed accuracy per axis, the conditions, the mean score) in place of the
scorecard.

A **test-set proposal** only adds a case or a check, or suggests a retirement.
One that would edit or remove an existing case, its held-out tests, its check
or its notes is refused when proposed, with the reason. An accepted one is
`suggested`. It is listed under **Suggested by the improver** on the Test set
screen, and nothing reaches the set until the operator presses **Confirm**.
Confirm sends the screen's own add, check or retire command, so a suggested
check still has to fail on the base and pass on the reference (`evals-set.ts
check`). An improver's check names a test file only, never a command: a
model-written command would run on the host after one click, so a command
check stays an operator's. Once the set shows the change, the proposal reads `confirmed`; if the
set has moved so that it would now edit something, it reads `failed`. A
test-set proposal never opens a PR. On a summary-only project, the row shows
no content and no Confirm.

## Keep the backtest results

`backtest-ledger.ts` keeps one permanent record per clerk project on this
repository's `main`: `backtests/<project>/RESULTS.md`, rendered from
`ledger.jsonl` beside it. It publishes under the journal's lock and worktree.

```bash
bun "$RALPH_HOME/backtest-ledger.ts" nightly backtest.json
bun "$RALPH_HOME/backtest-ledger.ts" record <run-dir> --project-id <id>
```

`nightly` takes the same config as `experiments.ts backtest`. It reads the
ledger from a freshly fetched `origin/main`, samples only tickets the ledger
does not hold and whose human PRs it does not name, runs them in
`.ralph/logs/experiments/nightly-<day>` and records them. `sample.cap` is how
many new tickets one night may pay for. With nothing new it spends nothing.

- A ticket whose trial did not run is not recorded, so the next night retries it.
- A ticket's first verdict stands; a later run does not replace it.
- A ledger it cannot fetch or parse stops the night before any model runs,
  because reading it as empty would pay for every ticket again.
- A run cut short (a reboot mid-scoring) or whose record failed stays on disk. The
  next night finishes and records it first, in its own directory, and samples
  nothing new until it has. Finished trials are not run again.

Run it from a user timer, not from a session shell. The token comes from the
clerk's secrets, for that one command:

```ini
# ~/.config/systemd/user/ralph-backtest-nightly.service
[Service]
Type=oneshot
WorkingDirectory=<clerk checkout>
ExecStart=/bin/bash -lc 'export RALPH_CLERK_JIRA_TOKEN="$(doppler secrets get RALPH_CLERK_JIRA_TOKEN --plain -p <project> -c <config>)"; exec bun %h/ralph/backtest-ledger.ts nightly %h/.ralph/backtests/<config>.json'

# ~/.config/systemd/user/ralph-backtest-nightly.timer
[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true
[Install]
WantedBy=timers.target
```

## Known gaps

The frontier cannot prove every prompt-level condition, including every open-PR
relationship. A ready verdict is eligibility evidence, not permission to
duplicate work. Preserve the iteration's recheck before claiming. The rescue
limit is not one of those conditions: it is the `<loop>-blocked` label the
second failed rescue applies, which the frontier and the gate both honour, and
removing the label resets it. Two things remove it — an operator, and the
triager's `unblock` op, bounded as above. No other op may clear another loop's
claim label.

Synthetic multi-loop tests do not measure shared provider quotas, CI capacity, or
live merge races. Observe those when increasing concurrency instead of treating
passing fixture tests as a production capacity measurement.
