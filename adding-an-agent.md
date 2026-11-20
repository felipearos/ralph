# Adding a new agent (loop)

A step-by-step guide to bringing a new loop up on a project that already runs
Ralph, e.g. adding `testo` to Loggd next to `ralph`, `rafa`, `remo` and `rulo`.
Each step says what breaks if it is skipped, because most of them fail silently
until the first start.

The examples use Loggd's values: repo `felipearos/loggd`, base branch `main`,
main checkout `/home/faros/loggd`, loop worktrees under
`/home/faros/.local/share/ralph/workspaces/loggd/<name>-loop`, harness at `~/ralph`. Replace
`testo` with the new name throughout.

## Checklist

| # | Step | Where | Skipped → |
|---|------|-------|-----------|
| 1 | Pick a name | — | roster PR rejected by config validation |
| 2 | Pick its role | — | wrong labels, wrong lineup shape, and a second roster PR to change it |
| 3 | Add it to the roster by PR, and merge (a verifier also needs its `verifier` block, a sentinel its `sentinel` block) | project repo `.ralph/config.json` | `ralph.sh` refuses the name; dashboard Start stays refused (`pending-merge`); a verifier or a sentinel without its block is refused (`project-config`) |
| 4 | Create the worktree, `.ralph/loop-name` and `.ralph/logs` | project checkout, or the dashboard's **Create checkout** | loop runs under the wrong identity (claims as `ralph`); preflight refuses (`logs-writable`) |
| 5 | Refresh the worktree to `origin/main` after the roster PR merges | loop worktree | stale config (e.g. missing a required check); supervisor refuses a worktree behind base |
| 6 | Create the labels its ROLE needs (on GitHub, preflight creates a verifier's five verdict labels and a sentinel's `ready-for-human` itself) | project repo on GitHub | **preflight refuses startup** (`loop-labels`) |
| 7 | Give it a lineup in `models.json` | harness `~/ralph/models.json` | falls back to the project's/file's `default` block |
| 8 | Route it in `jav.json` (only if Jav is on) | harness `~/ralph/jav.json` | loop picks nothing; its gate waits forever |
| 9 | `bun install` in the worktree | loop worktree | gates (`test`, `typecheck`, `build`) fail inside the first iteration |
| 10 | Check secrets and refused files (a verifier: its read tokens and test account; a sentinel: `RALPH_SENTINEL_SENTRY_TOKEN`) | loop worktree, secrets manager, `~/.config/ralph/screenshots` | preflight refuses (`doppler-scope`, `repository-state`, `verifier-credentials`); a verifier with no test account never ends a watch `verified`; a sentinel with no usable token is not refused — its gate logs `no Sentry token` on every poll, forever |
| 11 | Run preflight and the frontier gate by hand | loop worktree | you learn about 6–10 from a failed overnight start |
| 12 | Start it and verify its identity | loop worktree | — |

## 1. Pick a name

One lowercase word, unique inside the project's `loops`. Names may repeat
across projects (each project keys its own `models.json`/`jav.json` block).
The name becomes the label prefix (`testo-wip`), the branch prefix
(`testo/1576-…`), the run id (`testo-run-…`) and the log prefix (`Testo:`).

## 2. Pick its role

A loop's role is `coder`, `triager`, `ci-doctor`, `pr-medic`, `clerk`,
`verifier` or `sentinel`, and it decides most of what the remaining steps do: which labels
you create, how many stages its lineup block names, whether it gets a Jav route
at all, and which preflight checks have to pass. Pick it before the roster PR, because changing it later is
another reviewed PR and another round of labels.

