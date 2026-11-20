/**
 * GitHub throttling, told apart from every other `gh` failure.
 *
 * Four loops share one GitHub account. On 2026-09-28 their frontier reads
 * failed again and again with `API rate limit exceeded (HTTP 403)` on
 * `issues/<n>/dependencies/blocked_by` while `gh api rate_limit` showed the
 * core quota untouched: GitHub's secondary (burst) limit, answering the
 * frontier's per-ticket fan-out. The failure was reported like any other, so
 * the gate logged "the frontier could not be read" and one iteration ended
 * NEEDS_TRIAGE, halting its loop for a throttle that lifts in minutes.
 *
 * Three answers come back from here:
 *
 *   secondary    throttled while quota remains (`Retry-After`, or the
 *                secondary-limit text, or a rate-limit message beside a
 *                non-zero `x-ratelimit-remaining`). Waiting seconds clears it.
 *   quota        the hourly quota is spent (`x-ratelimit-remaining: 0`).
 *                Clears at `x-ratelimit-reset`, which may be most of an hour.
 *   unspecified  rate-limit text with no headers to say which. `gh issue list`
 *                and friends expose no headers, and GitHub words some
 *                secondary limits exactly like the primary one, so this is
 *                waited on like a secondary limit.
 *
 * A 403 without rate-limit text is a permission failure and is not touched.
 */

export type RateLimitKind = "secondary" | "quota" | "unspecified";

export interface RateLimitSignal {
  kind: RateLimitKind;
  /** What GitHub said to wait, in seconds; null when it said nothing. */
  retryAfterSeconds: number | null;
}

/** The exit status for "GitHub throttled this read; try later" (EX_TEMPFAIL). */
export const RATE_LIMITED_EXIT = 75;

// "already exceeded" is GitHub's GraphQL wording for a limit that is not the
// hourly quota: on 2026-11-03 PR #656's review-thread reads were refused with
// `GraphQL: API rate limit already exceeded for user ID ...` while
// `gh api rate_limit` showed 3440/5000 left. Only the optional "already" is
// added, so other text that merely mentions a rate limit stays unclassified.
const RATE_LIMIT_TEXT =
  /secondary rate limit|rate limit (?:already )?exceeded|abuse detection|\bRATE_LIMITED\b|too many requests/i;

/**
 * The failure the frontier raises once its own retries are spent. Typed so a
 * caller can report "rate limited, retry later" instead of a generic fault.
 */
export class RateLimitedError extends Error {
  readonly rateLimited = true;
  constructor(
    readonly kind: RateLimitKind,
    readonly retryAfterSeconds: number | null,
    detail: string,
  ) {
    super(
      `GitHub rate limit (${kind}) — retry later` +
        (retryAfterSeconds === null ? "" : ` (in ~${retryAfterSeconds}s)`) +
        `: ${detail}`,
    );
    this.name = "RateLimitedError";
  }
}

export function isRateLimited(error: unknown): error is RateLimitedError {
  return error instanceof RateLimitedError;
}

/** What `gh api --include` printed: the status line, headers, then the body. */
export interface IncludedResponse {
  status: number | null;
  /** Lower-cased names. */
  headers: Record<string, string>;
  body: string;
}

/**
 * Split `gh api --include` output. Output with no status line (a fake, or a
 * gh that ignored the flag) is all body, so a caller never loses the payload.
 */
export function parseIncluded(stdout: string): IncludedResponse {
  const status = /^HTTP\/[\d.]+ (\d{3})/.exec(stdout);
  if (status === null) return { status: null, headers: {}, body: stdout };
  const split = /\r?\n\r?\n/.exec(stdout);
  const head = split === null ? stdout : stdout.slice(0, split.index);
  const body = split === null ? "" : stdout.slice(split.index + split[0].length);
  const headers: Record<string, string> = {};
  for (const line of head.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number(status[1]), headers, body };
}

const wholeSeconds = (raw: string | undefined): number | null =>
  raw !== undefined && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;

/**
 * Whether a failed `gh` call was GitHub throttling, and which kind. `message`
 * is gh's stderr (or the wrapping error); `response` is the `--include`
 * output when the call asked for it.
 */
