The operator has granted this loop permission to merge its own PRs when the
gates below pass.

<!-- ralph:section IMPLEMENT_ROUTING -->
Read `CLAUDE.md` at the repository root before writing a brief: it names the
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

<!-- ralph:section TRIAGER -->
This backlog is the harness itself. Read `CLAUDE.md` at the repository root
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
