# Launching both loops

Paste this as a prompt to bring ralph and rafa up from cold.

---

Bring both AFK loops up and watch them cheaply.

1. Refresh both worktrees to `origin/main` — `ralph.sh` refuses to start from
   one that is behind, and a stale checkout runs old code without saying so:
   - `/home/faros/loggd` (loop `ralph`): `git checkout main && git fetch origin && git merge --ff-only origin/main`
   - `/home/faros/loggd-rafa` (loop `rafa`): `git fetch origin && git checkout --detach origin/main`
   Never check `main` out in the rafa worktree — git then refuses every fetch
   in every worktree.

2. Check the preconditions in each. All four are silent until they fail:
   `ralph/.loop-name` (absent in loggd = ralph, `rafa` in loggd-rafa),
   Doppler scope (`doppler secrets --only-names >/dev/null`), `bun install`,
   and no `.env.local`.

3. Ask whether there is work at all, and for how many loops:
   `bun run next -- --dry-run` — count the independent trees under READY NOW.
   The frontier prints at most one ticket per tree, so N trees feed N loops;
   with one tree the second loop parks and does nothing, which is correct
   rather than broken. Prove each gate answers: `ralph/frontier-gate.ts --once`.

4. Start both gated, each from its own worktree, so an empty frontier is a
   wait rather than an exit:
   `RALPH_WAIT_FOR_WORK=300 nohup ralph/ralph.sh 50 >> ralph/logs/loop.stdout 2>&1 &`
   Confirm the identities in the first log line: `Ralph run ralph-run-…` and
   `Rafa run rafa-run-…`. If rafa says `Ralph`, stop it — both are about to
   claim under one label.

5. Monitor cheaply: tail both `ralph/logs/loop.stdout` with a filter for
   iteration boundaries, sigils, and gate lines. Do NOT poll `gh` or run
   `status.sh` on a timer — every poll costs API calls and tells you nothing a
   log line does not. Reserve `ralph/status.sh` for when I ask what is
   happening right now.

Report only: which loop took which ticket, any sigil that is not DONE, and
anything a human has to decide (a `*-blocked` label, a needs-migration draft).

---

## Stopping

    pkill -f 'ralph/ralph\.sh'    # after the current iteration
    pkill -f 'claude -p'          # also kill the iteration in flight (blunt)

A killed iteration leaves its `<loop>-wip` on the issue and a half-finished
branch. That is recoverable: the next iteration resumes it under §1 priority 1.