export function classifyRateLimit(
  message: string,
  response: IncludedResponse | null = null,
  nowSeconds: number = Date.now() / 1000,
): RateLimitSignal | null {
  const statusInMessage = /\(HTTP (\d{3})\)/.exec(message);
  const status = response?.status ?? (statusInMessage ? Number(statusInMessage[1]) : null);
  const text = `${message}\n${response?.body ?? ""}`;
  if (status !== 429 && !RATE_LIMIT_TEXT.test(text)) return null;

  const headers = response?.headers ?? {};
  const retryAfter = wholeSeconds(headers["retry-after"]);
  if (retryAfter !== null) return { kind: "secondary", retryAfterSeconds: retryAfter };

  const remaining = wholeSeconds(headers["x-ratelimit-remaining"]);
  const reset = wholeSeconds(headers["x-ratelimit-reset"]);
  if (remaining === 0) {
    return {
      kind: "quota",
      retryAfterSeconds: reset === null ? null : Math.max(0, Math.ceil(reset - nowSeconds)),
    };
  }
  if (/secondary rate limit|abuse detection/i.test(text) || (remaining !== null && remaining > 0)) {
    return { kind: "secondary", retryAfterSeconds: null };
  }
  return { kind: "unspecified", retryAfterSeconds: null };
}

export interface RetryPolicy {
  /** Most seconds one frontier run spends waiting on GitHub, across all calls. */
  budgetSeconds: number;
  /** First backoff when GitHub gives no Retry-After; doubles per attempt. */
  baseSeconds: number;
}

const wholeOr = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const n = wholeSeconds(raw);
  return n === null ? fallback : Math.min(max, Math.max(min, n));
};

/**
 * `RALPH_FRONTIER_RATE_LIMIT_BUDGET_SECONDS` (120) and
 * `RALPH_FRONTIER_RATE_LIMIT_BASE_SECONDS` (5). The budget is bounded so an
 * iteration never sits for long inside one tool call: past it the typed error
 * hands the wait to the supervisor, which waits with no model running.
 * `review-threads.ts` reads the same two settings for the merge gate, capped
 * below the model's Bash timeout.
 */
export function retryPolicy(env: Record<string, string | undefined> = process.env): RetryPolicy {
  return {
    budgetSeconds: wholeOr(env.RALPH_FRONTIER_RATE_LIMIT_BUDGET_SECONDS, 120, 0, 900),
    baseSeconds: wholeOr(env.RALPH_FRONTIER_RATE_LIMIT_BASE_SECONDS, 5, 1, 300),
  };
}

/**
 * `RALPH_FRONTIER_CONCURRENCY` (2): how many `gh` reads one frontier run keeps
 * in flight in its per-ticket fan-outs. Four loops multiply it, and GitHub's
 * secondary limit counts concurrent requests per account.
 */
export function frontierConcurrency(env: Record<string, string | undefined> = process.env): number {
  return wholeOr(env.RALPH_FRONTIER_CONCURRENCY, 2, 1, 16);
}

export interface RetryDeps {
  sleep(seconds: number): Promise<void>;
  /** [0, 1), for jitter. */
  random(): number;
}

/**
 * One frontier run's patience, shared by every call it makes, so a run of
 * paged or parallel reads cannot each spend the whole budget.
 */
export interface RetryBudget {
  waitedSeconds: number;
}

/**
 * Run `attempt`, waiting out GitHub throttling: Retry-After when GitHub gives
 * one, else exponential backoff from `baseSeconds` with jitter, so loops that
 * were throttled together do not return together. Any other failure is
 * re-thrown untouched. When the next wait would overrun the budget, throws
 * `RateLimitedError` carrying how long the caller should wait instead.
 */
export async function withRateLimitRetry<T>(
  attempt: () => Promise<T>,
  classify: (error: unknown) => RateLimitSignal | null,
  deps: RetryDeps,
  policy: RetryPolicy,
  budget: RetryBudget = { waitedSeconds: 0 },
): Promise<T> {
  for (let tries = 0; ; tries++) {
    try {
      return await attempt();
    } catch (error) {
      const signal = classify(error);
      if (signal === null) throw error;
      const jitter = deps.random();
      const wait =
        signal.retryAfterSeconds !== null
          ? signal.retryAfterSeconds + Math.ceil(jitter * policy.baseSeconds)
          : Math.ceil(policy.baseSeconds * 2 ** tries * (0.5 + jitter));
      const detail = error instanceof Error ? error.message : String(error);
      if (budget.waitedSeconds + wait > policy.budgetSeconds) {
        throw new RateLimitedError(signal.kind, signal.retryAfterSeconds ?? wait, detail);
      }
      budget.waitedSeconds += wait;
      await deps.sleep(wait);
    }
  }
}
