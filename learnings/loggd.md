# loggd learnings

Lessons from running Ralph on loggd. See `README.md` for how learnings are
split.

## Open: fix these

### Mobile jest DiaryTab Books empty-state test flakes in quality (2026-11-23)
<!-- learning: diarytab-books-empty-state-flake -->
- **Seen:** PR #3746 builds 5100 and 5103 (2026-11-23), also builds 5102, 5101, 5099, 5097 (incl. merge-queue branches): quality job, `components/__tests__/DiaryTab.test.tsx` › "names Book Logs and offers a book to log in Books mode" fails `expect(instance).toBeOnTheScreen()`; bk-log marks it confirmed flake.
- **Workaround:** Not the diff. First red: re-run CI with an empty commit. Second red: RETRY_LATER without re-running; block only at the 4th flake red per harness §5.4.
- **Fix:** #3749

### Mobile DiaryTab Books-mode empty-state test fails on main and dequeues every PR (2026-11-23)
<!-- learning: mobile-diarytab-books-empty-state-fails-on-main -->
- **Seen:** main build 5095 (f85164a38) and queue build 5097 for PR #3740 red in quality/jest on `mobile/components/__tests__/DiaryTab.test.tsx` › "DiaryTab empty state › names Book Logs and offers a book to log in Books mode": `findByText("No Book Logs with a Read Date yet.")` not found (line 374). Locally on plain origin/main d303a7084 it failed 3/3; on main+PR 2/3; main build 5096 passed it. Landed with #3736 (#3107) next to #3737 (#3138).
- **Workaround:** not the diff of any PR that doesn't touch DiaryTab. Don't requeue into it. Leave the claim and RETRY_LATER with key `ci:buildkite/loggd:quality` until main's test is fixed.
- **Fix:** https://github.com/felipearos/loggd/issues/3748
- **Change:** Make the DiaryTab Books-mode empty-state test deterministic. Mock or await the Books-mode/Media Mode Preview read that gates the Book Logs empty state, so the empty copy renders before `findByText` times out. Or fix the component if the empty state really depends on an order between the #3107 and #3138 changes.
- **Verify:** `cd mobile && for i in $(seq 10); do npx jest components/__tests__/DiaryTab.test.tsx; done` passes 10/10 on main.

