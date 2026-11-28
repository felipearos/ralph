# Ralph dashboard — local operator page

A small local-only Bun HTTP server that presents the Ralph loops on one
page: durable loop status and worktree status per loop, token usage, and each
loop's recent journal entries, served from `GET /api/loops` as JSON and rendered
by a React shell at `GET /`. Each loop page also offers the loop controls —
start, pause, resume, stop, approve, deny, retry, abandon, release and
restart-to-apply — plus Stop now and the recovery that follows it: Resume work
and Release. Each loop page also carries the loop's **Notifications** — every
alert it raised, and whether each plugin and the ticket got it — and its
**History**: every command, Stop now and plugin repair, with its recorded
outcome.

Observation is **read-only by construction**. The guarantee is a closed list
of declared surfaces — `COMMAND_SURFACE` (`adapter.ts`), `JAV_SURFACE`
(`jav-adapter.ts`) and `INTAKE_SURFACE` (`intake-adapter.ts`) — pinned argv by
argv in `read-only.test.ts`, so a new surface fails the test by name. The
runtime reads are `loop-state status --json`, `observe --json`, `claim-lease
status --json`, `gh issue list --state open --json …` (or `tracker.ts list
--json` on a Linear or Jira project), `gh pr list --state open|merged --json
…`, `project-config --json`, `usage.py --json --no-record`, `timeline.ts
--json`, `runner-failure.ts status --json`, `frontier/next-tasks.ts --dry-run
--json`, `verifier/following.ts --json`, `sentinel/issues.ts --json`, and `git ls-tree` / `git cat-file
--batch` / `git show` / `git remote get-url origin` against the harness's
`origin/main`. Jav reads `jav.ts --json`, and its page has one write, `jav.ts
--save`, the only declared entry outside the read set; the intake page has two
reads, `clerk-intake.ts --json` and `clerk-intake.ts --metrics --json`. None of
those three adapters imports `node:child_process`: they run through the
executor (`executor.ts`), the one module on the read path that spawns. Beside them
the observation routes run `controls status --json` and tail the loops' own
logs for cost; they never start, stop, pause, claim, fetch, or write anything.

