/**
 * Running a tracker's CLI (`gh`) from TypeScript. Moved out of
 * `frontier/next-tasks.ts` so the GitHub adapter and the frontier share one
 * runner and one failure shape.
 */
import { execFile } from "node:child_process";

/** A failed command, with what it printed: `gh api --include` puts the headers there. */
export class CommandError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
  ) {
    super(message);
  }
}

/**
 * One binary, one convention: the failing command in the message, so a caller
 * reading a stack knows which invocation produced it. The buffer is sized for
 * the full issue list with bodies, which comfortably exceeds the 1MB default.
 */
export async function run(bin: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new CommandError(`${bin} ${args.join(" ")} failed: ${stderr || error.message}`, stdout));
        return;
      }
      resolve(stdout);
    });
  });
}
