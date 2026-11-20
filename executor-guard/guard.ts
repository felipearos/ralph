#!/usr/bin/env bun
/**
 * The executor's command guard: refuses repo-wide verification before it
 * starts.
 *
 * The executor's job is one slice of code and the checks for the files it
 * touched. Repo-wide verification — the whole test suite, a lint of the whole
 * tree, a build, e2e, a dev server — is the orchestrator's, which has the
 * environment for it and runs it after reading the diff. On 2026-09-23 two
 * Codex executors ran it anyway: rafa #1108 ran `bun run test` with no paths
 * although its brief forbade exactly that, and ralph #1221 ran `bun lint` over
 * the whole repo unprompted. Both hung in the sandbox and both were killed at
 * the 900s ceiling with the slice half-reported. A sentence in the brief had
 * already failed once, so this does not depend on the model reading one.
 *
 * `shim.sh` sits first on the executor's PATH under the names of every package
 * runner (`bun`, `bunx`, `node`, `npx`, `npm`, `pnpm`, `yarn`) and asks this
 * file about each invocation before handing it to the real binary. The Codex
 * runner mounts it inside Bubblewrap; the other runners get it from
 * `delegate.sh`. What is judged is what the command would RUN, not how it is
 * spelled: a package script is expanded from `package.json` (so `bun lint` is
 * judged as the `eslint src/ mobile/ packages/` it runs), and `bunx`, `npx`,
 * `pnpm exec` and `node node_modules/.bin/…` all reduce to the tool itself.
 *
 * Two kinds of refusal:
 *   - refused outright: builds, e2e, dev servers and watchers — nothing an
 *     executor needs, whatever it targets;
 *   - refused without a narrow target: test runners and linters, which with
 *     no file argument (or with `.` or a top-level directory) run over the
 *     whole repository.
 * The tool knowledge is built in; a project adds its own commands under
 * `executorGuard` in `.ralph/config.json`.
 *
 * This file is mounted into the sandbox on its own, so it imports nothing from
 * the rest of the harness.
 *
 * The second subcommand is the ci-doctor's diff guard (felipearos/ralph#152).
 * The command guard cannot see a diff — it judges one invocation at a time —
 * so judging what the doctor WROTE is its own call, made by the doctor's
 * verify phase and by the doctor's executor before it reports a slice. Both
 * run the rules in `diff-guard.ts`, which is why that file lives here, under
 * the same no-harness-imports rule, rather than beside the rest of
 * `ci-doctor/`.
 *
 * Usage (from shim.sh):
 *   bun guard.ts check --cwd <dir> <program> [args…]
 *   bun guard.ts diff  --cwd <dir> [--pr-body <file>]                     # diff on stdin
 * Exit 0 allows, 10 refuses (the reason is on stderr); anything else is the
 * guard failing, which the shim reports and then lets the command through.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  diffGuardProblems,
  diffRefusalMessage,
  parseTimeoutEvidence,
  readDiffGuardConfig,
} from "./diff-guard";

/** How one command resolves: a package script, or a tool and its arguments. */
type Call = { kind: "script"; name: string; args: string[] } | { kind: "tool"; words: string[] };

export interface GuardContext {
  cwd: string;
  /** The directory of the nearest package.json: "the repository" for breadth. */
  root: string;
  scripts: Record<string, string>;
  /** Project-configured patterns, already canonicalised. */
  refuse: Call[];
  requireTargets: Call[];
}

export type Verdict = { allowed: true } | { allowed: false; reason: string };

export const REFUSED_EXIT = 10;

/** Refused whatever they target: builds, e2e, servers, watchers. */
const REFUSED_TOOLS: string[][] = [
  ["playwright"],
  ["cypress"],
  ["next", "build"],
  ["next", "dev"],
  ["next", "start"],
  ["vite", "build"],
  ["vite", "dev"],
  ["vite", "serve"],
  ["vite", "preview"],
  ["storybook"],
  ["build-storybook"],
  ["bun", "build"],
  ["vitest", "watch"],
  ["vitest", "dev"],
];

