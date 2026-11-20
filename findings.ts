#!/usr/bin/env bun
/** Turn a systemic learning into one ordinary fix ticket. GitHub is the registry,
 * backed by a per-host record of what this host filed; the journal publisher's
 * lock serialises filing and linking across local loops. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { HARNESS_FILE, noIssueYet, parseLearnings, SLUG, type LearningEntry } from "./learnings";
import { journalLocation } from "./journal-home";
import { RALPH_HOME, projectRoot } from "./paths";
import { loadProjectConfig } from "./project-config";
import { redact } from "./runner-failure";

export const FINDING_LABEL = "learning-fix";
/** `sourceBranch`: where `file` lives on `sourceRepo` (default `main`; a `journal.branch` otherwise). */
export interface FindingTarget { repo: string; file: string; sourceRepo?: string; sourceBranch?: string }
export type FindingGh = (args: string[]) => string;

export const findingMarker = (target: FindingTarget, slug: string): string =>
  `<!-- ralph-finding-${createHash("sha256").update(`${target.repo}\n${target.file}\n${slug}`).digest("hex")} -->`;

/** Fields inside quoted examples are never instructions to file a ticket. */
export function findingFields(entry: LearningEntry): Record<string, string> {
  const fields: Record<string, string> = {};
  let fence: string | null = null;
  for (const line of entry.body.split("\n")) {
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      if (fence === null) fence = delimiter.slice(0, 3);
      else if (delimiter.startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const match = /^- \*\*(Seen|Workaround|Fix|Change|Verify):\*\*\s*(.+)$/.exec(line);
    if (match) {
      if (fields[match[1]!]) throw new Error(`duplicate ${match[1]} field in ${entry.slug}`);
      fields[match[1]!] = match[2]!.trim();
    }
  }
  return fields;
}

export function pendingFinding(entry: LearningEntry): boolean {
  if (entry.slug === null || !SLUG.test(entry.slug)) return false;
  const fields = findingFields(entry);
  return Boolean(fields.Seen && fields.Workaround && noIssueYet(fields.Fix ?? "") !== null);
}

/**
 * Words in a learning's Change line that mean the fix is harness code.
 *
 * A project-scoped learning's finding is filed as a ticket in the PROJECT's
 * repository, and no project loop can land a change to the harness. On
 * 2026-11-15 a loggd learning whose Change asked for a pr-wait.ts/ralph.sh fix
 * became exactly such a ticket (learning `learning-fix-filed-in-wrong-repo`),
 * so a new entry whose Change names any of these is refused at project scope.
 */
export const HARNESS_CHANGE_MARKERS = ["ralph.sh", "pr-wait.ts", "frontier/", "frontier-gate.ts", "supervisor", "$RALPH_HOME", "${RALPH_HOME}"] as const;

/**
 * A marker as a regex, case-insensitive so a sentence may start with it. Not
 * glued to a longer name on the left — a `/` included, so a project's own
 * `apps/web/frontier/` is not the harness — nor, when it ends in a word, on
 * the right.
 */
const markerPattern = (marker: string): RegExp => {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tail = /\w$/.test(marker) ? "(?![A-Za-z0-9_])" : "";
  return new RegExp(`(?<![A-Za-z0-9_./-])${escaped}${tail}`, "i");
};

/**
 * Why this entry's finding must not be filed in the project's repository, or
 * null when it may.
 *
 * Only a project scope, and only an entry that would file a ticket (its Fix
 * still says no issue yet): a sighting or a revision of an entry whose ticket
 * already exists files nothing, so there is nothing to misroute. The Change
 * line is read the way the finding filer reads it (`findingFields`), since that
 * is the text that becomes the ticket's "What to build". When the project IS
 * the harness its tickets already land in the harness repo; an unknown repo on
 * either side, or an entry the filer could not read, refuses nothing — a
 * missing signal falls back to publishing as before.
 */
export function harnessChangeRefusal(
  entry: LearningEntry,
  options: { scope: "project" | "harness"; projectRepo: string | null; harnessRepo: string | null },
): string | null {
  if (options.scope !== "project") return null;
  if (options.projectRepo === null || options.harnessRepo === null) return null;
  // GitHub owner/repo names are case-insensitive.
  if (options.projectRepo.toLowerCase() === options.harnessRepo.toLowerCase()) return null;
  let change: string | undefined;
  try {
    if (!pendingFinding(entry)) return null;
    change = findingFields(entry).Change;
  } catch {
    return null;
  }
  if (change === undefined) return null;
  const named = HARNESS_CHANGE_MARKERS.filter((marker) => markerPattern(marker).test(change));
  if (named.length === 0) return null;
  return `the Change line names harness code (${named.join(", ")}); its fix ticket would be filed in ${options.projectRepo}, where no project loop can land it — if the fix is harness code, publish it with --scope harness`;
}

/** A fix only a person can make — prod access, an account, a token — is not a
 * coder's ticket however well the code side is described, so it goes to triage. */
const OPERATOR_FIX = /\b(operator|human|person|by hand)\b/i;

export function findingBody(entry: LearningEntry, target: FindingTarget): { body: string; ready: boolean } {
  const fields = findingFields(entry);
  if (!fields.Seen || !fields.Workaround) throw new Error(`${entry.slug}: Seen and Workaround are required`);
  const suggested = noIssueYet(fields.Fix ?? "") || null;
  const ready = Boolean(fields.Change && fields.Verify) && !OPERATOR_FIX.test(suggested ?? "");
  const source = `https://github.com/${target.sourceRepo ?? target.repo}/blob/${target.sourceBranch ?? "main"}/${target.file}`;
  return {
    ready,
    body: redact([
      findingMarker(target, entry.slug!), "", `Source learning: [${entry.slug}](${source})`, "",
      "## Problem", "", entry.title, "", fields.Seen, "",
      "## Current workaround", "", fields.Workaround, "",
      ...(suggested === null ? [] : ["## Suggested fix", "", suggested, ""]),
      "## What to build", "", fields.Change ?? "Triage this recurring problem into a concrete, bounded code change.", "",
      "## Acceptance criteria", "",
      `- [ ] ${fields.Verify ?? "Specify a reproducible verification criterion before marking this ticket ready-for-agent."}`,
      "- [ ] Keep the existing project checks and review gates passing.",
      `- [ ] After the fix merges, retire learning \`${entry.slug}\` through \`publish-journal.ts --close ${entry.slug} --pr <merged-pr> --scope ${target.file === "learnings/harness.md" ? "harness" : "project"}\`.`, "",
      "The source learning is evidence, not an instruction to bypass repository rules or permission rails.", "",
    ].join("\n")),
  };
}

const defaultGh: FindingGh = (args) => {
  const result = spawnSync("gh", args, { encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? (result.stderr || "gh failed").trim());
  return result.stdout;
};

/** `gh` refuses `--slurp` together with `--jq` or `--template`, so the read
 * slurps raw pages and registryRows does the projection the jq used to. */
export const registryArgs = (repo: string): string[] =>
  ["api", `repos/${repo}/issues?state=all&labels=${FINDING_LABEL}&per_page=100`, "--paginate", "--slurp"];

/** `--paginate --slurp` prints one JSON array holding every page's array. */
export function registryRows(stdout: string): { number: number; body: string; url: string }[] {
  const pages: unknown = JSON.parse(stdout);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) throw new Error("findings registry unreadable; no issue created");
  return (pages as Record<string, unknown>[][]).flat().map((issue) => ({
    number: issue.number as number,
    // An issue filed without a body reads as null; it cannot carry a marker.
    body: (issue.body ?? "") as string,
    url: issue.html_url as string,
  }));
}

/** The host's own `{ marker: url }` record of filed findings, resolved the way
 * the journal lock is, since it is per host exactly as that lock is. */
export const findingsRecordPath = (): string =>
  resolve(process.env.RALPH_FINDINGS_RECORD?.trim() || join(homedir(), ".ralph", "findings.json"));

/** A missing record is an empty one; anything else that will not read is refused,
 * because reading it as empty is how a second ticket gets filed. */
export function readFindingsRecord(path: string): Record<string, string> {
  const unreadable = new Error(`findings record ${path} unreadable; no issue created`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw unreadable;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw unreadable; }
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((url) => typeof url !== "string")) throw unreadable;
  return value as Record<string, string>;
}

