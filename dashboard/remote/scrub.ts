/**
 * The scrub every snapshot passes before it leaves the machine (spec #165 §4,
 * "Scrubbing").
 *
 * The views are already redacted where the harness writes them, but the
 * remote copy must not trust that field by field: one new field that quotes a
 * log line would otherwise ship whatever the line held. So the scrub is total.
 * Every document is walked, and:
 *
 * 1. a string under a deny-listed key (`token`, `secret`, `password`,
 *    `authorization`, `cookie`, `api key`) becomes `[scrubbed]`;
 * 2. URL userinfo is dropped, so `https://user:token@host/…` is
 *    `https://host/…` and `repoUrl` still links;
 * 3. `$HOME` becomes `~` wherever a string names it as a path, at its start
 *    or mid-sentence, so the username and the machine's layout stay home;
 * 4. every string leaf goes through the harness's own redactor,
 *    `runner-failure.ts redact`, the filter the live output pane uses.
 *
 * The first three are local rewrites, done before the redactor so it sees the
 * final text: a `repoUrl` with a token in it is a link with the token gone,
 * not a whole `[redacted:connection-string]`.
 *
 * The redactor is a line filter, so each leaf is written as its lines and read
 * back the same count. A leaf is reassigned only from that answer, which keeps
 * the document valid JSON whatever a pattern replaces. It fails CLOSED: a
 * redactor that exits non-zero, writes to stderr, or answers a different
 * number of lines is an error, and nothing is returned to push, as the output
 * pane withholds rather than shows what it could not redact.
 *
 * Pure except for the redactor it is handed. The default spawns
 * `bun <RALPH_HOME>/runner-failure.ts redact`; tests hand in failing fakes.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Lines in, the same lines redacted out. Rejects when it cannot vouch for them. */
export type Redactor = (lines: readonly string[]) => Promise<string[]>;

/** A key whose string values never leave the machine, whatever they hold. */
export const DENIED_KEY = /(token|secret|password|authorization|cookie|api[_-]?key)/i;

/** What a deny-listed value is replaced by. */
export const SCRUBBED = "[scrubbed]";

/** Scheme, then `user[:password]@`, then the host. */
const USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi;

/** The redactor's own command, as `iteration-output.ts`'s `REDACT_COMMAND` names it. */
const REDACT_SCRIPT = "runner-failure.ts";
const REDACT_ARGS = ["redact"] as const;

/** This file's harness checkout: `dashboard/remote` is two levels down from it. */
const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface ScrubOptions {
  redact: Redactor;
  /** The prefix rewritten to `~`. Defaults to the user's home directory. */
  home?: string;
}

export type ScrubResult<T> = { ok: true; value: T } | { ok: false; error: "redactor-degraded"; detail: string };

export class RedactorError extends Error {}

/**
 * `$HOME` as a whole path segment run, never the prefix of a sibling
 * (`/home/user2`). Anywhere in the string, not only at its start, because a
 * notification body or an evidence line quotes paths mid-sentence. A `/`
 * before it does not protect it, so `file:///home/u` loses the username too.
 */
