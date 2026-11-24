Felipe has given a standing grant for this loop to merge its own
PRs when the gates below pass.

<!-- ralph:section REVIEW_ROUTING -->
Never `/code-review`: it names no model of its
  own, so invoking it would run the review on whatever model you are. §5.1
  carries the marker step.

<!-- ralph:section ORIENT -->
   `journal/loggd/progress.md` in the harness repository is the closed archive
   of the same journal — worth reading for older history, never appended to.

4. Read `CONTEXT.md` (the domain glossary — terms and the `_Avoid_` synonyms
   they replace) and any `docs/adr/` entry touching the area you are about to
   work in. These are binding vocabulary, not background: see §3.

<!-- ralph:section IMPLEMENT_ROUTING -->
Follow AGENTS.md skill routing (server-patterns,
design-audit, loggd-nextjs-rendering, mobile, storybook, etc.).

<!-- ralph:section BRIEF_TRAPS -->
Here: the adult-title gate, `~/` vs `@/`, solid colour
   tokens, session checks before mutations.

<!-- ralph:section BRIEF_VOCABULARY -->
   **Name domain concepts the way `CONTEXT.md` names them**, and quote the
   definition inline when the brief leans on one. The brief is where naming
   drift turns into code: an executor told "poster ID" writes a bare TMDB id
   where the glossary requires a media-type-specific Media Reference, and you
   pay for it in diff review. If the ticket needs a concept the glossary
   doesn't have, use one name consistently, say so in the brief, and record it
   in §6 — do not invent a synonym for a term that already exists. The
   glossary's `_Avoid_` lines are what §3.3 checks the diff's vocabulary against.

<!-- ralph:section RAILS -->
- **HARD RAIL — migrations:** you may edit `src/server/db/schema.ts` and
  generate the migration file, but NEVER apply a migration (no db:migrate,
  no SQL against the database). The injected database is non-production, but
  branch identity is not a mechanical capability fence and production apply
  is never the loop's: either the merge queue's apply step or a person
  applies it, and which one is the classifier's call, not yours.

  **Expand, then contract.** Prefer the shape the classifier can call safe:
  a nullable column (or one with a constant default) with no foreign key
  onto an existing table, or a new enum value no statement in the same batch
  uses. Do any backfill, `NOT NULL`, new constraint, type change, rename or
  drop in a separate later change. When the ticket needs a backfill, split it
  out so the schema part stands alone: ship the schema part here, say in the
  PR body what was split out and why, and file the rest as a follow-up ticket
  (`bun "$RALPH_HOME/tracker.ts" create … --label needs-triage`) linked from
  the PR, so the ticket's remaining criterion is not lost when this PR closes
  it.
  **Never leave a statement out, or weaken one, to change the verdict.** A
  new table's `lock_*` migration (the `REVOKE` on its table and id sequence,
  `docs/development-workflow.md`), a foreign key onto an existing table, a
  policy or a grant is unsafe and goes to a person as it is; a migration
  stripped of its lock to read safe ships a table the client roles can reach.

  Write the migration's SQL first (for `bun run db:generate --custom`, fill
  the file it creates), then classify every migration the branch adds, in
  order:

  ```bash
  bun run db:classify-migrations drizzle/00NN_name.sql [drizzle/00NN_next.sql …]
  ```

  It needs no credentials. Its `OVERALL` line is the verdict; paste the
  verdict-pin row it reports for each file into
  `scripts/migration-verdict-pins.ts` (a row printed for an empty `--custom`
  file is wrong once the SQL is written). Run
  `scripts/migration-classifier.test.ts`,
  `scripts/declared-security-state.test.ts` and
  `scripts/migration-rls-walk.test.ts` with your targeted tests, and add the
  matching `supabase/migrations/` file the development workflow requires.
  Then:

  - **safe** → an ordinary PR, not a draft: no `needs-migration` comment, no
    block, the claim stays yours. CI's `production-migrations` gives it the
    *pending safe apply* verdict and the merge queue applies the migration
    (`docs/development-workflow.md`). Put the classifier's `OVERALL` verdict
    and what the migration adds in the PR body. If `production-migrations`
    is red on it, read its `Pending safe apply withheld:` line and act on the
    reason: out of sequence, or a journal entry older than production's
    ledger, means a sibling's migration landed first — rebase on
    `origin/main`, delete and regenerate the migration (new number, journal
    entry and pin row), re-classify, and push; main's copy could not be read
    is a CI read failure, re-run once. Auto-apply switched off, an unsafe
    verdict from main's classifier, or a reason you cannot clear yourself
    takes the unsafe path below, first turning the PR back into a draft
    (`gh pr ready --undo <pr>`). So does a queue build whose `migration-apply`
    step refuses: never requeue it.
  - **unsafe** → finish the code, open the PR as DRAFT, comment
    `needs-migration`, clear the claim and mark the issue blocked exactly as
    the stuck path in §6 does — removing the `-wip` the issue carries, which
    is not always your own — journal it, and stop (this counts as completing
    a task). Quote the classifier's per-statement output in the comment,
    under the plain-words explanation below.

  The `needs-migration` comment is read by a person who has not seen the
  branch, so it must **explain the migration in plain words before showing
  it**: what the ticket needed from the database and why, what the migration
  adds, changes or drops (tables, columns, enum values, constraints, indexes)
  and what each of those is for, what the app does differently once it is
  applied, and whether it is additive and backwards-compatible with what
  `main` writes today. Someone should understand the change from that
  paragraph alone. Then give the exact SQL and the apply instructions; the
  SQL illustrates the explanation, it does not replace it.

