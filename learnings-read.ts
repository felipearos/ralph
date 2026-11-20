#!/usr/bin/env bun
/**
 * What a loop reads at orientation: the open learnings for this project and for
 * the harness, out of the harness repository's `origin/main`.
 *
 *     bun "$RALPH_HOME/learnings-read.ts" show
 *
 * `origin/main` and not a working tree, for the reason §0 of the prompt already
 * gives about the journal: every loop on the machine publishes there, so it is
 * the only ref that holds what the OTHER loops learned. A harness checkout can
 * sit on a feature branch for hours, and the lesson that would have saved this
 * iteration is quite possibly an hour old and somebody else's.
 *
 * Two files, always in the same order: the project's own, then the harness's.
 * `learnings/README.md` owns that split — a lesson about one project's CI,
 * tests or host against a lesson about Ralph itself.
 *
 * A missing file is not an error. It means a project has learned nothing yet,
 * which is the normal state of a new project, and refusing to orient over it
 * would make the first iteration on every project a failure.
 *
 * This is the one half of the learnings path that must never write. The other
 * half goes through `publish-journal.ts`, behind the journal lock, because
 * these files are shared and appended rather than one-file-per-iteration.
 */
import { execFileSync } from "node:child_process";

import { DEFAULT_CAP_BYTES, HARNESS_FILE, renderOpen } from "./learnings";
import { journalLocation } from "./journal-home";
import { RALPH_HOME, projectRoot } from "./paths";
import { loadProjectConfig } from "./project-config";

/** How long a `git show` may take before it counts as no file. */
const COMMAND_TIMEOUT_MS = 15_000;

/**
 * Whether the harness's `origin/main` can be read at all.
 *
 * The distinction this draws is the whole point of asking: `git show` exits
 * non-zero both for "that file is not on the ref" and for "this checkout is
 * unreadable", and the prompt declares these entries BINDING while a loop
 * diagnoses a failure. Telling a loop with a broken harness that nothing has
 * been learned would send it off to re-diagnose from scratch — the exact
 * failure the learnings path exists to end. A resolvable `origin/main` is the
 * proof that git and the repository work, so a file still missing after it
 * really is absent. (`dashboard/adapter.ts` draws the same line with the
 * remote URL.)
 */
function refIsReadable(home: string, ref: string): boolean {
  try {
    execFileSync("git", ["-C", home, "rev-parse", "--verify", "--quiet", ref], {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/** One file's worth of open learnings. */
export interface LearningsSource {
  /** `project` or `harness`: the scope a writer would publish to. */
  scope: "project" | "harness";
  /** The path inside the harness repository. */
  file: string;
  /** The rendered open entries, or `""` when the file is missing or has none. */
  open: string;
  /** False when `git show` could not produce the file at all. */
  present: boolean;
  /** False when the harness's `origin/main` could not be resolved: absence is then unknown. */
  readable: boolean;
}

/** The file's text on `ref`, or null when it is not there. */
function showOn(home: string, ref: string, file: string): string | null {
  try {
    return execFileSync("git", ["-C", home, "show", `${ref}:${file}`], {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** The byte budget per file. One knob, so both files are capped alike. */
export function capBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = env.RALPH_LEARNINGS_CAP_BYTES?.trim() ?? "";
  if (raw === "") return DEFAULT_CAP_BYTES;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_CAP_BYTES;
}

/**
 * The project's learnings path: the env the supervisor exported, else the
 * config. Null when the project opted out.
 *
 * The env first because `ralph.sh` already evaluated the config once per run
 * and a loop's worktree may not be the project `loadProjectConfig` would find;
 * an EMPTY `RALPH_LEARNINGS_FILE` is the export of `"learnings": false`, and so
 * means opted out rather than unset.
 */
export function projectFile(
  root: string = projectRoot(),
  env: Record<string, string | undefined> = process.env,
): string | "opted-out" | "unreadable" {
  const exported = env.RALPH_LEARNINGS_FILE;
  if (exported !== undefined) return exported.trim() === "" ? "opted-out" : exported.trim();
  try {
    const config = loadProjectConfig(root);
    return config.learnings === false ? "opted-out" : config.learnings.file;
  } catch {
    // Three states, not two: the publisher refuses a project learning on this
    // answer, and telling an operator they "opted out" when their config is
    // malformed sends them to look at a key that may not be there.
    return "unreadable";
  }
}

/** Both files' open entries, project first, capped. Never throws. */
export function readLearnings(
  root: string = projectRoot(),
  home: string = RALPH_HOME,
  env: Record<string, string | undefined> = process.env,
): LearningsSource[] {
  const cap = capBytes(env);
  const sources: LearningsSource[] = [];
  const project = projectFile(root, env);
  // The project file follows `journal.branch` to the project's own repository;
  // the harness file never moves.
  const local = journalLocation(root, env);
  for (const [scope, file] of [
    ["project", project],
    ["harness", HARNESS_FILE],
  ] as const) {
    // Both non-paths mean "no project file to read": the publisher is the one
    // that has to tell them apart, because it refuses on them.
    if (file === "opted-out" || file === "unreadable") continue;
    const { repo, ref } =
      scope === "project" && local.projectSide ? { repo: local.home, ref: local.ref } : { repo: home, ref: "origin/main" };
    // A project branch nobody has published to yet has no ref at all, and that
    // is "nothing learned", not an unreadable repository: the repository
    // itself answering is the proof there.
    const readable = refIsReadable(repo, ref === "origin/main" ? ref : "HEAD");
    const text = showOn(repo, ref, file);
    sources.push({
      scope,
      file,
      open: text === null ? "" : renderOpen(text, { capBytes: cap }),
      present: text !== null,
      readable,
    });
  }
  return sources;
}

/**
 * The block the prompt prints.
 *
 * Headed per file so a loop can tell a project lesson from a harness one
 * without opening anything — that distinction is what tells it whether the fix
 * belongs in the repository it is working in.
 */
export function renderLearnings(sources: readonly LearningsSource[]): string {
  if (sources.length === 0) return "No learnings are configured for this project.\n";
  const blocks: string[] = [];
  for (const source of sources) {
    const heading = `=== open learnings (${source.scope}): ${source.file}`;
    if (!source.present) {
      blocks.push(
        source.readable
          ? `${heading}\n(not published yet — nothing learned so far)`
          : `${heading}\n(the harness checkout could not be read — treat this list as UNKNOWN, not empty)`,
      );
      continue;
    }
    blocks.push(source.open === "" ? `${heading}\n(no open entries)` : `${heading}\n${source.open}`);
  }
  return `${blocks.join("\n\n")}\n`;
}

/**
 * The harness checkout to read from. `RALPH_LEARNINGS_HOME` overrides it the
 * way `RALPH_JOURNAL_HOME` overrides the publisher's, so a test can point both
 * halves of the path at a fixture repository instead of the live harness.
 */
function learningsHome(env: Record<string, string | undefined> = process.env): string {
  const override = env.RALPH_LEARNINGS_HOME?.trim() ?? "";
  return override === "" ? RALPH_HOME : override;
}

export function main(args: string[]): number {
  const command = args[0] ?? "";
  if (command !== "show") {
    process.stderr.write("usage: learnings-read.ts show\n");
    return 2;
  }
  process.stdout.write(renderLearnings(readLearnings(projectRoot(), learningsHome())));
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
