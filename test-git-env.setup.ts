/**
 * Vitest loads this before every test file. A pre-push hook runs with `GIT_DIR`
 * set to the outer checkout; a suite that spreads `process.env` into a `git`
 * child would then act on the real repository instead of its fixture. Strip the
 * git repo-location variables once here so no suite inherits them, whatever it
 * does with `process.env` afterwards.
 */
import { stripGitLocationEnv } from "./test-git-env";

stripGitLocationEnv();
