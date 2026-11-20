# Ralph lineup editor — local HTTP adapter

The backend for the local-only lineup editor: a small Bun HTTP server that reads
`ralph/models.json`, re-resolves a candidate, and commits a validated one — all
by spawning the `ralph/models.ts` CLI, never by importing it.

It sits on the pure edit/validate/serialize layer in
[`../lineup-editor.ts`](../lineup-editor.ts). The **runtime adapter**
(`adapter.ts`) chooses every read/preview/save invocation, owns its environment,
and narrows each response against the JSON contract; the HTTP handlers hold no
validation logic and never touch a subprocess or a file. The static front-end
in `static/` is the operator's page over that API.

## Run it

```bash
bun ~/ralph/lineup/server.ts
```

Then open <http://127.0.0.1:8792/>. The server prints the address it bound,
including the port when one is chosen for you.

## The page

`GET /` serves `static/index.html`, which imports `static/lineup-view.js` as a
native module — plain files, no build step. The page:

- lists `default` and every loop block in the file (plus any loop it has
  already shown, so a removed block's loop stays listed running `default`), and
  every stage of the selected loop as the file has it;
- edits one stage at a time: the runner picker offers `schema.runnersFor[stage]`;
  an Agent-tool stage on the Agent-tool runner takes an alias or a full
  `claude-…` id when the schema names its agent in `schema.agentNames` (an
  older schema's ad-hoc call picks from `schema.aliases`), any other stage
  takes a model id checked against `schema.modelId` before Apply; effort is
  offered wherever `schema.effortRunnersFor` allows it, and an ordered fallback editor
  only on an Agent-tool stage whose runner is not `claude`. Fallback choices
  include the OpenCode and Codex catalogues plus Claude Agent aliases; they can
  be added, removed and reordered. Apply sends runner, model, effort and the
  fallback chain as **one** edit;
- editing a named loop without a block gives it a complete block copied from
  `default`; a named loop's block can be removed to fall back to `default`;
- re-resolves the preview after every edit, with each stage's `source`, and
  names the exact environment variable wherever a live override wins;
- saves through the validator, showing the complete problem list on refusal;
- says that a save applies at the next `start.sh`, not to a running
  supervisor, and points at the dashboard's loop controls to restart — it does
  not restart anything itself.

`lineup-view.js` holds the page's pure view helpers and its HTTP client; it
knows the HTTP view models only and hardcodes no runner list, alias set or
model-id rule. `lineup-view.d.ts` types it for the Vitest suites.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RALPH_LINEUP_PORT` | `8792` | TCP port. `0` asks the OS for an ephemeral port. |
| `RALPH_LINEUP_ROOTS` | the harness checkout (`RALPH_HOME`) | Comma-separated **absolute** repo/checkout roots, each holding the `models.json` it edits. |
| `RALPH_LINEUP_BUN` | the running Bun (or `bun`) | Bun executable used to invoke `models.ts`. |
| `RALPH_LINEUP_PROJECT` | `loggd` | The project whose keys a request that names none edits. |

The tool works from any working directory: roots are absolute, and the default
root is the harness's own path, never `pwd`. A request selects a root by
absolute path or by its index in the configured list, and a project by id
(`project`, as a query parameter or body field). The dashboard mounts one
handler per project with the project pinned, so its pages cannot name another.

`models.json` keys loop blocks by project. The editor never hands a page the
whole file: `config` in every request and response is one project's **view** —
`default` (the project's own `default` block, else the file's) plus that
project's loop blocks. A preview, edit or save merges the view back under the
project's key (`mergeProjectView` in `../lineup-editor.ts`), judges the whole
file the merge makes, and a save writes it. Every other key — the file's
`default`, other projects, commentary — is carried over untouched. The view's
`default` becomes the project's own only when it was already, or the edit
changed it. Before reading, the adapter runs `models.ts --migrate`, the
one-time move of pre-project loop blocks under `loggd` (a no-op once done).

## HTTP surface

- `GET /api/roots` — the configured roots, in order.
- `GET /api/lineup?root=&project=&loop=&role=` — the project's view of the file (`config`), the resolved
  lineup with per-stage `source`, the runtime schema, and the environment
  shadows. 400 when the resolver refuses the file, carrying its own message —
  including the restore guidance for a missing `models.json`.

  `role` is for a caller that knows the loop's role when the resolver cannot:
  the roots this editor edits are HARNESS checkouts, and a loop's role is
  declared in the PROJECT's `.ralph/config.json`, so without it a triager is
  resolved — and validated — as a coder, offered five stages, and then refused
  for the three-stage block the form helped write. It is checked here for shape
  only (the role vocabulary belongs to the runtime, which this editor never
  imports); a well-formed role the runtime does not know is its refusal,
  reported as a 400. A block whose stages the role forbids still OPENS, showing
  the block as it is — those stages are what has to be deleted — and is refused
  on preview and save, naming them.
- `GET /api/lineup/catalog` — what each harness can run, from the harness
  itself: the model catalog baked into the Claude Code binary (ids, display
  names, context windows, per-model effort levels, and the alias-to-latest
  map) plus `claude --help` for the effort levels the CLI accepts,
  `opencode models`, and Codex's `~/.codex/models_cache.json`.
  `{ fetchedAt, runners: { claude, opencode, codex } }`, each runner
  `{ available, reason, source, version, models: [{ id, label?, efforts?, contextWindow? }], efforts, aliases }`.
  A harness that cannot be asked is `available: false` with a `reason`, never
  an empty list. Cached for ten minutes; `?refresh=1` asks again now.
- `POST /api/lineup/preview` — `{ root?, project?, loop?, role?, config }`. Re-resolves the
  candidate without writing; returns `{ valid, problems, resolved }` where
  `resolved` is null on reject.
- `POST /api/lineup/edit` — `{ root?, project?, loop?, role?, config, edit }`. Applies one edit
  to a copy of `config` through the pure layer and re-resolves it for `loop`
  without writing; returns the preview plus the edited `config`. `edit` is
  `{ kind: "stage", stage, change: { runner?, model?, effort?, fallback?: string[] } }`
  (`null` removes `effort`/`fallback`), `{ kind: "create" }` or
  `{ kind: "remove" }`. 400 for an edit the layer cannot apply (an unknown
  stage, removing `default`).
- `GET /` and `GET /lineup-view.js` — the static page.
- `POST /api/lineup/save` — `{ root?, project?, loop?, role?, config }`. Merges the
  view under the project's key, validates, writes atomically only on success; 400 with the complete problem list on reject, as `{ error: "LineupInvalid", message, ...save }`.
- `GET /api/lineup/updates?root=&project=` — the project's blocks (and the
  file's `default`) with the stages on an older Claude id than their family's
  latest, each block's `updates` policy and whether to ask (#851), from
  `model-updates.ts --json`.
- `POST /api/lineup/updates/answer` — `{ root?, project?, block?, fileDefault?, answer }`,
  `answer` one of `update`, `snooze`, `skip`, `pin`, `auto`, `ask`. Runs
  `model-updates.ts --answer`, which writes `models.json` itself and refuses
  an edit that would add a resolver problem (a 400 with its sentence); returns
  the stages it moved and the block as it reads after.
- Everything else is 404; a route with the wrong method is 405.

The file's `$comment`/`$comment_loops`, other projects' blocks and key order
survive the round trip.

### The read response

`GET /api/lineup` returns:

```jsonc
{
  "root": "/srv/ralph",
  "project": "loggd",
  "loop": "rafa",
  "config": { /* loggd's view: { "default": {…}, "ralph": {…}, … } */ },
  "resolved": {
    "loop": "rafa",
    "role": "coder",
    "stages": {
      "mapper": { "model": "sonnet", "runner": "claude", "source": "loop" }
      // … one entry per stage the ROLE runs, from `bun models.ts --json`
    }
  },
  // The schema is read for the role the caller named, else the one `resolved` reports, so `stages` is that
  // role's set — a triager's three, not every stage the resolver knows.
  "schema": {
    "role": "coder",
    "stages": ["orchestrator", "executor", "mapper", "review.standards", "review.spec", "review.correctness"],
    "runners": ["claude", "opencode", "codex"],
    "runnersFor": { "orchestrator": ["claude", "codex"], /* … */ },
    "effortRunnersFor": { "mapper": ["claude", "codex"], /* … */ },
    "agentToolStages": ["mapper", "review.standards", "review.spec", "review.correctness"],
    "agentNames": { "mapper": "ralph-mapper", "review.standards": "ralph-review-standards", "review.spec": "ralph-review-spec", "review.correctness": "ralph-review-correctness" },
    "aliases": ["opus", "sonnet", "haiku", "fable"],
    "defaultFallback": "opus",
    "modelId": { "pattern": "…", "providerPrefix": { "claude": "optional", "opencode": "required", "codex": "forbidden" } }
  },
  "shadows": [
    { "stage": "mapper", "field": "model", "variable": "RALPH_MODEL_MAPPER" }
  ]
}
```

`shadows` names the exact variable an operator must unset when a live
environment override would win over the file — `RALPH_MODEL_<STAGE>`,
`RALPH_RUNNER_<STAGE>`, `RALPH_MODEL_ORCHESTRATOR_EFFORT`, and the legacy
`RALPH_CODER_MODEL` for the executor. The editor never modifies the environment.

## Architecture

- `contracts.ts` — the editor's own typed view models, and nothing else.
- `adapter.ts` — **the only code that chooses the CLI invocation** (command,
  flags, environment) **and owns the JSON shapes.** Besides the three
  `models.ts` flags it runs `../harness-catalog.ts --json`, the one command
  that asks the harnesses rather than the resolver. It narrows and validates
  every response and fails loudly with `LineupContractError` (naming the command
  and the unexpected output) on drift; a resolver refusal becomes
  `LineupRefusedError` carrying the resolver's own message. Read is a health
  check: it resolves the current file through the same CLI the supervisor runs,
  and a missing or malformed file is refused by that CLI at its real path, so
  the restore guidance is the resolver's, naming the root's own checkout.
- `config.ts` — the listen address, the configured roots, and the harness
  directory (derived from this file's location, never `pwd`).
- `server.ts` — a thin HTTP adapter: parse the request, call the adapter,
  serialize. No projection or validation logic, no subprocess, no file write,
  and no `ralph/*.ts` import.
- `assets.ts` — reads the static page once at startup, so the handlers hold no
  filesystem call.
- `static/` — the page and its helper module (see [The page](#the-page)).
- `../lineup-editor.ts` — the pure edit/validate/serialize layer and the atomic
  writer, reused unchanged from issue #9. It imports no `ralph/*.ts` and hands a
  candidate to `models.ts --validate`; the adapter still chooses every
  read/preview/save invocation and its environment.

## Tests

```bash
bun x vitest run lineup
```

The adapter is tested against the **real `ralph/models.ts`** CLI on scratch
checkout roots, including contract-drift cases. The HTTP tests spawn the actual
Bun server on an ephemeral loopback port and drive it with `fetch`.
`boundary.test.ts` pins the import allow-list, the CLI flag surface, and the
single validated write path.
