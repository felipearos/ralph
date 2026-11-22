/**
 * The name guard: refuses a `git push` that would publish a name this host
 * keeps private — a client, a channel id, a personal address.
 *
 * This repository is public, and the loops push to it unattended (their
 * branches, and the journal straight to `main`). House rule 5 keeps clients
 * out of the harness, but a rule is only read; this is the check. The list
 * of names cannot live in the repository — it would publish them — so it is
 * a file on the host: `~/.config/ralph/name-guard` (or `RALPH_NAME_GUARD`),
 * one case-insensitive regular expression per line, `#` for comments.
 *
 * What a push is scanned for: every commit it would add to the remote, by
 * its author and committer, its message, the paths it adds, and every line
 * it adds. Removed lines are not scanned: deleting a name is the fix.
 * "Already on the remote" means reachable from this clone's remote-tracking
 * refs for it, so a clone that kept a branch the remote has since rewritten
 * should `git fetch --prune` before it pushes.
 *
 * The guard fails closed. A host that installed the hook but has no list (or
 * an unreadable one) refuses every push and says why: a guard that silently
 * passes is worse than none, since it reads as safe.
 *
 *   bun name-guard.ts --install            # pre-push hook in this clone
 *   bun name-guard.ts --pre-push <remote>  # what the hook runs (refs on stdin)
 *   bun name-guard.ts --scan <rev-range>   # check commits by hand
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const DEFAULT_LIST = join(homedir(), ".config", "ralph", "name-guard");
const ZERO = /^0+$/;
const HOOK_MARK = "# installed by ralph name-guard.ts";

export interface Hit {
  commit: string;
  where: string;
  pattern: string;
}

/** The list file's patterns; throws on a pattern that is not a regex. */
export function parsePatterns(text: string): RegExp[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => new RegExp(line, "i"));
}

/** The first pattern `text` matches, or null. */
export function matchOf(text: string, patterns: RegExp[]): RegExp | null {
  return patterns.find((p) => p.test(text)) ?? null;
}

/**
 * The scannable lines of one commit's patch: added lines and the paths it
 * writes to. Removed lines, context and the `a/` side of a header are not.
 */
export function addedLines(patch: string): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  let file = "";
  let line = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "");
      if (file !== "/dev/null") out.push({ where: file, text: file });
      continue;
    }
    if (raw.startsWith("rename to ") || raw.startsWith("copy to ")) {
      file = raw.replace(/^(rename|copy) to /, "");
      out.push({ where: file, text: file });
      continue;
    }
    const hunk = /^@@ -\S+ \+(\d+)/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+")) {
      out.push({ where: `${file}:${line}`, text: raw.slice(1) });
      line += 1;
    }
  }
  return out;
}

type Git = (args: string[]) => { ok: boolean; stdout: string; stderr: string };

