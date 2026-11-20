/**
 * Local review — run an app repo's own Revisión Claude review with no PR (#529).
 *
 * The review an app repo runs on every pull request lives in its
 * `.github/workflows/revision-claude.yml`: the prompt, the model flags, the
 * tool list, the settings, the UI check and the install step. Reading them out
 * of that file, rather than keeping a copy here, means a local run reviews
 * exactly the way the repo's CI does, and follows the workflow when it changes.
 *
 * The parsing part is pure — text in, spec out (see `parseYaml` for the one
 * exception under Node). `runLocalReview` then runs that spec against
 * `base...head` in a throwaway worktree. Neither throws, because a loop that
 * asks for a local review overnight must get a reason it can log, not a crash.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

export type ReviewVars = {
  /** `owner/name`, for `${{ github.repository }}`. */
  repo: string;
  /** A label standing in for the PR number, e.g. `local`. */
  pr: string;
  /** The base branch, for `${{ github.event.pull_request.base.ref }}`. */
  base: string;
  /** `"si"` or `"no"`, for `${{ steps.ui.outputs.playwright }}`. */
  playwright: string;
  /** Where the run can be found, for the workflow's run-url expression. */
  runUrl: string;
};

export type ReviewSpec = {
  prompt: string;
  /** `with.claude_args`, tokenized, without `--allowedTools` and its value. */
  claudeArgs: string[];
  allowedTools: string[];
  settings: Record<string, unknown> | null;
  env: Record<string, string>;
  timeoutMinutes: number | null;
  uiPattern: string;
  uiPatternSource: "workflow" | "default";
  installCommand: string | null;
  installSource: "workflow" | "default";
  playwrightSpecDir: string;
  screenshotDir: string;
  /** Raw text of every `${{ }}` expression the prompt used that vars do not cover. */
  unresolved: string[];
};

export type ParseResult = { ok: true; spec: ReviewSpec } | { ok: false; reason: string };

export const DEFAULT_UI_PATTERN = "^src/.*\\.(tsx?|css)$";
export const DEFAULT_INSTALL_COMMAND = "npm ci && npx playwright install chromium-headless-shell";
export const DEFAULT_PLAYWRIGHT_SPEC_DIR = "tests/e2e/_revision-claude";
export const DEFAULT_SCREENSHOT_DIR = "tests/e2e/_revision-claude/capturas";

// Under Bun (the CLI) the parser is in-process. Under vitest, which runs on
// Node, there is no `Bun` global and no YAML dependency to fall back on, so the
// text goes through a `bun` child that parses it and answers in JSON.
export function parseYaml(text: string): unknown {
  const bun = (globalThis as { Bun?: { YAML: { parse(input: string): unknown } } }).Bun;
  if (bun) return bun.YAML.parse(text);
  const child = spawnSync(
    "bun",
    ["-e", "process.stdout.write(JSON.stringify(Bun.YAML.parse(await Bun.stdin.text())) ?? 'null')"],
    { input: text, encoding: "utf8", timeout: 30_000 },
  );
  if (child.error) throw child.error;
  if (child.status !== 0) {
    // Bun prints the eval'd source around the error; the error line is the reason.
    const line = child.stderr.split("\n").find((l) => /Error/.test(l));
    throw new Error(line?.trim() || `bun exited ${child.status}`);
  }
  return JSON.parse(child.stdout);
}

const CLAUDE_ACTION = "anthropics/claude-code-action@";

type Step = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The steps of the job that holds the claude step: the UI check and the
// install that feed it live beside it, not in some other job.
function claudeJobSteps(doc: Record<string, unknown>): { steps: Step[]; claude: Step } | null {
  if (!isObject(doc.jobs)) return null;
  for (const job of Object.values(doc.jobs)) {
    if (!isObject(job) || !Array.isArray(job.steps)) continue;
    const steps = job.steps.filter(isObject);
    const claude = steps.find((s) => typeof s.uses === "string" && s.uses.startsWith(CLAUDE_ACTION));
    if (claude) return { steps, claude };
  }
  return null;
}

