/**
 * The command surface of Unblock & resume (#255): the only code above the
 * process boundary that names the `gh` writes a handback makes and the
 * journal publisher it runs.
 *
 * A sibling of `lifecycle-adapter.ts`, and for the same reason: the tests
 * drive the whole handback against fakes and this file is where the argv is
 * pinned. It owns the executor too, behind `guarded()`, so the sequence in
 * `chat-handback.ts` asks for one operation and reads an answer: an executor
 * that rejects reads as that step's failure, never as a rejected handback.
 *
 * What it changes, all of it on the ticket the chat is about or in the
 * harness's journal:
 *
 * - `gh issue comment` — the `### Operator decision` comment;
 * - `gh issue edit --remove-label` — `<loop>-blocked`, and only after
 *   `gh issue view` showed it there (`gh` errors removing a label that is not);
 * - `publish-journal.ts --draft` — the journal entry, through the publisher
 *   every loop uses, behind its machine-wide lock.
 *
 * And the one file it writes: the journal DRAFT, in the loop's own
 * `.ralph/logs/`, where the publisher requires a draft to be and deletes it
 * once published. The loop's worktree is otherwise never written.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { defaultBunPath, isRecord } from "./adapter";
import type { Env } from "./contracts";
import { guarded, type ExecResult, type Executor, type Invocation } from "./control-adapter";

/** The handback's command surface — a closed list, asserted by `read-only.test.ts`. */
export const HANDBACK_SURFACE = {
  gh: {
    command: "gh",
    /** Read the ticket's comments (for the marker) and labels (for the block). */
    view: ["issue", "view"],
    fields: "comments,labels",
    comment: ["issue", "comment"],
    unlabel: ["issue", "edit"],
  },
  /**
   * The same three, on a project whose tickets live in Linear or Jira (#339):
   * the project's tracker through `tracker.ts`, the comment on stdin.
   */
  tracker: {
    script: "tracker.ts",
    view: ["view"],
    comment: ["comment"],
    unlabel: ["label", "remove"],
  },
  publish: { script: "publish-journal.ts" },
  /** Where the publisher requires a draft to be: directly in the project's logs. */
  drafts: join(".ralph", "logs"),
} as const;

/**
 * The publisher's own variables, and the ones it must not inherit.
 *
 * `home` is passed EXPLICITLY. Unset, `publish-journal.ts` publishes into the
 * checkout its own file sits in, and a dashboard run from a worktree of the
 * harness would then refuse: the shared `~/.ralph/journal-wt` is a worktree
 * of `~/ralph`, not of that checkout. `adapter.ts` reads the journal from
 * the same `journalHome`, so what is published is what the panel shows.
 *
 * `inherited` are dropped from the dashboard's environment: a dashboard
 * started inside a loop's shell would otherwise hand the publisher that
 * loop's journal directory and display name, or `RALPH_JOURNAL_LOCKED=1`,
 * which skips the machine-wide lock outright.
 */
export const PUBLISH_ENV = {
  home: "RALPH_JOURNAL_HOME",
  project: "RALPH_PROJECT",
  loop: "RALPH_LOOP_NAME",
  inherited: ["RALPH_JOURNAL_LOCKED", "RALPH_JOURNAL_DIR", "RALPH_PROJECT_DISPLAY_NAME", "RALPH_RUN_ID", "RALPH_SESSION_ID"],
} as const;

/** What `gh issue view` said about the ticket, narrowed to what a handback reads. */
export interface IssueRead {
  labels: string[];
  comments: string[];
}

/** A write's answer: done, or why not, in the words the handback marks the step with. */
export type HandbackWrite = { ok: true } | { ok: false; why: string };

export interface HandbackAdapter {
  /** The loop's worktree: where `gh` resolves the repository and the draft is written. */
  readonly worktree: string;
  /** The ticket's labels and comment bodies, or why they could not be read. */
  readIssue(ticket: number): Promise<IssueRead | { problem: string }>;
  comment(ticket: number, body: string): Promise<HandbackWrite>;
  unlabel(ticket: number, label: string): Promise<HandbackWrite>;
  /** Write the journal draft into the loop's logs; returns its path. Throws on a failed write. */
  writeDraft(name: string, content: string): string;
  /** Publish the draft; `said` is the publisher's last line, which the journal step is marked with. */
  publish(draft: string, issue: number | null): Promise<{ ok: true; said: string } | { ok: false; why: string }>;
}

export interface HandbackAdapterConfig {
  /** The harness checkout, `$RALPH_HOME`: where `publish-journal.ts` is. */
  cliDir: string;
  /** The harness repository the journal is published into. Defaults to `cliDir`. */
  journalHome?: string;
  /** The loop's worktree. */
  root: string;
  loop: string;
  bunPath?: string;
  env?: Env;
  /** Runs every command; wrapped in `guarded()`, so a throw reads as that step's failure. */
  exec: Executor;
}

const firstLine = (text: string): string => text.trim().split("\n")[0]?.trim() ?? "";