/** Refused unless every target is narrow and there is at least one. */
const TARGETED_TOOLS: string[][] = [["vitest"], ["jest"], ["eslint"], ["oxlint"], ["biome"], ["bun", "test"]];

/** Words after a targeted tool that choose a mode rather than name a target. */
const SUBCOMMANDS: Record<string, string[]> = {
  vitest: ["run", "related", "bench", "list"],
  biome: ["check", "lint", "format", "ci"],
};

/** Flags that stand in for a target: "only what changed". */
const TARGETING_FLAGS = new Set(["--changed", "--onlyChanged", "-o", "--findRelatedTests", "--staged"]);

/** Flags whose next word is their value, not a target. */
const VALUE_FLAGS = new Set([
  "-c", "--config", "--project", "--root", "-r", "--dir", "--reporter", "--pool", "--environment",
  "--shard", "-t", "--testNamePattern", "--format", "-f", "--ext", "--cwd", "--outputFile",
  "--max-warnings", "--rule", "--ignore-pattern", "--parser", "--env", "--plugin", "--workspace",
  "--exclude", "--testTimeout", "--maxWorkers", "--mode", "--preload", "--timeout",
]);

/**
 * Package scripts refused by name: a build, e2e, a server or a watcher is not
 * the executor's whatever its body says (`build-storybook`, `db:seed:e2e`).
 */
const REFUSED_SCRIPT_NAME = /(^|[:_-])(build|e2e|dev|start|serve|preview|watch)($|[:_-])/;

const BUN_BUILTINS = new Set([
  "run", "test", "x", "repl", "exec", "install", "i", "add", "a", "remove", "rm", "update", "outdated",
  "link", "unlink", "pm", "build", "init", "create", "c", "upgrade", "completions", "help", "publish",
  "audit", "info", "patch", "patch-commit", "why", "feedback",
]);
const PNPM_BUILTINS = new Set(["install", "i", "add", "remove", "rm", "update", "up", "link", "outdated", "why", "list", "ls"]);

const toolName = (word: string): string => basename(word).replace(/\.(c|m)?js$/, "");

const dropDashDash = (args: string[]): string[] => (args[0] === "--" ? args.slice(1) : args);

/**
 * Reduce a command to what it runs. `assumeScripts` is for configured
 * patterns: `bun run test:integration` names a script even where this
 * package.json has none by that name.
 */
function canonical(argv: string[], scripts: Record<string, string>, assumeScripts = false): Call | null {
  if (argv.length === 0) return null;
  const program = toolName(argv[0]!);
  const rest = argv.slice(1);
  const isScript = (name: string | undefined) => name !== undefined && (assumeScripts || Object.hasOwn(scripts, name));
  const script = (name: string, args: string[]): Call => ({ kind: "script", name, args: dropDashDash(args) });
  const tool = (words: string[]): Call | null => (words.length === 0 ? null : { kind: "tool", words: [toolName(words[0]!), ...words.slice(1)] });
  const withoutFlags = (words: string[]) => {
    let i = 0;
    while (i < words.length && words[i]!.startsWith("-")) i++;
    return words.slice(i);
  };

  switch (program) {
    case "bun": {
      const words = withoutFlags(rest);
      const sub = words[0];
      if (sub === undefined) return null;
      if (sub === "x") return tool(withoutFlags(words.slice(1)));
      if (sub === "run") {
        const target = words[1];
        if (target === undefined) return null;
        return isScript(target) ? script(target, words.slice(2)) : tool(words.slice(1));
      }
      if (BUN_BUILTINS.has(sub)) return { kind: "tool", words: ["bun", ...words] };
      return isScript(sub) ? script(sub, words.slice(1)) : tool(words);
    }
    case "bunx":
    case "npx":
      return tool(withoutFlags(rest));
    case "npm": {
      const sub = rest[0];
      if (sub === "run" || sub === "run-script") return rest[1] === undefined ? null : script(rest[1], rest.slice(2));
      if (sub === "test" || sub === "t" || sub === "tst") return script("test", rest.slice(1));
      if (sub === "exec" || sub === "x") return tool(withoutFlags(rest.slice(1)));
      return null;
    }
    case "pnpm":
    case "yarn": {
      const words = withoutFlags(rest);
      const sub = words[0];
      if (sub === undefined) return null;
      if (sub === "run") return words[1] === undefined ? null : script(words[1], words.slice(2));
      if (sub === "test" || sub === "t") return script("test", words.slice(1));
      if (sub === "exec" || sub === "dlx") return tool(withoutFlags(words.slice(1)));
      if (PNPM_BUILTINS.has(sub)) return null;
      return isScript(sub) ? script(sub, words.slice(1)) : tool(words);
    }
    case "node": {
      // The first word that is not an option is the script node runs.
      for (let i = 0; i < rest.length; i++) {
        const word = rest[i]!;
        if (word === "-e" || word === "--eval" || word === "-p" || word === "--print") return null;
        if (["-r", "--require", "--import", "--loader", "--experimental-loader"].includes(word)) {
          i++;
          continue;
        }
        if (word.startsWith("-")) continue;
        return tool(rest.slice(i));
      }
      return null;
    }
    default:
      return tool(argv);
  }
}

