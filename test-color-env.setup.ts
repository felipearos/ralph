/**
 * Vitest loads this before every test file. A shell that exports
 * `FORCE_COLOR` (some terminals and agent shells set `FORCE_COLOR=3`) makes a
 * Bun child colour its `console.error` output even into a pipe, so a suite that
 * spawns a CLI with `process.env` and compares its stderr sees
 * `"… at least one loop\x1b[0m"` instead of the message: `onboarding-http`
 * failed that way on a clean main (#187). Remove the forcing variables once
 * here so every child starts uncoloured, whatever shell ran the suite. Their
 * output goes to pipes, so nothing else turns colour back on.
 */

/** The variables that force colour onto a non-terminal stream. */
export const FORCED_COLOR_ENV = ["FORCE_COLOR", "CLICOLOR_FORCE"] as const;

/** Strip the colour-forcing variables from `env` (the process by default). */
export function stripForcedColorEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of FORCED_COLOR_ENV) delete env[name];
}

stripForcedColorEnv();