<!-- ralph:section VERIFY -->
Your local gate is five commands, in this order:

1. targeted vitest for the areas you touched — `bun run test <paths>`
2. `bun run typecheck`
3. `bun lint`
4. `bun run lint:shadcn`
5. `bun run build`

That is the whole local gate. `lint:shadcn` is the design-system lint
(`@shadcn/lint`): it reports only the findings the branch introduces in web
`.tsx` files, so every finding is yours — fix it through the coder, or suppress a
deliberate exception directly above the reported line with
`// shadcn-lint-ignore-next-line shadcn/<rule> -- <reason>` (not
`eslint-disable`, which `bun lint` rejects for this plugin).
It is not in CI; the `.husky/pre-push` hook runs it again on every push, so
never push with `--no-verify` to get past it.

New UI components still need a Storybook story (fold skeletons into existing
stories, never add a new exported story object).

**You already have a real environment — run the gate bare.** `ralph.sh` starts
you under Doppler, so `bun run build` validates against the configuration this
app actually deploys with. Two rules follow, and both are absolute:

- **Never create an env file — no `.env.local`, no `.env`, no throwaway with
  dummy values, at any point, for any gate.** Iterations used to write one to
  get past `src/env.js` validation, which made the last gate before a PR a gate
  against invented config. If a gate fails on environment, that is a finding to
  report, not a file to fabricate.