const EXPRESSION = /\$\{\{\s*([^}]*?)\s*\}\}/g;
const RUN_URL =
  /\$\{\{\s*github\.server_url\s*\}\}\/\$\{\{\s*github\.repository\s*\}\}\/actions\/runs\/\$\{\{\s*github\.run_id\s*\}\}/g;

function substitute(text: string, vars: ReviewVars, unresolved: string[]): string {
  const known: Record<string, string> = {
    "github.repository": vars.repo,
    "github.event.pull_request.number": vars.pr,
    "github.event.pull_request.base.ref": vars.base,
    "steps.ui.outputs.playwright": vars.playwright,
  };
  // The run url first: its parts would otherwise be resolved one by one into a
  // half-empty url.
  return text.replace(RUN_URL, () => vars.runUrl).replace(EXPRESSION, (raw, expr: string) => {
    const value = known[expr];
    if (value !== undefined && Object.hasOwn(known, expr)) return value;
    if (!unresolved.includes(raw)) unresolved.push(raw);
    return "";
  });
}

/** Shell-style split: double and single quotes, any whitespace between words. */
export function tokenizeArgs(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && (text[i + 1] === '"' || text[i + 1] === "\\")) current += text.charAt(++i);
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) tokens.push(current);
      current = "";
      inToken = false;
    } else if (ch === "\\" && i + 1 < text.length) {
      current += text.charAt(++i);
      inToken = true;
    } else {
      current += ch;
      inToken = true;
    }
  }
  if (inToken) tokens.push(current);
  return tokens;
}

// Commas inside `Bash(gh pr diff:*)`-style parentheses belong to the entry.
function splitTools(value: string): string[] {
  const tools: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      tools.push(current);
      current = "";
    } else current += ch;
  }
  tools.push(current);
  return tools.map((t) => t.trim()).filter((t) => t !== "");
}

function recordExpressions(text: string, unresolved: string[]): void {
  for (const match of text.matchAll(EXPRESSION)) if (!unresolved.includes(match[0])) unresolved.push(match[0]);
  if (!text.match(EXPRESSION) && !unresolved.includes(text)) unresolved.push(text);
}

// `--model ${{ vars.M }}` loses both words: the flag alone would take the next
// argument as its value.
function withoutExpressions(args: string[], unresolved: string[]): string[] {
  const kept: string[] = [];
  for (const arg of args) {
    if (!arg.includes("${{")) {
      kept.push(arg);
      continue;
    }
    recordExpressions(arg, unresolved);
    const previous = kept.at(-1);
    if (!arg.startsWith("-") && previous !== undefined && previous.startsWith("-") && !previous.includes("=")) kept.pop();
  }
  return kept;
}

function extractAllowedTools(args: string[]): { claudeArgs: string[]; allowedTools: string[] } {
  const claudeArgs: string[] = [];
  const allowedTools: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const eq = /^--(?:allowedTools|allowed-tools)=(.*)$/s.exec(arg);
    if (eq) {
      allowedTools.push(...splitTools(eq[1] ?? ""));
    } else if (arg === "--allowedTools" || arg === "--allowed-tools") {
      if (i + 1 < args.length) allowedTools.push(...splitTools(args[++i] ?? ""));
    } else claudeArgs.push(arg);
  }
  return { claudeArgs, allowedTools };
}

function uiPatternFrom(steps: Step[]): string | null {
  const ui = steps.find((s) => s.id === "ui");
  if (!ui || typeof ui.run !== "string") return null;
  const match = /grep\s+-q?E\s+'([^']*)'/.exec(ui.run);
  return match?.[1] ?? null;
}

function installFrom(steps: Step[]): string | null {
  const step =
    steps.find((s) => s.id === "dependencias" && typeof s.run === "string") ??
    steps.find((s) => typeof s.run === "string" && s.run.includes("npm ci"));
  if (!step) return null;
  // Locally `--with-deps` runs `sudo apt-get`, which waits on a password
  // prompt nobody will answer overnight.
  return (step.run as string).replace(/[ \t]*--with-deps\b/g, "").trim();
}

