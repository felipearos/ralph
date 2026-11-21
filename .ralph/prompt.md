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
   Qodo Code Review reviews every PR on this repository. Its findings are
   numbered in one summary comment ("Code Review by Qodo"), each with a type
   (Bug, Rule violation, Requirement gap) and a severity (High, Medium,
   Low), and on this repository they do NOT arrive as review threads, so
   step 6's thread check never lists them. A green `test` is not a review
   either: Qodo takes from seconds to ten minutes. So before step 6:

   ```bash
   bun "$RALPH_HOME/qodo-review.ts" <pr>
   ```

   - **Exit 0**: a finished review covers the head with no open finding.
     Go on to step 6.
   - **Exit 1**: a finished review covers the head and lists its open
     findings (number, severity, type, title, link). Work them through the
     gate below.
   - **Exit 3**: still pending. Run it again; each call waits up to four
     minutes itself, and asks Qodo again with `/agentic_review` once per
     head when its run failed. Never comment `/agentic_review` yourself.
   - **Exit 4**: no finished review of the head within 30 minutes of the
     tool first seeing it. Do not merge: comment on the PR that the gate is
     not met and why, then hand the PR to a person as below.
   - **Exit 5**: unreadable; re-run once, then journal it and end with
     `<ralph>RETRY_LATER</ralph>`. **Exit 75**: journal it and end with
     `<ralph>RETRY_LATER</ralph>`.

   **The gate.** Read every listed finding against the code and the ticket's
   acceptance criteria (open its link for the description), then:
   - Fix every *valid* **High** or **Medium** finding, whatever its type, with
     a test where the change has behaviour to pin. A **Requirement gap**
     against one of the ticket's acceptance criteria is fixed at any
     severity: the criteria are the contract.
   - Leave **Low** findings unchanged unless the fix is one obvious line;
     list every Low finding for the operator under `### Low findings for the
     operator` in the merge comment (§5.7), each with its link and one line
     on why it was left.
   - A finding you judge wrong is a disagreement: change nothing, and give
     the evidence (the line, the test, or the criterion that shows it).
   - **Answer the review in one PR comment that starts with `@qodo `**, a
     line per finding by its number: `1. Fixed in <sha>: …`, `2. Not
     changed: <evidence>`, `3. Low, left for the operator: …`. Qodo reads
     only messages addressed to it. Write the body to a file and post it with
     `gh pr comment <pr> --body-file <file>`, two calls (§5.3). If a finding
     also arrived as a review thread, answer the thread the same way.
   - After a fix push, CI and Qodo both run again: hand the wait back with
     `<ralph>AWAIT_PR <pr> ci</ralph>`, then run `qodo-review.ts` and
     `review-threads.ts` on the new head. Merge when it exits 0, or exits 1
     listing only findings your latest `@qodo` comment already answered as
     Low or as a disagreement with evidence.
   - **Stall stop.** If a High or Medium finding is still listed after two
     fix rounds, or Qodo repeats a finding you disputed with evidence, the
     gate is not met: do not merge. Comment on the PR naming each unresolved
     finding and what you need from the operator, and hand the PR to a
     person as below.

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
