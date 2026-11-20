/**
 * `fixtures/loggd/.ralph` is a hand-maintained copy of the real `.ralph/` in
 * felipearos/loggd. Copies drift: one withhold-list change already needed a
 * paired edit in both repositories. These helpers find a loggd checkout and
 * read `.ralph/` from its `origin/main`, so a test can prove the mirror is
 * current and a script can refresh it.
 *
 * The source checkout is `RALPH_MIRROR_SOURCE` when set, else `~/loggd`; either
 * must have an `origin` remote pointing at felipearos/loggd. `origin/main` is
 * compared rather than the working tree so the answer does not depend on which
 * branch that checkout happens to have out.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MIRROR_REF = "origin/main";
export const MIRROR_DIR = ".ralph";
const LOGGD_REMOTE = /github\.com[/:]felipearos\/loggd(?:\.git)?$/;

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, ...args: string[]): GitResult {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A loggd checkout to mirror from, or `undefined` with the reason none was usable. */
export function findMirrorSource(env: NodeJS.ProcessEnv = process.env): { path?: string; reason: string } {
  const candidates = [env.RALPH_MIRROR_SOURCE, join(homedir(), "loggd")].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  const tried: string[] = [];
  for (const candidate of candidates) {
    if (!existsSync(join(candidate, ".git"))) {
      tried.push(`${candidate}: not a git checkout`);
      continue;
    }
    const url = git(candidate, "remote", "get-url", "origin");
    if (url.status !== 0 || !LOGGD_REMOTE.test(url.stdout.trim())) {
      tried.push(`${candidate}: origin is not felipearos/loggd`);
      continue;
    }
    return { path: candidate, reason: `${candidate} (${MIRROR_REF})` };
  }
  return { reason: `no loggd checkout: ${tried.join("; ") || "set RALPH_MIRROR_SOURCE or clone to ~/loggd"}` };
}

/** Paths under `.ralph/` on `origin/main`, relative to `.ralph/`, sorted. */
export function listUpstream(loggd: string): GitResult & { files: string[] } {
  const result = git(loggd, "ls-tree", "-r", "--name-only", MIRROR_REF, `${MIRROR_DIR}/`);
  const files =
    result.status === 0
      ? result.stdout
          .split("\n")
          .filter(Boolean)
          .map((path) => path.slice(MIRROR_DIR.length + 1))
          .sort()
      : [];
  return { ...result, files };
}

/** The content of one `.ralph/<relative>` file on `origin/main`. */
export function showUpstream(loggd: string, relative: string): GitResult {
  return git(loggd, "show", `${MIRROR_REF}:${MIRROR_DIR}/${relative}`);
}