/**
 * Whether the worktree's committed config names a Linear or Jira tracker. Read
 * as a file, like the adapter's base branch, because the dashboard runs no
 * harness code to answer it; an unreadable config is a GitHub project.
 */
export function keyedTracker(worktree: string): boolean {
  try {
    const config = JSON.parse(readFileSync(join(worktree, ".ralph", "config.json"), "utf8")) as { tracker?: { kind?: unknown } };
    const kind = config.tracker?.kind;
    return kind === "linear" || kind === "jira" || kind === "local";
  } catch {
    return false;
  }
}

/** Narrow `gh issue view --json comments,labels`, or `tracker.ts view --json`, whose labels are bare names. */
export function parseIssue(result: ExecResult): IssueRead | { problem: string } {
  if (result.status !== 0) {
    return { problem: `gh issue view failed: ${firstLine(result.stderr) || firstLine(result.stdout) || String(result.status)}` };
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return { problem: "gh issue view did not return JSON" };
  }
  if (!isRecord(value) || !Array.isArray(value.labels) || !Array.isArray(value.comments)) {
    return { problem: "gh issue view returned no labels or comments" };
  }
  return {
    labels: value.labels.flatMap((label) =>
      typeof label === "string" ? [label] : isRecord(label) && typeof label.name === "string" ? [label.name] : [],
    ),
    comments: value.comments.flatMap((comment) => (isRecord(comment) && typeof comment.body === "string" ? [comment.body] : [])),
  };
}

/** Why a write failed: its last line of output, or its exit status when it said nothing. */
const failureOf = (what: string, result: ExecResult): string => {
  const said = (result.stderr.trim() || result.stdout.trim()).split("\n").at(-1)?.trim() ?? "";
  return `${what} failed${said === "" ? ` (exit ${String(result.status)})` : `: ${said}`}`;
};

const written = (what: string, result: ExecResult): HandbackWrite =>
  result.status === 0 ? { ok: true } : { ok: false, why: failureOf(what, result) };

/** Build the handback adapter over one loop's worktree. */
export function createHandbackAdapter(config: HandbackAdapterConfig): HandbackAdapter {
  const cliDir = resolve(config.cliDir);
  const worktree = resolve(config.root);
  const journalHome = resolve(config.journalHome ?? cliDir);
  const bunPath = config.bunPath ?? defaultBunPath();
  const baseEnv: Env = { ...process.env, ...config.env };
  const surface = HANDBACK_SURFACE;

  // `gh` never prompts: a dashboard request has no terminal to answer on.
  const ghEnv: Env = { ...baseEnv, GH_PROMPT_DISABLED: "1" };
  const gh = (args: readonly string[]): Invocation => ({ command: surface.gh.command, args: [...args], cwd: worktree, env: ghEnv });

  const publishEnv = (): Env => {
    const env: Env = { ...baseEnv };
    for (const name of PUBLISH_ENV.inherited) delete env[name];
    env[PUBLISH_ENV.home] = journalHome;
    env[PUBLISH_ENV.project] = worktree;
    env[PUBLISH_ENV.loop] = config.loop;
    return env;
  };

  // A Linear or Jira ticket is read and written through the project's tracker.
  const keyed = keyedTracker(worktree);
  const tracker = (args: readonly string[], input?: string): Invocation => ({
    command: bunPath,
    args: [join(cliDir, surface.tracker.script), ...args],
    cwd: worktree,
    env: { ...baseEnv, RALPH_PROJECT: worktree },
    ...(input === undefined ? {} : { input }),
  });

  const run = guarded(config.exec);

  return {
    worktree,
    readIssue: async (ticket) =>
      parseIssue(
        await run(
          keyed ? tracker([...surface.tracker.view, String(ticket), "--json"]) : gh([...surface.gh.view, String(ticket), "--json", surface.gh.fields]),
        ),
      ),
    // `--body=` in one argument: a value is never read as a flag, whatever it starts with.
    comment: async (ticket, body) =>
      written(
        `commenting on #${ticket}`,
        await run(
          keyed ? tracker([...surface.tracker.comment, String(ticket), "--body-file", "-"], body) : gh([...surface.gh.comment, String(ticket), `--body=${body}`]),
        ),
      ),
    unlabel: async (ticket, label) =>
      written(
        `removing ${label} from #${ticket}`,
        await run(keyed ? tracker([...surface.tracker.unlabel, String(ticket), label]) : gh([...surface.gh.unlabel, String(ticket), `--remove-label=${label}`])),
      ),
    writeDraft: (name, content) => {
      const dir = join(worktree, surface.drafts);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, name);
      writeFileSync(path, content);
      return path;
    },
    publish: async (draft, issue) => {
      const published = await run({
        command: bunPath,
        args: [join(cliDir, surface.publish.script), "--draft", draft, "--issue", issue === null ? "none" : String(issue)],
        cwd: worktree,
        env: publishEnv(),
      });
      if (published.status !== 0) return { ok: false, why: failureOf("publishing the journal entry", published) };
      return { ok: true, said: published.stdout.trim().split("\n").at(-1)?.trim() || "journal published" };
    },
  };
}