The operator's write paths are separate modules beside them. The loop controls
are `control-adapter.ts` (the loop's local command inbox and the durable
records), `dispatch.ts` (a pure, injectable layer that turns
`pause`/`resume`/`stop`/`approve`/`deny`/`retry`/`abandon`/`release` into one
command file in the loop's `.ralph/control/inbox/` and a recorded outcome), and `control-routes.ts` (the HTTP write
endpoint, a thin adapter over dispatch). Start and restart-to-apply are
`lifecycle-adapter.ts`, `lifecycle.ts` and `lifecycle-routes.ts` in the same
shape. The **lineup editor** (`../lineup/`), mounted under `/api/lineup*`, edits
`models.json` — which model runs which stage of a loop, on which harness —
through the editor's own validate-then-atomic-write path, and nothing else; each
loop page carries its form. The feed's read mark
(`records-adapter.ts`'s `markRead`, behind `POST /api/notifications/read`) is
the one write about a loop beside the observation reads: it records which
alerts the operator has seen, and nothing about the loop. The project registry
(`projects.ts`) writes only `projects.json`, outside every checkout. Onboarding
(`onboarding-adapter.ts`, `onboarding.ts`, `onboarding-routes.ts`, in the
lifecycle shape) clones a new project and opens its setup PR. The agent
paths (`agents-adapter.ts`, `agents.ts`, `agents-routes.ts`) add and delete an
agent's worktree and open the roster PR that follows, and unregister a project. They share the same extraction boundary: nothing
above the adapters imports ralph TypeScript. The server binds `127.0.0.1`, is
never deployed, and has no imports from `src/`. It answers only to loopback,
`*.ts.net` and the names in `RALPH_DASHBOARD_HOSTS`, and refuses a write whose
`Sec-Fetch-Site` or `Origin` says another origin sent it — the page has no
login, so request authenticity is the one check it can make. A client that
sends neither header (the bridge, `curl`) is let through, and a `GET` or `HEAD`
is never refused on that signal: the `Host` check is what stands between a
rebound name and a read. `bun lineup/server.ts` run on its own is not behind this gate.

It signals exactly one kind of process, for Stop now, under limits the code
enforces (`interrupt-adapter.ts`, pinned by `read-only.test.ts`). The target is
the process group named by `.ralph/logs/supervisor.pid` in a configured root, and
nothing is ever found by pattern. The pid must be alive, must be running
`ralph.sh`, and must work in that checkout. Its group must be led by it or by
its `start.sh` wrapper, and must not be the dashboard's own. Every refusal and
signal is recorded in the checkout's `.ralph/control/signals.jsonl` before
anything is sent. No other module sends a signal.

## Run it

```bash
bun ~/ralph/dashboard/server.ts
```

Then open <http://127.0.0.1:8791>. The server prints the address it bound,
including the port when one is chosen for you.

## Running as services

On the host, the dashboard and the remote-dashboard bridge run as **systemd
user services**, so neither depends on someone remembering to start it. The
units live in [`remote/systemd/`](remote/systemd/):

- `ralph-dashboard.service` runs the wrapper `~/.local/bin/ralph-dashboard`
  (the server on `127.0.0.1:8791` plus its `tailscale serve` mapping) from
  `~/ralph`, with `Restart=always`. Loops started from the dashboard do not
  live in its cgroup: `start.sh` runs each in a transient user scope of its
  own, `ralph-loop-<project>-<loop>.scope`, so an oomd kill or a
  `systemctl --user kill` of the dashboard leaves them running. It still uses
  `KillMode=process`, because on a host without `systemd-run --user` `start.sh`
  falls back to `nohup setsid`, those loops do sit in its cgroup, and a restart
  must not take them down.
- `ralph-bridge.service` runs `doppler run --scope ~/doppler-new-ws --project
  software-factory --config bridge -- bun ~/ralph/dashboard/remote/bridge.ts`.
  The `--scope` selects the CLI login for the Personal workspace, which holds
  `software-factory`; `~/ralph` itself resolves to another workspace's login. It requires the dashboard and starts
  after it, runs at `Nice=10` with `IOSchedulingClass=idle`, and is capped at
  `MemoryMax=512M`. Every secret comes from Doppler; the unit holds none.

The bridge pushes each snapshot key on a per-key cadence, fast while a project
is hot (a viewer, or a new approval or error) and slow while it is idle. While
a project is hot it also holds the local dashboard's change stream for that
project open (#724, #730) and reads a key the stream names on its next tick,
so a change reaches the hosted store within about 2 s; it still never reads a
key sooner than twice its last read time. The timers stay the fallback: a
stream that is refused or drops only makes the bridge slower, and it reopens
with backoff. Idle projects are never streamed.

**Install.** From the deployed checkout:

```bash
~/ralph/dashboard/remote/install-units.sh                  # both units
~/ralph/dashboard/remote/install-units.sh --dashboard-only # before the bridge exists
```

It copies the units into `~/.config/systemd/user` (`$XDG_CONFIG_HOME` if set),
runs `systemctl --user daemon-reload`, and prints the commands below without
running them. It is idempotent: rerun it after a pull that changes a unit file.

**Enable** (once, by the operator). A dashboard started by hand or with
`systemd-run` holds the port, or the unit name; stop it first:

```bash
systemctl --user stop ralph-dashboard.service
systemctl --user enable --now ralph-dashboard.service ralph-bridge.service
loginctl enable-linger "$USER"   # run without a login session, as the loops do
```

**Logs.**

```bash
journalctl --user -u ralph-dashboard -f
journalctl --user -u ralph-bridge -f
```

**Deploy.** Deploying `~/ralph` gains one step. After pulling it:

```bash
systemctl --user restart ralph-dashboard ralph-bridge
```

## Remote dashboard

The hosted copy of this dashboard (spec #165, go-live #176) is a Vercel app
that reads the snapshot the bridge pushes to Supabase and queues the commands
it sends back. It is live since 2026-11-10:

| Piece | Where |
| --- | --- |
| Web app | Vercel project `ralph-dashboard` (team `felipearosrs-projects`), <https://ralph-dashboard-chi.vercel.app>, region `gru1` |
| Store | Supabase project `ralph-dashboard` (org `felipe-personal`), `sa-east-1` |
| Bridge | `ralph-bridge.service` on the host (see "Running as services") |
| Secrets | Doppler project `software-factory` (Personal workspace): config `bridge` (the bridge's six values), `web` (`RALPH_WEB_DATABASE_URL`, copied into Vercel), `admin` (`RALPH_SUPABASE_OWNER_URL`, for schema changes only) |

**What must stay true.** Each of these was checked at go-live; recheck after
any change to the accounts:

- Vercel **Deployment Protection is Vercel Authentication on `all`**
  deployments. `all_except_custom_domains`, the default a new project gets,
  leaves the production `*.vercel.app` alias public, because Vercel counts
  that alias as one of the project's domains. Signed out, every URL must
  answer a 302 to `vercel.com/sso-api`. Protection Bypass for Automation
  stays off, so do not use `vercel curl` against it (it creates a bypass).
- Vercel holds only `RALPH_WEB_DATABASE_URL` and `RALPH_COMMAND_WAIT_MS=25000`,
  in Production. No Supabase key, no `service_role`, no owner URL. Previews get
  no database. Do not install the Supabase Vercel integration.
- One firewall rule: `POST /api/*` is rate-limited to 30 a minute per IP.
- Supabase: sign-ups disabled, Realtime `private_only` (the dashboard's
  "Allow public access" off), and schema `ralph` not among the Data API's
  exposed schemas. The only Auth user is `bridge@ralph.invalid`.
- 2FA on the Supabase, Vercel and Doppler accounts.

**Provisioning from nothing.** Create the Supabase project, apply
`remote/schema.sql`, create the Auth user `bridge@ralph.invalid` (email
confirmed), then apply `remote/roles.sql` with generated `web_password` and
`bridge_password` and that user's uuid as `bridge_uid`, all as the
`postgres` owner through the session pooler (`aws-0-sa-east-1`, port 5432,
user `postgres.<ref>`). `ralph_bridge` connects through the session pooler
(5432), `ralph_web` through the transaction pooler (6543), each as
`<role>.<ref>`. Store the values in Doppler as above. Then
`install-units.sh` and `systemctl --user enable --now ralph-bridge.service`.
Within a minute `ralph.bridge` shows the lease, `local: ok` and
`wake: realtime`, and `ralph.snapshot` holds rows for every project.

**Deploying the web app.** There is no Git integration: merging to `main`
deploys nothing. From a clean checkout of the commit, so no untracked local
file is uploaded:

```bash
git worktree add --detach /tmp/ralph-deploy origin/main && cd /tmp/ralph-deploy
vercel link --yes --project ralph-dashboard --scope felipearosrs-projects
vercel deploy --prod --yes --scope felipearosrs-projects
cd - && git worktree remove --force /tmp/ralph-deploy
```

The bridge deploys with `~/ralph`: restart it after a pull
(`systemctl --user restart ralph-dashboard ralph-bridge`).

**Kill switch.** Set `RALPH_BRIDGE_CONTROLS=off` in Doppler `software-factory/bridge` and
restart `ralph-bridge`: the page greys its controls and the bridge executes
nothing, while state keeps flowing. Stopping `ralph-bridge` takes the page
offline within 45 s.

**Rotating a password.** Generate the new one, `alter role … password …` as
the owner (or reset the Auth user's password in Supabase for the bridge's
login), update Doppler, then restart `ralph-bridge`. For `ralph_web` also
replace `RALPH_WEB_DATABASE_URL` in Vercel and redeploy.

**A paused project.** Supabase pauses a Free project after a week without
activity. The bridge's heartbeat keeps this one active; if it is ever paused
(the bridge logs connection errors and the page shows offline), restore it
from the Supabase dashboard, and the bridge recovers on its own.

**Plan limits.** Vercel Hobby is non-commercial. Move to Pro when a project
the dashboard drives does paid work, a second person needs access, or usage
passes 1 M invocations a month.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RALPH_DASHBOARD_PORT` | `8791` | TCP port. `0` asks the OS for an ephemeral port. |
| `RALPH_DASHBOARD_ROOTS` | unset: the [project registry](#projects) decides | Comma-separated **absolute** repo/checkout roots. When set, it overrides the registry for the run (read-only), one project per repo. It also seeds a missing registry; unset, a missing registry is seeded from the project the server is started from (`RALPH_PROJECT`, else the git toplevel of the cwd). |
| `RALPH_DASHBOARD_BUN` | the running Bun (or `bun`) | Bun executable used to invoke the ralph CLIs. |
| `RALPH_DASHBOARD_HOSTS` | unset: loopback and the tailnet only | Extra `Host` names to answer to, comma-separated. If the dashboard refuses your browser, its log names the `Host` to add — paste it in as printed, port and all — the port is ignored, so a name is allowed on whatever port the server bound. If a tailnet browser is refused after a deploy, set this in `remote/systemd/ralph-dashboard.service` and record the name here. |
| `RALPH_LINEUP_ROOTS` | the harness checkout (`RALPH_HOME`) | Comma-separated **absolute** checkout roots whose `models.json` the lineup editor edits. Point it at the harness the loops actually run from. |
| `RALPH_DASHBOARD_START` | `start.sh` in the harness | **Absolute** starter the start and restart routes run in a loop's checkout. |
| `RALPH_JOURNAL_DIR` | the project's `journal.dir` | Journal directory in the harness repo, as the loops honour it. |
| `RALPH_DASHBOARD_RECONCILE_MS` | `60000` | How often the [loop reconciler](#the-loop-reconciler-restarting-a-loop-whose-supervisor-died) passes over the registry's worktrees. **`0` switches it off** — no pass runs, not even the startup one, and a loop whose supervisor dies stays down; the log says so at startup. Set it for a second dashboard beside the live one, or for anything that boots the server without wanting it to start loops. Any other non-positive-integer value is logged and ignored. |
| `RALPH_MIGRATION_ALERT_SECONDS` | `3600` | How long a PR may carry `migration-applied` before the [migration watchdog](#the-migration-watchdog-paging-for-a-stalled-migration-applied-pr) raises one `migration-applied-stalled` alert. Not an off switch: `0` or any other non-positive-integer value is logged and falls back to the default. The watchdog runs on the reconciler's timer, so `RALPH_DASHBOARD_RECONCILE_MS=0` turns it off too. |
| `RALPH_DASHBOARD_RESTART_ATTEMPTS` | `3` | How many restart **attempts** the reconciler may make for one loop per hour. Attempts, not successes: a refused start counts, so a loop the start gate keeps refusing stops being re-attempted. |
| `RALPH_DASHBOARD_RETRY_SCHEDULE` | `5,15,45,60,60,60,60` | The gaps, in minutes, before each [retry](#the-loop-reconciler-restarting-a-loop-whose-supervisor-died) of a loop that stopped itself on a transient fault. One gap before each attempt, so its length is the attempt count. A malformed value (anything but comma-separated positive integers) is logged and falls back to the default. |

Example against a different host layout:

```bash
RALPH_DASHBOARD_ROOTS=/srv/loggd,/srv/loggd-rafa RALPH_DASHBOARD_PORT=9000 bun ~/ralph/dashboard/server.ts
```

The tool works from any working directory: roots are absolute, and the default
root is derived from the file's own location, never from `pwd`.

Snapshot reads overlap independent data sources and process up to four
worktrees at a time. Simultaneous panel, control, and usage requests share the
in-flight runtime snapshot, and each project's handler reuses its last
successful snapshot for `RUNTIME_REUSE_MS` (4 s, below the page's 5 s poll) from
when that read started, so `/api/controls` after `/api/loops` runs no second
`loop-state status` (#66). A write (any non-GET) drops the kept snapshot, the
change stream's recompute always reads fresh, and the preview turns reuse off
(`runtimeReuseMs: 0`). GitHub claim reads overlap local loop reads, and the frontier retains
its separate 60-second cache. Within each frontier refresh, the open-issue,
closed-issue, and open-PR censuses overlap; native blocker reads start as soon
as the open issues arrive, with the existing concurrency limit.

Each observer reconciles only its selected worktree from the Git registry and
reuses that worktree's timeline for presence, avoiding peer-log reads. Published
journal history uses one listing and one `git cat-file --batch` call for up to
200 entries. Reads stay bounded; an output-limit failure preserves complete
entries captured before the limit.

## Projects

The dashboard observes **projects**, listed in the registry at
`$XDG_CONFIG_HOME/ralph/projects.json` (default `~/.config/ralph/projects.json`)
as `[{ id, path, addedAt, source, worktrees? }]`. `worktrees` is the folder the
project's new agent worktrees are created in, as `<agent>-loop` (#693); absent,
they go in `~/orca/workspaces/<project>`. It is host-local, which is why it
lives here and never in `.ralph/config.json`. Every dashboard process on the machine
shares it; writes (`projects.ts`) take a lock file and commit by temp-file
rename, so concurrent writers never corrupt it. A project's id is its repo's
directory name: a linked worktree such as `~/.local/share/ralph/workspaces/loggd/ralph-loop`
belongs to `loggd`.

Every page lives under `/p/:project/…` and every API route under
`/api/p/:project/…`; an unknown project is a 404. Unscoped legacy URLs keep
working: a page (`/loops/rafa`, `/usage`, …) redirects into the first
registered project, and an API path (`/api/loops`, …) is answered as that
project's. `/` opens the project last used in this browser. The sidebar header
is the project switcher; its last item, **Add project**, opens a dialog with
two tabs:

- **Local** registers a git checkout by absolute path. A relative path, a
  missing or non-git directory, and a project already registered are refused
  with the reason. A second repo with the same directory name gets `<name>-2`.
- **GitHub** lists repos with `gh repo list`, or takes a pasted `owner/name`,
  and clones with `gh repo clone` into `~/<name>`. If that directory exists it
  clones nothing and offers to register the existing checkout as a local
  project instead. After the clone it is exactly a local add.

Adding projects does not multiply the dashboard's cost. Only the project the
page shows gets the **full snapshot** (`gh` issues, frontier, claims, usage
tails, timeline), on the page's 5-second poll. Every other project gets a
**health read** (`health.ts`): the adapter's local read (`loop-state status
--json` and the cached `project-config --json`) and `controls status --json`
per roster checkout. It runs no `gh`, and each project is read at most once
every 30 seconds however often the page asks. It yields the switcher's health
dot — `needs-you`, `degraded` (a loop stale, orphaned or unknown, or its
control record unreadable), `running`, `idle`, or `unknown` when the project
cannot be read — and a **needs-you** count: loops awaiting approval, blocked
(an operator's own pause aside), or stopped on an error, each loop counted
once. The closed switcher shows the total across other projects. Each project
has its own adapter, so its frontier cache and its `gh` reads are its own:
switching back to a project is instant while its cache is warm.

The **Usage** page shows the selected project's loops' cost and tokens, and at
the top the account-wide plan meters, labelled **all projects**: the newest
rate-limit reading across every registered project's logs (each other project's
read at most every 30s), so a quiet project never reads as a healthy plan. The
harness records Codex tokens but no Codex plan limits, so the Codex meter says
there is no reading.

A project's **status** is derived on every read, never stored: `ready` once
`.ralph/config.json` is on `origin/<baseBranch>`, `setup-pending` while a PR
from `ralph-setup` is open, `needs-setup` when that PR list reads and finds
none. The base branch is the checkout's own config's, else a linked loop
worktree's config's, else the setup PR's base, else `origin/HEAD`: a
`dev`-based project whose main checkout sits behind its base reads ready with
no `gh` at all. A failed `gh pr list` is not `needs-setup`: `GET /api/setup`
answers 503 `ProjectStatusUnknown`, which is not cached, so the next read asks
again (#765). A project that is not ready fetches its base branch when read
(cached for 15s), so a merged setup PR turns it ready by itself. Start, Restart
and Resume work answer 409 `ProjectNotReady` until it is.

A project that is not ready shows setup in place of its agents: while it needs
setup, a form pre-filled from git (base branch, origin), `gh` (repo, login),
`package.json` scripts (`test`, `typecheck`, `lint`, run by the lockfile's
package manager), the repo name, secrets `none` and loops `["ralph"]`; while
the PR is open, a link to it. The form is validated by running
`project-config --json` against the candidate in a scratch root, and lists every
problem at once. Submitting refuses a dirty main checkout, and a `ralph-setup`
branch on origin that the dashboard did not push; one it did push (an attempt
whose `gh pr create` failed) is resumed by opening its PR. Otherwise it switches the main checkout to
`ralph-setup` from `origin/<baseBranch>`, writes the config and the prompt,
coder and plan templates from `examples/`, commits (without hooks: a fresh
clone has no dependencies installed), pushes, runs `gh pr create`, and switches
back. An attempt that fails before its commit unstages what it added and puts
every file back as it was, ignored files included.

## The intake page

`/p/:project/intake` is the clerk's intake page (felipearos/ralph#459). It
stands alone, with its own shadcn navbar and collapsible sidebar, in Spanish. The Slack canvas holds at most
`clerk.rowCap` rows a section, and links here on its `Ver todo el backlog:`
line once `clerk.dashboardUrl` is set. Each table pages its rows (10, 25, 50 or 100, 25 by default); a
filter change goes back to the first page, the minute's refresh does not.

- The navbar, filters and tabs remain visible while each table scrolls; its
  column headers stay pinned. The navbar offers **Claro**, **Oscuro** and
  **Sistema**, saving the choice in the browser and following system changes
  in Sistema mode. The sidebar switches between Tickets and Métricas and
  keeps the GitHub and Jira shortcuts at the bottom: the clerk's
  `prRepos` and its two Jira boards, read from config with each snapshot.
- **Tickets** has three tabs, each a sortable table with filters on status,
  app, difficulty and assignee kind. **Recientes** lists the rows the canvas
  shows. **Backlog** lists every open ticket. **Historial** lists the closed
  and moved tickets. The first column, **Seguimiento**, shows the furthest
  stage a report reached (PR, then the OA ticket, then the OAI ticket, then
  the Slack report) and opens a menu of every stage, oldest first, each
  linked and dated in Chile time. **Fecha** and **Hora** are the report's
  date and time in Chile; sorting either sorts by the whole timestamp.
  Long summaries end in an ellipsis and open in a full-text dialog. Priorities
  display in Spanish. Seguimiento's status glyph distinguishes draft, open,
  merged and closed PRs, plus work, review, blocked and paused states; a team
  blocker remains visible even when a PR is the furthest stage. Custom workflow
  names retain their text with an unknown-state icon. The separate Estado
  column is omitted; intake details remain in the Seguimiento menu.
- **Where the stages come from.** The Slack permalink and reporter are read
  off the ticket's `Reportado por … en Slack:` line. The OA key comes from
  the move's comment, else the sweep's record; a held move shows as
  `Pendiente de mover a OA`. The OA statuses are one Jira search per rebuild.
  The PRs are the newest of each `clerk.prRepos` repo (none when it names
  none), one `gh pr list` per repo, cached in
  `<loop>.pulls.json` beside the store for 15 min; a PR counts when its
  title, body or branch names the OAI or OA key. Open drafts are read from
  GitHub's `isDraft` field and appear as `borrador`. A failed read is a note in
  the gate's log and an emptier column, never a failed poll.
- **Métricas** has five tabs. Three summarise the reports by reporter, app and
  week: valuable vs noise, confirmation latency, override rate per field, and
  the top clerk-to-person changes. The fourth, participation, shows who
  reports and how lately. The fifth, **Precisión**, measures the clerk
  against its confirmers (`clerk/metrics.ts` `precision`): per field, the
  share of confirmed tickets left as proposed and the commonest changes; per
  week, the share confirmed with no change; and every correction (ticket,
  field, agent and person values, who, when), newest first. A ticket filed by
  hand had no proposal and is left out. It sits behind the same password.
- **Where the data comes from.** On every canvas rebuild, the clerk gate
  writes the tickets it read to `<git-common-dir>/ralph/clerk/<loop>.intake.json`.
  A live read covers only the open tickets and the last week's closed ones,
  so the file keeps what earlier rebuilds saw. `clerk-intake.ts --json`
  prints that file, and `--metrics --json` prints the `clerk-metrics.ts`
  rows. `intake-adapter.ts` runs both through the CLI read (`cli-read.ts`)
  over its injected executor, caches each for 30 s, and the bridge pushes
  them as the `intake` and `intake-metrics` snapshot keys. A read that fails
  or prints no JSON is an unavailable view with a Spanish reason, never an
  error.
- **Locally** there is no login, so the session answers `local`.
- **Remotely** the metrics are behind `RALPH_INTAKE_METRICS_PASSWORD`, checked
  in the function by `remote/intake-auth.ts`:
  - A right password gets a signed, HttpOnly session cookie that lasts 12 h.
  - A wrong one waits 1 s. After 10 wrong guesses in 15 min, that client gets
    a 429.
  - With the variable unset, the metrics are locked for everyone.
- **Who can open it.** The main remote deployment sits behind Vercel
  Authentication, so only the operator can open it there. For the team, a
  second Vercel project can serve the page alone:
  - Set `RALPH_REMOTE_SURFACE=intake`, which serves the intake routes and
    nothing else, and turn Vercel Authentication off. The build reads the
    same variable and flags the shell, so every page there but
    `/p/:project/intake` shows "Página no encontrada", never the loop
    dashboard. Changing it needs a redeploy, not just a restart.
  - Point its `RALPH_WEB_DATABASE_URL` at the `ralph_intake` role, which
    `remote/intake.sql` creates. That role reads only the two intake keys,
    through `ralph.intake_snapshot`.

## HTTP surface

Paths below are shown unscoped; each is also served under `/api/p/:project`.

- `GET /api/intake` — the intake page's tickets: `IntakeView`. Open.
- `GET /api/intake/metrics` — `IntakeMetricsView`. Remotely, it answers 403
  `MetricsLocked` with no password configured and 401 `Unauthorized` without
  a session.
- `GET /api/intake/session` — `{ access: "local" | "unlocked" | "locked" | "unconfigured" }`.
- `POST /api/intake/login` `{ password }`, `POST /api/intake/logout` — remote
  only. A login answers 200 with the session cookie, 401 `WrongPassword` or
  429 `RateLimited`.

- `GET /api/projects` — `{ projects: [{ id, path, addedAt, source }] }`, in
  registration order.
- `GET /api/projects/health?selected=<id>` — `{ selected, projects: [{ project,
  readAt, health, needsYou, needs: [{ loop, reason }], loops, running, problem
  }] }`: every registered project but `selected`, in registration order, from
  the local health read (no `gh`, cached 30s per project; while another
  project's page streams, that project's hub re-reads it on change and
  refreshes the cache, #729). `reason` is
  `approval`, `blocked` or `errored`. A project that cannot be read is
  `unknown` with its `problem`, never a failed response. Served at the top
  level, not per project.
- `POST /api/projects` — `{ source: "local", path }` or
  `{ source: "github", repo }`; 201 `{ project, status }`, or a refusal
  `{ error, message }` (`path` on `CloneTargetExists`). `status` is null when
  the project registered but its setup state could not be read.
- `GET /api/github/repos` — `{ repos: [{ nameWithOwner, description, isPrivate }] }`.
- `GET /api/setup` — `{ project, status, baseBranch, pr }`, or 503
  `ProjectStatusUnknown` while `gh` cannot list the setup PR.
- `GET /api/setup/defaults` — `{ project, config }`, the pre-filled candidate.
- `POST /api/setup/validate` — `{ config }` → `{ valid, problems }`.
- `POST /api/setup` — `{ config }` → `{ project, branch, files, pr: { url } }`;
  422 `InvalidConfig` with `problems`; 409 `NotNeedingSetup`, `CheckoutDirty`
  or `SetupBranchExists`; 502 `SetupFailed` with the failing command's reason.
- `POST /api/start`, `/api/restart`, `/api/resume-work` — 409 `ProjectNotReady`
  (with the project's `status`) until it is `ready`; 503 `ProjectStatusUnknown`
  when the status cannot be read.
- `POST /api/projects/remove` `{ project, confirm: true }` — unregister a
  project: `{ project, outcome: "removed" | "refused", why, running }`. Only
  the registry changes; the checkout, its worktrees and the GitHub repo are
  never touched. Refused while any of the project's supervisors is alive or
  cannot be seen (`running` lists them), and when `RALPH_DASHBOARD_ROOTS`
  makes the registry read-only. Served at the top level, not per project.

- `GET /api/claude-accounts` — `ClaudeAccountsView`: the host's registered
  Claude accounts (login, address, spent-limit time), the config directories
  found but not registered, and the rule and current account of the project
  and each loop. Local only; a CLI failure is a view with `problem`.
- `POST /api/claude-accounts` — one of `{ action: "add", name, dir }`,
  `{ action: "remove" | "clear-limit", name }`,
  `{ action: "assign", target: "*" | <loop>, use, onLimit }`,
  `{ action: "assign-env", target }`, `{ action: "unassign", target }` →
  `{ ok, message, view }`; 400 on a malformed body. Each runs one verb of
  `claude-account.ts`; the assignments are the host override loops read
  before their next iteration. Local only.

### Agents

- `GET /api/agents` — `{ project, baseBranch, pending, problem }`: the agents
  whose worktree exists but whose name the project's roster does not list yet
  — worktrees whose `.ralph/loop-name` is outside the main checkout's `loops`.
  Each is `pending-merge` until `origin/<baseBranch>` names it, then `ready`,
  with its roster PR (`gh pr list --head ralph-roster/add-<name>`). A `ready`
  agent whose supervisor is alive has been started and is left out, however
  stale the main checkout's branch is. Read-only:
  it never fetches, so the base branch is as last fetched — every running loop
  fetches each iteration, and a Start fetches first.
- `GET /api/labels` — `{ project, repo, labels, problems }`: every label the
  roster's loops need, from `preflight.ts --labels --loop <name> --role
  <role>` per loop plus `ready-for-agent` and `priority:urgent` for each coder
  (its frontier reads them; its preflight does not require them), each with
  the loops that need it (`usedBy`) and whether the repository has it
  (`onRepo`, from `gh label list`), then the repository's labels no loop
  needs (`usedBy: []`). `onRepo` is `null` when the repository's labels could
  not be read; `problems` also warns when `gh label list` returned its full
  200, since a label past them reads as missing. Read-only; the Labels page
  shows it, with the `gh label create` remedy beside a missing label. Not
  relayed by the remote dashboard.
- `GET /api/settings` — `{ project, checkout: { path, addedAt }, worktreesDir,
  worktreesDefault, defaultWorktreesDir, config, problems, worktrees,
  worktreesProblem }`: the Settings page's read-only overview (`settings.ts`).
  `worktreesDir` is the folder new agent worktrees go in, `worktreesDefault`
  whether the project names none of its own, and `defaultWorktreesDir` where
  they would go without one. `config` (repo, owner, base branch, display name,
  and the `gates` as `{ name, command }` and `requiredChecks`, in the config's
  order) is null when `.ralph/config.json` fails validation, and
  `problems` then lists every problem `project-config` named. Each worktree
  carries its branch, its loop (the one its loop record names, else its
  `loop-name`, as the dashboard attributes loops) and a `use`: `unowned` when
  the Reconciliation page lists it (orphaned, prunable or unattributed) or no
  roster loop owns it, `in-use` when its supervisor is alive or cannot be
  seen, `idle` when it is dead.
  `worktrees` is null, with `worktreesProblem`, when git or loop-state could
  not be read. Relayed as the `settings` snapshot.
- `GET /api/settings/prompts` — `{ fragments: [{ kind, path, text, missing,
  problem }], renders: [{ role, loop, prompt, error }], problems }`: the
  Settings page's read-only Prompts section (`settings-prompts.ts`). One
  fragment per path the config names (`promptFragment`, `coderFragment`,
  `plan`), read from the checkout holding the config; `missing` when the file
  is absent, `problem` when it cannot be read or resolves outside the
  checkout. One render per distinct roster role, as the first roster loop
  holding it, through `models.ts --render-prompt --role <role>`: exactly what
  the harness hands a session of that role. A missing fragment or a failed
  render is drawn, never a failed request. GET only. Relayed as the `prompts`
  snapshot, at the `config` cadence, so a hot relayed project spawns one
  render per role every 30 s.
- `POST /api/settings/gates/run` `{ gate }` — run one of the config's gates,
  by name (the command is read from the main checkout's config at request
  time, never taken from the request), as `bash -c` in that checkout
  (`gate-run.ts`), with the dashboard's own environment: not the loop's
  secrets runner, so a gate that needs those secrets fails here. Answers at once `{ run }` with the run `running`: a full
  test gate can outlast Bun's 255 s idle timeout, so no request waits on it.
  One run per project at a time; a second start is refused 409
  `GateRunInFlight` naming the running gate, never queued. Unknown gate 404
  `UnknownGate`, unreadable config 502. The run has a 20-minute limit; past
  it the gate's whole process group is killed and the run reads `timeout`,
  never `passed` or `failed`. A run settles shortly after the gate exits even
  when a process that left the group still holds its output open. `GET` on the same path answers `{ run }`: the
  run in flight, else the project's last one (kept in memory), else null,
  with state, exit code, duration and the last 40 lines of output, ANSI
  stripped. Both are local-only: the remote page lists the gates from the
  `settings` snapshot and shows Run disabled.
- `POST /api/settings/worktrees` `{ folder: string | null }` — set the
  project's agent worktrees folder in the project registry, or clear it back
  to the default with `null`, from the Settings page's Agent worktrees form.
  Answers `{ project, worktreesDir, worktreesDefault, defaultWorktreesDir }`.
  The registry refuses, as `409 WorktreesRefused` with its reason, a folder
  that is relative, cannot be created or written, sits inside any registered
  checkout (the project's own included) or is another project's folder, and
  any write while `RALPH_DASHBOARD_ROOTS` makes the registry read-only; a body
  without a string or null `folder` is a 400. Existing worktrees stay where
  they are: only Add agent and Create checkout after the change use it.
  Local-only, never relayed: a path only means something on this machine.
- `POST /api/settings/worktrees/cleanup` `{ paths: string[], confirm: true }`
  — remove git's registration of each listed worktree whose directory is gone
  (a stale registration makes `git worktree add` refuse that path), from the
  Settings page's Clean up worktrees control. Each path is judged on its own
  (`worktree-cleanup.ts`) and answers
  `{ project, outcome: "done" | "refused", pruned, skipped, why }`. It skips,
  with the reason, a registration git does not offer to prune (an orphaned,
  locked worktree is left for a hand, and every one is listed whether sent or
  not), one a loop runs in, one git does not report as prunable, and a sent
  path git no longer lists (`registered: false`, already out of the way). A
  registration nobody sent is neither touched nor listed, unless orphaned. A
  checkout on a volume that is not mounted reads as gone: `git worktree lock`
  it to keep it out of the cleanup. Local-only, never relayed: it changes
  this host's git.
- `POST /api/settings/project` `{ displayName?, baseBranch?, gates?, requiredChecks?, refuseFiles?, worktreeSetup? }` — propose the
  project's display name and/or base branch, from the Settings page's Edit
  form (the Worktree setup section sends `worktreeSetup` as complete steps,
  written to the config with its defaults left out; `[]` clears them). Only the keys that differ from `origin/<baseBranch>`'s config are
  proposed (an unchanged Save is refused "nothing to change"), validated by
  `project-config --set-project --at origin/<baseBranch>` (the values as JSON
  on stdin) before origin is asked anything; the commit is built and pushed as
  `ralph-roster/project-settings-<key>-<UTC stamp>` the way Add agent's roster
  PR is, `<key>` a hash of the changed values and the current base branch. A
  second Save of the same change against the same base while its PR is open
  links that PR (`reused`) and pushes nothing. A new base branch must exist on
  origin as exactly `refs/heads/<branch>` and carry a readable
  `.ralph/config.json`; when that config names another base, the PR body says
  it needs the same change. The PR targets the current base, and its body says
  to restart the loops after the merge (for a base-branch change: stop, check
  out the new base in each loop worktree, start).
  `{ outcome: "proposed" | "reused", pr } | { outcome: "refused" |
  "pr-failed", why }`; a refusal pushed nothing. Not relayed by the remote
  dashboard.
- `POST /api/agents` `{ name }` — Add agent. The name is checked against the
  roster rules by `project-config --add-loop <name> --at origin/<baseBranch>`
  after a fetch; then `git worktree add
  ~/.local/share/ralph/workspaces/<project>/<name>-loop origin/<baseBranch>` in the main
  checkout, `.ralph/loop-name` and `.ralph/logs` written, and a PR adding the
  name to `loops`. The path is only where a NEW agent goes: an existing loop is
  found through `git worktree list` and its `.ralph/loop-name`, wherever its
  worktree lives, so loops made under the old `~/orca/workspaces/` keep
  working until they are moved.
  The PR's commit is built on `origin/<baseBranch>` in a private index
  (`read-tree`, `hash-object`, `update-index`, `write-tree`, `commit-tree`)
  and pushed as `ralph-roster/add-<name>`, so no working tree is touched and
  nothing lands on the base branch. `{ name, worktree, outcome: "added" |
  "pr-failed" | "refused", status, pr, labels, setup, why }`; a refusal
  created nothing.
- `POST /api/agents/checkout` `{ name }` — Create checkout: the worktree for a
  loop `origin/<baseBranch>` ALREADY lists. The mirror of Add agent's roster
  test, and the answer to a project onboarded here, whose `loops` came from the
  setup PR: every one of those names is on the roster with no worktree, and Add
  agent refuses them for exactly that. It makes the same worktree Add agent
  makes — `git worktree add ~/.local/share/ralph/workspaces/<project>/<name>-loop
  origin/<baseBranch>`, `.ralph/loop-name`, `.ralph/logs` — and creates the
  labels the roster entry's ROLE declares, because `preflight`'s `loop-labels`
  check would otherwise deny the start. No branch is pushed and no PR opened.
  `{ name, worktree, outcome: "created" | "incomplete" | "refused", labels,
  setup, why }`; a refusal created nothing, and `incomplete` left a worktree that
  needs a hand. Both it and Add agent then run the project's `worktreeSetup`
  steps (`.ralph/config.json`, #694) in the new worktree, in order, each under
  its own limit through `gate-run.ts` (its whole process group is killed on a
  timeout), with `RALPH_MAIN_CHECKOUT` set to the main checkout. The first step
  that does not pass stops the rest, which are recorded `skipped`; the
  worktree is kept. The record, written to the worktree's
  `.ralph/logs/worktree-setup.json` (atomically) before the first step and
  after every step, comes back as `setup`
  on both answers (null when no steps are configured). A setup that did not
  pass makes Create checkout `incomplete`; Add agent still opens its roster PR
  and says in `why` that the setup needs a hand. With no steps, both behave
  exactly as before. Readiness step 9 reads an `installsDependencies` step's
  record instead of `node_modules`.
- `POST /api/agents/setup` `{ name }` — Rerun setup: the same steps again in
  `name`'s existing worktree. Refused, running nothing, when the config has no
  steps, when no worktree is `name`, for the main checkout, when its directory
  is gone, while its supervisor is alive or cannot be seen, and while a setup
  already runs there (one setup per worktree at a time, across requests). `{ name, worktree, outcome: "passed"
  | "failed" | "refused", setup, why }`. Local-only, never relayed.
- `POST /api/agents/delete` `{ name, confirm: true }` — Delete agent worktree.
  Refused while its supervisor is alive or cannot be seen (the `loop-state`
  read restart and Resume work use), while a worktree setup runs in it, and
  for the main checkout. Otherwise
  `git worktree remove <path>` — never `--force`, so git itself refuses a
  worktree with changes — and, when the base branch lists the name, a PR
  removing it (`ralph-roster/remove-<name>`).
- `POST /api/agents/start` `{ name }` — Start a pending agent. `POST
  /api/start` runs the same gate for a roster loop: a worktree whose own config
  names the loop starts as before; one that does not is refused (`outcome:
  "refused"`) until `origin/<baseBranch>` names it, after a fetch, and then its
  clean checkout is moved up to `origin/<baseBranch>` (`git checkout --detach`,
  only when clean and behind) so `ralph.sh` reads a roster that names it.
- `GET /api/agents/verifier` — `{ baseBranch, rostered, configured, rules,
  pending, configChanges }`: the verifier's rules as `origin/<baseBranch>`'s
  `verifier` block spells them (`project-config --json --at
  origin/<baseBranch>`, after a fetch; a key the block leaves out is absent,
  and the form shows its default), whether a roster loop has the verifier
  role, the open rules PR (head `ralph-roster/verifier-rules-*`), if any, and
  how a save lands (`commit` or `pr`, the config's `configChanges`). The
  Verifier sheet reads it. The open-PR lookup is a `gh pr list` (~3 s), so a
  successful answer is kept for a minute per process (#65); a save writes
  through (its own fresh check, and the PR it opens), so only a PR opened or
  closed outside the dashboard waits that minute out. An unreadable list is
  never kept and answers `pending: null`. With `?pending=skip` the lookup is
  not made at all and `pending` is `null`: the agent card's Off line reads it
  that way, on every cold load.
- `POST /api/agents/verifier` `{ rules }` — save new verifier rules.
  `project-config --set-verifier --at origin/<baseBranch>` (the rules as JSON
  on stdin) replaces only the block's rules (`enabled`, `windowHours`,
  `checkIns`, `trafficFloor`, `revert`, `follow`, `mode`), keeps its production URL,
  deploy source and Sentry project, and validates the whole file; the commit
  is built in a private index on the freshly fetched `origin/<baseBranch>`,
  as Add agent's roster commit is. Then (#787):
  - with `configChanges: "commit"` (the default), it is pushed straight to
    `refs/heads/<baseBranch>`. Its parent is the ref just fetched and the push
    is never forced, so it lands only as a fast-forward: if anything moved
    the branch meanwhile, git refuses it. Its subject names what changed
    (`ralph: verifier rules — mode observe → report`; with several changes,
    their keys) and its body lists every change. A save that changes no rule
    is refused rather than committed. If the push is refused for any reason
    — a protected branch, a non-fast-forward, the network — the same commit
    is pushed as a rules PR instead (below), and the answer carries why
    (`notCommitted`). A direct commit does not wait on an open rules PR; the
    fallback does.
  - with `configChanges: "pr"`, it is pushed as
    `ralph-roster/verifier-rules-<UTC stamp>` and proposed as a PR — a branch
    per proposal, so a merged PR's leftover head branch is no obstacle.
  One rules PR at a time: a PR, fallback or not, is refused while one is
  open.
  `{ outcome: "committed", commit: { branch, sha, subject } } | { outcome:
  "proposed", pr, notCommitted? } | { outcome: "refused" | "pr-failed", why }`;
  a refusal quotes the config validation's own sentence. The verifier reads a
  committed change on its next poll. Not relayed by the remote dashboard.
- `GET /api/agents/sentinel` — `{ baseBranch, rostered, configured, rules,
  pending, configChanges }`: the sentinel's rules as `origin/<baseBranch>`'s
  `sentinel` block spells them, whether a roster loop has the sentinel role,
  the open rules PR (head `ralph-roster/sentinel-rules-*`), if any, and how a
  save lands. The Sentinel sheet reads it; the open-PR lookup is cached and
  skippable (`?pending=skip`, the agent card's read) as for the verifier.
- `POST /api/agents/sentinel` `{ rules }` — save new sentinel rules, as the
  verifier's POST does: `project-config --set-sentinel --at origin/<baseBranch>`
  replaces only `enabled`, `lookbackHours`, `minEvents`, `minUsers`,
  `maxPerDay` and `mode`, keeps the block's `reporter` and `language`, and validates the whole
  file; the commit goes straight to the base branch (`ralph: sentinel rules —
  mode observe → file`) or, with `configChanges: "pr"` or a refused push, up
  as a rules PR. One rules PR at a time. Not relayed by the remote dashboard.
- `GET /api/sentinel` — the Sentinel panel: `{ rostered, rules, issues,
  problem }`, the checkout's sentinel rules with their defaults filled in and
  `sentinel/issues.ts --json`'s view of the issue store (each issue's state,
  counts, ticket, attempts and mode, the draft's title, and today's filed count
  against the cap and whether the cap alert went out). The CLI is not run when
  no loop is a sentinel; a store it cannot read is `problem`, never an error
  response. A snapshot, so the remote dashboard serves it too: the view carries
  no draft body and no reporter evidence.

- `GET /` — the shell. It fetches the JSON below and renders one card per
  loop, refreshing every 5 seconds — or, while the project's change stream
  (`/api/stream`, below) is open, at once on each change and otherwise only
  every 60 seconds. Its script and stylesheet are served under
  content-hashed paths next to it.
- `GET /loops/:name` — the shell again; the page routes client-side to that
  loop's detail view, so deep links and reloads work.
- `GET /api/loops` — the overview: `{ generatedAt, loops, reconciliation,
  unattributed, ownership, frontier, following, tracker }`, sent as compact
  JSON. `loops` carries exactly the project's roster (`loops` in its
  `.ralph/config.json`) in roster order, each with its `claims`; each
  `presence.recent` keeps only its newest 5 rows, with `recentTotal` the full
  count. The frontier carries no `tree` and no `prs`, and there is no
  `learnings` or `ciHealth` (#67).
- `GET /api/dashboard` — the full dashboard `/api/loops` is cut from, every
  field and every recent row; the remote bridge collects it as `dashboard`.
- `GET /api/loops/:name` — one loop's panel, or 404. The panel's `presence`
  carries the observer's full reading: issue history, per-stage agents, recent
  timeline activity, and the derived step, phase and warning that
  `observe.ts` paints in its own frame.
- `GET /api/usage` — reported cost and plan usage across the project's loops,
  tailed from the loops' own logs (`usage.ts`). Read-only; which worktree is
  which loop comes from the local read, so it runs no `gh`. `plan` is the
  newest reading in this project's logs; `account` is `{ scope:
  "all-projects", plan, projects, unread }`, the newest reading across every
  registered project (with the `project` that reported it), the projects read
  for it, and any that could not be read, with why.
  Each loop's Codex token breakdown combines live orchestrator events with
  ledger records from all stages, without counting checkpoints twice. Codex
  tokens have no reported dollar cost; a loop with no Codex records shows an
  explicit empty state.
- `GET /api/lineup?loop=`, `POST /api/lineup/preview`, `POST /api/lineup/edit`,
  `POST /api/lineup/save`, `GET /api/roots` — the lineup editor's routes,
  documented in [`../lineup/README.md`](../lineup/README.md). Each project's
  handler is pinned to that project's keys in `models.json`: it serves the
  project's view and a save writes back those keys and no others.
- `GET /api/jav`, `POST /api/jav/save` — Jav difficulty routing for the
  project (`../jav.ts`, reached by CLI through `jav-adapter.ts`, run with the
  project's `RALPH_PROJECT` and `RALPH_PROJECT_ID`). The read is a loud CLI
  read, so a failure is a `JavError`; the save runs the same injected
  executor with the candidate on stdin. The read returns
  `{ path, exists, project, own, config, problems, loops, reserved }`, where
  `config` is the project's block (else the `default` block, else off) and
  `loops` its roster. Save takes `{ config }`, the project's block, and
  `jav.ts --save` validates it against the project's roster before writing it
  under the project's key, leaving every other block as it was. A refused
  candidate gets a 400 `{ error: "JavInvalid", message, valid, problems }`
  with every problem, and the file is left untouched. The
  overview's **Routing** button is the form over both.
- `GET /api/sleep`, `POST /api/sleep` — the project's sleep: one marker in
  the repo's git common directory that every loop of the project reads at its
  iteration boundary. Asleep, each loop finishes its current iteration, then
  waits before the next until the project is woken. Both routes run the
  harness's `../project-sleep.ts` (`status`, `sleep` or `wake`, with `--json`)
  through `project-sleep-adapter.ts`, in the project's registered checkout
  with `RALPH_STATE_ROOT` set to it, and answer `{ asleep, since, why, by,
  problem }`. The POST takes `{ "asleep": true, "why"?: "<one line>" }` to
  sleep (sent with `--by dashboard`) or `{ "asleep": false }` to wake; both
  verbs are idempotent, so sleeping an asleep project keeps its first `since`
  and `why`. A malformed body is a 400 `ControlRequestError`; a CLI that
  failed or printed something unreadable is a 200 view with `problem` set,
  never a 500. Local only: the remote dashboard answers both with its 403 and
  the remote page shows no toggle. The top bar's **Sleep project** button
  asks for confirmation first; **Wake project** does not, and while asleep a
  strip under the top bar reads "Asleep since <time> — <why>".
- `POST /api/learnings/file` — files one learning as a ticket now. Takes
  `{ "slug": "<entry slug>", "scope": "project" | "harness" }` and runs the
  harness's `../findings.ts file <slug> --scope <scope>` through
  `learnings-file-adapter.ts`, in the project's registered checkout with
  `RALPH_JOURNAL_HOME` set to the harness checkout the page reads the
  learnings from. Answers `{ slug, url, problem }`: `url` is the ticket, null
  with no `problem` when the entry was published as queued instead. A refusal
  (a ticket already named, missing evidence, no such entry) is a `problem`,
  answered 200. Local only: the remote page shows no File ticket.
- `GET /api/controls` — every roster loop's control view from one runtime
  read, `{ loops: { <loop>: <control view> } }`, each view exactly what the
  per-loop route below answers. The overview's loop cards read this one route
  instead of one per loop (#615); the remote snapshot carries it as `controls`.
- `GET /api/loops/:name/control` — one loop's read-only control view, or 404
  for a name off the roster: `{ loop, generatedAt, present, worktree, run,
  loopStatus, status, channel, hold, blocked, stop, commands, pendingApprovals,
  gates, deferrals, givenUp }`. `gates` lists the gates armed before a named
  phase, `{ phase, since, why }`, in phase order. `status` leads with the most urgent recorded fact
  (`stopped`, `stop-pending`, `stop-unreachable`, `held`, `blocked`,
  `degraded`, `clear`, `unknown`). `channel.state` is `ok`, `no-record`,
  `degraded` (the record's degraded window, with `why` and `retryAt`) or
  `unreachable` (the record could not be read). A degraded or unreachable
  channel never produces a hold or a stop, and a stop's `confirmation` is the
  recorded one, so `unreachable` is never shown as `confirmed`.
- `GET /api/loops/:name/output` — the loop's live output, held open as
  server-sent events (`iteration-output.ts`), or 404 for a name off the
  roster. The source is the newest `.ralph/logs/iter-<ts>.log` in the loop's
  worktree, the formatted output `stream-render.py` writes, so the pane
  follows the loop into each new iteration and, with no loop running, shows
  the last one's tail. Each `data:` line is one JSON event: `reset` (`log`,
  `reason`) clears the pane, `append` (`text`) adds whole lines, and
  `withheld` (`reason`) ends the output. Every line passes through the
  harness's own `runner-failure.ts redact` filter, the `runner-signals.json`
  redaction notifications use; if the filter cannot redact (it reports on
  stderr, or exits early) the output is withheld, never shown raw, and the
  stream closes with a one-minute `retry:` so an open page recovers on its
  own once the pattern file is fixed. A missing
  or truncated log is a `reset` with a reason, not an error. The follower
  stats its log once a second, lists the directory every few seconds and
  reads only appended bytes; a closed page stops it and its filter. The
  route is GET only: nothing reaches the loop's terminal, and nothing is
  started but the filter.
- `GET /api/stream` — the project's change stream (#724,
  `snapshot-stream.ts`), held open as server-sent events: a `retry: 3000`
  hint, a `: keep-alive` comment every 20 seconds, and one
  `data: {"key":"<key>","version":N}` line per change, `N` rising on each
  line of one response. The key is the route-table key of the read that
  moved (#729): `dashboard` when the snapshot's hash moves, which also names
  `controls` and `agents`; `controls`, `control/<loop>` and `history/<loop>`
  when a file in a loop's `.ralph/control` (or its `inbox/`, `processed/`)
  or its `.ralph/logs/controls.json` changes; `notifications` for
  `notifications.jsonl` and the read marks; `history/<loop>` for
  `plugin-doctor.jsonl`; `agents` when the common dir's `worktrees/` or
  `FETCH_HEAD` moves. Those file keys need no recompute and go out on their
  own 250 ms debounce. `_/health` is another registered project's health
  moving: the stream also subscribes to every other project's hub for that
  key alone, which runs only that project's local health read (at most every
  5 seconds, never its dashboard read) and refreshes its 30-second cache.
  Projects registered after a stream opened join on the page's reconnect.
  It carries invalidations only, never a body: the
  page re-reads each read through its normal route. One hub per project
  serves every open page. It is made on the first stream and stops when the
  last one closes, and it closes, ending its streams, when the project leaves
  the registry (seen on the next request, or by the hub's own tick). The hub
  watches each loop's `.ralph/logs` (but not the iteration, session,
  executor and inspector logs a running loop streams), `.ralph/control`,
  `.ralph/control/inbox`, `.ralph/control/processed`, and the git common
  directory's `ralph*` stores, `ralph/` and `worktrees/`. It debounces a change by 250 ms and recomputes one at a
  time, at least a second apart, after any read already on the wire, so it
  never hashes the state from before the change. It also recomputes on a
  30-second tick for what no file shows (a dead supervisor, an expired
  lease, GitHub). An event goes out only when a hash of the snapshot, taken
  without its `generatedAt`/`readAt` at any depth, has moved. A directory it
  cannot watch is logged once and left to the tick, and a hub that cannot be
  made is a `503 StreamUnavailable`. The remote dashboard answers this route
  with one `event: unavailable` and a one-minute `retry:`, because it relays
  no stream. Its page does not open it: it long-polls the hosted
  `GET /api/versions?since=…` (#731, `ui/version-wait.ts`) for the same keys
  instead, and each key whose version moved refreshes that key's reads as a
  stream event would. If the wait fails, the page polls as before and tries
  the wait again later, backing off.
- `POST /api/chat` — `{ "loop": "ralph", "ticket": 252 }` (the ticket is
  optional) opens an **unblocker chat** (`chat.ts`, spec #251) with the agent
  that hit the block: `{ id, session, source, why }`. `session` is the session
  the chat will fork — for a halt, the one named by the iteration log in the
  loop's `stopReason`; for a ticket, the one behind the newest iteration log
  that records a block of it. Both are resolved through the SUPERVISOR log,
  `.ralph/logs/supervisor-<run>.log`, whose `=== <Loop> iteration N/M (<ts>)
  session <uuid> ===` header is the only place the id is written; an iteration
  that ran several sessions resolves to its last. `session` is null with a
  `why` when there is nothing to resume — no stop reason, no log that records
  the block, an iteration a non-claude runner orchestrated, or several runs
  that opened an iteration in the same second and so share one iteration log —
  and the chat then starts fresh. The runner is read from the lineup the
  iteration's OWN supervisor announced, bounded by the run banner above it: a
  supervisor log is appended to across restarts, and one on this host carries
  1,972 lineups. 404 for a loop off the roster, 409 for one with no
  checkout.
- `POST /api/chat/:id/turn` — `{ "text": "why are you blocked?" }`, answered
  **202**: a turn takes as long as a model does, and the answer arrives on the
  events stream. The first turn runs `claude --resume <session>
  --fork-session`, learns the fork's id from the stream's `system/init` event,
  and every later turn resumes the fork — so the loop's own session file is
  never written. The operator's text goes in on **stdin**, never the argv, so a
  message beginning with a dash is a message and not a flag.
  The **first turn is seeded** (`chat-seed.ts`, #253): a fenced
  `operator-chat` preamble goes in front of the operator's words, saying who
  is talking, that this is a fork (or a FRESH session, and why) and that
  nothing reaches the loop unless the operator hands it back, then quoting
  the newest block record on the ticket (the frontier's `stuckReasons`), the
  loop's `stopReason`, the iteration's journal entry (by the session fragment
  in its name, else the ticket's newest) and the last 80 lines of the
  iteration log (`iteration-output.ts`'s `readLogTail`). The whole seed goes
  through its own one-shot run of the same redactor, with the same fail-closed
  checks, BEFORE `claude` is started; a redactor that complains, drops or adds
  a line, or does not finish in 30 seconds withholds the chat and no turn
  runs. Every turn runs in **Ask mode** (`ASK_MODE` in `chat.ts`), and every
  layer of it was probed with `claude -p`:
  - `--tools Read,Grep,Glob,Bash` mounts nothing else.
  - The file tools are confined to two roots, the worktree (cwd) and
    `$RALPH_HOME` (`--add-dir`). There is no bare `Read` allow rule, so
    `dontAsk` refuses any path outside them.
  - `--allowedTools` is only the `gh issue view`, `gh pr view`,
    `gh pr checks`, `git log`, `git diff`, `git show` and
    `bun $RALPH_HOME/bk-log.ts` prefixes.
  - `--disallowedTools Edit,Write,NotebookEdit`.
  - `--settings` denies every `Read(...)` path in
    `claude-executor-settings.json` (read at run time; a turn is withheld if
    the file cannot be read), plus `.env*`, `~/.aws` and the other
    `CHAT_READ_DENY` paths. It also sets `blockReadsOutsideWorkingDirectories`
    and denies the shell commands that print file contents (`SHELL_READERS`:
    `cat`, `grep`, `rg`, `sed`, `git grep`, …). Claude Code auto-approves
    those as read-only, and `grep -r SECRET .` printed a denied `.env` before
    they were denied. It denies `--output` (`ASK_WRITE_FLAGS`) too: the
    allowlisted `git log --output=<file>` writes.
  - `--permission-mode dontAsk` with `--permission-prompts none` means
    anything else is denied in the stream (`permission_denied`) rather than
    left waiting on a prompt nobody can answer.
  - `--setting-sources ""` stops the loop worktree's own settings being
    loaded over it.

  A turn in **Fix mode** (#254) runs instead with the loop's claude
  executor's own rails, as `delegate.sh` gives them, and never more
  (`CHAT_COMMAND.fix`, `fixSettings`, `executorEnv` in `chat.ts`):
  - `--dangerously-skip-permissions --strict-mcp-config --setting-sources
    project`, the executor's flags. No `--tools`, `--allowedTools` or
    `--add-dir`: the executor gets none.
  - `--settings` denies everything `claude-executor-settings.json` denies
    (read at run time; a turn is withheld if it cannot be), so commits,
    pushes, `gh`, `curl`, migrations and the Agent tool are refused. It also
    keeps Ask's `CHAT_READ_DENY`, `SHELL_READERS` and
    `blockReadsOutsideWorkingDirectories`. The executor's rails deny no
    shell reader, so without them `grep -r SECRET .` would print a `.env` to
    the browser. Under the bypass those denies are tripwires, not a
    boundary. The boundaries are the executor's own: the cleared
    environment and the redactor.
  - `claude` runs with the executor's cleared environment: `PATH` led by
    `executor-guard/bin`, `HOME`, `TERM`, `LANG` and the `XDG_*`, `TMPDIR`,
    `CLAUDE_CONFIG_DIR` and `CODEX_HOME` passthroughs. Nothing else of the
    dashboard's reaches it.
  - The turn after a mode change tells the agent its new mode in a fenced
    `operator-chat` note (`modeNotice` in `chat-seed.ts`) ahead of the
    operator's words, because the seed said Ask.
  - **Every Fix turn is refused (409) while the loop's supervisor is alive**,
    checked again before each turn, not only at the switch.

  **Both modes run under Claude Code's OS sandbox** (`SANDBOX`,
  `sandboxSettings`, `sandboxEnv` in `chat.ts`; bubblewrap and socat). The
  deny lists above stay as the second layer, and the sandbox is what an
  interpreter's `open()` or a shell write meets. Each item below was probed
  with the real CLI, and `chat-sandbox.test.ts` repeats the probe when run
  with `RALPH_TEST_LIVE_CLAUDE=1`.
  - **Fails closed.** `failIfUnavailable: true` makes the CLI refuse to start
    without its sandbox, and the chat turns that refusal into a withheld chat
    ("the OS sandbox is unavailable"). It never runs the turn unsandboxed.
    `allowUnsandboxedCommands: false` ignores the model's
    `dangerouslyDisableSandbox` retry, and `autoAllowBashIfSandboxed: false`
    leaves approval with each mode's own rules.
  - **Reads.** `blockReadsOutsideWorkingDirectories` masks home directories
    and mounted volumes from sandboxed commands, but not `/tmp`, so `/tmp`,
    `/var/tmp`, `/dev/shm` and `/run/user` are denied as well. `allowRead`
    re-opens only these:
    - the worktree;
    - `$RALPH_HOME`;
    - the git dirs a linked worktree keeps outside itself, so `git log` works;
    - the chat's private temp dir, `/tmp/ralph-chat-<id>`, set through
      `CLAUDE_CODE_TMPDIR`. The CLI's shared temp root held other sessions'
      files, which were readable before this;
    - for Fix only, `~/.bun`.

    The `Read(...)` denies apply inside the sandbox too: `grep -r` and a
    `python3` read of `.env` both fail.
  - **Ask writes nothing** outside the private temp dir. The sandbox
    `denyWrite`s the harness, the git dirs and the worktree's `.git` pointer.
    It cannot deny the worktree root, because bwrap writes its mask files
    there and a read-only cwd fails every command, so writes in the worktree
    root are refused by `dontAsk` and `ASK_WRITE_FLAGS`. The network allowlist
    is empty. The ticket's three `gh` reads and `bk-log.ts` are
    `excludedCommands`: they run outside the sandbox, still only when the
    allowlist approves them, because `gh` needs its token file
    (`~/.config/gh`), which the sandbox rightly hides from everything else.
  - **Fix writes** only in the worktree, its own git dir (the index) and the
    private temp dir. Writes elsewhere under `/tmp` and to `~` fail. There is
    no network. `bun run typecheck` and a scoped `bunx vitest run` pass inside
    it in a linked worktree with its own `node_modules`, with `BUN_TMPDIR`
    pointed at the private temp dir.
  - `CLAUDE_CODE_SHELL=/bin/bash`, because the account's `$SHELL`
    (linuxbrew's zsh, under `/home`) is hidden by the home mask.
  - The per-chat temp dirs are left in `/tmp` (tmpfs, cleared at boot):
    the chat module deletes nothing.

  A turn whose `claude` never exits is killed after ten minutes rather
  than pinning the chat. 409 while a turn is still in flight, or once the
  chat is withheld.
- `POST /api/chat/:id/mode` — `{ "mode": "fix", "confirm": true }` switches
  the chat to Fix; `{ "mode": "ask" }` goes back to Ask at any time, with no
  confirmation and no check. Fix is **refused with 409 and the reason** while
  the loop's supervisor is alive (`SupervisorAlive`), when its liveness cannot
  be read (`SupervisorUnknown`: cannot tell is not stopped), and on a
  dashboard with no lifecycle adapters (`FixUnavailable`). Liveness is
  `chat-fix.ts`'s `fixGate`, the `loop-state status` read the lifecycle
  routes make (`lifecycle.ts readLiveness`). Its per-worktree answer is
  `supervisorPidMatches`, the check `controls.ts ownerLiveness` makes, so
  there is not a second liveness read. 400 without the `confirm`. A turn
  already in flight keeps the rails it started with. Answers the chat's view.
- `POST /api/chat/:id/stop-and-fix` — `{ "confirm": true, "why"? }` sends the
  ordinary soft stop through the control channel (`dispatch()`'s `stop` at
  iteration scope, what the Stop button sends) **exactly once**. It marks
  `stopping — waiting for the iteration boundary` on the chat's stream and
  waits for the supervisor to exit over the restart route's window
  (`DEFAULT_RESTART_WAIT_MS`, two minutes). Fix is switched on only once the
  supervisor has exited: `{ outcome: "fix", why, mode: "fix", stopping:
  false }`. A stop still pending at the deadline answers `outcome:
  "pending"`, says so on the stream, and leaves the chat in Ask. The chat
  holds the stop's key, so pressing again waits on the same stop and sends
  no second one. A loop already stopped switches at once and is sent
  nothing. `refused` (the stop was not delivered, or the loop recorded it
  refused) and `unknown` (liveness unreadable, so nothing was sent) leave
  Ask too. Nothing is signalled; Stop now stays the only route that does.
- `POST /api/chat/:id/handback` — **Unblock & resume** (#255,
  `chat-handback.ts`): the operator's decision lands where the loop reads it,
  and the loop starts again. Two calls:
  - `{ "draft": true }` runs **one bounded turn** asking the chat for an
    operator-decision summary in three parts — what was wrong, what was
    decided, what the loop should do next — and answers `{ draft }`. It is an
    ordinary turn on the chat's own session and mode rails (gated like a Fix
    turn when the chat is in Fix; it carries the seed if it is the first
    turn), plus `CHAT_DRAFT`'s bounds: `--max-turns 1 --max-budget-usd 1`
    after the mode's flags, killed after three minutes, the text cut at 4,000
    characters. The text is the redacted stream's `result`, else the
    assistant's text blocks. **502** `DraftFailed` with the CLI's reason
    (`error_max_turns`, a spent budget) when there is none; the operator
    writes the summary instead. 409 while a turn is in flight or once the chat
    is withheld.
  - `{ "summary": "…", "confirm": true }`, with the text the operator may have
    edited (at most 8,000 characters; 400 without `confirm` or `summary`),
    runs the sequence **in order, stopping at the first failure**, and
    answers `{ loop, outcome: "resumed" | "refused" | "failed", step, why,
    ticket, steps: [{ step, outcome, why }], dirty, checkout, restart }`:
    1. `worktree` — the checkout against its role's invariant, **before
       anything external**: nothing uncommitted outside `.ralph/` (the loop's
       own state, where the transcript and draft live) for every role; HEAD
       detached for a `clean-detached` role (`roles.ts`, the triager); HEAD on
       one of the loop's own `<loop>/…` branches, or detached, for a coder.
       Refused with the dirty paths in `dirty`. Skipped while the supervisor
       is alive: the checkout is then the running loop's own, and no Fix turn
       can have touched it.
    2. `comment` — `### Operator decision`, the summary, the transcript's path
       and a hidden `<!-- ralph:operator-decision chat=<id> -->` marker, on
       the chat's ticket (the one it was opened on, else the halted loop's
       own; `ticket` in `GET /api/chat/:id`).
    3. `label` — `<loop>-blocked` removed, when `gh issue view` shows it.
    4. `journal` — an entry (`**Outcome: unblocked by the operator.**`)
       drafted as `.ralph/logs/journal-draft-<stamp>-<n|none>-chat-<id>.md`
       and published by `publish-journal.ts`, with `RALPH_JOURNAL_HOME` set
       to the harness explicitly (`chat-handback-adapter.ts`).
    5. `restart` — `resume-work` when the record's stop is a Stop now, else
       `start`, through `lifecycle.ts`.

    A chat with no ticket skips 2 and 3 and still journals and starts.
    **Idempotent on retry**: the comment is not posted when the marker is
    already on the ticket, the label is removed only when present, the journal
    is skipped once the transcript records it `done` (and its draft keeps the
    first confirm's timestamp, so a lost answer re-publishes the same entry),
    and `start` is idempotent. One handback per chat at a time (409
    `HandbackInFlight`), and no turn runs during one. 409
    `HandbackUnavailable` on a dashboard with no lifecycle or handback
    adapters. Gated, like Start, on a ready project.

    The handback adapter owns its `Executor` (the server's 240 s one, long
    enough for the publisher's lock wait), behind `guarded()`, and answers
    with operations: `readIssue`, and `comment`, `unlabel` and `publish`,
    each `{ ok: true }` (`publish`'s also carries `said`, the publisher's
    last line) or `{ ok: false, why }` carrying the step's failure text. An executor that throws reads as that step's failure and the
    sequence stops there; nothing rejects out of the handback.
- `GET /api/chat/:id/events?after=<seq>` — the chat's stream, **long-polled**:
  it holds for up to 25 seconds and answers `{ events, next, status }` as soon
  as there is something newer than `after`. Events are `operator` (what was
  typed), `seed` (the redacted evidence preamble the first turn sent), `agent`
  (one redacted line of `claude`'s stream-json, its stderr
  marked `[stderr]`), `turn-end` and `withheld`, plus Fix mode's markers
  (#254), each carrying `mode`, the chat's mode once it has happened:
  `mode` (the chat switched; `text` says why), `fix-turn` (the next
  `operator` event's turn runs under the executor's rails, in the named
  worktree; emitted ahead of **every** Fix turn) and `stop` (Stop & fix's
  progress: the stop sent and the wait, a stop still pending at the
  deadline, a refusal, the supervisor's exit). Unblock & resume (#255)
  adds `handback`, carrying `step` (`draft`, `decision`, `worktree`,
  `comment`, `label`, `journal`, `restart`) and `outcome` (`asked`,
  `confirmed`, `done`, `already`, `skipped`, `refused`, `failed`); a
  `draft`/`done` event's text is the agent's summary and a
  `decision`/`confirmed` one's the summary the operator confirmed, and every
  other's says what the step did or why it stopped. The UI (#256,
  `ui/chat.tsx` over `ui/chat-model.ts`) draws `mode`, `stop`, `handback` and
  `withheld` as status lines and badges the turn after each `fix-turn`. Every byte has crossed the
  same `runner-failure.ts redact` filter the live pane uses, and fails closed
  the same way: stderr from the filter, the filter exiting, or a line count
  that does not match withholds the chat and stops the turn. The count is made
  complete by sending an end marker through the filter, so it waits on the
  filter's flush rather than racing it.
- `GET /api/chat/:id` — the chat and everything said in it: `session` (the one
  it forked FROM), `fork` (the one later turns resume, once announced),
  `mode` (`ask` or `fix`), `stopping` (a Stop & fix is waiting on the
  boundary), `ticket` (what a handback comments on, or null),
  `handingBack` (an Unblock & resume is running), `status`, the events, the path of its durable transcript
  (`.ralph/logs/chat-<id>.jsonl` in the loop's checkout) and
  `transcriptProblem` when an append to it failed.
- `DELETE /api/chat/:id` — end it and release what it holds; **204**.
- A chat lives in the dashboard's memory and the transcript is what survives a
  restart. Nothing accumulates unwatched: the redactor is started and stopped
  **with each turn**, so an idle chat holds no process at all, and a chat
  nobody has touched for an hour is dropped when the next one starts. One
  registry serves every project, so each chat is stamped with the project that
  started it and another project's scoped path cannot read it.
- `GET /api/loops/:name/notifications` — one loop's notification feed, read
  from its checkout's `.ralph/logs/notifications.jsonl` (`push-notification.ts`
  writes it): `{ loop, notifications, unread, readThrough, problem }`, newest
  first, at most 100. Each alert carries `kind`, `subject` and `body` (redacted
  by the loop through `runner-signals.json` before it was written, the same
  text a plugin and a ticket comment get), `priority`, `ticket`, `iteration`,
  `at`, `read`, and `deliveries`: one per plugin it was offered to, then the
  ticket comment when the ticket was eligible, each `delivered`, `failed`
  (answered, not delivered), `skipped` (never asked: backed off from, not
  installed; or a comment the cap or a lapsed claim stopped) or `unconfirmed`
  (no answer recorded), with `why`. An alert no plugin got is shown as such, not
  dropped. A feed with nothing in it says why in `problem`: `missing` (nothing
  raised yet), `unreadable`, or `no-checkout`. Always a 200 for a roster loop.
- `GET /api/notifications` — every loop's feed, `recent` (the newest 50 across
  them) and the total `unread`. The overview draws it as the **Notifications**
  panel.
- `POST /api/notifications/read` — `{ "loop": "ralph", "through": "<ISO time>" }`:
  every alert of that loop at or before `through` is read. The page sends the
  newest unread alert's time, so one raised meanwhile stays unread. The mark is
  `.ralph/control/notifications-read.json` in the loop's checkout; it only moves
  forward, and it records nothing but what the operator has seen. No
  confirmation. Client errors are the control route's kinds.
- `GET /api/loops/:name/history` — the loop's audit history, `{ loop,
  generatedAt, entries, problems }`, newest first, at most 100. Entries are
  `command`s (the inbox's pending files and its settled ones beside their
  outcome files: `applied`, `refused`, `replayed`, `needs-reconfirmation`,
  `not-for-this-loop`, or `pending`), `signal`s (each Stop now from
  `.ralph/control/signals.jsonl`: `interrupted`, `refused` with the
  `failedCheck`, `needs-reconfirmation` when it named a replaced run,
  `survived`, or `pending` when it signalled and recorded no
  ending, with the `signals` sent) and `repair`s (each repair and Fix all from
  `.ralph/logs/plugin-doctor.jsonl`; diagnoses stay in the Fix panel). Each
  carries `detail` — the recorded answer, so a refusal says why: the lease that
  has not expired, the run that replaced the one it named, the check that failed
  — and `reason`, the operator's own, with `run`, `via` and `issue`. A record
  that is missing or unreadable adds a `problem` for its source and nothing
  else; the others still count.
- `GET /api/ownership` — the machine-wide ownership map on its own.
- `GET /api/frontier` — the project's backlog as the loops' frontier buckets
  it (`frontier/next-tasks.ts --dry-run --json`, run from the first root):
  `{ readAt, view, problem, failedAt }`. `view` carries `ready` (one staffing group per
  entry, with its spec and the ticket it offers), `occupied`, `specs`,
  `inFlight` (with the claiming `loop` when a `-wip` label names one),
  `blocked` (with `blockers`), `gates`, `stuck`, `stuckReasons`, `untriaged`
  and `triage`; it is
  null with a `problem` when the tracker could not be read and no read ever
  had. A refresh that fails after a good one serves that last census again:
  `readAt` stays its time, `problem` says why the refresh failed and
  `failedAt` when, and the Backlog panel marks it stale. The census runs with
  `RALPH_FRONTIER_RATE_LIMIT_BUDGET_SECONDS=0`, so a GitHub throttle fails at
  once with its reason instead of sleeping past the adapter's timeout; the
  TTL retries it. `untriaged` lists
  the ready tickets carrying none of the project's Jav labels, which no loop
  takes while routing is on — a second view of tickets already in `ready` or
  `occupied`, not a bucket of its own, and empty when the project configures no
  Jav labels. `triage` is one count per triager intake bucket (`staffing`,
  `routing`, `intake`, `oversize`); the intake hands over only the first
  non-empty one, so a count behind it is backlog nobody is stuck on, and
  `routing` is `untriaged` after the triager's eligibility fence so it is never
  larger. A missing bucket is a contract error, never a zero. `stuckReasons`
  has one entry per ticket carrying a `<loop>-blocked` label: `kind` is
  `migration` (the code is done and a person must apply a migration),
  `other`, or `unknown` (no block record on the ticket, or its comments could
  not be read), with the loop's `reason`, the `pr` and the `migration` file
  it names. `block-reason.ts` reads them from the ticket's comments, one
  `gh issue view` per stuck ticket. Each entry also carries `park` (#776/#777):
  the wake condition a loop parked the ticket on, its `summary`, `budgetUntil`
  and whether it has `expired` or been escalated, or `null` when no park names
  the ticket (a frontier older than #776 sends no field, which reads as `null`).
  The read is one tracker census, so the
  adapter serves it from a 60-second cache and `readAt` says how old the
  picture is. The overview draws it as the **Backlog** panel, in four groups:
  tickets under a live park ("parked: waiting for …" with the budget left — a
  model-free probe watches them, so nobody here acts yet), migration blocks,
  blocks waiting on the ci-doctor (`kind: "ci-flake"` — the
  doctor unparks those itself, so nobody here acts on them), and everything
  else, which is the only group headed "needs triage". A park is live until it
  expires, is escalated, or its budget passes the snapshot's own clock; a
  spent park is a person's again, so it falls back to the migration group or
  to "needs triage", is listed under For you, and asks in the overview's needs
  you list under "park ran out", naming the condition that never held. A live
  park keeps a ticket out of both lists whatever its block reason says.
- On a project whose roster names a verifier, the snapshot also carries
  `following` — `{ readAt, view, problem }`, the verifier's watch store as
  `verifier/following.ts --json` prints it (#569), on the frontier's TTL. A
  missing store is an empty `view.watches`; an unreadable store, a failed run
  or output this dashboard does not know is `view: null` with the reason in
  `problem`, never an error for the snapshot. The project page draws it as the
  **Following** panel: watches in progress with their next check-in, finished
  verdicts (with what the watch's mode did to them), what observe mode held
  back, and the criteria marked not verifiable live. Without a verifier the
  field is absent and the CLI never runs.
- The snapshot also carries `ciHealth` — `{ readAt, view, problem }`, the
  ci-doctor's store as the dashboard reads it. Its source is three filesystem
  reads and no API call: the checkout's `.git` for the git common directory,
  `.ralph/config.json` for `ciDoctor.retry.perDay`, and
  `<git-common-dir>/ralph/ci-health.json` itself. `view` carries `main`
  (`state`, `since`, `build`, with the last two `null` on the `unknown` shape
  the classifier writes), `cases` (every case but the parked and the infra
  ones, worst first by the store's own `mainReds×3 + dequeues×2 + redBuilds`),
  `incidents` (the OPEN infra cases — `fixed` and `retired` are history and are
  left out of a list headed "open"), `parked` (one per `parked:<issue>` case,
  with its unpark history newest first), `retries` (`day`, `count`, `cap` and
  `today`, which says whether the count's day is the read's — the store carries
  one day and rolls it over lazily), `reverts` (open first; the store records no
  timestamp, so "recent" cannot be expressed and is not claimed), `lostTime`,
  `metrics`, `waits`, and `held` — every case an unexpired lease holds,
  whatever list draws it.
  `held` is a flat list on purpose: a parked ticket IS leasable
  (`ci-doctor/gate.ts` returns `parked:<issue>` as a work verdict) but is drawn
  in `parked` rather than in `cases`, so a reader asking what a doctor is
  working on must not depend on which list its case landed in.
  `view` is NOT null for a missing store: an absent, truncated or
  wrong-version store folds to an EMPTY view, because the store is a cache the
  next scan rebuilds and a project whose doctor has never run has nothing to
  report. `view` is null only when the checkout's `.git` could not be read at
  all, and `problem` then says so. The overview draws it on its own **CI health**
  page (`/ci`), which says so in place of the panel on a project that staffs
  no ci-doctor.
  `lostTime.minutes` is an ESTIMATE from median red-BUILD wall time, not the
  per-job time it stands for: nothing in the store persists a job duration, so
  every surface that prints it says so.
  `metrics` is the ci-doctor's own success measure as a 14-day trend
  (felipearos/ralph#163): one entry per UTC day, oldest first and ending on the
  day of the read, each with `knownFlakeReds` (red builds whose failing tests
  were all known flakes) and `parkedOnFlake` (the day's highest count of coder
  tickets parked on a flake). The series is zero-filled rather than sparse —
  `ci-doctor/scan.ts` writes a day only when it counted something, and a chart
  with holes reads as missing data when it means nothing went wrong — so
  `recorded` carries the "the doctor has never run here" the zeros erase. Both
  counters are running MAXIMA, not tallies: the scan recomputes them from a
  72-hour window of evidence but the store keeps 30 days, so assigning would
  zero out a day the window has moved past. `CI_METRICS_TREND_DAYS` is fenced
  at or below that retention by `dashboard/contract-parity.test.ts`.
  `waits` is the median minutes one coder iteration spent waiting on CI and on
  the merge queue, over 24 hours and 7 days. It is read from the wait results
  under **every** configured root's `.ralph/logs` — `ralph.sh` redirects
  `pr-wait.ts`'s stdout into one `pr-wait-<iteration>-<round>.json` per round,
  and `merge-wait.ts` files its own in the same shape so an in-session queue
  wait is countable too — summed per iteration and per mode, then medianed
  across iterations. Filesystem reads only; no API call and no process. Three
  things it depends on, each fenced by a test: the `.jsonl` history beside the
  results holds the SAME records and is never read, the worktree is part of the
  iteration key because two supervisors can mint the same
  `<ts>-<pid>-<iteration>`, and the window comes from each file's mtime, since
  a `WaitResult` carries `elapsedSeconds` but no clock and the filename's stamp
  is local time. A median rather than a mean: one 25-minute timeout would move
  a mean further than the typical wait it describes. An absent `.ralph/logs` is
  no waits (a fresh checkout has none); `waits.unreadable` names only a
  directory that exists and still could not be listed, so a panel showing no
  waits can say whether nobody waited or nobody looked.
- `POST /api/control` — send one control. The body names the loop and action:

  ```json
  { "loop": "ralph", "action": "stop", "run": "run-1", "stopKind": "blocked", "why": "…", "confirm": true }
  ```

  `action` is one of `pause`, `resume`, `stop`, `approve`, `deny`,
  `arm-gate`, `disarm-gate`, `retry`, `abandon`, `release`, `retry-phase`; `run`, `why`, `id` (idempotency key) and `reconfirm`
  are optional, and `stopKind` applies only to `stop`. `scope` (`iteration`,
  the default, or `phase`) applies only to `pause` and `stop`: `phase` makes
  the command take effect at the loop's next phase boundary instead of its
  next iteration boundary. `retry-phase` runs the phase just finished again,
  and the loop accepts it only while held at a phase boundary. `arm-gate` and
  `disarm-gate` require `phase` (`select`, `implement`, `verify`, `review` or
  `finish`), the phase the gate holds the loop before, and no other action
  takes one. `abandon` and `release`
  require `issue`, the ticket whose claim they act on, and clear that
  ticket's phase ledger once they apply. No other action
  takes one. **`stop`, `abandon` and `release` require `"confirm": true`**; the
  server rejects them otherwise. When the loop's supervisor reads as `dead`,
  `retry`, `abandon` and `release` are applied at once: dispatch runs the
  loop's own `controls.ts poll` as an operator (not `--supervised`), as
  the run on record, with `RALPH_PLUGINS=` and `--only
  retry,abandon,release`, so the answer is the recorded one, nothing reaches
  a plugin, and any other command waiting in the inbox is left for the next
  supervisor. It does not poll when the control record belongs to a newer run
  than the loop state names. The poll runs under `flock -n` on
  `.ralph/logs/supervisor.lock` — the lock `start.sh` takes and its wrapper
  holds for the supervisor's life — and refuses on its own when the recorded
  owner is alive, so a supervisor `start.sh` launched after the page's
  liveness read is found rather than raced, and none can start mid-poll (a
  `ralph.sh` started by hand holds no lock; the owner check only narrows it) (`start.sh` waits up
  to two seconds for the lock). Either way the command stays in the inbox for
  that supervisor, and the answer says so. Every other command, and any command
  to a live or unknown supervisor, waits for the loop's own poll. The response is dispatch's result — `outcome` is `applied`,
  `refused`, `replayed`, `needs-reconfirmation`, `not-for-this-loop` or
  `deferred`, with `recorded`, `at` and the stop confirmation — always a 200.
  Client errors are distinct: `400 ControlRequestError` (malformed body, missing
  loop or action, unknown action or stop kind, a missing or misplaced `issue`),
  `400 ConfirmationRequired`,
  `404 UnknownLoop` (not in the roster), `409 LoopNotAddressable` (a roster
  loop with no checkout).
- `POST /api/doctor` — the **Fix** panel's route:

  ```json
  { "loop": "ralph", "action": "repair", "plugin": "orca", "check": "consumer", "repair": "rebind" }
  ```

  `action` is `diagnose` (the default), `repair` (with `plugin`, `check` and
  `repair`) or `fix-all` (with `plugin`). It runs the harness's
  `plugin-doctor.ts` in the loop's checkout, with `RALPH_PLUGINS` removed so the
  project's config says which plugins are on, and answers `{ loop, plugins,
  steps, stopped, history, problem }`: each enabled plugin's checks (status,
  detail and the repairs a failed one offers), the repair steps just taken,
  why Fix all stopped short, and the loop's recorded diagnoses and repairs.
  `plugins` is empty when no plugin is enabled, and the page then shows no
  panel. The `disable-plugin` repair edits the project's `.ralph/config.json`
  and **requires `"confirm": true`**. A POST even to diagnose, because a
  diagnosis is recorded and asks the plugin's backend questions. Client errors
  are the control route's kinds. The page names no plugin backend and no verb:
  the checks, their words and their repairs all arrive in the answer.
- `POST /api/start` — `{ "loop": "ralph" }`. Runs `start.sh` at the loop's
  checkout through lifecycle dispatch. No confirmation: the response's
  `outcome` is `started` (with `pid`), `already-running` (the worktree lock's
  idempotent no-op; nothing is launched) or `failed`, with `why`.
- `POST /api/restart` — restart-to-apply:

  ```json
  { "loop": "ralph", "confirm": true, "stopKind": "blocked", "why": "…", "id": "restart-1" }
  ```

  **`restart` requires `"confirm": true`**; the server rejects it otherwise.
  `run` (defaults to the observed run), `why`, `stopKind` (default `blocked`),
  `reconfirm` and `id` are optional. The response is always a 200 carrying
  `outcome` (`started`, `already-running`, `failed`, or `halted` with `halt`:
  `stop-refused`, `stop-unreachable`, `stop-pending`, `supervisor-running`,
  `supervisor-unknown`), the stop `dispatch` sent, the stop `confirmation`
  (`confirmed`/`unreachable`/`pending`), the `start` report, and the
  `checkout` report. It answers only once the sequence ends, up to about two
  minutes; re-issue with the same `id` to keep waiting.
- `GET /api/loops/:name/checkout` — `{ loop, checkout }`, the read-only
  report of what a restart would leave in place: `branch`, `dirty` and
  `changes` (`git status --porcelain`), `claims` held for the worktree,
  `midTicket`, and `unpushed` — the commits on HEAD no remote-tracking ref has
  (`git log HEAD --not --remotes`, at most 50), or null when git could not say.
- `POST /api/stop-now` — the emergency stop:

  ```json
  { "loop": "ralph", "confirm": true, "why": "the model held a turn for 40 minutes", "run": "run-1", "id": "now-1" }
  ```

  **`stop-now` requires `"confirm": true`**; the server rejects it otherwise.
  `why` (the operator's reason), `run`, `reconfirm` and `id` are optional. A
  request naming a run the loop no longer holds is `needs-reconfirmation`
  before anything is looked at. Otherwise the target is checked in order —
  `pid-file`, `alive`, `ralph.sh`, `cwd`, `group` — and the first failure is
  `refused` with the mismatch named and nothing sent. A target that passes gets
  SIGTERM to its process group, then SIGKILL if anything is still there after
  ten seconds, a child that ignored SIGTERM included. SIGKILL goes only to a
  group still provably the loop's: the re-verified supervisor or the leader the
  check accepted (by start time) is alive, or the pid counter (`/proc/loadavg`'s
  last pid) has not wrapped since the check, which is the only way the number
  could be reused while the group has members. Members of a group it cannot
  vouch for are reported, not killed.
  Each signal is appended to
  `.ralph/control/signals.jsonl` before it is sent, and one that cannot be
  recorded is not sent. With the supervisor gone, the loop's own `controls.ts
  interrupted` records the stop, as the run on record, under
  `.ralph/logs/supervisor.lock` and with `RALPH_PLUGINS=`: `confirmed`, kind
  `interrupted`, with the iteration it cut short and the ticket the run holds.
  The claim is kept. The response is always a 200: `outcome` (`interrupted`,
  `refused`, `survived`, `needs-reconfirmation`, `not-for-this-loop`), `why`,
  `target` (`pidFile`, `pid`, `group`), `checks`, `signals`, `recorded`, the
  recorded `stop` and `audit` (the file's path).
- `POST /api/resume-work` — `{ "loop": "ralph" }`. Starts the loop again after
  Stop now, through `start.sh` in the same checkout with `RALPH_RESUME_WORK=1` and
  `RALPH_RESUME_ISSUE` naming the interrupted ticket. That makes `ralph.sh` leave
  HEAD where the iteration left it, so it never resets or fast-forwards to the
  base branch; the new run picks up the branch and reconnects that one ticket's
  claim, even a lease that lapsed meanwhile, as long as no other run has taken it.
  The request needs no confirmation. It is `refused`, with nothing started, while
  a supervisor is alive or its liveness cannot be seen, while the record holds a
  stop nobody confirmed, and when the stop on record is not a confirmed
  `interrupted` one (any other ending is a plain Start's). The response carries
  `outcome` (`started`, `already-running`, `failed`, `refused`,
  `not-for-this-loop`), `pid`, `why` and the `checkout` report.
- Start, restart, Stop now and Resume work answer client errors with the same
  kinds as `/api/control`.
- Everything else is 404; any other method is 405.

On the loop page, the header offers **Start** for a loop with no live
supervisor, and **Pause**, **Restart** and **Stop** for a live one. Stop and
restart are two-step confirms and send `"confirm": true` only from the
confirming click. Arming restart reads the checkout report and warns when the
checkout is dirty or mid-ticket; the warning says that commits, claims and
uncommitted work stay in the worktree. Resume appears for a pause hold, and
approve and deny only while the control view shows a pending approval hold.
**Retry** appears for a loop that stopped `failed` whose supervisor reads as
dead; it records the linked attempt, which runs when the loop is started. A
**Claims** notice lists each other run's expired claim with **Abandon…** (not
while the supervisor's liveness is unknown), and — once the supervisor is dead —
each of the run's own claims, lapsed or not, with **Release…**; both are
two-step confirms. **Stop now** sits beside Stop on a live loop. It is a
two-step confirm with a reason field, and the answer lists every check with the
signals sent. A loop stopped that way shows an **Interrupted** panel in place of
Start: the iteration and ticket, then the branch, uncommitted changes and
unpushed commits from the checkout report, with **Resume work** and
**Release #n…**. Every command names the run the page last observed; a `needs-reconfirmation`
result asks the operator to re-issue against the run that now holds the loop
instead of resending it. The last answer — the recorded outcome, the start
report, or restart's stop confirmation, start result or halt reason — is shown
beside the control view: a degraded or unreachable channel, a stop still
pending, deferred and given-up commands, and the recorded command history.

Beside them, **Notifications** lists the loop's alerts newest first — kind,
subject, ticket, iteration, time, the redacted body, and a chip per channel that
says whether it got it and why not — with **Mark read**. **History** lists what
operators did to the loop, newest first: each command, Stop now and plugin
repair with its outcome, the operator's reason, the recorded answer and, for a
refused Stop now, the check that failed. The overview's **Notifications** panel
shows the newest alerts across every loop. With no records, each panel says so;
a record that cannot be read is a sentence in its panel, never a failed page.

When a plugin is enabled for the project, the loop page shows a **Fix** panel
per plugin: its checks in order, whether each passed and what failed, a button
for each repair a failed check offers (turning the plugin off is a two-step
confirm), **Fix all**, **Re-check**, the answer to the last repair, and the
loop's repair history. With no plugin enabled there is no panel. The loop's
controls never go through a plugin, so they work whatever the panel says.

The overview adds claim chips and a runner-failure line to each loop card, the
machine-wide **Ownership** table (contested tickets are also counted in the
summary), and unattributed loop records under Reconciliation. The loop page adds
**Claims**, **Tokens**, **Journal** and **Control record** sections, shows a
recorded runner failure beside the stop reason, and falls back to the run's
`timeline` when observe's presence cannot be attributed to the loop.

A roster loop with no discoverable checkout is reported as `unknown`, not as a
healthy loop. Orphaned/prunable checkouts are reported under `reconciliation`,
never as loop panels.

Each loop panel also carries its live detail, read from that worktree's
`observe --json`:

- `actors[]` — every stage actor with `stage`, `state`
  (`running`/`completed`/`failed`/`degraded`/`unknown`), `runner`, `model`,
  `invocation`, `startedAt`/`endedAt`, `lastAction` and `activityAt`. A
  `running` actor whose supervisor is not alive reads `unknown`.
- `issue` and `issueTitle` — the title comes from the loop's own issue history
  when it records one, else from the `<loop>/<issue>-<slug>` branch; otherwise
  it is `null` (rendered as unknown).
- `branch` and `iteration` (`{ index, max }`).
- `presenceProblem` — `null` when observe's result belongs to this loop,
  `unavailable` when observe could not be run or read for the worktree, and
  `unattributed` when observe named a different loop (or `unknown`) for it. In
  both problem cases `actors` is empty and the panel says the actors are
  unknown; the rest of the response is unaffected.

`unattributed` at the top level lists worktrees whose loop record resolves to
no roster loop (a copied or moved record, an unreadable one, or an owner the
roster does not name), so such a loop is reported rather than silently dropped.

### Claims and ownership

A claim has two halves: the durable lease (`claim-lease status --json`, which
carries the expiry) and the `<loop>-wip` label on the open GitHub issue
(`gh issue list`). Each loop panel lists its claims with issue number, title
and expiry:

- `active` — a lease for that loop whose expiry is still in the future. This is
  the only way a claim renders as active.
- `expired` — the lease has lapsed. A lapsed lease is listed only while the
  loop's label or current run still points at it; leases are never deleted.
- `unknown` — a label with no lease for that loop, an unparseable expiry, or a
  lease store that could not be read.

`ownership.issues` maps every claimed or in-flight issue (a running loop's
current issue) to its owner. Exactly one contending loop — a non-expired claim,
or running on the issue — is the `owner`; two or more is `contested` and listed
in `ownership.contested`; only lapsed claims means no owner and `expired`.
`ownership.sources` says whether the lease store and GitHub could be read. A
source that could not run degrades to `unavailable`; a drifted shape is a 500.

Each loop panel also carries its token usage and recent journal entries, read
through the same adapter:

- `usage` — `{ session, runId, iteration, run, context }` from `usage.py --json`,
  token counts as raw integers (`input`, `output`, `cache5m`, `cache1h`,
  `cacheRead`, `inputTotal`). It is `null` — unknown, never zero — when the loop
  has no durable record, no recorded session (the `session <uuid>` detail of
  `iteration-start`, else the session the record keeps for the run), no
  transcript for that session, or when the report is for another run. `run` is
  `null` when the worktree has no `.ralph/logs/usage-ledger.tsv`, and
  `context.window`/`context.percent` are `null` for a model with an unknown
  window.
- `journal` — up to five entries the loop signed (`Loop: **name**`), newest
  first: `{ name, at, issue, loop, title, outcome }`. It is `null` when the
  journal cannot be read (no journal dir, no harness `origin/main`) and `[]`
  when the loop has no entries among the project's newest 100. Entries that
  sign no loop are shown on no panel.
- `triage` — the loop's intake activity, and `null` for any loop whose role
  gives the triage panel no meaning (`ROLE_PANELS[role].triage`, so today every
  role but `triager`). It carries `writesLastHour`, `maxWrites` and up to ten
  `units`. `writesLastHour` counts `result: "applied"` lines stamped inside the
  TRAILING hour across the worktree's `.ralph/logs/triage-apply-*.jsonl`, read
  straight off disk like the usage ledger and bounded by the window: a ledger is
  append-only, so one whose mtime is older than the hour is skipped unread. It
  is `0` for a triager that has applied nothing and `null` when a ledger could
  not be read — unknown, never a count that silently dropped a unit.
  `maxWrites` is `RALPH_TRIAGE_MAX_WRITES` **as this dashboard's environment has
  it**, which is the triager's only when both processes share one, and `null`
  when nothing configured it; it is a PER-PLAN cap, not an hourly budget, so it
  is shown as the scale a plan is measured on rather than as a limit the writes
  beside it approach. `units` are the newest ten journal entries the loop signed
  that carry an issue number and an outcome recording that something was applied
  (`all blocked` and `retry later` applied nothing; `gave up` leaves a marker
  comment, so it counts), one row per unit with the latest attempt winning.
- `case` — the ci-health case this loop's own UNEXPIRED lease holds, and what
  its card leads with where a coder's leads with its ticket. `null` three ways
  and the panel does not tell them apart: the loop's role gives the CI health
  panel no meaning (`ROLE_PANELS[role].ciHealth`, so today every role but
  `ci-doctor`); it is a doctor holding nothing; or the store was not read at
  all. The third is why a reader must not say "no case" on the strength of it —
  the snapshot's `ciHealth.problem` is where an unread store is reported.
  An expired lease holds nothing, so it reads as `null` rather than as the loop
  that let it lapse.

Each loop panel also carries its recent timeline activity and its runner-failure
reason, both read for the loop's recorded run:

- `timeline` — up to ten `{ stage, label, at, iteration, run }` activities from
  `timeline.ts --json --run <run>` (with `RALPH_TIMELINE_ROOT` set to the
  worktree), newest first. Labels arrive ANSI-free from the CLI; the GUI does no
  text parsing. It is `null` (unknown) when the timeline could not be read, no
  iteration event file matched the run (`exists: false`), or the loop has no
  recorded run. `[]` is a timeline with nothing in it yet.
- `runnerFailure` — `{ state, reason }` from `runner-failure.ts status --json
  --run <run>` (with `RALPH_PROJECT` set to the worktree). `failed` carries the
  newest settled observation for the run and loop as `reason`: `kind`, `stage`,
  `summary`, `evidence`, `runner`, `model`, `exitCode`, `issue`, `visibility`,
  `at`. `none` means the record was read and the run did not fail. `unknown`
  covers every other case: the record could not be read, the run is unknown, or
  the run failed (`loopStatus: failed` or a `failed` stop) but no runner failure
  is recorded. Set this beside `stopReason` to tell a provider outage from a
  model-level stop.

A timeline or failure read that cannot run degrades only that field. A drifted
shape (a `timeline` version other than 1, a malformed observation) is a 500.

## Architecture

The GUI is extractable from day one. It speaks to the Ralph runtime **across a
process/JSON boundary**, never by importing ralph TypeScript. Two pure helpers
are the exceptions, pinned by `read-only.test.ts`: `../paths` (where the
harness and project are) for the server, and `../project-id` (a project's id
from its checkout's `.git`) for the registry — the rule the loops key their
lineup and Jav blocks by, so the two cannot disagree. Neither runs loop code.

- `contracts.ts` — the dashboard's own typed view models, and nothing else.
- `adapter.ts` — **the only read-only code that names ralph commands, flags,
  environment variables or JSON shapes**, save the live pane's
  `iteration-output.ts`, which names only the iteration log and the redactor, the Fix panel's
  `doctor-adapter.ts`, which names only `plugin-doctor.ts` and its flags, and
  `records-adapter.ts`, which names only the files the feed and the history
  are read from (and writes only the feed's read mark). It invokes `loop-state status --json`
  once per configured root (with `RALPH_STATE_ROOT`), and per attributed loop
  worktree `observe --json` (with `RALPH_OBSERVER_ROOT`) and `usage.py --json
  --no-record` (in the worktree, with `RALPH_PROJECT`, `RALPH_RUN_ID` and
  `RALPH_SESSION_ID`). Once per root it resolves the journal dir
  (`RALPH_JOURNAL_DIR`, else `project-config --json`) and reads the newest
  entries from the harness checkout's `origin/main` with `git ls-tree` and one
  `git cat-file --batch`; it never fetches. It narrows and validates the JSON,
  and fails loudly via a contract/shape guard on drift. It reads the roster by
  running `project-config --json` against the project's root — the config the
  loops read it from — re-reading only when the file changes; a config that
  cannot be read is a `roster` contract error, never a guessed roster.
  Per root it also reads the lease store through `claim-lease status --json`
  (with `RALPH_STATE_ROOT`) and claim labels through one `gh issue list` run in
  the root checkout, resolving `<loop>-wip` to a loop name so nothing above it
  knows the label convention. It spawns nothing itself: every command above is
  a declared surface run through `cli-read.ts` over the injected executor.
- `control-adapter.ts` — the write-side sibling. It writes one command file,
  atomically, into the loop's `.ralph/control/inbox/` (the format is
  `../control-inbox.ts`'s; the directory ignores itself so it is never
  committed), and names no plugin — the controls work with no plugin
  enabled. It reads the loop's durable identity from `.ralph/logs/state.json`,
  and narrows `controls status --json`. For the recovery poll it runs
  `controls.ts poll --only
  retry,abandon,release` under `flock -n` on `.ralph/logs/supervisor.lock`.
  It names ralph's control surface and no caller above it does. It
  re-exports the executor port from `executor.ts` (below), including
  `guarded(executor)`, the one place a rejected call becomes
  `{ status: null, stdout: "", stderr: <message> }`; the lifecycle adapter,
  the chat handback adapter, agents and reconcile run their invocations
  through it rather than each catching on its own. The adapter takes its own `Executor` in its config
  and runs its read-backs through `guarded` too, so it answers with operations
  — `readControlRecord`, `readControlStatus`, `recoveryPoll`, `recordInterrupt`
  — that never reject, and dispatch, the control view and Stop now carry no
  try/catch of their own. The reconcile adapter likewise takes its own
  `Executor` in its config and answers with operations — `push`,
  `listMigrations`, `appliedAt` — that never reject, so the reconciler and the
  migration watchdog wrap none of those commands in a try/catch.
- `executor.ts` — the `Executor` port (`Invocation` in, `ExecResult` out),
  `guarded(executor)`, the one place a rejected call becomes
  `{ status: null, stdout: "", stderr: <message> }`, and
  `createProcessExecutor`, the one module that spawns for the adapters. It
  imports no adapter, so any of them can import it by value.
- `cli-read.ts` — the CLI read module: a read declared as a `CliSurface` (a
  command or a ralph script, its argv, its narrow) is run over an injected
  executor, parsed, narrowed and degraded by a named policy — `loud` (every
  failure throws), `unavailable` (a CLI that could not run degrades, drift
  throws) or `any` — with one TTL + in-flight cache on an injected clock. Every
  read of the runtime adapter goes through it (#608, #609), and so do the Jav
  read (`loud`) and the intake page's two reads (`any`, 30 s TTL) (#610), each naming its
  policy: loop state and the project config are `loud`; the frontier and the
  per-worktree and per-source reads (observe, claims, usage, timeline, runner
  failures, the journal) `unavailable`; the PR-status chips, the Following view
  and the learnings files `any`.
- `dispatch.ts` — a **pure layer over the control adapter** (which owns the executor): address the
  command to the loop's observed run, refuse a replaced run rather than
  redirect it, deliver, and read the recorded outcome back. It reimplements no
  idempotency or ownership logic; the loop's own `controls.ts poll` decides
  and records what happened, at the next iteration boundary — or, for `retry`,
  `abandon` and `release` to a loop whose supervisor is dead, at once, in a
  poll dispatch runs for it (one at a time per loop). The
  recording-executor unit tests and the real-poller integration tests
  (`dispatch-channel.test.ts`, with no plugin enabled) are its
  primary seam.
- `aggregate.ts` — a **pure function** of the adapter's typed view models plus a
  `Clock`. This is the primary test seam and the only place selection logic
  lives: which worktree is the loop, whose run a usage report belongs to, and
  which journal entries are the loop's.
- `control-view.ts` — the **read-only control view**. It composes the durable
  loop state from the runtime snapshot (`loop-state status --json`) with the
  control record read through `control-adapter.ts`'s status read
  (`controls status --json`, anchored at the loop's worktree), and projects
  the hold, blocked reason, stop, recent recorded outcomes, pending approvals,
  deferrals, given-up commands and degraded window. It never builds a send, and
  an unreadable record degrades the channel rather than failing the response.
- `command-requests.ts` — every relayed command's body parser, the request
  helpers and error class, and the dispatch vocabulary. It imports only
  `contracts.ts`, so the remote Vercel function calls the same parsers as the
  local routes (and `vercel.json` rebuilds the function when it changes).
- `control-routes.ts` — the write endpoint: validate the request (loop,
  action, `issue`'s type, the server-enforced confirmation for stop, abandon
  and release), resolve the loop to its
  checkout, call `dispatch`, serialize. No control logic and no CLI names.
- `chat.ts` — the unblocker chat's server half: `resolveSession` (pure over an
  injected IO: it reads a loop's own logs and nothing else) and
  `ChatSessions`, which runs the turns, pipes them through the live pane's
  redactor, and appends the transcript. It reaches no ralph module; the two
  processes it runs are `claude` and that redactor. `ASK_MODE`/`modeArgs`
  are the Ask-mode rails.
- `chat-seed.ts` — the first turn's evidence preamble: pure text in, text out.
  It reads nothing and redacts nothing; `chat.ts` does both.
- `chat-handback.ts` — Unblock & resume's sequence over the lifecycle module
  and `chat-handback-adapter.ts`, which is the one module naming its `gh`
  writes, the journal publisher and the draft it writes for it.
- `chat-routes.ts` — the chat endpoints: validate, call `ChatSessions`,
  serialize, and `evidenceOf` — the block record, ticket and journal off the
  dashboard snapshot the page is drawn from. Unknown project, loop and chat id
  are each refused by the mechanism that already owns them.
- `server.ts` — a thin HTTP adapter: parse the request, call the aggregation,
  the control view or the control route, serialize. No projection logic, no
  subprocess. Its `main()` only reads the environment, builds the shell and
  the real dependencies, serves, and schedules the reconcile pass.
- `compose.ts` — `composeServer(deps)`, the server's wiring (#624): every
  adapter, the per-project scopes, and the guarded reconcile and
  migration-watchdog passes. Its deps are the config, the registry, the shell,
  one Executor factory keyed by timeout, the RalphAdapter factory, and the
  factories that run no executor (records, chat runner, redactor, follower,
  usage, lineup handler, interrupt); every other adapter is built inside it
  from its real factory over that Executor factory (#626). It reads no
  environment and names no Bun API, so `compose.test.ts` and
  `server-handler.test.ts` drive it in-process under Node. The design preview
  composes it too, over a canned project read and an executor that answers
  only onboarding's set-up probes (#625).
- `usage.ts` — reported cost and plan usage, tailed read-only from each loop's
  `.ralph/logs` (`iter-*.events.jsonl` and `usage-ledger.tsv`). Nothing is
  priced here: a cost is a reported one or it is absent.
  `usage-worker.ts` keeps file scanning, parsing, and aggregation off the HTTP
  event loop. A persistent worker retains incremental tails, reads in 64 KiB
  chunks, and shares each in-flight report across concurrent requests. Reports
  recompute time windows on each poll. Worker failures fail the request and a
  later poll starts a fresh worker; idle workers do not keep the process alive.
  `accountPlan` folds every project's newest reading into the account's plan.
- `health.ts` — the health read for the projects the page is not showing: a
  pure fold (`projectHealth`) over the adapter's local read (`readLocal`:
  loop state and the roster, no `gh`) and each roster checkout's control
  record, and the 30-second `cachedRead` that bounds how often it runs. No
  subprocess or file of its own; `health.test.ts` covers the fold and the
  cache, `server-handler.test.ts` the route over a two-project scratch machine.
- `build.ts` + `ui/` — the shell. `ui/` is a small React app styled with
  Tailwind v4 and [shadcn](https://ui.shadcn.com) components (`ui/components/ui`,
  managed by `components.json` at the repo root). `build.ts` bundles it with
  Vite (config in `vite-config.ts`: React and Tailwind plugins, the `@/`
  alias) once at server start and keeps the artifacts in memory; nothing
  is checked in or written to disk. Assets are emitted at the top level with
  content-hashed names and absolute links, so a nested deep link resolves
  them and the server can cache them as immutable. The build puts the
  process's `NODE_ENV` back afterwards, since the loops the dashboard starts
  inherit it. The UI reads `contracts.ts` types only; the
  write routes' answers and the control view are mirrored there as wire types,
  and each route checks what it serializes against them with `satisfies`.
- `iteration-output.ts` — the loop page's **Live output** pane: follows a
  worktree's newest iteration log and pipes whole lines through the
  harness's redactor, the one process it runs (without `--done`, so it writes
  nothing). `read-only.test.ts` pins that surface.
- `preview.ts` — `bun run dashboard:preview` serves the real shell over canned
  loops on its own port, rebuilding on `ui/` changes (`RALPH_PREVIEW_WATCH=0`
  turns that off, as `dashboard:dev` does); `/states` renders every
  loop-header state. It never touches a loop. Its loops are a canned
  `RuntimeSnapshot`, rebuilt per read, and its loop reads (`/api/loops`, a
  loop's panel, `/api/ownership`, `/api/frontier`) are answered by
  `composeServer(previewServerDeps())`: the real handler and
  `aggregateDashboard`, with every other factory a stub that refuses and an
  executor that refuses every call (#625). So the preview cannot draw a state
  the aggregate would not derive. Its command routes stay in a front layer and
  change the in-memory loops the next read derives from, and nudge the
  router's change-stream hub, since no file moves: `/api/stream` is served
  from the same composed snapshot, so Approve reaches the sidebar in about a
  second. It serves two canned projects under the same `/p/:project/` and
  `/api/p/:project/` paths the shell uses: `preview`, where `/` lands, and
  `widgets`, one running coder `wido`, so a project switch can be tried in a
  browser (#728). `widgets` answers the loop reads, controls, sleep, setup and
  the lifecycle commands from its own loop, and 404s usage, records, chat,
  doctor and output, which stay `preview`'s. It answers the chat routes from `preview-chat.ts` (canned turns
  in memory; a summary containing `dirty` is refused at the worktree step).
  Its command routes parse bodies with the `command-requests.ts` parsers the
  route table names, so a malformed body gets production's 400 and
  `ConfirmationRequired` answers. `preview.test.ts` drives its router
  (`createPreviewRouter`) in-process and pins every GET row of the route table
  as previewed or deliberately not; a new row fails it until someone decides.
  `preview-compose.test.ts` composes the preview's deps in-process and pins
  that `/api/loops` is a well-formed `Dashboard` with every canned loop and
  derived state, that controls reach the next read, and that the reads never
  call the executor. `chat-ui.e2e.test.ts` drives the chat panel against it in a headless
  chromium (`playwright-core`, the browser from Playwright's cache; skipped
  when there is none), including a 375 px viewport.
- `dev.ts` — `bun run dashboard:dev` serves `ui/` from source under Vite's
  dev server, with hot module replacement, so a UI edit shows up in place
  without a rebuild or a reload. React Fast Refresh keeps a component's state
  only when every export of the edited module is a component; editing a file
  that also exports helpers or hooks (`router.tsx`, `shell-parts.tsx`) falls
  back to a full page reload. Every `/api` request is proxied: by default to
  a design preview it starts itself (on `RALPH_PREVIEW_HOST`:`RALPH_PREVIEW_PORT`,
  default `127.0.0.1` and a free port, with `RALPH_PREVIEW_WATCH=0`, since HMR
  does the preview's rebuilding) and stops when it exits; with `--target http://127.0.0.1:8791`, to the local server
  already running, for live data, and nothing is spawned. It listens on
  `RALPH_DASHBOARD_DEV_HOST`:`RALPH_DASHBOARD_DEV_PORT` (default
  `127.0.0.1:8794`, beside the remote preview's 8793; a busy port fails
  rather than moving, and port `0` picks a free one the printed line names).
  The proxy is transparent: the browser's `Host`, `Origin` and
  `Sec-Fetch-Site` reach the target unchanged, so the server's `UnknownHost`
  and `CrossOrigin` refusals still judge the page's own request, and streams
  (`/api/stream`, a loop's output, the chat long-poll) are neither buffered
  nor timed out. CORS is off, so only the page's own origin reads `/api`:
  Vite's default would grant any localhost page, which the local server
  alone never does. Vite answers the same names the local server does beside
  loopback: any `*.ts.net` and those in `RALPH_DASHBOARD_HOSTS`. To reach it
  over Tailscale, map the dev port with `tailscale serve` as for the local
  server.
- `remote/preview.ts` — `bun run dashboard:remote-preview` serves the same
  shell flagged remote (`<meta name="ralph-remote">`) through the real remote
  handler, over an in-memory store (PGlite) holding the design preview's loops
  as the collector pushed them, with a stand-in bridge that applies queued
  commands. `remote-ui.e2e.test.ts` drives it in chromium: each bridge banner
  state, the stale snapshot stamp, the control lock, a relayed command's
  queued answer, and the local-only affordances.
- `ui/remote.tsx`, `ui/remote-model.ts` — what only the remote page shows
  (spec #165 §8): the bridge banner under the header, polled from
  `/api/bridge`; "Updated" from `x-ralph-snapshot-at`, stale past 60 s; the
  loop controls and Mark read off while the bridge says so, with its `why` on
  hover; a `202 { relay }` answer followed through `/api/commands/:id` to the
  machine's own answer (only by `ui/command.tsx`, for a route the route
  table marks relayed). `isRemote()` (`ui/api.ts`) is false on the local
  shell, so none of it renders or runs there. The "Local dashboard only" note
  is `ui/command.tsx`'s `LocalOnlyNote`, below.
- `ui/route-tree.ts`, `ui/router.tsx` — the shell's routes, on TanStack Router
  (spec #723, #728, #735, #736), with the URLs the hand-written router had.
  `route-tree.ts` builds the code-based tree: `/p/$project/` is the Agents
  page, `/p/$project/loops/$name` the loop page, each overview page
  (notifications, usage, backlog, learnings, ownership, reconciliation,
  labels), settings and states has its own route, all typed, so a router
  `Link` to a missing route fails the typecheck. An unknown page of a project
  matches the project's splat, which draws Agents. `/factory` is the All
  projects floor; `/p/$project/factory` redirects there. `/p/$project/intake`
  is a child of the root, not of the project, so it draws without the project
  chrome. `/` and any other unscoped address draw the landing, which moves into
  the project used last. `screenOf` turns the committed leaf match into the
  page the chrome titles and highlights, so the header never runs ahead of the
  body. `App` is a gate that calls no read: the intake route draws alone, and
  on the open intake deployment every other address is "not found". Adding a
  page touches three lists — the tree, `SHELL_PAGES` in `routes.ts` and the
  `vercel.json` rewrites — and `ui/route-consistency.test.ts` fails until they
  agree. `trailingSlash: "preserve"` keeps `/p/x` and `/p/x/` as typed. The
  pages are injected so `route-tree.test.ts` builds the real tree in node;
  `router.tsx` passes the real ones and registers the router's type. The
  project chrome is keyed by project id, so a switch rebuilds the screen.
- `ui/in-app-link.tsx` — an anchor the router follows in place, for the
  floor's links, whose hrefs are strings its models build.
- `ui/screen-project.ts` — the project on screen, which `api()`, `page()`, the
  reads and `send()` scope to. `DashboardApp` (in `ui/app.tsx`) records it as
  it renders, so during a navigation, when the address bar has already moved,
  a command still goes to the project the operator is looking at; the floor
  and the intake surface record none.
- `ui/query-reads.ts`, `ui/reads.ts`, `ui/use-reads.ts` — how the shell reads
  (spec #602). `reads.ts` declares each GET the shell polls as a named read
  (URL and interval). `query-reads.ts` keeps one entry per URL, so two panels
  on one URL share a request. It reschedules only after a read settles, keeps
  the last data on an error, and `refresh` re-reads right after a control
  action without a skeleton. It is tested with a fake fetch and
  clock. `use-reads.ts` binds the page's reads to React (`useDashboard`,
  `useLoopControl`, `useUsage`, …), on the Query layer below since #734. A
  layer also reports whether a URL's read is in flight (`inFlight`), telling
  listeners when a read starts as well as when it settles; `useReadBusy`
  carries it, opt-in so other readers do not re-render at every poll's start,
  and the labels page's Refresh button is disabled from it. The dashboard snapshot (`useDashboard`, the factory floor and the
  change stream's refresh of it) goes through TanStack Query since #727, the
  first step of spec #722: `ui/query-reads.ts` kept the old store's rules and
  shape with a `QueryClient` as its cache, so a project's snapshot stays
  cached for 60 seconds after its last reader leaves. Hovering or focusing
  any in-app link preloads the page it opens (#739): router links through
  `defaultPreload: "intent"`, and the plain anchors (`InAppLink`, the shell's
  `Link`, the rail's project tiles, their page menus and All projects, the
  usage page's loop links) through `usePreloadHref`, both running the target
  route's loader, which reads the page's data through the Query layer; its
  keep-alive decides whether a read actually happens. Since #733 every other
  polled read (projects, health, setup, sleep, bridge, usage, Sentinel panel,
  notifications, history, agents, labels and intake) goes through it too, and
  the labels busy flag is read from it. Since #734 the one-shot reads, the
  loop controls and the busy flags of the lineup catalogue and GitHub repo
  list go through it too, and the change stream drives the Query layer
  alone; a returning one-shot reader opens on loading rather than the cache,
  so a form never seeds its draft from stale data. #738 deleted the
  hand-written read store (`ui/read-store.ts`) the page had used since #603,
  so the Query layer is the only one. The notification and history panels,
  the intake page, the agents page and the labels page read through these named reads too, so a
  failed refresh keeps their last data on screen; none polls on its own.
  The factory floor reads every project's snapshot as `floorRead` (15 s,
  through `useDashboards`, one Query-layer entry per project), on the same
  URL as `useDashboard`, so the current project costs one request per tick
  and polls at the shell's 5 s while the shell is mounted. The lineup
  (and its harness catalog, `?refresh=1` on Refresh), verifier, Jav, agent
  guide, setup defaults and GitHub repo list are one-shot reads
  (`intervalMs: null`): read on mount, again only on `reload()`, which the
  views call after a save. Their POSTs go through the command module below.
  The store's `refresh(url)` and `livePoll(url, ms)` are the seam the change
  stream drives (#724), and the one the TanStack Query migration (#722,
  #727, #733, #734) must keep. `ui/live-stream.ts` (`useLiveStream`) opens `/api/stream` while
  the tab is visible; on the remote page it opens `ui/version-wait.ts`
  instead, a fetch long-poll of the hosted `/api/versions` that turns each
  key whose version moved into the same event (#731). Each event refreshes the reads its key names (#729):
  `dashboard`, `controls` (the batched controls read), `control/<loop>`,
  `notifications` (the project's feed and every loop's), `history/<loop>`,
  `agents`, and `_/health`, which the stream forwards from the other
  projects' hubs and which refreshes the switcher's health read. The per-loop
  keys follow the roster without reopening the stream (`setReads`). While the
  stream is open, `livePoll` slows each mapped read's poll to 60 seconds, as
  a fallback only. An error or `unavailable` restores each
  read's own interval, and the header then says "Live updates off · polling".
  A stream the browser gave up on is reopened with a backoff, and a reopen
  refreshes once for the changes it missed.
  A hidden tab polls nothing (#725): the store takes the page's visibility
  (`document.visibilityState`), arms no poll timer while hidden, and the
  stream is closed then too, so a forgotten tab spawns no adapter reads all
  night. Showing the tab re-reads every polling read at once, keeping its
  data on screen; the stream reopened on show does not refresh again. The
  first read of a new subscription and an explicit refresh still go while
  hidden. One-shot reads are not re-read on show, so a form built from one
  does not reload under the operator.
- `ui/loop-control.ts` — how `useLoopControl` reads (#615): every loop card
  picks its loop's row from the project's one `/api/controls` read, so N cards
  cost one request a tick. A 404 there (an older server), or a 503 before it
  ever answered (a remote whose bridge has not pushed `controls`), switches the
  project to the per-loop route for the rest of the session.
- `ui/chat.tsx` — the **Talk** button on halted or stopped loop cards and on
  the backlog's stuck-ticket rows (targeting the loop whose `<loop>-blocked`
  label the ticket wears), and the chat sheet: source header, Ask/Fix pill,
  Stop & fix, the transcript, and Unblock & resume's draft → edit → confirm.
  Its rules are `ui/chat-model.ts`'s, tested without a browser.
- `ui/controls.tsx` — the loop controls (start, restart, pause, stop, Stop
  now, Resume work, gates, claims), their notices and the loop header, kept
  out of the shell `ui/app.tsx`. The shell imports `Controls` and `LoopHeader` from it, and the `/states` gallery
  renders `LoopHeader` from it without importing the shell.
- `ui/control-model.ts` — which loop controls apply (`controlsFor`) and where
  each action is posted (`requestFor`), plus the controls' transient state as a
  pure reducer (`controlsReducer` over `ControlsState`: what is armed, pending
  and last answered). Kept out of `ui/controls.tsx` so the rules and the
  transitions are tested without a browser; the `/states` gallery seeds
  `LoopHeader` with a `Partial<ControlsState>`.
- `ui/command-model.ts`, `ui/command.tsx` — how the page writes (spec #607).
  Every POST and DELETE the page sends is declared once by method and path;
  whether it relays, is local-only on the remote page or is addressed at the
  top level (`/api/projects`, `/api/projects/remove`,
  `/api/projects/pick-folder`) is read off `route-table.ts`, never written per
  route. `sendCommand` never throws: it answers `Result<T, CommandError>`,
  `{ kind, message, status, problems?, path? }`, minting `Network`, `Malformed`,
  `LocalOnly` and `Aborted`, and following a `202 { relay }` only on a relayed
  route. `command.tsx` binds it to the window (`send`, `useCommand` with the
  lock and one send's pending and queued state) and renders a failure as
  `Kind: message` in `CommandNotice`. The loop controls, the Agents panel and
  Mark read go through it, as do the settings editors (Lineup preview and
  save, Jav save, the verifier proposal, the plugin doctor), onboarding
  (Setup validate and submit, the tracker connector's test and save, Add
  project's folder pick and add, whose register-local hint reads the
  refusal's `path`), the chat sheet's writes and intake login and logout,
  which are `open` routes the remote page sends as is. Add project and Setup
  are locked on the remote page by the route's availability, not by
  `isRemote()`. `LocalOnlyNote` takes the route of the write it stands beside
  and says "Local dashboard only" exactly where that route's availability is
  local-only (Add project, setup, Add/Delete agent, Create checkout, Remove
  project, the lineup and Jav saves, the verifier proposal, the Fix panel).
  The few plain GETs outside the read layer (the chat's polls, the controls'
  checkout read, the agent preflight) decode their answer with
  `decodeAnswer`. `dashboard/command-guard.test.ts` pins the monopoly: it
  parses each UI source with the TypeScript compiler and fails when one
  outside the command module sets a `method` other than GET or HEAD, calls `isRemote()` beyond its pinned per-file allowlist (page shell and
  read-side only), or decodes an `{ error, message }` body itself. The
  parity test against the bridge's `RELAY_ROUTES` sits in `read-only.test.ts`,
  because the UI's tsconfig carries no node types for the bridge module.
- `ui/shell-parts.tsx` — the small display helpers both the shell and the
  controls draw with (tones, the status and role badges, the observer's
  reading, ages), kept apart so `ui/controls.tsx` never imports `ui/app.tsx`
  back.
- `ui/sentinel-panel.tsx`, `ui/sentinel-model.ts` — the Sentinel panel on the
  agents page, over `GET /api/sentinel`: the issues grouped by state, what
  observe mode would have filed, and today's cap. Absent with no sentinel loop.
- `ui/sentinel.tsx`, `ui/sentinel-form-model.ts` — the Sentinel sheet's rules
  form, over `/api/agents/sentinel`, local only. Its checks are a copy of
  `project-config`'s `sentinelProblems`, held to it by
  `sentinel-form-parity.test.ts`.
- `ui/rules-save-model.ts` — what the Sentinel and Verifier sheets say about
  a save: the button and the note above it (Save rules, or Propose rules for a
  `configChanges: "pr"` project), and the notice after it ("Saved to main
  (abc1234). The sentinel picks it up on its next poll.", the PR link, or why
  a direct commit became a PR). It also words the On/Off switch (#789) and the
  card line `Off: disabled in config`.
- `ui/agent-switch.tsx` — the On/Off switch at the top of the Sentinel and
  Verifier sheets, and the `Off: disabled in config` line on a sentinel's or
  verifier's card (local only; it reads `/api/agents/sentinel?pending=skip`
  or `/api/agents/verifier?pending=skip`, the base branch's rules the gate
  re-reads, without the open-PR lookup (#65)). A switch
  saves at once through the same POST as the rules, sending the base branch's
  rules with only `enabled` changed, so its commit reads `ralph: sentinel
  rules — enabled true → false`. Off, the gate keeps polling and does nothing
  else until it is switched on again.
- `ui/settings.tsx`, `ui/settings-model.ts`, `ui/settings-form-model.ts` —
  the project's Settings page (`/p/<project>/settings`), its own module so
  each Settings section is added here rather than in the app shell: the
  read-only overview of `GET /api/settings`, the Edit form that proposes a
  display name or base branch through `POST /api/settings/project` (disabled
  on the remote page), the Gates section (each gate with Run, polling
  `GET /api/settings/gates/run` every 2 s while a run is in flight, and the
  required checks; `ui/gate-run-model.ts` words its states), the Prompts
  section over `GET /api/settings/prompts` (each named fragment as Markdown
  source, flagged when missing, and the rendered prompt of a role chosen by
  tab; `ui/prompts-model.ts` decides what each draws), the Agent
  worktrees form that sets the folder new agent worktrees go in through
  `POST /api/settings/worktrees` (also disabled remotely), and the page ends
  with a Danger zone: Clean up worktrees (#696), which lists the
  registrations the Worktrees overview marks prunable, prunes them through
  `POST /api/settings/worktrees/cleanup` after a confirm click and shows what
  was pruned and skipped (`ui/worktree-cleanup-model.ts`; disabled remotely
  and when there is nothing stale), then Remove project, which stays on the
  page whatever the overview could read. The form's checks are `settings-form-model.ts`'s
  copy of `project-config`'s, held to it by `settings-form-parity.test.ts`.

  The Gates section is editable too (#692): one form for the gates, the
  required checks and the refused files, whose Save opens one config PR
  through `POST /api/settings/project` with every change in it. It warns
  when a new required check has not been reported recently (on the base
  branch or the five newest PRs; the PR still opens), applies once the PR merges and the loops restart, and is
  local-only: disabled on the remote page. Run keeps running the saved gates.

### Agent dispatch: add, delete, and remove a project

- `agents-adapter.ts` — the agent sibling of `lifecycle-adapter.ts`: the only
  module that names `git worktree add`/`remove`, the roster commit's plumbing,
  `gh pr create`/`list`, `project-config`'s roster flags and the Orca worktree
  path. It writes a new worktree's `.ralph/loop-name` and its own scratch
  index, and nothing else; the roster rules stay `project-config`'s.
  Like the control adapter, it takes its own `Executor` in its config and
  runs everything through `guarded`, so it answers with operations —
  `readConfig({ at?, ref? })`, `editRoster`, `fetch`, `revParse`, `checkouts` and the rest
  — that never reject.
- `agents.ts` — the sequences over the adapter's operations: everything that can
  be checked (config, name, clash, liveness, the edited roster) is checked
  before the first change, so a refusal leaves nothing behind.
- `settings.ts` — the Settings overview over the adapter's reads: the
  config, the worktrees and one loop-state read, which carries both the
  supervisors' liveness and the Reconciliation page's own lists.
- `settings-prompts.ts` — the Settings Prompts section over the adapter's
  reads: the config's fragment paths, each file's text, and one
  `models.ts --render-prompt` per roster role, run concurrently.
- `gate-run.ts` — the Settings page's gate runner: one run per key (a
  project's checkout), spawned detached so a timeout kills the whole process
  group, with only the output's tail kept. The server holds one runner for
  every project, so a rebuilt project handler still refuses a second run.
- `agents-routes.ts` — the routes: validate, call, serialize.
  `agents-http.test.ts` drives them over a real bare `origin` and a clone,
  with a `git` wrapper that records every argv and a fake `gh`.

### Lifecycle dispatch: start and restart-to-apply

- `lifecycle-adapter.ts` — the lifecycle sibling of `control-adapter.ts`. It
  runs `start.sh` in the loop's worktree (the configured root) with
  `RALPH_PROJECT` naming that root and no inherited run id. It also
  reads the supervisor's liveness from `loop-state status --json`, which
  matches the process by argv and cwd, and builds a read-only checkout report
  from `git status --porcelain`, the branch, and the claim leases held for the
  worktree. Like the control adapter, it takes its own `Executor` in its config
  and runs everything through `guarded`, so it answers with operations —
  `start(options)`, `supervisor()`, `loopState()`, `checkout()` — that never
  reject; the pure parsers (`parseStart`, `parseLoopState`, `parseSupervisor`,
  `parseCheckout`) stay exported for their unit tests.
- `lifecycle.ts` — `start` returns `start.sh`'s answer: `started`, the
  worktree lock's idempotent `already-running`, or `failed`.
  `restart-to-apply` sends a stop naming the observed run (default kind
  `blocked`) through `dispatch()`. It then waits until the record shows that
  stop `confirmed` **and** the liveness read shows the supervisor gone, and
  only then runs `start.sh`. It halts without starting when the stop is
  refused, recorded `unreachable`, still `pending` at the deadline, or pending
  on a supervisor that exited, and when liveness cannot be seen. If the
  supervisor is already gone, no stop is sent, but a leftover unconfirmed stop
  on the record halts the restart too, because a new supervisor would adopt
  it. Re-issuing with the same `id` replays the stop and resumes the wait.
  Restart never resets, checks out, cleans or stashes. A dirty or mid-ticket
  checkout is reported in `checkout`, and it never sends a process signal.

- `doctor-adapter.ts` and `doctor-routes.ts` — the Fix panel: one invocation of
  the harness's `plugin-doctor.ts` for a loop's checkout, its answer narrowed
  (an unreadable one is a `problem`, never a failed page), and the route that
  validates the request and serializes it. The adapter owns its exec behind
  `guarded()` and exposes one `run`, so an executor that rejects is a failed
  view with a `problem`, not a 500. The plugin doctor holds each plugin's own
  verb allowlist; nothing on the page's side names one.

- `records-adapter.ts`, `records.ts` and `records-routes.ts` — the
  notification feed and the audit history. The adapter reads the feed, the
  command inbox and its settled files, the Stop now audit and the doctor's
  record, bounded to their newest part, and writes one file, the read mark,
  into the control directory; it runs no process. `records.ts` is a pure
  projection of what it read (`records.test.ts`), and the routes resolve a
  loop to its checkout and serialize. `records-routes.test.ts` drives them
  over records written by the real `push-notification.ts`, `control-inbox.ts`
  and Stop now adapter.

#### The loop reconciler: restarting a loop whose supervisor died

`reconcile.ts` is the pass that notices a dead loop. `ralph-dashboard.service`
comes back by itself — `Restart=always` after an oomd kill, `WantedBy` plus
linger after a reboot — but the loops it was supervising do not, and on
2026-10-19 one oomd kill left every loop dead until an operator looked.
`main()` calls `schedule(…, { intervalMs })` once, over the composition's
reconcile and migration-watchdog passes (`compose.ts`): the pass
runs immediately, which is what covers both of those, and then every
`RALPH_DASHBOARD_RECONCILE_MS`.

- **It restarts only a death.** Per worktree it takes ONE
  `loop-state status --json` read (`parseLoopState`) and restarts when the
  record names no `stopReason` **and** the supervisor is `dead`. `completed`,
  `blocked`, `failed` and `interrupted` are endings the loop chose and stay
  stopped; liveness `unknown` is "could not tell", including the old-heartbeat
  case `classifyLoop` calls `stale`; a worktree with no record was never
  started here.
- **A signal is an ending, not a death.** A shutdown, a reboot or an
  operator's `kill <pid>` reaches `ralph.sh` as SIGTERM (Ctrl-C as SIGINT, a
  closed terminal as SIGHUP), and its trap (`signal-stop.sh`) records a
  confirmed `interrupted` stop — "stopped by SIGTERM (a shutdown, a reboot or
  a kill)" — the way Stop now does, and Start or Resume work picks it up.
  The trap also records which signal it caught and that it recorded the stop
  itself (`stopReason.signal`, `stopReason.self: true`); Stop now's own record
  replaces it with `self: false`. Before the trap, on 2026-10-28, a shutdown
  came back at boot as every loop restarted, the ones meant to be off
  included. SIGKILL, an OOM kill and a power cut leave no ending, and stay
  restarted.
- **A shutdown is restarted at the next boot; a kill is not (#6).** A dead
  loop whose ending is a self-recorded SIGTERM `interrupted` stopped *before*
  the host's current boot (`btime` in `/proc/stat`) was stopped by the
  shutdown, not by anyone, and is restarted through the same bounded path as
  a death, with the journal line `reconcile: <p>/<l> was stopped by the host
  shutdown before this boot — restarting`. This reverses #520's rule for
  shutdowns only: on 2026-11-22 it kept both coders down for ten hours after
  a reboot with a green PR waiting. These stay stopped, as before: Stop now
  (operator-recorded, and a stop still pending on the control record blocks
  any restart), a SIGTERM, SIGINT or SIGHUP recorded after the current boot
  (a manual `kill`), and every other ending. An `interrupted` record written
  before #6 (no `signal` or `self`), a boot time that cannot be read, or a
  stop time that will not parse also stays stopped, and the line that says so
  names why.
- **Through the Start button's own path.** `gatedStart` into `start()`, so a
  restart cannot step around the new-agent gate, the supervisor lock or
  `start.sh`'s duplicate prevention. A `prepareStart` refusal is an attempt
  like any other: recorded with its reason and counted.
- **Every attempt is recorded where the page already reads.**
  `push-notification.ts push --kind loop-restarted`, with `RALPH_STATE_ROOT`,
  `RALPH_LOOP_NAME` and `RALPH_RUN_ID` (the DEAD run) set, and the attempt's
  timestamp in the occurrence key — the record dedupes on
  `<run>:<occurrence>`, and a loop that dies before writing a new `state.json`
  keeps its old run id. The records arrive in the notification feed as
  ordinary alerts, naming the project, the loop, the dead run, the reason
  (`supervisor <pid> gone, no stopReason`) and the outcome.
- **Bounded, from the records and not from memory.** At most
  `RALPH_DASHBOARD_RESTART_ATTEMPTS` attempts per loop per hour, counted back
  out of that loop's own `.ralph/logs/notifications.jsonl`: an in-memory
  counter would reset on every `Restart=always` cycle, which is the cycle the
  bound exists for. The process's own count is a *second* ceiling beside it,
  for the one case the records cannot cover — a push that could not be
  written leaves no attempt to count — and a feed that cannot be read at all
  leaves the loop alone rather than reading as zero attempts. While the bound
  holds, one `loop-restart-capped` alert is raised for that capped stretch —
  one per stretch, not one per pass.
  The attempts are not spaced across the hour, which has a cost worth knowing:
  three passes a minute apart spend the bound in three minutes, and the loop
  then stays down until the hour has slid past. That is #346's own rule; raise
  `RALPH_DASHBOARD_RESTART_ATTEMPTS`, or press Start, if a host needs more.
- **A loop it leaves down is said once.** A recorded loop whose dead
  supervisor has an ending (`is down and stays stopped: …`, a kill's
  `interrupted` included) or whose supervisor cannot be seen
  (`could not be seen, so it is left alone: …`) is one journal line per run
  and reason, and so is a project whose read fails (`could not read <p>: …`,
  then `<p> is readable again`), in both the reconcile and the
  migration-watchdog walk. The memory is per process, so a restarted
  dashboard says each standing state once more. Before it (#765) the first
  two said nothing at all and the third said itself every minute.

**A loop that stopped itself on a transient fault is retried, on a spaced
schedule.** Only a `failed` stop whose last event is `secrets-env`, `no-sigil`,
`preflight-broken` (a preflight that could not run, which a supervisor before
#767 stopped on and today's waits out), or a `preflight-denied` whose recorded
failing checks are all `doppler-scope`;
every other ending stays stopped, including a `preflight-denied` naming a
local-config check or naming no checks at all. `secrets-env` is retried even
though a local Doppler scope problem raises it too: the bound turns that case
into seven retries and one alert rather than a loop down in silence. The gaps
are `RALPH_DASHBOARD_RETRY_SCHEDULE` (5, 15 and 45 minutes, then hourly; seven
attempts). Attempts are counted from the `loop-retried` records raised after
the loop last finished an iteration, so a loop that has worked since starts a
fresh schedule. The first gap runs from the stop that opened the stretch, each
later one from the previous `loop-retried` record. When the attempts are spent,
one `loop-retry-capped` alert is raised at high priority for that stretch and
the loop stays stopped. This path's records are its own kinds, so it never
spends the dead-supervisor path's attempts, nor that path its.

**With the reconciler on, stop a loop with the dashboard, not with a signal.**
A supervisor killed from a shell — a targeted `kill`, or the broad
`pkill -f 'ralph/ralph\.sh'` — leaves a record with no `stopReason`, which is
exactly a death, so the next pass starts it again within a minute. Stop now
and restart write the ending that keeps a loop stopped; a stop whose
confirmation never landed is left alone too, because a new supervisor would
adopt it and exit.

Switch it off with `RALPH_DASHBOARD_RECONCILE_MS=0` when a dashboard must not
start loops — a second instance beside the live one, or the suite's own HTTP
servers, whose fixture worktrees carry records with no `stopReason` and no
supervisor and would otherwise be read as dead loops.

`reconcile.test.ts` drives the pass over scratch worktrees with every process
faked but every decision real, and the schedule on an injected clock;
`end-to-end.test.ts` drives it over the real `start.sh` with a supervisor
killed with `kill -9`.

- `lifecycle.ts`'s `resumeWork` — start again over an interrupted run's work:
  refused over a live or unseen supervisor and over an unconfirmed stop, then
  `start.sh` with the resume flag, answering with the checkout report.
- `interrupt-adapter.ts` — the only module that may signal a process: reads
  the pid file, runs the five checks against `/proc`, signals a process group,
  reads what is left of it, and appends the audit file. It imports only
  `node:fs`, `node:path` and the contracts.
- `interrupt.ts` — Stop now's sequence over the injected adapter: address it,
  check, record then signal, SIGTERM then SIGKILL, and have the loop record the
  interrupted stop. `interrupt.test.ts` asserts the order over a scripted
  target, `interrupt-adapter.test.ts` the checks and the signal against real
  processes, and `interrupt-channel.test.ts` the whole of it — with Resume work
  — against the real `start.sh`, `flock` and `controls.ts`.
- `lifecycle-routes.ts` — the start/restart/Stop now/Resume work endpoints and
  the checkout report: validate the request (loop, the server-enforced restart
  and Stop now confirmations), resolve the loop to its checkout, call `start`,
  `restartToApply`, `stopNow`, `resumeWork` or `readCheckout`, and serialize. It names no command,
  flag or environment variable. The server sets Bun's idle timeout to its
  maximum (255s) as a safeguard for a restart's long wait.

`lifecycle.test.ts` asserts the ordering through the shared recording executor
(`recording-executor.ts`).
`lifecycle-routes.test.ts` pins the HTTP contract in-process, and
`lifecycle-http.test.ts` drives start and restart against the real Bun server
on an ephemeral loopback port.
`lifecycle-channel.test.ts` drives the real `start.sh` (with a fake
`nohup`/`ralph.sh`, as `start.test.ts` does), the real `controls.ts` and
the real `loop-state.ts`.

The roster is the project's `loops` in its `.ralph/config.json`, read through
`project-config --json`; a loop added there appears without a second edit.

- `onboarding-adapter.ts` — the one module naming the git and `gh` commands
  that add and set up a project, as a closed surface pinned by
  `read-only.test.ts`: nothing resets, cleans, stashes, deletes or
  force-pushes, and `gh` only lists, clones, views, reads the login, lists PRs
  and creates the setup PR.
- `onboarding.ts` — the sequences over the adapter's operations (the adapter
  owns the executor, behind `guarded()`): add local, add from GitHub, derive status, pre-fill, validate, submit.
- `onboarding-routes.ts` — their HTTP routes, and the gate that refuses a
  start on a project that is not ready. `GET /api/setup` is not an observation
  read: for a project that is not ready it fetches and asks `gh`.

`onboarding-http.test.ts` drives every add path, refusal and status transition
through the real handler with real git against a scratch bare origin and a
fake `gh` that logs its argv.

#### The migration watchdog: paging for a stalled `migration-applied` PR

A hand-applied migration puts prod ahead of main, and every other PR of the
project reds until the one that carries it merges (loggd #2760, #434). On the
reconciler's timer, after each reconcile pass, `watchMigrations` reads each
registered project's open PRs labelled `migration-applied` with `gh`, and when
one has carried the label longer than `RALPH_MIGRATION_ALERT_SECONDS` (default
3600) it raises one high-priority `migration-applied-stalled` alert — once
per PR and apply time, so a label removed and put back pages again.

The alert is written under the fixed run `migration-watchdog` in the
roster's first loop worktree, once per project, not per loop. push-notification
dedupes on `<run>:<occurrence>` at that root, so a dashboard restart does not
page the same stall twice, and the alert goes out through that project's
enabled plugins. An apply time that cannot be read is logged and retried next
tick. The watchdog follows the reconciler's off switch:
`RALPH_DASHBOARD_RECONCILE_MS=0` stops both. `migration-watchdog.test.ts`
proves the restart dedupe and the plugin delivery with the real
`push-notification.ts`.

## Tests

```bash
bun x vitest run dashboard
```

The runtime adapter suites (`adapter.test.ts`, `adapter-claims.test.ts`,
`adapter-performance.test.ts`, `adapter-timeline-failure.test.ts`) spawn
nothing: `adapter-script.ts` builds a scripted world on the recording executor
with a neutral, contract-valid answer for every surface a snapshot reads, a
fixed clock, and a scratch root for what the adapter reads off disk. A test
overrides one surface and asserts on the recorded invocations, so it tests the
adapter, not the CLIs. The real ralph CLI, against a fake `git` and `gh` on
PATH and scratch worktrees (`fixtures.ts`), stays where a suite still runs it:
`adapter-runtime-reads.test.ts` (the CLI-to-narrower contract, the run-scoped
timeline and runner-failure reads, and a read-only frontier census) and
`adapter-cli-reads.test.ts`, and the subprocess HTTP suite (`server.test.ts`). Suites that drive a module through an injected executor
script and inspect it with `recording-executor.ts`: answers by matcher (fixed,
computed, or a throw for the `guarded()` path) and one ordered log of every
call. `cli-read.test.ts` drives
the CLI read module's policies and cache that way on a fake clock;
`adapter-cli-reads.test.ts` drives the frontier, Following and PR-status reads
through `createRalphAdapter` with a recording executor beside the real CLI
fixture; `jav.test.ts` and `intake-adapter.test.ts` drive the Jav read and
save and the intake reads, degrades and TTL with one;
`process-executor.test.ts` runs the real process executor against
`sh` (timeout, missing binary, stdin closed). Usage is
read by the real `usage.py` from a scratch `HOME` transcript, and the journal
from a real scratch git repository standing in for the harness. The HTTP routes are
driven in-process: `server-handler.test.ts` hands each `Request` to
`composeServer` with its Executor factory returning one recorder over
`adapter-script.ts`'s scripted world, so a case's fixture describes runtime
state and nothing fake sits on PATH. `server.test.ts` spawns the actual Bun
server only for what the entrypoint alone can show (its header lists the
cases), and `compose.test.ts` pins the wiring itself — which surface's
commands run on which timeout's executor — with the real adapters over
recording executors; `preview-compose.test.ts`
drives the preview's no-process composition the same way. `dev.test.ts`
spawns the real server with `dev.ts --target` in front of it and pins the
proxy's transparency: both refusals, no CORS grant, a stream's first bytes, a
response held past Bun's idle timeout, and the SPA fallback;
`dev-config.test.ts` pins `dev.ts`'s arguments, environment and Vite config
without starting anything. `read-only.test.ts` pins the command surface and proves the handlers
never invoke a write path. It also pins the exec boundary (#640): every
adapter owns its `Executor`, so outside the adapter modules (`adapter.ts`,
`*-adapter.ts`, `cli-read.ts`, `executor.ts`, `reconcile.ts`, whose adapter
factory shares the reconciler's module, and the test-only
`recording-executor.ts`) no module imports the executor port, names an
`Executor` or calls a `*Invocation(` builder. `server.ts`, the composition
root, imports only `createProcessExecutor` of the port and calls it in one
place: the `executor:` dependency it hands `composeServer`. `compose.ts`, the
composition, takes the port's `Executor` type alone, binds each executor it is
given once, and names it after that only as an adapter factory's `exec:`. The route, lifecycle, dispatch, doctor and
reconcile suites script their executor with `recording-executor.ts` too.
