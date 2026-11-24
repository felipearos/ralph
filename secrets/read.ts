/**
 * `bun secrets/read.ts <NAME>` — one named secret, read through the loop's
 * configured `SecretSource`, for `ralph.sh` (felipearos/ralph#759).
 *
 * The runner is `RALPH_NAMED_SECRETS_RUNNER`, falling back to
 * `RALPH_SECRETS_RUNNER`, then to none. `doppler` reads Doppler, `dotenv`
 * reads the file named by `RALPH_SECRETS_FILE`, and any other runner reads
 * the environment.
 *
 * Exit codes, which bash branches on:
 *   0  the value on stdout, with NO trailing newline (`$(...)` would strip
 *      one, but a value must not depend on that)
 *   2  usage error
 *   3  absent; nothing printed
 *   4  unread; the reason on stderr, one line
 *
 * The value goes to stdout and nowhere else: never into an error or a log.
 */
import { secretSourceFor, type SecretsRunner } from "./source";

export const EXIT_ABSENT = 3;
export const EXIT_UNREAD = 4;
export const EXIT_USAGE = 2;

export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  out: { stdout: (text: string) => void; stderr: (text: string) => void } = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === "" || rest.length > 0) {
    out.stderr("usage: bun secrets/read.ts <NAME>\n");
    return EXIT_USAGE;
  }
  const configured = env.RALPH_NAMED_SECRETS_RUNNER || env.RALPH_SECRETS_RUNNER || "none";
  const runner: SecretsRunner = configured === "doppler" || configured === "dotenv" ? configured : "none";
  const read = await secretSourceFor(runner, env).read(name);
  if (read.kind === "value") {
    out.stdout(read.value);
    return 0;
  }
  if (read.kind === "unread") {
    out.stderr(`${read.why.replace(/\n/g, " ")}\n`);
    return EXIT_UNREAD;
  }
  return EXIT_ABSENT;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // A source rejecting is a read that did not happen: unread, so the
      // supervisor waits rather than treating the secret as never stored.
      process.stderr.write(`${(error instanceof Error ? error.message : String(error)).replace(/\n/g, " ")}\n`);
      process.exitCode = EXIT_UNREAD;
    },
  );
}