- **Never prefix a command with `doppler run --`, and never run `doppler` at
  all.** Your environment is already injected, so it would add nothing except
  the credentials deliberately withheld from you — `PRODUCTION_MIGRATIONS_DATABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `SELF_HOSTED_RUNNER_GH_PAT`, `BUILDKITE_AGENT_TOKEN`,
  `BUILDKITE_API_TOKEN`, `BUILDKITE_OPERATOR_TOKEN`, `RENOVATE_TOKEN` (the list
  in `.ralph/config.json`).
  `DATABASE_URL` and `SUPABASE_DB_URL` do reach you, fenced to the local
  Supabase stack by `scripts/check-loop-env.ts`. Doppler is
  still authed here and this directory is still scoped, so nothing stops you
  mechanically. This rule is the whole fence; treat it as one.

`DATABASE_URL` in your environment points at the local Supabase stack
(`127.0.0.1:54322`), which may not be running. That is deliberate and is not a
bug to fix: the build only parses it. Nothing in your gate connects to a
database, and if a ticket seems to need one, it needs a human — say so and hand
off rather than reaching for `doppler`.

**Never run Playwright, at any point in the iteration.** CI owns e2e, and
proves it twice: Buildkite — the automatic control plane here, the GitHub
Actions workflow being `workflow_dispatch`-only — runs the hermetic Playwright
suite on the pull request, and again in the merge queue before the merge.
The Buildkite agents share a nested Docker daemon and its Supabase ports;
local development has a separate namespace, but still shares the host's RAM.
Network isolation does not make simultaneous heavy suites safe (#809).

**Do not run local lint, typecheck, full unit/mobile suites, or builds while
Buildkite quality or E2E is running on this host.** Before starting each heavy
command, inspect `docker top buildkite-agent -eo pid,comm` and the latest
`docker logs --since 30m buildkite-agent` job start/finish entries. These reads
need no Buildkite API token. If work is active or you cannot establish idleness,
defer the local command and let CI provide that validation; record the gap.
After pushing, wait on CI instead of duplicating its heavy checks locally.
This is an operational fence, not an atomic scheduler lock: CI can start after
an idle check. If that happens, stop your own local command and defer it.

Keep any Next/Storybook server you start attached to an owned terminal/process
group, record it, and shut it down when its verification ends, including failure
and cancellation paths. Never leave a detached server between iterations.
Before stopping a stale server, verify its owner and worktree; never use a broad
`pkill` or stop another iteration's process.

So if the ticket changes a user-facing flow, write or update the relevant
Playwright spec as part of the diff, and let CI be the one to run it in §5.
A red e2e check there is a real finding to fix, not a reason to reproduce it
locally.

<!-- ralph:section REVIEW_GATE -->
Do not let `/code-review` choose: its
   skill names no model, so its agents inherit yours and this run's review
   configuration goes unused. Read `.claude/skills/code-review/SKILL.md` for
   what each axis is briefed with; brief the stage with the same thing,
   whichever shape it takes. The spec axis gets `.ralph/logs/spec-<n>.md` by
   path and reads it without `gh` (`docs/agents/issue-tracker.md`, "fetch the
   relevant ticket").

   Fix what they find, then **record the marker yourself**, as
   `docs/agents/implementation.md` ("Record the review") says. Nothing records
   it for you, so without it `gh pr create` is denied:

   ```bash
   dir="$(git rev-parse --show-toplevel)/.claude/reviewed"
   mkdir -p "$dir" && touch "$dir/$(git rev-parse HEAD)"
   ```

   Run those two lines as a Bash call of their own, then push, then run
   `gh pr create` alone: the hook judges the whole command before any of it
   runs, so a marker chained into the `gh pr create` line is not there yet.

   The marker is keyed to the commit, so re-record it after any further push —
   and only once the review has actually read what is going out.

<!-- ralph:section CI_RED -->
Then read `bk-log.ts`'s `known:` line under each failing test first: it is
   the ci-doctor's own verdict on that test, and a confirmed flake there never
   counts as a strike (harness §5.4).

<!-- ralph:section CODEX -->
5. **Codex reviews every push on its own; answer it, never wait for it.**
   The Codex connector reviews each PR head without being asked, usually
   within the hour, and leaves its findings as inline review threads with a
   P1–P3 badge. Do not comment `@codex review` and do not wait or poll for
   a review that has not arrived: §5 step 6's review-thread check judges
   whatever is there when you check it. Between 2026-10-05 and 10-09 these
   loops merged with 52 of 74 Codex threads unanswered, 11 of them P1,
   because this section still said Codex's quota was out. It is not.

   Every Codex thread the check lists gets the treatment step 6 describes:
   fix real P1/P2s with a test (P3s by judgment), and reply on every thread,
   `Fixed in <sha>.` or why the finding does not hold. There is no mandatory
   confirming review after a fix; the next green CI and an empty
   review-thread check are the gate.

<!-- ralph:section MERGE_PROTECTION -->
GitHub's `Protect main` ruleset
   enforces Buildkite, and `main` merges only through the Mergify
   merge queue, which builds main-plus-PR before anything lands; independently
   verify the exact head because the loop still owns the correctness of what
   it enqueues:

<!-- ralph:section ENQUEUE -->
```bash
     gh pr comment <pr> --body "@mergifyio queue"
     ```

     That comment is Mergify's enqueue: it replies on the PR and adds the
     `queued` label, swapped for `dequeued` after a failed attempt. A failed
     queue build runs on a `mergify/merge-queue/…` branch in Buildkite, and the
     dequeued PR's Mergify comment names it; `docs/merge-gates.md` shows how to
     list those builds.

<!-- ralph:section REQUEUE -->
Here the re-queue command is
         `gh pr comment <pr> --body "@mergifyio requeue"`, posted once per
         PR and only when the failed queue job does not reproduce locally.
         The queue gate hook does not gate `requeue` on CI colour, so it goes
         through on a head whose Mergify queue check is still red; it does
         refuse it while status.mergify.com reports a component that is not
         operational, because Mergify is then not re-evaluating PRs: wait for
         the status page rather than requeue (§1's external blocker). Never
         reach for `@mergifyio queue` or `LOGGD_MERGE_RED` instead. You never
         run Playwright here, so a failed e2e job counts as not reproducing
         only when the failing spec is a known flake (see the flaky-spec rule
         above) and your diff does not touch it.

<!-- ralph:section CODEX_REBASE -->
A rebase marks open Codex threads outdated, but they still count:
     answer each one (the finding may still hold), as §5 step 6 says.

<!-- ralph:section JOURNAL_GLOSSARY -->
If this ticket settled a domain term — a concept the code now names one way
and the glossary doesn't carry, or a synonym you had to rule out — add it to
`CONTEXT.md` in the existing format (definition plus an `_Avoid_` line), in
the ticket PR. That is the one file outside the ticket's own scope you may
touch, and it is how the glossary grows: from work that actually resolved the
term, not from a documentation pass. Contradicting an existing ADR is not a
journal note — surface it on the issue and treat it as a blocker.

<!-- ralph:section CI_DOCTOR -->
Loggd's CI is Buildkite (`buildkite/loggd`); the GitHub Actions workflow is
`workflow_dispatch`-only and is not a case. The merge queue is Mergify:
`@mergifyio queue` to enqueue, `@mergifyio requeue` to re-queue, and
`$RALPH_HOME/merge-wait.ts` for the wait. Supabase and Doppler are the
operator's; a case that needs either needs a human.

<!-- ralph:section CI_DOCTOR_JOB_COMMANDS -->
The failing Buildkite job maps to one local command, and only this map:

| Buildkite job | locally, on T's file only |
| ------------- | ------------------------- |
| quality       | `bun run test:coverage -- <file>` |
| typecheck     | `bun run typecheck` |
| build         | `bun run build` |
| e2e           | nothing — you never run Playwright (file it, §2.2) |

<!-- ralph:section CI_DOCTOR_KNOWN_FLAKES -->
`e2e/onboarding.spec.ts` flakes on every branch and is E2E, so it is filed and
never fixed here. Any other E2E spec is the same: CI owns Playwright twice
over, on the pull request and again in the queue, and the doctor neither runs
nor repairs it.

<!-- ralph:section CI_DOCTOR_HOST_FENCE -->
Before each batch of timing runs, inspect `docker top buildkite-agent -eo
pid,comm` and `docker logs --since 30m buildkite-agent` for job start/finish
entries. These reads need no Buildkite token. If work is active, or you cannot
establish idleness, the host is busy: do not run, and record the reading. CI
can start after an idle check — if it does, stop your own command and defer it.

<!-- ralph:section CI_DOCTOR_GATES -->
The gate is loggd's coder gate, in this order, and the first one is scoped to
the files the fix touched:

1. `bun run test <paths>`
2. `bun run typecheck`
3. `bun lint`
4. `bun run lint:shadcn`
5. `bun run build`

The heavy ones are behind the host fence above, exactly as a coder's are: if
Buildkite is busy, defer them and let CI validate, and say in the pull request
which you deferred.

<!-- ralph:section PR_MEDIC -->
Loggd's only required CI check is Buildkite (`buildkite/loggd`); the GitHub
Actions workflow is `workflow_dispatch`-only and is not a case. Vercel deployments
are optional and manual while the project is pre-launch: a missing, canceled,
or failed `Vercel` status is not a merge blocker or a PR-medic remediation task.
Investigate a Vercel failure only when the operator explicitly asks about a
manual deployment. The merge queue is Mergify, and its commands
(`@mergifyio queue`, `@mergifyio requeue`) are exactly what guardrail 1 forbids
you to post. Supabase and Doppler are the operator's; a red that needs either
needs a human. This project's coder rules hold for you too: never create an
env file, never run `doppler`, and never run Playwright.

<!-- ralph:section PR_MEDIC_STALE -->
- **The "never grows" ratchets.** Each of these conformance tests reads its old
  list from the base branch and fails when the branch's list is longer. CI
  points `CONFORMANCE_BASE_REF` and `ACTION_RESULT_BASE_REF` at
  `origin/<base>`; see `src/test/ratchet-base.ts`.
  - `src/server/actions/action-result-conformance.test.ts`: "the baseline never grows"
  - `src/server/db/review-visibility-conformance.test.ts`: "the baseline never grows"
  - `src/server/auth/acting-member-conformance.test.ts`: "never increases the baseline or adapter exemptions from the base branch"
  - `src/server/title-detail/title-detail-conformance.test.ts`: "never grows TITLE_DETAIL_EXCEPTIONS against the base branch"
  - `src/app/api/v1/route-conformance.test.ts` and `src/app/api/v1/profile-subject-conformance.test.ts`: "never grows against the base branch"
  - `src/app/auth-connection-conformance.test.ts`: "the above-a-boundary list never grows"
  - `src/components/media/poster-slot-conformance.test.ts`: "the exemptions never grow"

  Agents shrink these lists on main all day, so a branch behind main can go
  red on a list it never touched. If the operator's diff does not add to the
  list, it is stale: rebase. If the diff adds an entry, it is bin B. Locally
  the test can pass against a stale `origin/main`, and it skips when the base
  ref is missing. So fetch the base first, run it as the job map below says,
  and don't treat a green local run as proof the branch isn't stale.
- **The screenshot baselines.** `e2e/poster-sizing.spec.ts` compares each page
  family at 375, 768 and 1280 px against the PNGs in
  `e2e/poster-sizing.spec.ts-snapshots/` (`show-detail-1280-chromium-linux.png`,
  `feed-768-chromium-authenticated-linux.png`, …). A failure is a
  `toHaveScreenshot` diff on one `<family>-<width>` route. If the operator's
  diff doesn't touch that page and main changed the page or its baseline since
  the branch was cut (`git log --oneline "$expect..origin/<base>" --
  e2e/poster-sizing.spec.ts-snapshots <the page's files>`), it is stale:
  rebase. If the diff changes that page's layout, it is not stale and you
  can't fix it. The new baseline is the `-actual.png` in the build's
  `playwright-report` artifact, Playwright never runs here, and whether the
  new look is right is the operator's call. Take the blocked path (§5.7) and
  name the route, the width and the build.
