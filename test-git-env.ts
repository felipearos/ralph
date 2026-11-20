/**
 * Git exports `GIT_DIR` (and its repo-location siblings) to a pre-push hook.
 *
 * A test that spreads `process.env` into a `git` child — or drives a script
 * that does, like `publish-journal.ts` and `inspect.sh` — inherits them, and
 * then every `git -C <fixture>` runs against the OUTER checkout instead. The
 * suite passes when run by hand and fails only from the hook, which is the
 * worst way for a gate to be wrong.
 *
 * Import this for its side effect at the top of such a suite: it removes the
 * variables from the test process, so every child built from `process.env`
 * (and every helper object built from it) starts from the fixture.
 */

/** The variables that point git at a repository, working tree or config. */
export const GIT_LOCATION_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_ATTR_SOURCE",
  "GIT_PREFIX",
  "GIT_CONFIG_PARAMETERS",
  "GIT_NAMESPACE",
  "GIT_GRAFT_FILE",
] as const;

/** Strip the repository-location variables from `env` (the process by default). */
export function stripGitLocationEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of GIT_LOCATION_ENV) delete env[name];
}

/**
 * A child environment with the repo-location variables removed, whatever the
 * test process happens to hold when it is called.
 *
 * Module-level stripping is not enough under Vitest's shared workers: another
 * test file can re-add `GIT_DIR` between this file's import and its tests. So
 * every `git` spawn in a hermetic suite builds its env through here, and the
 * fixture — not the outer checkout — is what the command sees.
 */
export function fixtureGitEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  stripGitLocationEnv(env);
  return env;
}
