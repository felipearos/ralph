// @vitest-environment node
/**
 * Proves `fixtures/loggd/.ralph` still matches the real `.ralph/` on
 * felipearos/loggd's `origin/main`. Runs for real wherever a loggd checkout is
 * reachable (see fixture-mirror.ts); elsewhere it skips with the reason in the
 * test name, so a vacuous pass is never mistaken for a checked one.
 *
 * Drift is fixed with `bun sync-fixtures.ts`, which the failure messages name.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { MIRROR_REF, findMirrorSource, listUpstream, showUpstream } from "./fixture-mirror";

const FIXTURE = join(__dirname, "fixtures", "loggd", ".ralph");
const FIX = "run `bun sync-fixtures.ts` to refresh fixtures/loggd/.ralph";

function walk(dir: string, root = dir): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path, root) : [relative(root, path)];
    })
    .sort();
}

const source = findMirrorSource();

describe("fixtures/loggd/.ralph mirrors felipearos/loggd", () => {
  if (!source.path) {
    it.skip(`skipped — ${source.reason}`, () => {});
    return;
  }
  const loggd = source.path;
  const fixtureFiles = walk(FIXTURE);
  const upstream = listUpstream(loggd);

  it(`reads .ralph/ from ${source.reason}`, () => {
    expect(upstream.status, upstream.stderr).toBe(0);
    expect(upstream.files.length).toBeGreaterThan(0);
  });

  it(`carries exactly the files ${MIRROR_REF} has`, () => {
    expect(fixtureFiles, FIX).toEqual(upstream.files);
  });

  it.each(fixtureFiles)("%s matches origin/main (JSON compared structurally)", (file) => {
    const shown = showUpstream(loggd, file);
    expect(shown.status, `${MIRROR_REF} has no .ralph/${file}; ${FIX}`).toBe(0);
    const ours = readFileSync(join(FIXTURE, file), "utf8");
    if (file.endsWith(".json")) {
      expect(JSON.parse(ours), `${file} drifted; ${FIX}`).toEqual(JSON.parse(shown.stdout));
    } else {
      expect(ours, `${file} drifted; ${FIX}`).toBe(shown.stdout);
    }
  });
});
