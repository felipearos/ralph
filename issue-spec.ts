#!/usr/bin/env bun
/**
 * The issue a spec-axis review reads, fetched by the harness.
 *
 * The spec reviewer is read-only and has no `gh` — on every runner, and by
 * design (inspector.md). Loop #1154 (2026-09-23) showed what that costs when
 * nothing else hands it the ticket: "I couldn't read the spec directly because
 * `gh` is outside my rails, so I reviewed against the Agent Brief as your brief
 * paraphrases it." A review against the orchestrator's summary of an issue
 * checks the change against the orchestrator, and misses exactly the criteria
 * the summary dropped.
 *
 * So the orchestrator, which already runs `gh`, fetches the issue here and
 * names the file in the spec brief, and the reviewer reads a file inside the
 * checkout — which every runner can. That is chosen over opening a narrow
 * `gh issue view` to the reviewer: the rail stays whole (no credential, no
 * network, one fewer command to allow-list on three harnesses), the review is
 * reproducible from `.ralph/logs`, and a missing spec is caught before any model
 * is paid for rather than discovered in its report.
 *
 *   fetch <n> [--repo owner/name]
 *       `gh issue view` → `.ralph/logs/spec-<n>.md` (body, labels, every
 *       comment in order), then prints that path. Always a fresh copy: a
 *       re-review must see the comments added since the last one.
 *   attach <brief-file>
 *       Prints every harness-fetched spec the brief names, for `inspect.sh` to
 *       put in front of an external reviewer. Refuses a brief that names none,
 *       names a file that is not there, or names one this script did not write
 *       — a hand-written `spec-<n>.md` is the paraphrase again.
 *
 * Exit codes:
 *   0   done
 *   3   attach: no usable spec in the brief (inspect.sh passes this through as
 *       its own "bad call" — the brief is wrong whoever runs the stage)
 *   5   fetch: gh could not read the issue, or answered about another one
 *  64   usage
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { projectRoot } from './paths';
import { keyedProjectTracker } from './tracker/project';
import type { Tracker } from './tracker/types';

export const EXIT = {
  ok: 0,
  nospec: 3,
  unreadable: 5,
  usage: 64,
} as const;

/** The first line of every spec this script writes; `attach` checks for it. */
export const SPEC_MARKER = '<!-- ralph:issue-spec — fetched by the harness from GitHub; do not edit -->';

export const SPEC_DIR = '.ralph/logs';

const FIELDS = 'number,title,url,state,labels,body,comments';

export interface IssueComment {
  author: { login: string } | null;
  createdAt: string;
  body: string;
}

export interface Issue {
  number: number;
  /** How the tracker spells it, `AND-184`; `#<number>` when absent. */
  ref?: string;
  title: string;
  url: string;
  state: string;
  labels: { name: string }[];
  body: string;
  comments: IssueComment[];
}

/** The issue as `gh issue view --json` returned it, or null when it is not one. */
export function parseIssue(raw: string): Issue | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const issue = data as Record<string, unknown>;
  if (typeof issue.number !== 'number' || typeof issue.title !== 'string') return null;
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  const comments = Array.isArray(issue.comments) ? issue.comments : [];
  return {
    number: issue.number,
    title: issue.title,
    url: typeof issue.url === 'string' ? issue.url : '',
    state: typeof issue.state === 'string' ? issue.state : '',
    body: typeof issue.body === 'string' ? issue.body : '',
    labels: labels
      .map((label) => (label as Record<string, unknown>)?.name)
      .filter((name): name is string => typeof name === 'string')
      .map((name) => ({ name })),
    comments: comments.map((comment) => {
      const c = (comment ?? {}) as Record<string, unknown>;
      const author = c.author as Record<string, unknown> | null | undefined;
      return {
        author: typeof author?.login === 'string' ? { login: author.login } : null,
        createdAt: typeof c.createdAt === 'string' ? c.createdAt : '',
        body: typeof c.body === 'string' ? c.body : '',
      };
    }),
  };
}

/**
 * The spec file's text. The body and the comments go in verbatim: a reviewer
 * checking acceptance criteria needs the checkboxes as written, and the
 * comments are where scope gets changed after the issue was filed.
 */
export function renderSpec(issue: Issue, fetchedAt: string): string {
  const labels = issue.labels.map((label) => label.name).join(', ') || '(none)';
  const lines = [
    SPEC_MARKER,
    '',
    `# ${issue.ref ?? `#${issue.number}`} — ${issue.title}`,
    '',
    `- URL: ${issue.url}`,
    `- State: ${issue.state}`,
    `- Labels: ${labels}`,
    `- Fetched: ${fetchedAt}`,
    '',
    '## Body',
    '',
    issue.body.trim() === '' ? '(The issue has no body.)' : issue.body.trim(),
    '',
    `## Comments (${issue.comments.length})`,
    '',
  ];
  if (issue.comments.length === 0) lines.push('(No comments.)', '');
  issue.comments.forEach((comment, index) => {
    const who = comment.author ? `@${comment.author.login}` : '(unknown author)';
    lines.push(`### ${index + 1}. ${who}${comment.createdAt ? ` — ${comment.createdAt}` : ''}`, '');
    lines.push(comment.body.trim() === '' ? '(empty)' : comment.body.trim(), '');
  });
  return lines.join('\n');
}

/**
 * Every `spec-<n>.md` path a brief names, once each, in order. Loose about how
 * the brief writes it — backticks, bold, a trailing full stop — because the
 * brief is prose a model wrote; strict about the file itself, in `attach`.
 */
