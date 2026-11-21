The operator has granted this loop permission to merge its own PRs when the
gates below pass.

<!-- ralph:section IMPLEMENT_ROUTING -->
Read `AGENTS.md` at the repository root before writing a brief: it names the
commands, where the supervisor, frontier, dashboard and roles live, and the
rules a change to the test suite must follow.

<!-- ralph:section VERIFY -->
Your local gate, in this order:

1. `bun x vitest run <paths>` for the suites that own what you touched
2. `bun run typecheck`
3. `bun run lint`
4. `bun run test` — the whole suite; it has to pass on a loaded host

Never create an env file to get a gate past validation; a gate that fails on
environment is a finding to report.

<!-- ralph:section CODEX -->
5. **Qodo's review of the head is a merge condition here: the quality gate.**
   Qodo Code Review reviews every PR on this repository. Its summary comment
   ("Code Review by Qodo") counts Bugs, Rule violations and Requirement gaps;
   each finding also arrives as an inline review thread with a severity
   (High, Medium or Low), which step 6's review-thread check lists. A green
   `test` is not a review: Qodo takes from seconds to ten minutes, and a loop
   that merged on CI alone merged code nobody had reviewed. So before step 6:

   ```bash
   bun "$RALPH_HOME/qodo-review.ts" <pr>
   ```

   - **Exit 0**: Qodo's finished review covers the head. Go on to step 6.
   - **Exit 3**: still pending. Run it again (each call waits up to four
     minutes itself; a failed Qodo run is asked again with
     `/agentic_review`, once per head). Never comment `/agentic_review`
     yourself.
   - **Exit 4**: no review of the head within 30 minutes of its commit. Do
     not merge. Comment on the PR that the gate is not met and why, then hand
     the PR to a person exactly as in "Handing the PR to a person" below.
   - **Exit 5**: unreadable; re-run once, then journal it and end with
     `<ralph>RETRY_LATER</ralph>`. **Exit 75**: journal it and end with
     `<ralph>RETRY_LATER</ralph>`.

   **The gate.** Read every Qodo finding against the code and the ticket's
   acceptance criteria, then:
   - Fix every *valid* **High** or **Medium** finding, whatever its type, with
     a test where the change has behaviour to pin. A **Requirement gap**
     against one of the ticket's acceptance criteria is fixed at any
     severity: the criteria are the contract.
   - Leave **Low** findings unchanged unless the fix is one obvious line; list
     every Low finding for the operator under `### Low findings for the
     operator` in the merge comment (§5.7), each with its link and one line
     on why it was left.
   - A finding you judge wrong is a disagreement: change nothing, and reply
     with the evidence (the line, the test, or the criterion that shows it).
   - **Every reply to a Qodo thread starts with `@qodo `** (`@qodo Fixed in
     <sha>: …` or `@qodo Not changed: …`). Qodo reads only messages addressed
     to it, so a reply without the prefix never reaches it, and its next
     review raises the same finding again.
   - After a fix push, CI and Qodo both run again: hand the wait back with
     `<ralph>AWAIT_PR <pr> ci</ralph>`, then run `qodo-review.ts` and
     `review-threads.ts` again on the new head.
   - **Stall stop.** If a High or Medium finding is still open after two fix
     rounds, or you and Qodo still disagree after your evidence reply and its
     answer, the gate is not met: do not merge. Comment on the PR naming each
     unresolved finding and what you need from the operator, and hand the PR
     to a person as below.

   **Handing the PR to a person** (gate not met): `bun "$RALPH_HOME/tracker.ts"
   handoff <n> --pr <pr-url>`, the token footer comment
   (`"$RALPH_HOME/usage.py" --step "handed off #<n>" --md`), then
   `gh pr edit <pr> --add-label $RALPH_LOOP_NAME-done` as the last remote
   write, detach to `origin/$RALPH_BASE_BRANCH`, journal, and end with
   `<ralph>DONE</ralph>`. The PR stays open for the operator.

<!-- ralph:section TRIAGER -->
This backlog is the harness itself. Read `AGENTS.md` at the repository root
before you judge a ticket: it names where the supervisor, the frontier, the
leases, the roles, the dashboard and the journal live, and the test rules a
change must follow. Many tickets here are filed by loops working OTHER projects
(a learning, an incident, a journal entry from loggd), so check the evidence a
ticket cites against the harness's `origin/main` before you call it ready: the
behaviour it describes may already be fixed.

<!-- ralph:section TRIAGER_DIFFICULTY -->
This project uses no difficulty labels: Jav is off and its block lists none
(`jav.ts --json` prints `labels: []`). Apply no `difficulty:*` label, and skip
the routing step and the "add the difficulty label" part of a ready verdict.

<!-- ralph:section TRIAGER_SPLIT -->
Here a ticket is oversize when the body has more than 8 acceptance-criteria
checkboxes, or when it changes three or more of these areas: the supervisor
(`ralph.sh` and its gates), the frontier and its claims and leases, the role
prompts (`prompt.md`, `prompts/*.md`), the dashboard (`dashboard/`), and
durable state (`loop-state.ts`, `observe.ts`, the journal). The frontier counts
web, mobile, api and db, which rarely match this repository, so judge the
areas yourself. Split along those areas in dependency order: the state or
module that changes first, then the supervisor or prompt that uses it, then the
dashboard that shows it. Each child names the file and the function it owns.

<!-- ralph:section TRIAGER_READINESS -->
Here, `ready-for-human` rather than `ready-for-agent` when the ticket needs any
of these, and say which in the comment:

- the operator's accounts or secrets: Vercel, Supabase, Doppler, Slack, Jira,
  a GitHub App, or a Buildkite token;
- host state outside the repository: systemd user units, the `~/ralph` deploy,
  `~/ralph/jav.json`, the self-hosted runner, or restarting live loops;
- an edit to another project's files, including `fixtures/loggd/.ralph`, which
  mirrors loggd's `origin/main` and is refreshed with `bun sync-fixtures.ts`
  after the loggd change merges, never edited by hand;
- an acceptance criterion measured on a live loop over hours or days (a shadow
  run, an overnight run), which no single iteration can observe;
- a design decision that neither the ticket's parent spec nor the README
  settles.

A change to a permission rail (`claude-executor-settings.json`,
`pr-medic/orchestrator-settings.json`) is ordinary work, provided the ticket
says the coder runs `claude-executor-rails-probe.sh` after it.
