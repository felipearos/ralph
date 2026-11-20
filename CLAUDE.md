# Ralph — the harness for autonomous backlog loops

Ralph runs Claude Code iterations unattended, overnight, against the GitHub
issues of a project (today: loggd, and this repository itself). Nothing here
may hang, halt or lose a claim while nobody is watching: a missing or
malformed signal falls back to existing behaviour, never to a stuck loop.

## Commands

| Purpose | Command | Notes |
| --- | --- | --- |
| Install | `bun install --frozen-lockfile` | Bun >= 1.4 |
| Typecheck | `bun run typecheck` | root `tsconfig.json` plus `dashboard/ui` |
| Lint | `bun run lint` | oxlint; warnings are printed but do not fail it |
| Tests | `bun run test` | vitest, ~200 files, ~2.5 min on an idle host |
| One suite | `bun x vitest run <file>.test.ts` | |
| Dashboard | `bun dashboard/server.ts` | local, 127.0.0.1:8791 |
| Render a prompt | `bun models.ts --render-prompt prompt.md` | run from a project worktree |

CI (`.github/workflows/ci.yml`) runs typecheck, lint and test on a self-hosted
runner that is also the host of the live loops, so the suite must pass on a
loaded machine.

## Where things live

- `ralph.sh` — the supervisor (bash). One iteration is one `claude -p` session
  driven by `prompt.md`, with phases, control checkpoints and gates.
- `prompt.md`, `coder.md`, `inspector.md`, `prompts/*.md` — the harness prompts.
  `{{PROJECT_*}}` placeholders are filled from the project's `.ralph/*.md`
  fragments by `models.ts`.
- `models.ts` / `models.json` — which model and runner each stage uses.
- `roles.ts` — coder, triager, ci-doctor (`ci-doctor/`), pr-medic (`pr-medic/`).
- `frontier/next-tasks.ts`, `frontier-gate.ts` — pick the next ticket; the
  `--take-one` claim lock and `<loop>-wip` labels fence loops from each other.
- `claim-lease.ts`, `host-lease.ts`, `claim-race.ts` — leases and locks the
  loops on one host share (stored in git's common directory).
- `tracker/`, `tracker.ts` — the `Tracker` interface every issue read and write
  goes through (GitHub today; Linear and Jira per #330), its in-memory fake and
  shared contract suite, and the CLI bash and the prompts call instead of
  `gh issue`. Linear/Jira credentials live on the host, never in `.ralph/`.
- `reporter/` — the `Reporter` interface the sentinel (#678) reads error
  reporters through (Sentry today), shaped like `tracker/`: its in-memory fake,
  shared contract suite and the Sentry adapter, tested over an emulated API.
- `secrets/` — the `SecretSource` interface every named-secret read goes
  through (value, absent or unread; #759): the Doppler and environment
  sources, its in-memory fake and shared contract suite, and `read.ts`, the
  CLI `ralph.sh` calls.
- `gate-verdict-store.ts` — the per-loop record of the verdict a holding
  gate (coder, triager) waits on after an iteration refuted it (#771).
- `controls.ts`, `control-inbox.ts` — the operator command inbox.
- `speed.ts` — the per-loop claim-to-hand-off ledger and its report (#578).
- `loop-state.ts`, `observe.ts`, `timeline.ts`, `runner-failure.ts` — durable
  state, observation and diagnostics, read by the dashboard over a process
  boundary.
- `dashboard/` — the local operator page (Bun HTTP + React). It shells out to
  the CLIs above and never imports ralph TypeScript (`dashboard/read-only.test.ts`
  pins that). `dashboard/remote/` and `api/index.ts` are the Vercel-hosted
  remote dashboard.
- `publish-journal.ts`, `journal/`, `learnings/` — what every iteration
  records, pushed to this repository's `main`.
- `.ralph/` — this repository's own project config: ralph is a Ralph project.

Docs: `README.md` (operations, 2000+ lines), `dashboard/README.md`,
`lineup/README.md`, `adding-an-agent.md`, `journal/README.md`,
`learnings/README.md`, `incidents/`.

## Rules for changes

- Tests sit beside sources as `*.test.ts`. A file that spawns `bash`, `bun`,
  `git` or another process calls `subprocessSuite("<what it spawns>")` from
  `test-timeouts.ts` at the top. Never raise `testTimeout` in `vitest.config.ts`.
- No fixed sleeps where a predicate wait works; the worker count follows the
  host's free cores (`test-workers.ts`).
- Shared lifecycle changes need `end-to-end.test.ts`; prompt changes need
  `prompt-render.test.ts`, which renders against `fixtures/loggd/.ralph/`.
- Never write into this checkout's `.ralph/logs` from a test: a globalSetup
  guard (`test-ralph-logs.global.ts`) fails the run if `.ralph/` changes.
- Match the surrounding style: double quotes, two-space indent, comments that
  say WHY. A supervisor wait degrades on error; it does not throw.
- Permission rails (`claude-executor-settings.json`,
  `pr-medic/orchestrator-settings.json`) are probed, not read: after editing
  one, run `claude-executor-rails-probe.sh`.
- Commit subjects are `<area>: <what changed> (#issue)`, with a body that says
  why. PRs are squash-merged with `gh pr merge --squash`.
