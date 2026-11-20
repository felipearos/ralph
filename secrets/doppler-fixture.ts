/**
 * A stand-in `doppler` executable for the tests that run the real process path
 * (`doppler.test.ts`, `read.test.ts`). It answers `doppler secrets get <NAME>`
 * by name, so one script covers every outcome the classification knows.
 */
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The value STORED reads as: no trailing newline, an inner one kept. */
export const FIXTURE_VALUE = "tok_fixture\nsecond line";

/**
 * Writes `doppler` into `dir` and returns `dir`, ready to prepend to PATH.
 *
 * - STORED: the value on stdout, and an update notice on stderr, as Doppler
 *   prints even on success.
 * - LOCKED: a keyring error, exit 1.
 * - SILENT: exit 1 with nothing said.
 * - HANG: a child that outlives any deadline. Not exec'd, so the shell keeps
 *   a grandchild holding the pipes — what the runner's group kill is for.
 * - anything else: Doppler's not-found error.
 */
export function writeFakeDoppler(dir: string): string {
  const script = join(dir, "doppler");
  writeFileSync(
    script,
    [
      "#!/usr/bin/env bash",
      'case "$3" in',
      `  STORED) printf '%s' '${FIXTURE_VALUE}'; echo 'A new version of the Doppler CLI is available' >&2; exit 0 ;;`,
      "  LOCKED) printf 'Doppler Error: failed to unlock correct collection\\n/org/freedesktop/secrets\\n' >&2; exit 1 ;;",
      "  SILENT) exit 1 ;;",
      "  HANG) sleep 60; exit 0 ;;",
      '  *) echo "Doppler Error: Could not find requested secret: $3" >&2; exit 1 ;;',
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return dir;
}