function screenshotDirFrom(steps: Step[]): string {
  for (const step of steps) {
    if (!isObject(step.with) || typeof step.with.path !== "string") continue;
    const path = step.with.path.trim().replace(/\/+$/, "");
    if (/_revision-claude.*capturas/.test(path)) return path;
  }
  return DEFAULT_SCREENSHOT_DIR;
}

export function parseReviewWorkflow(text: string, vars: ReviewVars): ParseResult {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (error) {
    return { ok: false, reason: `workflow is not valid YAML: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isObject(doc)) return { ok: false, reason: "workflow is not a YAML mapping" };
  const found = claudeJobSteps(doc);
  if (!found) return { ok: false, reason: "workflow has no anthropics/claude-code-action step" };
  const { steps, claude } = found;
  const withBlock = isObject(claude.with) ? claude.with : {};
  if (typeof withBlock.prompt !== "string") {
    return { ok: false, reason: "the anthropics/claude-code-action step has no string with.prompt" };
  }

  let settings: Record<string, unknown> | null = null;
  if (withBlock.settings !== undefined) {
    if (typeof withBlock.settings !== "string") {
      return { ok: false, reason: "the claude step's with.settings is not a JSON string" };
    }
    try {
      const parsed: unknown = JSON.parse(withBlock.settings);
      if (!isObject(parsed)) return { ok: false, reason: "the claude step's with.settings is not a JSON object" };
      settings = parsed;
    } catch (error) {
      return {
        ok: false,
        reason: `the claude step's with.settings is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const unresolved: string[] = [];
  const prompt = substitute(withBlock.prompt, vars, unresolved);
  // Each expression becomes one space-free placeholder first, so the tokenizer
  // cannot split `${{ vars.M }}` into three words.
  const expressions: string[] = [];
  const argsText = typeof withBlock.claude_args === "string" ? withBlock.claude_args : "";
  const masked = argsText.replace(EXPRESSION, (raw) => `\uE000${expressions.push(raw) - 1}\uE000`);
  const unmask = (token: string) => token.replace(/\uE000(\d+)\uE000/g, (_, i: string) => expressions[Number(i)] ?? "");
  const extracted = extractAllowedTools(tokenizeArgs(masked).map(unmask));
  const allowedTools = extracted.allowedTools;
  const claudeArgs = withoutExpressions(extracted.claudeArgs, unresolved);

  // An expression is a CI secret or variable that does not exist here; passed
  // as literal text it would shadow the host's real value (an API key, say).
  const env: Record<string, string> = {};
  if (isObject(claude.env)) {
    for (const [key, value] of Object.entries(claude.env)) {
      const text = String(value);
      if (text.includes("${{")) recordExpressions(text, unresolved);
      else env[key] = text;
    }
  }
  const timeout = claude["timeout-minutes"];
  const timeoutMinutes = typeof timeout === "number" && Number.isFinite(timeout) ? timeout : null;

  const uiPattern = uiPatternFrom(steps);
  const installCommand = installFrom(steps);

  return {
    ok: true,
    spec: {
      prompt,
      claudeArgs,
      allowedTools,
      settings,
      env,
      timeoutMinutes,
      uiPattern: uiPattern ?? DEFAULT_UI_PATTERN,
      uiPatternSource: uiPattern === null ? "default" : "workflow",
      installCommand: installCommand ?? DEFAULT_INSTALL_COMMAND,
      installSource: installCommand === null ? "default" : "workflow",
      playwrightSpecDir: DEFAULT_PLAYWRIGHT_SPEC_DIR,
      screenshotDir: screenshotDirFrom(steps),
      unresolved,
    },
  };
}

/** True when any changed path is one the workflow's UI check would run Playwright for. */
export function matchesUi(paths: string[], pattern: string): boolean {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    // An unreadable pattern errs toward running Playwright, as the workflow
    // does when it cannot list the PR's files.
    return paths.length > 0;
  }
  return paths.some((p) => re.test(p));
}

// ---------------------------------------------------------------------------
// Running the review locally.

export const WORKFLOW_PATH = ".github/workflows/revision-claude.yml";
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_MINUTES = 30;
/** setTimeout clamps anything over 2^31-1 ms to 1 ms; a day is far below that. */
export const MAX_TIMEOUT_MINUTES = 24 * 60;

export type Priority = "P1" | "P2" | "P3";

export type Finding = { priority: Priority; path: string; line: number | null; title: string; text: string };

export type LocalReviewResult =
  | {
      status: "ok";
      base: string;
      head: string;
      findings: Finding[];
      screenshots: string[];
      playwright: "ran" | "skipped" | "degraded";
      playwrightNote: string | null;
      workflow: { path: string; ref: string };
      costUsd: number | null;
      durationMs: number | null;
    }
  | { status: "unavailable"; reason: string; base: string | null; head: string | null };

export type LocalReviewOptions = {
  /** The app repo checkout; it is only read, never changed. */
  checkout: string;
  base: string;
  /** Defaults to `HEAD`. */
  head?: string;
  /** Where screenshots go; a fresh tmp dir when absent. */
  out?: string;
  /** `owner/name`; derived from `origin` when absent. */
  repo?: string;
  timeoutMinutes?: number;
  /** The environment the review starts from; `process.env` when absent. */
  env?: NodeJS.ProcessEnv;
  /** Progress lines; silent when absent. */
  log?: (line: string) => void;
  /**
   * The workflow to take the prompt from, as a file, instead of the one at
   * `base`. A backtest replays a base older than the workflow itself, and asks
   * how today's review judges it, so it hands in the live checkout's copy.
   */
  workflowFile?: string;
};

export const LOCAL_MODE_HEADING = "## Local mode (no PR)";

/**
 * Appended after the workflow's prompt, which assumes a PR, `gh` and the
 * inline-comment tool. Locally none of them exist, so this says what stands in
 * for each, and asks for the findings as JSON the caller can parse.
 */
export function localModeAddendum(baseSha: string, headSha: string, diffPath: string): string {
  return `

${LOCAL_MODE_HEADING}

The instructions above were written for a pull request on GitHub. This run is local: there is no PR and no GitHub, and neither \`gh\` nor \`git\` is available as a tool.

- The working directory is the head tree (${headSha}), NOT merged with the base.
- Wherever the instructions say \`gh pr diff\`, read ${diffPath} with the Read tool instead: it holds \`git diff ${baseSha}...${headSha}\`.
- There are no existing review comments; skip any step that reads or answers them.
- Do not use the inline-comment tool and do not try to post anything. Instead, end your answer with exactly one fenced \`\`\`json block holding \`{"findings":[{"priority":"P1","path":"src/x.ts","line":12,"title":"…","text":"…"}]}\` — one entry per finding you would have commented inline, with the same P1–P3 rules; \`line\` is the head-tree line or null; use \`{"findings":[]}\` if there are none.
- Keep writing in the language the instructions above ask for.
`;
}

/**
 * The workflow's tools minus anything that reaches GitHub. Nothing is added:
 * even read-only git takes \`--output=<file>`, a write the workflow never allowed.
 */
export function localAllowedTools(tools: string[]): string[] {
  return tools.filter((t) => !t.startsWith("mcp__") && !/^Bash\(\s*gh(?:[\s:)]|$)/.test(t));
}

function git(cwd: string, args: string[], timeoutMs = 60_000): { ok: boolean; stdout: string; stderr: string } {
  const child = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: timeoutMs });
  return { ok: !child.error && child.status === 0, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
}