| Pick | When |
| --- | --- |
| `coder` | the loop is to build tickets and merge pull requests — the default, and what a bare name means |
| `triager` | the backlog gains issues faster than a person makes them ready: it labels difficulty, splits oversize tickets, annotates staffing groups and promotes to `ready-for-agent` |
| `ci-doctor` | red builds on the base branch outlive the coder who caused them, and somebody has to own flakes and regressions |
| `pr-medic` | a red run on the operator's own pull request sits until the operator notices; no coder owns a branch it did not open. Gate, push fence and prompt are live (felipearos/ralph#246–#248); a project onboards it with a roster entry and its `PR_MEDIC_*` prompt sections (felipearos/ralph#249) |
| `clerk` | reports arrive in a Slack channel and somebody files them in Jira by hand. It needs `RALPH_CLERK_SLACK_TOKEN` and `RALPH_CLERK_JIRA_TOKEN`; starts in `shadow`, and goes live by a reviewed `clerk.mode` edit plus `bun ~/ralph/clerk/cursor.ts --now` (README, "The clerk") |
| `verifier` | merged changes reach production and nobody checks that they worked there or broke nothing. It needs a `verifier` block in `.ralph/config.json`, `RALPH_VERIFIER_SENTRY_TOKEN` (and `RALPH_VERIFIER_VERCEL_TOKEN` for a Vercel deploy source) and a production test account; starts in `observe`, and moves to `report` and then `act` by reviewed `verifier.mode` edits ([A verifier's prerequisites](#a-verifiers-prerequisites); README, "The verifier") |
| `sentinel` | production errors sit in Sentry until somebody opens it, and nobody turns them into tickets. It needs a `sentinel` block in `.ralph/config.json` and `RALPH_SENTINEL_SENTRY_TOKEN`; starts in `observe`, and moves to `file` by a reviewed `sentinel.mode` edit ([A sentinel's prerequisites](#a-sentinels-prerequisites); README, "The sentinel") |

[Roles](README.md#roles) describes what each one does and never does. Two
consequences worth knowing before you commit to one:

- A **triager** writes no code and opens no pull request. It needs the triage
  vocabulary and the project's difficulty labels (step 6), a three-stage lineup
  (step 7), and no Jav route (step 8). It leaves its worktree clean and
  detached, so that worktree is never where work-in-progress lives.

  A triager also runs on a project whose tickets live in Linear or Jira
  (#396). There it does the Slack intake only: it turns open `slack-intake`
  reports into agent briefs or hands them to a person, and a `triage` block in
  the project's config decides whether a person's report moves to Jira. The
  clerk's own pipeline needs no triager: it files on a Jira intake board a
  person confirms (README, "Slack intake on a Jira board").

  A project's FIRST triager is rolled out in **shadow**: configure Jav with
  `enabled: false` but with the difficulty labels and the coders' routes
  already written, let the triager label for a day or two while routing stays
  off, and only turn Jav on once the untriaged count reaches zero and you agree
  with the labels it chose. Step 8 has the file.
- A **ci-doctor** works cases on its own: it reviews the classification its
  gate proposed, fixes a confirmed in-scope flake through the coder's phases,
  files anything out of scope, and unparks a coder ticket parked on a flake
  (`prompts/ci-doctor.md`). Its gate also re-runs one candidate flake's failed
  job, with no model turn and only while the host is idle, when the project has
  stored a `write_builds`-only `RALPH_BUILDKITE_RETRY_TOKEN`. On a confirmed
  regression on main with an unambiguous culprit it opens a revert pull request
  itself and files the forward fix behind it, which the project turns off with
  `ciDoctor.autoRevert: false`. It reads five `CI_DOCTOR_*` sections from the
  project's prompt fragment — without them it has no gate commands, no host
  fence, no job→command map and no known-flake list, so write those with the
  roster entry.
- A **clerk** works no repository at all. It lives in a project of its own
  that holds only `.ralph/` — empty `gates` and `requiredChecks`, a `clerk`
  block naming its Slack channel and Jira project, and its `CLERK`,
  `CLERK_APPS` and `CLERK_PRIORITY` sections — and starts in `mode: "shadow"`,
  which writes nothing to Slack or Jira. Its lineup names the orchestrator
  alone (step 7), it takes no Jav route (step 8), and it leaves its worktree
  clean and detached. `fixtures/clerk/.ralph/` is a complete example.
- A **verifier** writes no code either. It follows each merged pull request
  into production and judges it against the ticket it closed; its gate
  (`verifier/gate.ts`) finds the merges, waits for the deploy, reads Sentry and
  traffic and makes every tracker write. It needs more setting up than any
  other role — a config block, two read tokens, a test account and five labels —
  so it has its own list below. Its lineup names the orchestrator alone (step
  7), it takes no Jav route (step 8), and it leaves its worktree clean and
  detached.
- A **sentinel** writes no code either, and its session makes no tracker
  write: it diagnoses one production error the gate stored and drafts a ticket
  for it. The gate (`sentinel/gate.ts`) reads the reporter, decides what
  qualifies, files the `ready-for-human` ticket, dedupes and comments on
  recurrences. Run one per project (nothing enforces it). Its lineup names the
  orchestrator alone (step 7), it takes no Jav route (step 8), and it leaves
  its worktree clean and detached; its own list is below.

A loop that is not a coder is written as an object in the roster — that is the
next step. Nothing outside the roster records the role: `RALPH_LOOP_ROLE` is
exported from it, never read as the source of truth, so a loop's role changes
only by changing `.ralph/config.json`.

### A verifier's prerequisites

Each of these has to be in place before a verifier's first start; the steps
below point back here. README, "The verifier" says what it does with them.

**The `verifier` block** (step 3, in the same PR as the roster entry). The
block is required once the roster names a verifier and refused when it names
none; unknown keys are refused:

```jsonc
// .ralph/config.json
"verifier": {
  "productionUrl": "https://app.example.com",
  "deploy": { "source": "vercel", "project": "app" },
  "sentry": { "org": "acme", "project": "app" }
}
```

- Required: `productionUrl` (absolute http(s), no user or password in it),
  `deploy.source` (`vercel` or `github-deployments`), `sentry.org` and
  `sentry.project` (lowercase slugs). A `vercel` source also needs
  `deploy.project` (id or name; `deploy.team` is optional); a
  `github-deployments` source takes an optional `deploy.environment`, default
  `production`.
- Optional, with their defaults: `enabled` `true` (`false` switches the
  verifier off while its gate keeps polling); `windowHours` 24; `checkIns` `[1, 6, 24]`
  (hours after the deploy, ascending, none past `windowHours` — so a
  `windowHours` under 24 needs its own `checkIns`); `trafficFloor` `true`;
  `revert.rateFactor` 5, `revert.minEvents` 10, `revert.minUsers` 2;
  `follow.loopPrs` and `follow.humanPrs` `true` (not both `false`); `mode`
  `"observe"` (then `"report"`, `"act"`); `language` `"en"` or `"es"`, default
  `screenshots.locale`, else `"en"`; `mergeCommand`, gh arguments with a
  `{pr}` in one of them, e.g. `["pr", "merge", "{pr}", "--squash"]` — without
  it act mode only proposes its reverts.
- The dashboard's verifier form (or `bun ~/ralph/project-config.ts
  --set-verifier`, rules JSON on stdin) edits only `enabled`, `windowHours`,
  `checkIns`, `trafficFloor`, `revert`, `follow` and `mode`.
  `productionUrl`, `deploy`, `sentry`, `language` and `mergeCommand` are hand
  edits.
- Skipped → preflight denies `project-config` with the validator's message
  (a verifier on the roster requires the block), and `verifier-credentials`
  denies ("the project has no `verifier` block").

**The roster entry** (step 3): `{ "name": "veri", "role": "verifier" }`,
written by hand in the same edit as the block. `bun ~/ralph/project-config.ts
--add-loop veri --role verifier` cannot add a project's first verifier: the
config is validated as a whole, a verifier with no block is refused, and so is
a block with no verifier. It works for a second one.

**The labels** (step 6): `veri-wip`, `veri-blocked`, `veri-done`, plus
`following`, `verified`, `unexercised`, `inconclusive` and `needs-human`.
Preflight creates the five verdict labels itself on a GitHub tracker, but not
the triple: without it `loop-labels` denies. Fix tickets also carry
`ready-for-agent` and `priority:urgent`, which nothing creates: a project
with no coder or ci-doctor must add them, or its first fix ticket fails. On Linear or Jira preflight
handles all of them through the tracker, as for every role (step 6).

**The read tokens** (step 10). `RALPH_VERIFIER_SENTRY_TOKEN` always — a Sentry
token with `project:read` on the org — and `RALPH_VERIFIER_VERCEL_TOKEN` only
for a `vercel` deploy source, a token that can read the Vercel project. Store
them in the project's secrets manager scope (Loggd: Doppler `loggd-web/dev`),
or in the supervisor's environment when the project has none. Only the gate is
handed them, never the model session. Check one with the token exported:

```bash
bun ~/ralph/verifier/credentials.ts --check-token sentry   # or vercel
```

A `github-deployments` source holds no token: it reads through gh's own, which
needs deployments read on the repository (classic: `repo` or
`repo_deployment`; fine-grained: Deployments read), and preflight probes it.
Skipped → `verifier-credentials` denies startup: no token, a token its check
refused (withheld), or gh unable to read the deployments.

**The test account** (step 10). The session checks production as one
dedicated account, read from the ui-shots credential store
`${XDG_CONFIG_HOME:-~/.config}/ralph/screenshots/<projectId>.env`:
`SHOTS_EMAIL`, `SHOTS_PASSWORD`, `VERIFIER_SUPABASE_URL` and
`VERIFIER_SUPABASE_ANON_KEY` (the PRODUCTION auth backend; the file's
`VITE_SUPABASE_*` keys are not used), and optionally
`VERIFIER_READONLY_DATABASE_URL`. Under `screenshots.login: "none"` no sign-in
is needed. **Preflight does not check this file.** Skipped → every acceptance
check is inconclusive, so no watch ever ends `verified`; without the read-only
URL, criteria that need SQL are marked not verifiable live.

**The lineup** (step 7): the orchestrator alone. `"loggd": { "@verifier": { … } }`
gives every verifier of the project one; resolution is the loop's own block →
`@verifier` → the project's `default` → the file's `default`.

**Project guidance** (optional): a `<!-- ralph:section VERIFIER -->` section
in the project's `.ralph/prompt.md`, rendered into the verifier's prompt —
what production looks like, which routes matter, what to leave alone.

### A sentinel's prerequisites

Each of these has to be in place before a sentinel's first start; the steps
below point back here. README, ["The sentinel"](README.md#the-sentinel) says
what it does with them.

**The `sentinel` block** (step 3, in the same PR as the roster entry). The
block is required once the roster names a sentinel and refused when it names
none; unknown keys are refused, in the block and in `reporter`:

```jsonc
// .ralph/config.json
"sentinel": {
  "reporter": { "kind": "sentry", "org": "acme", "project": "app", "environment": "production" }
}
```

- Required: `reporter.kind` (`"sentry"`, the only kind), `reporter.org` and
  `reporter.project` (Sentry slugs: lowercase letters, digits, `-` or `_`).
  `reporter.environment` is optional, a non-empty string; without it every
  environment's errors count.
- Optional, with their defaults: `enabled` `true` (`false` switches the
  sentinel off while its gate keeps polling); `lookbackHours` 24 (positive); `minEvents` 10
  and `minUsers` 2 (whole numbers, at least 1 — an issue qualifies at either);
  `maxPerDay` 5 (whole, at least 1); `mode` `"observe"` (then `"file"`);
  `language` `"en"` or `"es"`, default `screenshots.locale`, else `"en"`.
- The dashboard's Sentinel sheet (or `bun ~/ralph/project-config.ts
  --set-sentinel`, rules JSON on stdin) edits only `enabled`,
  `lookbackHours`, `minEvents`, `minUsers`, `maxPerDay` and `mode`;
  `reporter` and `language` are hand edits.
- Skipped → preflight denies `project-config` with the validator's message
  (a sentinel on the roster requires the block).

**The roster entry** (step 3): `{ "name": "senti", "role": "sentinel" }`,
written by hand in the same edit as the block. `bun ~/ralph/project-config.ts
--add-loop senti --role sentinel` cannot add a project's first sentinel: the
config is validated as a whole, a sentinel with no block is refused, and so is
a block with no sentinel.

**The labels** (step 6): `senti-wip`, `senti-blocked`, `senti-done`, plus
`ready-for-human`, which every ticket it files carries. Preflight creates
`ready-for-human` itself on a GitHub tracker (it is in `roles.ts`
`CREATED_LABELS`), but not the triple: without it `loop-labels` denies. The
gate also ensures `ready-for-human` through the tracker before it files
(`sentinel/file.ts`). On Linear or Jira preflight handles all of them through
the tracker, as for every role (step 6).

**The read token** (step 10). `RALPH_SENTINEL_SENTRY_TOKEN`, a read-only
Sentry token with `event:read`, `project:read` and `org:read`; a token with any
scope not ending `:read` is refused, and so is one whose scopes Sentry does not
report. Store it in the project's secrets manager scope (Loggd: Doppler
`loggd-web/dev`), or in the supervisor's environment when the project has none.
Only the gate is handed it, never the model session. Check it with the token
exported:

```bash
bun ~/ralph/sentinel/credentials.ts --check-token sentry
```

Skipped or refused → **preflight does not deny the start.** A token its check
refused is withheld by `ralph.sh`, and with no token the gate logs
`sentinel-gate: no Sentry token — RALPH_SENTINEL_SENTRY_TOKEN is not set at
<time> — waiting 300s …` on every poll, all night (`--once` prints it as
`nothing to do — no Sentry token — …`), so read `loop.stdout` after the start.
A token the secrets manager could not hand over at startup (a keyring still
locked at boot) is not final, unlike one that is absent or that its check
refused. The supervisor reads it again before each gate poll and each
iteration, at most once per poll interval and without lengthening it; the gate
hands back for that read after a tokenless poll. The token reaches the gate
from the next poll once the read and its check pass. A token the check refused
stays withheld and is not read again.

**The lineup** (step 7): the orchestrator alone. `"loggd": { "@sentinel": { … } }`
gives every sentinel of the project one, as `@verifier` does for verifiers;
resolution is the loop's own block → `@sentinel` → the project's `default` →
the file's `default`.

**Project guidance** (optional): a `<!-- ralph:section SENTINEL -->` section
in the project's `.ralph/prompt.md`, rendered into the sentinel's prompt.

**The rollout.** Start in `observe`, which files nothing, for about a week.
Read what it would have filed — the store,
`<git-common-dir>/ralph/sentinel-issues.json`, and the sentinel's journal
entries — tune `minEvents` and `minUsers` until the would-be tickets are ones
you want, and then a reviewed PR sets `"mode": "file"`. An issue drafted
during the observe week is never filed after the switch, nor handed to a
session again; file any of them that matter by hand.

### Rolling out a sentinel on loggd

Loggd's block, in its `.ralph/config.json`, in the same PR as the roster entry
`{ "name": "senti", "role": "sentinel" }`. The Sentry slugs are the ones
loggd's `next.config.js` uploads source maps to (`org: "faros-o9"`,
`project: "loggd"`); check them there before the PR, since a display name in
place of a slug makes every read fail.

```jsonc
"sentinel": {
  "reporter": {
    "kind": "sentry",
    "org": "faros-o9",
    "project": "loggd",
    "environment": "production"
  },
  "lookbackHours": 24,
  "minEvents": 10,
  "minUsers": 2,
  "maxPerDay": 5,
  "mode": "observe"
}
```

Store `RALPH_SENTINEL_SENTRY_TOKEN` in Doppler `loggd-web/dev` and check it as
above. Leave it in `observe` for a week, read the store and the journal, and
only then open the PR that sets `"mode": "file"`.

## 3. Add it to the roster, by pull request

The roster is `loops` in the project's committed `.ralph/config.json`. It only
changes by a reviewed PR, never in place. A loop outside the roster writes
claims nobody else reads.

**From the dashboard (preferred).** `bun ~/ralph/dashboard/server.ts`, open
<http://127.0.0.1:8791>, and add the agent on the project's page. It creates
the worktree from `origin/main`, writes `.ralph/loop-name`, and opens the roster
PR, so it covers steps 3 and 4 in one go. Until the PR merges the agent shows
as `pending-merge` and Start is refused.

**By hand.** On a branch in the main checkout:

```jsonc
// .ralph/config.json
"loops": ["ralph", "rafa", "remo", "rulo", "testo"]
```

A loop whose role is not `coder` is an object instead of a name, and the two
forms mix freely in one roster:

```jsonc
"loops": ["ralph", "rafa", "remo", "rulo", { "name": "tria", "role": "triager" }]
```

Open the PR, let CI pass, and queue it (`@mergifyio queue`). Confirm it landed:

```bash
git -C /home/faros/loggd fetch origin
git -C /home/faros/loggd show origin/main:.ralph/config.json | grep -A8 '"loops"'
```

## 4. Create the worktree

Skip this if the dashboard already made it.

**From the dashboard**, for a name that is on the roster but has no worktree —
every loop a setup PR put there, and any loop whose worktree was deleted: open
its loop page and press **Create checkout**. Add agent refuses such a name,
because it is already in `loops`; this is the path for it. It makes the same
worktree Add agent makes and opens no PR.

**By hand.** Never check `main` out in a loop worktree; git then refuses
fetches in every worktree.

```bash
cd /home/faros/loggd
git fetch origin
git worktree add --detach /home/faros/.local/share/ralph/workspaces/loggd/testo-loop origin/main
echo testo > /home/faros/.local/share/ralph/workspaces/loggd/testo-loop/.ralph/loop-name
mkdir -p /home/faros/.local/share/ralph/workspaces/loggd/testo-loop/.ralph/logs
```

The log directory is the one `preflight` denies a start without
(`logs-writable`), and a project that does not track a file inside `.ralph/logs`
gets no such directory from git. Both dashboard paths create it.

`.ralph/loop-name` is git-ignored and per-worktree. `RALPH_LOOP_NAME` overrides
it for a single command.

## 5. Refresh the worktree after the roster PR merges

A worktree made before the PR merged (or days before its first start) is
stale, and the supervisor refuses a worktree that is behind its base branch.
It also runs with that old `.ralph/config.json`. `testo`'s worktree was missing
the `Vercel` required check that `main` had gained in the meantime. On a
clean worktree with no claim in flight:

```bash
cd /home/faros/.local/share/ralph/workspaces/loggd/testo-loop
git status --short                 # must be empty
git fetch origin && git checkout --detach origin/main
```

## 6. Create the labels

Each loop needs `<name>-wip` (active claim), `<name>-blocked` (needs a human)
and `<name>-done` (completed), and a loop whose role is not `coder` needs more:
a triager's verdict vocabulary, a ci-doctor's `ci-health` and
`priority:urgent`, a verifier's `following`, `verified`, `unexercised`,
`inconclusive` and `needs-human` (which preflight creates on GitHub; see
[A verifier's prerequisites](#a-verifiers-prerequisites)), and a sentinel's
`ready-for-human` (which preflight also creates on GitHub; see
[A sentinel's prerequisites](#a-sentinels-prerequisites)). Ask rather than remember — this answers without a single
probe, because these are what you create BEFORE a preflight can pass:

```bash
RALPH_LOOP_NAME=testo bun ~/ralph/preflight.ts --labels
```

An agent whose roster PR has not merged yet is not on the roster, so
`RALPH_LOOP_NAME` cannot name it. Ask for it by name and role instead — this is
the form Add agent itself uses:

```bash
bun ~/ralph/preflight.ts --labels --loop testo --role triager
```

The dashboard's **Add agent** creates them for you, from this same answer, so
the steps below are for an agent added by hand — or for one whose labels Add
agent reported it could not create. The roster PR never creates them. Preflight
refuses to start without them:

```
preflight: loop-labels — the repository has no testo-wip, testo-blocked, testo-done label, so this loop could claim nothing
preflight: refusing to start — a local requirement is not met
```

Create only the missing ones, and never overwrite another loop's:

```bash
gh label create testo-wip     -R felipearos/loggd --color 1D76DB --description "Claimed by the Testo loop this iteration"
gh label create testo-blocked -R felipearos/loggd --color E11D21 --description "Testo got stuck; needs human triage"
gh label create testo-done    -R felipearos/loggd --color 0E8A16 --description "Closed by the Testo loop (issue) / merged by Testo (PR)"
```

A role's extra labels carry no fixed colour, so create whichever of them the
repository is missing — and only those:

```bash
gh label list -R felipearos/loggd --limit 200 --json name -q '.[].name' > /tmp/have
RALPH_LOOP_NAME=testo bun ~/ralph/preflight.ts --labels |
  while read -r label; do
    grep -qix "$label" /tmp/have || gh label create "$label" -R felipearos/loggd
  done
```

`--limit 200` is the limit the preflight itself reads with: `gh label list`
defaults to 30, and a repository with several loops on it has more than that, so
the default would report labels as missing that are only unlisted.

A triager's vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`, `spec`, `duplicate`) and the project's difficulty
labels are shared by every triager, so on a repository that already has one
there is usually nothing left to create but the triple.

On a project whose tickets live in Linear or Jira (README, "Linear and Jira
projects"), the labels are the tracker's, not the repository's: preflight
creates a missing Linear label itself through the tracker, and Jira's labels
are free-form and need no creating. There is nothing to run by hand beyond
connecting the tracker from the dashboard; `gh label create` would make labels
no loop reads.

## 7. Give it a lineup (`models.json`)

The harness's `~/ralph/models.json` says which model runs each stage on which
runner. WHICH stages a loop has is its role's (`roles.ts` `stages`): a coder and
a ci-doctor run all six — `orchestrator`, `executor`, `mapper`,
`review.standards`, `review.spec`, `review.correctness` (which a block may
leave out: it then runs `claude-opus-5-5` at `high`) — a triager runs `orchestrator`, `mapper`
and `review.spec`, and a clerk, a verifier or a sentinel the `orchestrator` alone. A block names exactly its role's stages and is refused for
naming any other. A loop block lives under the project id:

```jsonc
{
  "default": { … },
  "loggd": {
    "testo": {
      "orchestrator": { "runner": "claude", "model": "claude-opus-5", "effort": "medium" },
      "executor":     { "runner": "claude", "model": "claude-opus-5-5" },
      "mapper":       { "runner": "claude", "model": "claude-opus-5-5", "effort": "medium" },
      "review": {
        "standards": { "runner": "claude", "model": "claude-opus-5-5", "effort": "medium" },
        "spec":      { "runner": "claude", "model": "claude-opus-5-5", "effort": "medium" }
      }
    }
  }
}
```

Without a block the loop resolves env → its own block → the project's
`@<role>` block → the project's `default` → the file's `default`, so it still
runs, just not on the models you chose. `@<role>` is the useful one for a second
loop of a role: `"loggd": { "@triager": { … } }` gives every triager that
project runs the same lineup with no per-loop block at all, and it is complete
over THAT role's stages — three for a triager, five for `"@ci-doctor"`. Edit a
LOOP block from the dashboard's lineup form (validated, atomic write) or by
hand; a `@role` block is edited in the file (the form leaves it alone, since it
is not a loop). Then check the resolution, naming the role the roster gives the
loop:

```bash
RALPH_LOOP_NAME=testo RALPH_PROJECT_ID=loggd bun ~/ralph/models.ts --json --role coder
```

A change takes effect at the next `start.sh`, never mid-turn. If the runner is
`codex` or `opencode`, that CLI must be installed and logged in on this
machine; preflight checks for it.

## 8. Route it in `jav.json` (only if Jav is on)

If `~/ralph/jav.json` has an enabled block for the project, a loop takes only
tickets with a label listed in `routes.<name>`, falling back to
`routes.default`. A coder with no route and no `default` route picks nothing,
and its gate waits forever without an error.

**This step is for coders only.** A triager or a ci-doctor takes no frontier
work, so it holds no route: `jav.ts` refuses one, the dashboard's **Routing**
page offers no row for it, and a label only those loops would have fallen back
to counts as stranded. Add a route from the dashboard's
**Routing** page, or by hand:

```json
"routes": { "ralph": ["difficulty:hard"], "testo": ["difficulty:easy"], "default": ["difficulty:easy"] }
```

With no `jav.json` (Loggd today), routing is off and every loop sees every
ready ticket.

**Adding the project's first triager: start Jav in shadow.** Turning routing on
the same day a triager starts labelling means every mislabelled ticket is also
a misrouted one, and a label nobody has read yet decides which loop builds it.
So write the block with the labels and the coders' routes, and leave it off:

```json
{
  "loggd": {
    "enabled": false,
    "labels": ["difficulty:easy", "difficulty:hard"],
    "routes": { "ralph": ["difficulty:hard"], "rafa": ["difficulty:hard"],
                "default": ["difficulty:easy", "difficulty:hard"] }
  }
}
```

The labels have to exist before the triager's preflight passes (step 6), and
`routes` never names the triager. With `enabled: false` every coder still sees
every ready ticket, so nothing is stranded while the triager works through the
backlog. Read what it labelled on the dashboard, and set `enabled: true` only
once the ready queue's untriaged count has reached 0 and the labels look right
to you. Loops re-read the file on every pick, so the flip needs no restart.

## 9. Install dependencies

A fresh worktree has no `node_modules`. The project's gates (`bun run test`,
`typecheck`, `build`) run inside the iteration and fail there if you skip this.

A project whose `.ralph/config.json` lists `worktreeSetup` steps does this for
you: Add agent and Create checkout run the steps in the new worktree, and a
step marked `installsDependencies` is what this checklist item reads. When a
step failed, fix the cause and use **Rerun setup** on the agent's page. Without
such a step, install by hand:

```bash
cd /home/faros/.local/share/ralph/workspaces/loggd/testo-loop
bun install
```

## 10. Secrets and refused files

- The secrets CLI must be logged in with access to `secrets.project`/`secrets.config`
  (Loggd: `loggd-web/dev`). The supervisor pins that scope itself, so no per-directory
  `doppler setup` is needed. Check with `doppler secrets --only-names >/dev/null`.
- No file listed in `refuseFiles` may exist (Loggd: `.env.local`).
- A verifier also needs its read tokens and its test account
  ([A verifier's prerequisites](#a-verifiers-prerequisites)); preflight denies
  `verifier-credentials` without the tokens, and checks the test account not at
  all.
- A sentinel also needs `RALPH_SENTINEL_SENTRY_TOKEN`
  ([A sentinel's prerequisites](#a-sentinels-prerequisites)); preflight does
  not check it, so a missing or refused token shows only as the gate's
  `no Sentry token` line on every poll.

## 11. Preflight and frontier gate, by hand

```bash
cd /home/faros/.local/share/ralph/workspaces/loggd/testo-loop
RALPH_LOOP_NAME=testo bun ~/ralph/preflight.ts
RALPH_LOOP_NAME=testo bun ~/ralph/frontier-gate.ts --once
```

For a loop whose role is not `coder`, run the gate its role declares rather than
this one — `bun ~/ralph/project-config.ts --intake-gate-of testo` prints which,
and the supervisor runs exactly that. A sentinel's `--once` is not a dry run:
a work answer spends one of the issue's two session attempts (README, "The
sentinel"), so run it at most once by hand.

You want `preflight: ready — N checks passed`. Warnings (e.g. `buildkite-logs`)
don't stop the start. The gate prints either `work available — frontier
ticket #…` or that there is nothing ready. Nothing ready is fine for a gated
start (it waits), but check `bun ~/ralph/frontier/next.ts --dry-run`. A new loop
only helps when there is an independent ready tree for it. With one tree, the
extra loop parks, which is correct behaviour.

## 12. Start and verify

```bash
cd /home/faros/.local/share/ralph/workspaces/loggd/testo-loop
~/ralph/start.sh            # gated: the role's interval, up to 50 iterations
tail -f .ralph/logs/loop.stdout
```

`start.sh` takes the poll interval from the loop's **role** when you name none:
300 s for a coder, a ci-doctor, a pr-medic, a clerk, a verifier or a sentinel, 600 s for a
triager, whose bucket answers
"what has nobody looked at" and cannot change as fast as a coder's frontier
(`roles.ts`'s `pollSeconds`; `bun ~/ralph/project-config.ts --poll-seconds-of
testo` prints the one this worktree gets). `RALPH_WAIT_FOR_WORK=<seconds>` on
the start line still wins.

Check the first lines:

```
Testo run testo-run-20260929T…  — usage ledger: .ralph/logs/usage-ledger.tsv
Testo: models — orchestrator claude-opus-5 on claude, executor claude-opus-5-5 on claude, …
Testo: frontier-gated — waits 300s between checks instead of exiting.
preflight: ready — …
```

If the prefix says another loop's name (`Ralph run …`), stop it at once
(`pkill -f` the supervisor pid in `.ralph/logs/supervisor.pid`). Both loops are
about to claim under one label. For Orca board mirroring, start from an Orca
terminal in the worktree with `"plugins": ["orca"]` (or `RALPH_PLUGINS=orca`),
then verify with `bun ~/ralph/plugins.ts status`.

The dashboard picks the new loop up from the git worktree registry; no
dashboard config change is needed.

## Troubleshooting

| Symptom (log / preflight line) | Cause | Fix |
|---|---|---|
| `loop-labels — the repository has no <name>-wip…` | step 6 skipped | create the labels |
| `loop-identity` denied | no `.ralph/loop-name` and no `RALPH_LOOP_NAME` | step 4 |
| `ralph.sh` refuses the name / dashboard shows `pending-merge` | roster PR not merged, or worktree not refreshed since | steps 3 and 5 |
| `harness at ~/ralph is behind its origin/main` (warning) | harness checkout stale | `git -C ~/ralph pull --ff-only` when no loop is mid-iteration |
| `repository-state` denied | worktree behind base, dirty, or `.env.local` present | step 5 / step 10 |
| `doppler-scope` denied | secrets CLI not logged in to the scope | step 10 |
| gate always "no work" while other loops are busy | Jav on with no route, or one ready tree only | step 8 / `frontier/next.ts --dry-run` |
| gates fail on missing modules in the first iteration | no `node_modules` | step 9 |
| models line shows `default` models | no loop block in `models.json` | step 7 |

## Removing an agent

Stop its supervisor, let any in-flight PR finish or release its claim from the
dashboard, delete the worktree from the dashboard (it refuses while a
supervisor is alive or the worktree is dirty), and drop the name from `loops`
by PR. Leave the labels: closed issues still carry `<name>-done`.
