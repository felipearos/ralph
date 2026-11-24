/**
 * The one seam every named secret a loop reads goes through
 * (felipearos/ralph#759): Doppler, a dotenv file on the host (`dotenv.ts`,
 * felipearos/software-factory#49), the plain environment when the project
 * runs no secrets manager, and whatever manager comes next
 * (Infisical, 1Password, a host file) as one more `SecretSource`. The
 * supervisor's re-read of an unread secret is written against this interface,
 * so a new source gets it without touching `ralph.sh`.
 *
 * Shaped like `tracker/` and `reporter/`: the interface and real sources here,
 * an in-memory fake (`fake.ts`), and a shared contract suite (`contract.ts`)
 * every source's test file runs.
 */
import { spawn } from "node:child_process";

import { dotenvSource } from "./dotenv";

/**
 * What one read of a named secret came back with.
 *
 * `absent` and `unread` are kept apart because they lead to different
 * supervisor answers: absent means "not stored" and the role works without it,
 * while unread is a transient failure (a timeout, a locked keyring, a refused
 * connection) and the supervisor waits and reads it again. Folding the second
 * into the first is what denied clara on 2026-10-29.
 */
export type SecretRead =
  | { kind: "value"; value: string }
  /** Not stored. */
  | { kind: "absent" }
  /** Transient: timeout, locked keyring, refused connection. `why` is one line. */
  | { kind: "unread"; why: string };

export interface SecretSource {
  /** Which manager answers: "doppler", "dotenv", "environment", "fake". */
  readonly kind: string;
  read(name: string): Promise<SecretRead>;
}

/**
 * The runners `ralph.sh` knows: Doppler, a dotenv file (its path in
 * `RALPH_SECRETS_FILE`), and none, which reads the environment.
 */
export type SecretsRunner = "doppler" | "dotenv" | "none";

/** What a finished (or abandoned) child process left behind. */
export interface RunResult {
  /** Exit status; null when it was killed or never started. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the runner killed it for running past `timeoutMs`. */
  timedOut: boolean;
}

/**
 * Runs `argv` with a deadline. Injectable so tests drive a fake process rather
 * than the real CLI. A spawn failure (ENOENT: no such binary) rejects.
 */
export type ProcessRunner = (argv: string[], timeoutMs: number) => Promise<RunResult>;

/**
 * Longest `why` an unread carries: it lands in one supervisor log line and
 * one warning, and Doppler's errors can run to a page.
 */
export const MAX_WHY_CHARS = 200;

/** Doppler's answer for a name the scope does not hold — the one error that means absent. */
const NOT_FOUND = /could not find requested secret/i;

/**
 * The default runner: a real child process, killed with its whole process
 * group at the deadline.
 *
 * The group, not the child alone: a wrapper script that execs nothing (a shell
 * running `doppler`, or a test's fake) leaves its own children holding the
 * output pipes, and killing only the shell would leave this waiting on them.
 * On a timeout it answers at once rather than on the pipes closing, for the
 * same reason — a read must never hang the supervisor.
 */
export const runProcess: ProcessRunner = (argv, timeoutMs) =>
  new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      reject(new Error("no command to run"));
      return;
    }
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone between the deadline and the kill: nothing to stop.
      }
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });

/** One line, bounded: newlines to spaces and cut to {@link MAX_WHY_CHARS}. */
const oneLine = (text: string): string => text.replace(/\n/g, " ").slice(0, MAX_WHY_CHARS);

export interface DopplerSourceOptions {
  project: string;
  config: string;
  run?: ProcessRunner;
  timeoutMs?: number;
}

/**
 * Doppler, read one name at a time with `doppler secrets get --plain`.
 *
 * Classification — each answer is handled differently by the supervisor, so a
 * wrong one either drops a token for the run or re-reads forever:
 * - exit 0: the value is stdout ONLY. Doppler can print an update notice on
 *   stderr even on success, and that must never become the token. Trailing
 *   newlines are dropped, as the shell's command substitution did; an empty
 *   value is absent.
 * - a timeout is unread.
 * - "could not find requested secret" is absent: the one error that means
 *   "not stored".
 * - any other error text is unread, carrying that text.
 * - a silent failure (non-zero, nothing on stderr) has no evidence of an
 *   outage and stays absent, as it always was.
 * - a CLI that cannot be started at all is unread: the scope may hold it.
 */
export function dopplerSource(options: DopplerSourceOptions): SecretSource {
  const run = options.run ?? runProcess;
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    kind: "doppler",
    async read(name) {
      let result: RunResult;
      try {
        result = await run(
          ["doppler", "secrets", "get", name, "--plain", "-p", options.project, "-c", options.config],
          timeoutMs,
        );
      } catch (error) {
        return { kind: "unread", why: oneLine(error instanceof Error ? error.message : String(error)) };
      }
      if (result.timedOut) return { kind: "unread", why: "the read timed out" };
      if (result.code === 0) {
        const value = result.stdout.replace(/\n+$/, "");
        return value === "" ? { kind: "absent" } : { kind: "value", value };
      }
      if (NOT_FOUND.test(result.stderr)) return { kind: "absent" };
      const why = oneLine(result.stderr);
      if (why.replace(/ /g, "") === "") return { kind: "absent" };
      return { kind: "unread", why };
    },
  };
}

/**
 * The process environment, for a project that runs no secrets manager: its
 * launcher (a systemd unit, a shell profile) put the secrets there.
 *
 * It never answers unread: a launcher that failed to export a secret cannot be
 * told from one that was never given it, so all an empty or missing variable
 * can mean is absent. A blank value counts as missing; a real one is returned
 * as stored, untrimmed.
 */
export function environmentSource(env: Record<string, string | undefined> = process.env): SecretSource {
  return {
    kind: "environment",
    async read(name) {
      const value = env[name];
      return value !== undefined && value.trim() !== "" ? { kind: "value", value } : { kind: "absent" };
    },
  };
}

/** The source a loop's configured runner reads named secrets through. */
export function secretSourceFor(
  runner: SecretsRunner,
  env: Record<string, string | undefined> = process.env,
): SecretSource {
  if (runner === "doppler") {
    return dopplerSource({ project: env.RALPH_SECRETS_PROJECT ?? "", config: env.RALPH_SECRETS_CONFIG ?? "" });
  }
  // An unset path reads as a missing file, so every read answers unread and
  // the supervisor waits, rather than quietly finding nothing.
  if (runner === "dotenv") return dotenvSource(env.RALPH_SECRETS_FILE ?? "");
  return environmentSource(env);
}
