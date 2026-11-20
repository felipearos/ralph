import { describe, expect, it } from 'vitest';

import {
  RateLimitedError,
  classifyRateLimit,
  frontierConcurrency,
  isRateLimited,
  parseIncluded,
  retryPolicy,
  withRateLimitRetry,
  type RateLimitSignal,
} from './github-rate-limit';

const included = (status: string, headers: Record<string, string>, body = '{}'): string =>
  [`HTTP/2.0 ${status}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', body].join('\n');

describe('parseIncluded', () => {
  it('splits the status, lower-cased headers and body', () => {
    const out = parseIncluded(included('403 Forbidden', { 'Retry-After': '60', 'X-Ratelimit-Remaining': '12' }, '[1]'));
    expect(out).toEqual({ status: 403, headers: { 'retry-after': '60', 'x-ratelimit-remaining': '12' }, body: '[1]' });
  });

  it('treats output with no status line as all body', () => {
    expect(parseIncluded('[]')).toEqual({ status: null, headers: {}, body: '[]' });
  });
});

describe('classifyRateLimit', () => {
  // gh's words on 2026-09-28, while `gh api rate_limit` showed core 5000/5000.
  const primaryWording = 'gh: API rate limit exceeded for user ID 21047325. (HTTP 403)';

  it('reads Retry-After as a secondary limit', () => {
    const response = parseIncluded(included('403 Forbidden', { 'Retry-After': '45' }));
    expect(classifyRateLimit('gh: You have exceeded a secondary rate limit (HTTP 403)', response)).toEqual({
      kind: 'secondary',
      retryAfterSeconds: 45,
    });
  });

  it('reads the primary wording with quota remaining as a secondary limit', () => {
    const response = parseIncluded(included('403 Forbidden', { 'X-Ratelimit-Remaining': '4999' }));
    expect(classifyRateLimit(primaryWording, response)).toEqual({ kind: 'secondary', retryAfterSeconds: null });
  });

  it('reads an exhausted hourly quota, with the time left to its reset', () => {
    const response = parseIncluded(
      included('403 Forbidden', { 'X-Ratelimit-Remaining': '0', 'X-Ratelimit-Reset': '2000' }),
    );
    expect(classifyRateLimit(primaryWording, response, 1400)).toEqual({ kind: 'quota', retryAfterSeconds: 600 });
  });

  it('names the secondary-limit text without headers, and flags bare rate-limit text as unspecified', () => {
    expect(classifyRateLimit('gh: You have exceeded a secondary rate limit (HTTP 403)')).toEqual({
      kind: 'secondary',
      retryAfterSeconds: null,
    });
    expect(classifyRateLimit('GraphQL: API rate limit exceeded for user ID 1.')).toEqual({
      kind: 'unspecified',
      retryAfterSeconds: null,
    });
  });

  it('flags the GraphQL "already exceeded" wording as unspecified (PR #656, quota 3440/5000 left)', () => {
    expect(classifyRateLimit('GraphQL: API rate limit already exceeded for user ID 21047325')).toEqual({
      kind: 'unspecified',
      retryAfterSeconds: null,
    });
  });

  it('counts a bare 429 as throttling', () => {
    expect(classifyRateLimit('gh: Too Many Requests (HTTP 429)')?.kind).toBe('unspecified');
  });

  it('leaves a permission 403, a 404 and a server error alone', () => {
    expect(classifyRateLimit('gh: Resource not accessible by integration (HTTP 403)')).toBeNull();
    expect(classifyRateLimit('gh: Must have admin rights to Repository. (HTTP 403)')).toBeNull();
    expect(classifyRateLimit('gh: Not Found (HTTP 404)')).toBeNull();
    expect(classifyRateLimit('gh: Server Error (HTTP 500)')).toBeNull();
    // Mentions a rate limit but says nothing was exceeded: a near miss, not throttling.
    expect(classifyRateLimit('gh: rate limit settings unavailable (HTTP 403)')).toBeNull();
  });
});

describe('withRateLimitRetry', () => {
  const throttled = new Error('throttled');
  const classify =
    (signal: RateLimitSignal) =>
    (error: unknown): RateLimitSignal | null =>
      error === throttled ? signal : null;

  function recorder(random = 0.5) {
    const sleeps: number[] = [];
    return { sleeps, deps: { sleep: async (s: number) => void sleeps.push(s), random: () => random } };
  }

  function failing(times: number) {
    let calls = 0;
    const attempt = async (): Promise<string> => {
      calls++;
      if (calls <= times) throw throttled;
      return 'ok';
    };
    return { attempt, calls: () => calls };
  }

  it('honours Retry-After, plus a little jitter, then succeeds', async () => {
    const { sleeps, deps } = recorder(0);
    const call = failing(1);
    const out = await withRateLimitRetry(
      call.attempt,
      classify({ kind: 'secondary', retryAfterSeconds: 30 }),
      deps,
      { budgetSeconds: 120, baseSeconds: 5 },
    );
    expect(out).toBe('ok');
    expect(sleeps).toEqual([30]);
  });

  it('backs off exponentially with jitter when GitHub names no wait', async () => {
    const { sleeps, deps } = recorder(0.5);
    const call = failing(3);
    await withRateLimitRetry(call.attempt, classify({ kind: 'secondary', retryAfterSeconds: null }), deps, {
      budgetSeconds: 120,
      baseSeconds: 5,
    });
    expect(sleeps).toEqual([5, 10, 20]);
    expect(call.calls()).toBe(4);
  });

  it('spreads loops apart: different jitter, different waits', async () => {
    const low = recorder(0);
    const high = recorder(0.99);
    const signal = classify({ kind: 'secondary', retryAfterSeconds: null });
    await withRateLimitRetry(failing(1).attempt, signal, low.deps, { budgetSeconds: 120, baseSeconds: 8 });
    await withRateLimitRetry(failing(1).attempt, signal, high.deps, { budgetSeconds: 120, baseSeconds: 8 });
    expect(low.sleeps[0]).toBeLessThan(high.sleeps[0]!);
  });

  it('gives up with a typed error once the next wait would overrun the budget', async () => {
    const { sleeps, deps } = recorder(0.5);
    const call = failing(100);
    const run = withRateLimitRetry(call.attempt, classify({ kind: 'secondary', retryAfterSeconds: null }), deps, {
      budgetSeconds: 40,
      baseSeconds: 5,
    });
    const error = await run.catch((e: unknown) => e);
    expect(isRateLimited(error)).toBe(true);
    expect((error as RateLimitedError).kind).toBe('secondary');
    // 5 + 10 + 20 = 35 spent; the next (40) would pass the budget.
    expect(sleeps).toEqual([5, 10, 20]);
    expect((error as RateLimitedError).retryAfterSeconds).toBe(40);
    expect((error as RateLimitedError).message).toContain('GitHub rate limit (secondary)');
  });

  it('does not wait out an hourly reset longer than the budget', async () => {
    const { sleeps, deps } = recorder();
    const run = withRateLimitRetry(failing(1).attempt, classify({ kind: 'quota', retryAfterSeconds: 1800 }), deps, {
      budgetSeconds: 120,
      baseSeconds: 5,
    });
    const error = (await run.catch((e: unknown) => e)) as RateLimitedError;
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error.kind).toBe('quota');
    expect(error.retryAfterSeconds).toBe(1800);
    expect(sleeps).toEqual([]);
  });

  it('shares one budget across the calls of a run', async () => {
    const { sleeps, deps } = recorder(0);
    const budget = { waitedSeconds: 0 };
    const signal = classify({ kind: 'secondary', retryAfterSeconds: 50 });
    const policy = { budgetSeconds: 120, baseSeconds: 5 };
    await withRateLimitRetry(failing(1).attempt, signal, deps, policy, budget);
    await withRateLimitRetry(failing(1).attempt, signal, deps, policy, budget);
    await expect(withRateLimitRetry(failing(1).attempt, signal, deps, policy, budget)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(sleeps).toEqual([50, 50]);
  });

  it('re-throws any other failure at once, untouched', async () => {
    const { sleeps, deps } = recorder();
    const denied = new Error('gh: Resource not accessible by integration (HTTP 403)');
    const run = withRateLimitRetry(
      async () => {
        throw denied;
      },
      classify({ kind: 'secondary', retryAfterSeconds: 1 }),
      deps,
      { budgetSeconds: 120, baseSeconds: 5 },
    );
    await expect(run).rejects.toBe(denied);
    expect(sleeps).toEqual([]);
  });
});

describe('knobs', () => {
  it('defaults the fan-out to 2 and bounds what the environment asks for', () => {
    expect(frontierConcurrency({})).toBe(2);
    expect(frontierConcurrency({ RALPH_FRONTIER_CONCURRENCY: '4' })).toBe(4);
    expect(frontierConcurrency({ RALPH_FRONTIER_CONCURRENCY: '0' })).toBe(1);
    expect(frontierConcurrency({ RALPH_FRONTIER_CONCURRENCY: '500' })).toBe(16);
    expect(frontierConcurrency({ RALPH_FRONTIER_CONCURRENCY: 'lots' })).toBe(2);
  });

  it('defaults the retry budget to two minutes from a five-second base', () => {
    expect(retryPolicy({})).toEqual({ budgetSeconds: 120, baseSeconds: 5 });
    expect(
      retryPolicy({ RALPH_FRONTIER_RATE_LIMIT_BUDGET_SECONDS: '0', RALPH_FRONTIER_RATE_LIMIT_BASE_SECONDS: '2' }),
    ).toEqual({ budgetSeconds: 0, baseSeconds: 2 });
  });
});