export function specPathsIn(brief: string): string[] {
  const found = brief.match(/[^\s`'"()<>*]*spec-\d+\.md/g) ?? [];
  return [...new Set(found)];
}

export type Fetched = { ok: true; issue: Issue } | { ok: false; error: string };

export function fetchIssue(number: string, repo: string | null): Fetched {
  const args = ['issue', 'view', number, '--json', FIELDS];
  if (repo !== null) args.push('--repo', repo);
  const result = spawnSync('gh', args, { encoding: 'utf8', timeout: 60_000 });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || `gh exited ${result.status}`).trim() };
  }
  const issue = parseIssue(result.stdout);
  if (issue === null) return { ok: false, error: `unparseable gh output: ${result.stdout.trim().slice(0, 200)}` };
  if (String(issue.number) !== number) {
    return { ok: false, error: `asked for #${number}, gh answered about #${issue.number}` };
  }
  return { ok: true, issue };
}

/**
 * The issue from a Linear or Jira project's tracker (#334), in the shape the
 * GitHub read gives, so the spec file is the same whatever holds the ticket.
 */
export async function fetchFromTracker(tracker: Tracker, number: number): Promise<Fetched> {
  try {
    const issue = await tracker.issue(number);
    return {
      ok: true,
      issue: {
        number: issue.number,
        ref: tracker.ref(issue.number),
        title: issue.title,
        url: issue.url,
        state: issue.status === '' ? issue.state.toUpperCase() : `${issue.state.toUpperCase()} (${issue.status})`,
        labels: issue.labels.map((name) => ({ name })),
        body: issue.body,
        comments: issue.comments.map((comment) => ({
          author: comment.author ? { login: comment.author } : null,
          createdAt: comment.createdAt ?? '',
          body: comment.body,
        })),
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const USAGE = [
  'usage: issue-spec.ts fetch <issue> [--repo owner/name]',
  '       issue-spec.ts attach <brief-file>',
].join('\n');

async function fetchCommand(argv: string[]): Promise<number> {
  let number: string | null = null;
  let repo: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--repo') {
      const value = argv[i + 1];
      if (value === undefined) return usage('--repo needs owner/name');
      repo = value;
      i += 1;
    } else if (arg.startsWith('-')) {
      return usage(`unknown flag ${arg}`);
    } else if (number !== null) {
      return usage(`one issue at a time, got ${number} and ${arg}`);
    } else {
      // `#1154` and a Linear or Jira key (`AND-184`) both name the number.
      number = arg.replace(/^#/, '').replace(/^[A-Z][A-Z0-9_]*-(?=\d+$)/, '');
    }
  }
  if (number === null || !/^\d+$/.test(number)) return usage('which issue? pass its number');

  // GitHub keeps its `gh issue view`; Linear and Jira read through the tracker.
  let tracker: Tracker | null;
  try {
    tracker = keyedProjectTracker(projectRoot());
  } catch (error) {
    console.error(`issue-spec: cannot read issue ${number}: ${error instanceof Error ? error.message : String(error)}`);
    console.error('issue-spec: no spec was written — the spec axis cannot run without it.');
    return EXIT.unreadable;
  }
  const fetched = tracker === null ? fetchIssue(number, repo) : await fetchFromTracker(tracker, Number(number));
  if (!fetched.ok) {
    console.error(`issue-spec: cannot read issue #${number}: ${fetched.error}`);
    console.error('issue-spec: no spec was written — the spec axis cannot run without it.');
    return EXIT.unreadable;
  }
  mkdirSync(SPEC_DIR, { recursive: true });
  const path = join(SPEC_DIR, `spec-${number}.md`);
  // Through a temporary name, so a reviewer already reading the old copy never
  // sees half of the new one.
  const partial = `${path}.${process.pid}.tmp`;
  writeFileSync(partial, renderSpec(fetched.issue, new Date().toISOString()));
  renameSync(partial, path);
  console.log(path);
  return EXIT.ok;
}

function attachCommand(argv: string[]): number {
  if (argv.length !== 1) return usage('attach takes exactly one brief file');
  const briefPath = argv[0]!;
  let brief: string;
  try {
    brief = readFileSync(briefPath, 'utf8');
  } catch (error) {
    console.error(`issue-spec: cannot read the brief ${briefPath}: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.nospec;
  }
  const fix =
    'issue-spec: run `bun "$RALPH_HOME/issue-spec.ts" fetch <n>` and name the path it prints in the brief ' +
    '(`Spec: .ralph/logs/spec-<n>.md`). Never paraphrase the issue in its place.';
  const paths = specPathsIn(brief);
  if (paths.length === 0) {
    console.error(`issue-spec: the spec-axis brief ${briefPath} names no fetched issue.`);
    console.error(fix);
    return EXIT.nospec;
  }
  const sections: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) {
      console.error(`issue-spec: the brief names ${path}, which does not exist.`);
      console.error(fix);
      return EXIT.nospec;
    }
    const text = readFileSync(path, 'utf8');
    if (!text.startsWith(SPEC_MARKER)) {
      console.error(`issue-spec: ${path} was not written by issue-spec.ts fetch — it is not the issue as GitHub has it.`);
      console.error(fix);
      return EXIT.nospec;
    }
    sections.push(`<!-- ${path} -->\n${text.trimEnd()}`);
  }
  console.log(sections.join('\n\n'));
  return EXIT.ok;
}

function usage(problem: string): number {
  console.error(`issue-spec: ${problem}\n${USAGE}`);
  return EXIT.usage;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'fetch':
      return fetchCommand(rest);
    case 'attach':
      return attachCommand(rest);
    default:
      return usage(command === undefined ? 'which command?' : `unknown command ${command}`);
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
