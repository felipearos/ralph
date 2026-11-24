/**
 * A dotenv file as a project's secrets runner (felipearos/software-factory#49):
 * for a host with no secrets manager, the secrets sit in one file the operator
 * keeps outside the repository, and the loop reads them from there.
 *
 * Three doors onto the same parser:
 * - `dotenvSource(path)`, the `SecretSource` a named-secret read goes through;
 * - `readDotenvFile(path)`, the whole file at once;
 * - `bun secrets/dotenv.ts export <file>`, the CLI `secrets/dotenv-run.sh`
 *   calls to put the file's variables into a command's environment.
 *
 * No error, reason or log line here ever carries a value from the file: a
 * malformed line is named by its number only, since its text may be a secret.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

import type { SecretSource } from "./source";

/** A syntax error in a dotenv file; its message names a line number, never text. */
export class DotenvSyntaxError extends Error {}

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Escapes a double-quoted value understands; any other backslash is kept as written. */
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\" };

/** True when what follows a closing quote is nothing or a comment. */
const onlyComment = (rest: string): boolean => rest.trim() === "" || rest.trimStart().startsWith("#");

/**
 * Parses dotenv text: blank and `#` lines skipped, an optional `export `,
 * `KEY=value` with unquoted values trimmed and a ` #` comment cut, single
 * quotes literal, double quotes with `\n` `\t` `\"` `\\` escapes and free to
 * span lines. A later duplicate key wins. Throws {@link DotenvSyntaxError}.
 */
export function parseDotenv(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  // A NUL cannot live in an environment variable, and the export CLI
  // separates records with it: one inside a value would split it in two.
  const nul = text.indexOf("\0");
  if (nul >= 0) throw new DotenvSyntaxError(`line ${text.slice(0, nul).split("\n").length}: a NUL byte`);
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const line = (lines[index] ?? "").trim();
    if (line === "" || line.startsWith("#")) continue;
    const body = line.replace(/^export\s+/, "");
    const equals = body.indexOf("=");
    if (equals < 0) throw new DotenvSyntaxError(`line ${lineNumber}: no '=' in the assignment`);
    const key = body.slice(0, equals).trim();
    if (!KEY.test(key)) throw new DotenvSyntaxError(`line ${lineNumber}: not a valid variable name`);
    const raw = body.slice(equals + 1).trimStart();

    if (raw.startsWith("'")) {
      const close = raw.indexOf("'", 1);
      if (close < 0) throw new DotenvSyntaxError(`line ${lineNumber}: unclosed single quote`);
      if (!onlyComment(raw.slice(close + 1))) {
        throw new DotenvSyntaxError(`line ${lineNumber}: text after the closing quote`);
      }
      vars.set(key, raw.slice(1, close));
      continue;
    }

    if (raw.startsWith('"')) {
      // Scan on through following lines until an unescaped closing quote: a
      // double-quoted value (a PEM key, say) may span lines.
      let value = "";
      let rest = raw.slice(1);
      let closed = false;
      for (;;) {
        let at = 0;
        while (at < rest.length) {
          const char = rest[at] as string;
          if (char === "\\" && at + 1 < rest.length) {
            const next = rest[at + 1] as string;
            value += ESCAPES[next] ?? `\\${next}`;
            at += 2;
            continue;
          }
          if (char === '"') {
            closed = true;
            break;
          }
          value += char;
          at++;
        }
        if (closed) {
          if (!onlyComment(rest.slice(at + 1))) {
            throw new DotenvSyntaxError(`line ${index + 1}: text after the closing quote`);
          }
          break;
        }
        index++;
        if (index >= lines.length) throw new DotenvSyntaxError(`line ${lineNumber}: unclosed double quote`);
        value += "\n";
        rest = lines[index] ?? "";
      }
      vars.set(key, value);
      continue;
    }

    // Unquoted: a `#` after whitespace starts a comment; one inside a value
    // (`a#b`) does not.
    // A value that is nothing but a comment (`KEY=   # fill me in`) is empty,
    // as other dotenv readers have it, so a named secret left as a
    // placeholder reads absent rather than as the placeholder's text.
    if (raw.startsWith("#")) {
      vars.set(key, "");
      continue;
    }
    const comment = raw.search(/\s#/);
    vars.set(key, (comment < 0 ? raw : raw.slice(0, comment)).trim());
  }
  return vars;
}