/** Positional words, with each value-taking flag's value dropped. */
function positionals(words: string[]): { positional: string[]; targeting: boolean } {
  const positional: string[] = [];
  let targeting = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === "--") continue;
    if (word.startsWith("-")) {
      if (TARGETING_FLAGS.has(word) || TARGETING_FLAGS.has(word.split("=")[0]!)) targeting = true;
      if (VALUE_FLAGS.has(word)) i++;
      continue;
    }
    positional.push(word);
  }
  return { positional, targeting };
}

const startsWith = (words: string[], prefix: string[]): boolean => prefix.every((word, i) => words[i] === word);

/**
 * A target is broad when it is the package root or one of its top-level
 * directories (`.`, `src/`, `packages/`), or a glob rooted there. Anything
 * deeper, any file, and any word that is not a path (a test-name filter) is
 * narrow.
 */
function broad(target: string, ctx: GuardContext): boolean {
  const glob = target.search(/[*?[{]/);
  const literal = glob === -1 ? target : target.slice(0, glob);
  const path = resolve(ctx.cwd, literal === "" ? "." : literal);
  const fromRoot = relative(ctx.root, path);
  if (fromRoot === "") return true;
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) return false;
  const depth = fromRoot.split(/[\\/]/).filter(Boolean).length;
  if (depth > 1) return false;
  if (glob !== -1) return true;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The verdict on a tool invocation's targets; `fixed` is how the script spelled it, for the reason. */
function judgeTargets(words: string[], prefix: string[], ctx: GuardContext): Verdict {
  const tool = prefix.join(" ");
  const after = words.slice(prefix.length);
  let { positional, targeting } = positionals(after);
  const modes = SUBCOMMANDS[prefix[0]!] ?? [];
  if (prefix.length === 1 && positional.length > 0 && modes.includes(positional[0]!)) positional = positional.slice(1);
  const wide = positional.filter((target) => broad(target, ctx));
  if (wide.length > 0) {
    return { allowed: false, reason: `it runs ${tool} over ${wide.join(", ")} — the whole repository, not the files you touched.` };
  }
  if (positional.length === 0 && !targeting) {
    return { allowed: false, reason: `it runs ${tool} with no file targets — the whole suite.` };
  }
  return { allowed: true };
}

function evaluate(call: Call | null, ctx: GuardContext, depth: number): Verdict {
  if (call === null || depth > 8) return { allowed: true };
  if (call.kind === "script") {
    const words = ["run", call.name, ...call.args];
    if (REFUSED_SCRIPT_NAME.test(call.name)) {
      return { allowed: false, reason: `the \`${call.name}\` script is a build, e2e, server or watcher — the orchestrator's, not yours.` };
    }
    for (const pattern of ctx.refuse) {
      if (pattern.kind === "script" && startsWith(words, ["run", pattern.name, ...pattern.args])) {
        return { allowed: false, reason: `this project refuses \`${call.name}\` to the executor.` };
      }
    }
    for (const pattern of ctx.requireTargets) {
      if (pattern.kind === "script" && startsWith(words, ["run", pattern.name, ...pattern.args])) {
        const verdict = judgeTargets(words, ["run", pattern.name, ...pattern.args], ctx);
        if (!verdict.allowed) return { allowed: false, reason: verdict.reason.replace(`run ${pattern.name}`, `the \`${pattern.name}\` script`) };
      }
    }
    const body = ctx.scripts[call.name];
    if (body === undefined) return { allowed: true };
    // The package manager appends extra arguments to the script's text, so
    // they reach its last command.
    const segments = splitScript(body);
    for (const [index, segment] of segments.entries()) {
      const argv = index === segments.length - 1 ? [...segment, ...call.args] : segment;
      const verdict = evaluate(canonical(argv, ctx.scripts), ctx, depth + 1);
      if (!verdict.allowed) return verdict;
    }
    return { allowed: true };
  }

  const words = call.words;
  for (const prefix of REFUSED_TOOLS) {
    if (startsWith(positionals(words).positional, prefix)) {
      return { allowed: false, reason: `it runs \`${prefix.join(" ")}\` — a build, e2e, server or watcher, which belongs to the orchestrator.` };
    }
  }
  for (const pattern of ctx.refuse) {
    if (pattern.kind === "tool" && startsWith(positionals(words).positional, pattern.words)) {
      return { allowed: false, reason: `this project refuses \`${pattern.words.join(" ")}\` to the executor.` };
    }
  }
  for (const prefix of [...TARGETED_TOOLS, ...ctx.requireTargets.flatMap((p) => (p.kind === "tool" ? [p.words] : []))]) {
    if (startsWith(words, prefix)) {
      const verdict = judgeTargets(words, prefix, ctx);
      if (!verdict.allowed) return verdict;
    }
  }
  return { allowed: true };
}

/** Judge one command, `argv[0]` being the program as the executor typed it. */
export function judge(argv: string[], ctx: GuardContext): Verdict {
  return evaluate(canonical(argv, ctx.scripts), ctx, 0);
}

/**
 * A package script's text as the argv of each simple command in it. Enough
 * shell for what scripts contain: quotes, `&&`/`||`/`;`/`|`, leading
 * `VAR=value` assignments and `env`/`cross-env` wrappers.
 */
export function splitScript(text: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    let start = 0;
    while (start < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start]!) || ["env", "cross-env", "exec", "time", "nice"].includes(words[start]!))) start++;
    if (start < words.length) commands.push(words.slice(start));
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "'" || char === '"') {
      const close = text.indexOf(char, i + 1);
      word += text.slice(i + 1, close === -1 ? text.length : close);
      inWord = true;
      i = close === -1 ? text.length : close;
    } else if (char === "\\" && i + 1 < text.length) {
      word += text[++i];
      inWord = true;
    } else if (/\s/.test(char) && char !== "\n") {
      endWord();
    } else if ("&|;\n()".includes(char)) {
      endCommand();
    } else {
      word += char;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

/** The nearest `name` at or above `from`, or null. */
function nearest(from: string, name: string): string | null {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, name))) return join(dir, name);
    if (dirname(dir) === dir) return null;
  }
}

