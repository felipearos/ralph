/**
 * The one `gh` wrapper the ci-doctor's modules share.
 *
 * Three callers had grown byte-identical copies of the same ten lines, and
 * `ci-doctor/unpark.ts` left the instruction that produced this file: *"a third
 * caller should lift both into a shared `ci-doctor/gh.ts` rather than make a
 * third copy."* `ci-doctor/revert.ts` was the third caller.
 *
 * What the copies agreed on, and what matters enough to have one home:
 *
 * - **A throttle is time, not a fault.** It is raised as the frontier's own
 *   `RateLimitedError`, never a local class, because `isRateLimited()` is what
 *   every other caller tests with and a parallel class reads as a plain fault
 *   to all of them. The CLIs turn it into `RATE_LIMITED_EXIT`, which the
 *   supervisor waits out instead of stopping for a human.
 * - **Anything else is a throw**, so a decision is never made from a half-read
 *   answer. Where a caller would rather degrade than fail — a comment it could
 *   not check for, a number it was handed that no longer resolves — it asks
 *   with `tried()` instead and decides for itself.
 */

import { classifyRateLimit, RateLimitedError } from "../frontier/github-rate-limit";

import type { Gh, Ran } from "./gate";

/** Whatever is holding a `gh`: the modules pass their own io objects. */
export type HasGh = { gh: Gh };

/**
 * Raise the right error for a failed `gh`, never returning.
 *
 * `args[0]` and `args[1]` lead the throttle's message because `gh issue list`
 * and `gh pr view` are throttled for different reasons and the supervisor's
 * log is where that gets read.
 */
export function throttled(message: string, args: readonly string[]): never {
  const signal = classifyRateLimit(message);
  if (signal !== null) {
    throw new RateLimitedError(signal.kind, signal.retryAfterSeconds, `gh ${args[0]} ${args[1]}: ${message}`);
  }
  throw new Error(message === "" ? `gh ${args.join(" ")} failed` : message);
}

/** A `gh` call whose failure is a fault. Every write, and every read a decision depends on. */
export async function write(io: HasGh, args: string[]): Promise<Ran> {
  const ran = await io.gh(args);
  if (ran.ok) return ran;
  throttled(`${ran.stderr}\n${ran.stdout}`.trim(), args);
}

/**
 * A `gh` call the caller would rather degrade on than fail.
 *
 * A throttle still throws — it is the one failure that is about time rather
 * than about the answer, and swallowing it would spend the doctor's budget
 * silently. Everything else comes back as `null`, which the caller reads as
 * "cannot tell". That is the line `ci-doctor/case-issue.ts:201-217` draws for
 * an issue number a cache remembers and GitHub will not resolve: not a verdict
 * on the case.
 */
export async function tried(io: HasGh, args: string[]): Promise<Ran | null> {
  const ran = await io.gh(args);
  if (ran.ok) return ran;
  const message = `${ran.stderr}\n${ran.stdout}`.trim();
  if (classifyRateLimit(message) !== null) throttled(message, args);
  return null;
}
