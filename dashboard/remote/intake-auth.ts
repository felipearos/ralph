/**
 * The intake metrics password, checked on the server (felipearos/ralph#459).
 *
 * The tickets on the intake page are open to whoever has the link; the
 * metrics — who reports noise, how often the team overrides the clerk — are
 * the operator's. So the function serves `intake-metrics` only to a browser
 * holding a session cookie this module signed after a right password. The
 * payload never reaches a browser without one: there is no client-side gate.
 *
 * - The password is the Vercel env `RALPH_INTAKE_METRICS_PASSWORD`. Unset or
 *   empty, the metrics are locked for everyone: there is no password that
 *   opens them, and the login says so. They never fall open.
 * - A guess is compared as a SHA-256 digest against the password's digest,
 *   byte by byte without an early exit, so the time it takes says nothing
 *   about how much of the guess was right.
 * - Every wrong guess waits `FAILURE_DELAY_MS` before it is answered, and a
 *   client past `MAX_FAILURES` in `FAILURE_WINDOW_MS` is refused outright
 *   (429) until the window passes. The count is per function instance:
 *   instances are few on this traffic, and the delay holds on every one.
 * - The session is `v1.<expires ms>.<HMAC-SHA-256>` in an HttpOnly, Secure,
 *   SameSite=Strict cookie scoped to `/api`. The HMAC key is derived from the
 *   password, so changing the password ends every session at once, and no
 *   second secret has to be kept.
 *
 * Web Crypto only (`crypto.subtle`), so the function bundle gains no package.
 */

export const INTAKE_COOKIE = "ralph_intake_session";
/** How long a session lasts: a working day. */
export const SESSION_SECONDS = 12 * 3600;
export const FAILURE_DELAY_MS = 1000;
export const MAX_FAILURES = 10;
export const FAILURE_WINDOW_MS = 15 * 60_000;
/** Clients remembered at once; past it the oldest entry goes. Bounds the instance's memory under a spray of addresses. */
const MAX_CLIENTS = 10_000;

export type LoginResult =
  | { ok: true; cookie: string }
  | { ok: false; reason: "unconfigured" | "wrong" | "throttled"; retryAfterSeconds?: number };

export interface IntakeGate {
  /** Whether a password is set at all; false locks the metrics for everyone. */
  readonly configured: boolean;
  /** Whether `request` carries a valid, unexpired session. */
  session(request: Request): Promise<boolean>;
  login(password: unknown, client: string): Promise<LoginResult>;
  /** A cookie that ends the session. */
  readonly logoutCookie: string;
}

const encoder = new TextEncoder();

const digest = async (text: string): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));

/** Equal-length byte arrays compared without an early exit. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

/** The client a failure is counted against: the first forwarded address Vercel sets, else one shared bucket. */
export function clientOf(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** The value of cookie `name` in a `Cookie` header, or null. */
function cookieValue(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

const cookie = (value: string, maxAge: number): string =>
  `${INTAKE_COOKIE}=${value}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

export function createIntakeGate(options: {
  password: string | null | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  failureDelayMs?: number;
}): IntakeGate {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const delay = options.failureDelayMs ?? FAILURE_DELAY_MS;
  const password = options.password ?? "";
  const configured = password !== "";
  const failures = new Map<string, { count: number; since: number }>();

  // Derived once per instance; the password itself is not kept past this.
  const expected = configured ? digest(password) : null;
  const key = configured
    ? digest(`ralph-intake-session\u0000${password}`).then((raw) =>
        crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
      )
    : null;

  const sign = async (payload: string): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.sign("HMAC", await key!, encoder.encode(payload)));

  const throttled = (client: string): number | null => {
    const entry = failures.get(client);
    if (entry === undefined) return null;
    const age = now() - entry.since;
    if (age >= FAILURE_WINDOW_MS) {
      failures.delete(client);
      return null;
    }
    return entry.count >= MAX_FAILURES ? Math.ceil((FAILURE_WINDOW_MS - age) / 1000) : null;
  };

  const fail = (client: string): void => {
    const entry = failures.get(client);
    if (entry === undefined || now() - entry.since >= FAILURE_WINDOW_MS) {
      if (failures.size >= MAX_CLIENTS) failures.delete(failures.keys().next().value!);
      failures.set(client, { count: 1, since: now() });
    } else entry.count += 1;
  };

  return {
    configured,
    logoutCookie: cookie("", 0),
    async session(request) {
      if (!configured) return false;
      const value = cookieValue(request.headers.get("cookie"), INTAKE_COOKIE);
      const match = value === null ? null : /^v1\.(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(value);
      if (match === null) return false;
      const expires = Number(match[1]);
      if (!(expires > now())) return false;
      const given = new Uint8Array(Buffer.from(match[2]!, "base64url"));
      return constantTimeEqual(given, await sign(`v1.${match[1]}`));
    },
    async login(guess, client) {
      if (!configured) return { ok: false, reason: "unconfigured" };
      const wait = throttled(client);
      if (wait !== null) return { ok: false, reason: "throttled", retryAfterSeconds: wait };
      const right = typeof guess === "string" && constantTimeEqual(await digest(guess), await expected!);
      if (!right) {
        fail(client);
        await sleep(delay);
        return { ok: false, reason: "wrong" };
      }
      failures.delete(client);
      const expires = String(now() + SESSION_SECONDS * 1000);
      return { ok: true, cookie: cookie(`v1.${expires}.${base64url(await sign(`v1.${expires}`))}`, SESSION_SECONDS) };
    },
  };
}
