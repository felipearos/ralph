/**
 * A prompt overlay (#801): a directory of replacement harness prompt files,
 * laid over a trial's staged copy of the harness so one arm can run with a
 * changed `coder.md` or `prompt.md` without anything being deployed.
 *
 * Only prompt files may be replaced. An overlay that could swap `ralph.sh` or
 * a permission rail would be testing a different harness, not a different
 * prompt, and would run unreviewed code inside the trial.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/** The harness files an overlay may replace: the prompts `models.ts` renders. */
const PROMPT_FILE = /^(?:prompt|coder|inspector)\.md$|^prompts\/[\w.-]+\.md$/;

/** Whether a harness-relative path is a prompt an overlay may replace; the improver's proposals are held to it too (#873). */
export function isPromptFile(path: string): boolean {
  return PROMPT_FILE.test(path);
}

export interface Overlay {
  dir: string;
  /** Paths relative to the overlay, sorted. */
  files: string[];
  /** sha256 over every path and its content: two arms with the same hash ran the same prompts. */
  hash: string;
}

function walk(dir: string, root: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = relative(root, path);
    if (entry.isSymbolicLink()) throw new Error(`prompt overlay: ${rel} is a symlink; copy the file in`);
    if (entry.isDirectory()) walk(path, root, out);
    else out.push(rel);
  }
}

/** The overlay's files, validated. Throws, naming the file, on anything that is not a prompt. */
export function readOverlay(dir: string): Overlay {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) throw new Error(`prompt overlay: no overlay directory at ${dir}`);
  const files: string[] = [];
  walk(dir, dir, files);
  files.sort();
  for (const file of files) {
    if (!isPromptFile(file)) throw new Error(`prompt overlay: ${file} is not a prompt file (prompt.md, coder.md, inspector.md or prompts/*.md)`);
  }
  if (files.length === 0) throw new Error(`prompt overlay: ${dir} replaces no prompt file`);
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file}\0`).update(readFileSync(join(dir, file))).update("\0");
  return { dir, files, hash: hash.digest("hex") };
}

/** Lay the overlay over a staged harness. Every file must already be there: a misspelt one would never be read. */
export function applyOverlay(dir: string, harness: string): Overlay {
  const overlay = readOverlay(dir);
  for (const file of overlay.files) {
    if (!existsSync(join(harness, file))) throw new Error(`prompt overlay: ${file} is not in the harness, so nothing would read it`);
  }
  for (const file of overlay.files) copyFileSync(join(dir, file), join(harness, file));
  return overlay;
}