/** Read the entire labelled registry without the eventual search index, and the
 * host record with it: even that REST list can miss a ticket created seconds
 * ago (#481/#482), so the registry alone cannot prove a finding is unfiled. */
export function promoteFinding(entry: LearningEntry, target: FindingTarget, gh: FindingGh = defaultGh, record: string = findingsRecordPath()): string {
  if (!pendingFinding(entry)) return entry.text;
  if (!/^[\w.-]+\/[\w.-]+$/.test(target.repo)) throw new Error("invalid findings repository");
  const marker = findingMarker(target, entry.slug!);
  const recorded = readFindingsRecord(record);
  const rows = registryRows(gh(registryArgs(target.repo)));
  if (rows.some((row) => !Number.isInteger(row.number) || typeof row.body !== "string" || typeof row.url !== "string")) {
    throw new Error("invalid findings registry; no issue created");
  }
  const matches = rows.filter((row) => row.body.split(/\r?\n/).includes(marker));
  const known = recorded[marker];
  if (matches.length > 1 || (matches[0] !== undefined && known !== undefined && known !== matches[0].url)) {
    throw new Error(`multiple tickets for finding ${entry.slug}; needs triage`);
  }
  const prefix = `https://github.com/${target.repo}/issues/`;
  const valid = (candidate: string): boolean => candidate.startsWith(prefix) && /^\d+$/.test(candidate.slice(prefix.length));
  let url = matches[0]?.url ?? known;
  if (url === undefined) {
    const issue = findingBody(entry, target);
    gh(["label", "create", FINDING_LABEL, "--repo", target.repo, "--color", "1D76DB", "--description", "A recurring learning promoted into a fix ticket", "--force"]);
    const dir = mkdtempSync(join(tmpdir(), "ralph-finding-"));
    try {
      const body = join(dir, "body.md");
      writeFileSync(body, issue.body);
      // A real body file lets the gh attribution hook append its footer once.
      url = gh(["issue", "create", "--repo", target.repo, "--title", redact(`Fix recurring finding: ${entry.title.replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, "")}`),
        "--label", FINDING_LABEL, "--label", issue.ready ? "ready-for-agent" : "needs-triage", "--body-file", body]).trim();
    } finally { rmSync(dir, { recursive: true, force: true }); }
    if (!valid(url)) throw new Error("GitHub returned an unexpected finding URL");
    // Recorded on create, not on push: publishLearning re-runs promote after a
    // rejected push. A failed write must not throw, or the entry stays pending
    // with a ticket already filed, which is the very duplicate this prevents.
    try {
      mkdirSync(dirname(record), { recursive: true });
      const tmp = `${record}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ ...recorded, [marker]: url }, null, 2)}\n`);
      renameSync(tmp, record);
    } catch (error) {
      console.error(`findings record not written: ${record}: ${redact(String(error))}`);
    }
  }
  if (!valid(url)) throw new Error("GitHub returned an unexpected finding URL");
  // Replace only the real field, never a fenced example of it.
  let replaced = false;
  let fence: string | null = null;
  return entry.text.split("\n").map((line) => {
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      if (fence === null) fence = delimiter.slice(0, 3);
      else if (delimiter.startsWith(fence)) fence = null;
      return line;
    }
    if (fence !== null) return line;
    const fix = /^- \*\*Fix:\*\*\s*(.*?)\s*$/.exec(line)?.[1];
    const reason = fix === undefined ? null : noIssueYet(fix);
    if (!replaced && reason !== null) {
      replaced = true;
      // The link leads so the Fix reads as settled; the reason stays, because
      // it is the only place the learning says what the fix would be.
      return reason === "" ? `- **Fix:** ${url}` : `- **Fix:** ${url} — ${reason}`;
    }
    return line;
  }).join("\n");
}