/** `owner/name` out of any GitHub-style remote url. */
export function repoFromRemote(url: string): string | null {
  const match = /[/:]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

// What a signal on the CLI must undo: the review's process groups, and the
// worktree it runs in. Module state, so `runLocalReview` itself installs no
// process-wide handler; the CLI does, and calls `abortLocalReviews`.
const liveGroups = new Set<number>();
const pendingCleanups = new Set<() => void>();

/** Kill every running review child group and remove its worktree, synchronously. */
export function abortLocalReviews(): void {
  for (const pid of liveGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  liveGroups.clear();
  for (const cleanup of pendingCleanups) cleanup();
  pendingCleanups.clear();
}

type RunResult = { code: number | null; stdout: string; timedOut: boolean; error: string | null };

// Async, so a half-hour review does not block the caller, and in its own
// process group, so a timeout reaches whatever the review started too.
function run(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((done) => {
    let stdout = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const pid = child.pid;
    if (pid !== undefined) liveGroups.add(pid);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, opts.timeoutMs);
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pid !== undefined) liveGroups.delete(pid);
      done(result);
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    // Drained so a chatty child never blocks on a full pipe.
    child.stderr.resume();
    child.on("error", (error) => finish({ code: null, stdout, timedOut, error: error.message }));
    child.on("close", (code) => finish({ code, stdout, timedOut, error: null }));
  });
}

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

