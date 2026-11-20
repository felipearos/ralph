// @vitest-environment node
/**
 * The line between the loop and its plugins, pinned.
 *
 * The loop runs, is controlled and reports its state with no plugin at all,
 * and it stays that way only if nothing in the core comes to lean on one. So
 * every core source file — everything tracked outside `plugins/`, tests aside
 * — is read here and held to three rules:
 *
 * 1. it does not import or run plugin code: the host reaches a plugin only as
 *    a subprocess, by directory name;
 * 2. it names no Orca verb, and runs no `orca`;
 * 3. it does not name Orca at all, beyond the one record path kept so a hold
 *    taken before the split still holds after it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = __dirname;

const coreSources = (): string[] =>
  execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((path) => /\.(ts|tsx|sh|py)$/.test(path))
    .filter((path) => !path.startsWith("plugins/") && !path.startsWith("node_modules/"))
    .filter((path) => !path.endsWith(".test.ts") && path !== "test-git-env.setup.ts");

/** Every line of every core source matching `pattern`, as `path:line: text`. */
function offending(pattern: RegExp, allowed: (path: string, line: string) => boolean = () => false): string[] {
  const hits: string[] = [];
  for (const path of coreSources()) {
    let text: string;
    try {
      text = readFileSync(join(ROOT, path), "utf8");
    } catch {
      continue;
    }
    text.split("\n").forEach((line, index) => {
      if (pattern.test(line) && !allowed(path, line)) hits.push(`${path}:${index + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

describe("the core", () => {
  it("is actually being read", () => {
    const sources = coreSources();
    for (const expected of ["ralph.sh", "controls.ts", "plugins.ts", "control-inbox.ts", "loop-state.ts", "dashboard/dispatch.ts"]) {
      expect(sources).toContain(expected);
    }
  });

  it("imports no plugin code and names no plugin's files", () => {
    expect(
      offending(
        /(from\s+["'][^"']*plugins\/|import\(\s*["'][^"']*plugins\/|require\(\s*["'][^"']*plugins\/|plugins\/[a-z][a-z0-9-]*\/[\w.-]+\.(ts|sh|py)\b)/,
      ),
    ).toEqual([]);
  });

  it("names no Orca verb and runs no orca", () => {
    expect(
      offending(
        /\borchestration\s+(check|run-[a-z]+|task-[a-z]+|dispatch|send|reply|gate-[a-z]+|worker-[a-z]+)\b|\binvokeOrca\b|\borca\s+(orchestration|terminal|serve|open)\b|RALPH_ORCA_/,
      ),
    ).toEqual([]);
  });

  it("does not name Orca at all, beyond the old control record's path", () => {
    // One path, not a verb: the old control record, kept so a hold taken
    // before the split still holds.
    const legacy = (path: string, line: string): boolean =>
      path === "controls.ts" && line.includes('LEGACY_CONTROL_STATE_RELATIVE_PATH = ".ralph/logs/orca-controls.json"');
    expect(offending(/orca/i, legacy)).toEqual([]);
  });
});