/** A Fix that already names a ticket, a pull request or another entry: filing
 * one more would be the duplicate the registry exists to prevent. */
const SETTLED_FIX = /^(?:https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+|(?:[\w.-]+\/[\w.-]+)?#\d+\b|duplicate\b)/i;

/**
 * The entry as a draft whose Fix is the filer's placeholder, so the publisher
 * files it like any other finding. An operator asking for a ticket overrides
 * what the Fix said about who fixes it, but not what it said: that text stays
 * after the placeholder and becomes the ticket's suggested fix — which is also
 * how an operator's job still lands in triage rather than on a coder.
 */
export function asPending(entry: LearningEntry): string {
  if (entry.slug === null || !SLUG.test(entry.slug)) throw new Error(`${entry.title}: an entry needs a slug before it can be filed`);
  const fields = findingFields(entry);
  if (!fields.Seen || !fields.Workaround) throw new Error(`${entry.slug}: a ticket needs the entry's Seen and Workaround`);
  const fix = fields.Fix;
  if (fix === undefined) return `${entry.text.trimEnd()}\n- **Fix:** no issue yet.`;
  if (noIssueYet(fix) !== null) return entry.text;
  if (SETTLED_FIX.test(fix)) throw new Error(`${entry.slug}: its Fix already reads "${fix.slice(0, 80)}"`);
  let fence: string | null = null;
  let replaced = false;
  return entry.text.split("\n").map((line) => {
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      if (fence === null) fence = delimiter.slice(0, 3);
      else if (delimiter.startsWith(fence)) fence = null;
      return line;
    }
    if (fence !== null || replaced) return line;
    const match = /^- \*\*Fix:\*\*\s*(.*)$/.exec(line);
    if (match === null) return line;
    replaced = true;
    return `- **Fix:** no issue yet — ${match[1]!.trim()}`;
  }).join("\n");
}

