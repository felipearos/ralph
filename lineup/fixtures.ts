/**
 * Scratch-checkout fixtures shared by the adapter and HTTP suites.
 *
 * Test infrastructure, not shipped code, but kept out of `*.test.ts` so both
 * suites build the same `models.json` and resolve the same bun without two
 * divergent copies of it. It is deliberately self-contained — the editor is
 * meant to be extractable, so its tests do not reach into the dashboard's
 * fixtures either.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject } from "./contracts";

const scratchRoots: string[] = [];

export function cleanupFixtures(): void {
  scratchRoots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
}

/** The bun running this suite, by absolute path — PATH may be replaced in fixtures. */
export function bunPath(): string {
  try {
    return execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
  } catch {
    return process.execPath;
  }
}

/** One complete five-stage block, valid for the default runner. */
export const block = (): JsonObject => ({
  orchestrator: { runner: "claude", model: "claude-opus-5", effort: "medium" },
  executor: { runner: "claude", model: "claude-sonnet-5" },
  mapper: { runner: "claude", model: "sonnet" },
  review: {
    standards: { runner: "claude", model: "opus" },
    spec: { runner: "claude", model: "opus" },
  },
});

/** A baseline config with commentary keys, plus any named loops a test adds. */
export const config = (extra: JsonObject = {}): JsonObject => ({
  $comment: ["commentary, not a loop"],
  default: block(),
  $comment_loops: ["why the named loops differ"],
  ...extra,
});

/** A scratch checkout root holding a `models.json`, as an absolute path. */
export function rootWith(contents: string = JSON.stringify(config(), null, 2) + "\n"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ralph-lineup-root-")));
  scratchRoots.push(root);
  writeFileSync(join(root, "models.json"), contents);
  return root;
}