function invalidFinding(entry: unknown): string | null {
  if (!isObject(entry)) return "not an object";
  if (entry.priority !== "P1" && entry.priority !== "P2" && entry.priority !== "P3") return "priority is not P1–P3";
  if (typeof entry.path !== "string" || entry.path.trim() === "") return "path is empty";
  if (entry.line !== undefined && entry.line !== null && !Number.isInteger(entry.line)) {
    return "line is neither an integer nor null";
  }
  if (typeof entry.title !== "string") return "title is not a string";
  if (typeof entry.text !== "string") return "text is not a string";
  return null;
}

/** The findings out of the last ```json block of the review's answer, validated whole. */
export function parseFindings(answer: string): Parsed<Finding[]> {
  const opener = [...answer.matchAll(/```json[ \t]*\r?\n/g)].at(-1);
  if (opener === undefined) return { ok: false, reason: "review answered with no findings block" };
  // A finding's text may hold a fenced snippet of its own, so the first closing
  // fence is not necessarily the block's: the block ends at the first one that
  // leaves valid JSON before it.
  const start = (opener.index ?? 0) + opener[0].length;
  let doc: unknown;
  let parsed = false;
  for (let close = answer.indexOf("```", start); close !== -1 && !parsed; close = answer.indexOf("```", close + 3)) {
    try {
      doc = JSON.parse(answer.slice(start, close));
      parsed = true;
    } catch {
      // Not this fence; try the next.
    }
  }
  if (!parsed) return { ok: false, reason: "review's findings block is not valid JSON" };
  if (!isObject(doc) || !Array.isArray(doc.findings)) {
    return { ok: false, reason: "review's findings block has no findings array" };
  }
  const findings: Finding[] = [];
  for (const [i, entry] of doc.findings.entries()) {
    const why = invalidFinding(entry);
    if (why) return { ok: false, reason: `review's finding #${i + 1} is invalid: ${why}` };
    const e = entry as Finding;
    findings.push({ priority: e.priority, path: e.path, line: e.line ?? null, title: e.title, text: e.text });
  }
  return { ok: true, value: findings };
}

type ClaudeOutput = { result: string; costUsd: number | null; durationMs: number | null };

export function parseClaudeOutput(stdout: string): Parsed<ClaudeOutput> {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: "review printed output that is not JSON" };
  }
  // Some claude versions print the whole event list; the result is its last entry.
  if (Array.isArray(doc)) doc = [...(doc as unknown[])].reverse().find((e) => isObject(e) && e.type === "result");
  if (!isObject(doc)) return { ok: false, reason: "review printed no result object" };
  if (doc.is_error === true) {
    const detail = typeof doc.result === "string" && doc.result ? `: ${doc.result.slice(0, 200)}` : "";
    return { ok: false, reason: `review ended in error${detail}` };
  }
  if (typeof doc.result !== "string") return { ok: false, reason: "review printed no result text" };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return { ok: true, value: { result: doc.result, costUsd: num(doc.total_cost_usd), durationMs: num(doc.duration_ms) } };
}

function pngsUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...pngsUnder(path));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".png")) found.push(path);
  }
  return found;
}

// Ahead of the real one on PATH: whatever the model tries, nothing is posted.
const GH_SHIM = `#!/bin/sh
echo "gh is disabled in a local review: nothing may be posted (gh $*)" >&2
exit 1
`;

export async function runLocalReview(opts: LocalReviewOptions): Promise<LocalReviewResult> {
  const log = opts.log ?? (() => {});
  const checkout = resolve(opts.checkout);
  const headRef = opts.head ?? "HEAD";
  const revParse = (ref: string) => {
    const r = git(checkout, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return r.ok ? r.stdout.trim() : null;
  };
  const base = revParse(opts.base);
  if (!base) return { status: "unavailable", reason: `base ${opts.base} is not a commit in ${checkout}`, base: null, head: null };
  const head = revParse(headRef);
  if (!head) return { status: "unavailable", reason: `head ${headRef} is not a commit in ${checkout}`, base, head: null };
  const unavailable = (reason: string): LocalReviewResult => ({ status: "unavailable", reason, base, head });

  // At the base, as CI does: a change cannot rewrite the review it is judged
  // by. A caller's file stands in for it, and is never one the head can edit.
  let workflowText: string;
  let workflowRef: string;
  if (opts.workflowFile !== undefined) {
    try {
      workflowText = readFileSync(resolve(opts.workflowFile), "utf8");
    } catch (error) {
      return unavailable(`cannot read the workflow file ${opts.workflowFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
    workflowRef = `file:${resolve(opts.workflowFile)}`;
  } else {
    const shown = git(checkout, ["show", `${base}:${WORKFLOW_PATH}`]);
    if (!shown.ok) return unavailable(`no ${WORKFLOW_PATH} at ${opts.base}`);
    workflowText = shown.stdout;
    workflowRef = base;
  }

  const diff = git(checkout, ["diff", "--name-only", `${base}...${head}`]);
  if (!diff.ok) return unavailable(`git diff ${base}...${head} failed: ${diff.stderr.trim()}`);
  const paths = diff.stdout.split("\n").filter((p) => p !== "");

  let out: string;
  try {
    out = opts.out ? resolve(opts.out) : mkdtempSync(join(tmpdir(), "local-review-"));
    mkdirSync(out, { recursive: true });
  } catch (error) {
    return unavailable(`cannot create the out dir: ${error instanceof Error ? error.message : String(error)}`);
  }
  log(`local review: out dir ${out}`);

  let repo = opts.repo;
  if (!repo) {
    const remote = git(checkout, ["remote", "get-url", "origin"]);
    repo = (remote.ok && repoFromRemote(remote.stdout)) || "local/repo";
  }
  const vars: ReviewVars = { repo, pr: "local", base: opts.base, playwright: "si", runUrl: `file://${out}` };
  // Parsed once for the UI pattern and install command, and again below once
  // `playwright` is known, so the prompt says what the workflow's would.
  const first = parseReviewWorkflow(workflowText, vars);
  if (!first.ok) return unavailable(first.reason);
  vars.playwright = matchesUi(paths, first.spec.uiPattern) ? "si" : "no";

  let work: string;
  try {
    work = mkdtempSync(join(tmpdir(), "local-review-work-"));
  } catch (error) {
    return unavailable(`cannot create a work dir: ${error instanceof Error ? error.message : String(error)}`);
  }
  const worktree = join(work, "tree");
  // Remove before rm (a forced remove of a big tree can take minutes), and
  // prune last, once the directory is gone for sure.
  const cleanup = () => {
    git(checkout, ["worktree", "remove", "--force", worktree], 5 * 60_000);
    rmSync(work, { recursive: true, force: true });
    git(checkout, ["worktree", "prune"]);
  };
  pendingCleanups.add(cleanup);
  try {
    const added = git(checkout, ["worktree", "add", "--detach", worktree, head]);
    if (!added.ok) return unavailable(`git worktree add failed: ${added.stderr.trim()}`);

    // Outside the worktree, so the review reads the diff without being handed
    // git, whose `--output=<file>` writes anywhere.
    const diffPath = join(work, "review.diff");
    const patch = git(checkout, ["diff", `--output=${diffPath}`, `${base}...${head}`]);
    if (!patch.ok) return unavailable(`git diff ${base}...${head} failed: ${patch.stderr.trim()}`);

    // The install and the review get the same fence: no GitHub token, and a gh
    // that refuses everything first on PATH. CI=true as on every GitHub step,
    // so an app's Playwright config never reuses another worktree's dev server.
    const binDir = join(work, "bin");
    mkdirSync(binDir);
    writeFileSync(join(binDir, "gh"), GH_SHIM);
    chmodSync(join(binDir, "gh"), 0o755);
    const baseEnv: NodeJS.ProcessEnv = { ...(opts.env ?? process.env), CI: "true" };
    delete baseEnv.GH_TOKEN;
    delete baseEnv.GITHUB_TOKEN;
    baseEnv.PATH = baseEnv.PATH ? `${binDir}:${baseEnv.PATH}` : binDir;

    let playwright: "ran" | "skipped" | "degraded";
    let playwrightNote: string | null = null;
    if (vars.playwright === "si") {
      log("local review: installing dependencies for Playwright");
      // GitHub runs a `run:` block with `bash -e`; the command may be several lines.
      const install = await run("bash", ["-e", "-o", "pipefail", "-c", first.spec.installCommand ?? DEFAULT_INSTALL_COMMAND], {
        cwd: worktree,
        env: baseEnv,
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
      if (install.code === 0 && !install.timedOut) playwright = "ran";
      else {
        // The workflow's install step is continue-on-error too: the review
        // still reads the diff, it just cannot drive the app.
        playwright = "degraded";
        const why = install.timedOut
          ? `timed out after ${INSTALL_TIMEOUT_MS / 60_000}m`
          : install.error
            ? `failed (${install.error})`
            : `failed (exit ${install.code})`;
        playwrightNote = `dependency install ${why}; the review read the code only`;
        vars.playwright = "no";
      }
    } else {
      playwright = "skipped";
      playwrightNote = `the diff touches no file matching ${first.spec.uiPattern}`;
    }

    const parsed = parseReviewWorkflow(workflowText, vars);
    if (!parsed.ok) return unavailable(parsed.reason);
    const spec = parsed.spec;
    const prompt = spec.prompt + localModeAddendum(base, head, diffPath);
    const env: NodeJS.ProcessEnv = { ...baseEnv, ...spec.env, CI: "true", PATH: baseEnv.PATH };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;

    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--permission-mode",
      "dontAsk",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      ...spec.claudeArgs,
      "--allowedTools",
      localAllowedTools(spec.allowedTools).join(","),
    ];
    if (spec.settings !== null) args.push("--settings", JSON.stringify(spec.settings));
    const minutes = Math.min(opts.timeoutMinutes ?? spec.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES);
    const bin = baseEnv.RALPH_CLAUDE_BIN || "claude";
    log(`local review: running ${bin} on ${base.slice(0, 12)}...${head.slice(0, 12)} (timeout ${minutes}m)`);
    const review = await run(bin, args, { cwd: worktree, env, timeoutMs: minutes * 60_000 });

    // Before the worktree goes: the screenshots are the one thing in it worth keeping.
    const screenshots: string[] = [];
    const shotsDir = join(worktree, spec.screenshotDir);
    for (const png of pngsUnder(shotsDir)) {
      const target = join(out, "screenshots", relative(shotsDir, png));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(png, target);
      screenshots.push(target);
    }

    if (review.timedOut) return unavailable(`review timed out after ${minutes}m`);
    if (review.error) return unavailable(`review run failed: ${review.error}`);
    if (review.code !== 0) return unavailable(`review run failed: exit ${review.code}`);
    const output = parseClaudeOutput(review.stdout);
    if (!output.ok) return unavailable(output.reason);
    const findings = parseFindings(output.value.result);
    if (!findings.ok) return unavailable(findings.reason);

    return {
      status: "ok",
      base,
      head,
      findings: findings.value,
      screenshots,
      playwright,
      playwrightNote,
      workflow: { path: WORKFLOW_PATH, ref: workflowRef },
      costUsd: output.value.costUsd,
      durationMs: output.value.durationMs,
    };
  } catch (error) {
    return unavailable(`local review failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // Not already run by abortLocalReviews.
    if (pendingCleanups.delete(cleanup)) cleanup();
  }
}

const USAGE =
  "usage: local-review.ts --checkout <dir> --base <ref> [--head <ref>] [--out <dir>] [--repo owner/name] [--timeout-minutes <n>] [--workflow-file <path>] [--fake-gh-findings]";

export type CliArgs = { opts: LocalReviewOptions; fakeGhFindings: boolean };

/** The CLI's flags, or the reason they are unusable. */
export function parseCliArgs(argv: string[]): Parsed<CliArgs> {
  const flags: Record<string, string> = {};
  const known = ["--checkout", "--base", "--head", "--out", "--repo", "--timeout-minutes", "--workflow-file"];
  let fakeGhFindings = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? "";
    if (flag === "--fake-gh-findings") {
      fakeGhFindings = true;
      continue;
    }
    if (!known.includes(flag)) return { ok: false, reason: `unknown argument ${flag}` };
    const value = argv[++i];
    if (value === undefined || value === "") return { ok: false, reason: `${flag} needs a value` };
    flags[flag] = value;
  }
  const checkout = flags["--checkout"];
  const base = flags["--base"];
  if (!checkout || !base) return { ok: false, reason: "--checkout and --base are required" };
  const opts: LocalReviewOptions = { checkout, base };
  if (flags["--head"]) opts.head = flags["--head"];
  if (flags["--out"]) opts.out = flags["--out"];
  if (flags["--repo"]) opts.repo = flags["--repo"];
  if (flags["--workflow-file"]) opts.workflowFile = flags["--workflow-file"];
  if (flags["--timeout-minutes"]) {
    const minutes = Number(flags["--timeout-minutes"]);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_TIMEOUT_MINUTES) {
      return { ok: false, reason: `--timeout-minutes must be a positive number of at most ${MAX_TIMEOUT_MINUTES}` };
    }
    opts.timeoutMinutes = minutes;
  }
  return { ok: true, value: { opts, fakeGhFindings } };
}

/**
 * The trial sandbox's fake gh (`fake-gh.ts`) reads a findings command's stdout
 * as a bare array of `{path, line, priority, title, body}`.
 */
export function fakeGhFindings(findings: Finding[]): { path: string; line: number | null; priority: Priority; title: string; body: string }[] {
  return findings.map((f) => ({ path: f.path, line: f.line, priority: f.priority, title: f.title, body: f.text }));
}

if (import.meta.main) {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.reason}\n${USAGE}\n`);
    process.exit(64);
  }
  // A signal skips every `finally`: kill the review and remove its worktree
  // here, or both outlive the CLI.
  const onSignal = (code: number) => () => {
    abortLocalReviews();
    process.exit(code);
  };
  process.on("SIGINT", onSignal(130));
  process.on("SIGTERM", onSignal(143));
  const { opts, fakeGhFindings: fakeGh } = parsed.value;
  const result = await runLocalReview({ ...opts, log: (line) => process.stderr.write(`${line}\n`) });
  if (fakeGh) {
    // Unavailable exits 3 (below): the fake reads that as an unreviewed head,
    // its review check NEUTRAL and no threads posted, never as zero findings.
    if (result.status === "ok") process.stdout.write(`${JSON.stringify(fakeGhFindings(result.findings))}\n`);
    else process.stderr.write(`local review unavailable: ${result.reason}\n`);
  } else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.status === "ok" ? 0 : 3);
}