export type DotenvFileRead =
  | { kind: "ok"; vars: Map<string, string> }
  | { kind: "missing" }
  /** `why` is the error code, never the file's contents. */
  | { kind: "unreadable"; why: string }
  /** `why` names a line number, never the line's text. */
  | { kind: "malformed"; why: string };

/** Reads and parses `path`. Never throws. */
export function readDotenvFile(path: string): DotenvFileRead {
  // No path configured reads as no file, so the source answers unread rather
  // than reading whatever "" resolves to.
  if (path === "") return { kind: "missing" };
  let text: string;
  try {
    // Opened non-blocking and checked on the open descriptor: a FIFO with no
    // writer would block a plain read forever (preflight, the export CLI), and
    // a stat before the read would race a swap of the path in between.
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) return { kind: "unreadable", why: "not a regular file" };
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    return { kind: "unreadable", why: code ?? "read failed" };
  }
  try {
    return { kind: "ok", vars: parseDotenv(text) };
  } catch (error) {
    if (error instanceof DotenvSyntaxError) return { kind: "malformed", why: error.message };
    // Anything else is a parser bug; its message is ours, but stay generic
    // rather than risk a value in it.
    return { kind: "malformed", why: "the file could not be parsed" };
  }
}

/**
 * The file as a `SecretSource`. A file that is missing, unreadable or
 * malformed answers unread for every name: the operator may be mid-edit or the
 * mount late, and the supervisor's wait-and-re-read is the right answer. A
 * blank value is absent; a real one is returned untrimmed, as stored.
 */
export function dotenvSource(path: string): SecretSource {
  return {
    kind: "dotenv",
    async read(name) {
      const file = readDotenvFile(path);
      if (file.kind === "missing") return { kind: "unread", why: `the secrets file ${path || "(none set)"} is missing` };
      if (file.kind === "unreadable") return { kind: "unread", why: `the secrets file ${path} is unreadable (${file.why})` };
      if (file.kind === "malformed") return { kind: "unread", why: `the secrets file ${path} is malformed (${file.why})` };
      const value = file.vars.get(name);
      return value !== undefined && value.trim() !== "" ? { kind: "value", value } : { kind: "absent" };
    },
  };
}

export const EXIT_USAGE = 2;
export const EXIT_MISSING = 3;
export const EXIT_UNREADABLE = 4;
export const EXIT_MALFORMED = 5;

/**
 * `bun secrets/dotenv.ts export <file>`: the file's variables on stdout as
 * NUL-separated `KEY=value` records (a value may hold a newline, so a newline
 * cannot separate them). On failure one stderr line naming the file and the
 * failure, nothing on stdout.
 */
export function main(
  argv: string[],
  out: { stdout: (text: string) => void; stderr: (text: string) => void } = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
): number {
  const [command, file, ...rest] = argv;
  if (command !== "export" || file === undefined || file === "" || rest.length > 0) {
    out.stderr("usage: bun secrets/dotenv.ts export <file>\n");
    return EXIT_USAGE;
  }
  const read = readDotenvFile(file);
  if (read.kind === "missing") {
    out.stderr(`dotenv: ${file}: missing\n`);
    return EXIT_MISSING;
  }
  if (read.kind === "unreadable") {
    out.stderr(`dotenv: ${file}: unreadable (${read.why})\n`);
    return EXIT_UNREADABLE;
  }
  if (read.kind === "malformed") {
    out.stderr(`dotenv: ${file}: malformed (${read.why})\n`);
    return EXIT_MALFORMED;
  }
  let records = "";
  for (const [key, value] of read.vars) records += `${key}=${value}\0`;
  out.stdout(records);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