const homePattern = (home: string): RegExp | null => {
  const trimmed = home.replace(/\/+$/, "");
  if (trimmed === "") return null;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w.~-])${escaped}(?![\\w.-])`, "g");
};

/** The local rewrites: everything but the redactor. */
const rewrite = (text: string, home: RegExp | null): string => {
  const bare = text.replace(USERINFO, "$1");
  return home === null ? bare : bare.replace(home, "~");
};

/**
 * Scrub several documents with one redactor call. Either every document comes
 * back scrubbed, or none does.
 */
export async function scrubAll(documents: readonly unknown[], { redact, home = homedir() }: ScrubOptions): Promise<ScrubResult<unknown[]>> {
  const homeAt = homePattern(home);
  // Each string leaf is split into lines, and `slots` remembers how many lines
  // belong to which leaf so the answer can be put back where it came from.
  const lines: string[] = [];
  const slots: { count: number; assign: (text: string) => void }[] = [];
  const leaf = (text: string, assign: (text: string) => void): void => {
    const parts = rewrite(text, homeAt).split("\n");
    lines.push(...parts);
    slots.push({ count: parts.length, assign });
  };
  const walk = (value: unknown, denied: boolean, assign: (next: unknown) => void): void => {
    if (typeof value === "string") {
      if (denied) assign(SCRUBBED);
      else leaf(value, assign);
      return;
    }
    if (Array.isArray(value)) {
      const copy: unknown[] = [...value];
      assign(copy);
      copy.forEach((item, index) => walk(item, denied, (next) => (copy[index] = next)));
      return;
    }
    if (typeof value === "object" && value !== null) {
      const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
      assign(copy);
      // A deny-listed key scrubs every string beneath it. Numbers survive, so
      // `tokens: 1200` and `unpricedTokens` stay counts rather than secrets.
      for (const [key, item] of Object.entries(copy)) walk(item, denied || DENIED_KEY.test(key), (next) => (copy[key] = next));
    }
    // Numbers, booleans and null are not text, and cannot carry a credential.
  };
  const out: unknown[] = [...documents];
  out.forEach((document, index) => walk(document, false, (next) => (out[index] = next)));
  if (lines.length === 0) return { ok: true, value: out };

  let redacted: string[];
  try {
    redacted = await redact(lines);
  } catch (error) {
    return { ok: false, error: "redactor-degraded", detail: error instanceof Error ? error.message : String(error) };
  }
  if (!Array.isArray(redacted) || redacted.length !== lines.length) {
    const got = Array.isArray(redacted) ? redacted.length : "no";
    return { ok: false, error: "redactor-degraded", detail: `the redactor answered ${got} lines for ${lines.length}` };
  }
  let at = 0;
  for (const slot of slots) {
    slot.assign(redacted.slice(at, at + slot.count).join("\n"));
    at += slot.count;
  }
  return { ok: true, value: out };
}

/** Scrub one document. */
export async function scrub<T>(document: T, options: ScrubOptions): Promise<ScrubResult<T>> {
  const result = await scrubAll([document], options);
  return result.ok ? { ok: true, value: result.value[0] as T } : result;
}

/**
 * The harness's redactor as a `Redactor`: one `bun runner-failure.ts redact`
 * per call, run from the harness checkout so it reads the harness's patterns,
 * with the bridge's environment so it strikes the values of its secrets too.
 */
export function processRedactor(
  config: { ralphHome?: string; bunPath?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Redactor {
  const ralphHome = config.ralphHome ?? process.env.RALPH_HOME ?? HARNESS;
  const bunPath = config.bunPath ?? ((process.versions as Record<string, string | undefined>).bun ? process.execPath : "bun");
  const timeoutMs = config.timeoutMs ?? 30_000;
  return (lines) =>
    new Promise<string[]>((resolve, reject) => {
      const child = spawn(bunPath, [join(ralphHome, REDACT_SCRIPT), ...REDACT_ARGS], {
        cwd: ralphHome,
        env: config.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let settled = false;
      const fail = (why: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new RedactorError(why));
      };
      const timer = setTimeout(() => fail(`the redactor did not finish within ${timeoutMs} ms`), timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", (error) => fail(`the redactor could not run: ${error.message}`));
      // A redactor that exits early closes stdin under the write; the exit
      // status below is what reports it.
      child.stdin.on("error", () => {});
      child.on("close", (code, signal) => {
        if (settled) return;
        const stderr = Buffer.concat(err).toString("utf8").trim();
        if (code !== 0) return fail(`the redactor exited ${code ?? signal}${stderr === "" ? "" : `: ${stderr}`}`);
        if (stderr !== "") return fail(`the redactor wrote to stderr: ${stderr}`);
        settled = true;
        clearTimeout(timer);
        const text = Buffer.concat(out).toString("utf8");
        // Every line went in newline-terminated, so every line comes back so.
        if (!text.endsWith("\n")) return reject(new RedactorError("the redactor's answer did not end with a newline"));
        resolve(text.slice(0, -1).split("\n"));
      });
      child.stdin.end(`${lines.join("\n")}\n`);
    });
}