- **Anything main was red on and has since fixed.** `bk-log.ts` marks it
  `known: main was red on this test from build <n>`. The fix is already on
  main, and a rebase brings it in. A test main is red on right now
  (`main red since build <n>`) is not stale: a rebase won't clear it, and it
  is bin C, the ci-doctor's.

<!-- ralph:section PR_MEDIC_JOB_COMMANDS -->
The failing Buildkite job maps to one local command, and only this map:

| Buildkite job | locally, on the failing file only |
| ------------- | --------------------------------- |
| quality — a unit test | `bun run test:coverage -- <file>` |
| quality — a ratchet (above) | `git fetch origin <base>`, then `CI=1 CONFORMANCE_BASE_REF=origin/<base> ACTION_RESULT_BASE_REF=origin/<base> bun run test:coverage -- <file>` |
| quality — lint | `bun lint` (it lints `src/ mobile/ packages/ eslint-rules/`; read the failing file's findings) |
| quality — a `mobile/` test | `bun run --cwd mobile test -- <file>` |
| quality — mobile typecheck | `bun run --cwd mobile typecheck` |
| typecheck | `bun run typecheck` |
| build | `bun run build` |
| production-migrations | nothing: it reads the production ledger, which is the operator's. A `Pending safe apply withheld:` line on a PR adding a migration is the coder rail's (migrations HARD RAIL), not yours |
| e2e | nothing: you never run Playwright. A screenshot diff is placed above; any other E2E red is placed by the diff and `known:`, and CI re-runs it after your push |

<!-- ralph:section PR_MEDIC_HOST_FENCE -->
Before each batch of local runs, inspect `docker top buildkite-agent -eo
pid,comm` and `docker logs --since 30m buildkite-agent` for job start/finish
entries. These reads need no Buildkite token. If work is active, or you cannot
establish idleness, the host is busy: do not run, and record the reading. CI
can start after an idle check — if it does, stop your own command and defer it.

<!-- ralph:section PR_MEDIC_GATES -->
The gate is loggd's coder gate, in this order, and the first one is scoped to
the files the fix touched:

1. `bun run test <paths>`
2. `bun run typecheck`
3. `bun lint`
4. `bun run lint:shadcn`
5. `bun run build`

If the fix touches `mobile/`, also run `bun run --cwd mobile test -- <paths>`
and `bun run --cwd mobile typecheck` after step 2. CI runs both.

The heavy ones are behind the host fence above, exactly as a coder's are: if
Buildkite is busy, defer them and let CI validate, and say in the pull request
which you deferred. `lint:shadcn` is never deferred: the `.husky/pre-push`
hook runs it again inside `push.ts`'s push, so a finding there fails the push.

<!-- ralph:section TRIAGER_DIFFICULTY -->
On Loggd, route a ticket `difficulty:hard` if ANY of these hold:

- the change crosses surfaces — web and mobile, or api and db — or it adds a
  domain concept (a new term for `CONTEXT.md`);
- it touches a conformance or ratchet test, or an allowlist;
- an acceptance criterion needs a measurement from a production build or a quiet
  host (the host-lease case, felipearos/loggd#1604);
- a journal entry records a failed or blocked attempt on this ticket, or on a
  sibling of the same shape;
- the mapper's estimate is more than 5 files, or it could not bound the change at
  all.

`difficulty:easy` only when ALL of these hold: one module, at most 5 files, every
acceptance criterion testable by a unit or component test, and — ideally — a
merged sibling whose pattern the coder can copy.

A migration, a Doppler secret, or anything needing Playwright is not an easy
ticket; an unsafe migration is usually `ready-for-human`.

<!-- ralph:section TRIAGER_SPLIT -->
On Loggd a ticket is oversize when EITHER the body has more than 8 acceptance-
criteria checkboxes, OR it names three or more of the surfaces web, mobile, api
and db. Split along the surface seam first — one child per surface, in dependency
order (db → api → web/mobile) — because that is the seam the staffing groups and
the coders' skills already follow. Each child names the query, the route, the
hook, the component or the screen it owns; a child that would touch every surface
has not been split.

<!-- ralph:section TRIAGER_READINESS -->
On Loggd, `ready-for-human` rather than `ready-for-agent` when the ticket needs
any of these, and say which in the comment:

- a migration the classifier (`bun run db:classify-migrations`) would call
  unsafe — anything but a nullable or constant-default column with no foreign
  key onto an existing table, or a new enum value. That includes a new table,
  whose `lock_*` migration revokes its id sequence; a drop, rename, type
  change or backfill; a `NOT NULL`, foreign key or other constraint on an
  existing table; an index on one; a policy, grant, function, trigger or
  extension. Only a person may apply those (the coder prompt's migrations
  HARD RAIL). A classifier-safe migration is not by itself a reason: the
  merge queue applies it;
- a new Doppler secret or any credential;
- a Vercel, Buildkite or host configuration change;
- an end-to-end or Playwright check as its only verification, since no loop may
  run Playwright;
- a product or design decision that neither `CONTEXT.md` nor `docs/adr/**`
  settles.

A ticket that only READS a table a migration already created is ordinary work;
it is the migration itself that a person must apply.
