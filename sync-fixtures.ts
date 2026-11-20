#!/usr/bin/env bun
/**
 * Refresh `fixtures/loggd/.ralph` from a loggd checkout's `origin/main`, the
 * one-command fix `fixture-mirror.test.ts` names when the mirror has drifted.
 *
 *   bun sync-fixtures.ts                       # ~/loggd
 *   RALPH_MIRROR_SOURCE=/path/to/loggd bun sync-fixtures.ts
 *
 * Writes upstream bytes verbatim, creates missing files, deletes fixture files
 * that `origin/main` no longer has, and prints each change. Does not fetch:
 * run `git fetch origin` in the checkout first if its `origin/main` is stale.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { findMirrorSource, listUpstream, showUpstream } from "./fixture-mirror";

const FIXTURE = join(import.meta.dirname, "fixtures", "loggd", ".ralph");

function walk(dir: string, root = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path, root) : [relative(root, path)];
  });
}

const source = findMirrorSource();
if (!source.path) {
  console.error(source.reason);
  process.exit(1);
}
const upstream = listUpstream(source.path);
if (upstream.status !== 0 || upstream.files.length === 0) {
  console.error(upstream.stderr.trim() || "origin/main has no .ralph/ files");
  process.exit(1);
}

let changed = 0;
for (const file of upstream.files) {
  const shown = showUpstream(source.path, file);
  if (shown.status !== 0) {
    console.error(`could not read .ralph/${file}: ${shown.stderr.trim()}`);
    process.exit(1);
  }
  const target = join(FIXTURE, file);
  const current = existsSync(target) ? readFileSync(target, "utf8") : undefined;
  if (current === shown.stdout) continue;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, shown.stdout);
  console.log(`${current === undefined ? "created" : "updated"} ${relative(process.cwd(), target)}`);
  changed += 1;
}
for (const file of walk(FIXTURE)) {
  if (upstream.files.includes(file)) continue;
  rmSync(join(FIXTURE, file));
  console.log(`removed ${relative(process.cwd(), join(FIXTURE, file))}`);
  changed += 1;
}
console.log(changed === 0 ? `fixture already matches ${source.reason}` : `${changed} file(s) synced from ${source.reason}`);