/** The project's `executorGuard` patterns; project-config.ts has validated the file. */
function projectPatterns(cwd: string, scripts: Record<string, string>): { refuse: Call[]; requireTargets: Call[] } {
  const path = nearest(cwd, join(".ralph", "config.json"));
  const guard = path ? (JSON.parse(readFileSync(path, "utf8")) as { executorGuard?: Record<string, unknown> }).executorGuard : undefined;
  const patterns = (list: unknown): Call[] =>
    (Array.isArray(list) ? list : []).flatMap((command) => {
      const call = typeof command === "string" ? canonical(command.trim().split(/\s+/), scripts, true) : null;
      return call ? [call] : [];
    });
  return { refuse: patterns(guard?.refuse), requireTargets: patterns(guard?.requireTargets) };
}

/** Everything a verdict depends on, read from the directory the command runs in. */
export function loadContext(cwd: string): GuardContext {
  const manifest = nearest(cwd, "package.json");
  const scripts = manifest
    ? ((JSON.parse(readFileSync(manifest, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {})
    : {};
  return { cwd, root: manifest ? dirname(manifest) : cwd, scripts, ...projectPatterns(cwd, scripts) };
}

/** What the executor reads instead of a hang. */
export function refusalMessage(argv: string[], verdict: Extract<Verdict, { allowed: false }>): string {
  const program = toolName(argv[0] ?? "bun");
  const runner = program === "node" || program === "bunx" ? "bun" : program;
  return [
    `ralph executor guard: refused \`${argv.join(" ")}\`.`,
    `  Why: ${verdict.reason}`,
    "  Repo-wide verification (the full test suite, a whole-repo lint, builds, e2e, dev servers) belongs to",
    "  the orchestrator, which runs it after reading your diff. In this sandbox it stalls until the",
    "  delegation is killed at its timeout, and your work is lost with it.",
    "  Run targeted checks on the files you touched instead, for example:",
    `    ${runner} run test path/to/changed.test.ts`,
    `    ${runner === "npm" ? "npx" : `${runner} x`} eslint path/to/changed.ts`,
    "  and report any check you could not target as not-run. Do not retry this command another way.",
  ].join("\n");
}

/** The `diff` subcommand's options; null when an argument is not one of them. */
function options(args: string[], allowed: readonly string[]): Record<string, string> | null {
  const found: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    // Refuse what is not understood rather than dropping it: a mistyped
    // `--pr-bodyy` that is silently ignored refuses the diff for want of
    // evidence that was supplied, and says nothing about why.
    if (name === undefined || !name.startsWith("--") || !allowed.includes(name.slice(2)) || value === undefined) return null;
    found[name.slice(2)] = value;
  }
  return found;
}

/**
 * Judge a diff the ci-doctor produced. The diff arrives on stdin, because it
 * is long and a shell argument is not where a patch belongs.
 *
 * There is deliberately no `--revert` here. The exact-revert exception skips
 * the weakening and timeout rules outright, so a caller who may name the
 * revert to compare against can clear any diff by naming a copy of itself —
 * and in the sandbox the caller is the executor, which is the actor this
 * whole file exists because of. The exception belongs to the verify phase,
 * which generates the revert from a sha with `git` rather than being handed
 * one (`ci-doctor/verify.ts --revert-of`).
 */
function diffMain(args: string[]): number {
  const flags = options(args, ["cwd", "pr-body"]);
  const cwd = flags?.cwd;
  if (flags === null || cwd === undefined) {
    console.error("usage: bun guard.ts diff --cwd <dir> [--pr-body <file>]   # diff on stdin");
    return 2;
  }
  const diff = readFileSync(0, "utf8");
  const config = readDiffGuardConfig(nearest(cwd, join(".ralph", "config.json")), (path) => readFileSync(path, "utf8"));
  const body = flags["pr-body"];
  const evidence = body === undefined ? null : parseTimeoutEvidence(readFileSync(body, "utf8"));
  const problems = diffGuardProblems(diff, { config, revert: null, evidence });
  if (problems.length === 0) return 0;
  console.error(diffRefusalMessage(problems));
  return REFUSED_EXIT;
}

function main(args: string[]): number {
  if (args[0] === "diff") return diffMain(args.slice(1));
  if (args[0] !== "check" || args[1] !== "--cwd" || args[2] === undefined || args[3] === undefined) {
    console.error("usage: bun guard.ts check --cwd <dir> <program> [args…]");
    return 2;
  }
  const argv = args.slice(3);
  const verdict = judge(argv, loadContext(args[2]));
  if (verdict.allowed) return 0;
  console.error(refusalMessage(argv, verdict));
  return REFUSED_EXIT;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`ralph executor guard: ${(error as Error).message}`);
    process.exitCode = 70;
  }
}