### Every PR build red on production-migrations while the prod DB is down (2026-11-23)
<!-- learning: prod-db-down-migration-check-xx000 -->
- **Seen:** Buildkite builds 5000-5006 (PRs #3686-#3690, 2026-11-23) all fail only `production-migrations` with "Production migration check failed (classification=ledger-check; host=aws-1-us-east-1.pooler.supabase.com port=6543): Failed query ... code=XX000"; prod DB down since 2026-11-19. No build has passed the step since.
- **Workaround:** a diff that touches no drizzle/ or migrations is not at fault: do not re-run or block; write retry-blocker.json with key `ci:buildkite/loggd:production-migrations`, keep the claim, end RETRY_LATER. Once any build passes the step, push an empty commit and AWAIT_PR ci.
- **Fix:** https://github.com/felipearos/loggd/issues/3700

### Production DB unreachable: every PR build red on production-migrations (2026-11-23)
<!-- learning: prod-db-down-reds-production-migrations -->
- **Seen:** Buildkite builds 5000-5006 (PRs #3686-#3690, all loops) red only on `production-migrations`: "Production migration check failed (classification=ledger-check; ... pooler.supabase.com port=6543): Failed query ... code=XX000". Prod DB down since 2026-11-19; no PR build has passed the job through build 5008.
- **Workaround:** Not the diff and not a flake; do not re-run or block. Keep the claim, write retry-blocker.json with key `ci:buildkite/loggd:production-migrations`, end RETRY_LATER. Once any build passes the job, push an empty commit and hand back AWAIT_PR ci.
- **Fix:** https://github.com/felipearos/loggd/issues/3699

### production-migrations goes red on every PR while the prod database is down (2026-11-23)
<!-- learning: prod-pooler-xx000-reds-production-migrations -->
- **Seen:** Buildkite builds 4998-5006 (PRs #3687, #3688, #3689, #3686, #3690) on 2026-11-23, each red only on `production-migrations`: "Production migration check failed (classification=ledger-check; ... host=aws-1-us-east-1.pooler.supabase.com port=6543): Failed query ... code=XX000". The prod database has been down since 2026-11-19. Main build 5007 skipped the job.
- **Workaround:** This is not a strike and not a flake. Do not re-run into it. Write retry-blocker.json with key `ci:buildkite/loggd:production-migrations`, keep the claim, and end RETRY_LATER. Once any build passes the job, push one empty commit and hand back AWAIT_PR ci.
- **Fix:** https://github.com/felipearos/loggd/issues/3698

### Production migration ledger check fails with XX000 on every PR while hosted prod is down (2026-11-23)
<!-- learning: prod-migration-ledger-pooler-xx000 -->
- **Seen:** 2026-11-23, builds 5001–5006 (PRs #3686, #3687, #3688, #3689, #3690): only `production-migrations` fails, with `Production migration check failed (classification=ledger-check; ... host=aws-1-us-east-1.pooler.supabase.com port=6543): Failed query ... code=XX000`. Every other job green. The hosted prod DB has been down since 2026-11-19.
- **Workaround:** if `bk-log.ts` shows only `production-migrations` failing with code=XX000 (not "ledger does not match"), and other open PRs fail the same line, it is not the diff and not a strike. Do not re-run into it; update the handoff, write retry-blocker.json with key `ci:buildkite/loggd:production-migrations`, keep the claim, end RETRY_LATER.
- **Fix:** https://github.com/felipearos/loggd/issues/3697 — an operator restores the hosted prod Supabase project (or the check skips/soft-fails when prod is unreachable).
- **Seen again:** 2026-11-23

### Production migration ledger check fails with a pooler XX000 while prod is down (2026-11-23)
<!-- learning: prod-pooler-xx000-ledger-check -->
- **Seen:** PR #3688 builds 5000 and 5005 on 2026-11-23: `production-migrations` fails `classification=ledger-check; host=aws-1-us-east-1.pooler.supabase.com port=6543 … code=XX000`, every other job green. The diff touches only mobile/. The operator noted prod down since 2026-11-19.
- **Workaround:** if `bk-log.ts` shows only `production-migrations` failing with the pooler `code=XX000` (not the ledger-mismatch message), the prod database is unreachable, not the diff, and not a strike. Do not re-run into it. Write retry-blocker.json with key `ci:buildkite/loggd:production-migrations`, keep the claim, end RETRY_LATER.
- **Fix:** https://github.com/felipearos/loggd/issues/3696 — Prod Supabase has to be restored (operator side). The audit could also tell "host unreachable" apart from "ledger mismatch" in its classification.

### production-migrations fails with XX000 from the prod pooler on every branch (2026-11-23)
<!-- learning: prod-pooler-xx000-migration-check -->
- **Seen:** 2026-11-23, PR #3687 builds 4999 and 5003 and testo's build 4998. Only the `production-migrations` job fails, with "Production migration check failed (classification=ledger-check; ... host=aws-1-us-east-1.pooler.supabase.com port=6543): Failed query ... code=XX000". That is a Postgres internal error from the prod pooler, not a ledger mismatch, on diffs that touch no migrations. Builds up to 4989 passed the step.
- **Workaround:** if bk-log.ts shows only this job red with code=XX000 and the diff leaves drizzle/ and src/server/db/ untouched, treat it as a flake: re-run once, and on a second red end RETRY_LATER with the claim kept. Never reach for prod credentials.
- **Fix:** https://github.com/felipearos/loggd/issues/3695 — An operator checks the prod Supabase project and its pooler (prod was reported down 2026-11-19). The check could also print the server's diagnostic message instead of omitting it.
- **Seen again:** 2026-11-23
- **Seen again:** 2026-11-23

### Production migration ledger check fails with XX000 on every branch while prod is down (2026-11-23)
<!-- learning: prod-db-unreachable-migration-ledger -->
- **Seen:** 2026-11-23. Builds 5000 (PR #3688), 5001 (PR #3689) and 5002 (PR #3686) all red on `production-migrations` only: "Production migration check failed (classification=ledger-check; ... host=aws-1-us-east-1.pooler.supabase.com port=6543): Failed query ... code=XX000". Prod has been down since 2026-11-19; none of the diffs touch drizzle/ or migrations. This is not the ledger-mismatch incident in `prod-ledger-ahead-of-main`: the query itself fails.
- **Workaround:** if `bk-log.ts` shows only `production-migrations` failing with `code=XX000` on the pooler, it is not the diff, not a flake and not a strike. Do not re-run into it. Keep the claim, write retry-blocker.json keyed `ci:buildkite/loggd:production-migrations`, end RETRY_LATER; once any branch's build passes the job, push an empty commit and hand back the CI wait.
- **Fix:** https://github.com/felipearos/loggd/issues/3694 — an operator restores the production database (or the pooler), after which the job goes green on its own.

### production-migrations red on every branch: hosted prod DB fails the ledger query with XX000 (2026-11-23)
<!-- learning: prod-db-query-xx000-ledger-check -->
- **Seen:** 2026-11-23, Buildkite builds 4998 (PR #3686), 4999 (rafa/3171), 5000 (remo/3201), 5001 (ralph/3304), 5002 (PR #3686): `production-migrations` fails with "Production migration check failed (classification=ledger-check; project=liuuaowngrfjgsfndeeu host=aws-1-us-east-1.pooler.supabase.com port=6543): Failed query … code=XX000". This is not a ledger mismatch: the hosted prod database is erroring on the query (prod reported down since 2026-11-19).
- **Workaround:** if `bk-log.ts` shows only `production-migrations` failing with `code=XX000` and the diff leaves `drizzle/` and `src/server/db/` untouched, it is not a strike and a re-run only reproduces it. Keep the claim, write retry-blocker.json with key `ci:buildkite/loggd:production-migrations`, end RETRY_LATER. Never reach for prod credentials.
- **Fix:** https://github.com/felipearos/loggd/issues/3693 — an operator restores the hosted prod database (or points the ledger check at a reachable target) so the required job can pass again.
- **Seen again:** 2026-11-23

### production-migrations goes red on every PR while the prod DB is down (2026-11-23)
<!-- learning: production-migrations-prod-db-unreachable -->
- **Seen:** 2026-11-23, PR #3688 build 5000 (remo) and PR #3689 build 5001 (ralph): the only failed job is `production-migrations`, "Production migration check failed (classification=ledger-check; ... pooler.supabase.com port=6543): Failed query ... code=XX000". Neither diff touches drizzle/ or migrations; the hosted prod Supabase has been down since 2026-11-19.
- **Workaround:** not a strike and not a flake; do not re-run into it. Keep the claim, write retry-blocker.json with key `ci:buildkite/loggd:production-migrations`, end RETRY_LATER. Once any build shows that job green, push an empty commit on the PR and hand back `AWAIT_PR <pr> ci`.
- **Fix:** https://github.com/felipearos/loggd/issues/3692 — (an operator restores the prod database, or the job reports infra unreachability as a skip rather than a red).
- **Seen again:** 2026-11-23

### production-migrations red on every PR while the prod database is unreachable (2026-11-23)
<!-- learning: prod-db-unreachable-ledger-check -->
- **Seen:** 2026-11-23, PR #3689 build 5001 and PR #3688 build 5000 both fail only `production-migrations` with "Production migration check failed (classification=ledger-check; project=liuuaowngrfjgsfndeeu host=aws-1-us-east-1.pooler.supabase.com ...): Failed query ... code=XX000". Prod has been down since 2026-11-19; main's builds skip the job, so main does not show it.
- **Workaround:** if this is the only red job and the diff touches no drizzle/ or migrations, it is not the diff and not a strike. Do not re-run into it: comment once on the PR, write retry-blocker.json with key `ci:buildkite/loggd:production-migrations`, keep the claim, end RETRY_LATER. Re-run CI once another branch's job goes green.
- **Fix:** https://github.com/felipearos/loggd/issues/3691 — an operator restores the production database (or the job's connection), after which the ledger check can query it again.
- **Seen again:** 2026-11-23
- **Seen again:** 2026-11-23

### GitHub rejects the host's SSH key, so `git fetch`/`push` on every loop worktree fails (2026-11-04)
<!-- learning: github-ssh-key-rejected -->
- **Seen:** 2026-11-04 ~10:30Z, rafa orientation. `git fetch origin` (remote `git@github.com:felipearos/loggd.git`, shared by every loop worktree) failed with `Permission denied (publickey)`. The agent at /run/user/1000/gcr/ssh held the key (ed25519 SHA256:UDTFukIg…) and so did ~/.ssh/id_ed25519, and GitHub refused both. The same remote had pushed PR #2882 at 06:02Z, so it started after that. **It is working again as of 2026-11-04 ~12:10Z:** testo's orientation `git fetch origin` and its `git push -u origin testo/2705-…` (PR #2886) both succeeded over plain SSH from a loop worktree with no `insteadOf` override, so the outage lasted roughly two hours and the key is accepted again.
- **Workaround:** try the plain SSH command FIRST — the refusal is intermittent rather than a standing configuration fault, and as of 2026-11-04 12:10Z it is not refusing. Only if it does refuse, run git network commands over HTTPS without touching config: `export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf GIT_CONFIG_VALUE_0=git@github.com:` (or `git -c url.https://github.com/.insteadOf=git@github.com: fetch …`). The `!/usr/bin/gh auth git-credential` helper authenticates as felipearosr.
- **Fix:** https://github.com/felipearos/loggd/issues/3450 — Kept open because nobody established WHY the key was refused for those two hours, so it can recur; an operator who confirms the key is permanently fine on GitHub can close it.
- **Verify:** `ssh -T -o BatchMode=yes git@github.com` prints "Hi felipearosr!" and a plain `git fetch origin` in a loop worktree succeeds.
- **Seen again:** 2026-11-04

### A CI wait times out while the build sits behind this host's other builds (2026-10-22)
<!-- learning: ci-wait-times-out-behind-host-build-queue -->
- **Seen:** PR #2781 (#2707, testo) spent **four of its six CI wait rounds in timeout** on 2026-10-22 — rounds 1 and 3 (builds 4061, 4068), round 5 (4083) and round 6 (4089) — with `bk-log.ts --pr 2781` reporting "running, 9 jobs, no failed jobs" every time. At 21:38Z `uptime` showed load average **36.59** on 16 cores and `docker logs --since 60m buildkite-agent` showed the three slots `home-loggd-1/2/3` churning builds 4085, 4086, 4087 and 4090 while 4089 (ours) waited. The agent was `Up 34 hours` and dind healthy, so `buildkite-agent-container-down` did not apply. Nothing was ever red; the iteration ended with a `MERGEABLE` PR, no open review threads and no code outstanding, purely for want of an agent slot. **It also costs merge-queue rounds, not just wait rounds:** on 2026-11-17 Mergify dequeued PR #3604 (#3178, testo) with `CHECKS_TIMEOUT` — "the checks did not pass within the checks timeout of 1 hour" — after its queue build 4862 (`mergify/merge-queue/438f203364`) sat queued behind builds 4859, 4860 and 4861 from 13:19Z and only started its own jobs at 14:13-14:22Z, so the 1-hour window expired with 0 of 9 jobs failed and the build still running at 14:26Z. The PR's own CI on that head had already timed out twice at 1500s before going green, which is the same starvation seen from the other end. **The agent slots are not the whole bottleneck, and measuring only them is misleading.** At 17:03Z on 2026-11-17, with #3604 still waiting to be re-enqueued, `docker logs` showed slot 1 idle since 16:55:47 and slot 3 idle since 17:00:48 — two of three slots free, load average down to 20.72 — and yet builds 4883 and 4884 had each run only their two short upload jobs and had nothing picked up for eight minutes. The hold was Buildkite's pipeline **concurrency groups**: `loggd/e2e` and `loggd/quality` are `concurrency: 1` pipeline-wide (see the comment in `.mergify.yml` and the pipeline definition), so one build's quality job blocks every other build's, idle slots or not. 4884 was Mergify's own `mergify/merge-queue/44820424df` (PR #3626, created 16:55:13Z, 60-minute clock already ticking) starving behind rulo's #3625 build 4882.
- **Workaround:** a timeout with "no failed jobs" is **not** a red and not a flake: do not push an empty commit, do not re-queue, and do not spend §5.4's re-run allowance on it. Confirm it is the queue rather than a dead agent — `docker ps --filter name=buildkite` (agent Up) plus `docker logs --since 60m buildkite-agent | grep "Starting job"` showing *other* builds' jobs — then update the handoff note with the build number and the competing builds, leave `$RALPH_LOOP_NAME-wip` in place, and end the iteration (`DONE`, or `RETRY_LATER` if rounds remain). The next iteration resumes the PR under §1 priority 1 and usually only needs the green check and the enqueue. Also stop queueing *local* heavy gates behind it: §4's host fence will refuse them for the same reason, and all of lint/typecheck/build are inside `buildkite/loggd` anyway. **A Mergify `CHECKS_TIMEOUT` dequeue is the same cause and takes the same branch:** read `docker logs` for whose jobs ran inside the queue window before treating it as §5.6's reproducible-failure case, because `@mergifyio requeue` only restarts the same 1-hour clock against the same three slots and burns one of §5.6's two rounds for a certain second timeout. Journal it as §1's external blocker with a shared `ci:buildkite/loggd:queued-behind-host-build-queue` key, keep the claim and end `RETRY_LATER`; a later iteration enqueues when the host is quiet. **Judge "quiet" by the concurrency groups, not by idle slots.** Idle slots prove nothing — a build whose only log entries are two short upload jobs, with minutes of silence after, is blocked on `loggd/quality` or `loggd/e2e`, not on a slot. The read that settles it: for each recent build in `docker logs --since 30m buildkite-agent | grep -E "Starting job|Finished job"`, a build with a *long-running* started-but-unfinished job holds a concurrency group, and every other pending build is behind it. Enqueue only when no build is in that state and Mergify's queue is empty (no open `mergify/merge-queue/*` PR, no `queued` labels); otherwise the 60-minute `checks_timeout` cannot be met and the enqueue is a wasted round.
- **Fix:** https://github.com/felipearos/loggd/issues/3451 — (the host runs three agent slots for five loops, so concurrent pushes self-starve; either fewer concurrent loops, more slots, or a supervisor wait that scales with the agent queue depth). Mergify's `checks_timeout` for the `main` queue being shorter than a starved build's wall clock is part of the same fix, and so is the pipeline-wide `concurrency: 1` on `loggd/quality` and `loggd/e2e`, which serialises every loop's build behind every other loop's regardless of how many slots are free.
- **Change:** have the supervisor's CI wait distinguish "pending, build not yet started or queued behind N other builds" from "pending, running": when the build has no running job after the wait budget, report `queued` rather than `timeout` so the iteration does not have to re-derive the host state from `docker logs` each round. The same signal should gate the enqueue: do not enqueue while builds are already waiting for a slot **or for a pipeline concurrency group**, since the queue's `checks_timeout` cannot be met.
- **Verify:** with three builds already occupying the agent slots, push a fourth PR head and run the supervisor's CI wait: it reports `queued` naming the builds ahead of it, and the resumed session takes the hand-off branch without reading `docker logs`.









### Unapplied prod migrations turn every web PR's buildkite/loggd red (2026-10-16)
<!-- learning: prod-migration-ledger-unapplied -->
- **Seen:** 2026-10-16. #2493 merged drizzle/0067_onboarding_seen_step.sql and 0068_onboarding_seen_step_backfill.sql, and they were not applied to prod. The `production-migrations` step ("Production's Drizzle ledger does not match the committed migrations") then failed on main build 3698 and on PR #2513 builds 3700 and 3702, while that PR's e2e was green in 3702.
- **Workaround:** if `bk-log.ts` shows only `production-migrations` failing with the ledger mismatch, and main's buildkite/loggd fails the same way (`gh api repos/felipearos/loggd/commits/main/status`), the cause is outside the repo. It is not a strike, and re-running only reproduces it. Keep the claim, journal it, end RETRY_LATER. Never apply the migrations yourself: the prod credentials are withheld.
- **Fix:** https://github.com/felipearos/loggd/issues/3453 — A person applies the pending migrations to prod by hand, in a transaction.
- **Seen again:** 2026-10-16

### Every PR's production-migrations job is red while main carries an unapplied migration (2026-10-16)
<!-- learning: prod-migration-ledger-unapplied-on-main -->
- **Seen:** PR #2513 build 3700 and main build 3698 on 2026-10-16. Both fail `production-migrations` with "Production's Drizzle ledger does not match the committed migrations" after #2493 merged drizzle/0067 and 0068 without anyone applying them to prod.
- **Workaround:** When `bk-log.ts` shows only this job failing and main's latest build fails it too, the failure is not the diff and not a strike. Do not re-run into it: update the handoff and end RETRY_LATER until a person applies the migrations and main goes green.
- **Fix:** https://github.com/felipearos/loggd/issues/3454 — Migrations are applied by hand after merge, so main stays red until someone does.

### Every PR is red on the production migration ledger check (2026-10-16)
<!-- learning: prod-migration-ledger-diverged -->
- **Seen:** 2026-10-16, the same incident as `prod-ledger-ahead-of-main`; filed separately by another loop the same night.
- **Workaround:** follow `prod-ledger-ahead-of-main`.
- **Fix:** duplicate; close together with `prod-ledger-ahead-of-main`.

### Every PR is red on the production migration ledger audit (2026-10-16)
<!-- learning: production-migration-ledger-drift -->
- **Seen:** 2026-10-16, the same incident as `prod-ledger-ahead-of-main`; filed separately by another loop the same night.
- **Workaround:** follow `prod-ledger-ahead-of-main`.
- **Fix:** duplicate; close together with `prod-ledger-ahead-of-main`.
- **Seen again:** 2026-10-16

### Production migration ledger red on every branch while a migration PR waits to merge (2026-10-16)
<!-- learning: prod-ledger-ahead-of-main -->
- **Seen:** night of 2026-10-15/16, confirmed by an operator. Two hand applies to prod, each made before its PR merged, deadlocked the required `production-migrations` job across the repo. 02:41Z: #2493's 0067/0068 applied (ledger ids 61, 62). From then on, every branch at main's 0066 tip was red (#2492 build 3666, #2494 build 3668). 03:08Z: the session on PR #2505 applied ITS OWN `0067_show_media_override_episode` (id 65). Neither could go green, main's builds skip the job so main looked green, and rafa, remo and testo each spent the 6 h backoff budget. That instance is over — #2493 and #2505 have long merged, so do not read their numbers as current. It has recurred since, and the 2026-10-22 instance is the single-PR variant: prod carries ledger rows 67/68 (`drizzle/0075_follow_across_block.sql`, `0076_delete_follows_across_blocks.sql`) that exist only on **PR #2760** (#2690, testo), still `OPEN`/`CONFLICTING` and red, while `origin/main` tops out at `0074_home_hero_logo.sql` — and **#2690 carries no `*-wip` label and #2760 no labels**, so nobody owns the one PR whose merge clears it.
- **Workaround:** if the only red job is `production-migrations` and your diff leaves `drizzle/ migrations/ src/server/db/` untouched, it is not yours. Do NOT renumber migrations, rebase to fix it, or wait for a merge order: no branch can clear it. Spend at most one re-run, comment once on the PR, keep the claim, end `RETRY_LATER`. Tell the two variants apart with `gh pr list` over open PRs adding `drizzle/*.sql`: two or more is a numbering race that only an operator can order, exactly one means that PR is the whole unstick. In the single-PR case, if its issue is OPEN, `ready-for-agent` and unclaimed, the cheapest route out is for the next iteration's frontier pass to claim **that** ticket and land it — never take it mid-iteration on top of your own.
- **Fix:** operator side, no issue yet. Apply a migration to prod only right before merging its PR, and merge it at once (admin merge past the ledger check if needed). Never let two unmerged migrations sit in prod unapplied-on-main. To unstick an instance: get the PR that owns the ahead-of-main rows green and merged (rebasing it first if it is `CONFLICTING`), then re-run the other PRs' builds; with two racing PRs, admin-merge the lower-numbered one and renumber the other to follow it with identical bytes. Also open: the audit should print WHICH row mismatched (it prints only the classification), main's build should run it, and a loop should not spend a backoff budget on a repo-wide red.
- **Seen again:** 2026-10-16
- **Seen again:** 2026-10-16
- **Seen again:** 2026-10-16
- **Seen again:** 2026-10-16
- **Seen again:** 2026-10-17
- **Seen again:** 2026-10-17
- **Seen again:** 2026-10-22
- **Seen again:** 2026-10-22
- **Seen again:** 2026-10-22
- **Seen again:** 2026-10-22
- **Seen again:** 2026-10-22
- **Seen again:** 2026-10-22
- **Seen again:** 2026-10-22
- **Seen again:** 2026-10-22
- **Seen again:** 2026-10-22
- **Seen again:** 2026-10-22
- **Seen again:** 2026-10-22
- **Seen again:** 2026-10-22
- **Seen again:** 2026-10-22
- **Seen again:** 2026-11-12
- **Seen again:** 2026-11-12
- **Seen again:** 2026-11-12
- **Seen again:** 2026-11-12
- **Seen again:** 2026-11-12
- **Seen again:** 2026-11-12
- **Seen again:** 2026-11-12

### Buildkite agent container down leaves PR builds "scheduled" forever (2026-10-15)
<!-- learning: buildkite-agent-container-down -->
- **Seen:** PR #2445 (#2442), build #3598 stayed `buildkite/loggd pending — Build #3598 scheduled` through a full 1500s CI wait on 2026-10-15; `docker ps -a` showed `buildkite-agent Exited (137) 6 hours ago` with `buildkite-dind` still healthy.
- **Workaround:** when a CI wait times out with the build only "scheduled", check `docker ps -a --filter name=buildkite` before re-running anything. If the agent has exited, do not push empty commits or re-queue: leave the claim, update the handoff note, end `RETRY_LATER`. An operator restarts it with `docker start buildkite-agent`.
- **Fix:** https://github.com/felipearos/loggd/issues/3455 — (the agent container needs a restart policy, or a supervisor check that sees it down).
- **Seen again:** 2026-10-15
- **Seen again:** 2026-10-15
- **Seen again:** 2026-10-15











### Mobile jest diary-tab-virtualized end-reached test fails intermittently in CI (2026-10-08)
<!-- learning: mobile-diary-tab-end-reached-flake -->
- **Seen:** PR #2232: Buildkite builds 3288 and 3294, quality job jest. `diary-tab-virtualized.test.tsx > does not request a failed next page again on further end-reached calls` got 2 `offset=3` requests where it expects 1. Locally it passed 11/11 on the same heads, and the diff does not touch the test or `useProfileCollection`.
- **Workaround:** if it is the only red, take the single re-run. bk-log lists it as a flake candidate, so a second red blocks the PR under §5.4 until a human confirms it is a flake or fixes the test.
- **Fix:** https://github.com/felipearos/loggd/issues/3457 — Suspect RecyclerView's own onEndReached racing the test's `reachEnd()` once the page has failed. Make the test wait out the list's auto end-reached call, or assert on request count only after the error footer settles.

### The loggd backlog is drained to human-gated tickets (2026-10-08)
<!-- learning: loggd-backlog-human-gated -->
- **Seen:** testo run `testo-run-20261008T081521-27548`, 2026-10-08. `frontier/next.ts --take-one` returned `ticket: null` with no obstructions and no error, and all seven parent-closure exceptions (#542, #507, #528, #759, #760, #761, #762) are already closed. The whole open list is six issues: #1996 claimed (`remo-wip`), #2203 / #1956 / #1911 `ready-for-human`, #1940 `needs-info`, #228 out of scope.
- **Workaround:** none for a loop — `ALL_BLOCKED` is the only correct ending, and re-deriving the graph each iteration is wasted work. The three `ready-for-human` tickets each need a measurement or a production check an operator must do (#2203 prod timing, #1911 Sentry verification), and #1940 needs its recheck answered; relabelling any of them `ready-for-agent` refills the frontier.
- **Fix:** https://github.com/felipearos/loggd/issues/2818
- **Seen again:** 2026-10-09
- **Seen again:** 2026-10-15
- **Seen again:** 2026-11-10

### The idle night: parked PRs and their root causes (2026-09-30)
- **Seen:** 3 draft (parked) PRs (#1877, #1885, #1886) held the remaining
  staffing groups, so all 5 loops idled 6–8 h. The harness side is in
  `harness.md` ("Parked PRs starve the loops").
- **Causes, each different:**
  - a deterministic bug on main: the hermetic TMDB stub has no genre-discover
    fixture (#1890);
  - confirmed cross-branch flakes (#1891–#1893);
  - one real rework: acceptance criteria unmet (#1611).
- **Unblocking:** #1869 is blocked by #1890; #1653 is blocked by #1891 and
  #1892. Both come back to their loops when the blockers merge.

### A red PR on infrastructure needs a human rebuild
- **Seen:** PR #1877, build #2747: Supabase Auth returned HTTP 502 ×239 during
  host overload. I rebuilt it as build #2760 with `BUILDKITE_OPERATOR_TOKEN`;
  it failed again on flakes. The harness fix is ralph #161.

### CI is sensitive to host load
- **Seen:** full suites time out at load of about 40 on 16 cores. ralph's own
  suite is fixed (#192); loggd's isn't.

## Fixed: kept for context





















| Problem | Fixed by |
| --- | --- |
| A migration's own comment can delete it from the PGlite replay | #2848 |
| `bun lint` dies of heap exhaustion on this host unless the Node heap is raised | #2850 |
| Mergify stops re-evaluating green PRs while GitHub webhooks are degraded | #2849 |
| Vercel posts its required commit status late, or not on the PR head | #2854 |
| Vercel stopped posting its required status on PRs | #2854 |
| Vercel never posts its required status on some PR heads | #2854 |
| Vercel posts no commit status on any PR, so nothing can be enqueued | #2854 |
| A migration PR is red on a test no targeted run touches: the classifier pin | #2888 |
| A new table cannot be classifier-safe: the RLS walk requires RLS in the create file | #3488 |
| Every PR is red on production-migrations while main's merged migration is unapplied to prod | #3492 |
| A mobile dev screening on the emulator cannot be run by a loop | #3524 |

## Host hygiene: check these first when loops go slow or red

- **Leaked E2E servers.** A `next start` on `.next-test` ran for 21 h at about
  90% CPU inside the `buildkite-agent` container.
  - **Find it:** its parent is the container's tini (PID 1); a live run's parent
    is `playwright test`.
  - **Kill it without sudo:** `docker exec buildkite-agent kill -9 <NSpid>`,
    taking the container pid from `/proc/<pid>/status`.
  - **Fixed at the source by** #1882.
- **Dead GitHub runners.** `gha-runner-loggd` and `gha-runner-loggd-2`
  (`~/loggd-runner`) crash-looped about 5,000 times with exit 127, missing
  `bin/Runner.Listener`, and each restart requested a GitHub token. I stopped
  them with `--restart=no`. `docker compose up` in `~/loggd-runner` brings them
  back broken; repair the image or delete the project.
