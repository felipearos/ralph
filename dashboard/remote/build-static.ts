/**
 * Vercel's build step for the remote dashboard: the unchanged shell, flagged
 * as remote, written to the project's output directory (`vercel.json`).
 *
 *   bun dashboard/remote/build-static.ts [dir]
 *
 * `dir` defaults to `dashboard/remote/dist`, next to this file; the tests pass
 * a scratch directory instead. `RALPH_REMOTE_SURFACE=intake`, the same
 * variable the function reads, also flags the shell as the intake deployment's,
 * so its pages other than the intake page answer "not found".
 */
import { fileURLToPath } from "node:url";

import { writeShell } from "../build";

const dir = process.argv[2] ?? fileURLToPath(new URL("./dist", import.meta.url));
const surface = process.env.RALPH_REMOTE_SURFACE?.trim() === "intake" ? "intake" : "full";
await writeShell(dir, { remote: true, surface });
console.log(`remote dashboard shell (${surface}) written to ${dir}`);
