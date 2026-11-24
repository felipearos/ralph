// @vitest-environment node
/**
 * What the supervisor does around an iteration.
 *
 * `ralph.sh` spends almost all of its wall-clock time inside one `claude -p`
 * call, and nothing about that call is testable. Everything around it is, and
 * it is the part that decides whether a loop left running overnight is still
 * running in the morning:
 *
 *   - *The gate is opt-in.* Adding a waiting mode to the supervisor that runs
 *     the backlog every night is only safe if the ungated path is untouched.
 *     "Untouched" is asserted, not assumed: the ungated supervisor must not
 *     call the gate at all, and must still stop on `ALL_BLOCKED`.
 *   - *Gated, `ALL_BLOCKED` is not the end.* A loop meant to be started once
 *     and left running has to treat "nothing right now" as a wait. The
 *     ungated supervisor treats the same sigil as a stop, and both are right.
 *   - *A missing sigil stays fatal in both modes.* It means the iteration died
 *     for an unknown reason; waiting would restart the same failure until the
 *     cap ran out.
 *   - *Each worktree is one named loop.* Two supervisors work one tracker, so
 *     everything an iteration leaves behind — the claim label, the branch, the
 *     PR stamp — has to say which one wrote it. The name comes from the
 *     worktree rather than from an exported variable an operator has to
 *     remember, and an unrecognised one is refused: a loop claiming under a
 *     label no other loop reads has no fence at all.
 *   - *Two supervisors get two run ids.* The id is what `usage.py` totals by,
 *     so a collision reports one run whose tokens are secretly the sum of two,
 *     which is precisely what starting a second loop would produce, since the
 *     old id was a whole-second timestamp and nothing else.
 *
 * Driven against a scratch worktree with fake `doppler`, `claude`, `uuidgen`
 * and `bun` on PATH: the seams this script depends on are subprocesses, and a
 * fake binary tests the seam where a mock would test the mock. Nothing here
 * spawns a model, reads Doppler, or touches GitHub.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { WAIT_RESULT } from './dashboard/ci-health';
import { HELD_CONTROL_EXIT, HELD_CONTROL_LINE } from './host-lease';
import { subprocessSuite } from './test-timeouts';

subprocessSuite('runs ralph.sh through bash against fixture repos');

const HARNESS = __dirname;

/**
 * The real `bun`, resolved before any fake shadows it.
 *
 * `process.execPath` is whatever is running vitest, which is not necessarily
 * bun — and a stub that exec'd it produced an empty transcript and an empty
 * error capture, which every assertion below then passed against vacuously.
 * That is the failure mode worth naming: a redaction test that asserts a
 * secret is ABSENT passes perfectly when nothing was written at all.
 */
const REAL_BUN = spawnSync('command', ['-v', 'bun'], { shell: true, encoding: 'utf8' }).stdout.trim();

const scratchRoots: string[] = [];
afterAll(() => scratchRoots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const writeExecutable = (path: string, lines: string[]): void => {
  writeFileSync(path, [...lines, ''].join('\n'));
  chmodSync(path, 0o755);
};

/**
 * The fixture project's own environment check — what loggd commits as
 * `scripts/check-loop-env.ts` and names in `envCheck`. The harness no longer
 * knows what a safe database target is; it only has to RUN the project's check,
 * under the injected environment, before every child, and refuse when it
 * fails. This stand-in keeps the development credential fence tests meaningful:
 * it passes on the development project and fails, without printing the value,
 * on anything else.
 */
const FIXTURE_ENV_CHECK = [
  "const DEV = 'ovboxcgaezdrluuepdmg';",
  "const hostOk = (value: string): boolean => {",
  "  try { const url = new URL(value); return url.hostname === `db.${DEV}.supabase.co` || (url.hostname.endsWith('.pooler.supabase.com') && decodeURIComponent(url.username).endsWith(`.${DEV}`)); } catch { return false; }",
  "};",
  "try {",
  "  for (const name of ['DATABASE_URL', 'SUPABASE_DB_URL', 'DATABASE_DIRECT_URL']) {",
  "    const value = process.env[name];",
  "    if (!value && name === 'DATABASE_DIRECT_URL') continue;",
  "    if (!value) throw new Error(`${name} is required for the development loop`);",
  "    if (!hostOk(value)) throw new Error(`${name} must target Supabase project ${DEV}`);",
  "  }",
  "  if (process.env.NEXT_PUBLIC_SUPABASE_URL !== `https://${DEV}.supabase.co`) throw new Error(`NEXT_PUBLIC_SUPABASE_URL must target Supabase project ${DEV}`);",
  "} catch (error) { console.error(error instanceof Error ? error.message : 'verification failed'); process.exitCode = 1; }",
  "",
].join("\n");

/** Loggd's `.ralph/config.json`, which the scratch project commits. */
const FIXTURE_CONFIG = {
  repo: 'felipearos/loggd',
  owner: 'felipearosr',
  baseBranch: 'main',
  displayName: 'Loggd',
  secrets: {
    runner: 'doppler',
    project: 'loggd-web',
    config: 'dev',
    withhold: [
      'PRODUCTION_MIGRATIONS_DATABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SELF_HOSTED_RUNNER_GH_PAT',
      'BUILDKITE_AGENT_TOKEN',
      'BUILDKITE_API_TOKEN',
      'BUILDKITE_OPERATOR_TOKEN',
      'RENOVATE_TOKEN',
    ],
  },
  refuseFiles: ['.env.local'],
  envCheck: ['bun', '--no-env-file', 'scripts/check-loop-env.ts'],
  requiredChecks: ['buildkite/loggd', 'Vercel'],
  gates: { test: 'bun run test', typecheck: 'bun run typecheck', build: 'bun run build' },
  promptFragment: '.ralph/prompt.md',
  coderFragment: '.ralph/coder.md',
  plan: '.ralph/plan.md',
  journal: { dir: 'journal/loggd' },
  loops: ['ralph', 'rafa', 'remo', 'rulo'],
};

/** Where `ralph.sh` looks for a project's sleep marker, as a bash statement setting `$marker`. */
const SLEEP_MARKER =
  'common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null); marker="${common:+$common/ralph-sleep.json}"; marker="${marker:-$PWD/.ralph-sleep.json}"';

/**
 * A project worktree (`root`) with loggd's `.ralph/config.json`, and a
 * separate harness checkout (`home`) holding the real `ralph.sh` and
 * stand-ins for everything it shells out to. `ralph.sh` resolves RALPH_HOME
 * from its own location and the project from its cwd, so the two are wholly
 * separate directories — as `~/ralph` and a project worktree are.
 */
function scratchWorktree(): { root: string; home: string; bin: string; argv: () => string[] } {
  const scratch = mkdtempSync(join(tmpdir(), 'loggd-ralph-'));
  scratchRoots.push(scratch);
  const root = join(scratch, 'project');
  const home = join(scratch, 'home');
  mkdirSync(join(root, '.ralph', 'logs'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(home, 'frontier'), { recursive: true });
  mkdirSync(join(home, 'triage'), { recursive: true });
  // The frontier reads every tracker through `tracker/` (#330), whole, so an
  // adapter added there cannot leave the scratch harness unable to load it.
  cpSync(join(HARNESS, 'tracker'), join(home, 'tracker'), { recursive: true });
  const bin = join(scratch, 'bin');
  mkdirSync(bin);
  writeFileSync(join(root, '.ralph', 'config.json'), JSON.stringify(FIXTURE_CONFIG, null, 2));
  writeFileSync(join(root, 'scripts', 'check-loop-env.ts'), FIXTURE_ENV_CHECK);

  // The real redaction module and everything it imports, copied in so that
  // the pattern file it reads from its own location is the SCRATCH harness's.
  // Exec'ing the repo's copy instead meant a test that corrupted the scratch
  // `runner-signals.json` was silently read against the real, valid one: the
  // drain path never ran and the assertion passed for the wrong reason.
  for (const file of [
    'runner-failure.ts',
    'development-env.sh',
    // Sourced by ralph.sh for its signal traps.
    'signal-stop.sh',
    'project.sh',
    'paths.ts',
    'project-config.ts',
    'project-id.ts',
    'roles.ts',
    // The supervisor evals this one at startup for the role's sigils, phases,
    // secrets, invariant and host lease (#140), so a scratch harness without
    // it refuses to start at all.
    'role-behaviour.ts',
    'roster.ts',
    'claim-lease.ts',
    'ship-prompt.ts',
    'phase-prompt.ts',
    'phase.ts',
    'runner-signals.json',
    'stream-render.py',
    'codex-orchestrator.py',
    'timeline.py',
    'jav.ts',
    'block-reason.ts',
    // `frontier/next-tasks.ts` reads the triager's marker off an issue's
    // comments (#143), so a scratch harness without it cannot build the
    // frontier at all.
    'triage-marker.ts',
    // And the Slack intake's labels, for a triager's bucket on a keyed
    // tracker (#396).
    'triage/intake.ts',
    // And it sizes a ticket by the section under one heading (#150's rescue
    // work moved that anchor to a leaf so three layers could share it).
    'sections.ts',
    // And it skips ticket keys a PR body quotes as code (#17).
    'markdown-code.ts',
    'executor-budget.ts',
    'frontier/next-tasks.ts',
    'frontier/github-rate-limit.ts',
    // `frontier/next-tasks.ts` and the supervisor record into the speed
    // ledger (#578), so the copies cannot load without it.
    'speed.ts',
    // It reads a live loop branch as a claim on its ticket (#480).
    'frontier/branch-claims.ts',
    'backoff.ts',
    // The backoff joins the shared blocker store on a settle (#430).
    'blocker-store.ts',
    // The frontier reads the park store to withhold a live park (#776).
    'park-store.ts',
    'usage-limit.ts',
    'control-inbox.ts',
    // Every wait between iterations asks it whether the project sleeps.
    'project-sleep.ts',
    'pr-wait.ts',
    'merge-wait.ts',
    'host-lease.ts',
    // The heartbeat renews the lease store the loop's ROLE owns (#138), so the
    // scratch harness carries that module and the ci-doctor store it reaches.
    'role-leases.ts',
    'ci-doctor/store.ts',
    // And the verifier's watch store, whose check-in leases it renews (#565).
    'verifier/watches.ts',
    // And the sentinel's issue store, whose issue leases it renews (#681).
    'sentinel/store.ts',
    // Every named secret is read through the secret-source seam (#759), run
    // for real so the fake doppler on PATH answers it.
    'secrets/read.ts',
    'secrets/source.ts',
    // The record a holding role's gate holds on (#771), run for real: what it
    // writes and clears is what the hold tests read back.
    'gate-verdict-store.ts',
  ]) {
    cpSync(join(HARNESS, file), join(home, file));
  }

  cpSync(join(HARNESS, 'ralph.sh'), join(home, 'ralph.sh'));
  chmodSync(join(home, 'ralph.sh'), 0o755);
  writeFileSync(join(home, 'prompt.md'), 'a stub prompt\n');
  mkdirSync(join(home, 'prompts'), { recursive: true });
  for (const role of ['triager', 'ci-doctor', 'pr-medic', 'clerk', 'sentinel']) {
    writeFileSync(join(home, 'prompts', `${role}.md`), `a stub ${role} prompt\n`);
  }
  // The orchestrator rails, both files, real rather than stubbed: whether
  // `ralph.sh` hands each to the session is what the rails tests below read,
  // and without the harness one every claude start refuses ("the orchestrator
  // rails … cannot be read").
  cpSync(join(HARNESS, 'claude-orchestrator-settings.json'), join(home, 'claude-orchestrator-settings.json'));
  mkdirSync(join(home, 'pr-medic'), { recursive: true });
  cpSync(join(HARNESS, 'pr-medic', 'orchestrator-settings.json'), join(home, 'pr-medic', 'orchestrator-settings.json'));
  mkdirSync(join(home, 'clerk'), { recursive: true });
  cpSync(join(HARNESS, 'clerk', 'orchestrator-settings.json'), join(home, 'clerk', 'orchestrator-settings.json'));
  // The sentinel's own rails, for its gate's re-read tests (#759); `sentinel/`
  // is already there for its issue store.
  cpSync(join(HARNESS, 'sentinel', 'orchestrator-settings.json'), join(home, 'sentinel', 'orchestrator-settings.json'));
  writeFileSync(join(root, '.env.test'), 'DATABASE_URL=postgresql://postgres@127.0.0.1:54322/postgres\n');
  const argvFile = join(root, 'argv.log');
  writeFileSync(argvFile, '');
  writeExecutable(join(home, 'usage.py'), [
    '#!/bin/sh',
    `printf 'usage %s\n' "$*" >> ${JSON.stringify(argvFile)}`,
    'exit 0',
  ]);
  const record = `printf '%s\\n' "$*" >> ${JSON.stringify(argvFile)}`;

  // `doppler run -- <cmd>` is a pass-through here: the withheld-secret filter
  // it wraps is asserted by nothing in this file, and re-implementing it in a
  // fake would only test the fake.
  // FAKE_DOPPLER_LOCKED_READS=<n> fails the first n `secrets get` reads the way
  // a login keyring still locked at boot does (2026-10-29), counted in a file.
  // FAKE_DOPPLER_LOCKED_NAME narrows that to one secret's reads, so a role
  // with two secrets locks the one under test. FAKE_DOPPLER_LOCKED_UNTIL_TURN
  // fails every read until the fake claude's first turn unlocks the keyring:
  // the only shape that tells "read before this iteration" from "after".
  const dopplerLockedFile = join(root, 'doppler.locked');
  const dopplerUnlockedFile = join(root, 'doppler.unlocked');
  writeExecutable(join(bin, 'doppler'), [
    '#!/bin/sh',
    `${record}`,
    `if [ "$1 $2" = "secrets get" ] && [ -n "\${FAKE_DOPPLER_LOCKED_UNTIL_TURN:-}" ] && [ ! -f ${JSON.stringify(dopplerUnlockedFile)} ]; then`,
    '  echo "Doppler Error: failed to unlock correct collection \'/org/freedesktop/secrets/collection/login\'" >&2; exit 1',
    'fi',
    'if [ "$1 $2" = "secrets get" ] && [ -n "${FAKE_DOPPLER_LOCKED_READS:-}" ]'
      + ' && { [ -z "${FAKE_DOPPLER_LOCKED_NAME:-}" ] || [ "$3" = "$FAKE_DOPPLER_LOCKED_NAME" ]; }; then',
    `  locked=$(( $(cat ${JSON.stringify(dopplerLockedFile)} 2>/dev/null || echo 0) + 1 ))`,
    `  printf '%s' "$locked" > ${JSON.stringify(dopplerLockedFile)}`,
    '  [ "$locked" -le "$FAKE_DOPPLER_LOCKED_READS" ] && { echo "Doppler Error: failed to unlock correct collection \'/org/freedesktop/secrets/collection/login\'" >&2; exit 1; }',
    'fi',
    // FAKE_BUILDKITE_SECRET is the scope's RALPH_BUILDKITE_READ_TOKEN, read
    // once by the supervisor for CI log access; unset, the scope has none and
    // `secrets get` fails the way Doppler's not-found does.
    'if [ "$1 $2 $3" = "secrets get RALPH_BUILDKITE_READ_TOKEN" ]; then [ -n "${FAKE_BUILDKITE_SECRET:-}" ] || { echo "Doppler Error: Could not find requested secret: RALPH_BUILDKITE_READ_TOKEN" >&2; exit 1; }; printf "%s" "$FAKE_BUILDKITE_SECRET"; exit 0; fi',
    // FAKE_GATE_CREDENTIAL is a gate-scoped credential: read by name like the
    // one above, and injected into every child like the one above, which is
    // what makes "absent from the iteration" a claim about the STRIP rather
    // than about nobody having put it there. NOT spelt `FAKE_GATE_TOKEN_SECRET`:
    // `<NAME>_SECRET` renames the scope entry the supervisor reads, so that
    // spelling would be taken as the entry's NAME and the read would go looking
    // for a secret called after this value.
    'if [ "$1 $2 $3" = "secrets get FAKE_GATE_TOKEN" ]; then [ -n "${FAKE_GATE_CREDENTIAL:-}" ] || { echo "Doppler Error: Could not find requested secret: FAKE_GATE_TOKEN" >&2; exit 1; }; printf "%s" "$FAKE_GATE_CREDENTIAL"; exit 0; fi',
    // FAKE_CLERK_SLACK / FAKE_CLERK_JIRA are the clerk's two tokens, stored in
    // the scope only: the clerk's children are never wrapped in `doppler run`,
    // so a read by name is the one way they reach its gate (#358).
    'if [ "$1 $2 $3" = "secrets get RALPH_CLERK_SLACK_TOKEN" ] && [ -n "${FAKE_CLERK_SLACK:-}" ]; then printf "%s" "$FAKE_CLERK_SLACK"; exit 0; fi',
    'if [ "$1 $2 $3" = "secrets get RALPH_CLERK_JIRA_TOKEN" ] && [ -n "${FAKE_CLERK_JIRA:-}" ]; then printf "%s" "$FAKE_CLERK_JIRA"; exit 0; fi',
    // FAKE_SENTINEL_SENTRY is the sentinel's reporter token, read by name the
    // same way and handed to its gate alone (#759).
    'if [ "$1 $2 $3" = "secrets get RALPH_SENTINEL_SENTRY_TOKEN" ] && [ -n "${FAKE_SENTINEL_SENTRY:-}" ]; then printf "%s" "$FAKE_SENTINEL_SENTRY"; exit 0; fi',
    // FAKE_RETRY_SECRET is the ci-doctor's gate-only Buildkite retry token (#759).
    'if [ "$1 $2 $3" = "secrets get RALPH_BUILDKITE_RETRY_TOKEN" ] && [ -n "${FAKE_RETRY_SECRET:-}" ]; then printf "%s" "$FAKE_RETRY_SECRET"; exit 0; fi',
    'if [ "$1 $2" = "secrets get" ]; then exit 1; fi',
    'if [ "$1" = "secrets" ]; then exit 0; fi',
    // FAKE_INJECTED_VALUE stands in for an injected credential. Its own name
    // is deliberately NOT secret-shaped: as `…_SECRET` it matched the env-name
    // rules itself, so the redactor could credit either variable and the label
    // depended on `Object.entries` order — green here and red in CI. `doppler run`
    // scopes the command it wraps and NOT its pipeline siblings, so this is
    // what lets a test tell a redactor that was given the secrets from one
    // that was quietly running on the supervisor's own environment and
    // striking nothing but shapes.
    'if [ "$1" = "run" ]; then shift; [ "$1 $2 $3 $4" = "-p loggd-web -c dev" ] || exit 90; shift 4; [ "$1" = "--" ] && shift;',
    // FAKE_SECRETS_ENV_FAILS fails only the bare `… true` probe the supervisor
    // runs after the preflight, so its earlier `secrets get` reads still work.
    '  if [ -n "${FAKE_SECRETS_ENV_FAILS:-}" ]; then for a; do last="$a"; done; [ "$last" = true ] && exit 1; fi',
    // FAKE_SECRETS_ENV_FAIL_TIMES=<n> fails that same probe n times, after
    // FAKE_SECRETS_ENV_FAILS_AFTER=<k> passing ones (default 1, the startup
    // probe), then passes again: a scope that becomes unreadable between
    // startup and a turn, and reads again later (#759). Counted in a file.
    // FAKE_SECRETS_ENV_ERROR replaces its error text, e.g. an auth failure.
    '  if [ -n "${FAKE_SECRETS_ENV_FAIL_TIMES:-}" ]; then for a; do last="$a"; done; if [ "$last" = true ]; then',
    `    probes=$(( $(cat ${JSON.stringify(join(root, 'doppler.probes'))} 2>/dev/null || echo 0) + 1 ))`,
    `    printf '%s' "$probes" > ${JSON.stringify(join(root, 'doppler.probes'))}`,
    '    if [ "$probes" -gt "${FAKE_SECRETS_ENV_FAILS_AFTER:-1}" ] && [ "$probes" -le $(( ${FAKE_SECRETS_ENV_FAILS_AFTER:-1} + FAKE_SECRETS_ENV_FAIL_TIMES )) ]; then',
    '      [ -n "${FAKE_SECRETS_ENV_ERROR:-}" ] && { echo "$FAKE_SECRETS_ENV_ERROR" >&2; exit 1; }',
    '      echo "Doppler Error: failed to unlock correct collection \'/org/freedesktop/secrets/collection/login\'" >&2; echo "second line of detail" >&2; exit 1',
    '    fi; fi; fi',
    '  if [ -n "${FAKE_INJECTED_VALUE:-}" ]; then INJECTED_API_TOKEN="$FAKE_INJECTED_VALUE"; export INJECTED_API_TOKEN; fi',
    // Like the real `doppler run`, it injects every secret in the scope,
    // the CI-log token included, whatever the supervisor decided about it.
    '  if [ -n "${FAKE_BUILDKITE_SECRET:-}" ]; then RALPH_BUILDKITE_READ_TOKEN="$FAKE_BUILDKITE_SECRET"; export RALPH_BUILDKITE_READ_TOKEN; fi',
    '  if [ -n "${FAKE_GATE_CREDENTIAL:-}" ]; then FAKE_GATE_TOKEN="$FAKE_GATE_CREDENTIAL"; export FAKE_GATE_TOKEN; fi',
    '  export DATABASE_URL="${DATABASE_URL-postgresql://postgres:test@db.ovboxcgaezdrluuepdmg.supabase.co/postgres}"',
    '  export SUPABASE_DB_URL="${SUPABASE_DB_URL-postgresql://postgres.test.ovboxcgaezdrluuepdmg:test@aws-0-us-east-1.pooler.supabase.com/postgres}"',
    '  export NEXT_PUBLIC_SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL-https://ovboxcgaezdrluuepdmg.supabase.co}"',
    '  exec "$@"; fi',
    'exit 0',
  ]);
  // FAKE_SIGIL_ALTERNATE makes the iteration report blocked, then working, then
  // blocked… — the only shape that can tell a streak counter that resets from
  // one that does not.
  const counterFile = join(root, 'iterations.count');
  const preflightOnceFile = join(root, 'preflight.once');
  const preflightAskedFile = join(root, 'preflight.asked');
  const viewCountFile = join(root, 'tracker-view.count');
  const controlOnceFile = join(root, 'control.once');
  const controlPollsFile = join(root, 'control.polls');
  const phaseHoldsFile = join(root, 'phase-control.holds');
  const phaseRetryFile = join(root, 'phase-control.retried');
  const leaseProbes = join(root, 'lease-probes');
  const gateAnsweredFile = join(root, 'gate.answered');
  const turnHeldFile = join(root, 'turn-held');
  const gateOnceFile = join(root, 'gate.once');
  const gateBrokenFile = join(root, 'gate.broken');
  const usageCommandFile = join(root, 'usage-command.once');
  writeExecutable(join(bin, 'claude'), [
    '#!/bin/sh',
    // ONE append per turn, and that is load-bearing rather than tidy. Two
    // supervisors run concurrently in the same scratch worktree — that is what
    // the run-identity test below exists to drive — and they share this file.
    // Four separate `>>` writes per turn gave them four windows to interleave
    // in, and an interleaved write splits a line, so a run id that WAS recorded
    // stops matching and the loop that wrote it reads as never having started.
    // A single `printf` is one `O_APPEND` write, which the two cannot tear.
    //
    // The whole invocation goes on one line with it: the model flags and the
    // rendered prompt are both arguments, and both are what this file pins.
    'argv_line="$(printf \'%s\' "$*" | tr -d \'\\n\')"',
    // `injected` says whether the injected credential REACHED this process —
    // recorded here, in a file no redactor touches, so a withhold that failed
    // cannot be hidden by the transcript redaction striking the value later.
    `printf 'claude run-id=%s\\nclaude loop=%s\\nclaude iteration=%s\\nclaude timeline=%s\\nclaude injected=%s\\nclaude buildkite=%s\\nclaude role=%s\\nclaude case=%s\\nclaude argv=%s\\n' `
      + `"$RALPH_RUN_ID" "$RALPH_LOOP_NAME" "$RALPH_ITERATION" "$RALPH_TIMELINE" "\${INJECTED_API_TOKEN:+set}" "\${RALPH_BUILDKITE_READ_TOKEN:-}" "\${RALPH_LOOP_ROLE:-}" "\${RALPH_INTAKE_CASE:-}" "$argv_line" >> ${JSON.stringify(argvFile)}`,
    // Separate from the line above so a test can read it without parsing prose:
    // whether a gate-scoped credential reached the model session at all.
    `printf 'claude gate-secret=%s\\n' "\${FAKE_GATE_TOKEN:-}" >> ${JSON.stringify(argvFile)}`,
    // Whether the ci-doctor's gate-only retry token reached the session —
    // set or unset, never the value.
    `if [ -n "\${RALPH_BUILDKITE_RETRY_TOKEN:-}" ]; then t=set; else t=unset; fi; printf 'claude retry-token=%s\\n' "$t" >> ${JSON.stringify(argvFile)}`,
    // The first turn unlocks the fake keyring, after this turn's environment
    // was recorded above.
    `[ -n "\${FAKE_DOPPLER_LOCKED_UNTIL_TURN:-}" ] && : > ${JSON.stringify(dopplerUnlockedFile)}`,
    // Likewise the clerk's two tokens, which are gate secrets too.
    `printf 'claude clerk-tokens=%s%s\\n' "\${RALPH_CLERK_SLACK_TOKEN:-}" "\${RALPH_CLERK_JIRA_TOKEN:-}" >> ${JSON.stringify(argvFile)}`,
    // The pr-medic's hand-over, as fields of their own (felipearos/ralph#246).
    `printf 'claude intake-pr=%s\\nclaude intake-reason=%s\\n' "\${RALPH_INTAKE_PR-unset}" "\${RALPH_INTAKE_REASON-unset}" >> ${JSON.stringify(argvFile)}`,
    // The supervisor's two name lists, which `preflight.ts` reads to tell an
    // armed credential from a withheld one. Names only; no value appears here.
    `printf 'claude secrets-available=%s\\nclaude secrets-withheld=%s\\n' "\${RALPH_ROLE_SECRETS_AVAILABLE:-}" "\${RALPH_ROLE_SECRETS_WITHHELD:-}" >> ${JSON.stringify(argvFile)}`,
    // Whether a park hand-off (#776) was already lying in the worktree when
    // this turn began: one iteration's hand-off must never reach the next.
    `if [ -f .ralph/logs/block-park.json ]; then p=present; else p=absent; fi; printf 'claude block-park-at-start=%s\\n' "$p" >> ${JSON.stringify(argvFile)}`,
    // The park hand-off a blocked session writes before `tracker.ts blocked`
    // (#776), written before any stream so a rejected turn leaves one too.
    '[ -n "${FAKE_SESSION_BLOCK_PARK:-}" ] && printf \'%s\' "$FAKE_SESSION_BLOCK_PARK" > .ralph/logs/block-park.json',
    '[ -n "${FAKE_STREAM_FILE:-}" ] && { cat "$FAKE_STREAM_FILE"; exit ${FAKE_CLAUDE_STATUS:-0}; }',
    // FAKE_STREAM_SEQUENCE="a|b" cats the n-th file as the n-th turn's stream,
    // exiting FAKE_STREAM_SEQUENCE_STATUS; every turn past the list falls
    // through to the ordinary result below. The trailing `|` keeps `cut` from
    // printing a one-entry list for every n.
    'if [ -n "${FAKE_STREAM_SEQUENCE:-}" ]; then',
    `  n=$(cat ${JSON.stringify(counterFile)} 2>/dev/null || echo 0)`,
    `  n=$((n + 1)); printf '%s' "$n" > ${JSON.stringify(counterFile)}`,
    '  stream="$(printf \'%s|\' "$FAKE_STREAM_SEQUENCE" | cut -d \'|\' -f "$n")"',
    '  [ -n "$stream" ] && { cat "$stream"; exit ${FAKE_STREAM_SEQUENCE_STATUS:-0}; }',
    'fi',
    // Long enough for a background budget guard to act while the turn runs.
    '[ -n "${FAKE_TURN_DELAY:-}" ] && sleep "$FAKE_TURN_DELAY"',
    'emit_result() {',
    '  printf \'{"type":"result","subtype":"success","result":"%s","usage":{"input_tokens":1,"output_tokens":2,"cache_creation_input_tokens":3,"cache_read_input_tokens":4,"output_tokens_details":{"thinking_tokens":1}},"permission_denials":[]}\\n\' "$1"',
    '}',
    // FAKE_SIGIL_SEQUENCE="a|b|c" ends the n-th turn with the n-th entry,
    // and every turn past the list with no sigil at all.
    'if [ -n "${FAKE_SIGIL_SEQUENCE:-}" ]; then',
    `  n=$(cat ${JSON.stringify(counterFile)} 2>/dev/null || echo 0)`,
    `  n=$((n + 1)); printf '%s' "$n" > ${JSON.stringify(counterFile)}`,
    '  sigil="$(printf \'%s\' "$FAKE_SIGIL_SEQUENCE" | cut -d \'|\' -f "$n")"',
    '  emit_result "${sigil:-no sigil}"',
    '  exit 0',
    'fi',
    'if [ -n "${FAKE_FIRST_SIGIL:-}" ]; then',
    `  n=$(cat ${JSON.stringify(counterFile)} 2>/dev/null || echo 0)`,
    `  n=$((n + 1)); printf '%s' "$n" > ${JSON.stringify(counterFile)}`,
    '  if [ "$n" -eq 1 ]; then emit_result "$FAKE_FIRST_SIGIL"; else emit_result "${FAKE_RECOVERY_SIGIL:-no recovery sigil}"; fi',
    '  exit 0',
    'fi',
    'if [ -n "${FAKE_SIGIL_ALTERNATE:-}" ]; then',
    `  n=$(cat ${JSON.stringify(counterFile)} 2>/dev/null || echo 0)`,
    `  n=$((n + 1)); printf '%s' "$n" > ${JSON.stringify(counterFile)}`,
    '  if [ $((n % 2)) -eq 1 ]',
    '    then sigil="<ralph>ALL_BLOCKED</ralph>"',
    '    else sigil="<ralph>DONE</ralph>"',
    '  fi',
    '  emit_result "$sigil"',
    '  exit 0',
    'fi',
    // A runner that leaves a live descendant behind holding the inherited
    // stderr open after it exits — a dev server, a stray `delegate.sh`, any
    // orphan. This is the shape that hangs a supervisor which `wait`s for its
    // stderr reader to see EOF, and it is entirely ordinary.
    // stdout CLOSED for the orphan (`1>/dev/null`), stderr inherited. With
    // stdout held too, `| tee` blocks for the orphan's whole life whatever the
    // stderr capture does — so the old version of this fake passed identically
    // under the unbounded `wait` it was written to catch.
    '[ -n "${FAKE_ORPHAN:-}" ] && { sleep "${FAKE_ORPHAN}" 1>/dev/null & }',
    // A runner that echoes its own environment back — which is exactly how a
    // credential reaches a transcript in the first place.
    '[ -n "${INJECTED_API_TOKEN:-}" ] && printf \'{"type":"assistant","message":{"content":[{"type":"text","text":"leaked %s"}]}}\\n\' "$INJECTED_API_TOKEN"',
    '[ -n "${INJECTED_API_TOKEN:-}" ] && printf \'stderr leaked %s\\n\' "$INJECTED_API_TOKEN" >&2',
    // A session that wrote to the worktree — the violation a read-only role's
    // post-iteration invariant exists to repair (#140). Written from the model
    // process, so the supervisor sees it exactly as it would in the wild.
    '[ -n "${FAKE_SESSION_WRITES:-}" ] && printf \'stray\\n\' > "${FAKE_SESSION_WRITES}"',
    // The blocker a RETRY_LATER iteration names for the backoff (#428),
    // written where the prompt tells the session to write it.
    '[ -n "${FAKE_SESSION_BLOCKER:-}" ] && printf \'%s\' "$FAKE_SESSION_BLOCKER" > .ralph/logs/retry-blocker.json',
    'emit_result "${FAKE_SIGIL:-<ralph>DONE</ralph>}"',
    // A `claude -p` that exits non-zero on an expired credential or a usage
    // limit is the case the supervisor used to lose entirely: the pipeline
    // discarded the status, and the failure arrived as a missing sigil.
    'exit ${FAKE_CLAUDE_STATUS:-0}',
  ]);
  writeExecutable(join(bin, 'uuidgen'), ['#!/bin/sh', 'echo 00000000-0000-4000-8000-000000000000']);
  // `gh pr view` answers with FAKE_PR_VIEW, the PR state the backoff
  // fingerprints; FAKE_PR_VIEW_MOVES gives every read a new head, which is
  // what an iteration that pushes looks like from outside.
  const prViewCount = join(root, 'pr-view.count');
  writeExecutable(join(bin, 'gh'), [
    '#!/bin/sh',
    'if [ "$1 $2" = "pr view" ]; then',
    '  [ -n "${FAKE_PR_VIEW:-}" ] || exit 1',
    '  if [ -n "${FAKE_PR_VIEW_MOVES:-}" ]; then',
    `    n=$(cat ${JSON.stringify(prViewCount)} 2>/dev/null || echo 0); n=$((n + 1)); printf '%s' "$n" > ${JSON.stringify(prViewCount)}`,
    '    printf \'%s\\n\' "$FAKE_PR_VIEW" | sed "s/HEADSHA/head$n/"',
    '  else printf \'%s\\n\' "$FAKE_PR_VIEW" | sed "s/HEADSHA/head0/"; fi',
    '  exit 0',
    'fi',
    'if [ -n "${FAKE_OWN_CLAIM:-}" ]; then echo 1; else echo 0; fi',
  ]);

  // The scratch worktree is not a git repository, so `git` is a stand-in whose
  // answers the freshness guard is steered by. Defaults to "fresh": HEAD and
  // origin/main are the same sha, which is what every test that is not about
  // freshness needs to be true so the guard stays out of its way.
  writeExecutable(join(bin, 'git'), [
    '#!/bin/sh',
    // Recorded like every other fake, because the guard now MOVES the checkout
    // in one case and the only proof of that is the command it ran.
    `printf 'git %s\\n' "$*" >> ${JSON.stringify(argvFile)}`,
    // `git -C <harness> …` is the harness freshness check. Behind only when a
    // test asks: HEAD differs from origin/main and is its ancestor.
    'if [ "$1" = "-C" ]; then',
    '  case "$3 $4" in',
    '    "rev-parse --git-dir") echo .git; exit 0 ;;',
    '    "rev-parse HEAD") echo "${FAKE_HOME_HEAD:-hhhh111}"; exit 0 ;;',
    '    "rev-parse origin/main") echo "${FAKE_HOME_MAIN:-hhhh111}"; exit 0 ;;',
    '  esac',
    '  exit 0',
    'fi',
    'if [ "$1 $2" = "status --porcelain" ]; then printf \'%s\\n\' "${FAKE_DIRTY:-}"; exit 0; fi',
    // A diff with a BODY, so a test can tell a patch that was written from an
    // empty file the shell redirection created on its own. Printed only once
    // something has been staged with `--intent-to-add`, which is the step that
    // puts a file the role CREATED into the patch — delete that step and this
    // prints nothing.
    `if [ "$1" = add ]; then : > ${JSON.stringify(join(root, 'git.staged'))}; exit 0; fi`,
    `if [ "$1" = diff ]; then [ -f ${JSON.stringify(join(root, 'git.staged'))} ] && printf '%s\\n' "diff --git a/stray.txt b/stray.txt" "+stray"; exit 0; fi`,
    // The branch a phase boundary records and a resume checks; detached unless
    // a test names one. FAKE_GONE_SHA is a commit no longer in HEAD's history.
    'if [ "$1 $2" = "branch --show-current" ]; then printf \'%s\\n\' "${FAKE_BRANCH:-}"; exit 0; fi',
    'if [ "$1 $2" = "merge-base --is-ancestor" ] && [ -n "${FAKE_GONE_SHA:-}" ] && [ "$3" = "$FAKE_GONE_SHA" ]; then exit 1; fi',
    'case "$1 $2" in',
    // `rev-parse --git-dir` decides whether the guard runs at all.
    '  "rev-parse --git-dir") [ -n "${FAKE_NOT_A_REPO:-}" ] && exit 1; echo .git; exit 0 ;;',
    '  "fetch --quiet") [ -n "${FAKE_FETCH_FAILS:-}" ] && exit 1; exit 0 ;;',
    '  "checkout --detach") [ -n "${FAKE_CHECKOUT_FAILS:-}" ] && exit 1; exit 0 ;;',
    'esac',
    'case "$1" in',
    '  rev-parse)',
    '    case "$2" in',
    '      HEAD) echo "${FAKE_HEAD:-aaaa111}" ;;',
    '      origin/main) echo "${FAKE_MAIN:-aaaa111}" ;;',
    '    esac',
    '    exit 0 ;;',
    // Exit 0 means "HEAD is an ancestor of origin/main", i.e. behind with
    // nothing of its own — the only state the guard refuses.
    '  merge-base) [ -n "${FAKE_HAS_OWN_COMMITS:-}" ] && exit 1; exit 0 ;;',
    'esac',
    'exit 0',
  ]);
  // The gate itself is pinned by `frontier-gate.test.ts` and the resolver by
  // `models.test.ts`; what matters here is that the supervisor asks each one,
  // and what it does with the answer. One fake `bun` serves both, dispatching
  // on the script it was handed — the supervisor calls them the same way, so a
  // stub that ignored its arguments would answer the resolver with gate text.
  // Recorded with the harness prefix written as `ralph/`, so an assertion reads
  // `ralph/frontier-gate.ts --once` whatever temp directory the harness is in.
  writeExecutable(join(bin, 'bun'), [
    '#!/bin/bash',
    `args="$*"; printf '%s\\n' "\${args//\${RALPH_HOME:-/nonexistent}\\//ralph/}" >> ${JSON.stringify(argvFile)}`,
    `[ "$1" = "--no-env-file" ] && exec ${JSON.stringify(REAL_BUN)} "$@"`,
    'case "$1" in',
    // The project config is read for real: it is what ralph.sh evals, and a
    // stub could not prove the loggd values reach doppler and the env filter.
    `  *project-config.ts) exec ${JSON.stringify(REAL_BUN)} "$@" ;;`,
    // The supervisor's own inline reads (the preflight's verdict file) run for
    // real: what they print is what is under test.
    `  -e) exec ${JSON.stringify(REAL_BUN)} "$@" ;;`,
    // Read for real too, and for the same reason: `ralph.sh` EVALS what it
    // prints — the role's sigils, phases, secrets, invariant and host lease
    // (#140) — so a stub would be inventing the fence under test.
    `  *role-behaviour.ts) exec ${JSON.stringify(REAL_BUN)} "$@" ;;`,
    // The secret-source seam, for real (#759): the fake doppler answers it.
    `  *secrets/read.ts) exec ${JSON.stringify(REAL_BUN)} "$@" ;;`,
    `  *executor-budget.ts) exec ${JSON.stringify(REAL_BUN)} "$@" ;;`,
    // The gate verdict record (#771), for real, in the scratch worktree's
    // `.ralph/logs/` unless a test points RALPH_GATE_VERDICT_STORE elsewhere.
    `  *gate-verdict-store.ts) exec ${JSON.stringify(REAL_BUN)} "$@" ;;`,
    // The loop's open claims, through the project's tracker (#334): FAKE_OWN_CLAIM
    // is this loop holding #1, exactly as the `gh issue list` stub answered.
    '  *tracker.ts)',
    '    [ "$2" = claimed ] && [ -n "${FAKE_OWN_CLAIM:-}" ] && echo 1',
    // The ticket's state at a phase boundary (#809): `view <n> --json`
    // hangs, fails, prints FAKE_VIEW_RAW as given, or prints FAKE_VIEW_STATE
    // as the state. FAKE_VIEW_STATE_SEQUENCE="a|b" answers the n-th view with
    // the n-th entry, counted in a file, and FAKE_VIEW_STATE past the list.
    '    if [ "$2" = view ] && [ "${4:-}" = --json ]; then',
    '      [ -n "${FAKE_VIEW_HANG:-}" ] && exec sleep "$FAKE_VIEW_HANG"',
    '      [ -n "${FAKE_VIEW_EXIT:-}" ] && exit "$FAKE_VIEW_EXIT"',
    '      [ -n "${FAKE_VIEW_RAW:-}" ] && { printf \'%s\\n\' "$FAKE_VIEW_RAW"; exit 0; }',
    '      state="${FAKE_VIEW_STATE:-}"',
    '      if [ -n "${FAKE_VIEW_STATE_SEQUENCE:-}" ]; then',
    `        viewed=$(( $(cat ${JSON.stringify(viewCountFile)} 2>/dev/null || echo 0) + 1 ))`,
    `        printf '%s' "$viewed" > ${JSON.stringify(viewCountFile)}`,
    '        listed="$(printf \'%s|\' "$FAKE_VIEW_STATE_SEQUENCE" | cut -d \'|\' -f "$viewed")"',
    '        [ -n "$listed" ] && state="$listed"',
    '      fi',
    '      [ -n "$state" ] && printf \'{"number":%s,"state":"%s"}\\n\' "$3" "$state"',
    '    fi',
    '    exit 0 ;;',
    // The preflight's own checks are pinned by `preflight.test.ts`; what
    // matters here is that the supervisor asks it before the gate, and what it
    // does with each of its three answers.
    '  *preflight.ts)',
    // The classifier the per-turn scope probe asks (#759), pinned for real by
    // `preflight.test.ts`; here only whether the supervisor acts on its answer.
    // Outside the ask counter, so it never shifts a preflight test's count.
    '    if [ "${2:-}" = "--doppler-failure" ]; then grep -qi unauthorized && echo denied || echo unavailable; exit 0; fi',
    // FAKE_PREFLIGHT_UNAVAILABLE_ONCE is unavailable on the first ask and
    // ready afterwards — the only shape that can tell a supervisor that waits
    // and re-asks from one that waits forever.
    // FAKE_PREFLIGHT_UNAVAILABLE_TIMES=<n> is the same for the first n asks,
    // counted in a file, which is what a wait long enough to alert needs.
    // Either way the verdict file names doppler-scope, like the real one would.
    `    asked=$(( $(cat ${JSON.stringify(preflightAskedFile)} 2>/dev/null || echo 0) + 1 ))`,
    `    printf '%s' "$asked" > ${JSON.stringify(preflightAskedFile)}`,
    // FAKE_PREFLIGHT_BROKEN_TIMES=<n> is a preflight that could not run for
    // n asks — exit FAKE_PREFLIGHT_BROKEN_STATUS (126, the `Text file busy`
    // of #767, by default; 1 is a preflight.ts bun could not load), no
    // verdict file — and ready after. They follow the
    // FAKE_PREFLIGHT_UNAVAILABLE_TIMES asks, so one run can wait on both kinds.
    '    if [ "$asked" -gt "${FAKE_PREFLIGHT_UNAVAILABLE_TIMES:-0}" ] '
      + '&& [ "$asked" -le $(( ${FAKE_PREFLIGHT_UNAVAILABLE_TIMES:-0} + ${FAKE_PREFLIGHT_BROKEN_TIMES:-0} )) ]; then',
    '      printf \'%s\\n\' "bun: Text file busy"',
    '      exit ${FAKE_PREFLIGHT_BROKEN_STATUS:-126}',
    '    fi',
    '    if { [ -n "${FAKE_PREFLIGHT_UNAVAILABLE_ONCE:-}" ] && [ ! -f '
      + JSON.stringify(preflightOnceFile)
      + ' ]; } || [ "$asked" -le "${FAKE_PREFLIGHT_UNAVAILABLE_TIMES:-0}" ]; then',
    `      : > ${JSON.stringify(preflightOnceFile)}`,
    `      [ -n "\${RALPH_PREFLIGHT_JSON:-}" ] && printf '%s' '{"verdict":"unavailable","checks":[{"name":"doppler-scope","outcome":{"status":"unavailable","why":"the Doppler secrets could not be read"}}]}' > "$RALPH_PREFLIGHT_JSON"`,
    '      printf \'%s\\n\' "preflight: doppler-scope — the Doppler secrets could not be read (unavailable, not denied)"',
    '      exit 2',
    '    fi',
    // Like the real `checkClerkCredentials`: a secret the supervisor could not
    // read from Doppler is a wait, asked again once it has been re-read.
    '    if [ -n "${FAKE_PREFLIGHT_SEES_UNREAD:-}" ] && [ -n "${RALPH_ROLE_SECRETS_UNREAD:-}" ]; then',
    `      [ -n "\${RALPH_PREFLIGHT_JSON:-}" ] && printf '%s' '{"verdict":"unavailable","checks":[{"name":"clerk-credentials","outcome":{"status":"unavailable","why":"unread"}}]}' > "$RALPH_PREFLIGHT_JSON"`,
    '      printf \'%s\\n\' "preflight: clerk-credentials — unread (unavailable, not denied)"',
    '      exit 2',
    '    fi',
    // FAKE_PREFLIGHT_CHECKS is the verdict file's body, written as given: the
    // supervisor reads the failing checks' names from it. A denial without it
    // still writes a file naming no checks, as the real one always writes one
    // on reaching a verdict — no file at all is a preflight that never ran.
    '    [ -n "${RALPH_PREFLIGHT_JSON:-}" ] && [ -n "${FAKE_PREFLIGHT_CHECKS:-}" ] && printf \'%s\' "$FAKE_PREFLIGHT_CHECKS" > "$RALPH_PREFLIGHT_JSON"',
    '    [ -n "${RALPH_PREFLIGHT_JSON:-}" ] && [ -z "${FAKE_PREFLIGHT_CHECKS:-}" ] && [ "${FAKE_PREFLIGHT_STATUS:-0}" = 1 ] '
      + '&& printf \'%s\' \'{"verdict":"denied","checks":[]}\' > "$RALPH_PREFLIGHT_JSON"',
    '    printf \'%s\\n\' "${FAKE_PREFLIGHT_OUTPUT:-preflight: ready — 8 checks passed}"',
    '    exit ${FAKE_PREFLIGHT_STATUS:-0} ;;',
    '  *models.ts)',
    '    [ -n "${FAKE_LINEUP_STATUS:-}" ] && { echo "models: broken lineup" >&2; exit ${FAKE_LINEUP_STATUS}; }',
    // `--render-prompt` is the real renderer's job (models.test.ts pins it);
    // here it only has to prove the supervisor hands the RENDERED prompt to
    // `claude` rather than the file, and that a refusal stops the run.
    '    if [ "$2" = "--render-prompt" ]; then',
    '      [ -n "${FAKE_RENDER_STATUS:-}" ] && { echo "models: unrendered placeholder" >&2; exit ${FAKE_RENDER_STATUS}; }',
    // The render pass must see the operator's environment, not this script's
    // own exports — so a test can ask what it saw.
    '      [ -n "${FAKE_ECHO_RENDER_ENV:-}" ] && { printf \'effort=[%s]\' "${RALPH_MODEL_ORCHESTRATOR_EFFORT-<unset>}"; exit 0; }',
    // The supervisor names the ROLE, not the file (#134). This mirrors the
    // paths `roles.ts` declares — `roles.test.ts` is what pins them against the
    // descriptor; here they are copied, so a descriptor that moved would leave
    // this fake resolving the old path.
    '      template="$3"',
    '      if [ "$3" = "--role" ]; then',
    '        case "$4" in',
    '          coder) template="$(dirname "$1")/prompt.md" ;;',
    '          *) template="$(dirname "$1")/prompts/$4.md" ;;',
    '        esac',
    '      fi',
    // An unreadable template exits 1, like the real renderer: printing
    //`rendered:` and exiting 0 would get past the supervisor's empty-prompt
    // guard and buy a whole iteration on two words.
    '      if [ -z "${FAKE_RENDERED_PROMPT+set}" ] && ! [ -r "$template" ]; then',
    '        echo "models: cannot read $template" >&2; exit 1',
    '      fi',
    '      printf \'%s\' "${FAKE_RENDERED_PROMPT-rendered:$(cat "$template")}"',
    '      exit 0',
    '    fi',
    '    printf \'%s\\n\' "${FAKE_LINEUP_EXPORTS:-'
      + "export RALPH_MODEL_ORCHESTRATOR='claude-opus-5'\n"
      + "export RALPH_RUNNER_ORCHESTRATOR='claude'\n"
      + "export RALPH_MODEL_EXECUTOR='opencode-go/deepseek-v4-flash'\n"
      + "export RALPH_RUNNER_EXECUTOR='opencode'\n"
      + "export RALPH_MODEL_MAPPER='sonnet'\n"
      + "export RALPH_RUNNER_MAPPER='claude'\n"
      + "export RALPH_MODEL_REVIEW_STANDARDS='opus'\n"
      + "export RALPH_RUNNER_REVIEW_STANDARDS='claude'\n"
      + "export RALPH_MODEL_REVIEW_SPEC='opus'\n"
      + "export RALPH_RUNNER_REVIEW_SPEC='claude'\n"
      + "export RALPH_MODEL_ORCHESTRATOR_EFFORT='medium'\n"
      + "export RALPH_MODEL_STAGE_VARS='RALPH_MODEL_ORCHESTRATOR RALPH_MODEL_EXECUTOR RALPH_MODEL_MAPPER RALPH_MODEL_REVIEW_STANDARDS RALPH_MODEL_REVIEW_SPEC'\n"
      + "export RALPH_RUNNER_STAGE_VARS='RALPH_RUNNER_ORCHESTRATOR RALPH_RUNNER_EXECUTOR RALPH_RUNNER_MAPPER RALPH_RUNNER_REVIEW_STANDARDS RALPH_RUNNER_REVIEW_SPEC'"
      + '}"',
    '    exit 0 ;;',
    // The record's own shape is pinned by `loop-state.test.ts`; what matters
    // here is WHICH events the supervisor writes and that a failure to write
    // one never reaches the loop. Without this branch it would fall through to
    // the gate stub below and answer bookkeeping with gate text.
    '  *loop-state.ts)',
    '    exit ${FAKE_RECORD_STATUS:-0} ;;',
    // Likewise: `runner-failure.test.ts` pins what an observation contains,
    // and `delegate.test.ts` pins that a denied runner produces one. What
    // matters HERE is that the supervisor observes the orchestrator's own turn
    // at all, and hands it the exit status the pipeline actually returned —
    // which this script used to throw away.
    '  *runner-failure.ts)',
    // `redact` is a FILTER standing between `claude` and the iteration log, so
    // a stub that swallows stdin empties the log and every sigil assertion in
    // this file fails at once. That is the right failure — it is what proves
    // the supervisor really pipes its transcript through the redactor — but
    // the stub has to pass the stream through to test anything past it.
    // `FAKE_REDACT_STATUS` drives the other half: a redactor that cannot run
    // must not leave a transcript on disk.
    '    if [ "$2" = "redact" ]; then',
    '      [ -n "${FAKE_REDACT_STATUS:-}" ] && exit "$FAKE_REDACT_STATUS"',
    // REAL_REDACT runs the actual filter instead of a pass-through, so a test
    // can assert on what it did rather than on the fact that it was called.
    // The SCRATCH copy, so the config it reads is the scratch's. `"$@"` from
    // `shift` onwards carries `--done`, which is what keeps the supervisor's
    // process substitution a single command.
    `      if [ -n "\${REAL_REDACT:-}" ]; then shift; exec ${JSON.stringify(REAL_BUN)} "\${RALPH_HOME}/runner-failure.ts" "$@"; fi`,
    // `--done` has to be honoured even by the pass-through, because the
    // supervisor's wait for that marker is what BOUNDS it. A stub that
    // swallowed the flag made every iteration in this file pay the full 10s
    // cap, which read as the whole suite hanging.
    '      done_file=""; prev=""',
    '      for a in "$@"; do [ "$prev" = "--done" ] && done_file="$a"; prev="$a"; done',
    '      cat',
    '      [ -n "$done_file" ] && : > "$done_file"',
    '      exit 0',
    '    fi',
    '    [ "$2" = "status" ] && printf \'%s\\n\' "${FAKE_FAILURE_LINE:-runner failures: none recorded for this run}"',
    '    exit ${FAKE_OBSERVE_STATUS:-0} ;;',
    // `await-pr-check.test.ts` pins the judge; here FAKE_AWAIT_PR_CHECK is a
    // refusal (exit 3 with the message), and otherwise it passes or fails
    // with FAKE_AWAIT_PR_CHECK_STATUS, silently.
    '  *await-pr-check.ts)',
    '    if [ -n "${FAKE_AWAIT_PR_CHECK:-}" ]; then printf \'%s\\n\' "$FAKE_AWAIT_PR_CHECK"; exit 3; fi',
    '    exit ${FAKE_AWAIT_PR_CHECK_STATUS:-0} ;;',
    // `pr-wait.test.ts` pins the waiter; here it answers with whatever the
    // test says the PR did, so the supervisor's handling of each outcome is
    // what is under test.
    '  *pr-wait.ts)',
    // FAKE_PR_WAIT_SEQUENCE: a file of results, one per line, answered in order.
    '    if [ -n "${FAKE_PR_WAIT_SEQUENCE:-}" ]; then n=$(( $(cat "$FAKE_PR_WAIT_SEQUENCE.n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAKE_PR_WAIT_SEQUENCE.n"; sed -n "${n}p" "$FAKE_PR_WAIT_SEQUENCE"; exit 0; fi',
    '    if [ -n "${FAKE_PR_WAIT_RESULT:-}" ]; then printf \'%s\\n\' "$FAKE_PR_WAIT_RESULT"; else printf \'%s\\n\' \'{"outcome":"merged","mode":"merge","pr":"7"}\'; fi',
    '    exit 0 ;;',
    // `host-lease.test.ts` pins the lease's policy; here `acquire` answers
    // FAKE_HOST_LEASE_RESULT, the resumed prompt is the real one, and the
    // turn bookkeeping is a no-op every other test walks through silently.
    '  *host-lease.ts)',
    '    case "$2" in',
    '      acquire) printf \'%s\\n\' "${FAKE_HOST_LEASE_RESULT:-{\\"outcome\\":\\"refused\\",\\"ticket\\":1604,\\"command\\":null,\\"expiresAt\\":null,\\"detail\\":\\"no request file\\"\\}}" ;;',
    `      prompt) exec ${JSON.stringify(REAL_BUN)} "$@" ;;`,
    // FAKE_TURN_BEGIN_HOLD=<command>: the first turn is held with that operator
    // command in the inbox, which the real `turn-begin` answers by handing back
    // (exit 3). The marker file makes it happen once, so the supervisor's loop
    // gets past it when the checkpoint lets the turn through.
    // FAKE_TURN_BEGIN_STATUS is any other status, which must never fail a turn.
    `      turn-begin) if [ -n "\${FAKE_TURN_BEGIN_HOLD:-}" ] && [ ! -f ${JSON.stringify(turnHeldFile)} ]; then`,
    `        : > ${JSON.stringify(turnHeldFile)}`,
    // FAKE_TURN_BEGIN_SLEEP puts the project to sleep while the turn is held.
    `        [ -n "\${FAKE_TURN_BEGIN_SLEEP:-}" ] && { ${SLEEP_MARKER}; printf '{"version":1,"since":"2026-11-05T23:00:00.000Z"}' > "$marker"; }`,
    '        mkdir -p .ralph/control/inbox',
    `        printf '{"version":1,"id":"held-1","command":"%s","why":"from the test"}' "$FAKE_TURN_BEGIN_HOLD" > .ralph/control/inbox/held-1.json`,
    `        echo ${JSON.stringify(HELD_CONTROL_LINE)}; exit ${HELD_CONTROL_EXIT}; fi`,
    `      exit "\${FAKE_TURN_BEGIN_STATUS:-0}" ;;`,
    '    esac',
    '    exit 0 ;;',
    // The real prompt builder: it is pure, and the fresh session's prompt is
    // exactly what these tests read back out of the fake claude's argv.
    `  *ship-prompt.ts) exec ${JSON.stringify(REAL_BUN)} "$@" ;;`,
    // The real phase ledger and resume prompt, for the same reason.
    `  *phase.ts) exec ${JSON.stringify(REAL_BUN)} "$@" ;;`,
    `  *phase-prompt.ts) exec ${JSON.stringify(REAL_BUN)} "$@" ;;`,
    // The real backoff: its decisions are pinned by `backoff.test.ts`, and
    // here the knobs are shrunk to seconds so a whole streak fits in a test.
    // FAKE_BACKOFF_EXHAUSTED=<text>: the wait is spent and leaves <text> as the
    // shared exhaustion record (#431), which is the CLI's job and pinned there.
    '  *backoff.ts)',
    '    if [ "$2" = wait ] && [ -n "${FAKE_BACKOFF_EXHAUSTED:-}" ]; then',
    '      printf \'%s\' "$FAKE_BACKOFF_EXHAUSTED" > .ralph/logs/backoff-exhausted.json',
    '      echo "backoff: spent the shared budget — escalating to a human."; exit 3',
    '    fi',
    `    exec ${JSON.stringify(REAL_BUN)} "$@" ;;`,
    // The real usage-limit reader, pinned by `usage-limit.test.ts`. With
    // FAKE_USAGE_WAIT_COMMAND (`stop` or `pause`) the first `remaining` drops
    // that operator command into the inbox, which is how one ARRIVES DURING
    // the wait for the reset rather than at a checkpoint.
    '  *usage-limit.ts)',
    `    if [ "$2" = remaining ] && [ -n "\${FAKE_USAGE_WAIT_COMMAND:-}" ] && [ ! -f ${JSON.stringify(usageCommandFile)} ]; then`,
    `      : > ${JSON.stringify(usageCommandFile)}`,
    '      mkdir -p .ralph/control/inbox',
    '      extra=""; [ "$FAKE_USAGE_WAIT_COMMAND" = stop ] && extra=\',"stop":"completed"\'',
    '      printf \'{"version":1,"id":"usage-1","command":"%s"%s,"why":"from the test"}\' "$FAKE_USAGE_WAIT_COMMAND" "$extra" > .ralph/control/inbox/usage-1.json',
    '    fi',
    // FAKE_USAGE_WAIT_SLEEP puts the project to sleep during the wait instead.
    `    if [ "$2" = remaining ] && [ -n "\${FAKE_USAGE_WAIT_SLEEP:-}" ] && [ ! -f ${JSON.stringify(usageCommandFile)} ]; then`,
    `      : > ${JSON.stringify(usageCommandFile)}; ${SLEEP_MARKER}`,
    '      printf \'{"version":1,"since":"2026-11-05T23:00:00.000Z","why":"bedtime"}\' > "$marker"',
    '    fi',
    `    exec ${JSON.stringify(REAL_BUN)} "$@" ;;`,
    // The token check's own rules are pinned by `bk-log.test.ts`; here it
    // answers FAKE_BK_CHECK_STATUS, and says which token it was handed.
    // `claim-race.test.ts` pins how a lost race is recognised; here it answers
    // what the test says the gate's ticket looked like afterwards.
    // FAKE_CLAIM_RACE="0 1 1" answers the n-th ask with the n-th exit status —
    // 0 lost, 1 unexplained, 3 unreadable — and the last one thereafter.
    '  *claim-race.ts)',
    `    asks=$(( $(cat ${JSON.stringify(join(root, 'claim-race.count'))} 2>/dev/null || echo 0) + 1 ))`,
    `    printf '%s' "$asks" > ${JSON.stringify(join(root, 'claim-race.count'))}`,
    '    set -- ${FAKE_CLAIM_RACE:-1}; [ "$asks" -le $# ] && code="${!asks}" || code="${!#}"',
    '    case "$code" in',
    '      0) echo "lost the claim race for #1 to rafa (labeled rafa-wip)" ;;',
    '      1) echo "#1 is not claimed by another loop" ;;',
    '      3) echo "could not tell whether #1 was claimed by another loop: gh: API rate limit exceeded" ;;',
    '    esac',
    '    exit "$code" ;;',
    '  *bk-log.ts)',
    '    if [ "${FAKE_BK_CHECK_STATUS:-0}" = 0 ]; then echo "bk-log: Buildkite token ok, read-only (read_builds)"; else echo "bk-log: the Buildkite token is not read-only (write_builds); refusing to use it" >&2; fi',
    '    exit ${FAKE_BK_CHECK_STATUS:-0} ;;',
    // FAKE_BUDGET_TRIP=<tokens> trips the cap once, at the first guard — or at
    // the FAKE_BUDGET_TRIP_ON-th: the marker is the supervisor's whole
    // interface to the real guard.
    '  *iteration-budget.ts)',
    `    guards=$(( $(cat ${JSON.stringify(join(root, 'guards.count'))} 2>/dev/null || echo 0) + 1 ))`,
    `    printf '%s' "$guards" > ${JSON.stringify(join(root, 'guards.count'))}`,
    '    if [ -n "${FAKE_BUDGET_TRIP:-}" ] && [ "$guards" -ge "${FAKE_BUDGET_TRIP_ON:-1}" ] && [ ! -f '
      + JSON.stringify(join(root, 'budget.once'))
      + ' ]; then',
    `      : > ${JSON.stringify(join(root, 'budget.once'))}`,
    '      marker=""; prev=""; limit=""',
    '      for a in "$@"; do [ "$prev" = "--marker" ] && marker="$a"; [ "$prev" = "--limit" ] && limit="$a"; prev="$a"; done',
    '      printf \'{"session":"s","used":%s,"limit":%s}\\n\' "$FAKE_BUDGET_TRIP" "$limit" > "$marker"',
    '      exit 3',
    '    fi',
    '    exit 0 ;;',
    // The plugin host's own behaviour is pinned by `plugins.test.ts`; what
    // matters here is that the supervisor hands it the SAME events as the
    // durable record, makes no call to it at all when no plugin is enabled,
    // and that a host which cannot run never reaches the loop.
    '  *plugins.ts)',
    '    [ "$2" = "status" ] && printf \'%s\\n\' "${FAKE_PLUGIN_LINE:-Plugins: orca ok}"',
    '    exit ${FAKE_PLUGIN_STATUS:-0} ;;',
    // The real lease tool only when a test asks for it: every `record` pulses
    // it, and the rest of this file has no lease to renew.
    '  *claim-lease.ts)',
    // Where the watcher was told to log, and one line on its stderr, so a
    // test can see both reach the log file rather than /dev/null.
    `    [ "$2 $3" = "heartbeat --watch" ] && printf 'heartbeat-log=%s\\n' "\${RALPH_LEASE_HEARTBEAT_LOG:-}" >> ${JSON.stringify(argvFile)}`,
    `    [ -n "\${REAL_LEASE:-}" ] && exec ${JSON.stringify(REAL_BUN)} "$@"`,
    '    [ "$2 $3" = "heartbeat --watch" ] && echo "fake watcher stderr" >&2',
    '    exit 0 ;;',
    // The control channel's own behaviour is pinned by
    // `controls.test.ts`; what matters here is what the SUPERVISOR does
    // with each of its three verdicts, and that a channel which cannot run
    // never holds or stops a loop. FAKE_CONTROL_HOLDS=<n> holds for the first
    // n polls and continues afterwards — a count rather than a flag, because
    // the supervisor's park loop does different work on its FIRST hold (say,
    // record) than on the ones after it (renew the lease), and only a hold
    // that lasts more than one poll reaches the second.
    // The real sleep reader, which `control_pending` asks once a marker is there.
    '  *project-sleep.ts)',
    `    exec ${JSON.stringify(REAL_BUN)} ${JSON.stringify(join(HARNESS, 'project-sleep.ts'))} "\${@:2}" ;;`,
    '  *controls.ts)',
    // REAL_CONTROLS runs the real channel on the worktree's own inbox, for the
    // cases that need its rules and the supervisor's together. With
    // FAKE_GATE_ANSWER set (`approve` or `deny`), the first approval hold it
    // answers is then answered, as an operator on the dashboard would, so the
    // supervisor's next poll reads the answer.
    '    if [ -n "${REAL_CONTROLS:-}" ]; then',
    `      ${JSON.stringify(REAL_BUN)} ${JSON.stringify(join(HARNESS, 'controls.ts'))} "\${@:2}"; code=$?`,
    // FAKE_WAKE_ON_HOLD wakes a sleeping project at its first hold, as an
    // operator would from the dashboard.
    `      if [ "$code" -eq 10 ] && [ -n "\${FAKE_WAKE_ON_HOLD:-}" ]; then ${SLEEP_MARKER}; rm -f "$marker"; fi`,
    `      if [ "$code" -eq 10 ] && [ -n "\${FAKE_GATE_ANSWER:-}" ] && [ ! -f ${JSON.stringify(gateAnsweredFile)} ]; then`,
    `        : > ${JSON.stringify(gateAnsweredFile)}`,
    `        printf '{"version":1,"id":"answer-1","command":"%s","why":"from the test"}' "$FAKE_GATE_ANSWER" > .ralph/control/inbox/answer-1.json`,
    '      fi',
    '      exit "$code"',
    '    fi',
    '    [ "$2" = "status" ] && { printf \'%s\\n\' "${FAKE_CONTROL_LINE:-Controls: running}"; exit 0; }',
    // A poll at a phase boundary (`--phase`) answers from its own knobs, so a
    // test can hold or stop there without touching the iteration's checkpoint.
    // FAKE_PHASE_HOLDS=<n> holds for the first n phase polls, and with
    // FAKE_LEASE_PROBE set each of those polls reads the REAL lease store —
    // what another loop deciding whether it may take the ticket would see.
    // FAKE_PHASE_STOP stops there; FAKE_PHASE_STATUS is a channel that broke.
    // FAKE_PHASE_RETRY=<phase> answers the first poll at the boundary after
    // <phase> with an operator's retry of it, once, as `controls.ts` does.
    '    if [[ " $* " == *" --phase "* ]]; then',
    '      if [ -n "${FAKE_PHASE_HOLDS:-}" ]; then',
    `        held=$(cat ${JSON.stringify(phaseHoldsFile)} 2>/dev/null || echo 0)`,
    '        if [ "$held" -lt "$FAKE_PHASE_HOLDS" ]; then',
    `          printf '%s' "$((held + 1))" > ${JSON.stringify(phaseHoldsFile)}`,
    '          if [ -n "${FAKE_LEASE_PROBE:-}" ]; then',
    `            mkdir -p ${JSON.stringify(leaseProbes)}`,
    `            { date +%s%3N; ${JSON.stringify(REAL_BUN)} "\${RALPH_HOME}/claim-lease.ts" status --json; } > ${JSON.stringify(leaseProbes)}/"$held".txt`,
    '          fi',
    '          printf \'%s\\n\' "hold\tpause\tpause after review"',
    '          exit 10',
    '        fi',
    '      fi',
    '      [ -n "${FAKE_PHASE_STOP:-}" ] && { printf \'%s\\n\' "stop\t${FAKE_PHASE_STOP}\tstop before it opens a PR"; exit 20; }',
    '      [ -n "${FAKE_PHASE_STATUS:-}" ] && { echo "controls: broken"; exit "$FAKE_PHASE_STATUS"; }',
    `      if [ -n "\${FAKE_PHASE_RETRY:-}" ] && [[ " $* " == *" --after \${FAKE_PHASE_RETRY} "* ]] && [ ! -f ${JSON.stringify(phaseRetryFile)} ]; then`,
    `        : > ${JSON.stringify(phaseRetryFile)}`,
    '        printf \'%s\\n\' "retry\t${FAKE_PHASE_RETRY}\tnew reviewer model"',
    '        exit 30',
    '      fi',
    '      printf \'%s\\n\' "continue\t-\tnothing is holding this loop"',
    '      exit 0',
    '    fi',
    '    if [ -n "${FAKE_CONTROL_HOLDS:-}" ]; then',
    `      held=$(cat ${JSON.stringify(controlOnceFile)} 2>/dev/null || echo 0)`,
    '      if [ "$held" -lt "$FAKE_CONTROL_HOLDS" ]; then',
    `        printf '%s' "$((held + 1))" > ${JSON.stringify(controlOnceFile)}`,
    '        printf \'%s\\n\' "${FAKE_CONTROL_HOLD_LINE:-hold\thold\tan operator paused this loop}"',
    '        exit 10',
    '      fi',
    '    fi',
    // FAKE_CONTROL_STOP_FROM=<n>: polls before the n-th continue, and the
    // n-th and later stop — the shape of a stop that arrives while the loop
    // is somewhere other than its checkpoint.
    '    if [ -n "${FAKE_CONTROL_STOP_FROM:-}" ]; then',
    `      polls=$(( $(cat ${JSON.stringify(controlPollsFile)} 2>/dev/null || echo 0) + 1 ))`,
    `      printf '%s' "$polls" > ${JSON.stringify(controlPollsFile)}`,
    '      if [ "$polls" -ge "$FAKE_CONTROL_STOP_FROM" ]; then',
    '        printf \'%s\\n\' "stop\tblocked\tstopped from the dashboard"',
    '        exit 20',
    '      fi',
    '    fi',
    '    printf \'%s\\n\' "${FAKE_CONTROL_VERDICT:-continue\t-\tnothing is holding this loop}"',
    '    exit ${FAKE_CONTROL_STATUS:-0} ;;',
    // A role's secret checker, for the fake gate-scoped credential below: the
    // check passing or failing is the supervisor's decision to make, so the
    // checker itself is a stub with an exit code a test can set.
    '  *fake-check.ts) printf \'fake-check: ok\\n\'; exit ${FAKE_CHECK_STATUS:-0} ;;',
    // The clerk's two token checks (felipearos/ralph#317, #318), stubbed the
    // same way: whether the supervisor hands the tokens on is under test here,
    // and `clerk/slack.test.ts` and `clerk/jira.test.ts` pin the checks.
    '  *clerk/slack.ts|*clerk/jira.ts) printf \'clerk-check: ok\\n\'; exit 0 ;;',
    // The sentinel's Sentry token check, stubbed likewise; FAKE_SENTINEL_CHECK_STATUS
    // refuses the token the way a revoked or under-scoped one is refused.
    '  *sentinel/credentials.ts) printf \'sentinel-check: ok\\n\'; exit ${FAKE_SENTINEL_CHECK_STATUS:-0} ;;',
    // The real speed ledger only when a test asks for it, like the lease:
    // two writes per iteration in every test would be load for nothing.
    `  *speed.ts) [ -n "\${REAL_SPEED:-}" ] && exec ${JSON.stringify(REAL_BUN)} "$@"; exit 0 ;;`,
    // The park sweep (#775), whose own behaviour `park-probe.test.ts` pins:
    // here it only has to be called, and to be harmless however it ends.
    // REAL_PARK_SWEEP runs real bun on the scratch harness, which carries no
    // `park-probe.ts` — a missing file; FAKE_PARK_SWEEP_CRASH dies on a signal.
    '  *park-probe.ts)',
    `    [ -n "\${REAL_PARK_SWEEP:-}" ] && exec ${JSON.stringify(REAL_BUN)} "$@"`,
    '    [ -n "${FAKE_PARK_SWEEP_CRASH:-}" ] && kill -SEGV $$',
    '    echo "park-probe: swept, nothing due"',
    '    exit ${FAKE_PARK_SWEEP_STATUS:-0} ;;',
    // The plan usage stop, whose verdicts `usage-stop.test.ts` pins: here
    // FAKE_USAGE_STOP answers the n-th check with the n-th of its `|`-separated
    // lines (`\t` between fields), and `run` after the last — a stop that
    // clears is a sequence that ends.
    // The auto model updates (#851), pinned for real by `model-updates.test.ts`:
    // FAKE_MODEL_UPDATES is what it printed, FAKE_MODEL_UPDATES_STATUS a run
    // that failed with a reason on stderr.
    '  *model-updates.ts)',
    '    [ -n "${FAKE_MODEL_UPDATES_STATUS:-}" ] && { echo "model-updates: cannot read models.json" >&2; exit "$FAKE_MODEL_UPDATES_STATUS"; }',
    '    [ -n "${FAKE_MODEL_UPDATES:-}" ] && printf \'%s\\n\' "$FAKE_MODEL_UPDATES"',
    '    exit 0 ;;',
    '  *usage-stop.ts)',
    `    stops=$(( $(cat ${JSON.stringify(join(root, 'usage-stop.count'))} 2>/dev/null || echo 0) + 1 ))`,
    `    printf '%s' "$stops" > ${JSON.stringify(join(root, 'usage-stop.count'))}`,
    '    answer="$(printf \'%s\\n\' "${FAKE_USAGE_STOP:-}" | awk -F"|" -v n="$stops" \'{print $n}\')"',
    '    printf \'%b\\n\' "${answer:-run\\t0\\t-\\tno usage stop}"',
    '    exit 0 ;;',
    'esac',
    // Whether the supervisor asked the blocking gate to sweep too (#775).
    `[ -n "\${RALPH_PARK_SWEEP_IN_GATE:-}" ] && printf 'gate park-sweep-in-gate=%s\\n' "$RALPH_PARK_SWEEP_IN_GATE" >> ${JSON.stringify(argvFile)}`,
    // Every gate call records whether the gate-scoped credential reached it:
    // written here, in the gate's own process, so a fence that leaked to the
    // iteration instead cannot be mistaken for one that worked.
    `printf 'gate secret=%s\\n' "\${FAKE_GATE_TOKEN:-}" >> ${JSON.stringify(argvFile)}`,
    // The sentinel's gate records only WHETHER its token arrived, never the
    // value: a test asserting the value appears nowhere reads this file too.
    `case "$1" in *sentinel/gate.ts) if [ -n "\${RALPH_SENTINEL_SENTRY_TOKEN:-}" ]; then t=set; else t=unset; fi; printf 'gate sentry-token=%s\\n' "$t" >> ${JSON.stringify(argvFile)} ;; esac`,
    // The ci-doctor's retry token likewise: set or unset, never the value (#759).
    `case "$1" in *ci-doctor/gate.ts) if [ -n "\${RALPH_BUILDKITE_RETRY_TOKEN:-}" ]; then t=set; else t=unset; fi; printf 'gate retry-token=%s\\n' "$t" >> ${JSON.stringify(argvFile)} ;; esac`,
    // FAKE_GATE_BROKEN_UNTIL=<n>: the first n gate calls never reach a verdict,
    // the way a spawn failure does not — the message is the one loggd's rafa
    // took on 2026-10-07 — and the (n+1)-th answers normally. Exit 2 is what
    // `frontier-gate.ts` itself uses for "it threw"; a real `ETXTBSY` is the
    // shell's own status, and the supervisor treats every non-verdict exit
    // alike, so one stands in for both.
    // FAKE_GATE_BROKEN_EVERY_OTHER breaks every second ask instead, which is
    // the only shape that can tell a streak counted per ask from one counted
    // for the whole run.
    'if [ "${1##*/}" = frontier-gate.ts ] &&'
      + ' { [ -n "${FAKE_GATE_BROKEN_UNTIL:-}" ] || [ -n "${FAKE_GATE_BROKEN_EVERY_OTHER:-}" ]; }; then',
    `  asked=$(( $(cat ${JSON.stringify(gateBrokenFile)} 2>/dev/null || echo 0) + 1 ))`,
    `  printf '%s' "$asked" > ${JSON.stringify(gateBrokenFile)}`,
    '  if [ "$asked" -le "${FAKE_GATE_BROKEN_UNTIL:-0}" ] ||'
      + ' { [ -n "${FAKE_GATE_BROKEN_EVERY_OTHER:-}" ] && [ $((asked % 2)) -eq 1 ]; }; then',
    // FAKE_GATE_STOP_ON_BREAK drops an operator's stop into the inbox as it
    // breaks, which is how a stop ARRIVES DURING the retry wait rather than at
    // a checkpoint the supervisor was already standing on.
    '    if [ -n "${FAKE_GATE_STOP_ON_BREAK:-}" ]; then',
    '      mkdir -p .ralph/control/inbox',
    '      printf \'{"version":1,"id":"stop-1","command":"stop","stop":"completed","why":"that is enough for tonight"}\''
      + ' > .ralph/control/inbox/stop-1.json',
    '    fi',
    "    printf 'ETXTBSY: text file is busy, posix_spawn %s\\n' \"'bun'\" >&2",
    '    exit 2',
    '  fi',
    'fi',
    // FAKE_GATE_SEES_HELD: each coder gate call logs the verdict record as it
    // stood when the gate was asked (#771), so a test can tell what the
    // supervisor cleared or kept BEFORE the next answer, not only at the end.
    'if [ -n "${FAKE_GATE_SEES_HELD:-}" ] && [ "${1##*/}" = frontier-gate.ts ]; then',
    `  held="$(tr -d ' \\n' < "\${RALPH_GATE_VERDICT_STORE:-.ralph/logs/gate-verdict.json}" 2>/dev/null)"`,
    `  printf 'gate held=%s\\n' "\${held:-none}" >> ${JSON.stringify(argvFile)}`,
    'fi',
    // FAKE_GATE_SEQUENCE answers the coder gate's n-th call with the n-th of its
    // `|`-separated answers, and with the default after the last (#771): a
    // hold, its release and the verdict's return are three answers in a row.
    // `\n` inside one prints a second line; one starting `STOP:` drops an
    // operator's stop into the inbox first, so a run can end without a session.
    'if [ -n "${FAKE_GATE_SEQUENCE:-}" ] && [ "${1##*/}" = frontier-gate.ts ]; then',
    `  seq_calls=$(( $(cat ${JSON.stringify(join(root, 'gate.seq'))} 2>/dev/null || echo 0) + 1 ))`,
    `  printf '%s' "$seq_calls" > ${JSON.stringify(join(root, 'gate.seq'))}`,
    '  answer="$(printf \'%s\\n\' "$FAKE_GATE_SEQUENCE" | awk -F"|" -v n="$seq_calls" \'{print $n}\')"',
    '  if [ -n "$answer" ]; then',
    '    case "$answer" in',
    '      STOP:*)',
    '        mkdir -p .ralph/control/inbox',
    '        printf \'{"version":1,"id":"stop-1","command":"stop","stop":"completed","why":"that is enough for tonight"}\''
      + ' > .ralph/control/inbox/stop-1.json',
    '        answer="${answer#STOP:}" ;;',
    '    esac',
    '    printf \'%b\\n\' "$answer"',
    '    exit 0',
    '  fi',
    'fi',
    // FAKE_GATE_FIRST_OUTPUT replaces the gate's answer on its first call only,
    // the coder's gate or the clerk's (`clerk/gate.ts`).
    `if [ -n "\${FAKE_GATE_FIRST_OUTPUT:-}" ] && { [ "\${1##*/}" = frontier-gate.ts ] || [ "\${1##*/}" = gate.ts ]; } && [ ! -f ${JSON.stringify(gateOnceFile)} ]; then`,
    `  : > ${JSON.stringify(gateOnceFile)}`,
    '  printf \'%s\\n\' "$FAKE_GATE_FIRST_OUTPUT"',
    '  exit 0',
    'fi',
    // FAKE_GATE_NTH=<n> answers FAKE_GATE_NTH_OUTPUT on the gate's n-th call
    // only, counted in a file: a hand-back that comes after an iteration (#759).
    'if [ -n "${FAKE_GATE_NTH:-}" ] && { [ "${1##*/}" = frontier-gate.ts ] || [ "${1##*/}" = gate.ts ]; }; then',
    `  gate_calls=$(( $(cat ${JSON.stringify(join(root, 'gate.calls'))} 2>/dev/null || echo 0) + 1 ))`,
    `  printf '%s' "$gate_calls" > ${JSON.stringify(join(root, 'gate.calls'))}`,
    '  [ "$gate_calls" = "$FAKE_GATE_NTH" ] && { printf \'%s\\n\' "$FAKE_GATE_NTH_OUTPUT"; exit 0; }',
    'fi',
    'printf \'%s\\n\' "${FAKE_GATE_OUTPUT:-frontier-gate: work available — frontier ticket #1}"',
    'exit ${FAKE_GATE_STATUS:-0}',
  ]);

  return { root, home, bin, argv: () => readFileSync(argvFile, 'utf8').split('\n').filter(Boolean) };
}

interface Run {
  status: number;
  stdout: string;
  /** The preflight guards refuse on stderr, before anything reaches the log. */
  stderr: string;
  argv: string[];
  supervisorLogs: string[];
}

// Fake Doppler owns the fixture credentials. CI's backup URL and a developer's
// shell environment must not become inputs to these subprocess tests.
const supervisorEnvironment = (work: ReturnType<typeof scratchWorktree>): NodeJS.ProcessEnv => ({
  ...process.env,
  DATABASE_URL: undefined,
  SUPABASE_DB_URL: undefined,
  DATABASE_DIRECT_URL: undefined,
  NEXT_PUBLIC_SUPABASE_URL: undefined,
  // Plugins are off unless a test turns one on: that is the default under test.
  RALPH_PLUGINS: undefined,
  // No Buildkite token unless a test's fake secrets scope holds one.
  RALPH_BUILDKITE_READ_TOKEN: undefined,
  BUILDKITE_API_TOKEN: undefined,
  // Never the ledger of the checkout running this suite, nor of a live loop.
  RALPH_SPEED_DIR: join(work.root, '..', 'speed'),
  // The gate verdict record is the scratch worktree's own unless a test says
  // otherwise, and the hold budget is the default (#771).
  RALPH_GATE_VERDICT_STORE: undefined,
  RALPH_GATE_HOLD_BUDGET_HOURS: undefined,
  PATH: `${work.bin}:${process.env.PATH ?? ''}`,
});

const runSupervisor = (
  work: ReturnType<typeof scratchWorktree>,
  args: string[],
  env: Record<string, string> = {},
): Run => {
  const result = spawnSync('bash', [join(work.home, 'ralph.sh'), ...args], {
    cwd: work.root,
    encoding: 'utf8',
    env: { ...supervisorEnvironment(work), ...env },
    timeout: 30_000,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
    argv: work.argv(),
    supervisorLogs: readdirSync(join(work.root, '.ralph', 'logs')).filter((f) =>
      f.startsWith('supervisor-'),
    ),
  };
};

const gateCalls = (argv: string[]): string[] =>
  argv.filter((line) => line.includes('frontier-gate.ts'));

/**
 * A loop's worktree does not update itself, and a stale one fails as anything
 * but staleness — the second loop's once sat three commits behind with no
 * `frontier-gate.ts` in it, so the gate died on a missing file. These pin the
 * one state that is refused, and the three that are not.
 */
describe('the development credential fence', () => {
  it('uses fixture credentials when the host supplies production database variables', () => {
    for (const name of ['DATABASE_URL', 'SUPABASE_DB_URL', 'DATABASE_DIRECT_URL']) {
      vi.stubEnv(name, 'postgresql://postgres:host-only@db.liuuaowngrfjgsfndeeu.supabase.co/postgres');
    }
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://liuuaowngrfjgsfndeeu.supabase.co');
    try {
      const run = runSupervisor(scratchWorktree(), ['1']);
      expect(run.status).toBe(0);
      expect(run.argv.some((line) => line.startsWith('claude '))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(['SUPABASE_DB_URL', 'DATABASE_DIRECT_URL', 'NEXT_PUBLIC_SUPABASE_URL'])('rejects a mixed-project %s', (name) => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      [name]: name === 'NEXT_PUBLIC_SUPABASE_URL'
        ? 'https://liuuaowngrfjgsfndeeu.supabase.co'
        : 'postgresql://postgres:hidden@db.liuuaowngrfjgsfndeeu.supabase.co/postgres',
    });
    expect(run.status).not.toBe(0);
    expect(run.argv.some((line) => line.startsWith('claude '))).toBe(false);
    expect(run.stderr + run.stdout).toContain(`${name} must target`);
  });

  it('rejects production credentials before starting the orchestrator', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      DATABASE_URL: 'postgresql://postgres:never-log-this@db.liuuaowngrfjgsfndeeu.supabase.co/postgres',
    });
    expect(run.status).not.toBe(0);
    expect(run.argv.some((line) => line.startsWith('claude '))).toBe(false);
    expect(run.stderr + run.stdout).not.toContain('never-log-this');
  });
});

describe('the worktree freshness guard', () => {
  it('fast-forwards a clean worktree that is strictly behind origin/main', () => {
    // The lossless case: an ancestor HEAD, nothing uncommitted, no claim. §1
    // would detach to the same ref before asking the frontier, so refusing
    // here only costs the operator a restart that exits instantly.
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_HEAD: 'old111',
      FAKE_MAIN: 'new222',
      FAKE_SIGIL: '<ralph>COMPLETE</ralph>',
    });

    expect(run.status).toBe(0);
    expect(run.argv).toContain('git checkout --detach origin/main --quiet');
    // Moved BEFORE spawning: an iteration on old code is the thing being
    // prevented, not something to repair afterwards.
    const moved = run.argv.indexOf('git checkout --detach origin/main --quiet');
    const spawned = run.argv.findIndex((l) => l.startsWith('claude run-id='));
    expect(moved).toBeGreaterThanOrEqual(0);
    expect(spawned).toBeGreaterThan(moved);
  });

  it('says that it moved HEAD, and where from and to', () => {
    // A supervisor that silently rewrites the checkout is worse than one that
    // refuses: the log is the only record that HEAD is not where it was left.
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_HEAD: 'old111',
      FAKE_MAIN: 'new222',
      FAKE_SIGIL: '<ralph>COMPLETE</ralph>',
    });

    expect(run.stderr).toContain('fast-forwarded');
    expect(run.stderr).toContain('old111');
    expect(run.stderr).toContain('new222');
  });

  it('refuses when the fast-forward does not take, and names the remedy', () => {
    // Detaching a clean ancestor is as safe as git gets. A failure is not
    // staleness — it is a worktree that does not do what it says — so this
    // one keeps the old refusal rather than starting on unknown code.
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_HEAD: 'old111',
      FAKE_MAIN: 'new222',
      FAKE_CHECKOUT_FAILS: '1',
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('could not be fast-forwarded');
    expect(run.stderr).toContain('git checkout --detach origin/main');
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(0);
  });

  it('starts when the worktree is level with origin/main', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_HEAD: 'same333',
      FAKE_MAIN: 'same333',
      FAKE_SIGIL: '<ralph>COMPLETE</ralph>',
    });

    expect(run.status).toBe(0);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
  });

  it('starts when the worktree carries its own commits — mid-ticket is not stale', () => {
    // A killed iteration leaves exactly this: a ralph/<n> branch with work on
    // it. Refusing here would strand the work §1 exists to shepherd.
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_HEAD: 'ticket444',
      FAKE_MAIN: 'new222',
      FAKE_HAS_OWN_COMMITS: '1',
      FAKE_SIGIL: '<ralph>COMPLETE</ralph>',
    });

    expect(run.status).toBe(0);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
  });

  it('starts when a behind worktree has uncommitted recovery work', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_HEAD: 'old111',
      FAKE_MAIN: 'new222',
      FAKE_DIRTY: ' M src/recovery.ts',
      FAKE_SIGIL: '<ralph>COMPLETE</ralph>',
    });

    expect(run.status).toBe(0);
    expect(run.stderr).toContain('uncommitted work');
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
    // The fast-forward is for the lossless case only. Here it would discard
    // the very work §0 is being started to inspect.
    expect(run.argv.some((l) => l.startsWith('git checkout'))).toBe(false);
  });

  it('starts when a clean behind worktree has this loop\'s unfinished claim', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_HEAD: 'old111',
      FAKE_MAIN: 'new222',
      FAKE_OWN_CLAIM: '1',
      FAKE_SIGIL: '<ralph>COMPLETE</ralph>',
    });

    expect(run.status).toBe(0);
    expect(run.stderr).toContain('unfinished claim');
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
    // §1 resumes the claim on the checkout it was left on; moving HEAD out
    // from under it is how a resumable ticket becomes a lost one.
    expect(run.argv.some((l) => l.startsWith('git checkout'))).toBe(false);
  });

  it('never moves HEAD when an operator resumes interrupted work', () => {
    // Resume work after a Stop now: the killed iteration's claim may already
    // have lapsed from the label, and a clean ancestor HEAD would otherwise be
    // fast-forwarded. Resuming means picking up exactly what was left.
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_HEAD: 'old111',
      FAKE_MAIN: 'new222',
      RALPH_RESUME_WORK: '1',
      FAKE_SIGIL: '<ralph>COMPLETE</ralph>',
    });

    expect(run.status).toBe(0);
    expect(run.stderr).toContain('resuming');
    expect(run.argv.some((l) => l.startsWith('git checkout'))).toBe(false);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
  });

  it('warns but still starts when origin cannot be fetched', () => {
    // A fetch that fails leaves origin/main at whatever it knew, so the
    // comparison can only be too permissive. Stopping a healthy loop over a
    // network blip is the worse trade.
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_FETCH_FAILS: '1',
      FAKE_SIGIL: '<ralph>COMPLETE</ralph>',
    });

    expect(run.status).toBe(0);
    expect(run.stderr).toContain('stale ref');
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
  });

  it('skips the check entirely outside a git repository', () => {
    // Behind-looking shas that must NOT be consulted: with no repository there
    // is nothing to be behind, and refusing would make the guard the reason a
    // loop cannot run anywhere but a checkout.
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_NOT_A_REPO: '1',
      FAKE_HEAD: 'old111',
      FAKE_MAIN: 'new222',
      FAKE_SIGIL: '<ralph>COMPLETE</ralph>',
    });

    expect(run.status).toBe(0);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
  });

  it('bounds the fetch, so an authentication prompt cannot hang the supervisor', () => {
    // Unauthenticated HTTPS makes git prompt, and a supervisor under
    // `nohup … &` would sit on it forever — a hang that reads as nothing at
    // all, since the prompt goes to /dev/null with the rest of stderr.
    const worktree = scratchWorktree();
    writeExecutable(join(worktree.bin, 'git'), [
      '#!/bin/sh',
      'case "$1 $2" in',
      '  "rev-parse --git-dir") echo .git; exit 0 ;;',
      // Hangs unless something upstream bounds it.
      '  "fetch --quiet") sleep 60; exit 0 ;;',
      'esac',
      'case "$1" in',
      '  rev-parse) echo same333; exit 0 ;;',
      '  merge-base) exit 0 ;;',
      'esac',
      'exit 0',
    ]);

    const started = Date.now();
    const run = runSupervisor(worktree, ['1'], {
      FAKE_SIGIL: '<ralph>COMPLETE</ralph>',
      RALPH_FETCH_TIMEOUT: '2',
    });

    // The fake fetch sleeps 60s. Returning in anything like 2s proves the cap
    // fired rather than the fetch finishing, and the supervisor carried on to
    // spawn — a bound that killed the run instead would be no better than the
    // hang.
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(run.status).toBe(0);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
  });
});

describe('the ungated supervisor', () => {
  it('spawns when the pre-flight check says there is work', () => {
    // The gate's default fake answer is "work available", so the run proceeds
    // — the check decides between spawning and not, it never delays a spawn
    // that has work waiting.
    const run = runSupervisor(scratchWorktree(), ['1'], { FAKE_SIGIL: '<ralph>COMPLETE</ralph>' });
    expect(run.status).toBe(0);
    expect(gateCalls(run.argv)).toEqual(['ralph/frontier-gate.ts --once']);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
  });

  it('still stops on ALL_BLOCKED', () => {
    const run = runSupervisor(scratchWorktree(), ['5'], {
      FAKE_SIGIL: '<ralph>ALL_BLOCKED</ralph>',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('needs human triage');
    // One iteration, not five: the sigil ended the run.
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
  });

  it('stops on NEEDS_TRIAGE', () => {
    const run = runSupervisor(scratchWorktree(), ['5'], {
      FAKE_SIGIL: '<ralph>NEEDS_TRIAGE</ralph>',
    });
    // Non-zero: unlike a drained backlog, this is a fault, and a supervisor
    // that exited 0 would look to a watcher like an orderly finish.
    expect(run.status).toBe(1);
    // Distinct wording from the streak-limit stop, which also asks for a
    // human: that one exits 0 after clean sigils, this one exits 1 because the
    // iteration never got started. A watcher grepping stdout has to be able to
    // tell them apart.
    expect(run.stdout).toContain('halting for repair');
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
  });

  it('lets a fault outrank a soft stop when the final message carries both', () => {
    // The supervisor matches sigils as unanchored substrings, so the order the
    // greps are written IS the precedence. Reading this message as COMPLETE would
    // retire a loop that never reached the backlog, and retire it exit 0 — an
    // orderly finish, to anyone watching.
    const run = runSupervisor(scratchWorktree(), ['5'], {
      FAKE_SIGIL: '<ralph>COMPLETE</ralph> then <ralph>NEEDS_TRIAGE</ralph>',
    });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('halting for repair');
  });

  it('runs up to the cap and then stops', () => {
    const run = runSupervisor(scratchWorktree(), ['3']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('iteration cap (3) reached');
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(3);
  });
});

describe('the gated supervisor', () => {
  it('asks the gate, with its interval, before every iteration', () => {
    const run = runSupervisor(scratchWorktree(), ['2'], { RALPH_WAIT_FOR_WORK: '300' });
    expect(run.status).toBe(0);
    expect(gateCalls(run.argv)).toEqual([
      'ralph/frontier-gate.ts 300',
      'ralph/frontier-gate.ts 300',
    ]);
  });

  it('records what the gate says while it waits, so an idle loop is legible', () => {
    const work = scratchWorktree();
    const run = runSupervisor(work, ['1'], {
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_GATE_OUTPUT: 'frontier-gate: the frontier is empty at 2026-08-20T11:15:00Z — waiting 1s (poll 4, idle 1h15m)',
    });
    expect(run.supervisorLogs).toHaveLength(1);
    const log = readFileSync(join(work.root, '.ralph', 'logs', run.supervisorLogs[0]!), 'utf8');
    expect(log).toContain('poll 4, idle 1h15m');
    expect(log).toContain('frontier-gated — waits 1s between checks');
  });

  // A stop sent to an idle loop once sat unread for hours: the gate blocked
  // for as long as the frontier stayed empty, and the checkpoint only runs
  // between iterations. These pin the hand-back from every long wait.
  it('goes back to the checkpoint when the gate wakes for a control command', () => {
    const run = runSupervisor(scratchWorktree(), ['3'], {
      RALPH_WAIT_FOR_WORK: '300',
      FAKE_GATE_FIRST_OUTPUT: 'frontier-gate: control command waiting — handing back to the supervisor',
      FAKE_CONTROL_STOP_FROM: '2',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('stopped by an operator — stopped from the dashboard');
    expect(gateCalls(run.argv)).toEqual(['ralph/frontier-gate.ts 300']);
    expect(run.argv.filter((line) => line.startsWith('claude argv='))).toHaveLength(0);
  });

  it('cuts a blocked wait short when a command lands in the inbox', () => {
    const work = scratchWorktree();
    const inbox = join(work.root, '.ralph', 'control', 'inbox');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, 'stop-1.json'), '{"version":1,"id":"stop-1","command":"stop"}\n');
    const started = Date.now();
    const run = runSupervisor(work, ['3'], {
      RALPH_WAIT_FOR_WORK: '120',
      RALPH_CONTROL_POLL_SECONDS: '1',
      FAKE_SIGIL: '<ralph>ALL_BLOCKED</ralph>',
      FAKE_CONTROL_STOP_FROM: '2',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('stopped by an operator — stopped from the dashboard');
    // One iteration, then a 1s slice of the 120s wait, then the stop.
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(gateCalls(run.argv)).toHaveLength(1);
  });

  it('waits instead of exiting when an iteration comes back ALL_BLOCKED', () => {
    // The ungated supervisor stops here. This one goes back to the gate.
    const run = runSupervisor(scratchWorktree(), ['2'], {
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_SIGIL: '<ralph>ALL_BLOCKED</ralph>',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('waiting for the frontier to widen');
    expect(gateCalls(run.argv)).toHaveLength(2);
  });

  it('waits instead of exiting when the backlog drains', () => {
    const run = runSupervisor(scratchWorktree(), ['2'], {
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_SIGIL: '<ralph>COMPLETE</ralph>',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('waiting for new work');
    expect(gateCalls(run.argv)).toHaveLength(2);
  });

  it('stops on NEEDS_TRIAGE even though it is gated', () => {
    // The one sigil waiting cannot help with. A gated supervisor turns "nothing
    // right now" into a wait, but a broken environment is not a backlog state:
    // re-running it on a timer would fail the same way forever.
    const run = runSupervisor(scratchWorktree(), ['5'], {
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_SIGIL: '<ralph>NEEDS_TRIAGE</ralph>',
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('halting for repair');
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
  });

  it('stops once the gate and the iteration have disagreed twice running', () => {
    // A frontier ticket is self-limiting — the gate sees it, the iteration
    // claims it, the answer changes. A closable spec is not: if the iteration
    // declines it, nothing changes, and the pair would trade one Opus turn per
    // interval forever. The cap here is what makes a stable disagreement
    // different from a race.
    const run = runSupervisor(scratchWorktree(), ['20'], {
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_SIGIL: '<ralph>ALL_BLOCKED</ralph>',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('disagree persistently');
    // Three iterations, not twenty — the cap never came into it. A coder holds
    // at the gate (#771): the first refusal writes the hold, and this fake
    // gate, which never reads the record, offers the same #1 again — so the
    // next two are the hold not taking, and those count as before.
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(3);
    // Each empty iteration asked whether the gate's ticket had been taken, and
    // nothing explained it, which is what makes these disagreements count.
    expect(run.argv.filter((l) => l === 'ralph/claim-race.ts 1')).toHaveLength(3);
    expect(run.stdout).toContain('#1 is not claimed by another loop.');
  });

  it('goes back to the gate without counting a claim race it lost', () => {
    // #1397 and #1407: the gate named a ticket, another loop claimed it before
    // the iteration's real take-one, the iteration came back ALL_BLOCKED, and
    // two of those halted an idle loop for a human. A lost race says nothing
    // about the gate being wrong, so it must never reach the halt.
    const run = runSupervisor(scratchWorktree(), ['4'], {
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_SIGIL: '<ralph>ALL_BLOCKED</ralph>',
      FAKE_CLAIM_RACE: '0',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain('disagree persistently');
    expect(run.stdout).toContain(
      'lost the claim race for #1 to rafa (labeled rafa-wip) — back to the gate; not counted as a disagreement.',
    );
    expect(run.stdout).toContain('iteration cap (4) reached');
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(4);
  }, 30_000);

  it('leaves the streak where it was across a lost race, so real disagreements still halt', () => {
    // Unexplained, lost, unexplained. The lost race neither counts nor resets:
    // resetting would let a loop that alternates a real disagreement with a
    // race run forever, and counting it is the bug. A coder's first
    // unexplained one is the hold (#771), so the halt is on the third
    // unexplained one, the fourth turn.
    const run = runSupervisor(scratchWorktree(), ['10'], {
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_SIGIL: '<ralph>ALL_BLOCKED</ralph>',
      FAKE_CLAIM_RACE: '1 0 1',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('lost the claim race for #1 to rafa');
    expect(run.stdout).toContain('2 iterations in a row found nothing');
    expect(run.stdout).toContain('disagree persistently');
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(4);
  }, 30_000);

  it('does not count a disagreement it could not verify, and says so', () => {
    // A rate-limited or unreachable GitHub cannot tell a race from a real
    // disagreement. Halting on that would put a human on a network blip.
    const run = runSupervisor(scratchWorktree(), ['3'], {
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_SIGIL: '<ralph>ALL_BLOCKED</ralph>',
      FAKE_CLAIM_RACE: '3',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain('disagree persistently');
    expect(run.stdout).toContain(
      'could not tell whether #1 was claimed by another loop: gh: API rate limit exceeded — not counted as a disagreement.',
    );
    expect(run.stdout).toContain('iteration cap (3) reached');
  }, 30_000);

  it('counts a check that could not run at all', () => {
    // A broken script is a harness fault, not a GitHub read. Excusing it would
    // switch the halt off for good, so it counts as it did before the check.
    const run = runSupervisor(scratchWorktree(), ['10'], {
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_SIGIL: '<ralph>ALL_BLOCKED</ralph>',
      FAKE_CLAIM_RACE: '2',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('the claim-race check for #1 failed (exit 2); counting the disagreement.');
    expect(run.stdout).toContain('disagree persistently');
    // The coder's first refusal is the hold (#771); the two after it count.
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(3);
  });

  it('asks about a claim race only when the gate named a frontier ticket', () => {
    // A closable spec is the stable disagreement the streak was built for:
    // no other loop can "win" it, so there is nothing to ask.
    const run = runSupervisor(scratchWorktree(), ['10'], {
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_SIGIL: '<ralph>ALL_BLOCKED</ralph>',
      FAKE_CLAIM_RACE: '0',
      FAKE_GATE_OUTPUT: 'frontier-gate: work available — spec #5 has no open children left — closing it is the task',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('disagree persistently');
    expect(run.argv.filter((l) => l.includes('claim-race.ts'))).toHaveLength(0);
  });

  it('resets the disagreement streak when an iteration does work', () => {
    // Blocked, working, blocked, working. The two blocked iterations are not
    // consecutive, so the guard must not fire — otherwise a healthy loop that
    // merely passes through an empty frontier twice would stop for good.
    // Without the reset this run stops after the third iteration instead.
    const run = runSupervisor(scratchWorktree(), ['4'], {
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_SIGIL_ALTERNATE: '1',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain('disagree persistently');
    expect(run.stdout).toContain('iteration cap (4) reached');
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(4);
  });

  // #771: a holding role (the coder here) records the verdict an iteration
  // refuted, and its gate holds on it instead of spawning on it again.
  const heldRecord = (work: ReturnType<typeof scratchWorktree>, path = join(work.root, '.ralph', 'logs', 'gate-verdict.json')) =>
    existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : null;
  const seedHeld = (work: ReturnType<typeof scratchWorktree>, held: Record<string, unknown>) =>
    writeFileSync(join(work.root, '.ralph', 'logs', 'gate-verdict.json'), JSON.stringify({ version: 1, ...held }));
  const eventsOf = (argv: string[]): string[] =>
    argv.flatMap((l) => {
      const m = /^ralph\/loop-state\.ts record --event (\S+)/.exec(l);
      return m?.[1] ? [m[1]] : [];
    });
  /** The argv lines from the n-th coder gate call (1-based) up to the next one. */
  const afterGate = (argv: string[], n: number): string[] => {
    const at = argv.map((l, i) => (l.includes('frontier-gate.ts') ? i : -1)).filter((i) => i >= 0);
    return argv.slice(at[n - 1], at[n] ?? argv.length);
  };
  /** The argv lines before the n-th coder gate call (1-based), back to the previous one. */
  const beforeGate = (argv: string[], n: number): string[] => {
    const at = argv.map((l, i) => (l.includes('frontier-gate.ts') ? i : -1)).filter((i) => i >= 0);
    return argv.slice(n >= 2 ? at[n - 2] : 0, at[n - 1]);
  };

  it('holds at the gate on a refuted verdict, and clears the hold when the gate names another ticket', () => {
    const work = scratchWorktree();
    const run = runSupervisor(work, ['2'], {
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_GATE_SEES_HELD: '1',
      // The second session ends the run before anything after it could touch
      // the record, so what is left on disk is what the gate's answer did.
      FAKE_SIGIL_SEQUENCE: '<ralph>ALL_BLOCKED</ralph>|<ralph>NEEDS_TRIAGE</ralph>',
      FAKE_GATE_NTH: '2',
      FAKE_GATE_NTH_OUTPUT: 'frontier-gate: work available — frontier ticket #2',
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('holding at the gate until its verdict changes (frontier ticket #1)');
    expect(run.stdout).not.toContain('disagree persistently');
    // The refusal is a hold, which the panel reads as idle — not a blocked wait.
    const firstRound = afterGate(run.argv, 1);
    expect(eventsOf(firstRound)).toContain('gate-hold');
    expect(eventsOf(firstRound)).not.toContain('blocked-wait');
    // The record the second gate was asked under: frontier ticket #1.
    const asked = run.argv.filter((l) => l.startsWith('gate held='));
    expect(asked[0]).toBe('gate held=none');
    expect(asked[1]).toContain('"kind":"frontier-ticket","ticket":1,');
    // The gate named #2, so the hold on #1 was cleared before that session.
    const secondRound = afterGate(run.argv, 2);
    const clearAt = secondRound.findIndex((l) => l.startsWith('ralph/gate-verdict-store.ts clear --keep-if-case frontier ticket #2'));
    const sessionAt = secondRound.findIndex((l) => l.startsWith('claude run-id='));
    expect(clearAt).toBeGreaterThanOrEqual(0);
    expect(clearAt).toBeLessThan(sessionAt);
    expect(heldRecord(work)).toBeNull();
  }, 30_000);

  it('falls back to the disagreement streak when the hold cannot be written', () => {
    const work = scratchWorktree();
    // A regular file where the record's directory should be.
    writeFileSync(join(work.root, 'not-a-dir'), 'x');
    const run = runSupervisor(work, ['20'], {
      RALPH_WAIT_FOR_WORK: '1',
      RALPH_GATE_VERDICT_STORE: join(work.root, 'not-a-dir', 'gate-verdict.json'),
      FAKE_SIGIL: '<ralph>ALL_BLOCKED</ralph>',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('the gate verdict record could not be written (exit 1); the disagreement counts.');
    expect(eventsOf(run.argv)).toContain('blocked-wait');
    expect(eventsOf(run.argv)).not.toContain('gate-hold');
    expect(run.stdout).toContain('disagree persistently');
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(2);
  }, 30_000);

  it('tells the operator once when the hold outlasts its budget, and keeps the loop on the needs-you list', () => {
    const work = scratchWorktree();
    const first = '2026-11-01T00:00:00.000Z';
    seedHeld(work, { kind: 'frontier-ticket', ticket: 1, first, notified: false });
    const run = runSupervisor(work, ['1'], {
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_GATE_FIRST_OUTPUT:
        `frontier-gate: hold budget spent — frontier ticket #1 held since ${first} (2d) — after poll 3`,
      // The gate after the hand-back offers the held verdict again; the
      // iteration refuses it, which is the hold not taking — so the record
      // stays for this test to read.
      FAKE_SIGIL: '<ralph>ALL_BLOCKED</ralph>',
    });
    expect(run.status).toBe(0);
    const pushes = run.argv.filter((l) => l.includes('push-notification.ts push --kind gate-hold-exhausted'));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain(`--occurrence gate-hold-exhausted:frontier-ticket:1:${first}`);
    expect(pushes[0]).toContain('--subject ralph has held on one gate verdict past its budget');
    expect(pushes[0]).toContain(`frontier ticket #1, held since ${first}`);
    expect(pushes[0]).toContain('gate-verdict-store.ts clear (in ');
    expect(pushes[0]).toContain('--priority high');
    expect(heldRecord(work)).toMatchObject({ kind: 'frontier-ticket', ticket: 1, first, notified: true });
    // The hand-back spawned no session: the only one ran after the second gate.
    expect(afterGate(run.argv, 1).filter((l) => l.startsWith('claude run-id='))).toHaveLength(0);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
    expect(eventsOf(afterGate(run.argv, 1))).toContain('gate-hold-exhausted');
    // Before the re-gate, the wait re-records the exhausted hold, not a plain
    // wait: the panel reads only the last event, and this one reads blocked.
    const beforeRegate = eventsOf(beforeGate(run.argv, 2));
    expect(beforeRegate.at(-1)).toBe('gate-hold-exhausted');
    expect(beforeRegate).not.toContain('frontier-wait');
    expect(eventsOf(beforeGate(run.argv, 1)).at(-1)).toBe('frontier-wait');
    expect(run.stdout).toContain('the operator is notified, and the loop keeps holding');
  }, 30_000);

  it('marks the record released and re-gates without a session when the gate releases its hold', () => {
    const work = scratchWorktree();
    seedHeld(work, { kind: 'frontier-ticket', ticket: 1, first: '2026-11-01T00:00:00.000Z', notified: false });
    const run = runSupervisor(work, ['1'], {
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_GATE_SEES_HELD: '1',
      FAKE_GATE_FIRST_OUTPUT: 'frontier-gate: hold released — the frontier is empty',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("the gate's hold is released — the frontier is empty.");
    // Released, not deleted, before the gate was asked again — its clock kept —
    // and nothing spawned in between.
    const asked = run.argv.filter((l) => l.startsWith('gate held='));
    expect(asked[0]).toContain('"ticket":1,');
    expect(asked[0]).not.toContain('"released":true');
    expect(asked[1]).toContain('"released":true');
    expect(asked[1]).toContain('"first":"2026-11-01T00:00:00.000Z"');
    expect(afterGate(run.argv, 1).filter((l) => l.startsWith('claude run-id='))).toHaveLength(0);
    expect(afterGate(run.argv, 1)).toContain('ralph/gate-verdict-store.ts release');
    expect(afterGate(run.argv, 1)).not.toContain('ralph/gate-verdict-store.ts clear');
  }, 30_000);

  const RELEASED_1 = 'frontier-gate: hold released — every frontier candidate is held (#1)';
  const OFFERS_1 = 'frontier-gate: work available — frontier ticket #1';

  it('re-holds a verdict that comes back after a flaky release on its original clock, without counting it', () => {
    const work = scratchWorktree();
    const run = runSupervisor(work, ['2'], {
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_GATE_SEES_HELD: '1',
      FAKE_GATE_SEQUENCE: [OFFERS_1, RELEASED_1, OFFERS_1].join('|'),
      FAKE_SIGIL: '<ralph>ALL_BLOCKED</ralph>',
    });
    expect(run.status).toBe(0);
    const asked = run.argv.filter((l) => l.startsWith('gate held='));
    // Held after the first refusal, then released — kept, not deleted — when
    // the next poll read every candidate as held.
    expect(asked[1]).toContain('"ticket":1,');
    expect(asked[1]).not.toContain('"released":true');
    expect(asked[2]).toContain('"released":true');
    const first = /"first":"([^"]+)"/.exec(asked[1] ?? '')?.[1];
    expect(first).toBeTruthy();
    // The release spawned nothing; #1's return did, and the record survived it.
    expect(afterGate(run.argv, 2).filter((l) => l.startsWith('claude run-id='))).toHaveLength(0);
    expect(afterGate(run.argv, 2)).toContain('ralph/gate-verdict-store.ts release');
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(2);
    // The second refusal re-holds on the original clock: a hold, not a disagreement.
    expect(eventsOf(afterGate(run.argv, 3))).toContain('gate-hold');
    expect(eventsOf(afterGate(run.argv, 3))).not.toContain('blocked-wait');
    expect(run.stdout.match(/holding at the gate until its verdict changes \(frontier ticket #1\)/g)).toHaveLength(2);
    expect(run.stdout).not.toContain('offered the verdict it was holding on again');
    expect(run.stdout).not.toContain('disagree persistently');
    expect(heldRecord(work)).toMatchObject({ kind: 'frontier-ticket', ticket: 1, first, released: false, reholds: 1 });
  }, 30_000);

  it('bounds a verdict that keeps flapping: the second return counts, the third halts', () => {
    const work = scratchWorktree();
    const run = runSupervisor(work, ['20'], {
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_GATE_SEQUENCE: [OFFERS_1, RELEASED_1, OFFERS_1, RELEASED_1, OFFERS_1, RELEASED_1, OFFERS_1].join('|'),
      FAKE_SIGIL: '<ralph>ALL_BLOCKED</ralph>',
    });
    // Four sessions, every one refusing #1: the first holds fresh, the first
    // return re-holds silently, the second return re-holds but counts (streak
    // 1), the third counts again (streak 2) and halts — not one per flap forever.
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(4);
    expect(run.stdout.match(/holding at the gate until its verdict changes/g)).toHaveLength(2);
    expect(run.stdout.match(
      /the gate offered the verdict it was holding on again \(frontier ticket #1\); the disagreement counts\./g,
    )).toHaveLength(2);
    expect(run.stdout).toContain('disagree persistently');
    expect(eventsOf(run.argv)).toContain('gate-disagreement');
    expect(heldRecord(work)).toMatchObject({ kind: 'frontier-ticket', ticket: 1, released: false, reholds: 3 });
  }, 30_000);

  it('after the budget hand-back, keeps holding without another push or session', () => {
    const work = scratchWorktree();
    const first = '2026-11-01T00:00:00.000Z';
    seedHeld(work, { kind: 'frontier-ticket', ticket: 1, first, notified: false });
    const holding =
      `frontier-gate: holding on an unchanged verdict (frontier ticket #1, held since ${first}): frontier ticket #1`
      + ' at 2026-11-11T00:00:00Z — waiting 1s (poll 4, idle 3s)';
    const run = runSupervisor(work, ['3'], {
      RALPH_WAIT_FOR_WORK: '1',
      REAL_CONTROLS: '1',
      RALPH_CONTROL_POLL_SECONDS: '1',
      FAKE_GATE_SEQUENCE: [
        `frontier-gate: hold budget spent — frontier ticket #1 held since ${first} (10d) — after poll 3`,
        // The next gate run holds, then an operator's stop ends the run: the
        // only way out of a gate that keeps holding without a session.
        `STOP:${holding}\\nfrontier-gate: control command waiting — handing back to the supervisor`,
      ].join('|'),
      FAKE_SIGIL: '<ralph>ALL_BLOCKED</ralph>',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('stopped by an operator — that is enough for tonight');
    expect(run.argv.filter((l) => l.includes('push-notification.ts push --kind gate-hold-exhausted'))).toHaveLength(1);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(0);
    expect(heldRecord(work)).toMatchObject({ kind: 'frontier-ticket', ticket: 1, first, notified: true });
  }, 30_000);

  it('keeps the hold across a retry-later iteration, and drops it after one that worked', () => {
    const held = { kind: 'frontier-ticket', ticket: 1, first: '2026-11-01T00:00:00.000Z', notified: false };
    // The gate offers the held #1 both times, so the clear before the session
    // keeps it: only what the iteration's ending does is under test.
    const later = scratchWorktree();
    seedHeld(later, held);
    const retry = runSupervisor(later, ['1'], { RALPH_WAIT_FOR_WORK: '1', FAKE_SIGIL: '<ralph>RETRY_LATER</ralph>' });
    expect(retry.status).toBe(0);
    expect(heldRecord(later)).toMatchObject(held);

    const worked = scratchWorktree();
    seedHeld(worked, held);
    const done = runSupervisor(worked, ['1'], { RALPH_WAIT_FOR_WORK: '1', FAKE_SIGIL: '<ralph>DONE</ralph>' });
    expect(done.status).toBe(0);
    expect(heldRecord(worked)).toBeNull();
  }, 30_000);

  it('never touches the record when ungated', () => {
    const run = runSupervisor(scratchWorktree(), ['3'], { FAKE_SIGIL: '<ralph>ALL_BLOCKED</ralph>' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('everything remaining is blocked; needs human triage.');
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
    expect(run.argv.some((l) => l.includes('gate-verdict-store.ts'))).toBe(false);
  });

  it('refuses to start on a hold budget that is not a positive whole number of hours', () => {
    for (const budget of ['0', 'x', '1.5']) {
      const run = runSupervisor(scratchWorktree(), ['1'], {
        RALPH_WAIT_FOR_WORK: '1',
        RALPH_GATE_HOLD_BUDGET_HOURS: budget,
      });
      expect(run.status, budget).toBe(1);
      expect(run.stderr).toContain(`RALPH_GATE_HOLD_BUDGET_HOURS must be a positive whole number of hours; got '${budget}'`);
      expect(run.argv.some((l) => l.startsWith('claude '))).toBe(false);
    }
  });

  it('still treats a missing sigil as fatal', () => {
    const run = runSupervisor(scratchWorktree(), ['5'], {
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_SIGIL: 'the iteration wandered off',
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('without a sigil');
  });

  it('names a spent usage limit and its reset when the wait cannot be armed', () => {
    // 2026-10-21: thirteen loops read "ended without a sigil" on the dashboard
    // when every one of them had hit the five_hour window, and the reset time
    // was only in the iteration log. A rejection is now waited out (#407), so
    // the stop is left only for a reader that cannot arm the wait: a directory
    // where its state file goes makes `usage-limit.ts detect` fail.
    const root = scratchWorktree();
    mkdirSync(join(root.root, '.ralph', 'logs', 'usage-wait.json'));
    const stream = join(root.home, 'limit.jsonl');
    writeFileSync(stream, [
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: "You've hit your session limit · resets 10:30pm (America/Santiago)" }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: "You've hit your session limit · resets 10:30pm (America/Santiago)", permission_denials: [] }),
    ].join('\n') + '\n');
    const run = runSupervisor(root, ['1'], { FAKE_STREAM_FILE: stream, FAKE_CLAUDE_STATUS: '1' });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(
      'iteration 1 hit the Claude 5-hour session usage limit, which resets 10:30pm (America/Santiago) — stopping',
    );
    expect(run.stdout).not.toContain('ended without a sigil');
    const stop = run.argv.find((line) => line.includes('loop-state.ts record') && line.includes('--event usage-limit-stop --stop failed'));
    expect(stop).toContain('hit the Claude 5-hour session usage limit, which resets 10:30pm (America/Santiago)');
    expect(run.argv.some((line) => line.includes('loop-state.ts record') && line.includes('--event no-sigil'))).toBe(false);
  });

  it('keeps the missing-sigil reason when an earlier rejection was waited out', () => {
    const root = scratchWorktree();
    const stream = join(root.home, 'recovered.jsonl');
    writeFileSync(stream, [
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } }),
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'wandered off', permission_denials: [] }),
    ].join('\n') + '\n');
    const run = runSupervisor(root, ['1'], { FAKE_STREAM_FILE: stream });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('ended without a sigil');
    expect(run.stdout).not.toContain('usage limit');
  });

  it('stops if the gate itself cannot run', () => {
    // Retried first, since exit 2 is also what a transient spawn failure looks
    // like (see "a gate that never reached a verdict"), so the waits are turned
    // down to keep this inside the spawn timeout.
    const run = runSupervisor(scratchWorktree(), ['2'], {
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_GATE_STATUS: '2',
      RALPH_GATE_RETRY_SECONDS: '1',
    });
    expect(run.status).toBe(1);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(0);
  });

  it.each(['0', '-1', 'later', '5m'])('refuses to start on a bad interval (%s)', (interval) => {
    const run = runSupervisor(scratchWorktree(), ['1'], { RALPH_WAIT_FOR_WORK: interval });
    expect(run.status).toBe(1);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(0);
  });
});

/**
 * A target that is not moving is waited on, not re-spawned into.
 *
 * Rafa, 2026-09-23: the gate named the same PR seven times running and seven
 * Opus sessions ended DONE on it, a minute apart, while Vercel was blocking
 * every deploy. Only the ninth ended — with NEEDS_TRIAGE, which killed the
 * loop for the night over an outage. The supervisor now tells "went round
 * again" from "made progress" by the PR itself, gives an external blocker a
 * sigil of its own, and backs off both on a growing interval with a budget.
 */
/** What each turn found at its start: `present` means a park hand-off leaked into it (#776). */
const parkAtStart = (run: Run): string[] =>
  run.argv.filter((l) => l.startsWith('claude block-park-at-start=')).map((l) => l.slice('claude block-park-at-start='.length));

describe('backing off a target that is not moving', () => {
  const turns = (run: Run): string[] => run.argv.filter((l) => l.startsWith('claude run-id='));
  const records = (run: Run): string[] => run.argv.filter((line) => line.includes('loop-state.ts record'));
  const SHEPHERD = 'frontier-gate: work available — Ralph PR #7 to shepherd';
  const PR_VIEW = JSON.stringify({
    state: 'OPEN',
    mergedAt: null,
    labels: [{ name: 'dequeued' }],
    headRefOid: 'HEADSHA',
    statusCheckRollup: [{ __typename: 'StatusContext', context: 'Vercel', state: 'SUCCESS', targetUrl: null }],
  });
  // Seconds, not minutes: base 1s, ceiling 1s, poll 1s.
  const FAST = {
    RALPH_BACKOFF_BASE_SECONDS: '1',
    RALPH_BACKOFF_MAX_SECONDS: '1',
    RALPH_BACKOFF_POLL_SECONDS: '1',
  };

  it('waits instead of re-spawning when an iteration left its shepherd PR exactly as it found it', () => {
    const run = runSupervisor(scratchWorktree(), ['5'], {
      ...FAST,
      RALPH_BACKOFF_BUDGET_SECONDS: '2',
      FAKE_GATE_OUTPUT: SHEPHERD,
      FAKE_PR_VIEW: PR_VIEW,
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });

    expect(run.status).toBe(0);
    // Iteration, 1s wait, iteration, 1s wait, iteration, budget spent — not
    // five back-to-back turns up to the cap.
    expect(turns(run)).toHaveLength(3);
    expect(run.stdout).toContain('PR #7 is exactly as the iteration found it');
    expect(run.stdout).toContain('no model turn while it does');
    expect(run.stdout).not.toContain('iteration cap (5) reached');
    expect(run.stdout).toContain('escalating to a human');
    const written = records(run).join('\n');
    expect(written).toContain('--event backoff-wait --stage gate');
    expect(written).toContain('--event backoff-exhausted --stop blocked');
  }, 30_000);

  it('runs straight on while the shepherd PR keeps moving', () => {
    const run = runSupervisor(scratchWorktree(), ['3'], {
      ...FAST,
      RALPH_BACKOFF_BUDGET_SECONDS: '1',
      FAKE_GATE_OUTPUT: SHEPHERD,
      FAKE_PR_VIEW: PR_VIEW,
      FAKE_PR_VIEW_MOVES: '1',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });

    expect(run.status).toBe(0);
    expect(turns(run)).toHaveLength(3);
    expect(run.stdout).toContain('iteration cap (3) reached');
    expect(run.stdout).not.toContain('backoff:');
 }, 30_000);

  it('never backs off frontier work on a DONE — a claimed ticket changes the frontier itself', () => {
    const run = runSupervisor(scratchWorktree(), ['3'], { ...FAST, RALPH_BACKOFF_BUDGET_SECONDS: '1' });
    expect(run.status).toBe(0);
    expect(turns(run)).toHaveLength(3);
    expect(run.stdout).not.toContain('backoff:');
  });

  it.each([
    ['ungated', {}],
    ['gated', { RALPH_WAIT_FOR_WORK: '1' }],
  ] as [string, Record<string, string>][])('backs off on RETRY_LATER instead of halting (%s)', (_mode, env) => {
    const run = runSupervisor(scratchWorktree(), ['4'], {
      ...FAST,
      ...env,
      RALPH_BACKOFF_BUDGET_SECONDS: '1',
      FAKE_SIGIL: '<ralph>RETRY_LATER</ralph>',
    });
    expect(run.status).toBe(0);
    // Strike, one 1s wait, a re-check iteration, then the budget is spent.
    expect(turns(run)).toHaveLength(2);
    expect(run.stdout).toContain('blocked on something external');
    expect(run.stdout).not.toContain('halting for repair');
    expect(run.stdout).not.toContain('without a sigil');
    expect(run.stdout).toContain('escalating to a human');
    expect(records(run).join('\n')).toContain('--event backoff-exhausted --stop blocked');
  }, 30_000);

  describe('a spent shared episode (#431)', () => {
    const TODAY = '--event backoff-exhausted --stop blocked --why backed off for 1s on a target no iteration could move; needs human triage';
    const exhaust = (record: string): Run =>
      runSupervisor(scratchWorktree(), ['4'], {
        ...FAST,
        RALPH_BACKOFF_BUDGET_SECONDS: '1',
        FAKE_SIGIL: '<ralph>RETRY_LATER</ralph>',
        FAKE_BACKOFF_EXHAUSTED: record,
      });

    it('records the escalation the loop claimed, naming every waiting loop', () => {
      const why = 'shared blocker ci:buildkite/loggd:unit did not clear in 1s; waiting loops: rafa, ralph; needs human triage';
      const run = exhaust(JSON.stringify({ event: 'backoff-exhausted', why }));
      expect(run.status).toBe(0);
      const written = records(run).join('\n');
      expect(written).toContain(`--event backoff-exhausted --stop blocked --why ${why}`);
      expect(written).not.toContain(TODAY);
    }, 30_000);

    it('records a -shared exhaustion for every other loop on the episode', () => {
      const why = 'shared blocker ci:buildkite/loggd:unit did not clear in 1s; already escalated on this host';
      const run = exhaust(JSON.stringify({ event: 'backoff-exhausted-shared', why }));
      expect(run.status).toBe(0);
      const written = records(run).join('\n');
      expect(written).toContain(`--event backoff-exhausted-shared --stop blocked --why ${why}`);
      expect(written).not.toContain('--event backoff-exhausted --stop');
    }, 30_000);

    it.each([
      ['unparseable', 'not json'],
      ['an unknown event', JSON.stringify({ event: 'stop', why: 'something else' })],
      ['an empty why', JSON.stringify({ event: 'backoff-exhausted-shared', why: '' })],
    ])('falls back to today\'s record on %s', (_case, record) => {
      const run = exhaust(record);
      expect(run.status).toBe(0);
      expect(records(run).join('\n')).toContain(TODAY);
    }, 30_000);

    it('drops a record a previous run left behind', () => {
      const work = scratchWorktree();
      const stale = join(work.root, '.ralph', 'logs', 'backoff-exhausted.json');
      writeFileSync(stale, JSON.stringify({ event: 'backoff-exhausted-shared', why: 'from another night' }));
      const run = runSupervisor(work, ['1'], FAST);
      expect(run.status).toBe(0);
      expect(existsSync(stale)).toBe(false);
    });
  });

  it('lets a fault outrank RETRY_LATER when the final message carries both', () => {
    const run = runSupervisor(scratchWorktree(), ['3'], {
      ...FAST,
      FAKE_SIGIL: '<ralph>RETRY_LATER</ralph> <ralph>NEEDS_TRIAGE</ralph>',
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('halting for repair');
  });

  it('starts every run with a clean slate — a restart is an operator saying try now', () => {
    const work = scratchWorktree();
    writeFileSync(
      join(work.root, '.ralph', 'logs', 'backoff.json'),
      JSON.stringify({ version: 1, reason: 'external', pr: null, fingerprint: null, strikes: 9, waitedSeconds: 99999, since: '2026-09-23T03:00:00Z' }),
    );
    const run = runSupervisor(work, ['1'], FAST);
    expect(run.status).toBe(0);
    expect(turns(run)).toHaveLength(1);
    expect(run.stdout).not.toContain('escalating');
  });

  it('clears a blocker a killed run left behind before the first iteration', () => {
    const work = scratchWorktree();
    const stale = join(work.root, '.ralph', 'logs', 'retry-blocker.json');
    writeFileSync(stale, JSON.stringify({ key: 'pr-red:7', summary: 'a blocker from another night' }));
    const run = runSupervisor(work, ['1'], FAST);
    expect(run.status).toBe(0);
    expect(existsSync(stale)).toBe(false);
    expect(run.stdout).not.toContain('a blocker from another night');
  });

  it('hands the iteration\'s blocker to the backoff, then drops it', () => {
    const work = scratchWorktree();
    const run = runSupervisor(work, ['1'], {
      ...FAST,
      FAKE_SIGIL: '<ralph>RETRY_LATER</ralph>',
      FAKE_SESSION_BLOCKER: JSON.stringify({ key: 'migration:0042', summary: 'prod is ahead of main on migration 0042' }),
    });
    expect(run.status).toBe(0);
    expect(
      run.argv.some((l) => l.includes('backoff.ts settle') && l.includes('--blocker-file .ralph/logs/retry-blocker.json')),
    ).toBe(true);
    expect(run.stdout).toContain('waiting on: prod is ahead of main on migration 0042');
    const state = JSON.parse(readFileSync(join(work.root, '.ralph', 'logs', 'backoff.json'), 'utf8'));
    expect(state.blocker).toMatchObject({ summary: 'prod is ahead of main on migration 0042' });
    expect(existsSync(join(work.root, '.ralph', 'logs', 'retry-blocker.json'))).toBe(false);
  });

  it('clears a park hand-off a killed run left behind before the first iteration (#776)', () => {
    const work = scratchWorktree();
    const stale = join(work.root, '.ralph', 'logs', 'block-park.json');
    writeFileSync(stale, JSON.stringify({ ticket: 7, condition: { kind: 'reference', ref: '#6' }, summary: 'from another night' }));
    const run = runSupervisor(work, ['1'], FAST);
    expect(run.status).toBe(0);
    expect(parkAtStart(run)).toEqual(['absent']);
    expect(existsSync(stale)).toBe(false);
  });

  it('drops an iteration\'s unread park hand-off before the next iteration (#776)', () => {
    const work = scratchWorktree();
    const run = runSupervisor(work, ['2'], {
      ...FAST,
      FAKE_SESSION_BLOCK_PARK: JSON.stringify({ ticket: 7, condition: { kind: 'reference', ref: '#6' }, summary: 'never read' }),
    });
    expect(run.status).toBe(0);
    expect(parkAtStart(run)).toEqual(['absent', 'absent']);
    expect(existsSync(join(work.root, '.ralph', 'logs', 'block-park.json'))).toBe(false);
  });

  it('does not wait the backoff again for a re-gate after a secret re-read hand-back (#759)', () => {
    // Iteration 1 leaves a backoff; the next ask waits it once, the gate hands
    // back for a re-read, and the re-gate goes straight to the gate again.
    // Waiting it on every hand-back would add a backoff per poll and spend the
    // budget until the loop stopped blocked.
    const run = runSupervisor(scratchWorktree(), ['2'], {
      ...FAST,
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_SIGIL: '<ralph>RETRY_LATER</ralph>',
      FAKE_GATE_NTH: '2',
      FAKE_GATE_NTH_OUTPUT: 'frontier-gate: secret re-read due — handing back to the supervisor — poll again in 0s',
    });
    expect(run.status).toBe(0);
    expect(turns(run)).toHaveLength(2);
    expect(run.argv.filter((l) => l.includes('ralph/backoff.ts wait'))).toHaveLength(1);
    expect(run.argv.filter((l) => l.includes('ralph/frontier-gate.ts'))).toHaveLength(3);
  }, 30_000);

  it('refuses backoff knobs that are not whole seconds', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], { RALPH_BACKOFF_BUDGET_SECONDS: 'overnight' });
    expect(run.status).toBe(1);
    expect(turns(run)).toHaveLength(0);
  });
});

/**
 * The park sweep (#775) runs before the gate is asked, so a ticket it wakes is
 * one the gate can see. It is harness bookkeeping, not a session, and nothing
 * about how it ends may reach the loop.
 */
describe('the park sweep before the gate', () => {
  const sweeps = (argv: string[]): string[] => argv.filter((l) => l.includes('park-probe.ts'));
  const claudeTurns = (argv: string[]): string[] => argv.filter((l) => l.startsWith('claude run-id='));

  it('sweeps once before each ask of the gate, ahead of it', () => {
    const run = runSupervisor(scratchWorktree(), ['1']);
    expect(run.status).toBe(0);
    expect(sweeps(run.argv)).toEqual(['ralph/park-probe.ts sweep']);
    const sweep = run.argv.indexOf('ralph/park-probe.ts sweep');
    const gate = run.argv.indexOf('ralph/frontier-gate.ts --once');
    expect(sweep).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(sweep);
    expect(claudeTurns(run.argv)).toHaveLength(1);
  });

  it('spawns no model session of its own', () => {
    // The gate finds nothing, so the only thing between start and stop is the
    // sweep and the ask: a sweep that started a session would show here.
    const run = runSupervisor(scratchWorktree(), ['3'], {
      FAKE_GATE_OUTPUT: 'frontier-gate: nothing to do — the frontier is empty',
      FAKE_GATE_STATUS: '1',
    });
    expect(run.status).toBe(0);
    expect(sweeps(run.argv)).toHaveLength(1);
    expect(run.argv.filter((l) => l.startsWith('claude '))).toHaveLength(0);
  });

  it.each([
    ['exits non-zero', { FAKE_PARK_SWEEP_STATUS: '3' }],
    ['crashes on a signal', { FAKE_PARK_SWEEP_CRASH: '1' }],
    ['is missing', { REAL_PARK_SWEEP: '1' }],
  ])('changes nothing when the sweep %s', (_how, env) => {
    const work = scratchWorktree();
    const run = runSupervisor(work, ['2'], env);
    expect(run.status).toBe(0);
    expect(sweeps(run.argv)).toHaveLength(2);
    expect(gateCalls(run.argv)).toEqual(['ralph/frontier-gate.ts --once', 'ralph/frontier-gate.ts --once']);
    expect(claudeTurns(run.argv)).toHaveLength(2);
    const log = readFileSync(join(work.root, '.ralph', 'logs', run.supervisorLogs[0]!), 'utf8');
    expect(log).toMatch(/the park sweep exited \d+; going on to the gate\./);
  });

  it('asks the blocking gate to sweep before its polls too, and only that gate', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], { RALPH_WAIT_FOR_WORK: '1' });
    expect(run.status).toBe(0);
    const asked = run.argv.indexOf('ralph/frontier-gate.ts 1');
    expect(asked).toBeGreaterThan(run.argv.indexOf('ralph/park-probe.ts sweep'));
    expect(run.argv.slice(asked)).toContain('gate park-sweep-in-gate=1');

    const once = runSupervisor(scratchWorktree(), ['1']);
    expect(once.argv).not.toContain('gate park-sweep-in-gate=1');
  });
});

/**
 * The ungated supervisor asks the same read-only question the gated one does —
 * once, before each spawn — so an empty frontier costs `gh` calls, not a
 * fresh-context turn. The gate itself is pinned by `frontier-gate.test.ts`;
 * what matters here is that the ask happens by default and that each answer
 * lands where it should.
 */
describe('the default pre-flight check', () => {
  it('asks the gate once before every iteration, without being asked to wait', () => {
    const run = runSupervisor(scratchWorktree(), ['2']);
    expect(run.status).toBe(0);
    expect(gateCalls(run.argv)).toEqual([
      'ralph/frontier-gate.ts --once',
      'ralph/frontier-gate.ts --once',
    ]);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(2);
  });

  it('stops without spending an iteration when the answer is nothing to do', () => {
    // Exit 1 with the gate's verdict in the output. The whole point of the
    // check: this used to be one Opus turn discovering ALL_BLOCKED for itself.
    const work = scratchWorktree();
    const run = runSupervisor(work, ['3'], {
      FAKE_GATE_OUTPUT: 'frontier-gate: nothing to do — every frontier candidate is held (#628)',
      FAKE_GATE_STATUS: '1',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('stopping without spending');
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(0);
    // The reason reaches the supervisor log, not just the console — status.sh
    // and a human read that file, not the nohup stdout.
    expect(run.supervisorLogs).toHaveLength(1);
    const log = readFileSync(join(work.root, '.ralph', 'logs', run.supervisorLogs[0]!), 'utf8');
    expect(log).toContain('every frontier candidate is held (#628)');
  });

  it('treats a gate that cannot run as fatal, like gated mode does', () => {
    // Exit 2 is not a verdict; it is a missing or unrunnable script. Stopping
    // exit 1 here matches "the frontier gate failed to start", and spawning
    // anyway would skip the only check standing between a spawn and an empty
    // frontier. Retried first (see the describe below), hence the knobs.
    const run = runSupervisor(scratchWorktree(), ['2'], {
      FAKE_GATE_STATUS: '2',
      RALPH_GATE_RETRY_SECONDS: '1',
    });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('failed to start');
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(0);
  });
});

/**
 * A gate exit that is not a verdict used to stop the loop on the spot, and a
 * missing file or an unrunnable script still stops it — a few tries later. But
 * it is also what a transient spawn failure looks like: loggd's rafa took
 * `ETXTBSY: text file is busy, posix_spawn 'bun'` on 2026-10-07 while idle on
 * its thirteenth poll, with the self-hosted CI runner writing at the time, and
 * sat down for 25 minutes over a frontier that was merely empty. So the ask is
 * retried, a bounded number of times, before the stop it had before.
 */
describe('a gate that never reached a verdict', () => {
  // One second per wait, so the doubling is visible without the test taking it.
  const RETRY_FAST = { RALPH_GATE_RETRY_SECONDS: '1', RALPH_GATE_RETRY_MAX_SECONDS: '1' };

  it('retries a single spawn failure and keeps going, ungated', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      ...RETRY_FAST,
      FAKE_GATE_BROKEN_UNTIL: '1',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('did not reach a verdict (status 2) — retrying in 1s (try 1 of 3)');
    expect(run.stdout).not.toContain('failed to start');
    // Asked twice — the failure and the ask that got an answer — and the
    // iteration the second answer called for was spawned.
    expect(gateCalls(run.argv)).toHaveLength(2);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
  });

  it('retries a single spawn failure and keeps waiting, gated', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      ...RETRY_FAST,
      RALPH_WAIT_FOR_WORK: '300',
      FAKE_GATE_BROKEN_UNTIL: '1',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('did not reach a verdict (status 2)');
    expect(gateCalls(run.argv)).toHaveLength(2);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
  });

  it('records every retry as a gate runner failure', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      ...RETRY_FAST,
      FAKE_GATE_BROKEN_UNTIL: '2',
    });

    expect(run.status).toBe(0);
    const observed = run.argv.filter((l) => l.includes('runner-failure.ts observe --stage gate'));
    expect(observed).toHaveLength(2);
    // The spawn error itself travels in the note, because on this path it is
    // the only error output there is — and it is what says "transient".
    expect(observed[0]).toContain('--exit 2');
    expect(observed[0]).toContain('ETXTBSY');
    expect(observed[1]).toContain('try 2 of 3');
  });

  it('still stops the loop once the gate has failed RALPH_GATE_RETRY_MAX times', () => {
    const run = runSupervisor(scratchWorktree(), ['2'], {
      ...RETRY_FAST,
      RALPH_GATE_RETRY_MAX: '2',
      FAKE_GATE_BROKEN_UNTIL: '9',
    });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('the intake gate failed to start; stopping.');
    // Two asks, one retry between them, and no iteration.
    expect(gateCalls(run.argv)).toHaveLength(2);
    expect(run.stdout).toContain('try 1 of 2');
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(0);
  });

  it('counts the streak per ask, so a recovered gate does not stop the next one', () => {
    // Broken, recovered, broken, recovered: with a run-long counter and a max
    // of 2 the second failure would be the last straw. It must not be.
    const run = runSupervisor(scratchWorktree(), ['2'], {
      ...RETRY_FAST,
      RALPH_GATE_RETRY_MAX: '2',
      FAKE_GATE_BROKEN_EVERY_OTHER: '1',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain('failed to start');
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(2);
  });

  it('grows the wait and holds it at the ceiling', () => {
    // The one mechanism the ticket named. Clamped to 1s everywhere else in this
    // describe, so without this a regression to a flat wait passes the suite.
    // Base 1, ceiling 2, four asks: 1s, 2s, 2s, then the stop.
    const run = runSupervisor(scratchWorktree(), ['1'], {
      RALPH_GATE_RETRY_SECONDS: '1',
      RALPH_GATE_RETRY_MAX_SECONDS: '2',
      RALPH_GATE_RETRY_MAX: '4',
      FAKE_GATE_BROKEN_UNTIL: '9',
    });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('retrying in 1s (try 1 of 4)');
    expect(run.stdout).toContain('retrying in 2s (try 2 of 4)');
    expect(run.stdout).toContain('retrying in 2s (try 3 of 4)');
    expect(run.stdout).toContain('the intake gate failed to start; stopping.');
  }, 30_000);

  it('never waits longer than the ceiling, even on the first try', () => {
    // The knobs are validated for shape, not against each other, and try 1
    // skips the doubling loop entirely — so a base above the ceiling used to
    // make the first wait the longest one.
    const run = runSupervisor(scratchWorktree(), ['1'], {
      RALPH_GATE_RETRY_SECONDS: '30',
      RALPH_GATE_RETRY_MAX_SECONDS: '1',
      RALPH_GATE_RETRY_MAX: '2',
      FAKE_GATE_BROKEN_UNTIL: '1',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('retrying in 1s (try 1 of 2)');
  });

  it('stops for an operator whose command arrives during the retry wait', () => {
    // The code's own comment calls sleeping through a stop a worse fault than
    // the one the retry covers, so the wait polls the inbox.
    const run = runSupervisor(scratchWorktree(), ['2'], {
      ...RETRY_FAST,
      REAL_CONTROLS: '1',
      RALPH_CONTROL_POLL_SECONDS: '1',
      FAKE_GATE_BROKEN_UNTIL: '9',
      FAKE_GATE_STOP_ON_BREAK: '1',
    });

    // The operator's stop, not the gate's streak: one ask, no "failed to start".
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('stopped by an operator — that is enough for tonight');
    expect(run.stdout).not.toContain('failed to start');
    expect(gateCalls(run.argv)).toHaveLength(1);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(0);
  }, 30_000);

  it('retries, records and finally stops on the gated path too', () => {
    // The incident's own path, and the one with the PIPESTATUS/tee machinery
    // around it — every other case here that exhausts the streak is ungated.
    const run = runSupervisor(scratchWorktree(), ['2'], {
      ...RETRY_FAST,
      RALPH_WAIT_FOR_WORK: '1',
      RALPH_GATE_RETRY_MAX: '2',
      FAKE_GATE_BROKEN_UNTIL: '9',
    });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('the intake gate failed to start; stopping.');
    expect(gateCalls(run.argv)).toHaveLength(2);
    const observed = run.argv.filter((l) => l.includes('runner-failure.ts observe --stage gate'));
    expect(observed).toHaveLength(2);
    expect(observed[0]).toContain('ETXTBSY');
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(0);
  }, 30_000);

  it('refuses a retry knob that is not a positive whole number', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], { RALPH_GATE_RETRY_MAX: '0' });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('RALPH_GATE_RETRY_MAX must be a positive integer');
    expect(gateCalls(run.argv)).toHaveLength(0);
  });
});

/**
 * The startup preflight, from the supervisor's side. What the checks ARE is
 * `preflight.test.ts`'s subject; what matters here is the wiring:
 *
 *   - it runs before the frontier gate and before the first paid turn, so a
 *     worktree missing a prerequisite costs a message rather than an Opus
 *     iteration;
 *   - a *denied* local requirement refuses the run, with the remedy the
 *     preflight printed, having claimed nothing;
 *   - an *unavailable* external service is a wait in BOTH modes — never a
 *     refusal, since a network blip must not permanently end a loop left
 *     running overnight, and never the ungated "nothing to do" stop either:
 *     an unreachable GitHub is not an empty backlog, it is no answer at all.
 */
describe('the startup preflight', () => {
  it('asks before the gate and before any paid turn', () => {
    const work = scratchWorktree();
    const run = runSupervisor(work, ['1']);

    expect(run.status).toBe(0);
    const asked = run.argv.filter((l) => l.includes('preflight.ts') || l.includes('frontier-gate.ts'));
    expect(asked).toEqual(['ralph/preflight.ts', 'ralph/frontier-gate.ts --once']);
    // Once for the whole run, not once per iteration: it answers about the
    // worktree, and the worktree does not change under a running supervisor.
    expect(runSupervisor(scratchWorktree(), ['2']).argv.filter((l) => l.includes('preflight.ts'))).toHaveLength(1);
  });

  it('refuses a denied local requirement, and repeats its remedy', () => {
    const work = scratchWorktree();
    const run = runSupervisor(work, ['3'], {
      FAKE_PREFLIGHT_STATUS: '1',
      FAKE_PREFLIGHT_OUTPUT: [
        'preflight: loop-labels — the repository has no rafa-wip label, so this loop could claim nothing',
        '           fix: gh label create rafa-wip',
      ].join('\n'),
    });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('gh label create rafa-wip');
    expect(run.stdout).toContain('nothing was claimed');
    expect(gateCalls(run.argv)).toHaveLength(0);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(0);
    // The failed check and its remedy reach the supervisor log too — that file
    // is what an operator reads after a loop was found stopped.
    const log = readFileSync(join(work.root, '.ralph', 'logs', run.supervisorLogs[0]!), 'utf8');
    expect(log).toContain('the repository has no rafa-wip label');
    expect(log).toContain('gh label create rafa-wip');
  });

  it('waits without claiming even ungated, on its own retry interval', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      RALPH_PREFLIGHT_RETRY_SECONDS: '1',
      FAKE_PREFLIGHT_UNAVAILABLE_ONCE: '1',
    });

    // No RALPH_WAIT_FOR_WORK, so the gate here is still the ungated one-shot
    // ask — but the preflight waits anyway, and claims nothing while it does.
    // An unreachable GitHub is not the gate's "nothing to do": stopping on it
    // would report a drained backlog this loop never actually saw.
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('waiting 1s without claiming work');
    expect(run.argv.filter((l) => l.includes('preflight.ts'))).toHaveLength(2);
    expect(gateCalls(run.argv)).toEqual(['ralph/frontier-gate.ts --once']);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
  });

  it('re-asks on the poll interval when there is one, rather than its own', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      RALPH_WAIT_FOR_WORK: '1',
      RALPH_PREFLIGHT_RETRY_SECONDS: '900',
      FAKE_PREFLIGHT_UNAVAILABLE_ONCE: '1',
    });

    // An operator who tightened or widened the poll interval gets that cadence
    // here too; the default exists only for a supervisor with no interval.
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('waiting 1s without claiming work');
  });

  it('refuses a retry interval that is not a positive number of seconds', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      RALPH_PREFLIGHT_RETRY_SECONDS: 'soon',
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('RALPH_PREFLIGHT_RETRY_SECONDS must be a positive integer');
    expect(run.argv.filter((l) => l.includes('preflight.ts'))).toHaveLength(0);
  });

  it('waits and re-asks rather than ending the loop', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_PREFLIGHT_UNAVAILABLE_ONCE: '1',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('the Doppler secrets could not be read');
    expect(run.stdout).toContain('waiting 1s without claiming work');
    // Asked twice: unavailable, then ready — and only then does anything spend.
    expect(run.argv.filter((l) => l.includes('preflight.ts'))).toHaveLength(2);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
  });

  it('names the refusing check in the stop record, so a reader need not parse the log', () => {
    const denied = (name: string) => JSON.stringify({
      verdict: 'denied',
      checks: [
        { name: 'tools', outcome: { status: 'ok' } },
        { name, outcome: { status: 'denied', why: 'no', remedy: 'fix it' } },
      ],
    });
    const stopOf = (name: string) => {
      const run = runSupervisor(scratchWorktree(), ['1'], {
        FAKE_PREFLIGHT_STATUS: '1',
        FAKE_PREFLIGHT_CHECKS: denied(name),
      });
      expect(run.status).toBe(1);
      return run.argv.filter((l) => l.includes('loop-state.ts record') && l.includes('--event preflight-denied'));
    };

    // `--detail` is lastEvent.detail in loop-state: the bare names, so a
    // Doppler scope a human must fix reads apart from a local config slip.
    const doppler = stopOf('doppler-scope');
    const config = stopOf('project-config');
    expect(doppler).toHaveLength(1);
    expect(config).toHaveLength(1);
    expect(doppler[0]).toContain('--stop failed --detail doppler-scope --why preflight refused startup on doppler-scope');
    expect(config[0]).toContain('--stop failed --detail project-config --why preflight refused startup on project-config');
  });

  it('keeps the old refusal when the verdict file names no check', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_PREFLIGHT_STATUS: '1',
      FAKE_PREFLIGHT_CHECKS: JSON.stringify({ verdict: 'denied', checks: [] }),
    });

    expect(run.status).toBe(1);
    const stop = run.argv.filter((l) => l.includes('loop-state.ts record') && l.includes('--event preflight-denied'));
    expect(stop).toHaveLength(1);
    expect(stop[0]).not.toContain('--detail');
    expect(stop[0]).toContain('--why preflight refused startup; a local requirement is not met');
  });

  it('waits on a denial with no verdict file, a preflight bun could not load (#767)', () => {
    // A module missing between `git pull` and `bun install` exits 1 before
    // main() writes anything: no evidence about the requirements, so a wait.
    const run = runSupervisor(scratchWorktree(), ['1'], {
      RALPH_PREFLIGHT_RETRY_SECONDS: '1',
      FAKE_PREFLIGHT_BROKEN_TIMES: '1',
      FAKE_PREFLIGHT_BROKEN_STATUS: '1',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('the preflight could not run (status 1, no verdict) — waiting 1s and asking again');
    const waits = run.argv.filter((l) => l.includes('loop-state.ts record') && l.includes('--event preflight-wait'));
    expect(waits).toHaveLength(1);
    expect(waits[0]).toContain('could not run (status 1, no verdict)');
    expect(run.argv.filter((l) => l.includes('--event preflight-denied'))).toHaveLength(0);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
  });

  it('alerts once on a long wait, names the check, and keeps waiting', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      RALPH_PREFLIGHT_RETRY_SECONDS: '1',
      RALPH_PREFLIGHT_ALERT_SECONDS: '1',
      FAKE_PREFLIGHT_UNAVAILABLE_TIMES: '3',
    });

    // Waited 0s, 1s, 2s: the second and third waits are both past the
    // threshold, and only the first of them may page anyone.
    expect(run.status).toBe(0);
    const waits = run.argv.filter((l) => l.includes('loop-state.ts record') && l.includes('--event preflight-wait'));
    expect(waits).toHaveLength(3);
    expect(waits[0]).toContain('--detail unavailable: doppler-scope; idle 0s');
    const pushes = run.argv.filter((l) => l.includes('push-notification.ts push --kind preflight-stalled'));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('--priority high');
    expect(pushes[0]).toContain('preflight waiting on doppler-scope');
    expect(run.argv.filter((l) => l.includes('loop-state.ts record') && /--event preflight-\S+ --stop/.test(l))).toHaveLength(0);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
  });

  it('refuses an alert threshold that is not a number of seconds', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      RALPH_PREFLIGHT_ALERT_SECONDS: 'later',
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('RALPH_PREFLIGHT_ALERT_SECONDS must be a non-negative integer');
    expect(run.argv.filter((l) => l.includes('preflight.ts'))).toHaveLength(0);
  });

  it('records a failed development environment check as a stop', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], { FAKE_SECRETS_ENV_FAILS: '1' });

    // It used to exit with no record, so the dashboard kept the last event
    // before it and showed a stopped loop as running.
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('development environment verification failed');
    expect(run.argv.some((l) => l.includes('loop-state.ts record --event secrets-env --stop failed'))).toBe(true);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(0);
  });

  it('holds a turn while the secrets scope cannot be read, then runs it once', () => {
    // Startup reads the scope; the turn's own probe then fails twice, the way
    // a keyring that locked again mid-run does, and reads on the third (#759).
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SECRETS_ENV_FAIL_TIMES: '2',
      RALPH_PREFLIGHT_RETRY_SECONDS: '1',
    });

    expect(run.status).toBe(0);
    const waits = run.stdout.split('\n').filter((l) => l.includes('the secrets scope could not be read'));
    expect(waits).toHaveLength(1);
    expect(waits[0]).toContain('(Doppler Error: failed to unlock correct collection');
    expect(waits[0]).not.toContain('second line of detail');
    expect(waits[0]).toContain('the turn waits and tries again every 1s.');
    // `waited` is wall-clock: two 1s retries take 2s on an idle host and more
    // on a loaded one, so pin the floor, not the exact figure.
    const resumed = /the secrets scope reads again after (\d+)s — running the turn\./.exec(run.stdout);
    expect(resumed, run.stdout).not.toBeNull();
    expect(Number(resumed![1])).toBeGreaterThanOrEqual(2);
    const records = run.argv.filter((l) => l.includes('loop-state.ts record --event secrets-scope-wait'));
    expect(records).toHaveLength(1);
    expect(records[0]).toContain('--stage iteration');
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
    // Neither a failed turn nor a stop: the wait spent nothing and broke nothing.
    // `observe` runs on a clean turn too; what must not appear is a turn that
    // exited non-zero.
    const observed = run.argv.filter((l) => l.includes('runner-failure.ts observe --stage orchestrator'));
    expect(observed).toHaveLength(1);
    expect(observed[0]).toContain('--exit 0');
    expect(run.argv.filter((l) => l.includes('loop-state.ts record') && l.includes('--stop failed'))).toHaveLength(0);
    expect(run.argv.filter((l) => l.includes('loop-state.ts record --event no-sigil'))).toHaveLength(0);
  });

  it('stops, spending no turn, when the secrets scope is denied mid-run (#759)', () => {
    // Startup read the scope; the turn's probe then answers an auth failure,
    // which no wait fixes: stop as the startup check does, with the remedy.
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SECRETS_ENV_FAIL_TIMES: '5',
      FAKE_SECRETS_ENV_ERROR: 'Doppler Error: Unauthorized',
      RALPH_PREFLIGHT_RETRY_SECONDS: '1',
    });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('secrets cannot be read — missing access or expired auth (Doppler Error: Unauthorized)');
    expect(run.stdout).toContain('to fix: doppler setup -p loggd-web -c dev   (then: doppler login)');
    expect(run.stdout).not.toContain('the secrets scope could not be read');
    expect(run.argv.filter((l) => l.includes('loop-state.ts record --event secrets-env --stop failed'))).toHaveLength(1);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(0);
  });

  for (const status of ['126', '127', '3']) {
    it(`waits on a preflight that could not run (status ${status}), then runs (#767)`, () => {
      // Not a verdict: an exec failure of the runtime (126 is `bun: Text file
      // busy`, 127 a missing one) or a crash (3) says nothing about the
      // loop's requirements, so it waits and asks again instead of stopping.
      const run = runSupervisor(scratchWorktree(), ['1'], {
        RALPH_PREFLIGHT_RETRY_SECONDS: '1',
        FAKE_PREFLIGHT_BROKEN_TIMES: '1',
        FAKE_PREFLIGHT_BROKEN_STATUS: status,
      });

      expect(run.status).toBe(0);
      expect(run.stdout).toContain(`the preflight could not run (status ${status}) — waiting 1s and asking again`);
      const waits = run.argv.filter((l) => l.includes('loop-state.ts record') && l.includes('--event preflight-wait'));
      expect(waits).toHaveLength(1);
      expect(waits[0]).toContain(`could not run (status ${status})`);
      expect(run.argv.filter((l) => l.includes('loop-state.ts record') && l.includes('--stop failed'))).toHaveLength(0);
      // The notifier pages on every preflight-broken record; a wait must not.
      expect(run.argv.filter((l) => l.includes('--event preflight-broken'))).toHaveLength(0);
      expect(run.argv.filter((l) => l.includes('preflight.ts'))).toHaveLength(2);
      expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
    });
  }

  it('doubles the wait on each consecutive could-not-run, and alerts once (#767)', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      RALPH_PREFLIGHT_RETRY_SECONDS: '1',
      RALPH_PREFLIGHT_ALERT_SECONDS: '1',
      FAKE_PREFLIGHT_BROKEN_TIMES: '3',
    });

    expect(run.status).toBe(0);
    const said = run.stdout.split('\n').filter((l) => l.includes('the preflight could not run'));
    expect(said.map((l) => /waiting (\d+)s/.exec(l)?.[1])).toEqual(['1', '2', '4']);
    // Idle 0s, 1s, 3s: two waits are past the threshold, one may page.
    const pushes = run.argv.filter((l) => l.includes('push-notification.ts push --kind preflight-stalled'));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('--priority high');
    expect(pushes[0]).toContain('preflight could not run (status 126)');
    expect(run.argv.filter((l) => l.includes('loop-state.ts record') && /--event preflight-\S+ --stop/.test(l))).toHaveLength(0);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
  });

  it('alerts again when the wait changes kind, under its own occurrence (#767)', () => {
    // An outage already paged for must not swallow the page for a preflight
    // that then stops running: a different thing for the operator to fix.
    const run = runSupervisor(scratchWorktree(), ['1'], {
      RALPH_PREFLIGHT_RETRY_SECONDS: '1',
      RALPH_PREFLIGHT_ALERT_SECONDS: '0',
      FAKE_PREFLIGHT_UNAVAILABLE_TIMES: '1',
      FAKE_PREFLIGHT_BROKEN_TIMES: '1',
    });

    expect(run.status).toBe(0);
    const pushes = run.argv.filter((l) => l.includes('push-notification.ts push --kind preflight-stalled'));
    expect(pushes).toHaveLength(2);
    expect(pushes[0]).toContain('preflight waiting on doppler-scope');
    expect(pushes[1]).toContain('preflight could not run (status 126)');
    const occurrences = pushes.map((l) => /--occurrence (\S+)/.exec(l)?.[1]);
    expect(occurrences[0]).toBeDefined();
    expect(occurrences[1]).toBeDefined();
    expect(occurrences[0]).not.toBe(occurrences[1]);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
  });
});

/**
 * Which loop this worktree is. `ralph` in the main worktree, `rafa` in the
 * second — and the iteration cannot be trusted to guess, because the label it
 * claims with is what keeps the other loop off the same ticket.
 */
describe('loop identity', () => {
  const loopOf = (run: Run): string[] =>
    run.argv.filter((l) => l.startsWith('claude loop=')).map((l) => l.replace('claude loop=', ''));

  it('defaults to ralph, and hands the name to the iteration', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], { FAKE_SIGIL: '<ralph>DONE</ralph>' });

    expect(loopOf(run)).toEqual(['ralph']);
  });

  it('takes the name from the worktree, so a hand-restarted loop keeps it', () => {
    const work = scratchWorktree();
    writeFileSync(join(work.root, '.ralph', 'loop-name'), 'rafa\n');

    const run = runSupervisor(work, ['1'], { FAKE_SIGIL: '<ralph>DONE</ralph>' });

    expect(loopOf(run)).toEqual(['rafa']);
    // And it says so on the console, because a log that reads "Ralph" while
    // rafa is claiming is the confusion the names exist to remove.
    expect(run.stdout).toContain('Rafa run ');
  });

  it('lets the environment override the file, for a one-off run', () => {
    const work = scratchWorktree();
    writeFileSync(join(work.root, '.ralph', 'loop-name'), 'rafa\n');

    const run = runSupervisor(work, ['1'], {
      RALPH_LOOP_NAME: 'ralph',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });

    expect(loopOf(run)).toEqual(['ralph']);
  });

  it('refuses a name nothing else reads, before spawning anything', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], { RALPH_LOOP_NAME: 'ralph2' });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("must be one of this project's loops (ralph, rafa, remo, rulo); got 'ralph2'");
    expect(loopOf(run)).toEqual([]);
  });

  it("checks the name against the project's own roster, and defaults to its first loop", () => {
    const project = () => {
      const work = scratchWorktree();
      writeFileSync(join(work.root, '.ralph', 'config.json'), JSON.stringify({ ...FIXTURE_CONFIG, loops: ['nova', 'vera'] }));
      return work;
    };

    expect(loopOf(runSupervisor(project(), ['1'], { FAKE_SIGIL: '<ralph>DONE</ralph>' }))).toEqual(['nova']);
    expect(loopOf(runSupervisor(project(), ['1'], { RALPH_LOOP_NAME: 'vera', FAKE_SIGIL: '<ralph>DONE</ralph>' }))).toEqual(['vera']);

    const refused = runSupervisor(project(), ['1'], { RALPH_LOOP_NAME: 'rafa' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("must be one of this project's loops (nova, vera); got 'rafa'");
  });

  it("hands the iteration the loop's role from the roster, never from the caller's environment", () => {
    const roleOf = (run: Run): string[] =>
      run.argv.filter((l) => l.startsWith('claude role=')).map((l) => l.replace('claude role=', ''));
    // loggd's roster is all strings: every loop is a coder, whatever the caller exported.
    const coder = runSupervisor(scratchWorktree(), ['1'], { RALPH_LOOP_ROLE: 'triager', FAKE_SIGIL: '<ralph>DONE</ralph>' });
    expect(loopOf(coder)).toEqual(['ralph']);
    expect(roleOf(coder)).toEqual(['coder']);

    const mixed = () => {
      const work = scratchWorktree();
      writeFileSync(
        join(work.root, '.ralph', 'config.json'),
        JSON.stringify({ ...FIXTURE_CONFIG, loops: ['nova', { name: 'tria', role: 'triager' }] }),
      );
      return work;
    };
    const triager = runSupervisor(mixed(), ['1'], { RALPH_LOOP_NAME: 'tria', FAKE_SIGIL: '<ralph>DONE</ralph>' });
    expect(loopOf(triager)).toEqual(['tria']);
    expect(roleOf(triager)).toEqual(['triager']);
    expect(roleOf(runSupervisor(mixed(), ['1'], { FAKE_SIGIL: '<ralph>DONE</ralph>' }))).toEqual(['coder']);
  });

  it("runs the gate its role declares, and hands the session the case whichever gate answered", () => {
    const caseOf = (run: Run): string[] =>
      run.argv.filter((l) => l.startsWith('claude case=')).map((l) => l.replace('claude case=', ''));
    const doctor = () => {
      const work = scratchWorktree();
      writeFileSync(
        join(work.root, '.ralph', 'config.json'),
        JSON.stringify({ ...FIXTURE_CONFIG, loops: ['nova', { name: 'doco', role: 'ci-doctor' }] }),
      );
      return work;
    };

    // A coder's gate is unchanged, and it is the role's declaration that says so.
    const coder = runSupervisor(doctor(), ['1'], {
      RALPH_LOOP_NAME: 'nova',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(gateCalls(coder.argv)).toEqual(['ralph/frontier-gate.ts --once']);

    // The doctor's asks Buildkite rather than the backlog, so it is a different
    // command — and it names itself differently on the verdict line, which the
    // supervisor must still read the case out of.
    const run = runSupervisor(doctor(), ['1'], {
      RALPH_LOOP_NAME: 'doco',
      FAKE_GATE_OUTPUT: 'ci-doctor-gate: work available — build 4821 on main is red (unit, 3 cases)',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(run.status).toBe(0);
    expect(run.argv.filter((l) => l.includes('ci-doctor/gate.ts'))).toEqual(['ralph/ci-doctor/gate.ts --once']);
    expect(gateCalls(run.argv)).toEqual([]);
    expect(caseOf(run)).toEqual(['build 4821 on main is red (unit, 3 cases)']);

    // A coder's ticket case still falls out of its own gate's line, unchanged.
    const ticket = runSupervisor(doctor(), ['1'], {
      RALPH_LOOP_NAME: 'nova',
      FAKE_GATE_OUTPUT: 'frontier-gate: work available — frontier ticket #612 — dup rows',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(caseOf(ticket)).toEqual(['frontier ticket #612 — dup rows']);
  });

  it("hands a pr-medic's claimed PR to the session as RALPH_INTAKE_PR and RALPH_INTAKE_REASON", () => {
    const field = (run: Run, name: string): string[] =>
      run.argv.filter((l) => l.startsWith(`claude ${name}=`)).map((l) => l.replace(`claude ${name}=`, ''));
    const medic = () => {
      const work = scratchWorktree();
      writeFileSync(
        join(work.root, '.ralph', 'config.json'),
        JSON.stringify({
          ...FIXTURE_CONFIG,
          loops: ['nova', { name: 'medi', role: 'pr-medic' }],
          prMedic: { branches: ['felipearosr/*'] },
        }),
      );
      return work;
    };

    // The reason is everything after the branch, whatever it holds — a check
    // name with a space or its own dash is still one reason.
    const run = runSupervisor(medic(), ['1'], {
      RALPH_LOOP_NAME: 'medi',
      FAKE_GATE_OUTPUT: 'pr-medic-gate: work available — operator PR #2197 on felipearosr/thing — conflicting; red: buildkite/loggd, CI — e2e',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(run.status).toBe(0);
    expect(run.argv.filter((l) => l.includes('pr-medic/gate.ts'))).toEqual(['ralph/pr-medic/gate.ts --once']);
    expect(field(run, 'intake-pr')).toEqual(['2197']);
    expect(field(run, 'intake-reason')).toEqual(['conflicting; red: buildkite/loggd, CI — e2e']);
    // And the backoff watches the PR, as it watches a coder's shepherd PR.
    expect(run.argv.some((l) => l.includes('backoff.ts settle') && l.includes('--pr 2197'))).toBe(true);

    // Any other case leaves both empty — set, never stale or absent.
    const coder = runSupervisor(medic(), ['1'], {
      RALPH_LOOP_NAME: 'nova',
      FAKE_GATE_OUTPUT: 'frontier-gate: work available — frontier ticket #612 — operator PR #1 on x — y',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(field(coder, 'intake-pr')).toEqual(['']);
    expect(field(coder, 'intake-reason')).toEqual(['']);
  });

  /**
   * Sigils, phases, secrets, the worktree invariant and the host lease are the
   * supervisor's last per-role behaviours (#140). Each is read off the role
   * descriptor through `role-behaviour.ts`, so these drive the REAL descriptors
   * — `roles.test.ts` pins what they say; this pins what `ralph.sh` does with
   * it — except where a fence needs a credential no role declares yet, which
   * the harness declares for itself below.
   */
  const withRole = (role: string, name = 'tria') => {
    const work = scratchWorktree();
    writeFileSync(
      join(work.root, '.ralph', 'config.json'),
      JSON.stringify({ ...FIXTURE_CONFIG, loops: ['nova', { name, role }] }),
    );
    return work;
  };

  it('gives a sigil this role may not use the recovery turn, then stops as no-sigil', () => {
    // A triager opens no pull request, runs no local gate and has no phases, so
    // all three hand-backs are endings it cannot honestly reach. Read instead
    // of refused, each would have the supervisor wait for something that does
    // not exist — a PR it never opened, a host it never contends for.
    for (const sigil of ['<ralph>AWAIT_PR 7 ci</ralph>', '<ralph>AWAIT_HOST 7</ralph>', '<ralph>PHASE verify 7</ralph>']) {
      const run = runSupervisor(withRole('triager'), ['1'], {
        RALPH_LOOP_NAME: 'tria',
        FAKE_SIGIL_SEQUENCE: `${sigil}|${sigil}`,
      });
      expect(run.status, `${sigil} did not stop the loop`).toBe(1);
      expect(run.stdout).toContain('ended cleanly without a sigil — recovering the missing sigil once');
      expect(run.stdout).toContain('ended without a sigil — stopping for safety');
      // And none of the machinery that sigil names was entered.
      expect(run.argv.some((line) => line.includes('pr-wait.ts') || line.includes('merge-wait.ts'))).toBe(false);
      expect(run.argv.some((line) => line.includes('host-lease.ts acquire'))).toBe(false);
      expect(run.argv.some((line) => line.includes('phase.ts boundary'))).toBe(false);
      // Exactly two model turns: the iteration and its one recovery.
      expect(run.argv.filter((line) => line.startsWith('claude run-id='))).toHaveLength(2);
    }
  });

  it('settles a sigil the role may use, and only recovers the ones it may not', () => {
    const ok = runSupervisor(withRole('triager'), ['1'], {
      RALPH_LOOP_NAME: 'tria',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(ok.status).toBe(0);
    expect(ok.stdout).not.toContain('recovering the missing sigil');
    expect(ok.argv.filter((line) => line.startsWith('claude run-id='))).toHaveLength(1);
  });

  it("handles a ci-doctor's COMPLETE as a missing sigil, not as a drained backlog", () => {
    // A doctor watches a branch that is never "drained", so the one ending
    // that retires a loop is not its to use. The danger is specific: read as
    // COMPLETE this would retire a loop whose subject is still red.
    const run = runSupervisor(withRole('ci-doctor', 'doco'), ['1'], {
      RALPH_LOOP_NAME: 'doco',
      FAKE_GATE_OUTPUT: 'ci-doctor-gate: work available — build 4821 on main is red',
      FAKE_SIGIL_SEQUENCE: '<ralph>COMPLETE</ralph>|<ralph>COMPLETE</ralph>',
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('recovering the missing sigil once');
    expect(run.stdout).not.toContain('backlog drained');
    // A coder's COMPLETE is untouched by any of this.
    const coder = runSupervisor(withRole('ci-doctor', 'doco'), ['1'], {
      RALPH_LOOP_NAME: 'nova',
      FAKE_SIGIL: '<ralph>COMPLETE</ralph>',
    });
    expect(coder.status).toBe(0);
    expect(coder.stdout).toContain('backlog drained');
  });

  it('offers the recovery turn only the endings the role may use', () => {
    const run = runSupervisor(withRole('triager'), ['1'], {
      RALPH_LOOP_NAME: 'tria',
      FAKE_SIGIL_SEQUENCE: 'no sigil at all|<ralph>DONE</ralph>',
    });
    expect(run.status).toBe(0);
    const recovery = run.argv.find((line) => line.includes('--resume') && line.includes('only recovery turn'));
    expect(recovery).toBeDefined();
    expect(recovery).not.toContain('<ralph>AWAIT_PR');
    expect(recovery).not.toContain('<ralph>COMPLETE');
    expect(recovery).toContain('<ralph>RETRY_LATER</ralph>');
  });

  it('never enters the phase machinery for a role whose phases are off', () => {
    const work = withRole('triager');
    const run = runSupervisor(work, ['1'], {
      RALPH_LOOP_NAME: 'tria',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(run.status).toBe(0);
    // No resume probe, no ledger, no boundary — and no ledger directory either,
    // which is what a later iteration would read as an interrupted ticket.
    expect(run.argv.some((line) => line.includes('phase-prompt.ts'))).toBe(false);
    expect(run.argv.some((line) => line.includes('phase.ts'))).toBe(false);
    expect(existsSync(join(work.root, '.ralph', 'logs', 'phases'))).toBe(false);
    // And no record claims a phase. This is the assertion that can fail: the
    // fixture has no ledger and no claim, so `phase_resume` would return early
    // whether the guard were there or not — while `--phase` is passed from
    // `ITERATION_PHASE`, which the guard is the only thing that leaves empty.
    // It is load-bearing too: `loop-state.ts` throws on an empty `--phase` and
    // `record` swallows it, so a regression here would silently drop a
    // phaseless role's whole timeline.
    const records = (from: Run): string[] => from.argv.filter((line) => line.includes('loop-state.ts record'));
    expect(records(run).length).toBeGreaterThan(0);
    expect(records(run).filter((line) => line.includes('--phase'))).toEqual([]);

    // A coder's records still carry one, from the same code path.
    const coder = runSupervisor(withRole('triager'), ['1'], {
      RALPH_LOOP_NAME: 'nova',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(records(coder).some((line) => line.includes('--phase select'))).toBe(true);
  });

  /**
   * The pr-medic's orchestrator rails (#247): its session is denied a raw
   * `git push` so `pr-medic/push.ts` is its one route to the operator's
   * branch. What has to hold as much as that is that no OTHER role's session
   * changes at all.
   */
  const withMedic = () => {
    const work = scratchWorktree();
    writeFileSync(
      join(work.root, '.ralph', 'config.json'),
      JSON.stringify({
        ...FIXTURE_CONFIG,
        loops: ['nova', { name: 'tria', role: 'triager' }, { name: 'doco', role: 'ci-doctor' }, { name: 'medi', role: 'pr-medic' }],
        prMedic: { branches: ['felipearosr/*'] },
      }),
    );
    return work;
  };
  const sessionArgv = (run: Run): string[] =>
    run.argv.filter((line) => line.startsWith('claude argv=')).map((line) => line.replace('claude argv=', ''));

  it("hands the pr-medic's session its own rails, and every other role's session the harness rails", () => {
    const work = withMedic();
    const medic = runSupervisor(work, ['1'], {
      RALPH_LOOP_NAME: 'medi',
      FAKE_GATE_OUTPUT: 'pr-medic-gate: work available — PR #2197 is red (buildkite/loggd)',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(medic.status).toBe(0);
    expect(sessionArgv(medic)).toHaveLength(1);
    expect(sessionArgv(medic)[0]).toContain(`--settings ${join(work.home, 'pr-medic', 'orchestrator-settings.json')}`);
    // A role file REPLACES the harness one, so the medic carries exactly one
    // `--settings` and it is not the harness file. Claude Code takes the last
    // of two, so handing it both would silently drop one file's rules — which
    // is the whole reason the medic's file repeats them.
    expect(sessionArgv(medic)[0]).not.toContain('claude-orchestrator-settings.json');
    expect(sessionArgv(medic)[0]?.match(/--settings/g) ?? []).toHaveLength(1);

    for (const [loop, gate] of [
      ['nova', 'frontier-gate: work available — frontier ticket #612 — dup rows'],
      ['tria', 'triage-gate: work available — 3 issues to triage'],
      ['doco', 'ci-doctor-gate: work available — build 4821 on main is red'],
    ] as const) {
      // Its own scratch harness, so the path asserted below is this run's.
      const roleWork = withMedic();
      const run = runSupervisor(roleWork, ['1'], { RALPH_LOOP_NAME: loop, FAKE_GATE_OUTPUT: gate, FAKE_SIGIL: '<ralph>DONE</ralph>' });
      expect(run.status).toBe(0);
      expect(sessionArgv(run)).toHaveLength(1);
      expect(sessionArgv(run)[0]).toContain(`--settings ${join(roleWork.home, 'claude-orchestrator-settings.json')}`);
      expect(sessionArgv(run)[0]).not.toContain('pr-medic/orchestrator-settings.json');
      expect(sessionArgv(run)[0]?.match(/--settings/g) ?? []).toHaveLength(1);
    }
  });

  it("runs a clerk's iteration on its batch under its own rails, holding no Slack or Jira credential", () => {
    // One clerk iteration through the supervisor (felipearos/ralph#318): the
    // gate's batch line reaches the session as its case, the session runs under
    // the clerk's rails rather than the harness's, and both clerk tokens are
    // stripped from it by name whatever the manager injects.
    const work = scratchWorktree();
    writeFileSync(
      join(work.root, '.ralph', 'config.json'),
      JSON.stringify({
        ...FIXTURE_CONFIG,
        loops: ['nova', { name: 'clara', role: 'clerk' }],
        appLabels: { backoffice: 'acme-backoffice', pwa: 'acme-pwa' },
        clerk: { channel: 'C0TESTCHAN1', jira: { site: 'example.atlassian.net', project: 'OA' } },
      }),
    );
    const run = runSupervisor(work, ['1'], {
      RALPH_LOOP_NAME: 'clara',
      RALPH_CLERK_SLACK_TOKEN: 'xoxb-clerk-test-0123456789',
      RALPH_CLERK_JIRA_TOKEN: 'clerk@example.com:jira-test-0123456789',
      FAKE_GATE_OUTPUT: 'clerk-gate: work available — 1 settled report in C0TESTCHAN1 (batch-1760961660.000100, attempt 1) — oldest https://example.slack.com/archives/C0TESTCHAN1/p1760961660000100',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(run.status).toBe(0);
    expect(run.argv.filter((line) => line.includes('clerk/gate.ts'))).toEqual(['ralph/clerk/gate.ts --once']);
    expect(run.argv).toContain('claude role=clerk');
    expect(run.argv).toContain(
      'claude case=1 settled report in C0TESTCHAN1 (batch-1760961660.000100, attempt 1) — oldest https://example.slack.com/archives/C0TESTCHAN1/p1760961660000100',
    );
    expect(sessionArgv(run)).toHaveLength(1);
    expect(sessionArgv(run)[0]).toContain(`--settings ${join(work.home, 'clerk', 'orchestrator-settings.json')}`);
    expect(sessionArgv(run)[0]?.match(/--settings/g) ?? []).toHaveLength(1);
    // Both tokens were in the supervisor's environment and passed their
    // checks; the session still holds neither.
    expect(run.stdout).toContain('RALPH_CLERK_SLACK_TOKEN is available to the intake gate');
    expect(run.stdout).toContain('RALPH_CLERK_JIRA_TOKEN is available to the intake gate');
    expect(run.argv).toContain('claude clerk-tokens=');
    expect(run.stdout + run.stderr).not.toContain('xoxb-clerk-test-0123456789');
  });

  it("reads a clerk's tokens by name from the project's scope, though its children run unwrapped", () => {
    // The clerk is given no secrets manager, and its tokens live only in the
    // configured Doppler scope: the supervisor must still read them by name and
    // hand them to the gate (#358). Before the fix it never asked, and every
    // real clerk loop refused to start with both tokens stored.
    const work = scratchWorktree();
    writeFileSync(
      join(work.root, '.ralph', 'config.json'),
      JSON.stringify({
        ...FIXTURE_CONFIG,
        loops: ['nova', { name: 'clara', role: 'clerk' }],
        appLabels: { backoffice: 'acme-backoffice', pwa: 'acme-pwa' },
        clerk: { channel: 'C0TESTCHAN1', jira: { site: 'example.atlassian.net', project: 'OA' } },
      }),
    );
    const run = runSupervisor(work, ['1'], {
      RALPH_LOOP_NAME: 'clara',
      FAKE_CLERK_SLACK: 'xoxb-clerk-scope-0123456789',
      FAKE_CLERK_JIRA: 'clerk@example.com:jira-scope-0123456789',
      FAKE_GATE_OUTPUT: 'clerk-gate: work available — 1 settled report in C0TESTCHAN1 (batch-1760961660.000100, attempt 1) — oldest https://example.slack.com/archives/C0TESTCHAN1/p1760961660000100',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(run.status).toBe(0);
    expect(run.argv).toContain('secrets get RALPH_CLERK_SLACK_TOKEN --plain -p loggd-web -c dev');
    expect(run.argv).toContain('secrets get RALPH_CLERK_JIRA_TOKEN --plain -p loggd-web -c dev');
    expect(run.stdout).toContain('RALPH_CLERK_SLACK_TOKEN is available to the intake gate');
    expect(run.stdout).toContain('RALPH_CLERK_JIRA_TOKEN is available to the intake gate');
    expect(run.stdout).not.toContain('is not in the secrets scope');
    // Still no application environment: nothing runs under `doppler run`.
    expect(run.argv.some((line) => line.startsWith('run '))).toBe(false);
    expect(run.argv).toContain('claude clerk-tokens=');
    expect(run.stdout + run.stderr).not.toContain('xoxb-clerk-scope-0123456789');
  });

  it("waits through a locked keyring and re-reads the clerk's tokens rather than refusing to start", () => {
    // 2026-10-29: the boot-time reconciler started clara before the login
    // keyring unlocked; both reads failed, the tokens were taken as absent,
    // the preflight denied, and the 09:00 KPI report never went out.
    const work = scratchWorktree();
    writeFileSync(
      join(work.root, '.ralph', 'config.json'),
      JSON.stringify({
        ...FIXTURE_CONFIG,
        loops: ['nova', { name: 'clara', role: 'clerk' }],
        appLabels: { backoffice: 'acme-backoffice', pwa: 'acme-pwa' },
        clerk: { channel: 'C0TESTCHAN1', jira: { site: 'example.atlassian.net', project: 'OA' } },
      }),
    );
    const run = runSupervisor(work, ['1'], {
      RALPH_LOOP_NAME: 'clara',
      RALPH_PREFLIGHT_RETRY_SECONDS: '1',
      FAKE_DOPPLER_LOCKED_READS: '2',
      FAKE_PREFLIGHT_SEES_UNREAD: '1',
      FAKE_CLERK_SLACK: 'xoxb-clerk-scope-0123456789',
      FAKE_CLERK_JIRA: 'clerk@example.com:jira-scope-0123456789',
      FAKE_GATE_OUTPUT: 'clerk-gate: work available — 1 settled report in C0TESTCHAN1 (batch-1760961660.000100, attempt 1) — oldest https://example.slack.com/archives/C0TESTCHAN1/p1760961660000100',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('RALPH_CLERK_SLACK_TOKEN could not be read from Doppler (Doppler Error: failed to unlock correct collection');
    expect(run.stdout).not.toContain('is not in the secrets scope');
    // One wait, then each token read a second time and proved.
    expect(run.argv.filter((l) => l.includes('loop-state.ts record') && l.includes('--event preflight-wait'))).toHaveLength(1);
    expect(run.argv.filter((l) => l === 'secrets get RALPH_CLERK_SLACK_TOKEN --plain -p loggd-web -c dev')).toHaveLength(2);
    expect(run.stdout).toContain('RALPH_CLERK_SLACK_TOKEN is available to the intake gate');
    expect(run.stdout).toContain('RALPH_CLERK_JIRA_TOKEN is available to the intake gate');
    expect(run.argv.filter((l) => l.includes('loop-state.ts record') && l.includes('--event preflight-denied'))).toHaveLength(0);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
    expect(run.stdout + run.stderr).not.toContain('xoxb-clerk-scope-0123456789');
  });

  /**
   * A sentinel's Sentry token is checked by no preflight, so a keyring still
   * locked at boot left the gate polling tokenless all night (#759). The gate
   * now hands back after a tokenless poll, and the supervisor reads the token
   * again between polls — without spawning an iteration for the hand-back.
   */
  const SENTINEL_CONFIG = {
    ...FIXTURE_CONFIG,
    loops: ['nova', { name: 'senti', role: 'sentinel' }],
    sentinel: { reporter: { kind: 'sentry', org: 'acme', project: 'web', environment: 'production' } },
  };
  const SENTINEL_REREAD_LINE = 'sentinel-gate: secret re-read due — handing back to the supervisor — poll again in 1s';
  const SENTINEL_TOKEN = 'sntrys_sentinel-test-0123456789';

  it("re-reads a sentinel's token Doppler could not hand over, between gate polls", () => {
    const work = scratchWorktree();
    writeFileSync(join(work.root, '.ralph', 'config.json'), JSON.stringify(SENTINEL_CONFIG));
    const run = runSupervisor(work, ['1'], {
      RALPH_LOOP_NAME: 'senti',
      // Wide, so the rate-limited re-read before an ask never fires within
      // the test: only the hand-back's forced one does, and its sleep is the
      // line's `poll again in 1s`, not this interval (#759).
      RALPH_WAIT_FOR_WORK: '30',
      FAKE_DOPPLER_LOCKED_READS: '1',
      FAKE_SENTINEL_SENTRY: SENTINEL_TOKEN,
      FAKE_GATE_FIRST_OUTPUT: SENTINEL_REREAD_LINE,
      FAKE_GATE_OUTPUT: 'sentinel-gate: work available — sentry issue WEB-1',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('RALPH_SENTINEL_SENTRY_TOKEN could not be read from Doppler (Doppler Error: failed to unlock correct collection');
    expect(run.argv.filter((l) => l === 'secrets get RALPH_SENTINEL_SENTRY_TOKEN --plain -p loggd-web -c dev')).toHaveLength(2);
    expect(run.stdout.split('RALPH_SENTINEL_SENTRY_TOKEN read on retry')).toHaveLength(2);
    // The first poll ran tokenless and handed back; the second had the token.
    expect(run.argv.filter((l) => l.startsWith('gate sentry-token='))).toEqual([
      'gate sentry-token=unset',
      'gate sentry-token=set',
    ]);
    // The hand-back spawned nothing: the one iteration is the work line's.
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
    expect(run.stdout + run.stderr).not.toContain(SENTINEL_TOKEN);
  });

  it("withholds a sentinel's token its check refuses, and does not read it again", () => {
    const work = scratchWorktree();
    writeFileSync(join(work.root, '.ralph', 'config.json'), JSON.stringify(SENTINEL_CONFIG));
    const run = runSupervisor(work, ['1'], {
      RALPH_LOOP_NAME: 'senti',
      RALPH_WAIT_FOR_WORK: '30',
      FAKE_SENTINEL_SENTRY: SENTINEL_TOKEN,
      FAKE_SENTINEL_CHECK_STATUS: '1',
      FAKE_GATE_FIRST_OUTPUT: SENTINEL_REREAD_LINE,
      FAKE_GATE_OUTPUT: 'sentinel-gate: work available — sentry issue WEB-1',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('RALPH_SENTINEL_SENTRY_TOKEN withheld');
    expect(run.stdout).not.toContain('read on retry');
    // Withheld is not unread: nothing is left to read again.
    expect(run.argv.filter((l) => l === 'secrets get RALPH_SENTINEL_SENTRY_TOKEN --plain -p loggd-web -c dev')).toHaveLength(1);
    expect(run.argv.filter((l) => l.startsWith('gate sentry-token='))).toEqual([
      'gate sentry-token=unset',
      'gate sentry-token=unset',
    ]);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
    expect(run.stdout + run.stderr).not.toContain(SENTINEL_TOKEN);
  });

  /**
   * Every role, every target (#759): a coder's iteration-only Buildkite read
   * token and a ci-doctor's gate-only retry token are read again the same
   * way, and a re-read that passes reaches exactly the targets a startup read
   * would have.
   */
  const BUILDKITE_TOKEN = 'bkua_reread0123456789abcdef0123456789';
  const bkReads = (run: Run): string[] =>
    run.argv.filter((l) => l === 'secrets get RALPH_BUILDKITE_READ_TOKEN --plain -p loggd-web -c dev');

  it("re-reads a coder's iteration token before a later iteration, and that iteration has it", () => {
    const run = runSupervisor(scratchWorktree(), ['2'], {
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_BUILDKITE_SECRET: BUILDKITE_TOKEN,
      // Locked until the first turn, which lasts past one poll interval, so
      // the next rate-limited re-read is due before the second iteration.
      FAKE_DOPPLER_LOCKED_UNTIL_TURN: '1',
      FAKE_TURN_DELAY: '1',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('RALPH_BUILDKITE_READ_TOKEN could not be read from Doppler (Doppler Error: failed to unlock correct collection');
    expect(run.stdout).toContain('it is read again before the next gate poll or iteration.');
    expect(run.stdout.split('RALPH_BUILDKITE_READ_TOKEN read on retry — available to the iteration.')).toHaveLength(2);
    const seen = run.argv.filter((l) => l.startsWith('claude buildkite='));
    // The first iteration ran without it: `doppler run` injects the whole
    // scope, so this is the filter's `-u` at work. The last has it, which only
    // holds once a passing re-read takes that `-u` back out.
    expect(seen[0]).toBe('claude buildkite=');
    expect(seen.at(-1)).toBe(`claude buildkite=${BUILDKITE_TOKEN}`);
    expect(run.argv.filter((l) => l.includes('loop-state.ts record') && l.includes('--event secret-reread'))).toHaveLength(1);
    expect(run.stdout + run.stderr).not.toContain(BUILDKITE_TOKEN);
  });

  it("never lifts a project's own withhold of a name when a re-read of it passes", () => {
    // The project's `secrets.withhold` names the token too: that `-u` is the
    // project's deny, so a passing re-read must leave it in the filter.
    const work = scratchWorktree();
    writeFileSync(
      join(work.root, '.ralph', 'config.json'),
      JSON.stringify({
        ...FIXTURE_CONFIG,
        secrets: { ...FIXTURE_CONFIG.secrets, withhold: [...FIXTURE_CONFIG.secrets.withhold, 'RALPH_BUILDKITE_READ_TOKEN'] },
      }),
    );
    const run = runSupervisor(work, ['2'], {
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_BUILDKITE_SECRET: BUILDKITE_TOKEN,
      FAKE_DOPPLER_LOCKED_UNTIL_TURN: '1',
      FAKE_TURN_DELAY: '1',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(run.status).toBe(0);
    expect(run.stdout.split('RALPH_BUILDKITE_READ_TOKEN read on retry')).toHaveLength(2);
    const seen = run.argv.filter((l) => l.startsWith('claude buildkite='));
    expect(seen).toHaveLength(2);
    expect(seen.every((l) => l === 'claude buildkite=')).toBe(true);
    expect(run.stdout + run.stderr).not.toContain(BUILDKITE_TOKEN);
  });

  it("recovers a ci-doctor's gate-only retry token through the gate's hand-back, for the gate alone", () => {
    const work = scratchWorktree();
    writeFileSync(
      join(work.root, '.ralph', 'config.json'),
      JSON.stringify({ ...FIXTURE_CONFIG, loops: ['nova', { name: 'doco', role: 'ci-doctor' }] }),
    );
    const token = 'bkua_retry0123456789abcdef0123456789';
    const run = runSupervisor(work, ['1'], {
      RALPH_LOOP_NAME: 'doco',
      // Wide, as in the sentinel's: only the hand-back's forced re-read fires.
      RALPH_WAIT_FOR_WORK: '30',
      FAKE_RETRY_SECRET: token,
      FAKE_DOPPLER_LOCKED_READS: '1',
      FAKE_DOPPLER_LOCKED_NAME: 'RALPH_BUILDKITE_RETRY_TOKEN',
      FAKE_GATE_FIRST_OUTPUT: 'ci-doctor-gate: secret re-read due — handing back to the supervisor — poll again in 1s',
      FAKE_GATE_OUTPUT: 'ci-doctor-gate: work available — build 4821 on main is red (unit, 3 cases)',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('RALPH_BUILDKITE_RETRY_TOKEN could not be read from Doppler');
    expect(run.stdout.split('RALPH_BUILDKITE_RETRY_TOKEN read on retry — available to the intake gate.')).toHaveLength(2);
    expect(run.argv.filter((l) => l.startsWith('gate retry-token='))).toEqual([
      'gate retry-token=unset',
      'gate retry-token=set',
    ]);
    // A gate secret, so the iteration never sees it, re-read or not.
    expect(run.argv.filter((l) => l.startsWith('claude retry-token='))).toEqual(['claude retry-token=unset']);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
    expect(run.stdout + run.stderr).not.toContain(token);
  });

  it('reads a secret the scope does not hold exactly once', () => {
    const run = runSupervisor(scratchWorktree(), ['2'], {
      RALPH_WAIT_FOR_WORK: '1',
      // Past one poll interval, so a re-read would be due if it were unread.
      FAKE_TURN_DELAY: '1',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('no RALPH_BUILDKITE_READ_TOKEN (RALPH_BUILDKITE_READ_TOKEN is not in the secrets scope)');
    expect(bkReads(run)).toHaveLength(1);
    expect(run.stdout).not.toContain('read on retry');
  });

  it('withholds a re-read token its check refuses, and never reads it a third time', () => {
    const run = runSupervisor(scratchWorktree(), ['3'], {
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_BUILDKITE_SECRET: BUILDKITE_TOKEN,
      FAKE_DOPPLER_LOCKED_READS: '1',
      FAKE_BK_CHECK_STATUS: '3',
      FAKE_TURN_DELAY: '1',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('RALPH_BUILDKITE_READ_TOKEN could not be read from Doppler');
    expect(run.stdout).toContain('RALPH_BUILDKITE_READ_TOKEN withheld: the Buildkite token is not read-only');
    expect(run.stdout).not.toContain('read on retry');
    expect(bkReads(run)).toHaveLength(2);
    expect(run.argv.filter((l) => l.startsWith('claude buildkite=')).every((l) => l === 'claude buildkite=')).toBe(true);
    expect(run.stdout + run.stderr).not.toContain(BUILDKITE_TOKEN);
  });

  /**
   * The clerk's code-context iterations (felipearos/ralph#499): a case the gate
   * hands as `code context <KEY> (<apps>)` runs the code-context prompt on the
   * lineup's `code-context` model, under the clerk's own rails; a report batch
   * runs exactly as before, even right after one.
   */
  const CLERK_EXPORTS = [
    "export RALPH_MODEL_ORCHESTRATOR='claude-opus-5'",
    "export RALPH_RUNNER_ORCHESTRATOR='claude'",
    "export RALPH_MODEL_CODE_CONTEXT='claude-opus-5-5'",
    "export RALPH_RUNNER_CODE_CONTEXT='claude'",
    "export RALPH_MODEL_ORCHESTRATOR_EFFORT='medium'",
    "export RALPH_MODEL_CODE_CONTEXT_EFFORT='high'",
    "export RALPH_MODEL_STAGE_VARS='RALPH_MODEL_ORCHESTRATOR RALPH_MODEL_CODE_CONTEXT'",
    "export RALPH_RUNNER_STAGE_VARS='RALPH_RUNNER_ORCHESTRATOR RALPH_RUNNER_CODE_CONTEXT'",
  ].join('\n');
  const CLERK_BATCH = 'clerk-gate: work available — 1 settled report in C0TESTCHAN1 (batch-1760961660.000100, attempt 1) — oldest https://example.slack.com/archives/C0TESTCHAN1/p1760961660000100';
  const CODE_CONTEXT_CASE = 'clerk-gate: work available — code context OAI-62 (pwa)';
  const clerkWork = (template = true) => {
    const work = scratchWorktree();
    writeFileSync(
      join(work.root, '.ralph', 'config.json'),
      JSON.stringify({
        ...FIXTURE_CONFIG,
        loops: ['nova', { name: 'clara', role: 'clerk' }],
        appLabels: { backoffice: 'acme-backoffice', pwa: 'acme-pwa' },
        clerk: { channel: 'C0TESTCHAN1', jira: { site: 'example.atlassian.net', project: 'OA' } },
      }),
    );
    if (template) writeFileSync(join(work.home, 'prompts', 'clerk-code-context.md'), 'a stub code-context prompt\n');
    return work;
  };
  const clerkEnv = (env: Record<string, string>) => ({
    RALPH_LOOP_NAME: 'clara',
    RALPH_CLERK_SLACK_TOKEN: 'xoxb-clerk-test-0123456789',
    RALPH_CLERK_JIRA_TOKEN: 'clerk@example.com:jira-test-0123456789',
    FAKE_LINEUP_EXPORTS: CLERK_EXPORTS,
    FAKE_SIGIL: '<ralph>DONE</ralph>',
    ...env,
  });

  it("runs a clerk's code-context case on its own prompt and model, and the next report batch on the clerk's", () => {
    const work = clerkWork();
    const run = runSupervisor(work, ['2'], clerkEnv({ FAKE_GATE_FIRST_OUTPUT: CODE_CONTEXT_CASE, FAKE_GATE_OUTPUT: CLERK_BATCH }));
    expect(run.status).toBe(0);
    const [codeContext, batch] = sessionArgv(run);
    expect(sessionArgv(run)).toHaveLength(2);
    expect(run.argv).toContain('claude case=code context OAI-62 (pwa)');
    const rails = `--settings ${join(work.home, 'clerk', 'orchestrator-settings.json')}`;

    expect(codeContext).toContain('-p rendered:a stub code-context prompt');
    expect(codeContext).toContain(`--model claude-opus-5-5 --effort high ${rails}`);
    expect(codeContext).not.toContain('a stub clerk prompt');
    expect(codeContext?.match(/--settings/g) ?? []).toHaveLength(1);
    expect(run.stdout).toContain('iteration 1 is code context OAI-62 — prompts/clerk-code-context.md on claude-opus-5-5 (effort high).');

    // The batch after it is untouched: the clerk's prompt, model and rails.
    expect(batch).toContain('-p rendered:a stub clerk prompt');
    expect(batch).toContain(`--model claude-opus-5 --effort medium ${rails}`);
    expect(batch).not.toContain('claude-opus-5-5');
    expect(batch).not.toContain('code-context prompt');
    expect(run.stdout).not.toContain('iteration 2 is code context');
    // Named in the models line like every other stage, hyphen and all.
    expect(run.stdout).toContain('models — orchestrator claude-opus-5 on claude, code-context claude-opus-5-5 on claude');
    expect(run.stdout + run.stderr).not.toContain('xoxb-clerk-test-0123456789');
  });

  it("keeps a code-context iteration's recovery turn on the code-context model, with its own menu of endings", () => {
    const work = clerkWork();
    const run = runSupervisor(work, ['1'], clerkEnv({
      FAKE_GATE_OUTPUT: CODE_CONTEXT_CASE,
      FAKE_FIRST_SIGIL: 'no sigil',
      FAKE_RECOVERY_SIGIL: '<ralph>DONE</ralph>',
    }));
    expect(run.status).toBe(0);
    const [first, recovery] = sessionArgv(run);
    expect(sessionArgv(run)).toHaveLength(2);
    expect(first).toContain('--model claude-opus-5-5 --effort high');
    expect(recovery).toContain('--model claude-opus-5-5 --effort high');
    expect(recovery).toContain('--resume');
    expect(recovery).toContain('You read the code behind one filed ticket and write one result file');
    expect(recovery).not.toContain('every report in the batch gets an entry');
  });

  it('runs a code-context case as a clerk iteration, with a warning, when its prompt cannot be rendered', () => {
    // Fail soft: the clerk still starts and still files reports.
    const work = clerkWork(false);
    const run = runSupervisor(work, ['1'], clerkEnv({ FAKE_GATE_OUTPUT: CODE_CONTEXT_CASE }));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('code context is off for this run: prompts/clerk-code-context.md could not be rendered (models: cannot read');
    expect(run.stdout).toContain('the gate handed a code-context case (code context OAI-62 (pwa)), but code context is off for this run; running it as a clerk iteration.');
    expect(sessionArgv(run)).toHaveLength(1);
    expect(sessionArgv(run)[0]).toContain('-p rendered:a stub clerk prompt');
    expect(sessionArgv(run)[0]).toContain('--model claude-opus-5 --effort medium');
    expect(sessionArgv(run)[0]).not.toContain('claude-opus-5-5');
  });

  it("never renders the code-context prompt, or switches on its case text, for a role that is not the clerk", () => {
    const work = clerkWork();
    const run = runSupervisor(work, ['1'], { FAKE_GATE_OUTPUT: 'frontier-gate: work available — code context OAI-62 (pwa)' });
    expect(run.status).toBe(0);
    expect(run.argv.some((line) => line.includes('clerk-code-context.md'))).toBe(false);
    expect(sessionArgv(run)[0]).toContain('-p rendered:a stub prompt');
    expect(sessionArgv(run)[0]).toContain('--model claude-opus-5 ');
  });

  /**
   * The harness-wide rails (#300): the orchestrator session reads untrusted
   * ticket text and the project's secrets CLI is still authenticated on the
   * host, so every claude orchestrator carries
   * `claude-orchestrator-settings.json` — on EVERY turn, because a resumed
   * session that dropped the flag would read the next ticket unrailed.
   */
  it('carries the harness orchestrator rails on every turn, a resumed one included', () => {
    const work = scratchWorktree();
    const run = runSupervisor(work, ['1'], {
      FAKE_FIRST_SIGIL: '<ralph>AWAIT_HOST 1604</ralph>',
      FAKE_RECOVERY_SIGIL: '<ralph>DONE</ralph>',
      FAKE_HOST_LEASE_RESULT:
        '{"outcome":"granted","ticket":1604,"command":"bun run build twice","expiresAt":"2026-09-29T12:00:00Z","detail":"idle"}',
    });

    expect(run.status, run.stderr).toBe(0);
    const argv = sessionArgv(run);
    expect(argv).toHaveLength(2);
    expect(argv[1]).toContain('--resume');
    for (const turn of argv) {
      expect(turn).toContain(`--settings ${join(work.home, 'claude-orchestrator-settings.json')}`);
    }
  });

  /**
   * `merge: "human"` (acme-pwa PR #41, 2026-10-26): a person merges, so the
   * orchestrator is denied `gh pr merge` on every turn, beside its rails. A
   * project that leaves `merge` out keeps the flag off its argv.
   */
  it('denies gh pr merge on every turn when a person merges, and only then', () => {
    const work = scratchWorktree();
    writeFileSync(join(work.root, '.ralph', 'config.json'), JSON.stringify({ ...FIXTURE_CONFIG, merge: 'human' }));
    const run = runSupervisor(work, ['1'], {
      FAKE_FIRST_SIGIL: '<ralph>AWAIT_HOST 1604</ralph>',
      FAKE_RECOVERY_SIGIL: '<ralph>DONE</ralph>',
      FAKE_HOST_LEASE_RESULT:
        '{"outcome":"granted","ticket":1604,"command":"bun run build twice","expiresAt":"2026-09-29T12:00:00Z","detail":"idle"}',
    });

    expect(run.status, run.stderr).toBe(0);
    const argv = sessionArgv(run);
    expect(argv).toHaveLength(2);
    for (const turn of argv) expect(turn).toContain('--disallowedTools Bash(gh pr merge:*) Bash(gh pr merge *)');

    const loop = runSupervisor(scratchWorktree(), ['1'], { FAKE_FIRST_SIGIL: '<ralph>DONE</ralph>' });
    expect(loop.status, loop.stderr).toBe(0);
    expect(sessionArgv(loop)[0]).not.toContain('--disallowedTools');
  });

  it('starts a codex orchestrator with no rails, saying so once, for a role that needs none', () => {
    const work = withMedic();
    // A real `codex` is needed here, unlike the refusal test below, because
    // this run is expected to reach the session rather than exit before it.
    writeExecutable(join(work.bin, 'codex'), [
      '#!/usr/bin/env python3',
      'import json, sys',
      'sys.stdin.read()',
      "print(json.dumps({'type': 'thread.started', 'thread_id': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}))",
      "print(json.dumps({'type': 'item.completed', 'item': {'type': 'agent_message', 'text': '<ralph>DONE</ralph>'}}))",
      "print(json.dumps({'type': 'turn.completed', 'usage': {'input_tokens': 100, 'cached_input_tokens': 40, 'output_tokens': 5}}))",
    ]);
    const run = runSupervisor(work, ['1'], {
      CODEX_HOME: work.root,
      RALPH_LOOP_NAME: 'nova',
      FAKE_LINEUP_EXPORTS: [
        "export RALPH_MODEL_ORCHESTRATOR='gpt-5.5'",
        "export RALPH_RUNNER_ORCHESTRATOR='codex'",
        "export RALPH_MODEL_STAGE_VARS='RALPH_MODEL_ORCHESTRATOR'",
        "export RALPH_RUNNER_STAGE_VARS='RALPH_RUNNER_ORCHESTRATOR'",
      ].join('\n'),
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });

    // No settings file can be handed to codex, so it is not refused — the
    // prompt's rule is its fence, and the absence is said once rather than
    // being silent. Only a role that REQUIRES rails is refused (above).
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain('carries no settings rails');
    expect(run.argv.some((line) => line.includes('--settings'))).toBe(false);
  });

  it('refuses to start a claude orchestrator whose harness rails cannot be read', () => {
    const work = scratchWorktree();
    rmSync(join(work.home, 'claude-orchestrator-settings.json'));
    const run = runSupervisor(work, ['1'], { FAKE_SIGIL: '<ralph>DONE</ralph>' });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('refusing to start: the orchestrator rails');
    expect(run.argv.some((line) => line.startsWith('claude argv='))).toBe(false);
  });

  it("does not let an operator's environment rail a role that declares no rails", () => {
    const work = withMedic();
    const run = runSupervisor(work, ['1'], {
      RALPH_LOOP_NAME: 'nova',
      RALPH_ROLE_ORCHESTRATOR_SETTINGS: 'pr-medic/orchestrator-settings.json',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(run.status).toBe(0);
    // `role-behaviour.ts` exports the name EMPTY for a role with none, so the
    // operator's value never reaches `--settings`; the coder gets the harness
    // rails, which is not the same thing as the medic's.
    expect(sessionArgv(run)[0]).toContain(`--settings ${join(work.home, 'claude-orchestrator-settings.json')}`);
    expect(sessionArgv(run)[0]).not.toContain('pr-medic/orchestrator-settings.json');
  });

  it('refuses to start a pr-medic under an orchestrator runner that cannot carry its rails', () => {
    const run = runSupervisor(withMedic(), ['1'], {
      RALPH_LOOP_NAME: 'medi',
      FAKE_LINEUP_EXPORTS: [
        "export RALPH_MODEL_ORCHESTRATOR='gpt-5.5'",
        "export RALPH_RUNNER_ORCHESTRATOR='codex'",
        "export RALPH_MODEL_STAGE_VARS='RALPH_MODEL_ORCHESTRATOR'",
        "export RALPH_RUNNER_STAGE_VARS='RALPH_RUNNER_ORCHESTRATOR'",
      ].join('\n'),
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("refusing to start: the pr-medic role's orchestrator must run under rails");
    expect(run.argv.some((line) => line.startsWith('claude ') || line.includes('codex-orchestrator.py'))).toBe(false);
  });

  it('keeps the phase machinery for a role that has it', () => {
    const run = runSupervisor(withRole('ci-doctor', 'doco'), ['1'], {
      RALPH_LOOP_NAME: 'doco',
      FAKE_GATE_OUTPUT: 'ci-doctor-gate: work available — build 4821 on main is red',
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE verify 7</ralph>|<ralph>DONE</ralph>',
    });
    expect(run.status).toBe(0);
    expect(run.argv.some((line) => line.includes('phase.ts boundary'))).toBe(true);
    expect(run.stdout).toContain('phase select → verify');
  });

  it('gives a role with no secrets no environment at all, and no env check', () => {
    const run = runSupervisor(withRole('triager'), ['1'], {
      RALPH_LOOP_NAME: 'tria',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
      FAKE_INJECTED_VALUE: 'withheld-value-0123456789',
      FAKE_BUILDKITE_SECRET: 'bkua_readonly0123456789abcdef0123456789',
    });
    expect(run.status).toBe(0);
    // `doppler run` never wraps a triager's children, so nothing is injected —
    // and the project's own env check is skipped with it, since with nothing
    // injected it would refuse every triager start over a DATABASE_URL no
    // triager uses.
    expect(run.argv.some((line) => line.startsWith('run '))).toBe(false);
    expect(run.argv).toContain('claude injected=');
    expect(run.argv).toContain('claude buildkite=');
    expect(run.argv.some((line) => line.includes('bk-log.ts'))).toBe(false);
    expect(run.stderr).toContain('is given no application environment');
    // And it still ran: no environment is not "no iteration".
    expect(run.argv.filter((line) => line.startsWith('claude run-id='))).toHaveLength(1);
  });

  it("gives a gate secret to the role's gate alone, and never to any iteration", () => {
    // The harness declares a fake gate secret rather than borrowing the
    // doctor's retry token: what is under test is the supervisor's split, not
    // the descriptor's contents, which `roles.test.ts` pins.
    const fake = 'fake-gate-token-0123456789';
    const gated = (work: ReturnType<typeof scratchWorktree>) => {
      cpSync(join(HARNESS, 'role-behaviour.ts'), join(work.home, 'role-behaviour.real.ts'));
      writeFileSync(
        join(work.home, 'role-behaviour.ts'),
        [
          'import { exportLines } from "./role-behaviour.real";',
          'const role = process.argv[3] ?? "coder";',
          'console.log([...exportLines(role as never),',
          '  "export RALPH_ROLE_SECRETS=\'FAKE_GATE_TOKEN\'",',
          '  "export RALPH_ROLE_SECRETS_GATE=\'FAKE_GATE_TOKEN\'",',
          '  "export RALPH_ROLE_SECRETS_ITERATION=\'\'",',
          '  "export RALPH_ROLE_SECRET_CHECK_FAKE_GATE_TOKEN=\'fake-check.ts\'",',
          "].join(String.fromCharCode(10)));",
        ].join('\n'),
      );
      return work;
    };

    const run = runSupervisor(gated(scratchWorktree()), ['1'], {
      FAKE_GATE_CREDENTIAL: fake,
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(run.status).toBe(0);
    // Checked before it is handed anywhere.
    expect(run.argv).toContain('ralph/fake-check.ts');
    // The gate acts with it…
    expect(run.argv).toContain(`gate secret=${fake}`);
    // …and no model session sees it, even though `doppler run` injects the
    // whole scope into every child: the strip is what makes this true.
    expect(run.argv).toContain('claude gate-secret=');
    expect(run.argv).not.toContain(`claude gate-secret=${fake}`);
    expect(run.argv.some((line) => line.startsWith('run ') && line.includes('-u FAKE_GATE_TOKEN'))).toBe(true);
    // Never logged, in either direction.
    expect(run.stdout + run.stderr).not.toContain(fake);

    // A failed check withholds it from the gate too, not merely from the session.
    const refused = runSupervisor(gated(scratchWorktree()), ['1'], {
      FAKE_GATE_CREDENTIAL: fake,
      FAKE_CHECK_STATUS: '3',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(refused.status).toBe(0);
    expect(refused.argv).toContain('gate secret=');
    expect(refused.argv).not.toContain(`gate secret=${fake}`);
    expect(refused.stdout).toContain('FAKE_GATE_TOKEN withheld');
    // Stored and refused: withheld, never available. The preflight reads these
    // two lists to tell that apart from nothing being stored at all.
    expect(refused.argv).toContain('claude secrets-withheld=FAKE_GATE_TOKEN');
    expect(refused.argv).toContain('claude secrets-available=');
  });

  it('reports a secret declared with no checker as withheld, not as missing', () => {
    // No role declares `check: null` today — the doctor's retry token was the
    // last one and #161 gave it a checker — but the supervisor's third answer
    // must keep working for the next secret declared ahead of its check, which
    // is what `preflight.ts`'s `buildkite-retry` warning rests on. Fenced end
    // to end here because the reader's
    // own tests set the lists by hand: without this, narrowing the accumulator
    // to secrets that have a checker would leave the whole suite green while
    // the doctor silently went back to being told to store a token it has.
    const fake = 'fake-gate-token-0123456789';
    const work = scratchWorktree();
    cpSync(join(HARNESS, 'role-behaviour.ts'), join(work.home, 'role-behaviour.real.ts'));
    writeFileSync(
      join(work.home, 'role-behaviour.ts'),
      [
        'import { exportLines } from "./role-behaviour.real";',
        'const role = process.argv[3] ?? "coder";',
        'console.log([...exportLines(role as never),',
        '  "export RALPH_ROLE_SECRETS=\'FAKE_GATE_TOKEN\'",',
        '  "export RALPH_ROLE_SECRETS_GATE=\'FAKE_GATE_TOKEN\'",',
        '  "export RALPH_ROLE_SECRETS_ITERATION=\'\'",',
        // The whole point: declared, in the scope, and with no check command.
        '  "export RALPH_ROLE_SECRET_CHECK_FAKE_GATE_TOKEN=\'\'",',
        "].join(String.fromCharCode(10)));",
      ].join('\n'),
    );

    const run = runSupervisor(work, ['1'], { FAKE_GATE_CREDENTIAL: fake, FAKE_SIGIL: '<ralph>DONE</ralph>' });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('FAKE_GATE_TOKEN has no check command yet, so it is withheld');
    expect(run.argv).toContain('claude secrets-withheld=FAKE_GATE_TOKEN');
    expect(run.argv).toContain('claude secrets-available=');
    // Withheld means withheld: the gate does not get it either.
    expect(run.argv).not.toContain(`gate secret=${fake}`);
    expect(run.stdout + run.stderr).not.toContain(fake);
  });

  it("strips another role's secret from a loop that declares none of it", () => {
    // The manager injects the whole scope into every child, so a credential a
    // coder never declared still reaches it unless it is stripped by name.
    const run = runSupervisor(scratchWorktree(), ['1'], { FAKE_SIGIL: '<ralph>DONE</ralph>' });
    expect(run.status).toBe(0);
    expect(
      run.argv.some((line) => line.startsWith('run ') && line.includes('-u RALPH_BUILDKITE_RETRY_TOKEN')),
      "the doctor's retry token is not stripped from a coder",
    ).toBe(true);
    // And it is never read for a coder: it is not that role's to have.
    expect(run.argv.some((line) => line.includes('secrets get RALPH_BUILDKITE_RETRY_TOKEN'))).toBe(false);
  });

  it("restores the worktree a read-only role dirtied, and says so once", () => {
    const work = withRole('triager');
    const run = runSupervisor(work, ['1'], {
      RALPH_LOOP_NAME: 'tria',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
      FAKE_SESSION_WRITES: join(work.root, 'stray.txt'),
      FAKE_DIRTY: '?? stray.txt',
    });
    // Repaired, not fatal: a read-only role that wrote something has a prompt
    // bug, and stopping the run would leave the stray edit where the next loop
    // reads it.
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('left the worktree dirty');
    // The diff is saved BEFORE the restore, so the restore can never be the
    // thing that loses it.
    const saved = readdirSync(join(work.root, '.ralph', 'logs')).filter((f) => f.startsWith('triager-violation-'));
    expect(saved).toHaveLength(1);
    // The patch has the work in it. File existence alone is satisfied by the
    // shell redirection, so it would pass with the `git diff` dropped entirely.
    expect(readFileSync(join(work.root, '.ralph', 'logs', saved[0]!), 'utf8')).toContain('+stray');
    // Against the BASE REF: a role that wrongly committed has its work in a
    // commit, which `git diff HEAD` does not show — and the reset would then be
    // the thing that lost it.
    expect(run.argv).toContain('git diff origin/main');
    const order = run.argv.map((line, index) => ({ line, index }));
    const at = (prefix: string): number => order.find((entry) => entry.line.startsWith(prefix))?.index ?? -1;
    expect(at('git diff origin/main')).toBeGreaterThanOrEqual(0);
    // Saved before anything is restored, and DETACHED before the reset: a reset
    // on an attached HEAD rewrites the branch the role should merely have
    // abandoned.
    expect(at('git switch --detach origin/main')).toBeGreaterThan(at('git diff origin/main'));
    expect(at('git reset --hard origin/main')).toBeGreaterThan(at('git switch --detach origin/main'));
    expect(run.argv).toContain('git clean -fd');
    // And a human hears about it: a role breaking its own fence is worth an eye.
    expect(run.argv.some((line) => line.includes('push-notification.ts push --kind role-invariant'))).toBe(true);
  });

  it("reads being left on a branch as a violation too, and leaves a role with no invariant alone", () => {
    const onBranch = runSupervisor(withRole('triager'), ['1'], {
      RALPH_LOOP_NAME: 'tria',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
      FAKE_BRANCH: 'tria/140-something',
    });
    expect(onBranch.status).toBe(0);
    expect(onBranch.stdout).toContain('left the checkout on tria/140-something');
    expect(onBranch.argv).toContain('git switch --detach origin/main');

    // A coder's whole job is a branch with commits on it. Restoring THAT would
    // destroy the iteration's work, so a role with no invariant is never touched.
    const coder = runSupervisor(withRole('triager'), ['1'], {
      RALPH_LOOP_NAME: 'nova',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
      FAKE_BRANCH: 'nova/140-something',
      FAKE_DIRTY: ' M src/app.ts',
    });
    expect(coder.status).toBe(0);
    expect(coder.stdout).not.toContain('restored the checkout');
    expect(coder.argv.some((line) => line.startsWith('git reset --hard'))).toBe(false);
    expect(coder.argv.some((line) => line.includes('--kind role-invariant'))).toBe(false);
  });

  it("checks the claim race against the ROLE's own pick, not a coder's", () => {
    // A CHARACTERISATION test, not a change: `ralph.sh` parses the ticket off
    // whichever gate's verdict line it got (`GATE_TICKET`), so this passes on
    // `main` too and no production line in this branch touches it. Pinned
    // because #146 asks for the behaviour by name — a triager's gate probed
    // the triage bucket, so the ticket is a triage unit's, and a triager that
    // lost its unit to another loop must go back to the gate rather than count
    // a disagreement it never had. A future "re-ask the frontier here" would
    // silently re-ask the CODER's bucket, and this is what would fail.
    const run = runSupervisor(withRole('triager'), ['2'], {
      RALPH_LOOP_NAME: 'tria',
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_SIGIL: '<ralph>ALL_BLOCKED</ralph>',
      FAKE_CLAIM_RACE: '0',
      FAKE_GATE_OUTPUT: 'frontier-gate: work available — frontier ticket #146 — Staff the tree',
    });
    expect(run.status).toBe(0);
    expect(run.argv.filter((l) => l.includes('claim-race.ts 146'))).not.toHaveLength(0);
    expect(run.stdout).toContain('back to the gate; not counted as a disagreement.');
    expect(run.stdout).not.toContain('disagree persistently');
  }, 30_000);

  it('halts a role that does not hold at the gate after two disagreements, as before (#771)', () => {
    // A ci-doctor's gate does not hold, so even a holdable verdict is counted
    // from the first refusal and the record is never written.
    const work = withRole('ci-doctor', 'doco');
    const run = runSupervisor(work, ['20'], {
      RALPH_LOOP_NAME: 'doco',
      RALPH_WAIT_FOR_WORK: '1',
      FAKE_SIGIL: '<ralph>ALL_BLOCKED</ralph>',
      FAKE_GATE_OUTPUT: 'ci-doctor-gate: work available — frontier ticket #1',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('disagree persistently');
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(2);
    expect(run.argv.some((l) => l.includes('gate-verdict-store.ts'))).toBe(false);
  }, 30_000);

  it('never holds a role that runs no local gates behind the host lease', () => {
    const triager = runSupervisor(withRole('triager'), ['1'], {
      RALPH_LOOP_NAME: 'tria',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(triager.status).toBe(0);
    expect(triager.argv.some((line) => line.includes('host-lease.ts'))).toBe(false);
    // A coder still takes its turn in the queue on every session.
    const coder = runSupervisor(withRole('triager'), ['1'], {
      RALPH_LOOP_NAME: 'nova',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(coder.argv.some((line) => line.includes('host-lease.ts turn-begin'))).toBe(true);
  });

  /**
   * The fallback is `ralph` — the loop that owns the tracker's original
   * labels — so it is the one default a broken identity must never reach. A
   * rafa worktree whose `.loop-name` turned unreadable would otherwise start
   * claiming `ralph-wip`, which is the single-label collision the file exists
   * to prevent, and it would do it without printing anything.
   */
  it('refuses a name file that exists but says nothing, rather than defaulting', () => {
    const work = scratchWorktree();
    writeFileSync(join(work.root, '.ralph', 'loop-name'), '   \n');

    const run = runSupervisor(work, ['1']);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('is empty');
    expect(loopOf(run)).toEqual([]);
  });

  it('refuses a name file it cannot read, rather than defaulting', () => {
    const work = scratchWorktree();
    // A directory is the readable-but-unreadable case that survives a `-r`
    // test, which is what the guard used to be.
    mkdirSync(join(work.root, '.ralph', 'loop-name'), { recursive: true });

    const run = runSupervisor(work, ['1']);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('could not be read');
    expect(loopOf(run)).toEqual([]);
  });

  it('names its own branch prefix when it refuses a stale worktree', () => {
    // The hint used to say `ralph/<n>` to both loops — the exact
    // mis-attribution the naming work exists to remove.
    const work = scratchWorktree();
    writeFileSync(join(work.root, '.ralph', 'loop-name'), 'rafa\n');

    const run = runSupervisor(work, ['1'], {
      FAKE_HEAD: 'old111',
      FAKE_MAIN: 'new222',
      // The hint only prints where the refusal survives: a fast-forward that
      // did not take.
      FAKE_CHECKOUT_FAILS: '1',
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('rafa/<n>');
    expect(run.stderr).not.toContain('ralph/<n>');
  });

  it('stamps the run id with the loop, so the usage ledger attributes it', () => {
    const work = scratchWorktree();
    writeFileSync(join(work.root, '.ralph', 'loop-name'), 'rafa\n');

    const run = runSupervisor(work, ['1'], { FAKE_SIGIL: '<ralph>DONE</ralph>' });

    expect(
      run.argv.filter((l) => l.startsWith('claude run-id=rafa-run-')),
    ).toHaveLength(1);
  });
});

describe('run identity', () => {
  it('gives two supervisors started in the same second two different run ids', async () => {
    // The old id was a whole-second timestamp, so this is exactly the case a
    // second loop produces, and a shared id makes one usage report out of two.
    const work = scratchWorktree();
    const start = (): Promise<void> =>
      new Promise((resolve) => {
        const child = spawn('bash', [join(work.home, 'ralph.sh'), '1'], {
          cwd: work.root,
          env: supervisorEnvironment(work),
          stdio: 'ignore',
        });
        child.on('close', () => resolve());
      });

    await Promise.all([start(), start()]);

    const ids = work
      .argv()
      .filter((line) => line.startsWith('claude run-id='))
      .map((line) => line.replace('claude run-id=', ''));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);

    // And each keeps its own supervisor log, so the two never interleave.
    const logs = readdirSync(join(work.root, '.ralph', 'logs')).filter((f) =>
      f.startsWith('supervisor-'),
    );
    expect(logs).toHaveLength(2);
  }, 30_000);
});

/**
 * A signal is an ending, not a crash (2026-10-28): a shutdown, a reboot or an
 * operator's `kill <pid>` reaches the supervisor as SIGTERM, and a supervisor
 * that died of it without writing a stop was restarted at boot by the
 * dashboard's reconciler like any oomd victim. Mid-turn is the case that
 * matters, because the turn is where the supervisor spends its life and bash
 * defers a trap until a foreground command returns. That the record keeps the
 * loop stopped is `controls.test.ts` and `end-to-end.test.ts`; here it is the
 * supervisor's half: answered at once, the model told, the stop recorded as
 * the owner, and nothing of the kind on an ordinary exit.
 */
describe('ending on a signal', () => {
  const pgrep = (pattern: string): boolean => spawnSync('pgrep', ['-f', pattern]).status === 0;
  const until = async (predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((settle) => setTimeout(settle, 50));
    }
    return predicate();
  };

  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]] as const) {
    it(`answers ${signal} mid-turn: the model is told, the stop is recorded as interrupted, and it exits`, async () => {
      const work = scratchWorktree();
      // A delay no other process on the host is sleeping, so pgrep finds this turn alone.
      const delay = `29.${String(process.pid).padStart(7, '0')}${code}`;
      const child = spawn('bash', [join(work.home, 'ralph.sh'), '1'], {
        cwd: work.root,
        env: { ...supervisorEnvironment(work), FAKE_TURN_DELAY: delay },
        stdio: 'ignore',
      });
      const closed = new Promise<number | null>((resolve) => child.on('close', (status) => resolve(status)));
      try {
        expect(await until(() => pgrep(`sleep ${delay}`))).toBe(true);
        // The supervisor alone, as `kill <pid>` does; a shutdown or Stop now
        // reaches its children too, which this case would only make easier.
        child.kill(signal);
        const status = await Promise.race([closed, new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 15_000))]);
        expect(status).toBe(code);
        expect(await until(() => !pgrep(`sleep ${delay}`), 5_000)).toBe(true);
        const recorded = work.argv().filter((line) => line.startsWith('ralph/controls.ts interrupted'));
        expect(recorded).toEqual([
          `ralph/controls.ts interrupted --self ${child.pid} --signal ${signal} --key signal-${work.argv().find((l) => l.startsWith('claude run-id='))?.replace('claude run-id=', '')} --why stopped by ${signal} (a shutdown, a reboot or a kill)`,
        ]);
        // The iteration never got to end: the stop is the trap's, not a sigil's.
        expect(work.argv().some((line) => line.includes('--event iteration-end'))).toBe(false);
      } finally {
        child.kill('SIGKILL');
        spawnSync('pkill', ['-f', `sleep ${delay}`]);
      }
    }, 40_000);
  }

  it('records nothing of the kind when the run ends on its own', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], { FAKE_SIGIL: '<ralph>COMPLETE</ralph>' });
    expect(run.status).toBe(0);
    expect(run.argv.some((line) => line.includes('controls.ts interrupted'))).toBe(false);
  });
});

/**
 * The model lineup.
 *
 * Which model runs which stage used to be spread over four files and a
 * paragraph of prose, so switching one meant editing all of them and hoping
 * the flag and the prose still agreed. `ralph/models.json` is now the only
 * place it is written down; what this file pins is the supervisor's half of
 * that — that it asks the resolver, refuses to run without an answer, applies
 * the answer to its own `claude` invocation, and renders the subagent models
 * into the prompt rather than leaving them as prose the iteration may ignore.
 * The resolver's own rules (env wins, a loop block is complete, unpriced is a
 * warning) are `models.test.ts`.
 */
describe('the model lineup', () => {
  const claudeArgv = (run: Run): string =>
    run.argv.find((line) => line.startsWith('claude argv=')) ?? '';

  it("moves the project's auto blocks before it resolves the lineup, and logs each change (#851)", () => {
    const work = scratchWorktree();
    const change = 'model-updates: loggd.nova orchestrator: claude-opus-5 → claude-opus-5-5 (auto)';
    const run = runSupervisor(work, ['1'], { FAKE_MODEL_UPDATES: change, FAKE_SIGIL: '<ralph>DONE</ralph>' });

    expect(run.status).toBe(0);
    const updates = run.argv.findIndex((line) => line.startsWith('ralph/model-updates.ts --apply-auto --project '));
    const lineup = run.argv.findIndex((line) => line.startsWith('ralph/models.ts --export'));
    expect(updates).toBeGreaterThanOrEqual(0);
    expect(updates).toBeLessThan(lineup);
    const log = readFileSync(join(work.root, '.ralph', 'logs', run.supervisorLogs[0]!), 'utf8');
    expect(log).toContain(change);
  });

  it('starts on the lineup as configured when the auto updates fail, and says why', () => {
    const work = scratchWorktree();
    const run = runSupervisor(work, ['1'], { FAKE_MODEL_UPDATES_STATUS: '1', FAKE_SIGIL: '<ralph>DONE</ralph>' });

    expect(run.status).toBe(0);
    expect(claudeArgv(run)).toContain('--model claude-opus-5');
    const log = readFileSync(join(work.root, '.ralph', 'logs', run.supervisorLogs[0]!), 'utf8');
    expect(log).toContain('auto model updates were skipped this start: model-updates: cannot read models.json');
  });

  it('runs the iteration on the orchestrator model and effort it resolved', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], { FAKE_SIGIL: '<ralph>DONE</ralph>' });

    expect(run.status).toBe(0);
    expect(claudeArgv(run)).toContain('--model claude-opus-5');
    expect(claudeArgv(run)).toContain('--effort medium');
    expect(claudeArgv(run)).toContain('--dangerously-skip-permissions');
    expect(claudeArgv(run)).toContain('--output-format stream-json');
    expect(claudeArgv(run)).toContain('--verbose');
    expect(claudeArgv(run)).not.toContain('--include-partial-messages');
    expect(claudeArgv(run)).not.toContain('--permission-mode acceptEdits');
  });

  it('defines the named stage agents on the orchestrator session, and only when there are some', () => {
    // The resolver builds the definitions (models.test.ts); the supervisor's
    // half is to hand them to `claude --agents` and to add no flag without them.
    const agents = '{"ralph-review-spec":{"model":"claude-opus-5-5","effort":"medium"}}';
    const withAgents = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_LINEUP_EXPORTS: [
        "export RALPH_MODEL_ORCHESTRATOR='claude-opus-5'",
        "export RALPH_RUNNER_ORCHESTRATOR='claude'",
        "export RALPH_MODEL_EXECUTOR='opencode-go/kimi-k3'",
        "export RALPH_RUNNER_EXECUTOR='opencode'",
        "export RALPH_MODEL_MAPPER='opencode-go/kimi-k3'",
        "export RALPH_RUNNER_MAPPER='opencode'",
        "export RALPH_MODEL_REVIEW_STANDARDS='opencode-go/kimi-k3'",
        "export RALPH_RUNNER_REVIEW_STANDARDS='opencode'",
        "export RALPH_MODEL_REVIEW_SPEC='claude-opus-5-5'",
        "export RALPH_RUNNER_REVIEW_SPEC='claude'",
        "export RALPH_MODEL_STAGE_VARS='RALPH_MODEL_ORCHESTRATOR RALPH_MODEL_EXECUTOR RALPH_MODEL_MAPPER RALPH_MODEL_REVIEW_STANDARDS RALPH_MODEL_REVIEW_SPEC'",
        "export RALPH_RUNNER_STAGE_VARS='RALPH_RUNNER_ORCHESTRATOR RALPH_RUNNER_EXECUTOR RALPH_RUNNER_MAPPER RALPH_RUNNER_REVIEW_STANDARDS RALPH_RUNNER_REVIEW_SPEC'",
        `RALPH_CLAUDE_AGENTS='${agents}'`,
      ].join('\n'),
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(withAgents.status).toBe(0);
    expect(claudeArgv(withAgents)).toContain(`--agents ${agents}`);

    const without = runSupervisor(scratchWorktree(), ['1'], {
      RALPH_CLAUDE_AGENTS: '',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(claudeArgv(without)).not.toContain('--agents');
  });

  it('hands `claude` the RENDERED prompt, not the file', () => {
    // The substitution itself is the resolver's and is pinned in
    // models.test.ts; what matters here is that the supervisor asks for it and
    // passes on what came back.
    const work = scratchWorktree();
    writeFileSync(join(work.home, 'prompt.md'), 'mapper={{RALPH_MODEL_MAPPER}}\n');

    const run = runSupervisor(work, ['1'], { FAKE_SIGIL: '<ralph>DONE</ralph>' });

    expect(run.status).toBe(0);
    expect(run.argv.some((l) => l.includes('--render-prompt --role coder'))).toBe(true);
    expect(claudeArgv(run)).toContain('rendered:mapper={{RALPH_MODEL_MAPPER}}');
  });

  it("renders the template its ROLE declares, not the coder's", () => {
    // Which file that is belongs to `roles.ts`; the supervisor's half is to
    // pass the role and hand on what came back.
    const mixed = () => {
      const work = scratchWorktree();
      writeFileSync(
        join(work.root, '.ralph', 'config.json'),
        JSON.stringify({ ...FIXTURE_CONFIG, loops: ['nova', { name: 'tria', role: 'triager' }] }),
      );
      return work;
    };

    const triager = runSupervisor(mixed(), ['1'], { RALPH_LOOP_NAME: 'tria', FAKE_SIGIL: '<ralph>DONE</ralph>' });
    expect(triager.status).toBe(0);
    expect(triager.argv.some((l) => l.includes('--render-prompt --role triager'))).toBe(true);
    expect(claudeArgv(triager)).toContain('rendered:a stub triager prompt');

    const coder = runSupervisor(mixed(), ['1'], { RALPH_LOOP_NAME: 'nova', FAKE_SIGIL: '<ralph>DONE</ralph>' });
    expect(coder.argv.some((l) => l.includes('--render-prompt --role coder'))).toBe(true);
    expect(claudeArgv(coder)).toContain('rendered:a stub prompt');
  });

  it("stops rather than render a role whose template the harness does not carry", () => {
    // A harness checkout from before a role landed: preflight names the missing
    // template (`HARNESS_FILES`), and if it is reached anyway the render fails
    // instead of handing `claude` a stub.
    const work = scratchWorktree();
    writeFileSync(
      join(work.root, '.ralph', 'config.json'),
      JSON.stringify({ ...FIXTURE_CONFIG, loops: ['nova', { name: 'tria', role: 'triager' }] }),
    );
    rmSync(join(work.home, 'prompts', 'triager.md'));

    const run = runSupervisor(work, ['1'], { RALPH_LOOP_NAME: 'tria', FAKE_SIGIL: '<ralph>DONE</ralph>' });

    expect(run.status).toBe(1);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(0);
  });

  it('does not spend an iteration when the prompt will not render', () => {
    // The resolver refuses a placeholder nothing fills — shipping literal
    // `{{RALPH_MODEL_JUDGE}}` is how a stage silently loses its configuration.
    // The supervisor's half is to stop rather than spend a fresh-context turn.
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_RENDER_STATUS: '1',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });

    expect(run.status).toBe(1);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(0);
  });

  it('refuses an empty rendered prompt', () => {
    // A renderer that exits 0 with nothing would otherwise buy a whole
    // fresh-context turn on `claude -p ""`.
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_RENDERED_PROMPT: '',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('rendered prompt is empty');
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(0);
  });

  it('refuses to start when the lineup cannot be resolved', () => {
    // A lineup that will not resolve is not a run: starting anyway would spend
    // a fresh-context turn on whatever model the account happens to default to.
    const run = runSupervisor(scratchWorktree(), ['1'], { FAKE_LINEUP_STATUS: '1' });

    expect(run.status).toBe(1);
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(0);
  });

  it('lets the environment override a stage without touching the file', () => {
    // The resolver decides this; what matters here is that the supervisor does
    // not clobber an override on its way past — the one-off switch is the
    // whole point of the environment layer.
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_LINEUP_EXPORTS: [
        "export RALPH_MODEL_ORCHESTRATOR='claude-sonnet-5'",
        "export RALPH_RUNNER_ORCHESTRATOR='claude'",
        "export RALPH_MODEL_EXECUTOR='opencode-go/kimi-k3'",
        "export RALPH_RUNNER_EXECUTOR='opencode'",
        "export RALPH_MODEL_MAPPER='haiku'",
        "export RALPH_RUNNER_MAPPER='claude'",
        "export RALPH_MODEL_REVIEW_STANDARDS='opus'",
        "export RALPH_RUNNER_REVIEW_STANDARDS='codex'",
        "export RALPH_MODEL_REVIEW_SPEC='opus'",
        "export RALPH_RUNNER_REVIEW_SPEC='claude'",
        'unset RALPH_MODEL_ORCHESTRATOR_EFFORT',
        "export RALPH_MODEL_STAGE_VARS='RALPH_MODEL_ORCHESTRATOR RALPH_MODEL_EXECUTOR RALPH_MODEL_MAPPER RALPH_MODEL_REVIEW_STANDARDS RALPH_MODEL_REVIEW_SPEC'",
        "export RALPH_RUNNER_STAGE_VARS='RALPH_RUNNER_ORCHESTRATOR RALPH_RUNNER_EXECUTOR RALPH_RUNNER_MAPPER RALPH_RUNNER_REVIEW_STANDARDS RALPH_RUNNER_REVIEW_SPEC'",
      ].join('\n'),
      // Set in the operator's shell, and NOT part of the resolved lineup: the
      // `unset` line above is what has to clear it. Left standing it would
      // reach `claude --effort` behind the resolver's back.
      RALPH_MODEL_ORCHESTRATOR_EFFORT: 'high',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });

    expect(claudeArgv(run)).toContain('--model claude-sonnet-5');
    // No effort in that lineup, so no flag — an empty `--effort` is not a
    // neutral default, it is an error at the CLI.
    expect(claudeArgv(run)).not.toContain('--effort');
  });

  it('renders the prompt before it evals its own exports', () => {
    // Both passes have to resolve from the same environment. Once the exports
    // are eval'd they ARE the environment, so a render after them would no
    // longer see `RALPH_MODEL_ORCHESTRATOR_EFFORT=` — the operator clearing the
    // effort for a model that takes none — and the prompt would name an effort
    // the CLI was never handed.
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_ECHO_RENDER_ENV: '1',
      RALPH_MODEL_ORCHESTRATOR_EFFORT: '',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });

    expect(claudeArgv(run)).toContain('effort=[]');
  });

  it('records the lineup in the supervisor log while the run is still going', () => {
    const work = scratchWorktree();
    runSupervisor(work, ['1'], { FAKE_SIGIL: '<ralph>DONE</ralph>' });

    const log = readdirSync(join(work.root, '.ralph', 'logs')).find((f) =>
      f.startsWith('supervisor-'),
    )!;
    const text = readFileSync(join(work.root, '.ralph', 'logs', log), 'utf8');
    expect(text).toContain('models — orchestrator claude-opus-5 on claude');
    expect(text).toContain('executor opencode-go/deepseek-v4-flash on opencode');
    // The runner is half the lineup: a run that says only the model does not
    // say what actually ran it.
    expect(text).toContain('review.spec opus on claude');
    expect(text).toContain('(orchestrator effort medium)');
  });
});

describe('a half-resolved lineup', () => {
  it('is refused by name, not as an unbound variable a hundred lines later', () => {
    // `eval` can half-succeed where the resolver cannot half-answer: output
    // truncated, a stage renamed on one side of the seam only. Named here, it
    // is one line to fix; left to `set -u`, it surfaces from inside a sed.
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_LINEUP_EXPORTS: [
        "export RALPH_MODEL_ORCHESTRATOR='claude-opus-5'",
        "export RALPH_MODEL_STAGE_VARS='RALPH_MODEL_ORCHESTRATOR RALPH_MODEL_EXECUTOR'",
        "export RALPH_RUNNER_ORCHESTRATOR='claude'",
        "export RALPH_RUNNER_STAGE_VARS='RALPH_RUNNER_ORCHESTRATOR'",
      ].join('\n'),
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('RALPH_MODEL_EXECUTOR');
    expect(run.stderr).toMatch(/bun \S*models\.ts --list/);
  });

  it('checks the runners too, because half a stage is not a stage', () => {
    // A stage with a model and no runner is as unrunnable as one with neither,
    // and it is the likelier half to lose: the runner roster is the newer of
    // the two seams.
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_LINEUP_EXPORTS: [
        "export RALPH_MODEL_ORCHESTRATOR='claude-opus-5'",
        "export RALPH_MODEL_STAGE_VARS='RALPH_MODEL_ORCHESTRATOR'",
        "export RALPH_RUNNER_STAGE_VARS='RALPH_RUNNER_ORCHESTRATOR'",
      ].join('\n'),
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('RALPH_RUNNER_ORCHESTRATOR');
  });
});

describe('the durable record', () => {
  /** The `record` calls the supervisor made, in order, as whole argv lines. */
  const records = (run: Run): string[] =>
    run.argv.filter((line) => line.includes('loop-state.ts record'));

  it('writes the iteration it is about to spend, and the ending it stops on', () => {
    // The supervisor log already says both in prose. The record says them in a
    // form `status.sh` can classify AFTER the process is gone — which is the
    // only moment anybody needs to be told the difference between a loop that
    // finished and one that died.
    const run = runSupervisor(scratchWorktree(), ['1'], { FAKE_SIGIL: '<ralph>DONE</ralph>' });

    expect(run.status).toBe(0);
    const written = records(run);
    expect(written[0]).toContain('--event supervisor-start --stage starting');
    expect(written.join('\n')).toContain(
      '--event iteration-start --stage iteration --iteration 1 --max 1',
    );
    expect(written[written.length - 1]).toContain('--event cap-reached --stop completed');
  });

  it('writes each iteration into the speed ledger, with its ending and its waits', () => {
    // The claim-to-hand-off clock (#578) needs the iterations between the
    // claim and the hand-off, and what each spent waiting with no model turn.
    const work = scratchWorktree();
    const dir = join(work.root, '..', 'speed-ledger');
    const run = runSupervisor(work, ['1'], {
      FAKE_SIGIL: '<ralph>DONE</ralph>',
      REAL_SPEED: '1',
      RALPH_SPEED_DIR: dir,
    });

    expect(run.status).toBe(0);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const events = readFileSync(join(dir, files[0]!), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event.kind)).toEqual(['iteration-start', 'iteration-end']);
    expect(events[1]).toMatchObject({ outcome: 'DONE', waitedSeconds: 0, iteration: 1 });
    expect(events[0]!.run).toBe(events[1]!.run);
  });

  it('carries on when the speed ledger cannot be written, and says so in the supervisor log', () => {
    // A path under a regular FILE: mkdir fails there even as root.
    const work = scratchWorktree();
    const blocker = join(work.root, '..', 'not-a-dir');
    writeFileSync(blocker, '');
    const run = runSupervisor(work, ['1'], {
      FAKE_SIGIL: '<ralph>DONE</ralph>',
      REAL_SPEED: '1',
      RALPH_SPEED_DIR: join(blocker, 'speed'),
    });

    expect(run.status).toBe(0);
    expect(records(run).join('\n')).toContain('--event cap-reached --stop completed');
    const log = readFileSync(join(work.root, '.ralph', 'logs', run.supervisorLogs[0]!), 'utf8');
    expect(log).toContain('speed: could not record iteration-start');
    expect(log).toContain('speed: could not record iteration-end');
  });

  it('keeps a triager out of the speed ledger', () => {
    // A triager's claim is routing, not a ticket being built.
    const work = scratchWorktree();
    writeFileSync(
      join(work.root, '.ralph', 'config.json'),
      JSON.stringify({ ...FIXTURE_CONFIG, loops: ['nova', { name: 'tria', role: 'triager' }] }),
    );
    const run = runSupervisor(work, ['1'], { RALPH_LOOP_NAME: 'tria', FAKE_SIGIL: '<ralph>DONE</ralph>' });
    expect(run.status).toBe(0);
    expect(run.argv.filter((line) => line.includes('speed.ts record'))).toEqual([]);
  });

  it('separates a loop that broke from one that ran out of work', () => {
    // `failed` and `completed` are the same "supervisor NOT running" to the
    // process table, and they are opposite instructions to an operator: repair
    // this, versus give it more tickets.
    const broken = runSupervisor(scratchWorktree(), ['1'], { FAKE_SIGIL: 'no sigil here' });
    expect(broken.status).toBe(1);
    expect(records(broken).join('\n')).toContain('--event no-sigil --stop failed');
    // With the iteration log as a FIELD, not only inside the `--why` prose.
    // `controls.ts` copies a retry's evidence out of `lastEvent.detail`,
    // so a failure stop that named the log only in a sentence left the link's
    // documented `log` empty — which is exactly the attempt a retry follows.
    expect(records(broken).join('\n')).toMatch(
      /--event no-sigil --stop failed --detail \S*ralph\/logs\/iter-\S+\.log/,
    );

    const drained = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SIGIL: '<ralph>COMPLETE</ralph>',
    });
    expect(drained.status).toBe(0);
    expect(records(drained).join('\n')).toContain('--event stop --stop completed');

    const blocked = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SIGIL: '<ralph>ALL_BLOCKED</ralph>',
    });
    expect(blocked.status).toBe(0);
    expect(records(blocked).join('\n')).toContain('--event stop --stop blocked');
  });

  it('gives one clean sigil-less turn a bounded recovery turn', () => {
    const recovered = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_FIRST_SIGIL: 'Waiting on the executor.',
      FAKE_RECOVERY_SIGIL: '<ralph>DONE</ralph>',
    });

    expect(recovered.status).toBe(0);
    expect(recovered.stdout).toContain('recovering the missing sigil once');
    expect(recovered.argv.filter((line) => line.startsWith('claude run-id='))).toHaveLength(2);
    const boundaries = records(recovered).filter((line) =>
      /--event (iteration-start|sigil-recovery|iteration-end)\b/.test(line),
    );
    expect(boundaries.map((line) => /--event ([^ ]+)/.exec(line)?.[1])).toEqual([
      'iteration-start',
      'sigil-recovery',
      'iteration-end',
    ]);
    expect(recovered.argv.filter((line) => line.startsWith('claude timeline='))).toEqual([
      expect.stringMatching(/\.events\.jsonl$/),
      expect.stringMatching(/\.events\.jsonl$/),
    ]);
    const timelines = recovered.argv
      .filter((line) => line.startsWith('claude timeline='))
      .map((line) => line.slice('claude timeline='.length));
    expect(new Set(timelines).size).toBe(1);
    const turnsAndUsage = recovered.argv.filter(
      (line) => line.startsWith('claude run-id=') || line.startsWith('usage '),
    );
    expect(turnsAndUsage.at(-1)).toBe('usage --step iteration 1 end');
    expect(records(recovered).join('\n')).not.toContain('--event no-sigil --stop failed');
  });

  it('stops when the bounded recovery turn also omits its sigil', () => {
    const failed = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_FIRST_SIGIL: 'Waiting on the executor.',
      FAKE_RECOVERY_SIGIL: 'Still waiting.',
    });

    expect(failed.status).toBe(1);
    expect(failed.argv.filter((line) => line.startsWith('claude run-id='))).toHaveLength(2);
    expect(records(failed).join('\n')).toContain('--event no-sigil --stop failed');
  });

  it('is bookkeeping, so a record that cannot be written never stops the loop', () => {
    // The record exists to explain a loop's ending. A loop that ENDED because
    // its record could not be written would be strictly worse than the missing
    // panel it was meant to prevent.
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SIGIL: '<ralph>DONE</ralph>',
      FAKE_RECORD_STATUS: '3',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('iteration cap (1) reached');
  });
});

/**
 * A turn the account's usage limit rejected ends at once with no sigil. It is
 * not a broken loop: the supervisor waits, with no model, until the reset the
 * events name, keeps the claim, and goes again (#407). The wait does not spend
 * the cap, so `['1']` still runs the resumed iteration.
 */
describe('a turn the usage limit rejected', () => {
  const records = (run: Run): string[] => run.argv.filter((line) => line.includes('loop-state.ts record'));
  const turns = (run: Run): string[] => run.argv.filter((line) => line.startsWith('claude run-id='));
  const events = (run: Run): string[] =>
    records(run).map((line) => /--event ([^ ]+)/.exec(line)?.[1] ?? '');
  // The reader's clock is pinned, so the wait is exactly `resetIn`'s seconds
  // however long the supervisor took to get there: on a loaded host a reset a
  // few real seconds out could pass before the first turn ends, and the wait
  // the test is about would never happen.
  const NOW_MS = Date.now();
  const FAST = {
    RALPH_USAGE_RESET_MARGIN_SECONDS: '0',
    RALPH_USAGE_MIN_WAIT_SECONDS: '1',
    RALPH_USAGE_NOW_MS: String(NOW_MS),
    RALPH_CONTROL_POLL_SECONDS: '1',
  };
  const LIMIT_TEXT = "You've hit your session limit · resets 10:30pm (America/Santiago)";

  /** One stream file in the scratch root, written from JSON lines. */
  const streamFile = (work: ReturnType<typeof scratchWorktree>, name: string, lines: object[]): string => {
    const path = join(work.root, name);
    writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    return path;
  };
  const rateLimit = (info: Record<string, unknown>) => ({ type: 'rate_limit_event', rate_limit_info: info });
  const result = (text: string, isError: boolean) => ({
    type: 'result',
    subtype: 'success',
    is_error: isError,
    result: text,
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  /** The rejected turn's own shape, as `claude -p` printed it on 2026-10-21. */
  const rejected = (work: ReturnType<typeof scratchWorktree>, name: string, info: Record<string, unknown>, text = LIMIT_TEXT) =>
    streamFile(work, name, [
      rateLimit({ status: 'rejected', rateLimitType: 'five_hour', overageStatus: 'rejected', isUsingOverage: false, ...info }),
      { type: 'assistant', message: { content: [{ type: 'text', text }] } },
      result(text, true),
    ]);
  const resetIn = (seconds: number): number => NOW_MS / 1000 + seconds;

  /** Waited, reset and ran again — never stopped as failed. */
  const expectWaitedAndResumed = (run: Run) => {
    const seen = events(run);
    const waitAt = seen.indexOf('usage-wait');
    const resetAt = seen.indexOf('usage-reset');
    const starts = seen.flatMap((event, at) => (event === 'iteration-start' ? [at] : []));
    expect(waitAt).toBeGreaterThan(starts[0]!);
    expect(resetAt).toBeGreaterThan(waitAt);
    expect(starts).toHaveLength(2);
    expect(starts[1]).toBeGreaterThan(resetAt);
    expect(seen).not.toContain('no-sigil');
    expect(records(run).join('\n')).not.toContain('--stop failed');
  };

  for (const status of ['0', '1']) {
    it(`waits out a rejected main turn (exit ${status}) until its reset, then runs the next iteration`, () => {
      const work = scratchWorktree();
      const resetsAt = resetIn(4);
      const stream = rejected(work, 'rejected.jsonl', { resetsAt });
      const started = Date.now();
      const run = runSupervisor(work, ['1'], {
        ...FAST,
        FAKE_STREAM_SEQUENCE: stream,
        FAKE_STREAM_SEQUENCE_STATUS: status,
      });

      expect(run.status).toBe(0);
      expectWaitedAndResumed(run);
      expect(events(run)).not.toContain('sigil-recovery');
      expect(turns(run)).toHaveLength(2);
      // The wait really slept: with the reader's clock pinned, the top of the
      // loop had exactly four seconds left, and slept them.
      expect(run.stdout).toContain('waiting for the usage limit to reset');
      expect(run.stdout).toContain('(4s left)');
      expect(Date.now() - started).toBeGreaterThanOrEqual(4000);
      expect(existsSync(join(work.root, '.ralph/logs/usage-wait.json'))).toBe(false);
    }, 30_000);
  }

  it('drops the rejected turn\'s park hand-off before the turn after the wait (#776)', () => {
    const work = scratchWorktree();
    const run = runSupervisor(work, ['1'], {
      ...FAST,
      FAKE_STREAM_SEQUENCE: rejected(work, 'rejected.jsonl', { resetsAt: resetIn(1) }),
      FAKE_SESSION_BLOCK_PARK: JSON.stringify({ ticket: 7, condition: { kind: 'reference', ref: '#6' }, summary: 'from the rejected turn' }),
    });
    expect(run.status).toBe(0);
    expectWaitedAndResumed(run);
    expect(parkAtStart(run)).toEqual(['absent', 'absent']);
  }, 30_000);

  it('waits when the sigil recovery is the turn the limit rejected', () => {
    const work = scratchWorktree();
    const clean = streamFile(work, 'clean.jsonl', [result('Waiting on the executor.', false)]);
    const stream = rejected(work, 'rejected.jsonl', { resetsAt: resetIn(2) });
    const run = runSupervisor(work, ['1'], { ...FAST, FAKE_STREAM_SEQUENCE: `${clean}|${stream}` });

    expect(run.status).toBe(0);
    expect(events(run).filter((event) => event === 'sigil-recovery')).toHaveLength(1);
    expect(events(run).indexOf('usage-wait')).toBeGreaterThan(events(run).indexOf('sigil-recovery'));
    expectWaitedAndResumed(run);
    expect(turns(run)).toHaveLength(3);
    expect(existsSync(join(work.root, '.ralph/logs/usage-wait.json'))).toBe(false);
  }, 30_000);

  it('waits the default when the rejection names no reset', () => {
    const work = scratchWorktree();
    const stream = rejected(work, 'rejected.jsonl', {}, "You've hit your session limit");
    const run = runSupervisor(work, ['1'], {
      ...FAST,
      RALPH_USAGE_WAIT_DEFAULT_SECONDS: '1',
      FAKE_STREAM_SEQUENCE: stream,
    });

    expect(run.status).toBe(0);
    expect(records(run).join('\n')).toContain('(five_hour, default)');
    expectWaitedAndResumed(run);
    expect(turns(run)).toHaveLength(2);
    expect(existsSync(join(work.root, '.ralph/logs/usage-wait.json'))).toBe(false);
  }, 30_000);

  it('stops at once for an operator stop sent during the wait', () => {
    const work = scratchWorktree();
    const stream = rejected(work, 'rejected.jsonl', { resetsAt: resetIn(3600) });
    const started = Date.now();
    const run = runSupervisor(work, ['1'], {
      ...FAST,
      REAL_CONTROLS: '1',
      FAKE_USAGE_WAIT_COMMAND: 'stop',
      FAKE_STREAM_SEQUENCE: stream,
    });

    expect(run.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(records(run).join('\n')).toContain('--event control-stop --stop completed');
    expect(records(run).join('\n')).not.toContain('--stop failed');
    expect(events(run)).not.toContain('usage-reset');
    expect(turns(run)).toHaveLength(1);
  }, 30_000);

  it('holds for a pause sent during the wait, and goes back to the wait on resume', () => {
    // FAKE_GATE_ANSWER answers the first hold with a resume, as an operator on
    // the dashboard would; the wait then resumes from the state it kept.
    const work = scratchWorktree();
    const stream = rejected(work, 'rejected.jsonl', { resetsAt: resetIn(4) });
    const run = runSupervisor(work, ['1'], {
      ...FAST,
      REAL_CONTROLS: '1',
      FAKE_USAGE_WAIT_COMMAND: 'pause',
      FAKE_GATE_ANSWER: 'resume',
      FAKE_STREAM_SEQUENCE: stream,
    });

    expect(run.status).toBe(0);
    const seen = events(run);
    const holdAt = seen.indexOf('control-hold');
    expect(holdAt).toBeGreaterThan(seen.indexOf('usage-wait'));
    expect(seen.indexOf('usage-reset')).toBeGreaterThan(holdAt);
    expectWaitedAndResumed(run);
    expect(turns(run)).toHaveLength(2);
    expect(existsSync(join(work.root, '.ralph/logs/usage-wait.json'))).toBe(false);
  }, 30_000);

  it('holds when the project falls asleep during the wait, and goes back to the wait once woken', () => {
    const work = scratchWorktree();
    const stream = rejected(work, 'rejected.jsonl', { resetsAt: resetIn(4) });
    const run = runSupervisor(work, ['1'], {
      ...FAST,
      REAL_CONTROLS: '1',
      FAKE_USAGE_WAIT_SLEEP: '1',
      FAKE_WAKE_ON_HOLD: '1',
      FAKE_STREAM_SEQUENCE: stream,
    });

    expect(run.status, run.stdout).toBe(0);
    const seen = events(run);
    const holdAt = seen.indexOf('control-hold');
    expect(holdAt).toBeGreaterThan(seen.indexOf('usage-wait'));
    expect(seen.indexOf('usage-reset')).toBeGreaterThan(holdAt);
    expect(run.stdout).toContain('asleep with its project');
    expect(turns(run)).toHaveLength(2);
  }, 30_000);

  it('still stops as failed on an API error that no usage limit explains', () => {
    // A provider 500 with no rate_limit_event is the death the stop exists
    // for: nothing names a reset, so there is nothing to wait for.
    const work = scratchWorktree();
    const stream = streamFile(work, 'api-error.jsonl', [result('API Error: 500 {"type":"error"}', true)]);
    const run = runSupervisor(work, ['1'], { ...FAST, FAKE_STREAM_FILE: stream, FAKE_CLAUDE_STATUS: '1' });

    expect(run.status).toBe(1);
    expect(records(run).join('\n')).toContain('--event no-sigil --stop failed');
    expect(events(run)).not.toContain('usage-wait');
    expect(existsSync(join(work.root, '.ralph/logs/usage-wait.json'))).toBe(false);
  }, 30_000);

  it('still stops as failed on an allowed turn whose overageStatus reads rejected', () => {
    // `overageStatus` is "rejected" on ordinary allowed events: it is a trap,
    // not the limit.
    const work = scratchWorktree();
    const stream = streamFile(work, 'allowed.jsonl', [
      rateLimit({ status: 'allowed_warning', resetsAt: resetIn(60), rateLimitType: 'five_hour', overageStatus: 'rejected', isUsingOverage: false }),
      result('no sigil here', false),
    ]);
    const run = runSupervisor(work, ['1'], { ...FAST, FAKE_STREAM_FILE: stream });

    expect(run.status).toBe(1);
    expect(records(run).join('\n')).toContain('--event no-sigil --stop failed');
    expect(events(run)).not.toContain('usage-wait');
    expect(existsSync(join(work.root, '.ralph/logs/usage-wait.json'))).toBe(false);
  }, 30_000);
});

/**
 * A session that has pushed hands the wait to the supervisor and ends; the
 * supervisor waits with no model involved and starts a FRESH session on the
 * outcome. The cap stops an iteration from outside, and a short session with a
 * cap of its own hands the ticket off.
 */
describe('waiting on a PR without a model', () => {
  const records = (run: Run): string[] => run.argv.filter((line) => line.includes('loop-state.ts record'));
  const turns = (run: Run): string[] => run.argv.filter((line) => line.startsWith('claude argv='));
  const waits = (run: Run): string[] => run.argv.filter((line) => line.includes('ralph/pr-wait.ts'));

  it('waits on CI for the pushed head, then resumes in a fresh session with the outcome', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_FIRST_SIGIL: '<ralph>AWAIT_PR 7 ci</ralph>',
      FAKE_RECOVERY_SIGIL: '<ralph>DONE</ralph>',
      FAKE_PR_WAIT_RESULT: '{"outcome":"green","mode":"ci","pr":"7","head":"aaaa111","checks":[{"name":"buildkite/loggd","state":"pass","url":null}]}',
    });

    expect(run.status).toBe(0);
    expect(waits(run)).toEqual([expect.stringMatching(/^ralph\/pr-wait\.ts 7 --mode ci --head aaaa111$/)]);
    expect(turns(run)).toHaveLength(2);
    const resumed = turns(run)[1]!;
    expect(resumed).toContain('Resuming iteration 1');
    expect(resumed).toContain('Outcome: **green**');
    expect(resumed).toContain('AWAIT_PR 7 merge');
    expect(resumed).toContain('.ralph/logs/handoff-pr-7.md');
    // A new session, not a resumed one: the point is the empty context.
    expect(resumed).toContain('--session-id');
    expect(resumed).not.toContain('--resume');
    const events = records(run).map((line) => /--event ([^ ]+)/.exec(line)?.[1]);
    expect(events).toEqual(expect.arrayContaining(['pr-wait', 'pr-session', 'iteration-end']));
    expect(events).not.toContain('no-sigil');
    expect(events).not.toContain('sigil-recovery');
    // The waiting session's usage is closed before the next one starts.
    expect(run.argv).toContain('usage --step iteration 1 awaiting PR #7');
  });

  // #807: testo ended with AWAIT_PR 2694 (its issue, off branch testo/2694-...)
  // while its PR was 2768, and the supervisor waited on the issue.
  describe('a sigil that names a number the branch has no PR for', () => {
    const REFUSAL = 'The supervisor refused your AWAIT_PR sigil and started no wait. End again with <ralph>AWAIT_PR 2768 ci</ralph>.';

    it('starts no wait and resumes the SAME session with the real number', () => {
      const run = runSupervisor(scratchWorktree(), ['1'], {
        FAKE_FIRST_SIGIL: '<ralph>AWAIT_PR 2694 ci</ralph>',
        FAKE_RECOVERY_SIGIL: '<ralph>DONE</ralph>',
        FAKE_AWAIT_PR_CHECK: REFUSAL,
      });

      expect(run.status, run.stdout).toBe(0);
      expect(run.argv).toEqual(expect.arrayContaining([expect.stringMatching(/ralph\/await-pr-check\.ts 2694 --mode ci$/)]));
      expect(waits(run)).toEqual([]);
      expect(turns(run)).toHaveLength(2);
      const resumed = turns(run)[1]!;
      expect(resumed).toContain('--resume');
      expect(resumed).not.toContain('--session-id');
      expect(resumed).toContain('AWAIT_PR 2768 ci');
      const events = records(run).map((line) => /--event ([^ ]+)/.exec(line)?.[1]);
      expect(events).toContain('pr-sigil-refused');
      expect(events).not.toContain('pr-wait');
    });

    it('waits as before when the check cannot judge', () => {
      const run = runSupervisor(scratchWorktree(), ['1'], {
        FAKE_FIRST_SIGIL: '<ralph>AWAIT_PR 7 ci</ralph>',
        FAKE_RECOVERY_SIGIL: '<ralph>DONE</ralph>',
        FAKE_AWAIT_PR_CHECK_STATUS: '1',
        FAKE_PR_WAIT_RESULT: '{"outcome":"green","mode":"ci","pr":"7","head":"aaaa111"}',
      });

      expect(run.status, run.stdout).toBe(0);
      expect(waits(run)).toHaveLength(1);
      expect(turns(run)[1]).toContain('--session-id');
    });

    it('refuses a repeat until the cap, then waits on it as asked', () => {
      const run = runSupervisor(scratchWorktree(), ['1'], {
        FAKE_FIRST_SIGIL: '<ralph>AWAIT_PR 2694 ci</ralph>',
        FAKE_RECOVERY_SIGIL: '<ralph>AWAIT_PR 2694 ci</ralph>',
        FAKE_AWAIT_PR_CHECK: REFUSAL,
        RALPH_AWAIT_PR_REFUSALS: '1',
        RALPH_PR_WAIT_ROUNDS: '1',
        FAKE_PR_WAIT_RESULT: '{"outcome":"green","mode":"ci","pr":"2694","head":"aaaa111"}',
      });

      expect(records(run).filter((line) => line.includes('pr-sigil-refused'))).toHaveLength(1);
      expect(turns(run)[1]).toContain('--resume');
      expect(waits(run)).toHaveLength(1);
    });

    it('waits as asked once its refusals are spent', () => {
      const run = runSupervisor(scratchWorktree(), ['1'], {
        FAKE_FIRST_SIGIL: '<ralph>AWAIT_PR 2694 ci</ralph>',
        FAKE_RECOVERY_SIGIL: '<ralph>DONE</ralph>',
        FAKE_AWAIT_PR_CHECK: REFUSAL,
        RALPH_AWAIT_PR_REFUSALS: '0',
        FAKE_PR_WAIT_RESULT: '{"outcome":"green","mode":"ci","pr":"2694","head":"aaaa111"}',
      });

      expect(run.status, run.stdout).toBe(0);
      expect(waits(run)).toHaveLength(1);
      expect(records(run).some((line) => line.includes('pr-sigil-refused'))).toBe(false);
      // Spent refusals are not asked for at all.
      expect(run.argv.some((line) => line.includes('await-pr-check.ts'))).toBe(false);
    });
  });

  // 356 of 553 PR sessions in Oct 2026 only asked to wait again after a timeout.
  describe('a wait that times out with nothing failed', () => {
    const TIMEOUT = '{"outcome":"timeout","mode":"ci","pr":"7","detail":"running, no failed jobs"}';
    const GREEN = '{"outcome":"green","mode":"ci","pr":"7","head":"aaaa111"}';
    const sequence = (work: ReturnType<typeof scratchWorktree>, lines: string[]): string => {
      const file = join(work.root, '.ralph/logs/fake-pr-wait-sequence');
      writeFileSync(file, `${lines.join('\n')}\n`);
      return file;
    };

    it('is waited out again by the supervisor, and only the settled outcome starts a session', () => {
      const work = scratchWorktree();
      const run = runSupervisor(work, ['1'], {
        FAKE_FIRST_SIGIL: '<ralph>AWAIT_PR 7 ci</ralph>',
        FAKE_RECOVERY_SIGIL: '<ralph>DONE</ralph>',
        FAKE_PR_WAIT_SEQUENCE: sequence(work, [TIMEOUT, TIMEOUT, GREEN]),
      });

      expect(run.status, run.stdout).toBe(0);
      expect(waits(run)).toHaveLength(3);
      expect(turns(run)).toHaveLength(2);
      expect(turns(run)[1]).toContain('Outcome: **green**');
      expect(run.stdout).toContain('waiting again (2/2) — no session for that');
      expect(records(run).filter((line) => line.includes('extension'))).toHaveLength(2);
      // One result file per wait, all one iteration to the dashboard's CI-wait medians.
      const files = readdirSync(join(work.root, '.ralph/logs')).filter((name) => WAIT_RESULT.test(name));
      expect(files).toHaveLength(3);
      expect(new Set(files.map((name) => WAIT_RESULT.exec(name)![1]))).toHaveProperty('size', 1);
    });

    it('does not extend a merge-queue timeout', () => {
      const work = scratchWorktree();
      const run = runSupervisor(work, ['1'], {
        FAKE_FIRST_SIGIL: '<ralph>AWAIT_PR 7 merge</ralph>',
        FAKE_RECOVERY_SIGIL: '<ralph>DONE</ralph>',
        FAKE_PR_WAIT_SEQUENCE: sequence(work, ['{"outcome":"timeout","mode":"merge","pr":"7"}', GREEN]),
      });

      expect(run.status, run.stdout).toBe(0);
      expect(waits(run)).toHaveLength(1);
      expect(turns(run)[1]).toContain('Outcome: **timeout**');
    });

    it('starts the session after the last extension still times out', () => {
      const work = scratchWorktree();
      const run = runSupervisor(work, ['1'], {
        FAKE_FIRST_SIGIL: '<ralph>AWAIT_PR 7 ci</ralph>',
        FAKE_RECOVERY_SIGIL: '<ralph>DONE</ralph>',
        FAKE_PR_WAIT_SEQUENCE: sequence(work, [TIMEOUT, TIMEOUT, TIMEOUT, GREEN]),
      });

      expect(run.status, run.stdout).toBe(0);
      expect(waits(run)).toHaveLength(3);
      expect(turns(run)).toHaveLength(2);
      expect(turns(run)[1]).toContain('Outcome: **timeout**');
    });

    it('keeps the old one-wait behaviour at RALPH_PR_WAIT_EXTENSIONS=0', () => {
      const work = scratchWorktree();
      const run = runSupervisor(work, ['1'], {
        FAKE_FIRST_SIGIL: '<ralph>AWAIT_PR 7 ci</ralph>',
        FAKE_RECOVERY_SIGIL: '<ralph>DONE</ralph>',
        RALPH_PR_WAIT_EXTENSIONS: '0',
        FAKE_PR_WAIT_SEQUENCE: sequence(work, [TIMEOUT, GREEN]),
      });

      expect(run.status, run.stdout).toBe(0);
      expect(waits(run)).toHaveLength(1);
      expect(turns(run)[1]).toContain('Outcome: **timeout**');
    });
  });

  it('waits for a quiet host, resumes the SAME session with the answer, and releases after it', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_FIRST_SIGIL: '<ralph>AWAIT_HOST 1604</ralph>',
      FAKE_RECOVERY_SIGIL: '<ralph>DONE</ralph>',
      FAKE_HOST_LEASE_RESULT: '{"outcome":"granted","ticket":1604,"command":"bun run build twice","expiresAt":"2026-09-29T12:00:00Z","detail":"idle"}',
    });

    expect(run.status).toBe(0);
    const lease = run.argv.filter((line) => line.includes('ralph/host-lease.ts'));
    const acquireAt = lease.findIndex((line) => / acquire --ticket 1604 /.test(line));
    const releaseAt = lease.findIndex((line) => line.endsWith('host-lease.ts release'));
    expect(acquireAt).toBeGreaterThanOrEqual(0);
    expect(releaseAt).toBeGreaterThan(acquireAt);
    // Every turn is bracketed, so a draining holder can see it.
    expect(lease.filter((line) => line.endsWith('turn-begin'))).toHaveLength(2);
    expect(lease.filter((line) => line.endsWith('turn-end'))).toHaveLength(2);
    expect(turns(run)).toHaveLength(2);
    expect(turns(run)[1]).toContain('Host lease GRANTED for #1604');
    expect(turns(run)[1]).toContain('--resume');
    const events = records(run).map((line) => /--event ([^ ]+)/.exec(line)?.[1]);
    expect(events).toEqual(expect.arrayContaining(['host-lease-wait', 'host-lease']));
    expect(events).not.toContain('no-sigil');
  });

  it('applies a stop sent while it is held for the host, before any model turn', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      REAL_CONTROLS: '1',
      FAKE_TURN_BEGIN_HOLD: 'stop',
      RALPH_CONTROL_POLL_SECONDS: '1',
    });

    expect(run.status, run.stdout).toBe(0);
    // The hold handed back once, the checkpoint read the stop, and no session
    // ever started: the stop is applied BEFORE the model, not after it.
    expect(run.argv.filter((line) => line.endsWith('host-lease.ts turn-begin'))).toHaveLength(1);
    expect(turns(run)).toHaveLength(0);
    const events = records(run).map((line) => /--event ([^ ]+)/.exec(line)?.[1]);
    expect(events).toContain('control-stop');
    expect(run.stdout).toContain('stopped by an operator while held for the host');
  }, 30_000);

  it('asks again after a handed-back command the checkpoint lets through', () => {
    // A `resume` is the other half of the loop: the checkpoint answers it,
    // nothing stops, and the turn it was holding has to actually happen — the
    // reason the one-line call became a loop.
    const run = runSupervisor(scratchWorktree(), ['1'], {
      REAL_CONTROLS: '1',
      FAKE_TURN_BEGIN_HOLD: 'resume',
      RALPH_CONTROL_POLL_SECONDS: '1',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });

    expect(run.status, run.stdout).toBe(0);
    // Asked twice: handed back once, then again once the command was applied.
    expect(run.argv.filter((line) => line.endsWith('host-lease.ts turn-begin'))).toHaveLength(2);
    expect(turns(run)).toHaveLength(1);
    const events = records(run).map((line) => /--event ([^ ]+)/.exec(line)?.[1]);
    expect(events).not.toContain('control-stop');
  }, 30_000);

  it('lets a turn held for the host go on when the project falls asleep meanwhile', () => {
    // Soft: the iteration has started, so the sleep holds it at the next one
    // rather than parking it here, between two turns, with its ticket claimed.
    const run = runSupervisor(scratchWorktree(), ['1'], {
      REAL_CONTROLS: '1',
      FAKE_TURN_BEGIN_HOLD: 'resume',
      FAKE_TURN_BEGIN_SLEEP: '1',
      RALPH_CONTROL_POLL_SECONDS: '1',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });

    expect(run.status, run.stdout).toBe(0);
    expect(turns(run)).toHaveLength(1);
    expect(run.argv.some((line) => line.includes('controls.ts poll') && line.includes('--in-iteration'))).toBe(true);
    expect(run.stdout).not.toContain('asleep with its project');
  }, 30_000);

  it('lets the turn through on any other status from turn-begin', () => {
    // Never fatal: a lease store it cannot read must not cost a turn.
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_TURN_BEGIN_STATUS: '1',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });

    expect(run.status, run.stdout).toBe(0);
    expect(turns(run)).toHaveLength(1);
  }, 30_000);

  it('asks the store once per iteration, and stops resuming a session that keeps asking', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SIGIL: '<ralph>AWAIT_HOST 1604</ralph>',
    });

    expect(run.status).toBe(0);
    expect(run.argv.filter((line) => / acquire --ticket/.test(line))).toHaveLength(1);
    // main, the refusal, the in-iteration refusal — and no fourth.
    expect(turns(run)).toHaveLength(3);
    expect(turns(run)[2]).toContain('this iteration already asked for the host once');
    expect(run.stdout).toContain('ended still asking for the host');
    expect(records(run).join('\n')).not.toContain('--event no-sigil');
  });

  it('waits on the queue without pinning a head', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_FIRST_SIGIL: '<ralph>AWAIT_PR 7 merge</ralph>',
      FAKE_RECOVERY_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(run.status).toBe(0);
    expect(waits(run)).toEqual([expect.stringMatching(/pr-wait\.ts 7 --mode merge$/)]);
    expect(turns(run)[1]).toContain('Outcome: **merged**');
  });

  it('bounds the waits, tells the last session to hand off, and settles as a handoff', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SIGIL: '<ralph>AWAIT_PR 7 ci</ralph>',
      FAKE_PR_WAIT_RESULT: '{"outcome":"red","mode":"ci","pr":"7"}',
      RALPH_PR_WAIT_ROUNDS: '1',
    });

    expect(run.status).toBe(0);
    expect(waits(run)).toHaveLength(1);
    // main, the round-1 session, and the one told its waits are used up.
    expect(turns(run)).toHaveLength(3);
    expect(turns(run)[2]).toContain('Outcome: **rounds-exhausted**');
    expect(turns(run)[2]).toContain('1. ci → red');
    expect(run.stdout).toContain('ended still waiting on a PR');
    expect(records(run).join('\n')).not.toContain('--event no-sigil');
  });

  it('caps every session by default and can be switched off', () => {
    const capped = runSupervisor(scratchWorktree(), ['1']);
    expect(capped.argv.some((line) => /iteration-budget\.ts watch .*--limit 120000000/.test(line))).toBe(true);

    const uncapped = runSupervisor(scratchWorktree(), ['1'], { RALPH_ITERATION_TOKEN_CAP: '0' });
    expect(uncapped.argv.some((line) => line.includes('iteration-budget.ts'))).toBe(false);
  });

  it('refuses a cap that is not a number', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], { RALPH_ITERATION_TOKEN_CAP: 'lots' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('RALPH_ITERATION_TOKEN_CAP must be a non-negative whole number');
  });

  it('hands off in a small, separately capped session when the cap stops an iteration', () => {
    const work = scratchWorktree();
    const run = runSupervisor(work, ['1'], {
      FAKE_BUDGET_TRIP: '130000000',
      FAKE_TURN_DELAY: '1',
      FAKE_OWN_CLAIM: '1',
    });

    expect(run.status).toBe(0);
    expect(turns(run)).toHaveLength(2);
    const handoff = turns(run)[1]!;
    expect(handoff).toContain('stopped at its token cap');
    expect(handoff).toContain('130M tokens against a cap of 120M');
    expect(handoff).toContain('strike 1 of 2');
    expect(run.argv.some((line) => /iteration-budget\.ts watch .*--limit 8000000 .*--only-session/.test(line))).toBe(true);
    expect(records(run).join('\n')).toContain('--event budget-stop');
    expect(readFileSync(join(work.root, '.ralph', 'logs', 'budget-strikes.tsv'), 'utf8')).toMatch(/^1\t/);
  });

  it('makes the second stop on the same ticket the blocked exit', () => {
    const work = scratchWorktree();
    writeFileSync(join(work.root, '.ralph', 'logs', 'budget-strikes.tsv'), '1\tearlier-run\t2026-09-19T13:00:00Z\n');
    const run = runSupervisor(work, ['1'], {
      FAKE_BUDGET_TRIP: '130000000',
      FAKE_TURN_DELAY: '1',
      FAKE_OWN_CLAIM: '1',
    });

    expect(run.status).toBe(0);
    expect(turns(run)[1]).toContain('strike 2 of 2');
    expect(turns(run)[1]).toContain('stuck path');
  });
});

/**
 * An iteration yields at each phase boundary and the supervisor resumes the
 * SAME session, so the context carries over. Nothing acts on a boundary yet:
 * apart from the extra turns, an iteration runs exactly as before, and a
 * malformed or runaway phase sigil falls back to what the loop already does.
 */
describe('phase boundaries', () => {
  const records = (run: Run): string[] => run.argv.filter((line) => line.includes('loop-state.ts record'));
  const events = (run: Run): Array<string | undefined> => records(run).map((line) => /--event ([^ ]+)/.exec(line)?.[1]);
  const turns = (run: Run): string[] => run.argv.filter((line) => line.startsWith('claude argv='));
  const SESSION = '00000000-0000-4000-8000-000000000000';

  it('records each boundary, appends it to the ticket ledger, and resumes the same session', () => {
    const work = scratchWorktree();
    writeFileSync(join(work.root, '.ralph', 'logs', 'phase-612-select.md'), 'mapped it\n');
    // COMPLETE rather than DONE: DONE finishes the ticket and clears the
    // ledger this reads back (pinned in 'resuming an interrupted ticket').
    const run = runSupervisor(work, ['1'], {
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE implement 612</ralph>|<ralph>PHASE verify 612</ralph>|<ralph>COMPLETE</ralph>',
    });

    expect(run.status, run.stdout).toBe(0);
    expect(turns(run)).toHaveLength(3);
    expect(turns(run)[0]).toContain(`--session-id ${SESSION}`);
    for (const resumed of turns(run).slice(1)) {
      expect(resumed).toContain(`--resume ${SESSION}`);
      expect(resumed).not.toContain('--session-id');
    }
    expect(turns(run)[1]).toContain('`select` → `implement`');
    expect(turns(run)[1]).toContain('`.ralph/logs/phase-612-select.md`');
    expect(turns(run)[2]).toContain('`implement` → `verify`');

    // The loop state carries the phase from the iteration's start onward.
    const phased = records(run).filter((line) => line.includes('--phase'));
    expect(phased.map((line) => /--event ([^ ]+).*--phase ([a-z]+)/.exec(line)?.slice(1).join(' '))).toEqual([
      'iteration-start select',
      'phase implement',
      'phase verify',
    ]);
    expect(events(run)).not.toContain('sigil-recovery');
    expect(events(run)).not.toContain('no-sigil');
    // A boundary is not a new session: no usage step is closed for it.
    expect(run.argv.some((line) => line.includes('awaiting'))).toBe(false);

    const ledger = readFileSync(join(work.root, '.ralph', 'logs', 'phases', '612.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(ledger).toEqual([
      expect.objectContaining({ ticket: 612, phase: 'select', next: 'implement', note: '.ralph/logs/phase-612-select.md', iteration: 1, session: SESSION }),
      expect.objectContaining({ ticket: 612, phase: 'implement', next: 'verify', note: null }),
    ]);
  });

  it('lets a terminal sigil in the same message win over the boundary', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SIGIL: '<ralph>PHASE review 612</ralph> <ralph>DONE</ralph>',
    });
    expect(run.status).toBe(0);
    expect(turns(run)).toHaveLength(1);
    expect(events(run)).not.toContain('phase');
  });

  it('lets AWAIT_PR win over the boundary, and resumes a phase in the fresh session it starts', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SIGIL_SEQUENCE: [
        '<ralph>PHASE finish 612</ralph>',
        '<ralph>PHASE finish 612</ralph> <ralph>AWAIT_PR 7 ci</ralph>',
        '<ralph>DONE</ralph>',
      ].join('|'),
      FAKE_PR_WAIT_RESULT: '{"outcome":"green","mode":"ci","pr":"7","head":"aaaa111"}',
    });
    expect(run.status, run.stdout).toBe(0);
    expect(turns(run)).toHaveLength(3);
    expect(turns(run)[1]).toContain('--resume');
    // The wait's session is fresh, told it is past every boundary.
    expect(turns(run)[2]).toContain('Resuming iteration 1');
    expect(turns(run)[2]).toContain('This session is the `finish` phase');
    expect(turns(run)[2]).not.toContain('--resume');
    expect(events(run).filter((name) => name === 'phase')).toHaveLength(1);
    expect(records(run).find((line) => line.includes('--event pr-wait'))).toContain('--phase finish');
  });

  it('sends a malformed phase sigil to the missing-sigil recovery, never a hang', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_FIRST_SIGIL: '<ralph>PHASE daydream 612</ralph>',
      FAKE_RECOVERY_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(run.status).toBe(0);
    expect(turns(run)).toHaveLength(2);
    expect(turns(run)[1]).toContain('This is the only recovery turn');
    expect(events(run)).toContain('sigil-recovery');
    expect(events(run)).not.toContain('phase');
  });

  it('stops for safety, as before, when the recovery also yields no valid sigil', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_FIRST_SIGIL: '<ralph>PHASE</ralph>',
      FAKE_RECOVERY_SIGIL: '<ralph>PHASE implement three</ralph>',
    });
    expect(run.status).toBe(1);
    expect(events(run)).toContain('no-sigil');
  });

  it('bounds the boundaries one iteration may take, and hands off rather than halting', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SIGIL: '<ralph>PHASE implement 612</ralph>',
      RALPH_PHASE_YIELDS: '2',
    });
    expect(run.status).toBe(0);
    // The first turn and the two resumes the bound allows.
    expect(turns(run)).toHaveLength(3);
    expect(run.stdout).toContain('ended at a phase boundary');
    expect(events(run)).not.toContain('no-sigil');
  });

  it('refuses a yield bound that is not a number', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], { RALPH_PHASE_YIELDS: 'many' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('RALPH_PHASE_YIELDS must be a non-negative whole number');
  });

  it('hands off at the token cap when it stops a resumed phase', () => {
    const work = scratchWorktree();
    const run = runSupervisor(work, ['1'], {
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE implement 612</ralph>|<ralph>PHASE verify 612</ralph>|<ralph>DONE</ralph>',
      FAKE_BUDGET_TRIP: '130000000',
      FAKE_BUDGET_TRIP_ON: '2',
      FAKE_TURN_DELAY: '1',
      FAKE_OWN_CLAIM: '1',
    });
    expect(run.status, run.stdout).toBe(0);
    expect(turns(run)).toHaveLength(3);
    expect(turns(run)[1]).toContain('--resume');
    // The cap outranks the stopped session's own boundary sigil.
    expect(turns(run)[2]).toContain('stopped at its token cap');
    expect(turns(run)[2]).toContain('.ralph/logs/phase-*.md');
    // Same iteration budget across the resumed session: not the handoff's own cap.
    expect(run.argv.filter((line) => /iteration-budget\.ts watch .*--limit 120000000/.test(line))).toHaveLength(2);
    expect(events(run)).toEqual(expect.arrayContaining(['phase', 'budget-stop']));
    expect(events(run).filter((name) => name === 'phase')).toHaveLength(1);
  });

  // A ticket closed from outside the loops mid-iteration (#809): the boundary
  // probes its state and, on `closed`, resumes once with a wrap-up.
  const views = (run: Run): string[] => run.argv.filter((line) => line.includes('tracker.ts view'));
  const wrapsUp = (turn: string | undefined, ticket: string): void => {
    expect(turn).toContain(`--resume ${SESSION}`);
    expect(turn).toContain(`#${ticket} was closed outside this loop`);
    expect(turn).toContain(`tracker.ts" comment ${ticket} --body-file`);
    expect(turn).toContain(`label remove ${ticket} $RALPH_LOOP_NAME-wip`);
    expect(turn).toContain('<ralph>DONE</ralph>');
  };

  it('wraps up once, without the next phase, when the ticket is closed at implement → verify', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE implement 612</ralph>|<ralph>PHASE verify 612</ralph>|<ralph>DONE</ralph>',
      // Open at select → implement, closed from the second read on.
      FAKE_VIEW_STATE_SEQUENCE: 'open',
      FAKE_VIEW_STATE: 'closed',
    });
    expect(run.status, run.stdout).toBe(0);
    expect(views(run)).toHaveLength(2);
    expect(turns(run)).toHaveLength(3);
    expect(turns(run)[1]).toContain('`select` → `implement`');
    wrapsUp(turns(run)[2], '612');
    expect(turns(run)[2]).not.toContain('`implement` → `verify`');
    expect(run.argv.some((line) => line.includes('phase.ts boundary --from select'))).toBe(true);
    expect(run.argv.some((line) => line.includes('phase.ts boundary --from implement'))).toBe(false);
    expect(run.argv.some((line) => line.includes('phase.ts clear --ticket 612'))).toBe(true);
    expect(run.argv.some((line) => line.includes('claim-lease.ts release 612'))).toBe(true);
    expect(run.stdout).toContain('#612 was closed outside the loop');
    expect(records(run).find((line) => line.includes('--event ticket-closed'))).toContain('--phase implement');
    expect(events(run).filter((name) => name === 'phase')).toHaveLength(1);
  });

  it('wraps up the same way when the ticket is closed at select → implement', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE implement 612</ralph>|<ralph>DONE</ralph>',
      FAKE_VIEW_STATE: 'closed',
    });
    expect(run.status, run.stdout).toBe(0);
    expect(turns(run)).toHaveLength(2);
    wrapsUp(turns(run)[1], '612');
    expect(run.argv.some((line) => line.includes('phase.ts boundary'))).toBe(false);
    expect(run.argv.some((line) => line.includes('phase.ts clear --ticket 612'))).toBe(true);
    expect(run.argv.some((line) => line.includes('claim-lease.ts release 612'))).toBe(true);
    expect(run.stdout).toContain('#612 was closed outside the loop');
    expect(events(run)).toContain('ticket-closed');
    expect(events(run)).not.toContain('phase');
  });

  it('ends the iteration when the wrap-up answers with another boundary, and resets for the next one', () => {
    const run = runSupervisor(scratchWorktree(), ['2'], {
      FAKE_SIGIL_SEQUENCE: [
        '<ralph>PHASE implement 612</ralph>',
        '<ralph>PHASE verify 612</ralph>',
        '<ralph>PHASE implement 613</ralph>',
        '<ralph>DONE</ralph>',
      ].join('|'),
      // #612 reads closed; #613, in the second iteration, reads open.
      FAKE_VIEW_STATE_SEQUENCE: 'closed',
      FAKE_VIEW_STATE: 'open',
    });
    expect(run.status, run.stdout).toBe(0);
    expect(turns(run)).toHaveLength(4);
    wrapsUp(turns(run)[1], '612');
    // The wrap-up's boundary got no further turn: the next is a fresh session.
    expect(turns(run)[2]).not.toContain('--resume');
    expect(run.argv.some((line) => line.includes('phase.ts clear --ticket 612'))).toBe(true);
    expect(run.argv.some((line) => line.includes('claim-lease.ts release 612'))).toBe(true);
    expect(run.stdout).toContain('the closed ticket is not resumed');
    expect(run.stdout).not.toContain('the next iteration resumes it');
    expect(events(run).filter((name) => name === 'ticket-closed')).toHaveLength(1);
    expect(events(run)).not.toContain('no-sigil');
    expect(events(run)).not.toContain('control-stop');
    // The second iteration's boundary resumes into its next phase as before.
    expect(views(run).at(-1)).toContain('tracker.ts view 613 --json');
    expect(turns(run)[3]).toContain('--resume');
    expect(turns(run)[3]).toContain('`select` → `implement`');
    expect(run.argv.some((line) => line.includes('claim-lease.ts release 613'))).toBe(false);
  });

  it('never probes select → finish, the shepherd path that runs on a closed ticket', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE finish 612</ralph>|<ralph>DONE</ralph>',
      FAKE_VIEW_STATE: 'closed',
    });
    expect(run.status, run.stdout).toBe(0);
    expect(views(run)).toHaveLength(0);
    expect(turns(run)).toHaveLength(2);
    expect(turns(run)[1]).toContain('`select` → `finish`');
    expect(events(run)).not.toContain('ticket-closed');
  });

  it("never probes a pr-medic's boundary, whose number is a pull request's", () => {
    const work = scratchWorktree();
    writeFileSync(
      join(work.root, '.ralph', 'config.json'),
      JSON.stringify({ ...FIXTURE_CONFIG, loops: ['nova', { name: 'medi', role: 'pr-medic' }], prMedic: { branches: ['felipearosr/*'] } }),
    );
    const run = runSupervisor(work, ['1'], {
      RALPH_LOOP_NAME: 'medi',
      FAKE_GATE_OUTPUT: 'pr-medic-gate: work available — operator PR #2197 on felipearosr/thing — conflicting',
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE implement 2197</ralph>|<ralph>DONE</ralph>',
      FAKE_VIEW_STATE: 'closed',
    });
    expect(run.status, run.stdout).toBe(0);
    expect(views(run)).toHaveLength(0);
    expect(turns(run)).toHaveLength(2);
    expect(turns(run)[1]).toContain(`--resume ${SESSION}`);
    expect(events(run)).not.toContain('ticket-closed');
  });

  it('never probes a boundary with no ticket to read', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE implement</ralph>|<ralph>DONE</ralph>',
      FAKE_VIEW_STATE: 'closed',
    });
    expect(run.status, run.stdout).toBe(0);
    expect(views(run)).toHaveLength(0);
    expect(turns(run)).toHaveLength(2);
    expect(turns(run)[1]).toContain('`select` → `implement`');
    expect(events(run)).not.toContain('ticket-closed');
  });

  it.each([
    ['an open ticket', { FAKE_VIEW_STATE: 'open' }],
    ['a failed read', { FAKE_VIEW_EXIT: '1' }],
    ['an answer that is not JSON', { FAKE_VIEW_RAW: 'not json' }],
    ['an answer with no state', { FAKE_VIEW_RAW: '{"number":612}' }],
    ['a read that outlasts its timeout', { FAKE_VIEW_HANG: '30', RALPH_RECOVERY_PROBE_TIMEOUT: '1' }],
  ])('resumes into the next phase as before on %s', (_case, env) => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE implement 612</ralph>|<ralph>DONE</ralph>',
      ...env,
    });
    expect(run.status, run.stdout).toBe(0);
    expect(views(run)).toHaveLength(1);
    expect(turns(run)).toHaveLength(2);
    expect(turns(run)[1]).toContain(`--resume ${SESSION}`);
    expect(turns(run)[1]).toContain('`select` → `implement`');
    expect(events(run)).toContain('phase');
    expect(events(run)).not.toContain('ticket-closed');
    expect(run.argv.some((line) => line.includes('claim-lease.ts release'))).toBe(false);
  });
});

/**
 * Pause and stop at the next phase boundary. The channel's own rules — which
 * scope applies where, what the record says — are `controls.test.ts`; these
 * pin what the SUPERVISOR does with each answer at a boundary.
 */
describe('phase control', () => {
  const records = (run: Run): string[] => run.argv.filter((line) => line.includes('loop-state.ts record'));
  const turns = (run: Run): string[] => run.argv.filter((line) => line.startsWith('claude argv='));
  const phasePolls = (run: Run): string[] =>
    run.argv.filter((line) => line.includes('controls.ts poll') && line.includes('--phase'));
  const SESSION = '00000000-0000-4000-8000-000000000000';

  it('asks the control channel at every boundary, naming the phase finished and the one next', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE implement 612</ralph>|<ralph>PHASE verify 612</ralph>|<ralph>DONE</ralph>',
    });
    expect(run.status, run.stdout).toBe(0);
    expect(turns(run)).toHaveLength(3);
    expect(phasePolls(run)).toHaveLength(2);
    expect(phasePolls(run)[0]).toContain('poll --supervised --phase implement --after select');
    expect(phasePolls(run)[1]).toContain('--phase verify --after implement');
  });

  it('holds at the boundary, then resumes the same session into the next phase', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE review 612</ralph>|<ralph>DONE</ralph>',
      FAKE_PHASE_HOLDS: '2',
      RALPH_CONTROL_POLL_SECONDS: '1',
    });
    expect(run.status, run.stdout).toBe(0);
    expect(run.stdout).toContain('held by an operator (pause) before review');
    expect(run.stdout).toContain('released —');
    // Two holding polls and the one that released it.
    expect(phasePolls(run)).toHaveLength(3);
    expect(turns(run)).toHaveLength(2);
    expect(turns(run)[1]).toContain(`--resume ${SESSION}`);
    expect(turns(run)[1]).toContain('`select` → `review`');
    // Recorded once, as a pause at the boundary it is held before, and
    // released back into the iteration in that phase.
    const held = records(run).filter((line) => line.includes('--event control-hold'));
    expect(held).toHaveLength(1);
    expect(held[0]).toContain('--stage paused --phase review');
    expect(records(run).find((line) => line.includes('--event control-resume'))).toContain('--stage iteration --phase review');
  });

  it('spends no tokens while held: no session and no budget guard runs until it is released', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE review 612</ralph>|<ralph>DONE</ralph>',
      FAKE_PHASE_HOLDS: '3',
      RALPH_CONTROL_POLL_SECONDS: '1',
    });
    expect(run.status, run.stdout).toBe(0);
    const firstHold = run.argv.findIndex((line) => line.includes('--phase review'));
    const lastPoll = run.argv.map((line) => line.includes('--phase review')).lastIndexOf(true);
    const between = run.argv.slice(firstHold, lastPoll + 1);
    expect(between.some((line) => line.startsWith('claude argv='))).toBe(false);
    expect(between.some((line) => line.includes('iteration-budget.ts'))).toBe(false);
    // One guard per session, each with the iteration's whole cap: the hold
    // took nothing from it and started no session of its own.
    const guards = run.argv.filter((line) => line.includes('iteration-budget.ts watch'));
    expect(guards).toHaveLength(2);
    for (const guard of guards) expect(guard).toMatch(/--limit 120000000 /);
  });

  it("logs the lease watcher to a per-run file instead of discarding it (#119)", () => {
    const work = scratchWorktree();
    const run = runSupervisor(work, ['1'], { FAKE_SIGIL: '<ralph>DONE</ralph>', RALPH_RUN_ID: 'ralph-run-watch' });
    expect(run.status, run.stdout).toBe(0);
    expect(run.argv).toContain('heartbeat-log=.ralph/logs/heartbeat-ralph-run-watch.log');
    expect(readFileSync(join(work.root, '.ralph/logs/heartbeat-ralph-run-watch.log'), 'utf8'))
      .toContain('fake watcher stderr');
  });

  it('keeps the claim lease renewed through a hold longer than the lease itself', () => {
    const work = scratchWorktree();
    const LEASE_MS = 2_000;
    const now = Date.now();
    writeFileSync(
      join(work.root, '.ralph-claim-leases.json'),
      JSON.stringify({
        version: 1,
        leases: {
          612: {
            version: 1, issue: 612, run: 'ralph-run-hold', owner: 'ralph@test', loop: 'ralph', pid: null,
            host: 'test', worktree: work.root, branch: 'ralph/612', claim: 'ralph-wip', logs: '.ralph/logs',
            usageLedger: '.ralph/logs/usage-ledger.tsv', claimedAt: new Date(now).toISOString(),
            heartbeatAt: new Date(now).toISOString(), expiresAt: new Date(now + LEASE_MS).toISOString(),
            leaseMs: LEASE_MS, attempt: 1, history: [],
          },
        },
      }),
    );
    const run = runSupervisor(work, ['1'], {
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE review 612</ralph>|<ralph>DONE</ralph>',
      FAKE_PHASE_HOLDS: '5',
      FAKE_LEASE_PROBE: '1',
      REAL_LEASE: '1',
      RALPH_RUN_ID: 'ralph-run-hold',
      RALPH_CONTROL_POLL_SECONDS: '1',
      RALPH_LEASE_HEARTBEAT_SECONDS: '1',
    });
    expect(run.status, run.stdout).toBe(0);

    // What another loop would have seen at each poll of the hold.
    const probes = readdirSync(join(work.root, 'lease-probes')).sort().map((name) => {
      const [at, ...json] = readFileSync(join(work.root, 'lease-probes', name), 'utf8').split('\n');
      const lease = (JSON.parse(json.join('\n')) as { leases: Array<{ issue: number; run: string; expiresAt: string }> })
        .leases.find((row) => row.issue === 612);
      return { at: Number(at), lease };
    });
    expect(probes).toHaveLength(5);
    // Long enough that an unrenewed lease would have lapsed partway through.
    expect(probes[probes.length - 1]!.at - probes[0]!.at).toBeGreaterThan(LEASE_MS);
    for (const probe of probes) {
      expect(probe.lease?.run).toBe('ralph-run-hold');
      expect(Date.parse(probe.lease!.expiresAt)).toBeGreaterThan(probe.at);
    }
  }, 30_000);

  it('stops before the next phase with the claim kept, and records the phase it stopped before', () => {
    const run = runSupervisor(scratchWorktree(), ['3'], {
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE finish 612</ralph>|<ralph>DONE</ralph>',
      FAKE_PHASE_STOP: 'blocked',
    });
    expect(run.status, run.stdout).toBe(0);
    expect(run.stdout).toContain('iteration 1 stopped before finish on #612');
    expect(run.stdout).toContain('stopped by an operator before finish — stop before it opens a PR');
    // The session is not resumed, and no other iteration starts.
    expect(turns(run)).toHaveLength(1);
    const events = records(run).map((line) => /--event ([^ ]+)/.exec(line)?.[1]);
    expect(events.slice(-2)).toEqual(['iteration-end', 'control-stop']);
    expect(records(run).at(-1)).toContain(
      '--event control-stop --stop blocked --phase finish --why stopped before finish: stop before it opens a PR',
    );
    // Nothing gives the claim back: no release, and no label edit.
    expect(run.argv.some((line) => /controls\.ts poll .*release|issue edit/.test(line))).toBe(false);
    expect(run.stdout).not.toContain('iteration cap');
  });

  it('exits non-zero for a phase stop the operator called a failure', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE verify 612</ralph>|<ralph>DONE</ralph>',
      FAKE_PHASE_STOP: 'failed',
    });
    expect(run.status).toBe(1);
    expect(records(run).at(-1)).toContain('--event control-stop --stop failed --phase verify');
  });

  it('resumes the session as before when the channel cannot answer at a boundary', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE implement 612</ralph>|<ralph>DONE</ralph>',
      FAKE_PHASE_STATUS: '3',
    });
    expect(run.status, run.stdout).toBe(0);
    expect(turns(run)).toHaveLength(2);
    expect(turns(run)[1]).toContain(`--resume ${SESSION}`);
    expect(run.stdout).toContain('iteration cap (1) reached');
  });

  it('retries the phase just finished in a fresh session, under the same cap, and supersedes its ledger line', () => {
    const work = scratchWorktree();
    writeFileSync(join(work.root, '.ralph', 'logs', 'phase-612-verify.md'), 'gates green\n');
    const run = runSupervisor(work, ['1'], {
      FAKE_SIGIL_SEQUENCE: [
        '<ralph>PHASE verify 612</ralph>',
        '<ralph>PHASE review 612</ralph>',
        '<ralph>PHASE finish 612</ralph>',
        '<ralph>PHASE finish 612</ralph>',
        // Not DONE, which would clear the ledger read back below.
        '<ralph>COMPLETE</ralph>',
      ].join('|'),
      FAKE_PHASE_RETRY: 'review',
    });
    expect(run.status, run.stdout).toBe(0);
    expect(turns(run)).toHaveLength(5);
    // The retry is a fresh session, not a resume, on the note before review
    // over the rendered prompt (cut to review's sections: `phase-prompt.test.ts`).
    const retry = turns(run)[3]!;
    expect(retry).toContain(`--session-id ${SESSION}`);
    expect(retry).not.toContain('--resume');
    expect(retry).toContain('# Retrying the `review` phase of iteration 1 on #612');
    expect(retry).toContain('`.ralph/logs/phase-612-verify.md`');
    expect(retry).toContain('rendered:a stub prompt');
    // Once it yields, that fresh session is the one resumed into finish.
    expect(turns(run)[4]).toContain(`--resume ${SESSION}`);
    expect(turns(run)[4]).toContain('`review` → `finish`');
    expect(run.stdout).toContain('released to retry review — new reviewer model');
    // The old session's usage closes before the new one starts.
    expect(run.argv.some((line) => line.includes('iteration 1 retrying review'))).toBe(true);

    // The retry spends from the iteration's cap like every other session.
    const guards = run.argv.filter((line) => line.includes('iteration-budget.ts watch'));
    expect(guards).toHaveLength(5);
    for (const guard of guards) {
      expect(guard).toMatch(/--limit 120000000 /);
      expect(guard).not.toContain('--only-session');
    }

    const retried = records(run).find((line) => line.includes('--event phase-retry'));
    expect(retried).toContain('--phase review');
    expect(retried).toContain('retrying review on #612 before finish');

    const ledger = readFileSync(join(work.root, '.ralph', 'logs', 'phases', '612.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(ledger.map((entry) => [entry.phase, entry.next, entry.attempt, entry.retry])).toEqual([
      ['select', 'verify', 1, false],
      ['verify', 'review', 1, false],
      ['review', 'finish', 1, false],
      ['review', 'finish', 2, true],
    ]);
  });

  it('resumes the old session into the next phase when the retry prompt cannot be built', () => {
    const work = scratchWorktree();
    rmSync(join(work.home, 'phase-prompt.ts'));
    const run = runSupervisor(work, ['1'], {
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE finish 612</ralph>|<ralph>DONE</ralph>',
      FAKE_PHASE_RETRY: 'select',
    });
    expect(run.status, run.stdout).toBe(0);
    expect(turns(run)).toHaveLength(2);
    expect(turns(run)[1]).toContain(`--resume ${SESSION}`);
    expect(turns(run)[1]).toContain('`select` → `finish`');
    expect(run.stdout).toContain('could not build the prompt to retry select');
    expect(records(run).some((line) => line.includes('--event phase-retry'))).toBe(false);
  });

  /** A gate armed before the run starts, as the dashboard leaves it in the inbox. */
  const armed = (phase: string) => {
    const work = scratchWorktree();
    mkdirSync(join(work.root, '.ralph', 'control', 'inbox'), { recursive: true });
    writeFileSync(
      join(work.root, '.ralph', 'control', 'inbox', 'arm-1.json'),
      JSON.stringify({ version: 1, id: 'arm-1', command: 'arm-gate', phase }),
    );
    return work;
  };
  const controlRecord = (work: { root: string }) =>
    JSON.parse(readFileSync(join(work.root, '.ralph', 'logs', 'controls.json'), 'utf8')) as {
      gates: { phase: string }[];
      hold: unknown;
      stop: { kind: string; phase?: string } | null;
    };

  it('holds for approval at an armed gate, and approve resumes the same session into the phase', () => {
    const work = armed('finish');
    const run = runSupervisor(work, ['1'], {
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE review 612</ralph>|<ralph>PHASE finish 612</ralph>|<ralph>DONE</ralph>',
      REAL_CONTROLS: '1',
      FAKE_GATE_ANSWER: 'approve',
      RALPH_CONTROL_POLL_SECONDS: '1',
    });
    expect(run.status, run.stdout).toBe(0);
    // Passed before review, held before finish.
    expect(run.stdout).not.toContain('before review —');
    expect(run.stdout).toContain('held by an operator (approval) before finish — decision gate before-finish');
    expect(run.stdout).toContain('control — approve: approved — from the test');
    expect(turns(run)).toHaveLength(3);
    expect(turns(run)[2]).toContain(`--resume ${SESSION}`);
    expect(turns(run)[2]).toContain('`review` → `finish`');
    // Still armed once the iteration is done: it asks again next time.
    expect(controlRecord(work)).toMatchObject({ gates: [{ phase: 'finish' }], hold: null, stop: null });
  }, 30_000);

  it('ends the iteration before the gated phase on deny, with the claim kept and the outcome recorded', () => {
    const work = armed('finish');
    const run = runSupervisor(work, ['3'], {
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE finish 612</ralph>|<ralph>DONE</ralph>',
      REAL_CONTROLS: '1',
      FAKE_GATE_ANSWER: 'deny',
      RALPH_CONTROL_POLL_SECONDS: '1',
    });
    expect(run.status, run.stdout).toBe(0);
    expect(run.stdout).toContain('iteration 1 stopped before finish on #612');
    expect(turns(run)).toHaveLength(1);
    expect(records(run).at(-1)).toContain('--event control-stop --stop blocked --phase finish --why stopped before finish: approval denied');
    expect(run.argv.some((line) => /controls\.ts poll .*release|issue edit/.test(line))).toBe(false);
    expect(controlRecord(work)).toMatchObject({ gates: [{ phase: 'finish' }], stop: { kind: 'blocked', phase: 'finish' } });
  }, 30_000);

  it('runs as before with the real channel and no gate armed', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE finish 612</ralph>|<ralph>DONE</ralph>',
      REAL_CONTROLS: '1',
    });
    expect(run.status, run.stdout).toBe(0);
    expect(run.stdout).not.toContain('held by an operator');
    expect(turns(run)).toHaveLength(2);
  }, 30_000);
});

/**
 * An iteration cut off between phases is picked up at the phase after the
 * last one that finished, once the ledger agrees with the worktree. What the
 * check accepts is `phase-prompt.test.ts`; these pin what the SUPERVISOR does
 * with its answer, and that every other answer is today's path.
 */
describe('resuming an interrupted ticket', () => {
  const records = (run: Run): string[] => run.argv.filter((line) => line.includes('loop-state.ts record'));
  const turns = (run: Run): string[] => run.argv.filter((line) => line.startsWith('claude argv='));
  const SESSION = '00000000-0000-4000-8000-000000000000';
  const BRANCH = 'ralph/612-loader';
  const ledgerFile = (work: ReturnType<typeof scratchWorktree>, ticket = 612) =>
    join(work.root, '.ralph', 'logs', 'phases', `${ticket}.jsonl`);
  /** A ledger that finished `verify` of #<ticket> on BRANCH at aaaa111, with its note on disk. */
  const interrupted = (work: ReturnType<typeof scratchWorktree>, ticket = 612, line: Record<string, unknown> = {}) => {
    mkdirSync(join(work.root, '.ralph', 'logs', 'phases'), { recursive: true });
    writeFileSync(join(work.root, '.ralph', 'logs', `phase-${ticket}-verify.md`), 'gates green\n');
    const entry = (phase: string, next: string, note: string | null) => ({
      version: 1, ticket, phase, next, note, at: '2026-09-24T01:00:00Z', run: 'ralph-run-old', iteration: 3,
      session: 'old-session', attempt: 1, retry: false, branch: BRANCH, head: 'aaaa111',
    });
    writeFileSync(
      ledgerFile(work, ticket),
      [
        entry('select', 'implement', null),
        entry('implement', 'verify', null),
        { ...entry('verify', 'review', `.ralph/logs/phase-${ticket}-verify.md`), ...line },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n',
    );
  };

  it('resumes the claim at the next phase in a fresh session, and records where', () => {
    const work = scratchWorktree();
    interrupted(work, 1);
    const run = runSupervisor(work, ['1'], {
      FAKE_OWN_CLAIM: '1',
      FAKE_BRANCH: BRANCH,
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE finish 1</ralph>|<ralph>COMPLETE</ralph>',
    });
    expect(run.status, run.stdout).toBe(0);
    expect(turns(run)).toHaveLength(2);
    // A fresh session on the per-phase prompt, not the whole one from select.
    const first = turns(run)[0]!;
    expect(first).toContain(`--session-id ${SESSION}`);
    expect(first).not.toContain('--resume');
    expect(first).toContain('# Resuming #1 at the `review` phase, iteration 1');
    expect(first).toContain('`.ralph/logs/phase-1-verify.md`');
    expect(first).toContain('rendered:a stub prompt');
    // Its boundary is the resumed phase's, and resumes that same session.
    expect(turns(run)[1]).toContain(`--resume ${SESSION}`);
    expect(turns(run)[1]).toContain('`review` → `finish`');
    expect(run.stdout).toContain('iteration 1 resumes #1 at review in a fresh session — verify finished at aaaa111 on ralph/612-loader');

    const start = records(run).find((line) => line.includes('--event iteration-start'));
    expect(start).toContain('--phase review --resumed-at review');
    expect(start).toContain('resuming #1 at review');
  });

  it('enters the resumed phase across its boundary, so a stop or a denied gate there runs no turn', () => {
    const work = scratchWorktree();
    interrupted(work, 1);
    const run = runSupervisor(work, ['3'], {
      FAKE_OWN_CLAIM: '1',
      FAKE_BRANCH: BRANCH,
      FAKE_PHASE_STOP: 'blocked',
      FAKE_SIGIL: '<ralph>DONE</ralph>',
    });
    expect(run.status, run.stdout).toBe(0);
    expect(run.argv.some((line) => /controls\.ts poll --supervised --phase review --after verify/.test(line))).toBe(true);
    expect(turns(run)).toHaveLength(0);
    expect(run.stdout).toContain('iteration 1 stopped before review on #1 — the claim is kept for the next run.');
    expect(records(run).at(-1)).toContain('--event control-stop --stop blocked --phase review');
    // Nothing finished, so nothing is cleared: the next run is asked again.
    expect(existsSync(ledgerFile(work, 1))).toBe(true);
  });

  it('runs the finished phase again when a retry-phase answers the resumed boundary', () => {
    const work = scratchWorktree();
    interrupted(work, 1);
    writeFileSync(join(work.root, '.ralph', 'logs', 'phase-1-implement.md'), 'built\n');
    const run = runSupervisor(work, ['1'], {
      FAKE_OWN_CLAIM: '1',
      FAKE_BRANCH: BRANCH,
      FAKE_PHASE_RETRY: 'verify',
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE review 1</ralph>|<ralph>COMPLETE</ralph>',
    });
    expect(run.status, run.stdout).toBe(0);
    expect(turns(run)).toHaveLength(2);
    expect(turns(run)[0]).toContain('# Retrying the `verify` phase of iteration 1 on #1');
    expect(turns(run)[1]).toContain('`verify` → `review`');
  });

  it.each([
    ['stale: its handoff note is gone', { note: '.ralph/logs/phase-1-gone.md' }, {}, "#1's verify handoff note .ralph/logs/phase-1-gone.md is gone"],
    ['mismatched: another branch', {}, { FAKE_BRANCH: 'ralph/1-other' }, "#1's ledger was written on ralph/612-loader, but the worktree is on ralph/1-other"],
    ['mismatched: the head left the history', {}, { FAKE_GONE_SHA: 'aaaa111' }, "#1's ledger head aaaa111 is not in ralph/612-loader's history"],
    ['unrecorded: a line from before heads were kept', { branch: undefined, head: undefined }, {}, "#1's ledger ends at verify → review without the branch and head it was written on"],
  ])('falls back to the whole prompt when the ledger is %s, and says why', (_name, line, env, why) => {
    const work = scratchWorktree();
    interrupted(work, 1, line);
    const run = runSupervisor(work, ['1'], {
      FAKE_OWN_CLAIM: '1',
      FAKE_BRANCH: BRANCH,
      FAKE_SIGIL: '<ralph>COMPLETE</ralph>',
      ...env,
    });
    expect(run.status, run.stdout).toBe(0);
    expect(turns(run)).toHaveLength(1);
    expect(turns(run)[0]).not.toContain('# Resuming');
    expect(turns(run)[0]).toContain('rendered:a stub prompt');
    expect(run.stdout).toContain(`#1 is not resumed from its phase ledger — ${why}`);
    const start = records(run).find((line) => line.includes('--event iteration-start'))!;
    expect(start).toContain('--phase select');
    expect(start).not.toContain('--resumed-at');
    expect(start).toContain('#1 not resumed from its ledger');
  });

  it('falls back, never halts, when the resume check cannot run', () => {
    const work = scratchWorktree();
    interrupted(work, 1);
    rmSync(join(work.home, 'phase-prompt.ts'));
    const run = runSupervisor(work, ['1'], { FAKE_OWN_CLAIM: '1', FAKE_BRANCH: BRANCH, FAKE_SIGIL: '<ralph>COMPLETE</ralph>' });
    expect(run.status, run.stdout).toBe(0);
    expect(turns(run)).toHaveLength(1);
    expect(turns(run)[0]).not.toContain('# Resuming');
    expect(run.stdout).toContain('#1 is not resumed from its phase ledger — the resume check could not run');
  });

  it('asks the tracker for a claim only when a ledger is on disk, and resumes nothing without one', () => {
    const quiet = runSupervisor(scratchWorktree(), ['1'], { FAKE_OWN_CLAIM: '1', FAKE_SIGIL: '<ralph>COMPLETE</ralph>' });
    expect(quiet.argv.some((line) => line.includes('phase-prompt.ts resume'))).toBe(false);
    expect(quiet.stdout).not.toContain('not resumed');

    // A ledger, but no claim of this loop's: nothing to resume, nothing to explain.
    const work = scratchWorktree();
    interrupted(work, 1);
    const unclaimed = runSupervisor(work, ['1'], { FAKE_BRANCH: BRANCH, FAKE_SIGIL: '<ralph>COMPLETE</ralph>' });
    expect(unclaimed.argv.some((line) => line.includes('phase-prompt.ts resume'))).toBe(false);
    expect(turns(unclaimed)[0]).not.toContain('# Resuming');
  });

  it("uses the ledger for Stop now's interrupted ticket, without asking the tracker", () => {
    const work = scratchWorktree();
    interrupted(work, 42);
    const run = runSupervisor(work, ['1'], {
      RALPH_RESUME_WORK: '1',
      RALPH_RESUME_ISSUE: '42',
      FAKE_BRANCH: BRANCH,
      FAKE_SIGIL: '<ralph>COMPLETE</ralph>',
    });
    expect(run.status, run.stdout).toBe(0);
    expect(turns(run)[0]).toContain('# Resuming #42 at the `review` phase');
    expect(records(run).find((line) => line.includes('--event iteration-start'))).toContain('--resumed-at review');

    // With no ledger for it, Resume work is today's path, and says so.
    const bare = runSupervisor(scratchWorktree(), ['1'], {
      RALPH_RESUME_WORK: '1',
      RALPH_RESUME_ISSUE: '42',
      FAKE_SIGIL: '<ralph>COMPLETE</ralph>',
    });
    expect(bare.status, bare.stdout).toBe(0);
    expect(turns(bare)[0]).not.toContain('# Resuming');
    expect(bare.stdout).toContain('#42 is not resumed from its phase ledger — #42 has no phase ledger');
  });

  it('records the branch and head each boundary finished on', () => {
    const work = scratchWorktree();
    const run = runSupervisor(work, ['1'], {
      FAKE_BRANCH: BRANCH,
      FAKE_HEAD: 'bbbb222',
      FAKE_MAIN: 'bbbb222',
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE implement 612</ralph>|<ralph>COMPLETE</ralph>',
    });
    expect(run.status, run.stdout).toBe(0);
    const [line] = readFileSync(ledgerFile(work), 'utf8').trim().split('\n').map((row) => JSON.parse(row));
    expect(line).toMatchObject({ phase: 'select', next: 'implement', branch: BRANCH, head: 'bbbb222' });
  });

  it('clears the ledger and the notes when the ticket ends DONE, and keeps them otherwise', () => {
    const work = scratchWorktree();
    writeFileSync(join(work.root, '.ralph', 'logs', 'phase-612-select.md'), 'mapped it\n');
    const done = runSupervisor(work, ['1'], {
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE implement 612</ralph>|<ralph>DONE</ralph>',
    });
    expect(done.status, done.stdout).toBe(0);
    expect(existsSync(ledgerFile(work))).toBe(false);
    expect(existsSync(join(work.root, '.ralph', 'logs', 'phase-612-select.md'))).toBe(false);

    // A phase stop keeps the claim, and with it everything a resume needs.
    const stopped = scratchWorktree();
    writeFileSync(join(stopped.root, '.ralph', 'logs', 'phase-612-select.md'), 'mapped it\n');
    const run = runSupervisor(stopped, ['1'], {
      FAKE_SIGIL_SEQUENCE: '<ralph>PHASE implement 612</ralph>|<ralph>DONE</ralph>',
      FAKE_PHASE_STOP: 'blocked',
    });
    expect(run.status, run.stdout).toBe(0);
    expect(existsSync(ledgerFile(stopped))).toBe(true);
    expect(existsSync(join(stopped.root, '.ralph', 'logs', 'phase-612-select.md'))).toBe(true);
  });

  it('clears the ledger of a resumed ticket that ends DONE', () => {
    const work = scratchWorktree();
    interrupted(work, 1);
    const run = runSupervisor(work, ['1'], { FAKE_OWN_CLAIM: '1', FAKE_BRANCH: BRANCH, FAKE_SIGIL: '<ralph>DONE</ralph>' });
    expect(run.status, run.stdout).toBe(0);
    expect(turns(run)[0]).toContain('# Resuming #1');
    expect(existsSync(ledgerFile(work, 1))).toBe(false);
  });
});

describe('the plugin host', () => {
  /** The events the supervisor handed the host, as whole argv lines. */
  const offered = (run: Run): string[] =>
    run.argv.filter((line) => line.includes('plugins.ts event'));
  const on = { RALPH_PLUGINS: 'orca' };

  it('makes no plugin subprocess at all when none is enabled, which is the default', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], { FAKE_SIGIL: '<ralph>DONE</ralph>' });

    expect(run.status).toBe(0);
    expect(offered(run)).toEqual([]);
    expect(run.argv.some((line) => line.includes('plugins.ts pulse'))).toBe(false);
  });

  it('hands enabled plugins the same events as the durable record', () => {
    // One call site for both, so the panel an operator reads in this worktree
    // and whatever a plugin shows cannot come to describe different runs.
    const run = runSupervisor(scratchWorktree(), ['1'], { ...on, FAKE_SIGIL: '<ralph>DONE</ralph>' });

    expect(run.status).toBe(0);
    const events = (lines: string[]): string[] =>
      lines.map((line) => line.replace(/^.*(record|event) /, ''));
    expect(events(offered(run))).toEqual(
      events(run.argv.filter((line) => line.includes('loop-state.ts record'))),
    );
  });

  it('says at startup which plugins are on and how they are, because silence is their failure mode', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      ...on,
      FAKE_SIGIL: '<ralph>DONE</ralph>',
      FAKE_PLUGIN_LINE: 'Plugins: orca degraded (on-event) — lifecycle: no Orca CLI on PATH',
    });

    expect(run.stdout).toContain('Plugins: orca degraded (on-event) — lifecycle: no Orca CLI on PATH');
  });

  it('starts a pulse that runs while the runner does, only when a plugin is enabled', () => {
    // `record` only fires around `claude -p`, and that turn holds for tens of
    // minutes. Without a pulse in between, a healthy long iteration and a
    // supervisor that died after its first event look identical to a plugin.
    const run = runSupervisor(scratchWorktree(), ['1'], { ...on, FAKE_SIGIL: '<ralph>DONE</ralph>' });

    expect(run.status).toBe(0);
    expect(run.argv.some((line) => line.includes('plugins.ts pulse --watch'))).toBe(true);
  });

  it('takes the project\'s plugins unless the run overrides them', () => {
    const work = scratchWorktree();
    const config = join(work.root, '.ralph', 'config.json');
    writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), plugins: ['orca'] }));
    expect(offered(runSupervisor(work, ['1'], { FAKE_SIGIL: '<ralph>DONE</ralph>' })).length).toBeGreaterThan(0);

    const off = scratchWorktree();
    const offConfig = join(off.root, '.ralph', 'config.json');
    writeFileSync(offConfig, JSON.stringify({ ...JSON.parse(readFileSync(offConfig, 'utf8')), plugins: ['orca'] }));
    expect(offered(runSupervisor(off, ['1'], { RALPH_PLUGINS: '', FAKE_SIGIL: '<ralph>DONE</ralph>' }))).toEqual([]);
  });

  it('is never something a loop depends on, so a host that cannot run never stops it', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      ...on,
      FAKE_SIGIL: '<ralph>DONE</ralph>',
      FAKE_PLUGIN_STATUS: '3',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('iteration cap (1) reached');
  });
});

describe('the control channel', () => {
  /** The control polls the supervisor made, as whole argv lines. */
  const polls = (run: Run): string[] =>
    run.argv.filter((line) => line.includes('controls.ts poll'));

  it('asks before the frontier gate, so a held loop never polls the tracker', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], { FAKE_SIGIL: '<ralph>DONE</ralph>' });

    expect(run.status).toBe(0);
    expect(polls(run)).toHaveLength(1);
    // `--supervised` is what lets a stop this supervisor reads be recorded as
    // confirmed rather than as a note left for a process nobody can find. It
    // is passed here or nowhere: `controls.ts` infers nothing.
    expect(polls(run)[0]).toContain('--supervised');
    // The gate costs a `gh` round trip and the iteration costs money; a loop
    // an operator has stopped should ask neither question.
    const order = run.argv.findIndex((line) => line.includes('controls.ts poll'));
    const gate = run.argv.findIndex((line) => line.includes('frontier-gate.ts'));
    expect(order).toBeGreaterThanOrEqual(0);
    expect(order).toBeLessThan(gate);
  });

  it('says where the loop takes its orders at startup', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SIGIL: '<ralph>DONE</ralph>',
      FAKE_CONTROL_LINE: 'Controls: pause since T — the frontier needs a human',
    });

    expect(run.stdout).toContain('Controls: pause since T');
  });

  it('stops the run on a stop verdict, before spending an iteration', () => {
    const run = runSupervisor(scratchWorktree(), ['3'], {
      FAKE_SIGIL: '<ralph>DONE</ralph>',
      FAKE_CONTROL_STATUS: '20',
      FAKE_CONTROL_VERDICT: 'stop\tblocked\tan operator stopped this loop',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('stopped by an operator — an operator stopped this loop');
    expect(gateCalls(run.argv)).toHaveLength(0);
    expect(run.argv.filter((line) => line.startsWith('claude argv='))).toHaveLength(0);
    // The stop kind is the operator's, carried into the durable record: it is
    // what decides whether the panel reads this as triage or as repair.
    expect(
      run.argv.some((line) =>
        line.includes('loop-state.ts record --event control-stop --stop blocked'),
      ),
    ).toBe(true);
  });

  it('exits non-zero only for a stop the operator called a failure', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_CONTROL_STATUS: '20',
      FAKE_CONTROL_VERDICT: 'stop\tfailed\tthe runner is broken',
    });

    expect(run.status).toBe(1);
  });

  it('parks on a hold and carries on when it is released', () => {
    // A hold is temporary by definition: a supervisor that EXITED on one would
    // need a human to start it again, which is the opposite of "pause".
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SIGIL: '<ralph>DONE</ralph>',
      FAKE_CONTROL_HOLDS: '1',
      RALPH_CONTROL_POLL_SECONDS: '1',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('held by an operator');
    expect(run.stdout).toContain('released —');
    expect(polls(run).length).toBeGreaterThanOrEqual(2);
    // Recorded as its own stage, so the panel can tell a loop waiting on the
    // frontier from one waiting on a person.
    expect(
      run.argv.some((line) =>
        line.includes('loop-state.ts record --event control-hold --stage paused'),
      ),
    ).toBe(true);
    expect(run.stdout).toContain('iteration cap (1) reached');
  });

  it('says a loop held by its sleeping project is woken at the project, and records the hold as the sleep', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SIGIL: '<ralph>DONE</ralph>',
      FAKE_CONTROL_HOLDS: '1',
      FAKE_CONTROL_HOLD_LINE: 'hold\tsleep\tthe project is asleep since T — bedtime; wake it to go on',
      RALPH_CONTROL_POLL_SECONDS: '1',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('asleep with its project — the project is asleep since T — bedtime');
    expect(run.stdout).toContain('wake the project from the dashboard');
    expect(run.stdout).not.toContain('held by an operator');
    expect(
      run.argv.some(
        (line) =>
          line.includes('loop-state.ts record --event control-hold --stage paused') &&
          line.includes('sleep: the project is asleep'),
      ),
    ).toBe(true);
    expect(run.stdout).toContain('released —');
  });

  it('renews the claim lease on every poll it stays parked for', () => {
    // A hold long enough to matter would otherwise hand this loop's ticket to
    // another one. Counted rather than merely present: the background watcher
    // and every `record` renew too, so "a heartbeat happened" is true whether
    // or not the park loop renews anything. One extra poll parked is one extra
    // renewal, and that difference is the only thing that pins the line.
    const renewals = (holds: string): number =>
      runSupervisor(scratchWorktree(), ['1'], {
        FAKE_SIGIL: '<ralph>DONE</ralph>',
        FAKE_CONTROL_HOLDS: holds,
        RALPH_CONTROL_POLL_SECONDS: '1',
      }).argv.filter(
        (line) => line.includes('claim-lease.ts heartbeat') && !line.includes('--watch'),
      ).length;

    expect(renewals('2') - renewals('1')).toBe(1);
  });

  it('is a channel, so one that cannot run never holds or stops the loop', () => {
    // The same trade the plugin host makes. A supervisor held by a broken poller
    // would be indistinguishable from one an operator had paused, and nobody
    // would know which it was.
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_SIGIL: '<ralph>DONE</ralph>',
      FAKE_CONTROL_STATUS: '3',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('iteration cap (1) reached');
  });
});

/**
 * Why the orchestrator's own turn ended.
 *
 * Every other runner in the loop has a script around it that can see its exit
 * code; the orchestrator's is a pipeline in this file, and it used to be
 * thrown away. So an iteration that died on an expired credential, a usage
 * limit or a transport error arrived at the bottom of the loop as "ended
 * without a sigil" — the supervisor admitting it did not know why — when the
 * runner had said exactly which one it was.
 */
describe('observing the orchestrator', () => {
  it('classifies only the final message when thinking contains a completion sigil', () => {
    const work = scratchWorktree();
    const stream = join(work.root, 'thinking-sigil.jsonl');
    writeFileSync(
      stream,
      [
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-08-27T12:00:00.000Z',
          message: {
            content: [
              {
                type: 'thinking',
                thinking: 'If the task were finished I would emit <ralph>DONE</ralph>, but it is not.',
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'I could not finish this iteration.',
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 4,
            output_tokens_details: { thinking_tokens: 1 },
          },
          permission_denials: [],
        }),
        '',
      ].join('\n'),
    );

    const run = runSupervisor(work, ['1'], { FAKE_STREAM_FILE: stream });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('ended without a sigil');
    const humanLogName = readdirSync(join(work.root, '.ralph', 'logs')).find((name) =>
      /^iter-.*\.log$/.test(name),
    );
    expect(humanLogName).toBeDefined();
    const humanLog = readFileSync(join(work.root, '.ralph', 'logs', humanLogName!), 'utf8');
    // This is the regression in one line: the former target would stop the
    // loop, while the final-only channel above correctly refuses to.
    expect(humanLog).toContain('<ralph>DONE</ralph>');
  });

  it('hands the turn\'s real exit status to the observation', () => {
    const work = scratchWorktree();
    const result = runSupervisor(work, ['1'], { FAKE_CLAUDE_STATUS: '1', FAKE_SIGIL: 'no sigil here' });

    // Still fatal, and still for the same reason: the supervisor does not
    // treat a classified failure as permission to keep going.
    expect(result.status).toBe(1);
    const observed = result.argv.find((line) => line.includes('runner-failure.ts observe'));
    expect(observed).toContain('--stage orchestrator');
    expect(observed).toContain('--exit 1');
    expect(observed).toContain('--runner claude');
  });

  it('observes a clean turn too, since the record decides what is worth keeping', () => {
    const work = scratchWorktree();

    const observed = runSupervisor(work, ['1']).argv.find((line) =>
      line.includes('runner-failure.ts observe'),
    );

    expect(observed).toContain('--exit 0');
  });

  it('names the attempt, so a failure is attributable to an iteration', () => {
    // `RALPH_ITERATION` is exported for `delegate.sh` and `inspect.sh`, which
    // the ITERATION starts — without it an executor failure is attributable to
    // the run but not to the attempt inside it.
    const work = scratchWorktree();

    const iterations = runSupervisor(work, ['2']).argv
      .filter((line) => line.startsWith('claude iteration='))
      .map((line) => line.replace('claude iteration=', ''));
    expect(iterations).toEqual(['1', '2']);
  });

  it('hands each iteration its own shared event timeline', () => {
    const work = scratchWorktree();

    const timelines = runSupervisor(work, ['2']).argv
      .filter((line) => line.startsWith('claude timeline='))
      .map((line) => line.replace('claude timeline=', ''));
    expect(timelines).toHaveLength(2);
    expect(timelines.every((path) => /^\.ralph\/logs\/iter-.*\.events\.jsonl$/.test(path))).toBe(true);
    expect(new Set(timelines).size).toBe(2);
  });

  it('classifies the runner\'s stderr, and never the model\'s own prose', () => {
    // The two streams are captured apart HERE, where they still are: stdout is
    // structured events, stderr is the only free text handed to the
    // classifier. Merged with `2>&1`, as this used to be, a turn whose
    // OUTPUT discussed a permission denial was recorded as one.
    const work = scratchWorktree();

    const argv = runSupervisor(work, ['1']).argv;
    const observed = argv.find((line) => line.includes('runner-failure.ts observe'));

    // Two DIFFERENT files, which is the whole assertion: `--log` survives as a
    // pointer an operator can follow, and `--errors` is the only one read.
    const logPath = /--log (\S+)/.exec(observed ?? '')?.[1];
    const errorsPath = /--errors (\S+)/.exec(observed ?? '')?.[1];
    expect(logPath).toMatch(/^\.ralph\/logs\/iter-.*\.log$/);
    expect(errorsPath).toMatch(/^\.ralph\/logs\/iter-.*\.err$/);
    expect(errorsPath).not.toBe(logPath);
  });

  it('puts structured stdout through the stream renderer before it reaches disk', () => {
    // The event stream is the largest thing the loop writes. No upstream tee
    // may persist its raw bytes before the renderer can redact them.
    const work = scratchWorktree();

    runSupervisor(work, ['1']);

    const logs = readdirSync(join(work.root, '.ralph', 'logs'));
    expect(logs.some((name) => name.startsWith('iter-') && name.endsWith('.log'))).toBe(true);
    expect(logs.some((name) => name.endsWith('.events.jsonl'))).toBe(true);
    expect(work.argv().some((line) => line.includes('runner-failure.ts redact'))).toBe(true);
  });

  it('gives the redactor the same injected environment the iteration had', () => {
    // `doppler run --` scopes the command it wraps and NOT its pipeline
    // siblings, so a renderer sitting on the right of the pipe inherits the
    // SUPERVISOR's environment — which holds none of the injected secrets. It
    // was therefore striking credential shapes and no values at all, on the
    // largest file the loop writes, while the comment above it claimed
    // otherwise. Nothing but an end-to-end assertion catches that: the filter
    // ran, exited 0, and quietly did half its job.
    const work = scratchWorktree();
    const secret = 'injected-value-that-must-not-survive';

    runSupervisor(work, ['1'], { REAL_REDACT: '1', FAKE_INJECTED_VALUE: secret });

    const logs = join(work.root, '.ralph', 'logs');
    const transcript = readdirSync(logs).find((n) => n.startsWith('iter-') && n.endsWith('.log'));
    const body = readFileSync(join(logs, transcript!), 'utf8');

    // Assert the leak HAPPENED before asserting it was struck: "the secret is
    // absent" passes perfectly against an empty file, which is exactly how the
    // first version of this test passed while the redactor produced nothing.
    expect(body).toContain('leaked');
    // `[redacted:env:` and not a specific variable name: the property under
    // test is that the redactor knew the injected VALUE, which only the
    // environment sweep can supply. Which variable it credits is not a fact
    // about the loop.
    expect(body).toMatch(/\[redacted:env:/);
    expect(body).not.toContain(secret);
  });

  it('never writes the runner\'s stderr to disk in cleartext', () => {
    // Redacted ON THE WAY IN, through a FIFO. Written cleartext and scrubbed
    // afterwards, the one stream chosen for carrying auth failures sat
    // unscrubbed for the whole turn — and permanently if the supervisor was
    // killed before the scrub.
    const work = scratchWorktree();
    const secret = 'stderr-value-that-must-not-survive';

    runSupervisor(work, ['1'], { REAL_REDACT: '1', FAKE_INJECTED_VALUE: secret });

    const logs = join(work.root, '.ralph', 'logs');
    const errs = readdirSync(logs).filter((name) => name.endsWith('.err'));
    expect(errs.length).toBeGreaterThan(0);
    for (const name of errs) {
      const body = readFileSync(join(logs, name), 'utf8');
      expect(body, name).not.toContain(secret);
      expect(body, name).toMatch(/\[redacted:env:/);
    }
    // And the FIFO is not left behind.
    expect(readdirSync(logs).filter((name) => name.endsWith('.errpipe'))).toEqual([]);
  });

  it('keeps stderr out of both the human log and final-only control channel', () => {
    // `$RALPH_PROMPT` contains the sigil literals, so a diagnostic that echoed
    // the command line back would put `<ralph>DONE</ralph>` into the
    // transcript and end the loop on the strength of an error message.
    const work = scratchWorktree();

    runSupervisor(work, ['1'], { REAL_REDACT: '1', FAKE_INJECTED_VALUE: 'x-value-here' });

    const logs = join(work.root, '.ralph', 'logs');
    const transcript = readdirSync(logs).find((name) => name.startsWith('iter-') && name.endsWith('.log'));
    const body = readFileSync(join(logs, transcript!), 'utf8');
    const final = readdirSync(logs).find((name) => name.endsWith('.final.txt'));
    expect(body).not.toContain('stderr leaked');
    expect(body).not.toContain('--- stderr');
    expect(readFileSync(join(logs, final!), 'utf8')).not.toContain('stderr leaked');
  });

  it('does not wait on a stderr reader an orphaned grandchild is holding open', async () => {
    // The hang this shape exists to avoid. An `exec`-opened fd is inherited by
    // `claude` and everything it spawns, so ONE surviving descendant keeps the
    // write end open, the reader never reaches EOF, and an unbounded `wait` on
    // it never returns — past the last `record`, with the heartbeats still
    // pulsing a loop that is dead.
    //
    // The orphan holds ONLY stderr and lives 30s, which is what makes this a
    // test at all. Holding stdout too, `| tee` blocks for the orphan's whole
    // life whatever the stderr capture does — so an orphan that held both
    // passed identically under the unbounded `wait` this is written to catch.
    //
    // Bounded, the supervisor gives up on the capture after ~10s. Unbounded —
    // an `exec` fd and a `wait`, or a COMPOUND process substitution, which
    // bash also waits on inside a pipeline — it takes the orphan's full 30s.
    // The gap between the two is the assertion.
    // Timed on the supervisor's own `exit`, NOT on `spawnSync`, and the
    // difference is the whole measurement: `spawnSync` resolves when the
    // child's STDIO closes, and the redactor reading the orphan's stderr
    // inherits the supervisor's stderr pipe — so it reports the orphan's full
    // life however promptly the supervisor finished. That is a property of the
    // harness, not of the loop.
    const work = scratchWorktree();
    const started = Date.now();

    const { code, elapsed } = await new Promise<{ code: number | null; elapsed: number }>(
      (resolveWith) => {
        const child = spawn('bash', [join(work.home, 'ralph.sh'), '1'], {
          cwd: work.root,
          env: {
            ...supervisorEnvironment(work),
            REAL_REDACT: '1',
            FAKE_ORPHAN: '30',
          },
          stdio: 'ignore',
        });
        child.on('exit', (status) => resolveWith({ code: status, elapsed: Date.now() - started }));
      },
    );

    expect(code).toBe(0);
    expect(elapsed).toBeLessThan(20_000);
  }, 90_000);

  it('is not stopped by a pattern file it cannot read', () => {
    // `redact` fails closed, but it must DRAIN while it fails: returning
    // immediately closed the read end of a live pipe and every subsequent
    // stderr write by the orchestrator took EPIPE. A redactor that kills the
    // runner it was added to protect is worse than the leak.
    const work = scratchWorktree();
    // The scratch's own copy, which is the one the scratch's redactor reads.
    writeFileSync(join(work.home, 'runner-signals.json'), '{ broken');
    const secret = 'v-secret-value-that-must-not-survive';

    const result = runSupervisor(work, ['1'], { REAL_REDACT: '1', FAKE_INJECTED_VALUE: secret });

    // Fail-closed: the filter discarded the stream rather than writing it
    // unredacted, so the transcript is empty, so there is no sigil, so the
    // supervisor stops — loudly and of its own accord rather than hanging.
    expect(result.status).toBe(1);
    const logs = join(work.root, '.ralph', 'logs');
    const transcript = readdirSync(logs).find((n) => n.startsWith('iter-') && n.endsWith('.log'));
    expect(readFileSync(join(logs, transcript!), 'utf8')).toBe('');
    // And nothing anywhere carries the value the runner echoed.
    for (const name of readdirSync(logs)) {
      expect(readFileSync(join(logs, name), 'utf8'), name).not.toContain(secret);
    }
  }, 30_000);

  it('is not allowed to cost the loop anything when it cannot be written', () => {
    // The rule the rest of the supervisor's bookkeeping follows. A loop that
    // stopped because its observability failed would be strictly worse than
    // the blindness this replaces.
    const work = scratchWorktree();
    expect(runSupervisor(work, ['1'], { FAKE_OBSERVE_STATUS: '1' }).status).toBe(0);
  });
});

/**
 * The project seam, at the supervisor. Everything project-specific reaches
 * `ralph.sh` through `.ralph/config.json`: these pin that the config is
 * required, that its values — not a hardcoded Loggd scope — decide how children
 * are wrapped and what refuses startup, and that a stale HARNESS (shared by
 * every loop) is a warning where a stale PROJECT worktree is a refusal.
 */
describe('the project seam', () => {
  const writeConfig = (work: ReturnType<typeof scratchWorktree>, over: Record<string, unknown>): void => {
    writeFileSync(join(work.root, '.ralph', 'config.json'), JSON.stringify({ ...FIXTURE_CONFIG, ...over }));
  };

  it('refuses to start without a valid .ralph/config.json, before any child', () => {
    const work = scratchWorktree();
    rmSync(join(work.root, '.ralph', 'config.json'));
    const run = runSupervisor(work, ['1']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('.ralph/config.json');
    expect(run.argv.some((line) => line.startsWith('claude '))).toBe(false);
    expect(run.argv.some((line) => line.startsWith('run '))).toBe(false);
  });

  it('refuses a misspelt key rather than reading it as "withhold nothing"', () => {
    const work = scratchWorktree();
    const { withhold: _withhold, ...rest } = FIXTURE_CONFIG.secrets;
    writeConfig(work, { secrets: { ...rest, withold: FIXTURE_CONFIG.secrets.withhold } });
    const run = runSupervisor(work, ['1']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("unknown key 'secrets.withold'");
    expect(run.argv.some((line) => line.startsWith('claude '))).toBe(false);
  });

  it('wraps every child in the configured Doppler scope, never a hardcoded one', () => {
    const work = scratchWorktree();
    const run = runSupervisor(work, ['1']);
    expect(run.status).toBe(0);
    const scoped = run.argv.filter((line) => line.startsWith('run '));
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((line) => line.startsWith('run -p loggd-web -c dev -- '))).toBe(true);
    // Every child runs under the filter; only the per-turn scope probe (#759)
    // runs bare, because the filter's envCheck is not the scope.
    const children = scoped.filter((line) => line !== 'run -p loggd-web -c dev -- true');
    expect(children.length).toBeGreaterThan(0);
    expect(children.every((line) => line.startsWith('run -p loggd-web -c dev -- env '))).toBe(true);
    // The withheld names reach the filter as `env -u NAME`, every one of them.
    for (const name of FIXTURE_CONFIG.secrets.withhold) {
      expect(children.every((line) => line.includes(`-u ${name}`))).toBe(true);
    }
  });

  it('strips a withheld secret the secrets manager injected from what the child sees', () => {
    // Control first: without the withhold, the fake doppler's injected
    // credential DOES reach the orchestrator — so the assertion below cannot
    // pass merely because nothing was ever injected.
    const control = runSupervisor(scratchWorktree(), ['1'], { FAKE_INJECTED_VALUE: 'withheld-value-0123456789' });
    expect(control.status).toBe(0);
    expect(control.argv).toContain('claude injected=set');

    const work = scratchWorktree();
    writeConfig(work, {
      secrets: { ...FIXTURE_CONFIG.secrets, withhold: [...FIXTURE_CONFIG.secrets.withhold, 'INJECTED_API_TOKEN'] },
    });
    const run = runSupervisor(work, ['1'], { FAKE_INJECTED_VALUE: 'withheld-value-0123456789' });
    expect(run.status).toBe(0);
    expect(run.argv).toContain('claude injected=');
    expect(run.argv).not.toContain('claude injected=set');
  });

  it('hands the iteration a Buildkite token only once it is proved read-only, and never logs it', () => {
    const secret = 'bkua_readonly0123456789abcdef0123456789';
    const armed = runSupervisor(scratchWorktree(), ['1'], { FAKE_BUILDKITE_SECRET: secret });
    expect(armed.status).toBe(0);
    // Read from the configured scope, by name, and checked before export.
    expect(armed.argv).toContain('secrets get RALPH_BUILDKITE_READ_TOKEN --plain -p loggd-web -c dev');
    // The project's withheld BUILDKITE_API_TOKEN is never read.
    expect(armed.argv.some((line) => line.includes('BUILDKITE_API_TOKEN') && !line.includes('-u BUILDKITE_API_TOKEN'))).toBe(false);
    expect(armed.argv).toContain('ralph/bk-log.ts --check-token');
    expect(armed.argv).toContain(`claude buildkite=${secret}`);
    // The role declares the secret and its target, so the line names both
    // (#140); it is still the check's own verdict that decides.
    expect(armed.stdout).toContain('RALPH_BUILDKITE_READ_TOKEN is available to the iteration');
    expect(armed.stdout + armed.stderr).not.toContain(secret);
    // The supervisor half of the contract `preflight.ts`'s `buildkite-retry`
    // reads. Without this the reader is fenced against a list no test pins,
    // which is how the first draft of that check shipped unable ever to
    // report a configured token as present (#158).
    expect(armed.argv).toContain('claude secrets-available=RALPH_BUILDKITE_READ_TOKEN');
    expect(armed.argv).toContain('claude secrets-withheld=');

    const writable = runSupervisor(scratchWorktree(), ['1'], { FAKE_BUILDKITE_SECRET: secret, FAKE_BK_CHECK_STATUS: '3' });
    expect(writable.status).toBe(0);
    expect(writable.argv).toContain('claude buildkite=');
    expect(writable.argv).not.toContain(`claude buildkite=${secret}`);
    expect(writable.stdout).toContain('RALPH_BUILDKITE_READ_TOKEN withheld: the Buildkite token is not read-only');
    // Stored but refused by its check: withheld, and NOT available. The two
    // lists are the whole difference between "store a token" and "the token
    // you stored was refused", which is what the preflight reports.
    expect(writable.argv).toContain('claude secrets-withheld=RALPH_BUILDKITE_READ_TOKEN');
    expect(writable.argv).toContain('claude secrets-available=');
    // Stripped after `doppler run` re-injects it, not merely left unexported.
    expect(writable.argv.some((line) => line.startsWith('run ') && line.includes('-u RALPH_BUILDKITE_READ_TOKEN'))).toBe(true);

    // No token in the scope: a warning, and the loop still runs.
    const none = runSupervisor(scratchWorktree(), ['1']);
    expect(none.status).toBe(0);
    expect(none.stdout).toContain('no RALPH_BUILDKITE_READ_TOKEN (RALPH_BUILDKITE_READ_TOKEN is not in the secrets scope)');
    expect(none.stdout + none.stderr).not.toContain('Could not find requested secret');
    expect(none.argv.some((line) => line.includes('bk-log.ts'))).toBe(false);
    // Nothing in the scope: neither list names it, so the preflight's remedy
    // is the one that tells the operator to store a token.
    expect(none.argv).toContain('claude secrets-available=');
    expect(none.argv).toContain('claude secrets-withheld=');
    expect(none.argv.filter((line) => line.startsWith('claude run-id='))).toHaveLength(1);
  });

  it('refuses a configured refuse file, by its configured name', () => {
    const work = scratchWorktree();
    writeConfig(work, { refuseFiles: ['.env.override'] });
    writeFileSync(join(work.root, '.env.override'), 'DATABASE_URL=invented\n');
    const run = runSupervisor(work, ['1']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('.env.override exists and would override the injected environment');
    expect(run.argv.some((line) => line.startsWith('claude '))).toBe(false);
  });

  it('still refuses .env.local for loggd', () => {
    const work = scratchWorktree();
    writeFileSync(join(work.root, '.env.local'), 'DATABASE_URL=invented\n');
    const run = runSupervisor(work, ['1']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('.env.local exists');
  });

  it('runs a project with no secrets manager without ever calling doppler', () => {
    const work = scratchWorktree();
    writeConfig(work, { secrets: { runner: 'none', withhold: [] }, envCheck: [] });
    // The fake doppler stays on PATH and records every call, so "never
    // called" is observed rather than inferred from an absent binary.
    const run = runSupervisor(work, ['1']);
    expect(run.status).toBe(0);
    expect(run.argv.some((line) => line.startsWith('run '))).toBe(false);
    expect(run.argv.filter((line) => line.startsWith('claude run-id='))).toHaveLength(1);
  });

  it('never probes the secrets scope before a turn when the project has no secrets manager', () => {
    const work = scratchWorktree();
    writeConfig(work, { secrets: { runner: 'none', withhold: [] }, envCheck: [] });
    const run = runSupervisor(work, ['1'], {
      FAKE_SECRETS_ENV_FAIL_TIMES: '5',
      FAKE_SECRETS_ENV_FAILS_AFTER: '0',
      RALPH_PREFLIGHT_RETRY_SECONDS: '1',
    });

    expect(run.status).toBe(0);
    expect(run.argv.some((l) => l.startsWith('run '))).toBe(false);
    expect(run.stdout).not.toContain('the secrets scope could not be read');
    expect(run.argv.filter((l) => l.startsWith('claude run-id='))).toHaveLength(1);
  });

  it('runs the configured envCheck, so a project check that fails stops the child', () => {
    const work = scratchWorktree();
    writeFileSync(join(work.root, 'scripts', 'always-fails.sh'), 'echo "project says no" >&2; exit 1\n');
    writeConfig(work, { envCheck: ['bash', 'scripts/always-fails.sh'] });
    const run = runSupervisor(work, ['1']);
    expect(run.status).not.toBe(0);
    expect(run.stderr + run.stdout).toContain('project says no');
    expect(run.argv.some((line) => line.startsWith('claude '))).toBe(false);
  });

  it('warns, but starts, when the shared harness is behind its origin/main', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      FAKE_HOME_HEAD: 'home-old',
      FAKE_HOME_MAIN: 'home-new',
      FAKE_SIGIL: '<ralph>COMPLETE</ralph>',
    });
    expect(run.status).toBe(0);
    expect(run.stderr).toContain('the harness at');
    expect(run.stderr).toContain('is behind its origin/main');
    expect(run.argv.filter((line) => line.startsWith('claude run-id='))).toHaveLength(1);
  });

  it('says nothing about the harness when it is current', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], { FAKE_SIGIL: '<ralph>COMPLETE</ralph>' });
    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain('the harness at');
  });

  it('runs in the project and hands every child RALPH_HOME and RALPH_PROJECT', () => {
    const work = scratchWorktree();
    const run = runSupervisor(work, ['1']);
    expect(run.status).toBe(0);
    // State lands in the PROJECT's .ralph/logs, never in the harness checkout.
    expect(run.supervisorLogs).toHaveLength(1);
    expect(existsSync(join(work.home, '.ralph'))).toBe(false);
    expect(existsSync(join(work.home, 'logs'))).toBe(false);
  });
});


describe('Codex supervisor dispatch', () => {
  it('recovers the exact Codex thread when its first turn has no sigil', () => {
    const work = scratchWorktree();
    writeExecutable(join(work.bin, 'codex'), [
      '#!/usr/bin/env python3',
      'import json, sys',
      'prompt = sys.stdin.read()',
      `with open(${JSON.stringify(join(work.root, 'codex-calls.jsonl'))}, 'a') as out: out.write(json.dumps(sys.argv[1:]) + '\\n')`,
      `print(json.dumps({'type': 'thread.started', 'thread_id': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}))`,
      `text = '<ralph>DONE</ralph>' if 'resume' in sys.argv else 'unfinished'`,
      `print(json.dumps({'type': 'item.completed', 'item': {'type': 'agent_message', 'text': text}}))`,
      `print(json.dumps({'type': 'turn.completed', 'usage': {'input_tokens': 100, 'cached_input_tokens': 40, 'output_tokens': 5}}))`,
    ]);
    const run = runSupervisor(work, ['1'], {
      CODEX_HOME: work.root,
      FAKE_LINEUP_EXPORTS: [
        "export RALPH_MODEL_ORCHESTRATOR='gpt-5.6-terra'",
        "export RALPH_RUNNER_ORCHESTRATOR='codex'",
        "export RALPH_MODEL_ORCHESTRATOR_EFFORT='high'",
        "export RALPH_MODEL_STAGE_VARS='RALPH_MODEL_ORCHESTRATOR'",
        "export RALPH_RUNNER_STAGE_VARS='RALPH_RUNNER_ORCHESTRATOR'",
      ].join('\n'),
    });
    expect(run.status, run.stderr + run.stdout).toBe(0);
    const calls = readFileSync(join(work.root, 'codex-calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('resume');
    expect(calls[1]).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(run.argv.some((line) => line.startsWith('claude run-id='))).toBe(false);
    expect(run.argv.some((line) => line.includes('--stage orchestrator --runner codex'))).toBe(true);
  });

  it('resumes the exact Codex thread at a phase boundary', () => {
    const work = scratchWorktree();
    writeExecutable(join(work.bin, 'codex'), [
      '#!/usr/bin/env python3',
      'import json, sys',
      'prompt = sys.stdin.read()',
      `with open(${JSON.stringify(join(work.root, 'codex-calls.jsonl'))}, 'a') as out: out.write(json.dumps({'args': sys.argv[1:], 'prompt': prompt}) + '\\n')`,
      `print(json.dumps({'type': 'thread.started', 'thread_id': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}))`,
      `text = '<ralph>DONE</ralph>' if 'resume' in sys.argv else '<ralph>PHASE implement 612</ralph>'`,
      `print(json.dumps({'type': 'item.completed', 'item': {'type': 'agent_message', 'text': text}}))`,
      `print(json.dumps({'type': 'turn.completed', 'usage': {'input_tokens': 100, 'cached_input_tokens': 40, 'output_tokens': 5}}))`,
    ]);
    const run = runSupervisor(work, ['1'], {
      CODEX_HOME: work.root,
      FAKE_LINEUP_EXPORTS: [
        "export RALPH_MODEL_ORCHESTRATOR='gpt-5.6-terra'",
        "export RALPH_RUNNER_ORCHESTRATOR='codex'",
        "export RALPH_MODEL_STAGE_VARS='RALPH_MODEL_ORCHESTRATOR'",
        "export RALPH_RUNNER_STAGE_VARS='RALPH_RUNNER_ORCHESTRATOR'",
      ].join('\n'),
    });
    expect(run.status, run.stderr + run.stdout).toBe(0);
    const calls = readFileSync(join(work.root, 'codex-calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toContain('resume');
    expect(calls[1].args).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(calls[1].prompt).toContain('`select` → `implement`');
    expect(run.argv.some((line) => line.includes('--event phase') && line.includes('--phase implement'))).toBe(true);
    expect(run.argv.some((line) => line.includes('--event sigil-recovery'))).toBe(false);
  });
});

/**
 * rafa #1107 (2026-09-23): the orchestrator's Bash tool could not wait longer
 * than 600s, so it wrapped `delegate.sh` in `timeout 590` and stopped waiting
 * on an executor whose own budget was 900s. The supervisor now raises the
 * tool's ceiling past the largest budget a brief can declare.
 */
describe("the orchestrator's wait on a delegation", () => {
  const recordCeiling = (work: ReturnType<typeof scratchWorktree>) =>
    writeExecutable(join(work.bin, 'claude'), [
      '#!/bin/sh',
      `printf 'claude bash-max=%s\\n' "\${BASH_MAX_TIMEOUT_MS:-unset}" >> ${JSON.stringify(join(work.root, 'argv.log'))}`,
      'printf \'{"type":"result","subtype":"success","result":"<ralph>DONE</ralph>","usage":{"input_tokens":1,"output_tokens":1},"permission_denials":[]}\\n\'',
    ]);

  it('raises the Bash tool ceiling above the largest executor budget', () => {
    const work = scratchWorktree();
    recordCeiling(work);
    const run = runSupervisor(work, ['1'], { RALPH_DELEGATE_MAX_TIMEOUT: '3000', BASH_MAX_TIMEOUT_MS: '' });
    const ceiling = run.argv.find((line) => line.startsWith('claude bash-max='));
    expect(ceiling).toBeDefined();
    expect(Number(ceiling?.split('=')[1])).toBeGreaterThan(3000 * 1000);
  });

  it('never lowers a ceiling the operator already set higher', () => {
    const work = scratchWorktree();
    recordCeiling(work);
    const run = runSupervisor(work, ['1'], { BASH_MAX_TIMEOUT_MS: '99000000' });
    expect(run.argv).toContain('claude bash-max=99000000');
  });
});

/**
 * The plan usage stop (`usage-stop.ts`): at a share of the plan the operator
 * chose, a loop drains — no new ticket, only what it already holds — and at
 * the hard threshold, or once nothing held is left, parks until the window
 * resets. Neither is an iteration, so `['1']` still runs the one after.
 */
describe('the plan usage stop', () => {
  const records = (run: Run): string[] => run.argv.filter((line) => line.includes('loop-state.ts record'));
  const events = (run: Run): string[] => records(run).map((line) => /--event ([^ ]+)/.exec(line)?.[1] ?? '');
  const turns = (run: Run): string[] => run.argv.filter((line) => line.startsWith('claude run-id='));
  const pushes = (run: Run): string[] => run.argv.filter((line) => line.includes('push-notification.ts push --kind usage-stop'));
  const FAST = { RALPH_CONTROL_POLL_SECONDS: '1', RALPH_USAGE_STOP_RECHECK_SECONDS: '1' };
  const PARK = 'park\\t900\\tseven_day:1794841200\\tseven_day 96% ≥ 95% — parked until Tue 17 11:02';
  const DRAIN = 'drain\\t900\\tseven_day:1794841200\\tseven_day 81% ≥ 80% — no new work until Tue 17 11:02; parks at 95%';

  it('runs as before when no stop applies', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], FAST);
    expect(run.status).toBe(0);
    expect(run.argv).toContain('ralph/usage-stop.ts check --loop ralph');
    expect(events(run).filter((event) => event.startsWith('usage-'))).toEqual([]);
    expect(turns(run)).toHaveLength(1);
  });

  it('parks at the hard threshold without asking the gate, records and pages once, then resumes', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], { ...FAST, FAKE_USAGE_STOP: `${PARK}|${PARK}` });
    expect(run.status).toBe(0);
    const seen = events(run);
    // Two parked passes, one record and one page: a park that lasts days
    // must not write a line per recheck.
    expect(seen.filter((event) => event === 'usage-stop')).toHaveLength(1);
    expect(pushes(run)).toHaveLength(1);
    expect(pushes(run)[0]).toContain('--occurrence usage-stop:ralph:seven_day:1794841200');
    expect(pushes(run)[0]).not.toContain('--ticket');
    expect(seen.indexOf('usage-stop-cleared')).toBeGreaterThan(seen.indexOf('usage-stop'));
    // The gate is first asked after the park cleared.
    const firstGate = run.argv.findIndex((line) => line.includes('frontier-gate.ts'));
    const lastCheckParked = run.argv.map((line, at) => (line.includes('usage-stop.ts check') ? at : -1)).filter((at) => at >= 0)[1]!;
    expect(firstGate).toBeGreaterThan(lastCheckParked);
    expect(run.stdout).toContain('plan usage stop — seven_day 96% ≥ 95%');
    expect(turns(run)).toHaveLength(1);
    expect(records(run).join('\n')).not.toMatch(/--stop (failed|blocked)/);
    expect(records(run).find((line) => line.includes('--event usage-stop-cleared'))).toContain('no usage stop');
  });

  it('drains: asks the gate once even when gated, and parks on new work rather than spawning', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      ...FAST,
      RALPH_WAIT_FOR_WORK: '300',
      FAKE_USAGE_STOP: DRAIN,
    });
    expect(run.status).toBe(0);
    // Draining it asked `--once`; once the stop cleared, the blocking gate.
    expect(gateCalls(run.argv)).toEqual(['ralph/frontier-gate.ts --once', 'ralph/frontier-gate.ts 300']);
    const seen = events(run);
    expect(seen).toContain('usage-drain');
    expect(seen.indexOf('usage-stop')).toBeGreaterThan(seen.indexOf('usage-drain'));
    expect(records(run).find((line) => line.includes('--event usage-stop '))).toContain('nothing held is left to finish');
    expect(turns(run)).toHaveLength(1);
  });

  it('drains quietly once finished: a recheck that parks again writes nothing new', () => {
    // 2026-11-13 on loggd: every 5-minute recheck of a finished drain wrote a
    // drain and a park pair, 60–78 of them per loop over one night.
    const run = runSupervisor(scratchWorktree(), ['1'], {
      ...FAST,
      FAKE_USAGE_STOP: `${DRAIN}|${DRAIN}|${DRAIN}`,
    });
    expect(run.status).toBe(0);
    const seen = events(run);
    expect(seen.filter((event) => event === 'usage-drain')).toHaveLength(1);
    expect(seen.filter((event) => event === 'usage-stop')).toHaveLength(1);
    expect(run.stdout.match(/draining: only work/g)).toHaveLength(1);
    // Still asked each time: held work may have turned up since.
    expect(gateCalls(run.argv).filter((line) => line.endsWith('--once')).length).toBeGreaterThanOrEqual(4);
    expect(turns(run)).toHaveLength(1);
  });

  it('drains: announces the drain again when held work turns up after a quiet park', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      ...FAST,
      FAKE_USAGE_STOP: `${DRAIN}|${DRAIN}`,
      FAKE_GATE_SEQUENCE: 'frontier-gate: work available — frontier ticket #1|frontier-gate: work available — Ralph PR #7 to shepherd',
    });
    expect(run.status).toBe(0);
    expect(events(run)).toEqual(expect.arrayContaining(['usage-drain', 'usage-stop']));
    const seen = events(run);
    expect(seen.lastIndexOf('usage-drain')).toBeGreaterThan(seen.indexOf('usage-stop'));
    expect(turns(run)).toHaveLength(1);
  });

  it('drains: spawns on a pull request the loop already holds', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      ...FAST,
      FAKE_USAGE_STOP: DRAIN,
      FAKE_GATE_OUTPUT: 'frontier-gate: work available — Ralph PR #7 to shepherd',
    });
    expect(run.status).toBe(0);
    expect(events(run)).toContain('usage-drain');
    expect(events(run)).not.toContain('usage-stop');
    expect(turns(run)).toHaveLength(1);
  });

  it('drains: parks rather than stops when an ungated gate finds nothing held', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], {
      ...FAST,
      FAKE_USAGE_STOP: DRAIN,
      FAKE_GATE_OUTPUT: 'frontier-gate: nothing to do — the frontier is empty',
      FAKE_GATE_STATUS: '1',
    });
    expect(run.status).toBe(0);
    // Draining, the empty answer parked; once the stop cleared, the same
    // answer stopped the run as it always has.
    const seen = events(run);
    expect(seen.indexOf('usage-stop')).toBeGreaterThan(seen.indexOf('usage-drain'));
    expect(seen.indexOf('frontier-empty')).toBeGreaterThan(seen.indexOf('usage-stop'));
    expect(turns(run)).toHaveLength(0);
  });

  it('reads an unreadable check as run', () => {
    const run = runSupervisor(scratchWorktree(), ['1'], { ...FAST, FAKE_USAGE_STOP: 'garbage' });
    expect(run.status).toBe(0);
    expect(events(run).filter((event) => event.startsWith('usage-'))).toEqual([]);
    expect(turns(run)).toHaveLength(1);
  });
});