const scopeOf = (file: string): "harness" | "project" => (file === HARNESS_FILE ? "harness" : "project");

/** One revised entry through the publisher, which takes its lock, files the
 * finding while it holds it, and pushes. The draft stays on a failure. */
function publishRevision(root: string, home: string, file: string, entry: LearningEntry, text: string, env: NodeJS.ProcessEnv, stdio: "inherit" | "pipe"): void {
  mkdirSync(join(root, ".ralph/logs"), { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const draft = join(root, ".ralph/logs", `learning-draft-${stamp}-${entry.slug}.md`);
  writeFileSync(draft, `${text}\n`);
  const result = spawnSync(process.execPath, [join(RALPH_HOME, "publish-journal.ts"), "--revise", draft, "--scope", scopeOf(file)], {
    cwd: root, env: { ...env, RALPH_PROJECT: root, RALPH_JOURNAL_HOME: home }, encoding: "utf8", stdio, timeout: 240_000,
  });
  // Piped, the publisher's lines go to stderr: stdout is the caller's answer.
  if (stdio === "pipe") process.stderr.write(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  if (result.status !== 0) {
    const why = stdio === "pipe" ? redact(`${result.stderr ?? ""}`.trim().split("\n").at(-1) ?? "") : "";
    throw new Error(`the publisher did not publish the revision${why ? `: ${why}` : ""}; the draft is kept`);
  }
}

/** Where `file` is read: the harness's main, or the project's `journal.branch` for its own file. */
function locate(root: string, home: string, file: string): { repo: string; ref: string; branch: string } {
  const local = journalLocation(root);
  return scopeOf(file) === "project" && local.projectSide
    ? { repo: local.home, ref: local.ref, branch: local.branch }
    : { repo: home, ref: "origin/main", branch: "main" };
}

function openEntries(root: string, home: string, file: string): LearningEntry[] | null {
  const { repo, ref } = locate(root, home, file);
  const shown = spawnSync("git", ["-C", repo, "show", `${ref}:${file}`], { encoding: "utf8", timeout: 15_000 });
  return shown.status === 0 ? parseLearnings(shown.stdout).open : null;
}

/** Reconcile legacy entries too, through the same publisher and its lock.
 * A bounded batch keeps an old backlog from monopolising orientation. */
export function reconcileFindings(root: string, home: string, limit = 3): number {
  if (process.env.RALPH_FINDINGS_DISABLED === "1") return 0;
  const config = loadProjectConfig(root);
  const files = [...new Set([...(config.learnings === false ? [] : [config.learnings.file]), HARNESS_FILE])];
  let harnessRepo: string | null = null;
  try {
    harnessRepo = loadProjectConfig(home).repo;
  } catch {
    // Unknown: harnessChangeRefusal then refuses nothing, as before #815.
  }
  let count = 0;
  for (const file of files) {
    for (const entry of openEntries(root, home, file) ?? []) {
      if (count >= limit) return count;
      try {
        if (!pendingFinding(entry)) continue;
      } catch (error) {
        console.error(`findings: skipped invalid entry ${entry.slug}: ${redact(String(error))}`);
        continue;
      }
      // The publisher would publish it and file nothing (#815), so it stays
      // pending forever: counting it would spend this batch on it every run.
      const refused = scopeOf(file) === "project" && config.tracker.kind === "github"
        ? harnessChangeRefusal(entry, { scope: "project", projectRepo: config.repo, harnessRepo })
        : null;
      if (refused !== null) {
        console.error(`findings: skipped ${entry.slug}: ${refused}`);
        continue;
      }
      try {
        publishRevision(root, home, file, entry, entry.text, process.env, "inherit");
      } catch {
        throw new Error("finding reconciliation failed; the draft is kept");
      }
      count += 1;
    }
  }
  return count;
}

/** What `file` answers: the ticket, or null when the publish landed but
 * GitHub did not take the issue — the entry is then queued for the next
 * reconciliation, which is what the page says. */
export interface FiledFinding { version: 1; slug: string; url: string | null }

/**
 * File one entry now, at an operator's request (the dashboard's File ticket).
 * It goes through the publisher like reconciliation does, so the lock, the
 * registry and the host record keep it to one ticket however often it is
 * asked. `RALPH_FINDINGS_DISABLED` holds the automatic batch, not this: the
 * operator asked for this one by name.
 */
export function fileFinding(root: string, home: string, slug: string, scope: "project" | "harness"): FiledFinding {
  if (!SLUG.test(slug)) throw new Error(`'${slug}' is not a learning slug`);
  let file = HARNESS_FILE;
  if (scope === "project") {
    const learnings = loadProjectConfig(root).learnings;
    if (learnings === false) throw new Error("this project keeps no learnings file");
    file = learnings.file;
  }
  // Best effort: an offline fetch still finds the entry on the last-known ref,
  // and the publisher fetches again before it edits anything.
  const where = locate(root, home, file);
  spawnSync("git", ["-C", where.repo, "fetch", "--quiet", "origin", `+refs/heads/${where.branch}:refs/remotes/origin/${where.branch}`], { timeout: 60_000 });
  const entry = openEntries(root, home, file)?.find((one) => one.slug === slug);
  if (entry === undefined) throw new Error(`no open learning '${slug}' in ${file}`);
  const env = { ...process.env };
  delete env.RALPH_FINDINGS_DISABLED;
  publishRevision(root, home, file, entry, asPending(entry), env, "pipe");
  const after = openEntries(root, home, file)?.find((one) => one.slug === slug);
  const fix = after === undefined ? "" : (findingFields(after).Fix ?? "");
  return { version: 1, slug, url: /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/.exec(fix)?.[0] ?? null };
}

const USAGE = "usage: findings.ts reconcile | findings.ts file <slug> --scope project|harness";

if (import.meta.main) {
  try {
    const [verb, slug, flag, scope] = process.argv.slice(2);
    const home = resolve(process.env.RALPH_JOURNAL_HOME || RALPH_HOME);
    if (verb === "reconcile" && slug === undefined) {
      console.log(`findings: reconciled ${reconcileFindings(projectRoot(), home)} entries`);
    } else if (verb === "file" && slug !== undefined && flag === "--scope" && (scope === "project" || scope === "harness")) {
      console.log(JSON.stringify(fileFinding(projectRoot(), home, slug, scope)));
    } else {
      throw new Error(USAGE);
    }
  } catch (error) { console.error(`findings: ${redact(String(error))}`); process.exitCode = 1; }
}
