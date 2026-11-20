# ralph learnings

Lessons from running Ralph on its own repository (self-hosting). See
`README.md` for how learnings are split.

## Open: fix these

### fixture-mirror goes red on every branch when loggd's .ralph/config.json changes (2026-11-05)
<!-- learning: loggd-fixture-mirror-drift -->
- **Seen:** loggd#2909 (senti + a sentinel block, 2026-11-05 13:36Z) turned `fixture-mirror.test.ts` red, and the pre-push hook refused the #696 push. `bun sync-fixtures.ts` alone then broke 30 tests in prompt-render, sentinel/gate, tracker/lifecycle, frontier-gate and end-to-end, which write their own roster over the fixture.
- **Workaround:** if PR #716 has not merged yet, rebase onto it. Otherwise run `bun sync-fixtures.ts`, then fix the suites that replace `loops`: drop a role block (ciDoctor, prMedic, sentinel) whose role the new roster lacks, and add a loop only if the fixture does not roster it already. Never push with RALPH_SKIP_PRE_PUSH.
- **Fix:** PR #716 refreshed the fixture for loggd#2909. The next loggd config change will cause the same drift: no issue yet.

## Fixed: kept for context



| Problem | Fixed by |
| --- | --- |
| Setup's `git add` refused ralph's gitignored `.ralph/` files | #181 |
| The setup PR had no required checks; `test` added by hand | #188 |
| The test suite timed out under load, so the pre-push hook was unusable, plus colour and teardown races | #192 (#187) |
| The test gate inherited the loop's `RALPH_*` identity | #198 |
| Suites wrote into the working checkout's `.ralph/logs`, which is the live loop's when ralph works on itself; every suite now gets a scratch project and a guard fails the run if `.ralph/` changes | #199 |
| codex-executor's index-rebuild test fails on a loaded host | #356 |