function gitIn(cwd: string): Git {
  return (args) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
    return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

/** Every hit in the given commits. */
export function scanCommits(git: Git, commits: string[], patterns: RegExp[]): Hit[] {
  const hits: Hit[] = [];
  for (const commit of commits) {
    const meta = git(["log", "-1", "--format=%an%n%ae%n%cn%n%ce%n%B", commit]);
    if (!meta.ok) throw new Error(`git log ${commit}: ${meta.stderr.trim()}`);
    const [an, ae, cn, ce, ...message] = meta.stdout.split("\n");
    const fields: [string, string][] = [
      ["author", `${an} <${ae}>`],
      ["committer", `${cn} <${ce}>`],
      ...message.map((text, i): [string, string] => [`message:${i + 1}`, text]),
    ];
    for (const [where, text] of fields) {
      const p = matchOf(text, patterns);
      if (p) hits.push({ commit, where, pattern: p.source });
    }
    const patch = git(["diff-tree", "-p", "-M", "--unified=0", "--no-color", "--no-commit-id", "--root", commit]);
    if (!patch.ok) throw new Error(`git diff-tree ${commit}: ${patch.stderr.trim()}`);
    for (const { where, text } of addedLines(patch.stdout)) {
      const p = matchOf(text, patterns);
      if (p) hits.push({ commit, where, pattern: p.source });
    }
  }
  return hits;
}

/**
 * The commits one pre-push ref line would add to `remote`: none for a
 * deletion; for an update whose old tip is known here, `old..new` minus
 * whatever a ref of that remote already holds; otherwise (a new branch, or a
 * remote tip never fetched) everything not already on a ref of that remote.
 */
export function commitsToPush(git: Git, remote: string, refLine: string): string[] {
  const [, localSha, , remoteSha] = refLine.trim().split(/\s+/);
  if (!localSha || ZERO.test(localSha)) return [];
  let range = ["rev-list", localSha, "--not", `--remotes=${remote}`];
  if (remoteSha && !ZERO.test(remoteSha) && git(["cat-file", "-e", `${remoteSha}^{commit}`]).ok) {
    // A branch rebased onto the remote's main carries main's commits in
    // old..new; they are already public, so rescanning them would refuse the
    // force-push for a name this push does not publish. `^old` sits before
    // `--not`, which flips every ref after it.
    range = ["rev-list", localSha, `^${remoteSha}`, "--not", `--remotes=${remote}`];
  }
  const r = git(range);
  if (!r.ok) throw new Error(`git ${range.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout.split("\n").filter(Boolean);
}

export function loadList(path: string): RegExp[] {
  if (!existsSync(path)) throw new Error(`no name list at ${path} (set RALPH_NAME_GUARD, or create it)`);
  const patterns = parsePatterns(readFileSync(path, "utf8"));
  if (patterns.length === 0) throw new Error(`the name list at ${path} is empty`);
  return patterns;
}

export function report(hits: Hit[]): string {
  const lines = hits.slice(0, 40).map((h) => `  ${h.commit.slice(0, 10)} ${h.where}  (matches /${h.pattern}/)`);
  if (hits.length > 40) lines.push(`  … and ${hits.length - 40} more`);
  return [
    "name-guard: push refused — it would publish a name this host keeps private:",
    ...lines,
    "Rewrite those commits without the name (house rule 5 in AGENTS.md), then push again.",
  ].join("\n");
}

/** The hook script, pointing at this file through an absolute bun. */
export function hookScript(guard: string, bun: string): string {
  return ["#!/bin/sh", HOOK_MARK, `exec ${JSON.stringify(bun)} ${JSON.stringify(guard)} --pre-push "$@"`, ""].join("\n");
}

function install(cwd: string): string {
  const git = gitIn(cwd);
  const common = git(["rev-parse", "--git-common-dir"]);
  if (!common.ok) throw new Error(`not a git repository: ${cwd}`);
  const dir = isAbsolute(common.stdout.trim()) ? common.stdout.trim() : resolve(cwd, common.stdout.trim());
  const hooksPath = git(["config", "--get", "core.hooksPath"]).stdout.trim();
  if (hooksPath) throw new Error(`core.hooksPath is set (${hooksPath}); install the hook there by hand`);
  const hook = join(dir, "hooks", "pre-push");
  if (existsSync(hook) && !readFileSync(hook, "utf8").includes(HOOK_MARK)) {
    throw new Error(`${hook} exists and is not ours; merge it by hand`);
  }
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, hookScript(join(import.meta.dir, "name-guard.ts"), process.execPath));
  chmodSync(hook, 0o755);
  return hook;
}

function main(argv: string[]): number {
  const [mode, arg] = argv;
  const cwd = process.cwd();
  try {
    if (mode === "--install") {
      // The list first: a hook installed without one refuses every push
      // from this clone, which is a broken host, not a guarded one.
      loadList(process.env.RALPH_NAME_GUARD || DEFAULT_LIST);
      const hook = install(cwd);
      console.log(`name-guard: installed ${hook}`);
      return 0;
    }
    if (mode !== "--pre-push" && mode !== "--scan") {
      console.error("usage: bun name-guard.ts --install | --pre-push <remote> | --scan <rev-range>");
      return 2;
    }
    const patterns = loadList(process.env.RALPH_NAME_GUARD || DEFAULT_LIST);
    const git = gitIn(cwd);
    let commits: string[];
    if (mode === "--scan") {
      const r = git(["rev-list", arg ?? "HEAD"]);
      if (!r.ok) throw new Error(r.stderr.trim());
      commits = r.stdout.split("\n").filter(Boolean);
    } else {
      const stdin = readFileSync(0, "utf8");
      commits = [...new Set(stdin.split("\n").filter((l) => l.trim()).flatMap((l) => commitsToPush(git, arg ?? "origin", l)))];
    }
    const hits = scanCommits(git, commits, patterns);
    if (hits.length > 0) {
      console.error(report(hits));
      return 1;
    }
    return 0;
  } catch (error) {
    console.error(`name-guard: push refused — ${(error as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
