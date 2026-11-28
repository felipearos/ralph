# Harness learnings

Lessons about Ralph itself. They apply to every project. See `README.md` for
how learnings are split.

## Open: fix these

### An intended screenshot change parks the ticket: the read token can't fetch artifacts (2026-10-08)
<!-- learning: bk-read-token-no-artifacts -->
- **Seen:** loggd #2013 / PR #2182, 2026-10-06. Build 3191 failed only `show detail at 1280px` (`e2e/poster-sizing.spec.ts:324`) on a deliberate desktop layout change. The fix is to commit the run's `-actual.png` as the new baseline, but `RALPH_BUILDKITE_READ_TOKEN` carries only `read_builds` and `read_build_logs`. The artifacts API answers "Your access token doesn't have the read_artifacts scope", so rulo blocked the ticket for a human.
- **Workaround:** with `read_artifacts` on the token, list the build's artifacts (`GET /v2/organizations/<org>/pipelines/<pipeline>/builds/<n>/artifacts`), then fetch each one's `download_url` with the same bearer token. The Playwright report's `data/*.png` files are the expected, actual and diff images. Look at the diff before replacing the baseline. Without the scope, block and name the scope in the reason.
- **Fix:** the operator adds `read_artifacts` to the token in Doppler `loggd-web`/`dev`. It is one secret that every loggd loop reads: the coders (ralph, rafa, remo, rulo, testo), doc and medi. `bk-log.ts --check-token` now names any missing read scope in the supervisor's startup line, and the README and the preflight remedy list all three scopes. Once the scope is on the token, `bk-log.ts` should get an artifact mode so a loop doesn't need hand-written API calls.









### Staffing groups serialise whole specs
- **Seen:** each spec's children share one staffing group, so a single parked
  or slow PR holds back all its siblings. It happens on loggd and on ralph's
  own frontier.
- **Fix:** the triager's first job, adding `## Staffing group` sections to
  split independent children (spec #131).

### Onboarding: colour codes reach the problem list
- **Seen:** the onboarding problem list would show ANSI colour codes if the
  dashboard is started from a shell that exports `FORCE_COLOR`. The tests are
  now hermetic (#192), but production isn't.
- **Fix:** strip ANSI in `parseConfigProblems`, or unset the variable when the
  dashboard starts. No issue yet.

### The remote dashboard's command mechanism is unproven
- **Seen:** spec #165 relies on Supabase Realtime with a dedicated Auth user,
  which hasn't been tested live.
- **Fix:** #168 includes an opt-in live test. Run it before go-live (#176).

## Fixed: kept for context









































| Problem | Fixed by |
| --- | --- |
| Dashboard read the roster from the main checkout's working tree, a stale feature branch, and showed 4 loops instead of 5 | #190 (#183) |
| Add project could register the live harness `~/ralph`, and setup would switch its branch under the running loops | #191 (#182) |
| A project that isn't set up showed "Unavailable: HTTP 500" | #191 (#184) |
| Setup had no required-checks field and defaulted to `[]`, so loops would merge without CI | #191 (#185) |
| Check passed, then setup failed at `git add` on gitignored files; the rollback left a local `ralph-setup` branch; the push error showed only one line | #191 (#186) |
| Parked PRs starved the loops: a ticket parked on a flake was never unparked, and a coder's block was never cleared. (Still open as an idea: the gate reports "frontier is empty" rather than "work waiting on an operator"; see `backlog-starved-blocked-rollouts`.) | #155, #150 |
| A red PR on infrastructure needed a human rebuild | #161 |
| A loop that setup put on the roster got no worktree, and needed `mkdir .ralph/logs` by hand | #189 |
| The `.ralph` test guard fails the suite on a live operator control | #489 |
| Every learning's fix ticket fails to file because `findings.ts` combines `gh api --slurp` with `--jq` | #478 |
| An open PR on a parent spec does not fence the children a triager split out of it | #488 |
| A loop's claim label vanishes across a rate-limit restart while it keeps working the ticket | #494 |
| One learning gets two fix tickets, and the frontier hands the duplicate to a second loop | #496 |
| The frontier claims Jira tickets already closed as "Mergeado" | #675 |
| GitHub GraphQL refuses the loops while rate_limit still shows budget | #676 |
| The shared GitHub GraphQL quota runs out and the CI wait reads "unreadable" | #703 |
| server-handler.test.ts ownership case reds on a host running live loops | #758 |
| A comment whose body file is written in the same command is refused by the guard | #800 |
| One issue whose Staffing group section carries a trailing footer crashes the frontier for every loop | #326 |
| A measurement printed by a passing CI job can't be read by the loop | #258 |
| AWAIT_PR handed back the issue number, so the supervisor waited on a PR that does not exist | #832 |
| A loop's `*-wip` claim does not fence work done outside the loops | #834 |
| A project-scoped learning whose fix is a harness change becomes a ticket no project loop can land | #833 |
| Both loops are starved: the backlog is operator-blocked work | #835 |
| Every opencode runner refuses, and the cause is not always the same | #837 |
| Two loops race on the same parent-closure maintenance task | #838 |
| name-guard refuses a rebased branch's force-push over commits already on main | #44 |
| frontier tests read the host's real claim-lease store | #77 |

## Operator notes

- **Dashboard env.** Never export `RALPH_DASHBOARD_ROOTS` in a shell profile:
  it makes the project registry read-only. Removed from `~/.zshrc`.
- **Killing a process:** kill by exact pid. `pgrep -f "<pattern>"` also matches
  the shell running it.
- **agent-browser:** set the viewport to about 1280×1000, or `scrollintoview`
  first. A click below the fold silently does nothing.
- **Deploying the harness:** `~/ralph` only changes when pulled, so a bad merge
  can't break running loops until it's deployed. Dashboard-only changes need a
  dashboard restart, not a loop restart.
